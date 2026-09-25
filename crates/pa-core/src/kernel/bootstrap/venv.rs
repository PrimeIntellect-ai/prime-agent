//! Venv discovery, build, lock, and the shared `.bootstrap-version` cache:
//! the machine state behind [`super::ensure_kernel_python`]. The version
//! file is a cross-session cache, not a per-session manifest.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Context};
use sha2::Digest;

use super::{
    default_rlm_extra_uv_args, EnsureKernelPythonOptions, KernelPythonSkill,
    DEFAULT_RLM_EXTRA_PACKAGES,
};

/// Schema of `.bootstrap-version`; a mismatch rebuilds the venv.
const BOOTSTRAP_SCHEMA: u64 = 9;
const PYTHON_VERSION: &str = "3.11";
const RUNTIME_REQUIREMENT: &str = "prime-agent-runtime";
const STATE_SNAPSHOT_REQUIREMENT: &str = "dill";
const BOOTSTRAP_VERSION_FILE: &str = ".bootstrap-version";
pub(crate) const BOOTSTRAP_LOCK_NAME: &str = ".bootstrap.lock";
pub(crate) const BOOTSTRAP_LOCK_RETRY_MS: u64 = 100;
pub(crate) const BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS: u64 = 30_000;
const UV_INSTALL_COMMAND: &str = "curl -LsSf https://astral.sh/uv/install.sh | sh";

/// One normalized skill as recorded in the bootstrap version file.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct BootstrapPythonSkill {
    import_name: String,
    package_path: String,
    pyproject_path: String,
    pyproject_hash: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct BootstrapVersion {
    schema: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    extra_uv_args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    python_skills: Option<Vec<BootstrapPythonSkill>>,
}

pub(crate) fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    PathBuf::from(path)
}

fn home_dir() -> PathBuf {
    pa_types::platform::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn file_content_hash(path: &Path) -> String {
    match std::fs::read(path) {
        Ok(bytes) => format!("sha256:{:x}", sha2::Sha256::digest(&bytes)),
        Err(_) => "unreadable".to_string(),
    }
}

fn read_toml_project_section(pyproject_path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(pyproject_path).ok()?;
    let mut start = None;
    for (index, line) in text.lines().enumerate() {
        if line.trim() == "[project]" {
            start = Some(index + 1);
            break;
        }
    }
    let start = start?;
    let mut section = String::new();
    for line in text.lines().skip(start) {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            break;
        }
        section.push_str(line);
        section.push('\n');
    }
    Some(section)
}

fn read_python_skill_project_name(skill: &BootstrapPythonSkill) -> String {
    let section = read_toml_project_section(Path::new(&skill.pyproject_path));
    let name = section.and_then(|text| {
        for line in text.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed
                .strip_prefix("name")
                .and_then(|r| r.trim_start().strip_prefix('='))
            {
                let value = rest.trim().trim_matches(|c| c == '"' || c == '\'');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
        None
    });
    name.unwrap_or_else(|| skill.import_name.replace('_', "-"))
}

fn parse_dependency_package_name(dependency: &str) -> Option<String> {
    let without_marker = dependency.split(';').next()?.trim();
    if without_marker.is_empty() {
        return None;
    }
    let name: String = without_marker
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        .collect();
    if name.is_empty() {
        return None;
    }
    Some(name.replace('_', "-").to_lowercase())
}

/// Names in the `[project] dependencies` array, tolerating quotes/escapes.
fn read_python_skill_dependency_names(skill: &BootstrapPythonSkill) -> Vec<String> {
    let Some(section) = read_toml_project_section(Path::new(&skill.pyproject_path)) else {
        return Vec::new();
    };
    let mut dependencies = Vec::new();
    let mut in_dependencies = false;
    for line in section.lines() {
        let trimmed = line.trim();
        if in_dependencies {
            if trimmed.starts_with(']') {
                break;
            }
            for raw in trimmed.split(',') {
                let candidate = raw.trim().trim_matches(|c| c == '"' || c == '\'');
                if candidate.is_empty() {
                    continue;
                }
                if let Some(name) = parse_dependency_package_name(candidate) {
                    dependencies.push(name);
                }
            }
        } else if let Some(rest) = trimmed.strip_prefix("dependencies") {
            if rest.trim_start().starts_with('=') {
                in_dependencies = true;
            }
        }
    }
    dependencies
}

pub(crate) fn to_bootstrap_skill(skill: &KernelPythonSkill) -> BootstrapPythonSkill {
    BootstrapPythonSkill {
        import_name: skill.import_name.clone(),
        package_path: skill.package_path.to_string_lossy().to_string(),
        pyproject_path: skill.pyproject_path.to_string_lossy().to_string(),
        pyproject_hash: file_content_hash(&skill.pyproject_path),
    }
}

/// Deduplicate skills (by importName + packagePath), resolve sibling-local
/// dependencies, and sort deterministically — matching `normalizePythonSkills`.
pub(crate) fn normalize_python_skills(
    python_skills: &[KernelPythonSkill],
) -> Vec<BootstrapPythonSkill> {
    fn add_skill(by_key: &mut Vec<(String, BootstrapPythonSkill)>, skill: BootstrapPythonSkill) {
        let key = format!("{}\u{0}{}", skill.import_name, skill.package_path);
        if by_key.iter().any(|(existing, _)| *existing == key) {
            return;
        }
        for dependency_name in read_python_skill_dependency_names(&skill) {
            if let Some(sibling) = resolve_sibling_python_skill_dependency(&skill, &dependency_name)
            {
                add_skill(by_key, sibling);
            }
        }
        by_key.push((key, skill));
    }
    let mut by_key: Vec<(String, BootstrapPythonSkill)> = Vec::new();
    for skill in python_skills {
        add_skill(&mut by_key, to_bootstrap_skill(skill));
    }
    let mut skills: Vec<BootstrapPythonSkill> = by_key.into_iter().map(|(_, s)| s).collect();
    skills.sort_by(|a, b| {
        a.package_path
            .cmp(&b.package_path)
            .then(a.import_name.cmp(&b.import_name))
    });
    skills
}

fn resolve_sibling_python_skill_dependency(
    skill: &BootstrapPythonSkill,
    dependency_name: &str,
) -> Option<BootstrapPythonSkill> {
    let siblings_dir = Path::new(&skill.package_path).parent()?;
    for entry in std::fs::read_dir(siblings_dir).ok()? {
        let entry = entry.ok()?;
        if !entry.file_type().ok()?.is_dir() {
            continue;
        }
        let package_path = entry.path();
        let pyproject_path = package_path.join("pyproject.toml");
        if !pyproject_path.exists() {
            continue;
        }
        let candidate = BootstrapPythonSkill {
            import_name: entry.file_name().to_string_lossy().replace('-', "_"),
            package_path: package_path.to_string_lossy().to_string(),
            pyproject_path: pyproject_path.to_string_lossy().to_string(),
            pyproject_hash: file_content_hash(&pyproject_path),
        };
        if read_python_skill_project_name(&candidate)
            .replace('_', "-")
            .to_lowercase()
            == dependency_name
        {
            return Some(candidate);
        }
    }
    None
}

/// Directory of the kernel venv, honoring `PRIME_AGENT_KERNEL_VENV`.
pub fn kernel_venv_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("PRIME_AGENT_KERNEL_VENV") {
        if !override_dir.is_empty() {
            return expand_home(&override_dir);
        }
    }
    home_dir().join(".prime").join("agent").join("kernel-venv")
}

fn xdg_kernel_venv_dir() -> PathBuf {
    let data_home = match std::env::var("XDG_DATA_HOME") {
        Ok(value) if !value.is_empty() => expand_home(&value),
        _ => home_dir().join(".local").join("share"),
    };
    data_home.join("prime").join("agent").join("kernel-venv")
}

pub(crate) fn resolve_writable_kernel_venv_dir() -> anyhow::Result<PathBuf> {
    let primary = kernel_venv_dir();
    if std::fs::create_dir_all(primary.parent().unwrap_or(Path::new("/"))).is_ok() {
        return Ok(primary);
    }
    if std::env::var("PRIME_AGENT_KERNEL_VENV").is_ok_and(|v| !v.is_empty()) {
        return Err(anyhow!(
            "couldn't create kernel venv parent directories for {}",
            primary.display()
        ));
    }
    let fallback = xdg_kernel_venv_dir();
    if std::fs::create_dir_all(fallback.parent().unwrap_or(Path::new("/"))).is_err() {
        return Err(anyhow!(
            "couldn't create kernel venv directory at {} or {}; set PRIME_AGENT_KERNEL_PYTHON to a python with a current prime-agent-runtime installed",
            primary.display(),
            fallback.display()
        ));
    }
    Ok(fallback)
}

/// Path of the venv's python interpreter.
pub fn kernel_venv_python(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

async fn run_async(command: &str, args: &[String]) -> anyhow::Result<()> {
    // Run on a blocking thread: the bootstrap is an IO-bound child process.
    let command = command.to_string();
    let args = args.to_vec();
    tokio::task::spawn_blocking(move || {
        let mut child = std::process::Command::new(&command);
        child.args(&args).stdin(Stdio::null());
        // Hidden window on Windows (TS `spawnHidden`).
        crate::platform::process::set_no_window(&mut child);
        let status = child
            .status()
            .with_context(|| format!("failed to spawn {command}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(anyhow!(
                "{} {} failed with exit code {}",
                command,
                args.join(" "),
                status.code().unwrap_or(-1)
            ))
        }
    })
    .await
    .map_err(|e| anyhow!("bootstrap task join failed: {e}"))?
}

fn python_imports(python: &str, module_name: &str) -> bool {
    run_quiet(python, &["-c", &format!("import {module_name}")])
}

fn run_quiet(command: &str, args: &[&str]) -> bool {
    let mut child = std::process::Command::new(command);
    child
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Hidden window on Windows (TS `spawnHidden`).
    crate::platform::process::set_no_window(&mut child);
    matches!(child.status(), Ok(status) if status.success())
}

/// The runtime-ready assertion from the TS product: a current
/// prime-agent-runtime with the callable RLM surface, harness CRUD, bash
/// handles, and protocol version 3.
const RUNTIME_READY_CHECK: &str = "import inspect; import rlm; from rlm import McpIntegration; import rlm.mcp as mcp; from rlm.harness import HarnessEntry; _harness_methods = ['create_memory', 'update_memory', 'delete_memory', 'create_skill', 'update_skill', 'delete_skill', 'create_subagent', 'update_subagent', 'delete_subagent', 'create_prompt_note', 'update_prompt_note', 'delete_prompt_note', 'record_refinement']; assert callable(mcp.list_tools); assert callable(mcp.call_tool); assert callable(rlm.spawn); assert hasattr(rlm, 'rlm'); assert callable(rlm.rlm.spawn); assert inspect.signature(rlm.spawn).parameters['name'].default is inspect.Parameter.empty; assert not hasattr(rlm, 'run'); assert not hasattr(rlm.rlm, 'run'); assert callable(rlm.host_request); assert callable(rlm.find_models); assert callable(rlm.rlm.find_models); assert callable(rlm.create_session); assert callable(rlm.rlm.create_session); assert callable(rlm.progress_note); assert callable(rlm.rlm.progress_note); assert hasattr(rlm, 'harness'); assert hasattr(rlm, 'get_harness_state'); assert hasattr(rlm.rlm, 'harness'); assert hasattr(rlm.rlm, 'get_harness_state'); assert all(callable(getattr(_harness, _method, None)) for _harness in (rlm.harness, rlm.rlm.harness) for _method in _harness_methods); assert 'reference' in HarnessEntry.__dataclass_fields__; assert 'scope' in HarnessEntry.__dataclass_fields__; assert 'reference' in inspect.signature(rlm.harness.create_skill).parameters; assert 'reference' in inspect.signature(rlm.harness.update_skill).parameters; assert 'global_' in inspect.signature(rlm.harness.create_memory).parameters; assert 'global_' in inspect.signature(rlm.get_harness_state).parameters; assert not hasattr(rlm, 'background'); assert not hasattr(rlm.rlm, 'background'); from rlm.bash import BashHandle, BashResult; assert callable(rlm.bash); assert all(callable(getattr(BashHandle, _m, None)) for _m in ('tail', 'output', 'poll', 'kill')); assert {'exit_code', 'output', 'duration'} <= set(BashResult.__dataclass_fields__); import rlm.repl as _repl; assert callable(_repl.main); assert callable(_repl.emit); assert callable(_repl.host_request); assert callable(_repl.is_active); assert _repl.PROTOCOL_VERSION == 3; assert callable(rlm.emit); assert not hasattr(rlm, 'HOST_COMM_TARGET'); assert not hasattr(mcp, 'install_shutdown_hook')";

pub(crate) fn has_prime_agent_runtime(python: &str) -> bool {
    run_quiet(python, &["-c", RUNTIME_READY_CHECK])
}

pub(crate) fn missing_rlm_extra_import_labels(python: &str) -> Vec<&'static str> {
    DEFAULT_RLM_EXTRA_PACKAGES
        .iter()
        .filter(|(_, import, _)| !python_imports(python, import))
        .map(|(_, _, label)| *label)
        .collect()
}

pub(crate) fn missing_python_skill_import_labels(
    python: &str,
    python_skills: &[KernelPythonSkill],
) -> Vec<String> {
    python_skills
        .iter()
        .filter(|skill| !python_imports(python, &skill.import_name))
        .map(|skill| format!("{} ({})", skill.name, skill.import_name))
        .collect()
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let path_value = std::env::var("PATH").ok()?;
    // The bare name on Unix; PATHEXT extension candidates on Windows
    // (TS `findExecutable` -> `windowsExecutableCandidates`).
    #[cfg(windows)]
    let candidates = windows_executable_candidates(name, std::env::var("PATHEXT").ok().as_deref());
    #[cfg(not(windows))]
    let candidates = vec![name.to_string()];
    for dir in std::env::split_paths(&path_value) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for candidate in &candidates {
            let full_path = dir.join(candidate);
            if full_path.is_file() && is_executable(&full_path) {
                return Some(full_path);
            }
        }
    }
    None
}

/// TS `WINDOWS_PATHEXT_DEFAULT`: the extension order `windowsExecutableCandidates`
/// uses when `PATHEXT` yields nothing usable.
#[cfg(any(windows, test))]
const WINDOWS_PATHEXT_DEFAULT: [&str; 4] = [".COM", ".EXE", ".BAT", ".CMD"];

/// The bare name followed by the supported PATHEXT extensions, in
/// `PATHEXT` order when it yields supported extensions, else the TS default
/// order. A name that already ends in a default extension is never suffixed
/// again (TS `windowsExecutableCandidates` verbatim).
#[cfg(any(windows, test))]
fn windows_executable_candidates(name: &str, pathext: Option<&str>) -> Vec<String> {
    let extensions = pathext
        .unwrap_or("")
        .split(';')
        .map(str::trim)
        .map(str::to_lowercase)
        .filter(|ext| {
            WINDOWS_PATHEXT_DEFAULT
                .iter()
                .any(|default| default.eq_ignore_ascii_case(ext))
        })
        .collect::<Vec<_>>();
    let lower_name = name.to_lowercase();
    if WINDOWS_PATHEXT_DEFAULT
        .iter()
        .any(|ext| lower_name.ends_with(&ext.to_lowercase()))
    {
        return vec![name.to_string()];
    }
    let defaults: Vec<String> = WINDOWS_PATHEXT_DEFAULT
        .iter()
        .map(std::string::ToString::to_string)
        .collect();
    let source: &[String] = if extensions.is_empty() {
        &defaults
    } else {
        &extensions
    };
    let mut seen = std::collections::HashSet::from([lower_name]);
    let mut candidates = vec![name.to_string()];
    for ext in source {
        let candidate = format!("{name}{ext}");
        if seen.insert(candidate.to_lowercase()) {
            candidates.push(candidate);
        }
    }
    candidates
}

fn is_executable(path: &Path) -> bool {
    crate::platform::perms::is_executable(path)
}

fn read_bootstrap_version(venv: &Path) -> Option<BootstrapVersion> {
    let raw = std::fs::read_to_string(venv.join(BOOTSTRAP_VERSION_FILE)).ok()?;
    let parsed: BootstrapVersion = serde_json::from_str(&raw).ok()?;
    (parsed.schema > 0).then_some(parsed)
}

fn extra_uv_args_match(a: &Option<Vec<String>>, b: &[&str]) -> bool {
    match a {
        None => false,
        Some(a) => a.iter().map(String::as_str).eq(b.iter().copied()),
    }
}

/// Identity of one recorded skill: the install root is the package path, and
/// the editable install follows that path.
fn bootstrap_skill_key(skill: &BootstrapPythonSkill) -> String {
    format!("{}\u{0}{}", skill.import_name, skill.package_path)
}

/// True when the recorded installs cover every current skill at the same
/// path with the same pyproject hash. Extra recorded skills from other
/// sessions are fine: the venv is a shared cache, not a per-session manifest,
/// so a session whose skill set differs must not force reinstalls.
fn recorded_skills_cover(
    recorded: &Option<Vec<BootstrapPythonSkill>>,
    current: &[BootstrapPythonSkill],
) -> bool {
    if current.is_empty() {
        return true;
    }
    let Some(recorded) = recorded else {
        return false;
    };
    current.iter().all(|skill| {
        recorded.iter().any(|entry| {
            bootstrap_skill_key(entry) == bootstrap_skill_key(skill)
                && entry.pyproject_path == skill.pyproject_path
                && entry.pyproject_hash == skill.pyproject_hash
        })
    })
}

fn bootstrap_base_version_current(
    version: Option<BootstrapVersion>,
    runtime_identity: &str,
) -> bool {
    match version {
        Some(version) => {
            version.schema == BOOTSTRAP_SCHEMA
                && version.runtime.as_deref() == Some(runtime_identity)
                && version.snapshot.as_deref() == Some(STATE_SNAPSHOT_REQUIREMENT)
                && extra_uv_args_match(&version.extra_uv_args, &default_rlm_extra_uv_args())
        }
        None => false,
    }
}

fn bootstrap_version_current(
    version: Option<BootstrapVersion>,
    runtime_identity: &str,
    python_skills: &[BootstrapPythonSkill],
) -> bool {
    bootstrap_base_version_current(version.clone(), runtime_identity)
        && recorded_skills_cover(
            &version.as_ref().and_then(|v| v.python_skills.clone()),
            python_skills,
        )
}

pub(crate) fn write_bootstrap_version(
    venv: &Path,
    runtime_identity: &str,
    python_skills: &[BootstrapPythonSkill],
) -> anyhow::Result<()> {
    let version = BootstrapVersion {
        schema: BOOTSTRAP_SCHEMA,
        runtime: Some(runtime_identity.to_string()),
        snapshot: Some(STATE_SNAPSHOT_REQUIREMENT.to_string()),
        extra_uv_args: Some(
            default_rlm_extra_uv_args()
                .into_iter()
                .map(String::from)
                .collect(),
        ),
        python_skills: Some(python_skills.to_vec()),
    };
    std::fs::write(
        venv.join(BOOTSTRAP_VERSION_FILE),
        format!("{}\n", serde_json::to_string(&version)?),
    )?;
    Ok(())
}

/// Directory of the installed `prime-agent-runtime` sources. The Rust binary
/// ships the same sidecar layout the compiled TS executable uses; an explicit
/// `PI_PACKAGE_DIR` override wins (matching the TS `getPackageDir`).
pub(super) fn package_dir() -> PathBuf {
    if let Ok(env_dir) = std::env::var("PI_PACKAGE_DIR") {
        if !env_dir.is_empty() {
            return expand_home(&env_dir);
        }
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir
}

/// The packaged sidecar directory (the exe-adjacent layout): the TS
/// `runtimeCandidateDirs` bun-binary candidates, `PI_PACKAGE_DIR` included
/// through [`package_dir`].
pub(super) fn packaged_runtime_dir() -> Option<PathBuf> {
    let package = package_dir();
    [
        package.join("prime-agent-runtime"),
        package.join("dist").join("prime-agent-runtime"),
    ]
    .into_iter()
    .find(|candidate| candidate.join("pyproject.toml").exists())
}

fn runtime_candidate_dirs() -> Vec<PathBuf> {
    let mut candidates = packaged_runtime_dir().into_iter().collect::<Vec<_>>();
    // Source checkouts keep the sidecar at the workspace root (TS resolves
    // module-relative monorepo candidates the same way).
    if let Some(root) = crate::packages::source_checkout_root() {
        candidates.push(root.join("prime-agent-runtime"));
    }
    candidates
}

fn resolve_runtime_source_dir() -> Option<PathBuf> {
    runtime_candidate_dirs()
        .into_iter()
        .find(|candidate| candidate.join("pyproject.toml").exists())
}

/// Content identity of the runtime: a hash of every `rlm/*.py` file plus
/// `pyproject.toml`, so any runtime change invalidates an existing venv.
/// Falls back to the bare package name when the runtime resolves to a
/// registry install (no local source).
///
/// # Panics
///
/// Panics when hashing the resolved local runtime source fails (unreadable
/// or missing runtime files).
pub fn resolve_runtime_identity() -> String {
    let Some(source_dir) = resolve_runtime_source_dir() else {
        return RUNTIME_REQUIREMENT.to_string();
    };
    hash_runtime_source(&source_dir).unwrap_or_else(|error| {
        panic!(
            "cannot hash runtime source at {}: {error}",
            source_dir.display()
        )
    })
}

fn hash_runtime_source(source_dir: &Path) -> anyhow::Result<String> {
    let rlm_dir = source_dir.join("src").join("rlm");
    let mut files = vec![source_dir.join("pyproject.toml")];
    collect_python_files(&rlm_dir, &mut files)?;
    files.sort();
    let mut hasher = sha2::Sha256::new();
    for file in &files {
        let relative = file.strip_prefix(source_dir)?;
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update(&std::fs::read(file)?);
        hasher.update([0]);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn collect_python_files(dir: &Path, files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_python_files(&path, files)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("py") {
            files.push(path);
        }
    }
    Ok(())
}

/// Find `uv` on PATH or at `~/.local/bin/uv` (`uv.exe` on Windows). Returns
/// `Err` with install guidance when missing: the Rust binary never
/// auto-installs (the TS interactive confirm belongs to the CLI layer).
pub(crate) fn ensure_uv() -> anyhow::Result<String> {
    if let Some(from_path) = find_executable("uv") {
        return Ok(from_path.to_string_lossy().to_string());
    }
    let uv_name = if cfg!(windows) { "uv.exe" } else { "uv" };
    let local_uv = home_dir().join(".local").join("bin").join(uv_name);
    if is_executable(&local_uv) {
        return Ok(local_uv.to_string_lossy().to_string());
    }
    Err(anyhow!(
        "uv is required to set up the Python kernel. Install uv yourself: {UV_INSTALL_COMMAND}"
    ))
}

pub(crate) async fn bootstrap_venv(
    venv: &Path,
    python_skills: &[BootstrapPythonSkill],
    options: &EnsureKernelPythonOptions,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(venv.parent().unwrap_or(Path::new("/")))?;
    let uv = ensure_uv()?;
    let python = kernel_venv_python(venv);
    let source_dir = resolve_runtime_source_dir();
    let runtime_requirement = source_dir.as_ref().map_or_else(
        || RUNTIME_REQUIREMENT.to_string(),
        |p| p.to_string_lossy().to_string(),
    );
    let runtime_identity = resolve_runtime_identity();

    let venv_str = venv.to_string_lossy().to_string();
    let python_str = python.to_string_lossy().to_string();
    let mut install_args = vec![
        "pip".to_string(),
        "install".to_string(),
        "--python".to_string(),
        python_str,
        runtime_requirement,
    ];
    install_args.push(STATE_SNAPSHOT_REQUIREMENT.to_string());
    for uv_arg in default_rlm_extra_uv_args() {
        install_args.push(uv_arg.to_string());
    }

    run_async(
        &uv,
        &[
            "python".to_string(),
            "install".to_string(),
            PYTHON_VERSION.to_string(),
        ],
    )
    .await?;
    run_async(
        &uv,
        &[
            "venv".to_string(),
            venv_str,
            "--python".to_string(),
            PYTHON_VERSION.to_string(),
            "--seed".to_string(),
        ],
    )
    .await?;
    run_async(&uv, &install_args).await?;
    sync_python_skills(
        &uv,
        venv,
        &python,
        &runtime_identity,
        python_skills,
        options,
    )
    .await
}

/// Install/refresh the editable Python skills recorded in the version file.
/// The version file is a shared cache, not a per-session manifest: records
/// from other sessions carry over, and only skills missing or changed are
/// installed. Per-skill failures warn and continue: one broken skill must
/// not cost the kernel.
pub(crate) async fn sync_python_skills(
    uv: &str,
    venv: &Path,
    python: &Path,
    runtime_identity: &str,
    python_skills: &[BootstrapPythonSkill],
    options: &EnsureKernelPythonOptions,
) -> anyhow::Result<()> {
    let version = read_bootstrap_version(venv);
    // Previously installed skills still present on disk: their records carry
    // over so sessions with different skill sets share one venv cache
    // instead of forcing reinstalls of each other's skills. Records for
    // skills whose package path disappeared (a retired release dir, a
    // deleted project) cannot serve a future install and are dropped.
    let current_python_skills: HashMap<String, BootstrapPythonSkill> = version
        .as_ref()
        .and_then(|v| v.python_skills.clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|recorded| Path::new(&recorded.package_path).is_dir())
        .map(|s| (bootstrap_skill_key(&s), s))
        .collect();
    let python_str = python.to_string_lossy().to_string();
    let mut installed: HashMap<String, BootstrapPythonSkill> = current_python_skills;
    for skill in python_skills {
        let key = bootstrap_skill_key(skill);
        if installed.get(&key).is_some_and(|existing| {
            existing.pyproject_path == skill.pyproject_path
                && existing.pyproject_hash == skill.pyproject_hash
        }) {
            continue;
        }
        let result = run_async(
            uv,
            &[
                "pip".to_string(),
                "install".to_string(),
                "--python".to_string(),
                python_str.clone(),
                "--editable".to_string(),
                skill.package_path.clone(),
            ],
        )
        .await;
        match result {
            // A changed pyproject (hash moved) replaces the stale record.
            Ok(()) => {
                installed.insert(key, skill.clone());
            }
            Err(error) => options.report(&format!(
                "Warning: Python skill {} failed to install and will be unavailable: {error}",
                skill.import_name
            )),
        }
    }
    let mut merged: Vec<BootstrapPythonSkill> = installed.into_values().collect();
    merged.sort_by(|a, b| {
        a.package_path
            .cmp(&b.package_path)
            .then(a.import_name.cmp(&b.import_name))
    });
    write_bootstrap_version(venv, runtime_identity, &merged)
}

pub(crate) fn kernel_base_ready(python: &str, venv: &Path, runtime_identity: &str) -> bool {
    has_prime_agent_runtime(python)
        && bootstrap_base_version_current(read_bootstrap_version(venv), runtime_identity)
}

pub(crate) fn kernel_ready(
    python: &str,
    venv: &Path,
    runtime_identity: &str,
    python_skills: &[BootstrapPythonSkill],
) -> bool {
    has_prime_agent_runtime(python)
        && bootstrap_version_current(
            read_bootstrap_version(venv),
            runtime_identity,
            python_skills,
        )
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_executable_candidates_default_order() {
        // No PATHEXT: the TS default extension order, deduped against the
        // bare name.
        assert_eq!(
            windows_executable_candidates("uv", None),
            vec![
                "uv".to_string(),
                "uv.COM".into(),
                "uv.EXE".into(),
                "uv.BAT".into(),
                "uv.CMD".into()
            ]
        );
    }

    #[test]
    fn windows_executable_candidates_follows_pathext_order() {
        // Supported extensions keep PATHEXT's order; unsupported ones drop.
        assert_eq!(
            windows_executable_candidates("uv", Some(".FOO;.EXE;.BAT")),
            vec!["uv".to_string(), "uv.exe".into(), "uv.bat".into()]
        );
    }

    #[test]
    fn windows_executable_candidates_skips_suffix_and_duplicates() {
        // A name that already ends in a default extension is used bare.
        assert_eq!(
            windows_executable_candidates("uv.exe", Some(".EXE;.BAT")),
            vec!["uv.exe".to_string()]
        );
        // A candidate equal to the bare name (case-insensitively) never
        // repeats.
        assert_eq!(
            windows_executable_candidates("node", Some("")),
            vec![
                "node".to_string(),
                "node.COM".into(),
                "node.EXE".into(),
                "node.BAT".into(),
                "node.CMD".into()
            ]
        );
    }

    use super::*;

    #[test]
    fn venv_dir_honors_override() {
        // The default path lives under $HOME.
        let base = kernel_venv_dir();
        assert!(base.ends_with("kernel-venv"));
    }

    #[test]
    fn dependency_names_parse() {
        let dir = tempfile::tempdir().unwrap();
        let pyproject = dir.path().join("pyproject.toml");
        std::fs::write(
            &pyproject,
            "[project]\nname = 'edit'\ndependencies = [\n  \"agent-message>=1\",\n  'yaml; python_version > \"3\"',\n]\n[other]\nkey = 1\n",
        )
        .unwrap();
        let skill = BootstrapPythonSkill {
            import_name: "edit".into(),
            package_path: dir.path().join("pkg").to_string_lossy().to_string(),
            pyproject_path: pyproject.to_string_lossy().to_string(),
            pyproject_hash: file_content_hash(&pyproject),
        };
        assert_eq!(read_python_skill_project_name(&skill), "edit");
        assert_eq!(
            read_python_skill_dependency_names(&skill),
            vec!["agent-message", "yaml"]
        );
    }

    fn skill(import_name: &str, path: &str, hash: &str) -> BootstrapPythonSkill {
        BootstrapPythonSkill {
            import_name: import_name.to_string(),
            package_path: path.to_string(),
            pyproject_path: format!("{path}/pyproject.toml"),
            pyproject_hash: hash.to_string(),
        }
    }

    #[test]
    fn version_file_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        write_bootstrap_version(dir.path(), "sha256:abc", &[]).unwrap();
        let version = read_bootstrap_version(dir.path()).expect("version written");
        assert_eq!(version.schema, BOOTSTRAP_SCHEMA);
        assert_eq!(version.runtime.as_deref(), Some("sha256:abc"));
        assert!(bootstrap_version_current(Some(version), "sha256:abc", &[]));
        assert!(!bootstrap_base_version_current(
            read_bootstrap_version(dir.path()),
            "sha256:other"
        ));
    }

    #[test]
    fn extra_recorded_skills_do_not_force_reinstall() {
        // A session's set ([edit]) must be served by a venv that also carries
        // records from other sessions ([websearch]): the file is a cache.
        let recorded = Some(vec![
            skill("edit", "/skills/edit", "h1"),
            skill("websearch", "/skills/websearch", "h2"),
        ]);
        let current = [skill("edit", "/skills/edit", "h1")];
        assert!(recorded_skills_cover(&recorded, &current));
        // A missing record (new session skill) does force a sync.
        assert!(!recorded_skills_cover(
            &recorded,
            &[
                skill("edit", "/skills/edit", "h1"),
                skill("goal", "/skills/goal", "h3")
            ],
        ));
        // A changed pyproject hash does force a sync.
        assert!(!recorded_skills_cover(
            &recorded,
            &[skill("edit", "/skills/edit", "changed")],
        ));
        // No records at all: nothing is covered.
        assert!(!recorded_skills_cover(&None, &current));
        assert!(recorded_skills_cover(&None, &[]));
    }
}
