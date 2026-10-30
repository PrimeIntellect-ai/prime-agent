use super::*;
use crate::theme::{ColorMode, Theme};
use serde_json::json;

fn theme() -> Theme {
    Theme::builtin("prime", ColorMode::TrueColor)
}

fn cell_card(code: &str, details: Value, is_error: bool, partial: bool) -> ToolCallCard {
    ToolCallCard {
        id: "toolu_1".into(),
        name: "ipython".into(),
        args: json!({ "code": code }),
        started: true,
        result: Some(super::super::ToolResultView {
            content: vec![],
            details,
            is_error,
        }),
        result_partial: partial,
        ..Default::default()
    }
}

/// Render a card whose own detail matches the conversation level, with images shown.
fn render_card(card: &ToolCallCard, detail: Detail) -> Vec<Line> {
    render(card, 0, detail, detail, &theme(), 100, true)
}

fn text_of(line: &Line) -> String {
    line.iter().map(|s| s.content.as_str()).collect()
}

#[test]
fn done_cell_summary_line() {
    let card = cell_card(
        "print('visual parity ok')",
        json!({
            "status": "ok",
            "durationMs": 2,
            "stdout": "visual parity ok\n",
        }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::Overview);
    assert_eq!(lines.len(), 1);
    let text = text_of(&lines[0]);
    assert!(
            text.contains("\u{2713} python \u{00b7} print('visual parity ok') \u{00b7} \u{2191} 1 \u{2193} 1 lines \u{00b7} 2ms"),
            "got: {text}"
        );
}

#[test]
fn error_cell_summary_line() {
    let card = cell_card(
        "raise ValueError('boom')",
        json!({
            "status": "error",
            "error": { "ename": "ValueError", "evalue": "boom", "traceback": [] },
        }),
        true,
        false,
    );
    let lines = render_card(&card, Detail::Overview);
    let text = text_of(&lines[0]);
    assert!(text.contains("\u{2717} python"), "got: {text}");
    assert!(text.contains("ValueError"), "got: {text}");
}

#[test]
fn expanded_renders_code_and_output() {
    let card = cell_card(
        "for i in range(3):\n    print(f'line {i}')",
        json!({
            "status": "ok",
            "durationMs": 3,
            "stdout": "line 0\nline 1\nline 2\n",
        }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::All);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat[1].starts_with(" \u{2570}\u{2500} for i in range(3):"),
        "got: {flat:?}"
    );
    assert!(
        flat[2].starts_with("        print(f'line {i}')"),
        "got: {flat:?}"
    );
    assert_eq!(flat[3], "", "blank between code and output");
    assert!(flat[4].starts_with("  \u{203a} line 0"), "got: {flat:?}");
    assert!(flat[5].starts_with("    line 1"), "got: {flat:?}");
}

#[test]
fn expanded_error_cell_shows_traceback() {
    let card = cell_card(
        "raise ValueError('boom')",
        json!({
            "status": "error",
            "error": {
                "ename": "ValueError",
                "evalue": "boom",
                "traceback": ["Traceback (most recent call last):", "ValueError: boom"],
            },
        }),
        true,
        false,
    );
    let lines = render_card(&card, Detail::All);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat.iter().any(|row| row.contains("ValueError: boom")),
        "got: {flat:?}"
    );
}

#[test]
fn sent_agent_messages_render_below_the_code() {
    let details = json!({
        "status": "ok",
        "durationMs": 3,
        "sentAgentMessages": [{
            "id": "agentmsg_1",
            "message": "Ping.\nThen report back.",
            "deliveryStatus": "delivered",
            "receiverRole": "parent",
            "target": {
                "activeSessionId": "worker-active",
                "sessionId": "worker-session",
                "sessionName": "Worker",
            },
        }],
    });
    let card = cell_card(
        "await agent_message.send(\"Ping.\", receiver_role=\"parent\")",
        details,
        false,
        false,
    );
    let collapsed = render_card(&card, Detail::Overview);
    let flat: Vec<String> = collapsed.iter().map(text_of).collect();
    assert_eq!(flat.len(), 2, "top line + receipt summary: {flat:?}");
    assert!(
        flat[1]
            .trim_end()
            .starts_with(" \u{2709} Agent message \u{b7} \u{2191} Worker"),
        "got: {flat:?}"
    );
    assert!(!flat[1].contains("Ping."), "no body when collapsed");

    let expanded = render_card(&card, Detail::All);
    let flat: Vec<String> = expanded.iter().map(text_of).collect();
    let summary = flat
        .iter()
        .position(|row| row.contains("Agent message \u{b7} \u{2191} Worker"))
        .expect("summary row");
    assert_eq!(flat[summary - 1], "", "blank between code and receipt");
    assert_eq!(
        flat[summary].trim_end(),
        " \u{2709} Agent message \u{b7} \u{2191} Worker"
    );
    assert_eq!(flat[summary + 1], " \u{2570}\u{2500} Ping.");
    assert_eq!(flat[summary + 2], "    Then report back.");
    assert!(!flat.iter().any(|row| row.contains("agentmsg_1")));
    assert!(!flat.iter().any(|row| row.contains("deliveryStatus")));
}

#[test]
fn sent_agent_message_receipts_share_the_viewer_relative_arrow() {
    // Both receipt kinds render the shared `Agent message` label with
    // the outgoing `↑` arrow (the operator's 2026-09-25 directive).
    for delivery in ["delivered", "queued"] {
        let details = json!({
            "status": "ok",
            "sentAgentMessages": [{
                "id": "agentmsg_2",
                "message": "Ping.",
                "deliveryStatus": delivery,
                "receiverRole": "child",
                "target": { "activeSessionId": "worker-active", "sessionId": "worker-session" },
            }],
        });
        let card = cell_card("send()", details, false, false);
        let lines = render_card(&card, Detail::Overview);
        let text = text_of(&lines[1]);
        assert!(
            text.contains("\u{2709} Agent message \u{b7} \u{2191} worker-active"),
            "got: {text}"
        );
    }
    let details = json!({
        "status": "ok",
        "sentAgentMessages": [{
            "id": "agentmsg_3",
            "message": "Ping.",
            "deliveryStatus": "queued",
            "target": { "sessionId": "peer-session" },
        }],
    });
    let card = cell_card("send()", details, false, false);
    let lines = render_card(&card, Detail::Overview);
    assert!(
        text_of(&lines[1]).contains("Agent message \u{b7} \u{2191} peer-session"),
        "got: {}",
        text_of(&lines[1])
    );
    let details = json!({
        "status": "ok",
        "sentAgentMessages": [{ "id": "agentmsg_4" }, { "message": 1 }],
    });
    let card = cell_card("send()", details, false, false);
    let lines = render_card(&card, Detail::Overview);
    assert_eq!(lines.len(), 1, "malformed receipts skipped: {lines:?}");
}

#[test]
fn collapsed_stays_single_line() {
    let card = cell_card(
        "print(1)",
        json!({ "status": "ok", "stdout": "1\n" }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::All);
    assert!(lines.len() > 1, "all mode expands rows");
    let collapsed = render_card(&card, Detail::Overview);
    let details = render_card(&card, Detail::Details);
    assert_eq!(collapsed.len(), 1);
    assert_eq!(details.len(), 1, "details mode keeps tool output collapsed");
}

#[test]
fn bash_cell_renders_bash_mode_line() {
    let card = cell_card(
        "%%bash\necho hi",
        json!({ "status": "ok", "durationMs": 8, "stdout": "hi\n" }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::All);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(flat[0].contains("bash"), "got: {flat:?}");
    assert!(flat[1].contains("%%bash"), "got: {flat:?}");
    assert!(flat[2].contains("echo hi"), "got: {flat:?}");
}

#[test]
fn running_cell_summary_ticks_live_elapsed() {
    // The live timer (operator feature 2026-10-03): while the cell runs,
    // the duration slot ticks the elapsed since the execution start; the
    // kernel's `durationMs` lands in the same slot when the cell settles.
    let mut card = cell_card("time.sleep(2)", json!({ "status": "ok" }), false, true);
    card.started_at = Some(
        std::time::Instant::now()
            .checked_sub(std::time::Duration::from_millis(1500))
            .expect("the clock is past the start"),
    );
    let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
    let text = text_of(&lines[0]);
    assert!(text.contains("↑ 1 lines"), "got: {text}");
    // The duration slot ticks right after the line counts: the summary's
    // last segment is a live `<seconds>s` value, without pinning the
    // leading second (a descheduled render must not flake the shape).
    let duration_part = text.rsplit(" \u{00b7} ").next().unwrap_or_default();
    assert!(
        duration_part.ends_with('s') && duration_part.trim_end_matches('s').parse::<f64>().is_ok(),
        "the live duration ticks in its own slot: {text}"
    );
    assert!(!text.contains("Took "), "got: {text}");
}

#[test]
fn running_cell_long_preview_keeps_live_duration_visible() {
    // The summary clips from the right, so a preview that fills the width
    // would clip the ticking duration first: while the cell runs, the
    // preview shortens itself to keep the live duration on screen (the
    // settled card keeps its established layout, clipping the same way
    // it always has). The preview words stay under the noise-redaction
    // run length so the descriptor caps at its full 64 units.
    let code = format!("print('{}')", "lorem ipsum ".repeat(8));
    let mut card = cell_card(&code, json!({ "status": "ok" }), false, true);
    card.started_at = Some(
        std::time::Instant::now()
            .checked_sub(std::time::Duration::from_millis(1500))
            .expect("the clock is past the start"),
    );
    let lines = render(&card, 0, Detail::Overview, &theme(), 80, true);
    let text = text_of(&lines[0]);
    // Pre-fix this line is red: the row overflows to 95 columns and the
    // right clip eats the duration slot entirely, so the summary's last
    // segment is a fragment of the line counts, never a duration.
    let duration_part = text.rsplit(" \u{00b7} ").next().unwrap_or_default();
    assert!(
        duration_part.ends_with('s') && duration_part.trim_end_matches('s').parse::<f64>().is_ok(),
        "the live duration stays on screen as its own segment: {text}"
    );
    assert!(crate::width::str_width(&text) <= 80, "got: {text}");
    assert!(
        text.matches("lorem").count() < 8,
        "the preview gave the duration its room: {text}"
    );
}

#[test]
fn background_shell_duration_label_and_exit() {
    let code = "h = bash('sleep 0.1')";
    let details = json!({
        "status": "ok",
        "durationMs": 12,
        "result": "<BashHandle pid=421 running command='sleep 0.1'>",
    });
    let card = cell_card(code, details, false, false);
    let lines = render_card(&card, Detail::Overview);
    let text = text_of(&lines[0]);
    assert!(text.contains("cell 12ms"), "got: {text}");
    let details = json!({
        "status": "ok",
        "durationMs": 12,
        "result": "<BashHandle pid=421 exit_code=1 command='sleep 0.1'>",
    });
    let card2 = cell_card(code, details, false, false);
    let lines = render_card(&card2, Detail::Overview);
    let text = text_of(&lines[0]);
    assert!(text.contains("exit 1"), "got: {text}");
    assert!(text.contains("\u{2717}"), "got: {text}");
}

#[test]
fn aborted_cell_never_renders_done_from_a_stale_exit_code() {
    // The settle shape: a straggler's kept partial carries a background
    // shell that already exited 0, but the aborted stamp is the truth —
    // the turn cut the call off, so the summary renders the aborted
    // marker, never the success checkmark.
    let code = "h = bash('sleep 0.1')";
    let details = json!({
        "status": "ok",
        "durationMs": 12,
        "result": "<BashHandle pid=421 exit_code=0 command='sleep 0.1'>",
    });
    let mut card = cell_card(code, details, false, false);
    card.aborted = true;
    let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
    let text = text_of(&lines[0]);
    assert!(text.contains("\u{2717}"), "got: {text}");
    assert!(!text.contains("\u{2713}"), "got: {text}");
}

#[test]
fn partial_cell_shows_waiting_for_output() {
    let card = cell_card("print(2)", json!({ "status": "ok" }), false, true);
    let lines = render_card(&card, Detail::All);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat.iter().any(|row| row.contains("waiting for output...")),
        "got: {flat:?}"
    );
}

fn image_cell_card() -> ToolCallCard {
    use base64::Engine;
    let mut bytes = vec![0x89, b'P', b'N', b'G'];
    bytes.extend(vec![0u8; 12]);
    bytes.extend(8u32.to_be_bytes());
    bytes.extend(4u32.to_be_bytes());
    let png = base64::engine::general_purpose::STANDARD.encode(bytes);
    ToolCallCard {
        id: "toolu_1".into(),
        name: "ipython".into(),
        args: json!({ "code": "display(img)" }),
        started: true,
        result: Some(super::super::ToolResultView {
            content: vec![json!({ "type": "image", "data": png, "mimeType": "image/png" })],
            details: json!({ "status": "ok", "durationMs": 3 }),
            is_error: false,
        }),
        result_partial: false,
        ..Default::default()
    }
}

#[test]
fn shown_image_counts_render_below_the_cell() {
    let card = image_cell_card();
    let lines = render_card(&card, Detail::All);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat.iter()
            .any(|row| row.contains("1 image rendered below")),
        "got: {flat:?}"
    );
    assert!(
        flat.iter()
            .any(|row| row.contains("\u{2570}\u{2500} [image/png \u{b7} 8\u{d7}4]")),
        "got: {flat:?}"
    );
}

#[test]
fn hidden_image_counts_stay_hidden_with_no_rows() {
    let card = image_cell_card();
    let lines = render(&card, 0, Detail::All, Detail::All, &theme(), 100, false);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat.iter().any(|row| row.contains("1 image hidden")),
        "got: {flat:?}"
    );
    assert!(!flat.iter().any(|row| row.contains("[image/png")));
}

#[test]
fn no_output_placeholder() {
    let card = cell_card(
        "x = 1",
        json!({ "status": "ok", "durationMs": 4 }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::All);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat.iter().any(|row| row.contains("no output")),
        "got: {flat:?}"
    );
}

#[test]
fn bash_dominated_cell_renders_as_bash() {
    let code =
        "r = await sh(\"\"\"\ncd crates/pa-tui\ncargo test -p pa-tui\n\"\"\")\nprint(r.output)";
    let card = cell_card(
        code,
        json!({
            "status": "ok",
            "durationMs": 2,
            "stdout": "ok\n",
            "bashCommands": {
                "first": "\ncd crates/pa-tui\ncargo test -p pa-tui\n",
                "count": 3,
                "lines": 4,
            },
        }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::Overview);
    assert_eq!(lines.len(), 1);
    assert_eq!(
        text_of(&lines[0]),
        " \u{2713} bash \u{00b7} cargo test -p pa-tui \u{00b7} +2 more \u{00b7} \u{2191} 5 \u{2193} 1 lines \u{00b7} 2ms"
    );
    assert_eq!(
        bash_dominated_stats(&card),
        Some(BashCellStats {
            bash_lines: 4,
            cell_lines: 5,
            count: 3,
        })
    );
}

#[test]
fn bash_minority_cell_stays_python() {
    let code = "async def sh(cmd):\n    return await bash(cmd)\nr = await sh(\"ls\")\nprint(r.pid)";
    let card = cell_card(
        code,
        json!({
            "status": "ok",
            "durationMs": 5,
            "stdout": "0\n",
            "bashCommands": { "first": "ls", "count": 1, "lines": 1 },
        }),
        false,
        false,
    );
    let lines = render_card(&card, Detail::Overview);
    assert_eq!(lines.len(), 1);
    assert_eq!(
        text_of(&lines[0]),
        " \u{2713} python \u{00b7} r = await sh(\"ls\") \u{00b7} \u{2191} 4 \u{2193} 1 lines \u{00b7} 5ms"
    );
    assert_eq!(bash_dominated_stats(&card), None);
}

fn edit_cell_card() -> ToolCallCard {
    cell_card(
        "await edit.run('src/app.py', 'x = 1', 'x = 2')",
        json!({
            "status": "ok",
            "durationMs": 5,
            "result": "'Edited src/app.py'",
            "diffs": [{ "path": "src/app.py", "diff": "-10 x = 1\n+10 x = 2\n 11 y = 3\n    ..." }],
        }),
        false,
        false,
    )
}

fn trimmed_rows(lines: &[Line]) -> Vec<String> {
    lines
        .iter()
        .skip(1)
        .map(|line| text_of(line).trim_end().to_string())
        .collect()
}

#[test]
fn edit_diffs_collapse_to_a_file_summary_line_in_overview() {
    let card = edit_cell_card();
    let summary = vec!["    \u{2570}\u{2500} src/app.py +1 -1".to_string()];
    let lines = render(
        &card,
        0,
        Detail::Overview,
        Detail::Overview,
        &theme(),
        40,
        true,
    );
    assert_eq!(trimmed_rows(&lines), summary);
    // A click-expanded card keeps the conversation level's collapsed diff.
    let toggled = render(&card, 0, Detail::All, Detail::Overview, &theme(), 40, true);
    assert!(!trimmed_rows(&toggled)
        .iter()
        .any(|row| row.contains("10 + x = 2")));
}

#[test]
fn edit_diffs_expand_to_numbered_rows_in_details() {
    let card = edit_cell_card();
    let lines = render(
        &card,
        0,
        Detail::Details,
        Detail::Details,
        &theme(),
        40,
        true,
    );
    assert_eq!(
        trimmed_rows(&lines),
        vec![
            "    \u{2570}\u{2500} src/app.py +1 -1".to_string(),
            "  10 - x = 1".to_string(),
            "  10 + x = 2".to_string(),
            "  11   y = 3".to_string(),
            "       ...".to_string(),
        ]
    );
    // Full-width rows on the diff backgrounds.
    assert_eq!(text_of(&lines[2]).chars().count(), 40);
    assert_eq!(
        lines[3][1].style,
        theme()
            .fg_style(ThemeColor::ToolDiffAdded)
            .patch(theme().bg_style(crate::theme::ThemeBg::ToolDiffAddedBg))
    );
    assert_eq!(
        count(
            &card,
            0,
            Detail::Details,
            Detail::Details,
            &theme(),
            40,
            true
        ),
        lines.len()
    );
}

#[test]
fn an_aborted_cell_freezes_its_duration_from_card_timestamps() {
    let now = std::time::Instant::now();
    let mut card = cell_card("print('x')", Value::Null, true, false);
    card.started_at = now.checked_sub(std::time::Duration::from_secs(4));
    card.ended_at = now.checked_sub(std::time::Duration::from_secs(1));
    card.aborted = true;
    let first = render(&card, 0, Detail::Overview, &theme(), 100, true);
    let later = render(&card, 10, Detail::Overview, &theme(), 100, true);
    assert_eq!(
        first, later,
        "a settled timer never repaints a different duration"
    );
    assert!(text_of(&first[0]).contains("3.0s"), "got: {first:?}");
}
