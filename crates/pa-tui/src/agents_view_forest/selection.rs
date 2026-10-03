use serde_json::Value;

use super::{is_summary_row_identity, AgentsViewRow, RowKind, SelectionKey};

/// Session ids of every ancestor of a nested row, root-most first (TS
/// `collectSubagentAncestorSessionIds`): the chain the view re-expands
/// when the drilled-in child returns to it.
pub fn ancestor_session_ids(rows: &[AgentsViewRow], parent_identity: Option<&str>) -> Vec<String> {
    let mut ancestors: Vec<String> = Vec::new();
    let mut parent = parent_identity;
    let mut guard = 0;
    while let Some(identity) = parent {
        guard += 1;
        if guard > rows.len() {
            break;
        }
        let Some(row) = rows
            .iter()
            .find(|row| row.identity == identity)
            .filter(|row| row.kind != RowKind::SubagentSummary)
        else {
            break;
        };
        ancestors.insert(
            0,
            row.summary
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        );
        parent = row.parent_identity.as_deref();
    }
    ancestors
}

/// Resolve the selection after a rebuild (TS
/// `resolveAgentsViewSelectionState`): the row identity wins, then the
/// active session id, then the session id; an unresolvable anchor keeps
/// the bounded current index, else the first selectable row. A summary
/// line identity pins the fallbacks to summary rows, which reuse their
/// parent's session key.
pub fn resolve_selection(
    rows: &[AgentsViewRow],
    current: usize,
    identity: Option<&str>,
    key: Option<&SelectionKey>,
) -> usize {
    fn find_selectable<F: Fn(&AgentsViewRow) -> bool>(
        rows: &[AgentsViewRow],
        predicate: F,
    ) -> Option<usize> {
        rows.iter()
            .position(|row| row.selectable() && predicate(row))
    }
    if rows.is_empty() {
        return 0;
    }
    let selected_summary_row = identity.is_some_and(is_summary_row_identity);
    let preserves_kind =
        |row: &AgentsViewRow| !selected_summary_row || row.kind == RowKind::SubagentSummary;
    if let Some(identity) = identity {
        if let Some(index) = find_selectable(rows, |row| row.identity == identity) {
            // Synthetic nested rows deliberately reuse their parent's
            // session key, so their exact row identity must win over the
            // active-runtime fallback.
            if rows[index].kind != RowKind::Agent {
                return index;
            }
        }
    }
    // Id fallbacks stay host-scoped, like the row identity (TS #2516's
    // review fix): a local session that reuses a remote row's ids must
    // never take that row's selection.
    let selection_scope = key.and_then(|key| key.remote_host.as_deref());
    let preserves_host = |row: &AgentsViewRow| {
        row.summary
            .get("remoteHost")
            .and_then(Value::as_str)
            .filter(|host| !host.is_empty())
            == selection_scope
    };
    if let Some(active) = key.and_then(|key| key.active_session_id.as_deref()) {
        if let Some(index) = find_selectable(rows, |row| {
            preserves_kind(row)
                && preserves_host(row)
                && row
                    .summary
                    .get("activeSessionId")
                    .or_else(|| row.summary.get("id"))
                    .and_then(Value::as_str)
                    == Some(active)
        }) {
            return index;
        }
    }
    if let Some(identity) = identity {
        if let Some(index) = find_selectable(rows, |row| row.identity == identity) {
            return index;
        }
    }
    if let Some(session) = key.and_then(|key| key.session_id.as_deref()) {
        if let Some(index) = find_selectable(rows, |row| {
            preserves_kind(row)
                && preserves_host(row)
                && row.summary.get("sessionId").and_then(Value::as_str) == Some(session)
        }) {
            return index;
        }
    }
    let bounded = current.min(rows.len() - 1);
    if rows[bounded].selectable() {
        return bounded;
    }
    rows.iter()
        .position(AgentsViewRow::selectable)
        .unwrap_or(bounded)
}
