import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { spawn } from "child_process";
import { readFileSync, rmSync, statSync } from "fs";
import { resolve, sep } from "path";
import { selectConfig } from "./cli/config-selector.js";
import {
	ensureInteractiveDaemonRunning,
	isDaemonSessionSummary,
	isSessionBusy,
	probeRunningDaemonSessions,
	type RunningDaemonProbe,
	shutdownConnectedDaemonAndWait,
} from "./cli/daemon-launch.js";
import { confirmDaemonSessionLoss, type DaemonSessionLossCopy, pluralizeSessions } from "./cli/daemon-stop-confirm.js";
import {
	acquireDaemonUpdateRestartCoordinator,
	buildDaemonUpdateRestartReport,
	DAEMON_UPDATE_RESTART_COORDINATOR_FLAG,
	DAEMON_UPDATE_RESTART_ORIGIN_FLAG,
	DAEMON_UPDATE_RESTART_STATUS_FLAG,
	DaemonUpdateRestartCoordinatorAlreadyRunningError,
	type DaemonUpdateRestartCounts,
	type DaemonUpdateRestartFailure,
	type DaemonUpdateRestartProcessIdentity,
	type DaemonUpdateRestartStatus,
	DaemonUpdateRestartStatusWriter,
	launchDaemonUpdateRestartCoordinator,
	waitForActiveDaemonUpdateRestartCoordinator,
} from "./cli/daemon-update-restart.js";
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	getAgentDir,
	getDaemonUpdateRestartManifestPath,
	getLegacyDaemonUpdateRestartManifestPath,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	SELF_UPDATE_INTERACTIVE_CHILD_ENV,
	SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE,
	type SelfUpdateCommand,
	VERSION,
} from "./config.js";
import type { SessionActionRecoverySnapshot } from "./core/agent-session.js";
import { SESSION_ACTION_RECOVERY_FORMAT_VERSION } from "./core/agent-session.js";
import type { AgentSessionRuntimeMetadata } from "./core/agent-session-runtime.js";
import { type CustomMessage, isSessionSlashCommand } from "./core/messages.js";
import { DefaultPackageManager } from "./core/package-manager.js";
import { SettingsManager } from "./core/settings-manager.js";
import { DaemonClient, type DaemonHello } from "./modes/daemon/daemon-client.js";
import {
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_ID,
	DAEMON_UPDATE_RESTART_FORMAT_VERSION,
	type DaemonUpdateRestartManifest,
	type DaemonUpdateRestartSession,
	isUnknownDaemonCommandError,
} from "./modes/daemon/daemon-protocol.js";
import { defaultDaemonSocketPath } from "./modes/daemon/daemon-socket.js";
import {
	acquireDaemonShutdownAdmission,
	persistDaemonStartupFenceFromOwner,
	waitForDaemonStartupFence,
} from "./modes/daemon/daemon-supervisor-ownership.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
} from "./modes/daemon/daemon-worker-protocol.js";
import { shouldUseWindowsShell } from "./utils/child-process.js";
import { getLatestPiRelease, isNewerPackageVersion } from "./utils/version-check.js";

export type PackageCommand = "install" | "remove" | "update" | "list";

const UPDATE_RESTART_PREDECESSOR_FENCE_TIMEOUT_MS = 60_000;

type UpdateTarget = { type: "all" } | { type: "self" } | { type: "extensions"; source?: string };

export function isSelfUpdateSource(source: string): boolean {
	return source === "self" || source === "pi" || source === APP_NAME;
}

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	updateTarget?: UpdateTarget;
	local: boolean;
	force: boolean;
	help: boolean;
	daemonSocketPath?: string;
	restartCoordinator: boolean;
	restartStatusPath?: string;
	restartOriginActiveSessionId?: string;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} package install <source> [--local]`;
		case "remove":
			return `${APP_NAME} package remove <source> [--local]`;
		case "update":
			return `${APP_NAME} update [--force] or ${APP_NAME} package update [source]`;
		case "list":
			return `${APP_NAME} package list`;
	}
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  --local    Install project-locally (${CONFIG_DIR_NAME}/settings.json)

Examples:
  ${APP_NAME} package install npm:@foo/bar
  ${APP_NAME} package install git:github.com/user/repo
  ${APP_NAME} package install git:git@github.com:user/repo
  ${APP_NAME} package install https://github.com/user/repo
  ${APP_NAME} package install ssh://git@github.com/user/repo
  ${APP_NAME} package install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.

Options:
  --local    Remove from project settings (${CONFIG_DIR_NAME}/settings.json)

Examples:
  ${APP_NAME} package remove npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update ${APP_NAME} or installed packages.

Options:
  --self                  Update ${APP_NAME} only
  --extensions            Update installed packages only
  --extension <source>    Update one package only
  --force                 Reinstall ${APP_NAME} even if the current version is latest
  --daemon-socket <path>  Restart the daemon listening on this exact socket

Commands:
  ${APP_NAME} update                Update ${APP_NAME}
  ${APP_NAME} package update        Update installed packages
  ${APP_NAME} package update <source> Update one package
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.
`);
			return;
	}
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: PackageCommand | undefined;
	if (rawCommand === "uninstall") {
		command = "remove";
	} else if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let local = false;
	let force = false;
	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	let source: string | undefined;
	let selfFlag = false;
	let extensionsFlag = false;
	let extensionFlagSource: string | undefined;
	let daemonSocketPath: string | undefined;
	let restartCoordinator = false;
	let restartStatusPath: string | undefined;
	let restartOriginActiveSessionId: string | undefined;

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--self") {
			if (command === "update") {
				selfFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extensions") {
			if (command === "update") {
				extensionsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--force") {
			if (command === "update") {
				force = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--daemon-socket") {
			if (command !== "update") {
				invalidOption = invalidOption ?? arg;
				continue;
			}
			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (daemonSocketPath) {
				conflictingOptions = conflictingOptions ?? "--daemon-socket can only be provided once";
				index++;
			} else {
				daemonSocketPath = value;
				index++;
			}
			continue;
		}

		if (arg === DAEMON_UPDATE_RESTART_COORDINATOR_FLAG) {
			if (command === "update") {
				restartCoordinator = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === DAEMON_UPDATE_RESTART_STATUS_FLAG || arg === DAEMON_UPDATE_RESTART_ORIGIN_FLAG) {
			if (command !== "update") {
				invalidOption = invalidOption ?? arg;
				continue;
			}
			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
				continue;
			}
			if (arg === DAEMON_UPDATE_RESTART_STATUS_FLAG) {
				restartStatusPath = value;
			} else {
				restartOriginActiveSessionId = value;
			}
			index++;
			continue;
		}

		if (arg === "--extension") {
			if (command !== "update") {
				invalidOption = invalidOption ?? arg;
				continue;
			}

			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (extensionFlagSource) {
				conflictingOptions = conflictingOptions ?? "--extension can only be provided once";
				index++;
			} else {
				extensionFlagSource = value;
				index++;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	let updateTarget: UpdateTarget | undefined;
	if (command === "update") {
		if (extensionFlagSource) {
			if (selfFlag || extensionsFlag) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with --self or --extensions";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with a positional source";
			}
			updateTarget = { type: "extensions", source: extensionFlagSource };
		} else if (source) {
			const sourceIsSelf = isSelfUpdateSource(source);
			if (sourceIsSelf) {
				updateTarget = extensionsFlag ? { type: "all" } : { type: "self" };
			} else {
				if (extensionsFlag || selfFlag) {
					conflictingOptions =
						conflictingOptions ?? "positional update targets cannot be combined with --self or --extensions";
				}
				updateTarget = { type: "extensions", source };
			}
		} else if (selfFlag && extensionsFlag) {
			updateTarget = { type: "all" };
		} else if (selfFlag) {
			updateTarget = { type: "self" };
		} else if (extensionsFlag) {
			updateTarget = { type: "extensions" };
		} else {
			updateTarget = { type: "all" };
		}
	}

	return {
		command,
		source,
		updateTarget,
		local,
		force,
		help,
		daemonSocketPath,
		restartCoordinator,
		restartStatusPath,
		restartOriginActiveSessionId,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

function updateTargetIncludesSelf(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "self";
}

function updateTargetIncludesExtensions(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "extensions";
}

export function resolveUpdateDaemonSocketPath(explicitSocketPath?: string): string {
	return explicitSocketPath ?? process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] ?? defaultDaemonSocketPath();
}

function reportDaemonUpdateRestartStatus(status: DaemonUpdateRestartStatus): void {
	const report = buildDaemonUpdateRestartReport(status);
	for (const message of report.info) {
		console.log(chalk.green(message));
	}
	for (const warning of report.warnings) {
		console.error(chalk.yellow(`Warning: ${warning}`));
	}
}

function printSelfUpdateUnavailable(
	npmCommand?: string[],
	updateSpec = PACKAGE_NAME,
	updatePackageName = updateSpec,
): void {
	console.error(`error: ${APP_NAME} cannot self-update this installation.`);
	console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME, npmCommand, updateSpec, updatePackageName));

	const entrypoint = process.argv[1];
	if (entrypoint) {
		console.error("");
		console.error(`Location of pi executable: ${entrypoint}`);
	}
}

function printSelfUpdateFallback(command: SelfUpdateCommand): void {
	console.error(chalk.dim(`If this keeps failing, run this command yourself: ${command.display}`));
}

interface SelfUpdatePlan {
	installSpec: string;
	packageName: string;
	shouldRun: boolean;
	targetVersion?: string;
}

function setSelfUpdateNoChangeExitCode(): void {
	process.exitCode =
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] === "1" ? SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE : undefined;
}

async function getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	try {
		const latestRelease = await getLatestPiRelease(VERSION);
		const packageName = latestRelease?.packageName ?? PACKAGE_NAME;
		const installSpec = latestRelease?.installSpec ?? packageName;
		const packageRenameRequiresUpdate = !latestRelease?.installSpec && packageName !== PACKAGE_NAME;
		if (
			force ||
			!latestRelease ||
			packageRenameRequiresUpdate ||
			isNewerPackageVersion(latestRelease.version, VERSION)
		) {
			return { installSpec, packageName, shouldRun: true, targetVersion: latestRelease?.version };
		}
	} catch {
		return { installSpec: PACKAGE_NAME, packageName: PACKAGE_NAME, shouldRun: true };
	}

	console.log(chalk.green(`${APP_NAME} is already up to date (v${VERSION})`));
	return { installSpec: PACKAGE_NAME, packageName: PACKAGE_NAME, shouldRun: false };
}

async function runSelfUpdate(command: SelfUpdateCommand): Promise<void> {
	console.log(chalk.dim(`Updating ${APP_NAME} with ${command.display}...`));
	for (const step of command.steps ?? [command]) {
		await new Promise<void>((resolve, reject) => {
			// Windows package managers are commonly .cmd shims. Use the shell so Node can execute them.
			const child = spawn(step.command, step.args, {
				stdio: "inherit",
				shell: shouldUseWindowsShell(step.command),
			});
			child.on("error", (error) => {
				reject(error);
			});
			child.on("close", (code, signal) => {
				if (code === 0) {
					resolve();
				} else if (signal) {
					reject(new Error(`${step.display} terminated by signal ${signal}`));
				} else {
					reject(new Error(`${step.display} exited with code ${code ?? "unknown"}`));
				}
			});
		});
	}
}

const UPDATE_RESTART_CONTINUATION_PROMPT =
	"Prime Agent restarted after an update. Continue the interrupted task from the saved transcript and restored tool/kernel state. Inspect current state before retrying commands when needed.";

const UPDATE_SESSION_LOSS_COPY: DaemonSessionLossCopy = {
	busyDetail(count) {
		const { noun, pronoun } = pluralizeSessions(count);
		return `Prime Agent has ${count} busy ${noun}. After the update installs, it will stop ${pronoun}, restart its background service, and resume interrupted work.`;
	},
	unlistableDetail:
		"Running agents could not be listed. After the update installs, Prime Agent will stop resident agents, restart its background service, and resume interrupted work where possible.",
	question: "Continue?",
	nonTtyHint: "Re-run with --force to proceed.",
};

// Returns false when the update should be aborted to avoid terminating live sessions.
function confirmDaemonSessionLossBeforeUpdate(probe: RunningDaemonProbe, force: boolean): Promise<boolean> {
	return confirmDaemonSessionLoss(probe, { force, copy: UPDATE_SESSION_LOSS_COPY });
}

function daemonProbeMayHaveBusySessions(probe: RunningDaemonProbe): boolean {
	return (
		probe.reachable &&
		(probe.activeSessions === undefined ||
			(probe.busyClientOwnedSessionCount ?? 0) > 0 ||
			probe.activeSessions.some(isSessionBusy))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringEnum(value: unknown, allowed: readonly string[]): boolean {
	return typeof value === "string" && allowed.includes(value);
}

function readString(value: unknown, fieldName: string): string {
	if (typeof value !== "string") {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value;
}

function readOptionalString(value: unknown, fieldName: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value;
}

function readBoolean(value: unknown, fieldName: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value;
}

function readNumber(value: unknown, fieldName: string): number {
	if (typeof value !== "number") {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value;
}

function readOptionalStringRecord(value: unknown, fieldName: string): Record<string, string> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value) || !Object.values(value).every((entry): entry is string => typeof entry === "string")) {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value as Record<string, string>;
}

function isMessageContentBlock(value: unknown): value is TextContent | ImageContent {
	return (
		isRecord(value) &&
		((value.type === "text" && typeof value.text === "string") ||
			(value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"))
	);
}

function isImageContent(value: unknown): value is ImageContent {
	return isMessageContentBlock(value) && value.type === "image";
}

function isCustomMessage(value: unknown): value is CustomMessage {
	return (
		isRecord(value) &&
		value.role === "custom" &&
		typeof value.customType === "string" &&
		(typeof value.content === "string" ||
			(Array.isArray(value.content) && value.content.every(isMessageContentBlock))) &&
		typeof value.display === "boolean" &&
		typeof value.timestamp === "number"
	);
}

function isUserMessage(value: unknown): value is UserMessage {
	return (
		isRecord(value) &&
		value.role === "user" &&
		(typeof value.content === "string" ||
			(Array.isArray(value.content) && value.content.every(isMessageContentBlock))) &&
		typeof value.timestamp === "number"
	);
}

function isQueuedAgentMessage(value: unknown): value is UserMessage | CustomMessage {
	return isUserMessage(value) || isCustomMessage(value);
}

function readCustomMessages(value: unknown, fieldName: string): CustomMessage[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every(isCustomMessage)) {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value;
}

function isSessionActionRecoveryAction(value: unknown): value is SessionActionRecoverySnapshot["actions"][number] {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.source !== "string" ||
		(value.delivery !== "next_turn_boundary" && value.delivery !== "when_run_idle") ||
		(value.wake !== "immediate" && value.wake !== "on_lower_boundary" && value.wake !== "external_resume") ||
		!isRecord(value.payload) ||
		typeof value.payload.text !== "string" ||
		(value.payload.images !== undefined &&
			(!Array.isArray(value.payload.images) || !value.payload.images.every(isImageContent)))
	) {
		return false;
	}
	if (value.payload.kind === "session_command") return isSessionSlashCommand(value.payload.command);
	return (
		value.payload.kind === "turn" &&
		Array.isArray(value.payload.records) &&
		value.payload.records.filter((record) => isRecord(record) && record.role === "primary").length === 1 &&
		value.payload.records.every(
			(record) =>
				isRecord(record) &&
				typeof record.id === "string" &&
				(record.role === "primary" || record.role === "prefix" || record.role === "next_turn") &&
				record.ownerActionId === value.id &&
				isQueuedAgentMessage(record.message),
		) &&
		(value.payload.content === undefined ||
			(Array.isArray(value.payload.content) && value.payload.content.every(isMessageContentBlock))) &&
		(value.payload.customMessage === undefined || isCustomMessage(value.payload.customMessage)) &&
		isRecord(value.payload.executionPolicy) &&
		isRecord(value.payload.executionPolicy.preparation) &&
		isStringEnum(value.payload.executionPolicy.preparation.initialRefineBarrier, ["always", "ifInFlight", "skip"]) &&
		typeof value.payload.executionPolicy.preparation.flushPendingBashBeforeValidation === "boolean" &&
		typeof value.payload.executionPolicy.preparation.validateModelAndAuth === "boolean" &&
		typeof value.payload.executionPolicy.preparation.awaitPendingModelSelection === "boolean" &&
		isStringEnum(value.payload.executionPolicy.preparation.preTurnCompaction, [
			"beforeModelSelection",
			"afterModelSelection",
			"skip",
		]) &&
		isStringEnum(value.payload.executionPolicy.preparation.finalRefineBarrier, ["always", "ifInFlight", "skip"]) &&
		typeof value.payload.executionPolicy.runBeforeAgentStart === "boolean" &&
		isStringEnum(value.payload.executionPolicy.nextTurnContextTiming, ["preparation", "commit", "skip"]) &&
		typeof value.payload.executionPolicy.preserveEmptyExtensionPrompt === "boolean" &&
		typeof value.payload.executionPolicy.completionIncludesRetryChain === "boolean" &&
		typeof value.payload.queueVisible === "boolean" &&
		typeof value.payload.acceptedAgentMessage === "boolean" &&
		typeof value.payload.acceptedBeforeCompletion === "boolean"
	);
}

function parseSessionActionRecoverySnapshot(value: unknown): SessionActionRecoverySnapshot {
	if (!isRecord(value)) throw new Error("Daemon update restart response contains invalid session actions");
	if (value.formatVersion !== SESSION_ACTION_RECOVERY_FORMAT_VERSION) {
		throw new Error(`Unsupported session action recovery format version: ${String(value.formatVersion)}`);
	}
	if (!Array.isArray(value.actions) || !value.actions.every(isSessionActionRecoveryAction)) {
		throw new Error("Daemon update restart response is missing session actions");
	}
	return {
		formatVersion: SESSION_ACTION_RECOVERY_FORMAT_VERSION,
		actions: value.actions,
	};
}

function parseDaemonUpdateRestartRuntimeMetadata(value: unknown): AgentSessionRuntimeMetadata | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error("Daemon update restart response contains invalid runtime metadata");
	}
	const kind = readString(value.kind, "runtimeMetadata.kind");
	if (kind !== "top-level" && kind !== "subagent") {
		throw new Error("Daemon update restart response contains invalid runtime metadata kind");
	}
	const parentActiveSessionId = readOptionalString(
		value.parentActiveSessionId,
		"runtimeMetadata.parentActiveSessionId",
	);
	const parentSessionId = readOptionalString(value.parentSessionId, "runtimeMetadata.parentSessionId");
	const parentSessionFile = readOptionalString(value.parentSessionFile, "runtimeMetadata.parentSessionFile");
	const rlmChildId = readOptionalString(value.rlmChildId, "runtimeMetadata.rlmChildId");
	const rlmParentNodeId = readOptionalString(value.rlmParentNodeId, "runtimeMetadata.rlmParentNodeId");
	const prompt = readOptionalString(value.prompt, "runtimeMetadata.prompt");
	const spawnCode = readOptionalString(value.spawnCode, "runtimeMetadata.spawnCode");
	const sessionDir = readOptionalString(value.sessionDir, "runtimeMetadata.sessionDir");
	return {
		kind,
		createdAt: readNumber(value.createdAt, "runtimeMetadata.createdAt"),
		...(parentActiveSessionId ? { parentActiveSessionId } : {}),
		...(parentSessionId ? { parentSessionId } : {}),
		...(parentSessionFile ? { parentSessionFile } : {}),
		...(rlmChildId ? { rlmChildId } : {}),
		...(rlmParentNodeId ? { rlmParentNodeId } : {}),
		...(prompt ? { prompt } : {}),
		...(spawnCode ? { spawnCode } : {}),
		...(sessionDir ? { sessionDir } : {}),
	};
}

function parseDaemonUpdateRestartSession(value: unknown): DaemonUpdateRestartSession {
	if (!isRecord(value)) {
		throw new Error("Daemon update restart response contains an invalid session");
	}
	const queue = value.queue;
	if (!isRecord(queue)) {
		throw new Error("Daemon update restart response contains an invalid queue");
	}
	const config = value.config;
	if (!isRecord(config)) {
		throw new Error("Daemon update restart response contains an invalid session config");
	}
	const clientEnv = readOptionalStringRecord(value.clientEnv, "clientEnv");
	const runtimeMetadata = parseDaemonUpdateRestartRuntimeMetadata(value.runtimeMetadata);
	return {
		activeSessionId: readString(value.activeSessionId, "activeSessionId"),
		sessionId: readString(value.sessionId, "sessionId"),
		sessionFile: readString(value.sessionFile, "sessionFile"),
		cwd: readString(value.cwd, "cwd"),
		config: config as DaemonUpdateRestartSession["config"],
		...(runtimeMetadata ? { runtimeMetadata } : {}),
		...(clientEnv ? { clientEnv } : {}),
		queue: {
			actions: parseSessionActionRecoverySnapshot(queue.actions),
			nextTurn: readCustomMessages(queue.nextTurn, "queue.nextTurn"),
		},
		shouldResume: readBoolean(value.shouldResume, "shouldResume"),
		wasStreaming: readBoolean(value.wasStreaming, "wasStreaming"),
		wasCompacting: readBoolean(value.wasCompacting, "wasCompacting"),
		wasBashRunning: readBoolean(value.wasBashRunning, "wasBashRunning"),
		hadRunningRlmChildren: readBoolean(value.hadRunningRlmChildren, "hadRunningRlmChildren"),
		wasRetrying: readBoolean(value.wasRetrying, "wasRetrying"),
		hadAcceptedPromptInFlight: readBoolean(value.hadAcceptedPromptInFlight, "hadAcceptedPromptInFlight"),
	};
}

function parseDaemonUpdateRestartManifest(value: unknown): DaemonUpdateRestartManifest {
	if (!isRecord(value)) {
		throw new Error("Daemon update restart response is invalid");
	}
	if (value.formatVersion !== DAEMON_UPDATE_RESTART_FORMAT_VERSION) {
		throw new Error(`Unsupported daemon update restart format version: ${String(value.formatVersion)}`);
	}
	const sessions = value.sessions;
	if (!Array.isArray(sessions)) {
		throw new Error("Daemon update restart response is missing sessions");
	}
	return {
		formatVersion: DAEMON_UPDATE_RESTART_FORMAT_VERSION,
		createdAt: readString(value.createdAt, "createdAt"),
		sessions: sessions.map(parseDaemonUpdateRestartSession),
	};
}

function clearPreparedDaemonUpdateRestartManifest(socketPath: string, agentDir: string): void {
	for (const manifestPath of [
		getDaemonUpdateRestartManifestPath(socketPath, agentDir),
		getLegacyDaemonUpdateRestartManifestPath(agentDir),
	]) {
		try {
			rmSync(manifestPath, { force: true });
		} catch {
			// Best effort only; the mtime guard below prevents stale fallback use.
		}
	}
}

function readPreparedDaemonUpdateRestartManifest(
	socketPath: string,
	agentDir: string,
	notBeforeMs?: number,
): DaemonUpdateRestartManifest | undefined {
	for (const manifestPath of [
		getDaemonUpdateRestartManifestPath(socketPath, agentDir),
		getLegacyDaemonUpdateRestartManifestPath(agentDir),
	]) {
		let modifiedAt: number;
		try {
			modifiedAt = statSync(manifestPath).mtimeMs;
		} catch {
			continue;
		}
		if (notBeforeMs !== undefined && modifiedAt < notBeforeMs - 1000) {
			continue;
		}
		const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown;
		return parseDaemonUpdateRestartManifest(parsed);
	}
	return undefined;
}

function tryReadPreparedDaemonUpdateRestartManifest(
	socketPath: string,
	agentDir: string,
): DaemonUpdateRestartManifest | undefined {
	try {
		return readPreparedDaemonUpdateRestartManifest(socketPath, agentDir);
	} catch {
		clearPreparedDaemonUpdateRestartManifest(socketPath, agentDir);
		return undefined;
	}
}

function hasRestorableDaemonUpdateRestart(manifest: DaemonUpdateRestartManifest | undefined): boolean {
	return manifest !== undefined && manifest.sessions.length > 0;
}

function responseHasActiveDaemonSessions(data: unknown): boolean {
	if (!isRecord(data) || !Array.isArray(data.sessions)) {
		return true;
	}
	return data.sessions.length > 0;
}

interface FixedDaemonSupervisorOwnerIdentity {
	supervisorGeneration: string;
	supervisorOwnerToken: string;
	supervisorPid: number;
	supervisorProcessStartId: string;
	supervisorSocketPath: string;
}

function hasFixedDaemonSupervisorOwnerIdentity(value: unknown): value is FixedDaemonSupervisorOwnerIdentity {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value.supervisorGeneration === "string" &&
		typeof value.supervisorOwnerToken === "string" &&
		Number.isInteger(value.supervisorPid) &&
		(value.supervisorPid as number) > 0 &&
		typeof value.supervisorProcessStartId === "string" &&
		typeof value.supervisorSocketPath === "string"
	);
}

async function prepareConnectedDaemonUpdateRestart(
	client: DaemonClient,
	socketPath: string,
	agentDir: string,
	hello: DaemonHello | undefined,
): Promise<DaemonUpdateRestartManifest> {
	const pendingManifest = tryReadPreparedDaemonUpdateRestartManifest(socketPath, agentDir);
	let startedAt: number | undefined;
	let fixedOwnerIdentity: FixedDaemonSupervisorOwnerIdentity | undefined;
	let fencePersistenceStarted = false;
	const persistPreparedRestartFence = async () => {
		const currentHello = client.hello;
		if (hasFixedDaemonSupervisorOwnerIdentity(currentHello)) {
			fixedOwnerIdentity = currentHello;
		}
		if (!fixedOwnerIdentity) {
			return;
		}
		fencePersistenceStarted = true;
		await persistDaemonStartupFenceFromOwner(socketPath, fixedOwnerIdentity);
	};
	try {
		if (hasFixedDaemonSupervisorOwnerIdentity(hello)) {
			fixedOwnerIdentity = hello;
		}
		if (pendingManifest && pendingManifest.sessions.length > 0) {
			const listResponse = await client.request({ type: "list" }, 30000);
			if (listResponse.success && !responseHasActiveDaemonSessions(listResponse.data)) {
				await persistPreparedRestartFence();
				return pendingManifest;
			}
		}
		clearPreparedDaemonUpdateRestartManifest(socketPath, agentDir);
		startedAt = Date.now();
		const response = await client.request({ type: "prepare_update_restart" }, 120000);
		if (!response.success) {
			throw new Error(response.error);
		}
		const manifest = parseDaemonUpdateRestartManifest(response.data);
		await persistPreparedRestartFence();
		return manifest;
	} catch (error) {
		if (fencePersistenceStarted) {
			throw error;
		}
		if (startedAt !== undefined) {
			const fallback = readPreparedDaemonUpdateRestartManifest(socketPath, agentDir, startedAt);
			if (fallback) {
				await persistPreparedRestartFence();
				return fallback;
			}
		}
		throw error;
	}
}

export async function prepareDaemonUpdateRestart(
	socketPath: string,
	agentDir: string,
): Promise<DaemonUpdateRestartManifest> {
	const pendingManifest = tryReadPreparedDaemonUpdateRestartManifest(socketPath, agentDir);
	const client = new DaemonClient(socketPath);
	let connected = false;
	try {
		await client.connect(1000);
		connected = true;
		const hello = await client.waitForHello(2000).catch(() => undefined);
		return await prepareConnectedDaemonUpdateRestart(client, socketPath, agentDir, hello);
	} catch (error) {
		if (!connected && pendingManifest && pendingManifest.sessions.length > 0) {
			return pendingManifest;
		}
		throw error;
	} finally {
		client.close();
	}
}

function readCreatedActiveSessionId(value: unknown): string {
	if (!isDaemonSessionSummary(value) || typeof value.activeSessionId !== "string") {
		throw new Error("Daemon returned an invalid session create response");
	}
	return value.activeSessionId;
}

async function restoreNextTurnMessages(
	client: DaemonClient,
	activeSessionId: string,
	sessionFile: string,
	messages: readonly CustomMessage[],
): Promise<boolean> {
	if (messages.length === 0) {
		return true;
	}
	const response = await client.request(
		{ type: "restore_next_turn", activeSessionId, messages: [...messages] },
		30000,
	);
	if (!response.success) {
		console.error(chalk.yellow(`Warning: could not restore pending context for ${sessionFile}: ${response.error}`));
		return false;
	}
	return true;
}

interface RestoreDaemonUpdateRestartSessionResult {
	restored: boolean;
	resumed: boolean;
	failureMessage?: string;
}

interface RestoreDaemonUpdateRestartResult extends DaemonUpdateRestartCounts {
	failures: DaemonUpdateRestartFailure[];
}

function remapDaemonUpdateRestartRuntimeMetadata(
	session: DaemonUpdateRestartSession,
	restoredActiveSessionIds: ReadonlyMap<string, string>,
): AgentSessionRuntimeMetadata | undefined {
	const metadata = session.runtimeMetadata;
	if (!metadata) {
		return undefined;
	}
	if (metadata.kind !== "subagent") {
		return metadata;
	}
	const { parentActiveSessionId: oldParentActiveSessionId, ...runtimeMetadata } = metadata;
	const parentActiveSessionId = oldParentActiveSessionId
		? restoredActiveSessionIds.get(oldParentActiveSessionId)
		: undefined;
	return {
		...runtimeMetadata,
		...(parentActiveSessionId ? { parentActiveSessionId } : {}),
	};
}

async function restoreDaemonUpdateRestartSession(
	client: DaemonClient,
	session: DaemonUpdateRestartSession,
	restoredActiveSessionIds: Map<string, string>,
	restartOriginActiveSessionId?: string,
): Promise<RestoreDaemonUpdateRestartSessionResult> {
	const runtimeMetadata = remapDaemonUpdateRestartRuntimeMetadata(session, restoredActiveSessionIds);
	const createResponse = await client.request(
		{
			type: "create",
			sessionPath: session.sessionFile,
			config: session.config,
			...(runtimeMetadata ? { runtimeMetadata } : {}),
			...(session.clientEnv ? { env: session.clientEnv } : {}),
		},
		120000,
	);
	if (!createResponse.success) {
		console.error(chalk.yellow(`Warning: could not restore ${session.sessionFile}: ${createResponse.error}`));
		return { restored: false, resumed: false, failureMessage: createResponse.error };
	}
	const activeSessionId = readCreatedActiveSessionId(createResponse.data);
	restoredActiveSessionIds.set(session.activeSessionId, activeSessionId);
	if (session.activeSessionId === restartOriginActiveSessionId) {
		try {
			const noticeResponse = await client.request(
				{
					type: "append_custom_message",
					activeSessionId,
					message: {
						customType: "prime-agent.update_complete",
						content: `Prime Agent updated to v${VERSION}. This daemon session was restored after the update.`,
						display: true,
						details: { version: VERSION },
					},
				},
				30000,
			);
			if (!noticeResponse.success) {
				console.error(
					chalk.yellow(
						`Warning: could not record update completion in ${session.sessionFile}: ${noticeResponse.error}`,
					),
				);
			}
		} catch (error: unknown) {
			console.error(
				chalk.yellow(
					`Warning: could not record update completion in ${session.sessionFile}: ${formatUnknownError(error)}`,
				),
			);
		}
	}
	await restoreNextTurnMessages(client, activeSessionId, session.sessionFile, session.queue.nextTurn);
	if (!session.shouldResume) return { restored: true, resumed: false };

	const needsContinuationPrompt =
		session.wasStreaming ||
		session.wasCompacting ||
		session.wasBashRunning ||
		session.hadRunningRlmChildren ||
		session.wasRetrying ||
		session.hadAcceptedPromptInFlight;
	let resumedSession = false;
	let restoredQueuedWork = false;
	if (session.queue.actions.actions.length > 0) {
		const response = await client.request(
			{ type: "restore_actions", activeSessionId, snapshot: session.queue.actions },
			30000,
		);
		if (response.success) {
			restoredQueuedWork = true;
		} else {
			console.error(
				chalk.yellow(`Warning: could not restore queued actions for ${session.sessionFile}: ${response.error}`),
			);
		}
	}
	const restoredAcceptedTurn =
		restoredQueuedWork &&
		session.queue.actions.actions.some(
			(action) =>
				action.payload.kind === "turn" && !action.payload.queueVisible && action.payload.acceptedBeforeCompletion,
		);
	if (needsContinuationPrompt && !restoredAcceptedTurn) {
		const promptResponse = await client.request(
			{
				type: "prompt",
				activeSessionId,
				message: UPDATE_RESTART_CONTINUATION_PROMPT,
				expandPromptTemplates: false,
			},
			120000,
		);
		if (!promptResponse.success) {
			console.error(chalk.yellow(`Warning: could not resume ${session.sessionFile}: ${promptResponse.error}`));
		} else {
			resumedSession = true;
		}
	}
	if (!resumedSession && restoredQueuedWork) {
		const response = await client.request({ type: "resume_queue", activeSessionId }, 30000);
		if (response.success) {
			resumedSession = true;
		} else {
			console.error(
				chalk.yellow(`Warning: could not resume queued work for ${session.sessionFile}: ${response.error}`),
			);
		}
	}
	return { restored: true, resumed: resumedSession };
}

async function restoreDaemonUpdateRestart(
	socketPath: string,
	manifest: DaemonUpdateRestartManifest,
	restartOriginActiveSessionId?: string,
	onProgress?: (progress: RestoreDaemonUpdateRestartResult) => void,
): Promise<RestoreDaemonUpdateRestartResult> {
	const restoredActiveSessionIds = new Map<string, string>();
	if (manifest.sessions.length === 0) {
		return { total: 0, restored: 0, resumed: 0, failed: 0, failures: [] };
	}
	const client = new DaemonClient(socketPath);
	let restored = 0;
	let resumed = 0;
	const failures: DaemonUpdateRestartFailure[] = [];
	try {
		await client.connect(10000);
		for (const session of manifest.sessions) {
			try {
				const result = await restoreDaemonUpdateRestartSession(
					client,
					session,
					restoredActiveSessionIds,
					restartOriginActiveSessionId,
				);
				if (result.restored) {
					restored++;
				}
				if (result.resumed) {
					resumed++;
				}
				if (!result.restored) {
					failures.push({
						sessionFile: session.sessionFile,
						message: result.failureMessage ?? "unknown restore error",
					});
				}
			} catch (error: unknown) {
				const message = formatUnknownError(error);
				console.error(chalk.yellow(`Warning: could not restore ${session.sessionFile}: ${message}`));
				failures.push({ sessionFile: session.sessionFile, message });
			}
			onProgress?.({
				total: manifest.sessions.length,
				restored,
				resumed,
				failed: failures.length,
				failures: [...failures],
			});
		}
	} finally {
		client.close();
	}
	console.log(chalk.green(`Restored ${restored} agent session${restored === 1 ? "" : "s"}`));
	if (resumed > 0) {
		console.log(chalk.green(`Resumed ${resumed} interrupted session${resumed === 1 ? "" : "s"}`));
	}
	return {
		total: manifest.sessions.length,
		restored,
		resumed,
		failed: manifest.sessions.length - restored,
		failures,
	};
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function processIdentityFromDaemonHello(
	hello: DaemonHello | undefined,
): DaemonUpdateRestartProcessIdentity | undefined {
	if (!hello?.supervisorPid || !Number.isInteger(hello.supervisorPid) || hello.supervisorPid <= 0) {
		return undefined;
	}
	return {
		pid: hello.supervisorPid,
		...(hello.supervisorProcessStartId ? { processStartId: hello.supervisorProcessStartId } : {}),
		...(hello.supervisorGeneration ? { supervisorGeneration: hello.supervisorGeneration } : {}),
		...(hello.supervisorOwnerToken ? { supervisorOwnerToken: hello.supervisorOwnerToken } : {}),
	};
}

function normalizedSocketPath(socketPath: string): string {
	return process.platform === "win32" ? socketPath.toLowerCase() : resolve(socketPath);
}

function validateReplacementDaemon(
	socketPath: string,
	hello: DaemonHello,
	predecessor: DaemonUpdateRestartProcessIdentity | undefined,
): DaemonUpdateRestartProcessIdentity {
	if (
		hello.protocol.version !== DAEMON_PROTOCOL_VERSION ||
		hello.schemaId !== DAEMON_SCHEMA_ID ||
		hello.appVersion !== VERSION
	) {
		throw new Error(
			`Replacement daemon is v${hello.appVersion}/proto${hello.protocol.version}/schema ${hello.schemaId ?? "legacy"}, ` +
				`expected v${VERSION}/proto${DAEMON_PROTOCOL_VERSION}/schema ${DAEMON_SCHEMA_ID}`,
		);
	}
	if (
		!hello.supervisorSocketPath ||
		normalizedSocketPath(hello.supervisorSocketPath) !== normalizedSocketPath(socketPath)
	) {
		throw new Error(`Replacement daemon identity does not match ${socketPath}`);
	}
	const successor = processIdentityFromDaemonHello(hello);
	if (!successor?.supervisorGeneration || !successor.supervisorOwnerToken) {
		throw new Error(`Replacement daemon on ${socketPath} did not provide an identity fence`);
	}
	if (
		predecessor &&
		((predecessor.supervisorGeneration !== undefined &&
			successor.supervisorGeneration === predecessor.supervisorGeneration) ||
			(predecessor.supervisorOwnerToken !== undefined &&
				successor.supervisorOwnerToken === predecessor.supervisorOwnerToken) ||
			(successor.pid === predecessor.pid &&
				predecessor.processStartId !== undefined &&
				successor.processStartId === predecessor.processStartId))
	) {
		throw new Error(`Replacement daemon on ${socketPath} still has the predecessor identity`);
	}
	return successor;
}

export async function runDaemonUpdateRestartCoordinator(options: {
	socketPath: string;
	agentDir: string;
	statusPath: string;
	originActiveSessionId?: string;
}): Promise<DaemonUpdateRestartStatus> {
	const statusWriter = new DaemonUpdateRestartStatusWriter(
		options.statusPath,
		`${process.pid}-${Date.now()}`,
		options.socketPath,
	);
	const stopStatusHeartbeat = statusWriter.startHeartbeat();
	let lease: Awaited<ReturnType<typeof acquireDaemonUpdateRestartCoordinator>> | undefined;
	let shutdownAdmission: Awaited<ReturnType<typeof acquireDaemonShutdownAdmission>> | undefined;
	let connectedClient: DaemonClient | undefined;
	let manifest: DaemonUpdateRestartManifest | undefined;
	try {
		try {
			lease = await acquireDaemonUpdateRestartCoordinator({
				requestId: statusWriter.current().requestId,
				socketPath: options.socketPath,
				statusPath: options.statusPath,
			});
		} catch (error: unknown) {
			if (!(error instanceof DaemonUpdateRestartCoordinatorAlreadyRunningError)) {
				throw error;
			}
			const activeStatus = await waitForActiveDaemonUpdateRestartCoordinator(error.record);
			statusWriter.update({
				phase: activeStatus.phase,
				counts: activeStatus.counts,
				...(activeStatus.predecessor ? { predecessor: activeStatus.predecessor } : {}),
				...(activeStatus.successor ? { successor: activeStatus.successor } : {}),
				...(activeStatus.failures ? { failures: activeStatus.failures } : {}),
				...(activeStatus.message ? { message: activeStatus.message } : {}),
			});
			return statusWriter.current();
		}
		shutdownAdmission = await acquireDaemonShutdownAdmission();
		const daemonProbe = await probeRunningDaemonSessions(options.socketPath);
		const reportRestoreProgress = (progress: RestoreDaemonUpdateRestartResult) => {
			const { failures, ...counts } = progress;
			statusWriter.update({ counts, failures });
		};
		let predecessor: DaemonUpdateRestartProcessIdentity | undefined;
		if (daemonProbe.reachable) {
			connectedClient = new DaemonClient(options.socketPath);
			await connectedClient.connect(1000);
			const hello = await connectedClient.waitForHello(2000);
			predecessor = processIdentityFromDaemonHello(hello);
			statusWriter.update({ phase: "preparing", ...(predecessor ? { predecessor } : {}) });
			try {
				manifest = await prepareConnectedDaemonUpdateRestart(
					connectedClient,
					options.socketPath,
					options.agentDir,
					hello,
				);
			} catch (error: unknown) {
				const daemonLacksPrepareCommand = isUnknownDaemonCommandError(error, "prepare_update_restart");
				if (daemonProbeMayHaveBusySessions(daemonProbe) || !daemonLacksPrepareCommand) {
					throw new Error(
						`Could not prepare daemon sessions for automatic resume; the previous daemon is still running (${formatUnknownError(error)})`,
					);
				}
			}
			statusWriter.update({
				phase: "stopping",
				counts: {
					total: manifest?.sessions.length ?? 0,
					restored: 0,
					resumed: 0,
					failed: 0,
				},
			});
			await shutdownAdmission.assertOrRenew();
			const stopped = await shutdownConnectedDaemonAndWait(connectedClient, options.socketPath, 10000, hello);
			connectedClient = undefined;
			if (!stopped) {
				const remainingDaemon = await probeRunningDaemonSessions(options.socketPath);
				if (remainingDaemon.reachable) {
					if (manifest) {
						try {
							const restoreResult = await restoreDaemonUpdateRestart(
								options.socketPath,
								manifest,
								options.originActiveSessionId,
								reportRestoreProgress,
							);
							const { failures: restoreFailures, ...counts } = restoreResult;
							clearPreparedDaemonUpdateRestartManifest(options.socketPath, options.agentDir);
							statusWriter.update({
								counts,
								...(restoreFailures.length > 0 ? { failures: restoreFailures } : {}),
							});
						} catch {
							// Keep the manifest for a later recovery attempt when fallback restoration fails.
						}
					}
					throw new Error(`Could not stop the predecessor daemon on ${options.socketPath}`);
				}
			}
		} else {
			manifest = tryReadPreparedDaemonUpdateRestartManifest(options.socketPath, options.agentDir);
			if (!hasRestorableDaemonUpdateRestart(manifest)) {
				statusWriter.update({ phase: "skipped", message: "No running daemon needed to be restarted" });
				return statusWriter.current();
			}
		}

		statusWriter.update({ phase: "starting_daemon" });
		await waitForDaemonStartupFence(options.socketPath, UPDATE_RESTART_PREDECESSOR_FENCE_TIMEOUT_MS);
		await shutdownAdmission.assertOrRenew();
		await shutdownAdmission.release();
		shutdownAdmission = undefined;
		await ensureInteractiveDaemonRunning(options.socketPath);
		const successorClient = new DaemonClient(options.socketPath);
		let successor: DaemonUpdateRestartProcessIdentity;
		try {
			await successorClient.connect(1000);
			const successorHello = await successorClient.waitForHello(60000);
			successor = validateReplacementDaemon(options.socketPath, successorHello, predecessor);
		} finally {
			successorClient.close();
		}
		statusWriter.update({ phase: "restoring", successor });

		let counts: DaemonUpdateRestartCounts = { total: 0, restored: 0, resumed: 0, failed: 0 };
		let failures: DaemonUpdateRestartFailure[] = [];
		if (manifest) {
			const restoreResult = await restoreDaemonUpdateRestart(
				options.socketPath,
				manifest,
				options.originActiveSessionId,
				reportRestoreProgress,
			);
			counts = {
				total: restoreResult.total,
				restored: restoreResult.restored,
				resumed: restoreResult.resumed,
				failed: restoreResult.failed,
			};
			failures = restoreResult.failures;
			clearPreparedDaemonUpdateRestartManifest(options.socketPath, options.agentDir);
		}
		statusWriter.update({
			phase: "complete",
			counts,
			...(failures.length > 0 ? { failures } : {}),
			message:
				counts.failed > 0
					? `Restarted the daemon with ${counts.failed} session restore failure${counts.failed === 1 ? "" : "s"}`
					: "Restarted the daemon after the update",
		});
	} catch (error: unknown) {
		statusWriter.update({ phase: "failed", message: formatUnknownError(error) });
	} finally {
		stopStatusHeartbeat();
		connectedClient?.close();
		await shutdownAdmission?.release();
		await lease?.release();
	}
	return statusWriter.current();
}

export async function handleConfigCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "config") {
		return false;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "config command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolvedPaths = await packageManager.resolve();

	await selectConfig({
		resolvedPaths,
		settingsManager,
		cwd,
		agentDir,
	});

	process.exit(0);
}

export async function handlePackageCommand(args: string[]): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		if (options.invalidOption === "-l" && (options.command === "install" || options.command === "remove")) {
			console.error(chalk.red('Option -l was removed. Use "--local".'));
			process.exitCode = 1;
			return true;
		}
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.restartCoordinator) {
		const agentDir = getAgentDir();
		const statusPath = options.restartStatusPath;
		const daemonSocketPath = options.daemonSocketPath;
		const restartDirectory = resolve(agentDir, "update-restarts");
		if (!statusPath || !daemonSocketPath || !resolve(statusPath).startsWith(`${restartDirectory}${sep}`)) {
			console.error(chalk.red("Invalid daemon update restart coordinator invocation."));
			process.exitCode = 1;
			return true;
		}
		const status = await runDaemonUpdateRestartCoordinator({
			socketPath: daemonSocketPath,
			agentDir,
			statusPath,
			originActiveSessionId: options.restartOriginActiveSessionId,
		});
		if (status.phase === "failed") {
			process.exitCode = 1;
		}
		return true;
	}

	if (options.restartStatusPath || options.restartOriginActiveSessionId) {
		console.error(chalk.red("Invalid daemon update restart coordinator invocation."));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "package command");
	const selfUpdateNpmCommand = settingsManager.getGlobalSettings().npmCommand;

	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install":
				await packageManager.installAndPersist(source!, { local: options.local });
				console.log(chalk.green(`Installed ${source}`));
				return true;

			case "remove": {
				const removed = await packageManager.removeAndPersist(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "list": {
				const configuredPackages = packageManager.listConfiguredPackages();
				const userPackages = configuredPackages.filter((pkg) => pkg.scope === "user");
				const projectPackages = configuredPackages.filter((pkg) => pkg.scope === "project");

				if (configuredPackages.length === 0) {
					console.log(chalk.dim("No packages installed."));
					return true;
				}

				const formatPackage = (pkg: (typeof configuredPackages)[number]) => {
					const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
					console.log(`  ${display}`);
					if (pkg.installedPath) {
						console.log(chalk.dim(`    ${pkg.installedPath}`));
					}
				};

				if (userPackages.length > 0) {
					console.log(chalk.bold("User packages:"));
					for (const pkg of userPackages) {
						formatPackage(pkg);
					}
				}

				if (projectPackages.length > 0) {
					if (userPackages.length > 0) console.log();
					console.log(chalk.bold("Project packages:"));
					for (const pkg of projectPackages) {
						formatPackage(pkg);
					}
				}

				return true;
			}

			case "update": {
				const target = options.updateTarget ?? { type: "all" };
				if (updateTargetIncludesExtensions(target)) {
					const updateSource = target.type === "extensions" ? target.source : undefined;
					await packageManager.update(updateSource);
					if (updateSource) {
						console.log(chalk.green(`Updated ${updateSource}`));
					} else {
						console.log(chalk.green("Updated packages"));
					}
				}
				if (updateTargetIncludesSelf(target)) {
					const selfUpdatePlan = await getSelfUpdatePlan(options.force);
					if (!selfUpdatePlan.shouldRun) {
						setSelfUpdateNoChangeExitCode();
						return true;
					}
					const selfUpdateCommand = getSelfUpdateCommand(
						PACKAGE_NAME,
						selfUpdateNpmCommand,
						selfUpdatePlan.installSpec,
						selfUpdatePlan.packageName,
					);
					if (!selfUpdateCommand) {
						printSelfUpdateUnavailable(
							selfUpdateNpmCommand,
							selfUpdatePlan.installSpec,
							selfUpdatePlan.packageName,
						);
						process.exitCode = 1;
						return true;
					}
					// Confirm before the install, since upgrading the daemon afterward stops and resumes busy work.
					const daemonSocketPath = resolveUpdateDaemonSocketPath(options.daemonSocketPath);
					const daemonProbe = await probeRunningDaemonSessions(daemonSocketPath);
					if (!(await confirmDaemonSessionLossBeforeUpdate(daemonProbe, options.force))) {
						if (process.stdin.isTTY) {
							console.log(chalk.dim("Update cancelled."));
						}
						process.exitCode = 1;
						return true;
					}
					try {
						await runSelfUpdate(selfUpdateCommand);
					} catch (error: unknown) {
						const message = error instanceof Error ? error.message : "Unknown package command error";
						console.error(chalk.red(`Error: ${message}`));
						printSelfUpdateFallback(selfUpdateCommand);
						process.exitCode = 1;
						return true;
					}
					const versionChange = selfUpdatePlan.targetVersion
						? ` from v${VERSION} to v${selfUpdatePlan.targetVersion}`
						: "";
					console.log(chalk.green(`Updated ${APP_NAME}${versionChange}`));
					if (process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] === "1") {
						return true;
					}
					try {
						const status = await launchDaemonUpdateRestartCoordinator({
							socketPath: daemonSocketPath,
							agentDir,
							cwd,
							originActiveSessionId: process.env[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV],
						});
						reportDaemonUpdateRestartStatus(status);
					} catch (error: unknown) {
						console.error(
							chalk.yellow(
								`Warning: updated, but could not coordinate the daemon restart (${formatUnknownError(error)}).`,
							),
						);
					}
				}
				return true;
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
