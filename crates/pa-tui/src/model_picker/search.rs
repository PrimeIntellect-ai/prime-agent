use pa_types::ai::Model;
/// Match quality for the scored search (TS `ModelSearchMatchQuality`;
/// lower sorts first).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum MatchQuality {
    ExactShortId,
    ExactFullId,
    PrefixOrToken,
    Fuzzy,
}

/// One scored search match.
pub(super) struct SearchMatch {
    pub(super) quality: MatchQuality,
    pub(super) score: f64,
}

/// TS `normalizeModelSearchText`: lowercase, drop separator runs.
fn normalize_search_text(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t' | '-' | '_' | '.' | ':' | '/'))
        .collect()
}

/// The search fields of one item (TS `getModelSearchFields`).
fn search_fields(model: &Model) -> (String, Vec<String>, Vec<String>) {
    let short_id = model.id.rsplit('/').next().unwrap_or(&model.id).to_string();
    let full_ids = vec![model.id.clone(), format!("{}/{}", model.provider, model.id)];
    let mut all = vec![short_id.clone()];
    all.extend(full_ids.iter().cloned());
    all.push(model.name.clone());
    all.push(model.provider.clone());
    (short_id, full_ids, all)
}

/// TS `getBestFuzzyScore`: every token must fuzzy-match some field; the
/// score is the sum of each token's best field.
fn best_fuzzy_score(query_tokens: &[String], fields: &[String]) -> Option<f64> {
    let mut total = 0.0;
    for token in query_tokens {
        // Every token must match some field; the score is each token's best.
        let mut best: Option<f64> = None;
        for field in fields {
            if let Some(score) = crate::fuzzy::fuzzy_match(token, field) {
                best = Some(match best {
                    Some(current) if current <= score => current,
                    _ => score,
                });
            }
        }
        let best = best?;
        total += best;
    }
    Some(total)
}

/// TS `scoreModelSearch`.
pub(super) fn score_model_search(model: &Model, query: &str) -> Option<SearchMatch> {
    let query_tokens: Vec<String> = query.split_whitespace().map(str::to_string).collect();
    let normalized_query = normalize_search_text(query);
    let normalized_tokens: Vec<String> = query_tokens
        .iter()
        .map(|token| normalize_search_text(token))
        .filter(|token| !token.is_empty())
        .collect();
    if normalized_query.is_empty() || normalized_tokens.is_empty() {
        return None;
    }

    let (short_id, full_ids, all) = search_fields(model);
    if normalize_search_text(&short_id) == normalized_query {
        return Some(SearchMatch {
            quality: MatchQuality::ExactShortId,
            score: 0.0,
        });
    }
    if full_ids
        .iter()
        .any(|field| normalize_search_text(field) == normalized_query)
    {
        return Some(SearchMatch {
            quality: MatchQuality::ExactFullId,
            score: 0.0,
        });
    }

    let normalized_fields: Vec<String> = all
        .iter()
        .map(|field| normalize_search_text(field))
        .collect();
    let field_tokens: Vec<String> = all
        .iter()
        .flat_map(|field| field.split([' ', '/', '_', '-']).map(normalize_search_text))
        .filter(|token| !token.is_empty())
        .collect();
    let fuzzy_score = best_fuzzy_score(&normalized_tokens, &normalized_fields);
    let is_prefix_or_token = normalized_tokens.iter().all(|token| {
        normalized_fields
            .iter()
            .any(|field| field.starts_with(token))
            || field_tokens.iter().any(|field| field.starts_with(token))
    });
    match fuzzy_score {
        Some(score) if is_prefix_or_token => Some(SearchMatch {
            quality: MatchQuality::PrefixOrToken,
            score,
        }),
        Some(score) => Some(SearchMatch {
            quality: MatchQuality::Fuzzy,
            score,
        }),
        None => None,
    }
}
