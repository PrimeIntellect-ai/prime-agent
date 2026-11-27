//! The supervisor's agent roster: per-agent entries keyed by roster agent
//! id, with active-session and canonical-session-file indexes so lookups
//! converge across worker restarts and re-registrations. Classification
//! uses the shared formula in `pa_types::daemon::agent_roster`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use pa_types::daemon::agent_roster::{
    classify_summary_value, roster_agent_id_for_summary, slim_roster_summary, AgentRosterEntry,
};
use serde_json::{Map, Value};

/// The supervisor-owned roster. `Write()` classifies once and its file index
/// converges seed and worker keys.
pub(crate) struct AgentRoster {
    entries: HashMap<String, AgentRosterEntry>,
    agent_id_by_active_session_id: HashMap<String, String>,
    agent_id_by_session_file: HashMap<String, String>,
    /// The stale-delta gate of one worker: a single bounded slot naming
    /// the worker's CURRENT process generation (`instance`) and the
    /// newest sequence applied from it. A worker's push consumer
    /// serializes its deltas, but a delta still races an authoritative
    /// pull (the link dials one socket per request), so the gates drop a
    /// delayed older snapshot instead of letting it overwrite a newer
    /// one. The slot is bounded (one entry per
    /// worker, dropped on stop): a replacement registers a new instance
    /// and restarts its counter, and [`AgentRoster::note_worker_generation`]
    /// flips the slot to the replacement — every frame or pull of the
    /// predecessor generation is then stale by construction and drops on
    /// the generation mismatch, so retired generations never accumulate.
    /// The TS worker never needs any of this — its roster deltas ride
    /// one ordered supervisor client socket.
    delta_watermarks: HashMap<String, DeltaWatermark>,
    /// Every row's `usage` and `totalUsage` are stamped from this fold.
    usage: Arc<crate::usage_ledger::UsageLedger>,
}

/// One worker's stale-delta slot: the process generation the watermark
/// orders and the newest sequence applied from that generation.
struct DeltaWatermark {
    instance: String,
    watermark: u64,
}

impl AgentRoster {
    pub(crate) fn new(usage: Arc<crate::usage_ledger::UsageLedger>) -> Self {
        AgentRoster {
            entries: HashMap::new(),
            agent_id_by_active_session_id: HashMap::new(),
            agent_id_by_session_file: HashMap::new(),
            delta_watermarks: HashMap::new(),
            usage,
        }
    }

    /// The stale-delta gate for one worker's `worker_roster_delta`: a sequence at or below
    /// the newest applied one must not write; a frame from a generation the slot no longer
    /// names is stale (the answer is still success). `0` means unsequenced and always applies.
    pub(crate) fn accept_delta_sequence(
        &mut self,
        worker_id: &str,
        instance: &str,
        sequence: u64,
    ) -> bool {
        if sequence == 0 {
            // Unsequenced frames apply only from the slot's own generation: a replaced
            // process's delayed frame must not overwrite the replacement.
            return self
                .delta_watermarks
                .get(worker_id)
                .is_none_or(|slot| slot.instance == instance);
        }
        match self.delta_watermarks.get_mut(worker_id) {
            Some(slot) if slot.instance == instance => {
                if sequence <= slot.watermark {
                    false
                } else {
                    slot.watermark = sequence;
                    true
                }
            }
            Some(_) => false,
            None => {
                self.delta_watermarks.insert(
                    worker_id.to_string(),
                    DeltaWatermark {
                        instance: instance.to_string(),
                        watermark: sequence,
                    },
                );
                true
            }
        }
    }

    /// The gate for one authoritative pull (registration, adoption, create, refresh):
    /// applies when its counter is at or above the applied watermark, dropped below it.
    /// The worker captures the counter and state under one core lock: at equal
    /// counters the pull follows the push snapshot and has the newer content.
    /// The caller must run this gate, the summary write, and the watermark raise in ONE
    /// roster-lock critical section. A summary without the counter stamp always applies;
    /// a STAMPED counter — zero included — orders against the slot like any other pull.
    pub(crate) fn accept_roster_pull(
        &mut self,
        worker_id: &str,
        instance: &str,
        counter: Option<u64>,
    ) -> bool {
        let Some(counter) = counter else {
            return true;
        };
        match self.delta_watermarks.get_mut(worker_id) {
            Some(slot) if slot.instance == instance => {
                if counter < slot.watermark {
                    false
                } else {
                    slot.watermark = counter;
                    true
                }
            }
            // The slot names the current generation; the pull answered
            // for a predecessor.
            Some(_) => false,
            None => {
                self.delta_watermarks.insert(
                    worker_id.to_string(),
                    DeltaWatermark {
                        instance: instance.to_string(),
                        watermark: counter,
                    },
                );
                true
            }
        }
    }

    /// Record the worker's current process generation: a replacement flips the slot to a
    /// fresh watermark and the predecessor's delayed frames drop; a same-generation
    /// re-register keeps the slot.
    pub(crate) fn note_worker_generation(&mut self, worker_id: &str, instance: &str) {
        let generation_flipped = match self.delta_watermarks.get(worker_id) {
            Some(slot) => slot.instance != instance,
            // A first registration starts the slot: the pull that follows may never land, so
            // the slot alone must already gate the predecessor's frames.
            None => true,
        };
        if generation_flipped {
            self.delta_watermarks.insert(
                worker_id.to_string(),
                DeltaWatermark {
                    instance: instance.to_string(),
                    watermark: 0,
                },
            );
        }
    }

    /// Forget the stopped worker's stale-delta slot (keeps the map bounded).
    pub(crate) fn forget_worker_sequences(&mut self, worker_id: &str) {
        self.delta_watermarks.remove(worker_id);
    }

    /// Classify and store one entry from a worker's slim summary: a session file that changed
    /// agent ownership evicts the previous owner (TS `write` index convergence).
    pub(crate) fn write_summary(
        &mut self,
        summary: Value,
        worker_id: Option<&str>,
        status_label: Option<&str>,
    ) -> AgentRosterEntry {
        let queued_child = summary
            .get("queuedChild")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.store(
            summary,
            queued_child.then_some(true),
            worker_id,
            status_label,
            None,
        )
    }

    /// Store one ledger-seeded entry (TS `write` of a boot-seed `WorkerRosterEntry`): no
    /// worker owner, no status label, `seededCwd` when the cwd could not be hydrated.
    pub(crate) fn write_seeded(&mut self, summary: Value, seeded_cwd: bool) -> AgentRosterEntry {
        self.store(summary, None, None, None, seeded_cwd.then_some(true))
    }

    /// The shared write path behind [`AgentRoster::write_summary`] and
    /// [`AgentRoster::write_seeded`]: classify once, stamp the spend from
    /// the usage ledger, converge the indexes, and evict a previous owner of
    /// the same session file.
    fn store(
        &mut self,
        mut summary: Value,
        queued_child: Option<bool>,
        worker_id: Option<&str>,
        status_label: Option<&str>,
        seeded_cwd: Option<bool>,
    ) -> AgentRosterEntry {
        let queued = queued_child.unwrap_or(false);
        let agent_id = roster_agent_id_for_summary(&summary);
        let file = summary
            .get("sessionFile")
            .and_then(Value::as_str)
            .filter(|file| !file.is_empty())
            .map(canonical_roster_path);
        if let (Some(file), Some(object)) = (&file, summary.as_object_mut()) {
            self.usage.stamp(object, Path::new(file));
        }
        let stored = AgentRosterEntry {
            agent_id: agent_id.clone(),
            queued_child,
            seeded_cwd,
            status: classify_summary_value(&summary, queued),
            status_label: if queued {
                Some("queued".to_string())
            } else {
                status_label.map(str::to_string)
            },
            last_heard_from_at: None,
            worker_id: worker_id.map(str::to_string),
            summary: slim_roster_summary(summary),
            rest: Map::default(),
        };
        if let Some(previous) = self.entries.get(&agent_id).cloned() {
            self.drop_indexes(&previous);
        }
        if let Some(file) = file {
            if let Some(existing) = self.agent_id_by_session_file.get(&file) {
                if existing != &agent_id {
                    let existing = existing.clone();
                    self.delete(&existing);
                }
            }
            self.agent_id_by_session_file.insert(file, agent_id.clone());
        }
        if let Some(active) = stored
            .summary
            .get("activeSessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            self.agent_id_by_active_session_id
                .insert(active.to_string(), agent_id.clone());
        }
        self.entries.insert(agent_id, stored.clone());
        stored
    }

    /// Re-stamp the spend of every row whose session's total the usage
    /// ledger moved; returns the rewritten rows for the caller's push.
    pub(crate) fn restamp_spend(&mut self, session_ids: &[String]) -> Vec<AgentRosterEntry> {
        let mut changed = Vec::new();
        for entry in self.entries.values_mut() {
            let Some(file) = entry
                .summary
                .get("sessionFile")
                .and_then(Value::as_str)
                .map(std::path::PathBuf::from)
            else {
                continue;
            };
            let moved = crate::rlm_ledger::durable_session_id(&file)
                .is_some_and(|session_id| session_ids.contains(&session_id));
            if let (true, Some(object)) = (moved, entry.summary.as_object_mut()) {
                self.usage.stamp(object, &file);
                changed.push(entry.clone());
            }
        }
        changed
    }

    pub(crate) fn delete(&mut self, agent_id: &str) {
        let Some(entry) = self.entries.remove(agent_id) else {
            return;
        };
        self.drop_indexes(&entry);
    }

    pub(crate) fn get(&self, agent_id: &str) -> Option<&AgentRosterEntry> {
        self.entries.get(agent_id)
    }

    /// The session-file index has a row (TS `hasSessionFile`): never a second seeded row.
    pub(crate) fn has_session_file(&self, canonical_file: &str) -> bool {
        self.agent_id_by_session_file.contains_key(canonical_file)
    }

    /// The entry owning one canonical session file.
    pub(crate) fn by_session_file(&self, canonical_file: &str) -> Option<&AgentRosterEntry> {
        self.agent_id_by_session_file
            .get(canonical_file)
            .and_then(|agent_id| self.entries.get(agent_id))
    }

    /// The entry keyed by one active session id.
    pub(crate) fn by_active_session_id(
        &self,
        active_session_id: &str,
    ) -> Option<&AgentRosterEntry> {
        self.agent_id_by_active_session_id
            .get(active_session_id)
            .and_then(|agent_id| self.entries.get(agent_id))
    }

    pub(crate) fn entries_for_worker(&self, worker_id: &str) -> Vec<&AgentRosterEntry> {
        self.entries
            .values()
            .filter(|entry| entry.worker_id.as_deref() == Some(worker_id))
            .collect()
    }

    /// The rows a worker's root-slot swap retires: a whole-session
    /// replacement (`new_session`/`switch_session`/`import_jsonl`/`fork`)
    /// serves a NEW durable session under the SAME active session id.
    pub(crate) fn swapped_out_root_rows(
        &self,
        worker_id: &str,
        fresh: &AgentRosterEntry,
    ) -> Vec<String> {
        let Some(active) = fresh
            .summary
            .get("activeSessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            return Vec::new();
        };
        self.entries_for_worker(worker_id)
            .into_iter()
            .filter(|entry| entry.agent_id != fresh.agent_id)
            .filter(|entry| {
                entry.summary.get("activeSessionId").and_then(Value::as_str) == Some(active)
            })
            .map(|entry| entry.agent_id.clone())
            .collect()
    }

    /// All entries in stable (insertion) order for pushes and snapshots.
    pub(crate) fn entries(&self) -> Vec<AgentRosterEntry> {
        self.entries.values().cloned().collect()
    }

    fn drop_indexes(&mut self, entry: &AgentRosterEntry) {
        if let Some(active) = entry
            .summary
            .get("activeSessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            if self
                .agent_id_by_active_session_id
                .get(active)
                .is_some_and(|agent_id| agent_id == &entry.agent_id)
            {
                self.agent_id_by_active_session_id.remove(active);
            }
        }
        if let Some(file) = entry
            .summary
            .get("sessionFile")
            .and_then(Value::as_str)
            .filter(|file| !file.is_empty())
        {
            let file = canonical_roster_path(file);
            if self
                .agent_id_by_session_file
                .get(&file)
                .is_some_and(|agent_id| agent_id == &entry.agent_id)
            {
                self.agent_id_by_session_file.remove(&file);
            }
        }
    }
}

/// The canonical key for a session file: lexically normalized, falling back to the raw path.
fn canonical_roster_path(path: &str) -> String {
    Path::new(path).canonicalize().map_or_else(
        |_| path.to_string(),
        |canonical| canonical.to_string_lossy().to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::daemon::agent_roster::AgentRosterStatus;
    use serde_json::json;
    use std::sync::Mutex;

    /// The store is not Sync-friendly in tests through `&mut`; the
    /// supervisor holds it behind a lock, so tests do too.
    fn locked() -> Mutex<AgentRoster> {
        let agent_dir = std::env::temp_dir().join(format!("pa-roster-{}", uuid::Uuid::new_v4()));
        let spawns = Arc::new(crate::rlm_ledger::RlmSpawnLedger::new(
            &agent_dir,
            &agent_dir.join("sessions"),
            |_| {},
        ));
        Mutex::new(AgentRoster::new(Arc::new(
            crate::usage_ledger::UsageLedger::new(&agent_dir, spawns),
        )))
    }

    fn summary(agent: &str, active: Option<&str>, file: Option<&str>) -> Value {
        json!({
            "sessionId": agent,
            "activeSessionId": active,
            "sessionFile": file,
            "activity": "idle",
        })
    }

    #[test]
    fn write_classifies_and_indexes() {
        let roster = locked();
        let mut roster = roster.lock().unwrap();
        let entry = roster.write_summary(
            summary("s1", Some("a1"), Some("/tmp/s1.jsonl")),
            Some("w1"),
            None,
        );
        assert_eq!(entry.status, AgentRosterStatus::Idle);
        assert_eq!(entry.agent_id, "s1");
        let mut working = summary("s1", Some("a1"), Some("/tmp/s1.jsonl"));
        working["activity"] = json!("working");
        let entry = roster.write_summary(working, Some("w1"), None);
        assert_eq!(entry.status, AgentRosterStatus::Running);
    }

    #[test]
    fn session_file_ownership_converges() {
        let roster = locked();
        let mut roster = roster.lock().unwrap();
        roster.write_summary(
            summary("s1", Some("a1"), Some("/tmp/shared.jsonl")),
            Some("w1"),
            None,
        );
        roster.write_summary(
            summary("s2", Some("a2"), Some("/tmp/shared.jsonl")),
            Some("w2"),
            None,
        );
        assert!(roster.get("s1").is_none());
        assert!(roster.get("s2").is_some());
        assert_eq!(roster.entries().len(), 1);
    }

    #[test]
    fn delete_is_idempotent() {
        let roster = locked();
        let mut roster = roster.lock().unwrap();
        roster.write_summary(summary("s1", Some("a1"), None), Some("w1"), None);
        roster.delete("s1");
        assert!(roster.get("s1").is_none());
        roster.delete("s1");
    }

    #[test]
    fn queued_children_classify_running_with_label() {
        let roster = locked();
        let mut roster = roster.lock().unwrap();
        let mut queued = summary("child1", None, None);
        queued["queuedChild"] = json!(true);
        let entry = roster.write_summary(queued, Some("w1"), None);
        assert_eq!(entry.status, AgentRosterStatus::Running);
        assert_eq!(entry.status_label.as_deref(), Some("queued"));
    }

    #[test]
    fn seeded_rows_carry_the_marker_and_never_double_key() {
        let roster = locked();
        let mut roster = roster.lock().unwrap();
        let seeded = roster.write_seeded(
            json!({
                "sessionId": "sub-1",
                "runtimeKind": "subagent",
                "rlmChildId": "sub-1",
                "parentSessionPath": "/tmp/parent.jsonl",
                "sessionFile": "/tmp/artifacts/sub-1.jsonl",
                "activity": "idle",
            }),
            true,
        );
        assert_eq!(seeded.status, AgentRosterStatus::Inactive);
        assert_eq!(seeded.seeded_cwd, Some(true));
        assert_eq!(seeded.worker_id, None);
        assert_eq!(seeded.agent_id, "/tmp/parent.jsonl#sub-1");
        // The session-file index answers the seed's duplicate guard (a nonexistent file keys raw).
        assert!(roster.has_session_file("/tmp/artifacts/sub-1.jsonl"));
        assert!(!roster.has_session_file("/tmp/other.jsonl"));
        let hydrated = roster.write_seeded(
            json!({
                "sessionId": "sub-1",
                "runtimeKind": "subagent",
                "rlmChildId": "sub-1",
                "parentSessionPath": "/tmp/parent.jsonl",
                "sessionFile": "/tmp/artifacts/sub-1.jsonl",
                "cwd": "/tmp/project",
                "activity": "idle",
            }),
            false,
        );
        assert_eq!(hydrated.seeded_cwd, None);
        assert_eq!(hydrated.summary["cwd"], "/tmp/project");
    }

    #[test]
    fn worker_entries_filter_by_worker() {
        let roster = locked();
        let mut roster = roster.lock().unwrap();
        roster.write_summary(summary("s1", Some("a1"), None), Some("w1"), None);
        roster.write_summary(summary("s2", Some("a2"), None), Some("w2"), None);
        let w1 = roster.entries_for_worker("w1");
        assert_eq!(w1.len(), 1);
        assert_eq!(w1[0].agent_id, "s1");
    }

    #[test]
    fn delta_sequence_gate_drops_stale_snapshots() {
        let roster = locked();
        let mut roster = roster.lock().unwrap();
        assert!(roster.accept_delta_sequence("w1", "i1", 1));
        assert!(roster.accept_delta_sequence("w1", "i1", 2));
        // A delayed older snapshot is stale: lower sequences never overwrite the newer state.
        assert!(!roster.accept_delta_sequence("w1", "i1", 1));
        assert!(!roster.accept_delta_sequence("w1", "i1", 2));
        assert!(roster.accept_delta_sequence("w1", "i1", 0));
        // Another worker's slot is independent.
        assert!(roster.accept_delta_sequence("w2", "i1", 1));

        // A new generation restarts its counter: the slot flips, the predecessor's frames drop.
        roster.note_worker_generation("w1", "i2");
        assert!(!roster.accept_delta_sequence("w1", "i1", 9_000_000));
        assert!(roster.accept_delta_sequence("w1", "i2", 1));
        assert!(roster.accept_delta_sequence("w1", "i2", 2));
        assert!(!roster.accept_delta_sequence("w1", "i2", 1));
        // A same-generation re-register keeps the slot untouched.
        roster.note_worker_generation("w1", "i2");
        assert!(!roster.accept_delta_sequence("w1", "i2", 1));
        // The stop cleanup forgets the slot: the next frame starts a fresh one.
        roster.forget_worker_sequences("w1");
        assert!(roster.accept_delta_sequence("w1", "i1", 1));
        assert!(!roster.accept_delta_sequence("w1", "i2", 1));
    }

    #[test]
    fn pull_gate_orders_authoritative_writes_by_the_snapshot_counter() {
        let roster = locked();
        let mut roster = roster.lock().unwrap();
        // A stamped ZERO counter (before the first push) starts the slot and applies.
        assert!(roster.accept_roster_pull("w1", "i1", Some(0)));
        assert!(roster.accept_delta_sequence("w1", "i1", 1));
        // An unsequenced summary (a legacy build) applies without touching the slot.
        assert!(roster.accept_roster_pull("w1", "i1", None));
        // The pull applies and raises the watermark: a delta still in
        // flight when the pull answered never overwrites the pull.
        assert!(roster.accept_roster_pull("w1", "i1", Some(5)));
        assert!(!roster.accept_delta_sequence("w1", "i1", 5));
        assert!(!roster.accept_delta_sequence("w1", "i1", 4));
        assert!(roster.accept_delta_sequence("w1", "i1", 6));
        // The raise never lowers the watermark.
        assert!(!roster.accept_roster_pull("w1", "i1", Some(3)));
        // A pull AT the applied watermark still applies: its snapshot was taken after that
        // delta stamped, so it carries the delta's change and possibly more.
        assert!(roster.accept_roster_pull("w1", "i1", Some(6)));
        // A pull below the applied watermark is stale: a delta stamped after already applied.
        assert!(roster.accept_delta_sequence("w1", "i1", 8));
        assert!(!roster.accept_roster_pull("w1", "i1", Some(7)));
        // The stamped-zero pull is sequenced like any other: a DELAYED
        // zero-counter snapshot drops instead of overwriting the newer
        // delta's state.
        assert!(!roster.accept_roster_pull("w1", "i1", Some(0)));
        // A replaced process's delayed answer drops on the generation mismatch, at any counter.
        roster.note_worker_generation("w1", "i2");
        assert!(!roster.accept_roster_pull("w1", "i1", Some(9_000_000)));
        assert!(!roster.accept_roster_pull("w1", "i1", Some(0)));
        // The replacement's own pull applies from the fresh watermark.
        assert!(roster.accept_roster_pull("w1", "i2", Some(0)));
        assert!(roster.accept_roster_pull("w1", "i2", Some(3)));
        assert!(!roster.accept_delta_sequence("w1", "i2", 3));
        assert!(roster.accept_delta_sequence("w1", "i2", 4));
    }

    #[test]
    fn replacement_watermarks_stay_bounded() {
        let roster = locked();
        let mut roster = roster.lock().unwrap();
        // Repeated replacements never grow the store: one slot per worker.
        for generation in 1..=64 {
            roster.note_worker_generation("w1", &format!("i{generation}"));
            assert!(roster.accept_delta_sequence("w1", &format!("i{generation}"), 1));
            assert!(roster.accept_roster_pull("w1", &format!("i{generation}"), Some(2)));
            assert_eq!(roster.delta_watermarks.len(), 1);
            // Every earlier generation's delayed frames and pulls drop.
            assert!(!roster.accept_delta_sequence("w1", &format!("i{}", generation - 1), 5));
            assert!(!roster.accept_roster_pull("w1", &format!("i{}", generation - 1), Some(5)));
        }
        roster.forget_worker_sequences("w1");
        assert!(roster.delta_watermarks.is_empty());
    }
}
