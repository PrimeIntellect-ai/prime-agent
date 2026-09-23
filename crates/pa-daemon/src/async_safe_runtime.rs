//! A tokio runtime whose teardown never panics from an async context.

use std::ops::Deref;

/// A multi-thread tokio runtime that drops on a dedicated OS thread.
///
/// [`AgentSessionEngine`](crate::agent_engine::AgentSessionEngine) builds a
/// private runtime and drops when the worker teardown replaces or retires
/// it — often from inside an async context. Dropping a
/// `tokio::runtime::Runtime` there panics (`Cannot drop a runtime in a
/// context where blocking is not allowed`), killing the worker process and
/// racing its socket on restart. The wrapper keeps the inner runtime fully
/// usable (`block_on`, `spawn`, ... via `Deref`) but moves the actual drop
/// onto a fresh OS thread where the runtime's blocking shutdown is legal.
pub(crate) struct AsyncSafeRuntime {
    runtime: Option<tokio::runtime::Runtime>,
}

impl AsyncSafeRuntime {
    /// Build the engine's multi-thread runtime.
    pub(crate) fn new_multi_thread() -> anyhow::Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        Ok(Self {
            runtime: Some(runtime),
        })
    }
}

impl Deref for AsyncSafeRuntime {
    type Target = tokio::runtime::Runtime;

    fn deref(&self) -> &Self::Target {
        self.runtime.as_ref().expect("engine runtime present")
    }
}

impl Drop for AsyncSafeRuntime {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            // Dropping a runtime blocks until its workers drain; that is
            // illegal on an async thread, so the shutdown rides a fresh OS
            // thread. Fire-and-forget: the engine is already retired by the
            // time its runtime drops.
            std::thread::Builder::new()
                .name("engine-runtime-drop".to_string())
                .spawn(move || drop(runtime))
                .ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropping_from_an_async_context_does_not_panic() {
        // The exact production crash: an engine teardown drops the runtime
        // from inside a tokio task (a blocking-shutdown is illegal there).
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        rt.block_on(async {
            let engine_runtime = AsyncSafeRuntime::new_multi_thread().expect("engine runtime");
            // The Deref seams stay usable from async code (spawn never
            // blocks the calling thread); only the drop is the hazard.
            engine_runtime.spawn(async {});
            drop(engine_runtime);
        });
    }
}
