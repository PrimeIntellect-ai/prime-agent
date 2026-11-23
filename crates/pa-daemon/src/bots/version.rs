//! The bot runs the exact prime-agent version of the Mac that owns it.
//!
//! [`install_script`] installs that release in the guest from the GitHub release
//! Linux tarball, verified against the release `SHA256SUMS`. A build with no
//! published release (a dev build) cannot spawn bots unless
//! [`TARBALL_OVERRIDE_ENV`] names a local Linux tarball, which the manager
//! uploads through the exec stdin.

use std::path::PathBuf;

use anyhow::{Context, Result};

/// A local Linux release tarball to install instead of the published release.
pub const TARBALL_OVERRIDE_ENV: &str = "PRIME_AGENT_BOT_TARBALL";

/// The exit code [`install_script`] returns when the release is not published.
pub const UNPUBLISHED_EXIT_CODE: i32 = 3;

/// The version of this binary.
#[must_use]
pub fn local_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
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

/// Installs `$PA_VERSION` into the managed layout `pa-core::update::install`
/// resolves, installs uv when missing, and stops a daemon that runs another version.
pub const INSTALL_SCRIPT: &str = r#"set -euo pipefail
export HOME="${HOME:-/root}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
root="$HOME/.local/share/prime-agent"
asset="prime-agent-${PA_VERSION}-linux-x64.tar.gz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
if [ -n "${PA_TARBALL_BYTES:-}" ]; then
  head -c "$PA_TARBALL_BYTES" > "$asset"
  echo "${PA_TARBALL_SHA256}  $asset" | sha256sum -c - >/dev/null
else
  base="https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v${PA_VERSION}"
  if ! curl -fsSL -o SHA256SUMS "$base/SHA256SUMS" || ! curl -fsSL -o "$asset" "$base/$asset"; then
    echo "prime-agent ${PA_VERSION} has no published linux-x64 release" >&2
    exit 3
  fi
  awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 "  " f }' SHA256SUMS > expected
  test -s expected
  sha256sum -c expected >/dev/null
fi
sha="$(sha256sum "$asset" | cut -d' ' -f1)"
release="${PA_VERSION}-linux-x64-${sha}"
if command -v prime-agent >/dev/null 2>&1; then
  prime-agent shutdown --force >/dev/null 2>&1 || true
fi
mkdir -p "$root/releases/$release" "$root/bin" "$HOME/.local/bin"
tar -xzf "$asset" -C "$root/releases/$release"
chmod 0755 "$root/releases/$release/prime-agent"
printf 'prime-agent-native-v1\n' > "$root/.managed"
ln -sfn "../releases/$release/prime-agent" "$root/bin/prime-agent"
ln -sfn "$root/bin/prime-agent" "$HOME/.local/bin/prime-agent"
command -v uv >/dev/null 2>&1 || python3 -m pip install --quiet --root-user-action=ignore --disable-pip-version-check uv
test "$(prime-agent --version)" = "$PA_VERSION"
"#;
