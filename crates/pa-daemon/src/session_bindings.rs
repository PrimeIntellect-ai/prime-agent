//! The supervisor's durable session-binding table (the stale-active-id
//! rebind fix): every active session id the supervisor has ever routed is
//! remembered with the session's durable identity, so a client holding a
//! SUPERSEDED id - a worker replaced after the give-up cap, a session
//! re-opened under a fresh worker - resolves to the session's current
//! resident instead of failing with `Unknown active session`.
//!
//! The registry is the live roster; this table is its durable shadow. It
//! survives worker removal (`stop_worker`, the give-up path) by design:
//! the binding, not the worker, is what the client's stale id addresses.
//! A supervisor restart empties it - the descriptor-file fallback in
//! [`crate::supervisor`] covers that case from disk.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use std::sync::Mutex;

/// One session's durable identity plus its latest known active id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionBinding {
    /// The active session id of the worker that produced this binding.
    pub(crate) active_session_id: String,
    /// The durable session id (the session file's UUID).
    pub(crate) session_id: Option<String>,
    /// The session file path (canonicalized when it exists).
    pub(crate) session_file: Option<String>,
}

/// The remembered bindings, keyed by every active id ever seen and by the
/// canonical session file. Two maps, one shared binding per session: a
/// supersede (a new worker taking over a session file) repoints the old
/// active id at the new binding, so lookups by either id converge.
#[derive(Default)]
pub(crate) struct SessionBindingTable {
    by_active_id: Mutex<HashMap<String, Arc<SessionBinding>>>,
    by_session_file: Mutex<HashMap<String, Arc<SessionBinding>>>,
}

impl SessionBindingTable {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Record one binding. Returns every superseded active id (all older
    /// ids of the session, sorted) with the new binding when the session
    /// file was already bound to a different worker - the old->new binding
    /// events' trigger. All older ids repoint at the new binding, so a
    /// client holding any of them converges on the current identity.
    pub(crate) fn record(
        &self,
        active_session_id: &str,
        session_id: Option<&str>,
        session_file: Option<&str>,
    ) -> Option<(Vec<String>, Arc<SessionBinding>)> {
        if active_session_id.is_empty() {
            return None;
        }
        let binding = Arc::new(SessionBinding {
            active_session_id: active_session_id.to_string(),
            session_id: session_id.filter(|id| !id.is_empty()).map(str::to_string),
            session_file: session_file
                .filter(|file| !file.is_empty())
                .map(canonical_binding_path),
        });
        let mut by_active_id = self.locked(&self.by_active_id);
        let mut by_session_file = self.locked(&self.by_session_file);
        by_active_id.insert(active_session_id.to_string(), Arc::clone(&binding));
        // Every id still holding an older binding for this session file is
        // superseded - not just the immediately previous one, so a client
        // that missed an intermediate supersede still converges.
        let mut superseded_ids: Vec<String> = binding
            .session_file
            .as_deref()
            .map(|file| {
                by_active_id
                    .iter()
                    .filter(|(_, bound)| {
                        bound.session_file.as_deref() == Some(file)
                            && bound.active_session_id != binding.active_session_id
                    })
                    .map(|(id, _)| id.clone())
                    .collect()
            })
            .unwrap_or_default();
        superseded_ids.sort();
        if let Some(file) = binding.session_file.as_deref() {
            by_session_file.insert(file.to_string(), Arc::clone(&binding));
        }
        // The superseded ids keep addressing the session through the new
        // binding: `by_active_id[old] = new`.
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
        self.locked(&self.by_active_id)
            .get(active_session_id)
            .cloned()
    }
}

impl SessionBindingTable {
    /// Poisoning-tolerant lock (the supervisor's std-Mutex pattern): the
    /// tables' invariants survive a panic between lock and unlock.
    fn locked<'a, T>(&self, mutex: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The canonical key for a session file (the registry's comparison rule:
/// canonicalize when the path exists, keep the raw path otherwise).
fn canonical_binding_path(path: &str) -> String {
    Path::new(path)
        .canonicalize()
        .map(|canonical| canonical.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string())
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
        // The pair carries the NEW binding - what the supersede event
        // advertises as the rebind target.
        assert_eq!(superseded.1.active_session_id, "worker-2");
        // The old id addresses the session's CURRENT binding.
        let through_old = table.binding_for("worker-1").expect("old id still bound");
        assert_eq!(through_old.active_session_id, "worker-2");
        assert_eq!(through_old.session_file.as_deref(), Some("/tmp/sess.jsonl"));
        // The new id works directly.
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
        // BOTH older ids are reported (sorted) - each gets its own
        // supersede event - and both converge on the current binding.
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
        // A no-session worker (in-memory) has no durable identity to bind.
        assert!(table.record("worker-1", None, None).is_none());
        assert!(table.record("worker-2", None, None).is_none());
        assert_eq!(
            table
                .binding_for("worker-1")
                .expect("kept")
                .active_session_id,
            "worker-1"
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
