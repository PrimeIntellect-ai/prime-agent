//! The status line's presentation (TS `setStatusMessage`,
//! agents-view-mode.ts:1436-1473): the text with its tone and lifetime.
//! The line renders one hint row at the bottom of the frame, in the
//! tone's color, and clears itself after
//! [`STATUS_MESSAGE_DURATION_MS`](Self::DURATION) — TS arms a timer; the
//! view's run loop holds the expiry deadline instead (no thread, no
//! sleep, the chat's ctrl-c-hint deadline pattern).
use std::time::Duration;

/// The line's color (TS `statusMessageTone`, rendered through
/// `theme.fg(tone, ...)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StatusTone {
    Muted,
    Warning,
    Error,
}

impl StatusTone {
    /// The theme color the tone renders in (the one-line status row).
    pub(super) fn color(self) -> crate::theme::ThemeColor {
        match self {
            StatusTone::Muted => crate::theme::ThemeColor::Muted,
            StatusTone::Warning => crate::theme::ThemeColor::Warning,
            StatusTone::Error => crate::theme::ThemeColor::Error,
        }
    }
}

/// One status line: the collapsed text, its tone, and its lifetime.
#[derive(Debug, Clone)]
pub(super) struct Status {
    text: String,
    tone: StatusTone,
    /// Sticky lines stay up until the next keypress instead of expiring
    /// (TS `statusMessageSticky`).
    sticky: bool,
    /// The expiry instant while the line is transient (TS's
    /// `STATUS_MESSAGE_DURATION_MS` timer); `None` while sticky.
    expires: Option<std::time::Instant>,
}

impl Status {
    /// TS `STATUS_MESSAGE_DURATION_MS`.
    const DURATION: Duration = Duration::from_millis(4500);

    /// The text with its whitespace collapsed (TS
    /// `formatAgentsViewStatusLine`: one line, never the message's own
    /// line breaks).
    fn collapse(text: &str) -> String {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// TS's tone rule (explicit tone wins, then the `Failed` prefix,
    /// else muted — `setStatusMessage`'s `options.tone ??`).
    fn default_tone(text: &str) -> StatusTone {
        if text.starts_with("Failed") {
            StatusTone::Error
        } else {
            StatusTone::Muted
        }
    }

    /// TS `setStatusMessage(message)`: the default tone, the expiry armed.
    #[must_use]
    pub(super) fn transient(text: &str) -> Self {
        let text = Self::collapse(text);
        let tone = Self::default_tone(&text);
        Self::with(text, tone, false)
    }

    /// TS `setStatusMessage(message, { tone })`: the explicit tone and
    /// the expiry armed.
    #[must_use]
    pub(super) fn with_tone(text: &str, tone: StatusTone) -> Self {
        Self::with(Self::collapse(text), tone, false)
    }

    /// TS `setStatusMessage(message, { sticky: true })`: the default tone
    /// rule, no expiry — the line stays until the next keypress.
    #[must_use]
    pub(super) fn sticky(text: &str) -> Self {
        let text = Self::collapse(text);
        let tone = Self::default_tone(&text);
        Self::with(text, tone, true)
    }

    fn with(text: String, tone: StatusTone, sticky: bool) -> Self {
        Self {
            expires: (!sticky).then(|| std::time::Instant::now() + Self::DURATION),
            text,
            tone,
            sticky,
        }
    }

    /// The line's collapsed text.
    pub(super) fn text(&self) -> &str {
        &self.text
    }

    /// The line's tone.
    pub(super) fn tone(&self) -> StatusTone {
        self.tone
    }

    /// Whether the line waits for the next keypress instead of the timer.
    pub(super) fn is_sticky(&self) -> bool {
        self.sticky
    }

    /// The expiry instant while the window is still open at `now` (the
    /// loop's wake arm reads this the same way the chat arms its ctrl-c
    /// hint deadline).
    pub(super) fn expiry(&self, now: std::time::Instant) -> Option<std::time::Instant> {
        self.expires.filter(|at| now < *at)
    }
}

impl super::AgentsViewMode {
    /// TS `setStatusMessage(message)`: the default tone rule, the
    /// expiry armed.
    pub(super) fn set_status(&mut self, text: &str) {
        self.status = Some(Status::transient(text));
    }

    /// TS `setStatusMessage(message, { tone })`: the explicit tone, the
    /// expiry armed.
    pub(super) fn set_status_tone(&mut self, text: &str, tone: StatusTone) {
        self.status = Some(Status::with_tone(text, tone));
    }

    /// The status line's text (the renderers' and tests' view of it).
    pub(super) fn status_text(&self) -> Option<&str> {
        self.status.as_ref().map(Status::text)
    }

    /// The armed expiry the loop wakes at (a sticky line arms none):
    /// TS's timer cleared the line; here the deadline branch repaints it
    /// away.
    pub(super) fn status_expiry(&self, now: std::time::Instant) -> Option<std::time::Instant> {
        self.status.as_ref().and_then(|status| status.expiry(now))
    }

    /// The timer's callback (TS clears the line only when nothing
    /// replaced it — a replaced line carries its own new deadline):
    /// clear the status once its window passed at `now`, and report
    /// whether the frame must repaint.
    pub(super) fn expire_status(&mut self, now: std::time::Instant) -> bool {
        let expired = self
            .status
            .as_ref()
            .is_some_and(|status| status.expiry(now).is_none() && !status.is_sticky());
        if expired {
            self.status = None;
        }
        expired
    }

    /// TS `clearStickyStatusMessage`: a sticky line clears on any
    /// keypress (the transient timer never covered it).
    pub(super) fn clear_sticky_status(&mut self) {
        if self.status.as_ref().is_some_and(Status::is_sticky) {
            self.status = None;
        }
    }
}
