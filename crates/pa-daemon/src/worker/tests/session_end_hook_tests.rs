//! Transport close ordering without external processes or network dependencies.
use super::*;
use crate::engine::{
    BranchSummaryOutcome, BranchSummaryRequest, CompactionOutcome, CompactionRequest,
    SideQuestionOutcome, SideQuestionRequest,
};

struct EndHookEngine {
    core: Arc<Mutex<SessionCore>>,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    calls: Arc<std::sync::atomic::AtomicUsize>,
}

impl SessionEngine for EndHookEngine {
    fn run_prompt(
        &self,
        prompt_index: usize,
        request: PromptRequest,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        ScriptedEngine::default().run_prompt(prompt_index, request, aborted, emit);
    }

    fn run_side_question(
        &self,
        request: SideQuestionRequest,
        signal: &pa_agent::abort::AbortSignal,
        sink: &pa_core::session_engine::side_question::SideQuestionSink,
    ) -> SideQuestionOutcome {
        ScriptedEngine::default().run_side_question(request, signal, sink)
    }

    fn run_compaction(
        &self,
        request: CompactionRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> CompactionOutcome {
        ScriptedEngine::default().run_compaction(request, signal)
    }

    fn run_branch_summary(
        &self,
        request: BranchSummaryRequest,
        signal: &pa_agent::abort::AbortSignal,
    ) -> BranchSummaryOutcome {
        ScriptedEngine::default().run_branch_summary(request, signal)
    }

    fn rebuild_session_context(
        &self,
        branch_entries: Vec<pa_types::session::FileEntry>,
        goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> anyhow::Result<()> {
        ScriptedEngine::default().rebuild_session_context(branch_entries, goal_reload)
    }

    fn end_session_hooks(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            {
                let core = self
                    .core
                    .try_lock()
                    .expect("end hook must not hold core lock");
                assert!(
                    !core.busy && !core.compacting,
                    "end hook must run after turn settlement"
                );
            }
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.entered.notify_one();
            self.release.notified().await;
        })
    }
}

#[tokio::test]
async fn session_end_hooks_are_awaited_unlocked_on_close_but_not_detach() {
    for command in ["shutdown", "kill"] {
        let mut worker = created_dispatch_worker().await;
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook_engine = Arc::new(EndHookEngine {
            core: Arc::clone(&worker.core),
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            calls: Arc::clone(&calls),
        });
        Arc::get_mut(&mut worker)
            .expect("unique worker fixture")
            .engine = hook_engine;
        worker
            .dispatch("detach", &json!({"clientId": "test-client"}))
            .await;
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        let closing = {
            let worker = Arc::clone(&worker);
            tokio::spawn(async move { worker.dispatch(command, &json!({})).await })
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
            .await
            .expect("close reaches end hook");
        assert!(!closing.is_finished(), "close must await its end callback");
        assert!(
            worker.core.try_lock().is_ok(),
            "callback holds no core lock"
        );
        release.notify_one();
        let response = closing.await.expect("close task succeeds");
        assert!(response.success, "{response:?}");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
