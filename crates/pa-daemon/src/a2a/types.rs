//! The A2A 1.0 wire types the server reads and writes (the `ProtoJSON` form
//! of the specification's protobuf messages): `camelCase` fields,
//! `SCREAMING_SNAKE` enum values, and every `oneof` as a single member
//! named by its field. Requests only deserialize and replies only
//! serialize.
//!
//! Source: <https://a2a-protocol.org/latest/specification/> (sections 3-9).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Task lifecycle states (spec 4.1.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskState {
    #[serde(rename = "TASK_STATE_SUBMITTED")]
    Submitted,
    #[serde(rename = "TASK_STATE_WORKING")]
    Working,
    #[serde(rename = "TASK_STATE_COMPLETED")]
    Completed,
    #[serde(rename = "TASK_STATE_FAILED")]
    Failed,
    #[serde(rename = "TASK_STATE_CANCELED")]
    Canceled,
    #[serde(rename = "TASK_STATE_INPUT_REQUIRED")]
    InputRequired,
    #[serde(rename = "TASK_STATE_REJECTED")]
    Rejected,
    #[serde(rename = "TASK_STATE_AUTH_REQUIRED")]
    AuthRequired,
}

impl TaskState {
    /// The terminal states (spec 4.1.3): a task accepts no more work and
    /// its streams close.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Canceled | Self::Rejected
        )
    }
}

/// The sender of a message (spec 4.1.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    #[serde(rename = "ROLE_USER")]
    User,
    #[serde(rename = "ROLE_AGENT")]
    Agent,
}

/// One message part (spec 4.1.6): exactly one of `text`, `raw`, `url`,
/// `data`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
}

impl Part {
    #[must_use]
    pub fn text(text: impl Into<String>) -> Self {
        Part {
            text: Some(text.into()),
            raw: None,
            url: None,
            data: None,
            filename: None,
            media_type: None,
            metadata: None,
        }
    }

    fn content_members(&self) -> usize {
        usize::from(self.text.is_some())
            + usize::from(self.raw.is_some())
            + usize::from(self.url.is_some())
            + usize::from(self.data.is_some())
    }
}

/// Why a message's parts cannot become a prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PartsError {
    /// No parts, an invalid part, or no text at all (-32602).
    Invalid(&'static str),
    /// A valid non-text part (-32005: the card declares text input only).
    NotText,
}

/// The prompt text of a message: its text parts joined by newlines.
pub fn prompt_text(parts: &[Part]) -> Result<String, PartsError> {
    if parts.is_empty() {
        return Err(PartsError::Invalid("message.parts must not be empty"));
    }
    if parts.iter().any(|part| part.content_members() != 1) {
        return Err(PartsError::Invalid(
            "each part must contain exactly one of text, raw, url, data",
        ));
    }
    let texts: Option<Vec<&str>> = parts.iter().map(|part| part.text.as_deref()).collect();
    let text = texts.ok_or(PartsError::NotText)?.join("\n");
    if text.trim().is_empty() {
        return Err(PartsError::Invalid("the message carries no text"));
    }
    Ok(text)
}

/// One message (spec 4.1.4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub role: Role,
    pub parts: Vec<Part>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
}

/// A task's status (spec 4.1.2).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub state: TaskState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<Message>,
    pub timestamp: String,
}

/// A task output (spec 4.1.7).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub artifact_id: String,
    pub name: String,
    pub parts: Vec<Part>,
}

/// A task (spec 4.1.1).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub context_id: String,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<Artifact>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<Message>,
}

/// A status change event (spec 4.2.1).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusUpdateEvent {
    pub task_id: String,
    pub context_id: String,
    pub status: TaskStatus,
}

/// An artifact chunk event (spec 4.2.2).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifactUpdateEvent {
    pub task_id: String,
    pub context_id: String,
    pub artifact: Artifact,
    pub append: bool,
    pub last_chunk: bool,
}

/// The streaming wrapper's update members (spec 3.2.3): one member per
/// frame. The opening `task` frame is written from the snapshot.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamResponse {
    StatusUpdate(TaskStatusUpdateEvent),
    ArtifactUpdate(TaskArtifactUpdateEvent),
}

/// The `SendMessage` params (spec 3.2.1).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    pub message: Message,
    #[serde(default)]
    pub configuration: Option<SendMessageConfiguration>,
}

/// The send configuration (spec 3.2.2).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageConfiguration {
    #[serde(default)]
    pub task_push_notification_config: Option<Value>,
    #[serde(default)]
    pub history_length: Option<u32>,
    #[serde(default)]
    pub return_immediately: bool,
}

/// The `GetTask` and `SubscribeToTask` params (spec 3.1.3, 3.1.6).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQuery {
    pub id: String,
    #[serde(default)]
    pub history_length: Option<u32>,
}

/// The `ListTasks` params (spec 3.1.4).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksParams {
    #[serde(default)]
    pub context_id: Option<String>,
    #[serde(default)]
    pub status: Option<TaskState>,
    #[serde(default)]
    pub page_size: Option<u32>,
    #[serde(default)]
    pub page_token: Option<String>,
    #[serde(default)]
    pub history_length: Option<u32>,
    #[serde(default)]
    pub status_timestamp_after: Option<String>,
    #[serde(default)]
    pub include_artifacts: bool,
}

/// The `ListTasks` result (spec 3.1.4).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksResponse {
    pub tasks: Vec<Task>,
    pub next_page_token: String,
    pub page_size: u32,
    pub total_size: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prompt_text_joins_text_parts_and_classifies_the_rest() {
        let text = |value: Value| serde_json::from_value::<Part>(value).unwrap();
        assert_eq!(
            prompt_text(&[
                text(json!({"text": "Translate:"})),
                text(json!({"text": "Hi"}))
            ]),
            Ok("Translate:\nHi".to_string())
        );
        assert_eq!(
            prompt_text(&[text(json!({"raw": "aGk=", "mediaType": "image/png"}))]),
            Err(PartsError::NotText)
        );
        assert!(matches!(prompt_text(&[]), Err(PartsError::Invalid(_))));
        assert!(matches!(
            prompt_text(&[text(json!({"text": "a", "url": "https://x"}))]),
            Err(PartsError::Invalid(_))
        ));
        assert!(matches!(
            prompt_text(&[text(json!({"text": "  "}))]),
            Err(PartsError::Invalid(_))
        ));
    }

    #[test]
    fn stream_frames_use_oneof_member_names_and_enum_names() {
        let frame = StreamResponse::StatusUpdate(TaskStatusUpdateEvent {
            task_id: "t".into(),
            context_id: "c".into(),
            status: TaskStatus {
                state: TaskState::Working,
                message: None,
                timestamp: "2026-11-25T10:00:00.000Z".into(),
            },
        });
        assert_eq!(
            serde_json::to_value(&frame).unwrap(),
            json!({"statusUpdate": {"taskId": "t", "contextId": "c", "status": {
                "state": "TASK_STATE_WORKING", "timestamp": "2026-11-25T10:00:00.000Z"}}})
        );
        let request: SendMessageRequest = serde_json::from_value(json!({
            "message": {"messageId": "m", "role": "ROLE_USER", "parts": [{"text": "hi"}]},
            "configuration": {"returnImmediately": true}
        }))
        .unwrap();
        assert!(request.configuration.unwrap().return_immediately);
    }
}
