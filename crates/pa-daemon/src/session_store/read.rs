//! The read arm: the file-IO load surface — the streamed and windowed opens, the bounded
//! header-only readers, the file-layout helpers, and the in-memory create.

use super::view::is_warning_shown_row;
use super::{
    anyhow, fold_child_usage_attributions, fs, message_text, BufRead, Context, HashMap, Map, Path,
    PathBuf, Read, Result, SessionEntry, SessionFile, SessionHeader, SessionWindow, Value,
};

const CURRENT_SESSION_VERSION: u32 = 3;

fn new_session_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[must_use]
pub fn session_file_name(session_id: &str) -> String {
    format!("{session_id}.jsonl")
}

#[must_use]
pub fn parse_session_entries(content: &str) -> Vec<Value> {
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            serde_json::from_str(trimmed).ok()
        })
        .collect()
}

/// The bounded first-line read cap for header-only judgments: a session
/// header line lands well inside 512 bytes.
pub const SESSION_LIST_HEADER_READ_MAX_BYTES: usize = 512;

/// Parse one session file line as the `session` header: a JSON object tagged
/// `session` that deserializes into the typed header.
pub(crate) fn parse_session_header_line(line: &str) -> Option<SessionHeader> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    serde_json::from_value(value).ok()
}

/// Read the file's first line when it ends within `max_bytes` bytes. `None`
/// when no line ends within the bound: the caller judges with a full read,
/// never on truncated bytes. A final line without a trailing newline still
/// counts.
pub(crate) fn read_first_line_bounded(path: &Path, max_bytes: usize) -> Option<Vec<u8>> {
    let mut file = fs::File::open(path).ok()?;
    read_first_line_bounded_from(&mut file, max_bytes)
}

/// The bounded first-line read over an already-open handle (the roster gate shares one
/// open with the fold).
pub(crate) fn read_first_line_bounded_from(
    file: &mut fs::File,
    max_bytes: usize,
) -> Option<Vec<u8>> {
    // One byte over the cap separates a line that fits (judgeable) from an
    // over-long one: a newline at index `max_bytes` still bounds a full line.
    let mut buf = vec![0u8; max_bytes + 1];
    let mut filled = 0;
    while filled < buf.len() {
        let read = file.read(&mut buf[filled..]).ok()?;
        if read == 0 {
            return (filled > 0).then(|| strip_line_return(&buf[..filled]));
        }
        if let Some(at) = buf[filled..filled + read]
            .iter()
            .position(|&byte| byte == b'\n')
        {
            if filled + at > max_bytes {
                return None;
            }
            return Some(strip_line_return(&buf[..filled + at]));
        }
        filled += read;
    }
    None
}

/// Drop one `\r\n` line return off the line's own bytes, like `str::lines`.
fn strip_line_return(line: &[u8]) -> Vec<u8> {
    let mut line = line.to_vec();
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    line
}

/// The session file's header, read from the first line bounded to
/// [`SESSION_LIST_HEADER_READ_MAX_BYTES`]: `None` also covers an over-long
/// first line — the bounded read refuses to judge a truncated one.
#[must_use]
pub fn read_session_header_bounded(path: &Path) -> Option<SessionHeader> {
    let line = read_first_line_bounded(path, SESSION_LIST_HEADER_READ_MAX_BYTES)?;
    let text = std::str::from_utf8(&line).ok()?;
    parse_session_header_line(text)
}

/// Read the first line of a session file and parse it as a header.
#[must_use]
pub fn read_session_header(path: &Path) -> Option<SessionHeader> {
    let file = fs::File::open(path).ok()?;
    let mut first = String::new();
    std::io::BufReader::new(file).read_line(&mut first).ok()?;
    parse_session_header_line(&first)
}

/// A session file is valid when its first line is a `session` header, judged
/// on the bounded header read.
#[must_use]
pub fn is_valid_session_file(path: &Path) -> bool {
    read_session_header_bounded(path).is_some()
}

impl SessionFile {
    /// Load an existing session file; malformed entry lines are skipped (the TS loader).
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be read, is empty, or its header is invalid.
    pub fn open(path: &Path) -> Result<Self> {
        // Streamed line-by-line load: one line is resident at a time, so a grown session
        // never holds the raw file bytes alongside the parsed entries.
        let file = fs::File::open(path)
            .with_context(|| format!("read session file {}", path.display()))?;
        let mut lines = std::io::BufReader::new(file).lines();
        let read_context = || format!("read session file {}", path.display());
        let mut first = None;
        for line in lines.by_ref() {
            let line = line.with_context(read_context)?;
            if !line.trim().is_empty() {
                first = Some(line);
                break;
            }
        }
        let first = first.ok_or_else(|| anyhow!("empty session file {}", path.display()))?;
        let header_value: Value = serde_json::from_str(first.trim())
            .with_context(|| format!("invalid session header in {}", path.display()))?;
        if header_value.get("type").and_then(Value::as_str) != Some("session") {
            return Err(anyhow!("missing session header in {}", path.display()));
        }
        let header: SessionHeader = serde_json::from_value(header_value)
            .with_context(|| format!("invalid session header in {}", path.display()))?;
        let mut file = SessionFile {
            path: path.to_path_buf(),
            header,
            entries: Vec::new(),
            by_id: HashMap::new(),
            leaf_id: None,
            window: None,
            lease: None,
            anthropic_warning_shown: false,
        };
        for line in lines {
            let line = line.with_context(read_context)?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Malformed lines are skipped, matching the TS loader.
            if let Ok(entry) = serde_json::from_str::<SessionEntry>(trimmed) {
                file.push_index(entry);
            }
        }
        fold_child_usage_attributions(&mut file.entries);
        // The once-per-lifecycle gate rides the ACTIVE branch, exactly
        // like the windowed walk below: a marker on an abandoned or
        // sibling branch never suppresses the warning for the open leaf
        // (fail-open — an off-path marker must not hide the warning on a
        // branch that never showed it).
        file.anthropic_warning_shown = file.branch().iter().copied().any(is_warning_shown_row);
        Ok(file)
    }

    /// Load the verified compacted context without decoding old message bodies.
    ///
    /// # Errors
    ///
    /// Returns an error when the windowed load fails or holds no header; a
    /// malformed retained row falls back to [`SessionFile::open`].
    pub fn open_windowed(path: &Path) -> Result<Self> {
        let Some(mut window) = pa_core::session::window::WindowedSessionStore::open(path)? else {
            return Self::open(path);
        };
        let header = window
            .entries()
            .iter()
            .find_map(|entry| match entry {
                pa_types::session::FileEntry::Header { header } => Some(header.clone()),
                _ => None,
            })
            .ok_or_else(|| anyhow!("window has no session header"))?;
        // The window's walk already hydrated the once-per-session-lifecycle
        // warning gate from the whole active branch (the row may sit in the
        // discarded prefix, far outside this store's retained rows).
        let anthropic_warning_shown = window.anthropic_warning_shown();
        let mut file = Self {
            path: path.to_owned(),
            header,
            entries: Vec::new(),
            by_id: HashMap::new(),
            leaf_id: None,
            window: None,
            lease: None,
            anthropic_warning_shown,
        };
        // The raw rows are consumed in place: each line String drops as soon as its
        // parsed entry joins the store.
        let raw_count = window.raw_entries().len();
        for line in window
            .take_metadata_entries()
            .into_iter()
            .chain(window.take_raw_entries())
        {
            let Ok(entry) = serde_json::from_str(&line) else {
                return Self::open(path);
            };
            file.push_index(entry);
        }
        // The window parses the retained-target attributions BEFORE the raw
        // retained rows, so the fold runs once every row is in.
        fold_child_usage_attributions(&mut file.entries);
        file.leaf_id = Some(window.leaf_id().to_owned());
        let context = window.context();
        file.window = Some(SessionWindow {
            message_count: window.message_count(),
            first_message: window
                .first_user_message()
                .map(message_text)
                .filter(|text| !text.is_empty()),
            loaded_entries: file.entries.len(),
            compaction_count: window.compaction_count(),
            has_thinking_level: window.has_thinking_level(),
            has_service_tier: window.has_service_tier(),
            model: context.model,
            boundary_model: window.boundary_model().cloned(),
            thinking_level: context.thinking_level,
            service_tier: context.service_tier,
            // The retained rows joined the store verbatim above, so their ids are
            // exactly the trailing `raw_count` store ids — no third parse pass.
            retained_ids: file.entries[file.entries.len() - raw_count..]
                .iter()
                .map(|entry| entry.id.clone())
                .collect(),
            older_path_stats: window.older_path_stats().clone(),
        });
        Ok(file)
    }

    #[cfg(test)]
    pub(super) fn ensure_full_history(&mut self) -> Result<()> {
        if self.window.is_some() {
            let full = Self::open(&self.path)?;
            self.install_full_history(full);
        }
        Ok(())
    }

    /// Merge appends made while the disk snapshot loaded without holding the store lock.
    pub(crate) fn install_full_history(&mut self, mut full: Self) {
        let Some(window) = &self.window else {
            return;
        };
        for entry in &self.entries[window.loaded_entries..] {
            if !full.by_id.contains_key(&entry.id) {
                full.push_index(entry.clone());
            }
        }
        full.leaf_id.clone_from(&self.leaf_id);
        full.lease.clone_from(&self.lease);
        // The merged store's leaf is the window's leaf: re-derive the gate
        // from the merged ACTIVE branch — the full open's own-leaf answer
        // can disagree, a post-snapshot marker must hydrate, and an
        // off-path one must not (the full scan never wins here).
        full.anthropic_warning_shown = full.branch().iter().copied().any(is_warning_shown_row);
        *self = full;
    }

    /// Create a new in-memory session; persisted with the first flush.
    pub fn create(cwd: &str, parent_session: Option<&str>, rlm_depth: u32) -> Self {
        let header = SessionHeader {
            version: Some(CURRENT_SESSION_VERSION),
            id: new_session_id(),
            timestamp: crate::util::now_iso(),
            cwd: cwd.to_string(),
            parent_session: parent_session.map(str::to_string),
            rlm_depth: Some(u64::from(rlm_depth)),
            git: None,
            rest: Map::default(),
        };
        SessionFile {
            path: PathBuf::new(),
            header,
            entries: Vec::new(),
            by_id: HashMap::new(),
            leaf_id: None,
            window: None,
            lease: None,
            anthropic_warning_shown: false,
        }
    }
}
