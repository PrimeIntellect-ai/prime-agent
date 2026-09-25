//! Faithful port of jsdiff v9 `diffLines` (Myers O(ND) with the
//! diagonal-bounds optimization), as vendored by
//! `packages/coding-agent/src/core/tools/edit-diff.ts` (`Diff.diffLines`).
//! Split from the edit-diff module for module-size hygiene. Diffs generated
//! here must match the TypeScript product byte for byte; the golden corpus
//! pins them.

/// Tokenize a string the way jsdiff's `diffLines` does: split keeping `\n` /
/// `\r\n` separators, drop a trailing empty element, and merge each newline
/// into the preceding line token.
fn jsdiff_line_tokenize(value: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' {
            parts.push(std::mem::take(&mut current));
            parts.push("\n".to_string());
        } else if c == '\r' && chars.peek() == Some(&'\n') {
            chars.next();
            parts.push(std::mem::take(&mut current));
            parts.push("\r\n".to_string());
        } else {
            current.push(c);
        }
    }
    parts.push(current);
    // Ignore the final empty token that occurs if the string ends with a newline.
    if parts.last().is_some_and(String::is_empty) {
        parts.pop();
    }
    // Merge the content and line separators into single tokens.
    let mut ret_lines: Vec<String> = Vec::new();
    for (i, part) in parts.into_iter().enumerate() {
        if i % 2 == 1 {
            if let Some(last) = ret_lines.last_mut() {
                last.push_str(&part);
            }
        } else {
            ret_lines.push(part);
        }
    }
    ret_lines
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DiffPart {
    pub value: String,
    pub added: bool,
    pub removed: bool,
    pub count: usize,
}

#[derive(Debug, Clone, Copy)]
struct Component {
    count: usize,
    added: bool,
    removed: bool,
    previous: Option<usize>,
}

#[derive(Debug, Clone, Copy)]
struct PathEntry {
    old_pos: isize,
    last_component: Option<usize>,
}

struct DiffEngine<'a> {
    old_tokens: &'a [String],
    new_tokens: &'a [String],
    components: Vec<Component>,
}

impl<'a> DiffEngine<'a> {
    fn equals(&self, left: &str, right: &str) -> bool {
        left == right
    }

    fn add_to_path(
        &mut self,
        path: &PathEntry,
        added: bool,
        removed: bool,
        old_pos_inc: isize,
    ) -> PathEntry {
        if let Some(last_idx) = path.last_component {
            let last = self.components[last_idx];
            if last.added == added && last.removed == removed {
                let idx = self.components.len();
                self.components.push(Component {
                    count: last.count + 1,
                    added,
                    removed,
                    previous: last.previous,
                });
                return PathEntry {
                    old_pos: path.old_pos + old_pos_inc,
                    last_component: Some(idx),
                };
            }
        }
        let idx = self.components.len();
        self.components.push(Component {
            count: 1,
            added,
            removed,
            previous: path.last_component,
        });
        PathEntry {
            old_pos: path.old_pos + old_pos_inc,
            last_component: Some(idx),
        }
    }

    fn extract_common(&mut self, base_path: &mut PathEntry, diagonal_path: isize) -> isize {
        let new_len = self.new_tokens.len() as isize;
        let old_len = self.old_tokens.len() as isize;
        let mut old_pos = base_path.old_pos;
        let mut new_pos = old_pos - diagonal_path;
        let mut common_count = 0usize;
        while new_pos + 1 < new_len
            && old_pos + 1 < old_len
            && self.equals(
                &self.old_tokens[(old_pos + 1) as usize],
                &self.new_tokens[(new_pos + 1) as usize],
            )
        {
            new_pos += 1;
            old_pos += 1;
            common_count += 1;
        }
        if common_count > 0 {
            let idx = self.components.len();
            self.components.push(Component {
                count: common_count,
                added: false,
                removed: false,
                previous: base_path.last_component,
            });
            base_path.last_component = Some(idx);
        }
        base_path.old_pos = old_pos;
        new_pos
    }

    fn build_values(&mut self, last_component: Option<usize>) -> Vec<DiffPart> {
        // Convert the linked list of components to an ordered array.
        let mut component_indices: Vec<usize> = Vec::new();
        let mut next = last_component;
        while let Some(idx) = next {
            component_indices.push(idx);
            next = self.components[idx].previous;
        }
        component_indices.reverse();

        let mut parts: Vec<DiffPart> = Vec::with_capacity(component_indices.len());
        let mut new_pos = 0usize;
        let mut old_pos = 0usize;
        for idx in component_indices {
            let component = self.components[idx];
            if component.removed {
                let slice: Vec<String> =
                    self.old_tokens[old_pos..(old_pos + component.count)].to_vec();
                let value = slice.join("");
                old_pos += component.count;
                parts.push(DiffPart {
                    value,
                    added: component.added,
                    removed: component.removed,
                    count: component.count,
                });
            } else {
                let slice: Vec<String> =
                    self.new_tokens[new_pos..(new_pos + component.count)].to_vec();
                let value = slice.join("");
                new_pos += component.count;
                if !component.added {
                    old_pos += component.count;
                }
                parts.push(DiffPart {
                    value,
                    added: component.added,
                    removed: component.removed,
                    count: component.count,
                });
            }
        }
        parts
    }

    /// Port of jsdiff `Diff.diffWithOptionsObj` (no options, sync).
    fn run(&mut self) -> Vec<DiffPart> {
        let new_len = self.new_tokens.len() as isize;
        let old_len = self.old_tokens.len() as isize;
        let mut edit_length: isize = 1;
        let max_edit_length = new_len + old_len;

        // jsdiff stores best-path entries in a JS array/object indexed by the
        // (possibly negative) diagonal path; emulate that with a map so
        // negative indices work exactly like in JavaScript.
        let mut best_path: std::collections::HashMap<isize, PathEntry> =
            std::collections::HashMap::new();
        best_path.insert(
            0,
            PathEntry {
                old_pos: -1,
                last_component: None,
            },
        );
        // Seed editLength = 0, i.e. the content starts with the same values.
        let mut base = *best_path.get(&0).expect("seeded");
        let mut new_pos = self.extract_common(&mut base, 0);
        best_path.insert(0, base);
        if base.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
            let last = base.last_component;
            return self.build_values(last);
        }

        let mut min_diagonal_to_consider: isize = isize::MIN;
        let mut max_diagonal_to_consider: isize = isize::MAX;

        while edit_length <= max_edit_length {
            let mut done: Option<Vec<DiffPart>> = None;
            let diag_start = min_diagonal_to_consider.max(-edit_length);
            let diag_end = max_diagonal_to_consider.min(edit_length);

            let mut diagonal_path = diag_start;
            while diagonal_path <= diag_end {
                let remove_path = best_path.get(&(diagonal_path - 1)).copied();
                let add_path = best_path.get(&(diagonal_path + 1)).copied();

                let mut can_add = false;
                if let Some(add) = add_path {
                    let add_path_new_pos = add.old_pos - diagonal_path;
                    can_add = 0 <= add_path_new_pos && add_path_new_pos < new_len;
                }
                let can_remove = remove_path.is_some_and(|remove| remove.old_pos + 1 < old_len);

                if !can_add && !can_remove {
                    // If this path is a terminal then prune.
                    best_path.remove(&diagonal_path);
                    diagonal_path += 2;
                    continue;
                }

                let mut base_path = if !can_remove
                    || (can_add
                        && remove_path.is_some_and(|remove| {
                            add_path.is_some_and(|add| remove.old_pos < add.old_pos)
                        })) {
                    self.add_to_path(&add_path.unwrap(), true, false, 0)
                } else {
                    self.add_to_path(&remove_path.unwrap(), false, true, 1)
                };

                new_pos = self.extract_common(&mut base_path, diagonal_path);
                if base_path.old_pos + 1 >= old_len && new_pos + 1 >= new_len {
                    // If we have hit the end of both strings, then we are done.
                    done = Some(self.build_values(base_path.last_component));
                    break;
                } else {
                    best_path.insert(diagonal_path, base_path);
                    if base_path.old_pos + 1 >= old_len {
                        max_diagonal_to_consider = max_diagonal_to_consider.min(diagonal_path - 1);
                    }
                    if new_pos + 1 >= new_len {
                        min_diagonal_to_consider = min_diagonal_to_consider.max(diagonal_path + 1);
                    }
                }
                diagonal_path += 2;
            }

            if let Some(parts) = done {
                return parts;
            }
            edit_length += 1;
        }

        // The loop always terminates via the done path for well-formed input
        // (maxEditLength = newLen + oldLen bounds the Myers search), but the
        // seed is kept as a safe terminal answer.
        self.build_values(
            best_path
                .get(&(-max_edit_length))
                .and_then(|p| p.last_component),
        )
    }
}

/// jsdiff `diffLines` with default options (case-sensitive, newlines merged
/// into line tokens). Returns the change parts in order.
pub(crate) fn diff_lines(old_str: &str, new_str: &str) -> Vec<DiffPart> {
    let mut old_tokens = jsdiff_line_tokenize(old_str);
    let mut new_tokens = jsdiff_line_tokenize(new_str);
    // removeEmpty: drop empty tokens.
    old_tokens.retain(|t| !t.is_empty());
    new_tokens.retain(|t| !t.is_empty());

    let mut engine = DiffEngine {
        old_tokens: &old_tokens,
        new_tokens: &new_tokens,
        components: Vec::new(),
    };
    engine.run()
}

// ---------------------------------------------------------------------------
// Diff string generation
// ---------------------------------------------------------------------------
