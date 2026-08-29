// Host side of MCP integrations. The protocol itself runs Python-side in the kernel; the host
// only registers OAuth providers, gates integration skills by auth, and serves mcp.* host-requests.

import {
	BUILTIN_MCP_CATALOG,
	createMcpOAuthProvider,
	getCatalogEntry,
	registerBuiltinMcpOAuthProviders,
} from "@earendil-works/pi-ai/mcp";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { AuthStorage } from "../auth-storage.js";
import type { McpServerConfig } from "../settings-manager.js";
import type { AcpMcpServerConfig } from "./acp-mcp-types.js";

export interface McpManagerOptions {
	authStorage: AuthStorage;
	/** Reads the current Settings.mcpServers (name → config). Re-read on refresh(). */
	getUserServers?: () => Record<string, McpServerConfig> | undefined;
	/** Start an interactive host-side login for a server. Provided by the UI mode. */
	beginLogin?: (server: string) => Promise<void>;
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
}

export class McpManager {
	private readonly authStorage: AuthStorage;
	private readonly getUserServers: () => Record<string, McpServerConfig> | undefined;
	private readonly beginLogin?: (server: string) => Promise<void>;
	private integrations = new Map<string, ResolvedIntegration>();
	private acpServers = new Map<string, AcpMcpServerConfig>();
	private acpOwnerId?: string;
	/** Provider ids we registered for user servers, so refresh can drop removed ones. */
	private registeredUserProviderIds = new Set<string>();

	constructor(options: McpManagerOptions) {
		this.authStorage = options.authStorage;
		this.getUserServers = options.getUserServers ?? (() => undefined);
		this.beginLogin = options.beginLogin;
		this.resolveIntegrations();
		this.registerProviders();
	}

	/** Re-read settings and re-register providers; call after a session reload. */
	refresh(): void {
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

	private resolveIntegrations(): void {
		const integrations = new Map<string, ResolvedIntegration>();
		for (const entry of BUILTIN_MCP_CATALOG) {
			integrations.set(entry.server, {
				server: entry.server,
				label: entry.label,
				config: { type: "http", url: entry.url, oauth: true },
				usesOAuth: entry.oauth?.kind === "oauth",
			});
		}
		for (const [server, config] of Object.entries(this.getUserServers() ?? {})) {
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
		registerBuiltinMcpOAuthProviders();
		this.registerUserProviders();
	}

	/**
	 * Register OAuth providers for user-declared (non-catalog) servers. Public so it
	 * can run after ModelRegistry.refresh() resets the registry — otherwise custom
	 * `mcp:<server>` providers vanish on every refresh (e.g. post-login).
	 */
	registerUserProviders(): void {
		const current = new Set<string>();
		for (const integration of this.integrations.values()) {
			if (!integration.userDeclared || integration.config.type !== "http" || getCatalogEntry(integration.server)) {
				continue;
			}
			const id = this.providerId(integration.server);
			if (integration.usesOAuth) {
				current.add(id);
				registerOAuthProvider(
					createMcpOAuthProvider({
						server: integration.server,
						label: integration.label,
						url: integration.config.url,
					}),
				);
			}
		}
		// Drop providers for user servers removed since the last registration.
		for (const id of this.registeredUserProviderIds) {
			if (!current.has(id)) unregisterOAuthProvider(id);
		}
		this.registeredUserProviderIds = current;
	}

	/** True when valid credentials exist for the integration (drives enablement). */
	private isAuthed(integration: ResolvedIntegration): boolean {
		if (integration.config.enabled === false) return false;
		if (integration.userDeclared && getCatalogEntry(integration.server)) return false;
		if (integration.config.type === "stdio") return true;
		const { bearerTokenEnvVar } = integration.config;
		if (!integration.usesOAuth && !bearerTokenEnvVar) return true;
		if (bearerTokenEnvVar && process.env[bearerTokenEnvVar]?.trim()) {
			return true;
		}
		const cred = this.authStorage.get(this.providerId(integration.server));
		if (cred === undefined) return false;
		// Builtin URLs are code-constant; only user-declared endpoints can be retargeted, so only their
		// tokens must prove where they belong. Mismatched or unbound tokens require re-login.
		if (!integration.userDeclared) return true;
		const endpoint = (cred as { endpoint?: string }).endpoint;
		return typeof endpoint === "string" && endpoint === integration.config.url;
	}

	/** `-<server>/SKILL.md` overrides for every built-in integration the user isn't logged into. */
	getDisabledBuiltinSkillOverrides(): string[] {
		const overrides: string[] = [];
		for (const entry of BUILTIN_MCP_CATALOG) {
			const integration = this.integrations.get(entry.server);
			if (integration && !this.isAuthed(integration)) {
				overrides.push(`-${entry.server}/SKILL.md`);
			}
		}
		return overrides;
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
			// Resolved config so the kernel skill connects to the same URL the host
			// registered/authenticated (honors a user's mcpServers `url` override).
			"mcp.config": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.config requires a server");
				const acpServer = this.acpServers.get(server);
				if (acpServer) {
					const { name: _name, ...config } = acpServer;
					return { ...config, credentialSource: "acp" };
				}
				const integration = this.integrations.get(server);
				if (!integration?.userDeclared || getCatalogEntry(server)) return {};
				return { ...integration.config };
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
		return handlers;
	}

	/** Enabled persistent and session-scoped servers available through the generic kernel API. */
	getEnabledGenericServers(): string[] {
		const servers = Array.from(this.integrations.values())
			.filter(
				(integration) =>
					integration.userDeclared &&
					GENERIC_SERVER_NAME_PATTERN.test(integration.server) &&
					!getCatalogEntry(integration.server) &&
					this.isAuthed(integration),
			)
			.map((integration) => integration.server);
		for (const server of this.acpServers.keys()) servers.push(server);
		return [...new Set(servers)].sort((left, right) => left.localeCompare(right));
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
}
