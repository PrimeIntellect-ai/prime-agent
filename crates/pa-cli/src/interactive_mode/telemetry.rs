//! The interaction-telemetry concern: the pa-tui interactive loop reports
//! through the `InteractionTelemetry` trait. Interactions only count into
//! the session run's counters, which ride its one `tui exit` event. Two
//! standalone events remain their own (TS parity, plus one upstream
//! addition): `agent command used`, and `tui ipython bash rendered` —
//! the settled-shell-cell metric upstream #3307 tracks per render, kept
//! intact from main.

use std::collections::BTreeMap;
use std::sync::Mutex;

use super::{Future, PathBuf, Pin};

/// The interactive client's telemetry: per-session-run adoption counters
/// flushed with `tui exit`, plus the two standalone events — the TS
/// `agent command used`, and the upstream #3307 `tui ipython bash
/// rendered` — each on a one-shot client. Telemetry must never fail the
/// session: opt-out or a broken install id drops the events.
pub(super) struct CliInteractionTelemetry {
    pub(super) cwd: PathBuf,
    pub(super) agent_dir: PathBuf,
    pub(super) counters: Mutex<TuiCounters>,
}

/// The session run's adoption counters (`tui_*_count`, `feature_*_count`,
/// `input_*`) and its terminal capability flags.
#[derive(Default)]
pub(super) struct TuiCounters {
    counts: BTreeMap<String, u64>,
    flags: BTreeMap<&'static str, bool>,
}

impl CliInteractionTelemetry {
    pub(super) fn new(cwd: PathBuf, agent_dir: PathBuf) -> Self {
        Self {
            cwd,
            agent_dir,
            counters: Mutex::default(),
        }
    }

    fn settings(&self) -> pa_core::settings::SettingsManager {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
    }

    /// A one-shot client, or `None` when telemetry is opted out.
    fn client(&self) -> Option<pa_telemetry::TelemetryClient> {
        let settings = self.settings();
        if crate::mode::telemetry_disabled(&settings) {
            return None;
        }
        Some(pa_core::session_engine::telemetry::build_client(
            &settings,
            &self.agent_dir,
        ))
    }

    /// Count only while telemetry is on, so turning it on later never
    /// sends what happened while it was off.
    fn with(&self, update: impl FnOnce(&mut TuiCounters)) {
        if crate::mode::telemetry_disabled(&self.settings()) {
            return;
        }
        update(
            &mut self
                .counters
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
    }

    fn count(&self, key: &'static str) {
        self.with(|counters| *counters.counts.entry(key.to_string()).or_default() += 1);
    }
}

impl pa_tui::interactive::InteractionTelemetry for CliInteractionTelemetry {
    fn feature_outcome(
        &self,
        feature: &'static str,
        outcome: &'static str,
        _duration_ms: Option<u64>,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        if let Some(key) = pa_telemetry::feature_outcome_key(feature, outcome) {
            self.with(|counters| *counters.counts.entry(key).or_default() += 1);
        }
        Box::pin(std::future::ready(()))
    }

    fn input_stage(
        &self,
        _input_id: String,
        stage: &'static str,
        _outcome: &'static str,
        duration_ms: u64,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        if let Some(prefix) = pa_telemetry::input_stage_key(stage) {
            self.with(|counters| {
                *counters
                    .counts
                    .entry(format!("{prefix}_count"))
                    .or_default() += 1;
                let max = counters
                    .counts
                    .entry(format!("{prefix}_max_ms"))
                    .or_default();
                *max = (*max).max(duration_ms);
            });
        }
        Box::pin(std::future::ready(()))
    }

    fn bash_shortcut_used(
        &self,
        _excluded: bool,
        _side_conversation: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_bash_shortcut_count");
        Box::pin(std::future::ready(()))
    }

    fn bash_bang_executed(
        &self,
        _duration_bucket: &'static str,
        _exit_class: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_bash_bang_count");
        Box::pin(std::future::ready(()))
    }

    fn prompt_stash(
        &self,
        _action: &'static str,
        _had_images: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_prompt_stash_count");
        Box::pin(std::future::ready(()))
    }

    fn external_editor_used(
        &self,
        _outcome: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_external_editor_count");
        Box::pin(std::future::ready(()))
    }

    fn scoped_models_used(
        &self,
        _action: &'static str,
        _scoped: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_scoped_models_count");
        Box::pin(std::future::ready(()))
    }

    fn ipython_bash_rendered(
        &self,
        bash_lines: usize,
        cell_lines: usize,
        count: usize,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("bash_lines", serde_json::Value::from(bash_lines));
            properties.set("cell_lines", serde_json::Value::from(cell_lines));
            properties.set("count", serde_json::Value::from(count));
            client.track("tui ipython bash rendered", properties);
            let _ = client.shutdown().await;
        })
    }

    fn scroll_used(
        &self,
        _action: &'static str,
        _resumed_following: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_scroll_count");
        Box::pin(std::future::ready(()))
    }

    fn selection_used(&self, _lines: usize) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_selection_count");
        Box::pin(std::future::ready(()))
    }

    fn click_used(&self, _surface: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_click_count");
        Box::pin(std::future::ready(()))
    }

    fn activity_opened(
        &self,
        _kind: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_activity_open_count");
        Box::pin(std::future::ready(()))
    }

    fn menu_opened(
        &self,
        _menu: &'static str,
        _source: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_menu_open_count");
        Box::pin(std::future::ready(()))
    }

    fn subagents_view_opened(
        &self,
        _children_total: u64,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_subagents_open_count");
        Box::pin(std::future::ready(()))
    }

    fn scoped_agent_created(&self, _depth: u32) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_scoped_agent_count");
        Box::pin(std::future::ready(()))
    }

    fn image_pasted(&self, _mime_type: &str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_image_paste_count");
        Box::pin(std::future::ready(()))
    }

    fn queued_input(
        &self,
        _lane: &'static str,
        _steering_mode: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_input_queued_count");
        Box::pin(std::future::ready(()))
    }

    fn queue_edited(&self, _action: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_queue_edit_count");
        Box::pin(std::future::ready(()))
    }

    fn suspend_used(
        &self,
        _outcome: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_suspend_count");
        Box::pin(std::future::ready(()))
    }

    fn agents_view_action(
        &self,
        _action: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.count("tui_agents_action_count");
        Box::pin(std::future::ready(()))
    }

    fn enhanced_keys(
        &self,
        kitty: bool,
        modify_other_keys: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.with(|counters| {
            counters.flags.insert("tui_enhanced_keys_kitty", kitty);
            counters
                .flags
                .insert("tui_enhanced_keys_modify_other_keys", modify_other_keys);
        });
        Box::pin(std::future::ready(()))
    }

    fn hyperlinks_active(&self, enabled: bool) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.with(|counters| {
            counters.flags.insert("tui_hyperlinks_enabled", enabled);
        });
        Box::pin(std::future::ready(()))
    }

    fn client_exit(
        &self,
        reason: &'static str,
        turn_active: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            // Every session run of the process shares these counters (the
            // agents view hands one telemetry handle to each session it
            // opens), so each `tui exit` takes what its run counted.
            let counters = std::mem::take(
                &mut *self
                    .counters
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            );
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("exit_reason", serde_json::Value::from(reason));
            properties.set("turn_active", serde_json::Value::from(turn_active));
            for (key, count) in &counters.counts {
                properties.set(key, serde_json::Value::from(*count));
            }
            for (key, flag) in &counters.flags {
                properties.set(key, serde_json::Value::from(*flag));
            }
            client.track("tui exit", properties);
            let _ = client.shutdown().await;
        })
    }

    fn command_used(&self, command: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        // `agent command used` (TS `captureAgentCommandUsed`): every
        // submitted builtin reports from the client, session commands
        // included (the session engine reports none).
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("command_name", serde_json::Value::from(command));
            client.track("agent command used", properties);
            let _ = client.shutdown().await;
        })
    }
}

#[cfg(test)]
mod tests {
    use pa_tui::interactive::InteractionTelemetry as _;

    use super::CliInteractionTelemetry;

    /// Interactions while telemetry is off never count, so a later
    /// `/telemetry on` cannot send them with `tui exit`.
    #[test]
    fn interactions_while_off_never_count() {
        crate::mode::tests::with_clean_telemetry_env(|| {
            futures::executor::block_on(count_interactions_while_off());
        });
    }

    async fn count_interactions_while_off() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        pa_core::settings::SettingsManager::create(dir.path(), &agent_dir)
            .set_telemetry_enabled(false)
            .unwrap();
        let telemetry = CliInteractionTelemetry::new(dir.path().to_path_buf(), agent_dir);
        telemetry.scroll_used("page", false).await;
        telemetry
            .input_stage(String::new(), "received", "ok", 5)
            .await;
        telemetry.hyperlinks_active(true).await;
        {
            let counters = telemetry.counters.lock().unwrap();
            assert!(counters.counts.is_empty());
            assert!(counters.flags.is_empty());
        }
        pa_core::settings::SettingsManager::create(dir.path(), dir.path().join("agent"))
            .set_telemetry_enabled(true)
            .unwrap();
        telemetry.scroll_used("page", false).await;
        let counters = telemetry.counters.lock().unwrap();
        assert_eq!(counters.counts.get("tui_scroll_count"), Some(&1));
    }

    /// The agents view shares one telemetry handle across the sessions it
    /// opens: each `tui exit` reports only its own run's interactions.
    #[test]
    fn each_tui_exit_reports_only_its_own_run() {
        crate::mode::tests::with_clean_telemetry_env(|| {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(report_each_run_once());
        });
    }

    async fn report_each_run_once() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let telemetry = CliInteractionTelemetry::new(dir.path().to_path_buf(), agent_dir.clone());
        telemetry.scroll_used("page", false).await;
        telemetry.hyperlinks_active(true).await;
        telemetry.client_exit("session_request", false).await;
        telemetry.client_exit("ctrl_d", false).await;
        let mirror = std::fs::read_to_string(agent_dir.join("telemetry.jsonl")).unwrap();
        let exits: Vec<serde_json::Value> = mirror
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .filter(|event: &serde_json::Value| event["name"] == "tui exit")
            .collect();
        assert_eq!(exits.len(), 2);
        assert_eq!(exits[0]["properties"]["tui_scroll_count"], 1);
        assert_eq!(exits[0]["properties"]["tui_hyperlinks_enabled"], true);
        assert!(exits[1]["properties"].get("tui_scroll_count").is_none());
        assert!(exits[1]["properties"]
            .get("tui_hyperlinks_enabled")
            .is_none());
    }
}
