//! A tokio runtime whose teardown never panics from an async context.

use std::ops::Deref;

/// A multi-thread tokio runtime that drops on a dedicated OS thread.
///
/// [`AgentSessionEngine`](crate::agent_engine::AgentSessionEngine) drops its private runtime
/// during worker teardown — often from inside an async context, where dropping a runtime
/// panics. The wrapper keeps the inner runtime usable via `Deref` but moves the drop onto
/// a fresh OS thread.
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
            // Dropping a runtime blocks until its workers drain; that is illegal on an
            // async thread, so the shutdown rides a fresh OS thread.
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
            // The Deref seams stay usable from async code; only the drop is the hazard.
            engine_runtime.spawn(async {});
            drop(engine_runtime);
        });
    }
}
