//! The Windows update handoff e2e (the channel funnel's Windows lock):
//! the real binary copied into a marked installer tree —
//! `<prefix>/share/prime-agent/prime-agent.exe`, the file the `.cmd` and
//! sh launchers exec — runs `prime-agent update` against a served mock
//! installer. Windows keeps a running executable's directory un-renameable,
//! and that directory is exactly what the installer's publish renames, so
//! a spawn-and-wait funnel can never publish: the CLI must HAND OFF —
//! spawn the installer detached, never wait, print the handoff line, and
//! exit — and the detached installer must survive the caller's exit and
//! land its payload. The windows battery (windows-runtime-triage) runs
//! this on windows-latest; the unix hosts compile-skip the file (the unix
//! funnel keeps its deterministic spawn-and-wait and its own e2e).
#![cfg(windows)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const ENV_INSTALLER_URL: &str = "PRIME_AGENT_RUST_INSTALLER_URL";
const ENV_PREFIX: &str = "PRIME_AGENT_RUST_PREFIX";

/// The installer's publish budget: the mock script outlives the CLI's
/// exit window by this much (the CLI must exit while the script is still
/// running — a spawn-and-wait funnel would sit inside the window).
const SCRIPT_SLEEP: Duration = Duration::from_secs(8);
/// How long the CLI may take to hand off (fetch + spawn + exit): well
/// inside the script's lifetime, so the exit proves the funnel did not
/// wait.
const CLI_EXIT_BUDGET: Duration = Duration::from_secs(6);
/// How long the detached installer may take to land its side effect after
/// the CLI is gone (the machine is still running its sleep).
const SIDEEFFECT_BUDGET: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(250);

/// The mock installer: it sleeps first (it must still be running when the
/// CLI exits) and then lands its side-effect file — the publish's rename
/// semantics are the install e2e's lane (test_windows_install.ps1); this
/// e2e proves the handoff's own contract: the spawn is detached, the
/// caller exits, and the installer survives and finishes.
const MOCK_INSTALLER: &str = r#"#!/bin/sh
sleep 8
printf 'done\n' > "${PRIME_AGENT_RUST_PREFIX}/handoff-installed"
"#;

/// Serve `body` over one plain HTTP request; return the URL the funnel
/// fetches (the unix funnel e2e's one-shot server shape).
fn serve(body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let address = listener.local_addr().expect("local address");
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            // Read the request head first: answering before the request
            // is drained can reset the connection mid-write.
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

/// The sandbox: a home, an install prefix, and the marked payload tree
/// the CLI runs from (the real binary copied to
/// `<prefix>/share/prime-agent/prime-agent.exe`).
struct Sandbox {
    root: PathBuf,
    prefix: PathBuf,
    payload_exe: PathBuf,
}

impl Sandbox {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("pa-windows-handoff-e2e-{}", std::process::id()));
        let home = root.join("home");
        std::fs::create_dir_all(&home).expect("sandbox home");
        let prefix = root.join("prefix/.local");
        let payload = prefix.join("share/prime-agent");
        std::fs::create_dir_all(&payload).expect("payload tree");
        let payload_exe = payload.join("prime-agent.exe");
        std::fs::copy(env!("CARGO_BIN_EXE_prime-agent"), &payload_exe)
            .expect("copy this build into the payload tree");
        // The installer's own publish marker (the ownership proof the
        // handoff gate reads): this tree is the installer's.
        std::fs::write(
            payload.join(".prime-agent-install"),
            "install-rust.sh channel stable\nversion 9.9.9\n",
        )
        .expect("install marker");
        Self {
            root,
            prefix,
            payload_exe,
        }
    }

    /// The update invocation's environment: the served installer URL, the
    /// sandbox prefix, and a contained home + agent dir (nothing on the
    /// machine is touched).
    fn prime_agent(&self, installer_url: &str) -> Command {
        let home = self.root.join("home");
        let mut command = Command::new(&self.payload_exe);
        command
            .arg("update")
            .env(ENV_INSTALLER_URL, installer_url)
            .env(ENV_PREFIX, &self.prefix)
            .env("USERPROFILE", &home)
            .env("HOME", &home)
            .env("PRIME_AGENT_CODING_AGENT_DIR", home.join(".prime/agent"));
        command
    }
}

/// The handoff: the CLI (the payload binary itself) must exit while the
/// installer is still running, and the detached installer must survive
/// the exit and land its payload.
#[test]
fn the_windows_update_hands_off_instead_of_waiting_on_the_installer() {
    let sandbox = Sandbox::new();
    let url = serve(MOCK_INSTALLER);
    // The CLI's output lands in files (never pipes): the detached
    // installer inherits the handles, so a piped reader would block on
    // the installer's lifetime instead of observing the CLI's exit.
    let stdout_path = sandbox.prefix.join("cli-stdout.txt");
    let stderr_path = sandbox.prefix.join("cli-stderr.txt");
    let stdout = std::fs::File::create(&stdout_path).expect("stdout file");
    let stderr = std::fs::File::create(&stderr_path).expect("stderr file");
    let mut child = sandbox
        .prime_agent(&url)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .expect("run the payload binary's update");

    // The CLI must exit inside the budget — while the installer is still
    // in its sleep (a spawn-and-wait funnel would hold it here).
    let started = Instant::now();
    let exit_code = loop {
        match child.try_wait().expect("poll the CLI") {
            Some(status) => break status.code(),
            None => assert!(
                started.elapsed() < CLI_EXIT_BUDGET,
                "the update CLI is still running after {:?}: the funnel \
                 spawn-and-waits on the installer (the Windows handoff did \
                 not fire)",
                started.elapsed()
            ),
        }
        std::thread::sleep(POLL);
    };
    let exited_at = started.elapsed();
    let sideeffect = sandbox.prefix.join("handoff-installed");
    assert!(
        !sideeffect.exists(),
        "the installer finished before the CLI exited: the handoff waited"
    );
    assert_eq!(exit_code, Some(0), "the handed-off update exits 0");
    let stdout = std::fs::read_to_string(&stdout_path).expect("the CLI's stdout");
    assert!(
        stdout.contains("the update continues in a separate installer process"),
        "the handoff line prints:\n{stdout}"
    );
    assert!(
        !stdout.contains("updated to"),
        "a handed-off run never reports a completed install:\n{stdout}"
    );

    // The detached installer survives the caller's exit and lands its
    // payload (the mock script's side effect).
    let landed = loop {
        if sideeffect.is_file() {
            break true;
        }
        assert!(
            started.elapsed() < SIDEEFFECT_BUDGET,
            "the detached installer never landed its payload after the CLI \
             exited at {exited_at:?}"
        );
        std::thread::sleep(POLL);
    };
    assert!(landed, "the detached installer survived the caller's exit");
    assert!(
        exited_at < SCRIPT_SLEEP,
        "the CLI exited before the installer's sleep ended (it did not wait)"
    );
}
