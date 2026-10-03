//! Typed builders for the catalog's lifecycle events (onboarding, startup,
//! installation stages) and the run vocabulary enums. Every field is typed (numbers are `u64`,
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

    /// The category's wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
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
    use super::*;
    use crate::catalog::{RUN_TRIGGERS, TOOL_CATEGORIES};

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
        for trigger in ["prompt", "continuation", "unknown"] {
            assert!(RUN_TRIGGERS.contains(&trigger));
        }
        for category in [
            ToolCategory::Read,
            ToolCategory::Write,
            ToolCategory::Edit,
            ToolCategory::Bash,
            ToolCategory::Grep,
            ToolCategory::Find,
            ToolCategory::Ls,
            ToolCategory::Ipython,
            ToolCategory::Mcp,
            ToolCategory::Custom,
            ToolCategory::Unknown,
        ] {
            assert!(TOOL_CATEGORIES.contains(&category.as_str()));
        }
    }
}
