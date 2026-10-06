//! Injected-prompt rows (TS `InjectedPromptMessageComponent`): the kind's
//! header line, plus the guttered markdown body in the expanded view.
//! Decode maps each custom type to its kind (TS `isInjectedPromptMessage`);
//! the render ports each header shape and the expand contract.
//!
//! The RLM child status notices left this class (the operator's 2026-10-01
//! directive: "the factory child status notices should be like subagent
//! messages not user messages" — a spawned child's exit status is
//! child-originated mail, so those rows render in the `agent_message`
//! class now, superseding the 2026-09-23 diamond-row divergence): the
//! kinds here are the engine-injected turn prompts only — the heartbeat
//! prompt, the goal context, the kernel-state restore, and the
//! skills-unavailable report.
//!
//! Second divergence (operator directive 2026-09-23): the heartbeat prompt
//! row renders the `◷` clock glyph — the unified activity dock's
//! Heartbeats group icon (`chrome.rs::render_activity_dock`) — where the
//! TS binary still renders the `♥` heart. The TS side is expected to
//! adopt the same glyph.

use super::render::{spacer, text_rows, truncate_text};
use super::{
    custom_content_text, GOAL_CONTEXT_CUSTOM_TYPE, HEARTBEAT_PROMPT_CUSTOM_TYPE,
    IPYTHON_STATE_RESTORED_CUSTOM_TYPE, PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
};
use crate::chat::Detail;
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};
use serde_json::Value;

/// One injected prompt row; the kind picks the header shape, `body`
/// renders as markdown when expanded.
#[derive(Debug, Clone, PartialEq)]
pub struct InjectedPromptRow {
    pub kind: InjectedPromptKind,
    /// Markdown body (`None` renders nothing extra when expanded).
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum InjectedPromptKind {
    /// `◷ Heartbeat prompt · <schedule>` (the clock glyph is the dock's
    /// Heartbeats icon — the module docs' divergence).
    Heartbeat { schedule: Option<String> },
    /// `<goal label>[ · <objective preview>]` (muted; TS `goalLabel`/`metaText`).
    Goal {
        kind: Option<String>,
        objective: Option<String>,
    },
    /// `◆ Restored Python kernel state` / `◆ Started fresh Python
    /// kernel`.
    KernelRestored { restored: bool },
    /// `Python skills unavailable · <skill names>` (muted label, dim
    /// names, no marker glyph), expandable to the full report.
    PythonSkillsUnavailable { skills: Vec<String> },
}

/// One injected-prompt row (TS `isInjectedPromptMessage` kinds).
pub(crate) fn injected_prompt_row(
    custom_type: &str,
    message: &Value,
    details: &Value,
) -> InjectedPromptRow {
    let content = custom_content_text(message);
    let kind = match custom_type {
        HEARTBEAT_PROMPT_CUSTOM_TYPE => InjectedPromptKind::Heartbeat {
            schedule: details
                .get("schedule")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        GOAL_CONTEXT_CUSTOM_TYPE => InjectedPromptKind::Goal {
            kind: details
                .get("kind")
                .and_then(Value::as_str)
                .map(str::to_string),
            objective: details
                .get("objective")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        IPYTHON_STATE_RESTORED_CUSTOM_TYPE => InjectedPromptKind::KernelRestored {
            restored: details.get("restored").and_then(Value::as_bool) != Some(false),
        },
        PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE => InjectedPromptKind::PythonSkillsUnavailable {
            skills: details
                .get("skills")
                .and_then(Value::as_array)
                .map(|names| {
                    names
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        },
        // The dispatch routes only this module's four kinds here; every
        // other custom type (the RLM child status notices included — they
        // render in the `agent_message` class now) owns its own dispatch
        // arm, and an unknown type never reaches this function.
        _ => unreachable!("injected_prompt_row sees only its four kinds"),
    };
    let body = match &kind {
        // The kernel-state row stays header-only (TS keeps
        // `ipython_state_restored` header-only).
        InjectedPromptKind::KernelRestored { .. } => None,
        _ => Some(content),
    };
    InjectedPromptRow { kind, body }
}

/// One injected-prompt row (TS `InjectedPromptMessageComponent`): a leading
/// blank, the kind's header, then the guttered markdown body below it when
/// expanded (the kernel-state row stays header-only in both states).
pub(crate) fn render_injected_prompt(
    row: &InjectedPromptRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let mut out = vec![spacer()];
    let header = prompt_header(row, theme);
    out.extend(text_rows(&header, width));
    if let Some(body) = expanded_prompt_body(row, detail) {
        out.extend(crate::branch::branch_markdown(
            body,
            &super::geometry::markdown_style(ThemeColor::CustomMessageText, theme),
            theme,
            width,
        ));
    }
    out
}

fn prompt_header(row: &InjectedPromptRow, theme: &Theme) -> Line {
    let muted = theme.fg_style(ThemeColor::Muted);
    let dim = theme.fg_style(ThemeColor::Dim);
    let accent = theme.fg_style(ThemeColor::Accent);
    // The header always renders; the expanded form adds the markdown
    // body below it.
    let header: Line = match &row.kind {
        InjectedPromptKind::Heartbeat { schedule } => vec![
            // The ◷ clock (the module docs' divergence from the TS ♥
            // heart).
            Span::styled("\u{25f7}".to_string(), theme.fg_style(ThemeColor::Error)),
            Span::raw(" "),
            Span::styled("Heartbeat prompt".to_string(), muted),
            Span::styled(" \u{b7} ".to_string(), dim),
            Span::styled(heartbeat_schedule(schedule.as_deref()), muted),
        ],
        InjectedPromptKind::Goal { kind, objective } => {
            let mut spans: Line = vec![Span::styled(goal_label(kind.as_deref()), muted)];
            if let Some(objective) = objective {
                spans.push(Span::styled(goal_meta(objective), muted));
            }
            spans
        }
        InjectedPromptKind::KernelRestored { restored } => vec![
            Span::styled("\u{25c6}".to_string(), accent),
            Span::raw(" "),
            Span::styled(
                if *restored {
                    "Restored Python kernel state"
                } else {
                    "Started fresh Python kernel"
                }
                .to_string(),
                muted,
            ),
        ],
        InjectedPromptKind::PythonSkillsUnavailable { skills } => {
            let mut spans = vec![Span::styled("Python skills unavailable".to_string(), muted)];
            if !skills.is_empty() {
                // TS `truncateToWidth(skills.join(", "),
                // max(20, 90 - "Python skills unavailable · ".length))` = 62.
                spans.push(Span::styled(
                    format!(" \u{b7} {}", truncate_text(&skills.join(", "), 62, "...")),
                    dim,
                ));
            }
            spans
        }
    };
    header
}

pub(crate) fn count_injected_prompt(
    row: &InjectedPromptRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
) -> usize {
    let header = prompt_header(row, theme);
    let body = expanded_prompt_body(row, detail).map_or(0, |body| {
        crate::branch::branch_markdown_count(
            body,
            &super::geometry::markdown_style(ThemeColor::CustomMessageText, theme),
            width,
        )
    });
    1 + super::geometry::text_row_count(&header, width) + body
}

fn expanded_prompt_body(row: &InjectedPromptRow, detail: Detail) -> Option<&str> {
    row.body
        .as_deref()
        .filter(|_| detail.tool_output_expanded())
}

/// A blank schedule shows as `scheduled`, every other expression as `every <expression>`
/// (a leading case-insensitive `every` plus whitespace stripped first).
fn heartbeat_schedule(schedule: Option<&str>) -> String {
    let trimmed = schedule.map_or("", str::trim);
    let compact = if trimmed.is_empty() {
        "prompt"
    } else if trimmed.get(..5).is_some_and(|prefix| {
        prefix.eq_ignore_ascii_case("every")
            && trimmed[5..].chars().next().is_some_and(char::is_whitespace)
    }) {
        trimmed[5..].trim_start()
    } else {
        trimmed
    };
    if compact == "prompt" {
        "scheduled".to_string()
    } else {
        format!("every {compact}")
    }
}

fn goal_label(kind: Option<&str>) -> String {
    match kind {
        Some("continuation") => "Goal continuation",
        Some("budget_limit") => "Goal budget limit",
        Some("objective_updated") => "Goal updated",
        _ => "Goal context",
    }
    .to_string()
}

/// ` \u{b7} <collapsed objective>` truncated to the 70-column budget with
/// the default `...` ellipsis.
fn goal_meta(objective: &str) -> String {
    let collapsed: String = objective.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(" \u{b7} {}", truncate_text(&collapsed, 70, "..."))
}

#[cfg(test)]
mod tests {

    use super::*;
    use crate::chat::Detail;
    use crate::theme::{ColorMode, Theme};
    use crate::width::str_width;
    use crate::Span;

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn flat(row: &Line) -> String {
        row.iter().map(|s| s.content.as_str()).collect()
    }

    #[test]
    fn heartbeat_header_and_schedule_forms() {
        assert_eq!(heartbeat_schedule(Some("every 10m")), "every 10m");
        assert_eq!(heartbeat_schedule(Some("10m")), "every 10m");
        // TS `/^every\s+/i`: case-insensitive with any whitespace run;
        // `every` without whitespace stays part of the expression.
        assert_eq!(heartbeat_schedule(Some("EVERY  10m")), "every 10m");
        assert_eq!(heartbeat_schedule(Some("every10m")), "every every10m");
        assert_eq!(heartbeat_schedule(Some("prompt")), "scheduled");
        assert_eq!(heartbeat_schedule(Some("  ")), "scheduled");
        assert_eq!(heartbeat_schedule(None), "scheduled");
        let row = InjectedPromptRow {
            kind: InjectedPromptKind::Heartbeat {
                schedule: Some("every 10m".to_string()),
            },
            body: Some("nudge".to_string()),
        };
        let rows = render_injected_prompt(&row, Detail::Overview, &theme(), 60);
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(rows[0].is_empty());
        assert_eq!(
            flat(&rows[1]).trim_end(),
            " \u{25f7} Heartbeat prompt \u{b7} every 10m"
        );
        assert_eq!(
            rows[1][1],
            Span::styled("\u{25f7}".to_string(), theme().fg_style(ThemeColor::Error))
        );
    }

    #[test]
    fn goal_header_label_and_meta() {
        let row = InjectedPromptRow {
            kind: InjectedPromptKind::Goal {
                kind: Some("continuation".to_string()),
                objective: Some("ship it today".to_string()),
            },
            body: Some("continue".to_string()),
        };
        let rows = render_injected_prompt(&row, Detail::Overview, &theme(), 60);
        assert_eq!(
            flat(&rows[1]).trim_end(),
            " Goal continuation \u{b7} ship it today"
        );
        // Budget-limit and objective-update kinds carry their own labels.
        for (kind, label) in [
            ("budget_limit", "Goal budget limit"),
            ("objective_updated", "Goal updated"),
            ("other", "Goal context"),
        ] {
            let row = InjectedPromptRow {
                kind: InjectedPromptKind::Goal {
                    kind: Some(kind.to_string()),
                    objective: None,
                },
                body: None,
            };
            let rows = render_injected_prompt(&row, Detail::Overview, &theme(), 60);
            assert_eq!(flat(&rows[1]).trim_end(), format!(" {label}"));
        }
        // A long objective truncates to the 70-column budget after whitespace collapsing;
        // the rendered row adds the inset plus the 20-column prefix for a 91-wide line.
        let objective = format!("{} tail", "word ".repeat(15));
        let row = InjectedPromptRow {
            kind: InjectedPromptKind::Goal {
                kind: Some("continuation".to_string()),
                objective: Some(objective),
            },
            body: None,
        };
        let rows = render_injected_prompt(&row, Detail::Overview, &theme(), 120);
        let rendered = flat(&rows[1]);
        let meta = rendered.trim_end();
        assert!(meta.ends_with("..."), "ellipsized meta: {meta:?}");
        let visible: String = meta.trim_end_matches('.').to_string();
        let preview = visible.trim_end();
        assert_eq!(str_width(preview) + 3, 91, "meta {meta:?}");
        let prefix = " Goal continuation \u{b7} ";
        assert_eq!(
            str_width(preview.trim_start_matches(prefix)) + 3,
            70,
            "objective {meta:?}"
        );
    }

    #[test]
    fn python_skills_unavailable_header_shapes() {
        // Collapsed: muted label + dim names, no body.
        let row = InjectedPromptRow {
            kind: InjectedPromptKind::PythonSkillsUnavailable {
                skills: vec!["websearch".to_string(), "edit".to_string()],
            },
            body: Some("[python-skills-unavailable]\n\n...".to_string()),
        };
        let rows = render_injected_prompt(&row, Detail::Overview, &theme(), 80);
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!(
            flat(&rows[1]).trim_end(),
            " Python skills unavailable \u{b7} websearch, edit"
        );
        assert_eq!(rows[1][1].style, theme().fg_style(ThemeColor::Muted));
        assert_eq!(rows[1][2].style, theme().fg_style(ThemeColor::Dim));
        // Expanded: no hint, the full report renders as the body.
        let rows = render_injected_prompt(&row, Detail::All, &theme(), 80);
        assert!(rows.len() > 2, "body renders expanded: {rows:?}");
        assert_eq!(
            flat(&rows[1]).trim_end(),
            " Python skills unavailable \u{b7} websearch, edit"
        );
        let long: Vec<String> = (0..12).map(|i| format!("skill-{i}")).collect();
        let row = InjectedPromptRow {
            kind: InjectedPromptKind::PythonSkillsUnavailable { skills: long },
            body: None,
        };
        let rows = render_injected_prompt(&row, Detail::Overview, &theme(), 120);
        let row_text = flat(&rows[1]);
        let meta = row_text.trim_end();
        let names = meta.trim_start_matches(" Python skills unavailable \u{b7} ");
        assert_eq!(str_width(names), 62, "names width: {names}");
        assert!(names.ends_with("..."), "ellipsized names: {names}");
        // No skills details: the label alone.
        let row = InjectedPromptRow {
            kind: InjectedPromptKind::PythonSkillsUnavailable { skills: Vec::new() },
            body: None,
        };
        let rows = render_injected_prompt(&row, Detail::Overview, &theme(), 80);
        assert_eq!(flat(&rows[1]).trim_end(), " Python skills unavailable");
    }

    #[test]
    fn kernel_state_labels() {
        for (restored, label) in [
            (true, "Restored Python kernel state"),
            (false, "Started fresh Python kernel"),
        ] {
            let row = InjectedPromptRow {
                kind: InjectedPromptKind::KernelRestored { restored },
                body: None,
            };
            let rows = render_injected_prompt(&row, Detail::All, &theme(), 60);
            assert_eq!(rows.len(), 2, "{rows:?}");
            assert_eq!(flat(&rows[1]).trim_end(), format!(" \u{25c6} {label}"));
        }
    }
}
