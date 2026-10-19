//! The client launch-env wire contract (TS `collectDaemonLaunchEnv`,
//! `daemon-protocol.ts`): the environment a client forwards on a
//! session `create` — its whole process env minus the daemon-internal
//! vars.
//!
//! A session's worker runs as a separate process the supervisor spawns
//! with the daemon's own boot env; without this contract the session
//! would run in whatever environment the daemon booted in (the TS
//! port-parity gap): PATH changes, direnv, proxies, and certificate
//! paths from the terminal that opened the session would be lost.
//!
//! The trust model mirrors the Herdr client-env contract: any client
//! that can reach the user-scoped daemon socket can already run
//! commands through it, so the forwarded env crosses no privilege
//! boundary — but the daemon re-applies the same filter on receipt
//! (the socket peer is untrusted), and the daemon-internal
//! `PRIME_AGENT_INTERNAL_*` vars never ride the wire: a worker's
//! identity is stamped by the supervisor at spawn, never inherited
//! from a client, and a worker forwarding its own env to a spawned
//! child (the TS in-process-parity path) must not leak its internal
//! identity into it.

use std::collections::BTreeMap;

/// The daemon-internal env prefix (`PRIME_AGENT_INTERNAL_*`): the
/// supervisor's worker identity and protocol vars. Neither side of the
/// wire ever forwards them.
pub const INTERNAL_ENV_PREFIX: &str = "PRIME_AGENT_INTERNAL_";

/// Collect the launch env from a process-env-like source: everything
/// except the daemon-internal vars (the client side of the wire
/// contract). The daemon re-applies the same function to a received
/// map (the socket peer is untrusted): a forwarded map never carries
/// more than a client may legitimately forward.
#[must_use]
pub fn collect_launch_env(
    source: impl IntoIterator<Item = (String, String)>,
) -> BTreeMap<String, String> {
    source
        .into_iter()
        .filter(|(key, _)| !key.starts_with(INTERNAL_ENV_PREFIX))
        .collect()
}

/// Collect the launch env from THIS process's environment. Entries that
/// are not valid UTF-8 are skipped: the JSON wire cannot carry them,
/// and `std::env::vars` would panic on them.
#[must_use]
pub fn collect_process_launch_env() -> BTreeMap<String, String> {
    collect_launch_env(
        std::env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The client side forwards everything except the daemon-internal
    /// vars: no other var is special-cased (the whole point of the
    /// contract — PATH, proxies, credential paths ride along).
    #[test]
    fn the_client_collects_everything_but_the_internal_vars() {
        let env = collect_launch_env([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("SSL_CERT_FILE".to_string(), "/certs/ca.pem".to_string()),
            ("PA_MARKER".to_string(), "a-1".to_string()),
            (
                "PRIME_AGENT_INTERNAL_DAEMON_WORKER".to_string(),
                "1".to_string(),
            ),
            (
                "PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN".to_string(),
                "secret-token".to_string(),
            ),
            (
                "PRIME_AGENT_INTERNAL_".to_string(),
                "bare-prefix".to_string(),
            ),
        ]);
        assert_eq!(
            env,
            BTreeMap::from([
                ("PATH".to_string(), "/usr/bin".to_string()),
                ("SSL_CERT_FILE".to_string(), "/certs/ca.pem".to_string()),
                ("PA_MARKER".to_string(), "a-1".to_string()),
            ])
        );
    }
}
