//! The compact-steps line over one assistant message's thinking: collapsed, the
//! `▸ Thought for 3.2s - <first sentence>` summary; expanded, the `▾ Thought for 3.2s` header
//! over the full reasoning. The line sits on the message's first content row either way, the
//! row a click toggles.

use std::time::Duration;

use super::{pad_to, AssistantMessage, MessageBlock};
use crate::theme::{Theme, ThemeColor};
use crate::width::truncate_line;
use crate::{Line, Span};
use ratatui::style::Style;

/// The entry-local row the line renders on: right below the message's leading spacer.
pub(crate) const THINKING_STEP_ROW: usize = 1;

/// One message's thinking step under compact steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ThinkingStep {
    /// The thinking time measured from the live stream; `None` for a message loaded from disk,
    /// whose session file records no thinking time.
    pub(crate) duration: Option<Duration>,
}

pub(super) fn thinking_step_line(
    message: &AssistantMessage,
    step: ThinkingStep,
    expanded: bool,
    theme: &Theme,
    width: usize,
) -> Line {
    let muted = theme.fg_style(ThemeColor::Muted);
    let dim = theme.fg_style(ThemeColor::Dim);
    let label = match step.duration {
        Some(duration) => format!(
            "Thought for {}",
            crate::tool_card::format_step_duration(duration.as_secs_f64() * 1000.0)
        ),
        None if message.streaming => "Thinking".to_string(),
        None => "Thought".to_string(),
    };
    let marker = if expanded { "\u{25be}" } else { "\u{25b8}" };
    let mut row: Line = vec![
        Span::raw(" "),
        Span::styled(marker, muted),
        Span::raw(" "),
        Span::styled(label, muted),
    ];
    if !expanded {
        if let Some(sentence) = first_sentence(message) {
            row.push(Span::styled(" - ", dim));
            row.push(Span::styled(sentence, dim));
        }
    }
    pad_to(
        truncate_line(&row, width, "\u{2026}"),
        width,
        Style::default(),
    )
}

/// The reasoning's first sentence without its markdown markers: the summary line's gist.
fn first_sentence(message: &AssistantMessage) -> Option<String> {
    let line = message
        .blocks
        .iter()
        .filter_map(|block| match block {
            MessageBlock::Thinking(text) => Some(text.as_str()),
            MessageBlock::Text(_) => None,
        })
        .flat_map(str::lines)
        .map(|line| {
            // Without the heading, quote, and bullet leads or the emphasis and code delimiters.
            let line = line.trim().trim_start_matches(['#', '>']).trim_start();
            let line = ["- ", "* ", "+ "]
                .iter()
                .find_map(|bullet| line.strip_prefix(bullet))
                .unwrap_or(line);
            line.replace("**", "")
                .replace("__", "")
                .replace('`', "")
                .trim()
                .to_string()
        })
        .find(|line| !line.is_empty())?;
    // A sentence ends at `.`, `!`, or `?` before whitespace or the line's end (`v1.2` and
    // `main.rs` read on).
    let end = line
        .char_indices()
        .find(|&(index, ch)| {
            matches!(ch, '.' | '!' | '?')
                && line[index + ch.len_utf8()..]
                    .chars()
                    .next()
                    .is_none_or(char::is_whitespace)
        })
        .map_or(line.len(), |(index, ch)| index + ch.len_utf8());
    Some(line[..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ColorMode;

    fn message(thinking: &str, streaming: bool) -> AssistantMessage {
        AssistantMessage {
            blocks: vec![
                MessageBlock::Thinking(thinking.to_string()),
                MessageBlock::Text("The answer.".to_string()),
            ],
            has_tool_calls: false,
            streaming,
            error: None,
            aborted: false,
        }
    }

    fn text(message: &AssistantMessage, duration: Option<Duration>, expanded: bool) -> String {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        thinking_step_line(message, ThinkingStep { duration }, expanded, &theme, 80)
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>()
            .trim_end()
            .to_string()
    }

    /// The summary names the measured time (or the stream state when none was measured) and the
    /// reasoning's first sentence without its markdown; the expanded header drops the sentence.
    #[test]
    fn the_line_summarizes_the_time_and_the_first_sentence() {
        let settled = message(
            "## **Checking the config first.** The loader reads v1.2 twice.\n\nMore detail.",
            false,
        );
        assert_eq!(
            text(&settled, Some(Duration::from_millis(3_240)), false),
            " \u{25b8} Thought for 3.2s - Checking the config first."
        );
        assert_eq!(
            text(&settled, Some(Duration::from_millis(3_240)), true),
            " \u{25be} Thought for 3.2s"
        );
        assert_eq!(
            text(&settled, None, false),
            " \u{25b8} Thought - Checking the config first."
        );
        let streaming = message("\n- `main.rs` holds the loop", true);
        assert_eq!(
            text(&streaming, None, false),
            " \u{25b8} Thinking - main.rs holds the loop"
        );
    }
}
