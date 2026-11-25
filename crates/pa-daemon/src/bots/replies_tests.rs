//! Delivery across a Mac daemon restart: each settled turn and outbox line
//! reaches the owner once; a delivery a crash interrupted is never repeated.

use std::sync::{Arc, Mutex};

use anyhow::Result;
use pa_types::daemon::DaemonCommand;
use serde_json::{json, Value};

use super::{
    follows, pause_verdict, sync_deliveries, Follow, GuestCommands, PauseVerdict, PAUSE_GRACE,
};
use crate::bots::ledger::{recover_all, BotLedger, DeliveryState};
use crate::bots::remote_parent::READ_PAGE_LINES;
use pa_core::session_engine::agent_messaging::DEFAULT_AGENT_MESSAGE_MAX_CHARS;

/// The guest's bot session: its transcript rows and its owner outbox.
#[derive(Default)]
struct FakeGuest {
    rows: Vec<Value>,
    /// Each outbox line with the time it was written.
    outbox: Vec<(String, u64)>,
    clock: u64,
    state: Value,
}

impl FakeGuest {
    /// One turn; `note` is a message the bot sends its owner during it.
    /// Such a turn starts with a custom row (an inbox notice), whose
    /// timestamp is the entry's ISO time.
    fn turn_with(&mut self, id: &str, answer: &str, note: Option<&str>) {
        self.clock += 10;
        let started = self.clock;
        let start_row = if note.is_some() {
            json!({ "role": "custom", "content": "go", "timestamp": crate::util::iso_from_unix_ms(started) })
        } else {
            json!({ "role": "user", "content": "go", "timestamp": started })
        };
        self.rows
            .push(json!({ "id": format!("u-{id}"), "message": start_row }));
        // The note is written after the final generation began, as a reply
        // sent from the last tool call is.
        if let Some(note) = note {
            self.outbox.push((note.to_string(), started + 3));
        }
        self.rows.push(json!({
            "id": id,
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": answer }],
                "timestamp": started + 2,
            },
        }));
    }

    fn turn(&mut self, id: &str, answer: &str) {
        self.turn_with(id, answer, None);
    }
}

impl GuestCommands for FakeGuest {
    fn command(
        &mut self,
        command: &DaemonCommand,
    ) -> impl std::future::Future<Output = Result<Value>> + Send {
        std::future::ready(Ok(match command {
            DaemonCommand::GetSessionMessages { .. } => json!({ "messages": self.rows }),
            DaemonCommand::ReadRemoteParent { after_seq, .. } => {
                let entries: Vec<Value> = (1u64..)
                    .zip(&self.outbox)
                    .filter(|(seq, _)| seq > after_seq)
                    .take(READ_PAGE_LINES)
                    .map(|(seq, (message, at_ms))| json!({ "seq": seq, "id": format!("m{seq}"), "message": message, "atMs": at_ms }))
                    .collect();
                json!({ "entries": entries })
            }
            DaemonCommand::GetState { .. } => self.state.clone(),
            _ => json!({}),
        }))
    }
}

/// One sync against a ledger reopened from disk, as after a restart.
async fn sync(agent_dir: &std::path::Path, guest: &mut FakeGuest) -> Vec<String> {
    let ledger = BotLedger::new(agent_dir, "bot-1");
    let delivered = Arc::new(Mutex::new(Vec::new()));
    sync_deliveries(
        guest,
        &ledger,
        "guest-session",
        || None,
        |text| {
            let delivered = Arc::clone(&delivered);
            async move {
                delivered.lock().unwrap().push(text);
                Ok(())
            }
        },
    )
    .await
    .unwrap();
    let delivered = delivered.lock().unwrap().clone();
    delivered
}

#[tokio::test]
async fn a_restart_never_delivers_a_reply_twice() {
    let dir = tempfile::tempdir().unwrap();
    let mut guest = FakeGuest::default();
    guest.turn("a1", "first answer");
    assert_eq!(sync(dir.path(), &mut guest).await, ["first answer"]);
    assert!(sync(dir.path(), &mut guest).await.is_empty());

    // One settled run delivers one answer, however many messages it took.
    guest.turn("a2", "second answer");
    guest.turn("a2a", "folded answer");
    assert_eq!(sync(dir.path(), &mut guest).await, ["folded answer"]);

    // A run in which the bot messaged its owner answered with that message.
    guest.turn_with("a2b", "noted answer", Some("a note"));
    assert_eq!(sync(dir.path(), &mut guest).await, ["a note"]);

    // The message arrives before its turn shows in the transcript: the
    // turn still counts as replied once it does.
    let rows_before = guest.rows.len();
    guest.turn_with("a2c", "late answer", Some("early note"));
    let late_turn = guest.rows.split_off(rows_before);
    assert_eq!(sync(dir.path(), &mut guest).await, ["early note"]);
    guest.rows.extend(late_turn);
    assert!(sync(dir.path(), &mut guest).await.is_empty());

    // A crash after the `sending` write: boot recovery makes that turn
    // uncertain, and it is never resent.
    guest.turn("a3", "third answer");
    let ledger = BotLedger::new(dir.path(), "bot-1");
    ledger.mark_turn("a3", DeliveryState::Sending).unwrap();
    assert_eq!(recover_all(dir.path()).unwrap().uncertain.len(), 1);
    let turn = ledger.delivery_marks().unwrap().delivered_turn.unwrap();
    assert_eq!(turn.state, DeliveryState::Uncertain);
    guest.turn("a4", "fourth answer");
    assert_eq!(sync(dir.path(), &mut guest).await, ["fourth answer"]);

    // The last delivered turn left the transcript window: nothing is guessed.
    guest.rows.clear();
    guest.turn("a5", "fifth answer");
    assert!(sync(dir.path(), &mut guest).await.is_empty());
    guest.turn("a6", "sixth answer");
    assert_eq!(sync(dir.path(), &mut guest).await, ["sixth answer"]);
}

#[tokio::test]
async fn a_send_only_run_does_not_swallow_the_next_answer() {
    let dir = tempfile::tempdir().unwrap();
    let mut guest = FakeGuest::default();
    guest.turn("a1", "first answer");
    assert_eq!(sync(dir.path(), &mut guest).await, ["first answer"]);
    // The bot answers only with a message; its run ends with a tool-only
    // row and a trailing notice.
    guest.turn_with("a2", "", Some("a note"));
    guest
        .rows
        .push(json!({ "id": "n2", "message": { "role": "custom", "content": "notice", "timestamp": crate::util::iso_from_unix_ms(guest.clock + 5) } }));
    assert_eq!(sync(dir.path(), &mut guest).await, ["a note"]);
    guest.turn("a3", "third answer");
    assert_eq!(sync(dir.path(), &mut guest).await, ["third answer"]);
}

#[tokio::test]
async fn long_answers_and_outbox_backlogs_arrive_whole() {
    let dir = tempfile::tempdir().unwrap();
    let mut guest = FakeGuest::default();
    let answer: String = (0..40_000u32)
        .map(|index| char::from(b'a' + u8::try_from(index % 26).unwrap()))
        .collect();
    guest.turn("a1", &answer);
    let parts = sync(dir.path(), &mut guest).await;
    assert_eq!(parts.len(), 3);
    let mut joined = String::new();
    for (index, part) in parts.iter().enumerate() {
        assert!(part.chars().count() <= DEFAULT_AGENT_MESSAGE_MAX_CHARS);
        let (header, body) = part.split_once('\n').unwrap();
        assert_eq!(header, format!("[bot answer part {}/3]", index + 1));
        joined.push_str(body);
    }
    assert_eq!(joined, answer);

    // A backlog longer than one read page is read page by page.
    guest.clock += 10;
    let clock = guest.clock;
    let lines: Vec<String> = (0..READ_PAGE_LINES * 2 + 3)
        .map(|index| format!("line {index}"))
        .collect();
    guest
        .outbox
        .extend(lines.iter().map(|line| (line.clone(), clock)));
    assert_eq!(sync(dir.path(), &mut guest).await, lines);
}

#[tokio::test]
async fn a_settled_idle_bot_pauses_after_its_turn() {
    let dir = tempfile::tempdir().unwrap();
    let mut guest = FakeGuest::default();
    guest.turn("a1", "done");
    guest.state = json!({ "isStreaming": false, "sessionActions": { "queuedCount": 0 } });
    assert_eq!(sync(dir.path(), &mut guest).await, ["done"]);
    let pause = pause_verdict(&mut guest, "guest-session", || true)
        .await
        .unwrap();
    assert_eq!(pause, PauseVerdict::Pause);
    // A send or an attach during the grace period keeps the bot running.
    let keep = pause_verdict(&mut guest, "guest-session", || false)
        .await
        .unwrap();
    assert_eq!(keep, PauseVerdict::Keep);
    // Queued input starts another turn: follow it instead of pausing.
    guest.state["sessionActions"]["queuedCount"] = json!(1);
    let busy = pause_verdict(&mut guest, "guest-session", || true)
        .await
        .unwrap();
    assert_eq!(busy, PauseVerdict::FollowAgain);
}

#[test]
fn a_send_during_a_boot_catch_up_waits_the_full_grace() {
    follows().lock().unwrap().insert(
        "bot-boot".to_string(),
        Follow {
            running: true,
            again: false,
            grace: std::time::Duration::ZERO,
            pause_at: None,
        },
    );
    crate::supervisor::Supervisor::touch_bot("bot-boot");
    let follows = follows().lock().unwrap();
    let follow = &follows["bot-boot"];
    assert_eq!((follow.again, follow.grace), (true, PAUSE_GRACE));
}
