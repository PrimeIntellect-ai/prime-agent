//! `rlm.decide`: one fast decision from the `decisionModel` setting
//! ("System 1"), served directly by the host for kernel code. The model must
//! speak Prime Inference's structured-decision protocol (`api: "systemone"`):
//! the request POSTs to the model's `baseUrl` + `/systemone`. Each served call
//! appends one non-context [`DECISION_CUSTOM_TYPE`] entry with its usage,
//! which the session cost scan folds into the session's own totals.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail};
use pa_types::ai::{Model, ModelInput, Usage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::kernel::shared::{host_handler, HostRequestHandlers};
use crate::models::{
    find_exact_model_reference_match, model_allowed, ModelAllowlistRefusal, ModelRegistry,
};
use crate::session::manager::SessionManager;

/// The session entry type of one served decision (usage only, never context).
pub const DECISION_CUSTOM_TYPE: &str = "decision";
const DEFAULT_INSTRUCTIONS: &str =
    "Choose the next action that best advances the goal given the observation.";
/// One decision's whole-request bound (connect through the reply body).
const DECISION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_IMAGES: usize = 4;
/// The error body's bounded excerpt.
const ERROR_BODY_CHARS: usize = 500;
const SYSTEMONE_API: &str = "systemone";

/// The `decisionModel` reference resolved through the model registry, with
/// its request auth (key plus merged headers, including the team header).
struct ResolvedDecisionModel {
    model: Model,
    selector: String,
    api_key: Option<String>,
    headers: Option<BTreeMap<String, String>>,
}

/// Resolve `decisionModel`: the reference must match an available,
/// authenticated `systemone` model inside `allowedModels`.
fn resolve_decision_model(cwd: &Path, agent_dir: &Path) -> anyhow::Result<ResolvedDecisionModel> {
    let settings = crate::settings::SettingsManager::create(cwd, agent_dir);
    let Some(reference) = settings
        .settings()
        .decision_model
        .as_deref()
        .map(str::trim)
        .filter(|reference| !reference.is_empty())
        .map(str::to_string)
    else {
        bail!(
            "decisionModel is not set in settings.json. Set it to a structured-decision model \
             reference (\"provider/model-id\"), e.g. \"prime-inference/cloudflare/clef\"."
        );
    };
    let unusable = || {
        anyhow!(
            "decisionModel \"{reference}\" could not be resolved to an available, authenticated \
             model. Fix the decisionModel setting (settings.json) or authenticate the provider, \
             then retry the decision."
        )
    };
    let mut registry = ModelRegistry::create(
        crate::auth::AuthStorage::create(agent_dir),
        agent_dir.join("models.json"),
    );
    // A fresh registry gates cached-authorized private models out until it
    // adopts the on-disk authorization (the same step as the other resolvers).
    registry.load_private_authorization_from_cache();
    let available: Vec<Model> = registry.get_available().into_iter().cloned().collect();
    let model = find_exact_model_reference_match(&reference, &available)
        .cloned()
        .ok_or_else(unusable)?;
    let selector = format!("{}/{}", model.provider, model.id);
    if model.api != SYSTEMONE_API {
        bail!(
            "decisionModel \"{selector}\" uses api \"{}\", but rlm.decide serves only \
             structured-decision models (api \"{SYSTEMONE_API}\"), e.g. \
             \"prime-inference/cloudflare/clef\" declared in models.json with \"api\": \
             \"{SYSTEMONE_API}\". Fix the decisionModel setting, then retry.",
            model.api
        );
    }
    if let Some(allowlist) = settings.get_allowed_models() {
        if !model_allowed(&selector, &allowlist) {
            return Err(ModelAllowlistRefusal { selector }.into());
        }
    }
    let auth = registry.get_api_key_and_headers(&model, None);
    if !auth.ok {
        return Err(unusable());
    }
    Ok(ResolvedDecisionModel {
        model,
        selector,
        api_key: auth.api_key,
        headers: auth.headers,
    })
}

/// Validate one `rlm.decide` request and build its `/systemone` body: one
/// `action` choice question over the requested actions.
fn systemone_body(data: &Value, model: &Model) -> anyhow::Result<Value> {
    let Some(actions) = data
        .get("actions")
        .and_then(Value::as_object)
        .filter(|actions| !actions.is_empty())
    else {
        bail!("rlm.decide needs a non-empty actions dict of action name -> when it applies");
    };
    if let Some((name, _)) = actions.iter().find(|(_, when)| !when.is_string()) {
        bail!("rlm.decide action {name:?} must map to a string describing when it applies");
    }
    let instructions = match data.get("instructions") {
        None | Some(Value::Null) => DEFAULT_INSTRUCTIONS,
        Some(Value::String(text)) => text.as_str(),
        Some(other) => bail!("rlm.decide instructions must be a string, not {other}"),
    };
    let mut body = json!({
        "model": model.id,
        "state": data.get("state").cloned().unwrap_or(Value::Null),
        "questions": { "action": {
            "type": "choice",
            "instructions": instructions,
            "criteria": actions,
        } },
    });
    match data.get("images") {
        None | Some(Value::Null) => {}
        Some(Value::Array(images))
            if images.len() <= MAX_IMAGES
                && images.iter().all(|image| {
                    image
                        .as_str()
                        .is_some_and(|url| url.starts_with("data:image/"))
                }) =>
        {
            if !model.input.contains(&ModelInput::Image) {
                bail!(
                    "{}/{} does not accept image input. Drop the images, or set decisionModel \
                     to a vision-capable model.",
                    model.provider,
                    model.id
                );
            }
            body["images"] = Value::Array(images.clone());
        }
        Some(_) => bail!(
            "rlm.decide images must be a list of at most {MAX_IMAGES} data URL strings like \
             \"data:image/png;base64,...\""
        ),
    }
    Ok(body)
}

/// The `/systemone` reply envelope.
#[derive(Deserialize)]
struct SystemOneReply {
    answers: SystemOneAnswers,
    usage: SystemOneUsage,
}

#[derive(Deserialize)]
struct SystemOneAnswers {
    action: SystemOneChoice,
}

#[derive(Deserialize)]
struct SystemOneChoice {
    choice: String,
    confidence: Option<f64>,
    #[serde(default)]
    probabilities: BTreeMap<String, f64>,
}

/// The endpoint's usage shape (not `pa_types` usage: no cost, other names).
/// Required: a reply without it would bill nothing.
#[derive(Deserialize)]
struct SystemOneUsage {
    input_tokens: u64,
    output_tokens: u64,
}

/// What the kernel's `RLMDecision` is built from.
#[derive(Serialize)]
struct Decision {
    choice: String,
    confidence: Option<f64>,
    probabilities: BTreeMap<String, f64>,
    model: String,
}

fn request_error(error: &reqwest::Error) -> anyhow::Error {
    if error.is_timeout() {
        anyhow!(
            "the decision model request timed out after {} s",
            DECISION_TIMEOUT.as_secs()
        )
    } else {
        anyhow!("the decision model request failed: {error}")
    }
}

/// POST one decision body on pa-ai's shared client (one pool and TLS
/// session across decisions), bounded by [`DECISION_TIMEOUT`]. Dropping
/// the future drops the request and its connection.
async fn post_systemone(
    resolved: &ResolvedDecisionModel,
    body: &Value,
) -> anyhow::Result<SystemOneReply> {
    let url = format!(
        "{}/systemone",
        resolved.model.base_url.trim_end_matches('/')
    );
    let mut request = pa_ai::utils::shared_http_client()
        .post(url)
        .timeout(DECISION_TIMEOUT)
        .json(body);
    if let Some(api_key) = &resolved.api_key {
        request = request.bearer_auth(api_key);
    }
    for (name, value) in resolved.headers.iter().flatten() {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| request_error(&error))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| request_error(&error))?;
    let excerpt = || text.chars().take(ERROR_BODY_CHARS).collect::<String>();
    if !status.is_success() {
        bail!(
            "the decision model call failed: systemone returned HTTP {status}: {}",
            excerpt()
        );
    }
    serde_json::from_str(&text).map_err(|error| {
        anyhow!(
            "the decision model's reply is not a decision envelope ({error}): {}",
            excerpt()
        )
    })
}

/// Register `rlm.decide`: one awaited decision per kernel call. The model
/// resolves on the first successful call and is reused for the session; a
/// refusal is not cached, so a fixed setting works on the next call. Each
/// call counts as `feature_decide_{completed,failed}_count`.
pub(crate) fn register_decision_handler(
    handlers: &mut HostRequestHandlers,
    session: Arc<tokio::sync::Mutex<SessionManager>>,
    cwd: PathBuf,
    agent_dir: PathBuf,
    counters: Arc<super::telemetry::SessionCounters>,
) {
    let resolved = Arc::new(tokio::sync::OnceCell::<ResolvedDecisionModel>::new());
    handlers.register(
        "rlm.decide",
        host_handler(move |payload| {
            let (session, resolved) = (Arc::clone(&session), Arc::clone(&resolved));
            let (cwd, agent_dir) = (cwd.clone(), agent_dir.clone());
            let counters = Arc::clone(&counters);
            async move {
                let decision: anyhow::Result<Value> = async {
                    let resolved = resolved
                        .get_or_try_init(|| async { resolve_decision_model(&cwd, &agent_dir) })
                        .await?;
                    let body = systemone_body(&payload.data, &resolved.model)?;
                    let reply = post_systemone(resolved, &body).await?;
                    let mut usage = Usage {
                        input: reply.usage.input_tokens,
                        output: reply.usage.output_tokens,
                        total_tokens: reply.usage.input_tokens + reply.usage.output_tokens,
                        ..Usage::default()
                    };
                    pa_ai::models::calculate_cost(&resolved.model, &mut usage, None);
                    session.lock().await.append_custom_entry(
                        DECISION_CUSTOM_TYPE,
                        Some(json!({ "model": resolved.selector, "usage": usage })),
                    )?;
                    let actions = &body["questions"]["action"]["criteria"];
                    let SystemOneChoice {
                        choice,
                        confidence,
                        mut probabilities,
                    } = reply.answers.action;
                    if actions.get(&choice).is_none() {
                        bail!(
                            "the decision model chose {choice:?}, which is not one of the \
                             requested actions {actions}"
                        );
                    }
                    probabilities.retain(|name, _| actions.get(name).is_some());
                    Ok(serde_json::to_value(Decision {
                        choice,
                        confidence,
                        probabilities,
                        model: resolved.selector.clone(),
                    })?)
                }
                .await;
                let outcome = if decision.is_ok() {
                    "completed"
                } else {
                    "failed"
                };
                counters.note_feature_outcome("decide", outcome);
                decision
            }
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::shared::{HostHandlerFn, HostRequestPayload};
    use pa_types::ai::UsageCost;
    use pa_types::session::FileEntry;
    use pa_types::JsNumber;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    type Session = Arc<tokio::sync::Mutex<SessionManager>>;

    /// The agent dir: clef declared as a `systemone` model at `base_url`
    /// (priced like the live catalog), a chat model beside it, a
    /// team-scoped Prime Inference key, and `settings`.
    fn write_agent_dir(dir: &Path, base_url: &str, settings: &Value) {
        std::fs::write(dir.join("settings.json"), settings.to_string()).unwrap();
        let models = json!({ "providers": { "prime-inference": { "models": [
            { "id": "cloudflare/clef", "api": "systemone", "baseUrl": base_url,
              "cost": { "input": 0.042, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
            { "id": "fixture-chat", "api": "openai-completions", "baseUrl": base_url },
        ] } } });
        std::fs::write(dir.join("models.json"), models.to_string()).unwrap();
        let auth = json!({ "prime-inference": { "type": "api_key", "key": "sk-decide",
            "primeTeam": { "teamId": "team-decide", "name": "Decide Team" } } });
        std::fs::write(dir.join("auth.json"), auth.to_string()).unwrap();
    }

    /// The `rlm.decide` handler exactly as the kernel's host-request
    /// dispatch looks it up, over an in-memory session.
    fn decide_handler(dir: &Path) -> (Session, HostHandlerFn) {
        let session = Arc::new(tokio::sync::Mutex::new(SessionManager::in_memory(dir)));
        let mut handlers = HostRequestHandlers::default();
        register_decision_handler(
            &mut handlers,
            Arc::clone(&session),
            dir.to_path_buf(),
            dir.to_path_buf(),
            Arc::default(),
        );
        let handler = handlers.get("rlm.decide").unwrap().clone();
        (session, handler)
    }

    /// The payload `rlm.decide(state, actions)` sends.
    fn request() -> HostRequestPayload {
        HostRequestPayload {
            data: json!({
                "type": "rlm.decide",
                "state": { "goal": "catch the ball", "ball_x": 3 },
                "actions": { "left": "ball to the left", "right": "ball to the right",
                             "wait": "ball above" },
                "instructions": null,
                "images": null,
            }),
        }
    }

    async fn decision_entries(session: &Session) -> Vec<Value> {
        session
            .lock()
            .await
            .get_entries()
            .into_iter()
            .filter_map(|entry| match entry {
                FileEntry::Custom { payload, .. }
                    if payload.custom_type == DECISION_CUSTOM_TYPE =>
                {
                    payload.data
                }
                _ => None,
            })
            .collect()
    }

    /// A loopback `/systemone` answering every request with `reply`; returns
    /// the base URL and each request's lowercased head and parsed body.
    async fn systemone_stub(reply: Value) -> (String, Arc<std::sync::Mutex<Vec<(String, Value)>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut raw = Vec::new();
                let (head, body) = loop {
                    let mut chunk = [0u8; 4096];
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert_ne!(read, 0, "the client closed mid-request");
                    raw.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&raw).into_owned();
                    let Some((head, body)) = text.split_once("\r\n\r\n") else {
                        continue;
                    };
                    let head = head.to_ascii_lowercase();
                    let length: usize = head
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:")?.trim().parse().ok())
                        .unwrap_or(0);
                    if body.len() >= length {
                        break (head, body.to_string());
                    }
                };
                sink.lock()
                    .unwrap()
                    .push((head, serde_json::from_str(&body).unwrap()));
                let reply = reply.to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\
                     content-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (base, seen)
    }

    /// One decision through the handler against the real `/systemone` reply
    /// shape: the choice comes back, the request carries the team header,
    /// and exactly one `decision` entry bills the endpoint's 177 input
    /// tokens at the model's input price.
    #[tokio::test]
    async fn rlm_decide_serves_and_bills_one_systemone_decision() {
        let (base, seen) = systemone_stub(json!({
            "model": "cloudflare/clef",
            "answers": { "action": { "type": "choice", "choice": "right", "confidence": 0.9127,
                "probabilities": { "left": 0.0289, "right": 0.9418, "wait": 0.0293 } } },
            "usage": { "input_tokens": 177, "output_tokens": 0 },
        }))
        .await;
        let dir = tempfile::tempdir().unwrap();
        write_agent_dir(
            dir.path(),
            &base,
            &json!({ "decisionModel": "prime-inference/cloudflare/clef" }),
        );
        let (session, handler) = decide_handler(dir.path());

        let decision = handler(request()).await.unwrap();

        assert_eq!(
            decision,
            json!({
                "choice": "right",
                "confidence": 0.9127,
                "probabilities": { "left": 0.0289, "right": 0.9418, "wait": 0.0293 },
                "model": "prime-inference/cloudflare/clef",
            })
        );
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        let (head, body) = &requests[0];
        assert!(head.starts_with("post /systemone "), "{head}");
        assert!(
            head.contains("\r\nx-prime-team-id: team-decide\r\n"),
            "{head}"
        );
        assert!(
            head.contains("\r\nauthorization: bearer sk-decide\r\n"),
            "{head}"
        );
        assert_eq!(
            body,
            &json!({
                "model": "cloudflare/clef",
                "state": { "goal": "catch the ball", "ball_x": 3 },
                "questions": { "action": {
                    "type": "choice",
                    "instructions": DEFAULT_INSTRUCTIONS,
                    "criteria": { "left": "ball to the left", "right": "ball to the right",
                                  "wait": "ball above" },
                } },
            })
        );
        let entries = decision_entries(&session).await;
        assert_eq!(entries.len(), 1, "{entries:?}");
        assert_eq!(entries[0]["model"], "prime-inference/cloudflare/clef");
        // clef bills $0.042 per Mtok of input and nothing for output.
        let input_cost = JsNumber::from((0.042 / 1_000_000.0) * 177.0);
        assert_eq!(
            serde_json::from_value::<Usage>(entries[0]["usage"].clone()).unwrap(),
            Usage {
                input: 177,
                total_tokens: 177,
                cost: UsageCost {
                    input: input_cost,
                    total: input_cost,
                    ..UsageCost::default()
                },
                ..Usage::default()
            }
        );
    }

    /// An endpoint that never answers: the whole-request bound fails the
    /// awaiting call with the timeout error, and nothing is billed.
    #[tokio::test(start_paused = true)]
    async fn a_stalled_decision_times_out_without_billing() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        let dir = tempfile::tempdir().unwrap();
        write_agent_dir(
            dir.path(),
            &base,
            &json!({ "decisionModel": "prime-inference/cloudflare/clef" }),
        );
        let (session, handler) = decide_handler(dir.path());

        let error = handler(request()).await.unwrap_err();

        assert_eq!(
            format!("{error:#}"),
            "the decision model request timed out after 30 s"
        );
        assert_eq!(decision_entries(&session).await, Vec::<Value>::new());
    }

    /// Unset, non-`systemone`, and outside-`allowedModels` settings each
    /// refuse before any request; one handler throughout, so a refusal is
    /// never cached and each fixed setting is read on the next call.
    #[tokio::test]
    async fn rlm_decide_refuses_unusable_settings_without_caching_the_refusal() {
        let dir = tempfile::tempdir().unwrap();
        let (_session, handler) = decide_handler(dir.path());
        for (settings, refusal) in [
            (json!({}), "decisionModel is not set in settings.json"),
            (
                json!({ "decisionModel": "prime-inference/fixture-chat" }),
                "decisionModel \"prime-inference/fixture-chat\" uses api \"openai-completions\", \
                 but rlm.decide serves only structured-decision models",
            ),
            (
                json!({ "decisionModel": "prime-inference/cloudflare/clef",
                        "allowedModels": ["anthropic/*"] }),
                "Model \"prime-inference/cloudflare/clef\" is blocked by the daemon model allowlist",
            ),
        ] {
            write_agent_dir(dir.path(), "http://127.0.0.1:9", &settings);
            let error = format!("{:#}", handler(request()).await.unwrap_err());
            assert!(error.starts_with(refusal), "{error}");
        }
    }
}
