//! The compaction-arms unit battery: the threshold arm, the overflow
//! attempts, the requested arm, and the abort slot.
use super::*;
use crate::agent_engine::FAUX_TEST_LOCK;

/// The faux model's per-request output budget (maxTokens `16_384` under the
/// `32_000` request cap): threshold fixtures subtract it from the window
/// alongside the headroom (the combined input+output ceiling).
const FAUX_REQUEST_BUDGET: u64 = 16_384;

use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
use pa_core::session_engine::provider_adapter::{json_round_trip, real_stream_fn};
use serde_json::json;
use tokio::sync::{mpsc, Mutex};

use super::super::producer::UpdateProducer;
use super::super::prompt::handle_session_prompt;
use super::super::session::AcpSession;
use super::super::{AcpModeState, ConnectionState, SessionEntry};

/// The ACP meta namespace on the wire.
const META: &str = "ai.primeintellect.prime-agent";

/// One armed ACP prompt turn over an in-process faux engine. The faux
/// provider registry is process-global, so every test holds the
/// shared lock like the daemon engine tests.
struct AcpTestBed {
    mode: AcpModeState,
    state: std::sync::Arc<Mutex<ConnectionState>>,
    session_id: String,
    tx: super::super::producer::FrameSink,
    frames: mpsc::UnboundedReceiver<serde_json::Value>,
    next_request_id: u64,
    engine: std::sync::Arc<SessionEngine>,
    /// Held so the engine's cwd outlives the test.
    _dir: tempfile::TempDir,
}

/// Build one bed: the faux script drives the provider, the compaction
/// settings come from the agent dir, and the ACP session wraps the
/// engine exactly like `session/new` does.
async fn acp_test_bed(
    script: serde_json::Value,
    reserve_tokens: u64,
    keep_recent_tokens: u64,
) -> AcpTestBed {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("settings.json"),
        json!({
            "compaction": {
                "enabled": true,
                "reserveTokens": reserve_tokens,
                "keepRecentTokens": keep_recent_tokens,
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
    let agent_model: pa_agent::types::Model = json_round_trip(&model).expect("model conversion");
    let stream_fn = real_stream_fn(None, model.clone());
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
            session_manager: None,
            extra_host_handlers: None,
            conversation_log_path: None,
            additional_skill_paths: Vec::new(),
            additional_prompt_paths: Vec::new(),
            extra_builtin_skill_overrides: Vec::new(),
            rlm_subagent_host: None,
            rlm_depth: None,
            model_info: Some(model.clone()),
            prewarm_ipython_kernel: None,
            on_background_work_settled: None,
            queued_goal_context_purge: None,
        })
        .await
        .unwrap(),
    );
    let (tx, frames) = mpsc::unbounded_channel::<serde_json::Value>();
    let session_id = "acp-test-session".to_string();
    let producer = UpdateProducer::new(session_id.clone(), tx.clone());
    let autonomous = std::sync::Arc::new(Mutex::new(
        pa_core::autonomous::create_autonomous_runtime_state(None, None),
    ));
    let driver: std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver> =
        std::sync::Arc::new(pa_core::autonomous::ShellAutonomousDriver::new(dir.path()));
    let session = std::sync::Arc::new(
        AcpSession::new(
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
            config: std::sync::Arc::new(super::super::InProcessConfig {
                published: tokio::sync::Mutex::new(Vec::new()),
                models: tokio::sync::Mutex::new(Vec::new()),
            }),
            config_refresh: None,
        }),
        session_new_in_flight: false,
        session_close_in_flight: false,
    }));
    let mode = AcpModeState {
        engine: engine.clone(),
        actual_cwd: std::sync::Arc::new(dir.path().to_path_buf()),
        product_version: std::sync::Arc::new("test".to_string()),
        model: std::sync::Arc::new(Mutex::new(Some(model))),
        api_key: std::sync::Arc::new(Mutex::new(None)),
        config_queue: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        agent_dir: std::sync::Arc::new(agent_dir),
        provider_target: std::sync::Arc::new(std::sync::RwLock::new(None)),
        autonomous_config: None,
        mcp: engine.mcp_manager.clone(),
        mcp_owner_id: std::sync::Arc::new("acp-test-owner".to_string()),
        mcp_server_names: std::sync::Arc::new(Mutex::new(Vec::new())),
    };
    AcpTestBed {
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

impl AcpTestBed {
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

    /// The published `compaction` metas (the ACP `compaction_end`
    /// mapping) among a turn's notifications.
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

    /// The durable entry chain.
    async fn entries(&self) -> Vec<pa_types::session::FileEntry> {
        self.engine
            .session
            .shared_persistence()
            .lock()
            .await
            .get_entries()
    }
}

/// The TS overflow error shape: an Anthropic token-overflow message.
/// The retry-turn entry paces the stream (`delayMs`) so its settled
/// message timestamp lands strictly after the compaction entry's (the
/// `assistantIsFromBeforeCompaction` guard compares millisecond
/// timestamps; a real provider round-trip spans more than one).
fn overflow_error(delay_ms: u64) -> serde_json::Value {
    let mut entry = json!({
        "text": "",
        "stopReason": "error",
        "errorMessage": "prompt is too long: 213462 tokens > 200000 maximum",
    });
    if delay_ms > 0 {
        entry["delayMs"] = json!(delay_ms);
    }
    entry
}

/// The threshold arm on the ACP turn path: a settled turn whose usage
/// crosses the reserve headroom runs one compaction at the boundary
/// and publishes the `compaction` meta (tokensBefore + summary), and
/// the turn still settles with `end_turn`. The faux provider
/// estimates usage from the serialized context, so the probe measures
/// one seed turn's usage and the reserve sits between the two turns'
/// usage (the daemon engine tests' environment-independent recipe).
#[tokio::test]
async fn threshold_arm_compacts_and_publishes_the_acp_meta() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Probe: the seed turn's total usage (system prompt included).
    let mut probe = acp_test_bed(json!({ "responses": [{ "text": "seed reply" }] }), 1, 10).await;
    probe
        .prompt(format!("seed turn {}", "x".repeat(48_000)))
        .await;
    let seed_usage = probe.latest_usage().await;
    assert!(
        seed_usage > 0 && seed_usage < 100_000,
        "usage: {seed_usage}"
    );
    drop(probe);

    // The crossing prompt adds ~2000 tokens; the headroom sits
    // between the two turns' usage (500-token margins on both
    // sides).
    let crossing_delta = (8_000 + "seed turn  crossing".len() as u64).div_ceil(4);
    let mut bed = acp_test_bed(
        json!({
            "responses": [
                { "text": "seed reply" },
                { "text": "crossing reply" },
                { "text": "the summary" },
            ]
        }),
        128_000u64
            .saturating_sub(FAUX_REQUEST_BUDGET + seed_usage + crossing_delta / 4)
            .max(1),
        10,
    )
    .await;
    // The seed turn stays below the headroom: no compaction.
    let (response, notifications) = bed
        .prompt(format!("seed turn {}", "x".repeat(48_000)))
        .await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    assert!(AcpTestBed::compaction_metas(&notifications).is_empty());
    // The threshold-crossing turn: the settled usage fires one
    // compaction at the boundary (the summarizer consumed the third
    // scripted response).
    let (response, notifications) = bed
        .prompt(format!("crossing turn {}", "x".repeat(8_000)))
        .await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    let metas = AcpTestBed::compaction_metas(&notifications);
    assert_eq!(metas.len(), 1, "one compaction meta: {metas:?}");
    assert_eq!(metas[0]["summary"], "the summary");
    assert!(metas[0]["tokensBefore"].as_u64().unwrap() > 0);
    assert!(
        bed.entries()
            .await
            .iter()
            .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. })),
        "the compaction persisted"
    );
}

/// Below the headroom nothing fires: no compaction meta, no entry.
#[tokio::test]
async fn below_headroom_no_arm_fires() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut bed = acp_test_bed(json!({ "responses": [{ "text": "small reply" }] }), 1, 10).await;
    let (response, notifications) = bed.prompt("small turn".to_string()).await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    assert!(AcpTestBed::compaction_metas(&notifications).is_empty());
    assert!(!bed
        .entries()
        .await
        .iter()
        .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. })));
}

/// The overflow arm on the ACP turn path: an overflow error turn
/// compacts once (the compact-and-retry) and the retried turn settles
/// the prompt with `end_turn` instead of the error.
#[tokio::test]
async fn overflow_arm_compacts_and_retries_the_turn() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut bed = acp_test_bed(
        json!({
            "responses": [
                { "text": "seed reply" },
                overflow_error(0),
                { "text": "the summary" },
                { "text": "recovered reply" },
            ]
        }),
        1,
        10,
    )
    .await;
    let (response, _) = bed
        .prompt(format!("seed turn {}", "x".repeat(48_000)))
        .await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    let (response, notifications) = bed
        .prompt(format!("overflow probe {}", "x".repeat(2_000)))
        .await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    let metas = AcpTestBed::compaction_metas(&notifications);
    assert_eq!(metas.len(), 1, "one compaction meta: {metas:?}");
    assert_eq!(metas[0]["summary"], "the summary");
    assert!(metas[0]["tokensBefore"].as_u64().unwrap() > 0);
    // The retried turn is the settled outcome: no failure rows on the
    // recovered run (the daemon worker's contract).
    let latest = super::super::session::latest_assistant_message(bed.engine.session.agent())
        .await
        .expect("an assistant message");
    assert_eq!(latest.stop_reason, pa_types::ai::StopReason::Stop);
    assert!(
        bed.entries()
            .await
            .iter()
            .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. })),
        "the compaction persisted"
    );
}

/// A retry that still overflows reports once (the TS failure text) and
/// ends the run with the overflow error: the successful
/// compact-and-retry publishes the result meta, the report publishes
/// the empty payload, and the prompt errors.
#[tokio::test]
async fn overflow_retry_that_overflows_again_reports_once() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut bed = acp_test_bed(
        json!({
            "responses": [
                { "text": "seed reply" },
                overflow_error(0),
                { "text": "the summary" },
                overflow_error(25),
            ]
        }),
        1,
        10,
    )
    .await;
    let (response, _) = bed
        .prompt(format!("seed turn {}", "x".repeat(48_000)))
        .await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    let (response, notifications) = bed
        .prompt(format!("overflow probe {}", "x".repeat(2_000)))
        .await;
    assert_eq!(response["error"]["code"], -32603, "the turn failed");
    let details = response["error"]["data"]["details"]
        .as_str()
        .unwrap_or_default();
    assert!(
        details.contains("prompt is too long"),
        "the overflow error text surfaces: {response}"
    );
    let metas = AcpTestBed::compaction_metas(&notifications);
    assert_eq!(metas.len(), 2, "the run + the report: {metas:?}");
    assert_eq!(metas[0]["summary"], "the summary");
    assert_eq!(metas[1], json!({}));
    // The durable disclosure row carries the TS report text.
    let entries = bed.entries().await;
    let rows = entries
        .iter()
        .filter_map(|entry| match entry {
            pa_types::session::FileEntry::CustomMessage { payload, .. } => Some(payload),
            _ => None,
        })
        .filter(|payload| payload.custom_type == "compaction_outcome")
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 1, "one disclosure row");
    assert_eq!(
        serde_json::to_value(&rows[0].content).unwrap(),
        json!("Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.")
    );
}

/// The requested arm on the ACP turn path: a scheduled `compact.run`
/// request is consumed at the next admitted prompt's pre-turn boundary
/// (TS `_runPreTurnCompaction` runs the requested arm too), publishes
/// the compaction meta, and stops the turn loop on purpose (the run
/// still settles `end_turn`); the request is taken regardless of
/// outcome.
#[tokio::test]
async fn requested_arm_consumes_the_scheduled_compaction() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut bed = acp_test_bed(
        json!({
            "responses": [
                { "text": "seed reply" },
                { "text": "turn two reply" },
                { "text": "the requested summary" },
                { "text": "turn three reply" },
            ]
        }),
        1,
        10,
    )
    .await;
    let (response, _) = bed
        .prompt(format!("seed turn {}", "x".repeat(48_000)))
        .await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    let (response, _) = bed.prompt(format!("turn two {}", "x".repeat(2_000))).await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    // Schedule a requested compaction (the `compact.run` write path):
    // the next prompt's pre-turn boundary consumes it. The session
    // carries two settled turns, so the keep-recent cut leaves the
    // first turn summarizable.
    bed.engine
        .turn_boundary
        .schedule_compaction(Some("keep the checklist".to_string()))
        .await;
    let (response, notifications) = bed.prompt("turn three".to_string()).await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    let metas = AcpTestBed::compaction_metas(&notifications);
    assert_eq!(metas.len(), 1, "one compaction meta: {metas:?}");
    assert_eq!(metas[0]["summary"], "the requested summary");
    assert!(!bed.engine.turn_boundary.compaction_scheduled().await);
    assert!(
        bed.entries()
            .await
            .iter()
            .any(|entry| matches!(entry, pa_types::session::FileEntry::Compaction { .. })),
        "the requested compaction persisted"
    );
}

/// A skipped requested compaction still consumes the request and
/// publishes the empty payload (the TS `compaction_end` with
/// `result: undefined`), plus the durable disclosure row with the
/// requested-skip message.
#[tokio::test]
async fn requested_arm_skip_publishes_the_empty_payload() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // `keepRecentTokens` beyond the whole session: the cut keeps
    // everything, so the compaction skips as too short.
    let mut bed = acp_test_bed(
        json!({ "responses": [{ "text": "seed reply" }, { "text": "turn two reply" }] }),
        1,
        100_000,
    )
    .await;
    let (response, _) = bed.prompt("seed turn".to_string()).await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    bed.engine.turn_boundary.schedule_compaction(None).await;
    let (response, notifications) = bed.prompt("turn two".to_string()).await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    let metas = AcpTestBed::compaction_metas(&notifications);
    assert_eq!(metas.len(), 1, "the skip is observable: {metas:?}");
    assert_eq!(metas[0], json!({}));
    assert!(!bed.engine.turn_boundary.compaction_scheduled().await);
    let entries = bed.entries().await;
    let row = entries
        .iter()
        .filter_map(|entry| match entry {
            pa_types::session::FileEntry::CustomMessage { payload, .. } => Some(payload),
            _ => None,
        })
        .find(|payload| payload.custom_type == "compaction_outcome")
        .expect("the disclosure row persisted");
    assert_eq!(
        serde_json::to_value(&row.content).unwrap(),
        json!("Requested compaction skipped: Session is too short to compact — try again once it grows")
    );
}

/// The overflow machine resets at a user row that starts an agent run
/// (TS `startsAgentRun` at `message_start`): the reported state from
/// the previous prompt's failed recovery never suppresses the next
/// prompt's fresh attempt, and the fresh turn's overflow recovers at
/// its own boundary.
#[tokio::test]
async fn overflow_state_resets_per_agent_run() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut bed = acp_test_bed(
        json!({
            "responses": [
                { "text": "seed reply" },
                overflow_error(0),
                { "text": "the summary" },
                overflow_error(25),
                overflow_error(25),
                { "text": "the second summary" },
                { "text": "recovered after the stale overflow" },
            ]
        }),
        1,
        10,
    )
    .await;
    let (response, _) = bed
        .prompt(format!("seed turn {}", "x".repeat(48_000)))
        .await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    // Prompt two: attempt, the retry overflows, reported — the run
    // ends with the error.
    let (response, notifications) = bed
        .prompt(format!("overflow probe {}", "x".repeat(2_000)))
        .await;
    assert_eq!(response["error"]["code"], -32603);
    assert_eq!(
        AcpTestBed::compaction_metas(&notifications).len(),
        2,
        "the run + the report"
    );
    // Prompt three: the fresh user row reset the machine, so the
    // turn's own overflow gets a fresh attempt and the retry
    // recovers.
    let (response, notifications) = bed.prompt("second prompt".to_string()).await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    let metas = AcpTestBed::compaction_metas(&notifications);
    assert_eq!(metas.len(), 1, "a fresh attempt ran: {metas:?}");
    assert_eq!(metas[0]["summary"], "the second summary");
}

/// The overflow retry re-issues without re-adding the user message (TS
/// `agent.continue()`): the durable chain carries the seed and probe
/// rows only.
#[tokio::test]
async fn overflow_retry_turn_adds_no_user_row() {
    let _faux = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut bed = acp_test_bed(
        json!({
            "responses": [
                { "text": "seed reply" },
                overflow_error(0),
                { "text": "the summary" },
                { "text": "recovered reply" },
            ]
        }),
        1,
        10,
    )
    .await;
    let (response, _) = bed
        .prompt(format!("seed turn {}", "x".repeat(48_000)))
        .await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    let (response, _) = bed
        .prompt(format!("overflow probe {}", "x".repeat(2_000)))
        .await;
    assert_eq!(response["result"]["stopReason"], "end_turn");
    let users = bed
        .entries()
        .await
        .iter()
        .filter(|entry| {
            matches!(
                entry,
                pa_types::session::FileEntry::Message {
                    message: pa_types::session::AgentMessage::User(_),
                    ..
                }
            )
        })
        .count();
    assert_eq!(users, 2, "the retry added no user row");
}
