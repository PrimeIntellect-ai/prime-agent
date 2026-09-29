//! The reply composer family (TS `toggleReplyTarget`/`sendReply`/the
//! armed key routing): the arm and its headline, the guards, the submit
//! paths, the view commands, and the hint rows.

use super::*;
use crate::agents_view::rename::{Rename, RenameTarget};
use crate::agents_view::reply::{KillRequest, ReplyRequest, ReplySent};
use pa_types::daemon::StreamingBehavior;

/// One armed composer over the fixture's live parent row.
fn armed_live() -> AgentsViewMode {
    let mut mode = mode_with_parent_and_child();
    mode.handle_key("space");
    assert!(
        matches!(&mode.composer, Composer::Reply(_)),
        "the composer armed on the live row"
    );
    mode
}

/// One armed composer over a saved fixture row (the resume target).
fn armed_saved() -> AgentsViewMode {
    let mut mode = mode_with_anchor(None, Vec::new());
    mode.saved = vec![saved_catalog_row(
        "/x/saved.jsonl",
        "saved-1",
        "a saved session",
    )];
    mode.rebuild_rows();
    mode.selected = mode
        .rows
        .iter()
        .position(|row| row.identity.contains("saved.jsonl"))
        .expect("the saved row");
    mode.handle_key("space");
    assert!(
        matches!(&mode.composer, Composer::Reply(_)),
        "the composer armed on the saved row"
    );
    mode
}

/// The flat text of one rendered frame.
fn frame_text(mode: &mut AgentsViewMode) -> String {
    let (frame, _) = mode.render_frame(120, 24);
    frame.iter().map(flat).collect::<Vec<_>>().join("\n")
}

/// The arm: space on the live parent arms the composer, fires the
/// headline fetch, and renders the loading header; the landed headline
/// renders its first line (TS `createAgentsViewReplyHeadline`).
#[test]
fn space_arms_the_live_reply_and_fetches_the_headline() {
    let mut mode = armed_live();
    assert_eq!(
        mode.pending_headline,
        Some(("p-live".to_string(), "p-live".to_string())),
        "the headline fetch targets the live session"
    );
    assert!(
        frame_text(&mut mode).contains("Loading last response..."),
        "the live header shows the loading line"
    );
    // The landed headline renders its first line; a re-targeted or
    // disarmed composer drops a late result (the key guard).
    mode.headline_result(
        "p-live".to_string(),
        Ok(Some("line one\nline two".to_string())),
    );
    let frame = frame_text(&mut mode);
    assert!(
        frame.contains("line one") && !frame.contains("line two"),
        "the header renders the first collapsed line only:\n{frame}"
    );
    // A result for another key drops.
    mode.headline_result("other".to_string(), Ok(Some("nope".to_string())));
    assert!(frame_text(&mut mode).contains("line one"));
}

/// The saved arm starts from the recap: no fetch, the placeholder names
/// the resume, and the header's time is the row's relative age.
#[test]
fn space_arms_the_saved_reply_from_the_recap() {
    let mut mode = armed_saved();
    assert_eq!(mode.pending_headline, None, "the saved arm fetches nothing");
    let frame = frame_text(&mut mode);
    assert!(
        frame.contains("Write a prompt to resume this session"),
        "the saved placeholder:\n{frame}"
    );
    assert!(
        frame.contains("a saved session"),
        "the saved recap rides the header (the firstMessage):\n{frame}"
    );
}

/// The keys while armed (TS `handleInput`'s gates over the editor):
/// down goes to the editor (the selection never moves), ctrl+n is
/// inert, the cancel keys disarm without touching the query, and the
/// exit hint never arms from the composer's cancel.
#[test]
fn armed_keys_route_to_the_editor_and_the_cancels_disarm() {
    let mut mode = armed_live();
    let selected = mode.selected;
    mode.handle_key("down");
    assert_eq!(mode.selected, selected, "down never moves the selection");
    assert!(matches!(&mode.composer, Composer::Reply(_)));
    // ctrl+n (the new-session action) is disabled while armed.
    mode.handle_key("ctrl+n");
    assert!(matches!(&mode.composer, Composer::Reply(_)));
    assert!(!mode.new_session);
    // Esc disarms; the query stays untouched (the composer never owned
    // it).
    mode.handle_key("escape");
    assert!(matches!(mode.composer, Composer::Search));
    // Re-arm; left disarms (TS: onAgentsBack runs before the editor's
    // cursor motions, so Left never moves the cursor while armed).
    mode.handle_key("space");
    mode.handle_key("left");
    assert!(matches!(mode.composer, Composer::Search));
    // Re-arm; ctrl+c disarms without arming the exit hint, and the
    // force-quit guard saw the handled press.
    mode.handle_key("space");
    mode.handle_key("ctrl+c");
    assert!(matches!(mode.composer, Composer::Search));
    assert!(
        !mode.exit_armed,
        "the composer's cancel never arms the exit"
    );
}

/// A move off the targeted row disarms (TS `moveSelection`'s guard).
#[test]
fn a_selection_move_off_the_target_disarms() {
    let mut mode = armed_live();
    mode.handle_key("down");
    assert!(
        matches!(mode.composer, Composer::Search),
        "the move disarms the reply"
    );
}

/// The submit: Enter on a typed draft dispatches the whole-object
/// request; alt+enter queues the follow-up; a streaming target steers;
/// the failure restores the draft, the success disarms and reports.
#[test]
fn enter_submits_the_reply_and_the_outcomes_land() {
    let mut mode = armed_live();
    for ch in "hello".chars() {
        mode.handle_key(ch.to_string().as_str());
    }
    mode.handle_key("enter");
    let request = mode.pending_reply.take().expect("the send dispatched");
    assert_eq!(
        request,
        ReplyRequest {
            key: "p-live".to_string(),
            summary: parent_summary("p"),
            text: "hello".to_string(),
            behavior: None,
            resume_config: serde_json::json!({}),
            cwd_notice: None,
        },
        "the live send dispatches against the current summary"
    );
    // The failure restores the draft and reports; a re-armed composer on
    // the same key keeps its fresh compose (the in-flight guard).
    mode.reply_result("p-live".to_string(), Err("daemon down".to_string()));
    assert_eq!(
        mode.status_text(),
        Some("Failed to send reply: daemon down")
    );
    assert!(
        matches!(&mode.composer, Composer::Reply(reply) if reply.editor.get_text() == "hello"),
        "the failure restores the draft"
    );
    // The success disarms (the empty-editor guard) and reports; the
    // adoption action rides the outcome.
    mode.handle_key("enter");
    assert!(
        mode.pending_reply.take().is_some(),
        "the re-armed draft resubmits"
    );
    mode.reply_result(
        "p-live".to_string(),
        Ok(ReplySent {
            resumed: None,
            cwd_notice: None,
        }),
    );
    assert_eq!(mode.status_text(), Some("Reply sent"));
    assert!(
        matches!(mode.composer, Composer::Search),
        "the success disarms"
    );
    assert_eq!(mode.actions.last(), Some(&"reply_sent"));
}

/// The follow-up key and the streaming behavior (TS `sendReply`'s
/// ladder): alt+enter queues, a streaming target steers, and the saved
/// path resolves the resume config with its missing-directory notice.
#[test]
fn the_follow_up_queues_and_streaming_steers() {
    let mut mode = armed_live();
    // TS `handleReplyFollowUp`: the blank draft is a no-op — nothing
    // dispatches and the composer stays armed.
    mode.handle_key("alt+enter");
    assert!(mode.pending_reply.is_none());
    assert!(matches!(&mode.composer, Composer::Reply(_)));
    for ch in "hello".chars() {
        mode.handle_key(ch.to_string().as_str());
    }
    mode.handle_key("alt+enter");
    assert_eq!(
        mode.pending_reply
            .take()
            .expect("the follow-up dispatched")
            .behavior,
        Some(StreamingBehavior::FollowUp)
    );
    // The live target streams: the plain Enter steers.
    let mut streaming = mode_with_parent_and_child();
    streaming.roster[0]["summary"]["isStreaming"] = serde_json::json!(true);
    streaming.rebuild_rows();
    streaming.handle_key("space");
    for ch in "hi".chars() {
        streaming.handle_key(ch.to_string().as_str());
    }
    streaming.handle_key("enter");
    assert_eq!(
        streaming.pending_reply.take().expect("the send").behavior,
        Some(StreamingBehavior::Steer)
    );
    // The saved target resumes: the config drops the cwd (or overrides
    // it with the notice when the saved directory is gone — the fixture
    // row's /x cwd does not exist).
    let mut saved = armed_saved();
    for ch in "resume me".chars() {
        saved.handle_key(ch.to_string().as_str());
    }
    saved.handle_key("enter");
    let request = saved.pending_reply.take().expect("the resume send");
    assert!(
        request.cwd_notice.is_some(),
        "the missing cwd carries its notice"
    );
    assert!(
        request.resume_config.get("cwd").is_some(),
        "the override replaces the removed cwd"
    );
    assert_eq!(request.behavior, None, "a fresh resume never steers");
}

/// The view commands and the rejection (TS `parseAgentsViewCommand` +
/// `getReplyComposerCommandRejection`): `/name` reuses the rename flow,
/// `/kill` refuses an inactive target, and a client builtin never goes
/// to the model as prompt text.
#[test]
fn view_commands_route_and_reject() {
    let mut mode = armed_live();
    for ch in "/tree".chars() {
        mode.handle_key(ch.to_string().as_str());
    }
    mode.handle_key("enter");
    assert_eq!(
        mode.status_text(),
        Some("/tree is not available here; open the session to run it")
    );
    assert!(
        matches!(&mode.composer, Composer::Reply(reply) if reply.editor.get_text() == "/tree"),
        "the rejected command keeps its draft"
    );
    // /name with no args: the usage warning, the draft stays.
    for ch in "/name".chars() {
        mode.handle_key(ch.to_string().as_str());
    }
    mode.handle_key("enter");
    assert_eq!(mode.status_text(), Some("Usage: /name <session name>"));
    assert!(
        mode.pending_rename.is_none(),
        "the usage warning dispatches nothing"
    );
    // /name with args dispatches the rename against the live target.
    mode.handle_key(" ");
    for ch in "new".chars() {
        mode.handle_key(ch.to_string().as_str());
    }
    mode.handle_key("enter");
    assert_eq!(
        mode.pending_rename,
        Some(Rename {
            target: RenameTarget::Live {
                active_session_id: "p-live".to_string()
            },
            name: "new".to_string(),
        }),
        "the /name dispatch reuses the rename flow"
    );
    // /kill on the saved row: the inactive warning.
    let mut saved = armed_saved();
    for ch in "/kill".chars() {
        saved.handle_key(ch.to_string().as_str());
    }
    saved.handle_key("enter");
    assert_eq!(
        saved.status_text(),
        Some("/kill needs a running agent; this session is inactive")
    );
    // /kill on the live target dispatches, and the landed outcome
    // disarms with the stopped status.
    let mut live = armed_live();
    for ch in "/kill".chars() {
        live.handle_key(ch.to_string().as_str());
    }
    live.handle_key("enter");
    assert_eq!(
        live.pending_kill,
        Some(KillRequest {
            key: "p-live".to_string(),
            active_session_id: "p-live".to_string(),
        })
    );
    live.kill_result("p-live".to_string(), Ok(()));
    assert!(
        matches!(live.composer, Composer::Search),
        "the stopped target disarms"
    );
    assert_eq!(live.status_text(), Some("Agent stopped"));
    assert_eq!(live.actions.last(), Some(&"killed"));
}

/// The hint rows (TS `renderReplyComposerHints`): the confirm word by
/// the target's state, the queue hint while the draft has text, and
/// cancel over the whole cancel binding.
#[test]
fn the_reply_hints_follow_the_target_state() {
    let mode = armed_live();
    assert_eq!(
        flat(&mode.render_hints(120, None)),
        "Enter send   Esc/Ctrl+C cancel",
        "the live idle hint"
    );
    let mut streaming = mode_with_parent_and_child();
    streaming.roster[0]["summary"]["isStreaming"] = serde_json::json!(true);
    streaming.rebuild_rows();
    streaming.handle_key("space");
    assert_eq!(
        flat(&streaming.render_hints(120, None)),
        "Enter steer   Esc/Ctrl+C cancel"
    );
    let mut with_text = armed_live();
    with_text.handle_key("h");
    assert_eq!(
        flat(&with_text.render_hints(120, None)),
        "Enter send   Alt+Enter queue   Esc/Ctrl+C cancel"
    );
    let saved = armed_saved();
    assert_eq!(
        flat(&saved.render_hints(120, None)),
        "Enter resume & send   Esc/Ctrl+C cancel"
    );
}
