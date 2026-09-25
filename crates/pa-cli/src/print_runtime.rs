//! The headless print runtime: single-shot prompt -> answer over the pa-core
//! session engine with a real pa-ai provider. Port of the text-mode half of
//! modes/print-mode.ts wired onto `create_session` (the Rust engine facade).

use std::sync::Arc;

use pa_agent::types::Model as AgentModel;
use pa_core::session::discovery::{
    find_most_recent_session_for_cwd, resolve_session_path, ResolvedSession, SessionSelectorError,
};
use pa_types::ai::Model;

use crate::headless_autonomous::{autonomous_runtime_config, HeadlessAutonomous};
use crate::mode::{AppMode, MissingSubsystem, RunOptions};
use pa_core::session_engine::provider_adapter::{
    json_round_trip, map_thinking_level, switchable_stream_fn, ProviderTarget,
};
use pa_core::session_engine::session_events::agent_event_json;

/// The runtime: implements the print (text) mode against the merged session
/// engine. Modes not wired here still report their typed missing subsystem.
pub struct PrintRuntime;

impl crate::mode::Runtime for PrintRuntime {
    fn run(&self, options: &RunOptions) -> Result<i32, MissingSubsystem> {
        // `model list` takes the full runtime path in every mode and exits
        // (TS main: listModels runs after session assembly, before any mode
        // transport, and exits 0).
        if options.list_models.is_some() {
            return match crate::list_models::run(options) {
                Ok(code) => Ok(code),
                Err(message) => {
                    eprintln!("Error: {message}");
                    Ok(1)
                }
            };
        }
        match options.app_mode {
            // Runtime failures print themselves and exit non-zero; the typed
            // MissingSubsystem channel stays reserved for unwired subsystems.
            AppMode::Print | AppMode::Json => match run_print_mode(options) {
                Ok(code) => Ok(code),
                Err(message) => {
                    eprintln!("Error: {message}");
                    Ok(1)
                }
            },
            // The interactive TUI attaches through the daemon (spawning a
            // supervisor when none is running); the daemon mode runs the
            // supervisor in-process. Runtime failures print themselves and
            // exit non-zero, so the typed channel stays for unwired modes.
            AppMode::Interactive => match crate::interactive_mode::run_interactive_mode(options) {
                Ok(code) => Ok(code),
                Err(error) => {
                    eprintln!("Error: {error:#}");
                    Ok(1)
                }
            },
            AppMode::Daemon => {
                match crate::daemon_mode::run_daemon_mode(options.daemon_socket.as_deref()) {
                    Ok(code) => Ok(code),
                    Err(error) => {
                        eprintln!("Error: {error:#}");
                        Ok(1)
                    }
                }
            }
            // ACP mode: a thin JSON-RPC stdio transport over the same
            // in-process session engine the print mode uses.
            AppMode::Acp => match run_acp_mode(options) {
                Ok(code) => Ok(code),
                Err(error) => {
                    eprintln!("Error: {error:#}");
                    Ok(1)
                }
            },
            // RPC mode: the TS `modes/rpc` JSONL command surface over the
            // same in-process session engine the print mode uses
            // (daemon-attached transport: the follow-up lane).
            AppMode::Rpc => match run_rpc_mode(options) {
                Ok(code) => Ok(code),
                Err(error) => {
                    eprintln!("Error: {error:#}");
                    Ok(1)
                }
            },
        }
    }
}

/// The ACP headless mode: build the in-process session engine the same way
/// the print mode does, then serve the ACP JSON-RPC surface over stdio until
/// the client disconnects.
fn run_acp_mode(options: &RunOptions) -> Result<i32, String> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    rt.block_on(acp_mode_main(options))
}

async fn acp_mode_main(options: &RunOptions) -> Result<i32, String> {
    // TS `shouldUseDaemonClient` is true for the ACP mode: the daemon is
    // the preferred transport, and the in-process engine stays the
    // fallback when no daemon can be reached or served.
    if let Some(exit_code) = try_daemon_attached_acp(options).await {
        return Ok(exit_code);
    }
    let config = &options.config;
    let engine = build_headless_engine_parts(options, "print").await?;
    let exit_code = pa_daemon::acp::run_acp_mode(pa_daemon::acp::AcpOptions {
        engine: std::sync::Arc::new(engine.engine),
        actual_cwd: config.cwd.clone(),
        product_version: crate::config::version().to_string(),
        model: Some(engine.model),
        api_key: engine.api_key,
        agent_dir: config.agent_dir.clone(),
        autonomous_config: options
            .config
            .autonomous
            .as_ref()
            .map(autonomous_runtime_config),
    })
    .await
    .map_err(|error| format!("{error:#}"))?;
    Ok(exit_code)
}

/// Try the daemon-attached ACP transport: ensure a supervisor is
/// listening (spawning one detached, TS daemon-launch semantics), then
/// serve the ACP surface over a client-owned daemon session. `None` means
/// the daemon path is unavailable and the in-process engine serves the
/// connection instead (the failure is logged to stderr, never stdout).
async fn try_daemon_attached_acp(options: &RunOptions) -> Option<i32> {
    if std::env::var_os("PRIME_AGENT_FAUX_SCRIPT").is_some() {
        return None;
    }
    // Flag > env > default: the ACP transport resolves the same
    // `PRIME_AGENT_DAEMON_SOCKET` contract as every other mode (the
    // `prime-agent-rust` launcher pins that env, so the ACP path must
    // honor it or it would target the TypeScript default socket and
    // treat the schema mismatch as a stale daemon).
    let socket_path = crate::config::resolve_daemon_socket_path(options.daemon_socket.as_deref());
    let cwd = options.config.cwd.clone();
    let result = async {
        crate::interactive_mode::ensure_daemon_running(&socket_path, &cwd)
            .await
            .map_err(|error| format!("{error:#}"))?;
        let config = &options.config;
        // The daemon worker resolves model auth from its own agent dir;
        // the composition only carries the selection flags.
        pa_daemon::acp::daemon::run_daemon_attached_acp_mode(
            pa_daemon::acp::daemon::DaemonAcpOptions {
                socket_path,
                actual_cwd: config.cwd.clone(),
                product_version: crate::config::version().to_string(),
                provider: config.provider.clone(),
                model: config.model.clone(),
                api_key: None,
            },
        )
        .await
        .map_err(|error| format!("{error:#}"))
    }
    .await;
    match result {
        Ok(code) => Some(code),
        Err(error) => {
            eprintln!(
                "prime-agent: daemon-attached ACP unavailable, using in-process mode: {error}"
            );
            None
        }
    }
}

/// The RPC headless mode: build the in-process session engine the print
/// mode does, then serve the TS `modes/rpc` JSONL command surface over
/// stdio until the client closes stdin.
fn run_rpc_mode(options: &RunOptions) -> Result<i32, String> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    rt.block_on(rpc_mode_main(options))
}

async fn rpc_mode_main(options: &RunOptions) -> Result<i32, String> {
    let config = &options.config;
    let (parts, initial_lease) = build_headless_engine_parts_with_lease(options, "rpc").await?;
    // The CLI `--goal` seed rides the first session like the print mode.
    if let Some(goal) = &config.initial_goal {
        parts
            .engine
            .seed_initial_goal(&goal.objective, goal.token_budget.map(u64::from))
            .await
            .map_err(|error| format!("{error:#}"))?;
    }
    let factory = rpc_engine_factory(options);
    let mut engine_handle = pa_daemon::rpc::session::RpcEngineHandle::from(parts);
    // The initial (possibly resumed) session's runtime lease rides the
    // handle: a later whole-session replacement releases it exactly when
    // the initial engine stops writing (instead of holding the file
    // until the process exits).
    engine_handle.session_lease = initial_lease;
    let exit_code = pa_daemon::rpc::run_rpc_mode(pa_daemon::rpc::RpcOptions {
        engine: engine_handle,
        engine_factory: Some(factory),
        cwd: config.cwd.clone(),
        agent_dir: config.agent_dir.clone(),
        autonomous_config: options
            .config
            .autonomous
            .as_ref()
            .map(autonomous_runtime_config),
    })
    .await
    .map_err(|error| format!("{error:#}"))?;
    Ok(exit_code)
}

/// The engine-replacement seam the RPC mode's `new_session` /
/// `switch_session` / `fork` commands drive (TS `runtimeHost`
/// replacement flows): pa-cli owns the assembly, the mode owns the swap.
fn rpc_engine_factory(options: &RunOptions) -> pa_daemon::rpc::session::RpcEngineFactory {
    let options = options.clone();
    std::sync::Arc::new(move |request| {
        let mut options = options.clone();
        // The replacement sessions ignore the CLI's session-selection
        // flags (TS replacement flows build their own manager).
        options.session.resume = None;
        options.session.resume_bare = false;
        options.session.continue_recent = false;
        options.session.fork = None;
        Box::pin(async move {
            // The runtime lease an `Open` acquired for the target file: it
            // rides the handle (dropping with the engine on the next
            // replacement, exactly when the old session stops writing).
            let mut opened_lease = None;
            let manager = match &request {
                pa_daemon::rpc::session::RpcEngineRequest::New { parent_session } => {
                    let session_dir = replacement_session_dir(&options);
                    match parent_session {
                        Some(parent) => {
                            let cwd = options.config.cwd.clone();
                            let mut manager = pa_core::session::manager::SessionManager::persisted(
                                &cwd,
                                &session_dir,
                            );
                            manager.new_session(&pa_core::session::manager::NewSessionOptions {
                                parent_session: Some(parent.clone()),
                                ..Default::default()
                            });
                            manager
                        }
                        None => pa_core::session::manager::SessionManager::persisted(
                            &options.config.cwd,
                            &session_dir,
                        ),
                    }
                }
                pa_daemon::rpc::session::RpcEngineRequest::Open { session_path } => {
                    let session_dir = replacement_session_dir(&options);
                    let cwd = options.config.cwd.clone();
                    // The ownership guard every in-process open applies:
                    // refuse a file a live daemon worker or another
                    // process already hosts (a second writer over a
                    // persisted history), and hold its runtime lease for
                    // the opened session.
                    let lease = session_open_guard(options.daemon_socket.as_deref(), session_path)?;
                    // A failed open's early return drops the lease
                    // (released), so errors never leave an orphaned hold.
                    let manager = open_session_file(session_path, &session_dir, &cwd, None)?;
                    // The replacement ADOPTS the opened session's own
                    // cwd (TS createRuntime builds the runtime over the
                    // session's project, not the CLI startup
                    // directory): tools, settings, and file work run
                    // against the session's repository.
                    options.config.cwd = manager.get_cwd().to_path_buf();
                    opened_lease = Some(lease);
                    manager
                }
            };
            let engine = if let Ok(script) = std::env::var("PRIME_AGENT_FAUX_SCRIPT") {
                build_faux_engine_with(&options, &script, Some(manager), "rpc").await?
            } else {
                build_headless_engine_with(&options, Some(manager), "rpc").await?
            };
            let mut handle = pa_daemon::rpc::session::RpcEngineHandle::from(engine);
            handle.session_lease = opened_lease;
            Ok(handle)
        })
    })
}

/// The replacement builds' session dir (the resolved one, else the
/// default under the agent dir).
fn replacement_session_dir(options: &RunOptions) -> std::path::PathBuf {
    options
        .session
        .session_dir
        .clone()
        .unwrap_or_else(|| options.config.agent_dir.join("sessions"))
}

/// The RPC mode's engine-handle conversion (the composition root's
/// `HeadlessEngine` into the mode's handle).
impl From<HeadlessEngine> for pa_daemon::rpc::session::RpcEngineHandle {
    fn from(parts: HeadlessEngine) -> Self {
        Self {
            engine: std::sync::Arc::new(parts.engine),
            model: parts.model,
            api_key: parts.api_key,
            provider_target: parts.provider_target,
            session_lease: None,
        }
    }
}

fn run_print_mode(options: &RunOptions) -> Result<i32, String> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    rt.block_on(print_mode_main(options))
}

async fn print_mode_main(options: &RunOptions) -> Result<i32, String> {
    let headless = build_headless_engine(options, "print").await?;
    let engine = std::sync::Arc::new(headless.engine);
    // The CLI `--goal` seed (TS constructor seeding): a fresh root branch
    // starts the goal and queues its continuation context as the first
    // turn's leading row; a resumed or already-seeded branch keeps its
    // persisted goal. Depth 0 only — the print session is a root session
    // (TS main.ts gates `initialGoal` on `rlmDepth === 0` the same way).
    if let Some(goal) = &options.config.initial_goal {
        engine
            .seed_initial_goal(&goal.objective, goal.token_budget.map(u64::from))
            .await
            .map_err(|error| format!("{error:#}"))?;
    }
    run_prompts_and_emit(&engine, &headless.model, headless.api_key.clone(), options).await
}

/// Assemble the in-process session engine for a headless run: model
/// resolution, session persistence, and the engine facade. The faux-script
/// seam (`PRIME_AGENT_FAUX_SCRIPT`) drives the same assembly without the
/// network; verification harness only, never set by the product.
/// The assembled headless engine plus the model and request auth it runs
/// on, so host transports can drive session-command executors
/// (compact/refine) with the session's own model.
struct HeadlessEngine {
    engine: pa_core::session_engine::engine::SessionEngine,
    model: Model,
    api_key: Option<String>,
    /// The live provider target the engine's stream reads per call
    /// (`set_model` swaps it without rebuilding the session).
    provider_target: std::sync::Arc<std::sync::RwLock<Option<ProviderTarget>>>,
}

async fn build_headless_engine_parts(
    options: &RunOptions,
    execution_mode: &str,
) -> Result<HeadlessEngine, String> {
    let (engine, lease) = build_headless_engine_parts_with_lease(options, execution_mode).await?;
    std::mem::forget(lease);
    Ok(engine)
}

/// The same assembly, returning the opened session's runtime lease
/// alongside (a long-lived connection holds it on the engine handle so a
/// replacement releases it with the engine it guarded; the one-shot
/// modes forget it for the process lifetime).
async fn build_headless_engine_parts_with_lease(
    options: &RunOptions,
    execution_mode: &str,
) -> Result<(HeadlessEngine, Option<pa_daemon::lease::SessionLease>), String> {
    let (session_manager, lease) = select_session_manager_with_lease(options)?;
    if let Ok(script) = std::env::var("PRIME_AGENT_FAUX_SCRIPT") {
        let engine =
            build_faux_engine_with(options, &script, session_manager, execution_mode).await?;
        return Ok((engine, lease));
    }
    let engine = build_headless_engine_with(options, session_manager, execution_mode).await?;
    Ok((engine, lease))
}

/// The session-manager selection every engine build shares
/// (`--no-session` keeps the engine in-memory; anything else resolves
/// through the flag order), returning the opened session's runtime
/// lease.
fn select_session_manager_with_lease(
    options: &RunOptions,
) -> Result<
    (
        Option<pa_core::session::manager::SessionManager>,
        Option<pa_daemon::lease::SessionLease>,
    ),
    String,
> {
    if options.session.no_session {
        return Ok((None, None));
    }
    let (manager, lease) = build_session_manager_with_lease(options)?;
    Ok((Some(manager), lease))
}

/// The real-provider engine assembly over one session-manager selection
/// (the print/json path and the RPC mode's replacement builds).
async fn build_headless_engine_with(
    options: &RunOptions,
    session_manager: Option<pa_core::session::manager::SessionManager>,
    execution_mode: &str,
) -> Result<HeadlessEngine, String> {
    let config = &options.config;

    // Model registry: composed catalog + models.json with real auth.
    let auth = pa_core::auth::AuthStorage::create(&config.agent_dir);
    let mut registry =
        pa_core::models::ModelRegistry::create(auth, config.agent_dir.join("models.json"));
    registry.load_private_authorization_from_cache();
    let model = select_model(
        &mut registry,
        config.provider.as_deref(),
        config.model.as_deref(),
    )?;

    // Resolve request auth once (single-shot mode).
    let resolved = registry.get_api_key_and_headers(&model, model.headers.as_ref());

    let provider_target = std::sync::Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
        api_key: resolved.api_key.clone(),
        model: model.clone(),
        service_tier: None,
        headers: resolved.headers.clone(),
    })));
    let stream_fn = switchable_stream_fn(std::sync::Arc::clone(&provider_target));
    let agent_model: AgentModel = json_round_trip(&model).ok_or("model conversion failed")?;

    // Telemetry (TS `installAgentTelemetry` parity for headless sessions):
    // the CLI's env/settings opt-out decides; enabled sessions resolve the
    // configured sinks. Depth 0 only, enforced by the engine.
    let telemetry = (!config.telemetry_disabled).then(|| {
        let settings = pa_core::settings::SettingsManager::create(&config.cwd, &config.agent_dir);
        pa_core::session_engine::telemetry::TelemetryWiring {
            client: pa_core::session_engine::telemetry::build_client(&settings, &config.agent_dir),
            execution_mode: Some(execution_mode.to_string()),
            now: None,
        }
    });
    // TS `sdk.ts` seeds the Agent's queue modes from the settings manager
    // (`steeringMode`/`followUpMode`): the print runtime reads the same
    // settings its telemetry does, so the agent-level queues drain per
    // the configured modes (the steering default is "all"; follow-ups
    // keep "one-at-a-time").
    let queue_settings = pa_core::settings::SettingsManager::create(&config.cwd, &config.agent_dir);
    let queue_mode = |mode: pa_core::settings::QueueModeSetting| match mode {
        pa_core::settings::QueueModeSetting::All => pa_agent::agent::QueueMode::All,
        pa_core::settings::QueueModeSetting::OneAtATime => pa_agent::agent::QueueMode::OneAtATime,
    };
    let steering_mode = Some(queue_mode(queue_settings.get_steering_mode()));
    let follow_up_mode = Some(queue_mode(queue_settings.get_follow_up_mode()));
    // TS `createAgentSessionServices` builds every CLI session — print
    // included — on a manager whose `getUserServers`/`getCatalogSources`
    // closures re-read settings on every resolution (construction and
    // each later `refresh()`: the API the remote-catalog change
    // subscription drives mid-session), and whose declared local catalog
    // sources resolve. The session's `mcp.config` host handler keeps
    // serving the registration-time integrations (the pa-core handler
    // design, shared with the daemon worker). Auth construction blocks;
    // run it off the async runtime like the engine's own gating does.
    let mcp_manager = {
        let cwd = config.cwd.clone();
        let agent_dir = config.agent_dir.clone();
        let manager = tokio::task::spawn_blocking(move || {
            crate::mcp_login::cli_mcp_manager(&cwd, &agent_dir)
        })
        .await
        .map_err(|error| format!("MCP manager construction failed: {error}"))?;
        std::sync::Arc::new(std::sync::Mutex::new(manager))
    };
    let engine = pa_core::session_engine::engine::create_session(
        pa_core::session_engine::engine::SessionEngineConfig {
            cron_store: None,
            telemetry,
            steering_mode,
            follow_up_mode,
            cwd: config.cwd.clone(),
            agent_dir: config.agent_dir.clone(),
            mcp_manager: Some(mcp_manager),
            model: Some(agent_model),
            thinking_level: Some(resolve_thinking_level(config, &model)),
            stream_fn: Some(stream_fn),
            tools: builtin_tools(&config.cwd),
            custom_system_prompt: config.system_prompt.clone(),
            prompt_guidelines: config.append_system_prompt.clone(),
            generic_mcp_servers: vec![],
            allow_recursion: None,
            session_manager,
            extra_host_handlers: None,
            conversation_log_path: None,
            additional_skill_paths: config
                .skills
                .iter()
                .map(|path| path.display().to_string())
                .collect(),
            additional_prompt_paths: config
                .prompt_templates
                .iter()
                .map(|path| path.display().to_string())
                .collect(),
            extra_builtin_skill_overrides: vec![],
            rlm_subagent_host: None,
            rlm_depth: None,
            model_info: Some(model.clone()),
            cli_extension_sources: config
                .extensions
                .iter()
                .map(|path| path.display().to_string())
                .collect(),
            extension_tool_allow_list: config.tools.clone(),
            // TS print/headless sessions build through the same
            // `createDefaultRuntimeFactory` runtime (prewarmIpythonKernel:
            // true), so the kernel boots in the background at creation;
            // the engine's depth-0 gate matches the TS session's.
            prewarm_ipython_kernel: Some(true),
            queued_goal_context_purge: None,
            queued_steering_probe: None,
        },
    )
    .await
    .map_err(|error| format!("{error:#}"))?;
    Ok(HeadlessEngine {
        engine,
        model,
        api_key: resolved.api_key,
        provider_target,
    })
}

/// The engine alone (callers that do not drive session commands).
async fn build_headless_engine(
    options: &RunOptions,
    execution_mode: &str,
) -> Result<HeadlessEngine, String> {
    build_headless_engine_parts(options, execution_mode).await
}

/// The session header line: the session file's `type: "session"` entry in
/// the TS wire shape and field order (`getSessionHeader` ->
/// `JSON.stringify`), so a fresh run reports the same identity row the TS
/// json stream leads with.
async fn session_header_json(
    engine: &pa_core::session_engine::engine::SessionEngine,
) -> Option<String> {
    let persistence = engine.session.shared_persistence();
    let session = persistence.lock().await;
    let header = session.get_header()?;
    // The TS field order, optional fields only when present.
    let mut object = serde_json::Map::new();
    let field = |map: &mut serde_json::Map<String, serde_json::Value>,
                 key: &str,
                 value: Option<serde_json::Value>| {
        if let Some(value) = value {
            map.insert(key.to_string(), value);
        }
    };
    field(&mut object, "type", Some(serde_json::json!("session")));
    field(
        &mut object,
        "version",
        header.version.map(serde_json::Value::from),
    );
    field(&mut object, "id", Some(serde_json::json!(header.id)));
    field(
        &mut object,
        "timestamp",
        Some(serde_json::json!(header.timestamp)),
    );
    field(&mut object, "cwd", Some(serde_json::json!(header.cwd)));
    field(
        &mut object,
        "parentSession",
        header
            .parent_session
            .as_ref()
            .map(|parent| serde_json::json!(parent)),
    );
    field(
        &mut object,
        "rlmDepth",
        header.rlm_depth.map(serde_json::Value::from),
    );
    field(
        &mut object,
        "git",
        header
            .git
            .as_ref()
            .map(|git| serde_json::to_value(git).unwrap_or(serde_json::Value::Null)),
    );
    Some(serde_json::Value::Object(object).to_string())
}

fn select_model(
    registry: &mut pa_core::models::ModelRegistry,
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<Model, String> {
    let available: Vec<Model> = registry.get_available().into_iter().cloned().collect();
    let Some(model_name) = model else {
        // No model selection: prefer the registry's featured default.
        let all: Vec<Model> = registry.get_all().to_vec();
        if let Some(default) = pa_core::models::find_preferred_default_model(&available) {
            return Ok(default.clone());
        }
        return all.first().cloned().ok_or_else(|| {
            "No models available. Check your installation or add models to models.json.".to_string()
        });
    };
    let resolved = pa_core::models::resolve_cli_model(provider, model_name, &available);
    if let Some(error) = resolved.error {
        return Err(error);
    }
    resolved
        .model
        .ok_or_else(|| "No matching model found.".to_string())
}

/// Resolve the session thinking level with the sdk.ts `createAgentSession`
/// order: the CLI flag, then the settings default, then "medium" — always
/// clamped to what the model supports.
fn resolve_thinking_level(
    config: &crate::mode::RuntimeConfig,
    model: &Model,
) -> pa_agent::types::ThinkingLevel {
    use pa_types::ai::ModelThinkingLevel;
    let settings = pa_core::settings::SettingsManager::create(&config.cwd, &config.agent_dir);
    let requested = config
        .thinking
        .or_else(|| {
            settings
                .get_default_thinking_level()
                .map(pa_core::settings::ThinkingLevelSetting::model_level)
        })
        // TS `DEFAULT_THINKING_LEVEL`.
        .unwrap_or(ModelThinkingLevel::Medium);
    let clamped = pa_ai::models::clamp_thinking_level(model, requested);
    map_thinking_level(clamped)
}

/// The headless session-manager resolution, mirroring the flag order of
/// TS `createSessionManager` (noSession -> fork -> resume -> continue ->
/// create). `--no-session` never reaches here: the caller passes `None` to
/// the engine, which builds the in-memory manager itself. The opened
/// session's runtime lease returns alongside (a long-lived connection
/// holds it on the engine handle; the one-shot modes forget it for the
/// process lifetime).
fn build_session_manager_with_lease(
    options: &RunOptions,
) -> Result<
    (
        pa_core::session::manager::SessionManager,
        Option<pa_daemon::lease::SessionLease>,
    ),
    String,
> {
    use pa_core::session::manager::SessionManager;
    let cwd = options.config.cwd.clone();
    let session_dir = options
        .session
        .session_dir
        .clone()
        .unwrap_or_else(|| options.config.agent_dir.join("sessions"));
    // TS `createSessionManager`'s fork arm: every resolution shape forks —
    // a GLOBAL session is exactly what --fork is for (a different
    // project's session copied into this cwd) — with no daemon-active
    // guard: the copy writes a fresh file, never the hosted source.
    if let Some(selector) = &options.session.fork {
        let resolved =
            resolve_session_path(selector, &cwd, &session_dir).map_err(render_selector_error)?;
        let source = match resolved {
            ResolvedSession::Path(path)
            | ResolvedSession::Local(path)
            | ResolvedSession::Global { path, .. } => path,
        };
        return Ok((
            SessionManager::fork_from(&source, &cwd, &session_dir)?,
            None,
        ));
    }
    // main.ts `explicitCwdOverride`: with --cwd, the flag's directory wins
    // over the stored session cwd on resume.
    let explicit_cwd_override = options.session.cwd_from_flag.then_some(cwd.as_path());
    if let Some(selector) = &options.session.resume {
        let resolved =
            resolve_session_path(selector, &cwd, &session_dir).map_err(render_selector_error)?;
        return match resolved {
            ResolvedSession::Path(path) | ResolvedSession::Local(path) => {
                let lease = session_open_guard(options.daemon_socket.as_deref(), &path)?;
                // A failed open's early return drops the lease (released),
                // never leaving an orphaned hold behind.
                let manager = open_session_file(&path, &session_dir, &cwd, explicit_cwd_override)?;
                Ok((manager, Some(lease)))
            }
            ResolvedSession::Global {
                path: _,
                cwd: session_cwd,
            } => {
                // Print mode has no fork prompt; mirror the TS non-TTY path.
                Err(format!(
                    "session {selector} belongs to a different project ({}). Pass --fork {selector} to use it here, or run from that project's directory.",
                    session_cwd.display()
                ))
            }
        };
    }
    if options.session.continue_recent {
        let most_recent = find_most_recent_session_for_cwd(&session_dir, &cwd);
        return match most_recent {
            Some(path) => {
                let lease = session_open_guard(options.daemon_socket.as_deref(), &path)?;
                let manager = open_session_file(&path, &session_dir, &cwd, explicit_cwd_override)?;
                Ok((manager, Some(lease)))
            }
            None => Ok((SessionManager::persisted(&cwd, &session_dir), None)),
        };
    }
    Ok((SessionManager::persisted(&cwd, &session_dir), None))
}

/// Open a session file with the TS `SessionManager.open` cwd semantics: an
/// explicit `--cwd` override wins, else the header's cwd, falling back to the
/// process cwd for unreadable or new files. Resumed sessions keep the
/// missing-cwd guard from main.ts.
/// Guard an in-process open of a persisted session file: probe the
/// daemon's live roster (`-c`/`-r` refuse a file a live daemon worker
/// already hosts, `SessionAlreadyActiveError`), then acquire the runtime
/// lease. Returns the HELD lease — the caller owns its lifetime (the
/// one-shot print paths forget it for the process lifetime; a
/// long-lived connection holds it per session and drops it with the
/// engine it guards).
fn session_open_guard(
    socket_path: Option<&str>,
    session_path: &std::path::Path,
) -> Result<pa_daemon::lease::SessionLease, String> {
    let socket = crate::interactive_mode::resolve_socket_path(socket_path);
    if let Ok(mut client) = crate::daemon_client::DaemonClient::connect(&socket) {
        let list = client
            .request(pa_types::daemon::DaemonCommand::List {
                id: None,
                all: None,
                cwd: None,
                session_dir: None,
                include_client_owned: None,
                rest: Default::default(),
            })
            .map_err(|error| format!("Could not check active sessions: {error:#}"))?;
        if list.success {
            let target = pa_daemon::lease::canonical_session_path(session_path);
            for row in list
                .data
                .and_then(|data| data.get("sessions").cloned())
                .and_then(|sessions| sessions.as_array().cloned())
                .unwrap_or_default()
            {
                let Some(file) = row.get("sessionFile").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                if pa_daemon::lease::canonical_session_path(std::path::Path::new(file)) != target {
                    continue;
                }
                let active_session_id = row
                    .get("activeSessionId")
                    .or_else(|| row.get("id"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                // The descriptive refusal (operator-directed): the TS-identical
                // first line, then the holder's identity and the next steps —
                // attach to the live session instead of reopening its file.
                let message = match pa_tui::session_open_error::holder_from_roster(
                    std::slice::from_ref(&row),
                    &target,
                ) {
                    Some(holder) => {
                        pa_tui::session_open_error::already_active_error(&holder, &target)
                    }
                    None => format!(
                        "Session is already active in {active_session_id}: {}",
                        target.display()
                    ),
                };
                return Err(message);
            }
        }
    }
    // The daemon's roster covers only its own sessions; the session store
    // is shared, so the file may instead be held by a live process no
    // roster here names - typically the TypeScript product's daemon or one
    // of its surviving workers, with this Rust daemon running beside it
    // (each product owns its daemon; the store is the shared part). The
    // runtime lease table is the one cross-daemon ownership record the
    // shared agent dir offers, so a live holder refuses the in-process
    // open with the same refusal the daemon's create path answers - a
    // print-mode run over a held file would be a second writer on it.
    let agent_dir = crate::config::get_agent_dir();
    // Acquire, not observe: a probe leaves a window where a daemon worker
    // (or another CLI) acquires the file's runtime lease after the check
    // and before this in-process open - two writers on one file. The
    // acquire is atomic against the shared lease table: a live foreign
    // holder answers with the session-hold refusal, and the returned
    // lease is the caller's to hold (the one-shot print run IS the
    // writer and forgets it for the process lifetime, whose dead pid
    // the liveness probes treat as released).
    match pa_daemon::lease::acquire_runtime_session_lease(session_path, &agent_dir) {
        Ok(lease) => Ok(lease),
        Err(error) => {
            let Some(active) = error.downcast_ref::<pa_daemon::lease::SessionAlreadyActiveError>()
            else {
                // The lease table itself failed (io, permissions): never
                // silently proceed over an undeterminable ownership record.
                return Err(format!(
                    "could not verify the session file is not held: {error:#}"
                ));
            };
            Err(pa_daemon::hold_refusal::refusal_message(
                &pa_daemon::hold_refusal::HoldIdentity {
                    pid: active.holder_pid,
                    active_session_id: active.active_session_id.clone(),
                },
                Some(session_path),
            ))
        }
    }
}

fn open_session_file(
    path: &std::path::Path,
    session_dir: &std::path::Path,
    fallback_cwd: &std::path::Path,
    explicit_cwd_override: Option<&std::path::Path>,
) -> Result<pa_core::session::manager::SessionManager, String> {
    let session_cwd = explicit_cwd_override.map_or_else(
        || {
            let header = pa_core::session::manager::read_session_header(path);
            header.filter(|header| !header.cwd.is_empty()).map_or_else(
                || fallback_cwd.to_path_buf(),
                |header| std::path::PathBuf::from(&header.cwd),
            )
        },
        std::path::Path::to_path_buf,
    );
    let manager = pa_core::session::manager::SessionManager::open(&session_cwd, session_dir, path);
    // main.ts getMissingSessionCwdIssue: a session stored against a deleted
    // directory must not silently continue somewhere else.
    if !manager.get_cwd().exists() {
        let session_file = manager
            .get_session_file()
            .map(|path| format!("\nSession file: {}", path.display()))
            .unwrap_or_default();
        return Err(format!(
            "Stored session working directory does not exist: {}{session_file}\nCurrent working directory: {}",
            manager.get_cwd().display(),
            fallback_cwd.display()
        ));
    }
    Ok(manager)
}

/// Render a selector failure with the main.ts formatting: the error message
/// plus the browse hint.
fn render_selector_error(error: SessionSelectorError) -> String {
    format!(
        "{}.{}\nOpen prime-agent and press left-arrow to browse sessions.",
        error.message(),
        error.suggestion().unwrap_or_default()
    )
}

/// Model tools for the print runtime: `ipython` only (the TS product exposes
/// only the REPL tool to the model; `bash` and `edit` live in the kernel).
/// The engine adds the kernel-backed `ipython` tool itself.
fn builtin_tools(_cwd: &std::path::Path) -> Vec<Arc<dyn pa_agent::types::AgentTool>> {
    Vec::new()
}

/// Admit prompts, stream json events when requested, and decide the exit code
/// from the headless terminal result plus the autonomous gate contract.
/// Shared by the real and faux paths. The turn-boundary compaction checks
/// (the overflow compact-and-retry arm, the requested compaction/refinement
/// consumption, and the threshold arm) run through
/// [`crate::print_boundary::TurnBoundary`] at every prompt's quiescent
/// boundaries. The autonomous continuation loop rides the agent's
/// natural-turn-end hook (the TS in-run shape: continuations churn inside
/// the one prompt wait with no run boundary between them); a held
/// threshold continuation drains through the boundary pair, and a stop
/// surfaces only through the headless exit contract (TS: no row, no
/// stream frame).
async fn run_prompts_and_emit(
    engine: &std::sync::Arc<pa_core::session_engine::engine::SessionEngine>,
    model: &Model,
    api_key: Option<String>,
    options: &RunOptions,
) -> Result<i32, String> {
    let json_mode = options.app_mode == AppMode::Json;
    let mut unsubscribe: Option<pa_agent::agent::Subscription> = None;
    if json_mode {
        if let Some(header) = session_header_json(engine).await {
            println!("{header}");
        }
        unsubscribe = Some(
            engine
                .session
                .agent()
                .subscribe(|event, _signal| {
                    Box::pin(async move {
                        if let Some(json) = agent_event_json(&event) {
                            println!("{json}");
                        }
                        Ok(())
                    })
                })
                .await,
        );
    }
    // The goal continuation surface (the #252 residue): the usage
    // accounting publishes `goal_update` frames, the in-loop hook runs an
    // active goal's continuations inside the same agent run (the TS
    // `getContinuationMessages` seam), and the driver drains the queued
    // turns (the budget-limit steer, the threshold-held continuation) as
    // this invocation's follow-up runs. Wired in every output mode — the
    // loop runs identically in text mode, only silently.
    let goal = std::sync::Arc::new(crate::print_goal::PrintGoalSurface::new(json_mode));
    goal.seed_publish_baseline(engine).await;
    let goal_accounting = goal.wire_accounting(engine, engine.session.agent()).await;
    // The autonomous run (the verifier/eval composition seam): the CLI
    // flags enable it, a no-flag session starts disabled and `/autonomous`
    // rewrites it live. Per-message accounting runs against the one shared
    // state, and the composed in-run continuation hook drives both the
    // CLI-flag run and the flipped session state (TS: the continuation rides
    // the agent loop's natural-turn-end hook, in-run).
    let autonomous = std::sync::Arc::new(match options.config.autonomous.as_ref() {
        Some(config) => HeadlessAutonomous::from_cli(config, &options.config.cwd),
        None => HeadlessAutonomous::disabled(&options.config.cwd),
    });
    let accounting = autonomous.wire_accounting(engine.session.agent()).await;
    // The composed natural-turn-end hook (TS `_getContinuationMessages`):
    // the goal arm first (exclusive priority), the autonomous arm on the
    // fall-through, the boundary gates shared (queued input, a requested
    // compaction, the threshold arm's held continuation).
    crate::print_autonomous::wire_continuation_hook(
        engine,
        engine.session.agent(),
        model,
        &goal,
        &autonomous,
    );
    let global_harness_dir =
        pa_core::refinement::get_global_harness_state_dir(&options.config.agent_dir);
    let mut boundary = crate::print_boundary::TurnBoundary::new(json_mode);
    // The autonomous runtime state the session-command executor mutates —
    // the run's own shared state (the session always carries one, TS
    // `createAgentSession`), so `/autonomous` rewrites the state the hook,
    // the accounting, and the exit contract read.
    let autonomous_state = autonomous.state_handle();
    // A failed session command rejects the prompt wait (TS print-mode's
    // catch): the raw error prints to stderr and the run exits 1 without
    // the later prompts or the terminal selection.
    let mut command_failure: Option<String> = None;
    // The `@file` image attachments ride the initial prompt only (TS
    // `initialImages`); the later CLI messages stay text.
    'prompts: for (prompt, images) in options
        .initial_message
        .iter()
        .map(|prompt| (prompt, options.initial_images.clone()))
        .chain(options.messages.iter().map(|prompt| (prompt, Vec::new())))
    {
        // Session commands (TS `_normalizeSubmission`'s `sessionCommand`
        // arm) never reach the model loop: the pre-turn boundary stays
        // theirs to skip and the prompt's turn never exists.
        if let Some(command) = engine.session.classify_session_command(prompt) {
            let execution = crate::print_session_command::execute_prompt_session_command(
                engine,
                &goal,
                model,
                api_key.clone(),
                global_harness_dir.clone(),
                &autonomous_state,
                &command,
            )
            .await;
            if let Some(error) = execution.error {
                command_failure = Some(error);
                break 'prompts;
            }
            // A `/goal` start (or resume) scheduled its continuation as
            // queued session input: the prompt wait drains it inside the
            // same wait, as the queued turn with its action frames.
            if let Some(continuation) = execution.continuation_message {
                goal.run_session_command_continuation(
                    engine,
                    &mut boundary,
                    model,
                    api_key.clone(),
                    global_harness_dir.clone(),
                    &continuation,
                )
                .await?;
            }
            // The same queue drain a settled turn gets: held continuations
            // and armed steers run as this prompt's follow-up turns.
            goal.drive_boundary(
                engine,
                &mut boundary,
                model,
                api_key.clone(),
                global_harness_dir.clone(),
            )
            .await?;
            continue;
        }
        // The pre-turn boundary (TS `_runPreTurnCompaction`, the full
        // `_checkCompaction` pass): an aborted trailing turn drops pending
        // requests, a stale overflow error from a previous run gets its
        // recovery attempt, and a resumed context above the reserve
        // headroom (or a pending model request) compacts before the
        // admitted prompt runs on the compacted context.
        boundary
            .run_pre_turn(engine, model, api_key.clone())
            .await?;
        engine
            .session
            .prompt_with_images(prompt, images, Default::default())
            .await
            .map_err(|error| format!("{error:#}"))?;
        engine.session.agent().wait_for_idle().await;
        // The settled-turn boundary (TS `agent_end`): the overflow
        // compact-and-retry arm, the turn-boundary requests the kernel
        // scheduled mid-turn (`compact.run` / `refine.run`), and the
        // threshold arm. The outcomes persist in the session entries the
        // terminal result reads.
        boundary
            .run_at_settled_turn(engine, model, api_key.clone(), global_harness_dir.clone())
            .await?;
        // The goal boundary's queue drain: the threshold-held continuation
        // (minted ahead of the boundary's compaction) and the budget-limit
        // steer (armed at the crossing turn's message end) run as this
        // invocation's follow-up turns, each crossing the same boundary
        // pair; a turn that still ends in a terminal error fails an active
        // goal once the arms could not save it (TS
        // `_finishGoalForTerminalAssistantMessage` at `agent_end`, after
        // `_checkCompaction`).
        let goal_owns_boundary = goal
            .drive_boundary(
                engine,
                &mut boundary,
                model,
                api_key.clone(),
                global_harness_dir.clone(),
            )
            .await?;
        // The autonomous arm runs only when the goal does not own the
        // boundary (TS `_getContinuationMessages`: the goal arm takes
        // exclusive priority; autonomous is never consulted while a goal
        // is active).
        if !goal_owns_boundary {
            // The held threshold continuation drains as this invocation's
            // follow-up turn (TS's queued `followUp` admission); its own
            // natural end churns the in-run hook again. The stop surfaces
            // only through the headless exit contract (TS: no row, no
            // stream frame).
            autonomous
                .drive_boundary(
                    engine,
                    &mut boundary,
                    model,
                    api_key.clone(),
                    global_harness_dir.clone(),
                )
                .await
                .map_err(|error| format!("{error:#}"))?;
        }
    }
    goal_accounting.unsubscribe().await;
    accounting.unsubscribe().await;
    if let Some(subscription) = unsubscribe {
        subscription.unsubscribe().await;
    }
    // The rejected prompt wait (TS print-mode's catch): print the raw
    // command error to stderr and exit 1 — no later prompts ran, the
    // terminal selection is skipped, and the disposal drain still runs.
    if let Some(error) = command_failure {
        eprintln!("{error}");
        boundary
            .drain_compact_auto_refine_at_disposal(engine, model, api_key, global_harness_dir)
            .await;
        return Ok(1);
    }
    let state = engine.session.agent().state().await;
    let messages: Vec<pa_types::session::AgentMessage> =
        state.messages.iter().filter_map(json_round_trip).collect();
    let result = pa_core::session_engine::headless::select_headless_terminal_result(&messages);
    // The TS print-mode exit contract (modes/print-mode.ts): json mode
    // never derives the exit code from the terminal selection — the event
    // stream carries everything, and only the autonomous gates (or a thrown
    // error) exit non-zero. Text mode prints the primary message (an error
    // primary to stderr with exit 1, a settled answer to stdout) and the
    // trailing compaction-outcome disclosures to stderr. A run with no
    // terminal message — e.g. an overflow turn dropped by the
    // compact-and-retry recovery whose outcome row is the only surface —
    // prints nothing and leaves the exit code to the outcome rows.
    let mut exit_code = 0;
    if !json_mode {
        if let Some(primary) = result.primary {
            if let Some(stderr) = primary.stderr_text(&mut exit_code) {
                eprintln!("{stderr}");
            }
            if exit_code == 0 {
                if let Some(text) = primary.stdout_text() {
                    println!("{text}");
                }
            }
        }
        for outcome in result.compaction_outcomes {
            eprintln!("{}", outcome.content);
            if outcome.outcome == "failed" {
                exit_code = 1;
            }
        }
    }
    // The TS print-mode autonomous contract applies to both output modes.
    if let Some(stderr) = autonomous.exit_stderr().await {
        eprintln!("{stderr}");
        exit_code = 1;
    }
    // The TS disposal order: print mode returns its exit code first, then
    // the connection teardown disposes the session — which drains a
    // compact-trigger auto-refine that no later boundary consumed (TS
    // `dispose`: "a serialized compaction can finish without another model
    // turn"). The event subscription is already gone at this point, so the
    // round's surface stays off the stream; the durable rows and the
    // harness state persist.
    boundary
        .drain_compact_auto_refine_at_disposal(engine, model, api_key, global_harness_dir)
        .await;
    Ok(exit_code)
}

/// The faux-script engine: identical session assembly, scripted provider.
/// The faux assembly over one session-manager selection (the RPC mode's
/// replacement builds share it under the same script).
async fn build_faux_engine_with(
    options: &RunOptions,
    script: &str,
    session_manager: Option<pa_core::session::manager::SessionManager>,
    // The faux harness installs no product telemetry, so the execution
    // mode label carries through the real path only.
    _execution_mode: &str,
) -> Result<HeadlessEngine, String> {
    let config = &options.config;
    let script: serde_json::Value = serde_json::from_str(script)
        .map_err(|error| format!("invalid PRIME_AGENT_FAUX_SCRIPT: {error}"))?;
    // Response entries: a plain string answers with fixed text;
    // `{"systemPrompt": true}` answers with the request's system prompt
    // (binary-level verification of session assembly; never used by the
    // product); any other object goes through the shared faux-script
    // parser the daemon worker seam uses — `{"text": ...}`,
    // `{"content": [...]}` blocks (thinking, text, tool calls), and the
    // scripted `stopReason`/`errorMessage`/`delayMs` fields the
    // overflow-recovery harnesses script provider error turns with.
    let response_steps: Vec<pa_ai::faux::FauxResponseStep> = script
        .get("responses")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
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
                        if map.get("systemPrompt").and_then(serde_json::Value::as_bool)
                            == Some(true) =>
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
                .collect::<Result<Vec<_>, String>>()
        })
        .ok_or_else(|| "PRIME_AGENT_FAUX_SCRIPT requires a responses array".to_string())??;
    // The same faux-script model contract as the daemon worker seam: a
    // `reasoning` model makes the harness script thinking-capable turns so
    // thinking-level resolution can be verified without the network.
    let reasoning = script
        .get("reasoning")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    // The script pins the context window (the TS faux-extension contract):
    // threshold/overflow verifiers size it to the probe they run.
    let context_window = script
        .get("contextWindow")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(100_000);
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
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
    registration.set_responses(response_steps);
    let model = registration.get_model();
    let agent_model = json_round_trip(&model).ok_or("model conversion failed")?;
    let provider_target = std::sync::Arc::new(std::sync::RwLock::new(Some(ProviderTarget {
        api_key: None,
        model: model.clone(),
        service_tier: None,
        headers: None,
    })));
    let stream_fn = switchable_stream_fn(std::sync::Arc::clone(&provider_target));
    // The faux path shares the session-manager wiring (persist / --no-session
    // / --resume / --continue) with the real provider path so binary-level
    // tests can verify persistence without the network.
    let engine = pa_core::session_engine::engine::create_session(
        pa_core::session_engine::engine::SessionEngineConfig {
            cron_store: None,
            // Faux verification harness: no product telemetry.
            steering_mode: None,
            follow_up_mode: None,
            telemetry: None,
            cwd: config.cwd.clone(),
            agent_dir: config.agent_dir.clone(),
            mcp_manager: None,
            model: Some(agent_model),
            thinking_level: Some(resolve_thinking_level(config, &model)),
            stream_fn: Some(stream_fn),
            tools: builtin_tools(&config.cwd),
            custom_system_prompt: config.system_prompt.clone(),
            prompt_guidelines: config.append_system_prompt.clone(),
            generic_mcp_servers: vec![],
            allow_recursion: None,
            session_manager,
            extra_host_handlers: None,
            conversation_log_path: None,
            additional_skill_paths: vec![],
            additional_prompt_paths: vec![],
            extra_builtin_skill_overrides: vec![],
            rlm_subagent_host: None,
            rlm_depth: None,
            model_info: Some(model.clone()),
            cli_extension_sources: config
                .extensions
                .iter()
                .map(|path| path.display().to_string())
                .collect(),
            extension_tool_allow_list: config.tools.clone(),
            // The faux engine is a Rust-only verification harness, not a
            // product surface: no background kernel boot in tests.
            prewarm_ipython_kernel: None,
            queued_goal_context_purge: None,
            queued_steering_probe: None,
        },
    )
    .await
    .map_err(|error| format!("{error:#}"))?;
    Ok(HeadlessEngine {
        engine,
        model,
        api_key: None,
        provider_target,
    })
}

#[cfg(test)]
mod tests {
    // --- print-mode MCP wiring (TS `createAgentSessionServices` parity) ---

    /// The print session's MCP manager serves a settings-declared server
    /// through the `mcp.config` host request the kernel dispatches
    /// (`rlm/mcp.py` resolution), and resolves its settings LIVE: a
    /// settings rewrite reaches the next `refresh()` — the re-resolver
    /// the remote-catalog change subscription drives mid-session. The
    /// `mcp.config` handler itself keeps the registration-time
    /// integrations (the pa-core handler design, shared with the daemon
    /// worker), so the pre-refresh handler still answers the old roster —
    /// asserted here so the test states the real production behavior.
    #[tokio::test]
    async fn print_mode_mcp_manager_serves_settings_servers_and_resolves_live() {
        let home = tempfile::TempDir::new().unwrap();
        let cwd = home.path().to_path_buf();
        let agent_dir = home.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join("settings.json"),
            serde_json::json!({
                "mcpServers": {
                    "fixture-echo": {
                        "type": "stdio",
                        "command": "python3",
                        "args": ["echo.py"]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let mut manager = crate::mcp_login::cli_mcp_manager(&cwd, &agent_dir);
        assert_eq!(
            manager.get_enabled_persistent_generic_servers(),
            vec!["fixture-echo".to_string()]
        );
        // The kernel's config host request serves the declared server with
        // the declared stdio config (registration-time integrations).
        let mut handlers = pa_core::kernel::shared::HostRequestHandlers::default();
        manager.register_host_handlers(&mut handlers);
        let config = handlers.get("mcp.config").unwrap().clone();
        let result = config(pa_core::kernel::shared::HostRequestPayload {
            data: serde_json::json!({ "server": "fixture-echo" }),
            cell_source_code: None,
        })
        .await
        .unwrap();
        assert_eq!(result["type"], "stdio");
        assert_eq!(result["command"], "python3");
        assert_eq!(result["args"], serde_json::json!(["echo.py"]));
        // A settings rewrite reaches the same manager on the next refresh:
        // the closures re-read settings per resolution.
        std::fs::write(
            agent_dir.join("settings.json"),
            serde_json::json!({
                "mcpServers": {
                    "second-echo": {
                        "type": "stdio",
                        "command": "node",
                        "args": ["echo.mjs"]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        manager.refresh();
        assert_eq!(
            manager.get_enabled_persistent_generic_servers(),
            vec!["second-echo".to_string()]
        );
        // The already-registered handler keeps its registration-time
        // integrations — the registration shape a live session dispatches.
        let result = config(pa_core::kernel::shared::HostRequestPayload {
            data: serde_json::json!({ "server": "fixture-echo" }),
            cell_source_code: None,
        })
        .await
        .unwrap();
        assert_eq!(
            result["command"], "python3",
            "the registered handler serves its registration-time integrations"
        );
        let missing = config(pa_core::kernel::shared::HostRequestPayload {
            data: serde_json::json!({ "server": "second-echo" }),
            cell_source_code: None,
        })
        .await
        .unwrap();
        assert!(
            missing.as_object().unwrap().is_empty(),
            "the pre-refresh handler does not know the new server"
        );
    }

    /// Local service-catalog sources (`mcpCatalogSources`) reach the print
    /// manager's catalog resolution (TS `getCatalogSources`): the declared
    /// file's entry surfaces as a local descriptor, and dropping the
    /// declaration withdraws it on the next resolve — the same live
    /// settings read as the user-server closure.
    #[test]
    fn print_mode_mcp_manager_resolves_declared_catalog_sources() {
        let home = tempfile::TempDir::new().unwrap();
        let agent_dir = home.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let catalog = home.path().join("local-catalog.json");
        std::fs::write(
            &catalog,
            serde_json::json!({
                "version": 1,
                "entries": [{
                    "server": "my-local", "service": "my-local", "label": "My Local",
                    "url": "https://my-local.example/mcp", "aliases": [],
                    "transport": { "type": "http", "url": "https://my-local.example/mcp" },
                    "auth": { "strategy": "oauth", "clientRegistration": "dynamic" },
                    "setup": { "status": "ready" },
                    "verification": { "status": "unverified" },
                    "legacyBuiltin": false,
                    "provenance": [{ "source": "user" }]
                }]
            })
            .to_string(),
        )
        .unwrap();
        let settings = |sources: &[&str]| {
            serde_json::json!({
                "mcpCatalogSources": sources
                    .iter()
                    .map(std::string::ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .to_string()
        };
        std::fs::write(
            agent_dir.join("settings.json"),
            settings(&[&catalog.display().to_string()]),
        )
        .unwrap();
        let mut manager = crate::mcp_login::cli_mcp_manager(home.path(), &agent_dir);
        let my_local = manager
            .service_descriptors()
            .iter()
            .find(|service| service.service_id == "my-local")
            .expect("declared source entry resolved");
        assert!(my_local.local_source);
        // Live: dropping the declaration withdraws the entry on refresh.
        std::fs::write(agent_dir.join("settings.json"), settings(&[])).unwrap();
        manager.refresh();
        assert!(
            !manager
                .service_descriptors()
                .iter()
                .any(|service| service.service_id == "my-local"),
            "the dropped source no longer resolves"
        );
    }
}
