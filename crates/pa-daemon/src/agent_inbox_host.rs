//! The kernel host handlers of the swarm digest lanes (swarm PRs C/D/E):
//! `rlm.inbox.list`/`read`/`configure` and `rlm.watch.agent`/`agent_list`/
//! `agent_cancel` plus the kernel-side `bash.progress` job-watch request.
//!
//! The seam follows the bash-completion notice pattern: the receiving
//! WORKER owns the queue and the session store, so it installs closures
//! into the engine (`set_digest_inbox_seams`, `set_watch_notice_sink`) at
//! construction and the engine registers these handlers only when the
//! seams exist — every product session is a daemon worker, and anything
//! without the worker queue leaves the requests honestly unavailable.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};

use pa_core::kernel::shared::{host_handler, HostRequestHandlers};

use crate::agent_engine::AgentSessionEngine;
use crate::agent_watch::{
    AgentWatchRegistry, AgentWatchSnapshot, AGENT_WATCH_MAX_TOTAL, AGENT_WATCH_POLL_INTERVAL_MS,
};

/// The inbox listing seam: the `rlm.inbox.list` snapshot.
pub type InboxListFn = Arc<dyn Fn() -> Value + Send + Sync>;
/// The inbox read seam: the `rlm.inbox.read` body (`ids` of `None` reads
/// every unread entry).
pub type InboxReadFn = Arc<dyn Fn(Option<Vec<String>>) -> anyhow::Result<Value> + Send + Sync>;
/// The pin seam: the `rlm.inbox.configure` result.
pub type InboxConfigureFn = Arc<dyn Fn(&str) -> anyhow::Result<Value> + Send + Sync>;

/// One child snapshot's bounded wait: a fraction of the shared 5-second
/// poll cadence, so an unavailable child never stalls the poll for the
/// healthy subscriptions.
const WATCH_CHILD_SNAPSHOT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// The worker-installed inbox seams (swarm PR C): the digest inbox reads
/// and the pin live on the receiving worker; the kernel calls through
/// these closures.
#[derive(Clone)]
pub struct DigestInboxSeams {
    pub list: InboxListFn,
    pub read: InboxReadFn,
    pub configure: InboxConfigureFn,
}

/// The worker-installed watch routing: one watch event (agent or job)
/// routed through the digest-aware notice pipeline.
pub type WatchNoticeSink = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// The watch registration's engine-side state (swarm PR E): the
/// subscription registry plus the one-shared-poll arming flag. The poller
/// task exits when the registry empties or the session closes, and the
/// next registration re-arms it. The generation invalidates in-flight
/// poll passes at a session replacement (see
/// [`Self::poll_if_current`]).
#[derive(Debug, Default)]
pub(crate) struct AgentWatchHostState {
    pub registry: AgentWatchRegistry,
    pub poller_armed: std::sync::atomic::AtomicBool,
    /// Bumped by every registry reset (a session replacement's
    /// [`AgentSessionEngine::clear_agent_watches`]): a poll pass that
    /// snapshotted its subscriptions under an older generation must drop
    /// its results — the retired session's snapshot inputs must not
    /// poll the replacement session's registry or deliver its notices.
    pub generation: u64,
}

impl AgentWatchHostState {
    /// One poll pass's registry step: poll only while the state still
    /// carries the generation the pass snapshotted its subscriptions
    /// under (a session replacement clears the registry and bumps the
    /// generation between the poller's subscription snapshot and this
    /// step — the child snapshot queries in between are the race
    /// window). A stale pass answers `false` and its caller drops the
    /// events.
    pub(crate) fn poll_if_current(
        &mut self,
        generation: u64,
        subscriptions: &[crate::agent_watch::AgentWatchSubscription],
        snapshots: &HashMap<String, AgentWatchSnapshot>,
        events: &mut Vec<String>,
    ) -> bool {
        if self.generation != generation {
            return false;
        }
        // Discard snapshots captured before the subscription they answer
        // to was replaced: a (re-)registration that ran while this pass
        // was querying the children re-baselined the subscription with a
        // FRESHER count, so the pass's stale lower count must not be
        // accepted as compaction (it would move the baseline BACKWARDS
        // and the next poll re-emit the already-baselined range). The
        // current pass skips the child; the next pass re-snapshots.
        let mut current: HashMap<String, AgentWatchSnapshot> = HashMap::new();
        for subscription in subscriptions {
            if self.registry.registration_seq(&subscription.id)
                != Some(subscription.registration_seq)
            {
                continue;
            }
            if let Some(snapshot) = snapshots.get(&subscription.active_session_id) {
                current.insert(subscription.active_session_id.clone(), snapshot.clone());
            }
        }
        self.registry
            .poll(&mut crate::agent_watch::AgentWatchState {
                message_count: &|child_id: &str| current.get(child_id).cloned(),
                on_event: &mut |event| {
                    events.push(crate::agent_watch::format_agent_watch_notice(&event));
                },
            });
        true
    }
}

impl AgentSessionEngine {
    /// Install the digest inbox seams (the worker calls this at
    /// construction, before the first session build reads them in
    /// [`Self::register_digest_inbox_host_handlers`]).
    ///
    /// # Panics
    ///
    /// Panics when the seams mutex is poisoned (a holder panicked while
    /// holding the seam lock).
    pub fn set_digest_inbox_seams(&self, seams: DigestInboxSeams) {
        *self
            .digest_inbox_seams
            .lock()
            .expect("digest inbox seams lock") = Some(seams);
    }

    /// Install the watch notice sink (the worker owns the digest-aware
    /// notice routing).
    ///
    /// # Panics
    ///
    /// Panics when the sink mutex is poisoned (a holder panicked while
    /// holding the sink lock).
    pub fn set_watch_notice_sink(&self, sink: WatchNoticeSink) {
        *self
            .watch_notice_sink
            .lock()
            .expect("watch notice sink lock") = Some(sink);
    }

    /// `rlm.inbox.list` / `rlm.inbox.read` / `rlm.inbox.configure`
    /// (swarm PRs C + D): registered only when the worker seams exist —
    /// the same honest-unavailability contract the bash notice handlers
    /// hold.
    pub(crate) fn register_digest_inbox_host_handlers(&self, handlers: &mut HostRequestHandlers) {
        let Some(seams) = self
            .digest_inbox_seams
            .lock()
            .expect("digest inbox seams lock")
            .clone()
        else {
            return;
        };
        let list = Arc::clone(&seams.list);
        handlers.register(
            "rlm.inbox.list",
            host_handler(move |_payload| {
                let list = Arc::clone(&list);
                Box::pin(async move { Ok(list()) })
            }),
        );
        let read = Arc::clone(&seams.read);
        handlers.register(
            "rlm.inbox.read",
            host_handler(move |payload| {
                let read = Arc::clone(&read);
                Box::pin(async move {
                    let ids = match payload.data.get("ids") {
                        None | Some(Value::Null) => None,
                        Some(Value::Array(ids)) => Some(
                            ids.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect::<Vec<_>>(),
                        ),
                        Some(_) => {
                            anyhow::bail!("rlm.inbox.read ids must be an array of entry ids")
                        }
                    };
                    read(ids)
                })
            }),
        );
        let configure = Arc::clone(&seams.configure);
        handlers.register(
            "rlm.inbox.configure",
            host_handler(move |payload| {
                let configure = Arc::clone(&configure);
                Box::pin(async move {
                    let mode = payload
                        .data
                        .get("mode")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    configure(mode)
                })
            }),
        );
    }

    /// `rlm.watch.agent` / `agent_list` / `agent_cancel` and the kernel-side
    /// `bash.progress` job-watch request (swarm PR E): registered only when
    /// the worker's notice sink exists.
    pub(crate) fn register_watch_host_handlers(&self, handlers: &mut HostRequestHandlers) {
        let Some(sink) = self
            .watch_notice_sink
            .lock()
            .expect("watch notice sink lock")
            .clone()
        else {
            return;
        };
        let progress_sink = Arc::clone(&sink);
        handlers.register(
            "bash.progress",
            host_handler(move |payload| {
                let sink = Arc::clone(&progress_sink);
                Box::pin(async move {
                    let data = &payload.data;
                    let command = data
                        .get("command")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let numeric = "bash.progress requires numeric pid, fromBytes, toBytes";
                    let Some(pid) = data.get("pid").and_then(Value::as_u64) else {
                        anyhow::bail!("{numeric}");
                    };
                    let Some(from_bytes) = data.get("fromBytes").and_then(Value::as_u64) else {
                        anyhow::bail!("{numeric}");
                    };
                    let Some(to_bytes) = data.get("toBytes").and_then(Value::as_u64) else {
                        anyhow::bail!("{numeric}");
                    };
                    // No growth → no notice: a silent no-op, never an error.
                    if to_bytes > from_bytes {
                        sink(
                            "job",
                            &crate::agent_watch::format_job_watch_notice(
                                pid, from_bytes, to_bytes, command,
                            ),
                        );
                    }
                    Ok(json!({ "status": "ok" }))
                })
            }),
        );
        self.register_agent_watch_handlers(handlers, &sink);
    }

    fn register_agent_watch_handlers(
        &self,
        handlers: &mut HostRequestHandlers,
        sink: &WatchNoticeSink,
    ) {
        // The handlers hold the engine weakly (the registered self-arc):
        // the session owns the registry, the poller never pins the engine.
        let weak = self
            .self_weak
            .lock()
            .expect("engine self weak lock")
            .clone();
        let Some(weak) = weak else {
            return;
        };
        let weak = Arc::new(weak);
        let agent_sink = Arc::clone(sink);
        let agent_weak = Arc::clone(&weak);
        handlers.register(
            "rlm.watch.agent",
            host_handler(move |payload| {
                let engine = Arc::clone(&agent_weak);
                let sink = Arc::clone(&agent_sink);
                Box::pin(async move {
                    let Some(engine) = engine.upgrade() else {
                        anyhow::bail!("watch registration failed: session is closing");
                    };
                    let target = payload
                        .data
                        .get("target")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if target.is_empty() {
                        anyhow::bail!("rlm.watch.agent requires a target child name or id");
                    }
                    // Capture the session generation BEFORE the awaits: a
                    // session replacement's `clear_agent_watches` can run
                    // while the child resolution and the snapshot are in
                    // flight, and a watcher from the retired session must
                    // not land in the replacement's registry (it would
                    // poll and notify for a subscription the replacement
                    // never made).
                    let generation = engine.watch_host_state().generation;
                    let Some((child_id, child_name, active_session_id)) =
                        engine.resolve_watch_child(target).await
                    else {
                        anyhow::bail!("No direct child matches \"{target}\"");
                    };
                    let Some(initial) = engine.watch_child_snapshot(&active_session_id).await
                    else {
                        anyhow::bail!("Child \"{target}\" is not inspectable in-process");
                    };
                    let id = format!("watch-agent-{child_id}");
                    // Re-registration re-baselines (TS `registerAgentWatch`),
                    // preserving the active subscription when the lifetime
                    // limit rejects the replacement.
                    engine.register_agent_watch(
                        generation,
                        &id,
                        &active_session_id,
                        &child_name,
                        initial.clone(),
                    )?;
                    engine.arm_agent_watch_poller(sink);
                    Ok(json!({
                        "id": id,
                        "childName": child_name,
                        "messages": initial.message_count,
                    }))
                })
            }),
        );
        let list_weak = Arc::clone(&weak);
        handlers.register(
            "rlm.watch.agent_list",
            host_handler(move |_payload| {
                let engine = Arc::clone(&list_weak);
                Box::pin(async move {
                    let Some(engine) = engine.upgrade() else {
                        anyhow::bail!("watch listing failed: session is closing");
                    };
                    let watches = {
                        let state = engine.watch_host_state();
                        state
                            .registry
                            .list()
                            .iter()
                            .map(crate::agent_watch::AgentWatchSubscription::list_row)
                            .collect::<Vec<_>>()
                    };
                    Ok(json!({ "watches": watches }))
                })
            }),
        );
        let cancel_weak = Arc::clone(&weak);
        handlers.register(
            "rlm.watch.agent_cancel",
            host_handler(move |payload| {
                let engine = Arc::clone(&cancel_weak);
                Box::pin(async move {
                    let Some(engine) = engine.upgrade() else {
                        anyhow::bail!("watch cancel failed: session is closing");
                    };
                    let id = payload
                        .data
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if id.is_empty() {
                        anyhow::bail!("rlm.watch.agent_cancel requires an id");
                    }
                    let cancelled = engine.watch_host_state().registry.cancel(id);
                    Ok(json!({ "cancelled": cancelled }))
                })
            }),
        );
    }

    /// Clear every watch subscription (the "watchers die with the session"
    /// rule at a session replacement: the reused engine must not carry the
    /// replaced session's subscriptions into the new one). The shared
    /// poller exits on its next tick (the empty registry disarms it), and
    /// the generation bump kills any pass already in flight: its
    /// subscription snapshot belongs to the retired session, so it must
    /// not poll the replacement's registry or deliver its notices into
    /// the replacement's inbox.
    pub fn clear_agent_watches(&self) {
        let mut state = self.watch_host_state();
        state.registry = AgentWatchRegistry::default();
        state.generation += 1;
    }

    /// The watch host state accessor (register/poll paths hold the lock
    /// briefly; the poll task clones what it needs).
    pub(crate) fn watch_host_state(&self) -> std::sync::MutexGuard<'_, AgentWatchHostState> {
        self.agent_watches.lock().expect("agent watch state lock")
    }

    /// Resolve one watch target against this session's resident direct
    /// children (the registry join): a child id or session name.
    async fn resolve_watch_child(&self, target: &str) -> Option<(String, String, String)> {
        let children = self.children.as_ref()?.child_identities().await;
        let child = children
            .into_iter()
            .find(|child| child.rlm_child_id == target || child.session_name == target)?;
        if child.active_session_id.is_empty() {
            return None;
        }
        Some((
            child.rlm_child_id,
            child.session_name,
            child.active_session_id,
        ))
    }

    /// One child's activity snapshot over the supervisor link (`get_state`):
    /// the message count and the running/idle status. The timeout stays a
    /// fraction of the poll interval so one unavailable child cannot stall
    /// the shared poll (the queries run concurrently, each with this bound).
    async fn watch_child_snapshot(&self, active_session_id: &str) -> Option<AgentWatchSnapshot> {
        let data = self
            .link
            .request_success(
                json!({
                    "type": "get_state",
                    "activeSessionId": active_session_id,
                }),
                WATCH_CHILD_SNAPSHOT_TIMEOUT,
            )
            .await
            .ok()?;
        Some(AgentWatchSnapshot {
            message_count: data
                .get("messageCount")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            status: if data.get("isStreaming").and_then(Value::as_bool) == Some(true) {
                "running".to_string()
            } else {
                "idle".to_string()
            },
        })
    }

    /// Register one watch (re-registration re-baselines by cancelling
    /// first, TS `registerAgentWatch`). The lifetime-capacity check runs
    /// BEFORE the cancel, so a rejected replacement never silently drops
    /// the active subscription.
    ///
    /// `generation` is the session generation the registration captured
    /// BEFORE its pre-registration awaits (the child resolution and the
    /// snapshot): a session replacement's
    /// [`Self::clear_agent_watches`] bumps it, and a registration from
    /// the retired session must not land in the replacement's registry.
    /// The check rides the same registry hold as the registration.
    pub(crate) fn register_agent_watch(
        &self,
        generation: u64,
        id: &str,
        active_session_id: &str,
        child_name: &str,
        initial: AgentWatchSnapshot,
    ) -> anyhow::Result<()> {
        let mut state = self.watch_host_state();
        if state.generation != generation {
            anyhow::bail!("watch registration failed: session was replaced");
        }
        if !state.registry.can_register() {
            anyhow::bail!("Agent watch total limit reached ({AGENT_WATCH_MAX_TOTAL})");
        }
        state.registry.cancel(id);
        state
            .registry
            .register(id, active_session_id, child_name, initial)
            .map(|_| ())
    }

    /// Arm the one-shared watch poller (swarm PR E): a single background
    /// task while any subscription is active, exiting when the registry
    /// empties or the session closes — watchers never hold the process
    /// open (the TS `unref` analog: a tokio task never blocks process
    /// exit).
    fn arm_agent_watch_poller(self: &Arc<Self>, sink: WatchNoticeSink) {
        {
            let state = self.watch_host_state();
            if state.registry.is_empty() {
                return;
            }
            if state
                .poller_armed
                .swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(AGENT_WATCH_POLL_INTERVAL_MS).await;
                let Some(engine) = weak.upgrade() else {
                    return;
                };
                if engine.session_is_closed() {
                    let mut state = engine.watch_host_state();
                    state.registry = AgentWatchRegistry::default();
                    state
                        .poller_armed
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                    return;
                }
                // One poll cycle: snapshot every subscribed child, then
                // one registry pass turns the deltas into range events. The
                // generation rides the snapshot: a session replacement's
                // clear (between this snapshot and the registry pass)
                // invalidates the pass.
                let (subscriptions, generation) = {
                    let state = engine.watch_host_state();
                    if state.registry.is_empty() {
                        // Quiet by default: the poller dies with the last
                        // subscription (a later registration re-arms it).
                        state
                            .poller_armed
                            .store(false, std::sync::atomic::Ordering::SeqCst);
                        return;
                    }
                    (state.registry.list(), state.generation)
                };
                // Snapshot the children CONCURRENTLY (an unavailable child
                // gets its own bounded timeout instead of stalling the
                // shared poll for every healthy subscription), and query by
                // the child's ACTIVE SESSION ID — `get_state` routes by
                // `activeSessionId`, never by the RLM child id.
                let mut queries = Vec::with_capacity(subscriptions.len());
                for subscription in &subscriptions {
                    let engine = std::sync::Arc::clone(&engine);
                    let active_session_id = subscription.active_session_id.clone();
                    let query_id = active_session_id.clone();
                    queries.push(async move {
                        let snapshot = engine.watch_child_snapshot(&query_id).await;
                        (active_session_id, snapshot)
                    });
                }
                let mut snapshots: HashMap<String, AgentWatchSnapshot> = HashMap::new();
                for (active_session_id, snapshot) in futures::future::join_all(queries).await {
                    if let Some(snapshot) = snapshot {
                        snapshots.insert(active_session_id, snapshot);
                    }
                }
                let sink = Arc::clone(&sink);
                let mut events: Vec<String> = Vec::new();
                {
                    let mut state = engine.watch_host_state();
                    if !state.poll_if_current(generation, &subscriptions, &snapshots, &mut events) {
                        // The pass snapshotted the retired session's
                        // registry: drop its results instead of polling
                        // the replacement's registry with the stale child
                        // snapshots. The next tick re-snapshots fresh.
                        continue;
                    }
                }
                for content in events {
                    sink("agent", &content);
                }
            }
        });
    }
}
