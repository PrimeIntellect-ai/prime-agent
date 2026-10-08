use std::sync::Arc;

use pa_agent::agent::{Agent, AgentOptions};
use pa_types::ai::UserContent;
use pa_types::session::AgentMessage as SessionAgentMessage;

use super::compact_session::CompactOutcome;
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
    let compactions = engine
        .entries()
        .await
        .iter()
        .filter(|entry| matches!(entry, FileEntry::Compaction { .. }))
        .count();
    assert_eq!(compactions, 1, "exactly one committed compaction");
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
