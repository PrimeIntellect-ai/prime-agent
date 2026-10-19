//! The daemon-reconnect concern (TS #2458): a window that survived a
//! daemon restart reports it version-honestly — when the restarted daemon
//! is NEWER than this window's binary, the recovered row says so.

use crate::chat::StatusKind;
use std::cmp::Ordering;

/// The reconnect driver that owns the run: which daemon closing armed it
/// decides the reattach banner and the expiry row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryKind {
    /// Spec §10: an update restart's resume contract — the daemon is coming
    /// back by design inside the 10-minute §10.2 window; the reattach paints
    /// the update banner.
    Update,
    /// An unexpected connection loss with no notice: a daemon hiccup —
    /// same driver window, its own expiry row.
    Lost,
    /// TS #2458 `reconnectAfterShutdown`: the daemon announced a non-update
    /// closing. The pane waits bounded for it to come back on the same socket
    /// path and never relaunches it (an explicit stop stays stopped); the
    /// expiry is the saved-transcript close.
    Shutdown,
}

/// TS #2458 `formatDaemonReconnectBanner`: the row a recovered window
/// shows. `daemon_version` is the restarted daemon's hello `appVersion`
/// (`None` when unreported). The row is version-honest: a daemon NEWER
/// than this window names the mismatch — the user restarts the window to
/// pick the update up — while an older or unorderable daemon reports
/// without the advice.
pub(crate) fn reconnect_banner(
    daemon_version: Option<&str>,
    client_version: &str,
) -> (String, StatusKind) {
    let Some(daemon_version) = daemon_version else {
        return ("Daemon reconnected".to_string(), StatusKind::Info);
    };
    if daemon_version == client_version {
        return (
            format!("Daemon restarted (v{daemon_version}) - reconnected"),
            StatusKind::Info,
        );
    }
    if is_daemon_version_newer(daemon_version, client_version) {
        let message = format!(
            "Daemon restarted (v{daemon_version}), this window still runs v{client_version} - restart the window to pick up the update."
        );
        return (message, StatusKind::Warning);
    }
    let message =
        format!("Daemon restarted (v{daemon_version}), this window runs v{client_version}.");
    (message, StatusKind::Info)
}

/// The numeric version prefixes order segment by segment; a numeric-equal
/// release outranks the client's own prerelease (semver: "1.2.3" >
/// "1.2.3-beta.1"), so a prerelease window still gets the restart advice.
/// Two prereleases of the same prefix order by `compare_prerelease_identifiers`.
fn is_daemon_version_newer(daemon_version: &str, client_version: &str) -> bool {
    let daemon = parse_numeric_version_prefix(daemon_version);
    let client = parse_numeric_version_prefix(client_version);
    for index in 0..daemon.len().max(client.len()) {
        let daemon_segment = daemon.get(index).copied().unwrap_or("0");
        let client_segment = client.get(index).copied().unwrap_or("0");
        let ordering = compare_numeric_identifiers(daemon_segment, client_segment);
        if ordering != Ordering::Equal {
            return ordering == Ordering::Greater;
        }
    }
    let daemon_ids = prerelease_identifiers(daemon_version);
    let client_ids = prerelease_identifiers(client_version);
    match (daemon_ids.is_empty(), client_ids.is_empty()) {
        (_, true) => false,
        (true, false) => true,
        (false, false) => {
            compare_prerelease_identifiers(&daemon_ids, &client_ids) == Ordering::Greater
        }
    }
}

/// Build metadata never contributes to Semver precedence.
fn version_without_build(value: &str) -> &str {
    value.split('+').next().unwrap_or(value)
}

/// The leading numeric segments of the release prefix; the first
/// unparseable segment ends the prefix for nonstandard development versions.
fn parse_numeric_version_prefix(value: &str) -> Vec<&str> {
    let release = version_without_build(value)
        .split('-')
        .next()
        .unwrap_or(value);
    let mut segments = Vec::new();
    for segment in release.split('.') {
        if segment.is_empty() || !segment.bytes().all(|byte| byte.is_ascii_digit()) {
            break;
        }
        segments.push(segment);
    }
    segments
}

/// Prerelease identifiers split on dots only: hyphens belong to an
/// identifier, and even an entirely numeric prerelease remains a prerelease.
fn prerelease_identifiers(value: &str) -> Vec<&str> {
    let value = version_without_build(value);
    if let Some((_, prerelease)) = value.split_once('-') {
        return prerelease.split('.').collect();
    }
    // Preserve the existing treatment of nonstandard development strings.
    value
        .split('.')
        .skip(parse_numeric_version_prefix(value).len())
        .collect()
}

/// Decimal length then lexical order compares arbitrarily large numeric
/// identifiers, retaining the accepted leading-zero behavior of core versions.
fn compare_numeric_identifiers(daemon: &str, client: &str) -> Ordering {
    let daemon_number = daemon.trim_start_matches('0');
    let client_number = client.trim_start_matches('0');
    daemon_number
        .len()
        .cmp(&client_number.len())
        .then_with(|| daemon_number.cmp(client_number))
}

/// Semver §11 ordering of two prerelease identifier lists: identifiers
/// compare left to right — numeric ones numerically, alphanumeric ones
/// lexically, numeric below alphanumeric — and the list with more
/// identifiers wins when the shared ones are equal.
fn compare_prerelease_identifiers(daemon: &[&str], client: &[&str]) -> Ordering {
    for (daemon_id, client_id) in daemon.iter().zip(client) {
        let daemon_numeric = daemon_id.bytes().all(|byte| byte.is_ascii_digit());
        let client_numeric = client_id.bytes().all(|byte| byte.is_ascii_digit());
        let ordering = match (daemon_numeric, client_numeric) {
            (true, true) => compare_numeric_identifiers(daemon_id, client_id),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => daemon_id.cmp(client_id),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    daemon.len().cmp(&client.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The TS #2458 banner table, verbatim: the recovered window's row is
    /// version-honest.
    #[test]
    fn the_banner_table_is_the_ts_table() {
        assert_eq!(
            reconnect_banner(None, "1.2.3"),
            ("Daemon reconnected".to_string(), StatusKind::Info)
        );
        assert_eq!(
            reconnect_banner(Some("1.2.3"), "1.2.3"),
            (
                "Daemon restarted (v1.2.3) - reconnected".to_string(),
                StatusKind::Info
            )
        );
        let newer_banner = "Daemon restarted (v2.0.0), this window still runs v1.2.3 - restart the window to pick up the update.";
        assert_eq!(
            reconnect_banner(Some("2.0.0"), "1.2.3"),
            (newer_banner.to_string(), StatusKind::Warning)
        );
        let prerelease_banner = "Daemon restarted (v1.2.3), this window still runs v1.2.3-beta.1 - restart the window to pick up the update.";
        assert_eq!(
            reconnect_banner(Some("1.2.3"), "1.2.3-beta.1"),
            (prerelease_banner.to_string(), StatusKind::Warning)
        );
        let older_banner = "Daemon restarted (v1.2.3-beta.1), this window runs v1.2.3.";
        assert_eq!(
            reconnect_banner(Some("1.2.3-beta.1"), "1.2.3"),
            (older_banner.to_string(), StatusKind::Info)
        );
    }

    #[test]
    fn build_metadata_does_not_change_precedence() {
        assert!(!is_daemon_version_newer("1.2.3+daemon", "1.2.3+client"));
        assert!(!is_daemon_version_newer(
            "1.2.3-beta.1+daemon",
            "1.2.3-beta.1"
        ));
        assert!(is_daemon_version_newer(
            "1.2.3+daemon",
            "1.2.3-beta.1+client"
        ));
        assert!(is_daemon_version_newer("1.2.4+daemon", "1.2.3+client"));
    }

    #[test]
    fn hyphens_belong_to_the_prerelease_identifier() {
        assert!(is_daemon_version_newer("1.2.3-alpha-2", "1.2.3-alpha-10"));
        assert!(is_daemon_version_newer("1.2.3-alpha-10", "1.2.3-alpha.10"));
        assert!(!is_daemon_version_newer("1.2.3-20", "1.2.3"));
        assert!(!is_daemon_version_newer("1.2.3-20", "1.2.3-alpha"));
    }

    #[test]
    fn numeric_prerelease_identifiers_have_no_integer_size_limit() {
        assert!(is_daemon_version_newer(
            "1.2.3-beta.100000000000000000000",
            "1.2.3-beta.99999999999999999999"
        ));
        assert!(!is_daemon_version_newer(
            "1.2.3-beta.100000000000000000000",
            "1.2.3-beta.alpha"
        ));
    }

    #[test]
    fn numeric_core_segments_have_no_integer_size_limit() {
        for (newer, older) in [
            ("100000000000000000000.0.0", "2.0.0"),
            ("1.100000000000000000000.0", "1.99999999999999999999.0"),
            ("1.2.100000000000000000000", "1.2.99999999999999999999"),
        ] {
            assert!(is_daemon_version_newer(newer, older), "{newer} > {older}");
            assert!(!is_daemon_version_newer(older, newer), "{older} < {newer}");
        }
        assert!(is_daemon_version_newer(
            "100000000000000000000.0.0",
            "100000000000000000000.0.0-beta.1"
        ));
        assert!(!is_daemon_version_newer("01.002.0003", "1.2.3"));
        assert!(!is_daemon_version_newer("1.2.0", "1.2"));
        assert!(!is_daemon_version_newer("1..9", "1.2.0"));
    }

    /// TS `isDaemonVersionNewer`: numeric-prefix ordering with the semver prerelease rule.
    #[test]
    fn the_version_order_follows_the_ts_rules() {
        assert!(is_daemon_version_newer("2.0.0", "1.2.3"));
        assert!(!is_daemon_version_newer("1.2.2", "1.2.3"));
        assert!(is_daemon_version_newer("1.2.1", "1.2"));
        assert!(is_daemon_version_newer("1.2.3", "1.2.3-beta.1"));
        assert!(!is_daemon_version_newer("1.2.3-beta.1", "1.2.3"));
        assert!(!is_daemon_version_newer("1.2.3-beta.2", "1.2.3-beta.10"));
        assert!(!is_daemon_version_newer("1.2.3-beta.1", "1.2.3-beta.2"));
        assert!(is_daemon_version_newer("0.10.1-beta.20", "0.10.1-beta.8"));
        // An unparseable version has an empty prefix: it reads as all zeros, so a real release
        // orders above it but never below.
        assert!(!is_daemon_version_newer("dev", "0.1.0"));
        assert!(is_daemon_version_newer("0.1.0", "dev"));
    }
}
