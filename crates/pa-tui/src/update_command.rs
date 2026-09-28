//! The `/update` command's runner seam: the TUI confirms, then the
//! download+install runs OUT-OF-BAND (a background task — the TUI stays
//! mounted and the daemon keeps running; the update replaces only the
//! on-disk binary, so the new build takes effect on restart), and the
//! outcome lands as a note row. The old TS-parity child + relaunch flow
//! is gone: a successful update never tears this process down.

use std::pin::Pin;

/// One `/update` run's outcome: the new build's version line, or the
/// failure message for the error row.
pub type UpdateOutcome = std::result::Result<String, String>;

/// The boxed-future shape of [`UpdateCommands::run_update`].
pub type UpdateRunFuture = Pin<Box<dyn std::future::Future<Output = UpdateOutcome> + Send>>;

/// The update funnel the composition root owns: the same body
/// `prime-agent update` runs (the installer script download + exec with
/// the output captured — the live frame stays intact), so the two
/// surfaces cannot diverge.
pub trait UpdateCommands: Send + Sync {
    /// Run the download+install and report the new build's version (or
    /// the failure message). The caller spawns this; the run may take
    /// minutes (the installer downloads its own artifacts).
    fn run_update(&self) -> UpdateRunFuture;
}

/// The handle the interactive options carry.
#[derive(Clone)]
pub struct UpdateCommandsHandle(pub std::sync::Arc<dyn UpdateCommands>);

impl std::fmt::Debug for UpdateCommandsHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpdateCommandsHandle").finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scripted runner: records the call, answers a fixed outcome (the
    /// headless verifier's seam — no network, no installer).
    struct ScriptedUpdate {
        calls: std::sync::atomic::AtomicUsize,
        outcome: UpdateOutcome,
    }

    impl UpdateCommands for ScriptedUpdate {
        fn run_update(&self) -> UpdateRunFuture {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let outcome = self.outcome.clone();
            Box::pin(async move { outcome })
        }
    }

    #[tokio::test]
    async fn the_runner_reports_its_outcome() {
        let success = ScriptedUpdate {
            calls: std::sync::atomic::AtomicUsize::new(0),
            outcome: Ok("9.9.9-continuous.0123456789abcdef".to_string()),
        };
        assert_eq!(
            UpdateCommandsHandle(std::sync::Arc::new(success))
                .0
                .run_update()
                .await,
            Ok("9.9.9-continuous.0123456789abcdef".to_string())
        );
        let failure = ScriptedUpdate {
            calls: std::sync::atomic::AtomicUsize::new(0),
            outcome: Err("the installer exited with code 3".to_string()),
        };
        assert_eq!(
            UpdateCommandsHandle(std::sync::Arc::new(failure))
                .0
                .run_update()
                .await,
            Err("the installer exited with code 3".to_string())
        );
    }
}
