//! Ephemeral action toasts: the top-right auto-dismiss overlay for
//! short-lived action confirmations (clipboard copies and their kin).
//!
//! SANCTIONED DIVERGENCE from TS (documented per the #289 precedent): the
//! TS product has no in-TUI toast surface — confirmations render as
//! durable chat status rows (`showStatus`), and its "toast" surfaces are
//! OS-level notifications (the Windows Terminal / termux notifier
//! extensions). The Rust product keeps the chat row for anything the
//! transcript should remember and surfaces action acks the user only
//! needs for a moment as an overlay instead: the confirmation never
//! pollutes the transcript and the transcript never scrolls to show it.

use std::time::{Duration, Instant};

use crate::{Line, Span};
use ratatui::style::Style;

/// How long a toast stays on screen before it auto-dismisses.
pub const TOAST_TTL: Duration = Duration::from_secs(3);

/// How many distinct toasts stack at once (the oldest drop first).
pub const TOAST_STACK_LIMIT: usize = 3;

/// One ephemeral confirmation: its text, how many times its action
/// repeated inside the live window, and its expiry.
#[derive(Debug, Clone)]
struct Toast {
    text: String,
    repeats: usize,
    expires_at: Instant,
}

impl Toast {
    fn new(text: String) -> Self {
        let now = Instant::now();
        Toast {
            text,
            repeats: 1,
            expires_at: expiry(now),
        }
    }

    /// The overlay label: the second and later repeats of the same action
    /// inside the window read as the count bump ("Copied … (x3)"), so a
    /// coalesced repeat still visibly acknowledges every copy.
    fn label(&self) -> String {
        if self.repeats > 1 {
            format!(
                "{text} (x{repeats})",
                text = self.text,
                repeats = self.repeats
            )
        } else {
            self.text.clone()
        }
    }
}

/// The expiry `TOAST_TTL` out from `now` (an overflow near the monotonic
/// clock's end lands at `now`, which reads as expired).
fn expiry(now: Instant) -> Instant {
    now.checked_add(TOAST_TTL).unwrap_or(now)
}

/// The active toast stack (oldest first, newest last).
#[derive(Debug, Default)]
pub struct Toasts {
    entries: Vec<Toast>,
}

impl Toasts {
    /// Show a toast. A repeat of an action whose toast is still on screen
    /// COALESCES into that toast: its TTL resets and its repeat count
    /// climbs, so three consecutive copies read as one "Copied … (x3)"
    /// toast — never three identical rows stacked. The coalesced toast
    /// moves to the bottom of the stack (it is the newest action). A
    /// distinct action keeps its own toast; the stack caps at the limit
    /// with the oldest dropping first.
    pub fn push(&mut self, text: impl Into<String>) {
        let text = text.into();
        // Only a still-visible toast coalesces: one whose TTL already
        // passed starts fresh (the earlier confirmation is gone).
        let now = Instant::now();
        if let Some(index) = self
            .entries
            .iter()
            .rposition(|toast| toast.text == text && toast.expires_at > now)
        {
            let mut toast = self.entries.remove(index);
            toast.expires_at = expiry(Instant::now());
            toast.repeats += 1;
            self.entries.push(toast);
        } else {
            self.entries.push(Toast::new(text));
        }
        while self.entries.len() > TOAST_STACK_LIMIT {
            self.entries.remove(0);
        }
    }

    /// Drop the toasts whose TTL passed at `now`; `true` when any went.
    pub fn prune_expired(&mut self, now: Instant) -> bool {
        let before = self.entries.len();
        self.entries.retain(|toast| toast.expires_at > now);
        before != self.entries.len()
    }

    /// The still-active toasts' labels, oldest first.
    pub fn active(&self, now: Instant) -> Vec<String> {
        self.entries
            .iter()
            .filter(|toast| toast.expires_at > now)
            .map(Toast::label)
            .collect()
    }

    /// Fast-forward every toast's expiry by `age` (test hook: expiry
    /// without a wall-clock wait; an expiry already too close to the
    /// monotonic clock's start lands at `now`, which reads as expired).
    #[cfg(test)]
    pub(crate) fn age_by(&mut self, age: Duration) {
        let now = Instant::now();
        for toast in &mut self.entries {
            toast.expires_at = toast.expires_at.checked_sub(age).unwrap_or(now);
        }
    }
}

/// Composite the toasts over the frame's top transcript rows: each toast
/// is a compact right-aligned pill over the row's right edge — the
/// follow-hint composite's grammar, not a wholesale row replacement —
/// so the covered row keeps its own content outside the pill's columns
/// (and its leading OSC 133 zone markers: shell integration's
/// turn-boundary jumps keep working while the toast is visible). Rows at
/// or past `end` (the transcript window's last row + 1) stay untouched —
/// a short window never lets the overlay run into the dock.
pub fn overlay_toasts(
    frame: &mut [Line],
    start: usize,
    end: usize,
    toasts: &[String],
    width: usize,
    style: Style,
) {
    // A window shorter than the stack keeps the NEWEST toasts: the latest
    // acknowledgment is the one the user just triggered, so it never hides.
    let capacity = end.saturating_sub(start);
    let skip = toasts.len().saturating_sub(capacity);
    for (offset, text) in toasts.iter().skip(skip).enumerate() {
        if start + offset >= end {
            break;
        }
        let Some(row) = frame.get_mut(start + offset) else {
            break;
        };
        // The pill covers only its own columns at the row's right edge;
        // the covered row's content survives on both sides (its leading
        // zone markers intact). A pill wider than the frame truncates to
        // the frame edge — the overlay never wraps a row past the width.
        let pill = format!(" {text} ");
        let pill_width = crate::width::str_width(&pill).min(width);
        let col = width.saturating_sub(pill_width);
        let (markers, rest) = crate::osc133::split_leading_markers(row);
        let mut out: Line = markers;
        let prefix = slice_columns_keeping_escapes(&rest, 0, col);
        out.extend(prefix);
        // The pill never rides an open link region, whether the covered
        // content opened one or a wrapped link carried one in from the
        // row above (the writer's regions resume at the next row's
        // column 0): the close lands before the pill's cells, and an
        // unmatched close is a terminal no-op.
        out.push(Span::raw(crate::hyperlinks::OSC8_CLOSE.to_string()));
        // The pill sits at its right-edge column even when the covered
        // content runs short or a wide cluster clips at the boundary: the
        // composited prefix pads up to the column first.
        let prefix_width = crate::width::line_width(&out);
        if prefix_width < col {
            out.push(Span::raw(" ".repeat(col - prefix_width)));
        }
        out.push(Span::styled(pill, style));
        let suffix = slice_columns_keeping_escapes(&rest, col.saturating_add(pill_width), width);
        out.extend(suffix);
        if crate::width::line_width(&out) > width {
            out = crate::width::truncate_line(&out, width, "");
        }
        *row = out;
    }
}

/// Slice `line`'s visible columns `[start, start + length)`, keeping the
/// zero-width escapes whose column falls inside the range — the TS
/// `sliceByColumn` form drops them, which strips an OSC 8 hyperlink from
/// covered content for the toast's lifetime. Wide clusters clip at the
/// boundary like the strict TS form.
fn slice_columns_keeping_escapes(line: &Line, start: usize, length: usize) -> Line {
    use unicode_segmentation::UnicodeSegmentation;
    let mut out: Line = Vec::new();
    let mut col = 0usize;
    let end = start.saturating_add(length);
    'outer: for span in line {
        let mut rest = span.content.as_str();
        while !rest.is_empty() {
            if let Some(len) = crate::width::escape_len(rest) {
                if col >= start && col < end {
                    let escape = &rest[..len];
                    push_slice_text(&mut out, span.style, escape);
                }
                rest = &rest[len..];
                continue;
            }
            let cluster = rest.graphemes(true).next().expect("non-empty rest");
            let cluster_width = crate::width::grapheme_width(cluster);
            let in_range = col >= start && col < end;
            let fits = col.saturating_add(cluster_width) <= end;
            if in_range && fits {
                push_slice_text(&mut out, span.style, cluster);
            }
            col += cluster_width;
            rest = &rest[cluster.len()..];
            if col >= end {
                break 'outer;
            }
        }
    }
    out
}

/// Append `text` to the slice, merging into the trailing span when the
/// style already matches (the width module's span-merge shape).
fn push_slice_text(out: &mut Line, style: ratatui::style::Style, text: &str) {
    if let Some(last) = out.last_mut() {
        if last.style == style {
            last.content.push_str(text);
            return;
        }
    }
    out.push(Span::styled(text.to_string(), style));
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
