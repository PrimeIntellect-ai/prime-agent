//! The provider-burst coalescing family: the per-tick update
//! coalescing and the settle-frame flush.
use super::*;

/// One scripted turn that streams `deltas` partial-message updates and
/// settles with one final assistant message. `spacing_ms` paces the
/// deltas so the flusher tick can interleave.
struct BurstStreamEngine {
    deltas: usize,
    spacing_ms: u64,
}

impl BurstStreamEngine {
    fn message_with(text: &str) -> Value {
        json!({
            "role": "assistant",
            "provider": "faux",
            "model": "faux-1",
            "content": [{ "type": "text", "text": text }],
        })
    }

    fn delta_text(index: usize) -> String {
        "x".repeat((index + 1) * 4)
    }

    fn full_text(&self) -> String {
        Self::delta_text(self.deltas)
    }
}

impl SessionEngine for BurstStreamEngine {
    fn run_prompt(
        &self,
        _prompt_index: usize,
        _request: PromptRequest,
        _aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        for index in 0..=self.deltas {
            let message = Self::message_with(&Self::delta_text(index));
            let stream_event = if index == 0 {
                json!({ "type": "start" })
            } else {
                json!({ "type": "text_delta", "delta": "xxxx" })
            };
            if !emit(EngineEvent::AssistantUpdate {
                message: crate::engine::AssistantSnapshot::Wire(message),
                stream_event: Some(stream_event),
            }) {
                return;
            }
            if self.spacing_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(self.spacing_ms));
            }
        }
        if !emit(EngineEvent::AssistantMessage(Self::message_with(
            &self.full_text(),
        ))) {
            return;
        }
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

fn texts_at(events: &[Value], positions: &[usize]) -> Vec<String> {
    positions
        .iter()
        .filter_map(|index| {
            events[*index]["message"]["content"][0]["text"]
                .as_str()
                .map(str::to_string)
        })
        .collect()
}

/// A provider that outruns the flush tick still broadcasts at most one
/// parked update per tick — never one wire frame per delta.
#[tokio::test]
async fn a_provider_burst_broadcasts_one_coalesced_update_per_tick_not_per_delta() {
    const DELTAS: usize = 120;
    // 1ms spacing: the burst spans ~120ms, so the 50ms flusher tick
    // flushes at most a handful of mid-burst snapshots.
    let engine = Arc::new(BurstStreamEngine {
        deltas: DELTAS,
        spacing_ms: 1,
    });
    let events = turn_session_events(engine).await;

    assert_eq!(
        positions_of(&events, "message_start").len(),
        1,
        "one message_start frame opens the stream"
    );
    let updates = positions_of(&events, "message_update");
    let end = positions_of(&events, "message_end");
    assert_eq!(end.len(), 1, "the turn settles with one message_end");
    assert!(
        !updates.is_empty(),
        "the parked snapshots must reach the wire"
    );
    assert!(
        updates.len() * 10 < DELTAS,
        "{DELTAS} spaced deltas must coalesce to a handful of wire updates, saw {}",
        updates.len()
    );
    // The latest snapshot wins: the flushed update carries the full
    // message so far, and superseded snapshots are dropped.
    assert_eq!(
        texts_at(&events, &updates).last().map(String::len),
        Some((DELTAS + 1) * 4),
        "the last flushed update must carry the full text"
    );
    // Event-sequence order: every update precedes the settle frame.
    assert!(
        updates.iter().all(|index| *index < end[0]),
        "a superseded snapshot must never follow message_end"
    );
}

/// The streamed-turn pipeline end to end, timed on the turn wall clock.
/// The faux splitter randomizes chunk sizes, so runs vary; compare
/// medians, not single runs.
#[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
#[tokio::test]
#[ignore = "run with cargo test -p pa-daemon --release streamed_turn_pipeline_benchmark -- --ignored --nocapture"]
async fn streamed_turn_pipeline_benchmark() {
    for text_kb in [64usize, 256, 512] {
        let _faux = crate::agent_engine::FAUX_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dir = tempfile::TempDir::new().unwrap();
        let word = "benchmark word ";
        let text = word.repeat(text_kb * 1024 / word.len());
        let script = serde_json::json!({
            "engine": "faux",
            "responses": [{ "content": [{ "type": "text", "text": text }] }],
            "contextWindow": 4_000_000,
            "maxTokens": 4_000_000,
        });
        let engine = AgentSessionEngine::new(AgentEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: dir.path().join("agent"),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: None,
            session_file: None,
            faux_script: Some(script.to_string()),
            supervisor_link: None,
            telemetry_disabled: Some(true),
            cron_store: None,
            queued_steering_probe: None,
        })
        .unwrap();
        let started = std::time::Instant::now();
        let events = turn_session_events(std::sync::Arc::new(engine)).await;
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        let updates = events
            .iter()
            .filter(|event| event["type"] == "message_update")
            .count();
        let end = events
            .iter()
            .find(|event| event["type"] == "message_end" && event["message"]["role"] == "assistant")
            .expect("the assistant message_end frame");
        assert_eq!(end["message"]["content"][0]["text"], json!(text));
        println!("text_kb={text_kb} elapsed_ms={elapsed_ms:.1} wire_updates={updates}");
    }
}

/// The parked loop snapshot reaches the wire intact: the last flushed
/// `text_delta` update before `message_end` carries the final content.
#[allow(clippy::await_holding_lock)] // the faux registry is process-global: the guard must span the async flow
#[tokio::test]
async fn the_last_parked_update_carries_the_final_content() {
    let _faux = crate::agent_engine::FAUX_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().unwrap();
    let text = "pin word ".repeat(512);
    let script = json!({ "engine": "faux", "responses": [{ "content": [{ "type": "text", "text": text }] }] });
    let engine = AgentSessionEngine::new(AgentEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: dir.path().join("agent"),
        provider: None,
        model: None,
        api_key: None,
        thinking: None,
        session_dir: None,
        session_file: None,
        faux_script: Some(script.to_string()),
        supervisor_link: None,
        telemetry_disabled: Some(true),
        cron_store: None,
        queued_steering_probe: None,
    })
    .unwrap();
    let events = turn_session_events(Arc::new(engine)).await;
    let end = *positions_of(&events, "message_end")
        .last()
        .expect("message_end");
    let last_delta = positions_of(&events, "message_update")
        .into_iter()
        .rfind(|index| {
            *index < end && events[*index]["assistantMessageEvent"]["type"] == "text_delta"
        })
        .expect("a flushed text_delta update");
    assert_eq!(
        events[last_delta]["message"]["content"],
        events[end]["message"]["content"]
    );
    assert_eq!(events[end]["message"]["content"][0]["text"], json!(text));
}

/// The client sees the full message without a tick wait and nothing lands out of order.
#[tokio::test]
async fn an_instant_burst_flushes_the_final_snapshot_with_its_settle_frame() {
    const DELTAS: usize = 200;
    let engine = Arc::new(BurstStreamEngine {
        deltas: DELTAS,
        spacing_ms: 0,
    });
    let events = turn_session_events(engine).await;

    let updates = positions_of(&events, "message_update");
    let end = positions_of(&events, "message_end");
    assert_eq!(end.len(), 1, "the turn settles with one message_end");
    assert!(
        updates.len() <= 3,
        "an instant burst broadcasts at most the settle-flushed snapshot (a mid-burst tick race adds one per 50ms stall), saw {}",
        updates.len()
    );
    assert!(
        texts_at(&events, &updates)
            .iter()
            .any(|text| text.len() == (DELTAS + 1) * 4),
        "the flushed snapshot must carry the full message"
    );
    assert!(
        updates.iter().all(|index| *index < end[0]),
        "the flushed snapshot precedes message_end"
    );
}
