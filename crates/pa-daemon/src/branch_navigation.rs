//! Session-tree navigation commands: the worker-side handlers for
//! `get_session_tree`, `get_user_messages_for_forking`,
//! `set_session_entry_label`, `navigate_tree`, `fork`, and
//! `abort_branch_summary`. Port of the matching daemon-mode cases; the
//! tree store operations live in [`crate::session_tree`], the branch-summary
//! model call in the engine ([`SessionEngine::run_branch_summary`]).

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::engine::{BranchSummaryRequest, SessionEngine};
use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::session_store::{SessionEntry, SessionFile};
use crate::session_tree;
use crate::worker::{SessionCore, Worker};
use pa_agent::abort::AbortController;

/// One completed abandoned-branch summary to persist: the text, its usage
/// block, its file-operation details, and the model the summary call
/// served on (TS #2411's auxiliary routing — `None` keeps the timeline
/// attribution).
type PendingBranchSummary = (
    String,
    Option<Value>,
    Option<Value>,
    Option<(String, String)>,
);

pub(crate) struct TreeNavigation {
    engine: Arc<dyn SessionEngine>,
    core: Arc<Mutex<SessionCore>>,
    idle_notify: Arc<Notify>,
    /// The live branch-summary run's abort slot; each run replaces it, like
    /// the TS `_branchSummaryAbortController`.
    abort: Mutex<Option<Arc<AbortController>>>,
}

impl TreeNavigation {
    pub(crate) fn new(
        engine: Arc<dyn SessionEngine>,
        core: Arc<Mutex<SessionCore>>,
        idle_notify: Arc<Notify>,
    ) -> Self {
        TreeNavigation {
            engine,
            core,
            idle_notify,
            abort: Mutex::new(None),
        }
    }

    /// `abort_branch_summary`: abort the live run; the TS handler always
    /// replies success.
    pub(crate) fn abort(&self) {
        if let Some(controller) = self
            .abort
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            controller.abort();
        }
    }

    /// `get_session_tree`: every entry in file order with its label plus the
    /// current leaf id (TS `getFlatTree` + `getLeafId`).
    pub(crate) fn get_session_tree(&self) -> DaemonResponse {
        let core = self.core.lock().unwrap();
        match core.store.as_ref() {
            Some(store) => response_success(
                None,
                "get_session_tree",
                Some(json!({
                    "flatNodes": session_tree::flat_tree(store),
                    "leafId": store.leaf_id(),
                })),
            ),
            None => response_failure(
                None,
                "get_session_tree",
                "Session is still initializing",
                None,
            ),
        }
    }

    /// `get_user_messages_for_forking`: the user messages with text (TS
    /// `getUserMessagesForForking`).
    pub(crate) fn get_user_messages_for_forking(&self) -> DaemonResponse {
        let core = self.core.lock().unwrap();
        match core.store.as_ref() {
            Some(store) => response_success(
                None,
                "get_user_messages_for_forking",
                Some(json!({
                    "messages": session_tree::user_messages_for_forking(store),
                })),
            ),
            None => response_failure(
                None,
                "get_user_messages_for_forking",
                "Session is still initializing",
                None,
            ),
        }
    }

    /// `set_session_entry_label`: persist a label change for an entry (TS
    /// `appendLabelChange`; a missing target errors like the TS throw).
    pub(crate) fn set_session_entry_label(&self, payload: &Value) -> DaemonResponse {
        let entry_id = payload
            .get("entryId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let label = payload.get("label").and_then(Value::as_str);
        let mut core = self.core.lock().unwrap();
        match core.store.as_mut() {
            Some(store) => match store.append_label_change(entry_id, label) {
                Ok(_) => response_success(None, "set_session_entry_label", None),
                Err(error) => {
                    response_failure(None, "set_session_entry_label", &error.to_string(), None)
                }
            },
            None => response_failure(
                None,
                "set_session_entry_label",
                "Session is still initializing",
                None,
            ),
        }
    }

    /// `navigate_tree`: move the session leaf onto a tree node, optionally
    /// summarizing the abandoned branch first (TS `_navigateTree`). The
    /// response carries `editorText` when the target was a user message or
    /// custom message (the text re-enters the input bar).
    /// `navigate_tree` (TS `AgentSession.navigateTree`): a tree move is
    /// NOT a runtime replacement - TS rebuilds the branch context in
    /// place on the live session (`agent.state.messages =
    /// sessionContext.messages`), so the kernel stays warm: same process,
    /// same namespace. No teardown runs here (the replacement ruling in
    /// `session_navigation` covers `fork`, the only tree flow that
    /// replaces the runtime).
    pub(crate) async fn navigate_tree(&self, payload: &Value) -> DaemonResponse {
        let target_id = payload
            .get("targetId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let summarize = payload.get("summarize").and_then(Value::as_bool) == Some(true);
        let custom_instructions = payload
            .get("customInstructions")
            .and_then(Value::as_str)
            .map(str::to_string);
        let label = payload
            .get("label")
            .and_then(Value::as_str)
            .map(str::to_string);

        // Snapshot the tree state under one lock pass; the model call below
        // runs without holding it.
        let (target, old_leaf, entries) = {
            let core = self.core.lock().unwrap();
            let Some(store) = core.store.as_ref() else {
                return response_failure(
                    None,
                    "navigate_tree",
                    "Session is still initializing",
                    None,
                );
            };
            let Some(target) = store.entry(target_id).cloned() else {
                return response_failure(
                    None,
                    "navigate_tree",
                    &format!("Entry {target_id} not found"),
                    None,
                );
            };
            let old_leaf = store.leaf_id().map(str::to_string);
            let entries = store.entries().to_vec();
            (target, old_leaf, entries)
        };
        // No-op when already at the target (TS checks before pausing work).
        if Some(target_id) == old_leaf.as_deref() {
            return response_success(None, "navigate_tree", Some(json!({ "cancelled": false })));
        }
        // A navigation interrupts the running turn first (TS
        // `acquireQueuedWorkPause` + `waitForIdle`).
        self.wait_turn_end().await;

        // Where the leaf lands, and what text returns to the editor.
        let (new_leaf, editor_text) = navigation_point(&target);

        // The abandoned-branch summary (TS `generateBranchSummary` over
        // `collectEntriesForBranchSummary`).
        let mut summary: Option<PendingBranchSummary> = None;
        let replace_instructions =
            payload.get("replaceInstructions").and_then(Value::as_bool) == Some(true);
        if summarize {
            let file_entries: Vec<_> = entries
                .iter()
                .filter_map(session_tree::entry_as_file_entry)
                .collect();
            let collected =
                pa_core::session_engine::branch_summarization::collect_entries_for_branch_summary(
                    &file_entries,
                    old_leaf.as_deref(),
                    target_id,
                );
            if !collected.entries.is_empty() {
                let controller = Arc::new(AbortController::new());
                {
                    let mut slot = self
                        .abort
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    *slot = Some(Arc::clone(&controller));
                }
                let outcome = {
                    let engine = Arc::clone(&self.engine);
                    let signal = controller.signal();
                    tokio::task::spawn_blocking(move || {
                        engine.run_branch_summary(
                            BranchSummaryRequest {
                                entries: collected.entries,
                                custom_instructions,
                                replace_instructions,
                            },
                            &signal,
                        )
                    })
                    .await
                    .unwrap_or_else(|join_error| {
                        crate::engine::BranchSummaryOutcome::Failed {
                            error: format!("branch summary run failed: {join_error}"),
                        }
                    })
                };
                let mut slot = self
                    .abort
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if slot
                    .as_ref()
                    .is_some_and(|live| Arc::ptr_eq(live, &controller))
                {
                    *slot = None;
                }
                match outcome {
                    crate::engine::BranchSummaryOutcome::Complete { run } => {
                        summary = Some((run.summary, run.usage, run.details, run.model));
                    }
                    crate::engine::BranchSummaryOutcome::Aborted => {
                        return response_success(
                            None,
                            "navigate_tree",
                            Some(json!({ "cancelled": true, "aborted": true })),
                        )
                    }
                    crate::engine::BranchSummaryOutcome::Failed { error } => {
                        return response_failure(None, "navigate_tree", &error, None)
                    }
                }
            }
        }

        // Move the leaf and persist the summary entry, then rebuild the
        // engine context onto the moved branch. A created summary entry
        // means the navigation rebuilds the context across a
        // compaction-style cut (TS `Boolean(summaryText)`).
        let summarized = summary.is_some();
        let (branch_entries, summary_entry) = {
            let mut core = self.core.lock().unwrap();
            let Some(store) = core.store.as_mut() else {
                return response_failure(
                    None,
                    "navigate_tree",
                    "Session is still initializing",
                    None,
                );
            };
            let mut summary_entry = None;
            if let Some((summary, usage, details, model)) = summary {
                match store.append_branch_summary(
                    new_leaf.as_deref(),
                    &summary,
                    details,
                    None,
                    usage,
                    model
                        .as_ref()
                        .map(|(provider, model_id)| (provider.as_str(), model_id.as_str())),
                ) {
                    Ok(summary_id) => {
                        if let Some(label) = &label {
                            if let Err(error) = store.append_label_change(&summary_id, Some(label))
                            {
                                return response_failure(
                                    None,
                                    "navigate_tree",
                                    &error.to_string(),
                                    None,
                                );
                            }
                        }
                        summary_entry = store.entry(&summary_id).map(session_tree::entry_json);
                    }
                    Err(error) => {
                        return response_failure(None, "navigate_tree", &error.to_string(), None)
                    }
                }
            } else {
                if let Err(error) = store.branch_to(new_leaf.as_deref()) {
                    return response_failure(None, "navigate_tree", &error.to_string(), None);
                }
                if let Some(label) = &label {
                    if let Err(error) = store.append_label_change(target_id, Some(label)) {
                        return response_failure(None, "navigate_tree", &error.to_string(), None);
                    }
                }
            }
            (store.branch_file_entries(), summary_entry)
        };
        // TS `Boolean(summaryText)`: a created summary entry means the
        // navigation rebuilt the context across a compaction-style cut
        // (the same timeline — the goal's accounting is monotonic); a
        // plain move is time travel and reloads faithfully.
        let goal_reload = if summarized {
            pa_core::session_engine::goal_driver::GoalBranchReload::SameTimeline
        } else {
            pa_core::session_engine::goal_driver::GoalBranchReload::FaithfulBranch
        };
        if let Err(error) = rebuild_engine_context(&self.engine, branch_entries, goal_reload).await
        {
            return response_failure(None, "navigate_tree", &error, None);
        }
        let mut data = json!({ "cancelled": false });
        if let Some(editor_text) = editor_text {
            data["editorText"] = json!(editor_text);
        }
        if let Some(summary_entry) = summary_entry {
            data["summaryEntry"] = summary_entry;
        }
        response_success(None, "navigate_tree", Some(data))
    }

    /// `fork`'s prepare phase (TS `AgentSessionRuntime.fork` before its
    /// `teardownForReplacement`): settle the running turn first (the
    /// branch copy below reads the store; a turn must not append entries
    /// mid-copy), resolve the fork point, and copy the active path up to
    /// the target into the new session file. `position: "before"`
    /// (default) forks from a user message with its text returned as
    /// `selectedText`; `"at"` keeps the path through the entry itself. A
    /// failed prepare never tears the live session down (the TS entry
    /// errors answer before the runtime teardown), so the live kernel
    /// and any in-flight work stay untouched.
    #[allow(clippy::result_large_err)]
    pub(crate) async fn prepare_fork(
        &self,
        payload: &Value,
    ) -> Result<(SessionFile, Option<String>), DaemonResponse> {
        let entry_id = payload
            .get("entryId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let position = payload.get("position").and_then(Value::as_str);
        // A fork interrupts the running turn first, like the TS runtime's
        // replacement lease path.
        self.wait_turn_end().await;

        let (target_leaf, selected_text, store, cwd) = {
            let core = self.core.lock().unwrap();
            let Some(store) = core.store.as_ref() else {
                return Err(response_failure(
                    None,
                    "fork",
                    "Session is still initializing",
                    None,
                ));
            };
            let Some(target) = store.entry(entry_id) else {
                return Err(response_failure(
                    None,
                    "fork",
                    "Invalid entry ID for forking",
                    None,
                ));
            };
            let (target_leaf, selected_text) = if let Some("at") = position {
                (Some(entry_id.to_string()), None)
            } else {
                let Some(text) = session_tree::user_entry_text(target) else {
                    return Err(response_failure(
                        None,
                        "fork",
                        "Invalid entry ID for forking",
                        None,
                    ));
                };
                (target.parent_id.clone(), Some(text))
            };
            (target_leaf, selected_text, store.clone(), core.cwd.clone())
        };

        let forked = match target_leaf.as_deref() {
            None => {
                // Fork at the root: a fresh empty session (TS `newSession`
                // with the source as parent).
                let mut forked = SessionFile::create(
                    &cwd,
                    store.path.to_str().map(str::to_string).as_deref(),
                    store.header.rlm_depth.unwrap_or(0) as u32,
                );
                if !store.path.as_os_str().is_empty() {
                    let session_dir = store.path.parent().unwrap_or(store.path.as_path());
                    let file = session_dir
                        .join(crate::session_store::session_file_name(forked.session_id()));
                    forked.set_path(file);
                    if let Some(lease) = &store.lease {
                        forked.lease =
                            Some(lease.acquire_target(&forked.path).map_err(|error| {
                                response_failure(None, "fork", &error.to_string(), None)
                            })?);
                    }
                    if let Err(error) = forked.rewrite() {
                        return Err(response_failure(None, "fork", &error.to_string(), None));
                    }
                }
                forked
            }
            Some(leaf_id) => {
                if store.path.as_os_str().is_empty() {
                    // In-memory session: the fork replaces the entries in
                    // place (TS non-persisted `createBranchedSession`).
                    let mut forked = store;
                    if let Err(error) = forked.replace_with_branch(Some(leaf_id)) {
                        return Err(response_failure(None, "fork", &error.to_string(), None));
                    }
                    forked
                } else {
                    let session_dir = store.path.parent().unwrap_or(store.path.as_path());
                    match store.create_branched_file(leaf_id, session_dir) {
                        Ok(forked) => forked,
                        Err(error) => {
                            return Err(response_failure(None, "fork", &error.to_string(), None))
                        }
                    }
                }
            }
        };

        Ok((forked, selected_text))
    }

    /// `fork`'s swap phase (TS `buildAndApplyReplacement`): the store,
    /// the engine's session file, and the rebuilt context move onto the
    /// prepared fork file. The worker runs its replacement teardown
    /// between the prepare and this swap, so the parked context lands on
    /// the fresh, unbuilt session and its first build adopts the fork's
    /// branch.
    pub(crate) async fn replace_with_fork(&self, forked: SessionFile) -> Result<(), String> {
        let branch_entries = forked.branch_file_entries();
        let new_path = forked.path.clone();
        {
            let mut core = self.core.lock().unwrap();
            core.store = Some(forked);
        }
        self.engine.set_session_file(new_path.clone());
        // TS re-restores the forked session's saved model at its runtime
        // recreation (`createRuntime` -> `createAgentSession`): the fork
        // resolves to the model its own file pins, not the previous
        // session's (an explicit flag still wins inside).
        self.engine.restore_session_model(&new_path).await;
        // A replacement flow retires the runtime first, so the rebuild
        // parks on the fresh, unbuilt session: its first build seeds the
        // goal state from the moved branch's own rows (the TS
        // constructor's `_loadPersistedGoalState`), faithful semantics.
        rebuild_engine_context(
            &self.engine,
            branch_entries,
            pa_core::session_engine::goal_driver::GoalBranchReload::FaithfulBranch,
        )
        .await
    }

    /// Wait until the running turn (if any) has settled (the compaction
    /// flow's interrupt-and-settle loop).
    async fn wait_turn_end(&self) {
        loop {
            let busy = {
                let mut core = self.core.lock().unwrap();
                if core.busy {
                    core.abort_requested = true;
                    // The interrupted turn's aborted row stays off the wire
                    // and out of the store (TS's navigation path never
                    // surfaces one — the compact-style teardown shape; the
                    // gate's aborted-row exception stays closed).
                    core.suppress_aborted_row = true;
                    true
                } else {
                    false
                }
            };
            if !busy {
                break;
            }
            // The interrupt-and-settle loop, like the compaction flow's:
            // the engine abort cancels the in-flight fetch now (TS
            // `requestAbort` -> `agent.abort()`).
            self.engine.abort_in_flight_turn();
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(50),
                self.idle_notify.notified(),
            )
            .await;
        }
        // The interrupted turn settled; the suppression owns only that
        // drain window.
        self.core.lock().unwrap().suppress_aborted_row = false;
    }
}

/// Rebuild the engine's live context onto the moved branch. The engine
/// method is synchronous and may ride its own runtime (the
/// `run_compaction` pattern), so it runs on a blocking thread — never on
/// the worker's async dispatcher (a `block_on` there panics). The goal
/// reload rule rides the rebuild (TS `_reloadGoalStateFromBranch`'s
/// `monotonicTokens`: a summary context rebuild continues the same
/// timeline, a plain branch move keeps faithful branch semantics).
async fn rebuild_engine_context(
    engine: &std::sync::Arc<dyn crate::engine::SessionEngine>,
    branch_entries: Vec<pa_types::session::FileEntry>,
    goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
) -> Result<(), String> {
    let engine = std::sync::Arc::clone(engine);
    tokio::task::spawn_blocking(move || engine.rebuild_session_context(branch_entries, goal_reload))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("{error:#}"))
}

/// Where a navigation lands (TS `_navigateTreeUnderPause`): a user message
/// or custom message target re-enters its text in the editor with the leaf
/// at its parent; every other target keeps its own id.
fn navigation_point(target: &SessionEntry) -> (Option<String>, Option<String>) {
    if let Some(text) = session_tree::user_entry_text(target) {
        return (target.parent_id.clone(), Some(text));
    }
    if target.type_ == "custom_message" {
        let text = custom_message_text(target);
        return (target.parent_id.clone(), text);
    }
    (Some(target.id.clone()), None)
}

/// The text of a custom-message entry (TS: string content, or the
/// concatenated text blocks).
fn custom_message_text(entry: &SessionEntry) -> Option<String> {
    match entry.fields.get("content") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(blocks)) => {
            let text: String = blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect();
            Some(text).filter(|text| !text.is_empty())
        }
        _ => None,
    }
}

impl Worker {
    /// `fork` (TS `AgentSessionRuntime.fork`): a whole-runtime
    /// replacement - prepare the fork file (the branch copy), retire the
    /// live runtime (the kernel disposes; the fresh session's kernel
    /// starts cold), swap the store, and prewarm the replacement session.
    /// The tree moves (`navigate_tree`) are the contrast ruling: TS
    /// rebuilds the branch context in place on the live session and never
    /// runs this teardown, so the kernel stays warm there.
    pub(crate) async fn handle_fork(&self, payload: &Value) -> DaemonResponse {
        let (forked, selected_text) = match self.tree_navigation.prepare_fork(payload).await {
            Ok(prepared) => prepared,
            Err(response) => return response,
        };
        // One replacement at a time: the fork's teardown, swap, restore,
        // and rebuild share the replacement gate with the other
        // whole-session replacements (a fork racing a `switch_session`
        // interleaves the same way two switches do).
        let _replacement_gate = self.replacement_gate.lock().await;
        if let Err(error) = self.teardown_for_replacement().await {
            return response_failure(None, "fork", &format!("{error:#}"), None);
        }
        match self.tree_navigation.replace_with_fork(forked).await {
            Ok(()) => {
                // The fork is a whole-runtime replacement (TS
                // `refreshReplacedSessionState` +
                // `rebindCronJobsToState` after `runtime.fork`): the
                // forked session's derived state re-seeds, and the live
                // session's scheduled jobs rebind onto the forked
                // session file — future restores target the fork, not the
                // source branch.
                self.refresh_replaced_session_state();
                self.bind_scheduled_jobs().await;
                self.prewarm_replacement_session();
                let mut data = json!({ "cancelled": false });
                if let Some(selected_text) = selected_text {
                    data["selectedText"] = json!(selected_text);
                }
                response_success(None, "fork", Some(data))
            }
            Err(error) => response_failure(None, "fork", &error, None),
        }
    }
}
