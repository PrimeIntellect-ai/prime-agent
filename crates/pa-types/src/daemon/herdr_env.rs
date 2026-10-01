//! The Herdr client-env contract (TS `DAEMON_CLIENT_ENV_KEYS` in
//! `daemon-protocol.ts`): the allowlist of environment vars a client may
//! forward to the daemon so a session can report for the pane it runs in.
//!
//! Herdr (<https://herdr.dev>) exports a pane's identity in the environment
//! of processes inside it. A client (the TUI) sends these on the session
//! `create` — the session it creates reports for THIS pane, whatever
//! environment the daemon itself booted in — and the daemon re-filters on
//! receipt (the socket peer is untrusted). Both sides share this one list
//! because it is the wire contract.
//!
//! The trust model: the pane identity names the socket a session reports
//! to, and a client picks it — but any client that can reach the
//! user-scoped daemon socket can already read the full session through the
//! daemon's own API, so the report surface (the session reference and the
//! pane state) crosses no privilege boundary. The re-filter bounds what
//! rides the wire: a forwarded map never carries more than these keys.
//! The daemon-side reporter additionally FENCES the target itself: it
//! connects only to a Unix socket the daemon's own uid owns (lstat, no
//! symlink follow), so a redirected target cannot exfiltrate anywhere.

use std::collections::BTreeMap;

/// The allowlist of client env vars the Herdr connector consumes (TS
/// `DAEMON_CLIENT_ENV_KEYS`, plus the connector's own tuning keys). The
/// tuning keys ride the same allowlist so a pane can tune the debounce
/// and the retry grace per session — the TS read them from the shared
/// daemon process env, which the session-scoped port deliberately cannot.
pub const HERDR_CLIENT_ENV_KEYS: [&str; 7] = [
    "HERDR_ENV",
    "HERDR_PANE_ID",
    "HERDR_SOCKET_PATH",
    "HERDR_TAB_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_PI_IDLE_DEBOUNCE_MS",
    "HERDR_PI_RETRY_GRACE_MS",
];

/// Collect the allowlisted vars from a process-env-like source (the
/// client side of the wire contract: only these keys may travel on the
/// create).
#[must_use]
pub fn collect_client_env(source: impl Fn(&str) -> Option<String>) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for key in HERDR_CLIENT_ENV_KEYS {
        if let Some(value) = source(key).filter(|value| !value.is_empty()) {
            env.insert(key.to_string(), value);
        }
    }
    env
}

/// Re-filter a received env map to the allowlist with non-empty values
/// (the daemon side of the wire contract: the peer is untrusted, so a
/// forwarded map never carries more than the connector reads anyway).
#[must_use]
pub fn filter_client_env(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.iter()
        .filter(|(key, value)| HERDR_CLIENT_ENV_KEYS.contains(&key.as_str()) && !value.is_empty())
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;

    /// The client side collects exactly the allowlist (the wire contract:
    /// no other var a pane process runs with may travel on the create).
    #[test]
    fn the_client_collects_only_the_allowlist() {
        let env = collect_client_env(|key| match key {
            "HERDR_ENV" => Some("1".to_string()),
            "HERDR_SOCKET_PATH" => Some("/tmp/herdr.sock".to_string()),
            "HERDR_PANE_ID" => Some("w1:payload".to_string()),
            "HERDR_TAB_ID" => Some("t1".to_string()),
            "HERDR_WORKSPACE_ID" => Some("ws1".to_string()),
            "HERDR_PI_IDLE_DEBOUNCE_MS" => Some("10".to_string()),
            "HERDR_PI_RETRY_GRACE_MS" => Some("30".to_string()),
            "SOMETHING_ELSE" => Some("never travels".to_string()),
            _ => None,
        });
        assert_eq!(
            env,
            BTreeMap::from([
                ("HERDR_ENV".to_string(), "1".to_string()),
                (
                    "HERDR_SOCKET_PATH".to_string(),
                    "/tmp/herdr.sock".to_string()
                ),
                ("HERDR_PANE_ID".to_string(), "w1:payload".to_string()),
                ("HERDR_TAB_ID".to_string(), "t1".to_string()),
                ("HERDR_WORKSPACE_ID".to_string(), "ws1".to_string()),
                ("HERDR_PI_IDLE_DEBOUNCE_MS".to_string(), "10".to_string()),
                ("HERDR_PI_RETRY_GRACE_MS".to_string(), "30".to_string()),
            ])
        );
    }

    /// An empty value never travels (TS treats the empty pane id as "not
    /// inside a pane"; the filter keeps that shape on both sides).
    #[test]
    fn the_client_skips_empty_values() {
        let env = collect_client_env(|key| match key {
            "HERDR_ENV" => Some("1".to_string()),
            "HERDR_PANE_ID" => Some(String::new()),
            _ => None,
        });
        assert_eq!(
            env,
            BTreeMap::from([("HERDR_ENV".to_string(), "1".to_string())])
        );
    }

    /// The daemon side re-filters a received map (the socket peer is
    /// untrusted): an off-list key and an empty value never survive —
    /// and the tuning keys ride through.
    #[test]
    fn the_daemon_re_filters_to_the_allowlist() {
        let received = BTreeMap::from([
            ("HERDR_PANE_ID".to_string(), "w1:payload".to_string()),
            ("PRIME_API_KEY".to_string(), "leak".to_string()),
            ("HERDR_ENV".to_string(), String::new()),
            ("HERDR_PI_IDLE_DEBOUNCE_MS".to_string(), "10".to_string()),
            ("HERDR_PI_RETRY_GRACE_MS".to_string(), "30".to_string()),
        ]);
        assert_eq!(
            filter_client_env(&received),
            BTreeMap::from([
                ("HERDR_PANE_ID".to_string(), "w1:payload".to_string()),
                ("HERDR_PI_IDLE_DEBOUNCE_MS".to_string(), "10".to_string()),
                ("HERDR_PI_RETRY_GRACE_MS".to_string(), "30".to_string()),
            ])
        );
    }
}
