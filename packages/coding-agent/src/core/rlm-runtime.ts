import { types } from "node:util";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ServiceTier } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.js";
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

export interface LocalRlmSpawnHandle {
	rlm_child_id: string;
	name: string;
	session_dir: string;
	model: string;
}

interface RlmCreateSessionRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
}

export interface RlmCreateSessionResult {
	active_session_id: string;
	session_id: string;
	name: string;
	session_file: string;
	model: string;
}

export interface HostedRlmSpawnHandle {
	rlm_child_id: string;
	name: string;
	model: string;
	/** Immutable execution context. Presence discriminates local vs hosted. */
	readonly execution: { readonly type: "prime-sandbox" };
}

export type RlmSpawnHandle = LocalRlmSpawnHandle | HostedRlmSpawnHandle;

export type RlmSubagentRegistryStatus = "running" | "completed" | "error";

export interface LocalRlmSubagentRegistryEntry {
	rlm_child_id: string;
	active_session_id: string | null;
	session_id: string | null;
	session_name: string;
	session_dir: string;
	status: RlmSubagentRegistryStatus;
}

export interface HostedRlmSubagentRegistryEntry {
	rlm_child_id: string;
	active_session_id: string;
	session_id: string;
	session_name: string;
	status: RlmSubagentRegistryStatus;
	/** Immutable execution context. Presence discriminates local vs hosted. */
	readonly execution: { readonly type: "prime-sandbox" };
}

export type RlmSubagentRegistryEntry = LocalRlmSubagentRegistryEntry | HostedRlmSubagentRegistryEntry;

/** Location arm: local child holds a session_dir; hosted holds immutable execution. */
export type RlmChildRunLocation =
	| Readonly<{ type: "local"; readonly sessionDir: string }>
	| Readonly<{ type: "hosted"; readonly execution: Readonly<{ readonly type: "prime-sandbox" }> }>;

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
type RlmCreateSessionHandler = (request: RlmCreateSessionRequest) => Promise<RlmCreateSessionResult>;

interface AsyncBashCompletionRequest {
	pid: number;
	command: string;
	exitCode: number;
}

type AsyncBashCompletionHandler = (request: AsyncBashCompletionRequest) => void | Promise<void>;
export type RlmListSubagentsHandler = () => RlmListSubagentsResult | Promise<RlmListSubagentsResult>;
export type RlmDeleteSubagentHandler = (target: string) => Promise<RlmDeleteSubagentResult>;
export type RlmFindModelsHandler = (query: string, limit: number) => RlmFindModelsResult | Promise<RlmFindModelsResult>;

const RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH = 64;
export const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8;
export const MAX_RLM_MODEL_SEARCH_LIMIT = 20;

export function normalizeRequestedRlmSubagentSessionName(value: unknown, operation = "rlm.run"): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${operation} name must be a string`);
	}
	const name = value.trim();
	if (!name) {
		throw new Error(`${operation} name must not be empty`);
	}
	if (name.length > RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH) {
		throw new Error(`${operation} name must be at most ${RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH} characters`);
	}
	return name;
}

export function normalizeRequestedRlmSubagentThinkingLevel(
	value: unknown,
	operation = "rlm.run",
): ThinkingLevel | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${operation} thinking must be a string`);
	}
	const level = value.trim().toLowerCase();
	if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
		throw new Error(`${operation} thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
	}
	return level as ThinkingLevel;
}

export function normalizeRequestedRlmSubagentModel(value: unknown, operation = "rlm.run"): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${operation} model must be a string`);
	}
	const model = value.trim();
	if (!model) {
		throw new Error(`${operation} model must not be empty`);
	}
	return model;
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

export function createRlmCreateSessionHostHandler(handler: RlmCreateSessionHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.prompt !== "string") {
			throw new Error("rlm.create_session prompt must be a string");
		}
		const kwargs = isRecord(payload.kwargs) ? payload.kwargs : {};
		const result = await handler({ prompt: payload.prompt, kwargs });
		return result as unknown as Record<string, unknown>;
	};
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

/** Adapt detached kernel bash completions into a validated host notification. */
export function createAsyncBashCompletionHostHandler(handler: AsyncBashCompletionHandler): HostRequestHandler {
	return async (payload) => {
		const { pid, command, exitCode } = payload;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
			throw new Error("bash.completed pid must be a positive integer");
		}
		if (typeof command !== "string" || !command) {
			throw new Error("bash.completed command must be a non-empty string");
		}
		if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
			throw new Error("bash.completed exitCode must be an integer");
		}
		await handler({ pid, command, exitCode });
		return {};
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

export const RLM_SANDBOX_UNAVAILABLE_MESSAGE = "Sandbox execution is not available for this session";

export function normalizeRequestedRlmSandbox(value: unknown): boolean {
	if (value === undefined || value === false) return false;
	if (value === true) return true;
	throw new Error("rlm.run sandbox must be a boolean");
}

export type RlmRunKwargsSnapshot = Readonly<{
	name: unknown;
	model: unknown;
	thinking: unknown;
	sandbox: unknown;
	unsupported: readonly string[];
}>;

export function snapshotRlmRunKwargs(value: unknown): RlmRunKwargsSnapshot {
	let keys: readonly (string | symbol)[];
	try {
		if (typeof value !== "object" || value === null || types.isProxy(value)) {
			throw new Error("invalid");
		}
		if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("invalid");
		keys = Reflect.ownKeys(value);
	} catch {
		throw new Error("rlm.run kwargs are invalid");
	}
	if (keys.length > 64) throw new Error("rlm.run kwargs are invalid");
	let name: unknown;
	let model: unknown;
	let thinking: unknown;
	let sandbox: unknown;
	const unsupported: string[] = [];
	for (const key of keys) {
		if (typeof key !== "string" || key.length === 0 || key.length > 64 || /[\x00-\x1f\x7f]/.test(key)) {
			throw new Error("rlm.run kwargs are invalid");
		}
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(value, key);
		} catch {
			throw new Error("rlm.run kwargs are invalid");
		}
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
			throw new Error("rlm.run kwargs are invalid");
		}
		if (key === "name") name = descriptor.value;
		else if (key === "model") model = descriptor.value;
		else if (key === "thinking") thinking = descriptor.value;
		else if (key === "sandbox") sandbox = descriptor.value;
		else unsupported.push(key);
	}
	return Object.freeze({ name, model, thinking, sandbox, unsupported: Object.freeze(unsupported) });
}

export interface CreateLocalRlmSubagentRuntimeOptions {
	parentSession: AgentSession;
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	sandbox?: false;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
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

export interface HostedRlmScopedModelSelector {
	readonly modelSelector: string;
	readonly thinkingLevel?: ThinkingLevel;
}

/** Credential-free, path-free data copied across the hosted allocation boundary. */
export interface CreateHostedRlmSubagentRuntimeOptions {
	readonly sandbox: true;
	readonly id: string;
	readonly sessionId: string;
	readonly activeSessionId: string;
	readonly parentSessionId: string;
	readonly parentActiveSessionId: string;
	readonly sessionName: string;
	readonly modelSelector: string;
	readonly thinkingLevel: ThinkingLevel;
	readonly serviceTier: ServiceTier;
	readonly spawnedByRequestId?: string;
	readonly scopedModels: readonly HostedRlmScopedModelSelector[];
	readonly activeToolNames: readonly string[];
	readonly allowedToolNames?: readonly string[];
	readonly includeGoals: boolean;
	readonly includeCompactSkill: boolean;
	readonly rlmDepth: number;
	readonly rlmMaxDepth: number;
	readonly rlmParentNodeId: string;
}

export type CreateRlmSubagentRuntimeOptions =
	| CreateLocalRlmSubagentRuntimeOptions
	| CreateHostedRlmSubagentRuntimeOptions;

export type HostedRlmAllocationSettlement = (result: unknown) => void;

export interface CreateRlmRootSessionOptions {
	prompt: string;
	sessionName?: string;
	cwd: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
}

export interface SubagentRuntimeHost {
	createRlmSubagentRuntime(options: CreateLocalRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	createHostedRlmSubagentRuntime?(
		options: CreateHostedRlmSubagentRuntimeOptions,
		settle: HostedRlmAllocationSettlement,
	): void;
	createRlmRootSession?(options: CreateRlmRootSessionOptions): Promise<RlmCreateSessionResult>;
	/** Persist host-owned completion before the child becomes passivation-eligible. */
	completeRlmSubagentRuntime?(childId: string, runtime: RlmSubagentRuntime): boolean | Promise<boolean>;
	/** Release a local host-owned child after its detached initial task settles. */
	releaseRlmSubagentRuntime?: (
		runtime: RlmSubagentRuntime,
		options: CreateRlmSubagentRuntimeOptions,
		status: "done" | "error" | "cancelled",
	) => Promise<void>;
	/** Release an exact hosted allocation token after its detached initial task settles. */
	releaseHostedRlmSubagentRuntime?: (
		runtime: unknown,
		options: CreateHostedRlmSubagentRuntimeOptions,
		status: "done" | "error" | "cancelled",
	) => Promise<void>;
	/** Close or remove a local host-owned child. */
	deleteRlmSubagentRuntime(childId: string, runtime?: RlmSubagentRuntime): Promise<void>;
	/** Close or remove an exact hosted allocation token. */
	deleteHostedRlmSubagentRuntime?(childId: string, runtime?: unknown): Promise<void>;
	disposeRlmSubagentRuntimes?(): unknown;
}

// ---------------------------------------------------------------------------
// Exact-boundary normalizer for RlmSubagentRuntime
// ---------------------------------------------------------------------------

const HostedAllocationObjectFreeze = Object.freeze;
const HostedAllocationGetPrototypeOf = Object.getPrototypeOf;
const HostedAllocationIsFrozen = Object.isFrozen;
const HostedAllocationOwnKeys = Reflect.ownKeys;
const HostedAllocationGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const HostedAllocationObjectPrototype = Object.prototype;
const HostedAllocationIsProxy = types.isProxy;

export type NormalizedHostedRlmAllocationResult = Readonly<{ ok: true; runtime: unknown }> | Readonly<{ ok: false }>;

/** Snapshot one untrusted hosted-allocation callback result without invoking accessors. */
export function normalizeHostedRlmAllocationResult(raw: unknown): NormalizedHostedRlmAllocationResult | null {
	if (typeof raw !== "object" || raw === null || HostedAllocationIsProxy(raw)) return null;
	try {
		if (HostedAllocationGetPrototypeOf(raw) !== HostedAllocationObjectPrototype || !HostedAllocationIsFrozen(raw))
			return null;
		const keys = HostedAllocationOwnKeys(raw);
		const descriptors = HostedAllocationGetOwnPropertyDescriptors(raw);
		const okDescriptor = descriptors.ok;
		if (!okDescriptor || !("value" in okDescriptor) || !okDescriptor.enumerable) return null;
		if (okDescriptor.value === false) {
			if (keys.length !== 1 || keys[0] !== "ok") return null;
			return HostedAllocationObjectFreeze({ ok: false });
		}
		if (
			okDescriptor.value !== true ||
			keys.length !== 2 ||
			!((keys[0] === "ok" && keys[1] === "runtime") || (keys[0] === "runtime" && keys[1] === "ok"))
		) {
			return null;
		}
		const runtimeDescriptor = descriptors.runtime;
		if (!runtimeDescriptor || !("value" in runtimeDescriptor) || !runtimeDescriptor.enumerable) return null;
		return HostedAllocationObjectFreeze({ ok: true, runtime: runtimeDescriptor.value });
	} catch {
		return null;
	}
}

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
