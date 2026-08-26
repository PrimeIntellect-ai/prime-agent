import type { Api, Model } from "@earendil-works/pi-ai";

export const AGENT_RUN_MODEL_SCOPE_VERSION = 1 as const;

export interface AgentRunRequestAuth {
	readonly apiKey?: string;
	readonly headers?: Readonly<Record<string, string>>;
}

export interface AgentRunRequestAuthContext {
	readonly executionId: string;
	readonly signal: AbortSignal;
}

export type AgentRunRequestAuthResolver = (
	model: Model<Api>,
	context: AgentRunRequestAuthContext,
) => AgentRunRequestAuth | Promise<AgentRunRequestAuth>;

const agentRunModelScopeBrand = Symbol("AgentRunModelScope");
const agentRunModelAuthBrand = Symbol("AgentRunModelAuth");

/** A factory-minted, single-run model and request-auth capability. */
export interface AgentRunModelScope {
	readonly version: typeof AGENT_RUN_MODEL_SCOPE_VERSION;
	readonly root: Model<Api>;
	readonly models: readonly Model<Api>[];
	readonly [agentRunModelScopeBrand]: true;
}

function modelIdentity(model: Model<Api>): string {
	return `${model.provider}\0${model.id}`;
}

function exactModelIdentity(model: Model<Api>): string {
	return `${modelIdentity(model)}\0${model.api}\0${model.baseUrl}`;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function immutableModel(model: Model<Api>): Model<Api> {
	return deepFreeze(structuredClone(model));
}

class AgentRunModelScopeCapability implements AgentRunModelScope {
	readonly version = AGENT_RUN_MODEL_SCOPE_VERSION;
	readonly root: Model<Api>;
	readonly models: readonly Model<Api>[];
	readonly [agentRunModelScopeBrand] = true;
	#active = true;
	readonly #resolveRequestAuth: AgentRunRequestAuthResolver;

	constructor(root: Model<Api>, models: readonly Model<Api>[], resolver: AgentRunRequestAuthResolver) {
		this.root = root;
		this.models = models;
		this.#resolveRequestAuth = resolver;
		Object.freeze(this);
	}

	assertActive(): void {
		if (!this.#active) throw new Error("Agent run model scope is revoked");
	}

	resolveRequestAuth(
		model: Model<Api>,
		context: AgentRunRequestAuthContext,
	): AgentRunRequestAuth | Promise<AgentRunRequestAuth> {
		this.assertActive();
		return this.#resolveRequestAuth(model, context);
	}

	revoke(): void {
		this.#active = false;
	}
}

export function createAgentRunModelScope(input: {
	readonly version: typeof AGENT_RUN_MODEL_SCOPE_VERSION;
	readonly root: Model<Api>;
	readonly models: readonly Model<Api>[];
	readonly resolveRequestAuth: AgentRunRequestAuthResolver;
}): AgentRunModelScope {
	if (input.version !== AGENT_RUN_MODEL_SCOPE_VERSION) throw new Error("Unsupported agent run model scope version");
	if (input.models.length < 1) throw new Error("Agent run model scope requires at least one model");
	if (typeof input.resolveRequestAuth !== "function") throw new Error("Agent run model scope requires request auth");
	const models = input.models.map(immutableModel);
	const identities = new Set<string>();
	for (const model of models) {
		const identity = modelIdentity(model);
		if (identities.has(identity))
			throw new Error(`Agent run model scope contains duplicate model ${model.provider}/${model.id}`);
		identities.add(identity);
	}
	const root = models.find((model) => exactModelIdentity(model) === exactModelIdentity(input.root));
	if (!root) throw new Error("Agent run model scope root must belong to its ordered model roster");
	return new AgentRunModelScopeCapability(root, Object.freeze(models), input.resolveRequestAuth);
}

export function assertAgentRunModelScope(value: unknown): asserts value is AgentRunModelScope {
	if (!(value instanceof AgentRunModelScopeCapability)) {
		throw new Error("Agent run model scope is not a factory-created capability");
	}
	value.assertActive();
}

export function findAgentRunScopedModel(
	scope: AgentRunModelScope,
	provider: string,
	modelId: string,
): Model<Api> | undefined {
	assertAgentRunModelScope(scope);
	return scope.models.find((model) => model.provider === provider && model.id === modelId);
}

export async function resolveAgentRunRequestAuth(
	scope: AgentRunModelScope,
	model: Model<Api>,
	context: AgentRunRequestAuthContext,
): Promise<AgentRunRequestAuth> {
	assertAgentRunModelScope(scope);
	const selected = findAgentRunScopedModel(scope, model.provider, model.id);
	if (!selected) throw new Error(`Model ${model.provider}/${model.id} is outside the admitted run scope`);
	context.signal.throwIfAborted();
	const auth = await (scope as AgentRunModelScopeCapability).resolveRequestAuth(selected, context);
	assertAgentRunModelScope(scope);
	context.signal.throwIfAborted();
	return Object.freeze({
		...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
		...(auth.headers === undefined ? {} : { headers: Object.freeze({ ...auth.headers }) }),
	});
}

export function revokeAgentRunModelScope(scope: AgentRunModelScope): void {
	if (scope instanceof AgentRunModelScopeCapability) scope.revoke();
}

export function markAgentRunModelAuth<T extends object>(options: T): T {
	return Object.defineProperty(options, agentRunModelAuthBrand, { value: true });
}

export function hasAgentRunModelAuth(options: unknown): boolean {
	return typeof options === "object" && options !== null && agentRunModelAuthBrand in options;
}
