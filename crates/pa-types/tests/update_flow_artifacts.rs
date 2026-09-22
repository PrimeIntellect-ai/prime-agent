//! Round-trip and cross-check tests for the update-flow artifact schemas
//! (`docs/update-flow-state-machine.md` §7, §8): the golden roster example in
//! the spec's own shape, the intent/status/marker artifacts, and the
//! watchdog/transition tables as cross-referenced from the spec.

use std::path::Path;

use pa_types::daemon::update_flow::{
    prepared_marker_expiry, socket_update_dir, update_intent_path, update_marker_path,
    update_prepared_dir, update_roster_path, update_status_path, update_transition_allowed,
    PreparedMarkerExpiry, UpdateHeartbeatDeliveryMode, UpdateHeartbeatStatus, UpdateId,
    UpdateIntent, UpdatePreparedMarker, UpdateProcessIdentity, UpdateRoster, UpdateRosterBinary,
    UpdateRosterHeartbeat, UpdateRosterSessionKind, UpdateRosterSubagentStatus, UpdateState,
    UpdateStatus, UpdateSupervisorIdentity, UpdateTimeoutBudget, UPDATE_ROSTER_FORMAT_VERSION,
    UPDATE_STATUS_FORMAT_VERSION,
};

/// Lossless round-trip contract (crate-wide): parse, serialize, re-parse, and
/// require equality with the original JSON value.
fn rt<T: serde::de::DeserializeOwned + serde::Serialize>(json: &str) {
    let original: serde_json::Value = serde_json::from_str(json).unwrap();
    let parsed: T = serde_json::from_str(json).expect("deserialize");
    let out = serde_json::to_string(&parsed).expect("serialize");
    let reparsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(original, reparsed, "round trip changed the value: {out}");
}

/// The spec §8 example roster, verbatim in field names and values (the JSONC
/// comments removed, and `parent_session_id: null` written absent, which is
/// the same value in the schema). This is the golden artifact corpus entry:
/// any schema change must keep this file round-tripping.
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
fn spec_roster_example_roundtrips_losslessly() {
    rt::<UpdateRoster>(SPEC_ROSTER);
    let roster: UpdateRoster = serde_json::from_str(SPEC_ROSTER).unwrap();
    assert_eq!(roster.format_version, UPDATE_ROSTER_FORMAT_VERSION);
    assert_eq!(roster.sessions.len(), 1);
    assert_eq!(roster.sessions[0].kind, UpdateRosterSessionKind::TopLevel);
    assert!(roster.sessions[0].queue.next_turn[0]
        .custom_type
        .contains("queued"));
    assert_eq!(
        roster.subagents[0].status,
        UpdateRosterSubagentStatus::Completed
    );
    assert_eq!(roster.heartbeats[0].status, UpdateHeartbeatStatus::Active);
    assert_eq!(
        roster.heartbeats[0].delivery_mode,
        UpdateHeartbeatDeliveryMode::Steer
    );
}

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
}

#[test]
fn prepared_artifact_paths_lay_out_under_the_socket_dir() {
    let agent_dir = Path::new("/ad");
    let socket_dir = socket_update_dir(agent_dir, "cafebabe");
    let id = UpdateId::from(String::from("018f"));
    let prepared = update_prepared_dir(&socket_dir, &id);
    assert_eq!(
        update_intent_path(&socket_dir),
        Path::new("/ad/update-restarts/cafebabe/intent.json")
    );
    assert_eq!(
        update_status_path(&socket_dir),
        Path::new("/ad/update-restarts/cafebabe/status.json")
    );
    assert_eq!(
        update_roster_path(&prepared),
        Path::new("/ad/update-restarts/cafebabe/prepared/018f/roster.json")
    );
    assert_eq!(
        update_marker_path(&prepared),
        Path::new("/ad/update-restarts/cafebabe/prepared/018f/marker.json")
    );
}

/// The watchdog table (spec §9) and the transition table (spec §4) must stay
/// mutually consistent: every watchdog outcome names a transition that the
/// coordinator table allows from the state it guards.
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

/// The `Prepared` self-expiry verdict (spec §5, §7) and the default expiry
/// window (spec §9) must line up: the marker timestamp the supervisor writes
/// with the budgeted window expires exactly when the watchdog says so.
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
        rest: Default::default(),
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

/// The status file keeps the TS schema shape (spec §7: "TS status-file
/// schema"): the version constant and the counts field names match the TS
/// writer's, so a differential test can compare artifacts directly.
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
            rest: Default::default(),
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

#[test]
fn roster_binary_and_heartbeat_wire_names() {
    let binary: UpdateRosterBinary = serde_json::from_value(serde_json::json!({
        "from_version": "0.9.5", "to_version": "0.9.6"
    }))
    .unwrap();
    assert_eq!(binary.from_version, "0.9.5");
    let heartbeat: UpdateRosterHeartbeat = serde_json::from_value(serde_json::json!({
        "job_id": "j", "session_id": "s", "schedule": "every 5m",
        "delivery_mode": "follow_up", "status": "paused", "next_run_at": "t"
    }))
    .unwrap();
    assert_eq!(
        heartbeat.delivery_mode,
        UpdateHeartbeatDeliveryMode::FollowUp
    );
}
