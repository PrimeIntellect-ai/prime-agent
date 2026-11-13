//! Headless e2e for the `/telemetry` command: bare and `status` render the
//! seam's report, `on`/`off` persist through the settings seam and render
//! the report after the write (including the "stays off" answer when an
//! environment variable forces telemetry off), and a bad argument gets the
//! usage error. The report text and the settings round-trip are covered by
//! the pa-core telemetry status tests over the real settings store.
#![cfg(unix)]
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

mod support;

use std::sync::Arc;

use anyhow::Result;
use pa_tui::interactive::{HeadlessPlan, HeadlessStep, InteractiveOptions};

use support::{
    attach_response, create_response, detach_response, options, run_headless, serve_connection,
    session_stats_response, write_json, MockSupervisor, Request,
};

impl MockSupervisor {
    /// Serve one connection: attach an empty session, then answer the
    /// loop's requests.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        serve_connection(stream, &[], |writer, Request { id, kind, .. }| {
            match kind {
                "create" => {
                    write_json(writer, &create_response(id));
                }
                "attach" => {
                    write_json(writer, &attach_response(id, "telemetry session"));
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

/// The settings seam stub: the telemetry switch lives in memory, and an
/// optional environment opt-out mimics `DO_NOT_TRACK`.
#[derive(Default)]
struct StubSettings {
    telemetry_enabled: std::sync::Mutex<Option<bool>>,
    forced_off_by: Option<&'static str>,
    notice_due: bool,
    notice_shown: std::sync::atomic::AtomicBool,
}

impl StubSettings {
    fn state(&self) -> (&'static str, String) {
        if let Some(var) = self.forced_off_by {
            return ("off", format!("forced off by {var}"));
        }
        match *self.telemetry_enabled.lock().expect("telemetry lock") {
            None => ("on", "on by default".to_string()),
            Some(true) => ("on", "turned on in settings".to_string()),
            Some(false) => ("off", "turned off in settings".to_string()),
        }
    }
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
        None
    }
    fn set_update_channel(&self, _channel: &str) -> Result<()> {
        Ok(())
    }
    fn telemetry_status(&self) -> String {
        let (state, reason) = self.state();
        format!("Telemetry is {state} ({reason}).\nInstallation id: stub-id")
    }
    fn set_telemetry_enabled(&self, enabled: bool) -> Result<String> {
        *self.telemetry_enabled.lock().expect("telemetry lock") = Some(enabled);
        let headline = if self.forced_off_by.is_some() && enabled {
            "Saved telemetry on in settings, but it stays off."
        } else if enabled {
            "Telemetry turned on."
        } else {
            "Telemetry turned off."
        };
        Ok(format!("{headline}\n{}", self.telemetry_status()))
    }
    fn effective_update_channel(&self, _version: &str) -> String {
        "stable".to_string()
    }
    fn telemetry_notice_due(&self) -> bool {
        // Like the real funnel: a due notice stops being due once the
        // marker persists.
        self.notice_due && !self.notice_shown.load(std::sync::atomic::Ordering::Relaxed)
    }
    fn set_telemetry_notice_shown(&self) -> Result<()> {
        self.notice_shown
            .store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }
}

fn run_plan(settings: Arc<StubSettings>, steps: Vec<HeadlessStep>) -> Vec<String> {
    let outcome = run_headless(
        HeadlessPlan {
            steps,
            width: 100,
            height: 30,
        },
        |socket| InteractiveOptions {
            client_settings: Some(settings),
            ..options(socket)
        },
        |socket| {
            let supervisor = MockSupervisor::bind(socket);
            move || supervisor.serve()
        },
    );
    outcome.frames
}

fn submit(text: &str) -> Vec<HeadlessStep> {
    vec![
        HeadlessStep::Submit(text.to_string()),
        HeadlessStep::WaitMs(200),
    ]
}

/// Bare `/telemetry` and `/telemetry status` render the report; a bad
/// argument gets the usage error.
#[test]
fn telemetry_status_renders_the_report() {
    let settings = Arc::new(StubSettings::default());
    let mut steps = submit("/telemetry");
    steps.extend(submit("/telemetry status"));
    steps.extend(submit("/telemetry maybe"));
    let all = run_plan(Arc::clone(&settings), steps).join("\n");
    assert!(
        all.matches("Telemetry is on (on by default).").count() >= 2,
        "bare and status both report:\n{all}"
    );
    assert!(all.contains("Installation id: stub-id"), "{all}");
    assert!(
        all.contains("Usage: /telemetry [status|on|off]"),
        "the usage error rendered:\n{all}"
    );
}

/// `/telemetry off` then `/telemetry on` persist through the seam.
#[test]
fn telemetry_off_and_on_persist_the_switch() {
    let settings = Arc::new(StubSettings::default());
    let steps = submit("/telemetry off");
    let all = run_plan(Arc::clone(&settings), steps).join("\n");
    assert!(all.contains("Telemetry turned off."), "{all}");
    assert!(
        all.contains("Telemetry is off (turned off in settings)."),
        "{all}"
    );
    assert_eq!(*settings.telemetry_enabled.lock().unwrap(), Some(false));

    let all = run_plan(Arc::clone(&settings), submit("/telemetry on")).join("\n");
    assert!(all.contains("Telemetry turned on."), "{all}");
    assert_eq!(*settings.telemetry_enabled.lock().unwrap(), Some(true));
}

/// The first-run telemetry disclosure renders as a session info row
/// (the TS session diagnostic): once per installation, from the
/// interactive attach, and the shown marker persists with the row.
#[test]
fn the_first_run_telemetry_notice_renders_as_a_row() {
    let settings = Arc::new(StubSettings {
        notice_due: true,
        ..StubSettings::default()
    });
    let all = run_plan(Arc::clone(&settings), submit("/telemetry status")).join("\n");
    assert!(
        all.contains("Prime Agent sends pseudonymous usage"),
        "the disclosure row rendered:\n{all}"
    );
    assert!(
        all.contains("Disable this with /telemetry off"),
        "the interactive switch names itself:\n{all}"
    );
    assert!(
        settings
            .notice_shown
            .load(std::sync::atomic::Ordering::Relaxed),
        "the shown marker persisted with the row"
    );

    // The once-per-installation gate: a second attach with the same
    // installation draws no second row.
    let again = run_plan(Arc::clone(&settings), submit("/telemetry status")).join("\n");
    assert!(
        !again.contains("Prime Agent sends pseudonymous usage"),
        "no second disclosure row:\n{again}"
    );
}

/// The disclosure is once per installation: a run whose notice already
/// showed draws no second row.
#[test]
fn an_already_disclosed_installation_renders_no_notice_row() {
    let settings = Arc::new(StubSettings::default());
    let all = run_plan(Arc::clone(&settings), submit("/telemetry status")).join("\n");
    assert!(
        !all.contains("Prime Agent sends pseudonymous usage"),
        "no disclosure row on an already-shown install:\n{all}"
    );
}

/// `/telemetry on` under an environment opt-out says it stays off.
#[test]
fn telemetry_on_says_an_environment_opt_out_still_wins() {
    let settings = Arc::new(StubSettings {
        forced_off_by: Some("DO_NOT_TRACK"),
        ..StubSettings::default()
    });
    let all = run_plan(Arc::clone(&settings), submit("/telemetry on")).join("\n");
    assert!(
        all.contains("Saved telemetry on in settings, but it stays off."),
        "{all}"
    );
    assert!(
        all.contains("Telemetry is off (forced off by DO_NOT_TRACK)."),
        "{all}"
    );
}
