// Tiny built-in MCP fallback plus schema validation for remote service catalogs.
// The full catalog is fetched by the host from PrimeIntellect-ai/prime-agent-catalog
// and cached on user devices. This package keeps only legacy built-ins that must
// be available offline and whose ids stay reserved.

import { getOAuthProvider, registerOAuthProvider } from "../utils/oauth/index.js";
import { createMcpOAuthProvider, type McpOAuthConfig } from "./oauth.js";
import { isLiteralPrivateOrLoopbackHost } from "./url-checks.js";

export interface McpServiceProvenance {
	/** `prime` for curated data, or `user` for local sources. */
	source: "prime" | "user";
}

export type McpServiceSetupFieldKind = "env-var" | "url" | "client-id" | "client-secret" | "bearer-token" | "api-key";

export interface McpServiceSetupField {
	id: string;
	label: string;
	description?: string;
	required: boolean;
	/** What the field collects. Absent means the importer had no signal (legacy generic env-var). */
	kind?: McpServiceSetupFieldKind;
	/**
	 * Fields sharing a credential-set id are ALTERNATIVE NAMES for one
	 * credential (GitHub's GITHUB_PAT_TOKEN and GITHUB_PERSONAL_ACCESS_TOKEN
	 * name the same PAT). The paste flow prompts ONCE for the credential and
	 * stores the value under the first alternative; the importer refuses to
	 * ship a requires-setup entry whose required credential fields resolve to
	 * more than one distinct credential, because the runtime sends exactly one
	 * Authorization: Bearer per connection.
	 */
	credentialSet?: string;
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

export interface McpServiceAuth {
	strategy: "oauth" | "api_key" | "none" | "unknown";
	/** How an OAuth client is obtained; `unknown` means discovery is attempted at connect. */
	clientRegistration: "dynamic" | "pre-registered" | "unknown";
	/** Reviewed upstream scope hints only; never auto-requested, and empty in the first snapshot. */
	reviewedScopes?: string[];
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
	/** Present on OAuth-strategy entries; consumers key OAuth support off `auth.strategy` (the host uses authStrategy), not this marker. */
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
const PROVENANCE_SOURCES = new Set(["prime", "user"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
	entryId: string,
	label: string,
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
): void {
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (unknown.length > 0) {
		fail(entryId, `${label} has unsupported keys: ${unknown.sort().join(", ")}`);
	}
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
		if (field.credentialSet !== undefined && (typeof field.credentialSet !== "string" || !field.credentialSet)) {
			return fail(entryId, "setup.fields[].credentialSet must be a non-empty string");
		}
		return {
			id: requireString(entryId, "setup.fields[].id", field.id),
			label: requireString(entryId, "setup.fields[].label", field.label),
			description: typeof field.description === "string" ? field.description : undefined,
			required: field.required === true,
			...(typeof field.kind === "string" ? { kind: field.kind as McpServiceSetupFieldKind } : {}),
			...(typeof field.credentialSet === "string" && field.credentialSet
				? { credentialSet: field.credentialSet }
				: {}),
		};
	});
}

const CATALOG_KEYS = new Set(["version", "counts", "entries"]);
const ENTRY_KEYS = new Set([
	"server",
	"service",
	"label",
	"url",
	"description",
	"category",
	"aliases",
	"publisher",
	"transport",
	"auth",
	"setup",
	"verification",
	"legacyBuiltin",
	"oauth",
	"provenance",
	"homepage",
	"docsUrl",
	"privacyUrl",
	"supportUrl",
]);
const AUTH_KEYS = new Set(["strategy", "clientRegistration", "reviewedScopes"]);
const PROVENANCE_KEYS = new Set(["source"]);
/**
 * Structural validation for one catalog entry. Also usable for user-authored
 * local service entries so local sources validate against the same contract.
 */
export function validateMcpServiceEntry(entry: unknown): McpServiceEntry {
	if (!isRecord(entry)) {
		throw new Error(`catalog entry must be an object, got ${typeof entry}`);
	}
	const entryId = typeof entry.server === "string" ? entry.server : "<unknown>";
	rejectUnknownKeys(entryId, "entry", entry, ENTRY_KEYS);
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
	rejectUnknownKeys(entryId, "auth", entry.auth, AUTH_KEYS);
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
	const auth: McpServiceAuth = {
		strategy: strategyTyped,
		clientRegistration: clientRegistrationTyped,
		...(reviewedScopes ? { reviewedScopes } : {}),
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
		// Secrets fail loudly instead of silently dropping (symmetric with the client-id rejection).
		const rawOauth = entry.oauth as Record<string, unknown>;
		for (const secretKey of ["clientSecret", "client_secret"]) {
			if (rawOauth[secretKey] !== undefined) {
				fail(entryId, "catalog entries must not carry OAuth client secrets");
			}
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
		if (!isRecord(prov)) {
			fail(entryId, "provenance entries must be objects");
		}
		rejectUnknownKeys(entryId, "provenance", prov, PROVENANCE_KEYS);
		if (!PROVENANCE_SOURCES.has(prov.source as string)) {
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

function parseCatalog(data: unknown): CatalogFileShape {
	if (!isRecord(data)) {
		throw new Error("catalog must be an object");
	}
	// Version 2 keeps only working client data in the public plugin payload.
	rejectUnknownKeys("<catalog>", "catalog", data, CATALOG_KEYS);
	if (typeof data.version !== "number" || !SUPPORTED_CATALOG_VERSIONS.has(data.version)) {
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
	return {
		version: data.version,
		counts: isRecord(data.counts) ? (data.counts as Record<string, number>) : {},
		entries,
	};
}

/** Parse and validate an MCP service catalog file. Remote/local callers fail closed on errors. */
export function parseMcpServiceCatalogFile(data: unknown): CatalogFileShape {
	return parseCatalog(data);
}

const FALLBACK_CATALOG_DATA = {
	version: 2,
	counts: {
		entries: 2,
	},
	entries: [
		{
			server: "linear",
			service: "linear",
			label: "Linear",
			url: "https://mcp.linear.app/mcp",
			description:
				"Search, create and update Linear issues, projects, and initiatives. Draft PRDs, write updates, analyze customer requests, and keep plans up to date — all from within ChatGPT",
			category: "Productivity",
			aliases: ["linear-app"],
			publisher: "Linear",
			transport: {
				type: "http",
				url: "https://mcp.linear.app/mcp",
			},
			auth: {
				strategy: "oauth",
				clientRegistration: "dynamic",
			},
			setup: {
				status: "ready",
				readiness: "oauth-ready",
			},
			verification: {
				status: "metadata-reviewed",
			},
			legacyBuiltin: true,
			provenance: [
				{
					source: "prime",
				},
			],
			homepage: "https://linear.app/",
			privacyUrl: "https://linear.app/privacy",
			supportUrl: "https://linear.app/contact",
			oauth: {
				kind: "oauth",
			},
		},
		{
			server: "notion",
			service: "notion",
			label: "Notion",
			url: "https://mcp.notion.com/mcp",
			description:
				"Notion workflows for implementation planning, research synthesis, meeting preparation, and knowledge capture.",
			category: "Productivity",
			aliases: ["notion-workspace"],
			publisher: "Notion",
			transport: {
				type: "http",
				url: "https://mcp.notion.com/mcp",
			},
			auth: {
				strategy: "oauth",
				clientRegistration: "dynamic",
			},
			setup: {
				status: "ready",
				readiness: "oauth-ready",
			},
			verification: {
				status: "metadata-reviewed",
			},
			legacyBuiltin: true,
			provenance: [
				{
					source: "prime",
				},
			],
			homepage: "https://www.notion.so/",
			privacyUrl: "https://www.notion.com/help/privacy",
			oauth: {
				kind: "oauth",
			},
		},
	],
} satisfies CatalogFileShape;

const CATALOG = parseCatalog(FALLBACK_CATALOG_DATA);

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
