//! The compact-trigger auto-refine on the ACP turn path: the serialized
//! scheduling TS gives the ACP mode (main.ts
//! `serializedRefine: appMode !== "interactive" && appMode !== "daemon"`
//! — true for ACP), mapped onto this transport's boundaries.
//!
//! TS ground truth: a successful compaction arms the trigger
//! (`_scheduleAutoRefineAfterCompaction`'s serialized arm sets
//! `_compactAutoRefinePending`); the serialized checkpoint between turns
//! consumes it after servicing the requested `refine.run`
//! (`_runSerializedRefineCheckpointAfterBackground`'s compact step, with
//! its `enabled`/`compact` gates and the cooldown preserving the trigger),
//! and session disposal drains a trigger no turn serviced (the
//! serialized dispose drain). An approved round runs the refinement and
//! publishes the same `refinement` meta the `/refine` command produces
//! (`RefineComplete`/`RefineFailed`); a declined review surfaces
//! nothing (TS: only the cooldown is stamped).

use pa_core::refinement::RefinementResult;
use pa_core::session_engine::auto_refine_trigger::CompactAutoRefineSurface;

use super::events::AcpEngineEvent;
use super::session::AcpSession;
use super::AcpModeState;

/// The namespaced `refinement` meta event one applied refinement
/// publishes (the same shape the `/refine` command and the requested
/// `refine.run` round publish).
pub(super) fn refine_complete_event(result: &RefinementResult) -> AcpEngineEvent {
    let changes = result
        .applied_edits
        .iter()
        .filter(|edit| edit.applied)
        .map(|edit| {
            let action = serde_json::to_value(edit.action)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default();
            let kind = serde_json::to_value(edit.kind)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default();
            format!("{action} {kind}:{}", edit.id)
        })
        .collect();
    AcpEngineEvent::RefineComplete {
        summary: result.summary.clone(),
        changes,
    }
}

impl AcpSession {
    /// Consume an armed trigger at the serialized checkpoint between
    /// turns (TS `_runSerializedRefineCheckpointAfterBackground`'s
    /// compact step): the gates and the review run in the pa-core seam;
    /// an approved round publishes its `refinement` meta exactly like
    /// the requested refinement round, and a failed round publishes the
    /// `RefineFailed` mapping (TS emits `refine_failed` on the wire for
    /// a failed serialized round). A declined review stays silent.
    pub(super) async fn consume_compact_auto_refine(&self, mode: &AcpModeState) {
        let Some(model) = mode.model.clone() else {
            return;
        };
        let outcome = self
            .consume_compact_auto_refine_round(mode, &model, CompactAutoRefineSurface::Checkpoint)
            .await;
        self.publish_compact_auto_refine_outcome(outcome).await;
    }

    /// The disposal drain (TS `dispose`'s serialized arm: "a serialized
    /// compaction can finish without another model turn — drain its
    /// pending review here so disposal does not silently lose the
    /// trigger"): session close services an armed trigger one last
    /// time; a trigger under the cooldown drops without a review. The
    /// round is best-effort like the TS drain — close proceeds even
    /// when the review fails.
    pub(super) async fn drain_compact_auto_refine_at_close(&self, mode: &AcpModeState) {
        let Some(model) = mode.model.clone() else {
            return;
        };
        let outcome = self
            .consume_compact_auto_refine_round(mode, &model, CompactAutoRefineSurface::Dispose)
            .await;
        self.publish_compact_auto_refine_outcome(outcome).await;
    }

    /// The shared round body: the pa-core consumption with its
    /// gate/review/stamp sequence. `Ok(None)` is every silent outcome
    /// (no trigger armed, a gate dropping it, the cooldown holding it,
    /// or a declined review).
    async fn consume_compact_auto_refine_round(
        &self,
        mode: &AcpModeState,
        model: &pa_types::ai::Model,
        surface: CompactAutoRefineSurface,
    ) -> anyhow::Result<Option<RefinementResult>> {
        mode.engine
            .session
            .consume_compact_auto_refine(
                model,
                mode.api_key.clone(),
                mode.agent_dir.as_path().to_path_buf(),
                surface,
            )
            .await
    }

    /// One round's `refinement` meta surface: an approved round
    /// publishes the complete mapping, a failed round the failure
    /// mapping, and every silent outcome nothing.
    async fn publish_compact_auto_refine_outcome(
        &self,
        outcome: anyhow::Result<Option<RefinementResult>>,
    ) {
        match outcome {
            Ok(Some(result)) => {
                let event = refine_complete_event(&result);
                self.publish_engine_event(&event).await;
            }
            Ok(None) => {}
            Err(error) => {
                self.publish_engine_event(&AcpEngineEvent::RefineFailed {
                    error: format!("{error:#}"),
                })
                .await;
            }
        }
    }
}

#[cfg(test)]
// The faux provider registry is process-global and shared with the
// daemon engine tests: the std lock serializes every test that drives
// it, and the async tests here hold it across their awaits on purpose
// (the tests are the only contenders, so no cross-task deadlock).
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::*;
    use crate::agent_engine::FAUX_TEST_LOCK;

    /// The faux model's per-request output budget (maxTokens 16_384 under the
    /// 32_000 request cap): threshold fixtures subtract it from the window
    /// alongside the headroom (the combined input+output ceiling).
    const FAUX_REQUEST_BUDGET: u64 = 16_384;

    use pa_core::session::manager::SessionManager;
    use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
    use pa_core::session_engine::provider_adapter::{json_round_trip, real_stream_fn};
    use serde_json::json;
    use tokio::sync::{mpsc, Mutex};

    use super::super::producer::UpdateProducer;
    use super::super::prompt::handle_session_prompt;
    use super::super::{ConnectionState, SessionEntry};

    /// The ACP meta namespace on the wire.
    const META: &str = "ai.primeintellect.prime-agent";

    /// A declining review reply.
    const DECLINE: &str = r#"{"shouldRefine": false, "rationale": "one-off tool output"}"#;

    /// One armed ACP prompt turn over an in-process faux engine whose
    /// session is persisted (the CLI-built ACP engine shape: a material
    /// session file, hence the local harness dir the refine surface
    /// gates on).
    struct AcpAutorefineBed {
        mode: AcpModeState,
        state: std::sync::Arc<Mutex<ConnectionState>>,
        session_id: String,
        tx: super::super::producer::FrameSink,
        frames: mpsc::UnboundedReceiver<serde_json::Value>,
        next_request_id: u64,
        engine: std::sync::Arc<pa_core::session_engine::engine::SessionEngine>,
        /// Held so the engine's cwd outlives the test.
        _dir: tempfile::TempDir,
    }

    async fn acp_autorefine_bed(
        script: serde_json::Value,
        reserve_tokens: u64,
    ) -> AcpAutorefineBed {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("settings.json"),
            json!({
                "compaction": {
                    "enabled": true,
                    "reserveTokens": reserve_tokens,
                    "keepRecentTokens": 10,
                }
            })
            .to_string(),
        )
        .unwrap();
        let parsed = pa_ai::faux::script::parse_faux_script(&script)
            .map_err(anyhow::Error::msg)
            .unwrap();
        let registration = pa_ai::faux::script::register_faux_provider_from_script(&parsed);
        let model = registration.get_model();
        let agent_model: pa_agent::types::Model =
            json_round_trip(&model).expect("model conversion");
        let stream_fn = real_stream_fn(None, model.clone());
        let mut session_manager = SessionManager::in_memory(dir.path());
        session_manager.materialize_session_file(Some(dir.path().join("sessions")));
        let engine = std::sync::Arc::new(
            create_session(SessionEngineConfig {
                cron_store: None,
                queued_steering_probe: None,
                image_model_router: None,
                steering_mode: None,
                follow_up_mode: None,
                telemetry: None,
                cwd: dir.path().to_path_buf(),
                agent_dir: agent_dir.clone(),
                mcp_manager: None,
                model: Some(agent_model),
                thinking_level: None,
                stream_fn: Some(stream_fn),
                tools: Vec::new(),
                custom_system_prompt: None,
                prompt_guidelines: Vec::new(),
                generic_mcp_servers: Vec::new(),
                allow_recursion: None,
                session_manager: Some(session_manager),
                extra_host_handlers: None,
                conversation_log_path: None,
                additional_skill_paths: Vec::new(),
                additional_prompt_paths: Vec::new(),
                extra_builtin_skill_overrides: Vec::new(),
                rlm_subagent_host: None,
                rlm_depth: None,
                model_info: Some(model.clone()),
                cli_extension_sources: Vec::new(),
                extension_tool_allow_list: None,
                // The settings default (no prewarm); the ACP autorefine
                // tests do not exercise kernel boot paths.
                prewarm_ipython_kernel: None,
                queued_goal_context_purge: None,
            })
            .await
            .unwrap(),
        );
        let (tx, frames) = mpsc::unbounded_channel::<serde_json::Value>();
        let session_id = "acp-autorefine-session".to_string();
        let producer = UpdateProducer::new(session_id.clone(), tx.clone());
        let autonomous = std::sync::Arc::new(Mutex::new(
            pa_core::autonomous::create_autonomous_runtime_state(None, None),
        ));
        let driver: std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver> =
            std::sync::Arc::new(pa_core::autonomous::ShellAutonomousDriver::new(dir.path()));
        let session = std::sync::Arc::new(
            super::AcpSession::new(
                session_id.clone(),
                engine.clone(),
                producer.clone(),
                autonomous,
                driver,
            )
            .await,
        );
        producer.commit_session_new_response().await;
        let state = std::sync::Arc::new(Mutex::new(ConnectionState {
            session: Some(SessionEntry {
                session,
                prompt_task: None,
            }),
            session_new_in_flight: false,
            session_close_in_flight: false,
        }));
        let mode = AcpModeState {
            engine: engine.clone(),
            actual_cwd: std::sync::Arc::new(dir.path().to_path_buf()),
            product_version: std::sync::Arc::new("test".to_string()),
            model: Some(model),
            api_key: None,
            agent_dir: std::sync::Arc::new(agent_dir),
            autonomous_config: None,
            mcp: engine.mcp_manager.clone(),
            mcp_owner_id: std::sync::Arc::new("acp-autorefine-owner".to_string()),
            mcp_server_names: std::sync::Arc::new(Mutex::new(Vec::new())),
        };
        AcpAutorefineBed {
            mode,
            state,
            session_id,
            tx,
            frames,
            next_request_id: 0,
            engine,
            _dir: dir,
        }
    }

    impl AcpAutorefineBed {
        /// Admit one prompt through the real ACP prompt handler and read
        /// frames until its response: (response, notifications in order).
        async fn prompt(&mut self, text: String) -> (serde_json::Value, Vec<serde_json::Value>) {
            self.next_request_id += 1;
            let id = serde_json::Value::from(self.next_request_id);
            handle_session_prompt(
                id.clone(),
                json!({
                    "sessionId": self.session_id,
                    "prompt": [{ "type": "text", "text": text }],
                }),
                self.state.clone(),
                self.mode.clone(),
                self.tx.clone(),
            )
            .await;
            let mut notifications = Vec::new();
            loop {
                let Some(frame) = self.frames.recv().await else {
                    panic!("ACP frame channel closed before the response");
                };
                if frame.get("id") == Some(&id)
                    && (frame.get("result").is_some() || frame.get("error").is_some())
                {
                    return (frame, notifications);
                }
                notifications.push(frame);
            }
        }

        /// The hosted session handle (the close-drain caller's shape).
        async fn session(&self) -> std::sync::Arc<super::AcpSession> {
            self.state
                .lock()
                .await
                .session
                .as_ref()
                .expect("the session is hosted")
                .session
                .clone()
        }

        /// The published `refinement` metas among a turn's notifications.
        fn refinement_metas(notifications: &[serde_json::Value]) -> Vec<serde_json::Value> {
            notifications
                .iter()
                .filter_map(|frame| {
                    Some(
                        frame
                            .get("params")?
                            .get("update")?
                            .get("_meta")?
                            .get(META)?
                            .get("refinement")?
                            .clone(),
                    )
                })
                .collect()
        }

        /// The published `compaction` metas.
        fn compaction_metas(notifications: &[serde_json::Value]) -> Vec<serde_json::Value> {
            notifications
                .iter()
                .filter_map(|frame| {
                    Some(
                        frame
                            .get("params")?
                            .get("update")?
                            .get("_meta")?
                            .get(META)?
                            .get("compaction")?
                            .clone(),
                    )
                })
                .collect()
        }

        /// The settled assistant usage of the newest assistant turn.
        async fn latest_usage(&self) -> u64 {
            super::super::session::latest_assistant_message(self.engine.session.agent())
                .await
                .expect("an assistant message")
                .usage
                .total_tokens
        }
    }

    /// The threshold compaction at the settled boundary arms the trigger
    /// and the serialized checkpoint consumes it in the same prompt: the
    /// review declines (the queued reply after it serves the next turn)
    /// and nothing surfaces.
    #[tokio::test]
    async fn threshold_compaction_consumes_the_trigger_at_the_checkpoint() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Probe: the seed turn's usage.
        let mut probe =
            acp_autorefine_bed(json!({ "responses": [{ "text": "seed reply" }] }), 1).await;
        probe
            .prompt(format!("seed turn {}", "x".repeat(48_000)))
            .await;
        let seed_usage = probe.latest_usage().await;
        assert!(
            seed_usage > 0 && seed_usage < 100_000,
            "usage: {seed_usage}"
        );
        drop(probe);

        let crossing_delta = (8_000 + "seed turn  crossing".len() as u64).div_ceil(4);
        let mut bed = acp_autorefine_bed(
            json!({
                "responses": [
                    { "text": "seed reply" },
                    { "text": "crossing reply" },
                    { "text": "the summary" },
                    { "text": DECLINE },
                    { "text": "third reply" },
                ]
            }),
            128_000u64
                .saturating_sub(FAUX_REQUEST_BUDGET + seed_usage + crossing_delta / 4)
                .max(1),
        )
        .await;
        let (response, notifications) = bed
            .prompt(format!("seed turn {}", "x".repeat(48_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        assert!(AcpAutorefineBed::compaction_metas(&notifications).is_empty());
        // The crossing turn compacts and the checkpoint consumes the
        // armed trigger: the decline review ran and surfaced nothing.
        let (response, notifications) = bed
            .prompt(format!("crossing turn {}", "x".repeat(8_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        assert_eq!(AcpAutorefineBed::compaction_metas(&notifications).len(), 1);
        assert!(
            AcpAutorefineBed::refinement_metas(&notifications).is_empty(),
            "the decline surfaced nothing"
        );
        assert!(
            !bed.engine.session.compact_auto_refine_pending(),
            "the trigger was consumed"
        );
        // The review consumed the decline: the next turn sees the reply
        // queued after it (a missed review would answer with the decline
        // text).
        let (response, _) = bed.prompt("third turn".to_string()).await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let latest = super::super::session::latest_assistant_message(bed.engine.session.agent())
            .await
            .expect("an assistant message");
        let reply = match &latest.content[0] {
            pa_types::ai::AssistantContentBlock::Text(text) => text.text.clone(),
            _ => String::new(),
        };
        assert_eq!(
            reply, "third reply",
            "the review consumed the queued decline"
        );
    }

    /// An approving checkpoint round publishes the `refinement` complete
    /// meta (the same mapping the `/refine` command produces) and applies
    /// the durable rows.
    #[tokio::test]
    async fn an_approving_checkpoint_round_publishes_the_refinement_meta() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Probe: the seed turn's usage.
        let mut probe =
            acp_autorefine_bed(json!({ "responses": [{ "text": "seed reply" }] }), 1).await;
        probe
            .prompt(format!("seed turn {}", "x".repeat(48_000)))
            .await;
        let seed_usage = probe.latest_usage().await;
        drop(probe);

        let review = r#"{"shouldRefine": true, "rationale": "the turn shows a reusable tactic"}"#;
        let plan = r#"{"summary":"note the tactic","rationale":"repeated","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#;
        let crossing_delta = (8_000 + "seed turn  crossing".len() as u64).div_ceil(4);
        let mut bed = acp_autorefine_bed(
            json!({
                "responses": [
                    { "text": "seed reply" },
                    { "text": "crossing reply" },
                    { "text": "the summary" },
                    { "text": review },
                    { "text": plan },
                ]
            }),
            128_000u64
                .saturating_sub(FAUX_REQUEST_BUDGET + seed_usage + crossing_delta / 4)
                .max(1),
        )
        .await;
        let (response, _) = bed
            .prompt(format!("seed turn {}", "x".repeat(48_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let (response, notifications) = bed
            .prompt(format!("crossing turn {}", "x".repeat(8_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let metas = AcpAutorefineBed::refinement_metas(&notifications);
        assert_eq!(metas.len(), 1, "one refinement meta: {metas:?}");
        assert_eq!(metas[0]["status"], "complete");
        assert_eq!(metas[0]["summary"], "note the tactic");
        assert_eq!(metas[0]["changes"], json!(["create memory:m1"]));
        // The durable rows persisted.
        let rows: Vec<String> = bed
            .engine
            .session
            .shared_persistence()
            .lock()
            .await
            .get_entries()
            .iter()
            .filter_map(|entry| match entry {
                pa_types::session::FileEntry::CustomMessage { payload, .. } => {
                    Some(payload.custom_type.clone())
                }
                _ => None,
            })
            .collect();
        assert!(
            rows.iter().any(|kind| kind == "refinement_outcome")
                && rows.iter().any(|kind| kind == "refinement_notice"),
            "the refinement rows persisted: {rows:?}"
        );
    }

    /// The session-close drain (TS `dispose`): a `/compact` session
    /// command arms the trigger no turn services, and the close runs the
    /// round — an approving review publishes its refinement meta before
    /// the subscription tears down.
    #[tokio::test]
    async fn session_close_drains_an_armed_trigger() {
        let _faux = FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let review = r#"{"shouldRefine": true, "rationale": "the turn shows a reusable tactic"}"#;
        let plan = r#"{"summary":"note the tactic","rationale":"repeated","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#;
        let mut bed = acp_autorefine_bed(
            json!({
                "responses": [
                    { "text": "seed reply" },
                    { "text": "second reply" },
                    { "text": "the summary" },
                    { "text": review },
                    { "text": plan },
                ]
            }),
            // reserve 1: the threshold headroom never crosses, so only
            // the `/compact` session command compacts and arms.
            1,
        )
        .await;
        let (response, _) = bed
            .prompt(format!("seed turn {}", "x".repeat(48_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        let (response, _) = bed
            .prompt(format!("second turn {}", "x".repeat(48_000)))
            .await;
        assert_eq!(response["result"]["stopReason"], "end_turn");
        // The `/compact` session command: the compaction runs, no turn
        // follows, and the trigger stays armed for the close drain.
        let (response, notifications) = bed.prompt("/compact".to_string()).await;
        for entry in bed
            .engine
            .session
            .shared_persistence()
            .lock()
            .await
            .get_entries()
        {
            if let pa_types::session::FileEntry::CustomMessage { payload, .. } = entry {
                eprintln!(
                    "CLOSE-TEST row {} {:?}",
                    payload.custom_type, payload.content
                );
            }
        }
        assert_eq!(response["result"]["stopReason"], "end_turn");
        assert_eq!(AcpAutorefineBed::compaction_metas(&notifications).len(), 1);
        assert!(
            bed.engine.session.compact_auto_refine_pending(),
            "the session command armed the trigger"
        );
        let session = bed.session().await;
        session.drain_compact_auto_refine_at_close(&bed.mode).await;
        assert!(
            !bed.engine.session.compact_auto_refine_pending(),
            "the drain consumed the trigger"
        );
        // The approved round published its refinement meta.
        let mut metas = Vec::new();
        while let Ok(frame) = bed.frames.try_recv() {
            if let Some(meta) = frame
                .get("params")
                .and_then(|params| params.get("update"))
                .and_then(|update| update.get("_meta"))
                .and_then(|meta| meta.get(META))
                .and_then(|meta| meta.get("refinement"))
                .cloned()
            {
                metas.push(meta);
            }
        }
        assert_eq!(metas.len(), 1, "one refinement meta: {metas:?}");
        assert_eq!(metas[0]["status"], "complete");
    }
}
