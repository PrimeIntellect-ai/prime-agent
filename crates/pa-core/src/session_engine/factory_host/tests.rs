//! The factory host bridge battery: the declared-selector extraction, the
//! `run` preflight (catalog resolution, the allowlist pin, request auth, the
//! session-model fallback), and the request validation (#3184 battery
//! style).

use std::path::Path;

use serde_json::{json, Map};

use crate::refinement::{empty_harness_state, save_harness_state, HarnessEntry, RefinementKind};

use super::{FactoryActivityRequest, FactoryHost, FactoryHostConfig};

const MODELS_JSON: &str = r#"{
  "providers": {
    "testprov": {
      "baseUrl": "http://localhost:9",
      "apiKey": "bridge-key",
      "api": "openai-completions",
      "models": [
        { "id": "declared-model", "name": "Declared Model", "contextWindow": 128000 },
        { "id": "shared-id", "name": "Shared One", "contextWindow": 128000 },
        { "id": "other-model", "name": "Other Model", "contextWindow": 128000 }
      ]
    },
    "otherprov": {
      "baseUrl": "http://localhost:10",
      "apiKey": "other-key",
      "api": "openai-completions",
      "models": [
        { "id": "shared-id", "name": "Shared Two", "contextWindow": 128000 }
      ]
    },
  }
}"#;

fn write_catalog(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("models.json"), MODELS_JSON).unwrap();
}

fn session_model() -> pa_agent::types::Model {
    serde_json::from_value(json!({
        "id": "session-model", "name": "Session Model", "api": "openai-completions",
        "provider": "testprov", "base_url": "http://localhost:9", "reasoning": false,
        "cost": { "input": 1.5, "output": 2.5, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 128_000, "maxTokens": 4096
    }))
    .unwrap()
}

fn harness_entry(id: &str, kind: RefinementKind, arguments: &serde_json::Value) -> HarnessEntry {
    let reference = Map::new();
    let mut metadata = Map::new();
    if kind == RefinementKind::Subagent {
        metadata.insert("model".to_string(), json!("testprov/declared-model"));
    }
    HarnessEntry {
        id: id.to_string(),
        kind,
        title: id.to_string(),
        content: "content".to_string(),
        path: String::new(),
        scope: None,
        reference,
        arguments: arguments.as_object().cloned().unwrap_or_default(),
        metadata,
        source: "test".to_string(),
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
        version: 1,
    }
}

/// Write one harness state file: global entries in `agent_dir/harness`, an
/// optional local overlay in `<dir>/local`.
fn write_harness_state(
    agent_dir: &Path,
    global_entries: &[HarnessEntry],
    local_entries: &[HarnessEntry],
) {
    let global_dir = crate::refinement::get_global_harness_state_dir(agent_dir);
    let mut global = empty_harness_state();
    global.schema = 1;
    for entry in global_entries {
        global
            .entries
            .get_mut(&entry.kind)
            .unwrap()
            .insert(entry.id.clone(), entry.clone());
    }
    save_harness_state(&global_dir, &global).unwrap();
    if !local_entries.is_empty() {
        let local_dir = agent_dir.join("local-harness");
        let mut local = empty_harness_state();
        local.schema = 1;
        for entry in local_entries {
            local
                .entries
                .get_mut(&entry.kind)
                .unwrap()
                .insert(entry.id.clone(), entry.clone());
        }
        save_harness_state(&local_dir, &local).unwrap();
    }
}

fn factory_entry(spec_id: &str, spec: &serde_json::Value) -> HarnessEntry {
    harness_entry(spec_id, RefinementKind::Factory, spec)
}

/// One factory entry's on-disk shape: the spec rides under `machine` (the
/// dag sugar under `dag`), exactly like `create_factory` stores it.
fn machine_entry(spec_id: &str, spec: &serde_json::Value) -> HarnessEntry {
    factory_entry(spec_id, &json!({ "machine": spec }))
}

fn dag_entry(spec_id: &str, spec: &serde_json::Value) -> HarnessEntry {
    factory_entry(spec_id, &json!({ "dag": spec }))
}

fn inline_machine(model: &str) -> serde_json::Value {
    json!({
        "run": { "max_parallel": 2 },
        "states": [
            { "id": "research", "entry": true,
              "subagent": { "prompt": "Do the work.", "model": model } }
        ]
    })
}

fn host(
    dir: &Path,
    session_model: Option<pa_agent::types::Model>,
    allowed_models: Option<Vec<String>>,
    local: bool,
) -> FactoryHost {
    FactoryHost::new(FactoryHostConfig {
        agent_dir: dir.to_path_buf(),
        global_harness_dir: crate::refinement::get_global_harness_state_dir(dir),
        local_harness_dir: local.then(|| dir.join("local-harness")),
        session_model,
        allowed_models,
    })
}

/// The declared selectors: an inline subagent object's `model`, and a
/// referenced harness subagent entry's `metadata.model`, from both spec
/// forms, deduped.

#[test]
fn declared_model_selectors_cover_both_subagent_forms_and_spec_forms() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    write_harness_state(
        dir.path(),
        &[
            harness_entry("researcher", RefinementKind::Subagent, &json!({})),
            machine_entry(
                "inline",
                &json!({
                    "states": [
                        { "id": "a", "entry": true,
                          "subagent": { "prompt": "p", "model": "testprov/declared-model" } },
                        { "id": "b", "subagent": { "prompt": "p" } }
                    ]
                }),
            ),
            machine_entry(
                "byref",
                &json!({
                    "states": [{ "id": "a", "entry": true, "subagent": "researcher" }]
                }),
            ),
            dag_entry(
                "dag",
                &json!({
                    "nodes": [
                        { "id": "a", "subagent": "researcher" },
                        { "id": "b", "subagent": { "prompt": "p", "model": "otherprov/shared-id" } }
                    ]
                }),
            ),
        ],
        &[],
    );
    let bridge = host(dir.path(), None, None, false);
    assert_eq!(
        bridge.spec_model_selectors("inline").unwrap(),
        vec!["testprov/declared-model".to_string()]
    );
    assert_eq!(
        bridge.spec_model_selectors("byref").unwrap(),
        vec!["testprov/declared-model".to_string()]
    );
    assert_eq!(
        bridge.spec_model_selectors("dag").unwrap(),
        vec![
            "testprov/declared-model".to_string(),
            "otherprov/shared-id".to_string()
        ]
    );
    // An unknown spec reads as None: the preflight passes through (the
    // kernel's own `run()` reports unknown specs).
    assert!(bridge.spec_model_selectors("missing").is_none());
}

/// The local overlay shadows the global spec by id (the merge's `local:`
/// rule keeps the shadowed global reachable under its own id).
#[test]
fn local_state_shadows_the_global_spec() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    write_harness_state(
        dir.path(),
        &[
            harness_entry("researcher", RefinementKind::Subagent, &json!({})),
            machine_entry("spec", &inline_machine("testprov/other-model")),
        ],
        &[machine_entry(
            "spec",
            &inline_machine("missingprov/model-x"),
        )],
    );
    // The bridge without the local dir sees the global spec.
    let global_only = host(dir.path(), None, None, false);
    global_only.preflight_run("spec").unwrap();
    // With the local dir, the shadowed spec's unresolvable model fails
    // the preflight loudly.
    let with_local = host(dir.path(), None, None, true);
    let error = with_local.preflight_run("spec").unwrap_err().to_string();
    assert!(
        error.starts_with("Requested factory model \"missingprov/model-x\" is unavailable"),
        "{error}"
    );
}

/// The `run` preflight: a declared model resolves through the catalog
/// (exact form and the TS short form) and passes with request auth.
#[test]
fn preflight_resolves_exact_and_short_form_selectors() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    write_harness_state(
        dir.path(),
        &[
            machine_entry("exact", &inline_machine("testprov/declared-model")),
            machine_entry("short", &inline_machine("declared-model")),
            machine_entry("ambiguous", &inline_machine("shared-id")),
        ],
        &[],
    );
    let bridge = host(dir.path(), None, None, false);
    bridge.preflight_run("exact").unwrap();
    bridge.preflight_run("short").unwrap();
    // A bare id naming two models stays unresolved.
    let error = bridge.preflight_run("ambiguous").unwrap_err().to_string();
    assert!(
        error.starts_with("Requested factory model \"shared-id\" is unavailable"),
        "{error}"
    );
}

/// The allowlist pin refuses a resolved declared model outside the pin,
/// exactly like the #3184 router handler.
#[test]
fn the_allowlist_pin_refuses_a_resolved_declared_model() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    write_harness_state(
        dir.path(),
        &[machine_entry(
            "spec",
            &inline_machine("testprov/declared-model"),
        )],
        &[],
    );
    let bridge = host(dir.path(), None, Some(vec!["other/*".to_string()]), false);
    let error = bridge.preflight_run("spec").unwrap_err().to_string();
    assert_eq!(
        error,
        "Requested factory model \"testprov/declared-model\" is blocked by the model allowlist"
    );
    // A selector inside the pin resolves.
    let bridge = host(
        dir.path(),
        None,
        Some(vec!["testprov/*".to_string()]),
        false,
    );
    bridge.preflight_run("spec").unwrap();
}

/// The session-model fallback: a declared selector naming the session's own
/// model (which the catalog does not carry) passes unless its provider is
/// stale or expired — the #3184 gate.
#[test]
fn the_session_model_fallback_gates_on_the_stale_provider() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    write_harness_state(
        dir.path(),
        &[
            machine_entry("named", &inline_machine("testprov/session-model")),
            machine_entry("foreign", &inline_machine("testprov/other-model")),
        ],
        &[],
    );
    let bridge = host(dir.path(), Some(session_model()), None, false);
    bridge.preflight_run("named").unwrap();
    // A declared selector the catalog carries never reaches the fallback.
    bridge.preflight_run("foreign").unwrap();
    // Without a session model, the catalog-miss selector fails loudly.
    let bridge = host(dir.path(), None, None, false);
    let error = bridge.preflight_run("named").unwrap_err().to_string();
    assert!(
        error.starts_with("Requested factory model \"testprov/session-model\" is unavailable"),
        "{error}"
    );
}

/// A spec whose states declare no models passes: every state rides the
/// spawn path's default chain, resolved per spawn.
#[test]
fn a_spec_without_declared_models_preflights_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    write_harness_state(
        dir.path(),
        &[machine_entry(
            "spec",
            &json!({"states": [{ "id": "a", "entry": true, "subagent": { "prompt": "p" } }]}),
        )],
        &[],
    );
    let bridge = host(dir.path(), None, None, false);
    bridge.preflight_run("spec").unwrap();
    // An unknown spec passes through: the kernel's `run()` owns the
    // unknown-spec error.
    bridge.preflight_run("missing").unwrap();
}

/// The request validation: known actions, required targets per action, and
/// the bounded watch timeout.
#[test]
fn factory_activity_requests_validate_like_the_kernel_frame() {
    let parse =
        |action: &str, run_id: Option<&str>, spec_id: Option<&str>, timeout_ms: Option<u64>| {
            FactoryActivityRequest::parse(action, run_id, spec_id, timeout_ms)
        };
    // the happy shapes
    assert_eq!(
        parse("graph", None, None, None).unwrap(),
        FactoryActivityRequest {
            action: "graph",
            run_id: None,
            spec_id: None,
            timeout_ms: None,
        }
    );
    assert_eq!(
        parse("graph", Some("  "), None, None).unwrap().run_id,
        None,
        "whitespace-only targets read as absent"
    );
    assert_eq!(
        parse("watch", Some("run-1"), None, Some(2_000))
            .unwrap()
            .timeout_ms,
        Some(2_000)
    );
    assert_eq!(
        parse("run", None, Some("spec-1"), None)
            .unwrap()
            .spec_id
            .as_deref(),
        Some("spec-1")
    );
    // unknown action
    assert_eq!(
        parse("bogus", None, None, None).unwrap_err().to_string(),
        "unknown factory activity action"
    );
    // required targets
    assert_eq!(
        parse("status", None, None, None).unwrap_err().to_string(),
        "factory activity status requires runId"
    );
    assert_eq!(
        parse("watch", None, None, None).unwrap_err().to_string(),
        "factory activity watch requires runId"
    );
    assert_eq!(
        parse("stop", None, None, None).unwrap_err().to_string(),
        "factory activity stop requires runId"
    );
    assert_eq!(
        parse("resume", None, None, None).unwrap_err().to_string(),
        "factory activity resume requires runId"
    );
    assert_eq!(
        parse("run", None, None, None).unwrap_err().to_string(),
        "factory activity run requires specId"
    );
    // the watch bound
    assert!(parse("watch", Some("r"), None, Some(60_000)).is_ok());
    let error = parse("watch", Some("r"), None, Some(60_001))
        .unwrap_err()
        .to_string();
    assert_eq!(error, "factory activity timeoutMs must be at most 60000");
}
