// Service-catalog view builders: the shared projection of catalog services and
// user-declared MCP servers used by the /plugins picker, the mcp.* host requests,
// and the kernel inventory. Pure data assembly over auth.json credentials and
// connection records; no secrets ever leave this module.

import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalCatalogLoadResult, McpServiceEntry } from "@earendil-works/pi-ai/mcp";
import { createMcpOAuthProvider, loadLocalServiceCatalog, SERVICE_CATALOG } from "@earendil-works/pi-ai/mcp";
import type { AuthCredential, AuthStorage } from "../auth-storage.js";
import type { McpServerConfig } from "../settings-manager.js";
import { MCP_PROBE_ERRORS, probeMcpEndpoint } from "./connection-probe.js";
import type { McpConnectionRecord, McpConnectionStore } from "./connection-store.js";

/**
 * Connection status vocabulary shared with the kernel host-request contract.
 * "connected" requires a verified handshake (connection record), never bare token
 * presence; "pending" means credentials exist but verification has not succeeded yet.
 */
export type McpConnectionStatus = "connected" | "pending" | "not_connected" | "setup_required" | "disabled" | "error";

export interface McpPluginView {
	/** Catalog service id, or the user server name for user-declared servers. */
	serviceId: string;
	label: string;
	connectionStatus: McpConnectionStatus;
	/** True when the service can be connected through the host OAuth flow right now. */
	connectable: boolean;
	/** A fresh additional account obeys current definition capabilities. */
	addAccountAllowed?: boolean;
	/** Active login ownership, distinct from pending endpoint verification. */
	loginPending?: boolean;
	usesOAuth: boolean;
	source: "catalog" | "user";
	/** Kernel dispatch ids (`mcp.list_tools("<id>")`); empty unless credentials make dispatch possible. */
	connectionIds: string[];
	/** View-only marker: this row removes the account instead of connecting. */
	removeAction?: boolean;
	/** Catalog metadata aliases (searchable; never runtime claims). */
	aliases?: string[];
	description?: string;
	category?: string;
	publisher?: string;
	docsUrl?: string;
	/** Honest requirement or failure detail; non-empty for setup_required and error states. */
	setupHint?: string;
	/** True when the catalog entry itself has not been vetted (imported definition). */
	unverified?: boolean;
	/** From the connection record, when connected. */
	verifiedAt?: number;
	toolCount?: number;
}

export interface McpConnectionView {
	/** The dispatch id: mcp.config + list_tools/call_tool address this. */
	connectionId: string;
	serviceId?: string;
	label: string;
	status: Exclude<McpConnectionStatus, "setup_required" | "not_connected"> | "not_connected" | "disabled";
	usesOAuth: boolean;
	transport: "http" | "stdio";
	loginPending?: boolean;
	source: "catalog" | "user" | "acp";
	setupHint?: string;
}

export interface McpServiceDescriptor {
	/** Stable service id; kernel dispatch id and `mcp:<serviceId>` credential key. */
	serviceId: string;
	label: string;
	aliases: string[];
	description?: string;
	category?: string;
	publisher?: string;
	/** Brand grouping id from the merged catalog (search groups by it). */
	brand?: string;
	docsUrl?: string;
	homepage?: string;
	transport: { type: "http"; url: string } | { type: "http-template" | "stdio" | "other" };
	authStrategy: "oauth" | "api_key" | "none" | "unknown";
	setup: { status: "ready" | "requires-setup"; reason?: string };
	/** True only for legacy built-ins whose provider OAuth metadata was reviewed. Never a runtime/interop claim. */
	metadataReviewed: boolean;
	/** Advisory client-registration capability mirrored from the catalog (shapes engine error guidance only). */
	clientRegistration?: "dynamic" | "pre-registered" | "unknown";
	/** Reviewed upstream scope hints; joined into the engine's requested scopes when present. */
	reviewedScopes?: string[];
	/** True for pre-catalog legacy built-ins; their ids stay reserved. */
	legacyBuiltin: boolean;
	/** True when the entry came from a user-declared local catalog file (trusted by construction). */
	localSource?: boolean;
	/** True when the service's source vanished; the descriptor is pinned to the installed record's endpoint. */
	pinnedFromRecord?: boolean;
}

export type McpServiceCatalogProvider = () => readonly McpServiceDescriptor[];

/** Result of merging the built-in catalog with declared local sources. */
export interface McpCatalogResolution {
	descriptors: readonly McpServiceDescriptor[];
	/** Human-readable wiring diagnostics; visible, never silent. */
	diagnostics: string[];
}

/**
 * Map one merged-catalog entry onto the host descriptor shape. `localSource`
 * marks entries from a user-declared file (trusted by construction: the user
 * placed the file); the metadataReviewed flag mirrors the entry's own review
 * state and is never inferred for local files.
 */
function mapCatalogEntry(entry: McpServiceEntry, localSource: boolean): McpServiceDescriptor {
	const transport: McpServiceDescriptor["transport"] =
		entry.transport.type === "http" && entry.url
			? { type: "http", url: entry.url }
			: entry.transport.type === "http-template"
				? { type: "http-template" }
				: entry.transport.type === "stdio"
					? { type: "stdio" }
					: { type: "other" };
	return {
		serviceId: entry.server,
		label: entry.label,
		aliases: entry.aliases ?? [],
		...(entry.description ? { description: entry.description } : {}),
		...(entry.category ? { category: entry.category } : {}),
		...(entry.publisher ? { publisher: entry.publisher } : {}),
		...(entry.service ? { brand: entry.service } : {}),
		...(entry.docsUrl ? { docsUrl: entry.docsUrl } : {}),
		...(entry.homepage ? { homepage: entry.homepage } : {}),
		transport,
		authStrategy: entry.auth.strategy,
		setup: {
			status: entry.setup.status,
			...(entry.setup.reason ? { reason: entry.setup.reason } : {}),
		},
		metadataReviewed: entry.verification?.status === "metadata-reviewed",
		...(entry.auth.clientRegistration ? { clientRegistration: entry.auth.clientRegistration } : {}),
		...(entry.auth.reviewedScopes !== undefined && entry.auth.reviewedScopes.length > 0
			? { reviewedScopes: [...entry.auth.reviewedScopes] }
			: {}),
		legacyBuiltin: entry.legacyBuiltin === true,
		...(localSource ? { localSource: true } : {}),
	};
}

const MAX_TOTAL_CATALOG_ENTRIES = 500;

/** Expand a leading ~ in a declared source path; other spellings pass through. */
function expandSourcePath(rawPath: string): string {
	if (rawPath === "~" || rawPath.startsWith("~/")) {
		return join(homedir(), rawPath.slice(1));
	}
	return rawPath;
}

/**
 * Resolve the merged service catalog: the built-in SERVICE_CATALOG plus every
 * declared local source (settings mcpCatalogSources, ~-expanded here — the
 * loader does no expansion by design). First source wins per id; declared-but-
 * missing files and duplicate ids surface as visible diagnostics; a total cap
 * keeps the merged catalog bounded. The SAME resolution feeds the host handlers
 * and the /plugins UI, so both views agree.
 */
export function resolveMcpServiceCatalog(options: {
	localSources?: readonly string[];
	loadLocal?: typeof loadLocalServiceCatalog;
	/**
	 * Existing connection records. A record whose service came from an optional
	 * local source that no longer loads keeps a durable PINNED descriptor built
	 * from the record's endpoint, so installed credentials are never retargeted
	 * and the connection stays manageable (verify/disconnect) by its own id.
	 */
	records?: readonly McpConnectionRecord[];
}): McpCatalogResolution {
	const loadLocal = options.loadLocal ?? loadLocalServiceCatalog;
	const diagnostics: string[] = [];
	const byId = new Map<string, McpServiceDescriptor>();
	const addEntry = (entry: McpServiceEntry, localSource: boolean): void => {
		if (byId.has(entry.server)) {
			diagnostics.push(`Duplicate MCP service id "${entry.server}"; the first source wins.`);
			return;
		}
		byId.set(entry.server, mapCatalogEntry(entry, localSource));
	};
	for (const entry of SERVICE_CATALOG) {
		addEntry(entry, false);
	}
	for (const rawPath of options.localSources ?? []) {
		const expanded = expandSourcePath(rawPath);
		let loaded: LocalCatalogLoadResult;
		try {
			loaded = loadLocal(expanded);
		} catch (error) {
			// One unreadable/invalid source never blocks the rest: built-ins and
			// every other source keep resolving; the problem is a visible,
			// bounded diagnostic instead of a startup failure.
			const reason = error instanceof Error ? error.message : "unknown error";
			diagnostics.push(`MCP catalog source failed to load: ${rawPath}: ${reason.slice(0, 200)}`);
			continue;
		}
		// The loader reports a missing file as path:""; a declared source that
		// does not exist must be a visible diagnostic, never a silent skip.
		if (!loaded.path) {
			diagnostics.push(`Declared MCP catalog source not found: ${rawPath}`);
			continue;
		}
		for (const entry of loaded.entries) {
			addEntry(entry, true);
		}
	}
	// Durable pins: records of services the catalog no longer defines.
	for (const record of options.records ?? []) {
		if (byId.has(record.serviceId)) continue;
		byId.set(record.serviceId, {
			serviceId: record.serviceId,
			label: record.label,
			aliases: [],
			// Pinned to the endpoint the credential was verified against.
			transport: { type: "http", url: record.endpoint },
			authStrategy: "oauth",
			setup: { status: "ready" },
			metadataReviewed: false,
			clientRegistration: "unknown",
			legacyBuiltin: false,
			// Pinned-from-record is its OWN trust state: the source vanished, so
			// the pin reuses user-placed trust semantics for NOTHING — it keeps
			// the installed connection manageable but never one-click connectable.
			pinnedFromRecord: true,
		});
	}
	const descriptors = [...byId.values()];
	if (descriptors.length > MAX_TOTAL_CATALOG_ENTRIES) {
		// Installed connections and built-in services are never trimmed: every
		// serviceId with records survives the cap (pinned from the record or
		// still present in a source), and legacy builtins keep their reserved
		// names — dropping one would resurrect shadow user entries and hide
		// credential-only legacy accounts. Only uninstalled candidates fill
		// the remaining budget. When the retained inventory alone exceeds the
		// cap it still wins and the diagnostic states it explicitly instead of
		// silently dropping manageability.
		const installedIds = new Set((options.records ?? []).map((record) => record.serviceId));
		const retained = (descriptor: McpServiceDescriptor): boolean =>
			installedIds.has(descriptor.serviceId) || descriptor.legacyBuiltin;
		const kept = descriptors.filter(retained);
		const budget = Math.max(0, MAX_TOTAL_CATALOG_ENTRIES - kept.length);
		const fill = descriptors.filter((descriptor) => !retained(descriptor)).slice(0, budget);
		const ignored = descriptors.length - kept.length - fill.length;
		diagnostics.push(
			`MCP service catalog discovery capped at ${MAX_TOTAL_CATALOG_ENTRIES} entries; ${ignored} entries were ignored. Installed connections and built-in services are always kept${
				kept.length > MAX_TOTAL_CATALOG_ENTRIES
					? ` (retained inventory alone exceeded the cap: ${kept.length} kept — ${installedIds.size} installed connections)`
					: ""
			}.`,
		);
		return { descriptors: [...kept, ...fill], diagnostics };
	}
	return { descriptors, diagnostics };
}

/**
 * Default catalog source: the merged built-in SERVICE_CATALOG plus any declared
 * local sources. Callers without settings wiring get the built-in catalog only.
 */
export function defaultServiceCatalogProvider(
	localSources?: readonly string[] | (() => readonly string[]),
	records?: readonly McpConnectionRecord[] | (() => readonly McpConnectionRecord[]),
): McpServiceCatalogProvider {
	const getSources = typeof localSources === "function" ? localSources : () => localSources ?? [];
	const getRecords = typeof records === "function" ? records : () => records ?? [];
	return () => resolveMcpServiceCatalog({ localSources: getSources(), records: getRecords() }).descriptors;
}

/**
 * Resolver result with diagnostics, for callers that surface wiring problems
 * (the /plugins UI banner and host logs).
 */
export function resolveServiceCatalogWithDiagnostics(
	localSources?: readonly string[],
	records?: readonly McpConnectionRecord[],
): McpCatalogResolution {
	return resolveMcpServiceCatalog({ localSources, records });
}

/** Reserved definitions keep one canonical owner across UI and dispatch. */
export function reservedMcpOwnership(
	service: McpServiceDescriptor | undefined,
	config: McpServerConfig | undefined,
): { status: "canonical" | "disabled" | "conflict"; setupHint?: string } {
	if (!service?.legacyBuiltin || !config) return { status: "canonical" };
	if (config.enabled === false) return { status: "disabled", setupHint: "Disabled in settings." };
	if (
		config.type === "http" &&
		service.transport.type === "http" &&
		config.url === service.transport.url &&
		config.oauth === true &&
		config.bearerTokenEnvVar === undefined &&
		Object.keys(config.headers ?? {}).length === 0
	) {
		return { status: "canonical" };
	}
	return {
		status: "conflict",
		setupHint:
			"This name belongs to a built-in service. Rename or remove the conflicting server settings; saved accounts remain available for removal.",
	};
}

function concreteOAuthEndpoint(endpoint: string | undefined): endpoint is string {
	if (!endpoint || /[{}]/.test(endpoint)) return false;
	try {
		const url = new URL(endpoint);
		return (
			!url.username &&
			!url.password &&
			!url.hash &&
			(url.protocol === "https:" ||
				(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
		);
	} catch {
		return false;
	}
}

/** A discoverable OAuth candidate is not a certification or a successful connection. */
export function freshMcpLoginAllowed(service: McpServiceDescriptor): boolean {
	return (
		service.transport.type === "http" &&
		concreteOAuthEndpoint(service.transport.url) &&
		(service.authStrategy === "oauth" || service.authStrategy === "unknown") &&
		service.setup.status === "ready" &&
		service.pinnedFromRecord !== true
	);
}

/** Resolve one operation, never infer approval from an aggregate account status. */
export function mcpLoginEligibility(options: {
	connectionId: string;
	service?: McpServiceDescriptor;
	userConfig?: McpServerConfig;
	reservedConfig?: McpServerConfig;
	record: McpConnectionRecord | undefined;
	credential: AuthCredential | undefined;
	addAccount?: boolean;
	/** Explicit login commands (/mcp login, /login, config menu) carry OAuth intent. */
	explicitLogin?: boolean;
}): { allowed: boolean; endpoint?: string; setupHint?: string; repair?: boolean } {
	const { service, record, credential, connectionId } = options;
	const deny = (setupHint: string) => ({ allowed: false, setupHint });
	const ownership = reservedMcpOwnership(service, options.reservedConfig);
	if (ownership.status !== "canonical") return deny(ownership.setupHint!);
	if (record?.attemptId !== undefined) return deny("Login in progress. Finish it or remove the account to cancel.");
	const config = service?.legacyBuiltin ? undefined : options.userConfig;
	if (config?.enabled === false) return deny("Disabled in settings.");
	// An explicit login command carries OAuth intent itself; a settings HTTP
	// server without `oauth: true` still logs in through the guarded flow. The
	// picker's fresh Connect keeps the stricter check instead.
	if (
		config &&
		(config.type !== "http" ||
			config.bearerTokenEnvVar !== undefined ||
			(options.explicitLogin !== true && config.oauth !== true))
	) {
		return deny("This server uses settings-managed authentication. Manage it through /mcp or settings.");
	}
	if (!config && service && service.authStrategy !== "oauth" && service.authStrategy !== "unknown") {
		return deny(service.setup.reason ?? "This service does not use automatic OAuth login.");
	}
	if (service?.setup.status === "requires-setup" && !config) {
		return deny(service.setup.reason ?? "This service requires setup before OAuth login.");
	}
	const boundEndpoint =
		credential?.type === "oauth" &&
		typeof credential.access === "string" &&
		credential.access.length > 0 &&
		typeof credential.endpoint === "string" &&
		concreteOAuthEndpoint(credential.endpoint)
			? credential.endpoint
			: undefined;
	const exactRecord =
		record?.connectionId === connectionId && (!service || record.serviceId === service.serviceId)
			? record
			: undefined;
	const verifiedEndpoint =
		exactRecord?.status === "connected" &&
		Number.isFinite(exactRecord.verifiedAt) &&
		(exactRecord.verifiedAt ?? 0) > 0
			? exactRecord.endpoint
			: undefined;
	const repairEndpoint = exactRecord
		? boundEndpoint === exactRecord.endpoint || verifiedEndpoint === exactRecord.endpoint
			? exactRecord.endpoint
			: undefined
		: boundEndpoint;
	if (options.addAccount && concreteOAuthEndpoint(repairEndpoint)) {
		// Add allocates a NEW account id for an INSTALLED service whose own
		// record proves the endpoint was approved (verified connection or
		// bound credential): the new account lands at that same durable
		// endpoint, never at a changed or unreviewed URL. A pending shell
		// alone still lacks evidence and stays denied.
		return { allowed: true, endpoint: repairEndpoint };
	}
	if (!options.addAccount && !config && concreteOAuthEndpoint(repairEndpoint)) {
		return { allowed: true, endpoint: repairEndpoint, repair: true };
	}
	if (config?.type === "http" && concreteOAuthEndpoint(config.url)) return { allowed: true, endpoint: config.url };
	if (service && freshMcpLoginAllowed(service))
		return { allowed: true, endpoint: service.transport.type === "http" ? service.transport.url : undefined };
	return deny(
		service?.pinnedFromRecord
			? "The catalog source is unavailable. Only an approved saved account endpoint can be repaired; remove this account or restore its source."
			: "This service requires a concrete OAuth endpoint and supported setup before it can be connected.",
	);
}

/**
 * Explicit OAuth client identity resolved from a settings HTTP server.
 * `clientId` is omitted for DCR/public discovery. A CONFIGURED
 * `oauthClientSecretEnvVar` resolves to the env value or the EXPLICIT empty
 * string when it is missing/empty — the engine fails closed on "" before any
 * network request and never falls back to a stale stored secret. Scopes are
 * omitted when unset so the engine keeps its config > PRM > omit precedence.
 */
export interface McpOAuthIdentity {
	clientId?: string;
	clientSecret?: string;
	clientMetadataUrl?: string;
	scopes?: string[];
}

/** Resolve the configured OAuth client identity for a settings HTTP server. */
export function resolveMcpOAuthIdentity(config: McpServerConfig | undefined): McpOAuthIdentity {
	if (!config || config.type !== "http") return {};
	const identity: McpOAuthIdentity = {};
	const clientId = config.oauthClientId?.trim();
	if (clientId) identity.clientId = clientId;
	const secretEnvVar = config.oauthClientSecretEnvVar?.trim();
	if (secretEnvVar) identity.clientSecret = process.env[secretEnvVar]?.trim() ?? "";
	const metadataUrl = config.oauthClientMetadataUrl?.trim();
	if (metadataUrl) identity.clientMetadataUrl = metadataUrl;
	if (config.oauthScopes !== undefined && config.oauthScopes.length > 0) {
		identity.scopes = [...config.oauthScopes];
	}
	return identity;
}

/**
 * The ONE host factory for MCP OAuth providers: every registration site
 * (manager refresh providers, staged login, post-finalize real id) builds the
 * provider here so the identity resolved at LOGIN time is byte-identical to
 * the one used at REFRESH time — the engine pins client identity on the
 * stored credential and refuses mismatches, so a drifting factory would break
 * refresh spuriously. Settings identity wins over catalog scope hints; a
 * catalog NEVER supplies secrets.
 */
export function createConfiguredMcpProvider(options: {
	server: string;
	label?: string;
	url: string;
	identity?: McpOAuthIdentity;
	/** Reviewed catalog scope hints; used only when no settings scopes exist. */
	reviewedScopes?: readonly string[];
	clientRegistration?: "dynamic" | "pre-registered" | "unknown";
}): ReturnType<typeof createMcpOAuthProvider> {
	const identity = options.identity ?? {};
	const scopes =
		identity.scopes !== undefined
			? identity.scopes.join(" ")
			: options.reviewedScopes !== undefined && options.reviewedScopes.length > 0
				? [...options.reviewedScopes].join(" ")
				: undefined;
	return createMcpOAuthProvider({
		server: options.server,
		...(options.label !== undefined ? { label: options.label } : {}),
		url: options.url,
		...(identity.clientId !== undefined ? { clientId: identity.clientId } : {}),
		...(identity.clientSecret !== undefined ? { clientSecret: identity.clientSecret } : {}),
		...(identity.clientMetadataUrl !== undefined ? { clientMetadataUrl: identity.clientMetadataUrl } : {}),
		...(scopes !== undefined ? { scopes } : {}),
		...(options.clientRegistration !== undefined ? { clientRegistration: options.clientRegistration } : {}),
	});
}

export function mcpCredentialKey(connectionId: string): string {
	return `mcp:${connectionId}`;
}

/**
 * Next free per-account connection id for a service. The first account keeps
 * the service id (compat with existing credentials); further accounts get
 * "<serviceId>-2", "-3", ... — distinct ids with distinct credentials and
 * records, so a second login never overwrites the first account.
 */
export function nextMcpConnectionId(serviceId: string, taken: (id: string) => boolean): string {
	if (!taken(serviceId)) return serviceId;
	for (let index = 2; index < 1000; index++) {
		const candidate = `${serviceId}-${index}`;
		if (!taken(candidate)) return candidate;
	}
	throw new Error(`No free connection id for service ${serviceId}`);
}

/** Why a stored OAuth grant is not usable at an endpoint. */
type OAuthGrantUsabilityReason =
	| "missing"
	| "wrong-type"
	| "empty-access"
	| "unbound"
	| "cross-endpoint"
	| "expired-no-refresh";

interface OAuthGrantUsability {
	usable: boolean;
	reason?: OAuthGrantUsabilityReason;
}

/**
 * ONE shared rule for whether a stored credential is a usable OAuth grant at an
 * endpoint: typed oauth, non-empty access, bound to exactly this endpoint, and
 * not expired without a refresh token (Boolean(refresh) semantics). The
 * manager's dispatch eligibility, the account-state resolver, and the picker
 * all consume this predicate so their answers can never drift; verified
 * Connected status and pending-probe needs stay the CALLER's state machine on
 * top of `usable`.
 */
export function oauthGrantUsable(credential: AuthCredential | undefined, endpoint: string): OAuthGrantUsability {
	if (credential === undefined) return { usable: false, reason: "missing" };
	if (credential.type !== "oauth") return { usable: false, reason: "wrong-type" };
	if (typeof credential.access !== "string" || credential.access.length === 0) {
		return { usable: false, reason: "empty-access" };
	}
	if (credential.endpoint === undefined) return { usable: false, reason: "unbound" };
	if (credential.endpoint !== endpoint) return { usable: false, reason: "cross-endpoint" };
	if (typeof credential.expires === "number" && credential.expires <= Date.now() && !credential.refresh) {
		return { usable: false, reason: "expired-no-refresh" };
	}
	return { usable: true };
}

function bearerTokenPresent(bearerTokenEnvVar: string | undefined): boolean {
	if (!bearerTokenEnvVar) return false;
	return Boolean(process.env[bearerTokenEnvVar]?.trim());
}

interface HttpStatusResult {
	status: McpConnectionStatus;
	loginPending?: boolean;
	setupHint?: string;
	record?: McpConnectionRecord;
}

/**
 * Status for an HTTP connection with optional OAuth credential or static bearer
 * token. Token presence alone never yields "connected": without a verified
 * connection record the state is "pending" until the probe succeeds.
 */
function httpConnectionStatus(options: {
	connectionId: string;
	endpoint: string;
	authStorage: AuthStorage;
	connectionStore: McpConnectionStore;
	usesOAuth: boolean;
	bearerTokenEnvVar?: string;
	/** Declared no-auth endpoint: dispatchable without credentials (kernel handshakes). */
	declaredNoAuth?: boolean;
}): HttpStatusResult {
	const { connectionId, endpoint, authStorage, connectionStore, usesOAuth, bearerTokenEnvVar } = options;
	const record = connectionStore.get(connectionId);
	if (record?.attemptId !== undefined) {
		return {
			status: "pending",
			loginPending: true,
			record,
			setupHint: "Login in progress. Finish it or remove the account to cancel.",
		};
	}
	if (usesOAuth && !bearerTokenEnvVar) {
		// ONE shared grant-usability rule (with the manager's dispatch
		// eligibility): wrong-type, empty-access, unbound, cross-endpoint, and
		// expired-no-refresh grants are all unusable here too.
		const grant = oauthGrantUsable(authStorage.get(mcpCredentialKey(connectionId)), endpoint);
		if (!grant.usable) {
			if (grant.reason === "unbound" || grant.reason === "cross-endpoint") {
				// Endpoint binding: a token must prove where it belongs before it
				// counts as usable — for catalog services and user servers alike.
				return {
					status: "error",
					setupHint: "Stored credentials are not bound to this endpoint. Reconnect required.",
				};
			}
			if (grant.reason === "expired-no-refresh") {
				return {
					status: "error",
					setupHint: "Stored credentials expired without a refresh token. Reconnect required.",
				};
			}
			// No usable grant (missing, wrong-type, or empty access): a record
			// without one is a stale connection, not a fresh one.
			if (record?.status === "pending" && record.attemptId === undefined) {
				return {
					status: "not_connected",
					setupHint: "Account settings kept. Connect to finish setup, or remove the account.",
					record,
				};
			}
			if (record) {
				return {
					status: "error",
					setupHint: "Stored credentials are missing. Reconnect required.",
					record,
				};
			}
			return { status: "not_connected" };
		}
		if (record?.status === "connected") return { status: "connected", record };
		if (record?.status === "pending") {
			return { status: "pending", setupHint: record.lastError, record };
		}
		if (record?.status === "error") return { status: "error", setupHint: record.lastError, record };
		return {
			status: "pending",
			setupHint: "Credentials stored; connection verification pending.",
		};
	}
	if (bearerTokenEnvVar) {
		if (!bearerTokenPresent(bearerTokenEnvVar)) {
			if (record) {
				return {
					status: "error",
					setupHint: `The ${bearerTokenEnvVar} environment variable is no longer set. Reconnect required.`,
					record,
				};
			}
			return {
				status: "not_connected",
				setupHint: `Set the ${bearerTokenEnvVar} environment variable to use this server.`,
			};
		}
		if (record?.status === "connected") return { status: "connected", record };
		if (record?.status === "pending") return { status: "pending", setupHint: record.lastError, record };
		if (record?.status === "error") return { status: "error", setupHint: record.lastError, record };
		return { status: "pending", setupHint: "Bearer token present; connection verification pending." };
	}
	if (options.declaredNoAuth) return { status: "connected", record };
	return { status: "not_connected" };
}

function catalogServiceNotConnectedView(service: McpServiceDescriptor): McpPluginView {
	const http = service.transport.type === "http" && service.transport.url ? service.transport.url : undefined;
	const setupHint =
		service.setup.status === "requires-setup"
			? (service.setup.reason ?? "This service requires manual setup before it can be connected.")
			: service.transport.type !== "http" || !service.transport.url
				? "This service uses a stdio adapter or a tenant URL template. Add it manually with /mcp add."
				: service.authStrategy === "api_key"
					? "This service requires an API key. Add it manually with /mcp add."
					: service.authStrategy === "none"
						? "No login required. Add it manually with /mcp add to use it."
						: service.metadataReviewed
							? undefined
							: "OAuth support has not been verified. Connect checks capabilities and asks for approval before login.";
	return {
		serviceId: service.serviceId,
		label: service.label,
		connectionStatus:
			service.setup.status === "requires-setup" || !http || service.authStrategy === "api_key"
				? "setup_required"
				: "not_connected",
		// Connect starts explicit capability discovery and consent, not a verified claim.
		connectable: freshMcpLoginAllowed(service),
		addAccountAllowed: freshMcpLoginAllowed(service),
		usesOAuth: service.authStrategy === "oauth" || service.authStrategy === "unknown",
		source: "catalog",
		connectionIds: [],
		...(service.description ? { description: service.description } : {}),
		...(service.category ? { category: service.category } : {}),
		...(service.publisher ? { publisher: service.publisher } : {}),
		...(service.docsUrl ? { docsUrl: service.docsUrl } : {}),
		...(setupHint ? { setupHint } : {}),
		...(service.metadataReviewed ? {} : { unverified: true }),
		...(service.aliases.length > 0 ? { aliases: service.aliases } : {}),
	};
}

/**
 * One account's honestly-computed state: the credential binding (present,
 * bound to this endpoint, not expired) and the connection record are combined
 * through httpConnectionStatus, so expiry, retargeting, and missing grants
 * surface as reconnect-required regardless of what the record last said.
 * The SAME computation backs the plugin aggregate, the connection inventory,
 * and the account picker — one truth, no stale record.status reads.
 */
export interface McpAccountState {
	connectionId: string;
	loginPending?: boolean;
	status: "connected" | "pending" | "error" | "not_connected" | "disabled" | "setup_required";
	setupHint?: string;
	toolCount?: number;
	verifiedAt?: number;
	lastError?: string;
}

export function accountStateFor(options: {
	connectionId: string;
	endpoint: string;
	authStorage: AuthStorage;
	connectionStore: McpConnectionStore;
	usesOAuth?: boolean;
}): McpAccountState {
	const state = httpConnectionStatus({
		connectionId: options.connectionId,
		endpoint: options.endpoint,
		authStorage: options.authStorage,
		connectionStore: options.connectionStore,
		usesOAuth: options.usesOAuth ?? true,
	});
	return {
		connectionId: options.connectionId,
		status: state.status,
		...(state.loginPending ? { loginPending: true } : {}),
		...(state.setupHint ? { setupHint: state.setupHint } : {}),
		...(state.record?.toolCount !== undefined ? { toolCount: state.record.toolCount } : {}),
		...(state.record?.verifiedAt ? { verifiedAt: state.record.verifiedAt } : {}),
		...(state.record?.lastError ? { lastError: state.record.lastError } : {}),
	};
}

/** Every account of a service (primary first), each with its computed state. */
export function accountStatesFor(options: {
	service: McpServiceDescriptor;
	authStorage: AuthStorage;
	connectionStore: McpConnectionStore;
}): McpAccountState[] {
	const { service, authStorage, connectionStore } = options;
	const url = service.transport.type === "http" ? service.transport.url : undefined;
	if (!url) return [];
	const ids = [
		service.serviceId,
		...connectionStore
			.records()
			.filter((record) => record.serviceId === service.serviceId && record.connectionId !== service.serviceId)
			.map((record) => record.connectionId),
	];
	return ids
		.map((connectionId) => {
			const eligibility = mcpLoginEligibility({
				connectionId,
				service,
				record: connectionStore.get(connectionId),
				credential: authStorage.get(mcpCredentialKey(connectionId)),
			});
			return accountStateFor({
				connectionId,
				endpoint: eligibility.repair && connectionStore.get(connectionId) ? eligibility.endpoint! : url,
				authStorage,
				connectionStore,
				usesOAuth: service.authStrategy === "oauth" || service.authStrategy === "unknown",
			});
		})
		.filter(
			(account) => account.status !== "not_connected" || connectionStore.get(account.connectionId) !== undefined,
		);
}

function baseCatalogServiceView(
	service: McpServiceDescriptor,
	authStorage: AuthStorage,
	connectionStore: McpConnectionStore,
): McpPluginView {
	if (service.transport.type !== "http" || !service.transport.url) {
		return catalogServiceNotConnectedView(service);
	}
	const accounts = accountStatesFor({ service, authStorage, connectionStore });
	if (accounts.length === 0) {
		const primary = httpConnectionStatus({
			connectionId: service.serviceId,
			endpoint: service.transport.url,
			authStorage,
			connectionStore,
			usesOAuth: service.authStrategy === "oauth" || service.authStrategy === "unknown",
		});
		if (primary.status === "not_connected" && service.authStrategy === "none") {
			return catalogServiceNotConnectedView(service);
		}
		const view = catalogServiceNotConnectedView(service);
		// setup.required entries keep their reason; a status-computed hint (binding
		// or expiry problems) wins; otherwise the candidate/transport hints stay.
		if (primary.status === "not_connected" && service.setup.status === "ready" && primary.setupHint !== undefined) {
			view.setupHint = primary.setupHint;
		}
		if (service.pinnedFromRecord) {
			view.setupHint = "This service's catalog source is unavailable; its connection keeps the pinned definition.";
		}
		return view;
	}
	const anyConnected = accounts.some((account) => account.status === "connected");
	const anyPending = accounts.some((account) => account.status === "pending");
	const aggregate = anyConnected
		? "connected"
		: anyPending
			? "pending"
			: accounts.some((account) => account.status === "error")
				? "error"
				: "not_connected";
	const newestConnected = accounts
		.filter((account) => account.status === "connected")
		.sort((left, right) => (right.verifiedAt ?? 0) - (left.verifiedAt ?? 0))[0];
	const errorHint =
		accounts.find((account) => account.loginPending)?.setupHint ??
		accounts.find((account) => account.status === "error")?.setupHint ??
		accounts.find((account) => account.status === "not_connected")?.setupHint;
	const setupHint = service.pinnedFromRecord
		? "This service's catalog source is unavailable; its connection keeps the pinned definition."
		: errorHint;
	return {
		serviceId: service.serviceId,
		label: service.label,
		connectionStatus: aggregate,
		connectable:
			!accounts.some((account) => account.loginPending) &&
			(aggregate === "error" || aggregate === "not_connected") &&
			mcpLoginEligibility({
				connectionId: service.serviceId,
				service,
				record: connectionStore.get(service.serviceId),
				credential: authStorage.get(mcpCredentialKey(service.serviceId)),
			}).allowed,
		addAccountAllowed: freshMcpLoginAllowed(service) && !accounts.some((account) => account.loginPending),
		...(accounts.some((account) => account.loginPending) ? { loginPending: true } : {}),
		usesOAuth: service.authStrategy === "oauth" || service.authStrategy === "unknown",
		source: "catalog",
		// Every account id, so the account picker can manage each one.
		connectionIds: accounts.map((account) => account.connectionId),
		...(service.description ? { description: service.description } : {}),
		...(service.category ? { category: service.category } : {}),
		...(service.publisher ? { publisher: service.publisher } : {}),
		...(service.docsUrl ? { docsUrl: service.docsUrl } : {}),
		...(setupHint ? { setupHint } : {}),
		...(service.metadataReviewed ? {} : { unverified: true }),
		...(newestConnected?.verifiedAt ? { verifiedAt: newestConnected.verifiedAt } : {}),
		...(newestConnected?.toolCount !== undefined ? { toolCount: newestConnected.toolCount } : {}),
		...(service.aliases.length > 0 ? { aliases: service.aliases } : {}),
	};
}

function catalogServiceView(
	service: McpServiceDescriptor,
	authStorage: AuthStorage,
	connectionStore: McpConnectionStore,
	reservedConfig?: McpServerConfig,
): McpPluginView {
	const view = baseCatalogServiceView(service, authStorage, connectionStore);
	const ownership = reservedMcpOwnership(service, reservedConfig);
	if (ownership.status === "canonical") return view;
	return {
		...view,
		connectionStatus: ownership.status === "disabled" ? "disabled" : "error",
		connectable: false,
		addAccountAllowed: false,
		setupHint: ownership.setupHint,
	};
}

function userServerView(
	name: string,
	config: McpServerConfig,
	authStorage: AuthStorage,
	connectionStore: McpConnectionStore,
): McpPluginView {
	const label = name;
	if (config.type === "stdio") {
		return {
			serviceId: name,
			label,
			connectionStatus: config.enabled === false ? "disabled" : "connected",
			connectable: false,
			usesOAuth: false,
			source: "user",
			connectionIds: config.enabled === false ? [] : [name],
			setupHint: config.enabled === false ? "Disabled in settings." : undefined,
		};
	}
	const usesOAuth = config.oauth === true;
	const status = httpConnectionStatus({
		connectionId: name,
		endpoint: config.url,
		authStorage,
		connectionStore,
		usesOAuth,
		bearerTokenEnvVar: config.bearerTokenEnvVar,
		declaredNoAuth: !usesOAuth && !config.bearerTokenEnvVar,
	});
	return {
		serviceId: name,
		label,
		connectionStatus: config.enabled === false ? "disabled" : status.status,
		// not_connected connects; error (rejected credential, unbound grant) reconnects.
		connectable:
			!status.loginPending &&
			mcpLoginEligibility({
				connectionId: name,
				userConfig: config,
				record: connectionStore.get(name),
				credential: authStorage.get(mcpCredentialKey(name)),
			}).allowed &&
			(status.status === "not_connected" || status.status === "error"),
		addAccountAllowed:
			!status.loginPending &&
			config.enabled !== false &&
			usesOAuth &&
			config.bearerTokenEnvVar === undefined &&
			concreteOAuthEndpoint(config.url),
		...(status.loginPending ? { loginPending: true } : {}),
		usesOAuth,
		source: "user",
		connectionIds:
			connectionStore.get(name) !== undefined
				? [name]
				: config.enabled === false || status.status === "error" || status.status === "not_connected"
					? []
					: [name],
		...(status.setupHint ? { setupHint: status.setupHint } : {}),
	};
}

export interface BuildViewsOptions {
	services: readonly McpServiceDescriptor[];
	userServers: Record<string, McpServerConfig> | undefined;
	authStorage: AuthStorage;
	connectionStore: McpConnectionStore;
}

/** Cards for the /plugins picker and the mcp.list_plugins/search host requests. */
export function buildPluginViews(options: BuildViewsOptions): McpPluginView[] {
	const { services, userServers, authStorage, connectionStore } = options;
	const userEntries = Object.entries(userServers ?? {});
	const reservedIds = new Set(services.filter((service) => service.legacyBuiltin).map((service) => service.serviceId));
	const userViews = new Map<string, McpPluginView>();
	for (const [name, config] of userEntries) {
		// Dead shadows: a user entry cannot override a bundled catalog service.
		if (reservedIds.has(name)) continue;
		userViews.set(name, userServerView(name, config, authStorage, connectionStore));
	}
	const views: McpPluginView[] = [];
	for (const service of services) {
		// A user-declared server owns the id for non-bundled services; no duplicate card.
		if (!service.legacyBuiltin && userViews.has(service.serviceId)) continue;
		views.push(catalogServiceView(service, authStorage, connectionStore, userServers?.[service.serviceId]));
	}
	views.push(...userViews.values());
	const rank = (view: McpPluginView): number =>
		view.connectionStatus === "connected"
			? 0
			: view.loginPending
				? 1
				: view.connectionStatus === "pending"
					? 2
					: view.connectable
						? 3
						: view.connectionIds.length > 0
							? 4
							: 5;
	return views.sort(
		(left, right) =>
			rank(left) - rank(right) ||
			left.label.toLowerCase().localeCompare(right.label.toLowerCase()) ||
			left.serviceId.localeCompare(right.serviceId),
	);
}

/** Connection inventory for the mcp.list_connections host request. */
export function buildConnectionViews(
	options: BuildViewsOptions & {
		acpServers?: ReadonlyArray<{ name: string; type: "http" | "stdio" }>;
	},
): McpConnectionView[] {
	const { services, userServers, authStorage, connectionStore, acpServers } = options;
	const views: McpConnectionView[] = [];
	const reservedIds = new Set(services.filter((service) => service.legacyBuiltin).map((service) => service.serviceId));
	const connected = new Set<string>();
	for (const service of services) {
		const ownership = reservedMcpOwnership(service, userServers?.[service.serviceId]);
		const plugin = catalogServiceView(service, authStorage, connectionStore, userServers?.[service.serviceId]);
		if (plugin.connectionIds.length === 0) {
			if (ownership.status !== "canonical")
				views.push({
					connectionId: service.serviceId,
					serviceId: service.serviceId,
					label: service.label,
					status: ownership.status === "disabled" ? "disabled" : "error",
					usesOAuth: plugin.usesOAuth,
					transport: "http",
					source: "catalog",
					setupHint: ownership.setupHint,
				});
			continue;
		}
		// One inventory row per account, each with the SAME centralized,
		// honestly-computed status (credential binding + expiry + record) —
		// never a raw record.status that could claim a stale Connected.
		for (const account of accountStatesFor({ service, authStorage, connectionStore })) {
			connected.add(account.connectionId);
			views.push({
				connectionId: account.connectionId,
				serviceId: service.serviceId,
				label:
					account.connectionId === service.serviceId
						? service.label
						: `${service.label} (${account.connectionId})`,
				status:
					ownership.status === "disabled"
						? "disabled"
						: ownership.status === "conflict"
							? "error"
							: account.status === "setup_required"
								? "not_connected"
								: account.status,
				...(account.loginPending ? { loginPending: true } : {}),
				usesOAuth: plugin.usesOAuth,
				transport: "http",
				source: "catalog",
				...(ownership.setupHint || account.setupHint
					? { setupHint: ownership.setupHint ?? account.setupHint }
					: {}),
			});
		}
	}
	for (const [name, config] of Object.entries(userServers ?? {})) {
		if (reservedIds.has(name)) continue;
		const plugin = userServerView(name, config, authStorage, connectionStore);
		if (plugin.connectionIds.length === 0) continue;
		connected.add(name);
		views.push({
			connectionId: name,
			label: name,
			status: plugin.connectionStatus === "setup_required" ? "not_connected" : plugin.connectionStatus,
			usesOAuth: plugin.usesOAuth,
			transport: config.type,
			...(plugin.loginPending ? { loginPending: true } : {}),
			source: "user",
			...(plugin.setupHint ? { setupHint: plugin.setupHint } : {}),
		});
	}
	for (const server of acpServers ?? []) {
		if (connected.has(server.name)) continue;
		views.push({
			connectionId: server.name,
			label: server.name,
			status: "connected",
			usesOAuth: false,
			transport: server.type,
			source: "acp",
		});
	}
	return views.sort((left, right) => left.connectionId.localeCompare(right.connectionId));
}

export function filterPluginViewsByStatus(views: readonly McpPluginView[], status: string): McpPluginView[] {
	return views.filter((view) => view.connectionStatus === status);
}

export function searchPluginViews(views: readonly McpPluginView[], query: string, limit: number): McpPluginView[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return views.slice(0, limit);
	return views
		.filter((view) =>
			[
				view.serviceId,
				view.label,
				// Catalog metadata aliases and account ids are searchable — the
				// kernel's search_plugins documents both as match surface.
				...(view.aliases ?? []),
				...view.connectionIds,
				...(view.description ? [view.description] : []),
				view.category,
				view.publisher,
				view.docsUrl,
			]
				.filter((field): field is string => typeof field === "string")
				.some((field) => field.toLowerCase().includes(needle)),
		)
		.slice(0, limit);
}

export function decodePluginCursor(cursor: string | null | undefined): number {
	if (cursor === undefined || cursor === null || cursor === "") return 0;
	if (!/^\d+$/.test(cursor)) throw new Error("mcp.list_plugins received an invalid cursor");
	return Number(cursor);
}

export function pagePluginViews(
	views: readonly McpPluginView[],
	cursor: number,
	limit: number,
): { plugins: McpPluginView[]; nextCursor: string | null } {
	const page = views.slice(cursor, cursor + limit);
	const nextCursor = cursor + limit < views.length ? String(cursor + limit) : null;
	return { plugins: page, nextCursor };
}

export interface VerifyMcpConnectionOptions {
	authStorage: AuthStorage;
	connectionStore: McpConnectionStore;
	connectionId: string;
	serviceId: string;
	label: string;
	endpoint: string;
	usesOAuth: boolean;
	bearerTokenEnvVar?: string;
	/** Injectable probe for tests; defaults to the real streamable-HTTP probe. */
	probe?: typeof probeMcpEndpoint;
	timeoutMs?: number;
}

/**
 * Run a real MCP handshake against the connection's endpoint and persist the
 * record. Credential refresh runs through authStorage.getApiKey under its lock.
 * A rejected credential (HTTP 401/403) is an error; transport/network failures
 * stay "pending" — verification unavailable, not a broken grant.
 */
export async function verifyMcpConnection(options: VerifyMcpConnectionOptions): Promise<McpConnectionRecord> {
	const { authStorage, connectionStore, connectionId, serviceId, label, endpoint, usesOAuth, bearerTokenEnvVar } =
		options;
	const probe = options.probe ?? probeMcpEndpoint;
	const previous = connectionStore.get(connectionId);
	const expectedRecord = previous ? { ...previous } : undefined;
	const now = Date.now();
	const record: McpConnectionRecord = {
		connectionId,
		serviceId,
		endpoint,
		label,
		status: "pending",
		createdAt: now,
		updatedAt: now,
	};
	// Login owns this record until finalize/logout/release. Verification never
	// refreshes credentials or probes on behalf of an active attempt.
	if (expectedRecord?.attemptId !== undefined) return { ...expectedRecord, status: "pending" };
	const oauthSource = usesOAuth && !bearerTokenEnvVar;
	const currentSource = (): string => {
		if (bearerTokenEnvVar) return process.env[bearerTokenEnvVar]?.trim() ?? "";
		if (oauthSource) return JSON.stringify(authStorage.getVerified(mcpCredentialKey(connectionId))) ?? "";
		return "";
	};
	let sourceSnapshot: string;
	try {
		sourceSnapshot = currentSource();
	} catch {
		return { ...record, lastError: MCP_PROBE_ERRORS.UNKNOWN };
	}
	const persist = async (): Promise<McpConnectionRecord> => {
		const outcome = connectionStore.queueVerifyResult(record, () => sameGrantToken(sourceSnapshot, currentSource()), {
			expectedRecord,
		});
		try {
			await connectionStore.flush();
			if (await outcome) return record;
		} catch {
			// A failed write is one-shot, not a weaker retry of this result.
		}
		return {
			...record,
			status: "pending",
			verifiedAt: undefined,
			toolCount: undefined,
			lastError: MCP_PROBE_ERRORS.CREDENTIAL_CHANGED,
		};
	};
	try {
		if (oauthSource) {
			const credential = authStorage.getVerified(mcpCredentialKey(connectionId));
			if (credential?.type === "oauth" && credential.endpoint !== endpoint) {
				record.status = "error";
				record.lastError = MCP_PROBE_ERRORS.UNBOUND_CREDENTIAL;
				return await persist();
			}
		}
		const token = await resolveConnectionToken(authStorage, connectionId, oauthSource, bearerTokenEnvVar);
		// getApiKey may refresh. Bind both the probe token and the complete fresh
		// credential identity (including endpoint) before any network operation.
		if (oauthSource) {
			const credential = authStorage.getVerified(mcpCredentialKey(connectionId));
			if (
				token &&
				(credential?.type !== "oauth" ||
					credential.endpoint !== endpoint ||
					!sameGrantToken(token, credential.access))
			) {
				return { ...record, lastError: MCP_PROBE_ERRORS.CREDENTIAL_CHANGED };
			}
			sourceSnapshot = JSON.stringify(credential) ?? "";
		} else if (bearerTokenEnvVar) {
			sourceSnapshot = token;
		}
		if ((oauthSource || bearerTokenEnvVar) && !token) {
			record.lastError = MCP_PROBE_ERRORS.UNKNOWN;
			return await persist();
		}
		const result = await probe({
			url: endpoint,
			getToken: () => token,
			...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
		});
		if (result.ok) {
			record.status = "connected";
			record.verifiedAt = Date.now();
			record.toolCount = result.toolCount;
		} else if (result.error === MCP_PROBE_ERRORS.UNAUTHORIZED) {
			record.status = "error";
			record.lastError = result.error;
		} else {
			record.lastError = result.error;
		}
	} catch {
		record.status = "pending";
		record.lastError = MCP_PROBE_ERRORS.UNKNOWN;
	}
	return persist();
}

/** Resolve the usable token for a connection; empty string when unauthenticated. */
async function resolveConnectionToken(
	authStorage: AuthStorage,
	connectionId: string,
	usesOAuth: boolean,
	bearerTokenEnvVar: string | undefined,
): Promise<string> {
	if (usesOAuth) {
		const token = await authStorage.getApiKey(mcpCredentialKey(connectionId));
		return token ?? "";
	}
	if (bearerTokenEnvVar) return process.env[bearerTokenEnvVar]?.trim() ?? "";
	return "";
}

/**
 * Constant-time equality between the EXACT token a verification probed and the
 * current grant value: rotation, logout, or a second login's replacement makes
 * the comparison false so a stale probe result can never mark the new grant
 * verified. Byte length is checked first (length is not secret material);
 * timingSafeEqual never leaks content, and the raw token never leaves memory.
 */
export function sameGrantToken(probed: string, current: string): boolean {
	const left = Buffer.from(probed, "utf8");
	const right = Buffer.from(current, "utf8");
	return left.length === right.length && timingSafeEqual(left, right);
}
