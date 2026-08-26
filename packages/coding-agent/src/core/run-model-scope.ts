import { type Api, type Model, supportsExplicitRequestAccess } from "@earendil-works/pi-ai";

export const AGENT_RUN_MODEL_SCOPE_VERSION = 1 as const;

export interface AgentRunSecretRequestAccess {
	readonly kind: "secret";
	readonly contract: "secret@1";
	readonly apiKey: string;
	readonly headers?: Readonly<Record<string, string>>;
}

export interface AgentRunManagedRuntimeRequestAccess {
	readonly kind: "managed-runtime";
	readonly contract: "managed-runtime@1";
	readonly executable?: string;
	readonly environment: Readonly<Record<string, string>>;
}

export type AgentRunRequestAccess = AgentRunSecretRequestAccess | AgentRunManagedRuntimeRequestAccess;

export interface AgentRunModelRequestAccess {
	readonly model: Model<Api>;
	readonly access: AgentRunRequestAccess;
}

const agentRunModelScopeBrand = Symbol("AgentRunModelScope");
const agentRunModelAuthBrand = Symbol("AgentRunModelAuth");

/** A factory-minted, single-run model and upfront request-access capability. */
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

function immutableStringRecord(
	value: Readonly<Record<string, string>>,
	label: string,
): Readonly<Record<string, string>> {
	const copy: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key.trim() === "" || typeof entry !== "string") throw new Error(`${label} must contain only string entries`);
		copy[key] = entry;
	}
	return Object.freeze(copy);
}

function normalizeRequestAccess(model: Model<Api>, access: AgentRunRequestAccess): AgentRunSecretRequestAccess {
	if (access.kind === "managed-runtime") {
		if (access.contract !== "managed-runtime@1") {
			throw new Error("Unsupported agent run managed-runtime access contract");
		}
		immutableStringRecord(access.environment, "Agent run managed-runtime environment");
		if (access.executable !== undefined && access.executable.trim() === "") {
			throw new Error("Agent run managed-runtime executable must be non-empty");
		}
		throw new Error(`Agent run api ${model.api} does not support managed-runtime@1 access`);
	}
	if (access.kind !== "secret" || access.contract !== "secret@1") {
		throw new Error("Unsupported agent run request access contract");
	}
	if (!supportsExplicitRequestAccess(model.api)) {
		throw new Error(`Agent run api ${model.api} does not support secret@1 access`);
	}
	let decodedBaseUrl = model.baseUrl;
	for (let pass = 0; pass < 4; pass++) {
		if (/[{}]/.test(decodedBaseUrl)) break;
		try {
			const next = decodeURIComponent(decodedBaseUrl);
			if (next === decodedBaseUrl) break;
			decodedBaseUrl = next;
		} catch {
			break;
		}
	}
	if (/[{}]/.test(decodedBaseUrl) || /%(?:25)*7[bd]/i.test(decodedBaseUrl)) {
		throw new Error(`Agent run model ${model.provider}/${model.id} requires a resolved Cloudflare endpoint`);
	}
	let endpoint: URL;
	try {
		endpoint = new URL(model.baseUrl);
	} catch {
		throw new Error(`Agent run model ${model.provider}/${model.id} requires an explicit HTTP endpoint`);
	}
	if (
		!["http:", "https:"].includes(endpoint.protocol) ||
		endpoint.username !== "" ||
		endpoint.password !== "" ||
		endpoint.hash !== "" ||
		model.baseUrl.includes("#")
	) {
		throw new Error(`Agent run model ${model.provider}/${model.id} requires an explicit HTTP endpoint`);
	}
	if (typeof access.apiKey !== "string" || access.apiKey.trim() === "") {
		throw new Error(`Agent run model ${model.provider}/${model.id} requires an explicit api key`);
	}
	return Object.freeze({
		kind: "secret",
		contract: "secret@1",
		apiKey: access.apiKey,
		...(access.headers === undefined
			? {}
			: { headers: immutableStringRecord(access.headers, "Agent run secret headers") }),
	});
}

class AgentRunModelScopeCapability implements AgentRunModelScope {
	readonly version = AGENT_RUN_MODEL_SCOPE_VERSION;
	readonly root: Model<Api>;
	readonly models: readonly Model<Api>[];
	readonly [agentRunModelScopeBrand] = true;
	#active = true;
	readonly #requestAccessByModel: ReadonlyMap<string, AgentRunSecretRequestAccess>;

	constructor(
		root: Model<Api>,
		models: readonly Model<Api>[],
		requestAccessByModel: ReadonlyMap<string, AgentRunSecretRequestAccess>,
	) {
		this.root = root;
		this.models = models;
		this.#requestAccessByModel = requestAccessByModel;
		Object.freeze(this);
	}

	assertActive(): void {
		if (!this.#active) throw new Error("Agent run model scope is revoked");
	}

	requestAccess(model: Model<Api>): AgentRunSecretRequestAccess {
		this.assertActive();
		const access = this.#requestAccessByModel.get(exactModelIdentity(model));
		if (access === undefined) throw new Error(`Agent run model ${model.provider}/${model.id} has no upfront access`);
		return access;
	}

	revoke(): void {
		this.#active = false;
	}
}

export function createAgentRunModelScope(input: {
	readonly version: typeof AGENT_RUN_MODEL_SCOPE_VERSION;
	readonly root: Model<Api>;
	readonly models: readonly Model<Api>[];
	readonly requestAccess: readonly AgentRunModelRequestAccess[];
}): AgentRunModelScope {
	if (input.version !== AGENT_RUN_MODEL_SCOPE_VERSION) throw new Error("Unsupported agent run model scope version");
	if (input.models.length < 1) throw new Error("Agent run model scope requires at least one model");
	if (!Array.isArray(input.requestAccess)) throw new Error("Agent run model scope requires upfront request access");
	const models = input.models.map(immutableModel);
	const identities = new Set<string>();
	const exactIdentities = new Map<string, Model<Api>>();
	for (const model of models) {
		const identity = modelIdentity(model);
		if (identities.has(identity))
			throw new Error(`Agent run model scope contains duplicate model ${model.provider}/${model.id}`);
		identities.add(identity);
		exactIdentities.set(exactModelIdentity(model), model);
	}
	const root = exactIdentities.get(exactModelIdentity(input.root));
	if (!root) throw new Error("Agent run model scope root must belong to its ordered model roster");
	if (input.requestAccess.length !== models.length) {
		throw new Error("Agent run request access must exactly cover the ordered model roster");
	}
	const requestAccessByModel = new Map<string, AgentRunSecretRequestAccess>();
	for (const entry of input.requestAccess) {
		const identity = exactModelIdentity(entry.model);
		const selected = exactIdentities.get(identity);
		if (selected === undefined)
			throw new Error("Agent run request access contains a model outside the ordered roster");
		if (requestAccessByModel.has(identity)) {
			throw new Error(`Agent run request access contains duplicate model ${selected.provider}/${selected.id}`);
		}
		requestAccessByModel.set(identity, normalizeRequestAccess(selected, entry.access));
	}
	for (const model of models) {
		if (!requestAccessByModel.has(exactModelIdentity(model))) {
			throw new Error(`Agent run model ${model.provider}/${model.id} has no upfront access`);
		}
	}
	return new AgentRunModelScopeCapability(root, Object.freeze(models), requestAccessByModel);
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

export function getAgentRunRequestAccess(scope: AgentRunModelScope, model: Model<Api>): AgentRunSecretRequestAccess {
	assertAgentRunModelScope(scope);
	const selected = findAgentRunScopedModel(scope, model.provider, model.id);
	if (!selected) throw new Error(`Model ${model.provider}/${model.id} is outside the admitted run scope`);
	if (exactModelIdentity(selected) !== exactModelIdentity(model)) {
		throw new Error(`Model ${model.provider}/${model.id} does not match its admitted api and endpoint`);
	}
	return (scope as AgentRunModelScopeCapability).requestAccess(selected);
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
