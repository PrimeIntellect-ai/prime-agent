//! The session's durable usage boundary: model calls made outside the agent
//! loop land here as billed rows, and every billed row is reported once.

use super::model_usage::{ModelUsage, MODEL_USAGE_CUSTOM_TYPE};
use crate::session::billed_row::BilledRowSink;
use crate::session::manager::SessionManager;

pub type UsageStoreFuture<'a, T> =
    std::pin::Pin<std::boxed::Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// The session's durable usage boundary. Implementations append the rows
/// the usage folds read to the session's own transcript, serialized under
/// the session owner. Object-safe (stored behind `Arc<dyn ...>`), so
/// implementations box their futures.
pub trait UsageStore: Send + Sync {
    /// Append one [`ModelUsage`] row to the transcript of `session_id`, the
    /// session the bill was made in. A store that has since moved to another
    /// session refuses the row instead of charging the replacement.
    fn append_model_usage(
        &self,
        session_id: String,
        usage: ModelUsage,
    ) -> UsageStoreFuture<'_, std::io::Result<()>>;

    /// Report every row this store appends from now on that bills a model
    /// call: the store is the one place each billed row lands exactly once.
    fn observe_billed_rows(&self, sink: BilledRowSink) -> UsageStoreFuture<'_, ()>;
}

pub(crate) struct SessionUsageStore(pub(crate) std::sync::Arc<tokio::sync::Mutex<SessionManager>>);

impl UsageStore for SessionUsageStore {
    /// The wrapped manager stays on one session for the store's lifetime.
    fn append_model_usage(
        &self,
        _session_id: String,
        usage: ModelUsage,
    ) -> UsageStoreFuture<'_, std::io::Result<()>> {
        let session = std::sync::Arc::clone(&self.0);
        Box::pin(async move {
            let data = serde_json::to_value(&usage)?;
            session
                .lock()
                .await
                .append_custom_entry(MODEL_USAGE_CUSTOM_TYPE, Some(data))?;
            Ok(())
        })
    }

    fn observe_billed_rows(&self, sink: BilledRowSink) -> UsageStoreFuture<'_, ()> {
        Box::pin(async move { self.0.lock().await.on_billed_row(sink) })
    }
}
