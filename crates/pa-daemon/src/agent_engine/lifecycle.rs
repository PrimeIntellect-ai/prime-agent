//! The engine's lifecycle surface: the constructor and the session
//! build/adopt/retire cycle, the closed-state markers, the skill
//! expansion and session-command funnels, and the kernel host
//! wiring the session build installs (moved with its concern).
use super::*;

impl AgentSessionEngine {
    /// Build the engine: the shared async runtime, the model selection
    /// (create config, else the process env pair), the supervisor link, the
    /// children registry, and the MCP store.
    ///
    /// # Errors
    ///
    /// Returns an error when the multi-thread runtime cannot be built.
    ///
    /// # Panics
    ///
    /// The MCP user-server and catalog-source closures built here panic
    /// on a poisoned engine cwd lock (a holder panicked while holding
    /// it).
    pub fn new(config: AgentEngineConfig) -> anyhow::Result<Self> {
        let runtime = crate::async_safe_runtime::AsyncSafeRuntime::new_multi_thread()?;
        let session_file = std::sync::Mutex::new(config.session_file.clone());
        // Process-level fallback: the create config, else the worker env
        // pair. A create command with explicit wire flags overrides both.
        let thinking = config.thinking;
        let selection = if config.provider.is_some() || config.model.is_some() {
            EngineModelSelection {
                provider: config.provider.clone(),
                model: config.model.clone(),
                api_key: config.api_key.clone(),
                thinking,
            }
        } else {
            EngineModelSelection {
                provider: std::env::var("PRIME_AGENT_MODEL_PROVIDER").ok(),
                model: std::env::var("PRIME_AGENT_MODEL").ok(),
                api_key: None,
                thinking,
            }
        };
        // One shared supervisor-link client for the worker: agent messaging
        // and supervisor-backed RLM children multiplex the same connection
        // (the TS worker's single `SupervisorLink` socket).
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
        // The ACP MCP store (auth storage construction is blocking; the
        // engine construction paths are already off the hot async paths).
        let agent_dir = config.agent_dir.clone();
        // Settings-declared user servers feed the store this worker owns
        // (TS `session._mcpManager` resolves user settings; the
        // `mcp.config` host request answers from them). Read per resolve
        // so `mcp.refresh` - which re-resolves integrations - sees
        // settings changes, mirroring the in-process engine's
        // `mcp_gating` extraction (agentDir + project settings.json).
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
                // The live cwd slot, not the construction-time cwd: the
                // rebind (a switched-to session in another directory) must
                // reach the MCP settings discovery (TS rebuilds the runtime's
                // MCP manager per replacement).
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
                // Declared local service-catalog sources (TS
                // `settingsManager.getMcpCatalogSources()`), re-read per
                // resolve so settings changes reach the next refresh.
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
        // OAuth login (browser + local callback) and persists the
        // endpoint-bound credential the shared auth store gates on. Wired
        // before any session registers host handlers, so every session the
        // worker builds exposes it.
        let mcp = std::sync::Arc::new(std::sync::Mutex::new(mcp));
        crate::mcp_login::wire_worker_mcp_login(
            &mcp,
            std::sync::Arc::new(crate::mcp_login::WorkerMcpLoginUi::from_env()),
            std::sync::Arc::new(pa_core::mcp::ReqwestOAuthHttp::new()),
        );
        // The queue delivery modes arrive at session create (TS `sdk.ts`
        // builds the agent with the settings modes; the worker's create
        // seeds them through `set_queue_modes`), so the engine starts
        // unseeded (None keeps the TS default "one-at-a-time" until the
        // create writes the settings modes — steering "all" by default).
        let queue_modes = std::sync::Mutex::new((None, None));
        Ok(Self {
            runtime,
            config,
            mcp,
            published_goal: std::sync::Mutex::new(None),
            goal_runtime: std::sync::Mutex::new(None),
            goal_budget_crossed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            goal_input_probe: std::sync::Mutex::new(None),
            goal_admission_sink: std::sync::Mutex::new(None),
            bash_completion_sink: std::sync::Mutex::new(None),
            bash_consumed_sink: std::sync::Mutex::new(None),
            goal_queue_purge: std::sync::Mutex::new(None),
            turn_agent: std::sync::Mutex::new(None),
            queue_modes,
            autonomous_boundary: std::sync::Mutex::new(None),
            background_bash_probe: std::sync::Mutex::new(None),
            session_file,
            selection: std::sync::RwLock::new(selection.clone()),
            restored_model: std::sync::Mutex::new(None),
            initial_selection: std::sync::RwLock::new(selection),
            effective_thinking: std::sync::RwLock::new(None),
            service_tier: std::sync::RwLock::new(None),
            session: tokio::sync::Mutex::new(None),
            session_build: tokio::sync::Mutex::new(()),
            pending_branch: std::sync::Mutex::new(None),
            provider_target: std::sync::Arc::new(std::sync::RwLock::new(None)),
            image_route: std::sync::Mutex::new(None),
            own_summary: std::sync::Arc::new(std::sync::Mutex::new(None)),
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
        })
    }

    /// Replace the autonomous continuation policy. Deterministic eval
    /// harnesses inject a scripted driver here; the product keeps the
    /// default shell-gate driver in the session cwd. Call before the
    /// first admitted turn.
    ///
    /// # Panics
    ///
    /// Panics when the autonomous-driver lock is poisoned (a holder
    /// panicked while holding it).
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

    /// The session's live working directory (the engine's cwd slot).
    pub(crate) fn cwd(&self) -> std::path::PathBuf {
        self.cwd.read().expect("engine cwd lock").clone()
    }

    /// Expand a `/skill:<name>` submission for the accepted-turn user row
    /// (TS `_normalizeSubmission` persists the expanded text as the user
    /// message): build the core session when needed (it loads the skill
    /// inventory), then expand against it. Non-skill inputs and build
    /// failures pass the text through unchanged — the turn then surfaces
    /// the failure it would have surfaced anyway.
    pub(crate) fn expand_skill_submission(&self, text: &str) -> String {
        let Ok(model) = self.resolve_model() else {
            return text.to_string();
        };
        if let Err(error) = self.ensure_core_session(&model) {
            eprintln!("skill submission expansion skipped: session build failed: {error:#}");
            return text.to_string();
        }
        self.runtime.block_on(async {
            let guard = self.session.lock().await;
            match guard.as_deref() {
                Some(engine) => engine.expand_skill_submission(text),
                None => text.to_string(),
            }
        })
    }

    /// The async build of the core session (the same funnel as
    /// `ensure_core_session`, awaited on the caller's runtime instead of
    /// parked on the engine's own): read seams (`get_system_prompt`)
    /// reaching an unbuilt session build it here. The build gate makes the
    /// eager create-time build and every demand seam meet at one build.
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

    /// Install the worker's live compaction summary-delta sink (the
    /// `compaction_summary_delta` broadcast seam): the worker calls this
    /// once after the engine is built, capturing its event pump; every
    /// built session adopts the sink at [`Self::adopt_built_session`], so
    /// each compaction surface (the manual `compact` command, the
    /// threshold, overflow, and requested auto arms) streams its
    /// summarizer deltas to the attached clients while the summary
    /// generates.
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

    /// Post-build adoption, shared by every build path (the async funnel
    /// and the turn-driven `session_agent` build): mirror the goal
    /// runtime, flush a depth override that landed before the build, and
    /// consume a parked replacement branch. A replacement flow retires
    /// the built session (see [`Self::retire_session_runtime`]) and parks
    /// the moved branch in `pending_branch`; whichever build path runs
    /// first must adopt it, or a read-seam build would strand the parked
    /// branch and the session would start off the moved branch's entries.
    async fn adopt_built_session(&self, built: &CoreSessionEngine) -> anyhow::Result<()> {
        self.mirror_goal_runtime(built);
        // The live compaction summary-delta sink (the worker's
        // `compaction_summary_delta` broadcast): adopted onto the built
        // session like the goal runtime mirrors, so every rebuild's
        // compactions stream — the worker installs the sink before the
        // first build and every built session takes the current slot.
        if let Some(sink) = self
            .compaction_summary_sink
            .lock()
            .expect("compaction summary sink lock")
            .clone()
        {
            built.session.set_compaction_summary_sink(sink);
        }
        // The in-run consult's mirror (deadlock-free reads: the session
        // mutex is held across compaction model turns, and the consult
        // runs inside one of them).
        *self
            .autonomous_boundary
            .lock()
            .expect("autonomous boundary lock") =
            Some(crate::autonomous_continuation::AutonomousBoundaryMirror {
                turn_boundary: std::sync::Arc::clone(&built.turn_boundary),
                agent: std::sync::Arc::clone(built.session.agent()),
                compaction: built.session.compaction_settings(),
            });
        // The background-bash liveness probe (TS `_hasLiveBackgroundBashHandles`
        // reads the provisioner's kernel manager): the same deadlock-free
        // read discipline as the mirror, over the build's own provisioner —
        // the kernel's bash-activity tracking (the state behind the
        // bash-done completion follow-ups) is the liveness surface a held
        // continuation waits on.
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
        // The in-run autonomous continuation hook (the natural mint rides
        // the agent loop; the goal seam keeps its own boundary mint).
        self.install_autonomous_continuation_hook_on(built.session.agent());
        // The children registry's usage observation feeds the engine's
        // attribution producer (TS `flushPendingChildUsageAttribution`'s
        // Rust seam): one sink per build. The session's live children are
        // separate worker processes that OUTLIVE the rebuild — their
        // spawns were registered on the previous build's producer, so
        // adopt those registrations forward before the new sink starts
        // observing, or the first post-swap report drops against a
        // producer that never saw the spawn.
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
        }
        // The eager-abort target rides the same mirror (see
        // [`Self::turn_agent`]).
        *self.turn_agent.lock().expect("turn agent lock") =
            Some(std::sync::Arc::clone(built.session.agent()));
        // A `set_rlm_max_depth` that landed before the build parks its
        // durable entry; the built session owns the store now.
        {
            let handles = self.goal_runtime.lock().expect("goal runtime lock").clone();
            if let Some(handles) = handles {
                let mut manager = handles.session.lock().await;
                self.flush_pending_max_depth(&mut manager);
            }
        }
        // A branch move that landed before the first turn built the
        // session (tree navigation/fork/replacement with no turn yet)
        // re-seeds the session onto the moved branch.
        let pending_branch = self
            .pending_branch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // Rehydrate the goal driver from the durable store (TS
        // constructor: `this._goalState = this._loadPersistedGoalState()`
        // reads the same session rows `_persistGoalState` wrote). A moved
        // branch's own latest entry wins (faithful branch semantics); the
        // worker-owned session file answers otherwise. The seed also sets
        // the published baseline so the rehydrated state never announces
        // itself (TS loads at construction without emitting).
        let seed = if let Some(entries) = &pending_branch {
            crate::goal_state_persist::goal_state_in_branch(entries)
        } else {
            let path = self
                .session_file
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            tokio::task::spawn_blocking(move || {
                crate::goal_state_persist::persisted_goal_state(path.as_deref())
            })
            .await?
        };
        if let Some(state) = seed {
            let handles = self.goal_runtime.lock().expect("goal runtime lock").clone();
            if let Some(handles) = handles {
                let mut driver = handles.driver.lock().await;
                driver.restore_from_persisted(state.clone());
            }
            *self.published_goal.lock().expect("published goal lock") = Some(state);
        }
        if let Some(entries) = pending_branch {
            built.session.rebuild_branch_context(entries).await?;
            // A moved branch restores its own park (the early return
            // would otherwise skip the build-tail restore and leave the
            // previous branch's park — or none — armed).
            self.restore_quota_park(built).await;
            return Ok(());
        }
        // Restore the retained context and certified metadata without loading
        // discarded message bodies. Unsupported files use the ordinary reader.
        let session_file = self
            .session_file
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(path) = session_file {
            let (window, branch) = tokio::task::spawn_blocking(move || {
                match pa_core::session::window::WindowedSessionStore::open(&path) {
                    Ok(Some(window)) => (Some(window), None),
                    Ok(None) | Err(_) => (
                        None,
                        crate::session_store::SessionFile::open(&path)
                            .ok()
                            .map(|store| store.branch_file_entries()),
                    ),
                }
            })
            .await?;
            if let Some(window) = window {
                built.session.restore_windowed_context(window).await;
                // This worker holds the session's runtime lease for the
                // engine's lifetime: its durable appends may certify the
                // window cache incrementally (exactly one writer per
                // lease), and the lease's release flushes the certified
                // snapshot to the sidecar for the next warm open.
                built
                    .session
                    .shared_persistence()
                    .lock()
                    .await
                    .set_append_ownership(
                        pa_core::session::window::AppendOwnership::SessionLeaseHeld,
                    );
            } else if let Some(entries) = branch.filter(|entries| !entries.is_empty()) {
                built.session.rebuild_branch_context(entries).await?;
            }
        }
        // Restore the quota park this branch ended on (TS
        // `_restoreQuotaPark`, at construction): the newest
        // `provider_quota_park` entry not followed by a
        // `provider_quota_resume` entry. A wake still ahead re-arms the
        // live state (a missing wake is rebuilt; a user-cancelled one is
        // honored by leaving the session unparked); a wake that already
        // passed is left to the durable job — a later failure re-parks
        // from a fresh count, like the TS.
        self.restore_quota_park(built).await;
        // The window walk and the retained-context replay allocated
        // transient entry trees several times the retained size; both are
        // consumed here, so release their freed heap to the OS.
        pa_types::memory_release::trim_freed_heap();
        Ok(())
    }

    /// Scan the built session's branch entries for the park this branch
    /// ended on and re-arm the live park state (TS `_restoreQuotaPark`).
    /// A rebuild starts from the branch's own records: any park carried
    /// by the previous build (a replaced session or a moved branch) is
    /// cleared first, so the state never survives onto a branch that did
    /// not park.
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
            // The wake time passed: the durable wake job owns the resume
            // (a failed probe re-parks from a fresh count, like the TS).
            return;
        }
        // A wake job that still exists keeps its id; a missing one is
        // rebuilt and the replacement is recorded so the next restart
        // reuses it instead of arming another beside it; a user-cancelled
        // one is honored (the user owns the wake) by leaving the session
        // unparked.
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
            // Write through the BUILT session: the installed slot is
            // still empty while the build runs. A failed write surfaces
            // as a log: the wake exists (rebuilt above), so the restart's
            // stale-park arms still own the recovery.
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

    /// The TS replacement teardown (`teardownForReplacement` ->
    /// `teardownCurrent` -> `session.disposeAsync()`): retire the live
    /// runtime so the next demand seam rebuilds a fresh session against
    /// the moved session file. The built session's kernel disposes first -
    /// one final namespace snapshot flush, drained host requests, then the
    /// process exits; a kernel that survived here would carry the old
    /// session's namespace into what TS treats as a new session - and the
    /// built session drops together with its mirrored goal handles and the
    /// last published goal state (a read before the next build reports
    /// the fresh runtime's empty state, not the retired session's). The
    /// build gate is held across the teardown so no racing demand seam
    /// rebuilds mid-dispose; the kernel dispose happens after the session
    /// is taken, so the fresh build it enables starts from nothing.
    pub(crate) async fn retire_session_runtime(&self) {
        let _build = self.session_build.lock().await;
        let built = self.session.lock().await.take();
        // The retired session's quota park ends with it (the wake's owner
        // is gone); the replacement build restores whatever the new
        // branch's own entries say.
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
        *self.published_goal.lock().expect("published goal lock") = None;
        // The retired session's provider target goes with it: a demand
        // seam before the replacement build (an immediate `/compact`)
        // must resolve the CURRENT model through the pre-build
        // `resolve_model` fallback, not rebuild on the retired session's
        // target while a cwd/settings change waits for the prewarm.
        *self.provider_target.write().expect("provider target lock") = None;
        if let Some(engine) = built {
            // The replacement teardown also drops the compact-trigger
            // state with a version bump (TS teardown -> `requestAbort` ->
            // `_autoRefineReviewAbort.abort()`): a background review round
            // still in flight on this session resolves against the
            // bumped version and never applies its edits or surfaces its
            // rows.
            engine.session.discard_compact_auto_refine();
            // The session's telemetry ends with it (the TS dispose
            // callback the replacement teardown runs); best-effort like
            // every end path, a failed flush never fails the teardown.
            if let Some(telemetry) = &engine.telemetry {
                let _ = telemetry.end().await;
            }
            engine.dispose_kernel().await;
        }
    }

    /// Tear the built session's kernel down (TS `closeSession` ->
    /// `AgentSessionRuntime.dispose` -> `AgentSession.disposeAsync` ->
    /// `IpythonKernelProvisioner.dispose`: one final namespace snapshot,
    /// drained host requests, then the `python -m rlm.repl` process exits).
    ///
    /// The engine object survives the call: the worker process outlives its
    /// session, so the engine-drop teardown (the strong owner of the
    /// provisioner going away) cannot run yet. This is the explicit seam the
    /// worker invokes at every session end — kill, shutdown, the orphan
    /// exit — so the kernel process never outlives the session that owns it.
    pub async fn dispose_kernel(&self) {
        let guard = self.session.lock().await;
        if let Some(engine) = guard.as_deref() {
            engine.dispose_kernel().await;
        }
    }

    /// Mark the session closed (TS `runtime.dispose`'s `_disposing`/`_disposed`
    /// gates) and retire the closed runtime's continuation mirrors: the
    /// worker's kill, shutdown, and replacement closes set it first, so
    /// every continuation mint site and settle-hook retry bails — a stopped
    /// session never continues (no mint, no goal-state churn, no queued
    /// follow-up a later wake could run). The mirrors go with the marker:
    /// the engine object outlives the close (the worker process may be
    /// reused for a fresh create), and a stale settle callback must find
    /// no goal runtime to mint through — the owed slot itself survives
    /// the close in the durable state for a later resumed session.
    ///
    /// # Panics
    ///
    /// Panics when an internal mutex is poisoned (the goal runtime or the
    /// autonomous boundary lock, after a holder panicked while holding
    /// it).
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
    }

    /// The create path's live reset: a fresh (or replaced) session starts
    /// live (TS's fresh runtime starts un-disposed).
    pub fn clear_session_closed(&self) {
        self.session_closed
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    /// Whether the session is closed (TS `this._disposed || this._disposing`
    /// in the continuation resume sites).
    pub fn session_is_closed(&self) -> bool {
        self.session_closed
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Session-scoped kernel shell activity; never builds a new session/kernel.
    ///
    /// # Errors
    ///
    /// Returns an error when no session kernel is running ("Kernel is
    /// not running"), or when the kernel's own shell-activity call fails.
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

    /// Build the core session once (same once-only rule as `session_agent`),
    /// through the same guarded funnel.
    pub(crate) fn ensure_core_session(&self, model: &Model) -> anyhow::Result<()> {
        self.runtime
            .block_on(async { self.ensure_core_session_async(model).await })
    }

    /// Execute one session slash command against the built session: resolve
    /// the model, build the core session on first use, then run the pa-core
    /// executor (durable rows, compaction, goal continuation).
    pub(crate) fn execute_session_command(
        &self,
        command: &pa_core::session_engine::slash_commands::SessionSlashCommand,
    ) -> anyhow::Result<SessionCommandExecution> {
        // The session's live model (`/compact` runs a summarizer call):
        // the provider target the turn stream reads, not a fresh
        // startup-chain resolution (R8).
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
        // The lock covers the clone only (see `run_turn_once`): a
        // session command can run a summarizer model call (`/compact`),
        // so holding the mutex across the execution serialized every
        // client read seam behind it.
        let core = self
            .session
            .blocking_lock()
            .clone()
            .expect("session built by ensure_core_session");
        Ok(self
            .runtime
            .block_on(async { execute_session_command(&core, &mut params, command).await }))
    }

    /// The current explicit selection (create-config flags merged over the
    /// process fallback).
    pub(super) fn current_selection(&self) -> EngineModelSelection {
        self.selection.read().expect("model selection lock").clone()
    }

    /// Kernel host-request handlers for agent messaging and observation,
    /// routed through the worker's supervisor link. `None` outside a daemon
    /// worker: without a supervisor there is nobody to reach.
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
        Some(handlers)
    }

    /// The configured kernel cron wiring (the worker's shared store).
    pub(super) fn cron_wiring(
        &self,
    ) -> Option<pa_core::session_engine::runtime_wiring::KernelCronWiring> {
        self.config.cron_store.clone()
    }

    /// The kernel cron binding for the current session build: the live
    /// active session id (the supervisor link carries it) plus the
    /// durable session id + file from the worker-owned session file's
    /// header. `None` outside a daemon worker or before the session file
    /// exists (the engine falls back to its in-memory identity).
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
        // The live queue-delivery modes (seeded from the start config or
        // switched by `set_steering_mode`/`set_follow_up_mode`): read
        // under a scoped lock — a std guard must never ride the build's
        // awaits below.
        let (steering_mode, follow_up_mode) = {
            let modes = self.queue_modes.lock().expect("queue modes");
            (
                modes.0.as_deref().and_then(Self::queue_mode),
                modes.1.as_deref().and_then(Self::queue_mode),
            )
        };

        // The session's stream reads its target from the engine's live slot:
        // `set_model` swaps the slot so the built session follows without a
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
        // The engine session carries the session's own directory (the
        // refine path's local harness state and the session's identity)
        // while staying non-persisted: the worker owns the durable
        // session file and mirrors the entries into it. The configured
        // session dir leads; the session file's parent (the create
        // command's sessionDir) is the daemon's own fallback — the
        // engine config itself is built without one.
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
        // Children inherit the parent model selector; the engine resolves
        // the model here, after the create command set the rest of the
        // parent identity.
        if let Some(children) = &self.children {
            children.set_model(format!("{}/{}", model.provider, model.id));
        }
        // Session telemetry: the composition root is this worker process;
        // the create command's opt-out rides the engine config (TS main.ts
        // `telemetryDisabled` on the runtime config). Sinks resolve from
        // settings + env inside `build_client`.
        let telemetry = (self.config.telemetry_disabled != Some(true)).then(|| {
            let settings =
                pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir);
            pa_core::session_engine::telemetry::TelemetryWiring {
                client: pa_core::session_engine::telemetry::build_client(
                    &settings,
                    &self.config.agent_dir,
                ),
                execution_mode: Some("daemon".to_string()),
                now: None,
            }
        });
        // Bound before the awaited build: the purge-clone binding must not
        // hold the lock guard across the await.
        let queued_goal_context_purge = self
            .goal_queue_purge
            .lock()
            .expect("goal queue purge lock")
            .clone();
        // TS `AgentSession` wires `onBackgroundWorkSettled` onto the kernel
        // provisioner (agent-session.ts): the kernel's last live background
        // `bash()` handle settling — or the kernel tearing down while one
        // runs — retries the owed continuations, the same resume pair the
        // RLM child settlement sites fire. An engine without a registered
        // arc (direct-construction harnesses) wires nothing, exactly like
        // the in-run autonomous hook.
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
        pa_core::session_engine::engine::create_session(SessionEngineConfig {
            telemetry,
            cwd,
            // TS settings.imageModel routing: the daemon owns the routing
            // (the armed route overrides the serving target + the run's
            // model); the headless surfaces pass `None` to keep their own.
            image_model_router: None,
            agent_dir: self.config.agent_dir.clone(),
            mcp_manager: Some(std::sync::Arc::clone(&self.mcp)),
            model: Some(agent_model),
            thinking_level: Some(map_thinking_level(self.effective_thinking())),
            stream_fn: Some(stream_fn),
            // Model tools: `ipython` only (kernel-resident bash/edit parity);
            // the engine adds the kernel-backed `ipython` tool itself.
            tools: vec![],
            custom_system_prompt: None,
            prompt_guidelines: vec![],
            generic_mcp_servers: vec![],
            allow_recursion: None,
            session_manager: Some(session_manager),
            extra_host_handlers: self.extra_host_handlers(),
            conversation_log_path: session_file,
            additional_skill_paths: vec![],
            additional_prompt_paths: vec![],
            extra_builtin_skill_overrides: vec![],
            rlm_subagent_host: self.children.clone().map(|children| {
                children as Arc<dyn pa_core::session_engine::rlm_host::RlmSubagentHost>
            }),
            rlm_depth: Some(self.rlm_depth.load(std::sync::atomic::Ordering::Relaxed)),
            model_info: Some(model.clone()),
            // The daemon worker has no CLI extension sources: sessions
            // load configured/discovered extensions only (the attached
            // TUI/ACP surfaces do not carry `-e` flags today).
            cli_extension_sources: vec![],
            extension_tool_allow_list: None,
            // TS main.ts `createDefaultRuntimeFactory` passes
            // `prewarmIpythonKernel: true` for every session it hosts; the
            // engine's depth gate keeps subagent workers (rlmDepth > 0) on
            // the lazy first-call start, exactly like the TS session's
            // `rlmDepth === 0` check.
            prewarm_ipython_kernel: Some(true),
            on_background_work_settled,
            // TS `_clearQueuedGoalContexts` (the session-command sites and
            // the kernel's `goal.complete`): the worker-installed queue
            // purge, so the session engine's surfaces withdraw queued
            // minted continuations.
            queued_goal_context_purge,
            // TS `_steeringStopPending`: the worker's steering lane owns
            // the stop hooks (a queued steer cuts the run at the next
            // turn boundary; the runner delivers it as the next turn).
            queued_steering_probe: self.config.queued_steering_probe.clone(),
            // TS `sdk.ts` seeds the Agent's queue modes from the settings
            // manager; the worker create reads the same settings (the
            // engine-level queues drain per the mode at the loop
            // boundary, mirroring the worker lane's delivery modes). The
            // live switch (`set_steering_mode`/`set_follow_up_mode`)
            // updates the same slot ahead of any later build. The lock
            // is scoped to the read (a guard must never ride the build's
            // awaits).
            steering_mode,
            follow_up_mode,
            // The worker's shared scheduled-jobs store with the session
            // identity the kernel binding needs: the live active session
            // id the supervisor routes commands by, and the durable session
            // id + file the store partitions and rebinds by. Both come from
            // the worker-owned session (the engine's in-memory manager
            // carries neither), so the enrichment runs per build.
            cron_store: self.cron_wiring().map(|mut wiring| {
                wiring.binding = self.kernel_cron_binding().or(wiring.binding);
                wiring
            }),
        })
        .await
        .inspect(|engine| {
            // A queue-mode switch that landed while this build was in
            // flight wrote only the live slot (the build snapshot above
            // predates it, and the agent handle did not exist yet): re-
            // apply the current modes to the freshly built agent so the
            // first build can never serve a stale mode (TS's agent is
            // built once per session, so the race does not exist there;
            // this port's lazy build needs the catch-up).
            let (steering_mode, follow_up_mode) = {
                let modes = self.queue_modes.lock().expect("queue modes");
                (
                    modes.0.as_deref().and_then(Self::queue_mode),
                    modes.1.as_deref().and_then(Self::queue_mode),
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
