//! The A2A 1.0 wire types the server reads and writes (the `ProtoJSON` form
//! of the specification's protobuf messages): `camelCase` fields,
//! `SCREAMING_SNAKE` enum values, and every `oneof` as a single member
//! named by its field.
//!
//! Source: <https://a2a-protocol.org/latest/specification/>

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    /// The terminal states: a task accepts no more work and its streams
    /// close.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Canceled | Self::Rejected
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    #[serde(rename = "ROLE_USER")]
    User,
    #[serde(rename = "ROLE_AGENT")]
    Agent,
}

/// One message part: exactly one of `text`, `raw`, `url`, `data`.
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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub state: TaskState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<Message>,
    pub timestamp: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub artifact_id: String,
    pub name: String,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub context_id: String,
    pub status: TaskStatus,
    /// `None` omits the field (a `ListTasks` row without `includeArtifacts`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<Vec<Artifact>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<Message>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusUpdateEvent {
    pub task_id: String,
    pub context_id: String,
    pub status: TaskStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifactUpdateEvent {
    pub task_id: String,
    pub context_id: String,
    pub artifact: Artifact,
    pub append: bool,
    pub last_chunk: bool,
}

/// The opening `task` frame is written from the snapshot.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamResponse {
    StatusUpdate(TaskStatusUpdateEvent),
    ArtifactUpdate(TaskArtifactUpdateEvent),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    pub message: Message,
    #[serde(default)]
    pub configuration: Option<SendMessageConfiguration>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageConfiguration {
    #[serde(default)]
    pub accepted_output_modes: Vec<String>,
    #[serde(default)]
    pub task_push_notification_config: Option<Value>,
    #[serde(default)]
    pub history_length: Option<u32>,
    #[serde(default)]
    pub return_immediately: bool,
}

impl SendMessageConfiguration {
    /// Whether the client takes `media_type` in the reply; no list takes
    /// anything.
    #[must_use]
    pub fn accepts_output(&self, media_type: &str) -> bool {
        self.accepted_output_modes.is_empty()
            || self.accepted_output_modes.iter().any(|mode| {
                mode.split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .eq_ignore_ascii_case(media_type)
            })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQuery {
    pub id: String,
    #[serde(default)]
    pub history_length: Option<u32>,
}

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
}
