//! Harness digest delivery: compose the continual-harness state into the
//! model-facing `[harness-digest]` context message and deliver it at cold
//! context boundaries (session start, resume, compaction head). The
//! deferred first-turn row rides the turn's prompt messages, so the loop
//! carries it on `agent_end` and persists it through its `message_end`
//! (TS commit-time injection). Port of the `_harnessDigest` half of
//! core/agent-session.ts over `format_harness_state_for_prompt`.

use std::path::PathBuf;

use pa_agent::types::{AgentMessage, Message, UserContent, UserPart};
use pa_types::session::{AgentMessage as SessionAgentMessage, FileEntry};

use crate::refinement::ranking::{
    format_harness_state_for_prompt, harness_digest_fingerprint, harness_query_terms,
    HarnessDigestRenderFlags, HarnessQueryTerms, HarnessStatePromptOptions,
};
use crate::refinement::{load_harness_state, merge_harness_states, HarnessScope};

use super::messages::{COMPACTION_SUMMARY_PREFIX, HARNESS_DIGEST_PREFIX, HARNESS_DIGEST_SUFFIX};

/// Session-scoped digest inputs: where harness state lives and which
/// interfaces the digest may reference.
#[derive(Debug, Clone)]
pub struct HarnessDigestContext {
    /// Global harness state directory (`<agent dir>/harness`).
    pub global_dir: PathBuf,
    /// Session-local harness state directory (session artifact dir), when the
    /// session persists artifacts.
    pub local_dir: Option<PathBuf>,
    /// The session exposes the Python REPL (`ipython` tool active).
    pub include_ipython: bool,
    /// The session exposes `bash` as a model tool.
    pub include_shell_examples: bool,
    /// The `refine` skill is visible to the model.
    pub include_refine: bool,
}

/// Relevance terms for digest entry ranking: the active goal objective
/// (strongest) plus the last few user/assistant texts, newest first.
pub fn digest_query_terms(
    goal_objective: Option<&str>,
    recent_texts_newest_first: &[String],
) -> HarnessQueryTerms {
    let mut terms: HarnessQueryTerms = std::collections::HashMap::new();
    fn add_text(terms: &mut HarnessQueryTerms, text: &str, weight: f64) {
        for raw in harness_query_terms(text) {
            if terms.len() >= 48 && !terms.contains_key(&raw) {
                return;
            }
            terms.entry(raw).or_insert(weight);
        }
    }
    add_text(&mut terms, goal_objective.unwrap_or_default(), 3.0);
    let mut recency_weight = 2.0;
    for text in recent_texts_newest_first.iter().take(4) {
        add_text(&mut terms, text, recency_weight);
        recency_weight = (recency_weight - 0.5).max(1.0);
    }
    terms
}

/// One digest render: the body plus the fingerprint of the harness state
/// that produced it (TS `_harnessDigestWithFingerprint`). One merged-state
/// read feeds both, so the fingerprint always matches the rendered
/// digest's material; relevance query terms drive the render but stay out
/// of the fingerprint (the digest is frozen per delivery).
#[derive(Debug, Clone, PartialEq)]
pub struct HarnessDigestRender {
    pub digest: String,
    pub state_fingerprint: String,
}

/// The rendered digest body (the `<harness_state>` content): merged global +
/// local harness state, ranked by the query terms.
pub fn harness_digest_text(
    context: &HarnessDigestContext,
    query_terms: HarnessQueryTerms,
) -> String {
    render_digest_with_fingerprint(context, query_terms).digest
}

/// Render the digest body and its state fingerprint from one merged-state
/// read (TS `_harnessDigestMaterial` + `harnessDigestFingerprint`).
fn render_digest_with_fingerprint(
    context: &HarnessDigestContext,
    query_terms: HarnessQueryTerms,
) -> HarnessDigestRender {
    let global = load_harness_state(&context.global_dir, HarnessScope::Global);
    let local = context
        .local_dir
        .as_ref()
        .map(|dir| load_harness_state(dir, HarnessScope::Local));
    let merged = merge_harness_states(&global, local.as_ref());
    let render_flags = HarnessDigestRenderFlags {
        include_ipython_examples: context.include_ipython,
        include_shell_examples: context.include_shell_examples,
        // TS: includeRefineExamples = hasIpython && hasRefineSkill.
        include_refine_examples: context.include_ipython && context.include_refine,
    };
    let digest = format_harness_state_for_prompt(
        &merged,
        &HarnessStatePromptOptions {
            include_ipython_examples: Some(context.include_ipython),
            include_shell_examples: context.include_shell_examples,
            include_refine_examples: Some(render_flags.include_refine_examples),
            query_terms: Some(query_terms),
            ..Default::default()
        },
    );
    let state_fingerprint = harness_digest_fingerprint(&merged, render_flags);
    HarnessDigestRender {
        digest,
        state_fingerprint,
    }
}

/// Digest inputs captured from the live session (interface flags plus
/// relevance terms); the merged harness-state disk read happens when the
/// digest is rendered, so a render at the compaction commit is a fresh
/// read of harness state written mid-run (TS `_harnessDigest` at the
/// `appendCompaction` call site).
#[derive(Debug, Clone)]
pub struct HarnessDigestInputs {
    pub context: HarnessDigestContext,
    pub terms: HarnessQueryTerms,
}

impl HarnessDigestInputs {
    /// Render the digest body (the `<harness_state>` content).
    pub fn render(&self) -> String {
        self.render_with_fingerprint().digest
    }

    /// Render the digest body plus the fingerprint of the harness state
    /// behind it (TS `_harnessDigestWithFingerprint`): one state read
    /// feeds both, and the relevance terms drive the render only.
    pub fn render_with_fingerprint(&self) -> HarnessDigestRender {
        render_digest_with_fingerprint(&self.context, self.terms.clone())
    }
}

/// Full digest message text (prefix + state + suffix).
pub fn harness_digest_message_text(digest: &str) -> String {
    format!("{HARNESS_DIGEST_PREFIX}{digest}{HARNESS_DIGEST_SUFFIX}")
}

/// The digest as the loop's custom prompt row (TS `createHarnessDigestMessage`
/// riding the turn's prompt messages): role `custom`, the `harness_digest`
/// tag, framed text content, `display: false`, and the raw digest plus its
/// state fingerprint in `details` (TS `HarnessDigestDetails`). The row rides
/// the run's prompt messages (so it appears in `agent_end.messages` and
/// persists through its `message_end`) and converts to a user turn at the
/// loop's LLM boundary.
pub fn harness_digest_prompt_row(
    digest: &str,
    timestamp: u64,
    state_fingerprint: &str,
) -> AgentMessage {
    let custom = pa_types::session::CustomMessage {
        custom_type: super::headless::HARNESS_DIGEST_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(harness_digest_message_text(digest)),
        display: false,
        details: Some(serde_json::json!({
            "digest": digest,
            "stateFingerprint": state_fingerprint,
        })),
        timestamp,
        rest: Default::default(),
    };
    AgentMessage::Custom(pa_agent::types::CustomAgentMessage {
        role: "custom".to_string(),
        payload: serde_json::to_value(&custom).expect("digest row payload serializes"),
    })
}

/// The digest as a session message payload for persistence
/// (`append_custom_message` with `display: false` and the digest plus its
/// state fingerprint in details).
pub fn persist_digest(
    session: &mut crate::session::manager::SessionManager,
    digest: &str,
    state_fingerprint: &str,
) -> std::io::Result<String> {
    session.append_custom_message(
        super::headless::HARNESS_DIGEST_CUSTOM_TYPE,
        pa_types::ai::UserContent::Text(harness_digest_message_text(digest)),
        false,
        Some(serde_json::json!({
            "digest": digest,
            "stateFingerprint": state_fingerprint,
        })),
    )
}

/// The raw digest carried by one loop-context user row, when it carries the
/// digest frame (standalone digest rows and the digest block that leads a
/// compaction-summary row).
fn digest_from_frame(text: &str) -> Option<&str> {
    let after_prefix = text
        .strip_prefix(super::messages::HARNESS_DIGEST_PREFIX)
        .or_else(|| {
            text.find(super::messages::HARNESS_DIGEST_PREFIX)
                .map(|at| &text[at + super::messages::HARNESS_DIGEST_PREFIX.len()..])
        })?;
    let end = after_prefix
        .find(super::messages::HARNESS_DIGEST_SUFFIX)
        .map(|at| &after_prefix[..at])?;
    Some(end.trim_end_matches('\n'))
}

/// Split a leading digest frame off a loop user row's text: the raw digest
/// and the text after the frame's blank-line separator (TS
/// `convertToLlm` renders the digest block with `\n\n` before what
/// follows). A standalone converted digest row leaves an empty remainder;
/// a compaction-summary row leaves its summary text.
fn split_leading_digest_frame(text: &str) -> Option<(&str, &str)> {
    let after_prefix = text.strip_prefix(super::messages::HARNESS_DIGEST_PREFIX)?;
    let suffix_at = after_prefix.find(super::messages::HARNESS_DIGEST_SUFFIX)?;
    let digest = after_prefix[..suffix_at].trim_end_matches('\n');
    let mut remainder = &after_prefix[suffix_at + super::messages::HARNESS_DIGEST_SUFFIX.len()..];
    if let Some(after_separator) = remainder.strip_prefix("\n\n") {
        remainder = after_separator;
    }
    Some((digest, remainder))
}

/// Whether one loop-context row is a delivered digest row: the custom wire
/// shape (TS custom rows) or the user turn a context rebuild converted it
/// into (the whole row is the digest frame).
fn is_digest_row(message: &AgentMessage) -> bool {
    match message {
        AgentMessage::Custom(custom) => {
            custom
                .payload
                .get("customType")
                .and_then(serde_json::Value::as_str)
                == Some(super::headless::HARNESS_DIGEST_CUSTOM_TYPE)
        }
        AgentMessage::Standard(Message::User(user)) => {
            let text = loop_user_text(&user.content);
            split_leading_digest_frame(&text)
                .is_some_and(|(_, remainder)| remainder.trim().is_empty())
        }
        _ => false,
    }
}

/// Strip a live compaction-summary row's superseded digest block (TS #2394
/// clears `harnessDigest` on the in-context summary): the summary text
/// stays, byte-identical with a summary that never carried a snapshot.
fn strip_compaction_digest_block(message: AgentMessage) -> AgentMessage {
    let AgentMessage::Standard(Message::User(user)) = &message else {
        return message;
    };
    let text = loop_user_text(&user.content);
    let Some((_, summary_text)) = split_leading_digest_frame(&text) else {
        return message;
    };
    if !summary_text.starts_with(COMPACTION_SUMMARY_PREFIX) {
        return message;
    }
    let mut stripped = message;
    let AgentMessage::Standard(Message::User(user)) = &mut stripped else {
        return stripped;
    };
    match &mut user.content {
        UserContent::Text(text) => *text = summary_text.to_string(),
        UserContent::Parts(parts) => {
            for part in parts.iter_mut() {
                if let UserPart::Text(text) = part {
                    text.text = summary_text.to_string();
                }
            }
        }
    }
    stripped
}

/// The newest in-context digest and the state fingerprint it carries (TS
/// `_latestContextHarnessDigestDetails`). A delivered digest row rides the
/// loop as its custom wire shape (details digest + `stateFingerprint`, TS
/// custom rows) or as the user turn it converts to at a context rebuild
/// (the digest frame, plus the digest block that leads a compaction-summary
/// row) — the converted shapes carry no fingerprint, so a fingerprint-less
/// latest falls back to rendered-text comparison (TS
/// `_harnessDigestIsFresh`). Recency is by timestamp, not position -
/// retained pre-compaction rows follow the compaction head, and
/// out-of-context file entries must never suppress a cold-boundary delivery.
#[derive(Debug, Clone, PartialEq)]
pub struct LatestContextDigest {
    pub timestamp: i64,
    pub digest: String,
    pub state_fingerprint: Option<String>,
}

pub fn latest_context_digest_details(messages: &[AgentMessage]) -> Option<LatestContextDigest> {
    let mut latest: Option<LatestContextDigest> = None;
    fn consider(
        latest: &mut Option<LatestContextDigest>,
        timestamp: i64,
        digest: &str,
        state_fingerprint: Option<&str>,
    ) {
        if latest
            .as_ref()
            .is_none_or(|kept| timestamp > kept.timestamp)
        {
            *latest = Some(LatestContextDigest {
                timestamp,
                digest: digest.to_string(),
                state_fingerprint: state_fingerprint.map(str::to_string),
            });
        }
    }
    for message in messages {
        match message {
            AgentMessage::Standard(Message::User(user)) => {
                let text = match &user.content {
                    UserContent::Text(text) => text.as_str(),
                    UserContent::Parts(parts) => parts
                        .iter()
                        .find_map(|part| match part {
                            UserPart::Text(text) => Some(text.text.as_str()),
                            _ => None,
                        })
                        .unwrap_or(""),
                };
                let Some(digest) = digest_from_frame(text) else {
                    continue;
                };
                consider(&mut latest, user.timestamp, digest, None);
            }
            AgentMessage::Custom(custom) => {
                let payload = &custom.payload;
                if payload
                    .get("customType")
                    .and_then(serde_json::Value::as_str)
                    != Some(super::headless::HARNESS_DIGEST_CUSTOM_TYPE)
                {
                    continue;
                }
                let Some(digest) = payload
                    .pointer("/details/digest")
                    .and_then(serde_json::Value::as_str)
                else {
                    continue;
                };
                let state_fingerprint = payload
                    .pointer("/details/stateFingerprint")
                    .and_then(serde_json::Value::as_str);
                consider(
                    &mut latest,
                    payload
                        .get("timestamp")
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or(0),
                    digest,
                    state_fingerprint,
                );
            }
            _ => continue,
        }
    }
    latest
}

/// The newest digest recorded in the session's typed context rows (TS
/// `_latestContextHarnessDigestDetails` over typed messages): digest custom
/// rows carry `details.digest` + `details.stateFingerprint`, and a
/// compaction summary carries `harnessDigest` + `harnessStateFingerprint`.
/// The live loop context holds the LLM-shaped rows a rebuild produced, which
/// dropped those payloads; this typed view is where a fingerprint-less
/// latest recovers its fingerprint from.
fn latest_typed_digest_details(messages: &[SessionAgentMessage]) -> Option<LatestContextDigest> {
    let mut latest: Option<LatestContextDigest> = None;
    fn consider(
        latest: &mut Option<LatestContextDigest>,
        timestamp: u64,
        digest: &str,
        state_fingerprint: Option<&str>,
    ) {
        if latest
            .as_ref()
            .is_none_or(|kept| timestamp as i64 > kept.timestamp)
        {
            *latest = Some(LatestContextDigest {
                timestamp: timestamp as i64,
                digest: digest.to_string(),
                state_fingerprint: state_fingerprint.map(str::to_string),
            });
        }
    }
    for message in messages {
        match message {
            SessionAgentMessage::Custom(custom) => {
                if custom.custom_type != super::headless::HARNESS_DIGEST_CUSTOM_TYPE {
                    continue;
                }
                let Some(details) = custom.details.as_ref() else {
                    continue;
                };
                let Some(digest) = details.get("digest").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                consider(
                    &mut latest,
                    custom.timestamp,
                    digest,
                    details
                        .get("stateFingerprint")
                        .and_then(serde_json::Value::as_str),
                );
            }
            SessionAgentMessage::CompactionSummary(summary) => {
                let Some(digest) = summary.harness_digest.as_deref() else {
                    continue;
                };
                consider(
                    &mut latest,
                    summary.timestamp,
                    digest,
                    summary.harness_state_fingerprint.as_deref(),
                );
            }
            _ => continue,
        }
    }
    latest
}

/// Session artifact directory implied by a conversation-log path
/// (`dirname(dirname(file))/session-artifacts/<id>`, TS
/// `getSessionArtifactPathForFile`); used when the caller owns persistence
/// outside the session manager (the daemon worker's in-memory session).
pub fn session_artifact_dir_for_log(log: &std::path::Path) -> Option<PathBuf> {
    let id = log.file_stem()?.to_string_lossy().to_string();
    let artifacts_root = log.parent()?.parent()?.join("session-artifacts");
    Some(artifacts_root.join(id))
}

/// Session-local harness state directory implied by a conversation-log path
/// (the artifact dir plus the harness subdir); used when the caller owns
/// persistence.
pub fn local_harness_dir_for_log(log: &std::path::Path) -> Option<PathBuf> {
    session_artifact_dir_for_log(log).map(|dir| dir.join(crate::refinement::HARNESS_STATE_DIR_NAME))
}

/// Session message view of the digest entries (resume context rebuild).
pub fn digest_session_message(entry: &FileEntry) -> Option<SessionAgentMessage> {
    let FileEntry::CustomMessage { payload, .. } = entry else {
        return None;
    };
    if payload.custom_type != super::headless::HARNESS_DIGEST_CUSTOM_TYPE {
        return None;
    }
    Some(SessionAgentMessage::Custom(
        pa_types::session::CustomMessage {
            custom_type: payload.custom_type.clone(),
            content: payload.content.clone(),
            display: payload.display,
            details: payload.details.clone(),
            timestamp: crate::session::timestamp_to_millis(entry.timestamp()),
            rest: Default::default(),
        },
    ))
}

// Delivery mechanics live with the digest composition (cold-boundary
// delivery is one invariant, TS `_ensureHarnessDigestContext` /
// `_appendHarnessDigestIfStale`): the `AgentSession` methods that drive
// it. Private `AgentSession` fields are reachable from this child module.
impl super::AgentSession {
    /// Cold-boundary digest delivery (session start / resume): empty contexts
    /// defer to the first committed turn; non-empty contexts append only when
    /// the newest in-context digest is stale against disk. The row lands
    /// silently (TS `_appendHarnessDigestIfStale` pushes without events).
    pub(crate) async fn ensure_harness_digest_context(&self) -> anyhow::Result<()> {
        let state = self.agent.state().await;
        let empty = state.messages.is_empty();
        drop(state);
        if empty {
            self.digest_pending
                .store(true, std::sync::atomic::Ordering::SeqCst);
        } else {
            self.append_stale_harness_digest().await?;
        }
        Ok(())
    }

    /// The deferred first-turn digest as the prompt row that rides the turn's
    /// admission (TS commit-time injection): the caller prepends it to the
    /// turn's prompt messages, so the loop streams its `message_start` /
    /// `message_end` pair ahead of the user prompt, carries it into the
    /// context and the run's `agent_end` message list, and persists it
    /// through its `message_end`. The row carries the digest's state
    /// fingerprint (TS `createHarnessDigestMessage` details). `None` when
    /// nothing was pending or the digest is current against the live
    /// context; the pending flag is consumed either way (TS clears
    /// `_harnessDigestPending` before the staleness check).
    pub(crate) async fn pending_digest_prompt_row(&self) -> anyhow::Result<Option<AgentMessage>> {
        if !self
            .digest_pending
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Ok(None);
        }
        Ok(self.fresh_digest().await.map(|render| {
            harness_digest_prompt_row(
                &render.digest,
                super::now_millis(),
                &render.state_fingerprint,
            )
        }))
    }

    /// The digest inputs captured from the live session (TS `_harnessDigest`
    /// sources): the interface flags plus relevance terms from the goal
    /// objective and the last few user/assistant texts. `None` when the
    /// session carries no harness state. The harness-state disk read is
    /// deferred to render time so a snapshot taken before a long-running
    /// operation (the compaction summarizer) still reads fresh state at
    /// its commit.
    pub(crate) async fn harness_digest_inputs(&self) -> Option<HarnessDigestInputs> {
        let context = self.harness_digest.clone()?;
        let recent_texts = self.recent_message_texts_newest_first().await;
        let goal = {
            let session = self.session.lock().await;
            super::goal_driver::GoalDriver::load_persisted(&session)
                .state()
                .objective
                .clone()
        };
        let terms = digest_query_terms(goal.as_deref(), &recent_texts);
        Some(HarnessDigestInputs { context, terms })
    }

    /// The digest to deliver at this boundary, when the newest in-context
    /// digest is stale against it (TS `_appendHarnessDigestIfStale`'s
    /// staleness check over `_harnessDigestIsFresh`): a fingerprint match
    /// is fresh regardless of the rendered text, so query-term drift no
    /// longer re-delivers an unchanged state (TS #2400); a latest without
    /// a fingerprint compares rendered text instead (TS fallback). The
    /// comparison is against the live loop context only — pruned file
    /// entries are not in-context digests and must not suppress delivery.
    async fn fresh_digest(&self) -> Option<HarnessDigestRender> {
        let fresh = self
            .harness_digest_inputs()
            .await?
            .render_with_fingerprint();
        let mut latest = latest_context_digest_details(&self.agent.state().await.messages);
        // Fingerprint recovery for converted rows (TS keeps typed loop
        // contexts; this port converts at rebuild boundaries, which drops
        // the typed payload): the session's built context holds the same
        // rows with their fingerprints, so a fingerprint-less latest borrows
        // the typed row's fingerprint when it is the same digest.
        if latest
            .as_ref()
            .is_some_and(|details| details.state_fingerprint.is_none())
        {
            let session = self.session.lock().await;
            if let Some(typed) = latest_typed_digest_details(&session.active_context().messages) {
                if latest
                    .as_ref()
                    .is_some_and(|details| details.digest == typed.digest)
                {
                    latest.as_mut().unwrap().state_fingerprint = typed.state_fingerprint;
                }
            }
        }
        let fresh_matches = match latest {
            Some(latest) => match latest.state_fingerprint.as_deref() {
                Some(state_fingerprint) => state_fingerprint == fresh.state_fingerprint,
                None => latest.digest == fresh.digest,
            },
            None => false,
        };
        (!fresh_matches).then_some(fresh)
    }

    /// Deliver a stale digest onto an already-populated loop context (TS
    /// `_appendHarnessDigestIfStale` from `_ensureHarnessDigestContext`):
    /// no run carries the row, so it is pushed directly onto the context
    /// and persisted eagerly, without events. The fresh digest is
    /// authoritative and older in-context copies are regenerable
    /// redundancy, so the append replaces them instead of stacking (TS
    /// #2394): delivered digest rows drop, and a live compaction-summary
    /// row yields its digest block so the context renders exactly one
    /// digest. Persisted transcripts keep every copy; the newest digest
    /// remains authoritative.
    async fn append_stale_harness_digest(&self) -> anyhow::Result<()> {
        let Some(render) = self.fresh_digest().await else {
            return Ok(());
        };
        let message = harness_digest_prompt_row(
            &render.digest,
            super::now_millis(),
            &render.state_fingerprint,
        );
        let mut messages: Vec<AgentMessage> = self
            .agent
            .state()
            .await
            .messages
            .into_iter()
            .filter(|existing| !is_digest_row(existing))
            .map(strip_compaction_digest_block)
            .collect();
        messages.push(message);
        self.agent.set_messages(messages).await;
        let mut session = self.session.lock().await;
        persist_digest(&mut session, &render.digest, &render.state_fingerprint)?;
        Ok(())
    }

    /// The last four user/assistant texts, newest first (digest ranking).
    async fn recent_message_texts_newest_first(&self) -> Vec<String> {
        use pa_agent::types::{AgentMessage, AssistantContent, Message};
        let state = self.agent.state().await;
        let mut texts: Vec<String> = state
            .messages
            .iter()
            .filter_map(|message| match message {
                AgentMessage::Standard(Message::User(user)) => Some(loop_user_text(&user.content)),
                AgentMessage::Standard(Message::Assistant(assistant)) => {
                    let text = assistant
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            AssistantContent::Text(text) => Some(text.text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    (!text.is_empty()).then_some(text)
                }
                _ => None,
            })
            .collect();
        texts.truncate(4);
        texts.reverse();
        texts
    }
}

/// The text of a loop user message (string content or joined text parts).
fn loop_user_text(content: &pa_agent::types::UserContent) -> String {
    match content {
        pa_agent::types::UserContent::Text(text) => text.clone(),
        pa_agent::types::UserContent::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                pa_agent::types::UserPart::Text(text) => Some(text.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::manager::SessionManager;
    use pa_agent::types::UserMessage;
    use serde_json::Value;

    #[test]
    fn empty_state_digest_renders_placeholder() {
        let tmp = tempfile::tempdir().unwrap();
        let context = HarnessDigestContext {
            global_dir: tmp.path().join("harness"),
            local_dir: None,
            include_ipython: true,
            include_shell_examples: false,
            include_refine: true,
        };
        let digest = harness_digest_text(&context, HarnessQueryTerms::default());
        assert!(digest.starts_with("# Continual Harness State"));
        assert!(digest.contains("No saved harness entries yet."));
        assert!(digest.contains("recent refinements: 0"));
        assert!(digest.contains("When to call `await refine.run()`"));
        // The framed message text wraps the state block.
        let message = harness_digest_message_text(&digest);
        assert!(message.starts_with("[harness-digest]"));
        assert!(message.ends_with("</harness_state>"));
    }

    #[test]
    fn query_terms_weight_goal_and_recency() {
        let terms = digest_query_terms(
            Some("fix the worktree parity battery"),
            &["continue the parity work".to_string()],
        );
        assert_eq!(terms.get("worktree"), Some(&3.0));
        assert_eq!(terms.get("parity"), Some(&3.0));
        assert_eq!(terms.get("continue"), Some(&2.0));
    }

    #[test]
    fn persisted_digest_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let mut session = SessionManager::persisted(tmp.path(), &tmp.path().join("sessions"));
        let id = persist_digest(&mut session, "digest body", "fingerprint-1").unwrap();
        let _ = id;
        let entries = session.get_all_entries().to_vec();
        let FileEntry::CustomMessage { payload, .. } = &entries[1] else {
            panic!("expected digest entry");
        };
        assert_eq!(
            payload
                .details
                .as_ref()
                .and_then(|details| details.get("digest"))
                .and_then(serde_json::Value::as_str),
            Some("digest body")
        );
        assert_eq!(
            payload
                .details
                .as_ref()
                .and_then(|details| details.get("stateFingerprint"))
                .and_then(serde_json::Value::as_str),
            Some("fingerprint-1")
        );
        let message = digest_session_message(&entries[1]).expect("digest entry");
        let SessionAgentMessage::Custom(custom) = &message else {
            panic!("expected custom message");
        };
        assert_eq!(custom.custom_type, "harness_digest");
        assert!(!custom.display);
        assert!(matches!(custom.content, pa_types::ai::UserContent::Text(_)));
        // The loop prompt row is the custom wire shape: role `custom`, the
        // `harness_digest` tag, framed text, `display: false`, the raw
        // digest plus its state fingerprint in `details` (TS
        // `createHarnessDigestMessage`).
        let loop_row = harness_digest_prompt_row("digest body", 0, "fingerprint-1");
        let AgentMessage::Custom(custom) = &loop_row else {
            panic!("expected custom row");
        };
        assert_eq!(custom.role, "custom");
        assert_eq!(
            custom.payload.get("customType").and_then(Value::as_str),
            Some("harness_digest")
        );
        assert_eq!(
            custom.payload.get("content").and_then(Value::as_str),
            Some(harness_digest_message_text("digest body").as_str())
        );
        assert_eq!(
            custom.payload.get("display").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            custom
                .payload
                .pointer("/details/digest")
                .and_then(Value::as_str),
            Some("digest body")
        );
        assert_eq!(
            custom
                .payload
                .pointer("/details/stateFingerprint")
                .and_then(Value::as_str),
            Some("fingerprint-1")
        );
        // The row round-trips to its session wire shape (persistence reads
        // it back through the shared wire form).
        let session_view: SessionAgentMessage =
            serde_json::from_value(serde_json::to_value(&loop_row).unwrap()).unwrap();
        assert!(matches!(session_view, SessionAgentMessage::Custom(_)));
        // The loop-context staleness view reads the digest and its
        // fingerprint out of the row, so a delivered digest row suppresses
        // re-delivery while it is the newest (TS
        // `_latestContextHarnessDigestDetails`).
        let mut context = vec![loop_row.clone()];
        assert_eq!(
            latest_context_digest_details(&context).map(|details| (
                details.digest.as_str(),
                details.state_fingerprint.as_deref()
            )),
            Some(("digest body", Some("fingerprint-1")))
        );
        context.push(harness_digest_prompt_row(
            "newer digest",
            2,
            "fingerprint-2",
        ));
        assert_eq!(
            latest_context_digest_details(&context).map(|details| (
                details.digest.as_str(),
                details.state_fingerprint.as_deref()
            )),
            Some(("newer digest", Some("fingerprint-2")))
        );
        // A context with no digest rows never suppresses delivery.
        assert_eq!(latest_context_digest_details(&[]), None);
        // The typed session view reads the same details off the session
        // wire shape (TS compaction summaries carry the fingerprint the
        // same way).
        let typed = latest_typed_digest_details(&[message]);
        assert_eq!(
            typed.map(|details| (
                details.digest.as_str(),
                details.state_fingerprint.as_deref()
            )),
            Some(("digest body", Some("fingerprint-1")))
        );
    }

    #[test]
    fn append_replaces_older_digest_rows_and_strips_snapshot_blocks() {
        // A delivered custom digest row and its converted user-turn form are
        // both digest rows (TS #2394 drops every older copy on append).
        let custom = harness_digest_prompt_row("older digest", 1, "fp-1");
        assert!(is_digest_row(&custom));
        let converted = AgentMessage::Standard(Message::User(UserMessage {
            content: UserContent::Text(harness_digest_message_text("older digest")),
            timestamp: 1,
            rest: Default::default(),
        }));
        assert!(is_digest_row(&converted));
        // A plain user row and an unrelated custom row are not.
        let plain = AgentMessage::Standard(Message::User(UserMessage {
            content: UserContent::Text("a question".to_string()),
            timestamp: 2,
            rest: Default::default(),
        }));
        assert!(!is_digest_row(&plain));
        let unrelated = AgentMessage::Custom(pa_agent::types::CustomAgentMessage {
            role: "custom".to_string(),
            payload: serde_json::json!({"customType": "extension_note"}),
        });
        assert!(!is_digest_row(&unrelated));

        // A live compaction-summary row yields its superseded digest block
        // when a fresh digest is appended: the summary text stays,
        // byte-identical with a summary that never carried a snapshot.
        let summary_text =
            format!("{COMPACTION_SUMMARY_PREFIX}the story so far{COMPACTION_SUMMARY_SUFFIX}");
        let summary_with_block = AgentMessage::Standard(Message::User(UserMessage {
            content: UserContent::Text(format!(
                "{HARNESS_DIGEST_PREFIX}stale snapshot{HARNESS_DIGEST_SUFFIX}\n\n{summary_text}"
            )),
            timestamp: 3,
            rest: Default::default(),
        }));
        let stripped = strip_compaction_digest_block(summary_with_block);
        let AgentMessage::Standard(Message::User(user)) = &stripped else {
            panic!("expected the compaction row to stay");
        };
        assert_eq!(user.content.text(), summary_text);
        assert!(!is_digest_row(&stripped));
        // The same strip on an already-plain summary row is a no-op.
        let plain_summary = AgentMessage::Standard(Message::User(UserMessage {
            content: UserContent::Text(summary_text.clone()),
            timestamp: 4,
            rest: Default::default(),
        }));
        let untouched = strip_compaction_digest_block(plain_summary.clone());
        assert_eq!(untouched, plain_summary);
    }

    #[test]
    fn out_of_context_file_entries_never_count_as_context_digests() {
        // A compaction-summary user row carries its digest block first; the
        // frame reader extracts that digest, and a compaction row without a
        // digest block contributes nothing.
        let wrapped = AgentMessage::Standard(Message::User(UserMessage {
            content: UserContent::Text(format!(
                "{HARNESS_DIGEST_PREFIX}compaction head digest{HARNESS_DIGEST_SUFFIX}\n\n[compaction] summary text"
            )),
            timestamp: 5,
        }));
        assert_eq!(
            latest_context_digest_details(&[wrapped]).map(|details| details.digest),
            Some("compaction head digest".to_string())
        );
        let no_digest = AgentMessage::Standard(Message::User(UserMessage {
            content: UserContent::Text("[compaction] summary text".to_string()),
            timestamp: 6,
        }));
        assert_eq!(latest_context_digest_details(&[no_digest]), None);
    }
}
