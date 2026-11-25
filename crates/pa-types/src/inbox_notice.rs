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
/// The cell-done class label: one auto-backgrounded cell's completion
/// (the `[cell-done ...]` row) routed into the inbox.
pub const INBOX_CLASS_CELL_DONE: &str = "cell-done";

/// The durable row a detached kernel bash completion admits as the woken
/// turn's injected prompt.
pub const ASYNC_BASH_COMPLETION_CUSTOM_TYPE: &str = "async_bash_completion";
/// The durable row a factory run milestone (`factory.progress`) admits on
/// the owning session's steering lane.
pub const FACTORY_PROGRESS_NOTICE_CUSTOM_TYPE: &str = "factory_progress_notice";
/// One delivered `agent_message.send` row.
pub const AGENT_MESSAGE_CUSTOM_TYPE: &str = "agent_message";
/// A child run that ended without an explicit reply or was cancelled.
pub const RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE: &str = "rlm_child_terminal_notice";
/// A child run that failed.
pub const RLM_CHILD_FAILURE_CUSTOM_TYPE: &str = "rlm_child_failure";
/// One fired scheduled heartbeat's prompt row.
pub const HEARTBEAT_PROMPT_CUSTOM_TYPE: &str = "heartbeat_prompt";
/// The durable row an auto-backgrounded cell's completion admits as the
/// woken turn's injected prompt (`[cell-done ...]`).
pub const ASYNC_BACKGROUND_CELL_COMPLETION_CUSTOM_TYPE: &str = "async_background_cell";

/// Each inbox class with the custom type of the row its messages are
/// routed from: the session engine classes rows by it, the TUI renders a
/// read message as the row it replaced.
pub const INBOX_CLASS_CUSTOM_TYPES: [(&str, &str); 7] = [
    (INBOX_CLASS_BASH_DONE, ASYNC_BASH_COMPLETION_CUSTOM_TYPE),
    (
        INBOX_CLASS_FACTORY_PROGRESS,
        FACTORY_PROGRESS_NOTICE_CUSTOM_TYPE,
    ),
    (INBOX_CLASS_AGENT_MESSAGE, AGENT_MESSAGE_CUSTOM_TYPE),
    (
        INBOX_CLASS_CHILD_EXITED,
        RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
    ),
    (INBOX_CLASS_CHILD_FAILED, RLM_CHILD_FAILURE_CUSTOM_TYPE),
    (INBOX_CLASS_HEARTBEAT, HEARTBEAT_PROMPT_CUSTOM_TYPE),
    (
        INBOX_CLASS_CELL_DONE,
        ASYNC_BACKGROUND_CELL_COMPLETION_CUSTOM_TYPE,
    ),
];

/// The inbox class a custom type's rows route to.
#[must_use]
pub fn inbox_class_for_custom_type(custom_type: &str) -> Option<&'static str> {
    INBOX_CLASS_CUSTOM_TYPES
        .iter()
        .find(|(_, row_type)| *row_type == custom_type)
        .map(|(class, _)| *class)
}

/// The custom type of the row an inbox class's messages are routed from.
#[must_use]
pub fn custom_type_for_inbox_class(class: &str) -> Option<&'static str> {
    INBOX_CLASS_CUSTOM_TYPES
        .iter()
        .find(|(inbox_class, _)| *inbox_class == class)
        .map(|(_, row_type)| *row_type)
}

/// The `customType` of the inbox notice rows (`arrival` and `reminder`).
pub const INBOX_NOTICE_CUSTOM_TYPE: &str = "inbox_notice";
/// The arrival notice's class word (a fresh batch landed).
pub const INBOX_NOTICE_CLASS_ARRIVAL: &str = "arrival";
/// The reminder notice's class word (the unread repeat).
pub const INBOX_NOTICE_CLASS_REMINDER: &str = "reminder";
/// The sender identity the notice rows carry: the inbox system, not a
/// human counterpart.
pub const INBOX_NOTICE_SENDER: &str = "Agent inbox";
