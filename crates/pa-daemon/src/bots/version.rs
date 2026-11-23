//! The bot runs the exact prime-agent version of the Mac that owns it.
//!
//! [`INSTALL_SCRIPT`] installs that release in the guest from the GitHub release
//! Linux tarball, verified against the release `SHA256SUMS`. A build with no
//! published release (a dev build) cannot spawn bots unless
//! [`TARBALL_OVERRIDE_ENV`] names a local Linux tarball, which the manager
//! uploads through the exec stdin.

use std::path::PathBuf;

use anyhow::{Context, Result};

/// A local Linux release tarball to install instead of the published release.
pub const TARBALL_OVERRIDE_ENV: &str = "PRIME_AGENT_BOT_TARBALL";

/// The exit code [`INSTALL_SCRIPT`] returns when the release is not published.
pub const UNPUBLISHED_EXIT_CODE: i32 = 3;

/// The product version of this binary (the version the daemon hello reports).
#[must_use]
pub fn local_version() -> &'static str {
    crate::protocol::app_version()
}

/// Where the guest gets the release from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseSource {
    /// The GitHub release of this version.
    Published,
    /// A local tarball, uploaded through the exec stdin.
    LocalTarball(PathBuf),
}

impl ReleaseSource {
    /// [`TARBALL_OVERRIDE_ENV`] when set, else the published release.
    #[must_use]
    pub fn from_env() -> Self {
        match std::env::var_os(TARBALL_OVERRIDE_ENV) {
            Some(path) if !path.is_empty() => Self::LocalTarball(PathBuf::from(path)),
            _ => Self::Published,
        }
    }
}

/// One install run: the script env and the optional stdin payload.
#[derive(Debug, Clone)]
pub struct Install {
    pub env: Vec<(String, String)>,
    pub stdin: Option<Vec<u8>>,
}

impl Install {
    /// Prepare the install of `version` from `source`.
    ///
    /// # Errors
    /// Returns an error when the local tarball cannot be read.
    pub fn prepare(version: &str, source: &ReleaseSource) -> Result<Self> {
        let mut env = vec![("PA_VERSION".to_string(), version.to_string())];
        let stdin = match source {
            ReleaseSource::Published => None,
            ReleaseSource::LocalTarball(path) => {
                let bytes = std::fs::read(path)
                    .with_context(|| format!("read {TARBALL_OVERRIDE_ENV}={}", path.display()))?;
                env.push(("PA_TARBALL_BYTES".into(), bytes.len().to_string()));
                env.push(("PA_TARBALL_SHA256".into(), super::sha256_hex(&bytes)));
                Some(bytes)
            }
        };
        Ok(Self { env, stdin })
    }
}

/// The message for a guest install that found no published release.
#[must_use]
pub fn unpublished_message(version: &str) -> String {
    format!(
        "prime-agent {version} has no published Linux release, so a bot cannot run it. \
         Use a released build, or set {TARBALL_OVERRIDE_ENV} to a local linux-x64 release tarball."
    )
}

/// Prints the guest's `prime-agent --version`, or nothing when it is not installed.
pub const GUEST_VERSION_SCRIPT: &str = r#"export PATH="$HOME/.local/bin:$PATH"
command -v prime-agent >/dev/null 2>&1 && prime-agent --version || true
"#;

/// Fetches the `$PA_VERSION` linux-x64 release tarball (or reads it from
/// stdin), verifies it, and installs it with the release's own `install.sh
/// --archive`. That installer writes the managed layout the self-update reads,
/// installs uv, and stops a daemon that runs another version.
pub const INSTALL_SCRIPT: &str = r#"set -euo pipefail
export HOME="${HOME:-/root}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
asset="prime-agent-${PA_VERSION}-linux-x64.tar.gz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
if [ -n "${PA_TARBALL_BYTES:-}" ]; then
  head -c "$PA_TARBALL_BYTES" > "$asset"
  echo "${PA_TARBALL_SHA256}  $asset" | sha256sum -c - >/dev/null
else
  base="https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v${PA_VERSION}"
  status="$(curl -sSL --retry 3 -o SHA256SUMS -w '%{http_code}' "$base/SHA256SUMS" || true)"
  if [ "$status" = 404 ]; then
    echo "prime-agent ${PA_VERSION} has no published linux-x64 release" >&2
    exit 3
  fi
  test "$status" = 200
  curl -fsSL --retry 3 -o "$asset" "$base/$asset"
  awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 "  " f }' SHA256SUMS > expected
  test -s expected
  sha256sum -c expected >/dev/null
fi
if command -v prime-agent >/dev/null 2>&1; then
  prime-agent shutdown --force >/dev/null 2>&1 || true
fi
tar -xzf "$asset" install.sh
sh ./install.sh --archive "$work/$asset" --force
test "$(prime-agent --version)" = "$PA_VERSION"
"#;
