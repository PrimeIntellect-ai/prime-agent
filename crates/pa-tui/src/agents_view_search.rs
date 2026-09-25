//! The agents-view session search: a picker over the session's identity
//! fields — the display NAME (primary), the durable session ID, and the
//! CWD. The TS corpus fields — the first message, the transcript text,
//! file paths — never match (a deliberate divergence
//! from TS `session-view-search.ts`, which joined them; the query
//! language stays TS-shaped).
//!
//! Matching follows the session/command-picker standard (VS Code
//! quick-open `fuzzyScorer.ts` + `filters.ts`; Zed's project switcher;
//! tmux choose-tree): tiered and ranked — identity paste > name exact >
//! name prefix > name substring > name fuzzy (the TS subsequence scorer
//! with its strict ceiling) > id prefix/substring > cwd basename/path —
//! with recency as the tiebreaker. Every token must match some target,
//! and a record's rank follows its WORST token's tier (a multi-token
//! search never trades one token's weak tier away for another's strong
//! one); within a tier, lower quality ranks first.

use crate::fuzzy::fuzzy_match;

/// The strict fuzzy ceiling above which a token counts as unmatched (TS
/// `STRICT_FUZZY_MAX_TOKEN_SCORE`).
const STRICT_FUZZY_MAX_TOKEN_SCORE: f64 = 25.0;

/// One record's match targets, in rank order (lower tier ranks first).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionSearchText {
    /// The session display name (daemon `sessionName`, saved `name`).
    pub name: String,
    /// The durable session id (daemon `sessionId`, saved `id`).
    pub id: String,
    /// The session working directory.
    pub cwd: String,
}

impl SessionSearchText {
    /// The regex-mode corpus: the same restricted fields, joined.
    fn corpus(&self) -> String {
        [self.name.as_str(), self.id.as_str(), self.cwd.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// One parsed search query (TS `ParsedSearchQuery`): `re:` enters regex
/// mode; otherwise whitespace tokens with `"quoted phrase"` support.
pub struct ParsedSearchQuery {
    regex: Option<fancy_regex::Regex>,
    tokens: Vec<SearchToken>,
    /// A query that cannot match anything (an invalid `re:` pattern).
    matches_never: bool,
}

enum SearchToken {
    Fuzzy(String),
    Phrase(String),
}

/// The `re:` backtrack budget. `fancy-regex` keeps JS-shaped features
/// (lookarounds, backreferences) by backtracking, which has no
/// worst-case time bound; the search runs synchronously on the TUI
/// thread for every record on every keystroke, so one `find` is bounded
/// to this many backtracking attempts. A pattern that needs more fails
/// the find, and `score_search` treats the record as unmatched.
const REGEX_BACKTRACK_LIMIT: usize = 10_000;

/// Parse a query; invalid `re:` patterns parse to no matches.
pub fn parse_search_query(query: &str) -> ParsedSearchQuery {
    let trimmed = query.trim();
    if let Some(pattern) = trimmed.strip_prefix("re:") {
        let pattern = pattern.trim();
        if pattern.is_empty() {
            return ParsedSearchQuery {
                regex: None,
                tokens: Vec::new(),
                matches_never: true,
            };
        }
        let built = fancy_regex::RegexBuilder::new(&format!("(?i){pattern}"))
            .backtrack_limit(REGEX_BACKTRACK_LIMIT)
            .build();
        let matches_never = match built {
            Ok(regex) => {
                return ParsedSearchQuery {
                    regex: Some(regex),
                    tokens: Vec::new(),
                    matches_never: false,
                }
            }
            Err(_) => true,
        };
        return ParsedSearchQuery {
            regex: None,
            tokens: Vec::new(),
            matches_never,
        };
    }
    ParsedSearchQuery {
        regex: None,
        tokens: tokenize(trimmed),
        matches_never: false,
    }
}

fn tokenize(trimmed: &str) -> Vec<SearchToken> {
    let mut tokens = Vec::new();
    let mut buffer = String::new();
    let mut in_quote = false;
    for ch in trimmed.chars() {
        if ch == '"' {
            if in_quote {
                push_token(&mut tokens, &mut buffer, SearchToken::Phrase);
            } else {
                push_token(&mut tokens, &mut buffer, SearchToken::Fuzzy);
            }
            in_quote = !in_quote;
            continue;
        }
        if !in_quote && ch.is_whitespace() {
            push_token(&mut tokens, &mut buffer, SearchToken::Fuzzy);
            continue;
        }
        buffer.push(ch);
    }
    if in_quote {
        // Unbalanced quotes fall back to plain whitespace tokenization.
        return trimmed
            .split_whitespace()
            .map(|token| SearchToken::Fuzzy(token.to_string()))
            .collect();
    }
    // Whatever is left in the buffer belongs to the last quote state.
    let kind = if in_quote {
        SearchToken::Phrase
    } else {
        SearchToken::Fuzzy
    };
    push_token(&mut tokens, &mut buffer, kind);
    tokens
}

fn push_token(tokens: &mut Vec<SearchToken>, buffer: &mut String, kind: fn(String) -> SearchToken) {
    let value = buffer.trim().to_string();
    buffer.clear();
    if !value.is_empty() {
        tokens.push(kind(value));
    }
}

/// One token's match: the tier it reached (lower ranks first — the
/// documented tier ladder) and its within-tier quality (lower ranks
/// better). `score_search` bounds the quality aggregate inside one tier
/// stride, so quality can never reorder records across tiers.
struct TokenMatch {
    tier: f64,
    quality: f64,
}

/// Score one record's targets against the query: `Some(score)` when the
/// query matches (lower is better — the `fuzzy_match` convention), `None`
/// otherwise. Every token must match at least one target (VS Code
/// `doScoreItemFuzzyMultiple`: "we require all queries to match"), and a
/// record's rank follows its WORST token's tier: the quality sums are
/// clamped inside one tier stride before the tier offset is added, so no
/// within-tier difference — however long the name or however sprawling
/// the fuzzy match — can cross a tier boundary.
pub fn score_search(targets: &SessionSearchText, query: &ParsedSearchQuery) -> Option<f64> {
    if query.matches_never {
        return None;
    }
    if let Some(regex) = &query.regex {
        let corpus = targets.corpus();
        if corpus.is_empty() {
            return None;
        }
        // A find that blows its backtrack budget fails here (see
        // `REGEX_BACKTRACK_LIMIT`): the record just does not match.
        return regex
            .find(&corpus)
            .ok()
            .flatten()
            .map(|found| found.start() as f64 * 0.1);
    }
    if query.tokens.is_empty() {
        return Some(0.0);
    }
    let mut worst_tier = 0.0f64;
    let mut quality_total = 0.0f64;
    for token in &query.tokens {
        let matched = match token {
            SearchToken::Phrase(value) => contiguous_token_score(value, targets)?,
            SearchToken::Fuzzy(value) => token_score(value, targets)?,
        };
        worst_tier = worst_tier.max(matched.tier);
        quality_total += matched.quality;
    }
    let quality = quality_total.clamp(0.0, TIER_STRIDE - 1.0);
    Some(worst_tier * TIER_STRIDE + quality)
}

/// The tier stride: the worst token's tier decides a record's rank before
/// any quality does, and `score_search` clamps the summed quality inside
/// one stride so it can never cross a tier boundary.
const TIER_STRIDE: f64 = 100_000.0;

/// One fuzzy token: the best tier it reaches across the targets (TS kept
/// the contiguous-first-then-fuzzy order; this generalizes it per field).
fn token_score(token: &str, targets: &SessionSearchText) -> Option<TokenMatch> {
    contiguous_token_score(token, targets).or_else(|| {
        let score = fuzzy_match(token, &targets.name)?;
        (score <= STRICT_FUZZY_MAX_TOKEN_SCORE).then_some(TokenMatch {
            tier: 4.0,
            quality: score,
        })
    })
}

/// One contiguous token (or the contiguous phase of a fuzzy token). The
/// tiers mirror VS Code quick-open scoring: the identity match is highest
/// (`PATH_IDENTITY_SCORE` — a pasted full id is unambiguous), then the
/// name ranks exact > prefix > substring, then the id prefix and
/// substring (paste-a-fragment targeting), then the CWD basename and
/// full path.
fn contiguous_token_score(token: &str, targets: &SessionSearchText) -> Option<TokenMatch> {
    let needle = normalize(token);
    if needle.is_empty() {
        return Some(TokenMatch {
            tier: 0.0,
            quality: 0.0,
        });
    }
    if needle == normalize(&targets.id) {
        return Some(TokenMatch {
            tier: 0.0,
            quality: 0.0,
        });
    }
    if let Some(name) = label_score(&needle, &targets.name) {
        return Some(name);
    }
    // Targets normalize like the needle (TS lowercased the whole corpus):
    // ids and paths match case-insensitively.
    if let Some(found) = normalize(&targets.id).find(&needle) {
        let tier = if found == 0 { 5.0 } else { 6.0 };
        return Some(TokenMatch {
            tier,
            quality: found as f64,
        });
    }
    if let Some(found) = normalize(&cwd_basename(&targets.cwd)).find(&needle) {
        return Some(TokenMatch {
            tier: 7.0,
            quality: found as f64,
        });
    }
    normalize(&targets.cwd)
        .find(&needle)
        .map(|found| TokenMatch {
            tier: 8.0,
            quality: found as f64,
        })
}

/// The name tiers: exact, prefix (shorter labels win, VS Code
/// `prefixLengthBoost`), then substring (earlier wins).
fn label_score(needle: &str, name: &str) -> Option<TokenMatch> {
    let name = normalize(name);
    if name.is_empty() {
        return None;
    }
    if name == needle {
        return Some(TokenMatch {
            tier: 1.0,
            quality: 0.0,
        });
    }
    if name.strip_prefix(needle).is_some() {
        return Some(TokenMatch {
            tier: 2.0,
            quality: (name.chars().count() - needle.chars().count()) as f64,
        });
    }
    name.find(needle).map(|found| TokenMatch {
        tier: 3.0,
        quality: found as f64,
    })
}

/// Lowercase and collapse whitespace (TS `normalizeWhitespaceLower`).
fn normalize(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The CWD's last path segment (`Path::file_name`), the directory label.
fn cwd_basename(cwd: &str) -> String {
    std::path::Path::new(cwd)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets() -> SessionSearchText {
        SessionSearchText {
            // One word: tier comparisons below stay single-token queries.
            name: "gatewayworker".to_string(),
            id: "01a0b6b3-2e8d-71ab-b1c2-2a7db1bf8077".to_string(),
            cwd: "/Users/kevin/pi/prime-agent".to_string(),
        }
    }

    fn score(query: &str) -> Option<f64> {
        score_search(&targets(), &parse_search_query(query))
    }

    #[test]
    fn name_exact_outranks_prefix_outranks_substring_outranks_fuzzy() {
        // Single-token queries: a whitespace query tokenizes and sums.
        let exact = score("gatewayworker").expect("exact name matches");
        let prefix = score("gatewaywork").expect("name prefix matches");
        let substring = score("tewaywor").expect("name substring matches");
        let fuzzy = score("gtwwr").expect("name fuzzy matches");
        assert!(exact < prefix, "exact {exact} < prefix {prefix}");
        assert!(
            prefix < substring,
            "prefix {prefix} < substring {substring}"
        );
        assert!(substring < fuzzy, "substring {substring} < fuzzy {fuzzy}");
    }

    #[test]
    fn shorter_prefix_wins() {
        let short = score_search(
            &SessionSearchText {
                name: "run books".to_string(),
                ..targets()
            },
            &parse_search_query("run"),
        );
        let long = score_search(
            &SessionSearchText {
                name: "runway cleanup crew".to_string(),
                ..targets()
            },
            &parse_search_query("run"),
        );
        let (short, long) = (short.expect("matches"), long.expect("matches"));
        assert!(short < long, "shorter label {short} < longer {long}");
    }

    #[test]
    fn the_session_id_targets_by_paste_prefix_and_fragment() {
        assert!(score("01a0b6b3").is_some(), "pasted uuid prefix matches");
        // The name is primary: a name fuzzy match outranks a bare id
        // fragment; only the identity paste outranks the name.
        let fragment = score("b1c2").expect("middle fragment matches");
        let name_fuzzy = score("gtwy").expect("name fuzzy matches");
        assert!(
            name_fuzzy < fragment,
            "name fuzzy {name_fuzzy} outranks id fragment {fragment}"
        );
        let identity = score("01a0b6b3-2e8d-71ab-b1c2-2a7db1bf8077").expect("full id matches");
        let name_exact = score("gateway worker").expect("exact name matches");
        assert!(
            identity < name_exact,
            "the pasted identity {identity} outranks the name exact {name_exact}"
        );
    }

    #[test]
    fn the_cwd_targets_basename_first() {
        assert!(score("prime-agent").is_some(), "cwd basename matches");
        assert!(score("kevin/pi").is_some(), "cwd path fragments match");
    }

    #[test]
    fn transcript_and_roster_fields_never_match() {
        // The corpus is name + id + cwd only: first messages, transcript
        // text, and session paths have no tier to hit.
        for query in ["backoff", "deploy", "sessions", "jsonl"] {
            assert!(
                score(query).is_none(),
                "{query:?} matches nothing in the restricted corpus"
            );
        }
    }

    #[test]
    fn every_token_must_match_and_phrases_stay_contiguous() {
        let both = score("gatewaywork 01a0");
        assert!(both.is_some(), "tokens may match different targets");
        assert!(
            score("gatewaywork zebra").is_none(),
            "all tokens must match"
        );
        let phrase = parse_search_query(r#""gatewaywork" 01a0"#);
        assert!(score_search(&targets(), &phrase).is_some(), "phrases match");
        let split_phrase = parse_search_query(r#""workgateway""#);
        assert!(
            score_search(&targets(), &split_phrase).is_none(),
            "phrases are contiguous substrings, not fuzzy"
        );
    }

    #[test]
    fn regex_mode_searches_the_same_restricted_corpus() {
        let hit = parse_search_query("re:gateway.*worker");
        assert!(score_search(&targets(), &hit).is_some());
        let transcript_only = parse_search_query("re:backoff");
        assert!(score_search(&targets(), &transcript_only).is_none());
        let invalid = parse_search_query("re:[");
        assert!(score_search(&targets(), &invalid).is_none());
    }

    #[test]
    fn an_empty_query_matches_everything_at_zero() {
        assert_eq!(score(""), Some(0.0));
    }

    #[test]
    fn fuzzy_keeps_the_strict_ceiling() {
        // A sprawling subsequence over a long name scores past the strict
        // ceiling and rejects (TS `STRICT_FUZZY_MAX_TOKEN_SCORE`).
        let sprawled = SessionSearchText {
            name: "primary agent session worker running in the forest temple of doom".to_string(),
            ..targets()
        };
        assert!(
            score_search(&sprawled, &parse_search_query("podm")).is_none(),
            "weak sprawling fuzzy matches reject"
        );
        // A compact subsequence still reaches the fuzzy tier.
        assert!(
            score_search(&sprawled, &parse_search_query("prm")).is_some(),
            "compact fuzzy matches stay"
        );
    }

    #[test]
    fn the_worst_token_tier_decides_multi_token_ranking() {
        // The same two-token query against two records: one lands both
        // tokens on the name (worst tier 3), the other pastes the id for
        // one token (tier 0) but only fuzzy-matches the other (tier 4).
        // Summing per-token scores would rank the id paste first; the
        // record's rank follows its WORST token, so the all-name record
        // wins.
        let strong = SessionSearchText {
            name: "gw x 01a0b6b3".to_string(),
            id: "ffff0000".to_string(),
            cwd: "/home/u/ops".to_string(),
        };
        let weak = SessionSearchText {
            name: "gateway worker".to_string(),
            id: "01a0b6b3".to_string(),
            cwd: "/home/u/ops".to_string(),
        };
        let parsed = parse_search_query("01a0b6b3 gw");
        let strong_score = score_search(&strong, &parsed).expect("the name record matches");
        let weak_score = score_search(&weak, &parsed).expect("the id-paste record matches");
        assert!(
            strong_score < weak_score,
            "the worst token's tier decides: {strong_score} < {weak_score}"
        );
    }

    #[test]
    fn long_fuzzy_hits_stay_inside_their_tier() {
        // A sprawling consecutive fuzzy match over a long name scores far
        // below zero; the quality term is clamped inside one tier stride,
        // so the fuzzy tier can never cross into the name-exact or
        // identity ranges.
        let query = parse_search_query(&format!("{}q", "x".repeat(500)));
        let exact = SessionSearchText {
            name: format!("{}q", "x".repeat(500)),
            ..targets()
        };
        let sprawl = SessionSearchText {
            name: format!("{}{}zq", "y".repeat(10), "x".repeat(500)),
            ..targets()
        };
        let exact_score = score_search(&exact, &query).expect("the exact name matches");
        let sprawl_score = score_search(&sprawl, &query).expect("the sprawling fuzzy match");
        assert!(
            (TIER_STRIDE..4.0 * TIER_STRIDE).contains(&exact_score),
            "the name-exact tier stays under the fuzzy tier: {exact_score}"
        );
        assert!(
            sprawl_score >= 4.0 * TIER_STRIDE,
            "the sprawling fuzzy match stays inside tier 4: {sprawl_score}"
        );
        assert!(exact_score < sprawl_score);
    }

    #[test]
    fn pathological_re_patterns_stop_at_the_backtrack_budget() {
        // A catastrophic-backtracking pattern over a near-miss corpus
        // stops at the budget and simply does not match — the keystroke
        // rebuild can never stall on it.
        let near_miss = SessionSearchText {
            name: format!("{}b", "a".repeat(40)),
            id: "fff-fff".to_string(),
            cwd: "/tmp".to_string(),
        };
        let parsed = parse_search_query("re:(a+)+$");
        assert!(
            score_search(&near_miss, &parsed).is_none(),
            "a blown backtrack budget matches nothing"
        );
        // The budget does not narrow the feature set: lookarounds still
        // run through the fancy engine and match.
        let lookahead = parse_search_query("re:gateway(?=worker)");
        assert!(score_search(&targets(), &lookahead).is_some());
    }
}
