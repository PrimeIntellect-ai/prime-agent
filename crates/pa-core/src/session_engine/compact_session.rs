//! `/compact` execution: resolve the cut over session entries, run the
//! summarizer, persist the compaction entry, and rebuild the agent context.

use pa_types::ai::Message;
use pa_types::session::{AgentMessage, FileEntry};

use super::compaction::{estimate_context_tokens, find_cut_point, CutPointResult};
use super::compaction_exec::{
    build_summarization_request, build_turn_prefix_request, compaction_entry_for,
    complete_summary_call, details_for, file_ops_block, split_summary, summed_usage,
    CompactionDetails, CompactionResult, SummarySlice, NO_PRIOR_HISTORY,
};
use super::messages::convert_to_llm;
use crate::session::manager::SessionManager;

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
}

/// The history summary's completion budget (TS `generateSummary`:
/// `Math.floor(0.8 * reserveTokens)`).
pub(crate) fn history_summary_completion_budget(reserve_tokens: u64) -> u64 {
    reserve_tokens / 5 * 4
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
pub fn estimate_summary_request_tokens(
    history: &[AgentMessage],
    turn_prefix: &[AgentMessage],
    is_split_turn: bool,
    previous_summary: Option<&str>,
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
    let issues_history_call = !history.is_empty() || !(is_split_turn && !turn_prefix.is_empty());
    if issues_history_call {
        let request = super::compaction_exec::build_summarization_request(
            history,
            custom_instructions,
            previous_summary,
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
                rest: Default::default(),
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
        FileEntry::Compaction { .. } => None,
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

/// Session AgentMessage -> LLM Message (post convertToLlm).
fn to_llm_messages(messages: &[AgentMessage]) -> Vec<Message> {
    convert_to_llm(messages)
        .into_iter()
        .filter_map(|message| match message {
            AgentMessage::User(user) => Some(Message::User(user)),
            AgentMessage::Assistant(assistant) => Some(Message::Assistant(assistant)),
            AgentMessage::ToolResult(result) => Some(Message::ToolResult(result)),
            _ => None,
        })
        .collect()
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
    /// of re-summarizing from scratch.
    pub previous_summary: Option<String>,
}

/// Resolve the compaction cut and the skip guards without a model call
/// (TS `prepareCompaction`): a branch that already ends in a compaction has
/// nothing new to summarize, and a branch with no summarizable history has
/// no compaction to run.
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
            (boundary_start, Some(payload.summary.clone()))
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
    // Avoid a compaction that would summarize no history (TS prepareCompaction
    // — a prior summary alone is enough to run: the update merges it).
    if messages.is_empty() && turn_prefix_messages.is_empty() && previous_summary.is_none() {
        return Err(CompactSkip::TooShort);
    }
    Ok(CompactionPreparation {
        cut,
        boundary_start,
        previous_summary,
    })
}

/// Run compaction over the session: summarize the pre-cut prefix, persist the
/// entry, and return the rebuilt post-compaction context messages.
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
    let tokens_before = context_tokens(&entries, session.get_leaf_id());
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
    // to the session model otherwise (the pre-#2411 behavior).
    let (model, api_key) = match options.auxiliary {
        Some(context) => {
            let required = estimate_summary_request_tokens(
                &history,
                &turn_prefix_messages,
                cut.is_split_turn,
                previous_summary.as_deref(),
                options.custom_instructions,
                options.settings.reserve_tokens,
            );
            let routed = super::auxiliary_model::resolve_auxiliary_model(
                context,
                "compaction summary",
                &options.model,
                options.api_key.clone(),
                Some(required),
            );
            (routed.model, routed.api_key)
        }
        None => (options.model.clone(), options.api_key.clone()),
    };
    let history_max_tokens = history_summary_completion_budget(options.settings.reserve_tokens);
    let turn_prefix_max_tokens =
        turn_prefix_summary_completion_budget(options.settings.reserve_tokens);
    let history_call = async {
        // The stand-in applies only inside the split arm (TS
        // `messagesToSummarize.length > 0 ? generateSummary(...) : "No
        // prior history."` — the arm runs when a turn prefix exists); a
        // cut without a turn prefix makes the history call below.
        if cut.is_split_turn && !turn_prefix_messages.is_empty() && history.is_empty() {
            return Ok(SummarySlice {
                summary: NO_PRIOR_HISTORY.to_string(),
                usage: None,
            });
        }
        let request = build_summarization_request(
            &history,
            options.custom_instructions,
            previous_summary.as_deref(),
            options.settings.reserve_tokens,
        );
        complete_summary_call(
            &model,
            api_key.clone(),
            history_max_tokens,
            request,
            "Summarization failed",
        )
        .await
    };
    let turn_prefix_call = async {
        if !(cut.is_split_turn && !turn_prefix_messages.is_empty()) {
            return Ok::<Option<SummarySlice>, anyhow::Error>(None);
        }
        let request = build_turn_prefix_request(&turn_prefix_messages);
        let slice = complete_summary_call(
            &model,
            api_key.clone(),
            turn_prefix_max_tokens,
            request,
            "Turn prefix summarization failed",
        )
        .await?;
        Ok(Some(slice))
    };
    let (history_slice, turn_prefix_slice) = tokio::join!(history_call, turn_prefix_call);
    let history_slice = history_slice?;
    let turn_prefix_slice = turn_prefix_slice?;

    // The summarizer resolved while the run was aborted: the compaction is
    // cancelled before it commits (TS `_performCompaction`'s
    // `if (signal.aborted) throw` between the summary and the ledger).
    if options
        .abort
        .is_some_and(pa_agent::abort::AbortSignal::is_aborted)
    {
        return Err(pa_agent::abort::aborted_error());
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
    // TS `_performCompaction` passes `this._harnessDigest()` into
    // `appendCompaction`: the snapshot is attached mechanically at the
    // commit and never flows through the summarizer. The harness-state
    // read happens here, after the summarizer resolved, so harness state
    // written during the run is a fresh read.
    let harness_digest = options
        .harness_digest
        .as_ref()
        .map(super::harness_digest::HarnessDigestInputs::render);
    let entry = compaction_entry_for(
        &result,
        &details,
        options.custom_instructions,
        harness_digest,
    );
    // TS `appendCompaction` persists the full record: `details`,
    // `fromHook`, `customInstructions`, `usage`, and the `harnessDigest`
    // snapshot ride on the durable row alongside the summary, boundary,
    // and token count.
    session.append_compaction(entry.clone())?;
    Ok(CompactOutcome::Ran(Box::new(CompactRun {
        result,
        entry,
        ipython_state: None,
    })))
}

/// Rebuild the agent's message list after compaction (summary-first context).
pub fn rebuilt_context_after_compaction(session: &SessionManager) -> Vec<Message> {
    let context = session.active_context();
    to_llm_messages(&context.messages)
}

/// The cut computed for a session (test seam for decision verification).
pub fn compute_cut(session: &SessionManager, keep_recent_tokens: u64) -> (CutPointResult, u64) {
    let entries = session.retained_entries();
    let start = usize::from(matches!(entries.first(), Some(FileEntry::Header { .. })));
    let cut = find_cut_point(entries, start, entries.len(), keep_recent_tokens);
    let tokens = context_tokens(entries, session.get_leaf_id());
    (cut, tokens)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::ai::{AssistantMessage, UserContent};
    use pa_types::session::EntryBase;

    fn session_with_turns(cwd: &std::path::Path, turns: usize) -> SessionManager {
        let mut session = SessionManager::in_memory(cwd);
        for i in 0..turns {
            session
                .append_message(AgentMessage::User(pa_types::ai::UserMessage {
                    content: UserContent::Text(format!("turn {i} message with some words")),
                    timestamp: 0,
                    rest: Default::default(),
                }))
                .unwrap();
            session
                .append_message(AgentMessage::Assistant(AssistantMessage {
                    content: vec![pa_types::ai::AssistantContentBlock::Text(
                        pa_types::ai::TextContent {
                            text: format!("reply {i}"),
                            text_signature: None,
                            rest: Default::default(),
                        },
                    )],
                    api: "openai-completions".to_string(),
                    provider: "test".to_string(),
                    model: "m".to_string(),
                    response_model: None,
                    response_id: None,
                    diagnostics: None,
                    usage: pa_types::ai::Usage {
                        input: 100,
                        output: 20,
                        cache_read: 0,
                        cache_write: 0,
                        total_tokens: 120,
                        cost: Default::default(),
                    },
                    stop_reason: pa_types::ai::StopReason::Stop,
                    stop_reason_raw: None,
                    error_message: None,
                    timestamp: 0,
                    rest: Default::default(),
                }))
                .unwrap();
        }
        session
    }

    #[test]
    fn cut_and_tokens_computed_from_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let session = session_with_turns(tmp.path(), 3);
        let (cut, tokens) = compute_cut(&session, 10_000);
        // A large keep budget keeps from the start.
        assert_eq!(cut.first_kept_entry_index, 1); // after the header
        assert_eq!(tokens, 120);
    }

    #[test]
    fn message_extraction_skips_compaction_and_tool_results() {
        let mut compaction = FileEntry::Compaction {
            payload: pa_types::session::CompactionEntry {
                summary: "s".to_string(),
                first_kept_entry_id: "x".to_string(),
                tokens_before: 1,
                details: None,
                from_hook: None,
                custom_instructions: None,
                usage: None,
                harness_digest: None,
            },
            base: EntryBase {
                id: Some("c".to_string()),
                parent_id: None,
                timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
                rest: Default::default(),
            },
        };
        let _ = &mut compaction;
        assert!(message_from_entry(&compaction).is_none());
        let tool_result = FileEntry::Message {
            message: AgentMessage::ToolResult(pa_types::ai::ToolResultMessage {
                tool_call_id: "c".to_string(),
                tool_name: "bash".to_string(),
                content: vec![],
                details: None,
                is_error: false,
                timestamp: 0,
                rest: Default::default(),
            }),
            base: EntryBase {
                id: Some("t".to_string()),
                parent_id: None,
                timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
                rest: Default::default(),
            },
        };
        assert!(message_from_entry(&tool_result).is_none());
    }

    /// The faux provider with one scripted summarizer response. The faux
    /// seam is process-global, so every registration unregisters on drop.
    fn faux_registration() -> pa_ai::faux::FauxProviderRegistration {
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                models: Some(vec![pa_ai::faux::FauxModelDefinition {
                    id: "compact-m".to_string(),
                    name: Some("Compact Model".to_string()),
                    reasoning: Some(false),
                    input: Some(vec![pa_types::ai::ModelInput::Text]),
                    cost: None,
                    context_window: Some(1_000),
                    max_tokens: Some(256),
                }]),
                ..Default::default()
            });
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                "## Goal\nsummarized goal",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        registration
    }

    /// A turn-spanning cut is a split turn: the compaction runs TWO
    /// summarizer calls — the history checkpoint call and the turn-prefix
    /// call under its own instruction — and the merged summary carries the
    /// turn context behind the TS split marker, with both calls' usage
    /// summed onto the durable row (TS `compact`'s split arm).
    #[tokio::test]
    async fn split_turn_compaction_runs_two_summarizer_calls_and_merges_the_turn_context() {
        let registration = faux_registration();
        let model = registration.get_model();
        let tmp = tempfile::tempdir().unwrap();
        let mut session = SessionManager::in_memory(tmp.path());
        let user = |text: &str| {
            AgentMessage::User(pa_types::ai::UserMessage {
                content: UserContent::Text(text.to_string()),
                timestamp: 0,
                rest: Default::default(),
            })
        };
        let reply = |text: &str| {
            AgentMessage::Assistant(AssistantMessage {
                content: vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text: text.to_string(),
                        text_signature: None,
                        rest: Default::default(),
                    },
                )],
                api: "faux".to_string(),
                provider: "faux".to_string(),
                model: "compact-m".to_string(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: pa_types::ai::Usage::default(),
                stop_reason: pa_types::ai::StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: 0,
                rest: Default::default(),
            })
        };
        session.append_message(user("turn one")).unwrap();
        session.append_message(reply("reply one")).unwrap();
        session
            .append_message(user(&format!("big turn {}", "x".repeat(4_000))))
            .unwrap();
        session
            .append_message(reply(&format!("reply {}", "y".repeat(4_000))))
            .unwrap();
        session.append_message(user("turn three")).unwrap();
        session.append_message(reply("reply three")).unwrap();
        // The tiny keep-recent budget lands the cut on the big turn's
        // assistant reply — a mid-turn cut.
        let (cut, _) = compute_cut(&session, 10);
        assert!(cut.is_split_turn);
        assert_eq!(cut.turn_start_index, Some(3));
        assert_eq!(cut.first_kept_entry_index, 4);
        let kept_id = session.get_all_entries()[4]
            .id()
            .expect("entry id")
            .to_string();

        // Scripted summaries: each factory call records its request and
        // answers with its scripted response, so both wire calls are
        // captured regardless of issue order.
        let seen: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>> = Default::default();
        let make_step = |response: &'static str| {
            let seen = seen.clone();
            pa_ai::faux::FauxResponseStep::Factory(std::sync::Arc::new(
                move |context: &pa_types::ai::Context,
                      _options: Option<&pa_ai::types::StreamOptions>,
                      _call: u64,
                      _model: &pa_types::ai::Model| {
                    let text = match &context.messages[0] {
                        pa_types::ai::Message::User(user) => user.content.text(),
                        _ => panic!("expected a user request"),
                    };
                    seen.lock().unwrap().push((text, response.to_string()));
                    Ok(pa_ai::faux::faux_assistant_text_message(
                        response,
                        pa_ai::faux::FauxAssistantMessageOptions::default(),
                    ))
                },
            ))
        };
        registration.set_responses(vec![
            make_step("the history summary"),
            make_step("the turn prefix summary"),
        ]);
        let outcome = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings: super::super::compaction::CompactionSettings {
                    keep_recent_tokens: 10,
                    ..Default::default()
                },
                abort: None,
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap();
        let CompactOutcome::Ran(run) = outcome else {
            panic!("expected the compaction to run");
        };
        // Two wire calls: the history checkpoint and the turn prefix.
        assert_eq!(registration.call_count(), 2);
        let calls = seen.lock().unwrap().clone();
        assert_eq!(calls.len(), 2);
        let (history_request, history_response) = calls
            .iter()
            .find(|(text, _)| text.contains("Create a structured context checkpoint summary"))
            .expect("history call");
        assert!(history_request.contains("[User]: turn one"));
        assert!(history_request.contains("[Assistant]: reply one"));
        assert!(!history_request.contains("big turn"));
        assert!(!history_request.contains("PREFIX of a turn"));
        assert_eq!(history_response, "the history summary");
        let (prefix_request, prefix_response) = calls
            .iter()
            .find(|(text, _)| text.contains("PREFIX of a turn"))
            .expect("turn-prefix call");
        assert!(prefix_request.contains("[User]: big turn"));
        assert!(prefix_request.contains("This is the PREFIX of a turn that was too large to keep."));
        assert!(prefix_request
            .ends_with("Be concise. Focus on what's needed to understand the kept suffix."));
        assert!(!prefix_request.contains("checkpoint summary"));
        assert_eq!(prefix_response, "the turn prefix summary");
        // The merged summary: history, the split marker, the turn context.
        assert_eq!(
            run.result.summary,
            "the history summary\n\n---\n\n**Turn Context (split turn):**\n\nthe turn prefix summary"
        );
        assert_eq!(run.result.first_kept_entry_id, kept_id);
        // The usage is the sum of the two wire calls (faux estimates each
        // call as ceil(chars/4) over the serialized prompt plus response).
        let est = |text: &str| (text.chars().count() as f64 / 4.0).ceil() as u64;
        let usage_of = |request: &str, response: &str| {
            let prompt = format!(
                "system:{}\n\nuser:{request}",
                super::super::compaction_utils::SUMMARIZATION_SYSTEM_PROMPT
            );
            let input = est(&prompt);
            let output = est(response);
            pa_types::ai::Usage {
                input,
                output,
                cache_read: 0,
                cache_write: 0,
                total_tokens: input + output,
                cost: Default::default(),
            }
        };
        let mut expected = usage_of(history_request, history_response);
        super::super::compaction_exec::add_assistant_usage(
            &mut expected,
            &usage_of(prefix_request, prefix_response),
        );
        assert_eq!(run.result.usage, Some(expected));
        assert_eq!(run.entry.usage, run.result.usage);
        assert_eq!(run.entry.summary, run.result.summary);
        // The persisted durable row is the full merged entry.
        let persisted = session
            .get_entries()
            .iter()
            .rev()
            .find_map(|entry| match entry {
                FileEntry::Compaction { payload, .. } => Some(payload.clone()),
                _ => None,
            })
            .expect("compaction entry persisted");
        assert_eq!(persisted, run.entry);
        registration.unregister();
    }

    /// The injected-turn representation drives the compaction walk (the
    /// f7 goal-continue differential's shape): a session whose last turn
    /// is an injected custom row — ONE representation, the goal-context
    /// row, with no duplicate user message — compacts with a whole-turn
    /// cut (a single history call, the whole goal turn kept). The
    /// double-represented shape the fix removes (the custom row PLUS a
    /// user message with the same text, the pre-fix engine branch) shifts
    /// the keep-recent crossing and lands the cut mid-turn: a split-turn
    /// compaction with an extra turn-prefix summarizer call — the
    /// short-session compact TS never makes.
    #[tokio::test]
    async fn injected_custom_turn_cuts_whole_turns_the_double_row_splits() {
        let registration = faux_registration();
        let model = registration.get_model();
        let tmp = tempfile::tempdir().unwrap();
        let mut session = SessionManager::in_memory(tmp.path());
        let user = |text: &str| {
            AgentMessage::User(pa_types::ai::UserMessage {
                content: UserContent::Text(text.to_string()),
                timestamp: 0,
                rest: Default::default(),
            })
        };
        let reply = |text: &str| {
            AgentMessage::Assistant(AssistantMessage {
                content: vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text: text.to_string(),
                        text_signature: None,
                        rest: Default::default(),
                    },
                )],
                api: "faux".to_string(),
                provider: "faux".to_string(),
                model: "compact-m".to_string(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: pa_types::ai::Usage::default(),
                stop_reason: pa_types::ai::StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: 0,
                rest: Default::default(),
            })
        };
        let goal_row = |session: &mut SessionManager| {
            session.append_custom_message(
                "goal_context",
                UserContent::Text("[goal: continuation] keep going".to_string()),
                true,
                Some(serde_json::json!({ "kind": "continuation" })),
            )
        };
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let record_summary = |recorder: std::sync::Arc<std::sync::Mutex<Vec<String>>>| {
            pa_ai::faux::FauxResponseStep::Factory(std::sync::Arc::new(
                move |context: &pa_types::ai::Context,
                      _options: Option<&pa_ai::types::StreamOptions>,
                      _call: u64,
                      _model: &pa_types::ai::Model| {
                    let text = match &context.messages[0] {
                        pa_types::ai::Message::User(user) => user.content.text(),
                        _ => panic!("expected a user request"),
                    };
                    recorder.lock().unwrap().push(text);
                    Ok(pa_ai::faux::faux_assistant_text_message(
                        "## Summary\nthe session story",
                        pa_ai::faux::FauxAssistantMessageOptions::default(),
                    ))
                },
            ))
        };
        registration.set_responses(vec![record_summary(seen.clone())]);
        let settings = |keep_recent_tokens: u64| super::super::compaction::CompactionSettings {
            keep_recent_tokens,
            ..Default::default()
        };

        // ONE representation (the fixed engine branch): the goal turn is
        // the custom row plus its reply.
        session.append_message(user("seed turn")).unwrap();
        session.append_message(reply("seed reply")).unwrap();
        let kept_goal_row_id = goal_row(&mut session).unwrap();
        session.append_message(reply("goal reply")).unwrap();
        let outcome = execute_compaction(
            &mut session,
            CompactOptions {
                model: model.clone(),
                api_key: None,
                custom_instructions: None,
                settings: settings(2),
                abort: None,
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap();
        let CompactOutcome::Ran(run) = outcome else {
            panic!("expected the compaction to run");
        };
        // Whole-turn cut: one history call, no turn-prefix call, the
        // entire goal turn (custom row plus reply) kept.
        assert_eq!(
            registration.call_count(),
            1,
            "the whole-turn cut makes one call"
        );
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].contains("checkpoint summary"));
        assert!(!requests[0].contains("PREFIX of a turn"));
        assert_eq!(run.result.first_kept_entry_id, kept_goal_row_id);
        assert!(
            !run.result.summary.contains("Turn Context (split turn)"),
            "a whole-turn cut never merges a turn context: {summary}",
            summary = run.result.summary
        );

        // The double-represented shape the fix removes (the pre-fix
        // engine branch): the custom row PLUS a user message with the
        // same text. The extra user row shifts the keep-recent crossing
        // and the pull-back lands the cut mid-turn — the extra
        // turn-prefix call TS never makes (the f7 goal-continue split).
        let calls_before = registration.call_count();
        seen.lock().unwrap().clear();
        // Two calls in the doubled shape (history plus the extra
        // turn-prefix summarizer the double row forces).
        registration.set_responses(vec![
            record_summary(seen.clone()),
            record_summary(seen.clone()),
        ]);
        let mut doubled = SessionManager::in_memory(tmp.path());
        doubled.append_message(user("seed turn")).unwrap();
        doubled.append_message(reply("seed reply")).unwrap();
        goal_row(&mut doubled).unwrap();
        doubled
            .append_message(user("[goal: continuation] keep going"))
            .unwrap();
        doubled.append_message(reply("goal reply")).unwrap();
        let outcome = execute_compaction(
            &mut doubled,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings: settings(2),
                abort: None,
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap();
        let CompactOutcome::Ran(run) = outcome else {
            panic!("expected the compaction to run");
        };
        assert_eq!(
            registration.call_count() - calls_before,
            2,
            "the double row splits the turn and makes the extra prefix call"
        );
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 2);
        let prefix_request = requests
            .iter()
            .find(|text| text.contains("PREFIX of a turn"))
            .expect("the double row's turn-prefix call");
        assert!(
            prefix_request.contains("[User]: [goal: continuation] keep going"),
            "the split prefix is the duplicate user row: {prefix_request}"
        );
        assert!(run.result.summary.contains("Turn Context (split turn)"));
        registration.unregister();
    }

    /// A split turn with no history to summarize makes only the
    /// turn-prefix wire call and stands the literal "No prior history."
    /// in for the history half (TS
    /// `Promise.resolve({ summary: "No prior history." })` — no history
    /// wire call), billing only the prefix call.
    #[tokio::test]
    async fn split_turn_without_history_makes_only_the_prefix_call() {
        let registration = faux_registration();
        let model = registration.get_model();
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let recorder = seen.clone();
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(
            std::sync::Arc::new(
                move |context: &pa_types::ai::Context,
                      _options: Option<&pa_ai::types::StreamOptions>,
                      _call: u64,
                      _model: &pa_types::ai::Model| {
                    let text = match &context.messages[0] {
                        pa_types::ai::Message::User(user) => user.content.text(),
                        _ => panic!("expected a user request"),
                    };
                    recorder.lock().unwrap().push(text);
                    Ok(pa_ai::faux::faux_assistant_text_message(
                        "the turn prefix summary",
                        pa_ai::faux::FauxAssistantMessageOptions::default(),
                    ))
                },
            ),
        )]);
        let tmp = tempfile::tempdir().unwrap();
        let mut session = SessionManager::in_memory(tmp.path());
        let user = |text: &str| {
            AgentMessage::User(pa_types::ai::UserMessage {
                content: UserContent::Text(text.to_string()),
                timestamp: 0,
                rest: Default::default(),
            })
        };
        let reply = |text: &str| {
            AgentMessage::Assistant(AssistantMessage {
                content: vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text: text.to_string(),
                        text_signature: None,
                        rest: Default::default(),
                    },
                )],
                api: "faux".to_string(),
                provider: "faux".to_string(),
                model: "compact-m".to_string(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: pa_types::ai::Usage::default(),
                stop_reason: pa_types::ai::StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: 0,
                rest: Default::default(),
            })
        };
        // One big turn only: the cut splits it, and nothing precedes the
        // turn start, so there is no history to summarize.
        session
            .append_message(user(&format!("big turn {}", "x".repeat(4_000))))
            .unwrap();
        session
            .append_message(reply(&format!("reply {}", "y".repeat(4_000))))
            .unwrap();
        session.append_message(user("small")).unwrap();
        session.append_message(reply("small reply")).unwrap();
        let (cut, _) = compute_cut(&session, 10);
        assert!(cut.is_split_turn);
        assert_eq!(cut.turn_start_index, Some(1));
        let kept_id = session.get_all_entries()[2]
            .id()
            .expect("entry id")
            .to_string();
        let outcome = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings: super::super::compaction::CompactionSettings {
                    keep_recent_tokens: 10,
                    ..Default::default()
                },
                abort: None,
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap();
        let CompactOutcome::Ran(run) = outcome else {
            panic!("expected the compaction to run");
        };
        // One wire call: only the turn-prefix summary was requested.
        assert_eq!(registration.call_count(), 1);
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].contains("[User]: big turn"));
        assert!(requests[0].contains("PREFIX of a turn that was too large to keep"));
        // The merged summary stands the literal in for the history half.
        assert_eq!(
            run.result.summary,
            "No prior history.\n\n---\n\n**Turn Context (split turn):**\n\nthe turn prefix summary"
        );
        assert_eq!(run.result.first_kept_entry_id, kept_id);
        // Only the prefix call billed.
        let est = |text: &str| (text.chars().count() as f64 / 4.0).ceil() as u64;
        let prompt = format!(
            "system:{}\n\nuser:{}",
            super::super::compaction_utils::SUMMARIZATION_SYSTEM_PROMPT,
            requests[0]
        );
        let input = est(&prompt);
        let output = est("the turn prefix summary");
        assert_eq!(
            run.result.usage,
            Some(pa_types::ai::Usage {
                input,
                output,
                cache_read: 0,
                cache_write: 0,
                total_tokens: input + output,
                cost: Default::default(),
            })
        );
        registration.unregister();
    }

    /// The split arm of the skip guard (TS `prepareCompaction`): a
    /// mid-turn cut with no history still has the turn prefix to
    /// summarize, so the compaction prepares instead of skipping.
    #[test]
    fn prepare_compaction_split_arm_counts_the_turn_prefix_as_content() {
        let tmp = tempfile::tempdir().unwrap();
        let mut session = SessionManager::in_memory(tmp.path());
        let user = |text: &str| {
            AgentMessage::User(pa_types::ai::UserMessage {
                content: UserContent::Text(text.to_string()),
                timestamp: 0,
                rest: Default::default(),
            })
        };
        session
            .append_message(user(&format!("big turn {}", "x".repeat(4_000))))
            .unwrap();
        session
            .append_message(AgentMessage::Assistant(AssistantMessage {
                content: vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text: format!("reply {}", "y".repeat(4_000)),
                        text_signature: None,
                        rest: Default::default(),
                    },
                )],
                api: "faux".to_string(),
                provider: "faux".to_string(),
                model: "compact-m".to_string(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: pa_types::ai::Usage::default(),
                stop_reason: pa_types::ai::StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: 0,
                rest: Default::default(),
            }))
            .unwrap();
        session.append_message(user("small")).unwrap();
        let entries = session.get_all_entries().to_vec();
        let preparation = prepare_compaction(&entries, 10).expect("split compaction prepares");
        assert!(preparation.cut.is_split_turn);
        assert_eq!(preparation.cut.turn_start_index, Some(1));
        // No prior compaction: no update-mode anchors.
        assert_eq!(preparation.previous_summary, None);
        // A fresh small session with no cut history still skips.
        let mut small = SessionManager::in_memory(tmp.path());
        small.append_message(user("one small turn")).unwrap();
        let entries = small.get_all_entries().to_vec();
        assert_eq!(
            prepare_compaction(&entries, 10_000),
            Err(CompactSkip::TooShort)
        );
    }

    /// A raw entry builder for prepare-level tests (explicit ids).
    fn raw_user_entry(id: &str, text: &str) -> FileEntry {
        FileEntry::Message {
            message: AgentMessage::User(pa_types::ai::UserMessage {
                content: UserContent::Text(text.to_string()),
                timestamp: 0,
                rest: Default::default(),
            }),
            base: EntryBase {
                id: Some(id.to_string()),
                parent_id: None,
                timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
                rest: Default::default(),
            },
        }
    }

    fn raw_compaction_entry(id: &str, first_kept: &str, summary: &str) -> FileEntry {
        FileEntry::Compaction {
            payload: pa_types::session::CompactionEntry {
                summary: summary.to_string(),
                first_kept_entry_id: first_kept.to_string(),
                tokens_before: 100,
                ..Default::default()
            },
            base: EntryBase {
                id: Some(id.to_string()),
                parent_id: None,
                timestamp: Some("2024-01-01T00:00:00.000Z".to_string()),
                rest: Default::default(),
            },
        }
    }

    /// The iterative update mode activates from a prior compaction (TS
    /// `prepareCompaction`): the prior summary becomes `previousSummary`
    /// and the prior compaction's first kept entry becomes the
    /// summarization boundary — the cut walks only the retained
    /// conversation, and the new history covers the messages since the
    /// boundary, never the already-summarized prefix.
    #[test]
    fn prepare_compaction_update_mode_anchors_on_the_prior_compaction() {
        let entries = vec![
            raw_user_entry("m0", "turn zero"),
            raw_user_entry("m1", "turn one"),
            raw_user_entry("m2", "turn two"),
            raw_compaction_entry("c1", "m1", "the prior summary"),
            raw_user_entry("m3", "turn three"),
            raw_user_entry("m4", "turn four"),
        ];
        let preparation = prepare_compaction(&entries, 2).expect("update compaction prepares");
        // The boundary is the prior compaction's first kept entry.
        assert_eq!(preparation.boundary_start, 1);
        assert_eq!(
            preparation.previous_summary,
            Some("the prior summary".to_string())
        );
        // The cut walks only the retained region (the budget counts the
        // post-boundary messages, so it lands at the last small turn).
        assert_eq!(preparation.cut.first_kept_entry_index, 5);
        assert!(!preparation.cut.is_split_turn);
        // Without a prior compaction there are no update anchors.
        let fresh = vec![
            raw_user_entry("m0", "turn zero"),
            raw_user_entry("m1", "turn one"),
        ];
        let preparation = prepare_compaction(&fresh, 2).expect("fresh compaction prepares");
        assert_eq!(preparation.previous_summary, None);
        assert_eq!(preparation.boundary_start, 0);
    }

    /// The boundary fallback (TS `boundaryStart = prevCompactionIndex + 1`
    /// when the retained entry is gone — session migration) and the guard
    /// (TS: `!previousSummary` — a prior summary alone is enough to run).
    #[test]
    fn prepare_compaction_boundary_fallback_and_prior_summary_guard() {
        // The retained entry id no longer exists: the boundary falls back
        // to the entry after the compaction.
        let entries = vec![
            raw_compaction_entry("c1", "gone-entry", "the prior summary"),
            raw_user_entry("m1", "turn one"),
        ];
        let preparation = prepare_compaction(&entries, 2).expect("fallback boundary prepares");
        assert_eq!(preparation.boundary_start, 1);
        assert_eq!(
            preparation.previous_summary,
            Some("the prior summary".to_string())
        );
        // A huge keep budget leaves nothing new to summarize, but the
        // prior summary alone keeps the compaction runnable (TS: the skip
        // guard fires only without a previousSummary).
        let preparation = prepare_compaction(&entries, 10_000).expect("prior summary runs");
        assert_eq!(preparation.cut.first_kept_entry_index, 1);
        // The same shape WITHOUT a prior compaction skips as too short.
        let fresh = vec![raw_user_entry("m1", "turn one")];
        assert_eq!(
            prepare_compaction(&fresh, 10_000),
            Err(CompactSkip::TooShort)
        );
    }

    /// A session compacted twice (the iterative update mode, TS `compact`
    /// passing `previousSummary` into the history call): the second
    /// compaction's summarizer request carries the update prompt with the
    /// prior summary in `<previous-summary>` tags and summarizes only the
    /// conversation since the first compaction's boundary — never the
    /// history the first compaction already summarized.
    #[tokio::test]
    async fn second_compaction_updates_the_prior_summary_over_new_history() {
        let registration = faux_registration();
        let model = registration.get_model();
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let make_step = |response: &'static str| {
            let seen = seen.clone();
            pa_ai::faux::FauxResponseStep::Factory(std::sync::Arc::new(
                move |context: &pa_types::ai::Context,
                      _options: Option<&pa_ai::types::StreamOptions>,
                      _call: u64,
                      _model: &pa_types::ai::Model| {
                    let text = match &context.messages[0] {
                        pa_types::ai::Message::User(user) => user.content.text(),
                        _ => panic!("expected a user request"),
                    };
                    seen.lock().unwrap().push(text);
                    Ok(pa_ai::faux::faux_assistant_text_message(
                        response,
                        pa_ai::faux::FauxAssistantMessageOptions::default(),
                    ))
                },
            ))
        };
        registration.set_responses(vec![
            make_step("the first summary"),
            make_step("the second summary"),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let mut session = SessionManager::in_memory(tmp.path());
        let user = |text: &str| {
            AgentMessage::User(pa_types::ai::UserMessage {
                content: UserContent::Text(text.to_string()),
                timestamp: 0,
                rest: Default::default(),
            })
        };
        session.append_message(user("turn zero")).unwrap();
        session.append_message(user("turn one")).unwrap();
        session.append_message(user("turn two")).unwrap();
        let settings = super::super::compaction::CompactionSettings {
            keep_recent_tokens: 2,
            ..Default::default()
        };
        // First compaction: the initial checkpoint prompt over turns zero
        // and one, keeping turn two.
        let outcome = execute_compaction(
            &mut session,
            CompactOptions {
                model: model.clone(),
                api_key: None,
                custom_instructions: None,
                settings,
                abort: None,
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap();
        let CompactOutcome::Ran(first) = outcome else {
            panic!("expected the first compaction to run")
        };
        assert_eq!(first.result.summary, "the first summary");
        let mut requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].contains("Create a structured context checkpoint summary"));
        assert!(requests[0].contains("[User]: turn zero"));
        assert!(!requests[0].contains("<previous-summary>"));

        // New turns after the first compaction.
        session.append_message(user("turn three")).unwrap();
        session.append_message(user("turn four")).unwrap();
        let outcome = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings,
                abort: None,
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap();
        let CompactOutcome::Ran(second) = outcome else {
            panic!("expected the second compaction to run")
        };
        // One update-mode wire call: the update prompt, the prior summary
        // in <previous-summary> tags, and only the conversation since the
        // first compaction's boundary (turn two was RETAINED by the first
        // compaction, so it is new history; turn zero was summarized away).
        assert_eq!(registration.call_count(), 2);
        requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 2);
        let request = &requests[1];
        assert!(request.contains("NEW conversation messages to incorporate"));
        assert!(request.contains("<previous-summary>\nthe first summary\n</previous-summary>"));
        assert!(request.contains("[User]: turn two"));
        assert!(request.contains("[User]: turn three"));
        assert!(!request.contains("[User]: turn zero"));
        assert!(!request.contains("[User]: turn one"));
        // The merged durable entry: the updated summary, the new cut.
        assert_eq!(second.result.summary, "the second summary");
        let kept_id = session
            .get_all_entries()
            .iter()
            .rev()
            .find(|entry| matches!(entry, FileEntry::Message { .. }))
            .and_then(|entry| entry.id())
            .expect("kept entry id")
            .to_string();
        assert_eq!(second.result.first_kept_entry_id, kept_id);
        // Both compactions persisted.
        let compactions = session
            .get_entries()
            .iter()
            .filter_map(|entry| match entry {
                FileEntry::Compaction { payload, .. } => Some(payload.summary.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(compactions, vec!["the first summary", "the second summary"]);
        registration.unregister();
    }

    /// A split-turn cut after a prior compaction (the iterative update
    /// mode on the split path, #225's note): the history call runs in
    /// update mode over the conversation since the boundary, while the
    /// turn-prefix call stays a plain prefix summary — never the previous
    /// summary.
    #[tokio::test]
    async fn second_compaction_split_turn_history_updates_prefix_does_not() {
        let registration = faux_registration();
        let model = registration.get_model();
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let make_step = |response: &'static str| {
            let seen = seen.clone();
            pa_ai::faux::FauxResponseStep::Factory(std::sync::Arc::new(
                move |context: &pa_types::ai::Context,
                      _options: Option<&pa_ai::types::StreamOptions>,
                      _call: u64,
                      _model: &pa_types::ai::Model| {
                    let text = match &context.messages[0] {
                        pa_types::ai::Message::User(user) => user.content.text(),
                        _ => panic!("expected a user request"),
                    };
                    seen.lock().unwrap().push(text);
                    Ok(pa_ai::faux::faux_assistant_text_message(
                        response,
                        pa_ai::faux::FauxAssistantMessageOptions::default(),
                    ))
                },
            ))
        };
        registration.set_responses(vec![
            make_step("the first summary"),
            make_step("the updated history summary"),
            make_step("the turn prefix summary"),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let mut session = SessionManager::in_memory(tmp.path());
        let user = |text: &str| {
            AgentMessage::User(pa_types::ai::UserMessage {
                content: UserContent::Text(text.to_string()),
                timestamp: 0,
                rest: Default::default(),
            })
        };
        let reply = |text: &str| {
            AgentMessage::Assistant(AssistantMessage {
                content: vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text: text.to_string(),
                        text_signature: None,
                        rest: Default::default(),
                    },
                )],
                api: "faux".to_string(),
                provider: "faux".to_string(),
                model: "compact-m".to_string(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: pa_types::ai::Usage::default(),
                stop_reason: pa_types::ai::StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: 0,
                rest: Default::default(),
            })
        };
        session.append_message(user("turn zero")).unwrap();
        session.append_message(user("turn one")).unwrap();
        let settings = super::super::compaction::CompactionSettings {
            keep_recent_tokens: 1,
            ..Default::default()
        };
        let outcome = execute_compaction(
            &mut session,
            CompactOptions {
                model: model.clone(),
                api_key: None,
                custom_instructions: None,
                settings,
                abort: None,
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap();
        assert!(matches!(outcome, CompactOutcome::Ran(_)));

        // A small retained turn, then a big turn the cut splits: the cut
        // lands mid big turn (keep budget 10), with the first compaction's
        // retained turns as the history and the big turn's user message as
        // the split prefix.
        session.append_message(user("kept small turn")).unwrap();
        session.append_message(reply("small kept reply")).unwrap();
        session
            .append_message(user(&format!("big turn {}", "x".repeat(4_000))))
            .unwrap();
        session
            .append_message(reply(&format!("reply {}", "y".repeat(4_000))))
            .unwrap();
        session.append_message(user("final small turn")).unwrap();
        session.append_message(reply("final reply")).unwrap();
        let outcome = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings: super::super::compaction::CompactionSettings {
                    keep_recent_tokens: 10,
                    ..Default::default()
                },
                abort: None,
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap();
        let CompactOutcome::Ran(second) = outcome else {
            panic!("expected the second compaction to run")
        };
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 3);
        // The history call: update mode over the conversation since the
        // first compaction's boundary (turn one was retained, kept small
        // turn, small kept reply) — with the previous summary; turn zero
        // was summarized away and never reappears.
        let history_request = requests
            .iter()
            .find(|text| text.contains("NEW conversation messages to incorporate"))
            .expect("history call in update mode");
        assert!(
            history_request.contains("<previous-summary>\nthe first summary\n</previous-summary>")
        );
        assert!(history_request.contains("[User]: turn one"));
        assert!(history_request.contains("[User]: kept small turn"));
        assert!(!history_request.contains("[User]: turn zero"));
        // The turn-prefix call: its own instruction, never the update
        // prompt or the previous summary.
        let prefix_request = requests
            .iter()
            .find(|text| text.contains("PREFIX of a turn"))
            .expect("turn-prefix call");
        assert!(prefix_request.contains("[User]: big turn"));
        assert!(!prefix_request.contains("<previous-summary>"));
        assert!(!prefix_request.contains("NEW conversation messages to incorporate"));
        // The merged summary carries the split marker behind the updated
        // history summary.
        assert_eq!(
            second.result.summary,
            "the updated history summary\n\n---\n\n**Turn Context (split turn):**\n\nthe turn prefix summary"
        );
        registration.unregister();
    }

    #[tokio::test]
    async fn execute_compaction_persists_and_rebuilds() {
        let registration = faux_registration();
        let model = registration.get_model();
        let tmp = tempfile::tempdir().unwrap();
        let mut session = session_with_turns(tmp.path(), 3);
        let result = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: Some("focus on the goal"),
                settings: super::super::compaction::CompactionSettings {
                    keep_recent_tokens: 20,
                    ..Default::default()
                },
                abort: None,
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap();
        let CompactOutcome::Ran(run) = result else {
            panic!("expected the compaction to run");
        };
        assert!(run.result.summary.contains("summarized goal"));
        assert!(run.result.usage.is_some());
        assert_eq!(run.entry.summary, run.result.summary);
        // A user-message cut is not a split turn: exactly one summarizer
        // wire call, and no split marker in the merged summary.
        assert_eq!(registration.call_count(), 1);
        assert!(!run.result.summary.contains("Turn Context (split turn)"));
        // The compaction entry persisted on the session.
        assert!(session
            .get_entries()
            .iter()
            .any(|entry| matches!(entry, FileEntry::Compaction { .. })));
        // The rebuilt context starts with the summary message.
        let rebuilt = rebuilt_context_after_compaction(&session);
        assert!(!rebuilt.is_empty());
        match &rebuilt[0] {
            Message::User(user) => assert!(user.content.text().contains("[compaction-summary]")),
            other => panic!("expected summary user message, got {other:?}"),
        }
        registration.unregister();
    }

    /// The harness digest snapshot rides the durable compaction row (TS
    /// `_performCompaction` -> `appendCompaction(..., this._harnessDigest())`):
    /// the harness-state disk read happens at the commit, so state written
    /// after the inputs were captured (mid-run, the TS test's "written
    /// before compaction" memory) is a fresh read, the digest never flows
    /// through the summarizer, and the rebuilt context leads with the
    /// digest block before the compaction summary.
    #[tokio::test]
    async fn execute_compaction_attaches_harness_digest_snapshot() {
        let registration = faux_registration();
        let model = registration.get_model();
        let tmp = tempfile::tempdir().unwrap();
        let mut session = session_with_turns(tmp.path(), 3);
        let global_dir = tmp.path().join("agent").join("harness");
        let local_dir = tmp
            .path()
            .join("session-artifacts")
            .join("s1")
            .join("harness");
        // Inputs captured before the run (the live-session half); no
        // harness state exists yet.
        let inputs = super::super::harness_digest::HarnessDigestInputs {
            context: super::super::harness_digest::HarnessDigestContext {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
                include_ipython: true,
                include_shell_examples: true,
                include_refine: true,
            },
            terms: super::super::harness_digest::digest_query_terms(None, &[]),
        };
        // Harness state written after the inputs were captured — the
        // digest must still see it (fresh disk read at the commit).
        let mut state = crate::refinement::empty_harness_state();
        state
            .entries
            .get_mut(&crate::refinement::RefinementKind::Memory)
            .unwrap()
            .insert(
                "compaction_test_memory".to_string(),
                crate::refinement::HarnessEntry {
                    id: "compaction_test_memory".to_string(),
                    kind: crate::refinement::RefinementKind::Memory,
                    title: "Compaction test memory".to_string(),
                    content: "Written before compaction.".to_string(),
                    path: "general".to_string(),
                    scope: Some(crate::refinement::HarnessScope::Local),
                    reference: Default::default(),
                    arguments: Default::default(),
                    metadata: Default::default(),
                    source: "refine".to_string(),
                    created_at: "2026-09-07T00:00:00.000Z".to_string(),
                    updated_at: "2026-09-07T00:00:00.000Z".to_string(),
                    version: 1,
                },
            );
        crate::refinement::save_harness_state(&local_dir, &state).unwrap();
        let result = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings: super::super::compaction::CompactionSettings {
                    keep_recent_tokens: 20,
                    ..Default::default()
                },
                abort: None,
                harness_digest: Some(inputs),
                auxiliary: None,
            },
        )
        .await
        .unwrap();
        let CompactOutcome::Ran(run) = result else {
            panic!("expected the compaction to run");
        };
        let digest = run
            .entry
            .harness_digest
            .as_deref()
            .expect("digest snapshot");
        assert!(digest.contains("Compaction test memory"));
        // Mechanical attachment: the digest never flows through the summarizer.
        assert!(!run.entry.summary.contains("# Continual Harness State"));
        // The durable row carries the TS wire shape (`harnessDigest`).
        let serialized = serde_json::to_value(&run.entry).unwrap();
        assert_eq!(
            serialized
                .get("harnessDigest")
                .and_then(|value| value.as_str()),
            Some(digest)
        );
        // The rebuilt context leads with the digest block before the
        // compaction summary (TS `convertToLlm` on the compaction head).
        let rebuilt = rebuilt_context_after_compaction(&session);
        let Message::User(user) = &rebuilt[0] else {
            panic!("expected compaction head user message");
        };
        let text = user.content.text();
        let digest_at = text
            .find("[harness-digest]")
            .expect("digest block leads the compaction head");
        let summary_at = text
            .find("[compaction-summary]")
            .expect("compaction summary follows");
        assert!(digest_at < summary_at);
        assert!(text.contains("Compaction test memory"));
        registration.unregister();
    }

    /// An error-stop summarizer response fails the compaction (TS throws
    /// `Summarization failed: ...`), never an empty-summary success.
    #[tokio::test]
    async fn execute_compaction_fails_on_an_error_summarizer_response() {
        let registration = faux_registration();
        let model = registration.get_model();
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                "",
                pa_ai::faux::FauxAssistantMessageOptions {
                    stop_reason: Some(pa_types::ai::StopReason::Error),
                    error_message: Some("summarizer exploded".to_string()),
                    ..Default::default()
                },
            ),
        )]);
        let tmp = tempfile::tempdir().unwrap();
        let mut session = session_with_turns(tmp.path(), 3);
        let error = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings: super::super::compaction::CompactionSettings {
                    keep_recent_tokens: 20,
                    ..Default::default()
                },
                abort: None,
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Summarization failed: summarizer exploded"
        );
        // No compaction entry persisted for the failed run.
        assert!(session
            .get_entries()
            .iter()
            .all(|entry| !matches!(entry, FileEntry::Compaction { .. })));
        registration.unregister();
    }

    /// An already-aborted signal cancels the run before any summarizer
    /// request (TS `throwIfAborted` at the top of the provider call):
    /// the abort marker error surfaces and nothing commits.
    #[tokio::test]
    async fn execute_compaction_with_pre_aborted_signal_never_runs_the_summarizer() {
        let registration = faux_registration();
        let model = registration.get_model();
        let controller = pa_agent::abort::AbortController::new();
        controller.abort();
        let signal = controller.signal();
        let tmp = tempfile::tempdir().unwrap();
        let mut session = session_with_turns(tmp.path(), 3);
        let error = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings: super::super::compaction::CompactionSettings {
                    keep_recent_tokens: 20,
                    ..Default::default()
                },
                abort: Some(&signal),
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap_err();
        assert!(pa_agent::abort::is_abort_error(&error), "{error:#}");
        assert!(session
            .get_entries()
            .iter()
            .all(|entry| !matches!(entry, FileEntry::Compaction { .. })));
        registration.unregister();
    }

    /// A signal that aborts while the summarizer is in flight cancels the
    /// run before it commits (TS `_performCompaction`'s
    /// `if (signal.aborted) throw` between the summary and the ledger):
    /// the summarizer's resolved summary never lands as a compaction
    /// entry.
    #[tokio::test]
    async fn execute_compaction_with_late_abort_cancels_before_the_commit() {
        let registration = faux_registration();
        let model = registration.get_model();
        // The delayed response holds the summarizer in flight while the
        // abort lands mid-run.
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Delayed {
            message: pa_ai::faux::faux_assistant_text_message(
                "## Goal\nsummarized goal",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
            delay_ms: 200,
        }]);
        let controller = pa_agent::abort::AbortController::new();
        let signal = controller.signal();
        let aborter = {
            let controller = controller.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                controller.abort();
            })
        };
        let tmp = tempfile::tempdir().unwrap();
        let mut session = session_with_turns(tmp.path(), 3);
        let error = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings: super::super::compaction::CompactionSettings {
                    keep_recent_tokens: 20,
                    ..Default::default()
                },
                abort: Some(&signal),
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap_err();
        aborter.await.unwrap();
        assert!(pa_agent::abort::is_abort_error(&error), "{error:#}");
        assert!(
            session
                .get_entries()
                .iter()
                .all(|entry| !matches!(entry, FileEntry::Compaction { .. })),
            "the late abort never commits the compaction"
        );
        registration.unregister();
    }

    #[tokio::test]
    async fn execute_compaction_skips_short_sessions() {
        let registration = faux_registration();
        let model = registration.get_model();
        let tmp = tempfile::tempdir().unwrap();
        // Three small turns fit inside the keep-recent budget: nothing to
        // summarize, so compaction skips (TS prepareCompaction).
        let mut session = session_with_turns(tmp.path(), 3);
        let outcome = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings: super::super::compaction::CompactionSettings::default(),
                abort: None,
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            outcome,
            CompactOutcome::Skipped("Session is too short to compact — try again once it grows")
        );
        assert!(session
            .get_entries()
            .iter()
            .all(|entry| !matches!(entry, FileEntry::Compaction { .. })));
        registration.unregister();
    }

    #[tokio::test]
    async fn execute_compaction_skips_when_already_compacted() {
        let registration = faux_registration();
        let model = registration.get_model();
        let tmp = tempfile::tempdir().unwrap();
        let mut session = session_with_turns(tmp.path(), 3);
        session
            .append_compaction(pa_types::session::CompactionEntry {
                summary: "summary".to_string(),
                first_kept_entry_id: "e1".to_string(),
                tokens_before: 100,
                ..Default::default()
            })
            .unwrap();
        let outcome = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings: super::super::compaction::CompactionSettings {
                    keep_recent_tokens: 200,
                    ..Default::default()
                },
                abort: None,
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(outcome, CompactOutcome::Skipped("Already compacted"));
        registration.unregister();
    }

    /// A usage-less error turn never anchors `tokensBefore`: the estimate
    /// uses the last settled (probe-measured) usage plus a chars/4
    /// estimate of everything that trails it — the exact TS overflow-row
    /// scenario (`getLastAssistantUsageInfo` skips error turns).
    #[test]
    fn tokens_before_anchors_on_last_valid_usage_plus_trailing() {
        let reply = |usage: pa_types::ai::Usage, error: bool| {
            // A failed request carries no content: the failure lives in
            // `errorMessage` (the TS and Rust durable error turns both
            // record an empty content list).
            let content = if error {
                Vec::new()
            } else {
                vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text: "seed reply".to_string(),
                        text_signature: None,
                        rest: Default::default(),
                    },
                )]
            };
            AgentMessage::Assistant(AssistantMessage {
                content,
                api: "openai-completions".to_string(),
                provider: "test".to_string(),
                model: "m".to_string(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage,
                stop_reason: if error {
                    pa_types::ai::StopReason::Error
                } else {
                    pa_types::ai::StopReason::Stop
                },
                stop_reason_raw: None,
                error_message: None,
                timestamp: 0,
                rest: Default::default(),
            })
        };
        let tmp = tempfile::tempdir().unwrap();
        let mut session = SessionManager::in_memory(tmp.path());
        let settled = pa_types::ai::Usage {
            input: 20,
            output: 10,
            cache_read: 80,
            cache_write: 0,
            total_tokens: 110,
            cost: Default::default(),
        };
        let probe = |text: &str| {
            AgentMessage::User(pa_types::ai::UserMessage {
                content: UserContent::Text(text.to_string()),
                timestamp: 0,
                rest: Default::default(),
            })
        };
        session.append_message(probe("seed turn")).unwrap();
        session.append_message(reply(settled, false)).unwrap();
        session
            .append_message(probe(&("overflow probe ".to_string() + &"x".repeat(400))))
            .unwrap();
        // The overflow error turn: stopReason "error" with zeroed usage
        // (what the provider returns for a failed request).
        session
            .append_message(reply(Default::default(), true))
            .unwrap();
        // TS: 110 (last valid usage) + ceil(415/4) (the probe turn) = 214.
        assert_eq!(
            context_tokens(session.get_all_entries(), session.get_leaf_id()),
            214
        );
    }

    /// The durable row carries the full TS `CompactionEntry` record:
    /// `fromHook: false` (the built-in origin), the summarizer usage, and
    /// the file-operation details — not just the summary boundary.
    #[tokio::test]
    async fn durable_compaction_row_carries_the_ts_record() {
        let registration = faux_registration();
        let model = registration.get_model();
        let tmp = tempfile::tempdir().unwrap();
        let mut session = session_with_turns(tmp.path(), 3);
        let before = context_tokens(session.get_all_entries(), session.get_leaf_id());
        let outcome = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings: super::super::compaction::CompactionSettings {
                    keep_recent_tokens: 20,
                    ..Default::default()
                },
                abort: None,
                harness_digest: None,
                auxiliary: None,
            },
        )
        .await
        .unwrap();
        let CompactOutcome::Ran(run) = outcome else {
            panic!("expected the compaction to run");
        };
        assert_eq!(run.entry.from_hook, Some(false));
        assert_eq!(run.entry.usage, run.result.usage);
        assert_eq!(run.entry.tokens_before, before);
        // The persisted session record is the full entry, byte-for-byte
        // (TS `appendCompaction` stores the same record it returns).
        let persisted = session
            .get_entries()
            .iter()
            .rev()
            .find_map(|entry| match entry {
                FileEntry::Compaction { payload, .. } => Some(payload.clone()),
                _ => None,
            })
            .expect("compaction entry persisted");
        assert_eq!(persisted, run.entry);
    }

    /// An aux context whose settings pin one `auxiliaryModel` selector.
    fn aux_context(
        dir: &std::path::Path,
        selector: Option<&str>,
    ) -> crate::session_engine::auxiliary_model::AuxiliaryModelContext {
        std::fs::write(
            dir.join("settings.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "auxiliaryModel": selector,
            }))
            .unwrap(),
        )
        .unwrap();
        crate::session_engine::auxiliary_model::AuxiliaryModelContext {
            cwd: dir.to_path_buf(),
            agent_dir: dir.to_path_buf(),
        }
    }

    /// The routing context present with a selector equal to the session
    /// model keeps the session model: the compaction's wire call serves
    /// on the session model (the faux factory records the model).
    #[tokio::test]
    async fn compaction_auxiliary_selector_equal_to_the_session_model_runs_on_the_session_model() {
        let registration = faux_registration();
        let model = registration.get_model();
        let tmp = tempfile::tempdir().unwrap();
        let aux = aux_context(tmp.path(), Some("faux/compact-m"));
        let mut session = session_with_turns(tmp.path(), 3);
        let seen_models: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let recorder = seen_models.clone();
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(
            std::sync::Arc::new(
                move |_context: &pa_types::ai::Context,
                      _options: Option<&pa_ai::types::StreamOptions>,
                      _call: u64,
                      model: &pa_types::ai::Model| {
                    recorder.lock().unwrap().push(model.id.clone());
                    Ok(pa_ai::faux::faux_assistant_text_message(
                        "the summary",
                        pa_ai::faux::FauxAssistantMessageOptions::default(),
                    ))
                },
            ),
        )]);
        let outcome = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings: super::super::compaction::CompactionSettings {
                    keep_recent_tokens: 20,
                    ..Default::default()
                },
                abort: None,
                harness_digest: None,
                auxiliary: Some(&aux),
            },
        )
        .await
        .unwrap();
        assert!(matches!(outcome, CompactOutcome::Ran(_)));
        assert_eq!(seen_models.lock().unwrap().as_slice(), ["compact-m"]);
        registration.unregister();
    }

    /// A selector that resolves to no model (unusable) falls back to the
    /// session model with a warning: the compaction still runs.
    #[tokio::test]
    async fn compaction_auxiliary_selector_unusable_falls_back_to_the_session_model() {
        let registration = faux_registration();
        let model = registration.get_model();
        let tmp = tempfile::tempdir().unwrap();
        let aux = aux_context(tmp.path(), Some("testaux/missing-model"));
        let mut session = session_with_turns(tmp.path(), 3);
        let seen_models: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let recorder = seen_models.clone();
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(
            std::sync::Arc::new(
                move |_context: &pa_types::ai::Context,
                      _options: Option<&pa_ai::types::StreamOptions>,
                      _call: u64,
                      model: &pa_types::ai::Model| {
                    recorder.lock().unwrap().push(model.id.clone());
                    Ok(pa_ai::faux::faux_assistant_text_message(
                        "the summary",
                        pa_ai::faux::FauxAssistantMessageOptions::default(),
                    ))
                },
            ),
        )]);
        let outcome = execute_compaction(
            &mut session,
            CompactOptions {
                model,
                api_key: None,
                custom_instructions: None,
                settings: super::super::compaction::CompactionSettings {
                    keep_recent_tokens: 20,
                    ..Default::default()
                },
                abort: None,
                harness_digest: None,
                auxiliary: Some(&aux),
            },
        )
        .await
        .unwrap();
        let CompactOutcome::Ran(run) = outcome else {
            panic!("expected the compaction to run on the fallback model");
        };
        assert_eq!(run.result.summary, "the summary");
        assert_eq!(seen_models.lock().unwrap().as_slice(), ["compact-m"]);
        registration.unregister();
    }

    /// The window estimate covers the exact wire bodies the compaction
    /// will issue (TS #2411's `estimateSummaryRequestTokens`): a split
    /// turn estimates BOTH the history request and the turn-prefix
    /// request (each with the shared system prompt and its own
    /// completion budget), and the no-history split arm estimates only the
    /// prefix call.
    #[test]
    fn summary_window_estimate_covers_both_split_requests() {
        let history = vec![user_message("some history to summarize")];
        let turn_prefix = vec![user_message(&"a very long turn prefix ".repeat(2_000))];
        let full =
            estimate_summary_request_tokens(&history, &turn_prefix, true, None, None, 10_000);
        let history_only =
            estimate_summary_request_tokens(&history, &[], false, None, None, 10_000);
        let prefix_only =
            estimate_summary_request_tokens(&[], &turn_prefix, true, None, None, 10_000);
        // A split turn must fit every request it will issue: the estimate
        // is the larger of the two arms' estimates (each with the shared
        // system prompt and its own completion budget).
        assert_eq!(full, history_only.max(prefix_only));
        assert!(full > history_only);
        // The previous summary and the custom instructions grow the
        // history request, so they grow the estimate.
        let with_anchors = estimate_summary_request_tokens(
            &history,
            &[],
            false,
            Some("the previous summary text"),
            Some("focus on the goal"),
            10_000,
        );
        assert!(with_anchors > history_only);
        // The completion budgets draw on the reserve: a larger reserve
        // grows the estimate.
        let bigger_reserve =
            estimate_summary_request_tokens(&history, &[], false, None, None, 100_000);
        assert!(bigger_reserve > history_only);
    }

    fn user_message(text: &str) -> AgentMessage {
        AgentMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: Default::default(),
        })
    }
}
