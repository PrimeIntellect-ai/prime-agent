//! Session-level /refine: message builders, history merge, and the
//! prepare -> child-spawn -> wake-apply flow. The planning model pass runs
//! in the refinement child (a daemon `rlm.spawn kind="refine"` child); the
//! parent only prepares the request (the trimmed conversation plus the
//! resolvable harness paths), then applies the child's proposal on the
//! child-reply wake against a freshly re-read harness state.

use std::path::{Path, PathBuf};

use pa_types::ai::UserContent;
use pa_types::session::{AgentMessage, CustomMessage, FileEntry};
use serde_json::json;

use super::AgentSession;
use crate::refinement::executor::{
    apply_refinement_plan, generate_refinement_id, parse_child_proposal, refinement_spawn_prompt,
    rollback_plan, RefineOptions as CoreRefineOptions, RefinementPlan, RefinementRequest,
};
use crate::refinement::{
    append_global_refinement, format_refinement_notice_body, load_global_refinement_history,
    load_harness_state, try_update_harness_state, HarnessScope, HarnessState, RefinementResult,
};
use crate::session::manager::SessionManager;

pub const REFINEMENT_AUDIT_CUSTOM_TYPE: &str = "prime-agent.refinement";
pub const REFINEMENT_OUTCOME_CUSTOM_TYPE: &str = "refinement_outcome";
/// Model-facing notice custom type (display=false).
pub const REFINEMENT_NOTICE_CUSTOM_TYPE: &str = "refinement_notice";

pub const AUTO_REFINE_COMPACT_REASON: &str = "compact";

/// The resolved auto-refine gates: the settings block with the product
/// defaults and clamps applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AutoRefineGates {
    pub enabled: bool,
    pub turn_interval: u64,
    pub compact: bool,
    pub cooldown_ms: u64,
}

impl Default for AutoRefineGates {
    fn default() -> Self {
        Self {
            enabled: true,
            turn_interval: 25,
            compact: true,
            cooldown_ms: 20 * 60 * 1000,
        }
    }
}

impl AutoRefineGates {
    /// The interval clamps to at least 1.
    #[must_use]
    pub fn from_settings(raw: Option<&crate::settings::AutoRefineSettings>) -> Self {
        let Some(raw) = raw else {
            return Self::default();
        };
        let defaults = Self::default();
        Self {
            enabled: raw.enabled.unwrap_or(defaults.enabled),
            turn_interval: raw.turn_interval.unwrap_or(defaults.turn_interval).max(1),
            compact: raw.compact.unwrap_or(defaults.compact),
            cooldown_ms: raw.cooldown_ms.unwrap_or(defaults.cooldown_ms),
        }
    }
}

/// The instructions the compact-trigger round carries into the refinement
/// child (the review gate is gone: the child's own empty-edits judgment is
/// the gate).
#[must_use]
pub fn auto_refine_instructions(reason: &str) -> String {
    format!(
        "Automatic refine review triggered by {reason}. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested."
    )
}

/// Who triggered a refinement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefinementSource {
    Auto,
    User,
    SelfRefine,
}

impl RefinementSource {
    fn as_str(self) -> &'static str {
        match self {
            RefinementSource::Auto => "auto",
            RefinementSource::User => "user",
            RefinementSource::SelfRefine => "self",
        }
    }
}

pub(crate) fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[must_use]
pub fn create_refinement_outcome_message(result: &RefinementResult) -> CustomMessage {
    let mut details = json!({
        "refinementId": result.id,
        "summary": result.summary,
        "scope": result.scope.unwrap_or(HarnessScope::Local),
        "edits": result.applied_edits,
    });
    if let (Some(rollback), Some(map)) = (result.rollback_of.clone(), details.as_object_mut()) {
        map.insert("rollbackOf".to_string(), json!(rollback));
    }
    CustomMessage {
        custom_type: REFINEMENT_OUTCOME_CUSTOM_TYPE.to_string(),
        content: UserContent::Text(format!("Refinement complete: {}", result.summary)),
        display: true,
        details: Some(details),
        timestamp: now_millis(),
        rest: serde_json::Map::default(),
    }
}

/// Model-facing notice (display=false).
#[must_use]
pub fn create_refinement_notice_message(
    result: &RefinementResult,
    source: RefinementSource,
) -> CustomMessage {
    let mut details = json!({
        "refinementId": result.id,
        "summary": result.summary,
        "scope": result.scope.unwrap_or(HarnessScope::Local),
        "edits": result.applied_edits,
        "source": source.as_str(),
    });
    if let (Some(rollback), Some(map)) = (result.rollback_of.clone(), details.as_object_mut()) {
        map.insert("rollbackOf".to_string(), json!(rollback));
    }
    CustomMessage {
        custom_type: REFINEMENT_NOTICE_CUSTOM_TYPE.to_string(),
        content: UserContent::Text(format!(
            "[{}-refinement]\n\n{}",
            source.as_str(),
            format_refinement_notice_body(result)
        )),
        display: false,
        details: Some(details),
        timestamp: now_millis(),
        rest: serde_json::Map::default(),
    }
}

/// This run's live-context rows (the outcome, plus the notice only when any
/// edit applied), selected BY ID so interleaved runs never select each other's rows.
pub(crate) fn context_rows_by_ids(entries: &[FileEntry], ids: &[String]) -> Vec<AgentMessage> {
    entries
        .iter()
        .filter_map(|entry| {
            let id = entry.id()?;
            ids.iter()
                .position(|wanted| wanted == id)
                .map(|_| match entry {
                    FileEntry::CustomMessage { payload, .. } => {
                        AgentMessage::Custom(crate::session::create_custom_message(payload, entry))
                    }
                    _ => unreachable!("refinement context rows are custom-message rows"),
                })
        })
        .collect()
}

/// Refinement history recorded in this session's JSONL entries.
#[must_use]
pub fn session_refinement_history(entries: &[FileEntry]) -> Vec<RefinementResult> {
    entries
        .iter()
        .filter_map(|entry| match entry {
            FileEntry::Custom { payload, .. }
                if payload.custom_type == REFINEMENT_AUDIT_CUSTOM_TYPE =>
            {
                payload
                    .data
                    .as_ref()
                    .and_then(|data| serde_json::from_value::<RefinementResult>(data.clone()).ok())
            }
            _ => None,
        })
        .collect()
}

/// Merged cross-session + in-session refinement history.
#[must_use]
pub fn load_refinement_history(
    session: &SessionManager,
    global_harness_dir: &Path,
) -> Vec<RefinementResult> {
    let global = load_global_refinement_history(global_harness_dir);
    let session_entries = session.refinement_history();
    crate::refinement::merge_refinement_history(&global, &session_entries)
}

/// The session's local harness state directory (under the session dir).
///
/// # Panics
///
/// The `expect` cannot fire: the mapping is total for `Some` session dirs.
#[must_use]
pub fn local_harness_state_dir(session: &SessionManager) -> PathBuf {
    let session_dir = session.get_session_dir().to_path_buf();
    crate::refinement::get_local_harness_state_dir(Some(&session_dir))
        .expect("session dir always yields a local harness dir")
}

/// Strip display-only `local:`/`global:` prefixes from edit ids.
fn strip_display_prefixes(plan: RefinementPlan) -> RefinementPlan {
    let mut plan = plan;
    for edit in &mut plan.proposal.edits {
        if let Some(id) = &edit.id {
            if let Some(stripped) = id
                .strip_prefix("local:")
                .or_else(|| id.strip_prefix("global:"))
            {
                edit.id = Some(stripped.to_string());
            }
        }
    }
    plan
}

/// `/refine` request options (session layer).
#[derive(Debug, Default, Clone)]
pub struct RefineOptions {
    pub global: bool,
    pub instructions: Option<String>,
    pub rollback_id: Option<String>,
}

/// The refinement the parent prepared for one child: everything captured
/// before the child's model pass, plus the paths the wake-side apply
/// resolves its fresh state reads against.
#[derive(Debug, Clone)]
pub struct PreparedRefinement {
    pub options: RefineOptions,
    /// The store this refinement applies to (the rollback may retarget it).
    pub requested_scope: HarnessScope,
    /// The harness state as observed at preparation time — the baseline the
    /// apply's stale check compares the freshly re-read state against, so
    /// concurrent kernel writes reject instead of clobber.
    pub baseline_state: HarnessState,
    /// The refinement id the applied result carries (minted before the
    /// child, so history and rows agree).
    pub id: String,
}

impl AgentSession {
    /// Prepare one refinement for the child: the gate check, the
    /// local-store requirement, the trimmed conversation, and the baseline
    /// capture. The child reads the harness state itself through the paths
    /// the request carries — no snapshot rides the prompt.
    ///
    /// # Errors
    ///
    /// Returns an error when refinements are disabled in /settings, when a
    /// local refinement is requested on an unpersisted session, or when
    /// the transcript cannot be read.
    pub async fn prepare_refinement(
        &self,
        options: &RefineOptions,
        model: &pa_types::ai::Model,
        global_harness_dir: &Path,
    ) -> anyhow::Result<(PreparedRefinement, String)> {
        anyhow::ensure!(
            self.harness_refinements_enabled(),
            "Harness refinements are disabled in /settings"
        );
        let requested_scope = if options.global {
            HarnessScope::Global
        } else {
            HarnessScope::Local
        };
        // A local refinement needs the session's own directory: its harness
        // state and artifact paths live there. The daemon's engine session
        // is deliberately non-persisted but carries the session's directory,
        // so local refinement runs.
        anyhow::ensure!(
            options.global || self.session.lock().await.has_session_dir(),
            "Local harness refinement requires a session directory; use global refinement instead."
        );
        // The transcript's conversation is extracted under this first lock
        // straight from the retained rows; the child runs without the lock.
        let parts = self.session.lock().await.refine_transcript_parts();
        let crate::session::manager::RefineTranscriptParts {
            messages,
            refinement_history: _,
        } = parts.await?;
        let conversation =
            crate::session_engine::compaction_utils::serialize_conversation(&messages);
        let (local_harness_dir, parent_session_file) = {
            let session = self.session.lock().await;
            (
                local_harness_state_dir(&session),
                session
                    .get_session_file()
                    .map(|path| path.display().to_string()),
            )
        };
        // The baseline captured now — before the child's model pass, which
        // can take many seconds — so concurrent kernel writes to the store
        // are rejected at apply time instead of clobbered.
        let baseline_dir = match requested_scope {
            HarnessScope::Global => global_harness_dir.to_path_buf(),
            HarnessScope::Local => local_harness_dir.clone(),
        };
        let baseline_state = load_harness_state(&baseline_dir, requested_scope);
        let request = RefinementRequest {
            global: options.global,
            instructions: options.instructions.clone(),
            local_harness_dir: (!options.global).then(|| local_harness_dir.display().to_string()),
            global_harness_dir: global_harness_dir.display().to_string(),
            parent_session_file,
        };
        let prompt = refinement_spawn_prompt(&request, model.context_window, &conversation);
        let prepared = PreparedRefinement {
            options: options.clone(),
            requested_scope,
            baseline_state,
            id: generate_refinement_id(),
        };
        Ok((prepared, prompt))
    }

    /// Apply the refinement child's proposal on the wake: parse the reply,
    /// re-read the target store FRESH, apply through the stale-baseline
    /// contract, and push this run's rows onto the live context.
    ///
    /// # Errors
    ///
    /// Returns an error when the proposal does not parse, when applying
    /// fails (including a stale baseline and a mid-flight disable), or
    /// when the durable rows fail to persist.
    pub async fn apply_child_refinement(
        &self,
        prepared: PreparedRefinement,
        reply: &str,
        source: RefinementSource,
        global_harness_dir: &Path,
    ) -> anyhow::Result<RefinementResult> {
        let proposal = parse_child_proposal(reply)?;
        let plan = RefinementPlan {
            proposal,
            id: prepared.id.clone(),
            rollback_of: None,
            rollback_scope: None,
        };
        self.apply_prepared_refinement(plan, prepared, source, global_harness_dir)
            .await
    }

    /// Run the mechanical rollback inline (no child, no model pass): the
    /// plan inverts the target refinement's applied edits.
    ///
    /// # Errors
    ///
    /// Returns an error when the rollback id is absent (the planning
    /// refinement is the refinement child's), when the rollback id is
    /// unknown, or when the apply or persist fails.
    pub async fn run_rollback_refinement(
        &self,
        options: &RefineOptions,
        source: RefinementSource,
        global_harness_dir: &Path,
    ) -> anyhow::Result<RefinementResult> {
        anyhow::ensure!(
            self.harness_refinements_enabled(),
            "Harness refinements are disabled in /settings"
        );
        let history = {
            let session = self.session.lock().await;
            load_refinement_history(&session, global_harness_dir)
        };
        let core_options = CoreRefineOptions {
            global: options.global,
            instructions: options.instructions.clone(),
            rollback_id: options.rollback_id.clone(),
        };
        let Some(plan) = rollback_plan(&history, &core_options)? else {
            anyhow::bail!("the mechanical rollback requires a rollbackId; every planning refinement is the refinement child's");
        };
        let target_scope = plan.rollback_scope.unwrap_or(if options.global {
            HarnessScope::Global
        } else {
            HarnessScope::Local
        });
        let baseline_dir = match target_scope {
            HarnessScope::Global => global_harness_dir.to_path_buf(),
            HarnessScope::Local => local_harness_state_dir(&*self.session.lock().await),
        };
        let baseline_state = load_harness_state(&baseline_dir, target_scope);
        let prepared = PreparedRefinement {
            options: options.clone(),
            requested_scope: if options.global {
                HarnessScope::Global
            } else {
                HarnessScope::Local
            },
            baseline_state,
            id: plan.id.clone(),
        };
        self.apply_prepared_refinement(plan, prepared, source, global_harness_dir)
            .await
    }

    /// The apply core: the compaction flight, the fresh re-read, the
    /// factory gate, the stale-baseline apply, and the durable rows, with
    /// this run's live-context rows pushed under one agent-state lock.
    ///
    /// # Errors
    ///
    /// Returns the apply or persist error.
    async fn apply_prepared_refinement(
        &self,
        plan: RefinementPlan,
        prepared: PreparedRefinement,
        source: RefinementSource,
        global_harness_dir: &Path,
    ) -> anyhow::Result<RefinementResult> {
        // The flight serializes every live-context replacer against a
        // compaction's rebuild: this run's outcome rows persist and then
        // push onto the context the compaction replaces, so the push must
        // not interleave with a replace.
        let _flight = self.compaction_flight.lock().await;
        let PreparedRefinement {
            options,
            requested_scope,
            baseline_state,
            id: _,
        } = prepared;
        let core_options = CoreRefineOptions {
            global: options.global,
            instructions: options.instructions.clone(),
            rollback_id: options.rollback_id.clone(),
        };
        let plan = strip_display_prefixes(plan);
        let target_scope = plan.rollback_scope.unwrap_or(requested_scope);
        let target_dir = match target_scope {
            HarnessScope::Global => global_harness_dir.to_path_buf(),
            HarnessScope::Local => local_harness_state_dir(&*self.session.lock().await),
        };
        // The apply's gates re-read their settings live inside the update
        // (the settings manager reopens), and the factory opt-in resolves
        // HERE — immediately before the apply — so a setting that changed
        // during the child's pass decides, never a snapshot captured before
        // it. Both reads ride `spawn_blocking`; a session without a wired
        // agent dir keeps the fail-closed disabled default.
        let agent_dir = self.agent_dir.clone();
        let cwd = self.session.lock().await.get_cwd().to_path_buf();
        let (mut result, state_path) = tokio::task::spawn_blocking(move || {
            let settings = agent_dir
                .as_deref()
                .map(|dir| crate::settings::SettingsManager::create(&cwd, dir));
            try_update_harness_state(&target_dir, target_scope, |state| {
                anyhow::ensure!(
                    super::refinement_gate::enabled(settings.as_ref()),
                    "Harness refinements were disabled during planning; the result was discarded"
                );
                let factory_enabled = agent_dir
                    .as_deref()
                    .is_some_and(crate::refinement::factory_enabled);
                Ok(apply_refinement_plan(
                    state,
                    plan,
                    &core_options,
                    Some(baseline_state),
                    factory_enabled,
                ))
            })
        })
        .await
        .map_err(|error| anyhow::anyhow!("refinement harness update task failed: {error}"))??;
        result.harness_state_path = state_path.to_string_lossy().to_string();
        if target_scope == HarnessScope::Global {
            append_global_refinement(global_harness_dir, &result)?;
        }
        // The audit append is attempted first; a failed write is caught (the row
        // stays live-indexed) and the audit error surfaces only after the outcome
        // records — the user's view and the durable stores do not diverge.
        let mut session = self.session.lock().await;
        let (_, audit_write) = session.append_custom_entry_retained(
            REFINEMENT_AUDIT_CUSTOM_TYPE,
            Some(serde_json::to_value(&result)?),
        );
        // Outcome for the TUI; notice for the model (only when edits applied).
        let outcome = create_refinement_outcome_message(&result);
        let (outcome_id, outcome_write) = session.append_custom_message_retained(
            &outcome.custom_type,
            outcome.content.clone(),
            outcome.display,
            outcome.details.clone(),
        );
        let mut context_row_ids = vec![outcome_id];
        if let Some(error) = audit_write {
            anyhow::bail!("refinement audit row not persisted: {error}");
        }
        if let Some(error) = outcome_write {
            anyhow::bail!("refinement outcome row not persisted: {error}");
        }
        if result.applied_edits.iter().any(|edit| edit.applied) {
            let notice = create_refinement_notice_message(&result, source);
            let notice_id = session.append_custom_message(
                &notice.custom_type,
                notice.content.clone(),
                notice.display,
                notice.details.clone(),
            )?;
            context_row_ids.push(notice_id);
        }
        // This run's rows push onto the live context after the durable
        // append, never a full rebuild — a rebuild would resurrect a
        // retried turn's dropped trailing assistant. The pushed rows are
        // THIS run's, under ONE agent-state lock.
        let rows = context_rows_by_ids(session.retained_entries(), &context_row_ids);
        let loop_rows: Vec<pa_agent::types::AgentMessage> = rows
            .iter()
            .filter_map(super::session_message_to_loop)
            .collect();
        if !loop_rows.is_empty() {
            self.agent.append_messages(loop_rows).await;
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refinement::HarnessScope;

    #[test]
    fn refinement_messages_match_wire_shape() {
        let result = RefinementResult {
            id: "refine_1".to_string(),
            summary: "add memory".to_string(),
            rationale: "seen twice".to_string(),
            expected_outcome: "recall".to_string(),
            applied_edits: vec![],
            harness_state_path: String::new(),
            rollback_of: None,
            scope: Some(HarnessScope::Local),
        };
        let outcome = create_refinement_outcome_message(&result);
        assert_eq!(outcome.custom_type, "refinement_outcome");
        assert_eq!(
            outcome.content,
            UserContent::Text("Refinement complete: add memory".to_string())
        );
        assert!(outcome.display);
        let notice = create_refinement_notice_message(&result, RefinementSource::User);
        assert_eq!(notice.custom_type, "refinement_notice");
        assert!(!notice.display);
        assert_eq!(
            notice.content,
            UserContent::Text("[user-refinement]\n\nadd memory".to_string())
        );
    }

    #[test]
    fn auto_refine_gates_resolve_the_ts_defaults_and_clamps() {
        assert_eq!(
            AutoRefineGates::from_settings(None),
            AutoRefineGates {
                enabled: true,
                turn_interval: 25,
                compact: true,
                cooldown_ms: 20 * 60 * 1000,
            }
        );
        let raw = crate::settings::AutoRefineSettings {
            enabled: Some(false),
            turn_interval: Some(0),
            compact: Some(false),
            cooldown_ms: Some(5),
        };
        assert_eq!(
            AutoRefineGates::from_settings(Some(&raw)),
            AutoRefineGates {
                enabled: false,
                turn_interval: 1,
                compact: false,
                cooldown_ms: 5,
            }
        );
    }

    #[test]
    fn auto_refine_instructions_compose_the_ts_text() {
        assert_eq!(
            auto_refine_instructions("compact"),
            "Automatic refine review triggered by compact. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested."
        );
    }
}
