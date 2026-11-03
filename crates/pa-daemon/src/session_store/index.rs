//! The index concern: the entry-chain index maintenance — the push-side `by_id`/`leaf_id`
//! bookkeeping with the branch's role counts, the live and end-of-load child-usage
//! attribution folds, the rewrite-persist deferred fold, and the entry-id mint.

use super::{HashMap, SessionEntry, SessionFile, Value};

pub(crate) fn new_entry_id(used: &HashMap<String, usize>) -> String {
    for _ in 0..100 {
        let id: String = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        if !used.contains_key(&id) {
            return id;
        }
    }
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

/// Fold each `child_usage_attributed` entry's `aggregateUsage` into its target
/// assistant row. TS performs this fold on every session read, so the daemon's
/// usage walks must see the same attributed aggregates the live turn did. The
/// last attribution per target wins; in-memory only.
pub(super) fn fold_child_usage_attributions(entries: &mut [SessionEntry]) {
    let mut assistant_rows: HashMap<&str, usize> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if entry.type_ == "message"
            && entry
                .fields
                .get("message")
                .and_then(|message| message.get("role"))
                .and_then(Value::as_str)
                == Some("assistant")
        {
            assistant_rows.insert(entry.id.as_str(), index);
        }
    }
    let mut folds: Vec<(usize, Value)> = Vec::new();
    for entry in entries.iter() {
        if entry.type_ != "child_usage_attributed" {
            continue;
        }
        let Some(row) = entry
            .fields
            .get("targetId")
            .and_then(Value::as_str)
            .and_then(|id| assistant_rows.get(id))
        else {
            continue;
        };
        // A malformed aggregate (null, a scalar) must not overwrite the
        // row's valid usage with nothing.
        let Some(aggregate) = entry
            .fields
            .get("aggregateUsage")
            .filter(|aggregate| aggregate.is_object())
        else {
            continue;
        };
        folds.push((*row, aggregate.clone()));
    }
    for (row, aggregate) in folds {
        // TS assigns `target.message.usage = cloneUsage(aggregate)` —
        // assignment, not merge: a row without a `usage` field gets the
        // aggregate inserted, a row with one is overwritten.
        if let Some(message) = entries[row].fields.get_mut("message") {
            if let Some(object) = message.as_object_mut() {
                object.insert("usage".to_string(), aggregate);
            }
        }
    }
}

/// An entry's place on its parent chain, fixed when it joins the index: entries are
/// append-only and parent links never change, so links need no invalidation.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ChainLink {
    /// A chain root links to itself.
    parent: usize,
    depth: usize,
    jump: usize,
}

impl ChainLink {
    pub(super) fn parent(self) -> Option<usize> {
        (self.depth > 0).then_some(self.parent)
    }

    pub(super) fn depth(self) -> usize {
        self.depth
    }
}

impl SessionFile {
    pub(super) fn push_index(&mut self, entry: SessionEntry) {
        self.push_index_inner(entry, true);
    }

    /// The load and in-memory build paths fold live attributions as they push;
    /// the rewrite-persist path defers the fold until the rewrite succeeds (a
    /// failed rewrite rolls the index back).
    pub(super) fn push_index_inner(&mut self, entry: SessionEntry, fold_live: bool) {
        // The live-append seam: an attribution entry joining the index folds
        // its aggregate into the target, or the in-memory view keeps stale
        // usage until a reopen; the end-of-load fold re-applies idempotently
        // and catches forward references in foreign files.
        if fold_live && entry.type_ == "child_usage_attributed" {
            self.fold_live_attribution(&entry);
        }
        self.index_entry(entry);
    }

    /// The one place an entry joins the index: its `by_id` slot, its chain link, and the leaf.
    /// The link resolves the parent at push time; a parent not indexed yet starts a new chain
    /// (strict [`Self::branch`] stops at a missing parent too).
    pub(crate) fn index_entry(&mut self, entry: SessionEntry) {
        let position = self.entries.len();
        let link = match entry
            .parent_id
            .as_deref()
            .and_then(|id| self.by_id.get(id).copied())
        {
            Some(parent) => {
                let up = self.chain[parent];
                let jump = self.chain[up.jump];
                // Skew-binary jump pointers (Myers 1983): O(1) to add, O(log N) ancestor lookup.
                let jump = if up.depth - jump.depth == jump.depth - self.chain[jump.jump].depth {
                    jump.jump
                } else {
                    parent
                };
                ChainLink {
                    parent,
                    depth: up.depth + 1,
                    jump,
                }
            }
            None => ChainLink {
                parent: position,
                depth: 0,
                jump: position,
            },
        };
        self.chain.push(link);
        let id = entry.id.clone();
        self.by_id.insert(id.clone(), position);
        self.entries.push(entry);
        self.set_leaf(Some(id));
    }

    /// The one place the leaf moves. An append onto the leaf adds its row to the branch's
    /// role counts; any other move leaves them stale for the next read to recount (a
    /// recount here would walk the branch at every jump of a file load).
    pub(crate) fn set_leaf(&mut self, leaf: Option<String>) {
        if leaf == self.leaf_id {
            return;
        }
        let appended = leaf
            .as_deref()
            .and_then(|id| self.by_id.get(id).copied())
            .filter(|&position| self.entries[position].parent_id == self.leaf_id);
        self.branch_roles = match (appended, self.branch_roles.take()) {
            (Some(position), Some(mut counts)) => {
                if let Some(role) = self.display_role(position) {
                    super::view::count_role(&mut counts, role);
                }
                Some(counts)
            }
            _ => None,
        };
        self.leaf_id = leaf;
    }

    /// Undo the newest [`Self::index_entry`] (a failed rewrite-persist).
    pub(super) fn unindex_last(&mut self) {
        if let Some(entry) = self.entries.pop() {
            self.by_id.remove(&entry.id);
            self.chain.pop();
        }
    }

    pub(crate) fn clear_index(&mut self) {
        self.entries.clear();
        self.by_id.clear();
        self.chain.clear();
        self.set_leaf(None);
        // An empty index: the branch has no rows, so appends count from here.
        self.branch_roles = Some(HashMap::new());
    }

    /// The ancestor of `position` at chain depth `depth` (at most the position's own depth).
    pub(super) fn ancestor_at(&self, mut position: usize, depth: usize) -> usize {
        while self.chain[position].depth > depth {
            #[cfg(test)]
            super::view::CHAIN_STEPS.with(|steps| steps.set(steps.get() + 1));
            let link = self.chain[position];
            position = if self.chain[link.jump].depth >= depth {
                link.jump
            } else {
                link.parent
            };
        }
        position
    }

    /// Fold one already-indexed attribution entry's aggregate (the rewrite-persist path
    /// calls this after the durable write succeeds).
    pub(super) fn fold_attribution_id(&mut self, id: &str) {
        let Some(&row) = self.by_id.get(id) else {
            return;
        };
        if self.entries[row].type_ != "child_usage_attributed" {
            return;
        }
        let entry = self.entries[row].clone();
        self.fold_live_attribution(&entry);
    }

    /// Fold one attribution entry's aggregate into its already-indexed
    /// target assistant row, when the row has joined the index.
    fn fold_live_attribution(&mut self, entry: &SessionEntry) {
        let Some(row) = entry
            .fields
            .get("targetId")
            .and_then(Value::as_str)
            .and_then(|id| self.by_id.get(id).copied())
        else {
            return;
        };
        // A malformed aggregate (null, a scalar) must not overwrite the
        // row's valid usage with nothing.
        let Some(aggregate) = entry
            .fields
            .get("aggregateUsage")
            .filter(|aggregate| aggregate.is_object())
        else {
            return;
        };
        // TS assigns `target.message.usage = cloneUsage(aggregate)`: insert
        // even when the row never carried a `usage` field.
        if let Some(message) = self.entries[row].fields.get_mut("message") {
            if let Some(object) = message.as_object_mut() {
                object.insert("usage".to_string(), aggregate.clone());
            }
        }
    }
}
