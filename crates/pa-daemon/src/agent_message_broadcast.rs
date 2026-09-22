//! Supervisor arms for the agent-message ingestion surface (protocol
//! breadth wave b7): the selector-less forms of `agent_messages_status`,
//! `agent_messages_pause`, and `agent_messages_resume` (TS
//! daemon-supervisor `case "agent_messages_status"` and the shared
//! pause/resume case). A command that addresses one session routes through
//! the generic worker path; these arms cover the TS broadcast forms:
//!
//! - `status` without a selector forwards to the first live worker, or
//!   answers the TS empty-status object `{ paused: false, limits: {} }`
//!   when no worker is live;
//! - `pause`/`resume` without a selector broadcast to every live worker:
//!   the first failure answers with its error, otherwise the first
//!   success's data (an empty roster answers success with `data: null`).

use std::sync::Arc;

use serde_json::{json, Value};

use pa_types::daemon::DaemonWorkerLifecycle;

use crate::protocol::{
    command_type_name, response_failure, response_line, response_success, DaemonResponse,
};
use crate::registry::ResidentWorker;
use crate::supervisor::{client_command_payload, Supervisor, ROUTE_TIMEOUT_MS};

impl Supervisor {
    /// A live, connected, non-stopping resident (TS `isLiveWorker(worker)
    /// && worker.client`).
    pub(crate) async fn is_live_connected_worker(&self, resident: &Arc<ResidentWorker>) -> bool {
        if self.is_stopping(resident) {
            return false;
        }
        let lifecycle = resident.descriptor.lock().await.lifecycle;
        lifecycle == DaemonWorkerLifecycle::Ready && resident.cmd_tx.lock().await.is_some()
    }

    /// The live connected residents in creation order (TS walks its
    /// insertion-ordered worker map).
    pub(crate) async fn live_workers_in_creation_order(&self) -> Vec<Arc<ResidentWorker>> {
        let mut residents = Vec::new();
        for resident in self.registry.list().await {
            if self.is_live_connected_worker(&resident).await {
                residents.push(resident);
            }
        }
        // Creation order (TS walks its insertion-ordered worker map);
        // the descriptors are read before the sort so the closure stays
        // sync.
        let mut ordered: Vec<(String, Arc<ResidentWorker>)> = Vec::new();
        for resident in residents {
            let created_at = resident.descriptor.lock().await.created_at.clone();
            ordered.push((created_at, resident));
        }
        ordered.sort_by(|a, b| a.0.cmp(&b.0));
        ordered.into_iter().map(|(_, resident)| resident).collect()
    }

    /// Forward one client command to a specific resident (the generic
    /// route path minus the selector resolution): the worker payload with
    /// the client id stamped, TS timeout.
    async fn forward_client_command(
        &self,
        resident: &Arc<ResidentWorker>,
        command: &pa_types::daemon::DaemonCommand,
        client_id: &str,
    ) -> DaemonResponse {
        match client_command_payload(command, client_id) {
            Ok((command_type, payload)) => {
                match self
                    .route_command(resident, command_type, payload, ROUTE_TIMEOUT_MS)
                    .await
                {
                    Ok(response) => response,
                    Err(error) => response_failure(None, command_type, &error.to_string(), None),
                }
            }
            Err(error) => {
                response_failure(None, command_type_name(command), &error.to_string(), None)
            }
        }
    }

    /// Selector-less `agent_messages_status`: the first live worker's
    /// safety status, or the TS empty-status object when none is live.
    pub(crate) async fn handle_agent_messages_status_broadcast(
        &self,
        command: &pa_types::daemon::DaemonCommand,
        client_id: &str,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let residents = self.live_workers_in_creation_order().await;
        if let Some(first) = residents.first() {
            let mut response = self.forward_client_command(first, command, client_id).await;
            response.id = Some(command_id.to_string());
            return (vec![response_line(&response)], false);
        }
        (
            vec![response_line(&response_success(
                Some(command_id),
                type_name,
                Some(json!({ "paused": false, "limits": {} })),
            ))],
            false,
        )
    }

    /// Selector-less `agent_messages_pause` / `agent_messages_resume`:
    /// broadcast to every live worker, answer the first failure, else the
    /// first success's data (`data: null` when no worker answered).
    pub(crate) async fn handle_agent_messages_pause_resume_broadcast(
        &self,
        command: &pa_types::daemon::DaemonCommand,
        client_id: &str,
        command_id: &str,
        type_name: &str,
    ) -> (Vec<Value>, bool) {
        let residents = self.live_workers_in_creation_order().await;
        let mut first_failure: Option<DaemonResponse> = None;
        let mut first_data: Option<Value> = None;
        for resident in &residents {
            let mut response = self
                .forward_client_command(resident, command, client_id)
                .await;
            response.id = Some(command_id.to_string());
            if !response.success && first_failure.is_none() {
                first_failure = Some(response);
                continue;
            }
            if response.success && first_data.is_none() {
                first_data = response.data;
            }
        }
        if let Some(failure) = first_failure {
            return (vec![response_line(&failure)], false);
        }
        (
            vec![response_line(&response_success(
                Some(command_id),
                type_name,
                first_data,
            ))],
            false,
        )
    }
}
