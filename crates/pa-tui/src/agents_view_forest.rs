//! The agents-view subagent forest: how unified records nest into the
//! session list's rows. One pass computes the record hierarchy (parent
//! linkage, rollups), then row building emits top-level agents with their
//! subagent summary lines and, when a line is expanded, its nested
//! children. Selection resolution and ancestry walks over that row tree
//! live here too. Pure functions on the wire forms (roster summaries and
//! saved-catalog rows); the view module owns input and painting.
//!
//! Operator directive (2026-09-25, deliberate TS divergence): a parent
//! with running descendants carries TWO summary lines. The running line
//! titles `"{direct}, {nested} running"` (direct = immediately running
//! children, nested = further running descendants below them) and expands
//! to ONLY running rows — flattened through non-running ancestors so a
//! `0, N running` line still reveals its nested workers. The inactive
//! line titles `"{n} inactive subagent(s)"` and expands to the
//! not-running children, so historical agents stay discoverable without
//! contaminating the running expansion. TS `createSubagentSummaryRow`
//! instead titles one `"{n} subagents running"` / `"{n} subagents"` line
//! that expands to every child.

use serde_json::Value;

use crate::agents_view_state::Section;

mod lineage;
mod rows;
mod selection;
mod summary;

pub use lineage::{
    compute_rollups, has_session_children, scope_ancestors, scope_depth, scope_to_subtree,
};
pub use rows::build_rows;
pub use selection::{ancestor_session_ids, resolve_selection};
pub(crate) use summary::{is_subagent_summary, session_model};
pub use summary::{selection_key, session_title, summary_identity};

/// The scope of a scoped agents view (TS `AgentsViewScopeKey` plus the
/// display name): the subtree root the view lists descendants of.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentsViewScope {
    pub session_id: Option<String>,
    pub active_session_id: Option<String>,
    pub session_name: Option<String>,
}

/// One rendered list row (TS `AgentsViewRow`).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentsViewRow {
    /// Which of the three row shapes this row renders as.
    pub kind: RowKind,
    pub section: Section,
    pub identity: String,
    /// The agent row this row is nested under (summary rows and nested
    /// children carry their parent's identity).
    pub parent_identity: Option<String>,
    /// The merged summary the open action acts on (summary rows reuse
    /// their parent's).
    pub summary: Value,
    pub title: String,
    pub model: String,
    /// Own usage cost plus every descendant's (TS `recursiveCost`).
    pub cost: f64,
    pub age: String,
    /// Nesting depth: 0 for top-level agent rows.
    pub depth: usize,
    /// Every descendant session under this row (TS `descendantCount`).
    pub descendant_count: usize,
    /// Live running descendants (TS `runningSubagentCount`).
    pub running_subagent_count: usize,
    /// The summary row's list is expanded (TS `expanded`).
    pub expanded: bool,
}

/// The three list row shapes (TS `AgentsViewRowKind`; the read-only
/// spawn-code rows belong to the program surface, not this one).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    /// A top-level agent row.
    Agent,
    /// The running/inactive summary lines under an agent (TS
    /// `subagent-summary`, split by the operator's 2026-09-25
    /// directive).
    SubagentSummary,
    /// A nested child row inside an expanded list (TS `subagent`).
    Subagent,
}

/// The running line's identity prefix (TS `subagent-summary` keeps the
/// `subagents:` prefix, so a carried selection restores onto it).
pub(crate) const SUMMARY_ROW_PREFIX: &str = "subagents:";
/// The inactive line's identity prefix (the operator's historical
/// agents' separate line).
pub(crate) const INACTIVE_SUMMARY_ROW_PREFIX: &str = "subagents-inactive:";

/// Whether a row identity is one of a parent's summary lines (the
/// running or the inactive line): such identities pin selection
/// fallbacks to summary rows, which reuse their parent's session key,
/// and the inactive prefix drives the toggle's expansion-set dispatch.
pub(crate) fn is_summary_row_identity(identity: &str) -> bool {
    identity.starts_with(SUMMARY_ROW_PREFIX) || identity.starts_with(INACTIVE_SUMMARY_ROW_PREFIX)
}

impl AgentsViewRow {
    /// Rows the selection may land on (TS `selectable`: every row here).
    pub fn selectable(&self) -> bool {
        true
    }
}

/// One session's stable selection key (TS `AgentsViewSelectionKey`): a
/// row's identity flips when its session persists or re-attaches, so the
/// session ids re-find it across those transitions.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SelectionKey {
    pub session_id: Option<String>,
    pub active_session_id: Option<String>,
}

/// One recursive rollup over the record hierarchy (TS
/// `AgentsViewRecursiveRollup`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Rollup {
    pub cost: f64,
    /// Every descendant subagent's spend (the running line's aggregate
    /// cost cell): each child's recursive rollup plus this record's
    /// deleted-descendant bucket. Status-independent — running, idle,
    /// and inactive descendants all bill.
    pub descendants: f64,
    pub descendant_count: usize,
}

#[cfg(test)]
mod tests;
