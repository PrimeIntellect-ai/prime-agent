//! The refine planner: proposal parsing, edit validation, application, and
//! rollback. Port of the apply half of core/refinement/refinement.ts.

use serde::{Deserialize, Serialize};

use super::{
    AppliedRefinementEdit, HarnessEntry, HarnessRefinementEvent, HarnessScope, HarnessState,
    RefinementAction, RefinementKind,
};

pub const REFINEMENT_SYSTEM_PROMPT: &str = "You are Prime Agent's /refine continual harness subsystem.\n\nYour job is to improve the editable continual harness state from the current trajectory.\nThis is similar in spirit to context compaction, but instead of summarizing the\nconversation you emit precise Create, Update, or Delete edits to reusable state.\nThe continual harness is the persistent, editable set of prompt notes, memories,\nskills, and subagent specs that lets Prime Agent improve reusable behavior\noutside the token history.\nUse \"continual harness\" for that persistent artifact layer; keep \"RLM\" for the\nruntime, Python REPL kernel, and native call interface that executes those artifacts.\n\nContinual harness components:\n- prompt: supplemental prompt notes only. The base system prompt is immutable and MUST NOT be rewritten.\n- memory: durable facts, decisions, failures, preferences, and outcomes.\n- skill: installed Python REPL skill. Skill create/update edits MUST include a `reference` object with `{\"type\":\"python\"}`, a Python import, and a callable or call pattern; they also MUST include an `arguments` object describing accepted inputs, required fields, defaults, and constraints. Use `{}` for `arguments` only when the Python callable truly needs no external inputs. Include the RLM-native call form `await <skill_import>(...)`.\n- subagent: reusable delegation specs, including purpose, instructions, and when to invoke. Include the RLM-native call form: compose a concise task prompt and spawn with `handle = await rlm.spawn(\"sub-task\", name=\"worker\")`; admission returns immediately with `rlm_child_id`, `name`, `session_dir`, and `model`, never the child's answer. Results arrive only through explicit `agent_message` replies or files; children reply with `await agent_message.send(message, receiver_role=\"parent\")`. Use `await rlm.list_subagents()` to recover direct child handles and `await agent_message.send(..., receiver_role=\"child\", receiver_name=handle.name)` for follow-ups. Do not invent wrappers like `run_subagent(...)`.\n\nScope and persistence policy:\n- The default editable continual harness store is local to the current Prime Agent session. Use it for session-specific progress, active task state, current-run coordination notes, temporary blockers, and project facts that should not affect other sessions.\n- A caller may explicitly request global refinement. Global edits must be stable cross-session lessons, durable user preferences, reusable skills/subagents, or tool/environment facts that should affect future sessions.\n- Entry ids in the harness overview may carry a display-only `local:` or `global:` prefix. Always use the bare id (no prefix) in edits.\n- All edits in one refinement apply only to the requested scope's store. During a local refinement, global entries are read-only context: never propose update or delete edits for them; create a local entry instead when a session-specific override is genuinely needed.\n- Project/workspace-specific lessons may be persisted globally only when the title, path, or content explicitly names the project/workspace and the lesson is likely to be reused in future sessions for that project. Prefer local edits when the lesson only belongs in the current conversation.\n- Use memory for declarative facts and preferences, skill for repeatable procedures exposed as Python calls, prompt for narrow behavioral policy addendums, and subagent for reusable delegation roles.\n- Create or update the smallest relevant component: repeated delegation roles should become subagent specs, repeated procedures should become skills, durable facts/preferences should become memories, and narrow behavioral policies should become prompt addendums.\n- When an edit is persisted, include metadata such as `{\"scope\":\"local\"}` or `{\"scope\":\"global\"}` when that helps future review understand the intended blast radius.\n\nUse the trajectory, current continual harness state, and prior refinement history. Prefer\nsmall evidence-backed edits. If prior refinements caused issues, rollback or\nreplace the faulty editable entries. Never edit source files directly. Output\nJSON only with this exact shape:\n\n{\n  \"summary\": \"one sentence\",\n  \"rationale\": \"why these edits are justified by trajectory evidence\",\n  \"expectedOutcome\": \"what should improve and how to validate it\",\n  \"edits\": [\n    {\n      \"action\": \"create|update|delete\",\n      \"kind\": \"prompt|memory|skill|subagent\",\n      \"id\": \"stable id for update/delete, optional for create\",\n      \"title\": \"required for create/update except delete\",\n      \"content\": \"required for create/update except delete\",\n      \"path\": \"optional grouping path\",\n      \"reference\": {\"type\": \"python\", \"import\": \"package.module\", \"callable\": \"function_name\", \"call_pattern\": \"await function_name(...)\"},\n      \"arguments\": {\"name\": {\"type\": \"string\", \"required\": true, \"description\": \"accepted input\"}},\n      \"metadata\": {},\n      \"reason\": \"why this edit is useful\"\n    }\n  ]\n}";

pub const AUTO_REFINE_REVIEW_SYSTEM_PROMPT: &str = "You are Prime Agent's automatic /refine review gate.\n\nDecide whether this checkpoint should run /refine. Auto /refine writes local continual harness state by default, so approve when the trajectory contains evidence useful to this session's future turns.\nReject one-off noise, unsupported hypotheses, and transient tool outputs. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified lessons likely to be reused in future sessions.\n\nReturn JSON only:\n{\n  \"shouldRefine\": true|false,\n  \"rationale\": \"short reason\",\n  \"instructions\": \"optional concise instructions for /refine if shouldRefine is true\"\n}";

/// Output caps (reasoning off shares the model's output budget with JSON).
pub const REFINEMENT_MAX_OUTPUT_TOKENS: u64 = 32_000;
pub const AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS: u64 = 4_096;
pub const REFINEMENT_CONTEXT_OVERHEAD_TOKENS: u64 = 1_024;

pub const TRUNCATED_JSON_ERROR: &str = "the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

/// One proposed edit.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefinementEdit {
    pub action: Option<RefinementAction>,
    pub kind: Option<RefinementKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The refiner's proposal.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RefinementProposal {
    pub summary: String,
    pub rationale: String,
    pub expected_outcome: String,
    pub edits: Vec<RefinementEdit>,
}

/// Whether a JSON candidate ends mid-value (unterminated string, unclosed
/// object/array): a truncated reply, as opposed to a malformed-but-balanced one.
pub fn is_incomplete_json(candidate: &str) -> bool {
    let mut depth = 0i64;
    let mut in_string = false;
    let mut escaped = false;
    for char in candidate.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if in_string {
            if char == '\\' {
                escaped = true;
            } else if char == '"' {
                in_string = false;
            }
            continue;
        }
        match char {
            '"' => in_string = true,
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            _ => {}
        }
    }
    in_string || depth > 0
}

fn parse_json_candidate(candidate: &str) -> Result<serde_json::Value, String> {
    match serde_json::from_str::<serde_json::Value>(candidate) {
        Ok(value) => Ok(value),
        Err(error) => {
            if is_incomplete_json(candidate) {
                Err(TRUNCATED_JSON_ERROR.to_string())
            } else {
                Err(format!("the model did not return valid JSON: {error}"))
            }
        }
    }
}

/// Extract the proposal JSON from a reply: direct, fenced, or brace-sliced
/// out of prose (with truncation diagnosed against the original text).
///
/// # Errors
///
/// Returns a human-readable error string when the reply contains no JSON
/// object, the candidate JSON is invalid, or the reply looks truncated.
pub fn extract_json_object(text: &str) -> Result<serde_json::Value, String> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return parse_json_candidate(trimmed);
    }
    // Fenced block: ``` or ```json ... ```.
    if let Some(start) = trimmed.find("```") {
        let after_fence = &trimmed[start + 3..];
        let after_lang = after_fence.trim_start_matches("json").trim_start();
        if let Some(end) = after_lang.find("```") {
            return parse_json_candidate(after_lang[..end].trim());
        }
    }
    let start = trimmed.find('{');
    let end = trimmed.rfind('}');
    if let (Some(start), Some(end)) = (start, end) {
        if end > start {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&trimmed[start..=end]) {
                return Ok(value);
            }
            return parse_json_candidate(&trimmed[start..]);
        }
    }
    if is_incomplete_json(trimmed) {
        return Err(TRUNCATED_JSON_ERROR.to_string());
    }
    Err("Refiner did not return a JSON object".to_string())
}

/// Normalize an untrusted proposal, preserving invalid edit fields for
/// apply-time validation.
pub fn normalize_refinement_proposal(value: serde_json::Value) -> RefinementProposal {
    let record = value.as_object().cloned().unwrap_or_default();
    let string_field = |key: &str, fallback: &str| -> String {
        record
            .get(key)
            .and_then(|value| value.as_str())
            .unwrap_or(fallback)
            .to_string()
    };
    let edits = record
        .get("edits")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|edit| {
            edit.as_object()?;
            serde_json::from_value::<RefinementEdit>(edit.clone()).ok()
        })
        .collect();
    RefinementProposal {
        summary: string_field("summary", "Refined continual harness state"),
        rationale: string_field("rationale", ""),
        expected_outcome: string_field("expectedOutcome", ""),
        edits,
    }
}

/// Parse and normalize a refinement proposal from a model reply.
///
/// # Errors
///
/// Returns a human-readable error string when the reply's JSON cannot be
/// extracted or its top level is not an object.
pub fn parse_proposal(text: &str) -> Result<RefinementProposal, String> {
    let value = extract_json_object(text)?;
    if !value.is_object() {
        return Err("Refiner JSON must be an object".to_string());
    }
    Ok(normalize_refinement_proposal(value))
}

fn slug(raw: &str, fallback: &str) -> String {
    let mut normalized = String::new();
    for char in raw.trim().to_lowercase().chars() {
        if char.is_ascii_lowercase() || char.is_ascii_digit() {
            normalized.push(char);
        } else if !normalized.ends_with('_') {
            normalized.push('_');
        }
    }
    let normalized = normalized.trim_matches('_').to_string();
    let truncated: String = normalized.chars().take(80).collect();
    if truncated.is_empty() {
        fallback.to_string()
    } else {
        truncated
    }
}

/// Validation errors mirror the TS messages exactly.
fn validate_edit(edit: &RefinementEdit, computed_id: Option<&str>) -> Option<String> {
    let Some(action) = edit.action else {
        return Some("unsupported action".to_string());
    };
    let Some(kind) = edit.kind else {
        return Some("unsupported kind".to_string());
    };
    match action {
        RefinementAction::Create | RefinementAction::Update | RefinementAction::Delete => {}
    }
    match kind {
        RefinementKind::Prompt
        | RefinementKind::Memory
        | RefinementKind::Skill
        | RefinementKind::Subagent => {}
    }
    if kind == RefinementKind::Prompt
        && (edit.id.as_deref() == Some("base_system_prompt")
            || computed_id == Some("base_system_prompt"))
    {
        return Some("base system prompt is not editable".to_string());
    }
    if action != RefinementAction::Create && edit.id.is_none() {
        return Some(format!("{action:?} requires id").to_lowercase());
    }
    if action != RefinementAction::Delete && (edit.title.is_none() || edit.content.is_none()) {
        return Some(format!("{action:?} requires title and content").to_lowercase());
    }
    if action != RefinementAction::Delete && kind == RefinementKind::Skill {
        if edit.arguments.is_none() {
            return Some(format!("{action:?} skill requires arguments").to_lowercase());
        }
        let Some(reference) = &edit.reference else {
            return Some(format!("{action:?} skill requires python reference").to_lowercase());
        };
        if reference.get("type").and_then(|value| value.as_str()) != Some("python") {
            return Some(format!("{action:?} skill reference.type must be python").to_lowercase());
        }
        let has_import = reference
            .get("import")
            .and_then(|value| value.as_str())
            .is_some_and(|import| !import.is_empty())
            || reference
                .get("python_import")
                .and_then(|value| value.as_str())
                .is_some_and(|import| !import.is_empty());
        let has_callable = reference
            .get("callable")
            .and_then(|value| value.as_str())
            .is_some_and(|callable| !callable.is_empty())
            || reference
                .get("call_pattern")
                .and_then(|value| value.as_str())
                .is_some_and(|callable| !callable.is_empty());
        if !has_import {
            return Some(format!("{action:?} skill requires python import").to_lowercase());
        }
        if !has_callable {
            return Some(
                format!("{action:?} skill requires callable or call_pattern").to_lowercase(),
            );
        }
    }
    None
}

fn now_iso() -> String {
    crate::session::manager::format_iso_now()
}

/// Options for applying a proposal.
pub struct ApplyOptions {
    pub id: String,
    pub rollback_of: Option<String>,
    pub scope: Option<HarnessScope>,
    /// Target-scope state captured before planning; edits whose entry changed
    /// since the baseline are rejected.
    pub baseline_state: Option<HarnessState>,
}

/// Apply a proposal to the state (mutating entries and recording the event).
///
/// # Panics
///
/// The internal unwraps cannot fire: an edit without an action is rejected
/// by validation first, and the empty state pre-populates every per-kind
/// entry map.
pub fn apply_refinement_proposal(
    state: &mut HarnessState,
    proposal: &RefinementProposal,
    options: ApplyOptions,
) -> super::RefinementResult {
    let mut applied_edits: Vec<AppliedRefinementEdit> = Vec::new();
    let mut proposal_modified_keys: std::collections::HashSet<String> =
        std::collections::HashSet::default();
    for edit in &proposal.edits {
        let computed_id = edit.id.clone().or_else(|| {
            (edit.action == Some(RefinementAction::Create)).then(|| {
                slug(
                    edit.title
                        .as_deref()
                        .unwrap_or(kind_name(edit.kind.unwrap_or(RefinementKind::Memory))),
                    kind_name(edit.kind.unwrap_or(RefinementKind::Memory)),
                )
            })
        });
        let id = computed_id.clone().unwrap_or_default();
        let validation_error = validate_edit(edit, computed_id.as_deref());
        let Some(kind) = edit.kind else {
            let mut row = AppliedRefinementEdit::planned(
                edit,
                RefinementAction::Create,
                RefinementKind::Memory,
                id.clone(),
            );
            row.error = validation_error;
            applied_edits.push(row);
            continue;
        };
        if let Some(error) = validation_error {
            let mut row = AppliedRefinementEdit::planned(
                edit,
                edit.action.unwrap_or(RefinementAction::Create),
                kind,
                id.clone(),
            );
            row.error = Some(error);
            applied_edits.push(row);
            continue;
        }
        let action = edit.action.unwrap();
        let records = state.entries.get_mut(&kind).unwrap();
        let before = records.get(&id).cloned();
        let entry_key = format!("{}:{id}", kind_name(kind));
        let baseline = options.baseline_state.as_ref().and_then(|baseline| {
            baseline
                .entries
                .get(&kind)
                .and_then(|entries| entries.get(&id).cloned())
        });
        if options.baseline_state.is_some()
            && !proposal_modified_keys.contains(&entry_key)
            && serde_json::to_value(&before).ok() != serde_json::to_value(&baseline).ok()
        {
            let mut row = AppliedRefinementEdit::planned(edit, action, kind, id.clone());
            row.before = before;
            row.error = Some("entry changed during refinement planning".to_string());
            applied_edits.push(row);
            continue;
        }
        if action == RefinementAction::Delete {
            if before.is_none() {
                let mut row = AppliedRefinementEdit::planned(edit, action, kind, id.clone());
                row.error = Some("entry not found".to_string());
                applied_edits.push(row);
                continue;
            }
            records.remove(&id);
            proposal_modified_keys.insert(entry_key);
            let mut row = AppliedRefinementEdit::planned(edit, action, kind, id);
            row.before = before;
            row.applied = true;
            applied_edits.push(row);
            continue;
        }
        if action == RefinementAction::Create && before.is_some() {
            let mut row = AppliedRefinementEdit::planned(edit, action, kind, id.clone());
            row.before = before;
            row.error = Some("entry already exists".to_string());
            applied_edits.push(row);
            continue;
        }
        if action == RefinementAction::Update && before.is_none() {
            let mut row = AppliedRefinementEdit::planned(edit, action, kind, id.clone());
            row.error = Some("entry not found".to_string());
            applied_edits.push(row);
            continue;
        }
        let after = HarnessEntry {
            id: id.clone(),
            kind,
            title: edit
                .title
                .clone()
                .or_else(|| before.as_ref().map(|entry| entry.title.clone()))
                .unwrap_or_else(|| id.clone()),
            content: edit
                .content
                .clone()
                .or_else(|| before.as_ref().map(|entry| entry.content.clone()))
                .unwrap_or_default(),
            path: edit
                .path
                .clone()
                .or_else(|| before.as_ref().map(|entry| entry.path.clone()))
                .unwrap_or_else(|| "general".to_string()),
            scope: before
                .as_ref()
                .and_then(|entry| entry.scope)
                .or(options.scope)
                .or(Some(HarnessScope::Local)),
            reference: edit
                .reference
                .clone()
                .or_else(|| before.as_ref().map(|entry| entry.reference.clone()))
                .unwrap_or_default(),
            arguments: edit
                .arguments
                .clone()
                .or_else(|| before.as_ref().map(|entry| entry.arguments.clone()))
                .unwrap_or_default(),
            metadata: edit
                .metadata
                .clone()
                .or_else(|| before.as_ref().map(|entry| entry.metadata.clone()))
                .unwrap_or_default(),
            source: "refine".to_string(),
            created_at: before
                .as_ref()
                .map_or_else(now_iso, |entry| entry.created_at.clone()),
            updated_at: now_iso(),
            version: before.as_ref().map_or(1, |entry| entry.version + 1),
        };
        records.insert(id.clone(), after.clone());
        proposal_modified_keys.insert(entry_key);
        let mut row = AppliedRefinementEdit::planned(edit, action, kind, id);
        row.before = before;
        row.after = Some(after);
        row.applied = true;
        applied_edits.push(row);
    }
    let changes: Vec<String> = applied_edits
        .iter()
        .filter(|edit| edit.applied)
        .map(|edit| {
            format!(
                "{} {}:{}",
                action_name(edit.action),
                kind_name(edit.kind),
                edit.id
            )
        })
        .collect();
    state.refinements.push(HarnessRefinementEvent {
        id: options.id.clone(),
        trigger: proposal.summary.clone(),
        changes,
        evidence: proposal.rationale.clone(),
        outcome: proposal.expected_outcome.clone(),
        created_at: now_iso(),
    });
    super::RefinementResult {
        id: options.id,
        summary: proposal.summary.clone(),
        rationale: proposal.rationale.clone(),
        expected_outcome: proposal.expected_outcome.clone(),
        applied_edits,
        harness_state_path: String::new(),
        rollback_of: options.rollback_of,
        scope: options.scope,
    }
}

/// The proposal that reverts a previously applied result.
pub fn rollback_proposal(target: &super::RefinementResult) -> RefinementProposal {
    let mut edits: Vec<RefinementEdit> = Vec::new();
    for edit in target.applied_edits.iter().rev() {
        if !edit.applied {
            continue;
        }
        if let Some(before) = &edit.before {
            edits.push(RefinementEdit {
                action: Some(if edit.after.is_some() {
                    RefinementAction::Update
                } else {
                    RefinementAction::Create
                }),
                kind: Some(edit.kind),
                id: Some(edit.id.clone()),
                title: Some(before.title.clone()),
                content: Some(before.content.clone()),
                path: Some(before.path.clone()),
                reference: Some(before.reference.clone()),
                arguments: Some(before.arguments.clone()),
                metadata: Some(before.metadata.clone()),
                reason: Some(format!("Rollback {}", target.id)),
            });
        } else if edit.after.is_some() {
            edits.push(RefinementEdit {
                action: Some(RefinementAction::Delete),
                kind: Some(edit.kind),
                id: Some(edit.id.clone()),
                reason: Some(format!("Rollback {}", target.id)),
                ..Default::default()
            });
        }
    }
    RefinementProposal {
        summary: format!("Rollback refinement {}", target.id),
        rationale: format!(
            "Restores continual harness state snapshots from refinement {}.",
            target.id
        ),
        expected_outcome: "Faulty refinement edits are reverted.".to_string(),
        edits,
    }
}

fn action_name(action: RefinementAction) -> &'static str {
    match action {
        RefinementAction::Create => "create",
        RefinementAction::Update => "update",
        RefinementAction::Delete => "delete",
    }
}

fn kind_name(kind: RefinementKind) -> &'static str {
    match kind {
        RefinementKind::Prompt => "prompt",
        RefinementKind::Memory => "memory",
        RefinementKind::Skill => "skill",
        RefinementKind::Subagent => "subagent",
    }
}

/// Byte-based input token bound (one token per UTF-8 byte).
fn refinement_input_token_bound(text: &str) -> u64 {
    text.len() as u64
}

/// Fit the refinement request into the model context: trim conversation from
/// the front (binary search) and clamp output tokens.
///
/// # Errors
///
/// Returns an error when even the trimmed prompt leaves no room for output
/// tokens in the model's context window.
pub fn refinement_request(
    model: &pa_types::ai::Model,
    system_prompt: &str,
    conversation_text: &str,
    build_prompt: &dyn Fn(&str) -> String,
    output_reserve: u64,
) -> anyhow::Result<(u64, String)> {
    let system_reserve =
        refinement_input_token_bound(system_prompt) + REFINEMENT_CONTEXT_OVERHEAD_TOKENS;
    let input_budget = model.context_window.saturating_sub(
        model
            .max_tokens
            .min(output_reserve)
            .min(model.context_window / 2),
    );
    let mut user_prompt = build_prompt(conversation_text);
    if system_reserve + refinement_input_token_bound(&user_prompt) > input_budget
        && !conversation_text.is_empty()
    {
        let prompt_for_length = |length: usize| -> String {
            let start = conversation_text.len().saturating_sub(length);
            // Avoid splitting a UTF-8 sequence (the TS surrogate skip).
            let mut start = start.min(conversation_text.len());
            while start < conversation_text.len() && !conversation_text.is_char_boundary(start) {
                start += 1;
            }
            build_prompt(&format!(
                "[Earlier conversation omitted to fit the model context.]\n{}",
                &conversation_text[start..]
            ))
        };
        let mut low = 0usize;
        let mut high = conversation_text.len();
        while low < high {
            let length = (low + high).div_ceil(2);
            if system_reserve + refinement_input_token_bound(&prompt_for_length(length))
                <= input_budget
            {
                low = length;
            } else {
                high = length - 1;
            }
        }
        user_prompt = prompt_for_length(low);
    }
    let max_tokens = model.max_tokens.min(
        model
            .context_window
            .saturating_sub(system_reserve + refinement_input_token_bound(&user_prompt)),
    );
    if max_tokens == 0 {
        anyhow::bail!("Refinement prompt leaves no room for output in the model's context window; retry with a smaller request.");
    }
    Ok((max_tokens, user_prompt))
}

#[cfg(test)]
mod tests {
    use super::super::empty_harness_state;
    use super::*;

    fn create_memory_edit(id: &str, title: &str, content: &str) -> RefinementEdit {
        RefinementEdit {
            action: Some(RefinementAction::Create),
            kind: Some(RefinementKind::Memory),
            id: Some(id.to_string()),
            title: Some(title.to_string()),
            content: Some(content.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn json_extraction_diagnoses_truncation() {
        // Direct object.
        let parsed = parse_proposal(r#"{"summary":"ok","edits":[]}"#).unwrap();
        assert_eq!(parsed.summary, "ok");
        // Fenced block.
        let fenced = parse_proposal("```json\n{\"summary\":\"fenced\"}\n```").unwrap();
        assert_eq!(fenced.summary, "fenced");
        // Brace-sliced out of prose.
        let prose = parse_proposal("Here you go:\n{\"summary\":\"sliced\"}\nAll set.").unwrap();
        assert_eq!(prose.summary, "sliced");
        // Truncated JSON reports the output-budget cause.
        let error = parse_proposal(r#"{"summary":"cut","edits":[{"action":"cre"#).unwrap_err();
        assert_eq!(error, TRUNCATED_JSON_ERROR);
        // Non-JSON text reports missing JSON.
        assert_eq!(
            parse_proposal("no json here").unwrap_err(),
            "Refiner did not return a JSON object"
        );
    }

    #[test]
    fn validation_rules() {
        // Unsupported action.
        let mut edit = create_memory_edit("m", "t", "c");
        edit.action = None;
        assert!(validate_edit(&edit, None).is_some());
        // base_system_prompt is not editable.
        let mut prompt_edit = RefinementEdit {
            action: Some(RefinementAction::Update),
            kind: Some(RefinementKind::Prompt),
            id: Some("base_system_prompt".to_string()),
            title: Some("t".into()),
            content: Some("c".into()),
            ..Default::default()
        };
        assert_eq!(
            validate_edit(&prompt_edit, None),
            Some("base system prompt is not editable".to_string())
        );
        // Skill edits require python reference + arguments + callable.
        let mut skill_edit = RefinementEdit {
            action: Some(RefinementAction::Create),
            kind: Some(RefinementKind::Skill),
            title: Some("Skill".into()),
            content: Some("Does things".into()),
            ..Default::default()
        };
        assert!(validate_edit(&skill_edit, None)
            .unwrap()
            .contains("skill requires arguments"));
        skill_edit.arguments = Some(serde_json::Map::default());
        assert!(validate_edit(&skill_edit, None)
            .unwrap()
            .contains("skill requires python reference"));
        skill_edit.reference = Some(
            serde_json::from_value(
                serde_json::json!({ "type": "python", "import": "pkg.mod", "callable": "run" }),
            )
            .unwrap(),
        );
        assert_eq!(validate_edit(&skill_edit, None), None);
        // Wrong reference type.
        skill_edit.reference = Some(
            serde_json::from_value(
                serde_json::json!({ "type": "shell", "import": "pkg.mod", "callable": "run" }),
            )
            .unwrap(),
        );
        assert!(validate_edit(&skill_edit, None)
            .unwrap()
            .contains("reference.type must be python"));
        prompt_edit.id = Some("x".to_string());
    }

    #[test]
    fn apply_create_update_delete() {
        let mut state = empty_harness_state();
        let proposal = RefinementProposal {
            summary: "add a memory".to_string(),
            rationale: "used twice".to_string(),
            expected_outcome: "faster".to_string(),
            edits: vec![create_memory_edit("m1", "Fact", "builds are green")],
        };
        let result = apply_refinement_proposal(
            &mut state,
            &proposal,
            ApplyOptions {
                id: "r1".to_string(),
                rollback_of: None,
                scope: Some(HarnessScope::Local),
                baseline_state: None,
            },
        );
        assert_eq!(result.applied_edits.len(), 1);
        assert!(result.applied_edits[0].applied);
        let entry = &state.entries[&RefinementKind::Memory]["m1"];
        assert_eq!(entry.content, "builds are green");
        assert_eq!(entry.version, 1);
        assert_eq!(entry.scope, Some(HarnessScope::Local));
        // Duplicate create is rejected.
        let duplicate = apply_refinement_proposal(
            &mut state,
            &RefinementProposal {
                summary: "again".to_string(),
                rationale: String::new(),
                expected_outcome: String::new(),
                edits: vec![create_memory_edit("m1", "Fact", "again")],
            },
            ApplyOptions {
                id: "r2".to_string(),
                rollback_of: None,
                scope: None,
                baseline_state: None,
            },
        );
        assert!(!duplicate.applied_edits[0].applied);
        assert_eq!(
            duplicate.applied_edits[0].error.as_deref(),
            Some("entry already exists")
        );
        // Update bumps the version.
        let mut update_edit = create_memory_edit("m1", "Fact", "updated fact");
        update_edit.action = Some(RefinementAction::Update);
        apply_refinement_proposal(
            &mut state,
            &RefinementProposal {
                summary: "update".to_string(),
                rationale: String::new(),
                expected_outcome: String::new(),
                edits: vec![update_edit],
            },
            ApplyOptions {
                id: "r3".to_string(),
                rollback_of: None,
                scope: None,
                baseline_state: None,
            },
        );
        assert_eq!(state.entries[&RefinementKind::Memory]["m1"].version, 2);
        // Rollback restores the original content and keeps history.
        let rollback = rollback_proposal(&result);
        let rolled = apply_refinement_proposal(
            &mut state,
            &rollback,
            ApplyOptions {
                id: "r4".to_string(),
                rollback_of: Some("r1".to_string()),
                scope: None,
                baseline_state: None,
            },
        );
        assert!(rolled.applied_edits[0].applied);
        // r1 created m1 with no before snapshot, so the rollback deletes it.
        assert!(!state.entries[&RefinementKind::Memory].contains_key("m1"));
    }
}
