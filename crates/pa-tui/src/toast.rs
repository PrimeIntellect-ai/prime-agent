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
pub const TOAST_TTL: Duration = Duration::from_millis(3000);

/// How many toasts stack at once (the oldest drop first).
pub const TOAST_STACK_LIMIT: usize = 3;

/// The toast's semantic color (the theme's color per kind).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToastKind {
    /// A completed action (Success).
    Success,
    /// Neutral information (Accent).
    Info,
    /// A warning (Warning).
    Warning,
    /// An error (Error).
    Error,
}

/// One ephemeral confirmation: its text, kind, and expiry.
#[derive(Debug, Clone)]
struct Toast {
    text: String,
    kind: ToastKind,
    expires_at: Instant,
}

impl Toast {
    fn new(text: String, kind: ToastKind) -> Self {
        Toast {
            text,
            kind,
            expires_at: Instant::now()
                .checked_add(TOAST_TTL)
                .unwrap_or_else(Instant::now),
        }
    }
}

/// The active toast stack (oldest first, newest last).
#[derive(Debug, Default)]
pub struct Toasts {
    entries: Vec<Toast>,
}

impl Toasts {
    /// Show a toast: the newest lands at the bottom of the stack; a stack
    /// past the limit drops the oldest.
    pub fn push(&mut self, text: impl Into<String>, kind: ToastKind) {
        self.entries.push(Toast::new(text.into(), kind));
        while self.entries.len() > TOAST_STACK_LIMIT {
            self.entries.remove(0);
        }
    }

    /// Whether any toast is still on screen at `now`.
    pub fn has_active(&self, now: Instant) -> bool {
        self.entries.iter().any(|toast| toast.expires_at > now)
    }

    /// Drop the toasts whose TTL passed at `now`; `true` when any went.
    pub fn prune_expired(&mut self, now: Instant) -> bool {
        let before = self.entries.len();
        self.entries.retain(|toast| toast.expires_at > now);
        before != self.entries.len()
    }

    /// The still-active toasts, oldest first.
    pub fn active<'a>(&'a self, now: Instant) -> impl Iterator<Item = (&'a str, ToastKind)> + 'a {
        self.entries
            .iter()
            .filter(move |toast| toast.expires_at > now)
            .map(|toast| (toast.text.as_str(), toast.kind))
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

/// Compose the toast block over the frame's top transcript rows: each
/// toast replaces one row with its right-aligned message, so the overlay
/// stays legible over whatever the transcript shows beneath it. Each
/// entry carries its own style (the kind's theme color).
pub fn overlay_toasts(frame: &mut [Line], start: usize, toasts: &[(String, Style)], width: usize) {
    for (offset, (text, style)) in toasts.iter().enumerate() {
        let Some(row) = frame.get_mut(start + offset) else {
            break;
        };
        let label = format!(" {text} ");
        let col = width.saturating_sub(crate::width::str_width(&label));
        let mut out: Line = vec![Span::raw(" ".repeat(col)), Span::styled(label, *style)];
        out = crate::width::truncate_line(&out, width, "");
        let tail = width.saturating_sub(crate::width::line_width(&out));
        if tail > 0 {
            out.push(Span::raw(" ".repeat(tail)));
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
        toasts.push("Copied", ToastKind::Success);
        assert!(toasts.has_active(now()));
        assert_eq!(toasts.active(now()).count(), 1);
        toasts.age_by(TOAST_TTL + Duration::from_millis(1));
        assert!(!toasts.has_active(now()));
        assert_eq!(toasts.active(now()).count(), 0);
        assert!(toasts.prune_expired(now()));
        assert!(toasts.entries.is_empty());
    }

    /// Pruning with nothing to drop reports no change.
    #[test]
    fn pruning_a_fresh_stack_reports_no_change() {
        let mut toasts = Toasts::default();
        toasts.push("Again", ToastKind::Info);
        assert!(!toasts.prune_expired(now()));
        assert_eq!(toasts.entries.len(), 1);
    }

    /// The stack keeps the newest toasts and caps at the limit.
    #[test]
    fn the_stack_caps_at_the_limit() {
        let mut toasts = Toasts::default();
        for index in 0..=TOAST_STACK_LIMIT {
            toasts.push(format!("toast {index}"), ToastKind::Info);
        }
        let texts: Vec<&str> = toasts.active(now()).map(|(text, _)| text).collect();
        assert_eq!(texts, vec!["toast 1", "toast 2", "toast 3"]);
    }

    /// The overlay writes right-aligned rows over the frame's top rows
    /// and leaves the rows below untouched.
    #[test]
    fn the_overlay_writes_the_top_rows_right_aligned() {
        let mut frame = vec![vec![Span::raw("row")]; 6];
        let toasts = vec![("Copied the answer".to_string(), Style::default())];
        overlay_toasts(&mut frame, 2, &toasts, 20);
        let rendered: Vec<String> = frame
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.to_string())
                    .collect::<String>()
            })
            .collect();
        assert_eq!(rendered[2], "  Copied the answer ".to_string());
        assert_eq!(rendered[1], "row");
        assert_eq!(rendered[3], "row");
    }

    /// A label wider than the frame truncates instead of wrapping past
    /// the frame edge.
    #[test]
    fn an_overlong_label_truncates_to_the_frame_width() {
        let mut frame = vec![vec![Span::raw("row")]];
        let toasts = vec![(
            "a very long toast label that cannot fit".to_string(),
            Style::default(),
        )];
        overlay_toasts(&mut frame, 0, &toasts, 10);
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
        let mut frame = vec![vec![Span::raw("row")]; 2];
        let toasts = vec![
            ("one".to_string(), Style::default()),
            ("two".to_string(), Style::default()),
        ];
        overlay_toasts(&mut frame, 1, &toasts, 10);
        assert!(frame[1].iter().any(|span| span.content.contains("two")));
    }
}
