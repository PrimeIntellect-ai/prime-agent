//! Lifecycle admission and natural-stop contract through the real agent loop.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_agent::agent::{Agent, AgentOptions, AgentPromptInput};
use pa_agent::scripted::ScriptedProvider;
use pa_agent::types::{AgentMessage, Message, Model, UserContent, UserMessage};

fn user(text: &str) -> AgentMessage {
    AgentMessage::Standard(Message::User(UserMessage {
        content: UserContent::Text(text.into()),
        timestamp: 0,
    }))
}

#[tokio::test]
async fn denied_batch_never_enters_transcript_or_provider_context() {
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let agent = Agent::new(AgentOptions {
        stream_fn: Some(provider.stream_fn()),
        before_input: Some(Arc::new(move |users, _, _| {
            *sink.lock().unwrap() = users;
            Box::pin(async { anyhow::bail!("second submitted row denied") })
        })),
        ..Default::default()
    });
    let submitted = vec![user("first"), user("second")];
    assert!(agent
        .prompt(AgentPromptInput::Messages(submitted.clone()))
        .await
        .is_err());
    let seen_rows = seen.lock().unwrap().clone();
    assert_eq!(seen_rows, submitted);
    assert!(provider.calls().is_empty());
    assert!(!agent
        .state()
        .await
        .messages
        .iter()
        .any(|message| matches!(message, AgentMessage::Standard(Message::User(_)))));
}

#[tokio::test]
async fn abort_interrupts_a_pending_input_gate_before_any_user_row_is_persisted() {
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    let entered = Arc::new(tokio::sync::Notify::new());
    let signal_entry = Arc::clone(&entered);
    let agent = Arc::new(Agent::new(AgentOptions {
        stream_fn: Some(provider.stream_fn()),
        before_input: Some(Arc::new(move |_, _, _| {
            signal_entry.notify_one();
            Box::pin(std::future::pending())
        })),
        ..Default::default()
    }));
    let running = Arc::clone(&agent);
    let run = tokio::spawn(async move { running.prompt("not admitted").await });
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    agent.abort();
    assert!(tokio::time::timeout(Duration::from_secs(2), run)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(provider.calls().is_empty());
    assert!(!agent
        .state()
        .await
        .messages
        .iter()
        .any(|message| matches!(message, AgentMessage::Standard(Message::User(_)))));
}

#[tokio::test]
async fn queued_inputs_and_stop_feedback_are_gated_but_internal_continuation_is_not() {
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    for response in ["initial", "queued", "internal", "hook answer"] {
        provider.push_text_turn(response);
    }
    let admitted = Arc::new(Mutex::new(Vec::new()));
    let admitted_sink = Arc::clone(&admitted);
    let continuations = Arc::new(AtomicUsize::new(0));
    let continuation_count = Arc::clone(&continuations);
    let stop_active = Arc::new(Mutex::new(Vec::new()));
    let active_sink = Arc::clone(&stop_active);
    let agent = Agent::new(AgentOptions {
        stream_fn: Some(provider.stream_fn()),
        before_input: Some(Arc::new(move |users, _, _| {
            admitted_sink
                .lock()
                .unwrap()
                .extend(users.into_iter().filter_map(|row| {
                    if let AgentMessage::Standard(Message::User(row)) = row {
                        Some(row.content)
                    } else {
                        None
                    }
                }));
            Box::pin(async { Ok(()) })
        })),
        get_continuation_messages: Some(Arc::new(move |_, _| {
            let rows = if continuation_count.fetch_add(1, Ordering::SeqCst) == 0 {
                vec![user("internal autonomous")]
            } else {
                Vec::new()
            };
            Box::pin(async { Ok(rows) })
        })),
        final_stop: Some(Arc::new(move |_, active, _| {
            active_sink.lock().unwrap().push(active);
            // Deliberately request another row even while active: the loop
            // itself enforces the bound independently of the hook adapter.
            Box::pin(async { Ok(vec![user("hook feedback")]) })
        })),
        ..Default::default()
    });
    agent.follow_up(user("queued submission"));
    agent.prompt("external submission").await.unwrap();
    assert_eq!(*stop_active.lock().unwrap(), vec![false, true]);
    assert_eq!(
        *admitted.lock().unwrap(),
        vec![
            UserContent::Parts(vec![pa_agent::types::UserPart::Text(
                pa_agent::types::TextContent {
                    text: "external submission".into(),
                    text_signature: None
                }
            )]),
            UserContent::Text("queued submission".into()),
            UserContent::Text("hook feedback".into()),
        ]
    );
    assert_eq!(provider.calls().len(), 4);
    let raw_users = agent
        .state()
        .await
        .messages
        .into_iter()
        .filter_map(|message| {
            if let AgentMessage::Standard(Message::User(row)) = message {
                Some(row.content)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(
        raw_users,
        vec![
            UserContent::Parts(vec![pa_agent::types::UserPart::Text(
                pa_agent::types::TextContent {
                    text: "external submission".into(),
                    text_signature: None
                }
            )]),
            UserContent::Text("queued submission".into()),
            UserContent::Text("internal autonomous".into()),
            UserContent::Text("hook feedback".into()),
        ]
    );
}

#[tokio::test]
async fn host_handoff_prevents_a_stop_hook_from_minting_a_turn() {
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    provider.push_text_turn("yielding");
    let invoked = Arc::new(AtomicUsize::new(0));
    let invoked_sink = Arc::clone(&invoked);
    let agent = Agent::new(AgentOptions {
        stream_fn: Some(provider.stream_fn()),
        final_stop: Some(Arc::new(move |_, _, _| {
            invoked_sink.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(vec![user("should not run")]) })
        })),
        ..Default::default()
    });
    agent.set_stop_hook_eligibility(Some(Arc::new(|| Box::pin(async { false }))));
    agent.prompt("external").await.unwrap();
    assert_eq!(invoked.load(Ordering::SeqCst), 0);
    assert_eq!(provider.calls().len(), 1);
}

#[tokio::test]
async fn user_input_arriving_during_stop_work_preempts_hook_feedback() {
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    provider.push_text_turn("initial answer");
    provider.push_text_turn("answer to newer input");
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let entered_hook = Arc::clone(&entered);
    let release_hook = Arc::clone(&release);
    let calls = Arc::new(AtomicUsize::new(0));
    let agent = Arc::new(Agent::new(AgentOptions {
        stream_fn: Some(provider.stream_fn()),
        final_stop: Some(Arc::new(move |_, _, _| {
            let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
            let entered = Arc::clone(&entered_hook);
            let release = Arc::clone(&release_hook);
            Box::pin(async move {
                if first {
                    entered.notify_one();
                    release.notified().await;
                    Ok(vec![user("stale hook feedback")])
                } else {
                    Ok(Vec::new())
                }
            })
        })),
        ..Default::default()
    }));
    let running = Arc::clone(&agent);
    let run = tokio::spawn(async move { running.prompt("original").await });
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    agent.follow_up(user("newer input"));
    release.notify_one();
    tokio::time::timeout(Duration::from_secs(2), run)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let users = agent
        .state()
        .await
        .messages
        .into_iter()
        .filter_map(|message| {
            if let AgentMessage::Standard(Message::User(row)) = message {
                Some(row.content)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(
        users,
        vec![
            UserContent::Parts(vec![pa_agent::types::UserPart::Text(
                pa_agent::types::TextContent {
                    text: "original".into(),
                    text_signature: None
                }
            )]),
            UserContent::Text("newer input".into())
        ]
    );
    assert_eq!(provider.calls().len(), 2);
}
