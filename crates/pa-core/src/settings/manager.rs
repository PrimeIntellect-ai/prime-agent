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
    /// The raw global document (parsed JSON before the lenient load): the allowlist
    /// gate distinguishes an ABSENT `allowedModels` key (unrestricted) from a
    /// PRESENT-but-malformed one (fails closed); typed `Settings` drops both to `None`.
    global_raw: Option<serde_json::Value>,
    /// Load failures per scope; a scope whose file failed to parse is never written back.
    global_load_error: Option<String>,
    project_load_error: Option<String>,
}

impl SettingsManager {
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

    /// A new manager over the same settings store (a fresh read; the
    /// runtime overrides carry over), for long-lived readers such as the
    /// telemetry switch.
    #[must_use]
    pub fn reopen(&self) -> Self {
        let mut fresh = Self::from_storage(Arc::clone(&self.storage));
        fresh.apply_overrides(&self.runtime_overrides);
        fresh
    }

    /// In-memory manager (tests, embedded hosts).
    #[must_use]
    pub fn in_memory(initial: &Settings) -> Self {
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

    #[must_use]
    pub fn settings(&self) -> &Settings {
        &self.merged
    }

    #[must_use]
    pub fn global_settings(&self) -> &Settings {
        &self.global
    }

    /// The raw global document (post-migration, pre-lenient-load value);
    /// `None` when the scope has no document or it failed to parse.
    #[must_use]
    pub fn global_raw(&self) -> Option<&serde_json::Value> {
        self.global_raw.as_ref()
    }

    #[must_use]
    pub fn project_settings(&self) -> &Settings {
        &self.project
    }

    #[must_use]
    pub fn errors(&self) -> &[SettingsError] {
        &self.errors
    }

    /// Take and clear the recorded settings errors (warnings are printed once
    /// by the CLI commands that surface them).
    pub fn drain_errors(&mut self) -> Vec<SettingsError> {
        std::mem::take(&mut self.errors)
    }

    /// # Errors
    ///
    /// Never returns `Err`; load problems are recorded as load errors on
    /// the manager instead.
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

    /// Mutable global settings for the setters in sibling modules.
    pub(crate) fn global_mut(&mut self) -> &mut Settings {
        &mut self.global
    }

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub(crate) fn save_global_scope(&mut self) -> Result<()> {
        self.save_global()
    }

    // -- persisted setters --------------------------------------------------

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_default_provider(&mut self, provider: String) -> Result<()> {
        self.global.default_provider = Some(provider);
        self.save_global()
    }

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_default_model(&mut self, model: String) -> Result<()> {
        self.global.default_model = Some(model);
        self.save_global()
    }

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_default_model_and_provider(&mut self, provider: &str, model: &str) -> Result<()> {
        self.global.default_provider = Some(provider.to_string());
        self.global.default_model = Some(model.to_string());
        self.record_model_use(provider, model);
        self.save_global()
    }

    /// `markdown.codeBlockIndent`: the string the chat markdown renderer
    /// indents fenced code blocks by (TS default: two spaces).
    #[must_use]
    pub fn get_code_block_indent(&self) -> String {
        self.settings()
            .markdown
            .as_ref()
            .and_then(|markdown| markdown.code_block_indent.clone())
            .unwrap_or_else(|| "  ".to_string())
    }

    /// `terminal.fullscreenMouse`: whether the fullscreen transcript
    /// surface enables mouse tracking and wheel scrolling.
    #[must_use]
    pub fn get_fullscreen_mouse(&self) -> bool {
        self.settings()
            .terminal
            .as_ref()
            .and_then(|terminal| terminal.fullscreen_mouse)
            .unwrap_or(true)
    }

    /// `terminal.showImages`: whether image blocks in tool results render
    /// their type/dimension metadata rows (TS default: true).
    #[must_use]
    pub fn get_show_images(&self) -> bool {
        self.settings()
            .terminal
            .as_ref()
            .and_then(|terminal| terminal.show_images)
            .unwrap_or(true)
    }

    /// `treeFilterMode`: the `/tree` selector's initial filter; an unset
    /// or invalid value falls back to `user-only` (the TS default).
    #[must_use]
    pub fn get_tree_filter_mode(&self) -> String {
        let mode = self.settings().tree_filter_mode.clone().unwrap_or_default();
        let valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
        if valid.contains(&mode.as_str()) && !mode.is_empty() {
            mode
        } else {
            "user-only".to_string()
        }
    }

    /// `chatDetail`: the conversation-detail level the chat starts at; an unset or
    /// invalid value falls back to `overview` (operator directive 2026-09-28).
    #[must_use]
    pub fn get_chat_detail(&self) -> String {
        match self.settings().chat_detail.as_deref() {
            Some("details") => "details",
            Some("all") => "all",
            _ => "overview",
        }
        .to_string()
    }

    #[must_use]
    pub fn get_branch_summary_skip_prompt(&self) -> bool {
        self.settings()
            .branch_summary
            .as_ref()
            .and_then(|branch_summary| branch_summary.skip_prompt)
            .unwrap_or(false)
    }

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

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_steering_mode(&mut self, mode: QueueModeSetting) -> Result<()> {
        self.global.steering_mode = Some(mode);
        self.save_global()
    }

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_follow_up_mode(&mut self, mode: QueueModeSetting) -> Result<()> {
        self.global.follow_up_mode = Some(mode);
        self.save_global()
    }

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_theme(&mut self, theme: String) -> Result<()> {
        self.global.theme = Some(theme);
        self.save_global()
    }

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_update_channel(&mut self, channel: UpdateChannel) -> Result<()> {
        self.global.update_channel = Some(channel);
        self.save_global()
    }

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_default_thinking_level(&mut self, level: ThinkingLevelSetting) -> Result<()> {
        self.global.default_thinking_level = Some(level);
        self.save_global()
    }

    /// The auto-retry toggle (`retry.enabled`).
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

    /// The auto-compaction toggle (`compaction.enabled`): a daemon restart re-seeds
    /// the connection state's flag from the persisted setting.
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

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_transport(&mut self, transport: TransportSetting) -> Result<()> {
        self.global.transport = Some(transport);
        self.save_global()
    }

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_rlm_max_depth(&mut self, depth: u64) -> Result<()> {
        self.global.rlm_max_depth = Some(depth);
        self.save_global()
    }

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_telemetry_enabled(&mut self, enabled: bool) -> Result<()> {
        let telemetry = self.global.telemetry.get_or_insert_with(Default::default);
        telemetry.enabled = Some(enabled);
        self.save_global()
    }

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_telemetry_notice_shown(&mut self, shown: bool) -> Result<()> {
        let telemetry = self.global.telemetry.get_or_insert_with(Default::default);
        telemetry.notice_shown = Some(shown);
        self.save_global()
    }

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_onboarding_shown(&mut self, shown: bool) -> Result<()> {
        self.global.onboarding_shown = Some(shown);
        self.save_global()
    }

    /// # Errors
    ///
    /// Returns an error when the global settings file cannot be written.
    pub fn set_onboarding_completed(&mut self, completed: bool) -> Result<()> {
        self.global.onboarding_completed = Some(completed);
        self.save_global()
    }

    /// The shown flag with the legacy completed flag as fallback.
    #[must_use]
    pub fn get_onboarding_shown(&self) -> bool {
        self.merged
            .onboarding_shown
            .or(self.merged.onboarding_completed)
            .unwrap_or(false)
    }

    /// The auto-compaction toggle, on until the user opts out.
    #[must_use]
    pub fn get_compaction_enabled(&self) -> bool {
        self.merged
            .compaction
            .as_ref()
            .and_then(|compaction| compaction.enabled)
            .unwrap_or(true)
    }

    /// `agentTraces.enabled`: unset means OFF — trace sharing is opt-in, exactly the TS default.
    #[must_use]
    pub fn get_agent_traces_enabled(&self) -> bool {
        self.merged
            .agent_traces
            .as_ref()
            .and_then(|traces| traces.enabled)
            .unwrap_or(false)
    }

    /// Whether a trace-sharing choice was ever written: the `agentTraces.enabled` key
    /// present in the merged settings. Only a fresh home (no choice written) is asked, once.
    #[must_use]
    pub fn agent_traces_choice_written(&self) -> bool {
        self.merged
            .agent_traces
            .as_ref()
            .and_then(|traces| traces.enabled)
            .is_some()
    }

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

    pub fn set_packages(&mut self, packages: Vec<serde_json::Value>) {
        self.global.packages = Some(packages.clone());
        self.persist_scope_field(
            SettingsScope::Global,
            "packages",
            &serde_json::Value::Array(packages),
        );
        self.merged = deep_merge(&self.global, &self.project);
    }

    pub fn set_project_packages(&mut self, packages: Vec<serde_json::Value>) {
        self.project.packages = Some(packages.clone());
        self.persist_scope_field(
            SettingsScope::Project,
            "packages",
            &serde_json::Value::Array(packages),
        );
        self.merged = deep_merge(&self.global, &self.project);
    }

    /// Replace one resource-path array (`skills`/`prompts`/`themes`) in the global settings file.
    pub fn set_global_resource_array(&mut self, field: &str, values: Vec<String>) {
        let array: Vec<serde_json::Value> =
            values.into_iter().map(serde_json::Value::String).collect();
        match field {
            "skills" => self.global.skills = Some(strings(&array)),
            "prompts" => self.global.prompts = Some(strings(&array)),
            "themes" => self.global.themes = Some(strings(&array)),
            _ => return,
        }
        self.persist_scope_field(
            SettingsScope::Global,
            field,
            &serde_json::Value::Array(array),
        );
        self.merged = deep_merge(&self.global, &self.project);
    }

    /// Replace one resource-path array in the project settings file.
    pub fn set_project_resource_array(&mut self, field: &str, values: Vec<String>) {
        let array: Vec<serde_json::Value> =
            values.into_iter().map(serde_json::Value::String).collect();
        match field {
            "skills" => self.project.skills = Some(strings(&array)),
            "prompts" => self.project.prompts = Some(strings(&array)),
            "themes" => self.project.themes = Some(strings(&array)),
            _ => return,
        }
        self.persist_scope_field(
            SettingsScope::Project,
            field,
            &serde_json::Value::Array(array),
        );
        self.merged = deep_merge(&self.global, &self.project);
    }

    /// Write one field into a scope's file, merging with the current on-disk document
    /// so concurrently-added fields survive; failures are recorded as warnings, never thrown.
    fn persist_scope_field(
        &mut self,
        scope: SettingsScope,
        field: &str,
        value: &serde_json::Value,
    ) {
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

    #[must_use]
    pub fn get_default_provider(&self) -> Option<&str> {
        self.merged.default_provider.as_deref()
    }

    #[must_use]
    pub fn get_default_model(&self) -> Option<&str> {
        self.merged.default_model.as_deref()
    }

    /// Model for `rlm.spawn` without a pinned model; unset inherits parent.
    #[must_use]
    pub fn get_subagent_default_model(&self) -> Option<String> {
        self.merged
            .subagent_default_model
            .as_ref()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
    }

    #[must_use]
    pub fn get_auxiliary_model(&self) -> Option<&str> {
        self.merged.auxiliary_model.as_deref()
    }

    /// The "provider/model-id" (or bare id) reference serving image turns on models
    /// without image input; malformed values behave as unset and the refusal names the setting.
    #[must_use]
    pub fn get_image_model(&self) -> Option<String> {
        self.merged
            .image_model
            .as_ref()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
    }

    /// The daemon-level model allowlist (settings `allowedModels`), enforced at every
    /// daemon model resolution — a model outside fails loudly, never a fallback.
    /// Rust-only guardrail; `None` is unrestricted; global scope only, so a project
    /// cannot weaken a box-level pin; a list that trims to empty behaves as unset.
    #[must_use]
    pub fn get_allowed_models(&self) -> Option<Vec<String>> {
        let patterns = self.global.allowed_models.as_ref()?;
        let patterns: Vec<String> = patterns
            .iter()
            .map(|pattern| pattern.trim().to_string())
            .filter(|pattern| !pattern.is_empty())
            .collect();
        (!patterns.is_empty()).then_some(patterns)
    }

    /// The persisted default a fresh session starts from; the stored
    /// string is the same vocabulary `get_default_service_tier` parses.
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

    /// Service tier a fresh session records as its preference.
    /// An unrecognized setting value falls back to the same `default`.
    #[must_use]
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

    #[must_use]
    pub fn get_recent_models(&self) -> Vec<String> {
        self.merged.recent_models.clone().unwrap_or_default()
    }

    /// The steering queue's delivery mode: `all` co-delivers every queued message at
    /// the next turn boundary; `one-at-a-time` delivers one per turn.
    #[must_use]
    pub fn get_steering_mode(&self) -> QueueModeSetting {
        self.merged.steering_mode.unwrap_or(QueueModeSetting::All)
    }

    #[must_use]
    pub fn get_follow_up_mode(&self) -> QueueModeSetting {
        self.merged
            .follow_up_mode
            .unwrap_or(QueueModeSetting::OneAtATime)
    }

    #[must_use]
    pub fn get_theme(&self) -> Option<&str> {
        self.merged.theme.as_deref()
    }

    /// Global-only read of the two known values; anything else is unset.
    #[must_use]
    pub fn get_update_channel(&self) -> Option<UpdateChannel> {
        self.global.update_channel
    }

    #[must_use]
    pub fn get_default_thinking_level(&self) -> Option<ThinkingLevelSetting> {
        self.merged.default_thinking_level
    }

    /// The shared provider retry policy from settings.
    #[must_use]
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
                    |retries| retries.min(u64::from(u32::MAX)) as u32,
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
    #[must_use]
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
                    retries.min(u64::from(u32::MAX)) as u32
                }),
            base_delay_ms: failover
                .and_then(|failover| failover.base_delay_ms)
                .unwrap_or(defaults.base_delay_ms),
            max_delay_ms: failover
                .and_then(|failover| failover.max_delay_ms)
                .unwrap_or(defaults.max_delay_ms),
        }
    }

    /// The quota-park policy from settings (`retry.provider.waitForUsage`): the
    /// park toggle, per-park ceiling (clamped to one week), and per-episode budget.
    #[must_use]
    pub fn get_provider_park_policy(
        &self,
    ) -> crate::session_engine::provider_park::ProviderParkPolicy {
        let defaults = crate::session_engine::provider_park::DEFAULT_PROVIDER_PARK_POLICY;
        let wait = self
            .merged
            .retry
            .as_ref()
            .and_then(|retry| retry.provider.as_ref())
            .and_then(|provider| provider.wait_for_usage.as_ref());
        crate::session_engine::provider_park::ProviderParkPolicy {
            pause_until_reset: wait
                .and_then(|wait| wait.pause_until_reset)
                .unwrap_or(defaults.pause_until_reset),
            max_pause_ms: wait
                .and_then(|wait| wait.max_pause_ms)
                .unwrap_or(defaults.max_pause_ms),
            max_parks: wait
                .and_then(|wait| wait.max_parks)
                .map_or(defaults.max_parks, |parks| {
                    parks.min(u64::from(u32::MAX)) as u32
                }),
        }
    }

    #[must_use]
    pub fn get_rlm_max_depth(&self) -> Option<u64> {
        self.global.rlm_max_depth
    }

    /// The daemon mesh listener's TCP port (global scope only, TS #2517):
    /// an integer between 1 and 65535, else unset.
    #[must_use]
    pub fn get_daemon_port(&self) -> Option<u16> {
        self.global
            .daemon_port
            .filter(|port| (1..=u64::from(u16::MAX)).contains(port))
            .map(|port| port as u16)
    }

    /// The daemon mesh listener's bind host (global scope only, TS #2517):
    /// a non-empty trimmed string, else unset.
    #[must_use]
    pub fn get_daemon_tcp_bind_host(&self) -> Option<String> {
        self.global
            .daemon_tcp_bind_host
            .as_deref()
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .map(str::to_string)
    }

    /// `number | "off" | "none"` -> finite minutes or Off; malformed falls
    /// back to the default (90).
    #[must_use]
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

    /// Resolved session-archiving policy: both rules are independent — a session is
    /// archived when EITHER fires; `None` on a field disables that rule.
    #[must_use]
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

    #[must_use]
    pub fn get_transport(&self) -> TransportSetting {
        self.merged.transport.unwrap_or(TransportSetting::Auto)
    }

    /// `telemetry.enabled` when any scope sets it (`None`: nothing set, the
    /// default-on posture), resolved like [`Self::get_telemetry_enabled`].
    #[must_use]
    pub fn telemetry_enabled_setting(&self) -> Option<bool> {
        let set = [
            self.global.telemetry.as_ref(),
            self.project.telemetry.as_ref(),
            self.runtime_overrides.telemetry.as_ref(),
        ]
        .iter()
        .any(|scope| scope.and_then(|t| t.enabled).is_some());
        set.then(|| self.get_telemetry_enabled())
    }

    /// Telemetry is enabled only when every scope says so (default true).
    #[must_use]
    pub fn get_telemetry_enabled(&self) -> bool {
        [
            self.global.telemetry.as_ref(),
            self.project.telemetry.as_ref(),
            self.runtime_overrides.telemetry.as_ref(),
        ]
        .iter()
        .all(|scope| scope.and_then(|t| t.enabled).unwrap_or(true))
    }

    #[must_use]
    pub fn get_telemetry_notice_shown(&self) -> bool {
        self.runtime_overrides
            .telemetry
            .as_ref()
            .and_then(|t| t.notice_shown)
            .or_else(|| self.global.telemetry.as_ref().and_then(|t| t.notice_shown))
            .unwrap_or(false)
    }

    /// `requestTiming`: unset means OFF — the per-request timing timeline
    /// is opt-in, exactly the TS default.
    #[must_use]
    pub fn get_request_timing(&self) -> bool {
        self.merged.request_timing.unwrap_or(false)
    }

    #[must_use]
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
    /// user-set), then re-derive the effective settings.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleEviction {
    Minutes(u64),
    Off,
}

/// Resolved session-archiving settings: the age rule (sessions untouched for
/// `max_age_days` days) and the count rule (keep the newest `max_sessions`).
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

/// One loaded scope: the leniently-parsed settings, the migrated raw document,
/// and the load error (`Some` when the document exists but cannot be read/parsed).
#[allow(clippy::type_complexity)]
fn load_scope(
    storage: &dyn SettingsStorage,
    scope: SettingsScope,
    errors: &mut Vec<SettingsError>,
) -> (Settings, Option<serde_json::Value>, Option<String>) {
    let mut load_error: Option<String> = None;
    // The pure-read arm: a locked protocol read on any cache miss, the
    // process-cached copy on a hit (see `SettingsStorage::read`).
    let content = match storage.read(scope) {
        Ok(content) => content,
        Err(error) => {
            let message = error.to_string();
            errors.push(SettingsError {
                scope,
                message: message.clone(),
            });
            return (Settings::default(), None, Some(message));
        }
    };
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
        let mut manager = SettingsManager::in_memory(&Settings::default());
        manager
            .set_default_model_and_provider("prime-inference", "z-ai/glm-5.3")
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

    /// `factory.enabled` reads the GLOBAL scope only (the agent-dir
    /// document the kernel's factory gate and `set_factory_enabled` use):
    /// a project-scope override can never flip the gate out from under the
    /// kernel — a project `.prime/agent/settings.json` with `enabled: true`
    /// leaves the factory disabled while the global setting says nothing
    /// (Macroscope review finding: the merged read could diverge the
    /// daemon's lane advertisement and the client's `/factory status`
    /// from what the kernel would do).
    #[test]
    fn factory_enabled_reads_the_global_scope_only() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(cwd.join(".prime/agent")).unwrap();
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            cwd.join(".prime/agent/settings.json"),
            r#"{ "factory": { "enabled": true } }"#,
        )
        .unwrap();

        let mut manager = SettingsManager::create(&cwd, &agent_dir);
        assert!(
            !manager.get_factory_enabled(),
            "a project-scope override never enables the gate"
        );

        manager
            .set_factory_enabled(true)
            .expect("set factory enabled");
        assert!(manager.get_factory_enabled());
        let content =
            std::fs::read_to_string(agent_dir.join("settings.json")).expect("global file");
        assert!(
            content.contains(r#""enabled": true"#),
            "the write lands in the global document the kernel gate reads: {content}"
        );

        manager
            .set_factory_enabled(false)
            .expect("set factory disabled");
        assert!(!manager.get_factory_enabled());
    }

    #[test]
    fn reopen_keeps_the_runtime_overrides_in_the_merged_settings() {
        let mut manager = SettingsManager::in_memory(&Settings::default());
        manager.apply_overrides(&Settings {
            markdown: Some(MarkdownSettings {
                code_block_indent: Some("    ".to_string()),
                mermaid: None,
            }),
            ..Settings::default()
        });
        assert_eq!(manager.reopen().get_code_block_indent(), "    ");
    }

    #[test]
    fn code_block_indent_reads_markdown_settings_with_ts_default() {
        let manager = SettingsManager::in_memory(&Settings::default());
        assert_eq!(manager.get_code_block_indent(), "  ");

        let settings = Settings {
            markdown: Some(MarkdownSettings {
                code_block_indent: Some("    ".to_string()),
                mermaid: None,
            }),
            ..Settings::default()
        };
        let manager = SettingsManager::in_memory(&settings);
        assert_eq!(manager.get_code_block_indent(), "    ");
    }

    #[test]
    fn chat_detail_persists_the_chosen_level_with_the_startup_fallback() {
        let mut manager = SettingsManager::in_memory(&Settings::default());
        assert_eq!(manager.get_chat_detail(), "overview");
        manager.set_chat_detail("all").unwrap();
        assert_eq!(manager.get_chat_detail(), "all");
        manager.reload().unwrap();
        assert_eq!(
            manager.get_chat_detail(),
            "all",
            "the saved level survives a reload (a later chat re-reads it)"
        );
        manager.set_chat_detail("details").unwrap();
        assert_eq!(
            manager.get_chat_detail(),
            "details",
            "a saved details level reads back exactly (the Ctrl+O thinking reveal persists)"
        );
        manager.set_chat_detail("verbose").unwrap();
        assert_eq!(
            manager.get_chat_detail(),
            "overview",
            "an invalid value falls back to the startup default"
        );
    }

    #[test]
    fn steering_mode_defaults_to_all_follow_ups_stay_one_at_a_time() {
        let mut manager = SettingsManager::in_memory(&Settings::default());
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
        let mut manager = SettingsManager::in_memory(&Settings::default());
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
        let mut manager = SettingsManager::in_memory(&Settings::default());
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
        let mut manager = SettingsManager::in_memory(&Settings::default());
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
        let mut manager = SettingsManager::in_memory(&Settings::default());
        assert!(manager.get_compaction_enabled());
        manager.set_compaction_enabled(false).unwrap();
        assert!(!manager.get_compaction_enabled());
        manager.reload().unwrap();
        assert!(!manager.get_compaction_enabled());
    }

    #[test]
    fn session_archive_policy_semantics() {
        let mut manager = SettingsManager::in_memory(&Settings::default());
        assert_eq!(
            manager.get_session_archive_policy(),
            SessionArchivePolicy {
                max_age_days: Some(DEFAULT_SESSION_ARCHIVE_MAX_AGE_DAYS),
                max_sessions: Some(DEFAULT_SESSION_ARCHIVE_MAX_SESSIONS),
            }
        );
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

    #[test]
    fn image_model_reads_trimmed_or_unset() {
        let manager = SettingsManager::in_memory(&Settings {
            image_model: Some("  battery/mock-vision  ".to_string()),
            ..Settings::default()
        });
        assert_eq!(
            manager.get_image_model().as_deref(),
            Some("battery/mock-vision")
        );
        let manager = SettingsManager::in_memory(&Settings {
            image_model: Some("   ".to_string()),
            ..Settings::default()
        });
        assert_eq!(manager.get_image_model(), None);
        let manager = SettingsManager::in_memory(&Settings::default());
        assert_eq!(manager.get_image_model(), None);
    }
    /// TS #2517's daemon mesh listener settings: the global `daemonPort`
    /// reads back as a port only in 1..=65535, and `daemonTcpBindHost`
    /// reads back trimmed; the project and runtime scopes never provide
    /// them (the listener policy is global-scope only).
    #[test]
    fn daemon_tcp_listener_settings_read_from_the_global_scope() {
        let settings = Settings {
            daemon_port: Some(4700),
            daemon_tcp_bind_host: Some("  100.64.1.2  ".to_string()),
            ..Settings::default()
        };
        let manager = SettingsManager::in_memory(&settings);
        assert_eq!(manager.get_daemon_port(), Some(4700));
        assert_eq!(
            manager.get_daemon_tcp_bind_host().as_deref(),
            Some("100.64.1.2")
        );

        // Out-of-range and malformed values read as unset (the supervisor
        // refuses to start the listener on an invalid port from the env,
        // but a bad settings value simply disables it).
        let settings = Settings {
            daemon_port: Some(0),
            daemon_tcp_bind_host: Some("   ".to_string()),
            ..Settings::default()
        };
        let manager = SettingsManager::in_memory(&settings);
        assert_eq!(manager.get_daemon_port(), None);
        assert_eq!(manager.get_daemon_tcp_bind_host(), None);
    }
}
