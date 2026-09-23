//! The post-compaction kernel-state notice (`ipython_state`).
//!
//! A compaction rebuilds the model context from the session file, but the
//! Python kernel behind the `ipython` tool survives it with its namespace
//! intact. After every compaction that commits while a kernel is running,
//! the session appends a hidden `ipython_state` custom row that tells the
//! model exactly that: which names are still defined, what the
//! per-variable size pruning removed, and that the kernel state does not
//! need rebuilding. The row is model context (it reaches the provider as a
//! user turn) and display-only bookkeeping for humans (`display: false`),
//! and it keeps the session branch from ending on the compaction row — a
//! second `/compact` back-to-back prepares again in update mode instead of
//! skipping as already compacted.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use pa_agent::agent::Agent;
use pa_agent::types::AgentMessage;
use pa_types::session::CustomMessage;

use crate::kernel::provisioner::IpythonKernelProvisioner;
use crate::session::manager::SessionManager;

/// The notice's `customType` (TS `ipython_state`).
pub const IPYTHON_STATE_CUSTOM_TYPE: &str = "ipython_state";

/// How long the namespace listing may take before it is abandoned (TS
/// `KERNEL_STATE_LISTING_TIMEOUT_MS`): a stuck kernel degrades the notice
/// to the no-detail arm rather than hanging the compaction.
pub const KERNEL_STATE_LISTING_TIMEOUT_MS: u64 = 5_000;

/// The kernel-state view the post-compaction notice reads: TS
/// `IpythonKernelProvisioner`'s `hasRunningKernel` /
/// `pruneOversizedVariables` / `listNamespaceNames` trio, narrowed to what
/// the notice needs. Implementations never fail: a missing or broken
/// kernel reports `false`/`None` and the notice adapts (TS wraps every
/// call in `?.` and `.catch(() => null)`). Object-safe on purpose (the
/// session holds `Arc<dyn CompactionKernelProbe>` and tests inject a
/// scripted probe), hence boxed futures.
pub trait CompactionKernelProbe: Send + Sync {
    /// Whether a kernel has finished starting and is currently running.
    fn has_running_kernel(&self) -> bool;
    /// Persist the namespace, then remove variables above the
    /// per-variable snapshot limit; the pruned names, or `None` when no
    /// kernel/snapshot target exists.
    fn prune_oversized_variables(
        &self,
    ) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send + '_>>;
    /// Live user-defined top-level names, or `None` when the listing
    /// failed or no kernel is running.
    fn list_namespace_names(
        &self,
        signal: Option<crate::kernel::cancellation::AbortSignal>,
    ) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send + '_>>;
}

/// The session-held probe: weak over the engine-owned provisioner. The
/// engine owns the provisioner for exactly the lifetime of the session;
/// the kernel's host handlers reach the session, so a strong edge here
/// would loop the ownership graph and keep a dropped session's kernel
/// process alive until process exit.
pub struct EngineOwnedProbe {
    provisioner: std::sync::Weak<crate::kernel::provisioner::IpythonKernelProvisioner>,
}

impl EngineOwnedProbe {
    /// Wrap the engine-owned provisioner.
    pub fn new(
        provisioner: std::sync::Weak<crate::kernel::provisioner::IpythonKernelProvisioner>,
    ) -> Self {
        Self { provisioner }
    }

    fn owned(
        &self,
    ) -> Option<std::sync::Arc<crate::kernel::provisioner::IpythonKernelProvisioner>> {
        self.provisioner.upgrade()
    }
}

impl CompactionKernelProbe for EngineOwnedProbe {
    fn has_running_kernel(&self) -> bool {
        self.owned()
            .as_deref()
            .map(crate::kernel::provisioner::IpythonKernelProvisioner::has_running_kernel)
            .unwrap_or(false)
    }

    fn prune_oversized_variables(
        &self,
    ) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send + '_>> {
        let owned = self.owned();
        Box::pin(async move {
            let owned = owned?;
            owned.prune_oversized_variables().await
        })
    }

    fn list_namespace_names(
        &self,
        signal: Option<crate::kernel::cancellation::AbortSignal>,
    ) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send + '_>> {
        let owned = self.owned();
        Box::pin(async move {
            let owned = owned?;
            owned.list_namespace_names(signal).await
        })
    }
}

impl CompactionKernelProbe for crate::kernel::provisioner::IpythonKernelProvisioner {
    fn has_running_kernel(&self) -> bool {
        IpythonKernelProvisioner::has_running_kernel(self)
    }
    fn prune_oversized_variables(
        &self,
    ) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send + '_>> {
        Box::pin(async move { IpythonKernelProvisioner::prune_oversized_variables(self).await })
    }
    fn list_namespace_names(
        &self,
        signal: Option<crate::kernel::cancellation::AbortSignal>,
    ) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send + '_>> {
        Box::pin(async move { IpythonKernelProvisioner::list_namespace_names(self, signal).await })
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// The notice text (TS `_syncKernelStateAfterCompaction`'s builder): the
/// `[python-state]` header, the persistence statement, the pruning
/// disclosure, and the live-names detail. `names` is `None` when the
/// listing failed on a kernel that is still running (the notice lands
/// without the detail arm, TS `names === null`); `pruned` carries the
/// names removed above the per-variable snapshot limit.
pub fn notice_content(pruned: Option<&[String]>, names: Option<&[String]>) -> String {
    let detail = match names {
        None => String::new(),
        Some(names) if !names.is_empty() => {
            format!(" These names are still defined: {}.", names.join(", "))
        }
        Some(_) => " You have not defined any names yet.".to_string(),
    };
    let pruned_detail = match pruned {
        Some(pruned) if !pruned.is_empty() => format!(
            " Variables above the per-variable snapshot limit were removed: {}.",
            pruned.join(", ")
        ),
        _ => String::new(),
    };
    format!(
        "[python-state]

Your Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available.{pruned_detail}{detail}"
    )
}

/// The durable notice row: display false, no details (TS appends
/// `appendCustomMessageEntry(customType, content, display, undefined)`).
pub fn notice_message(content: String) -> CustomMessage {
    CustomMessage {
        custom_type: IPYTHON_STATE_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(content),
        display: false,
        details: None,
        timestamp: now_millis(),
        rest: Default::default(),
    }
}

/// Capture the notice content after a compaction (TS
/// `_syncKernelStateAfterCompaction`'s probe half): prune, list the live
/// names under the listing timeout, and decide whether the notice lands.
/// `None` when no kernel is running, or when a failed listing belongs to
/// a kernel that stopped mid-probe.
pub async fn capture_notice_content(probe: &dyn CompactionKernelProbe) -> Option<String> {
    if !probe.has_running_kernel() {
        return None;
    }
    let pruned = probe.prune_oversized_variables().await;
    let signal = crate::kernel::cancellation::AbortSignal::new();
    let timer = {
        let signal = signal.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(
                KERNEL_STATE_LISTING_TIMEOUT_MS,
            ))
            .await;
            signal.abort();
        })
    };
    let names = probe.list_namespace_names(Some(signal)).await;
    timer.abort();
    if names.is_none() && !probe.has_running_kernel() {
        return None;
    }
    Some(notice_content(pruned.as_deref(), names.as_deref()))
}

/// Append the post-compaction notice everywhere it belongs (TS
/// `_syncKernelStateAfterCompaction`): the durable session row first, then
/// the live loop context — inserted before a trailing error assistant
/// turn so the notice precedes the failure it explains — and the row is
/// returned for the surfaces to broadcast as a `message_start` /
/// `message_end` pair. `None` when no notice landed (no running kernel).
pub async fn sync_after_compaction(
    probe: &dyn CompactionKernelProbe,
    session: &Arc<tokio::sync::Mutex<SessionManager>>,
    agent: &Arc<Agent>,
) -> std::io::Result<Option<CustomMessage>> {
    let Some(content) = capture_notice_content(probe).await else {
        return Ok(None);
    };
    let row = notice_message(content);
    {
        let mut session = session.lock().await;
        session.append_custom_message(
            &row.custom_type,
            row.content.clone(),
            row.display,
            row.details.clone(),
        )?;
    }
    let Some(loop_message) = crate::session_engine::session_message_to_loop(
        &pa_types::session::AgentMessage::Custom(row.clone()),
    ) else {
        return Ok(Some(row));
    };
    let state = agent.state().await;
    let mut messages = state.messages;
    let insert_before_error = matches!(
        messages.last(),
        Some(AgentMessage::Standard(pa_agent::types::Message::Assistant(assistant)))
            if assistant.stop_reason == pa_agent::types::StopReason::Error
    );
    if insert_before_error {
        messages.insert(messages.len() - 1, loop_message);
    } else {
        messages.push(loop_message);
    }
    agent.set_messages(messages).await;
    Ok(Some(row))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::session::AgentMessage as SessionAgentMessage;

    /// A scripted kernel probe: whether a kernel runs, what pruning removed,
    /// and which names the listing reports (TS's structural test double for
    /// `_ipythonKernelProvisioner`).
    struct ScriptedProbe {
        running: std::sync::atomic::AtomicBool,
        pruned: Option<Vec<String>>,
        names: Option<Vec<String>>,
        /// `None` keeps reporting `running` on the post-listing recheck.
        stopped_during_listing: bool,
    }

    impl ScriptedProbe {
        fn running(pruned: Option<Vec<String>>, names: Option<Vec<String>>) -> Self {
            Self {
                running: std::sync::atomic::AtomicBool::new(true),
                pruned,
                names,
                stopped_during_listing: false,
            }
        }
        fn idle() -> Self {
            Self {
                running: std::sync::atomic::AtomicBool::new(false),
                pruned: None,
                names: None,
                stopped_during_listing: false,
            }
        }
    }

    impl CompactionKernelProbe for ScriptedProbe {
        fn has_running_kernel(&self) -> bool {
            self.running.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn prune_oversized_variables(
            &self,
        ) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send + '_>> {
            let pruned = self.pruned.clone();
            Box::pin(async move { pruned })
        }
        fn list_namespace_names(
            &self,
            _signal: Option<crate::kernel::cancellation::AbortSignal>,
        ) -> Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send + '_>> {
            if self.stopped_during_listing {
                self.running
                    .store(false, std::sync::atomic::Ordering::SeqCst);
            }
            let names = self.names.clone();
            Box::pin(async move { names })
        }
    }

    #[test]
    fn notice_content_matches_the_ts_text() {
        // The full TS text (agent-session-compaction.test.ts asserts the
        // same sentence): prune disclosure first, then the live-names
        // detail.
        assert_eq!(
            notice_content(
                Some(&["large_text".to_string()]),
                Some(&["small_value".to_string()]),
            ),
            "[python-state]\n\nYour Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available. Variables above the per-variable snapshot limit were removed: large_text. These names are still defined: small_value."
        );
        // An empty namespace spells the no-names arm.
        assert_eq!(
            notice_content(None, Some(&[])),
            "[python-state]\n\nYour Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available. You have not defined any names yet."
        );
        // A failed listing on a still-running kernel lands the notice
        // without a detail arm (TS `names === null`).
        assert_eq!(
            notice_content(Some(&["large_text".to_string()]), None),
            "[python-state]\n\nYour Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available. Variables above the per-variable snapshot limit were removed: large_text."
        );
        // Several names join comma-separated; nothing pruned keeps the
        // prune sentence out.
        assert_eq!(
            notice_content(None, Some(&["alpha".to_string(), "beta".to_string()])),
            "[python-state]\n\nYour Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available. These names are still defined: alpha, beta."
        );
        // An empty prune list is no disclosure either.
        assert!(notice_content(Some(&[]), Some(&["v".to_string()]))
            .contains("still available. These names"));
    }

    /// The durable row shape (TS `appendCustomMessageEntry(customType,
    /// content, display, undefined)`): display false, no `details` key on
    /// the wire, and the custom role wrapper around it.
    #[test]
    fn notice_row_is_display_false_without_details() {
        let row = notice_message(notice_content(None, Some(&["v".to_string()])));
        assert_eq!(row.custom_type, IPYTHON_STATE_CUSTOM_TYPE);
        assert!(!row.display);
        assert_eq!(row.details, None);
        let wire = serde_json::to_value(SessionAgentMessage::Custom(row)).unwrap();
        assert_eq!(wire["role"], "custom");
        assert_eq!(wire["customType"], "ipython_state");
        assert_eq!(wire["display"], false);
        assert!(wire.get("details").is_none());
        assert_eq!(
            wire["content"],
            "[python-state]\n\nYour Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available. These names are still defined: v."
        );
    }

    /// The capture guards (TS `_syncKernelStateAfterCompaction`'s early
    /// returns): an idle kernel never produces a notice, and a listing
    /// that failed while the kernel stopped mid-probe lands nothing.
    #[tokio::test]
    async fn capture_guards_match_ts() {
        let idle = ScriptedProbe::idle();
        assert_eq!(capture_notice_content(&idle).await, None);
        // A failed listing on a kernel that stopped mid-probe: no notice.
        let stopped = ScriptedProbe {
            names: None,
            stopped_during_listing: true,
            ..ScriptedProbe::running(None, None)
        };
        assert_eq!(capture_notice_content(&stopped).await, None);
        // A failed listing on a still-running kernel: the notice lands
        // without the detail arm.
        let listing_failed = ScriptedProbe::running(None, None);
        let content = capture_notice_content(&listing_failed).await;
        assert_eq!(
            content,
            Some(
                "[python-state]\n\nYour Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available."
                    .to_string()
            )
        );
    }

    // ------------------------------------------------------------------
    // AgentSession-level flow: the append point, the live context, and the
    // back-to-back second `/compact` (the #227-documented TS behavior).
    // ------------------------------------------------------------------

    use crate::session_engine::compact_session::{CompactOutcome, CompactSkip};
    use crate::session_engine::AgentSession;
    use pa_agent::agent::AgentOptions;
    use pa_types::ai::UserContent;
    use pa_types::session::FileEntry;

    /// The faux provider with scripted summarizer responses. The faux seam
    /// is process-global, so every registration unregisters on drop.
    fn faux_registration(
        responses: Vec<pa_ai::faux::FauxResponseStep>,
    ) -> pa_ai::faux::FauxProviderRegistration {
        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                models: Some(vec![pa_ai::faux::FauxModelDefinition {
                    id: "ipython-state-m".to_string(),
                    name: Some("Notice Model".to_string()),
                    reasoning: Some(false),
                    input: Some(vec![pa_types::ai::ModelInput::Text]),
                    cost: None,
                    context_window: Some(100_000),
                    max_tokens: Some(256),
                }]),
                ..Default::default()
            });
        registration.set_responses(responses);
        registration
    }

    /// A factory step that records each request text and answers with one
    /// scripted summary.
    fn recording_step(
        seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        response: &'static str,
    ) -> pa_ai::faux::FauxResponseStep {
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
    }

    fn user_turn(text: &str) -> SessionAgentMessage {
        SessionAgentMessage::User(pa_types::ai::UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: Default::default(),
        })
    }

    /// A session with three user turns and a kernel probe bound.
    async fn session_with_probe(probe: ScriptedProbe) -> (AgentSession, std::sync::Arc<Agent>) {
        let tmp = tempfile::tempdir().unwrap();
        let mut session = SessionManager::in_memory(tmp.path());
        for text in ["turn zero", "turn one", "turn two"] {
            session.append_message(user_turn(text));
        }
        let agent = std::sync::Arc::new(Agent::new(AgentOptions::default()));
        let mut engine = AgentSession::new(agent.clone(), session, Vec::new())
            .await
            .unwrap();
        engine.set_compaction_settings(crate::session_engine::compaction::CompactionSettings {
            keep_recent_tokens: 2,
            ..Default::default()
        });
        engine.set_kernel_state_probe(Some(std::sync::Arc::new(probe)));
        (engine, agent)
    }

    async fn compact_once(
        engine: &AgentSession,
        model: &pa_types::ai::Model,
    ) -> anyhow::Result<CompactOutcome> {
        engine.compact(None, model, None, None).await
    }

    /// The append point (TS `_performCompaction`: rebuild, then
    /// `_syncKernelStateAfterCompaction`): the notice row lands on the
    /// durable branch right after the compaction entry, rides the run for
    /// the surfaces to broadcast, and closes the live loop context.
    #[tokio::test]
    async fn compaction_with_a_running_kernel_appends_the_notice_after_the_entry() {
        let registration = faux_registration(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                "the compaction summary",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let model = registration.get_model();
        let (engine, agent) = session_with_probe(ScriptedProbe::running(
            Some(vec!["large_text".to_string()]),
            Some(vec!["small_value".to_string()]),
        ))
        .await;
        let outcome = compact_once(&engine, &model).await.unwrap();
        let CompactOutcome::Ran(run) = outcome else {
            panic!("expected the compaction to run");
        };
        // The row rides the run (the broadcast seam).
        let row = run.ipython_state.expect("the notice row rides the run");
        assert_eq!(row.custom_type, IPYTHON_STATE_CUSTOM_TYPE);
        assert_eq!(
            row.content.text(),
            "[python-state]\n\nYour Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available. Variables above the per-variable snapshot limit were removed: large_text. These names are still defined: small_value."
        );
        // The durable branch: the notice directly follows the compaction
        // entry (TS appends `appendCustomMessageEntry` right after
        // `appendCompaction`).
        let entries = engine.entries().await;
        let last = entries.last().expect("entries");
        assert!(matches!(
            last,
            FileEntry::CustomMessage { payload, .. }
                if payload.custom_type == IPYTHON_STATE_CUSTOM_TYPE
                    && !payload.display
                    && payload.details.is_none()
        ));
        let compaction_index = entries
            .iter()
            .rposition(|entry| matches!(entry, FileEntry::Compaction { .. }))
            .expect("compaction entry");
        assert_eq!(
            entries[compaction_index + 1].id(),
            last.id(),
            "the notice follows the compaction entry"
        );
        // The live loop context ends with the notice.
        let state = agent.state().await;
        assert!(matches!(
            state.messages.last(),
            Some(AgentMessage::Custom(_))
        ));
        registration.unregister();
    }

    /// THE #227 residue, convergent: with a running kernel, back-to-back
    /// `/compact` with nothing in between RUNS again (update mode over the
    /// retained conversation) — the notice row after every compaction keeps
    /// the branch from ending on the compaction row — while a session
    /// without a kernel keeps the "Already compacted" skip.
    #[tokio::test]
    async fn back_to_back_compact_runs_again_with_a_running_kernel() {
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = Default::default();
        let registration = faux_registration(vec![
            recording_step(seen.clone(), "the first compaction summary"),
            recording_step(seen.clone(), "the second compaction summary"),
            recording_step(seen.clone(), "the third compaction summary"),
        ]);
        let model = registration.get_model();
        let probe = ScriptedProbe::running(None, Some(vec!["v".to_string()]));
        let (engine, _agent) = session_with_probe(probe).await;
        // First compact: the checkpoint summary.
        let outcome = compact_once(&engine, &model).await.unwrap();
        assert!(matches!(outcome, CompactOutcome::Ran(_)));
        // Second compact, nothing in between: RUNS (update mode) — TS
        // parity, where the post-compaction notice row keeps the branch
        // from ending on the compaction row.
        let outcome = compact_once(&engine, &model).await.unwrap();
        let CompactOutcome::Ran(second) = outcome else {
            panic!("expected the back-to-back compaction to run again");
        };
        assert_eq!(second.result.summary, "the second compaction summary");
        // The second summary is the update-mode merge of the first.
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains("Create a structured context checkpoint summary"));
        assert!(requests[1].contains("NEW conversation messages to incorporate"));
        assert!(requests[1]
            .contains("<previous-summary>\nthe first compaction summary\n</previous-summary>"));
        // The branch carries a notice row after every compaction, in
        // order (notice, compaction, notice, compaction from the tip).
        let entries = engine.entries().await;
        let mut tail = entries.iter().rev();
        assert!(matches!(
            tail.next(),
            Some(FileEntry::CustomMessage { payload, .. })
                if payload.custom_type == IPYTHON_STATE_CUSTOM_TYPE
        ));
        assert!(matches!(tail.next(), Some(FileEntry::Compaction { .. })));
        assert!(matches!(
            tail.next(),
            Some(FileEntry::CustomMessage { payload, .. })
                if payload.custom_type == IPYTHON_STATE_CUSTOM_TYPE
        ));
        assert!(matches!(tail.next(), Some(FileEntry::Compaction { .. })));
        registration.unregister();
    }

    /// Without a kernel the notice never lands and the branch ends on the
    /// compaction row: the second `/compact` keeps the "Already compacted"
    /// skip (both sides' behavior for kernel-less sessions).
    #[tokio::test]
    async fn back_to_back_compact_without_a_kernel_still_skips() {
        let registration = faux_registration(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                "the compaction summary",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let model = registration.get_model();
        let (engine, _agent) = session_with_probe(ScriptedProbe::idle()).await;
        let outcome = compact_once(&engine, &model).await.unwrap();
        assert!(matches!(outcome, CompactOutcome::Ran(_)));
        assert!(engine.entries().await.iter().all(|entry| {
            !matches!(entry, FileEntry::CustomMessage { payload, .. } if payload.custom_type == IPYTHON_STATE_CUSTOM_TYPE)
        }));
        let outcome = compact_once(&engine, &model).await.unwrap();
        assert_eq!(
            outcome,
            CompactOutcome::Skipped(CompactSkip::AlreadyCompacted.user_message())
        );
        registration.unregister();
    }
}
