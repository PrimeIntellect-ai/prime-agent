//! The A2A v1.0.0 protocol data model (the JSON serialization of the
//! specification's Protocol Buffer definitions), served by the A2A mode
//! (`--mode a2a`; see `server.rs`).
//!
//! Wire discipline: field names `camelCase`, enum values `SCREAMING_SNAKE`
//! (`ProtoJSON`), every polymorphic object a single-member `OneOf` by member
//! name (v1.0 removed the v0.3 `kind` discriminators), timestamps ISO
//! 8601 UTC milliseconds. The serde tests hold one hand-verified JSON
//! literal per object, quoted from the specification, so a wire drift is
//! a red test — the same discipline the ACP layer holds against its TS
//! captures.
//!
//! Source: the `Agent2Agent` Protocol Specification 1.0.0,
//! <https://a2a-protocol.org/latest/specification/> (sections 3-9).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A2A task lifecycle states (spec 4.1.3). Terminal states accept no
/// further messages; interrupted states await client action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskState {
    #[serde(rename = "TASK_STATE_UNSPECIFIED")]
    Unspecified,
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
    /// The terminal states (spec 3.1.2): a stream closes and a task
    /// accepts no further messages once reached.
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
    #[serde(rename = "ROLE_UNSPECIFIED")]
    Unspecified,
    #[serde(rename = "ROLE_USER")]
    User,
    #[serde(rename = "ROLE_AGENT")]
    Agent,
}

/// One message part (spec 4.1.6): a flat `OneOf` of `text` / `raw` /
/// `url` / `data` by member name — v1.0's replacement for the v0.3
/// `kind` discriminators — plus optional `filename`, `mediaType`, and
/// `metadata`. A part with zero or more than one content member is
/// invalid, so deserialization rejects it rather than guessing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    /// The string content of the text part.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The raw byte content of a file, base64 in JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    /// A URL pointing at the file content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Arbitrary structured JSON data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// The file's name, when the part is a file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    /// The MIME type of the part content, available for all part types.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
}

impl Part {
    /// A text part, the one shape the A2A server emits.
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

    /// The content members explicitly set, in a stable order; the
    /// validity check is exactly one.
    fn content_members(&self) -> usize {
        usize::from(self.text.is_some())
            + usize::from(self.raw.is_some())
            + usize::from(self.url.is_some())
            + usize::from(self.data.is_some())
    }

    /// The spec's `OneOf` validity (spec 4.1.6): "A `Part` MUST contain
    /// exactly one of: text, raw, url, data".
    #[must_use]
    pub fn is_valid(&self) -> bool {
        self.content_members() == 1
    }

    /// The joined text of an all-text part list (the parts separated
    /// by a newline, the official client's own `get_message_text`
    /// default — 'Translate to French:' plus 'Good morning' reaches
    /// the agent as two lines, never a fused word), or `None` when a
    /// part carries a non-text content member (the caller answers
    /// `ContentTypeNotSupportedError`).
    #[must_use]
    pub fn join_text(parts: &[Part]) -> Option<String> {
        let mut text = String::new();
        for part in parts {
            // Exactly one content member, and it is text (spec 4.1.6);
            // anything else is unsupported content.
            if part.content_members() != 1 || part.text.is_none() {
                return None;
            }
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(part.text.as_deref().unwrap_or(""));
        }
        Some(text)
    }
}

/// One unit of communication between client and server (spec 4.1.4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// The message creator's identifier.
    pub message_id: String,
    pub context_id: Option<String>,
    pub task_id: Option<String>,
    pub role: Role,
    pub parts: Vec<Part>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_task_ids: Option<Vec<String>>,
}

/// The status of a task (spec 4.1.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub state: TaskState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
}

/// A task output (spec 4.1.7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub artifact_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub parts: Vec<Part>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Vec<String>>,
}

/// The core unit of action (spec 4.1.1): one prompt turn in the A2A
/// server's session mapping.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<Artifact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
}

/// A task status change event (spec 4.2.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusUpdateEvent {
    pub task_id: String,
    pub context_id: String,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
}

/// A task artifact delta (spec 4.2.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifactUpdateEvent {
    pub task_id: String,
    pub context_id: String,
    pub artifact: Artifact,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub append: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_chunk: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
}

/// The streaming wrapper (spec 3.2.3): every SSE data frame and webhook
/// payload carries exactly one of these members.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamResponse {
    Task(Task),
    Message(Message),
    StatusUpdate(TaskStatusUpdateEvent),
    ArtifactUpdate(TaskArtifactUpdateEvent),
}

impl Serialize for StreamResponse {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::Error as _;
        let mut object = serde_json::Map::new();
        match self {
            Self::Task(task) => {
                object.insert(
                    "task".into(),
                    serde_json::to_value(task).map_err(S::Error::custom)?,
                );
            }
            Self::Message(message) => {
                object.insert(
                    "message".into(),
                    serde_json::to_value(message).map_err(S::Error::custom)?,
                );
            }
            Self::StatusUpdate(event) => {
                object.insert(
                    "statusUpdate".into(),
                    serde_json::to_value(event).map_err(S::Error::custom)?,
                );
            }
            Self::ArtifactUpdate(event) => {
                object.insert(
                    "artifactUpdate".into(),
                    serde_json::to_value(event).map_err(S::Error::custom)?,
                );
            }
        }
        serializer.collect_map(object)
    }
}

impl StreamResponse {
    /// The `OneOf` member names in their spec order; the exact count is
    /// the validity rule (spec 3.2.3).
    const MEMBERS: [&str; 4] = ["task", "message", "statusUpdate", "artifactUpdate"];
}

impl<'de> Deserialize<'de> for StreamResponse {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let object = serde_json::Map::<String, Value>::deserialize(deserializer)?;
        let present: Vec<&str> = StreamResponse::MEMBERS
            .iter()
            .copied()
            .filter(|name| object.contains_key(*name))
            .collect();
        if present.len() != 1 {
            return Err(serde::de::Error::custom(format!(
                "StreamResponse must contain exactly one of {} (found {})",
                StreamResponse::MEMBERS.join(", "),
                present.join(", ")
            )));
        }
        let value = object
            .get(present[0])
            .ok_or_else(|| serde::de::Error::custom("StreamResponse member value missing"))?;
        // `present` is filtered from MEMBERS, so the fallback is the
        // compiler-required impossible arm, never a silent default.
        match present[0] {
            "task" => Ok(Self::Task(
                serde_json::from_value(value.clone()).map_err(D::Error::custom)?,
            )),
            "message" => Ok(Self::Message(
                serde_json::from_value(value.clone()).map_err(D::Error::custom)?,
            )),
            "statusUpdate" => Ok(Self::StatusUpdate(
                serde_json::from_value(value.clone()).map_err(D::Error::custom)?,
            )),
            "artifactUpdate" => Ok(Self::ArtifactUpdate(
                serde_json::from_value(value.clone()).map_err(D::Error::custom)?,
            )),
            other => Err(D::Error::custom(other)),
        }
    }
}

/// The `SendMessage` params (spec 3.2.1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant: Option<String>,
    pub message: Message,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<SendMessageConfiguration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
}

/// The send-message configuration (spec 3.2.2). Blocking is the default:
/// `return_immediately` unset or false waits for the task to settle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageConfiguration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_output_modes: Option<Vec<String>>,
    /// The requested push-notification delivery for the task (spec
    /// 3.2.2, `TaskPushNotificationConfig`). Parsed only to detect
    /// presence: the card declares push off, so any value answers the
    /// spec's `PushNotificationNotSupportedError` before side effects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_push_notification_config: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_length: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_immediately: Option<bool>,
}

impl SendMessageRequest {
    /// The blocking verdict (spec 3.2.2): unset or `false` waits for a
    /// terminal or interrupted state before answering.
    #[must_use]
    pub fn blocking(&self) -> bool {
        !self
            .configuration
            .as_ref()
            .is_some_and(|config| config.return_immediately.unwrap_or(false))
    }
}

/// The `GetTask` params (spec 3.1.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetTaskParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant: Option<String>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_length: Option<u32>,
}

/// The `ListTasks` params (spec 3.1.4).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<TaskState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_size: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_length: Option<u32>,
    /// The inclusive status-timestamp floor (spec 3.1.4): only tasks
    /// updated at or after this instant are returned.
    /// `google.protobuf.Timestamp`'s JSON form (see `TimestampJson`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_timestamp_after: Option<TimestampJson>,
    /// Whether list rows carry artifacts (spec 3.1.4: "Defaults to
    /// false to reduce payload size" — unset or false omits them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_artifacts: Option<bool>,
}

/// A `google.protobuf.Timestamp` in its JSON form (spec 3.1.4's
/// `statusTimestampAfter`): the RFC 3339 string
/// (`"2026-11-06T10:29:28.669Z"` — offsets and arbitrary fractional
/// precision accepted, the instant preserved to the nanosecond) or the
/// object form (`{ "seconds": "1730896168", "nanos": 669000000 }`).
/// Anything else — trailing garbage, an impossible date, a bad offset —
/// fails the deserialization (a parameter error, never a silent
/// no-filter).
#[derive(Debug, Clone, PartialEq)]
pub struct TimestampJson {
    /// The instant since the Unix epoch, in nanoseconds.
    pub nanos: i128,
}

impl<'de> Deserialize<'de> for TimestampJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = TimestampJson;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a google.protobuf.Timestamp JSON value")
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                crate::util::rfc3339_to_unix_ns(value)
                    .map(|nanos| TimestampJson { nanos })
                    .ok_or_else(|| E::custom("invalid RFC 3339 timestamp"))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                let mut seconds: Option<i64> = None;
                let mut nanos: i64 = 0;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "seconds" => {
                            // ProtoJSON maps int64 fields to strings;
                            // a numeric literal is accepted leniently.
                            seconds = Some(match map.next_value::<Value>()? {
                                Value::String(text) => {
                                    text.parse().map_err(serde::de::Error::custom)?
                                }
                                value => serde_json::from_value(value)
                                    .map_err(serde::de::Error::custom)?,
                            });
                        }
                        "nanos" => {
                            nanos = serde_json::from_value(map.next_value()?)
                                .map_err(serde::de::Error::custom)?;
                        }
                        _ => {
                            let _ = map.next_value::<Value>()?;
                        }
                    }
                }
                let seconds = seconds
                    .ok_or_else(|| serde::de::Error::custom("the object form needs seconds"))?;
                if !(0..1_000_000_000).contains(&nanos) {
                    return Err(serde::de::Error::custom("nanos must be within 0..1e9"));
                }
                Ok(TimestampJson {
                    nanos: i128::from(seconds) * 1_000_000_000 + i128::from(nanos),
                })
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

/// The `ListTasks` result (spec 3.1.4): `nextPageToken` is always
/// present, empty when the page is the last.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksResponse {
    pub tasks: Vec<Task>,
    pub next_page_token: String,
    pub page_size: u32,
    pub total_size: u32,
}

/// The `CancelTask` params (spec 3.1.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelTaskParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant: Option<String>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
}

/// One supported interface of the agent (spec 4.4.6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInterface {
    pub url: String,
    pub protocol_binding: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant: Option<String>,
    pub protocol_version: String,
}

/// The capability set of the agent (spec 4.4.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push_notifications: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Vec<AgentExtension>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extended_agent_card: Option<bool>,
}

/// A declared protocol extension (spec 4.4.4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExtension {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
}

/// A distinct capability the agent can perform (spec 4.4.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub examples: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_modes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_modes: Option<Vec<String>>,
}

/// The service provider of the agent (spec 4.4.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProvider {
    pub url: String,
    pub organization: String,
}

/// The HTTP authentication security scheme (spec 4.5.3), the one scheme
/// the A2A server's card declares when a bearer token is configured.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpAuthSecurityScheme {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The HTTP authentication scheme (RFC 7235), e.g. "Bearer".
    pub scheme: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearer_format: Option<String>,
}

/// A security scheme of the agent card (spec 4.5.1): a discriminated
/// union the A2A server fills with its HTTP bearer scheme only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SecurityScheme {
    /// The HTTP authentication scheme, under its spec member name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "httpAuthSecurityScheme"
    )]
    pub http_auth_security_scheme: Option<HttpAuthSecurityScheme>,
}

/// One security requirement (spec 8.5): the named schemes a request must
/// satisfy. The v1 shape is the spec's sample form, schemes as a map of
/// scheme name to scope list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SecurityRequirement {
    pub schemes: BTreeMap<String, SecurityScopes>,
}

/// The scope list of one required scheme.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SecurityScopes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<Vec<String>>,
}

/// The agent discovery manifest (spec 4.4.1), served at
/// `/.well-known/agent-card.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCard {
    pub name: String,
    pub description: String,
    pub supported_interfaces: Vec<AgentInterface>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<AgentProvider>,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub documentation_url: Option<String>,
    pub capabilities: AgentCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security_schemes: Option<BTreeMap<String, SecurityScheme>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security_requirements: Option<Vec<SecurityRequirement>>,
    pub default_input_modes: Vec<String>,
    pub default_output_modes: Vec<String>,
    pub skills: Vec<AgentSkill>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
}

impl AgentCard {
    /// The well-known URI of the agent card (spec 8.2, IANA-registered).
    pub const WELL_KNOWN_PATH: &'static str = "/.well-known/agent-card.json";
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// serde round-trip: a value survives a serialize/deserialize pair
    /// unchanged.
    fn round_trip<T>(value: &T) -> T
    where
        T: Serialize + serde::de::DeserializeOwned,
    {
        serde_json::from_value(serde_json::to_value(value).unwrap()).unwrap()
    }

    /// The spec's part examples (appendix A.2.1): the member name is the
    /// discriminator, `kind` never appears.
    #[test]
    fn parts_use_member_names_not_kind_discriminators() {
        let text: Part = serde_json::from_value(json!({ "text": "Hello, world!" })).unwrap();
        assert_eq!(text.text.as_deref(), Some("Hello, world!"));
        assert!(text.is_valid());

        let file: Part = serde_json::from_value(json!({
            "raw": "iVBORw0KGgo...",
            "filename": "diagram.png",
            "mediaType": "image/png",
        }))
        .unwrap();
        assert!(file.is_valid());
        assert_eq!(file.filename.as_deref(), Some("diagram.png"));
        assert_eq!(file.media_type.as_deref(), Some("image/png"));

        let data: Part = serde_json::from_value(json!({
            "data": { "origin": { "lat": 37.7749 } },
            "mediaType": "application/json",
        }))
        .unwrap();
        assert!(data.is_valid());

        // The spec's OneOf rule (4.1.6): zero or multiple content
        // members are invalid — deserialization rejects, never guesses.
        assert!(!Part {
            text: Some("a".into()),
            raw: Some("b".into()),
            url: None,
            data: None,
            filename: None,
            media_type: None,
            metadata: None,
        }
        .is_valid());
        let neither = serde_json::from_value::<Part>(json!({ "mediaType": "text/plain" }));
        assert!(neither.is_ok()); // parses; validity is a call-site check
        assert!(!neither.unwrap().is_valid());

        // A join over an all-text list separates the parts with a
        // newline (the official client's own `get_message_text`
        // default — 'Translate to French:' plus 'Good morning' reaches
        // the agent as two lines, never a fused word); anything else is
        // not supported content (the caller answers -32005).
        assert_eq!(
            Part::join_text(&[
                Part::text("a"),
                Part {
                    text: None,
                    raw: Some("aGk=".into()),
                    url: None,
                    data: None,
                    filename: None,
                    media_type: None,
                    metadata: None,
                },
            ]),
            None
        );
        assert_eq!(
            Part::join_text(&[
                Part::text("Translate to French:"),
                Part::text("Good morning"),
            ]),
            Some("Translate to French:\nGood morning".to_string())
        );
        // A single part joins with no separator; empty text stays empty
        // (the caller answers the parameter error).
        assert_eq!(
            Part::join_text(&[Part::text("one part")]),
            Some("one part".to_string())
        );
        assert_eq!(Part::join_text(&[Part::text("")]), Some(String::new()));
    }

    /// The streaming event members are the spec's v1.0 shapes (appendix
    /// A.2.1): a `statusUpdate` wrapper, not a `kind` field.
    #[test]
    fn stream_events_use_wrapper_members() {
        let event = StreamResponse::StatusUpdate(TaskStatusUpdateEvent {
            task_id: "task-1".into(),
            context_id: "ctx-1".into(),
            status: TaskStatus {
                state: TaskState::Working,
                message: None,
                timestamp: Some("2026-11-05T10:30:00.000Z".into()),
            },
            metadata: None,
        });
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["statusUpdate"]["taskId"], "task-1");
        assert_eq!(
            value["statusUpdate"]["status"]["state"],
            "TASK_STATE_WORKING"
        );
        let parsed: StreamResponse = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, event);
    }

    /// The `StreamResponse` `OneOf` (spec 3.2.3): one member exactly,
    /// both
    /// directions.
    #[test]
    fn stream_response_is_a_strict_oneof() {
        let task = StreamResponse::Task(Task {
            id: "t".into(),
            context_id: Some("c".into()),
            status: TaskStatus {
                state: TaskState::Submitted,
                message: None,
                timestamp: None,
            },
            artifacts: Vec::new(),
            history: Vec::new(),
            metadata: None,
        });
        let value = serde_json::to_value(&task).unwrap();
        assert!(value.get("task").is_some());
        assert_eq!(round_trip(&task), task);

        let empty: Result<StreamResponse, _> =
            serde_json::from_value(json!({ "task": null, "message": null }));
        assert!(empty.is_err());

        let two: Result<StreamResponse, _> = serde_json::from_value(json!({
            "task": { "id": "t", "status": { "state": "TASK_STATE_COMPLETED" } },
            "message": { "messageId": "m", "role": "ROLE_AGENT", "parts": [] },
        }));
        assert!(two.is_err());
    }

    /// The blocking verdict of a send request (spec 3.2.2): blocking
    /// unless `returnImmediately` is true.
    #[test]
    fn send_message_blocks_by_default() {
        let request = |config: Option<Value>| SendMessageRequest {
            tenant: None,
            message: Message {
                message_id: "m-1".into(),
                context_id: None,
                task_id: None,
                role: Role::User,
                parts: vec![Part::text("hi")],
                metadata: None,
                extensions: None,
                reference_task_ids: None,
            },
            configuration: config.and_then(|config| serde_json::from_value(config).ok()),
            metadata: None,
        };
        assert!(request(None).blocking());
        assert!(request(Some(json!({ "returnImmediately": false }))).blocking());
        assert!(!request(Some(json!({ "returnImmediately": true }))).blocking());
    }

    /// The agent card round-trips the spec's own sample shape (spec
    /// 8.5): camelCase fields, interfaces first-preferred, the skills
    /// array non-empty.
    #[test]
    fn agent_card_serializes_the_spec_sample_shape() {
        let card = AgentCard {
            name: "GeoSpatial Route Planner Agent".into(),
            description: "Provides advanced route planning.".into(),
            supported_interfaces: vec![
                AgentInterface {
                    url: "https://georoute-agent.example.com/a2a/v1".into(),
                    protocol_binding: "JSONRPC".into(),
                    tenant: None,
                    protocol_version: "1.0".into(),
                },
                AgentInterface {
                    url: "grpc.example.com:443".into(),
                    protocol_binding: "GRPC".into(),
                    tenant: None,
                    protocol_version: "1.0".into(),
                },
            ],
            provider: None,
            version: "1.2.0".into(),
            documentation_url: None,
            capabilities: AgentCapabilities {
                streaming: Some(true),
                push_notifications: Some(true),
                extensions: None,
                extended_agent_card: Some(true),
            },
            security_schemes: None,
            security_requirements: None,
            default_input_modes: vec!["text/plain".into()],
            default_output_modes: vec!["text/plain".into()],
            skills: vec![AgentSkill {
                id: "route-optimizer-traffic".into(),
                name: "Traffic-Aware Route Optimizer".into(),
                description: "Calculates the optimal driving route.".into(),
                tags: vec!["maps".into()],
                examples: None,
                input_modes: None,
                output_modes: None,
            }],
            icon_url: None,
        };
        let value = serde_json::to_value(&card).unwrap();
        assert_eq!(
            value["supportedInterfaces"][0]["protocolBinding"],
            "JSONRPC"
        );
        assert_eq!(value["capabilities"]["extendedAgentCard"], true);
        assert_eq!(value["defaultInputModes"][0], "text/plain");
        assert_eq!(value["skills"][0]["id"], "route-optimizer-traffic");
        assert_eq!(round_trip(&card), card);
    }

    /// The task states and roles ride their `SCREAMING_SNAKE` enum names
    /// (spec 5.5).
    #[test]
    fn enums_use_screaming_snake_wire_names() {
        assert_eq!(
            serde_json::to_value(TaskState::InputRequired).unwrap(),
            "TASK_STATE_INPUT_REQUIRED"
        );
        assert_eq!(serde_json::to_value(Role::User).unwrap(), "ROLE_USER");
        let state: TaskState = serde_json::from_value(json!("TASK_STATE_COMPLETED")).unwrap();
        assert_eq!(state, TaskState::Completed);
        assert!(state.is_terminal());
        assert!(!TaskState::AuthRequired.is_terminal());
    }
}
