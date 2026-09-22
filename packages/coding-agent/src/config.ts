import { createHash } from "crypto";
import {
	accessSync,
	appendFileSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join, posix, resolve, sep, win32 } from "path";
import { fileURLToPath } from "url";
import { shouldUseWindowsShell, spawnSyncHidden } from "./utils/child-process.js";
import { normalizeSocketPath } from "./utils/daemon-socket-path.js";
import { getNativeInstallationTarget } from "./utils/native-installation.js";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

export const SELF_UPDATE_INTERACTIVE_CHILD_ENV = "PRIME_AGENT_INTERACTIVE_SELF_UPDATE";
export const SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE = 75;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "homebrew" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

interface SelfUpdateCommandStep {
	command: string;
	args: string[];
	display: string;
}

export interface SelfUpdateCommand extends SelfUpdateCommandStep {
	steps?: SelfUpdateCommandStep[];
}

function makeSelfUpdateCommand(
	installStep: SelfUpdateCommandStep,
	uninstallStep?: SelfUpdateCommandStep,
	options: { uninstallAfterInstall?: boolean } = {},
): SelfUpdateCommand {
	if (!uninstallStep) return installStep;
	if (options.uninstallAfterInstall) {
		return {
			...installStep,
			display: `${installStep.display} && ${uninstallStep.display}`,
			steps: [installStep, uninstallStep],
		};
	}
	return {
		...installStep,
		display: `${uninstallStep.display} && ${installStep.display}`,
		steps: [uninstallStep, installStep],
	};
}

function makeSelfUpdateCommandStep(command: string, args: string[]): SelfUpdateCommandStep {
	return {
		command,
		args,
		display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
	};
}

export function detectInstallMethod(): InstallMethod {
	// Homebrew is checked FIRST, before the compiled-binary branch. Our tap ships the prebuilt
	// binary, so a brew copy is a compiled binary living inside a keg. Detecting it as "bun-binary"
	// would route `prime-agent update` into the self-updater, which would overwrite files Homebrew
	// owns and leave the keg inconsistent with its receipt. A brew copy must always be updated with
	// `brew upgrade`.
	if (isHomebrewInstall()) {
		return "homebrew";
	}
	if (isBunBinary) {
		// A compiled binary can also be delivered by a package manager (the per-platform npm
		// packages install the same executable under node_modules). Those copies belong to the
		// package manager too, not to the self-updater. Classify the RESOLVED executable as well as
		// the invoked path: a `bin` symlink into a package tree must not look like a loose binary.
		return (
			classifyPackageManagerPath(
				`${getPackageDir()}\0${process.execPath || ""}\0${resolveExecutablePath(process.execPath || "")}`,
			) ?? "bun-binary"
		);
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		return "npm";
	}

	return "unknown";
}

/**
 * Which package manager, if any, owns a compiled executable at this path. Only used for the
 * compiled-binary branch; the Node branch keeps its own looser matching for compatibility.
 */
function classifyPackageManagerPath(rawPath: string): InstallMethod | undefined {
	const path = rawPath.toLowerCase().replace(/\\/g, "/");
	if (path.includes("/pnpm/") || path.includes("/.pnpm/")) return "pnpm";
	if (path.includes("/yarn/") || path.includes("/.yarn/")) return "yarn";
	if (path.includes("/install/global/node_modules/")) return "bun";
	if (path.includes("/node_modules/")) return "npm";
	return undefined;
}

/** Homebrew's documented default prefixes (macOS Apple silicon, macOS Intel, Linuxbrew). */
const HOMEBREW_DEFAULT_PREFIXES = ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"];

/**
 * Whether a path sits inside a Homebrew keg: `<prefix>/Cellar/<formula>/<version>/...`. The shape
 * alone is not enough - a user directory named `Cellar` must not make the self-updater refuse to
 * work - so the Cellar has to belong to Homebrew: either it sits under a known prefix (the defaults
 * or `HOMEBREW_PREFIX`/`HOMEBREW_CELLAR` from the environment), or the keg carries the
 * `INSTALL_RECEIPT.json` that `brew` writes into every keg it installs.
 */
export function isHomebrewManagedPath(rawPath: string): boolean {
	const normalized = rawPath.replace(/\\/g, "/");
	const match = /^(.*?)\/cellar\/([^/]+)\/([^/]+)(?:\/|$)/i.exec(normalized);
	if (!match) return false;
	const [, prefix, formula, version] = match;
	if (!formula || !version || formula === "." || formula === "..") return false;
	const cellar = `${prefix}/Cellar`;
	const knownPrefixes = new Set(HOMEBREW_DEFAULT_PREFIXES.map((entry) => entry.toLowerCase()));
	const knownCellars = new Set<string>();
	const envPrefix = process.env.HOMEBREW_PREFIX?.replace(/\\/g, "/").replace(/\/+$/, "");
	const envCellar = process.env.HOMEBREW_CELLAR?.replace(/\\/g, "/").replace(/\/+$/, "");
	if (envPrefix) knownPrefixes.add(envPrefix.toLowerCase());
	if (envCellar) knownCellars.add(envCellar.toLowerCase());
	if (knownPrefixes.has(prefix.toLowerCase()) || knownCellars.has(cellar.toLowerCase())) return true;
	try {
		return statSync(join(cellar, formula, version, "INSTALL_RECEIPT.json")).isFile();
	} catch {
		return false;
	}
}

/**
 * Resolve an executable path through every symlink to the file that actually runs. Install-method
 * decisions (Homebrew, package manager, self-updater) must be made on THIS path, never on the path
 * as invoked: Homebrew and npm both expose a `bin` symlink whose own location says nothing about who
 * owns the target. Returns the input unchanged when it cannot be resolved, so callers still see a
 * non-empty path to match against.
 */
export function resolveExecutablePath(executablePath: string): string {
	if (!executablePath) return executablePath;
	try {
		return realpathSync(executablePath);
	} catch {
		return executablePath;
	}
}

function isHomebrewInstall(): boolean {
	// Homebrew symlinks `<prefix>/bin/prime-agent` at the keg, so the executable as invoked may not
	// look like a keg path until it is resolved. Check both, plus the package dir for npm layouts.
	const candidates = [
		getPackageDir(),
		process.execPath || "",
		resolveExecutablePath(process.execPath || ""),
		__dirname,
	];
	return candidates.some((candidate) => candidate && isHomebrewManagedPath(candidate));
}

function getInferredNpmInstall(): { root: string; prefix: string } | undefined {
	const packageDir = getPackageDir();
	const path = process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
	const parent = path.dirname(packageDir);
	let root: string | undefined;
	if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") {
		root = path.dirname(parent);
	} else if (path.basename(parent) === "node_modules") {
		root = parent;
	}
	if (!root) return undefined;
	const rootParent = path.dirname(root);
	if (path.basename(rootParent) === "lib") return { root, prefix: path.dirname(rootParent) };
	// Windows global npm prefixes use `<prefix>\\node_modules`, which is
	// indistinguishable from local project installs by path shape alone. Do not
	// infer unsupported Windows custom prefixes without `npm root -g` evidence.
	return undefined;
}

function isDirectPackageArtifactSpec(updateSpec: string): boolean {
	const spec = updateSpec.trim().toLowerCase();
	return (
		spec.startsWith("http://") ||
		spec.startsWith("https://") ||
		spec.startsWith("file:") ||
		spec.endsWith(".tgz") ||
		spec.endsWith(".tar.gz")
	);
}

function getDefaultUpdatePackageName(installedPackageName: string, updateSpec: string): string {
	if (isDirectPackageArtifactSpec(updateSpec)) {
		return installedPackageName;
	}
	return updateSpec;
}

function getSelfUpdateCommandForMethod(
	method: InstallMethod,
	installedPackageName: string,
	updateSpec = installedPackageName,
	npmCommand?: string[],
	updatePackageName = getDefaultUpdatePackageName(installedPackageName, updateSpec),
): SelfUpdateCommand | undefined {
	const uninstallAfterInstall = isDirectPackageArtifactSpec(updateSpec);
	switch (method) {
		case "bun-binary":
		case "homebrew":
			return undefined;
		case "pnpm":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("pnpm", ["install", "-g", updateSpec]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("pnpm", ["remove", "-g", installedPackageName]),
				{ uninstallAfterInstall },
			);
		case "yarn":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("yarn", ["global", "add", updateSpec]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]),
				{ uninstallAfterInstall },
			);
		case "bun":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("bun", ["install", "-g", updateSpec]),
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]),
				{ uninstallAfterInstall },
			);
		case "npm": {
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			const inferred = npmCommand?.length ? undefined : getInferredNpmInstall();
			const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
			const installStep = makeSelfUpdateCommandStep(command, [...prefixArgs, "install", "-g", updateSpec]);
			const uninstallStep =
				updatePackageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
			return makeSelfUpdateCommand(installStep, uninstallStep, { uninstallAfterInstall });
		}
		case "unknown":
			return undefined;
	}
}

function readCommandOutput(
	command: string,
	args: string[],
	options: { requireSuccess?: boolean } = {},
): string | undefined {
	const result = spawnSyncHidden(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		shell: shouldUseWindowsShell(command),
	});
	if (result.status === 0) return result.stdout.trim() || undefined;
	if (options.requireSuccess) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
	}
	return undefined;
}

function getGlobalPackageRoots(method: InstallMethod, _packageName: string, npmCommand?: string[]): string[] {
	switch (method) {
		case "npm": {
			const configured = !!npmCommand?.length;
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			if (configured && command === "bun") {
				const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
					requireSuccess: true,
				});
				const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
				if (bunBin) {
					roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
				}
				return roots;
			}
			const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
				requireSuccess: configured,
			});
			const inferred = configured ? undefined : getInferredNpmInstall();
			return [root, inferred?.root].filter((x): x is string => !!x);
		}
		case "pnpm": {
			const root = readCommandOutput("pnpm", ["root", "-g"]);
			return root ? [root, dirname(root)] : [];
		}
		case "yarn": {
			const dir = readCommandOutput("yarn", ["global", "dir"]);
			return dir ? [dir, join(dir, "node_modules")] : [];
		}
		case "bun": {
			const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
			const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
			if (bunBin) {
				roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
			}
			return roots;
		}
		case "bun-binary":
		case "homebrew":
		case "unknown":
			return [];
	}
}

function normalizeExistingPathForComparison(path: string): string | undefined {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		return undefined;
	}
	let normalizedPath: string;
	try {
		normalizedPath = realpathSync(resolvedPath);
	} catch {
		return undefined;
	}
	if (process.platform === "win32") {
		normalizedPath = normalizedPath.toLowerCase();
	}
	return normalizedPath;
}

function isSelfUpdatePathWritable(): boolean {
	const packageDir = getPackageDir();
	try {
		accessSync(packageDir, constants.W_OK);
		accessSync(dirname(packageDir), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function isManagedByGlobalPackageManager(method: InstallMethod, packageName: string, npmCommand?: string[]): boolean {
	const packageDir = normalizeExistingPathForComparison(getPackageDir());
	return (
		!!packageDir &&
		getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
			const normalizedRoot = normalizeExistingPathForComparison(root);
			return (
				!!normalizedRoot &&
				packageDir.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`)
			);
		})
	);
}

export function getSelfUpdateCommand(
	packageName: string,
	npmCommand?: string[],
	updateSpec = packageName,
	updatePackageName = getDefaultUpdatePackageName(packageName, updateSpec),
): SelfUpdateCommand | undefined {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName, updateSpec, npmCommand, updatePackageName);
	if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
		return undefined;
	}
	return command;
}

export function getSelfUpdateUnavailableInstruction(
	packageName: string,
	npmCommand?: string[],
	updateSpec = packageName,
	updatePackageName = getDefaultUpdatePackageName(packageName, updateSpec),
): string {
	const method = detectInstallMethod();
	if (method === "bun-binary") {
		return `Download from: https://github.com/PrimeIntellect-ai/prime-agent/releases/latest`;
	}
	if (method === "homebrew") {
		return `Update with: brew upgrade ${APP_NAME}`;
	}
	const command = getSelfUpdateCommandForMethod(method, packageName, updateSpec, npmCommand, updatePackageName);
	if (command) {
		if (isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable()) {
			return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
		}
		return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
	}
	return `Update ${updateSpec} using the package manager, wrapper, or source checkout that provides this installation.`;
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	// Homebrew outranks the self-updater: never tell a brew user to overwrite their own keg.
	if (method === "homebrew") return `Update with: brew upgrade ${APP_NAME}`;
	if (isBunBinary && getNativeInstallationTarget()) return `Run: ${APP_NAME} update`;
	const command = getSelfUpdateCommandForMethod(method, packageName);
	if (command) {
		return `Run: ${command.display}`;
	}
	return getSelfUpdateUnavailableInstruction(packageName);
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return expandTildePath(envDir);
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	// Node.js: walk up from __dirname until we find package.json
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Fallback (shouldn't happen)
	return __dirname;
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

/**
 * Get the directory containing built-in skills shipped with the package.
 * - For Bun binary: skills/ next to executable
 * - For Node.js (dist/): dist/skills/
 * - For tsx (src/): skills/ at the package root
 */
export function getBundledSkillsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "skills");
	}
	const packageDir = getPackageDir();
	// Source checkouts (tsx) keep built-in skills at the package root; built
	// packages copy them to dist/skills. Decide by whether src/ is present so a
	// stale dist/ from a prior build never shadows live source edits.
	const isSourceCheckout = existsSync(join(packageDir, "src"));
	return isSourceCheckout ? join(packageDir, "skills") : join(packageDir, "dist", "skills");
}

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string;
		configDir?: string;
	};
}

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;

const piConfigName: string | undefined = pkg.piConfig?.name;
const envPrefix =
	(piConfigName || "pi")
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "") || "PI";
export const PACKAGE_NAME: string = pkg.name || "@earendil-works/pi-coding-agent";
export const APP_NAME: string = piConfigName || "pi";
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".prime/agent";
export const VERSION: string = pkg.version || "0.0.0";

// e.g., PI_CODING_AGENT_DIR or PRIME_AGENT_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${envPrefix}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${envPrefix}_SESSION_DIR`;
export const ENV_LEGACY_SESSION_DIR = `${envPrefix}_CODING_AGENT_SESSION_DIR`;

export function expandTildePath(path: string, platform: NodeJS.Platform = process.platform): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || (platform === "win32" && path.startsWith("~\\"))) {
		return (platform === "win32" ? win32 : posix).join(homedir(), path.slice(2));
	}
	return path;
}

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (~/.prime/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.prime/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME);
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Directory where daemon and client diagnostic logs are written (e.g. ~/.prime/agent/logs/). */
export function getLogsDir(): string {
	return join(getAgentDir(), "logs");
}

/** Log file capturing client-side agent-open failures. */
export function getClientErrorLogPath(): string {
	return join(getLogsDir(), "client-errors.log");
}

export function getAgentTracesLogPath(): string {
	return join(getLogsDir(), "agent-traces.log");
}

/** Shared structured (JSON lines) log for client, daemon, and provider diagnostics. */
export function getAgentLogPath(): string {
	return join(getLogsDir(), "agent.jsonl");
}

/**
 * Log file for a daemon. The basename keeps it readable; a hash of the full
 * socket path makes it unique so two sockets that share a basename (e.g.
 * daemon.sock in different dirs) don't interleave into one file.
 */
export function getDaemonLogPath(socketPath: string): string {
	const normalized = normalizeSocketPath(socketPath);
	const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
	return join(getLogsDir(), `${basename(normalized)}.${hash}.log`);
}

export function getDaemonUpdateRestartManifestPath(socketPath: string, agentDir: string = getAgentDir()): string {
	const normalizedSocketPath = normalizeSocketPath(socketPath);
	const socketHash = createHash("sha256").update(normalizedSocketPath).digest("hex");
	return join(agentDir, "daemon-update-restarts", `${socketHash}.json`);
}

export function getLegacyDaemonUpdateRestartManifestPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "daemon-update-restart.json");
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Append a line to a log file, keeping its size bounded with a single-generation
 * rotation. Opens and closes per call (no held fd), so rotation works at runtime
 * — a long-lived writer rotates on the write that crosses the cap, not only at
 * startup. Best-effort: diagnostics must never throw into the caller.
 */
export function appendRotatingLog(logPath: string, message: string, maxBytes: number = MAX_LOG_BYTES): void {
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		try {
			if (existsSync(logPath) && statSync(logPath).size > maxBytes) {
				// Drop any prior .old first: renameSync fails on Windows if it exists.
				rmSync(`${logPath}.old`, { force: true });
				renameSync(logPath, `${logPath}.old`);
			}
		} catch {
			// Keep appending rather than dropping the log on a rotation failure.
		}
		appendFileSync(logPath, `${message}\n`);
	} catch {
		// A read-only or missing log dir must never break the caller.
	}
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to cron jobs store */
export function getCronJobsPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "cron-jobs.json");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to sessions directory */
export function getSessionsDir(agentDir: string = getAgentDir()): string {
	const envDir = getSessionDirEnvOverride();
	if (envDir) {
		return envDir;
	}
	return join(agentDir, "sessions");
}

export function getSessionDirEnvOverride(): string | undefined {
	const envDir = process.env[ENV_SESSION_DIR] ?? process.env[ENV_LEGACY_SESSION_DIR];
	return envDir ? expandTildePath(envDir) : undefined;
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
