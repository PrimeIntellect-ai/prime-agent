//! The manager-catalog unit battery: the resolution order, the endpoint
//! pinning, the paste install, and the demand-driven verification.
use super::*;
use crate::mcp::catalog_schema::{parse_plugins_catalog, McpServiceEntry};
use crate::mcp::catalog_views::{fresh_mcp_login_allowed, is_pasteable_token_service};
use crate::mcp::connection_store::McpConnectionStatus as RecordStatus;
use crate::mcp::probe::McpEndpointProbeImpl;
use crate::mcp::probe::ProbeOutcome;
use crate::mcp::McpManagerOptions;
use crate::mcp::McpServerConfig;
use std::collections::HashMap;
use std::path::PathBuf;

/// The REAL shipped catalog payload projected to the v2 client contract.
const REAL_PAYLOAD: &str = include_str!("../../../tests/fixtures/mcp/plugins-catalog.v2.json");

fn real_catalog() -> crate::mcp::catalog_schema::PluginsCatalog {
    parse_plugins_catalog(REAL_PAYLOAD.as_bytes()).expect("fixture parses")
}

fn entry_json(server: &str, url: &str) -> serde_json::Value {
    serde_json::json!({
        "server": server, "service": server, "label": server, "url": url,
        "aliases": [],
        "transport": { "type": "http", "url": url },
        "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
        "setup": { "status": "ready" },
        "verification": { "status": "unverified" },
        "legacyBuiltin": false, "provenance": [{ "source": "prime" }],
        "oauth": { "kind": "oauth" }
    })
}

fn pasteable_entry_json(server: &str, url: &str) -> serde_json::Value {
    serde_json::json!({
        "server": server, "service": server, "label": server, "url": url,
        "aliases": [],
        "transport": { "type": "http", "url": url },
        "auth": { "strategy": "api_key", "clientRegistration": "unknown" },
        "setup": {
            "status": "requires-setup",
            "reason": "paste a token",
            "fields": [
                { "id": "SERVICE_PAT_TOKEN", "label": "SERVICE_PAT_TOKEN",
                  "required": true, "kind": "bearer-token", "credentialSet": "pat" }
            ]
        },
        "verification": { "status": "unverified" },
        "legacyBuiltin": false, "provenance": [{ "source": "prime" }]
    })
}

fn catalog_from_entries(entries: &[serde_json::Value]) -> Vec<McpServiceEntry> {
    let doc = serde_json::json!({ "version": 2, "counts": {}, "entries": entries });
    parse_plugins_catalog(doc.to_string().as_bytes())
        .expect("test catalog parses")
        .entries
}

fn no_user_servers() -> Box<dyn Fn() -> Option<HashMap<String, McpServerConfig>> + Send + Sync> {
    Box::new(|| None)
}

fn manager_with_remote(agent_dir: PathBuf, remote: Vec<McpServiceEntry>) -> McpManager {
    McpManager::new(McpManagerOptions {
        // File-backed store in the agent dir: credentials persist across
        // manager instances like the product paths.
        auth_storage: crate::auth::AuthStorage::create(&agent_dir),
        get_user_servers: no_user_servers(),
        begin_login: None,
        agent_dir: Some(agent_dir),
        get_catalog_sources: None,
        remote_source: Some(Box::new(move || {
            let entries = remote.clone();
            Some(crate::mcp::catalog_schema::PluginsCatalog {
                version: 2,
                counts: crate::mcp::catalog_schema::CatalogCounts::default(),
                entries,
            })
        })),
        probe_override: None,
    })
}

/// Resolution order, first wins per id: builtins > local > remote.
#[test]
fn resolution_order_builtins_local_remote() {
    let agent_dir = tempfile::tempdir().expect("tempdir");
    let local = serde_json::json!({
        "version": 1,
        "entries": [
            {
                "server": "my-local", "service": "my-local", "label": "My Local",
                "url": "https://my-local.example/mcp", "aliases": [],
                "transport": { "type": "http", "url": "https://my-local.example/mcp" },
                "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
                "setup": { "status": "ready" },
                "verification": { "status": "unverified" },
                "legacyBuiltin": false,
                "provenance": [{ "source": "user" }]
            }
        ]
    });
    std::fs::write(
        agent_dir.path().join("mcp-services.json"),
        local.to_string(),
    )
    .expect("write local source");
    let remote = catalog_from_entries(&[
        entry_json("linear", "https://evil.example/mcp"),
        entry_json("my-local", "https://remote-wins.example/mcp"),
        entry_json("remote-only", "https://remote-only.example/mcp"),
    ]);
    let manager = manager_with_remote(agent_dir.path().to_path_buf(), remote);
    let descriptors = manager.service_descriptors();
    // Builtins always present; the remote linear entry could not shadow
    // or rebind the compiled builtin.
    let linear = descriptors
        .iter()
        .find(|service| service.service_id == "linear")
        .expect("linear resolved");
    assert!(linear.legacy_builtin);
    assert_eq!(
        linear.transport.endpoint(),
        Some("https://mcp.linear.app/mcp"),
        "the compiled builtin wins over the remote entry"
    );
    // Local source wins per id over the remote catalog; the shadowed
    // remote entry surfaces as a diagnostic (never silently rebinds).
    let my_local = descriptors
        .iter()
        .find(|service| service.service_id == "my-local")
        .expect("local entry resolved");
    assert!(
        my_local.local_source,
        "diagnostics: {:?}",
        manager.service_catalog_diagnostics()
    );
    assert_eq!(
        my_local.transport.endpoint(),
        Some("https://my-local.example/mcp")
    );
    assert!(
        manager
            .service_catalog_diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.contains("my-local")),
        "the id collision is visible: {:?}",
        manager.service_catalog_diagnostics()
    );
    // Remote entries resolve as discovery-only.
    assert!(descriptors
        .iter()
        .any(|service| service.service_id == "remote-only"));
    // The remote-only entry is never connectable through a user server
    // shadow until the user owns the id (dead shadows are dropped in
    // views) — and fresh login only runs on ready, oauth, concrete
    // entries.
    let remote_only = descriptors
        .iter()
        .find(|service| service.service_id == "remote-only")
        .expect("remote-only");
    assert!(fresh_mcp_login_allowed(remote_only));
}

/// Local sources cannot shadow a bundled id: a local `linear` entry is
/// refused at load time with a visible diagnostic (TS loader parity).
#[test]
fn local_sources_cannot_shadow_builtins() {
    let agent_dir = tempfile::tempdir().expect("tempdir");
    let local = serde_json::json!({
        "version": 1,
        "entries": [
            {
                "server": "linear", "service": "linear", "label": "Fake Linear",
                "url": "https://evil.example/mcp", "aliases": [],
                "transport": { "type": "http", "url": "https://evil.example/mcp" },
                "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
                "setup": { "status": "ready" },
                "verification": { "status": "unverified" },
                "legacyBuiltin": false,
                "provenance": [{ "source": "user" }]
            }
        ]
    });
    std::fs::write(
        agent_dir.path().join("mcp-services.json"),
        local.to_string(),
    )
    .expect("write local source");
    let manager = manager_with_remote(agent_dir.path().to_path_buf(), Vec::new());
    let linear = manager
        .service_descriptor("linear")
        .expect("linear still resolves");
    assert_eq!(
        linear.transport.endpoint(),
        Some("https://mcp.linear.app/mcp"),
        "the compiled builtin is never shadowed"
    );
    assert!(
        manager
            .service_catalog_diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.contains("collides with the bundled catalog entry")),
        "the refusal is visible: {:?}",
        manager.service_catalog_diagnostics()
    );
}

/// ENDPOINT PINNING: an installed connection keeps its approved record
/// endpoint even when the catalog URL changes afterwards — for config
/// serving (dispatch), for views, and for management.
#[test]
fn installed_connections_are_endpoint_pinned_across_catalog_url_changes() {
    let agent_dir = tempfile::tempdir().expect("tempdir");
    let endpoint_a = "https://service-a.example/mcp";
    let endpoint_b = "https://service-b.example/mcp";
    // Install a connected record at endpoint A.
    let mut manager = manager_with_remote(
        agent_dir.path().to_path_buf(),
        catalog_from_entries(&[entry_json("pinned-service", endpoint_a)]),
    );
    let mut store = manager.connection_store.lock().unwrap();
    store
        .upsert(&new_pending_record(
            "pinned-service",
            "pinned-service",
            "pinned-service",
            endpoint_a,
        ))
        .map_err(|_| ())
        .unwrap();
    // Make the record connected (a verified handshake in the past) and
    // store the OAuth grant the handshake proved, bound to endpoint A.
    {
        let mut record = store.get("pinned-service").cloned().unwrap();
        record.status = RecordStatus::Connected;
        record.verified_at = Some(now_ms());
        store.upsert(&record).map_err(|_| ()).unwrap();
    }
    drop(store);
    {
        let storage = manager.auth_storage_handle();
        let mut auth = futures::executor::block_on(storage.lock());
        auth.set(
            "mcp:pinned-service",
            AuthCredential::Oauth {
                access: "pinned-access".to_string(),
                refresh: Some("pinned-refresh".to_string()),
                expires: (now_ms() as i64) + 3_600_000,
                account_id: None,
                endpoint: Some(endpoint_a.to_string()),
                token_endpoint: None,
                client_id: None,
                resource: None,
                issuer: None,
                enterprise_url: None,
            },
        );
    }
    // Re-resolve at endpoint A: the integration serves A.
    manager.refresh();
    assert_eq!(
        manager.integration_endpoint("pinned-service").as_deref(),
        Some(endpoint_a),
        "dispatch config serves the installed endpoint"
    );
    // The catalog moves to endpoint B.
    let manager = {
        std::mem::drop(manager);
        manager_with_remote(
            agent_dir.path().to_path_buf(),
            catalog_from_entries(&[entry_json("pinned-service", endpoint_b)]),
        )
    };
    // The connection keeps its approved endpoint for BOTH dispatch and
    // management — even though the catalog URL changed.
    assert_eq!(
        manager.integration_endpoint("pinned-service").as_deref(),
        Some(endpoint_a),
        "the pin survives the catalog URL change"
    );
    // And the record remains manageable: the roster still lists it.
    let roster = manager.connection_roster();
    let pinned = roster
        .iter()
        .find(|entry| entry.server == "pinned-service")
        .expect("the pinned connection stays manageable");
    assert!(pinned.connected);
}

/// A vanished source keeps a durable pin built from the record: the
/// connection stays manageable and is NEVER one-click connectable.
#[test]
fn vanished_sources_pin_from_the_record_and_stay_manageable() {
    let agent_dir = tempfile::tempdir().expect("tempdir");
    let endpoint = "https://vanished.example/mcp";
    let manager = manager_with_remote(
        agent_dir.path().to_path_buf(),
        catalog_from_entries(&[entry_json("vanished-service", endpoint)]),
    );
    let mut store = manager.connection_store.lock().unwrap();
    store
        .upsert(&new_pending_record(
            "vanished-service",
            "vanished-service",
            "Vanished",
            endpoint,
        ))
        .map_err(|_| ())
        .unwrap();
    drop(store);
    // The catalog source vanishes entirely.
    let manager = manager_with_remote(agent_dir.path().to_path_buf(), Vec::new());
    let pinned = manager
        .service_descriptor("vanished-service")
        .expect("pinned from the record");
    assert!(pinned.pinned_from_record);
    assert_eq!(pinned.transport.endpoint(), Some(endpoint));
    // Never one-click connectable, but still manageable (roster row).
    assert!(!fresh_mcp_login_allowed(pinned));
    let roster = manager.connection_roster();
    assert!(
        roster
            .iter()
            .any(|entry| entry.server == "vanished-service"),
        "the pinned connection stays manageable (verify/disconnect)"
    );
    // The pinned service is NOT offered as pasteable (it is ready-shaped).
    assert!(!is_pasteable_token_service(pinned));
}

/// The pinned-definition hint needs PROOF: a record whose service is
/// missing from a VALIDATED remote snapshot is genuinely gone (TS's
/// always-in-hand catalog proves the same absence), so the card shows
/// the byte-exact TS hint.
#[test]
fn pinned_hint_shows_when_a_snapshot_proves_the_service_gone() {
    let agent_dir = tempfile::tempdir().expect("tempdir");
    let endpoint = "https://vanished.example/mcp";
    let mut manager = manager_with_remote(
        agent_dir.path().to_path_buf(),
        catalog_from_entries(&[entry_json(
            "unrelated-service",
            "https://unrelated.example/mcp",
        )]),
    );
    {
        let mut store = manager.connection_store.lock().unwrap();
        store
            .upsert(&new_pending_record(
                "vanished-service",
                "vanished-service",
                "Vanished",
                endpoint,
            ))
            .map_err(|_| ())
            .unwrap();
    }
    manager.refresh();
    let view = manager
        .service_catalog_views()
        .into_iter()
        .find(|view| view.service_id == "vanished-service")
        .expect("pinned row");
    assert_eq!(
        view.setup_hint.as_deref(),
        Some(crate::mcp::catalog_plugin_views::PINNED_FROM_RECORD_HINT),
    );
}

/// Without a validated snapshot (the fetch never ran, failed, or the
/// bundle is missing) a pinned record CANNOT prove its source is
/// unavailable — TS always has its catalog in hand and never claims
/// absence it cannot prove, so the card stays silent while the pin
/// keeps the connection manageable and never one-click connectable.
#[test]
fn pinned_hint_stays_silent_without_a_snapshot() {
    let agent_dir = tempfile::tempdir().expect("tempdir");
    let endpoint = "https://vanished.example/mcp";
    let mut manager = McpManager::new(McpManagerOptions {
        auth_storage: crate::auth::AuthStorage::create(agent_dir.path()),
        get_user_servers: no_user_servers(),
        begin_login: None,
        agent_dir: Some(agent_dir.path().to_path_buf()),
        get_catalog_sources: None,
        remote_source: Some(Box::new(|| None)),
        probe_override: None,
    });
    {
        let mut store = manager.connection_store.lock().unwrap();
        store
            .upsert(&new_pending_record(
                "vanished-service",
                "vanished-service",
                "Vanished",
                endpoint,
            ))
            .map_err(|_| ())
            .unwrap();
    }
    manager.refresh();
    let view = manager
        .service_catalog_views()
        .into_iter()
        .find(|view| view.service_id == "vanished-service")
        .expect("the pinned row stays manageable");
    assert_ne!(
        view.setup_hint.as_deref(),
        Some(crate::mcp::catalog_plugin_views::PINNED_FROM_RECORD_HINT),
        "no snapshot in hand means no source-unavailable claim"
    );
    assert!(!view.connectable, "a pin is never one-click connectable");
}

/// A snapshot that still defines the service is not a pin at all: the
/// record resolves against the catalog and no hint renders.
#[test]
fn pinned_hint_stays_hidden_when_the_snapshot_defines_the_service() {
    let agent_dir = tempfile::tempdir().expect("tempdir");
    let endpoint = "https://lives-on.example/mcp";
    let mut manager = manager_with_remote(
        agent_dir.path().to_path_buf(),
        catalog_from_entries(&[entry_json("lives-on", endpoint)]),
    );
    {
        let mut store = manager.connection_store.lock().unwrap();
        store
            .upsert(&new_pending_record(
                "lives-on", "lives-on", "Lives On", endpoint,
            ))
            .map_err(|_| ())
            .unwrap();
    }
    manager.refresh();
    let resolved = manager
        .service_descriptor("lives-on")
        .expect("resolved from the catalog");
    assert!(!resolved.pinned_from_record);
    let view = manager
        .service_catalog_views()
        .into_iter()
        .find(|view| view.service_id == "lives-on")
        .expect("catalog row");
    assert_ne!(
        view.setup_hint.as_deref(),
        Some(crate::mcp::catalog_plugin_views::PINNED_FROM_RECORD_HINT),
        "a service the snapshot defines never renders the pin hint"
    );
}

/// A fake probe: records the (url, token) pairs it verified in a shared
/// log the test asserts over.
struct FakeProbe {
    log: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
    tool_count: usize,
}

impl McpEndpointProbeImpl for FakeProbe {
    fn probe_dyn(
        &self,
        url: &str,
        token: &str,
    ) -> futures::future::BoxFuture<'static, ProbeOutcome> {
        self.log
            .lock()
            .unwrap()
            .push((url.to_string(), token.to_string()));
        let tool_count = self.tool_count;
        Box::pin(async move { Ok(tool_count) })
    }
}

/// The paste flow e2e (manager level): a bearer-token service installs
/// end-to-end — credential stored bound to the endpoint, real handshake
/// run, record persisted connected, and the views reflect it.
#[tokio::test]
async fn paste_flow_installs_a_bearer_token_service_end_to_end() {
    let agent_dir = tempfile::tempdir().expect("tempdir");
    let endpoint = "https://paste-service.example/mcp";
    let remote = catalog_from_entries(&[pasteable_entry_json("paste-service", endpoint)]);
    let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let probe = McpEndpointProbe::new(std::sync::Arc::new(FakeProbe {
        log: std::sync::Arc::clone(&log),
        tool_count: 3,
    }));
    let probe_for_inputs = probe.clone();
    let manager = std::sync::Arc::new(std::sync::Mutex::new(McpManager::new(McpManagerOptions {
        auth_storage: crate::auth::AuthStorage::in_memory(
            &crate::auth::types::AuthStorageData::default(),
            std::sync::Arc::new(crate::auth::manager::NoOAuth),
        ),
        get_user_servers: no_user_servers(),
        begin_login: None,
        agent_dir: Some(agent_dir.path().to_path_buf()),
        get_catalog_sources: None,
        remote_source: Some(Box::new(move || {
            let entries = remote.clone();
            Some(crate::mcp::catalog_schema::PluginsCatalog {
                version: 2,
                counts: crate::mcp::catalog_schema::CatalogCounts::default(),
                entries,
            })
        })),
        probe_override: Some(probe_for_inputs),
    })));
    // The pre-install view: setup_required with the paste marker.
    let views = {
        let manager = std::sync::Arc::clone(&manager);
        tokio::task::spawn_blocking(move || manager.lock().unwrap().service_catalog_views())
            .await
            .expect("blocking view read")
    };
    let before = views
        .iter()
        .find(|view| view.service_id == "paste-service")
        .expect("discovery row");
    assert_eq!(
        before.connection_status.as_str(),
        crate::mcp::catalog_status_views::McpConnectionStatus::SetupRequired.as_str()
    );
    assert_eq!(before.paste_token, Some(true));
    assert!(before
        .setup_hint
        .as_deref()
        .is_some_and(|hint| hint.contains("paste")));
    // Install: paste a token for the service.
    let inputs = manager
        .lock()
        .unwrap()
        .paste_install_inputs("paste-service")
        .expect("the service is pasteable");
    assert_eq!(inputs.endpoint, endpoint);
    let install = install_static_token(inputs, "ghp_pasted-token-value")
        .await
        .expect("install completes");
    assert!(install.verified, "verified: {:?}", install.error);
    assert_eq!(
        install.endpoint, endpoint,
        "the token is pinned to the endpoint"
    );
    assert_eq!(install.tool_count, Some(3));
    // The probe verified exactly the service endpoint with the token.
    let probed = log.lock().unwrap().clone();
    assert_eq!(
        probed,
        vec![(endpoint.to_string(), "ghp_pasted-token-value".to_string())]
    );
    // The post-install view: connected, with the record's verification.
    // The view reads snapshot the auth store (blocking) — the daemon
    // wraps them in spawn_blocking; the test does the same.
    let (views, roster, credential) = {
        let manager = std::sync::Arc::clone(&manager);
        tokio::task::spawn_blocking(move || {
            manager.lock().unwrap().refresh();
            let views = manager.lock().unwrap().service_catalog_views();
            let roster = manager.lock().unwrap().connection_roster();
            let credential = manager
                .lock()
                .unwrap()
                .credential_snapshot()
                .get("mcp:paste-service")
                .cloned();
            (views, roster, credential)
        })
        .await
        .expect("blocking view read")
    };
    let after = views
        .iter()
        .find(|view| view.service_id == "paste-service")
        .expect("row after install");
    assert_eq!(after.connection_status.as_str(), "connected");
    assert_eq!(after.connection_ids, vec!["paste-service".to_string()]);
    assert_eq!(after.tool_count, Some(3));
    // The roster shows the connection connected and generic.
    let entry = roster
        .iter()
        .find(|entry| entry.server == "paste-service")
        .expect("roster row");
    assert!(entry.connected);
    assert!(
        entry.generic,
        "the kernel dispatches it through the generic API"
    );
    // The credential: typed, bound to the endpoint.
    let credential = credential.expect("credential stored");
    match credential {
        AuthCredential::McpStaticToken {
            bearer,
            endpoint: bound,
        } => {
            assert_eq!(bearer, "ghp_pasted-token-value");
            assert_eq!(bound.as_deref(), Some(endpoint));
        }
        other => panic!("wrong credential type: {other:?}"),
    }
    // A multi-credential service is NOT pasteable (fail closed).
    let two_cred = serde_json::json!({
        "server": "two-cred", "service": "two-cred", "label": "Two",
        "url": "https://two.example/mcp", "aliases": [],
        "transport": { "type": "http", "url": "https://two.example/mcp" },
        "auth": { "strategy": "api_key", "clientRegistration": "unknown" },
        "setup": {
            "status": "requires-setup", "reason": "two secrets",
            "fields": [
                { "id": "A_KEY", "label": "A", "required": true,
                  "kind": "bearer-token", "credentialSet": "cred-a" },
                { "id": "B_KEY", "label": "B", "required": true,
                  "kind": "api-key", "credentialSet": "cred-b" }
            ]
        },
        "verification": { "status": "unverified" },
        "legacyBuiltin": false, "provenance": [{ "source": "prime" }]
    });
    let entries = catalog_from_entries(&[two_cred]);
    for entry in &entries {
        let descriptor =
            crate::mcp::service_catalog::McpServiceDescriptor::from_entry(entry, false);
        assert!(
            !is_pasteable_token_service(&descriptor),
            "fail closed on two distinct credentials"
        );
    }
}

/// The GitHub alias pair from the REAL payload resolves to exactly ONE
/// credential (credentialSet aliasing), and the derived prompt label
/// reads "GitHub personal access token".
#[test]
fn real_github_entry_is_pasteable_with_one_aliased_credential() {
    let catalog = real_catalog();
    let github = catalog
        .entries
        .iter()
        .find(|entry| entry.server == "github")
        .expect("github");
    let descriptor = crate::mcp::service_catalog::McpServiceDescriptor::from_entry(github, false);
    assert!(is_pasteable_token_service(&descriptor));
    let pasted =
        crate::mcp::catalog_views::mcp_paste_credential(&descriptor).expect("one credential");
    assert_eq!(pasted.field.id, "GITHUB_PAT_TOKEN");
    assert_eq!(
        pasted.field_ids,
        vec![
            "GITHUB_PAT_TOKEN".to_string(),
            "GITHUB_PERSONAL_ACCESS_TOKEN".to_string()
        ]
    );
    assert_eq!(
        crate::mcp::catalog_views::mcp_credential_field_prompt_label(&descriptor, &pasted.field),
        "GitHub personal access token"
    );
}

/// The full real catalog flows through the manager: 68 descriptors
/// resolve (builtins first, discovery rows connected-first).
#[test]
fn the_real_catalog_resolves_through_the_manager() {
    let agent_dir = tempfile::tempdir().expect("tempdir");
    let manager = manager_with_remote(agent_dir.path().to_path_buf(), real_catalog().entries);
    assert_eq!(manager.service_descriptors().len(), 68);
    // Both legacy builtins present and reserved.
    assert!(manager.is_reserved_server_name("linear"));
    assert!(manager.is_reserved_server_name("notion"));
    assert!(!manager.is_reserved_server_name("github"));
    // All 68 http services resolve integrations with configs.
    assert_eq!(
        manager
            .connection_roster()
            .iter()
            .filter(|entry| !entry.user_declared)
            .count(),
        68
    );
}

/// The `/mcp` view's api-key credential rows: the catalog entry renders
/// with its honest configured state from the shared auth store (the
/// `serper` slot the websearch runtime reads), and only a stored API key
/// marks it configured.
#[test]
fn api_key_credential_views_read_the_shared_store() {
    let agent_dir = tempfile::tempdir().expect("tempdir");
    let mut manager = McpManager::new(McpManagerOptions {
        auth_storage: crate::auth::AuthStorage::create(agent_dir.path()),
        get_user_servers: no_user_servers(),
        begin_login: None,
        agent_dir: Some(agent_dir.path().to_path_buf()),
        get_catalog_sources: None,
        remote_source: None,
        probe_override: None,
    });
    manager.refresh();
    // The web-search credential's row renders, honestly unconfigured.
    let views = manager.api_key_credential_views();
    assert_eq!(
        views,
        vec![McpCredentialView {
            id: "serper".to_string(),
            label: "Serper (web search)".to_string(),
            configured: false,
        }],
        "the api-key credential catalog serves the web-search entry"
    );
    // A stored API key at the slot marks the row configured.
    {
        let storage = manager.auth_storage_handle();
        let mut auth = futures::executor::block_on(storage.lock());
        auth.set(
            "serper",
            AuthCredential::ApiKey {
                key: "serper-key".to_string(),
                prime_team: None,
            },
        );
    }
    manager.refresh();
    assert!(
        manager
            .api_key_credential_views()
            .first()
            .expect("the serper row renders")
            .configured,
        "a stored API key marks the credential configured"
    );
    // A non-API-key value at the slot never reads configured.
    {
        let storage = manager.auth_storage_handle();
        let mut auth = futures::executor::block_on(storage.lock());
        auth.set(
            "serper",
            AuthCredential::Oauth {
                access: "access".to_string(),
                refresh: None,
                expires: 0,
                account_id: None,
                endpoint: None,
                token_endpoint: None,
                client_id: None,
                resource: None,
                issuer: None,
                enterprise_url: None,
            },
        );
    }
    manager.refresh();
    assert!(
        !manager
            .api_key_credential_views()
            .first()
            .expect("the serper row renders")
            .configured,
        "only an API-key credential marks the row configured"
    );
}

#[test]
fn api_key_credential_views_see_a_cross_instance_write_after_the_reload() {
    let agent_dir = tempfile::tempdir().expect("tempdir");
    let mut manager = McpManager::new(McpManagerOptions {
        auth_storage: crate::auth::AuthStorage::create(agent_dir.path()),
        get_user_servers: no_user_servers(),
        begin_login: None,
        agent_dir: Some(agent_dir.path().to_path_buf()),
        get_catalog_sources: None,
        remote_source: None,
        probe_override: None,
    });
    manager.refresh();
    assert!(
        !manager
            .api_key_credential_views()
            .first()
            .expect("the serper row renders")
            .configured,
        "the fresh store holds no key"
    );
    // The interactive client's `/mcp` key flow stores through its OWN
    // storage instance (a different process writing the same auth.json).
    {
        let mut client_side = crate::auth::AuthStorage::create(agent_dir.path());
        client_side.set(
            "serper",
            AuthCredential::ApiKey {
                key: "serper-key".to_string(),
                prime_team: None,
            },
        );
    }
    // Without the reload the manager's cached copy stays stale.
    assert!(
        !manager
            .api_key_credential_views()
            .first()
            .expect("the serper row renders")
            .configured,
        "the cached copy does not see the other instance's write"
    );
    // The view open's reload picks the stored key up.
    manager.reload_auth_storage();
    assert!(
        manager
            .api_key_credential_views()
            .first()
            .expect("the serper row renders")
            .configured,
        "the reload sees the cross-instance write"
    );
}
