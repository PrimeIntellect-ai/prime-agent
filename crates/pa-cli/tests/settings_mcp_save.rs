use std::process::Command;

use pa_core::settings::SettingsManager;
use serde_json::{json, Value};

#[test]
fn first_mcp_server_can_be_added_after_chat_detail_save_or_legacy_null() {
    for legacy_null in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).unwrap();
        let path = agent.join("settings.json");
        let mut initial = json!({"theme":"light","editorPaddingX":2});
        if legacy_null {
            initial["mcpServers"] = Value::Null;
        }
        std::fs::write(&path, initial.to_string()).unwrap();
        let mut manager = SettingsManager::create(dir.path(), &agent);
        manager.set_chat_detail("details").unwrap();
        let mut expected: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
            .args(["mcp", "add", "fixture", "--", "fixture-command"])
            .env("PRIME_AGENT_CODING_AGENT_DIR", &agent)
            .env("DO_NOT_TRACK", "1")
            .env("HOME", dir.path())
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        expected["mcpServers"] = json!({"fixture":{"type":"stdio","command":"fixture-command"}});
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap(),
            expected
        );
    }
}

#[test]
fn mcp_registration_preserves_invalid_documents_and_non_null_maps() {
    for content in ["{bad", "[]", r#"{"mcpServers":[],"theme":"light"}"#] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, content).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
            .args(["mcp", "add", "fixture", "--", "fixture-command"])
            .env("PRIME_AGENT_CODING_AGENT_DIR", dir.path())
            .env("DO_NOT_TRACK", "1")
            .env("HOME", dir.path())
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert_eq!(std::fs::read_to_string(path).unwrap(), content);
    }
}
