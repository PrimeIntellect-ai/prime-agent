//! The per-file info scan (moved with its concern): the resumable listing
//! fold - the generation identity, the LRU-bounded scan-state cache, the
//! resumed line fold over raw spans, the derived `SessionInfo`, and the
//! most-recent-session lookup.

use super::{
    fs, list_sessions, normalize_state_status, Cow, Deserialize, HashMap, Path, PathBuf,
    SessionHeader, Usage, Value,
};

/// Port of `readSessionInfo`'s fold (single pass, no resume cache): the durable
/// metadata the daemon list surfaces for one session file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub path: PathBuf,
    pub id: String,
    pub cwd: String,
    pub name: Option<String>,
    pub state: Option<String>,
    pub model: Option<(String, String)>,
    /// The last persisted `thinking_level_change` level (the durable row
    /// `set_thinking_level` writes); agents-view summaries surface it for
    /// sessions without a live worker (top-level and subagent alike).
    pub thinking_level: Option<String>,
    pub parent_session_path: Option<String>,
    pub rlm_depth: u32,
    pub created: String,
    pub modified: String,
    pub message_count: usize,
    pub first_message: String,
    /// Every user/assistant message text, concatenated, capped at
    /// `SESSION_LIST_SEARCH_TEXT_MAX_CHARS` (TS `allMessagesText`: the
    /// agents-view full-transcript search corpus).
    pub all_messages_text: String,
    /// TS `SessionInfo.usage`: the own-usage summary — assistant
    /// aggregates plus summarization calls, minus every attributed child
    /// block (`session_usage::UsageScan`; the child's own row carries the
    /// child spend). `None` when the session recorded no billable work.
    pub usage: Option<crate::session_usage::SessionUsageSummary>,
    /// TS `SessionInfo.deletedDescendantUsage`: the recursive spend of
    /// ledger-tombstoned descendants, attached by the catalog's listing
    /// arm from the spawn ledger's deleted-descendant bucket (one read
    /// per list, keyed by canonical parent path — TS
    /// `withPassiveRlmDescendantInfos`). The agents-view recursive cost
    /// rollup bills it to this row's own cost. Never set by the file
    /// scan: it is ledger-derived, not transcript-derived.
    pub deleted_descendant_usage: Option<crate::session_usage::SessionUsageSummary>,
}

/// TS `SESSION_LIST_SEARCH_TEXT_MAX_CHARS`: the transcript search-text cap.
pub const SESSION_LIST_SEARCH_TEXT_MAX_CHARS: usize = 64 * 1024;

/// The roster fold's read-buffer size: the default 8 KiB chunks a grown
/// session file into one read syscall per 8 KiB (a 1,000-file cold scan
/// paid thousands of extra reads); one 64 KiB fill reads the typical
/// session in a single syscall. Line semantics are `BufRead::read_line`'s
/// either way - only the syscall chunking changes, never the folded
/// bytes or the resume cursor.
const SESSION_SCAN_READ_BUF_BYTES: usize = 64 * 1024;

/// TS `appendCappedSearchText`: space-join the texts, cut the final
/// addition so the corpus never grows past the cap. `used` is the corpus's
/// char count before this append; the returned count is the corpus's char
/// count after it, so the fold keeps an O(1) running counter instead of
/// re-counting the capped string for every message.
pub(super) fn append_capped_search_text(current: &mut String, text: &str, used: usize) -> usize {
    if text.is_empty() {
        return used;
    }
    if used >= SESSION_LIST_SEARCH_TEXT_MAX_CHARS {
        return used;
    }
    let mut count = used;
    if count > 0 {
        current.push(' ');
        count += 1;
    }
    let remaining = SESSION_LIST_SEARCH_TEXT_MAX_CHARS - count;
    let mut taken = 0;
    current.extend(text.chars().take(remaining).inspect(|_| taken += 1));
    count + taken
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SessionInfoGeneration {
    pub(super) len: u64,
    pub(super) dev: u64,
    pub(super) ino: u64,
    pub(super) mtime: i64,
    pub(super) mtime_ns: i64,
    pub(super) ctime: i64,
    pub(super) ctime_ns: i64,
}

impl SessionInfoGeneration {
    #[cfg(unix)]
    pub(super) fn from_metadata(meta: &fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            len: meta.len(),
            dev: meta.dev(),
            ino: meta.ino(),
            mtime: meta.mtime(),
            mtime_ns: meta.mtime_nsec(),
            ctime: meta.ctime(),
            ctime_ns: meta.ctime_nsec(),
        }
    }

    #[cfg(not(unix))]
    pub(super) fn from_metadata(meta: &fs::Metadata) -> Self {
        Self {
            len: meta.len(),
            dev: 0,
            ino: 0,
            mtime: 0,
            mtime_ns: 0,
            ctime: 0,
            ctime_ns: 0,
        }
    }
}

/// TS `SESSION_SCAN_MAX_RETAINED_USAGE_ENTRIES`: the cross-file memory
/// budget on retained per-assistant-message usage records. Whole-state
/// LRU eviction can force a full catalog rescan every refresh, so keep
/// large families (~2k sessions, 150k usage entries) and growth headroom
/// resident (session-manager.ts).
const SESSION_SCAN_MAX_RETAINED_USAGE_ENTRIES: usize = 400_000;

/// The cached-state count ceiling: files with no usage records never trip
/// the usage budget, so the state count needs its own cap. The cap must
/// sit well ABOVE a catalog refresh's working set (every saved session
/// plus every passive child walks into the cache on one list; TS's design
/// point is ~2k sessions resident) - a cap inside the working set would
/// evict mid-walk and thrash every pass into a full rescan. 4096 keeps
/// the ~2k families plus headroom while bounding unbounded-growth; eviction
/// stays LRU-first (never the old clear-all).
pub(super) const SESSION_SCAN_MAX_CACHED_STATES: usize = 4096;

/// TS `sessionScanStates` + `storeSessionScanState`'s accounting: the
/// states map with its insertion order (JS Map iteration order — the LRU
/// eviction walks from the front) and the retained-usage-entry counter.
#[derive(Default)]
pub(super) struct SessionInfoScanCache {
    pub(super) states: HashMap<PathBuf, SessionScanState>,
    /// Oldest first. One ordinal per live state keeps the recency index
    /// bounded even when the same roster is refreshed indefinitely.
    pub(super) order: std::collections::BTreeMap<u64, PathBuf>,
    pub(super) ordinal_by_path: HashMap<PathBuf, u64>,
    pub(super) next_ordinal: u64,
    retained_usage_entries: usize,
}

impl SessionInfoScanCache {
    /// TS `dropSessionScanState`.
    pub(super) fn drop_state(&mut self, path: &Path) {
        if let Some(state) = self.states.remove(path) {
            self.retained_usage_entries -= state.accounted_usage_entries;
        }
        if let Some(ordinal) = self.ordinal_by_path.remove(path) {
            self.order.remove(&ordinal);
        }
    }

    fn mark_recent(&mut self, path: &Path) {
        if let Some(ordinal) = self.ordinal_by_path.remove(path) {
            self.order.remove(&ordinal);
        }
        // Rollover is unreachable in practice, but rebuilding the tiny
        // (at most 4096 entries) recency index preserves exact LRU order.
        if self.next_ordinal == u64::MAX {
            let ordered: Vec<PathBuf> = self.order.values().cloned().collect();
            self.order.clear();
            self.ordinal_by_path.clear();
            for (ordinal, old_path) in ordered.into_iter().enumerate() {
                let ordinal = ordinal as u64;
                self.ordinal_by_path.insert(old_path.clone(), ordinal);
                self.order.insert(ordinal, old_path);
            }
            self.next_ordinal = self.order.len() as u64;
        }
        let ordinal = self.next_ordinal;
        self.next_ordinal += 1;
        self.ordinal_by_path.insert(path.to_path_buf(), ordinal);
        self.order.insert(ordinal, path.to_path_buf());
    }

    /// The unchanged-file hit re-stores in TS (`storeSessionScanState
    /// (filePath, previous)`) — LRU recency without re-accounting.
    pub(super) fn touch(&mut self, path: &Path) {
        if self.states.contains_key(path) {
            self.mark_recent(path);
        }
    }

    /// TS `storeSessionScanState`: (re-)store with fresh accounting, then
    /// evict insertion-order-first states until the budget holds.
    pub(super) fn store_state(&mut self, path: &Path, state: SessionScanState) {
        self.drop_state(path);
        let mut state = state;
        state.accounted_usage_entries = state.acc.usage_scan.retained_entries();
        self.retained_usage_entries += state.accounted_usage_entries;
        self.states.insert(path.to_path_buf(), state);
        self.mark_recent(path);
        while self.retained_usage_entries > SESSION_SCAN_MAX_RETAINED_USAGE_ENTRIES
            || self.states.len() > SESSION_SCAN_MAX_CACHED_STATES
        {
            let Some((_, front)) = self.order.first_key_value() else {
                break;
            };
            let front = front.clone();
            self.drop_state(&front);
        }
    }
}

pub(super) fn session_info_cache() -> &'static std::sync::Mutex<SessionInfoScanCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<SessionInfoScanCache>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(SessionInfoScanCache::default()))
}

/// TS `SESSION_SCAN_RESUME_TAIL_BYTES`: the trailing window of the consumed
/// prefix a resumed scan verifies before trusting the cached fold state
/// (`scannedPrefixIntact`). The product appends, so a same-identity,
/// same-size rewrite is the aliasing risk the check covers.
pub(super) const SESSION_SCAN_RESUME_TAIL_BYTES: usize = 16;

/// TS `SessionScanAccumulator`: the per-file fold state a resume continues
/// from. The finished [`SessionInfo`] is derived from this; the cached state
/// carries the accumulator so a grown file folds ONLY its appended entries.
/// Clone is the snapshot fold's copy (TS `snapshotSessionInfo`).
#[derive(Clone, Default)]
pub(super) struct SessionScanAccumulator {
    header: Option<SessionHeader>,
    name: Option<String>,
    state: Option<String>,
    model: Option<(String, String)>,
    thinking_level: Option<String>,
    pub(super) message_count: usize,
    pub(super) first_message: String,
    pub(super) all_messages_text: String,
    /// [`SessionScanAccumulator::all_messages_text`]'s char count, kept in
    /// lockstep by the only writer (`append_capped_search_text`): the cap
    /// guard and the append read this O(1) counter instead of re-counting
    /// the capped string per message (an O(messages x cap) fold tax).
    pub(super) search_text_chars: usize,
    last_activity_ms: Option<u64>,
    usage_scan: crate::session_usage::UsageScan,
}

/// One cached scan state (TS `SessionScanState`): the generation the state
/// was certified at, the fold accumulator, the consumed-prefix cursor, the
/// resume tail, and the derived info.
pub(super) struct SessionScanState {
    generation: SessionInfoGeneration,
    pub(super) acc: SessionScanAccumulator,
    /// Bytes consumed through the end of the last complete line.
    offset: u64,
    /// The trailing window of the consumed prefix (TS `advanceScanTail`).
    pub(super) tail: [u8; SESSION_SCAN_RESUME_TAIL_BYTES],
    info: Option<SessionInfo>,
    /// Usage entries counted against the retained bound at the last store
    /// (TS `accountedUsageEntries`).
    accounted_usage_entries: usize,
}

impl SessionScanState {
    pub(super) fn fresh(generation: SessionInfoGeneration) -> Self {
        Self {
            generation,
            acc: SessionScanAccumulator::default(),
            offset: 0,
            tail: [b'\n'; SESSION_SCAN_RESUME_TAIL_BYTES],
            info: None,
            accounted_usage_entries: 0,
        }
    }

    /// The resume copy: the fold state travels, the derived info does not
    /// (the appended entries rebuild it).
    pub(super) fn clone_for_resume(&self) -> Self {
        Self {
            generation: self.generation,
            acc: SessionScanAccumulator {
                header: self.acc.header.clone(),
                name: self.acc.name.clone(),
                state: self.acc.state.clone(),
                model: self.acc.model.clone(),
                thinking_level: self.acc.thinking_level.clone(),
                message_count: self.acc.message_count,
                first_message: self.acc.first_message.clone(),
                all_messages_text: self.acc.all_messages_text.clone(),
                search_text_chars: self.acc.search_text_chars,
                last_activity_ms: self.acc.last_activity_ms,
                usage_scan: self.acc.usage_scan.clone(),
            },
            offset: self.offset,
            tail: self.tail,
            info: None,
            accounted_usage_entries: 0,
        }
    }

    /// TS `seedRosterLedger`-side identity: the resume requires the same
    /// file (dev/ino) with a grown-or-equal length.
    fn same_file_identity(&self, generation: &SessionInfoGeneration) -> bool {
        #[cfg(unix)]
        {
            self.generation.dev == generation.dev && self.generation.ino == generation.ino
        }
        // No dev/ino from std on this platform, so a grown file cannot be
        // certified as the same inode: every grown file rescans whole (TS
        // always has dev/ino from Node fs stats). An mtime-based identity
        // would instead certify an in-place rewrite as a resume.
        #[cfg(not(unix))]
        {
            false
        }
    }

    /// TS `advanceScanTail`: the consumed prefix's trailing window. A line at
    /// least as long as the window keeps only its last bytes plus the
    /// newline; a short line rolls into the previous window first. Both
    /// cases copy inside the fixed window — the old shape allocated a
    /// fresh `Vec` per line just to keep the last 16 bytes, so the scan
    /// paid a `line.len()+17` allocation for every row it folded.
    pub(super) fn advance_tail(&mut self, line: &[u8]) {
        let keep = SESSION_SCAN_RESUME_TAIL_BYTES - 1;
        if line.len() >= keep {
            // The window is the line's last `keep` bytes plus the newline.
            self.tail[..keep].copy_from_slice(&line[line.len() - keep..]);
            self.tail[keep] = b'\n';
        } else {
            // The short line rolls: the old window shifts left by the
            // line's own length plus its newline, the line lands in front
            // of the final newline byte.
            let shift = line.len() + 1;
            self.tail.copy_within(shift.., 0);
            let at = SESSION_SCAN_RESUME_TAIL_BYTES - shift;
            self.tail[at..keep].copy_from_slice(line);
            self.tail[keep] = b'\n';
        }
    }

    /// TS `scannedPrefixIntact`: the bytes just before the cursor match the
    /// cached window, proving the resume starts where the cached fold left
    /// off (a torn write or a rewrite that raced the scan is caught here).
    /// Session files are append-only between whole-file rewrites; an
    /// in-place interior edit that keeps the identity, growth, and this
    /// window intact defeats the check on TS too - outside the writer
    /// model (session-manager.ts: "In-place interior edits that defeat all
    /// four are outside the writer model").
    fn prefix_intact(&self, file: &fs::File) -> bool {
        use std::io::{Read, Seek, SeekFrom};
        if self.offset == 0 {
            return true;
        }
        let window = SESSION_SCAN_RESUME_TAIL_BYTES as u64;
        let start = self.offset.saturating_sub(window);
        let len = (self.offset - start) as usize;
        let mut read_back = vec![0u8; len];
        let mut cursor = file;
        if cursor.seek(SeekFrom::Start(start)).is_err() {
            return false;
        }
        if cursor.read_exact(&mut read_back).is_err() {
            return false;
        }
        read_back.as_slice() == &self.tail[self.tail.len() - len..]
    }
}

/// The listing fold only needs message metadata after the search corpus is
/// full. Unknown fields are skipped by serde; the fields the fold reads
/// ride as borrowed raw spans (zero copy, no materialization), so a row
/// re-parses only the spans its arm touches instead of the whole entry.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionInfoMessage<'a> {
    #[serde(default, borrow)]
    pub(super) role: Option<&'a serde_json::value::RawValue>,
    #[serde(default, borrow)]
    pub(super) provider: Option<&'a serde_json::value::RawValue>,
    #[serde(default, borrow)]
    pub(super) model: Option<&'a serde_json::value::RawValue>,
    #[serde(default, borrow)]
    pub(super) timestamp: Option<&'a serde_json::value::RawValue>,
    /// The lenient scan-side shape ([`crate::session_usage::ScanUsage`]):
    /// a partial persisted block must not reject the row.
    #[serde(default)]
    usage: Option<crate::session_usage::ScanUsage>,
    /// The message's `content`, borrowed from the scanned line (zero
    /// copy, no materialization): the corpus and first-message text read
    /// it only when the fold's guard passes.
    #[serde(default, borrow)]
    pub(super) content: Option<&'a serde_json::value::RawValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionInfoEntry<'a> {
    #[serde(borrow, rename = "type")]
    pub(super) type_: Cow<'a, str>,
    #[serde(borrow, rename = "id")]
    pub(super) id: Cow<'a, str>,
    #[serde(borrow, rename = "timestamp")]
    pub(super) _timestamp: Cow<'a, str>,
    #[serde(borrow, default, rename = "parentId")]
    pub(super) _parent_id: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    pub(super) name: Option<&'a serde_json::value::RawValue>,
    #[serde(default, borrow)]
    pub(super) state: Option<&'a serde_json::value::RawValue>,
    #[serde(default, borrow)]
    pub(super) provider: Option<&'a serde_json::value::RawValue>,
    #[serde(default, borrow)]
    pub(super) model_id: Option<&'a serde_json::value::RawValue>,
    #[serde(default, borrow)]
    pub(super) thinking_level: Option<&'a serde_json::value::RawValue>,
    #[serde(default, borrow)]
    pub(super) message: Option<SessionInfoMessage<'a>>,
    /// `child_usage_attributed`: the parent entry the aggregate folds into.
    #[serde(borrow, default)]
    pub(super) target_id: Option<Cow<'a, str>>,
    #[serde(default)]
    child_usage: Option<crate::session_usage::ScanUsage>,
    #[serde(default)]
    aggregate_usage: Option<crate::session_usage::ScanUsage>,
    /// `compaction`/`branch_summary`: the summarization call's own usage.
    #[serde(default)]
    usage: Option<crate::session_usage::ScanUsage>,
}

/// Read a session file's list metadata (TS `readSessionInfo` over the
/// resumable per-file scan states): an unchanged file answers from the
/// cached fold, a grown file folds ONLY its appended entries after the
/// prefix-tail check, and a rewritten file rescans from the top.
#[must_use]
pub fn read_session_info(path: &Path) -> Option<SessionInfo> {
    let mut file = fs::File::open(path).ok()?;
    read_session_info_from(&mut file, path)
}

/// [`read_session_info`] over an already-open handle: the roster gate
/// shares one open with the fold (the gate reads the first line, the fold
/// rewinds the same handle and folds from byte 0), every other caller
/// passes a fresh open.
pub(crate) fn read_session_info_from(file: &mut fs::File, path: &Path) -> Option<SessionInfo> {
    let generation = SessionInfoGeneration::from_metadata(&file.metadata().ok()?);

    // The unchanged case answers from the cache; the grown case resumes.
    let mut state = {
        let mut cache = session_info_cache().lock().ok()?;
        match cache.states.get(path) {
            Some(cached) if cached.generation == generation => {
                let info = cached.info.clone();
                cache.touch(path);
                return info;
            }
            Some(cached)
                if cached.same_file_identity(&generation)
                    && generation.len > cached.generation.len =>
            {
                if cached.prefix_intact(file) {
                    cached.clone_for_resume()
                } else {
                    SessionScanState::fresh(generation)
                }
            }
            _ => SessionScanState::fresh(generation),
        }
    };
    // Position the shared cursor at the resume point. A fresh state rewinds
    // to byte 0: `prefix_intact` leaves the cursor at the old consumed end
    // (its tail-window read), and a fresh scan started there would miss the
    // session header. TS restarts its stream at `state.offset` every scan.
    if std::io::Seek::seek(file, std::io::SeekFrom::Start(state.offset)).is_err() {
        return None;
    }
    let torn_tail = {
        let mut reader = std::io::BufReader::with_capacity(SESSION_SCAN_READ_BUF_BYTES, &mut *file);
        state.scan_from_cursor(&mut reader, generation.len)?
    };
    // TS's listing stat (`stats.mtime`): the durable last-resort value for
    // `modified`, captured from the open file like TS captures it at
    // readdir. `None` keeps unavailable (unreadable, pre-epoch) metadata
    // distinct from a real epoch timestamp. The stat is read lazily —
    // only when the `modified` fallback chain actually reaches it (a row
    // with message timestamps, or a parseable header timestamp, never
    // does) — the same metadata at the same moment the eager read paid a
    // per-file stat for on every scan.
    let stats_mtime_ms = || {
        file.metadata().ok().and_then(|meta| {
            meta.modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
        })
    };
    let info = state.build_info(path, stats_mtime_ms, Some(&torn_tail))?;
    // A concurrent append/replacement must never certify stale metadata.
    // Records without message timestamps never certify either: their
    // `modified` is a durable value now (header time, then mtime), but the
    // fold re-reads them instead of trusting a certified copy.
    let modified_ms = state.acc.last_activity_ms.unwrap_or(0);
    if cfg!(unix)
        && modified_ms > 0
        && file
            .metadata()
            .is_ok_and(|meta| SessionInfoGeneration::from_metadata(&meta) == generation)
        && fs::metadata(path)
            .is_ok_and(|meta| SessionInfoGeneration::from_metadata(&meta) == generation)
    {
        state.generation = generation;
        state.info = Some(info.clone());
        if let Ok(mut cache) = session_info_cache().lock() {
            cache.store_state(path, state);
        }
    }
    Some(info)
}

impl SessionScanState {
    /// Fold lines from the cursor (TS `scanSessionLines`): a complete line
    /// advances the cursor and the tail; an unterminated final line is
    /// never consumed (it may still be an in-progress append) and is
    /// returned as the snapshot-only torn tail. `None` = the abort arm.
    fn scan_from_cursor(
        &mut self,
        reader: &mut std::io::BufReader<&mut fs::File>,
        size: u64,
    ) -> Option<String> {
        let mut line = String::new();
        loop {
            line.clear();
            let consumed = std::io::BufRead::read_line(reader, &mut line).ok()?;
            if consumed == 0 {
                break;
            }
            let complete = line.ends_with('\n');
            if !complete && (self.offset + consumed as u64) >= size {
                // A torn trailing line: not folded here, the cursor stays
                // put so the completed line folds on the next scan; the
                // caller folds it into the current snapshot only.
                return Some(line);
            }
            if complete {
                line.pop();
            }
            fold_scan_entry(&mut self.acc, &line)?;
            self.offset += consumed as u64;
            self.advance_tail(line.as_bytes());
            if !complete {
                break;
            }
        }
        Some(String::new())
    }

    /// Derive the listing row (the tail of the old full scan). A non-empty
    /// torn tail folds into a SNAPSHOT copy of the accumulator (TS
    /// `snapshotSessionInfo`): the valid unterminated final line reaches
    /// the row, while the consumed prefix - the resumable state - stays
    /// untouched for the scan that sees the terminating newline.
    pub(super) fn build_info(
        &self,
        path: &Path,
        stats_mtime_ms: impl FnOnce() -> Option<u64>,
        torn: Option<&str>,
    ) -> Option<SessionInfo> {
        let snapshot;
        let acc = match torn.filter(|tail| !tail.trim().is_empty()) {
            Some(tail) => {
                let mut snap = self.acc.clone();
                fold_scan_entry(&mut snap, tail)?;
                snapshot = snap;
                &snapshot
            }
            None => &self.acc,
        };
        let usage = acc.usage_scan.summary();
        let header = acc.header.as_ref()?;
        // TS `getSessionModifiedDateFromLastActivity`: the newest
        // user/assistant message timestamp, then the header's own creation
        // timestamp, then the file's mtime — never scan time. The port's
        // `now()` fallback refreshed `modified` to the moment of every
        // re-enumeration for records without message timestamps, so
        // long-old sessions read as minutes old in the agents view. A zero
        // here is a real epoch timestamp (a 1970 header or mtime renders
        // 1970-01-01, like TS `toISOString`); only the message-timestamp
        // arm filters zero, because the append path stamps a missing
        // entry timestamp as 0, not activity. `None` — undatable header,
        // unavailable mtime — renders blank, never a fabricated age.
        let modified_ms = acc
            .last_activity_ms
            .filter(|ms| *ms > 0)
            .or_else(|| crate::util::iso_to_unix_ms(&header.timestamp))
            .or_else(stats_mtime_ms);
        let modified = modified_ms
            .map(crate::util::iso_from_unix_ms)
            .unwrap_or_default();
        Some(SessionInfo {
            path: path.to_path_buf(),
            id: header.id.clone(),
            cwd: header.cwd.clone(),
            name: acc.name.clone(),
            state: acc.state.clone(),
            model: acc.model.clone(),
            thinking_level: acc.thinking_level.clone(),
            parent_session_path: header.parent_session.clone(),
            rlm_depth: header.rlm_depth.unwrap_or(0) as u32,
            created: header.timestamp.clone(),
            modified,
            message_count: acc.message_count,
            first_message: if acc.first_message.is_empty() {
                "(no messages)".to_string()
            } else {
                acc.first_message.clone()
            },
            all_messages_text: acc.all_messages_text.clone(),
            usage,
            // Ledger-derived (`withPassiveRlmDescendantInfos`), never the
            // file scan's: the listing arm attaches it from the spawn
            // ledger's deleted-descendant bucket.
            deleted_descendant_usage: None,
        })
    }
}

/// The text fold of one message's `content`, from the raw span the typed
/// parse borrowed: parsing the span back yields the identical `Value`
/// [`message_text`] read from a fully re-parsed entry, without walking the
/// whole line a second time. `None` content and an unparsable span both
/// read as empty text — exactly what [`message_text`] returns for a
/// message without content.
pub(super) fn message_content_text(content: Option<&serde_json::value::RawValue>) -> String {
    content
        .map(|raw| {
            crate::types::content_to_text(
                &serde_json::from_str::<Value>(raw.get()).unwrap_or_default(),
            )
        })
        .unwrap_or_default()
}

/// Read a borrowed raw span the way the owned-`Value` fold read it:
/// `Some` only when the field is present and a JSON string, with escapes
/// unescaped exactly like the `Value` string the full parse materialized
/// (`Cow::Owned` when the span carries escapes, `Cow::Borrowed` when it
/// does not — the zero-copy case, the only difference from `Value::as_str`
/// being the allocation it skips).
pub(super) fn raw_string(raw: Option<&serde_json::value::RawValue>) -> Option<Cow<'_, str>> {
    serde_json::from_str(raw?.get()).ok()
}

/// `Value::as_u64` over a borrowed raw span: `Some` only when the field is
/// present and a JSON number a `u64` parses.
pub(super) fn raw_u64(raw: Option<&serde_json::value::RawValue>) -> Option<u64> {
    serde_json::from_str(raw?.get()).ok()
}

/// Fold one complete line into the scan state (the old scan-loop body).
/// `None` = the abort arm (a `model_change` without its model identity).
pub(super) fn fold_scan_entry(acc: &mut SessionScanAccumulator, raw: &str) -> Option<()> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(());
    }
    let Ok(entry) = serde_json::from_str::<SessionInfoEntry>(trimmed) else {
        return Some(());
    };
    match entry.type_.as_ref() {
        "session" => {
            let parsed: SessionHeader = serde_json::from_str(trimmed).ok()?;
            acc.header = Some(parsed);
        }
        "session_info" => {
            // The borrowed span reads exactly what `Value::as_str` read:
            // a present non-string parses back to `None`, the same
            // absent-as-`None` the owned `Value` gave (the only reader of
            // `name`, this arm, pays the span's one parse).
            acc.name = raw_string(entry.name)
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(str::to_string);
        }
        "session_state" => {
            if let Some(status) = entry
                .state
                .and_then(|raw| serde_json::from_str::<Value>(raw.get()).ok())
                .as_ref()
                .and_then(|s| s.get("status"))
                .and_then(Value::as_str)
            {
                acc.state = Some(normalize_state_status(status));
            }
        }
        "model_change" => {
            // The abort arm keeps its exact semantics: a `model_change`
            // without a string provider or modelId (absent, or present but
            // not a string) aborts the scan — `raw_string` returns `None`
            // for both, the same two-step `?` the owned values paid for.
            acc.model = Some((
                raw_string(entry.provider)?.into_owned(),
                raw_string(entry.model_id)?.into_owned(),
            ));
        }
        "thinking_level_change" => {
            if let Some(level) = raw_string(entry.thinking_level)
                .as_deref()
                .map(str::trim)
                .filter(|level| !level.is_empty())
            {
                acc.thinking_level = Some(level.to_string());
            }
        }
        "child_usage_attributed" => {
            acc.usage_scan.fold_child_attribution(
                entry.target_id.as_deref(),
                entry.child_usage.map(Usage::from),
                entry.aggregate_usage.map(Usage::from),
            );
        }
        "compaction" | "branch_summary" => {
            acc.usage_scan
                .fold_summarization(entry.usage.map(Usage::from));
        }
        "message" => {
            acc.message_count += 1;
            if let Some(message) = entry.message {
                // The role span parses back on the read the fold always
                // made; a non-string role parses to `None` here exactly as
                // `Value::as_str` returned `None` for it before.
                let role = raw_string(message.role);
                let role = role.as_deref();
                acc.usage_scan
                    .fold_message(&entry.id, role, message.usage.map(Usage::from));
                if role == Some("assistant") {
                    if let (Some(provider), Some(model_id)) =
                        (raw_string(message.provider), raw_string(message.model))
                    {
                        acc.model = Some((provider.to_string(), model_id.to_string()));
                    }
                }
                if matches!(role, Some("user" | "assistant")) {
                    if let Some(timestamp) = raw_u64(message.timestamp) {
                        acc.last_activity_ms =
                            Some(acc.last_activity_ms.unwrap_or(0).max(timestamp));
                    }
                }
                if (role == Some("user") && acc.first_message.is_empty())
                    || (matches!(role, Some("user" | "assistant"))
                        && acc.search_text_chars < SESSION_LIST_SEARCH_TEXT_MAX_CHARS)
                {
                    // The text reads the `content` span the typed parse
                    // borrowed; re-parsing the whole entry (a second full
                    // `Value` walk plus every string it materializes) paid
                    // for one field the fold never otherwise touches.
                    let text = message_content_text(message.content);
                    if role == Some("user") && acc.first_message.is_empty() && !text.is_empty() {
                        acc.first_message.clone_from(&text);
                    }
                    if matches!(role, Some("user" | "assistant")) {
                        acc.search_text_chars = append_capped_search_text(
                            &mut acc.all_messages_text,
                            &text,
                            acc.search_text_chars,
                        );
                    }
                }
            }
        }
        _ => {}
    }
    Some(())
}

/// Most recent valid session for a cwd (port of `findMostRecentSessionForCwd`).
#[must_use]
pub fn find_most_recent_session_for_cwd(session_dir: &Path, cwd: &str) -> Option<PathBuf> {
    list_sessions(session_dir)
        .into_iter()
        .find(|info| {
            !info.cwd.is_empty()
                && Path::new(&info.cwd).canonicalize().map_or_else(
                    |_| info.cwd == cwd,
                    |p| {
                        p == Path::new(cwd)
                            .canonicalize()
                            .unwrap_or_else(|_| PathBuf::from(cwd))
                    },
                )
        })
        .map(|info| info.path)
}
