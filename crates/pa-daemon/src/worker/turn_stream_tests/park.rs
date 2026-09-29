//! The idle-park family (moved with its concern): the parent-owned
//! kernel release at the idle park and the compacting admission
//! gate, with the `ReleaseCountingEngine` + `AdmitProbeEngine` fixtures.
use super::*;

/// A recording engine for the settled-child kernel release (TS #2483's
/// inline arm): the runner's park arm fires the trait method, and the
/// test counts the fires.
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

/// The settled-child kernel release fires from the park arm only for a
/// parent-owned child (TS #2483's `canPassivateSettledSession`,
/// worker-side): a depth-1 child with no attached clients releases at
/// the idle park; a root session, an attached child, and a compacting
/// child stay resident.
/// The settled-child kernel release fires from the park arm only for a
/// parent-owned child (TS #2483's `canPassivateSettledSession`,
/// worker-side). The test waits for the observable readiness (the
/// engine's release notification) - the bounded timeout is the
/// failure bound for the positive arm and the absence bound for the
/// gated arms (no fixed sleep ever makes a pass).
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
        // The runner parks with no work in flight; the park arm
        // fires the release when the policy holds and the engine
        // notifies - the wait is the observable readiness, and the
        // task tear-down runs after the await resolves either way.
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
    // A root session, an attached child, and a compacting child stay
    // resident: the same observable read must NOT fire within the
    // absence bound (there is no readiness event to await, so the
    // bound itself is the absence proof).
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

/// A recording engine for the admission-gate tests: every `run_prompt`
/// call lands in `prompts` (the served-path probe — a racing admission
/// reaches the engine, a parked one never does).
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

/// The compacting admission gate (TS `isCompacting` rides
/// `_isBusyForSessionInput("pump")`'s `externalBusy`): a resume site that
/// clears the queued-input suspension MID-WINDOW must not admit a racing
/// turn — the queued item stays parked until the window ends. The
/// served-path probe is the engine itself: `run_prompt` records every
/// admission, so a racing turn would appear as a prompt while the window
/// is open.
#[tokio::test]
async fn compacting_window_parks_a_cleared_suspension_until_it_ends() {
    let engine = Arc::new(AdmitProbeEngine::default());
    let runner = burst_runner(Arc::clone(&engine) as Arc<dyn SessionEngine>);
    let (done_tx, mut done_rx) = oneshot::channel();
    {
        // The mid-compaction shape: the manual compact set the
        // suspension with the window open, then a resume site (a steer's
        // `wake: "immediate"` resume, TS `_admitSessionInput`) cleared
        // the suspension and parked its item — the racing class.
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
    // The resume site's wake reaches the runner; the gate must park it
    // again on the compacting term (the suspension is already clear).
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
