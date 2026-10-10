//! Decision API live checks: the Prime Inference clef endpoint.
//!
//! The offline pins always run: the registry recipe (baseUrl, the key from an
//! env-var name, the team header from the stored login, the vision-capable
//! `clef` model) resolves through the spawn seam, and the unset setting
//! refuses with `decide()`'s actionable message. The billed `decide()` round
//! trip is opt-in: `PA_DECISION_LIVE=1` with `PA_DECISION_LIVE_API_KEY`
//! (and `PA_DECISION_LIVE_TEAM_ID`) set, and the endpoint reachable.

use std::time::Duration;

use serde_json::{json, Value};

use pa_core::auth::AuthStorage;
use pa_core::models::{find_exact_model_reference_match, ModelRegistry};
use pa_core::session_engine::decision_api::{decision_model_selector, serve_decision_request};

const LIVE_ENV: &str = "PA_DECISION_LIVE";
const LIVE_KEY_ENV: &str = "PA_DECISION_LIVE_API_KEY";
const LIVE_TEAM_ENV: &str = "PA_DECISION_LIVE_TEAM_ID";
const ENDPOINT_HOST: &str = "api.pinference.ai";
const ENDPOINT_PORT: u16 = 443;

/// The registry recipe: the Prime Inference clef endpoint with the
/// vision-capable `clef` model. The `apiKey` is an env-var name; the
/// `X-Prime-Team-ID` header comes from the stored login's team.
fn recipe_models_json() -> String {
    r#"{ "providers": { "prime-inference": {
        "baseUrl": "https://api.pinference.ai/api/v1",
        "apiKey": "PA_DECISION_LIVE_API_KEY",
        "api": "systemone",
        "models": [ { "id": "cloudflare/clef", "input": ["text", "image"] } ]
    } } }"#
        .to_string()
}

/// One live fixture dir: the recipe's models.json, the stored login (the
/// key and team from the live env when set), and the decisionApi setting.
fn live_dir(key: Option<&str>, team: Option<&str>) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("sessions")).unwrap();
    std::fs::write(dir.path().join("models.json"), recipe_models_json()).unwrap();
    let mut login = json!({ "prime-inference": {
        "type": "api_key",
        "key": key.unwrap_or("PA_DECISION_LIVE_API_KEY"),
    }});
    if let Some(team) = team {
        login["prime-inference"]["primeTeam"] = json!({ "teamId": team, "name": "decision live" });
    }
    std::fs::write(
        dir.path().join("auth.json"),
        serde_json::to_string(&login).unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("settings.json"),
        json!({ "decisionApi": { "systemOneModel": "prime-inference/cloudflare/clef" } })
            .to_string(),
    )
    .unwrap();
    dir
}

#[test]
fn the_clef_recipe_pins_the_spawn_seam_and_the_offline_refusals() {
    // The unset setting refuses with decide()'s actionable message — the
    // same refusal the spawn seam serves.
    let dir = live_dir(None, None);
    std::fs::write(dir.path().join("settings.json"), json!({}).to_string()).unwrap();
    let refusal = decision_model_selector(dir.path(), dir.path()).unwrap_err();
    assert!(
        refusal.starts_with("decisionApi.systemOneModel is not set in settings.json"),
        "{refusal}"
    );

    // The recipe resolves through the registry: the spawn seam's selector,
    // the vision-capable model, and the merged request auth (the env-var
    // key + the login's X-Prime-Team-ID header).
    let dir = live_dir(Some("fixture-key"), Some("fixture-team"));
    assert_eq!(
        decision_model_selector(dir.path(), dir.path()).unwrap(),
        "prime-inference/cloudflare/clef",
        "the spawn seam resolves the settings reference"
    );
    let auth = AuthStorage::create(dir.path());
    let mut registry = ModelRegistry::create(auth, dir.path().join("models.json"));
    let available: Vec<pa_types::ai::Model> =
        registry.get_available().into_iter().cloned().collect();
    let clef = find_exact_model_reference_match("cloudflare/clef", &available)
        .or_else(|| find_exact_model_reference_match("prime-inference/cloudflare/clef", &available))
        .expect("the recipe's clef model resolves")
        .clone();
    assert!(
        clef.input.contains(&pa_types::ai::ModelInput::Image),
        "the recipe's clef model is vision-capable"
    );
    assert_eq!(
        clef.api, "systemone",
        "the recipe rides the decision protocol"
    );
    let resolved = registry.get_api_key_and_headers(&clef, None);
    assert!(resolved.ok);
    assert!(resolved.api_key.is_some(), "the env-var key resolves");
    let headers = resolved.headers.expect("the login's team header merges");
    assert_eq!(
        headers.get("X-Prime-Team-ID").map(String::as_str),
        Some("fixture-team"),
        "the stored login scopes the team header"
    );

    // An unresolvable reference (the setting names a model the recipe does
    // not carry) refuses with the actionable message, never a provider call.
    std::fs::write(
        dir.path().join("settings.json"),
        json!({ "decisionApi": { "systemOneModel": "prime-inference/no-such-model" } }).to_string(),
    )
    .unwrap();
    let refusal = decision_model_selector(dir.path(), dir.path()).unwrap_err();
    assert!(
        refusal.contains("could not be resolved to an available, authenticated model"),
        "{refusal}"
    );
    assert!(
        refusal.contains("prime-inference/no-such-model"),
        "the refusal names the reference"
    );
}

/// The network-availability gate: an opted-in run (the live env set) probes
/// the endpoint before any billed call.
async fn endpoint_reachable() -> bool {
    if std::env::var_os(LIVE_ENV).as_deref() != Some(std::ffi::OsStr::new("1")) {
        eprintln!("{LIVE_ENV} not set; skipping the live clef decide round trip");
        return false;
    }
    if std::env::var_os(LIVE_KEY_ENV).is_none() {
        eprintln!("{LIVE_KEY_ENV} not set; skipping the live clef decide round trip");
        return false;
    }
    let probe = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect((ENDPOINT_HOST, ENDPOINT_PORT)),
    )
    .await;
    if let Ok(Ok(_)) = probe {
        true
    } else {
        eprintln!("{ENDPOINT_HOST} unreachable; skipping the live clef decide round trip");
        false
    }
}

/// One end-to-end `decide()` round trip over the clef endpoint: the text
/// decision and the vision (image) decision, through the same host path the
/// decision child serves.
#[tokio::test]
async fn the_clef_endpoint_serves_the_decide_round_trip() {
    if !endpoint_reachable().await {
        return;
    }
    let key = std::env::var(LIVE_KEY_ENV).unwrap();
    let team = std::env::var(LIVE_TEAM_ENV).ok();
    let dir = live_dir(Some(&key), team.as_deref());
    let cwd = dir.path().to_path_buf();
    let agent_dir = dir.path().to_path_buf();
    let actions = json!({
        "left": "Move toward a target on the left",
        "right": "Move toward a target on the right",
        "wait": "Do nothing while already aligned",
    });
    let request = json!({
        "state": { "observation": { "target_direction": "left" }, "goal": "Move toward the target" },
        "questions": { "action": {
            "type": "choice",
            "instructions": "Choose the next action that best advances the goal given the observation.",
            "criteria": actions,
        } }
    });
    let answer = serve_decision_request(request.clone(), &cwd, &agent_dir)
        .await
        .expect("the live clef decide round trip");
    assert_eq!(
        answer["model"], "prime-inference/cloudflare/clef",
        "{answer}"
    );
    let decision = &answer["answers"]["action"];
    let choice = decision["choice"].as_str().unwrap();
    assert!(
        ["left", "right", "wait"].contains(&choice),
        "the choice names a requested action: {decision}"
    );
    let confidence = decision["confidence"].as_f64().unwrap();
    assert!(
        (0.0..=1.0).contains(&confidence),
        "confidence stays in 0..=1: {decision}"
    );
    eprintln!("live clef text decision: {decision}");

    // The vision path: one small real PNG rides as an image block.
    let request = json!({
        "state": { "observation": { "frame": "a small red square centered" }, "goal": "Move toward the target" },
        "questions": { "action": {
            "type": "choice",
            "instructions": "Choose the next action that best advances the goal given the observation.",
            "criteria": actions,
        } },
        "images": [ format!("data:image/png;base64,{}", RED_SQUARE_PNG) ],
    });
    let answer = serve_decision_request(request, &cwd, &agent_dir)
        .await
        .expect("the live clef vision decide round trip");
    assert_eq!(
        answer["model"], "prime-inference/cloudflare/clef",
        "{answer}"
    );
    let decision = &answer["answers"]["action"];
    let choice = decision["choice"].as_str().unwrap();
    assert!(
        ["left", "right", "wait"].contains(&choice),
        "the vision choice names a requested action: {decision}"
    );
    eprintln!("live clef vision decision: {decision}");
    let _ = Value::Null;
}

/// A small (8x8) solid-red PNG: real image bytes, not a degenerate 1x1.
const RED_SQUARE_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mP4z8CAFTEMLQkAKP8/wc53yE8AAAAASUVORK5CYII=";
