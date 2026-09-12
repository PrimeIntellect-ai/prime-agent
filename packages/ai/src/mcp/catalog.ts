// The MCP service catalog. `catalog.json` beside this file is the single public
// source of truth; it is generated deterministically by
// `packages/ai/scripts/import-mcp-catalog.ts` from the pinned upstream fixtures
// in `packages/ai/mcp-catalog/` and must not be hand-edited per entry.
// `catalog.data.generated.ts` is the build-shipped mirror of that JSON
// (regenerated together with it) so the runtime works under the repo's Node16
// module target without JSON import attributes.

import { getOAuthProvider, registerOAuthProvider } from "../utils/oauth/index.js";
import { CATALOG_DATA } from "./catalog.data.generated.js";
import { createMcpOAuthProvider, type McpOAuthConfig } from "./oauth.js";
import { isLiteralPrivateOrLoopbackHost } from "./url-checks.js";

export interface McpServiceProvenance {
	/** Upstream catalog the definition came from, `prime` for curated data, or `user` for local sources. */
	source: "openai-plugins" | "claude-plugins-official" | "prime" | "user";
	repository?: string;
	commit?: string;
	path?: string;
	/** Pinned raw URL of the upstream config this entry was derived from. */
	url?: string;
	license?: string;
	note?: string;
}

export type McpServiceSetupFieldKind = "env-var" | "url" | "client-id" | "client-secret" | "bearer-token" | "api-key";

export interface McpServiceSetupField {
	id: string;
	label: string;
	description?: string;
	required: boolean;
	/** What the field collects. Absent means the importer had no signal (legacy generic env-var). */
	kind?: McpServiceSetupFieldKind;
}

/**
 * Honest setup state. `ready` means upstream configs declare no blocker — it is
 * never a claim of tested connectivity (see `verification`). `status` is the
 * only lever that gates Connect; readiness is informational and NEVER a gate.
 */
export interface McpServiceSetup {
	status: "ready" | "requires-setup";
	reason?: string;
	fields?: McpServiceSetupField[];
	/**
	 * INFORMATIONAL readiness of the default auth path (never consulted by
	 * Connect gating; `status` is the only hard lever):
	 * - `oauth-ready`: public metadata evidence shows a coherent standard-OAuth
	 *   path usable today (dynamic client registration; a successful metadata
	 *   GET is never proof live OAuth works).
	 * - `user-setup`: the provider's documented default path needs user-supplied
	 *   credentials (API key, token) before connecting.
	 * - `prime-restricted`: the provider requires a pre-registered client or
	 *   gated program (documented, research-anchored).
	 * - `unknown`: no conclusive public evidence — connect attempts surface
	 *   real errors honestly; never treated as proof of a restriction.
	 */
	readiness?: McpReadiness;
	/** The genuine hard requirement behind a `requires-setup` status, when known. */
	requirement?: McpSetupRequirement;
}

export type McpReadiness = "oauth-ready" | "user-setup" | "prime-restricted" | "unknown";

export type McpSetupRequirement =
	| "api-key"
	| "bearer-token"
	| "registered-client"
	| "tenant"
	| "unsupported-transport"
	| "local-runtime";

/**
 * A documented alternative auth path with its own per-path readiness. Never
 * replaces the primary path — recorded so consumers can show honest options
 * (e.g. MongoDB interactive is prime-restricted, but a dedicated service
 * account is a user-setup alternative; Airtable OAuth via DCR, PAT bearer as
 * an api-key alternative).
 */
export interface McpServiceAuthAlternative {
	kind: "oauth" | "api-key" | "bearer-token" | "service-account";
	readiness: McpReadiness;
	/** Human-readable basis for this path (provider docs / evidence), not a gate. */
	note?: string;
	/** Research or provider-doc anchor backing this path. */
	sourceUrl?: string;
}

/**
 * OBSERVATIONAL metadata evidence captured by the read-only public audit
 * (public unauthenticated GETs only). Never a live credential authority and
 * never a Connect gate: a successful metadata GET is never proof live OAuth
 * works. Omitted fields mean "not advertised" or "not captured" — never
 * "unsupported" (the engine applies protocol defaults for omitted lists).
 */
export interface McpServiceAuthMetadata {
	/** Whether a public authorization-server metadata document was captured for the endpoint. */
	status: "available" | "unavailable" | "not-audited";
	authorizationServer?: string;
	resource?: string;
	/** code_challenge_methods_supported advertises S256; absent = list omitted (engine still sends S256). */
	pkceS256?: boolean;
	/** registration_endpoint advertised (RFC 7591 dynamic client registration). */
	dynamicClientRegistration?: boolean;
	/** client_id_metadata_document_supported advertised (CIMD; alone it is NOT oauth-readiness). */
	clientIdMetadataDocument?: boolean;
	/** scopes_supported from the protected-resource document — login-relevant list (reviewed/config > PRM > omit). */
	protectedResourceScopes?: string[];
	/** scopes_supported from the authorization-server document — observational only; NEVER fed to the requested scopes. */
	authorizationServerScopes?: string[];
	/** token_endpoint_auth_methods_supported; absent = omitted (engine applies spec defaults). */
	tokenAuthMethods?: string[];
	/** Evidence capture locations (probe + well-known documents). */
	sourceUrls: string[];
	/** ISO timestamp of the read-only public metadata capture. */
	fetchedAt: string;
	/** Free-form honesty note (e.g. audience mismatch, provider-side block). */
	note?: string;
}

export interface McpServiceAuth {
	strategy: "oauth" | "api_key" | "none" | "unknown";
	/** How an OAuth client is obtained; `unknown` means discovery is attempted at connect. */
	clientRegistration: "dynamic" | "pre-registered" | "unknown";
	/** Reviewed upstream scope hints only; never auto-requested, and empty in the first snapshot. */
	reviewedScopes?: string[];
	/** Documented alternative auth paths, each with per-path readiness. */
	alternatives?: McpServiceAuthAlternative[];
	/** Observational public-metadata evidence from the read-only audit (never a gate). */
	metadata?: McpServiceAuthMetadata;
}

export type McpServiceTransport =
	| { type: "http"; url: string }
	| { type: "http-template"; template: string; variables: { name: string; description: string }[] }
	| { type: "sse"; url: string }
	| { type: "stdio"; servers: { name: string; command: string; args?: string[]; env?: Record<string, string> }[] };

/**
 * One catalog entry = one reviewed connection (endpoint) of a service. Stable
 * `server` ids are the kernel dispatch id, the auth.json credential key
 * `mcp:<server>`, and the /plugins card identity; `service` groups entries of
 * the same brand (e.g. the Zoom product endpoints) without merging products
 * like Gmail and Google Drive.
 */
export interface McpServiceEntry {
	/** Stable service id: `^[a-z0-9][a-z0-9-]{0,63}$`. */
	server: string;
	/** Brand grouping id; defaults to `server`. */
	service: string;
	label: string;
	/** Default reviewed endpoint; empty for stdio and tenant-URL-template transports. */
	url: string;
	description?: string;
	category?: string;
	/** Lowercase, sorted search aliases. */
	aliases: string[];
	publisher?: string;
	transport: McpServiceTransport;
	auth: McpServiceAuth;
	setup: McpServiceSetup;
	/**
	 * Entry-level review state, never a runtime claim: `metadata-reviewed` means
	 * public provider OAuth metadata was reviewed for an already-shipped legacy
	 * integration; `unverified` means imported only. Distinct from per-account
	 * connection verification, which the host owns.
	 */
	verification: { status: "metadata-reviewed" | "unverified" };
	/**
	 * True only for legacy built-in integrations that pre-date the catalog; their
	 * ids stay reserved. Not a claim about shipped skill packages.
	 */
	legacyBuiltin: boolean;
	/** Present on OAuth-strategy entries; keeps `usesOAuth: entry.oauth?.kind === "oauth"` working. */
	oauth?: Omit<McpOAuthConfig, "server" | "url"> & { kind: "oauth" };
	provenance: McpServiceProvenance[];
	homepage?: string;
	docsUrl?: string;
	privacyUrl?: string;
	supportUrl?: string;
}

/** Shape of the generated catalog.json file. */
export interface CatalogFileShape {
	version: number;
	sources: { source: string; repository: string; commit: string }[];
	counts: Record<string, number>;
	entries: McpServiceEntry[];
}

export { isLiteralPrivateOrLoopbackHost } from "./url-checks.js";

const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TRANSPORT_TYPES = new Set(["http", "http-template", "sse", "stdio"]);
const AUTH_STRATEGIES = new Set(["oauth", "api_key", "none", "unknown"]);
const CLIENT_REGISTRATIONS = new Set(["dynamic", "pre-registered", "unknown"]);
const SETUP_STATUSES = new Set(["ready", "requires-setup"]);
const READINESS_STATES = new Set(["oauth-ready", "user-setup", "prime-restricted", "unknown"]);
const SETUP_REQUIREMENTS = new Set([
	"api-key",
	"bearer-token",
	"registered-client",
	"tenant",
	"unsupported-transport",
	"local-runtime",
]);
const SETUP_FIELD_KINDS = new Set(["env-var", "url", "client-id", "client-secret", "bearer-token", "api-key"]);
const AUTH_ALTERNATIVE_KINDS = new Set(["oauth", "api-key", "bearer-token", "service-account"]);
const AUTH_METADATA_STATUSES = new Set(["available", "unavailable", "not-audited"]);
const PROVENANCE_SOURCES = new Set(["openai-plugins", "claude-plugins-official", "prime", "user"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bounded echo of an entry id in errors: never reprint untrusted long/secret-ish input. */
function safeEntryId(entryId: string): string {
	return entryId.length > 64 ? `${entryId.slice(0, 64)}…` : entryId;
}

function fail(entryId: string, message: string): never {
	throw new Error(`catalog entry ${safeEntryId(entryId)}: ${message}`);
}

function requireString(entryId: string, field: string, value: unknown): string {
	if (typeof value !== "string" || value === "") {
		return fail(entryId, `${field} must be a non-empty string`);
	}
	return value;
}

function requireHttpsUrl(entryId: string, field: string, value: unknown): string {
	const url = requireString(entryId, field, value);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// Do not echo the input value: it may carry query tokens or other secrets.
		return fail(entryId, `${field} is not an absolute URL`);
	}
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
		return fail(entryId, `${field} must be an absolute HTTPS URL without credentials or a fragment`);
	}
	if (isLiteralPrivateOrLoopbackHost(parsed.hostname)) {
		return fail(entryId, `${field} must not be a literal loopback, private, link-local or unspecified endpoint`);
	}
	return url;
}

function requireSetupFields(entryId: string, value: unknown): McpServiceSetupField[] {
	if (!Array.isArray(value)) return fail(entryId, "setup.fields must be an array");
	return value.map((field) => {
		if (!isRecord(field)) return fail(entryId, "setup.fields entries must be objects");
		if (field.kind !== undefined && (typeof field.kind !== "string" || !SETUP_FIELD_KINDS.has(field.kind))) {
			return fail(entryId, `setup.fields[].kind must be one of ${[...SETUP_FIELD_KINDS].join(", ")}`);
		}
		return {
			id: requireString(entryId, "setup.fields[].id", field.id),
			label: requireString(entryId, "setup.fields[].label", field.label),
			description: typeof field.description === "string" ? field.description : undefined,
			required: field.required === true,
			...(typeof field.kind === "string" ? { kind: field.kind as McpServiceSetupFieldKind } : {}),
		};
	});
}

function requireAuthAlternatives(entryId: string, value: unknown): McpServiceAuthAlternative[] {
	if (!Array.isArray(value)) return fail(entryId, "auth.alternatives must be an array");
	return value.map((alternative) => {
		if (!isRecord(alternative)) return fail(entryId, "auth.alternatives entries must be objects");
		if (typeof alternative.kind !== "string" || !AUTH_ALTERNATIVE_KINDS.has(alternative.kind)) {
			return fail(entryId, `auth.alternatives[].kind must be one of ${[...AUTH_ALTERNATIVE_KINDS].join(", ")}`);
		}
		if (typeof alternative.readiness !== "string" || !READINESS_STATES.has(alternative.readiness)) {
			return fail(entryId, `auth.alternatives[].readiness must be one of ${[...READINESS_STATES].join(", ")}`);
		}
		return {
			kind: alternative.kind as McpServiceAuthAlternative["kind"],
			readiness: alternative.readiness as McpReadiness,
			...(typeof alternative.note === "string" ? { note: alternative.note } : {}),
			...(typeof alternative.sourceUrl === "string" ? { sourceUrl: alternative.sourceUrl } : {}),
		};
	});
}

function requireAuthMetadata(entryId: string, value: unknown): McpServiceAuthMetadata {
	if (!isRecord(value)) return fail(entryId, "auth.metadata must be an object");
	if (typeof value.status !== "string" || !AUTH_METADATA_STATUSES.has(value.status)) {
		fail(entryId, `auth.metadata.status must be one of ${[...AUTH_METADATA_STATUSES].join(", ")}`);
	}
	const stringArray = (path: string, input: unknown): string[] | undefined =>
		Array.isArray(input) ? input.map((item) => requireString(entryId, path, item)) : undefined;
	if (value.sourceUrls !== undefined && !Array.isArray(value.sourceUrls)) {
		fail(entryId, "auth.metadata.sourceUrls must be an array");
	}
	const booleanOrUndefined = (path: string, input: unknown): boolean | undefined => {
		if (input === undefined) return undefined;
		if (typeof input !== "boolean") fail(entryId, `auth.metadata.${path} must be a boolean`);
		return input;
	};
	const protectedResourceScopes = stringArray(
		"auth.metadata.protectedResourceScopes[]",
		value.protectedResourceScopes,
	);
	const authorizationServerScopes = stringArray(
		"auth.metadata.authorizationServerScopes[]",
		value.authorizationServerScopes,
	);
	const tokenAuthMethods = stringArray("auth.metadata.tokenAuthMethods[]", value.tokenAuthMethods);
	if (value.sourceUrls === undefined || !Array.isArray(value.sourceUrls) || value.sourceUrls.length === 0) {
		fail(entryId, "auth.metadata.sourceUrls must be a non-empty array");
	}
	if (typeof value.fetchedAt !== "string" || value.fetchedAt.length === 0) {
		fail(entryId, "auth.metadata.fetchedAt must be a non-empty string");
	}
	const pkceS256 = booleanOrUndefined("pkceS256", value.pkceS256);
	const dynamicClientRegistration = booleanOrUndefined("dynamicClientRegistration", value.dynamicClientRegistration);
	const clientIdMetadataDocument = booleanOrUndefined("clientIdMetadataDocument", value.clientIdMetadataDocument);
	return {
		status: value.status as McpServiceAuthMetadata["status"],
		...(typeof value.authorizationServer === "string" ? { authorizationServer: value.authorizationServer } : {}),
		...(typeof value.resource === "string" ? { resource: value.resource } : {}),
		...(pkceS256 !== undefined ? { pkceS256 } : {}),
		...(dynamicClientRegistration !== undefined ? { dynamicClientRegistration } : {}),
		...(clientIdMetadataDocument !== undefined ? { clientIdMetadataDocument } : {}),
		// Absent lists stay undefined — "not advertised / not captured", never "empty".
		...(protectedResourceScopes ? { protectedResourceScopes } : {}),
		...(authorizationServerScopes ? { authorizationServerScopes } : {}),
		...(tokenAuthMethods ? { tokenAuthMethods } : {}),
		sourceUrls: (value.sourceUrls as unknown[]).map((url) =>
			requireString(entryId, "auth.metadata.sourceUrls[]", url),
		),
		fetchedAt: value.fetchedAt,
		...(typeof value.note === "string" ? { note: value.note } : {}),
	};
}

/**
 * Structural validation for one catalog entry. Also usable for user-authored
 * local service entries so local sources validate against the same contract.
 */
export function validateMcpServiceEntry(entry: unknown): McpServiceEntry {
	if (!isRecord(entry)) {
		throw new Error(`catalog entry must be an object, got ${typeof entry}`);
	}
	const entryId = typeof entry.server === "string" ? entry.server : "<unknown>";
	const server = requireString(entryId, "server", entry.server);
	if (!SERVER_ID_PATTERN.test(server)) {
		fail(entryId, `server id must match ${SERVER_ID_PATTERN}`);
	}
	const label = requireString(entryId, "label", entry.label);
	const service = requireString(entryId, "service", entry.service);
	const description = typeof entry.description === "string" ? entry.description : undefined;
	const category = typeof entry.category === "string" ? entry.category : undefined;
	const publisher = typeof entry.publisher === "string" ? entry.publisher : undefined;
	if (typeof entry.url !== "string") fail(entryId, "url must be a string");
	const url: string = entry.url;

	if (!isRecord(entry.transport) || typeof entry.transport.type !== "string") {
		fail(entryId, "transport must be an object with a type");
	}
	const transportType = entry.transport.type;
	if (!TRANSPORT_TYPES.has(transportType)) {
		fail(entryId, `transport.type must be one of ${[...TRANSPORT_TYPES].join(", ")}`);
	}
	let transport: McpServiceTransport;
	if (transportType === "http" || transportType === "sse") {
		const transportUrl = requireHttpsUrl(entryId, "transport.url", entry.transport.url);
		if (url !== transportUrl) fail(entryId, "url must equal transport.url");
		transport = transportType === "http" ? { type: "http", url: transportUrl } : { type: "sse", url: transportUrl };
	} else if (transportType === "http-template") {
		const template = requireString(entryId, "transport.template", entry.transport.template);
		const variables = entry.transport.variables;
		if (!Array.isArray(variables) || variables.length === 0) {
			fail(entryId, "http-template transports need at least one variable");
		}
		if (url !== "") fail(entryId, "url must be empty for http-template transports");
		transport = {
			type: "http-template",
			template,
			variables: variables.map((variable) => {
				if (!isRecord(variable)) fail(entryId, "transport.variables entries must be objects");
				return {
					name: requireString(entryId, "transport.variables[].name", variable.name),
					description: requireString(entryId, "transport.variables[].description", variable.description),
				};
			}),
		};
	} else {
		const servers = entry.transport.servers;
		if (!Array.isArray(servers) || servers.length === 0) {
			fail(entryId, "stdio transports need at least one server");
		}
		if (url !== "") fail(entryId, "url must be empty for stdio transports");
		transport = {
			type: "stdio",
			servers: servers.map((serverDef) => {
				if (!isRecord(serverDef)) fail(entryId, "transport.servers entries must be objects");
				const args = Array.isArray(serverDef.args)
					? serverDef.args.map((arg) => requireString(entryId, "transport.servers[].args[]", arg))
					: undefined;
				const env: Record<string, string> = {};
				if (isRecord(serverDef.env)) {
					for (const [key, value] of Object.entries(serverDef.env)) {
						if (typeof value !== "string") fail(entryId, "transport.servers[].env values must be strings");
						env[key] = value;
					}
				}
				return {
					name: requireString(entryId, "transport.servers[].name", serverDef.name),
					command: requireString(entryId, "transport.servers[].command", serverDef.command),
					args,
					env: Object.keys(env).length > 0 ? env : undefined,
				};
			}),
		};
	}

	if (!isRecord(entry.auth)) fail(entryId, "auth must be an object");
	const strategy = entry.auth.strategy;
	if (typeof strategy !== "string" || !AUTH_STRATEGIES.has(strategy)) {
		fail(entryId, `auth.strategy must be one of ${[...AUTH_STRATEGIES].join(", ")}`);
	}
	const clientRegistration = entry.auth.clientRegistration;
	if (typeof clientRegistration !== "string" || !CLIENT_REGISTRATIONS.has(clientRegistration)) {
		fail(entryId, `auth.clientRegistration must be one of ${[...CLIENT_REGISTRATIONS].join(", ")}`);
	}
	const strategyTyped = strategy as McpServiceAuth["strategy"];
	const clientRegistrationTyped = clientRegistration as McpServiceAuth["clientRegistration"];
	const reviewedScopes = Array.isArray(entry.auth.reviewedScopes)
		? entry.auth.reviewedScopes.map((scope) => requireString(entryId, "auth.reviewedScopes[]", scope))
		: undefined;
	const alternatives =
		entry.auth.alternatives === undefined ? undefined : requireAuthAlternatives(entryId, entry.auth.alternatives);
	const metadata = entry.auth.metadata === undefined ? undefined : requireAuthMetadata(entryId, entry.auth.metadata);
	const auth: McpServiceAuth = {
		strategy: strategyTyped,
		clientRegistration: clientRegistrationTyped,
		...(reviewedScopes ? { reviewedScopes } : {}),
		...(alternatives ? { alternatives } : {}),
		...(metadata ? { metadata } : {}),
	};

	if (!isRecord(entry.setup)) fail(entryId, "setup must be an object");
	const setupStatus = entry.setup.status;
	if (typeof setupStatus !== "string" || !SETUP_STATUSES.has(setupStatus)) {
		fail(entryId, `setup.status must be one of ${[...SETUP_STATUSES].join(", ")}`);
	}
	if (setupStatus === "requires-setup" && typeof entry.setup.reason !== "string") {
		fail(entryId, "requires-setup entries need a reason");
	}
	const fields = entry.setup.fields === undefined ? undefined : requireSetupFields(entryId, entry.setup.fields);
	if (
		entry.setup.readiness !== undefined &&
		(typeof entry.setup.readiness !== "string" || !READINESS_STATES.has(entry.setup.readiness))
	) {
		fail(entryId, `setup.readiness must be one of ${[...READINESS_STATES].join(", ")}`);
	}
	if (
		entry.setup.requirement !== undefined &&
		(typeof entry.setup.requirement !== "string" || !SETUP_REQUIREMENTS.has(entry.setup.requirement))
	) {
		fail(entryId, `setup.requirement must be one of ${[...SETUP_REQUIREMENTS].join(", ")}`);
	}
	const setup: McpServiceSetup = {
		status: setupStatus as McpServiceSetup["status"],
		...(typeof entry.setup.reason === "string" ? { reason: entry.setup.reason } : {}),
		...(fields ? { fields } : {}),
		...(typeof entry.setup.readiness === "string" ? { readiness: entry.setup.readiness as McpReadiness } : {}),
		...(typeof entry.setup.requirement === "string"
			? { requirement: entry.setup.requirement as McpSetupRequirement }
			: {}),
	};

	if (!isRecord(entry.verification) || typeof entry.verification.status !== "string") {
		fail(entryId, "verification must be an object with a status");
	}
	if (entry.verification.status !== "metadata-reviewed" && entry.verification.status !== "unverified") {
		fail(entryId, 'verification.status must be "metadata-reviewed" or "unverified"');
	}
	if (typeof entry.legacyBuiltin !== "boolean") fail(entryId, "legacyBuiltin must be a boolean");

	let oauth: McpServiceEntry["oauth"];
	if (entry.oauth !== undefined) {
		if (!isRecord(entry.oauth) || entry.oauth.kind !== "oauth") {
			fail(entryId, 'oauth must carry kind "oauth"');
		}
		if (strategy !== "oauth") {
			fail(entryId, "oauth is only allowed on oauth-strategy entries");
		}
		const scopes = typeof entry.oauth.scopes === "string" ? entry.oauth.scopes : undefined;
		const clientId = typeof entry.oauth.clientId === "string" ? entry.oauth.clientId : undefined;
		if (clientId !== undefined) {
			fail(entryId, "catalog entries must not carry OAuth client ids");
		}
		oauth = { kind: "oauth", ...(scopes !== undefined ? { scopes } : {}) };
	}

	if (!Array.isArray(entry.aliases)) fail(entryId, "aliases must be an array");
	const aliases = entry.aliases.map((alias) => {
		if (typeof alias !== "string" || alias !== alias.toLowerCase() || alias === server) {
			fail(entryId, "aliases must be lowercase strings distinct from the server id");
		}
		return alias;
	});
	for (let index = 1; index < aliases.length; index++) {
		if (aliases[index] <= aliases[index - 1]) {
			fail(entryId, "aliases must be sorted and unique");
		}
	}

	if (!Array.isArray(entry.provenance) || entry.provenance.length === 0) {
		fail(entryId, "provenance must be a non-empty array");
	}
	const provenance = entry.provenance.map((prov) => {
		if (!isRecord(prov) || !PROVENANCE_SOURCES.has(prov.source as string)) {
			fail(entryId, `provenance.source must be one of ${[...PROVENANCE_SOURCES].join(", ")}`);
		}
		return prov as unknown as McpServiceProvenance;
	});

	return {
		server,
		service,
		label,
		url,
		description,
		category,
		aliases,
		publisher,
		transport,
		auth,
		setup,
		verification: { status: entry.verification.status },
		legacyBuiltin: entry.legacyBuiltin,
		...(oauth !== undefined ? { oauth } : {}),
		provenance,
		homepage: typeof entry.homepage === "string" ? entry.homepage : undefined,
		docsUrl: typeof entry.docsUrl === "string" ? entry.docsUrl : undefined,
		privacyUrl: typeof entry.privacyUrl === "string" ? entry.privacyUrl : undefined,
		supportUrl: typeof entry.supportUrl === "string" ? entry.supportUrl : undefined,
	};
}

const SUPPORTED_CATALOG_VERSIONS = new Set([1, 2]);

function parseCatalog(data: CatalogFileShape): CatalogFileShape {
	// Version 2 adds optional readiness/requirement/field-kind/alternatives/
	// metadata-evidence fields (additive: every new field is optional).
	if (!SUPPORTED_CATALOG_VERSIONS.has(data.version)) {
		throw new Error(`catalog has unsupported version ${String(data.version)}`);
	}
	if (!Array.isArray(data.entries)) {
		throw new Error("catalog must contain an entries array");
	}
	const seen = new Set<string>();
	const entries = data.entries.map((entry) => {
		const validated = validateMcpServiceEntry(entry);
		if (seen.has(validated.server)) {
			throw new Error(`catalog contains duplicate server id ${validated.server}`);
		}
		seen.add(validated.server);
		return validated;
	});
	entries.sort((a, b) => a.server.localeCompare(b.server));
	for (const entry of entries) {
		Object.freeze(entry.transport);
		Object.freeze(entry.auth);
		Object.freeze(entry.setup);
		Object.freeze(entry.verification);
		Object.freeze(entry.provenance);
		Object.freeze(entry.aliases);
		Object.freeze(entry.oauth);
		Object.freeze(entry);
	}
	return { ...data, entries };
}

const CATALOG = parseCatalog(CATALOG_DATA);

/** The full imported service catalog, sorted by server id. */
export const SERVICE_CATALOG: readonly McpServiceEntry[] = CATALOG.entries;

/**
 * Legacy built-in integrations that pre-date the catalog (the `legacyBuiltin`
 * slice): their ids stay reserved. User servers go in the `mcpServers` setting
 * instead; local catalog sources cannot shadow or rebind these ids.
 */
export const BUILTIN_MCP_CATALOG: readonly McpServiceEntry[] = SERVICE_CATALOG.filter((entry) => entry.legacyBuiltin);

/** The full catalog (also available as the `SERVICE_CATALOG` const). */
export function listServiceCatalog(): readonly McpServiceEntry[] {
	return SERVICE_CATALOG;
}

/** Look up any catalog service by stable id. */
export function getServiceCatalogEntry(server: string): McpServiceEntry | undefined {
	return SERVICE_CATALOG.find((entry) => entry.server === server);
}

/** Look up a bundled-skill built-in entry (legacy semantics, unchanged). */
export function getCatalogEntry(server: string): McpServiceEntry | undefined {
	return BUILTIN_MCP_CATALOG.find((entry) => entry.server === server);
}

/**
 * Case-insensitive substring search over server id, brand, label and aliases.
 * Deterministic order (server id); an empty query matches nothing.
 */
export function searchServiceCatalog(query: string): McpServiceEntry[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	return SERVICE_CATALOG.filter((entry) => {
		if (entry.server.includes(needle) || entry.service.includes(needle)) return true;
		if (entry.label.toLowerCase().includes(needle)) return true;
		return entry.aliases.some((alias) => alias.includes(needle));
	});
}

/**
 * Register the built-in catalog's OAuth providers. Idempotent. Must be called
 * after any resetOAuthProviders() (e.g. ModelRegistry.refresh) since reset drops
 * everything but the model-provider built-ins.
 */
export function registerBuiltinMcpOAuthProviders(): void {
	for (const entry of BUILTIN_MCP_CATALOG) {
		if (entry.oauth?.kind !== "oauth") continue;
		const id = `mcp:${entry.server}`;
		if (getOAuthProvider(id)) continue;
		registerOAuthProvider(
			createMcpOAuthProvider({
				server: entry.server,
				label: entry.label,
				url: entry.url,
				scopes: entry.oauth.scopes,
				clientId: entry.oauth.clientId,
			}),
		);
	}
}
