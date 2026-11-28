//! The opt-in gate and the at-most-once owner-to-bot send, against a
//! fake guest daemon on a socket pair.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use std::collections::BTreeMap;

use super::commands::{
    admit_bot_spawn, admit_nested_spawn, BOTS_DISABLED_MESSAGE, BOT_MAY_NOT_SPAWN_MESSAGE,
};
use super::guest::GuestClient;
use super::ledger::{recover_all, BotLedger, MessageState};
use super::send::{send_message, send_task, send_within, SendError};

#[tokio::test]
async fn a_bot_spawn_is_refused_until_the_user_opts_in() {
    let dir = tempfile::tempdir().unwrap();
    let settings = dir.path().join("settings.json");
    for document in [
        None,
        Some(r#"{"bots": {"enabled": false}}"#),
        Some(r#"{"bots": {"enabled": "true"}}"#),
        Some("{ not json"),
    ] {
        if let Some(document) = document {
            std::fs::write(&settings, document).unwrap();
        }
        let refused = admit_bot_spawn(dir.path(), false)
            .await
            .expect_err("the gate refuses");
        assert_eq!(refused.to_string(), BOTS_DISABLED_MESSAGE);
    }
    std::fs::write(&settings, r#"{"bots": {"enabled": true}}"#).unwrap();
    admit_bot_spawn(dir.path(), false)
        .await
        .expect("the opt-in admits");
    // The refusals moved no bot state.
    assert!(!dir.path().join("bots").exists());
}

/// Inside a bot, the nested context decides: without it the spawn fails
/// with the bot refusal (never a platform call), and the `bots=True` flag
/// cannot pass the depth cap on.
#[tokio::test]
async fn a_bot_without_the_nested_context_may_not_spawn_bots() {
    let dir = tempfile::tempdir().unwrap();
    // The guest settings opt in; the nested context is what is missing.
    let refused = admit_nested_spawn(dir.path(), false)
        .await
        .expect_err("a bot without the context refuses");
    assert_eq!(refused.to_string(), BOT_MAY_NOT_SPAWN_MESSAGE);

    // With the context at the depth cap, both the spawn and the flag refuse.
    let context = super::nested::NestedContext {
        bot_id: "bot-a".into(),
        owner_session_id: "owner-1".into(),
        depth: super::MAX_BOT_DEPTH,
        max_bots: 10,
        max_cpu: 16,
        max_memory_gb: 32,
        network_rules: BTreeMap::default(),
    };
    let path = super::nested::NestedContext::path_in(dir.path());
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, serde_json::to_string(&context).unwrap()).unwrap();
    let refused = admit_nested_spawn(dir.path(), false)
        .await
        .expect_err("the depth cap refuses");
    assert!(refused.to_string().contains("two levels"), "{refused}");
    // The depth cap answer comes first for a flagged spawn too.
    let refused = admit_nested_spawn(dir.path(), true)
        .await
        .expect_err("the depth cap refuses a flagged spawn");
    assert!(refused.to_string().contains("two levels"), "{refused}");

    // One level up, the plain spawn admits and the flag cannot pass on.
    let context = super::nested::NestedContext {
        depth: 1,
        ..context
    };
    std::fs::write(&path, serde_json::to_string(&context).unwrap()).unwrap();
    admit_nested_spawn(dir.path(), false)
        .await
        .expect("a bot with the context admits");
    let refused = admit_nested_spawn(dir.path(), true)
        .await
        .expect_err("the flag cannot pass on");
    assert!(refused.to_string().contains("bots=True"), "{refused}");
}

/// What the fake guest does with one `send_message`.
#[derive(Clone, Copy)]
enum Guest {
    /// Answer with a receipt.
    Answer,
    /// Report the message, then never answer.
    Hold,
    /// Report the message, then close the link.
    Drop,
    /// Report the message, then answer with a failure.
    Fail,
}

/// A fake guest daemon: the hello, then one response per command. Each
/// received message text goes to `received`.
fn fake_guest(
    behavior: Guest,
    received: mpsc::UnboundedSender<String>,
) -> Box<dyn pa_types::platform::transport::TransportStream> {
    let (ours, theirs) = tokio::net::UnixStream::pair().unwrap();
    tokio::spawn(async move {
        let (reader, mut writer) = theirs.into_split();
        let hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "appVersion": crate::protocol::app_version(),
        });
        writer
            .write_all(format!("{hello}\n").as_bytes())
            .await
            .unwrap();
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let envelope: Value = serde_json::from_str(&line).unwrap();
            let _ = received.send(envelope["command"]["message"].as_str().unwrap().to_string());
            match behavior {
                Guest::Answer | Guest::Fail => {}
                Guest::Hold => continue,
                Guest::Drop => break,
            }
            let response = if matches!(behavior, Guest::Fail) {
                json!({
                    "type": "response",
                    "id": envelope["id"],
                    "command": "send_message",
                    "success": false,
                    "error": "worker request timed out",
                })
            } else {
                json!({
                    "type": "response",
                    "id": envelope["id"],
                    "command": "send_message",
                    "success": true,
                    "data": { "id": "guest-msg", "deliveryStatus": "delivered" },
                })
            };
            let _ = writer.write_all(format!("{response}\n").as_bytes()).await;
        }
    });
    Box::new(ours)
}

async fn client(behavior: Guest, received: &mpsc::UnboundedSender<String>) -> GuestClient {
    GuestClient::over_stream(fake_guest(behavior, received.clone()))
        .await
        .unwrap()
}

/// Kill the sending daemon at each ledger step, restart it (boot
/// recovery), and try the same message again: the guest never sees it a
/// second time, and the ledger never claims a delivery it cannot prove.
#[tokio::test]
async fn a_killed_send_is_never_resent() {
    let dir = tempfile::tempdir().unwrap();
    let ledger = Arc::new(BotLedger::new(dir.path(), "bot-1"));
    let (seen_tx, mut seen) = mpsc::unbounded_channel::<String>();

    // Step 1: killed after `sending` is durable, before any receipt.
    let mut held = client(Guest::Hold, &seen_tx).await;
    let task = {
        let ledger = Arc::clone(&ledger);
        tokio::spawn(
            async move { send_message(&ledger, &mut held, "guest", "m1", "first", None).await },
        )
    };
    assert_eq!(seen.recv().await.as_deref(), Some("first"));
    assert_eq!(
        ledger.message_state("m1").unwrap(),
        Some(MessageState::Sending)
    );
    task.abort();
    let _ = task.await;
    // The daemon that wrote the `sending` row is gone.
    let path = dir.path().join("bots/ledger/bot-1.json");
    let mut ledger_doc: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    ledger_doc["messages"]["m1"]["ownerPid"] = json!(0x7fff_fff0_u32);
    ledger_doc["messages"]["m1"]["ownerStartId"] = json!("gone");
    std::fs::write(&path, ledger_doc.to_string()).unwrap();

    // Step 2: killed after the receipt was written.
    let mut answering = client(Guest::Answer, &seen_tx).await;
    send_message(&ledger, &mut answering, "guest", "m2", "second", None)
        .await
        .expect("the guest answered");
    assert_eq!(seen.recv().await.as_deref(), Some("second"));
    assert_eq!(
        ledger.message_state("m2").unwrap(),
        Some(MessageState::Sent)
    );
    drop(answering);

    // Restart: the boot recovery settles the interrupted send. A live
    // writer's rows stay as they are, and a corrupt ledger is skipped.
    std::fs::write(dir.path().join("bots/ledger/bot-0.json"), "{ not json").unwrap();
    let recovery = recover_all(dir.path()).unwrap();
    assert_eq!(
        recovery.uncertain,
        vec![("bot-1".to_string(), "m1".to_string())]
    );
    assert_eq!(recovery.failed.len(), 1);
    assert_eq!(
        ledger.message_state("m1").unwrap(),
        Some(MessageState::Uncertain)
    );
    assert_eq!(
        ledger.message_state("m2").unwrap(),
        Some(MessageState::Sent)
    );

    // Retrying either message reaches nothing.
    let mut fresh = client(Guest::Answer, &seen_tx).await;
    for (msg_id, text) in [("m1", "first"), ("m2", "second")] {
        let refused = send_message(&ledger, &mut fresh, "guest", msg_id, text, None).await;
        assert!(matches!(refused, Err(SendError::NotDelivered(_))));
    }
    // Step 3: a link that drops after the send began is uncertain.
    let mut dropping = client(Guest::Drop, &seen_tx).await;
    let dropped = tokio::time::timeout(
        Duration::from_secs(10),
        send_message(&ledger, &mut dropping, "guest", "m3", "third", None),
    )
    .await
    .expect("the closed link ends the wait");
    assert!(matches!(dropped, Err(SendError::Uncertain(_))));
    assert_eq!(
        ledger.message_state("m3").unwrap(),
        Some(MessageState::Uncertain)
    );
    assert_eq!(seen.recv().await.as_deref(), Some("third"));
    // Step 4: a guest failure may come after its worker took the message.
    let mut failing = client(Guest::Fail, &seen_tx).await;
    let failed = send_message(&ledger, &mut failing, "guest", "m4", "fourth", None).await;
    assert!(matches!(failed, Err(SendError::Uncertain(_))));
    assert_eq!(seen.recv().await.as_deref(), Some("fourth"));
    // The guest saw each message exactly once.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(seen.try_recv().is_err(), "a resend reached the guest");
}

/// A send its deadline cuts after the `sending` row is durable is
/// `uncertain`; one cut before that row is not delivered.
#[tokio::test]
async fn a_send_past_its_deadline_is_uncertain() {
    let dir = tempfile::tempdir().unwrap();
    let ledger = BotLedger::new(dir.path(), "bot-1");
    let (seen_tx, mut seen) = mpsc::unbounded_channel::<String>();
    let mut held = client(Guest::Hold, &seen_tx).await;
    let cut = send_within(
        &ledger,
        "m1",
        Duration::from_millis(200),
        send_message(&ledger, &mut held, "guest", "m1", "first", None),
    )
    .await;
    assert!(matches!(cut, Err(SendError::Uncertain(_))));
    assert_eq!(
        ledger.message_state("m1").unwrap(),
        Some(MessageState::Uncertain)
    );
    assert_eq!(seen.recv().await.as_deref(), Some("first"));

    let never_began = send_within(
        &ledger,
        "m2",
        Duration::from_millis(200),
        std::future::pending::<Result<(), SendError>>(),
    )
    .await;
    assert!(matches!(never_began, Err(SendError::NotDelivered(_))));
    assert_eq!(ledger.message_state("m2").unwrap(), None);
}

/// A spawn's task is the guest session's prompt, with the label a local
/// child's task carries, under the same ledger rules.
#[tokio::test]
async fn a_task_prompts_the_guest_session() {
    let dir = tempfile::tempdir().unwrap();
    let ledger = BotLedger::new(dir.path(), "bot-1");
    let (seen_tx, mut seen) = mpsc::unbounded_channel::<String>();
    let mut answering = client(Guest::Answer, &seen_tx).await;
    send_task(
        &ledger,
        &mut answering,
        "guest",
        "spawn-bot-1",
        "count to 3",
    )
    .await
    .expect("the guest answered");
    assert_eq!(
        seen.recv().await.as_deref(),
        Some("[task from parent]\n\ncount to 3")
    );
    assert_eq!(
        ledger.message_state("spawn-bot-1").unwrap(),
        Some(MessageState::Sent)
    );
}
