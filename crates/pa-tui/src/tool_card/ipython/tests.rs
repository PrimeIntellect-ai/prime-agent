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
    let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
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
    let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
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
    let lines = render(&card, 0, Detail::All, &theme(), 100, true);
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
    let lines = render(&card, 0, Detail::All, &theme(), 100, true);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat.iter().any(|row| row.contains("ValueError: boom")),
        "got: {flat:?}"
    );
}

#[test]
fn sent_agent_messages_render_below_the_code() {
    // TS `renderSentAgentMessages`: the receipt summary renders below
    // the code with a blank separator, the body opens up in the
    // expanded view.
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
    let collapsed = render(&card, 0, Detail::Overview, &theme(), 100, true);
    let flat: Vec<String> = collapsed.iter().map(text_of).collect();
    assert_eq!(flat.len(), 2, "top line + receipt summary: {flat:?}");
    assert!(
        flat[1]
            .trim_end()
            .starts_with(" \u{2709} Agent message \u{b7} \u{2191} Worker"),
        "got: {flat:?}"
    );
    assert!(!flat[1].contains("Ping."), "no body when collapsed");

    let expanded = render(&card, 0, Detail::All, &theme(), 100, true);
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
    // The summary carries no body preview and no receipt metadata.
    assert!(!flat.iter().any(|row| row.contains("agentmsg_1")));
    assert!(!flat.iter().any(|row| row.contains("deliveryStatus")));
}

#[test]
fn sent_agent_message_receipts_share_the_viewer_relative_arrow() {
    // Both receipt kinds (delivered and queued) render the same shared
    // `Agent message` label with the outgoing `↑` arrow (the operator's
    // 2026-09-25 directive); the counterpart falls back name -> active
    // session id -> session id -> unknown.
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
        let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
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
    let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
    assert!(
        text_of(&lines[1]).contains("Agent message \u{b7} \u{2191} peer-session"),
        "got: {}",
        text_of(&lines[1])
    );
    // Malformed entries render nothing.
    let details = json!({
        "status": "ok",
        "sentAgentMessages": [{ "id": "agentmsg_4" }, { "message": 1 }],
    });
    let card = cell_card("send()", details, false, false);
    let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
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
    let lines = render(&card, 0, Detail::All, &theme(), 100, true);
    assert!(lines.len() > 1, "all mode expands rows");
    let collapsed = render(&card, 0, Detail::Overview, &theme(), 100, true);
    let details = render(&card, 0, Detail::Details, &theme(), 100, true);
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
    let lines = render(&card, 0, Detail::All, &theme(), 100, true);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(flat[0].contains("bash"), "got: {flat:?}");
    assert!(flat[1].contains("%%bash"), "got: {flat:?}");
    assert!(flat[2].contains("echo hi"), "got: {flat:?}");
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
    let lines = render(&card, 0, Detail::Overview, &theme(), 100, true);
    let text = text_of(&lines[0]);
    assert!(text.contains("cell 12ms"), "got: {text}");
    let details = json!({
        "status": "ok",
        "durationMs": 12,
        "result": "<BashHandle pid=421 exit_code=1 command='sleep 0.1'>",
    });
    let card2 = cell_card(code, details, false, false);
    let lines = render(&card2, 0, Detail::Overview, &theme(), 100, true);
    let text = text_of(&lines[0]);
    assert!(text.contains("exit 1"), "got: {text}");
    assert!(text.contains("\u{2717}"), "got: {text}");
}

#[test]
fn partial_cell_shows_waiting_for_output() {
    let card = cell_card("print(2)", json!({ "status": "ok" }), false, true);
    let lines = render(&card, 0, Detail::All, &theme(), 100, true);
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
    let lines = render(&card, 0, Detail::All, &theme(), 100, true);
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
    let lines = render(&card, 0, Detail::All, &theme(), 100, false);
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
    let lines = render(&card, 0, Detail::All, &theme(), 100, true);
    let flat: Vec<String> = lines.iter().map(text_of).collect();
    assert!(
        flat.iter().any(|row| row.contains("no output")),
        "got: {flat:?}"
    );
}

#[test]
fn geometry_matches_paint_across_cell_branches() {
    let mut cards = vec![image_cell_card(), ToolCallCard::default()];
    for code in [
        "",
        "!echo hi\n",
        "%%bash\necho 界",
        "x = '界é😀'\n\nprint(x)\t# hi",
    ] {
        for details in [
            json!({}),
            json!({"stdout": "abc def 界\n\n", "stderr": "err\n", "result": "value", "backgroundOutput": "async\nlog"}),
            json!({"error": {"ename": "ValueError", "evalue": "boom", "traceback": []}}),
            json!({"error": {"ename": "ValueError", "evalue": "boom", "traceback": ["Traceback", "ValueError: boom"]}}),
            json!({"sentAgentMessages": [{"message": "hello 界\n\nworld", "deliveryStatus": "delivered", "receiverRole": "parent", "target": {"sessionName": "Worker"}}, {"id": "invalid"}]}),
            json!({"diffs": [{"path": "x", "diff": "-x\n+y"}], "stdout": "Edited x"}),
        ] {
            for partial in [false, true] {
                let card = cell_card(code, details.clone(), false, partial);
                cards.push(card);
            }
        }
    }
    for text in [
        "before\nTraceback (most recent call last):\nValueError: boom",
        "plain 界\n\n",
    ] {
        let mut card = cell_card("print(x)", json!({"status": "error"}), true, false);
        card.result.as_mut().unwrap().content = vec![
            json!({"type": "text", "text": text}),
            json!({"type": "image"}),
        ];
        cards.push(card);
    }
    for card in &cards {
        for width in [0, 1, 2, 3, 4, 5, 8, 20, 80] {
            for detail in [Detail::Overview, Detail::Details, Detail::All] {
                for show_images in [false, true] {
                    let painted = render(card, 3, detail, &theme(), width, show_images);
                    assert_eq!(
                        count(card, 3, detail, &theme(), width, show_images),
                        painted.len(),
                        "width={width} detail={detail:?} card={card:?}"
                    );
                }
            }
        }
    }
}
