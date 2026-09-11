// Service-catalog view builders: the shared projection of catalog services and
// user-declared MCP servers used by the /plugins picker, the mcp.* host requests,
// and the kernel inventory. Pure data assembly over auth.json credentials and
// connection records; no secrets ever leave this module.

import { BUILTIN_MCP_CATALOG } from "@earendil-works/pi-ai/mcp";
import type { AuthStorage } from "../auth-storage.js";
import type { McpServerConfig } from "../settings-manager.js";
import { probeMcpEndpoint } from "./connection-probe.js";
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
	/** False for imported (not yet vetted) catalog entries. */
	catalogVerified: boolean;
	/** True only when a bundled authored skill package ships for this service. */
	bundledSkill: boolean;
}

export type McpServiceCatalogProvider = () => readonly McpServiceDescriptor[];

/**
 * Interim catalog source: the compiled-in built-in integrations. When the merged
 * JSON catalog resolver lands this swaps to it; the descriptor shape already
 * covers the merged entry contract.
 */
export function defaultServiceCatalogProvider(): McpServiceCatalogProvider {
	return () =>
		BUILTIN_MCP_CATALOG.map((entry) => ({
			serviceId: entry.server,
			label: entry.label,
			aliases: [],
			transport: { type: "http" as const, url: entry.url },
			authStrategy: entry.oauth?.kind === "oauth" ? ("oauth" as const) : ("none" as const),
			setup: { status: "ready" as const },
			catalogVerified: true,
			bundledSkill: true,
		}));
}

export function mcpCredentialKey(connectionId: string): string {
	return `mcp:${connectionId}`;
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
	authStorage: AuthStorage;
	connectionStore: McpConnectionStore;
	usesOAuth: boolean;
	bearerTokenEnvVar?: string;
	/** Declared no-auth endpoint: dispatchable without credentials (kernel handshakes). */
	declaredNoAuth?: boolean;
}): HttpStatusResult {
	const { connectionId, authStorage, connectionStore, usesOAuth, bearerTokenEnvVar } = options;
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
						: undefined;
	return {
		serviceId: service.serviceId,
		label: service.label,
		connectionStatus:
			service.setup.status === "requires-setup" || !http || service.authStrategy === "api_key"
				? "setup_required"
				: "not_connected",
		connectable: Boolean(http) && service.setup.status === "ready" && usesOAuth,
		usesOAuth: service.authStrategy === "oauth" || service.authStrategy === "unknown",
		source: "catalog",
		connectionIds: [],
		...(service.description ? { description: service.description } : {}),
		...(service.category ? { category: service.category } : {}),
		...(service.publisher ? { publisher: service.publisher } : {}),
		...(service.docsUrl ? { docsUrl: service.docsUrl } : {}),
		...(setupHint ? { setupHint } : {}),
		...(service.catalogVerified ? {} : { unverified: true }),
	};
}

function catalogServiceView(
	service: McpServiceDescriptor,
	authStorage: AuthStorage,
	connectionStore: McpConnectionStore,
): McpPluginView {
	if (service.transport.type !== "http" || !service.transport.url) {
		return catalogServiceNotConnectedView(service);
	}
	const status = httpConnectionStatus({
		connectionId: service.serviceId,
		authStorage,
		connectionStore,
		usesOAuth: service.authStrategy === "oauth" || service.authStrategy === "unknown",
	});
	if (status.status === "not_connected" && service.authStrategy === "none") {
		return catalogServiceNotConnectedView(service);
	}
	if (status.status === "not_connected" || status.status === "setup_required") {
		const view = catalogServiceNotConnectedView(service);
		// setup.required entries keep their reason; plain not_connected keeps the honest default.
		if (status.status === "not_connected" && service.setup.status === "ready") view.setupHint = status.setupHint;
		return view;
	}
	return {
		serviceId: service.serviceId,
		label: service.label,
		connectionStatus: status.status,
		connectable: false,
		usesOAuth: service.authStrategy === "oauth" || service.authStrategy === "unknown",
		source: "catalog",
		connectionIds: status.status === "error" ? [] : [service.serviceId],
		...(service.description ? { description: service.description } : {}),
		...(service.category ? { category: service.category } : {}),
		...(service.publisher ? { publisher: service.publisher } : {}),
		...(service.docsUrl ? { docsUrl: service.docsUrl } : {}),
		...(status.setupHint ? { setupHint: status.setupHint } : {}),
		...(service.catalogVerified ? {} : { unverified: true }),
		...(status.record?.verifiedAt ? { verifiedAt: status.record.verifiedAt } : {}),
		...(status.record?.toolCount !== undefined ? { toolCount: status.record.toolCount } : {}),
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
		connectable: config.enabled !== false && usesOAuth && status.status === "not_connected",
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
	const bundledIds = new Set(services.filter((service) => service.bundledSkill).map((service) => service.serviceId));
	const userViews = new Map<string, McpPluginView>();
	for (const [name, config] of userEntries) {
		// Dead shadows: a user entry cannot override a bundled catalog service.
		if (bundledIds.has(name)) continue;
		userViews.set(name, userServerView(name, config, authStorage, connectionStore));
	}
	const views: McpPluginView[] = [];
	for (const service of services) {
		// A user-declared server owns the id for non-bundled services; no duplicate card.
		if (!service.bundledSkill && userViews.has(service.serviceId)) continue;
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
	const bundledIds = new Set(services.filter((service) => service.bundledSkill).map((service) => service.serviceId));
	const connected = new Set<string>();
	for (const service of services) {
		if (bundledIds.has(service.serviceId) && userServers?.[service.serviceId] !== undefined) continue;
		const plugin = catalogServiceView(service, authStorage, connectionStore);
		if (plugin.connectionIds.length === 0) continue;
		connected.add(service.serviceId);
		views.push({
			connectionId: service.serviceId,
			serviceId: service.serviceId,
			label: service.label,
			status: plugin.connectionStatus === "setup_required" ? "not_connected" : plugin.connectionStatus,
			usesOAuth: plugin.usesOAuth,
			transport: "http",
			source: "catalog",
			...(plugin.setupHint ? { setupHint: plugin.setupHint } : {}),
		});
	}
	for (const [name, config] of Object.entries(userServers ?? {})) {
		if (bundledIds.has(name)) continue;
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
		const getToken = async (): Promise<string> => {
			if (usesOAuth) {
				const token = await authStorage.getApiKey(mcpCredentialKey(connectionId));
				return token ?? "";
			}
			if (bearerTokenEnvVar) return process.env[bearerTokenEnvVar]?.trim() ?? "";
			return "";
		};
		const result = await probe({
			url: endpoint,
			getToken,
			...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
		});
		if (result.ok) {
			record.status = "connected";
			record.verifiedAt = Date.now();
			record.toolCount = result.toolCount;
		} else if (/\bHTTP 40[13]\b/.test(result.error)) {
			record.status = "error";
			record.lastError = result.error;
		} else {
			record.status = "pending";
			record.lastError = result.error;
		}
	} catch (error) {
		record.status = "pending";
		record.lastError = `verification failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
	}
	connectionStore.upsert(record);
	await connectionStore.flush();
	return record;
}
