use std::sync::Arc;

use pa_agent::agent::{Agent, AgentOptions};
use pa_types::ai::UserContent;
use pa_types::session::AgentMessage as SessionAgentMessage;

use super::compact_session::CompactOutcome;
use super::compaction::ContextPressure;
use super::{AgentSession, FileEntry, SessionManager};

fn user_turn(text: &str) -> SessionAgentMessage {
    SessionAgentMessage::User(pa_types::ai::UserMessage {
        content: UserContent::Text(text.to_string()),
        timestamp: 0,
        rest: pa_types::JsonMap::default(),
    })
}

fn faux_reply(text: &str) -> pa_types::ai::AssistantMessage {
    pa_ai::faux::faux_assistant_text_message(
        text,
        pa_ai::faux::FauxAssistantMessageOptions::default(),
    )
}

fn assistant_turn(text: &str) -> SessionAgentMessage {
    SessionAgentMessage::Assistant(faux_reply(text))
}

fn follow_up(text: &str) -> pa_ai::faux::FauxResponseStep {
    pa_ai::faux::FauxResponseStep::Message(faux_reply(text))
}

/// A held summarizer: the first `holds` responses block until released
/// (each call signals its start, then waits for one release); the
/// follow-ups answer immediately.
struct HeldSummarizer {
    registration: pa_ai::faux::FauxProviderRegistration,
    started: tokio::sync::mpsc::UnboundedReceiver<()>,
    release: std::sync::mpsc::Sender<()>,
    model: pa_types::ai::Model,
}

fn held_summarizer(holds: usize, follow_ups: Vec<pa_ai::faux::FauxResponseStep>) -> HeldSummarizer {
    let (started, started_rx) = tokio::sync::mpsc::unbounded_channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    let release_rx = Arc::new(std::sync::Mutex::new(release_rx));
    // The registration must be unique so concurrent tests never share a queue.
    let api = format!("faux-held-{:?}", std::time::SystemTime::now());
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            api: Some(api),
            provider: Some("faux-held".to_string()),
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "held-m".to_string(),
                ..Default::default()
            }]),
            ..Default::default()
        });
    let held = {
        let release_rx = Arc::clone(&release_rx);
        move |_: &pa_types::ai::Context,
              _: Option<&pa_ai::types::StreamOptions>,
              _: u64,
              _: &pa_types::ai::Model| {
            let _ = started.send(());
            let _ = release_rx.lock().expect("release lock").recv();
            Ok(faux_reply("## Goal\nsummarized goal"))
        }
    };
    let mut responses = vec![pa_ai::faux::FauxResponseStep::Factory(Arc::new(held)); holds];
    responses.extend(follow_ups);
    registration.set_responses(responses);
    let model = registration.get_model();
    HeldSummarizer {
        registration,
        started: started_rx,
        release,
        model,
    }
}

/// A session with `turns` exchanges whose compaction cuts at
/// `keep_recent_tokens` 12.
async fn held_engine(persisted: bool, turns: usize) -> (Arc<AgentSession>, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let mut manager = if persisted {
        SessionManager::persisted(tmp.path(), tmp.path())
    } else {
        SessionManager::in_memory(tmp.path())
    };
    for i in 0..turns {
        manager
            .append_message(user_turn(&format!("turn {i} with a few words")))
            .and_then(|_| manager.append_message(assistant_turn(&format!("reply {i}"))))
            .unwrap();
    }
    let agent = Arc::new(Agent::new(AgentOptions::default()));
    let engine = AgentSession::new(agent, manager, Vec::new()).await.unwrap();
    engine.set_compaction_settings(crate::session_engine::compaction::CompactionSettings {
        keep_recent_tokens: 12,
        ..Default::default()
    });
    (Arc::new(engine), tmp)
}

async fn wait_for_held_summarizer(summarizer: &mut HeldSummarizer) {
    let window = std::time::Duration::from_secs(3);
    let Ok(started) = tokio::time::timeout(window, summarizer.started.recv()).await else {
        panic!("the summarizer request never started in the window");
    };
    started.expect("the summarizer request started");
}

fn release(summarizer: &HeldSummarizer) {
    summarizer
        .release
        .send(())
        .expect("the summarizer released");
}

/// The session file's rows, parsed straight off disk.
fn file_entries(path: &std::path::Path) -> Vec<FileEntry> {
    crate::session::parse_session_entries(&std::fs::read_to_string(path).expect("the file reads"))
}

async fn compaction_rows(engine: &AgentSession) -> usize {
    engine
        .entries()
        .await
        .iter()
        .filter(|entry| matches!(entry, FileEntry::Compaction { .. }))
        .count()
}

fn spawn_compact(
    engine: &Arc<AgentSession>,
    model: &pa_types::ai::Model,
) -> tokio::task::JoinHandle<anyhow::Result<CompactOutcome>> {
    let engine = Arc::clone(engine);
    let model = model.clone();
    tokio::spawn(async move { engine.compact(None, &model, None, None).await })
}

/// A mid-window write is durable in the session file right away, visible
/// to `retained_entries()` reads (what `register_spawn` walks), and the
/// committed context survives a file reopen.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mid_summarize_writes_are_durable_now_and_ride_the_retained_tail() {
    let (engine, tmp) = held_engine(true, 3).await;
    let session_file = engine
        .shared_persistence()
        .lock()
        .await
        .get_session_file()
        .expect("the session file")
        .to_path_buf();
    let mut summarizer = held_summarizer(1, Vec::new());
    let compact = spawn_compact(&engine, &summarizer.model);
    wait_for_held_summarizer(&mut summarizer).await;

    let assistant_id = {
        let persistence = engine.shared_persistence();
        let mut session = persistence.lock().await;
        let (id, _) = session.append_message_retained(assistant_turn("mid-window reply"));
        let last = session
            .retained_entries()
            .iter()
            .rev()
            .find_map(|entry| match entry {
                FileEntry::Message {
                    message: SessionAgentMessage::Assistant(_),
                    base,
                } => base.id.clone(),
                _ => None,
            });
        assert_eq!(
            last,
            Some(id.clone()),
            "the mid-window row is visible in retained_entries()"
        );
        id
    };
    assert!(
        file_entries(&session_file)
            .iter()
            .any(|entry| entry.id() == Some(assistant_id.as_str())),
        "the mid-window row is durable in the session file during the window"
    );

    release(&summarizer);
    compact
        .await
        .expect("the compact task joined")
        .expect("the compaction ran");
    let rebuilt_live = {
        let session = engine.shared_persistence();
        let session = session.lock().await;
        crate::session_engine::compact_session::rebuilt_context_after_compaction(&session)
    };
    let reopened = SessionManager::open(tmp.path(), tmp.path(), &session_file);
    assert_eq!(
        reopened.active_context().messages,
        rebuilt_live,
        "the reopened file rebuilds the same context"
    );
    summarizer.registration.unregister();
}

/// A branch move mid-window is a structural conflict: the compaction
/// retries from PREPARE and commits against the moved-to tree.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_branch_move_mid_summarize_conflicts_and_commits_against_the_new_tree() {
    let (engine, _tmp) = held_engine(false, 6).await;
    let mut summarizer = held_summarizer(1, vec![follow_up("## Goal\nretry summary")]);
    let compact = spawn_compact(&engine, &summarizer.model);
    wait_for_held_summarizer(&mut summarizer).await;

    let entries = engine.entries().await;
    let branch_entries = entries[..entries.len() - 4].to_vec();
    let moved_to_leaf = branch_entries
        .last()
        .and_then(FileEntry::id)
        .expect("the moved-to leaf")
        .to_string();
    engine
        .rebuild_branch_context(branch_entries)
        .await
        .expect("the branch context rebuilt");

    release(&summarizer);
    compact
        .await
        .expect("the compact task joined")
        .expect("the retried compaction ran");
    assert_eq!(
        summarizer.registration.call_count(),
        2,
        "the branch move conflicted and retried the summarizer"
    );
    let entries = engine.entries().await;
    let compaction = entries
        .iter()
        .rev()
        .find(|entry| matches!(entry, FileEntry::Compaction { .. }))
        .expect("the compaction row");
    assert_eq!(
        compaction.parent_id(),
        Some(moved_to_leaf.as_str()),
        "the compaction committed against the moved-to tree"
    );
    summarizer.registration.unregister();
}

/// Overlapping compactions serialize: the second waits for the
/// in-flight run instead of summarizing the same prefix again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_compaction_waits_for_the_in_flight_one() {
    let (engine, _tmp) = held_engine(false, 3).await;
    // The follow-up response would let a racing second summarizer finish.
    let mut summarizer = held_summarizer(1, vec![follow_up("## Goal\nracing summary")]);
    let first = spawn_compact(&engine, &summarizer.model);
    wait_for_held_summarizer(&mut summarizer).await;
    let second = spawn_compact(&engine, &summarizer.model);

    release(&summarizer);
    first
        .await
        .expect("the first compact joined")
        .expect("the first compaction ran");
    second
        .await
        .expect("the second compact joined")
        .expect("the second compaction resolved");
    assert_eq!(
        summarizer.registration.call_count(),
        1,
        "only the in-flight compaction summarized"
    );
    assert_eq!(compaction_rows(&engine).await, 1);
    summarizer.registration.unregister();
}

/// A branch rebuild during every attempt: the compaction fails with the
/// retry-cap error after three summarizer calls, never committing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn repeated_branch_conflicts_fail_the_compaction_after_three_attempts() {
    let (engine, _tmp) = held_engine(false, 6).await;
    let mut summarizer = held_summarizer(3, Vec::new());
    let compact = spawn_compact(&engine, &summarizer.model);
    // Two disjoint branch halves to alternate between: every rebuild is
    // a structural conflict and every re-prepare stays compactable.
    let full = engine.entries().await;
    let trees = [
        full[..full.len() / 2].to_vec(),
        full[full.len() / 2..].to_vec(),
    ];
    for tree in 0..3 {
        wait_for_held_summarizer(&mut summarizer).await;
        engine
            .rebuild_branch_context(trees[tree % 2].clone())
            .await
            .expect("the branch context rebuilt");
        release(&summarizer);
    }
    let error = compact
        .await
        .expect("the compact task joined")
        .expect_err("the capped compaction failed");
    assert_eq!(
        error.to_string(),
        "compaction retried 3 times while the branch kept changing; try again"
    );
    assert_eq!(
        summarizer.registration.call_count(),
        3,
        "each attempt summarized once"
    );
    let committed = engine
        .entries()
        .await
        .iter()
        .any(|entry| matches!(entry, FileEntry::Compaction { .. }));
    assert!(!committed, "the capped compaction never committed");
    summarizer.registration.unregister();
}

/// A background summarize joins into the next `compact`: one summarizer
/// call, one compaction row.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_background_summarize_joins_into_the_next_compact() {
    let (engine, _tmp) = held_engine(false, 3).await;
    let mut summarizer = held_summarizer(1, Vec::new());
    engine
        .start_background_compaction(&summarizer.model, None)
        .await;
    wait_for_held_summarizer(&mut summarizer).await;
    let compact = spawn_compact(&engine, &summarizer.model);
    release(&summarizer);
    compact
        .await
        .expect("the compact task joined")
        .expect("the joined compaction ran");
    assert_eq!(
        summarizer.registration.call_count(),
        1,
        "only the background summarizer ran"
    );
    assert_eq!(compaction_rows(&engine).await, 1);
    summarizer.registration.unregister();
}

/// A background kick while a foreground `compact` runs is a no-op: the
/// flight is held, so no second summarizer starts.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_background_kick_while_a_compact_runs_is_a_noop() {
    let (engine, _tmp) = held_engine(false, 3).await;
    let mut summarizer = held_summarizer(1, Vec::new());
    let compact = spawn_compact(&engine, &summarizer.model);
    wait_for_held_summarizer(&mut summarizer).await;
    engine
        .start_background_compaction(&summarizer.model, None)
        .await;
    release(&summarizer);
    compact
        .await
        .expect("the compact task joined")
        .expect("the foreground compaction ran");
    assert_eq!(
        summarizer.registration.call_count(),
        1,
        "the kick started no second summarizer"
    );
    assert_eq!(compaction_rows(&engine).await, 1);
    summarizer.registration.unregister();
}

/// A joined summary that would leave the context over the blocking
/// threshold is discarded; the fresh path re-prepares and re-summarizes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_joined_summary_that_would_not_relieve_falls_back_to_the_fresh_path() {
    let (engine, _tmp) = held_engine(false, 3).await;
    let mut summarizer = held_summarizer(1, vec![follow_up("## Goal\nfresh summary")]);
    engine
        .start_background_compaction(&summarizer.model, None)
        .await;
    wait_for_held_summarizer(&mut summarizer).await;
    {
        let persistence = engine.shared_persistence();
        let mut session = persistence.lock().await;
        session.append_message_retained(user_turn(&"x".repeat(400_000)));
    }
    release(&summarizer);
    let compact = spawn_compact(&engine, &summarizer.model);
    compact
        .await
        .expect("the compact task joined")
        .expect("the fresh compaction ran");
    assert_eq!(
        summarizer.registration.call_count(),
        2,
        "the stale join was discarded and the fresh path re-summarized"
    );
    let entry = engine
        .entries()
        .await
        .iter()
        .rev()
        .find_map(|entry| match entry {
            FileEntry::Compaction { payload, .. } => Some(payload.summary.clone()),
            _ => None,
        })
        .expect("the compaction row");
    assert_eq!(entry, "## Goal\nfresh summary");
    assert_eq!(compaction_rows(&engine).await, 1);
    summarizer.registration.unregister();
}

/// A retained custom row in the kept tail is kept context: a joined
/// summary that would leave the rebuilt context over the blocking
/// threshold is discarded even with no mid-window growth — the fresh path
/// re-prepares and re-summarizes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_joined_summary_over_a_large_kept_custom_row_falls_back_to_the_fresh_path() {
    let (engine, _tmp) = held_engine(false, 3).await;
    // The kept tail's custom row predates the preparation, so the growth
    // term cannot carry it; only the kept estimate can.
    {
        let persistence = engine.shared_persistence();
        let mut session = persistence.lock().await;
        session.append_custom_message_retained(
            "custom_type",
            UserContent::Text("x".repeat(400_000)),
            false,
            None,
        );
    }
    let mut summarizer = held_summarizer(1, vec![follow_up("## Goal\nfresh summary")]);
    engine
        .start_background_compaction(&summarizer.model, None)
        .await;
    wait_for_held_summarizer(&mut summarizer).await;
    release(&summarizer);
    let compact = spawn_compact(&engine, &summarizer.model);
    compact
        .await
        .expect("the compact task joined")
        .expect("the fresh compaction ran");
    assert_eq!(
        summarizer.registration.call_count(),
        2,
        "the join that ignored the kept custom row was discarded"
    );
    let entry = engine
        .entries()
        .await
        .iter()
        .rev()
        .find_map(|entry| match entry {
            FileEntry::Compaction { payload, .. } => Some(payload.summary.clone()),
            _ => None,
        })
        .expect("the compaction row");
    assert_eq!(entry, "## Goal\nfresh summary");
    assert_eq!(compaction_rows(&engine).await, 1);
    summarizer.registration.unregister();
}

/// Poll the band consult until it goes due (a released flight resolves
/// and validates into a Ready join); the summarize completes
/// asynchronously after its release, so one immediate consult could
/// race the finished flight.
async fn consult_until_due(
    engine: &AgentSession,
    run_model: &pa_types::ai::Model,
    summarizer_model: &pa_types::ai::Model,
) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if engine
            .auto_compaction_now(run_model, summarizer_model, None)
            .await
        {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

/// A branch move stales a stored `Ready` join: the next band consult
/// re-validates it, discards it, and restarts in the background instead
/// of going due — the fresh summarize a stale due would block on below
/// Reserve never runs on the consult path.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_ready_join_restarts_in_the_background_instead_of_going_due() {
    // Window 128_000, no output budget, the default reserve headroom:
    // threshold 111_616, watermark 78_848 — the crafted 100_000-token
    // usage anchors the live context mid-band, before the branch move
    // and after it.
    let run_model: pa_types::ai::Model = serde_json::from_value(serde_json::json!({
        "id": "run-m", "name": "run model", "api": "openai-completions", "provider": "p",
        "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 128_000, "maxTokens": 0,
    }))
    .expect("the run model");
    let usage_turn = |text: &str| {
        let mut reply = faux_reply(text);
        reply.usage.total_tokens = 100_000;
        SessionAgentMessage::Assistant(reply)
    };
    let tmp = tempfile::tempdir().unwrap();
    let mut manager = SessionManager::in_memory(tmp.path());
    for i in 0..4 {
        manager
            .append_message(user_turn(&format!("turn {i} with a few words")))
            .and_then(|_| manager.append_message(usage_turn(&format!("reply {i}"))))
            .unwrap();
    }
    let agent = Arc::new(Agent::new(AgentOptions::default()));
    let engine = AgentSession::new(agent, manager, Vec::new()).await.unwrap();
    engine.set_compaction_settings(crate::session_engine::compaction::CompactionSettings {
        keep_recent_tokens: 12,
        ..Default::default()
    });
    let engine = Arc::new(engine);
    // Load the live loop context from the session — the daemon's restore
    // path — so the band consult measures the retained messages.
    engine
        .rebuild_branch_context(engine.entries().await)
        .await
        .expect("the live context loaded");
    assert_eq!(
        engine.context_pressure(&run_model).await,
        ContextPressure::Background,
        "the fixture must consult in the background band"
    );

    let mut summarizer = held_summarizer(1, Vec::new());
    assert!(
        !engine
            .auto_compaction_now(&run_model, &summarizer.model, None)
            .await,
        "the first consult starts the background summarize"
    );
    wait_for_held_summarizer(&mut summarizer).await;
    release(&summarizer);

    // The cancelled CompactionStart: the resolved flight stores as a
    // Ready join and no compact consumes it.
    assert!(
        consult_until_due(&engine, &run_model, &summarizer.model).await,
        "the finished flight stores as a usable Ready join"
    );

    // The branch move stales the join — the prepared prefix is gone —
    // while the moved-to branch keeps the pressure in the band.
    let entries = engine.entries().await;
    engine
        .rebuild_branch_context(entries[..entries.len() - 2].to_vec())
        .await
        .expect("the branch moved");
    assert_eq!(
        engine.context_pressure(&run_model).await,
        ContextPressure::Background,
        "the moved-to branch stays in the background band"
    );

    let mut restart = held_summarizer(1, Vec::new());
    assert!(
        !engine
            .auto_compaction_now(&run_model, &restart.model, None)
            .await,
        "the stale Ready is discarded and restarted in the background, not due"
    );
    wait_for_held_summarizer(&mut restart).await;
    release(&restart);
    assert!(
        consult_until_due(&engine, &run_model, &restart.model).await,
        "the restarted flight stores as a usable Ready join"
    );
    assert_eq!(
        summarizer.registration.call_count(),
        1,
        "only the first summarize ran on the first summarizer"
    );
    assert_eq!(
        restart.registration.call_count(),
        1,
        "the restart summarize ran on the restart summarizer"
    );
    summarizer.registration.unregister();
    restart.registration.unregister();
}

/// The daemon races a foreground join against its abort signal. Cancelling
/// that join drops its background task and never commits the prepared cut.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelling_a_background_join_preserves_the_transcript_and_releases_the_flight() {
    use std::future::Future as _;
    use std::task::Poll;

    let (engine, _tmp) = held_engine(true, 3).await;
    let before = engine.entries().await;
    let mut summarizer = held_summarizer(1, vec![follow_up("fresh after cancellation")]);
    engine
        .start_background_compaction(&summarizer.model, None)
        .await;
    wait_for_held_summarizer(&mut summarizer).await;
    let background = {
        let slot = engine.compaction_flight.lock().await;
        let Some(super::BackgroundFlight::Summarizing(handle)) = slot.as_ref() else {
            panic!("the background summarize is running");
        };
        handle.abort_handle()
    };
    let controller = pa_agent::abort::AbortController::new();
    let signal = controller.signal();
    let mut joined = Box::pin(pa_agent::abort::race_with_abort(
        engine.compact(None, &summarizer.model, None, Some(&signal)),
        &signal,
    ));
    std::future::poll_fn(|cx| {
        assert!(joined.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert!(
        engine.compaction_flight.try_lock().is_err(),
        "the join owns the flight"
    );
    controller.abort();
    let error = joined.await.expect_err("the foreground join is cancelled");
    assert!(pa_agent::abort::is_abort_error(&error));
    // The faux provider's synchronous factory needs releasing even when its
    // surrounding async task was aborted; real async transport drops at once.
    release(&summarizer);
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !background.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the cancelled background task terminates");
    assert_eq!(engine.entries().await, before);
    assert!(engine.compaction_flight.lock().await.is_none());
    let outcome = engine
        .compact(None, &summarizer.model, None, None)
        .await
        .unwrap();
    let CompactOutcome::Ran(run) = outcome else {
        panic!("fresh compaction runs")
    };
    assert_eq!(run.result.summary, "fresh after cancellation");
    assert_eq!(summarizer.registration.call_count(), 2);
    assert_eq!(compaction_rows(&engine).await, 1);
    summarizer.registration.unregister();
}

/// Explicit instructions replace an in-flight background summary and reach
/// the new summarizer request; the discarded flight cannot append a late cut.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn explicit_instructions_replace_the_background_summary() {
    let (engine, _tmp) = held_engine(true, 3).await;
    let instructions = "Retain the deployment rollback procedure";
    let replacement = pa_ai::faux::FauxResponseStep::Factory(Arc::new(move |context, _, _, _| {
        assert!(serde_json::to_string(context)
            .unwrap()
            .contains(instructions));
        Ok(faux_reply("instruction-specific summary"))
    }));
    let mut summarizer = held_summarizer(1, vec![replacement]);
    engine
        .start_background_compaction(&summarizer.model, None)
        .await;
    wait_for_held_summarizer(&mut summarizer).await;
    let background = {
        let slot = engine.compaction_flight.lock().await;
        let Some(super::BackgroundFlight::Summarizing(handle)) = slot.as_ref() else {
            panic!("the background summarize is running");
        };
        handle.abort_handle()
    };
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        engine.compact(Some(instructions), &summarizer.model, None, None),
    )
    .await
    .expect("instructions do not wait for the held background summary")
    .unwrap();
    release(&summarizer);
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !background.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the replaced background task terminates");
    let CompactOutcome::Ran(run) = outcome else {
        panic!("replacement compaction runs")
    };
    assert_eq!(run.result.summary, "instruction-specific summary");
    assert_eq!(run.entry.custom_instructions.as_deref(), Some(instructions));
    assert_eq!(summarizer.registration.call_count(), 2);
    assert_eq!(compaction_rows(&engine).await, 1);
    assert!(engine.compaction_flight.lock().await.is_none());
    summarizer.registration.unregister();
}

/// Increasing the next request's output budget can invalidate a prepared
/// join even when the model's context window has not changed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_larger_output_budget_rejects_a_prepared_background_join() {
    let (engine, _tmp) = held_engine(false, 3).await;
    let mut summarizer = held_summarizer(1, vec![follow_up("fresh for larger output budget")]);
    let mut run_model = summarizer.model.clone();
    run_model.context_window = 128_000;
    run_model.max_tokens = 0;
    engine
        .start_background_compaction(&summarizer.model, None)
        .await;
    wait_for_held_summarizer(&mut summarizer).await;
    {
        let persistence = engine.shared_persistence();
        let mut session = persistence.lock().await;
        session.append_message_retained(user_turn(&"x".repeat(340_000)));
    }
    release(&summarizer);
    let Some(super::BackgroundFlight::Summarizing(handle)) =
        engine.compaction_flight.lock().await.take()
    else {
        panic!("the background summarize was started");
    };
    let summary = handle.await.unwrap().unwrap();
    {
        let persistence = engine.shared_persistence();
        let session = persistence.lock().await;
        let relieves = |max_output_tokens| {
            super::compact_session::joined_summary_relieves(
                &session,
                &summary.attempt,
                &summary.prepared,
                run_model.context_window,
                max_output_tokens,
                &engine.compaction_settings(),
            )
        };
        assert!(relieves(0));
        assert!(!relieves(32_000));
    }
    run_model.max_tokens = 32_000;
    *engine.compaction_flight.lock().await =
        Some(super::BackgroundFlight::Ready(Box::new(summary)));
    let outcome = engine
        .compact_for_run_model(None, &run_model, &summarizer.model, None, None)
        .await
        .unwrap();
    let CompactOutcome::Ran(run) = outcome else {
        panic!("fresh compaction runs")
    };
    assert_eq!(run.result.summary, "fresh for larger output budget");
    assert_eq!(summarizer.registration.call_count(), 2);
    assert_eq!(compaction_rows(&engine).await, 1);
    summarizer.registration.unregister();
}

/// A Stop during PREPARE must not let that old boundary create a new request.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_during_background_prepare_never_starts_the_provider() {
    use std::future::Future as _;
    use std::task::Poll;

    let (engine, _tmp) = held_engine(true, 3).await;
    let summarizer = held_summarizer(0, vec![follow_up("must not be requested")]);
    let before = engine.entries().await;
    let guard = engine.session.lock().await;
    let mut start = Box::pin(engine.start_background_compaction(&summarizer.model, None));
    std::future::poll_fn(|cx| {
        assert!(start.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    engine.abort_background_compaction();
    drop(guard);
    start.await;
    let flight = engine.compaction_flight.lock().await.take();
    let Some(super::BackgroundFlight::Summarizing(handle)) = flight else {
        panic!("the prepared task should observe its cancelled epoch");
    };
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(3), handle)
        .await
        .expect("cancelled task must settle")
        .expect("task joins");
    assert!(pa_agent::abort::is_abort_error(
        &outcome.err().expect("cancelled task")
    ));
    assert_eq!(summarizer.registration.call_count(), 0);
    assert_eq!(engine.entries().await, before);
    summarizer.registration.unregister();
}

/// A boundary stopped before entering the core must not use the new epoch
/// created by Stop to launch replacement work.
#[tokio::test]
async fn cancelled_boundary_does_not_start_in_the_replacement_epoch() {
    let (engine, _tmp) = held_engine(true, 3).await;
    let summarizer = held_summarizer(0, vec![follow_up("must not be requested")]);
    let mut model = summarizer.model.clone();
    model.context_window = 128_000;
    model.max_tokens = 0;
    let mut reply = faux_reply("usage anchor");
    reply.usage.total_tokens = 100_000;
    engine
        .session
        .lock()
        .await
        .append_message(SessionAgentMessage::Assistant(reply))
        .unwrap();
    engine
        .rebuild_branch_context(engine.entries().await)
        .await
        .unwrap();
    assert_eq!(
        engine.context_pressure(&model).await,
        ContextPressure::Background
    );
    let boundary = pa_agent::abort::AbortController::new();
    boundary.abort();
    engine.abort_background_compaction();
    assert!(
        !engine
            .auto_compaction_now_with_abort(
                &model,
                &summarizer.model,
                None,
                Some(&boundary.signal())
            )
            .await
    );
    assert!(
        engine.compaction_flight.lock().await.is_none(),
        "stopped boundary created a flight"
    );
    assert_eq!(summarizer.registration.call_count(), 0);
    summarizer.registration.unregister();
}
