//! The digest inbox lane's worker-level tests (swarm PRs C/D/E): the
//! delivery routing (push default, digest on the lane, parent bypass), the
//! one-per-batch notice, the read state, the pin, and the digest-aware
//! watch notice routing.
use super::*;

fn test_worker() -> Arc<Worker> {
    let dir = std::env::temp_dir().join(format!("pa-worker-digest-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = WorkerConfig {
        socket_path: dir.join("worker.sock"),
        supervisor_socket_path: PathBuf::new(),
        token: "token".to_string(),
        worker_instance_id: String::new(),
        active_session_id: "target-session".to_string(),
        agent_dir: dir.join("agent"),
        recovery_journal_path: dir.join("recovery.jsonl"),
        telemetry_disabled: None,
        script: Some(json!({ "responses": ["ack"] })),
    };
    Arc::new(Worker::new(config, None))
}

async fn created_worker() -> Arc<Worker> {
    let worker = test_worker();
    let created = worker
        .dispatch(
            "create",
            &json!({ "noSession": true, "cwd": "/tmp", "name": "target" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    worker
}

fn queue_texts(core: &Mutex<SessionCore>, lane: Lane) -> Vec<String> {
    let core = core.lock().unwrap();
    core_lane_items(&core, lane)
        .iter()
        .map(|item| item.message.clone())
        .collect()
}

fn sibling_sender() -> Value {
    json!({
        "activeSessionId": "source-session",
        "sessionId": "source-file",
        "sessionName": "source-agent",
        "runtimeKind": "top-level",
        "clientId": "cli-1",
    })
}

/// Deliver one agent message from the sibling sender and answer the receipt.
async fn deliver(worker: &Arc<Worker>, message: &str) -> Value {
    let response = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": worker.config.active_session_id,
                "message": message,
                "sender": sibling_sender(),
            }),
        )
        .await;
    assert!(response.success, "deliver failed: {response:?}");
    response.data.expect("receipt data")
}

/// The custom row types currently parked on a lane (diagnostics for the
/// coalescing and routing assertions).
fn lane_custom_types(core: &Mutex<SessionCore>, lane: Lane) -> Vec<String> {
    let core = core.lock().unwrap();
    core_lane_items(&core, lane)
        .iter()
        .map(|item| {
            item.custom_message
                .as_ref()
                .and_then(|row| row.get("customType"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        })
        .collect()
}

fn core_lane_items(core: &SessionCore, lane: Lane) -> Vec<&QueuedItem> {
    match lane {
        Lane::Steering => core.steering.iter().collect(),
        Lane::FollowUp => core.follow_up.iter().collect(),
    }
}

/// Park the turn runner (an input-pause lease holds the queue) so the
/// queue-lane and notice assertions are deterministic.
async fn park_runner(worker: &Arc<Worker>) {
    let response = worker
        .dispatch(
            "acquire_session_input_pause",
            &json!({ "leaseKey": "digest-tests" }),
        )
        .await;
    assert!(response.success, "pause failed: {response:?}");
}

/// Default off: an inbound agent message delivers on the push lane with the
/// exact current flow, and the inbox stays empty.
#[tokio::test]
async fn digest_lane_is_off_by_default_and_delivers_push() {
    let worker = created_worker().await;
    park_runner(&worker).await;
    let receipt = deliver(&worker, "pushed").await;
    assert_eq!(receipt["deliveryStatus"], "delivered");
    assert!(
        receipt.get("digestAt").is_none(),
        "digestAt on push: {receipt}"
    );
    assert!(receipt["deliveredAt"].as_str().is_some());
    assert_eq!(
        queue_texts(&worker.core, Lane::Steering),
        vec!["[agent-message from source-agent]\n\npushed"]
    );
    let snapshot = worker.agent_digest.inbox_snapshot();
    assert_eq!(snapshot["total"], json!(0));
    assert_eq!(snapshot["unread"], json!(0));
}

/// The pinned digest lane: the payload never prompts (no steering row, no
/// rendered prompt), the receipt answers `digest` + `digestAt`, the entry
/// lands in the durable inbox, and one coalesced notice wakes the session.
#[tokio::test]
async fn pinned_digest_lane_digests_messages_with_one_coalesced_notice() {
    let worker = created_worker().await;
    park_runner(&worker).await;
    let pin = worker.agent_digest.configure_pin("digest").unwrap();
    assert_eq!(pin["digest"], json!(true));
    assert_eq!(pin["pinned"], json!(true));

    let first = deliver(&worker, "REPORT 481").await;
    assert_eq!(first["deliveryStatus"], "digest");
    assert!(first["digestAt"].as_str().is_some(), "digestAt: {first}");
    assert!(first["id"].as_str().unwrap().starts_with("agentmsg_"));
    assert_eq!(first["target"]["activeSessionId"], "target-session");
    assert_eq!(first["from"]["sessionName"], "source-agent");

    let second = deliver(&worker, "REPORT 482").await;
    assert_eq!(second["deliveryStatus"], "digest");

    // The payloads never queued a prompt anywhere: the only parked row is
    // the ONE digest notice (the batch coalesces).
    assert!(queue_texts(&worker.core, Lane::Steering).is_empty());
    let notice_types = lane_custom_types(&worker.core, Lane::FollowUp);
    assert_eq!(
        notice_types,
        vec!["agent_message_digest_notice"],
        "follow-up lane"
    );
    let notice = {
        let core = worker.core.lock().unwrap();
        core.follow_up.front().expect("notice").message.clone()
    };
    // The one live notice's text is a snapshot of its batch (TS: one live
    // notice covers the batch; later arrivals wait for the read).
    assert!(notice.contains("1 unread inbox item"), "notice: {notice}");
    assert!(notice.contains("source-agent"));

    let snapshot = worker.agent_digest.inbox_snapshot();
    assert_eq!(snapshot["unread"], json!(2));
    assert_eq!(snapshot["total"], json!(2));
    assert_eq!(snapshot["entries"][0]["content"], json!("REPORT 481"));
    assert_eq!(snapshot["entries"][1]["content"], json!("REPORT 482"));
    assert_eq!(snapshot["entries"][0]["fromRelationship"], json!("sibling"));
}

/// Parent-to-child instructions always stay push — the hard boundary of the
/// lane, even with the digest lane enabled.
#[tokio::test]
async fn parent_instructions_bypass_digest_even_when_enabled() {
    let worker = created_worker().await;
    park_runner(&worker).await;
    {
        let mut core = worker.core.lock().unwrap();
        core.parent_active_session_id = Some("parent-active".to_string());
    }
    worker.agent_digest.configure_pin("digest").unwrap();
    let receipt = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": worker.config.active_session_id,
                "message": "instruction from parent",
                "sender": {
                    "activeSessionId": "parent-active",
                    "sessionName": "parent",
                },
            }),
        )
        .await;
    assert!(receipt.success, "deliver failed: {receipt:?}");
    let data = receipt.data.expect("receipt");
    assert_eq!(data["deliveryStatus"], "delivered");
    assert_eq!(
        lane_custom_types(&worker.core, Lane::Steering),
        vec!["agent_message"],
        "the delivered agent-message row queues on the push lane"
    );
    assert!(lane_custom_types(&worker.core, Lane::FollowUp).is_empty());
    assert_eq!(worker.agent_digest.inbox_snapshot()["total"], json!(0));
}

/// Reading the inbox marks entries read durably and cancels a still-pending
/// notice once everything is read.
#[tokio::test]
async fn read_inbox_marks_read_and_cancels_the_pending_notice() {
    let worker = created_worker().await;
    park_runner(&worker).await;
    worker.agent_digest.configure_pin("digest").unwrap();
    deliver(&worker, "REPORT 777").await;
    assert_eq!(
        lane_custom_types(&worker.core, Lane::FollowUp),
        vec!["agent_message_digest_notice"]
    );

    let read = worker.agent_digest.read_inbox(None).unwrap();
    assert_eq!(read["unread"], json!(0));
    assert!(read["entries"][0]["read"].as_bool().unwrap());
    assert_eq!(read["entries"][0]["content"], json!("REPORT 777"));
    // The pending notice withdrew: a read-before-delivery wake cancels.
    assert!(lane_custom_types(&worker.core, Lane::FollowUp).is_empty());
    let snapshot = worker.agent_digest.inbox_snapshot();
    assert_eq!(snapshot["unread"], json!(0));
    assert_eq!(snapshot["entries"][0]["read"], json!(true));
}

/// `read(ids)` reads only the requested entries; unknown ids are ignored.
#[tokio::test]
async fn read_inbox_with_ids_reads_only_those_entries() {
    let worker = created_worker().await;
    park_runner(&worker).await;
    worker.agent_digest.configure_pin("digest").unwrap();
    deliver(&worker, "one").await;
    deliver(&worker, "two").await;
    let first_id = worker.agent_digest.inbox_snapshot()["entries"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let read = worker
        .agent_digest
        .read_inbox(Some(vec![first_id]))
        .unwrap();
    assert_eq!(read["entries"].as_array().unwrap().len(), 1);
    assert_eq!(read["unread"], json!(1));
    let unknown = worker
        .agent_digest
        .read_inbox(Some(vec!["not-an-id".to_string()]))
        .unwrap();
    assert_eq!(unknown["entries"].as_array().unwrap().len(), 0);
    assert_eq!(unknown["unread"], json!(1));
}

/// The pin contract: invalid modes rejected, push/digest fix the lane, auto
/// returns control to the controller.
#[tokio::test]
async fn configure_pin_rejects_invalid_modes_and_pins_both_lanes() {
    let worker = created_worker().await;
    park_runner(&worker).await;
    let error = worker.agent_digest.configure_pin("sideways").unwrap_err();
    assert!(error.to_string().contains("must be"), "{error}");

    let pinned = worker.agent_digest.configure_pin("digest").unwrap();
    assert_eq!(
        pinned,
        json!({ "mode": "digest", "pinned": true, "digest": true })
    );
    let receipt = deliver(&worker, "digested").await;
    assert_eq!(receipt["deliveryStatus"], "digest");

    let pinned = worker.agent_digest.configure_pin("push").unwrap();
    assert_eq!(pinned["digest"], json!(false));
    let receipt = deliver(&worker, "pushed").await;
    assert_eq!(receipt["deliveryStatus"], "delivered");

    let auto = worker.agent_digest.configure_pin("auto").unwrap();
    assert_eq!(
        auto,
        json!({ "mode": "auto", "pinned": false, "digest": false })
    );
}

/// The daemon-side controller: a session armed with the auto pin and
/// crossed counters flips to digest (the ingestion-turn share crosses once
/// scripted turns run — every delivered agent message turn is an ingestion
/// turn), and a push-pinned session is never flipped. The controller ships
/// DORMANT: the default pin is push, so `configure("auto")` is the arm
/// step.
#[tokio::test]
async fn controller_flips_armed_sessions_but_never_push_pinned_ones() {
    let worker = created_worker().await;
    let pin = worker.agent_digest.configure_pin("auto").unwrap();
    assert_eq!(
        pin,
        json!({ "mode": "auto", "pinned": false, "digest": false })
    );
    // NOT parked: the runner must run turns so the ingestion-turn share
    // crosses the pre-registered trigger. A bounded wall-clock deadline
    // (not a fixed delivery count) absorbs a slow runner.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    let mut digested = 0;
    let mut index = 0;
    while std::time::Instant::now() < deadline {
        let receipt = deliver(&worker, &format!("burst {index}")).await;
        index += 1;
        if receipt["deliveryStatus"] == "digest" {
            digested += 1;
            break;
        }
        // Let the runner settle the turn so the counters advance.
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(digested > 0, "the armed controller never flipped the lane");

    // The dormant default: an untouched session never flips (the
    // established parent-child reply protocol keeps the push lane).
    let worker = created_worker().await;
    for index in 0..8 {
        let receipt = deliver(&worker, &format!("dormant {index}")).await;
        assert_eq!(receipt["deliveryStatus"], "delivered");
    }
    assert_eq!(worker.agent_digest.inbox_snapshot()["total"], json!(0));

    // A push-pinned session never flips: no crossed counter can digest a
    // delivery.
    let worker = created_worker().await;
    park_runner(&worker).await;
    worker.agent_digest.configure_pin("push").unwrap();
    for index in 0..8 {
        let receipt = deliver(&worker, &format!("held {index}")).await;
        assert_eq!(receipt["deliveryStatus"], "delivered");
    }
    assert_eq!(worker.agent_digest.inbox_snapshot()["total"], json!(0));
}

/// The push lane's arrival pressure feeds the controller only through
/// ACCEPTED deliveries: a burst of parked push deliveries (each accepted at
/// its enqueue) crosses the pending-EMA trigger and flips an auto-armed
/// session, while retries against a FULL queue record nothing — a rejected
/// attempt must never pin the lane on digest (the pre-fix recording flipped
/// the lane mid-retry, so later attempts digested into the already-full
/// session instead of answering the capacity error). The parked runner
/// keeps every trigger input at the pending ring (no turns run, so the
/// ingestion shares stay unmeasured).
#[tokio::test]
async fn accepted_push_pressure_flips_an_auto_session_rejections_never_pin_it() {
    // Accepted pressure flips: every delivered message parks as live work
    // and records its arrival at the enqueue.
    let worker = created_worker().await;
    park_runner(&worker).await;
    worker.agent_digest.configure_pin("auto").unwrap();
    let mut flipped = false;
    for index in 0..20 {
        let receipt = deliver(&worker, &format!("pressure {index}")).await;
        if receipt["deliveryStatus"] == "digest" {
            flipped = true;
            break;
        }
        assert_eq!(
            receipt["deliveryStatus"], "delivered",
            "attempt {index}: {receipt:?}"
        );
    }
    assert!(flipped, "the accepted arrivals never flipped the lane");

    // Rejected pressure does not: a full queue refuses every further
    // delivery, and the refusals must not record arrivals — the lane
    // never flips, so every attempt keeps answering the queue-capacity
    // error.
    let worker = created_worker().await;
    park_runner(&worker).await;
    {
        let mut core = worker.core.lock().unwrap();
        for _ in 0..DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION {
            core.follow_up.push_back(QueuedItem {
                priority: QueuePriority::Human,
                preview: None,
                message: "occupied".to_string(),
                custom_message: None,
                agent_message: None,
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Injected,
                forced_batch: false,
            });
        }
    }
    worker.agent_digest.configure_pin("auto").unwrap();
    for index in 0..12 {
        let response = worker
            .dispatch(
                "worker_deliver_message",
                &json!({
                    "targetActiveSessionId": worker.config.active_session_id,
                    "message": format!("retry {index}"),
                    "sender": sibling_sender(),
                }),
            )
            .await;
        assert!(
            !response.success,
            "the capped attempt {index} admitted: {response:?}"
        );
        assert!(
            response
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("unfinished"),
            "attempt {index} left the queue-capacity error: {response:?}"
        );
    }
}

/// Watch notices on the push lane: the quiet `agent_watch_notice` row rides
/// the steering lane (queue-if-busy, resume-if-idle), never the inbox.
#[tokio::test]
async fn watch_notice_on_the_push_lane_injects_the_quiet_row() {
    let worker = created_worker().await;
    park_runner(&worker).await;
    worker.agent_digest.emit_watch_notice(
        "job",
        "[watch-job pid:99] output +400 bytes (0..400) command: tail -f",
    );
    assert_eq!(
        lane_custom_types(&worker.core, Lane::Steering),
        vec!["agent_watch_notice"]
    );
    let (message, queue_visible) = {
        let core = worker.core.lock().unwrap();
        let item = core.steering.front().expect("watch notice");
        (item.message.clone(), item.queue_visible)
    };
    assert!(!queue_visible, "the watch notice stays invisible");
    assert!(message.contains("[watch-job pid:99] output +400 bytes (0..400)"));
    assert!(lane_custom_types(&worker.core, Lane::FollowUp).is_empty());
    assert_eq!(worker.agent_digest.inbox_snapshot()["total"], json!(0));
}

/// Watch notices on the digest lane: the event lands in the inbox as a
/// `watch`-kinded entry and the same coalesced notice wakes the session.
#[tokio::test]
async fn watch_notice_on_the_digest_lane_lands_an_inbox_entry() {
    let worker = created_worker().await;
    park_runner(&worker).await;
    worker.agent_digest.configure_pin("digest").unwrap();
    worker
        .agent_digest
        .emit_watch_notice("agent", "[watch-agent child:c1] messages 3..7 (+4)");
    let snapshot = worker.agent_digest.inbox_snapshot();
    assert_eq!(snapshot["unread"], json!(1));
    assert_eq!(snapshot["entries"][0]["kind"], json!("watch"));
    assert_eq!(snapshot["entries"][0]["watch"], json!("agent"));
    assert_eq!(
        snapshot["entries"][0]["content"],
        json!("[watch-agent child:c1] messages 3..7 (+4)")
    );
    assert_eq!(
        lane_custom_types(&worker.core, Lane::FollowUp),
        vec!["agent_message_digest_notice"]
    );
}

/// The inbox admission cap: unread entries stop at the push lane's
/// pending-message bound — the digested backlog never grows the durable
/// session file without bound, and the refusal answers the same capacity
/// error shape as the push lane.
#[tokio::test]
async fn digest_inbox_enforces_an_admission_cap_on_unread_entries() {
    let worker = created_worker().await;
    park_runner(&worker).await;
    worker.agent_digest.configure_pin("digest").unwrap();
    for index in 0..DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION {
        let receipt = deliver(&worker, &format!("capped {index}")).await;
        assert_eq!(receipt["deliveryStatus"], "digest");
    }
    let response = worker
        .dispatch(
            "worker_deliver_message",
            &json!({
                "targetActiveSessionId": worker.config.active_session_id,
                "message": "over the cap",
                "sender": sibling_sender(),
            }),
        )
        .await;
    assert!(
        !response.success,
        "over-cap delivery admitted: {response:?}"
    );
    assert!(
        response
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("too many pending messages"),
        "error: {response:?}"
    );
    let snapshot = worker.agent_digest.inbox_snapshot();
    assert_eq!(
        snapshot["unread"],
        json!(DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION)
    );
}

/// A failed durable append refuses the delivery (TS
/// `appendCustomEntryWithRollback` throws): the digested message reaches
/// the session file before the receipt answers `digest`, so a restart
/// never silently loses it.
#[tokio::test]
async fn digest_delivery_fails_loudly_when_the_durable_append_fails() {
    let dir = tempfile::TempDir::new().unwrap();
    let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
    // A directory as the session-file path: every append fails.
    store.set_path(dir.path().to_path_buf());
    let core = Arc::new(Mutex::new(SessionCore {
        store: Some(store),
        ..SessionCore::test_core(None, "/tmp".to_string())
    }));
    let digest = AgentMessageDigest::new(core, Arc::new(Mutex::new(None)), Arc::new(Notify::new()));
    digest.configure_pin("digest").unwrap();
    let error = digest
        .route_inbound_message(
            "agentmsg_cap",
            "this must not silently digest",
            &json!({ "activeSessionId": "sender", "sessionName": "sender" }),
            Some("sibling"),
        )
        .expect_err("the failed durable append answered success");
    assert!(
        error.to_string().contains("failed") || !error.to_string().is_empty(),
        "{error}"
    );
    assert_eq!(digest.inbox_snapshot()["total"], json!(0));
}

/// Watch events respect the same admission cap: at a full inbox the
/// advisory range event is dropped quietly instead of growing the durable
/// session file past the bound.
#[tokio::test]
async fn watch_events_respect_the_inbox_admission_cap() {
    let worker = created_worker().await;
    park_runner(&worker).await;
    worker.agent_digest.configure_pin("digest").unwrap();
    for index in 0..DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION {
        deliver(&worker, &format!("capped {index}")).await;
    }
    let total = worker.agent_digest.inbox_snapshot()["total"]
        .as_u64()
        .unwrap();
    worker
        .agent_digest
        .emit_watch_notice("agent", "[watch-agent child:c1] messages 3..7 (+4)");
    let snapshot = worker.agent_digest.inbox_snapshot();
    assert_eq!(
        snapshot["total"],
        json!(total),
        "the capped watch event landed"
    );
    assert!(snapshot["entries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["kind"] != json!("watch")));
}

/// A session replacement resets the lane (the TS replacement built a new
/// `AgentSession` with the default lane and fresh counters).
#[tokio::test]
async fn session_replacement_resets_the_lane_and_counters() {
    let worker = created_worker().await;
    park_runner(&worker).await;
    worker.agent_digest.configure_pin("digest").unwrap();
    worker.agent_digest.record_arrival(crate::util::now_ms());
    worker.agent_digest.note_model_turn(true);
    {
        let mut core = worker.core.lock().unwrap();
        core.agent_message_digest_mode = true;
    }
    // The replacement's reset (the navigation's store swap runs inside
    // the digest's one [counters -> core] hold).
    worker.agent_digest.reset_for_replacement(|_| ());
    assert_eq!(
        worker.agent_digest.configure_pin("auto").unwrap()["digest"],
        json!(false)
    );
    let receipt = deliver(&worker, "fresh session").await;
    assert_eq!(receipt["deliveryStatus"], "delivered");
    assert_eq!(worker.agent_digest.inbox_snapshot()["total"], json!(0));
}
/// A worker reload over a crashed predecessor's session file: the
/// digested row reached the durable inbox, but the crash landed between
/// the durable append and the notice's enqueue + checkpoint — the reload
/// must reconcile the unread entries and re-arm the one-per-batch notice,
/// so the backlog never sits silent with no later trigger to wake the
/// session.
#[tokio::test]
async fn a_reloaded_worker_re_arms_the_notice_for_unread_inbox_entries() {
    let dir =
        std::env::temp_dir().join(format!("pa-worker-digest-reload-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let session_path = dir.join("reloaded-session.jsonl");
    // The crashed predecessor's durable backlog: one unread inbox entry.
    let mut store = crate::session_store::SessionFile::create("/tmp", None, 0);
    store.set_path(session_path.clone());
    store.rewrite().unwrap();
    store
        .persist_entry(
            "custom",
            json!({
                "customType": crate::worker::digest::AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE,
                "data": {
                    "messageId": "agentmsg_crashed",
                    "content": "REPORT 481",
                    "from": { "activeSessionId": "sender", "sessionName": "sender" },
                    "fromRelationship": "sibling",
                    "target": { "activeSessionId": "target", "sessionId": "target" },
                    "receivedAt": "2026-01-01T00:00:00.000Z",
                    "kind": "agent_message",
                },
            }),
        )
        .unwrap();
    let worker = test_worker();
    // The queue stays parked across the create so the re-armed notice's
    // queued state is deterministic (the runner would otherwise consume
    // the wake turn asynchronously).
    {
        let mut core = worker.core.lock().unwrap();
        core.queued_input_suspended = true;
    }
    let created = worker
        .dispatch(
            "create",
            &json!({ "sessionPath": session_path.to_string_lossy(), "cwd": "/tmp" }),
        )
        .await;
    assert!(created.success, "create failed: {created:?}");
    // The durable backlog reloaded...
    let snapshot = worker.agent_digest.inbox_snapshot();
    assert_eq!(snapshot["unread"], json!(1), "{snapshot}");
    assert_eq!(
        snapshot["entries"][0]["content"],
        json!("REPORT 481"),
        "{snapshot}"
    );
    // ...and its notice re-armed (the one-per-batch wake).
    assert_eq!(
        lane_custom_types(&worker.core, Lane::FollowUp),
        vec!["agent_message_digest_notice"],
        "the reload did not re-arm the digest notice"
    );
}
/// The push lane's coalescing bound on a busy session: the 5-second
/// poller can emit faster than the runner drains, and one queued
/// notice per event would pile onto the steering lane unbounded. One
/// UNDELIVERED notice per watch — the newest event supersedes the
/// pending row's content; other watches keep their own row.
#[tokio::test]
async fn a_busy_session_holds_one_pending_watch_notice_per_watch() {
    let worker = created_worker().await;
    park_runner(&worker).await;
    {
        let mut core = worker.core.lock().unwrap();
        core.busy = true;
    }
    for index in 0..3 {
        worker.agent_digest.emit_watch_notice(
            "agent",
            &format!("[watch-agent child:c1] messages {index}..{}", index + 1),
        );
    }
    worker
        .agent_digest
        .emit_watch_notice("job", "[watch-job pid:1] output +10 bytes (0..10)");
    worker
        .agent_digest
        .emit_watch_notice("job", "[watch-job pid:1] output +20 bytes (0..20)");
    let texts = {
        let core = worker.core.lock().unwrap();
        core_lane_items(&core, Lane::Steering)
            .iter()
            .map(|item| item.message.clone())
            .collect::<Vec<_>>()
    };
    let types = lane_custom_types(&worker.core, Lane::Steering);
    assert_eq!(
        texts,
        vec![
            "[watch-agent child:c1] messages 2..3".to_string(),
            "[watch-job pid:1] output +20 bytes (0..20)".to_string(),
        ],
        "one pending notice per watch, superseded by the newest: {texts:?}"
    );
    assert_eq!(
        types,
        vec![
            "agent_watch_notice".to_string(),
            "agent_watch_notice".to_string()
        ],
        "{types:?}"
    );
}
