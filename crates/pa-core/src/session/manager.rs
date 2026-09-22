//! SessionManager: the stateful session writer. Port of the class half of
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

fn generate_id(existing: &std::collections::HashSet<String>) -> String {
    for _ in 0..100 {
        let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        if !existing.contains(&id) {
            return id;
        }
    }
    uuid::Uuid::new_v4().to_string()
}

fn create_session_id() -> String {
    create_uuid_v7()
}

/// UUIDv7 (timestamp-ordered, like the TS createSessionId).
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
    use std::io::Seek;
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
    let content = std::fs::read_to_string(file_path).ok()?;
    let first_line = content.lines().next()?;
    let wrapper: SessionHeaderWrapper = serde_json::from_str(first_line).ok()?;
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

/// The stateful session writer/reader.
pub struct SessionManager {
    session_id: String,
    session_file: Option<PathBuf>,
    session_dir: PathBuf,
    cwd: PathBuf,
    persist: bool,
    flushed: bool,
    has_assistant_entry: bool,
    file_entries: Vec<FileEntry>,
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
            flushed: false,
            has_assistant_entry: false,
            file_entries: Vec::new(),
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

    /// Create a persisted manager rooted at session_dir.
    pub fn persisted(cwd: &Path, session_dir: &Path) -> Self {
        Self::new_with(cwd.to_path_buf(), session_dir.to_path_buf(), None, true)
    }

    /// Create an in-memory (non-persisted) manager.
    pub fn in_memory(cwd: &Path) -> Self {
        Self::new_with(cwd.to_path_buf(), cwd.to_path_buf(), None, false)
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

    /// Switch to a different session file (resume/branch).
    pub fn set_session_file(
        &mut self,
        session_file: PathBuf,
        preloaded_entries: Option<Vec<FileEntry>>,
    ) {
        self.session_file = Some(session_file);
        if self.session_file.as_ref().is_some_and(|path| path.exists()) {
            let path = self.session_file.clone().unwrap();
            let mut entries =
                preloaded_entries.unwrap_or_else(|| load_entries_from_file(&path, self.persist));
            self.refresh_has_assistant_entry(&entries);

            // Empty or corrupted (no valid header): truncate and start fresh.
            if entries.is_empty() {
                let explicit_path = path.clone();
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
    pub fn new_session(&mut self, options: &NewSessionOptions) -> Option<PathBuf> {
        let mut session_id = options.id.clone().unwrap_or_else(create_session_id);
        let mut session_file: Option<PathBuf> = None;
        if self.persist {
            if options.id.is_some() {
                let candidate = get_session_file_path(&self.session_dir, &session_id);
                if candidate.exists() {
                    panic!(
                        "Session file already exists for id \"{session_id}\": {}",
                        candidate.display()
                    );
                }
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
        self.has_assistant_entry = false;
        self.by_id.clear();
        self.labels_by_id.clear();
        self.label_timestamps_by_id.clear();
        self.leaf_id = None;
        self.flushed = false;
        if self.persist {
            self.session_file = session_file.clone();
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
                match &payload.label {
                    Some(label) => {
                        self.labels_by_id
                            .insert(payload.target_id.clone(), label.clone());
                        self.label_timestamps_by_id
                            .insert(payload.target_id.clone(), entry.timestamp().to_string());
                    }
                    None => {
                        self.labels_by_id.remove(&payload.target_id);
                        self.label_timestamps_by_id.remove(&payload.target_id);
                    }
                }
            }
        }
    }

    fn rewrite_file(&mut self) {
        let Some(session_file) = &self.session_file else {
            return;
        };
        if !self.persist {
            return;
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
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = atomic_write(session_file, &content);
        self.notify_persist_listeners();
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
    pub fn get_entries(&self) -> Vec<FileEntry> {
        self.file_entries
            .iter()
            .filter(|entry| !matches!(entry, FileEntry::Header { .. }))
            .cloned()
            .collect()
    }

    /// All entries including the header (whole-file views).
    pub fn get_all_entries(&self) -> &[FileEntry] {
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
    pub fn flush_now(&mut self) {
        if !self.persist || self.session_file.is_none() {
            return;
        }
        if self.flushed && self.session_file.as_ref().is_some_and(|path| path.exists()) {
            return;
        }
        self.rewrite_file();
        self.flushed = true;
    }

    /// Materialize an in-memory session into a persisted file.
    pub fn materialize_session_file(&mut self, session_dir: Option<PathBuf>) -> PathBuf {
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
        self.session_id = session_id.clone();
        self.session_file = Some(target.clone());
        self.persist = true;
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
    pub fn get_tree(&self) -> SessionTree {
        SessionTree::build(&self.file_entries)
    }

    /// Adopt a durable branch as this session's entries (TS
    /// `createBranchedSession`'s in-memory case, and the engine's
    /// post-navigation context rebuild): keeps the header, replaces every
    /// entry with the given chain, and re-indexes so the leaf is the last
    /// adopted entry. In-memory only — the caller owns any persistence.
    pub fn adopt_entries(&mut self, entries: Vec<FileEntry>) {
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

    fn persist_entry(&mut self, index: usize) {
        if !self.persist || self.session_file.is_none() {
            return;
        }
        let is_session_state_or_info = matches!(
            self.file_entries[index],
            FileEntry::SessionState { .. } | FileEntry::SessionInfo { .. }
        );
        if !self.has_assistant_entry && !is_session_state_or_info {
            self.flushed = false;
            return;
        }
        let file_exists = self.session_file.as_ref().is_some_and(|path| path.exists());
        if !self.flushed || !file_exists {
            // Recover from the session file disappearing under a live session:
            // append would recreate a headerless stub.
            self.rewrite_file();
            self.flushed = true;
        } else {
            let entry = serialize_entry(&self.file_entries[index]);
            if let Some(session_file) = &self.session_file {
                if let Some(parent) = session_file.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Ok(mut file) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(session_file)
                {
                    let mut line = entry.into_bytes();
                    line.push(b'\n');
                    // writeAll: loop until the whole line lands.
                    while !line.is_empty() {
                        match file.write(&line) {
                            Ok(0) => break,
                            Ok(written) => {
                                line.drain(..written);
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                            Err(_) => break,
                        }
                    }
                }
            }
            self.notify_persist_listeners();
        }
    }

    pub(crate) fn append_entry(&mut self, entry: FileEntry) {
        self.file_entries.push(entry);
        let index = self.file_entries.len() - 1;
        if matches!(
            self.file_entries[index],
            FileEntry::Message {
                message: AgentMessage::Assistant(_),
                ..
            }
        ) {
            self.has_assistant_entry = true;
        }
        if let Some(id) = self.file_entries[index].id().map(str::to_string) {
            self.by_id.insert(id.clone(), index);
            self.leaf_id = Some(id);
        }
        self.persist_entry(index);
    }

    pub(crate) fn next_base(&self) -> EntryBase {
        EntryBase {
            id: Some(generate_id(&self.by_id.keys().cloned().collect())),
            parent_id: self.leaf_id.clone(),
            timestamp: Some(format_iso_now()),
            rest: pa_types::JsonMap::new(),
        }
    }

    /// Append a conversation message; returns the new entry id.
    pub fn append_message(&mut self, message: AgentMessage) -> String {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::Message { message, base });
        id
    }

    pub fn append_thinking_level_change(&mut self, thinking_level: &str) -> String {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::ThinkingLevelChange {
            payload: pa_types::session::ThinkingLevelChangeEntry {
                thinking_level: thinking_level.to_string(),
            },
            base,
        });
        id
    }

    pub fn append_service_tier_change(
        &mut self,
        service_tier: Option<pa_types::ai::ServiceTier>,
    ) -> String {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::ServiceTierChange {
            payload: pa_types::session::ServiceTierChangeEntry { service_tier },
            base,
        });
        id
    }

    pub fn append_model_change(&mut self, provider: &str, model_id: &str) -> String {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::ModelChange {
            payload: pa_types::session::ModelChangeEntry {
                provider: provider.to_string(),
                model_id: model_id.to_string(),
            },
            base,
        });
        id
    }

    /// `appendCompaction`: persist the compaction record. The full typed
    /// payload is stored (TS keeps `details`, `fromHook`,
    /// `customInstructions`, `usage`, and `harnessDigest` on the durable
    /// row; later compactions and branch summarization read them back).
    pub fn append_compaction(&mut self, payload: pa_types::session::CompactionEntry) -> String {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::Compaction { payload, base });
        id
    }

    pub fn append_custom_entry(
        &mut self,
        custom_type: &str,
        data: Option<serde_json::Value>,
    ) -> String {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::Custom {
            payload: pa_types::session::CustomEntry {
                custom_type: custom_type.to_string(),
                data,
                rest: Default::default(),
            },
            base,
        });
        id
    }

    /// Append a custom message entry (compaction/refine notices, prompts).
    pub fn append_custom_message(
        &mut self,
        custom_type: &str,
        content: pa_types::ai::UserContent,
        display: bool,
        details: Option<serde_json::Value>,
    ) -> String {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::CustomMessage {
            payload: pa_types::session::CustomMessageEntry {
                custom_type: custom_type.to_string(),
                content,
                details,
                display,
                rest: Default::default(),
            },
            base,
        });
        id
    }

    /// Fold child usage into the target assistant message and record the
    /// attribution entry.
    pub fn append_child_usage_attribution(
        &mut self,
        target_id: &str,
        child_usage: pa_types::ai::Usage,
        aggregate_usage: pa_types::ai::Usage,
        origin: Option<ChildUsageOrigin>,
    ) -> String {
        let target_index = self
            .by_id
            .get(target_id)
            .copied()
            .filter(|&index| {
                matches!(
                    self.file_entries[index],
                    FileEntry::Message {
                        message: AgentMessage::Assistant(_),
                        ..
                    }
                )
            })
            .unwrap_or_else(|| panic!("Assistant message entry {target_id} not found"));
        if let FileEntry::Message {
            message: AgentMessage::Assistant(assistant),
            ..
        } = &mut self.file_entries[target_index]
        {
            assistant.usage = aggregate_usage;
        }
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
        });
        id
    }

    pub fn append_session_info(&mut self, name: &str) -> String {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::SessionInfo {
            payload: pa_types::session::SessionInfoEntry {
                name: Some(name.trim().to_string()),
            },
            base,
        });
        id
    }

    /// Look up an entry by id (file position index).
    pub fn get_entry_by_id(&self, id: &str) -> Option<&FileEntry> {
        self.by_id.get(id).map(|&index| &self.file_entries[index])
    }

    /// The active label for a target entry id.
    pub fn get_label(&self, target_id: &str) -> Option<String> {
        self.labels_by_id.get(target_id).cloned()
    }

    /// The timestamp of the label entry that set the target's active label.
    pub fn get_label_timestamp(&self, target_id: &str) -> Option<String> {
        self.label_timestamps_by_id.get(target_id).cloned()
    }

    /// Move the leaf (used by branch/branchWithSummary).
    pub(crate) fn set_leaf_id(&mut self, leaf_id: Option<&str>) {
        self.leaf_id = leaf_id.map(str::to_string);
    }

    /// Apply a label entry to the label index (last label wins).
    pub(crate) fn apply_label_entry(
        &mut self,
        target_id: &str,
        label: Option<&str>,
        timestamp: &str,
    ) {
        match label {
            Some(label) => {
                self.labels_by_id
                    .insert(target_id.to_string(), label.to_string());
                self.label_timestamps_by_id
                    .insert(target_id.to_string(), timestamp.to_string());
            }
            None => {
                self.labels_by_id.remove(target_id);
                self.label_timestamps_by_id.remove(target_id);
            }
        }
    }

    pub fn append_session_state(&mut self, status: SessionStateStatus) -> String {
        let base = self.next_base();
        let id = base.id.clone().unwrap_or_default();
        self.append_entry(FileEntry::SessionState {
            payload: pa_types::session::SessionStateEntry {
                state: SessionState { status },
            },
            base,
        });
        id
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

    /// The durable compaction line is the full TS `CompactionEntry` record:
    /// `fromHook: false` is present (never a missing key), and the details
    /// and usage ride along.
    #[test]
    fn append_compaction_serializes_the_full_ts_record() {
        let tmp = tempfile::tempdir().unwrap();
        let mut manager = SessionManager::in_memory(tmp.path());
        manager.append_compaction(pa_types::session::CompactionEntry {
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
                cost: Default::default(),
            }),
            harness_digest: None,
        });
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
        manager.append_message(AgentMessage::Assistant(pa_types::ai::AssistantMessage {
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
            rest: Default::default(),
        }));
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
            rest: Default::default(),
        });
        manager.append_message(assistant.clone());
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
        manager.append_session_info("my session");
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
}
