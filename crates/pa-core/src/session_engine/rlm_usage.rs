//! RLM child-usage attribution: the producer that folds a recursive
//! child's billable usage into the parent assistant row that spawned it.
//!
//! TS `agent-session.ts`: `attributeChildUsage` (the child's fields and
//! cost fold into the parent row while `totalTokens` stays the parent's
//! model-facing context — recursive children launch from an assistant
//! tool call, so their tokens affect billable totals, not the parent
//! turn's context), the per-run `pendingChildUsage` origin buckets, and
//! `flushPendingChildUsageAttribution` (one durable `child_usage_attributed`
//! row per origin batch through `SessionManager.appendChildUsageAttribution`,
//! with the failure swallowed as recoverable bookkeeping).
//!
//! Observation split (PORTING-NOTES): TS children run in-process, so the
//! parent subscribes to child events and folds live at every child
//! `message_end`. Rust children are separate worker processes; the
//! daemon's children registry (`pa-daemon/rlm_children.rs`) observes
//! child turn boundaries and delivers per-origin usage batches here.
//! The flush folds the batch into the target assistant row in the
//! session manager and appends the durable row in one event — the
//! daemon's stats read the file, so there is no separate live-message
//! fold to keep in step (TS updates the live message object because its
//! own stats surfaces read it; the durable row is the same source of
//! truth in both).

use std::collections::HashMap;

use pa_types::ai::Usage;
use pa_types::session::ChildUsageOrigin;

use crate::session::manager::SessionManager;

/// TS `addAssistantUsage`: fold one usage block into a running total.
/// Shared with the daemon's child-side walk (`rlm_child_usage.rs`).
pub fn add_assistant_usage(total: &mut Usage, usage: &Usage) {
    // Saturating: billable aggregation must neither panic in debug nor
    // wrap to an underbill in release (the same convention as every
    // other usage sum in the accounting family).
    total.input = total.input.saturating_add(usage.input);
    total.output = total.output.saturating_add(usage.output);
    total.cache_read = total.cache_read.saturating_add(usage.cache_read);
    total.cache_write = total.cache_write.saturating_add(usage.cache_write);
    total.total_tokens = total.total_tokens.saturating_add(usage.total_tokens);
    total.cost.input = add_cost(total.cost.input, usage.cost.input);
    total.cost.output = add_cost(total.cost.output, usage.cost.output);
    total.cost.cache_read = add_cost(total.cost.cache_read, usage.cost.cache_read);
    total.cost.cache_write = add_cost(total.cost.cache_write, usage.cost.cache_write);
    total.cost.total = add_cost(total.cost.total, usage.cost.total);
}

/// TS cost math runs on plain numbers; `JsNumber` keeps the wire parity.
fn add_cost(total: pa_types::JsNumber, usage: pa_types::JsNumber) -> pa_types::JsNumber {
    pa_types::JsNumber(total.as_f64() + usage.as_f64())
}

/// TS `attributeChildUsage`: child work affects session-level billable
/// totals, not the parent's model-facing context size, so the parent's
/// context tokens are restored over the summed fields after the fold.
pub(crate) fn attribute_child_usage(parent_usage: &mut Usage, child_usage: &Usage) {
    let parent_context_tokens = super::compaction::calculate_context_tokens(parent_usage);
    add_assistant_usage(parent_usage, child_usage);
    parent_usage.total_tokens = parent_context_tokens;
}

/// Per-origin batches observed for one child at one observation boundary,
/// in first-seen origin order (TS `pendingChildUsage` Map order).
#[derive(Debug, Clone)]
pub struct RlmChildUsageReport {
    pub rlm_child_id: String,
    pub batches: Vec<(ChildUsageOrigin, Usage)>,
}

/// The producer the daemon's child observation feeds: spawn registration
/// plus the durable flush. One instance per session engine, shared with
/// the kernel's `rlm.spawn` handler through [`super::rlm_host::RlmHostBridge`].
pub struct RlmChildUsageAttributions {
    session: std::sync::Arc<tokio::sync::Mutex<SessionManager>>,
    /// TS `_rlmDurableParentUsage`: the spawn-time usage plus every
    /// durably-attributed batch, per parent assistant row — the aggregate
    /// base shared by all children of one assistant. Async: the flush
    /// holds it across the durable append so batches serialize in
    /// observation order (the TS single event queue's guarantee).
    bases: tokio::sync::Mutex<HashMap<String, Usage>>,
    /// TS `parentAssistantForUsage`: the parent assistant row each child
    /// attributes to, captured at spawn. Dropped when the child's final
    /// observation lands ([`Self::forget_child`]) — TS keeps the
    /// per-child subscription alive only while the child lives, and a
    /// session that runs sequential children must not accumulate their
    /// registrations.
    children: std::sync::Mutex<HashMap<String, String>>,
    /// The `rlm child usage attributed` adoption event's handle (`None`
    /// in sessions without telemetry — subagents never double-report).
    telemetry: std::sync::Mutex<Option<std::sync::Arc<super::telemetry::SessionTelemetry>>>,
    /// The producer a rebuild handed observation over to: an in-flight
    /// emission that cloned the retired sink still delivers through this
    /// producer, and the report forwards to the successor — the
    /// successor's adopted bases then carry the late batch's aggregate
    /// onward, so a post-rebuild chain never silently drops it.
    forward: std::sync::Mutex<Option<std::sync::Arc<RlmChildUsageAttributions>>>,
    /// The producer this one replaced (a rebuild's successor consulting
    /// the retired side for a registration the adoption copy raced): a
    /// Weak back-pointer, so the handoff pair never keeps each other
    /// alive.
    fallback: std::sync::Mutex<Option<std::sync::Weak<RlmChildUsageAttributions>>>,
}

impl RlmChildUsageAttributions {
    pub fn new(session: std::sync::Arc<tokio::sync::Mutex<SessionManager>>) -> Self {
        Self {
            session,
            bases: tokio::sync::Mutex::new(HashMap::new()),
            children: std::sync::Mutex::new(HashMap::new()),
            telemetry: std::sync::Mutex::new(None),
            forward: std::sync::Mutex::new(None),
            fallback: std::sync::Mutex::new(None),
        }
    }

    /// Bind the telemetry handle the `rlm child usage attributed`
    /// adoption event reports through (the engine wiring installs it
    /// once the session telemetry is assembled; depth-0 sessions only).
    pub fn set_telemetry(&self, telemetry: std::sync::Arc<super::telemetry::SessionTelemetry>) {
        *self.telemetry.lock().expect("rlm usage telemetry lock") = Some(telemetry);
    }

    /// TS `_findLastAssistantMessage` + the `_rlmDurableParentUsage`
    /// snapshot at spawn: the child attributes to the parent's last
    /// assistant row, and that row's usage becomes the aggregate base.
    /// No assistant row (a spawn outside a model turn) leaves the child
    /// unregistered — usage reports for it drop, exactly like TS folds
    /// into `emptyUsage()` without a durable target. A rebuild handed
    /// observation over: the spawn registers on the successor (the same
    /// file's last assistant row — the observation path is the
    /// successor's).
    pub async fn register_spawn(&self, rlm_child_id: &str) {
        // The guard drops at its statement end (a std MutexGuard held
        // across the forwarded await is not Send), and the recursion is
        // boxed: a rebuild chain forwards across successors.
        let forward = self.forward.lock().expect("rlm usage forward lock").clone();
        if let Some(forward) = forward {
            Box::pin(async move { forward.register_spawn(rlm_child_id).await }).await;
            return;
        }
        let target = {
            let session = self.session.lock().await;
            session
                .retained_entries()
                .iter()
                .rev()
                .find_map(last_assistant_row)
        };
        if let Some((target_id, usage)) = target {
            // The base seeds BEFORE the registration publishes: a report
            // that finds the child entry must never compute from the
            // default (the spawn-time usage is the aggregate base), or
            // the broken first aggregate would stick (the later or_insert
            // preserves it).
            let mut bases = self.bases.lock().await;
            bases.entry(target_id.clone()).or_insert(usage);
            drop(bases);
            self.children
                .lock()
                .expect("rlm usage children lock")
                .insert(rlm_child_id.to_string(), target_id);
        }
    }

    /// Flush one observed report: per-origin batches fold into the target
    /// row's cumulative aggregate and append one durable
    /// `child_usage_attributed` row each. A failed append is logged and
    /// dropped — TS swallows the same failure so attribution bookkeeping
    /// never breaks the observing path.
    pub async fn record_child_usage(&self, report: RlmChildUsageReport) {
        // A rebuild handed observation over: an in-flight emission (one
        // that cloned the sink before the swap) forwards here, and the
        // successor carries the batch on its adopted base — otherwise
        // the successor's later aggregates would compute from a base
        // that predates this late batch and the folded row would drop
        // it.
        let forward = self.forward.lock().expect("rlm usage forward lock").clone();
        if let Some(forward) = forward {
            Box::pin(async move { forward.record_child_usage(report).await }).await;
            return;
        }
        // The lookup guard drops at its own statement: a scrutinee temp
        // held across the fallback await is not Send.
        let registered = self
            .children
            .lock()
            .expect("rlm usage children lock")
            .get(&report.rlm_child_id)
            .cloned();
        let target_id = match registered {
            Some(target_id) => target_id,
            None => match self.adopt_from_fallback(&report.rlm_child_id).await {
                Some(target_id) => target_id,
                None => {
                    // A spawn this engine never registered (the
                    // observation raced a session rebuild, or a retained
                    // child outlived its parent engine): no durable
                    // target, nothing to attribute.
                    return;
                }
            },
        };
        // A report that raced the handoff can find its registration
        // copied while the aggregate bases have not been — folding onto
        // the default would break the durable chain. The retired side's
        // base is the true cumulative aggregate; read it BEFORE the
        // bases lock (the lock order there is the fallback's bases
        // first, ours second).
        let fallback_base = self.fallback_base(&target_id).await;
        let mut bases = self.bases.lock().await;
        // The handoff re-check runs WITH the bases lock held: a handoff
        // that armed while this report resolved blocks its bases copy on
        // this lock, so the aggregate this report lands is carried by the
        // adoption — routing the report to the successor now would race
        // the copies instead.
        let forward = self.forward.lock().expect("rlm usage forward lock").clone();
        if let Some(forward) = forward {
            // Release the bases BEFORE forwarding: the successor's
            // fallback_base re-locks THIS producer's bases (tokio Mutex
            // is not reentrant), and holding it across the await would
            // deadlock the handoff path, the adoption, and the child's
            // emit lock. The dropped report forwards whole — its
            // aggregate lands on the successor's side, so nothing that
            // the adoption copy could miss is written here anyway.
            drop(bases);
            Box::pin(async move { forward.record_child_usage(report).await }).await;
            return;
        }
        for (origin, usage) in report.batches {
            let base = bases
                .get(&target_id)
                .copied()
                .or(fallback_base)
                .unwrap_or_default();
            let mut aggregate = base;
            attribute_child_usage(&mut aggregate, &usage);
            match self.session.lock().await.append_child_usage_attribution(
                &target_id,
                usage,
                aggregate,
                Some(origin),
            ) {
                Ok(_) => {
                    bases.insert(target_id.clone(), aggregate);
                    if let Some(telemetry) = self
                        .telemetry
                        .lock()
                        .expect("rlm usage telemetry lock")
                        .as_ref()
                    {
                        telemetry.note_child_usage_attributed(
                            match origin {
                                ChildUsageOrigin::SpawnTask => "spawn_task",
                                ChildUsageOrigin::AgentMessage => "agent_message",
                                ChildUsageOrigin::DirectUser => "direct_user",
                            },
                            usage.input,
                            usage.output,
                            usage.cache_read,
                            usage.cache_write,
                            usage.cost.total.as_f64(),
                        );
                    }
                }
                Err(error) => {
                    eprintln!("pa-core: RLM child usage attribution not persisted: {error}");
                }
            }
        }
    }

    /// A rebuild keeps the session's live children (separate worker
    /// processes; only the engine session rebuilds): their spawns were
    /// registered on the retired engine's producer, so the new producer
    /// adopts the registrations and the aggregate bases before it starts
    /// observing — otherwise the first post-swap report drops against a
    /// producer that never saw the spawn, and the aggregate chain would
    /// restart from the spawn-time base and double-count every row the
    /// retired producer already attributed. The target rows are the same
    /// file rows in the rebuilt session; a replacement onto a MOVED file
    /// drops the adopted registrations at the durable append (the same
    /// recoverable "no durable target" failure every unregistered report
    /// takes).
    pub async fn adopt_registrations(self: &std::sync::Arc<Self>, retired: &std::sync::Arc<Self>) {
        // The handoff goes FIRST: from here on, a spawn or report
        // arriving on the retired producer forwards to the successor
        // (the successor owns the observation path). Anything already in
        // flight on the retired side holds the children/bases locks
        // across its whole flow, so the copies below serialize with it —
        // a late batch or registration is either already in the copied
        // state or lands on the successor through the forward.
        *retired.forward.lock().expect("rlm usage forward lock") =
            Some(std::sync::Arc::clone(self));
        // The successor can also consult the retired side for a
        // registration the copy raced (a spawn that passed the retired
        // forward check mid-handoff): a Weak back-pointer, so the pair
        // never keeps each other alive.
        *self.fallback.lock().expect("rlm usage fallback lock") =
            Some(std::sync::Arc::downgrade(retired));
        {
            let retired_children = retired.children.lock().expect("rlm usage children lock");
            let mut children = self.children.lock().expect("rlm usage children lock");
            for (rlm_child_id, target_id) in retired_children.iter() {
                children
                    .entry(rlm_child_id.clone())
                    .or_insert_with(|| target_id.clone());
            }
        }
        let retired_bases = retired.bases.lock().await;
        let mut bases = self.bases.lock().await;
        for (target_id, base) in retired_bases.iter() {
            bases.entry(target_id.clone()).or_insert_with(|| *base);
        }
    }

    /// A registration the adoption copy raced (a spawn that passed the
    /// retired side's forward check mid-handoff and registered there):
    /// the successor consults the retired producer through its Weak
    /// back-pointer, adopts the target and the target's aggregate base,
    /// and attributes from there — a child spawned across the handoff
    /// never loses its report.
    /// The live ancestor chain, newest first (each adoption links one
    /// Weak back-pointer; a rebuild chain is a line — a cycle cannot form,
    /// and a dropped producer ends the walk: its registrations died with
    /// it). The chain walk is what makes a raced registration reachable
    /// after the SECOND rebuild: the one-hop pointer stops at the middle
    /// producer, the walk continues to the original.
    fn fallback_chain(&self) -> Vec<std::sync::Arc<Self>> {
        let mut chain = Vec::new();
        let mut link = self
            .fallback
            .lock()
            .expect("rlm usage fallback lock")
            .clone();
        while let Some(ref weak) = link {
            let Some(producer) = weak.upgrade() else {
                break;
            };
            link.clone_from(&producer.fallback.lock().expect("rlm usage fallback lock"));
            chain.push(producer);
        }
        chain
    }

    async fn adopt_from_fallback(&self, rlm_child_id: &str) -> Option<String> {
        let chain = self.fallback_chain();
        let mut target: Option<String> = None;
        for producer in &chain {
            let retired_children = producer.children.lock().expect("rlm usage children lock");
            if let Some(found) = retired_children.get(rlm_child_id) {
                target = Some(found.clone());
                break;
            }
        }
        let target_id = target?;
        {
            let mut children = self.children.lock().expect("rlm usage children lock");
            children
                .entry(rlm_child_id.to_string())
                .or_insert_with(|| target_id.clone());
        }
        // The newest ancestor carrying the target's base wins (a deeper
        // hop predates a nearer update).
        for producer in &chain {
            let retired_bases = producer.bases.lock().await;
            if let Some(base) = retired_bases.get(&target_id) {
                let mut bases = self.bases.lock().await;
                bases.entry(target_id.clone()).or_insert(*base);
                break;
            }
        }
        Some(target_id)
    }

    /// The retired side's frozen cumulative base for one target (a
    /// report racing the adoption's bases copy folds onto it instead of
    /// the default — the bases copy's or_insert would keep a broken
    /// first aggregate forever). Read BEFORE our own bases lock: the
    /// lock order is the fallback's bases first, ours second, the same
    /// as [`Self::adopt_from_fallback`].
    async fn fallback_base(&self, target_id: &str) -> Option<Usage> {
        for producer in self.fallback_chain() {
            let retired_bases = producer.bases.lock().await;
            if let Some(base) = retired_bases.get(target_id) {
                return Some(*base);
            }
        }
        None
    }

    /// Drop one child's registration: the child's final observation
    /// landed (it closed or was deleted — its last rows already
    /// emitted). TS keeps the per-child subscription alive only while
    /// the child lives; a session running sequential children must not
    /// accumulate their registrations. The aggregate base stays (TS's
    /// `_rlmDurableParentUsage` entry lives with the assistant row). The
    /// retired side's copy is pruned too — a straggler report must not
    /// resurrect the registration through the fallback consult.
    pub async fn forget_child(&self, rlm_child_id: &str) {
        self.children
            .lock()
            .expect("rlm usage children lock")
            .remove(rlm_child_id);
        let fallback = self
            .fallback
            .lock()
            .expect("rlm usage fallback lock")
            .clone();
        if let Some(fallback) = fallback.and_then(|weak| weak.upgrade()) {
            // A separate lock section on purpose: nothing holds this
            // producer's children map while touching the retired side's
            // (the fallback consult takes them the other way around).
            fallback
                .children
                .lock()
                .expect("rlm usage children lock")
                .remove(rlm_child_id);
        }
    }
}

/// The last assistant row's id and usage when `entry` is one
/// (TS `_findLastAssistantMessage` has no stop-reason filter).
fn last_assistant_row(entry: &pa_types::session::FileEntry) -> Option<(String, Usage)> {
    let pa_types::session::FileEntry::Message {
        message: pa_types::session::AgentMessage::Assistant(assistant),
        base,
    } = entry
    else {
        return None;
    };
    base.id.clone().map(|id| (id, assistant.usage))
}

/// The sink contract the daemon's children registry drives: every child
/// observation boundary (settle, staleness slice, and the capture-before-
/// unlink teardown paths) delivers its per-origin batches through this.
/// Object-safe (stored behind `Arc<dyn ...>`): implementations box their
/// future rather than RPITIT.
pub trait RlmChildUsageSink: Send + Sync {
    fn record(
        &self,
        report: RlmChildUsageReport,
    ) -> std::pin::Pin<std::boxed::Box<dyn std::future::Future<Output = ()> + Send + '_>>;

    /// The child's final observation landed (it closed or was deleted):
    /// drop its registration so sequential children do not accumulate.
    fn forget(
        &self,
        rlm_child_id: &str,
    ) -> std::pin::Pin<std::boxed::Box<dyn std::future::Future<Output = ()> + Send + '_>>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::ai::{AssistantMessage, StopReason, UsageCost};

    /// TS `Usage` block with a single cost total (the captured-fixture
    /// rows carry per-field cost sums).
    fn usage_block(
        input: u64,
        output: u64,
        cache_read: u64,
        cache_write: u64,
        total_tokens: u64,
        cost_total: f64,
    ) -> Usage {
        Usage {
            input,
            output,
            cache_read,
            cache_write,
            total_tokens,
            cost: UsageCost {
                input: pa_types::JsNumber(0.0),
                output: pa_types::JsNumber(0.0),
                cache_read: pa_types::JsNumber(0.0),
                cache_write: pa_types::JsNumber(0.0),
                total: pa_types::JsNumber(cost_total),
            },
        }
    }

    fn assistant_row(usage: Usage) -> pa_types::session::AgentMessage {
        pa_types::session::AgentMessage::Assistant(AssistantMessage {
            content: vec![],
            api: "openai-completions".to_string(),
            provider: "openai".to_string(),
            model: "gpt-5.5".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage,
            stop_reason: StopReason::ToolUse,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: Default::default(),
        })
    }

    /// A file-backed manager holding one assistant row, plus the handle
    /// the producer locks.
    async fn manager_with_assistant(
        usage: Usage,
    ) -> (
        tempfile::TempDir,
        std::sync::Arc<tokio::sync::Mutex<SessionManager>>,
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sessions");
        let mut manager = crate::session::manager::SessionManager::persisted(tmp.path(), &dir);
        manager
            .append_message(assistant_row(usage))
            .expect("assistant row");
        (tmp, std::sync::Arc::new(tokio::sync::Mutex::new(manager)))
    }

    /// The session file's parsed rows.
    async fn file_rows(manager: &tokio::sync::Mutex<SessionManager>) -> Vec<serde_json::Value> {
        let path = manager
            .lock()
            .await
            .get_session_file()
            .expect("session file")
            .to_path_buf();
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    fn child_usage_total(row: &serde_json::Value, key: &str) -> f64 {
        row[key]["cost"]["total"]
            .as_f64()
            .unwrap_or_else(|| row[key]["cost"]["total"].as_i64().expect("cost number") as f64)
    }

    /// The captured TS fixture (assistant row 4f61089a, archive
    /// 01a0a7d4-cdd9, branch-verified by the usage-cost-audit lane):
    /// the raw parent row bills input 2,690 / totalTokens 23,032; the
    /// child's completions add 50,208 input and 2,929 output for
    /// $0.0089957 (50,208×$0.15/M = $0.0075312 plus 2,929×$0.50/M =
    /// $0.0014645); the folded aggregate carries input 52,898, parts
    /// summing to 77,321, and totalTokens FROZEN at the parent's 23,032
    /// (TS `attributeChildUsage`: billable fields grow, the model-facing
    /// context does not). The raw parent's cache/output split inside the
    /// parts total is synthetic; every captured total is asserted.
    #[tokio::test]
    async fn captured_ts_fixture_attributes_with_frozen_total_tokens() {
        // Parts sum 24,184 with totalTokens 23,032; input 2,690 captured.
        let raw_parent = usage_block(2_690, 1_577, 19_917, 0, 23_032, 0.0);
        let child = usage_block(50_208, 2_929, 0, 0, 53_137, 0.008_995_7);
        let (_tmp, manager) = manager_with_assistant(raw_parent).await;
        let producer = RlmChildUsageAttributions::new(manager.clone());
        producer.register_spawn("sub-abc12345").await;
        producer
            .record_child_usage(RlmChildUsageReport {
                rlm_child_id: "sub-abc12345".to_string(),
                batches: vec![(ChildUsageOrigin::SpawnTask, child)],
            })
            .await;

        let rows = file_rows(&manager).await;
        let row = rows
            .iter()
            .find(|row| row["type"] == "child_usage_attributed")
            .expect("durable attribution row");
        assert_eq!(row["origin"], "spawn_task");
        assert_eq!(row["childUsage"]["input"], 50_208);
        assert_eq!(row["childUsage"]["output"], 2_929);
        assert_eq!(row["childUsage"]["totalTokens"], 53_137);
        assert!((child_usage_total(row, "childUsage") - 0.008_995_7).abs() < 1e-9);
        assert_eq!(row["aggregateUsage"]["input"], 52_898);
        assert_eq!(row["aggregateUsage"]["output"], 4_506);
        assert_eq!(row["aggregateUsage"]["cacheRead"], 19_917);
        assert_eq!(row["aggregateUsage"]["cacheWrite"], 0);
        // Frozen at the parent's context size, not the summed parts
        // (77,321 = 52,898 + 4,506 + 19,917).
        assert_eq!(row["aggregateUsage"]["totalTokens"], 23_032);
        assert_eq!(
            row["aggregateUsage"]["input"].as_u64().unwrap()
                + row["aggregateUsage"]["output"].as_u64().unwrap()
                + row["aggregateUsage"]["cacheRead"].as_u64().unwrap()
                + row["aggregateUsage"]["cacheWrite"].as_u64().unwrap(),
            77_321
        );
        assert!((child_usage_total(row, "aggregateUsage") - 0.008_995_7).abs() < 1e-9);

        // The in-memory fold (the manager's live copy of the assistant
        // row) carries the aggregate, and the live totalTokens stays the
        // parent's context value.
        let entries = manager.lock().await.retained_entries().to_vec();
        let folded = entries
            .iter()
            .find_map(last_assistant_row)
            .expect("assistant row");
        assert_eq!(folded.1.input, 52_898);
        assert_eq!(folded.1.total_tokens, 23_032);
    }

    /// The rebuild seam (Macroscope #2671: attribution lost during session
    /// replacement): the session's live children OUTLIVE an engine
    /// rebuild, and the fresh producer must adopt the retired producer's
    /// registrations and aggregate bases — a post-swap report from a
    /// surviving child attributes onto the SAME target row and the
    /// aggregate chain CONTINUES (the base already carries the retired
    /// producer's attributed rows) instead of dropping. A producer
    /// without the adoption drops the same report (the registration is
    /// the gate).
    #[tokio::test]
    async fn rebuild_adoption_continues_the_aggregate_chain() {
        let raw_parent = usage_block(1_000, 0, 0, 0, 4_096, 0.0);
        let (_tmp, manager) = manager_with_assistant(raw_parent).await;
        let retired = std::sync::Arc::new(RlmChildUsageAttributions::new(manager.clone()));
        let fresh = std::sync::Arc::new(RlmChildUsageAttributions::new(manager.clone()));
        retired.register_spawn("sub-rebuild1").await;
        retired
            .record_child_usage(RlmChildUsageReport {
                rlm_child_id: "sub-rebuild1".to_string(),
                batches: vec![(
                    ChildUsageOrigin::SpawnTask,
                    usage_block(10, 5, 0, 0, 15, 0.01),
                )],
            })
            .await;
        // The rebuild swap: the fresh producer takes the sink before the
        // surviving child's next observation delivers.
        fresh.adopt_registrations(&retired).await;
        fresh
            .record_child_usage(RlmChildUsageReport {
                rlm_child_id: "sub-rebuild1".to_string(),
                batches: vec![(
                    ChildUsageOrigin::AgentMessage,
                    usage_block(7, 3, 0, 0, 10, 0.02),
                )],
            })
            .await;
        let rows = file_rows(&manager).await;
        let attributed: Vec<&serde_json::Value> = rows
            .iter()
            .filter(|row| row["type"] == "child_usage_attributed")
            .collect();
        assert_eq!(attributed.len(), 2, "both observations durably attributed");
        // The post-swap row continues the chain: its aggregate carries
        // BOTH batches' input (10 + 7 over the parent's 1,000) and the
        // parent's frozen context tokens.
        assert_eq!(attributed[1]["origin"], "agent_message");
        assert_eq!(attributed[1]["aggregateUsage"]["input"], 1_017);
        assert_eq!(attributed[1]["aggregateUsage"]["totalTokens"], 4_096);
        // The retired producer now FORWARDS (the rebuild handoff): an
        // in-flight emission that cloned the retired sink still lands on
        // the adopted chain — the late batch's aggregate continues the
        // base (1,017 + 1 over the parent's 1,000).
        retired
            .record_child_usage(RlmChildUsageReport {
                rlm_child_id: "sub-rebuild1".to_string(),
                batches: vec![(
                    ChildUsageOrigin::DirectUser,
                    usage_block(1, 1, 0, 0, 2, 0.0),
                )],
            })
            .await;
        let rows_late = file_rows(&manager).await;
        let attributed_late: Vec<&serde_json::Value> = rows_late
            .iter()
            .filter(|row| row["type"] == "child_usage_attributed")
            .collect();
        assert_eq!(attributed_late.len(), 3, "the forwarded report attributed");
        assert_eq!(attributed_late[2]["aggregateUsage"]["input"], 1_018);
        // The final observation landed: forget_child drops the
        // registration (a sequential child's successor never accumulates
        // its predecessor's entries).
        fresh.forget_child("sub-rebuild1").await;
        fresh
            .record_child_usage(RlmChildUsageReport {
                rlm_child_id: "sub-rebuild1".to_string(),
                batches: vec![(
                    ChildUsageOrigin::DirectUser,
                    usage_block(4, 4, 0, 0, 8, 0.0),
                )],
            })
            .await;
        let rows_after = file_rows(&manager).await;
        assert_eq!(
            rows_after
                .iter()
                .filter(|row| row["type"] == "child_usage_attributed")
                .count(),
            3,
            "the forgotten child's report drops"
        );
        // A spawn racing the handoff on the retired side FORWARDS: the
        // registration lands on the successor (the observation path is
        // the successor's), and the successor's report attributes.
        retired.register_spawn("sub-rebuild2").await;
        assert!(
            fresh
                .children
                .lock()
                .expect("children lock")
                .contains_key("sub-rebuild2"),
            "the handoff-forwarded spawn registered on the successor"
        );
        fresh
            .record_child_usage(RlmChildUsageReport {
                rlm_child_id: "sub-rebuild2".to_string(),
                batches: vec![(ChildUsageOrigin::SpawnTask, usage_block(2, 2, 0, 0, 4, 0.0))],
            })
            .await;
        // A report racing the adoption's bases copy (the registration is
        // copied but the base is not — simulated by dropping the copied
        // base): the fold must NOT start from the default — the retired
        // side's FROZEN handoff base is the true cumulative aggregate,
        // so the durable chain continues (the frozen 1,010 + 5).
        let target_of_second_for_base = fresh
            .children
            .lock()
            .expect("children lock")
            .get("sub-rebuild2")
            .cloned()
            .expect("sub-rebuild2 registered on the successor");
        fresh.bases.lock().await.remove(&target_of_second_for_base);
        fresh
            .record_child_usage(RlmChildUsageReport {
                rlm_child_id: "sub-rebuild2".to_string(),
                batches: vec![(
                    ChildUsageOrigin::AgentMessage,
                    usage_block(5, 5, 0, 0, 10, 0.0),
                )],
            })
            .await;
        let rows_base_race = file_rows(&manager).await;
        let base_race: Vec<&serde_json::Value> = rows_base_race
            .iter()
            .filter(|row| row["type"] == "child_usage_attributed")
            .collect();
        assert_eq!(
            base_race.last().unwrap()["aggregateUsage"]["input"],
            1_015,
            "the raced report folds onto the frozen retired base, not the default"
        );
        // A registration the adoption copy raced (a spawn that passed the
        // retired side's forward check mid-handoff — simulated by
        // inserting on the retired side directly): the successor's
        // fallback consult adopts the target and the report still
        // attributes.
        let target_of_second = fresh
            .children
            .lock()
            .expect("children lock")
            .get("sub-rebuild2")
            .cloned()
            .expect("sub-rebuild2 registered on the successor");
        {
            let mut retired_children = retired.children.lock().expect("children lock");
            retired_children.insert("sub-raced".to_string(), target_of_second);
        }
        fresh
            .record_child_usage(RlmChildUsageReport {
                rlm_child_id: "sub-raced".to_string(),
                batches: vec![(ChildUsageOrigin::SpawnTask, usage_block(3, 3, 0, 0, 6, 0.0))],
            })
            .await;
        let rows_raced = file_rows(&manager).await;
        let raced: Vec<&serde_json::Value> = rows_raced
            .iter()
            .filter(|row| row["type"] == "child_usage_attributed")
            .collect();
        assert_eq!(
            raced.len(),
            6,
            "the forwarded spawn, the base race, and the raced registration all attribute"
        );
        // The raced registration continues the SAME cumulative chain (the
        // fallback adopted the target's base): the raced 1,015 + 3 input.
        assert_eq!(raced[5]["aggregateUsage"]["input"], 1_018);
    }

    /// Multiple children of one assistant row share the cumulative base
    /// (TS `_rlmDurableParentUsage`), one durable row per origin batch in
    /// first-seen order, and every aggregate keeps the frozen
    /// totalTokens.
    #[tokio::test]
    async fn multiple_children_and_origins_share_the_cumulative_base() {
        let raw_parent = usage_block(1_000, 100, 0, 0, 1_100, 0.01);
        let (_tmp, manager) = manager_with_assistant(raw_parent).await;
        let producer = RlmChildUsageAttributions::new(manager.clone());
        producer.register_spawn("sub-one").await;
        producer.register_spawn("sub-two").await;
        producer
            .record_child_usage(RlmChildUsageReport {
                rlm_child_id: "sub-one".to_string(),
                batches: vec![(
                    ChildUsageOrigin::SpawnTask,
                    usage_block(10, 5, 0, 0, 15, 0.001),
                )],
            })
            .await;
        producer
            .record_child_usage(RlmChildUsageReport {
                rlm_child_id: "sub-two".to_string(),
                batches: vec![
                    (
                        ChildUsageOrigin::AgentMessage,
                        usage_block(20, 8, 0, 0, 28, 0.002),
                    ),
                    (
                        ChildUsageOrigin::DirectUser,
                        usage_block(30, 9, 0, 0, 39, 0.003),
                    ),
                ],
            })
            .await;

        let rows = file_rows(&manager).await;
        let attributions: Vec<&serde_json::Value> = rows
            .iter()
            .filter(|row| row["type"] == "child_usage_attributed")
            .collect();
        let origins: Vec<&str> = attributions
            .iter()
            .map(|row| row["origin"].as_str().unwrap())
            .collect();
        assert_eq!(origins, ["spawn_task", "agent_message", "direct_user"]);
        // Cumulative aggregates: base + batch so far, in flush order.
        assert_eq!(attributions[0]["aggregateUsage"]["input"], 1_010);
        assert_eq!(attributions[1]["aggregateUsage"]["input"], 1_030);
        assert_eq!(attributions[2]["aggregateUsage"]["input"], 1_060);
        assert_eq!(attributions[0]["aggregateUsage"]["totalTokens"], 1_100);
        assert_eq!(attributions[1]["aggregateUsage"]["totalTokens"], 1_100);
        assert_eq!(attributions[2]["aggregateUsage"]["totalTokens"], 1_100);
    }

    /// A report for a child this engine never registered attributes
    /// nothing (TS folds into `emptyUsage()` without a durable target —
    /// no parent row, no row on disk).
    #[tokio::test]
    async fn unregistered_child_report_attributes_nothing() {
        let (_tmp, manager) = manager_with_assistant(usage_block(1, 1, 0, 0, 2, 0.0)).await;
        let producer = RlmChildUsageAttributions::new(manager.clone());
        producer
            .record_child_usage(RlmChildUsageReport {
                rlm_child_id: "sub-unknown".to_string(),
                batches: vec![(
                    ChildUsageOrigin::SpawnTask,
                    usage_block(10, 5, 0, 0, 15, 0.0),
                )],
            })
            .await;
        let rows = file_rows(&manager).await;
        assert!(rows
            .iter()
            .all(|row| row["type"] != "child_usage_attributed"));
    }
}
