//! `rlm.spawn` admission: the depth gate, spawn-name reservation, model
//! resolution, the in-process child engine assembly, and the detached run
//! task. The kernel-visible order matches the daemon host: the handle
//! returns once the child session durably exists (its record registered),
//! and the task prompt runs detached behind the parent's turn boundary.

use std::sync::Arc;

use pa_agent::types::ThinkingLevel;

use super::super::engine::{create_session, SessionEngine, SessionEngineConfig};
use super::super::rlm_host::{RlmHostFuture, RlmSpawnHandle, RlmSpawnRequest};
use super::registry::{rlm_child_label, InProcessChildRecord};
use super::run::run_child_task;
use super::{InProcessRlmHost, ParentFacts};
use crate::kernel::rlm_runtime::create_default_rlm_subagent_session_name;
use crate::session::manager::{NewSessionOptions, SessionManager};

/// The spawn admission: gate, reserve the requested name, resolve the
/// model, build the child engine, register the record, detach the run,
/// return the handle.
pub(super) fn spawn(
    host: InProcessRlmHost,
    request: RlmSpawnRequest,
) -> RlmHostFuture<RlmSpawnHandle> {
    Box::pin(async move {
        let depth = host.rlm_depth();
        let max_depth = host.max_depth();
        if depth >= max_depth {
            anyhow::bail!(
                "RLM recursion depth limit reached (RLM_DEPTH={depth}, RLM_MAX_DEPTH={max_depth})"
            );
        }
        let (parent_engine, facts) = host.parent()?;
        let parent_engine = parent_engine
            .upgrade()
            .ok_or_else(|| anyhow::anyhow!("the parent session is no longer running"))?;
        let child_id = format!("sub-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let name = request.name.clone().unwrap_or_else(|| {
            create_default_rlm_subagent_session_name(&request.prompt, &child_id)
        });
        // TS #2396: a requested name is reserved before the first await
        // and held until admission settles, so two parallel same-name
        // spawns cannot both admit. A default name embeds its fresh child
        // id and never reserves. The RAII guard owns the release: it frees
        // the name at the settle, on every failure path, and on
        // cancellation (a dropped host future) alike.
        let _reservation = match request.name {
            Some(_) => {
                if !host.reserve_spawn_name(&name) {
                    anyhow::bail!(super::registry::spawn_name_unavailable(&name, depth + 1));
                }
                Some(SpawnNameReservation {
                    host: Some(host.clone()),
                    name: name.clone(),
                })
            }
            None => None,
        };
        host.assert_name_available(&name, depth + 1).await?;
        let (record, model) = admission(
            &host,
            &request,
            &facts,
            &child_id,
            &name,
            parent_engine,
            depth,
        )
        .await?;
        if !host.push_child(Arc::clone(&record)).await {
            anyhow::bail!("the parent session closed during child admission");
        }
        // The reservation's guard is still bound: its release at this
        // scope's end transfers the name from the pending set to the
        // registered record (a successful admission made the name
        // durable through the registry).
        let run_host = host.clone();
        let run_record = Arc::clone(&record);
        let prompt = request.prompt.clone();
        tokio::spawn(async move {
            run_child_task(run_host, run_record, prompt).await;
        });
        Ok(RlmSpawnHandle {
            rlm_child_id: child_id,
            name,
            session_dir: record.session_dir.clone(),
            model,
        })
    })
}

/// The heavyweight admission half: resolve the model, build the child
/// engine in-process, and register the record. Every failure path
/// releases the name reservation through the guard.
#[allow(clippy::too_many_arguments)]
async fn admission(
    host: &InProcessRlmHost,
    request: &RlmSpawnRequest,
    facts: &ParentFacts,
    child_id: &str,
    name: &str,
    parent_engine: Arc<SessionEngine>,
    depth: u32,
) -> anyhow::Result<(Arc<InProcessChildRecord>, String)> {
    let config = host.config();
    let parent_state = parent_engine.session.agent().state().await;
    let resolved = super::model::resolve_child_model(
        &config.registry,
        request.model.as_deref(),
        Some(&parent_state.model),
        "subagent",
    )?;
    super::model::assert_thinking_supported(
        &config.registry,
        request.thinking.as_deref(),
        &resolved.selector,
    )?;
    // The inherited thinking level: the request first, then the parent's
    // live level (the engine stores the debug-lowercase wire name), then
    // the host default.
    let parent_thinking = Some(format!("{:?}", parent_state.thinking_level).to_lowercase());
    let thinking = request
        .thinking
        .clone()
        .or(parent_thinking)
        .or_else(|| config.default_thinking.clone());
    // The per-child session dir under the parent's artifacts tree (TS
    // `_createChildRlmSessionDir`); the child session persists inside it.
    let session_dir = config
        .agent_dir
        .join("session-artifacts")
        .join(&facts.session_id)
        .join(child_id);
    std::fs::create_dir_all(&session_dir).map_err(|error| {
        anyhow::anyhow!(
            "create RLM child session dir {}: {error}",
            session_dir.display()
        )
    })?;
    let mut session_manager = SessionManager::persisted(&facts.cwd, &session_dir);
    session_manager.new_session(&NewSessionOptions {
        id: None,
        parent_session: facts.session_file.clone(),
        rlm_depth: Some(u64::from(depth) + 1),
    });
    // The session name is durable session state, not registry metadata:
    // the child's own observe row, its message senders, and any resumed
    // child file read it (TS guest `createGuestSubagentRuntime` sets it on
    // the session). It lands before the engine build, so the handle
    // publishes a fully-admitted child.
    session_manager
        .append_session_info(name)
        .map_err(|error| anyhow::anyhow!("persist RLM child session name: {error}"))?;
    // The child's own children host: grandchildren spawn through it, with
    // this parent's depth bound inherited one level down.
    // The child's own children host: grandchildren spawn through it, with
    // this parent's depth bound inherited one level down. The remote
    // family surface is the resident root's composition concern — child
    // hosts stay local-only (their family is entirely in-process).
    let child_host = Arc::new(InProcessRlmHost::new(super::InProcessRlmHostConfig {
        agent_dir: config.agent_dir.clone(),
        registry: config.registry.clone(),
        stream_fn_factory: config.stream_fn_factory.clone(),
        rlm_depth: depth + 1,
        rlm_max_depth: config.rlm_max_depth,
        default_thinking: thinking.clone(),
        remote_family: None,
        root_runtime_kind: None,
    }));
    child_host.set_parent_host(host);
    let engine = Arc::new(
        create_session(SessionEngineConfig {
            cwd: facts.cwd.clone(),
            agent_dir: config.agent_dir.clone(),
            model: Some(resolved.model.clone()),
            thinking_level: thinking.as_deref().map(thinking_level),
            stream_fn: Some((config.stream_fn_factory)(&resolved.model)),
            tools: Vec::new(),
            session_manager: Some(session_manager),
            rlm_depth: Some(depth + 1),
            rlm_subagent_host: Some(child_host.clone()),
            extra_host_handlers: Some(super::family::family_host_handlers(
                &child_host,
                super::family::FamilySelf::Child {
                    child_id: child_id.to_string(),
                },
            )),
            // Subagents never double-report telemetry and never prewarm
            // (the engine's own depth gate enforces both); the remaining
            // knobs keep the daemon child defaults.
            telemetry: None,
            prewarm_ipython_kernel: None,
            ..Default::default()
        })
        .await?,
    );
    child_host.bind_parent(Arc::clone(&engine)).await?;
    let session_id = engine.session.session_id().await;
    let label = rlm_child_label(&request.prompt);
    let record = Arc::new(InProcessChildRecord::new(
        child_id.to_string(),
        name.to_string(),
        session_id,
        session_dir.display().to_string(),
        label,
        super::now_ms(),
        engine,
        Arc::downgrade(&parent_engine),
        facts.session_id.clone(),
        child_host,
    ));
    Ok((record, resolved.selector))
}

/// One validated wire thinking level as the engine's enum (the request
/// validated the string upstream; an unknown level falls back to off like
/// an unset one).
fn thinking_level(level: &str) -> ThinkingLevel {
    match level {
        "minimal" => ThinkingLevel::Minimal,
        "low" => ThinkingLevel::Low,
        "medium" => ThinkingLevel::Medium,
        "high" => ThinkingLevel::High,
        "xhigh" => ThinkingLevel::Xhigh,
        "max" => ThinkingLevel::Max,
        // "off" (and any unknown level, already validated upstream) stays off.
        _ => ThinkingLevel::Off,
    }
}

/// One held spawn-name reservation; released at scope end (admission
/// settled or failed) and on cancellation alike (TS #2396).
struct SpawnNameReservation {
    host: Option<InProcessRlmHost>,
    name: String,
}

impl Drop for SpawnNameReservation {
    fn drop(&mut self) {
        if let Some(host) = self.host.take() {
            host.release_spawn_name(&self.name);
        }
    }
}
