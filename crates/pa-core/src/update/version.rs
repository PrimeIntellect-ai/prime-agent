//! Semver comparison and update-channel policy (the TS `version-check.ts`
//! port): the coordinator's `Planning` phase decides update-vs-skip-vs-
//! rollback with exactly these rules, so a candidate decision can never
//! disagree with the installer's.

/// A parsed semver: `major.minor.patch` plus an optional prerelease tag,
/// borrowing the parsed string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParsedVersion<'a> {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// The `-prerelease` part, without the dash.
    pub prerelease: Option<&'a str>,
}

/// Parse `v?-?`-prefixed semver (`1.2.3`, `v1.2.3`, `1.2.3-beta.4+meta`).
/// Returns `None` for anything else (TS `parsePackageVersion` parity: an
/// unparseable version is never a downgrade and never a strict upgrade).
pub fn parse_package_version(version: &str) -> Option<ParsedVersion<'_>> {
    let trimmed = version.trim().trim_start_matches('v');
    let without_build = trimmed.split('+').next().unwrap_or(trimmed);
    let mut parts = without_build.splitn(2, '-');
    let base = parts.next()?;
    let prerelease = parts.next();
    let mut numbers = base.split('.');
    let major = numbers.next()?.parse().ok()?;
    let minor = numbers.next()?.parse().ok()?;
    let patch = numbers.next()?.parse().ok()?;
    if numbers.next().is_some() {
        return None;
    }
    Some(ParsedVersion {
        major,
        minor,
        patch,
        prerelease,
    })
}

/// Compare two prerelease tags (TS `comparePrereleaseIdentifiers`: numeric
/// identifiers compare numerically, numeric < alphanumeric, dot-separated
/// left-to-right, shorter prefix loses when equal so far).
fn compare_prerelease_identifiers(left: &str, right: &str) -> std::cmp::Ordering {
    let left_parts: Vec<&str> = left.split('.').collect();
    let right_parts: Vec<&str> = right.split('.').collect();
    for index in 0..left_parts.len().max(right_parts.len()) {
        let left_identifier = left_parts.get(index);
        let right_identifier = right_parts.get(index);
        match (left_identifier, right_identifier) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(left), Some(right)) => {
                if left == right {
                    continue;
                }
                let left_numeric = left.chars().all(|c| c.is_ascii_digit());
                let right_numeric = right.chars().all(|c| c.is_ascii_digit());
                return match (left_numeric, right_numeric) {
                    (true, true) => {
                        let left_trimmed = left.trim_start_matches('0');
                        let right_trimmed = right.trim_start_matches('0');
                        left_trimmed
                            .len()
                            .cmp(&right_trimmed.len())
                            .then_with(|| left_trimmed.cmp(right_trimmed))
                    }
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    (false, false) => left.cmp(right),
                };
            }
        }
    }
    std::cmp::Ordering::Equal
}

/// Three-way semver compare (`Some(-1|0|1)`); `None` when either side does
/// not parse (TS `comparePackageVersions`).
pub fn compare_package_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    let left = parse_package_version(left)?;
    let right = parse_package_version(right)?;
    let base = left
        .major
        .cmp(&right.major)
        .then(left.minor.cmp(&right.minor))
        .then(left.patch.cmp(&right.patch));
    if base != std::cmp::Ordering::Equal {
        return Some(base);
    }
    Some(match (left.prerelease, right.prerelease) {
        (None, None) => std::cmp::Ordering::Equal,
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(a), Some(b)) if a == b => std::cmp::Ordering::Equal,
        (Some(a), Some(b)) => compare_prerelease_identifiers(a, b),
    })
}

/// Whether `candidate_version` is strictly newer than `current_version`
/// (TS `isNewerPackageVersion`; unparsable sides fall back to string
/// inequality).
pub fn is_newer_package_version(candidate_version: &str, current_version: &str) -> bool {
    match compare_package_versions(candidate_version, current_version) {
        Some(ordering) => ordering == std::cmp::Ordering::Greater,
        None => candidate_version.trim() != current_version.trim(),
    }
}

/// Whether installing `candidate_version` would lower the
/// `major.minor.patch` base (prerelease tags aside) — the `Planning`
/// refusal (TS `isBaseVersionDowngrade`).
pub fn is_base_version_downgrade(candidate_version: &str, current_version: &str) -> bool {
    let Some(candidate) = parse_package_version(candidate_version) else {
        return false;
    };
    let Some(current) = parse_package_version(current_version) else {
        return false;
    };
    if candidate.major != current.major {
        return candidate.major < current.major;
    }
    if candidate.minor != current.minor {
        return candidate.minor < current.minor;
    }
    candidate.patch < current.patch
}

/// Strip a leading `v` and surrounding whitespace (TS
/// `normalizeReleaseVersion`).
pub fn normalize_release_version(version: &str) -> &str {
    version.trim().trim_start_matches('v')
}

/// The update channel of a version (TS `resolveUpdateChannel`): a preferred
/// channel wins; otherwise a `-beta*` prerelease stays on nightly and
/// anything else follows stable. Nightly builds are what the release
/// bucket publishes as beta.
pub fn resolve_update_channel(
    current_version: &str,
    preferred: Option<UpdateChannel>,
) -> UpdateChannel {
    if let Some(channel) = preferred {
        return channel;
    }
    match parse_package_version(current_version).and_then(|parsed| parsed.prerelease) {
        Some(prerelease) if prerelease.starts_with("beta") => UpdateChannel::Nightly,
        _ => UpdateChannel::Stable,
    }
}

/// The release channel (`beta.json` = nightly, `latest.json` = stable).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateChannel {
    Stable,
    Nightly,
}

impl UpdateChannel {
    /// The manifest file the channel publishes at the download base URL.
    pub fn manifest_path(self) -> &'static str {
        match self {
            Self::Stable => "latest.json",
            Self::Nightly => "beta.json",
        }
    }

    /// The channel's wire name (the TS `UpdateChannel` string values).
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Nightly => "nightly",
        }
    }

    /// Parse the wire name; an unknown value reads as unset (a preferred
    /// channel then infers from the running version).
    pub fn from_wire(wire: &str) -> Option<Self> {
        match wire {
            "stable" => Some(Self::Stable),
            "nightly" => Some(Self::Nightly),
            _ => None,
        }
    }
}

/// Whether `candidate_version` should replace `current_version` on the
/// effective channel (TS `isReleaseUpdateCandidate`): same-channel updates
/// must be strictly newer; an explicit switch to another channel accepts any
/// different version whose base version is not older, so a stable `1.2.3`
/// can move onto `1.2.3-beta.5` even though prerelease ordering ranks that
/// lower.
pub fn is_release_update_candidate(
    candidate_version: &str,
    current_version: &str,
    channel: Option<UpdateChannel>,
) -> bool {
    if is_newer_package_version(candidate_version, current_version) {
        return true;
    }
    let Some(channel) = channel else {
        return false;
    };
    if channel == resolve_update_channel(current_version, None) {
        return false;
    }
    if normalize_release_version(candidate_version) == normalize_release_version(current_version) {
        return false;
    }
    let Some(candidate) = parse_package_version(candidate_version) else {
        return true;
    };
    let Some(current) = parse_package_version(current_version) else {
        return true;
    };
    if candidate.major != current.major {
        return candidate.major > current.major;
    }
    if candidate.minor != current.minor {
        return candidate.minor > current.minor;
    }
    candidate.patch >= current.patch
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;

    use super::*;

    #[test]
    fn parses_and_compares_semver() {
        assert_eq!(parse_package_version("1.2.3").map(|v| v.major), Some(1));
        assert_eq!(
            parse_package_version("v1.2.3-beta.4+meta").map(|v| v.minor),
            Some(2)
        );
        assert_eq!(parse_package_version("junk"), None);
        assert_eq!(
            compare_package_versions("1.2.3", "1.2.3"),
            Some(Ordering::Equal)
        );
        assert_eq!(
            compare_package_versions("1.2.4", "1.2.3"),
            Some(Ordering::Greater)
        );
        assert_eq!(
            compare_package_versions("1.2.3-beta.4", "1.2.3"),
            Some(Ordering::Less)
        );
        assert_eq!(
            compare_package_versions("1.2.3-beta.2", "1.2.3-beta.10"),
            Some(Ordering::Less)
        );
        assert_eq!(compare_package_versions("x", "1.2.3"), None);
    }

    #[test]
    fn newer_and_downgrade_rules_match_ts() {
        assert!(is_newer_package_version("1.3.0", "v1.2.3"));
        assert!(!is_newer_package_version("1.2.3", "v1.2.3"));
        assert!(is_base_version_downgrade("1.2.2", "1.3.0"));
        assert!(!is_base_version_downgrade("1.2.3-beta.9", "1.2.3"));
        assert!(!is_base_version_downgrade("junk", "1.2.3"));
    }

    #[test]
    fn channel_and_candidate_rules_match_ts() {
        assert_eq!(
            resolve_update_channel("1.2.3-beta.4", None),
            UpdateChannel::Nightly
        );
        assert_eq!(resolve_update_channel("1.2.3", None), UpdateChannel::Stable);
        assert_eq!(
            resolve_update_channel("1.2.3", Some(UpdateChannel::Nightly)),
            UpdateChannel::Nightly
        );
        assert_eq!(UpdateChannel::Stable.manifest_path(), "latest.json");
        assert_eq!(UpdateChannel::Nightly.manifest_path(), "beta.json");
        // Same-channel updates must be strictly newer.
        assert!(!is_release_update_candidate("1.2.3", "1.2.4", None));
        assert!(is_release_update_candidate("1.2.4", "1.2.3", None));
        // A channel switch accepts an equal base with a different tag.
        assert!(is_release_update_candidate(
            "1.2.3-beta.5",
            "1.2.3",
            Some(UpdateChannel::Nightly)
        ));
        assert!(!is_release_update_candidate(
            "1.2.2",
            "1.2.3",
            Some(UpdateChannel::Nightly)
        ));
    }
}
