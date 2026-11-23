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
        let attached = match crate::bots::manager_for(agent_dir) {
            Ok(manager) => crate::bots::attach::attach_bot(&manager, agent_dir, bot_id).await,
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
