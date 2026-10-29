//! Headless e2e for the `/nightly` command: the status arm resolves the
//! effective channel from the running version when none is preferred, the
//! usage error keeps the TS wording, and the off arm pins the channel
//! through a stub settings seam (persisted form covered by the pa-cli test).
#![cfg(unix)]
// Casts: structurally bounded terminal-layout arithmetic; guarded conversions add panic paths.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Render routes are flat tables (one arm per route); splitting adds indirection.
#![allow(clippy::too_many_lines)]
// Widget state structs carry independent flag bits.
#![allow(clippy::struct_excessive_bools, clippy::fn_params_excessive_bools)]
// Futures are bounded by the surface's lifetime; boxing adds a steady-state allocation.
#![allow(clippy::large_futures)]
// The wrappers preserve a uniform Result-returning API surface.
#![allow(clippy::unnecessary_wraps)]

mod support;

use anyhow::Result;
use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, UiMode,
};

use support::{
    attach_response, create_response, detach_response, options, serve_connection,
    session_stats_response, write_json, MockSupervisor, Request,
};

impl MockSupervisor {
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        serve_connection(stream, &[], |writer, Request { id, kind, .. }| {
            match kind {
                "create" => {
                    write_json(writer, &create_response(id));
                }
                "attach" => {
                    write_json(writer, &attach_response(id, "nightly session"));
                }
                "get_session_stats" => {
                    write_json(writer, &session_stats_response(id));
                }
                "detach" => {
                    write_json(writer, &detach_response(id));
                }
                _ => return false,
            }
            true
        });
    }
}

/// A minimal settings seam for the harness: every getter returns its TS default, writes succeed
/// without persistence, and the channel pair resolves like the composition root.
#[derive(Default)]
struct StubSettings {
    update_channel: std::sync::Mutex<Option<String>>,
}

impl pa_tui::client_settings::ClientSettings for StubSettings {
    fn compaction_threshold_percent(&self) -> f64 {
        95.0
    }
    fn set_compaction_threshold_percent(&self, _percent: f64) -> Result<()> {
        Ok(())
    }

    fn theme(&self) -> Option<String> {
        None
    }
    fn set_theme(&self, _theme: &str) -> Result<()> {
        Ok(())
    }
    fn show_images(&self) -> bool {
        true
    }
    fn set_show_images(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn clear_on_shrink(&self) -> bool {
        false
    }
    fn set_clear_on_shrink(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn show_terminal_progress(&self) -> bool {
        false
    }
    fn set_show_terminal_progress(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn image_auto_resize(&self) -> bool {
        true
    }
    fn set_image_auto_resize(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn block_images(&self) -> bool {
        false
    }
    fn set_block_images(&self, _blocked: bool) -> Result<()> {
        Ok(())
    }
    fn image_model(&self) -> Option<String> {
        None
    }
    fn enable_skill_commands(&self) -> bool {
        true
    }
    fn set_enable_skill_commands(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn enable_builtin_skills(&self) -> bool {
        true
    }
    fn set_enable_builtin_skills(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn show_hardware_cursor(&self) -> bool {
        false
    }
    fn set_show_hardware_cursor(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn editor_padding_x(&self) -> u64 {
        0
    }
    fn set_editor_padding_x(&self, _padding: u64) -> Result<()> {
        Ok(())
    }
    fn autocomplete_max_visible(&self) -> u64 {
        5
    }
    fn set_autocomplete_max_visible(&self, _max_visible: u64) -> Result<()> {
        Ok(())
    }
    fn quiet_startup(&self) -> bool {
        false
    }
    fn set_quiet_startup(&self, _quiet: bool) -> Result<()> {
        Ok(())
    }
    fn idle_eviction_minutes(&self) -> String {
        "90".to_string()
    }
    fn set_idle_eviction_minutes(&self, _value: &str) -> Result<()> {
        Ok(())
    }
    fn mermaid_rendering_mode(&self) -> String {
        "streaming".to_string()
    }
    fn set_mermaid_rendering_mode(&self, _mode: &str) -> Result<()> {
        Ok(())
    }
    fn tree_filter_mode(&self) -> String {
        "user-only".to_string()
    }
    fn set_tree_filter_mode(&self, _mode: &str) -> Result<()> {
        Ok(())
    }
    fn default_service_tier(&self) -> String {
        "default".to_string()
    }
    fn set_default_service_tier(&self, _tier: &str) -> Result<()> {
        Ok(())
    }
    fn chat_detail(&self) -> String {
        "details".to_string()
    }
    fn set_chat_detail(&self, _detail: &str) -> Result<()> {
        Ok(())
    }
    fn factory_enabled(&self) -> bool {
        false
    }
    fn set_factory_enabled(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn warnings_anthropic_extra_usage(&self) -> bool {
        true
    }
    fn set_warnings_anthropic_extra_usage(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn update_channel(&self) -> Option<String> {
        self.update_channel.lock().expect("channel lock").clone()
    }
    fn set_update_channel(&self, channel: &str) -> Result<()> {
        *self.update_channel.lock().expect("channel lock") = Some(channel.to_string());
        Ok(())
    }
    fn telemetry_status(&self) -> String {
        String::new()
    }
    fn set_telemetry_enabled(&self, _enabled: bool) -> Result<String> {
        Ok(String::new())
    }
    fn effective_update_channel(&self, version: &str) -> String {
        if let Some(channel) = self.update_channel() {
            return channel;
        }
        // The inference TS resolveUpdateChannel applies: a -beta* prerelease reads nightly,
        // anything else stable.
        if version.contains("-beta") {
            "nightly".to_string()
        } else {
            "stable".to_string()
        }
    }
}

fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let supervisor = MockSupervisor::bind(&socket);
    let handle = std::thread::spawn(move || supervisor.serve());

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height: 30,
    };
    let outcome = runtime
        .block_on(run_interactive(
            InteractiveOptions {
                client_settings: Some(std::sync::Arc::new(StubSettings::default())),
                ..options(socket)
            },
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    outcome.frames
}

/// `/nightly status` reports the inferred channel (the harness has no settings seam, so no
/// preferred channel is set) and the running version; a bad argument gets the TS usage error.
#[test]
fn nightly_status_and_usage_error_render_the_ts_wording() {
    let steps = vec![
        HeadlessStep::Submit("/nightly status".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/nightly maybe".to_string()),
        HeadlessStep::WaitMs(200),
    ];
    let frames = run_plan(steps);
    assert!(!frames.is_empty(), "frames were captured");
    let all = frames.join("\n");
    assert!(
        all.contains("Updates follow the stable channel (inferred from the running version). v0.0.0 installed."),
        "the status note rendered:\n{all}"
    );
    assert!(
        all.contains("Usage: /nightly [on|off|status]"),
        "the usage error rendered:\n{all}"
    );
}

/// `/nightly on` (or bare) saves the nightly channel that `/update` and
/// `prime-agent update` follow.
#[test]
fn nightly_on_saves_the_nightly_channel() {
    let steps = vec![
        HeadlessStep::Submit("/nightly on".to_string()),
        HeadlessStep::WaitMs(200),
        HeadlessStep::Submit("/nightly status".to_string()),
        HeadlessStep::WaitMs(200),
    ];
    let frames = run_plan(steps);
    let all = frames.join("\n");
    assert!(
        all.contains("Updates now follow the nightly channel."),
        "the switch note rendered:\n{all}"
    );
    assert!(
        all.contains("Updates follow the nightly channel (set in settings)."),
        "the saved channel reads back:\n{all}"
    );
}

#[test]
fn nightly_off_renders_the_stable_pin_note() {
    let steps = vec![
        HeadlessStep::Submit("/nightly off".to_string()),
        HeadlessStep::WaitMs(200),
    ];
    let frames = run_plan(steps);
    let all = frames.join("\n");
    assert!(
        all.contains(
            "Updates now follow the stable channel. Run /update to install the latest build."
        ),
        "the stable-pin note rendered:\n{all}"
    );
}
