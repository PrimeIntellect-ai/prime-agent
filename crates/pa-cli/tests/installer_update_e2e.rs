// large_futures: stack futures on hot paths by design. too_many_lines: style gate
// only. Casts: 64-bit targets; narrowing sits at bounded OS/protocol boundaries.
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! The `prime-agent update` e2e (the TS->Rust migration path): the real
//! binary, a mocked installer-script download (a local one-shot HTTP server),
//! and a sandboxed HOME — the launcher lands under the sandbox prefix, the
//! success line names the new build, and the sandbox session file is
//! byte-identical. A failing script keeps the previous install.
#![cfg(unix)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;

const ENV_INSTALLER_URL: &str = "PRIME_AGENT_RUST_INSTALLER_URL";
const ENV_PREFIX: &str = "PRIME_AGENT_RUST_PREFIX";

/// The mock installer the command downloads: it installs a launcher that
/// answers a stamped `--version` (the takeover's contract).
const MOCK_INSTALLER: &str = r#"#!/bin/sh
set -eu
mkdir -p "${PRIME_AGENT_RUST_PREFIX}/bin"
printf '#!/bin/sh\necho "9.9.9-continuous.0123456789abcdef"\n' > "${PRIME_AGENT_RUST_PREFIX}/bin/prime-agent"
chmod 0755 "${PRIME_AGENT_RUST_PREFIX}/bin/prime-agent"
echo "installed: 9.9.9-continuous.0123456789abcdef"
"#;

/// The failing installer: it dies before touching anything.
const FAILING_INSTALLER: &str =
    "#!/bin/sh\necho 'install-rust.sh: the artifact download failed' >&2\nexit 3\n";

/// Serve `body` over one plain HTTP request; return the URL the funnel
/// fetches.
fn serve(body: &'static str) -> String {
    format!("{}/install-rust.sh", serve_at("/install-rust.sh", body))
}

/// Serve `body` at `path` over one plain HTTP request (any other path
/// answers 404); return the server's base URL.
fn serve_at(path: &'static str, body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let address = listener.local_addr().expect("local address");
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            // Read the request head first (the funnel's GET carries no
            // body): answering before the request is drained can reset
            // the connection mid-write.
            let mut head = Vec::new();
            let mut byte = [0_u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                match stream.read(&mut byte) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => head.push(byte[0]),
                }
            }
            let requested = String::from_utf8_lossy(&head)
                .split_whitespace()
                .nth(1)
                .unwrap_or_default()
                .to_string();
            let (status, body) = if requested == path {
                ("200 OK", body)
            } else {
                ("404 Not Found", "")
            };
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    format!("http://{address}")
}

/// One sandbox: a HOME with the session store the update must preserve,
/// and the install prefix the launcher lands under.
struct Sandbox {
    /// Removes the sandbox (installed binaries included) when the test ends,
    /// passing or failing.
    _dir: tempfile::TempDir,
    root: PathBuf,
    session_file: PathBuf,
    session_bytes: Vec<u8>,
    prefix: PathBuf,
}

impl Sandbox {
    fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("pa-update-e2e-")
            .tempdir()
            .expect("sandbox root");
        // The installer reports resolved paths; macOS's temp dir sits behind
        // the /var -> /private/var symlink.
        let root = dir.path().canonicalize().expect("canonical sandbox root");
        let home = root.join("home");
        let session_file = home.join(".prime/agent/sessions/session.jsonl");
        std::fs::create_dir_all(session_file.parent().expect("session dir")).expect("session dir");
        let session_bytes =
            b"{\"type\":\"user_message\",\"content\":\"the session the update must preserve\"}\n"
                .to_vec();
        std::fs::write(&session_file, &session_bytes).expect("write session file");
        let prefix = root.join("prefix/.local");
        std::fs::create_dir_all(&prefix).expect("prefix");
        Self {
            _dir: dir,
            root,
            session_file,
            session_bytes,
            prefix,
        }
    }

    /// The preserve invariant: the session store is byte-identical.
    fn assert_session_preserved(&self) {
        let observed = std::fs::read(&self.session_file).expect("session file survives");
        assert_eq!(
            observed, self.session_bytes,
            "the sandbox ~/.prime/agent session file is byte-identical"
        );
    }
}

fn run_prime_agent(args: &[&str], sandbox: &Sandbox, url: &str) -> std::process::Output {
    let mut command = prime_agent(args, sandbox);
    command.env(ENV_INSTALLER_URL, url);
    command.output().expect("run the prime-agent binary")
}

fn prime_agent(args: &[&str], sandbox: &Sandbox) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_prime-agent"));
    command
        .args(args)
        .env("HOME", sandbox.root.join("home"))
        .env_remove(ENV_INSTALLER_URL)
        .env(ENV_PREFIX, &sandbox.prefix)
        .env(
            "PRIME_AGENT_CODING_AGENT_DIR",
            sandbox.root.join("home/.prime/agent"),
        );
    command
}

#[test]
fn update_runs_the_downloaded_installer_and_preserves_the_session_store() {
    let sandbox = Sandbox::new();
    let url = serve(MOCK_INSTALLER);
    let output = run_prime_agent(&["update"], &sandbox, &url);
    assert!(
        output.status.success(),
        "the update succeeds:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("updated to 9.9.9-continuous.0123456789abcdef"),
        "the success line names the new build:\n{stdout}"
    );
    assert!(
        stdout.contains("restart prime-agent to run the new build"),
        "the success line carries the restart hint:\n{stdout}"
    );
    let launcher = sandbox.prefix.join("bin/prime-agent");
    assert!(launcher.is_file(), "the launcher landed");
    let version = Command::new(&launcher)
        .arg("--version")
        .output()
        .expect("the launcher answers --version");
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        "9.9.9-continuous.0123456789abcdef"
    );
    sandbox.assert_session_preserved();
}

/// A nightly install's `prime-agent update` fetches `install-beta.sh` from
/// the download base (no installer override): the domain only forwards
/// the stable `install.sh`, so nightly updates go to the bucket directly.
#[test]
fn a_nightly_update_fetches_install_beta_from_the_download_base() {
    let sandbox = Sandbox::new();
    let share = sandbox.prefix.join("share/prime-agent");
    std::fs::create_dir_all(&share).expect("share dir");
    std::fs::write(
        share.join(".prime-agent-install"),
        "install-rust.sh channel beta\nversion 0.9.9-beta.11\n",
    )
    .expect("install marker");
    let base = serve_at("/install-beta.sh", MOCK_INSTALLER);
    let output = prime_agent(&["update"], &sandbox)
        .env("PRIME_AGENT_DOWNLOAD_BASE_URL", &base)
        .output()
        .expect("run the prime-agent binary");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "the nightly update succeeds:\nstdout:\n{stdout}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.contains(&format!(
            "fetching the installer from {base}/install-beta.sh"
        )),
        "the banner names the nightly installer:\n{stdout}"
    );
    assert!(
        stdout.contains("updated to 9.9.9-continuous.0123456789abcdef"),
        "the nightly installer ran:\n{stdout}"
    );
    sandbox.assert_session_preserved();
}

/// A failing installer reports the error and keeps the previous install.
#[test]
fn a_failing_installer_keeps_the_previous_install() {
    let sandbox = Sandbox::new();
    // A previous install exists; the funnel must leave it in place.
    std::fs::create_dir_all(sandbox.prefix.join("bin")).expect("bin dir");
    let previous = sandbox.prefix.join("bin/prime-agent");
    std::fs::write(&previous, "#!/bin/sh\necho 9.9.7-continuous.0000001\n").expect("launcher");
    make_executable(&previous);
    let url = serve(FAILING_INSTALLER);
    let output = run_prime_agent(&["update"], &sandbox, &url);
    assert_eq!(
        output.status.code(),
        Some(1),
        "the failed update exits 1:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Error:") && stderr.contains("code 3"),
        "the error names the failure:\n{stderr}"
    );
    let version = Command::new(&previous)
        .arg("--version")
        .output()
        .expect("the previous launcher still answers");
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        "9.9.7-continuous.0000001",
        "the previous install was kept"
    );
    sandbox.assert_session_preserved();
}

/// A hermetic world for the real `install-rust.sh`: `HOME` and `TMPDIR`
/// (the daemon sockets the installer probes) live in the sandbox, and
/// `PATH` puts shims first — `uv` answers only `python find` (the
/// installer's own Python), `npm` reports an empty global root — so the run
/// never touches the network, the machine's daemons, or a global npm
/// package.
fn installer_env(command: &mut Command, sandbox: &Sandbox) {
    let shims = sandbox.root.join("shims");
    std::fs::create_dir_all(&shims).expect("shims dir");
    let python = [
        "/usr/bin/python3",
        "/usr/local/bin/python3",
        "/opt/homebrew/bin/python3",
    ]
    .into_iter()
    .find(|path| Path::new(path).is_file())
    .expect("a python3 for the installer's scripting steps");
    let uv = shims.join("uv");
    std::fs::write(
        &uv,
        format!("#!/bin/sh\n[ \"$1 $2\" = \"python find\" ] && echo {python} && exit 0\nexit 1\n"),
    )
    .expect("uv shim");
    make_executable(&uv);
    let npm = shims.join("npm");
    std::fs::write(
        &npm,
        "#!/bin/sh\n[ \"$1\" = root ] && echo /nonexistent\nexit 0\n",
    )
    .expect("npm shim");
    make_executable(&npm);
    let tmp = sandbox.root.join("tmp");
    std::fs::create_dir_all(&tmp).expect("tmp dir");
    command
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", shims.display()))
        .env("HOME", sandbox.root.join("home"))
        .env("TMPDIR", tmp)
        .env(ENV_PREFIX, &sandbox.prefix)
        .current_dir(&sandbox.root);
}

/// A release archive whose payload is a script answering `version`.
fn fake_release(sandbox: &Sandbox, version: &str) -> PathBuf {
    let payload = sandbox.root.join(format!("payload-{version}"));
    std::fs::create_dir_all(&payload).expect("payload dir");
    let binary = payload.join("prime-agent");
    std::fs::write(&binary, format!("#!/bin/sh\necho {version}\n")).expect("payload binary");
    make_executable(&binary);
    let platform = pa_core::update::install::current_platform_alias();
    let archive = sandbox
        .root
        .join(format!("prime-agent-{version}-{platform}.tar.gz"));
    let status = Command::new("tar")
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(&payload)
        .arg("prime-agent")
        .status()
        .expect("run tar");
    assert!(status.success(), "tar the fake release");
    archive
}

fn assert_ran(output: &std::process::Output, what: &str) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    assert!(
        output.status.success(),
        "{what} succeeds:\nstdout:\n{stdout}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    stdout
}

/// The version the live payload's install marker records.
fn live_version(sandbox: &Sandbox) -> String {
    let marker = std::fs::read_to_string(
        sandbox
            .prefix
            .join("share/prime-agent/.prime-agent-install"),
    )
    .expect("the live payload's marker");
    marker
        .lines()
        .nth(1)
        .and_then(|line| line.strip_prefix("version "))
        .expect("the marker's version line")
        .to_string()
}

/// On an installer install, `update --archive` and `update --rollback` run
/// the bundled installer: the archive goes live with the replaced payload
/// kept, `--rollback` swaps the kept payload back (keeping the one it
/// replaces), so a second `--rollback` undoes the first; the session store
/// is untouched throughout.
#[test]
fn update_archive_and_rollback_swap_installer_payloads() {
    let sandbox = Sandbox::new();
    // This build, published as an installer payload.
    let live = sandbox.prefix.join("share/prime-agent");
    std::fs::create_dir_all(&live).expect("payload dir");
    let binary = live.join("prime-agent");
    std::fs::copy(env!("CARGO_BIN_EXE_prime-agent"), &binary).expect("copy this build");
    std::fs::write(
        live.join(".prime-agent-install"),
        "install-rust.sh channel beta\nversion 9.9.9\n",
    )
    .expect("install marker");
    let run_update = |args: &[&str]| {
        let mut command = Command::new(&binary);
        command.arg("update").args(args);
        installer_env(&mut command, &sandbox);
        command.output().expect("run the installed build")
    };

    let archive = fake_release(&sandbox, "1.0.0");
    let stdout = assert_ran(
        &run_update(&["--archive", archive.to_str().expect("utf-8 path")]),
        "update --archive",
    );
    assert!(stdout.contains("installed 1.0.0"), "{stdout}");
    assert_eq!(live_version(&sandbox), "1.0.0");

    // The archive's payload cannot run `update`: roll back with the script
    // itself (the bundled copy is this file).
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../install-rust.sh");
    let mut command = Command::new("/bin/sh");
    command.arg(&script).arg("--rollback");
    installer_env(&mut command, &sandbox);
    assert_ran(
        &command.output().expect("run the installer"),
        "install-rust.sh --rollback",
    );
    assert_eq!(
        live_version(&sandbox),
        "9.9.9",
        "the kept build is live again"
    );

    let stdout = assert_ran(&run_update(&["--rollback"]), "update --rollback");
    assert!(stdout.contains("rolled back to 1.0.0"), "{stdout}");
    assert_eq!(
        live_version(&sandbox),
        "1.0.0",
        "a second rollback undoes the first"
    );
    sandbox.assert_session_preserved();
}

/// The rollback pre-flight: the installer's check mode answers the
/// rollback question synchronously — nothing kept is its own refusal,
/// a kept generation prints the source and exits without touching the
/// payload (the Windows update handoff runs this exact scan before it
/// hands the real run off, so its exit code is honest for the
/// deterministic refusals).
#[test]
fn rollback_check_answers_synchronously_without_touching_the_payload() {
    let sandbox = Sandbox::new();
    let live = sandbox.prefix.join("share/prime-agent");
    std::fs::create_dir_all(&live).expect("payload dir");
    let binary = live.join("prime-agent");
    std::fs::copy(env!("CARGO_BIN_EXE_prime-agent"), &binary).expect("copy this build");
    std::fs::write(
        live.join(".prime-agent-install"),
        "install-rust.sh channel beta\nversion 9.9.9\n",
    )
    .expect("install marker");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../install-rust.sh");
    let run_check = || {
        let mut command = Command::new("/bin/sh");
        command.arg(&script).arg("--rollback");
        installer_env(&mut command, &sandbox);
        command
            .env("PRIME_AGENT_ROLLBACK_CHECK", "1")
            .output()
            .expect("run the installer's check mode")
    };

    let output = run_check();
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("nothing to roll back"), "{stderr}");
    assert_eq!(live_version(&sandbox), "9.9.9");

    let archive = fake_release(&sandbox, "1.0.0");
    let mut command = Command::new(&binary);
    command
        .arg("update")
        .arg("--archive")
        .arg(archive.to_str().expect("utf-8 path"));
    installer_env(&mut command, &sandbox);
    assert_ran(
        &command.output().expect("run the installed build"),
        "update --archive",
    );
    assert_eq!(live_version(&sandbox), "1.0.0");

    let output = run_check();
    assert!(output.status.success(), "the check finds the kept build");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let source = stdout.lines().last().unwrap_or_default().to_string();
    let kept = source.strip_prefix(sandbox.prefix.display().to_string().as_str());
    assert!(
        kept.is_some_and(|rest| rest.starts_with("/share/prime-agent.old.")),
        "the source names the kept generation: {source}"
    );
    assert_eq!(live_version(&sandbox), "1.0.0", "the check touched nothing");
    let leftovers: Vec<String> = std::fs::read_dir(sandbox.root.join("tmp"))
        .expect("tmp dir")
        .filter_map(std::result::Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.contains("prime-agent-download"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "the check mode cleans its staging: {leftovers:?}"
    );
    sandbox.assert_session_preserved();
}

/// A mis-named archive is refused before the publish: the payload's own
/// `--version` is the ground truth for the marker the install records
/// (and the rollback later reports), so a name/payload mismatch would
/// publish a lie.
#[test]
fn update_archive_refuses_a_misnamed_payload_version() {
    let sandbox = Sandbox::new();
    let live = sandbox.prefix.join("share/prime-agent");
    std::fs::create_dir_all(&live).expect("payload dir");
    let binary = live.join("prime-agent");
    std::fs::copy(env!("CARGO_BIN_EXE_prime-agent"), &binary).expect("copy this build");
    std::fs::write(
        live.join(".prime-agent-install"),
        "install-rust.sh channel beta\nversion 9.9.9\n",
    )
    .expect("install marker");
    let platform = pa_core::update::install::current_platform_alias();
    let payload_dir = sandbox.root.join("payload-misnamed");
    std::fs::create_dir_all(&payload_dir).expect("payload dir");
    let payload = payload_dir.join("prime-agent");
    std::fs::write(&payload, "#!/bin/sh\necho 0.9.7\n").expect("payload binary");
    make_executable(&payload);
    let archive = sandbox
        .root
        .join(format!("prime-agent-9.9.9-{platform}.tar.gz"));
    let status = Command::new("tar")
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(&payload_dir)
        .arg("prime-agent")
        .status()
        .expect("run tar");
    assert!(status.success(), "tar the misnamed release");

    let mut command = Command::new(&binary);
    command
        .arg("update")
        .arg("--archive")
        .arg(archive.to_str().expect("utf-8 path"));
    installer_env(&mut command, &sandbox);
    let output = command.output().expect("run the installed build");
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("the archive names 9.9.9 but its payload reports 0.9.7"),
        "{stderr}"
    );
    assert_eq!(live_version(&sandbox), "9.9.9", "nothing was published");
    sandbox.assert_session_preserved();
}

/// The install.ps1 slot: the Windows-native installer keeps its replaced
/// payload at the un-suffixed `prime-agent.old` and never writes the
/// generations record, so the CLI's rollback must fall back to that
/// slot — a ps1-updated machine's only automated rollback path.
#[test]
fn update_rollback_reads_the_unsuffixed_installer_slot() {
    let sandbox = Sandbox::new();
    let live = sandbox.prefix.join("share/prime-agent");
    std::fs::create_dir_all(&live).expect("payload dir");
    let binary = live.join("prime-agent");
    std::fs::copy(env!("CARGO_BIN_EXE_prime-agent"), &binary).expect("copy this build");
    std::fs::write(
        live.join(".prime-agent-install"),
        "install-rust.sh channel beta\nversion 9.9.9\n",
    )
    .expect("install marker");
    // The install.ps1 era: the replaced payload sits at the un-suffixed
    // name, and no generations record exists.
    let slot = sandbox.prefix.join("share/prime-agent.old");
    std::fs::create_dir_all(&slot).expect("slot dir");
    std::fs::write(
        slot.join(".prime-agent-install"),
        "install-rust.sh channel beta\nversion 1.0.0\n",
    )
    .expect("slot marker");
    std::fs::write(slot.join("prime-agent"), b"#!/bin/sh\necho 1.0.0\n").expect("slot payload");
    make_executable(&slot.join("prime-agent"));

    let mut command = Command::new(&binary);
    command.args(["update", "--rollback"]);
    installer_env(&mut command, &sandbox);
    let output = command.output().expect("run the installed build");
    assert!(output.status.success(), "the slot is a rollback source");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("rolled back to 1.0.0"), "{stdout}");
    assert_eq!(
        live_version(&sandbox),
        "1.0.0",
        "the slot's payload is live"
    );
    // The displaced live tree becomes a recorded generation: the machine
    // converts to the sh bookkeeping, so the toggle keeps working.
    let record = sandbox
        .prefix
        .join("share/.prime-agent-install-generations");
    assert!(
        record.exists(),
        "the publish recorded the displaced payload"
    );
    sandbox.assert_session_preserved();
}

/// A fresh installer install has nothing to roll back: the run fails with
/// the reason and the live payload stays.
#[test]
fn update_rollback_without_a_kept_version_changes_nothing() {
    let sandbox = Sandbox::new();
    let live = sandbox.prefix.join("share/prime-agent");
    std::fs::create_dir_all(&live).expect("payload dir");
    let binary = live.join("prime-agent");
    std::fs::copy(env!("CARGO_BIN_EXE_prime-agent"), &binary).expect("copy this build");
    std::fs::write(
        live.join(".prime-agent-install"),
        "install-rust.sh channel beta\nversion 9.9.9\n",
    )
    .expect("install marker");
    let mut command = Command::new(&binary);
    command.args(["update", "--rollback"]);
    installer_env(&mut command, &sandbox);
    let output = command.output().expect("run the installed build");
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("nothing to roll back"), "{stderr}");
    assert_eq!(live_version(&sandbox), "9.9.9");

    // A channel flag has nothing to switch in a local operation: refused
    // before any prompt or install.
    let mut command = Command::new(&binary);
    command.args(["update", "--rollback", "--nightly"]);
    installer_env(&mut command, &sandbox);
    let output = command.output().expect("run the installed build");
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("do not apply to --rollback"), "{stderr}");
    assert_eq!(live_version(&sandbox), "9.9.9");

    // The CLI's --force is the nightly-switch confirmation skip; the
    // local operations refuse it instead of silently dropping it.
    let mut command = Command::new(&binary);
    command.args(["update", "--rollback", "--force"]);
    installer_env(&mut command, &sandbox);
    let output = command.output().expect("run the installed build");
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("--force does not apply"), "{stderr}");
    assert!(stderr.contains("shutdown --force"), "{stderr}");
    assert_eq!(live_version(&sandbox), "9.9.9");
}

/// The archive pre-flight: the installer's check mode answers the
/// archive question synchronously — a mis-named archive is its own
/// refusal, a good one validates and exits without publishing (the
/// Windows update handoff runs this exact validation before it hands
/// the real run off, so its exit code is honest for the deterministic
/// refusals).
#[test]
fn archive_check_answers_synchronously_without_publishing() {
    let sandbox = Sandbox::new();
    let live = sandbox.prefix.join("share/prime-agent");
    std::fs::create_dir_all(&live).expect("payload dir");
    let binary = live.join("prime-agent");
    std::fs::copy(env!("CARGO_BIN_EXE_prime-agent"), &binary).expect("copy this build");
    std::fs::write(
        live.join(".prime-agent-install"),
        "install-rust.sh channel beta\nversion 9.9.9\n",
    )
    .expect("install marker");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../install-rust.sh");
    let run_check = |archive: &std::path::Path| {
        let mut command = Command::new("/bin/sh");
        command.arg(&script).arg("--archive").arg(archive);
        installer_env(&mut command, &sandbox);
        command
            .env("PRIME_AGENT_ARCHIVE_CHECK", "1")
            .output()
            .expect("run the installer's check mode")
    };

    // A mis-named archive: the payload answers 0.9.7 under a 9.9.9 name.
    let misnamed = fake_release_payload(&sandbox, "9.9.9", "0.9.7");
    let output = run_check(&misnamed);
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("the archive names 9.9.9 but its payload reports 0.9.7"),
        "{stderr}"
    );
    assert_eq!(live_version(&sandbox), "9.9.9");
    let leftovers: Vec<String> = std::fs::read_dir(sandbox.prefix.join("share"))
        .expect("share dir")
        .filter_map(std::result::Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.contains("prime-agent.stage"))
        .collect();
    assert!(leftovers.is_empty(), "no stage dir survives: {leftovers:?}");

    // A good archive: the check validates and exits without publishing.
    let good = fake_release(&sandbox, "9.9.9");
    let output = run_check(&good);
    assert!(
        output.status.success(),
        "the check accepts the good archive"
    );
    assert_eq!(
        live_version(&sandbox),
        "9.9.9",
        "the check published nothing"
    );
    sandbox.assert_session_preserved();
}

/// A running daemon of this product takes the update restart: the installer
/// runs the new payload's restart mode instead of the shutdown ladder, so the
/// old supervisor exits and a new one greets on the same socket.
#[test]
fn an_installer_run_restarts_the_running_daemon() {
    let sandbox = Sandbox::new();
    let live = sandbox.prefix.join("share/prime-agent");
    std::fs::create_dir_all(&live).expect("payload dir");
    let binary = live.join("prime-agent");
    std::fs::copy(env!("CARGO_BIN_EXE_prime-agent"), &binary).expect("copy this build");
    std::fs::write(
        live.join(".prime-agent-install"),
        "install-rust.sh channel beta\nversion 9.9.9\n",
    )
    .expect("install marker");
    // The release archive carries this build too, so the new payload can run the restart.
    let version = env!("CARGO_PKG_VERSION");
    let payload = sandbox.root.join("payload-restart");
    std::fs::create_dir_all(&payload).expect("payload dir");
    std::fs::copy(
        env!("CARGO_BIN_EXE_prime-agent"),
        payload.join("prime-agent"),
    )
    .expect("copy this build");
    let platform = pa_core::update::install::current_platform_alias();
    let archive = sandbox
        .root
        .join(format!("prime-agent-{version}-{platform}.tar.gz"));
    let status = Command::new("tar")
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(&payload)
        .arg("prime-agent")
        .status()
        .expect("run tar");
    assert!(status.success(), "tar the release");

    // The daemon on the socket the launcher pins (the installer's own rule).
    let uid = String::from_utf8(Command::new("id").arg("-u").output().expect("id -u").stdout)
        .expect("utf-8 uid");
    let socket = sandbox
        .root
        .join(format!("tmp/prime-agent-rust-{}/daemon.sock", uid.trim()));
    let mut daemon = Command::new(&binary);
    installer_env(&mut daemon, &sandbox);
    daemon
        .args(["--mode", "daemon", "--daemon-socket"])
        .arg(&socket)
        .env(
            "PRIME_AGENT_CODING_AGENT_DIR",
            sandbox.root.join("home/.prime/agent"),
        )
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut old_daemon = daemon.spawn().expect("start the daemon");
    let old_pid = supervisor_pid_after(&socket, None).expect("the daemon greets");

    let mut command = Command::new(&binary);
    command.arg("update").arg("--archive").arg(&archive);
    installer_env(&mut command, &sandbox);
    let output = command.output().expect("run the installed build");
    let new_pid = supervisor_pid_after(&socket, Some(old_pid));
    // The installer always takes the old daemon down: restarted or stopped.
    let _ = old_daemon.wait();
    if let Some(pid) = new_pid {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let stdout = assert_ran(&output, "update --archive");
    assert!(
        format!("{stdout}{stderr}").contains("Restarted the previous Rust daemon"),
        "the summary reports the restart:\n{stdout}\n{stderr}"
    );
    assert!(new_pid.is_some(), "a new supervisor greets on the socket");
}

/// The `supervisorPid` the daemon on `socket` greets with, once it differs from `previous`.
fn supervisor_pid_after(socket: &Path, previous: Option<u64>) -> Option<u64> {
    use std::io::BufRead as _;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while std::time::Instant::now() < deadline {
        if let Ok(stream) = std::os::unix::net::UnixStream::connect(socket) {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
            let mut hello = String::new();
            if std::io::BufReader::new(stream)
                .read_line(&mut hello)
                .is_ok()
            {
                let pid = serde_json::from_str::<serde_json::Value>(&hello)
                    .ok()
                    .and_then(|hello| {
                        hello
                            .get("supervisorPid")
                            .and_then(serde_json::Value::as_u64)
                    });
                if let Some(pid) = pid.filter(|pid| Some(*pid) != previous) {
                    return Some(pid);
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    None
}

/// A release archive whose payload answers `reported` under the archive
/// name `named` (the mis-naming fixture for the check-mode test).
fn fake_release_payload(sandbox: &Sandbox, named: &str, reported: &str) -> PathBuf {
    let payload = sandbox.root.join(format!("payload-mismatch-{named}"));
    std::fs::create_dir_all(&payload).expect("payload dir");
    let binary = payload.join("prime-agent");
    std::fs::write(&binary, format!("#!/bin/sh\necho {reported}\n")).expect("payload binary");
    make_executable(&binary);
    let platform = pa_core::update::install::current_platform_alias();
    let archive = sandbox
        .root
        .join(format!("prime-agent-{named}-{platform}.tar.gz"));
    let status = Command::new("tar")
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(&payload)
        .arg("prime-agent")
        .status()
        .expect("run tar");
    assert!(status.success(), "tar the mismatched release");
    archive
}

fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt as _;
    let mut permissions = std::fs::metadata(path).expect("metadata").permissions();
    permissions.set_mode(permissions.mode() | 0o755);
    std::fs::set_permissions(path, permissions).expect("chmod");
}
