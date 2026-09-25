//! The RPC command surface, part one: the dispatch table plus the
//! prompting, state, model, thinking, queue-mode, and compaction
//! handlers (TS `rpc-mode.ts`'s `handleCommand` cases). Session-level and
//! scheduling commands live in [`super::session_commands`].

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use pa_core::autonomous::AutonomousRuntimeState;
use pa_core::session_engine::provider_adapter::json_round_trip;

use pa_types::goal::GoalState;

use super::model_commands;
use super::prompt_commands;
use super::protocol::{self, ResponseData};
use super::session::{RpcEngineRequest, RpcSession};
use super::session_commands;
use super::LineWriter;

/// The shared handler state: the live session plus the fixed identity and
/// the session-scoped runtime pieces the handlers own.
pub struct RpcState {
    pub session: Arc<RpcSession>,
    pub writer: LineWriter,
    pub cwd: std::path::PathBuf,
    pub agent_dir: std::path::PathBuf,
    /// The compact handler's in-flight flag (TS `session.isCompacting`):
    /// `get_state` reports it while a compact command runs.
    pub compacting: Arc<AtomicBool>,
    /// The host-owned autonomous runtime state (`/autonomous` mutates it;
    /// the CLI flags seed it, TS `createAgentSession` parity).
    pub autonomous: Arc<tokio::sync::Mutex<AutonomousRuntimeState>>,
    /// The last `goal_update` event payload published (change-gated emits).
    pub last_goal: Arc<tokio::sync::Mutex<GoalState>>,
    /// The queued-work pump's serialization lane (one pump at a time).
    pub queue_pump: Arc<tokio::sync::Mutex<()>>,
    /// TS `_sessionInputPumpSuspended`: an abort suspends queued-input
    /// delivery; the next prompt/steer/follow-up resumes it.
    pub pump_suspended: Arc<std::sync::atomic::AtomicBool>,
}

impl RpcState {
    /// Publish the current goal state as a `goal_update` session event
    /// when it changed (TS `_emitGoalUpdate`).
    pub async fn publish_goal_update(&self) {
        let handle = self.session.handle().await;
        let goal = handle.engine.goal_state().await;
        drop(handle);
        let changed = {
            let mut last = self.last_goal.lock().await;
            if *last == goal {
                false;
            } else {
                *last = goal.clone();
                true
            }
        };
        if changed {
            self.session
                .write_connection_output(json!({
                    "type": "goal_update",
                    "goal": serde_json::to_value(&goal).unwrap_or(Value::Null),
                }))
                .await;
        }
    }
}

/// Resume queued-input delivery (TS `_resumeSessionInputAdmission`): the
/// pump restarts with the next queued batch.
pub fn resume_pump(state: &Arc<RpcState>) {
    state
        .pump_suspended
        .store(false, std::sync::atomic::Ordering::SeqCst);
}

/// Kick the queued-work pump (TS `_pumpSessionInputs`): deliver queued
/// steering/follow-up batches as runs, one settled turn at a time, until
/// nothing is queued or an abort suspends delivery. Serialized behind the
/// pump lane so concurrent kicks never double-deliver.
pub fn kick_queue_pump(
    state: &Arc<RpcState>,
    engine: &Arc<pa_core::session_engine::engine::SessionEngine>,
) {
    let state = Arc::clone(state);
    let engine = Arc::clone(engine);
    // The generation this pump serves: a whole-session replacement
    // (new_session/switch_session/fork) retires it — the pump must never
    // deliver queued input to the disposed session it was spawned with.
    let generation = state.session.pump_generation();
    tokio::spawn(async move {
        let _lane = state.queue_pump.lock().await;
        if state.session.pump_generation() != generation {
            return;
        }
        let agent = engine.session.agent();
        loop {
            if state.session.pump_generation() != generation {
                return;
            }
            if state
                .pump_suspended
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                break;
            }
            agent.wait_for_idle().await;
            if !agent.has_queued_messages() {
                break;
            }
            if state
                .pump_suspended
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                break;
            }
            // Deliver the next queued batch (`continue_run` drains the
            // steering lane first, then follow-ups); a delivery failure
            // ends the pump run (the error surfaced to the client through
            // the aborting command's own channel in TS; here the queue
            // stays and the next kick retries).
            if agent.continue_run().await.is_err() {
                break;
            }
        }
    });
}

/// Dispatch one command to its handler; the unknown-type error answers
/// with no id (TS `handleCommand`'s default arm).
pub async fn handle_command(state: &Arc<RpcState>, command: protocol::RpcCommand) -> Value {
    let id = command.id.clone();
    let payload = command.payload.clone();
    let name = command.command.as_str();
    let outcome: Result<ResponseData, String> = match name {
        "prompt" => prompt_commands::prompt(state, &payload).await,
        "steer" | "follow_up" => prompt_commands::steer_or_follow_up(state, &payload, name).await,
        "abort" => {
            state.session.handle().await.engine.session.agent().abort();
            // TS `requestAbort` suspends queued-input delivery; the next
            // prompt/steer/follow-up resumes it.
            state.pump_suspended.store(true, Ordering::SeqCst);
            Ok(ResponseData::Absent)
        }
        "new_session" => new_session(state, &payload).await,
        "get_state" => get_state(state).await,
        "set_model" => model_commands::set_model(state, &payload).await,
        "cycle_model" => model_commands::cycle_model(state).await,
        "get_available_models" => model_commands::get_available_models(state).await,
        "set_thinking_level" => model_commands::set_thinking_level(state, &payload).await,
        "cycle_thinking_level" => model_commands::cycle_thinking_level(state).await,
        "set_steering_mode" | "set_follow_up_mode" => {
            model_commands::set_queue_mode(state, &payload, name).await
        }
        "compact" => compact(state, &payload).await,
        "refine" => refine(state, &payload).await,
        "set_auto_compaction" => set_auto_compaction(state, &payload).await,
        "set_auto_retry" => set_auto_retry(state, &payload).await,
        // TS `abortRetry` always answers success (it aborts only an
        // in-flight retry; the in-process turn path has no parked retry).
        "abort_retry" => Ok(ResponseData::Absent),
        other => session_commands::handle(state, other, &payload).await,
    };
    match outcome {
        Ok(data) => protocol::success(id.as_ref(), name, data),
        Err(message) => protocol::error(id.as_ref(), name, &message),
    }
}

/// `new_session` (TS `runtimeHost.newSession`): a fresh session,
/// optionally under a parent session.
async fn new_session(state: &Arc<RpcState>, payload: &Value) -> Result<ResponseData, String> {
    let parent = payload
        .get("parentSession")
        .and_then(Value::as_str)
        .map(str::to_string);
    state
        .session
        .replace(RpcEngineRequest::New {
            parent_session: parent,
        })
        .await?;
    resume_pump(state);
    Ok(ResponseData::Present(json!({ "cancelled": false })))
}

/// `get_state` (TS `RpcSessionState`).
async fn get_state(state: &Arc<RpcState>) -> Result<ResponseData, String> {
    let handle = state.session.handle().await;
    let engine = &handle.engine;
    let agent = engine.session.agent();
    let agent_state = agent.state().await;
    let persistence = engine.session.shared_persistence();
    let manager = persistence.lock().await;

    let mut object = serde_json::Map::new();
    if let Some(model) = json_round_trip(&agent_state.model) {
        object.insert("model".to_string(), model);
    }
    object.insert(
        "thinkingLevel".to_string(),
        serde_json::to_value(agent_state.thinking_level).unwrap_or(json!("off")),
    );
    object.insert("isStreaming".to_string(), json!(agent_state.is_streaming));
    object.insert(
        "isCompacting".to_string(),
        json!(state.compacting.load(Ordering::SeqCst)),
    );
    object.insert(
        "steeringMode".to_string(),
        json!(queue_mode_wire_name(agent.steering_mode())),
    );
    object.insert(
        "followUpMode".to_string(),
        json!(queue_mode_wire_name(agent.follow_up_mode())),
    );
    if let Some(file) = manager.get_session_file() {
        object.insert("sessionFile".to_string(), json!(file.display().to_string()));
    }
    object.insert("sessionId".to_string(), json!(manager.get_session_id()));
    if let Some(name) = manager.get_session_name() {
        object.insert("sessionName".to_string(), json!(name));
    }
    object.insert(
        "autoCompactionEnabled".to_string(),
        json!(engine.session.auto_compaction_enabled()),
    );
    object.insert(
        "messageCount".to_string(),
        json!(agent_state.messages.len()),
    );
    object.insert(
        "sessionActions".to_string(),
        session_actions_snapshot(agent.as_ref(), &agent_state),
    );
    object.insert(
        "goal".to_string(),
        serde_json::to_value(&*engine.goal_driver.lock().await.state()).unwrap_or(Value::Null),
    );
    Ok(ResponseData::Present(Value::Object(object)))
}

/// The TS `SessionActionSnapshot` over the agent's queues: previews per
/// queued batch, the total, and the running turn as the active action.
fn session_actions_snapshot(
    agent: &pa_agent::agent::Agent,
    state: &pa_agent::types::AgentStateSnapshot,
) -> Value {
    let steering = agent.steering_previews();
    let follow_ups = agent.follow_up_previews();
    let mut snapshot = json!({
        "queuedCount": steering.len() + follow_ups.len(),
        "steering": steering,
        "followUps": follow_ups,
    });
    if state.is_streaming {
        snapshot["active"] = json!({ "kind": "turn", "phase": "running" });
    }
    snapshot
}

/// The wire names of the agent queue modes (TS `"all"`/`"one-at-a-time"`).
fn queue_mode_wire_name(mode: pa_agent::agent::QueueMode) -> &'static str {
    match mode {
        pa_agent::agent::QueueMode::All => "all",
        pa_agent::agent::QueueMode::OneAtATime => "one-at-a-time",
    }
}

/// `compact` (TS `session.compact(customInstructions)`): run the
/// compaction, emit its session events, and answer with the
/// `CompactionResult`; a skip answers the TS `CompactionSkippedError`
/// message.
async fn compact(state: &Arc<RpcState>, payload: &Value) -> Result<ResponseData, String> {
    let instructions = payload
        .get("customInstructions")
        .and_then(Value::as_str)
        .map(str::to_string);
    let (model, api_key, engine) = {
        let handle = state.session.handle().await;
        (
            handle.model.clone(),
            handle.api_key.clone(),
            handle.engine.clone(),
        )
    };
    state.compacting.store(true, Ordering::SeqCst);
    state
        .session
        .write_connection_output(compaction_frame(
            "compaction_start",
            instructions.as_deref(),
            None,
        ))
        .await;
    let outcome = engine
        .session
        .compact(instructions.as_deref(), &model, api_key, None)
        .await;
    state.compacting.store(false, Ordering::SeqCst);
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            // The failed compaction still publishes its end frame (TS
            // writes `compaction_end` around every completed attempt —
            // success, skip, and failure alike).
            state
                .session
                .write_connection_output(compaction_frame(
                    "compaction_end",
                    instructions.as_deref(),
                    None,
                ))
                .await;
            return Err(format!("{error:#}"));
        }
    };
    let outcome_value = match &outcome {
        pa_core::session_engine::compact_session::CompactOutcome::Ran(run) => {
            let result = crate::compaction::compaction_result_value(&run.result, &run.entry);
            state
                .session
                .write_connection_output(compaction_frame(
                    "compaction_end",
                    instructions.as_deref(),
                    Some(&result),
                ))
                .await;
            ResponseData::Present(result)
        }
        pa_core::session_engine::compact_session::CompactOutcome::Skipped(message) => {
            // TS `compaction_end` omits an undefined `result` (the skip
            // is observable, the result is not).
            state
                .session
                .write_connection_output(compaction_frame(
                    "compaction_end",
                    instructions.as_deref(),
                    None,
                ))
                .await;
            return Err(message.to_string());
        }
    };
    Ok(outcome_value)
}

/// One compaction frame in the TS key order, omitting the optional
/// fields that are absent (TS `JSON.stringify`'s `undefined` handling):
/// `compaction_start {type, reason, customInstructions?}` and
/// `compaction_end {type, reason, result?, aborted, willRetry,
/// customInstructions?}`.
pub fn compaction_frame(kind: &str, instructions: Option<&str>, result: Option<&Value>) -> Value {
    match kind {
        "compaction_start" => {
            let mut frame = json!({ "type": kind, "reason": "requested" });
            if let Some(instructions) = instructions {
                frame["customInstructions"] = json!(instructions);
            }
            frame
        }
        _ => {
            let mut frame = json!({ "type": kind, "reason": "requested" });
            if let Some(result) = result {
                frame["result"] = result.clone();
            }
            frame["aborted"] = json!(false);
            frame["willRetry"] = json!(false);
            if let Some(instructions) = instructions {
                frame["customInstructions"] = json!(instructions);
            }
            frame
        }
    }
}

/// `refine` (TS `session.refine`): run the refinement and answer with the
/// `RefinementResult`.
async fn refine(state: &Arc<RpcState>, payload: &Value) -> Result<ResponseData, String> {
    let options = pa_core::session_engine::refine::RefineOptions {
        global: payload
            .get("global")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        instructions: payload
            .get("instructions")
            .and_then(Value::as_str)
            .map(str::to_string),
        rollback_id: payload
            .get("rollbackId")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    let (model, api_key, engine) = {
        let handle = state.session.handle().await;
        (
            handle.model.clone(),
            handle.api_key.clone(),
            handle.engine.clone(),
        )
    };
    let global_harness_dir = pa_core::refinement::get_global_harness_state_dir(&state.agent_dir);
    let result = engine
        .session
        .refine(
            &options,
            pa_core::session_engine::refine::RefinementSource::User,
            &model,
            api_key,
            global_harness_dir,
        )
        .await
        .map_err(|error| format!("{error:#}"))?;
    Ok(ResponseData::Present(
        serde_json::to_value(result).unwrap_or(Value::Null),
    ))
}

/// `set_auto_compaction` (TS `session.setAutoCompactionEnabled`): the
/// live settings toggle plus the settings default TS persists.
async fn set_auto_compaction(
    state: &Arc<RpcState>,
    payload: &Value,
) -> Result<ResponseData, String> {
    let enabled = payload
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| "set_auto_compaction requires enabled".to_string())?;
    // Persist the settings default first: a settings failure must leave
    // the live toggle untouched (the session keeps its configured
    // behavior instead of half-applying the request).
    let mut settings = pa_core::settings::SettingsManager::create(&state.cwd, &state.agent_dir);
    settings
        .set_compaction_enabled(enabled)
        .map_err(|error| error.to_string())?;
    let handle = state.session.handle().await;
    handle.engine.session.set_auto_compaction_enabled(enabled);
    Ok(ResponseData::Absent)
}

/// `set_auto_retry` (TS `session.setAutoRetryEnabled`): the settings
/// toggle the session retry policy reads.
async fn set_auto_retry(state: &Arc<RpcState>, payload: &Value) -> Result<ResponseData, String> {
    let enabled = payload
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| "set_auto_retry requires enabled".to_string())?;
    let mut settings = pa_core::settings::SettingsManager::create(&state.cwd, &state.agent_dir);
    settings
        .set_retry_enabled(enabled)
        .map_err(|error| error.to_string())?;
    Ok(ResponseData::Absent)
}
