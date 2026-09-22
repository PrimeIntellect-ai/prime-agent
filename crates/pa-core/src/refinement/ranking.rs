//! Harness relevance ranking and prompt rendering. Port of the ranking half
//! of core/refinement/refinement.ts (query terms, scoring, digest formatting).

use std::collections::HashMap;

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

/// Score one entry against query terms: weighted per-term overlap across
/// title/content/identifier fields (field coverage weighted, not repetition).
pub fn score_harness_entry_for_query(entry: &HarnessEntry, terms: &HarnessQueryTerms) -> f64 {
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
            score += weight * (1.0 + (fields - 1) as f64 * 0.5);
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
        let mut entries: Vec<HarnessEntry> = entries.into_values().collect();
        entries.sort_by(|a, b| match query_terms.as_ref() {
            Some(terms) if !terms.is_empty() => {
                let left = score_harness_entry_for_query(b, terms)
                    .partial_cmp(&score_harness_entry_for_query(a, terms))
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
        let score = score_harness_entry_for_query(&entry, &terms);
        assert!((score - 2.0).abs() < 1e-9);
        terms.insert("absent".to_string(), 1.0);
        assert!((score_harness_entry_for_query(&entry, &terms) - score).abs() < 1e-9);
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
