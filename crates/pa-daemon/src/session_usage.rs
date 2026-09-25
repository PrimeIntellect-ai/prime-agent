//! Whole-file own-usage scan: the single source of truth for a session's
//! own token/cost summary.
//!
//! Port of the TS session-listing fold (`foldSessionScanLine`'s usage arms +
//! `snapshotSessionInfo`, `core/session-manager.ts`): assistant usage
//! keyed by entry id, a `child_usage_attributed` entry replacing the raw
//! block with its latest aggregate while every child block accumulates,
//! summarization (`compaction` / `branch_summary`) usage added, and all
//! attributed child usage subtracted. The child's own row carries the
//! child spend, so recursive rollups never double count. TS's live
//! `getOwnUsageSummary` documents the same contract: "Whole-file own
//! spend, identical to the catalog scan so rows never shift at
//! passivation" (`agent-session.ts`).
//!
//! Consumers: the saved-session listing scan (`session_store` feeds one
//! [`UsageScan`] while parsing each line) and the worker's live own-usage
//! summary ([`read_own_usage_summary`]). The live side layers only what
//! never reaches the file — child spend attributed in memory ahead of the
//! durable entry, and memoization — on top of this fold.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use pa_types::ai::{Usage, UsageCost};
use pa_types::JsNumber;
use serde::{Deserialize, Serialize};

use pa_core::session_engine::compaction_exec::{add_assistant_usage, subtract_assistant_usage};

/// TS `SessionUsageSummary` (`sessionUsageSummaryFrom`): the token/cost
/// summary rows publish. `inputTokens` folds cache reads and writes into
/// the input total; `cost` is the provider-billed total.
///
/// `Eq` is manual: `cost` is the f64 under `JsNumber`, and JSON numbers are
/// always finite (a NaN never round-trips `serde_json`), so equality is
/// total.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageSummary {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost: f64,
}

impl Eq for SessionUsageSummary {}

/// TS `sessionUsageSummaryFrom`: `None` — an absent wire field — when the
/// session recorded no billable work at all.
pub fn session_usage_summary_from(usage: &Usage) -> Option<SessionUsageSummary> {
    let input_tokens = usage
        .input
        .saturating_add(usage.cache_read)
        .saturating_add(usage.cache_write);
    if input_tokens == 0 && usage.output == 0 && usage.cost.total.as_f64() == 0.0 {
        return None;
    }
    Some(SessionUsageSummary {
        input_tokens,
        output_tokens: usage.output,
        cost: usage.cost.total.as_f64(),
    })
}

/// The per-assistant usage map. TS uses a `Map`: a later write replaces in
/// place and iteration keeps first-insertion order — the final summary
/// sums the cost floats in exactly the order TS does. The id index keeps
/// `set`/`contains` constant-time over that insertion order (a plain
/// `HashMap` would reorder the sums; a bare vec scan is the O(n²) fold
/// long sessions would stall on).
#[derive(Default, Clone)]
struct AssistantUsageById {
    entries: Vec<(String, Usage)>,
    index: std::collections::HashMap<String, usize>,
}

impl AssistantUsageById {
    fn contains(&self, id: &str) -> bool {
        self.index.contains_key(id)
    }

    /// The retained-entry count: TS `state.acc.assistantUsageById.size`.
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    fn set(&mut self, id: &str, usage: Usage) {
        if let Some(at) = self.index.get(id) {
            self.entries[*at].1 = usage;
        } else {
            self.index.insert(id.to_string(), self.entries.len());
            self.entries.push((id.to_string(), usage));
        }
    }
}

/// The scan-side wire shape of a usage block. Persisted files carry
/// partial objects (`{input, output, totalTokens}` without
/// `cacheRead`/`cacheWrite`/`cost`), and TS `JSON.parse` never rejects
/// one — the fold keeps the row and every field it does not find
/// defaults to zero, instead of dropping the message (its count, model,
/// and search text) with the block.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanUsage {
    #[serde(default)]
    input: u64,
    #[serde(default)]
    output: u64,
    #[serde(default)]
    cache_read: u64,
    #[serde(default)]
    cache_write: u64,
    #[serde(default)]
    total_tokens: u64,
    #[serde(default)]
    cost: ScanUsageCost,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanUsageCost {
    #[serde(default)]
    input: JsNumber,
    #[serde(default)]
    output: JsNumber,
    #[serde(default)]
    cache_read: JsNumber,
    #[serde(default)]
    cache_write: JsNumber,
    #[serde(default)]
    total: JsNumber,
}

impl From<ScanUsage> for Usage {
    fn from(scan: ScanUsage) -> Usage {
        Usage {
            input: scan.input,
            output: scan.output,
            cache_read: scan.cache_read,
            cache_write: scan.cache_write,
            total_tokens: scan.total_tokens,
            cost: UsageCost {
                input: scan.cost.input,
                output: scan.cost.output,
                cache_read: scan.cost.cache_read,
                cache_write: scan.cost.cache_write,
                total: scan.cost.total,
            },
        }
    }
}

/// The fold's two billable totals (TS PR #2506's `usageTotal`
/// projection): `own` subtracts every attributed child block (the child's
/// own row carries it), `total` keeps the child spend (the session-tree
/// spend including settled children).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionUsageTotals {
    pub own: Usage,
    pub total: Usage,
}

/// The streaming whole-file own-usage accumulator: feed one entry at a
/// time in file order, then read [`summary`](Self::summary). Line order is
/// the fold's authority — an attribution folds only when its target is
/// already in the map (the assistant entry precedes its children's settle
/// in the file).
#[derive(Default, Clone)]
pub struct UsageScan {
    assistant_usage_by_id: AssistantUsageById,
    attributed_child_usage: Usage,
    summarization_usage: Usage,
}

impl UsageScan {
    /// TS `storeSessionScanState`'s retained-usage accounting: the number of
    /// per-assistant-message records the scan state keeps resident.
    pub(crate) fn retained_entries(&self) -> usize {
        self.assistant_usage_by_id.len()
    }

    /// TS `foldSessionScanLine`: the raw assistant usage keyed by entry id.
    /// Only an assistant row with a usage block lands in the map.
    pub(crate) fn fold_message(&mut self, id: &str, role: Option<&str>, usage: Option<Usage>) {
        if role != Some("assistant") {
            return;
        }
        if let Some(usage) = usage {
            self.assistant_usage_by_id.set(id, usage);
        }
    }

    /// TS `foldSessionScanLine`: a `child_usage_attributed` entry folds
    /// only when its target is already in the map — the latest aggregate
    /// replaces the raw block while every child block accumulates. A
    /// malformed attribution (missing aggregate or child block)
    /// contributes nothing; well-formed files always carry both.
    pub(crate) fn fold_child_attribution(
        &mut self,
        target_id: Option<&str>,
        child_usage: Option<Usage>,
        aggregate_usage: Option<Usage>,
    ) {
        let (Some(target_id), Some(child_usage), Some(aggregate_usage)) =
            (target_id, child_usage, aggregate_usage)
        else {
            return;
        };
        if self.assistant_usage_by_id.contains(target_id) {
            self.assistant_usage_by_id.set(target_id, aggregate_usage);
            add_assistant_usage(&mut self.attributed_child_usage, &child_usage);
        }
    }

    /// TS `foldSessionScanLine`: a `compaction` or `branch_summary`
    /// entry's own usage (the summarization call's billed block).
    pub(crate) fn fold_summarization(&mut self, usage: Option<Usage>) {
        if let Some(usage) = usage {
            add_assistant_usage(&mut self.summarization_usage, &usage);
        }
    }

    /// The totals behind [`summary`](Self::summary): `own` subtracts the
    /// attributed child spend, `total` keeps it (the deletion capture reads
    /// both from the child's frozen file).
    pub fn totals(&self) -> SessionUsageTotals {
        let mut total = Usage::default();
        for (_, usage) in &self.assistant_usage_by_id.entries {
            add_assistant_usage(&mut total, usage);
        }
        add_assistant_usage(&mut total, &self.summarization_usage);
        let mut own = total;
        subtract_assistant_usage(&mut own, &self.attributed_child_usage);
        SessionUsageTotals { own, total }
    }

    /// TS `snapshotSessionInfo`'s total: the assistant aggregates plus the
    /// summarization calls, minus every attributed child block (clamped
    /// at zero to absorb attribution drift).
    pub fn summary(&self) -> Option<SessionUsageSummary> {
        session_usage_summary_from(&self.totals().own)
    }
}

/// The standalone scanner's minimal entry parse: only the usage fold's
/// fields, so unknown (and large) content is skipped by serde.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanEntry {
    #[serde(rename = "type")]
    type_: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    message: Option<ScanMessage>,
    #[serde(default)]
    usage: Option<ScanUsage>,
    #[serde(default)]
    target_id: Option<String>,
    #[serde(default)]
    child_usage: Option<ScanUsage>,
    #[serde(default)]
    aggregate_usage: Option<ScanUsage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanMessage {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    usage: Option<ScanUsage>,
}

impl ScanEntry {
    /// The standalone scanner's dispatch: fold this parsed entry into a
    /// scan (the same fold the listing scan drives).
    fn fold_into(&self, scan: &mut UsageScan) {
        match self.type_.as_str() {
            "message" => {
                let (role, usage) = self.message.as_ref().map_or((None, None), |message| {
                    (message.role.as_deref(), message.usage.map(Usage::from))
                });
                scan.fold_message(&self.id, role, usage);
            }
            "child_usage_attributed" => scan.fold_child_attribution(
                self.target_id.as_deref(),
                self.child_usage.map(Usage::from),
                self.aggregate_usage.map(Usage::from),
            ),
            "compaction" | "branch_summary" => {
                scan.fold_summarization(self.usage.map(Usage::from));
            }
            _ => {}
        }
    }
}

/// Whole-file scan over every parsable line: invalid lines contribute
/// nothing, exactly like the listing scan.
fn scan_file(path: &Path) -> Option<UsageScan> {
    let file = fs::File::open(path).ok()?;
    let mut scan = UsageScan::default();
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<ScanEntry>(trimmed) else {
            continue;
        };
        entry.fold_into(&mut scan);
    }
    Some(scan)
}

/// Whole-file own usage (the saved-row summary): the worker's live
/// own-usage summary reads this, so live rows and saved rows never
/// disagree.
pub fn read_own_usage_summary(path: &Path) -> Option<SessionUsageSummary> {
    scan_file(path).and_then(|scan| scan.summary())
}

/// Whole-file own + total usage (the deletion capture reads both from the
/// child's frozen file: `own` for the child's own row, `total` for the
/// spend the parent's attribution carries).
pub fn read_session_usage(path: &Path) -> Option<SessionUsageTotals> {
    scan_file(path).map(|scan| scan.totals())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn usage(input: u64, output: u64, total: f64) -> Usage {
        serde_json::from_value(json!({
            "input": input, "output": output, "cacheRead": 0, "cacheWrite": 0,
            "totalTokens": input + output,
            "cost": { "input": 0.0, "output": total, "cacheRead": 0.0, "cacheWrite": 0.0, "total": total }
        }))
        .unwrap()
    }

    fn scan_summary(lines: &[Value]) -> Option<SessionUsageSummary> {
        let mut scan = UsageScan::default();
        for line in lines {
            let entry: ScanEntry = serde_json::from_value(line.clone()).unwrap();
            entry.fold_into(&mut scan);
        }
        scan.summary()
    }

    fn message(id: &str, role: &str, usage: Value) -> Value {
        json!({ "type": "message", "id": id, "message": { "role": role, "usage": usage } })
    }

    fn attribution(target: &str, child: Usage, aggregate: Usage) -> Value {
        json!({
            "type": "child_usage_attributed", "targetId": target,
            "childUsage": child, "aggregateUsage": aggregate
        })
    }

    /// TS `snapshotSessionInfo` on a parent whose child settled twice: the
    /// latest aggregate replaces the raw block, every child block
    /// accumulates, and the summary subtracts the child spend (the child's
    /// own row carries it — no rollup double count).
    #[test]
    fn latest_aggregate_replaces_raw_and_child_usage_accumulates() {
        let summary = scan_summary(&[
            message(
                "a",
                "assistant",
                json!({
                    "input": 100, "output": 10, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 110,
                    "cost": { "input": 0.0, "output": 1.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 1.0 }
                }),
            ),
            attribution("a", usage(20, 2, 0.2), usage(120, 12, 1.2)),
            attribution("a", usage(30, 3, 0.3), usage(150, 15, 1.5)),
            message(
                "b",
                "assistant",
                json!({
                    "input": 50, "output": 5, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 55,
                    "cost": { "input": 0.0, "output": 0.5, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.5 }
                }),
            ),
        ]);
        assert_eq!(
            summary,
            Some(SessionUsageSummary {
                input_tokens: 150,
                output_tokens: 15,
                cost: 1.5
            })
        );
    }

    /// TS folds an attribution only when its target is already in the map:
    /// an attribution ahead of its assistant entry (or aimed at a missing
    /// one) contributes nothing.
    #[test]
    fn attribution_without_a_present_target_folds_nothing() {
        let assistant = message(
            "a",
            "assistant",
            json!({
                "input": 40, "output": 4, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 44,
                "cost": { "input": 0.0, "output": 0.4, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.4 }
            }),
        );
        let orphan = attribution("a", usage(30, 3, 0.3), usage(70, 7, 0.7));
        let ahead_of_target = attribution("z", usage(1, 1, 0.1), usage(41, 5, 0.5));

        let before = scan_summary(&[orphan.clone(), ahead_of_target.clone(), assistant.clone()]);
        let after = scan_summary(&[assistant, orphan, ahead_of_target]);
        assert_eq!(
            before,
            Some(SessionUsageSummary {
                input_tokens: 40,
                output_tokens: 4,
                cost: 0.4
            })
        );
        // After the assistant entry the same attribution DOES fold: the
        // aggregate replaces the raw block and the child spend subtracts
        // back — the same own tokens, at the aggregate/child arithmetic's
        // float residue (the file-order authority is TS's).
        assert_eq!(
            after,
            Some(SessionUsageSummary {
                input_tokens: 40,
                output_tokens: 4,
                cost: 0.7 - 0.3
            })
        );
    }

    /// `compaction` and `branch_summary` entries carry the summarization
    /// call's own billed usage into the summary.
    #[test]
    fn summarization_usage_is_added() {
        let summary = scan_summary(&[
            message(
                "a",
                "assistant",
                json!({
                    "input": 100, "output": 10, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 110,
                    "cost": { "input": 0.0, "output": 1.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 1.0 }
                }),
            ),
            json!({
                "type": "compaction", "id": "c",
                "usage": { "input": 200, "output": 20, "cacheRead": 5, "cacheWrite": 0,
                           "totalTokens": 225,
                           "cost": { "input": 0.1, "output": 0.2, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.3 } }
            }),
            json!({
                "type": "branch_summary", "id": "b",
                "usage": { "input": 50, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                           "totalTokens": 55,
                           "cost": { "input": 0.0, "output": 0.1, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.1 } }
            }),
        ]);
        // 100 + 200 + 5 + 50 input tokens; 10 + 20 + 5 output. The cost
        // sums in the fold's order: the summarization blocks accumulate
        // first ($0.3 + $0.1), then fold into the assistant total.
        assert_eq!(
            summary,
            Some(SessionUsageSummary {
                input_tokens: 355,
                output_tokens: 35,
                cost: 1.0 + (0.3 + 0.1)
            })
        );
    }

    /// A session with no billable work publishes no usage field at all
    /// (TS `sessionUsageSummaryFrom` returns undefined).
    #[test]
    fn no_billable_work_is_none() {
        assert_eq!(scan_summary(&[]), None);
        assert_eq!(
            scan_summary(&[
                message(
                    "u",
                    "user",
                    json!({ "input": 10, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 10, "cost": { "input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0 } })
                ),
                message(
                    "a",
                    "assistant",
                    json!({ "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0, "cost": { "input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0 } })
                ),
            ]),
            None
        );
    }

    /// TS `subtractAssistantUsage` clamps at zero to absorb attribution
    /// drift (child spend the aggregates never folded).
    #[test]
    fn child_attribution_drift_clamps_at_zero() {
        let summary = scan_summary(&[
            message(
                "a",
                "assistant",
                json!({
                    "input": 10, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 11,
                    "cost": { "input": 0.0, "output": 0.1, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.1 }
                }),
            ),
            // Drifted child spend larger than the aggregate folds in.
            attribution("a", usage(900, 90, 0.9), usage(10, 1, 0.1)),
        ]);
        // The clamp drains the session to no billable work at all, so the
        // summary is absent (TS `sessionUsageSummaryFrom` → undefined).
        assert_eq!(summary, None);
    }

    /// The map keeps first-insertion order so the cost sums stay
    /// bit-identical to the TS `Map` fold (a HashMap would reorder them).
    #[test]
    fn cost_sums_follow_insertion_order() {
        let line = |id: &str, cost: f64| {
            message(
                id,
                "assistant",
                json!({
                    "input": 10, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 11,
                    "cost": { "input": 0.0, "output": cost, "cacheRead": 0.0, "cacheWrite": 0.0, "total": cost }
                }),
            )
        };
        let summary = scan_summary(&[line("a", 0.1), line("b", 0.2), line("c", 0.3)]);
        let cost = summary.as_ref().map(|summary| summary.cost);
        assert_eq!(cost, Some(0.1 + 0.2 + 0.3));
        assert_eq!(cost, Some(0.600_000_000_000_000_1));
    }

    /// A persisted partial usage object (`{input, output, totalTokens}`
    /// without `cacheRead`/`cacheWrite`/`cost`) folds like TS
    /// `JSON.parse`: the message keeps its row and every absent field
    /// counts as zero instead of rejecting the whole entry.
    #[test]
    fn partial_usage_objects_keep_the_row() {
        let summary = scan_summary(&[
            message("u", "user", json!(null)),
            message(
                "a",
                "assistant",
                json!({ "input": 5, "output": 1, "totalTokens": 6 }),
            ),
        ]);
        assert_eq!(
            summary,
            Some(SessionUsageSummary {
                input_tokens: 5,
                output_tokens: 1,
                cost: 0.0
            })
        );
    }

    /// Token totals saturate at `u64::MAX` (JS `Infinity`): persisted
    /// overflow must never panic the scan or wrap to an undercount.
    #[test]
    fn overflowing_usage_saturates_never_panics() {
        let line = |id: &str| {
            message(
                id,
                "assistant",
                json!({
                    "input": u64::MAX, "output": 1, "cacheRead": 0, "cacheWrite": 0,
                    "totalTokens": u64::MAX,
                    "cost": { "input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0 }
                }),
            )
        };
        let summary = scan_summary(&[line("a"), line("b")]);
        assert_eq!(
            summary,
            Some(SessionUsageSummary {
                input_tokens: u64::MAX,
                output_tokens: 2,
                cost: 0.0
            })
        );
    }

    /// The standalone whole-file scan reads the same fold from disk;
    /// unparsable lines contribute nothing.
    #[test]
    fn read_own_usage_summary_scans_a_file() {
        let dir = std::env::temp_dir().join(format!("session-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session\",\"id\":\"s\",\"timestamp\":\"2026-09-23T00:00:00.000Z\",\"cwd\":\"/t\"}\n",
                "{\"type\":\"message\",\"id\":\"a\",\"message\":{\"role\":\"assistant\",\"usage\":{\"input\":100,\"output\":10,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":110,\"cost\":{\"input\":0.0,\"output\":1.0,\"cacheRead\":0.0,\"cacheWrite\":0.0,\"total\":1.0}}}}\n",
                "{\"type\":\"child_usage_attributed\",\"targetId\":\"a\",\"childUsage\":{\"input\":30,\"output\":3,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":33,\"cost\":{\"input\":0.0,\"output\":0.3,\"cacheRead\":0.0,\"cacheWrite\":0.0,\"total\":0.3}},\"aggregateUsage\":{\"input\":130,\"output\":13,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":143,\"cost\":{\"input\":0.0,\"output\":1.3,\"cacheRead\":0.0,\"cacheWrite\":0.0,\"total\":1.3}}}\n",
                "not json at all\n",
            ),
        )
        .unwrap();
        assert_eq!(
            read_own_usage_summary(&path),
            Some(SessionUsageSummary {
                input_tokens: 100,
                output_tokens: 10,
                cost: 1.0
            })
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The captured-session numeric parity harness (manual run in the gate
    /// VM): `SAVED_USAGE_FIXTURE=<captured .jsonl> cargo test --ignored`.
    /// The devbox parent fixture (228 entries, six attributions onto one
    /// target) pins the whole fold against the TS-computed summary of the
    /// same file: own spend only — the attributed child spend (input
    /// 50,208 / output 2,929 / $0.0089957) stays on the child rows.
    #[test]
    #[ignore = "needs a captured session fixture (SAVED_USAGE_FIXTURE)"]
    fn captured_session_summary_matches_the_ts_fold() {
        let Some(path) = std::env::var_os("SAVED_USAGE_FIXTURE") else {
            return;
        };
        let summary = read_own_usage_summary(Path::new(&path));
        assert_eq!(
            summary,
            Some(SessionUsageSummary {
                input_tokens: 1_505_509,
                output_tokens: 14_472,
                cost: 0.0
            })
        );
    }
}
