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
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Condvar, Mutex, PoisonError, Weak};
use std::thread;

use ignore::WalkState;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};

use super::fuzzy_file_search::{
    fd_printed_form, form_name, push_joined_path, rank, to_display_path, walk_builder, AtSearch,
    GIT_DIR,
};
use super::Suggestions;

/// The entry cap. Measured on a 200k-file synthetic tree: the built index costs ~72
/// bytes per entry of resident memory (RSS delta), so a capped index holds ~72 MiB.
pub(super) const MAX_INDEX_ENTRIES: usize = 1_000_000;

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
        entries: BTreeSet<Box<str>>,
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
                            if !prefix.is_empty() && !entries.contains(prefix.as_str()) =>
                        {
                            return Answer::Walk;
                        }
                        IndexScope::Prefix(prefix) => prefix.as_str(),
                        IndexScope::Unscoped => "",
                    };
                    return Answer::Served(rank(candidate_forms(entries, prefix, search), search));
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
        spawn_applier(
            Arc::downgrade(&self.shared),
            events,
            base.to_path_buf(),
            canonical_base,
        );
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

/// The query's matched candidates over the built index — the entries under `prefix`
/// (empty for the whole index), scope-relative where a scope applies — as borrowed
/// forms: the regex check runs on the borrowed form and only the ranked top few ever
/// allocate.
fn candidate_forms<'entries>(
    entries: &'entries BTreeSet<Box<str>>,
    prefix: &'entries str,
    search: &'entries AtSearch<'_>,
) -> Box<dyn Iterator<Item = &'entries str> + 'entries> {
    let forms: Box<dyn Iterator<Item = &Box<str>> + 'entries> = if prefix.is_empty() {
        Box::new(entries.iter())
    } else {
        Box::new(
            // The scope's own directory entry (the range's bound) is never a
            // candidate — the walk skips its own root.
            entries
                .range::<str, _>((Bound::Excluded(prefix), Bound::Unbounded))
                .take_while(move |form| form.starts_with(prefix)),
        )
    };
    let base = search.walk_base.to_string_lossy().into_owned();
    let mut target = String::new();
    Box::new(
        forms
            .take_while(|_| !search.cancel.load(Ordering::Relaxed))
            .map(move |form| &form[prefix.len()..])
            .filter(move |form| {
                let Some(regex) = search.regex else {
                    return true;
                };
                let matched = if search.full_path_mode {
                    push_joined_path(&mut target, &base, form);
                    regex.is_match(&target)
                } else {
                    regex.is_match(form_name(form))
                };
                matched
            }),
    )
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
fn walk_index_entries(base: &Path, cap: usize) -> Option<BTreeSet<Box<str>>> {
    let entries: Mutex<Option<BTreeSet<Box<str>>>> = Mutex::new(Some(BTreeSet::new()));
    walk_builder(base).build_parallel().run(|| {
        Box::new(|entry| {
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            let Some(form) = fd_printed_form(&entry, base) else {
                return WalkState::Continue;
            };
            let mut guard = entries.lock().unwrap_or_else(PoisonError::into_inner);
            let Some(collected) = guard.as_mut() else {
                return WalkState::Quit;
            };
            if collected.len() >= cap {
                *guard = None;
                return WalkState::Quit;
            }
            collected.insert(Box::from(form));
            WalkState::Continue
        })
    });
    entries.into_inner().unwrap_or_else(PoisonError::into_inner)
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
) {
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
                        break;
                    }
                    // The watcher that fed this batch is gone: the state is a
                    // rebuilt or fallback one, and nothing applies to it.
                    _ => break,
                }
            }
        }
    });
}

/// Apply one watcher batch to the index by each path's CURRENT existence — event kinds
/// differ per editor and platform, and existence covers create, remove, rename, and
/// modify uniformly. A watcher error disables the index; a rescan notice or a changed
/// `.gitignore`/`.ignore` file drops it to `Unbuilt` for a lazy rebuild; a batch that
/// grows it past [`MAX_INDEX_ENTRIES`] disables it.
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
        rels.extend(
            event
                .paths
                .iter()
                .filter_map(|path| event_rel(path, base, canonical_base)),
        );
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
    let mut gone: Vec<String> = Vec::new();
    let mut inserted: BTreeMap<String, Vec<(String, bool)>> = BTreeMap::new();
    for rel in &rels {
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
        // The typed-form no-op: the common editor save changes nothing.
        if entries.contains(form.as_str()) {
            continue;
        }
        let parent = parent_form(rel);
        // The parent is neither the base nor an indexed directory: the path sits
        // under an ignored or pruned tree, which the index never holds.
        if !parent.is_empty() && !entries.contains(parent.as_str()) {
            continue;
        }
        // A stale entry of the other type drops before the rule check: a directory
        // replaced by a file takes its descendants with it.
        if is_directory {
            entries.remove(rel.as_str());
        } else {
            remove_subtree(entries, rel);
        }
        inserted
            .entry(parent)
            .or_default()
            .push((rel.clone(), is_directory));
    }
    for rel in &gone {
        remove_subtree(entries, rel);
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
            entries.insert(Box::from(if is_directory {
                format!("{rel}/")
            } else {
                rel.clone()
            }));
            if is_directory {
                let dir = base.join(&rel);
                for form in walk_builder(&dir)
                    .build()
                    .filter_map(Result::ok)
                    .filter_map(|entry| fd_printed_form(&entry, base))
                {
                    entries.insert(Box::from(form));
                    if entries.len() > MAX_INDEX_ENTRIES {
                        // An over-cap batch disables the index, like an over-cap
                        // build does.
                        *state = IndexState::Disabled;
                        return;
                    }
                }
            }
        }
    }
    if entries.len() > MAX_INDEX_ENTRIES {
        *state = IndexState::Disabled;
    }
}

/// The event path relative to the base — `None` outside it. Watcher paths may be
/// canonical (macOS reports `/private/var` for a `/var` tempdir), so both the base and
/// its canonical form are stripped.
fn event_rel(path: &Path, base: &Path, canonical_base: &Path) -> Option<String> {
    let rel = path
        .strip_prefix(base)
        .or_else(|_| path.strip_prefix(canonical_base))
        .ok()?;
    Some(to_display_path(&rel.to_string_lossy()))
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

/// Remove a path's file form, its directory form, and every entry under it.
fn remove_subtree(entries: &mut BTreeSet<Box<str>>, rel: &str) {
    let prefix = format!("{rel}/");
    let stale: Vec<Box<str>> = entries
        .range::<str, _>((Bound::Included(prefix.as_str()), Bound::Unbounded))
        .take_while(|form| form.starts_with(prefix.as_str()))
        .cloned()
        .collect();
    entries.remove(rel);
    entries.remove(prefix.as_str());
    for form in stale {
        entries.remove(&form);
    }
}
