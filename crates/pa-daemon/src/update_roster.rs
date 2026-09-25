//! The update roster assembly (spec §8 of
//! `docs/update-flow-state-machine.md`): the durable snapshot of sessions,
//! workers, subagents, and heartbeats written at `Snapshotted`, fsynced
//! before the `Prepared` ack.
//!
//! The roster is a *projection*: the durable truth stays where it lives
//! (`sessions/*.jsonl`, the workers' recovery journals,
//! `session-artifacts/<id>/scheduled-jobs.json`, the RLM ledger and its
//! per-child display files). Nothing here writes, moves, or archives any of
//! those - in particular heartbeat rows are read out of
//! `scheduled-jobs.json` only, and deliberately carry just the re-arm fields
//! (`status`, `next_run_at`): no archive flag exists anywhere in the update
//! flow.
//!
//! Session rows mix three sources: the worker's live `update_snapshot`
//! reply (queue, in-flight flags, durable session id), the supervisor's
//! worker descriptor (active id, name, create payload, respawn env), and
//! the ledger (the `rlm_children` flag). Where the Rust engine cannot see
//! the TS-era granularity (streaming vs bash vs retry all live inside a
//! busy turn), the row reports the honest superset - documented on the
//! row, not guessed per flag.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use pa_core::cron::store::read_scheduled_jobs_artifact;
use pa_types::daemon::{
    UpdateHeartbeatDeliveryMode, UpdateHeartbeatStatus, UpdateId, UpdateRoster, UpdateRosterBinary,
    UpdateRosterHeartbeat, UpdateRosterInFlight, UpdateRosterQueue, UpdateRosterSession,
    UpdateRosterSessionKind, UpdateRosterSubagent, UpdateRosterSubagentStatus, UpdateRosterWorker,
    UpdateSupervisorIdentity, UPDATE_ROSTER_FORMAT_VERSION,
};
use serde_json::{json, Value};

use crate::lease::canonical_session_path;
use crate::rlm_ledger::{read_rlm_subagent_display, RlmSpawnLedger};
use crate::util::iso_from_unix_ms;

/// One resident worker's collected data for the roster: its durable
/// descriptor plus the live `update_snapshot` reply.
#[derive(Debug, Clone)]
pub(crate) struct WorkerSnapshot {
    pub(crate) worker_id: String,
    pub(crate) descriptor: pa_types::daemon::DaemonWorkerDescriptor,
    pub(crate) snapshot: Value,
}

/// The supervisor identity recorded into the roster and the prepared
/// marker (pid + start id + generation, the TS `getProcessStartId`
/// contract).
pub(crate) fn supervisor_identity(generation: String) -> UpdateSupervisorIdentity {
    let pid = std::process::id();
    UpdateSupervisorIdentity {
        pid: pid as u64,
        process_start_id: crate::protocol::process_start_id(pid),
        generation,
    }
}

fn value_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// One roster session row, assembled from the worker's snapshot and the
/// descriptor.
fn session_row(
    snapshot: &WorkerSnapshot,
    child_parents: &HashSet<PathBuf>,
) -> Result<UpdateRosterSession> {
    let data = &snapshot.snapshot;
    let descriptor = &snapshot.descriptor;
    let session_id = value_str(data, "sessionId")
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .or_else(|| {
            descriptor
                .session_file
                .as_deref()
                .map(file_stem)
                .filter(|stem| !stem.is_empty())
        })
        .with_context(|| format!("worker {} snapshot has no session id", snapshot.worker_id))?;
    let runtime = data.get("runtimeMetadata").cloned().unwrap_or(Value::Null);
    let queue = data.get("queue").cloned().unwrap_or(Value::Null);
    let busy = data.get("busy").and_then(Value::as_bool).unwrap_or(false);
    let compacting = data
        .get("compacting")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let lanes_pending = ["steering", "followUps"].into_iter().any(|lane| {
        queue
            .get(lane)
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
    });
    let kind = match value_str(&runtime, "kind") {
        Some("subagent") => UpdateRosterSessionKind::Subagent,
        _ => UpdateRosterSessionKind::TopLevel,
    };
    let session_file = value_str(data, "sessionFile")
        .map(str::to_string)
        .or_else(|| descriptor.session_file.clone())
        .unwrap_or_default();
    let has_running_children =
        child_parents.contains(&canonical_session_path(Path::new(&session_file)));
    Ok(UpdateRosterSession {
        session_id,
        active_session_id: descriptor.root_active_session_id.clone(),
        session_file,
        name: descriptor
            .create_command
            .rest
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        kind,
        parent_session_id: value_str(&runtime, "parentSessionId").map(str::to_string),
        rlm_depth: runtime.get("rlmDepth").and_then(Value::as_u64).unwrap_or(0) as u32,
        cwd: value_str(data, "cwd").unwrap_or_default().to_string(),
        runtime_config: json!({
            "create": serde_json::to_value(&descriptor.create_command)?,
        }),
        // The Rust engine has no separate next-turn custom-message lane:
        // pending prompts ride the steering/follow-up lanes (persisted to
        // the worker recovery journal and restored on respawn), so
        // `next_turn` is empty and `actions` carries the lane snapshot.
        queue: UpdateRosterQueue {
            next_turn: Vec::new(),
            actions: queue,
        },
        in_flight: UpdateRosterInFlight {
            streaming: busy,
            compacting,
            // Tool work, retries, and provider streaming all live inside a
            // busy turn on this build; `streaming` is the continuation
            // signal.
            bash_running: false,
            rlm_children: has_running_children,
            retrying: false,
            prompt_in_flight: false,
        },
        should_resume: busy || compacting || lanes_pending,
        rest: Map::default(),
    })
}

/// One roster worker row: the durable session ids it hosts plus the exact
/// env the supervisor respawns it with.
fn worker_row(
    agent_dir: &Path,
    supervisor_socket: &str,
    snapshot: &WorkerSnapshot,
    session_ids: &[String],
) -> UpdateRosterWorker {
    UpdateRosterWorker {
        worker_id: snapshot.worker_id.clone(),
        worker_instance_id: snapshot.descriptor.worker_instance_id.clone(),
        sessions: session_ids.to_vec(),
        launch_env: crate::descriptor::worker_launch_env(
            agent_dir,
            supervisor_socket,
            // The respawn instance id is per-spawn (uuid at relaunch time);
            // the roster row pins the current one as the snapshot.
            snapshot
                .descriptor
                .worker_instance_id
                .as_deref()
                .unwrap_or_default(),
            &snapshot.descriptor,
        ),
        rest: Map::default(),
    }
}

/// Subagent rows (spec §8): the ledger's live edges are the topology; the
/// per-child display file carries the durable status. A child whose display
/// is absent reports `running` when its session is resident, `completed`
/// otherwise (the TS passive-hydration split).
fn subagent_rows(
    agent_dir: &Path,
    ledger: &RlmSpawnLedger,
    resident_files: &HashSet<PathBuf>,
) -> Result<Vec<UpdateRosterSubagent>> {
    let edges = ledger
        .live_edges()
        .with_context(|| "read the RLM spawn ledger for the update roster")?;
    let mut rows = Vec::new();
    for edge in edges {
        let parent_stem = file_stem(&edge.parent);
        let child_dir = agent_dir
            .join("session-artifacts")
            .join(&parent_stem)
            .join(&edge.child_id);
        let display = read_rlm_subagent_display(&child_dir);
        let status = match display.as_ref().map(|entry| entry.status.as_str()) {
            Some("completed") => UpdateRosterSubagentStatus::Completed,
            Some("running") => UpdateRosterSubagentStatus::Running,
            _ => {
                if resident_files.contains(&canonical_session_path(Path::new(&edge.child))) {
                    UpdateRosterSubagentStatus::Running
                } else {
                    UpdateRosterSubagentStatus::Completed
                }
            }
        };
        let session_file = display
            .as_ref()
            .map(|entry| entry.session_file.clone())
            .filter(|file| !file.is_empty())
            .unwrap_or_else(|| edge.child.clone());
        rows.push(UpdateRosterSubagent {
            child_id: edge.child_id.clone(),
            session_id: file_stem(&session_file),
            parent_session_id: parent_stem,
            name: edge.name.clone(),
            status,
            depth: edge.depth,
            session_file,
            display_file: child_dir
                .join("rlm-subagent.json")
                .to_string_lossy()
                .to_string(),
            rest: Map::default(),
        });
    }
    Ok(rows)
}

/// Heartbeat rows (spec §8): a read-only projection of every
/// `scheduled-jobs.json` under the session-artifacts tree (per-session
/// partitions and per-child RLM partitions, two levels). Only `active`
/// and `paused` jobs project - completed/cancelled jobs are not re-armed -
/// and the update flow never writes, moves, or archives the files.
fn heartbeat_rows(agent_dir: &Path) -> Vec<UpdateRosterHeartbeat> {
    let mut rows = Vec::new();
    for job in scan_scheduled_jobs(agent_dir) {
        let status = match job.status {
            pa_core::cron::JobStatus::Active => UpdateHeartbeatStatus::Active,
            pa_core::cron::JobStatus::Paused => UpdateHeartbeatStatus::Paused,
            pa_core::cron::JobStatus::Completed | pa_core::cron::JobStatus::Cancelled => continue,
        };
        let schedule = schedule_text(&job);
        rows.push(UpdateRosterHeartbeat {
            job_id: job.id,
            session_id: job.session_id,
            label: job.label,
            schedule,
            delivery_mode: match job.delivery_mode {
                Some(pa_core::cron::DeliveryMode::FollowUp) => {
                    UpdateHeartbeatDeliveryMode::FollowUp
                }
                Some(pa_core::cron::DeliveryMode::Steer) | None => {
                    UpdateHeartbeatDeliveryMode::Steer
                }
            },
            status,
            next_run_at: job.next_run_at,
            rest: Map::default(),
        });
    }
    rows
}

/// Every scheduled job in the agent's session artifacts (spec §6 step 3's
/// scan; spec §8: `scheduled-jobs.json` is the only write path and is never
/// written, moved, or archived by the update flow). Shared by the roster
/// projection (heartbeat rows) and the boot re-arm pass.
pub(crate) fn scan_scheduled_jobs(agent_dir: &Path) -> Vec<pa_core::cron::AgentCronJob> {
    let artifacts_root = agent_dir.join("session-artifacts");
    let Ok(entries) = std::fs::read_dir(&artifacts_root) else {
        return Vec::new();
    };
    let mut jobs = Vec::new();
    for partition in entries.flatten() {
        for path in scheduled_job_files(&partition.path()) {
            jobs.extend(read_scheduled_jobs_artifact(&path));
        }
    }
    jobs
}

/// The `scheduled-jobs.json` files one level under an artifacts partition
/// root entry (per-session and per-child partitions).
fn scheduled_job_files(partition: &Path) -> Vec<PathBuf> {
    let mut paths = vec![partition.join("scheduled-jobs.json")];
    if let Ok(children) = std::fs::read_dir(partition) {
        for child in children.flatten() {
            paths.push(child.path().join("scheduled-jobs.json"));
        }
    }
    paths.into_iter().filter(|path| path.is_file()).collect()
}

/// The schedule's display text (a UX projection; the durable schedule
/// object stays in `scheduled-jobs.json`).
fn schedule_text(job: &pa_core::cron::AgentCronJob) -> String {
    match job.schedule.kind {
        pa_core::cron::ScheduleKind::Cron | pa_core::cron::ScheduleKind::Once => {
            if job.schedule.expression.is_empty() {
                "once".to_string()
            } else {
                job.schedule.expression.clone()
            }
        }
        pa_core::cron::ScheduleKind::Interval => {
            let millis = job.schedule.interval_ms.unwrap_or(0);
            if millis >= 60_000 && millis.is_multiple_of(60_000) {
                format!("every {}m", millis / 60_000)
            } else if millis >= 1000 && millis.is_multiple_of(1000) {
                format!("every {}s", millis / 1000)
            } else {
                format!("every {millis}ms")
            }
        }
    }
}

/// The static inputs of one roster assembly: everything the supervisor
/// knows before the worker snapshots arrive.
pub(crate) struct UpdateRosterInputs<'a> {
    pub(crate) update_id: &'a UpdateId,
    pub(crate) socket_path: &'a str,
    pub(crate) agent_dir: &'a Path,
    pub(crate) supervisor: UpdateSupervisorIdentity,
    pub(crate) from_version: &'a str,
    pub(crate) to_version: &'a str,
    pub(crate) created_at_ms: u64,
    pub(crate) ledger: &'a RlmSpawnLedger,
}

/// Assemble the full update roster (spec §8) from the collected worker
/// snapshots, the RLM ledger, and the scheduled-jobs scan.
pub(crate) fn build_update_roster(
    inputs: UpdateRosterInputs<'_>,
    workers: Vec<WorkerSnapshot>,
) -> Result<UpdateRoster> {
    let UpdateRosterInputs {
        update_id,
        socket_path,
        agent_dir,
        supervisor,
        from_version,
        to_version,
        created_at_ms,
        ledger,
    } = inputs;
    // Live edges group by parent session file: one row's `rlm_children`.
    let child_parents: HashSet<PathBuf> = ledger
        .live_edges()?
        .into_iter()
        .map(|edge| canonical_session_path(Path::new(&edge.parent)))
        .collect();
    let resident_files: HashSet<PathBuf> = workers
        .iter()
        .filter_map(|worker| {
            worker
                .descriptor
                .session_file
                .as_deref()
                .map(|file| canonical_session_path(Path::new(file)))
        })
        .collect();
    let mut sessions = Vec::new();
    let mut rows = Vec::new();
    for snapshot in &workers {
        let row = session_row(snapshot, &child_parents)?;
        rows.push(worker_row(
            agent_dir,
            socket_path,
            snapshot,
            std::slice::from_ref(&row.session_id),
        ));
        sessions.push(row);
    }
    Ok(UpdateRoster {
        format_version: UPDATE_ROSTER_FORMAT_VERSION,
        update_id: update_id.clone(),
        socket_path: socket_path.to_string(),
        created_at: iso_from_unix_ms(created_at_ms),
        supervisor,
        binary: UpdateRosterBinary {
            from_version: from_version.to_string(),
            to_version: to_version.to_string(),
        },
        sessions,
        workers: rows,
        subagents: subagent_rows(agent_dir, ledger, &resident_files)?,
        heartbeats: heartbeat_rows(agent_dir),
        rest: Map::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rlm_ledger::RlmSpawnInput;

    fn sessions_file(sessions_dir: &Path, session_id: &str) -> String {
        sessions_dir
            .join(format!("{session_id}.jsonl"))
            .to_string_lossy()
            .to_string()
    }

    fn snapshot_value(
        sessions_dir: &Path,
        session_id: &str,
        kind: &str,
        parent: Option<&str>,
        depth: u32,
    ) -> Value {
        json!({
            "activeSessionId": format!("active-{session_id}"),
            "sessionId": session_id,
            "sessionFile": sessions_file(sessions_dir, session_id),
            "cwd": "/w",
            "generation": "g",
            "runtimeMetadata": {
                "kind": kind,
                "rlmChildId": if kind == "subagent" { Some(format!("child-{session_id}")) } else { None },
                "parentSessionId": parent,
                "rlmDepth": depth,
            },
            "queue": {
                "actions": {"queuedCount": 1, "steering": ["finish the build"], "followUps": []},
                "steering": ["finish the build"],
                "followUps": [],
            },
            "busy": true,
            "compacting": false,
        })
    }

    fn descriptor(
        sessions_dir: &Path,
        session_id: &str,
        name: Option<&str>,
        kind: &str,
    ) -> pa_types::daemon::DaemonWorkerDescriptor {
        let mut rest = serde_json::Map::new();
        rest.insert("cwd".into(), json!("/w"));
        if let Some(name) = name {
            rest.insert("name".into(), json!(name));
        }
        if kind == "subagent" {
            rest.insert("rlmChildId".into(), json!(format!("child-{session_id}")));
        }
        pa_types::daemon::DaemonWorkerDescriptor {
            version: 2,
            worker_id: format!("active-{session_id}"),
            pid: 1,
            process_start_id: None,
            socket_path: format!("/tmp/{session_id}.sock"),
            recovery_journal_path: format!("/tmp/{session_id}.journal"),
            orphan_process_journal_path: None,
            supervisor_socket_path: "/tmp/sup.sock".into(),
            authentication_token: "t".into(),
            worker_instance_id: Some(format!("inst-{session_id}")),
            root_active_session_id: format!("active-{session_id}"),
            owner_client_id: None,
            root_session_id: Some(session_id.into()),
            session_file: Some(sessions_file(sessions_dir, session_id)),
            session_dir: None,
            telemetry_disabled: None,
            created_at: String::new(),
            updated_at: String::new(),
            lifecycle: pa_types::daemon::DaemonWorkerLifecycle::Ready,
            create_command: pa_types::daemon::DurableDaemonCreateCommand {
                session_path: None,
                no_session: None,
                rest,
            },
            consecutive_failures: 0,
            stop_requested_at: None,
            archive_on_stop: None,
            last_failure_at: None,
            last_error: None,
            rest: Map::default(),
        }
    }

    fn worker_snapshot(
        sessions_dir: &Path,
        session_id: &str,
        kind: &str,
        parent: Option<&str>,
        depth: u32,
        name: Option<&str>,
    ) -> WorkerSnapshot {
        WorkerSnapshot {
            worker_id: format!("active-{session_id}"),
            descriptor: descriptor(sessions_dir, session_id, name, kind),
            snapshot: snapshot_value(sessions_dir, session_id, kind, parent, depth),
        }
    }

    fn setup(agent_dir: &Path) -> (RlmSpawnLedger, PathBuf) {
        let sessions_dir = agent_dir.join("sessions");
        std::fs::create_dir_all(&sessions_dir).unwrap();
        // `live_edges` keeps only edges whose parent and child session files
        // exist on disk, so the fixtures are real files in the tempdir.
        for session_id in ["p1", "c1"] {
            std::fs::write(sessions_dir.join(format!("{session_id}.jsonl")), "").unwrap();
        }
        let ledger = RlmSpawnLedger::new(agent_dir, &sessions_dir, |_| {});
        ledger
            .append_spawn(RlmSpawnInput {
                parent: sessions_file(&sessions_dir, "p1"),
                child: sessions_file(&sessions_dir, "c1"),
                child_id: "child-c1".into(),
                depth: 1,
                name: "api-reviewer".into(),
            })
            .unwrap();
        (ledger, sessions_dir)
    }

    fn write_scheduled_jobs(agent_dir: &Path, session_id: &str, jobs: Value) {
        let dir = agent_dir.join("session-artifacts").join(session_id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("scheduled-jobs.json"), jobs.to_string()).unwrap();
    }

    fn identity() -> UpdateSupervisorIdentity {
        UpdateSupervisorIdentity {
            pid: 42,
            process_start_id: Some("42/7".into()),
            generation: "sup:42".into(),
        }
    }

    #[test]
    fn roster_assembles_all_four_sections() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path();
        let (ledger, sessions_dir) = setup(agent_dir);
        // A display entry pins the child's status.
        let child_display = agent_dir
            .join("session-artifacts")
            .join("p1")
            .join("child-c1");
        std::fs::create_dir_all(&child_display).unwrap();
        std::fs::write(
            child_display.join("rlm-subagent.json"),
            json!({
                "type": "rlm_subagent", "childId": "child-c1", "sessionName": "api-reviewer",
                "sessionDir": child_display.to_string_lossy(), "sessionFile": "/tmp/sessions/c1.jsonl",
                "status": "completed", "createdAt": 1
            })
            .to_string(),
        )
        .unwrap();
        write_scheduled_jobs(
            agent_dir,
            "p1",
            json!({"jobs": [
                {"id": "j1", "status": "active", "sessionId": "p1", "activeSessionId": "active-p1",
                 "sessionFile": "/tmp/sessions/p1.jsonl", "cwd": "/w", "prompt": "check",
                 "label": "watch", "deliveryMode": "follow_up",
                 "schedule": {"kind": "interval", "expression": "", "intervalMs": 300_000},
                 "createdAt": "t", "updatedAt": "t", "nextRunAt": "2026-10-01T12:05:00.000Z"},
                {"id": "j2", "status": "cancelled", "sessionId": "p1", "activeSessionId": "active-p1",
                 "sessionFile": "/tmp/sessions/p1.jsonl", "cwd": "/w", "prompt": "x",
                 "schedule": {"kind": "interval", "expression": "", "intervalMs": 60000},
                 "createdAt": "t", "updatedAt": "t"}
            ]}),
        );
        let workers = vec![
            worker_snapshot(&sessions_dir, "p1", "top-level", None, 0, Some("main")),
            worker_snapshot(&sessions_dir, "c1", "subagent", Some("p1"), 1, None),
        ];
        let update_id = UpdateId::from("u1".to_string());
        let roster = build_update_roster(
            UpdateRosterInputs {
                update_id: &update_id,
                socket_path: "/tmp/sup.sock",
                agent_dir,
                supervisor: identity(),
                from_version: "0.1.0",
                to_version: "0.2.0",
                created_at_ms: 1_000,
                ledger: &ledger,
            },
            workers,
        )
        .unwrap();

        // Sessions: durable ids, kinds, parents, in-flight from the worker.
        assert_eq!(roster.sessions.len(), 2);
        let root = &roster.sessions[0];
        assert_eq!(root.session_id, "p1");
        assert_eq!(root.active_session_id, "active-p1");
        assert_eq!(root.kind, UpdateRosterSessionKind::TopLevel);
        assert_eq!(root.name.as_deref(), Some("main"));
        assert!(root.in_flight.streaming);
        assert!(
            root.in_flight.rlm_children,
            "the ledger child flags the parent"
        );
        assert!(root.should_resume);
        assert!(root.queue.actions.get("steering").is_some());
        // The Rust engine has no next-turn lane: pending prompts live in
        // the lane snapshot, not next_turn.
        assert!(root.queue.next_turn.is_empty());
        let child = &roster.sessions[1];
        assert_eq!(child.kind, UpdateRosterSessionKind::Subagent);
        assert_eq!(child.parent_session_id.as_deref(), Some("p1"));

        // Workers: one row per resident, with the respawn env.
        assert_eq!(roster.workers.len(), 2);
        assert_eq!(roster.workers[0].sessions, ["p1"]);
        assert_eq!(
            roster.workers[0]
                .launch_env
                .get("PRIME_AGENT_INTERNAL_DAEMON_WORKER"),
            Some(&"1".to_string())
        );
        assert_eq!(
            roster.workers[0]
                .launch_env
                .get("PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID"),
            Some(&"active-p1".to_string())
        );

        // Subagents: the ledger edge + the display status.
        assert_eq!(roster.subagents.len(), 1);
        let sub = &roster.subagents[0];
        assert_eq!(sub.child_id, "child-c1");
        assert_eq!(sub.session_id, "c1");
        assert_eq!(sub.parent_session_id, "p1");
        assert_eq!(sub.name, "api-reviewer");
        assert_eq!(sub.status, UpdateRosterSubagentStatus::Completed);
        assert_eq!(sub.depth, 1);
        assert!(sub.display_file.ends_with("rlm-subagent.json"));

        // Heartbeats: the projection carries re-arm fields only; cancelled
        // jobs never project.
        assert_eq!(roster.heartbeats.len(), 1);
        let beat = &roster.heartbeats[0];
        assert_eq!(beat.job_id, "j1");
        assert_eq!(beat.session_id, "p1");
        assert_eq!(beat.status, UpdateHeartbeatStatus::Active);
        assert_eq!(beat.delivery_mode, UpdateHeartbeatDeliveryMode::FollowUp);
        assert_eq!(beat.schedule, "every 5m");
        assert_eq!(
            beat.next_run_at.as_deref(),
            Some("2026-10-01T12:05:00.000Z")
        );
        // The projection has no archive flag, by type.
        let encoded = serde_json::to_value(beat).unwrap();
        assert!(!encoded.as_object().unwrap().contains_key("archived"));
    }

    #[test]
    fn missing_session_id_fails_the_row() {
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path();
        let (ledger, sessions_dir) = setup(agent_dir);
        let mut snapshot = worker_snapshot(&sessions_dir, "p1", "top-level", None, 0, None);
        snapshot
            .snapshot
            .as_object_mut()
            .unwrap()
            .remove("sessionId");
        snapshot.descriptor.session_file = None;
        let error = build_update_roster(
            UpdateRosterInputs {
                update_id: &UpdateId::from("u1".to_string()),
                socket_path: "/tmp/sup.sock",
                agent_dir,
                supervisor: identity(),
                from_version: "a",
                to_version: "b",
                created_at_ms: 1,
                ledger: &ledger,
            },
            vec![snapshot],
        )
        .unwrap_err();
        assert!(error.to_string().contains("no session id"));
    }
}
