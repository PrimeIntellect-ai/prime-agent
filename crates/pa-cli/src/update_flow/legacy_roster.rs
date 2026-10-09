//! Translate the released TypeScript restart checkpoint into the Rust restore roster.
//! The create command deliberately mirrors the TS restore call: configuration,
//! client environment, and runtime metadata belong to the resumed session.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{ensure, Context, Result};
use pa_types::daemon::{
    UpdateId, UpdateRoster, UpdateRosterBinary, UpdateRosterInFlight, UpdateRosterQueue,
    UpdateRosterSession, UpdateRosterSessionKind, UpdateSupervisorIdentity,
    UPDATE_ROSTER_FORMAT_VERSION,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyManifest {
    format_version: u64,
    created_at: String,
    sessions: Vec<LegacySession>,
    #[serde(flatten)]
    rest: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyQueue {
    next_turn: Vec<pa_types::session::CustomMessage>,
    actions: Value,
}

#[allow(clippy::struct_excessive_bools)] // The released TS wire format has independent activity flags.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySession {
    active_session_id: String,
    session_id: String,
    session_file: String,
    cwd: String,
    config: Map<String, Value>,
    runtime_metadata: Option<Map<String, Value>>,
    client_env: Option<BTreeMap<String, String>>,
    queue: LegacyQueue,
    should_resume: bool,
    #[serde(default)]
    was_streaming: bool,
    #[serde(default)]
    was_compacting: bool,
    #[serde(default)]
    was_bash_running: bool,
    #[serde(default)]
    had_running_rlm_children: bool,
    #[serde(default)]
    was_retrying: bool,
    #[serde(default)]
    had_accepted_prompt_in_flight: bool,
}

// Keep the wire-to-roster field mapping together so omissions are reviewable.
#[allow(clippy::too_many_lines)]
pub(super) fn convert(
    manifest: &Value,
    hello: &Value,
    update_id: &UpdateId,
    socket_path: &Path,
    origin: Option<&str>,
) -> Result<UpdateRoster> {
    let manifest: LegacyManifest =
        serde_json::from_value(manifest.clone()).context("parse TypeScript update checkpoint")?;
    ensure!(
        manifest.format_version == 1,
        "unsupported TypeScript update checkpoint version"
    );
    let active_ids: BTreeMap<_, _> = manifest
        .sessions
        .iter()
        .map(|session| {
            (
                session.active_session_id.clone(),
                session.session_id.clone(),
            )
        })
        .collect();
    let files: BTreeMap<_, _> = manifest
        .sessions
        .iter()
        .map(|session| (session.session_file.clone(), session.session_id.clone()))
        .collect();
    let mut session_ids = BTreeSet::new();
    let mut sessions = Vec::with_capacity(manifest.sessions.len());
    for session in manifest.sessions {
        ensure!(
            !session.session_id.is_empty()
                && !session.active_session_id.is_empty()
                && !session.session_file.is_empty(),
            "TypeScript checkpoint contains an empty session identity"
        );
        ensure!(
            session_ids.insert(session.session_id.clone()),
            "TypeScript checkpoint contains duplicate session ids"
        );
        let runtime = session.runtime_metadata.as_ref();
        let kind = match runtime
            .and_then(|metadata| metadata.get("kind"))
            .and_then(Value::as_str)
        {
            Some("subagent") => UpdateRosterSessionKind::Subagent,
            Some("top-level") | None => UpdateRosterSessionKind::TopLevel,
            Some(kind) => anyhow::bail!("unsupported TypeScript session kind: {kind}"),
        };
        let parent_session_id = runtime.and_then(|metadata| {
            metadata
                .get("parentSessionId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    metadata
                        .get("parentActiveSessionId")
                        .and_then(Value::as_str)
                        .and_then(|id| active_ids.get(id))
                        .cloned()
                })
                .or_else(|| {
                    metadata
                        .get("parentSessionFile")
                        .and_then(Value::as_str)
                        .and_then(|file| files.get(file))
                        .cloned()
                })
        });
        let mut create = json!({"sessionPath": session.session_file, "cwd": session.cwd, "config": session.config});
        if let Some(metadata) = session.runtime_metadata {
            create["runtimeMetadata"] = Value::Object(metadata);
        }
        if let Some(env) = session.client_env {
            create["env"] = serde_json::to_value(env)?;
        }
        sessions.push(UpdateRosterSession {
            session_id: session.session_id,
            active_session_id: session.active_session_id,
            session_file: session.session_file,
            name: None,
            kind,
            parent_session_id,
            rlm_depth: 0,
            cwd: session.cwd,
            runtime_config: json!({"create": create}),
            queue: UpdateRosterQueue {
                next_turn: session.queue.next_turn,
                actions: session.queue.actions,
            },
            in_flight: UpdateRosterInFlight {
                streaming: session.was_streaming,
                compacting: session.was_compacting,
                bash_running: session.was_bash_running,
                rlm_children: session.had_running_rlm_children,
                retrying: session.was_retrying,
                prompt_in_flight: session.had_accepted_prompt_in_flight,
            },
            should_resume: session.should_resume,
            rest: Map::new(),
        });
    }
    ensure!(
        active_ids.len() == sessions.len(),
        "TypeScript checkpoint contains duplicate active session ids"
    );
    let parents: BTreeMap<_, _> = sessions
        .iter()
        .map(|session| {
            (
                session.session_id.clone(),
                session.parent_session_id.clone(),
            )
        })
        .collect();
    for session in &mut sessions {
        let mut visited = BTreeSet::from([session.session_id.clone()]);
        let mut parent = session.parent_session_id.as_ref();
        while let Some(id) = parent {
            ensure!(
                visited.insert(id.clone()),
                "TypeScript checkpoint contains cyclic session parents"
            );
            session.rlm_depth += 1;
            parent = parents.get(id).and_then(Option::as_ref);
        }
    }
    let mut rest = manifest.rest;
    rest.insert("legacy_ts_restart".into(), Value::Bool(true));
    if let Some(origin) = origin {
        rest.insert("restart_origin_active_session_id".into(), json!(origin));
    }
    Ok(UpdateRoster {
        format_version: UPDATE_ROSTER_FORMAT_VERSION,
        update_id: update_id.clone(),
        socket_path: socket_path.to_string_lossy().into_owned(),
        created_at: manifest.created_at,
        supervisor: UpdateSupervisorIdentity {
            pid: hello
                .get("supervisorPid")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            process_start_id: hello
                .get("supervisorProcessStartId")
                .and_then(Value::as_str)
                .map(str::to_string),
            generation: hello
                .get("supervisorGeneration")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        },
        binary: UpdateRosterBinary {
            from_version: hello
                .get("appVersion")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            to_version: crate::config::version().to_string(),
        },
        sessions,
        workers: Vec::new(),
        subagents: Vec::new(),
        heartbeats: Vec::new(),
        rest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, metadata: &Value) -> Value {
        json!({
            "activeSessionId": format!("active-{id}"), "sessionId": id,
            "sessionFile": format!("/sessions/{id}.jsonl"), "cwd": "/project",
            "config": {"modelId": "model", "thinkingLevel": "high"},
            "runtimeMetadata": metadata, "clientEnv": {"TEST_VAR": "preserved"},
            "queue": {"nextTurn": [{"customType": "note", "content": "pending", "display": false, "timestamp": 1}],
                "actions": {"formatVersion": 1, "actions": [{"payload": {"kind": "turn", "message": "queued"}}]}},
            "shouldResume": true, "wasStreaming": false, "wasCompacting": true,
            "wasBashRunning": true, "hadRunningRlmChildren": true,
            "wasRetrying": true, "hadAcceptedPromptInFlight": true
        })
    }

    #[test]
    fn conversion_preserves_restore_inputs_and_parent_topology() {
        let metadata = json!({"kind": "subagent", "parentActiveSessionId": "active-parent", "rlmChildId": "child-1", "createdAt": 1});
        let child = session("child", &metadata);
        let parent = session("parent", &json!({"kind": "top-level", "createdAt": 1}));
        let manifest = json!({"formatVersion": 1, "createdAt": "now", "sessions": [child, parent], "discardedActiveSessionIds": ["gone"]});
        let actual = convert(
            &manifest,
            &json!({"appVersion": "0.9.8", "supervisorPid": 42, "supervisorGeneration": "old"}),
            &UpdateId("migration".into()),
            Path::new("/daemon.sock"),
            Some("active-parent"),
        )
        .unwrap();
        let expected: UpdateRosterSession = serde_json::from_value(json!({
            "session_id": "child", "active_session_id": "active-child", "session_file": "/sessions/child.jsonl",
            "kind": "subagent", "parent_session_id": "parent", "rlm_depth": 1, "cwd": "/project",
            "runtime_config": {"create": {"sessionPath": "/sessions/child.jsonl", "cwd": "/project",
                "config": {"modelId": "model", "thinkingLevel": "high"}, "runtimeMetadata": metadata,
                "env": {"TEST_VAR": "preserved"}}},
            "queue": {"next_turn": manifest["sessions"][0]["queue"]["nextTurn"], "actions": manifest["sessions"][0]["queue"]["actions"]},
            "in_flight": {"streaming": false, "compacting": true, "bash_running": true, "rlm_children": true, "retrying": true, "prompt_in_flight": true},
            "should_resume": true
        })).unwrap();
        assert_eq!(actual.sessions[0], expected);
        assert_eq!(actual.rest, serde_json::from_value::<Map<String, Value>>(json!({"legacy_ts_restart": true, "restart_origin_active_session_id": "active-parent", "discardedActiveSessionIds": ["gone"]})).unwrap());
    }

    #[test]
    fn earlier_checkpoints_without_newer_activity_flags_remain_restorable() {
        let mut legacy = session("idle", &Value::Null);
        let value = legacy.as_object_mut().unwrap();
        for flag in [
            "wasStreaming",
            "wasCompacting",
            "wasBashRunning",
            "hadRunningRlmChildren",
            "wasRetrying",
            "hadAcceptedPromptInFlight",
        ] {
            value.remove(flag);
        }
        value.insert("shouldResume".into(), Value::Bool(false));
        let manifest = json!({"formatVersion": 1, "createdAt": "now", "sessions": [legacy]});
        let actual = convert(
            &manifest,
            &json!({}),
            &UpdateId("u".into()),
            Path::new("/s"),
            None,
        )
        .unwrap();
        assert_eq!(
            (
                actual.sessions[0].in_flight,
                actual.sessions[0].should_resume
            ),
            (UpdateRosterInFlight::default(), false)
        );
    }

    #[test]
    fn conversion_rejects_cycles_instead_of_hanging_during_restore_ordering() {
        let manifest = json!({"formatVersion": 1, "createdAt": "now", "sessions": [session("parent", &json!({"kind": "subagent", "parentSessionId": "parent"}))]});
        assert!(convert(
            &manifest,
            &json!({}),
            &UpdateId("u".into()),
            Path::new("/s"),
            None
        )
        .unwrap_err()
        .to_string()
        .contains("cyclic"));
    }
}
