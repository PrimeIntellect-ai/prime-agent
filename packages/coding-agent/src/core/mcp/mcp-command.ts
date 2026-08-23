import { getCatalogEntry } from "@earendil-works/pi-ai/mcp";
import type { McpServerConfig, SettingsManager } from "../settings-manager.js";

export type McpManagementAction = "add" | "list" | "get" | "remove";

export interface McpManagementResult {
	action: McpManagementAction;
	message: string;
	changed: boolean;
	serverChange?: {
		name: string;
		transport: McpServerConfig["type"];
		verb: "added" | "replaced" | "removed";
		usesOAuth: boolean;
	};
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface McpCredentialStore {
	/** Disk-verified removal: throws when the credential may still exist on disk. */
	removeVerified(provider: string): void;
}

export async function runMcpManagementCommand(
	args: readonly string[],
	settingsManager: SettingsManager,
	authStorage?: McpCredentialStore,
): Promise<McpManagementResult> {
	const action = args[0];
	if (action === "list") {
		requireCount(args, 1, "mcp list");
		return { action, message: formatMcpServerList(settingsManager.getGlobalMcpServers()), changed: false };
	}
	if (action === "get") {
		requireCount(args, 2, "mcp get <name>");
		const name = validateName(args[1]!);
		const config = settingsManager.getGlobalMcpServers()?.[name];
		if (!config) throw new Error(`MCP server "${name}" was not found.`);
		return { action, message: formatMcpServer(name, config), changed: false };
	}
	if (action === "remove") {
		requireCount(args, 2, "mcp remove <name>");
		const name = validateName(args[1]!);
		const config = settingsManager.getGlobalMcpServers()?.[name];
		if (!config || !settingsManager.removeGlobalMcpServer(name)) {
			throw new Error(`MCP server "${name}" was not found.`);
		}
		await flushGlobalSettings(settingsManager);
		dropServerCredentials(name, authStorage);
		return {
			action,
			message: `Removed MCP server "${name}".`,
			changed: true,
			serverChange: {
				name,
				transport: config.type,
				verb: "removed",
				usesOAuth: config.type === "http" && config.oauth === true,
			},
		};
	}
	if (action === "add") {
		const { name, config, force } = parseMcpAddArgs(args.slice(1));
		const replaced = settingsManager.getGlobalMcpServers()?.[name] !== undefined;
		if (replaced && !force) {
			throw new Error(`MCP server "${name}" already exists. Use --force to replace it.`);
		}
		// Any add may repoint a name an authored skill resolves by (e.g. slack); a stored token must never replay there.
		// Verified drop first: every partial failure lands on re-login, never on old-token-with-new-URL.
		dropServerCredentials(name, authStorage);
		settingsManager.setGlobalMcpServer(name, config, force);
		await flushGlobalSettings(settingsManager);
		return {
			action,
			message: `${replaced ? "Replaced" : "Added"} MCP server "${name}".`,
			changed: true,
			serverChange: {
				name,
				transport: config.type,
				verb: replaced ? "replaced" : "added",
				usesOAuth: config.type === "http" && config.oauth === true,
			},
		};
	}
	throw new Error("Usage: mcp <add|list|get|remove>.");
}

export function parseMcpAddArgs(args: readonly string[]): {
	name: string;
	config: McpServerConfig;
	force: boolean;
} {
	const name = validateName(args[0] ?? "");
	if (getCatalogEntry(name)) {
		throw new Error(`MCP server name "${name}" is reserved for a built-in integration.`);
	}
	const separator = args.indexOf("--");
	const optionArgs = args.slice(1, separator === -1 ? undefined : separator);
	const commandArgs = separator === -1 ? [] : args.slice(separator + 1);
	let url: string | undefined;
	let bearerTokenEnvVar: string | undefined;
	let oauth = false;
	let force = false;
	let cwd: string | undefined;
	const env: Record<string, { env: string }> = Object.create(null);
	const seenOptions = new Set<string>();

	for (let index = 0; index < optionArgs.length; index++) {
		const option = optionArgs[index]!;
		if (option !== "--env" && seenOptions.has(option)) throw new Error(`Duplicate MCP add option: ${option}`);
		seenOptions.add(option);
		if (option === "--oauth" || option === "--force") {
			if (option === "--oauth") oauth = true;
			else force = true;
			continue;
		}
		if (option !== "--url" && option !== "--bearer-token-env-var" && option !== "--cwd" && option !== "--env") {
			throw new Error(`Unknown MCP add option: ${option}`);
		}
		const value = optionArgs[++index];
		if (value === undefined || value === "") throw new Error(`${option} requires a value.`);
		if (option === "--url") url = value;
		else if (option === "--bearer-token-env-var") bearerTokenEnvVar = validateEnvName(value, option);
		else if (option === "--cwd") cwd = value;
		else {
			const equals = value.indexOf("=");
			if (equals <= 0 || equals === value.length - 1) {
				throw new Error("--env must use CHILD=SOURCE, where both sides are environment variable names.");
			}
			const child = validateEnvName(value.slice(0, equals), "--env child");
			const source = validateEnvName(value.slice(equals + 1), "--env source");
			if (env[child]) throw new Error(`Duplicate child environment variable: ${child}`);
			env[child] = { env: source };
		}
	}

	if (separator !== -1) {
		if (url || bearerTokenEnvVar || oauth) throw new Error("Stdio MCP servers cannot use HTTP options.");
		if (commandArgs.length === 0 || !commandArgs[0]?.trim()) {
			throw new Error("A command is required after --.");
		}
		if (commandArgs.some((part) => part.includes("\0"))) throw new Error("MCP command arguments cannot contain NUL.");
		return {
			name,
			force,
			config: {
				type: "stdio",
				command: commandArgs[0]!,
				...(commandArgs.length > 1 ? { args: commandArgs.slice(1) } : {}),
				...(cwd ? { cwd } : {}),
				...(Object.keys(env).length > 0 ? { env } : {}),
			},
		};
	}

	if (cwd || Object.keys(env).length > 0) throw new Error("--cwd and --env require a stdio command after --.");
	if (!url) throw new Error("Use --url <url> for HTTP or -- <command> [args...] for stdio.");
	if (bearerTokenEnvVar && oauth) throw new Error("--oauth and --bearer-token-env-var cannot be combined.");
	return {
		name,
		force,
		config: {
			type: "http",
			url: validateHttpUrl(url),
			...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
			...(oauth ? { oauth: true } : {}),
		},
	};
}

export function formatMcpServerList(servers: Record<string, McpServerConfig> | undefined): string {
	const entries = Object.entries(servers ?? {}).sort(([left], [right]) => left.localeCompare(right));
	if (entries.length === 0) return "No user-configured MCP servers.";
	return entries.map(([name, config]) => formatMcpServerSummary(name, config)).join("\n");
}

export function formatMcpServer(name: string, config: McpServerConfig): string {
	return `${name}: ${config.type}`;
}

function formatMcpServerSummary(name: string, config: McpServerConfig): string {
	return formatMcpServer(name, config);
}

function validateName(name: string): string {
	if (!NAME_PATTERN.test(name)) {
		throw new Error(
			"MCP server names must be 1-64 letters, numbers, underscores, or hyphens and start with a letter or number.",
		);
	}
	return name;
}

function validateEnvName(value: string, option: string): string {
	if (!ENV_NAME_PATTERN.test(value)) throw new Error(`${option} requires an environment variable name.`);
	return value;
}

function validateHttpUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Invalid MCP URL: ${value}`);
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) {
		throw new Error("MCP URL must be an http(s) URL without embedded credentials.");
	}
	return url.toString();
}

async function flushGlobalSettings(settingsManager: SettingsManager): Promise<void> {
	await settingsManager.flush();
	const error = settingsManager.drainErrors("global")[0];
	if (error) throw error.error;
}

function dropServerCredentials(name: string, authStorage: McpCredentialStore | undefined): void {
	// A catalog-named mcp:<name> credential belongs to the authored built-in
	// integration (removing a shadowing settings entry must not disconnect it);
	// the generic runtime never serves catalog names.
	if (getCatalogEntry(name)) return;
	try {
		authStorage?.removeVerified(`mcp:${name}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not remove stored credentials for "${name}": ${message}`);
	}
}

function requireCount(args: readonly string[], count: number, usage: string): void {
	if (args.length !== count) throw new Error(`Usage: ${usage}`);
}
