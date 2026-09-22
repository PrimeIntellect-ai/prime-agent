//! Fuzzy matching for autocomplete (port of `packages/tui/src/fuzzy.ts`):
//! a query matches when all its characters appear in order; lower scores
//! rank better. Space-separated query tokens must all match.

/// One fuzzy match: `Some(score)` when the query matches (lower is better).
pub fn fuzzy_match(query: &str, text: &str) -> Option<f64> {
    let query_lower: Vec<char> = query.to_lowercase().chars().collect();
    let text_lower: Vec<char> = text.to_lowercase().chars().collect();
    let primary = match_query(&query_lower, &text_lower);
    if primary.is_some() {
        return primary;
    }
    // Letter/digit transpositions get a second chance (TS swaps the digit and
    // letter groups and retries with a small penalty).
    let swapped_query = swapped_groups(&query_lower)?;
    let swapped = match_query(&swapped_query, &text_lower)?;
    Some(swapped + 5.0)
}

/// The swapped query for `letters+digits` or `digits+letters` inputs.
fn swapped_groups(query_lower: &[char]) -> Option<Vec<char>> {
    let letters: String = query_lower
        .iter()
        .filter(|c| c.is_ascii_lowercase())
        .collect();
    let digits: String = query_lower.iter().filter(|c| c.is_ascii_digit()).collect();
    if letters.is_empty() || digits.is_empty() || letters.len() + digits.len() != query_lower.len()
    {
        return None;
    }
    // Letters-first input swaps to digits-first and vice versa.
    if query_lower[0].is_ascii_lowercase() {
        Some(format!("{digits}{letters}").chars().collect())
    } else {
        Some(format!("{letters}{digits}").chars().collect())
    }
}

/// Score one ordered-subsequence match (TS `matchQuery`). Consecutive
/// matches and word boundaries score better; gaps score worse.
fn match_query(query_lower: &[char], text_lower: &[char]) -> Option<f64> {
    if query_lower.is_empty() {
        return Some(0.0);
    }
    if query_lower.len() > text_lower.len() {
        return None;
    }
    let mut query_index = 0usize;
    let mut score = 0.0f64;
    let mut last_match_index: Option<usize> = None;
    let mut consecutive_matches = 0i32;
    for i in 0..text_lower.len() {
        if query_index < query_lower.len() && text_lower[i] == query_lower[query_index] {
            let is_word_boundary =
                i == 0 || matches!(text_lower[i - 1], ' ' | '\t' | '-' | '_' | '.' | '/' | ':');
            if last_match_index == Some(i.saturating_sub(1)) {
                consecutive_matches += 1;
                score -= (consecutive_matches * 5) as f64;
            } else {
                consecutive_matches = 0;
                if let Some(last) = last_match_index {
                    score += (i - last - 1) as f64 * 2.0;
                }
            }
            if is_word_boundary {
                score -= 10.0;
            }
            score += i as f64 * 0.1;
            last_match_index = Some(i);
            query_index += 1;
        }
    }
    if query_index < query_lower.len() {
        return None;
    }
    if query_lower == text_lower {
        score -= 100.0;
    }
    Some(score)
}

/// Filter items by fuzzy match quality against their text, best-first.
/// Space-separated query tokens must all match; ties keep input order.
pub fn fuzzy_filter<T: Clone>(items: &[T], query: &str, get_text: impl Fn(&T) -> String) -> Vec<T> {
    let tokens: Vec<String> = query
        .split_whitespace()
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .collect();
    if tokens.is_empty() {
        return items.to_vec();
    }
    let mut scored: Vec<(T, f64)> = Vec::new();
    for item in items {
        let text = get_text(item);
        let mut total = 0.0f64;
        let mut all_match = true;
        for token in &tokens {
            match fuzzy_match(token, &text) {
                Some(score) => total += score,
                None => {
                    all_match = false;
                    break;
                }
            }
        }
        if all_match {
            scored.push((item.clone(), total));
        }
    }
    scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().map(|(item, _)| item).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_subsequences_with_exact_ranked_first() {
        assert_eq!(fuzzy_match("", "anything"), Some(0.0));
        assert!(fuzzy_match("abc", "ab").is_none());
        assert!(fuzzy_match("mod", "model").is_some());
        let exact = fuzzy_match("model", "model").unwrap();
        let partial = fuzzy_match("mdl", "model").unwrap();
        assert!(
            exact < partial,
            "exact {exact} should outrank partial {partial}"
        );
    }

    #[test]
    fn swapped_digit_letter_groups_match() {
        // `compact2` style queries: letters+digits swapped retry.
        assert!(fuzzy_match("model1", "model1").is_some());
        assert!(fuzzy_match("m1", "1m-model").is_some());
    }

    #[test]
    fn filter_ranks_and_keeps_order() {
        let items = vec!["settings", "session", "model"];
        let out = fuzzy_filter(&items, "sess", |s| s.to_string());
        assert_eq!(out.first().copied(), Some("session"));
        // Ties keep input order (stable sort).
        let tied = fuzzy_filter(&items, "se", |s| s.to_string());
        assert_eq!(tied.first().copied(), Some("settings"));
        // No query: all items in order.
        assert_eq!(fuzzy_filter(&items, "", |s| s.to_string()), items);
        // Multi-token queries need every token to match.
        assert!(fuzzy_filter(&items, "se zz", |s| s.to_string()).is_empty());
    }

    #[test]
    fn filter_matches_aliases_in_search_text() {
        let items = vec![("effort", "effort thinking"), ("export", "export")];
        let out = fuzzy_filter(&items, "think", |(_, text)| text.to_string());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "effort");
    }
}
