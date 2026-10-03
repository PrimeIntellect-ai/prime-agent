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

/// A stored `"machine": null` beside a `dag` is the dag form — the
/// null-is-absent read every settled seam makes — so the preflight must
/// fall through to the dag's declared models, never read the null as an
/// empty machine (which exempted the dag's inline model selections from
/// the allowlist and auth checks before any child spawned).
#[test]
fn a_null_machine_falls_through_to_the_dag_spec() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    write_harness_state(
        dir.path(),
        &[
            // The poisoned shape only the /refine writer can store: the
            // kernel's Python `create_factory` writes exactly one of the
            // two keys; the planner's null-is-absent validation accepts
            // the dag form with an explicit null machine.
            factory_entry(
                "swept",
                &json!({
                    "dag": {
                        "nodes": [
                            { "id": "a",
                              "subagent": { "prompt": "p", "model": "testprov/declared-model" } }
                        ]
                    },
                    "machine": serde_json::Value::Null,
                }),
            ),
            // The bare null-dag mirror: the machine form wins, the null
            // dag must not shadow it.
            factory_entry(
                "machined",
                &json!({
                    "machine": {
                        "states": [
                            { "id": "a", "entry": true,
                              "subagent": { "prompt": "p", "model": "testprov/declared-model" } }
                        ]
                    },
                    "dag": serde_json::Value::Null,
                }),
            ),
        ],
        &[],
    );
    let bridge = host(dir.path(), None, None, false);
    assert_eq!(
        bridge.spec_model_selectors("swept").unwrap(),
        vec!["testprov/declared-model".to_string()],
        "the null machine falls through to the dag's declared models"
    );
    assert_eq!(
        bridge.spec_model_selectors("machined").unwrap(),
        vec!["testprov/declared-model".to_string()],
        "the null dag never shadows the machine form"
    );
    // End to end: the allowlist blocks the dag's declared model, so the
    // preflight must refuse the run (before the fix the read answered no
    // declared models and the preflight passed).
    let gated = host(
        dir.path(),
        None,
        Some(vec!["otherprov/allowed".to_string()]),
        false,
    );
    let refused = gated.preflight_run("swept");
    assert!(
        refused.is_err(),
        "the allowlist gate sees the dag form's declared model: {refused:?}"
    );
}

/// One subagent entry with an explicit title and model (the shared
/// helper hard-codes both to the id).
fn titled_subagent(id: &str, title: &str, model: &str) -> HarnessEntry {
    let mut metadata = Map::new();
    metadata.insert("model".to_string(), json!(model));
    HarnessEntry {
        id: id.to_string(),
        kind: RefinementKind::Subagent,
        title: title.to_string(),
        content: "Do the work.".to_string(),
        path: String::new(),
        scope: None,
        reference: Map::new(),
        arguments: Map::new(),
        metadata,
        source: "test".to_string(),
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
        version: 1,
    }
}

/// The kernel's own resolution order, tier by tier — the id, then the
/// title, within a tier before the next tier — so a local TITLED
/// subagent wins over a global ID of the same name: the old id-first
/// sweep matched the global id while the kernel's harness `get` +
/// title scan spawns the local titled subagent, so the preflight
/// validated (and allowlisted) the wrong model.
#[test]
fn a_local_title_wins_over_a_global_id_of_the_same_name() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    write_harness_state(
        dir.path(),
        // Global: the id "researcher", a model the allowlist would
        // happily allow while the kernel spawns another.
        &[
            titled_subagent("researcher", "g-titled", "testprov/other-model"),
            machine_entry(
                "spec",
                &json!({
                    "states": [{ "id": "a", "entry": true, "subagent": "researcher" }]
                }),
            ),
        ],
        // Local: the TITLE "researcher" under a different id, the model
        // the kernel's tier order actually spawns — and the SAME spec
        // entry the run names, because the kernel's unprefixed spec
        // lookup reads one store (its harness `get` has no
        // local-then-global fall-through): a spec stored only globally
        // is an UNKNOWN SPEC to the kernel, so the run the end-to-end
        // allowlist pins judge would reject before any spawn — the
        // bypass scenario must run a spec the kernel actually accepts.
        &[
            titled_subagent("titled-researcher", "researcher", "testprov/declared-model"),
            machine_entry(
                "spec",
                &json!({
                    "states": [{ "id": "a", "entry": true, "subagent": "researcher" }]
                }),
            ),
        ],
    );
    let bridge = host(dir.path(), None, None, true);
    assert_eq!(
        bridge.spec_model_selectors("spec").unwrap(),
        vec!["testprov/declared-model".to_string()],
        "the local titled subagent's model is the one the preflight reads"
    );
    // End to end, the allowlist pins the model the kernel actually
    // spawns (the local-title model): a gate that allows only the
    // global-id model must REFUSE the run — the exact bypass the old
    // id-first sweep produced, letting a blocked model spawn — and a
    // gate that allows the local-title model passes it.
    let allows_only_global_id = host(
        dir.path(),
        None,
        Some(vec!["testprov/other-model".to_string()]),
        true,
    );
    assert!(
        allows_only_global_id.preflight_run("spec").is_err(),
        "the allowlist gate must judge the model the run actually spawns"
    );
    let allows_actual = host(
        dir.path(),
        None,
        Some(vec!["testprov/declared-model".to_string()]),
        true,
    );
    assert!(
        allows_actual.preflight_run("spec").is_ok(),
        "the allowed actual model passes the gate"
    );
}

/// Among duplicate titles within a tier, the kernel's title scan reads
/// `harness.list` — sorted by (kind, path, title, id) — so it picks the
/// (path, id)-least entry; the preflight must read the same one, not
/// whichever entry the harness map's iteration order happens to offer.
#[test]
fn a_duplicate_title_resolves_the_kernel_list_order() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    let spec = json!({
        "states": [{ "id": "a", "entry": true, "subagent": "researcher" }]
    });
    write_harness_state(
        dir.path(),
        &[
            machine_entry("spec", &spec),
            // Two same-title locals; the kernel's sorted title scan picks
            // the (path, id)-least: path "", id "aaa-worker".
            titled_subagent("zzz-worker", "researcher", "testprov/other-model"),
        ],
        &[
            titled_subagent("aaa-worker", "researcher", "testprov/declared-model"),
            titled_subagent("mmm-worker", "researcher", "testprov/shared-id"),
        ],
    );
    let bridge = host(dir.path(), None, None, true);
    assert_eq!(
        bridge.spec_model_selectors("spec").unwrap(),
        vec!["testprov/declared-model".to_string()],
        "the (path, id)-least same-title entry is the one the preflight reads"
    );
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

/// An unresolvable subagent reference skips only its own state's read
/// (the kernel's `run()` owns the unknown-reference error): every other
/// state's declared models still preflight — one unknown reference must
/// not exempt a spec's declared models from the catalog, allowlist, and
/// auth checks (the mutation check on the best-effort read: the whole-spec
/// `None` read would pass both specs through untouched).
#[test]
fn an_unknown_reference_skips_only_its_own_state() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    write_harness_state(
        dir.path(),
        &[
            harness_entry("researcher", RefinementKind::Subagent, &json!({})),
            machine_entry(
                "mixed",
                &json!({
                    "states": [
                        { "id": "ghosted", "entry": true, "subagent": "ghost" },
                        { "id": "declared",
                          "subagent": { "prompt": "p", "model": "missingprov/model-x" } }
                    ]
                }),
            ),
            machine_entry(
                "allghost",
                &json!({ "states": [{ "id": "a", "entry": true, "subagent": "ghost" }] }),
            ),
        ],
        &[],
    );
    let bridge = host(dir.path(), None, None, false);
    // The sibling state's declared model still preflights loudly.
    assert_eq!(
        bridge.spec_model_selectors("mixed").unwrap(),
        vec!["missingprov/model-x".to_string()]
    );
    let error = bridge.preflight_run("mixed").unwrap_err().to_string();
    assert!(
        error.starts_with("Requested factory model \"missingprov/model-x\" is unavailable"),
        "{error}"
    );
    // A spec whose only reference is unknown stays best-effort clean: the
    // kernel's own `run()` owns the unknown-reference error.
    assert_eq!(
        bridge.spec_model_selectors("allghost").unwrap(),
        Vec::<String>::new()
    );
    bridge.preflight_run("allghost").unwrap();
}

/// Scoped ids (`local:`/`global:`) resolve their own store, exactly like
/// the kernel harness's `_strip_scope_prefix`: a scoped run preflights
/// against the exact entry it will execute (the mutation check: raw-map
/// lookups miss scoped ids entirely, so a scoped run would skip the
/// whole preflight).
#[test]
fn scoped_ids_preflight_their_own_store() {
    let dir = tempfile::tempdir().unwrap();
    write_catalog(dir.path());
    write_harness_state(
        dir.path(),
        &[
            harness_entry("researcher", RefinementKind::Subagent, &json!({})),
            machine_entry("global-scoped", &inline_machine("missingprov/model-x")),
            machine_entry(
                "byref-scoped",
                &json!({
                    "states": [
                        { "id": "a", "entry": true, "subagent": "global:researcher" }
                    ]
                }),
            ),
        ],
        &[machine_entry(
            "local-scoped",
            &inline_machine("testprov/other-model"),
        )],
    );
    let bridge = host(dir.path(), None, None, true);
    // The global-scoped id preflights the GLOBAL spec's declared model.
    let error = bridge
        .preflight_run("global:global-scoped")
        .unwrap_err()
        .to_string();
    assert!(
        error.starts_with("Requested factory model \"missingprov/model-x\" is unavailable"),
        "{error}"
    );
    // The local-scoped id resolves the LOCAL store's spec.
    assert_eq!(
        bridge.spec_model_selectors("local:local-scoped").unwrap(),
        vec!["testprov/other-model".to_string()]
    );
    bridge.preflight_run("local:local-scoped").unwrap();
    // A scoped subagent reference resolves its own store's entry.
    assert_eq!(
        bridge.spec_model_selectors("byref-scoped").unwrap(),
        vec!["testprov/declared-model".to_string()],
        "the global: reference resolves the global researcher entry"
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
