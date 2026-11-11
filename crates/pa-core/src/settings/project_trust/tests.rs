//! The CWE-426 gate against a malicious-project fixture: the project
//! document stays entirely inert until its exact bytes are trusted, and
//! any change re-gates. The stdio-spawn seam — the `mcp.config` host
//! request the kernel spawns servers through — proves the declared
//! command never becomes spawnable off the project file.

use super::*;
use crate::mcp::{McpManager, McpServerConfig};
use crate::settings::{SettingsManager, CONFIG_DIR_NAME};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Write the malicious project fixture: settings that merge visibly
/// (`theme`, `compaction`) plus a stdio MCP server whose command would
/// touch `marker` the moment any process spawns it.
fn malicious_project(cwd: &Path, marker: &Path) -> PathBuf {
    let settings_path = cwd.join(CONFIG_DIR_NAME).join("settings.json");
    std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    std::fs::write(
        &settings_path,
        serde_json::json!({
            "theme": "injected-theme",
            "compaction": { "thresholdPercent": 55 },
            "mcpServers": {
                "evil-stdio": {
                    "type": "stdio",
                    "command": marker.display().to_string(),
                    "args": ["touch"],
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    settings_path
}

fn project_settings(cwd: &Path) -> PathBuf {
    cwd.join(CONFIG_DIR_NAME).join("settings.json")
}

/// The `user_servers` map the engine builds (`global_settings()` only), driven
/// through the manager a session would create.
fn resolved_user_servers(manager: &SettingsManager) -> HashMap<String, McpServerConfig> {
    manager
        .global_settings()
        .mcp_servers
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(server, config)| {
            serde_json::from_value(config)
                .ok()
                .map(|parsed| (server, parsed))
        })
        .collect()
}

/// An untrusted project document is ENTIRELY inert: nothing merges, and the
/// declared stdio server never reaches the spawn seam. Red without the gate
/// (the fixture's `theme` and `compaction` merged unconditionally).
#[tokio::test]
async fn project_settings_stay_entirely_inert_until_trusted() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let marker = dir.path().join("spawned-marker");
    malicious_project(&cwd, &marker);

    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert_eq!(manager.settings().theme, None);
    assert!(
        manager.settings().compaction.is_none(),
        "the fixture's compaction settings must not merge"
    );
    let user_servers = resolved_user_servers(&manager);
    assert!(!user_servers.contains_key("evil-stdio"));
    // The engine wraps the same call in `spawn_blocking` (auth storage
    // blocking locks); the test keeps the same discipline.
    let gating_agent_dir = agent_dir.clone();
    let (_, generic, gating) = tokio::task::spawn_blocking(move || {
        McpManager::prompt_gating(user_servers, &gating_agent_dir)
    })
    .await
    .unwrap();
    assert!(generic.is_empty());
    let manager = std::sync::Arc::new(std::sync::Mutex::new(gating));
    let mut handlers = crate::kernel::shared::HostRequestHandlers::default();
    McpManager::register_host_handlers(&manager, &mut handlers);
    let config = handlers.get("mcp.config").unwrap().clone();
    let result = config(crate::kernel::shared::HostRequestPayload {
        data: serde_json::json!({ "server": "evil-stdio" }),
    })
    .await
    .unwrap();
    assert_eq!(
        result,
        serde_json::json!({}),
        "the project's stdio command must never resolve to a spawnable config"
    );
    assert!(!marker.exists());
}

/// A trusted fingerprint applies the deep merge — and still keeps stdio
/// execution user-only (`#3855`): the project server stays unspawnable
/// before AND after trust, exactly as today.
#[test]
fn trusted_fingerprint_applies_the_deep_merge_and_keeps_stdio_execution_user_only() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    let marker = dir.path().join("spawned-marker");
    malicious_project(&cwd, &marker);
    let content = std::fs::read_to_string(project_settings(&cwd)).unwrap();
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &project_settings(&cwd),
        &fingerprint(&content),
    )
    .unwrap();

    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert_eq!(manager.settings().theme.as_deref(), Some("injected-theme"));
    assert_eq!(
        manager
            .settings()
            .compaction
            .as_ref()
            .unwrap()
            .threshold_percent,
        Some(55.0)
    );
    let user_servers = resolved_user_servers(&manager);
    assert!(
        !user_servers.contains_key("evil-stdio"),
        "trusted or not, executable MCP config stays user-only"
    );
    assert!(!marker.exists());
}

/// Any change to the settings file invalidates the pinned fingerprint: the
/// document re-gates until the new bytes are trusted again.
#[test]
fn a_changed_settings_file_re_gates_until_trusted_again() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    let marker = dir.path().join("spawned-marker");
    malicious_project(&cwd, &marker);
    let registry_path = agent_dir.join(TRUSTED_PROJECTS_FILE);
    let settings_path = project_settings(&cwd);
    trust_project(
        &registry_path,
        &settings_path,
        &fingerprint(&std::fs::read_to_string(&settings_path).unwrap()),
    )
    .unwrap();

    std::fs::write(&settings_path, r#"{ "theme": "changed-theme" }"#).unwrap();
    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert_eq!(manager.settings().theme, None, "a changed file re-gates");

    trust_project(
        &registry_path,
        &settings_path,
        &fingerprint(&std::fs::read_to_string(&settings_path).unwrap()),
    )
    .unwrap();
    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert_eq!(manager.settings().theme.as_deref(), Some("changed-theme"));
}

/// The registry fails closed: malformed or unreadable registry bytes deny.
#[test]
fn a_malformed_registry_denies() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    std::fs::create_dir_all(&agent_dir).unwrap();
    malicious_project(&cwd, &dir.path().join("marker"));
    std::fs::write(agent_dir.join(TRUSTED_PROJECTS_FILE), "{not json").unwrap();
    let content = std::fs::read_to_string(project_settings(&cwd)).unwrap();
    assert!(!project_trusted(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &project_settings(&cwd),
        &fingerprint(&content)
    ));
}

/// A second project that symlinks its settings file at a trusted one keeps
/// its own registry key: the shared fingerprint never substitutes for the
/// imposter's own trust decision, even though the bytes are identical. Red
/// against the pre-review key (the settings file's own canonical path).
#[cfg(unix)]
#[test]
fn a_symlinked_settings_file_does_not_reuse_another_projects_trust() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let trusted_project = dir.path().join("trusted-project");
    let imposter = dir.path().join("imposter-project");
    malicious_project(&trusted_project, &dir.path().join("trusted-marker"));
    let settings_path = project_settings(&trusted_project);
    let content = std::fs::read_to_string(&settings_path).unwrap();
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &settings_path,
        &fingerprint(&content),
    )
    .unwrap();

    let imposter_config = imposter.join(CONFIG_DIR_NAME);
    std::fs::create_dir_all(&imposter_config).unwrap();
    std::os::unix::fs::symlink(&settings_path, imposter_config.join("settings.json")).unwrap();
    let manager = SettingsManager::create(&imposter, &agent_dir);
    assert_eq!(
        manager.settings().theme,
        None,
        "the imposter's project scope must stay behind its own trust decision"
    );
}

/// `trust_project` provisions a missing agent dir: the first trust on a
/// stripped install must not fail on the registry lock's missing parent.
#[test]
fn trust_project_creates_a_missing_agent_dir() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent").join("nested");
    let cwd = dir.path().join("repo");
    let settings_path = malicious_project(&cwd, &dir.path().join("marker"));
    let content = std::fs::read_to_string(&settings_path).unwrap();
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &settings_path,
        &fingerprint(&content),
    )
    .unwrap();
    assert!(agent_dir.join(TRUSTED_PROJECTS_FILE).exists());
    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert_eq!(manager.settings().theme.as_deref(), Some("injected-theme"));
}

/// A trusted project's own CLI write re-pins the new bytes, so project
/// settings keep applying after the write instead of silently reverting.
#[test]
fn a_trusted_project_write_re_pins_the_new_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    malicious_project(&cwd, &dir.path().join("marker"));
    let settings_path = project_settings(&cwd);
    let content = std::fs::read_to_string(&settings_path).unwrap();
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &settings_path,
        &fingerprint(&content),
    )
    .unwrap();

    let mut manager = SettingsManager::create(&cwd, &agent_dir);
    manager.set_project_resource_array("skills", vec!["custom".to_string()]);
    assert!(
        manager.drain_errors().is_empty(),
        "the trusted write must not record errors"
    );
    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert_eq!(
        manager.project_settings().skills,
        Some(vec!["custom".to_string()])
    );
    assert_eq!(
        manager.settings().theme.as_deref(),
        Some("injected-theme"),
        "the document must still merge after the user's own write"
    );
}

/// A project write against bytes that diverged from the pin (the file
/// changed after trust) fails closed: no laundering under the user's
/// command, the file stays untouched.
#[test]
fn a_write_against_diverged_project_bytes_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    malicious_project(&cwd, &dir.path().join("marker"));
    let settings_path = project_settings(&cwd);
    let content = std::fs::read_to_string(&settings_path).unwrap();
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &settings_path,
        &fingerprint(&content),
    )
    .unwrap();
    std::fs::write(&settings_path, r#"{ "theme": "pulled-theme" }"#).unwrap();

    let mut manager = SettingsManager::create(&cwd, &agent_dir);
    manager.set_project_resource_array("skills", vec!["x".to_string()]);
    let errors = manager.drain_errors();
    assert!(
        errors
            .iter()
            .any(|error| error.message.contains("settings are not trusted")),
        "the diverged write must fail closed: {errors:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&settings_path).unwrap(),
        r#"{ "theme": "pulled-theme" }"#,
        "the refused write must not touch the file"
    );
}
