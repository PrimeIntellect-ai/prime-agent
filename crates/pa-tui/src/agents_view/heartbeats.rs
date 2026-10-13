//! The heartbeat-catalog fetch for the agents-view rows' `◷ N` badges.
use super::{mpsc, DaemonClient, DaemonCommand, UiInput};

/// The heartbeat-catalog fetch (TS `refreshHeartbeats` over
/// `listDaemonHeartbeats`): the selector-less `heartbeats_list` the
/// activity dock reads. A landed catalog re-enters the loop tagged with
/// its generation; a failed fetch keeps the last catalog (the dock's
/// stale-while-revalidate) and the next `heartbeats_changed` retries.
pub(super) fn spawn_heartbeat_catalog_fetch(
    client: &DaemonClient,
    ui_tx: mpsc::UnboundedSender<UiInput>,
    generation: u64,
) {
    let client = client.clone();
    tokio::spawn(async move {
        let request = DaemonCommand::HeartbeatsList {
            id: None,
            active_session_id: None,
            rest: serde_json::Map::default(),
        };
        if let Ok(data) = client.request_ok(request).await {
            let _ = ui_tx.send(UiInput::HeartbeatsLoaded {
                generation,
                heartbeats: crate::heartbeats_picker::parse_heartbeats(&data),
            });
        }
    });
}
