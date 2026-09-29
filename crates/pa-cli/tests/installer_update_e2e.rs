// The Tier-C/D ruling (fleet-uniform, 2026-09-28): stack-resident futures
// by design on hot paths (boxing 130 fns is allocation-churn with zero
// correctness gain); the fn-length threshold is a style gate, not
// correctness (the harness fns are intentionally linear); 64-bit targets -
// the narrowing sits at OS/protocol boundaries where the values are
// bounded (pid syscalls, epoch/elapsed milliseconds, calendar math,
// guarded parses), and checked conversions would add panic paths where
// silent wrap was deliberate (the one genuinely-suspect family, args.rs's
// parse_positive_u32 lacking its u32::MAX bound, is flagged in the lane
// dossier for the conductor).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! The `prime-agent update` e2e (the TS->Rust migration path): the real
//! binary, a mocked installer-script download (a local one-shot HTTP
//! server the URL knob points at), and a sandboxed HOME — the command
//! runs the downloaded script, the launcher lands under the sandbox
//! prefix, the success line names the new build, and the session file
//! in the sandbox `~/.prime/agent` is byte-identical. A failing script
//! keeps the previous install and reports the error.
#![cfg(unix)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;

const ENV_INSTALLER_URL: &str = "PRIME_AGENT_RUST_INSTALLER_URL";
const ENV_PREFIX: &str = "PRIME_AGENT_RUST_PREFIX";

/// The mock installer the command downloads: it installs a launcher that
/// answers a stamped `--version` (the takeover's contract — the real
/// script's own artifact download stays the installer-takeover lane's
/// sandbox test).
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
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    format!("http://{address}/install-rust.sh")
}

/// One sandbox: a HOME with the session store the update must preserve,
/// and the install prefix the launcher lands under.
struct Sandbox {
    root: PathBuf,
    session_file: PathBuf,
    session_bytes: Vec<u8>,
    prefix: PathBuf,
}

impl Sandbox {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pa-update-e2e-{}-{}",
            std::process::id(),
            uuid_probe()
        ));
        std::fs::create_dir_all(&root).expect("sandbox root");
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

/// A per-test disambiguator for the sandbox root (no uuid dependency in
/// dev-deps: the pid plus the server port keeps concurrent runs apart).
fn uuid_probe() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let next = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    format!("{next}")
}

fn run_prime_agent(args: &[&str], sandbox: &Sandbox, url: &str) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .args(args)
        .env("HOME", sandbox.root.join("home"))
        .env(ENV_INSTALLER_URL, url)
        .env(ENV_PREFIX, &sandbox.prefix)
        .env(
            "PRIME_AGENT_CODING_AGENT_DIR",
            sandbox.root.join("home/.prime/agent"),
        )
        .output()
        .expect("run the prime-agent binary")
}

/// `prime-agent update` downloads the script, runs it, the launcher
/// lands, the success line names the new build, and the session store is
/// untouched.
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

fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt as _;
    let mut permissions = std::fs::metadata(path).expect("metadata").permissions();
    permissions.set_mode(permissions.mode() | 0o755);
    std::fs::set_permissions(path, permissions).expect("chmod");
}
