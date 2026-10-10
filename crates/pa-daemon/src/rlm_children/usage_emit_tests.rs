use super::*;
use pa_core::session_engine::rlm_usage::RlmChildUsageReport;
use std::sync::Arc;

/// A capturing sink: reports land in a shared vector for assertions;
/// `fail` flips `record` into a failing no-op.
#[derive(Default)]
struct CapturingSink {
    reports: std::sync::Mutex<Vec<RlmChildUsageReport>>,
    fail: std::sync::atomic::AtomicBool,
}

impl pa_core::session_engine::rlm_usage::RlmChildUsageSink for CapturingSink {
    fn record(
        &self,
        report: RlmChildUsageReport,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        let (reports, fail) = (&self.reports, &self.fail);
        Box::pin(async move {
            if fail.load(std::sync::atomic::Ordering::Relaxed) {
                return false;
            }
            reports.lock().expect("reports lock").push(report);
            true
        })
    }

    fn forget(
        &self,
        _rlm_child_id: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {})
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
        answer_captured: false,
        replied_since_task: false,
        notice_delivered: false,
        prompt_admitted: true,
        error: None,
        closed_by_parent: false,
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
