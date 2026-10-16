//! One-shot auth-change notification: refresh serving credentials in all
//! currently resident session workers, including RLM children.

use serde_json::json;

use crate::backpressure::RouteAdmission;
use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::supervisor::{Supervisor, ROUTE_TIMEOUT_MS};

impl Supervisor {
    /// Notify every resident (including RLM children) after a saved Prime
    /// credential changes. No credential material crosses this boundary.
    pub(crate) async fn handle_auth_changed_broadcast(
        &self,
        command_id: &str,
        type_name: &str,
        provider_id: &str,
    ) -> DaemonResponse {
        if provider_id != "prime-inference" {
            return response_failure(Some(command_id), type_name, "Unsupported provider", None);
        }
        let residents = self.registry.list().await;
        let responses = futures::future::join_all(residents.iter().map(|resident| async move {
            self.route_command_typed(
                resident,
                "auth_changed",
                json!({ "providerId": provider_id }),
                ROUTE_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await
        }))
        .await;
        let failures = responses
            .iter()
            .filter(|reply| !matches!(reply, Ok(response) if response.success))
            .count();
        if failures > 0 {
            return response_failure(
                Some(command_id),
                type_name,
                &format!("Could not update {failures} of {} running sessions. Shut down and restart Prime Agent to update running sessions.", residents.len()),
                None,
            );
        }
        response_success(Some(command_id), type_name, None)
    }
}
