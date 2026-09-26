//! Session creation and reuse on the worker: the create command's
//! construction of the live session.
use super::*;

use serde_json::Value;

use crate::protocol::DaemonResponse;

impl Worker {
    pub(super) async fn handle_create(&self, payload: &Value) -> DaemonResponse {
        // One create in flight at a time (TS `openingSessions`): the
        // created check, the session-model restore's awaits, and the core
        // initialization below are one serialized critical section, so a
        // concurrent create joins this open and answers with the created
        // summary below instead of racing a second initialization.
        let _create_gate = self.create_gate.lock().await;
        {
            let core = self.core.lock().unwrap();
            if core.created {
                // Idempotent re-create after a supervisor restart or respawn.
                let summary = self.summary_locked(&core);
                return response_success(
                    None,
                    "create",
                    Some(serde_json::to_value(&summary).unwrap_or(Value::Null)),
                );
            }
        }
        let session_path = match payload.get("sessionPath").and_then(Value::as_str) {
            Some(path) => match paths::expand_tilde(path) {
                Ok(expanded) => Some(expanded),
                Err(error) => return response_failure(None, "create", &error.to_string(), None),
            },
            None => None,
        };
        let no_session = payload
            .get("noSession")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let name = payload.get("name").and_then(Value::as_str);
        let flagged_model = payload.get("model").and_then(Value::as_str).is_some();
        // TS createAgentSession's restored-from-session step: a revived
        // session (an existing session file — scheduled wake, update
        // restore, worker relaunch) restores the model its file pins
        // before the startup chain. The bounded readiness wait covers the
        // daemon boot's catalog fetch, so the revived session keeps the
        // model it was running on instead of silently landing on the
        // featured default while the catalog settles. An explicit model
        // flag on the create wins instead (TS `options.model` takes
        // priority over the saved session model): the restore is skipped
        // entirely, so a flagged create never eats the readiness window or
        // records a fallback that would not be used.
        // Explicit model flags from the create config are authoritative for
        // this worker's session runtime config (TS runtime-config
        // propagation): the engine rebinds its selection instead of
        // falling back to a process-wide model, and the folded flags
        // survive every session replacement (TS `sessionConfig`).
        let requested_thinking = match payload.get("thinking") {
            None => None,
            Some(Value::String(level)) => {
                match pa_ai::models::thinking_level_from_str(level) {
                    Some(level) => Some(level),
                    // The wire contract takes validated levels only: reject
                    // the create loudly instead of silently dropping it.
                    None => {
                        return response_failure(
                            None,
                            "create",
                            &format!("Invalid thinking level \"{level}\". Valid values: off, minimal, low, medium, high, xhigh, max"),
                            None,
                        );
                    }
                }
            }
            Some(_) => {
                return response_failure(
                    None,
                    "create",
                    "Invalid thinking level: expected a string",
                    None,
                );
            }
        };
        self.engine.configure_create_model(EngineModelSelection {
            provider: payload
                .get("provider")
                .and_then(Value::as_str)
                .map(str::to_string),
            model: payload
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            api_key: payload
                .get("apiKey")
                .and_then(Value::as_str)
                .map(str::to_string),
            thinking: requested_thinking,
        });
        let cwd = payload
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("/")
            .to_string();
        let session_dir = match payload.get("sessionDir").and_then(Value::as_str) {
            Some(dir) => match paths::expand_tilde(dir) {
                Ok(expanded) => expanded,
                Err(error) => return response_failure(None, "create", &error.to_string(), None),
            },
            None => match paths::sessions_dir(&self.config.agent_dir) {
                Ok(dir) => dir,
                Err(error) => return response_failure(None, "create", &error.to_string(), None),
            },
        };
        // RLM recursion identity (children of an RLM parent run at depth+1):
        // the durable create replays these so a respawned child keeps them.
        let (rlm_depth, rlm_max_depth) = match create_payload_rlm_depth(payload) {
            Ok(identity) => identity,
            Err(error) => return response_failure(None, "create", &error, None),
        };
        let parent_session_path = payload
            .get("parentSessionPath")
            .and_then(Value::as_str)
            .map(str::to_string);
        // The subagent runtime identity (TS `runtimeMetadata` on the create
        // command): the child id and the parent's live/persisted ids ride
        // the session summaries so the roster can key children
        // `parentPath#childId` like TS `rosterAgentIdForSummary`.
        let (rlm_child_id, parent_active_session_id, parent_session_id) = match payload
            .get("runtimeMetadata")
        {
            Some(metadata) if metadata.get("kind").and_then(Value::as_str) == Some("subagent") => (
                metadata
                    .get("rlmChildId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                metadata
                    .get("parentActiveSessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                metadata
                    .get("parentSessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            ),
            _ => (None, None, None),
        };
        let thinking = payload
            .get("thinking")
            .and_then(Value::as_str)
            .map(str::to_string);
        // Verification seam (the TS child runtime inherits the parent's
        // `sessionConfig`): a scripted parent session passes its children's
        // engine file down the recursion. Product creates carry `None`.
        let child_script = payload
            .get("childScript")
            .and_then(Value::as_str)
            .map(str::to_string);

        let mut store = match (&session_path, no_session) {
            (Some(path), false) if path.exists() => {
                let loaded = {
                    let path = path.clone();
                    let agent_dir = self.config.agent_dir.clone();
                    tokio::task::spawn_blocking(move || {
                        let lease = crate::lease::acquire_runtime_session_lease(&path, &agent_dir)?;
                        let mut store = SessionFile::open_windowed(&path)?;
                        store.lease = Some(Arc::new(lease));
                        Ok(store)
                    })
                    .await
                    .map_err(anyhow::Error::from)
                    .and_then(|result| result)
                };
                match loaded {
                    Ok(mut opened) => {
                        // The engine owns the file from here on (the open
                        // succeeded): the session-model restore binds the
                        // engine and records its decision only for a path
                        // this worker actually opened — a failed open (a
                        // held lease, an unreadable file) never leaks the
                        // binding into a later create's session. The
                        // create's own flags were folded before this; a
                        // flagged create still skips the restore (an
                        // explicit model wins end-to-end, TS
                        // `options.model`).
                        self.engine.set_session_file(path.clone());
                        if !flagged_model {
                            self.engine.restore_session_model(path).await;
                        }
                        let restored = opened.restored_settings();
                        // TS createAgentSession restores the session
                        // file's saved thinking level when the create
                        // carries no explicit flag (sdk.ts
                        // `hasThinkingEntry ? existingSession.thinkingLevel`).
                        // The saved MODEL restores through the engine's
                        // session-model restore (the bounded readiness
                        // window, the exact-match path, the published
                        // fallback) — never this direct adoption, which
                        // would bypass the window the fleet-kill
                        // forensics pinned.
                        self.engine.configure_model(EngineModelSelection {
                            provider: None,
                            model: None,
                            api_key: None,
                            thinking: requested_thinking.or_else(|| {
                                opened
                                    .has_thinking_level()
                                    .then(|| {
                                        pa_ai::models::thinking_level_from_str(
                                            &restored.thinking_level,
                                        )
                                    })
                                    .flatten()
                            }),
                        });
                        let append_start = opened.entries.len();
                        append_creation_prefix(
                            &mut opened,
                            self.engine.as_ref(),
                            &self.config.agent_dir,
                            &cwd,
                            false,
                        );
                        let _ = opened.append_session_state("active");
                        let persisted = if opened.window.is_some() {
                            opened.persist_appended(append_start)
                        } else {
                            opened.rewrite()
                        };
                        if let Err(error) = persisted {
                            return response_failure(None, "create", &error.to_string(), None);
                        }
                        opened
                    }
                    Err(error) => return crate::hold_refusal::create_failure_response(&error),
                }
            }
            (Some(path), false) => {
                let mut created = SessionFile::create(
                    &cwd,
                    parent_session_path.as_deref(),
                    rlm_depth.unwrap_or(0),
                );
                created.set_path(path.clone());
                let acquired = {
                    let path = path.clone();
                    let agent_dir = self.config.agent_dir.clone();
                    tokio::task::spawn_blocking(move || {
                        crate::lease::acquire_runtime_session_lease(&path, &agent_dir)
                    })
                    .await
                    .map_err(anyhow::Error::from)
                    .and_then(|lease| lease)
                };
                match acquired {
                    Ok(lease) => created.lease = Some(Arc::new(lease)),
                    Err(error) => return crate::hold_refusal::create_failure_response(&error),
                }
                if let Err(error) = created.rewrite() {
                    return response_failure(None, "create", &error.to_string(), None);
                }
                append_creation_prefix(
                    &mut created,
                    self.engine.as_ref(),
                    &self.config.agent_dir,
                    &cwd,
                    true,
                );
                let _ = created.append_session_state("active");
                if let Err(error) = created.rewrite() {
                    return response_failure(None, "create", &error.to_string(), None);
                }
                created
            }
            // In-memory session: no file, like the TS `noSession` create.
            (None, true) => {
                let mut created = SessionFile::create(
                    &cwd,
                    parent_session_path.as_deref(),
                    rlm_depth.unwrap_or(0),
                );
                append_creation_prefix(
                    &mut created,
                    self.engine.as_ref(),
                    &self.config.agent_dir,
                    &cwd,
                    true,
                );
                created
            }
            (None, false) => {
                let mut created = SessionFile::create(
                    &cwd,
                    parent_session_path.as_deref(),
                    rlm_depth.unwrap_or(0),
                );
                let path = session_dir.join(session_file_name(created.session_id()));
                created.set_path(path.clone());
                let acquired = {
                    let path = path.clone();
                    let agent_dir = self.config.agent_dir.clone();
                    tokio::task::spawn_blocking(move || {
                        crate::lease::acquire_runtime_session_lease(&path, &agent_dir)
                    })
                    .await
                    .map_err(anyhow::Error::from)
                    .and_then(|lease| lease)
                };
                match acquired {
                    Ok(lease) => created.lease = Some(Arc::new(lease)),
                    Err(error) => return crate::hold_refusal::create_failure_response(&error),
                }
                if let Err(error) = created.rewrite() {
                    return response_failure(None, "create", &error.to_string(), None);
                }
                append_creation_prefix(
                    &mut created,
                    self.engine.as_ref(),
                    &self.config.agent_dir,
                    &cwd,
                    true,
                );
                let _ = created.append_session_state("active");
                if let Err(error) = created.rewrite() {
                    return response_failure(None, "create", &error.to_string(), None);
                }
                created
            }
            (Some(_), true) => {
                return response_failure(
                    None,
                    "create",
                    "Session cannot be both no-session and session-pathed",
                    None,
                )
            }
        };

        if let Some(name) = name.filter(|n| !n.trim().is_empty()) {
            if let Err(error) = store.persist_entry("session_info", json!({ "name": name.trim() }))
            {
                return response_failure(None, "create", &error.to_string(), None);
            }
        }
        let restored_tier = store
            .has_service_tier()
            .then(|| store.restored_settings().service_tier);
        // Restore the persisted queue snapshot (crash/respawn recovery) from
        // the worker recovery journal.
        let (steering, follow_up) = {
            let guard = self.recovery.lock().unwrap();
            match guard.as_ref() {
                Some(journal) => restore_queue_snapshot(journal, &self.config.active_session_id),
                None => (VecDeque::new(), VecDeque::new()),
            }
        };
        // The worker owns the session file; the engine reads it for the
        // system prompt's conversation-log path and the local harness dir.
        if !store.path.as_os_str().is_empty() {
            self.engine.set_session_file(store.path.clone());
        }
        // The session's settings-seeded switches (TS createAgentSession:
        // the service tier, the queue delivery modes, and the auto-compaction
        // toggle come from the settings manager; the durable prefix records
        // the same tier). The TS connection state reads the settings value,
        // so a restarted session re-seeds its flag from the persisted
        // `compaction.enabled`.
        let (service_tier, steering_mode, follow_up_mode, auto_compaction_enabled) = {
            let settings = pa_core::settings::SettingsManager::create(&cwd, &self.config.agent_dir);
            let queue_mode = |mode: pa_core::settings::QueueModeSetting| -> String {
                match mode {
                    pa_core::settings::QueueModeSetting::All => "all".to_string(),
                    pa_core::settings::QueueModeSetting::OneAtATime => "one-at-a-time".to_string(),
                }
            };
            (
                settings.get_default_service_tier(),
                queue_mode(settings.get_steering_mode()),
                queue_mode(settings.get_follow_up_mode()),
                settings.get_compaction_enabled(),
            )
        };
        self.engine
            .configure_service_tier(restored_tier.unwrap_or(Some(service_tier)));
        // The abort supervision's terminal record (the supervisor declared
        // a wedged run aborted and injected it into this create replay):
        // the rebuilt transcript discloses the abort with the same
        // `compaction_outcome` row the worker's own auto-abort arms
        // persist. A manual run persists nothing — TS `compact()`'s abort
        // arm writes no durable row. The row is identity-stamped with the
        // declaration (`declaredAt`): a replacement that persisted it and
        // died before the supervisor consumed the record replays the same
        // declaration. The dedup matches the row's fields alone — a
        // worker that persisted its own cancelled row for the same run
        // (its abort arm ran, then the worker died before its
        // `compaction_end` reached the supervisor) carries the persist-
        // time stamp, not the declaration, and the replay must recognize
        // it instead of appending a second row for the one abort.
        let interrupted_compaction_requested = payload.get("interruptedCompaction").is_some();
        let interrupted_compaction = crate::compaction::interrupted_compaction_disclosure(payload);
        // The disclosure row's landing state for this replay: `true` when
        // the rebuilt transcript now holds the exact row (persisted here,
        // or already present from an earlier crash-replay), `false` when
        // the persist failed — the create reply carries it so the
        // supervisor consumes the terminal record only once the
        // disclosure is durable; a failed persist keeps it pending for
        // the next replacement to retry. A requested record with no
        // disclosure row (a manual run — TS `compact()`'s abort arm
        // writes none) is vacuously durable and reports `true`, so the
        // record is consumed instead of re-injecting forever. No
        // requested record adds no key: client-facing create replies
        // stay byte-identical to the TS shape.
        let mut interrupted_compaction_persisted = interrupted_compaction_requested;
        // The core lock stays inside this block: everything after it may
        // await (the schedule-catalog bind), and a std MutexGuard must
        // never ride an await point.
        let (summary, rlm_depth) = {
            let mut core = self.core.lock().unwrap();
            core.cwd = cwd;
            core.steering = steering;
            core.follow_up = follow_up;
            core.store = Some(store);
            if let Some(disclosure) = &interrupted_compaction {
                if let Some(store) = core.store.as_mut() {
                    let already_disclosed = store.entries().iter().any(|entry| {
                        entry.type_ == "custom_message" && entry.fields == disclosure.row
                    });
                    if !already_disclosed
                        && store
                            .persist_entry_at(
                                "custom_message",
                                disclosure.row.clone(),
                                &disclosure.declared_at,
                            )
                            .is_err()
                    {
                        interrupted_compaction_persisted = false;
                    }
                }
            }
            core.created = true;
            core.abort_requested = false;
            // A fresh (or replaced) session starts live: the previous
            // close's `session_closed` marker clears with the new session
            // (TS's fresh runtime starts un-disposed).
            if let Some(agent_engine) = &self.agent_engine {
                agent_engine.clear_session_closed();
            }
            core.auto_compaction_enabled = auto_compaction_enabled;
            core.service_tier = restored_tier.unwrap_or(Some(service_tier));
            core.steering_mode.clone_from(&steering_mode);
            core.follow_up_mode.clone_from(&follow_up_mode);
            core.forced_all_steering = false;
            core.scoped_models = Vec::new();
            core.retry_abort_requested = false;
            // The session's depth falls back to the opened file's header (TS
            // `config.rlmDepth ?? header.rlmDepth`): a resumed saved subagent
            // session keeps its persisted depth. The runtime kind keeps the
            // create's runtime identity (TS `metadata.kind`) — a resumed
            // subagent file is a top-level runtime that merely carries its
            // persisted depth, so the roster does not re-nest it under its
            // original parent.
            let rlm_depth = rlm_depth
                .or_else(|| core.store.as_ref().and_then(SessionFile::rlm_depth))
                .unwrap_or(0);
            core.rlm_depth = rlm_depth;
            core.runtime_kind = if rlm_child_id.is_some() {
                "subagent".to_string()
            } else {
                "top-level".to_string()
            };
            core.rlm_child_id = rlm_child_id;
            core.parent_active_session_id = parent_active_session_id;
            core.parent_session_id = parent_session_id;
            core.child_script.clone_from(&child_script);
            (self.summary_locked(&core), rlm_depth)
        };
        // TS `sdk.ts` seeds the Agent's queue modes from the settings
        // manager at session create (`steeringMode`/`followUpMode`): the
        // engine's agent-level queues drain per the same modes the worker
        // lane delivers by. Scripted harness engines keep the no-op.
        self.engine
            .set_queue_modes(Some(&steering_mode), Some(&follow_up_mode));
        // Seed the engine's RLM identity: recursion depth and bound, this
        // session's persistence ids, the default thinking level its
        // children inherit, and the harness's child engine file.
        if let Err(error) = self.engine.configure_rlm_identity(RlmSessionIdentity {
            rlm_depth,
            rlm_max_depth,
            cwd: Some(summary.cwd.clone()),
            session_id: Some(summary.session_id.clone()),
            session_file: summary.session_file.clone(),
            thinking,
            child_script: child_script.clone(),
        }) {
            return response_failure(None, "create", &error.to_string(), None);
        }
        // The engine renders this summary into the sender identity block
        // of worker-to-worker agent messages.
        if let Ok(summary_value) = serde_json::to_value(&summary) {
            self.engine.set_session_summary(summary_value);
        }
        // TS create builds the AgentSession eagerly
        // (`createAgentSessionFromServices` inside the create handler —
        // where the kernel prewarm fires). The Rust worker keeps the
        // create response model-independent, so the build runs in the
        // background instead: the prewarm starts at create, the build
        // gate deduplicates it against any racing demand seam, and a
        // build failure still surfaces on the first demand seam exactly
        // as before. Scripted harness engines have no session to build.
        if let Some(agent_engine) = &self.agent_engine {
            let engine = std::sync::Arc::clone(agent_engine);
            tokio::spawn(async move {
                let Ok(model) = engine.resolve_model() else {
                    return;
                };
                let _ = engine.ensure_core_session_async(&model).await;
            });
        }
        // Bind the schedule catalog onto the session (artifact partition,
        // job rebind, scheduler start) — TS `rebindCronJobsToState`.
        self.bind_scheduled_jobs().await;
        // Recovery journal writes must not happen while holding the core
        // lock: record_recovery locks the core to read the store.
        let _ = self.record_recovery(true, "create");
        let session_id = summary.session_id.clone();
        if let Some(registration) = &self.registration {
            registration.notify_session_created(session_id);
        }
        // TS session boot resolves the initial model through
        // `refreshAvailableModels`, which also fetches the live Prime
        // Inference catalog in the background and caches it on disk. Fire
        // the same refresh here: the effect is the cache file (fresh
        // registries read it), and failures fall back to the cached or
        // bundled catalog without touching the session.
        let agent_dir = self.config.agent_dir.clone();
        tokio::spawn(async move {
            let auth = pa_core::auth::AuthStorage::create(&agent_dir);
            let mut registry =
                pa_core::models::ModelRegistry::create(auth, agent_dir.join("models.json"));
            let _ = registry.refresh_available_models().await;
        });
        self.work_notify.notify_one();
        // Warm the context-tree cache at session open: the background walk
        // fills the cache while the client settles, so an early `/context`
        // answers from it instead of walking the artifact tree inline.
        self.poke_context_tree_refresh();
        // The delete boundary invalidates the cache's rows for the deleted
        // child immediately (the next background refresh would otherwise
        // keep its last row through the settled-children backfill).
        if let Some(agent_engine) = &self.agent_engine {
            if let Some(children) = &agent_engine.children {
                let cache = std::sync::Arc::clone(&self.context_tree);
                children.set_delete_notifier(std::sync::Arc::new(move |child_id| {
                    cache.invalidate_child(child_id);
                }));
            }
        }
        let mut data = serde_json::to_value(&summary).unwrap_or(Value::Null);
        if interrupted_compaction_requested {
            data["interruptedCompactionPersisted"] =
                serde_json::json!(interrupted_compaction_persisted);
        }
        // A resumed create just rebuilt the store from the session file:
        // its load copies (window walks, parsed entry trees) are dropped
        // by now — return that freed heap to the OS so the load's peak
        // does not stay resident.
        pa_types::memory_release::trim_freed_heap();
        response_success(None, "create", Some(data))
    }
}

pub(super) fn active_session_id_of(payload: &[u8]) -> String {
    serde_json::from_slice::<Value>(payload)
        .ok()
        .and_then(|value| {
            value
                .get("activeSessionId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

pub(super) fn worker_server_capabilities() -> Vec<String> {
    default_server_capabilities()
}

/// RLM depth fields of a create payload: `(depth, max_depth)`. Values must
/// be non-negative integers that fit a u32; anything else fails the create
/// instead of silently truncating.
fn create_payload_rlm_depth(payload: &Value) -> Result<(Option<u32>, Option<u32>), String> {
    fn parse(payload: &Value, key: &str) -> Result<Option<u32>, String> {
        match payload.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .map(Some)
                .ok_or_else(|| format!("create {key} must be a non-negative integer")),
        }
    }
    let depth = parse(payload, "rlmDepth")?;
    let max_depth = parse(payload, "rlmMaxDepth")?;
    Ok((depth, max_depth))
}

/// Creation prefix for a daemon-hosted session file (TS `createAgentSession`
/// in the worker process): fresh files record `model_change` (when the engine
/// resolves a model), `thinking_level_change`, and `service_tier_change`; a
/// reopened session records the thinking level and service tier only when no
/// earlier entry set them. The recorded thinking level is the engine's
/// effective one — the create-config flag (else settings default/medium)
/// clamped to the model's supported levels; engines without a model
/// resolution (the scripted harness) record "off".
fn append_creation_prefix(
    store: &mut SessionFile,
    engine: &dyn SessionEngine,
    agent_dir: &std::path::Path,
    cwd: &str,
    fresh: bool,
) {
    let has_thinking_entry = store.has_thinking_level();
    let has_service_tier_entry = store.has_service_tier();
    let thinking_level = engine
        .effective_thinking_level()
        .unwrap_or_else(|| "off".to_string());
    if fresh {
        if let Some((provider, model_id)) = engine.creation_model() {
            store.append_model_change(&provider, &model_id);
        }
        store.append_thinking_level_change(&thinking_level);
    } else if !has_thinking_entry {
        store.append_thinking_level_change(&thinking_level);
    }
    if fresh || !has_service_tier_entry {
        let settings = pa_core::settings::SettingsManager::create(cwd, agent_dir);
        let service_tier = settings.get_default_service_tier();
        store.append_entry(
            "service_tier_change",
            json!({ "serviceTier": service_tier }),
        );
    }
}
