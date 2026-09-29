//! Session-level /refine: message builders, history merge, and the
//! plan -> re-read -> apply -> persist flow. Port of the refine plumbing in
//! core/agent-session.ts (_planRefine/_applyRefine) plus the message builders
//! in core/messages.ts.

use std::path::{Path, PathBuf};

use pa_types::ai::{UserContent, UserMessage};
use pa_types::session::{AgentMessage, CustomMessage, FileEntry};
use serde_json::json;

use super::AgentSession;
use crate::refinement::executor::{
    apply_refinement_plan, plan_refinement, review_auto_refine, AutoRefineReview,
    AutoRefineReviewContext, RefineOptions as CoreRefineOptions, RefinementPlan,
};
use crate::refinement::{
    append_global_refinement, format_refinement_notice_body, load_global_refinement_history,
    load_harness_state, merge_harness_states, save_harness_state, HarnessScope, RefinementResult,
};
use crate::session::manager::SessionManager;

/// Audit entry type recording each applied refinement in the session JSONL.
pub const REFINEMENT_AUDIT_CUSTOM_TYPE: &str = "prime-agent.refinement";
/// TUI-rendered outcome message custom type.
pub const REFINEMENT_OUTCOME_CUSTOM_TYPE: &str = "refinement_outcome";
/// Model-facing notice custom type (display=false; passes convertToLlm).
pub const REFINEMENT_NOTICE_CUSTOM_TYPE: &str = "refinement_notice";

/// The compact trigger's review-request reason (TS `AutoRefineReason`
/// `"compact"`): the label the review prompt's trigger line and the
/// auto-refine instructions carry.
pub const AUTO_REFINE_COMPACT_REASON: &str = "compact";

/// The resolved auto-refine gates (TS `settingsManager.getAutoRefineSettings`):
/// the settings file's `autoRefine` block with the product defaults and
/// clamps applied.
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
    /// Resolve the gates from the raw settings block (TS
    /// `getAutoRefineSettings`: `enabled`/`compact` default on, the turn
    /// interval clamps to at least 1 and defaults to 25, the cooldown
    /// clamps to at least 0 and defaults to 20 minutes).
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

/// The instructions an approved auto-refine review carries into the
/// refinement run (TS `autoRefineInstructions`).
#[must_use]
pub fn auto_refine_instructions(reason: &str, review: &AutoRefineReview) -> String {
    let detail = review
        .instructions
        .as_deref()
        .map(|instructions| {
            format!(
                "

Reviewer instructions: {instructions}"
            )
        })
        .unwrap_or_default();
    format!(
        "Automatic refine review triggered by {reason}. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: {}{detail}",
        review.rationale
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

/// TUI-rendered outcome message (`refinement_outcome`).
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

/// Model-facing notice (`refinement_notice`, display=false).
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

/// This run's live-context rows (TS `_appendDurableRefineMessage`: the
/// outcome row, and the notice row only when any edit applied; the audit
/// entry is durable-only and never enters the context), selected BY ID —
/// exactly the rows `execute_refinement_with_rows` appended, so
/// interleaved runs can never select each other's rows. Materialized from
/// the appended durable entries — the same reconstruction a context
/// rebuild performs — so the pushed rows are byte-identical to a
/// rebuild's rows for them.
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
/// The `expect` cannot fire: mapping the session dir onto the local harness
/// dir is total for `Some` session dirs.
#[must_use]
pub fn local_harness_state_dir(session: &SessionManager) -> PathBuf {
    let session_dir = session.get_session_dir().to_path_buf();
    crate::refinement::get_local_harness_state_dir(Some(&session_dir))
        .expect("session dir always yields a local harness dir")
}

/// Strip display-only `local:`/`global:` prefixes from proposal edit ids.
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

/// The transcript feeding the refinement planner: the conversation
/// messages plus the in-session refinement history (the audit scan's
/// output over the full entry sequence — the caller extracts both from
/// the session's retained rows or its historical read, so the
/// refinement never materializes an owned copy of every entry).
pub struct RefinementTranscript<'a> {
    pub messages: &'a [AgentMessage],
    pub refinement_history: &'a [crate::refinement::RefinementResult],
}

/// Run the full refinement flow: plan (LLM or rollback), re-read the target
/// store, apply, persist state + history, and append the audit, outcome, and
/// notice entries to the session. `refine_call` performs the model request.
///
/// # Errors
///
/// Returns an error when a local refinement is requested on an unpersisted
/// session, when the refinement plan (LLM or rollback) fails, when applying
/// or persisting the refined harness state fails, or when appending the
/// audit, outcome, or notice entries fails.
pub async fn execute_refinement(
    session: &mut SessionManager,
    transcript: RefinementTranscript<'_>,
    global_harness_dir: &Path,
    model: &pa_types::ai::Model,
    options: &RefineOptions,
    source: RefinementSource,
    refine_call: crate::refinement::executor::RefinerFn,
) -> anyhow::Result<RefinementResult> {
    Ok(execute_refinement_with_rows(
        session,
        transcript,
        global_harness_dir,
        model,
        options,
        source,
        refine_call,
    )
    .await?
    .0)
}

/// [`execute_refinement`] plus the ids of the live-context rows this run
/// appended (the outcome row, and the notice row when any edit applied):
/// the exact-row set the caller's live-context push materializes, so two
/// interleaved runs can never select each other's rows.
///
/// # Errors
///
/// Returns the same errors as [`execute_refinement`].
pub async fn execute_refinement_with_rows(
    session: &mut SessionManager,
    transcript: RefinementTranscript<'_>,
    global_harness_dir: &Path,
    model: &pa_types::ai::Model,
    options: &RefineOptions,
    source: RefinementSource,
    refine_call: crate::refinement::executor::RefinerFn,
) -> anyhow::Result<(RefinementResult, Vec<String>)> {
    let RefinementTranscript {
        messages,
        refinement_history,
    } = transcript;
    let local_harness_dir = local_harness_state_dir(session);
    let core_options = CoreRefineOptions {
        global: options.global,
        instructions: options.instructions.clone(),
        rollback_id: options.rollback_id.clone(),
    };
    let requested_scope = if options.global {
        HarnessScope::Global
    } else {
        HarnessScope::Local
    };
    // A local refinement needs the session's own directory: its harness
    // state and artifact paths live there. The daemon's engine session is
    // deliberately non-persisted (the worker owns the durable file and
    // mirrors the entries) but carries the session's directory, so local
    // refinement runs; a bare in-memory session with no directory of its
    // own still bails.
    if options.rollback_id.is_none()
        && requested_scope == HarnessScope::Local
        && !session.has_session_dir()
    {
        anyhow::bail!(
            "Local harness refinement requires a session directory; use global refinement instead."
        );
    }
    // Planning state: global, or merged global+local for local refinements.
    let global_state = load_harness_state(global_harness_dir, HarnessScope::Global);
    let planning_state = if requested_scope == HarnessScope::Global {
        global_state.clone()
    } else {
        let local_state = load_harness_state(&local_harness_dir, HarnessScope::Local);
        merge_harness_states(&global_state, Some(&local_state))
    };
    let global = load_global_refinement_history(global_harness_dir);
    let history = crate::refinement::merge_refinement_history(&global, refinement_history);
    // Baseline captured before the (slow) LLM pass, so concurrent kernel
    // writes are rejected instead of clobbered.
    let baseline_scope = options
        .rollback_id
        .as_ref()
        .and_then(|id| history.iter().find(|item| &item.id == id))
        .and_then(crate::refinement::infer_refinement_result_scope)
        .unwrap_or(requested_scope);
    let baseline_dir = match baseline_scope {
        HarnessScope::Global => global_harness_dir.to_path_buf(),
        HarnessScope::Local => local_harness_dir.clone(),
    };
    let baseline_state = load_harness_state(&baseline_dir, baseline_scope);

    let mut plan = plan_refinement(
        messages,
        &planning_state,
        &history,
        model,
        &core_options,
        refine_call,
    )
    .await?;
    plan = strip_display_prefixes(plan);

    // Synchronous application phase: re-read the target store, apply, persist.
    let target_scope = plan.rollback_scope.unwrap_or(requested_scope);
    let target_dir = match target_scope {
        HarnessScope::Global => global_harness_dir.to_path_buf(),
        HarnessScope::Local => local_harness_dir.clone(),
    };
    let mut state = load_harness_state(&target_dir, target_scope);
    let mut result = apply_refinement_plan(&mut state, plan, &core_options, Some(baseline_state));
    result.harness_state_path = save_harness_state(&target_dir, &state)?
        .to_string_lossy()
        .to_string();
    if target_scope == HarnessScope::Global {
        append_global_refinement(global_harness_dir, &result)?;
    }
    // Session rows follow the TS refine arm's write choreography: the audit
    // append is attempted first and a failed write is caught (the row stays
    // live-indexed, so the in-process history sees the refinement), the
    // outcome row still records, and only then does the audit error surface
    // — the harness edits are already durable, and reporting the audit
    // failure after the outcome keeps the user's view and the durable stores
    // from diverging on the next retry.
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
    Ok((result, context_row_ids))
}

/// `/refine` request options (session layer).
#[derive(Debug, Default, Clone)]
pub struct RefineOptions {
    pub global: bool,
    pub instructions: Option<String>,
    pub rollback_id: Option<String>,
}

/// The compact-trigger round's resolution (TS `_maybeAutoRefine`'s arms):
/// the reviewer's decline, the retention of an approving review behind an
/// active agent turn, or the ran refinement.
pub(crate) enum AutoRefineRound {
    /// The reviewer declined (or the round resolved against a bumped
    /// branch version): no refinement ran. The caller stamps the review
    /// cooldown for a fresh round (TS's decline arm).
    Declined,
    /// The review approved while an agent turn was streaming: the
    /// refinement run (its session-mutex hold and the live-context
    /// rebuild) never runs mid-stream. The review is retained and the
    /// next serviced boundary runs it (TS `_pendingAutoRefineReview`).
    Deferred(AutoRefineReview),
    /// The refinement ran (TS `_runApprovedRefine`'s success arm).
    Ran(RefinementResult),
}

impl AgentSession {
    /// The compact-trigger review (TS `_reviewAutoRefine`'s compact
    /// round): the review gate first — an LLM call over the
    /// conversation, the merged harness state, and the refinement
    /// history — then the decline and the branch-version fence. `Ok(None)`
    /// is the decline (or a round resolved against a bumped branch
    /// version); `Ok(Some(review))` is a fresh approval the caller's arm
    /// applies.
    ///
    /// # Errors
    ///
    /// Returns an error when the conversation history cannot be read or
    /// when the review request fails; a decline is `Ok(None)`.
    pub async fn review_compact_auto_refine(
        &self,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        global_harness_dir: &Path,
        turns_since_last_review: u32,
        branch_version: u64,
    ) -> anyhow::Result<Option<AutoRefineReview>> {
        // The review reads the same planning inputs the refinement run
        // plans against (TS `_reviewAutoRefine`: the live conversation,
        // `_loadMergedHarnessState`, `_loadRefinementHistory`). The
        // transcript's consumed artifacts are extracted under this lock
        // straight from the retained rows (no owned copy of the full
        // entry set); a boundary window's historical read runs after the
        // release, like the refinement run's.
        let (parts, merged_state, history) = {
            let session = self.session_handle().lock().await;
            let local_state =
                load_harness_state(&local_harness_state_dir(&session), HarnessScope::Local);
            let global_state = load_harness_state(global_harness_dir, HarnessScope::Global);
            (
                session.refine_transcript_parts(),
                merge_harness_states(&global_state, Some(&local_state)),
                load_global_refinement_history(global_harness_dir),
            )
        };
        // Refinement deliberately reviews historical messages, unlike ordinary
        // turns. Await the transcript parts after releasing the session mutex.
        let crate::session::manager::RefineTranscriptParts {
            messages,
            refinement_history: session_history,
        } = parts.await?;
        let history = crate::refinement::merge_refinement_history(&history, &session_history);
        let review = review_auto_refine(
            &messages,
            &merged_state,
            &history,
            model,
            &AutoRefineReviewContext {
                reason: AUTO_REFINE_COMPACT_REASON.to_string(),
                turns_since_last_review,
            },
            default_refiner_call(api_key.clone()),
        )
        .await?;
        if !review.should_refine {
            return Ok(None);
        }
        // TS `_reviewAutoRefine`'s post-await branch check
        // (`branchVersion !== this._autoRefineBranchVersion`): a branch
        // move (or a replacement teardown's discard) bumped the version
        // while the review's model call was in flight — the approval
        // belongs to the abandoned conversation, so the refinement run
        // (its harness edits, audit rows, and message rebuilds) never
        // starts.
        if !self.compact_auto_refine_branch_version_unchanged(branch_version) {
            return Ok(None);
        }
        Ok(Some(review))
    }

    /// The serialized arm's compact-trigger round (TS
    /// `_runSerializedAutoRefineReview` with `reason: "compact"`): the
    /// review, and only when the reviewer approves, the refinement run
    /// carrying the auto-refine instructions. `Ok(None)` is the
    /// reviewer's decline: no refinement ran and nothing surfaces. The
    /// serialized boundary is quiescent by construction (the serialized
    /// path drains at turn boundaries and never runs inside a tool
    /// loop), so this arm carries no active-agent gate; the interactive
    /// arm's gate lives in the session-side consumption instead. The
    /// caller stamps its review cooldown for every outcome (decline,
    /// success, and failure alike, the TS contract).
    ///
    /// # Errors
    ///
    /// Returns an error when the conversation history cannot be read, when
    /// the review request fails, or when the approving review's refinement
    /// run fails. A decline is `Ok(None)`.
    pub async fn auto_refine_after_compaction(
        &self,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        global_harness_dir: std::path::PathBuf,
        turns_since_last_review: u32,
        branch_version: u64,
    ) -> anyhow::Result<Option<RefinementResult>> {
        let Some(review) = self
            .review_compact_auto_refine(
                model,
                api_key.clone(),
                &global_harness_dir,
                turns_since_last_review,
                branch_version,
            )
            .await?
        else {
            return Ok(None);
        };
        Ok(Some(
            self.run_approved_refine(&review, model, api_key, global_harness_dir)
                .await?,
        ))
    }

    /// The approved review's refinement run (TS `_runApprovedRefine`):
    /// the retained-review path and a fresh approval share it — the
    /// auto-refine instructions built from the review, then the one
    /// refinement run whose result consumes the review.
    pub(crate) async fn run_approved_refine(
        &self,
        review: &AutoRefineReview,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        global_harness_dir: std::path::PathBuf,
    ) -> anyhow::Result<RefinementResult> {
        let options = RefineOptions {
            global: false,
            instructions: Some(auto_refine_instructions(AUTO_REFINE_COMPACT_REASON, review)),
            rollback_id: None,
        };
        self.refine(
            &options,
            RefinementSource::Auto,
            model,
            api_key,
            global_harness_dir,
        )
        .await
    }
}

/// The default model seam over pa-ai completion.
#[must_use]
pub fn default_refiner_call(api_key: Option<String>) -> crate::refinement::executor::RefinerFn {
    Box::new(move |model, system_prompt, prompt| {
        let api_key = api_key;
        Box::pin(async move {
            let context = pa_types::ai::Context {
                system_prompt: Some(system_prompt.to_string()),
                messages: vec![pa_types::ai::Message::User(UserMessage {
                    content: UserContent::Text(prompt),
                    timestamp: 0,
                    rest: serde_json::Map::default(),
                })],
                tools: None,
            };
            let stream_options =
                pa_ai::types::SimpleStreamOptions::from_base(pa_ai::types::StreamOptions {
                    api_key,
                    ..Default::default()
                });
            Ok(pa_ai::complete_simple(&model, &context, Some(stream_options)).await?)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refinement::executor::RefinerFn;
    use pa_types::ai::{AssistantContentBlock, AssistantMessage, Model, StopReason, TextContent};
    use tempfile::TempDir;

    fn text_assistant(text: &str) -> AssistantMessage {
        AssistantMessage {
            content: vec![AssistantContentBlock::Text(TextContent {
                text: text.to_string(),
                text_signature: None,
                rest: serde_json::Map::default(),
            })],
            api: "openai-completions".to_string(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        }
    }

    fn seam(text: &str) -> RefinerFn {
        let text = text.to_string();
        Box::new(move |_model, _system, _prompt| {
            let text = text;
            Box::pin(async move { Ok(text_assistant(&text)) })
        })
    }

    fn test_model() -> Model {
        Model {
            id: "test".to_string(),
            name: "test".to_string(),
            api: "openai-completions".to_string(),
            provider: "test".to_string(),
            base_url: "https://example.invalid".to_string(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![],
            cost: pa_types::ai::ModelCost {
                input: 0.0.into(),
                output: 0.0.into(),
                cache_read: 0.0.into(),
                cache_write: 0.0.into(),
            },
            context_window: 100_000,
            max_tokens: 8_000,
            featured: None,
            headers: None,
            compat: None,
        }
    }

    fn persisted_session(dir: &TempDir) -> SessionManager {
        let session_dir = dir.path().join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut session = SessionManager::in_memory(dir.path());
        session.materialize_session_file(Some(session_dir));
        session
    }

    fn user_message(text: &str) -> AgentMessage {
        AgentMessage::User(UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    }

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
        // Absent block: the product defaults.
        assert_eq!(
            AutoRefineGates::from_settings(None),
            AutoRefineGates {
                enabled: true,
                turn_interval: 25,
                compact: true,
                cooldown_ms: 20 * 60 * 1000,
            }
        );
        // Partial block: the declared values win; the interval clamps to
        // at least 1 (TS `Math.max(1, ...)`).
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
        let review = AutoRefineReview {
            should_refine: true,
            rationale: "reusable tactic".to_string(),
            instructions: Some("record it".to_string()),
        };
        assert_eq!(
            auto_refine_instructions("compact", &review),
            "Automatic refine review triggered by compact. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: reusable tactic

Reviewer instructions: record it"
        );
        let bare = AutoRefineReview {
            should_refine: true,
            rationale: "reusable tactic".to_string(),
            instructions: None,
        };
        assert_eq!(
            auto_refine_instructions("compact", &bare),
            "Automatic refine review triggered by compact. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: reusable tactic"
        );
    }

    #[tokio::test]
    async fn execute_refinement_persists_state_and_entries() {
        let dir = TempDir::new().unwrap();
        let mut session = persisted_session(&dir);
        session
            .append_message(user_message("do a thing twice"))
            .unwrap();
        let global_dir = dir.path().join("harness");
        let reply = r#"{"summary":"note it","rationale":"repeated","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#;
        let result = execute_refinement(
            &mut session,
            RefinementTranscript {
                messages: &[user_message("do a thing twice")],
                refinement_history: &[],
            },
            &global_dir,
            &test_model(),
            &RefineOptions::default(),
            RefinementSource::User,
            seam(reply),
        )
        .await
        .unwrap();
        assert_eq!(result.applied_edits.len(), 1);
        assert!(result.applied_edits[0].applied);
        // State written to the session-local harness store.
        let state_path = Path::new(&result.harness_state_path);
        assert!(state_path.exists());
        let harness_dir =
            crate::refinement::get_local_harness_state_dir(Some(session.get_session_dir()))
                .unwrap();
        let state = load_harness_state(&harness_dir, HarnessScope::Local);
        assert!(state.entries[&crate::refinement::RefinementKind::Memory].contains_key("m1"));
        // Audit + outcome + notice entries appended.
        let entries = session.get_all_entries().to_vec();
        assert_eq!(session_refinement_history(&entries).len(), 1);
        let custom_messages: Vec<&FileEntry> = entries
            .iter()
            .filter(|entry| {
                matches!(entry, FileEntry::CustomMessage { payload, .. }
                    if payload.custom_type == REFINEMENT_OUTCOME_CUSTOM_TYPE
                        || payload.custom_type == REFINEMENT_NOTICE_CUSTOM_TYPE)
            })
            .collect();
        assert_eq!(custom_messages.len(), 2);
        // History merges session results for the next refinement.
        assert_eq!(load_refinement_history(&session, &global_dir).len(), 1);
    }

    /// A failed audit write still reports the refinement error after the
    /// durable writes (the TS refine arm's catch/rethrow choreography), and
    /// the failed rows stay live-indexed so the in-process history sees the
    /// refinement that the harness store already applied.
    #[tokio::test]
    async fn audit_write_failure_reports_after_durable_edits() {
        let dir = TempDir::new().unwrap();
        let mut session = persisted_session(&dir);
        // Bootstrap the flush rule: rows only persist after the first
        // assistant entry (persist_entry defers them until then).
        session
            .append_message(AgentMessage::Assistant(text_assistant("seed")))
            .unwrap();
        let global_dir = dir.path().join("harness");
        let reply = r#"{"summary":"lesson","edits":[{"action":"create","kind":"memory","id":"m9","title":"Lesson","content":"durable"}]}"#;
        // Fail every session-file write: the path becomes a directory (the
        // harness stores live under a sibling dir and stay writable).
        let file = session.get_session_file().unwrap().to_path_buf();
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        let error = execute_refinement(
            &mut session,
            RefinementTranscript {
                messages: &[user_message("x")],
                refinement_history: &[],
            },
            &global_dir,
            &test_model(),
            &RefineOptions::default(),
            RefinementSource::User,
            seam(reply),
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("audit row not persisted"),
            "the audit error surfaces after the durable writes: {error:#}"
        );
        // The harness edits are durable.
        let harness_dir =
            crate::refinement::get_local_harness_state_dir(Some(session.get_session_dir()))
                .unwrap();
        let state = load_harness_state(&harness_dir, HarnessScope::Local);
        assert!(state.entries[&crate::refinement::RefinementKind::Memory].contains_key("m9"));
        // The audit + outcome rows stay live-indexed for the in-process
        // history; the notice is ordered after the audit rethrow in TS.
        let entries = session.get_all_entries().to_vec();
        assert_eq!(session_refinement_history(&entries).len(), 1);
        assert!(
            !entries.iter().any(
                |entry| matches!(entry, FileEntry::CustomMessage { payload, .. }
                    if payload.custom_type == REFINEMENT_NOTICE_CUSTOM_TYPE)
            ),
            "the notice is ordered after the audit rethrow in TS"
        );
    }

    fn oracle_fixture() -> String {
        let mut rows = vec![
            serde_json::json!({"type":"session","id":"s","version":3,"cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}),
        ];
        let mut parent: Option<String> = None;
        for i in 0..5 {
            let id = format!("u{i}");
            rows.push(serde_json::json!({"type":"message","id":id.clone(),"parentId":parent,"message":{"role":"user","content":format!("hello {i}"),"timestamp":0}}));
            parent = Some(id);
        }
        rows.push(serde_json::json!({"type":"custom","id":"audit","parentId":parent,"customType":"prime-agent.refinement","data":{"id":"refine_0","summary":"seed","rationale":"seeded rationale","expectedOutcome":"seeded outcome","appliedEdits":[],"harnessStatePath":""}}));
        rows.into_iter().map(|row| row.to_string() + "\n").collect()
    }

    /// One captured refiner request (the seam's view of the model inputs).
    #[derive(Debug, Clone, PartialEq)]
    struct CapturedRequest {
        max_tokens: u64,
        system: &'static str,
        user: String,
    }

    /// The frozen surface is the refine model's exact request. The same
    /// fixture session must yield a byte-identical `(max_tokens, system,
    /// user prompt)` whether the transcript served from the retained
    /// rows of a full reader (the RPC/CLI path), a full-history window
    /// under the sole runtime lease (the shared-window path — the file
    /// is deleted first so a hidden fallback to the historical read
    /// would fail: the served-path proof), or the unleased historical
    /// read (the gate closed). A fourth leg proves the read leg really
    /// reads: an out-of-band audit row appended to the file must reach
    /// the prompt.
    #[tokio::test]
    async fn refine_request_is_identical_across_extraction_paths() {
        use std::io::Write as _;
        let body = oracle_fixture();
        let mut captured: Vec<CapturedRequest> = Vec::new();
        for leg in ["full-reader", "windowed-leased", "windowed-unleased"] {
            let dir = TempDir::new().unwrap();
            let path = dir.path().join("session.jsonl");
            std::fs::write(&path, &body).unwrap();
            let mut session = if leg == "full-reader" {
                SessionManager::open(dir.path(), dir.path(), &path)
            } else {
                SessionManager::open_windowed(dir.path(), dir.path(), &path)
                    .await
                    .unwrap()
            };
            if leg == "windowed-leased" {
                session.set_append_ownership(
                    crate::session::window::AppendOwnership::SessionLeaseHeld,
                );
                // The served-path proof: the shared-window extraction
                // must not touch the file, so removing it cannot fail the
                // parts. The file returns before the refinement's rows
                // append to it.
                std::fs::remove_file(&path).unwrap();
                let probe = session.refine_transcript_parts();
                probe.await.unwrap();
                std::fs::write(&path, &body).unwrap();
            }
            let global_harness_dir = dir.path().join("harness");
            let parts = session.refine_transcript_parts();
            let crate::session::manager::RefineTranscriptParts {
                messages,
                refinement_history,
            } = parts.await.unwrap();
            let captured_requests: std::sync::Arc<std::sync::Mutex<Vec<CapturedRequest>>> =
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let sink = std::sync::Arc::clone(&captured_requests);
            let reply = r#"{"summary":"bench","edits":[]}"#.to_string();
            let result = execute_refinement(
                &mut session,
                RefinementTranscript {
                    messages: &messages,
                    refinement_history: &refinement_history,
                },
                &global_harness_dir,
                &test_model(),
                &RefineOptions::default(),
                RefinementSource::User,
                Box::new(move |model, system, prompt| {
                    sink.lock().unwrap().push(CapturedRequest {
                        max_tokens: model.max_tokens,
                        system,
                        user: prompt,
                    });
                    let reply = reply;
                    Box::pin(async move { Ok(text_assistant(&reply)) })
                }),
            )
            .await
            .unwrap_or_else(|error| panic!("'{leg}' leg failed: {error:#}"));
            assert!(result.applied_edits.is_empty());
            let got = captured_requests.lock().unwrap().clone();
            assert_eq!(got.len(), 1, "'{leg}' leg: exactly one refiner call");
            captured.push(got[0].clone());
        }
        for (a, b) in captured.iter().zip(captured.iter().skip(1)) {
            assert_eq!(
                a, b,
                "the refiner request diverged between extraction paths (the frozen surface)"
            );
        }
        // The seeded audit row and the fixture's conversation rode the
        // transcript on every path (history_for_prompt renders the audit
        // id and summary; conversation_text serializes the messages).
        assert!(
            captured[0].user.contains("[refine_0] seed"),
            "the fixture's audit history must appear in the prompt"
        );
        assert!(
            captured[0].user.contains("hello 4"),
            "the fixture's conversation must appear in the prompt"
        );

        // The read-leg proof: the unleased window's extraction must
        // serve an out-of-band audit row (the historical read), which
        // changes the prompt's history section.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, &body).unwrap();
        let session = SessionManager::open_windowed(dir.path(), dir.path(), &path)
            .await
            .unwrap();
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(
            br#"{"type":"custom","id":"oob-audit","parentId":"audit","customType":"prime-agent.refinement","data":{"id":"refine_oob","summary":"oob","rationale":"r","expectedOutcome":"o","appliedEdits":[],"harnessStatePath":""}}"#
        )
        .unwrap();
        file.write_all(b"\n").unwrap();
        drop(file);
        let parts = session.refine_transcript_parts();
        let crate::session::manager::RefineTranscriptParts {
            refinement_history, ..
        } = parts.await.unwrap();
        assert!(
            refinement_history
                .iter()
                .any(|item| item.id == "refine_oob"),
            "the unleased window must keep re-reading the file (out-of-band audit visible)"
        );
    }

    #[tokio::test]
    async fn global_refinement_appends_history() {
        let dir = TempDir::new().unwrap();
        let mut session = persisted_session(&dir);
        let global_dir = dir.path().join("harness");
        let reply = r#"{"summary":"global lesson","edits":[{"action":"create","kind":"memory","id":"g1","title":"Lesson","content":"durable"}]}"#;
        let result = execute_refinement(
            &mut session,
            RefinementTranscript {
                messages: &[user_message("x")],
                refinement_history: &[],
            },
            &global_dir,
            &test_model(),
            &RefineOptions {
                global: true,
                ..Default::default()
            },
            RefinementSource::SelfRefine,
            seam(reply),
        )
        .await
        .unwrap();
        assert_eq!(result.scope, Some(HarnessScope::Global));
        // Global refinements land in the global store and the cross-session log.
        let global_state = load_harness_state(&global_dir, HarnessScope::Global);
        assert!(
            global_state.entries[&crate::refinement::RefinementKind::Memory].contains_key("g1")
        );
        let history = load_global_refinement_history(&global_dir);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, result.id);
        // Rollback by id works through the merged history.
        let rolled = execute_refinement(
            &mut session,
            RefinementTranscript {
                messages: &[],
                refinement_history: &[],
            },
            &global_dir,
            &test_model(),
            &RefineOptions {
                global: true,
                rollback_id: Some(result.id.clone()),
                ..Default::default()
            },
            RefinementSource::User,
            seam("unused"),
        )
        .await
        .unwrap();
        assert_eq!(rolled.rollback_of.as_deref(), Some(result.id.as_str()));
        let global_state = load_harness_state(&global_dir, HarnessScope::Global);
        assert!(
            !global_state.entries[&crate::refinement::RefinementKind::Memory].contains_key("g1")
        );
    }
}
