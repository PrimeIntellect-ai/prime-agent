/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { execFileHidden, execHidden, execSyncHidden, spawnSyncHidden } from "../utils/child-process.js";
import { getShellConfig } from "../utils/shell.js";

const commandResultCache = new Map<string, string>();

// Rotation commands change their output between requests; a short TTL plus
// auth-failure invalidation bounds staleness while removing the per-request shell spawn.
const COMMAND_RESULT_TTL_MS = 10_000;

interface CommandTtlEntry {
	value: string;
	expiresAt: number;
}

const commandTtlCache = new Map<string, CommandTtlEntry>();
const commandTtlInFlight = new Map<string, Promise<string | undefined>>();

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (successful results are cached)
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

function executeWithDefaultShellAsync(command: string): Promise<string | undefined> {
	return new Promise((resolvePromise) => {
		execHidden(command, { encoding: "utf-8", timeout: 10000 }, (error, stdout) => {
			resolvePromise(error ? undefined : stdout.trim() || undefined);
		}).stdin?.end();
	});
}

function executeWithConfiguredShellAsync(command: string): Promise<{ executed: boolean; value: string | undefined }> {
	return new Promise((resolvePromise) => {
		let shell: string;
		let shellArgs: string[];
		try {
			({ shell, args: shellArgs } = getShellConfig());
		} catch {
			resolvePromise({ executed: false, value: undefined });
			return;
		}
		execFileHidden(shell, [...shellArgs, command], { encoding: "utf-8", timeout: 10000 }, (error, stdout) => {
			if (error) {
				const code = (error as NodeJS.ErrnoException).code;
				resolvePromise({ executed: code !== "ENOENT", value: undefined });
				return;
			}
			resolvePromise({ executed: true, value: stdout.trim() || undefined });
		}).stdin?.end();
	});
}

async function executeCommandUncachedAsync(commandConfig: string): Promise<string | undefined> {
	const command = commandConfig.slice(1);
	if (process.platform !== "win32") {
		return executeWithDefaultShellAsync(command);
	}
	const configuredResult = await executeWithConfiguredShellAsync(command);
	return configuredResult.executed ? configuredResult.value : executeWithDefaultShellAsync(command);
}

async function resolveCommandConfigValueTtl(commandConfig: string): Promise<string | undefined> {
	const cached = commandTtlCache.get(commandConfig);
	if (cached && Date.now() < cached.expiresAt) {
		return cached.value;
	}
	const inFlight = commandTtlInFlight.get(commandConfig);
	if (inFlight) return inFlight;
	const pending = executeCommandUncachedAsync(commandConfig)
		.then((value) => {
			// Cache only defined results (failures self-heal on the next request) and
			// only while this exec is still the current one: an invalidation during
			// the exec disowned it, so its possibly pre-rotation output is not cached.
			if (value !== undefined && commandTtlInFlight.get(commandConfig) === pending) {
				commandTtlCache.set(commandConfig, { value, expiresAt: Date.now() + COMMAND_RESULT_TTL_MS });
			}
			return value;
		})
		.finally(() => {
			if (commandTtlInFlight.get(commandConfig) === pending) {
				commandTtlInFlight.delete(commandConfig);
			}
		});
	commandTtlInFlight.set(commandConfig, pending);
	return pending;
}

/** Async variant of resolveConfigValue; !command execs share one result per TTL window. */
export function resolveConfigValueAsync(config: string): Promise<string | undefined> {
	if (config.startsWith("!")) {
		return resolveCommandConfigValueTtl(config);
	}
	return Promise.resolve(resolveEnvOrLiteral(config));
}

/** Drop the cached !command result and disown any exec still in flight (its output may predate the rotation). */
export function invalidateCommandTtlCacheEntry(config: string): void {
	if (config.startsWith("!")) {
		commandTtlCache.delete(config);
		commandTtlInFlight.delete(config);
	}
}

function executeCommand(commandConfig: string): string | undefined {
	const cached = commandResultCache.get(commandConfig);
	if (cached !== undefined) {
		return cached;
	}

	// A command that produced no value is not a resolution: a locked keychain, a
	// missing network, or a rotated secret must be retried on the next lookup
	// instead of pinning the failure for the lifetime of the process.
	const result = executeCommandUncached(commandConfig);
	if (result !== undefined) {
		commandResultCache.set(commandConfig, result);
	}
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

export async function resolveConfigValueOrThrowAsync(config: string, description: string): Promise<string> {
	const resolvedValue = await resolveConfigValueAsync(config);
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

export async function resolveHeadersOrThrowAsync(
	headers: Record<string, string> | undefined,
	description: string,
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = await resolveConfigValueOrThrowAsync(value, `${description} header "${key}"`);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}
