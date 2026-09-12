/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import {
	chmodSync,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir, getBinDir, getSessionsDir } from "./config.js";
import { migrateKeybindingsConfig } from "./core/keybindings.js";
import { realpathIfPresentSync, writeFileAtomicSync } from "./utils/atomic-file.js";
import { readFirstLineSync } from "./utils/file-lines.js";

const MIGRATION_GUIDE_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md";

type CredentialRecord = Record<string, unknown>;

function readJsonObjectSync(path: string): CredentialRecord | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return parsed as CredentialRecord;
	} catch {
		return undefined;
	}
}

function containsProviders(auth: CredentialRecord | undefined, providers: Iterable<string>): boolean {
	if (!auth) return false;
	for (const provider of providers) {
		if (!(provider in auth)) return false;
	}
	return true;
}

/** Remove a legacy plaintext credential file; a symlinked file loses both the link and its target. */
function removeCredentialFileSync(path: string): void {
	const target = realpathIfPresentSync(path);
	rmSync(target, { force: true });
	if (target !== path) rmSync(path, { force: true });
}

function restrictCredentialFileSync(path: string): void {
	try {
		chmodSync(realpathIfPresentSync(path), 0o600);
	} catch {
		// Best effort; the warning still tells the user the file is there.
	}
}

function warnLeftoverCredentialFile(path: string, reason: string): void {
	console.error(
		chalk.yellow(
			`Warning: ${path} still holds plaintext credentials (${reason}). It was restricted to 0600; delete it once you have confirmed auth.json is complete.`,
		),
	);
}

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * Providers missing from auth.json are merged in; existing entries are never
 * overwritten. Legacy sources are removed only after auth.json has been
 * durably written and re-read with every legacy provider present.
 *
 * @returns Array of provider names that were added to auth.json
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	let existing: CredentialRecord = {};
	if (existsSync(authPath)) {
		const parsed = readJsonObjectSync(authPath);
		// An unreadable destination must never be replaced; leave every source alone.
		if (!parsed) {
			if (existsSync(oauthPath)) {
				restrictCredentialFileSync(oauthPath);
				warnLeftoverCredentialFile(oauthPath, "auth.json could not be parsed, so nothing was migrated");
			}
			cleanupMigratedOauthBackup(oauthPath, undefined);
			return [];
		}
		existing = parsed;
	}

	const added: CredentialRecord = {};
	const providers: string[] = [];
	const legacyProviders = new Set<string>();

	let oauthReadable = false;
	if (existsSync(oauthPath)) {
		const oauth = readJsonObjectSync(oauthPath);
		if (oauth) {
			oauthReadable = true;
			for (const [provider, cred] of Object.entries(oauth)) {
				legacyProviders.add(provider);
				if (provider in existing) continue;
				added[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
		}
	}

	let settingsWithoutApiKeys: string | undefined;
	let settingsMode: number | undefined;
	if (existsSync(settingsPath)) {
		try {
			settingsMode = statSync(settingsPath).mode & 0o777;
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (typeof key !== "string") continue;
					legacyProviders.add(provider);
					if (provider in existing || provider in added) continue;
					added[provider] = { type: "api_key", key };
					providers.push(provider);
				}
				delete settings.apiKeys;
				settingsWithoutApiKeys = JSON.stringify(settings, null, 2);
			}
		} catch {
			// Skip on error
		}
	}

	// The destination must be durable before any source is destroyed.
	if (providers.length > 0) {
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileAtomicSync(realpathIfPresentSync(authPath), JSON.stringify({ ...existing, ...added }, null, 2), {
			mode: 0o600,
			fsync: true,
			fsyncDir: true,
		});
	}

	// Re-read what actually landed; the sources go only once every legacy provider is there.
	const verified = legacyProviders.size > 0 ? readJsonObjectSync(authPath) : existing;
	const destinationComplete = containsProviders(verified, legacyProviders);

	if (oauthReadable) {
		if (destinationComplete) {
			try {
				removeCredentialFileSync(oauthPath);
			} catch {
				restrictCredentialFileSync(oauthPath);
				warnLeftoverCredentialFile(oauthPath, "could not be deleted");
			}
		} else {
			restrictCredentialFileSync(oauthPath);
			warnLeftoverCredentialFile(oauthPath, "auth.json could not be verified after migration");
		}
	}
	if (settingsWithoutApiKeys !== undefined && destinationComplete) {
		try {
			writeFileAtomicSync(
				realpathIfPresentSync(settingsPath),
				settingsWithoutApiKeys,
				settingsMode === undefined ? {} : { mode: settingsMode },
			);
		} catch {
			// Skip on error
		}
	}

	cleanupMigratedOauthBackup(oauthPath, verified);

	return providers;
}

/**
 * Earlier releases renamed oauth.json to oauth.json.migrated at its original mode.
 * Remove that backup once auth.json holds its providers; otherwise lock it down and warn.
 */
function cleanupMigratedOauthBackup(oauthPath: string, auth: CredentialRecord | undefined): void {
	const backupPath = `${oauthPath}.migrated`;
	if (!existsSync(backupPath)) return;

	const backup = readJsonObjectSync(backupPath);
	if (!backup) {
		restrictCredentialFileSync(backupPath);
		warnLeftoverCredentialFile(backupPath, "it could not be parsed");
		return;
	}
	if (!containsProviders(auth, Object.keys(backup))) {
		restrictCredentialFileSync(backupPath);
		warnLeftoverCredentialFile(backupPath, "auth.json is missing some of its providers");
		return;
	}
	try {
		removeCredentialFileSync(backupPath);
	} catch {
		restrictCredentialFileSync(backupPath);
		warnLeftoverCredentialFile(backupPath, "could not be deleted");
	}
}

/**
 * Migrate sessions from ~/.pi/agent/*.jsonl to the session root.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of
 * ~/.pi/agent/sessions/. This migration moves them to the configured
 * session root.
 *
 * See: https://github.com/earendil-works/pi-mono/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const firstLine = readFirstLineSync(file);
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session") continue;

			const correctDir = getSessionsDir(agentDir);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const newPath = join(correctDir, basename(file));

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

function isSessionJsonlFile(filePath: string): boolean {
	try {
		const firstLine = readFirstLineSync(filePath);
		if (!firstLine?.trim()) {
			return false;
		}
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
		return header.type === "session" && typeof header.id === "string";
	} catch {
		return false;
	}
}

function isLegacySessionDirName(name: string): boolean {
	return /^--.+--$/.test(name);
}

/**
 * Migrate legacy per-cwd session directories into the flat session root.
 *
 * Older versions stored sessions under ~/.prime/agent/sessions/--cwd--/*.jsonl.
 * The daemon list/continue paths now scan the flat session root, so move any
 * existing nested JSONL session files up one level.
 */
export function migrateLegacySessionDirsToSessionRoot(): void {
	const agentDir = getAgentDir();
	const sessionsDir = getSessionsDir(agentDir);

	let entries: Dirent[];
	try {
		entries = readdirSync(sessionsDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || !isLegacySessionDirName(entry.name)) {
			continue;
		}

		const legacyDir = join(sessionsDir, entry.name);
		let files: string[];
		try {
			files = readdirSync(legacyDir).filter((file) => file.endsWith(".jsonl"));
		} catch {
			continue;
		}

		for (const file of files) {
			const oldPath = join(legacyDir, file);
			let newPath = join(sessionsDir, file);
			if (!isSessionJsonlFile(oldPath)) {
				continue;
			}
			if (existsSync(newPath)) {
				if (filesHaveSameContent(oldPath, newPath)) {
					// Already migrated; leave the legacy copy alone.
					continue;
				}
				// A different session shares the basename; move it under a unique name
				// so it stays discoverable by the flat-root list and continue paths.
				newPath = uniqueSessionRootPath(sessionsDir, file);
			}
			try {
				renameSync(oldPath, newPath);
			} catch {
				// Leave the legacy file in place if it cannot be moved.
			}
		}

		try {
			if (readdirSync(legacyDir).length === 0) {
				rmdirSync(legacyDir);
			}
		} catch {
			// Ignore cleanup errors; migrated files are already in the flat root.
		}
	}
}

function filesHaveSameContent(a: string, b: string): boolean {
	try {
		if (statSync(a).size !== statSync(b).size) {
			return false;
		}
		return readFileSync(a, "utf-8") === readFileSync(b, "utf-8");
	} catch {
		return false;
	}
}

function uniqueSessionRootPath(sessionsDir: string, file: string): string {
	const base = file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : file;
	for (let n = 1; ; n++) {
		const candidate = join(sessionsDir, `${base}-${n}.jsonl`);
		if (!existsSync(candidate)) {
			return candidate;
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by pi, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateLegacySessionDirsToSessionRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
