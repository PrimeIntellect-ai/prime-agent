//! The faux-script verification seam (`PRIME_AGENT_FAUX_SCRIPT`): the
//! script env parse, one per-child response queue per spawned child, the
//! scripted engine build, and the response-step parser. Never set by the
//! product.

use pa_core::session_engine::provider_adapter::{
    json_round_trip, switchable_stream_fn, ProviderTarget,
};

use crate::print_runtime::{
    ChildLane, HeadlessEmbedding, HeadlessEmbeddingFields, HeadlessEngine, ProviderTargetSlot,
    RunOptions,
};

/// The parsed `PRIME_AGENT_FAUX_SCRIPT` (the whole-process verification
/// seam; never set by the product): `None` on a live run, an error when
/// the script does not parse.
pub(crate) fn faux_script_env() -> Result<Option<serde_json::Value>, String> {
    match std::env::var("PRIME_AGENT_FAUX_SCRIPT") {
        Ok(script) => serde_json::from_str(&script)
            .map(Some)
            .map_err(|error| format!("invalid PRIME_AGENT_FAUX_SCRIPT: {error}")),
        Err(_) => Ok(None),
    }
}

/// The per-child faux queue: its own registered provider (keyed by the
/// child id, so siblings never share a response lane) and its steps.
pub(crate) struct FauxChildQueue {
    pub child_id: String,
    pub steps: Vec<pa_ai::faux::FauxResponseStep>,
    pub repeat_last: bool,
}

/// The faux-script engine: identical session assembly, scripted provider.
/// A spawned child in a scripted run registers its OWN provider (keyed by
/// the child id) with the queue under `children.<spawn name>`, so
/// multi-child runs stay deterministic (the registry is process-global).
pub(crate) async fn build_faux_engine_with(
    options: &RunOptions,
    script: &serde_json::Value,
    session_manager: Option<pa_core::session::manager::SessionManager>,
    // The execution mode label carries through the real path only.
    _execution_mode: &str,
    embedding: &HeadlessEmbedding,
) -> Result<HeadlessEngine, String> {
    let config = &options.config;
    // Response entries: a plain string answers with fixed text; `{"systemPrompt":
    // true}` answers with the request's system prompt; other objects go through the
    // shared faux-script parser.
    let response_steps = faux_response_steps(
        script
            .get("responses")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| "PRIME_AGENT_FAUX_SCRIPT requires a responses array".to_string())?,
    )?;
    // A `reasoning` model makes the harness script thinking-capable turns so
    // thinking-level resolution can be verified without the network.
    let reasoning = script
        .get("reasoning")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    // The script pins the context window: threshold/overflow verifiers size it to the probe they
    // run.
    let context_window = script
        .get("contextWindow")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(100_000);
    // The stable faux identity (`api: "faux"`, `provider: "faux"`): fixtures can declare
    // faux-provider models in models.json. A spawned child gets its own api
    // lane so its queue never interleaves with its parent's.
    let (api, child_queue) = match embedding {
        HeadlessEmbedding::Child(overrides) => match &overrides.lane {
            ChildLane::Faux(queue) => (format!("faux-{}", queue.child_id), Some(queue)),
            ChildLane::Real(_) => {
                return Err("a real-provider child builds through the headless builder".to_string());
            }
        },
        HeadlessEmbedding::Root { .. } | HeadlessEmbedding::Rpc => ("faux".to_string(), None),
    };
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            api: Some(api),
            provider: Some("faux".to_string()),
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "faux-1".to_string(),
                name: Some("Faux Model".to_string()),
                reasoning: Some(reasoning),
                input: Some(vec![pa_types::ai::ModelInput::Text]),
                cost: None,
                context_window: Some(context_window),
                max_tokens: Some(4_096),
            }]),
            ..Default::default()
        });
    if let Some(queue) = child_queue {
        registration.set_responses(queue.steps.clone());
        registration.set_repeat_last_response(queue.repeat_last);
    } else {
        registration.set_responses(response_steps);
        registration.set_repeat_last_response(
            script
                .get("repeatLastResponse")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        );
    }
    let model = registration.get_model();
    let thinking_level = match embedding {
        HeadlessEmbedding::Child(overrides) => {
            Some(pa_core::session_engine::provider_adapter::map_thinking_level(overrides.thinking))
        }
        HeadlessEmbedding::Root { .. } | HeadlessEmbedding::Rpc => {
            Some(super::resolve_thinking_level(config, &model))
        }
    };
    let agent_model = json_round_trip(&model).ok_or("model conversion failed")?;
    let provider_target: ProviderTargetSlot =
        std::sync::Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
            api_key: None,
            model: model.clone(),
            service_tier: None,
            headers: None,
        })));
    let stream_fn = switchable_stream_fn(std::sync::Arc::clone(&provider_target));
    // The faux path shares the session-manager wiring with the real provider
    // path so binary-level tests can verify persistence without the network.
    let HeadlessEmbeddingFields {
        rlm_subagent_host,
        extra_host_handlers,
        rlm_depth,
        bash_wake,
        rpc_bash_wake,
        on_late_sent_agent_message,
    } = super::headless_embedding_fields(embedding);
    let engine = pa_core::session_engine::engine::create_session(
        pa_core::session_engine::engine::SessionEngineConfig {
            auto_background_notice: None,
            auto_background_registry: None,
            on_late_sent_agent_message,
            cron_store: None,
            // Faux verification harness: no product telemetry.
            semantic_edges: None,
            steering_mode: None,
            follow_up_mode: None,
            telemetry: None,
            cwd: config.cwd.clone(),
            agent_dir: config.agent_dir.clone(),
            mcp_manager: None,
            model: Some(agent_model),
            thinking_level,
            stream_fn: Some(stream_fn),
            tools: super::builtin_tools(&config.cwd),
            custom_system_prompt: config.system_prompt.clone(),
            prompt_guidelines: config.append_system_prompt.clone(),
            generic_mcp_servers: vec![],
            allow_recursion: None,
            session_manager,
            extra_host_handlers,
            conversation_log_path: None,
            additional_skill_paths: vec![],
            additional_prompt_paths: vec![],
            extra_builtin_skill_overrides: vec![],
            rlm_subagent_host,
            rlm_usage_store: None,
            progress_note_emit: None,
            rlm_depth,
            daemonless: true,
            model_info: Some(model.clone()),
            // A Rust-only verification harness: no background kernel boot in tests.
            prewarm_ipython_kernel: None,
            // The background-bash wake pair, the same seam the real
            // provider path wires (the scripted e2es drive the wake).
            bash_notice_wake: Some(std::sync::Arc::clone(&bash_wake)),
            on_background_work_settled: Some(bash_wake),
            queued_goal_context_purge: None,
            queued_steering_probe: None,
            should_stop_after_turn: None,
            image_model_router: None,
        },
    )
    .await
    .map_err(|error| format!("{error:#}"))?;
    Ok(HeadlessEngine {
        engine,
        model,
        api_key: None,
        provider_target,
        rpc_bash_wake,
    })
}

/// One scripted response entry: a plain string answers with fixed text;
/// `{"systemPrompt": true}` answers with the request's system prompt;
/// other objects go through the shared faux-script parser.
pub(crate) fn faux_response_steps(
    entries: &[serde_json::Value],
) -> Result<Vec<pa_ai::faux::FauxResponseStep>, String> {
    entries
        .iter()
        .map(|entry| match entry {
            serde_json::Value::String(text) => Ok(pa_ai::faux::FauxResponseStep::Message(
                pa_ai::faux::faux_assistant_text_message(
                    text,
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ),
            )),
            serde_json::Value::Object(map)
                if map.get("systemPrompt").and_then(serde_json::Value::as_bool) == Some(true) =>
            {
                Ok(pa_ai::faux::FauxResponseStep::Factory(std::sync::Arc::new(
                    |context, _options, _call, _model| {
                        Ok(pa_ai::faux::faux_assistant_text_message(
                            context.system_prompt.as_deref().unwrap_or_default(),
                            pa_ai::faux::FauxAssistantMessageOptions::default(),
                        ))
                    },
                )))
            }
            serde_json::Value::Object(_) => {
                pa_ai::faux::script::parse_faux_script(&serde_json::json!({
                    "responses": [entry]
                }))
                .map(|parsed| {
                    let mut steps = parsed.responses.into_iter();
                    let first = steps
                        .next()
                        .expect("an object entry parses into one response step");
                    debug_assert!(steps.next().is_none());
                    first
                })
            }
            _ => Ok(pa_ai::faux::FauxResponseStep::Message(
                pa_ai::faux::faux_assistant_text_message(
                    "",
                    pa_ai::faux::FauxAssistantMessageOptions::default(),
                ),
            )),
        })
        .collect()
}
