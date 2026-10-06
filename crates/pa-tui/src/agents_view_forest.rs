//! The agents-view subagent forest: how unified records nest into the session list's rows. One
//! pass computes the record hierarchy (parent linkage, rollups), then row building emits
//! top-level agents with their subagent summary line (the operator's 2026-09-28 one-line merge)
//! and, when expanded, its nested children. Pure functions on the wire forms.

use serde_json::Value;

use crate::agents_view_state::Section;

mod lineage;
mod rows;
mod selection;
mod summary;

pub use lineage::{compute_rollups, has_session_children, scope_ancestors, scope_to_subtree};
pub(crate) use lineage::{scope_root, ScopeRoot};
pub(crate) use rows::build_rows;
pub use selection::{ancestor_session_ids, resolve_selection};
pub(crate) use summary::session_model;
pub use summary::{identity_scope, selection_key, session_title, summary_identity};

/// The scope of a scoped agents view (TS `AgentsViewScopeKey` plus the display name): the
/// subtree root the view lists descendants of.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentsViewScope {
    pub session_id: Option<String>,
    pub active_session_id: Option<String>,
    pub session_name: Option<String>,
}

/// One rendered list row (TS `AgentsViewRow`).
#[derive(Debug, Clone, PartialEq)]
pub struct AgentsViewRow {
    pub kind: RowKind,
    pub section: Section,
    pub identity: String,
    /// The agent row this row is nested under (summary rows and nested children carry their
    /// parent's identity).
    pub parent_identity: Option<String>,
    /// The merged summary the open action acts on (summary rows reuse
    /// their parent's).
    pub summary: Value,
    pub title: String,
    pub model: String,
    /// The remote row's always-visible machine label
    /// ("on <tailnet-host>", "on <tailnet-host> (offline)"): local rows
    /// render none (TS #2516 `remoteHostLabel`; the label renders in its
    /// own host column, sized to its content, so a `MagicDNS` hostname is
    /// never truncated away).
    pub host_label: Option<String>,
    pub cost: f64,
    pub age: String,
    /// Nesting depth: 0 for top-level agent rows.
    pub depth: usize,
    pub descendant_count: usize,
    pub running_subagent_count: usize,
    pub expanded: bool,
    /// The row's children carry a spawn program: true only on the summary row whose children
    /// carry code, computed where the children are known.
    pub has_spawn_code: bool,
}

/// The four list row shapes (TS `AgentsViewRowKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    /// A top-level agent row.
    Agent,
    /// The subagents summary line under an agent (the operator's 2026-09-28 one-line merge).
    SubagentSummary,
    /// A nested child row inside an expanded list.
    Subagent,
    /// A read-only spawn-program line.
    Code,
}

/// The summary line's identity prefix (the `subagents:` prefix, so a carried selection
/// restores onto it).
pub(crate) const SUMMARY_ROW_PREFIX: &str = "subagents:";

/// Whether a row identity is one of a parent's summary lines: such identities pin selection
/// fallbacks to summary rows, which reuse their parent's session key.
pub(crate) fn is_summary_row_identity(identity: &str) -> bool {
    identity.starts_with(SUMMARY_ROW_PREFIX)
}

impl AgentsViewRow {
    /// Rows the selection may land on (TS `selectable`): the program's
    /// code rows are read-only context, every session row selects.
    #[must_use]
    pub fn selectable(&self) -> bool {
        match self.kind {
            RowKind::Code => false,
            RowKind::Agent | RowKind::SubagentSummary | RowKind::Subagent => true,
        }
    }
}

/// One session's stable selection key (TS `AgentsViewSelectionKey`): a row's identity flips
/// when its session persists or re-attaches, so the session ids re-find it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SelectionKey {
    pub session_id: Option<String>,
    pub active_session_id: Option<String>,
    /// `MagicDNS` host of a remote row: the id fallbacks only match inside
    /// that host (TS #2516).
    pub remote_host: Option<String>,
}

/// One recursive rollup over the record hierarchy (TS
/// `AgentsViewRecursiveRollup`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Rollup {
    pub cost: f64,
    /// Every descendant subagent's spend: each child's recursive rollup plus this record's
    /// deleted-descendant bucket. Status-independent — all descendants bill.
    pub descendants: f64,
    pub descendant_count: usize,
}

#[cfg(test)]
mod tests;
