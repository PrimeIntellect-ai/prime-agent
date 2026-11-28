//! Delivery across a Mac daemon restart: each settled turn and outbox line
//! reaches the owner once; a delivery a crash interrupted is never repeated.

use std::sync::{Arc, Mutex};

use anyhow::Result;
use pa_types::daemon::DaemonCommand;
use serde_json::{json, Value};

use super::{
    follows, pause_verdict, sync_deliveries, Follow, GuestCommands, PauseVerdict, MAX_ANSWER_PARTS,
    MAX_OUTBOX_PAGES, PAUSE_GRACE,
};
use crate::bots::ledger::{BotLedger, DeliveryState};
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
    /// Answer every outbox read from the first line, ignoring `after_seq`.
    replay_outbox: bool,
    outbox_reads: usize,
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
                self.outbox_reads += 1;
                assert!(self.outbox_reads < 50, "the owner keeps reading the outbox");
                let after_seq = if self.replay_outbox { 0 } else { *after_seq };
                let entries: Vec<Value> = (1u64..)
                    .zip(&self.outbox)
                    .filter(|(seq, _)| *seq > after_seq)
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

    // A crash after the `sending` write: that turn is never resent.
    guest.turn("a3", "third answer");
    let ledger = BotLedger::new(dir.path(), "bot-1");
    ledger.mark_turn("a3", DeliveryState::Sending).unwrap();
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

    // A longer answer is cut after the last part, with a note.
    let answer = answer.repeat(3);
    guest.turn("a2", &answer);
    let parts = sync(dir.path(), &mut guest).await;
    assert_eq!(parts.len(), MAX_ANSWER_PARTS + 1);
    assert!(parts[MAX_ANSWER_PARTS - 1].starts_with(&format!(
        "[bot answer part {MAX_ANSWER_PARTS}/{MAX_ANSWER_PARTS}]"
    )));
    assert!(parts[MAX_ANSWER_PARTS].contains("rlm.pull_bot_files"));

    // A backlog longer than one read page is read page by page, up to
    // the page cap; the rest arrives on the next sync.
    guest.clock += 10;
    let clock = guest.clock;
    let lines: Vec<String> = (0..READ_PAGE_LINES * MAX_OUTBOX_PAGES + 3)
        .map(|index| format!("line {index}"))
        .collect();
    guest
        .outbox
        .extend(lines.iter().map(|line| (line.clone(), clock)));
    let mut delivered = sync(dir.path(), &mut guest).await;
    assert_eq!(delivered.len(), READ_PAGE_LINES * MAX_OUTBOX_PAGES);
    delivered.extend(sync(dir.path(), &mut guest).await);
    assert_eq!(delivered, lines);
}

/// A guest whose outbox reads never move past old lines delivers each
/// line once and ends the sync.
#[tokio::test]
async fn a_guest_that_repeats_its_outbox_page_ends_the_sync() {
    let dir = tempfile::tempdir().unwrap();
    let mut guest = FakeGuest {
        replay_outbox: true,
        ..FakeGuest::default()
    };
    let lines: Vec<String> = (0..READ_PAGE_LINES)
        .map(|index| format!("line {index}"))
        .collect();
    guest
        .outbox
        .extend(lines.iter().map(|line| (line.clone(), 1)));
    assert_eq!(sync(dir.path(), &mut guest).await, lines);
    assert!(sync(dir.path(), &mut guest).await.is_empty());
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

#[tokio::test]
async fn background_kernel_work_and_factory_runs_hold_off_the_pause() {
    let dir = tempfile::tempdir().unwrap();
    let mut guest = FakeGuest::default();
    guest.turn("a1", "done");
    guest.state = json!({ "isStreaming": false, "sessionActions": { "queuedCount": 0 } });
    assert_eq!(sync(dir.path(), &mut guest).await, ["done"]);
    // A background shell, a backgrounded cell, or an active factory run
    // outlives the settled turn: the bot must not pause mid-job.
    guest.state["hasBackgroundKernelWork"] = json!(true);
    let verdict = pause_verdict(&mut guest, "guest-session", || true)
        .await
        .unwrap();
    assert_eq!(verdict, PauseVerdict::FollowAgain);
    // Once the background work and the run finish, the pause proceeds.
    guest.state = json!({ "isStreaming": false, "sessionActions": { "queuedCount": 0 } });
    let pause = pause_verdict(&mut guest, "guest-session", || true)
        .await
        .unwrap();
    assert_eq!(pause, PauseVerdict::Pause);
}

#[tokio::test]
async fn a_settled_answer_delivers_while_background_work_holds_the_pause() {
    let dir = tempfile::tempdir().unwrap();
    let mut guest = FakeGuest::default();
    guest.turn("a1", "done");
    // Background kernel work outlives the turn: the delivery lane reads
    // turn work only, so the settled answer still delivers (a stuck
    // settle loop would time out here).
    guest.state = json!({
        "isStreaming": false,
        "hasBackgroundKernelWork": true,
        "sessionActions": { "queuedCount": 0 },
    });
    let delivered = tokio::time::timeout(
        std::time::Duration::from_secs(6),
        sync(dir.path(), &mut guest),
    )
    .await;
    assert_eq!(
        delivered.expect("the answer delivers while background work runs"),
        ["done"]
    );
    // The idle pause still holds on the same state.
    let verdict = pause_verdict(&mut guest, "guest-session", || true)
        .await
        .unwrap();
    assert_eq!(verdict, PauseVerdict::FollowAgain);
    // Once the background work ends, the pause proceeds.
    guest.state = json!({ "isStreaming": false, "sessionActions": { "queuedCount": 0 } });
    let pause = pause_verdict(&mut guest, "guest-session", || true)
        .await
        .unwrap();
    assert_eq!(pause, PauseVerdict::Pause);
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
