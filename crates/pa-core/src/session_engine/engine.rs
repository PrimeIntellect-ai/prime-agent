//! `SessionEngine` assembly: build a running agent session from a config.
//! This is the facade pa-cli/pa-daemon call — the Rust equivalent of the
//! `createAgentSession` wiring: resources, prompt, model, tools, loop, and
//! persistence. The session subscribes persistence listeners on the caller's
//! reactor, so `create_session` is async.

use std::path::PathBuf;
use std::sync::Arc;

use pa_agent::agent::{Agent, AgentInitialState, AgentOptions};
use pa_agent::stream::StreamFn;
use pa_agent::types::{Model, ThinkingLevel};

use crate::resources::{load_resources, ResourceLoaderOptions};
use crate::session::manager::SessionManager;
use crate::skills::PromptTemplate;

use super::{AgentSession, PromptOptions, PromptOutcome};

/// Everything needed to assemble a session.
#[derive(Default)]
pub struct SessionEngineConfig {
    pub cwd: PathBuf,
    pub agent_dir: PathBuf,
    /// Resolved model (registry output).
    pub model: Option<Model>,
    /// Thinking level for the session.
    pub thinking_level: Option<ThinkingLevel>,
    /// Provider seam for the loop (required; wire a real provider here).
    pub stream_fn: Option<StreamFn>,
    /// Pre-bridged loop tools (bash/edit/ipython).
    pub tools: Vec<Arc<dyn pa_agent::types::AgentTool>>,
    /// Override the default system prompt.
    pub custom_system_prompt: Option<String>,
    /// Prompt guideline bullets.
    pub prompt_guidelines: Vec<String>,
    /// Enabled generic MCP server names.
    pub generic_mcp_servers: Vec<String>,
    /// Suppress the rlm recursion guidance.
    pub allow_recursion: Option<bool>,
    /// Session persistence (in-memory when None).
    pub session_manager: Option<SessionManager>,
    /// Extra kernel host-request handlers (e.g. the daemon's message/observe
    /// bridges), merged over the built-in goal/heartbeat registrations.
    pub extra_host_handlers: Option<crate::kernel::shared::HostRequestHandlers>,
    /// Conversation-log path for the system prompt when the caller owns
    /// persistence outside the session manager (the daemon worker mirrors
    /// entries into its own session file).
    pub conversation_log_path: Option<PathBuf>,
    /// Extra skill paths.
    pub additional_skill_paths: Vec<String>,
    /// Extra prompt-template paths.
    pub additional_prompt_paths: Vec<String>,
    /// Force-exclude patterns for built-in skills (e.g. unauthenticated
    /// integrations); the MCP manager seam.
    pub extra_builtin_skill_overrides: Vec<String>,
    /// Daemon child-session host backing the `rlm.*` recursion surface.
    pub rlm_subagent_host: Option<Arc<dyn super::rlm_host::RlmSubagentHost>>,
    /// The session's depth in the RLM recursion tree (0 for top-level
    /// sessions). Gates the `refine.*` host requests, like the TS
    /// `_autoRefineAllowedForSession` depth check.
    pub rlm_depth: Option<u32>,
    /// The full registry model (input modalities for `model.info`); the
    /// engine derives minimal facts from `model` when absent.
    pub model_info: Option<pa_types::ai::Model>,
    /// Session telemetry wiring (the telemetry client + execution mode). `None`
    /// (opt-out) installs nothing; non-depth-0 sessions never install.
    pub telemetry: Option<super::telemetry::TelemetryWiring>,
    /// The embedding's queued-goal-context purge (TS
    /// `_clearQueuedGoalContexts`, invoked at the pause/clear/start command
    /// sites and after a kernel `goal.complete` settles the goal): the
    /// daemon worker's queue purge.
    pub queued_goal_context_purge: Option<super::runtime::QueuedGoalContextPurge>,
    /// TS `_steeringStopPending` (the session's `shouldStopAfterTurn`/
    /// `shouldStopBeforeTurn` hooks): `true` while steering-lane session
    /// actions are queued or mid-selection, so the running turn stops at
    /// the next turn boundary and the queued steer delivers as the next
    /// input (TS agent-session.ts's `_steeringStopPending`; the follow-up
    /// lane never stops the run — `when_run_idle` waits for the settle).
    pub queued_steering_probe: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
    /// The session's queue delivery modes (TS `sdk.ts` passes
    /// `settingsManager.getSteeringMode()`/`getFollowUpMode()` into the
    /// Agent): the agent's steering/follow-up queues drain per the mode
    /// at the loop boundary. `None` keeps the TS default
    /// ("one-at-a-time").
    pub steering_mode: Option<pa_agent::agent::QueueMode>,
    pub follow_up_mode: Option<pa_agent::agent::QueueMode>,
    /// Boot the session's kernel in the background at creation (TS
    /// `prewarmIpythonKernel` from `createDefaultRuntimeFactory`): a main
    /// session (depth 0, the engine's gate like the TS `rlmDepth === 0`
    /// check) whose `ipython` tool is active starts its kernel without
    /// waiting for the first tool call. Boot failures are swallowed (they
    /// surface on the next `ensure()`), and the lazy first-call start
    /// stays intact.
    pub prewarm_ipython_kernel: Option<bool>,
    /// Fires when the session kernel's last live background `bash()`
    /// handle settles (its activity track empties or the kernel tears
    /// down): TS `AgentSession` wires its owed-continuation resume pair
    /// here. `None` (embeddings without continuations) installs nothing.
    pub on_background_work_settled: Option<crate::kernel::shared::BackgroundWorkSettledCallback>,
    /// An externally owned MCP manager (the daemon worker's session store):
    /// the engine adopts it instead of building its own, so ACP-admitted
    /// servers reach the prompt's MCP gating through the same store the
    /// `replace_acp_mcp_servers` command writes.
    pub mcp_manager: Option<std::sync::Arc<std::sync::Mutex<crate::mcp::McpManager>>>,
    /// The embedding's kernel cron wiring (the daemon worker's
    /// scheduled-jobs store plus its session identity): the kernel's
    /// `rlm_heartbeat.*` host requests write and read that store instead
    /// of the engine-private `cron-jobs.json`, binding the embedding's
    /// live/durable session identity, so agent-created heartbeats reach
    /// the same catalog the daemon's `heartbeats_list` reads and the
    /// scheduler fires (TS daemon-mode wires
    /// `AgentCronJobStore.forSessionArtifacts()` into both).
    pub cron_store: Option<super::runtime_wiring::KernelCronWiring>,
    /// The image-model routing host seam (TS agent-session's settings +
    /// registry reads at dispatch): the headless surfaces install theirs;
    /// the daemon worker stays `None` because its turn dispatch owns
    /// routing (its queued lanes re-dispatch every batch).
    pub image_model_router: Option<super::image_model_routing::ImageModelRouter>,
    /// The session's semantic-edge identity (TS
    /// `semanticEdgeLedgerPath` + `semanticParentSessionId` +
    /// `semanticSpawnedByRequestId`): the recorder's ledger location and
    /// spawn provenance. `None` keeps the session off the ledger (no
    /// request ids on the wire).
    pub semantic_edges: Option<super::semantic_edges::SemanticEdgeIdentity>,
}

/// An assembled, running session.
pub struct SessionEngine {
    pub session: AgentSession,
    pub skills: Vec<crate::skills::Skill>,
    /// Skill-loading diagnostics (TS `getSkills().diagnostics`; the
    /// connection resource snapshot surfaces them).
    pub skill_diagnostics: Vec<crate::skills::ResourceDiagnostic>,
    pub prompt_templates: Vec<PromptTemplate>,
    pub agents_files: Vec<crate::resources::ContextFile>,
    pub system_prompt: String,
    /// The session's goal driver: the same instance the kernel `goal.*`
    /// host handlers reach, so `/goal` and `goal.complete()` in the kernel
    /// observe one state machine.
    pub goal_driver: std::sync::Arc<tokio::sync::Mutex<super::goal_driver::GoalDriver>>,
    /// The embedding's queued-goal-context purge (TS
    /// `_clearQueuedGoalContexts`): the session-command surfaces
    /// (`/goal` pause/clear/start) and the kernel's `goal.complete`
    /// withdraw queued goal-context turns through it. `None` when the
    /// embedding owns no queue (the in-session engines).
    pub queued_goal_context_purge: Option<super::runtime::QueuedGoalContextPurge>,
    /// The session's MCP manager: host-side auth gating and the source the
    /// `mcp.*` kernel host handlers (config/refresh) resolve against. The
    /// daemon's `replace_acp_mcp_servers` wire command reaches it through
    /// this field (shared handle: the daemon worker and the engine gate
    /// prompts through one store).
    pub mcp_manager: std::sync::Arc<std::sync::Mutex<crate::mcp::McpManager>>,
    /// The turn-boundary request surface (`compact.*`/`refine.*`/
    /// `model.info` host requests and the pending requests the turn loop
    /// consumes after a settled turn).
    pub turn_boundary: std::sync::Arc<super::turn_boundary::TurnBoundaryRequests>,
    /// Installed session telemetry (agent-event subscriber). `None` when
    /// telemetry is disabled or the session is not depth 0.
    pub telemetry: Option<std::sync::Arc<super::telemetry::SessionTelemetry>>,
    /// The RLM child-usage attribution producer: the kernel `rlm.spawn`
    /// handler registers spawn targets into it, and the embedding wires
    /// the child-observation sink (the daemon children registry) onto it
    /// after the build.
    pub rlm_usage: std::sync::Arc<super::rlm_usage::RlmChildUsageAttributions>,
    /// The factory host bridge (`/factory` view lane): the daemon/TUI
    /// request surface over the kernel's factory runs, built from the
    /// session facts captured in `create_session` (the #3184 capture
    /// pattern) and reached through [`SessionEngine::factory_activity`].
    pub factory_host: super::factory_host::FactoryHost,
    /// The session's kernel provisioner. The engine is the STRONG owner on
    /// purpose: the `ipython` tool on the agent and the compaction
    /// kernel-state probe on the session hold weak references, because the
    /// kernel's host handlers reach back into the session (goal state,
    /// turn-boundary requests) — a strong edge anywhere on that return path
    /// loops the graph and keeps a dropped session's kernel process alive
    /// until the process exits.
    pub(crate) provisioner: std::sync::Arc<crate::kernel::provisioner::IpythonKernelProvisioner>,
}

/// Resolve the MCP gating the resource loader and prompt need: skill
/// overrides for built-in integrations the user is not logged into, plus the
/// enabled persistent generic servers (prompt `mcp` guidance).
async fn mcp_gating(
    settings: &crate::settings::SettingsManager,
    agent_dir: std::path::PathBuf,
) -> anyhow::Result<(Vec<String>, Vec<String>, crate::mcp::McpManager)> {
    let user_servers = settings
        .settings()
        .mcp_servers
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(server, config)| {
            serde_json::from_value(config)
                .ok()
                .map(|parsed| (server, parsed))
        })
        .collect::<std::collections::HashMap<String, crate::mcp::McpServerConfig>>();
    // The MCP manager snapshots auth with a blocking lock; run it off the
    // async runtime (session construction is async). The manager stays
    // alive on the session: it is the source for the `mcp.*` host
    // requests the kernel sends while serving generic MCP servers.
    tokio::task::spawn_blocking(move || mcp_gating_blocking(user_servers, &agent_dir))
        .await
        .map_err(|error| anyhow::anyhow!("MCP gating task failed: {error}"))
}

fn mcp_gating_blocking(
    user_servers: std::collections::HashMap<String, crate::mcp::McpServerConfig>,
    agent_dir: &std::path::Path,
) -> (Vec<String>, Vec<String>, crate::mcp::McpManager) {
    crate::mcp::McpManager::prompt_gating(user_servers, agent_dir)
}

/// Assemble a session: load resources, build the system prompt, and start the
/// loop with persistence wiring.
///
/// # Errors
///
/// Returns an error when the MCP gating task fails, when the session
/// resources cannot be resolved or loaded, or when the runtime bootstrap
/// fails.
///
/// # Panics
///
/// Panics if the MCP manager mutex is poisoned while wiring telemetry
/// reporting.
pub async fn create_session(mut config: SessionEngineConfig) -> anyhow::Result<SessionEngine> {
    let cwd = config.cwd.clone();
    // Session persistence first: the conversation-log path and the resume
    // context both come from the session manager (TS `_rebuildSystemPrompt`
    // reads `sessionManager.getSessionFile()`).
    let session_manager = config
        .session_manager
        .unwrap_or_else(|| SessionManager::in_memory(&cwd));
    let conversation_log = {
        let session = &session_manager;
        session
            .get_session_file()
            .map(|path| path.display().to_string())
            .or_else(|| {
                config
                    .conversation_log_path
                    .as_ref()
                    .map(|path| path.display().to_string())
            })
    };
    let wiring = super::runtime_wiring::wire_session_runtime(
        session_manager,
        &config.agent_dir,
        super::runtime_wiring::RlmWiring {
            model_registry: None,
            subagent_host: config.rlm_subagent_host.clone(),
        },
        config.queued_goal_context_purge.clone(),
        config.cron_store.clone(),
    );

    let settings = crate::settings::SettingsManager::create(&cwd, &config.agent_dir);
    let service_tier_preference = settings.get_default_service_tier();
    // Captured before `settings` moves into the resource loader: the
    // compaction scheduling budget (`compact.run` prepare check) and the
    // auto-refine gates (TS `getAutoRefineSettings`).
    let compaction_settings = settings.settings().compaction.clone().unwrap_or_default();
    let auto_refine_gates =
        super::refine::AutoRefineGates::from_settings(settings.settings().auto_refine.as_ref());
    // Request timing (TS #2462): the settings half of the flag is read once
    // here — `settings` moves into the resource loader below and its merged
    // snapshot is fixed for the session anyway — while the `PI_REQUEST_TIMING`
    // env half stays live inside the wrappers' per-request check.
    let request_timing_settings = settings.get_request_timing();
    // Captured before `settings` moves into the resource loader: the
    // factory host bridge's preflight facts (the daemon `allowedModels`
    // pin), like the request-timing snapshot above.
    let factory_allowed_models = settings.get_allowed_models();
    let (mcp_skill_overrides, mcp_generic_servers, built_manager) =
        mcp_gating(&settings, config.agent_dir.clone()).await?;
    let mcp_manager = config
        .mcp_manager
        .take()
        .unwrap_or_else(|| std::sync::Arc::new(std::sync::Mutex::new(built_manager)));
    let mut extra_builtin_skill_overrides = config.extra_builtin_skill_overrides.clone();
    extra_builtin_skill_overrides.extend(mcp_skill_overrides);
    let mut generic_mcp_servers = config.generic_mcp_servers.clone();
    for server in mcp_generic_servers {
        if !generic_mcp_servers.contains(&server) {
            generic_mcp_servers.push(server);
        }
    }
    let resources = load_resources(ResourceLoaderOptions {
        cwd: cwd.clone(),
        agent_dir: config.agent_dir.clone(),
        settings: Some(settings),
        extra_builtin_skill_overrides,
        additional_skill_paths: config.additional_skill_paths.clone(),
        additional_prompt_paths: config.additional_prompt_paths.clone(),
        no_skills: false,
        no_prompt_templates: false,
        no_context_files: false,
        system_prompt: config.custom_system_prompt.clone(),
        append_system_prompt: Vec::new(),
        ..Default::default()
    })?;

    let model = config
        .model
        .ok_or_else(|| anyhow::anyhow!("a resolved model is required"))?;
    let stream_fn = config
        .stream_fn
        .ok_or_else(|| anyhow::anyhow!("a provider stream_fn is required"))?;
    // `model.info` facts, captured before the model moves into the loop.
    let model_info = match config.model_info.clone() {
        Some(full) => super::turn_boundary::ModelInfo {
            id: full.id,
            provider: full.provider,
            input: full.input,
        },
        None => super::turn_boundary::ModelInfo {
            id: model.id.clone(),
            provider: model.provider.clone(),
            input: Vec::new(),
        },
    };
    // The context window the usage estimate and status rows read.
    let model_context_window = model.context_window;

    // The runtime wiring: goal/rlm-heartbeat host handlers ride the kernel
    // provisioner, and the agent gains the `ipython` tool backed by that
    // kernel (unless the caller supplied one).
    let python_skills = super::runtime_wiring::kernel_python_skills(&resources.skills);
    let session_id = wiring.session.lock().await.get_session_id().to_string();
    let mut handlers = wiring.handlers.clone();
    if let Some(extra) = config.extra_host_handlers.clone() {
        handlers.merge(extra);
    }
    // Per-session counters (MCP connector use, kernel boots, skills, RLM
    // child usage, feature outcomes) ride `agent session ended`; the seams
    // below count into them instead of emitting their own events.
    let session_counters = std::sync::Arc::new(super::telemetry::SessionCounters::default());
    // The counters gate from the very creation: the MCP and kernel setup
    // below starts counting (prewarm boots, connector use) long before
    // the first turn installs the session telemetry, so an off switch
    // must already be live — otherwise the pre-install window records
    // what a later enable would send.
    if let Some(telemetry_switch) = config
        .telemetry
        .as_ref()
        .and_then(|telemetry| telemetry.telemetry_enabled.as_ref())
    {
        session_counters.set_telemetry_enabled(telemetry_switch.enabled.clone());
    }
    // The `mcp.*` host requests (config/refresh/begin_login) the kernel's
    // generic MCP registry sends while listing or calling generic servers.
    // Telemetry counts connector use (never the server name) when the
    // session is telemetry-enabled; set before the handlers register so
    // their closures capture the reporter.
    if config.telemetry.is_some() {
        let counters = std::sync::Arc::clone(&session_counters);
        mcp_manager
            .lock()
            .unwrap()
            .set_usage_report(Some(std::sync::Arc::new(move |_action, _server| {
                counters.note_mcp_connector_use();
            })));
    }
    // The `mcp.*` host-request registration takes the shared manager: the
    // inventory handlers (list_plugins/search_plugins/list_connections)
    // serve live views per request.
    crate::mcp::McpManager::register_host_handlers(&mcp_manager, &mut handlers);
    // The turn-boundary surface: `model.info` always; `compact.*` behind
    // the compaction `agentCallable` setting; `refine.*` behind the TS
    // `_autoRefineAllowedForSession` gate (depth 0 with a local harness
    // state dir, i.e. exactly the sessions the refine skill targets).
    let turn_boundary = Arc::new(super::turn_boundary::TurnBoundaryRequests::new());
    turn_boundary.register_model_info_handler(&mut handlers, model_info.clone());
    let keep_recent_tokens = compaction_settings
        .keep_recent_tokens
        .unwrap_or(super::compaction::DEFAULT_KEEP_RECENT_TOKENS);
    if compaction_settings.agent_callable.unwrap_or(true) {
        turn_boundary.register_compact_handlers(&mut handlers, keep_recent_tokens);
    }
    // The session's artifact dir (TS `getSessionArtifactDir`; the daemon
    // worker owns persistence outside the session manager, so its
    // conversation-log path implies the same tree). One resolution feeds
    // the harness digest below and the kernel snapshot wiring.
    let session_artifact_dir: Option<PathBuf> = wiring
        .session
        .lock()
        .await
        .get_session_artifact_dir()
        .or_else(|| {
            config
                .conversation_log_path
                .as_deref()
                .and_then(super::harness_digest::session_artifact_dir_for_log)
        });
    let local_harness_dir =
        crate::refinement::get_local_harness_state_dir(session_artifact_dir.as_deref());
    // The refine surface gate (TS `_autoRefineAllowedForSession`): depth 0
    // with a local harness state dir — the sessions whose `refine.*` host
    // requests register, and the only sessions the compact-trigger
    // auto-refine may run for.
    let auto_refine_allowed = config.rlm_depth.unwrap_or(0) == 0 && local_harness_dir.is_some();
    if auto_refine_allowed {
        turn_boundary.register_refine_handlers(&mut handlers);
    }
    // Kernel boots (duration, cold/revived, outcome) count into the
    // session counters.
    let on_bootstrap_result = config.telemetry.as_ref().map(|_| {
        let counters = std::sync::Arc::clone(&session_counters);
        std::sync::Arc::new(
            move |stats: crate::kernel::provisioner::KernelBootstrapStats| {
                counters.note_kernel_bootstrap(
                    stats.cold,
                    matches!(
                        stats.outcome,
                        crate::kernel::provisioner::KernelBootstrapOutcome::Ready
                    ),
                    stats.duration_ms,
                );
            },
        ) as crate::kernel::provisioner::KernelBootstrapResultHandler
    });
    // Kernel namespace snapshots (TS `_ipythonKernelSnapshotDir`): the
    // provisioner saves the Python namespace to the session's artifact
    // dir (a debounced flush after successful executions plus a final
    // flush on dispose) and revives it on the next boot of the same
    // session, so a resumed session continues where it left off. The
    // `hasSnapshot` probe (TS `existsSync(snapshotPathIn(dir))`) drives
    // the resume prewarm below.
    let has_snapshot = session_artifact_dir
        .as_ref()
        .is_some_and(|dir| crate::kernel::state_snapshot::snapshot_path_in(dir).exists());
    // The boot-notice mailbox (TS `deliverAs: "nextTurn"`): a boot's
    // `onRestore`/`onUnavailableSkills` fires from a background task that
    // can settle before the AgentSession exists (the resume prewarm starts
    // at build), so the rows park in a mailbox the session adopts once
    // constructed and shares afterwards.
    let boot_notice_rows = std::sync::Arc::new(std::sync::Mutex::new(Vec::<
        pa_types::session::CustomMessage,
    >::new()));
    let on_restore = {
        let boot_notice_rows = std::sync::Arc::clone(&boot_notice_rows);
        Some(std::sync::Arc::new(
            move |result: &crate::kernel::state_snapshot::RestoreResult| {
                // TS `_onIpythonStateRestored`: the notice only fires
                // for a genuine revive (the provisioner suppresses the
                // callback when no snapshot existed), and it rides the
                // next admitted turn ahead of its prompt.
                let row = super::state_restore_notice::notice_message(result);
                boot_notice_rows
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(row);
            },
        ) as crate::kernel::provisioner::RestoreCallback)
    };
    let on_unavailable_skills = {
        let boot_notice_rows = std::sync::Arc::clone(&boot_notice_rows);
        Some(std::sync::Arc::new(
            move |errors: &crate::kernel::bootstrap::UnavailablePythonSkills| {
                // TS `_onPythonSkillsUnavailable` (PR #2381): the broken
                // skills and their import errors ride the next admitted
                // turn, so the model learns before its first call
                // instead of from the placeholder's error.
                let row = super::skills_unavailable_notice::notice_message(errors);
                boot_notice_rows
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(row);
            },
        )
            as crate::kernel::provisioner::UnavailableSkillsCallback)
    };
    let provisioner = super::runtime_wiring::kernel_provisioner(
        session_id,
        handlers,
        python_skills,
        cwd.clone(),
        &config.agent_dir,
        session_artifact_dir,
        on_restore,
        config.on_background_work_settled.clone(),
        on_unavailable_skills,
        on_bootstrap_result,
    );
    let mut tools = config.tools.clone();
    if !tools.iter().any(|tool| tool.name() == "ipython") {
        let definition = crate::tools::ipython::create_ipython_tool_definition(
            &cwd.to_string_lossy(),
            super::runtime_wiring::ipython_tool_options(provisioner.clone()),
        );
        tools.push(Arc::new(
            crate::session_engine::tool_bridge::ToolDefinitionBridge::new(definition),
        ));
    }
    let active_tool_names: Vec<String> = tools.iter().map(|tool| tool.name().to_string()).collect();

    // The TS prewarm (agent-session.ts `_buildRuntime`, behind
    // `createDefaultRuntimeFactory`'s `prewarmIpythonKernel: true`): a main
    // session (depth 0 — the session gate TS applies at
    // `this._prewarmIpythonKernel = config.prewarmIpythonKernel && rlmDepth
    // === 0`) boots its kernel in the background once the tool registry
    // shows `ipython` active. The TS `hasSnapshot` arm ORs in: a resumed
    // session whose artifact dir carries a kernel snapshot prewarms even
    // when the config flag is off (and at any depth — only the config
    // operand is depth-gated), so its namespace revives before the first
    // turn and the `ipython_state_restored` notice lands ahead of it.
    // Failures are swallowed there and surface on the next `ensure()`, and
    // an already-started kernel short-circuits it, so the lazy first-call
    // start stays the fallback.
    let prewarm_configured =
        config.prewarm_ipython_kernel.unwrap_or(false) && config.rlm_depth.unwrap_or(0) == 0;
    if (prewarm_configured || has_snapshot)
        && active_tool_names.iter().any(|name| name == "ipython")
    {
        provisioner.prewarm();
    }

    let prompt_guidelines = config.prompt_guidelines.clone();

    // The per-model prompt layer keys on the resolved `provider/id`
    // selector; vision capability gates the image-input line. Both are
    // captured before `model_info` moves into the turn-boundary handler.
    let prompt_model_selector = Some(format!("{}/{}", model_info.provider, model_info.id));
    let prompt_vision_capable = Some(model_info.input.contains(&pa_types::ai::ModelInput::Image));
    let system_prompt = crate::prompts::system_prompt::build_system_prompt(
        &crate::prompts::system_prompt::BuildSystemPromptOptions {
            custom_prompt: resources.system_prompt.clone(),
            model: prompt_model_selector.as_deref(),
            vision_capable: prompt_vision_capable,
            cwd: cwd.display().to_string(),
            messages_path: conversation_log.clone(),
            context_files: resources
                .agents_files
                .iter()
                .map(|file| (file.path.display().to_string(), file.content.clone()))
                .collect(),
            skills: resources.skills.clone(),
            selected_tools: Some(
                active_tool_names
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            ),
            allow_recursion: config.allow_recursion,
            // The session's recursion depth rides the dynamic tail's
            // session-role section: a spawned child's prompt must read
            // "depth: N (not root)" with the child-agent reply doctrine,
            // never the root identity.
            rlm_depth: config.rlm_depth,
            generic_mcp_servers,
            prompt_guidelines: Some(prompt_guidelines),
            ..Default::default()
        },
    );

    // Captured before the digest context moves the local harness dir and
    // the loop wiring moves the session model: the factory host bridge's
    // config (the #3184 capture pattern).
    let factory_local_harness_dir = local_harness_dir.clone();
    let factory_session_model = Some(model.clone());
    // Harness digest inputs: global state from the agent dir, local state
    // from the session artifacts (or the daemon-owned conversation log), and
    // the interfaces the digest may reference.
    let digest_context = super::harness_digest::HarnessDigestContext {
        global_dir: crate::refinement::get_global_harness_state_dir(&config.agent_dir),
        local_dir: local_harness_dir,
        include_ipython: active_tool_names.iter().any(|name| name == "ipython"),
        include_shell_examples: active_tool_names.iter().any(|name| name == "bash"),
        include_refine: resources.skills.iter().any(|skill| {
            !skill.disable_model_invocation
                && skill.name == crate::prompts::system_prompt::REFINE_SKILL_NAME
        }),
    };
    // sdk.ts `createAgentSession` parity: a session manager that already
    // holds messages is a resume — the loop starts from the persisted
    // context. Fresh sessions record the creation prefix (model_change +
    // thinking_level_change + service_tier_change); resumed sessions record
    // the thinking level and service tier only when no earlier entry set
    // them.
    let (existing_messages, has_thinking_entry, has_service_tier_entry) = {
        let session = wiring.session.lock().await;
        let messages = super::compact_session::rebuilt_context_after_compaction(&session);
        let has_thinking_entry = session.has_thinking_level();
        let has_service_tier_entry = session.has_service_tier();
        (messages, has_thinking_entry, has_service_tier_entry)
    };
    let thinking_level = config.thinking_level.unwrap_or(ThinkingLevel::Off);
    {
        let mut session = wiring.session.lock().await;
        if existing_messages.is_empty() {
            session.append_model_change(&model.provider, &model.id)?;
            session.append_thinking_level_change(&format!("{thinking_level:?}").to_lowercase())?;
        } else if !has_thinking_entry {
            session.append_thinking_level_change(&format!("{thinking_level:?}").to_lowercase())?;
        }
        if existing_messages.is_empty() || !has_service_tier_entry {
            session.append_service_tier_change(Some(service_tier_preference))?;
        }
    }
    // The loop consumes agent-side messages; session entries cross through
    // the shared wire shape (same conversion the compaction rebuild uses).
    let initial_messages = if existing_messages.is_empty() {
        None
    } else {
        Some(
            existing_messages
                .into_iter()
                .filter_map(|message| {
                    let value = serde_json::to_value(&message).ok()?;
                    serde_json::from_value(value).ok()
                })
                .collect(),
        )
    };

    // Request timing (TS #2462, `sdk.ts` `requestTimingEnabled` + the
    // instrumented seams): one wiring per session owns the flag probe, the
    // JSONL log, and the prompt-build correlation state. The wrappers pass
    // straight through while the flag is off — no timestamps, no payload
    // serialization, no entries.
    let request_timing_wiring = std::sync::Arc::new(
        super::request_timing::RequestTimingWiring::new(
            std::sync::Arc::new(move || {
                super::request_timing::is_request_timing_enabled(request_timing_settings)
            }),
            super::request_timing::RequestTimingLog::new(&config.agent_dir),
        )
        // The outbound body capture rides the same flag: while request
        // timing is on, every session — the daemon workers' included,
        // this is the one build path they all share — records each
        // request's final outbound body.
        .with_payload_capture(super::request_timing::RequestPayloadCapture::new(
            &config.agent_dir,
        )),
    );
    // Semantic edges (TS `semantic-edges.ts`): the recorder opens this
    // session's request-id ledger, and its stream wrapper goes OUTERMOST
    // over the timing-instrumented fn (TS `sdk.ts` instruments first, the
    // `AgentSession` constructor wraps semantic edges over it). The side
    // question keeps the pre-semantic fn, so its calls carry no id.
    let timing_stream_fn = super::request_timing::instrument_stream_fn(
        std::sync::Arc::clone(&request_timing_wiring),
        stream_fn,
    );
    let side_question_stream_fn = std::sync::Arc::clone(&timing_stream_fn);
    let semantic_recorder = config.semantic_edges.take().map(|identity| {
        std::sync::Arc::new(super::semantic_edges::SemanticEdgeRecorder::open(identity))
    });
    let agent_stream_fn = match &semantic_recorder {
        Some(recorder) => {
            super::semantic_edges::wrap_stream_fn(std::sync::Arc::clone(recorder), timing_stream_fn)
        }
        None => timing_stream_fn,
    };
    let agent = Agent::new(AgentOptions {
        initial_state: AgentInitialState {
            system_prompt: Some(system_prompt.clone()),
            model: Some(model),
            thinking_level: Some(thinking_level),
            tools: Some(tools),
            messages: initial_messages,
        },
        stream_fn: Some(agent_stream_fn),
        // The session conversion rules apply at the loop's LLM boundary
        // (TS `convertToLlm`): bookkeeping custom rows drop, everything
        // else (the harness digest included) becomes a user turn.
        convert_to_llm: Some(super::request_timing::instrument_convert_to_llm(
            std::sync::Arc::clone(&request_timing_wiring),
            super::messages::engine_convert_to_llm(),
        )),
        // TS wires the instrumented `transformContext` seam over the
        // session context transform; the Rust engine wires no transform,
        // so the instrumented seam wraps a pass-through that exists
        // to mark the turn's dispatch moment. Always wired like TS — the
        // wrapper's own per-request check keeps the disabled path free of
        // timestamps and entries, and a flag flipped on mid-session still
        // gets its dispatch timestamp.
        transform_context: Some(super::request_timing::instrument_transform_context(
            std::sync::Arc::clone(&request_timing_wiring),
            super::request_timing::pass_through_transform(),
        )),
        // TS `_steeringStopPending`: both the after-turn and the
        // before-turn hooks consult the same probe (a queued steer stops
        // the run at the boundary; the pump delivers it next).
        should_stop_after_turn: config.queued_steering_probe.take().map(|probe| {
            let probe: pa_agent::agent_loop::ShouldStopAfterTurnFn =
                std::sync::Arc::new(move |_context| {
                    let probe = std::sync::Arc::clone(&probe);
                    Box::pin(async move { Ok(probe()) })
                });
            probe
        }),
        should_stop_before_turn: config.queued_steering_probe.clone(),
        // TS `sdk.ts`: the Agent's steering/follow-up queues drain per
        // the session's configured modes (default "one-at-a-time").
        steering_mode: config.steering_mode,
        follow_up_mode: config.follow_up_mode,
        ..Default::default()
    });

    let agent = Arc::new(agent);
    // TS `_startRlmChildRun`'s spawn anchor: the `rlm.spawn` host handler
    // names the parent's in-flight turn through this weak seam (the
    // bridge is built before the agent exists, and a strong edge would
    // cycle the bridge -> agent -> kernel -> bridge graph).
    if let Some(recorder) = &semantic_recorder {
        let _ = wiring
            .rlm
            .semantic_spawn
            .set(super::rlm_host::SemanticSpawnAnchor {
                agent: Arc::downgrade(&agent),
                recorder: std::sync::Arc::clone(recorder),
            });
    }
    let telemetry_agent = std::sync::Arc::clone(&agent);
    let mut session = AgentSession::from_session_arc(
        agent.clone(),
        wiring.session.clone(),
        resources.prompts.clone(),
        Some(digest_context),
    )
    .await?;
    session.set_auto_refine(auto_refine_allowed, auto_refine_gates);
    session.set_agent_dir(config.agent_dir.clone());
    // Every compaction path reads the session's resolved compaction
    // settings (TS `getCompactionSettings`): `/compact` matches the
    // `compact.*` turn-boundary tool's `keepRecentTokens`/`reserveTokens`.
    session.set_compaction_settings(crate::session_engine::compaction::CompactionSettings {
        enabled: compaction_settings.enabled.unwrap_or(true),
        reserve_tokens: compaction_settings
            .reserve_tokens
            .unwrap_or(crate::session_engine::compaction::DEFAULT_RESERVE_TOKENS),
        keep_recent_tokens: compaction_settings
            .keep_recent_tokens
            .unwrap_or(crate::session_engine::compaction::DEFAULT_KEEP_RECENT_TOKENS),
    });
    // TS #2411: the session's summarizer passes (compaction summaries;
    // branch summaries route through the same context at the daemon seam)
    // resolve their model through the `auxiliaryModel` setting with the
    // session model as fallback, so their one-off prompts stay off the
    // session's prompt-cache prefix.
    session.set_auxiliary_model_context(
        crate::session_engine::auxiliary_model::AuxiliaryModelContext {
            cwd,
            agent_dir: config.agent_dir.clone(),
        },
    );
    // The kernel-state probe behind the post-compaction `ipython_state`
    // notice (TS `AgentSession._ipythonKernelProvisioner`): the engine's
    // provisioner is the session's kernel whether it added the `ipython`
    // tool itself or the caller supplied one backed by this provisioner.
    // A provisioner whose kernel never started reports no running kernel,
    // so the notice stays dormant until a kernel exists. The probe holds a
    // WEAK reference: the engine owns the provisioner (the session is part
    // of the graph the kernel's host handlers reach, so a strong edge here
    // would loop the graph and pin a dropped session's kernel).
    let kernel_state_probe: std::sync::Arc<
        dyn crate::session_engine::ipython_state::CompactionKernelProbe,
    > = std::sync::Arc::new(crate::session_engine::ipython_state::EngineOwnedProbe::new(
        std::sync::Arc::downgrade(&provisioner),
    ));
    session.set_kernel_state_probe(Some(kernel_state_probe));
    // The skill inventory `/skill:<name>` submissions expand against (TS
    // reads the resource loader at expansion time; the session snapshots
    // the engine's loaded list).
    session.set_skills(resources.skills.clone());
    // The embedding's image-model routing seam (the headless surfaces
    // install theirs; the daemon worker's turn dispatch owns routing).
    session.set_image_model_router(config.image_model_router.clone());
    // The semantic-edge handoff: the daemon's child registry and retry
    // park read the recorder; the side question keeps the pre-semantic
    // fn so its calls carry no id.
    session.set_semantic_edges(semantic_recorder);
    session.set_side_question_stream_fn(side_question_stream_fn);
    // The armed image route never outlives the run that armed it (TS
    // `_clearModelOverrideWhenIdle`: the override drops once the turn is
    // idle, so a picker switch between turns is live immediately — the
    // settle's still-routed guard leaves the switched slot). The settle
    // here is idempotent: an un-armed episode's swap restores the slot
    // it already holds, and the next admission's own settle re-reads
    // fresh state either way.
    if let Some(router) = config.image_model_router.clone() {
        // A weak agent reference: the listener lives ON the agent, so a
        // strong edge would cycle and pin a dropped session's agent.
        let agent_at_end = std::sync::Arc::downgrade(&agent);
        agent
            .subscribe(move |event, _signal| {
                let router = router.clone();
                let agent_at_end = agent_at_end.clone();
                Box::pin(async move {
                    if matches!(event, pa_agent::types::AgentEvent::AgentEnd { .. }) {
                        (router.swap_target)(None);
                        // The agent's per-run override clears with the
                        // route (TS `_clearModelOverrideWhenIdle` drops
                        // it once the turn is idle): a leftover override
                        // would leak into a later `continue_run`'s loop
                        // config — the retry would snapshot the image
                        // model while the stream serves the session one.
                        if let Some(agent) = agent_at_end.upgrade() {
                            agent.set_model_override(None);
                        }
                    }
                    Ok(())
                })
            })
            .await;
    }
    // The boot-notice mailbox becomes the session's next-turn queue:
    // rows parked by a boot that settled mid-build merge in, and later
    // boots (a lazy first-call start) push straight into the live
    // session's queue.
    session.adopt_next_turn_rows(boot_notice_rows);

    // Bind the turn-boundary runtime the `compact.*`/`refine.*` handlers
    // probe (turn-active state, usage estimate, compaction preparation).
    turn_boundary.bind(super::turn_boundary::TurnBoundaryRuntime {
        agent,
        session: wiring.session.clone(),
        context_window: (model_context_window > 0).then_some(model_context_window),
        model_info,
    });

    // Session telemetry: installed only for depth-0 sessions (TS parity —
    // subagents never double-report). The composition root supplies the
    // resolved client; `None` wires the opt-out fast path.
    let telemetry = match (config.telemetry.take(), config.rlm_depth.unwrap_or(0)) {
        (Some(wiring), 0) => {
            let skill_counts = super::telemetry::SkillCounts {
                skill_count: resources.skills.len(),
                python_skill_count: super::runtime_wiring::kernel_python_skills(&resources.skills)
                    .len(),
            };
            let installed = super::telemetry::install_session_telemetry(
                &telemetry_agent,
                &wiring,
                Some(skill_counts),
                std::sync::Arc::clone(&session_counters),
            )
            .await?;
            Some(std::sync::Arc::new(installed))
        }
        _ => None,
    };

    // The `skill_use_count` session counter counts through the session's
    // telemetry handle (installed once the telemetry composition decided
    // whether this session reports at all).
    if let Some(telemetry) = telemetry.as_ref() {
        session.set_skill_telemetry(telemetry.clone());
        // Same lifetime for the `rlm_child_*` session counters: the
        // producer's flush counts through this handle.
        wiring.rlm_usage.set_telemetry(telemetry.clone());
    }
    let goal_driver = wiring.runtime.goal_driver().clone();
    // The factory host bridge: registered from `create_session` (the #3184
    // pattern), so the daemon/TUI factory surface resolves against this
    // session's harness dirs, model registry, and the allowlist pin. The
    // kernel owns the runs; the bridge prefights and tunnels. Captured
    // before the loop wiring moves the session model and the digest moves
    // the local harness dir.
    let factory_host =
        super::factory_host::FactoryHost::new(super::factory_host::FactoryHostConfig {
            agent_dir: config.agent_dir.clone(),
            global_harness_dir: crate::refinement::get_global_harness_state_dir(&config.agent_dir),
            local_harness_dir: factory_local_harness_dir,
            session_model: factory_session_model,
            allowed_models: factory_allowed_models,
        });
    Ok(SessionEngine {
        session,
        skills: resources.skills,
        skill_diagnostics: resources.skill_diagnostics,
        prompt_templates: resources.prompts,
        agents_files: resources.agents_files,
        system_prompt,
        goal_driver,
        queued_goal_context_purge: config.queued_goal_context_purge.clone(),
        mcp_manager,
        turn_boundary,
        telemetry,
        rlm_usage: wiring.rlm_usage,
        factory_host,
        provisioner,
    })
}

impl SessionEngine {
    /// Live model-facts bookkeeping for the turn-boundary surface: after
    /// a model switch the registered `model.info` handler and the context
    /// window the usage estimate reads follow the model the session now
    /// runs (the TS runtime reads both live, not at assembly time).
    pub fn update_model_facts(&self, model: &pa_types::ai::Model) {
        super::turn_boundary::TurnBoundaryRequests::rebind_model_facts(
            &self.turn_boundary,
            super::turn_boundary::ModelInfo {
                id: model.id.clone(),
                provider: model.provider.clone(),
                input: model.input.clone(),
            },
            (model.context_window > 0).then_some(model.context_window),
        );
    }

    /// The session's kernel provisioner as a weak reference (TS
    /// `AgentSession._ipythonKernelProvisioner`): embeddings mirror it for
    /// lock-free kernel liveness probes (TS `hasBackgroundWork`) without
    /// joining the strong ownership graph — the same weak discipline the
    /// `ipython` tool and the compaction kernel-state probe follow.
    pub fn kernel_provisioner_weak(
        &self,
    ) -> std::sync::Weak<crate::kernel::provisioner::IpythonKernelProvisioner> {
        std::sync::Arc::downgrade(&self.provisioner)
    }

    /// Expand a `/skill:<name>` submission into its `<skill>` block for
    /// the accepted-turn row (TS `_expandSkillCommand`; the row the daemon
    /// emits before admission must match the text the model turn
    /// receives). Non-skill inputs pass through unchanged; the admitted
    /// turn's own expansion is idempotent over the block. The
    /// `skill_use_count` counter counts at the admission, not here.
    pub fn expand_skill_submission(&self, text: &str) -> String {
        crate::skills::expand_skill_command(text, &self.skills).0
    }

    /// Withdraw the queued goal-context turns (TS `_clearQueuedGoalContexts`
    /// at the `_pauseGoal`/`_clearGoal`/`_startGoal` command sites): a
    /// minted continuation waiting in the embedding's queue never runs
    /// behind a paused/cleared/replaced goal. The daemon worker owns the
    /// queue lanes; embeddings without one (in-session engines) have no
    /// queued goal contexts and installed no seam.
    pub fn purge_queued_goal_contexts(&self) {
        if let Some(purge) = &self.queued_goal_context_purge {
            purge();
        }
    }

    /// Prompt the session (delegates to `AgentSession::prompt`).
    ///
    /// # Errors
    ///
    /// Returns the underlying turn admission error: an invalid prompt, an
    /// already-busy session under its admission rule, or the turn's own
    /// failure.
    pub async fn prompt(
        &self,
        text: &str,
        options: PromptOptions,
    ) -> anyhow::Result<PromptOutcome> {
        self.session.prompt(text, options).await
    }

    /// Tear the session's kernel down now (a final namespace snapshot,
    /// like the TS session dispose). Dropping the engine tears the kernel
    /// down too — this is the explicit seam for a host that ends a
    /// session but keeps the engine object alive (the daemon worker's
    /// session disposal), so the kernel process never outlives the
    /// session that owns it.
    pub async fn dispose_kernel(&self) {
        self.provisioner.dispose(None).await;
    }

    /// Release the session's kernel now with a final namespace snapshot,
    /// revivable: the provisioner stays undisposed, and the next kernel
    /// use boots a fresh kernel gated on this stop's flush and revives
    /// the flushed snapshot (TS #2483's `stopKernel({ snapshot: true })`
    /// — the settled-child release arm; the session stays live,
    /// listable, and collectable).
    pub async fn stop_kernel_snapshot(&self) {
        self.provisioner
            .stop_kernel(Some(crate::kernel::shared::KernelShutdownOptions {
                snapshot: true,
                drain_host_requests: true,
            }))
            .await;
    }

    /// One factory activity over this session's live kernel: the `/factory`
    /// view's bridge lane (graph/status/watch/run/stop/resume). A `run`
    /// prefights the spec's declared models first (allowlist pin, request
    /// auth) so a doomed run fails before any child spawns; then the
    /// out-of-band frame carries the request into the kernel's executor,
    /// which owns the run registry.
    ///
    /// # Errors
    ///
    /// Returns an error when the arguments are invalid, the preflight
    /// fails, the session has no running kernel, or the kernel request
    /// fails or does not settle.
    pub async fn factory_activity(
        &self,
        action: &str,
        run_id: Option<&str>,
        spec_id: Option<&str>,
        timeout_ms: Option<u64>,
    ) -> anyhow::Result<serde_json::Value> {
        let request = super::factory_host::FactoryActivityRequest::parse(
            action, run_id, spec_id, timeout_ms,
        )?;
        if request.action == "run" {
            let spec_id = request
                .spec_id
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("factory activity run requires specId"))?;
            // The preflight reads the harness states, the model catalog,
            // and the auth caches from disk — blocking work off the
            // executor (the daemon's established settings-read posture:
            // `spawn_blocking`, never the async lane), so a stalled
            // filesystem can never stall the worker's other activity.
            let host = self.factory_host.clone();
            let spec_id = spec_id.to_string();
            let preflight = tokio::task::spawn_blocking(move || host.preflight_run(&spec_id))
                .await
                .map_err(|join| anyhow::anyhow!("factory run preflight join failed: {join}"))?;
            preflight?;
        }
        let manager = self
            .provisioner
            .manager()
            .ok_or_else(|| anyhow::anyhow!("Kernel is not running"))?;
        manager
            .factory_activity(
                request.action,
                request.run_id.as_deref(),
                request.spec_id.as_deref(),
                request.timeout_ms,
            )
            .await
    }

    /// Out-of-band kernel bash activity, scoped to this session's live kernel.
    ///
    /// # Errors
    ///
    /// Returns an error when the session has no running kernel, or the
    /// kernel's bash-activity validation or request fails.
    pub async fn bash_activity(
        &self,
        action: &str,
        activity_id: Option<&str>,
        lines: usize,
    ) -> anyhow::Result<serde_json::Value> {
        let manager = self
            .provisioner
            .manager()
            .ok_or_else(|| anyhow::anyhow!("Kernel is not running"))?;
        manager.bash_activity(action, activity_id, lines).await
    }
}

// The unit battery lives in the child module (engine::tests); its use-super
// glob resolves through this facade's bindings and re-exports.
#[cfg(test)]
mod tests;
