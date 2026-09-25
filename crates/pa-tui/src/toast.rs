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
    fn fresh(text: String) -> Self {
        let now = Instant::now();
        Toast {
            text,
            repeats: 1,
            expires_at: expiry(now),
        }
    }

    /// A repeat of the toast's action: the window resets and the repeat
    /// count climbs (the count bump the label renders).
    fn refresh(&mut self) {
        self.expires_at = expiry(Instant::now());
        self.repeats += 1;
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

    /// Fast-forward the expiry by `age` (test hook: expiry without a
    /// wall-clock wait; an expiry already too close to the monotonic
    /// clock's start lands at `now`, which reads as expired).
    #[cfg(test)]
    fn age_by(&mut self, age: Duration) {
        let now = Instant::now();
        self.expires_at = self.expires_at.checked_sub(age).unwrap_or(now);
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
            toast.refresh();
            self.entries.push(toast);
        } else {
            self.entries.push(Toast::fresh(text));
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
        for toast in &mut self.entries {
            toast.age_by(age);
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
        out.extend(crate::width::slice_line_by_column_strict(
            &rest, 0, col, true,
        ));
        out.push(Span::styled(pill, style));
        out.extend(crate::width::slice_line_by_column_strict(
            &rest,
            col.saturating_add(pill_width),
            width,
            true,
        ));
        if crate::width::line_width(&out) > width {
            out = crate::width::truncate_line(&out, width, "");
        }
        *row = out;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> Instant {
        Instant::now()
    }

    /// A toast starts active, expires after its TTL, and pruning drops it.
    #[test]
    fn toasts_expire_on_their_ttl() {
        let mut toasts = Toasts::default();
        toasts.push("Copied");
        assert_eq!(toasts.active(now()).len(), 1);
        toasts.age_by(TOAST_TTL + Duration::from_millis(1));
        assert!(toasts.active(now()).is_empty());
        assert!(toasts.prune_expired(now()));
        assert!(toasts.entries.is_empty());
    }

    /// Pruning with nothing to drop reports no change.
    #[test]
    fn pruning_a_fresh_stack_reports_no_change() {
        let mut toasts = Toasts::default();
        toasts.push("Again");
        assert!(!toasts.prune_expired(now()));
        assert_eq!(toasts.entries.len(), 1);
    }

    /// The stack keeps the newest toasts and caps at the limit.
    #[test]
    fn the_stack_caps_at_the_limit() {
        let mut toasts = Toasts::default();
        for index in 0..=TOAST_STACK_LIMIT {
            toasts.push(format!("toast {index}"));
        }
        let texts: Vec<String> = toasts.active(now());
        assert_eq!(texts, vec!["toast 1", "toast 2", "toast 3"]);
    }

    /// Consecutive repeats of the same action COALESCE: the toast stack
    /// holds one entry, its TTL resets (the repeat keeps it alive), and
    /// its label carries the count bump.
    #[test]
    fn consecutive_repeats_coalesce_into_one_toast() {
        let mut toasts = Toasts::default();
        toasts.push("Copied to clipboard");
        toasts.push("Copied to clipboard");
        toasts.push("Copied to clipboard");
        let labels = toasts.active(now());
        assert_eq!(labels.len(), 1, "three copies are one toast, not rows");
        assert_eq!(labels[0], "Copied to clipboard (x3)");
        assert_eq!(toasts.entries.len(), 1);
        // The TTL reset: half the TTL twice stays inside a refreshed
        // window (an unrefreshed toast expires before the second half).
        toasts.age_by(TOAST_TTL / 2);
        toasts.push("Copied to clipboard");
        toasts.age_by(TOAST_TTL / 2);
        assert_eq!(
            toasts.active(now()).as_slice(),
            ["Copied to clipboard (x4)"],
            "the refresh keeps the coalesced toast alive"
        );
    }

    /// A repeat AFTER the previous toast's TTL starts a fresh window: no
    /// count bump for a confirmation the user has already seen expire.
    #[test]
    fn a_repeat_after_the_ttl_starts_a_fresh_toast() {
        let mut toasts = Toasts::default();
        toasts.push("Copied to clipboard");
        toasts.age_by(TOAST_TTL + Duration::from_millis(1));
        toasts.push("Copied to clipboard");
        assert_eq!(
            toasts.active(now()).as_slice(),
            ["Copied to clipboard"],
            "the fresh toast carries no count bump"
        );
    }

    /// Distinct actions keep their own toasts; a repeat of one of them
    /// coalesces into THAT toast (it is the toast the user last triggered)
    /// and moves it to the bottom of the stack.
    #[test]
    fn distinct_actions_stack_and_a_repeat_coalesces_into_its_own_toast() {
        let mut toasts = Toasts::default();
        toasts.push("Copied last agent message to clipboard");
        toasts.push("Copied selection to clipboard");
        let labels = toasts.active(now());
        assert_eq!(
            labels.as_slice(),
            [
                "Copied last agent message to clipboard",
                "Copied selection to clipboard",
            ],
            "distinct actions are separate toasts"
        );
        toasts.push("Copied last agent message to clipboard");
        assert_eq!(
            toasts.active(now()).as_slice(),
            [
                "Copied selection to clipboard",
                "Copied last agent message to clipboard (x2)",
            ],
            "the repeat refreshes its own toast, newest at the bottom"
        );
    }

    /// The overlay composites a compact right-aligned pill over the row:
    /// the covered row's own content survives outside the pill's columns
    /// — the toast never spans the whole row.
    #[test]
    fn the_pill_keeps_the_covered_rows_content() {
        let mut frame = vec![line_of("row content that stays visible underneath")];
        overlay_toasts(
            &mut frame,
            0,
            1,
            &["Copied to clipboard".to_string()],
            60,
            Style::default(),
        );
        let rendered: String = frame[0]
            .iter()
            .map(|span| span.content.to_string())
            .collect();
        assert!(
            rendered.starts_with("row content"),
            "the row keeps its leading content: {rendered:?}"
        );
        assert!(
            rendered.contains(" Copied to clipboard "),
            "the pill lands on the row: {rendered:?}"
        );
        assert_eq!(
            crate::width::str_width(&rendered),
            60,
            "the composited row keeps the frame width"
        );
    }

    /// Right-aligned: the pill sits at the row's right edge and the rows
    /// outside the stack stay untouched.
    #[test]
    fn the_pill_lands_right_aligned_and_leaves_other_rows_alone() {
        let width = 20;
        let pill = " Copied the answer ".to_string();
        let mut frame = vec![line_of(&"x".repeat(width)); 6];
        overlay_toasts(
            &mut frame,
            2,
            6,
            &["Copied the answer".to_string()],
            width,
            Style::default(),
        );
        let rendered: Vec<String> = frame
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.to_string())
                    .collect::<String>()
            })
            .collect();
        let col = width - crate::width::str_width(&pill);
        assert_eq!(
            rendered[2],
            format!("{}{}", "x".repeat(col), pill),
            "the pill lands at the row's right edge"
        );
        assert_eq!(rendered[1], "x".repeat(width));
        assert_eq!(rendered[3], "x".repeat(width));
    }

    /// A label wider than the frame truncates instead of wrapping past
    /// the frame edge.
    #[test]
    fn an_overlong_pill_truncates_to_the_frame_width() {
        let mut frame = vec![line_of("row")];
        overlay_toasts(
            &mut frame,
            0,
            1,
            &["a very long toast label that cannot fit".to_string()],
            10,
            Style::default(),
        );
        let rendered: String = frame[0]
            .iter()
            .map(|span| span.content.to_string())
            .collect();
        assert!(
            crate::width::str_width(&rendered) <= 10,
            "row: {rendered:?}"
        );
    }

    /// A stack taller than the frame's rows overlays only what fits.
    #[test]
    fn a_tall_stack_overlays_only_what_fits() {
        let mut frame = vec![line_of("row"); 2];
        let toasts = vec!["one".to_string(), "two".to_string()];
        overlay_toasts(&mut frame, 1, 2, &toasts, 10, Style::default());
        assert!(frame[1].iter().any(|span| span.content.contains("two")));
    }

    /// A covered row keeps its leading OSC 133 zone markers: shell
    /// integration's turn-boundary jumps keep working while the toast is
    /// visible over the row (the follow-hint composite's rule).
    #[test]
    fn a_covered_row_keeps_its_zone_markers() {
        let mut frame = vec![line_of("row"); 2];
        crate::osc133::mark_start(&mut frame[1]);
        overlay_toasts(
            &mut frame,
            1,
            2,
            &["Copied".to_string()],
            20,
            Style::default(),
        );
        let row_text: String = frame[1].iter().map(|span| span.content.as_str()).collect();
        assert!(
            row_text.contains(crate::osc133::ZONE_START),
            "the zone marker survives the overlay: {row_text:?}"
        );
        assert!(row_text.contains("Copied"));
    }

    /// The end bound keeps the overlay inside the transcript window, and a
    /// window shorter than the stack keeps the NEWEST toasts: the third
    /// toast never lands on the dock's first row, and the latest
    /// acknowledgment is the one that stays visible.
    #[test]
    fn the_end_bound_keeps_the_newest_inside_the_window() {
        let mut frame = vec![line_of("row"); 4];
        let toasts = vec!["one".to_string(), "two".to_string(), "three".to_string()];
        // Transcript window: rows 1..3 (end 3); the window holds two
        // toasts, so the NEWEST two overlay and the dock row stays
        // untouched.
        overlay_toasts(&mut frame, 1, 3, &toasts, 10, Style::default());
        assert!(
            !frame[1].iter().any(|span| span.content.contains("one")),
            "the oldest toast drops: {:?}",
            frame[1]
        );
        assert!(frame[1].iter().any(|span| span.content.contains("two")));
        assert!(frame[2].iter().any(|span| span.content.contains("three")));
        assert!(
            !frame[3].iter().any(|span| span.content.contains("three")),
            "the dock row stays untouched: {:?}",
            frame[3]
        );
    }

    /// A styled span keeps the pill's style (the composite must not restyle
    /// the covered row's own spans).
    #[test]
    fn the_pill_carries_its_style() {
        use ratatui::style::Color;
        let mut frame = vec![line_of("row")];
        let style = Style::default().fg(Color::Green);
        overlay_toasts(&mut frame, 0, 1, &["Copied".to_string()], 10, style);
        let pill = frame[0]
            .iter()
            .find(|span| span.content.contains("Copied"))
            .expect("the pill renders");
        assert_eq!(pill.style, style);
    }

    fn line_of(text: &str) -> Line {
        vec![Span::raw(text.to_string())]
    }
}
