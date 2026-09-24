//! The refinement executor: plan a refinement (rollback or LLM pass), re-read
//! the harness store, apply the proposal, and record the result. Port of the
//! planRefinement/refineHarness/reviewAutoRefine half of refinement.ts.

use super::planner::{
    apply_refinement_proposal, parse_proposal, refinement_request, rollback_proposal, ApplyOptions,
    RefinementProposal, AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS, AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
    REFINEMENT_MAX_OUTPUT_TOKENS, REFINEMENT_SYSTEM_PROMPT,
};
use super::{
    infer_refinement_result_scope, merge_refinement_history, HarnessScope, HarnessState,
    RefinementKind, RefinementResult, REFINEMENT_KINDS,
};
use pa_types::ai::AssistantMessage;
use pa_types::session::AgentMessage;

/// `/refine` request options.
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

/// Prior-refinement-history section for the refine prompt.
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

/// Model-call seam (test seam over pa-ai completion): takes the request
/// model (output budget pre-clamped), the call's system prompt (TS sends
/// the review-gate prompt for the auto-refine review and the `/refine`
/// subsystem prompt for the plan), and the user prompt, returns the
/// reply text.
pub type RefinerFn = Box<
    dyn FnOnce(
            pa_types::ai::Model,
            &'static str,
            String,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = anyhow::Result<AssistantMessage>> + Send>,
        > + Send,
>;

/// Merge global and session histories into one prompt context.
pub fn merge_refinement_result_history(
    global: &[RefinementResult],
    session: &[RefinementResult],
) -> Vec<RefinementResult> {
    merge_refinement_history(global, session)
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
    }
}

fn kind_value(name: &str) -> RefinementKind {
    match name {
        "prompt" => RefinementKind::Prompt,
        "memory" => RefinementKind::Memory,
        "skill" => RefinementKind::Skill,
        _ => RefinementKind::Subagent,
    }
}

/// Serialize the conversation for the refine prompt, tail-capped.
fn conversation_text(messages: &[AgentMessage], cap: usize) -> String {
    let serialized = crate::session_engine::compaction_utils::serialize_conversation(messages);
    let chars: Vec<char> = serialized.chars().collect();
    if chars.len() <= cap {
        serialized
    } else {
        chars[chars.len() - cap..].iter().collect()
    }
}

/// Produce a refinement proposal (rollback, or the LLM pass) without mutating
/// any harness state. Callers re-read the harness file before applying because
/// the LLM call can take many seconds.
pub async fn plan_refinement(
    messages: &[AgentMessage],
    state: &HarnessState,
    history: &[RefinementResult],
    model: &pa_types::ai::Model,
    options: &RefineOptions,
    refine_call: RefinerFn,
) -> anyhow::Result<RefinementPlan> {
    let id = generate_refinement_id();
    if let Some(rollback_id) = &options.rollback_id {
        let Some(target) = history.iter().find(|item| &item.id == rollback_id) else {
            anyhow::bail!("Refinement {rollback_id} not found");
        };
        let fallback_scope = if options.global {
            HarnessScope::Global
        } else {
            HarnessScope::Local
        };
        return Ok(RefinementPlan {
            proposal: rollback_proposal(target),
            id,
            rollback_of: Some(target.id.clone()),
            rollback_scope: Some(infer_refinement_result_scope(target).unwrap_or(fallback_scope)),
        });
    }

    let conversation_text = conversation_text(messages, 80_000);
    let scope_instruction = if options.global {
        "Requested refinement scope: global. Only propose stable cross-session continual harness edits, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts that should affect future Prime Agent sessions. Do not persist session-only progress, temporary blockers, or current-run coordination globally."
    } else {
        "Requested refinement scope: local. Prefer local continual harness edits for current task progress, temporary blockers, current-run coordination, and project facts that are not clearly reusable across Prime Agent sessions. Global entries in the overview are read-only context: do not propose update or delete edits for them; create a local entry instead if an override is needed."
    };
    let build_prompt = |conversation: &str| -> String {
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
    };
    let (request_max_tokens, user_prompt) = refinement_request(
        model,
        super::planner::REFINEMENT_SYSTEM_PROMPT,
        &conversation_text,
        &build_prompt,
        REFINEMENT_MAX_OUTPUT_TOKENS,
    )?;
    let mut request_model = model.clone();
    request_model.max_tokens = request_max_tokens.min(REFINEMENT_MAX_OUTPUT_TOKENS);

    let reply = refine_call(request_model, REFINEMENT_SYSTEM_PROMPT, user_prompt).await?;
    let text = assistant_text(&reply);
    Ok(RefinementPlan {
        proposal: parse_proposal(&text).map_err(anyhow::Error::msg)?,
        id,
        rollback_of: None,
        rollback_scope: None,
    })
}

fn assistant_text(reply: &AssistantMessage) -> String {
    reply
        .content
        .iter()
        .filter_map(|block| match block {
            pa_types::ai::AssistantContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Apply a plan to the (re-read) harness state.
pub fn apply_refinement_plan(
    state: &mut HarnessState,
    plan: RefinementPlan,
    options: &RefineOptions,
    baseline_state: Option<HarnessState>,
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
        },
    )
}

/// The auto-refine review verdict.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct AutoRefineReview {
    pub should_refine: bool,
    pub rationale: String,
    pub instructions: Option<String>,
}

/// Context for an auto-refine review checkpoint.
pub struct AutoRefineReviewContext {
    pub reason: String,
    pub turns_since_last_review: u32,
}

fn parse_auto_refine_review(text: &str) -> anyhow::Result<AutoRefineReview> {
    let value = super::planner::extract_json_object(text).map_err(anyhow::Error::msg)?;
    let record = value.as_object().cloned().unwrap_or_default();
    Ok(AutoRefineReview {
        should_refine: record.get("shouldRefine") == Some(&serde_json::Value::Bool(true)),
        rationale: record
            .get("rationale")
            .and_then(|value| value.as_str())
            .unwrap_or("No rationale provided.")
            .to_string(),
        instructions: record
            .get("instructions")
            .and_then(|value| value.as_str())
            .map(std::string::ToString::to_string),
    })
}

/// The automatic /refine review gate.
pub async fn review_auto_refine(
    messages: &[AgentMessage],
    state: &HarnessState,
    history: &[RefinementResult],
    model: &pa_types::ai::Model,
    context: &AutoRefineReviewContext,
    review_call: RefinerFn,
) -> anyhow::Result<AutoRefineReview> {
    let conversation_text = conversation_text(messages, 40_000);
    let build_prompt = |conversation: &str| -> String {
        [
            format!(
                "<trigger>\n{}; {} assistant turns since last auto-refine review\n</trigger>",
                context.reason, context.turns_since_last_review
            ),
            format!(
                "<current_harness_state>\n{}\n</current_harness_state>",
                overview_for_prompt(state)
            ),
            format!(
                "<refinement_history>\n{}\n</refinement_history>",
                history_for_prompt(history)
            ),
            format!("<conversation>\n{conversation}\n</conversation>"),
            "Return shouldRefine=true when the trajectory contains evidence useful to this session's future turns. Prefer local harness edits for current task progress, temporary blockers, and current-run coordination. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified lessons likely to be reused in future sessions.".to_string(),
        ]
        .join("\n\n")
    };
    let (request_max_tokens, user_prompt) = refinement_request(
        model,
        AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
        &conversation_text,
        &build_prompt,
        AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS,
    )?;
    let mut request_model = model.clone();
    request_model.max_tokens = request_max_tokens.min(AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS);
    let reply = review_call(request_model, AUTO_REFINE_REVIEW_SYSTEM_PROMPT, user_prompt).await?;
    parse_auto_refine_review(&assistant_text(&reply))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::ai::{AssistantContentBlock, TextContent};

    fn text_message(text: &str) -> AssistantMessage {
        AssistantMessage {
            content: vec![AssistantContentBlock::Text(TextContent {
                text: text.to_string(),
                text_signature: None,
                rest: Default::default(),
            })],
            api: "openai-completions".to_string(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Default::default(),
            stop_reason: pa_types::ai::StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: Default::default(),
        }
    }

    fn seam(text: &str) -> RefinerFn {
        let text = text.to_string();
        Box::new(move |_model, _system, _prompt| {
            let text = text;
            Box::pin(async move { Ok(text_message(&text)) })
        })
    }

    /// The two refiner calls carry their own system prompts (TS sends the
    /// review-gate prompt for the auto-refine review, the `/refine`
    /// subsystem prompt for the plan).
    #[tokio::test]
    async fn review_and_plan_carry_their_own_system_prompts() {
        let model = test_model();
        // The review seam records its system prompt in a shared cell.
        let review_systems: std::sync::Arc<std::sync::Mutex<Vec<&'static str>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let review_recorder = std::sync::Arc::clone(&review_systems);
        let review_call: RefinerFn = Box::new(move |_model, system, _prompt| {
            review_recorder.lock().unwrap().push(system);
            Box::pin(async move {
                Ok(text_message(
                    r#"{"shouldRefine": false, "rationale": "no"}"#,
                ))
            })
        });
        let review = review_auto_refine(
            &[],
            &super::super::empty_harness_state(),
            &[],
            &model,
            &AutoRefineReviewContext {
                reason: "compact".to_string(),
                turns_since_last_review: 0,
            },
            review_call,
        )
        .await
        .unwrap();
        assert!(!review.should_refine);
        assert_eq!(
            *review_systems.lock().unwrap(),
            vec![AUTO_REFINE_REVIEW_SYSTEM_PROMPT]
        );
        // The plan seam likewise.
        let plan_systems: std::sync::Arc<std::sync::Mutex<Vec<&'static str>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let plan_recorder = std::sync::Arc::clone(&plan_systems);
        let reply = r#"{"summary":"s","edits":[]}"#.to_string();
        let plan_call: RefinerFn = Box::new(move |_model, system, _prompt| {
            plan_recorder.lock().unwrap().push(system);
            let reply = reply;
            Box::pin(async move { Ok(text_message(&reply)) })
        });
        let state = super::super::empty_harness_state();
        plan_refinement(
            &[],
            &state,
            &[],
            &model,
            &RefineOptions::default(),
            plan_call,
        )
        .await
        .unwrap();
        assert_eq!(
            *plan_systems.lock().unwrap(),
            vec![REFINEMENT_SYSTEM_PROMPT]
        );
    }

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
                    reference: Default::default(),
                    arguments: Default::default(),
                    metadata: Default::default(),
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

    #[tokio::test]
    async fn plan_parses_proposal_and_rolls_back() {
        let state = super::super::empty_harness_state();
        let reply = r#"{"summary":"note it","rationale":"seen twice","expectedOutcome":"recall","edits":[{"action":"create","kind":"memory","id":"m2","title":"Note","content":"value"}]}"#;
        let plan = plan_refinement(
            &[],
            &state,
            &[],
            &test_model(),
            &RefineOptions::default(),
            seam(reply),
        )
        .await
        .unwrap();
        assert_eq!(plan.proposal.summary, "note it");
        assert_eq!(plan.proposal.edits.len(), 1);
        // Rollback path finds the target and builds the inverse proposal.
        let mut history_state = state.clone();
        let result = apply_refinement_proposal(
            &mut history_state,
            &RefinementProposal {
                summary: "add".to_string(),
                ..Default::default()
            },
            ApplyOptions {
                id: "refine_target".to_string(),
                rollback_of: None,
                scope: Some(HarnessScope::Local),
                baseline_state: None,
            },
        );
        let rollback = plan_refinement(
            &[],
            &state,
            &[result],
            &test_model(),
            &RefineOptions {
                rollback_id: Some("refine_target".to_string()),
                ..Default::default()
            },
            seam("{}"),
        )
        .await
        .unwrap();
        assert_eq!(rollback.rollback_of.as_deref(), Some("refine_target"));
        assert_eq!(rollback.proposal.edits.len(), 0); // the seeded result applied no edits, so nothing inverts
                                                      // Unknown rollback target errors.
        let missing = plan_refinement(
            &[],
            &state,
            &[],
            &test_model(),
            &RefineOptions {
                rollback_id: Some("nope".to_string()),
                ..Default::default()
            },
            seam("{}"),
        )
        .await;
        assert!(missing.is_err());
    }

    #[tokio::test]
    async fn auto_refine_review_parses_verdict() {
        let state = super::super::empty_harness_state();
        let review = review_auto_refine(
            &[],
            &state,
            &[],
            &test_model(),
            &AutoRefineReviewContext {
                reason: "checkpoint".to_string(),
                turns_since_last_review: 4,
            },
            seam(r#"{"shouldRefine":true,"rationale":"pattern seen","instructions":"note the tactic"}"#),
        )
        .await
        .unwrap();
        assert!(review.should_refine);
        assert_eq!(review.rationale, "pattern seen");
        assert_eq!(review.instructions.as_deref(), Some("note the tactic"));
        let rejected = review_auto_refine(
            &[],
            &state,
            &[],
            &test_model(),
            &AutoRefineReviewContext {
                reason: "checkpoint".to_string(),
                turns_since_last_review: 1,
            },
            seam(r#"{"shouldRefine":false}"#),
        )
        .await
        .unwrap();
        assert!(!rejected.should_refine);
        assert_eq!(rejected.rationale, "No rationale provided.");
        assert_eq!(rejected.instructions, None);
    }

    fn test_model() -> pa_types::ai::Model {
        pa_types::ai::Model {
            id: "test".to_string(),
            name: "test".to_string(),
            api: "openai-completions".to_string(),
            provider: "test".to_string(),
            base_url: "https://example.invalid".to_string(),
            reasoning: false,
            thinking_level_map: None,
            input: vec![],
            cost: pa_types::ai::ModelCost {
                input: 0.0.into(),
                output: 0.0.into(),
                cache_read: 0.0.into(),
                cache_write: 0.0.into(),
            },
            context_window: 100_000,
            max_tokens: 8_000,
            featured: None,
            headers: None,
            compat: None,
        }
    }
}
