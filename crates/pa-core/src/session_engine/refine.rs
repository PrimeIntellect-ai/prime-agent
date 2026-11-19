//! Session-level /refine: message builders, history merge, and the
//! plan -> re-read -> apply -> persist flow.

use std::path::{Path, PathBuf};

use pa_types::ai::{UserContent, UserMessage};
use pa_types::session::{AgentMessage, CustomMessage, FileEntry};
use serde_json::json;

use super::model_usage::ModelUsage;
use super::AgentSession;
use crate::refinement::executor::{
    apply_refinement_plan, plan_refinement, review_auto_refine, AutoRefineReview,
    AutoRefineReviewContext, RefineOptions as CoreRefineOptions, RefinementPlan,
};
use crate::refinement::{
    append_global_refinement, format_refinement_notice_body, load_global_refinement_history,
    load_harness_state, merge_harness_states, HarnessScope, RefinementResult,
};
use crate::session::manager::SessionManager;

pub const REFINEMENT_AUDIT_CUSTOM_TYPE: &str = "prime-agent.refinement";
pub const REFINEMENT_OUTCOME_CUSTOM_TYPE: &str = "refinement_outcome";
/// Model-facing notice custom type (display=false).
pub const REFINEMENT_NOTICE_CUSTOM_TYPE: &str = "refinement_notice";

pub const AUTO_REFINE_COMPACT_REASON: &str = "compact";

/// The resolved auto-refine gates: the settings block with the product
/// defaults and clamps applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AutoRefineGates {
    pub enabled: bool,
    pub turn_interval: u64,
    pub compact: bool,
    pub cooldown_ms: u64,
}

impl Default for AutoRefineGates {
    fn default() -> Self {
        Self {
            enabled: true,
            turn_interval: 25,
            compact: true,
            cooldown_ms: 20 * 60 * 1000,
        }
    }
}

impl AutoRefineGates {
    /// The interval clamps to at least 1.
    #[must_use]
    pub fn from_settings(raw: Option<&crate::settings::AutoRefineSettings>) -> Self {
        let Some(raw) = raw else {
            return Self::default();
        };
        let defaults = Self::default();
        Self {
            enabled: raw.enabled.unwrap_or(defaults.enabled),
            turn_interval: raw.turn_interval.unwrap_or(defaults.turn_interval).max(1),
            compact: raw.compact.unwrap_or(defaults.compact),
            cooldown_ms: raw.cooldown_ms.unwrap_or(defaults.cooldown_ms),
        }
    }
}

/// The instructions an approved review carries into the run.
#[must_use]
pub fn auto_refine_instructions(reason: &str, review: &AutoRefineReview) -> String {
    let detail = review
        .instructions
        .as_deref()
        .map(|instructions| {
            format!(
                "

Reviewer instructions: {instructions}"
            )
        })
        .unwrap_or_default();
    format!(
        "Automatic refine review triggered by {reason}. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: {}{detail}",
        review.rationale
    )
}

/// Who triggered a refinement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefinementSource {
    Auto,
    User,
    SelfRefine,
}

impl RefinementSource {
    fn as_str(self) -> &'static str {
        match self {
            RefinementSource::Auto => "auto",
            RefinementSource::User => "user",
            RefinementSource::SelfRefine => "self",
        }
    }
}

/// One committed refinement: the result plus the live-context rows the
/// commit persisted (the TUI outcome row, then the model-facing notice
/// only when an edit applied), selected from the durable entries so
/// background reporters replay the persisted rows byte for byte.
#[derive(Debug)]
pub struct CommittedRefinement {
    pub result: RefinementResult,
    pub rows: Vec<CustomMessage>,
}

pub(crate) fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[must_use]
pub fn create_refinement_outcome_message(result: &RefinementResult) -> CustomMessage {
    let mut details = json!({
        "refinementId": result.id,
        "summary": result.summary,
        "scope": result.scope.unwrap_or(HarnessScope::Local),
        "edits": result.applied_edits,
    });
    if let (Some(rollback), Some(map)) = (result.rollback_of.clone(), details.as_object_mut()) {
        map.insert("rollbackOf".to_string(), json!(rollback));
    }
    CustomMessage {
        custom_type: REFINEMENT_OUTCOME_CUSTOM_TYPE.to_string(),
        content: UserContent::Text(format!("Refinement complete: {}", result.summary)),
        display: true,
        details: Some(details),
        timestamp: now_millis(),
        rest: serde_json::Map::default(),
    }
}

/// Model-facing notice (display=false).
#[must_use]
pub fn create_refinement_notice_message(
    result: &RefinementResult,
    source: RefinementSource,
) -> CustomMessage {
    let mut details = json!({
        "refinementId": result.id,
        "summary": result.summary,
        "scope": result.scope.unwrap_or(HarnessScope::Local),
        "edits": result.applied_edits,
        "source": source.as_str(),
    });
    if let (Some(rollback), Some(map)) = (result.rollback_of.clone(), details.as_object_mut()) {
        map.insert("rollbackOf".to_string(), json!(rollback));
    }
    CustomMessage {
        custom_type: REFINEMENT_NOTICE_CUSTOM_TYPE.to_string(),
        content: UserContent::Text(format!(
            "[{}-refinement]\n\n{}",
            source.as_str(),
            format_refinement_notice_body(result)
        )),
        display: false,
        details: Some(details),
        timestamp: now_millis(),
        rest: serde_json::Map::default(),
    }
}

/// This run's live-context rows (the outcome, plus the notice only when any
/// edit applied), selected BY ID so interleaved runs never select each other's rows.
pub(crate) fn context_rows_by_ids(entries: &[FileEntry], ids: &[String]) -> Vec<CustomMessage> {
    entries
        .iter()
        .filter_map(|entry| {
            let id = entry.id()?;
            ids.iter()
                .position(|wanted| wanted == id)
                .map(|_| match entry {
                    FileEntry::CustomMessage { payload, .. } => {
                        crate::session::create_custom_message(payload, entry)
                    }
                    _ => unreachable!("refinement context rows are custom-message rows"),
                })
        })
        .collect()
}

/// Refinement history recorded in this session's JSONL entries.
#[must_use]
pub fn session_refinement_history(entries: &[FileEntry]) -> Vec<RefinementResult> {
    entries
        .iter()
        .filter_map(|entry| match entry {
            FileEntry::Custom { payload, .. }
                if payload.custom_type == REFINEMENT_AUDIT_CUSTOM_TYPE =>
            {
                payload
                    .data
                    .as_ref()
                    .and_then(|data| serde_json::from_value::<RefinementResult>(data.clone()).ok())
            }
            _ => None,
        })
        .collect()
}

/// The refinement stores, the same directory pair the kernel reads and the
/// harness digest renders: the global under the agent dir's harness path,
/// the local in the session's own artifact state. Refinement paths derive
/// their stores from the session's harness digest context.
#[derive(Debug, Clone)]
pub struct RefinementStores {
    /// Global harness state directory (`<agent dir>/harness`).
    pub global_dir: PathBuf,
    /// The session's own local harness state directory, when the session
    /// persists artifacts.
    pub local_dir: Option<PathBuf>,
}

impl From<&super::harness_digest::HarnessDigestContext> for RefinementStores {
    fn from(context: &super::harness_digest::HarnessDigestContext) -> Self {
        Self {
            global_dir: context.global_dir.clone(),
            local_dir: context.local_dir.clone(),
        }
    }
}

/// Strip display-only `local:`/`global:` prefixes from edit ids.
fn strip_display_prefixes(plan: RefinementPlan) -> RefinementPlan {
    let mut plan = plan;
    for edit in &mut plan.proposal.edits {
        if let Some(id) = &edit.id {
            if let Some(stripped) = id
                .strip_prefix("local:")
                .or_else(|| id.strip_prefix("global:"))
            {
                edit.id = Some(stripped.to_string());
            }
        }
    }
    plan
}

/// The transcript feeding the refinement planner: the conversation messages
/// plus the in-session refinement history (no owned copy of every entry).
pub struct RefinementTranscript<'a> {
    pub messages: &'a [AgentMessage],
    pub refinement_history: &'a [crate::refinement::RefinementResult],
}

/// Run the full refinement flow: plan (LLM or rollback), re-read the target
/// store, apply, persist state + history, and append the audit, outcome, and
/// notice entries to the session. `refine_call` performs the model request.
///
/// # Errors
///
/// Returns an error when a local refinement is requested on an unpersisted
/// session, when the refinement plan (LLM or rollback) fails, when applying
/// or persisting the refined harness state fails, or when appending the
/// audit, outcome, or notice entries fails.
///
/// `agent_dir` is the session's settings root: its settings.json holds
/// the `factory.enabled` opt-in (default off), re-read immediately before
/// the plan applies — after the (long) model request, never snapshotted
/// before it — so the gate decides on the CURRENT setting. While it is
/// off, factory create/update edits refuse with the one disabled message —
/// the same gate the kernel-side factory writers raise
/// (`rlm.factory.require_factory_enabled`), so a refinement cannot
/// author factories the user has not opted into. `None` (a session
/// without a wired agent dir) keeps the fail-closed disabled default.
// One refine funnel: the transcript, the store dirs, the model seam, the
// options, the source, and the resolved gates ride the same call
// (same style as the daemon's too_many_arguments seams).
#[allow(clippy::too_many_arguments)]
pub async fn execute_refinement(
    session: &tokio::sync::Mutex<SessionManager>,
    agent: &pa_agent::agent::Agent,
    transcript: RefinementTranscript<'_>,
    stores: &RefinementStores,
    model: &pa_types::ai::Model,
    options: &RefineOptions,
    source: RefinementSource,
    refine_call: crate::refinement::executor::RefinerFn,
    agent_dir: Option<&Path>,
) -> anyhow::Result<RefinementResult> {
    let ready = prepare_refinement(
        session,
        agent_dir,
        transcript,
        stores,
        model,
        options,
        refine_call,
    )
    .await?;
    Ok(commit_refinement(
        session,
        agent,
        ready,
        source,
        agent_dir,
        /*compaction_flight*/ None,
        &pa_agent::abort::AbortSignal::never(),
    )
    .await?
    .result)
}

/// Counts the refinement runs currently planning or committing — the
/// counter `refine.status` answers `in_flight` from. The guard spans a
/// run's whole body, so every source reports its flight at the one
/// shared start.
struct RefinementFlightGuard(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl RefinementFlightGuard {
    fn enter(in_flight: std::sync::Arc<std::sync::atomic::AtomicUsize>) -> Self {
        in_flight.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Self(in_flight)
    }
}

impl Drop for RefinementFlightGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_refinement(
    session: std::sync::Arc<tokio::sync::Mutex<SessionManager>>,
    agent: std::sync::Arc<pa_agent::agent::Agent>,
    compaction_flight: std::sync::Arc<tokio::sync::Mutex<()>>,
    refinements_in_flight: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    cancel: pa_agent::abort::AbortSignal,
    agent_dir: Option<PathBuf>,
    options: RefineOptions,
    source: RefinementSource,
    model: pa_types::ai::Model,
    refine_call: crate::refinement::executor::RefinerFn,
    stores: RefinementStores,
) -> anyhow::Result<CommittedRefinement> {
    let _flight = RefinementFlightGuard::enter(refinements_in_flight);
    let ready = pa_agent::abort::race_with_abort(
        async {
            // The transcript's consumed artifacts are extracted under this first
            // lock straight from the retained rows: no second clone of the rows.
            let parts = session.lock().await.refine_transcript_parts();
            let crate::session::manager::RefineTranscriptParts {
                messages,
                refinement_history,
            } = parts.await?;
            prepare_refinement(
                &session,
                agent_dir.as_deref(),
                RefinementTranscript {
                    messages: &messages,
                    refinement_history: &refinement_history,
                },
                &stores,
                &model,
                &options,
                refine_call,
            )
            .await
        },
        &cancel,
    )
    .await??;
    commit_refinement(
        &session,
        &agent,
        ready,
        source,
        agent_dir.as_deref(),
        Some(&compaction_flight),
        &cancel,
    )
    .await
}

/// An ephemeral plan: no persistence or run reservation is held while planning.
pub(crate) struct ReadyRefinement {
    plan: RefinementPlan,
    core_options: CoreRefineOptions,
    baseline_state: crate::refinement::HarnessState,
    target_scope: HarnessScope,
    target_dir: PathBuf,
    global_harness_dir: PathBuf,
    settings: Option<crate::settings::SettingsManager>,
}

pub(crate) async fn prepare_refinement(
    session: &tokio::sync::Mutex<SessionManager>,
    agent_dir: Option<&Path>,
    transcript: RefinementTranscript<'_>,
    stores: &RefinementStores,
    model: &pa_types::ai::Model,
    options: &RefineOptions,
    refine_call: crate::refinement::executor::RefinerFn,
) -> anyhow::Result<ReadyRefinement> {
    let RefinementTranscript {
        messages,
        refinement_history,
    } = transcript;
    let (local_harness_dir, cwd) = {
        let session = session.lock().await;
        (stores.local_dir.clone(), session.get_cwd().to_path_buf())
    };
    // The live master gate decides before any harness load or plan request:
    // a disabled session never plans. The one settings construction rides
    // the ready refinement to the commit recheck; `enabled` reopens the
    // store live on each read, and a session without a wired agent dir
    // has no settings store to disable (mirrors the fail-open gate).
    let settings = match agent_dir.map(Path::to_path_buf) {
        Some(dir) => Some(
            tokio::task::spawn_blocking(move || {
                let settings = crate::settings::SettingsManager::create(&cwd, &dir);
                anyhow::ensure!(
                    super::refinement_gate::enabled(Some(&settings)),
                    "Harness refinements are disabled in /settings"
                );
                Ok::<_, anyhow::Error>(settings)
            })
            .await??,
        ),
        None => None,
    };
    let core_options = CoreRefineOptions {
        global: options.global,
        instructions: options.instructions.clone(),
        rollback_id: options.rollback_id.clone(),
    };
    let requested_scope = if options.global {
        HarnessScope::Global
    } else {
        HarnessScope::Local
    };
    // A local refinement needs the session's own harness state directory
    // (the digest context's `local_dir`): the per-session artifact store the
    // kernel and the digest read. Sessions without one — a pathless session —
    // refuse rather than write a store no digest ever shows.
    if options.rollback_id.is_none() && requested_scope == HarnessScope::Local {
        local_store_dir(local_harness_dir.as_deref())?;
    }
    // Planning state: global, or merged global+local for local refinements.
    let global_state = load_harness_state(&stores.global_dir, HarnessScope::Global);
    let planning_state = if requested_scope == HarnessScope::Global {
        global_state.clone()
    } else {
        let local_state = local_harness_dir
            .as_deref()
            .map(|dir| load_harness_state(dir, HarnessScope::Local));
        merge_harness_states(&global_state, local_state.as_ref())
    };
    let global = load_global_refinement_history(&stores.global_dir);
    let history = crate::refinement::merge_refinement_history(&global, refinement_history);
    // Baseline captured before the (slow) LLM pass, so concurrent kernel
    // writes are rejected instead of clobbered.
    let baseline_scope = options
        .rollback_id
        .as_ref()
        .and_then(|id| history.iter().find(|item| &item.id == id))
        .and_then(crate::refinement::infer_refinement_result_scope)
        .unwrap_or(requested_scope);
    let baseline_dir = match baseline_scope {
        HarnessScope::Global => stores.global_dir.clone(),
        HarnessScope::Local => local_store_dir(local_harness_dir.as_deref())?,
    };
    let baseline_state = load_harness_state(&baseline_dir, baseline_scope);

    let mut plan = plan_refinement(
        messages,
        &planning_state,
        &history,
        model,
        &core_options,
        refine_call,
    )
    .await?;
    plan = strip_display_prefixes(plan);

    let target_scope = plan.rollback_scope.unwrap_or(requested_scope);
    let target_dir = match target_scope {
        HarnessScope::Global => stores.global_dir.clone(),
        HarnessScope::Local => local_store_dir(local_harness_dir.as_deref())?,
    };
    // A rollback must land in the store its target actually wrote, named
    // by the recorded `harness_state_path`. A mismatch means the record
    // predates the store split (the orphan agent-dir file, the shared
    // sessions-root file) or belongs to another session; applying the
    // inverse to the current store would edit entries the refinement
    // never touched, so refuse and name both files. The recorded path is
    // the raw join `save_harness_state` returned, so the same store can
    // carry two spellings (a symlinked or relative dir): compare the
    // real files, keeping a spelling only when that side no longer
    // exists on disk.
    if let Some(rollback_id) = &core_options.rollback_id {
        if let Some(recorded) = history
            .iter()
            .find(|item| &item.id == rollback_id)
            .map(|item| item.harness_state_path.clone())
            .filter(|recorded| !recorded.is_empty())
        {
            let current = crate::refinement::get_harness_state_path(&target_dir);
            let recorded_store = crate::skills::loader::canonicalize_path(Path::new(&recorded));
            let current_store = crate::skills::loader::canonicalize_path(&current);
            if recorded_store != current_store {
                anyhow::bail!(
                    "Refinement {rollback_id} was recorded against the harness store {recorded}, \
                     not this session's current store {}; the rollback is refused rather than \
                     edit a store the refinement never touched. The recorded store is either a \
                     pre-split file nothing reads anymore or another session's store (a fork \
                     inherits its parent's records): edit or remove the entry by hand in the \
                     recorded store, or roll the refinement back from the session that wrote it",
                    current.display()
                );
            }
        }
    }
    Ok(ReadyRefinement {
        plan,
        core_options,
        baseline_state,
        target_scope,
        target_dir,
        global_harness_dir: stores.global_dir.clone(),
        settings,
    })
}

/// The local store dir for a scope that resolved local: a session without
/// one cannot apply or roll back a local refinement, so it refuses rather
/// than write a store no digest ever shows. The refusal keeps the TS
/// wording (v0.9.8 `agent-session.ts`): it names the user's real next step,
/// not the internal path the session lacks.
fn local_store_dir(local_dir: Option<&Path>) -> anyhow::Result<PathBuf> {
    local_dir.map(Path::to_path_buf).ok_or_else(|| {
        anyhow::anyhow!(
            "Local harness refinement requires a persisted session; use global refinement instead."
        )
    })
}

type RefinementCommitGuards<'a> = (
    tokio::sync::MutexGuard<'a, ()>,
    Option<tokio::sync::MutexGuard<'a, ()>>,
    tokio::sync::MutexGuard<'a, SessionManager>,
    crate::platform::lock_dir::LockDir,
);

async fn reserve_refinement_commit<'a>(
    session: &'a tokio::sync::Mutex<SessionManager>,
    agent: &'a pa_agent::agent::Agent,
    target_dir: &Path,
    compaction_flight: Option<&'a tokio::sync::Mutex<()>>,
) -> anyhow::Result<RefinementCommitGuards<'a>> {
    tokio::fs::create_dir_all(&target_dir).await?;
    // Lock the file the kernel locks: the real file behind a state
    // symlink, so both writers contend on one lock directory.
    let state_path = crate::refinement::resolved_state_file(
        &crate::refinement::get_harness_state_path(target_dir),
    );
    let mut attempts = 0;
    let guards = loop {
        let admission = agent.reserve_idle().await;
        let flight = match compaction_flight {
            Some(flight) => {
                if let Ok(guard) = flight.try_lock() {
                    Some(guard)
                } else {
                    drop(admission);
                    drop(flight.lock().await);
                    continue;
                }
            }
            None => None,
        };
        let Ok(session_guard) = session.try_lock() else {
            drop(flight);
            drop(admission);
            drop(session.lock().await);
            continue;
        };
        let path = state_path.clone();
        let lock = tokio::task::spawn_blocking(move || {
            crate::platform::lock_dir::LockDir::acquire_owned_retrying(
                &path,
                std::time::Duration::from_secs(10),
                1,
                std::time::Duration::ZERO,
            )
        })
        .await?;
        match lock {
            Ok(lock) => break (admission, flight, session_guard, lock),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                drop(session_guard);
                drop(flight);
                drop(admission);
                attempts += 1;
                if attempts >= 50 {
                    return Err(error.into());
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            Err(error) => return Err(error.into()),
        }
    };
    Ok(guards)
}

pub(crate) async fn commit_refinement(
    session: &tokio::sync::Mutex<SessionManager>,
    agent: &pa_agent::agent::Agent,
    ready: ReadyRefinement,
    source: RefinementSource,
    agent_dir: Option<&Path>,
    compaction_flight: Option<&tokio::sync::Mutex<()>>,
    cancel: &pa_agent::abort::AbortSignal,
) -> anyhow::Result<CommittedRefinement> {
    let ReadyRefinement {
        plan,
        core_options,
        baseline_state,
        target_scope,
        target_dir,
        global_harness_dir,
        settings,
    } = ready;
    let (_admission, _flight, mut session, lock) = pa_agent::abort::race_with_abort(
        reserve_refinement_commit(session, agent, &target_dir, compaction_flight),
        cancel,
    )
    .await??;
    pa_agent::abort::throw_if_aborted(cancel)?;
    // From this point the commit completes even if the session closes: dropping
    // planning is safe, dropping between the durable save and audit append is not.
    // The factory opt-in resolves HERE — immediately before the apply,
    // after the planning request — so a setting that changed during the
    // request (`/factory off` mid-plan) decides, not a snapshot captured
    // before it. The read rides `spawn_blocking` so the settings I/O
    // never blocks the async runtime worker. A session without a wired
    // agent dir keeps the fail-closed disabled default, and a panicked
    // read task reads as disabled — the same fail-closed leniency as
    // `factory_enabled` itself.
    let factory_enabled = match agent_dir {
        Some(agent_dir) => {
            let agent_dir = agent_dir.to_path_buf();
            tokio::task::spawn_blocking(move || crate::refinement::factory_enabled(&agent_dir))
                .await
                .unwrap_or(false)
        }
        None => false,
    };
    let (mut result, state_path) = tokio::task::spawn_blocking(move || {
        // The apply-time recheck: a toggle-off during the (slow) planning
        // request discards the plan here — after the lock, before any load,
        // apply, or save, so nothing persists and no rows append.
        anyhow::ensure!(
            super::refinement_gate::enabled(settings.as_ref()),
            "Harness refinements were disabled during planning; the result was discarded"
        );
        let mut state = load_harness_state(&target_dir, target_scope);
        let result = apply_refinement_plan(
            &mut state,
            plan,
            &core_options,
            Some(baseline_state),
            factory_enabled,
        );
        lock.ensure_owned()?;
        let state_path = crate::refinement::save_harness_state(&target_dir, &state)?;
        Ok::<_, anyhow::Error>((result, state_path))
    })
    .await
    .map_err(|error| anyhow::anyhow!("refinement harness update task failed: {error}"))??;
    result.harness_state_path = state_path.to_string_lossy().to_string();
    let history_write = if target_scope == HarnessScope::Global {
        append_global_refinement(&global_harness_dir, &result).err()
    } else {
        None
    };
    // The audit append is attempted first; a failed write is caught (the row
    // stays live-indexed) and the audit error surfaces only after the outcome
    // records — the user's view and the durable stores do not diverge.
    let (_, audit_write) = session.append_custom_entry_retained(
        REFINEMENT_AUDIT_CUSTOM_TYPE,
        Some(serde_json::to_value(&result)?),
    );
    // Outcome for the TUI; notice for the model (only when edits applied).
    let outcome = create_refinement_outcome_message(&result);
    let (outcome_id, outcome_write) = session.append_custom_message_retained(
        &outcome.custom_type,
        outcome.content.clone(),
        outcome.display,
        outcome.details.clone(),
    );
    let mut context_row_ids = vec![outcome_id];
    let mut notice_write = None;
    if result.applied_edits.iter().any(|edit| edit.applied) {
        let notice = create_refinement_notice_message(&result, source);
        let (notice_id, error) = session.append_custom_message_retained(
            &notice.custom_type,
            notice.content.clone(),
            notice.display,
            notice.details.clone(),
        );
        notice_write = error;
        context_row_ids.push(notice_id);
    }
    let rows = context_rows_by_ids(session.retained_entries(), &context_row_ids);
    let loop_rows = rows
        .iter()
        .filter_map(|row| super::session_message_to_loop(&AgentMessage::Custom(row.clone())))
        .collect();
    agent.append_messages(loop_rows).await;
    let failures: Vec<String> = [
        (
            "global history",
            history_write.map(|error| error.to_string()),
        ),
        ("audit", audit_write.map(|error| error.to_string())),
        ("outcome", outcome_write.map(|error| error.to_string())),
        ("notice", notice_write.map(|error| error.to_string())),
    ]
    .into_iter()
    .filter_map(|(store, error)| error.map(|error| format!("{store}: {error}")))
    .collect();
    if !failures.is_empty() {
        anyhow::bail!(
            "refinement applied but records were not persisted: {}",
            failures.join("; ")
        );
    }
    Ok(CommittedRefinement { result, rows })
}

/// `/refine` request options (session layer).
#[derive(Debug, Default, Clone)]
pub struct RefineOptions {
    pub global: bool,
    pub instructions: Option<String>,
    pub rollback_id: Option<String>,
}

/// The compact-trigger round's resolution: decline, deferred behind an
/// active agent turn, or ran.
pub(crate) enum AutoRefineRound {
    /// No refinement ran; the caller stamps the review cooldown.
    Declined,
    /// Approved mid-stream: the review is retained and the next serviced
    /// boundary runs it.
    Deferred(AutoRefineReview),
    /// The refinement ran.
    Ran(RefinementResult),
}

/// The refiner model call on the session model, with the merged request
/// headers (the Prime team header) the session's own requests send.
pub(super) async fn session_refiner_call(
    auxiliary: Option<super::auxiliary_model::AuxiliaryModelContext>,
    model: &pa_types::ai::Model,
    api_key: Option<String>,
    session_id: String,
) -> anyhow::Result<crate::refinement::executor::RefinerFn> {
    let (api_key, headers) = match auxiliary {
        Some(context) => {
            let model = model.clone();
            let routed = tokio::task::spawn_blocking(move || {
                super::auxiliary_model::session_fallback_with_headers(&context, &model, api_key)
            })
            .await?;
            (routed.api_key, routed.headers)
        }
        None => (api_key, None),
    };
    Ok(default_refiner_call(api_key, headers, session_id))
}

/// The billed refiner seam for the background runs: the reply's usage row
/// records at reply time — the planning call holds no session lock, and a
/// resolved bill persists even when its caller is aborted or dropped
/// mid-commit (the same resolved-bill guarantee `record_model_usage` gives
/// the blocking arm).
pub(crate) fn recorded_refiner_call(
    call: crate::refinement::executor::RefinerFn,
    source: &'static str,
    session: std::sync::Arc<tokio::sync::Mutex<SessionManager>>,
    usage_store: std::sync::Arc<dyn super::rlm_usage::RlmChildUsageStore>,
) -> crate::refinement::executor::RefinerFn {
    Box::new(move |model, system_prompt, prompt| {
        let reply = call(model, system_prompt, prompt);
        let session = std::sync::Arc::clone(&session);
        let usage_store = std::sync::Arc::clone(&usage_store);
        Box::pin(async move {
            let reply = reply.await?;
            // The task owns the resolved bill before the first await. Dropping
            // its JoinHandle detaches the append instead of dropping the bill.
            if let Some(usage) = ModelUsage::of_reply(source, &reply) {
                let recording = tokio::spawn(async move {
                    let session_id = session.lock().await.get_session_id().to_string();
                    if let Err(error) = usage_store.append_model_usage(session_id, usage).await {
                        eprintln!("pa-core: model usage row not persisted: {error}");
                    }
                });
                if let Err(error) = recording.await {
                    eprintln!("pa-core: model usage recording task failed: {error}");
                }
            }
            Ok(reply)
        })
    })
}

#[allow(clippy::too_many_arguments)]
async fn review_compact_refinement(
    session: &std::sync::Arc<tokio::sync::Mutex<SessionManager>>,
    branch_state: &std::sync::Mutex<super::auto_refine_trigger::CompactAutoRefineState>,
    auxiliary: Option<super::auxiliary_model::AuxiliaryModelContext>,
    usage_store: std::sync::Arc<dyn super::rlm_usage::RlmChildUsageStore>,
    model: &pa_types::ai::Model,
    api_key: Option<String>,
    stores: &RefinementStores,
    turns_since_last_review: u32,
    branch_version: u64,
) -> anyhow::Result<Option<AutoRefineReview>> {
    // The review reads the same planning inputs the run plans
    // against, extracted under this lock from the retained rows.
    let (parts, merged_state, history, session_id) = {
        let session = session.lock().await;
        let local_state = stores
            .local_dir
            .as_deref()
            .map(|dir| load_harness_state(dir, HarnessScope::Local));
        let global_state = load_harness_state(&stores.global_dir, HarnessScope::Global);
        (
            session.refine_transcript_parts(),
            merge_harness_states(&global_state, local_state.as_ref()),
            load_global_refinement_history(&stores.global_dir),
            session.get_session_id().to_string(),
        )
    };
    // Refinement deliberately reviews historical messages; await the
    // transcript parts after releasing the session mutex.
    let crate::session::manager::RefineTranscriptParts {
        messages,
        refinement_history: session_history,
    } = parts.await?;
    let history = crate::refinement::merge_refinement_history(&history, &session_history);
    let review = review_auto_refine(
        &messages,
        &merged_state,
        &history,
        model,
        &AutoRefineReviewContext {
            reason: AUTO_REFINE_COMPACT_REASON.to_string(),
            turns_since_last_review,
        },
        recorded_refiner_call(
            session_refiner_call(auxiliary, model, api_key, session_id).await?,
            "refine_review",
            std::sync::Arc::clone(session),
            usage_store,
        ),
    )
    .await?;
    if !review.should_refine {
        return Ok(None);
    }
    // A branch move (or a replacement teardown's discard) bumped the version
    // while the review's model call was in flight — the approval belongs to
    // the abandoned conversation, so the refinement run never starts.
    if branch_state
        .lock()
        .expect("compact auto-refine state lock")
        .branch_version
        != branch_version
    {
        return Ok(None);
    }
    Ok(Some(review))
}

/// The refusal for a session built without a harness digest context: it has
/// no store pair to read or write, so every refinement entry point errors
/// instead of guessing a directory.
pub(crate) fn refinement_stores_missing_error() -> anyhow::Error {
    anyhow::anyhow!(
        "refinement requires the session's harness digest context; this session was built without one"
    )
}

impl AgentSession {
    /// The refinement stores: the session's harness digest context's store
    /// pair, the same directories the kernel reads and the digest renders.
    /// Every refinement entry point on the session derives its stores here.
    ///
    /// # Errors
    ///
    /// Errors when the session was built without a harness digest context;
    /// engine-built sessions always carry one.
    pub(crate) fn refinement_stores(&self) -> anyhow::Result<RefinementStores> {
        self.harness_digest
            .as_ref()
            .map(RefinementStores::from)
            .ok_or_else(refinement_stores_missing_error)
    }

    /// The compact-trigger review: an LLM call over the conversation, the
    /// merged harness state, and the refinement history. `Ok(None)` is the
    /// decline; `Ok(Some(review))` a fresh approval.
    ///
    /// # Errors
    ///
    /// Returns an error when the conversation history cannot be read or
    /// when the review request fails; a decline is `Ok(None)`.
    ///
    /// # Panics
    ///
    /// Panics if the billed-call slot's mutex is poisoned.
    pub async fn review_compact_auto_refine(
        &self,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        turns_since_last_review: u32,
        branch_version: u64,
    ) -> anyhow::Result<Option<AutoRefineReview>> {
        if !self.harness_refinements_enabled() {
            return Ok(None);
        }
        let stores = self.refinement_stores()?;
        pa_agent::abort::race_with_abort(
            review_compact_refinement(
                &self.session,
                &self.compact_auto_refine,
                self.auxiliary_model.clone(),
                std::sync::Arc::clone(&self.usage_store),
                model,
                api_key,
                &stores,
                turns_since_last_review,
                branch_version,
            ),
            &self.refinement_signal(),
        )
        .await?
    }

    /// Review a compacted conversation and plan its refinement in the background.
    /// The returned task follows the same disposal and full-run commit boundary
    /// as [`Self::start_refinement`].
    pub fn start_auto_refine_after_compaction(
        &self,
        model: pa_types::ai::Model,
        api_key: Option<String>,
        turns_since_last_review: u32,
        branch_version: u64,
    ) -> tokio::task::JoinHandle<anyhow::Result<Option<CommittedRefinement>>> {
        let session = self.session.clone();
        let agent = self.agent.clone();
        let flight = self.compaction_flight.clone();
        let in_flight = self.refinements_in_flight.clone();
        let branch_state = self.compact_auto_refine.clone();
        let auxiliary = self.auxiliary_model.clone();
        let agent_dir = self.agent_dir.clone();
        let usage_store = std::sync::Arc::clone(&self.usage_store);
        let cancel = self.refinement_signal();
        let Ok(stores) = self.refinement_stores() else {
            return tokio::spawn(async { Err(refinement_stores_missing_error()) });
        };
        tokio::spawn(async move {
            let Some(review) = pa_agent::abort::race_with_abort(
                review_compact_refinement(
                    &session,
                    &branch_state,
                    auxiliary.clone(),
                    std::sync::Arc::clone(&usage_store),
                    &model,
                    api_key.clone(),
                    &stores,
                    turns_since_last_review,
                    branch_version,
                ),
                &cancel,
            )
            .await??
            else {
                return Ok(None);
            };
            let options = RefineOptions {
                global: false,
                instructions: Some(auto_refine_instructions(
                    AUTO_REFINE_COMPACT_REASON,
                    &review,
                )),
                rollback_id: None,
            };
            let session_id = session.lock().await.get_session_id().to_string();
            let refiner = session_refiner_call(auxiliary, &model, api_key, session_id).await?;
            let refiner = recorded_refiner_call(refiner, "refine", session.clone(), usage_store);
            run_refinement(
                session,
                agent,
                flight,
                in_flight,
                cancel,
                agent_dir,
                options,
                RefinementSource::Auto,
                model,
                refiner,
                stores,
            )
            .await
            .map(Some)
        })
    }

    /// The approved review's refinement run; the result consumes the
    /// review.
    pub(crate) async fn run_approved_refine(
        &self,
        review: &AutoRefineReview,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        cancel: pa_agent::abort::AbortSignal,
    ) -> anyhow::Result<RefinementResult> {
        let stores = self.refinement_stores()?;
        let options = RefineOptions {
            global: false,
            instructions: Some(auto_refine_instructions(AUTO_REFINE_COMPACT_REASON, review)),
            rollback_id: None,
        };
        let refiner = session_refiner_call(
            self.auxiliary_model.clone(),
            model,
            api_key,
            self.session_id().await,
        )
        .await?;
        let refiner = recorded_refiner_call(
            refiner,
            "refine",
            self.session.clone(),
            self.usage_store.clone(),
        );
        run_refinement(
            self.session.clone(),
            self.agent.clone(),
            self.compaction_flight.clone(),
            self.refinements_in_flight.clone(),
            cancel,
            self.agent_dir.clone(),
            options,
            RefinementSource::Auto,
            model.clone(),
            refiner,
            stores,
        )
        .await
        .map(|committed| committed.result)
    }
}

/// The default model seam over pa-ai completion.
#[must_use]
pub fn default_refiner_call(
    api_key: Option<String>,
    headers: Option<std::collections::BTreeMap<String, String>>,
    session_id: String,
) -> crate::refinement::executor::RefinerFn {
    Box::new(move |model, system_prompt, prompt| {
        Box::pin(async move {
            let context = pa_types::ai::Context {
                system_prompt: Some(system_prompt.to_string()),
                messages: vec![pa_types::ai::Message::User(UserMessage {
                    content: UserContent::Text(prompt),
                    timestamp: 0,
                    rest: serde_json::Map::default(),
                })],
                tools: None,
            };
            let mut stream_options =
                pa_ai::types::SimpleStreamOptions::from_base(pa_ai::types::StreamOptions {
                    api_key,
                    headers: headers.map(|headers| headers.into_iter().collect()),
                    session_id: Some(session_id),
                    // One-off prompts ride SSE: they keep the conversation id (cache key,
                    // opencode routing) but never take or replace the session's Codex
                    // WebSocket and its continuation.
                    transport: Some(pa_ai::types::Transport::Sse),
                    ..Default::default()
                });
            stream_options.reasoning = pa_types::ai::minimum_reasoning(&model);
            Ok(pa_ai::complete_simple(&model, &context, Some(stream_options)).await?)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refinement::executor::RefinerFn;
    use pa_agent::agent::{Agent, AgentOptions};
    use pa_types::ai::{AssistantContentBlock, AssistantMessage, Model, StopReason, TextContent};
    use std::sync::Arc;
    use tempfile::TempDir;

    fn text_assistant(text: &str) -> AssistantMessage {
        AssistantMessage {
            content: vec![AssistantContentBlock::Text(TextContent {
                text: text.to_string(),
                text_signature: None,
                rest: serde_json::Map::default(),
            })],
            api: "openai-completions".to_string(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        }
    }

    fn seam(text: &str) -> RefinerFn {
        let text = text.to_string();
        Box::new(move |_model, _system, _prompt| {
            let text = text;
            Box::pin(async move { Ok(text_assistant(&text)) })
        })
    }

    /// A refiner seam that rewrites the factory settings file mid-request
    /// (the `/factory` flip during the model request), then returns the
    /// plan authored under the pre-flip value.
    fn flip_seam(settings: &Path, flipped: &'static str, reply: &'static str) -> RefinerFn {
        let settings = settings.to_path_buf();
        Box::new(move |_model, _system, _prompt| {
            std::fs::write(&settings, flipped).unwrap();
            Box::pin(async move { Ok(text_assistant(reply)) })
        })
    }

    fn test_model() -> Model {
        Model {
            id: "test".to_string(),
            name: "test".to_string(),
            api: "openai-completions".to_string(),
            provider: "test".to_string(),
            base_url: "https://example.invalid".to_string(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![],
            cost: pa_types::ai::ModelCost {
                input: 0.0.into(),
                output: 0.0.into(),
                cache_read: 0.0.into(),
                cache_write: 0.0.into(),
            },
            context_window: 100_000,
            max_tokens: 8_000,
            max_tokens_explicit: false,
            featured: None,
            serving: None,
            headers: None,
            compat: None,
        }
    }

    fn persisted_session(dir: &TempDir) -> SessionManager {
        let session_dir = dir.path().join("session");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut session = SessionManager::in_memory(dir.path());
        session.materialize_session_file(Some(session_dir));
        session
    }

    /// The local store a production session's digest context carries for a
    /// materialized manager: the session's own artifact harness dir
    /// (`<dir>/session-artifacts/<id>/harness`), the derivation
    /// `create_session` wires — not the session dir itself.
    fn local_store_for(manager: &SessionManager) -> PathBuf {
        crate::refinement::get_local_harness_state_dir(
            manager.get_session_artifact_dir().as_deref(),
        )
        .expect("a materialized manager always has an artifact dir")
    }

    /// Seed one memory entry into a harness store dir, the shape a prior
    /// refinement wrote. `merge_harness_states` re-scopes by source store,
    /// so the entry's scope field only names the store it was seeded into.
    fn seed_store_memory(dir: &std::path::Path, id: &str, scope: HarnessScope) {
        let mut state = crate::refinement::empty_harness_state();
        state
            .entries
            .get_mut(&crate::refinement::RefinementKind::Memory)
            .unwrap()
            .insert(
                id.to_string(),
                crate::refinement::HarnessEntry {
                    id: id.to_string(),
                    kind: crate::refinement::RefinementKind::Memory,
                    title: format!("Seeded {id} entry"),
                    content: format!("Seeded {id} content"),
                    path: "general".to_string(),
                    scope: Some(scope),
                    reference: serde_json::Map::default(),
                    arguments: serde_json::Map::default(),
                    metadata: serde_json::Map::default(),
                    source: "agent".to_string(),
                    created_at: "2026-11-16T00:00:00Z".to_string(),
                    updated_at: "2026-11-16T00:00:00Z".to_string(),
                    version: 1,
                },
            );
        crate::refinement::save_harness_state(dir, &state).unwrap();
    }

    fn user_message(text: &str) -> AgentMessage {
        AgentMessage::User(UserMessage {
            content: UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    }

    #[tokio::test]
    async fn disabling_refinements_blocks_planning_and_discards_in_flight_results() {
        let dir = TempDir::new().unwrap();
        let mut manager = persisted_session(&dir);
        manager
            .append_message(user_message("remember this"))
            .unwrap();
        let local_dir = local_store_for(&manager);
        let session = tokio::sync::Mutex::new(manager);
        let agent = Arc::new(Agent::new(AgentOptions::default()));
        let global_dir = dir.path().join("harness");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let settings = agent_dir.join("settings.json");
        std::fs::write(&settings, r#"{"harnessRefinements":false}"#).unwrap();
        let entries_before = session.lock().await.retained_entries().to_vec();
        let error = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[],
                refinement_history: &[],
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &RefineOptions::default(),
            RefinementSource::User,
            Box::new(|_, _, _| panic!("disabled refinement must not call the planner")),
            Some(&agent_dir),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("disabled"));
        std::fs::write(&settings, r#"{"harnessRefinements":true}"#).unwrap();
        let error = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[user_message("remember this")],
                refinement_history: &[],
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &RefineOptions::default(),
            RefinementSource::SelfRefine,
            flip_seam(
                &settings,
                r#"{"harnessRefinements":false}"#,
                r#"{"summary":"memory","edits":[{"action":"create","kind":"memory","id":"note","title":"Note","content":"Remember this"}]}"#,
            ),
            Some(&agent_dir),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("discarded"));
        assert_eq!(
            session.lock().await.retained_entries(),
            entries_before.as_slice()
        );
        assert!(!local_dir.join("harness_state.json").exists());
        assert!(!global_dir.exists());
    }

    /// A local refinement on a session without a local store refuses with the
    /// TS wording (v0.9.8's persisted-session message) before any planner call.
    #[tokio::test]
    async fn a_local_refinement_without_a_local_store_refuses_with_the_ts_message() {
        let dir = TempDir::new().unwrap();
        let session = tokio::sync::Mutex::new(persisted_session(&dir));
        let agent = Arc::new(Agent::new(AgentOptions::default()));
        let error = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[],
                refinement_history: &[],
            },
            &RefinementStores {
                global_dir: dir.path().join("harness"),
                local_dir: None,
            },
            &test_model(),
            &RefineOptions::default(),
            RefinementSource::User,
            Box::new(|_, _, _| panic!("a refused local refinement must not call the planner")),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Local harness refinement requires a persisted session; use global refinement instead."
        );
    }

    /// A session built without a harness digest context (`AgentSession::new`
    /// is the only such constructor) refuses at the refinement entry points
    /// instead of guessing a store pair.
    #[tokio::test]
    async fn a_session_without_a_digest_context_refuses_refinements() {
        let dir = TempDir::new().unwrap();
        let agent = Arc::new(Agent::new(AgentOptions::default()));
        let session = AgentSession::new(agent, persisted_session(&dir), Vec::new())
            .await
            .unwrap();
        let error = session
            .refine_with_refiner(
                &RefineOptions::default(),
                RefinementSource::User,
                &test_model(),
                seam(r#"{"summary":"bench","edits":[]}"#),
            )
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "refinement requires the session's harness digest context; this session was built without one"
        );
        // The background funnel refuses the same way.
        let error = session
            .start_refinement(
                RefineOptions::default(),
                RefinementSource::User,
                test_model(),
                None,
            )
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "refinement requires the session's harness digest context; this session was built without one"
        );
    }

    #[test]
    fn refinement_messages_match_wire_shape() {
        let result = RefinementResult {
            id: "refine_1".to_string(),
            summary: "add memory".to_string(),
            rationale: "seen twice".to_string(),
            expected_outcome: "recall".to_string(),
            applied_edits: vec![],
            harness_state_path: String::new(),
            rollback_of: None,
            scope: Some(HarnessScope::Local),
        };
        let outcome = create_refinement_outcome_message(&result);
        assert_eq!(outcome.custom_type, "refinement_outcome");
        assert_eq!(
            outcome.content,
            UserContent::Text("Refinement complete: add memory".to_string())
        );
        assert!(outcome.display);
        let notice = create_refinement_notice_message(&result, RefinementSource::User);
        assert_eq!(notice.custom_type, "refinement_notice");
        assert!(!notice.display);
        assert_eq!(
            notice.content,
            UserContent::Text("[user-refinement]\n\nadd memory".to_string())
        );
    }

    #[test]
    fn auto_refine_gates_resolve_the_ts_defaults_and_clamps() {
        assert_eq!(
            AutoRefineGates::from_settings(None),
            AutoRefineGates {
                enabled: true,
                turn_interval: 25,
                compact: true,
                cooldown_ms: 20 * 60 * 1000,
            }
        );
        let raw = crate::settings::AutoRefineSettings {
            enabled: Some(false),
            turn_interval: Some(0),
            compact: Some(false),
            cooldown_ms: Some(5),
        };
        assert_eq!(
            AutoRefineGates::from_settings(Some(&raw)),
            AutoRefineGates {
                enabled: false,
                turn_interval: 1,
                compact: false,
                cooldown_ms: 5,
            }
        );
    }

    #[test]
    fn auto_refine_instructions_compose_the_ts_text() {
        let review = AutoRefineReview {
            should_refine: true,
            rationale: "reusable tactic".to_string(),
            instructions: Some("record it".to_string()),
        };
        assert_eq!(
            auto_refine_instructions("compact", &review),
            "Automatic refine review triggered by compact. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: reusable tactic

Reviewer instructions: record it"
        );
        let bare = AutoRefineReview {
            should_refine: true,
            rationale: "reusable tactic".to_string(),
            instructions: None,
        };
        assert_eq!(
            auto_refine_instructions("compact", &bare),
            "Automatic refine review triggered by compact. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: reusable tactic"
        );
    }

    #[tokio::test]
    async fn factory_edits_in_a_refinement_respect_the_opt_in_gate() {
        // The host /refine flow funnels factory create edits through the
        // same opt-in gate as the kernel writers: while `factory.enabled`
        // is off, the edit refuses with the one exact disabled message
        // and nothing persists; enabled, the same proposal applies.
        let dir = TempDir::new().unwrap();
        let manager = persisted_session(&dir);
        let local_dir = local_store_for(&manager);
        let session = tokio::sync::Mutex::new(manager);
        let agent = Arc::new(Agent::new(AgentOptions::default()));
        let global_dir = dir.path().join("harness");
        let reply = r#"{"summary":"sweep","edits":[{"action":"create","kind":"factory","id":"sweep","title":"Factory","content":"Sweep review.","arguments":{"machine":{"states":[{"id":"collect","entry":true,"subagent":"worker"}],"transitions":[]}}}]}"#;
        let disabled = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[user_message("do a thing twice")],
                refinement_history: &[],
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &RefineOptions::default(),
            RefinementSource::User,
            seam(reply),
            None,
        )
        .await
        .unwrap();
        assert!(!disabled.applied_edits[0].applied);
        assert_eq!(
            disabled.applied_edits[0].error.as_deref(),
            Some(crate::refinement::FACTORY_DISABLED_MESSAGE)
        );
        let state = load_harness_state(&local_dir, HarnessScope::Local);
        assert!(state.entries[&crate::refinement::RefinementKind::Factory].is_empty());
        // The user opts in: the same proposal applies, read live from the
        // agent dir's settings.json.
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(
            agent_dir.join(crate::refinement::FACTORY_SETTINGS_FILE_NAME),
            r#"{"factory": {"enabled": true}}"#,
        )
        .unwrap();
        let enabled = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[user_message("do a thing twice")],
                refinement_history: &[],
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &RefineOptions::default(),
            RefinementSource::User,
            seam(reply),
            Some(&agent_dir),
        )
        .await
        .unwrap();
        assert!(enabled.applied_edits[0].applied);
        assert!(enabled.applied_edits[0].error.is_none());
        let state = load_harness_state(&local_dir, HarnessScope::Local);
        assert!(state.entries[&crate::refinement::RefinementKind::Factory].contains_key("sweep"));
    }

    #[tokio::test]
    async fn factory_gate_decides_on_the_apply_time_setting_not_a_planning_snapshot() {
        // The opt-in re-reads immediately before the apply — after the
        // planning request — so a `/factory` flip during the model request
        // decides, not the value the plan was authored under: a plan
        // authored while enabled that lands after the setting turned off
        // refuses with the one exact disabled message and nothing
        // persists, and a plan authored while disabled that lands after
        // the opt-in applies.
        let dir = TempDir::new().unwrap();
        let manager = persisted_session(&dir);
        let local_dir = local_store_for(&manager);
        let session = tokio::sync::Mutex::new(manager);
        let agent = Arc::new(Agent::new(AgentOptions::default()));
        let global_dir = dir.path().join("harness");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let settings = agent_dir.join(crate::refinement::FACTORY_SETTINGS_FILE_NAME);
        let reply = r#"{"summary":"sweep","edits":[{"action":"create","kind":"factory","id":"sweep","title":"Factory","content":"Sweep review.","arguments":{"machine":{"states":[{"id":"collect","entry":true,"subagent":"worker"}],"transitions":[]}}}]}"#;
        // Authored while enabled; the request flips the setting off.
        std::fs::write(&settings, r#"{"factory": {"enabled": true}}"#).unwrap();
        let turned_off = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[user_message("do a thing twice")],
                refinement_history: &[],
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &RefineOptions::default(),
            RefinementSource::User,
            flip_seam(&settings, r#"{"factory": {"enabled": false}}"#, reply),
            Some(&agent_dir),
        )
        .await
        .unwrap();
        assert!(!turned_off.applied_edits[0].applied);
        assert_eq!(
            turned_off.applied_edits[0].error.as_deref(),
            Some(crate::refinement::FACTORY_DISABLED_MESSAGE)
        );
        let state = load_harness_state(&local_dir, HarnessScope::Local);
        assert!(state.entries[&crate::refinement::RefinementKind::Factory].is_empty());
        // Authored while disabled; the request opts in.
        std::fs::write(&settings, r#"{"factory": {"enabled": false}}"#).unwrap();
        let turned_on = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[user_message("do a thing twice")],
                refinement_history: &[],
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &RefineOptions::default(),
            RefinementSource::User,
            flip_seam(&settings, r#"{"factory": {"enabled": true}}"#, reply),
            Some(&agent_dir),
        )
        .await
        .unwrap();
        assert!(turned_on.applied_edits[0].applied);
        assert!(turned_on.applied_edits[0].error.is_none());
    }

    #[tokio::test]
    async fn execute_refinement_persists_state_and_entries() {
        let dir = TempDir::new().unwrap();
        let mut manager = persisted_session(&dir);
        manager
            .append_message(user_message("do a thing twice"))
            .unwrap();
        let local_dir = local_store_for(&manager);
        let session = tokio::sync::Mutex::new(manager);
        let agent = Arc::new(Agent::new(AgentOptions::default()));
        let global_dir = dir.path().join("harness");
        let reply = r#"{"summary":"note it","rationale":"repeated","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#;
        let result = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[user_message("do a thing twice")],
                refinement_history: &[],
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &RefineOptions::default(),
            RefinementSource::User,
            seam(reply),
            None,
        )
        .await
        .unwrap();
        assert_eq!(result.applied_edits.len(), 1);
        assert!(result.applied_edits[0].applied);
        let state_path = Path::new(&result.harness_state_path);
        assert!(state_path.exists());
        let state = load_harness_state(&local_dir, HarnessScope::Local);
        assert!(state.entries[&crate::refinement::RefinementKind::Memory].contains_key("m1"));
        let entries = session.lock().await.get_all_entries().to_vec();
        assert_eq!(session_refinement_history(&entries).len(), 1);
        let custom_messages: Vec<&FileEntry> = entries
            .iter()
            .filter(|entry| {
                matches!(entry, FileEntry::CustomMessage { payload, .. }
                    if payload.custom_type == REFINEMENT_OUTCOME_CUSTOM_TYPE
                        || payload.custom_type == REFINEMENT_NOTICE_CUSTOM_TYPE)
            })
            .collect();
        assert_eq!(custom_messages.len(), 2);
        let session = session.lock().await;
        let merged_history = crate::refinement::merge_refinement_history(
            &load_global_refinement_history(&global_dir),
            &session.refinement_history(),
        );
        assert_eq!(merged_history.len(), 1);
    }

    /// The failed rows stay live-indexed so the in-process history sees
    /// the refinement.
    #[tokio::test]
    async fn audit_write_failure_reports_after_durable_edits() {
        let dir = TempDir::new().unwrap();
        let mut manager = persisted_session(&dir);
        // Bootstrap the flush rule: rows only persist after the first
        // assistant entry (persist_entry defers them until then).
        manager
            .append_message(AgentMessage::Assistant(text_assistant("seed")))
            .unwrap();
        let global_dir = dir.path().join("harness");
        let reply = r#"{"summary":"lesson","edits":[{"action":"create","kind":"memory","id":"m9","title":"Lesson","content":"durable"}]}"#;
        // Fail every session-file write: the path becomes a directory (the
        // harness stores live under a sibling dir and stay writable).
        let file = manager.get_session_file().unwrap().to_path_buf();
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        let local_dir = local_store_for(&manager);
        let session = tokio::sync::Mutex::new(manager);
        let agent = Arc::new(Agent::new(AgentOptions::default()));
        let error = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[user_message("x")],
                refinement_history: &[],
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &RefineOptions::default(),
            RefinementSource::User,
            seam(reply),
            None,
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("audit:"),
            "the audit error surfaces after the durable writes: {error:#}"
        );
        let state = load_harness_state(&local_dir, HarnessScope::Local);
        assert!(state.entries[&crate::refinement::RefinementKind::Memory].contains_key("m9"));
        let entries = session.lock().await.get_all_entries().to_vec();
        assert_eq!(session_refinement_history(&entries).len(), 1);
        assert!(entries.iter().any(|entry| matches!(entry,
            FileEntry::CustomMessage { payload, .. }
            if payload.custom_type == REFINEMENT_NOTICE_CUSTOM_TYPE)));
        assert!(
            serde_json::to_string(&agent.state().await.messages)
                .unwrap()
                .contains(REFINEMENT_NOTICE_CUSTOM_TYPE),
            "a committed edit remains visible to the model even when its audit write fails"
        );
    }

    fn oracle_fixture() -> String {
        let mut rows = vec![
            serde_json::json!({"type":"session","id":"s","version":3,"cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"}),
        ];
        let mut parent: Option<String> = None;
        for i in 0..5 {
            let id = format!("u{i}");
            rows.push(serde_json::json!({"type":"message","id":id.clone(),"parentId":parent,"message":{"role":"user","content":format!("hello {i}"),"timestamp":0}}));
            parent = Some(id);
        }
        rows.push(serde_json::json!({"type":"custom","id":"audit","parentId":parent,"customType":"prime-agent.refinement","data":{"id":"refine_0","summary":"seed","rationale":"seeded rationale","expectedOutcome":"seeded outcome","appliedEdits":[],"harnessStatePath":""}}));
        rows.into_iter().map(|row| row.to_string() + "\n").collect()
    }

    /// One captured refiner request.
    #[derive(Debug, Clone, PartialEq)]
    struct CapturedRequest {
        max_tokens: u64,
        system: &'static str,
        user: String,
    }

    /// Byte-identical across every extraction path; the leased-window leg
    /// deletes the file first, so a hidden fallback fails.
    #[tokio::test]
    async fn refine_request_is_identical_across_extraction_paths() {
        use std::io::Write as _;
        let body = oracle_fixture();
        let agent = Arc::new(Agent::new(AgentOptions::default()));
        let mut captured: Vec<CapturedRequest> = Vec::new();
        for leg in ["full-reader", "windowed-leased", "windowed-unleased"] {
            let dir = TempDir::new().unwrap();
            let path = dir.path().join("session.jsonl");
            std::fs::write(&path, &body).unwrap();
            let mut session = if leg == "full-reader" {
                SessionManager::open(dir.path(), dir.path(), &path)
            } else {
                SessionManager::open_windowed(dir.path(), dir.path(), &path)
                    .await
                    .unwrap()
            };
            if leg == "windowed-leased" {
                session.set_append_ownership(
                    crate::session::window::AppendOwnership::SessionLeaseHeld,
                );
                // The served-path proof: removing the file cannot fail
                // the shared-window parts.
                std::fs::remove_file(&path).unwrap();
                let probe = session.refine_transcript_parts();
                probe.await.unwrap();
                std::fs::write(&path, &body).unwrap();
            }
            // Two distinct stores, the shape every production session
            // wires: the global store and the session's own local store
            // never share a directory. Each carries one seeded entry, so
            // a crossed read — the local half reading the global store —
            // changes the prompt this test compares.
            let global_harness_dir = dir.path().join("harness");
            let local_harness_dir = dir.path().join("local-harness");
            seed_store_memory(&global_harness_dir, "gseed", HarnessScope::Global);
            seed_store_memory(&local_harness_dir, "lseed", HarnessScope::Local);
            let parts = session.refine_transcript_parts();
            let crate::session::manager::RefineTranscriptParts {
                messages,
                refinement_history,
            } = parts.await.unwrap();
            let session = tokio::sync::Mutex::new(session);
            let captured_requests: std::sync::Arc<std::sync::Mutex<Vec<CapturedRequest>>> =
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let sink = std::sync::Arc::clone(&captured_requests);
            let reply = r#"{"summary":"bench","edits":[]}"#.to_string();
            let result = execute_refinement(
                &session,
                &agent,
                RefinementTranscript {
                    messages: &messages,
                    refinement_history: &refinement_history,
                },
                &RefinementStores {
                    global_dir: global_harness_dir.clone(),
                    local_dir: Some(local_harness_dir.clone()),
                },
                &test_model(),
                &RefineOptions::default(),
                RefinementSource::User,
                Box::new(move |model, system, prompt| {
                    sink.lock().unwrap().push(CapturedRequest {
                        max_tokens: model.max_tokens,
                        system,
                        user: prompt,
                    });
                    let reply = reply;
                    Box::pin(async move { Ok(text_assistant(&reply)) })
                }),
                None,
            )
            .await
            .unwrap_or_else(|error| panic!("'{leg}' leg failed: {error:#}"));
            assert!(result.applied_edits.is_empty());
            let got = captured_requests.lock().unwrap().clone();
            assert_eq!(got.len(), 1, "'{leg}' leg: exactly one refiner call");
            captured.push(got[0].clone());
        }
        for (a, b) in captured.iter().zip(captured.iter().skip(1)) {
            assert_eq!(
                a, b,
                "the refiner request diverged between extraction paths (the frozen surface)"
            );
        }
        assert!(
            captured[0].user.contains("[refine_0] seed"),
            "the fixture's audit history must appear in the prompt"
        );
        assert!(
            captured[0].user.contains("hello 4"),
            "the fixture's conversation must appear in the prompt"
        );
        assert!(
            captured[0].user.contains("global:gseed]"),
            "the planner read the global store: {}",
            captured[0].user
        );
        assert!(
            captured[0].user.contains("local:lseed]"),
            "the planner read the session's own local store: {}",
            captured[0].user
        );

        // The read-leg proof: the unleased window must serve an
        // out-of-band audit row.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(&path, &body).unwrap();
        let session = SessionManager::open_windowed(dir.path(), dir.path(), &path)
            .await
            .unwrap();
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(
            br#"{"type":"custom","id":"oob-audit","parentId":"audit","customType":"prime-agent.refinement","data":{"id":"refine_oob","summary":"oob","rationale":"r","expectedOutcome":"o","appliedEdits":[],"harnessStatePath":""}}"#
        )
        .unwrap();
        file.write_all(b"\n").unwrap();
        drop(file);
        let parts = session.refine_transcript_parts();
        let crate::session::manager::RefineTranscriptParts {
            refinement_history, ..
        } = parts.await.unwrap();
        assert!(
            refinement_history
                .iter()
                .any(|item| item.id == "refine_oob"),
            "the unleased window must keep re-reading the file (out-of-band audit visible)"
        );
    }

    #[tokio::test]
    async fn global_refinement_appends_history() {
        let dir = TempDir::new().unwrap();
        let manager = persisted_session(&dir);
        let local_dir = local_store_for(&manager);
        let session = tokio::sync::Mutex::new(manager);
        let agent = Arc::new(Agent::new(AgentOptions::default()));
        let global_dir = dir.path().join("harness");
        let reply = r#"{"summary":"global lesson","edits":[{"action":"create","kind":"memory","id":"g1","title":"Lesson","content":"durable"}]}"#;
        let result = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[user_message("x")],
                refinement_history: &[],
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &RefineOptions {
                global: true,
                ..Default::default()
            },
            RefinementSource::SelfRefine,
            seam(reply),
            None,
        )
        .await
        .unwrap();
        assert_eq!(result.scope, Some(HarnessScope::Global));
        let global_state = load_harness_state(&global_dir, HarnessScope::Global);
        assert!(
            global_state.entries[&crate::refinement::RefinementKind::Memory].contains_key("g1")
        );
        let history = load_global_refinement_history(&global_dir);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, result.id);
        let rolled = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[],
                refinement_history: &[],
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &RefineOptions {
                global: true,
                rollback_id: Some(result.id.clone()),
                ..Default::default()
            },
            RefinementSource::User,
            seam("unused"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(rolled.rollback_of.as_deref(), Some(result.id.as_str()));
        let global_state = load_harness_state(&global_dir, HarnessScope::Global);
        assert!(
            !global_state.entries[&crate::refinement::RefinementKind::Memory].contains_key("g1")
        );
    }

    /// A rollback whose target recorded a different harness store than the
    /// session's current one — a pre-split record (the old session-dir or
    /// orphan agent-dir file) or another session's store — refuses and
    /// names both files instead of applying the inverse to a store the
    /// refinement never touched.
    #[tokio::test]
    async fn a_rollback_recorded_against_another_store_refuses_and_names_both() {
        let dir = TempDir::new().unwrap();
        let manager = persisted_session(&dir);
        let local_dir = local_store_for(&manager);
        let session = tokio::sync::Mutex::new(manager);
        let agent = Arc::new(Agent::new(AgentOptions::default()));
        let global_dir = dir.path().join("harness");
        // The pre-upgrade local record: the session dir's harness store,
        // the derivation this change replaced.
        let legacy_local_store = dir.path().join("session").join("harness");
        let legacy_local = RefinementResult {
            id: "refine_legacy_local".to_string(),
            summary: "legacy local".to_string(),
            rationale: "legacy".to_string(),
            expected_outcome: "legacy".to_string(),
            applied_edits: vec![],
            harness_state_path: crate::refinement::get_harness_state_path(&legacy_local_store)
                .display()
                .to_string(),
            rollback_of: None,
            scope: Some(HarnessScope::Local),
        };
        // The pre-upgrade global record: the orphan file directly in the
        // agent dir.
        let legacy_global_store = dir.path().join("agent").join("harness_state.json");
        let legacy_global = RefinementResult {
            id: "refine_legacy_global".to_string(),
            summary: "legacy global".to_string(),
            rationale: "legacy".to_string(),
            expected_outcome: "legacy".to_string(),
            applied_edits: vec![],
            harness_state_path: legacy_global_store.display().to_string(),
            rollback_of: None,
            scope: Some(HarnessScope::Global),
        };
        let rollback = |rollback_id: &str, global: bool| RefineOptions {
            global,
            rollback_id: Some(rollback_id.to_string()),
            ..Default::default()
        };
        // The local arm: the current store is the session's artifact dir.
        let error = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[],
                refinement_history: std::slice::from_ref(&legacy_local),
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &rollback("refine_legacy_local", false),
            RefinementSource::User,
            seam("unused"),
            None,
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains(&legacy_local.harness_state_path),
            "the refusal names the recorded store: {error:#}"
        );
        assert!(
            error.to_string().contains(
                crate::refinement::get_harness_state_path(&local_dir)
                    .display()
                    .to_string()
                    .as_str()
            ),
            "the refusal names the current store: {error:#}"
        );
        // The refusal stays true for both mismatch kinds: it names
        // another session's store (the fork-copied record) and drops
        // the pre-split-only claim that was false for that case.
        assert!(
            error.to_string().contains("another session's store"),
            "the refusal covers the fork-copied record: {error:#}"
        );
        assert!(
            !error
                .to_string()
                .contains("predates the store split and is no longer read"),
            "no claim that every recorded file predates the split: {error:#}"
        );
        assert!(
            !local_dir.join("harness_state.json").exists(),
            "the refusal happens before any write to the current store"
        );
        // The global arm: the current store is the agent dir's harness
        // dir, not the orphan file beside it.
        let error = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[],
                refinement_history: std::slice::from_ref(&legacy_global),
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &rollback("refine_legacy_global", true),
            RefinementSource::User,
            seam("unused"),
            None,
        )
        .await
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(&legacy_global.harness_state_path),
            "the refusal names the recorded store: {error:#}"
        );
        assert!(
            error.to_string().contains(
                crate::refinement::get_harness_state_path(&global_dir)
                    .display()
                    .to_string()
                    .as_str()
            ),
            "the refusal names the current store: {error:#}"
        );
        assert!(
            !global_dir.join("harness_state.json").exists(),
            "the refusal happens before any write to the current store"
        );
    }

    /// A rollback whose record spells the current store through a symlink
    /// still applies: the recorded `harness_state_path` is the raw join
    /// `save_harness_state` returned, so one store can carry two spellings
    /// (a symlinked dir — the macOS `$TMPDIR` shape — or a relative one),
    /// and the guard compares the real files, not the path strings.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_rollback_recorded_through_a_re_spelled_store_still_applies() {
        let dir = TempDir::new().unwrap();
        let manager = persisted_session(&dir);
        let local_dir = local_store_for(&manager);
        let session = tokio::sync::Mutex::new(manager);
        let agent = Arc::new(Agent::new(AgentOptions::default()));
        let global_dir = dir.path().join("harness");
        // A real create through the session's own store.
        let reply = r#"{"summary":"note it","rationale":"repeated","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m1","title":"Tactic","content":"Use tactic A"}]}"#;
        let result = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[user_message("do a thing twice")],
                refinement_history: &[],
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &RefineOptions::default(),
            RefinementSource::User,
            seam(reply),
            None,
        )
        .await
        .unwrap();
        // The same store re-spelled through a symlink, the shape a
        // differently-resolved dir records.
        let linked_store = dir.path().join("linked-store");
        std::os::unix::fs::symlink(&local_dir, &linked_store).unwrap();
        let mut record = result;
        record.harness_state_path = crate::refinement::get_harness_state_path(&linked_store)
            .display()
            .to_string();
        let rolled = execute_refinement(
            &session,
            &agent,
            RefinementTranscript {
                messages: &[],
                refinement_history: std::slice::from_ref(&record),
            },
            &RefinementStores {
                global_dir: global_dir.clone(),
                local_dir: Some(local_dir.clone()),
            },
            &test_model(),
            &RefineOptions {
                rollback_id: Some(record.id.clone()),
                ..Default::default()
            },
            RefinementSource::User,
            seam("unused"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            rolled.rollback_of.as_deref(),
            Some(record.id.as_str()),
            "the re-spelled record still rolls back: {rolled:#?}"
        );
        let state = load_harness_state(&local_dir, HarnessScope::Local);
        assert!(
            !state.entries[&crate::refinement::RefinementKind::Memory].contains_key("m1"),
            "the inverse Delete landed in the session's own store"
        );
    }
}
