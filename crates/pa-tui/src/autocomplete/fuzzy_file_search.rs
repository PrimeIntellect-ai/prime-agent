//! The `@` fuzzy file search: fd's own `ignore`-crate walk — files and directories, links
//! followed, hidden entries included, `.git` pruned, fd's default gitignore rules — run
//! on one background thread, because a no-match walk of a large tree takes seconds; the
//! result lands on the receiver. From the first query on, the session's file index
//! (see [`file_index`]) answers instead; the walk stays as the fallback for scopes the
//! index cannot serve.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;

use ignore::{DirEntry, WalkBuilder, WalkState};
use regex::RegexBuilder;

use super::file_index::{Answer, FileIndex, IndexScope};
use super::{
    build_completion_value, expand_home_path, parse_path_prefix, CompletionItem, SuggestionKind,
    Suggestions,
};

/// The `.git` directory name: pruned from every walk.
pub(super) const GIT_DIR: &str = ".git";

/// fd's `--max-results`: the walk stops once this many entries match.
const MAX_WALK_RESULTS: usize = 100;
/// The menu's row cap.
pub(super) const MAX_SUGGESTIONS: usize = 20;

/// An in-flight `@` file search: the walk thread sends its result over `results` (`None`
/// when there is nothing to suggest). Dropping the handle cancels the walk.
#[derive(Debug)]
pub struct FileSearch {
    pub(crate) results: Receiver<Option<Suggestions>>,
    cancel: Arc<AtomicBool>,
}

impl Drop for FileSearch {
    fn drop(&mut self) {
        self.cancel.store(true, AtomicOrdering::Relaxed);
    }
}

/// Start the background search for the typed `@` token against the
/// session cwd.
pub(super) fn spawn(base: &Path, index: FileIndex, at_prefix: String) -> FileSearch {
    let (tx, results) = mpsc::channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let base = base.to_path_buf();
    let thread_cancel = Arc::clone(&cancel);
    thread::spawn(move || {
        let _ = tx.send(search(&base, &index, &at_prefix, &thread_cancel));
    });
    FileSearch { results, cancel }
}

/// The fd printed form without the directory marker.
pub(super) fn form_trimmed(form: &str) -> &str {
    form.strip_suffix('/').unwrap_or(form)
}

/// The final path segment of a fd printed form.
pub(super) fn form_name(form: &str) -> &str {
    form_trimmed(form).rsplit('/').next().unwrap_or_default()
}

/// The depth below the walk base: the separator count of the trimmed form.
fn form_depth(form: &str) -> usize {
    form_trimmed(form).matches('/').count()
}

/// fd's walk rules — the one configuration every walk in the `@` completion uses:
/// hidden entries included, links followed, `.git` pruned, fd's default ignore set.
pub(super) fn walk_builder(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder.hidden(false);
    builder.follow_links(true);
    builder.filter_entry(|entry| entry.file_name() != GIT_DIR);
    builder
}

/// The fd printed form of one walk entry: relative to `walk_base` (the walk may sit
/// deeper inside it), directories carrying their trailing `/`; the walk root itself
/// and non-file non-dir entries skip.
pub(super) fn fd_printed_form(entry: &DirEntry, walk_base: &Path) -> Option<String> {
    if entry.depth() == 0 {
        return None;
    }
    let file_type = entry.file_type()?;
    if !file_type.is_file() && !file_type.is_dir() {
        return None;
    }
    let relative = entry.path().strip_prefix(walk_base).unwrap_or(entry.path());
    let form = to_display_path(&relative.to_string_lossy());
    Some(if file_type.is_dir() {
        format!("{form}/")
    } else {
        form
    })
}

/// In full-path mode the query matches the walk-base-joined path — the string the
/// live walk matches. The walk joins once per entry; the index pass matches every
/// entry, so it builds into one reused buffer. `base` is the walk base as a string.
pub(super) fn push_joined_path(target: &mut String, base: &str, form: &str) {
    target.clear();
    target.push_str(base);
    if !target.ends_with(std::path::MAIN_SEPARATOR) {
        target.push(std::path::MAIN_SEPARATOR);
    }
    target.push_str(form_trimmed(form));
}

/// One typed `@` token's resolved search: what the ranking needs — the typed query,
/// the typed scope's display base rebuilt into the item paths, and the token's
/// quoting — and how candidates match and cancel.
pub(super) struct AtSearch<'a> {
    pub(super) query: &'a str,
    pub(super) display_base: Option<&'a str>,
    pub(super) at_prefix: &'a str,
    pub(super) is_quoted_prefix: bool,
    pub(super) walk_base: &'a Path,
    pub(super) regex: Option<&'a regex::Regex>,
    pub(super) full_path_mode: bool,
    pub(super) cancel: &'a AtomicBool,
}

/// The `@dir/partial` scope: the walk runs inside `base_dir` for `query`, and
/// `display_base` rebuilds the typed scope in the item paths.
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

/// Walk with fd's semantics: the parallel `ignore` walker, the base itself skipped, the
/// walk cut at [`MAX_WALK_RESULTS`] or on cancel; results come back in fd's printed form.
fn walk_directory(
    walk_base: &Path,
    regex: Option<&regex::Regex>,
    full_path_mode: bool,
    cancel: &AtomicBool,
) -> Vec<String> {
    let found: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let base = walk_base.to_string_lossy().into_owned();
    walk_builder(walk_base).build_parallel().run(|| {
        Box::new(|entry| {
            if cancel.load(AtomicOrdering::Relaxed) {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            let Some(form) = fd_printed_form(&entry, walk_base) else {
                return WalkState::Continue;
            };
            if let Some(regex) = regex {
                let mut target = String::new();
                let matched = if full_path_mode {
                    push_joined_path(&mut target, &base, &form);
                    regex.is_match(&target)
                } else {
                    regex.is_match(form_name(&form))
                };
                if !matched {
                    return WalkState::Continue;
                }
            }
            let mut found = found.lock().unwrap_or_else(PoisonError::into_inner);
            if found.len() == MAX_WALK_RESULTS {
                return WalkState::Quit;
            }
            found.push(form);
            WalkState::Continue
        })
    });
    found.into_inner().unwrap_or_else(PoisonError::into_inner)
}

/// The walk thread body: resolve the typed scope, answer from the file index when it
/// serves the query (walking once to build it on first use), fall back to the live walk
/// otherwise, and rank. `None` means no menu: fd matched nothing, the query was an
/// invalid regex (fd exits non-zero), or every entry scored zero.
fn search(
    base: &Path,
    index: &FileIndex,
    at_prefix: &str,
    cancel: &AtomicBool,
) -> Option<Suggestions> {
    let (raw_query, _is_at_prefix, is_quoted_prefix) = parse_path_prefix(at_prefix);
    let scoped_query = resolve_scoped_query(base, &raw_query);
    let (walk_base, query) = match &scoped_query {
        Some(scoped) => (scoped.base_dir.clone(), scoped.query.clone()),
        None => (base.to_path_buf(), raw_query),
    };
    // The fd pattern is the raw query as a regex (smart case), matched against the file
    // name — or the whole path when the query contains a `/`. An empty query matches everything.
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
    let search = AtSearch {
        query: &query,
        display_base: scoped_query
            .as_ref()
            .map(|scoped| scoped.display_base.as_str()),
        at_prefix,
        is_quoted_prefix,
        walk_base: &walk_base,
        regex: regex.as_ref(),
        full_path_mode,
        cancel,
    };
    let scope = match &scoped_query {
        Some(scoped) => index_scope(&scoped.display_base),
        None => IndexScope::Unscoped,
    };
    match index.query(base, &scope, &search) {
        Answer::Served(answered) => answered,
        Answer::Walk => {
            let found = walk_directory(
                search.walk_base,
                search.regex,
                search.full_path_mode,
                search.cancel,
            );
            rank(found.iter().map(String::as_str), &search)
        }
    }
}

/// The typed scope as an index prefix: relative, no `..` component, a leading `./`
/// normalized away — `Outside` when the scope can never be served by the index.
fn index_scope(display_base: &str) -> IndexScope {
    if display_base.starts_with('/') || display_base.starts_with('~') {
        return IndexScope::Outside;
    }
    let normalized = display_base.strip_prefix("./").unwrap_or(display_base);
    if normalized.split('/').any(|component| component == "..") {
        return IndexScope::Outside;
    }
    IndexScope::Prefix(normalized.to_string())
}

/// A scored candidate form, ordered by score (descending), then depth, then path.
struct RankedForm<'a> {
    score: i32,
    depth: usize,
    form: &'a str,
}

impl RankedForm<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .score
            .cmp(&self.score)
            .then_with(|| self.depth.cmp(&other.depth))
            .then_with(|| form_trimmed(self.form).cmp(form_trimmed(other.form)))
    }
}

/// The one ranking, shared by the walk and the index paths, over the candidates' fd
/// printed forms: score (the query lowercased once), drop the zero scores, and keep
/// the best [`MAX_SUGGESTIONS`] by score, then depth, then path — bounded work, the
/// full matched set never collects — then build the items. `None` means no menu.
pub(super) fn rank<'a>(
    candidates: impl Iterator<Item = &'a str>,
    search: &AtSearch<'_>,
) -> Option<Suggestions> {
    let AtSearch {
        query,
        display_base,
        at_prefix,
        is_quoted_prefix,
        ..
    } = search;
    let lower_query = query.to_lowercase();
    let mut best: Vec<RankedForm<'_>> = Vec::with_capacity(MAX_SUGGESTIONS);
    for form in candidates {
        let score = if query.is_empty() {
            1
        } else {
            score_entry(form, &lower_query, form.ends_with('/'))
        };
        if score <= 0 {
            continue;
        }
        let ranked = RankedForm {
            score,
            depth: form_depth(form),
            form,
        };
        if best.len() < MAX_SUGGESTIONS {
            best.push(ranked);
            if best.len() == MAX_SUGGESTIONS {
                best.sort_unstable_by(RankedForm::cmp);
            }
        } else if let Some(worst) = best.last() {
            if RankedForm::cmp(&ranked, worst) == Ordering::Less {
                best.pop();
                let position =
                    best.partition_point(|kept| RankedForm::cmp(kept, &ranked) == Ordering::Less);
                best.insert(position, ranked);
            }
        }
    }
    if best.is_empty() {
        return None;
    }
    // The fill phase above only sorts at capacity; a short candidate list arrives in
    // its own order.
    best.sort_unstable_by(RankedForm::cmp);
    let items: Vec<CompletionItem> = best
        .into_iter()
        .map(|ranked| {
            let path = form_trimmed(ranked.form);
            let display_path = match display_base {
                Some(display_base) => scoped_path_for_display(display_base, path),
                None => path.to_string(),
            };
            let name = path.rsplit('/').next().unwrap_or_default();
            let is_directory = ranked.form.ends_with('/');
            let completion_path = if is_directory {
                format!("{display_path}/")
            } else {
                display_path.clone()
            };
            CompletionItem {
                value: build_completion_value(&completion_path, true, *is_quoted_prefix),
                label: if is_directory {
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
    Some(Suggestions {
        prefix: (*at_prefix).to_string(),
        kind: Some(SuggestionKind::File),
        items,
    })
}

/// Case-insensitive equality against a needle already lowercased: in place for an
/// ASCII pair (ASCII casing is per-byte), Unicode lowering otherwise.
fn eq_ignore_case(haystack: &str, lower_needle: &str) -> bool {
    if haystack.is_ascii() && lower_needle.is_ascii() {
        haystack.eq_ignore_ascii_case(lower_needle)
    } else {
        haystack.to_lowercase() == lower_needle
    }
}

/// Case-insensitive prefix test against a needle already lowercased: in place for an
/// ASCII pair (ASCII casing is per-byte), Unicode lowering otherwise.
fn starts_with_ignore_case(haystack: &str, lower_needle: &str) -> bool {
    if haystack.is_ascii() && lower_needle.is_ascii() {
        haystack.len() >= lower_needle.len()
            && haystack[..lower_needle.len()].eq_ignore_ascii_case(lower_needle)
    } else {
        haystack.to_lowercase().starts_with(lower_needle)
    }
}

/// Case-insensitive containment against a needle already lowercased: in place for an
/// ASCII pair (byte windows, because ASCII casing is per-byte), Unicode lowering
/// otherwise.
fn contains_ignore_case(haystack: &str, lower_needle: &str) -> bool {
    if haystack.is_ascii() && lower_needle.is_ascii() {
        haystack
            .as_bytes()
            .windows(lower_needle.len())
            .any(|window| window.eq_ignore_ascii_case(lower_needle.as_bytes()))
    } else {
        haystack.to_lowercase().contains(lower_needle)
    }
}

/// Exact name 100, name prefix 80, name contains 50, path contains 30,
/// +10 for directories (when positive), all case-insensitive against the
/// once-lowercased query.
fn score_entry(form: &str, lower_query: &str, is_directory: bool) -> i32 {
    let file_name = form_name(form);
    let mut score = if eq_ignore_case(file_name, lower_query) {
        100
    } else if starts_with_ignore_case(file_name, lower_query) {
        80
    } else if contains_ignore_case(file_name, lower_query) {
        50
    } else if contains_ignore_case(form, lower_query) {
        30
    } else {
        0
    };
    if is_directory && score > 0 {
        score += 10;
    }
    score
}

/// The raw query when it holds no `/`; otherwise the segments
/// regex-escaped and joined with `[\\/]`, a trailing separator included.
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

/// Normalize backslashes to `/` on every platform.
pub(super) fn to_display_path(value: &str) -> String {
    value.replace('\\', "/")
}

/// Rebuild the scoped display path: the typed base plus the
/// walk-relative path.
fn scoped_path_for_display(display_base: &str, relative_path: &str) -> String {
    let normalized = to_display_path(relative_path);
    if display_base == "/" {
        format!("/{normalized}")
    } else {
        format!("{}{normalized}", to_display_path(display_base))
    }
}
