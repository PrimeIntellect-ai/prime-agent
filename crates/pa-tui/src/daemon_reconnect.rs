//! The daemon-reconnect concern (TS #2458): a window that survived a daemon
//! restart reports it version-honestly — when the restarted daemon is NEWER
//! than this window's binary, the recovered row says so instead of
//! pretending the window is updated.
//!
//! [`RecoveryKind`] names the full reconnect drivers the interactive loop
//! arms (the §10.2 update resume, the unexpected-loss hiccup window, and
//! TS #2458's announced non-update closing), so the reattach banner and the
//! window's expiry row follow the flow that owns the recovery.

use crate::chat::StatusKind;

/// The reconnect driver that owns the run: which daemon closing armed it
/// decides the reattach banner and the expiry row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryKind {
    /// Spec §10: an update restart's resume contract — the daemon is
    /// coming back by design inside the 10-minute §10.2 window, and the
    /// reattach paints the update banner.
    Update,
    /// An unexpected connection loss with no notice: a daemon hiccup —
    /// same driver window, its own expiry row.
    Lost,
    /// TS #2458 `reconnectAfterShutdown`: the daemon announced a
    /// non-update closing (`daemon_closing` without an update). The pane
    /// waits bounded for it to come back on the same socket path and
    /// never relaunches it (an explicit stop stays stopped); the expiry
    /// is the saved-transcript close.
    Shutdown,
}

/// TS #2458 `formatDaemonReconnectBanner`: the row a recovered window
/// shows. `daemon_version` is the restarted daemon's hello `appVersion`
/// (`None` when the daemon did not report one); `client_version` is this
/// window's binary. The row is version-honest: a daemon NEWER than this
/// window names the mismatch — the user restarts the window to pick the
/// update up — while an older or unorderable daemon reports without the
/// advice (restarting this window would pick up nothing).
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

/// TS `isDaemonVersionNewer`: the numeric version prefixes order segment
/// by segment; a numeric-equal release outranks the client's own
/// prerelease (semver: "1.2.3" > "1.2.3-beta.1"), so a prerelease window
/// still gets the restart advice.
fn is_daemon_version_newer(daemon_version: &str, client_version: &str) -> bool {
    let daemon = parse_numeric_version_prefix(daemon_version);
    let client = parse_numeric_version_prefix(client_version);
    for index in 0..daemon.len().max(client.len()) {
        let daemon_segment = daemon.get(index).copied().unwrap_or(0);
        let client_segment = client.get(index).copied().unwrap_or(0);
        if daemon_segment != client_segment {
            return daemon_segment > client_segment;
        }
    }
    !has_prerelease_suffix(daemon_version) && has_prerelease_suffix(client_version)
}

/// TS `splitVersionSegments`: the dot- and dash-separated segments of a
/// version ("1.2.3-beta.1" -> ["1", "2", "3", "beta", "1"]).
fn split_version_segments(value: &str) -> Vec<&str> {
    value.split(['.', '-']).collect()
}

/// TS `parseNumericVersionPrefix`: the leading numeric segments; the first
/// unparseable segment ends the prefix.
fn parse_numeric_version_prefix(value: &str) -> Vec<u64> {
    let mut segments = Vec::new();
    for segment in split_version_segments(value) {
        let Ok(parsed) = segment.parse::<u64>() else {
            break;
        };
        segments.push(parsed);
    }
    segments
}

/// TS `hasPrereleaseSuffix`: whether the version continues past its
/// numeric prefix with a prerelease suffix.
fn has_prerelease_suffix(value: &str) -> bool {
    let segments = split_version_segments(value);
    let prefix_len = parse_numeric_version_prefix(value).len();
    prefix_len > 0 && prefix_len < segments.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The TS #2458 banner table (interactive-update-relaunch.test.ts),
    /// verbatim: the recovered window's row is version-honest.
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

    /// TS `isDaemonVersionNewer`: numeric-prefix ordering with the semver
    /// prerelease rule (a release outranks its own prereleases).
    #[test]
    fn the_version_order_follows_the_ts_rules() {
        assert!(is_daemon_version_newer("2.0.0", "1.2.3"));
        assert!(!is_daemon_version_newer("1.2.2", "1.2.3"));
        // A missing segment reads as zero: 1.2 < 1.2.1.
        assert!(is_daemon_version_newer("1.2.1", "1.2"));
        // Numeric-equal releases order by the prerelease suffix alone.
        assert!(is_daemon_version_newer("1.2.3", "1.2.3-beta.1"));
        assert!(!is_daemon_version_newer("1.2.3-beta.1", "1.2.3"));
        assert!(!is_daemon_version_newer("1.2.3-beta.2", "1.2.3-beta.10"));
        assert!(!is_daemon_version_newer("1.2.3-beta.1", "1.2.3-beta.2"));
        // An unparseable version has an empty prefix: it reads as all
        // zeros, so a real release orders above it but never below.
        assert!(!is_daemon_version_newer("dev", "0.1.0"));
        assert!(is_daemon_version_newer("0.1.0", "dev"));
    }
}
