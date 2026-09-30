// Unix-only while the private-journal contract has no platform ACL
// proof: the family logs' private-parent validator fails closed on
// platforms without the owner/mode probes.
#![cfg(unix)]

//! Cloud family messaging substrate verifier: the journaled request/response
//! exchange over real durable logs, with the honesty contracts the design
//! pins — a receipt exists only after receiver admission, `Pending` is
//! durable-admitted-but-unanswered (never "queued"/"delivered"), a stalled
//! log fails the send, and the on-disk request envelope is the TS outbox
//! record byte-for-byte.
//!
//! Crash-gap protocol: every request is durably admitted BEFORE delivery;
//! an admitted-without-answer request is UNCERTAIN and never re-delivered —
//! a replay reconciles it through the receiver's idempotent lookup seam
//! (the test delivery records its admissions by request id, exactly what
//! the production receiver must implement). Without a receiver-side
//! idempotent record, the lookup answers `Unknown` and the request stays
//! uncertain: that is the release blocker the wiring PR must close, and
//! why nothing here claims reliable offline messaging.
//!
//! The delivery and submitter doubles implement the real seams; production
//! wiring (cloud registry attachment) is a later PR — nothing here fakes a
//! transport.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::oneshot;

use pa_daemon::cloud_family::{
    AgentMessageLookup, CloudDeliveryError, CloudFamilyDelivery, CloudFamilyRequestError,
    CloudFamilyRequestOutcome, CloudFamilyRequester, CloudFamilyResponder, FamilyRequestLog,
    FamilyResultLog, FamilyResultSubmitter, HandleOutcome, IncomingCloudMessage, ResolveOutcome,
};
use pa_types::daemon::cloud::{
    canonical_json, CloudAgentMessageDeliveryStatus, CloudAgentMessageReceipt, CloudFamilyCommand,
    CloudFamilyCommandPayload, CloudFamilyEventPayload, CloudFamilyRow,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const SHORT_WINDOW: Duration = Duration::from_millis(150);

struct TestDelivery {
    admitted: Mutex<Vec<IncomingCloudMessage>>,
    roster_calls: Mutex<Vec<String>>,
    errors_for: Mutex<HashMap<String, String>>,
    unresolved_for: Mutex<HashMap<String, String>>,
    /// The receiver's idempotent record: request id -> admitted receipt.
    /// Recorded exactly when the receiver admits a message, so a
    /// post-admission crash still leaves the truth to reconcile from.
    receiver_receipts: Mutex<HashMap<String, CloudAgentMessageReceipt>>,
    roster_error: Mutex<Option<String>>,
    rows: Vec<CloudFamilyRow>,
    /// Panic inside `deliver_agent_message` AFTER the receiver recorded its
    /// admission — simulates a process crash between the receiver's
    /// idempotent admission and the responder's answer record.
    panic_in_delivery: AtomicBool,
    /// Panic inside `deliver_agent_message` BEFORE the receiver records —
    /// the receiver never admitted, so its lookup answers `Unknown`.
    panic_before_admission: AtomicBool,
    /// Panic inside `family_roster` — the roster crash gap.
    panic_in_roster: AtomicBool,
    /// When set, the delivery waits on this gate before answering, so a
    /// second handler can observe the in-flight state.
    delivery_gate: Mutex<Option<oneshot::Receiver<()>>>,
    /// When set, the delivery replaces this journal file with a directory
    /// before answering, so the answer-record append fails (EISDIR).
    sabotage_results_path: Mutex<Option<std::path::PathBuf>>,
}

impl TestDelivery {
    fn new() -> Self {
        Self {
            admitted: Mutex::new(Vec::new()),
            roster_calls: Mutex::new(Vec::new()),
            errors_for: Mutex::new(HashMap::new()),
            unresolved_for: Mutex::new(HashMap::new()),
            receiver_receipts: Mutex::new(HashMap::new()),
            roster_error: Mutex::new(None),
            panic_in_delivery: AtomicBool::new(false),
            panic_before_admission: AtomicBool::new(false),
            panic_in_roster: AtomicBool::new(false),
            delivery_gate: Mutex::new(None),
            sabotage_results_path: Mutex::new(None),
            rows: vec![CloudFamilyRow {
                id: "sess_local_1".to_string(),
                name: Some("local parent".to_string()),
                depth: 0,
                status: pa_types::daemon::cloud::CloudFamilyRowStatus::Running,
                parent_session_id: None,
                parent_session_path: None,
                session_path: None,
            }],
        }
    }

    fn deliveries(&self) -> usize {
        self.admitted.lock().unwrap().len()
    }
}

impl CloudFamilyDelivery for TestDelivery {
    async fn deliver_agent_message(
        &self,
        message: IncomingCloudMessage,
    ) -> Result<CloudAgentMessageReceipt, CloudDeliveryError> {
        self.admitted.lock().unwrap().push(message.clone());
        let gate = self.delivery_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            let _ = gate.await;
        }
        if self.panic_before_admission.load(Ordering::SeqCst) {
            std::panic::panic_any("simulated crash before the receiver admitted");
        }
        if let Some(path) = self.sabotage_results_path.lock().unwrap().take() {
            std::fs::remove_file(&path).unwrap();
            std::fs::create_dir(&path).unwrap();
        }
        if let Some(error) = self.errors_for.lock().unwrap().get(&message.request_id) {
            return Err(CloudDeliveryError::Rejected(error.clone()));
        }
        if let Some(error) = self.unresolved_for.lock().unwrap().get(&message.request_id) {
            return Err(CloudDeliveryError::Unresolved(error.clone()));
        }
        // The receiver admits idempotently by request id: the record is
        // the reconciliation truth, and a later crash cannot undo it.
        let receipt = CloudAgentMessageReceipt {
            id: format!("agentmsg_{}", message.request_id),
            delivery_status: CloudAgentMessageDeliveryStatus::Delivered,
            rest: {
                let mut map = serde_json::Map::new();
                map.insert("message".to_string(), json!(message.message));
                map.insert("deliveryMode".to_string(), json!("steer"));
                map
            },
        };
        self.receiver_receipts
            .lock()
            .unwrap()
            .insert(message.request_id.clone(), receipt.clone());
        if self.panic_in_delivery.load(Ordering::SeqCst) {
            std::panic::panic_any("simulated crash between delivery and the answer record");
        }
        Ok(receipt)
    }

    async fn lookup_agent_message(&self, request_id: &str) -> AgentMessageLookup {
        match self.receiver_receipts.lock().unwrap().get(request_id) {
            Some(receipt) => AgentMessageLookup::Admitted(receipt.clone()),
            None => AgentMessageLookup::Unknown,
        }
    }

    async fn family_roster(
        &self,
        for_remote_session_id: &str,
    ) -> Result<Vec<CloudFamilyRow>, String> {
        self.roster_calls
            .lock()
            .unwrap()
            .push(for_remote_session_id.to_string());
        if self.panic_in_roster.load(Ordering::SeqCst) {
            std::panic::panic_any("simulated crash during the roster read");
        }
        if let Some(error) = self.roster_error.lock().unwrap().clone() {
            return Err(error);
        }
        Ok(self.rows.clone())
    }
}

struct TestSubmitter {
    submitted: Mutex<Vec<(String, CloudFamilyCommand)>>,
    fail: AtomicBool,
}

impl TestSubmitter {
    fn new() -> Self {
        Self {
            submitted: Mutex::new(Vec::new()),
            fail: AtomicBool::new(false),
        }
    }

    fn calls(&self) -> Vec<(String, CloudFamilyCommand)> {
        self.submitted.lock().unwrap().clone()
    }
}

impl FamilyResultSubmitter for TestSubmitter {
    async fn submit_family_result(
        &self,
        command_id: &str,
        command: &CloudFamilyCommand,
    ) -> Result<(), String> {
        if self.fail.load(Ordering::SeqCst) {
            return Err("tunnel detached".to_string());
        }
        self.submitted
            .lock()
            .unwrap()
            .push((command_id.to_string(), command.clone()));
        Ok(())
    }
}

fn open_request_log(dir: &std::path::Path, max_records: usize) -> FamilyRequestLog {
    // The macOS temp root resolves through /var (a symlink); the strict
    // no-symlink placement policy requires the ORIGINAL path to be
    // symlink-free, so the caller canonicalizes legitimate temp paths
    // (the product keeps no exception).
    FamilyRequestLog::open(
        &std::fs::canonicalize(dir).unwrap(),
        "sess_cloud_1",
        max_records,
    )
    .unwrap()
}

fn requester(log: FamilyRequestLog) -> Arc<CloudFamilyRequester> {
    Arc::new(CloudFamilyRequester::with_request_timeout(
        log,
        SHORT_WINDOW,
    ))
}

/// Poll the requester's durable log until one admitted request is
/// replayable — the append is synchronous, so one yielded task suffices in
/// practice; the loop keeps the test honest.
async fn wait_for_event(
    requester: &CloudFamilyRequester,
) -> pa_types::daemon::cloud::CloudFamilyEvent {
    for _ in 0..100 {
        if let Ok(events) = requester.events_after(0) {
            if let Some(event) = events.first() {
                return event.clone();
            }
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("no request event was admitted to the durable log");
}

#[tokio::test]
async fn send_resolves_answered_only_after_receiver_admission() {
    let dir = tempfile::tempdir().unwrap();
    // A long window: without an answer the send stays open the whole test,
    // so the receipt below can only come from receiver admission.
    let requester = Arc::new(CloudFamilyRequester::with_request_timeout(
        open_request_log(dir.path(), 50),
        Duration::from_secs(10),
    ));

    let sender = Arc::clone(&requester);
    let task = tokio::spawn(async move {
        sender
            .send_agent_message("remote_child", "sibling-worker", "status update")
            .await
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!task.is_finished(), "no answer may claim the send early");

    let event = wait_for_event(&requester).await;
    let results = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("results.ndjson");
    let responder = CloudFamilyResponder::new(FamilyResultLog::open(&results).unwrap());
    let delivery = TestDelivery::new();
    let submitter = TestSubmitter::new();
    let outcome = responder
        .handle_event(&event, &delivery, &submitter)
        .await
        .unwrap();
    assert_eq!(outcome, HandleOutcome::Answered);
    assert_eq!(delivery.deliveries(), 1);
    assert_eq!(
        delivery.admitted.lock().unwrap()[0].message,
        "status update"
    );

    let (command_id, command) = submitter.calls()[0].clone();
    assert!(command_id.starts_with("msgres_msgreq_"));
    assert_eq!(command.journal_command_id(), command_id);

    // The journaled answer is the only path to a receipt.
    assert_eq!(requester.resolve_result(&command), ResolveOutcome::Resolved);
    let receipt = match task.await.unwrap().unwrap() {
        CloudFamilyRequestOutcome::Answered(receipt) => receipt,
        CloudFamilyRequestOutcome::Pending { request_id } => {
            panic!("expected Answered, got Pending ({request_id})")
        }
    };
    assert_eq!(
        receipt.delivery_status,
        CloudAgentMessageDeliveryStatus::Delivered
    );
    assert!(receipt.id.starts_with("agentmsg_msgreq_"));
}

#[tokio::test]
async fn unanswered_send_is_pending_and_a_late_answer_is_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));

    let outcome = requester
        .send_agent_message("remote_child", "sibling-worker", "hello")
        .await
        .unwrap();
    // Offline honesty: durably admitted, no journaled answer — Pending, and
    // the outcome carries no delivery claim at all.
    let request_id = match outcome {
        CloudFamilyRequestOutcome::Pending { request_id } => request_id,
        CloudFamilyRequestOutcome::Answered(receipt) => {
            panic!(
                "expected Pending, got Answered ({:?})",
                receipt.delivery_status
            )
        }
    };
    assert!(request_id.starts_with("msgreq_"));
    assert!(!requester.events_after(0).unwrap().is_empty());

    // A late answer for the expired request is a harmless failed dispatch.
    let late: CloudFamilyCommand = serde_json::from_value(json!({
        "kind": "agent_message_result",
        "requestId": request_id,
        "ok": true,
        "receipt": {"id": "agentmsg_late", "deliveryStatus": "delivered"},
    }))
    .unwrap();
    assert_eq!(
        requester.resolve_result(&late),
        ResolveOutcome::UnknownRequestId
    );
}

#[tokio::test]
async fn a_stalled_log_fails_the_send_honestly() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 1));

    let first = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move {
            sender
                .send_agent_message("remote_child", "sibling", "one")
                .await
        }
    });
    assert!(matches!(
        first.await.unwrap().unwrap(),
        CloudFamilyRequestOutcome::Pending { .. }
    ));

    let error = requester
        .send_agent_message("remote_child", "sibling", "two")
        .await
        .unwrap_err();
    assert_eq!(
        error,
        CloudFamilyRequestError::Stalled(
            "the guest event log is stalled; agent messaging is unavailable".to_string()
        )
    );
    // The second request was never admitted.
    assert_eq!(requester.events_after(0).unwrap().len(), 1);
}

#[tokio::test]
async fn duplicate_replay_never_redelivers() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move {
            sender
                .send_agent_message("remote_child", "sibling", "hello")
                .await
        }
    });
    let event = wait_for_event(&requester).await;

    let results = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("results.ndjson");
    let responder = CloudFamilyResponder::new(FamilyResultLog::open(&results).unwrap());
    let delivery = TestDelivery::new();
    let submitter = TestSubmitter::new();

    let first = responder
        .handle_event(&event, &delivery, &submitter)
        .await
        .unwrap();
    assert_eq!(first, HandleOutcome::Answered);

    // The same event replaying (reconnect, unacked tail) is a duplicate: no
    // re-delivery, the same journaled answer re-submitted.
    let second = responder
        .handle_event(&event, &delivery, &submitter)
        .await
        .unwrap();
    assert_eq!(second, HandleOutcome::DuplicateResubmitted);
    assert_eq!(delivery.deliveries(), 1);
    let calls = submitter.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].0, calls[1].0);

    requester.resolve_result(&calls[0].1.clone());
    match task.await.unwrap().unwrap() {
        CloudFamilyRequestOutcome::Answered(_) => {}
        CloudFamilyRequestOutcome::Pending { request_id } => {
            panic!("expected Answered, got Pending ({request_id})")
        }
    }
}

#[tokio::test]
async fn responder_restart_replays_without_redelivery() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move {
            sender
                .send_agent_message("remote_child", "sibling", "hello")
                .await
        }
    });
    let event = wait_for_event(&requester).await;

    let results = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("results.ndjson");
    let delivery = TestDelivery::new();
    let submitter = TestSubmitter::new();
    let responder = CloudFamilyResponder::new(FamilyResultLog::open(&results).unwrap());
    responder
        .handle_event(&event, &delivery, &submitter)
        .await
        .unwrap();
    // The durable answer outlives the responder.
    drop(responder);

    let restarted = CloudFamilyResponder::new(FamilyResultLog::open(&results).unwrap());
    let outcome = restarted
        .handle_event(&event, &delivery, &submitter)
        .await
        .unwrap();
    assert_eq!(outcome, HandleOutcome::DuplicateResubmitted);
    assert_eq!(delivery.deliveries(), 1);
    assert_eq!(submitter.calls().len(), 2);

    let (_, command) = submitter.calls()[0].clone();
    requester.resolve_result(&command);
    match task.await.unwrap().unwrap() {
        CloudFamilyRequestOutcome::Answered(_) => {}
        CloudFamilyRequestOutcome::Pending { request_id } => {
            panic!("expected Answered, got Pending ({request_id})")
        }
    }
}

#[tokio::test]
async fn submit_failure_is_honest_and_a_replay_resubmits_the_durable_answer() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move {
            sender
                .send_agent_message("remote_child", "sibling", "hello")
                .await
        }
    });
    let event = wait_for_event(&requester).await;

    let results = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("results.ndjson");
    let responder = CloudFamilyResponder::new(FamilyResultLog::open(&results).unwrap());
    let delivery = TestDelivery::new();
    let submitter = TestSubmitter::new();
    // The tunnel is down for the submit leg: no answer may be claimed.
    submitter.fail.store(true, Ordering::SeqCst);
    let outcome = responder
        .handle_event(&event, &delivery, &submitter)
        .await
        .unwrap();
    assert_eq!(
        outcome,
        HandleOutcome::SubmitFailed("tunnel detached".to_string())
    );
    assert_eq!(delivery.deliveries(), 1);
    assert!(submitter.calls().is_empty());

    // The tunnel returns; the replay re-submits the durable answer without
    // re-delivering.
    submitter.fail.store(false, Ordering::SeqCst);
    let outcome = responder
        .handle_event(&event, &delivery, &submitter)
        .await
        .unwrap();
    assert_eq!(outcome, HandleOutcome::DuplicateResubmitted);
    assert_eq!(delivery.deliveries(), 1);

    let (_, command) = submitter.calls()[0].clone();
    requester.resolve_result(&command);
    match task.await.unwrap().unwrap() {
        CloudFamilyRequestOutcome::Answered(_) => {}
        CloudFamilyRequestOutcome::Pending { request_id } => {
            panic!("expected Answered, got Pending ({request_id})")
        }
    }
}

#[tokio::test]
async fn roster_request_answers_rows_and_degrades_to_empty_on_error() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move { sender.request_family_roster("remote_child").await }
    });
    let event = wait_for_event(&requester).await;
    assert!(event.request_id().starts_with("famreq_"));

    let results = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("results.ndjson");
    let responder = CloudFamilyResponder::new(FamilyResultLog::open(&results).unwrap());
    let delivery = TestDelivery::new();
    *delivery.roster_error.lock().unwrap() = Some("roster build failed".to_string());
    let submitter = TestSubmitter::new();
    responder
        .handle_event(&event, &delivery, &submitter)
        .await
        .unwrap();

    let (command_id, command) = submitter.calls()[0].clone();
    // The roster answer degrades to empty rows, exactly like the TS handler.
    assert!(command_id.starts_with("fam_famreq_"));
    requester.resolve_result(&command);
    match task.await.unwrap().unwrap() {
        CloudFamilyRequestOutcome::Answered(rows) => assert!(rows.is_empty()),
        CloudFamilyRequestOutcome::Pending { request_id } => {
            panic!("expected Answered, got Pending ({request_id})")
        }
    }
}

#[tokio::test]
async fn a_roster_answer_carries_the_local_rows() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move { sender.request_family_roster("remote_child").await }
    });
    let event = wait_for_event(&requester).await;

    let results = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("results.ndjson");
    let responder = CloudFamilyResponder::new(FamilyResultLog::open(&results).unwrap());
    let delivery = TestDelivery::new();
    let submitter = TestSubmitter::new();
    responder
        .handle_event(&event, &delivery, &submitter)
        .await
        .unwrap();
    assert_eq!(
        delivery.roster_calls.lock().unwrap().as_slice(),
        ["remote_child"]
    );

    let (_, command) = submitter.calls()[0].clone();
    requester.resolve_result(&command);
    match task.await.unwrap().unwrap() {
        CloudFamilyRequestOutcome::Answered(rows) => {
            assert_eq!(rows, delivery.rows);
        }
        CloudFamilyRequestOutcome::Pending { request_id } => {
            panic!("expected Answered, got Pending ({request_id})")
        }
    }
}

#[tokio::test]
async fn release_rejects_pending_requests() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move {
            sender
                .send_agent_message("remote_child", "sibling", "hello")
                .await
        }
    });
    wait_for_event(&requester).await;
    requester.release();
    assert_eq!(
        task.await.unwrap().unwrap_err(),
        CloudFamilyRequestError::Released
    );
}

#[tokio::test]
async fn first_attempt_unresolved_stays_unanswered_until_receiver_reconciles() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move {
            sender
                .send_agent_message("remote_child", "sibling", "hello")
                .await
        }
    });
    let event = wait_for_event(&requester).await;
    let request_id = event.request_id().to_string();
    let responder = CloudFamilyResponder::new(
        FamilyResultLog::open(
            &std::fs::canonicalize(dir.path())
                .unwrap()
                .join("results.ndjson"),
        )
        .unwrap(),
    );
    let delivery = TestDelivery::new();
    delivery.unresolved_for.lock().unwrap().insert(
        request_id.clone(),
        "worker route lost reply after dispatch".into(),
    );
    let submitter = TestSubmitter::new();
    assert_eq!(
        responder
            .handle_event(&event, &delivery, &submitter)
            .await
            .unwrap(),
        HandleOutcome::Uncertain
    );
    assert_eq!(responder.uncertain(), vec![request_id.clone()]);
    assert!(
        submitter.calls().is_empty(),
        "never persist or submit ok:false for an attempted delivery"
    );
    assert_eq!(
        responder
            .handle_event(&event, &delivery, &submitter)
            .await
            .unwrap(),
        HandleOutcome::Uncertain
    );
    delivery.unresolved_for.lock().unwrap().remove(&request_id);
    assert_eq!(
        pa_daemon::cloud_family::reconcile_uncertain(
            &responder,
            &delivery,
            std::slice::from_ref(&event)
        )
        .await
        .reconciled,
        vec![request_id],
    );
    assert_eq!(
        responder
            .handle_event(&event, &delivery, &submitter)
            .await
            .unwrap(),
        HandleOutcome::DuplicateResubmitted
    );
    let (_, command) = submitter.calls()[0].clone();
    assert!(matches!(
        command.payload,
        CloudFamilyCommandPayload::AgentMessageResult { ok: true, .. }
    ));
    requester.resolve_result(&command);
    assert!(matches!(
        task.await.unwrap().unwrap(),
        CloudFamilyRequestOutcome::Answered(_)
    ));
}

#[tokio::test]
async fn delivery_errors_slice_to_2000_utf16_units() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move {
            sender
                .send_agent_message("remote_child", "sibling", "hello")
                .await
        }
    });
    let event = wait_for_event(&requester).await;

    let results = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("results.ndjson");
    let responder = CloudFamilyResponder::new(FamilyResultLog::open(&results).unwrap());
    let delivery = TestDelivery::new();
    delivery.errors_for.lock().unwrap().insert(
        event.request_id().to_string(),
        "\u{1F600}".repeat(1501), // 3002 UTF-16 units
    );
    let submitter = TestSubmitter::new();
    responder
        .handle_event(&event, &delivery, &submitter)
        .await
        .unwrap();

    let (_, command) = submitter.calls()[0].clone();
    let error = match &command.payload {
        pa_types::daemon::cloud::CloudFamilyCommandPayload::AgentMessageResult {
            ok: false,
            error: Some(error),
            ..
        } => error.clone(),
        other => panic!("expected an error result, got {other:?}"),
    };
    assert_eq!(error.encode_utf16().count(), 2000);

    requester.resolve_result(&command);
    match task.await.unwrap() {
        Err(CloudFamilyRequestError::Rejected(rejection)) => {
            assert_eq!(rejection.encode_utf16().count(), 2000);
        }
        other => panic!("expected Rejected, got {other:?}"),
    }
}

#[tokio::test]
async fn request_log_repairs_a_crash_truncated_tail() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut log = open_request_log(dir.path(), 50);
        log.append(agent_message_event_payload("one")).unwrap();
        log.append(agent_message_event_payload("two")).unwrap();
    }
    // Simulate a crash mid-append: chop the final record.
    let path = dir.path().join("outbox-events.ndjson");
    let content = std::fs::read(&path).unwrap();
    std::fs::write(&path, &content[..content.len() - 10]).unwrap();

    let mut log = open_request_log(dir.path(), 50);
    assert_eq!(log.len(), 1);
    assert_eq!(log.events_after(0).unwrap().len(), 1);
    let third = log.append(agent_message_event_payload("three")).unwrap();
    assert_eq!(third.sequence, 2);

    // The repaired file is whole again: every line ends in a newline.
    let repaired = std::fs::read_to_string(&path).unwrap();
    assert!(repaired.ends_with('\n'));
    assert_eq!(repaired.lines().count(), 2);
}

#[tokio::test]
async fn request_log_replays_after_reopen_and_bounds_cursors() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut log = open_request_log(dir.path(), 50);
        log.append(agent_message_event_payload("one")).unwrap();
        log.append(agent_message_event_payload("two")).unwrap();
    }
    let log = open_request_log(dir.path(), 50);
    assert_eq!(log.events_after(0).unwrap().len(), 2);
    assert_eq!(log.events_after(1).unwrap().len(), 1);
    assert_eq!(log.events_after(1).unwrap()[0].sequence, 2);
    assert_eq!(log.events_after(2).unwrap(), Vec::new());
    assert_eq!(
        log.events_after(3).unwrap_err(),
        "Cloud cursor is beyond the event tail"
    );
}

#[tokio::test]
async fn request_envelope_is_the_ts_outbox_record() {
    let dir = tempfile::tempdir().unwrap();
    let mut log = open_request_log(dir.path(), 50);
    let event = log
        .append(CloudFamilyEventPayload::AgentMessageRequest {
            request_id: "msgreq_fixed".to_string(),
            from_remote_session_id: "remote_child".to_string(),
            target_selector: "sibling-worker".to_string(),
            message: "status update".to_string(),
        })
        .unwrap();
    drop(log);

    let path = dir.path().join("outbox-events.ndjson");
    let line = std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .to_string();
    let envelope: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(envelope["generation"], json!(1));
    let event_value = &envelope["event"];
    // Exact TS wire field names on the family event.
    assert_eq!(event_value["kind"], json!("agent_message_request"));
    assert_eq!(event_value["sequence"], json!(event.sequence));
    assert_eq!(event_value["requestId"], json!("msgreq_fixed"));
    assert_eq!(event_value["fromRemoteSessionId"], json!("remote_child"));
    assert_eq!(event_value["targetSelector"], json!("sibling-worker"));
    assert_eq!(event_value["message"], json!("status update"));
    assert!(event_value["recordedAt"]
        .as_str()
        .is_some_and(|at| !at.is_empty()));

    // eventId is the TS digest: sha256 over the canonical {sessionId,
    // generation, event} JSON, `evt_` prefixed.
    let canonical = canonical_json(&json!({
        "sessionId": "sess_cloud_1",
        "generation": 1,
        "event": event_value,
    }))
    .unwrap();
    let digest =
        Sha256::digest(canonical.as_bytes())
            .iter()
            .fold(String::new(), |mut key, byte| {
                use std::fmt::Write;
                write!(key, "{byte:02x}").expect("write to String");
                key
            });
    assert_eq!(envelope["eventId"], json!(format!("evt_{digest}")));
}

fn agent_message_event_payload(message: &str) -> CloudFamilyEventPayload {
    CloudFamilyEventPayload::AgentMessageRequest {
        request_id: format!("msgreq_{message}"),
        from_remote_session_id: "remote_child".to_string(),
        target_selector: "sibling".to_string(),
        message: message.to_string(),
    }
}

#[tokio::test]
async fn crash_after_receiver_admission_reconciles_through_the_seam() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move {
            sender
                .send_agent_message("remote_child", "sibling", "hello")
                .await
        }
    });
    let event = wait_for_event(&requester).await;

    let results = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("results.ndjson");
    let delivery = Arc::new(TestDelivery::new());
    let submitter = Arc::new(TestSubmitter::new());
    let responder = Arc::new(CloudFamilyResponder::new(
        FamilyResultLog::open(&results).unwrap(),
    ));
    // The process dies between the receiver's idempotent admission and the
    // responder's answer record.
    delivery.panic_in_delivery.store(true, Ordering::SeqCst);
    let crashed = tokio::spawn({
        let responder = Arc::clone(&responder);
        let delivery = Arc::clone(&delivery);
        let submitter = Arc::clone(&submitter);
        let event = event.clone();
        async move {
            responder
                .handle_event(&event, delivery.as_ref(), submitter.as_ref())
                .await
        }
    });
    assert!(crashed.await.unwrap_err().is_panic(), "delivery must crash");
    assert_eq!(delivery.deliveries(), 1);
    assert!(submitter.calls().is_empty());

    // Restart over the same durable journal: the request is durably
    // admitted with an unknown outcome, and the replay RECONCILES it
    // through the receiver's idempotent lookup — the recorded admission
    // becomes the journaled answer without any re-delivery.
    delivery.panic_in_delivery.store(false, Ordering::SeqCst);
    let restarted = CloudFamilyResponder::new(FamilyResultLog::open(&results).unwrap());
    assert_eq!(restarted.uncertain(), vec![event.request_id().to_string()]);
    let outcome = restarted
        .handle_event(&event, delivery.as_ref(), submitter.as_ref())
        .await
        .unwrap();
    assert_eq!(outcome, HandleOutcome::Reconciled);
    assert_eq!(delivery.deliveries(), 1, "reconciliation never re-delivers");
    assert!(restarted.uncertain().is_empty());
    assert_eq!(submitter.calls().len(), 1);
    let (_, command) = submitter.calls()[0].clone();
    assert_eq!(
        command.payload,
        CloudFamilyCommandPayload::AgentMessageResult {
            request_id: event.request_id().to_string(),
            ok: true,
            receipt: Some(CloudAgentMessageReceipt {
                id: format!("agentmsg_{}", event.request_id()),
                delivery_status: CloudAgentMessageDeliveryStatus::Delivered,
                rest: {
                    let mut map = serde_json::Map::new();
                    map.insert("message".to_string(), json!("hello"));
                    map.insert("deliveryMode".to_string(), json!("steer"));
                    map
                },
            }),
            error: None,
        }
    );

    requester.resolve_result(&command);
    assert!(matches!(
        task.await.unwrap().unwrap(),
        CloudFamilyRequestOutcome::Answered(_)
    ));
}

#[tokio::test]
async fn unknown_lookup_keeps_the_request_uncertain_without_redelivery() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move {
            sender
                .send_agent_message("remote_child", "sibling", "hello")
                .await
        }
    });
    let event = wait_for_event(&requester).await;

    let results = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("results.ndjson");
    let delivery = Arc::new(TestDelivery::new());
    let submitter = Arc::new(TestSubmitter::new());
    let responder = Arc::new(CloudFamilyResponder::new(
        FamilyResultLog::open(&results).unwrap(),
    ));
    // The process dies BEFORE the receiver recorded anything: the
    // receiver's idempotent lookup answers Unknown.
    delivery
        .panic_before_admission
        .store(true, Ordering::SeqCst);
    let crashed = tokio::spawn({
        let responder = Arc::clone(&responder);
        let delivery = Arc::clone(&delivery);
        let submitter = Arc::clone(&submitter);
        let event = event.clone();
        async move {
            responder
                .handle_event(&event, delivery.as_ref(), submitter.as_ref())
                .await
        }
    });
    assert!(crashed.await.unwrap_err().is_panic(), "delivery must crash");
    assert_eq!(delivery.deliveries(), 1);

    delivery
        .panic_before_admission
        .store(false, Ordering::SeqCst);
    let restarted = CloudFamilyResponder::new(FamilyResultLog::open(&results).unwrap());
    // The replay cannot decide: the receiver knows nothing, and
    // re-delivering is exactly what the admission gate exists to prevent.
    let outcome = restarted
        .handle_event(&event, delivery.as_ref(), submitter.as_ref())
        .await
        .unwrap();
    assert_eq!(outcome, HandleOutcome::Uncertain);
    assert_eq!(
        delivery.deliveries(),
        1,
        "an uncertain request is never re-delivered"
    );
    assert_eq!(restarted.uncertain(), vec![event.request_id().to_string()]);
    assert!(submitter.calls().is_empty());

    // The requester is honestly unanswered: Pending, never a receipt.
    assert!(matches!(
        task.await.unwrap().unwrap(),
        CloudFamilyRequestOutcome::Pending { .. }
    ));
}

#[tokio::test]
async fn roster_crash_replay_reruns_the_read_and_reconciles() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move { sender.request_family_roster("remote_child").await }
    });
    let event = wait_for_event(&requester).await;

    let results = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("results.ndjson");
    let delivery = Arc::new(TestDelivery::new());
    let submitter = Arc::new(TestSubmitter::new());
    let responder = Arc::new(CloudFamilyResponder::new(
        FamilyResultLog::open(&results).unwrap(),
    ));
    // The process dies during the roster read.
    delivery.panic_in_roster.store(true, Ordering::SeqCst);
    let crashed = tokio::spawn({
        let responder = Arc::clone(&responder);
        let delivery = Arc::clone(&delivery);
        let submitter = Arc::clone(&submitter);
        let event = event.clone();
        async move {
            responder
                .handle_event(&event, delivery.as_ref(), submitter.as_ref())
                .await
        }
    });
    assert!(crashed.await.unwrap_err().is_panic(), "roster must crash");
    assert_eq!(delivery.roster_calls.lock().unwrap().len(), 1);
    assert!(submitter.calls().is_empty());

    // The roster read is idempotent: the replay re-runs it and answers —
    // no message-style stranding for a pure read.
    delivery.panic_in_roster.store(false, Ordering::SeqCst);
    let restarted = CloudFamilyResponder::new(FamilyResultLog::open(&results).unwrap());
    let outcome = restarted
        .handle_event(&event, delivery.as_ref(), submitter.as_ref())
        .await
        .unwrap();
    assert_eq!(outcome, HandleOutcome::Reconciled);
    assert_eq!(delivery.roster_calls.lock().unwrap().len(), 2);
    assert!(restarted.uncertain().is_empty());

    let (_, command) = submitter.calls()[0].clone();
    requester.resolve_result(&command);
    match task.await.unwrap().unwrap() {
        CloudFamilyRequestOutcome::Answered(rows) => assert_eq!(rows, delivery.rows),
        CloudFamilyRequestOutcome::Pending { request_id } => {
            panic!("expected Answered, got Pending ({request_id})")
        }
    }
}

#[tokio::test]
async fn reconciliation_records_the_answer_and_replay_resubmits() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move {
            sender
                .send_agent_message("remote_child", "sibling", "hello")
                .await
        }
    });
    let event = wait_for_event(&requester).await;

    let results = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("results.ndjson");
    let delivery = Arc::new(TestDelivery::new());
    let submitter = Arc::new(TestSubmitter::new());
    let responder = Arc::new(CloudFamilyResponder::new(
        FamilyResultLog::open(&results).unwrap(),
    ));
    delivery.panic_in_delivery.store(true, Ordering::SeqCst);
    let crashed = tokio::spawn({
        let responder = Arc::clone(&responder);
        let delivery = Arc::clone(&delivery);
        let submitter = Arc::clone(&submitter);
        let event = event.clone();
        async move {
            responder
                .handle_event(&event, delivery.as_ref(), submitter.as_ref())
                .await
        }
    });
    assert!(crashed.await.unwrap_err().is_panic());

    // Reconciliation: the wiring layer learns what the receiver did (it is
    // idempotent by request id) and records the answer for the uncertain
    // request. Only then may a replay proceed — and it re-submits, never
    // re-delivers.
    let reconciled: CloudFamilyCommand = serde_json::from_value(json!({
        "kind": "agent_message_result",
        "requestId": event.request_id(),
        "ok": true,
        "receipt": {"id": format!("agentmsg_{}", event.request_id()), "deliveryStatus": "delivered"},
    }))
    .unwrap();
    responder.record_answer(reconciled.clone()).unwrap();
    assert!(responder.uncertain().is_empty());
    let outcome = responder
        .handle_event(&event, delivery.as_ref(), submitter.as_ref())
        .await
        .unwrap();
    assert_eq!(outcome, HandleOutcome::DuplicateResubmitted);
    assert_eq!(
        delivery.deliveries(),
        1,
        "reconciliation must not re-deliver"
    );

    let (command_id, command) = submitter.calls()[0].clone();
    assert_eq!(command_id, command.journal_command_id());
    requester.resolve_result(&command);
    assert!(matches!(
        task.await.unwrap().unwrap(),
        CloudFamilyRequestOutcome::Answered(_)
    ));
}

#[tokio::test]
async fn in_flight_duplicate_surfaces_uncertain_without_delivery() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move {
            sender
                .send_agent_message("remote_child", "sibling", "hello")
                .await
        }
    });
    let event = wait_for_event(&requester).await;

    let results = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("results.ndjson");
    let delivery = Arc::new(TestDelivery::new());
    let (release, gate) = oneshot::channel::<()>();
    *delivery.delivery_gate.lock().unwrap() = Some(gate);
    let submitter = Arc::new(TestSubmitter::new());
    let responder = Arc::new(CloudFamilyResponder::new(
        FamilyResultLog::open(&results).unwrap(),
    ));

    let first = tokio::spawn({
        let responder = Arc::clone(&responder);
        let delivery = Arc::clone(&delivery);
        let submitter = Arc::clone(&submitter);
        let event = event.clone();
        async move {
            responder
                .handle_event(&event, delivery.as_ref(), submitter.as_ref())
                .await
        }
    });
    // Let the first handler reach (and hold inside) delivery.
    while delivery.deliveries() == 0 {
        tokio::time::sleep(Duration::from_millis(2)).await;
    }

    // The duplicate racing the in-flight delivery is honestly uncertain —
    // admitted, unanswered, and never re-delivered.
    let second = responder
        .handle_event(&event, delivery.as_ref(), submitter.as_ref())
        .await
        .unwrap();
    assert_eq!(second, HandleOutcome::Uncertain);
    assert_eq!(delivery.deliveries(), 1);

    release.send(()).unwrap();
    assert_eq!(first.await.unwrap().unwrap(), HandleOutcome::Answered);
    assert_eq!(delivery.deliveries(), 1);

    let (_, command) = submitter.calls()[0].clone();
    requester.resolve_result(&command);
    assert!(matches!(
        task.await.unwrap().unwrap(),
        CloudFamilyRequestOutcome::Answered(_)
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn answer_record_failure_surfaces_uncertain_and_can_be_completed() {
    let dir = tempfile::tempdir().unwrap();
    let requester = requester(open_request_log(dir.path(), 50));
    let task = tokio::spawn({
        let sender = Arc::clone(&requester);
        async move {
            sender
                .send_agent_message("remote_child", "sibling", "hello")
                .await
        }
    });
    let event = wait_for_event(&requester).await;

    let results = std::fs::canonicalize(dir.path())
        .unwrap()
        .join("results.ndjson");
    let delivery = Arc::new(TestDelivery::new());
    *delivery.sabotage_results_path.lock().unwrap() = Some(results.clone());
    let submitter = TestSubmitter::new();
    let responder = CloudFamilyResponder::new(FamilyResultLog::open(&results).unwrap());

    // The delivery succeeds but the answer-record fsync fails: the
    // handling errors honestly, and the durable admission stands.
    let outcome = responder
        .handle_event(&event, delivery.as_ref(), &submitter)
        .await;
    assert!(
        outcome.is_err(),
        "a failed answer record must surface an error"
    );
    assert_eq!(delivery.deliveries(), 1);
    assert!(submitter.calls().is_empty());

    // The replay reconciles through the receiver's idempotent lookup (it
    // recorded the admission), but the broken journal still refuses the
    // record — the honest error again, and still no re-delivery.
    let outcome = responder
        .handle_event(&event, delivery.as_ref(), &submitter)
        .await;
    assert!(
        outcome.is_err(),
        "a still-broken journal must surface an error"
    );
    assert_eq!(
        delivery.deliveries(),
        1,
        "a record failure must not re-deliver"
    );
    assert_eq!(responder.uncertain(), vec![event.request_id().to_string()]);

    // Reconciliation completes the request: the journal file is writable
    // again, the answer is recorded, and a replay re-submits it.
    std::fs::remove_dir(&results).unwrap();
    let reconciled: CloudFamilyCommand = serde_json::from_value(json!({
        "kind": "agent_message_result",
        "requestId": event.request_id(),
        "ok": true,
        "receipt": {"id": format!("agentmsg_{}", event.request_id()), "deliveryStatus": "delivered"},
    }))
    .unwrap();
    responder.record_answer(reconciled).unwrap();
    assert!(responder.uncertain().is_empty());
    let outcome = responder
        .handle_event(&event, delivery.as_ref(), &submitter)
        .await
        .unwrap();
    assert_eq!(outcome, HandleOutcome::DuplicateResubmitted);
    assert_eq!(delivery.deliveries(), 1);
    assert_eq!(submitter.calls().len(), 1);

    let (_, command) = submitter.calls()[0].clone();
    requester.resolve_result(&command);
    assert!(matches!(
        task.await.unwrap().unwrap(),
        CloudFamilyRequestOutcome::Answered(_)
    ));
}
