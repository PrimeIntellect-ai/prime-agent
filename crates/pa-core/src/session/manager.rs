//! `SessionManager`: the stateful session writer. Port of the class half of
//! core/session-manager.ts (create/new/append/persist, crash repair, index).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use pa_types::session::{
    AgentMessage, ChildUsageOrigin, EntryBase, FileEntry, GitContext, SessionHeader, SessionState,
    SessionStateStatus,
};

use super::tree::SessionTree;
use super::{migrate_to_current_version, parse_session_entries, CURRENT_SESSION_VERSION};

/// A persist observer; must not break session writes (panics are contained).
pub type SessionPersistListener = Box<dyn Fn(&Path) + Send + Sync>;

fn generate_id(existing: &HashMap<String, usize>) -> String {
    for _ in 0..100 {
        let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        if !existing.contains_key(&id) {
            return id;
        }
    }
    uuid::Uuid::new_v4().to_string()
}

fn create_session_id() -> String {
    create_uuid_v7()
}

/// `UUIDv7` (timestamp-ordered, like the TS `createSessionId`).
fn create_uuid_v7() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub fn get_session_file_path(session_dir: &Path, session_id: &str) -> PathBuf {
    session_dir.join(format!("{session_id}.jsonl"))
}

pub fn format_iso_now() -> String {
    // ISO-8601 with millisecond precision, like `new Date().toISOString()`.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let millis = now.as_millis();
    format_iso(millis as i64)
}

/// Format unix milliseconds as an ISO-8601 UTC timestamp.
pub fn format_iso(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let time_ms = millis.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let hour = time_ms / 3_600_000;
    let minute = (time_ms / 60_000) % 60;
    let second = (time_ms / 1_000) % 60;
    let ms = time_ms % 1_000;
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z")
}

/// One quiet git probe: `--no-optional-locks`, stdio ignore/pipe/ignore,
/// `None` on any failure or empty output (TS `runGit` in utils/git.ts).
fn run_git_probe(cwd: &Path, args: &[&str]) -> Option<String> {
    std::process::Command::new("git")
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|stdout| stdout.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Capture git context for the header (best effort; None outside a repo).
///
/// Contract (TS `captureGitContext`): every field is independently optional;
/// the context exists when at least one probe succeeds. `branch` is
/// `--show-current`, so a detached HEAD yields no branch. The remote URL is
/// normalized through the git-source parser when it parses, else kept
/// verbatim.
pub fn capture_git_context(cwd: &Path) -> Option<GitContext> {
    let commit = run_git_probe(cwd, &["rev-parse", "HEAD"]);
    let branch = run_git_probe(cwd, &["branch", "--show-current"]);
    let remote = run_git_probe(cwd, &["remote", "get-url", "origin"]);
    if commit.is_none() && branch.is_none() && remote.is_none() {
        return None;
    }
    Some(GitContext {
        repo_url: remote.map(|url| {
            crate::packages::parse_git_url(&url)
                .map(|source| source.repo)
                .unwrap_or(url)
        }),
        commit,
        branch,
    })
}

fn serialize_entry(entry: &FileEntry) -> String {
    serde_json::to_string(entry).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Crash repair
// ---------------------------------------------------------------------------

const REPAIR_SUSPICION_WINDOW_BYTES: usize = 1024 * 1024;

fn parses_as_json(line: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(line).is_ok()
}

/// A bounded tail read gates the full repair scan: clean opens stay O(window).
fn tail_looks_damaged(target_path: &Path) -> bool {
    use std::io::Read;
    use std::io::Seek;
    let Ok(mut file) = std::fs::File::open(target_path) else {
        return false;
    };
    let Ok(size) = file.metadata().map(|meta| meta.len() as usize) else {
        return true;
    };
    if size == 0 {
        return false;
    }
    let window_bytes = size.min(REPAIR_SUSPICION_WINDOW_BYTES);
    let mut window = vec![0u8; window_bytes];
    if file
        .seek(std::io::SeekFrom::Start((size - window_bytes) as u64))
        .is_err()
    {
        return true;
    }
    if file.read_exact(&mut window).is_err() {
        return true;
    }
    if window.contains(&0) {
        return true;
    }
    if window.last() != Some(&0x0a) {
        return true;
    }
    let previous_newline = window[..window_bytes - 1]
        .iter()
        .rposition(|byte| *byte == 0x0a);
    match previous_newline {
        None => window_bytes < size,
        Some(position) => {
            let last_line = &window[position + 1..window_bytes - 1];
            !last_line.is_empty() && !parses_as_json(last_line)
        }
    }
}

/// Repair crash damage (torn tail, zero-filled append) once at open.
fn repair_jsonl_damage(file_path: &Path) {
    if !tail_looks_damaged(file_path) {
        return;
    }
    let Ok(buffer) = std::fs::read(file_path) else {
        return;
    };
    if buffer.is_empty() {
        return;
    }
    let mut kept_lines: Vec<&[u8]> = Vec::new();
    let mut dropped_lines = 0usize;
    let mut repaired_tail = false;
    let mut dirty = false;
    let mut start = 0usize;
    while start < buffer.len() {
        let end = match buffer[start..].iter().position(|byte| *byte == 0x0a) {
            Some(offset) => start + offset,
            None => buffer.len(),
        };
        let terminated = end < buffer.len();
        let mut line_start = start;
        while line_start < end && buffer[line_start] == 0 {
            line_start += 1;
        }
        let line = &buffer[line_start..end];
        if line_start > start {
            // Zero-filled prefix: recover what parses, drop the rest.
            dirty = true;
            if !line.is_empty() && parses_as_json(line) {
                kept_lines.push(line);
            } else {
                dropped_lines += 1;
            }
        } else if !terminated {
            // Unterminated tail merges with the next append: re-terminate.
            dirty = true;
            if !line.is_empty() && parses_as_json(line) {
                kept_lines.push(line);
                repaired_tail = true;
            } else {
                dropped_lines += 1;
            }
        } else if end + 1 >= buffer.len() && !line.is_empty() && !parses_as_json(line) {
            dirty = true;
            dropped_lines += 1;
        } else {
            kept_lines.push(line);
        }
        start = end + 1;
    }
    if !dirty {
        return;
    }
    let mut content = String::new();
    for (index, line) in kept_lines.iter().enumerate() {
        if index > 0 {
            content.push('\n');
        }
        content.push_str(&String::from_utf8_lossy(line));
    }
    if !content.is_empty() {
        content.push('\n');
    }
    // TS repairs crash damage through `writeFileAtomicSync`: the repaired
    // file lands by rename, never as a torn in-place write.
    let _ = atomic_write(file_path, &content);
    let _ = (repaired_tail, dropped_lines);
}

/// Load entries from a session file (repairing damage first when persisting).
pub fn load_entries_from_file(file_path: &Path, repair: bool) -> Vec<FileEntry> {
    if !file_path.exists() {
        return Vec::new();
    }
    if repair {
        repair_jsonl_damage(file_path);
    }
    let Ok(content) = std::fs::read_to_string(file_path) else {
        return Vec::new();
    };
    finalize_loaded_entries(parse_session_entries(&content))
}

/// Finalize: entries need a valid header first; attributions fold in.
fn finalize_loaded_entries(entries: Vec<FileEntry>) -> Vec<FileEntry> {
    if entries.is_empty() {
        return entries;
    }
    let valid_header = matches!(&entries[0], FileEntry::Header { .. });
    if !valid_header {
        return Vec::new();
    }
    entries
}

/// Read just the header of a session file (first line).
pub fn read_session_header(file_path: &Path) -> Option<SessionHeader> {
    use std::io::BufRead;
    let file = std::fs::File::open(file_path).ok()?;
    let mut first_line = String::new();
    std::io::BufReader::new(file)
        .read_line(&mut first_line)
        .ok()?;
    let wrapper: SessionHeaderWrapper = serde_json::from_str(&first_line).ok()?;
    Some(wrapper.header)
}

#[derive(serde::Deserialize)]
struct SessionHeaderWrapper {
    #[serde(flatten)]
    header: SessionHeader,
}

fn is_valid_rlm_depth(value: Option<u64>) -> bool {
    value.is_some_and(|depth| depth < u64::MAX)
}

fn root_rlm_depth_from_env() -> u64 {
    match std::env::var("RLM_DEPTH") {
        Ok(value) if value.is_empty() => 0,
        Ok(value) => value
            .parse::<u64>()
            .ok()
            .filter(|depth| is_valid_rlm_depth(Some(*depth)))
            .unwrap_or_else(|| panic!("RLM_DEPTH must be a non-negative integer")),
        Err(_) => 0,
    }
}

/// Options for creating a new session.
#[derive(Default)]
pub struct NewSessionOptions {
    pub id: Option<String>,
    pub parent_session: Option<String>,
    pub rlm_depth: Option<u64>,
}

/// The fork's branch copy (TS `forkFrom`'s entry loop): drop the source
/// header and its `git_state` rows, re-linking any child whose parent was a
/// dropped row to the nearest kept ancestor. Re-parented entries round-trip
/// through their own JSON (TS `{ ...entry, parentId }`) so every other field
/// stays verbatim.
fn forked_branch_entries(entries: Vec<FileEntry>) -> Vec<FileEntry> {
    // git_state rows describe the source repo; the fork reports its own.
    let mut dropped_parent: HashMap<String, Option<String>> = HashMap::new();
    for entry in &entries {
        if matches!(entry, FileEntry::GitState { .. }) {
            if let Some(id) = entry.id() {
                dropped_parent.insert(id.to_string(), entry.parent_id().map(str::to_string));
            }
        }
    }
    // Resolve each dropped id to its nearest kept ancestor lazily — TS's
    // `liveParent`, memoized over the ACYCLIC walks: a parent chain shared
    // by many children costs one walk total. Cycles (malformed git_state
    // rows) stay per-child: their terminal depends on the walk's start, so
    // memoizing them would make the outcome depend on map iteration order.
    let mut resolved: HashMap<String, Option<String>> = HashMap::new();
    entries
        .into_iter()
        .filter(|entry| !matches!(entry, FileEntry::Header { .. } | FileEntry::GitState { .. }))
        .map(|entry| {
            let parent = entry.parent_id().map(str::to_string);
            let live = match &parent {
                // A dropped parent re-links to its resolved kept ancestor
                // (which may be None, re-rooting the entry); a kept parent
                // stays.
                Some(id) if dropped_parent.contains_key(id) => {
                    resolve_dropped_ancestor(&dropped_parent, &mut resolved, id)
                }
                other => other.clone(),
            };
            if entry.parent_id() == live.as_deref() {
                return entry;
            }
            let mut value = serde_json::to_value(&entry).unwrap_or_default();
            if let serde_json::Value::Object(map) = &mut value {
                map.insert(
                    "parentId".to_string(),
                    match &live {
                        Some(id) => serde_json::Value::from(id.clone()),
                        None => serde_json::Value::Null,
                    },
                );
            }
            serde_json::from_value(value).unwrap_or(entry)
        })
        .collect()
}

/// The nearest kept ancestor for one dropped `git_state` row: walk the
/// dropped parents until an id that survives the fork (or a null parent),
/// memoizing every ACYCLIC node the walk passed so shared chains resolve
/// once. A cycle (malformed `git_state` rows parenting at each other) stops
/// at the first repeated id WITHOUT memoizing: the terminal depends on the
/// walk's start, so caching it would make the outcome depend on which
/// child resolves first.
fn resolve_dropped_ancestor(
    dropped_parent: &HashMap<String, Option<String>>,
    resolved: &mut HashMap<String, Option<String>>,
    start: &str,
) -> Option<String> {
    let mut path: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut current = Some(start.to_string());
    while let Some(ref id) = current {
        if let Some(answer) = resolved.get(id.as_str()) {
            let answer = answer.clone();
            for node in path {
                resolved.insert(node, answer.clone());
            }
            return answer;
        }
        if !seen.insert(id.clone()) {
            // The first repeated id of THIS walk — the outcome for this
            // child, memoized for no one else.
            return Some(id.clone());
        }
        if let Some(next) = dropped_parent.get(id.as_str()) {
            path.push(id.clone());
            current.clone_from(next);
        } else {
            let answer = Some(id.clone());
            for node in path {
                resolved.insert(node, answer.clone());
            }
            return answer;
        }
    }
    // The chain ends at a null parent: every node on it re-links to the
    // root.
    for node in path {
        resolved.insert(node, None);
    }
    None
}

/// The stateful session writer/reader.
pub struct SessionManager {
    session_id: String,
    session_file: Option<PathBuf>,
    session_dir: PathBuf,
    cwd: PathBuf,
    persist: bool,
    /// Whether the manager carries a session directory of its own (any
    /// persisted manager, and the daemon's mirrored engine session): the
    /// session-owned artifacts (local harness state) resolve under it.
    session_dir_backed: bool,
    flushed: bool,
    has_assistant_entry: bool,
    append_ownership: super::window::AppendOwnership,
    file_entries: Vec<FileEntry>,
    window: Option<super::window::WindowedSessionStore>,
    by_id: HashMap<String, usize>,
    labels_by_id: HashMap<String, String>,
    label_timestamps_by_id: HashMap<String, String>,
    leaf_id: Option<String>,
    persist_listeners: Vec<SessionPersistListener>,
}

impl SessionManager {
    fn new_with(
        cwd: PathBuf,
        session_dir: PathBuf,
        session_file: Option<PathBuf>,
        persist: bool,
    ) -> Self {
        if persist && !session_dir.exists() {
            let _ = std::fs::create_dir_all(&session_dir);
        }
        let mut manager = Self {
            session_id: String::new(),
            session_file: None,
            session_dir,
            cwd,
            persist,
            session_dir_backed: persist,
            flushed: false,
            has_assistant_entry: false,
            append_ownership: super::window::AppendOwnership::Unleased,
            file_entries: Vec::new(),
            window: None,
            by_id: HashMap::new(),
            labels_by_id: HashMap::new(),
            label_timestamps_by_id: HashMap::new(),
            leaf_id: None,
            persist_listeners: Vec::new(),
        };
        match session_file {
            Some(file) => manager.set_session_file(file, None),
            None => {
                manager.new_session(&NewSessionOptions::default());
            }
        }
        manager
    }

    /// Create a persisted manager rooted at `session_dir`.
    pub fn persisted(cwd: &Path, session_dir: &Path) -> Self {
        Self::new_with(cwd.to_path_buf(), session_dir.to_path_buf(), None, true)
    }

    /// Create an in-memory (non-persisted) manager.
    pub fn in_memory(cwd: &Path) -> Self {
        Self::new_with(cwd.to_path_buf(), cwd.to_path_buf(), None, false)
    }

    /// Create an in-memory (non-persisted) manager pinned to a session's
    /// own directory: the daemon worker owns the durable file and mirrors
    /// the entries, but the session's identity (its directory, the local
    /// harness state's home) stays the session's own.
    pub fn in_memory_in_session_dir(cwd: &Path, session_dir: &Path) -> Self {
        let mut manager = Self::new_with(cwd.to_path_buf(), session_dir.to_path_buf(), None, false);
        manager.session_dir_backed = true;
        manager
    }

    /// Whether the manager carries a session directory of its own: a
    /// fresh in-memory manager holds only the cwd fallback, while every
    /// session-backed manager (persisted, or the daemon's mirrored
    /// engine session) does. Session-owned artifacts (the local harness
    /// state) need it.
    pub fn has_session_dir(&self) -> bool {
        self.session_dir_backed
    }

    /// Open an existing session file (repair + migrate), or a fresh one.
    pub fn open(cwd: &Path, session_dir: &Path, session_file: &Path) -> Self {
        Self::new_with(
            cwd.to_path_buf(),
            session_dir.to_path_buf(),
            Some(session_file.to_path_buf()),
            true,
        )
    }

    /// TS `SessionManager.forkFrom`: copy a source session file into a
    /// fresh session under `target_cwd`, parented at the source. The
    /// source's `git_state` entries are dropped — they describe the source
    /// repo, and the fork must report its own target context — with their
    /// children re-linked to the nearest kept ancestor (TS `liveParent`).
    /// The new header carries the source path as `parentSession`, the
    /// resolved RLM depth, and the TARGET cwd's git context.
    ///
    /// # Errors
    ///
    /// Returns a human-readable error string when the source session file is
    /// not a regular file, is empty or invalid, has no header, or when the
    /// forked session file cannot be flushed.
    pub fn fork_from(
        source_path: &Path,
        target_cwd: &Path,
        session_dir: &Path,
    ) -> Result<Self, String> {
        // A non-regular source (a FIFO or a device) blocks the copy's read
        // until a writer appears; the fork reads regular files, so reject
        // the rest up front. A missing path falls through to the
        // empty-or-invalid contract (TS loadEntriesFromFile).
        if let Ok(metadata) = std::fs::metadata(source_path) {
            if !metadata.is_file() {
                return Err(format!(
                    "Cannot fork: source session file is not a regular file: {}",
                    source_path.display()
                ));
            }
        }
        // Read-only: repairing would REWRITE the source (dropping a torn
        // row mid-append into a live file); the copy just skips a torn
        // tail like TS's `loadEntriesFromFile` (read + parse, no repair).
        let mut entries = load_entries_from_file(source_path, false);
        if entries.is_empty() {
            return Err(format!(
                "Cannot fork: source session file is empty or invalid: {}",
                source_path.display()
            ));
        }
        let source_header = entries
            .iter()
            .find_map(|entry| match entry {
                FileEntry::Header { header } => Some(header.clone()),
                _ => None,
            })
            .ok_or_else(|| {
                format!(
                    "Cannot fork: source session has no header: {}",
                    source_path.display()
                )
            })?;
        migrate_to_current_version(&mut entries);
        let rlm_depth = resolve_session_rlm_depth(&source_header, source_path);

        let mut forked = Self::persisted(target_cwd, session_dir);
        // A fresh unique id + header (TS `createUniqueSessionFileTarget`):
        // the fork's git context is captured from the TARGET cwd, and the
        // source rides along as `parentSession`.
        forked.new_session(&NewSessionOptions {
            id: None,
            parent_session: Some(source_path.display().to_string()),
            rlm_depth: Some(rlm_depth),
        });
        let branch = forked_branch_entries(entries);
        // The copied rows' assistant entries keep the append path durable
        // from the first new entry (TS writes the whole fork synchronously):
        // one predicate for the durable-append rule.
        forked.refresh_has_assistant_entry(&branch);
        forked.adopt_entries(branch);
        forked.flush_now().map_err(|error| error.to_string())?;
        Ok(forked)
    }

    /// Open only the compacted active window off the async executor. Use
    /// `active_context` until `ensure_full_history` completes before accessing
    /// historical entries, navigation, or exporting.
    ///
    /// Production windowed managers come from [`Self::adopt_window`]; this
    /// constructor serves the window tests.
    ///
    /// # Errors
    ///
    /// Returns an error when the windowed session store cannot be opened.
    #[cfg(test)]
    pub async fn open_windowed(
        cwd: &Path,
        session_dir: &Path,
        session_file: &Path,
    ) -> anyhow::Result<Self> {
        let cwd = cwd.to_owned();
        let session_dir = session_dir.to_owned();
        let path = session_file.to_owned();
        tokio::task::spawn_blocking(move || {
            repair_jsonl_damage(&path);
            let Some(window) = super::window::WindowedSessionStore::open(&path)? else {
                return Ok(Self::open(&cwd, &session_dir, &path));
            };
            let mut manager = Self::in_memory(&cwd);
            manager.session_id = match window.entries().first() {
                Some(FileEntry::Header { header }) => header.id.clone(),
                _ => unreachable!("window validates header"),
            };
            manager.session_dir = session_dir;
            manager.session_file = Some(path);
            manager.persist = true;
            manager.session_dir_backed = true;
            manager.flushed = true;
            manager.file_entries = window.entries().to_vec();
            manager.has_assistant_entry = true;
            manager.build_index();
            manager.window = Some(window);
            Ok(manager)
        })
        .await?
    }

    /// The active compacted context without hydrating old message bodies.
    pub fn active_context(&self) -> super::SessionContext {
        match &self.window {
            Some(window) => window.context(),
            None => super::build_session_context(&self.file_entries, self.get_leaf_id()),
        }
    }

    /// Adopt a verified read-only window into an externally persisted manager.
    /// The adopted file is complete and appendable (the window's boundary
    /// proves real message history), so the manager joins with the same
    /// durable-append invariants the test constructor installs: rows go
    /// straight to disk — never deferred behind the bootstrap rule, whose
    /// `flushed = false` would later send `flush_now` into the
    /// window-failing rewrite path.
    pub fn adopt_window(&mut self, window: super::window::WindowedSessionStore) {
        self.file_entries = window.entries().to_vec();
        self.build_index();
        self.leaf_id = Some(window.leaf_id().to_owned());
        self.has_assistant_entry = true;
        self.flushed = true;
        self.window = Some(window);
    }

    /// Whether this manager's durable appends may certify the window cache
    /// incrementally. Only a caller holding this session's runtime lease may
    /// raise it (exactly one writer per lease; the lease's release flushes the
    /// certified snapshot to the sidecar), and every other manager keeps the
    /// unleased default that evicts the live snapshot instead of extending a
    /// certification it cannot guarantee.
    pub fn set_append_ownership(&mut self, ownership: super::window::AppendOwnership) {
        self.append_ownership = ownership;
    }

    /// Capture a historical read request while locked; await it after releasing
    /// the session mutex. Current unpersisted rows are merged into the snapshot.
    ///
    /// # Errors
    ///
    /// The returned future errors when reading the session file fails, or
    /// when the file read panics and the blocking task fails to join. When
    /// the manager holds no windowed store, the retained entries are
    /// returned without touching the disk.
    pub fn history_snapshot(
        &self,
    ) -> impl std::future::Future<Output = anyhow::Result<Vec<FileEntry>>> + Send + 'static {
        let path = self
            .window
            .as_ref()
            .map(|window| window.source_path().to_owned());
        let retained = self.file_entries.clone();
        async move {
            let Some(path) = path else {
                return Ok(retained);
            };
            let mut entries = tokio::task::spawn_blocking(move || {
                std::fs::read_to_string(path).map(|text| super::parse_session_entries(&text))
            })
            .await??;
            let ids: std::collections::HashSet<String> = entries
                .iter()
                .filter_map(|entry| entry.id().map(str::to_owned))
                .collect();
            entries.extend(
                retained
                    .into_iter()
                    .filter(|entry| entry.id().is_some_and(|id| !ids.contains(id))),
            );
            Ok(entries)
        }
    }

    /// Loaded current-context records; not a whole-history view.
    pub fn retained_entries(&self) -> &[FileEntry] {
        &self.file_entries
    }

    pub fn has_thinking_level(&self) -> bool {
        self.window
            .as_ref()
            .is_some_and(super::window::WindowedSessionStore::has_thinking_level)
            || self
                .active_branch_entries()
                .iter()
                .any(|entry| matches!(entry, FileEntry::ThinkingLevelChange { .. }))
    }

    pub fn has_service_tier(&self) -> bool {
        self.window
            .as_ref()
            .is_some_and(super::window::WindowedSessionStore::has_service_tier)
            || self
                .active_branch_entries()
                .iter()
                .any(|entry| matches!(entry, FileEntry::ServiceTierChange { .. }))
    }

    fn active_branch_entries(&self) -> Vec<&FileEntry> {
        let mut branch = Vec::new();
        let mut visited = std::collections::HashSet::new();
        let mut id = self.leaf_id.as_deref();
        while let Some(index) = id.and_then(|id| self.by_id.get(id)).copied() {
            // A corrupt file can hold a parent cycle; opening must not hang.
            if !visited.insert(index) {
                break;
            }
            let entry = &self.file_entries[index];
            branch.push(entry);
            id = entry.parent_id();
        }
        branch.reverse();
        branch
    }

    pub fn active_goal_state(&self) -> Option<crate::goals::GoalState> {
        if let Some(window) = &self.window {
            return window.goal_state().cloned();
        }
        self.active_branch_entries().iter().rev().find_map(|entry| {
            let FileEntry::Custom { payload, .. } = entry else {
                return None;
            };
            let data = payload.data.as_ref()?;
            if payload.custom_type != crate::goals::GOAL_STATE_CUSTOM_TYPE
                || !crate::goals::is_persisted_goal_state(data)
            {
                return None;
            }
            serde_json::from_value(data.clone())
                .ok()
                .map(crate::goals::normalize_goal_state)
        })
    }

    /// Newest `git_state` reachable without hydration: the loaded active
    /// branch first, then the window's pre-boundary metadata (newest first).
    pub(crate) fn latest_git_context(&self) -> Option<pa_types::session::GitContext> {
        let on_branch = self.active_branch_entries().iter().rev().find_map(|entry| {
            if let FileEntry::GitState { payload, .. } = entry {
                Some(payload.git.clone())
            } else {
                None
            }
        });
        if on_branch.is_some() {
            return on_branch;
        }
        // metadata_entries is file order; the newest wins.
        self.window
            .as_ref()?
            .metadata_entries()
            .iter()
            .rev()
            .find_map(|line| match serde_json::from_str::<FileEntry>(line) {
                Ok(FileEntry::GitState { payload, .. }) => Some(payload.git),
                _ => None,
            })
    }

    pub fn has_non_bootstrap_entries(&self) -> bool {
        self.window
            .as_ref()
            .is_some_and(super::window::WindowedSessionStore::has_non_bootstrap_entries)
            || self.file_entries.iter().any(|entry| {
                !matches!(
                    entry,
                    FileEntry::Header { .. }
                        | FileEntry::ModelChange { .. }
                        | FileEntry::ThinkingLevelChange { .. }
                        | FileEntry::ServiceTierChange { .. }
                )
            })
    }

    pub fn refinement_history(&self) -> Vec<crate::refinement::RefinementResult> {
        let mut history = self.window.as_ref().map_or_else(Vec::new, |window| {
            let entries: Vec<FileEntry> = window
                .metadata_entries()
                .iter()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect();
            crate::session_engine::refine::session_refinement_history(&entries)
        });
        history.extend(crate::session_engine::refine::session_refinement_history(
            &self.file_entries,
        ));
        history
    }

    #[cfg(test)]
    pub fn is_full_history(&self) -> bool {
        self.window.is_none()
    }

    /// Hydrate before historical reads or mutation. Loading uses a blocking
    /// worker; the selected leaf is retained and disk appends are preserved.
    ///
    /// # Errors
    ///
    /// Returns an error when the full-history hydration of the windowed
    /// store fails. A manager without a window is already hydrated and
    /// succeeds without touching the disk.
    #[cfg(test)]
    pub async fn ensure_full_history(&mut self) -> anyhow::Result<()> {
        let Some(window) = self.window.as_mut() else {
            return Ok(());
        };
        window.ensure_full_history().await?;
        let mut entries = window.entries().to_vec();
        let loaded_ids: std::collections::HashSet<String> = entries
            .iter()
            .filter_map(|entry| entry.id().map(str::to_owned))
            .collect();
        entries.extend(
            self.file_entries
                .iter()
                .filter(|entry| entry.id().is_some_and(|id| !loaded_ids.contains(id)))
                .cloned(),
        );
        let leaf = self.leaf_id.clone();
        self.refresh_has_assistant_entry(&entries);
        self.file_entries = entries;
        self.build_index();
        self.leaf_id = leaf;
        self.window = None;
        Ok(())
    }

    /// Switch to a different session file (resume/branch).
    ///
    /// # Panics
    ///
    /// The `unwrap` on the session file path is guarded by the existence
    /// check right above it, so it cannot fail.
    pub fn set_session_file(
        &mut self,
        session_file: PathBuf,
        preloaded_entries: Option<Vec<FileEntry>>,
    ) {
        self.window = None;
        self.session_file = Some(session_file);
        if self.session_file.as_ref().is_some_and(|path| path.exists()) {
            let path = self.session_file.clone().unwrap();
            let mut entries =
                preloaded_entries.unwrap_or_else(|| load_entries_from_file(&path, self.persist));
            self.refresh_has_assistant_entry(&entries);

            // Empty or corrupted (no valid header): truncate and start fresh.
            if entries.is_empty() {
                let explicit_path = path;
                self.new_session(&NewSessionOptions::default());
                self.session_file = Some(explicit_path);
                self.rewrite_file();
                self.flushed = true;
                return;
            }
            let header_id = entries.iter().find_map(|entry| match entry {
                FileEntry::Header { header } => Some(header.id.clone()),
                _ => None,
            });
            self.session_id = header_id.unwrap_or_else(create_session_id);

            let mut should_rewrite = migrate_to_current_version(&mut entries);
            if let Some(FileEntry::Header { header }) = entries.first_mut() {
                if header.parent_session.is_some() && !is_valid_rlm_depth(header.rlm_depth) {
                    let depth = resolve_session_rlm_depth(header, &path);
                    header.rlm_depth = Some(depth);
                    should_rewrite = true;
                }
            }
            self.file_entries = entries;
            if should_rewrite {
                self.rewrite_file();
            }
            self.build_index();
            self.flushed = true;
        } else {
            let explicit_path = self.session_file.clone();
            self.new_session(&NewSessionOptions::default());
            self.session_file = explicit_path;
        }
    }

    /// Create a new session; returns the session file path when persisting.
    ///
    /// # Panics
    ///
    /// Panics when an explicit session id is requested while persisting and
    /// a session file for that id already exists.
    pub fn new_session(&mut self, options: &NewSessionOptions) -> Option<PathBuf> {
        let mut session_id = options.id.clone().unwrap_or_else(create_session_id);
        let mut session_file: Option<PathBuf> = None;
        if self.persist {
            if options.id.is_some() {
                let candidate = get_session_file_path(&self.session_dir, &session_id);
                assert!(
                    !candidate.exists(),
                    "Session file already exists for id \"{session_id}\": {}",
                    candidate.display()
                );
                session_file = Some(candidate);
            } else {
                session_id = create_session_id();
                let mut candidate = get_session_file_path(&self.session_dir, &session_id);
                let mut attempts = 0;
                while candidate.exists() && attempts < 100 {
                    session_id = create_session_id();
                    candidate = get_session_file_path(&self.session_dir, &session_id);
                    attempts += 1;
                }
                session_file = Some(candidate);
            }
        }

        self.session_id = session_id;
        let timestamp = format_iso_now();
        let git = self
            .persist
            .then(|| capture_git_context(&self.cwd))
            .flatten();
        let rlm_depth = match options.rlm_depth {
            Some(depth) => Some(depth),
            None => options
                .parent_session
                .as_deref()
                .map(|_| 0)
                .or(Some(root_rlm_depth_from_env())),
        };
        let header = FileEntry::Header {
            header: SessionHeader {
                id: self.session_id.clone(),
                version: Some(CURRENT_SESSION_VERSION),
                timestamp,
                cwd: self.cwd.display().to_string(),
                parent_session: options.parent_session.clone(),
                rlm_depth,
                git,
                rest: pa_types::JsonMap::new(),
            },
        };
        self.file_entries = vec![header];
        self.window = None;
        self.has_assistant_entry = false;
        self.by_id.clear();
        self.labels_by_id.clear();
        self.label_timestamps_by_id.clear();
        self.leaf_id = None;
        self.flushed = false;
        if self.persist {
            self.session_file.clone_from(&session_file);
        }
        session_file
    }

    fn refresh_has_assistant_entry(&mut self, entries: &[FileEntry]) {
        self.has_assistant_entry = entries.iter().any(|entry| {
            matches!(
                entry,
                FileEntry::Message {
                    message: AgentMessage::Assistant(_),
                    ..
                }
            )
        });
    }

    fn build_index(&mut self) {
        self.by_id.clear();
        self.labels_by_id.clear();
        self.label_timestamps_by_id.clear();
        self.leaf_id = None;
        for (index, entry) in self.file_entries.iter().enumerate() {
            if matches!(entry, FileEntry::Header { .. }) {
                continue;
            }
            if let Some(id) = entry.id() {
                self.by_id.insert(id.to_string(), index);
                self.leaf_id = Some(id.to_string());
            }
            if let FileEntry::Label { payload, .. } = entry {
                if let Some(label) = &payload.label {
                    self.labels_by_id
                        .insert(payload.target_id.clone(), label.clone());
                    self.label_timestamps_by_id
                        .insert(payload.target_id.clone(), entry.timestamp().to_string());
                } else {
                    self.labels_by_id.remove(&payload.target_id);
                    self.label_timestamps_by_id.remove(&payload.target_id);
                }
            }
        }
    }

    fn rewrite_file(&mut self) {
        if let Err(error) = self.try_rewrite_file() {
            tracing::error!(%error, "session rewrite failed");
        }
    }

    fn try_rewrite_file(&mut self) -> std::io::Result<()> {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        let Some(session_file) = &self.session_file else {
            return Ok(());
        };
        if !self.persist {
            return Ok(());
        }
        let mut content = String::new();
        for (index, entry) in self.file_entries.iter().enumerate() {
            if index > 0 {
                content.push('\n');
            }
            content.push_str(&serialize_entry(entry));
        }
        content.push('\n');
        if let Some(parent) = session_file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        atomic_write(session_file, &content)?;
        self.notify_persist_listeners();
        Ok(())
    }

    fn notify_persist_listeners(&self) {
        let Some(session_file) = &self.session_file else {
            return;
        };
        for listener in &self.persist_listeners {
            listener(session_file);
        }
    }

    pub fn on_persist(&mut self, listener: SessionPersistListener) {
        self.persist_listeners.push(listener);
    }

    pub fn is_persisted(&self) -> bool {
        self.persist
    }

    /// Session artifact directory (`dirname(sessionDir)/session-artifacts/<id>`,
    /// TS `getSessionArtifactDir`); only persisted sessions have one.
    pub fn get_session_artifact_dir(&self) -> Option<std::path::PathBuf> {
        self.persist
            .then(|| {
                self.session_dir
                    .parent()
                    .map(|root| root.join("session-artifacts"))
            })
            .flatten()
            .map(|root| root.join(&self.session_id))
    }

    pub fn get_cwd(&self) -> &Path {
        &self.cwd
    }

    pub fn get_session_dir(&self) -> &Path {
        &self.session_dir
    }

    pub fn get_session_id(&self) -> &str {
        &self.session_id
    }

    pub fn get_session_file(&self) -> Option<&Path> {
        self.session_file.as_deref()
    }

    /// Entries excluding the session header (TS `getEntries()`).
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub fn get_entries(&self) -> Vec<FileEntry> {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        self.file_entries
            .iter()
            .filter(|entry| !matches!(entry, FileEntry::Header { .. }))
            .cloned()
            .collect()
    }

    /// All entries including the header (whole-file views).
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub fn get_all_entries(&self) -> &[FileEntry] {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        &self.file_entries
    }

    pub fn get_leaf_id(&self) -> Option<&str> {
        self.leaf_id.as_deref()
    }

    pub fn get_header(&self) -> Option<&SessionHeader> {
        self.file_entries.iter().find_map(|entry| match entry {
            FileEntry::Header { header } => Some(header),
            _ => None,
        })
    }

    pub fn get_session_name(&self) -> Option<String> {
        if let Some(window) = &self.window {
            return self
                .file_entries
                .iter()
                .rev()
                .find_map(|entry| match entry {
                    FileEntry::SessionInfo { payload, .. } => Some(payload.name.clone()),
                    _ => None,
                })
                .unwrap_or_else(|| {
                    window
                        .metadata_entries()
                        .iter()
                        .rev()
                        .find_map(|raw| match serde_json::from_str::<FileEntry>(raw).ok()? {
                            FileEntry::SessionInfo { payload, .. } => Some(payload.name),
                            _ => None,
                        })
                        .flatten()
                });
        }
        self.file_entries
            .iter()
            .rev()
            .find_map(|entry| match entry {
                FileEntry::SessionInfo { payload, .. } => Some(payload.name.clone()),
                _ => None,
            })
            .flatten()
    }

    /// Force-write all in-memory entries immediately (pre-model durability).
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the session file rewrite
    /// fails; unpersisted or already-flushed managers succeed without
    /// touching the disk.
    pub fn flush_now(&mut self) -> std::io::Result<()> {
        if !self.persist || self.session_file.is_none() {
            return Ok(());
        }
        if self.flushed && self.session_file.as_ref().is_some_and(|path| path.exists()) {
            return Ok(());
        }
        self.try_rewrite_file()?;
        self.flushed = true;
        Ok(())
    }

    /// Materialize an in-memory session into a persisted file.
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub fn materialize_session_file(&mut self, session_dir: Option<PathBuf>) -> PathBuf {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        if let Some(session_file) = self.session_file.clone() {
            return session_file;
        }
        let dir = session_dir
            .or_else(|| {
                (!self.session_dir.as_os_str().is_empty()).then(|| self.session_dir.clone())
            })
            .unwrap_or_else(|| self.cwd.join("sessions"));
        let _ = std::fs::create_dir_all(&dir);
        let previous_header = self.get_header().cloned();
        let session_id = create_session_id();
        let target = get_session_file_path(&dir, &session_id);
        self.session_dir = dir;
        self.session_id.clone_from(&session_id);
        self.session_file = Some(target.clone());
        self.persist = true;
        self.session_dir_backed = true;
        let timestamp = format_iso_now();
        let git = capture_git_context(&self.cwd);
        let header = FileEntry::Header {
            header: SessionHeader {
                id: session_id,
                version: Some(CURRENT_SESSION_VERSION),
                timestamp,
                cwd: self.cwd.display().to_string(),
                parent_session: previous_header
                    .as_ref()
                    .and_then(|header| header.parent_session.clone()),
                rlm_depth: Some(
                    previous_header
                        .as_ref()
                        .and_then(|header| header.rlm_depth)
                        .unwrap_or(0),
                ),
                git,
                rest: pa_types::JsonMap::new(),
            },
        };
        let rest = std::mem::take(&mut self.file_entries);
        let has_assistant = rest.iter().any(|entry| {
            matches!(
                entry,
                FileEntry::Message {
                    message: AgentMessage::Assistant(_),
                    ..
                }
            )
        });
        self.file_entries = vec![header];
        self.file_entries.extend(rest);
        self.has_assistant_entry = has_assistant;
        self.rewrite_file();
        self.flushed = true;
        target
    }

    /// The session tree (branch children + label state) over current entries.
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub fn get_tree(&self) -> SessionTree {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        SessionTree::build(&self.file_entries)
    }

    /// Adopt a durable branch as this session's entries (TS
    /// `createBranchedSession`'s in-memory case, and the engine's
    /// post-navigation context rebuild): keeps the header, replaces every
    /// entry with the given chain, and re-indexes so the leaf is the last
    /// adopted entry. In-memory only — the caller owns any persistence.
    pub fn adopt_entries(&mut self, entries: Vec<FileEntry>) {
        // The caller supplies the complete selected branch after explicit navigation.
        self.window = None;
        let header = self
            .file_entries
            .iter()
            .position(|entry| matches!(entry, FileEntry::Header { .. }));
        match header {
            Some(index) => {
                self.file_entries.truncate(index + 1);
                self.file_entries.extend(entries);
            }
            None => {
                self.file_entries = entries;
            }
        }
        self.build_index();
    }

    fn persist_entry(&mut self, index: usize) -> std::io::Result<()> {
        if !self.persist || self.session_file.is_none() {
            return Ok(());
        }
        let is_session_state_or_info = matches!(
            self.file_entries[index],
            FileEntry::SessionState { .. } | FileEntry::SessionInfo { .. }
        );
        if !self.has_assistant_entry && !is_session_state_or_info {
            self.flushed = false;
            return Ok(());
        }
        let file_exists = self.session_file.as_ref().is_some_and(|path| path.exists());
        if self.window.is_none() && (!self.flushed || !file_exists) {
            // Recover from the session file disappearing under a live session:
            // append would recreate a headerless stub.
            self.try_rewrite_file()?;
            self.flushed = true;
        } else {
            let entry = serialize_entry(&self.file_entries[index]);
            if let Some(session_file) = &self.session_file {
                let mut line = entry.into_bytes();
                line.push(b'\n');
                super::window::append_cached(session_file, &line, self.append_ownership)?;
            }
            self.notify_persist_listeners();
        }
        Ok(())
    }

    pub(crate) fn append_entry(&mut self, entry: FileEntry) -> std::io::Result<()> {
        let was_assistant = self.has_assistant_entry;
        let was_flushed = self.flushed;
        if matches!(
            entry,
            FileEntry::Message {
                message: AgentMessage::Assistant(_),
                ..
            }
        ) {
            self.has_assistant_entry = true;
        }
        self.file_entries.push(entry);
        let index = self.file_entries.len() - 1;
        if let Err(error) = self.persist_entry(index) {
            self.file_entries.pop();
            self.has_assistant_entry = was_assistant;
            self.flushed = was_flushed;
            return Err(error);
        }
        let entry = self.file_entries[index].clone();
        if let Some(window) = &mut self.window {
            window.append_entry(entry.clone());
        }
        if let Some(id) = entry.id().map(str::to_string) {
            self.by_id.insert(id.clone(), index);
            self.leaf_id = Some(id);
        }
        Ok(())
    }

    pub(crate) fn next_base(&self) -> EntryBase {
        EntryBase {
            id: Some(if self.window.is_some() {
                uuid::Uuid::new_v4().to_string()
            } else {
                generate_id(&self.by_id)
            }),
            parent_id: self.leaf_id.clone(),
            timestamp: Some(format_iso_now()),
            rest: pa_types::JsonMap::new(),
        }
    }

    /// Append a conversation message; returns the new entry id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails; the
    /// entry is not kept in the in-memory index.
    pub fn append_message(&mut self, message: AgentMessage) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::Message { message, base })?;
        Ok(id)
    }

    /// Append a conversation message with the TS `_appendEntry`
    /// retained-write contract (the `_agentEventQueue` subscriber arm): the
    /// loop already owns the row in live agent state, so a failed disk write
    /// keeps it in the live session index too — the two stores stay in sync —
    /// and the error surfaces for logging only. [`Self::append_message`]
    /// stays strict for callers that roll back on failure.
    pub fn append_message_retained(
        &mut self,
        message: AgentMessage,
    ) -> (String, Option<std::io::Error>) {
        if matches!(message, AgentMessage::Assistant(_)) {
            self.has_assistant_entry = true;
        }
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.file_entries.push(FileEntry::Message { message, base });
        let index = self.file_entries.len() - 1;
        let write_error = self.persist_entry(index).err();
        let entry = self.file_entries[index].clone();
        if let Some(window) = &mut self.window {
            window.append_entry(entry.clone());
        }
        if let Some(id) = entry.id().map(str::to_string) {
            self.by_id.insert(id.clone(), index);
            self.leaf_id = Some(id);
        }
        (id, write_error)
    }

    /// Append a thinking-level change; returns the new entry id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_thinking_level_change(
        &mut self,
        thinking_level: &str,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::ThinkingLevelChange {
            payload: pa_types::session::ThinkingLevelChangeEntry {
                thinking_level: thinking_level.to_string(),
            },
            base,
        })?;
        Ok(id)
    }

    /// Append a service-tier change; returns the new entry id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_service_tier_change(
        &mut self,
        service_tier: Option<pa_types::ai::ServiceTier>,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::ServiceTierChange {
            payload: pa_types::session::ServiceTierChangeEntry { service_tier },
            base,
        })?;
        Ok(id)
    }

    /// Append a model change; returns the new entry id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_model_change(
        &mut self,
        provider: &str,
        model_id: &str,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::ModelChange {
            payload: pa_types::session::ModelChangeEntry {
                provider: provider.to_string(),
                model_id: model_id.to_string(),
            },
            base,
        })?;
        Ok(id)
    }

    /// `appendCompaction`: persist the compaction record. The full typed
    /// payload is stored (TS keeps `details`, `fromHook`,
    /// `customInstructions`, `usage`, and `harnessDigest` on the durable
    /// row; later compactions and branch summarization read them back).
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_compaction(
        &mut self,
        payload: pa_types::session::CompactionEntry,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::Compaction { payload, base })?;
        Ok(id)
    }

    /// Append a custom entry; returns the new entry id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_custom_entry(
        &mut self,
        custom_type: &str,
        data: Option<serde_json::Value>,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::Custom {
            payload: pa_types::session::CustomEntry {
                custom_type: custom_type.to_string(),
                data,
                rest: serde_json::Map::default(),
            },
            base,
        })?;
        Ok(id)
    }

    /// Append a custom entry with the TS `_appendEntry` retained-write
    /// contract: a failed disk write keeps the entry in the live index and
    /// surfaces the error for the caller to log or report after the rest of
    /// its TS-choreographed writes (the refine audit arm). [`Self::append_custom_entry`]
    /// stays strict for callers that roll back on failure.
    pub fn append_custom_entry_retained(
        &mut self,
        custom_type: &str,
        data: Option<serde_json::Value>,
    ) -> (String, Option<std::io::Error>) {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.file_entries.push(FileEntry::Custom {
            payload: pa_types::session::CustomEntry {
                custom_type: custom_type.to_string(),
                data,
                rest: serde_json::Map::default(),
            },
            base,
        });
        let index = self.file_entries.len() - 1;
        let write_error = self.persist_entry(index).err();
        let entry = self.file_entries[index].clone();
        if let Some(window) = &mut self.window {
            window.append_entry(entry.clone());
        }
        if let Some(id) = entry.id().map(str::to_string) {
            self.by_id.insert(id.clone(), index);
            self.leaf_id = Some(id);
        }
        (id, write_error)
    }

    /// Append a custom message entry (compaction/refine notices, prompts).
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_custom_message(
        &mut self,
        custom_type: &str,
        content: pa_types::ai::UserContent,
        display: bool,
        details: Option<serde_json::Value>,
    ) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::CustomMessage {
            payload: pa_types::session::CustomMessageEntry {
                custom_type: custom_type.to_string(),
                content,
                details,
                display,
                rest: serde_json::Map::default(),
            },
            base,
        })?;
        Ok(id)
    }

    /// Append a best-effort disclosure row: a failed disk write keeps the
    /// entry indexed (the TS `_unpersistedOutcomes` guarantee — context
    /// rebuilds must not drop the disclosure; the gap-bridged usage walk
    /// tolerates the missing line on reload). The write error surfaces for
    /// logging only.
    pub fn append_custom_message_retained(
        &mut self,
        custom_type: &str,
        content: pa_types::ai::UserContent,
        display: bool,
        details: Option<serde_json::Value>,
    ) -> (String, Option<std::io::Error>) {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.file_entries.push(FileEntry::CustomMessage {
            payload: pa_types::session::CustomMessageEntry {
                custom_type: custom_type.to_string(),
                content,
                details,
                display,
                rest: serde_json::Map::default(),
            },
            base,
        });
        let index = self.file_entries.len() - 1;
        let write_error = self.persist_entry(index).err();
        let entry = self.file_entries[index].clone();
        if let Some(window) = &mut self.window {
            window.append_entry(entry.clone());
        }
        if let Some(id) = entry.id().map(str::to_string) {
            self.by_id.insert(id.clone(), index);
            self.leaf_id = Some(id);
        }
        (id, write_error)
    }

    /// Fold child usage into the target assistant message and record the
    /// attribution entry.
    ///
    /// # Errors
    ///
    /// Returns an invalid-input error when the target assistant message
    /// entry is missing, or the underlying I/O error when the durable
    /// append fails.
    pub fn append_child_usage_attribution(
        &mut self,
        target_id: &str,
        child_usage: pa_types::ai::Usage,
        aggregate_usage: pa_types::ai::Usage,
        origin: Option<ChildUsageOrigin>,
    ) -> std::io::Result<String> {
        let target_index = self.by_id.get(target_id).copied().filter(|&index| {
            matches!(
                self.file_entries[index],
                FileEntry::Message {
                    message: AgentMessage::Assistant(_),
                    ..
                }
            )
        });
        let target_index = target_index.ok_or_else(|| {
            // TS `appendChildUsageAttribution` throws the same text; the
            // caller treats a failed append as recoverable bookkeeping.
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("Assistant message entry {target_id} not found"),
            )
        })?;
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::ChildUsageAttributed {
            payload: pa_types::session::ChildUsageAttributionEntry {
                target_id: target_id.to_string(),
                child_usage,
                aggregate_usage,
                origin,
            },
            base,
        })?;
        // Fold only after the durable append: a failed write must not leave
        // phantom usage for a later rewrite to persist.
        if let FileEntry::Message {
            message: AgentMessage::Assistant(assistant),
            ..
        } = &mut self.file_entries[target_index]
        {
            assistant.usage = aggregate_usage;
        }
        Ok(id)
    }

    /// Append a session-info row (the session name); returns the new entry
    /// id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_session_info(&mut self, name: &str) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::SessionInfo {
            payload: pa_types::session::SessionInfoEntry {
                name: Some(name.trim().to_string()),
            },
            base,
        })?;
        Ok(id)
    }

    /// Look up an entry by id (file position index).
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub fn get_entry_by_id(&self, id: &str) -> Option<&FileEntry> {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        self.by_id.get(id).map(|&index| &self.file_entries[index])
    }

    /// The active label for a target entry id.
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub fn get_label(&self, target_id: &str) -> Option<String> {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        self.labels_by_id.get(target_id).cloned()
    }

    /// The timestamp of the label entry that set the target's active label.
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub fn get_label_timestamp(&self, target_id: &str) -> Option<String> {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        self.label_timestamps_by_id.get(target_id).cloned()
    }

    /// Move the leaf (used by branch/branchWithSummary).
    ///
    /// # Panics
    ///
    /// Asserts that the manager holds no windowed store: hydrate the full
    /// session history first.
    pub(crate) fn set_leaf_id(&mut self, leaf_id: Option<&str>) {
        assert!(
            self.window.is_none(),
            "hydrate full session history before this operation"
        );
        self.leaf_id = leaf_id.map(str::to_string);
    }

    /// Apply a label entry to the label index (last label wins).
    pub(crate) fn apply_label_entry(
        &mut self,
        target_id: &str,
        label: Option<&str>,
        timestamp: &str,
    ) {
        if let Some(label) = label {
            self.labels_by_id
                .insert(target_id.to_string(), label.to_string());
            self.label_timestamps_by_id
                .insert(target_id.to_string(), timestamp.to_string());
        } else {
            self.labels_by_id.remove(target_id);
            self.label_timestamps_by_id.remove(target_id);
        }
    }

    /// Append a session-state row; returns the new entry id.
    ///
    /// # Errors
    ///
    /// Returns the underlying I/O error when the durable append fails.
    pub fn append_session_state(&mut self, status: SessionStateStatus) -> std::io::Result<String> {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::SessionState {
            payload: pa_types::session::SessionStateEntry {
                state: SessionState { status },
            },
            base,
        })?;
        Ok(id)
    }
}

fn resolve_session_rlm_depth(header: &SessionHeader, _session_path: &Path) -> u64 {
    if is_valid_rlm_depth(header.rlm_depth) {
        return header.rlm_depth.unwrap();
    }
    0
}

/// Atomic session-file write: private temp + fsync + rename onto the
/// destination (TS `writeFileAtomicSync`; the win32 destination-busy retry
/// rides along in `rename_onto`).
fn atomic_write(path: &Path, content: &str) -> std::io::Result<()> {
    let temp = PathBuf::from(format!("{}.tmp{}", path.display(), std::process::id()));
    {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).write(true).truncate(true);
        crate::platform::perms::set_private_mode(&mut options);
        let mut file = options.open(&temp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
    }
    crate::platform::rename_onto(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_entry_ids_are_unique_and_link_to_previous_entry() {
        let mut manager = SessionManager::in_memory(Path::new("/tmp"));
        let mut previous = None;
        for _ in 0..1_000 {
            let id = manager.append_custom_entry("test", None).unwrap();
            let entry = manager.get_all_entries().last().unwrap();
            assert_eq!(entry.id(), Some(id.as_str()));
            assert_eq!(entry.parent_id(), previous.as_deref());
            assert_eq!(id.len(), 8);
            assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()));
            previous = Some(id);
        }
        assert_eq!(manager.by_id.len(), 1_000);
        assert_eq!(manager.get_leaf_id(), previous.as_deref());
    }

    /// The durable compaction line is the full TS `CompactionEntry` record:
    /// `fromHook: false` is present (never a missing key), and the details
    /// and usage ride along.
    #[test]
    fn append_compaction_serializes_the_full_ts_record() {
        let tmp = tempfile::tempdir().unwrap();
        let mut manager = SessionManager::in_memory(tmp.path());
        manager
            .append_compaction(pa_types::session::CompactionEntry {
                summary: "the overflow summary".to_string(),
                first_kept_entry_id: "e4".to_string(),
                tokens_before: 214,
                details: Some(serde_json::json!({
                    "readFiles": [],
                    "modifiedFiles": [],
                })),
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
                harness_digest: None,
            })
            .unwrap();
        let line = serialize_entry(
            manager
                .get_entries()
                .iter()
                .rev()
                .find(|entry| matches!(entry, FileEntry::Compaction { .. }))
                .expect("compaction entry appended"),
        );
        assert!(line.contains("\"fromHook\":false"));
        assert!(line.contains("\"tokensBefore\":214"));
        assert!(line.contains("\"usage\":"));
    }

    #[test]
    fn persist_appends_after_first_assistant() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sessions");
        let mut manager = SessionManager::persisted(tmp.path(), &dir);
        // Pre-model entries are not flushed until an assistant message exists.
        let first = manager.append_thinking_level_change("high");
        assert!(!manager.get_session_file().unwrap().exists());
        manager
            .append_message(AgentMessage::Assistant(pa_types::ai::AssistantMessage {
                content: vec![],
                api: "anthropic-messages".to_string(),
                provider: "anthropic".to_string(),
                model: "claude-x".to_string(),
                response_model: None,
                response_id: None,
                diagnostics: None,
                usage: pa_types::ai::Usage::default(),
                stop_reason: pa_types::ai::StopReason::Stop,
                stop_reason_raw: None,
                error_message: None,
                timestamp: 0,
                rest: serde_json::Map::default(),
            }))
            .unwrap();
        let file = manager.get_session_file().unwrap().to_path_buf();
        assert!(file.exists());
        // The assistant append rewrote the whole file, including the earlier entry.
        let content = std::fs::read_to_string(&file).unwrap();
        assert!(content.contains("thinking_level_change"));
        assert!(content.contains("claude-x"));
        assert_eq!(
            manager.get_leaf_id(),
            Some(manager.get_entries().last().and_then(|e| e.id()).unwrap())
        );
        let _ = first;
    }

    #[test]
    fn open_repairs_and_resumes() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let mut manager = SessionManager::persisted(tmp.path(), &dir);
        let assistant = AgentMessage::Assistant(pa_types::ai::AssistantMessage {
            content: vec![],
            api: "openai-completions".to_string(),
            provider: "openai".to_string(),
            model: "gpt-x".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        });
        manager.append_message(assistant).unwrap();
        let file = manager.get_session_file().unwrap().to_path_buf();
        // Simulate crash damage: torn tail (no trailing newline).
        let content = std::fs::read_to_string(&file).unwrap();
        std::fs::write(&file, content.trim_end()).unwrap();
        let reopened = SessionManager::open(tmp.path(), &dir, &file);
        assert_eq!(reopened.get_entries().len(), 1); // assistant (header excluded)
        assert_eq!(reopened.get_session_id(), manager.get_session_id());
    }

    #[test]
    fn flush_now_durability_without_assistant() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sessions");
        let mut manager = SessionManager::persisted(tmp.path(), &dir);
        manager.append_session_info("my session").unwrap();
        // session_info persists even without an assistant message.
        assert!(manager.get_session_file().unwrap().exists());
        assert_eq!(manager.get_session_name().as_deref(), Some("my session"));
    }

    #[test]
    fn iso_format_round_trips() {
        let stamp = format_iso(1_704_067_200_012);
        assert_eq!(stamp, "2024-01-01T00:00:00.012Z");
        assert_eq!(super::super::timestamp_to_millis(&stamp), 1_704_067_200_012);
    }

    /// TS `forkFrom`: the fork copies the source branch into a fresh
    /// session file under the target cwd, parented at the source; the
    /// source's `git_state` rows drop out and their children re-link to
    /// the nearest kept ancestor.
    #[test]
    fn fork_from_copies_the_branch_under_a_fresh_header() {
        let tmp = tempfile::tempdir().unwrap();
        let source_cwd = tmp.path().join("source-project");
        let source_dir = tmp.path().join("source-sessions");
        std::fs::create_dir_all(&source_cwd).unwrap();
        let mut source = SessionManager::persisted(&source_cwd, &source_dir);
        source
            .append_message(AgentMessage::User(pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Text("original question".to_string()),
                timestamp: 0,
                rest: serde_json::Map::default(),
            }))
            .unwrap();
        let user_id = source.get_leaf_id().unwrap().to_string();
        let assistant = AgentMessage::Assistant(pa_types::ai::AssistantMessage {
            content: vec![],
            api: "openai-completions".to_string(),
            provider: "openai".to_string(),
            model: "gpt-x".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_types::ai::Usage::default(),
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: serde_json::Map::default(),
        });
        source.append_message(assistant).unwrap();
        let assistant_id = source.get_leaf_id().unwrap().to_string();
        // A git_state row: dropped by the fork, its child re-linked.
        source
            .append_entry(FileEntry::GitState {
                payload: pa_types::session::GitStateEntry {
                    git: GitContext::default(),
                },
                base: EntryBase {
                    id: Some("gitstate1".to_string()),
                    parent_id: Some(assistant_id.clone()),
                    timestamp: Some(format_iso_now()),
                    rest: serde_json::Map::default(),
                },
            })
            .unwrap();
        source
            .append_custom_entry("after-git-state", Some(serde_json::json!({ "keep": true })))
            .unwrap();
        let trailing_id = source.get_leaf_id().unwrap().to_string();
        let source_file = source.get_session_file().unwrap().to_path_buf();

        // Fork into a different project root.
        let target_cwd = tmp.path().join("target-project");
        let target_dir = tmp.path().join("target-sessions");
        let forked = SessionManager::fork_from(&source_file, &target_cwd, &target_dir)
            .expect("fork copies the file");
        let fork_file = forked.get_session_file().unwrap().to_path_buf();
        assert!(fork_file.exists(), "the fork file landed on disk");
        assert!(fork_file != source_file, "the fork is a new session file");
        assert!(
            fork_file.starts_with(&target_dir),
            "the fork file lives in the target session dir"
        );

        // Fresh header: new id, target cwd, source as parentSession, source
        // depth carried over.
        let header = forked.get_header().unwrap();
        assert_ne!(header.id, source.get_session_id());
        assert_eq!(header.cwd, target_cwd.display().to_string());
        assert_eq!(
            header.parent_session.as_deref(),
            Some(source_file.display().to_string().as_str())
        );
        assert_eq!(header.rlm_depth, source.get_header().unwrap().rlm_depth);

        // The branch copied: the user + assistant rows survive with the
        // same ids; the git_state row is gone; its child re-linked to the
        // git_state's parent (the assistant row).
        let entries = forked.get_all_entries();
        assert!(entries
            .iter()
            .any(|entry| entry.id() == Some(user_id.as_str())));
        assert!(entries
            .iter()
            .any(|entry| entry.id() == Some(assistant_id.as_str())));
        assert!(
            !entries
                .iter()
                .any(|entry| matches!(entry, FileEntry::GitState { .. })),
            "git_state rows drop out of the fork"
        );
        let trailing = entries
            .iter()
            .find(|entry| entry.id() == Some(trailing_id.as_str()))
            .expect("the git_state child copied");
        assert_eq!(trailing.parent_id(), Some(assistant_id.as_str()));

        // The fork continues from the copied branch and the copy is durable.
        let before = std::fs::read_to_string(&fork_file).unwrap();
        let trailing_line = before
            .lines()
            .find(|line| line.contains(&trailing_id))
            .expect("the copied rows are on disk");
        assert!(trailing_line.contains("\"keep\":true"));
        let mut forked = forked;
        forked
            .append_message(AgentMessage::User(pa_types::ai::UserMessage {
                content: pa_types::ai::UserContent::Text("follow up".to_string()),
                timestamp: 1,
                rest: serde_json::Map::default(),
            }))
            .unwrap();
        let after = std::fs::read_to_string(&fork_file).unwrap();
        assert!(after.contains("follow up"), "appends extend the fork file");
        assert!(after.lines().count() > before.lines().count());
    }

    /// The fork is a read-only copy: a source with a torn tail (an
    /// in-progress append by a live writer) is copied with the torn row
    /// skipped, and the source file itself stays byte-identical — repairing
    /// would rewrite (and truncate) the live source.
    #[test]
    fn fork_from_never_rewrites_the_source() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("torn.jsonl");
        let content = "{\"type\":\"session\",\"version\":3,\"id\":\"torn-head\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\"}\n{\"type\":\"custom\",\"customType\":\"kept\",\"data\":{},\"id\":\"keep1\",\"parentId\":null,\"timestamp\":\"2024-01-01T00:00:00.000Z\"}\n{\"type\":\"custo";
        std::fs::write(&file, content).unwrap();
        let target_dir = tmp.path().join("fork-sessions");
        let forked = SessionManager::fork_from(&file, tmp.path(), &target_dir)
            .expect("the torn tail is skipped, not fatal");
        // The source is untouched, torn tail and all.
        assert_eq!(std::fs::read_to_string(&file).unwrap(), content);
        let entries = forked.get_all_entries();
        assert!(
            entries.iter().any(|entry| entry.id() == Some("keep1")),
            "the complete rows copied"
        );
    }

    /// Malformed-but-parseable `git_state` parents can form a cycle (a's
    /// dropped parent is b, b's is a): the fork's parent walk terminates at
    /// the first repeated id instead of looping forever.
    #[test]
    fn fork_from_terminates_on_cyclic_git_state_parents() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        // A hand-written source: a valid header, two git_state rows that
        // parent at each other, and a surviving custom row under one of them.
        let file = dir.join("cyclic.jsonl");
        let header = "{\"type\":\"session\",\"version\":3,\"id\":\"cyc-head\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\"}";
        let git_a = "{\"type\":\"git_state\",\"git\":{},\"id\":\"cyc01\",\"parentId\":\"cyc02\",\"timestamp\":\"2024-01-01T00:00:00.000Z\"}";
        let git_b = "{\"type\":\"git_state\",\"git\":{},\"id\":\"cyc02\",\"parentId\":\"cyc01\",\"timestamp\":\"2024-01-01T00:00:00.000Z\"}";
        let custom = "{\"type\":\"custom\",\"customType\":\"survivor\",\"data\":{},\"id\":\"cyc03\",\"parentId\":\"cyc01\",\"timestamp\":\"2024-01-01T00:00:00.000Z\"}";
        std::fs::write(&file, format!("{header}\n{git_a}\n{git_b}\n{custom}\n")).unwrap();

        let target_dir = tmp.path().join("fork-sessions");
        let forked = SessionManager::fork_from(&file, tmp.path(), &target_dir)
            .expect("the cycle terminates and the fork completes");
        let entries = forked.get_all_entries();
        assert!(
            !entries
                .iter()
                .any(|entry| matches!(entry, FileEntry::GitState { .. })),
            "the git_state rows dropped"
        );
        let survivor = entries
            .iter()
            .find(|entry| entry.id() == Some("cyc03"))
            .expect("the surviving custom row copied");
        // The walk stopped at the first repeated id (cyc01), so the survivor
        // keeps its (dropped) parent instead of spinning on the cycle.
        assert_eq!(survivor.parent_id(), Some("cyc01"));
    }

    /// TS `forkFrom`'s failure contract: the loader (TS
    /// `loadEntriesFromFile` -> `finalizeLoadedEntries`) returns no entries
    /// for a missing file, an empty file, AND a file without a valid leading
    /// header, so all three shapes take the "empty or invalid" arm (the
    /// no-header error stays as TS-faithful defense-in-depth — its own
    /// `forkFrom` finds the header only after the same finalize).
    #[test]
    fn fork_from_rejects_empty_and_headerless_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let empty = tmp.path().join("empty.jsonl");
        std::fs::write(&empty, "").unwrap();
        let error = SessionManager::fork_from(&empty, tmp.path(), &tmp.path().join("sessions"))
            .err()
            .expect("fork rejects an empty source");
        assert_eq!(
            error,
            format!(
                "Cannot fork: source session file is empty or invalid: {}",
                empty.display()
            )
        );
        let headerless = tmp.path().join("headerless.jsonl");
        std::fs::write(
            &headerless,
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[],\"timestamp\":0},\"id\":\"aaaa1\",\"parentId\":null}\n",
        )
        .unwrap();
        let error =
            SessionManager::fork_from(&headerless, tmp.path(), &tmp.path().join("sessions"))
                .err()
                .expect("fork rejects a headerless source");
        assert_eq!(
            error,
            format!(
                "Cannot fork: source session file is empty or invalid: {}",
                headerless.display()
            ),
            "the loader finalizes a headerless file to zero entries"
        );
        let missing = tmp.path().join("absent.jsonl");
        let error = SessionManager::fork_from(&missing, tmp.path(), &tmp.path().join("sessions"))
            .err()
            .expect("fork rejects a missing source");
        assert!(error.starts_with("Cannot fork: source session file is empty or invalid:"));
    }

    #[test]
    fn fork_from_rejects_a_non_regular_source() {
        let tmp = tempfile::tempdir().unwrap();
        let dir_source = tmp.path().join("not-a-session");
        std::fs::create_dir_all(&dir_source).unwrap();
        let error =
            SessionManager::fork_from(&dir_source, tmp.path(), &tmp.path().join("sessions"))
                .err()
                .expect("fork rejects a non-regular source");
        assert_eq!(
            error,
            format!(
                "Cannot fork: source session file is not a regular file: {}",
                dir_source.display()
            )
        );
    }
}
