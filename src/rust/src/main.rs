use globwalk::GlobWalkerBuilder;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process;

const PACKAGE_MANAGERS: &[&str] = &["pnpm", "npm", "deno", "bun", "yarn"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Generate,
    Compare,
}

#[derive(Debug)]
struct CliOptions {
    mode: Mode,
    targets: Option<Vec<String>>,
    silent: bool,
    debug: bool,
    unified: bool,
    pm_option: Option<String>,
}

#[derive(Debug)]
struct CliError {
    code: i32,
    message: String,
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

#[derive(Clone, Debug)]
struct Detection {
    pm: String,
    root: PathBuf,
    globs: Vec<String>,
}

#[derive(Deserialize, Debug)]
struct PnpmWorkspace {
    packages: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
struct DenoWorkspace {
    workspace: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
struct PackageJson {
    name: Option<String>,
    dependencies: Option<HashMap<String, String>>,
    #[serde(rename = "devDependencies")]
    dev_dependencies: Option<HashMap<String, String>>,
    #[serde(rename = "peerDependencies")]
    peer_dependencies: Option<HashMap<String, String>>,
    workspaces: Option<Value>,
}

#[derive(Clone, Debug)]
struct PackageInfo {
    dir: PathBuf,
    rel_dir_posix: String,
    deps: Vec<String>,
    per_file_hashes: BTreeMap<String, String>,
    own_hash: Vec<u8>,
}

#[derive(Debug)]
struct CompareChanged {
    name: String,
    old_hash: String,
    new_hash: String,
    changed_deps: Vec<String>,
}

#[derive(Debug)]
struct CompareMissing {
    name: String,
    new_hash: String,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("❌ Unexpected error :\n{}", err);
        process::exit(99);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let opts = match parse_args(&args) {
        Ok(Some(o)) => o,
        Ok(None) => return Ok(()),
        Err(e) => {
            eprintln!("❌ {}", e.message);
            process::exit(e.code);
        }
    };

    if !opts.silent {
        match opts.mode {
            Mode::Generate => {
                if let Some(targets) = &opts.targets {
                    println!(
                        "ℹ️  Generating hashes for specified targets... ({})\n",
                        targets.join(", ")
                    );
                } else {
                    println!("ℹ️  Generating hashes for all workspaces...\n");
                }
            }
            Mode::Compare => {
                if let Some(targets) = &opts.targets {
                    println!(
                        "ℹ️  Comparing hashes for specified targets... ({})\n",
                        targets.join(", ")
                    );
                } else {
                    println!("ℹ️  Comparing hashes for all workspaces...\n");
                }
            }
        }

        if opts.debug {
            println!("ℹ️  Debug mode enabled\n");
        }
        if !opts.unified {
            println!("ℹ️  Per-workspace mode enabled\n");
        }
    }

    let detection = if let Some(pm) = &opts.pm_option {
        match detect_specified(pm) {
            Some(Ok(d)) => d,
            Some(Err(e)) => {
                eprintln!("❌ {}", e.message);
                process::exit(e.code);
            }
            None => {
                eprintln!("❌ Specified package manager not found");
                process::exit(5);
            }
        }
    } else {
        match auto_detect() {
            Some(d) => d,
            None => {
                eprintln!("❌ No workspaces found or unsupported package manager");
                process::exit(4);
            }
        }
    };

    if !opts.silent {
        println!(
            "ℹ️  Using {} workspaces from {}\n",
            detection.pm,
            detection.root.display()
        );
    }

    let root_ignore = compile_root_ignore(&detection.root).map_err(|e| e.to_string())?;

    let mut packages = load_packages(&detection).map_err(|e| e.to_string())?;
    resolve_internal_deps(&mut packages);

    let selected_names = select_packages(&packages, opts.targets.as_ref());
    compute_package_hashes(
        &mut packages,
        &selected_names,
        &detection.root,
        root_ignore.as_ref(),
        opts.debug,
        opts.unified,
    )
    .map_err(|e| e.to_string())?;

    let final_hashes = compute_final_hashes(&packages, &selected_names).map_err(|e| {
        if e.code == 6 {
            eprintln!("❌ {}", e.message);
            process::exit(6);
        }
        e.to_string()
    })?;

    if !opts.silent {
        println!("✅ Computed all hashes ({})\n", selected_names.len());
    }

    match opts.mode {
        Mode::Generate => generate_hashes(
            &packages,
            &selected_names,
            &final_hashes,
            &detection.root,
            opts.unified,
            opts.silent,
        )
        .map_err(|e| e.to_string())?,
        Mode::Compare => compare_hashes(
            &packages,
            &selected_names,
            &final_hashes,
            &detection.root,
            opts.unified,
            opts.silent,
        )
        .map_err(|e| e.to_string())?,
    }

    Ok(())
}

fn parse_args(args: &[String]) -> Result<Option<CliOptions>, CliError> {
    let mut mode: Option<Mode> = None;
    let mut targets: Option<Vec<String>> = None;
    let mut silent = false;
    let mut debug = false;
    let mut unified = true;
    let mut pm_option: Option<String> = None;

    for arg in args {
        if arg == "--generate" || arg == "-g" {
            if mode == Some(Mode::Compare) {
                return Err(CliError {
                    code: 2,
                    message: "Cannot specify both --generate and --compare".to_string(),
                });
            }
            mode = Some(Mode::Generate);
        } else if arg == "--compare" || arg == "-c" {
            if mode == Some(Mode::Generate) {
                return Err(CliError {
                    code: 2,
                    message: "Cannot specify both --generate and --compare".to_string(),
                });
            }
            mode = Some(Mode::Compare);
        } else if let Some(value) = arg
            .strip_prefix("--target=")
            .or_else(|| arg.strip_prefix("-t="))
        {
            let parsed = value
                .split(',')
                .map(|s| s.trim().trim_end_matches('/').replace('\\', "/"))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>();
            targets = Some(parsed);
        } else if arg == "--silent" || arg == "-s" {
            silent = true;
        } else if arg == "--debug" || arg == "-d" {
            debug = true;
        } else if arg == "--workspaces" || arg == "-w" {
            unified = false;
        } else if let Some(value) = arg
            .strip_prefix("--packagemanager=")
            .or_else(|| arg.strip_prefix("-pm="))
        {
            if !PACKAGE_MANAGERS.contains(&value) {
                return Err(CliError {
                    code: 2,
                    message: format!(
                        "Invalid package manager (\"{}\"), supported values are : {}",
                        value,
                        PACKAGE_MANAGERS.join(", ")
                    ),
                });
            }
            pm_option = Some(value.to_string());
        } else if arg == "--nopathcache" || arg == "-npc" {
            // accepted for parity, no-op in rust
        } else if arg == "--help" || arg == "-h" {
            println!(
                "\nmonorepo-hash by EDM115\nA simple script to generate or compare .hash files for monorepo workspaces\nSupports PNPM, Yarn, NPM, Bun and Deno\n\nArguments :\n  --generate        (-g)   Generate or update .hash files for all workspaces\n  --compare         (-c)   Compare current state with existing .hash files. Capture the exit code to check for changes\n  --target=\"<path>\" (-t)   Specify one or more targets to generate/compare (comma-separated)\n  --silent          (-s)   Suppress output messages\n  --debug           (-d)   Enable debug mode (per-file hashes)\n  --workspaces      (-w)   Use per-workspace .hash files instead of a single root one\n  --packagemanager  (-pm)  Force the package manager ({})\n  --nopathcache     (-npc) Disable path normalization cache (can reduce memory footprint on very large repos)\n  --help            (-h)   Show this help message\n",
                PACKAGE_MANAGERS.join(", ")
            );
            process::exit(0);
        } else {
            return Err(CliError {
                code: 3,
                message: format!("Unknown option : {}", arg),
            });
        }
    }

    let mode = mode.ok_or_else(|| CliError {
        code: 2,
        message: "Must specify either --generate (-g) or --compare (-c)".to_string(),
    })?;

    Ok(Some(CliOptions {
        mode,
        targets,
        silent,
        debug,
        unified,
        pm_option,
    }))
}

fn find_up(start: &Path, names: &[&str]) -> Option<PathBuf> {
    let mut current = start.to_path_buf();

    loop {
        for name in names {
            let candidate = current.join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }

        if !current.pop() {
            break;
        }
    }

    None
}

fn detect_pnpm() -> Option<Detection> {
    let cwd = env::current_dir().ok()?;
    let file = find_up(&cwd, &["pnpm-workspace.yaml"])?;
    let root = file.parent()?.to_path_buf();
    let raw = fs::read_to_string(&file).ok()?;
    let parsed: PnpmWorkspace = serde_yaml::from_str(&raw).ok()?;
    let globs = parsed.packages?;

    Some(Detection {
        pm: "pnpm".to_string(),
        root,
        globs,
    })
}

fn strip_json_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    let mut in_str = false;
    let mut escape = false;

    while i < bytes.len() {
        let c = bytes[i] as char;
        if in_str {
            out.push(c);
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }

        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
            continue;
        }

        if c == '/' && i + 1 < bytes.len() {
            let n = bytes[i + 1] as char;
            if n == '/' {
                i += 2;
                while i < bytes.len() && bytes[i] as char != '\n' {
                    i += 1;
                }
                continue;
            }
            if n == '*' {
                i += 2;
                while i + 1 < bytes.len() {
                    if bytes[i] as char == '*' && bytes[i + 1] as char == '/' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
                continue;
            }
        }

        out.push(c);
        i += 1;
    }

    out
}

fn detect_deno() -> Option<Detection> {
    let cwd = env::current_dir().ok()?;
    let file = find_up(&cwd, &["deno.json", "deno.jsonc"])?;
    let root = file.parent()?.to_path_buf();
    let raw = fs::read_to_string(&file).ok()?;
    let cleaned = strip_json_comments(&raw);
    let parsed: DenoWorkspace = serde_json::from_str(&cleaned).ok()?;
    let globs = parsed.workspace?;

    Some(Detection {
        pm: "deno".to_string(),
        root,
        globs,
    })
}

fn workspaces_from_value(value: &Value) -> Option<Vec<String>> {
    if let Some(arr) = value.as_array() {
        let globs = arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>();
        if !globs.is_empty() {
            return Some(globs);
        }
    }

    if let Some(obj) = value.as_object() {
        if let Some(packages) = obj.get("packages").and_then(|v| v.as_array()) {
            let globs = packages
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>();
            if !globs.is_empty() {
                return Some(globs);
            }
        }
    }

    None
}

fn detect_pkg_json() -> Option<Detection> {
    let cwd = env::current_dir().ok()?;
    let file = find_up(&cwd, &["package.json"])?;
    let root = file.parent()?.to_path_buf();
    let raw = fs::read_to_string(&file).ok()?;
    let parsed: PackageJson = serde_json::from_str(&raw).ok()?;
    let globs = workspaces_from_value(parsed.workspaces.as_ref()?)?;

    let pm = if root.join("bun.lock").exists() || root.join("bun.lockb").exists() {
        "bun"
    } else if root.join("deno.lock").exists() {
        "deno"
    } else if root.join("yarn.lock").exists() {
        "yarn"
    } else {
        "npm"
    };

    Some(Detection {
        pm: pm.to_string(),
        root,
        globs,
    })
}

fn auto_detect() -> Option<Detection> {
    detect_pnpm().or_else(detect_deno).or_else(detect_pkg_json)
}

fn detect_specified(pm: &str) -> Option<Result<Detection, CliError>> {
    let detected = match pm {
        "pnpm" => detect_pnpm(),
        "deno" => detect_deno(),
        "npm" | "yarn" | "bun" => detect_pkg_json(),
        _ => None,
    };

    match detected {
        Some(d) if d.pm == pm => Some(Ok(d)),
        Some(d) => Some(Err(CliError {
            code: 5,
            message: format!("{} workspaces not found. Did you mean --packagemanager={} ?", pm, d.pm),
        })),
        None => None,
    }
}

fn compile_root_ignore(root: &Path) -> io::Result<Option<Gitignore>> {
    let gitignore = root.join(".gitignore");
    if !gitignore.exists() {
        return Ok(None);
    }

    let mut builder = GitignoreBuilder::new(root);
    builder.add(gitignore);
    builder
        .add_line(None, "**/.hash")
        .map_err(|e| io::Error::other(e.to_string()))?;
    builder
        .add_line(None, "**/.debug-hash")
        .map_err(|e| io::Error::other(e.to_string()))?;

    let compiled = builder
        .build()
        .map_err(|e| io::Error::other(e.to_string()))?;

    Ok(Some(compiled))
}

fn compile_local_ignore(pkg_dir: &Path) -> io::Result<Option<Gitignore>> {
    let gitignore = pkg_dir.join(".gitignore");
    if !gitignore.exists() {
        return Ok(None);
    }

    let mut builder = GitignoreBuilder::new(pkg_dir);
    builder.add(gitignore);
    let compiled = builder
        .build()
        .map_err(|e| io::Error::other(e.to_string()))?;

    Ok(Some(compiled))
}

fn load_packages(detection: &Detection) -> io::Result<HashMap<String, PackageInfo>> {
    let mut package_jsons = BTreeSet::new();

    for glob in &detection.globs {
        let pattern = format!("{}/package.json", glob.trim_end_matches('/'));
        let walker = GlobWalkerBuilder::from_patterns(&detection.root, &[&pattern])
            .follow_links(false)
            .build()
            .map_err(|e| io::Error::other(e.to_string()))?;

        for entry in walker.into_iter().flatten() {
            package_jsons.insert(entry.path().to_path_buf());
        }
    }

    let mut packages = HashMap::new();

    for package_json_path in package_jsons {
        let raw = fs::read_to_string(&package_json_path)?;
        let parsed: PackageJson = serde_json::from_str(&raw)
            .map_err(|e| io::Error::other(e.to_string()))?;

        let name = parsed
            .name
            .ok_or_else(|| io::Error::other("Package missing name"))?;

        let dir = package_json_path.parent().unwrap_or(&detection.root).to_path_buf();
        let rel = dir
            .strip_prefix(&detection.root)
            .unwrap_or(&dir)
            .to_string_lossy()
            .replace('\\', "/");

        packages.insert(
            name,
            PackageInfo {
                dir,
                rel_dir_posix: rel,
                deps: Vec::new(),
                per_file_hashes: BTreeMap::new(),
                own_hash: Vec::new(),
            },
        );
    }

    Ok(packages)
}

fn resolve_internal_deps(packages: &mut HashMap<String, PackageInfo>) {
    let package_names = packages.keys().cloned().collect::<HashSet<_>>();
    let mut deps_by_pkg = HashMap::new();

    for (name, pkg) in packages.iter() {
        let pkg_json_path = pkg.dir.join("package.json");
        let Ok(raw) = fs::read_to_string(pkg_json_path) else {
            continue;
        };
        let Ok(parsed): Result<PackageJson, _> = serde_json::from_str(&raw) else {
            continue;
        };

        let mut deps = BTreeSet::new();
        if let Some(map) = parsed.dependencies {
            for dep in map.keys() {
                if package_names.contains(dep) {
                    deps.insert(dep.clone());
                }
            }
        }
        if let Some(map) = parsed.dev_dependencies {
            for dep in map.keys() {
                if package_names.contains(dep) {
                    deps.insert(dep.clone());
                }
            }
        }
        if let Some(map) = parsed.peer_dependencies {
            for dep in map.keys() {
                if package_names.contains(dep) {
                    deps.insert(dep.clone());
                }
            }
        }

        deps_by_pkg.insert(name.clone(), deps.into_iter().collect::<Vec<_>>());
    }

    for (name, deps) in deps_by_pkg {
        if let Some(pkg) = packages.get_mut(&name) {
            pkg.deps = deps;
        }
    }
}

fn select_packages(packages: &HashMap<String, PackageInfo>, targets: Option<&Vec<String>>) -> Vec<String> {
    let mut selected = BTreeSet::new();

    if let Some(targets) = targets {
        let rel_to_name = packages
            .iter()
            .map(|(name, pkg)| (pkg.rel_dir_posix.clone(), name.clone()))
            .collect::<HashMap<_, _>>();

        fn add_with_deps(name: &str, packages: &HashMap<String, PackageInfo>, selected: &mut BTreeSet<String>) {
            if !selected.insert(name.to_string()) {
                return;
            }
            if let Some(pkg) = packages.get(name) {
                for dep in &pkg.deps {
                    add_with_deps(dep, packages, selected);
                }
            }
        }

        for target in targets {
            if let Some(name) = rel_to_name.get(target) {
                add_with_deps(name, packages, &mut selected);
            }
        }
    } else {
        for name in packages.keys() {
            selected.insert(name.clone());
        }
    }

    let mut names = selected.into_iter().collect::<Vec<_>>();
    names.sort_by_key(|name| {
        packages
            .get(name)
            .map(|p| p.rel_dir_posix.clone())
            .unwrap_or_else(|| name.clone())
    });
    names
}

fn should_ignore_path(
    path: &Path,
    is_dir: bool,
    repo_root: &Path,
    pkg_root: &Path,
    root_ignore: Option<&Gitignore>,
    local_ignore: Option<&Gitignore>,
) -> bool {
    let rel_repo = path
        .strip_prefix(repo_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    if let Some(ignore) = root_ignore {
        if ignore
            .matched_path_or_any_parents(Path::new(&rel_repo), is_dir)
            .is_ignore()
        {
            return true;
        }
    }

    let rel_pkg = path
        .strip_prefix(pkg_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    if let Some(ignore) = local_ignore {
        if ignore
            .matched_path_or_any_parents(Path::new(&rel_pkg), is_dir)
            .is_ignore()
        {
            return true;
        }
    }

    false
}

fn collect_workspace_files(
    dir: &Path,
    repo_root: &Path,
    pkg_root: &Path,
    root_ignore: Option<&Gitignore>,
    local_ignore: Option<&Gitignore>,
    out: &mut Vec<(PathBuf, String)>,
) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            if file_name == "node_modules" || file_name == ".git" {
                continue;
            }
            if should_ignore_path(&path, true, repo_root, pkg_root, root_ignore, local_ignore) {
                continue;
            }
            collect_workspace_files(&path, repo_root, pkg_root, root_ignore, local_ignore, out)?;
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        if file_name == ".hash" || file_name == ".debug-hash" {
            continue;
        }

        if should_ignore_path(&path, false, repo_root, pkg_root, root_ignore, local_ignore) {
            continue;
        }

        let rel_pkg = path
            .strip_prefix(pkg_root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        out.push((path, rel_pkg));
    }

    Ok(())
}

fn sha256_hex_for_file(path: &Path, rel_posix: &str) -> io::Result<String> {
    let mut hasher = Sha256::new();
    hasher.update(rel_posix.as_bytes());
    let content = fs::read(path)?;
    hasher.update(&content);
    Ok(hex_encode(&hasher.finalize()))
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let chars: Vec<char> = hex.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let hi = chars[i].to_digit(16)?;
        let lo = chars[i + 1].to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
        i += 2;
    }
    Some(out)
}

fn compute_package_hashes(
    packages: &mut HashMap<String, PackageInfo>,
    selected: &[String],
    repo_root: &Path,
    root_ignore: Option<&Gitignore>,
    debug: bool,
    unified: bool,
) -> io::Result<()> {
    let mut root_debug = BTreeMap::<String, BTreeMap<String, String>>::new();

    for name in selected {
        let pkg = packages
            .get(name)
            .ok_or_else(|| io::Error::other("Package missing metadata"))?
            .clone();

        let local_ignore = compile_local_ignore(&pkg.dir)?;
        let mut files = Vec::new();
        collect_workspace_files(
            &pkg.dir,
            repo_root,
            &pkg.dir,
            root_ignore,
            local_ignore.as_ref(),
            &mut files,
        )?;
        files.sort_by(|a, b| a.1.cmp(&b.1));

        let mut per_file = BTreeMap::new();
        for (path, rel) in files {
            let h = sha256_hex_for_file(&path, &rel)?;
            per_file.insert(rel, h);
        }

        let mut own = Sha256::new();
        for hash in per_file.values() {
            if let Some(bytes) = hex_decode(hash) {
                own.update(bytes);
            }
        }

        if let Some(entry) = packages.get_mut(name) {
            entry.per_file_hashes = per_file.clone();
            entry.own_hash = own.finalize().to_vec();
        }

        if debug {
            if unified {
                root_debug.insert(pkg.rel_dir_posix.clone(), per_file);
            } else {
                let content = format!(
                    "{}\n",
                    serde_json::to_string_pretty(&per_file).unwrap_or("{}".to_string())
                );
                fs::write(pkg.dir.join(".debug-hash"), content)?;
            }
        }
    }

    if debug && unified {
        let content = format!(
            "{}\n",
            serde_json::to_string_pretty(&root_debug).unwrap_or("{}".to_string())
        );
        fs::write(repo_root.join(".debug-hash"), content)?;
    }

    Ok(())
}

fn compute_final_hashes(
    packages: &HashMap<String, PackageInfo>,
    selected: &[String],
) -> Result<HashMap<String, String>, CliError> {
    fn compute_one(
        name: &str,
        packages: &HashMap<String, PackageInfo>,
        cache: &mut HashMap<String, String>,
        stack: &mut Vec<String>,
        visiting: &mut HashSet<String>,
    ) -> Result<String, CliError> {
        if let Some(v) = cache.get(name) {
            return Ok(v.clone());
        }

        if visiting.contains(name) {
            let mut cycle = stack.clone();
            cycle.push(name.to_string());
            return Err(CliError {
                code: 6,
                message: format!("Circular dependency detected : {}", cycle.join(" -> ")),
            });
        }

        let pkg = packages.get(name).ok_or_else(|| CliError {
            code: 99,
            message: format!("Package metadata missing for {}", name),
        })?;

        visiting.insert(name.to_string());
        stack.push(name.to_string());

        let mut hasher = Sha256::new();
        hasher.update(&pkg.own_hash);

        for dep in &pkg.deps {
            let dep_hash = compute_one(dep, packages, cache, stack, visiting)?;
            if let Some(bytes) = hex_decode(&dep_hash) {
                hasher.update(bytes);
            }
        }

        stack.pop();
        visiting.remove(name);

        let final_hex = hex_encode(&hasher.finalize());
        cache.insert(name.to_string(), final_hex.clone());
        Ok(final_hex)
    }

    let mut cache = HashMap::new();
    let mut visiting = HashSet::new();
    let mut stack = Vec::new();

    for name in selected {
        compute_one(name, packages, &mut cache, &mut stack, &mut visiting)?;
    }

    Ok(cache)
}

fn generate_hashes(
    packages: &HashMap<String, PackageInfo>,
    selected: &[String],
    final_hashes: &HashMap<String, String>,
    repo_root: &Path,
    unified: bool,
    silent: bool,
) -> io::Result<()> {
    if unified {
        let mut root = BTreeMap::new();
        for name in selected {
            if let (Some(pkg), Some(hash)) = (packages.get(name), final_hashes.get(name)) {
                root.insert(pkg.rel_dir_posix.clone(), hash.clone());
            }
        }
        let content = format!(
            "{}\n",
            serde_json::to_string_pretty(&root).unwrap_or("{}".to_string())
        );
        fs::write(repo_root.join(".hash"), content)?;

        if !silent {
            for name in selected {
                if let (Some(pkg), Some(hash)) = (packages.get(name), final_hashes.get(name)) {
                    println!("✅ {} ({} written to .hash)", pkg.rel_dir_posix, hash);
                }
            }
        }
        return Ok(());
    }

    for name in selected {
        if let (Some(pkg), Some(hash)) = (packages.get(name), final_hashes.get(name)) {
            fs::write(pkg.dir.join(".hash"), format!("{}\n", hash))?;
            if !silent {
                println!("✅ {} ({} written to .hash)", pkg.rel_dir_posix, hash);
            }
        }
    }

    Ok(())
}

fn compare_hashes(
    packages: &HashMap<String, PackageInfo>,
    selected: &[String],
    final_hashes: &HashMap<String, String>,
    repo_root: &Path,
    unified: bool,
    silent: bool,
) -> io::Result<()> {
    let mut old_by_name = HashMap::new();

    if unified {
        let root_hash = repo_root.join(".hash");
        if root_hash.exists() {
            let raw = fs::read_to_string(root_hash)?;
            if let Ok(parsed) = serde_json::from_str::<HashMap<String, String>>(&raw) {
                for (name, pkg) in packages {
                    if let Some(old) = parsed.get(&pkg.rel_dir_posix) {
                        old_by_name.insert(name.clone(), old.clone());
                    }
                }
            }
        }
    } else {
        for (name, pkg) in packages {
            let hash_path = pkg.dir.join(".hash");
            if hash_path.exists() {
                let old = fs::read_to_string(hash_path)?.trim().to_string();
                old_by_name.insert(name.clone(), old);
            }
        }
    }

    let mut all_changed = HashSet::new();
    for (name, new_hash) in final_hashes {
        if let Some(old) = old_by_name.get(name)
            && old != new_hash
        {
            all_changed.insert(name.clone());
        }
    }

    let mut unchanged = Vec::new();
    let mut changed = Vec::<CompareChanged>::new();
    let mut missing = Vec::<CompareMissing>::new();

    fn transitive_deps(name: &str, packages: &HashMap<String, PackageInfo>) -> HashSet<String> {
        let mut out = HashSet::new();
        let mut stack = packages
            .get(name)
            .map(|p| p.deps.clone())
            .unwrap_or_default();

        while let Some(dep) = stack.pop() {
            if out.insert(dep.clone())
                && let Some(pkg) = packages.get(&dep)
            {
                for nested in &pkg.deps {
                    if !out.contains(nested) {
                        stack.push(nested.clone());
                    }
                }
            }
        }
        out
    }

    for name in selected {
        let Some(pkg) = packages.get(name) else {
            continue;
        };
        let Some(new_hash) = final_hashes.get(name) else {
            continue;
        };

        let Some(old_hash) = old_by_name.get(name) else {
            missing.push(CompareMissing {
                name: pkg.rel_dir_posix.clone(),
                new_hash: new_hash.clone(),
            });
            continue;
        };

        let mut changed_deps = transitive_deps(name, packages)
            .into_iter()
            .filter(|d| all_changed.contains(d))
            .filter_map(|d| packages.get(&d).map(|p| p.rel_dir_posix.clone()))
            .collect::<Vec<_>>();
        changed_deps.sort();

        if old_hash != new_hash || !changed_deps.is_empty() {
            changed.push(CompareChanged {
                name: pkg.rel_dir_posix.clone(),
                old_hash: old_hash.clone(),
                new_hash: new_hash.clone(),
                changed_deps,
            });
        } else {
            unchanged.push(pkg.rel_dir_posix.clone());
        }
    }

    unchanged.sort();
    changed.sort_by(|a, b| a.name.cmp(&b.name));
    missing.sort_by(|a, b| a.name.cmp(&b.name));

    if !silent {
        if !unchanged.is_empty() {
            println!("✅ Unchanged ({}) :", unchanged.len());
            for item in &unchanged {
                println!("• {}", item);
            }
            println!();
        }

        if !changed.is_empty() {
            println!("⚠️  Changed ({}) :", changed.len());
            for item in &changed {
                println!("• {}", item.name);
                println!("\told : {}", item.old_hash);
                println!("\tnew : {}", item.new_hash);
                if !item.changed_deps.is_empty() {
                    println!("\t🚧 changed dependency(s) :");
                    for dep in &item.changed_deps {
                        println!("\t\t• {}", dep);
                    }
                }
            }
            println!();
        }

        if !missing.is_empty() {
            println!("❓ Missing .hash files ({}) :", missing.len());
            for item in &missing {
                println!("• {} (would be {})", item.name, item.new_hash);
            }
            println!();
        }
    }

    if !changed.is_empty() || !missing.is_empty() {
        process::exit(1);
    }

    Ok(())
}
