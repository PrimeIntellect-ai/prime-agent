//! The agent-inbox wire vocabulary: the inbox message classes, and the
//! daemon-authored arrival and reminder notices that deliver as
//! `role: "custom"` rows with their own customType, notice-class word,
//! and sender identity. One definition shared by the session engine and
//! the TUI's decode (the TUI cannot import the session engine).

/// The `bash.completed` notice class label.
pub const INBOX_CLASS_BASH_DONE: &str = "bash-done";
/// The `factory.progress` notice class label.
pub const INBOX_CLASS_FACTORY_PROGRESS: &str = "factory-progress";
/// The agent-message class label: one delivered `agent_message.send`
/// row (parent/sibling/child traffic) routed into the inbox.
pub const INBOX_CLASS_AGENT_MESSAGE: &str = "agent-message";
/// The child-exit class label: one `rlm_child_terminal_notice` row (a
/// child that ended without a reply or was cancelled).
pub const INBOX_CLASS_CHILD_EXITED: &str = "child-exited";
/// The child-failure class label: one `rlm_child_failure` row.
pub const INBOX_CLASS_CHILD_FAILED: &str = "child-failed";
/// The heartbeat class label: one fired scheduled heartbeat's prompt.
pub const INBOX_CLASS_HEARTBEAT: &str = "heartbeat";

/// The `customType` of the inbox notice rows (`arrival` and `reminder`).
pub const INBOX_NOTICE_CUSTOM_TYPE: &str = "inbox_notice";
/// The arrival notice's class word (a fresh batch landed).
pub const INBOX_NOTICE_CLASS_ARRIVAL: &str = "arrival";
/// The reminder notice's class word (the unread repeat).
pub const INBOX_NOTICE_CLASS_REMINDER: &str = "reminder";
/// The sender identity the notice rows carry: the inbox system, not a
/// human counterpart.
pub const INBOX_NOTICE_SENDER: &str = "Agent inbox";
