//! The delivery-wiring pins: the queue lane an item rode decides the
//! engine request's `streaming_behavior` — the steering lane steers a
//! busy agent, the follow-up lane queues at its boundary — so every
//! delivery class carries its sender's intent into admission. Mutation:
//! dropping the lane mapping in `run_turn` leaves the request behavior
//! `None`, and the witness assertions go red.
use super::*;

/// Records every admitted request's (message, streaming behavior).
#[derive(Default)]
struct RequestWitnessEngine {
    requests: Mutex<Vec<(String, Option<pa_core::session_engine::StreamingBehavior>)>>,
}

impl SessionEngine for RequestWitnessEngine {
    fn run_prompt(
        &self,
        _prompt_index: usize,
        request: PromptRequest,
        _aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        self.requests
            .lock()
            .unwrap()
            .push((request.message.clone(), request.streaming_behavior));
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

fn lane_item(message: &str) -> QueuedItem {
    QueuedItem {
        priority: QueuePriority::Human,
        preview: None,
        message: message.to_string(),
        custom_message: None,
        agent_message: None,
        queue_key: None,
        admission_id: None,
        images: Vec::new(),
        done: None,
        queue_visible: true,
        policy: TurnPolicy::Queued,
        forced_batch: false,
    }
}

/// Wait until `count` requests landed (one admitted request per lane item).
async fn wait_for_requests(
    engine: &RequestWitnessEngine,
    count: usize,
) -> Vec<(String, Option<pa_core::session_engine::StreamingBehavior>)> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let requests = engine.requests.lock().unwrap().clone();
        if requests.len() >= count {
            return requests;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the runner never admitted {count} request(s): {requests:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn the_steering_lane_steers_and_the_follow_up_lane_queues_at_its_boundary() {
    let engine = Arc::new(RequestWitnessEngine::default());
    let runner = burst_runner(Arc::clone(&engine) as Arc<dyn SessionEngine>);
    {
        let mut core = runner.core.lock().unwrap();
        core.steering.push_back(lane_item("steer item"));
        core.follow_up.push_back(lane_item("follow-up item"));
    }
    let work_notify = Arc::clone(&runner.work_notify);
    let running = tokio::spawn(async move { runner.run().await });
    work_notify.notify_one();

    let requests = wait_for_requests(&engine, 2).await;
    assert_eq!(requests[0].0, "steer item");
    assert_eq!(
        requests[0].1,
        Some(pa_core::session_engine::StreamingBehavior::Steer),
        "the steering lane carries the steer intent"
    );
    assert_eq!(requests[1].0, "follow-up item");
    assert_eq!(
        requests[1].1,
        Some(pa_core::session_engine::StreamingBehavior::FollowUp),
        "the follow-up lane carries the boundary-queue intent"
    );
    running.abort();
}
