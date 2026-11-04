//! The CLI's direct Python dispatch must use the same project startup boundary
//! as kernel probes and the persistent REPL.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

#[test]
fn factory_dispatch_and_probes_drop_project_python_paths() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let trusted = root.path().join("trusted");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&trusted).unwrap();
    let python = root.path().join("fake-python");
    std::fs::write(
        &python,
        r#"#!/bin/sh
[ "$1" = "-P" ] || exit 41
[ "$PYTHONPATH" = "$EXPECTED_TRUSTED" ] || exit 42
[ -z "${PYTHONHOME+x}" ] || exit 43
[ -z "${PYTHONUSERBASE+x}" ] || exit 44
case "$*" in
  *rlm.factory*)
    touch "$DISPATCH_MARKER"
    printf '%s\n' '{"ok":true,"machines":[]}'
    ;;
esac
"#,
    )
    .unwrap();
    std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
    let marker = root.path().join("factory-dispatched");
    let path = std::env::join_paths([Path::new("."), &project, &trusted]).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .args(["factory", "list", "--json"])
        .current_dir(&project)
        .env("PRIME_AGENT_KERNEL_PYTHON", &python)
        .env("PYTHONPATH", path)
        .env("PYTHONHOME", &project)
        .env("PYTHONUSERBASE", &project)
        .env("EXPECTED_TRUSTED", &trusted)
        .env("DISPATCH_MARKER", &marker)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(marker.exists(), "the factory dispatch never reached Python");
}

#[test]
fn missing_home_reports_agent_directory_requirement_without_a_panic() {
    let output = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .arg("config")
        .env_remove("HOME")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("HOME or PRIME_AGENT_CODING_AGENT_DIR is required"),
        "unexpected stderr: {stderr}"
    );
    assert!(!stderr.contains("panicked"), "unexpected panic: {stderr}");

    let help = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .arg("--help")
        .env_remove("HOME")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .output()
        .unwrap();
    assert!(help.status.success(), "help should not require a home");
}
