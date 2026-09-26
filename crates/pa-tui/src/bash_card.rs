//! The `!`/`!!` execution card (TS `BashExecutionComponent`,
//! bash-execution.ts): the bordered run box — the `$ command` header, the
//! `Running...` loader, the 20-line tail preview, and the settled status
//! rows — shared by the live `bash_start`/`bash_output`/`bash_end` mount,
//! the replayed durable `bashExecution` row, and the pending-while-streaming
//! hold (TS mounts the same component class in all three spots).

use crate::chat::LOADER_FRAMES;
use crate::error_summary::strip_ansi;
use crate::theme::{Theme, ThemeColor};
use crate::width::wrap_text;
use crate::{Line, Span};

/// The preview's visual-line budget (TS `PREVIEW_LINES`).
const PREVIEW_LINES: usize = 20;

/// One user-bash run card. `output_lines` mirrors the TS component's
/// per-line accumulation (chunks merge into the last open line).
#[derive(Debug, Clone, PartialEq)]
pub struct BashExecutionCard {
    /// The live card's transcript identity (durable rows render
    /// id-lessly like other settled entries).
    pub id: String,
    pub command: String,
    /// The `!!` variant: the border and header render dim instead of the
    /// bash-mode color (TS `excludeFromContext` picks the color key).
    pub excluded: bool,
    /// The accumulated output lines (ANSI-stripped, newlines normalized).
    pub output_lines: Vec<String>,
    /// Whether the run is still going (the loader owns the status row).
    pub running: bool,
    pub exit_code: Option<i64>,
    pub cancelled: bool,
    pub error_message: Option<String>,
    /// The run's output was context-truncated (the notice names the spill
    /// file when the daemon reported one).
    pub truncated: bool,
    pub full_output_path: Option<String>,
    /// The mounted row skips its leading spacer against an agent-message
    /// row (TS `suppressLeadingSpace`).
    pub suppress_leading_space: bool,
}

impl BashExecutionCard {
    /// A running card for one dispatched command (TS the constructor's
    /// `Running...` loader state).
    pub fn new_running(id: &str, command: &str, excluded: bool) -> Self {
        Self {
            id: id.to_string(),
            command: command.to_string(),
            excluded,
            output_lines: Vec::new(),
            running: true,
            exit_code: None,
            cancelled: false,
            error_message: None,
            truncated: false,
            full_output_path: None,
            suppress_leading_space: false,
        }
    }

    /// A settled card for a replayed durable `bashExecution` row (TS
    /// `addMessageToChat` constructs the component, appends the recorded
    /// output, and completes it).
    pub fn settled(command: &str, excluded: bool) -> Self {
        let mut card = Self::new_running("", command, excluded);
        card.running = false;
        card
    }

    /// One streamed chunk (TS `appendOutput`): strip ANSI, normalize
    /// carriage returns, then merge into the accumulated lines (the first
    /// new line continues the last open line).
    ///
    /// # Panics
    ///
    /// Cannot panic: the `expect` guards a branch invariant
    /// (`output_lines` is non-empty exactly on the branch that takes
    /// `last_mut`).
    pub fn append_output(&mut self, chunk: &str) {
        let clean = strip_ansi(chunk).replace("\r\n", "\n").replace('\r', "\n");
        if clean.is_empty() {
            return;
        }
        let new_lines: Vec<&str> = clean.split('\n').collect();
        if self.output_lines.is_empty() {
            self.output_lines
                .extend(new_lines.iter().map(ToString::to_string));
        } else {
            let last = self
                .output_lines
                .last_mut()
                .expect("checked non-empty above");
            last.push_str(new_lines[0]);
            self.output_lines
                .extend(new_lines[1..].iter().map(ToString::to_string));
        }
    }

    /// The run settled (TS `setComplete`): cancelled outranks the exit
    /// code; a non-zero exit marks the run failed.
    pub fn set_complete(
        &mut self,
        exit_code: Option<i64>,
        cancelled: bool,
        truncated: bool,
        full_output_path: Option<String>,
    ) {
        self.running = false;
        self.exit_code = exit_code;
        self.cancelled = cancelled;
        self.truncated = truncated;
        self.full_output_path = full_output_path;
    }

    /// The run failed before producing a result (TS `setFailed`, e.g. a
    /// spawn failure).
    pub fn set_failed(&mut self, message: &str) {
        self.running = false;
        self.error_message = Some(message.to_string());
    }

    /// The raw accumulated output (TS `getOutput`).
    pub fn get_output(&self) -> String {
        self.output_lines.join("\n")
    }

    /// Whether the status row shows a failure marker (TS `setComplete`
    /// classifies `exit !== 0` as the error status).
    pub fn failed(&self) -> bool {
        self.error_message.is_some() || self.exit_code.is_some_and(|code| code != 0)
    }
}

/// The card's rows (TS the component's render): the full-width borders,
/// the `$ command` header, the output preview, and the loader or status
/// rows. The leading spacer and the click-to-expand affordance live with
/// the caller (the chat entry spacing and the mouse surface own them).
pub fn render_bash_execution(
    card: &BashExecutionCard,
    frame: usize,
    expanded: bool,
    cancel_hint: &str,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let key_style = if card.excluded {
        theme.fg_style(ThemeColor::Dim)
    } else {
        theme.fg_style(ThemeColor::BashMode)
    };
    // TS's constructor renders the command row through the color key (dim
    // for `!!`); the first `updateDisplay` — any output chunk, the settle,
    // a failure — re-renders it bash-mode (bash-execution.ts), so that is
    // the row a run shows in flight with output or at rest.
    let command_style = if card.running && card.output_lines.is_empty() {
        key_style
    } else {
        theme.fg_style(ThemeColor::BashMode)
    };
    let muted = theme.fg_style(ThemeColor::Muted);
    let border =
        |width: usize| -> Line { vec![Span::styled("\u{2500}".repeat(width.max(1)), key_style)] };
    // TS `Text(..., 1, 0)`: content wraps two columns inside the box.
    let content_width = width.saturating_sub(2).max(1);
    let mut rows: Vec<Line> = Vec::new();
    rows.push(border(width));
    // The `$ command` header (TS styles the text, the leading space is
    // the Text padding and stays uncolored).
    for wrapped in wrap_text(&format!("$ {}", card.command), content_width) {
        let mut row: Line = vec![Span::raw(" ".to_string())];
        row.extend(
            wrapped
                .into_iter()
                .map(|span| Span::styled(span.content, command_style)),
        );
        rows.push(row);
    }
    // The output block: the context-truncated tail (the same 2000-line /
    // 50KB budget the bash tool applies), then either the full muted text
    // or the preview — the LAST twenty logical lines, wrapped, then cut
    // to twenty VISUAL lines keeping the tail (TS `truncateToVisualLines`
    // over the 20-logical-line slice).
    let (context, context_truncated) = crate::bash_bang::truncate_tail(&card.get_output());
    // TS renders no output block while the accumulated content is empty
    // (`availableLines = content ? content.split("\n") : []`), so a run
    // with no output yet shows only the command row and the loader.
    let logical: Vec<&str> = if context.is_empty() {
        Vec::new()
    } else {
        context.split('\n').collect()
    };
    let shown: Vec<&str> = if expanded {
        logical.clone()
    } else if logical.len() > PREVIEW_LINES {
        logical[logical.len() - PREVIEW_LINES..].to_vec()
    } else {
        logical.clone()
    };
    let mut visual: Vec<Line> = Vec::new();
    for line in &shown {
        if line.is_empty() {
            visual.push(Vec::new());
            continue;
        }
        for wrapped in wrap_text(line, content_width) {
            let mut row: Line = vec![Span::raw(" ".to_string())];
            row.extend(
                wrapped
                    .into_iter()
                    .map(|span| Span::styled(span.content, muted)),
            );
            visual.push(row);
        }
    }
    if !visual.is_empty() {
        // TS styles the block with a leading `\n` (`new Text("\n...")`),
        // so the block opens with a blank row.
        visual.insert(0, Vec::new());
        if !expanded && visual.len() > PREVIEW_LINES {
            visual = visual.split_off(visual.len() - PREVIEW_LINES);
        }
        rows.extend(visual);
    }
    if card.running {
        // The loader (TS `Loader`: a blank row, then the spinner and the
        // message, both muted around an unstyled gap).
        rows.push(Vec::new());
        let spinner = LOADER_FRAMES[frame % LOADER_FRAMES.len()];
        rows.push(vec![
            Span::raw(" ".to_string()),
            Span::styled(spinner.to_string(), muted),
            Span::raw(" ".to_string()),
            Span::styled(format!("Running... ({cancel_hint} to cancel)"), muted),
        ]);
    } else {
        // The status rows (TS `statusParts`, each on its own padded row
        // after a leading blank).
        let mut parts: Vec<(String, ratatui::style::Style)> = Vec::new();
        if !expanded {
            let hidden = logical.len().saturating_sub(PREVIEW_LINES);
            if hidden > 0 {
                parts.push((format!("... {hidden} more lines"), muted));
            }
        }
        if card.cancelled {
            parts.push((
                "(cancelled)".to_string(),
                theme.fg_style(ThemeColor::Warning),
            ));
        } else if card.failed() {
            let text = match &card.error_message {
                Some(message) => format!("(failed: {message})"),
                None => format!("(exit {})", card.exit_code.unwrap_or_default()),
            };
            parts.push((text, theme.fg_style(ThemeColor::Error)));
        }
        if (card.truncated || context_truncated) && card.full_output_path.is_some() {
            parts.push((
                format!(
                    "Output truncated. Full output: {}",
                    card.full_output_path.as_deref().unwrap_or_default()
                ),
                theme.fg_style(ThemeColor::Warning),
            ));
        }
        if !parts.is_empty() {
            rows.push(Vec::new());
            for (text, style) in parts {
                rows.push(vec![Span::raw(" ".to_string()), Span::styled(text, style)]);
            }
        }
    }
    rows.push(border(width));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn text_of(line: &Line) -> String {
        line.iter().map(|span| span.content.as_str()).collect()
    }

    /// Chunks merge into the open line the TS way: the first line of a
    /// chunk continues the last accumulated line, later chunk lines open
    /// their own rows, and carriage returns normalize to newlines.
    #[test]
    fn chunks_merge_into_the_open_line() {
        let mut card = BashExecutionCard::new_running("u-1", "echo x", false);
        card.append_output("hel");
        card.append_output("lo\nwor");
        card.append_output("ld\r\n!");
        assert_eq!(
            card.output_lines,
            vec!["hello".to_string(), "world".to_string(), "!".to_string()]
        );
        assert_eq!(card.get_output(), "hello\nworld\n!");
    }

    /// The collapsed preview keeps the LAST twenty visual lines and the
    /// `... N more lines` row names the logical tail (TS counts hidden
    /// LOGICAL lines while `truncateToVisualLines` hides visual ones).
    #[test]
    fn collapsed_preview_keeps_the_last_twenty_visual_lines() {
        let mut card = BashExecutionCard::new_running("u-1", "seq", false);
        for line in 1..=40 {
            card.append_output(&format!("line-{line}\n"));
        }
        card.set_complete(Some(0), false, false, None);
        let rows = render_bash_execution(&card, 0, false, "esc", &theme(), 80);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert_eq!(
            flat.first().map(String::as_str),
            Some("\u{2500}".repeat(80).as_str())
        );
        assert!(flat.contains(&" $ seq".to_string()), "header: {flat:?}");
        assert!(flat.contains(&" line-40".to_string()), "tail: {flat:?}");
        assert!(
            !flat.iter().any(|row| row.contains("line-20")),
            "the older half is hidden: {flat:?}"
        );
        assert!(
            flat.iter().any(|row| row.contains("more lines")),
            "the hidden count names the cut: {flat:?}"
        );
        assert_eq!(
            flat.last().map(String::as_str),
            Some("\u{2500}".repeat(80).as_str())
        );
    }

    /// The settled run marks itself with `(exit N)` for a non-zero exit,
    /// `(cancelled)` for a cancellation, and the truncation notice only
    /// when a spill file exists (TS `statusParts` ordering).
    #[test]
    fn settled_status_markers_match_the_ts_shape() {
        let mut card = BashExecutionCard::new_running("u-1", "false", false);
        card.set_complete(Some(1), false, false, None);
        let rows = render_bash_execution(&card, 0, false, "esc", &theme(), 80);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(flat.contains(&" (exit 1)".to_string()), "{flat:?}");
        assert!(
            !flat.iter().any(|row| row.contains("Output truncated")),
            "no path, no notice: {flat:?}"
        );

        let mut card = BashExecutionCard::new_running("u-1", "sleep", false);
        card.set_complete(None, true, false, None);
        let rows = render_bash_execution(&card, 0, false, "esc", &theme(), 80);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(flat.contains(&" (cancelled)".to_string()), "{flat:?}");

        let mut card = BashExecutionCard::new_running("u-1", "big", false);
        card.set_failed("spawn failed");
        let rows = render_bash_execution(&card, 0, false, "esc", &theme(), 80);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(
            flat.contains(&" (failed: spawn failed)".to_string()),
            "{flat:?}"
        );
    }

    /// The `!!` variant renders the borders and header through the dim
    /// color (TS `excludeFromContext` picks the color key), and a running
    /// card owns the loader row with its cancel hint.
    #[test]
    fn excluded_runs_render_dim_and_the_loader_names_the_cancel_key() {
        let card = BashExecutionCard::new_running("u-1", "secret", true);
        let rows = render_bash_execution(&card, 3, false, "esc", &theme(), 80);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(flat.contains(&" $ secret".to_string()), "{flat:?}");
        assert!(
            flat.iter()
                .any(|row| row.contains("Running... (esc to cancel)")),
            "loader: {flat:?}"
        );
        let dim = theme().fg_style(ThemeColor::Dim);
        assert!(rows[0][0].style == dim, "the border is dim for !!");
    }

    /// The expanded card shows the full context-truncated output (no
    /// `... N more lines` row).
    #[test]
    fn expanded_card_shows_everything() {
        let mut card = BashExecutionCard::new_running("u-1", "seq", false);
        for line in 1..=30 {
            card.append_output(&format!("line-{line}\n"));
        }
        card.set_complete(Some(0), false, false, None);
        let rows = render_bash_execution(&card, 0, true, "esc", &theme(), 80);
        let flat: Vec<String> = rows.iter().map(text_of).collect();
        assert!(flat.contains(&" line-1".to_string()), "{flat:?}");
        assert!(
            !flat.iter().any(|row| row.contains("more lines")),
            "expanded hides nothing: {flat:?}"
        );
    }
}
