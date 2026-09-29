//! The `@` fuzzy file search (TS `getFuzzyFileSuggestions` +
//! `walkDirectoryWithFd`): fd's own `ignore`-crate walk — `--type f
//! --type d --follow --hidden --exclude .git` with fd's default
//! gitignore rules — run on one background thread, because a no-match
//! walk of a large tree takes seconds. Dropping the [`FileSearch`]
//! handle cancels the walk (TS kills fd on abort); the result lands on
//! the receiver.

use std::cmp::Reverse;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;

use ignore::{WalkBuilder, WalkState};
use regex::RegexBuilder;

use super::{
    build_completion_value, expand_home_path, parse_path_prefix, CompletionItem, SuggestionKind,
    Suggestions,
};

/// fd's `--max-results` (TS `walkDirectoryWithFd`): the walk stops once
/// this many entries match.
const MAX_WALK_RESULTS: usize = 100;
/// The menu's row cap (TS `topEntries.slice(0, 20)`).
const MAX_SUGGESTIONS: usize = 20;

/// An in-flight `@` file search: the walk thread sends its result over
/// `results` (`None` when there is nothing to suggest). Dropping the
/// handle cancels the walk, so a stale search costs nothing.
#[derive(Debug)]
pub struct FileSearch {
    pub(crate) results: Receiver<Option<Suggestions>>,
    cancel: Arc<AtomicBool>,
}

impl Drop for FileSearch {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

/// Start the background search for the typed `@` token against the
/// session cwd.
pub(super) fn spawn(base: &Path, at_prefix: String) -> FileSearch {
    let (tx, results) = mpsc::channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let base = base.to_path_buf();
    let thread_cancel = Arc::clone(&cancel);
    thread::spawn(move || {
        let _ = tx.send(search(&base, &at_prefix, &thread_cancel));
    });
    FileSearch { results, cancel }
}

/// One walk result in fd's printed form: relative to the walk base,
/// directories carrying their trailing `/`.
struct WalkedEntry {
    path: String,
    is_directory: bool,
}

/// The `@dir/partial` scope (TS `resolveScopedFuzzyQuery`): the walk
/// runs inside `base_dir` for `query`, and `display_base` rebuilds the
/// typed scope in the item paths.
struct ScopedQuery {
    base_dir: PathBuf,
    query: String,
    display_base: String,
}

/// Split a scoped query at its last `/`: the typed directory must
/// exist, else the query stays unscoped.
fn resolve_scoped_query(base: &Path, raw_query: &str) -> Option<ScopedQuery> {
    let normalized = to_display_path(raw_query);
    let slash_index = normalized.rfind('/')?;
    let display_base = normalized[..=slash_index].to_string();
    let query = normalized[slash_index + 1..].to_string();
    let base_dir = if display_base.starts_with("~/") {
        PathBuf::from(expand_home_path(&display_base))
    } else if display_base.starts_with('/') {
        PathBuf::from(&display_base)
    } else {
        base.join(&display_base)
    };
    if !base_dir.is_dir() {
        return None;
    }
    Some(ScopedQuery {
        base_dir,
        query,
        display_base,
    })
}

/// Walk with fd's semantics (TS `walkDirectoryWithFd`): the parallel
/// `ignore` walker with hidden entries included, links followed, and
/// `.git` pruned, the base itself skipped, the walk cut at
/// [`MAX_WALK_RESULTS`] or on cancel. Results come back in fd's printed
/// form — relative to the base, directories carrying their trailing `/`.
fn walk_directory(
    walk_base: &Path,
    regex: Option<&regex::Regex>,
    full_path_mode: bool,
    cancel: &AtomicBool,
) -> Vec<WalkedEntry> {
    let found: Mutex<Vec<WalkedEntry>> = Mutex::new(Vec::new());
    WalkBuilder::new(walk_base)
        .hidden(false)
        .follow_links(true)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build_parallel()
        .run(|| {
            Box::new(|entry| {
                if cancel.load(Ordering::Relaxed) {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                // fd never prints the base directory itself, and only
                // files and directories reach the results (broken links
                // and loops arrive as errors and skip).
                if entry.depth() == 0 {
                    return WalkState::Continue;
                }
                let file_type = match entry.file_type() {
                    Some(file_type) if file_type.is_file() || file_type.is_dir() => file_type,
                    _ => return WalkState::Continue,
                };
                let target = if full_path_mode {
                    entry.path().to_string_lossy()
                } else {
                    entry.file_name().to_string_lossy()
                };
                if regex.is_some_and(|regex| !regex.is_match(&target)) {
                    return WalkState::Continue;
                }
                let relative = entry.path().strip_prefix(walk_base).unwrap_or(entry.path());
                let path = to_display_path(&relative.to_string_lossy());
                let is_directory = file_type.is_dir();
                let path = if is_directory {
                    format!("{path}/")
                } else {
                    path
                };
                let mut found = found.lock().unwrap_or_else(PoisonError::into_inner);
                if found.len() == MAX_WALK_RESULTS {
                    return WalkState::Quit;
                }
                found.push(WalkedEntry { path, is_directory });
                WalkState::Continue
            })
        });
    found.into_inner().unwrap_or_else(PoisonError::into_inner)
}

/// The walk thread body (TS `getFuzzyFileSuggestions`): resolve the
/// typed scope, walk with fd's semantics, score, and build the items.
/// `None` means no menu: fd matched nothing, the query was an invalid
/// regex (fd exits non-zero), or every entry scored zero.
fn search(base: &Path, at_prefix: &str, cancel: &AtomicBool) -> Option<Suggestions> {
    let (raw_query, _is_at_prefix, is_quoted_prefix) = parse_path_prefix(at_prefix);
    let scoped_query = resolve_scoped_query(base, &raw_query);
    let (walk_base, query) = match &scoped_query {
        Some(scoped) => (scoped.base_dir.clone(), scoped.query.clone()),
        None => (base.to_path_buf(), raw_query),
    };
    // The fd pattern is the raw query as a regex (smart case), matched
    // against the file name — or the whole path, which fd holds
    // absolute because the base is absolute, when the query contains a
    // `/`. An empty query matches everything.
    let pattern = build_fd_path_query(&query);
    let full_path_mode = to_display_path(&query).contains('/');
    let regex = if pattern.is_empty() {
        None
    } else {
        Some(
            RegexBuilder::new(&pattern)
                .case_insensitive(!pattern.chars().any(char::is_uppercase))
                .build()
                .ok()?,
        )
    };
    let found = walk_directory(&walk_base, regex.as_ref(), full_path_mode, cancel);
    // The stable sort keeps fd's arrival order within a score.
    let mut scored_entries: Vec<(i32, WalkedEntry)> = found
        .into_iter()
        .map(|entry| {
            let score = if query.is_empty() {
                1
            } else {
                score_entry(&entry.path, &query, entry.is_directory)
            };
            (score, entry)
        })
        .filter(|(score, _)| *score > 0)
        .collect();
    scored_entries.sort_by_key(|(score, _)| Reverse(*score));
    scored_entries.truncate(MAX_SUGGESTIONS);
    let items: Vec<CompletionItem> = scored_entries
        .into_iter()
        .map(|(_, entry)| {
            let path = entry.path.strip_suffix('/').unwrap_or(&entry.path);
            let display_path = match &scoped_query {
                Some(scoped) => scoped_path_for_display(&scoped.display_base, path),
                None => path.to_string(),
            };
            let name = path.rsplit('/').next().unwrap_or_default();
            let completion_path = if entry.is_directory {
                format!("{display_path}/")
            } else {
                display_path.clone()
            };
            CompletionItem {
                value: build_completion_value(&completion_path, true, is_quoted_prefix),
                label: if entry.is_directory {
                    format!("{name}/")
                } else {
                    name.to_string()
                },
                description: Some(display_path),
                argument_hint: None,
                source_tag: None,
            }
        })
        .collect();
    if items.is_empty() {
        return None;
    }
    Some(Suggestions {
        prefix: at_prefix.to_string(),
        kind: Some(SuggestionKind::File),
        items,
    })
}

/// TS `scoreEntry`: exact name 100, name prefix 80, name contains 50,
/// path contains 30, +10 for directories (when positive), all
/// case-insensitive against the fd-printed path.
fn score_entry(file_path: &str, query: &str, is_directory: bool) -> i32 {
    let file_name = file_path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default();
    let lower_name = file_name.to_lowercase();
    let lower_query = query.to_lowercase();
    let mut score = if lower_name == lower_query {
        100
    } else if lower_name.starts_with(&lower_query) {
        80
    } else if lower_name.contains(&lower_query) {
        50
    } else if file_path.to_lowercase().contains(&lower_query) {
        30
    } else {
        0
    };
    if is_directory && score > 0 {
        score += 10;
    }
    score
}

/// The fd path query (TS `buildFdPathQuery`): the raw query when it
/// holds no `/`; otherwise the segments regex-escaped and joined with
/// `[\\/]`, a trailing separator included.
fn build_fd_path_query(query: &str) -> String {
    let normalized = to_display_path(query);
    if !normalized.contains('/') {
        return normalized;
    }
    let has_trailing_separator = normalized.ends_with('/');
    let trimmed = normalized.trim_matches('/');
    if trimmed.is_empty() {
        return normalized;
    }
    let separator = "[\\\\/]";
    let mut pattern = trimmed
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(regex::escape)
        .collect::<Vec<_>>()
        .join(separator);
    if has_trailing_separator {
        pattern.push_str(separator);
    }
    pattern
}

/// Normalize backslashes to `/` on every platform (TS `toDisplayPath`).
fn to_display_path(value: &str) -> String {
    value.replace('\\', "/")
}

/// Rebuild the scoped display path (TS `scopedPathForDisplay`): the
/// typed base plus the walk-relative path.
fn scoped_path_for_display(display_base: &str, relative_path: &str) -> String {
    let normalized = to_display_path(relative_path);
    if display_base == "/" {
        format!("/{normalized}")
    } else {
        format!("{}{normalized}", to_display_path(display_base))
    }
}
