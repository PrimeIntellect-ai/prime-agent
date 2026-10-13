use super::*;
use crate::agent_traces::tests::{
    clear_trace_credentials, env_lock, response, Fixture, ScriptedTraceHttp,
};
use std::io::Write;

async fn recover(
    cwd: PathBuf,
    agent_dir: PathBuf,
    permits: Arc<tokio::sync::Semaphore>,
    http: Arc<dyn TraceHttp>,
    base_url: Option<String>,
    cancel: TraceUploadCancel,
) -> bool {
    recover_with_backoff(cwd, agent_dir, permits, http, base_url, cancel, None)
        .await
        .0
}

fn controller(fixture: &Fixture, path: &Path, enabled: bool) -> Arc<ContinuousTraceUpload> {
    Arc::new(ContinuousTraceUpload {
        cwd: fixture.cwd.clone(),
        agent_dir: Arc::new(fixture.agent_dir.clone()),
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

#[tokio::test(start_paused = true)]
async fn external_consent_change_fails_closed_until_background_reload() {
    let fixture = Fixture::new();
    let path = fixture.write_session("changed.jsonl", "changed");
    let c = controller(&fixture, &path, true);
    std::fs::write(
        fixture.agent_dir.join("settings.json"),
        r#"{"agentTraces":{"enabled":false}}"#,
    )
    .unwrap();
    c.persisted(&path);
    // The durable intent survives the external change; only the worker's
    // consent re-read decides whether it is ever delivered.
    assert!(c.pending.lock().unwrap().as_ref().unwrap().1.due.is_some());
    assert!(agent_trace_outbox_entry_path(&fixture.agent_dir, &path).exists());
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
    tokio::time::advance(MIN_INTERVAL * 2).await;
    tokio::task::yield_now().await;
    assert!(
        observed.try_recv().is_err(),
        "a disabled project must never deliver its retained intent"
    );
    drop(c);
    task.await.unwrap();
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
        json!({"samples":1000,"cold_marker_ns":{"p50":cold[500],"p95":cold[950],"p99":cold[990]},"warm_marker_ns":{"p50":warm[500],"p95":warm[950],"p99":warm[990]},"fsync":false,"consent_metadata_checks_included":false,"cached_consent_check_included":true})
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
    let first_start = Instant::now();
    let mut settings = crate::settings::SettingsManager::create(&fixture.cwd, &fixture.agent_dir);
    settings.set_agent_traces_enabled(false).unwrap();
    cancelled.notified().await;
    assert!(!c.cancel.is_cancelled());
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        None
    );
    tokio::time::advance(MIN_INTERVAL * 2).await;
    tokio::task::yield_now().await;
    assert!(observed.try_recv().is_err(), "consent off must not deliver");
    settings.set_agent_traces_enabled(true).unwrap();
    let (_body, _reply) = tokio::time::timeout(MIN_INTERVAL * 2, observed.recv())
        .await
        .expect("restoring consent resumes without another persist")
        .unwrap();
    assert!(Instant::now() - first_start >= MIN_INTERVAL);
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
            RecoveryRun {
                cancel: dead_cancel.clone(),
                ..RecoveryRun::new(vec![])
            },
        );
    }
    recovered.insert(
        fixture.agent_dir,
        RecoveryRun {
            cancel: live_cancel.clone(),
            ..RecoveryRun::new(vec![Arc::downgrade(&c), Arc::downgrade(&another_host)])
        },
    );
    let registration = Registration::of(&c);
    drop(c);
    let _ = retain_live_recoveries(
        &mut recovered,
        &[registration, Registration::of(&another_host)],
    );
    assert!(dead_cancel.is_cancelled());
    assert!(!live_cancel.is_cancelled());
    assert_eq!(recovered.len(), 1);
    drop(another_host);
    let _ = retain_live_recoveries(&mut recovered, &[]);
    assert!(live_cancel.is_cancelled());
    assert!(recovered.is_empty());
}

#[tokio::test(start_paused = true)]
async fn revoked_recovery_retains_intent_and_resumes_after_consent_restoration() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("revoked-recovery.jsonl", "revoked-recovery");
    mark_pending(&fixture.agent_dir, &path).unwrap();
    let (requests, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let cancelled = Arc::new(tokio::sync::Notify::new());
    let sink = Arc::new(ObservedSink {
        requests,
        cancelled: cancelled.clone(),
    });
    let permits = Arc::new(tokio::sync::Semaphore::new(1));
    let task = tokio::spawn(recover(
        fixture.cwd.clone(),
        fixture.agent_dir.clone(),
        permits.clone(),
        sink.clone(),
        Some("http://synthetic.invalid".into()),
        TraceUploadCancel::new(),
    ));
    let (_body, _reply) = observed.recv().await.unwrap();
    let mut settings = crate::settings::SettingsManager::create(&fixture.cwd, &fixture.agent_dir);
    settings.set_agent_traces_enabled(false).unwrap();
    cancelled.notified().await;
    assert!(!tokio::time::timeout(DEBOUNCE * 2, task)
        .await
        .unwrap()
        .unwrap());
    assert!(agent_trace_outbox_entry_path(&fixture.agent_dir, &path).exists());
    assert!(delivery_lease(&fixture.agent_dir, &path).is_some());
    assert_eq!(permits.available_permits(), 1);
    assert!(
        !recover(
            fixture.cwd.clone(),
            fixture.agent_dir.clone(),
            permits.clone(),
            sink.clone(),
            Some("http://synthetic.invalid".into()),
            TraceUploadCancel::new(),
        )
        .await
    );
    assert!(observed.try_recv().is_err());
    settings.set_agent_traces_enabled(true).unwrap();
    let task = tokio::spawn(recover(
        fixture.cwd.clone(),
        fixture.agent_dir.clone(),
        permits,
        sink,
        Some("http://synthetic.invalid".into()),
        TraceUploadCancel::new(),
    ));
    let (_body, reply) = tokio::time::timeout(MIN_INTERVAL, observed.recv())
        .await
        .unwrap()
        .unwrap();
    reply.send(response(200, "{}")).unwrap();
    assert!(task.await.unwrap());
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        TraceUploadSignature::of(&path)
    );
}

#[tokio::test(start_paused = true)]
async fn incomplete_recovery_cooldown_is_bounded_and_shutdown_cancellable() {
    let state = Arc::new(std::sync::atomic::AtomicU8::new(1));
    let cancel = TraceUploadCancel::new();
    let task_state = state.clone();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        settle_recovery_run(&task_state, false, None, &task_cancel).await;
    });
    tokio::task::yield_now().await;
    tokio::time::advance(MIN_INTERVAL.checked_sub(DEBOUNCE).unwrap()).await;
    assert_eq!(state.load(Ordering::Acquire), 1);
    tokio::time::advance(DEBOUNCE).await;
    task.await.unwrap();
    assert_eq!(state.load(Ordering::Acquire), 0);
    state.store(1, Ordering::Release);
    let task_state = state.clone();
    let task_cancel = cancel.clone();
    let task = tokio::spawn(async move {
        settle_recovery_run(&task_state, false, None, &task_cancel).await;
    });
    tokio::task::yield_now().await;
    let began = Instant::now();
    cancel.cancel();
    task.await.unwrap();
    assert_eq!(Instant::now(), began);
    assert_eq!(state.load(Ordering::Acquire), 0);
}

fn mixed_consent_fixture() -> (Fixture, PathBuf, PathBuf, PathBuf) {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let first = fixture.write_session("disabled-project.jsonl", "disabled-project");
    let second = fixture.write_session("enabled-project.jsonl", "enabled-project");
    let second_cwd = fixture.agent_dir.join("other-project");
    std::fs::create_dir_all(&second_cwd).unwrap();
    for (path, cwd) in [(&first, &fixture.cwd), (&second, &second_cwd)] {
        let raw = std::fs::read_to_string(path).unwrap();
        let (header, tail) = raw.split_once('\n').unwrap();
        let mut header: Value = serde_json::from_str(header).unwrap();
        header["cwd"] = json!(cwd);
        std::fs::write(path, format!("{header}\n{tail}")).unwrap();
        mark_pending(&fixture.agent_dir, path).unwrap();
    }
    let config = fixture.cwd.join(crate::settings::storage::CONFIG_DIR_NAME);
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("settings.json"),
        r#"{"agentTraces":{"enabled":false}}"#,
    )
    .unwrap();
    (fixture, first, second, second_cwd)
}

#[tokio::test(start_paused = true)]
async fn disabled_project_recovery_does_not_block_other_opted_in_projects() {
    let (fixture, first, second, second_cwd) = mixed_consent_fixture();
    let sink = Arc::new(ScriptedTraceHttp::new(vec![Ok(response(200, "{}"))]));
    assert!(
        !recover(
            second_cwd,
            fixture.agent_dir.clone(),
            Arc::new(tokio::sync::Semaphore::new(1)),
            sink,
            Some("http://synthetic.invalid".into()),
            TraceUploadCancel::new(),
        )
        .await
    );
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &first),
        None
    );
    assert!(agent_trace_outbox_entry_path(&fixture.agent_dir, &first).exists());
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &second),
        TraceUploadSignature::of(&second)
    );
}

#[tokio::test(start_paused = true)]
async fn disabled_uploaded_cursor_does_not_rearm_recovery() {
    let (fixture, first, second, second_cwd) = mixed_consent_fixture();
    record_agent_trace_outbox_upload(
        &fixture.agent_dir,
        &first,
        TraceUploadSignature::of(&first).unwrap(),
    )
    .unwrap();
    let sink = Arc::new(ScriptedTraceHttp::new(vec![Ok(response(200, "{}"))]));
    assert!(
        recover(
            second_cwd,
            fixture.agent_dir.clone(),
            Arc::new(tokio::sync::Semaphore::new(1)),
            sink,
            Some("http://synthetic.invalid".into()),
            TraceUploadCancel::new(),
        )
        .await
    );
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &second),
        TraceUploadSignature::of(&second)
    );
}

#[tokio::test(start_paused = true)]
async fn mixed_consent_rescan_preserves_exhausted_rate_limit_deadline() {
    let (fixture, _first, _second, second_cwd) = mixed_consent_fixture();
    let (requests, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let sink = Arc::new(ObservedSink {
        requests,
        cancelled: Arc::new(tokio::sync::Notify::new()),
    });
    let task = tokio::spawn(recover_with_backoff(
        second_cwd,
        fixture.agent_dir.clone(),
        Arc::new(tokio::sync::Semaphore::new(1)),
        sink,
        Some("http://synthetic.invalid".into()),
        TraceUploadCancel::new(),
        None,
    ));
    for _ in 0..3 {
        let (_body, reply) = observed.recv().await.unwrap();
        let mut limited = response(429, "{}");
        limited.retry_after = Some("120".into());
        reply.send(limited).unwrap();
    }
    let (complete, not_before) = task.await.unwrap();
    assert!(!complete);
    let began = Instant::now();
    assert_eq!(not_before, Some(began + Duration::from_secs(120)));
    let state = Arc::new(std::sync::atomic::AtomicU8::new(1));
    let task_state = state.clone();
    let task = tokio::spawn(async move {
        settle_recovery_run(&task_state, complete, not_before, &TraceUploadCancel::new()).await;
    });
    tokio::task::yield_now().await;
    tokio::time::advance(MIN_INTERVAL).await;
    assert_eq!(
        state.load(Ordering::Acquire),
        1,
        "must not rescan after only 60 seconds"
    );
    tokio::time::advance(MIN_INTERVAL).await;
    task.await.unwrap();
    assert_eq!(state.load(Ordering::Acquire), 0);
    assert_eq!(Instant::now(), began + Duration::from_secs(120));
}

#[test]
fn oversized_cursor_records_fail_closed_with_bounded_reads() {
    let fixture = Fixture::new();
    let path = fixture.write_session("large-cursor.jsonl", "large-cursor");
    record_agent_trace_outbox_upload(
        &fixture.agent_dir,
        &path,
        TraceUploadSignature::of(&path).unwrap(),
    )
    .unwrap();
    let entry = agent_trace_outbox_entry_path(&fixture.agent_dir, &path);
    let mut value: Value = serde_json::from_str(&std::fs::read_to_string(&entry).unwrap()).unwrap();
    value["padding"] = json!(" ".repeat(64 * 1024));
    std::fs::write(entry, value.to_string()).unwrap();
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        None
    );
}

#[tokio::test(start_paused = true)]
// Credential lookup must stay stable while synthetic background workers run.
#[allow(clippy::await_holding_lock)]
async fn replacement_at_capacity_reuses_a_slot_and_preserves_late_retirement() {
    let _env = env_lock();
    let _credentials = clear_trace_credentials();
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let original_path = fixture.write_session("original.jsonl", "original");
    let replacement_path = fixture.write_session("replacement.jsonl", "replacement");
    let source = controller(&fixture, &original_path, true);
    source.persisted(&original_path);
    let service = Service {
        controllers: Mutex::new(Vec::new()),
        wake: tokio::sync::Notify::new(),
    };
    assert!(service.register(&source));
    let mut hosts = vec![source.clone()];
    for n in 1..MAX_CONTROLLERS {
        let host = controller(
            &fixture,
            &fixture.session_dir.join(format!("host-{n}.jsonl")),
            false,
        );
        assert!(service.register(&host));
        hosts.push(host);
    }
    let old_sink = Arc::new(ScriptedTraceHttp::new(Vec::new()));
    let old_task = tokio::spawn(run_controller(
        Arc::downgrade(&source),
        Arc::new(tokio::sync::Semaphore::new(1)),
        old_sink.clone(),
        Some("http://synthetic.invalid".into()),
    ));
    let first = controller(&fixture, &replacement_path, true);
    assert!(service.replace(&source, &first));
    assert!(source.cancel.is_cancelled());
    old_task.await.unwrap();
    assert_eq!(old_sink.request_count(), 0);
    first.persisted(&replacement_path);
    let mut recovered = RecoveryRuns::new();
    let run = RecoveryRun::new(hosts.iter().map(Arc::downgrade).collect());
    run.state.store(2, Ordering::Release);
    recovered.insert(fixture.agent_dir.clone(), run);
    let snapshot = service.controllers.lock().unwrap().clone();
    retain_live_recoveries(&mut recovered, &snapshot);
    assert!(recovered[&fixture.agent_dir]
        .replay_needed
        .load(Ordering::Acquire));
    let latest = controller(&fixture, &replacement_path, true);
    assert!(service.replace(&first, &latest));
    assert!(first.cancel.is_cancelled());
    acknowledge_replacements(&mut service.controllers.lock().unwrap(), &snapshot);
    assert!(service
        .controllers
        .lock()
        .unwrap()
        .iter()
        .any(|registration| {
            registration.controller.ptr_eq(&Arc::downgrade(&latest))
                && registration.retired_predecessor
        }));
    let current = service.controllers.lock().unwrap().clone();
    retain_live_recoveries(&mut recovered, &current);
    acknowledge_replacements(&mut service.controllers.lock().unwrap(), &current);
    assert_eq!(service.controllers.lock().unwrap().len(), MAX_CONTROLLERS);
    let sink = Arc::new(ScriptedTraceHttp::new(vec![Ok(response(200, "{}"))]));
    let (complete, _) = recover_with_backoff(
        fixture.cwd.clone(),
        fixture.agent_dir.clone(),
        Arc::new(tokio::sync::Semaphore::new(1)),
        sink.clone(),
        Some("http://synthetic.invalid".into()),
        TraceUploadCancel::new(),
        Some(vec![Arc::downgrade(&latest)]),
    )
    .await;
    assert!(!complete); // Replacement owns its marker; the predecessor was recovered.
    assert_eq!(sink.request_count(), 1);
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &original_path),
        TraceUploadSignature::of(&original_path)
    );
    let (requests, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(run_controller(
        Arc::downgrade(&latest),
        Arc::new(tokio::sync::Semaphore::new(1)),
        Arc::new(ObservedSink {
            requests,
            cancelled: Arc::new(tokio::sync::Notify::new()),
        }),
        Some("http://synthetic.invalid".into()),
    ));
    let (_body, reply) = tokio::time::timeout(MIN_INTERVAL, observed.recv())
        .await
        .unwrap()
        .unwrap();
    reply.send(response(200, "{}")).unwrap();
    drop(latest);
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_busy_delivery_lease_leaves_recovery_incomplete_until_release() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("leased-recovery.jsonl", "leased-recovery");
    mark_pending(&fixture.agent_dir, &path).unwrap();
    let lease = delivery_lease(&fixture.agent_dir, &path).unwrap();
    let sink = Arc::new(ScriptedTraceHttp::new(vec![Ok(response(200, "{}"))]));
    assert!(
        !recover(
            fixture.cwd.clone(),
            fixture.agent_dir.clone(),
            Arc::new(tokio::sync::Semaphore::new(1)),
            sink.clone(),
            Some("http://synthetic.invalid".into()),
            TraceUploadCancel::new(),
        )
        .await,
        "a leased marker must keep the sweep incomplete so recovery re-arms"
    );
    drop(lease);
    assert!(
        recover(
            fixture.cwd.clone(),
            fixture.agent_dir.clone(),
            Arc::new(tokio::sync::Semaphore::new(1)),
            sink,
            Some("http://synthetic.invalid".into()),
            TraceUploadCancel::new(),
        )
        .await
    );
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        TraceUploadSignature::of(&path)
    );
}

#[tokio::test(start_paused = true)]
async fn exhausted_recovery_retries_leave_the_sweep_incomplete() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("exhausted-recovery.jsonl", "exhausted-recovery");
    mark_pending(&fixture.agent_dir, &path).unwrap();
    // Three bounded sweep attempts each exhaust the transport retries.
    let sink = Arc::new(ScriptedTraceHttp::new(
        std::iter::repeat_n(Ok(response(503, "{}")), 12).collect(),
    ));
    assert!(
        !recover(
            fixture.cwd.clone(),
            fixture.agent_dir.clone(),
            Arc::new(tokio::sync::Semaphore::new(1)),
            sink,
            Some("http://synthetic.invalid".into()),
            TraceUploadCancel::new(),
        )
        .await,
        "work still due after the bounded retries must keep the sweep incomplete"
    );
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        None
    );
    assert!(agent_trace_outbox_entry_path(&fixture.agent_dir, &path).exists());
}

#[tokio::test(start_paused = true)]
// The env lock is held across awaits by design (env must stay stable).
#[allow(clippy::await_holding_lock)]
async fn a_credentialless_controller_retries_after_credentials_arrive() {
    let _env = env_lock();
    let _credentials = clear_trace_credentials();
    let fixture = Fixture::new();
    let mut settings = crate::settings::SettingsManager::create(&fixture.cwd, &fixture.agent_dir);
    settings.set_agent_traces_enabled(true).unwrap();
    // Deliberately no auth.json yet: the delivery fails closed, and the live
    // controller must schedule its own retry rather than park forever.
    let path = fixture.write_session("late-login.jsonl", "late-login");
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
    // Park so the controller really attempts at +1s against the missing
    // credentials before any write makes one deliverable.
    tokio::time::sleep(MIN_INTERVAL + DEBOUNCE * 2).await;
    std::fs::write(
        fixture.agent_dir.join("auth.json"),
        r#"{"prime-agent-traces":{"type":"api_key","key":"synthetic-only"}}"#,
    )
    .unwrap();
    let (_body, reply) = tokio::time::timeout(MIN_INTERVAL * 2, observed.recv())
        .await
        .expect("a credentialless delivery must retry after credentials arrive")
        .unwrap();
    reply.send(response(200, "{}")).unwrap();
    drop(c);
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_settings_change_after_load_still_records_the_write_intent() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("settings-race.jsonl", "settings-race");
    let c = controller(&fixture, &path, true);
    // A concurrent project edit changes the settings metadata after the
    // host captured its consent snapshot: removal is unambiguous.
    std::fs::remove_file(fixture.agent_dir.join("settings.json")).unwrap();
    c.persisted(&path);
    assert!(
        agent_trace_outbox_entry_path(&fixture.agent_dir, &path).exists(),
        "the write intent must stay durable across a concurrent settings edit"
    );
    // The worker re-reads consent before delivery; restore the opted-in edit.
    let mut settings = crate::settings::SettingsManager::create(&fixture.cwd, &fixture.agent_dir);
    settings.set_agent_traces_enabled(true).unwrap();
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
    let (_body, reply) = tokio::time::timeout(MIN_INTERVAL, observed.recv())
        .await
        .expect("the worker revalidates consent and delivers the retained intent")
        .unwrap();
    reply.send(response(200, "{}")).unwrap();
    drop(c);
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
// The env lock is held across awaits by design (env must stay stable).
#[allow(clippy::await_holding_lock)]
async fn missing_credentials_leave_the_sweep_incomplete_until_provided() {
    let _env = env_lock();
    let _credentials = clear_trace_credentials();
    let fixture = Fixture::new();
    let mut settings = crate::settings::SettingsManager::create(&fixture.cwd, &fixture.agent_dir);
    settings.set_agent_traces_enabled(true).unwrap();
    // Deliberately no auth.json yet: the upload must fail closed.
    let path = fixture.write_session("no-credentials.jsonl", "no-credentials");
    mark_pending(&fixture.agent_dir, &path).unwrap();
    let sink = Arc::new(ScriptedTraceHttp::new(vec![Ok(response(200, "{}"))]));
    assert!(
        !recover(
            fixture.cwd.clone(),
            fixture.agent_dir.clone(),
            Arc::new(tokio::sync::Semaphore::new(1)),
            sink.clone(),
            Some("http://synthetic.invalid".into()),
            TraceUploadCancel::new(),
        )
        .await,
        "missing credentials must keep the sweep incomplete so it re-arms"
    );
    std::fs::write(
        fixture.agent_dir.join("auth.json"),
        r#"{"prime-agent-traces":{"type":"api_key","key":"synthetic-only"}}"#,
    )
    .unwrap();
    assert!(
        recover(
            fixture.cwd.clone(),
            fixture.agent_dir.clone(),
            Arc::new(tokio::sync::Semaphore::new(1)),
            sink,
            Some("http://synthetic.invalid".into()),
            TraceUploadCancel::new(),
        )
        .await
    );
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        TraceUploadSignature::of(&path)
    );
}

#[tokio::test(start_paused = true)]
// Keep credential lookup stable across injected background I/O failures.
#[allow(clippy::await_holding_lock)]
async fn transient_recovery_reads_rearm_and_deliver_after_restoration() {
    let _env = env_lock();
    let _credentials = clear_trace_credentials();
    for stage in [
        RecoveryRead::Directory,
        RecoveryRead::Iteration,
        RecoveryRead::RecordMetadata,
        RecoveryRead::Record,
        RecoveryRead::SessionMetadata,
        RecoveryRead::Header,
    ] {
        let fixture = Fixture::new();
        enable_synthetic_fixture(&fixture);
        let path = fixture.write_session("transient.jsonl", "transient");
        mark_pending(&fixture.agent_dir, &path).unwrap();
        let sink = Arc::new(ScriptedTraceHttp::new(vec![Ok(response(200, "{}"))]));
        let (complete, _) = recover_with_io(
            fixture.cwd.clone(),
            fixture.agent_dir.clone(),
            Arc::new(tokio::sync::Semaphore::new(1)),
            sink.clone(),
            Some("http://synthetic.invalid".into()),
            TraceUploadCancel::new(),
            Some(Vec::new()),
            |read, _| {
                if read == stage {
                    Err(std::io::Error::from(std::io::ErrorKind::Interrupted))
                } else {
                    Ok(())
                }
            },
        )
        .await;
        assert!(!complete, "{stage:?} must keep recovery incomplete");
        assert!(agent_trace_outbox_entry_path(&fixture.agent_dir, &path).exists());
        assert_eq!(sink.request_count(), 0);
        assert!(
            recover(
                fixture.cwd.clone(),
                fixture.agent_dir.clone(),
                Arc::new(tokio::sync::Semaphore::new(1)),
                sink.clone(),
                Some("http://synthetic.invalid".into()),
                TraceUploadCancel::new(),
            )
            .await
        );
        assert_eq!(sink.request_count(), 1);
        assert_eq!(
            read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
            TraceUploadSignature::of(&path)
        );
    }
}

#[tokio::test(start_paused = true)]
async fn terminal_invalid_records_and_headers_complete_without_network_or_rescan() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let valid = fixture.write_session("valid.jsonl", "valid");
    let header = std::fs::read_to_string(&valid).unwrap();
    for (name, bytes) in [
        ("malformed", b"not a header\n".to_vec()),
        ("utf8", vec![0xff, b'\n']),
        ("empty", Vec::new()),
        (
            "oversized",
            [
                header.lines().next().unwrap().as_bytes(),
                &vec![b' '; 256 * 1024],
            ]
            .concat(),
        ),
    ] {
        let path = fixture.session_dir.join(format!("{name}.jsonl"));
        std::fs::write(&path, bytes).unwrap();
        mark_pending(&fixture.agent_dir, &path).unwrap();
    }
    let outbox = agent_trace_outbox_dir(&fixture.agent_dir);
    std::fs::write(outbox.join("invalid-utf8.json"), [0xff]).unwrap();
    std::fs::write(outbox.join("oversized.json"), vec![b' '; 64 * 1024 + 1]).unwrap();
    std::fs::write(outbox.join("malformed.json"), "{").unwrap();
    let sink = Arc::new(ScriptedTraceHttp::new(Vec::new()));
    let (complete, not_before) = recover_with_backoff(
        fixture.cwd.clone(),
        fixture.agent_dir.clone(),
        Arc::new(tokio::sync::Semaphore::new(1)),
        sink.clone(),
        Some("http://synthetic.invalid".into()),
        TraceUploadCancel::new(),
        Some(Vec::new()),
    )
    .await;
    assert_eq!((complete, not_before), (true, None));
    let state = std::sync::atomic::AtomicU8::new(1);
    settle_recovery_run(&state, complete, not_before, &TraceUploadCancel::new()).await;
    assert_eq!(state.load(Ordering::Acquire), 2);
    assert_eq!(sink.request_count(), 0);
}

#[tokio::test(start_paused = true)]
// The env lock is held across awaits to keep credential lookup deterministic.
#[allow(clippy::await_holding_lock)]
async fn bounded_admission_preserves_retirement_and_delivers_on_readmission() {
    let _env = env_lock();
    let _credentials = clear_trace_credentials();
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("admission.jsonl", "admission");
    mark_pending(&fixture.agent_dir, &path).unwrap();
    let service = Service {
        controllers: Mutex::new(Vec::new()),
        wake: tokio::sync::Notify::new(),
    };
    let mut hosts = Vec::new();
    for n in 0..MAX_CONTROLLERS {
        let host = controller(
            &fixture,
            &fixture.session_dir.join(format!("host-{n}.jsonl")),
            false,
        );
        assert!(service.register(&host));
        hosts.push(host);
    }
    let candidate = controller(&fixture, &path, true);
    assert!(!service.register(&candidate));
    assert_eq!(service.controllers.lock().unwrap().len(), MAX_CONTROLLERS);
    let mut recovered = RecoveryRuns::new();
    let run = RecoveryRun::new(hosts.iter().map(Arc::downgrade).collect());
    run.state.store(2, Ordering::Release);
    recovered.insert(fixture.agent_dir.clone(), run);
    drop(hosts.pop().unwrap());
    // Retirement cannot be discarded by foreground admission before replay sees it.
    assert!(!service.register(&candidate));
    let snapshot = service.controllers.lock().unwrap().clone();
    let retired = retain_live_recoveries(&mut recovered, &snapshot);
    assert!(recovered[&fixture.agent_dir]
        .replay_needed
        .load(Ordering::Acquire));
    assert_eq!(retired.len(), 1);
    acknowledge_retired_registrations(&mut service.controllers.lock().unwrap(), &retired);
    assert!(service.register(&candidate));
    assert_eq!(service.controllers.lock().unwrap().len(), MAX_CONTROLLERS);
    let (requests, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let sink = Arc::new(ObservedSink {
        requests,
        cancelled: Arc::new(tokio::sync::Notify::new()),
    });
    let task = tokio::spawn(run_controller(
        Arc::downgrade(&candidate),
        Arc::new(tokio::sync::Semaphore::new(1)),
        sink,
        Some("http://synthetic.invalid".into()),
    ));
    // Admission resumes the durable marker with no restart or fresh persist.
    let (_body, reply) = tokio::time::timeout(MIN_INTERVAL, observed.recv())
        .await
        .expect("readmitted controller must deliver existing intent")
        .unwrap();
    reply.send(response(200, "{}")).unwrap();
    drop(candidate);
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_busy_delivery_lease_does_not_hold_upload_capacity() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let leased = fixture.write_session("lease-wait.jsonl", "lease-wait");
    let free = fixture.write_session("lease-free.jsonl", "lease-free");
    let busy_host = controller(&fixture, &leased, true);
    busy_host.persisted(&leased);
    let lease = delivery_lease(&fixture.agent_dir, &leased).unwrap();
    let (requests, mut observed) = tokio::sync::mpsc::unbounded_channel();
    let sink = Arc::new(ObservedSink {
        requests,
        cancelled: Arc::new(tokio::sync::Notify::new()),
    });
    let permits = Arc::new(tokio::sync::Semaphore::new(1));
    let busy_task = tokio::spawn(run_controller(
        Arc::downgrade(&busy_host),
        permits.clone(),
        sink.clone(),
        Some("http://synthetic.invalid".into()),
    ));
    // The busy host's due (+1s) must strictly precede the free host's (+1.5s):
    // startup re-persists each deadline from its own spawn instant, so the
    // ordering is built from distinct spawn instants, never wake order.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let free_host = controller(&fixture, &free, true);
    free_host.persisted(&free);
    let free_task = tokio::spawn(run_controller(
        Arc::downgrade(&free_host),
        permits.clone(),
        sink,
        Some("http://synthetic.invalid".into()),
    ));
    // The busy host attempts the held lease at +1s and must release the shared
    // permit while it waits, or the free host only delivers at its +2s retry.
    let (body, reply) =
        tokio::time::timeout(DEBOUNCE + Duration::from_millis(250), observed.recv())
            .await
            .expect("a busy lease must not starve an unrelated delivery")
            .unwrap();
    assert!(
        body.contains("lease-free"),
        "the free session delivers first"
    );
    reply.send(response(200, "{}")).unwrap();
    drop(lease);
    let (body, reply) = tokio::time::timeout(MIN_INTERVAL, observed.recv())
        .await
        .expect("the leased session retries after the lease releases")
        .unwrap();
    assert!(body.contains("lease-wait"));
    reply.send(response(200, "{}")).unwrap();
    drop(busy_host);
    drop(free_host);
    busy_task.await.unwrap();
    free_task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn pending_live_owner_keeps_recovery_incomplete_until_retirement() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("live-retirement.jsonl", "live-retirement");
    mark_pending(&fixture.agent_dir, &path).unwrap();
    let c = controller(&fixture, &path, true);
    let weak = Arc::downgrade(&c);
    let sink = Arc::new(ScriptedTraceHttp::new(vec![]));
    let (complete, _) = recover_with_backoff(
        fixture.cwd.clone(),
        fixture.agent_dir.clone(),
        Arc::new(tokio::sync::Semaphore::new(1)),
        sink,
        Some("http://synthetic.invalid".into()),
        TraceUploadCancel::new(),
        Some(vec![weak]),
    )
    .await;
    assert!(!complete);
    drop(c);
    let sink = Arc::new(ScriptedTraceHttp::new(vec![Ok(response(200, "{}"))]));
    assert!(
        recover(
            fixture.cwd.clone(),
            fixture.agent_dir.clone(),
            Arc::new(tokio::sync::Semaphore::new(1)),
            sink,
            Some("http://synthetic.invalid".into()),
            TraceUploadCancel::new(),
        )
        .await
    );
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        TraceUploadSignature::of(&path)
    );
}

#[tokio::test(start_paused = true)]
async fn host_retirement_rearms_an_already_complete_group_for_later_markers() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let path = fixture.write_session("late-marker.jsonl", "late-marker");
    let c = controller(&fixture, &path, true);
    let another = controller(&fixture, &fixture.session_dir.join("survivor.jsonl"), true);
    let weak = Arc::downgrade(&c);
    let another_weak = Arc::downgrade(&another);
    let mut runs = RecoveryRuns::new();
    let run = RecoveryRun::new(vec![weak.clone(), another_weak.clone()]);
    run.state.store(2, Ordering::Release);
    runs.insert(fixture.agent_dir.clone(), run);
    let registration = Registration::of(&c);
    let another_registration = Registration::of(&another);
    c.persisted(&path);
    drop(c);
    let _ = retain_live_recoveries(&mut runs, &[registration, another_registration]);
    let run = runs.get(&fixture.agent_dir).unwrap();
    assert!(run.replay_needed.load(Ordering::Acquire));
    assert!(!run.cancel.is_cancelled());
    rearm_retired_recovery(run);
    assert_eq!(run.state.load(Ordering::Acquire), 1);
    tokio::task::yield_now().await;
    tokio::time::advance(MIN_INTERVAL).await;
    tokio::task::yield_now().await;
    assert_eq!(run.state.load(Ordering::Acquire), 0);
    let sink = Arc::new(ScriptedTraceHttp::new(vec![Ok(response(200, "{}"))]));
    assert!(
        recover(
            fixture.cwd.clone(),
            fixture.agent_dir.clone(),
            Arc::new(tokio::sync::Semaphore::new(1)),
            sink,
            Some("http://synthetic.invalid".into()),
            TraceUploadCancel::new(),
        )
        .await
    );
    assert_eq!(
        read_agent_trace_outbox_entry(&fixture.agent_dir, &path),
        TraceUploadSignature::of(&path)
    );
}

#[tokio::test(start_paused = true)]
async fn retirement_racing_completion_survives_and_preserves_the_retry_deadline() {
    let run = RecoveryRun::new(vec![]);
    run.state.store(1, Ordering::Release);
    let complete = !run.replay_needed.load(Ordering::Acquire);
    run.replay_needed.store(true, Ordering::Release);
    let deadline = Instant::now() + Duration::from_secs(120);
    *run.not_before.lock().unwrap() = Some(deadline);
    settle_recovery_run(&run.state, complete, Some(deadline), &run.cancel).await;
    assert_eq!(run.state.load(Ordering::Acquire), 2);
    rearm_retired_recovery(&run);
    rearm_retired_recovery(&run);
    assert_eq!(run.state.load(Ordering::Acquire), 1);
    tokio::task::yield_now().await;
    tokio::time::advance(MIN_INTERVAL).await;
    assert_eq!(run.state.load(Ordering::Acquire), 1);
    tokio::time::advance(MIN_INTERVAL).await;
    tokio::task::yield_now().await;
    assert_eq!(run.state.load(Ordering::Acquire), 0);
    assert!(
        run.replay_needed.load(Ordering::Acquire),
        "only a new sweep may clear retirement intent"
    );
}

#[tokio::test(start_paused = true)]
async fn between_tick_retirement_and_late_acknowledgement_preserve_pending_markers() {
    let fixture = Fixture::new();
    enable_synthetic_fixture(&fixture);
    let survivor = controller(&fixture, &fixture.session_dir.join("survivor.jsonl"), true);
    let run = RecoveryRun::new(vec![Arc::downgrade(&survivor)]);
    run.state.store(2, Ordering::Release);
    let mut runs = RecoveryRuns::new();
    runs.insert(fixture.agent_dir.clone(), run);
    let mut registrations = vec![Registration::of(&survivor)];
    let first_path = fixture.write_session("between-ticks.jsonl", "between-ticks");
    let first = controller(&fixture, &first_path, true);
    registrations.push(Registration::of(&first));
    first.persisted(&first_path);
    drop(first);
    let retired = retain_live_recoveries(&mut runs, &registrations);
    assert_eq!(retired.len(), 1);
    let second_path = fixture.write_session("after-snapshot.jsonl", "after-snapshot");
    let second = controller(&fixture, &second_path, true);
    registrations.push(Registration::of(&second));
    second.persisted(&second_path);
    drop(second);
    acknowledge_retired_registrations(&mut registrations, &retired);
    assert_eq!(
        registrations.len(),
        2,
        "a retirement after the snapshot must remain until the next tick"
    );
    let retired = retain_live_recoveries(&mut runs, &registrations);
    assert_eq!(retired.len(), 1);
    acknowledge_retired_registrations(&mut registrations, &retired);
    assert_eq!(registrations.len(), 1);
    let run = runs.get(&fixture.agent_dir).unwrap();
    assert!(run.replay_needed.load(Ordering::Acquire));
    rearm_retired_recovery(run);
    tokio::task::yield_now().await;
    tokio::time::advance(MIN_INTERVAL).await;
    tokio::task::yield_now().await;
    assert_eq!(run.state.load(Ordering::Acquire), 0);
    let sink = Arc::new(ScriptedTraceHttp::new(vec![
        Ok(response(200, "{}")),
        Ok(response(200, "{}")),
    ]));
    assert!(
        recover(
            fixture.cwd.clone(),
            fixture.agent_dir.clone(),
            Arc::new(tokio::sync::Semaphore::new(1)),
            sink,
            Some("http://synthetic.invalid".into()),
            TraceUploadCancel::new(),
        )
        .await
    );
    for path in [&first_path, &second_path] {
        assert_eq!(
            read_agent_trace_outbox_entry(&fixture.agent_dir, path),
            TraceUploadSignature::of(path)
        );
    }
}
