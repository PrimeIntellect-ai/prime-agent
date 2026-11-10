//! Worker tests.
use super::*;

/// A created worker over the scripted engine.
async fn created_dispatch_worker() -> std::sync::Arc<Worker> {
    let dir = std::env::temp_dir().join(format!("pa-worker-susp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: std::path::PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "suspension-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": ["ack"] })),
    };
    let worker = std::sync::Arc::new(Worker::new(config, None));
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "suspension" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    worker
}

/// The session events seen by an attached client since `mark`, in
/// wire order.
fn session_events_since(
    subscription: &mut tokio::sync::broadcast::Receiver<Arc<OutboundFrame>>,
) -> Vec<Value> {
    let mut events = Vec::new();
    while let Ok(frame) = subscription.try_recv() {
        if frame.outbound_type == "session_event" {
            if let Ok(outbound) = serde_json::from_slice::<Value>(&frame.payload) {
                events.push(outbound["event"].clone());
            }
        }
    }
    events
}

/// A fake supervisor link endpoint (unix): greets the link handshake,
/// answers every request line with success, and records the full command
/// values in arrival order. The callers read the field they need (roster
/// deltas read `command["summary"]`, message probes filter the type).
#[cfg(unix)]
pub(crate) fn fake_supervisor(
    socket: &std::path::Path,
) -> (
    std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let listener = tokio::net::UnixListener::bind(socket).unwrap();
    let recorded = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let sink = std::sync::Arc::clone(&recorded);
    let server = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let sink = std::sync::Arc::clone(&sink);
            tokio::spawn(async move {
                let (reader, mut writer) = stream.into_split();
                writer
                    .write_all(
                        b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7}}\n",
                    )
                    .await
                    .unwrap();
                let mut lines = BufReader::new(reader);
                loop {
                    let mut line = String::new();
                    if lines.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    if line.trim().is_empty() {
                        continue;
                    }
                    let Ok(request) = serde_json::from_str::<Value>(line.trim()) else {
                        continue;
                    };
                    let command = request["command"].clone();
                    sink.lock().unwrap().push(command.clone());
                    let response =
                        crate::protocol::response_line(&crate::protocol::response_success(
                            request["id"].as_str(),
                            command["type"].as_str().unwrap_or_default(),
                            None,
                        ));
                    writer
                        .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                        .await
                        .unwrap();
                    writer.write_all(b"\n").await.unwrap();
                }
            });
        }
    });
    (recorded, server)
}

/// The daemon route of the billed-row report: the worker store tells the
/// observed sink about each billed row it appends (a `model_usage` call and a
/// compaction), once each, and nothing about a plain message.
#[tokio::test]
async fn the_worker_store_reports_each_billed_row_once() {
    use pa_core::session_engine::rlm_usage::RlmChildUsageStore;
    let dir = tempfile::tempdir().unwrap();
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&session_dir).unwrap();
    let worker = Worker::new(
        WorkerConfig {
            socket_path: dir.path().join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "billed-session".to_string(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery.jsonl"),
            telemetry_disabled: Some(true),
            script: Some(json!({ "responses": [] })),
        },
        None,
    );
    let created = worker
        .dispatch(
            "create",
            &json!({ "cwd": dir.path(), "sessionDir": session_dir, "name": "billed" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    let store = CoreUsageStore(Arc::clone(&worker.core));
    let session_id = {
        let core = worker.core.lock().unwrap();
        core.store.as_ref().unwrap().session_id().to_string()
    };
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink_seen = Arc::clone(&seen);
    store
        .observe_billed_rows(Arc::new(
            move |row: &pa_core::session::billed_row::BilledRow| {
                sink_seen.lock().unwrap().push(row.usage.total_tokens);
            },
        ))
        .await;
    let usage = |tokens: u64| pa_types::ai::Usage {
        input: tokens,
        total_tokens: tokens,
        ..Default::default()
    };
    store
        .append_model_usage(
            session_id,
            pa_core::session_engine::model_usage::ModelUsage::new(
                "side_question",
                "p",
                "m",
                usage(30),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    {
        let mut core = worker.core.lock().unwrap();
        let file = core.store.as_mut().unwrap();
        file.persist_entry(
            "message",
            json!({ "message": { "role": "user", "content": "hi", "timestamp": 0 } }),
        )
        .unwrap();
        file.persist_entry(
            "compaction",
            json!({ "summary": "s", "firstKeptEntryId": "x", "tokensBefore": 1, "usage": usage(50) }),
        )
        .unwrap();
    }
    assert_eq!(*seen.lock().unwrap(), vec![30, 50]);
}

mod abort_boundary_tests;
mod connection_state_tests;
mod goal_tests;
mod kill_broadcast_tests;
mod last_answer_tests;
mod navigation_pause_tests;
mod queue_tests;
mod sidecar_exit_tests;
mod summary_tests;
mod warning_marker_tests;
mod windowed_attach_tests;
mod withdraw_tests;
#[tokio::test]
async fn background_refinement_event_is_fenced_to_its_review_session() {
    let dir = std::env::temp_dir().join(format!("pa-refine-event-{}", uuid::Uuid::new_v4()));
    let worker = Worker::new(
        WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "refinement-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": [] })),
        },
        None,
    );
    let mut subscription = worker.events.subscribe();
    let original = SessionFile::create("/tmp", None, 0);
    let original_id = original.session_id().to_string();
    worker.core.lock().unwrap().store = Some(original);
    assert!(emit_refinement_event_for_session(
        &worker.core,
        &worker.events,
        &original_id,
        json!({ "type": "refine_complete" }),
    ));
    assert_eq!(session_events_since(&mut subscription).len(), 1);

    worker.core.lock().unwrap().store = Some(SessionFile::create("/tmp", None, 0));
    assert!(!emit_refinement_event_for_session(
        &worker.core,
        &worker.events,
        &original_id,
        json!({ "type": "refine_complete" }),
    ));
    assert!(!emit_refinement_event_for_session(
        &worker.core,
        &worker.events,
        &original_id,
        json!({ "type": "refine_failed", "error": "old session" }),
    ));
    assert!(session_events_since(&mut subscription).is_empty());
}

/// A bill made in one session never lands in the session the worker moved
/// to: once `core.store` holds the replacement, the store refuses it.
#[tokio::test]
async fn a_bill_made_before_a_session_replace_never_lands_in_the_replacement() {
    use pa_core::session_engine::rlm_usage::RlmChildUsageStore as _;
    let dir = std::env::temp_dir().join(format!("pa-bill-fence-{}", uuid::Uuid::new_v4()));
    let worker = Worker::new(
        WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "bill-session".to_string(),
            agent_dir: dir.join("agent"),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": [] })),
        },
        None,
    );
    let bill = || {
        pa_core::session_engine::model_usage::ModelUsage::new(
            "compaction_discarded",
            "p",
            "m",
            pa_types::ai::Usage {
                input: 5,
                total_tokens: 5,
                ..Default::default()
            },
        )
        .unwrap()
    };
    let billed_rows = |worker: &Worker| {
        let core = worker.core.lock().unwrap();
        core.store
            .as_ref()
            .unwrap()
            .entries()
            .iter()
            .filter(|entry| entry.type_ == "custom")
            .count()
    };
    let session_at = |name: &str| {
        let mut file = SessionFile::create("/tmp", None, 0);
        file.set_path(dir.join(name));
        file
    };
    let store = CoreUsageStore(Arc::clone(&worker.core));
    let original = session_at("original.jsonl");
    let original_id = original.session_id().to_string();
    worker.core.lock().unwrap().store = Some(original);
    store
        .append_model_usage(original_id.clone(), bill())
        .await
        .unwrap();
    assert_eq!(billed_rows(&worker), 1);

    worker.core.lock().unwrap().store = Some(session_at("replacement.jsonl"));
    assert!(store.append_model_usage(original_id, bill()).await.is_err());
    assert_eq!(billed_rows(&worker), 0);
}

/// The launch table's bound is insertion-ordered FIFO: past
/// [`MAX_KERNEL_BASH_CREATORS`] the OLDEST launch's binding leaves —
/// never the smallest pid (a small pid is not an old launch; a
/// pid-ordered eviction would keep dead bindings while dropping a
/// long-running background job's stamp), and a re-launch of a live pid
/// re-binds it at the table's back (the upsert), so the completion
/// notice of a relaunched handle finds its creator.
#[tokio::test]
async fn the_launch_table_evicts_its_oldest_binding_not_the_smallest_pid() {
    let worker = created_dispatch_worker().await;
    let mut core = worker.core.lock().unwrap();
    core.kernel_bash_creators.clear();
    // The oldest launch carries the LARGEST pid (a long-running job):
    // 256 bindings reach the table's bound exactly.
    record_kernel_bash_creator(&mut core, 9000, "oldest-long-job".into());
    for pid in 1..MAX_KERNEL_BASH_CREATORS as u32 {
        record_kernel_bash_creator(&mut core, pid, format!("launch-{pid}"));
    }
    assert_eq!(
        core.kernel_bash_creators.len(),
        MAX_KERNEL_BASH_CREATORS,
        "the table holds its bound"
    );
    // One more launch: the OLDEST binding (the largest pid) leaves.
    record_kernel_bash_creator(&mut core, 5000, "newest".into());
    let pids: Vec<u32> = core
        .kernel_bash_creators
        .iter()
        .map(|binding| binding.0)
        .collect();
    assert_eq!(core.kernel_bash_creators.len(), MAX_KERNEL_BASH_CREATORS);
    assert_eq!(pids.first(), Some(&1), "the second-oldest is now the front");
    assert!(
        !pids.contains(&9000),
        "the oldest launch's binding leaves, whatever its pid: {pids:?}"
    );
    assert_eq!(pids.last(), Some(&5000), "the newest launch stays bound");
    // A re-launch of a bound pid re-binds it at the back under its new
    // creator, evicting nothing past the bound.
    record_kernel_bash_creator(&mut core, 3, "relaunch-3".into());
    let bindings: Vec<(u32, String)> = core
        .kernel_bash_creators
        .iter()
        .map(|binding| (binding.0, binding.1.clone()))
        .collect();
    assert_eq!(
        bindings.last(),
        Some(&(3, "relaunch-3".to_string())),
        "the re-launch upserts its binding at the back: {bindings:?}"
    );
    assert_eq!(
        bindings.iter().filter(|(pid, _)| *pid == 3).count(),
        1,
        "the re-launch leaves no dead duplicate: {bindings:?}"
    );
    assert_eq!(
        bindings.first(),
        Some(&(1, "launch-1".to_string())),
        "the upsert evicts nothing: {bindings:?}"
    );
}

/// The activity-end observer the worker wires drops its pid's binding:
/// a handle whose result the kernel consumed in-cell (its notice never
/// arrives) must not hold a dead binding past its own end — at the
/// table's bound a dead binding would evict a live launch's stamp and
/// the foreign-bash notice would credit the wrong delivery. Driven
/// through the engine's WIRED observer (the real construction's
/// closure), never a test-local re-implementation of the retain.
#[tokio::test]
async fn the_wired_activity_end_observer_drops_the_launch_binding() {
    let dir = tempfile::tempdir().unwrap();
    let worker = Worker::new(
        WorkerConfig {
            socket_path: dir.path().join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "kernel-binding-session".to_string(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery.jsonl"),
            telemetry_disabled: Some(true),
            script: Some(json!({ "engine": "faux", "responses": [] })),
        },
        None,
    );
    {
        let mut core = worker.core.lock().unwrap();
        core.kernel_bash_creators
            .push_back((4321, "delivery-a".to_string()));
        core.kernel_bash_creators
            .push_back((4322, "delivery-b".to_string()));
    }
    let engine = worker
        .agent_engine
        .as_ref()
        .expect("the faux worker runs the real agent engine");
    let observer = engine
        .kernel_bash_activity_end_observer
        .lock()
        .unwrap()
        .clone()
        .expect("the worker wires the activity-end observer at construction");
    // The fired wired observer: the kernel's own call shape (the pid
    // of the handle whose activity ended).
    observer(4321);
    let pids: Vec<u32> = worker
        .core
        .lock()
        .unwrap()
        .kernel_bash_creators
        .iter()
        .map(|binding| binding.0)
        .collect();
    assert_eq!(
        pids,
        vec![4322],
        "the wired activity-end observer drops its pid's binding"
    );
}
