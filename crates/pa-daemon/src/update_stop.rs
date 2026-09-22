//! The update flow's graceful-stop driver (spec §5 `Stopping`, §9 budgets,
//! invariant I3): workers stop by an acked graceful-stop request and then
//! exiting, each within its budget; a worker that never acks or never exits
//! ABANDONS the update - the supervisor returns to `Serving` and relaunches
//! the already-stopped workers - and no session is ever killed mid-run.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use futures::future::join_all;
use pa_types::daemon::UpdateTimeoutBudget;

use crate::registry::ResidentWorker;

/// TS `UPDATE_RESTART_WORKER_REQUEST_TIMEOUT_MS` parity: the per-worker cap
/// for update RPCs, always bounded by the remaining prepare deadline at the
/// call site.
pub(crate) const WORKER_REQUEST_TIMEOUT_MS: u64 = 90_000;

/// One worker's stop verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkerStopVerdict {
    /// The worker acked the graceful stop and exited in budget.
    Stopped,
    /// The worker never acked (or never exited) in budget: the update is
    /// abandoned, the session keeps running untouched.
    Refused,
}

/// The supervisor's transport to its workers, abstracted so the stop budget
/// logic is unit-testable against a fake worker that never acks (the spec's
/// slice-3 verifier: "worker that never acks -> update abandoned, sessions
/// intact").
///
/// Contract of the two operations, matching the budget table (spec §9
/// `Stopping`): [`WorkerStopTransport::request_shutdown`] is the acked
/// graceful-stop request bounded by `worker_stop_ms` (its success means the
/// worker flushed its recovery journal and telemetry before replying - the
/// worker's shutdown handler is the flush barrier); a success then gets
/// `worker_stop_extension_ms` of exit wait. `wait_exit` returns `true` only
/// when the worker's process identity is gone by the deadline.
pub(crate) trait WorkerStopTransport {
    /// Send the acked graceful-stop request; `Err` on timeout, disconnect,
    /// or refusal.
    fn request_shutdown(
        &self,
        resident: &Arc<ResidentWorker>,
        timeout: Duration,
    ) -> impl std::future::Future<Output = Result<()>> + Send;

    /// Wait until the worker's process is gone or the timeout passes
    /// (`true` = exited).
    fn wait_exit(
        &self,
        resident: &Arc<ResidentWorker>,
        timeout: Duration,
    ) -> impl std::future::Future<Output = bool> + Send;
}

/// Stop every resident worker gracefully, concurrently, each within its own
/// budget (spec §9: 30 s request budget, +30 s exit window). A worker that
/// misses either budget refuses - the update driver abandons the update for
/// that verdict (never a kill).
pub(crate) async fn stop_workers_gracefully<T: WorkerStopTransport + Sync>(
    transport: &T,
    residents: &[Arc<ResidentWorker>],
    budget: &UpdateTimeoutBudget,
) -> Vec<(String, WorkerStopVerdict)> {
    join_all(residents.iter().map(|resident| {
        let resident = Arc::clone(resident);
        async move {
            let verdict = stop_one(transport, &resident, budget).await;
            (resident.worker_id.clone(), verdict)
        }
    }))
    .await
}

async fn stop_one<T: WorkerStopTransport + Sync>(
    transport: &T,
    resident: &Arc<ResidentWorker>,
    budget: &UpdateTimeoutBudget,
) -> WorkerStopVerdict {
    let request_budget = Duration::from_millis(budget.worker_stop_ms);
    if transport
        .request_shutdown(resident, request_budget)
        .await
        .is_err()
    {
        return WorkerStopVerdict::Refused;
    }
    // The ack means the flush already happened; the exit window is the
    // spec's extension budget.
    let exit_budget = Duration::from_millis(budget.worker_stop_extension_ms);
    if transport.wait_exit(resident, exit_budget).await {
        WorkerStopVerdict::Stopped
    } else {
        WorkerStopVerdict::Refused
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// A fake worker: `acks[i]` decides whether the shutdown request
    /// succeeds; `exits[i]` whether the process exits in budget. The
    /// observed budgets are recorded for the spec-table assertions.
    #[derive(Default)]
    struct FakeWorkers {
        acks: Mutex<Vec<bool>>,
        exits: Mutex<Vec<bool>>,
        request_budgets_ns: Mutex<Vec<u64>>,
        exit_budgets_ns: Mutex<Vec<u64>>,
    }

    impl WorkerStopTransport for Arc<FakeWorkers> {
        fn request_shutdown(
            &self,
            _resident: &Arc<ResidentWorker>,
            timeout: Duration,
        ) -> impl std::future::Future<Output = Result<()>> + Send {
            self.request_budgets_ns
                .lock()
                .unwrap()
                .push(timeout.as_nanos() as u64);
            let ack = *self.acks.lock().unwrap().last().unwrap_or(&false);
            async move {
                if ack {
                    Ok(())
                } else {
                    Err(anyhow::anyhow!("Session worker timed out"))
                }
            }
        }

        fn wait_exit(
            &self,
            _resident: &Arc<ResidentWorker>,
            timeout: Duration,
        ) -> impl std::future::Future<Output = bool> + Send {
            self.exit_budgets_ns
                .lock()
                .unwrap()
                .push(timeout.as_nanos() as u64);
            let exit = *self.exits.lock().unwrap().last().unwrap_or(&false);
            async move { exit }
        }
    }

    fn resident(name: &str) -> Arc<ResidentWorker> {
        // The stop driver only reads `worker_id`; a minimal descriptor-free
        // resident cannot be built (ResidentWorker::new needs a descriptor),
        // so build a real one from a minimal descriptor.
        let descriptor = pa_types::daemon::DaemonWorkerDescriptor {
            version: 2,
            worker_id: name.to_string(),
            pid: 0,
            process_start_id: None,
            socket_path: "/tmp/w.sock".into(),
            recovery_journal_path: "/tmp/w.jsonl".into(),
            orphan_process_journal_path: None,
            supervisor_socket_path: "/tmp/s.sock".into(),
            authentication_token: "t".into(),
            worker_instance_id: None,
            root_active_session_id: name.to_string(),
            owner_client_id: None,
            root_session_id: None,
            session_file: None,
            session_dir: None,
            telemetry_disabled: None,
            created_at: String::new(),
            updated_at: String::new(),
            lifecycle: pa_types::daemon::DaemonWorkerLifecycle::Ready,
            create_command: pa_types::daemon::DurableDaemonCreateCommand {
                session_path: None,
                no_session: None,
                rest: Default::default(),
            },
            consecutive_failures: 0,
            stop_requested_at: None,
            archive_on_stop: None,
            last_failure_at: None,
            last_error: None,
            rest: Default::default(),
        };
        crate::registry::ResidentWorker::new(
            name.to_string(),
            descriptor,
            std::path::PathBuf::from("/tmp/descriptor.json"),
        )
    }

    fn budget() -> UpdateTimeoutBudget {
        UpdateTimeoutBudget {
            worker_stop_ms: 30_000,
            worker_stop_extension_ms: 30_000,
            ..UpdateTimeoutBudget::default()
        }
    }

    #[tokio::test]
    async fn stopped_and_refused_verdicts_carry_the_spec_budgets() {
        let fake = Arc::new(FakeWorkers {
            acks: Mutex::new(vec![true, true, false]),
            exits: Mutex::new(vec![true, false, false]),
            ..FakeWorkers::default()
        });
        // The fake answers per call order; give each worker its own slot by
        // driving one resident at a time through the shared driver.
        for (expected, ack, exit) in [
            (WorkerStopVerdict::Stopped, true, true),
            (WorkerStopVerdict::Refused, true, false),
            (WorkerStopVerdict::Refused, false, false),
        ] {
            *fake.acks.lock().unwrap() = vec![ack];
            *fake.exits.lock().unwrap() = vec![exit];
            fake.request_budgets_ns.lock().unwrap().clear();
            fake.exit_budgets_ns.lock().unwrap().clear();
            let verdicts = stop_workers_gracefully(&fake, &[resident("w")], &budget()).await;
            assert_eq!(verdicts.len(), 1);
            assert_eq!(verdicts[0].1, expected, "ack={ack} exit={exit}");
            assert_eq!(
                fake.request_budgets_ns.lock().unwrap().last(),
                Some(&30_000_000_000)
            );
            if ack {
                assert_eq!(
                    fake.exit_budgets_ns.lock().unwrap().last(),
                    Some(&30_000_000_000)
                );
            } else {
                // A refused request never gets an exit window.
                assert_eq!(fake.exit_budgets_ns.lock().unwrap().len(), 0);
            }
        }
    }

    #[tokio::test]
    async fn no_ack_means_no_kill_and_the_verdict_names_the_worker() {
        // The spec's slice-3 verifier, at the driver seam: a worker that
        // never acks is Refused (the driver abandons, the session keeps
        // running - nothing here or in the driver signals or kills).
        let fake = Arc::new(FakeWorkers {
            acks: Mutex::new(vec![false]),
            exits: Mutex::new(vec![false]),
            ..FakeWorkers::default()
        });
        let residents = vec![resident("never-acks"), resident("never-acks-2")];
        *fake.acks.lock().unwrap() = vec![false, false];
        let verdicts = stop_workers_gracefully(&fake, &residents, &budget()).await;
        assert_eq!(
            verdicts,
            vec![
                ("never-acks".to_string(), WorkerStopVerdict::Refused),
                ("never-acks-2".to_string(), WorkerStopVerdict::Refused),
            ]
        );
    }

    #[test]
    fn ts_worker_request_timeout_parity() {
        // TS `UPDATE_RESTART_WORKER_REQUEST_TIMEOUT_MS = 90_000`.
        assert_eq!(WORKER_REQUEST_TIMEOUT_MS, 90_000);
    }
}
