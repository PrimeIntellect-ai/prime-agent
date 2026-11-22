//! The collapsed inbox-notice line: one dim row that counts a run of
//! consecutive inbox notices (`✉ Agent inbox · 3 new (2 bash-done,
//! 1 agent-message)`) in place of a full row per notice. The per-notice
//! rows render only when the run is expanded.

use super::InboxNoticeRow;
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};
use pa_types::inbox_notice::{INBOX_NOTICE_CLASS_REMINDER, INBOX_NOTICE_SENDER};

/// The collapsed run's one dim row: the new messages the run's arrivals
/// announce with their per-class breakdown, then the waiting count of the
/// run's latest reminder.
pub(crate) fn counter_line(notices: &[&InboxNoticeRow], theme: &Theme) -> Line {
    let mut new = 0u64;
    let mut classes: Option<Vec<(String, u64)>> = Some(Vec::new());
    let mut waiting = None;
    for notice in notices {
        if notice.class == INBOX_NOTICE_CLASS_REMINDER {
            waiting = notice.count;
            continue;
        }
        new = new.saturating_add(notice.count.unwrap_or(1));
        classes = classes
            .zip(arrival_classes(&notice.text))
            .map(|(mut all, parsed)| {
                for (class, count) in parsed {
                    match all.iter_mut().find(|(seen, _)| *seen == class) {
                        Some((_, total)) => *total = total.saturating_add(count),
                        None => all.push((class, count)),
                    }
                }
                all
            });
    }
    let mut parts = Vec::new();
    if new > 0 {
        let breakdown = classes
            .filter(|all| !all.is_empty())
            .map(|all| {
                let listed = all
                    .iter()
                    .map(|(class, count)| format!("{count} {class}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(" ({listed})")
            })
            .unwrap_or_default();
        parts.push(format!("{new} new{breakdown}"));
    }
    if let Some(waiting) = waiting {
        parts.push(format!("{waiting} waiting"));
    }
    let dim = theme.fg_style(ThemeColor::Dim);
    vec![
        Span::styled("\u{2709} ".to_string(), dim),
        Span::styled(format!("{INBOX_NOTICE_SENDER} \u{b7} "), dim),
        Span::styled(parts.join(" \u{b7} "), dim),
    ]
}

/// The per-class counts of one arrival notice, read from the summary the
/// daemon writes after the `[inbox <time> UTC] ` signature (the wire row
/// carries only the total): `1 new message (bash-done)`, `3 new bash-done
/// messages`, or `3 new messages (2 bash-done, 1 child-exited)`. `None`
/// for any other shape.
fn arrival_classes(text: &str) -> Option<Vec<(String, u64)>> {
    let summary = text.split_once("] ")?.1;
    let summary = summary.split(';').next()?;
    let (count, rest) = summary.split_once(" new ")?;
    let count: u64 = count.parse().ok()?;
    if let Some(class) = rest
        .strip_prefix("message (")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return Some(vec![(class.to_string(), count)]);
    }
    if let Some(breakdown) = rest
        .strip_prefix("messages (")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return breakdown
            .split(", ")
            .map(|item| {
                let (count, class) = item.split_once(' ')?;
                Some((class.to_string(), count.parse().ok()?))
            })
            .collect();
    }
    let class = rest.strip_suffix(" messages")?;
    Some(vec![(class.to_string(), count)])
}
