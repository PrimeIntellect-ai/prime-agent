//! The client-settings seam. pa-tui depends on pa-types only, so the
//! interactive commands that read or persist user settings (`/settings`,
//! `/fullscreen`) call this trait; the composition
//! root (pa-cli) implements it over the real settings manager. Every
//! getter reads the effective settings with the TS default; every setter
//! persists the global scope (TS `markModified` + `save`).

use anyhow::Result;

pub trait ClientSettings: Send + Sync {
    /// `theme` (TS `getTheme`/`setTheme`).
    fn theme(&self) -> Option<String>;
    fn set_theme(&self, theme: &str) -> Result<()>;
    /// `terminal.fullscreen` (TS default true).
    fn fullscreen(&self) -> bool;
    fn set_fullscreen(&self, enabled: bool) -> Result<()>;
    /// `terminal.showImages` (TS default true).
    fn show_images(&self) -> bool;
    fn set_show_images(&self, enabled: bool) -> Result<()>;
    /// `terminal.clearOnShrink` (TS default false).
    fn clear_on_shrink(&self) -> bool;
    fn set_clear_on_shrink(&self, enabled: bool) -> Result<()>;
    /// `terminal.showTerminalProgress` (TS default false).
    fn show_terminal_progress(&self) -> bool;
    fn set_show_terminal_progress(&self, enabled: bool) -> Result<()>;
    /// `images.autoResize` (TS default true).
    fn image_auto_resize(&self) -> bool;
    fn set_image_auto_resize(&self, enabled: bool) -> Result<()>;
    /// `images.blockImages` (TS default false).
    fn block_images(&self) -> bool;
    fn set_block_images(&self, blocked: bool) -> Result<()>;
    /// `enableSkillCommands` (TS default true).
    fn enable_skill_commands(&self) -> bool;
    fn set_enable_skill_commands(&self, enabled: bool) -> Result<()>;
    /// `enableBuiltinSkills` (TS default true).
    fn enable_builtin_skills(&self) -> bool;
    fn set_enable_builtin_skills(&self, enabled: bool) -> Result<()>;
    /// `showHardwareCursor` (TS default false).
    fn show_hardware_cursor(&self) -> bool;
    fn set_show_hardware_cursor(&self, enabled: bool) -> Result<()>;
    /// `editorPaddingX` (TS default 0).
    fn editor_padding_x(&self) -> u64;
    fn set_editor_padding_x(&self, padding: u64) -> Result<()>;
    /// `autocompleteMaxVisible` (TS default 5).
    fn autocomplete_max_visible(&self) -> u64;
    fn set_autocomplete_max_visible(&self, max_visible: u64) -> Result<()>;
    /// `quietStartup` (TS default false).
    fn quiet_startup(&self) -> bool;
    fn set_quiet_startup(&self, quiet: bool) -> Result<()>;
    /// `idleEvictionMinutes` wire form (a number or `off`).
    fn idle_eviction_minutes(&self) -> String;
    fn set_idle_eviction_minutes(&self, value: &str) -> Result<()>;
    /// `markdown.mermaid` (`off`/`final`/`streaming`).
    fn mermaid_rendering_mode(&self) -> String;
    fn set_mermaid_rendering_mode(&self, mode: &str) -> Result<()>;
    /// `treeFilterMode` (`default`/`no-tools`/`user-only`/`labeled-only`/`all`).
    fn tree_filter_mode(&self) -> String;
    fn set_tree_filter_mode(&self, mode: &str) -> Result<()>;
    /// `warnings.anthropicExtraUsage` (TS default true).
    fn warnings_anthropic_extra_usage(&self) -> bool;
    fn set_warnings_anthropic_extra_usage(&self, enabled: bool) -> Result<()>;
    /// `updateChannel` (`stable`/`nightly`; unset infers the channel from
    /// the running version).
    fn update_channel(&self) -> Option<String>;
    fn set_update_channel(&self, channel: &str) -> Result<()>;
    /// The effective update channel for the running version (TS
    /// `resolveUpdateChannel(version, getUpdateChannel())`), as its wire
    /// name — pa-tui cannot reach the update flow's resolver, so the
    /// composition root resolves it (a preferred channel wins, else the
    /// version's prerelease infers).
    fn effective_update_channel(&self, version: &str) -> String;
}
