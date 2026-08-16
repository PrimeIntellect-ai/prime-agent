import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../../config.js";
import { acquireSyncFileLock, errorCode } from "../../utils/sync-file-lock.js";

export const RELIABILITY_MONITOR_SERVICE_LABEL = "ai.primeintellect.prime-agent.reliability-monitor";
const RELIABILITY_MONITOR_SERVICE_INTERVAL_SECONDS = 60;
export const RELIABILITY_MONITOR_SERVICE_STALE_MS = 180_000;
const RELIABILITY_MONITOR_SERVICE_STATE_SCHEMA_VERSION = 1;

const SERVICE_STATE_FILE_NAME = "monitor-service-state.json";
const RUNNER_FILE_NAME = "monitor-runner.sh";
const RUNNER_STDOUT_FILE_NAME = "monitor-service.stdout.log";
const RUNNER_STDERR_FILE_NAME = "monitor-service.stderr.log";
const MODULE_PATH = fileURLToPath(import.meta.url);

const SERVICE_STATE_FIELD_NAMES: Readonly<Record<string, true>> = {
	schemaVersion: true,
	status: true,
	lastStartedAt: true,
	lastCompletedAt: true,
	lastError: true,
	lastExitCode: true,
	lastResult: true,
};

const SERVICE_RESULT_FIELD_NAMES: Readonly<Record<string, true>> = {
	scannedSnapshots: true,
	alertCount: true,
	attemptedNotifications: true,
	pendingNotifications: true,
	settledExtensionRequests: true,
};

export interface ReliabilityMonitorServiceResult {
	scannedSnapshots: number;
	alertCount: number;
	attemptedNotifications: number;
	pendingNotifications: number;
	settledExtensionRequests: number;
}

export interface ReliabilityMonitorServiceState {
	schemaVersion: 1;
	status: "running" | "succeeded" | "failed";
	lastStartedAt: string;
	lastCompletedAt?: string;
	lastError?: string;
	lastExitCode?: number;
	lastResult?: ReliabilityMonitorServiceResult;
}

export type ReliabilityMonitorServiceStatus = "unsupported" | "not_installed" | "healthy" | "stale" | "failed";

export interface ReliabilityMonitorServicePaths {
	launchAgentsDir: string;
	plistPath: string;
	reliabilityDir: string;
	runnerPath: string;
	statePath: string;
	stdoutPath: string;
	stderrPath: string;
}

export interface ReliabilityMonitorServiceStatusResult {
	status: ReliabilityMonitorServiceStatus;
	label: typeof RELIABILITY_MONITOR_SERVICE_LABEL;
	paths: ReliabilityMonitorServicePaths;
	state?: ReliabilityMonitorServiceState;
	reason?: string;
}

export interface ReliabilityMonitorServiceCommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

export interface ReliabilityMonitorServiceDependencies {
	platform?: NodeJS.Platform;
	homeDir?: () => string;
	processExecPath?: string;
	cliEntrypoint?: string;
	now?: () => number;
	runCommand?: (command: string, args: string[]) => ReliabilityMonitorServiceCommandResult;
}

export interface CreateReliabilityMonitorServiceOptions {
	agentDir: string;
	dependencies?: ReliabilityMonitorServiceDependencies;
}

export interface ReliabilityMonitorServiceRunStart {
	previousState?: ReliabilityMonitorServiceState;
	previousStateError?: string;
	state: ReliabilityMonitorServiceState;
}

interface ResolvedReliabilityMonitorServiceDependencies {
	platform: NodeJS.Platform;
	homeDir: () => string;
	processExecPath: string;
	cliEntrypoint: string;
	now: () => number;
	runCommand: (command: string, args: string[]) => ReliabilityMonitorServiceCommandResult;
}

interface StateReadResult {
	state?: ReliabilityMonitorServiceState;
	error?: string;
}

function getReliabilityMonitorServicePaths(
	agentDir: string,
	homeDir: string = homedir(),
): ReliabilityMonitorServicePaths {
	const reliabilityDir = join(agentDir, "reliability");
	const launchAgentsDir = join(homeDir, "Library", "LaunchAgents");
	return {
		launchAgentsDir,
		plistPath: join(launchAgentsDir, `${RELIABILITY_MONITOR_SERVICE_LABEL}.plist`),
		reliabilityDir,
		runnerPath: join(reliabilityDir, RUNNER_FILE_NAME),
		statePath: join(reliabilityDir, SERVICE_STATE_FILE_NAME),
		stdoutPath: join(reliabilityDir, RUNNER_STDOUT_FILE_NAME),
		stderrPath: join(reliabilityDir, RUNNER_STDERR_FILE_NAME),
	};
}

function getReliabilityMonitorServiceStatePath(agentDir: string): string {
	return join(agentDir, "reliability", SERVICE_STATE_FILE_NAME);
}

/**
 * Reads only a complete, schema-valid state document. Callers that need to
 * distinguish an absent state from a corrupt one should use service.status().
 */
export function readReliabilityMonitorServiceState(agentDir: string): ReliabilityMonitorServiceState | undefined {
	return readServiceState(getReliabilityMonitorServiceStatePath(agentDir)).state;
}

/**
 * Starts a monitor cycle while atomically preserving access to the previous
 * state. Consumers can turn a prior failure or stale run into a monitor alert
 * before they complete the new cycle.
 */
export function beginReliabilityMonitorServiceRunInDirectory(
	reliabilityDir: string,
	now: () => number = Date.now,
): ReliabilityMonitorServiceRunStart {
	ensureOwnerOnlyDirectory(reliabilityDir);
	const statePath = join(reliabilityDir, SERVICE_STATE_FILE_NAME);
	return withStateLock(reliabilityDir, () => {
		const { state: previousState, error: previousStateError } = readServiceState(statePath);
		const state: ReliabilityMonitorServiceState = {
			schemaVersion: RELIABILITY_MONITOR_SERVICE_STATE_SCHEMA_VERSION,
			status: "running",
			lastStartedAt: new Date(now()).toISOString(),
		};
		writeOwnerOnlyFileAtomically(statePath, `${JSON.stringify(state)}\n`, 0o600);
		return { previousState, previousStateError, state };
	});
}

export function completeReliabilityMonitorServiceRunInDirectory(
	reliabilityDir: string,
	result: ReliabilityMonitorServiceResult,
	now: () => number = Date.now,
): ReliabilityMonitorServiceState {
	if (!isReliabilityMonitorServiceResult(result)) throw new Error("Invalid reliability monitor service result.");
	const completedAt = new Date(now()).toISOString();
	return updateReliabilityMonitorServiceStateInDirectory(reliabilityDir, (current) => ({
		schemaVersion: RELIABILITY_MONITOR_SERVICE_STATE_SCHEMA_VERSION,
		status: "succeeded",
		lastStartedAt: current?.status === "running" ? current.lastStartedAt : completedAt,
		lastCompletedAt: completedAt,
		lastExitCode: 0,
		lastResult: result,
	}));
}

export function failReliabilityMonitorServiceRunInDirectory(
	reliabilityDir: string,
	error: string,
	options: { exitCode?: number; now?: () => number } = {},
): ReliabilityMonitorServiceState {
	const now = options.now ?? Date.now;
	const message = error.trim() || "reliability monitor failed";
	const completedAt = new Date(now()).toISOString();
	return updateReliabilityMonitorServiceStateInDirectory(reliabilityDir, (current) => ({
		schemaVersion: RELIABILITY_MONITOR_SERVICE_STATE_SCHEMA_VERSION,
		status: "failed",
		lastStartedAt: current?.status === "running" ? current.lastStartedAt : completedAt,
		lastCompletedAt: completedAt,
		lastError: message,
		lastExitCode: options.exitCode,
	}));
}

export function createReliabilityMonitorService(
	options: CreateReliabilityMonitorServiceOptions,
): ReliabilityMonitorService {
	const dependencies = resolveDependencies(options.dependencies);
	const paths = getReliabilityMonitorServicePaths(options.agentDir, dependencies.homeDir());
	return new ReliabilityMonitorService(paths, dependencies);
}

export class ReliabilityMonitorService {
	constructor(
		private readonly paths: ReliabilityMonitorServicePaths,
		private readonly dependencies: ResolvedReliabilityMonitorServiceDependencies,
	) {}

	install(): ReliabilityMonitorServiceStatusResult {
		if (this.dependencies.platform !== "darwin") return this.unsupportedResult();
		this.assertPackagedEntrypoint();
		const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
		// A missing previous service is expected; bootout is deliberately best-effort.
		this.dependencies.runCommand("/bin/launchctl", ["bootout", this.serviceTarget()]);

		ensureOwnerOnlyDirectory(this.paths.launchAgentsDir);
		ensureOwnerOnlyDirectory(this.paths.reliabilityDir);
		writeOwnerOnlyFileAtomically(
			this.paths.runnerPath,
			renderRunner(this.paths, this.dependencies.processExecPath, this.dependencies.cliEntrypoint),
			0o700,
		);
		writeOwnerOnlyFileAtomically(this.paths.plistPath, renderPlist(this.paths), 0o600);

		try {
			this.requireLaunchctlSuccess("bootstrap", ["bootstrap", domain, this.paths.plistPath]);
			this.requireLaunchctlSuccess("print", ["print", this.serviceTarget()]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failReliabilityMonitorServiceRunInDirectory(this.paths.reliabilityDir, message, {
				now: this.dependencies.now,
			});
			throw error;
		}

		return this.result("healthy");
	}

	uninstall(): ReliabilityMonitorServiceStatusResult {
		if (this.dependencies.platform !== "darwin") return this.unsupportedResult();

		const target = this.serviceTarget();
		// bootout fails when the service was never loaded, so confirm it is gone instead of trusting its status.
		this.dependencies.runCommand("/bin/launchctl", ["bootout", target]);
		if (this.dependencies.runCommand("/bin/launchctl", ["print", target]).status === 0) {
			throw new Error("launchctl bootout left the reliability monitor service loaded.");
		}
		removeOwnedFile(this.paths.plistPath);
		removeOwnedFile(this.paths.runnerPath);
		return this.result("not_installed");
	}

	status(): ReliabilityMonitorServiceStatusResult {
		if (this.dependencies.platform !== "darwin") return this.unsupportedResult();

		const plistExists = existsSync(this.paths.plistPath);
		const runnerExists = existsSync(this.paths.runnerPath);
		if (!plistExists && !runnerExists) return this.result("not_installed");
		if (!plistExists || !runnerExists) {
			return this.result("failed", undefined, "The reliability monitor service artifacts are incomplete.");
		}
		if (!hasPrivateFileMode(this.paths.plistPath, 0o600) || !hasPrivateFileMode(this.paths.runnerPath, 0o700)) {
			return this.result("failed", undefined, "The reliability monitor service artifacts are not owner-only.");
		}

		const readResult = readServiceState(this.paths.statePath);
		if (readResult.error) return this.result("failed", undefined, readResult.error);
		if (!readResult.state) {
			return this.result("stale", undefined, "The reliability monitor has not reported a completed cycle.");
		}

		const state = readResult.state;
		if (state.status === "failed") return this.result("failed", state);
		const referenceTime = state.status === "running" ? state.lastStartedAt : state.lastCompletedAt;
		if (!referenceTime) {
			return this.result("failed", state, "The reliability monitor service state has no completion timestamp.");
		}
		const ageMs = this.dependencies.now() - Date.parse(referenceTime);
		if (!Number.isFinite(ageMs) || ageMs < 0) {
			return this.result("failed", state, "The reliability monitor service timestamp is invalid.");
		}
		if (ageMs >= RELIABILITY_MONITOR_SERVICE_STALE_MS) return this.result("stale", state);
		return this.result("healthy", state);
	}

	private unsupportedResult(): ReliabilityMonitorServiceStatusResult {
		return this.result(
			"unsupported",
			undefined,
			"Reliability monitor service installation is supported only on macOS.",
		);
	}

	private serviceTarget(): string {
		return `gui/${typeof process.getuid === "function" ? process.getuid() : 0}/${RELIABILITY_MONITOR_SERVICE_LABEL}`;
	}

	private result(
		status: ReliabilityMonitorServiceStatus,
		state?: ReliabilityMonitorServiceState,
		reason?: string,
	): ReliabilityMonitorServiceStatusResult {
		return { status, label: RELIABILITY_MONITOR_SERVICE_LABEL, paths: this.paths, state, reason };
	}

	private assertPackagedEntrypoint(): void {
		assertStableRuntimePath(this.dependencies.processExecPath, "process executable");
		assertStableEntrypointPath(this.dependencies.cliEntrypoint);
	}

	private requireLaunchctlSuccess(operation: string, args: string[]): void {
		const result = this.dependencies.runCommand("/bin/launchctl", args);
		if (!result.error && result.status === 0) return;
		const detail = result.error?.message ?? (result.stderr.trim() || `exit ${result.status ?? "unknown"}`);
		throw new Error(`launchctl ${operation} failed: ${detail}`);
	}
}

function resolveDependencies(
	dependencies: ReliabilityMonitorServiceDependencies | undefined,
): ResolvedReliabilityMonitorServiceDependencies {
	return {
		platform: dependencies?.platform ?? process.platform,
		homeDir: dependencies?.homeDir ?? homedir,
		processExecPath: dependencies?.processExecPath ?? process.execPath,
		cliEntrypoint: dependencies?.cliEntrypoint ?? defaultCliEntrypoint(),
		now: dependencies?.now ?? Date.now,
		runCommand: dependencies?.runCommand ?? runCommand,
	};
}

function defaultCliEntrypoint(): string {
	if (isSourceOrWorktreePath(MODULE_PATH)) {
		return join(getPackageDir(), "src", "cli.ts");
	}
	return join(getPackageDir(), "dist", "bundle", "cli.js");
}

function runCommand(command: string, args: string[]): ReliabilityMonitorServiceCommandResult {
	const result = spawnSync(command, args, { encoding: "utf8" });
	return {
		status: result.status,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
		error: result.error,
	};
}

function assertStableRuntimePath(path: string, description: string): void {
	if (!isAbsolute(path)) throw new Error(`The ${description} must be an absolute packaged path.`);
	const normalized = normalizePath(path);
	const executableName = basename(normalized).toLowerCase();
	const extension = extname(normalized).toLowerCase();
	if (
		isSourceOrWorktreePath(normalized) ||
		executableName === "tsx" ||
		executableName.startsWith("tsx-") ||
		executableName.includes("ts-node") ||
		[".ts", ".tsx", ".mts", ".cts"].includes(extension)
	) {
		throw new Error(
			"Reliability monitor service installation requires a packaged runtime, not a source or tsx runner.",
		);
	}
}

function assertStableEntrypointPath(path: string): void {
	if (!isAbsolute(path)) throw new Error("The reliability monitor CLI entrypoint must be an absolute packaged path.");
	const normalized = normalizePath(path);
	const extension = extname(normalized).toLowerCase();
	if (
		isSourceOrWorktreePath(normalized) ||
		![".js", ".cjs", ".mjs"].includes(extension) ||
		normalized.includes("/node_modules/tsx/") ||
		normalized.includes("/node_modules/ts-node/") ||
		[".ts", ".tsx", ".mts", ".cts"].includes(extension) ||
		(normalized.includes("/node_modules/") && isWorktreePath(normalized))
	) {
		throw new Error(
			"Reliability monitor service installation requires a packaged CLI entrypoint, not a source or worktree path.",
		);
	}
}

function isSourceOrWorktreePath(path: string): boolean {
	const normalized = normalizePath(path);
	return normalized.includes("/src/") || isWorktreePath(normalized);
}

function isWorktreePath(path: string): boolean {
	return /\/(?:\.git\/worktrees|worktrees?|wt)\//.test(path) || path.includes("/.omp/wt/");
}

function normalizePath(path: string): string {
	return resolve(path).replaceAll("\\", "/");
}

function renderPlist(paths: ReliabilityMonitorServicePaths): string {
	const argumentStrings = [paths.runnerPath]
		.map((argument) => `\t\t<string>${escapeXml(argument)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${RELIABILITY_MONITOR_SERVICE_LABEL}</string>
	<key>Program</key>
	<string>${escapeXml(paths.runnerPath)}</string>
	<key>ProgramArguments</key>
	<array>
${argumentStrings}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StartInterval</key>
	<integer>${RELIABILITY_MONITOR_SERVICE_INTERVAL_SECONDS}</integer>
	<key>StandardOutPath</key>
	<string>${escapeXml(paths.stdoutPath)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(paths.stderrPath)}</string>
</dict>
</plist>
`;
}

function renderRunner(paths: ReliabilityMonitorServicePaths, processExecPath: string, cliEntrypoint: string): string {
	return `#!/bin/sh
set -eu
umask 077

RELIABILITY_DIR=${shellQuote(paths.reliabilityDir)}
STATE_PATH=${shellQuote(paths.statePath)}
STDOUT_PATH=${shellQuote(paths.stdoutPath)}
STDERR_PATH=${shellQuote(paths.stderrPath)}
PROCESS_EXEC_PATH=${shellQuote(processExecPath)}
CLI_ENTRYPOINT=${shellQuote(cliEntrypoint)}

/bin/mkdir -p "$RELIABILITY_DIR"
/bin/chmod 700 "$RELIABILITY_DIR"

write_failure_state() {
	(
		started_at="$1"
		completed_at="$2"
		exit_code="$3"
		# Must match acquireSyncFileLock(reliabilityDir) in withStateLock, or the two state writers do not exclude each other.
		state_lock="\${RELIABILITY_DIR}.lock"
		attempts=0
		until /bin/mkdir "$state_lock" 2>/dev/null; do
			attempts=$((attempts + 1))
			if [ "$attempts" -ge 10 ]; then
				exit 1
			fi
			/bin/sleep 1
		done
		/bin/chmod 700 "$state_lock"
		trap '/bin/rmdir "$state_lock" >/dev/null 2>&1 || true' EXIT
		temporary_state="\${STATE_PATH}.$$.tmp"
		/usr/bin/printf '{"schemaVersion":1,"status":"failed","lastStartedAt":"%s","lastCompletedAt":"%s","lastError":"monitor command exited %s","lastExitCode":%s}\n' \
			"$started_at" "$completed_at" "$exit_code" "$exit_code" >"$temporary_state"
		/bin/chmod 600 "$temporary_state"
		/bin/mv -f "$temporary_state" "$STATE_PATH"
	)
}

started_at=$(/bin/date -u +"%Y-%m-%dT%H:%M:%SZ")
if "$PROCESS_EXEC_PATH" "$CLI_ENTRYPOINT" monitor --json >>"$STDOUT_PATH" 2>>"$STDERR_PATH"; then
	exit 0
else
	exit_code=$?
fi
completed_at=$(/bin/date -u +"%Y-%m-%dT%H:%M:%SZ")
/usr/bin/osascript -e 'display notification "Prime Agent reliability monitor failed to launch." with title "Prime Agent"' >/dev/null 2>&1 || true
# Best-effort: under set -e a contended state lock would otherwise replace the monitor's exit code with 1.
write_failure_state "$started_at" "$completed_at" "$exit_code" || true
exit "$exit_code"
`;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function hasPrivateFileMode(path: string, expectedMode: number): boolean {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === expectedMode;
	} catch {
		return false;
	}
}

function removeOwnedFile(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

function ensureOwnerOnlyDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

function writeOwnerOnlyFileAtomically(path: string, contents: string, mode: number): void {
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, contents, { encoding: "utf8", mode });
		chmodSync(temporaryPath, mode);
		renameSync(temporaryPath, path);
		chmodSync(path, mode);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// Preserve the original write error.
		}
		throw error;
	}
}

function updateReliabilityMonitorServiceStateInDirectory(
	reliabilityDir: string,
	update: (current: ReliabilityMonitorServiceState | undefined) => ReliabilityMonitorServiceState,
): ReliabilityMonitorServiceState {
	ensureOwnerOnlyDirectory(reliabilityDir);
	const statePath = join(reliabilityDir, SERVICE_STATE_FILE_NAME);
	return withStateLock(reliabilityDir, () => {
		const state = update(readServiceState(statePath).state);
		if (!isReliabilityMonitorServiceState(state)) throw new Error("Invalid reliability monitor service state.");
		writeOwnerOnlyFileAtomically(statePath, `${JSON.stringify(state)}\n`, 0o600);
		return state;
	});
}

function withStateLock<T>(reliabilityDir: string, operation: () => T): T {
	const release = acquireSyncFileLock(reliabilityDir, { staleMs: 30_000 });
	try {
		return operation();
	} finally {
		release();
	}
}

function readServiceState(path: string): StateReadResult {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isReliabilityMonitorServiceState(parsed)) {
			return { error: "The reliability monitor service state is invalid." };
		}
		return { state: parsed };
	} catch (error) {
		if (errorCode(error) === "ENOENT") return {};
		return {
			error: `The reliability monitor service state could not be read: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

function isReliabilityMonitorServiceState(value: unknown): value is ReliabilityMonitorServiceState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const state = value as {
		schemaVersion?: unknown;
		status?: unknown;
		lastStartedAt?: unknown;
		lastCompletedAt?: unknown;
		lastError?: unknown;
		lastExitCode?: unknown;
		lastResult?: unknown;
	};
	if (Object.keys(state).some((key) => SERVICE_STATE_FIELD_NAMES[key] !== true)) return false;
	if (state.schemaVersion !== RELIABILITY_MONITOR_SERVICE_STATE_SCHEMA_VERSION) return false;
	if (state.status !== "running" && state.status !== "succeeded" && state.status !== "failed") return false;
	if (
		typeof state.lastStartedAt !== "string" ||
		state.lastStartedAt.length === 0 ||
		!isValidServiceTimestamp(state.lastStartedAt)
	) {
		return false;
	}
	if (
		state.lastCompletedAt !== undefined &&
		(typeof state.lastCompletedAt !== "string" ||
			state.lastCompletedAt.length === 0 ||
			!isValidServiceTimestamp(state.lastCompletedAt))
	) {
		return false;
	}
	if (state.lastError !== undefined && (typeof state.lastError !== "string" || state.lastError.length === 0)) {
		return false;
	}
	if (state.lastExitCode !== undefined && !isNonNegativeInteger(state.lastExitCode)) return false;
	return state.lastResult === undefined || isReliabilityMonitorServiceResult(state.lastResult);
}

function isReliabilityMonitorServiceResult(value: unknown): value is ReliabilityMonitorServiceResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const result = value as {
		scannedSnapshots?: unknown;
		alertCount?: unknown;
		attemptedNotifications?: unknown;
		pendingNotifications?: unknown;
		settledExtensionRequests?: unknown;
	};
	if (Object.keys(result).some((key) => SERVICE_RESULT_FIELD_NAMES[key] !== true)) return false;
	return (
		isNonNegativeInteger(result.scannedSnapshots) &&
		isNonNegativeInteger(result.alertCount) &&
		isNonNegativeInteger(result.attemptedNotifications) &&
		isNonNegativeInteger(result.pendingNotifications) &&
		isNonNegativeInteger(result.settledExtensionRequests)
	);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isValidServiceTimestamp(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}
