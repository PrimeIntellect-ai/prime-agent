//! Settings types (settings-manager.ts). All fields optional; JSON values of
//! the wrong type load as `None` (the TS access-time typechecks), never a
//! load error.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MermaidRenderingMode {
    Off,
    Final,
    Streaming,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateChannel {
    Stable,
    Nightly,
}

/// Thinking levels in wire form ("off" | "minimal" | "low" | "medium" |
/// "high" | "xhigh" | "max").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThinkingLevelSetting {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ThinkingLevelSetting {
    /// The reverse of [`ThinkingLevelSetting::model_level`]: a live switch
    /// (daemon `set_thinking_level`) persists a model-vocabulary level as
    /// the settings default without re-matching this enum at the call site.
    pub fn from_model_level(level: pa_types::ai::ModelThinkingLevel) -> ThinkingLevelSetting {
        match level {
            pa_types::ai::ModelThinkingLevel::Off => ThinkingLevelSetting::Off,
            pa_types::ai::ModelThinkingLevel::Minimal => ThinkingLevelSetting::Minimal,
            pa_types::ai::ModelThinkingLevel::Low => ThinkingLevelSetting::Low,
            pa_types::ai::ModelThinkingLevel::Medium => ThinkingLevelSetting::Medium,
            pa_types::ai::ModelThinkingLevel::High => ThinkingLevelSetting::High,
            pa_types::ai::ModelThinkingLevel::Xhigh => ThinkingLevelSetting::Xhigh,
            pa_types::ai::ModelThinkingLevel::Max => ThinkingLevelSetting::Max,
        }
    }

    /// The same level in the shared model vocabulary: the settings default
    /// feeds session thinking-level resolution, so callers need the
    /// pa-types value without re-matching this enum.
    pub fn model_level(self) -> pa_types::ai::ModelThinkingLevel {
        match self {
            ThinkingLevelSetting::Off => pa_types::ai::ModelThinkingLevel::Off,
            ThinkingLevelSetting::Minimal => pa_types::ai::ModelThinkingLevel::Minimal,
            ThinkingLevelSetting::Low => pa_types::ai::ModelThinkingLevel::Low,
            ThinkingLevelSetting::Medium => pa_types::ai::ModelThinkingLevel::Medium,
            ThinkingLevelSetting::High => pa_types::ai::ModelThinkingLevel::High,
            ThinkingLevelSetting::Xhigh => pa_types::ai::ModelThinkingLevel::Xhigh,
            ThinkingLevelSetting::Max => pa_types::ai::ModelThinkingLevel::Max,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QueueModeSetting {
    All,
    #[serde(alias = "oneAtATime")]
    OneAtATime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransportSetting {
    Auto,
    Sse,
    WebSocket,
    #[serde(rename = "websocket-cached")]
    WebSocketCached,
}

/// `number | "unlimited"` autonomous limit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AutonomousLimitSetting {
    Number(f64),
    Unlimited(String),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionSettings {
    pub enabled: Option<bool>,
    pub reserve_tokens: Option<u64>,
    pub keep_recent_tokens: Option<u64>,
    pub agent_callable: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummarySettings {
    pub reserve_tokens: Option<u64>,
    pub skip_prompt: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoRefineSettings {
    pub enabled: Option<bool>,
    pub turn_interval: Option<u64>,
    pub compact: Option<bool>,
    pub cooldown_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderWaitSettings {
    pub enabled: Option<bool>,
    pub base_delay_ms: Option<u64>,
    pub max_delay_ms: Option<u64>,
    pub max_attempts: Option<u64>,
    pub max_wait_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRetrySettings {
    pub timeout_ms: Option<u64>,
    pub max_retry_delay_ms: Option<u64>,
    pub wait_for_usage: Option<ProviderWaitSettings>,
}

/// Provider-failover settings (`retry.failover`): when another configured
/// provider serves the same model, a provider that exhausts its quick
/// retries hands the turn to the next one instead of failing it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryFailoverSettings {
    pub enabled: Option<bool>,
    /// Retries per provider before switching (default 5).
    pub max_retries: Option<u64>,
    /// First backoff delay, doubling each retry (default 1000ms).
    pub base_delay_ms: Option<u64>,
    /// Backoff ceiling per retry (default 30000ms).
    pub max_delay_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrySettings {
    pub enabled: Option<bool>,
    pub max_retries: Option<u64>,
    pub base_delay_ms: Option<u64>,
    pub failover: Option<RetryFailoverSettings>,
    pub provider: Option<ProviderRetrySettings>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    pub show_images: Option<bool>,
    pub clear_on_shrink: Option<bool>,
    pub show_terminal_progress: Option<bool>,
    pub fullscreen: Option<bool>,
    pub fullscreen_mouse: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSettings {
    pub auto_resize: Option<bool>,
    pub block_images: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingBudgetsSettings {
    pub minimal: Option<u64>,
    pub low: Option<u64>,
    pub medium: Option<u64>,
    pub high: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutonomousSettings {
    pub max_continuations: Option<AutonomousLimitSetting>,
    pub max_turns: Option<AutonomousLimitSetting>,
    pub max_tokens: Option<AutonomousLimitSetting>,
    pub timeout_ms: Option<AutonomousLimitSetting>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownSettings {
    pub code_block_indent: Option<String>,
    pub mermaid: Option<MermaidRenderingMode>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledSkillsSettings {
    pub websearch: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarningSettings {
    pub anthropic_extra_usage: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTracesSettings {
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySettings {
    pub enabled: Option<bool>,
    pub notice_shown: Option<bool>,
    /// Self-hosted PostHog capture configuration. Nothing is compiled in;
    /// an empty configuration resolves to the no-op sink.
    pub posthog: Option<PostHogSettings>,
    /// Local JSONL mirror at `<agentDir>/telemetry.jsonl` (default on:
    /// user-observable transparency).
    pub local_mirror: Option<bool>,
}

/// Settings `telemetry.posthog`: endpoint + project capture key.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostHogSettings {
    pub endpoint: Option<String>,
    pub api_key: Option<String>,
}

/// User-declared MCP server (settings `mcpServers` entry).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum McpServerConfig {
    Http {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        headers: Option<serde_json::Map<String, serde_json::Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bearer_token_env_var: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        oauth: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled_tools: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        disabled_tools: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        startup_timeout_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_timeout_ms: Option<u64>,
    },
    Stdio {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<serde_json::Map<String, serde_json::Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled_tools: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        disabled_tools: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        startup_timeout_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_timeout_ms: Option<u64>,
    },
}

/// The settings document: every known field optional; unknown keys preserved.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub onboarding_shown: Option<bool>,
    pub onboarding_completed: Option<bool>,
    pub default_provider: Option<String>,
    pub default_model: Option<String>,
    pub subagent_default_model: Option<String>,
    pub update_channel: Option<UpdateChannel>,
    pub recent_models: Option<Vec<String>>,
    pub auxiliary_model: Option<String>,
    pub default_thinking_level: Option<ThinkingLevelSetting>,
    pub default_service_tier: Option<String>,
    pub rlm_max_depth: Option<u64>,
    /// `number | "off" | "none"`; raw JSON because the TS getter validates at
    /// access time.
    pub idle_eviction_minutes: Option<serde_json::Value>,
    /// Session archiving age rule: sessions untouched for this many days are
    /// moved to the daemon's archive directory. `number | "off" | "none"`; raw
    /// JSON validated at access time (same grammar as `idleEvictionMinutes`).
    pub session_archive_max_age_days: Option<serde_json::Value>,
    /// Session archiving count rule: keep at most this many unarchived
    /// sessions (newest by mtime win); `0 | "off" | "none"` disables. Raw JSON
    /// validated at access time.
    pub session_archive_max_sessions: Option<serde_json::Value>,
    pub transport: Option<TransportSetting>,
    pub steering_mode: Option<QueueModeSetting>,
    pub follow_up_mode: Option<QueueModeSetting>,
    pub theme: Option<String>,
    pub compaction: Option<CompactionSettings>,
    pub auto_refine: Option<AutoRefineSettings>,
    pub agent_traces: Option<AgentTracesSettings>,
    pub telemetry: Option<TelemetrySettings>,
    pub branch_summary: Option<BranchSummarySettings>,
    pub retry: Option<RetrySettings>,
    pub provider_backup_model: Option<String>,
    pub autonomous: Option<AutonomousSettings>,
    pub shell_path: Option<String>,
    pub quiet_startup: Option<bool>,
    pub shell_command_prefix: Option<String>,
    pub npm_command: Option<Vec<String>>,
    pub mcp_servers: Option<serde_json::Map<String, serde_json::Value>>,
    /// Extra local MCP service-catalog files (TS `mcpCatalogSources`;
    /// ~-relative allowed), merged after the compiled built-ins, first
    /// source wins per id, and no bundled id can be shadowed.
    pub mcp_catalog_sources: Option<Vec<String>>,
    pub packages: Option<Vec<serde_json::Value>>,
    pub extensions: Option<Vec<String>>,
    pub skills: Option<Vec<String>>,
    pub prompts: Option<Vec<String>>,
    pub themes: Option<Vec<String>>,
    pub enable_skill_commands: Option<bool>,
    pub bundled_skills: Option<BundledSkillsSettings>,
    pub enable_builtin_skills: Option<bool>,
    pub terminal: Option<TerminalSettings>,
    pub images: Option<ImageSettings>,
    pub enabled_models: Option<Vec<String>>,
    /// Rust-only daemon-level model allowlist: model patterns (the
    /// `--models` CLI scope grammar) the daemon may resolve to. Enforced at
    /// the daemon's model-resolution seams (`set_model`, RLM child-model
    /// resolution, the worker startup chain); a model outside the allowlist
    /// fails loudly instead of resolving, with no fallback. `None` is
    /// unrestricted (the TS behavior).
    pub allowed_models: Option<Vec<String>>,
    pub tree_filter_mode: Option<String>,
    pub thinking_budgets: Option<ThinkingBudgetsSettings>,
    pub editor_padding_x: Option<u64>,
    pub autocomplete_max_visible: Option<u64>,
    pub show_hardware_cursor: Option<bool>,
    pub markdown: Option<MarkdownSettings>,
    pub warnings: Option<WarningSettings>,
    pub session_dir: Option<String>,
    /// Unknown keys survive load/save round-trips (forward compatibility).
    #[serde(flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, serde_json::Value>,
}
