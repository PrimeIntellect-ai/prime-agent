//! The installer-takeover update funnel: `prime-agent update` and the TUI's
//! `/update` download the `rust` branch's `install-rust.sh` and run it.
//! The script is the single source of truth for the whole move — it
//! resolves and downloads the latest `continuous` build, uninstalls the
//! TypeScript version, publishes the payload, and never touches
//! `~/.prime/agent` (the sessions and configuration the products share).
//! This module only fetches and execs the script, then reports what
//! landed; every install/uninstall decision stays in the script the
//! installer-takeover lane owns, so the two surfaces can never drift from
//! it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};

use super::release::update_user_agent;

/// `PRIME_AGENT_RUST_REPO`: the installer's own repo knob (the funnel reads
/// the same environment, so the script and the report always agree).
pub const ENV_REPO: &str = "PRIME_AGENT_RUST_REPO";
/// `PRIME_AGENT_RUST_PREFIX`: the installer's own prefix knob (the launcher
/// probe reads the same value the script installs under).
pub const ENV_PREFIX: &str = "PRIME_AGENT_RUST_PREFIX";
/// `PRIME_AGENT_RUST_INSTALLER_URL`: the installer script URL override —
/// tests serve their own script, a pinned install can point elsewhere.
pub const ENV_INSTALLER_URL: &str = "PRIME_AGENT_RUST_INSTALLER_URL";
/// `GITHUB_TOKEN`: the installer's own artifact-auth knob, sent on the
/// run-list request when set (the run list is public; the token only lifts
/// the anonymous rate limit).
pub const ENV_GITHUB_TOKEN: &str = "GITHUB_TOKEN";

/// The repo the installer and the run report resolve from.
pub const DEFAULT_REPO: &str = "PrimeIntellect-ai/prime-agent";
/// The workflow whose artifacts the installer downloads (the same name
/// the script's run-list query uses).
pub const WORKFLOW: &str = "continuous";
/// The branch the installer script and the continuous runs resolve from.
pub const BRANCH: &str = "rust";
/// The installer script's file name on the branch.
pub const SCRIPT_NAME: &str = "install-rust.sh";

/// The small-file budget for the script download (the script is a few KB;
/// a hung fetch must not hang the update).
const SCRIPT_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// The run-list request budget (`--check`'s report is a quick read).
const RUN_LIST_TIMEOUT: Duration = Duration::from_secs(10);
/// The launcher `--version` probe budget (the same bound the release
/// probe uses; a hung launcher must not hang the report).
const LAUNCHER_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// The repo the update installs from (`PRIME_AGENT_RUST_REPO`, the
/// installer's default).
pub fn repo() -> String {
    std::env::var(ENV_REPO)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_REPO.to_string())
}

/// The installer script URL: the branch's raw file by default
/// (`PRIME_AGENT_RUST_INSTALLER_URL` overrides it).
pub fn installer_script_url() -> String {
    if let Ok(url) = std::env::var(ENV_INSTALLER_URL) {
        if !url.trim().is_empty() {
            return url;
        }
    }
    format!(
        "https://raw.githubusercontent.com/{}/{BRANCH}/{SCRIPT_NAME}",
        repo()
    )
}

/// The install prefix the launcher probe reads (`PRIME_AGENT_RUST_PREFIX`,
/// the installer's own `~/.local` default).
pub fn install_prefix() -> PathBuf {
    if let Some(prefix) = std::env::var_os(ENV_PREFIX) {
        if !prefix.is_empty() {
            return PathBuf::from(prefix);
        }
    }
    pa_types::platform::home_dir()
        .unwrap_or_default()
        .join(".local")
}

/// The continuous matrix's target triple for one platform pair
/// (`std::env::consts`' vocabulary: the installer's own `uname -s`/`-m`
/// mapping over the same four targets).
#[must_use]
pub fn target_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        _ => None,
    }
}

/// The target triple this machine's update would install (the same matrix
/// the installer refuses with, so the failure names it identically).
///
/// # Errors
/// Returns an error naming the machine when no continuous build is
/// published for its platform.
pub fn current_target() -> Result<&'static str> {
    target_for(std::env::consts::OS, std::env::consts::ARCH).ok_or_else(|| {
        anyhow!(
            "no rust build is published for {} {} (the continuous matrix \
             builds aarch64-apple-darwin, x86_64-apple-darwin, \
             aarch64-unknown-linux-gnu, and x86_64-unknown-linux-gnu)",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })
}

/// The commit a running version's `-continuous.<sha>` stamp names — the
/// identity `--check` compares against the latest run's `head_sha`.
#[must_use]
pub fn running_commit(version: &str) -> Option<&str> {
    let (_, commit) = version.trim().rsplit_once("-continuous.")?;
    let hex =
        (7..=40).contains(&commit.len()) && commit.bytes().all(|byte| byte.is_ascii_hexdigit());
    hex.then_some(commit)
}

/// One resolved continuous run (`--check`'s "latest available"): the run
/// the installer would download from, and the exact commit it built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContinuousRun {
    pub id: u64,
    pub commit: String,
}

/// The newest successful `continuous` run on the branch — the same query
/// the installer's non-`gh` path sends (`--check` only reads it; nothing
/// downloads). `GITHUB_TOKEN`, when set, is sent as the bearer (the same
/// token the installer itself would use).
///
/// # Errors
/// Returns an error when the request or the response read fails; a run
/// list with no successful run is an error too — there is nothing to
/// report against.
pub async fn latest_continuous_run() -> Result<ContinuousRun> {
    let url = format!(
        "https://api.github.com/repos/{}/actions/workflows/{WORKFLOW}.yml/runs?branch={BRANCH}&status=success&per_page=1",
        repo()
    );
    let mut request = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", update_user_agent(env!("CARGO_PKG_VERSION")))
        .header("accept", "application/vnd.github+json")
        .timeout(RUN_LIST_TIMEOUT);
    if let Ok(token) = std::env::var(ENV_GITHUB_TOKEN) {
        if !token.trim().is_empty() {
            request = request.bearer_auth(token);
        }
    }
    let response = request
        .send()
        .await
        .with_context(|| format!("request the {WORKFLOW} run list in {}", repo()))?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .with_context(|| "read the run list body")?;
    if !status.is_success() {
        anyhow::bail!("the {WORKFLOW} run list in {} answered {status}", repo());
    }
    parse_runs(&body).ok_or_else(|| {
        anyhow!(
            "no successful {WORKFLOW} run is listed for {BRANCH} in {}",
            repo()
        )
    })
}

/// Parse the run-list body's newest run (the fetch half of
/// [`latest_continuous_run`] without the network).
#[must_use]
pub fn parse_runs(body: &[u8]) -> Option<ContinuousRun> {
    #[derive(serde::Deserialize)]
    struct RunRow {
        id: u64,
        head_sha: String,
    }
    #[derive(serde::Deserialize)]
    struct RunsDocument {
        #[serde(default)]
        workflow_runs: Vec<RunRow>,
    }
    let document: RunsDocument = serde_json::from_slice(body).ok()?;
    let run = document.workflow_runs.first()?;
    let commit = run.head_sha.trim().to_string();
    (!commit.is_empty()).then_some(ContinuousRun { id: run.id, commit })
}

/// Where the installer's output goes while it runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallerOutput {
    /// The CLI's run: the installer's own progress streams to the user's
    /// terminal.
    Inherit,
    /// The TUI's run: the output is captured (the live frame stays intact)
    /// and the failure tail becomes the message.
    Capture,
}

/// What a completed installer run landed: the new build's version line
/// (the launcher's own `--version` answer), when the probe found one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub version: Option<String>,
}

/// Why an update run failed: the actionable message the surfaces print
/// (the CLI as its `Error:` line, the TUI as the error row).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateFailure {
    pub message: String,
}

/// Run the takeover update with the environment's knobs (the script URL
/// and the install prefix): the composition root's entry.
///
/// # Errors
/// Returns the failure message for every non-installing outcome (see
/// [`run_installer_from`]).
pub async fn run_installer(
    output: InstallerOutput,
) -> std::result::Result<Installed, UpdateFailure> {
    run_installer_from(&installer_script_url(), &install_prefix(), output).await
}

/// Run the takeover update from one explicit script URL and install
/// prefix: platform preflight, fetch the branch's installer script, and
/// exec it with the environment passed through (the installer's own
/// `PRIME_AGENT_RUST_*` knobs and `GITHUB_TOKEN` ride the process
/// environment; the script owns download, the TypeScript uninstall, the
/// publish, and the `~/.prime/agent` preserve). On success the
/// launcher's `--version` answers the new version; on failure the
/// previous install is kept (the script's own rollback covers a
/// mid-publish crash).
///
/// # Errors
/// Returns the failure message for every non-installing outcome: an
/// unsupported platform, a script download that failed, or an installer
/// run that exited nonzero.
pub async fn run_installer_from(
    url: &str,
    prefix: &Path,
    output: InstallerOutput,
) -> std::result::Result<Installed, UpdateFailure> {
    current_target().map_err(|error| UpdateFailure {
        message: format!("{error:#}"),
    })?;
    let script = fetch_script(url).await.map_err(|error| UpdateFailure {
        message: format!("could not download the installer from {url}: {error:#}"),
    })?;
    execute_script(&script, prefix, output).await?;
    let version = launcher_version(prefix).await;
    Ok(Installed { version })
}

/// Fetch the installer script to a per-run temp file (the small-file
/// budget; the file is the exact bytes the branch serves).
///
/// # Errors
/// Returns an error when the request fails, answers a non-success status,
/// or the body cannot be read or written.
async fn fetch_script(url: &str) -> Result<PathBuf> {
    let response = reqwest::Client::new()
        .get(url)
        .header("User-Agent", update_user_agent(env!("CARGO_PKG_VERSION")))
        .timeout(SCRIPT_FETCH_TIMEOUT)
        .send()
        .await
        .with_context(|| format!("request {url}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .with_context(|| "read the installer script")?;
    if !status.is_success() {
        anyhow::bail!("download {url} returned {status}");
    }
    if bytes.is_empty() {
        anyhow::bail!("the installer script at {url} was empty");
    }
    let script = std::env::temp_dir().join(format!(
        "prime-agent-update-{}.sh",
        uuid::Uuid::now_v7().simple()
    ));
    std::fs::write(&script, &bytes).with_context(|| format!("write {}", script.display()))?;
    Ok(script)
}

/// Exec the downloaded script (`/bin/sh`, the same interpreter the
/// curl|sh one-liner uses, at the trusted absolute path so a poisoned
/// `PATH` cannot substitute the interpreter that runs the installer with
/// the inherited `GITHUB_TOKEN`) and wait for it. The install prefix rides
/// the child's environment as the installer's own knob, so the script
/// publishes exactly where the probe looks — every other
/// `PRIME_AGENT_RUST_*` knob and `GITHUB_TOKEN` pass through untouched.
/// The script's own die messages already streamed with
/// [`InstallerOutput::Inherit`]; with [`InstallerOutput::Capture`] the
/// tail becomes the failure message.
///
/// # Errors
/// Returns the failure when the script cannot start or exits nonzero.
async fn execute_script(
    script: &Path,
    prefix: &Path,
    output: InstallerOutput,
) -> std::result::Result<(), UpdateFailure> {
    let mut command = tokio::process::Command::new("/bin/sh");
    command.arg(script).env(ENV_PREFIX, prefix);
    match output {
        InstallerOutput::Inherit => {
            let status = command.status().await.map_err(|error| UpdateFailure {
                message: format!("could not run the installer: {error}"),
            })?;
            if status.success() {
                return Ok(());
            }
            Err(UpdateFailure {
                message: match status.code() {
                    Some(code) => format!(
                        "the installer exited with code {code}; the previous install was kept"
                    ),
                    None => {
                        "the installer was terminated by a signal; the previous install was kept"
                            .to_string()
                    }
                },
            })
        }
        InstallerOutput::Capture => {
            let captured = command.output().await.map_err(|error| UpdateFailure {
                message: format!("could not run the installer: {error}"),
            })?;
            if captured.status.success() {
                return Ok(());
            }
            let tail = output_tail(&captured);
            let detail = tail.map_or_else(String::new, |tail| format!(":\n{tail}"));
            Err(UpdateFailure {
                message: match captured.status.code() {
                    Some(code) => {
                        format!("the installer exited with code {code}{detail}")
                    }
                    None => {
                        format!("the installer was terminated by a signal{detail}")
                    }
                },
            })
        }
    }
}

/// The last informative lines of a captured installer run (the script's
/// die messages go to stderr; a silent failure falls back to stdout's
/// last line).
fn output_tail(captured: &std::process::Output) -> Option<String> {
    let stderr = String::from_utf8_lossy(&captured.stderr);
    let mut last_stderr: Vec<String> = stderr
        .lines()
        .rev()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .take(3)
        .collect();
    if last_stderr.is_empty() {
        let stdout = String::from_utf8_lossy(&captured.stdout);
        last_stderr = stdout
            .lines()
            .rev()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .take(1)
            .collect();
    }
    last_stderr.reverse();
    let joined = last_stderr.join("\n");
    (!joined.is_empty()).then_some(joined)
}

/// The installed launcher's `--version` answer, when one is there: the
/// takeover layout's `bin/prime-agent` first, the pre-takeover
/// `bin/prime-agent-rust` second, and only answers stamped
/// `-continuous.<commit>` count — the TypeScript product's own
/// `bin/prime-agent` (still present until the takeover's uninstall) never
/// matches, so the probe can never report its version.
async fn launcher_version(prefix: &Path) -> Option<String> {
    for name in ["prime-agent", "prime-agent-rust"] {
        let launcher = prefix.join("bin").join(name);
        if !launcher.is_file() {
            continue;
        }
        let probe = tokio::process::Command::new(&launcher)
            .arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .output();
        let Ok(output) = tokio::time::timeout(LAUNCHER_PROBE_TIMEOUT, probe).await else {
            continue;
        };
        let Ok(output) = output else {
            continue;
        };
        let first = String::from_utf8_lossy(&output.stdout);
        let version = first.lines().next().map(str::trim).unwrap_or_default();
        if running_commit(version).is_some() {
            return Some(version.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serve `body` over one plain HTTP request (the hermetic source the
    /// funnel fetches its mock installer from): bind an ephemeral loopback
    /// socket, answer the first request, return the URL the funnel uses.
    /// Unix only: its callers are the unix shell-installer tests.
    #[cfg(unix)]
    fn serve(body: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("local address");
        std::thread::spawn(move || {
            use std::io::Write as _;
            if let Ok((mut stream, _)) = listener.accept() {
                // Read the request head first: answering before the
                // request is drained can reset the connection mid-write
                // (the client then reports a broken response).
                let mut head = Vec::new();
                let mut byte = [0_u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    match std::io::Read::read(&mut stream, &mut byte) {
                        Ok(0) | Err(_) => return,
                        Ok(_) => head.push(byte[0]),
                    }
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{address}/{SCRIPT_NAME}")
    }

    /// The sandboxed preserve fixture: a session file under a home the
    /// installer world shares (`<home>/.prime/agent/sessions/…`), with
    /// its exact bytes snapshotted for the byte-identity assert.
    struct Preserve {
        // The byte-identity readers are the unix `assert_untouched`
        // checks; on other platforms the fixture only stages the file.
        #[cfg_attr(not(unix), allow(dead_code))]
        session_file: PathBuf,
        #[cfg_attr(not(unix), allow(dead_code))]
        bytes: Vec<u8>,
    }

    impl Preserve {
        fn new(root: &Path) -> Self {
            let session_file = root
                .join("home")
                .join(".prime/agent/sessions/session.jsonl");
            std::fs::create_dir_all(session_file.parent().expect("session dir"))
                .expect("session dir");
            let bytes =
                b"{\"type\":\"user_message\",\"content\":\"the session the update must preserve\"}\n"
                    .to_vec();
            std::fs::write(&session_file, &bytes).expect("write session file");
            Self {
                session_file,
                bytes,
            }
        }

        /// The session store must survive the update byte-identical.
        /// Unix only: the update-flow tests that read the snapshot sit
        /// behind the unix gate.
        #[cfg(unix)]
        fn assert_untouched(&self) {
            let observed =
                std::fs::read(&self.session_file).expect("session file survives the update");
            assert_eq!(
                observed, self.bytes,
                "the session store is byte-identical after the update"
            );
        }
    }

    /// The mock installer the funnel downloads in the tests: it installs a
    /// launcher that answers a stamped `--version`, exactly the takeover's
    /// contract (the real script's own artifact download stays the
    /// installer-takeover lane's sandbox test). Unix only: the script is
    /// `#!/bin/sh` and its users are the unix installer tests.
    #[cfg(unix)]
    const MOCK_INSTALLER: &str = r#"#!/bin/sh
set -eu
mkdir -p "${PRIME_AGENT_RUST_PREFIX}/bin"
printf '#!/bin/sh\necho "9.9.9-continuous.0123456789abcdef"\n' > "${PRIME_AGENT_RUST_PREFIX}/bin/prime-agent"
chmod 0755 "${PRIME_AGENT_RUST_PREFIX}/bin/prime-agent"
echo "installed: 9.9.9-continuous.0123456789abcdef"
"#;

    /// The pre-takeover installer: the launcher carries the legacy
    /// `prime-agent-rust` name the probe still accepts. Unix only: same
    /// sh-script class as [`MOCK_INSTALLER`].
    #[cfg(unix)]
    const LEGACY_INSTALLER: &str = r#"#!/bin/sh
set -eu
mkdir -p "${PRIME_AGENT_RUST_PREFIX}/bin"
printf '#!/bin/sh\necho "9.9.8-continuous.fedcba9876543210"\n' > "${PRIME_AGENT_RUST_PREFIX}/bin/prime-agent-rust"
chmod 0755 "${PRIME_AGENT_RUST_PREFIX}/bin/prime-agent-rust"
echo "installed: 9.9.8-continuous.fedcba9876543210"
"#;

    fn sandbox() -> (tempfile::TempDir, Preserve, PathBuf) {
        let root = tempfile::tempdir().expect("sandbox root");
        let preserve = Preserve::new(root.path());
        let prefix = root.path().join("prefix/.local");
        std::fs::create_dir_all(&prefix).expect("prefix");
        (root, preserve, prefix)
    }

    #[test]
    fn the_target_matrix_covers_the_continuous_builds() {
        assert_eq!(target_for("macos", "aarch64"), Some("aarch64-apple-darwin"));
        assert_eq!(target_for("macos", "x86_64"), Some("x86_64-apple-darwin"));
        assert_eq!(
            target_for("linux", "x86_64"),
            Some("x86_64-unknown-linux-gnu")
        );
        assert_eq!(
            target_for("linux", "aarch64"),
            Some("aarch64-unknown-linux-gnu")
        );
        assert_eq!(target_for("windows", "x86_64"), None);
        assert!(
            current_target().is_ok(),
            "the test matrix runs on a supported platform"
        );
    }

    #[test]
    fn running_commit_reads_the_continuous_stamp() {
        assert_eq!(
            running_commit("0.5.2-continuous.07f42eaa3a6159f942c6c24beb0352ce120a192c"),
            Some("07f42eaa3a6159f942c6c24beb0352ce120a192c")
        );
        assert_eq!(
            running_commit(" 9.9.9-continuous.0123456 "),
            Some("0123456")
        );
        assert_eq!(
            running_commit("0.5.2"),
            None,
            "a dev build carries no stamp"
        );
        assert_eq!(
            running_commit("2.31.4"),
            None,
            "the TypeScript product's version never reads as a rust commit"
        );
    }

    #[test]
    fn the_run_list_parse_takes_the_newest_successful_run() {
        let run = parse_runs(
            br#"{"total_count": 3, "workflow_runs": [
                {"id": 42424242, "head_sha": "07f42eaa3a6159f942c6c24beb0352ce120a192c"}
            ]}"#,
        )
        .expect("the run parses");
        assert_eq!(run.id, 42_424_242);
        assert_eq!(run.commit, "07f42eaa3a6159f942c6c24beb0352ce120a192c");
        assert!(
            parse_runs(br#"{"workflow_runs": []}"#).is_none(),
            "an empty run list reports nothing"
        );
        assert!(parse_runs(b"not json").is_none());
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn the_funnel_runs_the_downloaded_installer_and_preserves_the_session_store() {
        let (root, preserve, prefix) = sandbox();
        let installed =
            run_installer_from(&serve(MOCK_INSTALLER), &prefix, InstallerOutput::Capture)
                .await
                .expect("the funnel installs the mock build");
        assert_eq!(
            installed.version.as_deref(),
            Some("9.9.9-continuous.0123456789abcdef"),
            "the probe reads the launcher's own --version answer"
        );
        let launcher = prefix.join("bin/prime-agent");
        assert!(launcher.is_file(), "the launcher landed");
        let mode = std::fs::metadata(&launcher).expect("launcher metadata");
        assert!(unix_mode_is_executable(&mode), "the launcher is executable");
        preserve.assert_untouched();
        drop(root);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn the_probe_still_reads_a_pre_takeover_launchers_version() {
        let (root, _preserve, prefix) = sandbox();
        let installed =
            run_installer_from(&serve(LEGACY_INSTALLER), &prefix, InstallerOutput::Capture)
                .await
                .expect("the funnel installs the legacy-named build");
        assert_eq!(
            installed.version.as_deref(),
            Some("9.9.8-continuous.fedcba9876543210"),
            "the pre-takeover launcher answers through the probe"
        );
        drop(root);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn a_failed_installer_keeps_the_previous_install_and_reports_the_error() {
        let (root, preserve, prefix) = sandbox();
        // A previous install exists; the failing script must leave it in
        // place (the real script's own rollback is its lane's contract;
        // the funnel's contract is to change nothing itself).
        std::fs::create_dir_all(prefix.join("bin")).expect("bin dir");
        let previous = prefix.join("bin/prime-agent");
        std::fs::write(&previous, "#!/bin/sh\necho 9.9.7-continuous.0000001\n")
            .expect("previous launcher");
        make_executable(&previous);

        let failure = run_installer_from(
            &serve("#!/bin/sh\necho 'install-rust.sh: the artifact download failed' >&2\nexit 3\n"),
            &prefix,
            InstallerOutput::Capture,
        )
        .await
        .expect_err("the failing script fails the update");
        assert!(
            failure.message.contains("the artifact download failed"),
            "the failure carries the script's own die message: {}",
            failure.message
        );
        assert!(failure.message.contains("code 3"), "{}", failure.message);
        // The previous install is still there and still answers.
        let version = launcher_version(&prefix).await;
        assert_eq!(version.as_deref(), Some("9.9.7-continuous.0000001"));
        preserve.assert_untouched();
        drop(root);
    }

    #[tokio::test]
    async fn an_unfetchable_script_fails_without_installing() {
        let (_root, _preserve, prefix) = sandbox();
        // A port with no listener: the fetch fails, nothing runs.
        let failure = run_installer_from(
            "http://127.0.0.1:9/install-rust.sh",
            &prefix,
            InstallerOutput::Capture,
        )
        .await
        .expect_err("the unreachable URL fails the update");
        assert!(
            failure.message.contains("could not download the installer"),
            "the failure names the fetch: {}",
            failure.message
        );
        assert!(
            !prefix.join("bin").exists(),
            "nothing landed from a failed fetch"
        );
    }

    #[cfg(unix)]
    fn unix_mode_is_executable(metadata: &std::fs::Metadata) -> bool {
        use std::os::unix::fs::PermissionsExt as _;
        metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt as _;
        let mut permissions = std::fs::metadata(path).expect("metadata").permissions();
        permissions.set_mode(permissions.mode() | 0o755);
        std::fs::set_permissions(path, permissions).expect("chmod");
    }
}
