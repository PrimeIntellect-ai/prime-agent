//! The experimental Decision API host: the `decision_api.decide` handler the
//! bundled decision-api skill calls, and the settings gate that controls the
//! skill's availability. The decision model is the `decisionApi.systemOneModel`
//! settings reference — resolved through the model registry exactly like
//! `imageModel` — and requests ride the ordinary provider transports, so the
//! Decision API has no transport, envelope, or credential store of its own.
//! The setting is the feature gate: unset (or unresolvable) and the skill
//! stays out of the prompt and every `decide()` refuses with an actionable
//! message naming the setting.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail};
use pa_types::ai::{ModelInput, StopReason};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::kernel::shared::{host_handler, HostRequestHandlers};
use crate::models::{find_exact_model_reference_match, ModelRegistry};

/// The bundled skill the setting gates.
pub const DECISION_API_SKILL_NAME: &str = "decision-api";
/// The default decision instructions (the skill's `DEFAULT_INSTRUCTIONS`).
const DEFAULT_INSTRUCTIONS: &str =
    "Choose the next action that best advances the goal given the observation.";
/// One decision's output budget: the answer is a single small JSON object.
const DECISION_MAX_TOKENS: u64 = 512;
/// One decision call's wall-clock bound.
const DECISION_TIMEOUT_MS: u64 = 30_000;
/// The request's image cap (the skill mirrors it client-side).
const MAX_IMAGES: usize = 4;

/// One parsed decision request: what System 1 is asked.
#[derive(Debug, Clone)]
struct DecisionRequest {
    state: Value,
    instructions: String,
    /// (action name, when it applies), in request order.
    criteria: Vec<(String, String)>,
    /// (mime type, base64 data) data-URL images, at most [`MAX_IMAGES`].
    images: Vec<(String, String)>,
}

/// Validate the kernel's request body into a [`DecisionRequest`].
fn parse_decision_request(
    mut request: serde_json::Map<String, Value>,
) -> anyhow::Result<DecisionRequest> {
    if let Some(model) = request.remove("model") {
        if !model.is_null() {
            bail!(
                "The decision model comes from the decisionApi.systemOneModel setting; the \
                 request carries no model (got {model})."
            );
        }
    }
    let unknown: Vec<String> = request
        .keys()
        .filter(|key| !matches!(key.as_str(), "state" | "questions" | "images"))
        .cloned()
        .collect();
    if !unknown.is_empty() {
        bail!(
            "decision_api.decide got unsupported request fields: {}. Only \"state\", \
             \"questions\", and \"images\" are allowed.",
            unknown
                .iter()
                .map(|key| format!("{key:?}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    let state = request
        .get("state")
        .cloned()
        .ok_or_else(|| anyhow!("decision_api.decide needs a \"state\" value"))?;
    let Some(question) = request
        .get("questions")
        .and_then(Value::as_object)
        .and_then(|questions| questions.get("action"))
        .cloned()
    else {
        bail!("decision_api.decide needs a \"questions\" object with an \"action\" question");
    };
    if let Some(kind) = question.get("type") {
        if kind != "choice" {
            bail!(
                "the \"action\" question must have type \"choice\", not {kind}. The Decision API \
                 serves one action choice per request."
            );
        }
    }
    let instructions = match question.get("instructions") {
        None | Some(Value::Null) => DEFAULT_INSTRUCTIONS.to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => {
            bail!("the \"action\" question's instructions must be a string, not {other}.")
        }
    };
    let Some(criteria_value) = question.get("criteria").and_then(Value::as_object) else {
        bail!(
            "the \"action\" question needs a \"criteria\" object of action names to descriptions"
        );
    };
    if criteria_value.is_empty() {
        bail!("the \"action\" question's \"criteria\" object is empty; a decision needs actions to choose from");
    }
    let mut criteria = Vec::with_capacity(criteria_value.len());
    for (name, applies) in criteria_value {
        let Some(when) = applies.as_str() else {
            bail!("the \"criteria\" entry {name:?} must be a string describing when the action applies, not {applies}");
        };
        if name.is_empty() {
            bail!("the \"criteria\" object has an empty action name");
        }
        criteria.push((name.clone(), when.to_string()));
    }
    let mut images = Vec::new();
    match request.get("images") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => {
            if list.len() > MAX_IMAGES {
                bail!(
                    "a decision carries at most {MAX_IMAGES} images, got {}",
                    list.len()
                );
            }
            for image in list {
                let Some(url) = image.as_str() else {
                    bail!("decision images must be data URL strings like \"data:image/png;base64,...\", got {image}");
                };
                images.push(parse_image_data_url(url)?);
            }
        }
        Some(other) => {
            bail!("decision \"images\" must be an array of data URL strings, not {other}.")
        }
    }
    Ok(DecisionRequest {
        state,
        instructions,
        criteria,
        images,
    })
}

/// Split one `data:<mime>;base64,<data>` URL into its parts.
fn parse_image_data_url(url: &str) -> anyhow::Result<(String, String)> {
    let invalid =
        || anyhow!("decision images must be data URL strings like \"data:image/png;base64,...\"");
    let (header, data) = url.split_once(',').ok_or_else(invalid)?;
    if !header.starts_with("data:image/") || !header.ends_with(";base64") {
        return Err(invalid());
    }
    let mime = header
        .strip_prefix("data:")
        .and_then(|rest| rest.strip_suffix(";base64"))
        .ok_or_else(invalid)?;
    if mime.is_empty() || data.is_empty() {
        return Err(invalid());
    }
    Ok((mime.to_string(), data.to_string()))
}

/// The actionable refusal when `decisionApi.systemOneModel` is unset.
fn unconfigured_message() -> String {
    "decisionApi.systemOneModel is not set in settings.json. Set it to the decision model \
     reference (\"provider/model-id\" or a bare id), e.g. \"prime-inference/clef\"."
        .to_string()
}

/// Whether the Decision API is configured: `decisionApi.systemOneModel` is
/// set to a non-empty reference. This gates the skill's prompt inclusion and
/// kernel pre-import; `decide()` resolves the reference at call time.
#[must_use]
pub fn decision_api_configured(settings: &crate::settings::types::Settings) -> bool {
    settings
        .decision_api
        .as_ref()
        .and_then(|decision| decision.system_one_model.as_deref())
        .is_some_and(|reference| !reference.trim().is_empty())
}

/// The pre-import filter that withholds the decision-api skill while it is
/// unconfigured; a configured gate pre-imports every skill.
#[must_use]
pub fn decision_api_preimport_filter(
    configured: bool,
) -> crate::kernel::provisioner::PythonSkillPreimportFilter {
    if configured {
        return Arc::new(|_| true);
    }
    Arc::new(|skill: &crate::kernel::bootstrap::KernelPythonSkill| {
        skill.name != DECISION_API_SKILL_NAME
    })
}

/// The actionable refusal when the configured reference does not resolve to
/// an available, authenticated model (the `imageModel` refusal shape).
fn unusable_message(reference: &str) -> String {
    format!(
        "decisionApi.systemOneModel \"{reference}\" could not be resolved to an available, \
         authenticated model.\n\nFix the decisionApi.systemOneModel setting (settings.json) or \
         authenticate the provider, then retry the decision."
    )
}

/// The resolved decision model with its request auth: the settings reference
/// resolved through the registry exactly like `imageModel` routing.
struct ResolvedDecisionModel {
    model: pa_types::ai::Model,
    api_key: Option<String>,
    headers: Option<BTreeMap<String, String>>,
}

impl ResolvedDecisionModel {
    /// The model's full selector, for prompts and status rows.
    fn label(&self) -> String {
        format!("{}/{}", self.model.provider, self.model.id)
    }
}

/// Resolve `decisionApi.systemOneModel` through the model registry:
/// the reference must match an available (authenticated) model, and its
/// request auth comes from the registry's merged resolution.
fn resolve_decision_model(cwd: &Path, agent_dir: &Path) -> Result<ResolvedDecisionModel, String> {
    let settings = crate::settings::SettingsManager::create(cwd, agent_dir);
    let reference = settings
        .settings()
        .decision_api
        .as_ref()
        .and_then(|decision| decision.system_one_model.clone())
        .and_then(|reference| {
            let trimmed = reference.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        })
        .ok_or_else(unconfigured_message)?;
    let auth = crate::auth::AuthStorage::create(agent_dir);
    let mut registry = ModelRegistry::create(auth, agent_dir.join("models.json"));
    let available = registry.get_available();
    let available: Vec<pa_types::ai::Model> = available.into_iter().cloned().collect();
    let model = find_exact_model_reference_match(&reference, &available)
        .ok_or_else(|| unusable_message(&reference))?;
    let model = model.clone();
    let resolved = registry.get_api_key_and_headers(&model, None);
    if !resolved.ok {
        return Err(unusable_message(&reference));
    }
    Ok(ResolvedDecisionModel {
        model,
        api_key: resolved.api_key,
        headers: resolved.headers,
    })
}

/// The system prompt every decision request runs with: the answer protocol
/// (the skill material's decision contract).
const DECISION_SYSTEM_PROMPT: &str = "You are System 1, the decision model of a real-time control \
loop. Each request gives one situation (the state) and the actions available. Pick exactly one \
action and reply with a single JSON object, nothing else:\n\n{\"action\": {\"choice\": \
\"<one action name>\", \"confidence\": <number 0 to 1>, \"probabilities\": {\"<action name>\": \
<number>, ...}}}\n\n\"choice\" must be one of the request's action names. \"confidence\" is how \
confident you are that the choice is best. \"probabilities\" assigns a share to the action names. \
Reply with JSON only: no prose, no markdown, no code fences.";

/// The user half of one decision request.
fn decision_user_text(request: &DecisionRequest) -> String {
    use std::fmt::Write as _;
    let mut text = String::with_capacity(256);
    let _ = write!(text, "Instructions: {}", request.instructions);
    let _ = write!(text, "\n\nActions:");
    for (name, applies) in &request.criteria {
        let _ = write!(text, "\n- {name}: {applies}");
    }
    let state =
        serde_json::to_string_pretty(&request.state).unwrap_or_else(|_| request.state.to_string());
    let _ = write!(
        text,
        "\n\nState:\n{state}\n\nReply with one JSON object: {{\"action\": {{\"choice\": one \
         action name, \"confidence\": 0 to 1, \"probabilities\": {{action name: probability}}}}}}"
    );
    text
}

/// Build the completion context for one decision request: one user message
/// (text plus image blocks for vision-capable models).
fn build_decision_context(request: &DecisionRequest) -> pa_types::ai::Context {
    use pa_types::ai::{TextContent, UserMessage};
    let content = if request.images.is_empty() {
        pa_types::ai::UserContent::Text(decision_user_text(request))
    } else {
        let mut blocks = vec![pa_types::ai::UserContentBlock::Text(TextContent {
            text: decision_user_text(request),
            text_signature: None,
            rest: serde_json::Map::default(),
        })];
        for (mime, data) in &request.images {
            blocks.push(pa_types::ai::UserContentBlock::Image(
                pa_types::ai::ImageContent {
                    data: data.clone(),
                    mime_type: mime.clone(),
                    rest: serde_json::Map::default(),
                },
            ));
        }
        pa_types::ai::UserContent::Blocks(blocks)
    };
    pa_types::ai::Context {
        system_prompt: Some(DECISION_SYSTEM_PROMPT.to_string()),
        messages: vec![pa_types::ai::Message::User(UserMessage {
            content,
            timestamp: 0,
            rest: serde_json::Map::default(),
        })],
        tools: None,
    }
}

/// Parse the model's reply into the `answers.action` object: the choice must
/// name one of the requested actions; confidence clamps to `0..=1`.
fn parse_decision_answer(reply: &str, criteria: &[(String, String)]) -> anyhow::Result<Value> {
    let actions: Vec<&str> = criteria.iter().map(|(name, _)| name.as_str()).collect();
    let raw = reply.trim();
    // The protocol asks for JSON only; tolerate a fenced or chatty reply by
    // slicing to the outermost object before repair-parsing.
    let candidate = match (raw.find('{'), raw.rfind('}')) {
        (Some(start), Some(end)) if end > start => &raw[start..=end],
        _ => raw,
    };
    let parsed = pa_ai::parse_json_with_repair(candidate).map_err(|error| {
        anyhow!("the decision model's reply was not valid JSON ({error}): {raw}")
    })?;
    let Some(answer) = parsed.get("action").and_then(Value::as_object) else {
        bail!("the decision model's reply has no \"action\" object: {raw}");
    };
    let Some(choice) = answer.get("choice").and_then(Value::as_str) else {
        bail!("the decision model's reply has no \"action\".\"choice\" string: {raw}");
    };
    if !actions.contains(&choice) {
        bail!(
            "the decision model chose {choice:?}, which is not one of the requested actions: {}",
            actions.join(", ")
        );
    }
    let confidence = answer
        .get("confidence")
        .and_then(Value::as_f64)
        .and_then(finite_or_none)
        .map(|confidence| confidence.clamp(0.0, 1.0));
    let probabilities = match answer.get("probabilities").and_then(Value::as_object) {
        Some(entries) => {
            let mut parsed = serde_json::Map::new();
            for (name, share) in entries {
                if let Some(value) = share.as_f64().and_then(finite_or_none) {
                    parsed.insert(name.clone(), json!(value));
                }
            }
            Value::Object(parsed)
        }
        None => Value::Null,
    };
    Ok(json!({
        "choice": choice,
        "confidence": confidence,
        "probabilities": probabilities,
    }))
}

/// `None` for non-finite numbers, so no `NaN`/`Infinity` crosses the bridge.
fn finite_or_none(value: f64) -> Option<f64> {
    value.is_finite().then_some(value)
}

/// The api identifier of the System One structured-decision protocol: the
/// decision request body POSTs to the model's baseUrl + /systemone and the
/// reply envelope carries the answers (Prime Inference's hosted clef).
const SYSTEMONE_API: &str = "systemone";

/// Serve one decision request with the resolved model through the existing
/// provider transports: one non-streaming completion, parsed into the
/// decision envelope. System One models speak the native structured-decision
/// protocol; every other model answers the decision prompt.
async fn serve_decision(
    resolved: &ResolvedDecisionModel,
    request: &DecisionRequest,
) -> anyhow::Result<Value> {
    if resolved.model.api == SYSTEMONE_API {
        return serve_systemone(resolved, request).await;
    }
    let context = build_decision_context(request);
    let options = pa_ai::types::SimpleStreamOptions::from_base(pa_ai::types::StreamOptions {
        max_tokens: Some(DECISION_MAX_TOKENS),
        timeout_ms: Some(DECISION_TIMEOUT_MS),
        api_key: resolved.api_key.clone(),
        headers: resolved
            .headers
            .as_ref()
            .map(|headers| headers.clone().into_iter().collect()),
        ..Default::default()
    });
    let response = pa_ai::complete_simple(&resolved.model, &context, Some(options))
        .await
        .map_err(|error| anyhow!("the decision model request failed: {error:?}"))?;
    match response.stop_reason {
        StopReason::Error => bail!(
            "the decision model call failed: {}",
            response
                .error_message
                .unwrap_or_else(|| "unknown provider error".to_string())
        ),
        StopReason::Aborted => bail!("the decision model call was aborted"),
        _ => {}
    }
    let reply = response
        .content
        .iter()
        .filter_map(|block| match block {
            pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if reply.trim().is_empty() {
        bail!("the decision model returned an empty reply");
    }
    let answer = parse_decision_answer(&reply, &request.criteria)?;
    Ok(json!({
        "model": resolved.label(),
        "answers": { "action": answer },
    }))
}

/// The settings decision model's resolved selector (`"provider/id"`):
/// the spawn seam uses this for the decision child's model, refusing with
/// the same actionable messages as `decide()` when the setting is unset or
/// unresolvable.
///
/// # Errors
///
/// Returns the unset/unresolvable-setting refusal.
pub fn decision_model_selector(cwd: &Path, agent_dir: &Path) -> Result<String, String> {
    resolve_decision_model(cwd, agent_dir).map(|resolved| resolved.label())
}

/// Serve one decision request: validate the kernel's request body, resolve
/// the settings model through the registry, and run one provider
/// completion. The session host handler and the daemon's decision child
/// share this path.
///
/// # Errors
///
/// Returns the request, setting, resolution, or provider failure as an
/// actionable message.
pub async fn serve_decision_request(
    request: Value,
    cwd: &Path,
    agent_dir: &Path,
) -> anyhow::Result<Value> {
    let Value::Object(request) = request else {
        bail!("decision_api.decide needs a request object");
    };
    let request = parse_decision_request(request)?;
    let resolved = resolve_decision_model(cwd, agent_dir).map_err(anyhow::Error::msg)?;
    if !request.images.is_empty() && !resolved.model.input.contains(&ModelInput::Image) {
        bail!(
            "{} does not accept image input, so decisions cannot carry images. Drop \
             the images, or set decisionApi.systemOneModel to a vision-capable model.",
            resolved.label()
        );
    }
    serve_decision(&resolved, &request).await
}

/// Serve one decision over the System One structured-decision protocol:
/// the request body rides to the endpoint verbatim and the reply envelope
/// passes through the same answer validation.
async fn serve_systemone(
    resolved: &ResolvedDecisionModel,
    request: &DecisionRequest,
) -> anyhow::Result<Value> {
    let mut criteria = serde_json::Map::new();
    for (name, applies) in &request.criteria {
        criteria.insert(name.clone(), json!(applies));
    }
    let mut body = json!({
        "state": request.state,
        "questions": { "action": {
            "type": "choice",
            "instructions": request.instructions,
            "criteria": Value::Object(criteria),
        } },
        "model": resolved.model.id,
    });
    if !request.images.is_empty() {
        let images = request
            .images
            .iter()
            .map(|(mime, data)| json!(format!("data:{mime};base64,{data}")))
            .collect::<Vec<_>>();
        body["images"] = Value::Array(images);
    }
    let context = pa_types::ai::Context {
        system_prompt: None,
        messages: vec![pa_types::ai::Message::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text(body.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        })],
        tools: None,
    };
    let options = pa_ai::types::SimpleStreamOptions::from_base(pa_ai::types::StreamOptions {
        max_tokens: Some(DECISION_MAX_TOKENS),
        timeout_ms: Some(DECISION_TIMEOUT_MS),
        api_key: resolved.api_key.clone(),
        headers: resolved
            .headers
            .as_ref()
            .map(|headers| headers.clone().into_iter().collect()),
        ..Default::default()
    });
    let response = pa_ai::complete_simple(&resolved.model, &context, Some(options))
        .await
        .map_err(|error| anyhow!("the decision model request failed: {error:?}"))?;
    match response.stop_reason {
        StopReason::Error => bail!(
            "the decision model call failed: {}",
            response
                .error_message
                .unwrap_or_else(|| "unknown provider error".to_string())
        ),
        StopReason::Aborted => bail!("the decision model call was aborted"),
        _ => {}
    }
    let reply = response
        .content
        .iter()
        .filter_map(|block| match block {
            pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if reply.trim().is_empty() {
        bail!("the decision model returned an empty reply");
    }
    // The endpoint's envelope: {"model": ..., "answers": {"action": {...}}}.
    let raw = reply.trim();
    let candidate = match (raw.find('{'), raw.rfind('}')) {
        (Some(start), Some(end)) if end > start => &raw[start..=end],
        _ => raw,
    };
    let parsed = pa_ai::parse_json_with_repair(candidate).map_err(|error| {
        anyhow!("the decision model's reply was not valid JSON ({error}): {raw}")
    })?;
    let answers = parsed
        .get("answers")
        .cloned()
        .ok_or_else(|| anyhow!("the decision model's reply has no \"answers\" object: {raw}"))?;
    let answer = parse_decision_answer(&answers.to_string(), &request.criteria)?;
    // The envelope reports the resolved model's label (the chat path's
    // convention), never the endpoint's bare id.
    Ok(json!({
        "model": resolved.label(),
        "answers": { "action": answer },
    }))
}

/// Register `decision_api.decide`, resolving the decision model from the
/// settings under `agent_dir` on every call.
pub(crate) fn register_decision_api_handler(
    handlers: &mut HostRequestHandlers,
    cwd: PathBuf,
    agent_dir: PathBuf,
) {
    handlers.register(
        "decision_api.decide",
        host_handler(move |payload| {
            let cwd = cwd.clone();
            let agent_dir = agent_dir.clone();
            Box::pin(async move {
                let Some(request) = payload.data.get("request").cloned() else {
                    bail!("decision_api.decide needs a request object");
                };
                serve_decision_request(request, &cwd, &agent_dir).await
            })
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::shared::{HostHandlerFuture, HostRequestPayload};
    use std::path::Path;

    /// The registered `decision_api.decide`, called with a payload's data.
    fn decider(cwd: &Path, agent_dir: &Path) -> impl Fn(Value) -> HostHandlerFuture {
        let mut handlers = HostRequestHandlers::default();
        register_decision_api_handler(&mut handlers, cwd.to_path_buf(), agent_dir.to_path_buf());
        let decide = handlers
            .get("decision_api.decide")
            .expect("registered")
            .clone();
        move |data| {
            decide(HostRequestPayload {
                data,
                cell_source_code: None,
            })
        }
    }

    /// A fixture agent dir: settings.json naming the decision model and a
    /// custom registry provider carrying it (the api rides the faux provider).
    fn fixture_agent_dir(
        dir: &Path,
        decision_api: Option<&str>,
        model_input: &str,
    ) -> anyhow::Result<()> {
        let settings = match decision_api {
            Some(model) => json!({ "decisionApi": { "systemOneModel": model } }),
            None => json!({}),
        };
        std::fs::write(dir.join("settings.json"), settings.to_string())?;
        std::fs::write(
            dir.join("models.json"),
            format!(
                r#"{{ "providers": {{ "fixture-decisions": {{
                    "baseUrl": "https://fixture.example", "apiKey": "fixture-key",
                    "api": "faux-decision", "models": [
                        {{ "id": "decision-model", "input": {model_input} }}
                    ]
                }} }} }}"#
            ),
        )?;
        Ok(())
    }

    #[tokio::test]
    async fn decide_refuses_while_the_setting_is_missing_or_unusable() {
        let dir = tempfile::tempdir().unwrap();
        fixture_agent_dir(
            dir.path(),
            Some("fixture-decisions/decision-model"),
            r#"["text"]"#,
        )
        .unwrap();
        let call = decider(dir.path(), dir.path());
        let request = json!({ "request": { "state": {}, "questions": { "action": {
            "type": "choice",
            "criteria": { "left": "go left" }
        } } } });
        let error = |data| async { call(data).await.unwrap_err().to_string() };
        // An unset reference and an unresolvable one name the setting.
        fixture_agent_dir(dir.path(), None, r#"["text"]"#).unwrap();
        assert_eq!(
            error(request.clone()).await,
            "decisionApi.systemOneModel is not set in settings.json. Set it to the decision model \
             reference (\"provider/model-id\" or a bare id), e.g. \"prime-inference/clef\"."
        );
        fixture_agent_dir(dir.path(), Some("no-such/model"), r#"["text"]"#).unwrap();
        let refusal = error(request.clone()).await;
        assert!(
            refusal.starts_with(
                "decisionApi.systemOneModel \"no-such/model\" could not be resolved to an \
                 available, authenticated model."
            ),
            "{refusal}"
        );
        assert!(
            refusal.contains("or authenticate the provider"),
            "the refusal names the recovery: {refusal}"
        );
        // A configured but unauthenticated reference is unusable too: the
        // provider has no key, so the model never becomes available.
        std::fs::write(
            dir.path().join("models.json"),
            r#"{ "providers": { "fixture-decisions": {
                "baseUrl": "https://fixture.example", "api": "faux-decision",
                "models": [ { "id": "decision-model", "input": ["text"] } ]
            } } }"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            json!({ "decisionApi": { "systemOneModel": "decision-model" } }).to_string(),
        )
        .unwrap();
        assert!(
            error(request).await.contains("could not be resolved"),
            "an unauthenticated reference must refuse, not call a provider"
        );
    }

    #[tokio::test]
    async fn decide_validates_the_request_before_any_resolution() {
        let dir = tempfile::tempdir().unwrap();
        fixture_agent_dir(
            dir.path(),
            Some("fixture-decisions/decision-model"),
            r#"["text"]"#,
        )
        .unwrap();
        let call = decider(dir.path(), dir.path());
        let error = |data| async { call(data).await.unwrap_err().to_string() };
        let base = |request: Value| json!({ "request": request });
        assert_eq!(
            error(json!({})).await,
            "decision_api.decide needs a request object"
        );
        let good_question = json!({ "type": "choice", "criteria": { "left": "go left" } });
        let with_question =
            |question: Value| json!({ "state": {}, "questions": { "action": question } });
        assert_eq!(
            error(base(
                json!({ "state": {}, "questions": { "move": good_question } })
            ))
            .await,
            "decision_api.decide needs a \"questions\" object with an \"action\" question"
        );
        assert_eq!(
            error(base(with_question(
                json!({ "type": "rank", "criteria": {} })
            )))
            .await,
            "the \"action\" question must have type \"choice\", not \"rank\". The Decision API \
             serves one action choice per request."
        );
        assert_eq!(
            error(base(with_question(
                json!({ "type": "choice", "criteria": {} })
            )))
            .await,
            "the \"action\" question's \"criteria\" object is empty; a decision needs actions to \
             choose from"
        );
        assert_eq!(
            error(base(with_question(
                json!({ "type": "choice", "criteria": { "left": 7 } })
            )))
            .await,
            "the \"criteria\" entry \"left\" must be a string describing when the action applies, \
             not 7"
        );
        assert_eq!(
            error(base(json!({ "state": {}, "model": "jev-latest" }))).await,
            "The decision model comes from the decisionApi.systemOneModel setting; the request \
             carries no model (got \"jev-latest\")."
        );
        assert_eq!(
            error(base(json!({ "state": {}, "hint": true }))).await,
            "decision_api.decide got unsupported request fields: \"hint\". Only \"state\", \
             \"questions\", and \"images\" are allowed."
        );
        assert_eq!(
            error(base(json!({ "questions": { "action": good_question } }))).await,
            "decision_api.decide needs a \"state\" value"
        );
        let images = |list: Value| json!({ "state": {}, "questions": { "action": good_question }, "images": list });
        assert_eq!(
            error(base(images(json!([
                "data:image/png;base64,AA==",
                "not-a-data-url"
            ]))))
            .await,
            "decision images must be data URL strings like \"data:image/png;base64,...\""
        );
        let five: Vec<&str> = (0..5).map(|_| "data:image/png;base64,AA==").collect();
        assert_eq!(
            error(base(images(json!(five)))).await,
            "a decision carries at most 4 images, got 5"
        );
    }

    #[tokio::test]
    async fn decide_refuses_images_on_a_text_only_model() {
        let dir = tempfile::tempdir().unwrap();
        fixture_agent_dir(
            dir.path(),
            Some("fixture-decisions/decision-model"),
            r#"["text"]"#,
        )
        .unwrap();
        let call = decider(dir.path(), dir.path());
        let request = json!({ "request": { "state": {}, "questions": { "action": {
            "type": "choice", "criteria": { "left": "go left", "right": "go right" }
        } }, "images": [ "data:image/png;base64,AA==" ] } });
        let error = call(request).await.unwrap_err().to_string();
        assert_eq!(
            error,
            "fixture-decisions/decision-model does not accept image input, so decisions cannot \
             carry images. Drop the images, or set decisionApi.systemOneModel to a \
             vision-capable model."
        );
    }

    /// One decision round trip through the registry resolution and the
    /// provider transports, with the faux provider standing in for the wire:
    /// the answer's contract (choice, confidence, probabilities) and the
    /// request's reach (actions, state, images, key) are pinned.
    #[tokio::test]
    async fn decide_serves_one_round_trip_through_the_registry_and_provider() {
        static FAUX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let registration = {
            let _guard = FAUX_LOCK
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("faux-decision".to_string()),
                provider: Some("fixture-decisions".to_string()),
                models: Some(vec![pa_ai::faux::FauxModelDefinition {
                    id: "decision-model".to_string(),
                    input: Some(vec![ModelInput::Text, ModelInput::Image]),
                    ..Default::default()
                }]),
                ..Default::default()
            })
        };
        let dir = tempfile::tempdir().unwrap();
        fixture_agent_dir(dir.path(), Some("decision-model"), r#"["text", "image"]"#).unwrap();
        let call = decider(dir.path(), dir.path());

        // The served reply names an unrequested action: the refusal proves
        // the criteria reached the parse and the choice check is enforced.
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                r#"{"action": {"choice": "jump", "confidence": 0.9}}"#,
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let request = json!({ "request": { "state": { "x": 1 }, "questions": { "action": {
            "type": "choice", "instructions": "Track the target",
            "criteria": { "left": "go left", "right": "go right" }
        } } } });
        let error = call(request).await.unwrap_err().to_string();
        assert_eq!(
            error,
            "the decision model chose \"jump\", which is not one of the requested actions: left, \
             right"
        );

        // The good path: a fenced reply with an out-of-range confidence and
        // a non-finite share, both normalized by the host.
        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let seen_writer = std::sync::Arc::clone(&seen);
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Factory(
            std::sync::Arc::new(
                move |context: &pa_ai::types::Context,
                      options: Option<&pa_ai::types::StreamOptions>,
                      _call: u64,
                      model: &pa_types::ai::Model| {
                    let mut text = String::new();
                    for message in &context.messages {
                        if let pa_types::ai::Message::User(user) = message {
                            match &user.content {
                                pa_types::ai::UserContent::Text(content) => text.push_str(content),
                                pa_types::ai::UserContent::Blocks(blocks) => {
                                    for block in blocks {
                                        match block {
                                            pa_types::ai::UserContentBlock::Text(block) => {
                                                text.push_str(&block.text);
                                            }
                                            pa_types::ai::UserContentBlock::Image(_) => {
                                                text.push_str("<image>");
                                            }
                                            pa_types::ai::UserContentBlock::Raw(_) => {}
                                        }
                                    }
                                }
                            }
                        }
                    }
                    *seen_writer.lock().unwrap() = text;
                    let _ = (options.and_then(|options| options.api_key.clone()), model);
                    Ok(pa_ai::faux::faux_assistant_text_message(
                        "```json\n{\"action\": {\"choice\": \"left\", \"confidence\": 1.4, \
                         \"probabilities\": {\"left\": 0.75, \"right\": 0.25}}}\n```",
                        pa_ai::faux::FauxAssistantMessageOptions::default(),
                    ))
                },
            ),
        )]);
        let request = json!({ "request": { "state": { "x": 1 }, "questions": { "action": {
            "type": "choice", "instructions": "Track the target",
            "criteria": { "left": "go left", "right": "go right" }
        } }, "images": [ "data:image/png;base64,AA==" ] } });
        let answer = call(request).await.unwrap();
        assert_eq!(answer["model"], "fixture-decisions/decision-model");
        assert_eq!(
            answer["answers"],
            json!({
                "action": {
                    "choice": "left",
                    "confidence": 1.0,
                    "probabilities": { "left": 0.75, "right": 0.25 }
                }
            })
        );
        let seen = seen.lock().unwrap().clone();
        assert!(seen.contains("Instructions: Track the target"), "{seen}");
        assert!(seen.contains("- left: go left"), "{seen}");
        assert!(seen.contains("- right: go right"), "{seen}");
        assert!(seen.contains("\"x\""), "{seen}");
        assert!(seen.contains("<image>"), "{seen}");
        let received = registration.received_api_keys();
        assert!(
            received.len() >= 2
                && received
                    .iter()
                    .all(|key| key.as_deref() == Some("fixture-key")),
            "the registry-resolved key reaches the provider on every call: {received:?}"
        );
    }

    /// The fixture registry recipe with the System One decision api pointing
    /// at one loopback endpoint, plus the settings reference.
    async fn systemone_fixture(
        dir: &Path,
        reply: Value,
        seen: std::sync::Arc<std::sync::Mutex<Vec<(String, String, Value)>>>,
    ) -> anyhow::Result<String> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut raw = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head, body) = loop {
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert_ne!(read, 0, "the client closed mid-request");
                    raw.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&raw).to_string();
                    let Some((head, body)) = text.split_once("\r\n\r\n") else {
                        continue;
                    };
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let line = line.to_ascii_lowercase();
                            line.strip_prefix("content-length:")?.trim().parse().ok()
                        })
                        .unwrap_or(0);
                    if body.len() >= length {
                        break (head.to_string(), body.to_string());
                    }
                };
                let authorization = head
                    .lines()
                    .find_map(|line| {
                        let line = line.to_ascii_lowercase();
                        line.strip_prefix("authorization:")
                            .map(|v| v.trim().to_string())
                    })
                    .unwrap_or_default();
                let request_line = head.lines().next().unwrap_or_default().split(' ');
                let path = request_line
                    .into_iter()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                seen.lock().unwrap().push((
                    path,
                    authorization,
                    serde_json::from_str(&body).unwrap_or(Value::Null),
                ));
                let reply = reply.to_string();
                let response = format!(
                    "HTTP/1.1 200 Status\r\ncontent-type: application/json\r\n\
                     content-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        std::fs::write(
            dir.join("settings.json"),
            json!({ "decisionApi": { "systemOneModel": "fixture-decisions/systemone-model" } })
                .to_string(),
        )?;
        std::fs::write(
            dir.join("models.json"),
            format!(
                r#"{{ "providers": {{ "fixture-decisions": {{
                    "baseUrl": "{base}", "apiKey": "fixture-key", "api": "systemone",
                    "models": [ {{ "id": "systemone-model", "input": ["text", "image"] }} ]
                }} }} }}"#
            ),
        )?;
        Ok(base)
    }

    #[test]
    fn decision_answers_parse_leniently_and_validate_the_choice() {
        let criteria = vec![
            ("left".to_string(), "go left".to_string()),
            ("right".to_string(), "go right".to_string()),
        ];
        let plain = parse_decision_answer(
            r#"{"action": {"choice": "right", "confidence": 0.5, "probabilities": {"right": 1}}}"#,
            &criteria,
        )
        .unwrap();
        assert_eq!(plain["choice"], "right");
        assert_eq!(plain["confidence"], 0.5);
        let fenced = parse_decision_answer(
            "prose\n```json\n{\"action\": {\"choice\": \"left\"}}\n```",
            &criteria,
        )
        .unwrap();
        assert_eq!(fenced["choice"], "left");
        assert!(fenced["confidence"].is_null());
        assert!(fenced["probabilities"].is_null());
        for bad in [
            "not json",
            "{}",
            "{\"action\": \"left\"}",
            "{\"action\": {\"choice\": \"up\"}}",
            "{\"action\": {\"choice\": 3}}",
        ] {
            assert!(parse_decision_answer(bad, &criteria).is_err(), "{bad}");
        }
    }

    /// One decision over the System One protocol, hermetic: the decide
    /// dispatch builds the protocol request, the endpoint envelope parses
    /// through the same answer validation, and the merged auth rides.
    #[tokio::test]
    async fn decide_serves_the_systemone_protocol_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let envelope = json!({
            "model": "fixture-decisions/systemone-model",
            "answers": {"action": {"choice": "left", "confidence": 0.9, "probabilities": {"left": 0.9, "right": 0.1}}}
        });
        systemone_fixture(dir.path(), envelope.clone(), std::sync::Arc::clone(&seen))
            .await
            .unwrap();
        let call = decider(dir.path(), dir.path());
        let request = json!({ "request": { "state": {"observation": 1}, "questions": { "action": {
            "type": "choice", "criteria": {"left": "go left", "right": "go right"}
        } }, "images": ["data:image/png;base64,AA=="] } });
        let answer = call(request).await.unwrap();
        assert_eq!(answer["model"], "fixture-decisions/systemone-model");
        assert_eq!(answer["answers"]["action"]["choice"], "left", "{answer}");
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "/systemone");
        assert_eq!(requests[0].1, "bearer fixture-key");
        let body = &requests[0].2;
        assert_eq!(body["model"], "systemone-model");
        assert_eq!(
            body["questions"]["action"]["criteria"],
            json!({"left": "go left", "right": "go right"})
        );
        assert_eq!(
            body["images"],
            json!(["data:image/png;base64,AA=="]),
            "the images ride the protocol request"
        );
    }

    #[test]
    fn catch_startup_and_artifacts_follow_the_environment_contract() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/catch");
        let output = std::process::Command::new("python3")
            .args(["-m", "unittest", "discover", "-s"])
            .arg(&root)
            .args(["-p", "test_*.py", "-v"])
            .output()
            .expect("python3 runs the Catch environment tests");
        assert!(
            output.status.success(),
            "Catch tests failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    /// The skill's `Loop` and `decide` (image strings, step control, System 2's
    /// action gate) run as the package's own unittest.
    #[test]
    fn the_decision_api_python_loop_follows_its_contract() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../skills/decision-api");
        let output = std::process::Command::new("python3")
            .args(["-m", "unittest", "discover", "-s"])
            .arg(root.join("tests"))
            .arg("-v")
            .env("PYTHONPATH", root.join("src"))
            .output()
            .expect("python3 runs the decision-api loop tests");
        assert!(
            output.status.success(),
            "decision-api loop tests failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
}
