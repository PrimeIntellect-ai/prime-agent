//! RLM child-usage attribution: the producer that folds a recursive
//! child's billable usage into the parent assistant row that spawned it
//! (TS `attributeChildUsage`). Divergence: Rust children are separate
//! worker processes, so the daemon's children registry delivers batches.

use std::collections::HashMap;

use pa_types::ai::Usage;
use pa_types::session::ChildUsageOrigin;

use crate::session::manager::SessionManager;

pub fn add_assistant_usage(total: &mut Usage, usage: &Usage) {
    // Saturating: a wrapping usage sum would underbill.
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

/// Child work affects session-level billable totals, not the parent's
/// model-facing context size, so the context tokens are restored after the fold.
pub(crate) fn attribute_child_usage(parent_usage: &mut Usage, child_usage: &Usage) {
    let parent_context_tokens = super::compaction::calculate_context_tokens(parent_usage);
    add_assistant_usage(parent_usage, child_usage);
    parent_usage.total_tokens = parent_context_tokens;
}

/// Per-origin batches in first-seen order.
#[derive(Debug, Clone)]
pub struct RlmChildUsageReport {
    pub rlm_child_id: String,
    pub batches: Vec<(ChildUsageOrigin, Usage)>,
}

/// The producer the daemon's child observation feeds: spawn registration
/// plus the durable flush. One instance per session engine.
pub struct RlmChildUsageAttributions {
    session: std::sync::Arc<tokio::sync::Mutex<SessionManager>>,
    /// The aggregate base per parent assistant row, shared by all its children;
    /// held across the durable append so batches serialize in observation order.
    bases: tokio::sync::Mutex<HashMap<String, Usage>>,
    /// The parent assistant row each child attributes to, captured at spawn;
    /// dropped in [`Self::forget_child`].
    children: std::sync::Mutex<HashMap<String, String>>,
    /// The `rlm_child_*` session counters' handle (`None` in sessions
    /// without telemetry — subagents never double-report).
    telemetry: std::sync::Mutex<Option<std::sync::Arc<super::telemetry::SessionTelemetry>>>,
    /// The successor a rebuild handed observation to; a post-rebuild
    /// chain never silently drops a late batch.
    forward: std::sync::Mutex<Option<std::sync::Arc<RlmChildUsageAttributions>>>,
    /// Weak back-pointer to the replaced producer, consulted for a
    /// registration the adoption copy raced.
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

    /// Bind the telemetry handle the `rlm_child_*` session counters count
    /// through (the engine wiring installs it
    /// once the session telemetry is assembled; depth-0 sessions only).
    ///
    /// # Panics
    ///
    /// Panics if the telemetry state mutex is poisoned.
    pub fn set_telemetry(&self, telemetry: std::sync::Arc<super::telemetry::SessionTelemetry>) {
        *self.telemetry.lock().expect("rlm usage telemetry lock") = Some(telemetry);
    }

    /// The child attributes to the parent's last assistant row; that row's usage becomes the
    /// aggregate base. No assistant row leaves the child unregistered, its reports drop.
    ///
    /// # Panics
    ///
    /// Panics if the forward or children state mutexes are poisoned.
    pub async fn register_spawn(&self, rlm_child_id: &str) {
        // The guard drops at its statement end (held across the forwarded await it is not
        // Send); the recursion is boxed so a rebuild chain forwards across successors.
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
            // Seed the base BEFORE the registration publishes: a report finding the entry
            // must not compute from the default (or_insert preserves a broken first aggregate).
            let mut bases = self.bases.lock().await;
            bases.entry(target_id.clone()).or_insert(usage);
            drop(bases);
            self.children
                .lock()
                .expect("rlm usage children lock")
                .insert(rlm_child_id.to_string(), target_id);
        }
    }

    /// Flush one observed report: batches fold into the target row's cumulative aggregate,
    /// one durable `child_usage_attributed` row per batch; a failed append is logged and
    /// dropped, so attribution bookkeeping never breaks the observing path.
    ///
    /// # Panics
    ///
    /// Panics if the forward, children, or telemetry state mutexes are poisoned.
    pub async fn record_child_usage(&self, report: RlmChildUsageReport) {
        let forward = self.forward.lock().expect("rlm usage forward lock").clone();
        if let Some(forward) = forward {
            Box::pin(async move { forward.record_child_usage(report).await }).await;
            return;
        }
        // The guard drops at its own statement: a scrutinee temp held
        // across the fallback await is not Send.
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
                    // Never registered here (raced a rebuild, or the
                    // child outlived its engine): no durable target.
                    return;
                }
            },
        };
        // A report racing the handoff can find the registration copied before the bases:
        // read the retired side's base BEFORE our bases lock.
        let fallback_base = self.fallback_base(&target_id).await;
        let mut bases = self.bases.lock().await;
        // The forward re-check runs WITH the bases lock held: a handoff that armed
        // mid-report blocks its bases copy on this lock, so the adoption carries it.
        let forward = self.forward.lock().expect("rlm usage forward lock").clone();
        if let Some(forward) = forward {
            // Release the bases BEFORE forwarding: the successor's fallback_base re-locks
            // THIS producer's bases (a tokio Mutex is not reentrant); holding it across
            // the await would deadlock the handoff path and the adoption.
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

    /// A rebuild keeps the session's live children: adopt the retired
    /// registrations and bases before observing, or a post-swap report drops
    /// or the chain restarts from the spawn-time base and double-counts.
    ///
    /// # Panics
    ///
    /// Panics if the forward, fallback, or children state mutexes are poisoned.
    pub async fn adopt_registrations(self: &std::sync::Arc<Self>, retired: &std::sync::Arc<Self>) {
        // The handoff goes FIRST: in-flight work on the retired side holds its locks
        // across its flow, so the copies below serialize with it; late arrivals land
        // on the successor through the forward.
        *retired.forward.lock().expect("rlm usage forward lock") =
            Some(std::sync::Arc::clone(self));
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

    /// The live ancestor chain, newest first; a cycle cannot form and a dropped producer
    /// ends the walk. The walk reaches a raced registration after the SECOND rebuild,
    /// where the one-hop back-pointer stops at the middle producer.
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
        // The newest ancestor carrying the base wins (a deeper hop
        // predates a nearer update).
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

    /// The retired side's frozen cumulative base: read BEFORE our own
    /// bases lock (lock order: the fallback's bases first, ours second).
    async fn fallback_base(&self, target_id: &str) -> Option<Usage> {
        for producer in self.fallback_chain() {
            let retired_bases = producer.bases.lock().await;
            if let Some(base) = retired_bases.get(target_id) {
                return Some(*base);
            }
        }
        None
    }

    /// Drop one child's registration once its final observation lands; the
    /// aggregate base stays. The retired side's copy is pruned too, so a
    /// straggler cannot resurrect it through the fallback.
    ///
    /// # Panics
    ///
    /// Panics if the children or fallback state mutexes are poisoned.
    pub fn forget_child(&self, rlm_child_id: &str) -> impl std::future::Future<Output = ()> {
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
            // A separate lock section on purpose: the fallback consult
            // takes the maps the other way around.
            fallback
                .children
                .lock()
                .expect("rlm usage children lock")
                .remove(rlm_child_id);
        }
        std::future::ready(())
    }
}

/// Any assistant row counts — no stop-reason filter (TS `_findLastAssistantMessage`).
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

/// The sink contract the daemon's children registry drives. Object-safe
/// (stored behind `Arc<dyn ...>`), so implementations box their futures.
pub trait RlmChildUsageSink: Send + Sync {
    fn record(
        &self,
        report: RlmChildUsageReport,
    ) -> std::pin::Pin<std::boxed::Box<dyn std::future::Future<Output = ()> + Send + '_>>;

    /// Drop the registration so sequential children do not accumulate.
    fn forget(
        &self,
        rlm_child_id: &str,
    ) -> std::pin::Pin<std::boxed::Box<dyn std::future::Future<Output = ()> + Send + '_>>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::ai::{AssistantMessage, StopReason, UsageCost};

    /// `Usage` block with a single cost total.
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
            rest: serde_json::Map::default(),
        })
    }

    fn manager_with_assistant(
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

    /// Captured TS fixture (assistant row 4f61089a, archive 01a0a7d4-cdd9):
    /// the folded aggregate carries input 52,898, parts summing to 77,321,
    /// and totalTokens FROZEN at the parent's 23,032; the raw parent's
    /// cache/output split is synthetic.
    #[tokio::test]
    async fn captured_ts_fixture_attributes_with_frozen_total_tokens() {
        let raw_parent = usage_block(2_690, 1_577, 19_917, 0, 23_032, 0.0);
        let child = usage_block(50_208, 2_929, 0, 0, 53_137, 0.008_995_7);
        let (_tmp, manager) = manager_with_assistant(raw_parent);
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
        // Frozen at the parent's context size, not the summed parts.
        assert_eq!(row["aggregateUsage"]["totalTokens"], 23_032);
        assert_eq!(
            row["aggregateUsage"]["input"].as_u64().unwrap()
                + row["aggregateUsage"]["output"].as_u64().unwrap()
                + row["aggregateUsage"]["cacheRead"].as_u64().unwrap()
                + row["aggregateUsage"]["cacheWrite"].as_u64().unwrap(),
            77_321
        );
        assert!((child_usage_total(row, "aggregateUsage") - 0.008_995_7).abs() < 1e-9);

        let entries = manager.lock().await.retained_entries().to_vec();
        let folded = entries
            .iter()
            .find_map(last_assistant_row)
            .expect("assistant row");
        assert_eq!(folded.1.input, 52_898);
        assert_eq!(folded.1.total_tokens, 23_032);
    }

    /// The rebuild seam (Macroscope #2671): the fresh producer must adopt
    /// the retired registrations and bases, so a post-swap report continues
    /// the chain instead of dropping.
    #[tokio::test]
    async fn rebuild_adoption_continues_the_aggregate_chain() {
        let raw_parent = usage_block(1_000, 0, 0, 0, 4_096, 0.0);
        let (_tmp, manager) = manager_with_assistant(raw_parent);
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
        assert_eq!(attributed[1]["origin"], "agent_message");
        assert_eq!(attributed[1]["aggregateUsage"]["input"], 1_017);
        assert_eq!(attributed[1]["aggregateUsage"]["totalTokens"], 4_096);
        // The retired producer now FORWARDS: a late emission still lands on the adopted chain.
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
        // A spawn racing the handoff on the retired side FORWARDS to the successor.
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
        // A report racing the adoption's bases copy (base dropped to simulate):
        // the fold starts from the retired side's frozen handoff base.
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
        // A registration the adoption copy raced (inserted on the
        // retired side directly): the fallback consult adopts it.
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
        // Continues the same cumulative chain: the raced 1,015 + 3 input.
        assert_eq!(raced[5]["aggregateUsage"]["input"], 1_018);
    }

    #[tokio::test]
    async fn multiple_children_and_origins_share_the_cumulative_base() {
        let raw_parent = usage_block(1_000, 100, 0, 0, 1_100, 0.01);
        let (_tmp, manager) = manager_with_assistant(raw_parent);
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
        assert_eq!(attributions[0]["aggregateUsage"]["input"], 1_010);
        assert_eq!(attributions[1]["aggregateUsage"]["input"], 1_030);
        assert_eq!(attributions[2]["aggregateUsage"]["input"], 1_060);
        assert_eq!(attributions[0]["aggregateUsage"]["totalTokens"], 1_100);
        assert_eq!(attributions[1]["aggregateUsage"]["totalTokens"], 1_100);
        assert_eq!(attributions[2]["aggregateUsage"]["totalTokens"], 1_100);
    }

    #[tokio::test]
    async fn unregistered_child_report_attributes_nothing() {
        let (_tmp, manager) = manager_with_assistant(usage_block(1, 1, 0, 0, 2, 0.0));
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
