//! Session-tree node model: the flat `get_session_tree` wire nodes parsed
//! into typed entries, and the parent/child tree the `/tree` view navigates
//! (TS `buildSessionTreeFromFlatNodes` + `SessionTreeFlatNode`).

use std::collections::HashMap;

use pa_types::session::FileEntry;
use serde_json::Value;

/// One wire flat node: the full entry plus its active label.
#[derive(Debug, Clone, PartialEq)]
pub struct TreeNodeData {
    pub entry: FileEntry,
    pub label: Option<String>,
    pub label_timestamp: Option<String>,
}

/// Parse the `get_session_tree` response data into flat nodes.
pub fn parse_flat_nodes(data: &Value) -> Vec<TreeNodeData> {
    data.get("flatNodes")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|node| {
                    let entry = node.get("entry")?;
                    Some(TreeNodeData {
                        entry: serde_json::from_value(entry.clone()).ok()?,
                        label: node
                            .get("label")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        label_timestamp: node
                            .get("labelTimestamp")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A tree node: its data plus its children (siblings sorted by timestamp,
/// oldest first, like the TS `getTree` ordering).
///
/// The type deliberately carries no `Clone`/`Debug` derives: a session
/// tree nests one level per entry (a linear session runs tens of
/// thousands deep), and the generated per-level recursion of either
/// would overflow the runtime stack the same way a recursive build
/// does.
pub struct TreeNode {
    pub data: TreeNodeData,
    pub children: Vec<TreeNode>,
}

impl Drop for TreeNode {
    fn drop(&mut self) {
        // Teardown drains descendants through a worklist, never the call
        // stack: dropping a deep chain must not recurse per level.
        let mut rest: Vec<TreeNode> = std::mem::take(&mut self.children);
        while let Some(mut node) = rest.pop() {
            rest.append(&mut node.children);
        }
    }
}

impl TreeNode {
    pub fn id(&self) -> Option<&str> {
        self.data.entry.id()
    }

    pub fn parent_id(&self) -> Option<&str> {
        self.data.entry.parent_id()
    }

    pub fn timestamp(&self) -> &str {
        self.data.entry.timestamp()
    }
}

/// One worklist step of [`build_tree`]'s post-order walk: `Enter` pushes
/// the node's `Leave` step plus its children; `Leave` assembles the node
/// from its slot and the children built below it.
enum BuildStep {
    Enter(usize),
    Leave(usize),
}

/// Build the nested tree from flat nodes (TS
/// `buildSessionTreeFromFlatNodes`): parentless entries (or entries whose
/// parent is missing) become roots; sibling order is by timestamp, oldest
/// first (the TS `getTree` ordering).
///
/// The construction walks an explicit worklist, never the call stack
/// (TS builds "without recursively walking deep chains"): a session tree
/// nests one level per entry, and a call frame per level would overflow
/// the runtime stack on a linear session tens of thousands of entries
/// deep.
pub fn build_tree(flat: Vec<TreeNodeData>) -> Vec<TreeNode> {
    let by_id: HashMap<String, usize> = flat
        .iter()
        .enumerate()
        .filter_map(|(index, node)| node.entry.id().map(|id| (id.to_string(), index)))
        .collect();
    let mut slots: Vec<Option<TreeNode>> = flat
        .into_iter()
        .map(|data| {
            Some(TreeNode {
                data,
                children: Vec::new(),
            })
        })
        .collect();
    // One child-index list per node, resolved before any node is taken out
    // of its slot (a child attaches to the LAST parent occurrence, matching
    // the TS map-insertion order).
    let child_indices: Vec<Vec<usize>> = {
        let mut lists = vec![Vec::new(); slots.len()];
        for (index, slot) in slots.iter().enumerate() {
            let parent_index = slot
                .as_ref()
                .and_then(|node| node.parent_id())
                .and_then(|id| by_id.get(id))
                .copied()
                .filter(|&parent| parent != index);
            if let Some(parent) = parent_index {
                lists[parent].push(index);
            }
        }
        lists
    };
    let roots: Vec<usize> = (0..slots.len())
        .filter(|&index| {
            slots[index]
                .as_ref()
                .and_then(|node| node.parent_id())
                .and_then(|id| by_id.get(id))
                .copied()
                .unwrap_or(index)
                == index
        })
        .collect();
    // A node enters the worklist once (from its one parent slot or the
    // root list), so the walk terminates on any input, parent cycles
    // included (cycle members are never roots and never enter the
    // worklist).
    let mut built: Vec<Option<TreeNode>> = vec![None; slots.len()];
    let mut work: Vec<BuildStep> = roots.iter().rev().copied().map(BuildStep::Enter).collect();
    while let Some(step) = work.pop() {
        match step {
            BuildStep::Enter(index) => {
                work.push(BuildStep::Leave(index));
                work.extend(
                    child_indices[index]
                        .iter()
                        .rev()
                        .copied()
                        .map(BuildStep::Enter),
                );
            }
            BuildStep::Leave(index) => {
                let Some(mut node) = slots[index].take() else {
                    continue;
                };
                let mut children: Vec<TreeNode> = child_indices[index]
                    .iter()
                    .filter_map(|child| built[*child].take())
                    .collect();
                children.sort_by(|a, b| a.timestamp().cmp(b.timestamp()));
                node.children = children;
                built[index] = Some(node);
            }
        }
    }
    roots
        .into_iter()
        .filter_map(|index| built[index].take())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    fn node(id: &str, parent: Option<&str>, timestamp: &str) -> TreeNodeData {
        TreeNodeData {
            entry: FileEntry::Custom {
                payload: pa_types::session::CustomEntry {
                    custom_type: "x".to_string(),
                    data: None,
                    rest: Map::default(),
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

    #[test]
    fn builds_tree_with_timestamp_sorted_siblings() {
        let flat = vec![
            node("root", None, "2024-01-01T00:00:01.000Z"),
            node("b", Some("root"), "2024-01-01T00:00:03.000Z"),
            node("a", Some("root"), "2024-01-01T00:00:02.000Z"),
            node("orphan", Some("missing"), "2024-01-01T00:00:04.000Z"),
        ];
        let tree = build_tree(flat);
        let root_ids: Vec<&str> = tree.iter().map(|n| n.id().unwrap()).collect();
        // The parentless entry and the orphan both become roots.
        assert_eq!(root_ids, vec!["root", "orphan"]);
        let children: Vec<&str> = tree[0].children.iter().map(|n| n.id().unwrap()).collect();
        assert_eq!(children, vec!["a", "b"], "oldest sibling first");
    }

    #[test]
    fn deep_chain_builds_and_tears_down_iteratively() {
        // A linear session nests one level per entry; the operator's tree
        // ran tens of thousands deep, and a per-level build (or teardown)
        // overflows the runtime stack. A size far past any thread stack
        // makes the regression deterministic on every thread.
        let depth = 50_000;
        let mut flat: Vec<TreeNodeData> = Vec::with_capacity(depth);
        let mut parent: Option<String> = None;
        for step in 0..depth {
            let id = format!("n{step}");
            flat.push(node(&id, parent.as_deref(), "2024-01-01T00:00:00.000Z"));
            parent = Some(id);
        }
        let tree = build_tree(flat);
        assert_eq!(tree.len(), 1);
        // The count itself walks a worklist: the test must never recurse
        // per level either.
        let mut seen = 0usize;
        let mut rest: Vec<&TreeNode> = tree.iter().collect();
        while let Some(current) = rest.pop() {
            seen += 1;
            rest.extend(current.children.iter());
        }
        assert_eq!(seen, depth);
        // Teardown drains through the worklist, never the call stack.
        drop(tree);
    }

    #[test]
    fn parent_cycle_never_reaches_the_tree() {
        // `a` and `b` point at each other, so neither is a root and both
        // stay out of the tree (TS keeps cycle members out of the roots
        // the same way); a clean sibling root survives.
        let flat = vec![
            node("a", Some("b"), "2024-01-01T00:00:00.000Z"),
            node("b", Some("a"), "2024-01-01T00:00:01.000Z"),
            node("r", None, "2024-01-01T00:00:02.000Z"),
        ];
        let tree = build_tree(flat);
        let root_ids: Vec<Option<&str>> = tree.iter().map(|n| n.id()).collect();
        assert_eq!(root_ids, vec![Some("r")]);
    }

    #[test]
    fn self_parent_entry_is_a_root() {
        // TS treats `parentId === entry.id` as no parent: the entry is a
        // root, never its own child.
        let flat = vec![
            node("s", Some("s"), "2024-01-01T00:00:00.000Z"),
            node("c", Some("s"), "2024-01-01T00:00:01.000Z"),
        ];
        let tree = build_tree(flat);
        let root_ids: Vec<Option<&str>> = tree.iter().map(|n| n.id()).collect();
        assert_eq!(root_ids, vec![Some("s")]);
        let child_ids: Vec<Option<&str>> = tree[0].children.iter().map(|n| n.id()).collect();
        assert_eq!(child_ids, vec![Some("c")]);
    }

    #[test]
    fn parses_wire_flat_nodes() {
        let data = serde_json::json!({
            "flatNodes": [{
                "entry": {
                    "type": "custom",
                    "id": "c1",
                    "parentId": null,
                    "timestamp": "2024-01-01T00:00:00.000Z",
                    "customType": "x"
                },
                "label": "mark",
                "labelTimestamp": "2024-01-02T00:00:00.000Z"
            }],
            "leafId": "c1"
        });
        let flat = parse_flat_nodes(&data);
        assert_eq!(flat.len(), 1);
        assert_eq!(flat[0].entry.id(), Some("c1"));
        assert_eq!(flat[0].label.as_deref(), Some("mark"));
    }
}
