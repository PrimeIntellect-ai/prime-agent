/// The version run parsed from a model id: every digit group of the id,
/// in order, kept as text so components longer than `u64` still compare
/// by numeric value. Covers the catalog's id formats — hyphen-joined
/// (`claude-opus-5-5` -> `["5", "5"]`), dot-joined (`glm-5.3` ->
/// `["5", "3"]`), letter-glued (`qwen3`, `m2.7`, `glm-5p2` -> `["5", "2"]`),
/// dated snapshots (`claude-opus-4-5-20251101` -> `["4", "5", "20251101"]`),
/// and namespaced ids (`anthropic/claude-opus-4.7` -> `["4", "7"]`). Ids
/// without digits (`claude-opus-latest`) parse to an empty run.
pub(super) fn version_key(id: &str) -> Vec<String> {
    id.split(|character: char| !character.is_ascii_digit())
        .filter(|run| !run.is_empty())
        .map(str::to_string)
        .collect()
}

/// Version-descending order for the search sort's recency tier: higher
/// versions first, over an equal prefix the longer, more specific run
/// (the dated snapshot over its alias) first, ids without a version last.
/// Components compare by numeric value — leading zeros aside, digit
/// length first, then text — so no `u64` bound applies.
pub(super) fn version_desc(a: &[String], b: &[String]) -> std::cmp::Ordering {
    for (a_part, b_part) in a.iter().zip(b.iter()) {
        let a_part = a_part.trim_start_matches('0');
        let b_part = b_part.trim_start_matches('0');
        let order = match a_part.len().cmp(&b_part.len()) {
            std::cmp::Ordering::Equal => a_part.cmp(b_part),
            other => other,
        };
        if order != std::cmp::Ordering::Equal {
            return order.reverse();
        }
    }
    b.len().cmp(&a.len())
}

/// Numeric-aware string compare: digit runs compare by value, everything
/// else by characters (`localeCompare` with `numeric: true`).
pub(super) fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn split_run(text: &str) -> Option<(&str, bool)> {
        let first = text.chars().next()?;
        let is_digit = first.is_ascii_digit();
        let end = text
            .char_indices()
            .find(|(_, c)| c.is_ascii_digit() != is_digit)
            .map_or(text.len(), |(index, _)| index);
        Some((&text[..end], is_digit))
    }
    let mut a_rest = a;
    let mut b_rest = b;
    loop {
        match (split_run(a_rest), split_run(b_rest)) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some((a_run, a_digits)), Some((b_run, b_digits))) => {
                if a_digits && b_digits {
                    let a_trim = a_run.trim_start_matches('0');
                    let b_trim = b_run.trim_start_matches('0');
                    let order = match a_trim.len().cmp(&b_trim.len()) {
                        std::cmp::Ordering::Equal => a_trim.cmp(b_trim),
                        other => other,
                    };
                    if order != std::cmp::Ordering::Equal {
                        return order;
                    }
                } else {
                    let order = a_run.cmp(b_run);
                    if order != std::cmp::Ordering::Equal {
                        return order;
                    }
                }
                a_rest = &a_rest[a_run.len()..];
                b_rest = &b_rest[b_run.len()..];
            }
        }
    }
}
