//! CLI command edges that need no session: a missing home directory and the
//! `machine` command hint.
#![cfg(unix)]

use std::process::Command;

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

    for args in [["help", "package"], ["package", "--help"]] {
        let help = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
            .args(args)
            .env_remove("HOME")
            .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
            .output()
            .unwrap();
        assert!(
            help.status.success(),
            "{args:?} should show help without a home: {}",
            String::from_utf8_lossy(&help.stderr)
        );
    }

    let package = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .args(["package", "list"])
        .env_remove("HOME")
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .output()
        .unwrap();
    assert_eq!(package.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&package.stderr)
        .contains("HOME or PRIME_AGENT_CODING_AGENT_DIR is required"));
}

#[test]
fn the_machine_command_hint_names_a_real_factory_command() {
    let home = tempfile::tempdir().unwrap();
    let hint_for = |args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
            .args(args)
            .env("HOME", home.path())
            .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        String::from_utf8_lossy(&output.stderr).into_owned()
    };
    for (args, hint) in [
        (
            &["machine", "validate", "some/dir"][..],
            "Use \"prime-agent factory import <path>\"; it validates the machine before importing it.",
        ),
        (&["machine", "list"][..], "Use \"prime-agent factory list\"."),
        (&["machine", "run", "x"][..], "Use \"prime-agent factory\"."),
    ] {
        let stderr = hint_for(args);
        assert!(stderr.contains(hint), "{args:?}: {stderr}");
    }
}
