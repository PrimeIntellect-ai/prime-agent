/**
 * Provider-neutral swarm role policy parsing and admission.
 *
 * This module deliberately owns every policy decision.  Callers pass only an
 * authenticated model catalog and the parent's already-effective tool names;
 * it never reads files, credentials, defaults, or provider-specific aliases.
 */
import { createHash } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ServiceTier } from "@earendil-works/pi-ai";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_IDENTIFIERS = new Set(["default", "inherit", "none"]);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SERVICE_TIERS = new Set<Exclude<ServiceTier, null>>(["auto", "default", "flex", "scale", "priority"]);
export const SWARM_ROLE_MAX_ITEMS = 16;
export const SWARM_ROLE_MAX_CONTEXT_BYTES = 32768;
export const SWARM_ROLE_MAX_INSTRUCTION_BYTES = 8192;
export const SWARM_ROLE_MAX_ROLES = 64;

export interface SwarmRolePolicy {
	version: 1;
	trustProjectPolicy?: boolean;
	modelProfiles: Record<string, SwarmModelProfile>;
	roles: Record<string, SwarmRoleDefinition>;
}
export interface SwarmModelProfile {
	model: string;
	thinkingLevel?: ThinkingLevel;
	serviceTier?: ServiceTier;
}
export interface SwarmRoleDefinition {
	modelProfile: string;
	decisionScopes: string[];
	implementationScopes: string[];
	allowedToolNames: string[];
	delegableRoleIds?: string[];
	instructions?: string;
	sharedContext: SwarmSharedContextLimits;
}
export interface SwarmSharedContextLimits {
	maxItems: number;
	maxBytes: number;
	allowedKinds?: string[];
}
export interface SwarmRolePolicySnapshot {
	policy: Readonly<SwarmRolePolicy>;
	digest: string;
}
export interface SwarmRoleMetadata {
	id: string;
	modelProfile: string;
	decisionScopes: string[];
	implementationScopes: string[];
}
export interface SwarmContextCapsule {
	kind: string;
	text: string;
}
export interface SwarmRoleAssignment {
	assignmentId: string;
	policyDigest: string;
	roleId: string;
	modelProfile: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	serviceTier?: ServiceTier;
	decisionScopes: string[];
	implementationScopes: string[];
	allowedToolNames: string[];
	delegableRoleIds: string[];
	sharedContext: SwarmSharedContextLimits;
}
export interface ResolveSwarmRoleAssignmentInput {
	snapshot: SwarmRolePolicySnapshot;
	assignmentId: string;
	role: unknown;
	decisionScopes?: unknown;
	implementationScopes?: unknown;
	sharedContext?: unknown;
	models: Model<Api>[];
	parentToolNames: Iterable<string>;
	parentAssignment?: Pick<SwarmRoleAssignment, "delegableRoleIds" | "decisionScopes" | "implementationScopes">;
}

function fail(message: string): never {
	throw new Error(`Invalid swarm role policy: ${message}`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}
function normalizedIdentifier(value: unknown, label: string, reserved = false): string {
	if (typeof value !== "string") fail(`${label} must be a string`);
	const normalized = value.trim();
	if (!normalized || normalized.length > 64 || !IDENTIFIER.test(normalized))
		fail(`${label} must be a 1-64 character ASCII identifier`);
	if (reserved && RESERVED_IDENTIFIERS.has(normalized.toLowerCase())) fail(`${label} uses a reserved identifier`);
	return normalized;
}
function requireArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) fail(`${label} must be an array`);
	return value;
}
function normalizedIdentifierArray(value: unknown, label: string, reserved = false): string[] {
	const values = requireArray(value, label).map((entry, index) =>
		normalizedIdentifier(entry, `${label}[${index}]`, reserved),
	);
	if (new Set(values).size !== values.length) fail(`${label} contains a duplicate identifier`);
	return values;
}
function exactSelector(value: unknown): string {
	if (typeof value !== "string") fail("model profile model must be a string");
	const selector = value.trim();
	const slash = selector.indexOf("/");
	if (!selector || slash <= 0 || slash === selector.length - 1 || /\s/.test(selector))
		fail("model profile model must be an exact provider/model selector");
	return selector;
}
function canonicalize(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (!isRecord(value)) fail("policy contains an unsupported value");
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
		.join(",")}}`;
}
function freeze<T>(value: T): Readonly<T> {
	if (Array.isArray(value)) value.forEach(freeze);
	else if (isRecord(value)) Object.values(value).forEach(freeze);
	return Object.freeze(value);
}
function unknownKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
	for (const key of Object.keys(record)) if (!keys.includes(key)) fail(`${label} has unknown field ${key}`);
}
function parseProfile(value: unknown, alias: string): SwarmModelProfile {
	if (!isRecord(value)) fail(`modelProfiles.${alias} must be an object`);
	unknownKeys(value, ["model", "thinkingLevel", "serviceTier"], `modelProfiles.${alias}`);
	const profile: SwarmModelProfile = { model: exactSelector(value.model) };
	if (value.thinkingLevel !== undefined) {
		if (typeof value.thinkingLevel !== "string" || !THINKING_LEVELS.has(value.thinkingLevel as ThinkingLevel))
			fail(`modelProfiles.${alias}.thinkingLevel is invalid`);
		profile.thinkingLevel = value.thinkingLevel as ThinkingLevel;
	}
	if (value.serviceTier !== undefined) {
		if (typeof value.serviceTier !== "string" || !SERVICE_TIERS.has(value.serviceTier as Exclude<ServiceTier, null>))
			fail(`modelProfiles.${alias}.serviceTier is invalid`);
		profile.serviceTier = value.serviceTier as ServiceTier;
	}
	return profile;
}
function parseRole(value: unknown, id: string, profiles: Set<string>): SwarmRoleDefinition {
	if (!isRecord(value)) fail(`roles.${id} must be an object`);
	unknownKeys(
		value,
		[
			"modelProfile",
			"decisionScopes",
			"implementationScopes",
			"allowedToolNames",
			"delegableRoleIds",
			"instructions",
			"sharedContext",
		],
		`roles.${id}`,
	);
	const profile = normalizedIdentifier(value.modelProfile, `roles.${id}.modelProfile`, true);
	if (!profiles.has(profile)) fail(`roles.${id} references an unknown model profile`);
	const decisionScopes = normalizedIdentifierArray(value.decisionScopes, `roles.${id}.decisionScopes`);
	const implementationScopes = normalizedIdentifierArray(
		value.implementationScopes,
		`roles.${id}.implementationScopes`,
	);
	const allowedToolNames = requireArray(value.allowedToolNames, `roles.${id}.allowedToolNames`).map((tool, i) => {
		if (typeof tool !== "string" || !tool.trim())
			fail(`roles.${id}.allowedToolNames[${i}] must be a non-empty string`);
		return tool.trim();
	});
	if (new Set(allowedToolNames).size !== allowedToolNames.length)
		fail(`roles.${id}.allowedToolNames contains a duplicate tool`);
	const delegableRoleIds =
		value.delegableRoleIds === undefined
			? []
			: normalizedIdentifierArray(value.delegableRoleIds, `roles.${id}.delegableRoleIds`, true);
	let instructions: string | undefined;
	if (value.instructions !== undefined) {
		if (typeof value.instructions !== "string" || utf8Bytes(value.instructions) > SWARM_ROLE_MAX_INSTRUCTION_BYTES)
			fail(`roles.${id}.instructions exceeds ${SWARM_ROLE_MAX_INSTRUCTION_BYTES} UTF-8 bytes`);
		instructions = value.instructions;
	}
	if (!isRecord(value.sharedContext)) fail(`roles.${id}.sharedContext must be an object`);
	unknownKeys(value.sharedContext, ["maxItems", "maxBytes", "allowedKinds"], `roles.${id}.sharedContext`);
	const { maxItems, maxBytes } = value.sharedContext;
	if (!Number.isInteger(maxItems) || (maxItems as number) < 0 || (maxItems as number) > SWARM_ROLE_MAX_ITEMS)
		fail(`roles.${id}.sharedContext.maxItems is out of bounds`);
	if (!Number.isInteger(maxBytes) || (maxBytes as number) < 0 || (maxBytes as number) > SWARM_ROLE_MAX_CONTEXT_BYTES)
		fail(`roles.${id}.sharedContext.maxBytes is out of bounds`);
	const allowedKinds =
		value.sharedContext.allowedKinds === undefined
			? undefined
			: normalizedIdentifierArray(value.sharedContext.allowedKinds, `roles.${id}.sharedContext.allowedKinds`);
	return {
		modelProfile: profile,
		decisionScopes,
		implementationScopes,
		allowedToolNames,
		delegableRoleIds,
		...(instructions === undefined ? {} : { instructions }),
		sharedContext: {
			maxItems: maxItems as number,
			maxBytes: maxBytes as number,
			...(allowedKinds === undefined ? {} : { allowedKinds }),
		},
	};
}

/** Parse, normalize, canonically serialize, and fingerprint an untrusted settings value. */
export function parseSwarmRolePolicy(value: unknown): SwarmRolePolicySnapshot {
	if (!isRecord(value)) fail("policy must be an object");
	unknownKeys(value, ["version", "trustProjectPolicy", "modelProfiles", "roles"], "policy");
	if (value.version !== 1) fail("version must be 1");
	if (value.trustProjectPolicy !== undefined && typeof value.trustProjectPolicy !== "boolean")
		fail("trustProjectPolicy must be a boolean");
	if (!isRecord(value.modelProfiles) || !isRecord(value.roles)) fail("modelProfiles and roles must be objects");
	const rawProfiles = Object.entries(value.modelProfiles).map(
		([rawId, profile]) => [normalizedIdentifier(rawId, "model profile ID", true), profile] as const,
	);
	if (!rawProfiles.length) fail("modelProfiles must not be empty");
	if (new Set(rawProfiles.map(([id]) => id)).size !== rawProfiles.length)
		fail("modelProfiles contains duplicate normalized IDs");
	// Profiles are addressed by externally supplied, closed identifiers. Use a
	// null-prototype record so `__proto__` cannot invoke Object.prototype's legacy
	// setter if this grammar evolves; every accepted identifier remains an ordinary
	// own property and therefore participates in canonical authority/digests.
	const modelProfiles: Record<string, SwarmModelProfile> = Object.create(null) as Record<string, SwarmModelProfile>;
	for (const [id, profile] of rawProfiles) modelProfiles[id] = parseProfile(profile, id);
	const rawRoles = Object.entries(value.roles).map(
		([rawId, role]) => [normalizedIdentifier(rawId, "role ID", true), role] as const,
	);
	if (!rawRoles.length || rawRoles.length > SWARM_ROLE_MAX_ROLES)
		fail(`roles must contain 1-${SWARM_ROLE_MAX_ROLES} entries`);
	if (new Set(rawRoles.map(([id]) => id)).size !== rawRoles.length) fail("roles contains duplicate normalized IDs");
	const profileIds = new Set(Object.keys(modelProfiles));
	const roles: Record<string, SwarmRoleDefinition> = {};
	for (const [id, role] of rawRoles) roles[id] = parseRole(role, id, profileIds);
	for (const [id, role] of Object.entries(roles))
		for (const target of role.delegableRoleIds ?? [])
			if (!Object.hasOwn(roles, target)) fail(`roles.${id} delegates to an unknown role`);
	const policy: SwarmRolePolicy = {
		version: 1,
		...(value.trustProjectPolicy === undefined ? {} : { trustProjectPolicy: value.trustProjectPolicy }),
		modelProfiles,
		roles,
	};
	const digest = createHash("sha256").update(canonicalize(policy), "utf8").digest("hex");
	return freeze({ policy: freeze(policy), digest }) as SwarmRolePolicySnapshot;
}

export function projectSwarmRoleMetadata(snapshot: SwarmRolePolicySnapshot): SwarmRoleMetadata[] {
	return Object.entries(snapshot.policy.roles)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.slice(0, SWARM_ROLE_MAX_ROLES)
		.map(([id, role]) =>
			freeze({
				id,
				modelProfile: role.modelProfile,
				decisionScopes: [...role.decisionScopes],
				implementationScopes: [...role.implementationScopes],
			}),
		) as SwarmRoleMetadata[];
}
function requestedScopes(value: unknown, label: string): string[] {
	if (value === undefined) return [];
	return normalizedIdentifierArray(value, label);
}
function validateCapsules(value: unknown, caps: SwarmSharedContextLimits): SwarmContextCapsule[] {
	const values = value === undefined ? [] : requireArray(value, "shared_context");
	if (values.length > SWARM_ROLE_MAX_ITEMS || values.length > caps.maxItems)
		throw new Error("swarm shared_context exceeds item limit");
	const capsules = values.map((value, index) => {
		if (!isRecord(value)) throw new Error(`swarm shared_context[${index}] must be an object`);
		if (
			Object.keys(value).some((key) => key !== "kind" && key !== "text") ||
			typeof value.kind !== "string" ||
			typeof value.text !== "string"
		)
			throw new Error(`swarm shared_context[${index}] must contain only string kind and text`);
		const kind = normalizedIdentifier(value.kind, `shared_context[${index}].kind`);
		if (caps.allowedKinds && !caps.allowedKinds.includes(kind))
			throw new Error(`swarm shared_context[${index}] kind is not allowed`);
		return { kind, text: value.text };
	});
	const bytes = utf8Bytes(canonicalize(capsules));
	if (bytes > SWARM_ROLE_MAX_CONTEXT_BYTES || bytes > caps.maxBytes)
		throw new Error("swarm shared_context exceeds UTF-8 byte limit");
	return capsules;
}
/** Resolve exactly one catalog model; this intentionally has no alias/default/partial path. */
export function resolveSwarmRoleAssignment(input: ResolveSwarmRoleAssignmentInput): Readonly<SwarmRoleAssignment> {
	const roleId = normalizedIdentifier(input.role, "role", true);
	const role = input.snapshot.policy.roles[roleId];
	if (!role) throw new Error("swarm role does not exist");
	const profile = input.snapshot.policy.modelProfiles[role.modelProfile];
	if (!profile) throw new Error("swarm role model profile does not exist");
	const models = input.models.filter((model) => `${model.provider}/${model.id}` === profile.model);
	if (models.length !== 1)
		throw new Error("swarm role profile model is not exactly available in the authenticated catalog");
	const decisionScopes = requestedScopes(input.decisionScopes, "decision_scopes");
	const implementationScopes = requestedScopes(input.implementationScopes, "implementation_scopes");
	for (const scope of decisionScopes)
		if (!role.decisionScopes.includes(scope)) throw new Error("requested decision scope is not granted by role");
	for (const scope of implementationScopes)
		if (!role.implementationScopes.includes(scope))
			throw new Error("requested implementation scope is not granted by role");
	if (input.parentAssignment) {
		if (!input.parentAssignment.delegableRoleIds.includes(roleId))
			throw new Error("nested role is not delegable by parent assignment");
		for (const scope of decisionScopes)
			if (!input.parentAssignment.decisionScopes.includes(scope))
				throw new Error("nested decision scope is not granted by parent assignment");
		for (const scope of implementationScopes)
			if (!input.parentAssignment.implementationScopes.includes(scope))
				throw new Error("nested implementation scope is not granted by parent assignment");
	}
	const parentTools = new Set(input.parentToolNames);
	for (const tool of role.allowedToolNames)
		if (!parentTools.has(tool)) throw new Error("configured role tool is unavailable to parent");
	const capsules = validateCapsules(input.sharedContext, role.sharedContext);
	if (typeof input.assignmentId !== "string" || !input.assignmentId)
		throw new Error("swarm assignment requires an assignmentId");
	// validate before constructing: capsule bodies never enter this private metadata.
	void capsules;
	return freeze({
		assignmentId: input.assignmentId,
		policyDigest: input.snapshot.digest,
		roleId,
		modelProfile: role.modelProfile,
		model: profile.model,
		...(profile.thinkingLevel === undefined ? {} : { thinkingLevel: profile.thinkingLevel }),
		...(profile.serviceTier === undefined ? {} : { serviceTier: profile.serviceTier }),
		decisionScopes,
		implementationScopes,
		allowedToolNames: [...role.allowedToolNames],
		delegableRoleIds: [...(role.delegableRoleIds ?? [])],
		sharedContext: {
			...role.sharedContext,
			...(role.sharedContext.allowedKinds ? { allowedKinds: [...role.sharedContext.allowedKinds] } : {}),
		},
	}) as Readonly<SwarmRoleAssignment>;
}

/** Validate and return explicitly admitted capsule data for the child-only preamble builder. */
export function validateSwarmSharedContext(value: unknown, caps: SwarmSharedContextLimits): SwarmContextCapsule[] {
	return validateCapsules(value, caps);
}
