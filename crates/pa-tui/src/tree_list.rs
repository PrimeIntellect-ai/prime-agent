//! The `/tree` list state: flatten, filter, fold, search, and navigation.
//! Port of the TS `TreeList` component's model (interactive-mode's
//! tree-selector.ts).

use std::collections::{HashMap, HashSet};

use crate::keybindings::KeybindingsManager;
use crate::tree_display::{self, ToolCallInfo};
use crate::tree_nodes::{TreeNode, TreeNodeData};
use pa_types::session::FileEntry;

mod render;

#[cfg(test)]
use crate::width::str_width;
use render::{toggle, Direction, FlattenItem};

/// Tree filter modes (TS `FilterMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterMode {
    Default,
    NoTools,
    UserOnly,
    LabeledOnly,
    All,
}

impl FilterMode {
    #[must_use]
    pub fn cycle_forward(self) -> Self {
        match self {
            Self::Default => Self::NoTools,
            Self::NoTools => Self::UserOnly,
            Self::UserOnly => Self::LabeledOnly,
            Self::LabeledOnly => Self::All,
            Self::All => Self::Default,
        }
    }

    #[must_use]
    pub fn cycle_backward(self) -> Self {
        match self {
            Self::Default => Self::All,
            Self::All => Self::LabeledOnly,
            Self::LabeledOnly => Self::UserOnly,
            Self::UserOnly => Self::NoTools,
            Self::NoTools => Self::Default,
        }
    }

    /// The settings' wire name (`treeFilterMode`).
    #[must_use]
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::NoTools => "no-tools",
            Self::UserOnly => "user-only",
            Self::LabeledOnly => "labeled-only",
            Self::All => "all",
        }
    }

    /// The status-line suffix (TS `getStatusLabels`).
    fn status_label(self) -> &'static str {
        match self {
            Self::Default => "",
            Self::NoTools => " [no-tools]",
            Self::UserOnly => " [user]",
            Self::LabeledOnly => " [labeled]",
            Self::All => " [all]",
        }
    }
}

/// Parse the settings' `treeFilterMode` wire value.
#[must_use]
pub fn filter_mode_from_str(value: &str) -> FilterMode {
    match value {
        "no-tools" => FilterMode::NoTools,
        "user-only" => FilterMode::UserOnly,
        "labeled-only" => FilterMode::LabeledOnly,
        "all" => FilterMode::All,
        _ => FilterMode::Default,
    }
}

/// Gutter info: the display-indent level where a connector was shown and
/// whether the vertical bar continues (`│` vs spaces).
#[derive(Debug, Clone, PartialEq, Eq)]
struct GutterInfo {
    position: usize,
    show: bool,
}

/// One flattened node with its visual placement.
#[derive(Debug, Clone)]
struct FlatNode {
    data: TreeNodeData,
    indent: usize,
    show_connector: bool,
    is_last: bool,
    gutters: Vec<GutterInfo>,
    is_virtual_root_child: bool,
}

/// What a key press did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TreeListAction {
    /// Enter on a row: navigate to the entry id.
    Select(String),
    /// Escape with no active search: close the tree.
    Cancel,
    /// `app.tree.editLabel` on a row.
    EditLabel(String),
    /// Nothing emitted.
    None,
}

/// The flattened, filtered, foldable tree list.
pub struct TreeList {
    flat: Vec<FlatNode>,
    filtered: Vec<usize>,
    selected: usize,
    current_leaf_id: Option<String>,
    max_visible_lines: usize,
    filter_mode: FilterMode,
    search_query: String,
    tool_calls: HashMap<String, ToolCallInfo>,
    multiple_roots: bool,
    show_label_timestamps: bool,
    active_path: HashSet<String>,
    visible_parent: HashMap<String, Option<String>>,
    visible_children: HashMap<Option<String>, Vec<String>>,
    last_selected_id: Option<String>,
    folded: HashSet<String>,
}

impl TreeList {
    /// Build the list over one session tree; `current_leaf_id` marks the
    /// active branch, `initial_selected` the preselected entry.
    pub fn new(
        tree: &[TreeNode],
        current_leaf_id: Option<String>,
        max_visible_lines: usize,
        initial_selected_id: Option<&str>,
        initial_filter_mode: FilterMode,
    ) -> Self {
        let flat = Self::flatten_tree(tree, current_leaf_id.as_deref());
        let mut list = TreeList {
            flat,
            filtered: Vec::new(),
            selected: 0,
            current_leaf_id,
            max_visible_lines: max_visible_lines.max(5),
            filter_mode: initial_filter_mode,
            search_query: String::new(),
            tool_calls: HashMap::new(),
            multiple_roots: tree.len() > 1,
            show_label_timestamps: false,
            active_path: HashSet::new(),
            visible_parent: HashMap::new(),
            visible_children: HashMap::new(),
            last_selected_id: None,
            folded: HashSet::new(),
        };
        list.build_active_path();
        list.collect_calls();
        list.apply_filter();
        let target = initial_selected_id
            .map(str::to_string)
            .or_else(|| list.current_leaf_id.clone());
        list.selected = list.find_nearest_visible_index(target.as_deref());
        list.last_selected_id = list
            .filtered
            .get(list.selected)
            .and_then(|index| list.flat[*index].data.entry.id().map(str::to_string));
        list
    }

    fn collect_calls(&mut self) {
        let entries: Vec<TreeNodeData> = self.flat.iter().map(|node| node.data.clone()).collect();
        self.tool_calls = tree_display::collect_tool_calls(&entries);
    }

    /// The ids on the root-to-current-leaf path (the `•` markers).
    fn build_active_path(&mut self) {
        self.active_path.clear();
        let Some(leaf) = self.current_leaf_id.clone() else {
            return;
        };
        // An id-indexed walk (TS `entryMap`): a linear session nests one
        // level per entry, and a scan per hop turns the walk quadratic.
        // The visited set terminates a corrupted parent cycle instead of
        // spinning.
        let index_by_id: HashMap<&str, usize> = self
            .flat
            .iter()
            .enumerate()
            .filter_map(|(index, node)| node.data.entry.id().map(|id| (id, index)))
            .collect();
        let mut visited: HashSet<usize> = HashSet::new();
        let mut current = Some(leaf);
        while let Some(id) = current {
            let Some(&index) = index_by_id.get(id.as_str()) else {
                break;
            };
            if !visited.insert(index) {
                break;
            }
            self.active_path.insert(id);
            current = self.flat[index].data.entry.parent_id().map(str::to_string);
        }
    }

    /// Flatten the tree (TS `flattenTree`): roots and children carrying the
    /// active leaf come first, single-child chains stay flat, branch points
    /// indent one level, and branch points record gutters for descendants.
    fn flatten_tree(roots: &[TreeNode], leaf_id: Option<&str>) -> Vec<FlatNode> {
        // Which subtrees contain the active leaf (post-order, iterative).
        let mut contains_active: HashMap<*const TreeNode, bool> = HashMap::new();
        {
            let mut all: Vec<&TreeNode> = Vec::new();
            let mut stack: Vec<&TreeNode> = roots.iter().collect();
            while let Some(node) = stack.pop() {
                all.push(node);
                stack.extend(node.children.iter());
            }
            for node in all.iter().rev() {
                let mut has = leaf_id.is_some_and(|leaf| node.id() == Some(leaf));
                for child in &node.children {
                    if contains_active.get(&std::ptr::from_ref(child)) == Some(&true) {
                        has = true;
                    }
                }
                contains_active.insert(std::ptr::from_ref(*node), has);
            }
        }
        let multiple_roots = roots.len() > 1;
        let has = |node: &TreeNode| contains_active.get(&std::ptr::from_ref(node)) == Some(&true);

        let mut result: Vec<FlatNode> = Vec::new();
        // Stack of (node, indent, just_branched, show_connector, is_last,
        // gutters, is_virtual_root_child) pushed in reverse so pops come in
        // forward order.
        let mut ordered_roots: Vec<&TreeNode> = roots.iter().collect();
        // Active-leaf root first (stable within the groups).
        ordered_roots.sort_by_key(|node| !has(node));
        let mut stack: Vec<FlattenItem> = Vec::new();
        for (index, root) in ordered_roots.iter().enumerate().rev() {
            let is_last = index == ordered_roots.len() - 1;
            stack.push((
                root,
                usize::from(multiple_roots),
                multiple_roots,
                multiple_roots,
                is_last,
                Vec::new(),
                multiple_roots,
            ));
        }
        while let Some((
            node,
            indent,
            just_branched,
            show_connector,
            is_last,
            gutters,
            is_virtual_root_child,
        )) = stack.pop()
        {
            result.push(FlatNode {
                data: node.data.clone(),
                indent,
                show_connector,
                is_last,
                gutters: gutters.clone(),
                is_virtual_root_child,
            });
            let children = &node.children;
            let multiple_children = children.len() > 1;
            let (prioritized, rest): (Vec<&TreeNode>, Vec<&TreeNode>) =
                children.iter().partition(|child| has(child));
            let mut ordered_children = prioritized;
            ordered_children.extend(rest);
            let child_indent = if multiple_children || (just_branched && indent > 0) {
                indent + 1
            } else {
                indent
            };
            // Gutter position: the connector's display level.
            let current_display_indent = if multiple_roots {
                indent.saturating_sub(1)
            } else {
                indent
            };
            let connector_position = current_display_indent.saturating_sub(1);
            let connector_displayed = show_connector && !is_virtual_root_child;
            let child_gutters = if connector_displayed {
                let mut gutters = gutters.clone();
                gutters.push(GutterInfo {
                    position: connector_position,
                    show: !is_last,
                });
                gutters
            } else {
                gutters.clone()
            };
            for (index, child) in ordered_children.iter().enumerate().rev() {
                let child_is_last = index == ordered_children.len() - 1;
                stack.push((
                    child,
                    child_indent,
                    multiple_children,
                    multiple_children,
                    child_is_last,
                    child_gutters.clone(),
                    false,
                ));
            }
        }
        result
    }

    /// Whether an entry passes the active filter (TS `applyFilter`).
    fn passes_filter(&self, index: usize) -> bool {
        let node = &self.flat[index];
        let entry = &node.data.entry;
        let is_current_leaf = self.current_leaf_id.as_deref() == entry.id();
        // Assistant messages with only tool calls are hidden unless the
        // active leaf or an error/abort.
        if let FileEntry::Message {
            message: pa_types::session::AgentMessage::Assistant(assistant),
            ..
        } = entry
        {
            // Assistant messages with only tool calls are hidden unless the
            // current leaf or an error/abort (TS `applyFilter`).
            if !is_current_leaf {
                let has_text = tree_display::assistant_has_text(assistant);
                let is_error_or_aborted = !matches!(
                    assistant.stop_reason,
                    pa_types::ai::StopReason::Stop | pa_types::ai::StopReason::ToolUse
                );
                if !has_text && !is_error_or_aborted {
                    return false;
                }
            }
        }
        let is_settings_entry = matches!(
            entry,
            FileEntry::Label { .. }
                | FileEntry::Custom { .. }
                | FileEntry::ModelChange { .. }
                | FileEntry::ThinkingLevelChange { .. }
                | FileEntry::ServiceTierChange { .. }
                | FileEntry::SessionInfo { .. }
                | FileEntry::ChildUsageAttributed { .. }
        );
        let passes = match self.filter_mode {
            FilterMode::UserOnly => {
                matches!(
                    entry,
                    FileEntry::Message {
                        message: pa_types::session::AgentMessage::User(_),
                        ..
                    }
                )
            }
            FilterMode::NoTools => {
                !is_settings_entry
                    && !matches!(
                        entry,
                        FileEntry::Message {
                            message: pa_types::session::AgentMessage::ToolResult(_),
                            ..
                        }
                    )
            }
            FilterMode::LabeledOnly => node.data.label.is_some(),
            FilterMode::All => true,
            FilterMode::Default => !is_settings_entry,
        };
        if !passes {
            return false;
        }
        let search = self.search_query.to_lowercase();
        if search.trim().is_empty() {
            return true;
        }
        search
            .split_whitespace()
            .filter(|token| !token.is_empty())
            .all(|token| {
                tree_display::searchable_text(&node.data)
                    .to_lowercase()
                    .contains(token)
            })
    }

    /// Recompute the filtered view: filters, fold-skips, visual structure,
    /// and cursor preservation (TS `applyFilter`).
    pub fn apply_filter(&mut self) {
        if !self.filtered.is_empty() {
            self.last_selected_id = self
                .filtered
                .get(self.selected)
                .and_then(|index| self.flat[*index].data.entry.id().map(str::to_string))
                .or(self.last_selected_id.clone());
        }
        self.filtered = (0..self.flat.len())
            .filter(|index| self.passes_filter(*index))
            .collect();
        // Descendants of folded nodes are skipped (TS skip-set walk).
        if !self.folded.is_empty() {
            let mut skip: HashSet<String> = HashSet::new();
            for node in &self.flat {
                let Some(id) = node.data.entry.id() else {
                    continue;
                };
                if let Some(parent) = node.data.entry.parent_id() {
                    if self.folded.contains(parent) || skip.contains(parent) {
                        skip.insert(id.to_string());
                    }
                }
            }
            self.filtered.retain(|index| {
                self.flat[*index]
                    .data
                    .entry
                    .id()
                    .is_none_or(|id| !skip.contains(id))
            });
        }
        self.recalculate_visual_structure();
        if let Some(last) = self.last_selected_id.clone() {
            self.selected = self.find_nearest_visible_index(Some(&last));
        } else if self.selected >= self.filtered.len() {
            self.selected = self.filtered.len().saturating_sub(1);
        }
        if !self.filtered.is_empty() {
            self.last_selected_id = self
                .filtered
                .get(self.selected)
                .and_then(|index| self.flat[*index].data.entry.id().map(str::to_string))
                .or(self.last_selected_id.clone());
        }
    }

    /// Recompute indent/connectors for the filtered view (TS
    /// `recalculateVisualStructure`): hidden intermediates reattach
    /// descendants to the nearest visible ancestor.
    fn recalculate_visual_structure(&mut self) {
        self.visible_parent.clear();
        self.visible_children.clear();
        self.visible_children.insert(None, Vec::new());
        let visible: HashSet<String> = self
            .filtered
            .iter()
            .filter_map(|index| self.flat[*index].data.entry.id().map(str::to_string))
            .collect();
        // Nearest visible ancestors resolve in one pass over the
        // parent-index graph: hidden chains memoize (a later walk through
        // the same chain stops at the memo instead of re-walking it), and
        // the stamp array closes corrupted parent cycles without
        // per-node allocations.
        let index_by_id: HashMap<&str, usize> = self
            .flat
            .iter()
            .enumerate()
            .filter_map(|(index, node)| node.data.entry.id().map(|id| (id, index)))
            .collect();
        let parent_index_of: Vec<Option<usize>> = self
            .flat
            .iter()
            .map(|node| {
                node.data
                    .entry
                    .parent_id()
                    .and_then(|id| index_by_id.get(id).copied())
            })
            .collect();
        let visible_at: Vec<bool> = self
            .flat
            .iter()
            .map(|node| node.data.entry.id().is_some_and(|id| visible.contains(id)))
            .collect();
        // `memo[node]` holds `Some(outcome)` once resolved (the visible
        // ancestor's flat index, `None` when no visible ancestor exists);
        // `stamp[node]` marks the chain the current walk already walked.
        let mut memo: Vec<Option<Option<usize>>> = vec![None; self.flat.len()];
        let mut stamp: Vec<u32> = vec![0; self.flat.len()];
        let mut generation = 0u32;
        for index in 0..self.flat.len() {
            let id = match self.flat[index].data.entry.id() {
                Some(id) => id.to_string(),
                None => continue,
            };
            // Hidden nodes never join the visible tree: only filtered
            // (visible) entries attach to their nearest visible ancestor
            // (TS builds the maps over `filteredNodes` only).
            if !visible.contains(&id) {
                continue;
            }
            generation += 1;
            let mut path: Vec<usize> = Vec::new();
            let mut outcome: Option<usize> = None;
            let mut current = parent_index_of[index];
            while let Some(next) = current {
                if let Some(cached) = memo[next] {
                    outcome = cached;
                    break;
                }
                if visible_at[next] {
                    outcome = Some(next);
                    break;
                }
                if stamp[next] == generation {
                    break;
                }
                stamp[next] = generation;
                path.push(next);
                current = parent_index_of[next];
            }
            for hidden in path {
                memo[hidden] = Some(outcome);
            }
            let ancestor = outcome
                .and_then(|resolved| self.flat[resolved].data.entry.id())
                .map(str::to_string);
            self.visible_parent.insert(id.clone(), ancestor.clone());
            self.visible_children
                .entry(ancestor)
                .or_default()
                .push(id.clone());
        }
        let visible_root_ids = self
            .visible_children
            .get(&None)
            .cloned()
            .unwrap_or_default();
        self.multiple_roots = visible_root_ids.len() > 1;
        // DFS over the visible tree, recomputing placement.
        #[allow(clippy::type_complexity)]
        let mut stack: Vec<(String, usize, bool, bool, bool, Vec<GutterInfo>, bool)> = Vec::new();
        for (index, root_id) in visible_root_ids.iter().enumerate().rev() {
            let is_last = index == visible_root_ids.len() - 1;
            stack.push((
                root_id.clone(),
                usize::from(self.multiple_roots),
                self.multiple_roots,
                self.multiple_roots,
                is_last,
                Vec::new(),
                self.multiple_roots,
            ));
        }
        // The DFS resolves each visited id's row through one index map
        // (TS `filteredNodeMap`), not a scan per node.
        let index_by_id: HashMap<String, usize> = self
            .flat
            .iter()
            .enumerate()
            .filter_map(|(index, node)| node.data.entry.id().map(|id| (id.to_string(), index)))
            .collect();
        while let Some((
            id,
            indent,
            just_branched,
            show_connector,
            is_last,
            gutters,
            is_virtual_root_child,
        )) = stack.pop()
        {
            let Some(index) = index_by_id.get(id.as_str()).copied() else {
                continue;
            };
            let node = &mut self.flat[index];
            node.indent = indent;
            node.show_connector = show_connector;
            node.is_last = is_last;
            node.gutters.clone_from(&gutters);
            node.is_virtual_root_child = is_virtual_root_child;
            let children = self
                .visible_children
                .get(&Some(id))
                .cloned()
                .unwrap_or_default();
            let multiple_children = children.len() > 1;
            let child_indent = if multiple_children || (just_branched && indent > 0) {
                indent + 1
            } else {
                indent
            };
            let current_display_indent = if self.multiple_roots {
                indent.saturating_sub(1)
            } else {
                indent
            };
            let connector_position = current_display_indent.saturating_sub(1);
            let connector_displayed = show_connector && !is_virtual_root_child;
            let child_gutters = if connector_displayed {
                let mut gutters = gutters.clone();
                gutters.push(GutterInfo {
                    position: connector_position,
                    show: !is_last,
                });
                gutters
            } else {
                gutters.clone()
            };
            for (child_index, child) in children.iter().enumerate().rev() {
                let child_is_last = child_index == children.len() - 1;
                stack.push((
                    child.clone(),
                    child_indent,
                    multiple_children,
                    multiple_children,
                    child_is_last,
                    child_gutters.clone(),
                    false,
                ));
            }
        }
    }

    /// Index (into `filtered`) of the nearest visible entry from `entry_id`
    /// walking up the parent chain (TS `findNearestVisibleIndex`).
    fn find_nearest_visible_index(&self, entry_id: Option<&str>) -> usize {
        if self.filtered.is_empty() {
            return 0;
        }
        let visible_positions: HashMap<&str, usize> = self
            .filtered
            .iter()
            .enumerate()
            .filter_map(|(position, index)| {
                self.flat[*index].data.entry.id().map(|id| (id, position))
            })
            .collect();
        // The same id-indexed walk as [`Self::build_active_path`]: Map
        // lookups per hop (TS `entryMap`), with the visited set
        // terminating a corrupted parent cycle.
        let index_by_id: HashMap<&str, usize> = self
            .flat
            .iter()
            .enumerate()
            .filter_map(|(index, node)| node.data.entry.id().map(|id| (id, index)))
            .collect();
        let mut visited: HashSet<usize> = HashSet::new();
        let mut current = entry_id.map(str::to_string);
        while let Some(id) = current {
            if let Some(position) = visible_positions.get(id.as_str()) {
                return *position;
            }
            let Some(&index) = index_by_id.get(id.as_str()) else {
                break;
            };
            if !visited.insert(index) {
                break;
            }
            current = self.flat[index].data.entry.parent_id().map(str::to_string);
        }
        self.filtered.len() - 1
    }

    /// The selected entry's id, when one row is selected.
    #[must_use]
    pub fn selected_id(&self) -> Option<String> {
        self.filtered
            .get(self.selected)
            .and_then(|index| self.flat[*index].data.entry.id().map(str::to_string))
    }

    /// Move the cursor onto one entry (the nearest visible row when the
    /// entry is hidden).
    pub fn move_selection_to(&mut self, entry_id: Option<&str>) {
        self.selected = self.find_nearest_visible_index(entry_id);
        if !self.filtered.is_empty() {
            self.last_selected_id = self
                .filtered
                .get(self.selected)
                .and_then(|index| self.flat[*index].data.entry.id().map(str::to_string));
        }
    }

    /// The active search query.
    #[must_use]
    pub fn search_query(&self) -> &str {
        &self.search_query
    }

    /// The session's current leaf id (the active-branch tip).
    #[must_use]
    pub fn current_leaf_id(&self) -> Option<&str> {
        self.current_leaf_id.as_deref()
    }

    /// The label currently attached to an entry (the label-edit input's
    /// initial value).
    #[must_use]
    pub fn label_of(&self, entry_id: &str) -> Option<String> {
        self.flat
            .iter()
            .find(|node| node.data.entry.id() == Some(entry_id))
            .and_then(|node| node.data.label.clone())
    }

    /// Fold or unfold state for one entry id (the connector's ⊟/⊞ marker).
    fn is_folded(&self, id: &str) -> bool {
        self.folded.contains(id)
    }

    /// Whether a node can fold: it has visible children and is a root or a
    /// branch-point child (TS `isFoldable`).
    fn is_foldable(&self, id: &str) -> bool {
        let children = self.visible_children.get(&Some(id.to_string()));
        if children.is_none_or(Vec::is_empty) {
            return false;
        }
        match self.visible_parent.get(id).cloned().flatten() {
            None => true,
            Some(parent) => self
                .visible_children
                .get(&Some(parent))
                .is_some_and(|siblings| siblings.len() > 1),
        }
    }

    /// The next branch-segment start in a direction (TS
    /// `findBranchSegmentStart`): fold-or-up walks the visible parent
    /// chain, unfold-or-down follows children.
    fn find_branch_segment_start(&self, direction: Direction) -> usize {
        let Some(selected_id) = self.selected_id() else {
            return self.selected;
        };
        let positions: HashMap<&str, usize> = self
            .filtered
            .iter()
            .enumerate()
            .filter_map(|(position, index)| {
                self.flat[*index].data.entry.id().map(|id| (id, position))
            })
            .collect();
        let mut current = selected_id;
        if direction == Direction::Down {
            loop {
                let children = self
                    .visible_children
                    .get(&Some(current.clone()))
                    .cloned()
                    .unwrap_or_default();
                if children.is_empty() {
                    return positions
                        .get(current.as_str())
                        .copied()
                        .unwrap_or(self.selected);
                }
                if children.len() > 1 {
                    return positions
                        .get(children[0].as_str())
                        .copied()
                        .unwrap_or(self.selected);
                }
                current.clone_from(&children[0]);
            }
        }
        loop {
            let parent = self.visible_parent.get(&current).cloned().flatten();
            let Some(parent) = parent else {
                return positions
                    .get(current.as_str())
                    .copied()
                    .unwrap_or(self.selected);
            };
            let children = self
                .visible_children
                .get(&Some(parent.clone()))
                .cloned()
                .unwrap_or_default();
            if children.len() > 1 {
                if let Some(start) = positions.get(current.as_str()) {
                    if *start < self.selected {
                        return *start;
                    }
                }
            }
            current = parent;
        }
    }

    /// Handle one key id. Returns the action for the caller to run.
    ///
    /// # Panics
    ///
    /// Cannot panic: the `expect` runs only when the foldable check
    /// already proved the selected id is `Some`.
    pub fn handle_key(&mut self, kb: &KeybindingsManager, id: &str) -> TreeListAction {
        let mut action = TreeListAction::None;
        if kb.matches(id, "tui.select.up") {
            if self.selected == 0 {
                self.selected = self.filtered.len().saturating_sub(1);
            } else {
                self.selected -= 1;
            }
        } else if kb.matches(id, "tui.select.down") {
            self.selected = (self.selected + 1) % self.filtered.len().max(1);
        } else if kb.matches(id, "app.tree.foldOrUp") {
            let current = self.selected_id();
            let foldable = current
                .as_deref()
                .is_some_and(|id| self.is_foldable(id) && !self.folded.contains(id));
            if foldable {
                self.folded.insert(current.expect("foldable id"));
                self.apply_filter();
            } else {
                self.selected = self.find_branch_segment_start(Direction::Up);
            }
        } else if kb.matches(id, "app.tree.unfoldOrDown") {
            let current = self.selected_id();
            if let Some(id) = current.filter(|id| self.folded.contains(id)) {
                self.folded.remove(&id);
                self.apply_filter();
            } else {
                self.selected = self.find_branch_segment_start(Direction::Down);
            }
        } else if kb.matches(id, "tui.select.pageUp") || kb.matches(id, "tui.editor.cursorLeft") {
            self.selected = self.selected.saturating_sub(self.max_visible_lines);
        } else if kb.matches(id, "tui.select.pageDown") || kb.matches(id, "tui.editor.cursorRight")
        {
            if !self.filtered.is_empty() {
                self.selected =
                    (self.selected + self.max_visible_lines).min(self.filtered.len() - 1);
            }
        } else if kb.matches(id, "tui.select.confirm") {
            if let Some(id) = self.selected_id() {
                action = TreeListAction::Select(id);
            }
        } else if kb.matches(id, "tui.select.cancel") {
            if self.search_query.is_empty() {
                action = TreeListAction::Cancel;
            } else {
                self.search_query.clear();
                self.folded.clear();
                self.apply_filter();
            }
        } else if kb.matches(id, "app.tree.filter.default") {
            self.filter_mode = FilterMode::Default;
            self.folded.clear();
            self.apply_filter();
        } else if kb.matches(id, "app.tree.filter.noTools") {
            self.filter_mode = toggle(self.filter_mode, FilterMode::NoTools);
            self.folded.clear();
            self.apply_filter();
        } else if kb.matches(id, "app.tree.filter.userOnly") {
            self.filter_mode = toggle(self.filter_mode, FilterMode::UserOnly);
            self.folded.clear();
            self.apply_filter();
        } else if kb.matches(id, "app.tree.filter.labeledOnly") {
            self.filter_mode = toggle(self.filter_mode, FilterMode::LabeledOnly);
            self.folded.clear();
            self.apply_filter();
        } else if kb.matches(id, "app.tree.filter.all") {
            self.filter_mode = toggle(self.filter_mode, FilterMode::All);
            self.folded.clear();
            self.apply_filter();
        } else if kb.matches(id, "app.tree.filter.cycleForward") {
            self.filter_mode = self.filter_mode.cycle_forward();
            self.folded.clear();
            self.apply_filter();
        } else if kb.matches(id, "app.tree.filter.cycleBackward") {
            self.filter_mode = self.filter_mode.cycle_backward();
            self.folded.clear();
            self.apply_filter();
        } else if kb.matches(id, "tui.editor.deleteCharBackward") {
            if !self.search_query.is_empty() {
                self.search_query.pop();
                self.folded.clear();
                self.apply_filter();
            }
        } else if kb.matches(id, "app.tree.editLabel") {
            if let Some(id) = self.selected_id() {
                action = TreeListAction::EditLabel(id);
            }
        } else if kb.matches(id, "app.tree.toggleLabelTimestamp") {
            self.show_label_timestamps = !self.show_label_timestamps;
        } else {
            // Printable characters build the search query (TS: control
            // characters never append).
            let has_control = id
                .chars()
                .any(|c| c.is_control() || matches!(u32::from(c), 0x7f..=0x9f));
            if !has_control && !id.is_empty() && !id.contains('+') {
                self.search_query.push_str(id);
                self.folded.clear();
                self.apply_filter();
            }
        }
        action
    }

    /// Update one node's label after a save (TS `updateNodeLabel`).
    pub fn update_node_label(&mut self, entry_id: &str, label: Option<String>, timestamp: &str) {
        if let Some(node) = self
            .flat
            .iter_mut()
            .find(|node| node.data.entry.id() == Some(entry_id))
        {
            node.data.label.clone_from(&label);
            node.data.label_timestamp = label.map(|_| timestamp.to_string());
        }
        // Keep the filtered view consistent with the labeled-only filter.
        if self.filter_mode == FilterMode::LabeledOnly {
            self.apply_filter();
        }
    }
}
#[cfg(test)]
mod tests;
