//! `/compact` execution: resolve the cut over session entries, run the
//! summarizer, persist the compaction entry, and rebuild the agent context.

use pa_types::session::{AgentMessage, FileEntry};

use super::compaction::{estimate_context_tokens, find_cut_point, CutPointResult};
use super::compaction_exec::{
    build_summarization_request, build_turn_prefix_request, compaction_entry_for,
    complete_summary_call, details_for, file_ops_block, split_summary, summed_usage,
    CompactionDetails, CompactionResult, SummaryDeltaSink, SummarySlice, NO_PRIOR_HISTORY,
};
use crate::session::manager::SessionManager;

// The test mass (the in-file unit battery) moved to the child module at
// the same tree position (compact_session::tests); the tests' `super` and
// `super::super` paths resolve unchanged.
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
}

/// The history summary's completion budget (TS `generateSummary`:
/// `Math.floor(0.8 * reserveTokens)`): multiply before dividing so
/// sub-5 budgets round toward the true floor instead of collapsing to
/// zero (`/ 5 * 4` truncates first and yields 0 for reserves 1–4, and
/// 4 for 9 where the TS floor is 7).
pub(crate) fn history_summary_completion_budget(reserve_tokens: u64) -> u64 {
    reserve_tokens.saturating_mul(4) / 5
}

/// The split-turn prefix summary's completion budget (TS
/// `generateTurnPrefixSummary`: `Math.floor(0.5 * reserveTokens)`).
pub(crate) fn turn_prefix_summary_completion_budget(reserve_tokens: u64) -> u64 {
    reserve_tokens / 2
}

/// The chars the summarizer request text occupies at the compaction
/// module's chars/4 heuristic (TS #2411's estimator math).
pub(crate) fn summarizer_request_tokens(request: &[AgentMessage]) -> u64 {
    let chars: usize = request
        .iter()
        .map(|message| match message {
            AgentMessage::User(user) => user.content.text().chars().count(),
            _ => 0,
        })
        .sum();
    (chars as u64).div_ceil(4)
}

/// Estimate the context window the compaction's summary calls need (TS
/// #2411's `estimateSummaryRequestTokens`): the exact request bodies
/// through the same builders as the wire calls
/// ([`build_summarization_request`], [`build_turn_prefix_request`]), the
/// chars/4 heuristic, the shared system prompt, and each call's
/// completion budget — the largest slice wins, because routing must fit
/// every request the compaction will issue. `history` and `turn_prefix`
/// are the messages the run will summarize (see [`execute_compaction`]).
/// `recent_state_anchor` mirrors the anchor block the history wire request
/// always carries when the kept tail has assistant text (TS follow-up
/// 771611b14): an estimate without it would accept an auxiliary model
/// whose window fits the underestimate while the real request goes
/// over-limit.
pub fn estimate_summary_request_tokens(
    history: &[AgentMessage],
    turn_prefix: &[AgentMessage],
    is_split_turn: bool,
    previous_summary: Option<&str>,
    recent_state_anchor: Option<&str>,
    custom_instructions: Option<&str>,
    reserve_tokens: u64,
) -> u64 {
    let system_prompt_tokens = (super::compaction_utils::SUMMARIZATION_SYSTEM_PROMPT
        .chars()
        .count() as u64)
        .div_ceil(4);
    let mut required = 0u64;
    // The history slice runs for every compaction except a split turn
    // whose kept cut leaves no history ("No prior history." is a literal
    // stand-in, no wire call).
    let issues_history_call = !history.is_empty() || !is_split_turn || turn_prefix.is_empty();
    if issues_history_call {
        let request = super::compaction_exec::build_summarization_request(
            history,
            custom_instructions,
            previous_summary,
            recent_state_anchor,
            reserve_tokens,
        );
        required = required.max(
            system_prompt_tokens
                + summarizer_request_tokens(&request)
                + history_summary_completion_budget(reserve_tokens),
        );
    }
    // A split turn's prefix summary is a separate request with its own
    // body and a smaller completion budget, so it can exceed the history
    // slice.
    if !turn_prefix.is_empty() {
        let request = super::compaction_exec::build_turn_prefix_request(turn_prefix);
        required = required.max(
            system_prompt_tokens
                + summarizer_request_tokens(&request)
                + turn_prefix_summary_completion_budget(reserve_tokens),
        );
    }
    required
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

/// Why a compaction cannot prepare (TS `prepareCompaction` returning
/// `undefined`). The two surfaces spell it differently: `/compact` raises
/// the `CompactionSkippedError` message, the kernel `compact.run` host
/// request returns the short reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactSkip {
    AlreadyCompacted,
    TooShort,
}

impl CompactSkip {
    /// The `/compact` skip message (TS `CompactionSkippedError`).
    pub fn user_message(self) -> &'static str {
        match self {
            CompactSkip::AlreadyCompacted => "Already compacted",
            CompactSkip::TooShort => "Session is too short to compact — try again once it grows",
        }
    }

    /// The `compact.run` host-request reason (TS `handleCompactHostRequest`).
    pub fn request_reason(self) -> &'static str {
        match self {
            CompactSkip::AlreadyCompacted => "already compacted",
            CompactSkip::TooShort => "session is too short to compact",
        }
    }
}

/// A prepared compaction (TS `prepareCompaction`'s `CompactionPreparation`):
/// the resolved cut plus the iterative-update anchors derived from the prior
/// compaction — the retained boundary the new summary covers and the
/// previous summary the update-mode summarizer merges into.
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionPreparation {
    /// The chosen cut point.
    pub cut: CutPointResult,
    /// TS `boundaryStart`: the prior compaction's first kept entry (or the
    /// entry after the compaction when its boundary is gone — session
    /// migration). Everything before it is already summarized by the prior
    /// compaction; the new summary covers only what follows.
    pub boundary_start: usize,
    /// TS `previousSummary`: the prior compaction's summary, wired into the
    /// history summarizer request so it updates the existing summary instead
    /// of re-summarizing from scratch. File-list blocks never ride it (TS
    /// #2385 `stripFileListBlocks`): they strip before the update prompt,
    /// and a summary that contained only file blocks leaves no
    /// `previous_summary` at all (the initial-prompt path).
    pub previous_summary: Option<String>,
    /// TS #2385 `recentStateAnchor`: the newest kept-tail assistant text
    /// (tail-truncated), wired into the history summarizer request so the
    /// update summary cannot lag behind the retained tail it merges into.
    pub recent_state_anchor: Option<String>,
}

/// Resolve the compaction cut and the skip guards without a model call
/// (TS `prepareCompaction`): a branch that already ends in a compaction has
/// nothing new to summarize, and a branch with no summarizable history has
/// no compaction to run.
///
/// # Errors
///
/// Returns the TS `CompactionSkippedError` case as `Err`: the branch
/// already ends in a compaction, or it carries no summarizable history.
pub fn prepare_compaction(
    entries: &[FileEntry],
    keep_recent_tokens: u64,
) -> Result<CompactionPreparation, CompactSkip> {
    // Skip guard (TS prepareCompaction): a branch that already ends in a
    // compaction has nothing new to summarize.
    if matches!(entries.last(), Some(FileEntry::Compaction { .. })) {
        return Err(CompactSkip::AlreadyCompacted);
    }
    // The header is not a compact candidate.
    let start = usize::from(matches!(entries.first(), Some(FileEntry::Header { .. })));
    // Iterative update mode (TS prepareCompaction): a prior compaction is
    // the update anchor. Its summary becomes `previousSummary` (the
    // update-in-place mode for the history summarizer), and its first kept
    // entry becomes the boundary the new compaction covers — the new
    // summary summarizes only the retained conversation since, never the
    // already-summarized history before it.
    let prev_compaction_index = entries
        .iter()
        .rposition(|entry| matches!(entry, FileEntry::Compaction { .. }));
    let (boundary_start, previous_summary) = match prev_compaction_index {
        Some(index) => {
            let FileEntry::Compaction { payload, .. } = &entries[index] else {
                unreachable!("rposition matched a compaction entry")
            };
            let first_kept_index = entries
                .iter()
                .position(|entry| entry.id() == Some(payload.first_kept_entry_id.as_str()));
            // TS boundaryStart: the retained entry when it still exists,
            // else the entry after the compaction (session migration).
            let boundary_start = first_kept_index.unwrap_or(index + 1);
            // File-list blocks never reach the update prompt (TS #2385):
            // they are re-appended mechanically below and compound when
            // the model re-summarizes them. A previous summary that
            // contained only file blocks falls back to the initial-prompt
            // path.
            let stripped = super::compaction_utils::strip_file_list_blocks(&payload.summary);
            let previous_summary = (!stripped.is_empty()).then_some(stripped);
            (boundary_start, previous_summary)
        }
        None => (start, None),
    };
    let cut = find_cut_point(entries, boundary_start, entries.len(), keep_recent_tokens);
    // Messages the summarizer would see (TS prepareCompaction): the
    // conversation since the boundary, plus the prefix of a split turn.
    let history_end = if cut.is_split_turn {
        cut.turn_start_index.unwrap_or(cut.first_kept_entry_index)
    } else {
        cut.first_kept_entry_index
    };
    let messages: Vec<AgentMessage> = entries[boundary_start..history_end]
        .iter()
        .filter_map(message_from_entry)
        .collect();
    let turn_prefix_messages: Vec<AgentMessage> = entries[history_end..cut.first_kept_entry_index]
        .iter()
        .filter_map(message_from_entry)
        .collect();
    // The recency anchor (TS #2385): the summarizer sees only messages
    // before the cut, so its summary would describe pre-tail state. The
    // newest retained assistant text is the state the next turn actually
    // sees; it anchors the history summary to the kept tail.
    let recent_state_anchor =
        extract_recent_state_anchor(entries, cut.first_kept_entry_index, entries.len());

    // Avoid a compaction that would summarize no history (TS prepareCompaction
    // — a prior summary alone is enough to run: the update merges it).
    if messages.is_empty() && turn_prefix_messages.is_empty() && previous_summary.is_none() {
        return Err(CompactSkip::TooShort);
    }
    Ok(CompactionPreparation {
        cut,
        boundary_start,
        previous_summary,
        recent_state_anchor,
    })
}

/// Maximum characters kept from the retained tail for the recency anchor
/// (TS #2385 `RECENT_STATE_ANCHOR_MAX_CHARS`). The end of a message holds
/// the newest state, so long text keeps its tail.
const RECENT_STATE_ANCHOR_MAX_CHARS: usize = 2_000;

/// Extract the newest retained assistant text — the recency anchor (TS
/// #2385 `extractRecentStateAnchor`) — from the kept tail
/// `[kept_start, kept_end)`: scanning newest-first, the first assistant
/// message whose text blocks join to non-empty trimmed text wins; a longer
/// text keeps its tail. Compaction entries and harness digests are never
/// anchor candidates ([`message_from_entry`] drops them, mirroring TS
/// `getMessageFromEntryForCompaction`); assistants without text (tool-call
/// or thinking-only) skip until a text-bearing one is found.
fn extract_recent_state_anchor(
    entries: &[FileEntry],
    kept_start: usize,
    kept_end: usize,
) -> Option<String> {
    for entry in entries[kept_start..kept_end].iter().rev() {
        let Some(AgentMessage::Assistant(assistant)) = message_from_entry(entry) else {
            continue;
        };
        let text = assistant
            .content
            .iter()
            .filter_map(|block| match block {
                pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        let chars = text.chars().count();
        return Some(if chars > RECENT_STATE_ANCHOR_MAX_CHARS {
            text.chars()
                .skip(chars - RECENT_STATE_ANCHOR_MAX_CHARS)
                .collect()
        } else {
            text
        });
    }
    None
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
    let entries = session.retained_entries().to_vec();
    let preparation = match prepare_compaction(&entries, options.settings.keep_recent_tokens) {
        Ok(preparation) => preparation,
        Err(skip) => return Ok(CompactOutcome::Skipped(skip.user_message())),
    };
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
        serde_json::json!({
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
        serde_json::json!({ "tokensBefore": tokens_before }),
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
                        session_api_key,
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
        serde_json::json!({
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
                serde_json::Value::Null,
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
        complete_summary_call(
            &model,
            api_key.clone(),
            summary_headers.clone(),
            history_max_tokens,
            request,
            options.summary_delta.clone(),
            "Summarization failed",
        )
        .await
    };
    let turn_prefix_call = async {
        if !cut.is_split_turn || turn_prefix_messages.is_empty() {
            return Ok::<Option<SummarySlice>, anyhow::Error>(None);
        }
        let request = build_turn_prefix_request(&turn_prefix_messages);
        let slice = complete_summary_call(
            &model,
            api_key.clone(),
            summary_headers.clone(),
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
        .await?;
        Ok(Some(slice))
    };
    let (history_slice, turn_prefix_slice) = tokio::join!(history_call, turn_prefix_call);
    let history_slice = history_slice?;
    let turn_prefix_slice = turn_prefix_slice?;
    super::compaction_trace::trace(
        "compact.summarizer_resolved",
        serde_json::json!({
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
        serde_json::json!({ "digest": harness_digest.is_some() }),
    );
    let entry = compaction_entry_for(
        &result,
        &details,
        options.custom_instructions,
        harness_digest,
        harness_state_fingerprint,
    );
    // TS `appendCompaction` persists the full record: `details`,
    // `fromHook`, `customInstructions`, `usage`, and the `harnessDigest`
    // snapshot ride on the durable row alongside the summary, boundary,
    // and token count.
    session.append_compaction(entry.clone())?;
    super::compaction_trace::trace(
        "compact.entry_appended",
        serde_json::json!({
            "firstKeptEntryId": first_kept_entry,
            "persisted": session.is_persisted(),
        }),
    );
    Ok(CompactOutcome::Ran(Box::new(CompactRun {
        result,
        entry,
        ipython_state: None,
    })))
}

/// Rebuild the live agent context after compaction. Keep session-only roles
/// (especially the compaction boundary) until the provider conversion seam.
pub fn rebuilt_context_after_compaction(session: &SessionManager) -> Vec<AgentMessage> {
    session.active_context().messages
}

/// The cut computed for a session (test seam for decision verification).
pub fn compute_cut(session: &SessionManager, keep_recent_tokens: u64) -> (CutPointResult, u64) {
    let entries = session.retained_entries();
    let start = usize::from(matches!(entries.first(), Some(FileEntry::Header { .. })));
    let cut = find_cut_point(entries, start, entries.len(), keep_recent_tokens);
    let tokens = context_tokens(entries, session.get_leaf_id());
    (cut, tokens)
}
