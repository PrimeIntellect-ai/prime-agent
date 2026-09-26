//! The inline panel frame of the `/model` picker: bordered search field,
//! effort rows, scroll indicator, selection detail, key hint, one blank
//! line below the hint (the operator's 2026-09-24 spacing directive).
//! Geometry is the TS `ModelSelectorComponent` inline path (menu-panel.ts
//! primitives).

use pa_types::ai::{Model, ModelThinkingLevel};
use std::fmt::Write;

use super::{EffortLayout, ModelPicker};
use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{hint_row, menu_row, no_match_row, scroll_row, search_field_lines};
use crate::theme::{Theme, ThemeColor};
use crate::width::str_width;
use crate::{Line, Span};

/// The search field's placeholder (TS `MenuSearchInput("Search models")`).
const SEARCH_PLACEHOLDER: &str = "Search models";

/// The price detail block's unit label (TS `PRICE_UNIT_TEXT`).
const PRICE_UNIT_TEXT: &str = "$ / 1M tokens";

/// Wide detail columns must still fit the longest label, "Cached input".
const PRICE_COLUMN_MIN_WIDTH: usize = 13;

/// Render the picker's frame: the inline menu panel plus the model/effort
/// hint row (TS `ConfigurationMenuComponent.render` composition).
pub(super) fn render(
    picker: &mut ModelPicker,
    theme: &Theme,
    width: usize,
    kb: &KeybindingsManager,
) -> Vec<Line> {
    picker.set_render_width(width);
    picker.set_visible_items(picker.list_layout());

    let mut lines = search_field_lines(
        theme,
        width,
        picker.query(),
        picker.search_cursor(),
        true,
        SEARCH_PLACEHOLDER,
    );

    let (start, end) = picker.filtered_window();
    let effort_layout = picker.effort_layout(start, end);
    for index in start..end {
        let Some(model_index) = picker.filtered_index(index) else {
            continue;
        };
        let Some(model) = picker.model_at(model_index).cloned() else {
            continue;
        };
        let selected = index == picker.selected_index();
        let primary = row_primary(picker, theme, &model, selected, effort_layout);
        let trailing = picker.trailing_segments(&model);
        let trailing_refs: Vec<crate::menu_panel::MenuSegment> = trailing
            .iter()
            .map(|segment| crate::menu_panel::MenuSegment::muted(segment))
            .collect();
        lines.push(menu_row(theme, width, primary, &trailing_refs, selected));
    }

    let filtered_len = picker.filtered_len();
    // The scroll indicator shows the selection's position in the full list.
    if start > 0 || end < filtered_len {
        lines.push(scroll_row(
            theme,
            width,
            picker.selected_index() + 1,
            filtered_len,
        ));
    }

    if filtered_len == 0 {
        lines.push(no_match_row(theme, width, "No matching models"));
    } else if let Some(model) = picker.selected_model().cloned() {
        if picker.detail_rows() > 0 {
            lines.extend(detail_lines(theme, width, &model));
        }
    }

    lines.push(hint_line(theme, width, kb));
    // One blank line of spacing below the shortcuts (the operator's
    // 2026-09-24 directive on the `/model` view: the hint is the
    // frame's last content row, a single blank rides under it — never
    // a rule).
    lines.push(Vec::new());
    lines
}

/// The primary cell of one row: the model name, or the name with the inline
/// effort cluster (arrows, squares, level label) when the window fits it.
fn row_primary(
    picker: &ModelPicker,
    theme: &Theme,
    model: &Model,
    selected: bool,
    layout: EffortLayout,
) -> Line {
    let name = model.name.clone();
    if !layout.show_cluster {
        return vec![Span::raw(name)];
    }
    let levels = ModelPicker::selectable_levels(model);
    let Some(effort) = picker.effort_of(model) else {
        return vec![Span::raw(name)];
    };
    if levels.is_empty() {
        return vec![Span::raw(name)];
    }
    let mut primary: Line = vec![Span::raw(truncate_pad(
        &name,
        layout.name_column,
        "\u{2026}",
    ))];
    primary.push(Span::raw(" ".repeat(layout.gap)));
    // Arrow slots: only the selected row shows the effort-adjustment arrows.
    if selected {
        primary.push(theme.fg_span(ThemeColor::Dim, "\u{2190}"));
    } else {
        primary.push(Span::raw(" "));
    }
    primary.push(Span::raw(" "));
    primary.extend(effort_square_spans(
        theme,
        &levels,
        effort,
        layout.square_slots,
        selected,
    ));
    primary.push(Span::raw(" "));
    if selected {
        primary.push(theme.fg_span(ThemeColor::Dim, "\u{2192}"));
    } else {
        primary.push(Span::raw(" "));
    }
    primary.push(Span::raw(" "));
    if layout.show_label {
        let mut label = effort.wire_name().to_string();
        let pad = layout.label_width.saturating_sub(label.chars().count());
        label.push_str(&" ".repeat(pad));
        primary.push(theme.fg_span(ThemeColor::Muted, label));
    }
    primary
}

/// The effort squares (TS `renderEffortSquares`): one slot per on-level,
/// filled up to the current effort, padded to the row's slot count.
fn effort_square_spans(
    theme: &Theme,
    levels: &[ModelThinkingLevel],
    effort: ModelThinkingLevel,
    square_slots: usize,
    selected: bool,
) -> Line {
    let on_levels: Vec<ModelThinkingLevel> = levels
        .iter()
        .copied()
        .filter(|level| *level != ModelThinkingLevel::Off)
        .collect();
    if on_levels.is_empty() {
        return Vec::new();
    }
    let filled = if effort == ModelThinkingLevel::Off {
        0
    } else {
        on_levels
            .iter()
            .position(|level| *level == effort)
            .map_or(0, |position| position + 1)
    };
    let mut spans: Line = Vec::with_capacity(on_levels.len() + 1);
    for (index, _) in on_levels.iter().enumerate() {
        if index < filled {
            // Filled squares: the effort pastel on the selected row, muted
            // elsewhere.
            if selected {
                let style = theme.effort_square_style();
                spans.push(Span::styled("\u{25a0}".to_string(), style));
            } else {
                spans.push(theme.fg_span(ThemeColor::Muted, "\u{25a0}"));
            }
        } else {
            spans.push(theme.fg_span(ThemeColor::Dim, "\u{25a1}"));
        }
    }
    let used: usize = spans.iter().map(|span| str_width(&span.content)).sum();
    if used < square_slots {
        spans.push(Span::raw(" ".repeat(square_slots - used)));
    }
    spans
}

/// The selected model's price detail block (TS `renderInlineModelDetails`).
fn detail_lines(theme: &Theme, width: usize, model: &Model) -> Vec<Line> {
    let price = |value: Option<f64>| -> String {
        let Some(value) = value else {
            return "\u{2014}".to_string();
        };
        if !value.is_finite() || value < 0.0 {
            return "\u{2014}".to_string();
        }
        if value == 0.0 {
            return "$0".to_string();
        }
        let rounded = (value * 1000.0).round() / 1000.0;
        if rounded == 0.0 {
            return "<0.001".to_string();
        }
        format!("${rounded}")
    };
    let entries = [
        ("Input", price(Some(model.cost.input.as_f64()))),
        ("Cached input", price(Some(model.cost.cache_read.as_f64()))),
        ("Output", price(Some(model.cost.output.as_f64()))),
    ];
    let unit = theme.fg_span(ThemeColor::Muted, PRICE_UNIT_TEXT);
    let mut lines: Vec<Line> = Vec::new();
    if width >= 58 {
        // Shrink the columns so the unit can trail the Output column.
        let column_width = PRICE_COLUMN_MIN_WIDTH
            .max((width.saturating_sub(2 + str_width(PRICE_UNIT_TEXT) + 1)) / 3);
        let row = |index: usize| -> String {
            entries
                .iter()
                .fold(String::new(), |mut output, (label, value)| {
                    let cell = if index == 0 {
                        (*label).to_string()
                    } else {
                        value.clone()
                    };
                    let pad = column_width.saturating_sub(cell.chars().count());
                    let _ = write!(output, "{cell}{}", " ".repeat(pad));
                    output
                })
        };
        let mut labels = vec![Span::raw(" "), theme.fg_span(ThemeColor::Muted, row(0))];
        labels.push(Span::raw(" "));
        labels.push(unit);
        lines.push(vec![Span::raw(" ")]);
        lines.push(labels);
        lines.push(vec![Span::raw(" "), Span::raw(row(1))]);
        lines.push(vec![Span::raw(" ")]);
    } else {
        for (position, (label, value)) in entries.iter().enumerate() {
            let mut line = vec![
                theme.fg_span(ThemeColor::Muted, format!("{label}:")),
                Span::raw(format!(" {value}")),
            ];
            if position == entries.len() - 1 {
                line.push(Span::raw(" "));
                line.push(unit.clone());
            }
            lines.push(line);
        }
    }
    lines
        .into_iter()
        .map(|line| {
            let mut line = line;
            let used: usize = line.iter().map(|span| str_width(&span.content)).sum();
            if used < width {
                line.push(Span::raw(" ".repeat(width - used)));
            }
            crate::width::truncate_line(&line, width, "\u{2026}")
        })
        .collect()
}

/// The trailing key hint (TS `ConfigurationMenuComponent.render`): the
/// model/effort navigation hint on wide panes, the select/close core below
/// 70 columns.
fn hint_line(theme: &Theme, width: usize, kb: &KeybindingsManager) -> Line {
    let select_key = kb
        .first_key("tui.select.confirm")
        .map_or_else(|| "Enter".to_string(), |key| format_key_text(&key));
    let close_key = kb
        .first_key("tui.select.cancel")
        .map_or_else(|| "Esc".to_string(), |key| format_key_text(&key));
    let hint = if width >= 70 {
        let navigate = format!(
            "{}/{}",
            kb.first_key("tui.select.up")
                .map_or_else(|| "\u{2191}".to_string(), |key| format_key_text(&key)),
            kb.first_key("tui.select.down")
                .map_or_else(|| "\u{2193}".to_string(), |key| format_key_text(&key))
        );
        let effort = format!(
            "{}/{}",
            kb.first_key("tui.editor.cursorLeft")
                .map_or_else(|| "\u{2190}".to_string(), |key| format_key_text(&key)),
            kb.first_key("tui.editor.cursorRight")
                .map_or_else(|| "\u{2192}".to_string(), |key| format_key_text(&key))
        );
        format!("{navigate} model \u{b7} {effort} effort \u{b7} {select_key} select \u{b7} {close_key} close")
    } else {
        format!("{select_key} select \u{b7} {close_key} close")
    };
    hint_row(theme, width, &hint)
}

/// Truncate to a width and pad to it (TS `truncateToWidth` with
/// `pad: true`).
fn truncate_pad(text: &str, width: usize, ellipsis: &str) -> String {
    if width == 0 {
        return String::new();
    }
    let ellipsis_width = str_width(ellipsis);
    if str_width(text) <= width {
        let mut out = text.to_string();
        let pad = width.saturating_sub(str_width(text));
        out.push_str(&" ".repeat(pad));
        return out;
    }
    if ellipsis_width >= width {
        return " ".repeat(width);
    }
    let mut out = String::new();
    let mut used = 0;
    let target = width - ellipsis_width;
    for character in text.chars() {
        let character_width = crate::width::char_width(character);
        if used + character_width > target {
            break;
        }
        out.push(character);
        used += character_width;
    }
    out.push_str(ellipsis);
    out
}
