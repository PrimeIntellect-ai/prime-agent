//! The compact-steps line of a tool card: one semantic summary per call behind its status
//! marker (`Edited <path> (+N -M)`, `Ran <command> (<time>)`, `Python: <intent>`); a click on
//! the line opens the full card.

use serde_json::Value;

use super::ipython::CardStatus;
use super::{panel_status, PanelStatus, ToolCallCard};
use crate::code_preview::preview_bash_command;
use crate::theme::{Theme, ThemeColor};
use crate::width::truncate_line;
use crate::{Line, Span};

/// One tool call's step line, truncated to `width`.
pub(crate) fn step_line(card: &ToolCallCard, frame: usize, theme: &Theme, width: usize) -> Line {
    let mut row: Line = vec![Span::raw(" ")];
    row.extend(match card.name.as_str() {
        name if pa_types::ai::is_python_tool_name(name) => {
            super::ipython::step_summary(card, frame, theme)
        }
        "bash" => bash_summary(card, frame, theme),
        _ => generic_summary(card, frame, theme),
    });
    // Like the full cards, the line shows model-written text and adds no links of its own.
    crate::hyperlinks::strip_osc8(&mut row);
    truncate_line(&row, width, "\u{2026}")
}

/// A step's elapsed time: `800ms` and `3.2s` (the python card's format), then `1m 05s`.
pub(crate) fn format_step_duration(ms: f64) -> String {
    if ms < 60_000.0 {
        super::ipython_details::format_duration(ms)
    } else {
        crate::chat::format_working_elapsed((ms / 1000.0) as u64)
    }
}

/// `Ran <command> (<time>)`: the time while the call runs and once it settled live; a replayed
/// card's timing collapses to the rebuild instant, so it shows none.
fn bash_summary(card: &ToolCallCard, frame: usize, theme: &Theme) -> Line {
    let dim = theme.fg_style(ThemeColor::Dim);
    let command = card
        .args
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let preview = preview_bash_command(command).text;
    let mut line = vec![
        panel_marker(card, frame, theme),
        Span::raw(" "),
        Span::styled("Ran ", theme.fg_style(ThemeColor::Muted)),
        Span::styled(
            if preview.is_empty() {
                "..."
            } else {
                preview.as_str()
            },
            dim,
        ),
    ];
    let elapsed = match (card.started_at, card.ended_at) {
        (Some(started), Some(ended)) => Some(ended - started).filter(|time| !time.is_zero()),
        (Some(started), None) => Some(started.elapsed()),
        _ => None,
    };
    if let Some(elapsed) = elapsed {
        line.push(Span::styled(
            format!(
                " ({})",
                format_step_duration(elapsed.as_secs_f64() * 1000.0)
            ),
            dim,
        ));
    }
    line
}

/// Any other tool: its name and its arguments on one line.
fn generic_summary(card: &ToolCallCard, frame: usize, theme: &Theme) -> Line {
    let mut line = vec![
        panel_marker(card, frame, theme),
        Span::raw(" "),
        Span::styled(card.name.clone(), theme.fg_style(ThemeColor::Muted)),
    ];
    if card.args.as_object().is_some_and(|args| !args.is_empty()) {
        line.push(Span::styled(
            format!(" {}", card.args),
            theme.fg_style(ThemeColor::Dim),
        ));
    }
    line
}

/// The panel cards' status in the python card's marker vocabulary.
fn panel_marker(card: &ToolCallCard, frame: usize, theme: &Theme) -> Span {
    match panel_status(card) {
        PanelStatus::Queued => CardStatus::Queued,
        PanelStatus::Running => CardStatus::Running,
        PanelStatus::Done => CardStatus::Done,
        PanelStatus::Error => CardStatus::Error,
    }
    .marker(frame, theme)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ColorMode;
    use crate::tool_card::ToolResultView;
    use serde_json::json;

    fn cell(code: &str, details: Value) -> ToolCallCard {
        let now = std::time::Instant::now();
        ToolCallCard {
            id: "toolu_1".into(),
            name: "python_repl".into(),
            args: json!({ "code": code }),
            started: true,
            started_at: Some(now),
            ended_at: Some(now),
            result: Some(ToolResultView {
                content: Vec::new(),
                details,
                is_error: false,
            }),
            ..Default::default()
        }
    }

    fn text(card: &ToolCallCard) -> String {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        step_line(card, 0, &theme, 100)
            .iter()
            .map(|span| span.content.as_str())
            .collect()
    }

    /// A cell's line names what it did: the edit with its line counts, the dominant shell
    /// command with its time, or the python statement that carries its intent.
    #[test]
    fn a_cell_summarizes_as_its_edit_its_command_or_its_intent() {
        let edit = cell(
            "await edit.run('src/app.py', 'x = 1', 'x = 2')",
            json!({ "status": "ok", "diffs": [
                { "path": "src/app.py", "diff": "-10 x = 1\n+10 x = 2\n+11 y = 3" },
            ] }),
        );
        assert_eq!(text(&edit), " \u{2713} Edited src/app.py (+2 -1)");
        let shell = cell(
            "r = await bash(\"cargo test -p pa-tui\")",
            json!({ "status": "ok", "durationMs": 800,
                "bashCommands": { "first": "cargo test -p pa-tui", "count": 1, "lines": 1 } }),
        );
        assert_eq!(text(&shell), " \u{2713} Ran cargo test -p pa-tui (800ms)");
        let python = cell(
            "import json\nrows = json.loads(raw)\nprint(len(rows))",
            json!({ "status": "error", "error": { "ename": "NameError", "evalue": "raw", "traceback": [] } }),
        );
        assert_eq!(
            text(&python),
            " \u{2717} Python: rows = json.loads(raw) \u{b7} NameError"
        );
    }
}
