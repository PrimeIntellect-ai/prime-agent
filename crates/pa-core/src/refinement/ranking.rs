//! Harness relevance ranking and prompt rendering. Port of the ranking half
//! of core/refinement/refinement.ts (query terms, scoring, digest formatting).

use std::collections::HashMap;

use sha2::{Digest, Sha256};

use super::{
    compact_harness_text, HarnessEntry, HarnessState, RefinementKind,
    DEFAULT_OVERVIEW_CONTENT_LIMIT, DEFAULT_OVERVIEW_ENTRY_LIMIT,
    DEFAULT_OVERVIEW_REFINEMENT_LIMIT, REFINEMENT_KINDS,
};

/// Term -> weight, built from task signal (goal, recent messages).
pub type HarnessQueryTerms = HashMap<String, f64>;

fn is_cjk(char: char) -> bool {
    matches!(char as u32,
        0x3040..=0x30ff
        | 0x3400..=0x4dbf
        | 0x4e00..=0x9fff
        | 0xf900..=0xfaff
        | 0xac00..=0xd7af
        | 0x20000..=0x2a6df
        | 0x2a700..=0x2b73f
        | 0x2b740..=0x2b81f
        | 0x2b820..=0x2ceaf
        | 0x2ceb0..=0x2ebef
        | 0x2ebf0..=0x2ee5f
        | 0x2f800..=0x2fa1f
        | 0x30000..=0x3134f
        | 0x31350..=0x323af
        | 0x323b0..=0x3347f)
}

/// Tokenize text into lowercase query terms: word runs of letters/digits/marks
/// (>= 4 chars), CJK runs as overlapping bigrams.
pub fn harness_query_terms(text: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    let mut run = String::new();
    let flush_run = |run: &mut String, terms: &mut Vec<String>| {
        if run.is_empty() {
            return;
        }
        // Split the run into CJK and non-CJK segments.
        let mut segment = String::new();
        let mut segment_is_cjk = is_cjk(run.chars().next().unwrap());
        for char in run.chars() {
            if is_cjk(char) == segment_is_cjk {
                segment.push(char);
            } else {
                push_segment(&segment, segment_is_cjk, terms);
                segment.clear();
                segment.push(char);
                segment_is_cjk = !segment_is_cjk;
            }
        }
        push_segment(&segment, segment_is_cjk, terms);
        run.clear();
    };
    for char in text.to_lowercase().chars() {
        if char.is_alphabetic() || char.is_numeric() || char.is_alphanumeric() {
            run.push(char);
        } else {
            flush_run(&mut run, &mut terms);
        }
    }
    flush_run(&mut run, &mut terms);
    // Distinct terms, order preserved.
    let mut seen: Vec<String> = Vec::new();
    terms.retain(|term| {
        if seen.contains(term) {
            false
        } else {
            seen.push(term.clone());
            true
        }
    });
    terms
}

fn push_segment(segment: &str, is_cjk_segment: bool, terms: &mut Vec<String>) {
    if segment.is_empty() {
        return;
    }
    if is_cjk_segment {
        let chars: Vec<char> = segment.chars().collect();
        if chars.len() == 1 {
            terms.push(segment.to_string());
        } else {
            for window in chars.windows(2) {
                terms.push(window.iter().collect());
            }
        }
    } else if segment.chars().count() >= 4 {
        terms.push(segment.to_string());
    }
}

/// Inverse document frequency per query term over the entries being ranked:
/// `ln(1 + documents / matches)`. A term present in every entry still weighs
/// `ln(2)`, while a term in one entry of N weighs `ln(1 + N)`, so rare
/// distinctive terms outrank ubiquitous ones. Terms matching no entry are
/// absent (they cannot score anything).
pub fn harness_query_term_idf(
    entries: &[HarnessEntry],
    terms: &HarnessQueryTerms,
) -> HarnessQueryTerms {
    let mut idf = HarnessQueryTerms::new();
    if terms.is_empty() {
        return idf;
    }
    let mut matches: HashMap<&str, usize> = HashMap::new();
    for entry in entries {
        let title = entry.title.to_lowercase();
        let content = entry.content.to_lowercase();
        let identifier = format!("{} {}", entry.path.to_lowercase(), entry.id.to_lowercase());
        for term in terms.keys() {
            if title.contains(term.as_str())
                || content.contains(term.as_str())
                || identifier.contains(term.as_str())
            {
                *matches.entry(term.as_str()).or_insert(0) += 1;
            }
        }
    }
    for (term, document_frequency) in matches {
        idf.insert(
            term.to_string(),
            (1.0 + entries.len() as f64 / document_frequency as f64).ln(),
        );
    }
    idf
}

/// Score one entry against query terms: weighted per-term overlap across
/// title/content/identifier fields (field coverage weighted, not repetition),
/// with each matched term's weight discounted by its document frequency in
/// the ranked corpus (`idf`; a missing map weights every term at 1).
pub fn score_harness_entry_for_query(
    entry: &HarnessEntry,
    terms: &HarnessQueryTerms,
    idf: Option<&HarnessQueryTerms>,
) -> f64 {
    if terms.is_empty() {
        return 0.0;
    }
    let title = entry.title.to_lowercase();
    let content = entry.content.to_lowercase();
    let identifier = format!("{} {}", entry.path.to_lowercase(), entry.id.to_lowercase());
    let mut score = 0.0;
    for (term, weight) in terms {
        let mut fields = 0;
        if title.contains(term.as_str()) {
            fields += 1;
        }
        if content.contains(term.as_str()) {
            fields += 1;
        }
        if identifier.contains(term.as_str()) {
            fields += 1;
        }
        if fields > 0 {
            let term_idf = idf
                .and_then(|map| map.get(term.as_str()).copied())
                .unwrap_or(1.0);
            score += weight * term_idf * (1.0 + (fields - 1) as f64 * 0.5);
        }
    }
    score
}

fn entry_sort_key(entry: &HarnessEntry) -> String {
    format!("{}\0{}\0{}", entry.path, entry.title, entry.id)
}

/// Options for prompt rendering.
#[derive(Debug, Default)]
pub struct HarnessStatePromptOptions {
    pub max_entries_per_kind: Option<usize>,
    pub max_refinements: Option<usize>,
    pub max_content_length: Option<usize>,
    pub include_ipython_examples: Option<bool>,
    pub include_shell_examples: bool,
    pub include_refine_examples: Option<bool>,
    pub query_terms: Option<HarnessQueryTerms>,
}

/// Render the harness state as the model-facing digest block. Strings must
/// stay byte-identical with the TS formatter.
pub fn format_harness_state_for_prompt(
    state: &HarnessState,
    options: &HarnessStatePromptOptions,
) -> String {
    let max_entries_per_kind = options
        .max_entries_per_kind
        .unwrap_or(DEFAULT_OVERVIEW_ENTRY_LIMIT);
    let max_refinements = options
        .max_refinements
        .unwrap_or(DEFAULT_OVERVIEW_REFINEMENT_LIMIT);
    let max_content_length = options
        .max_content_length
        .unwrap_or(DEFAULT_OVERVIEW_CONTENT_LIMIT);
    let include_ipython = options.include_ipython_examples.unwrap_or(true);
    let include_refine = options.include_refine_examples.unwrap_or(include_ipython);

    let mut lines: Vec<String> = vec![
        "# Continual Harness State".to_string(),
        String::new(),
        "Local continual harness entries belong to this Prime Agent session. Global continual harness entries persist across Prime Agent sessions.".to_string(),
        "The continual harness entries below are compact summaries, not full descriptions. Use them as routing/context hints; inspect or refine the underlying continual harness entry only when detail matters.".to_string(),
        "Default to local continual harness refinement for current task progress, temporary blockers, and session coordination. Use global continual harness refinement only for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts.".to_string(),
        "Use these continual harness prompt notes, memories, skills, and subagent specs when they are relevant. The base system prompt is immutable; prompt entries below are supplemental notes only.".to_string(),
        String::new(),
        if include_refine {
            "When to call `await refine.run()`: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep `await refine.run()` continual harness edits small and evidence-backed.".to_string()
        } else {
            "When to refine the continual harness: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep continual harness edits small and evidence-backed.".to_string()
        },
        String::new(),
        if include_ipython {
            "Call contract: read each installed Python skill's SKILL.md and call its documented module function in the Python REPL; do not assume a `.run` entrypoint. Use `<skill_import> ...` in shell when a CLI exists. Continual harness skill entries are Python REPL skills with an explicit Python `reference` and `arguments` contract. Spawn a continual harness subagent spec by composing a concise task prompt and calling `handle = await rlm.spawn('sub-task', name='worker')`; admission returns immediately with `rlm_child_id`, `name`, `session_dir`, and `model`, never the child's answer. Results arrive only through explicit `agent_message` replies or files; children reply with `await agent_message.send(message, receiver_role='parent')`. Use `await rlm.list_subagents()` to recover direct child handles and `await agent_message.send(..., receiver_role='child', receiver_name=handle.name)` for follow-ups. Do not invent wrappers such as `call_skill(...)`, `run_subagent(...)`, or named subagent registries.".to_string()
        } else if options.include_shell_examples {
            "Call contract: use installed skills as shell commands when available (for example `<skill_import> ...`). Continual harness entries are routing/context hints only in sessions without the Python REPL; do not use Python `await`, `asyncio`, or `rlm` examples unless the prompt also documents a Python kernel.".to_string()
        } else {
            "Call contract: continual harness entries are routing/context hints only in sessions without the Python REPL or shell access; do not use Python `await`, `asyncio`, `rlm`, or shell skill commands unless the prompt also documents those interfaces.".to_string()
        },
        String::new(),
    ];

    let query_terms = &options.query_terms;
    let mut total_entries = 0usize;
    for kind in REFINEMENT_KINDS {
        let entries = state
            .entries
            .get(&kind_for(kind))
            .cloned()
            .unwrap_or_default();
        // The ranked corpus is the kind's own entries: they compete for the
        // same top-k slots, so document frequency discounts terms ubiquitous
        // within the kind rather than across unrelated kinds.
        let mut entries: Vec<HarnessEntry> = entries.into_values().collect();
        let ranked_idf = match query_terms.as_ref() {
            Some(terms) if !terms.is_empty() => Some(harness_query_term_idf(&entries, terms)),
            _ => None,
        };
        entries.sort_by(|a, b| match (query_terms.as_ref(), ranked_idf.as_ref()) {
            (Some(terms), idf) if !terms.is_empty() => {
                let left = score_harness_entry_for_query(b, terms, idf)
                    .partial_cmp(&score_harness_entry_for_query(a, terms, idf))
                    .unwrap_or(std::cmp::Ordering::Equal);
                if left != std::cmp::Ordering::Equal {
                    return left;
                }
                entry_sort_key(a).cmp(&entry_sort_key(b))
            }
            _ => entry_sort_key(a).cmp(&entry_sort_key(b)),
        });
        total_entries += entries.len();
        let kind_name = kind;
        if kind_name == "subagent" && !entries.is_empty() && include_ipython {
            lines.push(format!("{kind_name}: {} (invoke a spec by turning it into a concise task prompt and spawning with `await rlm.spawn('<task>', name='<worker>')`; admission returns a child handle, never the answer)", entries.len()));
        } else {
            lines.push(format!("{kind_name}: {}", entries.len()));
        }
        if let Some(terms) = query_terms.as_ref() {
            if !terms.is_empty() && entries.len() > max_entries_per_kind {
                lines.push(
                    "(entries ranked by relevance to the current task; see harness.search)"
                        .to_string(),
                );
            }
        }
        for entry in entries.iter().take(max_entries_per_kind) {
            let arguments_text =
                if entry.kind == RefinementKind::Skill && !entry.arguments.is_empty() {
                    format!(
                        " args={}",
                        compact_harness_text(
                            &serde_json::to_string(&entry.arguments).unwrap_or_default(),
                            max_content_length
                        )
                    )
                } else {
                    String::new()
                };
            let reference_text =
                if entry.kind == RefinementKind::Skill && !entry.reference.is_empty() {
                    format!(
                        " ref={}",
                        compact_harness_text(
                            &serde_json::to_string(&entry.reference).unwrap_or_default(),
                            max_content_length
                        )
                    )
                } else {
                    String::new()
                };
            let scope = match entry.scope {
                Some(super::HarnessScope::Local) => "local",
                _ => "global",
            };
            lines.push(format!(
                "- [{}:{}] {} ({}, v{}){}{}: {}",
                scope,
                entry.id,
                entry.title,
                entry.path,
                entry.version,
                reference_text,
                arguments_text,
                compact_harness_text(&entry.content, max_content_length)
            ));
        }
        let overflow = entries.len().saturating_sub(max_entries_per_kind);
        if overflow > 0 {
            lines.push(format!("- +{overflow} more {kind_name} entries"));
        }
        lines.push(String::new());
    }
    if total_entries == 0 {
        lines.push("No saved harness entries yet.".to_string());
        lines.push(String::new());
    }
    lines.push(format!("recent refinements: {}", state.refinements.len()));
    for event in state
        .refinements
        .iter()
        .rev()
        .take(max_refinements)
        .collect::<Vec<_>>()
        .iter()
        .rev()
    {
        let changes = if event.changes.is_empty() {
            "no applied edits".to_string()
        } else {
            event.changes.join(", ")
        };
        let outcome = if event.outcome.is_empty() {
            String::new()
        } else {
            format!(
                "; outcome: {}",
                compact_harness_text(&event.outcome, max_content_length)
            )
        };
        lines.push(format!(
            "- [{}] {}: {}{}",
            event.id,
            compact_harness_text(&event.trigger, max_content_length),
            changes,
            outcome
        ));
    }
    let refinement_overflow = state.refinements.len().saturating_sub(max_refinements);
    if refinement_overflow > 0 {
        lines.push(format!("- +{refinement_overflow} older refinement events"));
    }
    lines.join("\n").trim().to_string()
}

/// Bump when the fingerprinted material or its canonical serialization
/// changes, so fingerprints minted under different versions never compare
/// equal.
pub const HARNESS_DIGEST_FINGERPRINT_VERSION: u32 = 1;

/// The render flags the digest actually reads (TS `renderFlags` on
/// `harnessDigestFingerprint`): the relevance query terms are excluded —
/// the digest stays frozen per delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HarnessDigestRenderFlags {
    pub include_ipython_examples: bool,
    pub include_shell_examples: bool,
    pub include_refine_examples: bool,
}

fn scope_name(entry: &HarnessEntry) -> &'static str {
    match entry.scope {
        Some(super::HarnessScope::Local) => "local",
        _ => "global",
    }
}

fn refinement_kind_name(kind: RefinementKind) -> &'static str {
    match kind {
        RefinementKind::Prompt => "prompt",
        RefinementKind::Memory => "memory",
        RefinementKind::Skill => "skill",
        RefinementKind::Subagent => "subagent",
    }
}

/// Stable fingerprint of the harness material a digest renders (TS
/// `harnessDigestFingerprint`). Equal states (per the fields the digest
/// actually prints) produce equal fingerprints, so cold boundaries can
/// skip digest re-delivery with a state comparison instead of a
/// rendered-text comparison that query-term relevance keeps invalidating.
///
/// Covered: entry identity and content (entry order is normalized away, as
/// is the call contract on non-skill entries, which the formatter never
/// prints), plus the render flags and each refinement's printed fields in
/// stored order, since the formatter renders a positional newest tail. The
/// shell-examples flag participates only when IPython examples are not
/// rendered: the formatter never reads it then, so it is normalized out of
/// the fingerprint to keep an unchanged digest fresh. Excluded: `metadata`,
/// `source`, the invisible `created_at`/`updated_at` bookkeeping, and
/// relevance query terms.
pub fn harness_digest_fingerprint(
    state: &HarnessState,
    render_flags: HarnessDigestRenderFlags,
) -> String {
    // The section key is the renderer's grouping (the formatter prints
    // entries under their section, never `entry.kind`), so the material
    // keys `kind` by the section: an entry moved between sections renders
    // differently and must invalidate the digest, even when its `kind`
    // field disagrees with its section (a hand-edited store).
    let mut entries: Vec<(&'static str, &HarnessEntry)> = state
        .entries
        .iter()
        .flat_map(|(kind, records)| {
            records
                .values()
                .map(move |entry| (refinement_kind_name(*kind), entry))
        })
        .collect();
    entries.sort_by(|(a_kind, a), (b_kind, b)| {
        format!("{}\0{}\0{}", scope_name(a), a_kind, a.id).cmp(&format!(
            "{}\0{}\0{}",
            scope_name(b),
            b_kind,
            b.id
        ))
    });
    let entry_material = |kind: &'static str, entry: &HarnessEntry| {
        let mut material = serde_json::Map::new();
        material.insert("scope".to_string(), serde_json::json!(scope_name(entry)));
        material.insert("kind".to_string(), serde_json::json!(kind));
        material.insert("id".to_string(), serde_json::json!(entry.id));
        material.insert("title".to_string(), serde_json::json!(entry.title));
        material.insert("path".to_string(), serde_json::json!(entry.path));
        material.insert("version".to_string(), serde_json::json!(entry.version));
        material.insert("content".to_string(), serde_json::json!(entry.content));
        // Only skills render the kernel call contract, so another kind can
        // change these fields without changing a single digest byte.
        if entry.kind == RefinementKind::Skill {
            material.insert(
                "reference".to_string(),
                serde_json::Value::Object(entry.reference.clone().into_iter().collect()),
            );
            material.insert(
                "arguments".to_string(),
                serde_json::Value::Object(entry.arguments.clone().into_iter().collect()),
            );
        }
        serde_json::Value::Object(material)
    };
    // Refinements keep their stored order: the formatter renders the newest
    // tail of the array, so an order-only change renders differently and must
    // not reuse the previous digest.
    let refinement_material = state
        .refinements
        .iter()
        .map(|event| {
            let mut material = serde_json::Map::new();
            material.insert("id".to_string(), serde_json::json!(event.id));
            material.insert("trigger".to_string(), serde_json::json!(event.trigger));
            material.insert("changes".to_string(), serde_json::json!(event.changes));
            material.insert("outcome".to_string(), serde_json::json!(event.outcome));
            serde_json::Value::Object(material)
        })
        .collect::<Vec<_>>();
    // The formatter renders the shell call-contract only when IPython
    // examples are absent, so the shell flag cannot change the digest while
    // IPython examples take precedence; fingerprint only the flags the
    // render reads.
    let effective_shell_examples = if render_flags.include_ipython_examples {
        false
    } else {
        render_flags.include_shell_examples
    };
    let mut flags_material = serde_json::Map::new();
    flags_material.insert(
        "includeIpythonExamples".to_string(),
        serde_json::json!(render_flags.include_ipython_examples),
    );
    flags_material.insert(
        "includeShellExamples".to_string(),
        serde_json::json!(effective_shell_examples),
    );
    flags_material.insert(
        "includeRefineExamples".to_string(),
        serde_json::json!(render_flags.include_refine_examples),
    );
    let mut material = serde_json::Map::new();
    material.insert(
        "version".to_string(),
        serde_json::json!(HARNESS_DIGEST_FINGERPRINT_VERSION),
    );
    material.insert(
        "renderFlags".to_string(),
        serde_json::Value::Object(flags_material),
    );
    material.insert(
        "entries".to_string(),
        serde_json::Value::Array(
            entries
                .iter()
                .map(|(kind, entry)| entry_material(kind, entry))
                .collect(),
        ),
    );
    material.insert(
        "refinements".to_string(),
        serde_json::Value::Array(refinement_material),
    );
    let serialized =
        serde_json::to_string(&serde_json::Value::Object(material)).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn kind_for(name: &str) -> RefinementKind {
    match name {
        "prompt" => RefinementKind::Prompt,
        "memory" => RefinementKind::Memory,
        "skill" => RefinementKind::Skill,
        _ => RefinementKind::Subagent,
    }
}

#[cfg(test)]
mod tests {
    use super::super::{empty_harness_state, HarnessScope};
    use super::*;

    #[test]
    fn query_terms_words_and_cjk_bigrams() {
        let terms = harness_query_terms("fix the worktree? then 修复登录问题");
        assert!(terms.contains(&"worktree".to_string()));
        assert!(terms.contains(&"then".to_string()));
        // CJK bigrams overlap so 登录 matches entries mentioning 登录故障.
        assert!(terms.contains(&"修复".to_string()));
        assert!(terms.contains(&"登录".to_string()));
        assert!(!terms.contains(&"fix".to_string())); // short runs drop
                                                      // Distinct terms only.
        let dupes = harness_query_terms("alpha alpha alpha");
        assert_eq!(dupes.iter().filter(|t| *t == "alpha").count(), 1);
    }

    fn make_entry(id: &str, title: &str, content: &str, path: &str) -> HarnessEntry {
        HarnessEntry {
            id: id.to_string(),
            kind: RefinementKind::Memory,
            title: title.to_string(),
            content: content.to_string(),
            path: path.to_string(),
            scope: Some(HarnessScope::Global),
            reference: Default::default(),
            arguments: Default::default(),
            metadata: Default::default(),
            source: "test".to_string(),
            created_at: String::new(),
            updated_at: String::new(),
            version: 1,
        }
    }

    #[test]
    fn scoring_field_coverage() {
        let entry = HarnessEntry {
            id: "web".to_string(),
            kind: RefinementKind::Skill,
            title: "Web Search".to_string(),
            content: "searches the web for results".to_string(),
            path: "/skills/web".to_string(),
            scope: Some(HarnessScope::Global),
            reference: Default::default(),
            arguments: Default::default(),
            metadata: Default::default(),
            source: "test".to_string(),
            created_at: String::new(),
            updated_at: String::new(),
            version: 1,
        };
        let mut terms = HarnessQueryTerms::new();
        terms.insert("web".to_string(), 1.0);
        // web matches title + content + identifier: 3 fields -> 1.0*(1+1.0) = 2.
        let score = score_harness_entry_for_query(&entry, &terms, None);
        assert!((score - 2.0).abs() < 1e-9);
        terms.insert("absent".to_string(), 1.0);
        assert!((score_harness_entry_for_query(&entry, &terms, None) - score).abs() < 1e-9);
    }

    #[test]
    fn idf_discounts_common_terms_over_the_ranked_corpus() {
        let terms = HarnessQueryTerms::from_iter([
            ("session".to_string(), 1.0),
            ("quantum".to_string(), 1.0),
            ("missing".to_string(), 1.0),
        ]);
        let common0 = make_entry("common0", "Session notes", "session text", "general");
        let common1 = make_entry("common1", "Session notes", "session text", "general");
        let rare = make_entry("rare", "Quantum note", "quantum text", "general");
        // "session" matches 2 of 3 entries, "quantum" 1 of 3, "missing" none.
        let corpus = [common0.clone(), common1.clone(), rare.clone()];
        let idf = harness_query_term_idf(&corpus, &terms);
        assert_eq!(idf.len(), 2);
        let documents: f64 = 3.0;
        assert!((idf["session"] - (1.0 + documents / 2.0).ln()).abs() < 1e-9);
        assert!((idf["quantum"] - (1.0 + documents / 1.0).ln()).abs() < 1e-9);
        // The discount scales the weighted overlap: "quantum" covers 2
        // fields of 1 entry.
        let rare_score = score_harness_entry_for_query(&rare, &terms, Some(&idf));
        assert!((rare_score - (1.0 + documents / 1.0).ln() * 1.5).abs() < 1e-9);
        // A term in every entry still weighs ln(2); degenerate corpora stay
        // inert, and empty terms or corpora score nothing.
        let solo_idf = harness_query_term_idf(std::slice::from_ref(&rare), &terms);
        assert!((solo_idf["quantum"] - 2.0_f64.ln()).abs() < 1e-9);
        assert!(harness_query_term_idf(&[], &terms).is_empty());
        assert!(harness_query_term_idf(&corpus, &HarnessQueryTerms::new()).is_empty());
        // A rare distinctive term outranks a common-term-dense entry in the
        // rendered window, regardless of updated_at recency.
        let mut state = empty_harness_state();
        for entry in [common0, common1, rare] {
            state
                .entries
                .get_mut(&RefinementKind::Memory)
                .unwrap()
                .insert(entry.id.clone(), entry);
        }
        let rendered = format_harness_state_for_prompt(
            &state,
            &HarnessStatePromptOptions {
                max_entries_per_kind: Some(2),
                query_terms: Some(HarnessQueryTerms::from_iter([
                    ("session".to_string(), 1.0),
                    ("quantum".to_string(), 1.0),
                ])),
                ..Default::default()
            },
        );
        assert!(rendered.contains("[global:rare]"));
        assert!(rendered.contains("+1 more memory entries"));
    }

    #[test]
    fn fingerprint_is_stable_across_entry_order_and_ignores_query_terms() {
        let mut state = empty_harness_state();
        let alpha = make_entry("alpha", "Alpha note", "Alpha content", "general");
        let zeta = make_entry("zeta", "Zeta note", "Zeta content", "policy");
        state
            .entries
            .get_mut(&RefinementKind::Memory)
            .unwrap()
            .insert("alpha".to_string(), alpha);
        state
            .entries
            .get_mut(&RefinementKind::Prompt)
            .unwrap()
            .insert("zeta".to_string(), zeta);
        let flags = HarnessDigestRenderFlags {
            include_ipython_examples: true,
            include_shell_examples: false,
            include_refine_examples: false,
        };
        let baseline = harness_digest_fingerprint(&state, flags);
        // Kind iteration order is normalized away, as is the invisible
        // metadata/source/timestamps bookkeeping.
        let mut reordered = empty_harness_state();
        let entry = state.entries[&RefinementKind::Memory]["alpha"].clone();
        reordered
            .entries
            .get_mut(&RefinementKind::Memory)
            .unwrap()
            .insert("alpha".to_string(), entry);
        let entry = state.entries[&RefinementKind::Prompt]["zeta"].clone();
        reordered
            .entries
            .get_mut(&RefinementKind::Prompt)
            .unwrap()
            .insert("zeta".to_string(), entry);
        assert_eq!(harness_digest_fingerprint(&reordered, flags), baseline);
        // A content change re-fingerprints (the digest would differ).
        let mut changed = state.clone();
        changed
            .entries
            .get_mut(&RefinementKind::Memory)
            .unwrap()
            .get_mut("alpha")
            .unwrap()
            .content
            .push_str(" more");
        assert_ne!(harness_digest_fingerprint(&changed, flags), baseline);
        // The shell flag cannot change the digest while IPython examples
        // take precedence: it is normalized out of the material.
        let shell_on = HarnessDigestRenderFlags {
            include_ipython_examples: true,
            include_shell_examples: true,
            include_refine_examples: false,
        };
        assert_eq!(harness_digest_fingerprint(&state, shell_on), baseline);
        // Without IPython examples the shell contract renders, so the flag
        // participates; so does the refine flag while IPython is on.
        let shell_only = HarnessDigestRenderFlags {
            include_ipython_examples: false,
            include_shell_examples: true,
            include_refine_examples: false,
        };
        assert_ne!(harness_digest_fingerprint(&state, shell_only), baseline);
    }

    #[test]
    fn fingerprint_covers_skill_contract_and_refinement_order() {
        let mut state = empty_harness_state();
        let mut skill = make_entry("skill_a", "Skill A", "Skill content", "general");
        skill.kind = RefinementKind::Skill;
        skill
            .reference
            .insert("type".to_string(), serde_json::json!("python"));
        state
            .entries
            .get_mut(&RefinementKind::Skill)
            .unwrap()
            .insert("skill_a".to_string(), skill.clone());
        state
            .refinements
            .push(super::super::HarnessRefinementEvent {
                id: "r1".to_string(),
                trigger: "after a repeated failure".to_string(),
                changes: vec!["create skill skill_a".to_string()],
                evidence: String::new(),
                outcome: "routing improved".to_string(),
                created_at: String::new(),
            });
        state
            .refinements
            .push(super::super::HarnessRefinementEvent {
                id: "r2".to_string(),
                trigger: "a later pass".to_string(),
                changes: vec!["update memory m".to_string()],
                evidence: String::new(),
                outcome: String::new(),
                created_at: String::new(),
            });
        let flags = HarnessDigestRenderFlags {
            include_ipython_examples: true,
            include_shell_examples: false,
            include_refine_examples: true,
        };
        let baseline = harness_digest_fingerprint(&state, flags);
        // The skill's call contract participates; the same fields on a
        // memory entry never render, so they stay out of the material.
        let mut contract_changed = state.clone();
        contract_changed
            .entries
            .get_mut(&RefinementKind::Skill)
            .unwrap()
            .get_mut("skill_a")
            .unwrap()
            .reference
            .insert("import".to_string(), serde_json::json!("rlm.bash"));
        assert_ne!(
            harness_digest_fingerprint(&contract_changed, flags),
            baseline
        );
        let mut memory_touched = state.clone();
        memory_touched
            .entries
            .get_mut(&RefinementKind::Memory)
            .unwrap()
            .insert(
                "m".to_string(),
                make_entry("m", "M", "memory content", "general"),
            );
        // A new memory entry changes the digest, so the fingerprint moves.
        assert_ne!(harness_digest_fingerprint(&memory_touched, flags), baseline);
        // Refinements keep their stored order: a reorder renders a
        // different newest tail and must not reuse the fingerprint.
        let mut reordered = state.clone();
        reordered.refinements.reverse();
        assert_ne!(harness_digest_fingerprint(&reordered, flags), baseline);
        // The material keys `kind` by the SECTION the formatter prints
        // under: an entry moved between sections (even one whose `kind`
        // field still disagrees, as a hand-edited store can) renders
        // differently and must invalidate the digest.
        let mut moved = state.clone();
        let moved_skill = moved
            .entries
            .get_mut(&RefinementKind::Skill)
            .unwrap()
            .remove("skill_a")
            .expect("the seeded skill");
        moved
            .entries
            .get_mut(&RefinementKind::Prompt)
            .unwrap()
            .insert("skill_a".to_string(), moved_skill);
        assert_ne!(harness_digest_fingerprint(&moved, flags), baseline);
    }

    #[test]
    fn digest_renders_kinds_and_refinements() {
        let mut state = empty_harness_state();
        let entry = HarnessEntry {
            id: "m1".to_string(),
            kind: RefinementKind::Memory,
            title: "Fact".to_string(),
            content: "the  build is green".to_string(),
            path: "/m/m1".to_string(),
            scope: Some(HarnessScope::Local),
            reference: Default::default(),
            arguments: Default::default(),
            metadata: Default::default(),
            source: "test".to_string(),
            created_at: String::new(),
            updated_at: String::new(),
            version: 2,
        };
        state
            .entries
            .get_mut(&RefinementKind::Memory)
            .unwrap()
            .insert("m1".to_string(), entry);
        state
            .refinements
            .push(super::super::HarnessRefinementEvent {
                id: "r1".to_string(),
                trigger: "after a repeated failure".to_string(),
                changes: vec!["create memory m1".to_string()],
                evidence: String::new(),
                outcome: "routing improved".to_string(),
                created_at: String::new(),
            });
        let text = format_harness_state_for_prompt(&state, &HarnessStatePromptOptions::default());
        assert!(text.starts_with("# Continual Harness State"));
        assert!(text.contains("memory: 1"));
        assert!(text.contains("- [local:m1] Fact (/m/m1, v2): the build is green"));
        assert!(text.contains("recent refinements: 1"));
        assert!(text.contains("routing improved"));
        assert!(text.contains("When to call `await refine.run()`"));
        // Empty state renders the placeholder.
        let empty_text = format_harness_state_for_prompt(
            &empty_harness_state(),
            &HarnessStatePromptOptions::default(),
        );
        assert!(empty_text.contains("No saved harness entries yet."));
    }
}
