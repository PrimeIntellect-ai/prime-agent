use super::{FilterMode, GutterInfo, TreeList};
use crate::theme::{Theme, ThemeBg, ThemeColor};
use crate::tree_display;
use crate::tree_nodes::TreeNode;
use crate::width::{str_width, truncate_line};
use crate::{Line, Span};
use ratatui::style::{Modifier, Style};

impl TreeList {
    /// Render the visible rows plus the counter (TS `TreeList.render`).
    #[must_use]
    pub fn render(&self, theme: &Theme, width: usize) -> Vec<Line> {
        let mut lines: Vec<Line> = Vec::new();
        if self.filtered.is_empty() {
            lines.push(truncate_line(
                &vec![theme.fg_span(ThemeColor::Muted, "  No entries found".to_string())],
                width,
                "",
            ));
            lines.push(truncate_line(
                &vec![theme.fg_span(
                    ThemeColor::Muted,
                    format!("  (0/0){}", self.filter_mode.status_label()),
                )],
                width,
                "",
            ));
            return lines;
        }
        let max = self.max_visible_lines;
        let start = self
            .selected
            .saturating_sub(max / 2)
            .min(self.filtered.len().saturating_sub(max));
        let end = (start + max).min(self.filtered.len());
        let selected_bg = theme.bg_style(ThemeBg::SelectedBg);
        for position in start..end {
            let index = self.filtered[position];
            let node = &self.flat[index];
            let entry_id = node.data.entry.id().unwrap_or_default();
            let is_selected = position == self.selected;
            // TS renders the selected row's cursor and path markers inside
            // the selection background with no accent foreground: the the TS TUI
            // row writer drops those interior colors, and the capture shows
            // only the background escape before `› `.
            let cursor = if is_selected {
                Span::raw("› ".to_string())
            } else {
                Span::raw("  ".to_string())
            };
            let display_indent = if self.multiple_roots {
                node.indent.saturating_sub(1)
            } else {
                node.indent
            };
            let connector = if node.show_connector && !node.is_virtual_root_child {
                if node.is_last {
                    "└─ "
                } else {
                    "├─ "
                }
            } else {
                ""
            };
            let connector_position = if connector.is_empty() {
                usize::MAX
            } else {
                display_indent.saturating_sub(1)
            };
            // Prefix: gutters and connector placed per 3-char level.
            let mut prefix = String::new();
            for i in 0..display_indent * 3 {
                let level = i / 3;
                let pos_in_level = i % 3;
                let gutter = node.gutters.iter().find(|g| g.position == level);
                if let Some(gutter) = gutter {
                    if pos_in_level == 0 {
                        prefix.push(if gutter.show { '│' } else { ' ' });
                    } else {
                        prefix.push(' ');
                    }
                } else if !connector.is_empty() && level == connector_position {
                    match pos_in_level {
                        0 => prefix.push(if node.is_last { '└' } else { '├' }),
                        1 => {
                            let foldable = self.is_foldable(entry_id);
                            prefix.push(if self.is_folded(entry_id) {
                                '⊞'
                            } else if foldable {
                                '⊟'
                            } else {
                                '─'
                            });
                        }
                        _ => prefix.push(' '),
                    }
                } else {
                    prefix.push(' ');
                }
            }
            let shows_fold_in_connector = node.show_connector && !node.is_virtual_root_child;
            let fold_marker = if self.is_folded(entry_id) && !shows_fold_in_connector {
                theme.fg_span(ThemeColor::Accent, "⊞ ".to_string())
            } else {
                Span::raw("")
            };
            let path_marker = if self.active_path.contains(entry_id) {
                if is_selected {
                    Span::raw("• ".to_string())
                } else {
                    theme.fg_span(ThemeColor::Accent, "• ".to_string())
                }
            } else {
                Span::raw("")
            };
            let label = node.data.label.as_ref().map_or(Span::raw(""), |label| {
                theme.fg_span(ThemeColor::Warning, format!("[{label}] "))
            });
            let label_timestamp = if self.show_label_timestamps && node.data.label.is_some() {
                node.data.label_timestamp.as_deref().map_or_else(
                    || Span::raw(""),
                    |timestamp| {
                        theme.fg_span(
                            ThemeColor::Muted,
                            format!("{} ", format_label_timestamp(timestamp)),
                        )
                    },
                )
            } else {
                Span::raw("")
            };
            let mut content = tree_display::entry_display_text(theme, &node.data, &self.tool_calls);
            if is_selected {
                // TS `theme.bold(getEntryDisplayText(...))` wraps the whole
                // display text; the the TS TUI writer then re-emits the inner
                // fg reset between the role label and the content, so the
                // capture shows only the role run bold.
                if let Some(first) = content.first_mut() {
                    first.style = first.style.add_modifier(Modifier::BOLD);
                }
            }
            let mut row: Line = vec![cursor, theme.fg_span(ThemeColor::Dim, prefix.clone())];
            row.push(fold_marker);
            row.push(path_marker);
            row.push(label);
            row.push(label_timestamp);
            row.extend(content);
            if is_selected {
                // The selected row keeps only the bold modifier over the
                // selection background: the the TS TUI writer drops interior
                // foreground colors under the selection wrap, so the
                // capture shows `› • ` and the bold role without their
                // accent escapes.
                for span in &mut row {
                    let bold = span.style.add_modifier.contains(Modifier::BOLD);
                    span.style = Style::default();
                    if bold {
                        span.style = span.style.add_modifier(Modifier::BOLD);
                    }
                    span.style = span.style.patch(selected_bg);
                }
            }
            let _ = str_width(&prefix);
            lines.push(truncate_line(&row, width, ""));
        }
        lines.push(truncate_line(
            &vec![theme.fg_span(
                ThemeColor::Muted,
                format!(
                    "  ({}/{}){}",
                    self.selected + 1,
                    self.filtered.len(),
                    self.filter_mode.status_label()
                ),
            )],
            width,
            "",
        ));
        lines
    }
}

/// One iterative-flatten stack item: the node with its placement.
pub(super) type FlattenItem<'a> = (&'a TreeNode, usize, bool, bool, bool, Vec<GutterInfo>, bool);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Direction {
    Up,
    Down,
}

/// Toggle a filter mode: the requested mode switches back to default.
pub(super) fn toggle(current: FilterMode, requested: FilterMode) -> FilterMode {
    if current == requested {
        FilterMode::Default
    } else {
        requested
    }
}

/// Label timestamps render as `HH:MM` today, `M/D HH:MM` this year, and
/// `YY/M/D HH:MM` otherwise (TS `formatLabelTimestamp`).
fn format_label_timestamp(timestamp: &str) -> String {
    // The wire timestamps are ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`).
    let parse = |text: &str| -> Option<(u32, u32, u32, u32, u32)> {
        let bytes = text.as_bytes();
        if bytes.len() < 16 {
            return None;
        }
        let year: u32 = text.get(0..4)?.parse().ok()?;
        let month: u32 = text.get(5..7)?.parse().ok()?;
        let day: u32 = text.get(8..10)?.parse().ok()?;
        let hour: u32 = text.get(11..13)?.parse().ok()?;
        let minute: u32 = text.get(14..16)?.parse().ok()?;
        Some((year, month, day, hour, minute))
    };
    let Some((year, month, day, hour, minute)) = parse(timestamp) else {
        return String::new();
    };
    let time = format!("{hour:02}:{minute:02}");
    // "Today" needs the current date; sessions are recent, so a same-day
    // match compares against the current UTC date.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (now_year, now_month, now_day) = utc_date(now);
    if (year, month, day) == (now_year, now_month, now_day) {
        return time;
    }
    if year == now_year {
        return format!("{month}/{day} {time}");
    }
    let year_short = year % 100;
    format!("{year_short:02}/{month}/{day} {time}")
}

/// UTC date from unix seconds.
fn utc_date(secs: u64) -> (u32, u32, u32) {
    let days = secs / 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as u32, m as u32, d as u32)
}
