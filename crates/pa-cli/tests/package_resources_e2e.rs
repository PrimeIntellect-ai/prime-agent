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

//! Binary-level e2e: a settings-configured package provides a skill that
//! appears in a created session's skill list. The scripted faux provider
//! answers with the request's system prompt (the `<available_skills>`
//! inventory), so the full pipeline is exercised: CLI parse -> settings
//! load -> package resolution -> resource loading -> system-prompt assembly
//! -> provider request -> event emission.

use std::path::{Path, PathBuf};
use std::process::Command;

struct Sandbox {
    home: tempfile::TempDir,
    cwd: PathBuf,
    agent_dir: PathBuf,
}

fn write(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn fixture_package(cwd: &Path) -> PathBuf {
    let pkg = cwd.join("fixture-pkg");
    write(
        &pkg.join("package.json"),
        r#"{"name":"fixture-pkg","version":"1.0.0"}"#,
    );
    write(
        &pkg.join("skills").join("e-greeting").join("SKILL.md"),
        "---\nname: e-greeting\ndescription: Greets from a package\n---\nSay hi warmly.",
    );
    pkg
}

fn sandbox(settings: &serde_json::Value) -> Sandbox {
    let home = tempfile::TempDir::new().unwrap();
    let cwd = home.path().join("work");
    let agent_dir = home.path().join("agent");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&agent_dir).unwrap();
    fixture_package(&cwd);
    write(&agent_dir.join("settings.json"), &settings.to_string());
    Sandbox {
        home,
        cwd,
        agent_dir,
    }
}

fn run(sandbox: &Sandbox, script: &serde_json::Value) -> (String, String, i32) {
    let output = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .args(["--mode", "json", "-p", "hi"])
        .env("HOME", sandbox.home.path())
        .env("PRIME_AGENT_CODING_AGENT_DIR", &sandbox.agent_dir)
        .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string())
        .env_remove("PRIME_AGENT_SESSION_DIR")
        .env_remove("PRIME_AGENT_CODING_AGENT_SESSION_DIR")
        .env_remove("PI_OFFLINE")
        .current_dir(&sandbox.cwd)
        .output()
        .expect("binary present");
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        output.status.code().unwrap_or(-1),
    )
}

fn assistant_text(stdout: &str) -> String {
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|value| value["type"] == "message_end" && value["message"]["role"] == "assistant")
        .and_then(|value| {
            value["message"]["content"]
                .as_array()
                .and_then(|content| content.first())
                .and_then(|block| block["text"].as_str())
                .map(str::to_string)
        })
        .expect("assistant message in output")
}

#[test]
fn package_provided_skill_appears_in_created_session_skill_list() {
    let script = serde_json::json!({ "responses": [{"systemPrompt": true}] });

    // No package configured: the skill stays absent.
    let bare = sandbox(&serde_json::json!({}));
    let (stdout, stderr, code) = run(&bare, &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    let text = assistant_text(&stdout);
    assert!(!text.contains("e-greeting"), "no skill without the package");

    // The configured package contributes its skill to the session.
    let configured = sandbox(&serde_json::json!({"packages": ["../work/fixture-pkg"]}));
    let (stdout, stderr, code) = run(&configured, &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    let text = assistant_text(&stdout);
    assert!(
        text.contains("<name>e-greeting</name>"),
        "system prompt lists the package skill:\n{text}"
    );
    assert!(text.contains("<description>Greets from a package</description>"));
    assert!(
        text.contains("fixture-pkg/skills/e-greeting/SKILL.md"),
        "location points into the package"
    );

    // An explicit empty skills filter disables the package's skills.
    let filtered = sandbox(&serde_json::json!({"packages": [{
        "source": "../work/fixture-pkg",
        "skills": [],
        "prompts": [],
        "themes": [],
    }]}));
    let (stdout, stderr, code) = run(&filtered, &script);
    assert_eq!(code, 0, "stderr: {stderr}");
    let text = assistant_text(&stdout);
    assert!(
        !text.contains("<name>e-greeting</name>"),
        "empty skills filter disables the skill"
    );
}
