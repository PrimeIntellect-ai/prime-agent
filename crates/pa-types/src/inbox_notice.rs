//! The agent-inbox notice rows' wire vocabulary: the daemon-authored
//! arrival and reminder notices deliver as `role: "custom"` rows with
//! their own customType, notice-class word, and sender identity. One
//! definition shared by the session engine's row builder and the TUI's
//! decode (the TUI cannot import the session engine).

/// The `customType` of the inbox notice rows (`arrival` and `reminder`).
pub const INBOX_NOTICE_CUSTOM_TYPE: &str = "inbox_notice";
/// The arrival notice's class word (a fresh batch landed).
pub const INBOX_NOTICE_CLASS_ARRIVAL: &str = "arrival";
/// The reminder notice's class word (the unread repeat).
pub const INBOX_NOTICE_CLASS_REMINDER: &str = "reminder";
/// The sender identity the notice rows carry: the inbox system, not a
/// human counterpart.
pub const INBOX_NOTICE_SENDER: &str = "Agent inbox";
