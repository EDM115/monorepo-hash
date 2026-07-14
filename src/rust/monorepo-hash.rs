use ignore::gitignore::{Gitignore, GitignoreBuilder};
use jwalk::{Parallelism, WalkDir};
use rayon::prelude::*;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
  cell::RefCell,
  collections::{BTreeMap, HashMap, HashSet},
  env, fs,
  io::{self, IsTerminal, Write},
  path::{Path, PathBuf},
  process,
  sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

const PACKAGE_MANAGERS: &[&str] = &["pnpm", "npm", "deno", "bun", "yarn"];
const CLI_VERSION: &str = "3.0.0";
static USE_PATH_CACHE: AtomicBool = AtomicBool::new(false);
type DigestBytes = [u8; 32];

thread_local! {
  static PATH_DISPLAY_CACHE: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

macro_rules! outln {
  ($silent:expr, $($arg:tt)*) => {
    if !$silent {
      println!($($arg)*);
    }
  };
}

macro_rules! errln {
  ($silent:expr, $($arg:tt)*) => {
    if !$silent {
      eprintln!($($arg)*);
    }
  };
}

fn progressln(silent: bool, message: impl AsRef<str>) {
  if silent {
    return;
  }

  let message = message.as_ref();

  if io::stdout().is_terminal() {
    print!("\r\x1b[2K{message}");
    let _ = io::stdout().flush();
  } else {
    println!("\r{message}");
  }
}

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
  workspace: Option<Value>,
}

#[derive(Deserialize, Debug)]
struct PackageJson {
  name: Option<String>,
  dependencies: Option<HashMap<String, String>>,
  #[serde(rename = "devDependencies")]
  dev_dependencies: Option<HashMap<String, String>>,
  #[serde(rename = "peerDependencies")]
  peer_dependencies: Option<HashMap<String, String>>,
  #[serde(rename = "optionalDependencies")]
  optional_dependencies: Option<HashMap<String, String>>,
  #[serde(rename = "packageManager")]
  package_manager: Option<Value>,
  #[serde(rename = "devEngines")]
  dev_engines: Option<Value>,
  workspaces: Option<Value>,
}

#[derive(Debug)]
struct PackageJsonWorkspace {
  root: PathBuf,
  globs: Vec<String>,
  manifest: PackageJson,
}

#[derive(Clone, Debug)]
struct PackageInfo {
  dir: PathBuf,
  rel_dir_posix: String,
  deps: Vec<String>,
  per_file_hashes: Option<HashMap<String, DigestBytes>>,
  own_hash: DigestBytes,
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

#[derive(Debug)]
struct LoadedPackage {
  name: String,
  dir: PathBuf,
  rel_dir_posix: String,
  manifest: PackageJson,
}

#[derive(Debug)]
struct HashedWorkspace {
  name: String,
  per_file_hashes: Option<HashMap<String, DigestBytes>>,
  own_hash: DigestBytes,
}

fn args_request_silent(args: &[String]) -> bool {
  args.iter().any(|arg| arg == "--silent" || arg == "-s")
}

fn main() {
  let args: Vec<String> = env::args().skip(1).collect();

  if let Err(err) = run(&args) {
    errln!(args_request_silent(&args), "❌ Unexpected error :\n{}", err);
    process::exit(99);
  }
}

fn run(args: &[String]) -> Result<(), String> {
  let opts = match parse_args(args) {
    Ok(Some(o)) => o,
    Ok(None) => return Ok(()),
    Err(e) => {
      errln!(args_request_silent(args), "❌ {}", e.message);
      process::exit(e.code);
    },
  };

  USE_PATH_CACHE.store(opts.use_path_cache, Ordering::Relaxed);

  if !opts.silent {
    match opts.mode {
      Mode::Generate => {
        if let Some(targets) = &opts.targets {
          outln!(
            opts.silent,
            "ℹ️  Generating hashes for specified targets... ({})\n",
            targets.join(", ")
          );
        } else {
          outln!(opts.silent, "ℹ️  Generating hashes for all workspaces...\n");
        }
      },
      Mode::Compare => {
        if let Some(targets) = &opts.targets {
          outln!(
            opts.silent,
            "ℹ️  Comparing hashes for specified targets... ({})\n",
            targets.join(", ")
          );
        } else {
          outln!(opts.silent, "ℹ️  Comparing hashes for all workspaces...\n");
        }
      },
    }

    if opts.debug {
      outln!(opts.silent, "ℹ️  Debug mode enabled\n");
    }
    if !opts.unified {
      outln!(opts.silent, "ℹ️  Per-workspace mode enabled\n");
    }
  }

  let detection = if let Some(pm) = &opts.pm_option {
    match detect_specified(pm) {
      Ok(Some(d)) => d,
      Ok(None) => match auto_detect() {
        Ok(Some(auto)) => {
          errln!(
            opts.silent,
            "❌ {} workspaces not found. Did you mean --packagemanager={} ?",
            pm,
            auto.pm
          );
          process::exit(5);
        },
        Ok(None) => {
          errln!(
            opts.silent,
            "❌ Specified package manager not found and no supported package manager detected"
          );
          process::exit(5);
        },
        Err(error) => {
          errln!(opts.silent, "❌ {}", error);
          process::exit(99);
        },
      },
      Err(error) => {
        errln!(opts.silent, "❌ {}", error);
        process::exit(99);
      },
    }
  } else {
    match auto_detect() {
      Ok(Some(d)) => d,
      Ok(None) => {
        errln!(
          opts.silent,
          "❌ No workspaces found or unsupported package manager"
        );
        process::exit(4);
      },
      Err(error) => {
        errln!(opts.silent, "❌ {}", error);
        process::exit(99);
      },
    }
  };

  outln!(
    opts.silent,
    "ℹ️  Using {} workspaces from {}\n",
    detection.pm,
    detection.root.display()
  );

  let root_ignore = compile_root_ignore(&detection.root).map_err(|e| e.to_string())?;

  let mut packages = load_packages(&detection).map_err(|e| e.to_string())?;
  if packages.is_empty() {
    errln!(opts.silent, "❌ No package.json files found in workspaces");
    process::exit(4);
  }

  let selected_names = select_packages(&packages, opts.targets.as_ref());
  let packages_to_hash = packages_to_hash(&packages, &selected_names);
  compute_package_hashes(
    &mut packages,
    &packages_to_hash,
    &selected_names,
    opts.targets.is_some(),
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
      errln!(opts.silent, "❌ {}", e.message);
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
        .map(canonicalize_target)
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
    outln!(silent, "monorepo-hash v{CLI_VERSION}");

    return Ok(None);
  }

  if wants_help || mode.is_none() {
    outln!(
      silent,
      "\nmonorepo-hash by EDM115\nA simple script to generate or compare .hash files for monorepo workspaces\nSupports PNPM, Yarn, NPM, Bun and Deno\n\nArguments :\n  --generate        (-g)  Generate or update .hash files for all workspaces\n  --compare         (-c)  Compare current state with existing .hash files. Capture the exit code to check for changes\n  --target=\"<path>\" (-t)  Specify one or more targets to generate/compare (comma-separated)\n  --silent          (-s)  Suppress output messages\n  --debug           (-d)  Enable debug mode (per-file hashes)\n  --workspaces      (-w)  Use per-workspace .hash files instead of a single root one\n  --packagemanager  (-pm) Force the package manager ({})\n  --pathcache       (-pc) Enable path normalization cache (can augment memory footprint on very large repos)\n  --version         (-v)  Show version information\n  --help            (-h)  Show this help message\n",
      PACKAGE_MANAGERS.join(", ")
    );
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

fn read_json_file<T>(path: &Path, description: &str) -> io::Result<Option<T>>
where
  T: DeserializeOwned,
{
  let raw = match fs::read_to_string(path) {
    Ok(raw) => raw,
    Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
    Err(err) => return Err(err),
  };

  let parsed = serde_json::from_str::<T>(&raw)
    .map_err(|e| io::Error::other(format!("Invalid {description} at {} : {e}", path.display())))?;

  Ok(Some(parsed))
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

  PATH_DISPLAY_CACHE.with(|cache| {
    let mut cache = cache.borrow_mut();

    if let Some(cached) = cache.get(value) {
      return cached.clone();
    }

    let transformed = value.replace('\\', "/");
    cache.insert(value.to_string(), transformed.clone());

    transformed
  })
}

fn canonicalize_target(target: &str) -> String {
  let mut normalized = String::with_capacity(target.len());
  let mut previous_was_separator = false;

  for character in target.chars() {
    if matches!(character, '/' | '\\') {
      if !previous_was_separator {
        normalized.push('/');
      }
      previous_was_separator = true;
    } else {
      normalized.push(character);
      previous_was_separator = false;
    }
  }

  let trimmed_len = normalized.trim_end_matches('/').len();
  normalized.truncate(trimmed_len);

  if normalized == "." {
    String::new()
  } else {
    normalized
  }
}

fn path_relative_to_posix(path: &Path, base: &Path) -> String {
  to_posix_path(&path.strip_prefix(base).unwrap_or(path).to_string_lossy())
}

fn strip_json_comments(input: &str) -> String {
  let mut out = Vec::with_capacity(input.len());
  let bytes = input.as_bytes();
  let mut i = 0;
  let mut in_str = false;
  let mut escape = false;

  while i < bytes.len() {
    let c = bytes[i];
    if in_str {
      out.push(c);
      if escape {
        escape = false;
      } else if c == b'\\' {
        escape = true;
      } else if c == b'"' {
        in_str = false;
      }
      i += 1;
      continue;
    }

    if c == b'"' {
      in_str = true;
      out.push(c);
      i += 1;
      continue;
    }

    if c == b'/' && i + 1 < bytes.len() {
      let n = bytes[i + 1];
      if n == b'/' {
        out.extend_from_slice(b"  ");
        i += 2;
        while i < bytes.len() && !matches!(bytes[i], b'\n' | b'\r') {
          out.push(b' ');
          i += 1;
        }
        continue;
      }
      if n == b'*' {
        out.extend_from_slice(b"  ");
        i += 2;
        while i < bytes.len() {
          if bytes[i] == b'*' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            out.extend_from_slice(b"  ");
            i += 2;
            break;
          }
          out.push(if matches!(bytes[i], b'\n' | b'\r') {
            bytes[i]
          } else {
            b' '
          });
          i += 1;
        }
        continue;
      }
    }

    out.push(c);
    i += 1;
  }

  String::from_utf8(out).unwrap_or_default()
}

fn is_json_whitespace(value: u8) -> bool {
  matches!(value, b' ' | b'\t' | b'\n' | b'\r')
}

fn normalize_jsonc(input: &str) -> String {
  let without_comments = strip_json_comments(input);
  let bytes = without_comments.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut in_str = false;
  let mut escape = false;

  for (index, value) in bytes.iter().copied().enumerate() {
    if in_str {
      out.push(value);
      if escape {
        escape = false;
      } else if value == b'\\' {
        escape = true;
      } else if value == b'"' {
        in_str = false;
      }
      continue;
    }

    if value == b'"' {
      in_str = true;
      out.push(value);
      continue;
    }

    if value == b',' {
      let mut next = index + 1;
      while next < bytes.len() && is_json_whitespace(bytes[next]) {
        next += 1;
      }
      if next < bytes.len() && matches!(bytes[next], b']' | b'}') {
        out.push(b' ');
        continue;
      }
    }

    out.push(value);
  }

  String::from_utf8(out).unwrap_or_default()
}

fn workspace_globs_from_value(value: &Value, object_key: &str) -> Option<Vec<String>> {
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
    && let Some(packages) = obj.get(object_key).and_then(|v| v.as_array())
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

fn package_manager_from_string(value: &Value) -> Option<&str> {
  let value = value.as_str()?;
  let separator = value.find('@').filter(|index| *index > 0);
  let name = separator.map_or(value, |index| &value[..index]);

  matches!(name, "npm" | "pnpm" | "yarn" | "bun" | "deno").then_some(name)
}

fn declared_package_manager(manifest: &PackageJson) -> Option<&str> {
  if let Some(package_manager) = manifest
    .package_manager
    .as_ref()
    .and_then(package_manager_from_string)
  {
    return Some(package_manager);
  }

  let field = manifest
    .dev_engines
    .as_ref()?
    .as_object()?
    .get("packageManager")?;

  if let Some(entries) = field.as_array() {
    for entry in entries {
      if let Some(name) = entry
        .as_object()
        .and_then(|object| object.get("name"))
        .and_then(Value::as_str)
        && matches!(name, "npm" | "pnpm" | "yarn" | "bun" | "deno")
      {
        return Some(name);
      }
    }

    return None;
  }

  let name = field
    .as_object()
    .and_then(|object| object.get("name"))
    .and_then(Value::as_str)?;

  matches!(name, "npm" | "pnpm" | "yarn" | "bun" | "deno").then_some(name)
}

fn find_package_json_workspace(start: &Path) -> Result<Option<PackageJsonWorkspace>, String> {
  let mut current = start.to_path_buf();

  loop {
    let candidate = current.join("package.json");

    if candidate.exists()
      && let Ok(raw) = fs::read_to_string(&candidate)
      && let Ok(parsed) = serde_json::from_str::<PackageJson>(&raw)
      && let Some(workspaces) = parsed.workspaces.as_ref()
    {
      return Ok(Some(PackageJsonWorkspace {
        root: current,
        globs: workspace_globs_from_value(workspaces, "packages").unwrap_or_default(),
        manifest: parsed,
      }));
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
  let cleaned = normalize_jsonc(&raw);
  let parsed: DenoWorkspace = match serde_json::from_str(&cleaned) {
    Ok(parsed) => parsed,
    Err(_) => return Ok(None),
  };
  let globs = parsed
    .workspace
    .as_ref()
    .and_then(|workspace| workspace_globs_from_value(workspace, "members"))
    .unwrap_or_default();

  if globs.is_empty() {
    return Ok(None);
  }

  Ok(Some(Detection {
    pm: "deno".to_string(),
    root: root.to_path_buf(),
    globs,
  }))
}

fn package_manager_from_root(workspace: &PackageJsonWorkspace) -> &str {
  if let Some(package_manager) = declared_package_manager(&workspace.manifest) {
    return package_manager;
  }

  let root = &workspace.root;

  if root.join("pnpm-workspace.yaml").exists() || root.join("pnpm-lock.yaml").exists() {
    return "pnpm";
  }
  if root.join("yarn.lock").exists() || root.join(".yarnrc.yml").exists() {
    return "yarn";
  }
  if root.join("package-lock.json").exists() {
    return "npm";
  }
  if root.join("bun.lock").exists() || root.join("bun.lockb").exists() {
    return "bun";
  }
  if root.join("deno.lock").exists() {
    return "deno";
  }
  if root.join(".pnpmfile.cjs").exists() || root.join("pnpmfile.cjs").exists() {
    return "pnpm";
  }
  if root.join("bunfig.toml").exists() {
    return "bun";
  }
  if root.join("yarn.config.cjs").exists() {
    return "yarn";
  }

  "npm"
}

fn package_json_detection(
  workspace: &PackageJsonWorkspace,
  package_manager: &str,
) -> Option<Detection> {
  if workspace.globs.is_empty() {
    return None;
  }

  Some(Detection {
    pm: package_manager.to_string(),
    root: workspace.root.clone(),
    globs: workspace.globs.clone(),
  })
}

fn detect_package_json_workspace(workspace: &PackageJsonWorkspace) -> Option<Detection> {
  package_json_detection(workspace, package_manager_from_root(workspace))
}

fn detect_pkg_json() -> Result<Option<Detection>, String> {
  let cwd = env::current_dir().map_err(|e| e.to_string())?;
  let Some(workspace) = find_package_json_workspace(&cwd)? else {
    return Ok(None);
  };

  Ok(detect_package_json_workspace(&workspace))
}

fn auto_detect() -> Result<Option<Detection>, String> {
  let cwd = env::current_dir().map_err(|e| e.to_string())?;
  let package_json_workspace = find_package_json_workspace(&cwd)?;

  if let Some(workspace) = package_json_workspace.as_ref()
    && let Some(package_manager) = declared_package_manager(&workspace.manifest)
    && let Some(detection) = package_json_detection(workspace, package_manager)
  {
    return Ok(Some(detection));
  }

  if let Some(detection) = detect_pnpm()? {
    return Ok(Some(detection));
  }
  if let Some(detection) = detect_deno()? {
    return Ok(Some(detection));
  }

  Ok(
    package_json_workspace
      .as_ref()
      .and_then(detect_package_json_workspace),
  )
}

fn detect_specified(pm: &str) -> Result<Option<Detection>, String> {
  match pm {
    "pnpm" => {
      if let Some(detection) = detect_pnpm()? {
        return Ok(Some(detection));
      }
    },
    "deno" => {
      if let Some(detection) = detect_deno()? {
        return Ok(Some(detection));
      }
    },
    "npm" | "yarn" | "bun" => {},
    _ => return Ok(None),
  }

  let detected = detect_pkg_json()?;

  Ok(detected.filter(|d| d.pm == pm))
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

fn contains_workspace_glob_meta(pattern: &str) -> bool {
  let bytes = pattern.as_bytes();

  for (idx, byte) in bytes.iter().enumerate() {
    let ch = *byte as char;

    if matches!(ch, '*' | '[' | '{' | '?') {
      return true;
    }

    if ch == '@' && bytes.get(idx + 1).is_some_and(|next| *next as char == '(') {
      return true;
    }
  }

  false
}

fn workspace_pattern_search_root(pattern: &str) -> String {
  let bytes = pattern.as_bytes();
  let mut wildcard_idx = pattern.len();

  for (idx, byte) in bytes.iter().enumerate() {
    let ch = *byte as char;

    if matches!(ch, '*' | '[' | '{' | '?')
      || (ch == '@' && bytes.get(idx + 1).is_some_and(|next| *next as char == '('))
    {
      wildcard_idx = idx;
      break;
    }
  }

  let prefix = &pattern[..wildcard_idx];

  prefix
    .rsplit_once('/')
    .map(|(dir, _)| dir.trim_matches('/').to_string())
    .unwrap_or_default()
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

fn collect_workspace_package_jsons(root: &Path, globs: &[String]) -> io::Result<Vec<PathBuf>> {
  let mut seen = HashSet::new();

  for spec in prepare_workspace_patterns(globs) {
    for pattern in spec.patterns {
      if pattern.is_empty() || !contains_workspace_glob_meta(&pattern) {
        let mut candidate = root.to_path_buf();

        if !pattern.is_empty() {
          for part in pattern.split('/') {
            candidate.push(part);
          }
        }

        candidate.push("package.json");

        if candidate.is_file() {
          if spec.negated {
            seen.remove(&candidate);
          } else {
            seen.insert(candidate);
          }
        }

        continue;
      }

      let search_root_rel = workspace_pattern_search_root(&pattern);
      let start_dir = if search_root_rel.is_empty() {
        root.to_path_buf()
      } else {
        let mut start = root.to_path_buf();

        for part in search_root_rel.split('/') {
          start.push(part);
        }

        start
      };

      if !start_dir.exists() {
        continue;
      }

      for entry in WalkDir::new(&start_dir)
        .skip_hidden(false)
        .sort(true)
        .process_read_dir(|_, _, _, entries| {
          entries.retain(|entry_result| match entry_result {
            Ok(entry) => {
              !entry.file_type.is_dir()
                || !matches!(entry.file_name.to_str(), Some("node_modules" | ".git"))
            },
            Err(_) => true,
          });
        })
      {
        let entry = entry.map_err(|e| io::Error::other(e.to_string()))?;

        if !entry.file_type().is_file() || entry.file_name() != "package.json" {
          continue;
        }

        let path = entry.path().to_path_buf();
        let rel = to_posix_path(&path.strip_prefix(root).unwrap_or(&path).to_string_lossy());
        let rel_dir = rel.strip_suffix("/package.json").unwrap_or("");

        if workspace_pattern_matches(&pattern, &rel, rel_dir) {
          if spec.negated {
            seen.remove(&path);
          } else {
            seen.insert(path);
          }
        }
      }
    }
  }

  let mut matches = seen.into_iter().collect::<Vec<_>>();
  matches.sort();

  Ok(matches)
}

fn load_packages(detection: &Detection) -> io::Result<HashMap<String, PackageInfo>> {
  let package_jsons = collect_workspace_package_jsons(&detection.root, &detection.globs)?;
  let mut loaded = Vec::with_capacity(package_jsons.len());

  for package_json_path in package_jsons {
    let raw = fs::read_to_string(&package_json_path)?;
    let parsed: PackageJson =
      serde_json::from_str(&raw).map_err(|e| io::Error::other(e.to_string()))?;

    let name = parsed
      .name
      .clone()
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
    loaded.push(LoadedPackage {
      name,
      dir,
      rel_dir_posix: to_posix_path(&rel),
      manifest: parsed,
    });
  }

  let package_names = loaded
    .iter()
    .map(|pkg| pkg.name.clone())
    .collect::<HashSet<_>>();
  let mut packages = HashMap::with_capacity(loaded.len());

  for loaded_pkg in loaded {
    let mut deps = HashSet::new();

    if let Some(map) = loaded_pkg.manifest.dependencies.as_ref() {
      for dep in map.keys() {
        if package_names.contains(dep) {
          deps.insert(dep.clone());
        }
      }
    }
    if let Some(map) = loaded_pkg.manifest.dev_dependencies.as_ref() {
      for dep in map.keys() {
        if package_names.contains(dep) {
          deps.insert(dep.clone());
        }
      }
    }
    if let Some(map) = loaded_pkg.manifest.peer_dependencies.as_ref() {
      for dep in map.keys() {
        if package_names.contains(dep) {
          deps.insert(dep.clone());
        }
      }
    }
    if let Some(map) = loaded_pkg.manifest.optional_dependencies.as_ref() {
      for dep in map.keys() {
        if package_names.contains(dep) {
          deps.insert(dep.clone());
        }
      }
    }

    let mut deps = deps.into_iter().collect::<Vec<_>>();
    deps.sort();

    packages.insert(
      loaded_pkg.name,
      PackageInfo {
        dir: loaded_pkg.dir,
        rel_dir_posix: loaded_pkg.rel_dir_posix,
        deps,
        per_file_hashes: None,
        own_hash: [0; 32],
      },
    );
  }

  Ok(packages)
}

fn select_packages(
  packages: &HashMap<String, PackageInfo>,
  targets: Option<&Vec<String>>,
) -> Vec<String> {
  let mut selected = HashSet::new();

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
    selected: &mut HashSet<String>,
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

  let mut to_hash = HashSet::new();

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
  if let Some(ignore) = root_ignore
    && ignore
      .matched_path_or_any_parents(Path::new(&path_relative_to_posix(path, repo_root)), is_dir)
      .is_ignore()
  {
    return true;
  }

  if let Some(ignore) = local_ignore
    && ignore
      .matched_path_or_any_parents(Path::new(&path_relative_to_posix(path, pkg_root)), is_dir)
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
) -> io::Result<Vec<(PathBuf, String)>> {
  let mut out = Vec::new();
  let repo_root_buf = repo_root.to_path_buf();
  let pkg_root_buf = pkg_root.to_path_buf();
  let root_ignore = root_ignore.cloned();
  let local_ignore = local_ignore.cloned();

  for entry in WalkDir::new(dir)
    .skip_hidden(false)
    .parallelism(Parallelism::Serial)
    .sort(true)
    .process_read_dir(move |_, _, _, entries| {
      entries.retain(|entry_result| match entry_result {
        Ok(e) => {
          let file_name = e.file_name.to_str();

          if e.file_type.is_dir() {
            if matches!(file_name, Some("node_modules" | ".git")) {
              return false;
            }

            let path = e.parent_path.join(&e.file_name);

            return !should_ignore_path(
              &path,
              true,
              &repo_root_buf,
              &pkg_root_buf,
              root_ignore.as_ref(),
              local_ignore.as_ref(),
            );
          }

          if e.file_type.is_file() {
            if matches!(file_name, Some(".hash" | ".debug-hash")) {
              return false;
            }

            let path = e.parent_path.join(&e.file_name);

            return !should_ignore_path(
              &path,
              false,
              &repo_root_buf,
              &pkg_root_buf,
              root_ignore.as_ref(),
              local_ignore.as_ref(),
            );
          }

          true
        },
        Err(_) => true,
      });
    })
  {
    let entry = entry.map_err(|e| io::Error::other(e.to_string()))?;
    let path = entry.path();

    if !entry.file_type().is_file() {
      continue;
    }

    out.push((path.to_path_buf(), path_relative_to_posix(&path, pkg_root)));
  }

  out.sort_unstable_by(|a, b| a.1.cmp(&b.1));
  Ok(out)
}

fn sha256_bytes_for_file(path: &Path, rel_posix: &str) -> io::Result<[u8; 32]> {
  let mut hasher = Sha256::new();
  hasher.update(rel_posix.as_bytes());
  hasher.update([0]);
  let content = fs::read(path)?;
  hasher.update(&content);
  let digest = hasher.finalize();
  let mut out = [0u8; 32];
  out.copy_from_slice(&digest);
  Ok(out)
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

fn hash_workspace_entries(files: Vec<(PathBuf, String)>) -> io::Result<Vec<(String, DigestBytes)>> {
  const FILE_HASH_PARALLEL_THRESHOLD: usize = 64;
  let can_parallelize_files = rayon::current_thread_index().is_none();

  if can_parallelize_files && files.len() >= FILE_HASH_PARALLEL_THRESHOLD {
    return files
      .into_par_iter()
      .map(|(path, rel)| {
        let digest = sha256_bytes_for_file(&path, &rel)?;

        Ok((rel, digest))
      })
      .collect();
  }

  files
    .into_iter()
    .map(|(path, rel)| {
      let digest = sha256_bytes_for_file(&path, &rel)?;

      Ok((rel, digest))
    })
    .collect()
}

fn compute_own_hash_from_entries(entries: &[(String, DigestBytes)]) -> DigestBytes {
  let mut hasher = Sha256::new();

  for (_, digest) in entries {
    hasher.update(digest);
  }

  let digest = hasher.finalize();
  let mut out = [0; 32];
  out.copy_from_slice(&digest);

  out
}

fn compute_workspace_hash_result(
  pkg_dir: &Path,
  repo_root: &Path,
  root_ignore: Option<&Gitignore>,
  debug: bool,
) -> io::Result<(DigestBytes, Option<HashMap<String, DigestBytes>>)> {
  let local_ignore = compile_local_ignore(pkg_dir)?;
  let files = collect_workspace_files(
    pkg_dir,
    repo_root,
    pkg_dir,
    root_ignore,
    local_ignore.as_ref(),
  )?;
  let entries = hash_workspace_entries(files)?;
  let own_hash = compute_own_hash_from_entries(&entries);

  let per_file_hashes = if debug {
    let mut per_file_hashes = HashMap::with_capacity(entries.len());

    for (rel, digest) in entries {
      per_file_hashes.insert(rel, digest);
    }

    Some(per_file_hashes)
  } else {
    None
  };

  Ok((own_hash, per_file_hashes))
}

fn per_file_hashes_to_hex_map(per_file: &HashMap<String, DigestBytes>) -> BTreeMap<String, String> {
  let mut sorted = BTreeMap::new();

  for (key, value) in per_file {
    sorted.insert(key.clone(), hex_encode(value));
  }

  sorted
}

#[allow(clippy::too_many_arguments)]
fn compute_package_hashes(
  packages: &mut HashMap<String, PackageInfo>,
  to_hash: &[String],
  debug_selected: &[String],
  targeted: bool,
  repo_root: &Path,
  root_ignore: Option<&Gitignore>,
  debug: bool,
  unified: bool,
  mode: Mode,
  silent: bool,
) -> io::Result<()> {
  let root_debug_path = repo_root.join(".debug-hash");
  let mut root_debug = if debug && unified && mode == Mode::Generate && targeted {
    read_json_file::<BTreeMap<String, BTreeMap<String, String>>>(
      &root_debug_path,
      "root .debug-hash file",
    )?
    .unwrap_or_default()
  } else {
    BTreeMap::new()
  };
  let total = to_hash.len();
  let pad = if total >= 100 {
    3
  } else if total >= 10 {
    2
  } else {
    1
  };

  progressln(
    silent,
    format!("🔄 Computing hashes ({}/{})", zero_pad(0, pad), total),
  );

  let workspace_results: io::Result<Vec<HashedWorkspace>> = if total <= 1 {
    to_hash
      .iter()
      .enumerate()
      .map(|(idx, name)| {
        let pkg = packages
          .get(name)
          .ok_or_else(|| io::Error::other("Package missing metadata"))?;
        let (own_hash, per_file_hashes) =
          compute_workspace_hash_result(&pkg.dir, repo_root, root_ignore, debug)?;

        progressln(
          silent,
          format!(
            "🔄 Computing hashes ({}/{}) • {}",
            zero_pad(idx + 1, pad),
            total,
            pkg.rel_dir_posix,
          ),
        );

        Ok(HashedWorkspace {
          name: name.clone(),
          per_file_hashes,
          own_hash,
        })
      })
      .collect()
  } else {
    let completed = AtomicUsize::new(0);

    to_hash
      .par_iter()
      .map(|name| {
        let pkg = packages
          .get(name)
          .ok_or_else(|| io::Error::other("Package missing metadata"))?;
        let (own_hash, per_file_hashes) =
          compute_workspace_hash_result(&pkg.dir, repo_root, root_ignore, debug)?;

        let current = completed.fetch_add(1, Ordering::Relaxed) + 1;
        progressln(
          silent,
          format!(
            "🔄 Computing hashes ({}/{}) • {}",
            zero_pad(current, pad),
            total,
            pkg.rel_dir_posix,
          ),
        );

        Ok(HashedWorkspace {
          name: name.clone(),
          per_file_hashes,
          own_hash,
        })
      })
      .collect()
  };

  for workspace_result in workspace_results? {
    let Some(pkg) = packages.get_mut(&workspace_result.name) else {
      return Err(io::Error::other("Package missing metadata"));
    };

    pkg.per_file_hashes = workspace_result.per_file_hashes;
    pkg.own_hash = workspace_result.own_hash;
  }

  if debug && mode == Mode::Generate {
    for name in debug_selected {
      let pkg = packages
        .get(name)
        .ok_or_else(|| io::Error::other("Package missing metadata"))?;
      let per_file_hashes = pkg
        .per_file_hashes
        .as_ref()
        .ok_or_else(|| io::Error::other("Debug per-file hashes missing"))?;

      if unified {
        root_debug.insert(
          pkg.rel_dir_posix.clone(),
          per_file_hashes_to_hex_map(per_file_hashes),
        );
      } else {
        let content = serde_json::to_string_pretty(&per_file_hashes_to_hex_map(per_file_hashes))
          .unwrap_or("{}".to_string());
        fs::write(pkg.dir.join(".debug-hash"), content)?;
      }
    }
  }

  if debug && unified && mode == Mode::Generate {
    let content = serde_json::to_string_pretty(&root_debug).unwrap_or("{}".to_string());
    fs::write(root_debug_path, content)?;
  }

  progressln(silent, format!("✅ Computed all hashes ({})", total));
  outln!(silent, "");
  outln!(silent, "");

  Ok(())
}

fn compute_final_hashes<'a>(
  packages: &'a HashMap<String, PackageInfo>,
  selected: &'a [String],
) -> Result<HashMap<String, String>, CliError> {
  fn compute_one<'a>(
    name: &'a str,
    packages: &'a HashMap<String, PackageInfo>,
    cache: &mut HashMap<&'a str, DigestBytes>,
    stack: &mut Vec<&'a str>,
    visiting: &mut HashSet<&'a str>,
  ) -> Result<DigestBytes, CliError> {
    if let Some(v) = cache.get(name) {
      return Ok(*v);
    }

    if visiting.contains(name) {
      let mut cycle = String::from("Circular dependency detected : ");

      for (index, dep) in stack
        .iter()
        .copied()
        .chain(std::iter::once(name))
        .enumerate()
      {
        if index > 0 {
          cycle.push_str(" -> ");
        }
        cycle.push_str(dep);
      }

      return Err(CliError {
        code: 6,
        message: cycle,
      });
    }

    let pkg = packages.get(name).ok_or_else(|| CliError {
      code: 99,
      message: format!("Package metadata missing for {}", name),
    })?;

    visiting.insert(name);
    stack.push(name);

    let mut hasher = Sha256::new();
    hasher.update(pkg.own_hash);

    for dep in &pkg.deps {
      hasher.update(compute_one(dep.as_str(), packages, cache, stack, visiting)?);
    }

    stack.pop();
    visiting.remove(name);

    let digest = hasher.finalize();
    let mut out = [0; 32];
    out.copy_from_slice(&digest);
    cache.insert(name, out);
    Ok(out)
  }

  let mut cache = HashMap::with_capacity(selected.len());
  let mut visiting = HashSet::new();
  let mut stack = Vec::new();

  for name in selected {
    compute_one(
      name.as_str(),
      packages,
      &mut cache,
      &mut stack,
      &mut visiting,
    )?;
  }

  Ok(
    cache
      .into_iter()
      .map(|(name, digest)| (name.to_string(), hex_encode(&digest)))
      .collect(),
  )
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
    let mut root = read_json_file::<HashMap<String, String>>(&root_hash_path, "root .hash file")?
      .unwrap_or_default();

    for name in selected {
      if let (Some(pkg), Some(hash)) = (packages.get(name), final_hashes.get(name)) {
        root.insert(pkg.rel_dir_posix.clone(), hash.clone());
      }
    }
    let content =
      serde_json::to_string_pretty(&BTreeMap::from_iter(root)).unwrap_or("{}".to_string());
    fs::write(root_hash_path, content)?;

    for name in selected {
      if let (Some(pkg), Some(hash)) = (packages.get(name), final_hashes.get(name)) {
        outln!(
          silent,
          "✅ {} ({} written to .hash)",
          pkg.rel_dir_posix,
          hash
        );
      }
    }
    return Ok(());
  }

  for name in selected {
    if let (Some(pkg), Some(hash)) = (packages.get(name), final_hashes.get(name)) {
      fs::write(pkg.dir.join(".hash"), hash)?;
      outln!(
        silent,
        "✅ {} ({} written to .hash)",
        pkg.rel_dir_posix,
        hash
      );
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
  let mut old_by_name = HashMap::with_capacity(packages.len());
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

  fn transitive_deps(
    name: &str,
    packages: &HashMap<String, PackageInfo>,
    cache: &mut HashMap<String, Vec<String>>,
  ) -> Vec<String> {
    if let Some(cached) = cache.get(name) {
      return cached.clone();
    }

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

    let mut resolved = out.into_iter().collect::<Vec<_>>();
    resolved.sort();
    cache.insert(name.to_string(), resolved.clone());

    resolved
  }

  let mut transitive_cache = HashMap::with_capacity(selected.len());

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
        let old_debug =
          read_json_file::<HashMap<String, String>>(&debug_path, "workspace .debug-hash file")?;

        generate_debug(pkg, old_debug.as_ref(), silent);
      }
    }

    let mut changed_deps = transitive_deps(name, packages, &mut transitive_cache)
      .into_iter()
      .filter(|d| all_changed.contains(d))
      .filter_map(|d| packages.get(&d).map(|p| p.rel_dir_posix.clone()))
      .collect::<Vec<_>>();
    changed_deps.sort_unstable();

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

  unchanged.sort_unstable();
  changed.sort_unstable_by(|a, b| a.name.cmp(&b.name));
  missing.sort_unstable_by(|a, b| a.name.cmp(&b.name));

  if !unchanged.is_empty() {
    outln!(silent, "✅ Unchanged ({}) :", unchanged.len());
    for item in &unchanged {
      outln!(silent, "• {}", item);
    }
    outln!(silent, "");
  }

  if !changed.is_empty() {
    outln!(silent, "⚠️  Changed ({}) :", changed.len());
    for item in &changed {
      outln!(silent, "• {}", item.name);
      outln!(silent, "\told : {}", item.old_hash);
      outln!(silent, "\tnew : {}", item.new_hash);
      if !item.changed_deps.is_empty() {
        outln!(silent, "\t🚧 changed dependency(s) :");
        for dep in &item.changed_deps {
          outln!(silent, "\t\t• {}", dep);
        }
      }
    }
    outln!(silent, "");
  }

  if !missing.is_empty() {
    outln!(silent, "❓ Missing .hash files ({}) :", missing.len());
    for item in &missing {
      outln!(silent, "• {} (would be {})", item.name, item.new_hash);
    }
    outln!(silent, "");
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
    outln!(
      silent,
      "❓ <debug> {} has no .debug-hash to compare",
      pkg.rel_dir_posix
    );
    outln!(silent, "");

    return Vec::new();
  };

  let Some(per_file_hashes) = pkg.per_file_hashes.as_ref() else {
    return Vec::new();
  };

  let mut seen = HashSet::new();

  for key in old_debug.keys() {
    seen.insert(key.clone());
  }
  for key in per_file_hashes.keys() {
    seen.insert(key.clone());
  }

  let mut diverged = Vec::with_capacity(seen.len());

  for key in seen {
    let new_hex = per_file_hashes.get(&key).map(|d| hex_encode(d));
    if old_debug.get(&key) != new_hex.as_ref() {
      diverged.push(key);
    }
  }

  diverged.sort_unstable();

  if !diverged.is_empty() {
    outln!(
      silent,
      "⚠️  <debug> {} diverging files :",
      pkg.rel_dir_posix
    );
    for key in &diverged {
      outln!(silent, "  • {}", key);
    }
    outln!(silent, "");
  }

  diverged
}
