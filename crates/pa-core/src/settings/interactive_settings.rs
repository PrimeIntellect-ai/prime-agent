//! The interactive settings-menu accessors (TS settings-manager getters and
//! setters behind the `/settings` rows and `/fullscreen` persistence). Every
//! setter writes the global scope like the TS `markModified` + `save` pair;
//! every getter reads the merged effective settings with the TS defaults.

use anyhow::{anyhow, Result};

use super::manager::SettingsManager;

impl SettingsManager {
    /// `terminal.showImages` setter (the getter lives with the manager's
    /// startup accessors).
    pub fn set_show_images(&mut self, show: bool) -> Result<()> {
        self.global_mut()
            .terminal
            .get_or_insert_with(Default::default)
            .show_images = Some(show);
        self.save_global_scope()
    }

    /// `terminal.fullscreen` (TS `getFullscreen`/`setFullscreen`; the Rust
    /// surface always renders on the alternate screen, so the value is the
    /// persisted preference the startup surface would read).
    pub fn get_fullscreen(&self) -> bool {
        self.settings()
            .terminal
            .as_ref()
            .and_then(|terminal| terminal.fullscreen)
            .unwrap_or(true)
    }

    pub fn set_fullscreen(&mut self, enabled: bool) -> Result<()> {
        self.global_mut()
            .terminal
            .get_or_insert_with(Default::default)
            .fullscreen = Some(enabled);
        self.save_global_scope()
    }

    /// `terminal.clearOnShrink` (TS default: the `PI_CLEAR_ON_SHRINK`
    /// environment value; this port has no such override).
    pub fn get_clear_on_shrink(&self) -> bool {
        self.settings()
            .terminal
            .as_ref()
            .and_then(|terminal| terminal.clear_on_shrink)
            .unwrap_or(false)
    }

    pub fn set_clear_on_shrink(&mut self, enabled: bool) -> Result<()> {
        self.global_mut()
            .terminal
            .get_or_insert_with(Default::default)
            .clear_on_shrink = Some(enabled);
        self.save_global_scope()
    }

    /// `terminal.showTerminalProgress` (TS default false).
    pub fn get_show_terminal_progress(&self) -> bool {
        self.settings()
            .terminal
            .as_ref()
            .and_then(|terminal| terminal.show_terminal_progress)
            .unwrap_or(false)
    }

    pub fn set_show_terminal_progress(&mut self, enabled: bool) -> Result<()> {
        self.global_mut()
            .terminal
            .get_or_insert_with(Default::default)
            .show_terminal_progress = Some(enabled);
        self.save_global_scope()
    }

    /// `terminal.fullscreenMouse` setter (the getter lives with the mouse
    /// surface).
    pub fn set_fullscreen_mouse(&mut self, enabled: bool) -> Result<()> {
        self.global_mut()
            .terminal
            .get_or_insert_with(Default::default)
            .fullscreen_mouse = Some(enabled);
        self.save_global_scope()
    }

    /// `images.autoResize` (TS default true).
    pub fn get_image_auto_resize(&self) -> bool {
        self.settings()
            .images
            .as_ref()
            .and_then(|images| images.auto_resize)
            .unwrap_or(true)
    }

    pub fn set_image_auto_resize(&mut self, enabled: bool) -> Result<()> {
        self.global_mut()
            .images
            .get_or_insert_with(Default::default)
            .auto_resize = Some(enabled);
        self.save_global_scope()
    }

    /// `images.blockImages` (TS default false).
    pub fn get_block_images(&self) -> bool {
        self.settings()
            .images
            .as_ref()
            .and_then(|images| images.block_images)
            .unwrap_or(false)
    }

    pub fn set_block_images(&mut self, blocked: bool) -> Result<()> {
        self.global_mut()
            .images
            .get_or_insert_with(Default::default)
            .block_images = Some(blocked);
        self.save_global_scope()
    }

    /// `enableSkillCommands` (TS default true).
    pub fn get_enable_skill_commands(&self) -> bool {
        self.settings().enable_skill_commands.unwrap_or(true)
    }

    pub fn set_enable_skill_commands(&mut self, enabled: bool) -> Result<()> {
        self.global_mut().enable_skill_commands = Some(enabled);
        self.save_global_scope()
    }

    /// `enableBuiltinSkills` (TS default true).
    pub fn get_enable_builtin_skills(&self) -> bool {
        self.settings().enable_builtin_skills.unwrap_or(true)
    }

    pub fn set_enable_builtin_skills(&mut self, enabled: bool) -> Result<()> {
        self.global_mut().enable_builtin_skills = Some(enabled);
        self.save_global_scope()
    }

    /// `showHardwareCursor` (TS default false; the `PI_HARDWARE_CURSOR`
    /// override is not part of this port).
    pub fn get_show_hardware_cursor(&self) -> bool {
        self.settings().show_hardware_cursor.unwrap_or(false)
    }

    pub fn set_show_hardware_cursor(&mut self, enabled: bool) -> Result<()> {
        self.global_mut().show_hardware_cursor = Some(enabled);
        self.save_global_scope()
    }

    /// `editorPaddingX` (TS default 0, clamped 0-3).
    pub fn get_editor_padding_x(&self) -> u64 {
        self.settings().editor_padding_x.unwrap_or(0)
    }

    pub fn set_editor_padding_x(&mut self, padding: u64) -> Result<()> {
        self.global_mut().editor_padding_x = Some(padding.min(3));
        self.save_global_scope()
    }

    /// `autocompleteMaxVisible` (TS default 5, clamped 3-20).
    pub fn get_autocomplete_max_visible(&self) -> u64 {
        self.settings().autocomplete_max_visible.unwrap_or(5)
    }

    pub fn set_autocomplete_max_visible(&mut self, max_visible: u64) -> Result<()> {
        self.global_mut().autocomplete_max_visible = Some(max_visible.clamp(3, 20));
        self.save_global_scope()
    }

    /// `quietStartup` (TS default false).
    pub fn get_quiet_startup(&self) -> bool {
        self.settings().quiet_startup.unwrap_or(false)
    }

    pub fn set_quiet_startup(&mut self, quiet: bool) -> Result<()> {
        self.global_mut().quiet_startup = Some(quiet);
        self.save_global_scope()
    }

    /// `idleEvictionMinutes` (TS `number | "off"`; a `none` value or an
    /// invalid number falls back to the default like the TS getter).
    pub fn get_idle_eviction_minutes(&self) -> String {
        match self.settings().idle_eviction_minutes.as_ref() {
            Some(value) if value.as_str() == Some("off") || value.as_str() == Some("none") => {
                "off".to_string()
            }
            Some(value) => match value.as_f64() {
                Some(number) if number.is_finite() && number > 0.0 => {
                    let rounded = number.round();
                    if (number - rounded).abs() < f64::EPSILON {
                        format!("{rounded:.0}")
                    } else {
                        format!("{number}")
                    }
                }
                _ => super::manager::DEFAULT_IDLE_EVICTION_MINUTES.to_string(),
            },
            None => super::manager::DEFAULT_IDLE_EVICTION_MINUTES.to_string(),
        }
    }

    /// TS `setIdleEvictionMinutes`: a positive number or `"off"`.
    pub fn set_idle_eviction_minutes(&mut self, value: &str) -> Result<()> {
        if value == "off" {
            self.global_mut().idle_eviction_minutes = Some(serde_json::json!("off"));
            return self.save_global_scope();
        }
        let number: f64 = value
            .parse()
            .map_err(|_| anyhow!("Idle eviction minutes must be a positive number or off"))?;
        if !number.is_finite() || number <= 0.0 {
            return Err(anyhow!(
                "Idle eviction minutes must be a positive number or off"
            ));
        }
        self.global_mut().idle_eviction_minutes = Some(serde_json::json!(number));
        self.save_global_scope()
    }

    /// `markdown.mermaid` (TS default `streaming`; only `off` and `final`
    /// are recognized).
    pub fn get_mermaid_rendering_mode(&self) -> &'static str {
        match self
            .settings()
            .markdown
            .as_ref()
            .and_then(|markdown| markdown.mermaid)
        {
            Some(super::types::MermaidRenderingMode::Off) => "off",
            Some(super::types::MermaidRenderingMode::Final) => "final",
            _ => "streaming",
        }
    }

    pub fn set_mermaid_rendering_mode(&mut self, mode: &str) -> Result<()> {
        let parsed = match mode {
            "off" => super::types::MermaidRenderingMode::Off,
            "final" => super::types::MermaidRenderingMode::Final,
            "streaming" => super::types::MermaidRenderingMode::Streaming,
            other => return Err(anyhow!("Unknown mermaid rendering mode: {other}")),
        };
        self.global_mut()
            .markdown
            .get_or_insert_with(Default::default)
            .mermaid = Some(parsed);
        self.save_global_scope()
    }

    /// `warnings` (TS `WarningSettings`; a missing document is all-default,
    /// and `anthropicExtraUsage` defaults true).
    pub fn get_warnings_anthropic_extra_usage(&self) -> bool {
        self.settings()
            .warnings
            .as_ref()
            .and_then(|warnings| warnings.anthropic_extra_usage)
            .unwrap_or(true)
    }

    pub fn set_warnings_anthropic_extra_usage(&mut self, enabled: bool) -> Result<()> {
        self.global_mut()
            .warnings
            .get_or_insert_with(Default::default)
            .anthropic_extra_usage = Some(enabled);
        self.save_global_scope()
    }

    /// `treeFilterMode` setter (the getter lives with the manager's
    /// startup accessors); TS `setTreeFilterMode` writes the global scope.
    pub fn set_tree_filter_mode(&mut self, mode: &str) -> Result<()> {
        self.global_mut().tree_filter_mode = Some(mode.to_string());
        self.save_global_scope()
    }

    /// `enabledModels` (TS `getEnabledModels`/`setEnabledModels`): the
    /// persisted model-scope patterns the scoped-models selector saves.
    pub fn get_enabled_models(&self) -> Option<Vec<String>> {
        self.settings().enabled_models.clone()
    }

    pub fn set_enabled_models(&mut self, models: Option<Vec<String>>) -> Result<()> {
        self.global_mut().enabled_models = models;
        self.save_global_scope()
    }
}
