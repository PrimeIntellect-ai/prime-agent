//! Session-tree node model: the flat `get_session_tree` wire nodes parsed
//! into typed entries, and the parent/child tree the `/tree` view navigates
//! (TS `buildSessionTreeFromFlatNodes` + `SessionTreeFlatNode`).

use std::collections::HashMap;

use pa_types::session::FileEntry;
use serde_json::{Map, Value};

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
#[derive(Debug, Clone)]
pub struct TreeNode {
    pub data: TreeNodeData,
    pub children: Vec<TreeNode>,
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

/// Build the nested tree from flat nodes (TS
/// `buildSessionTreeFromFlatNodes`): parentless entries (or entries whose
/// parent is missing) become roots; sibling order is by timestamp, oldest
/// first (the TS `getTree` ordering).
pub fn build_tree(flat: Vec<TreeNodeData>) -> Vec<TreeNode> {
    fn build(
        slots: &mut Vec<Option<TreeNode>>,
        indices: &[usize],
        child_indices: &[Vec<usize>],
    ) -> Vec<TreeNode> {
        indices
            .iter()
            .map(|index| {
                let mut node = slots[*index].take().expect("node present");
                node.children = build(slots, &child_indices[*index], child_indices);
                node.children
                    .sort_by(|a, b| a.timestamp().cmp(b.timestamp()));
                node
            })
            .collect()
    }
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
    build(&mut slots, &roots, &child_indices)
}

#[cfg(test)]
mod tests {
    use super::*;

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
