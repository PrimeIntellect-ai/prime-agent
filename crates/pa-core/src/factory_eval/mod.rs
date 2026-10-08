//! Factory capability eval harness: reference machines, prompt pairing,
//! ledger replay, verdicts, and reporting.
//!
//! Port of the TS-era factory capability eval (`packages/coding-agent/
//! scripts/factory-eval.ts`, PR #2402): the deterministic half of a
//! real-token harness that runs the factory capability layer against live
//! sessions. The driver lives in `crates/pa-daemon/src/bin/factory-eval.rs`
//! (it spawns a dedicated supervisor, seeds this module's factory specs into
//! the harness store, runs factory-vs-baseline trial pairs, and writes the
//! reports this module renders); the unit battery in
//! [`crate::factory_eval::tests`] covers every deterministic piece (spec
//! shapes, prompt invariants, the ANSWER parser, the task-success
//! checkers, the replay checker, the verdicts, the report renderer, and
//! the CLI parsing) so no test needs a live model.
//!
//! The evaluation itself follows the Notion spec's "Proposed evaluation":
//! each reference factory runs against a hand-written manual-orchestration
//! baseline (identical topology, inputs, model, and declared budget) and
//! the report scores the pre-registered verdicts — no task-specific
//! orchestration code in the factory prompts (computed from the built
//! prompts, not assumed), the declared failure policy matching observed
//! behavior (an escalation probe), no node starting after a failed dry run
//! (a broken-spec probe), and zero total budget overshoot over the factory
//! arms. Parent-context comparison against the baseline is reported per
//! pair, informational only. Unknown/unmeasured verdicts are their own
//! class (`Inconclusive`), never a silent pass — the swarm-eval reporting
//! precedent (#3185) this port follows.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// Per-node wall-clock budget (admission to settlement) declared on every
/// task node.
pub const NODE_BUDGET_MS: u64 = 240_000;
/// Whole-run wall-clock budget declared on every reference factory.
pub const RUN_BUDGET_MS: u64 = 900_000;
/// The review sweep's foreach bound.
pub const REVIEW_FOREACH_MAX: u64 = 8;
/// Default builder width.
pub const DEFAULT_WIDTH: u64 = 6;
/// Largest builder width (clamped).
pub const MAX_WIDTH: u64 = 12;
/// The resident watcher's hold-open sleep (seconds): a resident child stays
/// alive after the declarative work settles until `rlm.factory.stop`.
pub const RESIDENT_WATCHER_SLEEP_SECONDS: u64 = 900;
/// Marker the monitoring resident sends before idling.
pub const MERGE_READY_MARKER: &str = "MERGE-READY";
/// The resident watcher's wake marker.
pub const WATCHER_MARKER: &str = "swr-marker";
/// Task chain markers for the resident-watcher reference.
pub const TASK_MARKER_A: &str = "swt-1";
pub const TASK_MARKER_B: &str = "swt-2";
/// The default model selector (the TS-era driver default).
pub const DEFAULT_MODEL: &str = "prime-inference/internal/glm-5.2-fast";

/// The builder marker for node `index` (1-based).
#[must_use]
pub fn builder_marker(index: u64) -> String {
    format!("swb-marker-{index}")
}

/// One planted review defect: a real, checkable issue with an audit id.
pub struct ReviewFile {
    pub name: &'static str,
    pub code: &'static str,
    pub issue_id: &'static str,
    pub audit: &'static str,
}

/// Four review files, each with one real, checkable planted defect and its
/// audit id.
pub const REVIEW_FILES: &[ReviewFile] = &[
    ReviewFile {
        name: "fa",
        code: "export function clampUpper(value, max) {\n\treturn Math.max(value, max);\n}",
        issue_id: "AUDIT-A1",
        audit: "callers expect the value capped at max, but Math.max returns the larger operand, so values above max pass through unclamped",
    },
    ReviewFile {
        name: "fb",
        code: "export function medianSorted(values) {\n\treturn values[Math.floor(values.length / 2)];\n}",
        issue_id: "AUDIT-B1",
        audit: "the median of an even-length sorted list is the average of the two middle values, but this returns only the upper middle",
    },
    ReviewFile {
        name: "fc",
        code: "export function isBlank(text) {\n\treturn text === \"\";\n}",
        issue_id: "AUDIT-C1",
        audit: "whitespace-only strings should count as blank, but the strict equality comparison misses them",
    },
    ReviewFile {
        name: "fd",
        code: "const RETRY_DELAY_SECONDS = 30;\nexport const RETRY_DELAY_MS = RETRY_DELAY_SECONDS;",
        issue_id: "AUDIT-D1",
        audit: "RETRY_DELAY_MS is documented as milliseconds but the constant was meant as seconds; the unit conversion is missing",
    },
];

/// Every planted audit id, in file order.
#[must_use]
pub fn review_issue_ids() -> Vec<&'static str> {
    REVIEW_FILES.iter().map(|file| file.issue_id).collect()
}

/// The mini-repo listing shared by every reviewer/fixer prompt.
#[must_use]
fn mini_repo_listing() -> String {
    REVIEW_FILES
        .iter()
        .map(|file| {
            format!(
                "[{}] {} // audit {}: {}",
                file.name, file.code, file.issue_id, file.audit
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------
// Child prompt builders (shared verbatim between factory nodes and baselines).
// ---------------------------------------------------------------------------

/// The review sweep's source node prompt (one fenced json file list).
#[must_use]
pub fn build_files_node_prompt() -> String {
    let list = json!({ "files": REVIEW_FILES.iter().map(|file| file.name).collect::<Vec<_>>() });
    [
        "You are the source node of a pull-request review sweep. Reply with exactly one fenced json block and nothing else:",
        "",
        "```json",
        &list.to_string(),
        "```",
    ]
    .join("\n")
}

/// Reviewer prompt for one file; `{files}` is the foreach placeholder.
#[must_use]
pub fn build_reviewer_prompt_template() -> String {
    [
        "You are one code reviewer in a pull-request review sweep.",
        "",
        "Mini-repo under review (four files, one planted defect each, audit note included):",
        "",
        &mini_repo_listing(),
        "",
        "Your assigned file is {files}. Verify its defect is real, then reply with exactly one line:",
        "FOUND <the audit id of your assigned file>",
        "Output that single line and nothing else, then end your turn.",
    ]
    .join("\n")
}

/// The review sweep's aggregation node prompt.
#[must_use]
pub fn build_report_node_prompt() -> String {
    [
        "You are the aggregation node of a pull-request review sweep.",
        "",
        "Files under review (json): {file_list}",
        "Reviewer reports (one FOUND line per file): {found}",
        "",
        "Every file has exactly one audit id. Cross-check that every reviewer report carries one, then reply with exactly one fenced json block and nothing else:",
        "",
        "```json\n{\"issues\": [<every audit id found, in file order>]}\n```",
    ]
    .join("\n")
}

/// The escalation probe's planted reviewer: deterministic, never runs.
#[must_use]
pub fn build_broken_reviewer_prompt() -> String {
    [
        "You are one code reviewer in a pull-request review sweep. Your assigned file is fa. Verify its defect, then reply with exactly one line:",
        "FOUND AUDIT-A1",
        "Output that single line and nothing else, then end your turn.",
    ]
    .join("\n")
}

/// One builder node's prompt.
#[must_use]
pub fn build_builder_node_prompt(index: u64) -> String {
    [
        &format!("You are builder node {index} of a wide build. Reply with exactly one line:"),
        &format!("BUILT {}", builder_marker(index)),
        "Output that single line and nothing else, then end your turn.",
    ]
    .join("\n")
}

/// The builder run's collector prompt.
#[must_use]
pub fn build_collector_prompt(width: u64) -> String {
    let lines = (1..=width)
        .map(|i| format!("{{line-{i}}}"))
        .collect::<Vec<_>>()
        .join("\n");
    let markers = (1..=width)
        .map(builder_marker)
        .collect::<Vec<_>>()
        .join(" ");
    [
        &format!("You are the collector of a {width}-wide build. One line per builder node arrived:"),
        "",
        &lines,
        "",
        "Merge them. Reply with exactly one line:",
        &format!("COLLECTED <every swb-marker from the lines above, space-separated, in ascending node order> (expected form: COLLECTED {markers})"),
        "Output that single line and nothing else, then end your turn.",
    ]
    .join("\n")
}

/// The resident watcher prompt: replies once, then idles inside its turn.
#[must_use]
pub fn build_watcher_prompt() -> String {
    [
        "You are a resident watcher node attached to an orchestration run. Do exactly this, in order:",
        "",
        "1. In the ipython tool, send your parent one message with exactly this text:",
        "   await agent_message.send(\"WATCHER-UP swr-marker\", receiver_role=\"parent\")",
        "2. Then, still in the ipython tool, run:",
        "   import asyncio",
        &format!("   await asyncio.sleep({RESIDENT_WATCHER_SLEEP_SECONDS})"),
        "   and stay idle. Do not end your turn before the sleep finishes. Do not send more messages. Do nothing else.",
    ]
    .join("\n")
}

/// Task node A of the resident-watcher's two-step chain.
#[must_use]
pub fn build_task_a_prompt() -> String {
    [
        "You are task node A of a tiny two-step chain. Reply with exactly one line:",
        "STEP swt-1",
        "Output that single line and nothing else, then end your turn.",
    ]
    .join("\n")
}

/// Task node B of the resident-watcher's two-step chain; `{prev}` is task A's captured output.
#[must_use]
pub fn build_task_b_prompt_template() -> String {
    [
        "You are task node B of a tiny two-step chain. The previous step reported: {prev}",
        "Reply with exactly one line:",
        "STEP swt-2",
        "Output that single line and nothing else, then end your turn.",
    ]
    .join("\n")
}

/// The pr-manager's entry state prompt.
#[must_use]
pub fn build_pr_entry_prompt() -> String {
    [
        "You are the entry state of a pull-request manager loop. Reply with exactly one line describing the pull request under management:",
        "",
        "PR swp://mini-repo: the snapshot under review carries four planted defects with audit notes",
        "",
        "Output that single line and nothing else, then end your turn.",
    ]
    .join("\n")
}

/// The pr-manager's reviewing prompt; `{pr_url}` is the entry state's output
/// and `{fix_report}` the previous fixing round's report (null on the first
/// review).
#[must_use]
pub fn build_pr_reviewing_prompt_template() -> String {
    [
        "You are the reviewing state of a pull-request manager loop.",
        "",
        "Pull request under review: {pr_url}",
        "",
        "Fix report from the previous fixing round (json; null means no fixing round has run yet): {fix_report}",
        "",
        "Mini-repo under review (four files, one planted defect each, audit note included):",
        "",
        &mini_repo_listing(),
        "",
        "Decide whether the pull request is merge-ready: when the fix report lists every finding you previously reported as fixed, approve it. Then reply with exactly one fenced json block and nothing else:",
        "",
        "```json\n{\"verdict\": {\"approved\": <true when the pull request is merge-ready, otherwise false>, \"findings\": [<every audit id that still needs a fix> ]}}\n```",
        "",
        "Output that single block and nothing else, then end your turn.",
    ]
    .join("\n")
}

/// The pr-manager's fixing prompt; `{verdict}` is the reviewing state's captured json output.
#[must_use]
pub fn build_pr_fixing_prompt_template() -> String {
    [
        "You are the fixing state of a pull-request manager loop.",
        "",
        "Review verdict to act on (json): {verdict}",
        "",
        "Mini-repo under repair (four files, one planted defect each, audit note included):",
        "",
        &mini_repo_listing(),
        "",
        "Fix every finding, then reply with exactly one fenced json block and nothing else:",
        "",
        "```json\n{\"fix_report\": {\"fixed\": [<every audit id you fixed>]}}\n```",
        "",
        "Output that single block and nothing else, then end your turn.",
    ]
    .join("\n")
}

/// The pr-manager's resident monitoring prompt: replies once, then idles.
#[must_use]
pub fn build_pr_monitoring_prompt() -> String {
    [
        "You are the monitoring state of a pull-request manager loop: a resident watcher attached to the merge-ready pull request. Do exactly this, in order:",
        "",
        "1. In the ipython tool, send your parent one message with exactly this text:",
        &format!("   await agent_message.send(\"{MERGE_READY_MARKER} {WATCHER_MARKER}\", receiver_role=\"parent\")"),
        "2. Then, still in the ipython tool, run:",
        "   import asyncio",
        &format!("   await asyncio.sleep({RESIDENT_WATCHER_SLEEP_SECONDS})"),
        "   and stay idle. Do not end your turn before the sleep finishes. Do not send more messages. Do nothing else.",
    ]
    .join("\n")
}

// ---------------------------------------------------------------------------
// Reference factory spec builders (dag sugar + the pr-manager machine).
// ---------------------------------------------------------------------------

fn inline(prompt: &str, name: &str) -> Value {
    json!({ "prompt": prompt, "name": name })
}

fn inline_model(prompt: &str, name: &str, model: &str) -> Value {
    json!({ "prompt": prompt, "name": name, "model": model })
}

/// Reference factory 1: pull-request review sweep with typed fan-in and
/// escalation. A source node emits a file list, a foreach reviewer spawns one
/// child per file, and an aggregator consumes both through typed ports.
#[must_use]
pub fn build_review_sweep_dag() -> Value {
    json!({
        "run": { "budget_ms": RUN_BUDGET_MS, "failure_policy": "escalate", "max_parallel": REVIEW_FOREACH_MAX },
        "nodes": [
            {
                "id": "files",
                "subagent": inline(&build_files_node_prompt(), "files-source"),
                "outputs": [{ "name": "files", "type": "json" }],
                "budget_ms": NODE_BUDGET_MS
            },
            {
                "id": "review",
                "subagent": inline(&build_reviewer_prompt_template(), "file-reviewer"),
                "inputs": [{ "name": "files", "type": "json", "from": "files.files" }],
                "outputs": [{ "name": "found", "type": "text" }],
                "foreach": { "over": "files", "max": REVIEW_FOREACH_MAX },
                "budget_ms": NODE_BUDGET_MS
            },
            {
                "id": "report",
                "subagent": inline(&build_report_node_prompt(), "review-aggregator"),
                "inputs": [
                    { "name": "file_list", "type": "json", "from": "files.files" },
                    { "name": "found", "type": "text", "from": "review.found" }
                ],
                "outputs": [{ "name": "issues", "type": "json" }],
                "budget_ms": NODE_BUDGET_MS
            }
        ]
    })
}

/// review-sweep plus a planted failing reviewer: admission of an
/// unresolvable model pin — deterministic, zero child tokens.
///
/// # Panics
///
/// Panics only on an internal invariant violation (the json! literal and
/// the sweep fixture always build).
#[must_use]
pub fn build_review_sweep_fail_dag() -> Value {
    let mut dag = build_review_sweep_dag();
    let nodes = dag
        .get_mut("nodes")
        .and_then(Value::as_array_mut)
        .expect("review sweep nodes");
    // Insert after the foreach so it starts once the sweep is under way.
    nodes.insert(
        2,
        json!({
            "id": "review-broken",
            "subagent": inline_model(
                &build_broken_reviewer_prompt(),
                "broken-reviewer",
                "internal/no-such-model-for-eval"
            ),
            "depends_on": ["files"],
            "budget_ms": NODE_BUDGET_MS,
            "failure_policy": "escalate"
        }),
    );
    dag
}

/// Reference factory 2: `width` builder nodes each produce one distinct
/// marker line; a collector merges them through typed fan-in.
#[must_use]
pub fn build_builder_dag(width: u64) -> Value {
    let mut nodes: Vec<Value> = (1..=width)
        .map(|i| {
            json!({
                "id": format!("builder-{i}"),
                "subagent": inline(&build_builder_node_prompt(i), &format!("builder-{i}")),
                "outputs": [{ "name": "line", "type": "text" }],
                "budget_ms": NODE_BUDGET_MS
            })
        })
        .collect();
    nodes.push(json!({
        "id": "collector",
        "subagent": inline(&build_collector_prompt(width), "build-collector"),
        "inputs": (1..=width)
            .map(|i| json!({ "name": format!("line-{i}"), "type": "text", "from": format!("builder-{i}.line") }))
            .collect::<Vec<_>>(),
        "outputs": [{ "name": "merged", "type": "text" }],
        "budget_ms": NODE_BUDGET_MS
    }));
    json!({
        "run": { "budget_ms": RUN_BUDGET_MS, "failure_policy": "escalate", "max_parallel": 8 },
        "nodes": nodes
    })
}

/// Reference factory 3: a resident watcher runs alongside a bounded
/// two-step task chain; `stop()` tears the resident down.
#[must_use]
pub fn build_resident_watcher_dag() -> Value {
    json!({
        "run": { "budget_ms": RUN_BUDGET_MS, "failure_policy": "escalate", "max_parallel": 8 },
        "nodes": [
            {
                "id": "watcher",
                "subagent": inline(&build_watcher_prompt(), "resident-watcher"),
                "lifecycle": "resident"
            },
            {
                "id": "task-a",
                "subagent": inline(&build_task_a_prompt(), "chain-step-a"),
                "outputs": [{ "name": "step", "type": "text" }],
                "budget_ms": NODE_BUDGET_MS
            },
            {
                "id": "task-b",
                "subagent": inline(&build_task_b_prompt_template(), "chain-step-b"),
                "inputs": [{ "name": "prev", "type": "text", "from": "task-a.step" }],
                "outputs": [{ "name": "step", "type": "text" }],
                "budget_ms": NODE_BUDGET_MS
            }
        ]
    })
}

/// Structurally valid but unresolvable: references a subagent entry that
/// does not exist (the dry-run rejection probe).
#[must_use]
pub fn build_broken_dag() -> Value {
    json!({
        "run": { "budget_ms": RUN_BUDGET_MS, "failure_policy": "escalate", "max_parallel": 8 },
        "nodes": [{ "id": "broken-source", "subagent": "no-such-subagent-entry" }]
    })
}

/// The pr-manager reference machine: entry -> reviewing -> (fixing ->
/// reviewing)* -> monitoring, driven by the approved verdict guard. The
/// fixing state reports the ids it fixed through a json `fix_report`
/// output; reviewing's optional `fix_report` input re-binds that report on
/// every re-entry (it binds null on the first review, before the fixer ever
/// runs), so a consistent reviewer rejects round 1 and approves once the
/// report covers its findings. Monitoring stays resident until the caller
/// stops the run.
#[must_use]
pub fn build_pr_manager_machine() -> Value {
    json!({
        "run": { "budget_ms": RUN_BUDGET_MS, "failure_policy": "escalate", "max_parallel": 8, "max_transitions": 24 },
        "states": [
            {
                "id": "entry",
                "entry": true,
                "subagent": inline(&build_pr_entry_prompt(), "pr-entry"),
                "outputs": [{ "name": "pr_url", "type": "text" }],
                "budget_ms": NODE_BUDGET_MS
            },
            {
                "id": "reviewing",
                "subagent": inline(&build_pr_reviewing_prompt_template(), "pr-reviewing"),
                "inputs": [
                    { "name": "pr_url", "type": "text", "from": "entry.pr_url" },
                    { "name": "fix_report", "type": "json", "from": "fixing.fix_report", "optional": true }
                ],
                "outputs": [{ "name": "verdict", "type": "json" }],
                "max_entries": 4,
                "budget_ms": NODE_BUDGET_MS
            },
            {
                "id": "fixing",
                "subagent": inline(&build_pr_fixing_prompt_template(), "pr-fixing"),
                "inputs": [{ "name": "verdict", "type": "json", "from": "reviewing.verdict" }],
                "outputs": [{ "name": "fix_report", "type": "json" }],
                "max_entries": 3,
                "budget_ms": NODE_BUDGET_MS
            },
            {
                "id": "monitoring",
                "subagent": inline(&build_pr_monitoring_prompt(), "pr-monitoring"),
                "lifecycle": "resident"
            }
        ],
        "transitions": [
            { "from": "entry", "to": "reviewing" },
            {
                "from": "reviewing",
                "to": "fixing",
                "when": { "output": "verdict", "path": "approved", "op": "eq", "value": false }
            },
            {
                "from": "reviewing",
                "to": "monitoring",
                "when": { "output": "verdict", "path": "approved", "op": "eq", "value": true }
            },
            { "from": "fixing", "to": "reviewing" }
        ]
    })
}

// ---------------------------------------------------------------------------
// The reference factory registry.
// ---------------------------------------------------------------------------

/// The eval's factory selection: the paired factory/baseline arms the sweep
/// runs. The two probes (escalation, dry-run) run factory arms only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReferenceFactoryKind {
    ReviewSweep,
    Builder,
    ResidentWatcher,
    PrManager,
    /// The escalation probe (factory arm only).
    ReviewSweepFail,
    /// The dry-run rejection probe (factory arm only).
    DryRunReject,
}

impl ReferenceFactoryKind {
    /// The selection token shared by the CLI and the report rows.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReviewSweep => "review-sweep",
            Self::Builder => "builder",
            Self::ResidentWatcher => "resident-watcher",
            Self::PrManager => "pr-manager",
            Self::ReviewSweepFail => "review-sweep-fail",
            Self::DryRunReject => "dry-run-reject",
        }
    }

    /// Parse a selection token.
    ///
    /// # Errors
    ///
    /// Returns the unknown token for anything outside the closed set (a
    /// typo must fail before any token is spent, not silently run the
    /// defaults).
    pub fn parse(raw: &str) -> Result<Self, String> {
        Ok(match raw {
            "review-sweep" => Self::ReviewSweep,
            "builder" => Self::Builder,
            "resident-watcher" => Self::ResidentWatcher,
            "pr-manager" => Self::PrManager,
            "review-sweep-fail" => Self::ReviewSweepFail,
            "dry-run-reject" => Self::DryRunReject,
            other => return Err(other.to_string()),
        })
    }

    /// Every selectable kind, in the report's canonical order.
    #[must_use]
    pub fn selections() -> [Self; 4] {
        [
            Self::ReviewSweep,
            Self::Builder,
            Self::ResidentWatcher,
            Self::PrManager,
        ]
    }

    /// Whether the kind is one of the sweep's automatic probes (they run
    /// once per sweep, never as `--factories` selections — a probe has no
    /// baseline arm, and the old TS harness rejected them from the flag
    /// the same way).
    #[must_use]
    pub fn is_probe(self) -> bool {
        matches!(self, Self::ReviewSweepFail | Self::DryRunReject)
    }
}

/// One reference factory: the stored spec plus its declared shape (the
/// budget and fan-in the verdicts score against).
#[derive(Debug, Clone)]
pub struct ReferenceFactory {
    pub id: String,
    pub kind: ReferenceFactoryKind,
    pub title: &'static str,
    pub description: String,
    /// Exactly one of machine/dag is present: machine form wins when set.
    pub machine: Option<Value>,
    pub dag: Option<Value>,
    pub declared_budget_ms: u64,
    pub declared_fan_in: u64,
    pub width: Option<u64>,
}

impl ReferenceFactory {
    /// The stored arguments payload: machine form wins when present.
    ///
    /// # Panics
    ///
    /// Panics when a machine-form reference carries no machine (an
    /// internal invariant: every reference is built with exactly one form).
    #[must_use]
    pub fn spec_arguments(&self) -> Value {
        if let Some(machine) = &self.machine {
            json!({ "machine": machine })
        } else {
            json!({ "dag": self.dag.clone().expect("reference carries a dag") })
        }
    }
}

/// Stable harness entry ids for the seeded specs.
const FACTORY_ENTRY_IDS: [&str; 6] = [
    "factory-dag-eval-review-sweep",
    "factory-dag-eval-builder",
    "factory-dag-eval-resident-watcher",
    "factory-dag-eval-pr-manager",
    "factory-dag-eval-review-fail",
    "factory-dag-eval-broken",
];

fn reference_factory(kind: ReferenceFactoryKind, width: u64) -> ReferenceFactory {
    let (id, title, description, machine, dag, fan_in) = match kind {
        ReferenceFactoryKind::ReviewSweep => (
            0,
            "review-sweep",
            "Reference factory: pull-request review sweep with typed fan-in and escalation (capability eval).".to_string(),
            None,
            Some(build_review_sweep_dag()),
            REVIEW_FILES.len() as u64,
        ),
        ReferenceFactoryKind::Builder => (
            1,
            "builder",
            format!("Reference factory: {width}-wide builder run with per-node budgets (capability eval)."),
            None,
            Some(build_builder_dag(width)),
            width,
        ),
        ReferenceFactoryKind::ResidentWatcher => (
            2,
            "resident-watcher",
            "Reference factory: resident watcher that starts a bounded task DAG (capability eval).".to_string(),
            None,
            Some(build_resident_watcher_dag()),
            1,
        ),
        ReferenceFactoryKind::PrManager => (
            3,
            "pr-manager",
            "Reference machine: guarded review/fix loop that re-enters reviewing until the verdict approves, then parks a resident monitoring state (capability eval).".to_string(),
            Some(build_pr_manager_machine()),
            None,
            2,
        ),
        ReferenceFactoryKind::ReviewSweepFail => (
            4,
            "review-sweep-fail",
            "Escalation probe: review sweep with one planted failing reviewer; the declared escalate policy must pause the run.".to_string(),
            None,
            Some(build_review_sweep_fail_dag()),
            REVIEW_FILES.len() as u64,
        ),
        ReferenceFactoryKind::DryRunReject => (
            5,
            "broken",
            "Dry-run probe: structurally valid spec that references an unknown subagent.".to_string(),
            None,
            Some(build_broken_dag()),
            0,
        ),
    };
    ReferenceFactory {
        id: FACTORY_ENTRY_IDS[id].to_string(),
        kind,
        title,
        description,
        machine,
        dag,
        declared_budget_ms: RUN_BUDGET_MS,
        declared_fan_in: fan_in,
        width: (kind == ReferenceFactoryKind::Builder).then_some(width),
    }
}

/// Every reference factory for one width, in the report's canonical order
/// (the four selections first, then the two probes).
#[must_use]
pub fn build_reference_factories(width: u64) -> Vec<ReferenceFactory> {
    let mut factories: Vec<ReferenceFactory> = ReferenceFactoryKind::selections()
        .into_iter()
        .map(|kind| reference_factory(kind, width))
        .collect();
    factories.push(reference_factory(
        ReferenceFactoryKind::ReviewSweepFail,
        width,
    ));
    factories.push(reference_factory(ReferenceFactoryKind::DryRunReject, width));
    factories
}

/// Find one reference factory by kind.
///
/// # Panics
///
/// Panics when the registry does not carry the kind (an internal invariant:
/// the registry is built from the closed kind set).
#[must_use]
pub fn find_reference_factory(
    factories: &[ReferenceFactory],
    kind: ReferenceFactoryKind,
) -> &ReferenceFactory {
    factories
        .iter()
        .find(|factory| factory.kind == kind)
        .unwrap_or_else(|| panic!("unknown reference factory kind {}", kind.as_str()))
}

/// Full `harness_state.json` file body seeding the given factory entries
/// (the exact file the kernel's harness store loads through
/// `RLM_HARNESS_STATE_DIR`).
///
/// # Panics
///
/// Panics only when serialization fails (the state body always
/// serializes).
#[must_use]
pub fn build_harness_state_file(specs: &[ReferenceFactory], now_iso: &str) -> String {
    let mut entries = BTreeMap::new();
    for spec in specs {
        entries.insert(
            spec.id.clone(),
            json!({
                "id": spec.id,
                "kind": "factory",
                "title": spec.title,
                "content": spec.description,
                "path": "factory-dag-eval",
                "scope": "local",
                "reference": {},
                "arguments": spec.spec_arguments(),
                "metadata": { "evalKind": spec.kind.as_str(), "source": "factory-dag-eval" },
                "source": "agent",
                "created_at": now_iso,
                "updated_at": now_iso,
                "version": 1
            }),
        );
    }
    let body = json!({
        "schema": 1,
        "entries": { "prompt": {}, "memory": {}, "skill": {}, "subagent": {}, "factory": entries },
        "refinements": []
    });
    format!(
        "{}\n",
        serde_json::to_string_pretty(&body).expect("harness state serializes")
    )
}

// ---------------------------------------------------------------------------
// Parent prompts.
// ---------------------------------------------------------------------------

/// The poll-cell body shared by every factory parent prompt: start the run
/// and poll `rlm.factory.status` to a terminal state in one cell.
#[must_use]
fn poll_code(break_states: &str) -> String {
    [
        "import asyncio, json",
        "started = await rlm.factory.run('<ID>')",
        "run_id = started[\"run_id\"]",
        "while True:",
        "\tstatus = await rlm.factory.status(run_id)",
        &format!("\tif status[\"state\"] in ({break_states}):"),
        "\t\tbreak",
        "\tawait asyncio.sleep(5)",
    ]
    .join("\n")
}

fn fill(prompt: &str, factory: &ReferenceFactory, ledger_path: &str, poll: &str) -> String {
    prompt
        .replace("<POLL>", poll)
        .replace("<ID>", &factory.id)
        .replace("<LEDGER>", ledger_path)
}

/// Parent prompt for a factory trial. Contains NO spawn/collect
/// instructions: the verdict "no task-specific orchestration code in the
/// parent" is checked against this builder (see the unit battery).
#[must_use]
pub fn build_factory_parent_prompt(factory: &ReferenceFactory, ledger_path: &str) -> String {
    let head = format!(
        "Capability eval: factory DAG orchestration. The local harness state for this session seeds exactly one factory specification: \"{}\". Run it with the executor and report the outcome. Do not spawn subagents yourself; the factory executor owns the children.",
        factory.id
    );
    let all_terminal = "\"done\", \"failed\", \"stopped\", \"paused\"";
    match factory.kind {
        ReferenceFactoryKind::ReviewSweep => fill(
            &[
                &head,
                "",
                "Step 1 — start the run and poll it to a terminal state in one ipython cell:",
                "",
                "<POLL>",
                "",
                "Step 2 — in the same or a new ipython cell, save the final status:",
                "",
                "\tjson.dump(status, open(r\"<LEDGER>\", \"w\"))",
                "",
                "Step 3 — the node with id \"report\" in status[\"nodes\"] has an answer_preview containing a JSON object like {\"issues\": [...]}. Output exactly one line and nothing else:",
                "",
                "ANSWER: ISSUES: <every audit id inside the report answer_preview, comma-separated>; STATE: <status[\"state\"]>",
            ]
            .join("\n"),
            factory,
            ledger_path,
            &poll_code(all_terminal),
        ),
        ReferenceFactoryKind::Builder => fill(
            &[
                &head,
                "",
                "Step 1 — start the run and poll it to a terminal state in one ipython cell:",
                "",
                "<POLL>",
                "",
                "Step 2 — in the same or a new ipython cell, save the final status:",
                "",
                "\tjson.dump(status, open(r\"<LEDGER>\", \"w\"))",
                "",
                "Step 3 — the node with id \"collector\" in status[\"nodes\"] has an answer_preview starting with COLLECTED and listing every swb-marker. Output exactly one line and nothing else:",
                "",
                "ANSWER: MARKERS: <every swb-marker from the collector answer_preview, comma-separated>; STATE: <status[\"state\"]>",
            ]
            .join("\n"),
            factory,
            ledger_path,
            &poll_code(all_terminal),
        ),
        ReferenceFactoryKind::ResidentWatcher => fill(
            &[
                &head,
                "The watcher node is resident: the run reaches done while the watcher child stays alive; you must then stop the run to tear it down.",
                "",
                "Step 1 — start the run and poll until the declarative work is done (state done) in one ipython cell:",
                "",
                "<POLL>",
                "",
                "Step 2 — stop the run, save the final status, and report. In the same or a new ipython cell:",
                "",
                "\tstopped = await rlm.factory.stop(run_id)",
                "\tstatus = await rlm.factory.status(run_id)",
                "\tjson.dump(status, open(r\"<LEDGER>\", \"w\"))",
                "\tstopped",
                "",
                "Step 3 — the nodes \"task-a\" and \"task-b\" in status[\"nodes\"] have answer_previews listing the step markers, and stopped[\"cancelled\"] lists the torn-down resident. Output exactly one line and nothing else:",
                "",
                "ANSWER: MARKERS: <the two step markers, comma-separated>; STOPPED: <the cancelled node ids from stopped[\"cancelled\"], comma-separated>; STATE: <status[\"state\"]>",
            ]
            .join("\n"),
            factory,
            ledger_path,
            &poll_code("\"done\", \"failed\", \"paused\""),
        ),
        ReferenceFactoryKind::PrManager => fill(
            &[
                "Capability eval: factory state-machine orchestration. The local harness state for this session seeds exactly one factory specification: \"<ID>\". Run it with the executor and report the outcome. Do not spawn subagents yourself; the factory executor owns the children.",
                "",
                "The machine loops reviewing and fixing until the reviewing verdict approves the pull request, then parks a resident monitoring state: the run reaches done while the monitoring child stays alive; you must then stop the run to tear it down.",
                "",
                "Step 1 — start the run and poll until the declarative work is done (state done) in one ipython cell:",
                "",
                "<POLL>",
                "",
                "Step 2 — stop the run to tear the resident monitoring state down, save the final status, and report. In the same or a new ipython cell:",
                "",
                "\tstopped = await rlm.factory.stop(run_id)",
                "\tstatus = await rlm.factory.status(run_id)",
                "\tjson.dump(status, open(r\"<LEDGER>\", \"w\"))",
                "\tstopped",
                "",
                "Step 3 — from the saved status: APPROVED is yes when the fenced json block in the reviewing state's answer_preview has verdict.approved true, DEFECTS is every audit id that appears in the fixing state's captured answers (its answer_preview plus the fixing answer_captured ledger events), ROUNDS is the reviewing state's entries_used, and STOPPED lists the cancelled state ids. Output exactly one line and nothing else:",
                "",
                "ANSWER: APPROVED: <yes|no>; DEFECTS: <every audit id from the fixing answers, comma-separated>; ROUNDS: <the reviewing state's entries_used>; STOPPED: <the cancelled state ids from stopped[\"cancelled\"], comma-separated>; STATE: <status[\"state\"]>",
            ]
            .join("\n"),
            factory,
            ledger_path,
            &poll_code("\"done\", \"failed\", \"paused\""),
        ),
        ReferenceFactoryKind::ReviewSweepFail => fill(
            &[
                &head,
                "One reviewer node in this factory is planted to fail (its subagent model reference cannot be resolved), so the declared escalate policy must pause the run.",
                "",
                "Step 1 — start the run and poll it to a terminal state in one ipython cell:",
                "",
                "<POLL>",
                "",
                "Step 2 — save the paused status, then stop the run to cancel the in-flight children. In the same or a new ipython cell:",
                "",
                "\tjson.dump(status, open(r\"<LEDGER>\", \"w\"))",
                "\tawait rlm.factory.stop(run_id)",
                "",
                "Step 3 — from the saved status: STATE is status[\"state\"], FAILED-NODE is the id of the node whose status is \"error\", and REPORT-STATUS is the status of the node \"report\". Output exactly one line and nothing else:",
                "",
                "ANSWER: STATE: <state>; FAILED-NODE: <failing node id>; REPORT-STATUS: <status of the report node>",
            ]
            .join("\n"),
            factory,
            ledger_path,
            &poll_code(all_terminal),
        ),
        ReferenceFactoryKind::DryRunReject => fill(
            &[
                &head,
                "This specification is intentionally INVALID: it references a harness subagent that does not exist. The run call must raise and start no node.",
                "",
                "Step 1 — in one ipython cell:",
                "",
                "\timport json",
                "\terror_message = \"no error\"",
                "\ttry:",
                "\t\tawait rlm.factory.run('<ID>')",
                "\texcept Exception as exc:",
                "\t\terror_message = str(exc)",
                "\tsubs = await rlm.list_subagents()",
                "\tprint(error_message)",
                "\tsubs",
                "",
                "Step 2 — output exactly one line and nothing else:",
                "",
                "ANSWER: REJECTED: <yes if the run call raised, otherwise no>; CHILDREN: <the number of entries in subs>; MESSAGE: <the error message>",
            ]
            .join("\n"),
            factory,
            ledger_path,
            "",
        ),
    }
}

/// The declared-budget sentence shared by every baseline prompt.
fn budget_line(factory: &ReferenceFactory) -> String {
    format!(
        "Declared budget: complete the whole run within {} minutes; each child within {} minutes.",
        factory.declared_budget_ms / 60_000,
        NODE_BUDGET_MS / 60_000
    )
}

/// Baseline prompt: the identical task done with manual orchestration
/// (`rlm.spawn` + `rlm.collect`). Never touches the factory executor.
#[must_use]
pub fn build_baseline_prompt(factory: &ReferenceFactory, ledger_path: &str) -> String {
    let indent = |prompt: &str| prompt.replace('\n', "\n\t");
    match factory.kind {
        ReferenceFactoryKind::ReviewSweep => [
            "Capability eval: manual multi-agent orchestration (baseline). Do the identical pull-request review sweep by orchestrating the children yourself with rlm.spawn and rlm.collect. Do NOT use the factory executor.",
            &budget_line(factory),
            "",
            "Step 1 — spawn one reviewer child per file in one ipython cell. Each child's prompt is the reviewer template below with the placeholder {files} replaced by the file's name; compose the four prompts by substitution. Do not set a model on the spawn; children inherit yours.",
            "",
            "import asyncio, json",
            "reviewer_template = \"\"\"",
            &format!("\t{}", indent(&build_reviewer_prompt_template())),
            "\t\"\"\"",
            "reviewer_prompts = {name: reviewer_template.replace(\"{files}\", name) for name in [\"fa\", \"fb\", \"fc\", \"fd\"]}",
            "handles = {name: await rlm.spawn(prompt, name=f\"reviewer-{name}\") for name, prompt in reviewer_prompts.items()}",
            "ids = [handle.rlm_child_id for handle in handles.values()]",
            "",
            "Step 2 — poll until all four children settle, then save their answers:",
            "",
            "while True:",
            "\tresults = await rlm.collect(ids, timeout_ms=2000)",
            "\tif all(r.settled for r in results):",
            "\t\tbreak",
            "\tawait asyncio.sleep(2)",
            "answers = {r.session_name: r.answer_preview for r in results}",
            &format!("json.dump(answers, open(r\"{ledger_path}\", \"w\"))"),
            "results",
            "",
            "Step 3 — aggregate the found audit ids from the four answer previews yourself and output exactly one line and nothing else:",
            "",
            "ANSWER: ISSUES: <every audit id found, comma-separated, sorted>",
        ]
        .join("\n"),
        ReferenceFactoryKind::Builder => {
            let width = factory.width.unwrap_or(DEFAULT_WIDTH);
            let mut prompts = vec!["\t\"builder prompts follow\"".to_string()];
            prompts.clear();
            for i in 1..=width {
                let prompt = build_builder_node_prompt(i);
                prompts.push(format!("\t\"{i}\": \"\"\"\n{}\"\"\",", indent(&prompt)));
            }
            [
                "Capability eval: manual multi-agent orchestration (baseline). Do the identical wide build by orchestrating the children yourself with rlm.spawn and rlm.collect. Do NOT use the factory executor.",
                &budget_line(factory),
                "",
                &format!("Step 1 — spawn {width} builder children in one ipython cell, using the exact child prompts below. Do not set a model on the spawn; children inherit yours."),
                "",
                "import asyncio, json",
                "builder_prompts = {",
                &prompts.join("\n"),
                "}",
                "handles = {i: await rlm.spawn(prompt, name=f\"builder-{i}\") for i, prompt in builder_prompts.items()}",
                "ids = [handle.rlm_child_id for handle in handles.values()]",
                "",
                "Step 2 — poll until every child settles, then save their answers:",
                "",
                "while True:",
                "\tresults = await rlm.collect(ids, timeout_ms=2000)",
                "\tif all(r.settled for r in results):",
                "\t\tbreak",
                "\tawait asyncio.sleep(2)",
                "answers = {r.session_name: r.answer_preview for r in results}",
                &format!("json.dump(answers, open(r\"{ledger_path}\", \"w\"))"),
                "results",
                "",
                "Step 3 — merge the builder markers from the answer previews yourself and output exactly one line and nothing else:",
                "",
                "ANSWER: MARKERS: <every swb-marker found, comma-separated, in ascending node order>",
            ]
            .join("\n")
        }
        ReferenceFactoryKind::ResidentWatcher => [
            "Capability eval: manual multi-agent orchestration (baseline). Run the identical resident-watcher topology by orchestrating the children yourself with rlm.spawn and rlm.collect. Do NOT use the factory executor.",
            &budget_line(factory),
            "",
            "Step 1 — spawn the watcher child and the task-a child in one ipython cell, using the exact child prompts below. Do not set a model on the spawn; children inherit yours.",
            "",
            "import asyncio, json",
            "watcher = await rlm.spawn(\"\"\"",
            &format!("\t{}", indent(&build_watcher_prompt())),
            "\t\"\"\", name=\"watcher\")",
            "task_a = await rlm.spawn(\"\"\"",
            &format!("\t{}", indent(&build_task_a_prompt())),
            "\t\"\"\", name=\"task-a\")",
            "",
            "Step 2 — poll until task-a settles and read its answer_preview:",
            "",
            "while True:",
            "\tresults = await rlm.collect([task_a.rlm_child_id], timeout_ms=2000)",
            "\tif all(r.settled for r in results):",
            "\t\tbreak",
            "\tawait asyncio.sleep(2)",
            "task_a_answer = results[0].answer_preview",
            "",
            "Step 3 — spawn task-b with the task-b prompt below, replacing the line that reads `The previous step reported: {prev}` with task_a_answer:",
            "",
            "task_b = await rlm.spawn(\"\"\"",
            &format!("\t{}", indent(&build_task_b_prompt_template())),
            "\t\"\"\", name=\"task-b\")",
            "",
            "Step 4 — poll until task-b settles, then save the answers and tear the watcher down:",
            "",
            "while True:",
            "\tresults = await rlm.collect([task_a.rlm_child_id, task_b.rlm_child_id], timeout_ms=2000)",
            "\tif all(r.settled for r in results):",
            "\t\tbreak",
            "\tawait asyncio.sleep(2)",
            "answers = {r.session_name: r.answer_preview for r in results}",
            &format!("json.dump(answers, open(r\"{ledger_path}\", \"w\"))"),
            "await rlm.delete_subagent(watcher.rlm_child_id)",
            "",
            "Step 5 — output exactly one line and nothing else:",
            "",
            "ANSWER: MARKERS: <the two step markers from the answers, comma-separated>; STOPPED: watcher",
        ]
        .join("\n"),
        ReferenceFactoryKind::PrManager => [
            "Capability eval: manual multi-agent orchestration (baseline). Run the identical pull-request manager loop by orchestrating the children yourself with rlm.spawn and rlm.collect. Do NOT use the factory executor.",
            &budget_line(factory),
            "",
            "Step 1 — spawn the entry child and collect its answer as pr_url, using the exact prompt below. Do not set a model on the spawn; children inherit yours.",
            "",
            "import asyncio, json",
            "async def settle_one(handle):",
            "    \"\"\"Poll one child until it settles, then return its collect entry.\"\"\"",
            "    while True:",
            "        result = (await rlm.collect([handle.rlm_child_id], timeout_ms=2000))[0]",
            "        if result.settled:",
            "            return result",
            "        await asyncio.sleep(2)",
            "",
            "entry = await rlm.spawn(\"\"\"",
            &format!("\t{}", indent(&build_pr_entry_prompt())),
            "\t\"\"\", name=\"pr-entry\")",
            "pr_url = (await settle_one(entry)).answer_preview",
            "",
            "Step 2 — compose the reviewing and fixing prompts once by substitution (the reviewing prompt uses {pr_url} and {fix_report}; the fixing prompt uses {verdict}):",
            "",
            "reviewing_template = \"\"\"",
            &format!("\t{}", indent(&build_pr_reviewing_prompt_template())),
            "\t\"\"\"",
            "fixing_template = \"\"\"",
            &format!("\t{}", indent(&build_pr_fixing_prompt_template())),
            "\t\"\"\"",
            "",
            "Step 3 — run the loop by hand: review the pull request, and while the verdict json says approved false and fewer than two review rounds have run, spawn the fixing child with the verdict, settle it, then re-review with the fix report substituted. Parse the verdict json from each reviewing answer with json.loads (strip the ``` fences first):",
            "",
            "def parse_verdict(answer):",
            "    block = answer[answer.find('{'):answer.rfind('}') + 1]",
            "    return json.loads(block)['verdict']",
            "",
            "rounds = 1",
            "fix_answers = []",
            "reviewing = await rlm.spawn(reviewing_template.replace(\"{pr_url}\", pr_url).replace(\"{fix_report}\", \"null\"), name=\"pr-reviewing-1\")",
            "verdict = parse_verdict((await settle_one(reviewing)).answer_preview)",
            "while verdict['approved'] is False and rounds < 3:",
            "\tfixing = await rlm.spawn(fixing_template.replace(\"{verdict}\", json.dumps(verdict)), name=f\"pr-fixing-{rounds}\")",
            "\tfix_answer = (await settle_one(fixing)).answer_preview",
            "\tfix_answers.append(fix_answer)",
            "\trounds += 1",
            "\treviewing = await rlm.spawn(reviewing_template.replace(\"{pr_url}\", pr_url).replace(\"{fix_report}\", fix_answer), name=f\"pr-reviewing-{rounds}\")",
            "\tverdict = parse_verdict((await settle_one(reviewing)).answer_preview)",
            "",
            "Step 4 — save the loop ledger, spawn the resident monitoring child with the exact prompt below, and tear it down:",
            "",
            &format!("json.dump({{\"fix_answers\": fix_answers, \"rounds\": rounds}}, open(r\"{ledger_path}\", \"w\"))"),
            "monitoring = await rlm.spawn(\"\"\"",
            &format!("\t{}", indent(&build_pr_monitoring_prompt())),
            "\t\"\"\", name=\"pr-monitoring\")",
            "await rlm.delete_subagent(monitoring.rlm_child_id)",
            "",
            "Step 5 — output exactly one line and nothing else:",
            "",
            "ANSWER: APPROVED: <yes if the final verdict says approved true, otherwise no>; DEFECTS: <every audit id from the fix answers, comma-separated>; ROUNDS: <the review rounds run>; STOPPED: monitoring",
        ]
        .join("\n"),
        ReferenceFactoryKind::ReviewSweepFail | ReferenceFactoryKind::DryRunReject => {
            unreachable!("no baseline exists for the probe factories (factory arm only)")
        }
    }
}

// ---------------------------------------------------------------------------
// Answer parsing and task-success checking.
// ---------------------------------------------------------------------------

/// The parsed ANSWER line from the parent's final assistant text.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ParsedAnswer {
    #[serde(default)]
    pub issues: Vec<String>,
    #[serde(default)]
    pub markers: Vec<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub stopped: Vec<String>,
    #[serde(default)]
    pub failed_node: Option<String>,
    #[serde(default)]
    pub report_status: Option<String>,
    #[serde(default)]
    pub rejected: Option<bool>,
    #[serde(default)]
    pub children: Option<u64>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub approved: Option<bool>,
    #[serde(default)]
    pub defects: Vec<String>,
    #[serde(default)]
    pub rounds: Option<u64>,
}

/// Parse the single ANSWER line from the parent's final assistant text.
#[must_use]
pub fn parse_answer_line(text: Option<&str>) -> Option<ParsedAnswer> {
    let text = text?;
    // The TS regex: /ANSWER:\s*(.+?)(?:\r?\n|$)/i — case-insensitive, the
    // first ANSWER-prefixed line.
    let line = text.lines().find(|line| {
        line.to_ascii_lowercase()
            .trim_start()
            .starts_with("answer:")
    })?;
    let rest = line
        .split_once(':')
        .map(|(_, rest)| rest)
        .unwrap_or_default();
    let rest = rest.trim();
    if rest.is_empty() {
        return None;
    }
    let mut parsed = ParsedAnswer::default();
    let list = |value: &str| -> Vec<String> {
        value
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect()
    };
    for part in rest.split(';') {
        let Some((key, value)) = part.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_uppercase();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        match key.as_str() {
            "ISSUES" => parsed.issues = list(value),
            "MARKERS" => parsed.markers = list(value),
            "STATE" => parsed.state = Some(value.to_string()),
            "STOPPED" => parsed.stopped = list(value),
            "FAILED-NODE" => parsed.failed_node = Some(value.to_string()),
            "REPORT-STATUS" => parsed.report_status = Some(value.to_string()),
            "REJECTED" => parsed.rejected = Some(value.eq_ignore_ascii_case("yes")),
            "CHILDREN" => parsed.children = value.parse::<u64>().ok(),
            "MESSAGE" => parsed.message = Some(value.to_string()),
            "APPROVED" => parsed.approved = Some(value.eq_ignore_ascii_case("yes")),
            "DEFECTS" => parsed.defects = list(value),
            "ROUNDS" => parsed.rounds = value.parse::<u64>().ok(),
            _ => {}
        }
    }
    Some(parsed)
}

/// Parse the last fenced JSON block in a captured answer preview; `None`
/// when absent or malformed. Multi-line fenced objects parse (the accepted
/// review fix for the TS-era `.*?` non-dotAll miss): a pretty-printed
/// verdict is a valid verdict.
#[must_use]
pub fn parse_fenced_json(text: &str) -> Option<Map<String, Value>> {
    let mut last: Option<&str> = None;
    let mut rest = text;
    while let Some(start) = rest.find("```json") {
        rest = &rest[start + "```json".len()..];
        let end = rest.find("```");
        let (block, remaining) = match end {
            Some(end) => (&rest[..end], &rest[end + 3..]),
            // An unterminated fence runs to the end of the answer.
            None => (rest, ""),
        };
        let block = block.trim();
        if !block.is_empty() {
            last = Some(block);
        }
        rest = remaining;
    }
    let block = last?;
    let parsed: Value = serde_json::from_str(block).ok()?;
    parsed.as_object().cloned()
}

/// The event-kind vocabulary the replay checker accepts (the executor's
/// ledger kinds, machine form included).
pub const KNOWN_FACTORY_EVENT_KINDS: &[&str] = &[
    "run_started",
    "node_ready",
    "state_entry",
    "transition_fired",
    "transition_blocked",
    "wait_settled",
    "spawned",
    "spawn_backoff",
    "spawn_deferred",
    "settled",
    "answer_captured",
    "retry",
    "node_error",
    "node_cancelled",
    "cancelled",
    "cancel_failed",
    "milestone",
    "run_stopped",
    "resumed",
    "executor_error",
];

const KNOWN_STAGES: &[&str] = &["recorded", "arrived", "shown", "delivered"];
const LEDGER_STATES: &[&str] = &["running", "stopping", "paused", "done", "failed", "stopped"];
const INSTANCE_ID_PATTERN: fn(&str) -> bool = |id: &str| {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
};

/// The result of one replay check: the problems it found (empty = ok).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LedgerCheckResult {
    pub ok: bool,
    pub problems: Vec<String>,
}

fn is_ledger_shape(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    let run_id = obj.get("run_id").and_then(Value::as_str);
    let spec_id = obj.get("spec_id").and_then(Value::as_str);
    let state = obj.get("state").and_then(Value::as_str);
    let nodes = obj.get("nodes").and_then(Value::as_array);
    let events = obj.get("events").and_then(Value::as_array);
    let elapsed = obj.get("elapsed_ms").and_then(Value::as_i64);
    let usage = obj.get("usage");
    run_id.is_some_and(|id| !id.is_empty())
        && spec_id.is_some_and(|id| !id.is_empty())
        && state.is_some_and(|state| LEDGER_STATES.contains(&state))
        && nodes.is_some_and(|nodes| !nodes.is_empty())
        && events.is_some()
        && elapsed.is_some_and(|elapsed| elapsed >= 0)
        && usage.is_some_and(Value::is_object)
}

/// Deterministic replay check over one saved status ledger: stable event
/// identities (contiguous seq, closed kind/stage vocabularies, valid node
/// refs) and complete resource accounting (every spawned instance settled
/// with a duration, cancelled, or still in flight on a paused run; usage
/// counts match the event stream). Machine-form ledgers add the
/// `state_entry` contiguity, transition endpoint, wait-settled, and
/// `transitions_fired` rules.
///
/// # Panics
///
/// Panics only on internal shape violations that the leading shape check
/// already ruled out (the `expect` calls sit behind `is_ledger_shape`).
#[must_use]
pub fn check_replay_ledger(ledger: &Value) -> LedgerCheckResult {
    let mut problems: Vec<String> = Vec::new();
    if !is_ledger_shape(ledger) {
        return LedgerCheckResult {
            ok: false,
            problems: vec!["ledger does not match the factory status shape".to_string()],
        };
    }
    let nodes = ledger["nodes"].as_array().expect("checked shape");
    let state = ledger["state"].as_str().expect("checked shape");
    let mut node_ids: Vec<String> = Vec::new();
    for node in nodes {
        let Some(id) = node.get("id").and_then(Value::as_str) else {
            problems.push("ledger node has an invalid id: null".to_string());
            continue;
        };
        if !INSTANCE_ID_PATTERN(id) {
            problems.push(format!("ledger node has an invalid id: {id:?}"));
        } else if node_ids.iter().any(|known| known == id) {
            problems.push(format!("ledger duplicates node id {id}"));
        }
        node_ids.push(id.to_string());
    }
    let node_exists = |id: &str| node_ids.iter().any(|known| known == id);

    let mut truncated = false;
    let mut last_seq: i64 = 0;
    let mut spawned: BTreeMap<String, i64> = BTreeMap::new();
    let mut spawned_per_node: BTreeMap<String, i64> = BTreeMap::new();
    let mut settled: BTreeMap<String, i64> = BTreeMap::new();
    let mut cancelled: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut state_entries: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    let mut wait_settled_nodes: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();
    let mut milestones: Vec<String> = Vec::new();
    let mut run_stopped = false;
    let mut transitions_fired: i64 = 0;
    let events = ledger["events"].as_array().expect("checked shape");
    for (index, event) in events.iter().enumerate() {
        let Some(event) = event.as_object() else {
            problems.push(format!("events[{index}] is not an object"));
            continue;
        };
        let seq = event.get("seq").and_then(Value::as_i64);
        let Some(seq) = seq else {
            problems.push(format!("events[{index}] has a non-increasing seq: null"));
            continue;
        };
        if seq <= last_seq {
            problems.push(format!("events[{index}] has a non-increasing seq: {seq}"));
            continue;
        }
        if seq != last_seq + 1 {
            problems.push(format!(
                "events[{index}] has a seq gap: expected {}, got {seq} (dropped event)",
                last_seq + 1
            ));
        }
        if index == 0 && seq != 1 {
            truncated = true;
        }
        last_seq = seq;
        let kind = event
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !KNOWN_FACTORY_EVENT_KINDS.contains(&kind) {
            problems.push(format!("events[{index}] has an unknown kind: {kind:?}"));
        }
        if let Some(stage) = event.get("stage").and_then(Value::as_str) {
            if !KNOWN_STAGES.contains(&stage) {
                problems.push(format!("events[{index}] has an unknown stage: {stage:?}"));
            }
        }
        if let Some(node) = event.get("node").and_then(Value::as_str) {
            if !node_exists(node) {
                problems.push(format!("events[{index}] references unknown node {node:?}"));
            }
        }
        if kind == "transition_fired" || kind == "transition_blocked" {
            // The executor always emits both endpoints; absence is drift.
            match (
                event.get("from").and_then(Value::as_str),
                event.get("to").and_then(Value::as_str),
            ) {
                (Some(from), Some(to)) => {
                    if !node_exists(from) {
                        problems.push(format!(
                            "events[{index}] transitions from unknown state {from:?}"
                        ));
                    }
                    if !node_exists(to) {
                        problems.push(format!(
                            "events[{index}] transitions to unknown state {to:?}"
                        ));
                    }
                }
                _ => problems.push(format!(
                    "events[{index}] {kind} requires from and to states"
                )),
            }
        }
        if kind == "state_entry" {
            let node = event.get("node").and_then(Value::as_str);
            let entry = event.get("entry").and_then(Value::as_i64);
            match (node, entry) {
                (Some(node), Some(entry)) if node_exists(node) && entry >= 0 => {
                    state_entries
                        .entry(node.to_string())
                        .or_default()
                        .push(entry);
                }
                (Some(node), _) if node_exists(node) => {
                    problems.push(format!(
                        "events[{index}] state_entry requires a non-negative integer entry index"
                    ));
                    let _ = node;
                }
                _ => problems.push(format!(
                    "events[{index}] state_entry references unknown node {}",
                    node.map(str::to_string)
                        .map_or_else(|| "null".to_string(), |n| format!("{n:?}"))
                )),
            }
        }
        if kind == "wait_settled" {
            if let Some(node) = event.get("node").and_then(Value::as_str) {
                wait_settled_nodes.insert(node.to_string());
            }
        }
        let instance = event.get("instance").and_then(Value::as_i64).unwrap_or(-1);
        let node = event.get("node").and_then(Value::as_str);
        let key = node.map(|node| format!("{node}#{instance}"));
        match kind {
            "transition_fired" => transitions_fired += 1,
            "spawned" => {
                if let Some(key) = &key {
                    *spawned.entry(key.clone()).or_insert(0) += 1;
                }
                if let Some(node) = node {
                    *spawned_per_node.entry(node.to_string()).or_insert(0) += 1;
                }
            }
            "settled" => {
                if let Some(key) = &key {
                    *settled.entry(key.clone()).or_insert(0) += 1;
                }
                let status = event.get("status").and_then(Value::as_str);
                if status == Some("done") {
                    let duration = event.get("duration_ms").and_then(Value::as_i64);
                    if duration.is_none_or(|duration| duration < 0) {
                        problems.push(format!(
                            "events[{index}] settles done without a duration_ms"
                        ));
                    }
                }
                if status == Some("error") && event.get("error").and_then(Value::as_str).is_none() {
                    problems.push(format!(
                        "events[{index}] settles error without an error message"
                    ));
                }
                if let Some(status) = status {
                    if !matches!(status, "done" | "error") {
                        problems.push(format!(
                            "events[{index}] has an invalid settled status: {status:?}"
                        ));
                    }
                }
            }
            "cancelled" => {
                if let Some(key) = &key {
                    cancelled.insert(key.clone());
                }
            }
            "milestone" => {
                if let Some(milestone) = event.get("milestone").and_then(Value::as_str) {
                    milestones.push(milestone.to_string());
                }
            }
            "run_stopped" => run_stopped = true,
            _ => {}
        }
    }
    if truncated {
        problems.push(
            "event window is truncated (first seq is not 1); count assertions skipped".to_string(),
        );
    }

    if !truncated {
        // A wait state never spawns: a node with wait_settled events must
        // have zero spawned instances in the whole ledger.
        for node_id in &wait_settled_nodes {
            let spawned = spawned_per_node.get(node_id).copied().unwrap_or(0);
            if spawned > 0 {
                problems.push(format!(
                    "node {node_id} settled a wait but spawned {spawned} instance(s)"
                ));
            }
        }
        // state_entry indices are contiguous 0..n-1 per state and match the
        // node's entries report (a gap means a dropped or forged event).
        for node in nodes {
            let Some(id) = node.get("id").and_then(Value::as_str) else {
                continue;
            };
            let mut indices = state_entries.get(id).cloned().unwrap_or_default();
            indices.sort_unstable();
            let contiguous = indices
                .iter()
                .enumerate()
                .all(|(position, entry)| *entry == position as i64);
            if !contiguous {
                problems.push(format!(
                    "node {id} state_entry indices are not contiguous 0..n-1: {indices:?}"
                ));
            }
            if let Some(entries) = node.get("entries").and_then(Value::as_array) {
                let mut reported: Vec<i64> = entries
                    .iter()
                    .filter_map(|entry| entry.get("index").and_then(Value::as_i64))
                    .collect();
                reported.sort_unstable();
                if reported != indices {
                    problems.push(format!(
                        "node {id} entries {reported:?} do not match its state_entry events {indices:?}"
                    ));
                }
            }
        }
    }

    if !truncated {
        // Complete resource accounting per instance.
        let in_flight_ok = matches!(state, "paused" | "running" | "stopping");
        for node in nodes {
            let Some(id) = node.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(instances) = node.get("instances").and_then(Value::as_array) else {
                continue;
            };
            for instance in instances {
                let index = instance.get("index").and_then(Value::as_i64).unwrap_or(-1);
                let key = format!("{id}#{index}");
                let has_spawn = spawned.get(&key).copied().unwrap_or(0) > 0;
                let settle_count = settled.get(&key).copied().unwrap_or(0);
                let status = instance
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match status {
                    "done" => {
                        if settle_count == 0 {
                            problems.push(format!(
                                "node {id} instance {index} is done without a settle event"
                            ));
                        } else {
                            let duration = instance.get("duration_ms").and_then(Value::as_i64);
                            if duration.is_none_or(|duration| duration < 0) {
                                problems.push(format!(
                                    "node {id} instance {index} is done without a duration_ms"
                                ));
                            }
                        }
                    }
                    "error" => {
                        if settle_count == 0 {
                            problems.push(format!(
                                "node {id} instance {index} errored without a settle event"
                            ));
                        } else {
                            let error = instance.get("error").and_then(Value::as_str);
                            if error.is_none_or(str::is_empty) {
                                problems.push(format!(
                                    "node {id} instance {index} errored without an error message"
                                ));
                            }
                        }
                        if has_spawn && instance.get("duration_ms").is_none() {
                            problems.push(format!(
                                "node {id} instance {index} errored after spawn without a duration_ms"
                            ));
                        }
                    }
                    "cancelled" => {
                        if !cancelled.contains(&key) {
                            problems.push(format!(
                                "node {id} instance {index} is cancelled without a cancel event"
                            ));
                        }
                    }
                    "running" | "pending" if !in_flight_ok => {
                        problems.push(format!(
                            "node {id} instance {index} is {status} in a {state} ledger"
                        ));
                    }
                    _ => {}
                }
            }
        }
        for (key, count) in &spawned {
            let settled_count = settled.get(key).copied().unwrap_or(0);
            if settled_count == 0 && !cancelled.contains(key) {
                let node_id = key.split('#').next().unwrap_or_default();
                let still_in_flight = in_flight_ok
                    && nodes.iter().any(|node| {
                        node.get("id").and_then(Value::as_str) == Some(node_id)
                            && node.get("instances").and_then(Value::as_array).is_some_and(
                                |instances| {
                                    instances.iter().any(|instance| {
                                        let index = instance
                                            .get("index")
                                            .and_then(Value::as_i64)
                                            .unwrap_or(-1);
                                        format!("{node_id}#{index}") == *key
                                            && matches!(
                                                instance.get("status").and_then(Value::as_str),
                                                Some("pending" | "running")
                                            )
                                    })
                                },
                            )
                    });
                if !still_in_flight {
                    problems.push(format!(
                        "spawned instance {key} never settled or cancelled ({count} spawn event(s))"
                    ));
                }
            }
        }
        // Admission failures settle without a spawn; every other settle must
        // follow a spawn.
        for (key, count) in &settled {
            if spawned.get(key).copied().unwrap_or(0) == 0 && *count > 0 {
                let node_id = key.split('#').next().unwrap_or_default();
                let admission_failure = nodes.iter().any(|node| {
                    node.get("id").and_then(Value::as_str) == Some(node_id)
                        && node.get("instances").and_then(Value::as_array).is_some_and(
                            |instances| {
                                instances.iter().any(|instance| {
                                    let index =
                                        instance.get("index").and_then(Value::as_i64).unwrap_or(-1);
                                    format!("{node_id}#{index}") == *key
                                        && instance.get("status").and_then(Value::as_str)
                                            == Some("error")
                                })
                            },
                        )
                });
                if !admission_failure {
                    problems.push(format!("instance {key} settled without ever being spawned"));
                }
            }
        }
        let spawn_events: i64 = spawned.values().sum();
        // Count settled EVENTS on spawned keys, not distinct keys: a
        // retried instance settles twice on the same key and the executor's
        // settle_count increments per settlement (including retries).
        let collect_settles: i64 = settled
            .iter()
            .filter(|(key, _)| spawned.get(*key).copied().unwrap_or(0) > 0)
            .map(|(_, count)| *count)
            .sum();
        let usage_spawns = ledger["usage"]["spawns"].as_i64().unwrap_or(-1);
        if usage_spawns != spawn_events {
            problems.push(format!(
                "usage.spawns {usage_spawns} does not match {spawn_events} spawned event(s)"
            ));
        }
        let usage_settled = ledger["usage"]["settled"].as_i64().unwrap_or(-1);
        if usage_settled != collect_settles {
            problems.push(format!(
                "usage.settled {usage_settled} does not match {collect_settles} collect settlement(s)"
            ));
        }
        if let Some(usage_transitions) = ledger["usage"]["transitions_fired"].as_i64() {
            if usage_transitions != transitions_fired {
                problems.push(format!(
                    "usage.transitions_fired {usage_transitions} does not match {transitions_fired} transition_fired event(s)"
                ));
            }
        }
    }

    // Run-state milestone identities.
    if !truncated {
        if state == "done" && !milestones.iter().any(|milestone| milestone == "finished") {
            problems.push("run state done without a finished milestone".to_string());
        }
        if state == "failed" && !milestones.iter().any(|milestone| milestone == "failed") {
            problems.push("run state failed without a failed milestone".to_string());
        }
        if state == "paused"
            && !milestones.iter().any(|milestone| {
                matches!(
                    milestone.as_str(),
                    "paused" | "budget_exceeded" | "max_transitions_exceeded"
                )
            })
        {
            problems.push(
                "run state paused without a paused, budget_exceeded, or max_transitions_exceeded milestone"
                    .to_string(),
            );
        }
        if state == "stopped" && !run_stopped {
            problems.push("run state stopped without a run_stopped event".to_string());
        }
    }
    LedgerCheckResult {
        ok: problems.is_empty(),
        problems,
    }
}

/// Run the replay check over a saved `report.json` or a single status
/// ledger. A report written by [`serialize_eval_report`] carries its
/// trials under `results`; the older hand-built `trials` key is still
/// accepted.
#[must_use]
pub fn run_replay_checks(data: &Value) -> ReplayOutcome {
    let mut ledgers: Vec<ReplayLedgerOutcome> = Vec::new();
    let trials = data
        .get("results")
        .and_then(Value::as_array)
        .or_else(|| data.get("trials").and_then(Value::as_array));
    if let Some(trials) = trials {
        for trial in trials {
            let Some(trial) = trial.as_object() else {
                continue;
            };
            let Some(ledger) = trial.get("ledger") else {
                continue;
            };
            if ledger.is_null() {
                continue;
            }
            let id = format!(
                "{}/{}/trial-{}",
                trial.get("factory").and_then(Value::as_str).unwrap_or("?"),
                trial.get("arm").and_then(Value::as_str).unwrap_or("?"),
                trial.get("trial").and_then(Value::as_i64).unwrap_or(-1)
            );
            let result = check_replay_ledger(ledger);
            ledgers.push(ReplayLedgerOutcome { id, result });
        }
    } else {
        let result = check_replay_ledger(data);
        ledgers.push(ReplayLedgerOutcome {
            id: "ledger".to_string(),
            result,
        });
    }
    let ok = !ledgers.is_empty() && ledgers.iter().all(|entry| entry.result.ok);
    ReplayOutcome { ok, ledgers }
}

/// The outcome of [`run_replay_checks`]: one entry per checked ledger.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplayLedgerOutcome {
    pub id: String,
    pub result: LedgerCheckResult,
}

/// The folded replay outcome.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplayOutcome {
    pub ok: bool,
    pub ledgers: Vec<ReplayLedgerOutcome>,
}

// ---------------------------------------------------------------------------
// Task-success checking (checkable answers + ledger cross-checks).
// ---------------------------------------------------------------------------

/// Which arm a task check scores.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EvalArm {
    Factory,
    Baseline,
}

impl EvalArm {
    /// The report row token.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Factory => "factory",
            Self::Baseline => "baseline",
        }
    }
}

/// Join the baseline collect dump's values into one searchable text; `None`
/// when the dump is absent. Strings, numbers, and arrays join recursively
/// (the accepted review fix: the pr-manager dump's `fix_answers` array must
/// contribute its answers, and a numeric field like `rounds` cross-checks),
/// so a planted id the children never reported cannot hide inside an array.
#[must_use]
fn baseline_ledger_text(baseline_ledger: Option<&Value>) -> Option<String> {
    fn walk(value: &Value, parts: &mut Vec<String>) {
        match value {
            Value::String(text) => parts.push(text.clone()),
            Value::Number(number) => parts.push(number.to_string()),
            Value::Array(items) => items.iter().for_each(|item| walk(item, parts)),
            _ => {}
        }
    }
    let baseline = baseline_ledger?.as_object()?;
    let mut parts: Vec<String> = Vec::new();
    baseline.values().for_each(|value| walk(value, &mut parts));
    Some(parts.join("\n"))
}

/// Whether `marker` appears in `text` as a whole token: `swb-marker-1`
/// must not count as present merely because `swb-marker-10` carries it as
/// a prefix — the ledger cross-check exists to catch a claimed marker the
/// children never produced, so a substring hit of a different builder's
/// marker is a false pass, not a pass.
fn contains_marker(text: &str, marker: &str) -> bool {
    let mut rest = text;
    while let Some(position) = rest.find(marker) {
        let after = &rest[position + marker.len()..];
        if after
            .chars()
            .next()
            .is_none_or(|next| !next.is_ascii_alphanumeric())
        {
            return true;
        }
        rest = &rest[position + 1..];
    }
    false
}

fn ledger_node<'a>(ledger: Option<&'a Value>, id: &str) -> Option<&'a Value> {
    let ledger = ledger?;
    let nodes = ledger.get("nodes")?.as_array()?;
    nodes
        .iter()
        .find(|node| node.get("id").and_then(Value::as_str) == Some(id))
}

/// Check the parent's ANSWER against the factory's checkable answer. The
/// factory arm cross-checks the saved status ledger; the baseline arm
/// instead cross-checks the parent's own collect dump against the ANSWER
/// ids, so a baseline trial cannot pass on a self-reported ANSWER the
/// children never produced.
#[must_use]
pub fn check_task_success(
    factory: &ReferenceFactory,
    answer: Option<&ParsedAnswer>,
    ledger: Option<&Value>,
    arm: EvalArm,
    baseline_ledger: Option<&Value>,
) -> TaskCheckOutcome {
    let mut problems: Vec<String> = Vec::new();
    let Some(answer) = answer else {
        return TaskCheckOutcome {
            ok: false,
            problems: vec!["no ANSWER line in the parent's final text".to_string()],
        };
    };
    let baseline = arm == EvalArm::Baseline;
    let width = factory.width.unwrap_or(DEFAULT_WIDTH);
    let ledger_text = baseline
        .then(|| baseline_ledger_text(baseline_ledger))
        .flatten();
    match factory.kind {
        ReferenceFactoryKind::ReviewSweep => {
            for issue_id in review_issue_ids() {
                if !answer.issues.iter().any(|known| known == issue_id) {
                    problems.push(format!(
                        "planted issue {issue_id} missing from the ANSWER line"
                    ));
                }
            }
            if baseline {
                match &ledger_text {
                    None => problems.push(
                        "baseline collect ledger missing (cannot verify the ANSWER against the children)"
                            .to_string(),
                    ),
                    Some(text) => {
                        for issue_id in review_issue_ids() {
                            if !text.contains(issue_id) {
                                problems.push(format!(
                                    "planted issue {issue_id} missing from the baseline collect ledger"
                                ));
                            }
                        }
                        for issue_id in &answer.issues {
                            if !text.contains(issue_id) {
                                problems.push(format!(
                                    "ANSWER issue {issue_id} is not present in the baseline collect ledger"
                                ));
                            }
                        }
                    }
                }
            } else {
                if answer.state.as_deref() != Some("done") {
                    problems.push(format!(
                        "ANSWER state is {}, expected done",
                        answer.state.as_deref().unwrap_or("unset")
                    ));
                }
                if let Some(ledger) = ledger {
                    if ledger["state"].as_str() != Some("done") {
                        problems.push(format!(
                            "ledger state is {}, expected done",
                            ledger["state"].as_str().unwrap_or("unset")
                        ));
                    }
                    let report = ledger_node(Some(ledger), "report");
                    if report
                        .and_then(|node| node.get("status"))
                        .and_then(Value::as_str)
                        != Some("done")
                    {
                        problems.push("ledger report node is not done".to_string());
                    }
                    for issue_id in review_issue_ids() {
                        if !report
                            .and_then(|node| node.get("answer_preview"))
                            .and_then(Value::as_str)
                            .is_some_and(|text| text.contains(issue_id))
                        {
                            problems.push(format!(
                                "planted issue {issue_id} missing from the report node answer preview"
                            ));
                        }
                    }
                }
            }
        }
        ReferenceFactoryKind::Builder => {
            let markers: Vec<String> = (1..=width).map(builder_marker).collect();
            for marker in &markers {
                if !answer.markers.contains(marker) {
                    problems.push(format!("{marker} missing from the ANSWER line"));
                }
            }
            if baseline {
                match &ledger_text {
                    None => problems.push(
                        "baseline collect ledger missing (cannot verify the ANSWER against the children)"
                            .to_string(),
                    ),
                    Some(text) => {
                        for marker in &markers {
                            if !contains_marker(text, marker) {
                                problems.push(format!("{marker} missing from the baseline collect ledger"));
                            }
                        }
                        for marker in &answer.markers {
                            if !contains_marker(text, marker) {
                                problems.push(format!(
                                    "ANSWER marker {marker} is not present in the baseline collect ledger"
                                ));
                            }
                        }
                    }
                }
            } else {
                if answer.state.as_deref() != Some("done") {
                    problems.push(format!(
                        "ANSWER state is {}, expected done",
                        answer.state.as_deref().unwrap_or("unset")
                    ));
                }
                if let Some(ledger) = ledger {
                    if ledger["state"].as_str() != Some("done") {
                        problems.push(format!(
                            "ledger state is {}, expected done",
                            ledger["state"].as_str().unwrap_or("unset")
                        ));
                    }
                    let collector = ledger_node(Some(ledger), "collector");
                    if collector
                        .and_then(|node| node.get("status"))
                        .and_then(Value::as_str)
                        != Some("done")
                    {
                        problems.push("ledger collector node is not done".to_string());
                    }
                    for marker in &markers {
                        if !collector
                            .and_then(|node| node.get("answer_preview"))
                            .and_then(Value::as_str)
                            .is_some_and(|text| contains_marker(text, marker))
                        {
                            problems.push(format!(
                                "{marker} missing from the collector answer preview"
                            ));
                        }
                    }
                }
            }
        }
        ReferenceFactoryKind::ResidentWatcher => {
            for marker in [TASK_MARKER_A, TASK_MARKER_B] {
                if !answer.markers.iter().any(|known| known == marker) {
                    problems.push(format!("{marker} missing from the ANSWER line"));
                }
            }
            if !answer.stopped.iter().any(|known| known == "watcher") {
                problems.push("ANSWER does not report the resident watcher as stopped".to_string());
            }
            if baseline {
                match &ledger_text {
                    None => problems.push(
                        "baseline collect ledger missing (cannot verify the ANSWER against the children)"
                            .to_string(),
                    ),
                    Some(text) => {
                        for marker in [TASK_MARKER_A, TASK_MARKER_B] {
                            if !text.contains(marker) {
                                problems.push(format!("{marker} missing from the baseline collect ledger"));
                            }
                        }
                        for marker in &answer.markers {
                            if !text.contains(marker) {
                                problems.push(format!(
                                    "ANSWER marker {marker} is not present in the baseline collect ledger"
                                ));
                            }
                        }
                    }
                }
            } else if let Some(ledger) = ledger {
                if ledger["state"].as_str() != Some("stopped") {
                    problems.push(format!(
                        "ledger state is {}, expected stopped",
                        ledger["state"].as_str().unwrap_or("unset")
                    ));
                }
                // The parent prompt names both step markers, so a
                // hallucinated ANSWER would pass on node status alone; each
                // task's marker must appear in that task's own captured
                // answer, the same cross-check the builder arm runs on the
                // collector preview.
                for (id, marker) in [("task-a", TASK_MARKER_A), ("task-b", TASK_MARKER_B)] {
                    let node = ledger_node(Some(ledger), id);
                    if node
                        .and_then(|node| node.get("status"))
                        .and_then(Value::as_str)
                        != Some("done")
                    {
                        problems.push(format!("ledger {id} node is not done"));
                    }
                    if !node
                        .and_then(|node| node.get("answer_preview"))
                        .and_then(Value::as_str)
                        .is_some_and(|text| contains_marker(text, marker))
                    {
                        problems.push(format!("{marker} missing from the {id} answer preview"));
                    }
                }
                let watcher = ledger_node(Some(ledger), "watcher");
                if watcher
                    .and_then(|node| node.get("status"))
                    .and_then(Value::as_str)
                    != Some("cancelled")
                {
                    problems.push("ledger watcher node is not cancelled".to_string());
                }
                let watcher_cancelled = watcher
                    .and_then(|node| node.get("instances"))
                    .and_then(Value::as_array)
                    .is_some_and(|instances| {
                        instances.iter().any(|instance| {
                            instance.get("status").and_then(Value::as_str) == Some("cancelled")
                        })
                    });
                if !watcher_cancelled {
                    problems.push("ledger watcher instance is not cancelled".to_string());
                }
            }
        }
        ReferenceFactoryKind::PrManager => {
            if answer.approved != Some(true) {
                problems.push(format!(
                    "ANSWER approved is {}, expected yes",
                    answer
                        .approved
                        .map_or_else(|| "unset".to_string(), |approved| approved.to_string())
                ));
            }
            if answer.rounds != Some(2) {
                problems.push(format!(
                    "ANSWER rounds is {}, expected 2",
                    answer
                        .rounds
                        .map_or_else(|| "unset".to_string(), |rounds| rounds.to_string())
                ));
            }
            for issue_id in review_issue_ids() {
                if !answer.defects.iter().any(|known| known == issue_id) {
                    problems.push(format!(
                        "planted issue {issue_id} missing from the ANSWER line"
                    ));
                }
            }
            if !answer.stopped.iter().any(|known| known == "monitoring") {
                problems.push(
                    "ANSWER does not report the resident monitoring state as stopped".to_string(),
                );
            }
            if baseline {
                match &ledger_text {
                    None => problems.push(
                        "baseline collect ledger missing (cannot verify the ANSWER against the children)"
                            .to_string(),
                    ),
                    Some(text) => {
                        for issue_id in review_issue_ids() {
                            if !text.contains(issue_id) {
                                problems.push(format!(
                                    "planted issue {issue_id} missing from the baseline collect ledger"
                                ));
                            }
                        }
                        for issue_id in &answer.defects {
                            if !text.contains(issue_id) {
                                problems.push(format!(
                                    "ANSWER defect {issue_id} is not present in the baseline collect ledger"
                                ));
                            }
                        }
                        if let Some(rounds) = answer.rounds {
                            if !text.contains(&rounds.to_string()) {
                                problems.push(format!(
                                    "ANSWER rounds {rounds} is not present in the baseline collect ledger"
                                ));
                            }
                        }
                    }
                }
            } else if let Some(ledger) = ledger {
                if ledger["state"].as_str() != Some("stopped") {
                    problems.push(format!(
                        "ledger state is {}, expected stopped",
                        ledger["state"].as_str().unwrap_or("unset")
                    ));
                }
                let reviewing = ledger_node(Some(ledger), "reviewing");
                let fixing = ledger_node(Some(ledger), "fixing");
                let monitoring = ledger_node(Some(ledger), "monitoring");
                // rounds is the review-loop length: the reviewing state's
                // entries_used.
                if reviewing
                    .and_then(|node| node.get("entries_used"))
                    .and_then(Value::as_i64)
                    != Some(2)
                {
                    problems.push(format!(
                        "ledger reviewing entries_used is {}, expected 2",
                        reviewing
                            .and_then(|node| node.get("entries_used"))
                            .and_then(Value::as_i64)
                            .map_or_else(|| "unset".to_string(), |used| used.to_string())
                    ));
                }
                if fixing
                    .and_then(|node| node.get("entries_used"))
                    .and_then(Value::as_i64)
                    != Some(1)
                {
                    problems.push(format!(
                        "ledger fixing entries_used is {}, expected 1",
                        fixing
                            .and_then(|node| node.get("entries_used"))
                            .and_then(Value::as_i64)
                            .map_or_else(|| "unset".to_string(), |used| used.to_string())
                    ));
                }
                if reviewing
                    .and_then(|node| node.get("status"))
                    .and_then(Value::as_str)
                    != Some("done")
                {
                    problems.push("ledger reviewing state is not done".to_string());
                }
                // The final verdict must be a fenced json block (multi-line
                // objects parse: a pretty-printed verdict is a valid
                // verdict) with approved === true.
                let verdict_text = reviewing
                    .and_then(|node| node.get("answer_preview"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let approved = parse_fenced_json(verdict_text)
                    .as_ref()
                    .and_then(|object| object.get("verdict"))
                    .and_then(Value::as_object)
                    .and_then(|verdict| verdict.get("approved"))
                    .cloned();
                if approved != Some(Value::Bool(true)) {
                    problems.push("final reviewing verdict is not approved true".to_string());
                }
                if reviewing
                    .and_then(|node| node.get("max_entries"))
                    .and_then(Value::as_i64)
                    != Some(4)
                {
                    problems.push(format!(
                        "ledger reviewing max_entries is {}, expected 4",
                        reviewing
                            .and_then(|node| node.get("max_entries"))
                            .and_then(Value::as_i64)
                            .map_or_else(|| "unset".to_string(), |entries| entries.to_string())
                    ));
                }
                // The fix ledger: the fixing node's captured previews plus
                // every fixing answer_captured event must carry all planted
                // defect ids.
                let mut fix_texts: Vec<String> = vec![fixing
                    .and_then(|node| node.get("answer_preview"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()];
                if let Some(events) = ledger.get("events").and_then(Value::as_array) {
                    for event in events {
                        let is_fix_captured = event.get("kind").and_then(Value::as_str)
                            == Some("answer_captured")
                            && event.get("node").and_then(Value::as_str) == Some("fixing");
                        if is_fix_captured {
                            fix_texts.push(
                                event
                                    .get("answer")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                            );
                        }
                    }
                }
                let fix_text = fix_texts.join("\n");
                for issue_id in review_issue_ids() {
                    if !fix_text.contains(issue_id) {
                        problems.push(format!(
                            "planted issue {issue_id} missing from the fixing ledger"
                        ));
                    }
                }
                if monitoring
                    .and_then(|node| node.get("lifecycle"))
                    .and_then(Value::as_str)
                    != Some("resident")
                {
                    problems.push("ledger monitoring state is not resident".to_string());
                }
                if monitoring
                    .and_then(|node| node.get("status"))
                    .and_then(Value::as_str)
                    != Some("cancelled")
                {
                    problems.push("ledger monitoring state is not cancelled".to_string());
                }
            }
        }
        ReferenceFactoryKind::ReviewSweepFail => {
            if answer.state.as_deref() != Some("paused") {
                problems.push(format!(
                    "ANSWER state is {}, expected paused",
                    answer.state.as_deref().unwrap_or("unset")
                ));
            }
            if answer.failed_node.as_deref() != Some("review-broken") {
                problems.push(format!(
                    "ANSWER failed node is {}, expected review-broken",
                    answer.failed_node.as_deref().unwrap_or("unset")
                ));
            }
            if answer.report_status.as_deref() != Some("pending") {
                problems.push(format!(
                    "ANSWER report status is {}, expected pending",
                    answer.report_status.as_deref().unwrap_or("unset")
                ));
            }
            if let Some(ledger) = ledger {
                if ledger["state"].as_str() != Some("paused") {
                    problems.push(format!(
                        "ledger state is {}, expected paused",
                        ledger["state"].as_str().unwrap_or("unset")
                    ));
                }
                let broken = ledger_node(Some(ledger), "review-broken");
                if broken
                    .and_then(|node| node.get("status"))
                    .and_then(Value::as_str)
                    != Some("error")
                {
                    problems.push("ledger review-broken node is not error".to_string());
                }
                if broken
                    .and_then(|node| node.get("error"))
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                {
                    problems.push("ledger review-broken node has no error message".to_string());
                }
                if ledger_node(Some(ledger), "report")
                    .and_then(|node| node.get("status"))
                    .and_then(Value::as_str)
                    != Some("pending")
                {
                    problems.push("ledger report node is not pending".to_string());
                }
                let report_started =
                    ledger
                        .get("events")
                        .and_then(Value::as_array)
                        .is_some_and(|events| {
                            events.iter().any(|event| {
                                event.get("kind").and_then(Value::as_str) == Some("spawned")
                                    && event.get("node").and_then(Value::as_str) == Some("report")
                            })
                        });
                if report_started {
                    problems.push("report node started despite the escalation pause".to_string());
                }
                let paused_milestone =
                    ledger
                        .get("events")
                        .and_then(Value::as_array)
                        .is_some_and(|events| {
                            events.iter().any(|event| {
                                event.get("kind").and_then(Value::as_str) == Some("milestone")
                                    && event.get("milestone").and_then(Value::as_str)
                                        == Some("paused")
                            })
                        });
                if !paused_milestone {
                    problems.push("ledger has no paused milestone".to_string());
                }
            }
        }
        ReferenceFactoryKind::DryRunReject => {
            if answer.rejected != Some(true) {
                problems.push("ANSWER does not report the run call as rejected".to_string());
            }
            if answer.children != Some(0) {
                problems.push(format!(
                    "ANSWER children count is {}, expected 0",
                    answer
                        .children
                        .map_or_else(|| "unset".to_string(), |children| children.to_string())
                ));
            }
            if !answer
                .message
                .as_deref()
                .is_some_and(|message| message.contains("no-such-subagent-entry"))
            {
                problems.push(
                    "ANSWER message does not mention the unknown subagent reference".to_string(),
                );
            }
        }
    }
    TaskCheckOutcome {
        ok: problems.is_empty(),
        problems,
    }
}

/// The outcome of one [`check_task_success`] call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskCheckOutcome {
    pub ok: bool,
    pub problems: Vec<String>,
}

// ---------------------------------------------------------------------------
// Trial result, verdicts, and report rendering.
// ---------------------------------------------------------------------------

/// A verdict that can be unknown: unmeasured lines are `Inconclusive`,
/// never a silent pass (the swarm-eval reporting precedent).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DefenseVerdict {
    Pass,
    Fail,
    Inconclusive,
}

impl DefenseVerdict {
    /// The lowercase wire/report token.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Fail => "fail",
            Self::Inconclusive => "inconclusive",
        }
    }
}

impl From<Option<bool>> for DefenseVerdict {
    fn from(value: Option<bool>) -> Self {
        match value {
            Some(true) => Self::Pass,
            Some(false) => Self::Fail,
            None => Self::Inconclusive,
        }
    }
}

/// One trial row of the eval report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactoryEvalTrialResult {
    pub factory: String,
    pub arm: EvalArm,
    pub trial: u64,
    pub model: String,
    pub task_success: bool,
    pub problems: Vec<String>,
    pub state: Option<String>,
    pub wall_ms: u64,
    pub context_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub declared_fan_in: u64,
    /// Omitted on this port: the executor's event ledger carries no
    /// timestamps (queue latency was omitted the same way in the TS-era
    /// harness).
    pub queue_latency_ms: Option<u64>,
    /// The factory-progress notice lane (finished notice -> final answer)
    /// is deliberately unported from the factory core port (#3199); the
    /// metric stays `None` until that lane lands.
    pub teardown_latency_ms: Option<u64>,
    pub declared_budget_ms: u64,
    pub budget_overshoot_ms: u64,
    pub elapsed_ms: Option<u64>,
    pub spawns: Option<u64>,
    pub settled: Option<u64>,
    pub replay_ok: Option<bool>,
    pub replay_problems: Vec<String>,
    pub answer: Option<ParsedAnswer>,
    pub ledger: Option<Value>,
    /// The folded trial verdict: task success, no problems, a clean replay
    /// (when one ran), and zero budget overshoot — an over-budget trial
    /// fails (the accepted review fix; the zero-overshoot verdict and the
    /// per-trial verdict cannot disagree).
    pub verdict: TrialVerdict,
}

/// The trial verdict: `fail` on any problem, `pass` only when the trial
/// scored clean; a thrown trial produces a failed row, never a missing
/// one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrialVerdict {
    Pass,
    Fail,
}

impl TrialVerdict {
    /// The report token.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::Fail => "fail",
        }
    }
}

impl FactoryEvalTrialResult {
    /// Build the factory-arm row from a scored trial.
    // The row carries every measured dimension of one trial (the TS-era row
    // had the same width); the inputs ARE the trial's outputs.
    #[allow(clippy::too_many_arguments)]
    pub fn factory_row(
        factory: &ReferenceFactory,
        trial: u64,
        model: &str,
        task_check: &TaskCheckOutcome,
        mut problems: Vec<String>,
        answer: Option<ParsedAnswer>,
        ledger: Option<Value>,
        replay: Option<&LedgerCheckResult>,
        wall_ms: u64,
        context_tokens: Option<u64>,
        total_tokens: Option<u64>,
    ) -> Self {
        let elapsed_ms = ledger
            .as_ref()
            .and_then(|ledger| ledger.get("elapsed_ms"))
            .and_then(Value::as_u64);
        // Factory arms use the run ledger's elapsed_ms against the declared
        // run budget. An absent ledger still folds as zero here — the row's
        // own budget gate must stay passable for the probe that never
        // writes a ledger (the dry-run probe, whose rejection IS the pass) —
        // but compute_verdicts treats the same absent elapsed_ms as
        // unmeasured, so the paired-arm budget verdict never passes on it.
        let budget_overshoot_ms = elapsed_ms.map_or(0, |elapsed| {
            elapsed.saturating_sub(factory.declared_budget_ms)
        });
        problems.extend(task_check.problems.iter().cloned());
        // The replay problems ride their own field (the renderer chains
        // row.problems with row.replay_problems, exactly like the TS-era
        // row split — merging them here would double-list every replay
        // problem in the report).
        let replay_ok = replay.as_ref().map(|replay| replay.ok);
        let verdict = if task_check.ok
            && problems.is_empty()
            && replay_ok.is_none_or(|ok| ok)
            && budget_overshoot_ms == 0
        {
            TrialVerdict::Pass
        } else {
            TrialVerdict::Fail
        };
        Self {
            factory: factory.kind.as_str().to_string(),
            arm: EvalArm::Factory,
            trial,
            model: model.to_string(),
            task_success: task_check.ok,
            problems,
            state: ledger
                .as_ref()
                .and_then(|ledger| ledger.get("state"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| answer.as_ref().and_then(|answer| answer.state.clone())),
            wall_ms,
            context_tokens,
            total_tokens,
            declared_fan_in: factory.declared_fan_in,
            queue_latency_ms: None,
            teardown_latency_ms: None,
            declared_budget_ms: factory.declared_budget_ms,
            budget_overshoot_ms,
            elapsed_ms,
            spawns: ledger
                .as_ref()
                .and_then(|ledger| ledger.get("usage"))
                .and_then(|usage| usage.get("spawns"))
                .and_then(Value::as_u64),
            settled: ledger
                .as_ref()
                .and_then(|ledger| ledger.get("usage"))
                .and_then(|usage| usage.get("settled"))
                .and_then(Value::as_u64),
            replay_ok,
            replay_problems: replay
                .as_ref()
                .map(|replay| replay.problems.clone())
                .unwrap_or_default(),
            answer,
            ledger,
            verdict,
        }
    }

    /// Build the baseline-arm row: the wall clock is the arm's overshoot
    /// upper bound against the same declared budget.
    // The row carries every measured dimension of one trial (the TS-era row
    // had the same width); the inputs ARE the trial's outputs.
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub fn baseline_row(
        factory: &ReferenceFactory,
        trial: u64,
        model: &str,
        task_check: &TaskCheckOutcome,
        problems: Vec<String>,
        answer: Option<ParsedAnswer>,
        wall_ms: u64,
        context_tokens: Option<u64>,
        total_tokens: Option<u64>,
    ) -> Self {
        let budget_overshoot_ms = wall_ms.saturating_sub(factory.declared_budget_ms);
        let verdict = if task_check.ok && problems.is_empty() {
            TrialVerdict::Pass
        } else {
            TrialVerdict::Fail
        };
        let mut problems = problems;
        problems.extend(task_check.problems.iter().cloned());
        Self {
            factory: factory.kind.as_str().to_string(),
            arm: EvalArm::Baseline,
            trial,
            model: model.to_string(),
            task_success: task_check.ok,
            problems,
            state: answer.as_ref().and_then(|answer| answer.state.clone()),
            wall_ms,
            context_tokens,
            total_tokens,
            declared_fan_in: factory.declared_fan_in,
            queue_latency_ms: None,
            teardown_latency_ms: None,
            declared_budget_ms: factory.declared_budget_ms,
            budget_overshoot_ms,
            elapsed_ms: None,
            spawns: None,
            settled: None,
            replay_ok: None,
            replay_problems: Vec::new(),
            answer,
            ledger: None,
            verdict,
        }
    }

    /// Build a failed row for a thrown trial (setup, prompt, or cleanup
    /// failure): the sweep can never cover a subset of its planned trials
    /// (the accepted review fix — a thrown trial is logged and counted,
    /// never swallowed).
    #[must_use]
    pub fn error_row(
        factory: &ReferenceFactory,
        arm: EvalArm,
        trial: u64,
        model: &str,
        error: &str,
        wall_ms: u64,
    ) -> Self {
        Self {
            factory: factory.kind.as_str().to_string(),
            arm,
            trial,
            model: model.to_string(),
            task_success: false,
            problems: vec![format!("trial error: {error}")],
            state: None,
            wall_ms,
            context_tokens: None,
            total_tokens: None,
            declared_fan_in: factory.declared_fan_in,
            queue_latency_ms: None,
            teardown_latency_ms: None,
            declared_budget_ms: factory.declared_budget_ms,
            budget_overshoot_ms: 0,
            elapsed_ms: None,
            spawns: None,
            settled: None,
            replay_ok: None,
            replay_problems: Vec::new(),
            answer: None,
            ledger: None,
            verdict: TrialVerdict::Fail,
        }
    }
}

/// The pre-registered verdict rules the report scores.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EvalVerdicts {
    pub no_orchestration_code: bool,
    pub failure_policy_matched: DefenseVerdict,
    pub dry_run_rejected: DefenseVerdict,
    pub budget_overshoot_ms: u64,
    pub budget_overshoot_zero: DefenseVerdict,
    pub context_pairs: Vec<ContextPair>,
}

/// One factory-vs-baseline context-token pair.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextPair {
    pub factory: String,
    pub factory_context_tokens: Option<u64>,
    pub baseline_context_tokens: Option<u64>,
    /// `None` (Inconclusive) when either arm is unmeasured.
    pub lower: Option<bool>,
    pub both_correct: bool,
}

/// Static prompt invariant, computed (not assumed): every factory parent
/// prompt orchestrates only through `rlm.factory.*` — no `rlm.spawn` or
/// `rlm.collect` call may leak into a factory parent prompt.
#[must_use]
pub fn check_no_orchestration_code(prompts: &[String]) -> bool {
    prompts
        .iter()
        .all(|prompt| !prompt.contains("rlm.spawn") && !prompt.contains("rlm.collect"))
}

/// The reference factories' parent prompts, the prompts the verdict checks.
#[must_use]
pub fn build_reference_parent_prompts(width: u64) -> Vec<String> {
    build_reference_factories(width)
        .iter()
        .map(|factory| build_factory_parent_prompt(factory, "/tmp/ledger.json"))
        .collect()
}

fn average_or_none(values: &[Option<u64>]) -> Option<u64> {
    let present: Vec<u64> = values.iter().filter_map(|value| *value).collect();
    if present.is_empty() {
        return None;
    }
    let sum = present.iter().sum::<u64>();
    Some((sum + present.len() as u64 / 2) / present.len() as u64)
}

/// Fold the pre-registered verdicts over the trial rows. The escalation and
/// dry-run probes never enter the budget sum; unrun probes report
/// `Inconclusive`, never a silent pass.
#[must_use]
pub fn compute_verdicts(
    results: &[FactoryEvalTrialResult],
    reference_prompts: Option<&[String]>,
) -> EvalVerdicts {
    let is_paired_factory = |row: &FactoryEvalTrialResult| {
        row.arm == EvalArm::Factory
            && row.factory != ReferenceFactoryKind::ReviewSweepFail.as_str()
            && row.factory != ReferenceFactoryKind::DryRunReject.as_str()
    };
    let factory_arms: Vec<&FactoryEvalTrialResult> = results
        .iter()
        .filter(|row| is_paired_factory(row))
        .collect();
    let escalation = results.iter().find(|row| {
        row.factory == ReferenceFactoryKind::ReviewSweepFail.as_str() && row.arm == EvalArm::Factory
    });
    let dry_run = results.iter().find(|row| {
        row.factory == ReferenceFactoryKind::DryRunReject.as_str() && row.arm == EvalArm::Factory
    });
    let budget_overshoot_ms: u64 = factory_arms.iter().map(|row| row.budget_overshoot_ms).sum();
    // A paired arm that never measured its run budget (a timed-out trial's
    // error row, or a completed trial whose ledger never carried an
    // elapsed_ms) has a missing overshoot, not a clean one: the gate below
    // reports Inconclusive instead of passing on a zero it never read —
    // the same never-a-silent-pass rule as the unrun probes.
    let budget_unmeasured = factory_arms.iter().any(|row| row.elapsed_ms.is_none());
    let mut context_pairs: Vec<ContextPair> = Vec::new();
    for kind in ReferenceFactoryKind::selections() {
        let factory_rows: Vec<&&FactoryEvalTrialResult> = factory_arms
            .iter()
            .filter(|row| row.factory == kind.as_str())
            .collect();
        let baseline_rows: Vec<&FactoryEvalTrialResult> = results
            .iter()
            .filter(|row| row.arm == EvalArm::Baseline && row.factory == kind.as_str())
            .collect();
        if factory_rows.is_empty() && baseline_rows.is_empty() {
            continue;
        }
        let factory_context = average_or_none(
            &factory_rows
                .iter()
                .map(|row| row.context_tokens)
                .collect::<Vec<_>>(),
        );
        let baseline_context = average_or_none(
            &baseline_rows
                .iter()
                .map(|row| row.context_tokens)
                .collect::<Vec<_>>(),
        );
        context_pairs.push(ContextPair {
            factory: kind.as_str().to_string(),
            factory_context_tokens: factory_context,
            baseline_context_tokens: baseline_context,
            lower: match (factory_context, baseline_context) {
                (Some(factory), Some(baseline)) => Some(factory < baseline),
                _ => None,
            },
            both_correct: factory_rows.iter().all(|row| row.task_success)
                && baseline_rows.iter().all(|row| row.task_success),
        });
    }
    let prompts = reference_prompts.map_or_else(
        || build_reference_parent_prompts(DEFAULT_WIDTH),
        <[String]>::to_vec,
    );
    EvalVerdicts {
        // Computed from the built prompts (check_no_orchestration_code),
        // not a constant.
        no_orchestration_code: check_no_orchestration_code(&prompts),
        failure_policy_matched: escalation.map_or(DefenseVerdict::Inconclusive, |row| {
            DefenseVerdict::from(Some(row.verdict == TrialVerdict::Pass))
        }),
        dry_run_rejected: dry_run.map_or(DefenseVerdict::Inconclusive, |row| {
            DefenseVerdict::from(Some(row.verdict == TrialVerdict::Pass))
        }),
        budget_overshoot_ms,
        budget_overshoot_zero: if factory_arms.is_empty() || budget_unmeasured {
            DefenseVerdict::Inconclusive
        } else {
            DefenseVerdict::from(Some(budget_overshoot_ms == 0))
        },
        context_pairs,
    }
}

fn render_defense_verdict(value: DefenseVerdict) -> &'static str {
    match value {
        DefenseVerdict::Pass => "(PASS)",
        DefenseVerdict::Fail => "(FAIL)",
        DefenseVerdict::Inconclusive => "(not run)",
    }
}

/// Render the markdown report: the trial table, the factory-vs-baseline
/// context pairs, the pre-registered verdict rules, and every problem.
#[must_use]
pub fn render_markdown_report(
    results: &[FactoryEvalTrialResult],
    config: &FactoryEvalConfig,
) -> String {
    let header = [
        "# Factory capability eval report".to_string(),
        String::new(),
        format!("- model: {}", config.model),
        format!(
            "- factories: {}  |  width: {}  |  trials per pair: {}",
            config
                .factories
                .iter()
                .map(|kind| kind.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            config.width,
            config.trials
        ),
        format!(
            "- declared budgets: run {RUN_BUDGET_MS} ms, per task node {NODE_BUDGET_MS} ms (same for each factory/baseline pair)"
        ),
        "- queue latency: omitted (the executor event ledger carries no timestamps)".to_string(),
        "- teardown latency: n/a on this port (the factory-progress notice lane is deliberately unported from the factory core port)".to_string(),
        "- budget overshoot is measured per arm and is not directly comparable*: factory arms use the run ledger's elapsed_ms against the declared run budget; baseline arms use full wall clock (an upper bound) against the same budget".to_string(),
        String::new(),
        "| factory | arm | trial | task | state | wall s | ctx tokens | total tokens | fan-in | teardown ms | over budget ms* | replay | verdict |".to_string(),
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |".to_string(),
    ];
    let rows: Vec<String> = results
        .iter()
        .map(|row| {
            let cells = [
                row.factory.clone(),
                row.arm.as_str().to_string(),
                row.trial.to_string(),
                if row.task_success {
                    "ok".to_string()
                } else {
                    "failed".to_string()
                },
                row.state.clone().unwrap_or_else(|| "n/a".to_string()),
                format!("{:.1}", row.wall_ms as f64 / 1000.0),
                row.context_tokens
                    .map_or_else(|| "n/a".to_string(), |tokens| tokens.to_string()),
                row.total_tokens
                    .map_or_else(|| "n/a".to_string(), |tokens| tokens.to_string()),
                row.declared_fan_in.to_string(),
                row.teardown_latency_ms
                    .map_or_else(|| "n/a".to_string(), |latency| latency.to_string()),
                row.budget_overshoot_ms.to_string(),
                match row.replay_ok {
                    None => "n/a".to_string(),
                    Some(true) => "ok".to_string(),
                    Some(false) => "failed".to_string(),
                },
                row.verdict.as_str().to_string(),
            ];
            format!("| {} |", cells.join(" | "))
        })
        .collect();
    let verdicts = compute_verdicts(results, None);
    let pairs: Vec<String> = verdicts
        .context_pairs
        .iter()
        .map(|pair| {
            format!(
                "| {} | {} | {} | {} | {} |",
                pair.factory,
                pair.factory_context_tokens
                    .map_or_else(|| "n/a".to_string(), |tokens| tokens.to_string()),
                pair.baseline_context_tokens
                    .map_or_else(|| "n/a".to_string(), |tokens| tokens.to_string()),
                match pair.lower {
                    None => "n/a".to_string(),
                    Some(true) => "yes".to_string(),
                    Some(false) => "no".to_string(),
                },
                if pair.both_correct { "yes" } else { "no" }
            )
        })
        .collect();
    let mut problems: Vec<String> = Vec::new();
    for row in results {
        for problem in row.problems.iter().chain(row.replay_problems.iter()) {
            problems.push(format!(
                "- {}/{}/trial {}: {problem}",
                row.factory,
                row.arm.as_str(),
                row.trial
            ));
        }
    }
    if problems.is_empty() {
        problems.push("- none".to_string());
    }
    let mut summary: Vec<String> = vec![
        String::new(),
        "## Factory vs hand-written baseline (parent context tokens)".to_string(),
        String::new(),
        "| factory | factory avg | baseline avg | lower | both task-correct |".to_string(),
        "| --- | --- | --- | --- | --- |".to_string(),
    ];
    summary.extend(pairs);
    summary.extend([
        String::new(),
        "## Verdict rules (Notion spec, Proposed evaluation)".to_string(),
        String::new(),
        format!(
            "- no task-specific orchestration code in factory prompts (computed from the built prompts): {}",
            if verdicts.no_orchestration_code { "PASS" } else { "FAIL" }
        ),
        format!(
            "- declared failure policy matches observed behavior (escalation): {}",
            render_defense_verdict(verdicts.failure_policy_matched)
        ),
        format!("- no node starts after a failed dry run: {}", render_defense_verdict(verdicts.dry_run_rejected)),
        format!(
            "- total budget overshoot (factory arms only): {} ms {}",
            verdicts.budget_overshoot_ms,
            render_defense_verdict(verdicts.budget_overshoot_zero)
        ),
        "- parent context lower than baseline: reported per pair above (informational, not asserted)".to_string(),
        String::new(),
        "## Problems".to_string(),
        String::new(),
    ]);
    summary.extend(problems);
    summary.push(String::new());
    header
        .into_iter()
        .chain(rows)
        .chain(summary)
        .collect::<Vec<_>>()
        .join("\n")
}

/// The exact object `report.json` is written from (the shape `--replay`
/// reads back).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalReportFile {
    pub config: FactoryEvalConfig,
    pub generated_at: String,
    pub results: Vec<FactoryEvalTrialResult>,
    pub verdicts: EvalVerdicts,
}

/// Build the report.json payload.
#[must_use]
pub fn serialize_eval_report(
    config: &FactoryEvalConfig,
    results: Vec<FactoryEvalTrialResult>,
    generated_at: &str,
) -> EvalReportFile {
    let verdicts = compute_verdicts(&results, None);
    EvalReportFile {
        config: config.clone(),
        generated_at: generated_at.to_string(),
        results,
        verdicts,
    }
}

// ---------------------------------------------------------------------------
// CLI parsing (the deterministic half of the driver's argument surface).
// ---------------------------------------------------------------------------

/// The eval configuration: the flags the driver runs with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FactoryEvalConfig {
    pub model: String,
    pub factories: Vec<ReferenceFactoryKind>,
    pub width: u64,
    pub trials: u64,
    pub timeout_minutes: u64,
    pub out_dir: String,
}

impl Default for FactoryEvalConfig {
    fn default() -> Self {
        Self {
            model: DEFAULT_MODEL.to_string(),
            factories: ReferenceFactoryKind::selections().to_vec(),
            width: DEFAULT_WIDTH,
            trials: 1,
            timeout_minutes: 20,
            out_dir: String::new(),
        }
    }
}

/// The CLI parser's failure modes.
#[derive(Debug, Clone, PartialEq)]
pub enum EvalArgsError {
    /// `--help` / `-h`: print the usage note, exit 0.
    Help,
    /// Any other parse failure: print the message, exit 1. A parse error
    /// must fail BEFORE any token is spent.
    Message(String),
}

/// Parse the driver's arguments. Integer flags accept only exactly
/// representable positive integers (integer parsing rejects the
/// TS-era `1e100`-style float spellings and out-of-range values, so a
/// huge trial count or timeout fails the parse instead of producing an
/// unbounded loop or an unusable budget), `--width` clamps to
/// [`MAX_WIDTH`], an unknown factory fails the parse (never silently
/// running the defaults), and an explicitly empty `--factories` value
/// fails too (the accepted review fix: `--factories ""` used to fall back
/// to the token-spending defaults).
///
/// # Errors
///
/// Returns [`EvalArgsError::Help`] for `--help`/`-h` and
/// [`EvalArgsError::Message`] for any invalid input.
pub fn parse_eval_args(argv: &[String]) -> Result<FactoryEvalConfig, EvalArgsError> {
    let mut config = FactoryEvalConfig::default();
    let mut index = 0;
    let take_value = |index: &mut usize, flag: &str| -> Result<String, EvalArgsError> {
        *index += 1;
        argv.get(*index)
            .cloned()
            .ok_or_else(|| EvalArgsError::Message(format!("Missing value for {flag}")))
    };
    // Integer flags accept only exactly representable positive integers
    // (integer parsing rejects the TS-era `1e100`-style float spellings and
    // out-of-range values, so a huge trial count or timeout fails the parse
    // instead of producing an unbounded loop or an unusable budget),
    // `--width` clamps to [`MAX_WIDTH`], an unknown factory fails the
    // parse (never silently running the defaults), and an explicitly empty
    // `--factories` value fails too (the accepted review fix:
    // `--factories ""` used to fall back to the token-spending defaults).
    let positive_integer = |flag: &str, raw: &str| -> Result<u64, EvalArgsError> {
        raw.parse::<u64>()
            .ok()
            .filter(|value| *value >= 1)
            .ok_or_else(|| {
                EvalArgsError::Message(format!("{flag} requires a positive integer, got {raw}"))
            })
    };
    while index < argv.len() {
        let flag = argv[index].as_str();
        match flag {
            "--help" | "-h" => return Err(EvalArgsError::Help),
            "--model" => config.model = take_value(&mut index, flag)?,
            "--out" => config.out_dir = take_value(&mut index, flag)?,
            "--trials" => config.trials = positive_integer(flag, &take_value(&mut index, flag)?)?,
            "--timeout-minutes" => {
                config.timeout_minutes = positive_integer(flag, &take_value(&mut index, flag)?)?;
            }
            "--width" => {
                let parsed = positive_integer(flag, &take_value(&mut index, flag)?)?;
                if parsed < 2 {
                    return Err(EvalArgsError::Message(format!(
                        "{flag} requires an integer >= 2, got {parsed}"
                    )));
                }
                config.width = parsed.min(MAX_WIDTH);
            }
            "--factories" => {
                let raw = take_value(&mut index, flag)?;
                let names: Vec<String> = raw
                    .split(',')
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
                    .collect();
                // A typo must fail before any token is spent, not silently
                // run the defaults; an explicitly empty selection fails the
                // same way (the accepted review fix).
                let mut selected: Vec<ReferenceFactoryKind> = Vec::new();
                for name in &names {
                    match ReferenceFactoryKind::parse(name) {
                        Ok(kind) if !kind.is_probe() => selected.push(kind),
                        Ok(probe) => {
                            // A probe runs automatically once per sweep and
                            // has no baseline arm — selecting one would
                            // panic the baseline build, so the flag rejects
                            // it with the selections list.
                            let known: Vec<&str> = ReferenceFactoryKind::selections()
                                .map(ReferenceFactoryKind::as_str)
                                .to_vec();
                            return Err(EvalArgsError::Message(format!(
                                "{} is a probe, not a selectable factory; the probes run \
                                 automatically once per sweep (the selections are: {})",
                                probe.as_str(),
                                known.join(", ")
                            )));
                        }
                        Err(unknown) => {
                            let known: Vec<&str> = ReferenceFactoryKind::selections()
                                .map(ReferenceFactoryKind::as_str)
                                .to_vec();
                            return Err(EvalArgsError::Message(format!(
                                "Unknown factory in --factories: {unknown} (known: {})",
                                known.join(", ")
                            )));
                        }
                    }
                }
                if selected.is_empty() {
                    return Err(EvalArgsError::Message(format!(
                        "{flag} requires at least one factory name, got {raw:?}"
                    )));
                }
                config.factories = selected;
            }
            other => return Err(EvalArgsError::Message(format!("Unknown argument: {other}"))),
        }
        index += 1;
    }
    if config.out_dir.is_empty() {
        config.out_dir = "factory-dag-eval-reports".to_string();
    }
    Ok(config)
}

// ---------------------------------------------------------------------------
// Kernel-python resolution (shared by the eval driver and the workflow e2e).
// ---------------------------------------------------------------------------

/// A resolved factory-capable kernel python.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactoryKernelPython {
    pub python: std::path::PathBuf,
    /// PYTHONPATH to prepend for this python (`None` keeps the ambient).
    pub python_path: Option<String>,
}

/// The imports a factory-capable kernel needs: the runtime (with
/// `rlm.factory`, this branch's addition) plus the kernel's default
/// packages.
const FACTORY_KERNEL_REQUIRED_IMPORTS: &str = "rlm.repl, rlm.factory, dill, requests, httpx, yaml, tomli, dotenv, pandas, numpy, scipy, bs4, lxml, pydantic, tyro";

/// Probe one candidate python for factory capability: it must import the
/// runtime and the default packages under the PYTHONPATH it would run
/// with. Bounded at 60s (importing the numeric stack is slow on a cold
/// filesystem); a hang fails the candidate, not the harness.
fn probe_factory_kernel_python(python: &std::path::Path, python_path: Option<&str>) -> bool {
    probe_factory_kernel_python_within(python, python_path, std::time::Duration::from_secs(60))
}

/// The bounded probe behind [`probe_factory_kernel_python`]: the
/// production caller passes the 60s hang bound, the unit pin a short
/// budget so the teardown path runs inside test time. Every failure
/// path owns the child's teardown — kill, then reap (`wait`): a killed
/// child nobody waits on stays a zombie for the harness's lifetime, and
/// a failed poll (`try_wait` error) proves nothing about the child, so
/// a live probe must not outlive the deadline on an unproven read (the
/// process-control discipline: kill + wait, as in the platform process
/// tests).
fn probe_factory_kernel_python_within(
    python: &std::path::Path,
    python_path: Option<&str>,
    hang_budget: std::time::Duration,
) -> bool {
    use std::process::{Command, Stdio};
    let mut command = Command::new(python);
    command
        .arg("-c")
        .arg(format!("import {FACTORY_KERNEL_REQUIRED_IMPORTS}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(path) = python_path {
        command.env("PYTHONPATH", path);
    }
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let deadline = std::time::Instant::now() + hang_budget;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            // The poll failed without proving the child exited: fall to
            // the teardown instead of leaking a live probe.
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    false
}

/// The checkout-local runtime venv (`prime-agent-runtime/.venv`, an
/// editable install of this checkout) and the runtime source dir used to
/// front-load the shared venv.
///
/// `#[must_use]` because every caller falls back to the shared venv when
/// the checkout-local pieces are absent.
#[must_use]
fn checkout_runtime_dirs() -> (Option<std::path::PathBuf>, Option<std::path::PathBuf>) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .map(std::path::Path::to_path_buf);
    let runtime_root = root.as_ref().map(|root| root.join("prime-agent-runtime"));
    let venv = runtime_root
        .as_ref()
        .map(|runtime| runtime.join(".venv").join("bin").join("python"))
        .filter(|python| python.exists());
    let source = runtime_root
        .as_ref()
        .map(|runtime| runtime.join("src"))
        .filter(|src| src.join("rlm").is_dir());
    (venv, source)
}

/// The venv interpreter path (the bootstrap's `kernel_venv_python`
/// shape, computed here — never exported from production for a harness
/// helper: the accepted review fix from the TS port kept exactly this
/// class of test-only resolution out of the production surface).
#[must_use]
fn venv_python(venv: &std::path::Path) -> std::path::PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// The XDG fallback dir the kernel bootstrap itself would use when the
/// primary venv parent is not creatable — computed here, never exported
/// from production (the accepted review fix from the TS port: no
/// speculative production surface for a test-only helper).
#[must_use]
fn xdg_kernel_venv_dir() -> std::path::PathBuf {
    let data_home = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .map_or_else(
            || {
                pa_types::platform::home_dir()
                    .unwrap_or_default()
                    .join(".local")
                    .join("share")
            },
            std::path::PathBuf::from,
        );
    data_home.join("prime").join("agent").join("kernel-venv")
}

/// Resolve a factory-capable kernel python following the TS-era harness
/// discipline (#2485): the caller's explicit pin first, then the
/// checkout-local runtime venv, then the shared kernel venv (primary and
/// XDG fallback) with this checkout's runtime source prepended on
/// PYTHONPATH so the kernel provably runs the code under test (the shared
/// venv's installed runtime is not this checkout's). Every candidate is
/// probed; a stale or factory-incapable python is never accepted.
///
/// Returns `None` with `shared_venv_exists: false` when NO shared venv
/// exists anywhere (CI): the standard kernel bootstrap then builds it from
/// this checkout's runtime, which is safe (nothing live depends on it).
/// When a shared venv exists but no candidate probes clean, the caller
/// must fail fast instead of letting the standard bootstrap rebuild the
/// shared venv that live sessions run on.
#[must_use]
pub fn resolve_factory_kernel_python(
    explicit_pin: Option<std::path::PathBuf>,
) -> (Option<FactoryKernelPython>, bool) {
    let (_, checkout_src) = checkout_runtime_dirs();
    let checkout_src = checkout_src.unwrap_or_else(|| {
        // No checkout source: the explicit candidates must stand alone.
        std::path::PathBuf::from("/nonexistent")
    });
    let shared_dirs = [crate::kernel::kernel_venv_dir(), xdg_kernel_venv_dir()];
    let shared_exists = shared_dirs.iter().any(|dir| venv_python(dir).exists());
    let prepend_source = |path: Option<String>| -> Option<String> {
        let source = checkout_src.to_string_lossy().to_string();
        if !checkout_src.join("rlm").is_dir() {
            return path;
        }
        Some(match path {
            Some(existing) => {
                let separator = path_sep();
                format!("{source}{separator}{existing}")
            }
            None => source,
        })
    };
    // 1. The caller's explicit pin: trusted as-is (the pin is the caller's
    // statement that this python is the right one), but still probed.
    if let Some(python) = explicit_pin {
        if python.exists()
            && probe_factory_kernel_python(&python, std::env::var("PYTHONPATH").ok().as_deref())
        {
            return (
                Some(FactoryKernelPython {
                    python,
                    python_path: std::env::var("PYTHONPATH").ok(),
                }),
                shared_exists,
            );
        }
    }
    // 2. The checkout-local runtime venv: an editable install of this
    //    checkout, so it runs the code under test with no injected path.
    let (venv, _) = checkout_runtime_dirs();
    if let Some(python) = venv {
        if probe_factory_kernel_python(&python, std::env::var("PYTHONPATH").ok().as_deref()) {
            return (
                Some(FactoryKernelPython {
                    python,
                    python_path: std::env::var("PYTHONPATH").ok(),
                }),
                shared_exists,
            );
        }
    }
    // 3. The shared kernel venv (primary, then the XDG fallback): the venv's
    //    installed runtime is not this checkout's (the factory stack is not
    //    released), so this checkout's runtime source is prepended on
    //    PYTHONPATH — the kernel always runs the code under test, with any
    //    caller-provided entries kept after it.
    for dir in shared_dirs {
        let python = venv_python(&dir);
        if !python.exists() {
            continue;
        }
        let python_path = prepend_source(std::env::var("PYTHONPATH").ok());
        if probe_factory_kernel_python(&python, python_path.as_deref()) {
            return (
                Some(FactoryKernelPython {
                    python,
                    python_path,
                }),
                shared_exists,
            );
        }
    }
    (None, shared_exists)
}

fn path_sep() -> &'static str {
    if cfg!(windows) {
        ";"
    } else {
        ":"
    }
}

/// The venv recipe the fail-fast message carries (the TS-era recipe, still
/// the checkout-local path that runs the code under test).
pub const FACTORY_KERNEL_VENV_RECIPE: &str = "cd prime-agent-runtime && uv venv .venv && uv pip install --python .venv/bin/python -e . dill requests httpx pyyaml tomli python-dotenv pandas numpy scipy beautifulsoup4 lxml pydantic tyro";

#[cfg(test)]
mod tests;
