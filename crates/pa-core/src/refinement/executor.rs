//! The refinement executor: the refinement child's planning surface (the
//! spawn request envelope and the model prompt), the proposal parse, the
//! rollback plan, and the apply machinery. The model pass itself runs in
//! the refinement child — a daemon `rlm.spawn kind="refine"` child — so
//! this module owns no provider call.

use super::planner::{
    apply_refinement_proposal, rollback_proposal, trim_conversation_to_context, ApplyOptions,
    RefinementProposal,
};
use super::{
    infer_refinement_result_scope, HarnessScope, HarnessState, RefinementKind, RefinementResult,
    REFINEMENT_KINDS,
};

#[derive(Debug, Default, Clone)]
pub struct RefineOptions {
    pub global: bool,
    pub instructions: Option<String>,
    pub rollback_id: Option<String>,
}

/// A planned refinement awaiting application.
pub struct RefinementPlan {
    pub proposal: RefinementProposal,
    pub id: String,
    pub rollback_of: Option<String>,
    pub rollback_scope: Option<HarnessScope>,
}

/// Mint a refinement id in the canonical `refine_<timestamp>` format.
pub fn generate_refinement_id() -> String {
    let iso = crate::session::manager::format_iso_now();
    let digits: String = iso.chars().filter(char::is_ascii_digit).collect();
    format!("refine_{}", &digits[..digits.len().min(17)])
}

/// Harness overview section for the refine prompt (per-kind, 40-entry cap,
/// 240-char content/ref/args snippets).
#[must_use]
pub fn overview_for_prompt(state: &HarnessState) -> String {
    let mut lines: Vec<String> = Vec::new();
    for kind in REFINEMENT_KINDS {
        let entries: Vec<&super::HarnessEntry> = state
            .entries
            .get(&kind_value(kind))
            .map(|records| records.values().collect())
            .unwrap_or_default();
        lines.push(format!("{kind}: {}", entries.len()));
        for entry in entries.iter().take(40) {
            let content: String = entry
                .content
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            let content: String = content.chars().take(240).collect();
            let arguments_text =
                if entry.kind == RefinementKind::Skill && !entry.arguments.is_empty() {
                    let serialized = serde_json::to_string(&entry.arguments).unwrap_or_default();
                    format!(" args={}", &serialized[..serialized.len().min(240)])
                } else {
                    String::new()
                };
            let reference_text =
                if entry.kind == RefinementKind::Skill && !entry.reference.is_empty() {
                    let serialized = serde_json::to_string(&entry.reference).unwrap_or_default();
                    format!(" ref={}", &serialized[..serialized.len().min(240)])
                } else {
                    String::new()
                };
            let scope = match entry.scope {
                Some(HarnessScope::Local) => "local",
                _ => "global",
            };
            lines.push(format!(
                "- [{scope}:{}] {} ({}, v{}){}{}: {content}",
                entry.id, entry.title, entry.path, entry.version, reference_text, arguments_text
            ));
        }
        let overflow = entries.len().saturating_sub(40);
        if overflow > 0 {
            lines.push(format!("- +{overflow} more {kind} entries"));
        }
    }
    lines.join("\n")
}

#[must_use]
pub fn history_for_prompt(history: &[RefinementResult]) -> String {
    if history.is_empty() {
        return "No prior refinement history.".to_string();
    }
    history
        .iter()
        .rev()
        .take(20)
        .rev()
        .map(|item| {
            let edits = item
                .applied_edits
                .iter()
                .map(|edit| {
                    format!(
                        "{} {} {}:{}",
                        if edit.applied { "applied" } else { "failed" },
                        action_name(edit.action),
                        kind_name(edit.kind),
                        edit.id
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            let rollback = item
                .rollback_of
                .as_ref()
                .map(|id| format!(" rollbackOf={id}"))
                .unwrap_or_default();
            format!(
                "[{}]{} {}\n{edits}\nExpected outcome: {}",
                item.id, rollback, item.summary, item.expected_outcome
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn action_name(action: super::RefinementAction) -> &'static str {
    match action {
        super::RefinementAction::Create => "create",
        super::RefinementAction::Update => "update",
        super::RefinementAction::Delete => "delete",
    }
}

fn kind_name(kind: RefinementKind) -> &'static str {
    match kind {
        RefinementKind::Prompt => "prompt",
        RefinementKind::Memory => "memory",
        RefinementKind::Skill => "skill",
        RefinementKind::Subagent => "subagent",
        RefinementKind::Factory => "factory",
    }
}

fn kind_value(name: &str) -> RefinementKind {
    match name {
        "prompt" => RefinementKind::Prompt,
        "memory" => RefinementKind::Memory,
        "skill" => RefinementKind::Skill,
        "factory" => RefinementKind::Factory,
        _ => RefinementKind::Subagent,
    }
}

/// The refinement child's spawn request tag: the JSON envelope the child's
/// engine parses off its first prompt.
pub const REFINEMENT_REQUEST_TYPE: &str = "refinement.request";

/// One refinement child's spawn request: everything the child needs to run
/// the planning pass itself. The harness state is NOT snapshotted here —
/// the child reads the state dirs and the refinement history from disk
/// through the carried paths.
#[derive(Debug, Clone)]
pub struct RefinementRequest {
    /// Global (`true`) or local (`false`) refinement scope.
    pub global: bool,
    /// Caller-supplied instructions, when any.
    pub instructions: Option<String>,
    /// The parent's local harness state dir (the session's own store).
    pub local_harness_dir: Option<String>,
    /// The agent dir's global harness state dir.
    pub global_harness_dir: String,
    /// The parent's session file (the in-session refinement history).
    pub parent_session_file: Option<String>,
}

/// Build the refinement child's spawn prompt: the JSON request envelope
/// carrying the conversation trimmed to the child model's context window.
#[must_use]
pub fn refinement_spawn_prompt(
    request: &RefinementRequest,
    context_window: u64,
    conversation: &str,
) -> String {
    let mut envelope = serde_json::json!({
        "type": REFINEMENT_REQUEST_TYPE,
        "scope": if request.global { "global" } else { "local" },
        "globalHarnessDir": request.global_harness_dir,
    });
    if let Some(instructions) = &request.instructions {
        envelope["instructions"] = serde_json::json!(instructions);
    }
    if let Some(dir) = &request.local_harness_dir {
        envelope["localHarnessDir"] = serde_json::json!(dir);
    }
    if let Some(file) = &request.parent_session_file {
        envelope["parentSessionFile"] = serde_json::json!(file);
    }
    // The trim needs the envelope's own head room: serialize it once with
    // the conversation slot empty, then trim the conversation against the
    // model's window minus that head.
    let mut head = envelope.clone();
    head["conversation"] = serde_json::json!("");
    let request_head = head.to_string();
    let trimmed = trim_conversation_to_context(context_window, &request_head, conversation);
    envelope["conversation"] = serde_json::json!(trimmed);
    serde_json::to_string(&envelope).unwrap_or_default()
}

/// The refinement child's model prompt: the harness overview, the history,
/// the conversation, and the scope policy — the sections the planning pass
/// answers with its proposal JSON.
#[must_use]
pub fn refinement_user_prompt(
    state: &HarnessState,
    history: &[RefinementResult],
    conversation: &str,
    options: &RefineOptions,
) -> String {
    let scope_instruction = if options.global {
        "Requested refinement scope: global. Only propose stable cross-session continual harness edits, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts that should affect future Prime Agent sessions. Do not persist session-only progress, temporary blockers, or current-run coordination globally."
    } else {
        "Requested refinement scope: local. Prefer local continual harness edits for current task progress, temporary blockers, current-run coordination, and project facts that are not clearly reusable across Prime Agent sessions. Global entries in the overview are read-only context: do not propose update or delete edits for them; create a local entry instead if an override is needed."
    };
    let mut sections = vec![
        format!(
            "<current_harness_state>\n{}\n</current_harness_state>",
            overview_for_prompt(state)
        ),
        format!(
            "<refinement_history>\n{}\n</refinement_history>",
            history_for_prompt(history)
        ),
        format!("<conversation>\n{conversation}\n</conversation>"),
        format!("<scope_policy>\n{scope_instruction}\n</scope_policy>"),
    ];
    if let Some(instructions) = &options.instructions {
        sections.push(format!(
            "<user_refine_instructions>\n{instructions}\n</user_refine_instructions>"
        ));
    }
    sections.push(
        "Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale."
            .to_string(),
    );
    sections.join("\n\n")
}

/// Parse the planning pass's proposal out of the model reply text.
///
/// # Errors
///
/// Human-readable parse error: no JSON object, an invalid candidate, or a
/// truncated reply.
pub fn parse_child_proposal(text: &str) -> anyhow::Result<RefinementProposal> {
    super::planner::parse_proposal(text).map_err(anyhow::Error::msg)
}

/// The mechanical rollback plan: no model pass, only the inversion of the
/// target refinement's applied edits. `Ok(None)` when `rollback_id` is
/// absent; the caller runs the planning child instead.
///
/// # Errors
///
/// Error on an unknown rollback id.
pub fn rollback_plan(
    history: &[RefinementResult],
    options: &RefineOptions,
) -> anyhow::Result<Option<RefinementPlan>> {
    let id = generate_refinement_id();
    let Some(rollback_id) = &options.rollback_id else {
        return Ok(None);
    };
    let Some(target) = history.iter().find(|item| &item.id == rollback_id) else {
        anyhow::bail!("Refinement {rollback_id} not found");
    };
    let fallback_scope = if options.global {
        HarnessScope::Global
    } else {
        HarnessScope::Local
    };
    Ok(Some(RefinementPlan {
        proposal: rollback_proposal(target),
        id,
        rollback_of: Some(target.id.clone()),
        rollback_scope: Some(infer_refinement_result_scope(target).unwrap_or(fallback_scope)),
    }))
}

/// Apply a plan to the (re-read) harness state. `factory_enabled` is the
/// `factory.enabled` opt-in (default off), resolved by the caller
/// immediately before this call — after the planning pass — so the
/// synchronous apply always decides on the current setting, never a
/// pre-request snapshot: while it is off, factory create/update edits
/// refuse with the one disabled message, the same gate the
/// kernel-side factory writers raise.
pub fn apply_refinement_plan(
    state: &mut HarnessState,
    plan: RefinementPlan,
    options: &RefineOptions,
    baseline_state: Option<HarnessState>,
    factory_enabled: bool,
) -> RefinementResult {
    let scope = plan.rollback_scope.unwrap_or(if options.global {
        HarnessScope::Global
    } else {
        HarnessScope::Local
    });
    apply_refinement_proposal(
        state,
        &plan.proposal,
        ApplyOptions {
            id: plan.id,
            rollback_of: plan.rollback_of,
            scope: Some(scope),
            baseline_state,
            factory_enabled,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refinement_ids_are_canonical() {
        let id = generate_refinement_id();
        assert!(id.starts_with("refine_"));
        assert!(id["refine_".len()..]
            .chars()
            .all(|char| char.is_ascii_digit()));
    }

    #[test]
    fn overview_and_history_sections() {
        let mut state = super::super::empty_harness_state();
        state
            .entries
            .get_mut(&RefinementKind::Memory)
            .unwrap()
            .insert(
                "m1".to_string(),
                super::super::HarnessEntry {
                    id: "m1".to_string(),
                    kind: RefinementKind::Memory,
                    title: "Fact".to_string(),
                    content: "builds are   green".to_string(),
                    path: "/m/m1".to_string(),
                    scope: Some(HarnessScope::Local),
                    reference: serde_json::Map::default(),
                    arguments: serde_json::Map::default(),
                    metadata: serde_json::Map::default(),
                    source: "test".to_string(),
                    created_at: String::new(),
                    updated_at: String::new(),
                    version: 0,
                },
            );
        let overview = overview_for_prompt(&state);
        assert!(overview.contains("memory: 1"));
        assert!(overview.contains("- [local:m1] Fact (/m/m1, v0): builds are green"));
        assert_eq!(history_for_prompt(&[]), "No prior refinement history.");
    }

    #[test]
    fn rollback_plan_inverts_the_target_or_refuses() {
        let mut history_state = super::super::empty_harness_state();
        let result = super::super::planner::apply_refinement_proposal(
            &mut history_state,
            &RefinementProposal {
                summary: "add".to_string(),
                ..Default::default()
            },
            super::super::planner::ApplyOptions {
                id: "refine_target".to_string(),
                rollback_of: None,
                scope: Some(HarnessScope::Local),
                baseline_state: None,
                factory_enabled: false,
            },
        );
        let plan = rollback_plan(
            &[result],
            &RefineOptions {
                rollback_id: Some("refine_target".to_string()),
                ..Default::default()
            },
        )
        .unwrap()
        .expect("the rollback plan exists");
        assert_eq!(plan.rollback_of.as_deref(), Some("refine_target"));
        assert_eq!(plan.proposal.edits.len(), 0); // the seeded result applied no edits, so nothing inverts
        let missing = rollback_plan(
            &[],
            &RefineOptions {
                rollback_id: Some("nope".to_string()),
                ..Default::default()
            },
        );
        assert!(missing.is_err());
        assert!(rollback_plan(&[], &RefineOptions::default())
            .unwrap()
            .is_none());
    }

    #[test]
    fn spawn_prompt_trims_the_conversation_to_the_model_window() {
        let request = RefinementRequest {
            global: false,
            instructions: Some("prefer small edits".to_string()),
            local_harness_dir: Some("/local/harness".to_string()),
            global_harness_dir: "/global/harness".to_string(),
            parent_session_file: Some("/sessions/parent.jsonl".to_string()),
        };
        let conversation = "x".repeat(200_000);
        let prompt = refinement_spawn_prompt(&request, 100_000, &conversation);
        let parsed: serde_json::Value = serde_json::from_str(&prompt).unwrap();
        assert_eq!(parsed["type"], REFINEMENT_REQUEST_TYPE);
        assert_eq!(parsed["scope"], "local");
        assert_eq!(parsed["instructions"], "prefer small edits");
        assert_eq!(parsed["localHarnessDir"], "/local/harness");
        assert_eq!(parsed["globalHarnessDir"], "/global/harness");
        assert_eq!(parsed["parentSessionFile"], "/sessions/parent.jsonl");
        let carried = parsed["conversation"].as_str().unwrap();
        assert!(carried.starts_with("[Earlier conversation omitted to fit the model context.]"));
        // The byte budget: the head plus the carried tail stays inside the window.
        assert!((carried.len() as u64) < 100_000);
        // A short conversation rides whole, with no omission marker.
        let whole = refinement_spawn_prompt(&request, 100_000, "short conversation");
        let parsed: serde_json::Value = serde_json::from_str(&whole).unwrap();
        assert_eq!(parsed["conversation"], "short conversation");
    }

    #[test]
    fn user_prompt_carries_the_sections() {
        let state = super::super::empty_harness_state();
        let prompt = refinement_user_prompt(
            &state,
            &[],
            "the conversation",
            &RefineOptions {
                global: false,
                instructions: Some("focus on the build failure".to_string()),
                rollback_id: None,
            },
        );
        assert!(prompt.contains("<current_harness_state>"));
        assert!(prompt.contains("No prior refinement history."));
        assert!(prompt.contains("<conversation>\nthe conversation\n</conversation>"));
        assert!(prompt.contains("Requested refinement scope: local"));
        assert!(prompt.contains("<user_refine_instructions>\nfocus on the build failure"));
        assert!(prompt.ends_with(
            "Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale."
        ));
        let global = refinement_user_prompt(
            &state,
            &[],
            "c",
            &RefineOptions {
                global: true,
                ..Default::default()
            },
        );
        assert!(global.contains("Requested refinement scope: global"));
    }

    #[test]
    fn child_proposals_parse_or_error() {
        let proposal = parse_child_proposal(
            r#"{"summary":"note it","rationale":"seen twice","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m2","title":"Note","content":"value"}]}"#,
        )
        .unwrap();
        assert_eq!(proposal.summary, "note it");
        assert_eq!(proposal.edits.len(), 1);
        assert_eq!(
            parse_child_proposal(r#"{"summary":"cut","edits":[{"action":"cre"#)
                .unwrap_err()
                .to_string(),
            super::super::planner::TRUNCATED_JSON_ERROR
        );
    }
}
