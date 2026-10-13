use super::*;
use pa_core::session_engine::rlm_usage::RlmChildUsageReport;
use std::sync::Arc;

/// A capturing sink: reports land in a shared vector for assertions;
/// `fail` flips `record` into a failing no-op.
#[derive(Default)]
struct CapturingSink {
    reports: std::sync::Mutex<Vec<RlmChildUsageReport>>,
    fail: std::sync::atomic::AtomicBool,
    forgotten: std::sync::Mutex<Vec<String>>,
    attempts: std::sync::atomic::AtomicUsize,
}

impl pa_core::session_engine::rlm_usage::RlmChildUsageSink for CapturingSink {
    fn record(
        &self,
        report: RlmChildUsageReport,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        let (reports, fail) = (&self.reports, &self.fail);
        Box::pin(async move {
            self.attempts
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if fail.load(std::sync::atomic::Ordering::Relaxed) {
                return false;
            }
            reports.lock().expect("reports lock").push(report);
            true
        })
    }

    fn forget(
        &self,
        rlm_child_id: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        let child_id = rlm_child_id.to_owned();
        Box::pin(async move {
            self.forgotten.lock().unwrap().push(child_id);
        })
    }
}

/// A child record aimed at a real temp child session file.
fn record_with_file(child_id: &str, session_file: &Path) -> Arc<Mutex<ChildRecord>> {
    Arc::new(Mutex::new(ChildRecord {
        rlm_child_id: child_id.to_string(),
        session_name: "child".to_string(),
        active_session_id: "child-live".to_string(),
        session_id: None,
        session_dir: String::new(),
        model: String::new(),
        label: "child".to_string(),
        started_at_ms: 0,
        settled_status: None,
        settled: false,
        answer_preview: None,
        answer_text: None,
        answer_captured: false,
        replied_since_task: false,
        notice_delivered: false,
        prompt_admitted: true,
        error: None,
        closed_by_parent: false,
        retirement_finished: false,
        retirement_notified: false,
        retirement_roster_emitted: false,
        usage_registration_forgotten: false,
        session_file: Some(session_file.display().to_string()),
        attributed_rows: Some(0),
        pending_usage_report: None,
        usage_watch_live: false,
        usage_rearm: false,
        emit_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        last_emitted_status: None,
        rename_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
    }))
}

fn registry(agent_dir: &Path) -> SupervisorChildSessions {
    let tmp = tempfile::tempdir().unwrap();
    let socket = tmp.path().join("supervisor.sock");
    std::mem::forget(tmp);
    SupervisorChildSessions::new(
        Arc::new(SupervisorLink::new(socket)),
        agent_dir.to_path_buf(),
        "parent-live".to_string(),
        std::sync::Arc::new(crate::model_allowlist::ModelRefusalTelemetry::new(
            agent_dir.to_path_buf(),
            /*telemetry_disabled*/ true,
        )),
    )
}

/// A child session file: the task prompt (first user row) plus the
/// captured completion (the branch-verified TS fixture row's child usage).
fn child_file(dir: &Path) -> PathBuf {
    let path = dir.join("child.jsonl");
    std::fs::write(
        &path,
        concat!(
            r#"{"type":"session","id":"child-1","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/tmp","version":3}"#, "\n",
            r#"{"type":"custom_message","id":"c0","parentId":null,"timestamp":"2026-09-23T00:00:01.000Z","customType":"agent_message","content":"[task from parent]\n\nthe task","display":true,"details":{"id":"spawn:child-1","message":"the task"}}"#, "\n",
            r#"{"type":"message","id":"a1","parentId":"c0","timestamp":"2026-09-23T00:00:02.000Z","message":{"role":"assistant","content":[],"stopReason":"toolUse","usage":{"input":50208,"output":2929,"cacheRead":0,"cacheWrite":0,"totalTokens":53137,"cost":{"input":0.0075312,"output":0.0014645,"cacheRead":0,"cacheWrite":0,"total":0.0089957}}}}"#, "\n",
        ),
    )
    .unwrap();
    path
}

#[tokio::test]
async fn emit_reads_once_and_advances_the_cursor() {
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let sessions = registry(Path::new("/agent"));
    let sink = Arc::new(CapturingSink::default());
    sessions.set_usage_sink(sink.clone());
    let record = record_with_file("sub-emit1", &file);

    sessions.inner.emit_child_usage(&record).await;
    let reports = sink.reports.lock().expect("reports lock").clone();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].rlm_child_id, "sub-emit1");
    let [(origin, usage)] = reports[0].batches[..] else {
        panic!("one batch: {:?}", reports[0].batches);
    };
    assert_eq!(origin, pa_types::session::ChildUsageOrigin::SpawnTask);
    assert_eq!(usage.input, 50_208);
    assert_eq!(usage.output, 2_929);
    assert!((usage.cost.total.as_f64() - 0.008_995_7).abs() < 1e-9);
    let consumed = record.lock().await.attributed_rows;
    assert!(consumed.is_some_and(|rows| rows > 0));

    sessions.inner.emit_child_usage(&record).await;
    let reports = sink.reports.lock().expect("reports lock").clone();
    assert_eq!(reports.len(), 1);
    assert_eq!(record.lock().await.attributed_rows, consumed);
}

/// A failed delivery keeps the cursor so the next emission re-delivers the
/// same rows; once the sink persists, the report lands exactly once.
#[tokio::test]
async fn emit_keeps_the_cursor_until_the_sink_persists() {
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let sessions = registry(Path::new("/agent"));
    let sink = Arc::new(CapturingSink::default());
    sessions.set_usage_sink(sink.clone());
    let record = record_with_file("sub-emit5", &file);

    sink.fail.store(true, std::sync::atomic::Ordering::Relaxed);
    sessions.inner.emit_child_usage(&record).await;
    assert_eq!(record.lock().await.attributed_rows, Some(0));
    assert_eq!(sink.reports.lock().expect("reports lock").len(), 0);

    sink.fail.store(false, std::sync::atomic::Ordering::Relaxed);
    sessions.inner.emit_child_usage(&record).await;
    let reports = sink.reports.lock().expect("reports lock").clone();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].rlm_child_id, "sub-emit5");
    assert!(record
        .lock()
        .await
        .attributed_rows
        .is_some_and(|rows| rows > 0));
}

/// A failed final observation keeps its report owed; the follow-up forget
/// replays it before the registration drops instead of orphaning it.
#[tokio::test]
async fn forget_replays_the_retained_report_before_unregistering() {
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let sessions = registry(Path::new("/agent"));
    let sink = Arc::new(CapturingSink::default());
    sessions.set_usage_sink(sink.clone());
    let record = record_with_file("sub-forget1", &file);

    sink.fail.store(true, std::sync::atomic::Ordering::Relaxed);
    sessions.inner.emit_child_usage(&record).await;
    assert!(record.lock().await.pending_usage_report.is_some());
    assert_eq!(record.lock().await.attributed_rows, Some(0));

    sink.fail.store(false, std::sync::atomic::Ordering::Relaxed);
    sessions.inner.forget_child_usage(&record).await;
    let reports = sink.reports.lock().expect("reports lock").clone();
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].rlm_child_id, "sub-forget1");
    assert!(record.lock().await.pending_usage_report.is_none());
    assert!(record
        .lock()
        .await
        .attributed_rows
        .is_some_and(|rows| rows > 0));
}

#[tokio::test]
async fn emit_without_a_sink_consumes_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let sessions = registry(Path::new("/agent"));
    let record = record_with_file("sub-emit2", &file);

    sessions.inner.emit_child_usage(&record).await;
    assert_eq!(record.lock().await.attributed_rows, Some(0));
}

#[tokio::test]
async fn emit_tolerates_missing_and_absent_files() {
    let tmp = tempfile::tempdir().unwrap();
    let sessions = registry(Path::new("/agent"));
    let sink = Arc::new(CapturingSink::default());
    sessions.set_usage_sink(sink.clone());
    let missing = record_with_file("sub-emit3", &tmp.path().join("absent.jsonl"));
    sessions.inner.emit_child_usage(&missing).await;
    assert_eq!(sink.reports.lock().expect("reports lock").len(), 0);

    let no_file = record_with_file("sub-emit4", &tmp.path().join("x.jsonl"));
    no_file.lock().await.session_file = None;
    sessions.inner.emit_child_usage(&no_file).await;
    assert_eq!(sink.reports.lock().expect("reports lock").len(), 0);
}

/// The reseed lists the parent's live ledger children as settled rows
/// (tombstones/torn/`meta`/foreign parents excluded), the cursor lazy
/// until a delivery primes it at the tail.
#[tokio::test]
async fn reseed_lists_live_ledger_children_settled_and_bills_only_after_a_delivery() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = tmp.path().join("agent");
    let daemon_sessions = tmp.path().join("daemon-sessions");
    let proto = child_file(tmp.path());
    let file_at = |path: PathBuf| {
        std::fs::create_dir_all(path.parent().expect("parent dir")).unwrap();
        std::fs::copy(&proto, &path).unwrap();
        path.display().to_string()
    };
    let parent_one = file_at(daemon_sessions.join("P.jsonl"));
    let parent_two = file_at(daemon_sessions.join("Q.jsonl"));
    let child_one = file_at(agent.join("session-artifacts/P/sub-a/sess-a.jsonl"));
    let child_two = file_at(agent.join("session-artifacts/P/sub-b/sess-b.jsonl"));
    let child_legacy = file_at(agent.join("session-artifacts/P/sub-legacy/sess-legacy.jsonl"));
    let child_three = file_at(agent.join("session-artifacts/P/sub-c/sess-c.jsonl"));
    let child_four = file_at(agent.join("session-artifacts/Q/sub-d/sess-d.jsonl"));
    for (child_id, session_file, status, prompt) in [
        ("sub-a", &child_one, "completed", Some("finished task")),
        ("sub-b", &child_two, "running", None),
    ] {
        crate::rlm_ledger::write_rlm_subagent_display(
            &crate::rlm_ledger::RlmSubagentDisplayEntry {
                type_tag: "rlm_subagent".to_string(),
                child_id: child_id.to_string(),
                session_name: child_id.to_string(),
                session_dir: Path::new(session_file)
                    .parent()
                    .unwrap()
                    .display()
                    .to_string(),
                session_file: session_file.clone(),
                rlm_parent_node_id: None,
                prompt: prompt.map(str::to_string),
                spawn_code: None,
                model: None,
                status: status.to_string(),
                created_at: 1234,
            },
        )
        .unwrap();
    }
    let spawn = |child_id: &str, parent: &str, child: &str| {
        format!(
            r#"{{"v":1,"op":"spawn","at":"2026-09-30T00:00:00Z","childId":"{child_id}","parent":"{parent}","child":"{child}","depth":1,"name":"{child_id}"}}"#
        )
    };
    let ledger_path = crate::rlm_ledger::rlm_ledger_path(&agent, &daemon_sessions);
    std::fs::create_dir_all(ledger_path.parent().expect("ledger dir")).unwrap();
    std::fs::write(
        ledger_path,
        [
            r#"{"v":1,"op":"meta","at":"2026-09-30T00:00:00Z"}"#,
            spawn("sub-a", &parent_one, &child_one).as_str(),
            r#"{"v":1,"op":"spawn","at":"#,
            spawn("sub-b", &parent_one, &child_two).as_str(),
            spawn("sub-legacy", &parent_one, &child_legacy).as_str(),
            spawn("sub-c", &parent_one, &child_three).as_str(),
            format!(
                r#"{{"v":1,"op":"delete","at":"2026-09-30T00:00:01Z","childId":"sub-c","child":"{child_three}","reason":"user"}}"#
            )
            .as_str(),
            spawn("sub-d", &parent_two, &child_four).as_str(),
        ]
        .join("\n"),
    )
    .unwrap();
    let sessions = registry(&agent);
    let supervisor_socket = sessions.inner.link.socket_path().clone();
    crate::descriptor::persist_supervisor_config(
        &crate::descriptor::descriptor_dir(&agent, &supervisor_socket)
            .join(crate::descriptor::SUPERVISOR_CONFIG_FILE_NAME),
        &crate::descriptor::PersistedSupervisorConfig {
            version: 1,
            socket_path: supervisor_socket.to_string_lossy().to_string(),
            default_session_dir: Some(daemon_sessions.display().to_string()),
        },
    )
    .unwrap();
    sessions.set_identity(ParentIdentity {
        session_file: Some(parent_one.clone()),
        ..ParentIdentity::with_default_depth()
    });
    let sink = Arc::new(CapturingSink::default());
    sessions.set_usage_sink(sink.clone());
    sessions.reseed_from_ledger().await;
    let roster = sessions.list_subagents().await.expect("the roster read");
    let rows: Vec<_> = roster
        .iter()
        .map(|row| {
            (
                row.rlm_child_id.as_str(),
                row.status,
                row.active_session_id.as_deref(),
                row.label.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("sub-a", "completed", Some("sess-a"), Some("finished task")),
            ("sub-b", "error", Some("sess-b"), Some("child agent")),
            (
                "sub-legacy",
                "completed",
                Some("sess-legacy"),
                Some("child agent")
            ),
        ],
        "completed and interrupted children keep their display verdicts"
    );

    let legacy = sessions
        .inner
        .find_record("sub-legacy")
        .await
        .expect("ledger-only row");
    assert!(legacy.lock().await.started_at_ms > 0);

    let record = sessions
        .inner
        .find_record("sub-a")
        .await
        .expect("the reseeded row");
    // Nothing is owed: the pre-restart history never re-bills.
    sessions.inner.emit_child_usage(&record).await;
    assert_eq!(sink.reports.lock().expect("reports lock").len(), 0);
    // A delivery primes the lazy cursor at the tail; the delivered turn
    // appends its row; the next emit bills only that row.
    SupervisorChildSessionsInner::arm_usage_watch(&sessions.inner, &record).await;
    assert_eq!(record.lock().await.attributed_rows, Some(2));
    let mut content = std::fs::read_to_string(Path::new(&child_one)).expect("child file");
    content.push_str(
        r#"{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-09-23T00:00:03.000Z","message":{"role":"assistant","content":[],"stopReason":"toolUse","usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"input":0.1,"output":0.05,"cacheRead":0,"cacheWrite":0,"total":0.15}}}}"#,
    );
    content.push('\n');
    std::fs::write(Path::new(&child_one), content).expect("append the row");
    sessions.inner.emit_child_usage(&record).await;
    let reports = sink.reports.lock().expect("reports lock").clone();
    assert_eq!(reports.len(), 1);
    let [(_, usage)] = reports[0].batches[..] else {
        panic!("one batch: {:?}", reports[0].batches);
    };
    assert_eq!((usage.input, usage.output), (10, 5));
}

/// Cancellation after delivery starts retains the exact interval; rows arriving
/// behind it are drained once before the caller's final forget.
#[tokio::test]
async fn canceled_interval_keeps_identity_and_drains_new_rows_before_forget() {
    use std::io::Write;
    struct CancelFirstSink {
        attempts: std::sync::Mutex<Vec<RlmChildUsageReport>>,
        started: tokio::sync::Notify,
        forgotten: std::sync::atomic::AtomicBool,
    }
    impl pa_core::session_engine::rlm_usage::RlmChildUsageSink for CancelFirstSink {
        fn record(
            &self,
            report: RlmChildUsageReport,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
            Box::pin(async move {
                let first = {
                    let mut attempts = self.attempts.lock().unwrap();
                    let first = attempts.is_empty();
                    attempts.push(report);
                    first
                };
                if first {
                    self.started.notify_one();
                    std::future::pending::<()>().await;
                }
                true
            })
        }
        fn forget(
            &self,
            _id: &str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
            Box::pin(async move {
                self.forgotten
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            })
        }
    }
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let sessions = registry(Path::new("/agent"));
    let sink = Arc::new(CancelFirstSink {
        attempts: std::sync::Mutex::new(vec![]),
        started: tokio::sync::Notify::new(),
        forgotten: std::sync::atomic::AtomicBool::new(false),
    });
    sessions.set_usage_sink(sink.clone());
    let record = record_with_file("sub-canceled", &file);
    let inner = sessions.inner.clone();
    let emitted_record = record.clone();
    let emit = tokio::spawn(async move {
        inner.emit_child_usage(&emitted_record).await;
    });
    tokio::time::timeout(Duration::from_secs(5), sink.started.notified())
        .await
        .unwrap();
    emit.abort();
    assert!(emit.await.unwrap_err().is_cancelled());
    let pending = record.lock().await.pending_usage_report.clone().unwrap();
    let mut later: serde_json::Value = std::fs::read_to_string(&file)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|row| row["message"]["role"] == "assistant")
        .unwrap();
    later["id"] = serde_json::json!("new-completion");
    later["parentId"] = serde_json::json!("a0");
    later["message"]["usage"]["input"] = serde_json::json!(70);
    let mut append = std::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap();
    writeln!(append, "{}", serde_json::to_string(&later).unwrap()).unwrap();
    sessions.inner.emit_child_usage(&record).await;
    sessions.inner.forget_child_usage(&record).await;
    {
        let attempts = sink.attempts.lock().unwrap();
        assert_eq!(
            attempts.len(),
            3,
            "canceled attempt, same-ID retry, then fresh interval"
        );
        assert_eq!(attempts[0].report_id, pending.0.report_id);
        assert_eq!(attempts[1].report_id, pending.0.report_id);
        assert_eq!(attempts[0].batches, attempts[1].batches);
        assert_ne!(attempts[2].report_id, pending.0.report_id);
        assert_eq!(attempts[2].batches.len(), 1);
        assert_eq!(attempts[2].batches[0].1.input, 70);
        assert!(sink.forgotten.load(std::sync::atomic::Ordering::SeqCst));
    }
    assert!(record.lock().await.pending_usage_report.is_none());
    assert_eq!(
        record.lock().await.attributed_rows,
        Some(
            crate::session_store::SessionFile::open(&file)
                .unwrap()
                .entries()
                .len()
        )
    );
}

#[tokio::test]
async fn failed_final_replay_preserves_report_and_registration_for_a_bounded_retry() {
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let sessions = registry(tmp.path());
    let sink = Arc::new(CapturingSink::default());
    sessions.set_usage_sink(sink.clone());
    let record = record_with_file("sub-owed-final", &file);
    sink.fail.store(true, std::sync::atomic::Ordering::Relaxed);
    sessions.inner.emit_child_usage(&record).await;
    let frozen = record.lock().await.pending_usage_report.clone().unwrap();
    sessions.inner.forget_child_usage(&record).await;
    assert!(
        sink.forgotten.lock().unwrap().is_empty(),
        "an owed report must remain registered"
    );
    assert_eq!(
        sink.attempts.load(std::sync::atomic::Ordering::Relaxed),
        2,
        "one initial attempt plus one bounded final replay"
    );
    {
        let held = record.lock().await.pending_usage_report.clone().unwrap();
        assert_eq!(held.0.report_id, frozen.0.report_id);
        assert_eq!(held.0.batches, frozen.0.batches);
        assert_eq!(held.1, frozen.1);
    }
    sink.fail.store(false, std::sync::atomic::Ordering::Relaxed);
    sessions.inner.forget_child_usage(&record).await;
    {
        let reports = sink.reports.lock().unwrap();
        let observed: Vec<_> = reports
            .iter()
            .map(|report| {
                (
                    report.report_id.clone(),
                    report.rlm_child_id.clone(),
                    report.batches.clone(),
                )
            })
            .collect();
        assert_eq!(
            observed,
            vec![(frozen.0.report_id, frozen.0.rlm_child_id, frozen.0.batches)]
        );
    }
    assert_eq!(
        sink.forgotten.lock().unwrap().as_slice(),
        &["sub-owed-final"]
    );
    assert!(record.lock().await.pending_usage_report.is_none());
    assert_eq!(sink.attempts.load(std::sync::atomic::Ordering::Relaxed), 3);
}

/// A real supervisor link whose second kill fails: retirement replay must not resend it.
async fn retirement_registry(
    dir: &Path,
) -> (
    SupervisorChildSessions,
    Arc<std::sync::atomic::AtomicUsize>,
    Arc<std::sync::Mutex<Vec<Value>>>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let socket = dir.join("retirement.sock");
    let listener = pa_types::platform::transport::bind_transport(&socket)
        .await
        .unwrap();
    let kills = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = Arc::clone(&kills);
    let commands = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed_commands = Arc::clone(&commands);
    let task = tokio::spawn(async move {
        loop {
            let Ok(stream) = listener.accept().await else {
                return;
            };
            let (reader, mut writer) = stream.split();
            let mut reader = BufReader::new(reader);
            let hello =
                json!({"type":"daemon_hello", "protocol":crate::protocol::current_protocol_info()});
            writer
                .write_all(format!("{hello}\n").as_bytes())
                .await
                .unwrap();
            let mut line = String::new();
            if reader.read_line(&mut line).await.unwrap() == 0 {
                continue;
            }
            let envelope: Value = serde_json::from_str(&line).unwrap();
            observed_commands
                .lock()
                .unwrap()
                .push(envelope["command"].clone());
            let command = envelope["command"]["type"].as_str().unwrap();
            let id = envelope["id"].as_str().unwrap();
            let response = if command == "kill"
                && observed.fetch_add(1, std::sync::atomic::Ordering::Relaxed) > 0
            {
                crate::protocol::response_failure(
                    Some(id),
                    command,
                    "Unknown active session: child-live",
                    None,
                )
            } else {
                crate::protocol::response_success(Some(id), command, None)
            };
            writer
                .write_all(format!("{}\n", crate::protocol::response_line(&response)).as_bytes())
                .await
                .unwrap();
        }
    });
    let registry = SupervisorChildSessions::new(
        Arc::new(SupervisorLink::new(socket)),
        dir.to_path_buf(),
        "parent-live".into(),
        Arc::new(crate::model_allowlist::ModelRefusalTelemetry::new(
            dir.to_path_buf(),
            /*telemetry_disabled*/ true,
        )),
    );
    (registry, kills, commands, task)
}

#[tokio::test]
async fn repeated_delete_replays_retired_usage_without_repeating_lifecycle_work() {
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let (sessions, kills, _commands, server) = retirement_registry(tmp.path()).await;
    let sink = Arc::new(CapturingSink::default());
    sink.fail.store(true, std::sync::atomic::Ordering::Relaxed);
    sessions.set_usage_sink(sink.clone());
    let record = record_with_file("sub-retire-delete", &file);
    record.lock().await.settled_status = Some("done");
    sessions.inner.children.lock().await.push(record.clone());
    let settled = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let notified = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (settle_tx, mut settle_rx) = tokio::sync::mpsc::unbounded_channel();
    let observed = settled.clone();
    sessions.set_settle_hook(Arc::new(move || {
        observed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let _ = settle_tx.send(());
    }));
    let observed = notified.clone();
    sessions.set_delete_notifier(Arc::new(move |_| {
        observed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }));
    let first = sessions
        .delete_subagent("sub-retire-delete".into())
        .await
        .unwrap_err();
    assert!(first.to_string().contains("usage remains owed"));
    tokio::time::timeout(Duration::from_secs(5), settle_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(sessions.list_subagents().await.unwrap().is_empty());
    assert!(!sessions.any_running().await);
    assert!(sink.forgotten.lock().unwrap().is_empty());
    let frozen = record.lock().await.pending_usage_report.clone().unwrap().0;
    let attempts = sink.attempts.load(std::sync::atomic::Ordering::Relaxed);
    assert!(sessions
        .delete_subagent("sub-retire-delete".into())
        .await
        .unwrap_err()
        .to_string()
        .contains("usage remains owed"));
    assert_eq!(
        sink.attempts.load(std::sync::atomic::Ordering::Relaxed),
        attempts + 1
    );
    assert!(sink.forgotten.lock().unwrap().is_empty());
    sink.fail.store(false, std::sync::atomic::Ordering::Relaxed);
    let attempts = sink.attempts.load(std::sync::atomic::Ordering::Relaxed);
    assert_eq!(
        sessions
            .delete_subagent("sub-retire-delete".into())
            .await
            .unwrap()
            .outcome,
        Some("deleted")
    );
    assert_eq!(
        sink.attempts.load(std::sync::atomic::Ordering::Relaxed),
        attempts + 1
    );
    {
        let reports = sink.reports.lock().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(
            (reports[0].report_id.clone(), reports[0].batches.clone()),
            (frozen.report_id, frozen.batches)
        );
    }
    assert_eq!(
        sink.forgotten.lock().unwrap().as_slice(),
        &["sub-retire-delete"]
    );
    sessions
        .delete_subagent("sub-retire-delete".into())
        .await
        .unwrap();
    assert_eq!(
        (
            kills.load(std::sync::atomic::Ordering::Relaxed),
            settled.load(std::sync::atomic::Ordering::Relaxed),
            notified.load(std::sync::atomic::Ordering::Relaxed)
        ),
        (1, 1, 1)
    );
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn repeated_close_replays_retired_usage_without_a_second_kill() {
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let (sessions, kills, _commands, server) = retirement_registry(tmp.path()).await;
    let sink = Arc::new(CapturingSink::default());
    sink.fail.store(true, std::sync::atomic::Ordering::Relaxed);
    sessions.set_usage_sink(sink.clone());
    let record = record_with_file("sub-retire-close", &file);
    sessions.inner.children.lock().await.push(record.clone());
    let first = sessions
        .close_children(ChildCloseReason::Shutdown)
        .await
        .unwrap_err();
    assert!(first.to_string().contains("usage remains owed"));
    assert!(sessions.list_subagents().await.unwrap().is_empty());
    assert!(!sessions.any_running().await);
    assert!(sink.forgotten.lock().unwrap().is_empty());
    let frozen = record.lock().await.pending_usage_report.clone().unwrap().0;
    let attempts = sink.attempts.load(std::sync::atomic::Ordering::Relaxed);
    assert!(sessions
        .close_children(ChildCloseReason::Shutdown)
        .await
        .unwrap_err()
        .to_string()
        .contains("usage remains owed"));
    assert_eq!(
        sink.attempts.load(std::sync::atomic::Ordering::Relaxed),
        attempts + 1
    );
    assert!(sink.forgotten.lock().unwrap().is_empty());
    sink.fail.store(false, std::sync::atomic::Ordering::Relaxed);
    let attempts = sink.attempts.load(std::sync::atomic::Ordering::Relaxed);
    sessions
        .close_children(ChildCloseReason::Shutdown)
        .await
        .unwrap();
    assert_eq!(
        sink.attempts.load(std::sync::atomic::Ordering::Relaxed),
        attempts + 1
    );
    {
        let reports = sink.reports.lock().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(
            (reports[0].report_id.clone(), reports[0].batches.clone()),
            (frozen.report_id, frozen.batches)
        );
    }
    assert_eq!(
        sink.forgotten.lock().unwrap().as_slice(),
        &["sub-retire-close"]
    );
    sessions
        .close_children(ChildCloseReason::Shutdown)
        .await
        .unwrap();
    assert_eq!(kills.load(std::sync::atomic::Ordering::Relaxed), 1);
    server.abort();
    let _ = server.await;
}

struct AckPausedSink {
    capture: CapturingSink,
    kills: Arc<std::sync::atomic::AtomicUsize>,
    after_ack: tokio::sync::Notify,
    release: tokio::sync::Notify,
    recovered: std::sync::atomic::AtomicBool,
}

impl RlmChildUsageSink for AckPausedSink {
    fn record(
        &self,
        report: RlmChildUsageReport,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        Box::pin(async move {
            if self.kills.load(std::sync::atomic::Ordering::Relaxed) > 0
                && !self.recovered.load(std::sync::atomic::Ordering::Relaxed)
            {
                self.after_ack.notify_one();
                self.release.notified().await;
            }
            self.capture.record(report).await
        })
    }
    fn forget(
        &self,
        id: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        self.capture.forget(id)
    }
}

#[derive(Clone, Copy)]
enum RetirementCaller {
    Delete,
    Close,
    InactiveAfterDelete,
}

async fn cancellation_after_ack_preserves_retirement(caller: RetirementCaller) {
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let (sessions, kills, commands, server) = retirement_registry(tmp.path()).await;
    let sink = Arc::new(AckPausedSink {
        capture: CapturingSink::default(),
        kills: kills.clone(),
        after_ack: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        recovered: std::sync::atomic::AtomicBool::new(false),
    });
    sink.capture
        .fail
        .store(true, std::sync::atomic::Ordering::Relaxed);
    sessions.set_usage_sink(sink.clone());
    let record = record_with_file("sub-cancel-after-ack", &file);
    let notifications = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = notifications.clone();
    sessions.set_delete_notifier(Arc::new(move |id| {
        observed.lock().unwrap().push(id.to_string());
    }));
    let roster_events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = roster_events.clone();
    sessions.set_child_update_sink(Arc::new(move |row| observed.lock().unwrap().push(row)));
    let (settle_tx, mut settle_rx) = tokio::sync::mpsc::unbounded_channel();
    sessions.set_settle_hook(Arc::new(move || {
        let _ = settle_tx.send(());
    }));
    sessions.inner.children.lock().await.push(record.clone());
    let owned = sessions.clone();
    let retirement = tokio::spawn(async move {
        match caller {
            RetirementCaller::Delete | RetirementCaller::InactiveAfterDelete => owned
                .delete_subagent("sub-cancel-after-ack".into())
                .await
                .map(|_| ()),
            RetirementCaller::Close => owned.close_children(ChildCloseReason::Shutdown).await,
        }
    });
    tokio::time::timeout(Duration::from_secs(5), sink.after_ack.notified())
        .await
        .unwrap();
    retirement.abort();
    assert!(retirement.await.unwrap_err().is_cancelled());
    assert_eq!(kills.load(std::sync::atomic::Ordering::Relaxed), 1);
    let frozen = record.lock().await.pending_usage_report.clone().unwrap().0;
    assert!(sink.capture.forgotten.lock().unwrap().is_empty());
    sink.capture
        .fail
        .store(false, std::sync::atomic::Ordering::Relaxed);
    sink.recovered
        .store(true, std::sync::atomic::Ordering::Relaxed);
    match caller {
        RetirementCaller::Delete => {
            sessions
                .delete_subagent("sub-cancel-after-ack".into())
                .await
                .unwrap();
        }
        RetirementCaller::InactiveAfterDelete => {
            assert_eq!(
                sessions
                    .delete_inactive_subagent("sub-cancel-after-ack")
                    .await
                    .unwrap(),
                "deleted"
            );
        }
        RetirementCaller::Close => {
            sessions
                .close_children(ChildCloseReason::Shutdown)
                .await
                .unwrap();
        }
    }
    assert!(sessions.list_subagents().await.unwrap().is_empty());
    assert!(!sessions.any_running().await);
    assert_eq!(kills.load(std::sync::atomic::Ordering::Relaxed), 1);
    match caller {
        RetirementCaller::Delete | RetirementCaller::InactiveAfterDelete => {
            tokio::time::timeout(Duration::from_secs(5), settle_rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                notifications.lock().unwrap().as_slice(),
                &["sub-cancel-after-ack"]
            );
            let collected = sessions
                .collect(vec!["sub-cancel-after-ack".into()], 0)
                .await
                .unwrap();
            assert_eq!(
                collected
                    .iter()
                    .map(|row| (
                        row.rlm_child_id.clone(),
                        row.status,
                        row.settled,
                        row.error.clone()
                    ))
                    .collect::<Vec<_>>(),
                vec![(
                    "sub-cancel-after-ack".into(),
                    "cancelled",
                    true,
                    Some("Deleted by parent orchestrator".into())
                )]
            );
            {
                let events = roster_events.lock().unwrap();
                assert_eq!(events.len(), 1);
                let mut observed = events[0].clone();
                observed.as_object_mut().unwrap().remove("durationMs");
                assert_eq!(
                    observed,
                    json!({"id":"sub-cancel-after-ack", "activeSessionId":"child-live", "sessionName":"child", "label":"child", "status":"cancelled", "sessionDir":"", "error":"Deleted by parent orchestrator"})
                );
            }
            {
                let traffic = commands.lock().unwrap();
                assert_eq!(
                    traffic
                        .iter()
                        .filter(|row| row["type"] == "follow_up")
                        .count(),
                    1
                );
            }
            sessions
                .delete_subagent("sub-cancel-after-ack".into())
                .await
                .unwrap();
            assert!(settle_rx.try_recv().is_err());
            assert_eq!(notifications.lock().unwrap().len(), 1);
        }
        RetirementCaller::Close => {
            assert!(notifications.lock().unwrap().is_empty());
            assert!(roster_events.lock().unwrap().is_empty());
            assert!(settle_rx.try_recv().is_err());
            assert_eq!(
                commands
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|row| row["type"] == "follow_up")
                    .count(),
                0
            );
        }
    }
    {
        let reports = sink.capture.reports.lock().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(
            (reports[0].report_id.clone(), reports[0].batches.clone()),
            (frozen.report_id, frozen.batches)
        );
    }
    assert_eq!(
        sink.capture.forgotten.lock().unwrap().as_slice(),
        &["sub-cancel-after-ack"]
    );
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn delete_canceled_after_kill_ack_retries_without_a_second_kill() {
    cancellation_after_ack_preserves_retirement(RetirementCaller::Delete).await;
}

#[tokio::test]
async fn close_canceled_after_kill_ack_retries_without_a_second_kill() {
    cancellation_after_ack_preserves_retirement(RetirementCaller::Close).await;
}

#[tokio::test]
async fn concurrent_close_replays_debt_after_the_first_caller_retires_the_roster() {
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let (sessions, kills, _commands, server) = retirement_registry(tmp.path()).await;
    let sink = Arc::new(AckPausedSink {
        capture: CapturingSink::default(),
        kills: kills.clone(),
        after_ack: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        recovered: std::sync::atomic::AtomicBool::new(false),
    });
    sink.capture
        .fail
        .store(true, std::sync::atomic::Ordering::Relaxed);
    sessions.set_usage_sink(sink.clone());
    let record = record_with_file("sub-concurrent-close", &file);
    sessions.inner.children.lock().await.push(record.clone());
    let owned = sessions.clone();
    let first = tokio::spawn(async move { owned.close_children(ChildCloseReason::Shutdown).await });
    tokio::time::timeout(Duration::from_secs(5), sink.after_ack.notified())
        .await
        .unwrap();
    let frozen = record.lock().await.pending_usage_report.clone().unwrap().0;
    let mut retry = Box::pin(sessions.close_children(ChildCloseReason::Shutdown));
    // Drive the actual second caller to its first wait while the first owns rename_lock.
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(retry.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    sink.recovered
        .store(true, std::sync::atomic::Ordering::Relaxed);
    sink.release.notify_one();
    assert!(first
        .await
        .unwrap()
        .unwrap_err()
        .to_string()
        .contains("usage remains owed"));
    let attempts = sink
        .capture
        .attempts
        .load(std::sync::atomic::Ordering::Relaxed);
    assert!(retry
        .await
        .unwrap_err()
        .to_string()
        .contains("usage remains owed"));
    assert_eq!(
        sink.capture
            .attempts
            .load(std::sync::atomic::Ordering::Relaxed),
        attempts + 1
    );
    assert!(sessions.list_subagents().await.unwrap().is_empty());
    assert!(sink.capture.forgotten.lock().unwrap().is_empty());
    sink.capture
        .fail
        .store(false, std::sync::atomic::Ordering::Relaxed);
    sessions
        .close_children(ChildCloseReason::Shutdown)
        .await
        .unwrap();
    {
        let reports = sink.capture.reports.lock().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(
            (reports[0].report_id.clone(), reports[0].batches.clone()),
            (frozen.report_id, frozen.batches)
        );
    }
    assert_eq!(
        sink.capture.forgotten.lock().unwrap().as_slice(),
        &["sub-concurrent-close"]
    );
    assert_eq!(kills.load(std::sync::atomic::Ordering::Relaxed), 1);
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn inactive_delete_finishes_a_running_record_whose_kill_already_acknowledged() {
    cancellation_after_ack_preserves_retirement(RetirementCaller::InactiveAfterDelete).await;
}

#[tokio::test]
async fn close_preserves_final_usage_across_a_transient_child_file_read_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let original = std::fs::read(&file).unwrap();
    let parked = tmp.path().join("intact-child.jsonl");
    std::fs::rename(&file, &parked).unwrap();
    // A directory at the requested path fails open/read on all supported platforms.
    // The original transcript remains intact, without relying on root-sensitive permissions.
    std::fs::create_dir(&file).unwrap();
    let (sessions, kills, _commands, server) = retirement_registry(tmp.path()).await;
    let sink = Arc::new(CapturingSink::default());
    sessions.set_usage_sink(sink.clone());
    let record = record_with_file("sub-transient-read", &file);
    sessions.inner.children.lock().await.push(record.clone());
    let first = sessions
        .close_children(ChildCloseReason::Shutdown)
        .await
        .unwrap_err();
    assert!(first.to_string().contains("usage remains owed"));
    assert!(sessions.list_subagents().await.unwrap().is_empty());
    assert!(!sessions.any_running().await);
    assert!(record.lock().await.pending_usage_report.is_none());
    assert_eq!(record.lock().await.attributed_rows, Some(0));
    assert!(sink.forgotten.lock().unwrap().is_empty());
    assert_eq!(sink.attempts.load(std::sync::atomic::Ordering::Relaxed), 0);
    assert_eq!(std::fs::read(&parked).unwrap(), original);
    assert!(sessions
        .close_children(ChildCloseReason::Shutdown)
        .await
        .unwrap_err()
        .to_string()
        .contains("usage remains owed"));
    assert!(sink.forgotten.lock().unwrap().is_empty());
    assert_eq!(kills.load(std::sync::atomic::Ordering::Relaxed), 1);
    std::fs::remove_dir(&file).unwrap();
    std::fs::rename(&parked, &file).unwrap();
    sessions
        .close_children(ChildCloseReason::Shutdown)
        .await
        .unwrap();
    {
        let reports = sink.reports.lock().unwrap();
        // Decode the independently pinned wire numbers once, as the transcript reader does.
        let expected: pa_types::ai::Usage = serde_json::from_str(
            r#"{"input":50208,"output":2929,"cacheRead":0,"cacheWrite":0,"totalTokens":53137,"cost":{"input":0.0075312,"output":0.0014645,"cacheRead":0,"cacheWrite":0,"total":0.0089957}}"#,
        ).unwrap();
        assert_eq!(
            reports
                .iter()
                .map(|report| (report.rlm_child_id.clone(), report.batches.clone()))
                .collect::<Vec<_>>(),
            vec![(
                "sub-transient-read".into(),
                vec![(pa_types::session::ChildUsageOrigin::SpawnTask, expected)]
            )]
        );
    }
    assert_eq!(
        sink.forgotten.lock().unwrap().as_slice(),
        &["sub-transient-read"]
    );
    assert_eq!(kills.load(std::sync::atomic::Ordering::Relaxed), 1);
    assert_eq!(std::fs::read(&file).unwrap(), original);
    sessions
        .close_children(ChildCloseReason::Shutdown)
        .await
        .unwrap();
    assert_eq!(sink.attempts.load(std::sync::atomic::Ordering::Relaxed), 1);
    server.abort();
    let _ = server.await;
}

struct FinalWatcherSink {
    capture: CapturingSink,
    child_file: PathBuf,
    attempts: std::sync::Mutex<Vec<RlmChildUsageReport>>,
    commands: Arc<std::sync::Mutex<Vec<Value>>>,
    recovered: std::sync::atomic::AtomicBool,
}

impl RlmChildUsageSink for FinalWatcherSink {
    fn record(
        &self,
        report: RlmChildUsageReport,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        Box::pin(async move {
            let attempt = {
                let mut attempts = self.attempts.lock().unwrap();
                attempts.push(report.clone());
                attempts.len()
            };
            if attempt == 3 {
                assert!(
                    self.commands
                        .lock()
                        .unwrap()
                        .iter()
                        .all(|command| command["type"] != "follow_up"),
                    "the bounded final replay must precede the parent's terminal notice"
                );
            }
            if attempt == 1 {
                // The slice-top flush succeeds; the child's final turn lands afterward.
                let row = json!({"type":"message","id":"a2","parentId":"a1",
                "timestamp":"2026-09-23T00:00:03.000Z", "message": {
                    "role":"assistant","content":[],"stopReason":"toolUse",
                    "usage":{"input":7,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":10,
                        "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}
                }});
                let mut file = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&self.child_file)
                    .unwrap();
                std::io::Write::write_all(&mut file, format!("{row}\n").as_bytes()).unwrap();
                self.capture.record(report).await
            } else if attempt == 2 || !self.recovered.load(std::sync::atomic::Ordering::Relaxed) {
                false
            } else {
                self.capture.record(report).await
            }
        })
    }
    fn forget(
        &self,
        id: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        self.capture.forget(id)
    }
}

#[derive(Clone, Copy)]
enum FinalWatcherFailure {
    Transient,
    Persistent,
}

async fn settled_watcher_replays_only_one_failed_final_interval(failure: FinalWatcherFailure) {
    let tmp = tempfile::tempdir().unwrap();
    let file = child_file(tmp.path());
    let (sessions, kills, commands, server) = retirement_registry(tmp.path()).await;
    let sink = Arc::new(FinalWatcherSink {
        capture: CapturingSink::default(),
        child_file: file.clone(),
        attempts: std::sync::Mutex::new(Vec::new()),
        commands: commands.clone(),
        recovered: std::sync::atomic::AtomicBool::new(matches!(
            failure,
            FinalWatcherFailure::Transient
        )),
    });
    sessions.set_usage_sink(sink.clone());
    let record = record_with_file("sub-final-watch", &file);
    record.lock().await.session_dir = tmp.path().join("child-display").display().to_string();
    sessions.inner.children.lock().await.push(record.clone());
    let (settle_tx, mut settle_rx) = tokio::sync::mpsc::unbounded_channel();
    sessions.set_settle_hook(Arc::new(move || {
        let _ = settle_tx.send(());
    }));
    tokio::time::timeout(
        Duration::from_secs(5),
        sessions.inner.watch_child_settle(&record),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), settle_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(!sessions.any_running().await);
    assert_eq!(
        sessions.list_subagents().await.unwrap()[0].status,
        "completed"
    );
    let complete_report = |report: &RlmChildUsageReport| {
        (
            report.report_id.clone(),
            report.rlm_child_id.clone(),
            report.batches.clone(),
        )
    };
    let final_report = {
        let attempts = sink.attempts.lock().unwrap();
        assert_eq!(
            attempts.len(),
            3,
            "one slice-top attempt and exactly two final attempts"
        );
        assert_eq!(complete_report(&attempts[1]), complete_report(&attempts[2]));
        assert_ne!(
            attempts[0].report_id, attempts[1].report_id,
            "a new interval gets its own report identity"
        );
        attempts[1].clone()
    };
    assert_eq!(
        final_report.batches,
        vec![(
            pa_types::session::ChildUsageOrigin::SpawnTask,
            pa_types::ai::Usage {
                input: 7,
                output: 3,
                total_tokens: 10,
                ..Default::default()
            }
        )]
    );
    assert!(sink.capture.forgotten.lock().unwrap().is_empty());
    assert_eq!(
        commands
            .lock()
            .unwrap()
            .iter()
            .filter(|command| command["type"] == "follow_up")
            .count(),
        1
    );
    assert_eq!(kills.load(std::sync::atomic::Ordering::Relaxed), 0);
    assert!(settle_rx.try_recv().is_err());
    match failure {
        FinalWatcherFailure::Transient => {
            {
                let reports = sink.capture.reports.lock().unwrap();
                assert_eq!(reports.len(), 2);
                assert_eq!(complete_report(&reports[1]), complete_report(&final_report));
            }
            assert!(record.lock().await.pending_usage_report.is_none());
            assert_eq!(record.lock().await.attributed_rows, Some(3));
        }
        FinalWatcherFailure::Persistent => {
            {
                let held = record.lock().await;
                let pending = held.pending_usage_report.as_ref().unwrap();
                assert_eq!(
                    (complete_report(&pending.0), pending.1),
                    (complete_report(&final_report), 3)
                );
                assert_eq!(held.attributed_rows, Some(2));
            }
            sink.recovered
                .store(true, std::sync::atomic::Ordering::Relaxed);
            sessions
                .close_children(ChildCloseReason::Shutdown)
                .await
                .unwrap();
            assert_eq!(
                sink.attempts.lock().unwrap().len(),
                4,
                "later explicit close still owns the frozen debt"
            );
            let reports = sink.capture.reports.lock().unwrap();
            assert_eq!(reports.len(), 2);
            assert_eq!(complete_report(&reports[1]), complete_report(&final_report));
            assert_eq!(
                sink.capture.forgotten.lock().unwrap().as_slice(),
                &["sub-final-watch"]
            );
            assert_eq!(kills.load(std::sync::atomic::Ordering::Relaxed), 1);
            assert!(settle_rx.try_recv().is_err());
        }
    }
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn settled_watcher_replays_a_failed_final_emit_before_its_notice_and_settle() {
    settled_watcher_replays_only_one_failed_final_interval(FinalWatcherFailure::Transient).await;
}

#[tokio::test]
async fn settled_watcher_caps_a_persistent_final_failure_and_preserves_the_debt() {
    settled_watcher_replays_only_one_failed_final_interval(FinalWatcherFailure::Persistent).await;
}
