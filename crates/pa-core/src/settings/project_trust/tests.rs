//! The CWE-426 gate against a malicious-project fixture: the project
//! document stays entirely inert until its exact bytes are trusted, and
//! any change re-gates. The stdio-spawn seam — the `mcp.config` host
//! request the kernel spawns servers through — proves the declared
//! command never becomes spawnable off the project file.

use super::*;
use crate::mcp::{McpManager, McpServerConfig};
use crate::resources::{load_resources, ResourceLoaderOptions};
use crate::settings::{SettingsManager, CONFIG_DIR_NAME};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn load_resources_cold(cwd: &Path, agent_dir: &Path) -> crate::resources::LoadedResources {
    load_resources(ResourceLoaderOptions::new(
        cwd.to_path_buf(),
        agent_dir.to_path_buf(),
    ))
    .expect("resource load")
}

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
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &project_settings(&cwd),
        &project_fingerprint(&project_settings(&cwd)).unwrap(),
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
        &project_fingerprint(&settings_path).unwrap(),
    )
    .unwrap();

    std::fs::write(&settings_path, r#"{ "theme": "changed-theme" }"#).unwrap();
    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert_eq!(manager.settings().theme, None, "a changed file re-gates");

    trust_project(
        &registry_path,
        &settings_path,
        &project_fingerprint(&settings_path).unwrap(),
    )
    .unwrap();
    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert_eq!(manager.settings().theme.as_deref(), Some("changed-theme"));
}

/// The pin covers `SYSTEM.md` and `APPEND_SYSTEM.md` beside the settings
/// file: a changed prompt file, or one that appears after trust, re-gates
/// the whole project. Red against a settings-only pin.
#[test]
fn a_changed_or_new_system_prompt_file_re_gates_the_project() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    let settings_path = malicious_project(&cwd, &dir.path().join("marker"));
    let system = settings_path.with_file_name("SYSTEM.md");
    std::fs::write(&system, "trusted prompt").unwrap();
    let trust = || {
        trust_project(
            &agent_dir.join(TRUSTED_PROJECTS_FILE),
            &settings_path,
            &project_fingerprint(&settings_path).unwrap(),
        )
        .unwrap();
    };
    trust();
    assert!(SettingsManager::create(&cwd, &agent_dir).project_config_trusted());

    std::fs::write(&system, "pulled prompt").unwrap();
    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert!(
        !manager.project_config_trusted(),
        "a changed SYSTEM.md re-gates"
    );
    assert_eq!(
        manager.settings().theme,
        None,
        "the settings re-gate with it"
    );

    trust();
    std::fs::write(settings_path.with_file_name("APPEND_SYSTEM.md"), "appended").unwrap();
    assert!(
        !SettingsManager::create(&cwd, &agent_dir).project_config_trusted(),
        "a new APPEND_SYSTEM.md re-gates"
    );
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
    assert!(!project_trusted(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &project_settings(&cwd),
        &project_fingerprint(&project_settings(&cwd)).unwrap()
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
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &settings_path,
        &project_fingerprint(&settings_path).unwrap(),
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
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &settings_path,
        &project_fingerprint(&settings_path).unwrap(),
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
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &settings_path,
        &project_fingerprint(&settings_path).unwrap(),
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
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &settings_path,
        &project_fingerprint(&settings_path).unwrap(),
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
    assert!(
        errors
            .iter()
            .any(|error| error.message.contains("not trusted. Reopen")),
        "the refusal reads as a normal sentence, not a padded line: {errors:?}"
    );
    assert!(
        manager.settings().skills.is_none(),
        "a refused write must not update the in-memory session either"
    );
    assert_eq!(
        std::fs::read_to_string(&settings_path).unwrap(),
        r#"{ "theme": "pulled-theme" }"#,
        "the refused write must not touch the file"
    );
}

/// The privacy opt-outs in an untrusted project document still apply: the
/// project's `agentTraces`/`telemetry` opt-outs and `images.blockImages`
/// survive the gate — declining trust must never increase sharing — while
/// everything else stays inert. Red against a whole-document drop.
#[test]
fn untrusted_project_opt_outs_still_apply() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let marker = dir.path().join("marker");
    malicious_project(&cwd, &marker);
    std::fs::write(
        project_settings(&cwd),
        r#"{
        "theme": "injected-theme",
        "agentTraces": { "enabled": false },
        "telemetry": { "enabled": false },
        "images": { "blockImages": true }
    }"#,
    )
    .unwrap();
    let mut manager = SettingsManager::create(&cwd, &agent_dir);
    assert_eq!(
        manager.settings().theme,
        None,
        "non-restrictive keys stay inert"
    );
    assert!(
        !manager.get_agent_traces_enabled(),
        "the trace opt-out applies"
    );
    assert!(
        !manager.get_telemetry_enabled(),
        "the telemetry opt-out applies"
    );
    assert_eq!(
        manager
            .settings()
            .images
            .as_ref()
            .and_then(|images| images.block_images),
        Some(true),
        "the image restriction applies"
    );
    assert!(manager.drain_errors().is_empty());
}

/// A malformed untrusted project document still records its load error, so
/// the trace upload's fail-closed `errors().is_empty()` rule keeps working.
#[test]
fn a_malformed_untrusted_document_fails_the_trace_upload_gate() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    malicious_project(&cwd, &dir.path().join("marker"));
    std::fs::write(project_settings(&cwd), "{not json").unwrap();
    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert!(
        !manager.errors().is_empty(),
        "the malformed document must keep the fail-closed rule armed"
    );
}

/// The discovered project config (SYSTEM.md, the skills directory, an
/// ancestor `.agents/skills`) loads only behind the project-dir trust
/// decision — one trust covers the whole surface. Red against ungated
/// discovery.
#[test]
fn discovered_project_config_loads_only_when_trusted() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    malicious_project(&cwd, &dir.path().join("marker")); // settings.json present
    let config = cwd.join(CONFIG_DIR_NAME);
    std::fs::write(config.join("SYSTEM.md"), "# replaced system prompt").unwrap();
    std::fs::create_dir_all(config.join("skills/evil")).unwrap();
    std::fs::write(
        config.join("skills/evil/SKILL.md"),
        "---\nname: evil\ndescription: injected skill\n---\nInjected body",
    )
    .unwrap();
    let ancestor = dir
        .path()
        .join(".agents")
        .join("skills")
        .join("ancestor-evil");
    std::fs::create_dir_all(&ancestor).unwrap();
    std::fs::write(
        ancestor.join("SKILL.md"),
        "---\nname: ancestor-evil\ndescription: x\n---\nB",
    )
    .unwrap();

    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert!(!manager.project_config_trusted());
    let resources = load_resources_cold(&cwd, &agent_dir);
    assert!(
        resources
            .skills
            .iter()
            .all(|skill| skill.name != "evil" && skill.name != "ancestor-evil"),
        "discovered skills must stay inert until trusted"
    );
    assert_ne!(
        resources.system_prompt.as_deref(),
        Some("# replaced system prompt")
    );

    let settings_path = project_settings(&cwd);
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &settings_path,
        &project_fingerprint(&settings_path).unwrap(),
    )
    .unwrap();
    let resources = load_resources_cold(&cwd, &agent_dir);
    assert!(resources.skills.iter().any(|skill| skill.name == "evil"));
    assert!(resources
        .skills
        .iter()
        .any(|skill| skill.name == "ancestor-evil"));
    assert_eq!(
        resources.system_prompt.as_deref(),
        Some("# replaced system prompt")
    );
}

/// A project write with no existing settings file creates the file but
/// never a trust decision: the new pin would have authorized the gated
/// sibling files (SYSTEM.md, discovered skills) unasked. Red against a
/// write path that pins authored-fresh bytes.
#[test]
fn an_absent_document_write_creates_no_trust() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    let config = cwd.join(CONFIG_DIR_NAME);
    std::fs::create_dir_all(config.join("skills/stray")).unwrap();
    std::fs::write(
        config.join("skills/stray/SKILL.md"),
        "---\nname: stray\ndescription: sibling\n---\nBody",
    )
    .unwrap();

    let mut manager = SettingsManager::create(&cwd, &agent_dir);
    manager.set_project_resource_array("skills", vec!["custom".to_string()]);
    assert!(
        manager.drain_errors().is_empty(),
        "the write itself succeeds"
    );
    assert!(project_settings(&cwd).exists(), "the file landed");
    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert!(
        !manager.project_config_trusted(),
        "an authored-fresh write never creates trust"
    );
    let resources = load_resources_cold(&cwd, &agent_dir);
    assert!(
        resources.skills.iter().all(|skill| skill.name != "stray"),
        "gated siblings stay inert without a trust decision"
    );
}

/// Distinct non-UTF-8 project paths keep distinct registry keys: the digest
/// key is lossless where a lossy text key would collide.
#[cfg(unix)]
#[test]
fn distinct_non_utf8_paths_keep_distinct_registry_keys() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    let a = Path::new(OsStr::from_bytes(
        b"/nonexistent/a\xffb/.prime/agent/settings.json",
    ));
    let b = Path::new(OsStr::from_bytes(
        b"/nonexistent/a\xfeb/.prime/agent/settings.json",
    ));
    assert_ne!(
        super::registry_key(a),
        super::registry_key(b),
        "a lossy text key would collide these two projects"
    );
}

/// An unreadable settings file never rides the absence pin: after trusting
/// a settings-less project, a file that appears unreadable refuses.
#[cfg(unix)]
#[test]
fn an_unreadable_settings_file_never_rides_the_absence_pin() {
    // Invalid UTF-8 content is the root-proof unreadable case: CI and the
    // gate containers run as root, where permission bits never fail a read.
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    let settings_path = project_settings(&cwd);
    std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &settings_path,
        &project_fingerprint(&settings_path).unwrap(),
    )
    .unwrap();
    std::fs::write(&settings_path, b"{\"theme\": \xff invalid}").unwrap();
    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert!(
        !manager.project_config_trusted(),
        "an unreadable (non-UTF-8) file must refuse instead of riding the absence pin"
    );
}

/// The legacy telemetry bool (`"telemetry": false`) is a privacy opt-out and
/// survives the untrusted projection through the same migration the trusted
/// path applies.
#[test]
fn a_legacy_telemetry_bool_opt_out_survives_untrusted() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let settings_path = project_settings(&cwd);
    std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    std::fs::write(&settings_path, r#"{"telemetry": false}"#).unwrap();
    let manager = SettingsManager::create(&cwd, &agent_dir);
    assert!(
        !manager.get_telemetry_enabled(),
        "the legacy opt-out must apply while untrusted"
    );
}

/// A trust decision recorded while the settings file was absent (the
/// absence pin) extends to the user's own first write: the new bytes
/// re-pin, so the already-authorized gated surface (SYSTEM.md, discovered
/// skills) survives the file's creation. Red against a write path that
/// treats every absent document as trust-creating-none.
#[test]
fn an_absence_pin_extends_to_the_first_write() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("repo");
    let config = cwd.join(CONFIG_DIR_NAME);
    std::fs::create_dir_all(config.join("skills/authorized")).unwrap();
    std::fs::write(
        config.join("skills/authorized/SKILL.md"),
        "---\nname: authorized\ndescription: sibling\n---\nBody",
    )
    .unwrap();
    let settings_path = project_settings(&cwd);
    trust_project(
        &agent_dir.join(TRUSTED_PROJECTS_FILE),
        &settings_path,
        &project_fingerprint(&settings_path).unwrap(),
    )
    .unwrap();
    let before = SettingsManager::create(&cwd, &agent_dir);
    assert!(
        before.project_config_trusted(),
        "the absence pin authorizes"
    );

    let mut manager = SettingsManager::create(&cwd, &agent_dir);
    manager.set_project_resource_array("skills", vec!["custom".to_string()]);
    assert!(
        manager.drain_errors().is_empty(),
        "the first write succeeds"
    );
    assert!(settings_path.exists(), "the file was created");

    let after = SettingsManager::create(&cwd, &agent_dir);
    assert!(
        after.project_config_trusted(),
        "the first write re-pins the new bytes instead of dropping the trust"
    );
    let resources = load_resources_cold(&cwd, &agent_dir);
    assert!(
        resources
            .skills
            .iter()
            .any(|skill| skill.name == "authorized"),
        "the already-authorized sibling survives the write"
    );
}
