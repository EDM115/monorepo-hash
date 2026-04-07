use ignore::gitignore::{Gitignore, GitignoreBuilder};
use jwalk::WalkDir;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::{
  Mutex, OnceLock,
  atomic::{AtomicBool, Ordering},
};

const PACKAGE_MANAGERS: &[&str] = &["pnpm", "npm", "deno", "bun", "yarn"];
const CLI_VERSION: &str = "2.2.0";
static USE_PATH_CACHE: AtomicBool = AtomicBool::new(false);
static PATH_DISPLAY_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

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
  use_path_cache: bool,
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
      let quiet = args.iter().any(|arg| arg == "--silent" || arg == "-s");

      if !quiet {
        eprintln!("❌ {}", e.message);
      }
      process::exit(e.code);
    },
  };

  USE_PATH_CACHE.store(opts.use_path_cache, Ordering::Relaxed);

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
      },
      Mode::Compare => {
        if let Some(targets) = &opts.targets {
          println!(
            "ℹ️  Comparing hashes for specified targets... ({})\n",
            targets.join(", ")
          );
        } else {
          println!("ℹ️  Comparing hashes for all workspaces...\n");
        }
      },
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
      Ok(Some(d)) => d,
      Ok(None) => {
        if let Ok(Some(auto)) = auto_detect() {
          eprintln!(
            "❌ {} workspaces not found. Did you mean --packagemanager={} ?",
            pm, auto.pm
          );
        } else {
          eprintln!(
            "❌ Specified package manager not found and no supported package manager detected"
          );
        }
        process::exit(5);
      },
      Err(error) => {
        eprintln!("❌ {}", error);
        process::exit(99);
      },
    }
  } else {
    match auto_detect() {
      Ok(Some(d)) => d,
      Ok(None) => {
        eprintln!("❌ No workspaces found or unsupported package manager");
        process::exit(4);
      },
      Err(error) => {
        eprintln!("❌ {}", error);
        process::exit(99);
      },
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
  if packages.is_empty() {
    eprintln!("❌ No package.json files found in workspaces");
    process::exit(4);
  }
  resolve_internal_deps(&mut packages);

  let selected_names = select_packages(&packages, opts.targets.as_ref());
  let packages_to_hash = packages_to_hash(&packages, &selected_names);
  compute_package_hashes(
    &mut packages,
    &packages_to_hash,
    &detection.root,
    root_ignore.as_ref(),
    opts.debug,
    opts.unified,
    opts.mode,
    opts.silent,
  )
  .map_err(|e| e.to_string())?;

  let final_hashes = compute_final_hashes(&packages, &packages_to_hash).map_err(|e| {
    if e.code == 6 {
      eprintln!("❌ {}", e.message);
      process::exit(6);
    }
    e.to_string()
  })?;

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
      opts.debug,
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
  let mut use_path_cache = false;
  let mut wants_help = false;
  let mut wants_version = false;

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
        .map(|s| to_posix_path(s.trim_end_matches('/')))
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
    } else if arg == "--pathcache" || arg == "-pc" {
      use_path_cache = true;
    } else if arg == "--help" || arg == "-h" {
      wants_help = true;
    } else if arg == "--version" || arg == "-v" {
      wants_version = true;
    } else {
      return Err(CliError {
        code: 3,
        message: format!("Unknown option : {}", arg),
      });
    }
  }

  if wants_version {
    if !silent {
      println!("monorepo-hash v{CLI_VERSION}");
    }

    return Ok(None);
  }

  if wants_help || mode.is_none() {
    if !silent {
      println!(
        "\nmonorepo-hash by EDM115\nA simple script to generate or compare .hash files for monorepo workspaces\nSupports PNPM, Yarn, NPM, Bun and Deno\n\nArguments :\n  --generate        (-g)  Generate or update .hash files for all workspaces\n  --compare         (-c)  Compare current state with existing .hash files. Capture the exit code to check for changes\n  --target=\"<path>\" (-t)  Specify one or more targets to generate/compare (comma-separated)\n  --silent          (-s)  Suppress output messages\n  --debug           (-d)  Enable debug mode (per-file hashes)\n  --workspaces      (-w)  Use per-workspace .hash files instead of a single root one\n  --packagemanager  (-pm) Force the package manager ({})\n  --pathcache       (-pc) Enable path normalization cache (can augment memory footprint on very large repos)\n  --version         (-v)  Show version information\n  --help            (-h)  Show this help message\n",
        PACKAGE_MANAGERS.join(", ")
      );
    }
    return Ok(None);
  }

  let mode = mode.expect("mode checked above");

  Ok(Some(CliOptions {
    mode,
    targets,
    silent,
    debug,
    unified,
    pm_option,
    use_path_cache,
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

fn to_posix_path(value: &str) -> String {
  if !value.contains('\\') {
    return value.to_string();
  }

  if !USE_PATH_CACHE.load(Ordering::Relaxed) {
    return value.replace('\\', "/");
  }

  let cache = PATH_DISPLAY_CACHE.get_or_init(|| Mutex::new(HashMap::new()));

  {
    let guard = cache.lock().expect("path cache poisoned");

    if let Some(cached) = guard.get(value) {
      return cached.clone();
    }
  }

  let transformed = value.replace('\\', "/");
  let mut guard = cache.lock().expect("path cache poisoned");
  guard.insert(value.to_string(), transformed.clone());

  transformed
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

  if let Some(obj) = value.as_object()
    && let Some(packages) = obj.get("packages").and_then(|v| v.as_array())
  {
    let globs = packages
      .iter()
      .filter_map(|v| v.as_str().map(|s| s.to_string()))
      .collect::<Vec<_>>();
    if !globs.is_empty() {
      return Some(globs);
    }
  }

  None
}

fn find_workspace_package_json(start: &Path) -> Result<Option<PathBuf>, String> {
  let mut current = start.to_path_buf();

  loop {
    let candidate = current.join("package.json");

    if candidate.exists()
      && let Ok(raw) = fs::read_to_string(&candidate)
      && let Ok(parsed) = serde_json::from_str::<PackageJson>(&raw)
      && parsed
        .workspaces
        .as_ref()
        .and_then(workspaces_from_value)
        .is_some()
    {
      return Ok(Some(candidate));
    }

    if !current.pop() {
      return Ok(None);
    }
  }
}

fn detect_pnpm() -> Result<Option<Detection>, String> {
  let cwd = env::current_dir().map_err(|e| e.to_string())?;
  let Some(file) = find_up(&cwd, &["pnpm-workspace.yaml"]) else {
    return Ok(None);
  };
  let Some(root) = file.parent() else {
    return Ok(None);
  };
  let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
  let parsed: PnpmWorkspace = serde_saphyr::from_str(&raw).map_err(|e| e.to_string())?;
  let globs = parsed.packages.unwrap_or_default();

  if globs.is_empty() {
    return Ok(None);
  }

  Ok(Some(Detection {
    pm: "pnpm".to_string(),
    root: root.to_path_buf(),
    globs,
  }))
}

fn detect_deno() -> Result<Option<Detection>, String> {
  let cwd = env::current_dir().map_err(|e| e.to_string())?;
  let Some(file) = find_up(&cwd, &["deno.json", "deno.jsonc"]) else {
    return Ok(None);
  };
  let Some(root) = file.parent() else {
    return Ok(None);
  };
  let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
  let cleaned = strip_json_comments(&raw);
  let parsed: DenoWorkspace = serde_json::from_str(&cleaned).map_err(|e| e.to_string())?;
  let globs = parsed.workspace.unwrap_or_default();

  if globs.is_empty() {
    return Ok(None);
  }

  Ok(Some(Detection {
    pm: "deno".to_string(),
    root: root.to_path_buf(),
    globs,
  }))
}

fn detect_pkg_json() -> Result<Option<Detection>, String> {
  let cwd = env::current_dir().map_err(|e| e.to_string())?;
  let Some(file) = find_workspace_package_json(&cwd)? else {
    return Ok(None);
  };
  let Some(root) = file.parent() else {
    return Ok(None);
  };
  let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
  let parsed: PackageJson = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
  let Some(globs) = parsed.workspaces.as_ref().and_then(workspaces_from_value) else {
    return Ok(None);
  };

  let pm = if root.join("bun.lock").exists() || root.join("bun.lockb").exists() {
    "bun"
  } else if root.join("deno.lock").exists() {
    "deno"
  } else if root.join("yarn.lock").exists() {
    "yarn"
  } else {
    "npm"
  };

  Ok(Some(Detection {
    pm: pm.to_string(),
    root: root.to_path_buf(),
    globs,
  }))
}

fn auto_detect() -> Result<Option<Detection>, String> {
  if let Some(detection) = detect_pnpm()? {
    return Ok(Some(detection));
  }
  if let Some(detection) = detect_deno()? {
    return Ok(Some(detection));
  }

  detect_pkg_json()
}

fn detect_specified(pm: &str) -> Result<Option<Detection>, String> {
  match pm {
    "pnpm" => detect_pnpm(),
    "deno" => detect_deno(),
    "npm" | "yarn" | "bun" => {
      let detected = detect_pkg_json()?;

      Ok(detected.filter(|d| d.pm == pm))
    },
    _ => Ok(None),
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

fn read_json_file<T>(path: &Path, description: &str) -> io::Result<Option<T>>
where
  T: DeserializeOwned,
{
  if !path.exists() {
    return Ok(None);
  }

  let raw = fs::read_to_string(path)?;
  let parsed = serde_json::from_str::<T>(&raw)
    .map_err(|e| io::Error::other(format!("Invalid {description} at {} : {e}", path.display())))?;

  Ok(Some(parsed))
}

fn find_first_supported_extglob(pattern: &str) -> Option<(usize, char)> {
  let bytes = pattern.as_bytes();

  for idx in 0..bytes.len().saturating_sub(1) {
    let op = bytes[idx] as char;

    if (op == '@' || op == '?') && bytes[idx + 1] as char == '(' {
      return Some((idx, op));
    }
  }

  None
}

fn find_matching_paren(pattern: &str, open: usize) -> Option<usize> {
  let bytes = pattern.as_bytes();
  let mut depth = 0;

  for (idx, byte) in bytes.iter().enumerate().skip(open) {
    let ch = *byte as char;

    if ch == '(' {
      depth += 1;
    } else if ch == ')' {
      depth -= 1;

      if depth == 0 {
        return Some(idx);
      }
    }
  }

  None
}

fn split_extglob_alternatives(input: &str) -> Vec<String> {
  let mut parts = Vec::new();
  let mut current = String::new();
  let mut depth = 0;

  for ch in input.chars() {
    match ch {
      '(' => {
        depth += 1;
        current.push(ch);
      },
      ')' => {
        depth -= 1;
        current.push(ch);
      },
      '|' if depth == 0 => {
        parts.push(current);
        current = String::new();
      },
      _ => current.push(ch),
    }
  }

  parts.push(current);
  parts
}

fn find_first_brace_group(pattern: &str) -> Option<(usize, usize)> {
  let mut depth = 0;
  let mut start = None;

  for (idx, ch) in pattern.char_indices() {
    match ch {
      '{' => {
        if depth == 0 {
          start = Some(idx);
        }
        depth += 1;
      },
      '}' => {
        if depth == 0 {
          continue;
        }

        depth -= 1;

        if depth == 0 {
          return start.map(|open| (open, idx));
        }
      },
      _ => {},
    }
  }

  None
}

fn split_brace_alternatives(input: &str) -> Vec<String> {
  let mut parts = Vec::new();
  let mut current = String::new();
  let mut depth = 0;

  for ch in input.chars() {
    match ch {
      '{' => {
        depth += 1;
        current.push(ch);
      },
      '}' => {
        depth -= 1;
        current.push(ch);
      },
      ',' if depth == 0 => {
        parts.push(current);
        current = String::new();
      },
      _ => current.push(ch),
    }
  }

  parts.push(current);
  parts
}

fn expand_brace_glob(pattern: &str) -> Vec<String> {
  let Some((open, close)) = find_first_brace_group(pattern) else {
    return vec![pattern.to_string()];
  };

  let prefix = &pattern[..open];
  let suffix = &pattern[close + 1..];
  let alts = split_brace_alternatives(&pattern[open + 1..close]);
  let mut expanded = Vec::new();

  for alt in alts {
    expanded.extend(expand_workspace_pattern(&format!("{prefix}{alt}{suffix}")));
  }

  expanded
}

fn expand_supported_extglob(pattern: &str) -> Vec<String> {
  let Some((idx, op)) = find_first_supported_extglob(pattern) else {
    return vec![pattern.to_string()];
  };
  let open = idx + 1;
  let Some(close) = find_matching_paren(pattern, open) else {
    return vec![pattern.to_string()];
  };

  let alts = split_extglob_alternatives(&pattern[open + 1..close]);
  let mut replacements = Vec::new();

  match op {
    '@' => replacements.extend(alts),
    '?' => {
      replacements.push(String::new());
      replacements.extend(alts);
    },
    _ => return vec![pattern.to_string()],
  }

  let prefix = &pattern[..idx];
  let suffix = &pattern[close + 1..];
  let mut expanded = Vec::new();

  for replacement in replacements {
    expanded.extend(expand_workspace_pattern(&format!(
      "{prefix}{replacement}{suffix}"
    )));
  }

  expanded
}

fn expand_workspace_pattern(pattern: &str) -> Vec<String> {
  if find_first_brace_group(pattern).is_some() {
    return expand_brace_glob(pattern);
  }

  if find_first_supported_extglob(pattern).is_some() {
    return expand_supported_extglob(pattern);
  }

  vec![pattern.to_string()]
}

#[derive(Debug)]
struct WorkspacePatternSpec {
  negated: bool,
  patterns: Vec<String>,
}

fn prepare_workspace_patterns(globs: &[String]) -> Vec<WorkspacePatternSpec> {
  let mut specs = Vec::new();

  for glob in globs {
    let negated = glob.starts_with('!');
    let raw_pattern = glob
      .trim_start_matches('!')
      .trim_start_matches("./")
      .trim_end_matches('/');
    let raw_pattern = if raw_pattern == "." { "" } else { raw_pattern };

    if raw_pattern.is_empty() && !glob.starts_with('.') && !glob.starts_with("!.") {
      continue;
    }

    let mut patterns = expand_workspace_pattern(raw_pattern)
      .into_iter()
      .map(|pattern| pattern.trim_matches('/').to_string())
      .collect::<Vec<_>>();

    patterns.sort();
    patterns.dedup();

    if !patterns.is_empty() {
      specs.push(WorkspacePatternSpec { negated, patterns });
    }
  }

  specs
}

fn workspace_pattern_matches(pattern: &str, rel: &str, rel_dir: &str) -> bool {
  if pattern.is_empty() {
    return rel == "package.json";
  }

  if pattern.contains('*') || pattern.contains('?') || pattern.contains('[') {
    let candidate = format!("{rel_dir}/package.json");
    let glob_pattern = format!("{pattern}/package.json");

    return glob_match::glob_match(&glob_pattern, &candidate);
  }

  rel_dir == pattern
}

fn load_packages(detection: &Detection) -> io::Result<HashMap<String, PackageInfo>> {
  let mut package_jsons = BTreeSet::new();

  let pattern_specs = prepare_workspace_patterns(&detection.globs);

  for entry in
    WalkDir::new(&detection.root)
      .sort(true)
      .process_read_dir(|_, _, _, dir_entry_results| {
        dir_entry_results.retain(|dir_entry_result| match dir_entry_result {
          Ok(dir_entry) => {
            !dir_entry.file_type.is_dir()
              || !matches!(dir_entry.file_name.to_str(), Some("node_modules" | ".git"))
          },
          Err(_) => true,
        });
      })
  {
    let entry = match entry {
      Ok(entry) => entry,
      Err(err) => return Err(io::Error::other(err.to_string())),
    };

    if !entry.file_type().is_file() {
      continue;
    }

    if entry.file_name() != "package.json" {
      continue;
    }

    let path = entry.path();
    let rel = to_posix_path(
      &path
        .strip_prefix(&detection.root)
        .unwrap_or(&path)
        .to_string_lossy(),
    );
    let rel_dir = rel.strip_suffix("/package.json").unwrap_or("");
    let mut included = false;

    for spec in &pattern_specs {
      if spec
        .patterns
        .iter()
        .any(|pattern| workspace_pattern_matches(pattern, &rel, rel_dir))
      {
        included = !spec.negated;
      }
    }

    if included {
      package_jsons.insert(path.to_path_buf());
    }
  }

  let mut packages = HashMap::new();

  for package_json_path in package_jsons {
    let raw = fs::read_to_string(&package_json_path)?;
    let parsed: PackageJson =
      serde_json::from_str(&raw).map_err(|e| io::Error::other(e.to_string()))?;

    let name = parsed
      .name
      .ok_or_else(|| io::Error::other("Package missing name"))?;

    let dir = package_json_path
      .parent()
      .unwrap_or(&detection.root)
      .to_path_buf();
    let rel = dir
      .strip_prefix(&detection.root)
      .unwrap_or(&dir)
      .to_string_lossy()
      .to_string();
    let rel = to_posix_path(&rel);

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

fn select_packages(
  packages: &HashMap<String, PackageInfo>,
  targets: Option<&Vec<String>>,
) -> Vec<String> {
  let mut selected = BTreeSet::new();

  if let Some(targets) = targets {
    let rel_to_name = packages
      .iter()
      .map(|(name, pkg)| (pkg.rel_dir_posix.clone(), name.clone()))
      .collect::<HashMap<_, _>>();

    for target in targets {
      if let Some(name) = rel_to_name.get(target) {
        selected.insert(name.clone());
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

fn packages_to_hash(packages: &HashMap<String, PackageInfo>, selected: &[String]) -> Vec<String> {
  fn add_with_deps(
    name: &str,
    packages: &HashMap<String, PackageInfo>,
    selected: &mut BTreeSet<String>,
  ) {
    if !selected.insert(name.to_string()) {
      return;
    }
    if let Some(pkg) = packages.get(name) {
      for dep in &pkg.deps {
        add_with_deps(dep, packages, selected);
      }
    }
  }

  let mut to_hash = BTreeSet::new();

  for name in selected {
    add_with_deps(name, packages, &mut to_hash);
  }

  let mut names = to_hash.into_iter().collect::<Vec<_>>();
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
    .to_string();
  let rel_repo = to_posix_path(&rel_repo);
  if let Some(ignore) = root_ignore
    && ignore
      .matched_path_or_any_parents(Path::new(&rel_repo), is_dir)
      .is_ignore()
  {
    return true;
  }

  let rel_pkg = path
    .strip_prefix(pkg_root)
    .unwrap_or(path)
    .to_string_lossy()
    .to_string();
  let rel_pkg = to_posix_path(&rel_pkg);
  if let Some(ignore) = local_ignore
    && ignore
      .matched_path_or_any_parents(Path::new(&rel_pkg), is_dir)
      .is_ignore()
  {
    return true;
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
      .to_string();
    let rel_pkg = to_posix_path(&rel_pkg);

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
  const HEX: &[u8; 16] = b"0123456789abcdef";

  let mut out = String::with_capacity(bytes.len() * 2);

  for b in bytes {
    out.push(HEX[(b >> 4) as usize] as char);
    out.push(HEX[(b & 0x0f) as usize] as char);
  }

  out
}

fn zero_pad(num: usize, places: usize) -> String {
  format!("{num:0places$}")
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

#[allow(clippy::too_many_arguments)]
fn compute_package_hashes(
  packages: &mut HashMap<String, PackageInfo>,
  selected: &[String],
  repo_root: &Path,
  root_ignore: Option<&Gitignore>,
  debug: bool,
  unified: bool,
  mode: Mode,
  silent: bool,
) -> io::Result<()> {
  let mut root_debug = BTreeMap::<String, BTreeMap<String, String>>::new();
  let total = selected.len();
  let pad = if total >= 100 {
    3
  } else if total >= 10 {
    2
  } else {
    1
  };

  if !silent {
    println!("\r🔄 Computing hashes ({}/{})", zero_pad(0, pad), total);
  }

  for (idx, name) in selected.iter().enumerate() {
    let (pkg_dir, pkg_rel_dir) = {
      let pkg = packages
        .get(name)
        .ok_or_else(|| io::Error::other("Package missing metadata"))?;

      (pkg.dir.clone(), pkg.rel_dir_posix.clone())
    };

    let local_ignore = compile_local_ignore(&pkg_dir)?;
    let mut files = Vec::new();
    collect_workspace_files(
      &pkg_dir,
      repo_root,
      &pkg_dir,
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

    if !silent {
      println!(
        "\r🔄 Computing hashes ({}/{}) • {}",
        zero_pad(idx + 1, pad),
        total,
        pkg_rel_dir
      );
    }

    if debug && mode == Mode::Generate {
      if unified {
        root_debug.insert(pkg_rel_dir, per_file);
      } else {
        let content = serde_json::to_string_pretty(&per_file).unwrap_or("{}".to_string());
        fs::write(pkg_dir.join(".debug-hash"), content)?;
      }
    }
  }

  if debug && unified && mode == Mode::Generate {
    let content = serde_json::to_string_pretty(&root_debug).unwrap_or("{}".to_string());
    fs::write(repo_root.join(".debug-hash"), content)?;
  }

  if !silent {
    println!("\r✅ Computed all hashes ({})", total);
    println!();
    println!();
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
    let root_hash_path = repo_root.join(".hash");
    let mut root = read_json_file::<BTreeMap<String, String>>(&root_hash_path, "root .hash file")?
      .unwrap_or_default();

    for name in selected {
      if let (Some(pkg), Some(hash)) = (packages.get(name), final_hashes.get(name)) {
        root.insert(pkg.rel_dir_posix.clone(), hash.clone());
      }
    }
    let content = serde_json::to_string_pretty(&root).unwrap_or("{}".to_string());
    fs::write(root_hash_path, content)?;

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
      fs::write(pkg.dir.join(".hash"), hash)?;
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
  debug: bool,
  silent: bool,
) -> io::Result<()> {
  let mut old_by_name = HashMap::new();
  let mut root_debug = None;

  if unified {
    let root_hash_path = repo_root.join(".hash");
    if let Some(parsed) =
      read_json_file::<HashMap<String, String>>(&root_hash_path, "root .hash file")?
    {
      for (name, pkg) in packages {
        if let Some(old) = parsed.get(&pkg.rel_dir_posix)
          && !old.is_empty()
        {
          old_by_name.insert(name.clone(), old.clone());
        }
      }
    }

    if debug {
      let root_debug_path = repo_root.join(".debug-hash");
      root_debug = read_json_file::<HashMap<String, HashMap<String, String>>>(
        &root_debug_path,
        "root .debug-hash file",
      )?;
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

    if debug {
      if unified {
        if let Some(root_debug) = root_debug.as_ref() {
          generate_debug(pkg, root_debug.get(&pkg.rel_dir_posix), silent);
        }
      } else {
        let debug_path = pkg.dir.join(".debug-hash");
        let old_debug = if debug_path.exists() {
          let raw = fs::read_to_string(debug_path)?;

          serde_json::from_str::<HashMap<String, String>>(&raw).ok()
        } else {
          None
        };

        generate_debug(pkg, old_debug.as_ref(), silent);
      }
    }

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

fn generate_debug(
  pkg: &PackageInfo,
  old_debug: Option<&HashMap<String, String>>,
  silent: bool,
) -> Vec<String> {
  let Some(old_debug) = old_debug else {
    if !silent {
      println!(
        "❓ <debug> {} has no .debug-hash to compare",
        pkg.rel_dir_posix
      );
      println!();
    }

    return Vec::new();
  };

  let mut seen = BTreeSet::new();

  for key in old_debug.keys() {
    seen.insert(key.clone());
  }
  for key in pkg.per_file_hashes.keys() {
    seen.insert(key.clone());
  }

  let mut diverged = Vec::new();

  for key in seen {
    if old_debug.get(&key) != pkg.per_file_hashes.get(&key) {
      diverged.push(key);
    }
  }

  if !diverged.is_empty() && !silent {
    println!("⚠️  <debug> {} diverging files :", pkg.rel_dir_posix);
    for key in &diverged {
      println!("  • {}", key);
    }
    println!();
  }

  diverged
}
