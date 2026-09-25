//! The `/tree` list state: flatten, filter, fold, search, and navigation.
//! Port of the TS `TreeList` component's model (interactive-mode's
//! tree-selector.ts).

use std::collections::{HashMap, HashSet};

use crate::keybindings::KeybindingsManager;
use crate::theme::{Theme, ThemeBg, ThemeColor};
use crate::tree_display::{self, ToolCallInfo};
use crate::tree_nodes::{TreeNode, TreeNodeData};
use crate::width::{str_width, truncate_line};
use crate::{Line, Span};
use pa_types::session::FileEntry;
use ratatui::style::{Modifier, Style};

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
        tree: Vec<TreeNode>,
        current_leaf_id: Option<String>,
        max_visible_lines: usize,
        initial_selected_id: Option<&str>,
        initial_filter_mode: FilterMode,
    ) -> Self {
        let flat = Self::flatten_tree(&tree, current_leaf_id.as_deref());
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
        let mut current = Some(leaf);
        while let Some(id) = current {
            let Some(node) = self
                .flat
                .iter()
                .find(|node| node.data.entry.id() == Some(id.as_str()))
            else {
                break;
            };
            self.active_path.insert(id.clone());
            current = node.data.entry.parent_id().map(str::to_string);
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
                    if contains_active.get(&(child as *const TreeNode)) == Some(&true) {
                        has = true;
                    }
                }
                contains_active.insert(*node as *const TreeNode, has);
            }
        }
        let multiple_roots = roots.len() > 1;
        let has = |node: &TreeNode| contains_active.get(&(node as *const TreeNode)) == Some(&true);

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
        let parent_of = |id: &str| -> Option<String> {
            self.flat
                .iter()
                .find(|node| node.data.entry.id() == Some(id))
                .and_then(|node| node.data.entry.parent_id().map(str::to_string))
        };
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
            // Nearest visible ancestor.
            let mut ancestor: Option<String> = None;
            let mut current = parent_of(&id);
            while let Some(candidate) = current {
                if visible.contains(&candidate) {
                    ancestor = Some(candidate);
                    break;
                }
                current = parent_of(&candidate);
            }
            self.visible_parent.insert(id.clone(), ancestor.clone());
            self.visible_children.entry(ancestor).or_default().push(id);
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
            let Some(index) = self
                .filtered
                .iter()
                .copied()
                .find(|index| self.flat[*index].data.entry.id() == Some(id.as_str()))
            else {
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
        let mut current = entry_id.map(str::to_string);
        while let Some(id) = current {
            if let Some(position) = visible_positions.get(id.as_str()) {
                return *position;
            }
            current = self
                .flat
                .iter()
                .find(|node| node.data.entry.id() == Some(id.as_str()))
                .and_then(|node| node.data.entry.parent_id().map(str::to_string));
        }
        self.filtered.len() - 1
    }

    /// The selected entry's id, when one row is selected.
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
    pub fn search_query(&self) -> &str {
        &self.search_query
    }

    /// The session's current leaf id (the active-branch tip).
    pub fn current_leaf_id(&self) -> Option<&str> {
        self.current_leaf_id.as_deref()
    }

    /// The label currently attached to an entry (the label-edit input's
    /// initial value).
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

    /// Render the visible rows plus the counter (TS `TreeList.render`).
    pub fn render(&self, theme: &Theme, width: usize) -> Vec<Line> {
        let mut lines: Vec<Line> = Vec::new();
        if self.filtered.is_empty() {
            lines.push(truncate_line(
                &vec![theme.fg_span(ThemeColor::Muted, "  No entries found".to_string())],
                width,
                "",
            ));
            lines.push(truncate_line(
                &vec![theme.fg_span(
                    ThemeColor::Muted,
                    format!("  (0/0){}", self.filter_mode.status_label()),
                )],
                width,
                "",
            ));
            return lines;
        }
        let max = self.max_visible_lines;
        let start = self
            .selected
            .saturating_sub(max / 2)
            .min(self.filtered.len().saturating_sub(max));
        let end = (start + max).min(self.filtered.len());
        let selected_bg = theme.bg_style(ThemeBg::SelectedBg);
        for position in start..end {
            let index = self.filtered[position];
            let node = &self.flat[index];
            let entry_id = node.data.entry.id().unwrap_or_default();
            let is_selected = position == self.selected;
            // TS renders the selected row's cursor and path markers inside
            // the selection background with no accent foreground: the the TS TUI
            // row writer drops those interior colors, and the capture shows
            // only the background escape before `› `.
            let cursor = if is_selected {
                Span::raw("› ".to_string())
            } else {
                Span::raw("  ".to_string())
            };
            let display_indent = if self.multiple_roots {
                node.indent.saturating_sub(1)
            } else {
                node.indent
            };
            let connector = if node.show_connector && !node.is_virtual_root_child {
                if node.is_last {
                    "└─ "
                } else {
                    "├─ "
                }
            } else {
                ""
            };
            let connector_position = if connector.is_empty() {
                usize::MAX
            } else {
                display_indent.saturating_sub(1)
            };
            // Prefix: gutters and connector placed per 3-char level.
            let mut prefix = String::new();
            for i in 0..display_indent * 3 {
                let level = i / 3;
                let pos_in_level = i % 3;
                let gutter = node.gutters.iter().find(|g| g.position == level);
                if let Some(gutter) = gutter {
                    if pos_in_level == 0 {
                        prefix.push(if gutter.show { '│' } else { ' ' });
                    } else {
                        prefix.push(' ');
                    }
                } else if !connector.is_empty() && level == connector_position {
                    match pos_in_level {
                        0 => prefix.push(if node.is_last { '└' } else { '├' }),
                        1 => {
                            let foldable = self.is_foldable(entry_id);
                            prefix.push(if self.is_folded(entry_id) {
                                '⊞'
                            } else if foldable {
                                '⊟'
                            } else {
                                '─'
                            });
                        }
                        _ => prefix.push(' '),
                    }
                } else {
                    prefix.push(' ');
                }
            }
            let shows_fold_in_connector = node.show_connector && !node.is_virtual_root_child;
            let fold_marker = if self.is_folded(entry_id) && !shows_fold_in_connector {
                theme.fg_span(ThemeColor::Accent, "⊞ ".to_string())
            } else {
                Span::raw("")
            };
            let path_marker = if self.active_path.contains(entry_id) {
                if is_selected {
                    Span::raw("• ".to_string())
                } else {
                    theme.fg_span(ThemeColor::Accent, "• ".to_string())
                }
            } else {
                Span::raw("")
            };
            let label = node.data.label.as_ref().map_or(Span::raw(""), |label| {
                theme.fg_span(ThemeColor::Warning, format!("[{label}] "))
            });
            let label_timestamp = if self.show_label_timestamps && node.data.label.is_some() {
                node.data.label_timestamp.as_deref().map_or_else(
                    || Span::raw(""),
                    |timestamp| {
                        theme.fg_span(
                            ThemeColor::Muted,
                            format!("{} ", format_label_timestamp(timestamp)),
                        )
                    },
                )
            } else {
                Span::raw("")
            };
            let mut content = tree_display::entry_display_text(theme, &node.data, &self.tool_calls);
            if is_selected {
                // TS `theme.bold(getEntryDisplayText(...))` wraps the whole
                // display text; the the TS TUI writer then re-emits the inner
                // fg reset between the role label and the content, so the
                // capture shows only the role run bold.
                if let Some(first) = content.first_mut() {
                    first.style = first.style.add_modifier(Modifier::BOLD);
                }
            }
            let mut row: Line = vec![cursor, theme.fg_span(ThemeColor::Dim, prefix.clone())];
            row.push(fold_marker);
            row.push(path_marker);
            row.push(label);
            row.push(label_timestamp);
            row.extend(content);
            if is_selected {
                // The selected row keeps only the bold modifier over the
                // selection background: the the TS TUI writer drops interior
                // foreground colors under the selection wrap, so the
                // capture shows `› • ` and the bold role without their
                // accent escapes.
                for span in &mut row {
                    let bold = span.style.add_modifier.contains(Modifier::BOLD);
                    span.style = Style::default();
                    if bold {
                        span.style = span.style.add_modifier(Modifier::BOLD);
                    }
                    span.style = span.style.patch(selected_bg);
                }
            }
            let _ = str_width(&prefix);
            lines.push(truncate_line(&row, width, ""));
        }
        lines.push(truncate_line(
            &vec![theme.fg_span(
                ThemeColor::Muted,
                format!(
                    "  ({}/{}){}",
                    self.selected + 1,
                    self.filtered.len(),
                    self.filter_mode.status_label()
                ),
            )],
            width,
            "",
        ));
        lines
    }
}

/// One iterative-flatten stack item: the node with its placement.
type FlattenItem<'a> = (&'a TreeNode, usize, bool, bool, bool, Vec<GutterInfo>, bool);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    Up,
    Down,
}

/// Toggle a filter mode: the requested mode switches back to default.
fn toggle(current: FilterMode, requested: FilterMode) -> FilterMode {
    if current == requested {
        FilterMode::Default
    } else {
        requested
    }
}

/// Label timestamps render as `HH:MM` today, `M/D HH:MM` this year, and
/// `YY/M/D HH:MM` otherwise (TS `formatLabelTimestamp`).
fn format_label_timestamp(timestamp: &str) -> String {
    // The wire timestamps are ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`).
    let parse = |text: &str| -> Option<(u32, u32, u32, u32, u32)> {
        let bytes = text.as_bytes();
        if bytes.len() < 16 {
            return None;
        }
        let year: u32 = text.get(0..4)?.parse().ok()?;
        let month: u32 = text.get(5..7)?.parse().ok()?;
        let day: u32 = text.get(8..10)?.parse().ok()?;
        let hour: u32 = text.get(11..13)?.parse().ok()?;
        let minute: u32 = text.get(14..16)?.parse().ok()?;
        Some((year, month, day, hour, minute))
    };
    let Some((year, month, day, hour, minute)) = parse(timestamp) else {
        return String::new();
    };
    let time = format!("{hour:02}:{minute:02}");
    // "Today" needs the current date; sessions are recent, so a same-day
    // match compares against the current UTC date.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (now_year, now_month, now_day) = utc_date(now);
    if (year, month, day) == (now_year, now_month, now_day) {
        return time;
    }
    if year == now_year {
        return format!("{month}/{day} {time}");
    }
    let year_short = year % 100;
    format!("{year_short:02}/{month}/{day} {time}")
}

/// UTC date from unix seconds.
fn utc_date(secs: u64) -> (u32, u32, u32) {
    let days = secs / 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as u32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree_nodes::{build_tree, TreeNodeData};
    use serde_json::Map;

    fn message_node(id: &str, parent: Option<&str>, timestamp: &str, text: &str) -> TreeNodeData {
        TreeNodeData {
            entry: FileEntry::Message {
                message: pa_types::session::AgentMessage::User(pa_types::ai::UserMessage {
                    content: pa_types::ai::UserContent::Text(text.to_string()),
                    timestamp: 0,
                    rest: Map::default(),
                }),
                base: pa_types::session::EntryBase {
                    id: Some(id.to_string()),
                    parent_id: parent.map(str::to_string),
                    timestamp: Some(timestamp.to_string()),
                    rest: Map::default(),
                },
            },
            label: None,
            label_timestamp: None,
        }
    }

    fn assistant_node(id: &str, parent: Option<&str>, timestamp: &str) -> TreeNodeData {
        TreeNodeData {
            entry: FileEntry::Message {
                message: pa_types::session::AgentMessage::Assistant(
                    pa_types::ai::AssistantMessage {
                        content: vec![],
                        api: "openai-completions".to_string(),
                        provider: "openai".to_string(),
                        model: "m".to_string(),
                        response_model: None,
                        response_id: None,
                        diagnostics: None,
                        usage: pa_types::ai::Usage::default(),
                        stop_reason: pa_types::ai::StopReason::Stop,
                        stop_reason_raw: None,
                        error_message: None,
                        timestamp: 0,
                        rest: Map::default(),
                    },
                ),
                base: pa_types::session::EntryBase {
                    id: Some(id.to_string()),
                    parent_id: parent.map(str::to_string),
                    timestamp: Some(timestamp.to_string()),
                    rest: Map::default(),
                },
            },
            label: None,
            label_timestamp: None,
        }
    }

    fn assistant_text_node(
        id: &str,
        parent: Option<&str>,
        timestamp: &str,
        text: &str,
    ) -> TreeNodeData {
        let mut node = assistant_node(id, parent, timestamp);
        if let FileEntry::Message {
            message: pa_types::session::AgentMessage::Assistant(assistant),
            ..
        } = &mut node.entry
        {
            assistant.content = vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: text.to_string(),
                    text_signature: None,
                    rest: Map::default(),
                },
            )];
        }
        node
    }

    fn settings_node(id: &str, parent: Option<&str>, timestamp: &str) -> TreeNodeData {
        TreeNodeData {
            entry: FileEntry::ModelChange {
                payload: pa_types::session::ModelChangeEntry {
                    provider: "openai".to_string(),
                    model_id: "m".to_string(),
                },
                base: pa_types::session::EntryBase {
                    id: Some(id.to_string()),
                    parent_id: parent.map(str::to_string),
                    timestamp: Some(timestamp.to_string()),
                    rest: Map::default(),
                },
            },
            label: None,
            label_timestamp: None,
        }
    }

    fn list(flat: Vec<TreeNodeData>, leaf: Option<&str>) -> TreeList {
        TreeList::new(
            build_tree(flat),
            leaf.map(str::to_string),
            40,
            None,
            FilterMode::Default,
        )
    }

    #[test]
    fn default_view_hides_settings_entries() {
        let flat = vec![
            message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
            settings_node("m1", Some("u1"), "2024-01-01T00:00:02.000Z"),
            assistant_node("a1", Some("m1"), "2024-01-01T00:00:03.000Z"),
        ];
        let tree = list(flat, Some("a1"));
        let visible: Vec<&str> = tree
            .filtered
            .iter()
            .map(|index| tree.flat[*index].data.entry.id().unwrap())
            .collect();
        // The model change is hidden; the user and assistant rows stay.
        assert_eq!(visible, vec!["u1", "a1"]);
        // The active leaf leads the initial selection.
        assert_eq!(tree.selected_id().as_deref(), Some("a1"));
    }

    #[test]
    fn user_only_and_all_filters() {
        let flat = vec![
            message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
            settings_node("m1", Some("u1"), "2024-01-01T00:00:02.000Z"),
            assistant_node("a1", Some("m1"), "2024-01-01T00:00:03.000Z"),
        ];
        let mut tree = list(flat, Some("a1"));
        tree.filter_mode = FilterMode::UserOnly;
        tree.apply_filter();
        let visible: Vec<&str> = tree
            .filtered
            .iter()
            .map(|index| tree.flat[*index].data.entry.id().unwrap())
            .collect();
        assert_eq!(visible, vec!["u1"]);
        tree.filter_mode = FilterMode::All;
        tree.apply_filter();
        assert_eq!(tree.filtered.len(), 3);
    }

    #[test]
    fn branch_move_selects_nearest_visible_ancestor() {
        // u1 -> a1 -> u2 (leaf), u3 sibling under a1.
        let flat = vec![
            message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
            assistant_text_node("a1", Some("u1"), "2024-01-01T00:00:02.000Z", "answer"),
            message_node("u2", Some("a1"), "2024-01-01T00:00:03.000Z", "second"),
            message_node("u3", Some("a1"), "2024-01-01T00:00:04.000Z", "sibling"),
        ];
        let mut tree = list(flat, Some("u2"));
        assert_eq!(tree.selected_id().as_deref(), Some("u2"));
        // Folding u1 hides its subtree; the cursor walks up to u1.
        tree.folded.insert("u1".to_string());
        tree.apply_filter();
        let visible: Vec<&str> = tree
            .filtered
            .iter()
            .map(|index| tree.flat[*index].data.entry.id().unwrap())
            .collect();
        assert_eq!(visible, vec!["u1"], "descendants hidden: {visible:?}");
        assert_eq!(tree.selected_id().as_deref(), Some("u1"));
        // Unfolding restores the rows and the cursor stays on u1.
        tree.folded.clear();
        tree.apply_filter();
        assert_eq!(tree.selected_id().as_deref(), Some("u1"));
    }

    #[test]
    fn search_filters_and_backspace_restores() {
        let flat = vec![
            message_node("u1", None, "2024-01-01T00:00:01.000Z", "fix the parser"),
            assistant_text_node(
                "a1",
                Some("u1"),
                "2024-01-01T00:00:02.000Z",
                "parser answer",
            ),
            message_node(
                "u2",
                Some("a1"),
                "2024-01-01T00:00:03.000Z",
                "second request",
            ),
        ];
        let kb = KeybindingsManager::new();
        let mut tree = list(flat, Some("u2"));
        for ch in ["p", "a", "r", "s", "e", "r"] {
            tree.handle_key(&kb, ch);
        }
        let visible: Vec<&str> = tree
            .filtered
            .iter()
            .map(|index| tree.flat[*index].data.entry.id().unwrap())
            .collect();
        assert_eq!(visible, vec!["u1", "a1"]);
        // Escape with a query clears the search instead of closing.
        tree.handle_key(&kb, "escape");
        assert_eq!(tree.search_query(), "");
        assert_eq!(tree.filtered.len(), 3);
        // Backspace pops one character.
        for ch in ["s", "e", "c", "o", "n", "d"] {
            tree.handle_key(&kb, ch);
        }
        let visible: Vec<&str> = tree
            .filtered
            .iter()
            .map(|index| tree.flat[*index].data.entry.id().unwrap())
            .collect();
        assert_eq!(visible, vec!["u2"]);
        tree.handle_key(&kb, "backspace");
        assert_eq!(tree.search_query(), "secon");
    }

    #[test]
    fn user_only_filter_keeps_hidden_intermediates_out_of_the_visible_tree() {
        let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        // u1 -> a1 -> u2 (leaf): the user-only filter hides a1, and the
        // hidden assistant must not join the visible tree (a stray child
        // would branch u1 and give u2 a connector).
        let flat = vec![
            message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
            assistant_text_node("a1", Some("u1"), "2024-01-01T00:00:02.000Z", "answer"),
            message_node("u2", Some("a1"), "2024-01-01T00:00:03.000Z", "second"),
        ];
        let mut tree = list(flat, Some("u2"));
        let kb = KeybindingsManager::new();
        tree.handle_key(&kb, "ctrl+u");
        let rows = tree.render(&theme, 80);
        let joined: Vec<String> = rows
            .iter()
            .map(|row| {
                row.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .collect();
        // Two user rows, both flat: no connector characters on either.
        assert!(
            joined.iter().any(|row| row.contains("user: first")),
            "{joined:?}"
        );
        assert!(
            joined.iter().any(|row| row.contains("user: second")),
            "{joined:?}"
        );
        assert!(
            !joined
                .iter()
                .any(|row| row.contains("└") || row.contains("├")),
            "the hidden assistant did not branch the visible tree: {joined:?}"
        );
    }

    #[test]
    fn fold_or_up_moves_to_branch_segment() {
        // u1 -> a1 -> u2 (leaf).
        let flat = vec![
            message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
            assistant_text_node("a1", Some("u1"), "2024-01-01T00:00:02.000Z", "answer"),
            message_node("u2", Some("a1"), "2024-01-01T00:00:03.000Z", "second"),
        ];
        let kb = KeybindingsManager::new();
        let mut tree = list(flat, Some("u2"));
        // From the leaf, fold-or-up walks the visible parent chain; u2 is
        // already the segment start, so the walk continues to the root (TS
        // findBranchSegmentStart "up").
        tree.handle_key(&kb, "ctrl+left");
        assert_eq!(tree.selected_id().as_deref(), Some("u1"));
        // Unfold-or-down follows the single-child chain to the leaf.
        tree.handle_key(&kb, "ctrl+right");
        assert_eq!(tree.selected_id().as_deref(), Some("u2"));
    }

    #[test]
    fn render_marks_active_path_and_connectors() {
        let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        // u1 -> a1 -> u2 (leaf) plus sibling u3.
        let flat = vec![
            message_node("u1", None, "2024-01-01T00:00:01.000Z", "first"),
            assistant_text_node("a1", Some("u1"), "2024-01-01T00:00:02.000Z", "answer"),
            message_node("u2", Some("a1"), "2024-01-01T00:00:03.000Z", "second"),
            message_node("u3", Some("a1"), "2024-01-01T00:00:04.000Z", "sibling"),
        ];
        let tree = list(flat, Some("u2"));
        let rows = tree.render(&theme, 100);
        let text: Vec<String> = rows
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect();
        // The active branch (u1, a1, u2) carries the path marker; the
        // selected row is the leaf.
        assert!(text[0].starts_with("  •"), "path marker: {:?}", text[0]);
        let selected = text
            .iter()
            .find(|row| row.starts_with("› "))
            .expect("selected row");
        assert!(selected.contains("• user: second"), "selected: {selected}");
        let sibling = text
            .iter()
            .find(|row| row.contains("sibling"))
            .expect("sibling row");
        assert!(
            sibling.contains("└─") && sibling.contains("user: sibling"),
            "connector: {sibling}"
        );
        // The counter row closes the list.
        assert!(text.last().unwrap().starts_with("  ("));
    }

    #[test]
    fn label_update_round_trips() {
        let flat = vec![message_node(
            "u1",
            None,
            "2024-01-01T00:00:01.000Z",
            "first",
        )];
        let mut tree = list(flat, Some("u1"));
        tree.update_node_label(
            "u1",
            Some("checkpoint".to_string()),
            "2024-01-02T00:00:00.000Z",
        );
        assert_eq!(tree.label_of("u1").as_deref(), Some("checkpoint"));
        tree.update_node_label("u1", None, "");
        assert_eq!(tree.label_of("u1"), None);
    }
}
