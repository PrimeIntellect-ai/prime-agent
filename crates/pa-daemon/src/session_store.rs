//! Append-only session store on disk.
//!
//! Port of the session-file layout of `core/session-manager.ts`: one JSONL file
//! per session under `<agent-dir>/sessions/<uuid>.jsonl`, first line is the
//! `session` header, entries form a parent-id chain (tree). Layout compatibility
//! with the TS product is load-bearing: TUI reattach, checkpoint/resume, and
//! external tooling read the same files.

use anyhow::{anyhow, Context, Result};
use pa_types::ai::Usage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};

#[cfg(test)]
#[path = "session_store_info_tests.rs"]
mod info_tests;
#[cfg(test)]
#[path = "session_store_stream_tests.rs"]
mod stream_tests;

#[cfg(test)]
#[path = "session_store_window_tests.rs"]
mod window_tests;

// The index concern (the entry-chain index maintenance: the push-side
// by_id/leaf_id bookkeeping, the child-usage attribution folds, and the
// entry-id mint) moved to the child module at the same tree position
// (session_store::index); the facade re-imports keep the bare-path callers
// in scope (the read/write arms and the stream equivalence tests).
mod index;

use index::fold_child_usage_attributions;
pub(crate) use index::new_entry_id;

// The read arm (the file-IO load surface: the streamed and windowed
// opens, the bounded header-only readers, the file-layout helpers, and the
// in-memory create) moved to the child module at the same tree position
// (session_store::read); the facade re-exports keep the crate paths
// stable (session_scan.rs, rlm_ledger.rs, session_archive.rs,
// agent_engine/model.rs, worker/tests.rs).
mod read;

pub use read::{
    is_valid_session_file, parse_session_entries, read_session_header, read_session_header_bounded,
    session_file_name, SESSION_LIST_HEADER_READ_MAX_BYTES,
};
pub(crate) use read::{
    parse_session_header_line, read_first_line_bounded, read_first_line_bounded_from,
};

// The write arm (the in-memory append family, the atomic full-file
// rewrite, the durable persist paths, and the store lease discipline that
// serializes writers onto the file) moved to the child module at the same
// tree position (session_store::write); the facade re-export keeps the
// header-line API path stable for the rewrite arm and the unit battery.
mod write;

pub use write::session_header_line;

// The loaded-session view (the branch walks, the window/settings reads,
// the compacted message fold and its scalars, and the wire-shape message
// helpers) moved to the child module at the same tree position
// (session_store::view); the facade bindings keep the bare-path callers in
// scope (the read arm's windowed open, the info scan's state fold, and the
// test children).
mod view;

use view::{message_text, normalize_state_status};

// The message-role helper's remaining bare-path callers are the test
// children; the binding rides the test builds only.
#[cfg(test)]
use view::message_role;

// The per-file info scan (the resumable listing fold: the generation
// identity, the LRU-bounded scan-state cache, the resumed line fold, and
// the derived SessionInfo) moved to the child module at the same tree
// position (session_store::info); the facade re-exports keep the crate
// paths stable (rlm_roster.rs, session_catalog.rs, scheduling_catalog.rs,
// saved_session_commands.rs, session_scan.rs, messaging.rs, revival_gate.rs,
// scheduled_jobs.rs, stop_cleanup.rs, supervisor/sessions.rs), and the
// test-scoped binding keeps the scan internals' test callers in scope.
mod info;

pub(crate) use info::read_session_info_from;
#[cfg(test)]
use info::{
    append_capped_search_text, fold_scan_entry, message_content_text, raw_string, raw_u64,
    session_info_cache, SessionInfoEntry, SessionInfoGeneration, SessionInfoScanCache,
    SessionScanAccumulator, SessionScanState, SESSION_SCAN_MAX_CACHED_STATES,
    SESSION_SCAN_RESUME_TAIL_BYTES,
};
pub use info::{
    find_most_recent_session_for_cwd, read_session_info, SessionInfo,
    SESSION_LIST_SEARCH_TEXT_MAX_CHARS,
};

pub use pa_types::session::SessionHeader;

/// The roster scan lives in `session_scan` (the bounded-header reshape of
/// the listing loop); re-exported for the listing call sites.
pub use crate::session_scan::list_sessions;

/// One stored entry: message lifecycle, bookkeeping, or a custom record.
/// Fields beyond the entry envelope are preserved as raw JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    #[serde(rename = "type")]
    pub type_: String,
    pub id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub timestamp: String,
    #[serde(flatten)]
    pub fields: Value,
}

/// The windowed message sequence's summary scalars (TS
/// `summaryForActiveSession`): the newest message timestamp, the summed
/// assistant usage, and the window's message count. Produced by
/// [`SessionFile::scan_message_scalars`] without materializing the fold.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct MessageWindowScalars {
    /// The timestamp of the last windowed message that carries one (the
    /// fold's reverse `find_map`, preserved in walk order).
    pub last_timestamp_ms: Option<u64>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost: f64,
    pub message_count: usize,
}

/// A loaded session: header plus the full entry chain, indexed by id.
#[derive(Debug, Clone)]
pub struct SessionFile {
    pub path: PathBuf,
    pub header: SessionHeader,
    pub(crate) entries: Vec<SessionEntry>,
    pub(crate) by_id: HashMap<String, usize>,
    pub(crate) leaf_id: Option<String>,
    pub(crate) window: Option<SessionWindow>,
    pub(crate) lease: Option<std::sync::Arc<crate::lease::SessionLease>>,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionWindow {
    message_count: usize,
    first_message: Option<String>,
    loaded_entries: usize,
    compaction_count: usize,
    has_thinking_level: bool,
    has_service_tier: bool,
    model: Option<(String, String)>,
    /// The model in effect at the retained-window boundary (the newest
    /// `model_change` in the discarded prefix): the per-model usage fold's
    /// timeline seed — `model` above is the leaf's model, not the
    /// boundary's.
    boundary_model: Option<(String, String)>,
    thinking_level: String,
    service_tier: Option<pa_types::ai::ServiceTier>,
    retained_ids: std::collections::HashSet<String>,
    /// The discarded prefix's on-chain spend (attribution-folded — the
    /// window walk's older-path stats): the active stats add it when no
    /// compaction bounds the region (the prefix rows are in the kept
    /// region then — a window is a load optimization, not session state).
    pub(crate) older_path_stats: pa_core::session::window::WindowStats,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pa-daemon-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The captured-attribution fixture: real devbox session rows
    /// (content sanitized; ids, timestamps, and usage verbatim) — six
    /// `child_usage_attributed` entries target one assistant row.
    fn captured_attribution_fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/attribution-fold-captured.jsonl")
    }

    #[test]
    fn bounded_header_matches_the_line_read() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/repo", None, 0);
        session.append_message(json!({"role": "user", "content": "hi", "timestamp": 1u64}));
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        assert_eq!(
            read_session_header_bounded(&path),
            read_session_header(&path)
        );
        assert!(is_valid_session_file(&path));
    }

    #[test]
    fn bounded_header_rejects_a_non_json_first_line() {
        let dir = temp_dir();
        let path = dir.join("bad.jsonl");
        fs::write(&path, "truncated junk without json\n").unwrap();
        assert_eq!(read_session_header_bounded(&path), None);
        assert!(!is_valid_session_file(&path));
    }

    #[test]
    fn bounded_header_refuses_an_over_long_first_line() {
        let dir = temp_dir();
        // A cwd long enough to push the serialized header past the 512-byte
        // bound: the bounded read judges nothing; the line read still does.
        let mut session = SessionFile::create(&format!("/repo/{}", "x".repeat(600)), None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        assert_eq!(read_session_header_bounded(&path), None);
        assert!(read_session_header(&path).is_some());
    }

    #[test]
    fn bounded_header_reads_an_unterminated_first_line() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/repo", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        let header_line = fs::read_to_string(&path).unwrap();
        fs::write(&path, header_line.trim_end()).unwrap();
        assert_eq!(
            read_session_header_bounded(&path),
            read_session_header(&path)
        );
    }

    #[test]
    fn bounded_header_strips_a_crlf_line_return() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/repo", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        let header_line = fs::read_to_string(&path).unwrap();
        fs::write(&path, format!("{}\r\n", header_line.trim_end())).unwrap();
        assert_eq!(
            read_session_header_bounded(&path),
            read_session_header(&path)
        );
    }

    #[test]
    fn bounded_header_treats_an_empty_file_as_headerless() {
        let dir = temp_dir();
        let path = dir.join("empty.jsonl");
        fs::write(&path, "").unwrap();
        assert_eq!(read_session_header_bounded(&path), None);
        assert!(!is_valid_session_file(&path));
    }

    #[test]
    fn open_folds_captured_child_usage_attributions() {
        let store = SessionFile::open(&captured_attribution_fixture()).unwrap();
        // The raw file row: input 2690 / totalTokens 23032 / cost $0. The
        // last attribution's cumulative aggregate replaces it (TS
        // `applyChildUsageAttributions`): input 52898 / totalTokens 23032
        // (unchanged — the aggregate keeps the row's context size) / cost
        // $0.0089957. Six entries fold once, never sum.
        let assistant = store.entry("4f61089a").expect("captured target row");
        let usage = &assistant.fields["message"]["usage"];
        assert_eq!(usage["input"], json!(52898));
        assert_eq!(usage["output"], json!(5863));
        assert_eq!(usage["cacheRead"], json!(18560));
        assert_eq!(usage["cacheWrite"], json!(0));
        assert_eq!(usage["totalTokens"], json!(23032));
        assert_eq!(usage["cost"]["total"].as_f64(), Some(0.008_995_7));
    }

    #[test]
    fn append_entry_folds_a_live_child_usage_attribution() {
        let mut store = SessionFile::create("/tmp", None, 0);
        store.append_message(json!({"role": "user", "content": "hi", "timestamp": 1u64}));
        let assistant = store.append_message(json!({
            "role": "assistant", "content": "hello", "provider": "p", "model": "m",
            "timestamp": 2u64,
            "usage": {"input": 10, "output": 2, "cacheRead": 0, "cacheWrite": 0,
                      "totalTokens": 12,
                      "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
        }));
        store.append_entry(
            "child_usage_attributed",
            json!({
                "targetId": assistant,
                "origin": "spawn_task",
                "childUsage": {"input": 5, "output": 1, "cacheRead": 0, "cacheWrite": 0,
                               "totalTokens": 6,
                               "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.01}},
                "aggregateUsage": {"input": 15, "output": 3, "cacheRead": 0, "cacheWrite": 0,
                                   "totalTokens": 12,
                                   "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.01}},
            }),
        );
        // The live seam folds without a reopen (TS
        // `SessionManager.append_child_usage_attribution` folds after the
        // durable append).
        let row = store.entry(&assistant).unwrap();
        assert_eq!(row.fields["message"]["usage"]["input"], json!(15));
        assert_eq!(row.fields["message"]["usage"]["output"], json!(3));
        assert_eq!(row.fields["message"]["usage"]["totalTokens"], json!(12));
        assert_eq!(
            row.fields["message"]["usage"]["cost"]["total"].as_f64(),
            Some(0.01)
        );
    }

    #[test]
    fn a_malformed_aggregate_does_not_zero_the_target_row() {
        let mut store = SessionFile::create("/tmp", None, 0);
        store.append_message(json!({"role": "user", "content": "hi", "timestamp": 1u64}));
        let assistant = store.append_message(json!({
            "role": "assistant", "content": "hello", "provider": "p", "model": "m",
            "timestamp": 2u64,
            "usage": {"input": 10, "output": 2, "cacheRead": 0, "cacheWrite": 0,
                      "totalTokens": 12,
                      "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
        }));
        // A malformed aggregate (null / a scalar) must not overwrite the
        // row's valid usage with nothing — the fold skips it, exactly like
        // the typed session reader rejects invalid attribution payloads.
        store.append_entry(
            "child_usage_attributed",
            json!({"targetId": assistant, "origin": "spawn_task", "aggregateUsage": null}),
        );
        store.append_entry(
            "child_usage_attributed",
            json!({"targetId": assistant, "origin": "direct_user", "aggregateUsage": 42}),
        );
        let row = store.entry(&assistant).unwrap();
        assert_eq!(row.fields["message"]["usage"]["input"], json!(10));
        assert_eq!(row.fields["message"]["usage"]["totalTokens"], json!(12));
    }

    /// The depth-2 chain (the Macroscope #2671 thread's design pin): a
    /// child session file carrying its OWN grandchild attributions (the
    /// child spawned a child) opens FOLDED — the end-of-load fold replaces
    /// the target assistant row's usage with the newest cumulative
    /// aggregate — and the observer walk (`child_usage_batches` over the
    /// OPENED store) reports the FOLDED aggregate to the root: the
    /// grandchild's billable spend reaches the root parent exactly like
    /// the TS in-process fold does.
    #[test]
    fn the_depth_two_chain_reports_the_folded_aggregate() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("depth-two.jsonl");
        let row = |id: &str, parent: Option<&str>, message: Value| {
            json!({
                "type": "message", "id": id, "parentId": parent,
                "timestamp": "2026-09-24T00:00:00.000Z",
                "message": message,
            })
            .to_string()
        };
        let assistant_usage = json!({
            "input": 1_000, "output": 40, "cacheRead": 0, "cacheWrite": 0,
            "totalTokens": 1_040,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.10 },
        });
        let lines = [
            json!({"type": "session", "version": 3, "id": "child-s1", "timestamp": "2026-09-24T00:00:00.000Z", "cwd": "/tmp"}).to_string(),
            row("u1", None, json!({"role": "user", "content": "task"})),
            row(
                "a1",
                Some("u1"),
                json!({
                    "role": "assistant",
                    "provider": "prime-inference", "model": "internal/glm-5.3-fast",
                    "content": [{ "type": "text", "text": "hi" }],
                    "stopReason": "stop",
                    "usage": assistant_usage,
                }),
            ),
            // The grandchild's attribution into the child's spawning row: the
            // cumulative aggregate (raw + grandchild spend) that the fold
            // installs at load.
            json!({
                "type": "child_usage_attributed", "id": "attr1", "parentId": "a1",
                "timestamp": "2026-09-24T00:00:01.000Z",
                "targetId": "a1", "origin": "spawn_task",
                "childUsage": { "input": 500, "output": 10, "cacheRead": 0, "cacheWrite": 0,
                                "totalTokens": 510,
                                "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.05 } },
                "aggregateUsage": { "input": 1_500, "output": 50, "cacheRead": 0, "cacheWrite": 0,
                                    "totalTokens": 1_040,
                                    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.15 } },
            })
            .to_string(),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        // The fold applies at open (TS applyChildUsageAttributions).
        let store = SessionFile::open(&path).unwrap();
        let folded = store.entry("a1").expect("the target row");
        assert_eq!(
            folded.fields["message"]["usage"]["input"],
            json!(1_500),
            "the end-of-load fold installed the cumulative aggregate"
        );
        // The observer walk reads the FOLDED store: the depth-2 batch the
        // root receives carries the grandchild's spend (input 1,500 — the
        // raw 1,000 would mean the grandchild vanished at depth 2).
        let (batches, next) = crate::rlm_child_usage::child_usage_batches(store.entries(), 0);
        assert_eq!(next, store.entries().len(), "the walk consumes the file");
        let spawn = batches
            .iter()
            .find(|(origin, _)| matches!(origin, pa_types::session::ChildUsageOrigin::SpawnTask))
            .expect("the spawning turn's batch");
        assert_eq!(
            spawn.1.input, 1_500,
            "the folded aggregate rides the report"
        );
        assert_eq!(spawn.1.cost.total, pa_types::JsNumber(0.15));
    }

    #[test]
    fn creates_and_loads_a_session() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.append_session_state("active");
        session.append_message(json!({"role": "user", "content": "hi", "timestamp": 1u64}));
        session.append_message(json!({"role": "assistant", "content": "hello", "provider": "p", "model": "m", "timestamp": 2u64}));
        session.rewrite().unwrap();

        let loaded = SessionFile::open(&path).unwrap();
        assert_eq!(loaded.session_id(), session.session_id());
        assert_eq!(loaded.message_count(), 2);
        assert_eq!(loaded.state().as_deref(), Some("active"));
        let messages = loaded.messages();
        assert_eq!(messages.len(), 2);
        assert_eq!(crate::types::message_text(&messages[0]), "hi");

        let info = read_session_info(&path).unwrap();
        assert_eq!(info.message_count, 2);
        assert_eq!(info.first_message, "hi");
        assert_eq!(
            info.model.as_ref().map(|(p, m)| (p.as_str(), m.as_str())),
            Some(("p", "m"))
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A corrupt file can hold a parent cycle; the branch walk must
    /// terminate anyway (the same guard `build_session_context` has). The
    /// session-model restore reads the branch through this walk, so a
    /// cyclic file would otherwise hang the create's blocking task.
    #[test]
    fn a_cyclic_parent_chain_terminates_the_branch_walk() {
        let mut session = SessionFile::create("/tmp", None, 0);
        session.append_message(json!({"role": "user", "content": "a", "timestamp": 1u64}));
        session.append_message(json!({"role": "user", "content": "b", "timestamp": 2u64}));
        // Forge the cycle: the two entries point at each other.
        let first = session.entries[0].id.clone();
        let second = session.entries[1].id.clone();
        session.entries[0].parent_id = Some(second);
        session.entries[1].parent_id = Some(first);
        let branch = session.branch();
        assert!(
            branch.len() <= 2,
            "the cyclic walk terminates: {:?}",
            branch
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>()
        );
        // The root-to-leaf typed walk (the restore's reader) terminates too.
        let typed = session.branch_file_entries();
        assert!(typed.len() <= 2, "branch_file_entries terminates");
    }

    /// The persisted thinking level (`thinking_level_change`): the last
    /// entry wins, like the model; a malformed or empty level never
    /// replaces a prior good one.
    #[test]
    fn scan_keeps_the_latest_persisted_thinking_level() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.append_thinking_level_change("medium");
        session.append_thinking_level_change("high");
        session.rewrite().unwrap();
        let info = read_session_info(&path).unwrap();
        assert_eq!(info.thinking_level.as_deref(), Some("high"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A failed append leaves the store unchanged: the in-memory index
    /// only adopts entries the file accepted, so the next append parents
    /// to the last persisted entry and the reloaded file stays walkable.
    #[test]
    fn failed_persist_keeps_the_store_walkable() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let file = dir.join(session_file_name(session.session_id()));
        session.set_path(file.clone());
        let first = session
            .persist_entry(
                "message",
                json!({ "message": { "role": "user", "content": "hi" } }),
            )
            .unwrap();
        let blocker = dir.join("blocked");
        fs::create_dir_all(&blocker).unwrap();
        session.set_path(blocker);
        assert!(session
            .persist_entry(
                "message",
                json!({ "message": { "role": "user", "content": "x" } })
            )
            .is_err());
        assert_eq!(
            session.entries().len(),
            1,
            "only the persisted entry stays indexed"
        );
        assert_eq!(session.leaf_id(), Some(first.as_str()));
        session.set_path(file.clone());
        let third = session
            .persist_entry(
                "message",
                json!({ "message": { "role": "user", "content": "again" } }),
            )
            .unwrap();
        // The reloaded file chains first -> third: the failed append added
        // nothing to the file, so the next one chains from the last
        // persisted entry.
        let loaded = SessionFile::open(&file).unwrap();
        let chain: Vec<&str> = loaded
            .branch()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(chain, [first.as_str(), third.as_str()]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// The replay's dedup predicate is the disclosure row's fields: the
    /// create handler recognizes the exact row wherever it came from —
    /// this replacement's own declaration-stamped persist, an earlier
    /// crash-replay's identical row, or the dead worker's own abort arm
    /// (the same fields carrying the worker's persist-time stamp) — and
    /// appends nothing. A different disclosure (another reason or
    /// outcome) stays distinct.
    #[test]
    fn declaration_stamped_entry_survives_reload_as_the_same_identity() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let file = dir.join(session_file_name(session.session_id()));
        session.set_path(file.clone());
        let disclosure = json!({
            "customType": "compaction_outcome",
            "content": "Compaction cancelled",
            "display": true,
            "details": { "reason": "threshold", "outcome": "cancelled" },
        });
        let declared_at = "2026-09-23T06:00:00Z";
        session
            .persist_entry_at("custom_message", disclosure.clone(), declared_at)
            .unwrap();

        // The rebuilt transcript (a fresh open) holds the exact row: the
        // replay's fields-only dedup matches it — the declaration stamp
        // and any other stamp alike — so the row is not appended twice.
        let loaded = SessionFile::open(&file).unwrap();
        let already_disclosed =
            |entry: &SessionEntry| entry.type_ == "custom_message" && entry.fields == disclosure;
        assert!(loaded.entries().iter().any(already_disclosed));

        // The worker's own abort arm carries the same fields under its own
        // persist-time stamp: still the same disclosure, still not a
        // duplicate.
        let mut with_own_row = SessionFile::open(&file).unwrap();
        with_own_row
            .persist_entry("custom_message", disclosure.clone())
            .unwrap();
        assert!(with_own_row.entries().iter().any(already_disclosed));

        // A different disclosure (a failed run's row) stays distinct.
        let failed = json!({
            "customType": "compaction_outcome",
            "content": "Compaction failed: Summarization failed",
            "display": true,
            "details": { "reason": "threshold", "outcome": "failed" },
        });
        assert!(!loaded
            .entries()
            .iter()
            .any(|entry| entry.type_ == "custom_message" && entry.fields == failed));
        let _ = fs::remove_dir_all(&dir);
    }

    /// `branch_bridged` reconstructs the intended chain across a
    /// ghost-parent gap: the missing id was minted but never persisted, so
    /// the walk continues from the gap entry's file predecessor (the
    /// writer's leaf at the time).
    #[test]
    fn branch_bridged_bridges_ghost_parent_gaps() {
        let dir = temp_dir();
        let path = dir.join("ghosted.jsonl");
        let content = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
            json!({"type": "message", "id": "e1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "hi"}}),
            json!({"type": "session_state", "id": "e2", "parentId": "e1", "timestamp": "2026-09-22T00:00:02.000Z", "state": {"status": "active"}}),
            json!({"type": "message", "id": "e3", "parentId": "8b5f0d21", "timestamp": "2026-09-22T00:00:03.000Z", "message": {"role": "user", "content": "after the gap"}}),
            json!({"type": "message", "id": "e4", "parentId": "e3", "timestamp": "2026-09-22T00:00:04.000Z", "message": {"role": "assistant", "content": "ok"}}),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
        fs::write(&path, content).unwrap();
        let store = SessionFile::open(&path).unwrap();
        let strict: Vec<&str> = store
            .branch()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(
            strict,
            ["e3", "e4"],
            "the strict walk truncates at the ghost"
        );
        let bridged: Vec<&str> = store
            .branch_bridged()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(bridged, ["e1", "e2", "e3", "e4"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A gap after a persisted branch move follows the active lineage:
    /// the `branch_summary` marker is the gap entry's file predecessor
    /// and chains from the moved-to entry, so the bridged walk keeps the
    /// active branch and skips the abandoned fork.
    #[test]
    fn branch_bridged_skips_abandoned_chains_after_a_persisted_branch_move() {
        let dir = temp_dir();
        let path = dir.join("moved.jsonl");
        let content = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
            json!({"type": "message", "id": "e1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "root"}}),
            json!({"type": "message", "id": "e2", "parentId": "e1", "timestamp": "2026-09-22T00:00:02.000Z", "message": {"role": "user", "content": "abandoned a"}}),
            json!({"type": "message", "id": "e3", "parentId": "e2", "timestamp": "2026-09-22T00:00:03.000Z", "message": {"role": "user", "content": "abandoned b"}}),
            json!({"type": "branch_summary", "id": "m1", "parentId": "e1", "timestamp": "2026-09-22T00:00:04.000Z", "fromId": "e1", "summary": "moved back"}),
            json!({"type": "message", "id": "e4", "parentId": "8b5f0d21", "timestamp": "2026-09-22T00:00:05.000Z", "message": {"role": "user", "content": "after the move"}}),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
        fs::write(&path, content).unwrap();
        let store = SessionFile::open(&path).unwrap();
        let bridged: Vec<&str> = store
            .branch_bridged()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(bridged, ["e1", "m1", "e4"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A clean file bridges nothing: the bridged walk equals the strict
    /// walk, and forked-off entries stay excluded (they resolve by parent
    /// id; only a MISSING parent bridges).
    #[test]
    fn branch_bridged_matches_the_strict_walk_on_clean_files() {
        let dir = temp_dir();
        let path = dir.join("clean.jsonl");
        let content = [
            json!({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-09-22T00:00:00.000Z", "cwd": "/tmp"}),
            json!({"type": "message", "id": "e1", "parentId": null, "timestamp": "2026-09-22T00:00:01.000Z", "message": {"role": "user", "content": "root"}}),
            json!({"type": "message", "id": "fork", "parentId": "e1", "timestamp": "2026-09-22T00:00:02.000Z", "message": {"role": "user", "content": "forked away"}}),
            json!({"type": "message", "id": "e2", "parentId": "e1", "timestamp": "2026-09-22T00:00:03.000Z", "message": {"role": "assistant", "content": "leaf chain"}}),
        ]
        .iter()
        .map(std::string::ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
        fs::write(&path, content).unwrap();
        let store = SessionFile::open(&path).unwrap();
        let strict: Vec<&str> = store
            .branch()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        let bridged: Vec<&str> = store
            .branch_bridged()
            .iter()
            .map(|entry| entry.id.as_str())
            .collect();
        assert_eq!(strict, bridged);
        assert_eq!(strict, ["e1", "e2"], "the fork stays off the leaf chain");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_builds_transcript_search_text() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.append_message(
            json!({"role": "user", "content": "fix the login bug", "timestamp": 1u64}),
        );
        session.append_message(json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "fixed in auth.rs" }],
            "provider": "p", "model": "m", "timestamp": 2u64
        }));
        // Tool traffic is counted but never enters the search corpus.
        session.append_message(
            json!({"role": "toolResult", "content": "tool noise", "timestamp": 3u64}),
        );
        session.rewrite().unwrap();

        let info = read_session_info(&path).unwrap();
        assert_eq!(info.all_messages_text, "fix the login bug fixed in auth.rs");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The saved-row usage summary folds like the TS scan: raw assistant
    /// usage keyed by entry id, the latest attribution aggregate replacing
    /// the raw block, every child block accumulating, summarization usage
    /// added, and the child spend subtracted — the child's own row carries
    /// it, so rollups never double count. `session_usage`'s tests pin the
    /// fold unit-by-unit; this pins the listing scan's wiring.
    #[test]
    fn scan_folds_the_saved_row_usage_summary() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        let assistant_id = session.append_message(json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "run it" }],
            "provider": "p", "model": "m", "timestamp": 1u64,
            "usage": {
                "input": 100, "output": 10, "cacheRead": 20, "cacheWrite": 0,
                "totalTokens": 130,
                "cost": { "input": 0.0, "output": 0.5, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.5 }
            }
        }));
        session.append_entry(
            "child_usage_attributed",
            json!({
                "targetId": assistant_id, "origin": "spawn_task",
                "childUsage": {
                    "input": 30, "output": 3, "cacheRead": 0, "cacheWrite": 0,
                    "totalTokens": 33,
                    "cost": { "input": 0.0, "output": 0.125, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.125 }
                },
                "aggregateUsage": {
                    "input": 130, "output": 13, "cacheRead": 20, "cacheWrite": 0,
                    "totalTokens": 163,
                    "cost": { "input": 0.0, "output": 0.5, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.5 }
                }
            }),
        );
        session.append_entry(
            "compaction",
            json!({
                "summary": "kept", "firstKeptEntryId": assistant_id, "tokensBefore": 100,
                "usage": {
                    "input": 50, "output": 5, "cacheRead": 0, "cacheWrite": 0,
                    "totalTokens": 55,
                    "cost": { "input": 0.0, "output": 0.25, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.25 }
                }
            }),
        );
        session.rewrite().unwrap();

        let info = read_session_info(&path).unwrap();
        // Own: aggregate (150 in + 20 cache, 13 out, $0.5) + compaction
        // (50, 5, $0.25) - child (30, 3, $0.125).
        assert_eq!(
            info.usage,
            Some(crate::session_usage::SessionUsageSummary {
                input_tokens: 170,
                output_tokens: 15,
                cost: 0.625
            })
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A persisted partial usage object (`{input, output, totalTokens}`
    /// without `cacheRead`/`cacheWrite`/`cost`) must not reject the whole
    /// entry: TS `JSON.parse` keeps the row, so the count, model, search
    /// text, and every present usage field survive.
    #[test]
    fn scan_keeps_messages_with_partial_usage_objects() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.append_message(json!({"role": "user", "content": "run it", "timestamp": 1u64}));
        session.append_message(json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "done" }],
            "provider": "p", "model": "m", "timestamp": 2u64,
            "usage": { "input": 5, "output": 1, "totalTokens": 6 }
        }));
        session.rewrite().unwrap();

        let info = read_session_info(&path).unwrap();
        assert_eq!(info.message_count, 2);
        assert_eq!(info.model, Some(("p".to_string(), "m".to_string())));
        assert!(info.all_messages_text.contains("done"));
        assert_eq!(
            info.usage,
            Some(crate::session_usage::SessionUsageSummary {
                input_tokens: 5,
                output_tokens: 1,
                cost: 0.0
            })
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A session with no billable work publishes no usage field (TS
    /// `sessionUsageSummaryFrom` returns undefined).
    #[test]
    fn scan_omits_usage_without_billable_work() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.append_message(json!({"role": "user", "content": "hi", "timestamp": 1u64}));
        session.rewrite().unwrap();

        let info = read_session_info(&path).unwrap();
        assert_eq!(info.usage, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn transcript_search_text_caps_at_the_ts_limit() {
        let dir = temp_dir();
        let mut session = SessionFile::create("/tmp", None, 0);
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        for round in 0..3 {
            let message = "x".repeat(30 * 1024);
            session.append_message(json!({
                "role": "user", "content": format!("{round} {message}"), "timestamp": round + 1
            }));
        }
        session.rewrite().unwrap();

        let info = read_session_info(&path).unwrap();
        assert_eq!(
            info.all_messages_text.chars().count(),
            SESSION_LIST_SEARCH_TEXT_MAX_CHARS
        );
        // Space-joined like TS: exactly one separator between messages.
        assert!(info.all_messages_text.starts_with("0 xxx"));
        assert!(info.all_messages_text.contains("1 xxx"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_text_char_counter_stays_in_lockstep_with_the_corpus() {
        // The O(1) running counter must equal `chars().count()` of the
        // corpus at every fold step - including multibyte text, the cap
        // cut mid-message, and post-cap appends - or the cap guard drifts
        // from the TS corpus it bounds.
        let mut acc = SessionScanAccumulator::default();
        let texts = [
            "fix the login bug".to_string(),
            "ünïcödé — multibyte ✓ chars".to_string(),
            "x".repeat(66 * 1024),
            "post-cap tail that must not move the corpus".to_string(),
            "y".repeat(10),
        ];
        for (index, text) in texts.iter().enumerate() {
            let entry = json!({
                "type": "message",
                "id": format!("m{index}"),
                "timestamp": format!("{}", index + 1),
                "message": {"role": "user", "content": text}
            });
            fold_scan_entry(&mut acc, &entry.to_string()).unwrap();
            assert_eq!(
                acc.search_text_chars,
                acc.all_messages_text.chars().count(),
                "counter drift after fold {index}"
            );
            assert!(acc.all_messages_text.chars().count() <= SESSION_LIST_SEARCH_TEXT_MAX_CHARS);
        }
        assert_eq!(acc.first_message, "fix the login bug");
        assert_eq!(acc.message_count, 5);
        // The cap cut mid-message: the corpus holds exactly the limit.
        assert_eq!(acc.search_text_chars, SESSION_LIST_SEARCH_TEXT_MAX_CHARS);
    }

    #[test]
    fn search_text_char_counter_matches_the_legacy_append() {
        // The reference append (the pre-counter shape: count, then extend)
        // must produce the same corpus for the same sequence of texts.
        let mut corpus = String::new();
        let mut count = 0usize;
        let texts = [
            String::new(),
            "one".to_string(),
            "twö with multibyte".to_string(),
            "z".repeat(SESSION_LIST_SEARCH_TEXT_MAX_CHARS + 10),
            "post-cap".to_string(),
        ];
        for text in &texts {
            let mut legacy = corpus.clone();
            if !text.is_empty() {
                let used = legacy.chars().count();
                if used < SESSION_LIST_SEARCH_TEXT_MAX_CHARS {
                    if used > 0 {
                        legacy.push(' ');
                    }
                    let remaining = SESSION_LIST_SEARCH_TEXT_MAX_CHARS - legacy.chars().count();
                    legacy.extend(text.chars().take(remaining));
                }
            }
            count = append_capped_search_text(&mut corpus, text, count);
            assert_eq!(corpus, legacy);
            assert_eq!(count, legacy.chars().count());
        }
    }

    #[test]
    fn search_text_counter_lockstep_names_every_corpus_mutation_path() {
        // Every path that can mutate the capped corpus, at the accumulator
        // level. Any other path is read-only (build_info derives, the wire
        // serializes); eviction drops the whole state (counter and corpus
        // together, so it cannot desync) and store_state keeps it whole.
        // The paths: (1) a fresh fold's appends, (2) the resume copy a
        // grown file folds into (clone_for_resume travels the counter),
        // (3) the torn-tail SNAPSHOT fold (build_info folds the tail into
        // a clone, the durable accumulator untouched), and (4) a rewritten
        // file (generation mismatch re-folds from a fresh accumulator).
        let header_line = session_header_line(&SessionHeader {
            version: None,
            id: "s1".to_string(),
            timestamp: "2026-09-26T00:00:00.000Z".to_string(),
            cwd: "/repo".to_string(),
            parent_session: None,
            rlm_depth: None,
            git: None,
            rest: serde_json::Map::default(),
        })
        .to_string();
        let message = |text: &str, index: u64| {
            json!({
                "type": "message",
                "id": format!("m{index}"),
                "timestamp": index.to_string(),
                "message": {"role": "user", "content": text}
            })
            .to_string()
        };

        // (1) fresh fold, past the cap.
        let generation = SessionInfoGeneration {
            len: 4096,
            dev: 0,
            ino: 0,
            mtime: 0,
            mtime_ns: 0,
            ctime: 0,
            ctime_ns: 0,
        };
        let mut state = SessionScanState::fresh(generation);
        fold_scan_entry(&mut state.acc, &header_line).unwrap();
        fold_scan_entry(&mut state.acc, &message("first user turn", 1)).unwrap();
        fold_scan_entry(
            &mut state.acc,
            &message(&"x".repeat(SESSION_LIST_SEARCH_TEXT_MAX_CHARS), 2),
        )
        .unwrap();
        assert_eq!(
            state.acc.search_text_chars,
            state.acc.all_messages_text.chars().count()
        );
        assert_eq!(
            state.acc.all_messages_text.chars().count(),
            SESSION_LIST_SEARCH_TEXT_MAX_CHARS
        );

        // (2) the resume copy: the grown file's next appends fold into
        // clone_for_resume's accumulator - the counter travels with the
        // corpus and stays in lockstep for post-cap appends.
        let mut resumed = state.clone_for_resume();
        assert_eq!(
            resumed.acc.search_text_chars,
            resumed.acc.all_messages_text.chars().count()
        );
        fold_scan_entry(&mut resumed.acc, &message("appended after cap", 3)).unwrap();
        assert_eq!(
            resumed.acc.search_text_chars,
            resumed.acc.all_messages_text.chars().count()
        );
        assert_eq!(
            resumed.acc.all_messages_text.chars().count(),
            SESSION_LIST_SEARCH_TEXT_MAX_CHARS
        );

        // (3) the torn-tail snapshot: build_info folds the torn final
        // line into a CLONE, so the durable accumulator's counter stays
        // untouched; an uncapped snapshot's row gains the tail's text,
        // the capped one cannot (the tail arm is under the same cap).
        let durable_before = state.acc.clone();
        let capped_info = state
            .build_info(
                Path::new("/repo/s1.jsonl"),
                || None,
                Some(r#"{"type":"message","id":"m4","timestamp":"4","message":{"role":"user","content":"torn tail"}}"#),
            )
            .unwrap();
        assert_eq!(
            capped_info.all_messages_text, durable_before.all_messages_text,
            "the cap bounds the snapshot fold too - a torn tail past it changes no corpus byte"
        );
        assert_eq!(
            state.acc.search_text_chars,
            durable_before.search_text_chars
        );
        assert_eq!(
            state.acc.search_text_chars,
            state.acc.all_messages_text.chars().count()
        );
        let mut uncapped = SessionScanState::fresh(generation);
        fold_scan_entry(&mut uncapped.acc, &header_line).unwrap();
        fold_scan_entry(&mut uncapped.acc, &message("user turn one", 1)).unwrap();
        let uncapped_durable = uncapped.acc.clone();
        let uncapped_info = uncapped
            .build_info(
                Path::new("/repo/s1.jsonl"),
                || None,
                Some(r#"{"type":"message","id":"m5","timestamp":"2","message":{"role":"user","content":"user turn two"}}"#),
            )
            .unwrap();
        assert_eq!(
            uncapped_info.all_messages_text,
            "user turn one user turn two"
        );
        assert_eq!(
            uncapped.acc.all_messages_text,
            uncapped_durable.all_messages_text
        );
        assert_eq!(
            uncapped.acc.search_text_chars,
            uncapped_durable.search_text_chars
        );

        // (4) a rewritten file re-folds from a fresh accumulator: both
        // corpus and counter restart at zero together.
        let mut rewritten = SessionScanState::fresh(generation);
        assert_eq!(rewritten.acc.search_text_chars, 0);
        assert!(rewritten.acc.all_messages_text.is_empty());
        fold_scan_entry(&mut rewritten.acc, &header_line).unwrap();
        fold_scan_entry(&mut rewritten.acc, &message("rewrite from zero", 1)).unwrap();
        assert_eq!(
            rewritten.acc.search_text_chars,
            rewritten.acc.all_messages_text.chars().count()
        );
        assert_eq!(
            rewritten.acc.all_messages_text, "rewrite from zero",
            "a rewritten file's corpus is the fresh fold's, not the old session's"
        );
    }

    #[test]
    fn durable_first_kept_entry_id_pins_the_boundary_the_read_retains() {
        // The parity scenario the frame diff caught: the engine compacts its
        // in-memory entries and reports an id that never exists in the
        // session file. The durable re-cut must pin the boundary the
        // `messages()` read recognizes, or the retained tail is lost.
        let mut session = SessionFile::create("/tmp", None, 0);
        session.append_message(json!({"role": "user", "content": "first", "timestamp": 1u64}));
        let usage = json!({
            "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }
        });
        let assistant = |text: String, timestamp: u64| {
            json!({
                "role": "assistant",
                "content": [{ "type": "text", "text": text }],
                "api": "faux", "provider": "p", "model": "m",
                "usage": usage, "stopReason": "stop", "timestamp": timestamp
            })
        };
        session.append_message(assistant(format!("history {}", "word ".repeat(40)), 2u64));
        session
            .append_message(json!({"role": "user", "content": "second turn", "timestamp": 3u64}));
        session.append_message(assistant("second turn done".to_string(), 4u64));

        let durable_id = session.durable_first_kept_entry_id(5);
        // The cut keeps the whole second turn: its user message is the
        // boundary (estimate: 4 + 2 >= 5 stops at the user entry).
        let kept = session
            .branch()
            .iter()
            .find(|entry| {
                entry.fields.get("message").and_then(|m| m.get("content"))
                    == Some(&json!("second turn"))
            })
            .map(|entry| entry.id.clone())
            .expect("the second-turn user entry");
        assert_eq!(durable_id, Some(kept));

        let _ = session.persist_entry(
            "compaction",
            json!({ "summary": "the story", "firstKeptEntryId": durable_id, "tokensBefore": 12 }),
        );
        let messages = session.messages();
        // Wire order is summary-first (TS `buildSessionContext`); the
        // retained messages follow.
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].get("role"), Some(&json!("compactionSummary")));
        assert_eq!(crate::types::message_text(&messages[1]), "second turn");
        assert_eq!(crate::types::message_text(&messages[2]), "second turn done");
    }

    #[test]
    fn entry_chain_links_parents() {
        let mut session = SessionFile::create("/tmp", None, 0);
        let a = session.append_entry("custom", json!({"customType": "x"}));
        let b = session.append_entry("custom", json!({"customType": "y"}));
        assert_eq!(
            session.entry(&b).unwrap().parent_id.as_deref(),
            Some(a.as_str())
        );
        assert_eq!(session.leaf_id(), Some(b.as_str()));
    }

    #[test]
    fn skips_malformed_lines() {
        let dir = temp_dir();
        let path = dir.join("s.jsonl");
        fs::write(
            &path,
            format!(
                "{}\nnot json\n{}\n",
                json!({"type":"session","version":3,"id":"abc","timestamp":"t","cwd":"/x"}),
                json!({"type":"message","id":"aaaa1111","parentId":null,"timestamp":"t","message":{"role":"user","content":"hi"}})
            ),
        )
        .unwrap();
        let loaded = SessionFile::open(&path).unwrap();
        assert_eq!(loaded.message_count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    /// The durable compaction row must byte-serialize in the TS key order
    /// (TS `appendCompaction`'s `CompactionEntry` literal, verified against
    /// the TS binary's session file — battery run 20260921T140248Z,
    /// `ts/f7_compaction/sessions/*.jsonl`):
    /// type, id, parentId, timestamp, summary, firstKeptEntryId,
    /// tokensBefore, details, fromHook, customInstructions?, usage,
    /// harnessDigest — with `details` as `{readFiles, modifiedFiles}` and
    /// `usage` in the TS `Usage` field order. The JSON map preserves
    /// insertion order (`serde_json` `preserve_order`), so any drift shows
    /// up here as a wrong key sequence, not just a wrong shape.
    #[test]
    fn durable_compaction_row_serializes_in_the_ts_key_order() {
        let entry = pa_types::session::CompactionEntry {
            summary: "pre-compaction reply 6".to_string(),
            first_kept_entry_id: "ebd5e444".to_string(),
            tokens_before: 110,
            details: Some(
                serde_json::to_value(
                    &pa_core::session_engine::compaction_exec::CompactionDetails {
                        read_files: vec!["a.rs".to_string()],
                        modified_files: vec!["b.rs".to_string()],
                    },
                )
                .unwrap(),
            ),
            from_hook: Some(false),
            custom_instructions: None,
            usage: Some(pa_types::ai::Usage {
                input: 20,
                output: 10,
                cache_read: 80,
                cache_write: 0,
                total_tokens: 110,
                cost: pa_types::ai::UsageCost::default(),
            }),
            harness_digest: Some("# Continual Harness State".to_string()),
            harness_state_fingerprint: None,
        };
        let fields = serde_json::to_value(&entry).unwrap();
        let mut session = SessionFile::create("/tmp", None, 0);
        session.append_entry("compaction", fields);
        let row = serde_json::to_string(session.entries.last().unwrap()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&row).unwrap();
        let keys: Vec<&str> = parsed
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "type",
                "id",
                "parentId",
                "timestamp",
                "summary",
                "firstKeptEntryId",
                "tokensBefore",
                "details",
                "fromHook",
                "usage",
                "harnessDigest",
            ]
        );
        // The details block is the TS `readFiles`-first literal order, and
        // usage keeps the TS field order (input, output, cacheRead,
        // cacheWrite, totalTokens, cost).
        let details = serde_json::to_string(parsed["details"].as_object().unwrap()).unwrap();
        assert_eq!(
            details,
            "{\"readFiles\":[\"a.rs\"],\"modifiedFiles\":[\"b.rs\"]}"
        );
        let usage: Vec<&str> = parsed["usage"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            usage,
            vec![
                "input",
                "output",
                "cacheRead",
                "cacheWrite",
                "totalTokens",
                "cost"
            ]
        );
    }

    /// The in-place tail window matches the rolling `Vec` reference (the
    /// previous implementation) byte for byte across line-length regimes: the
    /// keep cut at the window edge, the short-line roll, the empty line, and
    /// multibyte bytes that never decode mid-window.
    #[test]
    fn resume_tail_window_matches_the_rolling_reference() {
        let mut state = SessionScanState::fresh(SessionInfoGeneration {
            len: 0,
            dev: 0,
            ino: 0,
            mtime: 0,
            mtime_ns: 0,
            ctime: 0,
            ctime_ns: 0,
        });
        let mut reference = [b'\n'; SESSION_SCAN_RESUME_TAIL_BYTES];
        let rolling_reference = |tail: &mut [u8; SESSION_SCAN_RESUME_TAIL_BYTES], line: &[u8]| {
            let keep = SESSION_SCAN_RESUME_TAIL_BYTES - 1;
            let mut combined = Vec::with_capacity(SESSION_SCAN_RESUME_TAIL_BYTES + line.len() + 1);
            if line.len() >= keep {
                combined.extend_from_slice(&line[line.len() - keep..]);
            } else {
                combined.extend_from_slice(tail);
                combined.extend_from_slice(line);
            }
            combined.push(b'\n');
            let start = combined
                .len()
                .saturating_sub(SESSION_SCAN_RESUME_TAIL_BYTES);
            tail.copy_from_slice(&combined[start..]);
        };
        let lines: Vec<Vec<u8>> = [
            &b""[..],
            b"x",
            b"fourteen xx",
            &b"exactly fifteen"[..],
            b"sixteen bytes..",
            &b"a much longer line than the window will ever keep"[..],
            b"",
            "multibyte 世界未詠 line".as_bytes(),
            &b"final"[..],
        ]
        .into_iter()
        .map(<[u8]>::to_vec)
        .collect();
        for line in &lines {
            state.advance_tail(line);
            rolling_reference(&mut reference, line);
            assert_eq!(state.tail, reference, "line {line:?}");
        }
        // The prefix-intact read keeps proving resumes from the same bytes.
        assert_eq!(state.tail, reference);
    }

    /// The session header line leads with the `type` tag, exactly like the
    /// TS session file's first line (`{"type":"session","version":...}`).
    #[test]
    fn session_header_line_leads_with_the_type_tag() {
        let header = SessionHeader {
            version: Some(3),
            id: "abc".to_string(),
            timestamp: "t".to_string(),
            cwd: "/x".to_string(),
            parent_session: None,
            rlm_depth: Some(0),
            git: None,
            rest: serde_json::Map::new(),
        };
        let line = serde_json::to_string(&session_header_line(&header)).unwrap();
        assert!(line.starts_with("{\"type\":\"session\",\"version\":3,\"id\":\"abc\""));
    }
}
