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
    sink_calls: std::sync::Arc<std::sync::Mutex<Vec<(String, String, String)>>>,
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
        engine.set_watch_notice_sink(std::sync::Arc::new(move |watch, target, content| {
            sink_for_engine.lock().unwrap().push((
                watch.to_string(),
                target.to_string(),
                content.to_string(),
            ));
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
    assert_eq!(calls[0].1, "99", "the sink call is (kind, target, content)");
    assert!(
        calls[0]
            .2
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
    // ...the session replacement clears the watches mid-poll (the
    // test's replacement carries no lane reset)...
    engine.clear_agent_watches(Box::new(|| {}));
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
    let mut events: Vec<(String, String)> = Vec::new();
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
    let mut events: Vec<(String, String)> = Vec::new();
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
    let mut events: Vec<(String, String)> = Vec::new();
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
    let mut events: Vec<(String, String)> = Vec::new();
    engine
        .watch_host_state()
        .poll_if_current(generation, &subscriptions, &snapshots, &mut events);
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(
        events[0].0, "c1",
        "the event carries its target: {events:?}"
    );
    assert!(
        events[0].1.contains("messages 11..12 (+1)"),
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
    // session replacement clears the watches mid-flight (the test's
    // replacement carries no lane reset)...
    engine.clear_agent_watches(Box::new(|| {}));
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

/// A poll pass's generation validation, its registry poll, and its
/// delivery ride ONE watch-state hold: with the delivery outside the
/// hold, a session replacement can complete its lane reset and its watch
/// retirement between the pass's validation and its sink, and the retired
/// pass injects its notices into the replacement's inbox or steering
/// queue (the "watchers die with the session" rule). The probed sink
/// pins the hold: the watch state must be UNAVAILABLE while the pass
/// delivers (the pass's own thread holds it — std mutexes do not
/// reenter, so the probe runs on another thread).
#[test]
fn a_watch_pass_delivers_under_the_same_hold_it_validated_under() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = std::sync::Arc::new(bare_engine(dir.path()));
    let initial = crate::agent_watch::AgentWatchSnapshot {
        message_count: 5,
        status: "idle".to_string(),
    };
    {
        let mut state = engine.watch_host_state();
        state
            .registry
            .register("watch-agent-c1", "active-1", "c1", initial)
            .unwrap();
    }
    // A pass's inputs: the subscription snapshot (and its generation)
    // plus the child snapshots the poller gathered.
    let generation = engine.watch_host_state().generation;
    let subscriptions = engine.watch_host_state().registry.list();
    let mut snapshots = std::collections::HashMap::new();
    snapshots.insert(
        "active-1".to_string(),
        crate::agent_watch::AgentWatchSnapshot {
            message_count: 8,
            status: "idle".to_string(),
        },
    );
    // The prober thread rendezvous with the sink AT DELIVERY.
    let (probe_tx, probe_rx) = std::sync::mpsc::channel::<()>();
    let (verdict_tx, verdict_rx) = std::sync::mpsc::channel::<bool>();
    let probing_engine = std::sync::Arc::clone(&engine);
    let prober = std::thread::spawn(move || {
        probe_rx.recv().expect("the probe signal");
        let held = probing_engine.agent_watches.try_lock().is_err();
        verdict_tx.send(held).expect("the verdict channel");
    });
    let delivered =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::<(String, String, String)>::new()));
    let recorded = std::sync::Arc::clone(&delivered);
    let probe_tx = std::sync::Mutex::new(probe_tx);
    let verdict_rx = std::sync::Mutex::new(verdict_rx);
    let sink: crate::agent_inbox_host::WatchNoticeSink = std::sync::Arc::new(
        move |watch, target, content| {
            probe_tx.lock().unwrap().send(()).expect("the probe signal");
            let held = verdict_rx.lock().unwrap().recv().expect("the verdict");
            assert!(
                held,
                "the pass delivered outside the watch hold: a replacement could retire the session mid-delivery"
            );
            recorded.lock().unwrap().push((
                watch.to_string(),
                target.to_string(),
                content.to_string(),
            ));
        },
    );
    engine.deliver_watch_pass(generation, &subscriptions, &snapshots, &sink);
    {
        let delivered = delivered.lock().unwrap();
        assert_eq!(delivered.len(), 1, "{delivered:?}");
        assert_eq!(delivered[0].0, "agent");
        assert_eq!(delivered[0].1, "c1", "the event's target");
        assert_eq!(
            delivered[0].2, "[watch-agent child:c1] messages 5..8 (+3)",
            "the range event"
        );
    }
    prober.join().expect("the prober");
    // The delivery consumed the growth: the baseline advanced to 8.
    let baseline = engine
        .watch_host_state()
        .registry
        .list()
        .into_iter()
        .find(|watch| watch.id == "watch-agent-c1")
        .expect("the watch");
    assert_eq!(baseline.last_seen_messages, 8);
}

/// The session replacement's lane reset (the store swap and the digest
/// reset) runs INSIDE the watch retirement's hold — the same hold a
/// poll pass's validation and delivery ride: a pass that validated under
/// the current generation delivers into the retiring session's pipeline
/// or not at all. With the reset outside the hold, the replacement's
/// store swap never takes the watch lock, so a pass holding its
/// validated events can sink them into the ALREADY-swapped core (the
/// retired session's notices land in the replacement). The probing reset
/// pins the hold: the watch state must be UNAVAILABLE while the reset
/// runs, and the retirement must complete (the registry empties and the
/// generation bumps) once the hold ends.
#[test]
fn a_replacement_runs_its_lane_reset_inside_the_watch_hold() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = std::sync::Arc::new(bare_engine(dir.path()));
    let idle = crate::agent_watch::AgentWatchSnapshot {
        message_count: 0,
        status: "idle".to_string(),
    };
    // The retired session's watch (the registry is non-empty so the
    // retirement is observable).
    {
        let mut state = engine.watch_host_state();
        state
            .registry
            .register("watch-agent-old", "active-1", "c1", idle)
            .unwrap();
    }
    let generation = engine.watch_host_state().generation;
    let (probe_tx, probe_rx) = std::sync::mpsc::channel::<()>();
    let (verdict_tx, verdict_rx) = std::sync::mpsc::channel::<bool>();
    let probing_engine = std::sync::Arc::clone(&engine);
    let prober = std::thread::spawn(move || {
        probe_rx.recv().expect("the probe signal");
        let held = probing_engine.agent_watches.try_lock().is_err();
        verdict_tx.send(held).expect("the verdict channel");
    });
    let probe_tx = std::sync::Mutex::new(probe_tx);
    let verdict_rx = std::sync::Mutex::new(verdict_rx);
    let mut reset_ran = false;
    let reset = || {
        reset_ran = true;
        probe_tx.lock().unwrap().send(()).expect("the probe signal");
        let held = verdict_rx.lock().unwrap().recv().expect("the verdict");
        assert!(
            held,
            "the replacement's lane reset ran outside the watch retirement's hold"
        );
    };
    engine.clear_agent_watches(Box::new(reset));
    assert!(reset_ran, "the retirement never ran its lane reset");
    prober.join().expect("the prober");
    // The retirement completed under the hold: the registry is empty and
    // the generation bumped, so a pass that snapshotted the retired
    // session is stale.
    assert!(
        engine.watch_host_state().registry.list().is_empty(),
        "the replacement inherited the retired session's watches"
    );
    assert_ne!(
        engine.watch_host_state().generation,
        generation,
        "the retirement did not bump the watch generation"
    );
}
