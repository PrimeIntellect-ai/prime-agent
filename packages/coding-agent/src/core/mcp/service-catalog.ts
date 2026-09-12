// Service-catalog view builders: the shared projection of catalog services and
// user-declared MCP servers used by the /plugins picker, the mcp.* host requests,
// and the kernel inventory. Pure data assembly over auth.json credentials and
// connection records; no secrets ever leave this module.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalCatalogLoadResult, McpServiceEntry } from "@earendil-works/pi-ai/mcp";
import { loadLocalServiceCatalog, SERVICE_CATALOG } from "@earendil-works/pi-ai/mcp";
import type { AuthStorage } from "../auth-storage.js";
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
			legacyBuiltin: false,
			// Pinned-from-record is its OWN trust state: the source vanished, so
			// the pin reuses user-placed trust semantics for NOTHING — it keeps
			// the installed connection manageable but never one-click connectable.
			pinnedFromRecord: true,
		});
	}
	const descriptors = [...byId.values()];
	if (descriptors.length > MAX_TOTAL_CATALOG_ENTRIES) {
		diagnostics.push(
			`MCP service catalog capped at ${MAX_TOTAL_CATALOG_ENTRIES} entries; ${descriptors.length - MAX_TOTAL_CATALOG_ENTRIES} entries were ignored.`,
		);
		return { descriptors: descriptors.slice(0, MAX_TOTAL_CATALOG_ENTRIES), diagnostics };
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

interface CredentialSnapshot {
	exists: boolean;
	expiresAt?: number;
	hasRefresh: boolean;
	endpoint?: string;
}

function oauthSnapshot(authStorage: AuthStorage, connectionId: string): CredentialSnapshot {
	const credential = authStorage.get(mcpCredentialKey(connectionId));
	if (!credential || credential.type !== "oauth") return { exists: false, hasRefresh: false };
	return {
		exists: true,
		expiresAt: typeof credential.expires === "number" ? credential.expires : undefined,
		hasRefresh: Boolean(credential.refresh),
		endpoint: typeof credential.endpoint === "string" ? credential.endpoint : undefined,
	};
}

function bearerTokenPresent(bearerTokenEnvVar: string | undefined): boolean {
	if (!bearerTokenEnvVar) return false;
	return Boolean(process.env[bearerTokenEnvVar]?.trim());
}

interface HttpStatusResult {
	status: McpConnectionStatus;
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
	if (usesOAuth) {
		const credential = oauthSnapshot(authStorage, connectionId);
		if (!credential.exists) {
			// A record without credentials is a stale connection, not a fresh one.
			if (record) {
				return {
					status: "error",
					setupHint: "Stored credentials are missing. Reconnect required.",
					record,
				};
			}
			return { status: "not_connected" };
		}
		// Endpoint binding: a token must prove where it belongs before it counts as
		// usable — for catalog services and user servers alike. Unbound legacy
		// grants are ambiguous and demand an explicit reconnect.
		if (credential.endpoint === undefined || credential.endpoint !== endpoint) {
			return {
				status: "error",
				setupHint: "Stored credentials are not bound to this endpoint. Reconnect required.",
			};
		}
		if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now() && !credential.hasRefresh) {
			return {
				status: "error",
				setupHint: "Stored credentials expired without a refresh token. Reconnect required.",
			};
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
	const usesOAuth = service.authStrategy === "oauth" || service.authStrategy === "unknown";
	const setupHint =
		service.setup.status === "requires-setup"
			? (service.setup.reason ?? "This service requires manual setup before it can be connected.")
			: service.transport.type !== "http" || !service.transport.url
				? "This service uses a stdio adapter or a tenant URL template. Add it manually with /mcp add."
				: service.authStrategy === "api_key"
					? "This service requires an API key. Add it manually with /mcp add."
					: service.authStrategy === "none"
						? "No login required. Add it manually with /mcp add to use it."
						: service.metadataReviewed || service.localSource === true
							? undefined
							: "Imported entry; its OAuth metadata has not been reviewed. Verify the provider, then add it manually with /mcp add.";
	return {
		serviceId: service.serviceId,
		label: service.label,
		connectionStatus:
			service.setup.status === "requires-setup" || !http || service.authStrategy === "api_key"
				? "setup_required"
				: "not_connected",
		// One-click Connect is an honest claim only for reviewed entries (or files
		// the user placed themselves, which still go through the login dialog's
		// explicit approval). Unreviewed imports stay candidates: verify the
		// provider manually and add it with /mcp add.
		connectable:
			Boolean(http) &&
			service.setup.status === "ready" &&
			usesOAuth &&
			(service.metadataReviewed || service.localSource === true) &&
			// A pinned (vanished-source) service has no reviewed OAuth metadata
			// to connect through — its accounts manage in place, never re-login.
			service.pinnedFromRecord !== true,
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
		...(state.setupHint ? { setupHint: state.setupHint } : {}),
		...(state.record?.toolCount !== undefined ? { toolCount: state.record.toolCount } : {}),
		...(state.record?.verifiedAt ? { verifiedAt: state.record.verifiedAt } : {}),
		...(state.record?.lastError ? { lastError: state.record.lastError } : {}),
	};
}

/** Every account of a service (primary first), each with its computed state. */
export function accountStatesFor(options: {
	service: Pick<McpServiceDescriptor, "serviceId" | "transport">;
	authStorage: AuthStorage;
	connectionStore: McpConnectionStore;
}): McpAccountState[] {
	const url = options.service.transport.type === "http" ? options.service.transport.url : undefined;
	if (!url) return [];
	const accounts: McpAccountState[] = [
		accountStateFor({
			connectionId: options.service.serviceId,
			endpoint: url,
			authStorage: options.authStorage,
			connectionStore: options.connectionStore,
		}),
	];
	for (const record of options.connectionStore.records()) {
		if (record.serviceId !== options.service.serviceId || record.connectionId === options.service.serviceId) {
			continue;
		}
		accounts.push(
			accountStateFor({
				connectionId: record.connectionId,
				endpoint: url,
				authStorage: options.authStorage,
				connectionStore: options.connectionStore,
			}),
		);
	}
	return accounts.filter((account) => account.status !== "not_connected");
}

function catalogServiceView(
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
	const aggregate = anyConnected ? "connected" : anyPending ? "pending" : "error";
	const newestConnected = accounts
		.filter((account) => account.status === "connected")
		.sort((left, right) => (right.verifiedAt ?? 0) - (left.verifiedAt ?? 0))[0];
	const errorHint = accounts.find((account) => account.status === "error")?.setupHint;
	const setupHint = service.pinnedFromRecord
		? "This service's catalog source is unavailable; its connection keeps the pinned definition."
		: errorHint;
	return {
		serviceId: service.serviceId,
		label: service.label,
		connectionStatus: aggregate,
		// Error rows keep the Reconnect action; connected/pending rows manage
		// their accounts through the picker instead of re-logging in.
		connectable: aggregate === "error",
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
			config.enabled !== false && usesOAuth && (status.status === "not_connected" || status.status === "error"),
		usesOAuth,
		source: "user",
		connectionIds:
			config.enabled === false || status.status === "error" || status.status === "not_connected" ? [] : [name],
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
		views.push(catalogServiceView(service, authStorage, connectionStore));
	}
	views.push(...userViews.values());
	return views.sort(
		(left, right) =>
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
		if (reservedIds.has(service.serviceId) && userServers?.[service.serviceId] !== undefined) continue;
		const plugin = catalogServiceView(service, authStorage, connectionStore);
		if (plugin.connectionIds.length === 0) continue;
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
					account.status === "not_connected" || account.status === "setup_required"
						? "not_connected"
						: account.status,
				usesOAuth: plugin.usesOAuth,
				transport: "http",
				source: "catalog",
				...(account.setupHint ? { setupHint: account.setupHint } : {}),
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
	try {
		// Endpoint binding first: a stored token must prove where it belongs before
		// any token fetch or probe. Unbound or cross-endpoint grants are ambiguous
		// legacy state and demand an explicit reconnect — never auto-probe.
		if (usesOAuth) {
			const credential = authStorage.get(mcpCredentialKey(connectionId));
			if (credential?.type === "oauth") {
				const bound = typeof credential.endpoint === "string" ? credential.endpoint : undefined;
				if (bound === undefined || bound !== endpoint) {
					record.status = "error";
					record.lastError = MCP_PROBE_ERRORS.UNBOUND_CREDENTIAL;
					connectionStore.queueVerifyResult(record, () => true);
					await connectionStore.flush().catch(() => undefined);
					return record;
				}
			}
		}
		// Resolve the token once: the probe and the binding check below both refer to
		// exactly this grant revision (getApiKey refreshes under its lock first).
		const token = await resolveConnectionToken(authStorage, connectionId, usesOAuth, bearerTokenEnvVar);
		// An OAuth connection verifies against its own grant: without a usable token
		// there is nothing to verify, and an anonymous probe must not produce a
		// "connected" record.
		if (usesOAuth && !token) {
			record.status = "pending";
			record.lastError = MCP_PROBE_ERRORS.UNKNOWN;
			connectionStore.queueVerifyResult(record, () => true);
			await connectionStore.flush().catch(() => undefined);
			return record;
		}
		const bindingAtProbe = authBindingFor(token);
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
			// The server rejected the credential: a real reconnection state.
			record.status = "error";
			record.lastError = result.error;
		} else {
			// Verification could not complete (network/timeout/protocol): the grant
			// stays intact, so this is pending rather than a broken connection.
			record.status = "pending";
			record.lastError = result.error;
		}
		// Bind the result to the current grant revision: if the credential changed
		// or disappeared while the probe ran (logout, rotation, reconnect), the
		// result is stale and must not mark the connection verified. The same guard
		// is re-evaluated under the store lock at flush time.
		const isStillCurrent = () =>
			authBindingFor(currentCredentialBindingValue(authStorage, connectionId, usesOAuth, bearerTokenEnvVar)) ===
			bindingAtProbe;
		if (!isStillCurrent()) {
			return { ...record, status: "pending", lastError: MCP_PROBE_ERRORS.CREDENTIAL_CHANGED };
		}
		connectionStore.queueVerifyResult(record, isStillCurrent);
		await connectionStore.flush();
		return record;
	} catch {
		record.status = "pending";
		record.lastError = MCP_PROBE_ERRORS.UNKNOWN;
		connectionStore.queueVerifyResult(record, () => true);
		await connectionStore.flush().catch(() => undefined);
		return record;
	}
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
 * The current grant revision as a short stable hash. Reloads the credential
 * source first: the probe-to-flush guard must observe logins, logouts, and token
 * rotations — including ones performed by another process between probe start
 * and flush — so it never re-reads a cached AuthStorage snapshot. The reload is
 * one consistent read under the auth.json backend lock; a login racing the flush
 * itself is resolved by the next verification (documented best-effort, no
 * cross-process atomicity claim).
 */
function currentCredentialBindingValue(
	authStorage: AuthStorage,
	connectionId: string,
	usesOAuth: boolean,
	bearerTokenEnvVar: string | undefined,
): string {
	authStorage.reload();
	if (usesOAuth) {
		const credential = authStorage.get(mcpCredentialKey(connectionId));
		return credential?.type === "oauth" && typeof credential.access === "string" ? credential.access : "";
	}
	if (bearerTokenEnvVar) return process.env[bearerTokenEnvVar]?.trim() ?? "";
	return "";
}

/** Short non-reversible hash binding a verification to one exact grant. */
export function authBindingFor(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
