use super::*;
use crate::agent_traces::tests::{response, Fixture, ScriptedTraceHttp};

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

#[test]
#[ignore = "remote performance measurement; never run on the loaded laptop"]
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
    println!(
        "{}",
        json!({"samples":1000,"cold_marker_ns":{"p50":cold[500],"p95":cold[950],"p99":cold[990]},"warm_marker_ns":{"p50":warm[500],"p95":warm[950],"p99":warm[990]},"fsync":false,"consent_metadata_checks_included":true})
    );
}
