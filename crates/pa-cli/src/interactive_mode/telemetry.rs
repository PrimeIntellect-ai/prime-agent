//! The interaction-telemetry concern (moved with its concern): the
//! one-shot client wrapper and the adoption events the pa-tui
//! interactive loop reports through the InteractionTelemetry trait.

use super::*;

/// `tui scroll used` / `tui exit` adoption telemetry: a one-shot client per
/// event, tracked and flushed at the emission point (the `startup`-event
/// pattern). Telemetry must never fail the session: opt-out or a broken
/// install id drops the event.
pub(super) struct CliInteractionTelemetry {
    pub(super) cwd: PathBuf,
    pub(super) agent_dir: PathBuf,
}

impl CliInteractionTelemetry {
    /// A one-shot client, or `None` when telemetry is opted out.
    fn client(&self) -> Option<pa_telemetry::TelemetryClient> {
        let settings = pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir);
        if crate::mode::telemetry_disabled(&settings) {
            return None;
        }
        Some(pa_core::session_engine::telemetry::build_client(
            &settings,
            &self.agent_dir,
        ))
    }
}

impl pa_tui::interactive::InteractionTelemetry for CliInteractionTelemetry {
    fn bash_shortcut_used(
        &self,
        excluded: bool,
        side_conversation: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("excluded", serde_json::Value::from(excluded));
            properties.set(
                "side_conversation",
                serde_json::Value::from(side_conversation),
            );
            client.track("tui bash shortcut used", properties);
            let _ = client.shutdown().await;
        })
    }

    fn bash_bang_executed(
        &self,
        duration_bucket: &'static str,
        exit_class: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("duration_bucket", serde_json::Value::from(duration_bucket));
            properties.set("exit_class", serde_json::Value::from(exit_class));
            client.track("tui bash bang executed", properties);
            let _ = client.shutdown().await;
        })
    }

    fn prompt_stash(
        &self,
        action: &'static str,
        had_images: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("action", serde_json::Value::from(action));
            properties.set("had_images", serde_json::Value::from(had_images));
            client.track("tui prompt stash", properties);
            let _ = client.shutdown().await;
        })
    }

    fn scroll_used(
        &self,
        action: &'static str,
        resumed_following: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("action", serde_json::Value::from(action));
            properties.set(
                "resumed_following",
                serde_json::Value::from(resumed_following),
            );
            client.track("tui scroll used", properties);
            let _ = client.shutdown().await;
        })
    }

    fn selection_used(&self, lines: usize) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("lines", serde_json::Value::from(lines as u64));
            client.track("tui selection used", properties);
            let _ = client.shutdown().await;
        })
    }
    fn click_used(&self, surface: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("surface", serde_json::Value::from(surface));
            client.track("tui click used", properties);
            let _ = client.shutdown().await;
        })
    }
    fn client_exit(
        &self,
        reason: &'static str,
        turn_active: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("exit_reason", serde_json::Value::from(reason));
            properties.set("turn_active", serde_json::Value::from(turn_active));
            client.track("tui exit", properties);
            let _ = client.shutdown().await;
        })
    }

    fn activity_opened(&self, kind: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("kind", serde_json::Value::from(kind));
            client.track("tui activity opened", properties);
            let _ = client.shutdown().await;
        })
    }

    fn menu_opened(
        &self,
        menu: &'static str,
        source: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("menu", serde_json::Value::from(menu));
            properties.set("source", serde_json::Value::from(source));
            client.track("tui menu opened", properties);
            let _ = client.shutdown().await;
        })
    }

    fn subagents_view_opened(
        &self,
        children_total: u64,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("children_total", serde_json::Value::from(children_total));
            client.track("tui subagents open", properties);
            let _ = client.shutdown().await;
        })
    }

    fn command_used(&self, command: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        // `agent command used` (TS `captureAgentCommandUsed`): builtin
        // client commands report from the client; session commands report
        // through the session telemetry, so the two seams never double-emit.
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

    fn image_pasted(&self, mime_type: &str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        // The returned future borrows only `self`, so the mime type rides
        // inside it by value.
        let mime_type = mime_type.to_string();
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("mime_type", serde_json::Value::from(mime_type));
            client.track("tui image pasted", properties);
            let _ = client.shutdown().await;
        })
    }

    fn queued_input(
        &self,
        lane: &'static str,
        steering_mode: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("lane", serde_json::Value::from(lane));
            properties.set("steering_mode", serde_json::Value::from(steering_mode));
            client.track("tui input queued", properties);
            let _ = client.shutdown().await;
        })
    }

    fn queue_edited(&self, action: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("action", serde_json::Value::from(action));
            client.track("tui queue edited", properties);
            let _ = client.shutdown().await;
        })
    }

    fn enhanced_keys(
        &self,
        kitty: bool,
        modify_other_keys: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("kitty", serde_json::Value::from(kitty));
            properties.set(
                "modify_other_keys",
                serde_json::Value::from(modify_other_keys),
            );
            client.track("tui enhanced keys", properties);
            let _ = client.shutdown().await;
        })
    }

    fn hyperlinks_active(&self, enabled: bool) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("enabled", serde_json::Value::from(enabled));
            client.track("tui hyperlinks", properties);
            let _ = client.shutdown().await;
        })
    }

    fn suspend_used(&self, outcome: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let Some(client) = self.client() else {
                return;
            };
            let mut properties = pa_telemetry::base_properties("interactive");
            properties.set("outcome", serde_json::Value::from(outcome));
            client.track("tui suspend used", properties);
            let _ = client.shutdown().await;
        })
    }
}
