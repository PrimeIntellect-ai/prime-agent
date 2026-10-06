//! The chat unit battery: the detail cycle, the user/assistant row
//! geometry, the thinking blocks, the loader/retry rows, and the width math.
use super::*;
use crate::osc133::RowMarkers;
use crate::theme::{ColorMode, Theme, ThemeColor};

fn theme() -> Theme {
    Theme::builtin("prime", ColorMode::TrueColor)
}

#[test]
fn backup_switch_loader_renders_the_failover_message() {
    // TS reason "backup": no countdown — the switch re-issues
    // immediately on the backup provider.
    let retry = RetryState {
        attempt: 3,
        max_attempts: 5,
        ends_at: std::time::Instant::now(),
        error_message: "Connection failed".to_string(),
        reason: RetryStartReason::Backup {
            backup_model: "prime-backup/mock-1".to_string(),
        },
    };
    let rows = render_retry(&retry, 0, &theme(), 60);
    let text = rows[1]
        .iter()
        .map(|s| s.content.as_str())
        .collect::<String>();
    assert!(
        text.contains(
            "Primary model unavailable (Connection failed) — retrying on backup model prime-backup/mock-1..."
        ),
        "got: {text}"
    );
}

#[test]
fn retry_loader_renders_countdown() {
    let retry = RetryState {
        attempt: 1,
        max_attempts: 2,
        ends_at: std::time::Instant::now() + std::time::Duration::from_millis(1500),
        error_message: "provider down".to_string(),
        reason: RetryStartReason::Quick,
    };
    let rows = render_retry(&retry, 0, &theme(), 60);
    let text = rows[1]
        .iter()
        .map(|s| s.content.as_str())
        .collect::<String>();
    // The quick-retry line names the error too (the one line the
    // chat shows while the episode runs, updated in place).
    assert!(
        text.contains("provider down — retrying (1/2) in 1s..."),
        "got: {text}"
    );
}

/// The muted pen colors the spinner, and the gap to the label resets to default fg.
#[test]
fn retry_loader_spans_carry_the_ts_sgr_boundaries() {
    let retry = RetryState {
        attempt: 1,
        max_attempts: 2,
        ends_at: std::time::Instant::now() + std::time::Duration::from_millis(1500),
        error_message: "provider down".to_string(),
        reason: RetryStartReason::Quick,
    };
    let t = theme();
    let muted = t.fg_style(ThemeColor::Muted);
    let rows = render_retry(&retry, 0, &t, 60);
    assert_eq!(
        rows[1][..4],
        [
            Span::styled(" ", Style::default()),
            Span::styled(LOADER_FRAMES[0], muted),
            Span::raw(" "),
            Span::styled("provider down — retrying (1/2) in 1s...", muted),
        ]
    );
}

#[test]
fn detail_cycle_visits_all_three_levels() {
    // TS `toggleToolOutputExpansion`: overview -> details -> all -> overview.
    let mut detail = Detail::Overview;
    assert!(!detail.show_thinking());
    assert!(!detail.tool_output_expanded());
    assert!(!detail.edit_diffs_expanded());
    detail = detail.next();
    assert_eq!(detail, Detail::Details);
    assert!(detail.show_thinking());
    assert!(!detail.tool_output_expanded());
    assert!(detail.edit_diffs_expanded());
    detail = detail.next();
    assert_eq!(detail, Detail::All);
    assert!(detail.show_thinking());
    assert!(detail.tool_output_expanded());
    assert!(detail.edit_diffs_expanded());
    detail = detail.next();
    assert_eq!(detail, Detail::Overview);
}

#[test]
fn detail_wire_names_round_trip_with_the_startup_fallback() {
    // The Ctrl+O level persists as the `chatDetail` wire string and
    // reads back; anything unknown is the startup level (operator
    // directive 2026-09-28).
    for detail in [Detail::Overview, Detail::Details, Detail::All] {
        assert_eq!(Detail::from_wire_name(detail.wire_name()), detail);
    }
    assert_eq!(Detail::from_wire_name(""), Detail::Overview);
    assert_eq!(Detail::from_wire_name("verbose"), Detail::Overview);
}

#[test]
fn user_block_renders_box_rows() {
    let rows = render_user_block("Run a quick check.", &theme(), "  ", 60);
    assert_eq!(rows.len(), 3);
    let text = rows[1]
        .iter()
        .map(|s| s.content.as_str())
        .collect::<String>();
    assert_eq!(text.trim(), "Run a quick check.");
    assert_eq!(text.len(), 60);
}

/// The user block's styling tiers: the row background, the
/// `userMessageText` body, and the prompt-highlight token colors.
fn user_block_styles() -> (Style, Style, Style, Style, Style) {
    let theme = theme();
    let bg = theme.bg_style(ThemeBg::UserMessageBg);
    let body = theme.fg_style(ThemeColor::UserMessageText);
    let on_bg = |fg: Style| bg.patch(fg);
    (
        bg,
        on_bg(body),
        on_bg(theme.fg_style(ThemeColor::Accent)),
        on_bg(theme.fg_style(ThemeColor::Success)),
        on_bg(theme.fg_style(ThemeColor::MdLink)),
    )
}

/// One row's runs with adjacent same-style spans merged: the
/// markdown renderer splits words and the restore keeps token runs,
/// so the styled runs — not the span segmentation — are the contract.
fn row_runs(row: &Line) -> Vec<(String, Style)> {
    let mut runs: Vec<(String, Style)> = Vec::new();
    for span in row {
        if let Some((text, style)) = runs.last_mut() {
            if *style == span.style {
                text.push_str(&span.content);
                continue;
            }
        }
        runs.push((span.content.clone(), span.style));
    }
    runs
}

#[test]
fn user_block_keeps_the_link_affordance() {
    crate::hyperlinks::set_hyperlinks_override(Some(true));
    let (bg, body, _, _, _) = user_block_styles();
    let link_url = bg.patch(theme().fg_style(ThemeColor::MdLinkUrl));
    let rows = render_user_block("see [docs](https://x.dev/a)", &theme(), "  ", 60);
    assert_eq!(rows.len(), 3);
    assert_eq!(
        row_runs(&rows[1]),
        vec![
            ("  ".to_string(), bg),
            ("see ".to_string(), body),
            (
                format!(
                    "{}docs{}",
                    crate::hyperlinks::osc8_open("https://x.dev/a"),
                    crate::hyperlinks::OSC8_CLOSE
                ),
                body.add_modifier(ratatui::style::Modifier::UNDERLINED)
            ),
            (" [https://x.dev/a]".to_string(), link_url),
            (" ".repeat(60 - 28), bg),
        ]
    );
    crate::hyperlinks::set_hyperlinks_override(None);
}

#[test]
fn user_block_highlights_argument_tokens() {
    // The argument tokens render in their own colors inside the
    // `userMessageText` body.
    let (bg, body, _, success, md_link) = user_block_styles();
    let rows = render_user_block("fix @Cargo.toml --quiet now", &theme(), "  ", 60);
    assert_eq!(rows.len(), 3);
    assert_eq!(
        row_runs(&rows[1]),
        vec![
            ("  ".to_string(), bg),
            ("fix ".to_string(), body),
            ("@Cargo.toml".to_string(), success),
            (" ".to_string(), body),
            ("--quiet".to_string(), md_link),
            (" now".to_string(), body),
            (" ".repeat(60 - 2 - 27), bg),
        ]
    );
}

#[test]
fn user_block_accents_a_recognized_leading_command() {
    // A leading `/name` naming a recognized command masks in accent
    // over the whole command segment; an unrecognized one renders like
    // any other text.
    let (bg, body, accent, _, _) = user_block_styles();
    let rows = render_user_block("/hotkeys", &theme(), "  ", 40);
    assert_eq!(
        row_runs(&rows[1]),
        vec![
            ("  ".to_string(), bg),
            ("/hotkeys".to_string(), accent),
            (" ".repeat(40 - 2 - 8), bg),
        ]
    );
    let rows = render_user_block("/definitely-not-builtin now", &theme(), "  ", 40);
    let styled = row_runs(&rows[1]);
    assert_eq!(
        styled
            .iter()
            .map(|(t, _)| t.as_str())
            .collect::<String>()
            .trim(),
        "/definitely-not-builtin now"
    );
    assert!(
        styled
            .iter()
            .filter(|(_, s)| s != &bg)
            .all(|(_, s)| s == &body),
        "no accent for unrecognized commands: {styled:?}"
    );
}

#[test]
fn user_block_mask_shields_tokens_from_markdown() {
    // The mask exists so markdown cannot eat or emphasize the token
    // text: an `@path` full of asterisks renders verbatim in the token
    // color, and a long token wraps like plain text.
    let (_, _, _, success, _) = user_block_styles();
    let rows = render_user_block("use @a*b_c and more", &theme(), "  ", 60);
    let text: String = rows[1].iter().map(|s| s.content.as_str()).collect();
    assert!(
        text.contains("@a*b_c"),
        "the token renders verbatim: {text:?}"
    );
    assert!(
        row_runs(&rows[1])
            .iter()
            .any(|(t, s)| t == "@a*b_c" && *s == success),
        "the token renders in success color"
    );
}

#[test]
fn user_block_plain_sources_stay_plain() {
    // A source holding literal mask-range characters masks nothing:
    // the token colors would alias the literals.
    let (bg, body, _, _, _) = user_block_styles();
    let rows = render_user_block("look \u{E000} at @file", &theme(), "  ", 60);
    let styled: Vec<(String, Style)> = rows[1]
        .iter()
        .map(|s| (s.content.clone(), s.style))
        .collect();
    assert!(
        styled
            .iter()
            .filter(|(_, s)| s != &bg)
            .all(|(_, s)| s == &body),
        "a literal-mask source renders whole: {styled:?}"
    );
    // More masked graphemes than the placeholder alphabet holds (6400)
    // mask nothing.
    let long = format!("fix {} now", "@x".repeat(3300));
    let rows = render_user_block(&long, &theme(), "  ", 60);
    let offending: Vec<(String, Style)> = rows
        .iter()
        .flatten()
        .filter(|s| !s.content.contains('\u{1b}'))
        .filter(|s| s.style != body && s.style != bg)
        .map(|s| (s.content.clone(), s.style))
        .collect();
    assert!(
        offending.is_empty(),
        "over-capacity sources render whole: {offending:?}"
    );
}

#[test]
fn user_block_carries_zone_markers() {
    let rows = render_user_block("Run a quick check.", &theme(), "  ", 60);
    // The zone-start sequence leads the first block row; the end and
    // final sequences lead the last block row.
    assert!(crate::osc133::row_markers(&rows[0]).start);
    assert!(crate::osc133::row_markers(&rows[2]).end);
    let first: String = rows[0].iter().map(|s| s.content.as_str()).collect();
    assert!(first.starts_with(crate::osc133::ZONE_START));
    let last: String = rows[2].iter().map(|s| s.content.as_str()).collect();
    assert!(last.starts_with(crate::osc133::ZONE_END_PREFIX));
    // Markers are zero-width: marked rows still measure full width.
    assert_eq!(crate::width::line_width(&rows[0]), 60);
}

#[test]
fn assistant_markers_skip_tool_call_messages() {
    let plain = AssistantMessage {
        blocks: vec![MessageBlock::Text("Done.".to_string())],
        has_tool_calls: false,
        streaming: false,
        error: None,
        aborted: false,
    };
    let rows = render_assistant(
        &plain,
        Detail::Overview,
        &theme(),
        "  ",
        60,
        false,
        &mut crate::markdown::MarkdownBlockCache::default(),
    );
    assert!(crate::osc133::row_markers(&rows[0]).start);
    assert!(crate::osc133::row_markers(rows.last().unwrap()).end);

    let with_tools = AssistantMessage {
        blocks: vec![MessageBlock::Text("Working.".to_string())],
        has_tool_calls: true,
        streaming: false,
        error: None,
        aborted: false,
    };
    let rows = render_assistant(
        &with_tools,
        Detail::Overview,
        &theme(),
        "  ",
        60,
        false,
        &mut crate::markdown::MarkdownBlockCache::default(),
    );
    assert_eq!(crate::osc133::row_markers(&rows[0]), RowMarkers::default());
}

#[test]
fn code_block_indent_rides_the_render_calls() {
    // `markdown.codeBlockIndent`: the settings string flows through
    // render_assistant / render_user_block into every fenced block.
    let message = AssistantMessage {
        blocks: vec![MessageBlock::Text(
            "intro\n\n```\nfn main() {}\n```".to_string(),
        )],
        has_tool_calls: false,
        streaming: false,
        error: None,
        aborted: false,
    };
    let strip_markers = |row: &str| {
        row.replace(crate::osc133::ZONE_END_PREFIX, "")
            .replace(crate::osc133::ZONE_END, "")
            .trim_end()
            .to_string()
    };
    let rows = render_assistant(
        &message,
        Detail::Overview,
        &theme(),
        "    ",
        60,
        false,
        &mut crate::markdown::MarkdownBlockCache::default(),
    );
    let flat: Vec<String> = rows
        .iter()
        .map(|line| line.iter().map(|s| s.content.as_str()).collect::<String>())
        .map(|row| strip_markers(&row))
        .collect();
    assert!(
        flat.iter().any(|row| row == "     fn main() {}"),
        "non-default indent applied: {flat:?}"
    );
    // The default (no setting) stays two spaces.
    let rows = render_assistant(
        &message,
        Detail::Overview,
        &theme(),
        "  ",
        60,
        false,
        &mut crate::markdown::MarkdownBlockCache::default(),
    );
    let flat: Vec<String> = rows
        .iter()
        .map(|line| line.iter().map(|s| s.content.as_str()).collect::<String>())
        .map(|row| strip_markers(&row))
        .collect();
    assert!(
        flat.iter().any(|row| row == "   fn main() {}"),
        "default indent: {flat:?}"
    );
}

#[test]
fn ipython_card_done_line() {
    let card = ToolCallCard {
        id: "toolu_1".into(),
        name: "ipython".into(),
        args: serde_json::json!({ "code": "print('visual parity ok')" }),
        started: true,
        result: Some(ToolResultView {
            content: vec![serde_json::json!({ "type": "text", "text": "visual parity ok" })],
            details: serde_json::json!({ "status": "ok", "durationMs": 2, "stdout": "visual parity ok\n" }),
            is_error: false,
        }),
        result_partial: false,
        ..Default::default()
    };
    let rows = render_tool_card(&card, 0, Detail::Overview, &theme(), 100, true);
    let text = rows[0]
        .iter()
        .map(|s| s.content.as_str())
        .collect::<String>();
    assert!(
        text.contains("\u{2713} python \u{00b7} print('visual parity ok') \u{00b7} \u{2191} 1 \u{2193} 1 lines"),
        "got: {text}"
    );
}

#[test]
fn assistant_error_row_and_spacers() {
    let message = AssistantMessage {
        blocks: vec![MessageBlock::Text("Running the checks.".into())],
        has_tool_calls: false,
        streaming: false,
        error: Some("Error: request failed after retries".into()),
        aborted: false,
    };
    let rows = render_assistant(
        &message,
        Detail::Overview,
        &theme(),
        "  ",
        60,
        false,
        &mut crate::markdown::MarkdownBlockCache::default(),
    );
    let flat: Vec<String> = rows
        .iter()
        .map(|line| line.iter().map(|s| s.content.as_str()).collect())
        .collect();
    assert!(
        flat[0].starts_with(crate::osc133::ZONE_START),
        "leading spacer carries the OSC-133 start marker: {flat:?}"
    );
    assert!(
        flat.iter().any(|row| row.contains("Error: request failed")),
        "got: {flat:?}"
    );
    let message = AssistantMessage {
        blocks: vec![MessageBlock::Text("body".into())],
        has_tool_calls: true,
        streaming: false,
        error: None,
        aborted: false,
    };
    let rows = render_assistant(
        &message,
        Detail::Overview,
        &theme(),
        "  ",
        60,
        true,
        &mut crate::markdown::MarkdownBlockCache::default(),
    );
    assert_eq!(rows.last().unwrap().len(), 0, "trailing spacer");
    let message = AssistantMessage {
        blocks: Vec::new(),
        has_tool_calls: true,
        streaming: false,
        error: None,
        aborted: false,
    };
    let rows = render_assistant(
        &message,
        Detail::Overview,
        &theme(),
        "  ",
        60,
        true,
        &mut crate::markdown::MarkdownBlockCache::default(),
    );
    assert!(rows.is_empty(), "got: {rows:?}");
}

/// An error whose text ends with the login-recovery suffix renders as ONE merged inline
/// line, error-colored and identical across detail modes (never the collapsible component).
#[test]
fn login_recovery_error_renders_one_merged_inline_line() {
    let theme = theme();
    let error_style = theme.fg_style(ThemeColor::Error);
    let message = AssistantMessage {
        blocks: Vec::new(),
        has_tool_calls: false,
        streaming: false,
        error: Some("Auth failed. \n\nRun /login to update credentials.".into()),
        aborted: false,
    };
    for detail in [Detail::Overview, Detail::Details, Detail::All] {
        let rows = render_assistant(
            &message,
            detail,
            &theme,
            "  ",
            60,
            false,
            &mut crate::markdown::MarkdownBlockCache::default(),
        );
        assert_eq!(
            rows,
            vec![
                vec![Span::raw(crate::osc133::ZONE_START)],
                vec![
                    Span::raw(crate::osc133::ZONE_END_PREFIX),
                    Span::raw(" "),
                    Span::styled(
                        "Auth failed. · Run /login to update credentials.",
                        error_style
                    ),
                    Span::raw(" ".repeat(11)),
                ],
            ]
        );
    }
}

/// The exact daemon authentication-failure wording merges: one inline logical line, and
/// the same single line flows across wrapped rows when narrow.
#[test]
fn login_recovery_merges_the_exact_daemon_error_wording() {
    let theme = theme();
    let error_style = theme.fg_style(ThemeColor::Error);
    let message = AssistantMessage {
        blocks: Vec::new(),
        has_tool_calls: false,
        streaming: false,
        error: Some(
            "Authentication failed for \"prime-inference\". Credentials may have expired or network is unavailable.\n\nRun /login to update credentials."
                .into(),
        ),
        aborted: false,
    };
    let merged = "Authentication failed for \"prime-inference\". Credentials may have expired or network is unavailable. · Run /login to update credentials.";
    let rows = render_assistant(
        &message,
        Detail::Overview,
        &theme,
        "  ",
        140,
        false,
        &mut crate::markdown::MarkdownBlockCache::default(),
    );
    assert_eq!(
        rows,
        vec![
            vec![Span::raw(crate::osc133::ZONE_START)],
            vec![
                Span::raw(crate::osc133::ZONE_END_PREFIX),
                Span::raw(" "),
                Span::styled(merged, error_style),
                Span::raw(" ".repeat(3)),
            ],
        ]
    );

    let rows = render_assistant(
        &message,
        Detail::Overview,
        &theme,
        "  ",
        60,
        false,
        &mut crate::markdown::MarkdownBlockCache::default(),
    );
    let flat: Vec<String> = rows
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
                .replace(crate::osc133::ZONE_END_PREFIX, "")
                .replace(crate::osc133::ZONE_START, "")
        })
        .collect();
    assert_eq!(flat.len(), 4, "spacer + 3 wrapped rows: {flat:?}");
    assert_eq!(
        flat[1..],
        vec![
            format!(
                " Authentication failed for \"prime-inference\". Credentials{}",
                " ".repeat(3)
            ),
            " may have expired or network is unavailable. · Run /login to".to_string(),
            format!(" update credentials.{}", " ".repeat(40)),
        ]
    );
}

/// Only an end-of-text suffix with a non-empty, single-line base merges.
#[test]
fn login_recovery_fallthroughs_keep_the_normal_error_rows() {
    let theme = theme();
    let error_style = theme.fg_style(ThemeColor::Error);
    let render = |error: &str, detail: Detail| {
        render_assistant(
            &AssistantMessage {
                blocks: Vec::new(),
                has_tool_calls: false,
                streaming: false,
                error: Some(error.to_string()),
                aborted: false,
            },
            detail,
            &theme,
            "  ",
            60,
            false,
            &mut crate::markdown::MarkdownBlockCache::default(),
        )
    };
    assert_eq!(
        render("Auth failed.", Detail::Overview)[1],
        vec![
            Span::raw(crate::osc133::ZONE_END_PREFIX),
            Span::raw(" "),
            Span::styled("Auth failed.", error_style),
            Span::raw(" ".repeat(47)),
        ]
    );
    // Multi-line base: the collapsible path applies to the full error.
    let multi = "Auth failed\nfor provider.\n\nRun /login to update credentials.";
    assert_eq!(
        render(multi, Detail::Overview)[1],
        vec![
            Span::raw(crate::osc133::ZONE_END_PREFIX),
            Span::raw(" "),
            Span::styled("Auth failed ", error_style),
            Span::raw(" ".repeat(47)),
        ]
    );
    let flat: Vec<String> = render(multi, Detail::All)
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
                .replace(crate::osc133::ZONE_END_PREFIX, "")
                .replace(crate::osc133::ZONE_START, "")
        })
        .collect();
    assert_eq!(
        flat,
        vec![
            String::new(),
            format!(" Auth failed{}", " ".repeat(48)),
            format!(" for provider.{}", " ".repeat(46)),
            // The error's empty line pads to a full-width spaces row —
            // never a truly blank row inside the error body.
            " ".repeat(60),
            format!(" Run /login to update credentials.{}", " ".repeat(26)),
        ]
    );
    let trailing = "Auth failed.\n\nRun /login to update credentials.\nProvider degraded.";
    assert_eq!(
        render(trailing, Detail::Overview)[1],
        vec![
            Span::raw(crate::osc133::ZONE_END_PREFIX),
            Span::raw(" "),
            Span::styled("Auth failed. ", error_style),
            Span::raw(" ".repeat(46)),
        ]
    );
}

/// The aborted message renders its "Operation aborted" row inside the component, in the
/// error color with no "Error: " prefix, behind a spacer.
#[test]
fn aborted_assistant_message_renders_the_red_abort_row() {
    let theme = theme();
    let message = AssistantMessage {
        blocks: vec![MessageBlock::Text("Partial answer.".into())],
        has_tool_calls: true,
        streaming: false,
        error: Some("Operation aborted".into()),
        aborted: true,
    };
    let rows = render_assistant(
        &message,
        Detail::Overview,
        &theme,
        "  ",
        60,
        true,
        &mut crate::markdown::MarkdownBlockCache::default(),
    );
    let abort_row_index = rows
        .iter()
        .position(|line| {
            line.iter()
                .any(|span| span.content.contains("Operation aborted"))
        })
        .expect("the aborted row never rendered");
    // The row before is the spacer, and the trailing tool spacer
    // follows even after tool activity.
    assert_eq!(
        rows[abort_row_index - 1].len(),
        0,
        "no spacer before the abort row"
    );
    let error_style = theme.fg_style(ThemeColor::Error);
    let abort_text = rows[abort_row_index]
        .iter()
        .find(|span| span.content.contains("Operation aborted"))
        .expect("the abort span");
    assert_eq!(
        abort_text.style, error_style,
        "the abort row is not error-colored"
    );
    assert!(
        !rows[abort_row_index]
            .iter()
            .any(|span| span.content.contains("Error: ")),
        "unexpected error prefix"
    );
    assert_eq!(rows.last().unwrap().len(), 0, "trailing spacer");
    // A provider-supplied abort reason renders instead of the generic
    // text.
    let message = AssistantMessage {
        blocks: Vec::new(),
        has_tool_calls: false,
        streaming: false,
        error: Some("aborted by the user".into()),
        aborted: true,
    };
    let rows = render_assistant(
        &message,
        Detail::Overview,
        &theme,
        "  ",
        60,
        false,
        &mut crate::markdown::MarkdownBlockCache::default(),
    );
    assert!(
        rows.iter().any(|line| {
            line.iter()
                .any(|span| span.content.contains("aborted by the user"))
        }),
        "the custom abort reason never rendered: {rows:?}"
    );
}

#[test]
fn loader_line_shape() {
    let working = WorkingState {
        activity: "Writing",
        message: None,
        download: true,
        tokens: 72,
        elapsed_secs: 1,
    };
    let rows = render_loader(&working, 4, &theme(), 100);
    assert_eq!(rows.len(), 2);
    let text = rows[1]
        .iter()
        .map(|s| s.content.as_str())
        .collect::<String>();
    assert!(text.contains("\u{283c} Writing \u{00b7} 1s \u{00b7} \u{2193} 72 tokens"));
}

/// The gap resets to default fg instead of carrying the label color over the gap.
#[test]
fn loader_gap_between_spinner_and_label_is_unstyled() {
    let working = WorkingState {
        activity: "Writing",
        message: None,
        download: true,
        tokens: 72,
        elapsed_secs: 1,
    };
    let t = theme();
    let accent = t.fg_style(ThemeColor::Accent);
    let muted = t.fg_style(ThemeColor::Muted);
    let rows = render_loader(&working, 0, &t, 100);
    assert_eq!(
        rows[1][..4],
        [
            Span::styled(" ", Style::default()),
            Span::styled(LOADER_FRAMES[0], accent),
            Span::raw(" "),
            Span::styled("Writing \u{00b7} 1s \u{00b7} \u{2193} 72 tokens", muted),
        ]
    );
}

/// The loader shows "<message> <elapsed>" and drops the activity label and token count.
#[test]
fn loader_working_message_replaces_the_activity_label() {
    let working = WorkingState {
        activity: "Executing",
        message: Some("\u{203a} setting up python kernel (one-time, ~30s)\u{2026}".into()),
        download: true,
        tokens: 72,
        elapsed_secs: 3,
    };
    let rows = render_loader(&working, 4, &theme(), 100);
    let text = rows[1]
        .iter()
        .map(|s| s.content.as_str())
        .collect::<String>();
    assert!(
        text.contains("\u{283c} \u{203a} setting up python kernel (one-time, ~30s)\u{2026} 3s"),
        "got: {text}"
    );
    assert!(!text.contains("Executing"));
    assert!(!text.contains("72 tokens"));
}

/// "3s" below a minute, then "1m 05s", "1h 02m 03s", "1d 02h 03m 04s".
#[test]
fn elapsed_label_formats_like_ts() {
    assert_eq!(format_working_elapsed(3), "3s");
    assert_eq!(format_working_elapsed(65), "1m 05s");
    assert_eq!(format_working_elapsed(3723), "1h 02m 03s");
    assert_eq!(format_working_elapsed(93784), "1d 02h 03m 04s");
}

/// The live abort row carries the client's retry count and elapsed suffix (the wire row
/// never does).
#[test]
fn live_abort_text_matches_ts() {
    assert_eq!(live_abort_text(0, None), "Operation aborted");
    assert_eq!(live_abort_text(0, Some(3)), "Operation aborted \u{00b7} 3s");
    assert_eq!(
        live_abort_text(1, Some(2)),
        "Aborted after 1 retry attempt \u{00b7} 2s"
    );
    assert_eq!(
        live_abort_text(2, Some(65)),
        "Aborted after 2 retry attempts \u{00b7} 1m 05s"
    );
}
