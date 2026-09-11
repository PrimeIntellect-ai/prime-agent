/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { execFileHidden, execSyncHidden, spawnSyncHidden } from "../utils/child-process.js";
import { getShellConfig } from "../utils/shell.js";

const commandResultCache = new Map<string, string | undefined>();
const pendingCommands = new Map<string, Promise<string | undefined>>();

/** Read the last resolved value without running credential commands on UI paths. */
export function peekConfigValue(config: string): string | undefined {
	return config.startsWith("!") ? commandResultCache.get(config) : resolveEnvOrLiteral(config);
}

export async function resolveConfigValueAsync(
	config: string,
	options: { force?: boolean } = {},
): Promise<string | undefined> {
	if (!config.startsWith("!")) return resolveEnvOrLiteral(config);
	const pending = pendingCommands.get(config);
	if (pending) return pending;
	const cached = commandResultCache.get(config);
	if (!options.force && cached !== undefined) return cached;
	const promise = executeCommandAsync(config.slice(1)).then((value) => {
		// A failed refresh must not reuse an old key or prevent the next request from retrying.
		if (value === undefined) commandResultCache.delete(config);
		else commandResultCache.set(config, value);
		return value;
	});
	pendingCommands.set(config, promise);
	try {
		return await promise;
	} finally {
		if (pendingCommands.get(config) === promise) pendingCommands.delete(config);
	}
}

async function executeCommandAsync(command: string): Promise<string | undefined> {
	const execute = (file: string, args: string[], shell: boolean) =>
		new Promise<{ missing: boolean; value?: string }>((resolve) => {
			const child = execFileHidden(file, args, { shell, encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
				resolve({ missing: error?.code === "ENOENT", value: error ? undefined : stdout.trim() || undefined });
			});
			child.stdin?.end();
		});
	try {
		if (process.platform === "win32") {
			const { shell, args } = getShellConfig();
			const result = await execute(shell, [...args, command], false);
			if (!result.missing) return result.value;
		}
		return (await execute(command, [], true)).value;
	} catch {
		return undefined;
	}
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 */
export function resolveConfigValue(config: string): string | undefined {
	if (config.startsWith("!")) {
		return executeCommand(config);
	}
	return resolveEnvOrLiteral(config);
}

/** Unset env var: fall back to the literal string. Set-but-empty: missing credential, never the var name. */
function resolveEnvOrLiteral(config: string): string | undefined {
	const envValue = process.env[config];
	if (envValue !== undefined) {
		return envValue || undefined;
	}
	return config;
}

function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		const { shell, args } = getShellConfig();
		const result = spawnSyncHidden(shell, [...args, command], {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
			shell: false,
		});

		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				return { executed: false, value: undefined };
			}
			return { executed: true, value: undefined };
		}

		if (result.status !== 0) {
			return { executed: true, value: undefined };
		}

		const value = (result.stdout ?? "").trim();
		return { executed: true, value: value || undefined };
	} catch {
		return { executed: false, value: undefined };
	}
}

function executeWithDefaultShell(command: string): string | undefined {
	try {
		const output = execSyncHidden(command, {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

function executeCommandUncached(commandConfig: string): string | undefined {
	const command = commandConfig.slice(1);
	return process.platform === "win32"
		? (() => {
				const configuredResult = executeWithConfiguredShell(command);
				return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
			})()
		: executeWithDefaultShell(command);
}

function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	const result = executeCommandUncached(commandConfig);
	commandResultCache.set(commandConfig, result);
	return result;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveConfigValueUncached(config: string): string | undefined {
	if (config.startsWith("!")) {
		return executeCommandUncached(config);
	}
	return resolveEnvOrLiteral(config);
}

export function resolveConfigValueOrThrow(config: string, description: string): string {
	const resolvedValue = resolveConfigValueUncached(config);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}

	if (config.startsWith("!")) {
		throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
	}

	throw new Error(`Failed to resolve ${description}`);
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}
