//! Kernel host-request handlers for the bundled goal and rlm-heartbeat
//! skills and the generic `telemetry.emit` skill bridge: the `snake_case`
//! bridge the Python REPL skills call. Port of handleGoalHostRequest /
//! handleRlmHeartbeatHostRequest in agent-session.ts plus
//! rlmHeartbeatHostResponse; `telemetry.emit` is Rust-native (no TS
//! counterpart).

use std::future::Future;
use std::pin::Pin;

use serde_json::{json, Value};

use crate::cron::store::{
    AgentCronJobStore, CreateAgentCronJobInput, RlmHeartbeatStatusUpdate, RlmHeartbeatUpdate,
};
use crate::cron::{AgentCronJob, DeliveryMode, JobStatus};
use crate::goals::{goal_host_response, GoalHostResponse, GoalState, GoalStatus};
use crate::session::manager::SessionManager;
use pa_telemetry::{base_properties, lookup, TelemetryClient};

use super::goal_driver::GoalDriver;

/// The `snake_case` heartbeat payload returned to the rlm-heartbeat skill.
pub fn rlm_heartbeat_host_response(job: &AgentCronJob) -> Value {
    json!({
        "id": job.id,
        "status": status_name(job.status),
        "label": nullable_string(job.label.clone()),
        "delivery_mode": job.delivery_mode.map_or("steer", delivery_mode_name),
        "instruction": job.prompt,
        "schedule": serde_json::to_value(&job.schedule).unwrap_or(Value::Null),
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "next_run_at": nullable_string(job.next_run_at.clone()),
        "last_run_at": nullable_string(job.last_run_at.clone()),
        "last_error": nullable_string(job.last_error.clone()),
        "run_count": job.run_count,
    })
}

fn status_name(status: JobStatus) -> &'static str {
    match status {
        JobStatus::Active => "active",
        JobStatus::Paused => "paused",
        JobStatus::Completed => "completed",
        JobStatus::Cancelled => "cancelled",
    }
}

fn delivery_mode_name(mode: DeliveryMode) -> &'static str {
    match mode {
        DeliveryMode::Steer => "steer",
        DeliveryMode::FollowUp => "follow_up",
    }
}

fn nullable_string(value: Option<String>) -> Value {
    match value {
        Some(text) => Value::String(text),
        None => Value::Null,
    }
}

/// Handle a `goal.*` host request. All goal state stays host-side; the kernel
/// only sees the serialized `snake_case` response.
///
/// # Errors
///
/// Returns an error when the request payload's fields are invalid, the
/// objective or budget fails validation, the request type is unknown, or a
/// goal-state persist fails.
pub fn handle_goal_host_request(
    request_type: &str,
    payload: &Value,
    driver: &mut GoalDriver,
    session: &mut SessionManager,
) -> anyhow::Result<GoalHostResponse> {
    let record = payload.as_object().cloned().unwrap_or_default();
    match request_type {
        // The creation-based timer: the served state reads the goal's age
        // fresh from `created_at` on every read.
        "goal.get" => Ok(goal_host_response(
            &driver.state_with_creation_elapsed(),
            false,
        )),
        "goal.create" => {
            let Some(objective) = record.get("objective").and_then(Value::as_str) else {
                anyhow::bail!("goal.create objective must be a string");
            };
            let token_budget = match record.get("token_budget") {
                None | Some(Value::Null) => None,
                Some(value) => {
                    let budget = value.as_u64().ok_or_else(|| {
                        anyhow::anyhow!("goal.create token_budget must be an integer when provided")
                    })?;
                    Some(budget)
                }
            };
            let goal = create_goal_from_host(driver, session, objective, token_budget)?;
            Ok(goal_host_response(&goal, false))
        }
        "goal.complete" => {
            let goal = complete_goal_from_host(driver, session)?;
            Ok(goal_host_response(&goal, true))
        }
        _ => anyhow::bail!("unknown goal request type \"{request_type}\""),
    }
}

fn create_goal_from_host(
    driver: &mut GoalDriver,
    session: &mut SessionManager,
    objective: &str,
    token_budget: Option<u64>,
) -> anyhow::Result<GoalState> {
    match driver.state().status {
        GoalStatus::Active => anyhow::bail!(
            "cannot create a new goal because this thread already has an active goal; run `await goal.complete()` when it is achieved, or ask the user to clear it with /goal clear"
        ),
        GoalStatus::Paused => anyhow::bail!(
            "cannot create a new goal because a paused goal exists; ask the user to resume it with /goal resume or clear it with /goal clear"
        ),
        GoalStatus::BudgetLimited => anyhow::bail!(
            "cannot create a new goal because a budget-limited goal exists; ask the user to resume it with /goal resume or clear it with /goal clear"
        ),
        // Idle, or a terminal record (complete / error): start fresh.
        GoalStatus::Idle | GoalStatus::Complete | GoalStatus::Error => {
            driver.start(session, objective, token_budget)
        }
    }
}

fn complete_goal_from_host(
    driver: &mut GoalDriver,
    session: &mut SessionManager,
) -> anyhow::Result<GoalState> {
    if driver.state().objective.is_none() || driver.state().status == GoalStatus::Idle {
        anyhow::bail!("cannot complete goal because this thread has no goal");
    }
    driver.complete(session)?;
    Ok(driver.state_with_creation_elapsed())
}

/// One kernel `rlm_heartbeat.*` mutation: the changed job plus the
/// daemon-side post-mutation work it owes (TS daemon-mode runs
/// `removeQueuedHeartbeatFollowUp` and `cronScheduler.wake()` inside its
/// `createRlmHeartbeatForState` / `updateRlmHeartbeatForState` /
/// `deleteRlmHeartbeatForState` controllers).
///
/// `drop_queued` is the TS update condition: instruction/interval/pause/
/// delivery updates withdraw the queued fire, a label-only or resume-only
/// update does not, and every delete does.
#[derive(Debug, Clone)]
pub struct RlmHeartbeatMutation {
    pub job: AgentCronJob,
    pub drop_queued: bool,
}

/// The embedding's seam for kernel rlm heartbeat mutations: invoked by the
/// `rlm_heartbeat.*` host handlers after the store mutation, before the
/// response returns. The daemon worker installs the hook that withdraws
/// the queued fire and re-arms the scheduler.
pub type RlmHeartbeatMutationHook = std::sync::Arc<
    dyn Fn(RlmHeartbeatMutation) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync,
>;

/// One handled `rlm_heartbeat.*` request: the wire response plus the
/// mutation the request made (catalog reads carry none).
#[derive(Debug)]
pub struct RlmHeartbeatHostOutcome {
    pub response: Value,
    pub mutation: Option<RlmHeartbeatMutation>,
}

/// Handle an `rlm_heartbeat.*` host request from the bundled rlm-heartbeat
/// skill. These heartbeats are internal to the active session and never read
/// or mutate the user-level /heartbeat.
///
/// # Errors
///
/// Returns an error when the request payload's fields are invalid, the
/// schedule text cannot be parsed, or the request type is unknown.
pub fn handle_rlm_heartbeat_host_request(
    request_type: &str,
    payload: &Value,
    store: &AgentCronJobStore,
    active_session_id: &str,
    binding: &SessionBinding,
) -> anyhow::Result<RlmHeartbeatHostOutcome> {
    let record = payload.as_object().cloned().unwrap_or_default();
    let string_field = |name: &str| -> anyhow::Result<Option<String>> {
        match record.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_str()
                .map(|text| Some(text.to_string()))
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "rlm_heartbeat.{request_type} {name} must be a string when provided"
                    )
                }),
        }
    };
    let delivery_mode = match record.get("delivery_mode") {
        None | Some(Value::Null) => None,
        Some(value) => match value.as_str() {
            Some("steer") => Some(DeliveryMode::Steer),
            Some("follow_up") => Some(DeliveryMode::FollowUp),
            _ => anyhow::bail!(
                "rlm_heartbeat.{request_type} delivery_mode must be \"steer\" or \"follow_up\" when provided"
            ),
        },
    };
    let now = store_now();
    let mut create_input = CreateAgentCronJobInput {
        active_session_id: active_session_id.to_string(),
        session_id: binding.session_id.clone(),
        session_file: binding.session_file.clone(),
        cwd: binding.cwd.clone(),
        source: Some("rlm_heartbeat".to_string()),
        now: Some(now),
        ..Default::default()
    };
    match request_type {
        "rlm_heartbeat.list" => {
            let include_inactive =
                matches!(record.get("include_inactive"), Some(Value::Bool(true)));
            let heartbeats = store.list_rlm_heartbeats(active_session_id, include_inactive);
            Ok(RlmHeartbeatHostOutcome {
                response: json!({
                    "heartbeats": heartbeats
                        .iter()
                        .map(rlm_heartbeat_host_response)
                        .collect::<Vec<_>>(),
                }),
                // A catalog read mutates nothing: no post-mutation work.
                mutation: None,
            })
        }
        "rlm_heartbeat.create" => {
            let Some(instruction) = record.get("instruction").and_then(Value::as_str) else {
                anyhow::bail!("rlm_heartbeat.create instruction must be a string");
            };
            let interval = string_field("interval")?;
            let label = string_field("label")?;
            create_input.prompt = instruction.to_string();
            create_input.label = label;
            create_input.schedule_text = interval.unwrap_or_else(|| "every 5m".to_string());
            create_input.delivery_mode = delivery_mode;
            let heartbeat = store.create_rlm_heartbeat(&create_input)?;
            let response = json!({ "heartbeat": rlm_heartbeat_host_response(&heartbeat) });
            // TS `createRlmHeartbeatForState` never withdraws a queued
            // fire; it only wakes the scheduler.
            Ok(RlmHeartbeatHostOutcome {
                response,
                mutation: Some(RlmHeartbeatMutation {
                    job: heartbeat,
                    drop_queued: false,
                }),
            })
        }
        "rlm_heartbeat.update" => {
            let Some(id) = record.get("id").and_then(Value::as_str) else {
                anyhow::bail!("rlm_heartbeat.update id must be a string");
            };
            let instruction = string_field("instruction")?;
            let interval = string_field("interval")?;
            let label = string_field("label")?;
            let status = match record.get("status") {
                None | Some(Value::Null) => None,
                Some(Value::String(status)) => match status.as_str() {
                    "pause" => Some(RlmHeartbeatStatusUpdate::Pause),
                    "resume" => Some(RlmHeartbeatStatusUpdate::Resume),
                    _ => anyhow::bail!(
                        "rlm_heartbeat.update status must be \"pause\" or \"resume\" when provided"
                    ),
                },
                _ => anyhow::bail!(
                    "rlm_heartbeat.update status must be \"pause\" or \"resume\" when provided"
                ),
            };
            if instruction.is_none()
                && interval.is_none()
                && label.is_none()
                && status.is_none()
                && delivery_mode.is_none()
            {
                anyhow::bail!("rlm_heartbeat.update requires at least one field to update");
            }
            // TS `updateRlmHeartbeatForState`: instruction/interval/pause/
            // delivery updates withdraw the queued fire; label-only and
            // resume-only updates do not.
            let drop_queued = instruction.is_some()
                || interval.is_some()
                || status == Some(RlmHeartbeatStatusUpdate::Pause)
                || delivery_mode.is_some();
            let heartbeat = store.update_rlm_heartbeat(
                active_session_id,
                id,
                &RlmHeartbeatUpdate {
                    label,
                    prompt: instruction,
                    schedule_text: interval,
                    status,
                    delivery_mode,
                    now: Some(now),
                },
            )?;
            Ok(RlmHeartbeatHostOutcome {
                response: json!({
                    "heartbeat": heartbeat
                        .as_ref()
                        .map_or(Value::Null, rlm_heartbeat_host_response),
                }),
                // TS wakes only when the update found the job.
                mutation: heartbeat.map(|job| RlmHeartbeatMutation { job, drop_queued }),
            })
        }
        "rlm_heartbeat.delete" => {
            let Some(id) = record.get("id").and_then(Value::as_str) else {
                anyhow::bail!("rlm_heartbeat.delete id must be a string");
            };
            let heartbeat = store.delete_rlm_heartbeat(active_session_id, id, now);
            Ok(RlmHeartbeatHostOutcome {
                response: json!({
                    "heartbeat": heartbeat
                        .as_ref()
                        .map_or(Value::Null, rlm_heartbeat_host_response),
                }),
                // TS `deleteRlmHeartbeatForState` always withdraws the
                // queued fire of the deleted job.
                mutation: heartbeat.map(|job| RlmHeartbeatMutation {
                    job,
                    drop_queued: true,
                }),
            })
        }
        _ => anyhow::bail!("unknown RLM heartbeat request type \"{request_type}\""),
    }
}

// ---------------------------------------------------------------------------
// telemetry.emit
// ---------------------------------------------------------------------------

/// The only event names the `telemetry.emit` bridge may carry. A
/// catalogued name alone is not authorization: catalogued events with
/// free-text properties (e.g. `agent error`'s 4096-byte
/// `error_message`) would turn the bridge into an exfiltration channel
/// for any kernel-resident code, so the bridge serves the skill-side
/// adoption vocabulary only and everything else stays host-internal.
const KERNEL_BRIDGE_EVENTS: &[&str] = &["computer_use_session_started", "computer_use_action"];

/// Handle a `telemetry.emit` host request from a Python-backed skill: the
/// best-effort bridge onto the session's telemetry client, restricted to
/// [`KERNEL_BRIDGE_EVENTS`]. A request tracks only when the name is
/// bridge-allowlisted and catalogued, every property key is one of that
/// event's catalogued properties (a caller-supplied base-property key or
/// an unknown key refuses the whole request — the caller must not
/// override the host's platform facts), every value is a JSON primitive,
/// and every required property is present; anything else answers
/// `{"emitted": false}` without tracking anything. The catalog's typed
/// rules still normalize what survives (enum fallbacks, number caps) —
/// and neither bridge event carries a free string, so no content-bearing
/// value can ride. Telemetry never breaks the caller: a refused request
/// is a value, never an error.
pub fn handle_telemetry_emit_host_request(
    payload: &Value,
    client: &TelemetryClient,
    execution_mode: &str,
) -> Value {
    let Some(name) = payload.get("name").and_then(Value::as_str) else {
        return json!({ "emitted": false });
    };
    if !KERNEL_BRIDGE_EVENTS.contains(&name) {
        return json!({ "emitted": false });
    }
    let Some(rule) = lookup(name) else {
        return json!({ "emitted": false });
    };
    let properties = match payload.get("properties") {
        // An absent (or null) properties object validates as an empty
        // one; any other non-object value is malformed.
        None | Some(Value::Null) => None,
        Some(Value::Object(map)) => Some(map),
        Some(_) => return json!({ "emitted": false }),
    };
    let empty = serde_json::Map::new();
    let properties = properties.unwrap_or(&empty);
    for (key, value) in properties {
        if !rule.properties.iter().any(|(known, _)| known == key) {
            return json!({ "emitted": false });
        }
        if !matches!(
            value,
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
        ) {
            return json!({ "emitted": false });
        }
    }
    for (key, property_rule) in rule.properties {
        if property_rule.required && !properties.contains_key(*key) {
            return json!({ "emitted": false });
        }
    }
    let mut tracked = base_properties(execution_mode);
    for (key, value) in properties {
        tracked.set(key, value.clone());
    }
    client.track(name, tracked);
    json!({ "emitted": true })
}

/// The session identity fields heartbeat creation needs.
pub struct SessionBinding {
    pub session_id: String,
    pub session_file: String,
    pub cwd: String,
}

fn store_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cron::store::AgentCronJobStore;
    use crate::session::manager::SessionManager;
    use pa_telemetry::{MockSink, TelemetryClientConfig, TelemetrySink};

    fn persisted_session() -> SessionManager {
        let dir = tempfile::TempDir::new().unwrap();
        let session_dir = dir.path().join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut session = SessionManager::in_memory(dir.path());
        session.materialize_session_file(Some(session_dir));
        session
    }

    fn binding() -> SessionBinding {
        SessionBinding {
            session_id: "session-1".to_string(),
            session_file: "/w/session.jsonl".to_string(),
            cwd: "/w".to_string(),
        }
    }

    fn heartbeat_store() -> AgentCronJobStore {
        let dir = tempfile::TempDir::new().unwrap();
        AgentCronJobStore::new(dir.path().join("jobs.json"))
    }

    #[test]
    fn goal_host_requests() {
        let mut session = persisted_session();
        let mut driver = GoalDriver::new();
        // goal.get with no goal.
        let response =
            handle_goal_host_request("goal.get", &json!({}), &mut driver, &mut session).unwrap();
        assert!(response.goal.is_none());
        // goal.create.
        let response = handle_goal_host_request(
            "goal.create",
            &json!({ "objective": "ship it", "token_budget": 5000 }),
            &mut driver,
            &mut session,
        )
        .unwrap();
        let goal = response.goal.unwrap();
        assert_eq!(goal.objective, "ship it");
        assert_eq!(goal.token_budget, Some(5000));
        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(response.remaining_tokens, Some(5000));
        // Creating while active is rejected with the exact TS error.
        let error = handle_goal_host_request(
            "goal.create",
            &json!({ "objective": "another" }),
            &mut driver,
            &mut session,
        )
        .unwrap_err();
        assert!(error.to_string().contains("already has an active goal"));
        // Validation errors from the kernel payload.
        let error = handle_goal_host_request("goal.create", &json!({}), &mut driver, &mut session)
            .unwrap_err();
        assert_eq!(error.to_string(), "goal.create objective must be a string");
        let error = handle_goal_host_request(
            "goal.create",
            &json!({ "objective": "x", "token_budget": "lots" }),
            &mut driver,
            &mut session,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("token_budget must be an integer"));
        // goal.complete carries the completion budget report.
        let response =
            handle_goal_host_request("goal.complete", &json!({}), &mut driver, &mut session)
                .unwrap();
        assert_eq!(response.goal.unwrap().status, GoalStatus::Complete);
        assert!(response
            .completion_budget_report
            .as_deref()
            .unwrap()
            .starts_with("Goal achieved."));
        // Completing with no goal errors.
        let mut bare = GoalDriver::new();
        let mut other_session = persisted_session();
        let error =
            handle_goal_host_request("goal.complete", &json!({}), &mut bare, &mut other_session)
                .unwrap_err();
        assert_eq!(
            error.to_string(),
            "cannot complete goal because this thread has no goal"
        );
        // Unknown types.
        let error = handle_goal_host_request("goal.nope", &json!({}), &mut driver, &mut session)
            .unwrap_err();
        assert!(error.to_string().contains("unknown goal request type"));
    }

    #[test]
    fn rlm_heartbeat_host_requests() {
        let store = heartbeat_store();
        let bind = binding();
        // Create.
        let created = handle_rlm_heartbeat_host_request(
            "rlm_heartbeat.create",
            &json!({ "instruction": "watch pods", "interval": "every 10m", "label": "podwatch" }),
            &store,
            "live-1",
            &bind,
        )
        .unwrap();
        let heartbeat = created.response.get("heartbeat").cloned().unwrap();
        assert_eq!(heartbeat["status"], "active");
        assert_eq!(heartbeat["instruction"], "watch pods");
        assert_eq!(heartbeat["label"], "podwatch");
        assert_eq!(heartbeat["delivery_mode"], "steer");
        assert!(heartbeat["schedule"]["kind"].is_string());
        // Create carries the mutation (TS `createRlmHeartbeatForState`
        // wakes; it never withdraws a queued fire).
        let mutation = created.mutation.expect("create mutation");
        assert_eq!(mutation.job.id, heartbeat["id"].as_str().unwrap());
        assert_eq!(mutation.job.source.as_deref(), Some("rlm_heartbeat"));
        assert_eq!(mutation.job.active_session_id, "live-1");
        assert!(!mutation.drop_queued);
        let id = heartbeat["id"].as_str().unwrap().to_string();
        // List.
        let listed = handle_rlm_heartbeat_host_request(
            "rlm_heartbeat.list",
            &json!({ "include_inactive": true }),
            &store,
            "live-1",
            &bind,
        )
        .unwrap();
        assert_eq!(listed.response["heartbeats"].as_array().unwrap().len(), 1);
        assert!(listed.mutation.is_none(), "a catalog read mutates nothing");
        // Update with pause.
        let paused = handle_rlm_heartbeat_host_request(
            "rlm_heartbeat.update",
            &json!({ "id": id, "status": "pause" }),
            &store,
            "live-1",
            &bind,
        )
        .unwrap();
        assert_eq!(paused.response["heartbeat"]["status"], "paused");
        // A pause withdraws the queued fire (TS `updateRlmHeartbeatForState`).
        let mutation = paused.mutation.expect("pause mutation");
        assert!(mutation.drop_queued);
        // Update requires a field.
        let error = handle_rlm_heartbeat_host_request(
            "rlm_heartbeat.update",
            &json!({ "id": id }),
            &store,
            "live-1",
            &bind,
        )
        .unwrap_err();
        assert!(error.to_string().contains("at least one field"));
        // Resume does not withdraw the queued fire (TS: resume-only keeps it).
        let resumed = handle_rlm_heartbeat_host_request(
            "rlm_heartbeat.update",
            &json!({ "id": id, "status": "resume" }),
            &store,
            "live-1",
            &bind,
        )
        .unwrap();
        assert_eq!(resumed.response["heartbeat"]["status"], "active");
        assert!(!resumed.mutation.expect("resume mutation").drop_queued);
        // Delete.
        let deleted = handle_rlm_heartbeat_host_request(
            "rlm_heartbeat.delete",
            &json!({ "id": id }),
            &store,
            "live-1",
            &bind,
        )
        .unwrap();
        assert_eq!(deleted.response["heartbeat"]["status"], "cancelled");
        assert!(deleted.mutation.expect("delete mutation").drop_queued);
        // Deleting again re-cancels (the TS delete does not check status).
        let again = handle_rlm_heartbeat_host_request(
            "rlm_heartbeat.delete",
            &json!({ "id": id }),
            &store,
            "live-1",
            &bind,
        )
        .unwrap();
        assert_eq!(again.response["heartbeat"]["status"], "cancelled");
        // Unknown type.
        let error = handle_rlm_heartbeat_host_request(
            "rlm_heartbeat.nope",
            &json!({}),
            &store,
            "live-1",
            &bind,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("unknown RLM heartbeat request type"));
    }

    fn telemetry_client(mock: &std::sync::Arc<MockSink>) -> TelemetryClient {
        let mut config = TelemetryClientConfig::new("install-1");
        // Flush per event so assertions see every tracked event without
        // an explicit flush round-trip.
        config.batch_size = 1;
        config.flush_interval = std::time::Duration::from_mins(10);
        config.sinks = vec![mock.clone() as std::sync::Arc<dyn TelemetrySink>];
        TelemetryClient::spawn(config).expect("spawn client")
    }

    /// A catalogued event rides the client with its properties and the
    /// platform base under them.
    #[tokio::test]
    async fn telemetry_emit_tracks_catalogued_events() {
        let mock = std::sync::Arc::new(MockSink::new());
        let client = telemetry_client(&mock);
        let response = handle_telemetry_emit_host_request(
            &json!({
                "type": "telemetry.emit",
                "name": "computer_use_action",
                "properties": {
                    "action": "click",
                    "outcome": "error",
                    "error_code": "APP_NOT_ALLOWED",
                    "duration_ms": 120
                }
            }),
            &client,
            "interactive",
        );
        assert_eq!(response, json!({ "emitted": true }));
        client.flush().await.unwrap();
        let events = mock.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].name, "computer_use_action");
        assert_eq!(events[0].properties.get("action"), Some(&json!("click")));
        assert_eq!(events[0].properties.get("outcome"), Some(&json!("error")));
        assert_eq!(
            events[0].properties.get("error_code"),
            Some(&json!("APP_NOT_ALLOWED"))
        );
        assert_eq!(
            events[0].properties.get("duration_ms"),
            Some(&json!(120u64))
        );
        assert_eq!(
            events[0].properties.get("execution_mode"),
            Some(&json!("interactive"))
        );
    }

    /// An uncatalogued name drops silently: no event, `emitted: false`.
    #[tokio::test]
    async fn telemetry_emit_drops_uncatalogued_names() {
        let mock = std::sync::Arc::new(MockSink::new());
        let client = telemetry_client(&mock);
        for name in ["not an event", "computer use action", ""] {
            let response = handle_telemetry_emit_host_request(
                &json!({ "name": name, "properties": { "action": "click" } }),
                &client,
                "interactive",
            );
            assert_eq!(response, json!({ "emitted": false }), "name {name}");
        }
        client.flush().await.unwrap();
        assert!(mock.events().is_empty());
    }

    /// A catalogued name outside the bridge's event vocabulary refuses the
    /// request — `agent error` (a 4096-byte free-string `error_message`)
    /// must not become an exfiltration channel for kernel-resident code.
    #[tokio::test]
    async fn telemetry_emit_refuses_events_outside_the_bridge_allowlist() {
        let mock = std::sync::Arc::new(MockSink::new());
        let client = telemetry_client(&mock);
        for name in ["agent error", "tool executed"] {
            let response = handle_telemetry_emit_host_request(
                &json!({
                    "name": name,
                    "properties": {
                        "error_message": "private screen text streamed to the sink"
                    }
                }),
                &client,
                "interactive",
            );
            assert_eq!(response, json!({ "emitted": false }), "name {name}");
        }
        client.flush().await.unwrap();
        assert!(mock.events().is_empty(), "nothing tracked");
    }

    /// Caller-supplied keys outside the event's catalogued property set
    /// refuse the whole request: base-property keys (the host's platform
    /// facts are not caller-overridable) and unknown keys never reach a
    /// sink.
    #[tokio::test]
    async fn telemetry_emit_refuses_base_property_and_unknown_keys() {
        let mock = std::sync::Arc::new(MockSink::new());
        let client = telemetry_client(&mock);
        for key in ["execution_mode", "os_release", "screen_text"] {
            let mut properties = json!({
                "action": "click",
                "outcome": "ok",
                "duration_ms": 5
            });
            properties[key] = json!("spoofed value");
            let response = handle_telemetry_emit_host_request(
                &json!({ "name": "computer_use_action", "properties": properties }),
                &client,
                "interactive",
            );
            assert_eq!(response, json!({ "emitted": false }), "key {key}");
        }
        client.flush().await.unwrap();
        assert!(mock.events().is_empty(), "nothing tracked");
    }

    /// A structured property value or a missing required property refuses
    /// the whole request — nothing partial ever tracks.
    #[tokio::test]
    async fn telemetry_emit_refuses_structured_values_and_missing_required() {
        let mock = std::sync::Arc::new(MockSink::new());
        let client = telemetry_client(&mock);
        let structured = json!({
            "name": "computer_use_action",
            "properties": {
                "action": { "ax": "private screen text" },
                "outcome": "ok",
                "duration_ms": 5
            }
        });
        let response = handle_telemetry_emit_host_request(&structured, &client, "interactive");
        assert_eq!(response, json!({ "emitted": false }));
        let missing_required = json!({
            "name": "computer_use_action",
            "properties": { "action": "click", "outcome": "ok" }
        });
        let response =
            handle_telemetry_emit_host_request(&missing_required, &client, "interactive");
        assert_eq!(response, json!({ "emitted": false }));
        client.flush().await.unwrap();
        assert!(mock.events().is_empty(), "nothing tracked");
    }

    /// The real Python payload shapes ride the bridge: the ok shape keeps
    /// a null error code, and an out-of-vocabulary error code falls back
    /// to the fixed `unknown` literal at the catalog's typed boundary —
    /// a free string never rides the event.
    #[tokio::test]
    async fn telemetry_emit_falls_back_on_out_of_vocabulary_error_codes() {
        let mock = std::sync::Arc::new(MockSink::new());
        let client = telemetry_client(&mock);
        let ok_shape = json!({
            "name": "computer_use_action",
            "properties": {
                "action": "click",
                "outcome": "ok",
                "error_code": null,
                "duration_ms": 12
            }
        });
        let response = handle_telemetry_emit_host_request(&ok_shape, &client, "interactive");
        assert_eq!(response, json!({ "emitted": true }));
        let error_shape = json!({
            "name": "computer_use_action",
            "properties": {
                "action": "type_text",
                "outcome": "error",
                "error_code": "EXFIL_ATTEMPT",
                "duration_ms": 12
            }
        });
        let response = handle_telemetry_emit_host_request(&error_shape, &client, "interactive");
        assert_eq!(response, json!({ "emitted": true }));
        client.flush().await.unwrap();
        let events = mock.events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].properties.get("outcome"), Some(&json!("ok")));
        assert_eq!(events[0].properties.get("error_code"), Some(&json!(null)));
        assert_eq!(events[1].properties.get("outcome"), Some(&json!("error")));
        assert_eq!(
            events[1].properties.get("error_code"),
            Some(&json!("unknown")),
            "out-of-vocabulary code fell back to the fixed literal"
        );
    }

    /// The bridge never errors: malformed payloads answer `emitted: false` —
    /// including an absent (or null) properties object, which validates as
    /// empty and therefore misses every required property.
    #[tokio::test]
    async fn telemetry_emit_never_errors_on_malformed_payloads() {
        let mock = std::sync::Arc::new(MockSink::new());
        let client = telemetry_client(&mock);
        let malformed = [
            json!({}),                                                      // no name
            json!({ "name": 7 }),                                           // name not a string
            json!({ "name": "computer_use_action", "properties": "nope" }), // not an object
            json!(["not", "an", "object"]),                                 // payload not an object
        ];
        for payload in &malformed {
            let response = handle_telemetry_emit_host_request(payload, &client, "interactive");
            assert_eq!(response, json!({ "emitted": false }));
        }
        // An absent or null properties object validates as an empty one,
        // and an empty property set is missing every required property:
        // the request refuses, still without erroring.
        for properties in [None, Some(Value::Null)] {
            let mut payload = json!({ "name": "computer_use_session_started" });
            if let Some(properties) = properties {
                payload["properties"] = properties;
            }
            let response = handle_telemetry_emit_host_request(&payload, &client, "interactive");
            assert_eq!(response, json!({ "emitted": false }));
        }
        client.flush().await.unwrap();
        assert!(mock.events().is_empty(), "nothing tracked");
    }
}
