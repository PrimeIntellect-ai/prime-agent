//! Worker-side usage reports: every row the worker's transcript appends that
//! carries usage goes to the supervisor's usage ledger as one
//! `worker_usage` request. Delivery is fire-and-forget from the append
//! path: one consumer task sends the reports in order, and a lost report is
//! healed by the supervisor's reconcile, so nothing retries here.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::session_store::UsageRow;
use crate::supervisor_link::SupervisorLink;

/// The worker's report queue (cheap to clone); disabled without a
/// supervisor.
#[derive(Clone)]
pub(crate) struct UsageReports {
    queue: Option<(tokio::sync::mpsc::UnboundedSender<Value>, String)>,
}

impl UsageReports {
    /// Reports go nowhere: no supervisor endpoint, or
    /// [`ROSTER_PUSH_DISABLE_ENV`](crate::roster_activity::ROSTER_PUSH_DISABLE_ENV).
    pub(crate) fn disabled() -> Self {
        Self { queue: None }
    }

    /// Spawn the consumer that sends each report over the worker's link.
    pub(crate) fn spawn(link: Arc<SupervisorLink>, worker_token: String) -> Self {
        if std::env::var_os(crate::roster_activity::ROSTER_PUSH_DISABLE_ENV).is_some()
            || worker_token.is_empty()
            || link.socket_path().as_os_str().is_empty()
        {
            return Self::disabled();
        }
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            while let Some(command) = receiver.recv().await {
                let _ = link
                    .request(command, std::time::Duration::from_secs(10))
                    .await;
            }
        });
        Self {
            queue: Some((sender, worker_token)),
        }
    }

    /// Queue one row's report; a pathless session has no ledger shard.
    pub(crate) fn report(&self, row: &UsageRow<'_>) {
        let Some((sender, worker_token)) = &self.queue else {
            return;
        };
        let Some(session_id) = crate::rlm_ledger::durable_session_id(row.session_file) else {
            return;
        };
        let _ = sender.send(json!({
            "type": "worker_usage",
            "workerToken": worker_token,
            "sessionId": session_id,
            "entryId": row.id,
            "usage": row.usage,
        }));
    }
}
