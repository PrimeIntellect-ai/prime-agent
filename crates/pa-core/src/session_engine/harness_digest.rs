//! Harness digest delivery: compose the continual-harness state into the
//! model-facing `[harness-digest]` context message and deliver it at cold
//! context boundaries (session start, resume, compaction head); the
//! deferred first-turn row rides the turn's prompt messages.

use std::path::PathBuf;

use pa_agent::types::{AgentMessage, Message, UserContent, UserPart};
use pa_types::session::{AgentMessage as SessionAgentMessage, FileEntry};

use crate::refinement::ranking::{
    format_harness_state_for_prompt, harness_digest_fingerprint, harness_query_terms,
    HarnessDigestRenderFlags, HarnessQueryTerms, HarnessStatePromptOptions,
};
use crate::refinement::{load_harness_state, merge_harness_states, HarnessScope};

use super::messages::{COMPACTION_SUMMARY_PREFIX, HARNESS_DIGEST_PREFIX, HARNESS_DIGEST_SUFFIX};

#[cfg(test)]
mod direction;

/// Session-scoped digest inputs: where harness state lives and which
/// interfaces the digest may reference.
#[derive(Debug, Clone)]
pub struct HarnessDigestContext {
    /// Global harness state directory (`<agent dir>/harness`).
    pub global_dir: PathBuf,
    /// Session-local harness state directory (session artifact dir), when the
    /// session persists artifacts.
    pub local_dir: Option<PathBuf>,
    pub include_ipython: bool,
    pub include_shell_examples: bool,
    pub include_refine: bool,
}

/// Relevance terms for digest entry ranking: the active goal objective
/// (strongest) plus the last few user/assistant texts, newest first.
#[must_use]
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
/// that produced it; query terms drive the render but stay out of the fingerprint.
#[derive(Debug, Clone, PartialEq)]
pub struct HarnessDigestRender {
    pub digest: String,
    pub state_fingerprint: String,
}

/// The rendered digest body (the `<harness_state>` content): merged global +
/// local harness state, ranked by the query terms.
#[must_use]
pub fn harness_digest_text(
    context: &HarnessDigestContext,
    query_terms: HarnessQueryTerms,
) -> String {
    render_digest_with_fingerprint(context, query_terms).digest
}

/// Render the digest body and its state fingerprint from one merged-state
/// read.
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

/// Digest inputs captured from the live session; the disk read happens at
/// render time, so a render at the compaction commit reads mid-run state.
#[derive(Debug, Clone)]
pub struct HarnessDigestInputs {
    pub context: HarnessDigestContext,
    pub terms: HarnessQueryTerms,
}

impl HarnessDigestInputs {
    #[must_use]
    pub fn render(&self) -> String {
        self.render_with_fingerprint().digest
    }

    /// Render the body plus the fingerprint of the state behind it (one
    /// state read feeds both).
    #[must_use]
    pub fn render_with_fingerprint(&self) -> HarnessDigestRender {
        render_digest_with_fingerprint(&self.context, self.terms.clone())
    }
}

#[must_use]
pub fn harness_digest_message_text(digest: &str) -> String {
    format!("{HARNESS_DIGEST_PREFIX}{digest}{HARNESS_DIGEST_SUFFIX}")
}

/// The digest as the loop's custom prompt row: it rides the run's prompt
/// messages and converts to a user turn at the loop's LLM boundary.
///
/// # Panics
///
/// Panics if serializing the digest row payload fails, which cannot happen
/// for the plain message struct.
#[must_use]
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

/// The digest as a session message payload for persistence (display:
/// false, the digest plus its fingerprint in details).
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
/// digest frame (standalone digest rows, the block leading a summary row).
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
/// shape, or the user turn a rebuild converted — matched byte-exactly against
/// the digest's frame, so a quoting user turn survives the refresh.
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

/// Strip a live compaction-summary row's superseded digest block: the summary text
/// stays. The block must be the newest in-context digest's frame, never a quoting user turn.
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

/// The newest in-context digest and its state fingerprint: a fingerprint-less
/// latest (a converted user turn) falls back to rendered-text comparison, and
/// recency is by timestamp — out-of-context entries must not suppress delivery.
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

/// The newest digest recorded in the session's typed context rows; this typed
/// view is where a fingerprint-less latest recovers its fingerprint.
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
/// (`dirname(dirname(file))/session-artifacts/<id>`).
#[must_use]
pub fn session_artifact_dir_for_log(log: &std::path::Path) -> Option<PathBuf> {
    let id = log.file_stem()?.to_string_lossy().to_string();
    let artifacts_root = log.parent()?.parent()?.join("session-artifacts");
    Some(artifacts_root.join(id))
}

/// Session-local harness state directory implied by a conversation-log path
/// (the artifact dir plus the harness subdir).
#[must_use]
pub fn local_harness_dir_for_log(log: &std::path::Path) -> Option<PathBuf> {
    session_artifact_dir_for_log(log).map(|dir| dir.join(crate::refinement::HARNESS_STATE_DIR_NAME))
}

/// Session message view of the digest entries (resume context rebuild).
#[must_use]
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

// Delivery mechanics: the `AgentSession` methods that drive the
// cold-boundary delivery invariant (private fields reachable here).
impl super::AgentSession {
    /// Cold-boundary digest delivery: empty contexts defer to the first committed
    /// turn; non-empty contexts append when the newest digest is stale, without events.
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
    /// admission; the pending flag is consumed either way.
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

    /// The digest inputs captured from the live session: interface flags plus
    /// relevance terms. `None` when the session carries no harness state; the
    /// disk read stays deferred to render time, so a snapshot reads fresh state.
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

    /// The digest to deliver at this boundary, when the newest in-context digest
    /// is stale against it: a fingerprint match is fresh regardless of the
    /// rendered text. The comparison is against the live loop context only.
    async fn fresh_digest(&self) -> Option<HarnessDigestRender> {
        let fresh = self
            .harness_digest_inputs()
            .await?
            .render_with_fingerprint();
        let mut latest = latest_context_digest_details(&self.agent.state().await.messages);
        // Fingerprint recovery for converted rows (a rebuild drops the typed payload):
        // a fingerprint-less latest borrows the typed row's fingerprint when it is the same digest.
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

    /// Deliver a stale digest onto an already-populated loop context: the row
    /// is pushed directly and persisted eagerly, without events. The fresh
    /// digest is authoritative, so the append replaces older in-context copies.
    async fn append_stale_harness_digest(&self) -> anyhow::Result<()> {
        let Some(render) = self.fresh_digest().await else {
            return Ok(());
        };
        // The newest in-context digest is the provenance marker: the converted
        // rows are its exact frame, so the strip never matches a quoting user turn.
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

    /// The last four user/assistant texts, newest first (digest ranking) — the NEWEST
    /// four texts of the recent window, never the chronological head.
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
        // Keep the newest four texts (the window tail): `truncate(4)`
        // would keep the chronological head and rank the wrong end.
        if texts.len() > 4 {
            texts.drain(..texts.len() - 4);
        }
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
mod tests;
