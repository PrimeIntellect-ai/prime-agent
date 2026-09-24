//! The release manifest fetch (TS `version-check.ts` `getLatestPiRelease`
//! port): the channel manifest at the download base URL, validated with
//! the same rules so a malformed manifest can never stage a wrong binary.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::install::{current_platform_alias, KNOWN_PLATFORMS};
use super::version::{normalize_release_version, UpdateChannel};

/// One release artifact row (TS `NativeReleaseArtifact`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ReleaseArtifact {
    pub platform: String,
    pub file: String,
    pub sha256: String,
}

/// The channel manifest (TS `LatestPiRelease`): the version plus the
/// per-platform binary artifacts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LatestRelease {
    pub version: String,
    pub artifacts: Vec<ReleaseArtifact>,
}

#[derive(Debug, Deserialize)]
struct ManifestFile {
    version: String,
    #[serde(default)]
    binaries: Option<Vec<RawArtifact>>,
    /// The v2 schema (TS prefers it, v1 as fallback).
    #[serde(default)]
    binaries_v2: Option<Vec<RawArtifact>>,
    /// Unknown fields are ignored; TS reads `package`/`tarball` only for the
    /// npm path, which the Rust port does not serve.
    #[serde(flatten)]
    _rest: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct RawArtifact {
    platform: String,
    file: String,
    sha256: String,
}

/// The `User-Agent` of update requests (TS `getPiUserAgent` shape, with the
/// Rust runtime in the runtime slot).
pub fn update_user_agent(version: &str) -> String {
    format!(
        "prime-agent/{version} ({}; rust/{}; {})",
        std::env::consts::OS,
        env!("CARGO_PKG_VERSION"),
        std::env::consts::ARCH
    )
}

/// Fetch and validate the channel's latest release (TS `getLatestPiRelease`).
/// `PI_SKIP_VERSION_CHECK`/`PI_OFFLINE` short-circuit to `None`; a missing or
/// malformed manifest is `None`, never an error - `Planning` decides skip.
pub async fn latest_release(
    current_version: &str,
    channel: Option<UpdateChannel>,
    base_url: &str,
    timeout: Duration,
) -> Result<Option<LatestRelease>> {
    if std::env::var("PI_SKIP_VERSION_CHECK").is_ok() || std::env::var("PI_OFFLINE").is_ok() {
        return Ok(None);
    }
    let manifest_path =
        super::version::resolve_update_channel(current_version, channel).manifest_path();
    let url = format!("{}/{manifest_path}", base_url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", update_user_agent(current_version))
        .header("accept", "application/json")
        .timeout(timeout)
        .send()
        .await;
    let response = match response {
        Ok(response) if response.status().is_success() => response,
        // Network, timeout, and malformed-manifest failures all mean the
        // same thing here: nothing to install (TS parity).
        _ => return Ok(None),
    };
    let body = response
        .bytes()
        .await
        .context("read the release manifest")?;
    Ok(parse_channel_manifest(&body))
}

/// Parse and validate one channel-manifest body — the manifest half of
/// [`latest_release`] without the fetch. This is the byte contract the
/// release pipeline's channel-manifest producer (`release.yml`'s promote
/// job) must satisfy: the version normalizes to a non-empty string, the
/// v2 `binaries_v2` list wins over the v1 `binaries` fallback, and an
/// artifact row survives only when its platform is known, its `file` is
/// exactly `prime-agent-<version>-<platform>.tar.gz`, its `sha256` is 64
/// hex chars, and no supported platform repeats. A row that fails any of
/// that empties the artifact list (never the whole release); a body that
/// is not the manifest schema or carries no version is `None`.
pub fn parse_channel_manifest(body: &[u8]) -> Option<LatestRelease> {
    let manifest: ManifestFile = match serde_json::from_slice(body) {
        Ok(manifest) => manifest,
        Err(_) => return None,
    };
    let version = normalize_release_version(&manifest.version).to_string();
    if version.is_empty() {
        return None;
    }
    let Some(raw) = manifest.binaries_v2.or(manifest.binaries) else {
        return Some(LatestRelease {
            version,
            artifacts: Vec::new(),
        });
    };
    // Prefer the complete v2 schema, with v1 as a compatibility fallback.
    // Structurally valid entries for future platforms are ignored; malformed
    // or duplicate supported-platform entries reject the list (TS parity).
    let mut artifacts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for artifact in raw {
        if !KNOWN_PLATFORMS.contains(&artifact.platform.as_str()) {
            continue;
        }
        let file = format!("prime-agent-{version}-{}.tar.gz", artifact.platform);
        let sha_valid =
            artifact.sha256.len() == 64 && artifact.sha256.bytes().all(|b| b.is_ascii_hexdigit());
        if artifact.file != file || !sha_valid || !seen.insert(artifact.platform.clone()) {
            return Some(LatestRelease {
                version,
                artifacts: Vec::new(),
            });
        }
        artifacts.push(ReleaseArtifact {
            platform: artifact.platform,
            file: artifact.file,
            sha256: artifact.sha256,
        });
    }
    Some(LatestRelease { version, artifacts })
}

/// The artifact row for this platform, if the release carries one.
pub fn artifact_for_platform(release: &LatestRelease) -> Result<&ReleaseArtifact> {
    let platform = current_platform_alias();
    release
        .artifacts
        .iter()
        .find(|artifact| artifact.platform == platform)
        .ok_or_else(|| anyhow!("No verified compiled archive is available for {platform}."))
}

/// sha256 hex of one byte slice (shared by the download's streaming digest
/// checks and tests that build fixture archives).
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_artifact_rows_like_ts() {
        let release = LatestRelease {
            version: "1.2.3".into(),
            artifacts: vec![ReleaseArtifact {
                platform: "linux-x64".into(),
                file: "prime-agent-1.2.3-linux-x64.tar.gz".into(),
                sha256: "a".repeat(64),
            }],
        };
        assert!(artifact_for_platform(&release).is_ok() || current_platform_alias() != "linux-x64");
        let unknown = LatestRelease {
            version: "1.2.3".into(),
            artifacts: vec![ReleaseArtifact {
                platform: "future-platform".into(),
                file: "whatever".into(),
                sha256: "a".repeat(64),
            }],
        };
        assert!(artifact_for_platform(&unknown).is_err());
    }

    #[test]
    fn parse_channel_manifest_accepts_the_producer_shape() {
        // The shape release.yml's promote job emits: the version, a v1
        // `binaries` list (the four installer platforms), and the full
        // `binaries_v2` list whose rows are exactly the read-side contract.
        let sha = "a".repeat(64);
        let row = |platform: &str| {
            serde_json::json!({
                "platform": platform,
                "file": format!("prime-agent-1.2.3-{platform}.tar.gz"),
                "sha256": sha,
            })
        };
        let manifest = serde_json::json!({
            "version": "v1.2.3",
            "binaries": [row("linux-x64"), row("darwin-arm64")],
            "binaries_v2": [row("linux-x64"), row("darwin-arm64"), row("linux-arm64")],
        });
        let release = parse_channel_manifest(manifest.to_string().as_bytes()).unwrap();
        assert_eq!(release.version, "1.2.3");
        // binaries_v2 wins over the v1 fallback.
        assert_eq!(release.artifacts.len(), 3);
        assert!(release
            .artifacts
            .iter()
            .any(|artifact| artifact.platform == "linux-arm64"));
    }

    #[test]
    fn parse_channel_manifest_keeps_the_reader_guards() {
        // A row the reader cannot verify empties the artifacts (TS parity);
        // the release pipeline's producer gate refuses this shape upstream,
        // which is what the workflow test pins.
        let lying_row = serde_json::json!({
            "version": "v1.2.3",
            "binaries": [{
                "platform": "linux-x64",
                "file": "prime-agent-1.2.3-x86_64-unknown-linux-gnu.tar.gz",
                "sha256": "b".repeat(64),
            }],
        });
        let release = parse_channel_manifest(lying_row.to_string().as_bytes()).unwrap();
        assert_eq!(release.version, "1.2.3");
        assert!(release.artifacts.is_empty());
        // Not the manifest schema, or no version: None, never an error.
        assert!(parse_channel_manifest(b"{").is_none());
        assert!(parse_channel_manifest(br#"{"binaries": []}"#).is_none());
        // A version-only manifest is a release without verified artifacts.
        let version_only = parse_channel_manifest(br#"{"version": "v1.2.3"}"#).unwrap();
        assert_eq!(version_only.version, "1.2.3");
        assert!(version_only.artifacts.is_empty());
    }

    #[test]
    fn user_agent_keeps_the_ts_shape() {
        let agent = update_user_agent("1.2.3");
        assert!(agent.starts_with("prime-agent/1.2.3 ("));
        assert!(agent.contains("; rust/"));
    }
}
