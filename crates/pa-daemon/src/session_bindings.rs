//! The supervisor's durable session-binding table: every file-backed active id
//! the supervisor has routed is remembered, so a SUPERSEDED id resolves to the
//! session's current resident, not `Unknown active session`. The registry is the
//! live roster; this is its durable shadow (a restart empties it — the
//! descriptor-file fallback covers that). A deleted file forgets its binding.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use std::sync::Mutex;

/// One session's durable identity plus its latest known active id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionBinding {
    pub(crate) active_session_id: String,
    /// The durable session id (the session file's UUID).
    pub(crate) session_id: Option<String>,
    /// The session file path (canonicalized when it exists).
    pub(crate) session_file: Option<String>,
}

/// The remembered bindings, keyed by every file-backed active id ever seen and
/// by the canonical session file: a supersede repoints the old active id at
/// the new binding, so lookups by either id converge.
#[derive(Default)]
pub(crate) struct SessionBindingTable {
    by_active_id: Mutex<HashMap<String, Arc<SessionBinding>>>,
    by_session_file: Mutex<HashMap<String, Arc<SessionBinding>>>,
}

impl SessionBindingTable {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Record one binding. Returns the superseded active ids with the new
    /// binding when the SAME durable session (matching file AND id) was bound
    /// to a different worker; a foreign session at a reused path supersedes nothing.
    pub(crate) fn record(
        &self,
        active_session_id: &str,
        session_id: Option<&str>,
        session_file: Option<&str>,
    ) -> Option<(Vec<String>, Arc<SessionBinding>)> {
        if active_session_id.is_empty() {
            return None;
        }
        // Nothing durable to remember: a file-less worker (an in-memory
        // session) is never a rebind source and earns no entry.
        let session_file = session_file.filter(|file| !file.is_empty())?;
        let binding = Arc::new(SessionBinding {
            active_session_id: active_session_id.to_string(),
            session_id: session_id.filter(|id| !id.is_empty()).map(str::to_string),
            session_file: Some(canonical_binding_path(session_file)),
        });
        let mut by_active_id = Self::locked(&self.by_active_id);
        let mut by_session_file = Self::locked(&self.by_session_file);
        by_active_id.insert(active_session_id.to_string(), Arc::clone(&binding));
        // Every id holding an older binding for this same durable session is
        // superseded — not just the immediately previous one.
        let file = binding.session_file.as_deref().expect("file-backed");
        let mut superseded_ids: Vec<String> = by_active_id
            .iter()
            .filter(|(_, bound)| {
                bound.session_file.as_deref() == Some(file)
                    && bound.session_id.is_some()
                    && bound.session_id == binding.session_id
                    && bound.active_session_id != binding.active_session_id
            })
            .map(|(id, _)| id.clone())
            .collect();
        superseded_ids.sort();
        by_session_file.insert(file.to_string(), Arc::clone(&binding));
        // The superseded ids keep addressing the session through the new binding.
        for previous in &superseded_ids {
            by_active_id.insert(previous.clone(), Arc::clone(&binding));
        }
        (!superseded_ids.is_empty()).then_some((superseded_ids, binding))
    }

    /// The binding one active id addresses (the latest binding for its
    /// session when the id was superseded).
    pub(crate) fn binding_for(&self, active_session_id: &str) -> Option<Arc<SessionBinding>> {
        if active_session_id.is_empty() {
            return None;
        }
        Self::locked(&self.by_active_id)
            .get(active_session_id)
            .cloned()
    }

    /// Forget a session file's binding (the session-delete prune): the
    /// argument is the canonical key `record` stores, computed while the file
    /// still exists. Bindings of live files stay.
    pub(crate) fn forget_file(&self, session_file: &str) {
        let mut by_active_id = Self::locked(&self.by_active_id);
        let mut by_session_file = Self::locked(&self.by_session_file);
        by_session_file.remove(session_file);
        by_active_id.retain(|_, bound| bound.session_file.as_deref() != Some(session_file));
    }
}

impl SessionBindingTable {
    /// Poisoning-tolerant lock (the supervisor's std-Mutex pattern): the
    /// tables' invariants survive a panic between lock and unlock.
    fn locked<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// The canonical key for a session file (the registry's comparison rule:
/// canonicalize when the path exists, keep the raw path otherwise).
fn canonical_binding_path(path: &str) -> String {
    Path::new(path).canonicalize().map_or_else(
        |_| path.to_string(),
        |canonical| canonical.to_string_lossy().to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_indexes_by_active_id_and_file() {
        let table = SessionBindingTable::new();
        assert!(table
            .record("worker-1", Some("sess-uuid"), Some("/tmp/sess.jsonl"))
            .is_none());
        let binding = table.binding_for("worker-1").expect("binding");
        assert_eq!(binding.active_session_id, "worker-1");
        assert_eq!(binding.session_id.as_deref(), Some("sess-uuid"));
        assert_eq!(binding.session_file.as_deref(), Some("/tmp/sess.jsonl"));
    }

    #[test]
    fn supersede_repoints_the_old_id_at_the_new_binding() {
        let table = SessionBindingTable::new();
        table.record("worker-1", Some("sess-uuid"), Some("/tmp/sess.jsonl"));
        let superseded = table
            .record("worker-2", Some("sess-uuid"), Some("/tmp/sess.jsonl"))
            .expect("supersede reported");
        assert_eq!(superseded.0, vec!["worker-1".to_string()]);
        // The pair carries the NEW binding - what the supersede event advertises as the
        // rebind target.
        assert_eq!(superseded.1.active_session_id, "worker-2");
        let through_old = table.binding_for("worker-1").expect("old id still bound");
        assert_eq!(through_old.active_session_id, "worker-2");
        assert_eq!(through_old.session_file.as_deref(), Some("/tmp/sess.jsonl"));
        assert_eq!(
            table
                .binding_for("worker-2")
                .expect("new id")
                .active_session_id,
            "worker-2"
        );
    }

    #[test]
    fn a_second_supersede_repoints_every_older_id() {
        let table = SessionBindingTable::new();
        table.record("worker-1", Some("sess-uuid"), Some("/tmp/sess.jsonl"));
        table.record("worker-2", Some("sess-uuid"), Some("/tmp/sess.jsonl"));
        let superseded = table
            .record("worker-3", Some("sess-uuid"), Some("/tmp/sess.jsonl"))
            .expect("supersede reported");
        // BOTH older ids are reported (sorted) - each gets its own supersede event.
        assert_eq!(
            superseded.0,
            vec!["worker-1".to_string(), "worker-2".to_string()]
        );
        assert_eq!(
            table
                .binding_for("worker-1")
                .expect("oldest id")
                .active_session_id,
            "worker-3"
        );
        assert_eq!(
            table
                .binding_for("worker-2")
                .expect("middle id")
                .active_session_id,
            "worker-3"
        );
    }

    #[test]
    fn rebinding_the_same_id_is_not_a_supersede() {
        let table = SessionBindingTable::new();
        table.record("worker-1", Some("sess-uuid"), Some("/tmp/sess.jsonl"));
        // A relaunch re-records the same identity: no supersede, no event.
        assert!(table
            .record("worker-1", Some("sess-uuid"), Some("/tmp/sess.jsonl"))
            .is_none());
    }

    #[test]
    fn unknown_and_empty_ids_have_no_binding() {
        let table = SessionBindingTable::new();
        assert!(table.binding_for("never-seen").is_none());
        assert!(table.binding_for("").is_none());
        // Empty ids are never recorded, even with a file.
        assert!(table.record("", None, Some("/tmp/x.jsonl")).is_none());
        assert!(table.binding_for("").is_none());
    }

    #[test]
    fn a_binding_without_a_session_file_never_supersedes() {
        let table = SessionBindingTable::new();
        // A no-session worker (in-memory) has no durable identity to bind and can never serve
        // a rebind: nothing is retained for it.
        assert!(table.record("worker-1", None, None).is_none());
        assert!(table.record("worker-2", None, None).is_none());
        assert!(table.binding_for("worker-1").is_none());
        assert!(table.binding_for("worker-2").is_none());
    }

    #[test]
    fn a_deleted_session_file_forgets_its_ids() {
        let table = SessionBindingTable::new();
        table.record("worker-1", Some("sess-uuid"), Some("/tmp/sess.jsonl"));
        table.record("worker-2", Some("sess-uuid"), Some("/tmp/sess.jsonl"));
        // The file leaves disk (a client delete): no successor worker can ever take it over,
        // so every id addressing it drops with it.
        table.forget_file("/tmp/sess.jsonl");
        assert!(table.binding_for("worker-1").is_none());
        assert!(table.binding_for("worker-2").is_none());
        // A re-record after the prune rebuilds the binding (the delete pruned the old
        // state, not the session's future).
        assert!(table
            .record("worker-3", Some("sess-uuid"), Some("/tmp/sess.jsonl"))
            .is_none());
        assert_eq!(
            table
                .binding_for("worker-3")
                .expect("re-recorded")
                .active_session_id,
            "worker-3"
        );
    }

    #[test]
    fn forgetting_one_file_keeps_other_files_bound() {
        let table = SessionBindingTable::new();
        table.record("worker-1", Some("a"), Some("/tmp/a.jsonl"));
        table.record("worker-2", Some("b"), Some("/tmp/b.jsonl"));
        table.forget_file("/tmp/a.jsonl");
        // The untouched file's ids stay rebindable through their binding.
        assert_eq!(
            table
                .binding_for("worker-2")
                .expect("kept")
                .session_id
                .as_deref(),
            Some("b")
        );
        assert!(table.binding_for("worker-1").is_none());
    }

    #[test]
    fn a_different_session_at_a_reused_file_path_never_supersedes() {
        let table = SessionBindingTable::new();
        table.record("worker-1", Some("sess-a"), Some("/tmp/sess.jsonl"));
        // The file path is reused by a DIFFERENT durable session: no supersede,
        // no silent rebind into the foreign session.
        assert!(table
            .record("worker-2", Some("sess-b"), Some("/tmp/sess.jsonl"))
            .is_none());
        assert_eq!(
            table
                .binding_for("worker-1")
                .expect("kept")
                .session_id
                .as_deref(),
            Some("sess-a")
        );
        assert_eq!(
            table
                .binding_for("worker-2")
                .expect("kept")
                .session_id
                .as_deref(),
            Some("sess-b")
        );
    }

    #[test]
    fn an_identity_less_record_never_supersedes() {
        // A boot registration racing the create carries no session id: it
        // supersedes nothing (the identity cannot match); `None` identifies no
        // durable session.
        let table = SessionBindingTable::new();
        table.record("worker-1", Some("sess-a"), Some("/tmp/sess.jsonl"));
        assert!(table
            .record("worker-2", None, Some("/tmp/sess.jsonl"))
            .is_none());
        assert_eq!(
            table
                .binding_for("worker-1")
                .expect("kept")
                .session_id
                .as_deref(),
            Some("sess-a")
        );
        let superseded = table
            .record("worker-2", Some("sess-a"), Some("/tmp/sess.jsonl"))
            .expect("supersede at create completion");
        assert_eq!(superseded.0, vec!["worker-1".to_string()]);
    }

    #[test]
    fn two_identity_less_records_never_supersede_each_other() {
        let table = SessionBindingTable::new();
        table.record("worker-1", None, Some("/tmp/sess.jsonl"));
        table.record("worker-2", None, Some("/tmp/sess.jsonl"));
        assert_eq!(
            table
                .binding_for("worker-1")
                .expect("kept")
                .active_session_id,
            "worker-1"
        );
        assert_eq!(
            table
                .binding_for("worker-2")
                .expect("kept")
                .active_session_id,
            "worker-2"
        );
    }

    #[test]
    fn distinct_files_keep_distinct_bindings() {
        let table = SessionBindingTable::new();
        table.record("worker-1", Some("a"), Some("/tmp/a.jsonl"));
        table.record("worker-2", Some("b"), Some("/tmp/b.jsonl"));
        assert_eq!(
            table
                .binding_for("worker-1")
                .expect("a")
                .session_id
                .as_deref(),
            Some("a")
        );
        assert_eq!(
            table
                .binding_for("worker-2")
                .expect("b")
                .session_id
                .as_deref(),
            Some("b")
        );
    }
}
