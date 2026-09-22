//! The session-navigation surface (protocol breadth wave b9): the worker
//! arms for `new_session`, `switch_session`, and `import_jsonl` (TS
//! daemon-mode cases over `AgentSessionRuntime.newSession` /
//! `switchSession` / `importFromJsonl`). All three replace the worker's
//! live session with another file (the TS runtime's replacement lease
//! path): the store swaps, the engine's session file moves, and the live
//! context rebuilds onto the new branch - the same flow `fork` runs
//! (`branch_navigation.rs`).
//!
//! Replacement ruling (TS parity): the whole-runtime replacement flows
//! retire the old session's runtime first - `teardownForReplacement` ->
//! `teardownCurrent` -> `session.disposeAsync()` disposes the kernel (a
//! final namespace snapshot flush, then the `python -m rlm.repl` process
//! exits) and drops the session object - so the replacement session
//! rebuilds cold: a fresh kernel (the prewarm fires again at the
//! replacement), a system prompt built on the new conversation log, and
//! an empty namespace unless the moved-to session carries its own
//! snapshot. The TS order is kept: the replacement file is prepared and
//! validated BEFORE the teardown (a failed prepare - a missing switch
//! target, a missing import file, a bad fork entry - leaves the old
//! session, its kernel, and any in-flight work untouched), and the
//! teardown runs between the prepare and the swap. The tree moves
//! (`navigate_tree`) are NOT replacements: TS rebuilds the branch
//! context in place on the live session and the kernel stays warm.
//!
//! Responses are the TS `{ cancelled: false }` wire object; a missing input
//! file answers the TS import error (`File not found: <path>`), and a
//! stored session cwd that no longer exists answers the TS
//! `MissingSessionCwdError` text.
//!
//! Cwd rebind (TS parity): `switchSession` and `importFromJsonl` rebuild
//! the runtime with `createRuntime({ cwd: sessionManager.getCwd() })` -
//! the TARGET session's recorded cwd (an explicit override, else the
//! stored header cwd, else the process cwd). The worker rebinds onto the
//! prepared target's cwd between the teardown and the rebuild, so the
//! rebuilt session's kernel-resident tools (bash/edit) run in the
//! moved-to session's working directory; `newSession` keeps the live
//! cwd (TS `createRuntime({ cwd: this.cwd })`).

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::engine::SessionEngine;
use crate::protocol::{response_failure, response_success, DaemonErrorInfo, DaemonResponse};
use crate::session_store::{session_file_name, SessionFile};
use crate::worker::{SessionCore, Worker};

/// A prepared replacement session (TS `SessionManager.open` +
/// `assertSessionCwdExists`): the opened file, plus the session cwd the
/// replacement runtime rebinds onto (TS `createRuntime({ cwd:
/// sessionManager.getCwd() })` — the override or the stored header cwd).
/// `None` keeps the live cwd: the TS fallthrough is the process cwd, which
/// is the worker's live cwd already.
pub(crate) struct PreparedReplacement {
    pub(crate) file: SessionFile,
    pub(crate) cwd: Option<String>,
}

/// The navigation surface: the prepare and swap phases of `fork`'s
/// replacement flow the three commands share. The teardown between the
/// phases is the worker's (it owns the turn/compaction settle and the
/// engine retire), matching the TS split `teardownForReplacement` /
/// `buildAndApplyReplacement`.
pub(crate) struct SessionNavigation {
    engine: Arc<dyn SessionEngine>,
    core: Arc<Mutex<SessionCore>>,
}

impl SessionNavigation {
    pub(crate) fn new(engine: Arc<dyn SessionEngine>, core: Arc<Mutex<SessionCore>>) -> Self {
        SessionNavigation { engine, core }
    }

    /// Swap the worker's live session onto `file`: the store, the engine's
    /// session file, and the rebuilt context (the shared tail of
    /// new_session / switch_session / import_jsonl). The caller retires
    /// the previous runtime (the worker's `teardown_for_replacement`)
    /// before this runs - and rebinds the worker's cwd when the moved-to
    /// session records another one - so the context park lands on the
    /// fresh, unbuilt session and its first build adopts the replacement
    /// branch in the replacement session's cwd.
    async fn replace_session(&self, file: SessionFile) -> Result<(), String> {
        let branch_entries = file.branch_file_entries();
        let new_path = file.path.clone();
        {
            let mut core = self.core.lock().unwrap();
            core.store = Some(file);
        }
        self.engine.set_session_file(new_path);
        // The replacement retired the runtime, so the rebuild parks on the
        // fresh, unbuilt session: its first build seeds the goal state
        // from the moved branch's own rows (the TS constructor's
        // `_loadPersistedGoalState`), faithful semantics.
        rebuild_engine_context(
            &self.engine,
            branch_entries,
            pa_core::session_engine::goal_driver::GoalBranchReload::FaithfulBranch,
        )
        .await
    }

    /// `new_session`'s prepare phase (TS `SessionManager.create` +
    /// `newSession({ parentSession, rlmDepth })` before the runtime
    /// teardown): a fresh session in the same directory, optionally
    /// parented on `parentSession` with the current depth. Preparing
    /// never touches the live session, so a prepare failure leaves it
    /// untouched - the TS `releaseUncommittedLease` fallthrough.
    #[allow(clippy::result_large_err)]
    pub(crate) async fn prepare_new_session(
        &self,
        payload: &Value,
    ) -> Result<PreparedReplacement, DaemonResponse> {
        let parent_session = payload
            .get("parentSession")
            .and_then(Value::as_str)
            .map(str::to_string);
        let (cwd, session_dir, rlm_depth) = {
            let core = self.core.lock().unwrap();
            match core.store.as_ref() {
                Some(store) => (
                    core.cwd.clone(),
                    store.path.parent().map(|dir| dir.to_path_buf()),
                    store.header.rlm_depth.unwrap_or(0) as u32,
                ),
                None => {
                    return Err(response_failure(
                        None,
                        "new_session",
                        "Session is still initializing",
                        None,
                    ))
                }
            }
        };
        let mut fresh = SessionFile::create(&cwd, parent_session.as_deref(), rlm_depth);
        if let Some(session_dir) = session_dir {
            fresh.set_path(session_dir.join(session_file_name(fresh.session_id())));
            if let Err(error) = fresh.rewrite() {
                return Err(response_failure(
                    None,
                    "new_session",
                    &error.to_string(),
                    None,
                ));
            }
        }
        // TS `newSession` keeps the runtime's cwd (`createRuntime({ cwd:
        // this.cwd })`): the fresh session runs where the live one did.
        Ok(PreparedReplacement {
            file: fresh,
            cwd: None,
        })
    }

    /// `switch_session`'s prepare phase (TS `SessionManager.open` +
    /// `assertSessionCwdExists`): open the requested session file and
    /// check its stored cwd exists. A missing file or a gone cwd fails
    /// here - before the teardown - so the live session keeps its kernel
    /// and any in-flight work, exactly like the TS throw out of
    /// `switchSession` before `teardownForReplacement`.
    #[allow(clippy::result_large_err)]
    pub(crate) async fn prepare_switch_session(
        &self,
        payload: &Value,
    ) -> Result<PreparedReplacement, DaemonResponse> {
        let session_path = payload
            .get("sessionPath")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let cwd_override = payload
            .get("cwdOverride")
            .and_then(Value::as_str)
            .map(str::to_string);
        self.open_replacement(session_path, cwd_override, "switch_session")
            .await
    }

    /// `import_jsonl`'s prepare phase (TS `importFromJsonl` before the
    /// runtime teardown): copy the input file into the session dir and
    /// open the copy. A missing input file answers the TS import error
    /// without touching the live session.
    #[allow(clippy::result_large_err)]
    pub(crate) async fn prepare_import_jsonl(
        &self,
        payload: &Value,
    ) -> Result<PreparedReplacement, DaemonResponse> {
        let input_path = payload
            .get("inputPath")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let cwd_override = payload
            .get("cwdOverride")
            .and_then(Value::as_str)
            .map(str::to_string);
        let resolved = std::path::Path::new(input_path);
        if !resolved.is_file() {
            return Err(response_failure(
                None,
                "import_jsonl",
                &format!("File not found: {}", resolved.display()),
                Some(DaemonErrorInfo::SessionImportFileNotFound {
                    file_path: resolved.display().to_string(),
                }),
            ));
        }
        // The destination is the session dir's copy of the imported file
        // (TS `copyFileSync`); an in-place import (same file) skips the
        // copy.
        let destination = {
            let core = self.core.lock().unwrap();
            core.store
                .as_ref()
                .and_then(|store| store.path.parent().map(|dir| dir.to_path_buf()))
        };
        let target = match destination {
            Some(dir) => dir.join(
                resolved
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| session_file_name("imported")),
            ),
            None => {
                return Err(response_failure(
                    None,
                    "import_jsonl",
                    "Session is still initializing",
                    None,
                ))
            }
        };
        std::fs::create_dir_all(target.parent().unwrap_or(std::path::Path::new(".")))
            .map_err(|error| error.to_string())
            .ok();
        if std::fs::canonicalize(&target).ok() != std::fs::canonicalize(resolved).ok() {
            if let Err(error) = std::fs::copy(resolved, &target) {
                return Err(response_failure(
                    None,
                    "import_jsonl",
                    &error.to_string(),
                    None,
                ));
            }
        }
        self.open_replacement(&target.to_string_lossy(), cwd_override, "import_jsonl")
            .await
    }

    /// Open one replacement session file and check its stored cwd exists
    /// (TS `SessionManager.open` + `assertSessionCwdExists`): the
    /// `MissingSessionCwdError` text is TS-verbatim. The prepared target
    /// carries the session cwd the replacement rebinds onto (TS
    /// `SessionManager.open`'s `cwdOverride ?? header.cwd ?? process.cwd()`
    /// — the last term is the worker's live cwd, so the empty fallthrough
    /// keeps it).
    #[allow(clippy::result_large_err)]
    async fn open_replacement(
        &self,
        path: &str,
        cwd_override: Option<String>,
        command: &'static str,
    ) -> Result<PreparedReplacement, DaemonResponse> {
        let file = SessionFile::open(std::path::Path::new(path))
            .map_err(|error| response_failure(None, command, &error.to_string(), None))?;
        let cwd = cwd_override
            .clone()
            .or_else(|| (!file.header.cwd.is_empty()).then(|| file.header.cwd.clone()));
        if let Some(cwd) = cwd.as_deref() {
            if !std::path::Path::new(cwd).is_dir() {
                let fallback = {
                    let core = self.core.lock().unwrap();
                    core.cwd.clone()
                };
                // The typed error info lets clients render the TS
                // missing-cwd prompt (the issue carries the fallback cwd
                // the confirm answers with).
                return Err(response_failure(
                    None,
                    command,
                    &format!(
                        "Stored session working directory does not exist: {cwd}\nSession file: {path}\nCurrent working directory: {fallback}"
                    ),
                    Some(DaemonErrorInfo::MissingSessionCwd {
                        issue: json!({
                            "sessionFile": path,
                            "sessionCwd": cwd,
                            "fallbackCwd": fallback,
                        }),
                    }),
                ));
            }
        }
        Ok(PreparedReplacement { file, cwd })
    }
}

/// Rebuild the engine's live context onto the moved session (the same
/// helper `branch_navigation` runs for forks), with the goal reload rule
/// riding the rebuild (the replacement flow's fresh build seeds
/// faithfully, the TS constructor load).
async fn rebuild_engine_context(
    engine: &Arc<dyn SessionEngine>,
    branch_entries: Vec<pa_types::session::FileEntry>,
    goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
) -> Result<(), String> {
    let engine = Arc::clone(engine);
    tokio::task::spawn_blocking(move || engine.rebuild_session_context(branch_entries, goal_reload))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("{error:#}"))
}

impl Worker {
    /// The shared replacement flow (TS `teardownForReplacement` ->
    /// `buildAndApplyReplacement`): prepare the replacement file, retire
    /// the live runtime (kernel dispose - the fresh session's kernel
    /// starts cold), rebind the worker onto the replacement session's cwd
    /// (TS `createRuntime({ cwd: sessionManager.getCwd() })` - the
    /// rebind lands between the retire and the rebuild, so the fresh
    /// session's kernel spawns in the moved-to cwd), swap the store, and
    /// rebuild the context onto the new branch. After the swap the
    /// replacement session refreshes its derived state (TS
    /// `refreshReplacedSessionState`) and rebinds the schedule catalog
    /// (TS `rebindCronJobsToState`). The fresh session builds in the
    /// background, so the replacement kernel's prewarm fires at the
    /// replacement.
    async fn run_session_replacement(
        &self,
        command: &'static str,
        prepared: Result<PreparedReplacement, DaemonResponse>,
    ) -> DaemonResponse {
        let target = match prepared {
            Ok(target) => target,
            // A prepare failure never tore anything down: the live
            // session, its kernel, and any in-flight work are untouched
            // (the TS `releaseUncommittedLease` fallthrough).
            Err(response) => return response,
        };
        // TS `teardownForReplacement` rethrows: a failed retire (the
        // session's own kernel dispose, or a child close) fails the
        // replacement command with the old runtime already torn down.
        if let Err(error) = self.teardown_for_replacement().await {
            return response_failure(None, command, &format!("{error:#}"), None);
        }
        if let Some(cwd) = target.cwd.as_deref() {
            self.rebind_worker_cwd(cwd);
        }
        match self.navigation.replace_session(target.file).await {
            Ok(()) => {
                self.refresh_replaced_session_state();
                self.bind_scheduled_jobs().await;
                self.prewarm_replacement_session();
                response_success(None, command, Some(json!({ "cancelled": false })))
            }
            Err(error) => response_failure(None, command, &error, None),
        }
    }

    /// `new_session` (the dispatch surface of [`SessionNavigation`]).
    pub(crate) async fn handle_new_session(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("new_session") {
            return response;
        }
        let prepared = self.navigation.prepare_new_session(payload).await;
        self.run_session_replacement("new_session", prepared).await
    }

    /// `switch_session`.
    pub(crate) async fn handle_switch_session(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("switch_session") {
            return response;
        }
        let prepared = self.navigation.prepare_switch_session(payload).await;
        self.run_session_replacement("switch_session", prepared)
            .await
    }

    /// `import_jsonl`.
    pub(crate) async fn handle_import_jsonl(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("import_jsonl") {
            return response;
        }
        let prepared = self.navigation.prepare_import_jsonl(payload).await;
        self.run_session_replacement("import_jsonl", prepared).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    async fn created_worker() -> Arc<Worker> {
        let dir = std::env::temp_dir().join(format!("pa-worker-nav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::worker::WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "nav-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": "/tmp", "name": "nav" }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        worker
    }

    /// Wire shape: `new_session` answers `{ cancelled: false }` and the
    /// worker's session moves to the fresh file.
    #[tokio::test]
    async fn new_session_answers_the_ts_cancelled_shape() {
        let worker = created_worker().await;
        let response = worker
            .dispatch("new_session", &json!({ "activeSessionId": "nav-session" }))
            .await;
        assert_eq!(response.data, Some(json!({ "cancelled": false })));
        // The fresh session carries no history.
        let stats = worker
            .dispatch(
                "get_session_stats",
                &json!({ "activeSessionId": "nav-session" }),
            )
            .await;
        assert!(stats.success, "{stats:?}");
    }

    /// Wire shape: `switch_session` moves to an existing session file;
    /// a missing file fails the command.
    #[tokio::test]
    async fn switch_session_replaces_the_store_and_fails_on_missing_files() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "switch_session",
                &json!({ "activeSessionId": "nav-session", "sessionPath": "/tmp/definitely-missing.jsonl" }),
            )
            .await;
        assert!(!response.success, "{response:?}");
        assert!(
            response
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("/tmp/definitely-missing.jsonl"),
            "{response:?}"
        );
    }

    /// The replacement ruling over the dispatch surface (TS
    /// `teardownForReplacement` order): the teardown runs only after the
    /// replacement file is prepared - a failed switch target never retires
    /// the live session - while a successful replacement retires the built
    /// session (its kernel disposes; the fresh session rebuilds in the
    /// background, its kernel prewarm firing at the replacement). A tree
    /// move is not a replacement: the built session stays warm.
    // The faux provider registration is global; the lock must span the
    // awaited turns that consume its queue.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn replacement_flows_retire_only_on_a_prepared_file() {
        let _faux = crate::agent_engine::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = tempfile::TempDir::new().expect("temp dir");
        let sessions_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
        let config = crate::worker::WorkerConfig {
            socket_path: dir.path().join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "replacement-session".to_string(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({
                "engine": "faux",
                "responses": [{ "text": "one" }, { "text": "two" }],
            })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({
                    "cwd": dir.path().to_string_lossy(),
                    "sessionDir": sessions_dir.to_string_lossy(),
                }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let session_id = "replacement-session".to_string();
        let prompted = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": session_id, "message": "hello" }),
            )
            .await;
        assert!(prompted.success, "prompt failed: {prompted:?}");
        let engine = worker
            .agent_engine
            .as_ref()
            .expect("faux script drives the real engine")
            .clone();
        let session_built = || {
            let engine = std::sync::Arc::clone(&engine);
            tokio::task::spawn_blocking(move || engine.session.blocking_lock().is_some())
        };
        assert!(
            session_built().await.expect("built join"),
            "the turn built the session"
        );

        // A failed switch prepare leaves the live session untouched: no
        // teardown ran, so the built session (and its kernel) survive -
        // the TS `releaseUncommittedLease` fallthrough.
        let failed = worker
            .dispatch(
                "switch_session",
                &json!({
                    "activeSessionId": session_id,
                    "sessionPath": "/tmp/definitely-missing-replacement.jsonl",
                }),
            )
            .await;
        assert!(
            !failed.success,
            "missing switch target succeeded: {failed:?}"
        );
        assert!(
            session_built().await.expect("built join"),
            "a failed prepare must not retire the session"
        );

        // A tree move is not a replacement: the built session stays
        // (the kernel stays warm - TS rebuilds the branch in place).
        let tree = worker
            .dispatch(
                "get_session_tree",
                &json!({ "activeSessionId": session_id }),
            )
            .await;
        assert!(tree.success, "tree failed: {tree:?}");
        assert!(
            session_built().await.expect("built join"),
            "a tree move must keep the session warm"
        );

        // A successful replacement retires the built session and
        // rebuilds it in the background (the fresh session's kernel
        // prewarm fires at the replacement).
        let replaced = worker
            .dispatch("new_session", &json!({ "activeSessionId": session_id }))
            .await;
        assert_eq!(
            replaced.data,
            Some(json!({ "cancelled": false })),
            "new_session failed: {replaced:?}"
        );
        let second = worker
            .dispatch(
                "prompt_and_wait",
                &json!({ "activeSessionId": session_id, "message": "again" }),
            )
            .await;
        assert!(
            second.success,
            "the replacement session's turn failed: {second:?}"
        );
        assert!(
            session_built().await.expect("built join"),
            "the replacement session rebuilt"
        );

        // The worker (and its engine's private runtime) must drop off the
        // async context.
        let worker_for_drop = worker;
        drop(engine);
        tokio::task::spawn_blocking(move || drop(worker_for_drop))
            .await
            .expect("worker drop join");
    }

    /// The switch cwd rebind (TS `switchSession` -> `createRuntime({ cwd:
    /// sessionManager.getCwd() })`): the worker moves onto the target
    /// session's recorded working directory - the wire summary's cwd
    /// follows - while `new_session` keeps the live cwd (TS
    /// `createRuntime({ cwd: this.cwd })`), and a target whose stored cwd
    /// is gone fails at the prepare (TS `MissingSessionCwdError`), leaving
    /// the live session untouched.
    #[tokio::test]
    async fn switch_session_rebinds_the_worker_cwd_and_new_session_keeps_it() {
        let worker = created_worker().await;
        let state = worker
            .dispatch("get_state", &json!({ "activeSessionId": "nav-session" }))
            .await;
        assert!(state.success, "{state:?}");
        assert_eq!(state.data.as_ref().unwrap()["cwd"], "/tmp");

        // A target session file recording another existing cwd.
        let target_cwd = tempfile::TempDir::new().expect("target cwd");
        let target = target_cwd.path().join("switch-target.jsonl");
        std::fs::write(
            &target,
            format!(
                "{}\n",
                json!({
                    "type": "session",
                    "id": "switch-target",
                    "timestamp": "2026-09-21T00:00:00.000Z",
                    "cwd": target_cwd.path().to_string_lossy(),
                })
            ),
        )
        .expect("write switch target");
        let switched = worker
            .dispatch(
                "switch_session",
                &json!({
                    "activeSessionId": "nav-session",
                    "sessionPath": target.to_string_lossy(),
                }),
            )
            .await;
        assert!(switched.success, "{switched:?}");
        let state = worker
            .dispatch("get_state", &json!({ "activeSessionId": "nav-session" }))
            .await;
        let target_cwd = target_cwd.path().to_string_lossy().to_string();
        assert_eq!(state.data.as_ref().unwrap()["cwd"], target_cwd);

        // A target whose stored cwd no longer exists fails at the
        // prepare (the TS `MissingSessionCwdError` text) - the live
        // session keeps the rebound cwd and its store.
        let gone_dir = tempfile::TempDir::new().expect("gone dir");
        let gone = gone_dir.path().join("gone-target.jsonl");
        std::fs::write(
            &gone,
            format!(
                "{}\n",
                json!({
                    "type": "session",
                    "id": "gone-target",
                    "timestamp": "2026-09-21T00:00:00.000Z",
                    "cwd": gone_dir.path().join("missing-cwd"),
                })
            ),
        )
        .expect("write gone target");
        let failed = worker
            .dispatch(
                "switch_session",
                &json!({
                    "activeSessionId": "nav-session",
                    "sessionPath": gone.to_string_lossy(),
                }),
            )
            .await;
        assert!(!failed.success, "{failed:?}");
        assert!(
            failed
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("Stored session working directory does not exist"),
            "{failed:?}"
        );
        let state = worker
            .dispatch("get_state", &json!({ "activeSessionId": "nav-session" }))
            .await;
        assert_eq!(state.data.as_ref().unwrap()["cwd"], target_cwd);

        // `new_session` keeps the live cwd.
        let fresh = worker
            .dispatch("new_session", &json!({ "activeSessionId": "nav-session" }))
            .await;
        assert!(fresh.success, "{fresh:?}");
        let state = worker
            .dispatch("get_state", &json!({ "activeSessionId": "nav-session" }))
            .await;
        assert_eq!(state.data.as_ref().unwrap()["cwd"], target_cwd);
    }

    /// The fork schedule rebind (TS daemon-mode `fork` case ->
    /// `rebindCronJobsToState(state)` after `runtime.fork`): the live
    /// session's scheduled jobs rebind onto the forked session - the
    /// moved-to file and its header id - so a later restore targets the
    /// fork, not the source branch; the active session id and cwd stay
    /// (the fork keeps the runtime cwd, TS `forkFrom(_, this.cwd)`).
    #[tokio::test]
    async fn fork_rebinds_the_scheduled_jobs_onto_the_forked_session() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let sessions_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions_dir).expect("sessions dir");
        let config = crate::worker::WorkerConfig {
            socket_path: dir.path().join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "fork-schedule-session".to_string(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({
                    "cwd": dir.path().to_string_lossy(),
                    "sessionDir": sessions_dir.to_string_lossy(),
                }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        // One user message so the fork has a branch point.
        let entry_id = {
            let mut core = worker.core.lock().unwrap();
            let store = core.store.as_mut().expect("created store");
            let entry_id =
                store.append_message(json!({ "role": "user", "content": "hi", "timestamp": 1u64 }));
            let _ = store.rewrite();
            entry_id
        };
        let added = worker
            .dispatch(
                "cron_add",
                &json!({
                    "activeSessionId": "fork-schedule-session",
                    "schedule": "in 10m",
                    "prompt": "run me",
                }),
            )
            .await;
        assert!(added.success, "cron_add failed: {added:?}");
        let source_file = {
            let core = worker.core.lock().unwrap();
            core.store
                .as_ref()
                .expect("store")
                .path
                .to_string_lossy()
                .to_string()
        };

        let forked = worker
            .dispatch(
                "fork",
                &json!({
                    "activeSessionId": "fork-schedule-session",
                    "entryId": entry_id,
                    "position": "at",
                }),
            )
            .await;
        assert!(forked.success, "fork failed: {forked:?}");

        // The job followed the fork: its binding is the forked session.
        let (forked_file, forked_id, forked_cwd) = {
            let core = worker.core.lock().unwrap();
            let store = core.store.as_ref().expect("forked store");
            (
                store.path.to_string_lossy().to_string(),
                store.session_id().to_string(),
                core.cwd.clone(),
            )
        };
        assert_ne!(forked_file, source_file, "fork did not move the store");
        let jobs = worker.scheduled.store().list();
        assert_eq!(jobs.len(), 1, "{jobs:?}");
        assert_eq!(jobs[0].session_file, forked_file, "{jobs:?}");
        assert_eq!(jobs[0].session_id, forked_id, "{jobs:?}");
        assert_eq!(jobs[0].active_session_id, "fork-schedule-session");
        assert_eq!(jobs[0].cwd, forked_cwd, "{jobs:?}");
    }

    /// Wire shape: `import_jsonl` answers the TS import error for a
    /// missing input file.
    #[tokio::test]
    async fn import_jsonl_answers_the_ts_file_not_found_error() {
        let worker = created_worker().await;
        let response = worker
            .dispatch(
                "import_jsonl",
                &json!({ "activeSessionId": "nav-session", "inputPath": "/tmp/no-such-import.jsonl" }),
            )
            .await;
        assert!(!response.success, "{response:?}");
        assert_eq!(
            response.error.as_deref(),
            Some("File not found: /tmp/no-such-import.jsonl")
        );
        // The typed error info lets the client render the TS import
        // error surface (daemon-errors.ts `serializeDaemonError`).
        assert_eq!(
            response.error_info,
            Some(DaemonErrorInfo::SessionImportFileNotFound {
                file_path: "/tmp/no-such-import.jsonl".to_string()
            })
        );
    }

    /// A replacement whose stored cwd is gone answers the TS
    /// `MissingSessionCwdError` text plus its typed error info (the
    /// issue carries the fallback cwd the client's confirm answers with).
    #[tokio::test]
    async fn import_jsonl_answers_the_ts_missing_cwd_error_info() {
        let dir = std::env::temp_dir().join(format!("pa-import-cwd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // The live session persists (the import copies its input into the
        // live session's directory), so the worker starts on a real file.
        let live = dir.join("live-session.jsonl");
        let mut live_file = SessionFile::create("/tmp", None, 0);
        live_file.set_path(live.clone());
        live_file.rewrite().unwrap();
        let config = crate::worker::WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "nav-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(crate::worker::Worker::new(config, None));
        let created = worker
            .dispatch(
                "create",
                &json!({ "cwd": "/tmp", "name": "nav", "sessionPath": live.to_string_lossy() }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        let gone = dir.join("gone-session.jsonl");
        let gone_cwd = dir.join("gone-cwd");
        // A well-formed session file whose stored cwd no longer exists.
        let mut file = SessionFile::create(&gone_cwd.to_string_lossy(), None, 0);
        file.set_path(gone.clone());
        file.rewrite().unwrap();
        let response = worker
            .dispatch(
                "import_jsonl",
                &json!({
                    "activeSessionId": "nav-session",
                    "inputPath": gone.to_string_lossy(),
                }),
            )
            .await;
        assert!(!response.success, "{response:?}");
        assert!(
            response
                .error
                .as_deref()
                .unwrap_or_default()
                .starts_with("Stored session working directory does not exist:"),
            "the TS-verbatim error text, got {response:?}"
        );
        match response.error_info {
            Some(DaemonErrorInfo::MissingSessionCwd { issue }) => {
                assert_eq!(issue["sessionCwd"], json!(gone_cwd.to_string_lossy()));
                assert_eq!(issue["fallbackCwd"], json!("/tmp"));
            }
            other => panic!("expected the typed missing-cwd error info, got {other:?}"),
        }
    }
}
