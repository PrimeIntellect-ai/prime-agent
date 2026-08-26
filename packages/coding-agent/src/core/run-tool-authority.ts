export const AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION = 1 as const;

export interface AgentRunToolAuthorizationContext {
	readonly executionId: string;
	readonly runContext: unknown;
	readonly recursionDepth: number;
	readonly signal: AbortSignal;
}

export interface AgentRunToolAuthorizationRequest {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: unknown;
	readonly context: AgentRunToolAuthorizationContext;
}

export type AgentRunToolAuthorizationDecision =
	| { readonly decision: "allow" }
	| { readonly decision: "deny"; readonly reason?: string };

export type AgentRunToolAuthorizer = (
	request: AgentRunToolAuthorizationRequest,
) => AgentRunToolAuthorizationDecision | Promise<AgentRunToolAuthorizationDecision>;

const agentRunToolAuthorityScopeBrand = Symbol("AgentRunToolAuthorityScope");

/** A factory-minted, single-run capability for host authorization of tool calls. */
export interface AgentRunToolAuthorityScope {
	readonly version: typeof AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION;
	readonly [agentRunToolAuthorityScopeBrand]: true;
}

function immutableArgs(value: unknown): unknown {
	const clone = structuredClone(value);
	if (typeof clone !== "object" || clone === null) return clone;
	const pending: object[] = [clone];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || Object.isFrozen(current)) continue;
		for (const child of Object.values(current)) {
			if (typeof child === "object" && child !== null) pending.push(child);
		}
		Object.freeze(current);
	}
	return clone;
}

class AgentRunToolAuthorityScopeCapability implements AgentRunToolAuthorityScope {
	readonly version = AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION;
	readonly [agentRunToolAuthorityScopeBrand] = true;
	#active = true;
	readonly #authorize: AgentRunToolAuthorizer;

	constructor(authorize: AgentRunToolAuthorizer) {
		this.#authorize = authorize;
		Object.freeze(this);
	}

	assertActive(): void {
		if (!this.#active) throw new Error("Agent run tool-authority scope is revoked");
	}

	authorize(
		request: AgentRunToolAuthorizationRequest,
	): AgentRunToolAuthorizationDecision | Promise<AgentRunToolAuthorizationDecision> {
		this.assertActive();
		return this.#authorize(request);
	}

	revoke(): void {
		this.#active = false;
	}
}

export function createAgentRunToolAuthorityScope(input: {
	readonly version: typeof AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION;
	readonly authorize: AgentRunToolAuthorizer;
}): AgentRunToolAuthorityScope {
	if (input.version !== AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION) {
		throw new Error("Unsupported agent run tool-authority scope version");
	}
	if (typeof input.authorize !== "function") {
		throw new Error("Agent run tool-authority scope requires an authorizer");
	}
	return new AgentRunToolAuthorityScopeCapability(input.authorize);
}

export function assertAgentRunToolAuthorityScope(value: unknown): asserts value is AgentRunToolAuthorityScope {
	if (!(value instanceof AgentRunToolAuthorityScopeCapability)) {
		throw new Error("Agent run tool-authority scope is not a factory-created capability");
	}
	value.assertActive();
}

export async function authorizeAgentRunToolCall(
	scope: AgentRunToolAuthorityScope,
	request: AgentRunToolAuthorizationRequest,
): Promise<AgentRunToolAuthorizationDecision> {
	assertAgentRunToolAuthorityScope(scope);
	request.context.signal.throwIfAborted();
	const decision = await (scope as AgentRunToolAuthorityScopeCapability).authorize(
		Object.freeze({
			toolCallId: request.toolCallId,
			toolName: request.toolName,
			args: immutableArgs(request.args),
			context: Object.freeze({ ...request.context }),
		}),
	);
	assertAgentRunToolAuthorityScope(scope);
	request.context.signal.throwIfAborted();
	if (decision.decision === "allow") return Object.freeze({ decision: "allow" });
	if (decision.decision === "deny") {
		return Object.freeze({ decision: "deny", ...(decision.reason === undefined ? {} : { reason: decision.reason }) });
	}
	throw new Error("Agent run tool authorizer returned an invalid decision");
}

export function revokeAgentRunToolAuthorityScope(scope: AgentRunToolAuthorityScope): void {
	if (scope instanceof AgentRunToolAuthorityScopeCapability) scope.revoke();
}
