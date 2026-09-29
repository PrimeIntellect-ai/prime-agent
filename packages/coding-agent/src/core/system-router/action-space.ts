import {
	ESCALATE_ACTION,
	FINISH_ACTION,
	type RouterActionSpec,
	type RouterGateSpec,
	type RouterObservation,
	resolveGate,
} from "./types.js";

/** fnv1a (32-bit, 8 hex chars) digest for repeated-state detection. */
export function observationDigest(observation: RouterObservation): string {
	// Canonicalized (recursively key-sorted) so identical observations with
	// differently-ordered fields produce the same digest.
	const material = JSON.stringify(
		{
			text: observation.text,
			fields: observation.fields ?? null,
			...(observation.image ? { image: observation.image } : {}),
		},
		(_key, value) =>
			value !== null && typeof value === "object" && !Array.isArray(value)
				? Object.fromEntries(
						Object.keys(value)
							.sort()
							.map((key) => [key, value[key]]),
					)
				: value,
	);
	let hash = 0x811c9dc5;
	for (let i = 0; i < material.length; i += 1) {
		hash ^= material.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

export function truncateObservation(text: string, budget: number): string {
	if (text.length <= budget) return text;
	const marker = "\n<observation truncated>";
	return `${text.slice(0, Math.max(0, budget - marker.length))}${marker}`;
}

export interface CompiledAction {
	name: string;
	description: string;
	risk: "read" | "write" | "destructive";
	params: Record<string, { choices: Record<string, string> }>;
}

export function compileActionSpace(actions: Record<string, RouterActionSpec>): {
	actionNames: string[];
	byName: Map<string, CompiledAction>;
} {
	const byName = new Map<string, CompiledAction>();
	for (const name of Object.keys(actions)) {
		if (name === FINISH_ACTION || name === ESCALATE_ACTION) {
			throw new Error(`action name "${name}" is reserved for the loop itself`);
		}
	}
	for (const [name, spec] of Object.entries(actions)) {
		byName.set(name, {
			name,
			description: spec.description,
			risk: spec.risk ?? "write",
			params: spec.params ?? {},
		});
	}
	byName.set(FINISH_ACTION, {
		name: FINISH_ACTION,
		description: "Declare the goal reached and stop the loop now.",
		risk: "read",
		params: {},
	});
	byName.set(ESCALATE_ACTION, {
		name: ESCALATE_ACTION,
		description: "Stop the loop and hand control back to the supervising model for a new plan.",
		risk: "read",
		params: {},
	});
	const actionNames = [...byName.keys()];
	return { actionNames, byName };
}

export function gateThreshold(gate: RouterGateSpec, action: CompiledAction): number {
	const resolved = resolveGate(gate);
	// The escalation door is never gated: a System 1 model asking System 2
	// for help must always be honored (SystemOneHarness "escalate" semantics).
	if (action.name === ESCALATE_ACTION) return 0;
	if (action.name === FINISH_ACTION) return resolved.finish;
	return resolved[action.risk];
}

function renderAction(action: CompiledAction): string {
	const params = Object.entries(action.params).map(([paramName, param]) => {
		const choices = Object.entries(param.choices)
			.map(([value, description]) => `"${value}" (${description})`)
			.join(", ");
		return `    param "${paramName}": one of ${choices}`;
	});
	return [`- ${action.name} [risk=${action.risk}]: ${action.description}`, ...params].join("\n");
}

/** One line of bounded history, e.g. `press_a(frames="8") -> screen advanced`. */
export function formatHistoryEntry(action: string, params: Record<string, string>, result: string): string {
	const renderedParams = Object.entries(params)
		.map(([key, value]) => `${key}="${value}"`)
		.join(", ");
	const suffix = result.length > 160 ? `${result.slice(0, 157)}...` : result;
	return `${action}(${renderedParams}) -> ${suffix}`;
}

/**
 * Compile the typed question the System 1 model answers: one choice over the
 * declared action space with its finite parameter values, plus the confidence
 * attached to that choice. One model call per step; no free-form output.
 */
export function compileDecisionPrompt(input: {
	goal: string;
	observation: RouterObservation;
	history: string[];
	actions: Map<string, CompiledAction>;
	observationChars: number;
}): string {
	const fieldLines = Object.entries(input.observation.fields ?? {}).map(([key, value]) => `${key}: ${String(value)}`);
	// The budget bounds the whole rendered observation (text plus fields), not
	// just the text: both halves ride the same prompt the model reads.
	const text = truncateObservation(input.observation.text, Math.max(0, Math.floor(input.observationChars / 2)));
	const fieldsBudget = input.observationChars - text.length;
	const keptFields: string[] = [];
	let fieldsUsed = 0;
	for (const line of fieldLines) {
		if (fieldsUsed + line.length + 1 > Math.max(0, fieldsBudget - 40)) break;
		keptFields.push(line);
		fieldsUsed += line.length + 1;
	}
	const fieldsBlock =
		keptFields.length === fieldLines.length
			? keptFields.join("\n")
			: `${keptFields.join("\n")}${keptFields.length ? "\n" : ""}<${fieldLines.length - keptFields.length} more fields truncated>`;
	const observationText = [text, fieldsBlock].filter(Boolean).join("\n");
	const history = input.history.length > 0 ? input.history.join("\n") : "<no steps yet>";
	const actions = [...input.actions.values()].map(renderAction).join("\n");
	return [
		`GOAL\n${input.goal}`,
		"",
		`OBSERVATION\n${observationText || "<no observation>"}`,
		"",
		`HISTORY (oldest first)\n${history}`,
		"",
		`AVAILABLE ACTIONS (choose exactly one)\n${actions}`,
		"",
		'Reply with ONE JSON object and nothing else:\n{"action": "<action name>", "params": {"<param>": "<value>"}, "confidence": <number 0.0-1.0>}\nUse only listed action names and listed parameter values. Omit "params" when the action has none. "confidence" is your probability that this action is the correct next step.',
	].join("\n");
}
