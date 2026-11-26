use super::*;
use crate::chat::MessageBlock;
use crate::session::TranscriptItem;
use crate::theme::{ColorMode, Theme};
use crate::view::message_nav::MessageNavDirection::{Next, Prev};

fn view() -> AgentView {
    AgentView::new(Theme::builtin("prime", ColorMode::TrueColor))
}

/// user 0 | assistant 0 (tall) | tool | user 1 | note | user 2 |
/// assistant 2 (tall): anchors 0, 3, 5, and the tail window's top row sits
/// inside the trailing assistant reply (entry 6), like a live session's.
fn mixed() -> AgentView {
    let mut v = view();
    v.push(TranscriptItem::UserMessage {
        text: "user 0".to_string(),
    });
    v.push(TranscriptItem::Assistant {
        blocks: vec![MessageBlock::Text("assistant reply 0\n".repeat(40))],
        has_tool_calls: true,
    });
    v.push(TranscriptItem::ToolCall {
        id: "t0".to_string(),
        name: "bash".to_string(),
        arguments: "{}".to_string(),
    });
    v.push(TranscriptItem::UserMessage {
        text: "user 1\nsecond line".to_string(),
    });
    v.push(TranscriptItem::SystemNote {
        text: "a muted note".to_string(),
    });
    v.push(TranscriptItem::UserMessage {
        text: "user 2\nsecond line".to_string(),
    });
    v.push(TranscriptItem::Assistant {
        blocks: vec![MessageBlock::Text("assistant reply 2\n".repeat(40))],
        has_tool_calls: false,
    });
    v
}

#[test]
fn anchors_list_only_user_entries() {
    let mut v = mixed();
    v.render_frame(80, 24);
    assert_eq!(v.user_message_anchors(), vec![0, 3, 5]);
}

#[test]
fn prev_from_the_tail_lands_the_last_user_message_at_the_top() {
    let mut v = mixed();
    v.render_frame(80, 24);
    assert!(v.is_following());
    v.navigate_messages(Prev);
    let offsets = v.layout_pass(80).offsets;
    assert_eq!(
        v.scroll_top, offsets[5],
        "the last user message owns the top"
    );
    assert_eq!(v.message_nav, Some(5));
}

#[test]
fn the_walk_steps_through_the_anchors_in_order() {
    let mut v = mixed();
    v.render_frame(80, 24);
    v.navigate_messages(Prev);
    let offsets = v.layout_pass(80).offsets;
    assert_eq!(v.scroll_top, offsets[5]);
    v.navigate_messages(Prev);
    assert_eq!(
        v.scroll_top, offsets[3],
        "the walk skips assistant and tool rows"
    );
    assert_eq!(v.message_nav, Some(3));
    v.navigate_messages(Prev);
    assert_eq!(v.scroll_top, offsets[0]);
    v.navigate_messages(Next);
    assert_eq!(v.scroll_top, offsets[3], "next reverses the walk");
    v.navigate_messages(Next);
    assert_eq!(v.scroll_top, offsets[5]);
}

#[test]
fn prev_at_the_first_user_message_is_a_no_op() {
    let mut v = mixed();
    v.render_frame(80, 24);
    v.navigate_messages(Prev);
    v.navigate_messages(Prev);
    v.navigate_messages(Prev);
    assert_eq!(v.message_nav, Some(0));
    let (top, below) = (v.scroll_info().lines_above, v.scroll_info().lines_below);
    v.navigate_messages(Prev);
    assert_eq!(
        v.message_nav, None,
        "the step past the end clears the target"
    );
    assert_eq!(v.scroll_info().lines_above, top, "the window does not move");
    assert_eq!(v.scroll_info().lines_below, below);
    // ...and the next step walks forward to the second anchor.
    v.navigate_messages(Next);
    assert_eq!(v.message_nav, Some(3));
}

#[test]
fn next_at_the_last_user_message_is_a_no_op() {
    let mut v = mixed();
    v.render_frame(80, 24);
    v.navigate_messages(Prev);
    let (top, below) = (v.scroll_info().lines_above, v.scroll_info().lines_below);
    v.navigate_messages(Next);
    assert_eq!(
        v.message_nav, None,
        "past the last anchor the target clears"
    );
    assert_eq!(v.scroll_info().lines_above, top, "the window does not move");
    assert_eq!(v.scroll_info().lines_below, below);
}

#[test]
fn a_cut_off_user_message_comes_fully_into_view() {
    let mut v = mixed();
    v.render_frame(80, 24);
    v.navigate_messages(Prev);
    // One row down puts the landed user message's top above the window.
    v.scroll_by(1);
    let offsets = v.layout_pass(80).offsets;
    // A paused sparse window keeps the position in its anchor, so the
    // absolute top row comes from `scroll_info`, not the stale `scroll_top`.
    assert_ne!(v.scroll_info().lines_above, offsets[5]);
    // Both directions first bring the cut-off user message fully into view
    // (pa-gpui's `offset_in_item` rule), then step past it.
    v.navigate_messages(Prev);
    assert_eq!(
        v.scroll_info().lines_above,
        offsets[5],
        "prev re-lands the cut-off message"
    );
    v.scroll_by(1);
    v.navigate_messages(Next);
    assert_eq!(
        v.scroll_info().lines_above,
        offsets[5],
        "next re-lands the cut-off message"
    );
}

#[test]
fn a_transcript_without_user_messages_never_moves() {
    let mut v = view();
    v.push(TranscriptItem::SystemNote {
        text: "only notes here".to_string(),
    });
    v.render_frame(80, 24);
    let before = v.scroll_info();
    v.navigate_messages(Prev);
    v.navigate_messages(Next);
    assert_eq!(v.scroll_info(), before);
    assert_eq!(v.message_nav, None);
}

#[test]
fn prepending_shifts_the_recorded_anchor() {
    let mut v = mixed();
    v.render_frame(80, 24);
    v.navigate_messages(Prev);
    assert_eq!(v.message_nav, Some(5));
    // The replay seam prepends above the landed anchor: every entry index
    // after the seam shifts by the prepended count.
    v.prepend_entries(vec![crate::chat::ChatEntry::User {
        text: "replayed head".to_string(),
    }]);
    assert_eq!(v.message_nav, Some(6));
}


#[test]
fn first_message_jumps_to_the_first_user_message() {
    let mut v = mixed();
    v.render_frame(80, 24);
    assert!(v.is_following());
    v.navigate_to_first_message();
    let offsets = v.layout_pass(80).offsets;
    assert_eq!(
        v.scroll_top, offsets[0],
        "the first user message owns the top"
    );
    assert_eq!(v.message_nav, Some(0));
}

#[test]
fn last_message_jumps_to_the_last_user_message() {
    let mut v = mixed();
    v.render_frame(80, 24);
    assert!(v.is_following());
    v.navigate_to_last_message();
    let offsets = v.layout_pass(80).offsets;
    assert_eq!(
        v.scroll_top, offsets[5],
        "the last user message owns the top"
    );
    assert_eq!(v.message_nav, Some(5));
}

#[test]
fn first_message_with_no_user_messages_is_no_op() {
    let mut v = view();
    v.push(TranscriptItem::SystemNote {
        text: "only notes here".to_string(),
    });
    v.render_frame(80, 24);
    let before = v.scroll_info();
    v.navigate_to_first_message();
    v.navigate_to_last_message();
    assert_eq!(v.scroll_info(), before);
    assert_eq!(v.message_nav, None);
}

#[test]
fn first_last_message_steps_past_ends_are_no_ops() {
    let mut v = mixed();
    v.render_frame(80, 24);
    v.navigate_to_first_message();
    let (top, below) = (v.scroll_info().lines_above, v.scroll_info().lines_below);
    v.navigate_to_first_message();
    assert_eq!(
        v.message_nav, Some(0),
        "target stays on first anchor"
    );
    assert_eq!(v.scroll_info().lines_above, top, "window does not move");
    assert_eq!(v.scroll_info().lines_below, below);

    v.navigate_to_last_message();
    let (top2, below2) = (v.scroll_info().lines_above, v.scroll_info().lines_below);
    v.navigate_to_last_message();
    assert_eq!(
        v.message_nav, Some(5),
        "target stays on last anchor"
    );
    assert_eq!(v.scroll_info().lines_above, top2, "window does not move");
    assert_eq!(v.scroll_info().lines_below, below2);
}

#[test]
fn first_last_message_re_anchor_cut_off_message() {
    let mut v = mixed();
    v.render_frame(80, 24);
    v.navigate_to_first_message();
    // One row down puts the landed user message's top above the window.
    v.scroll_by(1);
    let offsets = v.layout_pass(80).offsets;
    assert_ne!(v.scroll_info().lines_above, offsets[0]);
    // Re-invoking first_message re-lands the cut-off message.
    v.navigate_to_first_message();
    assert_eq!(
        v.scroll_info().lines_above,
        offsets[0],
        "first_message re-lands the cut-off message"
    );

    v.navigate_to_last_message();
    v.scroll_by(1);
    assert_ne!(v.scroll_info().lines_above, offsets[5]);
    v.navigate_to_last_message();
    assert_eq!(
        v.scroll_info().lines_above,
        offsets[5],
        "last_message re-lands the cut-off message"
    );
}