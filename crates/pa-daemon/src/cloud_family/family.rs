//! The nuclear-family reach policy for cross-boundary cloud family
//! traffic (TS `agent-messages.ts` `familyCatalogEntry` /
//! `agentFamilyRelationship` / `assertAgentFamilyReach`): the pure edge
//! semantics the delivery seam asserts with, over the same persisted
//! parent-edge snapshots the local family catalog builds on. Family
//! membership derives from the recorded edges alone — never from names —
//! so a cloud row's family view can never cross families on a name
//! collision.

use pa_core::session_engine::agent_messaging::AgentFamilyRelationship;
use pa_types::daemon::agent_roster::classify_summary_value;
use pa_types::daemon::cloud::{CloudFamilyRow, CloudFamilyRowStatus};
use serde_json::Value;

use crate::lease::canonical_session_path;
use std::path::Path;

/// TS `AGENT_FAMILY_REACH_ERROR`: the refusal a cross-boundary send earns
/// when the target is outside the source's nuclear family.
pub const AGENT_FAMILY_REACH_ERROR: &str =
    "Agent reach is limited to parent, siblings, and children";

/// TS `familyCatalogEntry`: one roster summary's family-identity snapshot.
/// Depths are absolute (`rlmDepth`, defaulting to the parent-edge depth);
/// parent linkage rides the persisted session id / session path only when
/// the entry sits below the root; paths are canonical so an alias of the
/// same session file resolves to one parent.
#[must_use]
pub fn family_row_from_summary(summary: &Value) -> CloudFamilyRow {
    let non_empty = |key: &str| {
        summary
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    let depth = summary
        .get("rlmDepth")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| {
            usize::from(non_empty("parentSessionPath").is_some())
                .try_into()
                .unwrap_or(0)
        });
    let status = match summary.get("rosterStatus").and_then(Value::as_str) {
        Some("running") => CloudFamilyRowStatus::Running,
        Some("idle") => CloudFamilyRowStatus::Idle,
        Some("inactive") => CloudFamilyRowStatus::Inactive,
        _ => row_status(classify_summary_value(summary, false)),
    };
    CloudFamilyRow {
        id: non_empty("sessionId").unwrap_or_default().to_string(),
        name: non_empty("sessionName").map(str::to_string),
        depth,
        status,
        parent_session_id: (depth > 0)
            .then(|| non_empty("parentSessionId").map(str::to_string))
            .flatten(),
        parent_session_path: (depth > 0)
            .then(|| {
                non_empty("parentSessionPath").map(|path| {
                    canonical_session_path(Path::new(path))
                        .to_string_lossy()
                        .to_string()
                })
            })
            .flatten(),
        session_path: non_empty("sessionFile").map(|path| {
            canonical_session_path(Path::new(path))
                .to_string_lossy()
                .to_string()
        }),
    }
}

/// Map the roster status formula output onto the wire row status (the
/// two vocabularies are the same three states).
fn row_status(status: pa_types::daemon::agent_roster::AgentRosterStatus) -> CloudFamilyRowStatus {
    match status {
        pa_types::daemon::agent_roster::AgentRosterStatus::Running => CloudFamilyRowStatus::Running,
        pa_types::daemon::agent_roster::AgentRosterStatus::Idle => CloudFamilyRowStatus::Idle,
        pa_types::daemon::agent_roster::AgentRosterStatus::Inactive => {
            CloudFamilyRowStatus::Inactive
        }
    }
}

/// TS `isAgentFamilyParent`: `child`'s recorded parent edge names `parent`
/// (by session id, or by matching session path).
fn is_family_parent(parent: &CloudFamilyRow, child: &CloudFamilyRow) -> bool {
    child
        .parent_session_path
        .as_deref()
        .is_some_and(|path| parent.session_path.as_deref() == Some(path))
        || child
            .parent_session_id
            .as_deref()
            .is_some_and(|id| parent.id == id)
}

/// TS `agentFamilyRelationship`: the pure nuclear-family classification.
/// `None` means unrelated (or self); the delivery seam refuses the send
/// with [`AGENT_FAMILY_REACH_ERROR`] when the target answers `None`.
#[must_use]
pub fn agent_family_relationship(
    current: &CloudFamilyRow,
    target: &CloudFamilyRow,
) -> Option<AgentFamilyRelationship> {
    if current.id == target.id {
        return None;
    }
    if is_family_parent(target, current) {
        return Some(AgentFamilyRelationship::Parent);
    }
    if is_family_parent(current, target) {
        return Some(AgentFamilyRelationship::Child);
    }
    if current.depth == target.depth && same_family_parent(current, target) {
        return Some(AgentFamilyRelationship::Sibling);
    }
    None
}

/// TS `sameAgentFamilyParent` with the `[current, target]` catalog: two
/// entries share a parent when their recorded parent edges agree — by
/// path, by persisted session id, or by the mixed-identifier pair one of
/// the two entries itself proves (one side records the shared parent by
/// id and the other by path, and the pair resolves them to one parent).
/// Two parentless root entries are each other's siblings.
fn same_family_parent(left: &CloudFamilyRow, right: &CloudFamilyRow) -> bool {
    if let (Some(left_parent), Some(right_parent)) = (
        left.parent_session_path.as_deref(),
        right.parent_session_path.as_deref(),
    ) {
        if left_parent == right_parent {
            return true;
        }
    }
    if let (Some(left_parent), Some(right_parent)) = (
        left.parent_session_id.as_deref(),
        right.parent_session_id.as_deref(),
    ) {
        if left_parent == right_parent {
            return true;
        }
    }
    let has_catalog_parent_pair = |parent_session_id: &str, parent_session_path: &str| {
        [left, right].iter().any(|entry| {
            (entry.id == parent_session_id
                && entry.session_path.as_deref() == Some(parent_session_path))
                || (entry.parent_session_id.as_deref() == Some(parent_session_id)
                    && entry.parent_session_path.as_deref() == Some(parent_session_path))
        })
    };
    if let (Some(left_parent_id), Some(right_parent_path)) = (
        left.parent_session_id.as_deref(),
        right.parent_session_path.as_deref(),
    ) {
        if has_catalog_parent_pair(left_parent_id, right_parent_path) {
            return true;
        }
    }
    if let (Some(right_parent_id), Some(left_parent_path)) = (
        right.parent_session_id.as_deref(),
        left.parent_session_path.as_deref(),
    ) {
        if has_catalog_parent_pair(right_parent_id, left_parent_path) {
            return true;
        }
    }
    left.depth == 0
        && right.depth == 0
        && left.parent_session_path.is_none()
        && right.parent_session_path.is_none()
        && left.parent_session_id.is_none()
        && right.parent_session_id.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The TS reach fixtures (`agent-session-bus.test.ts`): the same rows,
    /// the same verdicts, byte-identical refusal strings.
    fn row(
        id: &str,
        depth: u64,
        parent_session_path: Option<&str>,
        parent_session_id: Option<&str>,
    ) -> CloudFamilyRow {
        CloudFamilyRow {
            id: id.to_string(),
            name: None,
            depth,
            status: CloudFamilyRowStatus::Running,
            parent_session_id: parent_session_id.map(str::to_string),
            parent_session_path: parent_session_path.map(str::to_string),
            session_path: Some(format!("/{id}")),
        }
    }

    #[test]
    fn authorizes_the_ts_reach_matrix() {
        let root = row("root", 0, None, None);
        let child = row("child", 1, Some("/root"), None);
        let sibling = row("sibling", 1, Some("/root"), Some("root"));
        let grandchild = row("grandchild", 2, Some("/child"), None);
        // root reaches another root as sibling
        assert_eq!(
            agent_family_relationship(&root, &row("other-root", 0, None, None)),
            Some(AgentFamilyRelationship::Sibling)
        );
        // root reaches its child
        assert_eq!(
            agent_family_relationship(&root, &child),
            Some(AgentFamilyRelationship::Child)
        );
        // child reaches its parent
        assert_eq!(
            agent_family_relationship(&child, &root),
            Some(AgentFamilyRelationship::Parent)
        );
        // children of one parent are siblings
        assert_eq!(
            agent_family_relationship(&child, &sibling),
            Some(AgentFamilyRelationship::Sibling)
        );
        // siblings match on parent id alone
        let id_only_sibling = CloudFamilyRow {
            parent_session_id: Some("root".to_string()),
            ..row("id-only-sibling", 1, None, None)
        };
        assert_eq!(
            agent_family_relationship(&sibling, &id_only_sibling),
            Some(AgentFamilyRelationship::Sibling)
        );
        let _ = grandchild;
    }

    #[test]
    fn refuses_reach_to_the_ts_unrelated_matrix() {
        let root = row("root", 0, None, None);
        let sibling = row("sibling", 1, Some("/root"), None);
        let grandchild = row("grandchild", 2, Some("/child"), None);
        // an unrelated deep agent
        assert_eq!(
            agent_family_relationship(&root, &row("orphan", 3, None, None)),
            None
        );
        // two parentless non-roots
        assert_eq!(
            agent_family_relationship(
                &row("orphan-a", 3, None, None),
                &row("orphan-b", 3, None, None)
            ),
            None
        );
        // a grandchild from the root
        assert_eq!(agent_family_relationship(&root, &grandchild), None);
        // a grandchild from an uncle
        assert_eq!(agent_family_relationship(&sibling, &grandchild), None);
    }

    /// Self answers `None` (TS: `current.id === target.id`), so a
    /// self-addressed send never resolves a relationship.
    #[test]
    fn self_answers_no_relationship() {
        let root = row("root", 0, None, None);
        assert_eq!(agent_family_relationship(&root, &root), None);
    }

    /// The mixed-identifier sibling pair (TS `hasCatalogParentPair`): one
    /// side records the shared parent by id, the other by path, and the
    /// catalog pair one of the two entries proves resolves them to one
    /// parent.
    #[test]
    fn mixed_identifier_edges_stay_unrelated_without_a_shared_edge() {
        // One side records the parent only by id, the other only by path,
        // and no entry in scope proves the two identifiers name one
        // parent: TS "unresolved mixed identifiers stay unrelated to
        // avoid false name conflicts across families".
        let by_id = CloudFamilyRow {
            parent_session_id: Some("p".to_string()),
            ..row("by-id", 1, None, None)
        };
        let by_path = CloudFamilyRow {
            parent_session_path: Some("/p".to_string()),
            ..row("by-path", 1, None, None)
        };
        assert_eq!(agent_family_relationship(&by_id, &by_path), None);
        // The resolved mixed pair: one entry carries BOTH the parent id
        // and the parent path (it proves the id<->path aliasing), the
        // other carries the path alone.
        let both = CloudFamilyRow {
            parent_session_id: Some("p".to_string()),
            parent_session_path: Some("/p".to_string()),
            ..row("both", 1, None, None)
        };
        assert_eq!(
            agent_family_relationship(&both, &by_path),
            Some(AgentFamilyRelationship::Sibling)
        );
        assert_eq!(
            agent_family_relationship(&by_path, &both),
            Some(AgentFamilyRelationship::Sibling)
        );
    }

    /// TS `familyCatalogEntry`: the depth default (`rlmDepth` falling back
    /// to the parent-edge depth), the depth-gated parent fields, and the
    /// canonical paths.
    #[test]
    fn family_row_maps_the_summary_like_the_ts_catalog_entry() {
        let summary = serde_json::json!({
            "sessionId": "sess-1",
            "activeSessionId": "aaa-111",
            "sessionName": "worker",
            "rlmDepth": 1,
            "parentSessionId": "sess-root",
            "parentSessionPath": "/sessions/root.jsonl",
            "sessionFile": "/sessions/sess-1.jsonl",
            "activity": "working",
            "isSessionActive": true,
        });
        let entry = family_row_from_summary(&summary);
        assert_eq!(entry.id, "sess-1");
        assert_eq!(entry.name.as_deref(), Some("worker"));
        assert_eq!(entry.depth, 1);
        assert_eq!(entry.parent_session_id.as_deref(), Some("sess-root"));
        assert_eq!(
            entry.parent_session_path.as_deref(),
            Some("/sessions/root.jsonl")
        );
        assert_eq!(
            entry.session_path.as_deref(),
            Some("/sessions/sess-1.jsonl")
        );
        assert_eq!(entry.status, CloudFamilyRowStatus::Running);

        // A depth-0 summary never carries the parent fields, whatever the
        // summary holds (TS gates on `depth > 0`).
        let root_summary = serde_json::json!({
            "sessionId": "sess-root",
            "activeSessionId": "bbb-222",
            "rlmDepth": 0,
            "parentSessionId": "fork-origin",
            "activity": "idle",
            "isSessionActive": false,
        });
        let root_entry = family_row_from_summary(&root_summary);
        assert_eq!(root_entry.depth, 0);
        assert_eq!(root_entry.parent_session_id, None);
        assert_eq!(root_entry.parent_session_path, None);
        assert_eq!(root_entry.status, CloudFamilyRowStatus::Idle);
        // A summary with no live active session id is not resident, so
        // the classification reads inactive (TS `!!summary.activeSessionId`).
        let passive = serde_json::json!({
            "sessionId": "sess-passive",
            "activity": "idle",
            "isSessionActive": false,
        });
        assert_eq!(
            family_row_from_summary(&passive).status,
            CloudFamilyRowStatus::Inactive
        );

        // A summary without rlmDepth but with a parent path sits at the
        // parent-edge depth (TS `rlmDepth ?? (parentSessionPath ? 1 : 0)`).
        let unnumbered = serde_json::json!({
            "sessionId": "sess-2",
            "parentSessionPath": "/sessions/root.jsonl",
        });
        assert_eq!(family_row_from_summary(&unnumbered).depth, 1);
        // The rosterStatus string overrides the classification.
        let labeled = serde_json::json!({
            "sessionId": "sess-3",
            "rosterStatus": "inactive",
            "activity": "working",
            "isSessionActive": true,
        });
        assert_eq!(
            family_row_from_summary(&labeled).status,
            CloudFamilyRowStatus::Inactive
        );
    }
}
