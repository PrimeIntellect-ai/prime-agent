//! The `attach_bot` command: prepare a bot attach for a local TUI (see `bots::attach`).

use super::{json, response_failure, response_success, Arc, DaemonResponse, Supervisor};

impl Supervisor {
    pub(super) async fn handle_attach_bot(
        self: &Arc<Self>,
        command_id: &str,
        type_name: &str,
        bot_id: &str,
    ) -> DaemonResponse {
        let agent_dir = &self.options.agent_dir;
        // The attach may resume a paused bot. When it ends, follow the bot: deliver the turns
        // run during the attach, then pause it after the grace.
        let this = Arc::clone(self);
        let followed = bot_id.to_string();
        let on_end = move || this.follow_bot(&followed);
        let attached = match crate::bots::manager_for(agent_dir) {
            Ok(manager) => {
                crate::bots::attach::attach_bot(&manager, agent_dir, bot_id, on_end).await
            }
            Err(error) => Err(error),
        };
        match attached {
            Ok(attach) => response_success(
                Some(command_id),
                type_name,
                Some(json!({
                    "botId": bot_id,
                    "endpoint": attach.endpoint,
                    "guestSessionId": attach.guest_session_id,
                })),
            ),
            Err(error) => {
                response_failure(Some(command_id), type_name, &format!("{error:#}"), None)
            }
        }
    }
}
