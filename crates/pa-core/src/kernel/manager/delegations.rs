//! ReplKernelManager delegations onto Inner.

use super::*;

// ---------------------------------------------------------------------------
// ReplKernelManager delegations onto Inner
// ---------------------------------------------------------------------------

impl ReplKernelManager {
    pub(crate) async fn wait_for_protocol_repair(
        &self,
        signal: Option<&AbortSignal>,
    ) -> anyhow::Result<()> {
        self.inner.wait_for_protocol_repair(signal).await
    }

    pub(crate) fn schedule_snapshot(&self) {
        // Spawn on the shared runtime: the debounced snapshot must outlive the
        // cell that scheduled it.
        let inner = Arc::clone(&self.inner);
        if tokio::runtime::Handle::try_current()
            .map(|handle| {
                handle.spawn(async move {
                    inner.schedule_snapshot();
                })
            })
            .is_err()
        {
            // No runtime (e.g. sync drop path): the snapshot stays pending.
        }
    }

    pub(crate) async fn capture_snapshot(
        &self,
        timeout: Option<u64>,
        prune: bool,
    ) -> Option<SnapshotResult> {
        self.inner.capture_snapshot(timeout, prune).await
    }

    pub(crate) async fn perform_restore(&self, protocol_repair: bool) -> Option<RestoreResult> {
        self.inner.perform_restore(protocol_repair).await
    }

    pub(crate) async fn wait_for_active_execution_to_clear_for_reuse(
        &self,
        signal: Option<&AbortSignal>,
    ) -> anyhow::Result<()> {
        self.inner
            .wait_for_active_execution_to_clear_for_reuse(signal)
            .await
    }

    pub(crate) async fn ensure_kernel_rebootstrapped(
        &self,
        signal: Option<&AbortSignal>,
    ) -> anyhow::Result<()> {
        self.inner.ensure_kernel_rebootstrapped(signal).await
    }

    pub(crate) fn supersede_protocol_repair(&self) {
        self.inner.supersede_protocol_repair();
    }
}

impl Inner {
    /// Bridge the Inner-only call sites onto the shared request plumbing:
    /// the manager struct is a thin Arc wrapper, so this is just a view.
    fn as_manager(self: &Arc<Self>) -> ReplKernelManager {
        ReplKernelManager {
            inner: Arc::clone(self),
        }
    }

    /// Type-erased entry onto the shared request plumbing: the state-op /
    /// repair paths recurse back through the queue (rebootstrap -> enqueue),
    /// so the cycle is broken with `dyn` here, not just `Box::pin`.
    pub(crate) fn enqueue_request(
        self: &Arc<Self>,
        request: Request,
        code: &str,
        opts: ExecuteOptions,
        execution_timeout_ms: Option<u64>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<InternalExecuteResult>> + Send>,
    > {
        let manager = self.as_manager();
        let code = code.to_string();
        Box::pin(async move {
            manager
                .enqueue_request(request, &code, opts, execution_timeout_ms)
                .await
        })
    }
}
