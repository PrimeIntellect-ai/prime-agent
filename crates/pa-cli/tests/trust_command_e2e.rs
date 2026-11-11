//! `prime-agent trust --yes <dir>` records the project's trust, pinned to
//! its files as shown, without a terminal.

use std::process::{Command, Stdio};

#[test]
fn trust_yes_records_the_project_pin() {
    let root = tempfile::tempdir().unwrap();
    let agent_dir = root.path().join("agent");
    let project = root.path().join("project");
    let settings_path = project.join(".prime/agent/settings.json");
    std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    std::fs::write(&settings_path, r#"{"theme": "project-theme"}"#).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .args(["trust", "--yes"])
        .arg(&project)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &agent_dir)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(pa_core::settings::project_trusted(
        &agent_dir.join(pa_core::settings::TRUSTED_PROJECTS_FILE),
        &settings_path,
        &pa_core::settings::project_fingerprint(&settings_path).unwrap(),
    ));
}
