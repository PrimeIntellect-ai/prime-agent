//! Guest loopback battery: the fake-transport harness that boots the
//! actual guest protocol server, submits through the real wire, and
//! proves the durability contract — idempotent stable-id admission
//! (a receipt state distinct from completion), claim-before-dispatch,
//! settle-before-event, and restart replay that never duplicates a
//! turn.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use pa_types::daemon::cloud::{
    CloudCommandId, CloudCommandRequest, CloudCommandState, CloudCursor, CloudGetCommand,
    CloudMessage, CloudSubmit, CloudSubscribe,
};

use crate::cloud_guest::dispatch::{GuestDispatchOutcome, GuestExecutor, GuestSessionSnapshot};
use crate::cloud_guest::outbox::{GuestEventInput, GuestEventOutbox};
use crate::cloud_guest::server::GuestProtocolServer;
use crate::cloud_guest::tests_support::{
    boot_guest, event_sequence, open_request, prompt_request, rt, BootedGuest, LoopbackClient,
    LoopbackHub, TEST_TOKEN,
};

// ---------------------------------------------------------------------------
// The scripted executor (the fake that stands in for the session engine)
// ---------------------------------------------------------------------------

/// The counting executor: every dispatch is observable, named commands
/// can park mid-run (the crash-mid-run harness), and nothing else is
/// supported.
struct ScriptedExecutor {
    open_count: Arc<AtomicUsize>,
    prompt_count: Arc<AtomicUsize>,
    park_ids: Arc<Mutex<HashSet<String>>>,
    cwd: String,
}

/// The counting executor and its witnesses: the open and prompt
/// counters plus the park set.
type ScriptedExecutorParts = (
    Arc<ScriptedExecutor>,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    Arc<Mutex<HashSet<String>>>,
);

impl ScriptedExecutor {
    fn new(cwd: &str) -> ScriptedExecutorParts {
        let open_count = Arc::new(AtomicUsize::new(0));
        let prompt_count = Arc::new(AtomicUsize::new(0));
        let park_ids = Arc::new(Mutex::new(HashSet::new()));
        (
            Arc::new(Self {
                open_count: Arc::clone(&open_count),
                prompt_count: Arc::clone(&prompt_count),
                park_ids: Arc::clone(&park_ids),
                cwd: cwd.to_string(),
            }),
            open_count,
            prompt_count,
            park_ids,
        )
    }
}

impl GuestExecutor for ScriptedExecutor {
    fn dispatch(
        &self,
        command_id: CloudCommandId,
        request: CloudCommandRequest,
    ) -> futures::future::BoxFuture<'static, GuestDispatchOutcome> {
        let open_count = Arc::clone(&self.open_count);
        let prompt_count = Arc::clone(&self.prompt_count);
        let park_ids = Arc::clone(&self.park_ids);
        Box::pin(async move {
            let parked = park_ids.lock().unwrap().contains(command_id.as_str());
            match request {
                CloudCommandRequest::OpenSession { prompt, .. } => {
                    open_count.fetch_add(1, Ordering::SeqCst);
                    if parked {
                        std::future::pending::<()>().await;
                    }
                    match prompt {
                        Some(prompt) if !prompt.is_empty() => {
                            prompt_count.fetch_add(1, Ordering::SeqCst);
                            GuestDispatchOutcome::Completed { result: None }
                        }
                        _ => GuestDispatchOutcome::Completed { result: None },
                    }
                }
                CloudCommandRequest::Prompt { text, .. } => {
                    let _ = text;
                    prompt_count.fetch_add(1, Ordering::SeqCst);
                    if parked {
                        std::future::pending::<()>().await;
                    }
                    GuestDispatchOutcome::Completed { result: None }
                }
                CloudCommandRequest::Release => GuestDispatchOutcome::Completed { result: None },
                _ => GuestDispatchOutcome::Failed {
                    error: Some("unsupported in the loopback harness".to_string()),
                },
            }
        })
    }

    fn snapshot(&self) -> GuestSessionSnapshot {
        GuestSessionSnapshot {
            cwd: self.cwd.clone(),
            model: Some("faux/faux-1".to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// The battery-local harness
// ---------------------------------------------------------------------------

struct GuestHarness {
    booted: BootedGuest,
    dir: tempfile::TempDir,
}

impl GuestHarness {
    fn spawn(dir: tempfile::TempDir, executor: Arc<dyn GuestExecutor>) -> Self {
        let booted = boot_guest(
            &dir.path().join("guest-state"),
            &dir.path().join("daemon-status.json"),
            &dir.path().display().to_string(),
            "sess_loopback",
            7,
            executor,
        );
        Self { booted, dir }
    }

    fn server(&self) -> Arc<GuestProtocolServer> {
        Arc::clone(&self.booted.server)
    }

    fn hub(&self) -> Arc<LoopbackHub> {
        Arc::clone(&self.booted.hub)
    }
}

/// Boot the next guest life over the first one's durable state (the
/// restart arm of every replay test); the first harness keeps the
/// state's temp dir alive.
fn restart_over(dir: &tempfile::TempDir, executor: Arc<dyn GuestExecutor>) -> BootedGuest {
    boot_guest(
        &dir.path().join("guest-state"),
        &dir.path().join("daemon-status.json"),
        &dir.path().display().to_string(),
        "sess_loopback",
        7,
        executor,
    )
}

// ---------------------------------------------------------------------------
// The battery
// ---------------------------------------------------------------------------

#[test]
fn hello_requires_the_exact_identity_and_token() {
    let (executor, _open, _prompts, _park) = {
        let dir = tempfile::TempDir::new().unwrap();
        ScriptedExecutor::new(&dir.path().display().to_string())
    };
    rt().block_on(async {
        let harness = GuestHarness::spawn(tempfile::TempDir::new().unwrap(), executor);
        let session_id = "sess_loopback";
        let generation = 7u64;
        // A wrong token is dropped without a snapshot.
        let (client, first) =
            LoopbackClient::hello(&harness.hub(), "wrong", session_id, generation).await;
        assert_eq!(first, None, "a wrong token must drop the connection");
        drop(client);
        // A wrong session id is dropped.
        let (client, first) =
            LoopbackClient::hello(&harness.hub(), TEST_TOKEN, "sess_other", generation).await;
        assert_eq!(first, None, "a wrong session id must drop the connection");
        drop(client);
        // A stale generation is dropped.
        let (client, first) =
            LoopbackClient::hello(&harness.hub(), TEST_TOKEN, session_id, generation + 1).await;
        assert_eq!(first, None, "a stale generation must drop the connection");
        drop(client);
        // The exact identity gets the snapshot.
        let (_client, first) =
            LoopbackClient::hello(&harness.hub(), TEST_TOKEN, session_id, generation).await;
        let Some(CloudMessage::Snapshot(snapshot)) = first else {
            panic!("expected a snapshot");
        };
        assert_eq!(
            snapshot.status,
            pa_types::daemon::cloud::CloudSessionStatus::Starting
        );
        assert!(
            snapshot.capabilities.is_none(),
            "the guest slice advertises nothing"
        );
        harness.server().begin_shutdown();
        harness.booted.serve.await.unwrap();
    });
}

#[test]
fn admission_is_distinct_from_completion_and_duplicates_never_rerun() {
    let (executor, _open, prompt_count, _park) = {
        let dir = tempfile::TempDir::new().unwrap();
        ScriptedExecutor::new(&dir.path().display().to_string())
    };
    let cwd_dir = tempfile::TempDir::new().unwrap();
    let cwd = cwd_dir.path().display().to_string();
    rt().block_on(async {
        let harness = GuestHarness::spawn(cwd_dir, executor);
        let session_id = "sess_loopback";
        let generation = 7u64;
        let (mut client, _) =
            LoopbackClient::hello(&harness.hub(), TEST_TOKEN, session_id, generation).await;
        // The open admits and completes.
        let (state, uncertain) = client
            .submit(session_id, generation, "cmd_open", open_request(&cwd))
            .await;
        assert_eq!(
            state,
            CloudCommandState::Accepted,
            "the submit answers with the admission receipt, not the completion"
        );
        assert!(!uncertain, "a fresh admission is certain");
        let settled = client
            .await_receipt(
                session_id,
                generation,
                "cmd_open",
                CloudCommandState::Completed,
            )
            .await;
        assert_eq!(settled, CloudCommandState::Completed);
        // The prompt admits, runs, and completes — one execution.
        let (state, _) = client
            .submit(
                session_id,
                generation,
                "cmd_prompt",
                prompt_request("turn one"),
            )
            .await;
        assert_eq!(
            state,
            CloudCommandState::Accepted,
            "admission precedes completion"
        );
        let completed = client
            .await_receipt(
                session_id,
                generation,
                "cmd_prompt",
                CloudCommandState::Completed,
            )
            .await;
        assert_eq!(completed, CloudCommandState::Completed);
        assert_eq!(
            prompt_count.load(Ordering::SeqCst),
            1,
            "one prompt, one execution"
        );
        // The duplicate submit replays the stored completed receipt
        // without a second execution.
        let (state, _) = client
            .submit(
                session_id,
                generation,
                "cmd_prompt",
                prompt_request("turn one"),
            )
            .await;
        assert_eq!(
            state,
            CloudCommandState::Completed,
            "the duplicate replays the terminal receipt"
        );
        assert_eq!(
            prompt_count.load(Ordering::SeqCst),
            1,
            "a duplicate never reruns"
        );
        // The same id with a different request is a conflict: the
        // connection drops, the journal never re-admits.
        let other = prompt_request("a different turn");
        let digest =
            pa_types::daemon::cloud::cloud_request_digest(&serde_json::to_value(&other).unwrap())
                .unwrap();
        client
            .send(&CloudMessage::Submit(CloudSubmit {
                session_id: session_id.to_string(),
                generation,
                command_id: "cmd_prompt".to_string(),
                request: other,
                digest,
            }))
            .await;
        assert_eq!(client.recv().await, None, "a conflict drops the connection");
        assert_eq!(prompt_count.load(Ordering::SeqCst), 1);
        harness.server().begin_shutdown();
        harness.booted.serve.await.unwrap();
    });
}

#[test]
fn restart_replay_of_a_completed_prompt_never_duplicates_the_turn() {
    let prompt_request_text = "the only turn";
    let cwd_dir = tempfile::TempDir::new().unwrap();
    let cwd = cwd_dir.path().display().to_string();
    // First life: open, one prompt, one execution.
    let (executor, _open, prompt_count, _park) = {
        let dir = tempfile::TempDir::new().unwrap();
        ScriptedExecutor::new(&dir.path().display().to_string())
    };
    let dir = rt().block_on(async {
        let harness = GuestHarness::spawn(cwd_dir, executor);
        let session_id = "sess_loopback";
        let generation = 7u64;
        let (mut client, _) =
            LoopbackClient::hello(&harness.hub(), TEST_TOKEN, session_id, generation).await;
        client
            .submit(session_id, generation, "cmd_open", open_request(&cwd))
            .await;
        client
            .await_receipt(
                session_id,
                generation,
                "cmd_open",
                CloudCommandState::Completed,
            )
            .await;
        let (state, _) = client
            .submit(
                session_id,
                generation,
                "cmd_prompt",
                prompt_request(prompt_request_text),
            )
            .await;
        assert_eq!(state, CloudCommandState::Accepted);
        client
            .await_receipt(
                session_id,
                generation,
                "cmd_prompt",
                CloudCommandState::Completed,
            )
            .await;
        assert_eq!(
            prompt_count.load(Ordering::SeqCst),
            1,
            "the first life ran the turn once"
        );
        let GuestHarness { booted, dir } = harness;
        booted.server.begin_shutdown();
        booted.serve.await.unwrap();
        dir
    });
    // Second life over the same durable state: the same command id
    // replays the stored receipt and never reruns the turn.
    let (executor, _open, prompt_count, _park) = {
        let executor_dir = tempfile::TempDir::new().unwrap();
        ScriptedExecutor::new(&executor_dir.path().display().to_string())
    };
    rt().block_on(async {
        let second = restart_over(&dir, executor);
        let session_id = "sess_loopback";
        let generation = 7u64;
        let (mut client, snapshot) =
            LoopbackClient::hello(&second.hub, TEST_TOKEN, session_id, generation).await;
        let Some(CloudMessage::Snapshot(snapshot)) = snapshot else {
            panic!("expected a snapshot");
        };
        assert_eq!(
            snapshot.status,
            pa_types::daemon::cloud::CloudSessionStatus::Starting,
            "the second life starts fresh"
        );
        let (state, uncertain) = client
            .submit(
                session_id,
                generation,
                "cmd_prompt",
                prompt_request(prompt_request_text),
            )
            .await;
        assert_eq!(
            state,
            CloudCommandState::Completed,
            "the replayed id answers with the stored terminal receipt"
        );
        assert!(!uncertain);
        assert_eq!(
            prompt_count.load(Ordering::SeqCst),
            0,
            "the replay never reruns the turn"
        );
        second.server.begin_shutdown();
        second.serve.await.unwrap();
    });
}

#[test]
fn crash_mid_run_restores_uncertain_and_never_answers_or_reruns() {
    // First life: the prompt claims (running fsynced) and parks
    // mid-run; the crash leaves the journal exactly at the claim.
    let (executor, _open, prompt_count, park) = {
        let dir = tempfile::TempDir::new().unwrap();
        ScriptedExecutor::new(&dir.path().display().to_string())
    };
    park.lock().unwrap().insert("cmd_crash".to_string());
    let cwd_dir = tempfile::TempDir::new().unwrap();
    let cwd = cwd_dir.path().display().to_string();
    let harness = rt().block_on(async {
        let harness = GuestHarness::spawn(cwd_dir, executor);
        let session_id = "sess_loopback";
        let generation = 7u64;
        let (mut client, _) =
            LoopbackClient::hello(&harness.hub(), TEST_TOKEN, session_id, generation).await;
        client
            .submit(session_id, generation, "cmd_open", open_request(&cwd))
            .await;
        client
            .await_receipt(
                session_id,
                generation,
                "cmd_open",
                CloudCommandState::Completed,
            )
            .await;
        let (state, _) = client
            .submit(
                session_id,
                generation,
                "cmd_crash",
                prompt_request("the interrupted turn"),
            )
            .await;
        assert_eq!(state, CloudCommandState::Accepted);
        client
            .await_receipt(
                session_id,
                generation,
                "cmd_crash",
                CloudCommandState::Running,
            )
            .await;
        assert_eq!(
            prompt_count.load(Ordering::SeqCst),
            1,
            "the turn started once"
        );
        harness
    });
    let dir = {
        let GuestHarness { booted, dir } = harness;
        booted.serve.abort();
        dir
    };
    // Second life: the crashed command restores uncertain, is never
    // claimed, and its duplicate submit reports the honest running
    // receipt — never a fabricated failure.
    let (executor, _open, prompt_count, _park) = {
        let executor_dir = tempfile::TempDir::new().unwrap();
        ScriptedExecutor::new(&executor_dir.path().display().to_string())
    };
    rt().block_on(async {
        let second = restart_over(&dir, executor);
        let session_id = "sess_loopback";
        let generation = 7u64;
        let uncertain = second.server.list_uncertain();
        assert_eq!(uncertain.len(), 1, "the crashed command surfaces uncertain");
        assert_eq!(uncertain[0].command_id, "cmd_crash");
        assert_eq!(uncertain[0].state, CloudCommandState::Running);
        assert!(uncertain[0].uncertain);
        assert!(
            second.server.list_pending_command_ids().is_empty(),
            "an uncertain command is never claimable"
        );
        let (mut client, _) =
            LoopbackClient::hello(&second.hub, TEST_TOKEN, session_id, generation).await;
        let (state, uncertain) = client
            .submit(
                session_id,
                generation,
                "cmd_crash",
                prompt_request("the interrupted turn"),
            )
            .await;
        assert_eq!(
            state,
            CloudCommandState::Running,
            "the duplicate replays the running receipt"
        );
        assert!(uncertain, "the receipt honestly reports the crash gap");
        assert_ne!(
            state,
            CloudCommandState::Failed,
            "a crash gap must never fabricate a durable failure answer"
        );
        // The probe settles only if the loop already skipped the
        // uncertain command: claims are FIFO, so cmd_probe would stay
        // queued behind cmd_crash forever if cmd_crash were claimable.
        client
            .submit(
                session_id,
                generation,
                "cmd_probe",
                CloudCommandRequest::Abort,
            )
            .await;
        client
            .await_receipt(
                session_id,
                generation,
                "cmd_probe",
                CloudCommandState::Failed,
            )
            .await;
        assert_eq!(
            prompt_count.load(Ordering::SeqCst),
            0,
            "the uncertain command never reruns"
        );
        // The host-explicit requeue makes it dispatchable again: one
        // honest execution, then the settle.
        second
            .server
            .requeue_command("cmd_crash")
            .expect("host requeue");
        let settled = client
            .await_receipt(
                session_id,
                generation,
                "cmd_crash",
                CloudCommandState::Completed,
            )
            .await;
        assert_eq!(settled, CloudCommandState::Completed);
        assert_eq!(
            prompt_count.load(Ordering::SeqCst),
            1,
            "the requeue runs exactly once"
        );
        second.server.begin_shutdown();
        second.serve.await.unwrap();
    });
}

#[test]
fn admitted_unclaimed_command_replays_exactly_once_after_restart() {
    // First life: the open parks mid-run, so the queued prompt stays
    // admitted-but-unclaimed; the crash leaves both on disk.
    let (executor, _open, _prompt, park) = {
        let dir = tempfile::TempDir::new().unwrap();
        ScriptedExecutor::new(&dir.path().display().to_string())
    };
    park.lock().unwrap().insert("cmd_open".to_string());
    let cwd_dir = tempfile::TempDir::new().unwrap();
    let cwd = cwd_dir.path().display().to_string();
    let harness = rt().block_on(async {
        let harness = GuestHarness::spawn(cwd_dir, executor);
        let session_id = "sess_loopback";
        let generation = 7u64;
        let (mut client, _) =
            LoopbackClient::hello(&harness.hub(), TEST_TOKEN, session_id, generation).await;
        client
            .submit(session_id, generation, "cmd_open", open_request(&cwd))
            .await;
        client
            .await_receipt(
                session_id,
                generation,
                "cmd_open",
                CloudCommandState::Running,
            )
            .await;
        // The queued prompt's admission is durable the moment its
        // accepted receipt frame arrives.
        client
            .submit(
                session_id,
                generation,
                "cmd_queued",
                prompt_request("the queued turn"),
            )
            .await;
        harness
    });
    let dir = {
        let GuestHarness { booted, dir } = harness;
        booted.serve.abort();
        dir
    };
    // Second life: the queued prompt claims and executes exactly once;
    // the parked open stays uncertain and never reruns.
    let (executor, open_count, prompt_count, _park) = {
        let executor_dir = tempfile::TempDir::new().unwrap();
        ScriptedExecutor::new(&executor_dir.path().display().to_string())
    };
    rt().block_on(async {
        let second = restart_over(&dir, executor);
        let session_id = "sess_loopback";
        let generation = 7u64;
        let (mut client, _) =
            LoopbackClient::hello(&second.hub, TEST_TOKEN, session_id, generation).await;
        let settled = client
            .await_receipt(
                session_id,
                generation,
                "cmd_queued",
                CloudCommandState::Completed,
            )
            .await;
        assert_eq!(settled, CloudCommandState::Completed);
        assert_eq!(
            prompt_count.load(Ordering::SeqCst),
            1,
            "the restored admission executes exactly once"
        );
        assert_eq!(
            open_count.load(Ordering::SeqCst),
            0,
            "the uncertain open never reruns"
        );
        second.server.begin_shutdown();
        second.serve.await.unwrap();
    });
}

#[test]
fn ack_cursor_advances_and_replay_resumes_after_it() {
    let (executor, _open, _prompt, _park) = {
        let dir = tempfile::TempDir::new().unwrap();
        ScriptedExecutor::new(&dir.path().display().to_string())
    };
    let cwd_dir = tempfile::TempDir::new().unwrap();
    let cwd = cwd_dir.path().display().to_string();
    let session_id = "sess_loopback";
    let generation = 7u64;
    let (dir, acknowledged) = rt().block_on(async {
        let harness = GuestHarness::spawn(cwd_dir, executor);
        let (mut client, _) =
            LoopbackClient::hello(&harness.hub(), TEST_TOKEN, session_id, generation).await;
        client
            .submit(session_id, generation, "cmd_open", open_request(&cwd))
            .await;
        client
            .await_receipt(
                session_id,
                generation,
                "cmd_open",
                CloudCommandState::Completed,
            )
            .await;
        // Go live from zero and read the whole tail in one batch.
        client
            .send(&CloudMessage::Subscribe(CloudSubscribe {
                session_id: session_id.to_string(),
                cursor: CloudCursor {
                    generation: 1,
                    sequence: 0,
                },
            }))
            .await;
        let batch = match client.recv().await {
            Some(CloudMessage::Events(batch)) => batch,
            other => panic!("expected the events batch, got {other:?}"),
        };
        let tail = batch.events.last().map(event_sequence).unwrap_or_default();
        assert!(
            tail >= 5,
            "the open produced its full command lifecycle, tail {tail}"
        );
        // Acknowledge through the observed tail; the receipt poll that
        // follows proves the ack was processed (frames are ordered).
        client
            .ack(
                session_id,
                CloudCursor {
                    generation: 1,
                    sequence: tail,
                },
            )
            .await;
        client
            .await_receipt(
                session_id,
                generation,
                "cmd_open",
                CloudCommandState::Completed,
            )
            .await;
        harness.server().begin_shutdown();
        harness.booted.serve.await.unwrap();
        // The acknowledged cursor is durable in the outbox metadata.
        let outbox = GuestEventOutbox::open(
            &harness.dir.path().join("guest-state").join("event-outbox"),
            session_id,
        )
        .expect("reopen outbox");
        assert_eq!(outbox.acknowledged_cursor().sequence, tail);
        let GuestHarness { booted: _, dir } = harness;
        (dir, tail)
    });
    // The restart serves replay after the acknowledged cursor: a
    // from-any-cursor subscribe receives exactly the unacknowledged
    // suffix, the acknowledged outbox metadata survives the restart,
    // and a fresh hello lands at the tail.
    rt().block_on(async {
        let (executor, _open, _prompt, _park) = {
            let executor_dir = tempfile::TempDir::new().unwrap();
            ScriptedExecutor::new(&executor_dir.path().display().to_string())
        };
        let second = restart_over(&dir, executor);
        // Hello at the top: the snapshot lands at the tail with nothing
        // to carry.
        let (mut client, first) =
            LoopbackClient::hello(&second.hub, TEST_TOKEN, session_id, generation).await;
        let Some(CloudMessage::Snapshot(snapshot)) = first else {
            panic!("expected a snapshot");
        };
        assert!(
            snapshot.events.is_empty(),
            "a fresh hello lands at the tail"
        );
        assert_eq!(snapshot.cursor.sequence, acknowledged);
        // Subscribe from one before the acknowledged tail: exactly the
        // suffix arrives.
        client
            .send(&CloudMessage::Subscribe(CloudSubscribe {
                session_id: session_id.to_string(),
                cursor: CloudCursor {
                    generation: 1,
                    sequence: acknowledged - 1,
                },
            }))
            .await;
        match client.recv().await {
            Some(CloudMessage::Events(batch)) => {
                assert_eq!(
                    batch.events.len(),
                    1,
                    "the acknowledged prefix is never re-served"
                );
                assert_eq!(event_sequence(&batch.events[0]), acknowledged);
            }
            other => panic!("expected the suffix batch, got {other:?}"),
        }
        second.server.begin_shutdown();
        second.serve.await.unwrap();
    });
}

#[test]
fn queue_full_fails_the_newest_admission_honestly() {
    let (executor, _open, _prompt, park) = {
        let dir = tempfile::TempDir::new().unwrap();
        ScriptedExecutor::new(&dir.path().display().to_string())
    };
    park.lock().unwrap().insert("cmd_open".to_string());
    let cwd_dir = tempfile::TempDir::new().unwrap();
    let cwd = cwd_dir.path().display().to_string();
    rt().block_on(async {
        let harness = GuestHarness::spawn(cwd_dir, executor);
        let session_id = "sess_loopback";
        let generation = 7u64;
        let (mut client, _) =
            LoopbackClient::hello(&harness.hub(), TEST_TOKEN, session_id, generation).await;
        client
            .submit(session_id, generation, "cmd_open", open_request(&cwd))
            .await;
        client
            .await_receipt(
                session_id,
                generation,
                "cmd_open",
                CloudCommandState::Running,
            )
            .await;
        // Fill the queue past the bound: the overflow admission settles
        // as a failed receipt, honestly, instead of wedging. The submit
        // frame still answers with the admission receipt (TS writes
        // `admitted.receipt`); the failed state surfaces in the polled
        // receipt.
        let mut last_state = CloudCommandState::Accepted;
        for index in 0..70u32 {
            let (state, _) = client
                .submit(
                    session_id,
                    generation,
                    &format!("cmd_fill_{index}"),
                    prompt_request("queued"),
                )
                .await;
            last_state = state;
        }
        assert_eq!(last_state, CloudCommandState::Accepted);
        assert_eq!(
            client
                .await_receipt(
                    session_id,
                    generation,
                    "cmd_fill_69",
                    CloudCommandState::Failed
                )
                .await,
            CloudCommandState::Failed,
            "the overflow admission fails honestly"
        );
        // The parked open holds the dispatch loop forever; the end of
        // this test is the crash shape (a hard kill), like the crash
        // battery, so nothing waits on the serving task.
        harness.booted.serve.abort();
    });
}

#[test]
fn guest_env_requires_every_provisioned_coordinate() {
    use crate::cloud_guest::parse_cloud_guest_env;

    let full = |key: &str| -> Option<String> {
        match key {
            "PRIME_AGENT_CLOUD_DAEMON_SOCKET" => Some("/tmp/cloud.sock".to_string()),
            "PRIME_AGENT_CLOUD_SESSION_ID" => Some("sess_loopback".to_string()),
            "PRIME_AGENT_CLOUD_GENERATION" => Some("7".to_string()),
            "PRIME_AGENT_CLOUD_WORKSPACE_DIR" => Some("/workspace".to_string()),
            "PRIME_AGENT_CLOUD_AGENT_DIR" => Some("/state/agent".to_string()),
            "PRIME_AGENT_CLOUD_BRIDGE_TOKEN" => Some("t".to_string()),
            _ => None,
        }
    };
    let env = parse_cloud_guest_env(&full, Some(std::path::Path::new("/default/state")))
        .expect("full env parses");
    assert_eq!(env.session_id, "sess_loopback");
    assert_eq!(env.generation, 7);
    assert_eq!(
        env.status_file,
        std::path::Path::new("/default/state").join("daemon-status.json"),
        "the status file defaults into the state dir"
    );
    assert_eq!(
        env.session_state_dir(),
        std::path::Path::new("/default/state").join("sess_loopback.g7"),
        "the per-session state dir embeds the sandbox generation"
    );
    // A missing required key is a hard boot error (TS parity message).
    let missing = |key: &str| -> Option<String> {
        if key == "PRIME_AGENT_CLOUD_BRIDGE_TOKEN" {
            None
        } else {
            full(key)
        }
    };
    let error = parse_cloud_guest_env(&missing, None).unwrap_err();
    assert_eq!(
        error.0,
        "missing required environment variable PRIME_AGENT_CLOUD_BRIDGE_TOKEN"
    );
    // A non-integer or zero generation is invalid.
    let bad_generation = |key: &str| -> Option<String> {
        if key == "PRIME_AGENT_CLOUD_GENERATION" {
            Some("0".to_string())
        } else {
            full(key)
        }
    };
    let error = parse_cloud_guest_env(&bad_generation, None).unwrap_err();
    assert_eq!(error.0, "invalid PRIME_AGENT_CLOUD_GENERATION");
}

#[test]
fn torn_multibyte_outbox_tail_preserves_the_fsynced_events() {
    let dir = tempfile::TempDir::new().unwrap();
    let session_id = "sess_outbox";
    let state = dir.path().join("guest-state");
    // A live event tail: command-accepted then command-state, fsynced.
    {
        let mut outbox = GuestEventOutbox::open(&state.join("event-outbox"), session_id).unwrap();
        let receipt = crate::cloud_guest::journal::GuestCommandJournal::open(
            &state.join("command-journal.ndjson"),
        )
        .unwrap()
        .admit("cmd_x", &serde_json::json!({"kind": "abort"}))
        .unwrap()
        .1;
        outbox
            .append(GuestEventInput::CommandAccepted {
                recorded_at: crate::cloud_guest::now_iso(),
                receipt: receipt.clone(),
            })
            .unwrap();
        outbox
            .append(GuestEventInput::CommandState {
                recorded_at: crate::cloud_guest::now_iso(),
                receipt,
            })
            .unwrap();
        outbox
            .ack(&CloudCursor {
                generation: 1,
                sequence: 1,
            })
            .unwrap();
    }
    // A torn final append whose UTF-8 sequence is split: the string
    // reader would reject the whole file; a truncating recovery would
    // destroy both fsynced events.
    let mut contents =
        std::fs::read(state.join("event-outbox").join("outbox-events.ndjson")).unwrap();
    contents.extend_from_slice(b"{\"eventId\":\"evt_\xF0\x9F");
    std::fs::write(
        state.join("event-outbox").join("outbox-events.ndjson"),
        &contents,
    )
    .unwrap();
    // The reopen keeps every complete record and the acknowledged
    // cursor, and repairs the torn tail.
    let outbox = GuestEventOutbox::open(&state.join("event-outbox"), session_id).unwrap();
    assert_eq!(
        outbox.tail_cursor().sequence,
        2,
        "both fsynced events survive"
    );
    assert_eq!(outbox.acknowledged_cursor().sequence, 1);
    let events = outbox
        .events_after(
            &CloudCursor {
                generation: 1,
                sequence: 0,
            },
            10,
        )
        .unwrap();
    assert_eq!(events.len(), 2);
    let reloaded = std::fs::read(state.join("event-outbox").join("outbox-events.ndjson")).unwrap();
    assert!(reloaded.ends_with(b"\n"), "the torn tail was repaired away");
}

#[test]
fn unreadable_outbox_refuses_to_open_instead_of_truncating() {
    let dir = tempfile::TempDir::new().unwrap();
    let state = dir.path().join("guest-state").join("event-outbox");
    // A directory where the events file belongs: every read fails; a
    // truncating recovery would destroy the durable log.
    std::fs::create_dir_all(&state).unwrap();
    std::fs::create_dir(state.join("outbox-events.ndjson")).unwrap();
    std::fs::write(
        state.join("outbox-meta.json"),
        b"{\"version\":1,\"sessionId\":\"sess_outbox\",\"generation\":1,\"ackedSequence\":0}\n",
    )
    .unwrap();
    assert!(GuestEventOutbox::open(&state, "sess_outbox").is_err());
    // The directory was never truncated away (the fail-closed path
    // leaves the path untouched).
    assert!(state.join("outbox-events.ndjson").is_dir());
}

#[test]
fn submit_with_a_stale_generation_is_dropped_and_never_admitted() {
    let (executor, _open, _prompt, _park) = {
        let dir = tempfile::TempDir::new().unwrap();
        ScriptedExecutor::new(&dir.path().display().to_string())
    };
    let cwd_dir = tempfile::TempDir::new().unwrap();
    rt().block_on(async {
        let harness = GuestHarness::spawn(cwd_dir, executor);
        let session_id = "sess_loopback";
        let generation = 7u64;
        let (mut client, _) =
            LoopbackClient::hello(&harness.hub(), TEST_TOKEN, session_id, generation).await;
        // Authenticated, but the submit names the wrong sandbox
        // generation: the connection drops and the command is never
        // journaled (TS handleSubmit's fence).
        let request = prompt_request("stale turn");
        let digest =
            pa_types::daemon::cloud::cloud_request_digest(&serde_json::to_value(&request).unwrap())
                .unwrap();
        client
            .send(&CloudMessage::Submit(CloudSubmit {
                session_id: session_id.to_string(),
                generation: generation + 1,
                command_id: "cmd_stale".to_string(),
                request,
                digest,
            }))
            .await;
        assert_eq!(
            client.recv().await,
            None,
            "a stale submit generation drops the connection"
        );
        // A fresh connection proves nothing was admitted.
        let (mut client, _) =
            LoopbackClient::hello(&harness.hub(), TEST_TOKEN, session_id, generation).await;
        client
            .send(&CloudMessage::GetCommand(CloudGetCommand {
                session_id: session_id.to_string(),
                generation,
                command_id: Some("cmd_stale".to_string()),
                claim: None,
            }))
            .await;
        assert_eq!(
            client.recv().await,
            None,
            "the stale command was never admitted"
        );
        harness.server().begin_shutdown();
        harness.booted.serve.await.unwrap();
    });
}

#[cfg(unix)]
#[test]
fn the_guest_socket_is_owner_only_after_bind() {
    // The guest's run path binds through the shared transport and then
    // restricts the socket inode to 0700 (TS chmodSync parity) — the
    // umask must not decide who can reach the bridge socket. Assert the
    // restriction over a REAL unix listener.
    use std::os::unix::fs::PermissionsExt;
    rt().block_on(async {
        let dir = tempfile::TempDir::new().unwrap();
        let socket = dir.path().join("cloud.sock");
        let listener = pa_types::platform::transport::bind_transport(&socket)
            .await
            .expect("guest bind");
        drop(listener);
        // Simulate the umask leaving the socket world-readable, then
        // apply the guest's restriction step exactly where
        // `run_guest_daemon` applies it.
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o755)).unwrap();
        pa_core::platform::perms::restrict_file(&socket).expect("restrict");
        let mode = std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode & 0o077,
            0,
            "the guest socket is owner-only after bind (got {mode:o})"
        );
        assert_eq!(mode & 0o700, 0o600, "the owner keeps connect access");
    });
}
