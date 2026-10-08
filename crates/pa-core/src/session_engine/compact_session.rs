//! `/compact` execution: resolve the cut over session entries, run the
//! summarizer, persist the compaction entry, and rebuild the agent context.

use pa_types::session::{AgentMessage, FileEntry};

use super::compaction::{estimate_context_tokens, find_cut_point, CutPointResult};
use super::compaction_exec;
use super::compaction_exec::{
    build_summarization_request, build_turn_prefix_request, compaction_entry_for,
    complete_summary_call, details_for, file_ops_block, split_summary, summed_usage,
    CompactionDetails, CompactionResult, SummaryDeltaSink, SummarySlice, NO_PRIOR_HISTORY,
};
use super::compaction_utils;
use crate::session::manager::SessionManager;

// The bindings above re-anchor the child's `super::compaction_exec::` and
// `super::compaction_utils::` paths.
mod summarization;
pub(crate) use summarization::summarizer_request_tokens;
use summarization::{
    estimate_summary_request_tokens, history_summary_completion_budget,
    turn_prefix_summary_completion_budget,
};

mod recent_state_anchor;

// The re-exports keep every `compact_session::` path stable.
mod prepare;
pub use prepare::{compute_cut, prepare_compaction, CompactSkip, CompactionPreparation};

#[cfg(test)]
use super::{compaction, harness_digest, messages, session_message_to_loop};
#[cfg(test)]
mod tests;

pub struct CompactOptions<'a> {
    pub model: pa_types::ai::Model,
    /// Resolved API key (None falls back to provider env resolution).
    pub api_key: Option<String>,
    /// `/compact <instructions>` guidance.
    pub custom_instructions: Option<&'a str>,
    pub settings: super::compaction::CompactionSettings,
    /// Checked before the summarizer request and again before the commit — a
    /// late abort never lands a committed compaction; `None` without a trigger.
    pub abort: Option<&'a pa_agent::abort::AbortSignal>,
    /// The snapshot rides the durable row as `harnessDigest`; the disk read
    /// happens at the commit, so mid-run state is a fresh read.
    pub harness_digest: Option<super::harness_digest::HarnessDigestInputs>,
    /// When present, the summarizer calls resolve their model through the `auxiliaryModel`
    /// setting with a context-window fit check, falling back to the session model.
    pub auxiliary: Option<&'a super::auxiliary_model::AuxiliaryModelContext>,
    /// The history summarizer call streams its text deltas through it live,
    /// and the run flushes the parts the live stream cannot carry in order.
    pub summary_delta: Option<SummaryDeltaSink>,
    /// The session's semantic-edge recorder (TS `semanticCompaction` in
    /// `_performCompaction`): each summary wire call carries its own
    /// request id, and the compaction's terminal event lands before the
    /// compaction entry persists. `None` records nothing.
    pub semantic_edges: Option<std::sync::Arc<super::semantic_edges::SemanticEdgeRecorder>>,
}

/// The model-visible message produced by a session entry (summarizer input).
fn message_from_entry(entry: &FileEntry) -> Option<AgentMessage> {
    match entry {
        FileEntry::Message { message, .. } => match message {
            AgentMessage::ToolResult(_) => None,
            _ => Some(message.clone()),
        },
        FileEntry::CustomMessage { payload, .. } => {
            if payload.custom_type == "harness_digest" {
                return None;
            }
            Some(AgentMessage::Custom(pa_types::session::CustomMessage {
                custom_type: payload.custom_type.clone(),
                content: payload.content.clone(),
                display: payload.display,
                details: payload.details.clone(),
                timestamp: crate::session::timestamp_to_millis(entry.timestamp()),
                rest: serde_json::Map::default(),
            }))
        }
        FileEntry::BranchSummary { payload, .. } => Some(AgentMessage::BranchSummary(
            pa_types::session::BranchSummaryMessage {
                summary: payload.summary.clone(),
                from_id: payload.from_id.clone(),
                timestamp: crate::session::timestamp_to_millis(entry.timestamp()),
            },
        )),
        // Prior compactions are kept context, not summarizer input; the new
        // compaction covers their retained span.
        _ => None,
    }
}

/// The pre-compaction context estimate recorded as `tokensBefore`: the last
/// non-error/aborted assistant usage plus a chars/4 estimate of the messages
/// that trail it — error and aborted usage is not a real measurement.
fn context_tokens(entries: &[FileEntry], leaf_id: Option<&str>) -> u64 {
    let context = crate::session::build_session_context(entries, leaf_id);
    estimate_context_tokens(&context.messages).tokens
}

/// One completed compaction run: the result plus the entry to persist.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactRun {
    pub result: CompactionResult,
    pub entry: pa_types::session::CompactionEntry,
    /// The whole compaction's wall duration (the run's
    /// `compaction_duration_ms`).
    pub duration_ms: u64,
    /// The post-compaction `ipython_state` notice, when a kernel was running:
    /// the row is already durable and in the live context; surfaces broadcast it.
    pub ipython_state: Option<pa_types::session::CustomMessage>,
}

/// What `/compact` did. `Skipped` carries the skip message; the caller
/// treats a skip as a silent no-op.
#[derive(Debug, Clone, PartialEq)]
pub enum CompactOutcome {
    Ran(Box<CompactRun>),
    Skipped(&'static str),
}

pub(crate) struct CompactionAttempt {
    /// The session leaf at prepare: the commit is valid while the active
    /// branch still grows through it with no compaction between.
    prefix_leaf: Option<String>,
    cut: CutPointResult,
    previous_summary: Option<String>,
    recent_state_anchor: Option<String>,
    history: Vec<AgentMessage>,
    turn_prefix_messages: Vec<AgentMessage>,
    tokens_before: u64,
    details: CompactionDetails,
    first_kept_entry: String,
    semantic_compaction: Option<super::semantic_edges::SemanticCompaction>,
}

pub(crate) struct PreparedCompaction {
    pub(crate) result: CompactionResult,
    pub(crate) entry: pa_types::session::CompactionEntry,
}

/// PREPARE under the caller's session lock: resolve the cut, begin the
/// ledger guard, and record the leaf the commit's structural check walks
/// back to.
pub(crate) fn prepare_attempt(
    session: &SessionManager,
    options: &CompactOptions<'_>,
) -> Result<CompactionAttempt, CompactSkip> {
    let entries = session.retained_entries().to_vec();
    let prefix_leaf = session.get_leaf_id().map(str::to_string);
    let preparation = prepare_compaction(&entries, options.settings.keep_recent_tokens)?;
    // TS `beginCompaction` after the preparation resolved: a skipped
    // compaction makes no events (the begin comes after the skip throw).
    let semantic_compaction = options
        .semantic_edges
        .as_ref()
        .map(|recorder| recorder.begin_compaction(options.abort));
    let cut = preparation.cut;
    let previous_summary = preparation.previous_summary;
    let recent_state_anchor = preparation.recent_state_anchor;
    let first_kept_entry = entries
        .get(cut.first_kept_entry_index)
        .and_then(|entry| entry.id())
        .unwrap_or_default()
        .to_string();

    // The summarizer sees the conversation since the prior compaction's
    // retained boundary, plus the prefix of a split turn.
    let history_end = if cut.is_split_turn {
        cut.turn_start_index.unwrap_or(cut.first_kept_entry_index)
    } else {
        cut.first_kept_entry_index
    };
    let history: Vec<AgentMessage> = entries[preparation.boundary_start..history_end]
        .iter()
        .filter_map(message_from_entry)
        .collect();
    let turn_prefix_messages: Vec<AgentMessage> = entries[history_end..cut.first_kept_entry_index]
        .iter()
        .filter_map(message_from_entry)
        .collect();
    super::compaction_trace::trace(
        "compact.cut_prepared",
        &serde_json::json!({
            "entries": entries.len(),
            "firstKeptEntryIndex": cut.first_kept_entry_index,
            "isSplitTurn": cut.is_split_turn,
            "historyMessages": history.len(),
            "turnPrefixMessages": turn_prefix_messages.len(),
        }),
    );
    let tokens_before = context_tokens(&entries, session.get_leaf_id());
    super::compaction_trace::trace(
        "compact.tokens_before_computed",
        &serde_json::json!({ "tokensBefore": tokens_before }),
    );
    let prev_compaction_index = entries[..cut.first_kept_entry_index]
        .iter()
        .rposition(|entry| matches!(entry, FileEntry::Compaction { .. }));
    // A split turn's prefix file operations still belong in the summary
    // details.
    let mut file_op_messages = history.clone();
    file_op_messages.extend(turn_prefix_messages.iter().cloned());
    let details: CompactionDetails =
        details_for(&file_op_messages, &entries, prev_compaction_index);
    Ok(CompactionAttempt {
        prefix_leaf,
        cut,
        previous_summary,
        recent_state_anchor,
        history,
        turn_prefix_messages,
        tokens_before,
        details,
        first_kept_entry,
        semantic_compaction,
    })
}

/// SUMMARIZE: run the summarizer calls with no session lock held.
pub(crate) async fn summarize_attempt(
    attempt: &CompactionAttempt,
    options: &CompactOptions<'_>,
) -> anyhow::Result<PreparedCompaction> {
    // A run aborted before the summarizer request never starts one.
    pa_agent::abort::throw_if_aborted_signal(options.abort)?;

    // A split-turn cut runs TWO summarizer calls concurrently — the history
    // summary and the turn-prefix summary; a non-split cut makes the single
    // history call. A split with no summarizable history stands in "No prior history.".
    // The summary calls run with their own prompt prefix, so on the session model they
    // can never hit the cached prefix — route them to the auxiliary model when its window fits.
    let (model, api_key, summary_headers) = match options.auxiliary {
        Some(context) => {
            let required = estimate_summary_request_tokens(
                &attempt.history,
                &attempt.turn_prefix_messages,
                attempt.cut.is_split_turn,
                attempt.previous_summary.as_deref(),
                attempt.recent_state_anchor.as_deref(),
                options.custom_instructions,
                options.settings.reserve_tokens,
            );
            let join = {
                let context = context.clone();
                let session_model = options.model.clone();
                let session_api_key = options.api_key.clone();
                tokio::task::spawn_blocking(move || {
                    super::auxiliary_model::resolve_auxiliary_model(
                        &context,
                        "compaction summary",
                        &session_model,
                        session_api_key.as_deref(),
                        Some(required),
                    )
                })
            };
            // A JoinError (the closure panicked) degrades to the session
            // fallback, which keeps the merged headers.
            let routed = join.await.unwrap_or_else(|_| {
                super::auxiliary_model::session_fallback_with_headers(
                    context,
                    &options.model,
                    options.api_key.clone(),
                )
            });
            (routed.model, routed.api_key, routed.headers)
        }
        None => (options.model.clone(), options.api_key.clone(), None),
    };
    let history_max_tokens = history_summary_completion_budget(options.settings.reserve_tokens);
    let turn_prefix_max_tokens =
        turn_prefix_summary_completion_budget(options.settings.reserve_tokens);
    super::compaction_trace::trace(
        "compact.summarizer_request",
        &serde_json::json!({
            "historyMaxTokens": history_max_tokens,
            "turnPrefixMaxTokens": turn_prefix_max_tokens,
        }),
    );
    let history_call = async {
        // The stand-in applies only inside the split arm; a cut without
        // a turn prefix makes the history call below.
        if attempt.cut.is_split_turn
            && !attempt.turn_prefix_messages.is_empty()
            && attempt.history.is_empty()
        {
            // The literal stand-in rides the live sink too, exactly
            // like the committed summary.
            if let Some(sink) = options.summary_delta.as_ref() {
                sink(NO_PRIOR_HISTORY);
            }
            super::compaction_trace::trace(
                "compact.summarizer_no_history",
                &serde_json::Value::Null,
            );
            return Ok(SummarySlice {
                summary: NO_PRIOR_HISTORY.to_string(),
                usage: None,
            });
        }
        let request = build_summarization_request(
            &attempt.history,
            options.custom_instructions,
            attempt.previous_summary.as_deref(),
            attempt.recent_state_anchor.as_deref(),
            options.settings.reserve_tokens,
        );
        // Each summary wire call carries its own request id under the
        // compaction's guard (TS `summaryCall`): the id's headers merge
        // over the routed model's.
        super::semantic_edges::summary_slice_call(
            attempt.semantic_compaction.as_ref(),
            summary_headers.clone(),
            |headers| {
                complete_summary_call(
                    &model,
                    api_key.clone(),
                    headers,
                    history_max_tokens,
                    request,
                    options.summary_delta.clone(),
                    "Summarization failed",
                )
            },
        )
        .await
    };
    let turn_prefix_call = async {
        if !attempt.cut.is_split_turn || attempt.turn_prefix_messages.is_empty() {
            return Ok::<Option<SummarySlice>, anyhow::Error>(None);
        }
        let request = build_turn_prefix_request(&attempt.turn_prefix_messages);
        let slice = super::semantic_edges::summary_slice_call(
            attempt.semantic_compaction.as_ref(),
            summary_headers.clone(),
            |headers| {
                complete_summary_call(
                    &model,
                    api_key.clone(),
                    headers,
                    turn_prefix_max_tokens,
                    request,
                    // The turn-prefix call never streams live: the split join
                    // runs it concurrently with the history call, and its chunks
                    // interleaved into the live sink would land out of the
                    // final order (the committed summary is history, split
                    // marker, prefix). The completed prefix flushes through the
                    // sink after the join, so the live block converges to the
                    // exact committed summary.
                    None,
                    "Turn prefix summarization failed",
                )
            },
        )
        .await?;
        Ok(Some(slice))
    };
    let (history_slice, turn_prefix_slice) = tokio::join!(history_call, turn_prefix_call);
    let history_slice = history_slice?;
    let turn_prefix_slice = turn_prefix_slice?;
    super::compaction_trace::trace(
        "compact.summarizer_resolved",
        &serde_json::json!({
            "summaryBytes": history_slice.summary.len()
                + turn_prefix_slice
                    .as_ref()
                    .map_or(0, |slice| slice.summary.len()),
        }),
    );

    // The summarizer resolved while the run was aborted: the compaction
    // is cancelled before it commits.
    if options
        .abort
        .is_some_and(pa_agent::abort::AbortSignal::is_aborted)
    {
        return Err(pa_agent::abort::aborted_error());
    }

    // The live block converges to the exact committed summary: the split marker
    // with the completed turn-prefix summary and the file-operations suffix flush here.
    if let Some(sink) = options.summary_delta.as_ref() {
        let mut remainder = match &turn_prefix_slice {
            Some(prefix) => split_summary("", &prefix.summary),
            None => String::new(),
        };
        remainder.push_str(&file_ops_block(
            &attempt.details.read_files,
            &attempt.details.modified_files,
        ));
        if !remainder.is_empty() {
            sink(&remainder);
        }
    }
    // The split join carries the turn-prefix summary behind the history
    // summary; the file-operation block rides the summary on both paths.
    let mut summary = match &turn_prefix_slice {
        Some(prefix) => split_summary(&history_slice.summary, &prefix.summary),
        None => history_slice.summary.clone(),
    };
    summary.push_str(&file_ops_block(
        &attempt.details.read_files,
        &attempt.details.modified_files,
    ));
    let mut slices = vec![history_slice];
    if let Some(prefix) = turn_prefix_slice {
        slices.push(prefix);
    }
    let result = CompactionResult {
        summary,
        first_kept_entry_id: attempt.first_kept_entry.clone(),
        tokens_before: attempt.tokens_before,
        usage: summed_usage(&slices),
    };
    // The digest snapshot and its fingerprint attach at the commit and never flow
    // through the summarizer; the read happens after the summarizer resolved.
    let (harness_digest, harness_state_fingerprint) = options
        .harness_digest
        .as_ref()
        .map(|inputs| {
            let render =
                super::harness_digest::HarnessDigestInputs::render_with_fingerprint(inputs);
            (Some(render.digest), Some(render.state_fingerprint))
        })
        .unwrap_or_default();
    super::compaction_trace::trace(
        "compact.digest_rendered",
        &serde_json::json!({ "digest": harness_digest.is_some() }),
    );
    let entry = compaction_entry_for(
        &result,
        &attempt.details,
        options.custom_instructions,
        harness_digest,
        harness_state_fingerprint,
    );
    Ok(PreparedCompaction { result, entry })
}

/// COMMIT under the session lock: an aborted run never commits; the
/// prepared prefix still decides the commit's validity; the ledger settles
/// and the compaction row persists behind the mid-window tail.
/// `Ok(false)` is a structural conflict — the caller re-prepares.
///
/// # Errors
///
/// The abort marker, or the durable append's I/O error (main's
/// `append_entry` then pops only the compaction row; every acked row is
/// already durable).
pub(crate) fn commit_attempt(
    session: &mut SessionManager,
    attempt: &mut CompactionAttempt,
    prepared: &PreparedCompaction,
    abort: Option<&pa_agent::abort::AbortSignal>,
) -> anyhow::Result<bool> {
    pa_agent::abort::throw_if_aborted_signal(abort)?;
    if !session.compaction_prefix_intact(attempt.prefix_leaf.as_deref()) {
        return Ok(false);
    }
    // Ledger before effect (TS: `compactionRecorded` and the terminal
    // event land before `appendCompaction`): a failed persist still
    // leaves a completed compaction on the ledger, exactly like TS.
    if let Some(compaction) = attempt.semantic_compaction.as_mut() {
        compaction.commit();
    }
    // TS `appendCompaction` persists the full record: `details`,
    // `fromHook`, `customInstructions`, `usage`, and the `harnessDigest`
    // snapshot ride on the durable row alongside the summary, boundary,
    // and token count. The row's parent is the CURRENT leaf, so the
    // mid-window tail sits between `first_kept_entry` and the compaction
    // row and rides the retained tail.
    session.append_compaction(prepared.entry.clone())?;
    super::compaction_trace::trace(
        "compact.entry_appended",
        &serde_json::json!({
            "firstKeptEntryId": attempt.first_kept_entry,
            "persisted": session.is_persisted(),
        }),
    );
    Ok(true)
}

/// Rebuild the live agent context after compaction. Keep session-only roles
/// (especially the compaction boundary) until the provider conversion seam.
#[must_use]
pub fn rebuilt_context_after_compaction(session: &SessionManager) -> Vec<AgentMessage> {
    session.active_context().messages
}
