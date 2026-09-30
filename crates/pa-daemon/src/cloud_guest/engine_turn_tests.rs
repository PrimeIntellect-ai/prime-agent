//! One real session-engine turn through the guest command path, on the
//! scripted faux provider (hermetic: no network, no credentials), and
//! the restart replay that never duplicates the turn.
//!
//! The engine is constructed on the plain test thread, exactly like
//! the agent-engine faux battery (its facade builds its own runtime;
//! an ambient one would shadow it), and only the protocol serving runs
//! on the test runtime.

use std::sync::Arc;

use pa_types::daemon::cloud::CloudCommandState;

use crate::agent_engine::{AgentEngineConfig, FAUX_TEST_LOCK};
use crate::cloud_guest::dispatch::GuestExecutor;
use crate::cloud_guest::executor::EngineGuestExecutor;
use crate::cloud_guest::tests_support::{
    boot_guest, open_request, prompt_request, LoopbackClient, TEST_TOKEN,
};

fn faux_executor(cwd: &std::path::Path) -> Arc<EngineGuestExecutor> {
    let agent_dir = cwd.join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let config = AgentEngineConfig {
        cwd: cwd.to_path_buf(),
        agent_dir,
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(r#"{"responses":["guest turn answer"]}"#.to_string()),
        supervisor_link: None,
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    };
    Arc::new(
        EngineGuestExecutor::new(config, Some("faux/faux-1".to_string()))
            .expect("faux engine executor"),
    )
}

fn serve_rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("test runtime")
}

#[test]
fn one_real_session_engine_turn_runs_once_and_replay_never_reruns() {
    let _faux_lock = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let cwd = dir.path().to_path_buf();
    let session_id = "sess_engine";
    let generation = 7u64;
    let state_dir = dir.path().join("guest-state");
    let status_file = dir.path().join("daemon-status.json");
    let workspace = cwd.display().to_string();
    // First life: the engine executor runs the real pa-core session
    // turn exactly once through the guest command path.
    let first_executor = faux_executor(&cwd);
    serve_rt().block_on(async {
        let booted = boot_guest(
            &state_dir,
            &status_file,
            &workspace,
            session_id,
            generation,
            Arc::clone(&first_executor) as Arc<dyn GuestExecutor>,
        );
        let (mut client, _) =
            LoopbackClient::hello(&booted.hub, TEST_TOKEN, session_id, generation).await;
        client
            .submit(session_id, generation, "cmd_open", open_request(&workspace))
            .await;
        client
            .await_receipt(
                session_id,
                generation,
                "cmd_open",
                CloudCommandState::Completed,
            )
            .await;
        let (admission, _) = client
            .submit(
                session_id,
                generation,
                "cmd_prompt",
                prompt_request("say hi"),
            )
            .await;
        assert_eq!(admission, CloudCommandState::Accepted);
        client
            .await_receipt(
                session_id,
                generation,
                "cmd_prompt",
                CloudCommandState::Completed,
            )
            .await;
        assert_eq!(
            first_executor.turn_count(),
            1,
            "the engine ran the turn once"
        );
        booted.server.begin_shutdown();
        booted.serve.await.unwrap();
    });
    // Restart over the same durable state: the replayed id answers with
    // the stored receipt and the engine never reruns.
    let second_executor = faux_executor(&cwd);
    serve_rt().block_on(async {
        let booted = boot_guest(
            &state_dir,
            &status_file,
            &workspace,
            session_id,
            generation,
            Arc::clone(&second_executor) as Arc<dyn GuestExecutor>,
        );
        let (mut client, _) =
            LoopbackClient::hello(&booted.hub, TEST_TOKEN, session_id, generation).await;
        let (state, _) = client
            .submit(
                session_id,
                generation,
                "cmd_prompt",
                prompt_request("say hi"),
            )
            .await;
        assert_eq!(
            state,
            CloudCommandState::Completed,
            "the replayed id answers with the stored terminal receipt"
        );
        assert_eq!(
            second_executor.turn_count(),
            0,
            "the replay never reruns the engine"
        );
        booted.server.begin_shutdown();
        booted.serve.await.unwrap();
    });
}

#[test]
fn a_restored_pending_prompt_runs_once_with_the_real_executor() {
    // The crash shape the review flagged: the open was claimed (its
    // running transition is fsynced) and a prompt was admitted but
    // never claimed. The restored guest must execute the pending
    // prompt exactly once with the real engine — the open's
    // uncertainty must not strand the prompt behind a per-process
    // "no session" flag.
    let _faux_lock = FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let cwd = dir.path().to_path_buf();
    let session_id = "sess_engine_restore";
    let generation = 7u64;
    let state_dir = dir.path().join("guest-state");
    let status_file = dir.path().join("daemon-status.json");
    let workspace = cwd.display().to_string();
    // Craft the crashed journal: open claimed (restores uncertain),
    // prompt admitted (restores pending).
    {
        let mut journal = crate::cloud_guest::journal::GuestCommandJournal::open(
            &state_dir.join("command-journal.ndjson"),
        )
        .unwrap();
        journal
            .admit(
                "cmd_open",
                &serde_json::to_value(open_request(&workspace)).unwrap(),
            )
            .unwrap();
        journal
            .admit(
                "cmd_prompt",
                &serde_json::to_value(prompt_request("the restored turn")).unwrap(),
            )
            .unwrap();
        let claimed = journal.claim_next_pending().unwrap().unwrap();
        assert_eq!(claimed.receipt.command_id, "cmd_open");
    }
    let executor = faux_executor(&cwd);
    serve_rt().block_on(async {
        let booted = boot_guest(
            &state_dir,
            &status_file,
            &workspace,
            session_id,
            generation,
            Arc::clone(&executor) as Arc<dyn GuestExecutor>,
        );
        // The restored open is uncertain and never re-runs; the
        // restored prompt is claimable and the engine executes it once.
        assert_eq!(booted.server.list_uncertain().len(), 1);
        assert_eq!(booted.server.list_uncertain()[0].command_id, "cmd_open");
        let (mut client, _) =
            LoopbackClient::hello(&booted.hub, TEST_TOKEN, session_id, generation).await;
        let settled = client
            .await_receipt(
                session_id,
                generation,
                "cmd_prompt",
                CloudCommandState::Completed,
            )
            .await;
        assert_eq!(settled, CloudCommandState::Completed);
        assert_eq!(
            executor.turn_count(),
            1,
            "the restored pending prompt runs exactly once with the real engine"
        );
        booted.server.begin_shutdown();
        booted.serve.await.unwrap();
    });
}
