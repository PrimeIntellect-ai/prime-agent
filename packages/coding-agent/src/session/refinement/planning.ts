import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import type { ProviderRetryPolicy } from "../../core/provider-retry.js";
import { completeWithProviderRetry } from "../../core/provider-retry.js";
import { getAuxiliaryThinkingLevel } from "../../core/thinking-levels.js";
import { serializeConversation } from "../context/conversation-text.js";
import { convertToLlm } from "../context/messages.js";
import { historyForPrompt, overviewForPrompt } from "./format.js";
import {
	applyRefinementProposal,
	generateRefinementId,
	inferRefinementResultScope,
	normalizeRefinementProposal,
	rollbackProposal,
} from "./harness-state.js";
import type {
	AutoRefineReview,
	AutoRefineReviewContext,
	HarnessScope,
	HarnessState,
	RefinementPlan,
	RefinementProposal,
	RefinementResult,
	RefineOptions,
} from "./types.js";

const REFINEMENT_SYSTEM_PROMPT = `You are Prime Agent's /refine continual harness subsystem.

Your job is to improve the editable continual harness state from the current trajectory.
This is similar in spirit to context compaction, but instead of summarizing the
conversation you emit precise Create, Update, or Delete edits to reusable state.
The continual harness is the persistent, editable set of prompt notes, memories,
skills, and subagent specs that lets Prime Agent improve reusable behavior
outside the token history.
Use "continual harness" for that persistent artifact layer; keep "RLM" for the
runtime, Python REPL kernel, and native call interface that executes those artifacts.

Continual harness components:
- prompt: supplemental prompt notes only. The base system prompt is immutable and MUST NOT be rewritten.
- memory: durable facts, decisions, failures, preferences, and outcomes.
- skill: installed Python REPL skill. Skill create/update edits MUST include a \`reference\` object with \`{"type":"python"}\`, a Python import, and a callable or call pattern; they also MUST include an \`arguments\` object describing accepted inputs, required fields, defaults, and constraints. Use \`{}\` for \`arguments\` only when the Python callable truly needs no external inputs. Include the RLM-native call form \`await <skill_import>(...)\`.
- subagent: reusable delegation specs, including purpose, instructions, and when to invoke. Include the RLM-native call form: compose a concise task prompt and spawn with \`handle = await rlm.spawn("sub-task", name="worker")\`; admission returns immediately with \`rlm_child_id\`, \`name\`, \`session_dir\`, and \`model\`, never the child's answer. Results arrive only through explicit \`agent_message\` replies or files; children reply with \`await agent_message.send(message, receiver_role="parent")\`. Use \`await rlm.list_subagents()\` to recover direct child handles and \`await agent_message.send(..., receiver_role="child", receiver_name=handle.name)\` for follow-ups. Do not invent wrappers like \`run_subagent(...)\`.

Scope and persistence policy:
- The default editable continual harness store is local to the current Prime Agent session. Use it for session-specific progress, active task state, current-run coordination notes, temporary blockers, and project facts that should not affect other sessions.
- A caller may explicitly request global refinement. Global edits must be stable cross-session lessons, durable user preferences, reusable skills/subagents, or tool/environment facts that should affect future sessions.
- Entry ids in the harness overview may carry a display-only \`local:\` or \`global:\` prefix. Always use the bare id (no prefix) in edits.
- All edits in one refinement apply only to the requested scope's store. During a local refinement, global entries are read-only context: never propose update or delete edits for them; create a local entry instead when a session-specific override is genuinely needed.
- Project/workspace-specific lessons may be persisted globally only when the title, path, or content explicitly names the project/workspace and the lesson is likely to be reused in future sessions for that project. Prefer local edits when the lesson only belongs in the current conversation.
- Use memory for declarative facts and preferences, skill for repeatable procedures exposed as Python calls, prompt for narrow behavioral policy addendums, and subagent for reusable delegation roles.
- Create or update the smallest relevant component: repeated delegation roles should become subagent specs, repeated procedures should become skills, durable facts/preferences should become memories, and narrow behavioral policies should become prompt addendums.
- When an edit is persisted, include metadata such as \`{"scope":"local"}\` or \`{"scope":"global"}\` when that helps future review understand the intended blast radius.

Use the trajectory, current continual harness state, and prior refinement history. Prefer
small evidence-backed edits. If prior refinements caused issues, rollback or
replace the faulty editable entries. Never edit source files directly. Output
JSON only with this exact shape:

{
  "summary": "one sentence",
  "rationale": "why these edits are justified by trajectory evidence",
  "expectedOutcome": "what should improve and how to validate it",
  "edits": [
    {
      "action": "create|update|delete",
      "kind": "prompt|memory|skill|subagent",
      "id": "stable id for update/delete, optional for create",
      "title": "required for create/update except delete",
      "content": "required for create/update except delete",
      "path": "optional grouping path",
      "reference": {"type": "python", "import": "package.module", "callable": "function_name", "call_pattern": "await function_name(...)"},
      "arguments": {"name": {"type": "string", "required": true, "description": "accepted input"}},
      "metadata": {},
      "reason": "why this edit is useful"
    }
  ]
}`;

const AUTO_REFINE_REVIEW_SYSTEM_PROMPT = `You are Prime Agent's automatic /refine review gate.

Decide whether this checkpoint should run /refine. Auto /refine writes local continual harness state by default, so approve when the trajectory contains evidence useful to this session's future turns.
Reject one-off noise, unsupported hypotheses, and transient tool outputs. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified lessons likely to be reused in future sessions.

Return JSON only:
{
  "shouldRefine": true|false,
  "rationale": "short reason",
  "instructions": "optional concise instructions for /refine if shouldRefine is true"
}`;

// These caps apply only with reasoning off; thinking and JSON otherwise share the model's output budget.

const REFINEMENT_MAX_OUTPUT_TOKENS = 32_000;

const AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS = 4_096;

const REFINEMENT_CONTEXT_OVERHEAD_TOKENS = 1_024;

const TRUNCATED_JSON_ERROR =
	"the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

function refinementInputTokenBound(text: string): number {
	// One token per UTF-8 byte bounds byte-based tokenizers, including dense or unusual text.
	return Buffer.byteLength(text, "utf8");
}

function refinementRequest(
	model: Model<Api>,
	systemPrompt: string,
	conversationText: string,
	buildPrompt: (conversation: string) => string,
	outputReserve: number,
): { model: Model<Api>; userPrompt: string } {
	const systemReserve = refinementInputTokenBound(systemPrompt) + REFINEMENT_CONTEXT_OVERHEAD_TOKENS;
	const inputBudget =
		model.contextWindow - Math.min(model.maxTokens, outputReserve, Math.floor(model.contextWindow / 2));
	let userPrompt = buildPrompt(conversationText);
	if (systemReserve + refinementInputTokenBound(userPrompt) > inputBudget && conversationText.length > 0) {
		const promptForLength = (length: number): string => {
			let start = conversationText.length - length;
			const first = conversationText.charCodeAt(start);
			if (first >= 0xdc00 && first <= 0xdfff) start++;
			return buildPrompt(
				`[Earlier conversation omitted to fit the model context.]\n${conversationText.slice(start)}`,
			);
		};
		let low = 0;
		let high = conversationText.length;
		while (low < high) {
			const length = Math.ceil((low + high) / 2);
			if (systemReserve + refinementInputTokenBound(promptForLength(length)) <= inputBudget) low = length;
			else high = length - 1;
		}
		userPrompt = promptForLength(low);
	}
	const maxTokens = Math.min(
		model.maxTokens,
		model.contextWindow - systemReserve - refinementInputTokenBound(userPrompt),
	);
	if (maxTokens <= 0) {
		throw new Error(
			"Refinement prompt leaves no room for output in the model's context window; retry with a smaller request.",
		);
	}
	// Bound the request's model ceiling too: some adapters add thinking tokens before clamping to it.
	return { model: { ...model, maxTokens }, userPrompt };
}

/**
 * Whether a JSON candidate ends mid-value: an unterminated string, or unclosed
 * objects/arrays. A reply cut off by an exhausted output budget is incomplete in
 * this sense, while a complete-but-malformed reply is balanced. Brace slicing can
 * also produce a balanced fragment, so callers treat "balanced" as malformed.
 */
function isIncompleteJson(candidate: string): boolean {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (const char of candidate) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") depth--;
	}
	return inString || depth > 0;
}

function parseJsonCandidate(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch (error) {
		// A truncated reply and a malformed one both fail here, and JSON.parse
		// describes the fragment rather than the cause. Name the cause instead.
		if (isIncompleteJson(candidate)) {
			throw new Error(TRUNCATED_JSON_ERROR);
		}
		throw new Error(`the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		// A reply truncated after a nested closing brace still looks well-formed
		// here, so this path needs the same diagnosis as the slicing fallback.
		return parseJsonCandidate(trimmed);
	}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		return parseJsonCandidate(fenced[1].trim());
	}
	// Brace slicing recovers JSON wrapped in prose. On a reply truncated inside the
	// edits array it slices to an earlier edit's closing brace, so a failure here
	// is diagnosed against the original text rather than the balanced fragment.
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			return parseJsonCandidate(trimmed.slice(start));
		}
	}
	if (isIncompleteJson(trimmed)) {
		throw new Error(TRUNCATED_JSON_ERROR);
	}
	throw new Error("Refiner did not return a JSON object");
}

function parseProposal(text: string): RefinementProposal {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Refiner JSON must be an object");
	}
	return normalizeRefinementProposal(value);
}

export async function planRefinement(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	options: RefineOptions = {},
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<RefinementPlan> {
	const id = generateRefinementId();
	if (options.rollbackId) {
		const target = history.find((item) => item.id === options.rollbackId);
		if (!target) {
			throw new Error(`Refinement ${options.rollbackId} not found`);
		}
		const fallbackScope: HarnessScope = options.global ? "global" : "local";
		return {
			proposal: rollbackProposal(target),
			id,
			rollbackOf: target.id,
			rollbackScope: inferRefinementResultScope(target) ?? fallbackScope,
		};
	}

	const conversationText = serializeConversation(convertToLlm(messages)).slice(-80_000);
	const scopeInstruction = options.global
		? "Requested refinement scope: global. Only propose stable cross-session continual harness edits, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts that should affect future Prime Agent sessions. Do not persist session-only progress, temporary blockers, or current-run coordination globally."
		: "Requested refinement scope: local. Prefer local continual harness edits for current task progress, temporary blockers, current-run coordination, and project facts that are not clearly reusable across Prime Agent sessions. Global entries in the overview are read-only context: do not propose update or delete edits for them; create a local entry instead if an override is needed.";
	const buildPrompt = (conversation: string): string =>
		[
			`<current_harness_state>\n${overviewForPrompt(state)}\n</current_harness_state>`,
			`<refinement_history>\n${historyForPrompt(history)}\n</refinement_history>`,
			`<conversation>\n${conversation}\n</conversation>`,
			`<scope_policy>\n${scopeInstruction}\n</scope_policy>`,
			options.instructions ? `<user_refine_instructions>\n${options.instructions}\n</user_refine_instructions>` : "",
			"Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
		]
			.filter(Boolean)
			.join("\n\n");
	const reasoning = getAuxiliaryThinkingLevel(model, thinkingLevel);
	const { model: requestModel, userPrompt } = refinementRequest(
		model,
		REFINEMENT_SYSTEM_PROMPT,
		conversationText,
		buildPrompt,
		reasoning === "off" ? REFINEMENT_MAX_OUTPUT_TOKENS : model.maxTokens,
	);
	const maxTokens =
		reasoning === "off" ? Math.min(requestModel.maxTokens, REFINEMENT_MAX_OUTPUT_TOKENS) : requestModel.maxTokens;

	const response = await completeWithProviderRetry(
		() =>
			completeSimple(
				requestModel,
				{
					systemPrompt: REFINEMENT_SYSTEM_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
				},
				{
					reasoning,
					maxTokens,
					signal,
					apiKey,
					headers,
				},
			),
		{ policy: options.retry, signal },
	);

	if (response.stopReason === "error") {
		throw new Error(`Refinement failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "length") {
		throw new Error(`Refinement failed: ${TRUNCATED_JSON_ERROR}`);
	}

	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return { proposal: parseProposal(text), id };
}

function parseAutoRefineReview(text: string): AutoRefineReview {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Auto-refine review JSON must be an object");
	}
	const record = value as Record<string, unknown>;
	return {
		shouldRefine: record.shouldRefine === true,
		rationale: typeof record.rationale === "string" ? record.rationale : "No rationale provided.",
		instructions: typeof record.instructions === "string" ? record.instructions : undefined,
	};
}

export async function reviewAutoRefine(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	context: AutoRefineReviewContext,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	retry?: ProviderRetryPolicy,
): Promise<AutoRefineReview> {
	const conversationText = serializeConversation(convertToLlm(messages)).slice(-40_000);
	const buildPrompt = (conversation: string): string =>
		[
			`<trigger>
${context.reason}; ${context.turnsSinceLastReview} assistant turns since last auto-refine review
</trigger>`,
			`<current_harness_state>
${overviewForPrompt(state)}
</current_harness_state>`,
			`<refinement_history>
${historyForPrompt(history)}
</refinement_history>`,
			`<conversation>
${conversation}
</conversation>`,
			"Return shouldRefine=true when the trajectory contains evidence useful to this session's future turns. Prefer local harness edits for current task progress, temporary blockers, and current-run coordination. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified facts likely to be reused in future sessions.",
		].join("\n\n");
	const reasoning = getAuxiliaryThinkingLevel(model, thinkingLevel);
	const { model: requestModel, userPrompt } = refinementRequest(
		model,
		AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
		conversationText,
		buildPrompt,
		reasoning === "off" ? AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS : model.maxTokens,
	);
	const maxTokens =
		reasoning === "off"
			? Math.min(requestModel.maxTokens, AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS)
			: requestModel.maxTokens;
	const response = await completeWithProviderRetry(
		() =>
			completeSimple(
				requestModel,
				{
					systemPrompt: AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
				},
				{
					reasoning,
					maxTokens,
					signal,
					apiKey,
					headers,
				},
			),
		{ policy: retry, signal },
	);
	if (response.stopReason === "error") {
		throw new Error(`Auto-refine review failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "length") {
		throw new Error(`Auto-refine review failed: ${TRUNCATED_JSON_ERROR}`);
	}
	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return parseAutoRefineReview(text);
}

export async function refineHarness(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	options: RefineOptions = {},
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<RefinementResult> {
	const plan = await planRefinement(messages, state, history, model, apiKey, options, headers, signal, thinkingLevel);
	return applyRefinementProposal(state, plan.proposal, {
		id: plan.id,
		rollbackOf: plan.rollbackOf,
		scope: plan.rollbackScope ?? (options.global ? "global" : "local"),
	});
}
