//! Injected-prompt rows (TS `InjectedPromptMessageComponent`): the kind's
//! header line, plus the markdown body in the expanded view. Decode maps
//! each custom type to its kind (TS `isInjectedPromptMessage`); the render
//! ports each header shape and the expand contract.
//!
//! Divergence (Kevin directive 2026-09-23, product improvement beyond the
//! TS binary): the RLM child rows render the `◆ Subagent <name>
//! finished|failed|cancelled` diamond rows — accent diamond, semantically
//! colored label, the failure error and the cancellation reason as the
//! expandable body — where the TS binary still shows the generic muted
//! `RLM child status` label over the full content markdown. The TS side is
//! expected to adopt the same rows.

use super::render::{markdown_rows, spacer, text_rows, truncate_text};
use super::{
    custom_content_text, GOAL_CONTEXT_CUSTOM_TYPE, HEARTBEAT_PROMPT_CUSTOM_TYPE,
    IPYTHON_STATE_RESTORED_CUSTOM_TYPE, RLM_CHILD_FAILURE_CUSTOM_TYPE,
    RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
};
use crate::chat::Detail;
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};
use serde_json::Value;

/// One injected prompt row (TS `InjectedPromptMessageComponent`); the kind
/// picks the header shape, `body` renders as markdown when expanded.
#[derive(Debug, Clone, PartialEq)]
pub struct InjectedPromptRow {
    pub kind: InjectedPromptKind,
    /// Markdown body (`None` renders nothing extra when expanded).
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum InjectedPromptKind {
    /// `♥ Heartbeat prompt · <schedule>` (error pulse, muted label).
    Heartbeat { schedule: Option<String> },
    /// `<goal label>[ · <objective preview>]` (muted; TS `goalLabel`/`metaText`).
    Goal {
        kind: Option<String>,
        objective: Option<String>,
    },
    /// `◆ Restored Python kernel state` / `◆ Started fresh Python kernel`.
    KernelRestored { restored: bool },
    /// `◆ Subagent <name> finished|failed|cancelled` (accent diamond,
    /// semantic label color; failed/cancelled rows expand to the reason).
    RlmChildStatus {
        outcome: RlmChildOutcome,
        session_name: String,
    },
}

/// How a spawned child run ended (the `rlm_child_failure` /
/// `rlm_child_terminal_notice` details kinds).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RlmChildOutcome {
    /// The run finished its task (the `completed_without_reply` terminal
    /// notice; a child that replied explicitly never lands in this row).
    Finished,
    /// The run errored out.
    Failed,
    /// The parent deleted a still-running child.
    Cancelled,
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
        RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE => InjectedPromptKind::RlmChildStatus {
            outcome: if details.get("kind").and_then(Value::as_str) == Some("cancelled") {
                RlmChildOutcome::Cancelled
            } else {
                RlmChildOutcome::Finished
            },
            session_name: rlm_child_session_name(details, &content),
        },
        RLM_CHILD_FAILURE_CUSTOM_TYPE => InjectedPromptKind::RlmChildStatus {
            outcome: RlmChildOutcome::Failed,
            session_name: rlm_child_session_name(details, &content),
        },
        _ => InjectedPromptKind::RlmChildStatus {
            outcome: RlmChildOutcome::Finished,
            session_name: rlm_child_session_name(details, &content),
        },
    };
    let body = match &kind {
        // The kernel-state row stays header-only (TS keeps
        // `ipython_state_restored` header-only); a finished child carries
        // no reason to expand.
        InjectedPromptKind::KernelRestored { .. } => None,
        InjectedPromptKind::RlmChildStatus { outcome, .. } => match outcome {
            RlmChildOutcome::Finished => None,
            RlmChildOutcome::Failed => rlm_child_reason(details, "error", &content),
            RlmChildOutcome::Cancelled => rlm_child_reason(details, "reason", &content),
        },
        _ => Some(content),
    };
    InjectedPromptRow { kind, body }
}

/// The child's session name: the `sessionName` details key, falling back to
/// the `child:<name>]` token of the content header (the pre-details wire
/// rows).
fn rlm_child_session_name(details: &Value, content: &str) -> String {
    details
        .get("sessionName")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| {
            content
                .split_once("child:")
                .and_then(|(_, rest)| rest.split(']').next())
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// The expandable reason body of a failed/cancelled row: the details field
/// (`error` / `reason`), falling back to the content after the
/// `[child-...]` header (the pre-details wire rows).
fn rlm_child_reason(details: &Value, field: &str, content: &str) -> Option<String> {
    details
        .get(field)
        .and_then(Value::as_str)
        .filter(|reason| !reason.is_empty())
        .map(str::to_string)
        .or_else(|| {
            content
                .split_once("\n\n")
                .map(|(_, reason)| reason.trim().to_string())
                .filter(|reason| !reason.is_empty())
        })
}

/// One injected-prompt row (TS `InjectedPromptMessageComponent`): a leading
/// blank, then the kind's header when collapsed, or the markdown body when
/// expanded (the kernel-state and finished-child rows stay header-only in
/// both states).
pub(crate) fn render_injected_prompt(
    row: &InjectedPromptRow,
    detail: Detail,
    theme: &Theme,
    width: usize,
) -> Vec<Line> {
    let muted = theme.fg_style(ThemeColor::Muted);
    let dim = theme.fg_style(ThemeColor::Dim);
    let accent = theme.fg_style(ThemeColor::Accent);
    let mut out = vec![spacer()];
    let expanded = detail.tool_output_expanded();
    // TS `InjectedPromptMessageComponent.updateDisplay`: the header always
    // renders; the expanded form adds the markdown body below it (the
    // kernel-state row stays header-only).
    let mut header: Line = match &row.kind {
        InjectedPromptKind::Heartbeat { schedule } => vec![
            Span::styled("\u{2665}".to_string(), theme.fg_style(ThemeColor::Error)),
            Span::raw(" "),
            Span::styled("Heartbeat prompt".to_string(), muted),
            Span::styled(" \u{b7} ".to_string(), dim),
            Span::styled(heartbeat_schedule(schedule), muted),
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
        InjectedPromptKind::RlmChildStatus {
            outcome,
            session_name,
        } => {
            let (label, color) = match outcome {
                RlmChildOutcome::Finished => ("finished", ThemeColor::Success),
                RlmChildOutcome::Failed => ("failed", ThemeColor::Error),
                RlmChildOutcome::Cancelled => ("cancelled", ThemeColor::Warning),
            };
            let label = if session_name.is_empty() {
                format!("Subagent {label}")
            } else {
                format!("Subagent {session_name} {label}")
            };
            vec![
                Span::styled("\u{25c6}".to_string(), accent),
                Span::raw(" "),
                Span::styled(label, theme.fg_style(color)),
            ]
        }
    };
    // TS `headerText`: the collapsed expandable rows append the dim expand
    // hint (`expandCollapseHint("app.tools.expand")` renders empty,
    // leaving the dim-colored space); header-only rows never do.
    if !expanded && row.body.is_some() {
        header.push(Span::styled(" ".to_string(), dim));
    }
    out.extend(text_rows(header, width));
    if expanded {
        if let Some(body) = &row.body {
            out.extend(markdown_rows(
                body,
                ThemeColor::CustomMessageText,
                theme,
                width,
            ));
        }
    }
    out
}

/// TS `heartbeatPromptSchedule` over `compactHeartbeatSchedule`: a blank
/// schedule shows as `scheduled` (the `prompt` compact form), every other
/// expression as `every <expression>` (a leading case-insensitive `every`
/// plus whitespace stripped from the stored expression first).
fn heartbeat_schedule(schedule: &Option<String>) -> String {
    let trimmed = schedule.as_deref().map(str::trim).unwrap_or("");
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

/// TS `goalLabel`.
fn goal_label(kind: Option<&str>) -> String {
    match kind {
        Some("continuation") => "Goal continuation",
        Some("budget_limit") => "Goal budget limit",
        Some("objective_updated") => "Goal updated",
        _ => "Goal context",
    }
    .to_string()
}

/// TS `metaText`: ` \u{b7} <collapsed objective>` truncated to the TS budget
/// (`max(20, 90 - width("Goal continuation \u{b7} "))` = 70) with the default
/// `...` ellipsis.
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

    fn decoded_row(value: serde_json::Value) -> InjectedPromptRow {
        let entry = super::super::custom_message_entries(&value)
            .pop()
            .expect("one entry");
        match entry {
            crate::chat::ChatEntry::InjectedPrompt(boxed) => *boxed,
            other => panic!("not an injected prompt: {other:?}"),
        }
    }

    #[test]
    fn heartbeat_header_and_schedule_forms() {
        assert_eq!(
            heartbeat_schedule(&Some("every 10m".to_string())),
            "every 10m"
        );
        assert_eq!(heartbeat_schedule(&Some("10m".to_string())), "every 10m");
        // TS `/^every\s+/i`: case-insensitive with any whitespace run;
        // `every` without whitespace stays part of the expression.
        assert_eq!(
            heartbeat_schedule(&Some("EVERY  10m".to_string())),
            "every 10m"
        );
        assert_eq!(
            heartbeat_schedule(&Some("every10m".to_string())),
            "every every10m"
        );
        assert_eq!(heartbeat_schedule(&Some("prompt".to_string())), "scheduled");
        assert_eq!(heartbeat_schedule(&Some("  ".to_string())), "scheduled");
        assert_eq!(heartbeat_schedule(&None), "scheduled");
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
            " \u{2665} Heartbeat prompt \u{b7} every 10m"
        );
        assert_eq!(
            rows[1][1],
            Span::styled("\u{2665}".to_string(), theme().fg_style(ThemeColor::Error))
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
        // A long objective truncates to the TS budget with the default
        // `...` ellipsis, after whitespace collapsing. TS `metaText`
        // truncates only the objective (70 columns); the rendered row
        // adds the 1-column inset plus the 20-column
        // `Goal continuation \u{b7} ` prefix for a 91-wide line.
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
        // The truncated objective alone stays within the TS budget.
        let prefix = " Goal continuation \u{b7} ";
        assert_eq!(
            str_width(preview.trim_start_matches(prefix)) + 3,
            70,
            "objective {meta:?}"
        );
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
            // Header only, no body even expanded.
            assert_eq!(rows.len(), 2, "{rows:?}");
            assert_eq!(flat(&rows[1]).trim_end(), format!(" \u{25c6} {label}"));
        }
    }

    #[test]
    fn rlm_child_rows_decode_the_outcome_and_name() {
        // The failure row: Failed outcome, the error as the body.
        let row = decoded_row(serde_json::json!({
            "role": "custom",
            "customType": RLM_CHILD_FAILURE_CUSTOM_TYPE,
            "content": "[child-failed child:boom-worker]\n\nthe model stream died",
            "display": true,
            "details": { "childId": "sub-1", "sessionName": "boom-worker", "error": "the model stream died" },
        }));
        assert_eq!(
            row.kind,
            InjectedPromptKind::RlmChildStatus {
                outcome: RlmChildOutcome::Failed,
                session_name: "boom-worker".to_string(),
            }
        );
        assert_eq!(row.body.as_deref(), Some("the model stream died"));
        // The cancelled terminal notice: Warning outcome, the reason body.
        let row = decoded_row(serde_json::json!({
            "role": "custom",
            "customType": RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
            "content": "[child-exited: cancelled child:cancel-worker]\n\nDeleted by parent",
            "display": true,
            "details": {
                "kind": "cancelled", "childId": "sub-2", "sessionName": "cancel-worker",
                "reason": "Deleted by parent",
            },
        }));
        assert_eq!(
            row.kind,
            InjectedPromptKind::RlmChildStatus {
                outcome: RlmChildOutcome::Cancelled,
                session_name: "cancel-worker".to_string(),
            }
        );
        assert_eq!(row.body.as_deref(), Some("Deleted by parent"));
        // The finished terminal notice: no body, no reply preview (the
        // last-assistant-text preview stays out of the row).
        let row = decoded_row(serde_json::json!({
            "role": "custom",
            "customType": RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
            "content": "[child-exited: no-reply child:lane]\n\nLast assistant text: done",
            "display": true,
            "details": {
                "kind": "completed_without_reply", "childId": "sub-3", "sessionName": "lane",
                "lastAssistantTextPreview": "done",
            },
        }));
        assert_eq!(
            row.kind,
            InjectedPromptKind::RlmChildStatus {
                outcome: RlmChildOutcome::Finished,
                session_name: "lane".to_string(),
            }
        );
        assert_eq!(row.body, None);
        // A cancellation without a reason stays header-only.
        let row = decoded_row(serde_json::json!({
            "role": "custom",
            "customType": RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
            "content": "[child-exited: cancelled child:quiet]",
            "display": true,
            "details": {
                "kind": "cancelled", "childId": "sub-4", "sessionName": "quiet", "reason": null,
            },
        }));
        assert_eq!(row.body, None);
    }

    #[test]
    fn rlm_child_rows_fall_back_to_the_content_header() {
        // Pre-details wire rows: the name comes from the `child:<name>]`
        // content token, the reason from the content after the header.
        let row = decoded_row(serde_json::json!({
            "role": "custom",
            "customType": RLM_CHILD_FAILURE_CUSTOM_TYPE,
            "content": "[child-failed child:legacy-worker]\n\nspawn failed",
            "display": true,
            "details": serde_json::Value::Null,
        }));
        assert_eq!(
            row.kind,
            InjectedPromptKind::RlmChildStatus {
                outcome: RlmChildOutcome::Failed,
                session_name: "legacy-worker".to_string(),
            }
        );
        assert_eq!(row.body.as_deref(), Some("spawn failed"));
    }

    #[test]
    fn rlm_child_rows_render_the_diamond_labels() {
        let theme = theme();
        let diamond = theme.fg_style(ThemeColor::Accent);
        for (outcome, session_name, label, color) in [
            (
                RlmChildOutcome::Finished,
                "lane",
                "Subagent lane finished",
                ThemeColor::Success,
            ),
            (
                RlmChildOutcome::Failed,
                "boom-worker",
                "Subagent boom-worker failed",
                ThemeColor::Error,
            ),
            (
                RlmChildOutcome::Cancelled,
                "cancel-worker",
                "Subagent cancel-worker cancelled",
                ThemeColor::Warning,
            ),
        ] {
            let row = InjectedPromptRow {
                kind: InjectedPromptKind::RlmChildStatus {
                    outcome,
                    session_name: session_name.to_string(),
                },
                body: None,
            };
            let rows = render_injected_prompt(&row, Detail::Overview, &theme, 60);
            assert_eq!(rows.len(), 2, "{rows:?}");
            assert_eq!(flat(&rows[1]).trim_end(), format!(" \u{25c6} {label}"));
            // The diamond stays accent; the label carries the semantic
            // color of the outcome.
            assert_eq!(rows[1][1], Span::styled("\u{25c6}".to_string(), diamond));
            assert_eq!(rows[1][3], Span::styled(label, theme.fg_style(color)));
        }
    }

    #[test]
    fn rlm_child_status_expand_contract() {
        // The finished row stays header-only in both states.
        let row = InjectedPromptRow {
            kind: InjectedPromptKind::RlmChildStatus {
                outcome: RlmChildOutcome::Finished,
                session_name: "lane".to_string(),
            },
            body: None,
        };
        let expanded = render_injected_prompt(&row, Detail::All, &theme(), 60);
        assert_eq!(expanded.len(), 2, "header-only expanded: {expanded:?}");
        assert_eq!(
            flat(&expanded[1]).trim_end(),
            " \u{25c6} Subagent lane finished"
        );
        // The failed row keeps the header and renders the error body.
        let row = InjectedPromptRow {
            kind: InjectedPromptKind::RlmChildStatus {
                outcome: RlmChildOutcome::Failed,
                session_name: "boom-worker".to_string(),
            },
            body: Some("the model stream died".to_string()),
        };
        let expanded = render_injected_prompt(&row, Detail::All, &theme(), 60);
        assert!(expanded.len() > 2, "body renders expanded: {expanded:?}");
        assert_eq!(
            flat(&expanded[1]).trim_end(),
            " \u{25c6} Subagent boom-worker failed"
        );
    }
}
