//! Lifecycle admission and natural-stop contract through the real agent loop.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pa_agent::agent::{Agent, AgentOptions, AgentPromptInput};
use pa_agent::agent_loop::Continuation;
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
            Box::pin(async { Ok(Vec::new()) })
        })),
        get_continuation_messages: Some(Arc::new(move |_, _| {
            let decision = if continuation_count.fetch_add(1, Ordering::SeqCst) == 0 {
                Continuation::Messages(vec![user("internal autonomous")])
            } else {
                Continuation::NaturalStop
            };
            Box::pin(async { Ok(decision) })
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
        // The host holds the boundary (e.g. queued work), so the stop is not natural.
        get_continuation_messages: Some(Arc::new(|_, _| {
            Box::pin(async { Ok(Continuation::Held) })
        })),
        ..Default::default()
    });
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

fn rejected(reason: &str) -> anyhow::Error {
    anyhow::Error::new(pa_agent::agent_loop::InputRejected(reason.into()))
}

fn has_failure_row(messages: &[AgentMessage]) -> bool {
    messages.iter().any(|message| {
        matches!(
            message,
            AgentMessage::Standard(Message::Assistant(assistant))
                if assistant.error_message.is_some()
        )
    })
}

/// A veto at run entry is one signal: the caller's error. No empty failure
/// row is recorded, and the run is still closed for event listeners.
#[tokio::test]
async fn entry_veto_returns_the_reason_without_a_failure_row() {
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    let agent = Agent::new(AgentOptions {
        stream_fn: Some(provider.stream_fn()),
        before_input: Some(Arc::new(|_, _, _| {
            Box::pin(async { Err(rejected("not this prompt")) })
        })),
        ..Default::default()
    });
    let ended = Arc::new(AtomicUsize::new(0));
    let ended_sink = Arc::clone(&ended);
    let _subscription = agent
        .subscribe(move |event, _| {
            if matches!(event, pa_agent::types::AgentEvent::AgentEnd { .. }) {
                ended_sink.fetch_add(1, Ordering::SeqCst);
            }
            Box::pin(async { Ok(()) })
        })
        .await;
    let error = agent.prompt("vetoed").await.unwrap_err();
    assert_eq!(error.to_string(), "not this prompt");
    assert_eq!(ended.load(Ordering::SeqCst), 1);
    assert!(provider.calls().is_empty());
    assert!(agent.state().await.messages.is_empty());
}

/// A rejected queued batch is dropped; the finished run and its answer stand.
#[tokio::test]
async fn rejected_queued_batch_is_dropped_and_the_run_completes() {
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    provider.push_text_turn("answer");
    let agent = Agent::new(AgentOptions {
        stream_fn: Some(provider.stream_fn()),
        before_input: Some(Arc::new(|users, _, _| {
            let queued = users.iter().any(|row| {
                matches!(row, AgentMessage::Standard(Message::User(user))
                    if user.content == UserContent::Text("queued".into()))
            });
            Box::pin(async move {
                if queued {
                    Err(rejected("queued input rejected"))
                } else {
                    Ok(Vec::new())
                }
            })
        })),
        ..Default::default()
    });
    agent.follow_up(user("queued"));
    agent.prompt("first").await.unwrap();
    assert_eq!(provider.calls().len(), 1);
    let messages = agent.state().await.messages;
    assert!(!has_failure_row(&messages));
    assert!(!messages.iter().any(|message| matches!(
        message,
        AgentMessage::Standard(Message::User(user))
            if user.content == UserContent::Text("queued".into())
    )));
}

/// An abort while the Stop hook runs ends the finished run cleanly: no
/// aborted row follows the final answer and the prompt succeeds.
#[tokio::test]
async fn abort_during_stop_work_keeps_the_finished_run() {
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    provider.push_text_turn("final answer");
    let entered = Arc::new(tokio::sync::Notify::new());
    let entered_hook = Arc::clone(&entered);
    let agent = Arc::new(Agent::new(AgentOptions {
        stream_fn: Some(provider.stream_fn()),
        final_stop: Some(Arc::new(move |_, _, _| {
            entered_hook.notify_one();
            Box::pin(std::future::pending())
        })),
        ..Default::default()
    }));
    let running = Arc::clone(&agent);
    let run = tokio::spawn(async move { running.prompt("go").await });
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    agent.abort();
    tokio::time::timeout(Duration::from_secs(2), run)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let messages = agent.state().await.messages;
    assert!(!has_failure_row(&messages));
    assert!(matches!(
        messages.last(),
        Some(AgentMessage::Standard(Message::Assistant(assistant)))
            if assistant.stop_reason == pa_agent::types::StopReason::Stop
    ));
}

/// Rows the input gate returns (hook context) follow the admitted batch into
/// context; rows the model gate returns enter before the model request.
#[tokio::test]
async fn gate_rows_enter_context_after_the_batch() {
    let provider = Arc::new(ScriptedProvider::new(Model::unknown()));
    provider.push_text_turn("answer");
    let agent = Agent::new(AgentOptions {
        stream_fn: Some(provider.stream_fn()),
        before_input: Some(Arc::new(|_, _, _| {
            Box::pin(async { Ok(vec![user("input context")]) })
        })),
        before_model: Some(Arc::new(|_, _| {
            Box::pin(async { Ok(vec![user("model context")]) })
        })),
        ..Default::default()
    });
    agent.prompt("question").await.unwrap();
    let call = &provider.calls()[0];
    let texts: Vec<String> = call
        .messages
        .iter()
        .map(|message| format!("{message:?}"))
        .collect();
    let position = |needle: &str| texts.iter().position(|text| text.contains(needle)).unwrap();
    assert!(position("question") < position("input context"));
    assert!(position("input context") < position("model context"));
}
