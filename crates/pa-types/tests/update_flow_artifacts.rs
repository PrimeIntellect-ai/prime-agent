//! Round-trip and cross-check tests for the update-flow artifact schemas: the golden roster
//! example,
//! the intent/status/marker artifacts, and the watchdog/transition tables.

use pa_types::daemon::update_flow::{
    prepared_marker_expiry, update_transition_allowed, PreparedMarkerExpiry, UpdateId,
    UpdateIntent, UpdatePreparedMarker, UpdateProcessIdentity, UpdateRoster, UpdateState,
    UpdateStatus, UpdateSupervisorIdentity, UpdateTimeoutBudget, UPDATE_STATUS_FORMAT_VERSION,
};
use pa_types::JsonMap;

/// Lossless round-trip contract (crate-wide): parse, serialize, re-parse,
/// require equality with the original JSON value.
fn rt<T: serde::de::DeserializeOwned + serde::Serialize>(json: &str) {
    let original: serde_json::Value = serde_json::from_str(json).unwrap();
    let parsed: T = serde_json::from_str(json).expect("deserialize");
    let out = serde_json::to_string(&parsed).expect("serialize");
    let reparsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(original, reparsed, "round trip changed the value: {out}");
}

/// The spec §8 example roster, verbatim (JSONC comments removed, `parent_session_id: null` written
/// absent - the same value in the schema). Any schema change must keep it round-tripping.
const SPEC_ROSTER: &str = r#"{
    "format_version": 1,
    "update_id": "018f-uuidv7",
    "socket_path": "/tmp/prime-agent-1000/daemon.sock",
    "created_at": "2026-10-01T12:00:00Z",
    "supervisor": {"pid": 4242, "process_start_id": "4242/170000", "generation": "gen-7"},
    "binary": {"from_version": "0.9.5", "to_version": "0.9.6"},
    "sessions": [
        {
            "session_id": "01a0b4f6-0000-7000-8000-000000000001",
            "active_session_id": "a-1",
            "session_file": "~/.prime/agent/sessions/01a0b4f6-0000-7000-8000-000000000001.jsonl",
            "name": "worker-1",
            "kind": "top-level",
            "rlm_depth": 1,
            "cwd": "/home/ubuntu/prime-agent-rs",
            "runtime_config": {"model": "glm-5.3"},
            "queue": {
                "next_turn": [
                    {"customType": "queued.note", "content": "finish the build", "display": true, "timestamp": 1790856000000}
                ],
                "actions": {"kind": "session-action-recovery"}
            },
            "in_flight": {
                "streaming": false, "compacting": false, "bash_running": true,
                "rlm_children": false, "retrying": false, "prompt_in_flight": false
            },
            "should_resume": true
        }
    ],
    "workers": [
        {
            "worker_id": "w-1",
            "worker_instance_id": "w-1-abc",
            "sessions": ["01a0b4f6-0000-7000-8000-000000000001"],
            "launch_env": {"PRIME_AGENT_SESSION_DIR": "/tmp/sess"}
        }
    ],
    "subagents": [
        {
            "child_id": "c-1",
            "session_id": "01a0b4f6-0000-7000-8000-000000000002",
            "parent_session_id": "01a0b4f6-0000-7000-8000-000000000001",
            "name": "api-reviewer",
            "status": "completed",
            "depth": 2,
            "session_file": "~/.prime/agent/sessions/01a0b4f6-0000-7000-8000-000000000002.jsonl",
            "display_file": "~/.prime/agent/session-artifacts/01a0b4f6-0000-7000-8000-000000000002/rlm-subagent.json"
        }
    ],
    "heartbeats": [
        {
            "job_id": "j-1",
            "session_id": "01a0b4f6-0000-7000-8000-000000000001",
            "label": "watch the build",
            "schedule": "every 5m",
            "delivery_mode": "steer",
            "status": "active",
            "next_run_at": "2026-10-01T12:05:00Z"
        }
    ]
}"#;

#[test]
fn full_artifact_set_roundtrips() {
    rt::<UpdateIntent>(
        r#"{"update_id":"018f","pid":100,"process_start_id":"100/22","heartbeat_at":"2026-10-01T12:00:00.000Z"}"#,
    );
    rt::<UpdateStatus>(
        r#"{"version":1,"updateId":"018f","socketPath":"/s","state":"rollback","epoch":2,"coordinator":{"pid":3},"predecessor":{"pid":4},"successor":{"pid":5},"counts":{"total":1,"restored":1,"resumed":0,"failed":0},"message":"rolling back","startedAt":"a","updatedAt":"b","heartbeatAt":"c"}"#,
    );
    rt::<UpdatePreparedMarker>(
        r#"{"update_id":"018f","expires_at":"2026-10-01T12:00:45.000Z","supervisor":{"pid":4242,"process_start_id":"4242/170000","generation":"gen-7"}}"#,
    );
    // Unknown fields survive and absent collections stay absent.
    rt::<UpdateIntent>(r#"{"update_id":"u","pid":9,"heartbeat_at":"t","note":"kept"}"#);
    rt::<UpdateStatus>(
        r#"{"version":1,"updateId":"u2","socketPath":"/s","state":"complete","epoch":7,"predecessor":{"pid":1},"successor":{"pid":2,"supervisorGeneration":"g"},"counts":{"total":3,"restored":2,"resumed":1,"failed":1},"failures":[{"sessionFile":"/sessions/a.jsonl","message":"worker refused"}],"message":"updated","startedAt":"a","updatedAt":"b","unknownField":true}"#,
    );
    rt::<UpdatePreparedMarker>(
        r#"{"update_id":"u","expires_at":"t","supervisor":{"pid":1,"generation":"g"},"note":"kept"}"#,
    );
    rt::<UpdateRoster>(SPEC_ROSTER);
    rt::<UpdateRoster>(
        r#"{"format_version":1,"update_id":"u","socket_path":"/s","created_at":"t","supervisor":{"pid":1,"generation":"g"},"binary":{"from_version":"a","to_version":"b"}}"#,
    );
}

/// Every watchdog outcome (spec §9) must name a transition the coordinator
/// table (spec §4) allows from the state it guards.
#[test]
fn watchdog_outcomes_are_legal_transitions() {
    let legal = [
        (UpdateState::Downloading, UpdateState::Aborted), // download/validate failed
        (UpdateState::Staged, UpdateState::Aborted),      // prepare RPC timeout
        (UpdateState::Preparing, UpdateState::Aborted),   // T_prepare exceeded
        (UpdateState::Prepared, UpdateState::Aborted),    // marker expired
        (UpdateState::Stopping, UpdateState::Aborted),    // worker stop budget exceeded
        (UpdateState::Stopped, UpdateState::Rollback),    // predecessor never exited
        (UpdateState::Activating, UpdateState::Rollback), // swap/probe budget
        (UpdateState::Booting, UpdateState::Rollback),    // T_boot exceeded
        (UpdateState::Rollback, UpdateState::Failed),     // rollback boot failed
        (UpdateState::Restoring, UpdateState::Complete),  // restore pass finished
    ];
    for (from, to) in legal {
        assert!(
            update_transition_allowed(from, to),
            "watchdog transition {from:?} -> {to:?} is not in the transition table"
        );
    }
}

/// The marker timestamp written with the budgeted window must expire
/// exactly when the watchdog says so (spec §5, §7, §9).
#[test]
fn prepared_expiry_window_and_marker_verdict_agree() {
    let budget = UpdateTimeoutBudget::default();
    // A marker written at 12:00:00 with the default 45 s window.
    let marker = UpdatePreparedMarker {
        update_id: UpdateId::from(String::from("018f")),
        expires_at: String::from("2026-10-01T12:00:45.000Z"),
        supervisor: UpdateSupervisorIdentity {
            pid: 1,
            process_start_id: Some(String::from("1/2")),
            generation: String::from("g"),
        },
        rest: JsonMap::default(),
    };
    assert_eq!(
        prepared_marker_expiry(&marker.expires_at, "2026-10-01T12:00:44.999Z"),
        PreparedMarkerExpiry::Active
    );
    assert_eq!(
        prepared_marker_expiry(&marker.expires_at, "2026-10-01T12:00:45.000Z"),
        PreparedMarkerExpiry::Expired
    );
    // The default window really is 45 s (spec §9).
    assert_eq!(budget.prepared_expiry_ms, 45_000);
}

/// The status file keeps the TS schema shape: the version constant and the counts field names match
/// the TS writer's, so differential tests compare artifacts directly.
#[test]
fn status_schema_is_ts_shaped() {
    assert_eq!(UPDATE_STATUS_FORMAT_VERSION, 1);
    let status: UpdateStatus = serde_json::from_value(serde_json::json!({
        "version": 1,
        "updateId": "u",
        "socketPath": "/s",
        "state": "complete",
        "epoch": 1,
        "coordinator": {"pid": 1, "processStartId": "1/9"},
        "counts": {"total": 0, "restored": 0, "resumed": 0, "failed": 0},
        "startedAt": "a",
        "updatedAt": "b",
    }))
    .unwrap();
    assert_eq!(
        status.coordinator,
        Some(UpdateProcessIdentity {
            pid: 1,
            process_start_id: Some(String::from("1/9")),
            supervisor_generation: None,
            supervisor_owner_token: None,
            rest: JsonMap::default(),
        })
    );
    assert_eq!(status.socket_path, "/s");
    assert_eq!(status.state, UpdateState::Complete);
    let encoded = serde_json::to_value(&status).unwrap();
    // camelCase, TS-shaped.
    assert!(encoded.get("socketPath").is_some());
    assert!(encoded.get("updatedAt").is_some());
    assert!(encoded.get("epoch").is_some());
    assert!(encoded.get("state").is_some());
}
