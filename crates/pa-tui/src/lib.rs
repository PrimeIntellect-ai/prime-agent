//! Terminal UI for Prime Agent.
//!
//! Rust port of the TS reference TUI (packages/tui) plus the interactive agent view
//! from `coding-agent/src/modes/interactive`. Components render styled lines;
//! the terminal layer paints them with crossterm + ratatui diffing.
// Pedantic-gate exceptions (every other pedantic warning in this crate is
// fixed in place; each exception carries its one-line justification):
// - the casts: terminal-layout arithmetic narrows structurally bounded
//   values (screen coordinates, byte counts, timestamps); guarded
//   conversions would add panic paths the bounds guarantee away.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// - the render routes are flat tables (one arm per route); splitting them
//   would add indirection without changing the flow.
#![allow(clippy::too_many_lines)]
// - widget state structs carry independent flag bits; a nested struct
//   would add indirection without changing the shape.
#![allow(clippy::struct_excessive_bools, clippy::fn_params_excessive_bools)]
// - the futures are bounded by the surface's lifetime; boxing them would
//   add an allocation to the steady-state loop.
#![allow(clippy::large_futures)]
// - the wrappers preserve a uniform Result-returning API surface; unwrap
//   removals would ripple through the callers without changing behavior.
#![allow(clippy::unnecessary_wraps)]

pub mod agents_view;
pub mod agents_view_forest;
pub mod agents_view_search;
pub mod agents_view_state;
pub mod altscreen;
pub mod ansi;
pub mod app;
pub mod auth_panel;
pub mod autocomplete;
mod autolink;
pub mod bash_bang;
pub mod bash_card;
pub mod bash_view;
pub(crate) mod branch;
pub(crate) mod browser;
pub mod chat;
pub mod chat_slash;
pub mod chrome;
mod click_dispatch;
pub mod client_auth;
pub mod client_settings;
mod clipboard;
mod clipboard_image;
pub mod code_preview;
mod compaction_row;
pub mod config_selector;
pub mod confirm;
pub mod custom_message;
pub mod daemon_client;
pub mod daemon_reconnect;
pub mod direct_transport;
pub mod editor;
pub mod effort_picker;
mod enhanced_keys;
pub mod error_summary;
pub mod exit_guard;
pub(crate) mod exit_restore;
pub mod export_share;
mod external_editor;
pub mod factory_view;
pub mod fuzzy;
pub mod goal_surface;
pub mod heartbeats_picker;
pub mod hotkeys;
pub mod hyperlinks;
mod image_component;
pub mod image_load;
mod image_markers;
pub mod incident_notices;
pub mod info_commands;
pub mod info_panel;
mod input;
pub mod interactive;
pub mod keybindings;
pub mod keys;
pub mod markdown;
pub mod markdown_table;
pub mod mcp_view;
mod menu_panel;
pub mod model_picker;
pub(crate) mod mouse;
pub(crate) mod mouse_tracking;
pub mod onboarding;
pub mod onboarding_choice;
pub mod onboarding_flow;
pub mod osc133;
pub mod osc52;
pub(crate) mod prompt_highlight;
pub mod prompt_stash;
pub mod provider_auth;
pub mod queued;
pub(crate) mod search_input;
pub mod selection;
mod sequence_guard;
pub mod session;
pub mod session_open_error;
pub mod session_ui;
pub mod settings_menu;
pub mod side_question;
pub mod snapshot;
pub mod subagents;
mod suspend;
mod terminal_image;
pub mod theme;
pub mod toast;
pub mod tool_card;
pub mod traces;
pub mod tree_display;
pub mod tree_list;
pub mod tree_nodes;
pub mod tree_selector;
pub mod update_command;
pub(crate) mod update_restart_wait;
pub mod user_message_selector;
pub mod view;
pub mod width;

use ratatui::style::Style;

/// A styled run of text. `style` applies to the whole `content`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub style: Style,
    pub content: String,
}

impl Span {
    pub fn raw(content: impl Into<String>) -> Self {
        Span {
            style: Style::default(),
            content: content.into(),
        }
    }

    pub fn styled(content: impl Into<String>, style: Style) -> Self {
        Span {
            style,
            content: content.into(),
        }
    }
}

/// A rendered line: styled spans laid out left to right.
pub type Line = Vec<Span>;

/// Render trait shared by all components.
pub trait Component {
    /// Render to lines for the given viewport width. Lines must not exceed
    /// `width` visible columns.
    fn render(&self, width: u16) -> Vec<Line>;
}
