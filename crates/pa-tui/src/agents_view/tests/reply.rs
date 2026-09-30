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
    mode.headline_result("p-live", Ok(Some("line one\nline two".to_string())));
    let frame = frame_text(&mut mode);
    assert!(
        frame.contains("line one") && !frame.contains("line two"),
        "the header renders the first collapsed line only:\n{frame}"
    );
    // A result for another key drops.
    mode.headline_result("other", Ok(Some("nope".to_string())));
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

/// A selection move off the targeted row disarms (TS `moveSelection`'s
/// guard, :1487-1493). The guard rides the move itself, not the key:
/// while armed the composer owns the navigation keys (they edit the
/// draft, exactly like TS's gated list navigation), so the drive calls
/// the production move directly — the shape a future move path takes.
#[test]
fn a_selection_move_off_the_target_disarms() {
    let mut mode = armed_live();
    mode.move_selection(1);
    assert!(
        matches!(mode.composer, Composer::Search),
        "the move disarms the reply"
    );
    // The move back onto the row does not re-arm (the arm is the space
    // key's act, never a selection side effect).
    mode.move_selection(-1);
    assert!(matches!(mode.composer, Composer::Search));
}

/// The submit: Enter on a typed draft dispatches the whole-object
/// request; alt+enter queues the follow-up; a streaming target steers;
/// the failure restores the draft, the success disarms and reports.
#[test]
fn enter_submits_the_reply_and_the_outcomes_land() {
    let mut mode = armed_live();
    // A trailing backslash + Enter is the editor's newline (TS's
    // shift+enter workaround), not a send; the plain Enter sends.
    for key in ["f", "o", "o", "\\", "enter", "b", "a", "r", "enter"] {
        mode.handle_key(key);
    }
    let request = mode.pending_reply.take().expect("the send dispatched");
    assert_eq!(
        request,
        ReplyRequest {
            key: "p-live".to_string(),
            summary: parent_summary("p"),
            text: "foo\nbar".to_string(),
            behavior: None,
            resume_config: serde_json::json!({}),
            cwd_notice: None,
        },
        "the live send dispatches against the current summary"
    );
    // The failure restores the draft and reports; a re-armed composer on
    // the same key keeps its fresh compose (the in-flight guard).
    mode.reply_result("p-live", Err("daemon down".to_string()));
    assert_eq!(
        mode.status_text(),
        Some("Failed to send reply: daemon down")
    );
    assert!(
        matches!(&mode.composer, Composer::Reply(reply) if reply.editor.get_text() == "foo\nbar"),
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
        "p-live",
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
    // The saved target resumes: the config drops the cwd, or overrides
    // it with the notice when the saved directory is gone (the catalog
    // row's cwd points at a path that does not exist — the submit
    // resolves the CURRENT summary from the records).
    let mut saved = mode_with_anchor(None, Vec::new());
    let mut row = saved_catalog_row("/x/saved.jsonl", "saved-1", "a saved session");
    row["cwd"] = serde_json::json!("/nonexistent-reply-e2e");
    saved.saved = vec![row];
    saved.rebuild_rows();
    saved.selected = saved
        .rows
        .iter()
        .position(|row| row.identity.contains("saved.jsonl"))
        .expect("the saved row");
    saved.handle_key("space");
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
    // /name with no args: the usage warning, the draft stays (the
    // restored old draft clears first — the editor kept the rejected
    // command, TS's restore).
    mode.handle_key("ctrl+u");
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
    // The run loop materializes the completion between keys: Enter on
    // the typed-exact `/kill` falls through the open popup and submits.
    let mut live = armed_live();
    for ch in "/kill".chars() {
        live.handle_key(ch.to_string().as_str());
        live.materialize_composer_autocomplete();
    }
    assert!(
        matches!(&live.composer, Composer::Reply(reply) if reply.editor.is_showing_autocomplete())
    );
    live.handle_key("enter");
    assert_eq!(
        live.pending_kill,
        Some(KillRequest {
            key: "p-live".to_string(),
            active_session_id: "p-live".to_string(),
        })
    );
    live.kill_result("p-live", Ok(()));
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

/// The reply autocomplete (TS `createReplyComposerAutocompleteProvider`):
/// only the armed composer completes — the session-owned builtins plus
/// the view commands, never the client builtins (the rejection family).
#[test]
fn the_reply_completion_lists_session_and_view_commands() {
    let mut mode = armed_live();
    mode.handle_key("/");
    mode.materialize_composer_autocomplete();
    let Composer::Reply(reply) = &mode.composer else {
        panic!("armed");
    };
    let labels: Vec<String> = reply
        .editor
        .autocomplete_state()
        .map(|state| state.items.iter().map(|item| item.label.clone()).collect())
        .unwrap_or_default();
    assert!(
        labels.iter().any(|label| label.contains("compact")),
        "the session commands suggest: {labels:?}"
    );
    for expected in ["kill", "name"] {
        assert!(
            labels.iter().any(|label| label.contains(expected)),
            "the view commands suggest: {labels:?}"
        );
    }
    assert!(
        !labels
            .iter()
            .any(|label| label.contains("tree") || label.contains("model")),
        "the client builtins never suggest: {labels:?}"
    );
}

/// An open completion owns Enter (TS's editor applies the selected
/// item; the typed-exact fall-through is what submits): typing `/`
/// completes into the buffer instead of submitting the partial.
#[test]
fn an_open_completion_owns_enter() {
    let mut mode = armed_live();
    mode.handle_key("/");
    mode.materialize_composer_autocomplete();
    assert!(
        matches!(&mode.composer, Composer::Reply(reply)
            if reply.editor.is_showing_autocomplete()),
        "the typed slash opens the completion"
    );
    mode.handle_key("enter");
    let Composer::Reply(reply) = &mode.composer else {
        panic!("the composer stays armed");
    };
    assert!(
        reply.editor.get_text().starts_with('/'),
        "Enter applied the completion instead of submitting:\n{:?}",
        reply.editor.get_text()
    );
    assert!(
        mode.pending_reply.is_none() && mode.pending_kill.is_none(),
        "nothing dispatched behind the popup"
    );
}

/// A persisted target that left the live catalog resumes as saved: the
/// stale runtime id leaves the summary (TS drops it with the archived
/// lifecycle), so the steer gate and the resuming status read it as
/// saved even when the captured summary still says streaming.
#[test]
fn a_target_gone_from_the_catalog_submits_as_a_resume() {
    let mut mode = mode_with_parent_and_child();
    mode.roster[0]["summary"]["isStreaming"] = serde_json::json!(true);
    mode.rebuild_rows();
    mode.handle_key("space");
    assert!(matches!(&mode.composer, Composer::Reply(_)));
    mode.roster = Vec::new();
    mode.rebuild_rows();
    for ch in "hi".chars() {
        mode.handle_key(ch.to_string().as_str());
    }
    mode.handle_key("enter");
    let request = mode.pending_reply.take().expect("the send dispatched");
    assert_eq!(request.behavior, None, "an archived target never steers");
    assert!(
        request.summary.get("activeSessionId").is_none(),
        "the stale runtime id left the summary"
    );
    assert_eq!(mode.status_text(), Some("Resuming session..."));
}

/// A paste never opens the completion (TS `handlePaste` cancels
/// autocomplete and inserts without a new request, editor.ts:1301);
/// the menu waits for the next keystroke.
#[test]
fn a_pasted_slash_never_opens_the_completion() {
    let mut mode = armed_live();
    mode.handle_paste("/");
    mode.materialize_composer_autocomplete();
    let Composer::Reply(reply) = &mode.composer else {
        panic!("armed");
    };
    assert!(
        reply.editor.autocomplete_state().is_none(),
        "the paste leaves the completion closed"
    );
}

/// The open completion renders its panel above the box (the chat's
/// stacking; TS shows the same dropdown through the editor's TUI
/// overlay).
#[test]
fn the_open_completion_renders_the_overlay_panel() {
    let mut mode = armed_live();
    mode.handle_key("/");
    mode.materialize_composer_autocomplete();
    let frame = frame_text(&mut mode);
    assert!(
        frame.contains("compact"),
        "the completion panel renders above the box:\n{frame}"
    );
}

/// A click that moves the selection runs the keyboard rule (TS
/// `moveSelection`'s reply guard): a toggle-click on a nested row stays
/// in the view, and the composer never stays armed against a row the
/// highlight left.
#[test]
fn a_click_off_the_target_disarms_like_a_key_move() {
    let _guard = match crate::mouse_tracking::STATE_TEST_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    crate::mouse_tracking::enable(&mut std::io::stdout()).expect("enable");
    let mut mode = armed_live();
    mode.render_frame(120, 24);
    let clicked = mode
        .rows
        .iter()
        .position(|row| row.kind != RowKind::Agent)
        .expect("a nested row renders");
    let (row, _) = mode
        .click_rows
        .iter()
        .find(|(_, index)| *index == clicked)
        .copied()
        .expect("the nested row is on screen");
    mode.handle_mouse(&mouse_report(row, true, false));
    mode.handle_mouse(&mouse_report(row, false, false));
    assert_eq!(mode.selected, clicked, "the click selected the nested row");
    assert!(
        matches!(mode.composer, Composer::Search),
        "the click off the target disarms the composer"
    );
    crate::mouse_tracking::disable(&mut std::io::stdout()).expect("disable");
}
