//! The engine's lifecycle surface: the constructor and the session
//! build/adopt/retire cycle, the closed-state markers, the skill
//! expansion and session-command funnels, and the kernel host wiring.
use super::{
    execute_session_command, json_round_trip, map_thinking_level,
    register_agent_message_host_handlers, register_agent_observe_host_handlers,
    switchable_stream_fn, AgentEngineConfig, AgentSessionEngine, Arc, CoreSessionEngine,
    EngineModelSelection, HostRequestHandlers, LinkAgentMessageController,
    LinkAgentObserveController, Model, OverflowRecovery, ProducerUsageSink, ProviderTarget,
    QuotaParkState, SessionCommandExecution, SessionCommandParams, SessionEngineConfig,
    SupervisorChildSessions, Value,
};

/// The instruction the floor appends to a bare skill invocation: ask what
/// the user wants first, never an imperative to execute.
pub(crate) const BARE_SKILL_INVOCATION_INSTRUCTION: &str = "The user invoked this skill with no task text - ask what they want before executing any protocol inside it.";

impl AgentSessionEngine {
    /// Build the engine: the shared async runtime, the model selection
    /// (create config), the supervisor link, the children registry, and the
    /// MCP store.
    ///
    /// # Errors
    ///
    /// Returns an error when the multi-thread runtime cannot be built.
    ///
    /// # Panics
    ///
    /// The MCP closures here panic on a poisoned engine cwd lock.
    pub fn new(config: AgentEngineConfig) -> anyhow::Result<Self> {
        let runtime = crate::async_safe_runtime::AsyncSafeRuntime::new_multi_thread()?;
        let session_file = std::sync::Mutex::new(config.session_file.clone());
        let selection = EngineModelSelection {
            provider: config.provider.clone(),
            model: config.model.clone(),
            api_key: config.api_key.clone(),
            thinking: config.thinking,
        };
        let link = Arc::new(crate::supervisor_link::SupervisorLink::new(
            config
                .supervisor_link
                .as_ref()
                .map(|link_config| link_config.socket_path.clone())
                .unwrap_or_default(),
        ));
        let model_refusal_telemetry =
            std::sync::Arc::new(crate::model_allowlist::ModelRefusalTelemetry::new(
                config.agent_dir.clone(),
                config.telemetry_disabled == Some(true),
            ));
        let children = config.supervisor_link.as_ref().map(|link_config| {
            Arc::new(SupervisorChildSessions::new(
                Arc::clone(&link),
                config.agent_dir.clone(),
                link_config.active_session_id.clone(),
                std::sync::Arc::clone(&model_refusal_telemetry),
            ))
        });
        let autonomous_driver = std::sync::RwLock::new(std::sync::Arc::new(
            pa_core::autonomous::ShellAutonomousDriver::new(config.cwd.clone()),
        )
            as std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver>);
        let cwd = std::sync::Arc::new(std::sync::RwLock::new(config.cwd.clone()));
        // The ACP MCP store (auth storage construction is blocking, off the hot async paths).
        let agent_dir = config.agent_dir.clone();
        // Settings-declared user servers; re-read per resolve so `mcp.refresh` sees settings
        // changes.
        let mcp_cwd = std::sync::Arc::clone(&cwd);
        let mcp_agent_dir = agent_dir.clone();
        let catalog_cwd = std::sync::Arc::clone(&cwd);
        let catalog_agent_dir = agent_dir.clone();
        let mcp = pa_core::mcp::McpManager::new(pa_core::mcp::McpManagerOptions {
            auth_storage: pa_core::auth::AuthStorage::create_with_oauth(
                &agent_dir,
                std::sync::Arc::new(pa_core::mcp::McpOAuth::new()),
            ),
            get_user_servers: Box::new(move || {
                // The live cwd slot, not the construction-time cwd: the rebind must reach the MCP
                // settings discovery.
                let mcp_cwd = mcp_cwd.read().expect("engine cwd lock").clone();
                let settings = pa_core::settings::SettingsManager::create(&mcp_cwd, &mcp_agent_dir);
                Some(
                    settings
                        .settings()
                        .mcp_servers
                        .clone()
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|(server, server_config)| {
                            serde_json::from_value(server_config)
                                .ok()
                                .map(|parsed| (server, parsed))
                        })
                        .collect::<std::collections::HashMap<
                            String,
                            pa_core::mcp::McpServerConfig,
                        >>(),
                )
            }),
            begin_login: None,
            agent_dir: Some(agent_dir),
            get_catalog_sources: Some(Box::new(move || {
                // Declared local service-catalog sources, re-read per resolve.
                let catalog_cwd = catalog_cwd.read().expect("engine cwd lock").clone();
                let settings =
                    pa_core::settings::SettingsManager::create(&catalog_cwd, &catalog_agent_dir);
                settings
                    .settings()
                    .mcp_catalog_sources
                    .clone()
                    .unwrap_or_default()
            })),
            remote_source: None,
            probe_override: None,
        });
        // The kernel's `mcp.begin_login` host request: the worker runs the
        // OAuth login; wired before any session registers host handlers.
        let mcp = std::sync::Arc::new(std::sync::Mutex::new(mcp));
        crate::mcp_login::wire_worker_mcp_login(
            &mcp,
            std::sync::Arc::new(crate::mcp_login::WorkerMcpLoginUi::from_env()),
            std::sync::Arc::new(pa_core::mcp::ReqwestOAuthHttp::new()),
        );
        // Queue delivery modes arrive at create, so the engine starts
        // unseeded (None keeps the TS default "one-at-a-time").
        let queue_modes = std::sync::Mutex::new((None, None));
        Ok(Self {
            runtime,
            config,
            mcp,
            published_goal: std::sync::Mutex::new(None),
            late_agent_message_sink: std::sync::Mutex::new(None),
            goal_runtime: std::sync::Mutex::new(None),
            pending_goal_continuation: std::sync::Mutex::new(None),
            goal_budget_crossed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            goal_input_probe: std::sync::Mutex::new(None),
            goal_admission_sink: std::sync::Mutex::new(None),
            bash_completion_sink: std::sync::Mutex::new(None),
            digest_inbox_seams: std::sync::Mutex::new(None),
            watch_notice_sink: std::sync::Mutex::new(None),
            agent_watches: std::sync::Mutex::new(
                crate::agent_inbox_host::AgentWatchHostState::default(),
            ),
            bash_consumed_sink: std::sync::Mutex::new(None),
            goal_queue_purge: std::sync::Mutex::new(None),
            goal_backoff_wake_job_id: std::sync::Mutex::new(None),
            stale_goal_terminal_pending: std::sync::Mutex::new(None),
            turn_agent: std::sync::Mutex::new(None),
            queue_modes,
            autonomous_boundary: std::sync::Mutex::new(None),
            background_bash_probe: std::sync::Mutex::new(None),
            kernel_release_probe: std::sync::Mutex::new(None),
            registered_jobs_probe: std::sync::Mutex::new(None),
            session_file,
            selection: std::sync::RwLock::new(selection.clone()),
            restored_model: std::sync::Mutex::new(None),
            startup_scope: std::sync::Mutex::new(None),
            initial_selection: std::sync::RwLock::new(selection),
            effective_thinking: std::sync::RwLock::new(None),
            service_tier: std::sync::RwLock::new(None),
            session: tokio::sync::Mutex::new(None),
            session_build: tokio::sync::Mutex::new(()),
            pending_branch: std::sync::Mutex::new(None),
            provider_target: std::sync::Arc::new(std::sync::RwLock::new(None)),
            image_route: std::sync::Mutex::new(None),
            own_summary: std::sync::Arc::new(std::sync::Mutex::new(None)),
            create_resources: std::sync::RwLock::default(),
            autonomous: std::sync::Arc::new(tokio::sync::Mutex::new(
                pa_core::autonomous::create_autonomous_runtime_state(None, None),
            )),
            link,
            children,
            usage_producer: std::sync::Mutex::new(None),
            quota_park: std::sync::Arc::new(std::sync::Mutex::new(None)),
            quota_parked_this_run: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            autonomous_driver,
            autonomous_driver_default: std::sync::atomic::AtomicBool::new(true),
            held_autonomous_continuation: std::sync::Mutex::new(None),
            autonomous_admission: std::sync::Mutex::new(None),
            autonomous_awaits_rlm_work: std::sync::atomic::AtomicBool::new(false),
            session_closed: std::sync::atomic::AtomicBool::new(false),
            self_weak: std::sync::Mutex::new(None),
            autonomous_queue_purge: std::sync::Mutex::new(None),
            cwd,
            rlm_depth: std::sync::atomic::AtomicU32::new(0),
            rlm_max_depth_source: std::sync::Mutex::new("default"),
            pending_max_depth: std::sync::Mutex::new(None),
            reloaded_goal_update: std::sync::Mutex::new(None),
            faux_model: std::sync::OnceLock::new(),
            overflow_recovery: std::sync::Mutex::new(OverflowRecovery::default()),
            auto_compaction_abort: std::sync::Mutex::new(None),
            compaction_summary_sink: std::sync::Mutex::new(None),
            model_refusal_telemetry,
            semantic_identity: std::sync::Mutex::new(None),
        })
    }

    /// Replace the autonomous continuation policy. Call before the first admitted turn.
    ///
    /// # Panics
    ///
    /// Panics when the autonomous-driver lock is poisoned.
    pub fn set_autonomous_driver(
        &self,
        driver: std::sync::Arc<dyn pa_core::autonomous::AutonomousDriver>,
    ) {
        self.autonomous_driver_default
            .store(false, std::sync::atomic::Ordering::Relaxed);
        *self
            .autonomous_driver
            .write()
            .expect("autonomous driver lock") = driver;
    }

    pub(crate) fn cwd(&self) -> std::path::PathBuf {
        self.cwd.read().expect("engine cwd lock").clone()
    }

    /// Expand a `/skill:<name>` submission against the core session
    /// (built here when needed); non-skill inputs and build failures
    /// pass through unchanged.
    pub(crate) fn expand_skill_submission(&self, text: &str) -> String {
        // The floor keys on the ORIGINAL invocation's shape, not the
        // expanded parse: a skill body can contain a close tag plus a
        // `\n\n` tail that parses as a trailing user message.
        let bare_invocation = pa_types::slash_commands::parse_slash_command(text)
            .is_some_and(|(name, args)| name.starts_with("skill:") && args.trim().is_empty());
        let Ok(model) = self.resolve_model() else {
            return text.to_string();
        };
        if let Err(error) = self.ensure_core_session(&model) {
            eprintln!("skill submission expansion skipped: session build failed: {error:#}");
            return text.to_string();
        }
        let expanded = self.runtime.block_on(async {
            let guard = self.session.lock().await;
            match guard.as_deref() {
                Some(engine) => engine.expand_skill_submission(text),
                None => text.to_string(),
            }
        });
        if bare_invocation && pa_types::skill_blocks::parse_skill_block(&expanded).is_some() {
            return format!("{expanded}\n\n{BARE_SKILL_INVOCATION_INSTRUCTION}");
        }
        expanded
    }

    /// The async build of the core session, awaited on the caller's
    /// runtime: unbuilt read seams build here.
    pub(crate) async fn ensure_core_session_async(&self, model: &Model) -> anyhow::Result<()> {
        let _build = self.session_build.lock().await;
        {
            let guard = self.session.lock().await;
            if guard.is_some() {
                return Ok(());
            }
        }
        let built = self.build_session(model).await?;
        self.adopt_built_session(&built).await?;
        self.session.lock().await.replace(Arc::new(built));
        Ok(())
    }

    /// Install the worker's live compaction summary-delta sink: every built session adopts it.
    ///
    /// # Panics
    ///
    /// Panics when the sink slot's mutex is poisoned.
    pub fn set_compaction_summary_sink(
        &self,
        sink: pa_core::session_engine::compaction_exec::SummaryDeltaSink,
    ) {
        *self
            .compaction_summary_sink
            .lock()
            .expect("compaction summary sink lock") = Some(sink);
    }

    /// The stale-row guard's deferred durable write: the terminal row
    /// lands AFTER the context adoption, so the active row stops being
    /// rediscovered.
    pub(crate) async fn flush_pending_stale_goal_terminal(&self) {
        let terminal = self
            .stale_goal_terminal_pending
            .lock()
            .expect("stale terminal pending lock")
            .take();
        let Some(terminal) = terminal else {
            return;
        };
        let Some(handles) = self.goal_runtime.lock().expect("goal runtime lock").clone() else {
            return;
        };
        let mut session = handles.session.lock().await;
        let normalized = pa_core::goals::normalize_goal_state(terminal);
        match serde_json::to_value(&normalized) {
            Ok(value) => {
                let appended = session
                    .append_custom_entry(pa_core::goals::GOAL_STATE_CUSTOM_TYPE, Some(value))
                    .map(|_| ())
                    .and_then(|()| session.flush_now());
                if let Err(persist_error) = appended {
                    eprintln!("pa-daemon: stale goal terminal persist failed: {persist_error:#}");
                }
            }
            Err(serialize_error) => {
                eprintln!("pa-daemon: stale goal terminal serialize failed: {serialize_error:#}");
            }
        }
    }

    async fn adopt_built_session(&self, built: &CoreSessionEngine) -> anyhow::Result<()> {
        self.mirror_goal_runtime(built).await;
        if let Some(sink) = self
            .compaction_summary_sink
            .lock()
            .expect("compaction summary sink lock")
            .clone()
        {
            built.session.set_compaction_summary_sink(sink);
        }
        // The in-run consult's mirror: the session mutex is held across
        // compaction turns, and the consult runs inside one.
        *self
            .autonomous_boundary
            .lock()
            .expect("autonomous boundary lock") =
            Some(crate::autonomous_continuation::AutonomousBoundaryMirror {
                turn_boundary: std::sync::Arc::clone(&built.turn_boundary),
                agent: std::sync::Arc::clone(built.session.agent()),
                compaction: built.session.compaction_settings(),
            });
        // The background-bash liveness probe: a deadlock-free read over the
        // build's provisioner.
        let provisioner = built.kernel_provisioner_weak();
        *self
            .background_bash_probe
            .lock()
            .expect("background bash probe lock") = Some(std::sync::Arc::new(move || {
            provisioner
                .upgrade()
                .and_then(|provisioner| provisioner.manager())
                .is_some_and(|manager| manager.has_background_work())
        }));
        // The settled-child kernel release handle: the park arm stops the
        // kernel without taking the session mutex (a dead weak reference
        // releases nothing).
        let release_provisioner = built.kernel_provisioner_weak();
        *self
            .kernel_release_probe
            .lock()
            .expect("kernel release probe lock") = Some(std::sync::Arc::new(move || {
            let provisioner = release_provisioner.clone();
            Box::pin(async move {
                if let Some(provisioner) = provisioner.upgrade() {
                    provisioner
                        .stop_kernel(Some(pa_core::kernel::shared::KernelShutdownOptions {
                            snapshot: true,
                            drain_host_requests: true,
                        }))
                        .await;
                }
            })
        }));
        // The in-run autonomous continuation hook (the goal seam keeps its own boundary mint).
        self.install_autonomous_continuation_hook_on(built.session.agent());
        // Live children outlive the rebuild and registered their spawns on the old producer:
        // adopt those registrations before the new sink observes, or the first post-swap
        // report drops against a producer that never saw the spawn.
        if let Some(children) = &self.children {
            let retired = self
                .usage_producer
                .lock()
                .expect("usage producer lock")
                .take();
            if let Some(retired) = retired {
                built.rlm_usage.adopt_registrations(&retired).await;
            }
            children.set_usage_sink(std::sync::Arc::new(ProducerUsageSink(
                std::sync::Arc::clone(&built.rlm_usage),
            )));
            *self.usage_producer.lock().expect("usage producer lock") =
                Some(std::sync::Arc::clone(&built.rlm_usage));
            // The semantic-edge handoff (the same per-build pattern): the
            // settle watcher records a returned child's last committed
            // request into this recorder.
            children.set_semantic_edges(built.session.semantic_edges());
        }
        *self.turn_agent.lock().expect("turn agent lock") =
            Some(std::sync::Arc::clone(built.session.agent()));
        {
            let handles = self.goal_runtime.lock().expect("goal runtime lock").clone();
            if let Some(handles) = handles {
                let mut manager = handles.session.lock().await;
                self.flush_pending_max_depth(&mut manager);
            }
        }
        let pending_branch = self
            .pending_branch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // Rehydrate the goal driver from the durable store (a moved
        // branch's latest entry wins), seeding the published baseline so
        // it never announces itself.
        let seed;
        let mut shared_window = None;
        let mut shared_branch = None;
        {
            let path = self
                .session_file
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            if let Some(entries) = &pending_branch {
                seed = crate::goal_state_persist::goal_state_in_branch(entries);
            } else {
                let (goal, window, branch) = tokio::task::spawn_blocking(move || {
                    // Window present -> snapshot goal + adopt; the full reader's branch entries
                    // otherwise.
                    let Some(path) = path else {
                        return (None, None, None);
                    };
                    if let Ok(Some(window)) =
                        pa_core::session::window::WindowedSessionStore::open(&path)
                    {
                        let goal = window.goal_state().cloned();
                        (goal, Some(window), None)
                    } else {
                        let store = crate::session_store::SessionFile::open(&path).ok();
                        let goal = store
                            .as_ref()
                            .and_then(crate::goal_state_persist::goal_state_in_session_file);
                        let branch = store.map(|store| store.branch_file_entries());
                        (goal, None, branch)
                    }
                })
                .await?;
                seed = goal;
                shared_window = window;
                shared_branch = branch;
            }
        }
        if let Some(state) = seed {
            // The restore-resurrection guard: an active seed whose
            // trailing turn settled as a terminal provider failure adopts
            // the failure (the active row cannot resurrect the goal).
            let mut stale_error = None;
            if state.status == pa_core::goals::GoalStatus::Active {
                let scan: Option<Vec<pa_types::session::FileEntry>> = pending_branch
                    .clone()
                    .or_else(|| shared_branch.clone())
                    .or_else(|| {
                        shared_window
                            .as_ref()
                            .map(|window| window.entries().to_vec())
                    });
                if let Some(entries) = scan {
                    if let Some(error) = pa_core::goals::stale_active_goal_failure(&entries) {
                        stale_error = Some(error);
                    }
                }
            }
            if let Some(error) = stale_error {
                // The stale-row guard's adoption: the IN-MEMORY driver
                // takes the verdict directly; the DURABLE row is DEFERRED
                // to the post-adoption flush (a write here would be replaced).
                let terminal = pa_core::goals::GoalState {
                    active: false,
                    status: pa_core::goals::GoalStatus::Error,
                    last_reason: Some(error.clone()),
                    last_error: Some(error),
                    ..state.clone()
                };
                let handles = self.goal_runtime.lock().expect("goal runtime lock").clone();
                if let Some(handles) = handles {
                    let mut driver = handles.driver.lock().await;
                    driver.restore_from_persisted(terminal.clone());
                    drop(driver);
                }
                *self
                    .stale_goal_terminal_pending
                    .lock()
                    .expect("stale terminal pending lock") = Some(terminal);
                // The published baseline keeps the RAW row: the first
                // `goal_update_if_changed` EMITS — the worker's durable
                // mirror is the ONE path the terminal row reaches the file.
                *self.published_goal.lock().expect("published goal lock") = Some(state);
            } else {
                let handles = self.goal_runtime.lock().expect("goal runtime lock").clone();
                if let Some(handles) = handles {
                    let mut driver = handles.driver.lock().await;
                    driver.restore_from_persisted(state.clone());
                    drop(driver);
                }
                *self.published_goal.lock().expect("published goal lock") = Some(state);
            }
        }
        if let Some(entries) = pending_branch {
            built.session.rebuild_branch_context(entries).await?;
            // A moved branch restores its own park (the early return would leave the previous
            // branch's park armed).
            self.restore_quota_park(built).await;
            self.flush_pending_stale_goal_terminal().await;
            return Ok(());
        }
        // Restore the retained context and certified metadata without loading discarded bodies.
        if let Some(window) = shared_window {
            built.session.restore_windowed_context(window).await;
            // This worker holds the runtime lease: exactly one writer per
            // lease certifies the window cache; the release flushes the
            // snapshot.
            built
                .session
                .shared_persistence()
                .lock()
                .await
                .set_append_ownership(pa_core::session::window::AppendOwnership::SessionLeaseHeld);
            self.flush_pending_stale_goal_terminal().await;
        } else if let Some(entries) = shared_branch.take().filter(|entries| !entries.is_empty()) {
            built.session.rebuild_branch_context(entries).await?;
            self.flush_pending_stale_goal_terminal().await;
        }
        self.restore_quota_park(built).await;
        // The walk and replay allocated transient trees several times the
        // retained size: release the freed heap.
        pa_types::memory_release::trim_freed_heap();
        Ok(())
    }

    /// Scan the branch entries for the park this branch ended on and re-arm the live park state.
    /// A previous build's park is cleared first, so it never survives onto a
    /// branch that did not park.
    async fn restore_quota_park(&self, built: &CoreSessionEngine) {
        *self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        let persistence = built.session.shared_persistence();
        let manager = persistence.lock().await;
        let Some(persisted) = manager.latest_quota_park() else {
            return;
        };
        drop(manager);
        let now_ms = crate::util::now_ms();
        if persisted.resume_at_ms <= now_ms {
            // The wake time passed: the durable wake job owns the resume.
            return;
        }
        // A missing wake job is rebuilt and recorded for the next restart;
        // a user-cancelled one is honored by leaving the session unparked.
        let job_id = match &persisted.job_id {
            Some(job_id) if self.quota_wake_job_active(job_id) => persisted.job_id.clone(),
            Some(job_id)
                if self.cron_wiring().is_some_and(|wiring| {
                    wiring.store.list().iter().any(|job| &job.id == job_id)
                }) =>
            {
                return;
            }
            Some(_) | None => self.create_quota_resume_job(persisted.resume_at_ms).await,
        };
        if job_id != persisted.job_id {
            // Write through the BUILT session (the installed slot is
            // still empty). A failed write only logs.
            if let Err(write_error) = self
                .append_quota_park_entry(
                    Some(built.session.shared_persistence()),
                    persisted.resume_at_ms,
                    persisted.park_count,
                    job_id.as_deref(),
                    None,
                )
                .await
            {
                eprintln!("pa-daemon: restored quota park entry write failed: {write_error}");
            }
        }
        *self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(QuotaParkState {
            park_count: persisted.park_count,
            resume_at_ms: persisted.resume_at_ms,
            job_id,
            wake_retries: 0,
        });
    }

    /// Retire the live runtime so the next demand seam rebuilds a fresh
    /// session against the moved file. The kernel disposes first — it
    /// must not carry the old session's namespace — and the build gate
    /// is held across the teardown.
    pub(crate) async fn retire_session_runtime(&self) {
        let _build = self.session_build.lock().await;
        let built = self.session.lock().await.take();
        *self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        *self.goal_runtime.lock().expect("goal runtime lock") = None;
        *self.turn_agent.lock().expect("turn agent lock") = None;
        *self
            .autonomous_boundary
            .lock()
            .expect("autonomous boundary lock") = None;
        *self
            .background_bash_probe
            .lock()
            .expect("background bash probe lock") = None;
        *self
            .kernel_release_probe
            .lock()
            .expect("kernel release probe lock") = None;
        *self.published_goal.lock().expect("published goal lock") = None;
        // The retired session's provider target goes with it: a pre-build demand seam resolves the
        // CURRENT model.
        *self.provider_target.write().expect("provider target lock") = None;
        if let Some(engine) = built {
            // The teardown drops the compact-trigger state with a version bump: an in-flight
            // review round never applies its edits.
            engine.session.discard_compact_auto_refine();
            if let Some(telemetry) = &engine.telemetry {
                let _ = telemetry.end().await;
            }
            engine.dispose_kernel().await;
        }
    }

    /// Tear the built session's kernel down. The engine object survives
    /// the call (the worker process outlives its session): the explicit
    /// seam the worker invokes at every session end — the kernel never
    /// outlives the session that owns it.
    pub async fn dispose_kernel(&self) {
        let guard = self.session.lock().await;
        if let Some(engine) = guard.as_deref() {
            engine.dispose_kernel().await;
        }
    }

    /// Mark the session closed and retire the closed runtime's continuation
    /// mirrors — a stopped session never continues.
    ///
    /// # Panics
    ///
    /// Panics when an internal mutex is poisoned.
    pub fn mark_session_closed(&self) {
        self.session_closed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        *self.goal_runtime.lock().expect("goal runtime lock") = None;
        *self
            .autonomous_boundary
            .lock()
            .expect("autonomous boundary lock") = None;
        *self
            .background_bash_probe
            .lock()
            .expect("background bash probe lock") = None;
        *self
            .kernel_release_probe
            .lock()
            .expect("kernel release probe lock") = None;
    }

    /// The create path's live reset: a fresh (or replaced) session starts live.
    pub fn clear_session_closed(&self) {
        self.session_closed
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn session_is_closed(&self) -> bool {
        self.session_closed
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Session-scoped kernel shell activity; never builds a new session/kernel.
    ///
    /// # Errors
    ///
    /// Returns an error when no session kernel is running or its own
    /// shell-activity call fails.
    pub async fn bash_activity(
        &self,
        action: &str,
        activity_id: Option<&str>,
        lines: usize,
    ) -> anyhow::Result<Value> {
        let engine = self
            .session
            .lock()
            .await
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Kernel is not running"))?;
        engine.bash_activity(action, activity_id, lines).await
    }

    /// One factory activity over this session's kernel (the `/factory`
    /// view's lane); never builds a new session/kernel.
    ///
    /// # Errors
    ///
    /// Returns an error when no session kernel is running ("Kernel is
    /// not running"), the preflight fails, or the kernel's own factory
    /// activity call fails.
    pub async fn factory_activity(
        &self,
        action: &str,
        run_id: Option<&str>,
        spec_id: Option<&str>,
        timeout_ms: Option<u64>,
    ) -> anyhow::Result<Value> {
        let engine = self
            .session
            .lock()
            .await
            .clone()
            .ok_or_else(|| anyhow::anyhow!(pa_types::daemon::KERNEL_NOT_RUNNING_MESSAGE))?;
        engine
            .factory_activity(action, run_id, spec_id, timeout_ms)
            .await
    }

    /// Build the core session once (same once-only rule as `session_agent`),
    /// through the same guarded funnel.
    pub(crate) fn ensure_core_session(&self, model: &Model) -> anyhow::Result<()> {
        self.runtime
            .block_on(async { self.ensure_core_session_async(model).await })
    }

    /// Execute one session slash command against the built session:
    /// resolve the model, build on first use, then run the pa-core
    /// executor.
    pub(crate) fn execute_session_command(
        &self,
        command: &pa_core::session_engine::slash_commands::SessionSlashCommand,
    ) -> anyhow::Result<SessionCommandExecution> {
        let model = self.session_model()?;
        self.ensure_core_session(&model)?;
        let api_key = self.resolve_request_api_key(&model);
        let mut autonomous = self.autonomous.blocking_lock();
        let mut params = SessionCommandParams {
            model: &model,
            api_key,
            global_harness_dir: self.config.agent_dir.clone(),
            autonomous: &mut autonomous,
        };
        // The lock covers the clone only: the command below can run a summarizer call, so the
        // mutex must not ride it.
        let core = self
            .session
            .blocking_lock()
            .clone()
            .expect("session built by ensure_core_session");
        Ok(self
            .runtime
            .block_on(async { execute_session_command(&core, &mut params, command).await }))
    }

    /// The current explicit selection (create-config flags over the
    /// process fallback). `pub(crate)`: the image-route probe reads the
    /// create-config key pin.
    pub(crate) fn current_selection(&self) -> EngineModelSelection {
        self.selection.read().expect("model selection lock").clone()
    }

    /// Kernel host-request handlers for messaging and observation,
    /// routed through the supervisor link. `None` outside a daemon worker.
    fn extra_host_handlers(&self) -> Option<HostRequestHandlers> {
        let config = self.config.supervisor_link.as_ref()?;
        let sender = Arc::new(LinkAgentMessageController::new(
            Arc::clone(&self.link),
            config.active_session_id.clone(),
            config.worker_token.clone(),
            Arc::clone(&self.own_summary),
            self.children.clone(),
        ));
        let observer = Arc::new(LinkAgentObserveController::new(
            Arc::clone(&self.link),
            config.active_session_id.clone(),
            Arc::clone(&self.own_summary),
            self.children.clone(),
        ));
        let mut handlers = HostRequestHandlers::default();
        register_agent_message_host_handlers(sender, &mut handlers);
        register_agent_observe_host_handlers(observer, &mut handlers);
        self.register_bash_notice_host_handlers(&mut handlers);
        // The swarm digest lanes (PRs C/D/E): the inbox reads and the
        // watches ride the same engine seams the bash notices hold.
        self.register_digest_inbox_host_handlers(&mut handlers);
        self.register_watch_host_handlers(&mut handlers);
        Some(handlers)
    }

    /// The configured kernel cron wiring (the worker's shared store).
    pub(super) fn cron_wiring(
        &self,
    ) -> Option<pa_core::session_engine::runtime_wiring::KernelCronWiring> {
        self.config.cron_store.clone()
    }

    /// The kernel cron binding: the live active session id plus the
    /// durable id + file from the header. `None` outside a daemon worker.
    pub(super) fn kernel_cron_binding(
        &self,
    ) -> Option<pa_core::session_engine::runtime_wiring::KernelCronBinding> {
        let active_session_id = self
            .config
            .supervisor_link
            .as_ref()?
            .active_session_id
            .clone();
        let file = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        let header = pa_core::session::manager::read_session_header(&file)?;
        Some(pa_core::session_engine::runtime_wiring::KernelCronBinding {
            active_session_id,
            session_id: header.id,
            session_file: file.display().to_string(),
            cwd: self.cwd().display().to_string(),
        })
    }

    async fn build_session(&self, model: &Model) -> anyhow::Result<CoreSessionEngine> {
        let agent_model =
            json_round_trip(model).ok_or_else(|| anyhow::anyhow!("model conversion failed"))?;
        // The live queue-delivery modes: read under a scoped lock (a std
        // guard must never ride the awaits below).
        let (steering_mode, follow_up_mode) = {
            let delivery_modes = self.queue_modes.lock().expect("queue modes");
            (
                delivery_modes.0.as_deref().and_then(Self::queue_mode),
                delivery_modes.1.as_deref().and_then(Self::queue_mode),
            )
        };
        let create_resources = self
            .create_resources
            .read()
            .expect("create resources lock")
            .clone();

        // The session's stream reads its target from the live slot:
        // `set_model` swaps it so the built session follows without a
        // rebuild.
        let stream_fn = switchable_stream_fn(std::sync::Arc::clone(&self.provider_target));
        {
            let (api_key, headers) = self.resolve_request_key_and_headers(model);
            let mut target = self.provider_target.write().expect("provider target lock");
            *target = Some(ProviderTarget {
                service_tier: *self.service_tier.read().expect("service tier lock"),
                api_key,
                model: model.clone(),
                headers,
            });
        }
        if let Some(session_dir) = &self.config.session_dir {
            std::fs::create_dir_all(session_dir)?;
        }
        let cwd = self.cwd();
        let session_file = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        // The engine session stays non-persisted (the worker owns the
        // durable file); the configured session dir leads, the file's
        // parent is the fallback.
        let session_manager = match self
            .config
            .session_dir
            .as_deref()
            .or_else(|| session_file.as_deref().and_then(std::path::Path::parent))
        {
            Some(session_dir) => {
                pa_core::session::manager::SessionManager::in_memory_in_session_dir(
                    &cwd,
                    session_dir,
                )
            }
            None => pa_core::session::manager::SessionManager::in_memory(&cwd),
        };
        if let Some(children) = &self.children {
            children.set_model(format!("{}/{}", model.provider, model.id));
        }
        // Session telemetry: the composition root is this worker; the
        // create's opt-out rides the engine config. Sinks resolve in
        // `build_client`.
        let telemetry = (self.config.telemetry_disabled != Some(true)).then(|| {
            let settings =
                pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
            pa_core::session_engine::telemetry::TelemetryWiring {
                client: pa_core::session_engine::telemetry::build_client(
                    &settings,
                    &self.config.agent_dir,
                ),
                execution_mode: create_resources.execution_mode.clone(),
                now: None,
                telemetry_enabled: Some(
                    pa_core::session_engine::telemetry::telemetry_enabled_switch(
                        &self.cwd(),
                        &self.config.agent_dir,
                    ),
                ),
            }
        });
        // Bound before the awaited build: the purge-clone must not hold the lock guard across the
        // await.
        let queued_goal_context_purge = self
            .goal_queue_purge
            .lock()
            .expect("goal queue purge lock")
            .clone();
        // The kernel's last live background `bash()` handle settling
        // (or a mid-run teardown) retries the owed continuations. No
        // registered arc wires nothing.
        let on_background_work_settled = self
            .self_weak
            .lock()
            .expect("engine self weak lock")
            .clone()
            .map(|weak| {
                std::sync::Arc::new(move || {
                    if let Some(engine) = weak.upgrade() {
                        engine.retry_owed_goal_continuation();
                        engine.retry_owed_autonomous_continuation();
                    }
                }) as pa_core::kernel::shared::BackgroundWorkSettledCallback
            });
        // The semantic-edge identity stamped by `configure_rlm_identity`
        // (the create's provenance): every build's recorder reopens the
        // same ledger, so a rebuild replays instead of re-registering.
        let semantic_edges = self
            .semantic_identity
            .lock()
            .expect("semantic identity lock")
            .clone();
        let on_late_sent_agent_message = self
            .late_agent_message_sink
            .lock()
            .expect("late agent message sink lock")
            .clone();
        pa_core::session_engine::engine::create_session(SessionEngineConfig {
            on_late_sent_agent_message,
            semantic_edges,
            telemetry,
            cwd,
            // TS settings.imageModel routing: the daemon owns the routing;
            // the headless surfaces pass `None` to keep their own.
            image_model_router: None,
            agent_dir: self.config.agent_dir.clone(),
            mcp_manager: Some(std::sync::Arc::clone(&self.mcp)),
            model: Some(agent_model),
            thinking_level: Some(map_thinking_level(self.effective_thinking())),
            stream_fn: Some(stream_fn),
            // Model tools: `ipython` only; the engine adds the kernel-backed `ipython` tool itself.
            tools: vec![],
            custom_system_prompt: create_resources.system_prompt,
            prompt_guidelines: create_resources.append_system_prompt,
            generic_mcp_servers: vec![],
            allow_recursion: None,
            session_manager: Some(session_manager),
            extra_host_handlers: self.extra_host_handlers(),
            conversation_log_path: session_file,
            additional_skill_paths: create_resources.skills,
            additional_prompt_paths: create_resources.prompt_templates,
            extra_builtin_skill_overrides: vec![],
            rlm_subagent_host: self.children.clone().map(|children| {
                children as Arc<dyn pa_core::session_engine::rlm_host::RlmSubagentHost>
            }),
            rlm_depth: Some(self.rlm_depth.load(std::sync::atomic::Ordering::Relaxed)),
            model_info: Some(model.clone()),
            // Prewarm; the depth gate keeps subagent workers lazy.
            prewarm_ipython_kernel: Some(true),
            on_background_work_settled,
            // The worker-installed purge withdraws queued minted continuations.
            queued_goal_context_purge,
            // The steering lane owns the stop hooks (a queued steer cuts the next turn).
            queued_steering_probe: self.config.queued_steering_probe.clone(),
            // Seeded from settings at create; the live switch updates the slot ahead of any later
            // build.
            steering_mode,
            follow_up_mode,
            // The shared scheduled-jobs store with the identity the kernel binding needs; enriched
            // per build.
            cron_store: self.cron_wiring().map(|mut wiring| {
                wiring.binding = self.kernel_cron_binding().or(wiring.binding);
                wiring
            }),
        })
        .await
        .inspect(|engine| {
            // A queue-mode switch that landed mid-build wrote only the live slot: re-apply the
            // modes so the first build never serves a stale one.
            let (steering_mode, follow_up_mode) = {
                let delivery_modes = self.queue_modes.lock().expect("queue modes");
                (
                    delivery_modes.0.as_deref().and_then(Self::queue_mode),
                    delivery_modes.1.as_deref().and_then(Self::queue_mode),
                )
            };
            if let Some(mode) = steering_mode {
                engine.session.agent().set_steering_mode(mode);
            }
            if let Some(mode) = follow_up_mode {
                engine.session.agent().set_follow_up_mode(mode);
            }
        })
    }
}
