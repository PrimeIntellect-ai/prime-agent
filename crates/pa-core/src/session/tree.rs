//! Session tree: branches, labels, and path queries over parsed entries.
//! Port of the tree/branch portion of core/session-manager.ts.

use std::collections::HashMap;

use pa_types::session::FileEntry;

/// Label assignment from `label` entries, keyed by target entry id.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTreeFlatNode {
    pub entry: usize,
    pub label: Option<String>,
    pub label_timestamp: Option<String>,
}

/// The session as a tree: children by parent id, roots are parentless.
#[derive(Debug, Default)]
pub struct SessionTree {
    /// Children indices by parent id (position in the file).
    pub children: HashMap<Option<String>, Vec<usize>>,
    /// The header position, if present.
    pub header: Option<usize>,
    /// Label state: latest `label` entry per target id.
    pub labels: HashMap<String, Option<String>>,
    /// Label timestamps keyed by target id.
    pub label_timestamps: HashMap<String, String>,
}

impl SessionTree {
    pub fn build(entries: &[FileEntry]) -> Self {
        let mut tree = SessionTree::default();
        for (index, entry) in entries.iter().enumerate() {
            if matches!(entry, FileEntry::Header { .. }) {
                tree.header = Some(index);
                continue;
            }
            let Some(_id) = entry.id() else {
                continue;
            };
            match entry {
                FileEntry::Label { payload, .. } => {
                    // Last label wins; an undefined label clears the name.
                    tree.labels
                        .insert(payload.target_id.clone(), payload.label.clone());
                    let timestamp = entry.timestamp();
                    if !timestamp.is_empty() {
                        tree.label_timestamps
                            .insert(payload.target_id.clone(), timestamp.to_string());
                    }
                }
                _ => {
                    let parent = entry.parent_id().map(str::to_string);
                    tree.children.entry(parent).or_default().push(index);
                }
            }
        }
        tree
    }

    /// The ancestor path (file order) from the root down to `leaf_id`.
    pub fn path_to(&self, entries: &[FileEntry], leaf_id: &str) -> Vec<usize> {
        let by_id: HashMap<&str, usize> = entries
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| entry.id().map(|id| (id, index)))
            .collect();
        let mut path = Vec::new();
        let mut current = by_id.get(leaf_id).copied();
        while let Some(index) = current {
            path.push(index);
            current = entries[index]
                .parent_id()
                .and_then(|parent_id| by_id.get(parent_id).copied());
        }
        path.reverse();
        path
    }

    /// The most recent leaf on the root path (the file's default leaf).
    pub fn default_leaf(&self, entries: &[FileEntry]) -> Option<String> {
        // The deepest rightmost parentless chain: entries whose parent is not
        // present in the file start new branches; the last entry overall is a
        // leaf on the current branch.
        entries
            .last()
            .and_then(|entry| entry.id().map(str::to_string))
    }
}

/// The latest label for a target entry id (None = no label entry).
pub fn get_label(tree: &SessionTree, target_id: &str) -> Option<Option<String>> {
    tree.labels.get(target_id).cloned()
}

#[cfg(test)]
mod tests {
    use super::super::parse_session_entries;
    use super::*;

    #[test]
    fn tree_paths_and_labels() {
        let content = r#"
{"type":"session","id":"s1","timestamp":"2024-01-01T00:00:00.000Z","cwd":"/w","version":3}
{"type":"custom","id":"a","parentId":null,"timestamp":"2024-01-01T00:00:01.000Z","customType":"x"}
{"type":"custom","id":"b","parentId":"a","timestamp":"2024-01-01T00:00:02.000Z","customType":"x"}
{"type":"custom","id":"c","parentId":"a","timestamp":"2024-01-01T00:00:03.000Z","customType":"x"}
{"type":"label","id":"l1","parentId":"c","timestamp":"2024-01-01T00:00:04.000Z","targetId":"b","label":"checkpoint"}
{"type":"label","id":"l2","parentId":"c","timestamp":"2024-01-01T00:00:05.000Z","targetId":"b"}
"#;
        let entries = parse_session_entries(content);
        let tree = SessionTree::build(&entries);
        // Branch roots: parentless entries (excluding the header).
        assert_eq!(
            tree.children
                .get(&Some("a".to_string()))
                .map(std::vec::Vec::len),
            Some(2)
        );
        // Path to c: a -> c.
        let path = tree.path_to(&entries, "c");
        let ids: Vec<&str> = path.iter().map(|&i| entries[i].id().unwrap()).collect();
        assert_eq!(ids, vec!["a", "c"]);
        // Label was set then cleared by the second label entry.
        assert_eq!(get_label(&tree, "b"), Some(None));
        assert_eq!(tree.default_leaf(&entries).as_deref(), Some("l2"));
    }
}
