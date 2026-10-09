//! The System 1 decision: one model call per step, thinking off, strict
//! single-choice parsing against the declared action space. Rust port of
//! `packages/coding-agent/src/core/system-router/decide.ts` (#2484).

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use pa_agent::abort::AbortSignal;
use pa_agent::types::{AssistantContent, AssistantMessage, StopReason};
use pa_types::ai::{
    ImageContent, Message, Model, ModelInput, ModelThinkingLevel, TextContent, UserContent,
    UserContentBlock, UserMessage,
};
use serde_json::{Map, Value};

use crate::session_engine::provider_adapter::json_round_trip;
use crate::session_engine::provider_retry::{complete_with_provider_retry, ProviderRetryPolicy};

use super::action_space::CompiledAction;
use super::types::RouterUsage;

/// Output cap for one decision call. The decision object itself is a few
/// dozen tokens, but mandatory-reasoning models still spend output tokens on
/// reasoning content; a small cap would truncate the decision.
pub const ROUTER_DECISION_MAX_TOKENS: u64 = 4_096;

/// The System 1 action-model system prompt.
pub const ROUTER_DECISION_SYSTEM_PROMPT: &str = "You are the action model inside a System 1 control loop. You do not plan, explain, or write prose. Each step you receive the goal, the latest observation, recent history, and the finite list of available actions. Reply with exactly one JSON object: the chosen action, its parameter values, and your confidence that it is the right next step. Reply with JSON only.";

/// One decision request: the compiled prompt, an optional screenshot, and the
/// abort signal the segment owns.
#[derive(Debug, Clone)]
pub struct RouterDecisionRequest {
    pub prompt: String,
    /// Base64 PNG screenshot; included only when the model accepts images.
    pub image: Option<String>,
    /// Aborted when the segment ends; provider retries and sleeps stop.
    pub signal: Option<AbortSignal>,
}

/// One decision outcome. `action` is `None` when the reply was not a valid
/// single choice from the action space.
#[derive(Debug, Clone)]
pub struct RouterDecisionOutcome {
    pub action: Option<String>,
    pub params: BTreeMap<String, String>,
    /// Parsed confidence in [0, 1]; `None` on parse failure.
    pub confidence: Option<f64>,
    /// Why a malformed reply was refused; counts toward the refusal streak.
    pub parse_error: Option<String>,
    /// Transport or model failure; fails the run.
    pub model_error: Option<String>,
    pub usage: Option<RouterUsage>,
}

impl RouterDecisionOutcome {
    fn refused(parse_error: String) -> Self {
        Self {
            action: None,
            params: BTreeMap::new(),
            confidence: None,
            parse_error: Some(parse_error),
            model_error: None,
            usage: None,
        }
    }
}

/// The System 1 decision function: one bounded model call per step.
pub type RouterDecisionFn = Arc<
    dyn Fn(
            RouterDecisionRequest,
        ) -> Pin<Box<dyn Future<Output = anyhow::Result<RouterDecisionOutcome>> + Send>>
        + Send
        + Sync,
>;

/// The resolved action model and request auth one decision function runs with.
#[derive(Clone)]
pub struct RouterDecisionContext {
    pub model: Model,
    pub api_key: Option<String>,
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    pub session_id: Option<String>,
    pub policy: ProviderRetryPolicy,
    pub actions: Arc<super::action_space::CompiledActionSpace>,
}

/// The thinking level the System 1 decision calls run at: off, clamped per
/// model.
#[must_use]
pub fn router_thinking_level(model: &Model) -> ModelThinkingLevel {
    pa_ai::models::clamp_thinking_level(model, ModelThinkingLevel::Off)
}

/// Whether the action model accepts image input.
#[must_use]
pub fn supports_images(model: &Model) -> bool {
    model
        .input
        .iter()
        .any(|input| matches!(input, ModelInput::Image))
}

fn text_of(message: &AssistantMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            AssistantContent::Text(text) => Some(text.text.clone()),
            AssistantContent::Thinking(_) | AssistantContent::ToolCall(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Extract every JSON object in the reply, in reply order: the fenced block
/// first, then the raw text. `parse_decision` accepts the reply only when the
/// candidates resolve to exactly one distinct valid choice, so prose (or a
/// discarded draft object) around the decision object cannot turn a
/// well-formed reply into a parse refusal.
fn extract_json_object_candidates(raw: &str) -> Vec<Map<String, Value>> {
    let mut candidates = Vec::new();
    let fenced = fenced_block(raw);
    for source in [fenced.map(str::to_string), Some(raw.to_string())] {
        let Some(source) = source else {
            continue;
        };
        let trimmed = source.trim();
        if trimmed.is_empty() {
            continue;
        }
        candidates.extend(object_candidates_from_text(trimmed));
    }
    candidates
}

/// The first fenced code block body, with an optional `json` tag.
fn fenced_block(raw: &str) -> Option<&str> {
    let start = raw.find("```")?;
    let after = &raw[start + 3..];
    let after = after.strip_prefix("json").unwrap_or(after);
    let after = after.trim_start();
    let end = after.find("```")?;
    Some(&after[..end])
}

/// Greedy first-brace-to-last-brace slice first, then nearest balanced-brace
/// slices.
fn object_candidates_from_text(trimmed: &str) -> Vec<Map<String, Value>> {
    let mut candidates = Vec::new();
    let Some(start) = trimmed.find('{') else {
        return candidates;
    };
    if let Some(end) = trimmed.rfind('}') {
        if end > start {
            push_object_candidate(&mut candidates, &trimmed[start..=end]);
        }
    }
    // The balanced scan advances past each slice to the next open brace: a
    // brace pair in prose before the decision object must not pin every slice
    // to the first brace and hide a later well-formed choice.
    let mut scan_from = Some(start);
    while let Some(from) = scan_from {
        if let Some(close) = balanced_object_end(trimmed, from) {
            push_object_candidate(&mut candidates, &trimmed[from..=close]);
            scan_from = trimmed[close + 1..]
                .find('{')
                .map(|offset| close + 1 + offset);
        } else {
            // An unclosed prose `{` must not end the scan: retry from the next
            // open brace so a later complete object is still recovered.
            scan_from = trimmed[from + 1..]
                .find('{')
                .map(|offset| from + 1 + offset);
        }
    }
    candidates
}

/// The byte index of the matching `}` for the `{` at `from`, ignoring braces
/// inside strings (a parameter choice value is content, not structure).
fn balanced_object_end(text: &str, from: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, character) in text[from..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(from + offset);
                }
            }
            _ => {}
        }
    }
    None
}

fn push_object_candidate(candidates: &mut Vec<Map<String, Value>>, slice: &str) {
    if let Ok(value) = serde_json::from_str::<Value>(slice) {
        if let Some(object) = value.as_object() {
            candidates.push(object.clone());
        }
    }
}

/// Parse a decision against the compiled action space. Free text never passes.
/// The reply must resolve to exactly ONE choice: prose (or a discarded draft
/// object) around the decision object cannot turn a well-formed reply into a
/// refusal, identical copies of one decision count once (the fenced and raw
/// scans re-extract the same object), but two distinct valid choices are an
/// ambiguous reply and refuse.
#[must_use]
#[allow(clippy::implicit_hasher)] // mirrors the TS Map<string, CompiledAction> seam
pub fn parse_decision(
    raw: &str,
    actions: &HashMap<String, CompiledAction>,
) -> RouterDecisionOutcome {
    let candidates = extract_json_object_candidates(raw);
    let mut first_refusal: Option<RouterDecisionOutcome> = None;
    let mut distinct: Vec<RouterDecisionOutcome> = Vec::new();
    for object in &candidates {
        let outcome = validate_decision_object(object, actions);
        if outcome.action.is_some() {
            if !distinct.iter().any(|seen| same_decision(seen, &outcome)) {
                distinct.push(outcome);
            }
        } else if first_refusal.is_none() {
            // The first candidate keeps the diagnostic about the earliest object.
            first_refusal = Some(outcome);
        }
    }
    match distinct.len() {
        0 => first_refusal.unwrap_or_else(|| {
            RouterDecisionOutcome::refused("reply was not a JSON object".to_string())
        }),
        1 => distinct.pop().unwrap(),
        _ => RouterDecisionOutcome::refused(
            "reply contained more than one distinct decision".to_string(),
        ),
    }
}

/// Two valid outcomes are the same choice when the action, its params, and the
/// confidence all match: identical copies (the fenced and raw scans find the
/// same object twice) must not look like a conflict.
fn same_decision(left: &RouterDecisionOutcome, right: &RouterDecisionOutcome) -> bool {
    left.action == right.action
        && left.params == right.params
        && left.confidence == right.confidence
}

/// Validate one extracted decision object against the compiled action space.
fn validate_decision_object(
    object: &Map<String, Value>,
    actions: &HashMap<String, CompiledAction>,
) -> RouterDecisionOutcome {
    let action_name = object.get("action").and_then(Value::as_str);
    let Some(action_name) = action_name else {
        return RouterDecisionOutcome::refused(format!(
            "unknown action {}",
            serde_json::to_string(&object.get("action").cloned().unwrap_or(Value::Null))
                .unwrap_or_else(|_| "null".to_string())
        ));
    };
    let Some(action) = actions.get(action_name) else {
        return RouterDecisionOutcome::refused(format!(
            "unknown action {}",
            serde_json::to_string(action_name).unwrap_or_else(|_| "null".to_string())
        ));
    };
    let mut params: BTreeMap<String, String> = BTreeMap::new();
    if let Some(raw_params) = object.get("params") {
        let Some(raw_params) = raw_params.as_object() else {
            return RouterDecisionOutcome::refused("params must be an object".to_string());
        };
        for (key, value) in raw_params {
            let Some(allowed) = action.params.get(key) else {
                return RouterDecisionOutcome::refused(format!(
                    "unknown param \"{key}\" for action \"{action_name}\""
                ));
            };
            let Some(value) = value.as_str() else {
                return RouterDecisionOutcome::refused(format!(
                    "param \"{key}\" value must be one of its declared choices"
                ));
            };
            if !allowed.choices.contains_key(value) {
                return RouterDecisionOutcome::refused(format!(
                    "param \"{key}\" value must be one of its declared choices"
                ));
            }
            params.insert(key.clone(), value.to_string());
        }
    }
    let missing: Vec<&String> = action
        .params
        .keys()
        .filter(|param_name| !params.contains_key(*param_name))
        .collect();
    if !missing.is_empty() {
        let missing = missing
            .iter()
            .map(|name| name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return RouterDecisionOutcome::refused(format!(
            "missing param(s) {missing} for action \"{action_name}\""
        ));
    }
    let confidence = object.get("confidence").and_then(Value::as_f64);
    let Some(confidence) = confidence else {
        return RouterDecisionOutcome::refused("confidence must be a number in [0, 1]".to_string());
    };
    if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
        return RouterDecisionOutcome::refused("confidence must be a number in [0, 1]".to_string());
    }
    RouterDecisionOutcome {
        action: Some(action_name.to_string()),
        params,
        confidence: Some(confidence),
        parse_error: None,
        model_error: None,
        usage: None,
    }
}

/// The one user message a decision call sends (text plus the optional image).
fn build_user_content(prompt: &str, image: Option<&str>) -> UserContent {
    let Some(image) = image else {
        return UserContent::Text(prompt.to_string());
    };
    UserContent::Blocks(vec![
        UserContentBlock::Text(TextContent {
            text: prompt.to_string(),
            text_signature: None,
            rest: Map::new(),
        }),
        UserContentBlock::Image(ImageContent {
            data: image.to_string(),
            mime_type: "image/png".to_string(),
            rest: Map::new(),
        }),
    ])
}

/// Build the System 1 decision function: ONE model call per step with thinking
/// disabled (clamped per model), provider-retry, and strict single-choice
/// parsing against the declared action space.
#[must_use]
pub fn create_model_decision_function(context: RouterDecisionContext) -> RouterDecisionFn {
    let thinking_level = router_thinking_level(&context.model);
    let include_images = supports_images(&context.model);
    Arc::new(move |request: RouterDecisionRequest| {
        let model = context.model.clone();
        let api_key = context.api_key.clone();
        let headers = context.headers.as_ref().map(|headers| {
            headers
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<HashMap<String, String>>()
        });
        let session_id = context.session_id.clone();
        let policy = context.policy.clone();
        let actions = Arc::clone(&context.actions);
        Box::pin(async move {
            let image = if include_images {
                request.image.as_deref()
            } else {
                None
            };
            let llm_context = pa_types::ai::Context {
                system_prompt: Some(ROUTER_DECISION_SYSTEM_PROMPT.to_string()),
                messages: vec![Message::User(UserMessage {
                    content: build_user_content(&request.prompt, image),
                    timestamp: 0,
                    rest: Map::new(),
                })],
                tools: None,
            };
            let mut stream_options =
                pa_ai::types::SimpleStreamOptions::from_base(pa_ai::types::StreamOptions {
                    max_tokens: Some(model.max_tokens.min(ROUTER_DECISION_MAX_TOKENS)),
                    api_key,
                    headers,
                    session_id,
                    ..Default::default()
                });
            stream_options.reasoning = Some(thinking_level);
            let signal = request.signal.clone();
            let wait_signal = signal.clone();
            let attempt_model = model.clone();
            let attempt_context = llm_context.clone();
            let attempt_options = stream_options.clone();
            let message = complete_with_provider_retry(
                &policy,
                signal.as_ref(),
                move |duration| {
                    let wait_signal = wait_signal.clone();
                    async move {
                        if let Some(signal) = &wait_signal {
                            tokio::select! {
                                () = tokio::time::sleep(duration) => true,
                                () = signal.aborted() => false,
                            }
                        } else {
                            tokio::time::sleep(duration).await;
                            true
                        }
                    }
                },
                move || {
                    let model = attempt_model.clone();
                    let llm_context = attempt_context.clone();
                    let options = attempt_options.clone();
                    async move {
                        let message = pa_ai::complete_simple(&model, &llm_context, Some(options))
                            .await
                            .map_err(anyhow::Error::new)?;
                        json_round_trip::<_, AssistantMessage>(&message)
                            .ok_or_else(|| anyhow::anyhow!("assistant wire shape mismatch"))
                    }
                },
            )
            .await?;
            let usage = Some(RouterUsage {
                input_tokens: message.usage.input,
                output_tokens: message.usage.output,
            });
            if message.stop_reason == StopReason::Error {
                return Ok(RouterDecisionOutcome {
                    action: None,
                    params: BTreeMap::new(),
                    confidence: None,
                    parse_error: None,
                    model_error: Some(format!(
                        "decision model failed: {}",
                        message.error_message.as_deref().unwrap_or("unknown error")
                    )),
                    usage,
                });
            }
            if matches!(
                message.stop_reason,
                StopReason::Length | StopReason::Aborted
            ) {
                return Ok(RouterDecisionOutcome {
                    action: None,
                    params: BTreeMap::new(),
                    confidence: None,
                    parse_error: None,
                    model_error: Some(format!(
                        "decision model stopped early ({})",
                        match message.stop_reason {
                            StopReason::Length => "length",
                            StopReason::Aborted => "aborted",
                            StopReason::Stop | StopReason::ToolUse | StopReason::Error => "error",
                        }
                    )),
                    usage,
                });
            }
            let mut outcome = parse_decision(&text_of(&message), &actions.by_name);
            outcome.usage = usage;
            Ok(outcome)
        })
    })
}

#[cfg(test)]
mod tests;
