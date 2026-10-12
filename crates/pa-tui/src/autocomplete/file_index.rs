//! The session file index: an in-memory mirror of the `@` completion's walk results
//! under the session base — fd printed-form paths, relative to the base, directories
//! keeping their trailing `/` — so every query after the first answers from memory
//! instead of walking the tree.
//!
//! The first `@` query builds it with one full walk (fd's rules, no result cut), a
//! watcher started before that walk buffers the changes it races with, and one applier
//! thread keeps the entries current afterwards: batches applied by each path's current
//! existence (event kinds differ per editor and platform), the shared walker deciding
//! what may enter. Queries the index cannot serve — an absolute or `..` scope, a typed
//! directory the walk rules exclude, a watcher that failed, or a tree over the entry
//! cap — fall back to the per-query walk, which stays.
//!
//! Limitations: changes inside symlinked directories whose targets sit outside the
//! base are not observed (the build-time view stands until a rebuild); `.git/info/exclude`
//! and global gitignore edits are not observed; Linux spends one inotify watch per
//! directory and falls back to the walk when the watch limit rejects the base.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::num::NonZeroUsize;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Condvar, Mutex, PoisonError, Weak};
use std::thread;

use ignore::WalkState;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

use super::fuzzy_file_search::{
    fd_printed_form, suggestions, to_display_path, top_ranked, walk_builder, AtSearch, RankedForm,
    GIT_DIR,
};
use super::Suggestions;

/// The entry cap. Measured on 202k- and 950k-entry synthetic trees: the built index costs
/// ~50-60 bytes per entry of resident memory (RSS delta), so a capped index holds ~60 MiB.
pub(super) const MAX_INDEX_ENTRIES: usize = 1_000_000;

/// The fewest candidates one scan thread takes: a smaller slice scans on the search
/// thread itself. Measured on 8- and 2-core x86 VMs over 5k–202k-entry trees: `4_096` is
/// the smallest value whose split scan is never slower than the inline scan (`2_048` lost
/// up to 46% on 2 cores near 5k entries).
pub(super) const SCAN_CHUNK_MIN: usize = 4_096;

/// How one query addresses the index.
pub(super) enum IndexScope {
    /// No typed scope: every entry is a candidate.
    Unscoped,
    /// The typed scope as an index prefix (relative, no `..`): the candidates are the
    /// entries under it, relative to it. The empty prefix is the base itself.
    Prefix(String),
    /// The typed scope can never be served by the index (absolute, `~`, or `..`).
    Outside,
}

/// The index's answer for one query: the ranked suggestions when it served the
/// query (`None` inside `Served` is an empty menu), or a walk when it did not.
pub(super) enum Answer {
    Served(Option<Suggestions>),
    Walk,
}

/// The session's file index, one per autocomplete provider: lazily built on the first
/// `@` query, then shared by every query thread. Cheap to clone; the last clone drops
/// the index and its watcher.
#[derive(Clone)]
pub(super) struct FileIndex {
    shared: Arc<Shared>,
}

/// The shared index state and its build-finished signal.
struct Shared {
    state: Mutex<IndexState>,
    ready: Condvar,
}

/// The index lifecycle. `Unbuilt` builds on the next query; `Building` makes later
/// queries wait instead of starting their own walks; `Disabled` walks per query for
/// the rest of the provider's life.
enum IndexState {
    Unbuilt,
    Building,
    Ready {
        /// Sorted, no duplicates: a scope's entries are one contiguous slice.
        entries: Vec<Box<str>>,
        _watcher: RecommendedWatcher,
    },
    Disabled,
}

enum Step {
    Build,
    Wait,
    Serve,
    Walk,
}

impl FileIndex {
    pub(super) fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(IndexState::Unbuilt),
                ready: Condvar::new(),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, IndexState> {
        self.shared
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Answer one query from the index: build on first use, wait out a concurrent
    /// build, then rank the matched entries (under the lock — the candidates borrow
    /// the entries). `Answer::Served` is the index's own result (`None` inside it an
    /// empty menu); `Answer::Walk` means the index does not serve the query — it is
    /// disabled, or the scope sits outside it.
    pub(super) fn query(&self, base: &Path, scope: &IndexScope, search: &AtSearch<'_>) -> Answer {
        let mut guard = self.lock();
        loop {
            let step = match &*guard {
                IndexState::Unbuilt => Step::Build,
                IndexState::Building => Step::Wait,
                IndexState::Ready { .. } => Step::Serve,
                IndexState::Disabled => Step::Walk,
            };
            match step {
                Step::Wait => {
                    guard = self
                        .shared
                        .ready
                        .wait(guard)
                        .unwrap_or_else(PoisonError::into_inner);
                }
                Step::Build => {
                    drop(guard);
                    self.build(base, MAX_INDEX_ENTRIES);
                    guard = self.lock();
                }
                Step::Walk => return Answer::Walk,
                Step::Serve => {
                    let IndexState::Ready { entries, .. } = &*guard else {
                        return Answer::Walk;
                    };
                    let prefix = match scope {
                        // The typed directory is not in the index (the walk rules
                        // exclude it): the walk lists its contents instead.
                        IndexScope::Outside => return Answer::Walk,
                        IndexScope::Prefix(prefix)
                            if !prefix.is_empty() && !contains(entries, prefix) =>
                        {
                            return Answer::Walk;
                        }
                        IndexScope::Prefix(prefix) => prefix.as_str(),
                        IndexScope::Unscoped => "",
                    };
                    return Answer::Served(suggestions(scan(entries, prefix, search), search));
                }
            }
        }
    }

    /// Build from `Unbuilt`: one full walk under `base`, at most `cap` entries, with the
    /// watcher started before it so changes during the walk are applied after. `true`
    /// when the state is `Ready` on return; a watcher that fails or a tree over the cap
    /// leaves `Disabled`.
    pub(super) fn build(&self, base: &Path, cap: usize) -> bool {
        {
            let mut guard = self.lock();
            if !matches!(&*guard, IndexState::Unbuilt) {
                return matches!(&*guard, IndexState::Ready { .. });
            }
            *guard = IndexState::Building;
        }
        let Some((watcher, events)) = watch(base) else {
            self.replace(IndexState::Disabled);
            return false;
        };
        let canonical_base = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
        drop(spawn_applier(
            Arc::downgrade(&self.shared),
            events,
            base.to_path_buf(),
            canonical_base,
        ));
        if let Some(entries) = walk_index_entries(base, cap) {
            self.replace(IndexState::Ready {
                entries,
                _watcher: watcher,
            });
            true
        } else {
            self.replace(IndexState::Disabled);
            false
        }
    }

    /// Swap in a new state and wake every waiter.
    fn replace(&self, state: IndexState) {
        let mut guard = self.lock();
        *guard = state;
        self.shared.ready.notify_all();
    }
}

/// The query's top ranks over the built index: the entries under `prefix` (empty for
/// the whole index) matched and scored scope-relative, the slice split across scan
/// threads when it is large enough to pay for them.
fn scan<'entries>(
    entries: &'entries [Box<str>],
    prefix: &str,
    search: &AtSearch<'_>,
) -> Vec<RankedForm<'entries>> {
    // The scope's own directory entry is never a candidate — the walk skips its own root.
    let candidates = &entries[range_under(entries, prefix)];
    let base = search.walk_base.to_string_lossy();
    let scan_chunk = |chunk: &'entries [Box<str>], search: &AtSearch<'_>| {
        let mut target = String::new();
        top_ranked(
            chunk
                .iter()
                .take_while(|_| !search.cancel.load(Ordering::Relaxed))
                .map(|form| &form[prefix.len()..])
                .filter(|form| search.matches(&base, form, &mut target))
                .filter_map(|form| search.score(form)),
        )
    };
    // `available_parallelism` reads cgroup files on Linux: only a slice worth splitting
    // pays for it.
    let chunks = match candidates.len() / SCAN_CHUNK_MIN {
        0 | 1 => 1,
        wanted => wanted.min(thread::available_parallelism().map_or(1, NonZeroUsize::get)),
    };
    if chunks == 1 {
        return scan_chunk(candidates, search);
    }
    let scan_chunk = &scan_chunk;
    thread::scope(|scope| {
        let handles: Vec<_> = candidates
            .chunks(candidates.len().div_ceil(chunks))
            .map(|chunk| {
                scope.spawn(move || {
                    // A shared regex serves its lock-free cache only to the first thread
                    // that used it; other threads take its pool's mutex on every match. A
                    // clone brings its own pool.
                    let regex = search.regex.cloned();
                    scan_chunk(
                        chunk,
                        &AtSearch {
                            regex: regex.as_ref(),
                            ..*search
                        },
                    )
                })
            })
            .collect();
        top_ranked(handles.into_iter().flat_map(|handle| {
            handle
                .join()
                .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
        }))
    })
}

/// The recursive watcher over `base`: its events flow into the returned channel.
fn watch(base: &Path) -> Option<(RecommendedWatcher, Receiver<notify::Result<Event>>)> {
    let (tx, events) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx).ok()?;
    watcher.watch(base, RecursiveMode::Recursive).ok()?;
    Some((watcher, events))
}

/// One full walk under `base` with fd's rules — no result cut, no cancel: a build
/// completes even when the typing that started it moved on. `None` when the tree holds
/// more than `cap` entries.
fn walk_index_entries(base: &Path, cap: usize) -> Option<Vec<Box<str>>> {
    let count = AtomicUsize::new(0);
    let sink = Mutex::new(Vec::new());
    walk_builder(base).build_parallel().run(|| {
        let count = &count;
        let mut collected = ThreadEntries {
            entries: Vec::new(),
            sink: &sink,
        };
        Box::new(move |entry| {
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            let Some(form) = fd_printed_form(&entry, base) else {
                return WalkState::Continue;
            };
            if count.fetch_add(1, Ordering::Relaxed) >= cap {
                return WalkState::Quit;
            }
            collected.entries.push(Box::from(form));
            WalkState::Continue
        })
    });
    if count.into_inner() > cap {
        return None;
    }
    let buffers = sink.into_inner().unwrap_or_else(PoisonError::into_inner);
    let mut entries = Vec::with_capacity(buffers.iter().map(Vec::len).sum());
    for buffer in buffers {
        entries.extend(buffer);
    }
    // Walk paths are unique: sorting alone yields the index order.
    entries.sort_unstable();
    Some(entries)
}

/// One walker thread's build entries: collected without a lock, handed to the shared
/// sink as a whole buffer when the thread's visitor drops at the end of the walk — the
/// buffers merge once, into an exact-capacity index, instead of growing one shared vec.
struct ThreadEntries<'sink> {
    entries: Vec<Box<str>>,
    sink: &'sink Mutex<Vec<Vec<Box<str>>>>,
}

impl Drop for ThreadEntries<'_> {
    fn drop(&mut self) {
        self.sink
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(std::mem::take(&mut self.entries));
    }
}

/// The one watcher-draining thread: each batch — everything queued at a wake-up, the
/// coalescing — applies to the index under the lock, and a batch that arrives during a
/// build waits for the build to finish first. Holding the channel's receiver and only
/// a weak index reference, it exits when the watcher drops with the provider.
fn spawn_applier(
    shared: Weak<Shared>,
    events: Receiver<notify::Result<Event>>,
    base: PathBuf,
    canonical_base: PathBuf,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        while let Ok(first) = events.recv() {
            let Some(shared) = shared.upgrade() else {
                return;
            };
            let mut batch = vec![first];
            while let Ok(event) = events.try_recv() {
                batch.push(event);
            }
            let mut guard = shared.state.lock().unwrap_or_else(PoisonError::into_inner);
            loop {
                match &*guard {
                    IndexState::Building => {
                        guard = shared
                            .ready
                            .wait(guard)
                            .unwrap_or_else(PoisonError::into_inner);
                    }
                    IndexState::Ready { .. } => {
                        apply_batch(&mut guard, &batch, &base, &canonical_base);
                        #[cfg(test)]
                        shared.ready.notify_all();
                        // Invalidation drops this watcher's ownership. Exit while
                        // still holding the lock, before a query can rebuild and
                        // expose its new state to any old queued callbacks.
                        if !matches!(*guard, IndexState::Ready { .. }) {
                            return;
                        }
                        break;
                    }
                    // The watcher that fed this batch is gone: the state is a
                    // rebuilt or fallback one, and nothing applies to it.
                    IndexState::Unbuilt | IndexState::Disabled => return,
                }
            }
        }
    })
}

/// Apply one watcher batch using each path's current existence. A structural event on
/// an indexed directory re-walks its subtree; ordinary file saves keep the typed-form
/// fast path. A watcher error disables the index; rescan notices, a structural event on
/// the base or a `.git` marker, an event on a `.git` file, or changed ignore rules
/// trigger a lazy rebuild. A batch exceeding [`MAX_INDEX_ENTRIES`] disables the index.
fn apply_batch(
    state: &mut IndexState,
    batch: &[notify::Result<Event>],
    base: &Path,
    canonical_base: &Path,
) {
    if batch.iter().any(Result::is_err) {
        *state = IndexState::Disabled;
        return;
    }
    let mut rels: BTreeSet<String> = BTreeSet::new();
    let mut replaced: BTreeSet<String> = BTreeSet::new();
    for event in batch.iter().flatten() {
        if event.need_rescan() {
            *state = IndexState::Unbuilt;
            return;
        }
        // Reads change nothing the index tracks — and the walker's own
        // directory opens (plus any search over the session tree) arrive as
        // an access flood, on Linux one event per opened directory.
        if event.kind.is_access() {
            continue;
        }
        for raw_rel in event
            .paths
            .iter()
            .filter_map(|path| event_rel(path, base, canonical_base))
        {
            let rel = to_display_path(&raw_rel.to_string_lossy());
            // Display keys normalize separators and replace invalid UTF-8. They
            // cannot locate every real filename (or distinguish all collisions).
            // Rebuild through the shared walker instead of mutating a wrong key.
            if Path::new(&rel) != raw_rel {
                *state = IndexState::Unbuilt;
                return;
            }
            // A directory's name event may be the only event for an entire
            // moved subtree. Its current existence cannot prove it is still
            // the indexed directory, especially after coalesced replacements.
            if matches!(
                event.kind,
                notify::EventKind::Create(_)
                    | notify::EventKind::Remove(_)
                    | notify::EventKind::Modify(
                        notify::event::ModifyKind::Name(_)
                            | notify::event::ModifyKind::Any
                            | notify::event::ModifyKind::Other,
                    )
                    | notify::EventKind::Any
                    | notify::EventKind::Other
            ) {
                replaced.insert(rel.clone());
            }
            rels.insert(rel);
        }
    }
    // Creating/removing a repository boundary changes whether gitignore
    // applies. A worktree's .git file may also change its gitdir pointer.
    // Directory metadata alone does not change the boundary, and ordinary
    // Git activity can emit those events. Check before pruning .git contents.
    if rels.iter().any(|rel| {
        rel.rsplit('/').next() == Some(GIT_DIR)
            && (replaced.contains(rel) || base.join(rel).is_file())
    }) {
        *state = IndexState::Unbuilt;
        return;
    }
    let rels: Vec<String> = rels
        .iter()
        .filter(|rel| !rel.split('/').any(|component| component == GIT_DIR))
        .cloned()
        .collect();
    if rels.iter().any(|rel| is_ignore_rules_name(rel)) {
        *state = IndexState::Unbuilt;
        return;
    }
    let IndexState::Ready { entries, .. } = state else {
        return;
    };
    // Every decision reads the batch's starting entries; the edits apply once per
    // batch, because each single edit of the sorted entries shifts their tail.
    let mut removals: Vec<Range<usize>> = Vec::new();
    let mut gone: Vec<String> = Vec::new();
    let mut rewalked: BTreeSet<&str> = BTreeSet::new();
    let mut inserted: BTreeMap<String, Vec<(String, bool)>> = BTreeMap::new();
    for rel in &rels {
        // An ancestor's scheduled walk already observes every child change;
        // do not walk or count them again. Check each component boundary: a
        // sibling such as dir-other can sort between dir and dir/nested.
        if rel
            .match_indices('/')
            .any(|(index, _)| rewalked.contains(&rel[..index]))
        {
            continue;
        }
        let metadata = std::fs::metadata(base.join(rel));
        let Ok(metadata) = metadata else {
            gone.push(rel.clone());
            continue;
        };
        let is_directory = metadata.is_dir();
        let form = if is_directory {
            format!("{rel}/")
        } else {
            rel.clone()
        };
        // Replacing an indexed directory may change every descendant without
        // child events. Only structural events re-walk its subtree (the base is the
        // whole tree: it rebuilds lazily); ordinary editor saves and directory
        // metadata changes remain no-ops.
        if is_directory && replaced.contains(rel) {
            if rel.is_empty() {
                *state = IndexState::Unbuilt;
                return;
            }
            if contains(entries, &form) {
                removals.push(range_under(entries, &form));
                rewalked.insert(rel);
                continue;
            }
        }
        // The typed-form no-op: the common editor save changes nothing.
        if contains(entries, &form) {
            continue;
        }
        let parent = parent_form(rel);
        // The parent is neither the base nor an indexed directory: the path sits
        // under an ignored or pruned tree, which the index never holds.
        if !parent.is_empty() && !contains(entries, &parent) {
            continue;
        }
        // A stale entry of the other type drops before the rule check: a directory
        // replaced by a file takes its descendants with it.
        if is_directory {
            removals.extend(find(entries, rel).map(|index| index..index + 1));
        } else {
            remove_subtree(entries, rel, &mut removals);
        }
        inserted
            .entry(parent)
            .or_default()
            .push((rel.clone(), is_directory));
    }
    for rel in &gone {
        if rel.is_empty() {
            // The base itself is gone: rebuild on the next query (into an empty
            // or failing walk) instead of serving the dead tree.
            *state = IndexState::Unbuilt;
            return;
        }
        remove_subtree(entries, rel, &mut removals);
    }
    remove_ranges(entries, removals);
    let mut additions: Vec<Box<str>> = Vec::new();
    for rel in rewalked {
        if !walk_subtree(base, rel, entries.len(), &mut additions) {
            *state = IndexState::Disabled;
            return;
        }
    }
    for (parent, paths) in inserted {
        // One depth-1 walk per parent per batch: the shared rules decide what may enter.
        let parent_dir = base.join(&parent);
        let listed: Vec<String> = walk_builder(&parent_dir)
            .max_depth(Some(1))
            .build()
            .filter_map(Result::ok)
            .filter_map(|entry| fd_printed_form(&entry, &parent_dir))
            .collect();
        let listed: HashSet<&str> = listed.iter().map(String::as_str).collect();
        for (rel, is_directory) in paths {
            let name = rel
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or_default();
            let name_form = if is_directory {
                format!("{name}/")
            } else {
                name.to_string()
            };
            if !listed.contains(name_form.as_str()) {
                continue;
            }
            additions.push(Box::from(if is_directory {
                format!("{rel}/")
            } else {
                rel.clone()
            }));
            if is_directory && !walk_subtree(base, &rel, entries.len(), &mut additions) {
                *state = IndexState::Disabled;
                return;
            }
        }
    }
    if !additions.is_empty() {
        entries.extend(additions);
        // The stable sort takes the sorted entries as one run, so the merge stays linear.
        entries.sort();
        entries.dedup();
    }
    if entries.len() > MAX_INDEX_ENTRIES {
        *state = IndexState::Disabled;
    }
}

/// Walk the directory `rel`'s subtree with the shared rules into `additions` — `false`
/// once the index (`indexed` entries plus the additions) passes [`MAX_INDEX_ENTRIES`]:
/// an over-cap batch disables the index, like an over-cap build does.
fn walk_subtree(base: &Path, rel: &str, indexed: usize, additions: &mut Vec<Box<str>>) -> bool {
    for form in walk_builder(&base.join(rel))
        .build()
        .filter_map(Result::ok)
        .filter_map(|entry| fd_printed_form(&entry, base))
    {
        additions.push(Box::from(form));
        if indexed + additions.len() > MAX_INDEX_ENTRIES {
            return false;
        }
    }
    true
}

/// The event path relative to the base — `None` outside it. Watcher paths may be
/// canonical (macOS reports `/private/var` for a `/var` tempdir), so both the base and
/// its canonical form are stripped.
fn event_rel<'a>(path: &'a Path, base: &Path, canonical_base: &Path) -> Option<&'a Path> {
    path.strip_prefix(base)
        .or_else(|_| path.strip_prefix(canonical_base))
        .ok()
}

/// The parent directory's index form: `""` for the base, else `a/b/`.
fn parent_form(rel: &str) -> String {
    match rel.rfind('/') {
        Some(index) => rel[..=index].to_string(),
        None => String::new(),
    }
}

/// An ignore-rules file: editing one rewrites what the walk lists.
fn is_ignore_rules_name(rel: &str) -> bool {
    matches!(
        rel.trim_end_matches('/').rsplit('/').next(),
        Some(".gitignore" | ".ignore")
    )
}

/// Whether the sorted entries hold `form`.
fn contains(entries: &[Box<str>], form: &str) -> bool {
    find(entries, form).is_some()
}

/// The position of `form` in the sorted entries.
fn find(entries: &[Box<str>], form: &str) -> Option<usize> {
    entries.binary_search_by(|entry| (**entry).cmp(form)).ok()
}

/// The sorted entries' range of forms under `prefix`, `prefix`'s own entry excluded;
/// the empty prefix spans every entry.
fn range_under(entries: &[Box<str>], prefix: &str) -> Range<usize> {
    let start = entries.partition_point(|entry| **entry <= *prefix);
    start..start + entries[start..].partition_point(|entry| entry.starts_with(prefix))
}

/// Mark a path's file form, its directory form, and every entry under it for removal.
fn remove_subtree(entries: &[Box<str>], rel: &str, removals: &mut Vec<Range<usize>>) {
    let prefix = format!("{rel}/");
    removals.extend(find(entries, rel).map(|index| index..index + 1));
    removals.extend(find(entries, &prefix).map(|index| index..index + 1));
    removals.push(range_under(entries, &prefix));
}

/// Drop the marked ranges of the entries in one pass.
fn remove_ranges(entries: &mut Vec<Box<str>>, mut removals: Vec<Range<usize>>) {
    removals.retain(|range| !range.is_empty());
    if removals.is_empty() {
        return;
    }
    removals.sort_unstable_by_key(|range| range.start);
    let mut removals = removals.into_iter().peekable();
    let mut index = 0;
    entries.retain(|_| {
        while removals.next_if(|range| range.end <= index).is_some() {}
        let removed = removals.peek().is_some_and(|range| range.start <= index);
        index += 1;
        !removed
    });
}

#[cfg(test)]
mod freshness_tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};

    fn snapshot(base: &Path) -> IndexState {
        IndexState::Ready {
            entries: walk_index_entries(base, MAX_INDEX_ENTRIES).expect("walk"),
            _watcher: notify::recommended_watcher(|_: notify::Result<Event>| {}).expect("watcher"),
        }
    }

    fn assert_matches_live_walk(state: &IndexState, base: &Path) {
        let expected = walk_index_entries(base, MAX_INDEX_ENTRIES).expect("live walk");
        let actual = match state {
            IndexState::Ready { entries, .. } => entries.clone(),
            IndexState::Unbuilt => walk_index_entries(base, MAX_INDEX_ENTRIES).expect("rebuild"),
            _ => panic!("unexpected state"),
        };
        assert_eq!(actual, expected);
    }

    #[test]
    fn invalidated_watcher_cannot_disable_a_rebuilt_index() {
        let outer = tempfile::tempdir().expect("tempdir");
        let base = outer.path();
        std::fs::write(base.join("visible.rs"), "visible").expect("write");
        let shared = Arc::new(Shared {
            state: Mutex::new(snapshot(base)),
            ready: Condvar::new(),
        });
        let (sender, events) = mpsc::channel();
        let worker = spawn_applier(
            Arc::downgrade(&shared),
            events,
            base.to_path_buf(),
            base.to_path_buf(),
        );
        sender
            .send(Ok(Event::new(notify::EventKind::Create(CreateKind::File))
                .add_path(base.join(".ignore"))))
            .expect("invalidate");
        let guard = shared.state.lock().expect("lock");
        let (mut guard, timeout) = shared
            .ready
            .wait_timeout_while(guard, std::time::Duration::from_secs(30), |state| {
                matches!(state, IndexState::Ready { .. })
            })
            .expect("wait for invalidation");
        assert!(!timeout.timed_out(), "watcher never invalidated its index");
        assert!(matches!(*guard, IndexState::Unbuilt));
        // Complete a new generation while holding the same state lock. An old
        // callback may still have queued an error when its watcher was dropped.
        *guard = snapshot(base);
        let _ = sender.send(Err(notify::Error::generic("old watcher error")));
        drop(sender);
        drop(guard);
        worker.join().expect("applier exits");
        let guard = shared.state.lock().expect("lock");
        assert!(matches!(*guard, IndexState::Ready { .. }));
        assert_matches_live_walk(&guard, base);
    }

    #[test]
    fn unknown_directory_modify_refreshes_descendants() {
        for kind in [ModifyKind::Any, ModifyKind::Other] {
            let outer = tempfile::tempdir().expect("tempdir");
            let base = outer.path();
            std::fs::create_dir(base.join("dir")).expect("mkdir");
            std::fs::write(base.join("dir/old.rs"), "old").expect("write");
            let mut state = snapshot(base);
            std::fs::remove_dir_all(base.join("dir")).expect("remove");
            std::fs::create_dir(base.join("dir")).expect("mkdir");
            std::fs::write(base.join("dir/new.rs"), "new").expect("write");
            let event = Event::new(notify::EventKind::Modify(kind)).add_path(base.join("dir"));
            apply_batch(&mut state, &[Ok(event)], base, base);
            assert_matches_live_walk(&state, base);
        }
    }

    #[cfg(unix)]
    #[test]
    fn saving_backslash_filename_preserves_live_walk_results() {
        let outer = tempfile::tempdir().expect("tempdir");
        let base = outer.path();
        let path = base.join(r"a\b.rs");
        std::fs::write(&path, "before").expect("write");
        let mut state = snapshot(base);
        std::fs::write(&path, "after").expect("save");
        let event = Event::new(notify::EventKind::Modify(ModifyKind::Data(
            notify::event::DataChange::Content,
        )))
        .add_path(path);
        apply_batch(&mut state, &[Ok(event)], base, base);
        assert_matches_live_walk(&state, base);
    }

    // macOS APFS rejects invalid UTF-8 names before the watcher can see them.
    #[cfg(target_os = "linux")]
    #[test]
    fn saving_non_utf8_filename_preserves_live_walk_results() {
        use std::os::unix::ffi::OsStringExt;

        let outer = tempfile::tempdir().expect("tempdir");
        let base = outer.path();
        let path = base.join(std::ffi::OsString::from_vec(b"invalid-\xff.rs".to_vec()));
        std::fs::write(&path, "before").expect("write");
        let mut state = snapshot(base);
        std::fs::write(&path, "after").expect("save");
        let event = Event::new(notify::EventKind::Modify(ModifyKind::Data(
            notify::event::DataChange::Content,
        )))
        .add_path(path);
        apply_batch(&mut state, &[Ok(event)], base, base);
        assert_matches_live_walk(&state, base);
    }

    #[test]
    fn overlapping_directory_refreshes_count_each_descendant_once() {
        let outer = tempfile::tempdir().expect("tempdir");
        let base = outer.path();
        std::fs::create_dir_all(base.join("dir/nested")).expect("mkdir");
        std::fs::create_dir(base.join("dir-other")).expect("mkdir sibling");
        std::fs::write(base.join("dir/nested/file.rs"), "file").expect("write");
        std::fs::write(base.join("dir-other/sibling.rs"), "sibling").expect("write");
        let mut state = snapshot(base);
        // Fill the unaffected portion in memory: exercising the cap must not
        // require creating a million files on the test runner.
        let IndexState::Ready { entries, .. } = &mut state else {
            panic!("ready snapshot");
        };
        for index in entries.len()..MAX_INDEX_ENTRIES {
            entries.push(format!("unaffected-{index:07}.rs").into_boxed_str());
        }
        entries.sort();
        let expected = entries.clone();
        let events = [
            Ok(Event::new(notify::EventKind::Create(CreateKind::Folder))
                .add_path(base.join("dir"))),
            Ok(Event::new(notify::EventKind::Create(CreateKind::Folder))
                .add_path(base.join("dir-other"))),
            Ok(Event::new(notify::EventKind::Create(CreateKind::Folder))
                .add_path(base.join("dir/nested"))),
        ];
        apply_batch(&mut state, &events, base, base);
        let IndexState::Ready { entries, .. } = state else {
            panic!("overlapping refreshes must not disable an index within the cap");
        };
        assert_eq!(entries, expected);
    }

    #[test]
    fn directory_renamed_onto_indexed_empty_destination_refreshes_descendants() {
        let outer = tempfile::tempdir().expect("tempdir");
        let base = outer.path().join("base");
        std::fs::create_dir_all(base.join("dest")).expect("mkdir");
        let mut state = snapshot(&base);
        let source = outer.path().join("source");
        std::fs::create_dir(&source).expect("mkdir");
        std::fs::write(source.join("new.rs"), "new").expect("write");
        std::fs::remove_dir(base.join("dest")).expect("remove empty destination");
        std::fs::rename(&source, base.join("dest")).expect("rename");
        let event = Event::new(notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)))
            .add_path(base.join("dest"));
        apply_batch(&mut state, &[Ok(event)], &base, &base);
        assert_matches_live_walk(&state, &base);
    }

    #[test]
    fn coalesced_directory_replacement_removes_old_descendants() {
        let outer = tempfile::tempdir().expect("tempdir");
        let base = outer.path().join("base");
        std::fs::create_dir_all(base.join("dest")).expect("mkdir");
        std::fs::write(base.join("dest/old.rs"), "old").expect("write");
        let mut state = snapshot(&base);
        std::fs::rename(base.join("dest"), outer.path().join("old")).expect("rename out");
        std::fs::create_dir(base.join("dest")).expect("mkdir");
        std::fs::write(base.join("dest/new.rs"), "new").expect("write");
        let events = [
            Ok(Event::new(notify::EventKind::Remove(RemoveKind::Folder))
                .add_path(base.join("dest"))),
            Ok(Event::new(notify::EventKind::Create(CreateKind::Folder))
                .add_path(base.join("dest"))),
        ];
        apply_batch(&mut state, &events, &base, &base);
        assert_matches_live_walk(&state, &base);
    }

    #[test]
    fn coalesced_base_replacement_drops_the_old_tree() {
        let outer = tempfile::tempdir().expect("tempdir");
        let base = outer.path().join("base");
        std::fs::create_dir(&base).expect("mkdir");
        std::fs::write(base.join("old.rs"), "old").expect("write");
        let mut state = snapshot(&base);
        std::fs::rename(&base, outer.path().join("old")).expect("rename out");
        std::fs::create_dir(&base).expect("mkdir");
        std::fs::write(base.join("new.rs"), "new").expect("write");
        let event =
            Event::new(notify::EventKind::Remove(RemoveKind::Folder)).add_path(base.clone());
        apply_batch(&mut state, &[Ok(event)], &base, &base);
        assert_matches_live_walk(&state, &base);
    }

    #[test]
    fn git_directory_metadata_keeps_the_ready_index() {
        let outer = tempfile::tempdir().expect("tempdir");
        let base = outer.path();
        std::fs::create_dir(base.join(".git")).expect("git init");
        std::fs::write(base.join("visible.rs"), "visible").expect("write");
        let mut state = snapshot(base);
        let event = Event::new(notify::EventKind::Modify(ModifyKind::Metadata(
            notify::event::MetadataKind::WriteTime,
        )))
        .add_path(base.join(".git"));
        apply_batch(&mut state, &[Ok(event)], base, base);
        assert!(
            matches!(state, IndexState::Ready { .. }),
            "ordinary Git directory metadata must not rebuild the index"
        );
        assert_matches_live_walk(&state, base);
    }

    #[test]
    fn git_marker_creation_and_removal_refresh_ignore_rules() {
        let outer = tempfile::tempdir().expect("tempdir");
        let base = outer.path();
        std::fs::write(base.join(".gitignore"), "generated/\n").expect("write");
        std::fs::create_dir(base.join("generated")).expect("mkdir");
        std::fs::write(base.join("generated/output.rs"), "generated").expect("write");
        let mut state = snapshot(base);
        std::fs::create_dir(base.join(".git")).expect("git init");
        let event =
            Event::new(notify::EventKind::Create(CreateKind::Folder)).add_path(base.join(".git"));
        apply_batch(&mut state, &[Ok(event)], base, base);
        assert_matches_live_walk(&state, base);
        let mut state = snapshot(base);
        std::fs::remove_dir(base.join(".git")).expect("remove git marker");
        let event =
            Event::new(notify::EventKind::Remove(RemoveKind::Folder)).add_path(base.join(".git"));
        apply_batch(&mut state, &[Ok(event)], base, base);
        assert_matches_live_walk(&state, base);
    }
}
