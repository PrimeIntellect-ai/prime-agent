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

// The summarization math (the two summary calls' completion budgets, the
// chars/4 request estimate, and the exact-request window estimator the
// auxiliary-model routing consults) moved to the child module; the module
// bindings above keep the child's `super::compaction_exec::` and
// `super::compaction_utils::` path literals resolving unchanged, and the
// re-exports keep the facade and `branch_summarization` caller paths stable.
mod summarization;
pub(crate) use summarization::summarizer_request_tokens;
use summarization::{
    estimate_summary_request_tokens, history_summary_completion_budget,
    turn_prefix_summary_completion_budget,
};

// The recent-state-anchor selection (the newest retained assistant text
// the history summary anchors on, with its tail-truncation bound) moved to
// the child module; the pub(super) bump serves its cross-module caller
// (prepare_compaction).
mod recent_state_anchor;

// The preparation (the skip guards, the prior-compaction boundary and
// previous-summary anchors, the cut resolution, and the session-cut test
// seam) moved to the child module; the pub use re-exports keep every
// compact_session:: path stable (turn_boundary, the facade's
// execute_compaction, and the tests glob).
mod prepare;
pub use prepare::{compute_cut, prepare_compaction, CompactSkip, CompactionPreparation};

// The test mass (the in-file unit battery) moved to the child module at
// the same tree position (compact_session::tests) and splits by test
// family under compact_session::tests; the moved blocks keep their
// `super` and `super::super` path literals, and these session_engine
// module bindings re-anchor those literals one level deeper (the same
// pattern the summarization bindings above serve for
// `super::compaction_exec::`).
#[cfg(test)]
use super::{compaction, harness_digest, messages, session_message_to_loop};
#[cfg(test)]
mod tests;

/// Options for `execute_compaction`.
pub struct CompactOptions<'a> {
    /// The model used for summarization.
    pub model: pa_types::ai::Model,
    /// Resolved API key (None falls back to provider env resolution).
    pub api_key: Option<String>,
    /// `/compact <instructions>` guidance.
    pub custom_instructions: Option<&'a str>,
    /// Compaction settings (reserve/keep budgets).
    pub settings: super::compaction::CompactionSettings,
    /// The run's abort signal (TS `AbortSignal` threaded through
    /// `_performCompaction` -> `compact`): checked before the summarizer
    /// request and again after it resolves, before the compaction commits —
    /// a late abort never lands a committed compaction. `None` for
    /// surfaces without an abort trigger (headless runs).
    pub abort: Option<&'a pa_agent::abort::AbortSignal>,
    /// Harness digest inputs captured from the live session (TS
    /// `_harnessDigest`): the snapshot rides the durable row as
    /// `harnessDigest`. The merged harness-state disk read happens at the
    /// commit, so state written mid-run is a fresh read. `None` for
    /// sessions without harness state (verification harnesses building
    /// the loop directly; the engine always wires one).
    pub harness_digest: Option<super::harness_digest::HarnessDigestInputs>,
    /// The auxiliary-model routing context (TS #2411): when present, the
    /// summarizer wire calls resolve their model through the
    /// `auxiliaryModel` setting with a context-window fit check, falling
    /// back to the caller's session model. `None` keeps the session model.
    pub auxiliary: Option<&'a super::auxiliary_model::AuxiliaryModelContext>,
    /// The live summary-delta sink ([`SummaryDeltaSink`]): the history
    /// summarizer call streams its text deltas through it live, in
    /// arrival order, and the run flushes the parts the live stream
    /// cannot carry in order — a split turn's marker with its completed
    /// turn-prefix summary (the concurrent call's raw chunks would
    /// interleave out of final order) and the file-operations suffix —
    /// so a client accumulating every delta holds exactly the summary
    /// the run commits (the daemon's `compaction_summary_delta`
    /// broadcast for the expanded TUI's live block). `None` keeps the
    /// one-shot completion — the summarizer call itself is identical
    /// either way; only the stream consumption differs.
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

/// The pre-compaction context estimate the compaction entry records as
/// `tokensBefore` (TS `prepareCompaction`:
/// `estimateContextTokens(buildSessionContext(pathEntries).messages)`): the
/// last non-error/aborted assistant usage — the probe-measured context of
/// the live provider — plus a chars/4 estimate of the messages that trail
/// it, or a full chars/4 estimate when no valid usage exists yet. Error
/// and aborted turns never anchor the estimate: their usage is not a real
/// measurement, and TS `getLastAssistantUsageInfo` skips them too.
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
    /// `compaction_duration_ms`; measured here once, centrally, for every
    /// arm).
    pub duration_ms: u64,
    /// The post-compaction `ipython_state` kernel-persistence notice, when a
    /// kernel was running (TS `_syncKernelStateAfterCompaction`): the row is
    /// already durable and in the live context; surfaces broadcast it as a
    /// `message_start`/`message_end` pair.
    pub ipython_state: Option<pa_types::session::CustomMessage>,
}

/// What `/compact` did. `Skipped` carries the TS `CompactionSkippedError`
/// message; the caller treats a skip as a silent no-op (TS
/// `_executeQueuedSessionCommand` returns without a result row).
#[derive(Debug, Clone, PartialEq)]
pub enum CompactOutcome {
    Ran(Box<CompactRun>),
    Skipped(&'static str),
}

/// Run compaction over the session: summarize the pre-cut prefix, persist the
/// entry, and return the rebuilt post-compaction context messages.
///
/// # Errors
///
/// Returns an error when the compaction preparation or the summarizer call
/// fails, or when the compaction entry cannot be persisted. A skipped
/// compaction is a normal `Ok` outcome carrying the skip message.
pub async fn execute_compaction(
    session: &mut SessionManager,
    options: CompactOptions<'_>,
) -> anyhow::Result<CompactOutcome> {
    let started_at = std::time::Instant::now();
    let entries = session.retained_entries().to_vec();
    let preparation = match prepare_compaction(&entries, options.settings.keep_recent_tokens) {
        Ok(preparation) => preparation,
        Err(skip) => return Ok(CompactOutcome::Skipped(skip.user_message())),
    };
    // TS `beginCompaction` after the preparation resolved: a skipped
    // compaction makes no events (the begin comes after the skip throw).
    let mut semantic_compaction = options
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

    // Messages the summarizer sees (TS prepareCompaction): the conversation
    // since the prior compaction's retained boundary, plus the prefix of a
    // split turn (turnPrefixMessages).
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
    // Split turns retain their suffix, but their prefix file operations
    // still belong in the summary details (TS prepareCompaction extracts
    // from messagesToSummarize plus turnPrefixMessages).
    let mut file_op_messages = history.clone();
    file_op_messages.extend(turn_prefix_messages.iter().cloned());
    let details: CompactionDetails =
        details_for(&file_op_messages, &entries, prev_compaction_index);

    // A run aborted before the summarizer request never starts one (TS
    // `throwIfAborted` at the top of the provider call).
    pa_agent::abort::throw_if_aborted_signal(options.abort)?;

    // TS `compact`: a split-turn cut runs TWO summarizer calls — the
    // history summary (the normal summarizer, floor(0.8*reserve) tokens)
    // and the turn-prefix summary (its own instruction, floor(0.5*reserve)
    // tokens) — concurrently; a non-split cut makes the single history
    // call. A split with no summarizable history makes no history wire
    // call at all and stands in the literal "No prior history.". The
    // history call carries the previous-summary update mode on both paths
    // (TS passes the prior compaction's summary to `generateSummary`; the
    // turn-prefix call never gets it) — a non-split cut with no new
    // history still makes the update wire call.
    // TS #2411 (`_resolveAuxiliaryModel`): the summary calls run with
    // their own prompt prefix (a different system prompt, no tools), so
    // on the session model they can never hit the session's cached
    // prefix and re-read their whole input at peak price — route them to
    // the configured auxiliary model when it is set, usable, and its
    // known window fits the exact requests this run will issue; fall back
    // to the session model otherwise (the pre-#2411 behavior). The
    // resolution reads settings.json/models.json/auth storage (and a
    // `!command` secret key resolves a subprocess when configured), so it
    // runs on the blocking pool, never the async executor.
    let (model, api_key, summary_headers) = match options.auxiliary {
        Some(context) => {
            let required = estimate_summary_request_tokens(
                &history,
                &turn_prefix_messages,
                cut.is_split_turn,
                previous_summary.as_deref(),
                recent_state_anchor.as_deref(),
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
            // fallback; the resolver itself never panics — every unusable
            // selector resolves to the fallback with the warning. The
            // fallback keeps the merged headers (the registry's single
            // owner of the team header).
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
        // The stand-in applies only inside the split arm (TS
        // `messagesToSummarize.length > 0 ? generateSummary(...) : "No
        // prior history."` — the arm runs when a turn prefix exists); a
        // cut without a turn prefix makes the history call below.
        if cut.is_split_turn && !turn_prefix_messages.is_empty() && history.is_empty() {
            // The literal stand-in is the history slice the live block
            // carries too (the flush below appends the split marker and
            // the prefix behind it, exactly like the committed summary).
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
            &history,
            options.custom_instructions,
            previous_summary.as_deref(),
            recent_state_anchor.as_deref(),
            options.settings.reserve_tokens,
        );
        // Each summary wire call carries its own request id under the
        // compaction's guard (TS `summaryCall`): the id's headers merge
        // over the routed model's.
        super::semantic_edges::summary_slice_call(
            semantic_compaction.as_ref(),
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
        if !cut.is_split_turn || turn_prefix_messages.is_empty() {
            return Ok::<Option<SummarySlice>, anyhow::Error>(None);
        }
        let request = build_turn_prefix_request(&turn_prefix_messages);
        let slice = super::semantic_edges::summary_slice_call(
            semantic_compaction.as_ref(),
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

    // The summarizer resolved while the run was aborted: the compaction is
    // cancelled before it commits (TS `_performCompaction`'s
    // `if (signal.aborted) throw` between the summary and the ledger).
    if options
        .abort
        .is_some_and(pa_agent::abort::AbortSignal::is_aborted)
    {
        return Err(pa_agent::abort::aborted_error());
    }

    // The live block converges to the exact committed summary: the
    // history streamed live above (its own call, in order), and the
    // parts the live stream has not carried — the split marker with the
    // completed turn-prefix summary (kept off the concurrent call so its
    // chunks never interleave out of final order) and the
    // file-operations suffix (which never flows through the summarizer)
    // flush through the sink here, in the final summary's own order. A
    // client accumulating every delta therefore holds precisely the text
    // the settled `compaction_end` carries.
    if let Some(sink) = options.summary_delta.as_ref() {
        let mut remainder = match &turn_prefix_slice {
            Some(prefix) => split_summary("", &prefix.summary),
            None => String::new(),
        };
        remainder.push_str(&file_ops_block(
            &details.read_files,
            &details.modified_files,
        ));
        if !remainder.is_empty() {
            sink(&remainder);
        }
    }
    // Result + persistence (TS `compact`): the split join carries the
    // turn-prefix summary behind the history summary under the TS marker,
    // and the file-operation block rides the summary on both paths.
    let mut summary = match &turn_prefix_slice {
        Some(prefix) => split_summary(&history_slice.summary, &prefix.summary),
        None => history_slice.summary.clone(),
    };
    summary.push_str(&file_ops_block(
        &details.read_files,
        &details.modified_files,
    ));
    let mut slices = vec![history_slice];
    if let Some(prefix) = turn_prefix_slice {
        slices.push(prefix);
    }
    let result = CompactionResult {
        summary,
        first_kept_entry_id: first_kept_entry.clone(),
        tokens_before,
        usage: summed_usage(&slices),
    };
    // TS `_performCompaction` passes `this._harnessDigestWithFingerprint()`
    // into `appendCompaction`: the snapshot plus the fingerprint of the
    // state behind it are attached mechanically at the commit and never
    // flow through the summarizer. The harness-state read happens here,
    // after the summarizer resolved, so harness state written during the
    // run is a fresh read — one read feeds the digest and its
    // fingerprint.
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
        &details,
        options.custom_instructions,
        harness_digest,
        harness_state_fingerprint,
    );
    // Ledger before effect (TS: `compactionRecorded` and the terminal
    // event land before `appendCompaction`): a failed persist still
    // leaves a completed compaction on the ledger, exactly like TS.
    if let Some(compaction) = semantic_compaction.as_mut() {
        compaction.commit();
    }
    // TS `appendCompaction` persists the full record: `details`,
    // `fromHook`, `customInstructions`, `usage`, and the `harnessDigest`
    // snapshot ride on the durable row alongside the summary, boundary,
    // and token count.
    session.append_compaction(entry.clone())?;
    super::compaction_trace::trace(
        "compact.entry_appended",
        &serde_json::json!({
            "firstKeptEntryId": first_kept_entry,
            "persisted": session.is_persisted(),
        }),
    );
    Ok(CompactOutcome::Ran(Box::new(CompactRun {
        result,
        entry,
        duration_ms: started_at.elapsed().as_millis() as u64,
        ipython_state: None,
    })))
}

/// Rebuild the live agent context after compaction. Keep session-only roles
/// (especially the compaction boundary) until the provider conversion seam.
#[must_use]
pub fn rebuilt_context_after_compaction(session: &SessionManager) -> Vec<AgentMessage> {
    session.active_context().messages
}
