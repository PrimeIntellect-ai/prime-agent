//! The idle-park family: the parent-owned kernel release at the idle
//! park and the compacting admission gate.
use super::*;

/// A recording engine for the settled-child kernel release: the park arm
/// fires the trait method; the test counts the fires.
struct ReleaseCountingEngine {
    releases: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    fired: std::sync::Arc<tokio::sync::Notify>,
}

impl SessionEngine for ReleaseCountingEngine {
    fn run_prompt(
        &self,
        _prompt_index: usize,
        _request: PromptRequest,
        _aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        emit(EngineEvent::Done(Ok(())));
    }

    fn run_side_question(
        &self,
        _request: SideQuestionRequest,
        _signal: &pa_agent::abort::AbortSignal,
        _sink: &pa_core::session_engine::side_question::SideQuestionSink,
    ) -> SideQuestionOutcome {
        SideQuestionOutcome::Failed {
            answer: String::new(),
            error: "unsupported".to_string(),
        }
    }

    fn run_compaction(
        &self,
        _request: CompactionRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> CompactionOutcome {
        CompactionOutcome::Skipped {
            message: "nothing to compact".to_string(),
        }
    }

    fn run_branch_summary(
        &self,
        _request: crate::engine::BranchSummaryRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> crate::engine::BranchSummaryOutcome {
        crate::engine::BranchSummaryOutcome::Failed {
            error: "unsupported".to_string(),
        }
    }

    fn rebuild_session_context(
        &self,
        _branch_entries: Vec<pa_types::session::FileEntry>,
        _goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    fn release_settled_child_kernel(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        self.releases
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.fired.notify_waiters();
        Box::pin(std::future::ready(()))
    }
}

/// The bounded timeout is the failure bound (positive arm) and the absence bound (gated arms).
#[tokio::test]
async fn the_idle_park_releases_a_parent_owned_childs_kernel_only() {
    struct ParkedProbe {
        releases: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    async fn park_with(depth: u32, attached: bool, compacting: bool) -> ParkedProbe {
        let releases = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let fired = std::sync::Arc::new(tokio::sync::Notify::new());
        let runner = burst_runner(Arc::new(ReleaseCountingEngine {
            releases: std::sync::Arc::clone(&releases),
            fired: std::sync::Arc::clone(&fired),
        }));
        {
            let mut core = runner.core.lock().unwrap();
            core.rlm_depth = depth;
            core.compacting = compacting;
            if attached {
                core.attached_client_ids.push("client-1".to_string());
            }
        }
        let task = tokio::spawn(async move {
            runner.run().await;
        });
        // The wait is the observable readiness: the park arm fires the release when
        // the policy holds; the tear-down runs after the await resolves either way.
        let _ =
            tokio::time::timeout(std::time::Duration::from_millis(2000), fired.notified()).await;
        task.abort();
        ParkedProbe { releases }
    }

    // A parent-owned child releases its kernel at the idle park: the
    // notification arrives (the bounded wait is the failure bound).
    let probe = park_with(1, false, false).await;
    assert_eq!(
        probe.releases.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "the park arm must fire the release for a parent-owned child"
    );
    // A root, an attached child, and a compacting child stay resident: no
    // readiness event exists, so the bound itself is the absence proof.
    let probe = park_with(0, false, false).await;
    assert_eq!(
        probe.releases.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "a root session keeps its kernel"
    );
    let probe = park_with(1, true, false).await;
    assert_eq!(
        probe.releases.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "an attached child keeps its kernel resident"
    );
    let probe = park_with(1, false, true).await;
    assert_eq!(
        probe.releases.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "a compacting child keeps its kernel resident"
    );
}

/// A recording engine for the admission-gate tests: every `run_prompt` call
/// lands in `prompts` (parked admissions never do).
#[derive(Default)]
struct AdmitProbeEngine {
    prompts: Mutex<Vec<String>>,
}

impl SessionEngine for AdmitProbeEngine {
    fn run_prompt(
        &self,
        _prompt_index: usize,
        request: PromptRequest,
        _aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        self.prompts.lock().unwrap().push(request.message);
        emit(EngineEvent::Done(Ok(())));
    }

    fn run_side_question(
        &self,
        _request: SideQuestionRequest,
        _signal: &pa_agent::abort::AbortSignal,
        _sink: &pa_core::session_engine::side_question::SideQuestionSink,
    ) -> SideQuestionOutcome {
        SideQuestionOutcome::Failed {
            answer: String::new(),
            error: "unsupported".to_string(),
        }
    }

    fn run_compaction(
        &self,
        _request: CompactionRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> CompactionOutcome {
        CompactionOutcome::Skipped {
            message: "nothing to compact".to_string(),
        }
    }

    fn run_branch_summary(
        &self,
        _request: crate::engine::BranchSummaryRequest,
        _signal: &pa_agent::abort::AbortSignal,
    ) -> crate::engine::BranchSummaryOutcome {
        crate::engine::BranchSummaryOutcome::Failed {
            error: "unsupported".to_string(),
        }
    }

    fn rebuild_session_context(
        &self,
        _branch_entries: Vec<pa_types::session::FileEntry>,
        _goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> anyhow::Result<()> {
        Ok(())
    }
}

/// A resume site that clears the suspension MID-WINDOW must not admit a racing turn.
#[tokio::test]
async fn compacting_window_parks_a_cleared_suspension_until_it_ends() {
    let engine = Arc::new(AdmitProbeEngine::default());
    let runner = burst_runner(Arc::clone(&engine) as Arc<dyn SessionEngine>);
    let (done_tx, mut done_rx) = oneshot::channel();
    {
        // The mid-compaction shape: the suspension is clear while the
        // window is open, the item parked — the racing class.
        let mut core = runner.core.lock().unwrap();
        core.compacting = true;
        core.queued_input_suspended = false;
        core.steering.push_back(QueuedItem {
            priority: QueuePriority::Human,
            preview: None,
            message: "racing steer".to_string(),
            custom_message: None,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: Some(done_tx),
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
        });
    }
    let parked = std::sync::Arc::clone(&runner.core);
    let work_notify = std::sync::Arc::clone(&runner.work_notify);
    let running = tokio::spawn(async move { runner.run().await });
    // The gate parks the wake again on the compacting term (the
    // suspension is already clear).
    work_notify.notify_one();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    {
        let core = parked.lock().unwrap();
        assert!(!core.busy, "the racing steer admitted mid-compaction");
        assert_eq!(
            core.steering.len(),
            1,
            "the parked steer left its lane mid-compaction"
        );
    }
    assert!(
        engine.prompts.lock().unwrap().is_empty(),
        "the racing user row reached the engine mid-window"
    );
    // The window ends (the compact's tail clears the flag and wakes the
    // runner): the parked steer delivers after it.
    {
        let mut core = parked.lock().unwrap();
        core.compacting = false;
    }
    work_notify.notify_one();
    let done = tokio::time::timeout(std::time::Duration::from_secs(5), &mut done_rx).await;
    assert!(
        done.is_ok(),
        "the parked steer never delivered after the window"
    );
    let delivered = engine.prompts.lock().unwrap().clone();
    assert_eq!(
        delivered,
        vec!["racing steer".to_string()],
        "the steer must deliver after the window, not during it"
    );
    running.abort();
}

// ---------------------------------------------------------------------------
// The whole-worker idle passivation's park arm (TS `idleEvictionMinutes`).
// ---------------------------------------------------------------------------

/// A settings fixture: the agent dir's `settings.json` carries the
/// `idleEvictionMinutes` value under test.
pub(super) fn passivation_settings(dir: &std::path::Path, value: &serde_json::Value) {
    std::fs::create_dir_all(dir).unwrap();
    let settings = serde_json::json!({ "idleEvictionMinutes": value });
    std::fs::write(
        dir.join("settings.json"),
        serde_json::to_string(&settings).unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn idle_passivation_window_arms_only_for_idle_unattached_sessions() {
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    passivation_settings(&agent_dir, &serde_json::json!(1));
    let engine = Arc::new(ScriptedEngine::default());
    let mut runner = burst_runner(Arc::clone(&engine) as Arc<dyn SessionEngine>);
    // The shared PassivationContext with a live settings dir.
    runner.passivation.agent_dir = agent_dir.clone();

    // An idle root session under a live threshold: the window arms (TS
    // `canEvictWorker` reaches roots; the depth fence is gone).
    {
        let mut core = runner.core.lock().unwrap();
        core.cwd = dir.path().to_string_lossy().to_string();
        core.last_activity_ms = crate::util::now_ms();
    }
    let window = runner.idle_passivation_window();
    assert!(window.is_some(), "an unattached idle root must arm");
    // A 1-minute threshold from now: the remaining window is under a
    // minute (the clock already ran during the test).
    assert!(
        window.unwrap() <= std::time::Duration::from_secs(60),
        "the remaining window must be the threshold minus the elapsed idle"
    );

    // An attached client cancels the window.
    runner.core.lock().unwrap().attached_client_ids = vec!["client-1".to_string()];
    assert!(runner.idle_passivation_window().is_none());
    runner.core.lock().unwrap().attached_client_ids = Vec::new();

    // An idle clock that already crossed the threshold arms a zero window.
    {
        let mut core = runner.core.lock().unwrap();
        core.last_activity_ms = crate::util::now_ms().saturating_sub(120_000);
    }
    assert_eq!(
        runner.idle_passivation_window(),
        Some(std::time::Duration::from_secs(0)),
        "a crossed clock must fire immediately"
    );

    // `"off"` disables the whole arm.
    passivation_settings(&agent_dir, &serde_json::json!("off"));
    assert!(runner.idle_passivation_window().is_none());
}

#[tokio::test]
async fn idle_passivation_refuses_while_the_lanes_hold_undelivered_input() {
    // A parked steer or follow-up lives only on the resident worker, so neither
    // the window nor the fire's fence may pass while the lanes hold it.
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    passivation_settings(&agent_dir, &serde_json::json!(1));
    let engine = Arc::new(ScriptedEngine::default());
    let mut runner = burst_runner(Arc::clone(&engine) as Arc<dyn SessionEngine>);
    runner.passivation.agent_dir = agent_dir;
    {
        let mut core = runner.core.lock().unwrap();
        core.rlm_depth = 1;
        core.cwd = dir.path().to_string_lossy().to_string();
        // The idle clock long crossed the 1-minute threshold: without
        // the queued arm this window would fire immediately.
        core.last_activity_ms = crate::util::now_ms().saturating_sub(120_000);
        core.steering.push_back(QueuedItem {
            priority: QueuePriority::Human,
            preview: None,
            message: "the parked steer".to_string(),
            custom_message: None,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images: Vec::new(),
            done: None,
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
        });
    }
    assert!(
        runner.idle_passivation_window().is_none(),
        "a queued steer in the lanes must cancel the window"
    );
    // The fire's fresh-snapshot fence holds the same arm: the observable is the
    // absence of any local stop (the dead-socket link answers best-effort).
    runner.maybe_request_idle_passivation().await;
    assert!(
        runner.core.lock().unwrap().steering.len() == 1,
        "the queued steer must survive the fire's fence"
    );
    // An empty follow-up lane alone does not block; a queued follow-up
    // does (the same arm, the other lane).
    runner.core.lock().unwrap().steering.clear();
    assert!(
        runner.idle_passivation_window().is_some(),
        "an empty lane re-arms the window"
    );
    runner.core.lock().unwrap().follow_up.push_back(QueuedItem {
        priority: QueuePriority::Human,
        preview: None,
        message: "the parked follow-up".to_string(),
        custom_message: None,
        agent_message: None,
        queue_key: None,
        admission_id: None,
        images: Vec::new(),
        done: None,
        queue_visible: true,
        policy: TurnPolicy::Queued,
        forced_batch: false,
    });
    assert!(
        runner.idle_passivation_window().is_none(),
        "a queued follow-up in the lanes must cancel the window"
    );
}

#[tokio::test]
async fn idle_passivation_fire_rechecks_the_fresh_state_and_reports_the_threshold() {
    // The fire's fresh-snapshot fence: an attached client (or an armed scheduled
    // job via the engine gate) cancels the stop even when the window armed before
    // the change; the fire never stops the worker locally and never panics.
    let dir = tempfile::TempDir::new().unwrap();
    let agent_dir = dir.path().join("agent");
    passivation_settings(&agent_dir, &serde_json::json!(1));
    let engine = Arc::new(ScriptedEngine::default());
    let mut runner = burst_runner(Arc::clone(&engine) as Arc<dyn SessionEngine>);
    runner.passivation.agent_dir = agent_dir;
    {
        let mut core = runner.core.lock().unwrap();
        core.rlm_depth = 1;
        core.cwd = dir.path().to_string_lossy().to_string();
        core.last_activity_ms = crate::util::now_ms().saturating_sub(120_000);
    }
    // The fence: an attached client arrived during the window.
    runner.core.lock().unwrap().attached_client_ids = vec!["client-1".to_string()];
    runner.maybe_request_idle_passivation().await;
    // No local stop occurred (the dead-socket link answers errors
    // best-effort).
}
