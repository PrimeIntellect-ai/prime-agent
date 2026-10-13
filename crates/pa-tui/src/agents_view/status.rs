//! The status line's presentation: the text with its tone and lifetime. One hint row
//! at the frame's bottom, cleared after [`STATUS_MESSAGE_DURATION_MS`](Self::DURATION)
//! — the run loop holds the expiry deadline instead of a timer.
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StatusTone {
    Muted,
    Warning,
    Error,
}

impl StatusTone {
    pub(super) fn color(self) -> crate::theme::ThemeColor {
        match self {
            StatusTone::Muted => crate::theme::ThemeColor::Muted,
            StatusTone::Warning => crate::theme::ThemeColor::Warning,
            StatusTone::Error => crate::theme::ThemeColor::Error,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct Status {
    text: String,
    tone: StatusTone,
    /// Stays up until the next keypress instead of expiring.
    sticky: bool,
    /// The expiry instant while transient; `None` while sticky.
    expires: Option<std::time::Instant>,
}

impl Status {
    const DURATION: Duration = Duration::from_millis(4500);

    /// The text with its whitespace collapsed (one line, never the message's own
    /// breaks).
    fn collapse(text: &str) -> String {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// The tone rule: the explicit tone wins, then the `Failed` prefix, else muted.
    fn default_tone(text: &str) -> StatusTone {
        if text.starts_with("Failed") {
            StatusTone::Error
        } else {
            StatusTone::Muted
        }
    }

    #[must_use]
    pub(super) fn transient(text: &str) -> Self {
        let text = Self::collapse(text);
        let tone = Self::default_tone(&text);
        Self::with(text, tone, false)
    }

    #[must_use]
    pub(super) fn with_tone(text: &str, tone: StatusTone) -> Self {
        Self::with(Self::collapse(text), tone, false)
    }

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

    pub(super) fn text(&self) -> &str {
        &self.text
    }

    pub(super) fn tone(&self) -> StatusTone {
        self.tone
    }

    pub(super) fn is_sticky(&self) -> bool {
        self.sticky
    }

    /// The expiry instant while the window is still open at `now`.
    pub(super) fn expiry(&self, now: std::time::Instant) -> Option<std::time::Instant> {
        self.expires.filter(|at| now < *at)
    }
}

impl super::AgentsViewMode {
    pub(super) fn set_status(&mut self, text: &str) {
        self.status = Some(Status::transient(text));
    }

    pub(super) fn set_status_tone(&mut self, text: &str, tone: StatusTone) {
        self.status = Some(Status::with_tone(text, tone));
    }

    pub(super) fn status_text(&self) -> Option<&str> {
        self.status.as_ref().map(Status::text)
    }

    /// The armed expiry the loop wakes at (a sticky line arms none).
    pub(super) fn status_expiry(&self, now: std::time::Instant) -> Option<std::time::Instant> {
        self.status.as_ref().and_then(|status| status.expiry(now))
    }

    /// Clear the status once its window passed at `now` (a replaced line carries
    /// its own new deadline); report whether the frame must repaint.
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

    /// A sticky line clears on any keypress (the transient timer never covered it).
    pub(super) fn clear_sticky_status(&mut self) {
        if self.status.as_ref().is_some_and(Status::is_sticky) {
            self.status = None;
        }
    }
}
