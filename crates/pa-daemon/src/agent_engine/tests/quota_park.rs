//! The quota-park tests (the park entry/wake durability, resume/retire clearing).
use super::*;

/// An engine with the quota-park seams live: the worker cron wiring
/// (store + binding + scheduler-less mutation hook), the supervisor
/// link the binding resolves, and a session file whose header names
/// the durable session id.
fn park_engine(dir: &std::path::Path) -> AgentSessionEngine {
    std::fs::create_dir_all(dir.join("agent")).unwrap();
    let session_file = dir.join("session.jsonl");
    std::fs::write(
        &session_file,
        format!(
            "{}\n",
            serde_json::json!({
                "type": "session",
                "version": 3,
                "id": "park-session",
                "timestamp": "2026-01-01T00:00:00.000Z",
                "cwd": dir.display().to_string(),
            })
        ),
    )
    .unwrap();
    let store =
        std::sync::Arc::new(pa_core::cron::store::AgentCronJobStore::for_session_artifacts());
    store.register_session_artifact("park-session", &dir.join("artifacts"));
    let cron_store = pa_core::session_engine::runtime_wiring::KernelCronWiring {
        store: std::sync::Arc::clone(&store),
        binding: None,
        mutation_hook: None,
    };
    AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.to_path_buf(),
        agent_dir: dir.join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: Some(session_file),
        faux_script: None,
        supervisor_link: Some(SupervisorLinkConfig {
            socket_path: dir.join("supervisor.sock"),
            active_session_id: "active-park".to_string(),
            worker_token: "token".to_string(),
        }),
        telemetry_disabled: None,
        cron_store: Some(cron_store),
        queued_steering_probe: None,
    })
    .unwrap()
}

fn quota_failure_message(
    kind: Option<&str>,
    retry_after_ms: Option<u64>,
) -> pa_agent::types::AssistantMessage {
    let details = serde_json::json!({
        "kind": kind,
        "retryAfterMs": retry_after_ms,
    });
    pa_agent::types::AssistantMessage {
        content: vec![],
        api: "openai-completions".to_string(),
        provider: "battery".to_string(),
        model: "mock-1".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: Some(vec![pa_agent::types::AssistantMessageDiagnostic {
            kind: "provider_stream_failure".to_string(),
            timestamp: 0,
            error: None,
            details: Some(details),
        }]),
        usage: pa_agent::types::Usage::zero(),
        stop_reason: pa_agent::types::StopReason::Error,
        stop_reason_raw: None,
        error_message: Some("You have hit your usage limit".to_string()),
        timestamp: 0,
    }
}

/// The park entry appender's write-failure propagation (the
/// persist-or-decline plumbing the park-arming arms guard with): a
/// PERSISTING session manager whose file becomes a directory fails the
/// append at the write stage (EISDIR, root included — a mode-based
/// injection would not stop root), and the `io::Result` reaches the
/// caller — the arming arms' decline gate consumes exactly this Err.
///
/// The daemon worker's INSTALLED engine session stays non-persisted
/// (`in_memory_in_session_dir`: the worker owns the durable file and
/// mirrors the entries), so its appends answer `Ok` and the park
/// proceeds unchanged; this `Err` path is the persisted-manager
/// contract the gate exists for.
#[tokio::test]
async fn a_failed_park_entry_write_propagates_to_the_caller() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let session_file = dir.path().join("session.jsonl");
    // A persisting manager over the session file (open repairs + pins
    // the durable path).
    let handle = std::sync::Arc::new(tokio::sync::Mutex::new(
        pa_core::session::manager::SessionManager::open(dir.path(), dir.path(), &session_file),
    ));
    // Seed the first assistant entry: custom appends before it defer
    // (the pre-first-assistant buffer, TS parity), so the park entry
    // must land after one to flush at all.
    handle
        .lock()
        .await
        .append_message(pa_types::session::AgentMessage::Assistant(
            pa_types::ai::AssistantMessage {
                content: vec![pa_types::ai::AssistantContentBlock::Text(
                    pa_types::ai::TextContent {
                        text: "seed".to_string(),
                        text_signature: None,
                        rest: Map::default(),
                    },
                )],
                api: "faux".to_string(),
                provider: "faux".to_string(),
                model: "faux-1".to_string(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: pa_types::ai::Usage::default(),
                stop_reason: pa_types::ai::StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: 2,
                rest: Map::default(),
            },
        ))
        .expect("the assistant seed persists");
    // Break the durable write: the session file becomes a directory.
    std::fs::remove_file(&session_file).expect("remove the session file");
    std::fs::create_dir(&session_file).expect("block the session file path");
    let result = engine
        .append_quota_park_entry(
            Some(handle),
            crate::util::now_ms() + 30_000,
            1,
            Some("job-1"),
            Some("battery"),
        )
        .await;
    assert!(
        result.is_err(),
        "a failed durable write must propagate to the park-arming gate"
    );
}

/// A quota failure whose reported reset exceeds the wait cap parks the
/// session: the surfaced status names the wake, the state counts the
/// park, and the durable wake job lands in the session's artifacts.
#[tokio::test]
async fn quota_failure_beyond_cap_parks_with_a_durable_wake() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let message = quota_failure_message(Some("rate_limit"), Some(3_600_000));
    // Captured BEFORE the park call: the slack assertion measures against
    // the pre-park clock, so test-process delay can only widen the slack
    // (the park's own resume_at already includes the grace from its
    // later now_ms), never shrink it under the window's lower bound.
    let before_park_ms = crate::util::now_ms();
    let outcome = engine
            .park_for_quota_reset(
                &message,
                "Provider requested a 3600s wait before retrying (above retry.provider.maxRetryDelayMs=60000ms)",
            )
            .await
            .expect("the park fires");
    assert!(
        outcome.status_message.contains("Session parked until ")
            && outcome.status_message.contains(
                "and will resume automatically (retry.provider.waitForUsage.pauseUntilReset)"
            )
    );
    assert!(engine.is_quota_parked());
    let park = engine
        .quota_park
        .lock()
        .expect("park state")
        .clone()
        .expect("parked");
    assert_eq!(park.park_count, 1);
    let job_id = park.job_id.expect("the wake job id");
    let store = engine.config.cron_store.as_ref().expect("wiring").clone();
    let job = store
        .store
        .list()
        .into_iter()
        .find(|job| job.id == job_id)
        .expect("the durable wake job");
    assert_eq!(
        job.label.as_deref(),
        Some("quota-resume"),
        "the wake carries the quota-resume label"
    );
    assert_eq!(
        job.prompt,
        pa_core::session_engine::provider_park::QUOTA_RESUME_MARKER_TEXT
    );
    assert_eq!(job.schedule.kind, pa_core::cron::ScheduleKind::Once);
    assert_eq!(job.active_session_id, "active-park");
    assert_eq!(job.session_id, "park-session");
    // The wake sits ~30s past the reported reset (the grace).
    let resume_slack = park.resume_at_ms as i64 - (before_park_ms as i64 + 3_600_000);
    assert!(
        (25_000..=40_000).contains(&resume_slack),
        "resume slack {resume_slack}"
    );
}

/// A repeat quota failure while the wake is still armed is a no-op: no
/// new park, no new wake, the already-parked status surfaces.
#[tokio::test]
async fn repeat_failure_while_parked_keeps_the_scheduled_wake() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let message = quota_failure_message(Some("rate_limit"), Some(3_600_000));
    let first = engine
        .park_for_quota_reset(&message, "abort sentence")
        .await
        .expect("the first park fires");
    assert!(first.status_message.contains("Session parked until"));
    let before = engine
        .quota_park
        .lock()
        .expect("park state")
        .clone()
        .expect("parked");
    let second = engine
        .park_for_quota_reset(&message, "abort sentence")
        .await
        .expect("the already-parked arm surfaces");
    assert!(
        second
            .status_message
            .starts_with("Session is parked until ")
            && second
                .status_message
                .contains("this turn ended without a retry"),
        "the already-parked wording surfaces: {second:?}"
    );
    let after = engine
        .quota_park
        .lock()
        .expect("park state")
        .clone()
        .expect("still parked");
    assert_eq!(before.job_id, after.job_id, "the wake is not rescheduled");
    assert_eq!(after.park_count, 1, "the repeat consumes no park");
    let store = engine.config.cron_store.as_ref().expect("wiring").clone();
    assert_eq!(store.store.list().len(), 1, "no second wake job is created");
}

/// Non-quota failures never park, and a quota failure without a
/// reported reset keeps the abort (a blind park would guess a wake).
#[tokio::test]
async fn non_quota_and_no_reset_failures_do_not_park() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let non_quota = quota_failure_message(Some("server_error"), Some(3_600_000));
    assert!(engine
        .park_for_quota_reset(&non_quota, "abort")
        .await
        .is_none());
    let no_reset = quota_failure_message(Some("rate_limit"), None);
    assert!(engine
        .park_for_quota_reset(&no_reset, "abort")
        .await
        .is_none());
    assert!(!engine.is_quota_parked());
}

/// A spent park budget ends the episode: the stale park clears and
/// the give-up stands (the goal fails like the bounded wait it
/// replaced).
#[tokio::test]
async fn spent_park_budget_clears_the_stale_park() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    // Arm a wake, then age the park state past its wake time: the
    // budget check runs against a wake that already fired (the
    // store only accepts future one-shots; the state is what the
    // consumed-wake paths read).
    let fired_job_id = engine
        .create_quota_resume_job(crate::util::now_ms() + 60_000)
        .await
        .expect("wake job");
    *engine.quota_park.lock().expect("park state") = Some(QuotaParkState {
        park_count: engine.park_policy().max_parks,
        resume_at_ms: crate::util::now_ms() - 60_000,
        job_id: Some(fired_job_id),
        wake_retries: 0,
    });
    let message = quota_failure_message(Some("rate_limit"), Some(3_600_000));
    assert!(
        engine
            .park_for_quota_reset(&message, "abort")
            .await
            .is_none(),
        "the spent budget declines the park"
    );
    assert!(
        !engine.is_quota_parked(),
        "the stale park clears when the episode ends"
    );
}

/// The wake fired but its probe failed with no new reset: the bounded
/// re-arm probes again instead of parking forever.
#[tokio::test]
async fn consumed_wake_without_reset_re_arms_bounded() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let fired_job_id = engine
        .create_quota_resume_job(crate::util::now_ms() + 60_000)
        .await
        .expect("wake job");
    *engine.quota_park.lock().expect("park state") = Some(QuotaParkState {
        park_count: 1,
        resume_at_ms: crate::util::now_ms() - 60_000,
        job_id: Some(fired_job_id),
        wake_retries: 0,
    });
    let no_reset = quota_failure_message(Some("rate_limit"), None);
    let outcome = engine
        .park_for_quota_reset(&no_reset, "abort")
        .await
        .expect("the re-arm fires");
    assert!(outcome
        .status_message
        .starts_with("Session is parked until "));
    let park = engine
        .quota_park
        .lock()
        .expect("park state")
        .clone()
        .expect("re-armed");
    assert_eq!(park.park_count, 1, "the re-arm consumes no park");
    assert_eq!(park.wake_retries, 1);
    let store = engine.config.cron_store.as_ref().expect("wiring").clone();
    assert_eq!(
        store.store.list().len(),
        2,
        "the re-arm creates a replacement wake"
    );
    // Spend the re-arm budget: the park drops and the give-up stands.
    *engine.quota_park.lock().expect("park state") = Some(QuotaParkState {
        park_count: park.park_count,
        resume_at_ms: crate::util::now_ms() - 60_000,
        job_id: park.job_id,
        wake_retries: QUOTA_WAKE_MAX_RETRIES,
    });
    assert!(
        engine
            .park_for_quota_reset(&no_reset, "abort")
            .await
            .is_none(),
        "the spent re-arm budget drops the park"
    );
    assert!(!engine.is_quota_parked());
}

/// The replacement teardown ends the retired session's park with it:
/// the state clears so an unparked replacement is never reported
/// quota-parked (the replacement build restores whatever its own
/// branch says).
#[tokio::test]
async fn retire_session_runtime_clears_the_live_park() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let message = quota_failure_message(Some("rate_limit"), Some(3_600_000));
    engine
        .park_for_quota_reset(&message, "abort")
        .await
        .expect("the park fires");
    assert!(engine.is_quota_parked());
    engine.retire_session_runtime().await;
    assert!(
        !engine.is_quota_parked(),
        "the retired session's park ends with it"
    );
}

/// A parked session that completes a model call resumes: the park
/// clears, the pending wake cancels, and an early success queues the
/// resume marker (the wake probe's success must not).
#[tokio::test]
async fn early_resume_clears_the_park_and_cancels_the_wake() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = park_engine(dir.path());
    let message = quota_failure_message(Some("rate_limit"), Some(3_600_000));
    engine
        .park_for_quota_reset(&message, "abort")
        .await
        .expect("the park fires");
    let job_id = engine
        .quota_park
        .lock()
        .expect("park state")
        .clone()
        .expect("parked")
        .job_id
        .expect("wake");
    let store = engine.config.cron_store.as_ref().expect("wiring").clone();
    assert_eq!(store.store.list().len(), 1);
    engine.resume_quota_park(false).await;
    assert!(!engine.is_quota_parked(), "the park clears on resume");
    let job = store
        .store
        .list()
        .into_iter()
        .find(|job| job.id == job_id)
        .expect("the wake job still exists");
    assert_eq!(
        job.status,
        pa_core::cron::JobStatus::Cancelled,
        "the pending wake cancels on resume"
    );
}

// --- cold-open-residual oracles: the persisted depth scan and the shared
// --- window goal seed (P2b/P3/P4). Both differential tests pin the new
// --- fast paths against the reference readers over fixture classes.
