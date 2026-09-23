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
    total.input += usage.input;
    total.output += usage.output;
    total.cache_read += usage.cache_read;
    total.cache_write += usage.cache_write;
    total.total_tokens += usage.total_tokens;
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
    /// attributes to, captured at spawn.
    children: std::sync::Mutex<HashMap<String, String>>,
    /// The `rlm child usage attributed` adoption event's handle (`None`
    /// in sessions without telemetry — subagents never double-report).
    telemetry: std::sync::Mutex<Option<std::sync::Arc<super::telemetry::SessionTelemetry>>>,
}

impl RlmChildUsageAttributions {
    pub fn new(session: std::sync::Arc<tokio::sync::Mutex<SessionManager>>) -> Self {
        Self {
            session,
            bases: tokio::sync::Mutex::new(HashMap::new()),
            children: std::sync::Mutex::new(HashMap::new()),
            telemetry: std::sync::Mutex::new(None),
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
    /// into `emptyUsage()` without a durable target.
    pub async fn register_spawn(&self, rlm_child_id: &str) {
        let target = {
            let session = self.session.lock().await;
            session
                .retained_entries()
                .iter()
                .rev()
                .find_map(last_assistant_row)
        };
        if let Some((target_id, usage)) = target {
            self.children
                .lock()
                .expect("rlm usage children lock")
                .insert(rlm_child_id.to_string(), target_id.clone());
            let mut bases = self.bases.lock().await;
            bases.entry(target_id).or_insert(usage);
        }
    }

    /// Flush one observed report: per-origin batches fold into the target
    /// row's cumulative aggregate and append one durable
    /// `child_usage_attributed` row each. A failed append is logged and
    /// dropped — TS swallows the same failure so attribution bookkeeping
    /// never breaks the observing path.
    pub async fn record_child_usage(&self, report: RlmChildUsageReport) {
        let Some(target_id) = self
            .children
            .lock()
            .expect("rlm usage children lock")
            .get(&report.rlm_child_id)
            .cloned()
        else {
            // A spawn this engine never registered (the observation raced
            // a session rebuild, or a retained child outlived its parent
            // engine): no durable target, nothing to attribute.
            return;
        };
        let mut bases = self.bases.lock().await;
        for (origin, usage) in report.batches {
            let base = bases.get(&target_id).copied().unwrap_or_default();
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
    pub async fn adopt_registrations(&self, retired: &Self) {
        {
            let retired_children = retired.children.lock().expect("rlm usage children lock");
            let mut children = self.children.lock().expect("rlm usage children lock");
            for (rlm_child_id, target_id) in retired_children.iter() {
                children
                    .entry(rlm_child_id.clone())
                    .or_insert_with(|| target_id.clone());
            }
        }
        let mut retired_bases = retired.bases.lock().await;
        let mut bases = self.bases.lock().await;
        for (target_id, base) in retired_bases.iter() {
            bases.entry(target_id.clone()).or_insert_with(|| *base);
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
        let child = usage_block(50_208, 2_929, 0, 0, 53_137, 0.0089957);
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
        assert!((child_usage_total(row, "childUsage") - 0.0089957).abs() < 1e-9);
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
        assert!((child_usage_total(row, "aggregateUsage") - 0.0089957).abs() < 1e-9);

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
        let retired = RlmChildUsageAttributions::new(manager.clone());
        let fresh = RlmChildUsageAttributions::new(manager.clone());
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
        // The un-adopted producer drops the same child's report.
        let orphan = RlmChildUsageAttributions::new(manager.clone());
        orphan
            .record_child_usage(RlmChildUsageReport {
                rlm_child_id: "sub-rebuild1".to_string(),
                batches: vec![(
                    ChildUsageOrigin::DirectUser,
                    usage_block(1, 1, 0, 0, 2, 0.0),
                )],
            })
            .await;
        let rows_after = file_rows(&manager).await;
        assert_eq!(
            rows_after
                .iter()
                .filter(|row| row["type"] == "child_usage_attributed")
                .count(),
            2,
            "the un-adopted producer drops the report"
        );
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
