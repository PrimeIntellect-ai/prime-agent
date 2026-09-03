import { types } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ServiceTier } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.js";
import type { SandboxOptions } from "./execution-location.js";
import { normalizeSandboxOptions } from "./execution-location.js";
import type { ToolDefinition } from "./extensions/index.js";
import { createHostedRlmRuntimePort, type HostedRlmRuntimePort } from "./hosted-rlm-runtime-port.js";
import type { HostRequestHandler } from "./kernel/index.js";
import { THINKING_LEVELS } from "./thinking-levels.js";

/** Request emitted by `rlm.run`; cellSourceCode preserves the spawning cell for display. */
export interface RlmRunRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
	cellSourceCode?: string;
}

export interface RlmSpawnHandle {
	rlm_child_id: string;
	name: string;
	session_dir: string;
	model: string;
}

export type RlmSubagentRegistryStatus = "running" | "completed" | "error";

export interface RlmSubagentRegistryEntry {
	rlm_child_id: string;
	active_session_id: string | null;
	session_id: string | null;
	session_name: string;
	session_dir: string;
	status: RlmSubagentRegistryStatus;
}

export interface RlmListSubagentsResult {
	subagents: RlmSubagentRegistryEntry[];
}

export interface RlmDeleteSubagentResult {
	subagent: RlmSubagentRegistryEntry;
	outcome?: "deleted" | "skipped_running";
}

export interface RlmModelMatch {
	provider: string;
	id: string;
	name: string;
	selector: string;
}

export interface RlmFindModelsResult {
	models: RlmModelMatch[];
}

export type RlmRunHandler = (request: RlmRunRequest) => Promise<Record<string, unknown>>;
export type RlmListSubagentsHandler = () => RlmListSubagentsResult | Promise<RlmListSubagentsResult>;
export type RlmDeleteSubagentHandler = (target: string) => Promise<RlmDeleteSubagentResult>;
export type RlmFindModelsHandler = (query: string, limit: number) => RlmFindModelsResult | Promise<RlmFindModelsResult>;

const RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH = 64;
export const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8;
export const MAX_RLM_MODEL_SEARCH_LIMIT = 20;

export function normalizeRequestedRlmSubagentSessionName(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run name must be a string");
	}
	const name = value.trim();
	if (!name) {
		throw new Error("rlm.run name must not be empty");
	}
	if (name.length > RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH) {
		throw new Error(`rlm.run name must be at most ${RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH} characters`);
	}
	return name;
}

export function normalizeRequestedRlmSubagentThinkingLevel(value: unknown): ThinkingLevel | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run thinking must be a string");
	}
	const level = value.trim().toLowerCase();
	if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
		throw new Error(`rlm.run thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
	}
	return level as ThinkingLevel;
}

export function normalizeRequestedRlmSubagentModel(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run model must be a string");
	}
	const model = value.trim();
	if (!model) {
		throw new Error("rlm.run model must not be empty");
	}
	return model;
}

export function normalizeRequestedRlmSubagentSandbox(value: unknown): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new Error("rlm.run sandbox must be a boolean");
	}
	return value;
}

export function normalizeRequestedRlmSubagentSandboxOptions(
	value: unknown,
	sandbox: boolean | undefined,
): SandboxOptions | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!sandbox) {
		throw new Error("rlm.run sandbox_options requires sandbox=true");
	}
	const normalised = normalizeSandboxOptions(value);
	if (normalised === undefined) {
		throw new Error("rlm.run sandbox_options contains invalid fields");
	}
	return normalised;
}

/** Create a readable, collision-resistant default name usable as an agent-message selector. */
export function createDefaultRlmSubagentSessionName(prompt: string, childId: string): string {
	const promptSlug = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const idSuffix =
		childId
			.replace(/^sub-/, "")
			.replace(/[^A-Za-z0-9]+/g, "")
			.slice(-8) || "child";
	const fixedLength = "subagent--".length + idSuffix.length;
	const promptPart = (promptSlug || "worker")
		.slice(0, Math.max(1, RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH - fixedLength))
		.replace(/-+$/g, "");
	return `subagent-${promptPart || "worker"}-${idSuffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function findRlmModelMatches(query: string, models: Model<Api>[], limit: number): RlmModelMatch[] {
	const normalizedQuery = normalizeModelSearchText(query.trim());
	return models
		.map((model) => {
			const selector = `${model.provider}/${model.id}`;
			const fields = [selector, model.id, model.name || model.id];
			const normalizedFields = fields.map(normalizeModelSearchText);
			let score = normalizedQuery ? Number.POSITIVE_INFINITY : 0;
			if (normalizedQuery) {
				const exactIndex = normalizedFields.indexOf(normalizedQuery);
				const prefixIndex = normalizedFields.findIndex((field) => field.startsWith(normalizedQuery));
				const partialIndex = normalizedFields.findIndex((field) => field.includes(normalizedQuery));
				if (exactIndex >= 0) score = exactIndex;
				else if (prefixIndex >= 0) score = 3 + prefixIndex;
				else if (partialIndex >= 0) score = 6 + partialIndex;
			}
			return { model, selector, score };
		})
		.filter((candidate) => Number.isFinite(candidate.score))
		.sort((a, b) => a.score - b.score || a.selector.localeCompare(b.selector))
		.slice(0, limit)
		.map(({ model, selector }) => ({
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			selector,
		}));
}

/** Adapt an RlmRunHandler into the typed `rlm.run` kernel host handler. */
export function createRlmRunHostHandler(handler: RlmRunHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.prompt !== "string") {
			throw new Error("rlm.run prompt must be a string");
		}
		const kwargs = isRecord(payload.kwargs) ? payload.kwargs : {};
		const cellSourceCode = typeof payload.cellSourceCode === "string" ? payload.cellSourceCode : undefined;
		const result = await handler({
			prompt: payload.prompt,
			kwargs,
			cellSourceCode,
		});
		return result as unknown as Record<string, unknown>;
	};
}

/** Search a bounded authenticated model catalog without adding it to the system prompt. */
export function createRlmFindModelsHostHandler(handler: RlmFindModelsHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.query !== "string") {
			throw new Error("rlm.find_models query must be a string");
		}
		const limit = payload.limit === undefined ? DEFAULT_RLM_MODEL_SEARCH_LIMIT : payload.limit;
		if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RLM_MODEL_SEARCH_LIMIT) {
			throw new Error(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`);
		}
		return { models: (await handler(payload.query, limit as number)).models };
	};
}

/** Expose the current parent session's direct RLM child registry to its kernel. */
export function createRlmListSubagentsHostHandler(handler: RlmListSubagentsHandler): HostRequestHandler {
	return async () => {
		const { subagents } = await handler();
		return { subagents };
	};
}

/** Delete one direct child selected from the current parent session's registry. */
export function createRlmDeleteSubagentHostHandler(handler: RlmDeleteSubagentHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.target !== "string" || !payload.target.trim()) {
			throw new Error("rlm.delete_subagent target must be a non-empty string");
		}
		const { subagent, outcome } = await handler(payload.target.trim());
		return outcome === undefined ? { subagent } : { subagent, outcome };
	};
}

export type RlmSubagentRuntime = Readonly<{ session: AgentSession }> | Readonly<{ hostedPort: HostedRlmRuntimePort }>;

export interface CreateRlmSubagentRuntimeOptions {
	parentSession: AgentSession;
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	/** Request a fresh sandbox for this subagent. Default false inherits the current execution host. */
	sandbox?: boolean;
	/** Sandbox descriptor options. Rejected unless sandbox is true. */
	sandboxOptions?: SandboxOptions;
	scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	activeToolNames: string[];
	allowedToolNames?: string[];
	customTools: ToolDefinition[];
	includeGoals: boolean;
	includeCompactSkill: boolean;
	rlmDepth: number;
	rlmMaxDepth: number;
	rlmParentNodeId: string;
	/** Request ID of the parent model call whose tool call caused this spawn. */
	spawnedByRequestId?: string;
	/** Source of the Python cell that spawned this subagent, for display. */
	spawnCode?: string;
	/** Publish the session to the parent before a host makes the runtime addressable. */
	onSessionPublished?: (session: AgentSession) => void;
}

export interface SubagentRuntimeHost {
	createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	/** Persist host-owned completion before the child becomes passivation-eligible. */
	completeRlmSubagentRuntime?(childId: string, runtime: RlmSubagentRuntime): boolean | Promise<boolean>;
	/** Release a host-owned child after its detached initial task settles. */
	releaseRlmSubagentRuntime?: (
		runtime: RlmSubagentRuntime,
		options: CreateRlmSubagentRuntimeOptions,
		status: "done" | "error" | "cancelled",
	) => Promise<void>;
	/** Close or remove the host-owned child; runtime is absent when a persisted child is still passive. */
	deleteRlmSubagentRuntime(childId: string, runtime?: RlmSubagentRuntime): Promise<void>;
	disposeRlmSubagentRuntimes?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Exact-boundary normalizer for RlmSubagentRuntime
// ---------------------------------------------------------------------------

export interface NormalizedHostedIdentityMatch {
	readonly childId: string;
	readonly sessionName: string;
	readonly modelSelector: string;
	readonly sessionId: string;
}

function printableHostedIdentityValue(descriptor: PropertyDescriptor | undefined): string | null {
	if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
	const value = descriptor.value;
	if (typeof value !== "string" || value.length < 1 || value.length > 128) return null;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x20 || code >= 0x7f) return null;
	}
	return value;
}

/** Snapshot the complete expected hosted identity before comparing a port. */
function requireExactHostedIdentityRecord(raw: unknown): NormalizedHostedIdentityMatch | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Object.prototype ||
			Object.getOwnPropertySymbols(raw).length !== 0
		) {
			return null;
		}
		const names = Object.getOwnPropertyNames(raw);
		if (
			names.length !== 4 ||
			!names.includes("childId") ||
			!names.includes("sessionName") ||
			!names.includes("modelSelector") ||
			!names.includes("sessionId")
		) {
			return null;
		}
		const descriptors = Object.getOwnPropertyDescriptors(raw);
		const childId = printableHostedIdentityValue(descriptors.childId);
		const sessionName = printableHostedIdentityValue(descriptors.sessionName);
		const modelSelector = printableHostedIdentityValue(descriptors.modelSelector);
		const sessionId = printableHostedIdentityValue(descriptors.sessionId);
		if (childId === null || sessionName === null || modelSelector === null || sessionId === null) return null;
		return Object.freeze({ childId, sessionName, modelSelector, sessionId });
	} catch {
		return null;
	}
}

/** Validate an untrusted raw value and return a frozen RlmSubagentRuntime,
 * or null on any malformed/hostile input. Never throws.
 *
 * For the local arm: validates exact {session} with Proxy/accessor/Promise
 * rejection, then invokes the caller-supplied `isAgentSession` predicate.
 * Returns Object.freeze({session}).
 *
 * For the hosted arm: passes the raw port through createHostedRlmRuntimePort,
 * matches identity fields against `expectedHostedIdentity` when provided, and
 * returns Object.freeze({hostedPort}). `expectedHostedIdentity` is
 * descriptor-snapshotted before any field access. */
export function normalizeRlmSubagentRuntime(
	raw: unknown,
	isAgentSession: (value: unknown) => value is AgentSession,
	expectedHostedIdentity?: unknown,
): RlmSubagentRuntime | null {
	let validated: { readonly [key: string]: unknown } | null;
	try {
		validated = requireExactSingleKeyRecord(raw);
	} catch {
		return null;
	}
	if (!validated) return null;
	const key = Object.keys(validated)[0];
	if (key !== "session" && key !== "hostedPort") return null;
	if (key === "session") {
		const session = validated.session;
		if (typeof session !== "object" || session === null) return null;
		try {
			if (types.isProxy(session) || types.isPromise(session)) return null;
		} catch {
			return null;
		}
		let checked: AgentSession | null = null;
		try {
			if (isAgentSession(session)) {
				checked = session;
			}
		} catch {
			return null;
		}
		if (checked === null) return null;
		return Object.freeze({ session: checked });
	}
	// hostedPort arm — always requires expectedHostedIdentity; only local arms may omit it.
	if (expectedHostedIdentity === undefined) return null;
	const port = validated.hostedPort;
	const factoryResult = createHostedRlmRuntimePort(port);
	if (!factoryResult.ok) return null;
	const acceptedPort = factoryResult.value;
	const snapshot = requireExactHostedIdentityRecord(expectedHostedIdentity);
	// Reject malformed expectedHostedIdentity before reading acceptedPort.identity
	if (!snapshot) return null;
	const id = acceptedPort.identity;
	try {
		if (
			id.childId !== snapshot.childId ||
			id.sessionName !== snapshot.sessionName ||
			id.modelSelector !== snapshot.modelSelector ||
			id.sessionId !== snapshot.sessionId
		) {
			return null;
		}
	} catch {
		return null;
	}
	return Object.freeze({ hostedPort: acceptedPort });
}

/** Return exact single-key own enumerable data record with Object.prototype,
 * no Proxy, no Symbols, no accessors, or null. Never throws. */
function requireExactSingleKeyRecord(raw: unknown): { readonly [key: string]: unknown } | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
	} catch {
		return null;
	}
	try {
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
	} catch {
		return null;
	}
	try {
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
	} catch {
		return null;
	}
	let names: string[];
	try {
		names = Object.getOwnPropertyNames(raw);
	} catch {
		return null;
	}
	if (names.length !== 1) return null;
	const key = names[0];
	if (key !== "session" && key !== "hostedPort") return null;
	let desc: PropertyDescriptor | undefined;
	try {
		desc = Object.getOwnPropertyDescriptor(raw, key);
	} catch {
		return null;
	}
	if (!desc || !("value" in desc) || !desc.enumerable) return null;
	return { [key]: desc.value };
}

export const INVALID_SUBAGENT_RUNTIME_ERROR = "Invalid subagent runtime";
