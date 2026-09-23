//! The interactive client-settings seam implementation: every call opens
//! the file-backed settings manager over the run's directories (the store
//! is a pair of small JSON files, so the re-read is the same freshness
//! the TS manager's `reload` produces) and applies the one setting.

use anyhow::Result;
use std::path::PathBuf;
use std::sync::Arc;

use pa_tui::client_settings::ClientSettings;

/// The seam handle the interactive run carries (TS injects the same
/// settings manager into the interactive mode).
#[derive(Clone)]
pub struct CliClientSettings {
    cwd: PathBuf,
    agent_dir: PathBuf,
}

impl CliClientSettings {
    pub fn new(cwd: PathBuf, agent_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self { cwd, agent_dir })
    }

    fn manager(&self) -> Result<pa_core::settings::SettingsManager> {
        Ok(pa_core::settings::SettingsManager::create(
            &self.cwd,
            &self.agent_dir,
        ))
    }
}

macro_rules! setting {
    ($get:ident, $set:ident, $getter:ident, $setter:ident, $ty:ty) => {
        fn $get(&self) -> $ty {
            match self.manager() {
                Ok(manager) => manager.$getter(),
                Err(_) => Default::default(),
            }
        }

        fn $set(&self, value: $ty) -> Result<()> {
            self.manager()?.$setter(value)
        }
    };
}

macro_rules! str_setting {
    ($get:ident, $set:ident, $getter:ident, $setter:ident) => {
        fn $get(&self) -> String {
            match self.manager() {
                Ok(manager) => manager.$getter().to_string(),
                Err(_) => String::new(),
            }
        }

        fn $set(&self, value: &str) -> Result<()> {
            self.manager()?.$setter(value)
        }
    };
}

impl ClientSettings for CliClientSettings {
    fn theme(&self) -> Option<String> {
        self.manager().ok()?.get_theme().map(str::to_string)
    }

    fn set_theme(&self, theme: &str) -> Result<()> {
        self.manager()?.set_theme(theme.to_string())
    }

    setting!(
        fullscreen,
        set_fullscreen,
        get_fullscreen,
        set_fullscreen,
        bool
    );
    setting!(
        show_images,
        set_show_images,
        get_show_images,
        set_show_images,
        bool
    );
    setting!(
        clear_on_shrink,
        set_clear_on_shrink,
        get_clear_on_shrink,
        set_clear_on_shrink,
        bool
    );
    setting!(
        show_terminal_progress,
        set_show_terminal_progress,
        get_show_terminal_progress,
        set_show_terminal_progress,
        bool
    );
    setting!(
        image_auto_resize,
        set_image_auto_resize,
        get_image_auto_resize,
        set_image_auto_resize,
        bool
    );
    setting!(
        block_images,
        set_block_images,
        get_block_images,
        set_block_images,
        bool
    );
    setting!(
        enable_skill_commands,
        set_enable_skill_commands,
        get_enable_skill_commands,
        set_enable_skill_commands,
        bool
    );
    setting!(
        enable_builtin_skills,
        set_enable_builtin_skills,
        get_enable_builtin_skills,
        set_enable_builtin_skills,
        bool
    );
    setting!(
        show_hardware_cursor,
        set_show_hardware_cursor,
        get_show_hardware_cursor,
        set_show_hardware_cursor,
        bool
    );
    setting!(
        editor_padding_x,
        set_editor_padding_x,
        get_editor_padding_x,
        set_editor_padding_x,
        u64
    );
    setting!(
        autocomplete_max_visible,
        set_autocomplete_max_visible,
        get_autocomplete_max_visible,
        set_autocomplete_max_visible,
        u64
    );
    setting!(
        quiet_startup,
        set_quiet_startup,
        get_quiet_startup,
        set_quiet_startup,
        bool
    );
    str_setting!(
        idle_eviction_minutes,
        set_idle_eviction_minutes,
        get_idle_eviction_minutes,
        set_idle_eviction_minutes
    );
    str_setting!(
        mermaid_rendering_mode,
        set_mermaid_rendering_mode,
        get_mermaid_rendering_mode,
        set_mermaid_rendering_mode
    );
    str_setting!(
        tree_filter_mode,
        set_tree_filter_mode,
        get_tree_filter_mode,
        set_tree_filter_mode
    );
    setting!(
        warnings_anthropic_extra_usage,
        set_warnings_anthropic_extra_usage,
        get_warnings_anthropic_extra_usage,
        set_warnings_anthropic_extra_usage,
        bool
    );

    /// `updateChannel`: the settings enum's wire value; unset reads as
    /// `None` (TS's global-only `getUpdateChannel`).
    fn update_channel(&self) -> Option<String> {
        let channel = self.manager().ok()?.get_update_channel()?;
        Some(
            match channel {
                pa_core::settings::types::UpdateChannel::Stable => "stable",
                pa_core::settings::types::UpdateChannel::Nightly => "nightly",
            }
            .to_string(),
        )
    }

    fn set_update_channel(&self, channel: &str) -> Result<()> {
        let channel = match channel {
            "stable" => pa_core::settings::types::UpdateChannel::Stable,
            "nightly" => pa_core::settings::types::UpdateChannel::Nightly,
            _ => anyhow::bail!("unknown update channel: {channel}"),
        };
        self.manager()?.set_update_channel(channel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The seam over the real settings store: every write persists through
    /// the pa-core manager and the next read (a fresh manager over the same
    /// dirs, exactly what every call does) sees it.
    #[test]
    fn seam_round_trips_through_the_settings_store() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let settings = CliClientSettings::new(dir.path().to_path_buf(), agent_dir.clone());

        // The TS defaults read first.
        assert!(settings.fullscreen());
        assert!(settings.show_images());
        assert!(!settings.quiet_startup());
        assert_eq!(settings.idle_eviction_minutes(), "90");
        assert_eq!(settings.mermaid_rendering_mode(), "streaming");
        assert_eq!(settings.tree_filter_mode(), "user-only");
        assert!(settings.warnings_anthropic_extra_usage());

        // Writes persist (the settings file lands in the agent dir).
        settings.set_fullscreen(false).expect("write");
        settings.set_theme("dark").expect("theme");
        settings.set_idle_eviction_minutes("off").expect("idle");
        settings.set_tree_filter_mode("all").expect("tree filter");
        settings.set_show_images(false).expect("show images");

        assert!(!settings.fullscreen());
        assert_eq!(settings.theme().as_deref(), Some("dark"));
        assert_eq!(settings.idle_eviction_minutes(), "off");
        assert_eq!(settings.tree_filter_mode(), "all");
        assert!(!settings.show_images());

        // The persisted file the real consumers read.
        let content =
            std::fs::read_to_string(agent_dir.join("settings.json")).expect("settings file");
        let value: serde_json::Value = serde_json::from_str(&content).expect("parse");
        assert_eq!(value["terminal"]["fullscreen"], false);
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["idleEvictionMinutes"], "off");
        assert_eq!(value["treeFilterMode"], "all");

        // The update channel starts unset (the version infers it) and
        // pins through the /nightly off path's seam.
        assert_eq!(settings.update_channel(), None);
        settings.set_update_channel("stable").expect("channel");
        assert_eq!(settings.update_channel().as_deref(), Some("stable"));
        let content =
            std::fs::read_to_string(agent_dir.join("settings.json")).expect("settings file");
        let value: serde_json::Value = serde_json::from_str(&content).expect("parse");
        assert_eq!(value["updateChannel"], "stable");
    }
}
