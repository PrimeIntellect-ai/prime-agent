//! The update flow's timeout budget (spec §9): the watchdog table, its
//! defaults, and the `PRIME_AGENT_UPDATE_<NAME>_MS` overrides that let CI
//! run the whole FSM in seconds.

/// Prefix of every update-flow timeout override variable.
pub const UPDATE_ENV_PREFIX: &str = "PRIME_AGENT_UPDATE_";

/// Every watchdog budget of the update flow (spec §9). Each field names the
/// state it guards; on expiry the coordinator/supervisor takes the
/// transition listed there (`Aborted`, `Rollback`, or `Failed` — never a
/// SIGKILL of a session mid-run: invariant I3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpdateTimeoutBudget {
    /// `Downloading`: network + checksum budget (300 s, 3 attempts).
    pub download_ms: u64,
    /// Download attempts before `Aborted`.
    pub download_attempts: u32,
    /// `Staged -> Preparing`: prepare RPC timeout (10 s; retried once).
    pub prepare_rpc_ms: u64,
    /// `Preparing`: the old supervisor's hard prepare deadline
    /// (90 s — TS `UPDATE_RESTART_PREPARE_TIMEOUT_MS` parity).
    pub prepare_ms: u64,
    /// `Prepared`: durable self-expiry window recorded in `marker.json` (45 s).
    pub prepared_expiry_ms: u64,
    /// `Stopping`: graceful stop budget per worker (30 s).
    pub worker_stop_ms: u64,
    /// Extension granted while a worker has an acked flush in progress
    /// (+30 s).
    pub worker_stop_extension_ms: u64,
    /// `Stopped`: fence-free liveness wait for the predecessor to exit
    /// (pid + start-id poll, 30 s).
    pub predecessor_exit_ms: u64,
    /// `Activating`: symlink swap + validation probes (20 s).
    pub activate_ms: u64,
    /// `Booting`: supervisor hello (bind + `daemon_hello`) (45 s).
    pub boot_ms: u64,
    /// `Restoring`: restore RPC per session (60 s).
    pub restore_per_session_ms: u64,
    /// `Restoring`: overall restore budget (300 s).
    pub restore_overall_ms: u64,
}

impl Default for UpdateTimeoutBudget {
    fn default() -> Self {
        UpdateTimeoutBudget {
            download_ms: 300_000,
            download_attempts: 3,
            prepare_rpc_ms: 10_000,
            prepare_ms: 90_000,
            prepared_expiry_ms: 45_000,
            worker_stop_ms: 30_000,
            worker_stop_extension_ms: 30_000,
            predecessor_exit_ms: 30_000,
            activate_ms: 20_000,
            boot_ms: 45_000,
            restore_per_session_ms: 60_000,
            restore_overall_ms: 300_000,
        }
    }
}

impl UpdateTimeoutBudget {
    /// The budget with `PRIME_AGENT_UPDATE_<NAME>_MS` (`_ATTEMPTS` for the
    /// download retry count) overrides from the process environment applied.
    /// An unparsable override falls back to the default: an override is test
    /// plumbing, and a typo must never wedge the FSM behind a huge budget.
    pub fn from_env() -> Self {
        Self::from_overrides(|key| std::env::var(key).ok())
    }

    /// The budget with overrides from an arbitrary lookup (env in
    /// production, a map in tests). Names are the bare `NAME` parts
    /// (`DOWNLOAD_MS`, `PREPARE_MS`, ...) resolved against
    /// [`UPDATE_ENV_PREFIX`].
    pub fn from_overrides(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let mut budget = Self::default();
        let full = |name: &str| format!("{UPDATE_ENV_PREFIX}{name}");
        let set = |name: &str, slot: &mut u64| {
            *slot = override_value(&lookup, &full(name), *slot);
        };
        set("DOWNLOAD_MS", &mut budget.download_ms);
        budget.download_attempts = override_value(
            &lookup,
            &full("DOWNLOAD_ATTEMPTS"),
            budget.download_attempts,
        );
        set("PREPARE_RPC_MS", &mut budget.prepare_rpc_ms);
        set("PREPARE_MS", &mut budget.prepare_ms);
        set("PREPARED_EXPIRY_MS", &mut budget.prepared_expiry_ms);
        set("WORKER_STOP_MS", &mut budget.worker_stop_ms);
        set(
            "WORKER_STOP_EXTENSION_MS",
            &mut budget.worker_stop_extension_ms,
        );
        set("PREDECESSOR_EXIT_MS", &mut budget.predecessor_exit_ms);
        set("ACTIVATE_MS", &mut budget.activate_ms);
        set("BOOT_MS", &mut budget.boot_ms);
        set("RESTORE_PER_SESSION_MS", &mut budget.restore_per_session_ms);
        set("RESTORE_OVERALL_MS", &mut budget.restore_overall_ms);
        budget
    }
}

/// Apply one numeric override: `lookup(name)` parsed, or the current value.
/// Garbage (unparsable) overrides keep the default.
fn override_value<T: std::str::FromStr>(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &str,
    current: T,
) -> T {
    lookup(name)
        .and_then(|value| value.parse().ok())
        .unwrap_or(current)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    #[test]
    fn defaults_match_the_spec_watchdog_table() {
        let b = UpdateTimeoutBudget::default();
        assert_eq!(b.download_ms, 300_000);
        assert_eq!(b.download_attempts, 3);
        assert_eq!(b.prepare_rpc_ms, 10_000);
        // TS `UPDATE_RESTART_PREPARE_TIMEOUT_MS` parity.
        assert_eq!(b.prepare_ms, 90_000);
        assert_eq!(b.prepared_expiry_ms, 45_000);
        assert_eq!(b.worker_stop_ms, 30_000);
        assert_eq!(b.worker_stop_extension_ms, 30_000);
        assert_eq!(b.predecessor_exit_ms, 30_000);
        assert_eq!(b.activate_ms, 20_000);
        assert_eq!(b.boot_ms, 45_000);
        assert_eq!(b.restore_per_session_ms, 60_000);
        assert_eq!(b.restore_overall_ms, 300_000);
    }

    #[test]
    fn env_overrides_apply_and_unrelated_vars_are_ignored() {
        let mut vars: HashMap<String, String> = HashMap::new();
        vars.insert("PRIME_AGENT_UPDATE_DOWNLOAD_MS".into(), "2000".into());
        vars.insert("PRIME_AGENT_UPDATE_PREPARE_MS".into(), "150".into());
        vars.insert("PRIME_AGENT_UPDATE_BOOT_MS".into(), "25".into());
        vars.insert("PRIME_AGENT_UPDATE_DOWNLOAD_ATTEMPTS".into(), "1".into());
        vars.insert("PRIME_AGENT_UNRELATED_MS".into(), "99999".into());
        let lookup = |key: &str| vars.get(key).cloned();
        let b = UpdateTimeoutBudget::from_overrides(lookup);
        assert_eq!(b.download_ms, 2000);
        assert_eq!(b.download_attempts, 1);
        assert_eq!(b.prepare_ms, 150);
        assert_eq!(b.boot_ms, 25);
        // Unrelated keys never leak in.
        assert_eq!(b.prepare_rpc_ms, 10_000);
        assert_eq!(b.worker_stop_ms, 30_000);
    }

    #[test]
    fn garbage_overrides_fall_back_to_defaults() {
        let vars: HashMap<String, String> = [
            ("PRIME_AGENT_UPDATE_PREPARE_MS", "soon"),
            ("PRIME_AGENT_UPDATE_DOWNLOAD_ATTEMPTS", "many"),
            ("PRIME_AGENT_UPDATE_PREPARED_EXPIRY_MS", "-5"),
            ("PRIME_AGENT_UPDATE_ACTIVATE_MS", ""),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let lookup = |key: &str| vars.get(key).cloned();
        let b = UpdateTimeoutBudget::from_overrides(lookup);
        let d = UpdateTimeoutBudget::default();
        assert_eq!(b.prepare_ms, d.prepare_ms);
        assert_eq!(b.download_attempts, d.download_attempts);
        assert_eq!(b.prepared_expiry_ms, d.prepared_expiry_ms);
        assert_eq!(b.activate_ms, d.activate_ms);
    }
}
