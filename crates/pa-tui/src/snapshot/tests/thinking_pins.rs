//! The thinking-channel render pins: the healthy row (a `thinking` block
//! plus a `text` block) and the content-only row (the reasoning merged
//! into the text block) decode and render faithfully; the thinking block
//! is the only detail-gated surface.

use super::*;

#[test]
fn the_two_stored_row_shapes_render_their_channels_faithfully() {
    // The healthy row: the reasoning rides a `thinking` block.
    let healthy_row = json!({
        "role": "assistant",
        "model": "internal/glm-5.3-fast",
        "stopReason": "stop",
        "content": [
            { "type": "thinking", "thinking": "The operator asks: why do we need the nightly cron again?", "thinkingSignature": "reasoning_content" },
            { "type": "text", "text": "**The nightly cron exists for three reasons.**" }
        ]
    });
    // The content-only row: the reasoning merged into the text block.
    let leak_row = json!({
        "role": "assistant",
        "model": "internal/glm-5.3-fast",
        "stopReason": "stop",
        "content": [
            { "type": "text", "text": "The domain-flip PR is green. The plan: let me execute." }
        ]
    });
    let (healthy_blocks, healthy_calls) = assistant_message_parts(&healthy_row);
    assert_eq!(
        healthy_blocks,
        vec![
            MessageBlock::Thinking(
                "The operator asks: why do we need the nightly cron again?".to_string()
            ),
            MessageBlock::Text("**The nightly cron exists for three reasons.**".to_string()),
        ],
        "the healthy row decodes to its thinking and text blocks"
    );
    assert!(healthy_calls.is_empty());
    let (leak_blocks, leak_calls) = assistant_message_parts(&leak_row);
    assert_eq!(
        leak_blocks,
        vec![MessageBlock::Text(
            "The domain-flip PR is green. The plan: let me execute.".to_string()
        )],
        "the content-only row decodes to a single text block"
    );
    assert!(leak_calls.is_empty());

    let frame_text = |view: &mut crate::view::AgentView| -> Vec<String> {
        view.render_frame(80, 30).iter().map(line_text).collect()
    };

    let mut view = test_view();
    for entry in assistant_value_to_entries(&healthy_row) {
        view.push_entry(entry);
    }
    view.detail = crate::chat::Detail::Overview;
    let collapsed = frame_text(&mut view);
    assert!(
        !collapsed
            .iter()
            .any(|row| row.contains("nightly cron again")),
        "the thinking row is hidden at the collapsed level: {collapsed:?}"
    );
    assert!(
        collapsed
            .iter()
            .any(|row| row.contains("nightly cron exists for three reasons")),
        "the text block renders at every level: {collapsed:?}"
    );
    view.detail = crate::chat::Detail::Details;
    let expanded = frame_text(&mut view);
    assert!(
        expanded
            .iter()
            .any(|row| row.contains("nightly cron again")),
        "the thinking row renders once the detail level reveals it: {expanded:?}"
    );
    assert!(
        expanded
            .iter()
            .any(|row| row.contains("nightly cron exists for three reasons")),
        "the text block stays rendered at the revealed level: {expanded:?}"
    );

    let mut leak_view = test_view();
    for entry in assistant_value_to_entries(&leak_row) {
        leak_view.push_entry(entry);
    }
    leak_view.detail = crate::chat::Detail::Overview;
    let leak_collapsed = frame_text(&mut leak_view);
    assert!(
        leak_collapsed
            .iter()
            .any(|row| row.contains("The domain-flip PR is green")),
        "the merged reasoning renders as plain assistant text: {leak_collapsed:?}"
    );
    leak_view.detail = crate::chat::Detail::All;
    let leak_expanded = frame_text(&mut leak_view);
    // The prompt-context strip carries the detail label (the only frame
    // element that changes with the level), so the strip filters it.
    let strip_label = |rows: &[String]| -> Vec<String> {
        rows.iter()
            .filter(|row| !row.contains(" mode ("))
            .cloned()
            .collect()
    };
    assert_eq!(
        strip_label(&leak_collapsed),
        strip_label(&leak_expanded),
        "the text-only row renders identically at every detail level"
    );
}
