//! The refinement-outcome row: decode (TS `isRefinementOutcomeMessage`,
//! `refinementHeader`, `editLabel`, `editFieldRows`) and rendering (TS
//! `RefinementOutcomeMessageComponent` over `ExpandableEventMessage`, with
//! the `buildRichDiffLine` -/+ change rows).
//!
//! Split from the module root so the dispatch stays small; the shared row
//! types live in `super`.

use super::render::{pad_with, spacer, text_rows};
use super::{EditField, LabelPart, RefinementEditRow, RefinementOutcomeRow};
use crate::chat::{ChatEntry, Detail, StatusKind};
use crate::theme::{ColorMode, Theme, ThemeBg, ThemeColor};
use crate::width::wrap_line;
use crate::width::{str_width, truncate_line, wrap_text};
use crate::{Line, Span};
use serde_json::Value;

/// TS `isRefinementOutcomeMessage` (summary + scope + applied-edit list)
/// with the full outcome shape; malformed payloads render the notice.
pub(crate) fn refinement_outcome_entries(message: &Value, details: &Value) -> Vec<ChatEntry> {
    let summary = details.get("summary").and_then(Value::as_str);
    let scope_ok = matches!(
        details.get("scope").and_then(Value::as_str),
        Some("local") | Some("global")
    );
    let edits = details.get("edits").and_then(Value::as_array);
    let valid = message
        .get("content")
        .map(|c| c.is_string())
        .unwrap_or(false)
        && summary.is_some()
        && scope_ok
        && edits.is_some_and(|edits| {
            edits.iter().all(|edit| {
                matches!(
                    edit.get("action").and_then(Value::as_str),
                    Some("create") | Some("update") | Some("delete")
                ) && edit.get("kind").map(Value::is_string).unwrap_or(false)
                    && edit.get("id").map(Value::is_string).unwrap_or(false)
                    && edit.get("applied").map(Value::is_boolean).unwrap_or(false)
            })
        });
    if !valid {
        return vec![ChatEntry::Status {
            text: "[Malformed refinement outcome message]".to_string(),
            kind: StatusKind::Error,
        }];
    }
    // Validity guarantees the array; the empty fallback only satisfies the
    // borrow checker.
    let no_edits: Vec<Value> = Vec::new();
    let edits = edits.unwrap_or(&no_edits);
    let applied: Vec<&Value> = edits
        .iter()
        .filter(|edit| edit.get("applied").and_then(Value::as_bool) == Some(true))
        .collect();
    let rollback_of = details.get("rollbackOf").and_then(Value::as_str);
    let outcome = refinement_outcome_line(edits, &applied, rollback_of);
    let header = if outcome.starts_with("Harness refined \u{b7}") {
        "Harness refined".to_string()
    } else {
        outcome.clone()
    };
    let meta = format!(
        "{outcome} \u{b7} Refinement {} \u{b7} {}{}",
        details
            .get("refinementId")
            .and_then(Value::as_str)
            .unwrap_or(""),
        details
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("local"),
        rollback_of
            .map(|id| format!(" \u{b7} rollback of {id}"))
            .unwrap_or_default()
    );
    vec![ChatEntry::RefinementOutcome(Box::new(
        RefinementOutcomeRow {
            header,
            summary: summary.unwrap_or_default().to_string(),
            meta,
            edits: edits
                .iter()
                .map(|edit| {
                    refinement_edit_row(
                        edit,
                        details
                            .get("scope")
                            .and_then(Value::as_str)
                            .unwrap_or("local"),
                    )
                })
                .collect(),
        },
    ))]
}

/// TS `refinementHeader`: the outcome line over the applied edit list.
fn refinement_outcome_line(
    edits: &[Value],
    applied: &[&Value],
    rollback_of: Option<&str>,
) -> String {
    let operation = if rollback_of.is_some() {
        "Harness rollback"
    } else {
        "Harness refinement"
    };
    if edits.is_empty() {
        return if rollback_of.is_some() {
            "Harness rollback unchanged \u{b7} no edits applied".to_string()
        } else {
            "Harness unchanged \u{b7} no edits applied".to_string()
        };
    }
    if applied.is_empty() {
        return format!("{operation} failed \u{b7} 0/{} edits applied", edits.len());
    }
    let count = applied.len();
    if count < edits.len() {
        return if rollback_of.is_some() {
            format!(
                "Harness partially rolled back \u{b7} {count}/{} edits applied",
                edits.len()
            )
        } else {
            format!(
                "Harness partially refined \u{b7} {count}/{} edits applied",
                edits.len()
            )
        };
    }
    if rollback_of.is_some() {
        return format!(
            "Harness rollback completed \u{b7} {count} edit{} applied",
            if count == 1 { "" } else { "s" }
        );
    }
    let first_kind = applied[0].get("kind").and_then(Value::as_str).unwrap_or("");
    let same_kind = applied
        .iter()
        .all(|edit| edit.get("kind").and_then(Value::as_str) == Some(first_kind));
    if same_kind {
        // TS: `memory` pluralizes to `memories`, every other kind just
        // appends `s`; mixed actions collapse to `changed`.
        let kind = if first_kind == "memory" {
            if count == 1 {
                "memory".to_string()
            } else {
                "memories".to_string()
            }
        } else if count == 1 {
            first_kind.to_string()
        } else {
            format!("{first_kind}s")
        };
        let same_action = applied
            .iter()
            .all(|edit| edit.get("action") == applied[0].get("action"));
        let action = match (
            same_action,
            applied[0].get("action").and_then(Value::as_str),
        ) {
            (true, Some("create")) => "created",
            (true, Some("update")) => "updated",
            (true, Some("delete")) => "deleted",
            _ => "changed",
        };
        return format!("Harness refined \u{b7} {count} {kind} {action}");
    }
    format!("Harness refined \u{b7} {count} edits applied")
}

/// TS `editLabel`/`editFieldRows` for one edit; `editScope(edit, fallback)`
/// takes the edit's own scope, else the message scope.
fn refinement_edit_row(edit: &Value, fallback_scope: &str) -> RefinementEditRow {
    let scope = edit
        .get("after")
        .and_then(|after| after.get("scope"))
        .and_then(Value::as_str)
        .or_else(|| {
            edit.get("before")
                .and_then(|before| before.get("scope"))
                .and_then(Value::as_str)
        })
        .unwrap_or(fallback_scope)
        .to_string();
    let applied = edit.get("applied").and_then(Value::as_bool) == Some(true);
    let action = edit.get("action").and_then(Value::as_str).unwrap_or("");
    let kind = edit.get("kind").and_then(Value::as_str).unwrap_or("");
    let id = edit.get("id").and_then(Value::as_str).unwrap_or("");
    let label = if !applied {
        let error = edit
            .get("error")
            .and_then(Value::as_str)
            .map(|error| format!(": {error}"))
            .unwrap_or_default();
        vec![LabelPart {
            text: format!("Failed to {action} {scope} {kind} `{id}`{error}"),
            color: Some(ThemeColor::Error),
        }]
    } else {
        let verb = match action {
            "create" => "Created",
            "update" => "Updated",
            _ => "Deleted",
        };
        vec![
            LabelPart {
                text: verb.to_string(),
                color: Some(ThemeColor::Success),
            },
            LabelPart {
                text: format!(" {scope} {kind} `{id}`"),
                color: None,
            },
        ]
    };
    RefinementEditRow {
        label,
        reason: edit
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string),
        fields: edit_field_rows(edit),
    }
}

/// The editable harness fields shown per edit, in display order (TS
/// `EDIT_FIELDS`).
const EDIT_FIELDS: [&str; 6] = [
    "title",
    "content",
    "path",
    "reference",
    "arguments",
    "metadata",
];

/// TS `fieldValueLines`: strings split on newlines, objects one JSON row,
/// everything else (and empty values) no rows.
fn field_value_lines(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) => {
            if text.is_empty() {
                Vec::new()
            } else {
                text.split('\n').map(str::to_string).collect()
            }
        }
        Value::Object(map) => {
            if map.is_empty() {
                Vec::new()
            } else {
                vec![serde_json::to_string(value).unwrap_or_default()]
            }
        }
        _ => Vec::new(),
    }
}

/// One entry's field rows (TS `entryFieldRows`).
fn entry_field_rows(entry: &Value) -> Vec<EditField> {
    EDIT_FIELDS
        .iter()
        .filter_map(|key| {
            let value = field_value_lines(entry.get(*key).unwrap_or(&Value::Null));
            (!value.is_empty()).then(|| EditField {
                label: key_title_case(key),
                value,
                change: None,
            })
        })
        .collect()
}

/// `EDIT_FIELDS` display labels.
fn key_title_case(key: &str) -> String {
    match key {
        "title" => "Title",
        "content" => "Description",
        "path" => "Path",
        "reference" => "Reference",
        "arguments" => "Arguments",
        "metadata" => "Metadata",
        other => other,
    }
    .to_string()
}

/// The edit fields for one edit (TS `editFieldRows`): failed edits show
/// before/proposed, updates show -/+ changes for changed fields, create and
/// delete show their value as added/removed rows.
fn edit_field_rows(edit: &Value) -> Vec<EditField> {
    let applied = edit.get("applied").and_then(Value::as_bool) == Some(true);
    let before = edit.get("before").filter(|v| v.is_object());
    let after = edit.get("after").filter(|v| v.is_object());
    let action = edit.get("action").and_then(Value::as_str).unwrap_or("");
    if !applied {
        let proposed = after
            .map(entry_field_rows)
            .unwrap_or_else(|| entry_field_rows(edit));
        return match before {
            None => proposed,
            Some(before) => {
                let mut rows: Vec<EditField> = entry_field_rows(before)
                    .into_iter()
                    .map(|field| EditField {
                        label: format!("Before {}", field.label),
                        ..field
                    })
                    .collect();
                rows.extend(
                    proposed
                        .into_iter()
                        .map(|field| EditField {
                            label: format!("Proposed {}", field.label),
                            ..field
                        })
                        .collect::<Vec<_>>(),
                );
                rows
            }
        };
    }
    if let (Some(before), Some(after)) = (before, after) {
        // TS `updateFieldRows`: one plain row per unchanged field, -/+ for
        // changed ones.
        return EDIT_FIELDS
            .iter()
            .filter_map(|key| {
                let removed = field_value_lines(before.get(*key).unwrap_or(&Value::Null));
                let added = field_value_lines(after.get(*key).unwrap_or(&Value::Null));
                if removed.is_empty() && added.is_empty() {
                    return None;
                }
                if removed.join("\n") == added.join("\n") {
                    return Some(EditField {
                        label: key_title_case(key),
                        value: added,
                        change: None,
                    });
                }
                Some(EditField {
                    label: key_title_case(key),
                    value: Vec::new(),
                    change: Some((removed, added)),
                })
            })
            .collect();
    }
    let entry = after.or(before).unwrap_or(edit);
    let fields = entry_field_rows(entry);
    if action == "update" {
        return fields;
    }
    fields
        .into_iter()
        .map(|field| {
            // TS: delete moves the value to the removed rows, create to
            // the added rows (one branch or the other, never both).
            let (removed, added) = if action == "delete" {
                (field.value, Vec::new())
            } else if action == "create" {
                (Vec::new(), field.value)
            } else {
                (Vec::new(), Vec::new())
            };
            EditField {
                label: field.label,
                value: Vec::new(),
                change: Some((removed, added)),
            }
        })
        .collect()
}

/// One refinement-outcome row (TS `RefinementOutcomeMessageComponent`): a
/// leading blank, the `◆` header in `refinementHeader`, the summary clamp
/// (`refinementSummary`), and the expanded outcome/edit details.
pub(crate) fn render_refinement_outcome(
    row: &RefinementOutcomeRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let mut out = vec![spacer()];
    let header = text_rows(
        vec![Span::styled(
            format!("\u{25c6} {}", row.header),
            theme.fg_style(ThemeColor::RefinementHeader),
        )],
        width,
    );
    out.extend(header);
    let summary = if row.summary.trim().is_empty() {
        "No summary was recorded for this harness change."
    } else {
        row.summary.trim()
    };
    // TS `ExpandableEventMessage.addSummary`: the summary follows the
    // component's `setExpanded` state (`toolOutputExpanded`), not the
    // edit-diffs toggle.
    out.extend(event_summary_rows(
        summary,
        detail.tool_output_expanded(),
        ThemeColor::RefinementSummary,
        theme,
        width,
    ));
    if detail.tool_output_expanded() {
        out.push(spacer());
        out.extend(text_rows(
            vec![Span::styled(
                row.meta.clone(),
                theme.fg_style(ThemeColor::Dim),
            )],
            width,
        ));
        for edit in &row.edits {
            out.push(spacer());
            out.extend(edit_section_rows(edit, theme, width));
        }
    }
    out
}

/// TS `EventSummary`: wrapped at `width - 1` with a one-column inset; the
/// collapsed view whitespace-collapses and clamps to two lines (the second
/// truncated with an ellipsis).
fn event_summary_rows(
    summary: &str,
    expanded: bool,
    color: ThemeColor,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let content_width = width.saturating_sub(1).max(1);
    let text = if expanded {
        summary.to_string()
    } else {
        summary.split_whitespace().collect::<Vec<_>>().join(" ")
    };
    let style = theme.fg_style(color);
    let mut lines: Vec<Line> = Vec::new();
    for source in text.split('\n') {
        let plain: Line = vec![Span::raw(source.to_string())];
        lines.extend(wrap_line(&plain, content_width));
    }
    if lines.is_empty() {
        lines.push(Vec::new());
    }
    if !expanded && lines.len() > 2 {
        lines.truncate(2);
        let second = lines.remove(1);
        let mut joined: Line = second;
        joined.push(Span::raw(" \u{2026}"));
        lines.insert(1, truncate_line(&joined, content_width, "\u{2026}"));
    }
    lines
        .into_iter()
        .map(|line| {
            // TS `EventSummary` colors the inset space with the summary
            // color (`theme.fg(color, \` ${line}\`)`), so the first span
            // carries the leading space.
            let mut row: Line = Vec::new();
            for (index, span) in line.into_iter().enumerate() {
                let content = if index == 0 {
                    format!(" {}", span.content)
                } else {
                    span.content
                };
                row.push(Span::styled(content, style));
            }
            row
        })
        .collect()
}

/// One edit section (TS `RefinementEditSection`): the label row, then one
/// muted field-label row per field with plain value rows or -/+ change rows.
fn edit_section_rows(edit: &RefinementEditRow, theme: &Theme, width: usize) -> Vec<Line> {
    let mut label: Line = Vec::new();
    for part in &edit.label {
        label.push(label_part(part, theme));
    }
    let mut out = text_rows(label, width);
    for field in &edit.fields {
        out.extend(text_rows(
            vec![Span::styled(
                field.label.clone(),
                theme.fg_style(ThemeColor::Muted),
            )],
            width,
        ));
        match &field.change {
            None => {
                out.extend(text_rows(vec![Span::raw(field.value.join("\n"))], width));
            }
            Some((removed, added)) => {
                for row in rich_change_rows(removed, added, theme, width.saturating_sub(1)) {
                    let mut inset: Line = vec![Span::raw(" ")];
                    inset.extend(row);
                    out.push(inset);
                }
            }
        }
    }
    if let Some(reason) = &edit.reason {
        out.extend(text_rows(
            vec![Span::styled(
                format!("Reason: {reason}"),
                theme.fg_style(ThemeColor::Muted),
            )],
            width,
        ));
    }
    out
}

/// One label span (the colored verb or failed line).
fn label_part(part: &LabelPart, theme: &Theme) -> Span {
    match part.color {
        Some(color) => Span::styled(part.text.clone(), theme.fg_style(color)),
        None => Span::raw(part.text.clone()),
    }
}

/// Full-context line diff rows in the rich-diff row shape (TS
/// `buildRichDiffLine` over `generateDiffString` with infinite context):
/// a ` <num> <prefix> ` gutter on the diff backgrounds, wrapped content in
/// `mdCodeBlock`, continuation rows keep a blank gutter.
fn rich_change_rows(
    removed: &[String],
    added: &[String],
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let line_num_width = removed.len().max(added.len()).to_string().len();
    let mut rows: Vec<Line> = Vec::new();
    let mut old_num = 1usize;
    let mut new_num = 1usize;
    for op in line_diff(removed, added) {
        let (prefix, num, line) = match op {
            DiffOp::Context(line) => {
                // TS `generateDiffString` advances both counters on
                // context lines, so added rows after a change keep the
                // new-file numbering.
                let num = old_num;
                old_num += 1;
                new_num += 1;
                (' ', num, line)
            }
            DiffOp::Removed(line) => {
                let num = old_num;
                old_num += 1;
                ('-', num, line)
            }
            DiffOp::Added(line) => {
                let num = new_num;
                new_num += 1;
                ('+', num, line)
            }
        };
        let (bg, gutter_color, content_color) = match prefix {
            '+' => {
                if theme.mode == ColorMode::TrueColor {
                    (
                        ThemeBg::ToolDiffAddedBg,
                        ThemeColor::ToolDiffAdded,
                        ThemeColor::MdCodeBlock,
                    )
                } else {
                    (
                        ThemeBg::ToolPanelBg,
                        ThemeColor::ToolDiffAdded,
                        ThemeColor::ToolDiffAdded,
                    )
                }
            }
            '-' => {
                if theme.mode == ColorMode::TrueColor {
                    (
                        ThemeBg::ToolDiffRemovedBg,
                        ThemeColor::ToolDiffRemoved,
                        ThemeColor::MdCodeBlock,
                    )
                } else {
                    (
                        ThemeBg::ToolPanelBg,
                        ThemeColor::ToolDiffRemoved,
                        ThemeColor::ToolDiffRemoved,
                    )
                }
            }
            _ => (
                ThemeBg::ToolPanelBg,
                ThemeColor::ToolDiffContext,
                ThemeColor::MdCodeBlock,
            ),
        };
        let gutter = format!(" {num:>line_num_width$} {prefix} ");
        let content = line.replace('\t', "   ");
        let content_width = width.saturating_sub(str_width(&gutter)).max(1);
        let wrapped = wrap_text(&content, content_width);
        for (index, wrapped_line) in wrapped.into_iter().enumerate() {
            let mut row: Line = Vec::new();
            if index == 0 {
                row.push(Span::styled(
                    gutter.clone(),
                    theme.fg_style(gutter_color).patch(theme.bg_style(bg)),
                ));
            } else {
                row.push(Span::styled(
                    " ".repeat(str_width(&gutter)),
                    theme.bg_style(bg),
                ));
            }
            for span in wrapped_line {
                row.push(Span::styled(
                    span.content,
                    theme.fg_style(content_color).patch(theme.bg_style(bg)),
                ));
            }
            // TS `theme.bg` covers the row's trailing padding too: the
            // background block reaches the full width.
            rows.push(pad_with(row, width, theme.bg_style(bg)));
        }
    }
    rows
}

/// One line-diff op over the field's removed/added values.
enum DiffOp {
    Context(String),
    Removed(String),
    Added(String),
}

/// Longest-common-subsequence line diff (the full-context form of the TS
/// `diff` package's `diffLines`): equal runs stay in order, removals come
/// before the additions that replace them.
fn line_diff(removed: &[String], added: &[String]) -> Vec<DiffOp> {
    let mut table = vec![vec![0usize; added.len() + 1]; removed.len() + 1];
    for (i, r) in removed.iter().enumerate().rev() {
        for (j, a) in added.iter().enumerate().rev() {
            table[i][j] = if r == a {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    let mut ops = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < removed.len() && j < added.len() {
        if removed[i] == added[j] {
            ops.push(DiffOp::Context(removed[i].clone()));
            i += 1;
            j += 1;
        } else if table[i + 1][j] >= table[i][j + 1] {
            ops.push(DiffOp::Removed(removed[i].clone()));
            i += 1;
        } else {
            ops.push(DiffOp::Added(added[j].clone()));
            j += 1;
        }
    }
    while i < removed.len() {
        ops.push(DiffOp::Removed(removed[i].clone()));
        i += 1;
    }
    while j < added.len() {
        ops.push(DiffOp::Added(added[j].clone()));
        j += 1;
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::custom_message::REFINEMENT_OUTCOME_CUSTOM_TYPE;
    use serde_json::json;

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn flat(row: &Line) -> String {
        row.iter().map(|s| s.content.as_str()).collect()
    }

    fn decoded(message: serde_json::Value) -> Vec<ChatEntry> {
        crate::custom_message::custom_message_entries(&message)
    }

    #[test]
    fn refinement_outcome_decodes_header_and_edits() {
        let entries = decoded(json!({
            "role": "custom",
            "customType": REFINEMENT_OUTCOME_CUSTOM_TYPE,
            "content": "Refinement complete: add a memory",
            "display": true,
            "details": {
                "refinementId": "refine_1",
                "summary": "add a memory",
                "scope": "local",
                "edits": [
                    {
                        "action": "create",
                        "kind": "memory",
                        "id": "mission",
                        "applied": true,
                        "reason": "durable",
                        "title": "Mission",
                        "content": "Keep going",
                        "after": { "id": "mission", "kind": "memory", "title": "Mission", "content": "Keep going", "scope": "local" },
                    }
                ],
            },
        }));
        let [ChatEntry::RefinementOutcome(row)] = entries.as_slice() else {
            panic!("refinement row: {entries:?}");
        };
        assert_eq!(row.header, "Harness refined");
        assert_eq!(row.summary, "add a memory");
        assert_eq!(
            row.meta,
            "Harness refined \u{b7} 1 memory created \u{b7} Refinement refine_1 \u{b7} local"
        );
        assert_eq!(row.edits.len(), 1);
        assert_eq!(row.edits[0].label[0].text, "Created");
        assert_eq!(row.edits[0].label[1].text, " local memory `mission`");
        assert_eq!(row.edits[0].reason.as_deref(), Some("durable"));
        // Create edits show their value as added change rows.
        let field = &row.edits[0].fields[0];
        assert_eq!(field.label, "Title");
        assert_eq!(
            field.change.as_ref().unwrap().1,
            vec!["Mission".to_string()]
        );

        // TS `isRefinementOutcomeMessage` runs `edits.every(isAppliedRefinementEdit)`,
        // which passes on an empty list: an outcome with no edits is valid
        // and renders the `Harness unchanged` row.
        let empty = decoded(json!({
            "role": "custom",
            "customType": REFINEMENT_OUTCOME_CUSTOM_TYPE,
            "content": "Refinement complete: ?",
            "display": true,
            "details": { "refinementId": "x", "summary": "?", "scope": "local", "edits": [] },
        }));
        let [ChatEntry::RefinementOutcome(row)] = empty.as_slice() else {
            panic!("empty-edits refinement row: {empty:?}");
        };
        assert_eq!(row.header, "Harness unchanged \u{b7} no edits applied");

        // An unknown scope fails the TS envelope check and renders the notice.
        let malformed = decoded(json!({
            "role": "custom",
            "customType": REFINEMENT_OUTCOME_CUSTOM_TYPE,
            "content": "Refinement complete: ?",
            "display": true,
            "details": { "refinementId": "x", "summary": "?", "scope": "team", "edits": [] },
        }));
        assert_eq!(
            malformed,
            vec![ChatEntry::Status {
                text: "[Malformed refinement outcome message]".to_string(),
                kind: StatusKind::Error,
            }]
        );
    }

    #[test]
    fn refinement_outcome_lines_match_ts() {
        // TS `refinementHeader` across the applied/total matrix.
        let edit = |applied: bool, kind: &str, action: &str| json!({ "action": action, "kind": kind, "id": "e", "applied": applied });
        // TS `refinementHeader` filters `edits.filter((edit) => edit.applied)`
        // before comparing to the total, so the helper passes only the
        // applied edits as the applied list.
        let line = |edits: Vec<serde_json::Value>, rollback: bool| {
            let applied: Vec<&Value> = edits
                .iter()
                .filter(|edit| edit.get("applied").and_then(Value::as_bool) == Some(true))
                .collect();
            refinement_outcome_line(&edits, &applied, rollback.then_some("r"))
        };
        assert_eq!(
            line(
                vec![
                    edit(true, "memory", "create"),
                    edit(false, "memory", "create")
                ],
                false
            ),
            "Harness partially refined \u{b7} 1/2 edits applied"
        );
        assert_eq!(
            line(vec![], false),
            "Harness unchanged \u{b7} no edits applied"
        );
        assert_eq!(
            line(
                vec![
                    edit(true, "memory", "create"),
                    edit(true, "skill", "update")
                ],
                false
            ),
            "Harness refined \u{b7} 2 edits applied"
        );
        assert_eq!(
            line(vec![edit(true, "skill", "delete")], true),
            "Harness rollback completed \u{b7} 1 edit applied"
        );
        assert_eq!(
            line(
                vec![edit(true, "skill", "delete"), edit(true, "skill", "delete")],
                true
            ),
            "Harness rollback completed \u{b7} 2 edits applied"
        );
        // Edits present but none applied: the operation-failed line (TS
        // distinguishes this from the empty-edit "unchanged" line).
        assert_eq!(
            line(vec![edit(false, "memory", "create")], false),
            "Harness refinement failed \u{b7} 0/1 edits applied"
        );
        assert_eq!(
            line(
                vec![
                    edit(false, "memory", "create"),
                    edit(false, "memory", "update")
                ],
                true
            ),
            "Harness rollback failed \u{b7} 0/2 edits applied"
        );
    }

    #[test]
    fn refinement_outcome_collapsed_shape() {
        let row = RefinementOutcomeRow {
            header: "Harness refined".to_string(),
            summary: "add a memory for the mission".to_string(),
            meta: "Harness refined \u{b7} 1 memory created \u{b7} Refinement r1 \u{b7} local"
                .to_string(),
            edits: Vec::new(),
        };
        let rows = render_refinement_outcome(&row, Detail::Overview, &theme(), 60);
        // Blank, diamond header, summary row.
        assert!(rows[0].is_empty());
        assert_eq!(flat(&rows[1]).trim_end(), " \u{25c6} Harness refined");
        assert_eq!(
            rows[1][1],
            Span::styled(
                "\u{25c6} Harness refined".to_string(),
                theme().fg_style(ThemeColor::RefinementHeader)
            )
        );
        assert_eq!(flat(&rows[2]), " add a memory for the mission");
        // TS `EventSummary` colors the inset space inside the summary
        // span (the space is part of the styled text): one styled span.
        assert_eq!(
            rows[2],
            vec![Span::styled(
                " add a memory for the mission".to_string(),
                theme().fg_style(ThemeColor::RefinementSummary)
            )]
        );
    }

    #[test]
    fn refinement_summary_collapses_whitespace_and_clamps() {
        let row = RefinementOutcomeRow {
            header: "Harness refined".to_string(),
            summary: "one   two\n\nthree four five six seven".to_string(),
            meta: String::new(),
            edits: Vec::new(),
        };
        // Collapsed (TS `EventSummary` under `setExpanded(false)`, i.e.
        // tool output not expanded): whitespace-collapsed and clamped to
        // two lines at width 14 (content width 13), the second line keeps
        // its ellipsis. `Detail::Details` expands edit diffs but not tool
        // output, so the summary stays collapsed there too.
        let rows = render_refinement_outcome(&row, Detail::Overview, &theme(), 14);
        // TS `Text(…, 1, 0)` wraps the header at content width 12, so the
        // `◆ Harness refined` header spans rows[1..3] before the summary.
        assert_eq!(flat(&rows[1]).trim_end(), " \u{25c6} Harness");
        assert_eq!(flat(&rows[2]).trim_end(), " refined");
        assert_eq!(flat(&rows[3]), " one two three");
        assert_eq!(flat(&rows[4]), " four five si\u{2026}");
        let rows = render_refinement_outcome(&row, Detail::Details, &theme(), 60);
        assert!(rows
            .iter()
            .any(|r| flat(r) == " one two three four five six seven"));
        // Expanded (`Detail::All`): the raw text.
        let rows = render_refinement_outcome(&row, Detail::All, &theme(), 60);
        assert!(rows.iter().any(|r| flat(r) == " one   two"));
    }

    #[test]
    fn refinement_expanded_shows_meta_and_edits() {
        let row = RefinementOutcomeRow {
            header: "Harness refined".to_string(),
            summary: "add a memory".to_string(),
            meta: "Harness refined \u{b7} 1 memory created \u{b7} Refinement r1 \u{b7} local"
                .to_string(),
            edits: vec![RefinementEditRow {
                label: vec![
                    LabelPart {
                        text: "Created".to_string(),
                        color: Some(ThemeColor::Success),
                    },
                    LabelPart {
                        text: " local memory `mission`".to_string(),
                        color: None,
                    },
                ],
                reason: Some("durable".to_string()),
                fields: vec![
                    EditField {
                        label: "Title".to_string(),
                        value: Vec::new(),
                        change: Some((vec![], vec!["Mission".to_string()])),
                    },
                    EditField {
                        label: "Description".to_string(),
                        value: vec!["Keep going".to_string()],
                        change: None,
                    },
                ],
            }],
        };
        let rows = render_refinement_outcome(&row, Detail::All, &theme(), 60);
        let text: Vec<String> = rows
            .iter()
            .map(|r| flat(r).trim_end().to_string())
            .collect();
        let meta = text
            .iter()
            .position(|r| {
                r == " Harness refined \u{b7} 1 memory created \u{b7} Refinement r1 \u{b7} local"
            })
            .expect("meta row");
        let label = text
            .iter()
            .position(|r| r == " Created local memory `mission`")
            .expect("edit label");
        let field_label = text
            .iter()
            .position(|r| r == " Title")
            .expect("field label");
        let added = text
            .iter()
            .position(|r| r.contains(" + Mission"))
            .expect("+ added row");
        let value = text
            .iter()
            .position(|r| r == " Keep going")
            .expect("value row");
        let reason = text
            .iter()
            .position(|r| r == " Reason: durable")
            .expect("reason row");
        assert!(meta < label && label < field_label && field_label < added);
        assert!(added < value && value < reason);
    }

    #[test]
    fn change_rows_render_full_context_diff() {
        let theme = theme();
        let rows = rich_change_rows(
            &["alpha".to_string(), "beta".to_string()],
            &["alpha".to_string(), "gamma".to_string()],
            &theme,
            40,
        );
        let text: Vec<String> = rows
            .iter()
            .map(|r| flat(r).trim_end().to_string())
            .collect();
        // Gutter ` <num> <prefix> ` (TS `buildRichDiffLine`), removed
        // rows on the removed background, added rows on the added one.
        assert_eq!(
            text,
            vec![
                " 1   alpha".to_string(),
                " 2 - beta".to_string(),
                " 2 + gamma".to_string(),
            ],
            "{text:?}"
        );
        assert_eq!(
            rows[1][0].style,
            theme
                .fg_style(ThemeColor::ToolDiffRemoved)
                .patch(theme.bg_style(ThemeBg::ToolDiffRemovedBg))
        );
        assert_eq!(
            rows[2][0].style,
            theme
                .fg_style(ThemeColor::ToolDiffAdded)
                .patch(theme.bg_style(ThemeBg::ToolDiffAddedBg))
        );
    }
}
