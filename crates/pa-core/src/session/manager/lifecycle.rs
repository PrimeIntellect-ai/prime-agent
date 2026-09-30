//! The lifecycle concern (moved with its concern): the constructors,
//! the open/fork/new/materialize/adopt arm, and the fork's branch-copy
//! helpers (TS SessionManager.forkFrom).

#[cfg(test)]
use super::repair::repair_jsonl_damage;
use super::{
    capture_git_context, create_session_id, format_iso_now, get_session_file_path,
    is_valid_rlm_depth, load_entries_from_file, migrate_to_current_version,
    resolve_session_rlm_depth, root_rlm_depth_from_env, AgentMessage, FileEntry, HashMap,
    NewSessionOptions, Path, PathBuf, SessionHeader, SessionManager, CURRENT_SESSION_VERSION,
};

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
            write_poison: None,
            #[cfg(test)]
            notice_append_fault: false,
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
    #[must_use]
    pub fn persisted(cwd: &Path, session_dir: &Path) -> Self {
        Self::new_with(cwd.to_path_buf(), session_dir.to_path_buf(), None, true)
    }

    /// Create an in-memory (non-persisted) manager.
    #[must_use]
    pub fn in_memory(cwd: &Path) -> Self {
        Self::new_with(cwd.to_path_buf(), cwd.to_path_buf(), None, false)
    }

    /// Create an in-memory (non-persisted) manager pinned to a session's
    /// own directory: the daemon worker owns the durable file and mirrors
    /// the entries, but the session's identity (its directory, the local
    /// harness state's home) stays the session's own.
    #[must_use]
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
    #[must_use]
    pub fn has_session_dir(&self) -> bool {
        self.session_dir_backed
    }

    /// Open an existing session file (repair + migrate), or a fresh one.
    #[must_use]
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
            // The production adoption path: one-copy move (the test
            // constructor rides the same detach semantics the daemon's
            // engine uses).
            manager.adopt_window(window);
            Ok(manager)
        })
        .await?
    }
    /// Adopt a verified read-only window into an externally persisted manager.
    /// The adopted file is complete and appendable (the window's boundary
    /// proves real message history), so the manager joins with the same
    /// durable-append invariants the test constructor installs: rows go
    /// straight to disk — never deferred behind the bootstrap rule, whose
    /// `flushed = false` would later send `flush_now` into the
    /// window-failing rewrite path.
    pub fn adopt_window(&mut self, mut window: super::window::WindowedSessionStore) {
        // One-copy adoption: the walk's parsed trees move in (no `to_vec`
        // clone), and the raw JSONL lines drop here — the file itself is the
        // durable raw copy, and a second resident typed copy plus the raw
        // lines measured ~29.5MiB of wire-equivalent duplication on the
        // 10MiB canonical fixture (worker-rss census, 2026-09-26). The
        // window stays attached for its snapshot/settings/metadata state;
        // `active_context` walks `file_entries` with the window's settings
        // overlay, so the served context is unchanged.
        let (entries, _raw_entries) = window.take_retained();
        self.file_entries = entries;
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
}
