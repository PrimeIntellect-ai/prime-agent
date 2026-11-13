//! Configuration-only coverage: never build a session, kernel, or MCP transport.
use super::*;

#[test]
fn mcp_settings_stay_global_after_refresh_and_cwd_rebind() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let mut global: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../pa-core/tests/fixtures/mcp/global-settings.json"
    )))
    .unwrap();
    global["mcpCatalogSources"] = json!([concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../pa-core/tests/fixtures/mcp/global-services.json"
    )]);
    let mut project: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../pa-core/tests/fixtures/mcp/project-settings.json"
    )))
    .unwrap();
    project["mcpCatalogSources"] = json!([concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../pa-core/tests/fixtures/mcp/project-services.json"
    )]);
    std::fs::write(agent_dir.join("settings.json"), global.to_string()).unwrap();
    for cwd in [dir.path().to_path_buf(), dir.path().join("other-project")] {
        std::fs::create_dir_all(cwd.join(".prime/agent")).unwrap();
        std::fs::write(cwd.join(".prime/agent/settings.json"), project.to_string()).unwrap();
    }
    let engine = bare_engine(dir.path());
    let mut handlers = HostRequestHandlers::default();
    pa_core::mcp::McpManager::register_host_handlers(&engine.mcp, &mut handlers);
    let config = handlers.get("mcp.config").unwrap();
    for cwd in [dir.path().to_path_buf(), dir.path().join("other-project")] {
        engine.set_cwd(cwd);
        {
            let mut manager = engine.mcp.lock().unwrap();
            manager.refresh();
            assert_eq!(
                manager.get_enabled_persistent_generic_servers(),
                vec!["user-server"]
            );
            assert!(manager.service_descriptor("user-catalog").is_some());
            assert!(manager.service_descriptor("project-catalog").is_none());
        }
        for (name, expected) in global["mcpServers"].as_object().unwrap() {
            let actual = engine
                .runtime
                .block_on(config(pa_core::kernel::shared::HostRequestPayload {
                    data: json!({ "server": name }),
                }))
                .unwrap();
            assert_eq!(actual, *expected);
        }
        assert_eq!(
            engine
                .runtime
                .block_on(config(pa_core::kernel::shared::HostRequestPayload {
                    data: json!({ "server": "project-server" }),
                },))
                .unwrap(),
            json!({})
        );
        // A global edit still takes effect when the live manager refreshes.
        global["mcpServers"]["user-server"]["args"] = json!(["updated-user-argument"]);
        std::fs::write(agent_dir.join("settings.json"), global.to_string()).unwrap();
    }
}
