//! Typed builders for the catalog's v2 events: the compile-time surface of
//! the #2117 tracking vocabulary. Every field is typed (numbers are `u64`,
//! enums are Rust enums, nullable durations are `Option<u64>`), so a firing
//! site cannot emit a stringly-typed or out-of-vocabulary value. Optional
//! fields are `Option` and simply omit the property when `None`.
//!
//! The builders only carry event-specific properties; the client merges the
//! base properties (version, platform, execution mode) under them, and the
//! worker normalizes every batch through [`crate::catalog::sanitize`]
//! before any sink sees it.

use serde_json::Value;

use crate::properties::Properties;
use crate::TelemetryClient;

/// The #2117 run trigger: a fresh prompt or a loop continuation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunTrigger {
    Prompt,
    Continuation,
    Unknown,
}

impl RunTrigger {
    /// The wire vocabulary value.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Continuation => "continuation",
            Self::Unknown => "unknown",
        }
    }
}

/// The #2117 tool category (the fixed vocabulary; `from_tool_name` maps a
/// concrete tool name onto it, `unknown` for anything unrecognized).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolCategory {
    Read,
    Write,
    Edit,
    Bash,
    Grep,
    Find,
    Ls,
    Ipython,
    Mcp,
    Custom,
    Unknown,
}

impl ToolCategory {
    /// Map a concrete tool name onto the fixed category vocabulary.
    #[must_use]
    pub fn from_tool_name(tool_name: &str) -> Self {
        let normalized = tool_name.to_ascii_lowercase();
        let core = normalized.split([':', '_']).next().unwrap_or_default();
        match core {
            "read" => Self::Read,
            "write" => Self::Write,
            "edit" => Self::Edit,
            "bash" => Self::Bash,
            "grep" => Self::Grep,
            "find" => Self::Find,
            "ls" => Self::Ls,
            "ipython" => Self::Ipython,
            "mcp" => Self::Mcp,
            "" => Self::Unknown,
            _ => Self::Custom,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Edit => "edit",
            Self::Bash => "bash",
            Self::Grep => "grep",
            Self::Find => "find",
            Self::Ls => "ls",
            Self::Ipython => "ipython",
            Self::Mcp => "mcp",
            Self::Custom => "custom",
            Self::Unknown => "unknown",
        }
    }
}

/// The #2117 timing stage: which boundary a timing event measures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimingStage {
    FirstModelEvent,
    FirstReasoning,
    FirstText,
    Tool,
    RetryWait,
    Compaction,
    StreamGap,
    TimeToError,
}

impl TimingStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::FirstModelEvent => "first_model_event",
            Self::FirstReasoning => "first_reasoning",
            Self::FirstText => "first_text",
            Self::Tool => "tool",
            Self::RetryWait => "retry_wait",
            Self::Compaction => "compaction",
            Self::StreamGap => "stream_gap",
            Self::TimeToError => "time_to_error",
        }
    }
}

/// The #2117 error event kind: a failure occurrence or a later recovery
/// update (recovery never creates a second occurrence).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorEventKind {
    Occurrence,
    RecoveryUpdate,
}

impl ErrorEventKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Occurrence => "occurrence",
            Self::RecoveryUpdate => "recovery_update",
        }
    }
}

/// `agent run started`: fires at the run's `AgentStart` boundary, pairing
/// the run with its id and trigger before any model call.
#[derive(Debug, Clone)]
pub struct AgentRunStarted {
    pub session_id: String,
    pub run_id: String,
    pub run_index: u64,
    pub trigger: RunTrigger,
}

impl AgentRunStarted {
    pub fn track(&self, client: &TelemetryClient) {
        let mut properties = Properties::new();
        properties.set("session_id", Value::String(self.session_id.clone()));
        properties.set("run_id", Value::String(self.run_id.clone()));
        properties.set("run_index", Value::from(self.run_index));
        properties.set("trigger", Value::from(self.trigger.as_str()));
        client.track("agent run started", properties);
    }
}

/// `agent timing`: one stage boundary measurement.
#[derive(Debug, Clone)]
pub struct AgentTiming {
    pub stage: TimingStage,
    pub duration_ms: Option<u64>,
    pub outcome: Option<&'static str>,
    pub tool_category: Option<ToolCategory>,
    pub timing_origin: Option<&'static str>,
}

impl AgentTiming {
    pub fn track(&self, client: &TelemetryClient) {
        let Some(duration_ms) = self.duration_ms else {
            // A measurement that never observed its end edge is not an
            // event: missing durations stay null-free (no fake zeros).
            return;
        };
        let mut properties = Properties::new();
        properties.set("stage", Value::from(self.stage.as_str()));
        properties.set("duration_ms", Value::from(duration_ms));
        if let Some(outcome) = self.outcome {
            properties.set("outcome", Value::from(outcome));
        }
        if let Some(category) = self.tool_category {
            properties.set("tool_category", Value::from(category.as_str()));
        }
        if let Some(origin) = self.timing_origin {
            properties.set("timing_origin", Value::from(origin));
        }
        client.track("agent timing", properties);
    }
}

/// `agent tool summary`: per-run, per-category aggregates at run finalize.
#[derive(Debug, Clone)]
pub struct AgentToolSummary {
    pub session_id: String,
    pub run_id: String,
    pub tool_category: ToolCategory,
    pub call_count: u64,
    pub failure_count: u64,
    pub duration_ms: Option<u64>,
    pub recovered_count: Option<u64>,
}

impl AgentToolSummary {
    pub fn track(&self, client: &TelemetryClient) {
        if self.call_count == 0 {
            return;
        }
        let mut properties = Properties::new();
        properties.set("session_id", Value::String(self.session_id.clone()));
        properties.set("run_id", Value::String(self.run_id.clone()));
        properties.set("tool_category", Value::from(self.tool_category.as_str()));
        properties.set("call_count", Value::from(self.call_count));
        properties.set("failure_count", Value::from(self.failure_count));
        if let Some(duration) = self.duration_ms {
            properties.set("duration_ms", Value::from(duration));
        }
        if let Some(recovered) = self.recovered_count {
            properties.set("recovered_count", Value::from(recovered));
        }
        client.track("agent tool summary", properties);
    }
}

/// `agent error`: an error occurrence or recovery update. The message
/// policy keeps raw provider text out: `diagnostic_message` carries the
/// fixed diagnostic, and `error_message` only a reviewed fixed string.
#[derive(Debug, Clone, Default)]
pub struct AgentError {
    pub error_id: String,
    pub kind: Option<ErrorEventKind>,
    pub subtype: Option<&'static str>,
    pub category: Option<&'static str>,
    pub code: Option<&'static str>,
    pub http_status: Option<u64>,
    pub classification_source: Option<&'static str>,
    pub diagnostic_message: Option<&'static str>,
    pub component: Option<&'static str>,
    pub operation: Option<&'static str>,
    pub stage: Option<&'static str>,
    pub retryable: Option<bool>,
    pub retry_attempt: Option<u64>,
    pub retry_backoff_ms: Option<u64>,
    pub consecutive_failure_count: Option<u64>,
    pub recovery_action: Option<&'static str>,
    pub recovery_outcome: Option<&'static str>,
    pub error_message: Option<&'static str>,
    pub error_message_source: Option<&'static str>,
    pub error_message_length: Option<u64>,
    pub error_message_length_lower_bound: Option<bool>,
    pub error_message_truncated: Option<bool>,
    pub error_message_redacted: Option<bool>,
}

impl AgentError {
    pub fn track(&self, client: &TelemetryClient) {
        let Some(kind) = self.kind else { return };
        let mut properties = Properties::new();
        properties.set("error_id", Value::String(self.error_id.clone()));
        properties.set("error_event_kind", Value::from(kind.as_str()));
        if let Some(subtype) = self.subtype {
            properties.set("error_subtype", Value::from(subtype));
        }
        if let Some(category) = self.category {
            properties.set("error_category", Value::from(category));
        }
        if let Some(code) = self.code {
            properties.set("error_code", Value::from(code));
        }
        if let Some(status) = self.http_status {
            properties.set("http_status", Value::from(status));
        }
        if let Some(source) = self.classification_source {
            properties.set("classification_source", Value::from(source));
            properties.set(
                "classifier_revision",
                Value::from(crate::catalog::ERROR_CLASSIFIER_REVISION),
            );
        }
        if let Some(message) = self.diagnostic_message {
            properties.set("diagnostic_message", Value::from(message));
        }
        if let Some(component) = self.component {
            properties.set("component", Value::from(component));
        }
        if let Some(operation) = self.operation {
            properties.set("operation", Value::from(operation));
        }
        if let Some(stage) = self.stage {
            properties.set("stage", Value::from(stage));
        }
        if let Some(retryable) = self.retryable {
            properties.set("retryable", Value::from(retryable));
        }
        if let Some(attempt) = self.retry_attempt {
            properties.set("retry_attempt", Value::from(attempt));
        }
        if let Some(backoff) = self.retry_backoff_ms {
            properties.set("retry_backoff_ms", Value::from(backoff));
        }
        if let Some(count) = self.consecutive_failure_count {
            properties.set("consecutive_failure_count", Value::from(count));
        }
        if let Some(action) = self.recovery_action {
            properties.set("recovery_action", Value::from(action));
        }
        if let Some(outcome) = self.recovery_outcome {
            properties.set("recovery_outcome", Value::from(outcome));
        }
        if let (Some(message), Some(source)) = (self.error_message, self.error_message_source) {
            properties.set("error_message", Value::from(message));
            properties.set("error_message_source", Value::from(source));
        }
        if let Some(length) = self.error_message_length {
            properties.set("error_message_length", Value::from(length));
        }
        if let Some(lower_bound) = self.error_message_length_lower_bound {
            properties.set("error_message_length_lower_bound", Value::from(lower_bound));
        }
        if let Some(truncated) = self.error_message_truncated {
            properties.set("error_message_truncated", Value::from(truncated));
        }
        if let Some(redacted) = self.error_message_redacted {
            properties.set("error_message_redacted", Value::from(redacted));
        }
        client.track("agent error", properties);
    }
}

/// `onboarding stage`: one onboarding journey stage, the flow's real
/// stages only.
#[derive(Debug, Clone)]
pub struct OnboardingStage {
    pub onboarding_id: String,
    pub stage: &'static str,
    pub outcome: &'static str,
    pub duration_ms: Option<u64>,
    pub auth_category: Option<&'static str>,
    pub entry_reason: Option<&'static str>,
    pub timing_scope: Option<&'static str>,
}

impl OnboardingStage {
    pub fn track(&self, client: &TelemetryClient) {
        let mut properties = Properties::new();
        properties.set("onboarding_id", Value::String(self.onboarding_id.clone()));
        properties.set("stage", Value::from(self.stage));
        properties.set("outcome", Value::from(self.outcome));
        if let Some(duration) = self.duration_ms {
            properties.set("duration_ms", Value::from(duration));
        }
        if let Some(category) = self.auth_category {
            properties.set("auth_category", Value::from(category));
        }
        if let Some(reason) = self.entry_reason {
            properties.set("entry_reason", Value::from(reason));
        }
        if let Some(scope) = self.timing_scope {
            properties.set("timing_scope", Value::from(scope));
        }
        client.track("onboarding stage", properties);
    }
}

/// `agent feature outcome`: a feature attempt and its observed result.
#[derive(Debug, Clone)]
pub struct AgentFeatureOutcome {
    pub feature_id: String,
    pub feature_name: &'static str,
    pub outcome: &'static str,
    pub duration_ms: Option<u64>,
    pub configuration_choice: Option<&'static str>,
}

impl AgentFeatureOutcome {
    pub fn track(&self, client: &TelemetryClient) {
        let mut properties = Properties::new();
        properties.set("feature_id", Value::String(self.feature_id.clone()));
        properties.set("feature_name", Value::from(self.feature_name));
        properties.set("outcome", Value::from(self.outcome));
        if let Some(duration) = self.duration_ms {
            properties.set("duration_ms", Value::from(duration));
        }
        if let Some(choice) = self.configuration_choice {
            properties.set("configuration_choice", Value::from(choice));
        }
        client.track("agent feature outcome", properties);
    }
}

/// `agent startup stage`: one startup phase's timing.
#[derive(Debug, Clone)]
pub struct AgentStartupStage {
    pub stage: &'static str,
    pub outcome: &'static str,
    pub duration_ms: Option<u64>,
    pub startup_kind: Option<&'static str>,
    pub timing_scope: Option<&'static str>,
}

impl AgentStartupStage {
    pub fn track(&self, client: &TelemetryClient) {
        let Some(duration_ms) = self.duration_ms else {
            return;
        };
        let mut properties = Properties::new();
        properties.set("stage", Value::from(self.stage));
        properties.set("outcome", Value::from(self.outcome));
        properties.set("duration_ms", Value::from(duration_ms));
        if let Some(kind) = self.startup_kind {
            properties.set("startup_kind", Value::from(kind));
        }
        if let Some(scope) = self.timing_scope {
            properties.set("timing_scope", Value::from(scope));
        }
        client.track("agent startup stage", properties);
    }
}

/// `agent input stage`: one input lifecycle observation.
#[derive(Debug, Clone)]
pub struct AgentInputStage {
    pub input_id: String,
    pub stage: &'static str,
    pub outcome: &'static str,
    pub duration_ms: Option<u64>,
    pub timing_origin: Option<&'static str>,
}

impl AgentInputStage {
    pub fn track(&self, client: &TelemetryClient) {
        let mut properties = Properties::new();
        properties.set("input_id", Value::String(self.input_id.clone()));
        properties.set("stage", Value::from(self.stage));
        properties.set("outcome", Value::from(self.outcome));
        if let Some(duration) = self.duration_ms {
            properties.set("duration_ms", Value::from(duration));
        }
        if let Some(origin) = self.timing_origin {
            properties.set("timing_origin", Value::from(origin));
        }
        client.track("agent input stage", properties);
    }
}

/// `agent installation stage`: one installer/updater stage outcome.
#[derive(Debug, Clone)]
pub struct AgentInstallationStage {
    pub installation_attempt_id: String,
    pub installation_action: &'static str,
    pub installation_source: &'static str,
    pub stage: &'static str,
    pub outcome: &'static str,
    pub reason: Option<&'static str>,
    pub from_version: Option<String>,
    pub target_version: Option<String>,
    pub observed_version: Option<String>,
    pub duration_ms: Option<u64>,
    pub exit_code: Option<u64>,
    pub session_restore_total: Option<u64>,
    pub session_restore_failed: Option<u64>,
}

impl AgentInstallationStage {
    pub fn track(&self, client: &TelemetryClient) {
        let mut properties = Properties::new();
        properties.set(
            "installation_attempt_id",
            Value::String(self.installation_attempt_id.clone()),
        );
        properties.set("installation_action", Value::from(self.installation_action));
        properties.set("installation_source", Value::from(self.installation_source));
        properties.set("stage", Value::from(self.stage));
        properties.set("outcome", Value::from(self.outcome));
        if let Some(reason) = self.reason {
            properties.set("reason", Value::from(reason));
        }
        if let Some(version) = &self.from_version {
            properties.set("from_version", Value::String(version.clone()));
        }
        if let Some(version) = &self.target_version {
            properties.set("target_version", Value::String(version.clone()));
        }
        if let Some(version) = &self.observed_version {
            properties.set("observed_version", Value::String(version.clone()));
        }
        if let Some(duration) = self.duration_ms {
            properties.set("duration_ms", Value::from(duration));
        }
        if let Some(code) = self.exit_code {
            properties.set("exit_code", Value::from(code));
        }
        if let Some(total) = self.session_restore_total {
            properties.set("session_restore_total", Value::from(total));
        }
        if let Some(failed) = self.session_restore_failed {
            properties.set("session_restore_failed", Value::from(failed));
        }
        client.track("agent installation stage", properties);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::catalog::{
        AUTH_CATEGORIES, CLASSIFICATION_SOURCES, ERROR_CATEGORIES, ERROR_CODES, ERROR_COMPONENTS,
        ERROR_OPERATIONS, ERROR_STAGES, ERROR_SUBTYPES, FEATURE_NAMES, FEATURE_OUTCOMES,
        INPUT_OUTCOMES, INPUT_STAGES, INSTALLATION_ACTIONS, INSTALLATION_OUTCOMES,
        INSTALLATION_REASONS, INSTALLATION_SOURCES, INSTALLATION_STAGES, ONBOARDING_ENTRY_REASONS,
        ONBOARDING_OUTCOMES, ONBOARDING_STAGES, PROVIDER_CATEGORIES, READY_KINDS, RECOVERY_ACTIONS,
        RECOVERY_OUTCOMES, RUN_TRIGGERS, STARTUP_KINDS, STARTUP_OUTCOMES, STARTUP_STAGES,
        TERMINAL_OUTCOMES, TIMING_ORIGINS, TIMING_STAGES, TOOL_CATEGORIES,
    };
    use crate::{MockSink, TelemetryClientConfig};

    fn recording_client(mock: &Arc<MockSink>) -> TelemetryClient {
        let mut config = TelemetryClientConfig::new("install-1");
        config.batch_size = 1;
        config.flush_interval = Duration::from_secs(600);
        config.sinks = vec![mock.clone() as Arc<dyn crate::TelemetrySink>];
        TelemetryClient::spawn(config).expect("spawn client")
    }

    async fn properties_of(
        mock: &MockSink,
        name: &str,
    ) -> serde_json::Map<String, serde_json::Value> {
        tokio::time::sleep(Duration::from_millis(10)).await;
        mock.events()
            .into_iter()
            .find(|event| event.name == name)
            .expect("event tracked")
            .properties
            .into()
    }

    #[tokio::test]
    async fn run_started_carries_typed_properties() {
        let mock = Arc::new(MockSink::new());
        let client = recording_client(&mock);
        AgentRunStarted {
            session_id: "0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a".into(),
            run_id: "0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1b".into(),
            run_index: 3,
            trigger: RunTrigger::Prompt,
        }
        .track(&client);
        client.flush().await.unwrap();
        let properties = properties_of(&mock, "agent run started").await;
        assert_eq!(properties["run_index"], serde_json::json!(3));
        assert_eq!(properties["trigger"], serde_json::json!("prompt"));
        assert_eq!(
            properties["session_id"],
            serde_json::json!("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a")
        );
    }

    #[tokio::test]
    async fn timing_omits_unmeasured_stages() {
        let mock = Arc::new(MockSink::new());
        let client = recording_client(&mock);
        AgentTiming {
            stage: TimingStage::Tool,
            duration_ms: None,
            outcome: Some("success"),
            tool_category: Some(ToolCategory::Bash),
            timing_origin: None,
        }
        .track(&client);
        client.flush().await.unwrap();
        assert!(mock.event_names().is_empty(), "no duration, no event");
        AgentTiming {
            stage: TimingStage::StreamGap,
            duration_ms: Some(120),
            outcome: Some("success"),
            tool_category: None,
            timing_origin: Some("worker_action"),
        }
        .track(&client);
        client.flush().await.unwrap();
        let properties = properties_of(&mock, "agent timing").await;
        assert_eq!(properties["stage"], serde_json::json!("stream_gap"));
        assert_eq!(properties["duration_ms"], serde_json::json!(120));
        assert_eq!(
            properties["timing_origin"],
            serde_json::json!("worker_action")
        );
    }

    #[tokio::test]
    async fn tool_summary_skips_empty_categories() {
        let mock = Arc::new(MockSink::new());
        let client = recording_client(&mock);
        AgentToolSummary {
            session_id: "0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a".into(),
            run_id: "0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1b".into(),
            tool_category: ToolCategory::Edit,
            call_count: 0,
            failure_count: 0,
            duration_ms: None,
            recovered_count: None,
        }
        .track(&client);
        client.flush().await.unwrap();
        assert!(mock.event_names().is_empty(), "no calls, no summary");
    }

    #[tokio::test]
    async fn error_requires_kind_and_id() {
        let mock = Arc::new(MockSink::new());
        let client = recording_client(&mock);
        AgentError::default().track(&client);
        client.flush().await.unwrap();
        assert!(mock.event_names().is_empty(), "no kind, no event");
        AgentError {
            error_id: "0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1c".into(),
            kind: Some(ErrorEventKind::Occurrence),
            subtype: Some("rate_limited"),
            category: Some("rate_limit"),
            code: Some("rate_limit_exceeded"),
            http_status: Some(429),
            classification_source: Some("http_status"),
            ..Default::default()
        }
        .track(&client);
        client.flush().await.unwrap();
        let properties = properties_of(&mock, "agent error").await;
        assert_eq!(
            properties["error_event_kind"],
            serde_json::json!("occurrence")
        );
        assert_eq!(
            properties["error_subtype"],
            serde_json::json!("rate_limited")
        );
        assert_eq!(
            properties["error_category"],
            serde_json::json!("rate_limit")
        );
        assert_eq!(properties["http_status"], serde_json::json!(429));
        assert_eq!(properties["classifier_revision"], serde_json::json!(1));
        assert!(!properties.contains_key("error_message"), "no raw message");
    }

    #[test]
    fn tool_category_mapping() {
        assert_eq!(ToolCategory::from_tool_name("bash"), ToolCategory::Bash);
        assert_eq!(ToolCategory::from_tool_name("Edit"), ToolCategory::Edit);
        assert_eq!(
            ToolCategory::from_tool_name("ipython"),
            ToolCategory::Ipython
        );
        assert_eq!(
            ToolCategory::from_tool_name("mcp__github__create_issue"),
            ToolCategory::Mcp
        );
        assert_eq!(
            ToolCategory::from_tool_name("web-search"),
            ToolCategory::Custom
        );
        assert_eq!(ToolCategory::from_tool_name(""), ToolCategory::Unknown);
    }

    #[test]
    fn vocabulary_consts_stay_in_the_catalog() {
        // The builder enums must stay inside the catalog vocabularies.
        for trigger in ["prompt", "continuation", "unknown"] {
            assert!(RUN_TRIGGERS.contains(&trigger));
        }
        for stage in [
            "first_model_event",
            "first_reasoning",
            "first_text",
            "tool",
            "retry_wait",
            "compaction",
            "stream_gap",
            "time_to_error",
        ] {
            assert!(TIMING_STAGES.contains(&stage), "{stage}");
        }
        for category in TOOL_CATEGORIES {
            assert!(TOOL_CATEGORIES.contains(category));
        }
        assert!(ERROR_SUBTYPES.contains(&"rate_limited"));
        assert!(ERROR_CATEGORIES.contains(&"rate_limit"));
        assert!(ERROR_CODES.contains(&"unknown"));
        assert!(CLASSIFICATION_SOURCES.contains(&"http_status"));
        assert!(ERROR_COMPONENTS.contains(&"provider"));
        assert!(ERROR_OPERATIONS.contains(&"stream"));
        assert!(ERROR_STAGES.contains(&"model_stream"));
        assert!(RECOVERY_ACTIONS.contains(&"automatic_retry"));
        assert!(RECOVERY_OUTCOMES.contains(&"success"));
        assert!(FEATURE_NAMES.contains(&"goal"));
        assert!(FEATURE_OUTCOMES.contains(&"completed"));
        assert!(INSTALLATION_STAGES.contains(&"completed"));
        assert!(INSTALLATION_OUTCOMES.contains(&"success"));
        assert!(INSTALLATION_REASONS.contains(&"up_to_date"));
        assert!(INSTALLATION_ACTIONS.contains(&"update"));
        assert!(INSTALLATION_SOURCES.contains(&"cli"));
        assert!(READY_KINDS.contains(&"interactive"));
        assert!(INPUT_STAGES.contains(&"terminal"));
        assert!(INPUT_OUTCOMES.contains(&"no_run"));
        assert!(STARTUP_STAGES.contains(&"ui_ready"));
        assert!(STARTUP_OUTCOMES.contains(&"completed"));
        assert!(STARTUP_KINDS.contains(&"cold"));
        assert!(TERMINAL_OUTCOMES.contains(&"success"));
        assert!(TIMING_ORIGINS.contains(&"worker_action"));
        assert!(ONBOARDING_STAGES.contains(&"exit"));
        assert!(ONBOARDING_OUTCOMES.contains(&"completed"));
        assert!(ONBOARDING_ENTRY_REASONS.contains(&"first_setup"));
        assert!(PROVIDER_CATEGORIES.contains(&"prime"));
        assert!(AUTH_CATEGORIES.contains(&"none"));
    }
}
