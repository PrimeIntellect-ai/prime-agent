//! The runtime-ready probe concern (moved with its concern): the quiet
//! interpreter checks, the runtime/extra/skill import labels, and the
//! two-layer memo (in-process map + the cross-process on-disk verdict)
//! that skips re-probing a venv nobody damaged.

use super::{
    collect_python_files, Digest, HashMap, KernelPythonSkill, Mutex, Path, PathBuf, Stdio,
    DEFAULT_RLM_EXTRA_PACKAGES,
};

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
const RUNTIME_READY_CHECK: &str = "import inspect; import rlm; from rlm import McpIntegration; import rlm.mcp as mcp; from rlm.harness import HarnessEntry; _harness_methods = ['create_memory', 'update_memory', 'delete_memory', 'create_skill', 'update_skill', 'delete_skill', 'create_subagent', 'update_subagent', 'delete_subagent', 'create_prompt_note', 'update_prompt_note', 'delete_prompt_note', 'record_refinement']; _mcp_discovery_methods = ['list_plugins', 'search_plugins', 'list_connections', 'search_tools', 'describe_tool']; assert callable(mcp.list_tools); assert callable(mcp.call_tool); assert all(callable(getattr(mcp, _m, None)) for _m in _mcp_discovery_methods), \"rlm.mcp is missing MCP discovery methods (list_plugins, search_plugins, list_connections, search_tools, describe_tool); the kernel venv needs a current prime-agent-runtime\"; assert callable(rlm.spawn); assert hasattr(rlm, 'rlm'); assert callable(rlm.rlm.spawn); assert inspect.signature(rlm.spawn).parameters['name'].default is inspect.Parameter.empty; assert not hasattr(rlm, 'run'); assert not hasattr(rlm.rlm, 'run'); assert callable(rlm.host_request); assert callable(rlm.find_models); assert callable(rlm.rlm.find_models); assert callable(rlm.create_session); assert callable(rlm.rlm.create_session); assert callable(rlm.progress_note); assert callable(rlm.rlm.progress_note); assert hasattr(rlm, 'harness'); assert hasattr(rlm, 'get_harness_state'); assert hasattr(rlm.rlm, 'harness'); assert hasattr(rlm.rlm, 'get_harness_state'); assert all(callable(getattr(_harness, _method, None)) for _harness in (rlm.harness, rlm.rlm.harness) for _method in _harness_methods); assert 'reference' in HarnessEntry.__dataclass_fields__; assert 'scope' in HarnessEntry.__dataclass_fields__; assert 'reference' in inspect.signature(rlm.harness.create_skill).parameters; assert 'reference' in inspect.signature(rlm.harness.update_skill).parameters; assert 'global_' in inspect.signature(rlm.harness.create_memory).parameters; assert 'global_' in inspect.signature(rlm.get_harness_state).parameters; assert not hasattr(rlm, 'background'); assert not hasattr(rlm.rlm, 'background'); from rlm.bash import BashHandle, BashResult; assert callable(rlm.bash); assert all(callable(getattr(BashHandle, _m, None)) for _m in ('tail', 'output', 'poll', 'kill')); assert {'exit_code', 'output', 'duration'} <= set(BashResult.__dataclass_fields__); import rlm.repl as _repl; assert callable(_repl.main); assert callable(_repl.emit); assert callable(_repl.host_request); assert callable(_repl.is_active); assert _repl.PROTOCOL_VERSION == 3; assert callable(rlm.emit); assert not hasattr(rlm, 'HOST_COMM_TARGET'); assert not hasattr(mcp, 'install_shutdown_hook')";

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

/// Process-global memo of a successful runtime-ready probe, tiered above
/// the cross-process on-disk memo ([`super::super::disk_memo`]): the probe is a
/// full interpreter start (the `import rlm` chain), and re-running it
/// before every kernel start re-pays a cost the kernel spawn itself is
/// about to pay. Memoized on success only: the key carries every input the
/// probe observes (interpreter identity, runtime identity, the venv's
/// recorded bootstrap state, and the installed runtime's content), so a
/// venv rebuilt by anyone — a newer concurrent daemon rewrites
/// `.bootstrap-version` — or damaged out of band — an uninstalled or
/// overwritten `rlm`, a replaced interpreter — misses both layers and
/// revalidates. A failed kernel start drops both layers
/// ([`invalidate_runtime_probe_cache`]), so the startup retry re-probes
/// and rebuilds exactly like the uncached flow. The in-process map dies
/// with the process; the disk layer carries the verdict to the next fresh
/// worker (every cold open and spawned child boots one) under the same
/// key, so only the interpreter probes are skipped on a hit — the key
/// recomputation above (the content walk) is the damage detector, and it
/// runs on every check.
static RUNTIME_PROBE_MEMO: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

pub(super) fn lock_probe_memo() -> std::sync::MutexGuard<'static, Option<HashMap<String, PathBuf>>>
{
    RUNTIME_PROBE_MEMO
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Identity of the runtime as installed in the venv — the state the probe
/// observes beyond its key inputs: the interpreter binary's stat plus a
/// content hash of the installed `rlm` package tree under the venv's
/// site-packages. Out-of-band damage (a package uninstall or overwrite, a
/// replaced or deleted interpreter) changes this identity, so a memoized
/// probe result can never mask a mutated install: the next
/// [`kernel_ready`] re-probes and rebuilds like the uncached flow.
pub(super) fn installed_runtime_identity(python: &Path, venv: &Path) -> String {
    let mut hasher = sha2::Sha256::new();
    match std::fs::metadata(python) {
        Ok(meta) => {
            let modified = meta
                .modified()
                .map_or_else(|_| "no-mtime".to_string(), |time| format!("{time:?}"));
            hasher.update(format!("py:{}:{}:{modified}", python.display(), meta.len()).as_bytes());
        }
        Err(error) => hasher.update(format!("py-error:{}:{error}", python.display()).as_bytes()),
    }
    for package in ["rlm", "dill"] {
        match installed_package_dir(venv, package) {
            Some(dir) => match hash_python_tree(&dir) {
                Ok(hash) => hasher.update(format!("{package}:{hash}").as_bytes()),
                Err(error) => hasher.update(format!("{package}-error:{error}").as_bytes()),
            },
            None => hasher.update(format!("{package}-missing").as_bytes()),
        }
    }
    format!("sha256:{:x}", hasher.finalize())
}

/// The installed `rlm` package under the venv's site-packages: the
/// Windows layout `<venv>/Lib/site-packages/rlm` (no python-version
/// layer) or the Unix layout `<venv>/lib/python*/site-packages/rlm`.
#[cfg(test)]
pub(super) fn installed_rlm_dir(venv: &Path) -> Option<PathBuf> {
    installed_package_dir(venv, "rlm")
}

pub(super) fn installed_package_dir(venv: &Path, package: &str) -> Option<PathBuf> {
    let lib = venv.join("lib");
    let windows_layout = lib.join("site-packages").join(package);
    if windows_layout.is_dir() {
        return Some(windows_layout);
    }
    let entries = std::fs::read_dir(&lib).ok()?;
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        if !entry.file_name().to_string_lossy().starts_with("python") {
            continue;
        }
        let installed = entry.path().join("site-packages").join(package);
        if installed.is_dir() {
            return Some(installed);
        }
    }
    None
}

/// Content hash of a python tree: every `.py` file's relative path and
/// bytes, in sorted order (same witness shape as `hash_runtime_source`).
fn hash_python_tree(dir: &Path) -> anyhow::Result<String> {
    let mut files = Vec::new();
    collect_python_files(dir, &mut files)?;
    files.sort();
    let mut hasher = sha2::Sha256::new();
    for file in &files {
        let relative = file.strip_prefix(dir)?;
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update(&std::fs::read(file)?);
        hasher.update([0]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// The memo key: every input the runtime-ready probe observes.
pub(super) fn runtime_probe_key(
    python: &str,
    runtime_identity: &str,
    version_raw: &str,
    installed_identity: &str,
) -> String {
    format!(
        "{python}\u{0}{runtime_identity}\u{0}{installed_identity}\u{0}sha256:{:x}",
        sha2::Sha256::digest(version_raw.as_bytes())
    )
}

/// The runtime-ready check, memoized on success across two layers: the
/// process-global map first, then the on-disk cross-process memo (a fresh
/// process — every cold open's worker, every spawned child — starts with
/// an empty map, so the disk layer is what carries the verdict across
/// process boundaries). `version_raw` is the raw `.bootstrap-version` text
/// the caller already read; `installed_identity` is the installed-runtime
/// identity from [`installed_runtime_identity`]. The key is recomputed
/// fresh on every call — the content walk inside the identity is the
/// damage detector — so a hit skips only the two interpreter probes.
/// Managed-venv path only: a caller-owned `PRIME_AGENT_KERNEL_PYTHON`
/// override never reaches this (it uses the direct probe, the d14
/// ruling), and no memo file is read or written for it.
pub(super) fn has_prime_agent_runtime_memoized(
    python: &str,
    runtime_identity: &str,
    version_raw: &str,
    installed_identity: &str,
    venv: &Path,
) -> bool {
    let key = runtime_probe_key(python, runtime_identity, version_raw, installed_identity);
    let memo_path = super::super::disk_memo::disk_memo_path(venv);
    if lock_probe_memo()
        .as_ref()
        .is_some_and(|memo| memo.contains_key(&key))
    {
        return true;
    }
    if super::super::disk_memo::disk_memo_hit(&memo_path, &key) {
        let mut memo = lock_probe_memo();
        let entries = memo.get_or_insert_with(HashMap::new);
        if entries.len() >= 16 {
            entries.clear();
        }
        entries.insert(key, memo_path);
        return true;
    }
    if !has_prime_agent_runtime(python) || !python_imports(python, "dill") {
        return false;
    }
    let mut memo = lock_probe_memo();
    let entries = memo.get_or_insert_with(HashMap::new);
    if entries.len() >= 16 {
        entries.clear();
    }
    super::super::disk_memo::disk_memo_write(&memo_path, &key);
    entries.insert(key, memo_path);
    true
}

/// Drop every memoized runtime-ready result, both layers: the in-process
/// map dies with this call, and every disk memo this process touched is
/// dropped (deleted, or atomically overwritten with the empty map when
/// the delete fails). The next kernel start re-runs the probe (and
/// rebuilds the venv when the probe finds it broken).
pub fn invalidate_runtime_probe_cache() {
    let tracked: Vec<PathBuf> = lock_probe_memo()
        .take()
        .map(|memo| memo.values().cloned().collect())
        .unwrap_or_default();
    for path in tracked {
        super::super::disk_memo::disk_memo_invalidate(&path);
    }
}

/// Drop only the in-process memo layer, leaving the on-disk layer intact:
/// the fresh-process simulation the disk-memo oracles use (a real fresh
/// process starts with an empty map and the disk file on disk). Unix
/// only: its callers are the unix socket-harness tests.
#[cfg(all(test, unix))]
pub(crate) fn clear_in_process_probe_memo_for_tests() {
    *lock_probe_memo() = None;
}
