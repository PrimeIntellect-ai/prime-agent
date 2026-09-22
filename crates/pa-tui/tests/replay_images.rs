//! Replay-path image rendering: a session file with image blocks renders
//! the same rows the live path shows (the TS replay adds an Image
//! component per result image block, and an image-only user prompt shows
//! the `[image]` placeholder). Drives the same fold the `pa-tui-replay`
//! `--frame` path uses.

use pa_tui::session::{parse_jsonl, JsonlSessionStream, SessionStream};
use pa_tui::theme::{ColorMode, Theme};
use pa_tui::view::AgentView;

fn tiny_png_base64() -> String {
    use base64::Engine;
    let mut bytes = vec![0x89, b'P', b'N', b'G'];
    bytes.extend(vec![0u8; 12]);
    bytes.extend(64u32.to_be_bytes());
    bytes.extend(32u32.to_be_bytes());
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn frame_text(session: &str, width: u16, height: u16, show_images: bool) -> Vec<String> {
    let entries = parse_jsonl(session).expect("session parses");
    let mut stream = JsonlSessionStream::from_entries(entries);
    let mut view = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
    view.show_images = show_images;
    while let pa_tui::session::SessionEvent::Item(item) = stream.poll().expect("poll") {
        view.push(item);
    }
    pa_tui::app::render_frame_text(&mut view, width, height)
}

fn session_with_image(png: &str, with_text_prompt: bool) -> String {
    let prompt = if with_text_prompt {
        r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"what is in this shot"}],"timestamp":1}}
"#
    } else {
        r#"{"type":"message","message":{"role":"user","content":[{"type":"image","data":"QQ==","mimeType":"image/png"}],"timestamp":1}}
"#
    };
    format!(
        r#"{prompt}{{"type":"message","message":{{"role":"assistant","content":[{{"type":"toolCall","id":"toolu_1","name":"vision","arguments":{{}}}}],"timestamp":2}}}}
{{"type":"message","message":{{"role":"toolResult","toolCallId":"toolu_1","toolName":"vision","content":[{{"type":"text","text":"inspected the frame"}},{{"type":"image","data":"{png}","mimeType":"image/png"}}],"isError":false,"timestamp":3}}}}"#
    )
}

#[test]
fn replayed_image_blocks_render_placeholder_rows() {
    let png = tiny_png_base64();
    let session = session_with_image(&png, /* with_text_prompt */ false);
    let rows = frame_text(&session, 100, 30, /* show_images */ true);
    let flat = rows.join("\n");
    // Image-only prompt: the `[image]` placeholder (TS conversation
    // components' user branch).
    assert!(flat.contains("[image]"), "image-only user row: {flat}");
    // The result's image block: the metadata row below the tool card
    // (dimensions parsed from the payload).
    assert!(
        flat.contains("\u{2570}\u{2500} [image/png \u{b7} 64\u{d7}32]"),
        "image metadata row: {flat}"
    );
}

#[test]
fn replayed_images_hidden_setting_swaps_the_placeholder_form() {
    let png = tiny_png_base64();
    let session = session_with_image(&png, /* with_text_prompt */ true);
    let rows = frame_text(&session, 100, 30, /* show_images */ false);
    let flat = rows.join("\n");
    // Hidden images contribute the `[Image: ...]` text through the
    // output preview, not the metadata row.
    assert!(flat.contains("[Image: [image/png] 64x32]"), "got: {flat}");
    assert!(!flat.contains("\u{2570}\u{2500} [image/png"), "got: {flat}");
}
