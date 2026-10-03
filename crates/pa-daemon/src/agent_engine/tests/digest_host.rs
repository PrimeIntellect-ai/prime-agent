//! The digest-lane kernel host handlers (swarm PRs C/D/E): the inbox seams,
//! the `bash.progress` job-watch validation, and the agent-watch
//! registration errors over a bare engine (no children registry, no worker
//! queue — exactly the honest-unavailability contract the bash notice
//! handlers hold).
use super::*;

use serde_json::json;

use pa_core::kernel::shared::{HostRequestHandlers, HostRequestPayload};

/// One bare engine with the digest seams + watch sink installed and its
/// self-arc registered (the handler closures hold the engine weakly).
struct Harness {
    _dir: tempfile::TempDir,
    /// Held only to keep the engine alive (the handler closures hold it
    /// weakly); the `call` guard reads it.
    engine: std::sync::Arc<AgentSessionEngine>,
    handlers: HostRequestHandlers,
    sink_calls: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
    read_state: std::sync::Arc<std::sync::Mutex<Vec<Option<Vec<String>>>>>,
    configure_state: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::TempDir::new().unwrap();
        let engine = std::sync::Arc::new(bare_engine(dir.path()));
        engine.register_arc();
        let read: std::sync::Arc<std::sync::Mutex<Vec<Option<Vec<String>>>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let configured = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
        let list_for_seam = std::sync::Arc::new(std::sync::Mutex::new(None::<Value>));
        let read_for_seam = std::sync::Arc::clone(&read);
        let configure_for_seam = std::sync::Arc::clone(&configured);
        engine.set_digest_inbox_seams(crate::agent_inbox_host::DigestInboxSeams {
            list: std::sync::Arc::new(move || {
                list_for_seam
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| json!({ "entries": [], "unread": 0, "total": 0 }))
            }),
            read: std::sync::Arc::new(move |ids| {
                read_for_seam.lock().unwrap().push(ids);
                Ok(json!({ "entries": [], "unread": 0 }))
            }),
            configure: std::sync::Arc::new(move |mode| {
                *configure_for_seam.lock().unwrap() = Some(mode.to_string());
                Ok(json!({ "mode": mode, "pinned": mode != "auto", "digest": mode == "digest" }))
            }),
        });
        let sink_calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_for_engine = std::sync::Arc::clone(&sink_calls);
        engine.set_watch_notice_sink(std::sync::Arc::new(move |watch, content| {
            sink_for_engine
                .lock()
                .unwrap()
                .push((watch.to_string(), content.to_string()));
        }));
        let mut handlers = HostRequestHandlers::default();
        engine.register_digest_inbox_host_handlers(&mut handlers);
        engine.register_watch_host_handlers(&mut handlers);
        Harness {
            _dir: dir,
            engine,
            handlers,
            sink_calls,
            read_state: read,
            configure_state: configured,
        }
    }

    async fn call(&self, request_type: &str, data: Value) -> anyhow::Result<Value> {
        // The closures hold the engine weakly (the TS self-arc pattern):
        // the harness keeps it alive through the calls.
        assert!(!self.engine.session_is_closed());
        let handler = self
            .handlers
            .get(request_type)
            .unwrap_or_else(|| panic!("missing handler {request_type}"))
            .clone();
        handler(HostRequestPayload {
            data,
            cell_source_code: None,
        })
        .await
    }
}

#[tokio::test]
async fn inbox_handlers_route_through_the_worker_seams() {
    let harness = Harness::new();
    let listing = harness.call("rlm.inbox.list", json!({})).await.unwrap();
    assert_eq!(listing["unread"], json!(0));
    assert_eq!(listing["total"], json!(0));

    harness.call("rlm.inbox.read", json!({})).await.unwrap();
    // The read-all form passes no ids through the seam.
    assert_eq!(harness.read_ids().last(), Some(&None));

    harness
        .call("rlm.inbox.read", json!({ "ids": ["entry-1", "entry-2"] }))
        .await
        .unwrap();
    assert_eq!(
        harness.read_ids().last(),
        Some(&Some(vec!["entry-1".to_string(), "entry-2".to_string()]))
    );

    let error = harness
        .call("rlm.inbox.read", json!({ "ids": "nope" }))
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("ids must be an array"),
        "{error}"
    );

    let pin = harness
        .call("rlm.inbox.configure", json!({ "mode": "digest" }))
        .await
        .unwrap();
    assert_eq!(pin["pinned"], json!(true));
    assert_eq!(pin["digest"], json!(true));
    assert_eq!(harness.configured_mode(), "digest");
}

impl Harness {
    fn read_ids(&self) -> std::sync::MutexGuard<'_, Vec<Option<Vec<String>>>> {
        self.read_state.lock().unwrap()
    }
    fn configured_mode(&self) -> String {
        self.configure_state.lock().unwrap().clone().unwrap()
    }
}

/// `bash.progress` (the kernel-side job watch): numeric validation, the
/// silent no-growth no-op, and the byte-range notice through the sink.
#[tokio::test]
async fn bash_progress_validates_and_no_growth_is_silent() {
    let harness = Harness::new();
    let error = harness
        .call(
            "bash.progress",
            json!({ "pid": "x", "fromBytes": 0, "toBytes": 1 }),
        )
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("bash.progress requires numeric pid, fromBytes, toBytes"),
        "{error}"
    );

    let ok = harness
        .call(
            "bash.progress",
            json!({ "pid": 5, "command": "c", "fromBytes": 40, "toBytes": 40 }),
        )
        .await
        .unwrap();
    assert_eq!(ok, json!({ "status": "ok" }));
    assert!(harness.sink_calls.lock().unwrap().is_empty());

    let ok = harness
        .call(
            "bash.progress",
            json!({ "pid": 99, "command": "tail -f", "fromBytes": 0, "toBytes": 400 }),
        )
        .await
        .unwrap();
    assert_eq!(ok, json!({ "status": "ok" }));
    let calls = harness.sink_calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "job");
    assert!(
        calls[0]
            .1
            .contains("[watch-job pid:99] output +400 bytes (0..400)"),
        "{calls:?}"
    );
}

/// The agent-watch registration over a bare engine (no children): the
/// payload errors and the honest no-children answer.
#[tokio::test]
async fn watch_agent_without_children_answers_the_ts_errors() {
    let harness = Harness::new();
    let error = harness
        .call("rlm.watch.agent", json!({}))
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("rlm.watch.agent requires a target child name or id"),
        "{error}"
    );
    let error = harness
        .call("rlm.watch.agent", json!({ "target": "ghost" }))
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("No direct child matches \"ghost\""),
        "{error}"
    );
    let error = harness
        .call("rlm.watch.agent_cancel", json!({}))
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("rlm.watch.agent_cancel requires an id"),
        "{error}"
    );
    let listing = harness
        .call("rlm.watch.agent_list", json!({}))
        .await
        .unwrap();
    assert_eq!(listing, json!({ "watches": [] }));
}

/// The session replacement invalidates an in-flight poll pass: a pass that
/// snapshotted its subscriptions before the replacement clear must not
/// poll the replacement session's registry with the retired session's
/// child snapshots (baseline corruption) nor deliver its notices into
/// the replacement's inbox.
#[test]
fn an_in_flight_poll_pass_dies_with_the_replaced_session() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = std::sync::Arc::new(bare_engine(dir.path()));
    let idle = crate::agent_watch::AgentWatchSnapshot {
        message_count: 0,
        status: "idle".to_string(),
    };
    // The retired session's watch.
    {
        let mut state = engine.watch_host_state();
        state
            .registry
            .register("watch-agent-old", "active-1", "c1", idle.clone())
            .unwrap();
    }
    // The in-flight pass snapshots the subscriptions (and their
    // generation) before the child snapshot queries run.
    let generation = engine.watch_host_state().generation;
    let subscriptions = engine.watch_host_state().registry.list();
    // ...the session replacement clears the watches mid-poll...
    engine.clear_agent_watches();
    // ...and the replacement session registers a fresh watch for the
    // SAME child.
    {
        let mut state = engine.watch_host_state();
        state
            .registry
            .register("watch-agent-new", "active-1", "c2", idle)
            .unwrap();
    }
    // The stale pass's snapshot map (built from the OLD subscription)
    // must not poll the replacement's registry.
    let mut snapshots = std::collections::HashMap::new();
    snapshots.insert(
        "active-1".to_string(),
        crate::agent_watch::AgentWatchSnapshot {
            message_count: 5,
            status: "idle".to_string(),
        },
    );
    let mut events: Vec<String> = Vec::new();
    let polled = engine.watch_host_state().poll_if_current(
        generation,
        &subscriptions,
        &snapshots,
        &mut events,
    );
    assert!(!polled, "the stale pass polled the replacement's registry");
    assert!(events.is_empty(), "the stale pass delivered: {events:?}");
    // The replacement's baseline is untouched.
    let baseline = engine
        .watch_host_state()
        .registry
        .list()
        .into_iter()
        .find(|watch| watch.id == "watch-agent-new")
        .expect("the replacement's watch");
    assert_eq!(baseline.last_seen_messages, 0);
    // A pass under the CURRENT generation still polls: the replacement's
    // watch emits from its own baseline.
    let generation = engine.watch_host_state().generation;
    let subscriptions = engine.watch_host_state().registry.list();
    let mut events: Vec<String> = Vec::new();
    let polled = engine.watch_host_state().poll_if_current(
        generation,
        &subscriptions,
        &snapshots,
        &mut events,
    );
    assert!(polled, "a current-generation pass did not poll");
    assert_eq!(events.len(), 1, "{events:?}");
    let baseline = engine
        .watch_host_state()
        .registry
        .list()
        .into_iter()
        .find(|watch| watch.id == "watch-agent-new")
        .expect("the replacement's watch");
    assert_eq!(baseline.last_seen_messages, 5);
}
/// A poll pass must discard snapshots captured before the subscription it
/// snapshotted was re-registered: the re-registration (the handler's
/// cancel+register) re-baselined the subscription with a FRESHER count,
/// and the pass's in-flight snapshot of the older count must not be
/// accepted as compaction — that would move the baseline BACKWARDS and
/// the next poll would re-emit the already-baselined range.
#[test]
fn a_stale_snapshot_never_moves_a_re_registered_baseline_backwards() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = std::sync::Arc::new(bare_engine(dir.path()));
    // The pass snapshots its subscriptions while the child reports 10.
    let ten = crate::agent_watch::AgentWatchSnapshot {
        message_count: 10,
        status: "idle".to_string(),
    };
    {
        let mut state = engine.watch_host_state();
        state
            .registry
            .register("watch-agent-c1", "active-1", "c1", ten.clone())
            .unwrap();
    }
    let generation = engine.watch_host_state().generation;
    let subscriptions = engine.watch_host_state().registry.list();
    let mut snapshots = std::collections::HashMap::new();
    snapshots.insert("active-1".to_string(), ten);
    // ...the child grows to 11 and the session re-registers the watch
    // (re-baselining it at 11) while the pass's in-flight snapshot still
    // reports the older 10...
    let eleven = crate::agent_watch::AgentWatchSnapshot {
        message_count: 11,
        status: "idle".to_string(),
    };
    {
        let mut state = engine.watch_host_state();
        state.registry.cancel("watch-agent-c1");
        state
            .registry
            .register("watch-agent-c1", "active-1", "c1", eleven)
            .unwrap();
    }
    // ...so the pass must drop its stale snapshot for the re-registered
    // subscription: no event, and the baseline holds at 11 (a poll that
    // accepted the stale 10 as compaction would re-baseline to 10).
    let mut events: Vec<String> = Vec::new();
    let polled = engine.watch_host_state().poll_if_current(
        generation,
        &subscriptions,
        &snapshots,
        &mut events,
    );
    assert!(polled, "the current-generation pass refused to poll");
    assert!(events.is_empty(), "the stale pass emitted: {events:?}");
    let baseline = engine
        .watch_host_state()
        .registry
        .list()
        .into_iter()
        .find(|watch| watch.id == "watch-agent-c1")
        .expect("the re-registered watch");
    assert_eq!(
        baseline.last_seen_messages, 11,
        "the stale snapshot moved the baseline backwards"
    );
    // The next pass (a FRESH snapshot of 12) emits from the 11 baseline
    // — never the duplicated 10..12 the stale baseline would allow.
    let subscriptions = engine.watch_host_state().registry.list();
    let mut snapshots = std::collections::HashMap::new();
    snapshots.insert(
        "active-1".to_string(),
        crate::agent_watch::AgentWatchSnapshot {
            message_count: 12,
            status: "idle".to_string(),
        },
    );
    let mut events: Vec<String> = Vec::new();
    engine
        .watch_host_state()
        .poll_if_current(generation, &subscriptions, &snapshots, &mut events);
    assert_eq!(events.len(), 1, "{events:?}");
    assert!(
        events[0].contains("messages 11..12 (+1)"),
        "the re-baselined range: {events:?}"
    );
}

/// A watch registration that captured the session generation BEFORE its
/// pre-registration awaits must not land in the replacement's registry:
/// the handler resolves the child and snapshots it across awaits, and a
/// session replacement's `clear_agent_watches` can run in between — the
/// retired session's watcher must not poll and notify for the
/// replacement (replacements never inherit the retired session's
/// subscriptions).
#[test]
fn a_registration_from_the_retired_session_never_lands_in_the_replacement() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = std::sync::Arc::new(bare_engine(dir.path()));
    let idle = crate::agent_watch::AgentWatchSnapshot {
        message_count: 0,
        status: "idle".to_string(),
    };
    // The handler's capture, before its awaits.
    let generation = engine.watch_host_state().generation;
    // ...the child resolution and the child snapshot awaits run, and a
    // session replacement clears the watches mid-flight...
    engine.clear_agent_watches();
    // ...so the post-await registration must refuse.
    let error = engine
        .register_agent_watch(generation, "watch-agent-c1", "active-1", "c1", idle.clone())
        .unwrap_err();
    assert!(
        error.to_string().contains("session was replaced"),
        "{error}"
    );
    assert!(
        engine.watch_host_state().registry.is_empty(),
        "the retired session's watch landed in the replacement"
    );
    // The replacement session's OWN registration (captured after the
    // clear) still lands.
    let generation = engine.watch_host_state().generation;
    engine
        .register_agent_watch(generation, "watch-agent-c2", "active-2", "c2", idle)
        .unwrap();
    assert_eq!(engine.watch_host_state().registry.list().len(), 1);
}
