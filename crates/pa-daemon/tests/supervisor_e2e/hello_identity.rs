//! The `daemon_hello` identity pins: the one version identity this build
//! reports (`appVersion` and the `runtime.buildId` the installer's Rust
//! probe keys on) is resolved exactly as the CLI's `--version` resolves it.

use super::{spawn_daemon, Client};

/// This supervisor runs from the workspace with no packaged `package.json`
/// beside it, so the hello reports the dev-build fallback — the compiled-in
/// workspace version, the same string the CLI's `--version` prints for a
/// dev build. A channel-restamped payload (the packaged-layout e2e in
/// pa-cli) answers its manifest stamp instead, through the same seam.
#[test]
fn daemon_hello_reports_the_dev_build_identity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (_client, hello) = Client::connect(&socket);
    assert_eq!(hello["type"], "daemon_hello");
    assert_eq!(
        hello["appVersion"],
        env!("CARGO_PKG_VERSION"),
        "no packaged manifest beside this dev build: the compiled-in workspace version"
    );
    assert_eq!(
        hello["runtime"]["buildId"],
        format!("pa-daemon-rs-{}", env!("CARGO_PKG_VERSION")),
        "the build id keeps the installer's pa-daemon-rs- prefix"
    );
}
