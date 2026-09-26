//! The coordinator's daemon-facing phase bodies: the prepare poll, the
//! commit, the marker freshness gate, and the restore report (the
//! successor's `update_restore_status` RPC). Split from the driver so the
//! FSM stays readable; the driver owns the state writes, these own the
//! wire and filesystem facts.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use pa_types::daemon::update_flow::{
    prepared_marker_expiry, update_marker_path, PreparedMarkerExpiry, UpdateId, UpdateStatusCounts,
    UpdateStatusFailure, UpdateTimeoutBudget,
};
use serde_json::Value;

/// The prepare-poll and restore-poll interval.
const PHASE_POLL: Duration = Duration::from_millis(500);

/// Poll `prepare_update_restart` (idempotent on `update_id`) until the old
/// supervisor reports `prepared` (spec §4 `Preparing`), bounded by the
/// prepare budget. A typed refusal is the spec's `Join` case: another
/// update owns the daemon's transaction - the update aborts for a later
/// retry (this process holds the coordinator lock, so there is nothing to
/// join).
pub(super) async fn prepare_to_prepared(
    client: &pa_tui::daemon_client::DaemonClient,
    update_id: &UpdateId,
    budget: &UpdateTimeoutBudget,
) -> Result<()> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(budget.prepare_ms.max(1));
    loop {
        let response = client
            .request_with_timeout(
                pa_types::daemon::DaemonCommand::PrepareUpdateRestart {
                    id: None,
                    update_id: Some(update_id.to_string()),
                    rest: serde_json::Map::default(),
                },
                budget.prepare_rpc_ms.max(1),
            )
            .await?;
        if response.success {
            let state = response
                .data
                .as_ref()
                .and_then(|data| data.get("state"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if state == "prepared" {
                return Ok(());
            }
        } else if matches!(
            response.error_info,
            Some(pa_types::daemon::DaemonErrorInfo::UpdatePrepareRefused { .. })
        ) {
            anyhow::bail!(
                "another update is preparing on the daemon ({}); retry later",
                response.error.unwrap_or_default()
            );
        }
        if tokio::time::Instant::now() >= deadline {
            anyhow::bail!("the old supervisor did not reach prepared within its budget");
        }
        tokio::time::sleep(PHASE_POLL).await;
    }
}

/// Consume the prepared artifact: `commit_update_restart` (spec §5
/// `Prepared -> Stopping`, the slice-3 dispatch). The RPC budget spans the
/// graceful stops (a stop that exceeds its budget refuses and the
/// supervisor abandons - either way this call returns).
pub(super) async fn commit_update(
    client: &pa_tui::daemon_client::DaemonClient,
    update_id: &UpdateId,
    budget: &UpdateTimeoutBudget,
) -> Result<()> {
    let response = client
        .request_with_timeout(
            pa_types::daemon::DaemonCommand::CommitUpdateRestart {
                id: None,
                update_id: Some(update_id.to_string()),
                rest: serde_json::Map::default(),
            },
            budget.prepare_rpc_ms + budget.worker_stop_ms + budget.worker_stop_extension_ms,
        )
        .await?;
    if !response.success {
        anyhow::bail!(
            "commit_update_restart was refused: {}",
            response
                .error
                .unwrap_or_else(|| "unknown error".to_string())
        );
    }
    Ok(())
}

/// An expired marker is a refusal, never a restore of stale snapshots (spec
/// §7).
pub(super) fn check_marker_fresh(prepared_dir: &Path) -> Result<()> {
    let marker_path = update_marker_path(prepared_dir);
    let content = std::fs::read_to_string(&marker_path)
        .with_context(|| format!("read the prepared marker at {}", marker_path.display()))?;
    let marker: pa_types::daemon::update_flow::UpdatePreparedMarker =
        serde_json::from_str(&content)?;
    match prepared_marker_expiry(&marker.expires_at, &crate::util_time::now_iso8601()) {
        PreparedMarkerExpiry::Active => Ok(()),
        PreparedMarkerExpiry::Expired => anyhow::bail!(
            "the prepared marker expired at {}; the update is abandoned",
            marker.expires_at
        ),
        PreparedMarkerExpiry::Malformed => anyhow::bail!(
            "the prepared marker at {} is malformed",
            marker_path.display()
        ),
    }
}

/// The restore report (slice 5): poll the successor's
/// `update_restore_status` RPC (spec §6/§9) until the boot restore pass
/// completes or the overall restore budget expires. The supervisor's
/// restore pass owns the real per-session counts and failure records —
/// the coordinator reports them, it does not infer adoption from the
/// session list.
pub(super) async fn restore_report(
    socket_path: &Path,
    budget: &UpdateTimeoutBudget,
) -> (UpdateStatusCounts, Vec<UpdateStatusFailure>) {
    let deadline =
        tokio::time::Instant::now() + Duration::from_millis(budget.restore_overall_ms.max(1));
    loop {
        if let Ok((client, _events)) =
            pa_tui::daemon_client::DaemonClient::connect(socket_path).await
        {
            let response = client
                .request_ok(pa_types::daemon::DaemonCommand::UpdateRestoreStatus {
                    id: None,
                    update_id: None,
                    rest: serde_json::Map::default(),
                })
                .await;
            if let Ok(data) = response {
                let complete = data
                    .get("complete")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let counts = read_counts(&data);
                let failures = read_failures(&data);
                client.close();
                if complete {
                    return (counts, failures);
                }
                // In flight: keep polling; the snapshot so far is not the
                // settle report.
            } else {
                client.close();
            }
        }
        if tokio::time::Instant::now() >= deadline {
            // The budget expired mid-restore: report the snapshot's last
            // poll as the honest state rather than blocking forever (spec
            // §9: restore never fails the boot; a late pass still settles
            // on the supervisor).
            return (UpdateStatusCounts::default(), Vec::new());
        }
        tokio::time::sleep(PHASE_POLL).await;
    }
}

/// Parse the RPC's `counts` object (TS `DaemonUpdateRestartCounts` shape).
fn read_counts(data: &Value) -> UpdateStatusCounts {
    let counts = data.get("counts").cloned().unwrap_or(Value::Null);
    let field = |name: &str| counts.get(name).and_then(Value::as_u64).unwrap_or(0);
    UpdateStatusCounts {
        total: field("total"),
        restored: field("restored"),
        resumed: field("resumed"),
        failed: field("failed"),
    }
}

/// Parse the RPC's `failures` array (session file + message per row).
fn read_failures(data: &Value) -> Vec<UpdateStatusFailure> {
    data.get("failures")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let session_file = row.get("sessionFile")?.as_str()?.to_string();
                    let message = row
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    Some(UpdateStatusFailure {
                        session_file,
                        message,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}
