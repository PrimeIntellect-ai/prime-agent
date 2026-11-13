//! The supervisor-owned usage ledger: one append-only shard per session at
//! `<agent-dir>/usage-ledger/<session-id>.jsonl`, one `{"id", "usage"}` line
//! per transcript row that carried usage. The supervisor is the only writer;
//! workers read. Records are keyed by the row's entry id, so a duplicate
//! report, a reconcile racing a report, or a replay never counts twice.
//!
//! A session's total is its own shard plus the totals of every child the
//! spawn ledger ever recorded for it, tombstones included. Shards only grow
//! and spawn records are never removed, so a total never drops when a
//! subagent is deleted, archived, or restarted. Shards live apart from the
//! transcripts, so a session delete or archive never touches them.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use pa_core::session_engine::compaction_exec::{add_assistant_usage, subtract_assistant_usage};
use pa_types::ai::{Usage, UsageCost};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::rlm_ledger::{durable_session_id, RlmSpawnLedger, SpawnTree};

/// Shards live under `<agent-dir>/usage-ledger/`.
pub(crate) const USAGE_LEDGER_DIR: &str = "usage-ledger";

/// The id of the one record imported from an older build's delete snapshot
/// (a deleted child's own usage captured on its spawn-ledger tombstone).
pub(crate) const LEGACY_DELETE_SNAPSHOT_ID: &str = "legacy-delete-snapshot";

/// One shard line.
#[derive(Serialize, Deserialize)]
struct UsageRecord {
    id: String,
    usage: Usage,
}

/// One loaded shard: its real row ids (the dedupe set) and their sum, plus
/// the legacy delete snapshot when one was imported.
#[derive(Default)]
struct Shard {
    ids: HashSet<String>,
    rows: Usage,
    snapshot: Option<Usage>,
}

impl Shard {
    /// Read a shard file; a torn or malformed line (a crash mid-append tears
    /// only the last one) is skipped, and a missing file is an empty shard.
    fn read(path: &Path) -> Self {
        let mut shard = Self::default();
        if let Ok(bytes) = fs::read(path) {
            for line in String::from_utf8_lossy(&bytes).lines() {
                if let Ok(record) = serde_json::from_str::<UsageRecord>(line) {
                    shard.add(record.id, &record.usage);
                }
            }
        }
        shard
    }

    /// The session's own spend: its real rows, or the legacy snapshot while
    /// none exist. The snapshot was the transcript's own usage when it was
    /// captured, so the rows that replace it never sum to less.
    fn own(&self) -> Usage {
        if self.ids.is_empty() {
            self.snapshot.unwrap_or_default()
        } else {
            self.rows
        }
    }

    fn has(&self, id: &str) -> bool {
        if id == LEGACY_DELETE_SNAPSHOT_ID {
            self.snapshot.is_some()
        } else {
            self.ids.contains(id)
        }
    }

    fn add(&mut self, id: String, usage: &Usage) {
        if id == LEGACY_DELETE_SNAPSHOT_ID {
            self.snapshot.get_or_insert(*usage);
        } else if self.ids.insert(id) {
            add_assistant_usage(&mut self.rows, usage);
        }
    }
}

#[derive(Default)]
struct FoldState {
    /// The spawn tree the cached totals were folded over.
    tree: Option<Arc<SpawnTree>>,
    shards: HashMap<String, Shard>,
    /// `total(s) = own(s) + Σ total(child)`, kept current on every append.
    totals: HashMap<String, Usage>,
}

/// One session's spend: its own model calls, and its own plus every
/// descendant's.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct Spend {
    pub(crate) own: Usage,
    pub(crate) total: Usage,
}

/// The ledger over one agent dir. The fold (`spend`, `stamp`) only reads;
/// `record`, `reconcile`, and `reconcile_family` are the writes, and only
/// the supervisor calls them.
pub(crate) struct UsageLedger {
    dir: PathBuf,
    spawns: Arc<RlmSpawnLedger>,
    state: Mutex<FoldState>,
}

impl UsageLedger {
    pub(crate) fn new(agent_dir: &Path, spawns: Arc<RlmSpawnLedger>) -> Self {
        Self {
            dir: agent_dir.join(USAGE_LEDGER_DIR),
            spawns,
            state: Mutex::new(FoldState::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FoldState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn shard_path(&self, session_id: &str) -> PathBuf {
        self.dir.join(format!("{session_id}.jsonl"))
    }

    /// The loaded shard of one session, read from disk on first use.
    fn shard<'a>(&self, shards: &'a mut HashMap<String, Shard>, session_id: &str) -> &'a mut Shard {
        shards
            .entry(session_id.to_string())
            .or_insert_with(|| Shard::read(&self.shard_path(session_id)))
    }

    /// The current spawn tree. A changed spawn ledger drops the cached
    /// totals (they refold lazily); an unreadable one keeps the last tree,
    /// so a failed read never drops a family's spend.
    fn tree(&self, state: &mut FoldState) -> Arc<SpawnTree> {
        match self.spawns.spawn_tree() {
            Ok(tree) => {
                if !state
                    .tree
                    .as_ref()
                    .is_some_and(|cached| Arc::ptr_eq(cached, &tree))
                {
                    state.totals.clear();
                    state.tree = Some(Arc::clone(&tree));
                }
                tree
            }
            Err(_) => state.tree.clone().unwrap_or_default(),
        }
    }

    /// One session's spend, keyed by its session file's durable id: a read
    /// of the shards (each loaded once, then kept current by the appends)
    /// and the cached totals. It never writes.
    pub(crate) fn spend(&self, session_file: &Path) -> Spend {
        let Some(session_id) = durable_session_id(session_file) else {
            return Spend::default();
        };
        let mut state = self.lock();
        let tree = self.tree(&mut state);
        let total = self.total_of(&mut state, &tree, &session_id, &mut HashSet::new());
        let own = self.shard(&mut state.shards, &session_id).own();
        Spend { own, total }
    }

    /// `total(s) = own(s) + Σ total(child)` over the spawn tree, memoized in
    /// the cached totals; a cyclic (corrupt) edge is skipped.
    fn total_of(
        &self,
        state: &mut FoldState,
        tree: &SpawnTree,
        session_id: &str,
        visiting: &mut HashSet<String>,
    ) -> Usage {
        if let Some(total) = state.totals.get(session_id) {
            return *total;
        }
        let mut total = self.shard(&mut state.shards, session_id).own();
        visiting.insert(session_id.to_string());
        for child in tree.children(session_id) {
            if !visiting.contains(child) {
                let child_total = self.total_of(state, tree, child, visiting);
                add_assistant_usage(&mut total, &child_total);
            }
        }
        visiting.remove(session_id);
        state.totals.insert(session_id.to_string(), total);
        total
    }

    /// Stamp a session row's spend fields from the fold: `usage` (own) and
    /// `totalUsage` (own plus every descendant's), each absent while zero.
    pub(crate) fn stamp(&self, row: &mut Map<String, Value>, session_file: &Path) {
        let spend = self.spend(session_file);
        for (key, usage) in [("usage", spend.own), ("totalUsage", spend.total)] {
            if let Some(summary) = crate::session_usage::session_usage_summary_from(&usage) {
                row.insert(key.to_string(), json!(summary));
            } else {
                row.remove(key);
            }
        }
    }

    /// Record one usage row a worker reported. Returns the sessions whose
    /// totals moved (the session and every ancestor); empty when the row was
    /// already recorded.
    ///
    /// # Errors
    ///
    /// Returns an error when the shard append fails.
    pub(crate) fn record(&self, session_id: &str, id: &str, usage: Usage) -> Result<Vec<String>> {
        self.append(session_id, vec![(id.to_string(), usage)])
    }

    /// Bring a session's shard up to its transcript: append every usage row
    /// the shard lacks. The info sidecar's usage-row counter guards the full
    /// transcript read. A session whose transcript is gone and whose shard
    /// is empty imports the own usage an older build captured on its
    /// tombstone, once. Returns the sessions whose totals moved.
    ///
    /// # Errors
    ///
    /// Returns an error when a shard append fails.
    pub(crate) fn reconcile(&self, session_file: &Path) -> Result<Vec<String>> {
        let Some(session_id) = durable_session_id(session_file) else {
            return Ok(Vec::new());
        };
        self.reconcile_id(&session_id, session_file)
    }

    /// [`Self::reconcile`] for a session and every descendant the spawn
    /// ledger recorded: a registration, a stop, a sweep or delete that
    /// unlinks transcripts, and the listings.
    ///
    /// # Errors
    ///
    /// Returns an error when a shard append fails.
    pub(crate) fn reconcile_family(&self, session_file: &Path) -> Result<Vec<String>> {
        let Some(session_id) = durable_session_id(session_file) else {
            return Ok(Vec::new());
        };
        let tree = {
            let mut state = self.lock();
            self.tree(&mut state)
        };
        let mut moved = Vec::new();
        let mut seen = HashSet::new();
        let mut pending = vec![(session_id, session_file.to_path_buf())];
        while let Some((member, file)) = pending.pop() {
            if !seen.insert(member.clone()) {
                continue;
            }
            for session in self.reconcile_id(&member, &file)? {
                if !moved.contains(&session) {
                    moved.push(session);
                }
            }
            for child in tree.children(&member) {
                if let Some(node) = tree.node(child) {
                    pending.push((child.clone(), node.file.clone()));
                }
            }
        }
        Ok(moved)
    }

    fn reconcile_id(&self, session_id: &str, session_file: &Path) -> Result<Vec<String>> {
        // A transcript that moved after its spawn record reconciles from where
        // it lives now; only a session gone everywhere falls back to its
        // tombstone's delete snapshot.
        let live = if session_file.exists() {
            Some(session_file.to_path_buf())
        } else {
            self.spawns.resolve_live_path(session_file)?
        };
        let Some(session_file) = live else {
            let mut state = self.lock();
            let tree = self.tree(&mut state);
            let Some(snapshot) = tree
                .node(session_id)
                .and_then(|node| node.deleted_usage.as_ref())
            else {
                return Ok(Vec::new());
            };
            let shard = self.shard(&mut state.shards, session_id);
            if !shard.ids.is_empty() || shard.snapshot.is_some() {
                return Ok(Vec::new());
            }
            let usage = Usage {
                input: snapshot.input_tokens,
                output: snapshot.output_tokens,
                total_tokens: snapshot.input_tokens.saturating_add(snapshot.output_tokens),
                cost: UsageCost {
                    total: pa_types::JsNumber(snapshot.cost),
                    ..UsageCost::default()
                },
                ..Usage::default()
            };
            return self.append_locked(
                &mut state,
                &tree,
                session_id,
                vec![(LEGACY_DELETE_SNAPSHOT_ID.to_string(), usage)],
            );
        };
        let counted =
            crate::session_store::read_session_info(&session_file).map(|info| info.usage_rows);
        let recorded = self.shard(&mut self.lock().shards, session_id).ids.len() as u64;
        if counted == Some(recorded) {
            return Ok(Vec::new());
        }
        let Some(rows) = crate::session_usage::read_usage_rows(&session_file) else {
            return Ok(Vec::new());
        };
        self.append(session_id, rows)
    }

    fn append(&self, session_id: &str, rows: Vec<(String, Usage)>) -> Result<Vec<String>> {
        let mut state = self.lock();
        let tree = self.tree(&mut state);
        self.append_locked(&mut state, &tree, session_id, rows)
    }

    /// The one write path: append the rows the shard lacks (durably, before
    /// they count), then add the growth of the session's own spend to the
    /// cached totals of the session and every ancestor.
    fn append_locked(
        &self,
        state: &mut FoldState,
        tree: &SpawnTree,
        session_id: &str,
        rows: Vec<(String, Usage)>,
    ) -> Result<Vec<String>> {
        let shard = self.shard(&mut state.shards, session_id);
        let mut batch = HashSet::new();
        let fresh: Vec<UsageRecord> = rows
            .into_iter()
            .filter(|(id, _)| !shard.has(id) && batch.insert(id.clone()))
            .map(|(id, usage)| UsageRecord { id, usage })
            .collect();
        if fresh.is_empty() {
            return Ok(Vec::new());
        }
        append_records(&self.shard_path(session_id), &fresh)?;
        // The first real rows replace a legacy snapshot: the totals move by
        // the change in own spend, never by the rows' whole sum.
        let before = shard.own();
        for record in fresh {
            shard.add(record.id, &record.usage);
        }
        let mut added = shard.own();
        subtract_assistant_usage(&mut added, &before);
        let mut moved: Vec<String> = Vec::new();
        let mut current = Some(session_id.to_string());
        while let Some(member) = current {
            if moved.contains(&member) {
                break;
            }
            if let Some(total) = state.totals.get_mut(&member) {
                add_assistant_usage(total, &added);
            }
            current = tree.node(&member).map(|node| node.parent.clone());
            moved.push(member);
        }
        Ok(moved)
    }
}

/// One durable `O_APPEND` write plus `fsync`; a torn last line from a crash
/// is closed first, so the new records never glue onto it.
fn append_records(path: &Path, records: &[UsageRecord]) -> Result<()> {
    if let Some(dir) = path.parent() {
        crate::paths::ensure_dir(dir)?;
    }
    let mut bytes = Vec::new();
    for record in records {
        serde_json::to_writer(&mut bytes, record)?;
        bytes.push(b'\n');
    }
    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(path)
        .with_context(|| format!("open usage ledger shard {}", path.display()))?;
    if file.metadata()?.len() > 0 {
        let mut last = [0u8; 1];
        file.seek(SeekFrom::End(-1))?;
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            bytes.insert(0, b'\n');
        }
    }
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(cost: f64) -> Usage {
        Usage {
            input: 10,
            output: 1,
            total_tokens: 11,
            cost: UsageCost {
                total: pa_types::JsNumber(cost),
                ..UsageCost::default()
            },
            ..Usage::default()
        }
    }

    /// One billed assistant turn appended to a transcript (the header first).
    fn append_turn(path: &Path, row_id: &str, cost: f64) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut lines = String::new();
        if !path.exists() {
            lines.push_str(r#"{"type":"session","version":3,"id":"s","timestamp":"t","cwd":"/c"}"#);
            lines.push('\n');
        }
        lines.push_str(
            &json!({
                "type": "message", "id": row_id, "parentId": null, "timestamp": "t",
                "message": {"role": "assistant", "content": [], "stopReason": "stop",
                    "timestamp": 1, "usage": usage(cost)},
            })
            .to_string(),
        );
        lines.push('\n');
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap()
            .write_all(lines.as_bytes())
            .unwrap();
    }

    struct Home {
        _dir: tempfile::TempDir,
        agent: PathBuf,
        root: PathBuf,
        child: PathBuf,
        spawns: Arc<RlmSpawnLedger>,
    }

    /// An agent dir with one spawn record root -> child.
    fn home() -> Home {
        let dir = tempfile::TempDir::new().unwrap();
        let agent = dir.path().join("agent");
        let root = agent.join("sessions/root.jsonl");
        let child = agent.join("session-artifacts/root/sub-c/child.jsonl");
        let spawns = Arc::new(RlmSpawnLedger::new(&agent, &agent.join("sessions"), |_| {}));
        spawns
            .append_spawn(&crate::rlm_ledger::RlmSpawnInput {
                child_id: "sub-c".to_string(),
                parent: root.to_string_lossy().into_owned(),
                child: child.to_string_lossy().into_owned(),
                depth: 1,
                name: "c".to_string(),
                factory: None,
            })
            .unwrap();
        Home {
            _dir: dir,
            agent,
            root,
            child,
            spawns,
        }
    }

    fn root_total(home: &Home, ledger: &UsageLedger) -> f64 {
        ledger.spend(&home.root).total.cost.total.as_f64()
    }

    /// (e) A duplicate report, a reconcile racing a report, a reconcile after a
    /// crash, and a torn shard tail never count a row twice.
    #[test]
    fn a_row_never_counts_twice() {
        let home = home();
        append_turn(&home.root, "r1", 1.0);
        append_turn(&home.child, "c1", 0.5);
        let ledger = UsageLedger::new(&home.agent, Arc::clone(&home.spawns));
        assert!(
            root_total(&home, &ledger).abs() < 1e-12,
            "the fold only reads"
        );
        ledger.reconcile_family(&home.root).unwrap();
        assert!((root_total(&home, &ledger) - 1.5).abs() < 1e-9);

        // The worker's report of a row the reconcile already recorded, and
        // its duplicate.
        assert!(ledger.record("child", "c1", usage(0.5)).unwrap().is_empty());
        assert!(ledger.record("child", "c1", usage(0.5)).unwrap().is_empty());
        // A reconcile racing the report finds nothing to add.
        assert!(ledger.reconcile(&home.child).unwrap().is_empty());
        assert!((root_total(&home, &ledger) - 1.5).abs() < 1e-9);

        // A crash between the append and the report: the reconcile adds the
        // row once, and the late report adds nothing.
        append_turn(&home.child, "c2", 0.25);
        assert_eq!(
            ledger.reconcile(&home.child).unwrap(),
            vec!["child".to_string(), "root".to_string()]
        );
        assert!(ledger.reconcile(&home.child).unwrap().is_empty());
        assert!(ledger
            .record("child", "c2", usage(0.25))
            .unwrap()
            .is_empty());
        assert!((root_total(&home, &ledger) - 1.75).abs() < 1e-9);

        // A crash mid-append tears the shard's last line: the restarted
        // ledger skips it, and the next record starts on a fresh line.
        let shard = home.agent.join(USAGE_LEDGER_DIR).join("child.jsonl");
        OpenOptions::new()
            .append(true)
            .open(&shard)
            .unwrap()
            .write_all(br#"{"id":"c3","usa"#)
            .unwrap();
        let restarted = UsageLedger::new(&home.agent, Arc::clone(&home.spawns));
        assert!((root_total(&home, &restarted) - 1.75).abs() < 1e-9);
        restarted.record("child", "c3", usage(0.125)).unwrap();
        let reread = UsageLedger::new(&home.agent, Arc::clone(&home.spawns));
        assert!((root_total(&home, &reread) - 1.875).abs() < 1e-9);
    }

    /// A legacy family (transcripts from before the ledger): a transcript with
    /// no shard reconciles to its real usage, and a deleted child whose
    /// transcript is gone imports its tombstone's captured usage once.
    #[test]
    fn a_legacy_family_reconciles_and_imports_a_delete_snapshot_once() {
        let home = home();
        append_turn(&home.root, "r1", 1.0);
        // An older build's delete record: the captured own usage rides the
        // tombstone, and the child's transcript is gone.
        let child = crate::lease::canonical_session_path(&home.child);
        let mut file = OpenOptions::new()
            .append(true)
            .open(home.spawns.ledger_path())
            .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "v": 1, "op": "delete", "at": "t", "childId": "sub-c",
                "child": child.to_string_lossy(), "reason": "user",
                "usage": {"inputTokens": 30, "outputTokens": 3, "cost": 0.3},
            })
        )
        .unwrap();
        drop(file);
        let ledger = UsageLedger::new(&home.agent, Arc::clone(&home.spawns));
        assert!(!ledger.reconcile_family(&home.root).unwrap().is_empty());
        let spend = ledger.spend(&home.root);
        assert!((spend.own.cost.total.as_f64() - 1.0).abs() < 1e-9);
        assert!((spend.total.cost.total.as_f64() - 1.3).abs() < 1e-9);
        assert!(ledger.reconcile_family(&home.root).unwrap().is_empty());
        let restarted = UsageLedger::new(&home.agent, Arc::clone(&home.spawns));
        assert!((root_total(&home, &restarted) - 1.3).abs() < 1e-9);
        let shard =
            fs::read_to_string(home.agent.join(USAGE_LEDGER_DIR).join("child.jsonl")).unwrap();
        assert_eq!(shard.lines().count(), 1, "{shard}");
        assert!(shard.contains(LEGACY_DELETE_SNAPSHOT_ID), "{shard}");
    }

    /// A child whose transcript moved after its spawn record (the spawn
    /// ledger's live resolver finds it by its durable session id) reconciles
    /// its real rows into the root's total.
    #[test]
    fn a_moved_child_transcript_reconciles_from_where_it_lives() {
        let home = home();
        append_turn(&home.root, "r1", 1.0);
        append_turn(&home.agent.join("sessions/child.jsonl"), "c1", 0.5);
        let ledger = UsageLedger::new(&home.agent, Arc::clone(&home.spawns));
        ledger.reconcile_family(&home.root).unwrap();
        assert!((root_total(&home, &ledger) - 1.5).abs() < 1e-9);
    }

    /// A legacy child's delete snapshot bills until its transcript reappears;
    /// the real rows then replace it without a double count or a drop, and
    /// later rows add exactly once.
    #[test]
    fn real_rows_replace_a_legacy_delete_snapshot() {
        let home = home();
        append_turn(&home.root, "r1", 1.0);
        let child = crate::lease::canonical_session_path(&home.child);
        let mut file = OpenOptions::new()
            .append(true)
            .open(home.spawns.ledger_path())
            .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "v": 1, "op": "delete", "at": "t", "childId": "sub-c",
                "child": child.to_string_lossy(), "reason": "user",
                "usage": {"inputTokens": 10, "outputTokens": 1, "cost": 0.5},
            })
        )
        .unwrap();
        drop(file);
        let ledger = UsageLedger::new(&home.agent, Arc::clone(&home.spawns));
        ledger.reconcile_family(&home.root).unwrap();
        assert!((root_total(&home, &ledger) - 1.5).abs() < 1e-9);

        append_turn(&home.child, "c1", 0.5);
        ledger.reconcile_family(&home.root).unwrap();
        assert!((root_total(&home, &ledger) - 1.5).abs() < 1e-9);
        append_turn(&home.child, "c2", 0.25);
        ledger.reconcile_family(&home.root).unwrap();
        assert!((root_total(&home, &ledger) - 1.75).abs() < 1e-9);
        assert!(ledger.reconcile_family(&home.root).unwrap().is_empty());
        let restarted = UsageLedger::new(&home.agent, Arc::clone(&home.spawns));
        assert!((root_total(&home, &restarted) - 1.75).abs() < 1e-9);
    }
}
