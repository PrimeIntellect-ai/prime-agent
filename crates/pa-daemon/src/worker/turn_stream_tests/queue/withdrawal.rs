//! Real withdrawal commands preserve active/remaining work and clear the last idle note.
use super::*;

#[tokio::test]
async fn queue_withdrawals_clear_only_the_last_idle_notes() {
    for command in [
        "mutate_queued_message",
        "cancel_prompt_admission",
        "agent_messages_pause",
        "agent_messages_clear",
        "bash_consumed",
        "abort",
    ] {
        for state in ["last", "busy", "remaining"] {
            let dir = tempfile::tempdir().unwrap();
            let engine = Arc::new(NoteWitnessEngine::default());
            let mut worker = Worker::new(
                WorkerConfig {
                    socket_path: dir.path().join("worker.sock"),
                    supervisor_socket_path: dir.path().join("supervisor.sock"),
                    token: "token".to_string(),
                    worker_instance_id: String::new(),
                    active_session_id: "withdraw-note".to_string(),
                    agent_dir: dir.path().join("agent"),
                    recovery_journal_path: dir.path().join("recovery.jsonl"),
                    telemetry_disabled: Some(true),
                    script: Some(json!({ "responses": ["unused"] })),
                },
                None,
            );
            worker.engine = engine.clone();
            let (roster_pushes, publication_pending) =
                crate::roster_activity::RosterPushQueue::observed_for_test();
            worker.roster_pushes = roster_pushes;
            // Represent a run whose AgentEnd retained its note for queued work.
            *engine.note.lock().unwrap() = Some("checking deployment".to_string());
            worker.register_prompt_admission("owned-note");
            assert!(worker.prompt_admissions.commit("owned-note"));
            {
                let mut core = worker.core.lock().unwrap();
                core.created = true;
                core.busy = state == "busy";
                core.queued_input_suspended = true;
                if command != "bash_consumed" {
                    let mut row = queued_prompt("withdraw me", TurnPolicy::Queued);
                    row.admission_id = Some("owned-note".to_string());
                    if command.starts_with("agent_messages_") {
                        row.agent_message = Some("message-note".to_string());
                    }
                    if command == "abort" {
                        row.queue_visible = false;
                    }
                    core.follow_up.push_back(row);
                }
                if state == "remaining" {
                    let mut row = queued_prompt("keep me", TurnPolicy::Queued);
                    row.queue_visible = true;
                    core.steering.push_back(row);
                }
            }
            if command == "bash_consumed" {
                admit_kernel_notice(
                    &worker.recovery,
                    &worker.core,
                    &Arc::new(Notify::new()),
                    crate::engine::KernelNotice::bash_completion(4321, "fixture command", 0, None),
                    || false,
                );
                withdraw_bash_completion_notice(
                    &worker.recovery,
                    &worker.core,
                    &crate::engine::BashConsumedNotice {
                        pid: 4321,
                        command: "fixture command".to_string(),
                    },
                    Some(engine.as_ref()),
                );
            } else {
                let payload = match command {
                    "mutate_queued_message" => json!({
                        "lane": "followUp", "index": 0, "expectedText": "withdraw me",
                        "mutation": { "type": "delete" },
                    }),
                    "cancel_prompt_admission" => json!({
                        "admissionId": "owned-note", "cancelOwned": true,
                    }),
                    _ => json!({}),
                };
                let response = worker.dispatch(command, &payload).await;
                assert!(response.success, "{command}/{state}: {response:?}");
                if command == "mutate_queued_message" {
                    assert_eq!(response.data, Some(json!({ "status": "applied" })));
                }
            }
            let core = worker.core.lock().unwrap();
            assert!(core.follow_up.is_empty(), "{command}/{state}");
            assert_eq!(
                core.steering.len(),
                usize::from(state == "remaining"),
                "{command}/{state}"
            );
            let expected = (state != "last").then(|| "checking deployment".to_string());
            assert_eq!(engine.progress_note(), expected, "{command}/{state}");
            drop(core);
            if matches!(command, "cancel_prompt_admission" | "abort") {
                assert!(publication_pending(), "{command}/{state}: no roster push");
                let (core, inputs) = worker.summary_inputs();
                let summary = crate::worker::summary::session_summary(&core, inputs);
                assert_eq!(
                    summary.progress_note, expected,
                    "{command}/{state}: summary"
                );
            }
        }
    }
}
