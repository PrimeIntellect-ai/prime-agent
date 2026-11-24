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
/// run's latest reminder. A row journaled before `count` existed reads its
/// count from the notice text; a count neither carries stays unnamed.
pub(crate) fn counter_line(notices: &[&InboxNoticeRow], theme: &Theme) -> Line {
    let mut new = Some(0u64);
    let mut classes: Option<Vec<(String, u64)>> = Some(Vec::new());
    let mut waiting = None;
    for notice in notices {
        if notice.class == INBOX_NOTICE_CLASS_REMINDER {
            waiting = Some(notice.count.or_else(|| reminder_count(&notice.text)));
            continue;
        }
        let parsed = arrival_classes(&notice.text);
        let count = notice.count.or_else(|| {
            parsed
                .as_ref()
                .map(|all| all.iter().map(|(_, count)| count).sum())
        });
        new = new.zip(count).map(|(new, count)| new.saturating_add(count));
        classes = classes.zip(parsed).map(|(mut all, parsed)| {
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
    match new {
        Some(0) => {}
        Some(new) => {
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
        None => parts.push("new messages".to_string()),
    }
    match waiting {
        Some(Some(waiting)) => parts.push(format!("{waiting} waiting")),
        Some(None) => parts.push("messages waiting".to_string()),
        None => {}
    }
    let dim = theme.fg_style(ThemeColor::Dim);
    vec![
        Span::styled("\u{2709} ".to_string(), dim),
        Span::styled(format!("{INBOX_NOTICE_SENDER} \u{b7} "), dim),
        Span::styled(parts.join(" \u{b7} "), dim),
    ]
}

/// The waiting count a reminder announces:
/// `[inbox reminder] 3 messages still waiting. ...`.
fn reminder_count(text: &str) -> Option<u64> {
    text.strip_prefix("[inbox reminder] ")?
        .split_once(' ')?
        .0
        .parse()
        .ok()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::ColorMode;
    use pa_types::inbox_notice::INBOX_NOTICE_CLASS_ARRIVAL;

    fn row(class: &str, text: &str) -> InboxNoticeRow {
        InboxNoticeRow {
            class: class.to_string(),
            count: None,
            text: text.to_string(),
        }
    }

    fn line_text(line: &Line) -> String {
        line.iter().map(|span| span.content.as_str()).collect()
    }

    #[test]
    fn rows_without_a_count_read_it_from_the_text_or_leave_it_unnamed() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let arrival = row(
            INBOX_NOTICE_CLASS_ARRIVAL,
            "[inbox 19:14 UTC] 3 new bash-done messages; total waiting: 3. Read them with msgs = await rlm.inbox.read().",
        );
        let reminder = row(
            INBOX_NOTICE_CLASS_REMINDER,
            "[inbox reminder] 4 messages still waiting. Read them with msgs = await rlm.inbox.read().",
        );
        assert_eq!(
            line_text(&counter_line(&[&arrival, &reminder], &theme)),
            "\u{2709} Agent inbox \u{b7} 3 new (3 bash-done) \u{b7} 4 waiting"
        );
        let unknown = [
            row(INBOX_NOTICE_CLASS_ARRIVAL, "an inbox notice"),
            row(INBOX_NOTICE_CLASS_REMINDER, "an inbox reminder"),
        ];
        assert_eq!(
            line_text(&counter_line(&[&unknown[0], &unknown[1]], &theme)),
            "\u{2709} Agent inbox \u{b7} new messages \u{b7} messages waiting"
        );
    }
}
