//! `SettingsManager`: loads global + project settings, merges them, tracks
//! modified fields, and writes back only what this session changed.

use std::sync::Arc;

use anyhow::Result;

use super::load::from_value_lenient;
use super::merge::{deep_merge, migrate};
use super::storage::{SettingsScope, SettingsStorage};
use super::types::{
    QueueModeSetting, Settings, ThinkingLevelSetting, TransportSetting, UpdateChannel,
};

pub const RECENT_MODELS_LIMIT: usize = 20;
pub const DEFAULT_IDLE_EVICTION_MINUTES: u64 = 90;
/// Session archiving defaults (roadmap item: the sessions directory must not
/// grow forever). Age rule mirrors the TS `idleEvictionMinutes` grammar
/// (`number | "off" | "none"`, malformed falls back to the default).
pub const DEFAULT_SESSION_ARCHIVE_MAX_AGE_DAYS: u64 = 30;
pub const DEFAULT_SESSION_ARCHIVE_MAX_SESSIONS: usize = 200;

#[derive(Debug, Clone)]
pub struct SettingsError {
    pub scope: SettingsScope,
    pub message: String,
}

pub struct SettingsManager {
    storage: Arc<dyn SettingsStorage>,
    global: Settings,
    project: Settings,
    merged: Settings,
    runtime_overrides: Settings,
    errors: Vec<SettingsError>,
    /// The raw global document (the parsed JSON before the lenient field
    /// load). The daemon model allowlist distinguishes an ABSENT
    /// `allowedModels` key (unrestricted) from a PRESENT-but-malformed one
    /// (the security gate fails closed) — the typed `Settings` drops both
    /// to `None`, so the raw value is the only witness.
    global_raw: Option<serde_json::Value>,
    /// Load failures per scope; a scope whose file failed to parse is never
    /// written back (the TS `save` guard against clobbering bad settings).
    global_load_error: Option<String>,
    project_load_error: Option<String>,
}

impl SettingsManager {
    /// Load global + project settings from a storage backend.
    pub fn from_storage(storage: Arc<dyn SettingsStorage>) -> Self {
        let mut errors = Vec::new();
        let (global, global_raw, global_load_error) =
            load_scope(storage.as_ref(), SettingsScope::Global, &mut errors);
        let (project, _, project_load_error) =
            load_scope(storage.as_ref(), SettingsScope::Project, &mut errors);
        let merged = deep_merge(&global, &project);
        Self {
            storage,
            global,
            project,
            merged,
            runtime_overrides: Settings::default(),
            global_raw,
            errors,
            global_load_error,
            project_load_error,
        }
    }

    /// File-backed manager (agentDir + cwd/.prime/agent).
    pub fn create(
        cwd: impl AsRef<std::path::Path>,
        agent_dir: impl AsRef<std::path::Path>,
    ) -> Self {
        let cwd = std::path::PathBuf::from(cwd.as_ref());
        let agent_dir = std::path::PathBuf::from(agent_dir.as_ref());
        let storage: Arc<dyn SettingsStorage> =
            Arc::new(super::storage::FileSettingsStorage::new(cwd, agent_dir));
        Self::from_storage(storage)
    }

    /// In-memory manager (tests, embedded hosts).
    pub fn in_memory(initial: Settings) -> Self {
        let storage: Arc<dyn SettingsStorage> =
            Arc::new(super::storage::InMemorySettingsStorage::default());
        let content = serde_json::to_string_pretty(&initial).unwrap_or_default();
        storage
            .with_lock(SettingsScope::Global, &mut |current| {
                let _ = current;
                Some(content.clone())
            })
            .ok();
        Self::from_storage(storage)
    }

    /// Effective (global + project) settings.
    pub fn settings(&self) -> &Settings {
        &self.merged
    }

    pub fn global_settings(&self) -> &Settings {
        &self.global
    }

    /// The raw global document (post-migration, pre-lenient-load value);
    /// `None` when the scope has no document or it failed to parse (the
    /// load error covers the latter).
    pub fn global_raw(&self) -> Option<&serde_json::Value> {
        self.global_raw.as_ref()
    }

    pub fn project_settings(&self) -> &Settings {
        &self.project
    }

    pub fn errors(&self) -> &[SettingsError] {
        &self.errors
    }

    /// Take and clear the recorded settings errors (warnings are printed once
    /// by the CLI commands that surface them).
    pub fn drain_errors(&mut self) -> Vec<SettingsError> {
        std::mem::take(&mut self.errors)
    }

    /// Reload both scopes from storage.
    ///
    /// # Errors
    ///
    /// The current implementation never returns `Err`; scope load problems
    /// are recorded as load errors on the manager instead.
    pub fn reload(&mut self) -> Result<()> {
        let mut errors = std::mem::take(&mut self.errors);
        let (global, global_raw, global_load_error) =
            load_scope(self.storage.as_ref(), SettingsScope::Global, &mut errors);
        let (project, _, project_load_error) =
            load_scope(self.storage.as_ref(), SettingsScope::Project, &mut errors);
        self.global = global;
        self.project = project;
        self.global_raw = global_raw;
        self.global_load_error = global_load_error;
        self.project_load_error = project_load_error;
        self.errors = errors;
        self.merged = deep_merge(&self.global, &self.project);
        Ok(())
    }

    /// Runtime overrides layered on top (CLI flags); not persisted.
    pub fn apply_overrides(&mut self, overrides: &Settings) {
        self.merged = deep_merge(&self.merged, overrides);
        self.runtime_overrides = deep_merge(&self.runtime_overrides, overrides);
    }

    /// Mutable global settings for the setters in sibling modules (the
    /// TS setters mutate `globalSettings` then save).
    pub(crate) fn global_mut(&mut self) -> &mut Settings {
        &mut self.global
    }

    /// Persist the global scope (sibling-module setters share this).
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub(crate) fn save_global_scope(&mut self) -> Result<()> {
        self.save_global()
    }

    // -- persisted setters --------------------------------------------------

    /// `defaultProvider` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_default_provider(&mut self, provider: String) -> Result<()> {
        self.global.default_provider = Some(provider);
        self.save_global()
    }

    /// `defaultModel` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_default_model(&mut self, model: String) -> Result<()> {
        self.global.default_model = Some(model);
        self.save_global()
    }

    /// `defaultModel` + `defaultProvider` setter (the model switch's
    /// combined write).
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_default_model_and_provider(
        &mut self,
        provider: String,
        model: String,
    ) -> Result<()> {
        self.global.default_provider = Some(provider.clone());
        self.global.default_model = Some(model.clone());
        self.record_model_use(&provider, &model);
        self.save_global()
    }

    /// `markdown.codeBlockIndent` (TS `getCodeBlockIndent`): the string the
    /// chat markdown renderer indents fenced code blocks by; the default
    /// matches the TS default, two spaces.
    pub fn get_code_block_indent(&self) -> String {
        self.settings()
            .markdown
            .as_ref()
            .and_then(|markdown| markdown.code_block_indent.clone())
            .unwrap_or_else(|| "  ".to_string())
    }

    /// `terminal.fullscreenMouse` (TS `getFullscreenMouse`): whether the
    /// fullscreen transcript surface enables mouse tracking and wheel
    /// scrolling; the default matches the TS default, true.
    pub fn get_fullscreen_mouse(&self) -> bool {
        self.settings()
            .terminal
            .as_ref()
            .and_then(|terminal| terminal.fullscreen_mouse)
            .unwrap_or(true)
    }

    /// `terminal.showImages` (TS `getShowImages`): whether image blocks in
    /// tool results render their type/dimension metadata rows; the
    /// default matches the TS default, true.
    pub fn get_show_images(&self) -> bool {
        self.settings()
            .terminal
            .as_ref()
            .and_then(|terminal| terminal.show_images)
            .unwrap_or(true)
    }

    /// `treeFilterMode` (TS `getTreeFilterMode`): the `/tree` selector's
    /// initial filter; an unset or invalid value falls back to
    /// `user-only`, like the TS default.
    pub fn get_tree_filter_mode(&self) -> String {
        let mode = self.settings().tree_filter_mode.clone().unwrap_or_default();
        let valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
        if valid.contains(&mode.as_str()) && !mode.is_empty() {
            mode
        } else {
            "user-only".to_string()
        }
    }

    /// `chatDetail` (TS #2709 `getChatDetail`): the conversation-detail
    /// level the chat starts at; an unset or invalid value falls back to
    /// `details` (the TS #2447 startup level).
    pub fn get_chat_detail(&self) -> String {
        match self.settings().chat_detail.as_deref() {
            Some("overview") => "overview",
            Some("all") => "all",
            _ => "details",
        }
        .to_string()
    }

    /// `branchSummary.skipPrompt` (TS `getBranchSummarySkipPrompt`).
    pub fn get_branch_summary_skip_prompt(&self) -> bool {
        self.settings()
            .branch_summary
            .as_ref()
            .and_then(|branch_summary| branch_summary.skip_prompt)
            .unwrap_or(false)
    }

    /// Record a model use at the front of `recentModels` (capped at 20).
    pub fn record_model_use(&mut self, provider: &str, model: &str) {
        let key = format!("{provider}/{model}");
        let mut recent: Vec<String> = vec![key];
        for existing in self.global.recent_models.iter().flatten() {
            if existing != &recent[0] {
                recent.push(existing.clone());
            }
        }
        recent.truncate(RECENT_MODELS_LIMIT);
        self.global.recent_models = Some(recent);
    }

    /// `steeringMode` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_steering_mode(&mut self, mode: QueueModeSetting) -> Result<()> {
        self.global.steering_mode = Some(mode);
        self.save_global()
    }

    /// `followUpMode` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_follow_up_mode(&mut self, mode: QueueModeSetting) -> Result<()> {
        self.global.follow_up_mode = Some(mode);
        self.save_global()
    }

    /// `theme` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_theme(&mut self, theme: String) -> Result<()> {
        self.global.theme = Some(theme);
        self.save_global()
    }

    /// `updateChannel` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_update_channel(&mut self, channel: UpdateChannel) -> Result<()> {
        self.global.update_channel = Some(channel);
        self.save_global()
    }

    /// `defaultThinkingLevel` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_default_thinking_level(&mut self, level: ThinkingLevelSetting) -> Result<()> {
        self.global.default_thinking_level = Some(level);
        self.save_global()
    }

    /// TS `setRetryEnabled`: the auto-retry toggle the provider retry
    /// policy reads (`retry.enabled`).
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_retry_enabled(&mut self, enabled: bool) -> Result<()> {
        self.global
            .retry
            .get_or_insert_with(Default::default)
            .enabled = Some(enabled);
        self.save_global()
    }

    /// TS `setCompactionEnabled`: the auto-compaction toggle
    /// (`compaction.enabled` in the global settings file). The connection
    /// state's `autoCompactionEnabled` is this value in TS, so a daemon
    /// restart re-seeds the flag from the persisted setting.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_compaction_enabled(&mut self, enabled: bool) -> Result<()> {
        self.global
            .compaction
            .get_or_insert_with(Default::default)
            .enabled = Some(enabled);
        self.save_global()
    }

    /// `transport` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_transport(&mut self, transport: TransportSetting) -> Result<()> {
        self.global.transport = Some(transport);
        self.save_global()
    }

    /// `rlmMaxDepth` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_rlm_max_depth(&mut self, depth: u64) -> Result<()> {
        self.global.rlm_max_depth = Some(depth);
        self.save_global()
    }

    /// `telemetry.enabled` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_telemetry_enabled(&mut self, enabled: bool) -> Result<()> {
        let telemetry = self.global.telemetry.get_or_insert_with(Default::default);
        telemetry.enabled = Some(enabled);
        self.save_global()
    }

    /// `telemetry.noticeShown` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_telemetry_notice_shown(&mut self, shown: bool) -> Result<()> {
        let telemetry = self.global.telemetry.get_or_insert_with(Default::default);
        telemetry.notice_shown = Some(shown);
        self.save_global()
    }

    /// `onboardingShown` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_onboarding_shown(&mut self, shown: bool) -> Result<()> {
        self.global.onboarding_shown = Some(shown);
        self.save_global()
    }

    /// `onboardingCompleted` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_onboarding_completed(&mut self, completed: bool) -> Result<()> {
        self.global.onboarding_completed = Some(completed);
        self.save_global()
    }

    /// TS `getOnboardingShown`: the shown flag with the legacy completed
    /// flag as fallback; first run is defined by the settings alone.
    pub fn get_onboarding_shown(&self) -> bool {
        self.merged
            .onboarding_shown
            .or(self.merged.onboarding_completed)
            .unwrap_or(false)
    }

    /// TS `getCompactionEnabled`: the auto-compaction toggle, on until the
    /// user opts out (the merged view, like every TS settings getter).
    pub fn get_compaction_enabled(&self) -> bool {
        self.merged
            .compaction
            .as_ref()
            .and_then(|compaction| compaction.enabled)
            .unwrap_or(true)
    }

    /// `agentTraces.enabled`: unset means OFF — trace sharing is
    /// opt-in, exactly the TS default. The first-run onboarding question
    /// is the opt-in moment; `/traces` stays the change path, and the
    /// value persists only when a choice is made.
    pub fn get_agent_traces_enabled(&self) -> bool {
        self.merged
            .agent_traces
            .as_ref()
            .and_then(|traces| traces.enabled)
            .unwrap_or(false)
    }

    /// Whether a trace-sharing choice was ever written: the
    /// `agentTraces.enabled` key present in the merged settings. A
    /// provisioned or copied-config home carries one, and the first-run
    /// flow never asks such a home the trace question — the standing
    /// choice stands and the flow completes silently. Only a fresh home
    /// (no choice written) is asked, once.
    pub fn agent_traces_choice_written(&self) -> bool {
        self.merged
            .agent_traces
            .as_ref()
            .and_then(|traces| traces.enabled)
            .is_some()
    }

    /// `agentTraces.enabled` setter.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_agent_traces_enabled(&mut self, enabled: bool) -> Result<()> {
        let traces = self
            .global
            .agent_traces
            .get_or_insert_with(Default::default);
        traces.enabled = Some(enabled);
        self.save_global()
    }

    /// Replace the `packages` array in the global settings file.
    pub fn set_packages(&mut self, packages: Vec<serde_json::Value>) {
        self.global.packages = Some(packages.clone());
        self.persist_scope_field(
            SettingsScope::Global,
            "packages",
            serde_json::Value::Array(packages),
        );
        self.merged = deep_merge(&self.global, &self.project);
    }

    /// Replace the `packages` array in the project settings file.
    pub fn set_project_packages(&mut self, packages: Vec<serde_json::Value>) {
        self.project.packages = Some(packages.clone());
        self.persist_scope_field(
            SettingsScope::Project,
            "packages",
            serde_json::Value::Array(packages),
        );
        self.merged = deep_merge(&self.global, &self.project);
    }

    /// Replace one resource-path array (`extensions`/`skills`/`prompts`/
    /// `themes`) in the global settings file (TS `setSkillPaths` & friends).
    pub fn set_global_resource_array(&mut self, field: &str, values: Vec<String>) {
        let array: Vec<serde_json::Value> =
            values.into_iter().map(serde_json::Value::String).collect();
        match field {
            "extensions" => self.global.extensions = Some(strings(&array)),
            "skills" => self.global.skills = Some(strings(&array)),
            "prompts" => self.global.prompts = Some(strings(&array)),
            "themes" => self.global.themes = Some(strings(&array)),
            _ => return,
        }
        self.persist_scope_field(
            SettingsScope::Global,
            field,
            serde_json::Value::Array(array),
        );
        self.merged = deep_merge(&self.global, &self.project);
    }

    /// Replace one resource-path array in the project settings file (TS
    /// `setProjectSkillPaths` & friends).
    pub fn set_project_resource_array(&mut self, field: &str, values: Vec<String>) {
        let array: Vec<serde_json::Value> =
            values.into_iter().map(serde_json::Value::String).collect();
        match field {
            "extensions" => self.project.extensions = Some(strings(&array)),
            "skills" => self.project.skills = Some(strings(&array)),
            "prompts" => self.project.prompts = Some(strings(&array)),
            "themes" => self.project.themes = Some(strings(&array)),
            _ => return,
        }
        self.persist_scope_field(
            SettingsScope::Project,
            field,
            serde_json::Value::Array(array),
        );
        self.merged = deep_merge(&self.global, &self.project);
    }

    /// Write one field into a scope's file, merging with the current on-disk
    /// document so concurrently-added fields survive. Settings failures are
    /// recorded as warnings, never thrown (the TS save contract).
    fn persist_scope_field(&mut self, scope: SettingsScope, field: &str, value: serde_json::Value) {
        let load_error = match scope {
            SettingsScope::Global => self.global_load_error.clone(),
            SettingsScope::Project => self.project_load_error.clone(),
        };
        if let Some(message) = load_error {
            let label = match scope {
                SettingsScope::Global => "Global",
                SettingsScope::Project => "Project",
            };
            self.errors.push(SettingsError {
                scope,
                message: format!(
                    "{label} settings not saved: settings file failed to parse: {message}"
                ),
            });
            return;
        }
        let result = self.storage.with_lock(scope, &mut |current| {
            let mut map: serde_json::Map<String, serde_json::Value> = current
                .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
                .and_then(|value| match value {
                    serde_json::Value::Object(mut map) => {
                        super::merge::migrate(&mut map);
                        Some(map)
                    }
                    _ => None,
                })
                .unwrap_or_default();
            map.insert(field.to_string(), value.clone());
            serde_json::to_string_pretty(&serde_json::Value::Object(map)).ok()
        });
        if let Err(error) = result {
            self.errors.push(SettingsError {
                scope,
                message: error.to_string(),
            });
        }
    }

    // -- getters with TS semantics ------------------------------------------

    pub fn get_default_provider(&self) -> Option<&str> {
        self.merged.default_provider.as_deref()
    }

    pub fn get_default_model(&self) -> Option<&str> {
        self.merged.default_model.as_deref()
    }

    /// Model for `rlm.spawn` without a pinned model; unset inherits parent.
    pub fn get_subagent_default_model(&self) -> Option<String> {
        self.merged
            .subagent_default_model
            .as_ref()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
    }

    pub fn get_auxiliary_model(&self) -> Option<&str> {
        self.merged.auxiliary_model.as_deref()
    }

    /// The daemon-level model allowlist (settings `allowedModels`): model
    /// patterns the daemon may resolve to, enforced at every daemon
    /// model resolution (`set_model`, RLM child-model resolution, the
    /// worker startup chain) — a model outside the allowlist fails loudly,
    /// never a fallback. Rust-only guardrail (no TS equivalent); `None` is
    /// unrestricted. A daemon policy like `idleEvictionMinutes`: read from
    /// the global scope only, so a project cannot weaken a box-level pin.
    /// A list that trims to empty behaves as unset.
    pub fn get_allowed_models(&self) -> Option<Vec<String>> {
        let patterns = self.global.allowed_models.as_ref()?;
        let patterns: Vec<String> = patterns
            .iter()
            .map(|pattern| pattern.trim().to_string())
            .filter(|pattern| !pattern.is_empty())
            .collect();
        (!patterns.is_empty()).then_some(patterns)
    }

    /// TS `setDefaultServiceTier`: the persisted default a fresh session
    /// starts from; the stored string is the same vocabulary
    /// `get_default_service_tier` parses.
    ///
    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_default_service_tier(&mut self, tier: pa_types::ai::ServiceTier) -> Result<()> {
        use pa_types::ai::ServiceTier;
        let name = match tier {
            ServiceTier::Auto => "auto",
            ServiceTier::Default => "default",
            ServiceTier::Flex => "flex",
            ServiceTier::Scale => "scale",
            ServiceTier::Priority => "priority",
        };
        self.global.default_service_tier = Some(name.to_string());
        self.save_global()
    }

    /// Service tier a fresh session records as its preference (TS
    /// `getDefaultServiceTier`: the setting when present, else `default`).
    /// An unrecognized setting value falls back to the same `default`.
    pub fn get_default_service_tier(&self) -> pa_types::ai::ServiceTier {
        use pa_types::ai::ServiceTier;
        self.merged
            .default_service_tier
            .as_deref()
            .and_then(|value| match value.trim().to_lowercase().as_str() {
                "auto" => Some(ServiceTier::Auto),
                "flex" => Some(ServiceTier::Flex),
                "scale" => Some(ServiceTier::Scale),
                "priority" => Some(ServiceTier::Priority),
                "default" => Some(ServiceTier::Default),
                _ => None,
            })
            .unwrap_or(ServiceTier::Default)
    }

    pub fn get_recent_models(&self) -> Vec<String> {
        self.merged.recent_models.clone().unwrap_or_default()
    }

    /// The steering queue's delivery mode (TS `steeringMode`): `all`
    /// batches every queued steering message into ONE co-delivered turn
    /// at the next turn boundary; `one-at-a-time` delivers one per turn.
    /// The product default is `all`; both modes stay selectable through
    /// the setting surface.
    pub fn get_steering_mode(&self) -> QueueModeSetting {
        self.merged.steering_mode.unwrap_or(QueueModeSetting::All)
    }

    pub fn get_follow_up_mode(&self) -> QueueModeSetting {
        self.merged
            .follow_up_mode
            .unwrap_or(QueueModeSetting::OneAtATime)
    }

    pub fn get_theme(&self) -> Option<&str> {
        self.merged.theme.as_deref()
    }

    /// Global-only read of the two known values; anything else is unset.
    pub fn get_update_channel(&self) -> Option<UpdateChannel> {
        self.global.update_channel
    }

    pub fn get_default_thinking_level(&self) -> Option<ThinkingLevelSetting> {
        self.merged.default_thinking_level
    }

    /// The shared provider retry policy from settings, combining the TS
    /// `getRetrySettings` and `getProviderRetrySettings` reads: the
    /// `retry.enabled`, `retry.maxRetries`, and `retry.baseDelayMs` knobs
    /// plus the `retry.provider.maxRetryDelayMs` cap.
    pub fn get_provider_retry_policy(
        &self,
    ) -> crate::session_engine::provider_retry::ProviderRetryPolicy {
        crate::session_engine::provider_retry::ProviderRetryPolicy {
            enabled: self
                .merged
                .retry
                .as_ref()
                .and_then(|retry| retry.enabled)
                .unwrap_or(true),
            max_retries: self
                .merged
                .retry
                .as_ref()
                .and_then(|retry| retry.max_retries)
                .map_or(
                    crate::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY
                        .max_retries,
                    |retries| retries.min(u32::MAX as u64) as u32,
                ),
            base_delay_ms: self
                .merged
                .retry
                .as_ref()
                .and_then(|retry| retry.base_delay_ms)
                .unwrap_or(
                    crate::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY
                        .base_delay_ms,
                ),
            max_retry_delay_ms: self
                .merged
                .retry
                .as_ref()
                .and_then(|retry| retry.provider.as_ref())
                .and_then(|provider| provider.max_retry_delay_ms)
                .unwrap_or(
                    crate::session_engine::provider_retry::DEFAULT_PROVIDER_RETRY_POLICY
                        .max_retry_delay_ms,
                ),
            max_delay_ms: crate::session_engine::provider_retry::UNBOUNDED_BACKOFF_MS,
        }
    }

    /// The provider-failover policy from settings (`retry.failover`).
    pub fn get_provider_failover_policy(
        &self,
    ) -> crate::session_engine::provider_failover::ProviderFailoverPolicy {
        let defaults = crate::session_engine::provider_failover::DEFAULT_PROVIDER_FAILOVER_POLICY;
        let failover = self
            .merged
            .retry
            .as_ref()
            .and_then(|retry| retry.failover.as_ref());
        crate::session_engine::provider_failover::ProviderFailoverPolicy {
            enabled: failover
                .and_then(|failover| failover.enabled)
                .unwrap_or(defaults.enabled),
            max_retries: failover
                .and_then(|failover| failover.max_retries)
                .map_or(defaults.max_retries, |retries| {
                    retries.min(u32::MAX as u64) as u32
                }),
            base_delay_ms: failover
                .and_then(|failover| failover.base_delay_ms)
                .unwrap_or(defaults.base_delay_ms),
            max_delay_ms: failover
                .and_then(|failover| failover.max_delay_ms)
                .unwrap_or(defaults.max_delay_ms),
        }
    }

    pub fn get_rlm_max_depth(&self) -> Option<u64> {
        self.global.rlm_max_depth
    }

    /// `number | "off" | "none"` -> finite minutes or Off; malformed falls
    /// back to the default (90).
    pub fn get_idle_eviction(&self) -> IdleEviction {
        match &self.global.idle_eviction_minutes {
            Some(serde_json::Value::String(text)) if text == "off" || text == "none" => {
                IdleEviction::Off
            }
            Some(serde_json::Value::Number(number)) => {
                if let Some(minutes) = number.as_u64() {
                    if minutes > 0 {
                        return IdleEviction::Minutes(minutes);
                    }
                }
                IdleEviction::Minutes(DEFAULT_IDLE_EVICTION_MINUTES)
            }
            _ => IdleEviction::Minutes(DEFAULT_IDLE_EVICTION_MINUTES),
        }
    }

    /// Resolved session-archiving policy: which sessions the daemon's archive
    /// sweep moves out of the sessions directory. Both rules are independent —
    /// a session is archived when EITHER fires. `None` on a field disables
    /// that rule.
    pub fn get_session_archive_policy(&self) -> SessionArchivePolicy {
        let max_age_days = match &self.global.session_archive_max_age_days {
            Some(serde_json::Value::String(text)) if text == "off" || text == "none" => None,
            Some(serde_json::Value::Number(number)) => Some(
                number
                    .as_u64()
                    .filter(|days| *days > 0)
                    .unwrap_or(DEFAULT_SESSION_ARCHIVE_MAX_AGE_DAYS),
            ),
            _ => Some(DEFAULT_SESSION_ARCHIVE_MAX_AGE_DAYS),
        };
        let max_sessions = match &self.global.session_archive_max_sessions {
            Some(serde_json::Value::String(text)) if text == "off" || text == "none" => None,
            Some(serde_json::Value::Number(number)) => number
                .as_u64()
                .filter(|count| *count > 0)
                .map(|count| count as usize),
            _ => Some(DEFAULT_SESSION_ARCHIVE_MAX_SESSIONS),
        };
        SessionArchivePolicy {
            max_age_days,
            max_sessions,
        }
    }

    pub fn get_transport(&self) -> TransportSetting {
        self.merged.transport.unwrap_or(TransportSetting::Auto)
    }

    /// Telemetry is enabled only when every scope says so (default true).
    pub fn get_telemetry_enabled(&self) -> bool {
        [
            self.global.telemetry.as_ref(),
            self.project.telemetry.as_ref(),
            self.runtime_overrides.telemetry.as_ref(),
        ]
        .iter()
        .all(|scope| scope.and_then(|t| t.enabled).unwrap_or(true))
    }

    pub fn get_telemetry_notice_shown(&self) -> bool {
        self.runtime_overrides
            .telemetry
            .as_ref()
            .and_then(|t| t.notice_shown)
            .or_else(|| self.global.telemetry.as_ref().and_then(|t| t.notice_shown))
            .unwrap_or(false)
    }

    /// `requestTiming`: unset means OFF — the per-request timing timeline
    /// is opt-in, exactly the TS default (`getRequestTiming`).
    pub fn get_request_timing(&self) -> bool {
        self.merged.request_timing.unwrap_or(false)
    }

    pub fn get_session_dir(&self) -> Option<std::path::PathBuf> {
        let session_dir = self.merged.session_dir.as_ref()?;
        let home = pa_types::platform::home_dir()?;
        Some(if session_dir == "~" {
            home
        } else if let Some(rest) = session_dir.strip_prefix("~/") {
            home.join(rest)
        } else {
            session_dir.into()
        })
    }

    // -- persistence ---------------------------------------------------------

    /// Write the global scope back (project scope is host-written, not
    /// user-set in this port), then re-derive the effective settings.
    fn save_global(&mut self) -> Result<()> {
        let content = serde_json::to_string_pretty(&self.global)?;
        self.storage
            .with_lock(SettingsScope::Global, &mut |current| {
                let _ = current;
                Some(content.clone())
            })?;
        self.merged = deep_merge(&self.global, &self.project);
        Ok(())
    }
}

/// Resolved `idleEvictionMinutes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleEviction {
    Minutes(u64),
    Off,
}

/// Resolved session-archiving settings: the age rule (archive sessions
/// untouched for `max_age_days` days) and the count rule (keep the newest
/// `max_sessions` sessions). Each field is `None` when its rule is off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionArchivePolicy {
    pub max_age_days: Option<u64>,
    pub max_sessions: Option<usize>,
}

fn strings(array: &[serde_json::Value]) -> Vec<String> {
    array
        .iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect()
}

/// One loaded scope: the leniently-parsed settings, the migrated raw
/// document (the value before the lenient field load — the only witness
/// for a PRESENT-but-malformed known field, which the lenient load drops),
/// and the load error (`Some` when the scope's document exists but could
/// not be read or parsed).
#[allow(clippy::type_complexity)]
fn load_scope(
    storage: &dyn SettingsStorage,
    scope: SettingsScope,
    errors: &mut Vec<SettingsError>,
) -> (Settings, Option<serde_json::Value>, Option<String>) {
    let mut content: Option<String> = None;
    let mut load_error: Option<String> = None;
    let result = storage.with_lock(scope, &mut |current| {
        content = current;
        None
    });
    if let Err(error) = result {
        errors.push(SettingsError {
            scope,
            message: error.to_string(),
        });
        return (Settings::default(), None, Some(error.to_string()));
    }
    let Some(content) = content else {
        return (Settings::default(), None, None);
    };
    let value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(error) => {
            load_error = Some(error.to_string());
            serde_json::Value::Null
        }
    };
    if let Some(message) = load_error {
        errors.push(SettingsError {
            scope,
            message: message.clone(),
        });
        return (Settings::default(), None, Some(message));
    }
    // Migrate the raw document, then load leniently.
    let migrated = match value {
        serde_json::Value::Object(mut map) => {
            migrate(&mut map);
            serde_json::Value::Object(map)
        }
        other => other,
    };
    (from_value_lenient(&migrated), Some(migrated), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::types::MarkdownSettings;

    #[test]
    fn in_memory_loads_merges_and_saves() {
        let mut manager = SettingsManager::in_memory(Settings::default());
        manager
            .set_default_model_and_provider("prime-inference".into(), "z-ai/glm-5.3".into())
            .unwrap();
        assert_eq!(manager.get_default_provider(), Some("prime-inference"));
        assert_eq!(manager.get_default_model(), Some("z-ai/glm-5.3"));
        assert_eq!(
            manager.get_recent_models(),
            vec!["prime-inference/z-ai/glm-5.3".to_string()]
        );
        manager.reload().unwrap();
        assert_eq!(manager.get_default_model(), Some("z-ai/glm-5.3"));
    }

    #[test]
    fn code_block_indent_reads_markdown_settings_with_ts_default() {
        // `markdown.codeBlockIndent` (TS getCodeBlockIndent): absent -> the
        // TS default two spaces; set -> the configured string.
        let manager = SettingsManager::in_memory(Settings::default());
        assert_eq!(manager.get_code_block_indent(), "  ");

        let settings = Settings {
            markdown: Some(MarkdownSettings {
                code_block_indent: Some("    ".to_string()),
                mermaid: None,
            }),
            ..Settings::default()
        };
        let manager = SettingsManager::in_memory(settings);
        assert_eq!(manager.get_code_block_indent(), "    ");
    }

    /// TS #2709: the Ctrl+O level persists as the global `chatDetail`
    /// setting — a later run reads it back — and anything but the three
    /// TS levels reads as the `details` startup default.
    #[test]
    fn chat_detail_persists_the_chosen_level_with_ts_fallback() {
        let mut manager = SettingsManager::in_memory(Settings::default());
        assert_eq!(manager.get_chat_detail(), "details");
        manager.set_chat_detail("all").unwrap();
        assert_eq!(manager.get_chat_detail(), "all");
        manager.reload().unwrap();
        assert_eq!(
            manager.get_chat_detail(),
            "all",
            "the saved level survives a reload (a later chat re-reads it)"
        );
        manager.set_chat_detail("verbose").unwrap();
        assert_eq!(
            manager.get_chat_detail(),
            "details",
            "an invalid value falls back to the TS startup default"
        );
    }

    /// The steering default is "all" (every queued steer co-delivers as
    /// ONE turn at the next tool-call boundary) with "one-at-a-time"
    /// selectable; the follow-up default stays "one-at-a-time".
    #[test]
    fn steering_mode_defaults_to_all_follow_ups_stay_one_at_a_time() {
        let mut manager = SettingsManager::in_memory(Settings::default());
        assert_eq!(manager.get_steering_mode(), QueueModeSetting::All);
        assert_eq!(manager.get_follow_up_mode(), QueueModeSetting::OneAtATime);
        manager
            .set_steering_mode(QueueModeSetting::OneAtATime)
            .unwrap();
        assert_eq!(
            manager.get_steering_mode(),
            QueueModeSetting::OneAtATime,
            "the explicit one-at-a-time setting still selects one-per-turn"
        );
    }

    #[test]
    fn migrations_apply_on_load() {
        let storage: Arc<dyn SettingsStorage> =
            Arc::new(super::super::storage::InMemorySettingsStorage::default());
        storage
            .with_lock(SettingsScope::Global, &mut |_| {
                Some(r#"{ "queueMode": "all", "telemetry": true }"#.into())
            })
            .unwrap();
        let manager = SettingsManager::from_storage(storage);
        assert_eq!(manager.get_steering_mode(), QueueModeSetting::All);
        assert!(manager.get_telemetry_enabled());
    }

    #[test]
    fn wrong_typed_fields_never_fail_load() {
        let storage: Arc<dyn SettingsStorage> =
            Arc::new(super::super::storage::InMemorySettingsStorage::default());
        storage
            .with_lock(SettingsScope::Global, &mut |_| {
                Some(r#"{ "defaultProvider": 42, "theme": "prime" }"#.into())
            })
            .unwrap();
        let manager = SettingsManager::from_storage(storage);
        assert_eq!(manager.get_default_provider(), None);
        assert_eq!(manager.get_theme(), Some("prime"));
    }

    #[test]
    fn idle_eviction_semantics() {
        let mut manager = SettingsManager::in_memory(Settings::default());
        assert_eq!(
            manager.get_idle_eviction(),
            IdleEviction::Minutes(DEFAULT_IDLE_EVICTION_MINUTES)
        );
        manager.global.idle_eviction_minutes = Some(serde_json::json!("off"));
        assert_eq!(manager.get_idle_eviction(), IdleEviction::Off);
        manager.global.idle_eviction_minutes = Some(serde_json::json!(0));
        assert_eq!(
            manager.get_idle_eviction(),
            IdleEviction::Minutes(DEFAULT_IDLE_EVICTION_MINUTES)
        );
        manager.global.idle_eviction_minutes = Some(serde_json::json!(45));
        assert_eq!(manager.get_idle_eviction(), IdleEviction::Minutes(45));
    }

    #[test]
    fn agent_traces_default_off_and_persist_the_opt_in() {
        // Unset means OFF (sharing is opt-in): the first-run onboarding
        // question is the opt-in moment, and the answer writes the
        // global scope and survives a reload.
        let mut manager = SettingsManager::in_memory(Settings::default());
        assert!(!manager.get_agent_traces_enabled());
        manager.set_agent_traces_enabled(true).unwrap();
        assert!(manager.get_agent_traces_enabled());
        manager.reload().unwrap();
        assert!(manager.get_agent_traces_enabled());
        manager.set_agent_traces_enabled(false).unwrap();
        assert!(!manager.get_agent_traces_enabled());
    }

    #[test]
    fn agent_traces_choice_written_marks_a_provisioned_home() {
        // The choice-written predicate separates a fresh home (nothing
        // written — the flow asks the question once) from a provisioned or
        // copied-config home (any standing choice — the flow completes
        // silently). Both answer values count: the predicate is about the
        // choice being made, not its direction.
        let mut manager = SettingsManager::in_memory(Settings::default());
        assert!(!manager.agent_traces_choice_written());
        manager.set_agent_traces_enabled(false).unwrap();
        assert!(manager.agent_traces_choice_written());
        manager.reload().unwrap();
        assert!(manager.agent_traces_choice_written());
        manager.set_agent_traces_enabled(true).unwrap();
        assert!(manager.agent_traces_choice_written());
    }

    #[test]
    fn compaction_toggle_defaults_on_and_persists() {
        // TS getCompactionEnabled: absent -> true (auto-compaction is on
        // until the user opts out); setCompactionEnabled writes the global
        // scope, so the value survives a reload (a restarted session
        // re-seeds its flag from it).
        let mut manager = SettingsManager::in_memory(Settings::default());
        assert!(manager.get_compaction_enabled());
        manager.set_compaction_enabled(false).unwrap();
        assert!(!manager.get_compaction_enabled());
        manager.reload().unwrap();
        assert!(!manager.get_compaction_enabled());
    }

    #[test]
    fn session_archive_policy_semantics() {
        // Absent keys: both rules on with their defaults.
        let mut manager = SettingsManager::in_memory(Settings::default());
        assert_eq!(
            manager.get_session_archive_policy(),
            SessionArchivePolicy {
                max_age_days: Some(DEFAULT_SESSION_ARCHIVE_MAX_AGE_DAYS),
                max_sessions: Some(DEFAULT_SESSION_ARCHIVE_MAX_SESSIONS),
            }
        );
        // "off"/"none" disable a rule; malformed values fall back to the
        // default (the `idleEvictionMinutes` grammar).
        manager.global.session_archive_max_age_days = Some(serde_json::json!("off"));
        assert_eq!(manager.get_session_archive_policy().max_age_days, None);
        manager.global.session_archive_max_age_days = Some(serde_json::json!(0));
        assert_eq!(
            manager.get_session_archive_policy().max_age_days,
            Some(DEFAULT_SESSION_ARCHIVE_MAX_AGE_DAYS)
        );
        manager.global.session_archive_max_age_days = Some(serde_json::json!(14));
        assert_eq!(manager.get_session_archive_policy().max_age_days, Some(14));
        manager.global.session_archive_max_sessions = Some(serde_json::json!("none"));
        assert_eq!(manager.get_session_archive_policy().max_sessions, None);
        manager.global.session_archive_max_sessions = Some(serde_json::json!(0));
        assert_eq!(manager.get_session_archive_policy().max_sessions, None);
        manager.global.session_archive_max_sessions = Some(serde_json::json!(50));
        assert_eq!(manager.get_session_archive_policy().max_sessions, Some(50));
    }
}
