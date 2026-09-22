//! The live-kernel registry: one registry serves every kernel client so
//! process-wide cleanup (session end, signal-driven shutdown) can dispose
//! them exactly once.
//!
//! Ported from the `liveKernels` registry and `installSignalHandlersOnce` in
//! `core/kernel/shared.ts`. The TS process hooks (`beforeExit`/SIGINT/SIGTERM)
//! live in the process layer here: the binary crate calls
//! [`shutdown_all_live_kernels`] from its own signal handling, keeping the
//! same flush-then-teardown ordering.

use std::sync::{Arc, Mutex, Weak};

use crate::kernel::manager::Inner;

type Registry = Mutex<Vec<Weak<Inner>>>;

fn registry() -> &'static Registry {
    static REGISTRY: Registry = Mutex::new(Vec::new());
    &REGISTRY
}

/// Track a kernel from the moment startup begins so cleanup can dispose a
/// kernel that is still booting. Entries are weak: dropping the manager
/// deregisters implicitly even if `remove` was not called.
pub(crate) fn add(inner: &std::sync::Arc<Inner>) {
    let mut entries = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    entries.retain(|weak| weak.strong_count() > 0);
    if !contains(&entries, inner) {
        entries.push(Arc::downgrade(inner));
    }
}

/// Stop tracking a kernel: teardown or defunct transition.
pub(crate) fn remove(inner: &Inner) {
    let mut entries = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    entries.retain(|weak| {
        weak.strong_count() == 0
            || !std::ptr::eq(
                Weak::as_ptr(weak) as *const (),
                std::ptr::from_ref(inner) as *const (),
            )
    });
}

/// Alias matching the manager's internal call sites.
pub(crate) fn remove_inner(inner: &Inner) {
    remove(inner);
}

fn contains(entries: &[Weak<Inner>], inner: &std::sync::Arc<Inner>) -> bool {
    entries
        .iter()
        .any(|weak| std::ptr::eq(Weak::as_ptr(weak), std::sync::Arc::as_ptr(inner)))
}

/// Flush and tear down every live kernel, discarding individual failures:
/// the shutdown of one wedged kernel must not block the others.
///
/// Mirrors the TS async shutdown handler (`snapshot: true`, no host-request
/// drain) run before process exit.
pub async fn shutdown_all_live_kernels() {
    let snapshots: Vec<std::sync::Arc<Inner>> = {
        let mut entries = registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        entries.retain(|weak| weak.strong_count() > 0);
        entries.iter().filter_map(Weak::upgrade).collect()
    };
    let mut joins = Vec::new();
    for inner in snapshots {
        joins.push(tokio::spawn(async move {
            let _ = inner
                .shutdown_for_cleanup(crate::kernel::shared::KernelShutdownOptions {
                    snapshot: true,
                    drain_host_requests: false,
                })
                .await;
        }));
    }
    for join in joins {
        let _ = join.await;
    }
}

/// The sessions the registry currently serves.
pub fn live_kernel_count() -> usize {
    let mut entries = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    entries.retain(|weak| weak.strong_count() > 0);
    entries.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::shared::KernelManagerOptions;

    #[tokio::test]
    async fn registry_tracks_and_releases_kernels() {
        assert_eq!(live_kernel_count(), 0);
        let manager = crate::kernel::ReplKernelManager::new(KernelManagerOptions::default());
        add(&manager.inner);
        assert_eq!(live_kernel_count(), 1);
        // Removing the same pointer deregisters it.
        remove(&manager.inner);
        assert_eq!(live_kernel_count(), 0);
        add(&manager.inner);
        drop(manager);
        assert_eq!(
            live_kernel_count(),
            0,
            "weak entry must vanish with the manager"
        );
    }

    #[tokio::test]
    async fn shutdown_all_is_safe_with_no_kernels() {
        shutdown_all_live_kernels().await;
    }
}
