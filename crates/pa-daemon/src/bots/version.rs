//! The bot runs the exact prime-agent version of the Mac that owns it.
//!
//! [`INSTALL_SCRIPT`] installs that release in the guest from the GitHub release
//! Linux tarball, verified against the release `SHA256SUMS`. A build with no
//! published release (a dev build) installs a linux-x64 tarball of its own
//! build instead: [`TARBALL_OVERRIDE_ENV`], or the tarball `make bot-tarball`
//! puts next to the binary. The manager uploads it through the exec stdin.

use std::path::PathBuf;

use anyhow::{Context, Result};

/// A local Linux release tarball to install instead of the published release.
pub const TARBALL_OVERRIDE_ENV: &str = "PRIME_AGENT_BOT_TARBALL";

/// The exit code [`INSTALL_SCRIPT`] returns when the release is not published.
pub const UNPUBLISHED_EXIT_CODE: i32 = 3;

/// The exit code [`INSTALL_SCRIPT`] returns when the local tarball is another version.
pub const TARBALL_VERSION_EXIT_CODE: i32 = 4;

/// The exit code [`INSTALL_SCRIPT`] returns when the installed build has no
/// bot guest side (`prime-agent relay --probe` fails).
pub const NO_GUEST_EXIT_CODE: i32 = 5;

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
    /// [`TARBALL_OVERRIDE_ENV`] when set, else [`tarball_name`] next to this
    /// binary when it exists, else the published release.
    #[must_use]
    pub fn resolve() -> Self {
        if let Some(path) = std::env::var_os(TARBALL_OVERRIDE_ENV).filter(|path| !path.is_empty()) {
            return Self::LocalTarball(PathBuf::from(path));
        }
        std::env::current_exe()
            .ok()
            .and_then(|exe| Some(exe.parent()?.join(tarball_name(local_version()))))
            .filter(|path| path.is_file())
            .map_or(Self::Published, Self::LocalTarball)
    }
}

/// The linux-x64 release tarball name of `version`.
#[must_use]
pub fn tarball_name(version: &str) -> String {
    format!("prime-agent-{version}-linux-x64.tar.gz")
}

/// Checks the guest still holds the tarball copy (`$PA_GUEST_TARBALL`).
/// A fixed script, so tests recognize it next to the other guest scripts.
pub const TARBALL_CHECK_SCRIPT: &str = r#"test -s "$PA_GUEST_TARBALL""#;

/// Restores the guest's tarball copy from stdin (`$PA_GUEST_TARBALL`,
/// `$PA_TARBALL_BYTES`).
pub const TARBALL_RESTORE_SCRIPT: &str = r#"mkdir -p "$(dirname "$PA_GUEST_TARBALL")" && head -c "$PA_TARBALL_BYTES" > "$PA_GUEST_TARBALL""#;

/// Where [`INSTALL_SCRIPT`] keeps a local tarball inside the guest, so a
/// bot that spawns bots can install the same build into its children.
pub const GUEST_TARBALL_DIR: &str = "/root/.prime-agent-bot-tarball";

/// The tarball a bot's own daemon installs its children from, when this
/// machine installs from a local tarball.
#[must_use]
pub fn guest_tarball_path(version: &str) -> String {
    format!("{GUEST_TARBALL_DIR}/{}", tarball_name(version))
}

/// One install run: the script env and the local tarball, if any.
#[derive(Debug, Clone)]
pub struct Install {
    pub env: Vec<(String, String)>,
    /// The local tarball. The manager uploads it over the gateway transfer
    /// endpoint, or writes it to the exec stream when that fails.
    pub tarball: Option<Vec<u8>>,
}

impl Install {
    /// The guest path a local tarball is uploaded to. The install script
    /// removes it.
    pub const UPLOAD_PATH: &'static str = "/root/.prime-agent-install.tar.gz";

    /// Prepare the install of `version` from `source`.
    ///
    /// # Errors
    /// Returns an error when the local tarball cannot be read.
    pub fn prepare(version: &str, source: &ReleaseSource) -> Result<Self> {
        let mut env = vec![("PA_VERSION".to_string(), version.to_string())];
        let tarball = match source {
            ReleaseSource::Published => None,
            ReleaseSource::LocalTarball(path) => {
                let bytes = std::fs::read(path)
                    .with_context(|| format!("read {TARBALL_OVERRIDE_ENV}={}", path.display()))?;
                env.push(("PA_TARBALL_BYTES".into(), bytes.len().to_string()));
                env.push(("PA_TARBALL_SHA256".into(), super::sha256_hex(&bytes)));
                Some(bytes)
            }
        };
        Ok(Self { env, tarball })
    }
}

/// The message for an [`INSTALL_SCRIPT`] exit code that names a known
/// failure, `None` for any other exit code.
#[must_use]
pub fn install_failure(exit_code: i32, version: &str) -> Option<String> {
    let build_one = format!(
        "run `make bot-tarball` in this build's checkout, or set {TARBALL_OVERRIDE_ENV} \
         to a linux-x64 tarball of this build"
    );
    match exit_code {
        UNPUBLISHED_EXIT_CODE => Some(format!(
            "prime-agent {version} has no published Linux release, so a bot cannot run it. \
             Use a released build, or {build_one}."
        )),
        TARBALL_VERSION_EXIT_CODE => Some(format!(
            "the bot tarball is not prime-agent {version}: {build_one}."
        )),
        NO_GUEST_EXIT_CODE => Some(format!(
            "the bot's prime-agent {version} has no bot guest support. \
             Bots need a release that contains it; for this build, {build_one}."
        )),
        _ => None,
    }
}

/// Prints the guest's `prime-agent --version` when it has the bot guest
/// side and the tools the installer adds (Node.js with npm, and `gh`),
/// else nothing (the manager then installs). A guest whose install half
/// failed (prime-agent in place, a tool download not) reports nothing, so
/// the idempotent installer runs again.
pub const GUEST_VERSION_SCRIPT: &str = r#"export PATH="$HOME/.local/bin:$PATH"
command -v prime-agent >/dev/null 2>&1 && prime-agent relay --probe >/dev/null 2>&1 \
  && command -v node >/dev/null 2>&1 && command -v gh >/dev/null 2>&1 \
  && prime-agent --version || true
"#;

/// Fetches the `$PA_VERSION` linux-x64 release tarball (or takes the local
/// one the manager uploaded, or wrote to stdin), verifies it, and installs
/// it with the release's own `install.sh --archive`. That installer writes
/// the managed layout the self-update reads, installs uv, and stops a daemon
/// that runs another version. The install fails when the build has no bot
/// guest side. Its `guest_tool` step installs the pinned tools the bot image
/// lacks (Node.js with npm, and the GitHub CLI).
pub const INSTALL_SCRIPT: &str = r#"set -euo pipefail
export HOME="${HOME:-/root}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
asset="prime-agent-${PA_VERSION}-linux-x64.tar.gz"
work="$(mktemp -d)"
trap 'rm -rf "$work"; rm -f "${PA_TARBALL_PATH:-}"' EXIT
cd "$work"
local_tarball=""
if [ -n "${PA_TARBALL_PATH:-}" ]; then
  # The daemon uploaded the tarball over the gateway transfer endpoint.
  test -f "$PA_TARBALL_PATH"
  echo "${PA_TARBALL_SHA256}  $PA_TARBALL_PATH" | sha256sum -c - >/dev/null
  mv "$PA_TARBALL_PATH" "$asset"
  local_tarball=1
elif [ -n "${PA_TARBALL_BYTES:-}" ]; then
  # Fallback: the daemon wrote the tarball to this process's stdin.
  head -c "$PA_TARBALL_BYTES" > "$asset"
  echo "${PA_TARBALL_SHA256}  $asset" | sha256sum -c - >/dev/null
  local_tarball=1
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
if [ -n "$local_tarball" ]; then
  tar -xzf "$asset" package.json
  tarball_version="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
  if [ "$tarball_version" != "$PA_VERSION" ]; then
    echo "the bot tarball is prime-agent ${tarball_version}, not ${PA_VERSION}" >&2
    exit 4
  fi
  # A bot that spawns bots installs its children from this same tarball.
  mkdir -p /root/.prime-agent-bot-tarball
  cp "$asset" /root/.prime-agent-bot-tarball/
fi
if command -v prime-agent >/dev/null 2>&1; then
  prime-agent shutdown --force >/dev/null 2>&1 || true
fi
tar -xzf "$asset" install.sh
sh ./install.sh --archive "$work/$asset" --force
test "$(prime-agent --version)" = "$PA_VERSION"
if ! prime-agent relay --probe >/dev/null 2>&1; then
  echo "prime-agent ${PA_VERSION} has no bot guest support" >&2
  exit 5
fi
# Guest tools the bot image lacks: one pinned, checksummed tarball each,
# unpacked to /opt/<command> with its bin/ linked onto PATH. The bot image
# already carries both, so these are no-ops there.
guest_tool() { # guest_tool COMMAND URL SHA256
  command -v "$1" >/dev/null 2>&1 && return 0
  curl -fsSL --retry 3 -o "$1.tar.gz" "$2"
  echo "$3  $1.tar.gz" | sha256sum -c - >/dev/null
  mkdir -p "/opt/$1"
  tar -xzf "$1.tar.gz" -C "/opt/$1" --strip-components=1 --no-same-owner
  ln -sf "/opt/$1"/bin/* /usr/local/bin/
}
guest_tool node https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-x64.tar.gz \
  c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1
guest_tool gh https://github.com/cli/cli/releases/download/v2.105.0/gh_2.105.0_linux_amd64.tar.gz \
  79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f
"#;
