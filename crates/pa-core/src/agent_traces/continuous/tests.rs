use super::*;
use crate::agent_traces::tests::{response, Fixture, ScriptedTraceHttp};
use std::io::Write;

fn controller(fixture: &Fixture, path: &Path, enabled: bool) -> Arc<ContinuousTraceUpload> {
    Arc::new(ContinuousTraceUpload {
        cwd: fixture.cwd.clone(),
        agent_dir: fixture.agent_dir.clone(),
        consent: Mutex::new((
            enabled,
            ConsentGeneration::read(&fixture.cwd, &fixture.agent_dir),
        )),
        pending: Mutex::new(Some((path.to_path_buf(), Schedule::default()))),
        wake: Arc::new(tokio::sync::Notify::new()),
        cancel: TraceUploadCancel::new(),
        started: AtomicBool::new(false),
    })
}

#[test]
fn debounce_throttle_and_writes_in_flight_coalesce() {
    let now = Instant::now();
    let mut s = Schedule::default();
    s.persist(now);
    s.persist(now + Duration::from_millis(500));
    assert_eq!(s.due, Some(now + Duration::from_millis(1500)));
    let generation = s.start(now + Duration::from_millis(1500));
    s.persist(now + Duration::from_secs(2));
    s.settle(
        now + Duration::from_secs(3),
        generation,
        &TraceUploadResult::Unchanged,
    );
    assert_eq!(s.due, Some(now + Duration::from_millis(61500)));
    let generation = s.start(s.due.unwrap());
    s.settle(
        now + Duration::from_secs(62),
        generation,
        &TraceUploadResult::Unchanged,
    );
    assert_eq!(s.due, None);
}

#[test]
fn rate_limit_reschedule_honors_retry_after_and_terminal_failure_stops() {
    let now = Instant::now();
    let mut s = Schedule::default();
    let generation = s.start(now);
    s.settle(
        now + Duration::from_secs(1),
        generation,
        &TraceUploadResult::Failed {
            status_code: Some(429),
            message: "synthetic".into(),
            retry_after_ms: Some(120_000),
        },
    );
    assert_eq!(s.due, Some(now + Duration::from_secs(121)));
    let generation = s.start(s.due.unwrap());
    s.settle(
        now + Duration::from_secs(122),
        generation,
        &TraceUploadResult::Failed {
            status_code: Some(403),
            message: "synthetic".into(),
            retry_after_ms: None,
        },
    );
    assert_eq!(s.due, None);
}

#[test]
fn consent_off_never_registers_or_schedules_retroactively() {
    let fixture = Fixture::new();
    let path = fixture.write_session("off.jsonl", "off");
    let c = controller(&fixture, &path, false);
    c.persisted(&path);
    *c.consent.lock().unwrap() = (
        true,
        ConsentGeneration::read(&fixture.cwd, &fixture.agent_dir),
    );
    assert_eq!(c.pending.lock().unwrap().as_ref().unwrap().1.due, None);
    assert!(!agent_trace_outbox_entry_path(&fixture.agent_dir, &path).exists());
}

#[test]
fn external_consent_change_fails_closed_until_background_reload() {
    let fixture = Fixture::new();
    let path = fixture.write_session("changed.jsonl", "changed");
    let c = controller(&fixture, &path, true);
    std::fs::write(
        fixture.agent_dir.join("settings.json"),
        r#"{"agentTraces":{"enabled":false}}"#,
    )
    .unwrap();
    c.persisted(&path);
    assert_eq!(c.pending.lock().unwrap().as_ref().unwrap().1.due, None);
    assert!(!agent_trace_outbox_entry_path(&fixture.agent_dir, &path).exists());
}

#[test]
fn marker_is_complete_and_preserves_a_success_cursor() {
    let fixture = Fixture::new();
    let path = fixture.write_session("marker.jsonl", "marker");
    mark_pending(&fixture.agent_dir, &path).unwrap();
    let raw =
        std::fs::read_to_string(agent_trace_outbox_entry_path(&fixture.agent_dir, &path)).unwrap();
    assert_eq!(
        parse_outbox_entry(&raw),
        Some((path.to_string_lossy().into_owned(), None))
    );
    let signature = TraceUploadSignature::of(&path).unwrap();
    record_agent_trace_outbox_upload(&fixture.agent_dir, &path, signature).unwrap();
    mark_pending(&fixture.agent_dir, &path).unwrap();
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        Some(signature)
    );
}

#[test]
fn competing_delivery_is_nonblocking_and_crash_recoverable() {
    let fixture = Fixture::new();
    let path = fixture.write_session("lease.jsonl", "lease");
    let lease = delivery_lease(&fixture.agent_dir, &path).unwrap();
    assert!(delivery_lease(&fixture.agent_dir, &path).is_none());
    drop(lease);
    assert!(delivery_lease(&fixture.agent_dir, &path).is_some());
}

#[tokio::test(start_paused = true)]
async fn controller_drop_cancels_timer_without_waiting_for_delivery() {
    let fixture = Fixture::new();
    let path = fixture.write_session("drop.jsonl", "drop");
    let c = controller(&fixture, &path, true);
    c.persisted(&path);
    let cancel = c.cancel.clone();
    let http = Arc::new(ScriptedTraceHttp::new(vec![Ok(response(200, "{}"))]));
    let task = tokio::spawn(run_controller(
        Arc::downgrade(&c),
        Arc::new(tokio::sync::Semaphore::new(1)),
        http,
        None,
    ));
    drop(c);
    assert!(cancel.is_cancelled());
    task.await.unwrap();
    assert!(agent_trace_outbox_entry_path(&fixture.agent_dir, &path).is_file());
}

// Informational default CI measurement; calibrated host benchmarks own latency gates.
#[test]
fn measure_synchronous_pending_marker_cost() {
    let fixture = Fixture::new();
    let mut cold = Vec::new();
    let mut warm = Vec::new();
    for index in 0..1000 {
        let path = fixture.session_dir.join(format!("synthetic-{index}.jsonl"));
        let c = controller(&fixture, &path, true);
        let start = std::time::Instant::now();
        c.persisted(&path);
        cold.push(start.elapsed().as_nanos());
        let start = std::time::Instant::now();
        c.persisted(&path);
        warm.push(start.elapsed().as_nanos());
    }
    cold.sort_unstable();
    warm.sort_unstable();
    let report = format!(
        "{}\n",
        json!({"samples":1000,"cold_marker_ns":{"p50":cold[500],"p95":cold[950],"p99":cold[990]},"warm_marker_ns":{"p50":warm[500],"p95":warm[950],"p99":warm[990]},"fsync":false,"consent_metadata_checks_included":true})
    );
    // Explicit stdout retains this informational measurement in hosted CI logs
    // even when the test harness captures println output for passing tests.
    std::io::stdout().write_all(report.as_bytes()).unwrap();
}

fn enable_synthetic_fixture(fixture: &Fixture) {
    let mut settings = crate::settings::SettingsManager::create(&fixture.cwd, &fixture.agent_dir);
    settings.set_agent_traces_enabled(true).unwrap();
    std::fs::write(
        fixture.agent_dir.join("auth.json"),
        r#"{"prime-agent-traces":{"type":"api_key","key":"synthetic-only"}}"#,
    )
    .unwrap();
}

struct ObservedSink {
    requests: tokio::sync::mpsc::UnboundedSender<(
        String,
        tokio::sync::oneshot::Sender<TraceHttpResponse>,
    )>,
    cancelled: Arc<tokio::sync::Notify>,
}

impl TraceHttp for ObservedSink {
    fn put<'a>(
        &'a self,
        _url: &'a str,
        _headers: Vec<(String, String)>,
        body: String,
        _timeout_ms: u64,
        cancel: Option<&'a TraceUploadCancel>,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<TraceHttpResponse, TraceHttpError>> + Send + 'a,
        >,
    > {
        Box::pin(async move {
            let (reply, result) = tokio::sync::oneshot::channel();
            self.requests.send((body, reply)).unwrap();
            tokio::select! {
                answer = result => Ok(answer.unwrap()),
                () = async { if let Some(cancel) = cancel { cancel.wait().await; } else { std::future::pending::<()>().await; } } => {
                    self.cancelled.notify_one();
                    Err(TraceHttpError::Cancelled)
                }
            }
        })
    }
}

#[tokio::test(start_paused = true)]
async fn dropping_an_active_controller_cancels_a_hanging_sink() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("hanging.jsonl", "hanging");
    let c = controller(&fixture, &path, true);
    c.persisted(&path);
    let (requests, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let cancelled = Arc::new(tokio::sync::Notify::new());
    let sink = Arc::new(ObservedSink {
        requests,
        cancelled: cancelled.clone(),
    });
    let task = tokio::spawn(run_controller(
        Arc::downgrade(&c),
        Arc::new(tokio::sync::Semaphore::new(1)),
        sink,
        Some("http://synthetic.invalid".into()),
    ));
    let (_body, _reply) = observed.recv().await.unwrap();
    drop(c);
    cancelled.notified().await;
    task.await.unwrap();
    assert!(agent_trace_outbox_entry_path(&fixture.agent_dir, &path).exists());
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        None
    );
}

#[tokio::test(start_paused = true)]
async fn disabling_consent_cancels_an_inflight_request_without_shutting_down_the_host() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("revoked-inflight.jsonl", "revoked");
    let c = controller(&fixture, &path, true);
    c.persisted(&path);
    let (requests, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let cancelled = Arc::new(tokio::sync::Notify::new());
    let sink = Arc::new(ObservedSink {
        requests,
        cancelled: cancelled.clone(),
    });
    let task = tokio::spawn(run_controller(
        Arc::downgrade(&c),
        Arc::new(tokio::sync::Semaphore::new(1)),
        sink,
        Some("http://synthetic.invalid".into()),
    ));
    let (_body, _reply) = observed.recv().await.unwrap();
    let mut settings = crate::settings::SettingsManager::create(&fixture.cwd, &fixture.agent_dir);
    settings.set_agent_traces_enabled(false).unwrap();
    cancelled.notified().await;
    assert!(!c.cancel.is_cancelled());
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        None
    );
    drop(c);
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn recovery_reschedules_rate_limits_without_holding_an_upload_permit() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("recovery-retry.jsonl", "retry");
    mark_pending(&fixture.agent_dir, &path).unwrap();
    let (requests, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let sink = Arc::new(ObservedSink {
        requests,
        cancelled: Arc::new(tokio::sync::Notify::new()),
    });
    let permits = Arc::new(tokio::sync::Semaphore::new(1));
    let task = tokio::spawn(recover(
        fixture.cwd.clone(),
        fixture.agent_dir.clone(),
        permits.clone(),
        sink,
        Some("http://synthetic.invalid".into()),
        TraceUploadCancel::new(),
    ));
    let (_body, first) = observed.recv().await.unwrap();
    let started = Instant::now();
    let mut limited = response(429, "{}");
    limited.retry_after = Some("120".into());
    first.send(limited).unwrap();
    // Acquire readiness demonstrates the retry timer does not consume delivery capacity.
    let permit = permits.acquire().await.unwrap();
    drop(permit);
    let (_body, second) = observed.recv().await.unwrap();
    assert!(Instant::now() - started >= Duration::from_secs(120));
    second.send(response(200, "{}")).unwrap();
    assert!(task.await.unwrap());
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        TraceUploadSignature::of(&path)
    );
}

#[tokio::test(start_paused = true)]
async fn recovery_shutdown_cancels_a_hanging_request_and_preserves_intent() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("recovery-shutdown.jsonl", "shutdown");
    mark_pending(&fixture.agent_dir, &path).unwrap();
    let (requests, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let cancelled = Arc::new(tokio::sync::Notify::new());
    let sink = Arc::new(ObservedSink {
        requests,
        cancelled: cancelled.clone(),
    });
    let cancel = TraceUploadCancel::new();
    let task = tokio::spawn(recover(
        fixture.cwd.clone(),
        fixture.agent_dir.clone(),
        Arc::new(tokio::sync::Semaphore::new(1)),
        sink,
        Some("http://synthetic.invalid".into()),
        cancel.clone(),
    ));
    let (_body, _reply) = observed.recv().await.unwrap();
    cancel.cancel();
    cancelled.notified().await;
    assert!(!task.await.unwrap());
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        None
    );
    assert!(agent_trace_outbox_entry_path(&fixture.agent_dir, &path).exists());
}

#[tokio::test(start_paused = true)]
async fn writes_during_upload_have_a_followup_and_do_not_advance_the_old_cursor() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("coalesce.jsonl", "coalesce");
    let initial_signature = TraceUploadSignature::of(&path).unwrap();
    let c = controller(&fixture, &path, true);
    c.persisted(&path);
    let (requests, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let sink = Arc::new(ObservedSink {
        requests,
        cancelled: Arc::new(tokio::sync::Notify::new()),
    });
    let task = tokio::spawn(run_controller(
        Arc::downgrade(&c),
        Arc::new(tokio::sync::Semaphore::new(1)),
        sink,
        Some("http://synthetic.invalid".into()),
    ));
    let (first_body, first_reply) = observed.recv().await.unwrap();
    let first_start = Instant::now();
    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"custom","id":"synthetic-appended"})
        )
        .unwrap();
    }
    c.persisted(&path);
    first_reply.send(response(200, "{}")).unwrap();
    let (second_body, _second_reply) = observed.recv().await.unwrap();
    assert!(Instant::now() - first_start >= MIN_INTERVAL);
    assert!(!first_body.contains("synthetic-appended"));
    assert!(second_body.contains("synthetic-appended"));
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        Some(initial_signature)
    );
    drop(c);
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn opted_out_recovery_does_not_create_an_outbox() {
    let fixture = Fixture::new();
    let sink = Arc::new(ScriptedTraceHttp::new(vec![]));
    recover(
        fixture.cwd.clone(),
        fixture.agent_dir.clone(),
        Arc::new(tokio::sync::Semaphore::new(1)),
        sink,
        Some("http://synthetic.invalid".into()),
        TraceUploadCancel::new(),
    )
    .await;
    assert!(!agent_trace_outbox_dir(&fixture.agent_dir).exists());
}

#[tokio::test(start_paused = true)]
async fn startup_recovery_uploads_pending_and_prunes_missing_but_preserves_unknown_kinds() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("recovery.jsonl", "recovery");
    let missing = fixture.session_dir.join("missing.jsonl");
    mark_pending(&fixture.agent_dir, &path).unwrap();
    mark_pending(&fixture.agent_dir, &missing).unwrap();
    let unknown = agent_trace_outbox_dir(&fixture.agent_dir).join("unknown.json");
    std::fs::write(
        &unknown,
        json!({"sessionFile":path,"kind":"semantic-edges"}).to_string(),
    )
    .unwrap();
    let malformed = agent_trace_outbox_dir(&fixture.agent_dir).join("malformed.json");
    std::fs::write(&malformed, "{").unwrap();
    let sink = Arc::new(ScriptedTraceHttp::new(vec![Ok(response(200, "{}"))]));
    recover(
        fixture.cwd.clone(),
        fixture.agent_dir.clone(),
        Arc::new(tokio::sync::Semaphore::new(1)),
        sink,
        Some("http://synthetic.invalid".into()),
        TraceUploadCancel::new(),
    )
    .await;
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        TraceUploadSignature::of(&path)
    );
    assert!(!agent_trace_outbox_entry_path(&fixture.agent_dir, &missing).exists());
    assert!(!malformed.exists());
    assert!(unknown.exists());
}

#[test]
fn persist_racing_a_pruner_retains_a_complete_nonblocking_fallback_marker() {
    let fixture = Fixture::new();
    let path = fixture.write_session("prune-race.jsonl", "race");
    let entry = agent_trace_outbox_entry_path(&fixture.agent_dir, &path);
    std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
    std::fs::write(&entry, "{").unwrap();
    let pruner = outbox_mutation_lock(&entry).unwrap();
    pruner.lock().unwrap();
    mark_pending(&fixture.agent_dir, &path).unwrap();
    let fallback = entry.with_extension("pending.json");
    let raw = std::fs::read_to_string(&fallback).unwrap();
    assert_eq!(
        parse_outbox_entry(&raw),
        Some((path.to_string_lossy().into_owned(), None))
    );
    drop(pruner);
    prune_entry(&entry, "{", None);
    assert!(!entry.exists());
    assert!(fallback.exists());
    prune_entry(&fallback, &raw, None);
    assert!(fallback.exists());
}

#[test]
fn stale_prune_observations_never_remove_a_new_cursor_or_recreated_transcript() {
    let fixture = Fixture::new();
    let path = fixture.write_session("stale-prune.jsonl", "stale");
    mark_pending(&fixture.agent_dir, &path).unwrap();
    let entry = agent_trace_outbox_entry_path(&fixture.agent_dir, &path);
    let raw = std::fs::read_to_string(&entry).unwrap();
    let signature = TraceUploadSignature::of(&path).unwrap();
    record_agent_trace_outbox_upload(&fixture.agent_dir, &path, signature).unwrap();
    prune_entry(&entry, &raw, Some(&path));
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        Some(signature)
    );
    let raw = std::fs::read_to_string(&entry).unwrap();
    prune_entry(&entry, &raw, Some(&path));
    assert!(entry.exists());
}

#[tokio::test(start_paused = true)]
async fn fallback_only_restart_schedules_the_live_controller_without_a_fresh_write() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("fallback-only.jsonl", "fallback-only");
    mark_pending(&fixture.agent_dir, &path).unwrap();
    let primary = agent_trace_outbox_entry_path(&fixture.agent_dir, &path);
    let fallback = primary.with_extension("pending.json");
    std::fs::rename(&primary, &fallback).unwrap();
    let c = controller(&fixture, &path, true);
    let (requests, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let sink = Arc::new(ObservedSink {
        requests,
        cancelled: Arc::new(tokio::sync::Notify::new()),
    });
    let task = tokio::spawn(run_controller(
        Arc::downgrade(&c),
        Arc::new(tokio::sync::Semaphore::new(1)),
        sink,
        Some("http://synthetic.invalid".into()),
    ));
    let (body, _reply) = observed.recv().await.unwrap();
    assert!(body.contains("fallback-only"));
    drop(c);
    task.await.unwrap();
    assert!(fallback.exists());
}

#[test]
fn recovery_registry_releases_inactive_directory_capacity_and_preserves_other_hosts() {
    let fixture = Fixture::new();
    let c = controller(&fixture, &fixture.session_dir.join("registry.jsonl"), true);
    let another_host = controller(&fixture, &fixture.session_dir.join("other.jsonl"), true);
    let dead_cancel = TraceUploadCancel::new();
    let live_cancel = TraceUploadCancel::new();
    let mut recovered = RecoveryRuns::new();
    for n in 0..MAX_CONTROLLERS - 1 {
        recovered.insert(
            PathBuf::from(format!("synthetic-inactive-{n}")),
            (
                dead_cancel.clone(),
                Arc::new(std::sync::atomic::AtomicU8::new(2)),
            ),
        );
    }
    recovered.insert(
        fixture.agent_dir,
        (
            live_cancel.clone(),
            Arc::new(std::sync::atomic::AtomicU8::new(1)),
        ),
    );
    let weak = Arc::downgrade(&c);
    drop(c);
    retain_live_recoveries(&mut recovered, &[weak, Arc::downgrade(&another_host)]);
    assert!(dead_cancel.is_cancelled());
    assert!(!live_cancel.is_cancelled());
    assert_eq!(recovered.len(), 1);
    drop(another_host);
    retain_live_recoveries(&mut recovered, &[]);
    assert!(live_cancel.is_cancelled());
    assert!(recovered.is_empty());
}
