// Host side of MCP integrations. The protocol itself runs Python-side in the kernel; the host
// registers OAuth providers, gates integration skills by auth, verifies connections with a
// real MCP handshake, and serves mcp.* host-requests including the service-catalog inventory.

import { join } from "node:path";
import { createMcpOAuthProvider, registerBuiltinMcpOAuthProviders } from "@earendil-works/pi-ai/mcp";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { getAgentDir } from "../../config.js";
import type { AuthStorage } from "../auth-storage.js";
import type { McpServerConfig } from "../settings-manager.js";
import type { AcpMcpServerConfig } from "./acp-mcp-types.js";
import type { probeMcpEndpoint } from "./connection-probe.js";
import { MCP_PROBE_ERRORS } from "./connection-probe.js";
import { type McpConnectionRecord, McpConnectionStore } from "./connection-store.js";
import {
	buildConnectionViews,
	buildPluginViews,
	decodePluginCursor,
	defaultServiceCatalogProvider,
	filterPluginViewsByStatus,
	type McpPluginView,
	type McpServiceCatalogProvider,
	type McpServiceDescriptor,
	mcpLoginEligibility,
	oauthGrantUsable,
	pagePluginViews,
	reservedMcpOwnership,
	searchPluginViews,
	verifyMcpConnection,
} from "./service-catalog.js";

export interface McpManagerOptions {
	authStorage: AuthStorage;
	/** Reads the current Settings.mcpServers (name → config). Re-read on refresh(). */
	getUserServers?: () => Record<string, McpServerConfig> | undefined;
	/** Start an interactive host-side login for a server. Provided by the UI mode. */
	beginLogin?: (server: string) => Promise<void>;
	/**
	 * Explicit user-approved connect handoff for the mcp.connect host request.
	 * Registered only when provided; never auto-opens a browser.
	 */
	beginConnect?: (serviceId: string) => Promise<boolean>;
	/** Service catalog source; defaults to the merged catalog and declared local sources. */
	getServiceCatalog?: McpServiceCatalogProvider;
	/** Declared local service-catalog sources (settings); re-read on every refresh. */
	getCatalogSources?: () => string[];
	/** Connection record store; defaults to <agentDir>/mcp-connections.json. */
	connectionStore?: McpConnectionStore;
	/** Injectable MCP verification probe (tests). */
	probeConnection?: typeof probeMcpEndpoint;
	/** Disable demand-driven verification probes (tests that assert no network). */
	noBackgroundVerification?: boolean;
}

/** A resolved integration: a catalog/user entry plus its provider id. */
const GENERIC_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface ResolvedIntegration {
	server: string;
	label: string;
	config: McpServerConfig;
	usesOAuth: boolean;
	/** True when this came from Settings.mcpServers (may override a catalog name). */
	userDeclared?: boolean;
	blockedReason?: string;
	/**
	 * Catalog entries only: the descriptor is explicitly public no-auth AND
	 * setup-ready, so credential-free dispatch is honest. api_key and
	 * requires-setup entries fail closed until the user adds the server
	 * manually (the picker already shows them as setup_required).
	 */
	credentialFreeEligible?: boolean;
	/** Parent catalog service id for per-account connections (records keep it). */
	catalogServiceId?: string;
}

const LIST_PLUGINS_DEFAULT_LIMIT = 50;
const LIST_PLUGINS_MAX_LIMIT = 200;
const SEARCH_PLUGINS_DEFAULT_LIMIT = 10;
const SEARCH_PLUGINS_MAX_LIMIT = 50;
const CONNECTION_STATUS_FILTERS = new Set([
	"connected",
	"pending",
	"not_connected",
	"setup_required",
	"disabled",
	"error",
]);

export class McpManager {
	private readonly authStorage: AuthStorage;
	private readonly getUserServers: () => Record<string, McpServerConfig> | undefined;
	private readonly beginLogin?: (server: string) => Promise<void>;
	private readonly beginConnect?: (serviceId: string) => Promise<boolean>;
	private readonly getServiceCatalog: McpServiceCatalogProvider;
	private readonly getCatalogSources: (() => string[]) | undefined;
	private readonly connectionStore: McpConnectionStore;
	private readonly probeConnection: typeof probeMcpEndpoint | undefined;
	private readonly noBackgroundVerification: boolean;
	private integrations = new Map<string, ResolvedIntegration>();
	private services: readonly McpServiceDescriptor[] = [];
	private acpServers = new Map<string, AcpMcpServerConfig>();
	private acpOwnerId?: string;
	/** Provider ids we registered for user servers, so refresh can drop removed ones. */
	private ownedProviderIds = new Set<string>();
	private verificationInFlight = new Set<string>();

	constructor(options: McpManagerOptions) {
		this.authStorage = options.authStorage;
		this.getUserServers = options.getUserServers ?? (() => undefined);
		this.beginLogin = options.beginLogin;
		this.beginConnect = options.beginConnect;
		this.getCatalogSources = options.getCatalogSources;
		this.getServiceCatalog =
			options.getServiceCatalog ??
			defaultServiceCatalogProvider(
				() => this.getCatalogSources?.() ?? [],
				() => this.connectionStore.records(),
			);
		this.connectionStore =
			options.connectionStore ?? McpConnectionStore.open(join(getAgentDir(), "mcp-connections.json"));
		this.probeConnection = options.probeConnection;
		this.noBackgroundVerification = options.noBackgroundVerification ?? false;
		this.refresh();
	}

	/**
	 * Re-read settings/catalog and re-register providers. Verification stays
	 * demand-driven (host-request reads); the store reloads because the
	 * interactive client process persists records the daemon must observe.
	 */
	refresh(): void {
		this.connectionStore.load();
		this.resolveIntegrations();
		this.registerProviders();
	}

	canReleaseAcpServers(ownerId: string): boolean {
		return this.acpOwnerId === undefined || this.acpOwnerId === ownerId;
	}

	replaceAcpServers(servers: readonly AcpMcpServerConfig[], ownerId: string): boolean {
		if (!ownerId) throw new Error("ACP MCP owner id is required");
		if (servers.length === 0 && this.acpOwnerId !== ownerId) return false;
		if (servers.length > 0 && this.acpOwnerId && this.acpOwnerId !== ownerId) {
			throw new Error("ACP MCP configuration is owned by another client");
		}

		const next = new Map<string, AcpMcpServerConfig>();
		for (const server of servers) {
			if (next.has(server.name)) throw new Error(`Duplicate ACP MCP server: ${server.name}`);
			next.set(server.name, server);
		}
		const unchanged =
			next.size === this.acpServers.size &&
			Array.from(next).every(
				([name, config]) => JSON.stringify(this.acpServers.get(name)) === JSON.stringify(config),
			);
		if (unchanged) return false;
		this.acpServers = next;
		this.acpOwnerId = next.size > 0 ? ownerId : undefined;
		return true;
	}

	private providerId(server: string): string {
		return `mcp:${server}`;
	}

	/** Catalog service ids that own their name: user settings cannot shadow them. */
	private isReservedServerName(server: string): boolean {
		return this.services.some((service) => service.legacyBuiltin && service.serviceId === server);
	}

	/** Whether a user-declared server name is owned by the user rather than the catalog. */
	private isUserOwnedName(server: string): boolean {
		return this.getUserServers()?.[server] !== undefined && !this.isReservedServerName(server);
	}

	private resolveIntegrations(): void {
		this.services = this.getServiceCatalog();
		const integrations = new Map<string, ResolvedIntegration>();
		for (const service of this.services) {
			if (service.transport.type !== "http" || !service.transport.url) continue;
			const usesOAuth = service.authStrategy === "oauth" || service.authStrategy === "unknown";
			const eligibility = mcpLoginEligibility({
				connectionId: service.serviceId,
				service,
				record: this.connectionStore.get(service.serviceId),
				credential: this.authStorage.get(this.providerId(service.serviceId)),
			});
			integrations.set(service.serviceId, {
				server: service.serviceId,
				label: service.label,
				config: {
					type: "http",
					url:
						eligibility.repair && this.connectionStore.get(service.serviceId)
							? eligibility.endpoint!
							: service.transport.url,
					...(usesOAuth ? { oauth: true } : {}),
				},
				usesOAuth,
				credentialFreeEligible: service.authStrategy === "none" && service.setup.status === "ready",
			});
		}
		// Per-account connections ("acme-2"): each record of a catalog service is
		// its own dispatchable id with its own credentials, so every existing
		// flow (verify, inventory, mcp.config, demand-driven verification) serves
		// accounts through the same machinery.
		for (const record of this.connectionStore.records()) {
			if (record.connectionId === record.serviceId) continue;
			const service = this.services.find((entry) => entry.serviceId === record.serviceId);
			if (!service || service.transport.type !== "http" || !service.transport.url) continue;
			if (integrations.has(record.connectionId)) continue;
			const eligibility = mcpLoginEligibility({
				connectionId: record.connectionId,
				service,
				record,
				credential: this.authStorage.get(this.providerId(record.connectionId)),
			});
			integrations.set(record.connectionId, {
				server: record.connectionId,
				label: `${service.label} (${record.connectionId})`,
				config: {
					type: "http",
					url: eligibility.repair ? eligibility.endpoint! : service.transport.url,
					oauth: true,
				},
				usesOAuth: true,
				catalogServiceId: service.serviceId,
			});
		}
		for (const [server, config] of Object.entries(this.getUserServers() ?? {})) {
			const service = this.services.find((entry) => entry.serviceId === server && entry.legacyBuiltin);
			if (service) {
				const ownership = reservedMcpOwnership(service, config);
				for (const integration of integrations.values()) {
					if (integration.server !== server && integration.catalogServiceId !== server) continue;
					if (ownership.status !== "canonical") {
						integration.config = { ...integration.config, enabled: false };
						integration.blockedReason = ownership.setupHint;
					} else if (config.type === "http") {
						integration.config = { ...config, ...integration.config };
					}
				}
				continue;
			}
			integrations.set(server, {
				server,
				label: server,
				config,
				usesOAuth: config.type === "http" && config.oauth === true,
				userDeclared: true,
			});
		}
		this.integrations = integrations;
	}

	private registerProviders(): void {
		this.registerAllProviders();
	}

	/**
	 * Atomic, idempotent reconciliation of every OAuth provider this manager owns:
	 * legacy built-ins, eligible catalog services, and user-declared servers.
	 * Desired providers are (re-)registered first; only ids we previously owned
	 * disappear. Safe to run after ModelRegistry.refresh() resets the registry
	 * (the reset hook) and after settings/catalog changes — override removals
	 * restore the catalog provider in one pass, leaving no gaps.
	 */
	registerAllProviders(): void {
		registerBuiltinMcpOAuthProviders();
		const desired = new Map<string, ReturnType<typeof createMcpOAuthProvider>>();
		for (const service of this.services) {
			if (service.legacyBuiltin) continue;
			if (service.transport.type !== "http" || !service.transport.url) continue;
			if (service.setup.status !== "ready") continue;
			if (service.authStrategy !== "oauth" && service.authStrategy !== "unknown") continue;
			if (this.isUserOwnedName(service.serviceId)) continue;
			desired.set(
				this.providerId(service.serviceId),
				createMcpOAuthProvider({
					server: service.serviceId,
					label: service.label,
					url: service.transport.url,
				}),
			);
		}
		for (const integration of this.integrations.values()) {
			if (!integration.userDeclared || integration.config.type !== "http") continue;
			if (this.isReservedServerName(integration.server)) continue;
			if (!integration.usesOAuth) continue;
			desired.set(
				this.providerId(integration.server),
				createMcpOAuthProvider({
					server: integration.server,
					label: integration.label,
					url: integration.config.url,
				}),
			);
		}
		const legacyIds = new Set(
			this.services.filter((service) => service.legacyBuiltin).map((service) => this.providerId(service.serviceId)),
		);
		// Alias connections register their own provider so an "Add account"
		// login targets mcp:<connectionId> and its bound credential.
		for (const record of this.connectionStore.records()) {
			if (record.connectionId === record.serviceId) continue;
			const service = this.services.find((entry) => entry.serviceId === record.serviceId);
			if (!service || service.transport.type !== "http" || !service.transport.url) continue;
			if (this.isUserOwnedName(record.connectionId)) continue;
			desired.set(
				this.providerId(record.connectionId),
				createMcpOAuthProvider({
					server: record.connectionId,
					label: `${service.label} (${record.connectionId})`,
					url: service.transport.url,
				}),
			);
		}
		for (const [id, provider] of desired) {
			if (!legacyIds.has(id)) registerOAuthProvider(provider);
		}
		for (const id of this.ownedProviderIds) {
			if (!desired.has(id) && !legacyIds.has(id)) unregisterOAuthProvider(id);
		}
		this.ownedProviderIds = new Set([...desired.keys(), ...legacyIds]);
	}

	/** True when valid credentials exist for the integration (drives dispatch eligibility). */
	private isAuthed(integration: ResolvedIntegration): boolean {
		if (integration.config.enabled === false) return false;
		// A bundled catalog service owns its name; a shadowing user entry is dead by design
		// so its token can never replay against the official endpoint.
		if (integration.userDeclared && this.isReservedServerName(integration.server)) return false;
		if (integration.config.type === "stdio") return true;
		const { bearerTokenEnvVar } = integration.config;
		if (!integration.userDeclared && !integration.usesOAuth) {
			// Catalog entry without OAuth: credential-free dispatch ONLY for an
			// explicitly public no-auth, setup-ready descriptor. api_key and
			// requires-setup entries fail closed until the user adds the server
			// manually — matching the picker setup_required view. Credential
			// binding is never inferred from setup field ids.
			return integration.credentialFreeEligible === true;
		}
		if (!integration.usesOAuth && !bearerTokenEnvVar) return true;
		if (bearerTokenEnvVar) {
			// The configured env var is the ONLY credential source for this
			// server: when it is unset, a stale OAuth credential stored under the
			// same id must never authorize dispatch.
			return Boolean(process.env[bearerTokenEnvVar]?.trim());
		}
		// ONE shared grant-usability rule (with the picker/account-state
		// resolver): typed oauth, non-empty access, endpoint binding, and no
		// expired-without-refresh state — dispatch eligibility and the picker
		// can never disagree.
		return oauthGrantUsable(this.authStorage.get(this.providerId(integration.server)), integration.config.url).usable;
	}

	/**
	 * Disable stale legacy skill packages from older installations when their
	 * canonical integration is not enabled. Current installations use generic MCP.
	 */
	getDisabledBuiltinSkillOverrides(): string[] {
		const overrides: string[] = [];
		for (const service of this.services) {
			if (!service.legacyBuiltin) continue;
			const integration = this.integrations.get(service.serviceId);
			if (integration && !this.isAuthed(integration)) {
				overrides.push(`-${service.serviceId}/SKILL.md`);
			}
		}
		return overrides;
	}

	/**
	 * Verify a connection with a real MCP handshake and persist the record.
	 * Used after login and for pending/error background re-verification.
	 */
	async verifyConnection(server: string): Promise<McpConnectionRecord> {
		const integration = this.integrations.get(server);
		if (!integration) throw new Error(`Unknown MCP connection: ${server}`);
		if (integration.blockedReason || integration.config.enabled === false) {
			throw new Error(integration.blockedReason ?? "Disabled in settings.");
		}
		if (integration.config.type !== "http") {
			throw new Error(`MCP connection ${server} is not an HTTP endpoint`);
		}
		if (integration.userDeclared && this.isReservedServerName(server)) {
			throw new Error(`MCP connection ${server} is reserved by a built-in service`);
		}
		return verifyMcpConnection({
			authStorage: this.authStorage,
			connectionStore: this.connectionStore,
			connectionId: server,
			// Per-account records keep the parent catalog id as their serviceId.
			serviceId: integration.catalogServiceId ?? server,
			label: integration.label,
			endpoint: integration.config.url,
			usesOAuth: integration.usesOAuth,
			bearerTokenEnvVar: integration.config.type === "http" ? integration.config.bearerTokenEnvVar : undefined,
			...(this.probeConnection ? { probe: this.probeConnection } : {}),
		});
	}

	/**
	 * Background verification for connections that hold credentials but lack a
	 * verified record (or whose last verification failed/retryable-pending).
	 * Bounded by the in-flight set; failures land in the record, not the console.
	 */
	private async verifyPendingConnections(): Promise<void> {
		if (this.noBackgroundVerification) return;
		const candidates: string[] = [];
		for (const integration of this.integrations.values()) {
			if (integration.config.type !== "http") continue;
			if (integration.userDeclared && this.isReservedServerName(integration.server)) continue;
			// Only bound, usable credentials may be probed; unbound or cross-endpoint
			// grants surface as Reconnect and are never auto-probed. The first
			// demand-driven pass records the unusable state once so /plugins shows
			// an honest Reconnect instead of a stale pending.
			if (!this.isAuthed(integration)) {
				if (
					!integration.blockedReason &&
					integration.config.enabled !== false &&
					integration.usesOAuth &&
					!this.connectionStore.get(integration.server)
				) {
					const credential = this.authStorage.getVerified(this.providerId(integration.server));
					if (credential !== undefined) {
						const snapshot = JSON.stringify(credential);
						const now = Date.now();
						void this.connectionStore.queueVerifyResult(
							{
								connectionId: integration.server,
								serviceId: integration.catalogServiceId ?? integration.server,
								endpoint: integration.config.url,
								label: integration.label,
								status: "error",
								createdAt: now,
								updatedAt: now,
								lastError: MCP_PROBE_ERRORS.UNBOUND_CREDENTIAL,
							},
							() =>
								JSON.stringify(this.authStorage.getVerified(this.providerId(integration.server))) === snapshot,
							{ expectedRecord: undefined },
						);
						void this.connectionStore.flush().catch(() => undefined);
					}
				}
				continue;
			}
			if (!integration.usesOAuth && !integration.config.bearerTokenEnvVar) continue;
			if (integration.config.enabled === false) continue;
			const record = this.connectionStore.get(integration.server);
			if (record?.attemptId !== undefined || record?.status === "connected") continue;
			if (this.verificationInFlight.has(integration.server)) continue;
			candidates.push(integration.server);
		}
		await Promise.allSettled(
			candidates.map(async (server) => {
				this.verificationInFlight.add(server);
				try {
					await this.verifyConnection(server);
				} catch {
					// Verification failures are recorded inside verifyConnection;
					// unexpected errors must not crash the host.
				} finally {
					this.verificationInFlight.delete(server);
				}
			}),
		);
	}

	private pluginViews(): McpPluginView[] {
		return buildPluginViews({
			services: this.services,
			userServers: this.getUserServers(),
			authStorage: this.authStorage,
			connectionStore: this.connectionStore,
		});
	}

	/** Current resolved service descriptors (the same resolution the UI uses). */
	getServices(): readonly McpServiceDescriptor[] {
		return this.services;
	}

	/** Host-request handlers exposed to the kernel. */
	hostHandlers(): Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> {
		const handlers: Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
			"mcp.refresh": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.refresh requires a server");
				if (this.acpServers.has(server)) throw new Error(`ACP MCP server ${server} does not use host OAuth`);
				// getApiKey refreshes + rewrites auth.json under lock; Python re-reads.
				// Surface failure (throw) instead of a false success so the kernel can
				// report a refresh error rather than a misleading "not enabled".
				const key = await this.authStorage.getApiKey(this.providerId(server));
				if (!key) throw new Error(`Could not refresh credentials for ${server}`);
				return {};
			},
			// Resolved config so the kernel connects to the same URL the host
			// registered/authenticated. Catalog services join the generic route once
			// the user holds credentials; user-declared servers resolve from settings.
			"mcp.config": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.config requires a server");
				const acpServer = this.acpServers.get(server);
				if (acpServer) {
					const { name: _name, ...config } = acpServer;
					return { ...config, credentialSource: "acp" };
				}
				const integration = this.integrations.get(server);
				if (!integration) return {};
				if (integration.userDeclared) {
					if (this.isReservedServerName(server)) return {};
					return { ...integration.config };
				}
				// Catalog service: serve the definition only with credentials present,
				// so dispatch can authenticate; verification state lives in the record.
				if (!this.isAuthed(integration)) return {};
				return { ...integration.config };
			},
			"mcp.list_plugins": async (payload) => {
				const status = payload.connectionStatus;
				if (status !== undefined && typeof status !== "string") {
					throw new Error("mcp.list_plugins connectionStatus must be a string");
				}
				if (status !== undefined && !CONNECTION_STATUS_FILTERS.has(status)) {
					throw new Error(`mcp.list_plugins received an unknown connectionStatus: ${status}`);
				}
				const limit = boundedLimit(payload.limit, LIST_PLUGINS_DEFAULT_LIMIT, LIST_PLUGINS_MAX_LIMIT, "limit");
				const cursor = decodePluginCursor(typeof payload.cursor === "string" ? payload.cursor : undefined);
				let views = this.pluginViews();
				if (status !== undefined) views = filterPluginViewsByStatus(views, status);
				const page = pagePluginViews(views, cursor, limit);
				// Demand-driven verification: credentialed-but-unverified entries get a
				// background handshake so the next listing reflects real state.
				void this.verifyPendingConnections();
				return { plugins: page.plugins, nextCursor: page.nextCursor };
			},
			"mcp.search_plugins": async (payload) => {
				const query = payload.query;
				if (typeof query !== "string" || !query.trim()) {
					throw new Error("mcp.search_plugins requires a non-empty query");
				}
				const limit = boundedLimit(payload.limit, SEARCH_PLUGINS_DEFAULT_LIMIT, SEARCH_PLUGINS_MAX_LIMIT, "limit");
				const views = searchPluginViews(this.pluginViews(), query, limit);
				void this.verifyPendingConnections();
				return { plugins: views, nextCursor: null };
			},
			"mcp.list_connections": async () => {
				const connections = buildConnectionViews({
					services: this.services,
					userServers: this.getUserServers(),
					authStorage: this.authStorage,
					connectionStore: this.connectionStore,
					acpServers: [...this.acpServers.values()],
				});
				return { connections };
			},
		};
		// Only expose begin_login when an interactive login is actually wired, so the
		// kernel doesn't get a handler whose only behavior is to throw.
		const beginLogin = this.beginLogin;
		if (beginLogin) {
			handlers["mcp.begin_login"] = async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.begin_login requires a server");
				await beginLogin(server);
				return {};
			};
		}
		// mcp.connect is an explicit user-approval handoff; without an approver it
		// stays unregistered and the kernel reports "no handler" honestly.
		const beginConnect = this.beginConnect;
		if (beginConnect) {
			handlers["mcp.connect"] = async (payload) => {
				const serviceId = String(payload.serviceId ?? "");
				if (!serviceId) throw new Error("mcp.connect requires a serviceId");
				const view = this.pluginViews().find((plugin) => plugin.serviceId === serviceId);
				if (!view) throw new Error(`Unknown MCP service: ${serviceId}`);
				// The approver seam may run on pending rows (verify a stored grant) and
				// error rows (re-login), matching the UI's Connect/Reconnect actions.
				if (view.loginPending || (!view.connectable && view.connectionStatus !== "pending")) {
					throw new Error(
						view.setupHint ??
							`${view.label} cannot be connected automatically (status: ${view.connectionStatus}).`,
					);
				}
				const connected = await beginConnect(serviceId);
				if (!connected) return { status: "cancelled" };
				// The approver completed the OAuth flow. "Connected" is an honest
				// claim only after a real handshake over the stored grant verifies.
				const record = await this.verifyConnection(serviceId);
				if (record.status !== "connected") {
					return {
						status: "error",
						message: record.lastError ?? "verification-failed",
						connectionId: serviceId,
					};
				}
				return { status: "connected", connectionId: serviceId, toolCount: record.toolCount };
			};
		}
		return handlers;
	}

	/** Session-scoped servers supplied by the active ACP client. */
	getAcpServers(): AcpMcpServerConfig[] {
		return [...this.acpServers.values()];
	}

	/** Enabled servers available through the generic kernel API (user-declared + connected catalog services). */
	getEnabledPersistentGenericServers(): string[] {
		return Array.from(this.integrations.values())
			.filter((integration) => GENERIC_SERVER_NAME_PATTERN.test(integration.server) && this.isAuthed(integration))
			.map((integration) => integration.server)
			.sort((left, right) => left.localeCompare(right));
	}

	/** Status for the /mcp list command. */
	listStatus(): Array<{ server: string; label: string; enabled: boolean; usesOAuth: boolean }> {
		return Array.from(this.integrations.values()).map((integration) => ({
			server: integration.server,
			label: integration.label,
			enabled: this.isAuthed(integration),
			usesOAuth: integration.usesOAuth,
		}));
	}

	/** Connection records for /mcp logout wiring and tests. */
	getConnectionRecord(connectionId: string): McpConnectionRecord | undefined {
		return this.connectionStore.get(connectionId);
	}

	/** Remove a connection record (used when credentials are removed). */
	async removeConnectionRecord(connectionId: string): Promise<void> {
		this.connectionStore.remove(connectionId);
		await this.connectionStore.flush().catch(() => undefined);
	}
}

function boundedLimit(value: unknown, defaultLimit: number, maxLimit: number, name: string): number {
	if (value === undefined) return defaultLimit;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`mcp host request ${name} must be a positive integer`);
	}
	return Math.min(value, maxLimit);
}
