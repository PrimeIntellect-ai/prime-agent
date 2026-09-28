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
    fn add_text(terms: &mut HarnessQueryTerms, text: &str, weight: f64) {
        for raw in harness_query_terms(text) {
            if terms.len() >= 48 && !terms.contains_key(&raw) {
                return;
            }
            terms.entry(raw).or_insert(weight);
        }
    }
    let mut terms: HarnessQueryTerms = std::collections::HashMap::new();
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
///
/// # Panics
///
/// Panics if serializing the digest row payload fails, which cannot happen
/// for the plain message struct.
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
        rest: serde_json::Map::default(),
    };
    AgentMessage::Custom(pa_agent::types::CustomAgentMessage {
        role: "custom".to_string(),
        payload: serde_json::to_value(&custom).expect("digest row payload serializes"),
    })
}

/// The digest as a session message payload for persistence
/// (`append_custom_message` with `display: false` and the digest plus its
/// state fingerprint in details).
///
/// # Errors
///
/// Returns the underlying I/O error when the durable append fails.
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

/// Whether one loop-context row is a delivered digest row: the custom wire
/// shape (TS custom rows), or the user turn a context rebuild converted the
/// newest in-context digest into — matched byte-exactly against that
/// digest's frame. A converted row is the whole frame and nothing else, so
/// a user turn that merely quotes the digest (or prefixes/suffixes anything
/// around it) is never mistaken for bookkeeping and survives the refresh.
fn is_digest_row(message: &AgentMessage, latest_digest: Option<&str>) -> bool {
    match message {
        AgentMessage::Custom(custom) => {
            custom
                .payload
                .get("customType")
                .and_then(serde_json::Value::as_str)
                == Some(super::headless::HARNESS_DIGEST_CUSTOM_TYPE)
        }
        AgentMessage::Standard(Message::User(user)) => latest_digest.is_some_and(|digest| {
            loop_user_text(&user.content) == harness_digest_message_text(digest)
        }),
        AgentMessage::Standard(_) => false,
    }
}

/// Strip a live compaction-summary row's superseded digest block (TS #2394
/// clears `harnessDigest` on the in-context summary): the summary text
/// stays, byte-identical with a summary that never carried a snapshot.
/// The block must be the newest in-context digest's frame — the row a
/// rebuild produced — never a user turn that quotes the digest prefix.
fn strip_compaction_digest_block(
    message: AgentMessage,
    latest_digest: Option<&str>,
) -> AgentMessage {
    let AgentMessage::Standard(Message::User(user)) = &message else {
        return message;
    };
    let Some(digest) = latest_digest else {
        return message;
    };
    let text = loop_user_text(&user.content);
    let frame = format!("{HARNESS_DIGEST_PREFIX}{digest}{HARNESS_DIGEST_SUFFIX}\n\n");
    let Some(summary_text) = text.strip_prefix(&frame) else {
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
    let mut latest: Option<LatestContextDigest> = None;
    for message in messages {
        match message {
            AgentMessage::Standard(Message::User(user)) => {
                let text = match &user.content {
                    UserContent::Text(text) => text.as_str(),
                    UserContent::Parts(parts) => parts
                        .iter()
                        .find_map(|part| match part {
                            UserPart::Text(text) => Some(text.text.as_str()),
                            UserPart::Image(_) => None,
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
            AgentMessage::Standard(_) => {}
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
    let mut latest: Option<LatestContextDigest> = None;
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
            _ => {}
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
            rest: serde_json::Map::default(),
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
        // The newest in-context digest is the provenance marker for the
        // rows a rebuild converted: they are its exact frame, so the strip
        // never matches a user turn that merely quotes the digest.
        let latest_digest = latest_context_digest_details(&self.agent.state().await.messages)
            .map(|details| details.digest);
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
            .filter(|existing| !is_digest_row(existing, latest_digest.as_deref()))
            .map(|row| strip_compaction_digest_block(row, latest_digest.as_deref()))
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
                pa_agent::types::UserPart::Image(_) => None,
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

    use super::super::messages::COMPACTION_SUMMARY_SUFFIX;

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
            latest_context_digest_details(&context)
                .map(|details| (details.digest, details.state_fingerprint)),
            Some(("digest body".to_string(), Some("fingerprint-1".to_string())))
        );
        context.push(harness_digest_prompt_row(
            "newer digest",
            2,
            "fingerprint-2",
        ));
        assert_eq!(
            latest_context_digest_details(&context)
                .map(|details| (details.digest, details.state_fingerprint)),
            Some((
                "newer digest".to_string(),
                Some("fingerprint-2".to_string())
            ))
        );
        // A context with no digest rows never suppresses delivery.
        assert_eq!(latest_context_digest_details(&[]), None);
        // The typed session view reads the same details off the session
        // wire shape (TS compaction summaries carry the fingerprint the
        // same way).
        let typed = latest_typed_digest_details(&[message]);
        assert_eq!(
            typed.map(|details| (details.digest, details.state_fingerprint)),
            Some(("digest body".to_string(), Some("fingerprint-1".to_string())))
        );
    }

    #[test]
    fn append_replaces_older_digest_rows_and_strips_snapshot_blocks() {
        // A delivered custom digest row and its converted user-turn form are
        // both digest rows (TS #2394 drops every older copy on append) —
        // the converted form matches the newest in-context digest's frame
        // byte-exactly, nothing looser.
        let custom = harness_digest_prompt_row("older digest", 1, "fp-1");
        assert!(is_digest_row(&custom, None));
        let converted = AgentMessage::Standard(Message::User(UserMessage {
            content: UserContent::Text(harness_digest_message_text("older digest")),
            timestamp: 1,
        }));
        assert!(is_digest_row(&converted, Some("older digest")));
        // A user turn that quotes the digest — trailing text follows, or
        // the frame of a DIFFERENT digest — never matches, so submissions
        // survive the refresh. No newest digest means no converted rows
        // exist to match either.
        let quoted = AgentMessage::Standard(Message::User(UserMessage {
            content: UserContent::Text(format!(
                "{} what is this block?",
                harness_digest_message_text("older digest")
            )),
            timestamp: 2,
        }));
        assert!(!is_digest_row(&quoted, Some("older digest")));
        assert!(!is_digest_row(&converted, Some("another digest")));
        assert!(!is_digest_row(&converted, None));
        // A plain user row and an unrelated custom row are not.
        let plain = AgentMessage::Standard(Message::User(UserMessage {
            content: UserContent::Text("a question".to_string()),
            timestamp: 2,
        }));
        assert!(!is_digest_row(&plain, Some("older digest")));
        let unrelated = AgentMessage::Custom(pa_agent::types::CustomAgentMessage {
            role: "custom".to_string(),
            payload: serde_json::json!({"customType": "extension_note"}),
        });
        assert!(!is_digest_row(&unrelated, Some("older digest")));

        // A live compaction-summary row yields its superseded digest block
        // when a fresh digest is appended: the summary text stays,
        // byte-identical with a summary that never carried a snapshot.
        let summary_text =
            format!("{COMPACTION_SUMMARY_PREFIX}the story so far{COMPACTION_SUMMARY_SUFFIX}");
        let block_with = |summary_text: String| {
            AgentMessage::Standard(Message::User(UserMessage {
                content: UserContent::Text(format!(
                    "{HARNESS_DIGEST_PREFIX}stale snapshot{HARNESS_DIGEST_SUFFIX}\n\n{summary_text}"
                )),
                timestamp: 3,
            }))
        };
        let summary_with_block = block_with(summary_text.clone());
        let stripped = strip_compaction_digest_block(summary_with_block, Some("stale snapshot"));
        let AgentMessage::Standard(Message::User(user)) = &stripped else {
            panic!("expected the compaction row to stay");
        };
        assert_eq!(loop_user_text(&user.content), summary_text);
        assert!(!is_digest_row(&stripped, Some("stale snapshot")));
        // The same strip on an already-plain summary row is a no-op, as is
        // a strip without a newest digest to anchor the frame.
        let plain_summary = AgentMessage::Standard(Message::User(UserMessage {
            content: UserContent::Text(summary_text),
            timestamp: 4,
        }));
        let untouched =
            strip_compaction_digest_block(plain_summary.clone(), Some("stale snapshot"));
        assert_eq!(untouched, plain_summary);
        let block_again = block_with(format!(
            "{COMPACTION_SUMMARY_PREFIX}the story so far{COMPACTION_SUMMARY_SUFFIX}"
        ));
        assert_eq!(
            strip_compaction_digest_block(block_again.clone(), None),
            block_again
        );
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

    // ---- The compact digest-capture placement oracles ----
    //
    // TS `_performCompaction` computes `_harnessDigestWithFingerprint()`
    // at the commit — after the summarizer, immediately before
    // `appendCompaction`. The port captures the digest INPUTS at compact
    // ENTER (`AgentSession::compact` -> `harness_digest_inputs()`) and
    // renders them at the commit (`execute_compaction`), so the products
    // agree on the render point and differ on the capture point. TS
    // freezes the whole window — `isCompacting` spans `_performCompaction`
    // and `_isBusyForSessionInput("pump")` defers the input pump on it —
    // so TS's commit capture never observes rows admitted mid-compaction.
    // The ENTER capture is strictly earlier and therefore matches TS's
    // effective content in every class; a commit-time capture in this
    // port would not (the turn runner defers only on admission pauses and
    // the queued-input suspension, so a resume-site admission — a steer
    // command, a prompt with streamingBehavior — starts a turn DURING the
    // compaction and lands its user row on the live context). The oracles
    // pin both halves: the frozen-class byte-identity across the two
    // placements, and the racing class where a commit-time capture would
    // observe rows the ENTER capture — and TS — never see.

    /// One keyword-distinct harness memory for the placement fixtures.
    fn placement_memory(
        id: &str,
        title: &str,
        content: &str,
        scope: crate::refinement::HarnessScope,
    ) -> crate::refinement::HarnessEntry {
        crate::refinement::HarnessEntry {
            id: id.to_string(),
            kind: crate::refinement::RefinementKind::Memory,
            title: title.to_string(),
            content: content.to_string(),
            path: "general".to_string(),
            scope: Some(scope),
            reference: serde_json::Map::default(),
            arguments: serde_json::Map::default(),
            metadata: serde_json::Map::default(),
            source: "refine".to_string(),
            created_at: "2026-09-07T00:00:00.000Z".to_string(),
            updated_at: "2026-09-07T00:00:00.000Z".to_string(),
            version: 1,
        }
    }

    /// The placement-oracle rig: a live context and durable entries that
    /// agree — `u0`/`a0` plus the interrupted turn's unanswered `u1` (the
    /// natural mid-turn `/compact` shape: TS `compact()` aborts the run
    /// first and the aborted reply never lands) — with a persisted active
    /// goal and two keyword-distinct harness memories on disk (at zero
    /// query terms the render order is the entry key order, wombat before
    /// zebra, so a ranking flip is observable). The faux summarizer's
    /// response is held `delay_ms`, so the ENTER→commit window stays open
    /// for mid-window sampling; `call_count()` is the served-path signal
    /// that the summarizer request is in flight.
    async fn placement_rig(
        tmp: &tempfile::TempDir,
        delay_ms: u64,
    ) -> (
        crate::session_engine::AgentSession,
        pa_ai::faux::FauxProviderRegistration,
        Option<String>,
    ) {
        let registration = pa_ai::faux::register_faux_provider(
            pa_ai::faux::RegisterFauxProviderOptions {
                models: Some(vec![pa_ai::faux::FauxModelDefinition {
                    id: "digest-placement-m".to_string(),
                    name: Some("Digest Placement Model".to_string()),
                    reasoning: Some(false),
                    input: Some(vec![pa_types::ai::ModelInput::Text]),
                    cost: None,
                    context_window: Some(1_000),
                    max_tokens: Some(256),
                }]),
                ..Default::default()
            },
        );
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Delayed {
            message: pa_ai::faux::faux_assistant_text_message(
                "## Goal\nsummarized goal",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
            delay_ms,
        }]);
        let global_dir = tmp.path().join("agent").join("harness");
        let local_dir = tmp
            .path()
            .join("session-artifacts")
            .join("s1")
            .join("harness");
        let mut global = crate::refinement::empty_harness_state();
        global
            .entries
            .get_mut(&crate::refinement::RefinementKind::Memory)
            .unwrap()
            .insert(
                "aaa_wombat".to_string(),
                placement_memory(
                    "aaa_wombat",
                    "wombat widget notes",
                    "the wombat widget checklist lives here",
                    crate::refinement::HarnessScope::Global,
                ),
            );
        crate::refinement::save_harness_state(&global_dir, &global).unwrap();
        let mut local = crate::refinement::empty_harness_state();
        local
            .entries
            .get_mut(&crate::refinement::RefinementKind::Memory)
            .unwrap()
            .insert(
                "bbb_zebra".to_string(),
                placement_memory(
                    "bbb_zebra",
                    "zebra gadget notes",
                    "the zebra gadget checklist lives here",
                    crate::refinement::HarnessScope::Local,
                ),
            );
        crate::refinement::save_harness_state(&local_dir, &local).unwrap();

        // Durable entries: two settled turns plus the interrupted turn's
        // user row, then the persisted goal state.
        let mut session = SessionManager::in_memory(tmp.path());
        let session_user = |text: &str| {
            pa_types::session::AgentMessage::User(pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Text(text.to_string()),
                timestamp: 0,
                rest: serde_json::Map::default(),
            })
        };
        let assistant_row = pa_types::ai::AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: "reply zero words".to_string(),
                    text_signature: None,
                    rest: serde_json::Map::default(),
                },
            )],
            api: "openai-completions".to_string(),
            provider: "test".to_string(),
            model: "digest-placement-m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage {
                input: 100,
                output: 20,
                cache_read: 0,
                cache_write: 0,
                total_tokens: 120,
                cost: pa_types::ai::UsageCost::default(),
            },
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        };
        let user0 = session_user("turn zero words");
        let reply0 = pa_types::session::AgentMessage::Assistant(assistant_row.clone());
        let user1 = session_user("unfinished turn three words");
        session.append_message(user0.clone()).unwrap();
        session.append_message(reply0.clone()).unwrap();
        session.append_message(user1.clone()).unwrap();
        let goal = pa_types::goal::GoalState {
            active: true,
            status: pa_types::goal::GoalStatus::Active,
            goal_id: Some("placement-goal".to_string()),
            objective: Some("launch checklist work".to_string()),
            ..Default::default()
        };
        session
            .append_custom_entry(
                crate::goals::GOAL_STATE_CUSTOM_TYPE,
                Some(serde_json::to_value(&goal).unwrap()),
            )
            .unwrap();

        // The live context mirrors the entries, built through the product's
        // own wire->loop converter (`session_message_to_loop`) so the
        // fixture's shapes are the writer's.
        let live: Vec<AgentMessage> = [user0, reply0, user1]
            .iter()
            .map(|row| {
                crate::session_engine::session_message_to_loop(row)
                    .expect("the rig's wire rows convert to loop rows")
            })
            .collect();
        let agent = std::sync::Arc::new(pa_agent::agent::Agent::new(
            pa_agent::agent::AgentOptions {
                initial_state: pa_agent::agent::AgentInitialState {
                    messages: Some(live),
                    ..Default::default()
                },
                ..Default::default()
            },
        ));
        let mut engine = crate::session_engine::AgentSession::from_session_arc(
            agent,
            std::sync::Arc::new(tokio::sync::Mutex::new(session)),
            Vec::new(),
            Some(HarnessDigestContext {
                global_dir,
                local_dir: Some(local_dir),
                include_ipython: false,
                include_shell_examples: false,
                include_refine: false,
            }),
        )
        .await
        .unwrap();
        engine.set_compaction_settings(crate::session_engine::compaction::CompactionSettings {
            keep_recent_tokens: 2,
            ..Default::default()
        });
        let objective = {
            let session = engine.session.lock().await;
            crate::session_engine::goal_driver::GoalDriver::load_persisted(&session)
                .state()
                .objective
                .clone()
        };
        (engine, registration, objective)
    }

    /// Spawn the rig's compaction and wait for the served-path signal: the
    /// summarizer request is in flight (the faux call arrived) and the
    /// compact task is unfinished — the ENTER→commit window is open.
    async fn spawn_compact(
        engine: std::sync::Arc<crate::session_engine::AgentSession>,
        model: &pa_types::ai::Model,
        registration: &pa_ai::faux::FauxProviderRegistration,
    ) -> tokio::task::JoinHandle<
        anyhow::Result<crate::session_engine::compact_session::CompactOutcome>,
    > {
        let model = model.clone();
        let handle = tokio::spawn(async move {
            engine.compact(None, &model, None, None).await
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while registration.call_count() == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "the summarizer request never arrived"
            );
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        assert!(
            !handle.is_finished(),
            "the compaction must still be in flight when the window is sampled"
        );
        handle
    }

    /// The commit-time placement's capture, sampled mid-window: the same
    /// pieces `harness_digest_inputs()` reads, taken without the session
    /// lock (the compaction holds it for the whole window — which is also
    /// the structural proof the goal term is frozen in-window: every goal
    /// mutation path serializes on that lock, so the pre-window read
    /// equals the commit-moment value).
    async fn commit_moment_inputs(
        engine: &crate::session_engine::AgentSession,
        goal_objective: Option<&str>,
    ) -> Option<HarnessDigestInputs> {
        let context = engine.harness_digest.clone()?;
        let texts = engine.recent_message_texts_newest_first().await;
        let terms = digest_query_terms(goal_objective, &texts);
        Some(HarnessDigestInputs { context, terms })
    }

    /// Oracle A — the frozen classes: with nothing mutating the live
    /// context inside the window, the ENTER capture and the commit-time
    /// capture render byte-identical digests, and the durable row carries
    /// exactly that digest. The placement is content-equivalent wherever
    /// the window is writer-free — and TS's window always is (its input
    /// pump defers on `isCompacting`), so the ENTER capture matches TS's
    /// effective commit-time content in every frozen class.
    #[tokio::test]
    async fn compact_digest_capture_placements_match_byte_for_byte_in_frozen_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let (engine, registration, goal) = placement_rig(&tmp, 300).await;
        let model = registration.get_model();

        // The ENTER-side capture: the same call `AgentSession::compact`
        // makes at ENTER, taken here for the cross-check.
        let enter_inputs = engine
            .harness_digest_inputs()
            .await
            .expect("the rig wires a harness digest context");
        let enter_digest = enter_inputs.render();

        let engine = std::sync::Arc::new(engine);
        let handle = spawn_compact(engine.clone(), &model, &registration).await;

        // The commit-time capture, sampled while the summarizer holds.
        let commit_inputs = commit_moment_inputs(&engine, goal.as_deref())
            .await
            .expect("the rig wires a harness digest context");
        // Anti-vacuity: the sample really observed the open window's
        // term source (identical texts), not a post-hoc state.
        assert_eq!(commit_inputs.terms, enter_inputs.terms);
        let commit_digest = commit_inputs.render();

        let outcome = handle.await.unwrap().unwrap();
        let crate::session_engine::compact_session::CompactOutcome::Ran(run) = outcome else {
            panic!("expected the compaction to run");
        };
        let committed = run
            .entry
            .harness_digest
            .as_deref()
            .expect("digest on the durable row");
        assert_eq!(
            committed, enter_digest,
            "the durable row carries the ENTER capture's render"
        );
        assert_eq!(
            commit_digest.as_str(),
            committed,
            "the two placements must be byte-identical in a frozen window"
        );
        assert_eq!(
            run.entry.harness_state_fingerprint.as_deref(),
            Some(commit_inputs.render_with_fingerprint().state_fingerprint.as_str()),
            "the state fingerprint is placement-independent (one state read per render)"
        );
        // The goal term is frozen across the window (the structural proof
        // is the lock the compaction holds; assert the freeze directly).
        let post_goal = {
            let session = engine.session.lock().await;
            crate::session_engine::goal_driver::GoalDriver::load_persisted(&session)
                .state()
                .objective
                .clone()
        };
        assert_eq!(post_goal, goal);
        registration.unregister();
    }

    /// Oracle B — the racing class: a resume-site admission mid-compaction
    /// (the port's turn runner starts the turn during the compaction; the
    /// racing row is reproduced here in the writer's context shape — the
    /// user row landing on the live context) shows the two placements
    /// apart: the commit-time capture ranks the racing row's terms into
    /// the digest — rows TS's commit capture never sees — while the ENTER
    /// capture, and the durable row, keep the frozen pre-race content.
    #[tokio::test]
    async fn compact_digest_capture_commit_time_placement_sees_racing_rows_enter_never_does() {
        let tmp = tempfile::tempdir().unwrap();
        let (engine, registration, goal) = placement_rig(&tmp, 300).await;
        let model = registration.get_model();

        let enter_inputs = engine
            .harness_digest_inputs()
            .await
            .expect("the rig wires a harness digest context");
        let enter_digest = enter_inputs.render();
        assert!(
            !enter_inputs.terms.contains_key("zebra"),
            "the pre-race terms must not carry the racing keyword"
        );

        let engine = std::sync::Arc::new(engine);
        let handle = spawn_compact(engine.clone(), &model, &registration).await;

        // The racing admission's writer effect (worker input resume site
        // -> the turn runner picks the item up mid-compaction ->
        // `prompt_with_images` -> `agent.prompt` lands the user row on the
        // live context): the row landing is the context shape a racing
        // turn produces.
        let racing_row = AgentMessage::user("urgent zebra gadget steer");
        let mut raced = engine.agent.state().await.messages;
        raced.push(racing_row);
        engine.agent.set_messages(raced).await;
        assert!(
            !handle.is_finished(),
            "the compaction must still be in flight after the racing row lands"
        );

        let commit_inputs = commit_moment_inputs(&engine, goal.as_deref())
            .await
            .expect("the rig wires a harness digest context");
        // Served-path: the racing row reached the commit-time capture.
        assert!(
            commit_inputs.terms.contains_key("zebra"),
            "the racing row must reach the commit-time capture"
        );
        let commit_digest = commit_inputs.render();

        // The placements come apart: the commit-time digest ranks the
        // zebra-bearing memory first, the ENTER digest keeps the
        // zero-term key order (wombat first).
        assert_ne!(
            commit_digest, enter_digest,
            "the racing class must diverge the two placements"
        );
        let enter_wombat = enter_digest
            .find("wombat widget notes")
            .expect("the wombat memory renders at ENTER");
        let enter_zebra = enter_digest
            .find("zebra gadget notes")
            .expect("the zebra memory renders at ENTER");
        assert!(enter_wombat < enter_zebra);
        let commit_zebra = commit_digest
            .find("zebra gadget notes")
            .expect("the zebra memory renders at the commit");
        let commit_wombat = commit_digest
            .find("wombat widget notes")
            .expect("the wombat memory renders at the commit");
        assert!(commit_zebra < commit_wombat);

        // THE SHIELD: the durable row keeps the ENTER (TS-frozen)
        // content — the racing row never reaches it. The divergence is
        // the terms-driven ranking only: the state fingerprint (the
        // harness state behind the digest, TS #2400) matches across
        // placements — the racing row changes no harness state.
        let outcome = handle.await.unwrap().unwrap();
        let crate::session_engine::compact_session::CompactOutcome::Ran(run) = outcome else {
            panic!("expected the compaction to run");
        };
        let committed = run
            .entry
            .harness_digest
            .as_deref()
            .expect("digest on the durable row");
        assert_eq!(
            committed, enter_digest,
            "the ENTER capture shields the durable row from the racing admission"
        );
        let commit_fingerprint = commit_inputs.render_with_fingerprint().state_fingerprint;
        assert_eq!(
            run.entry.harness_state_fingerprint.as_deref(),
            Some(commit_fingerprint.as_str()),
            "the state fingerprint matches across placements in every class"
        );
        registration.unregister();
    }
}
