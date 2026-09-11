import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ChildProcessModule from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DaemonLaunchModule from "../src/cli/daemon-launch.js";
import type * as DaemonStopConfirmModule from "../src/cli/daemon-stop-confirm.js";
import type * as DaemonUpdateRestartModule from "../src/cli/daemon-update-restart.js";
import type { DaemonUpdateRestartStatus } from "../src/cli/daemon-update-restart.js";
import type * as ConfigModule from "../src/config.js";
import {
	CONFIG_DIR_NAME,
	ENV_AGENT_DIR,
	PACKAGE_NAME,
	SELF_UPDATE_INTERACTIVE_CHILD_ENV,
	SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE,
	type SelfUpdateCommand,
	VERSION,
} from "../src/config.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type * as TelemetryModule from "../src/core/telemetry.js";
import type {
	CaptureTelemetryEventOptions,
	TelemetryEventName,
	TelemetryProperties,
	TelemetrySink,
} from "../src/core/telemetry.js";
import type * as TelemetryErrorsModule from "../src/core/telemetry-errors.js";
import type { CaptureTelemetryErrorOptions } from "../src/core/telemetry-errors.js";
import { beginInstallationTelemetry, INSTALLATION_TELEMETRY_CONTEXT_ENV } from "../src/core/telemetry-installation.js";
import {
	readInstallationTelemetryState,
	writeInstallationTelemetryState,
} from "../src/core/telemetry-installation-state.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { handlePackageCommand } from "../src/package-manager-cli.js";
import type * as VersionCheckModule from "../src/utils/version-check.js";

const mocks = vi.hoisted(() => ({
	events: [] as { name: TelemetryEventName; properties: TelemetryProperties }[],
	flush: vi.fn(async () => {}),
	capture: (name: TelemetryEventName, properties: TelemetryProperties) => mocks.events.push({ name, properties }),
	spawn: vi.fn(),
	spawnSync: vi.fn(),
	getSelfUpdateCommand: vi.fn(),
	getLatestRelease: vi.fn(),
	probeDaemon: vi.fn(),
	confirmSessionLoss: vi.fn(),
	launchCoordinator: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcessModule>()),
	spawn: mocks.spawn,
	spawnSync: mocks.spawnSync,
}));

vi.mock("../src/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof ConfigModule>()),
	getSelfUpdateCommand: mocks.getSelfUpdateCommand,
}));

vi.mock("../src/utils/version-check.js", async (importOriginal) => ({
	...(await importOriginal<typeof VersionCheckModule>()),
	getLatestPiRelease: mocks.getLatestRelease,
}));

vi.mock("../src/cli/daemon-launch.js", async (importOriginal) => ({
	...(await importOriginal<typeof DaemonLaunchModule>()),
	probeRunningDaemonSessions: mocks.probeDaemon,
}));

vi.mock("../src/cli/daemon-stop-confirm.js", async (importOriginal) => ({
	...(await importOriginal<typeof DaemonStopConfirmModule>()),
	confirmDaemonSessionLoss: mocks.confirmSessionLoss,
}));

vi.mock("../src/cli/daemon-update-restart.js", async (importOriginal) => ({
	...(await importOriginal<typeof DaemonUpdateRestartModule>()),
	launchDaemonUpdateRestartCoordinator: mocks.launchCoordinator,
}));

vi.mock("../src/core/telemetry.js", async (importOriginal) => {
	const original = await importOriginal<typeof TelemetryModule>();
	const sink: TelemetrySink = mocks;
	return {
		...original,
		captureTelemetryEvent: (options: CaptureTelemetryEventOptions) =>
			original.captureTelemetryEvent({ ...options, sink }),
		flushTelemetry: (options: Parameters<typeof original.flushTelemetry>[0], timeoutMs?: number) =>
			original.flushTelemetry({ ...options, sink }, timeoutMs),
	};
});

vi.mock("../src/core/telemetry-errors.js", async (importOriginal) => {
	const original = await importOriginal<typeof TelemetryErrorsModule>();
	const sink: TelemetrySink = mocks;
	return {
		...original,
		captureTelemetryError: (options: CaptureTelemetryErrorOptions) =>
			original.captureTelemetryError({ ...options, sink }),
	};
});

function installationEvents(): TelemetryProperties[] {
	return mocks.events.filter((event) => event.name === "agent installation stage").map((event) => event.properties);
}

function stages(): string[] {
	return installationEvents().map((properties) => `${properties.stage}:${properties.outcome}`);
}

function coordinatorStatus(overrides: Partial<DaemonUpdateRestartStatus> = {}): DaemonUpdateRestartStatus {
	return {
		version: 1,
		requestId: "test-request",
		socketPath: "/tmp/update-telemetry.sock",
		phase: "complete",
		coordinator: { pid: process.pid },
		counts: { total: 0, restored: 0, resumed: 0, failed: 0 },
		incompleteRestores: 0,
		startedAt: "2026-09-09T00:00:00.000Z",
		updatedAt: "2026-09-09T00:00:01.000Z",
		...overrides,
	};
}

function packageProcess(exitCode: number, signal: string | null = null) {
	const child = {
		on(event: string, listener: unknown) {
			if (event === "close") {
				queueMicrotask(() => (listener as (code: number, signal: string | null) => void)(exitCode, signal));
			}
			return child;
		},
	};
	return child;
}

let tempDirectory: string;
let agentDir: string;
let projectDir: string;
let previousCwd: string;
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.events.length = 0;
	tempDirectory = mkdtempSync(join(tmpdir(), "prime-update-telemetry-"));
	agentDir = join(tempDirectory, "agent");
	projectDir = join(tempDirectory, "project");
	mkdirSync(agentDir);
	mkdirSync(projectDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ npmCommand: ["npm"] }));
	previousCwd = process.cwd();
	previousExitCode = process.exitCode;
	process.chdir(projectDir);
	process.exitCode = undefined;
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv("DO_NOT_TRACK", "0");
	vi.stubEnv("PI_OFFLINE", "0");
	vi.stubEnv("PRIME_AGENT_TELEMETRY", "");
	vi.stubEnv(INSTALLATION_TELEMETRY_CONTEXT_ENV, "");
	vi.stubEnv(SELF_UPDATE_INTERACTIVE_CHILD_ENV, "");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network request");
		}),
	);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	mocks.getSelfUpdateCommand.mockReset().mockReturnValue({
		command: "npm",
		args: ["install", "-g", PACKAGE_NAME],
		display: `npm install -g ${PACKAGE_NAME}`,
	} satisfies SelfUpdateCommand);
	mocks.getLatestRelease.mockReset().mockResolvedValue({ version: "999.0.0" });
	mocks.probeDaemon.mockReset().mockResolvedValue({ reachable: false });
	mocks.confirmSessionLoss.mockReset().mockResolvedValue(true);
	mocks.launchCoordinator.mockReset().mockResolvedValue(coordinatorStatus());
	mocks.spawn.mockReset().mockImplementation(() => packageProcess(0));
	mocks.spawnSync.mockReset().mockReturnValue({ status: 0, signal: null, stdout: "", stderr: "" });
});

afterEach(() => {
	try {
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		process.chdir(previousCwd);
		process.exitCode = previousExitCode;
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});

describe("CLI update outcome telemetry", () => {
	it("records package completion separately from restart and first usable launch", async () => {
		await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

		expect(stages()).toEqual([
			"started:started",
			"release_lookup:started",
			"release_lookup:success",
			"requirements:started",
			"requirements:success",
			"package_install:started",
			"package_install:success",
			"completed:success",
			"daemon_restart:started",
			"daemon_restart:success",
		]);
		expect(new Set(installationEvents().map((event) => event.installation_attempt_id)).size).toBe(1);
		expect(installationEvents().at(-1)).toMatchObject({
			installation_action: "update",
			installation_source: "cli",
			from_version: VERSION,
			target_version: "999.0.0",
		});
		expect(readInstallationTelemetryState(agentDir)).toHaveLength(1);
		expect(stages()).not.toContain("ready:success");
		expect(mocks.flush).toHaveBeenCalledOnce();
		expect(process.exitCode).toBeUndefined();
	});

	it("counts an already-current update as skipped and preserves the interactive no-change result", async () => {
		vi.stubEnv(SELF_UPDATE_INTERACTIVE_CHILD_ENV, "1");
		mocks.getLatestRelease.mockResolvedValue({ version: VERSION });

		await handlePackageCommand(["update", "--self"]);

		expect(stages()).toEqual([
			"started:started",
			"release_lookup:started",
			"release_lookup:success",
			"completed:skipped",
		]);
		expect(installationEvents().at(-1)).toMatchObject({ reason: "up_to_date" });
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.launchCoordinator).not.toHaveBeenCalled();
		expect(readInstallationTelemetryState(agentDir)).toHaveLength(0);
		expect(process.exitCode).toBe(SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE);
	});

	it("reports an unsupported installation without pretending an install was attempted", async () => {
		mocks.getSelfUpdateCommand.mockReturnValue(undefined);

		await handlePackageCommand(["update", "--self"]);

		expect(installationEvents().at(-1)).toMatchObject({
			stage: "completed",
			outcome: "unavailable",
			reason: "unsupported_install",
		});
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.probeDaemon).not.toHaveBeenCalled();
		expect(stages()).not.toContain("package_install:started");
		expect(process.exitCode).toBe(1);
	});

	it("records a declined daemon interruption as cancellation before package installation", async () => {
		mocks.confirmSessionLoss.mockResolvedValue(false);

		await handlePackageCommand(["update", "--self"]);

		expect(stages().slice(-2)).toEqual(["requirements:cancelled", "completed:cancelled"]);
		expect(installationEvents().at(-1)).toMatchObject({ reason: "declined" });
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.launchCoordinator).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it.each(["unavailable", "throw"])(
		"records %s release lookup while preserving the package-manager fallback",
		async (result) => {
			if (result === "throw") mocks.getLatestRelease.mockRejectedValue(new Error("secret prompt in lookup failure"));
			else mocks.getLatestRelease.mockResolvedValue(undefined);

			await handlePackageCommand(["update", "--self"]);

			expect(installationEvents()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						stage: "release_lookup",
						outcome: result === "throw" ? "failed" : "unavailable",
						reason: "release_lookup_failed",
					}),
					expect.objectContaining({ stage: "completed", outcome: "success" }),
				]),
			);
			expect(mocks.spawn).toHaveBeenCalledOnce();
			expect(JSON.stringify(mocks.events)).not.toContain("secret prompt");
			expect(process.exitCode).toBeUndefined();
		},
	);

	it.each([
		{ code: 23, signal: null, expectedCode: "process_exit_23" },
		{ code: 1, signal: "SIGTERM", expectedCode: "signal_SIGTERM" },
	])(
		"links package failure $expectedCode to a sanitized error and never starts the daemon restart",
		async ({ code, signal, expectedCode }) => {
			mocks.spawn.mockImplementation(() => packageProcess(code, signal));

			await handlePackageCommand(["update", "--self"]);

			const error = mocks.events.find((event) => event.name === "agent error")?.properties;
			expect(error).toMatchObject({ error_code_group: expectedCode });
			expect(installationEvents()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						stage: "package_install",
						outcome: "failed",
						reason: "install_failed",
						error_id: error?.error_id,
					}),
					expect.objectContaining({ stage: "completed", outcome: "failed", reason: "install_failed" }),
				]),
			);
			expect(mocks.launchCoordinator).not.toHaveBeenCalled();
			expect(readInstallationTelemetryState(agentDir)).toHaveLength(0);
			expect(process.exitCode).toBe(1);
		},
	);

	it.each([
		{
			phase: "failed" as const,
			total: 0,
			failed: 0,
			incomplete: 0,
			restoreOutcome: undefined,
			restoreFailed: undefined,
		},
		{ phase: "complete" as const, total: 3, failed: 1, incomplete: 0, restoreOutcome: "failed", restoreFailed: 1 },
		{ phase: "complete" as const, total: 3, failed: 1, incomplete: 1, restoreOutcome: "failed", restoreFailed: 2 },
		{
			phase: "complete" as const,
			total: 2,
			failed: 0,
			incomplete: undefined,
			restoreOutcome: "unavailable",
			restoreFailed: undefined,
		},
	])(
		"keeps package success separate from restart/restoration: %j",
		async ({ phase, total, failed, incomplete, restoreOutcome, restoreFailed }) => {
			mocks.launchCoordinator.mockResolvedValue(
				coordinatorStatus({
					phase,
					counts: { total, restored: total - failed, resumed: 0, failed },
					incompleteRestores: incomplete,
					message: "private coordinator details should remain local",
					failures: failed
						? [{ sessionFile: "/private/user/session.jsonl", message: "private session prompt" }]
						: [],
				}),
			);
			await handlePackageCommand(["update", "--self"]);
			expect(installationEvents().filter((event) => event.stage === "completed")).toEqual([
				expect.objectContaining({ outcome: "success" }),
			]);
			expect(stages()).toContain(`daemon_restart:${phase === "failed" ? "failed" : "success"}`);
			const restore = installationEvents().find((event) => event.stage === "session_restore");
			if (total > 0) {
				expect(restore).toMatchObject({ outcome: restoreOutcome, session_restore_total: total });
				expect(restore?.session_restore_failed).toBe(restoreFailed);
				expect(restore?.reason).toBe(restoreFailed ? "session_restore_failed" : undefined);
			} else expect(restore).toBeUndefined();
			expect(stages()).not.toContain("ready:success");
			expect(JSON.stringify(mocks.events)).not.toContain("private");
			expect(process.exitCode).toBeUndefined();
		},
	);

	it("reports coordinator launch failures without changing successful package command exit status", async () => {
		mocks.launchCoordinator.mockRejectedValue(Object.assign(new Error("daemon start failed"), { code: "ENOENT" }));

		await handlePackageCommand(["update", "--self"]);

		expect(installationEvents()).toContainEqual(
			expect.objectContaining({ stage: "daemon_restart", outcome: "failed", reason: "daemon_restart_failed" }),
		);
		expect(installationEvents()).toContainEqual(expect.objectContaining({ stage: "completed", outcome: "success" }));
		expect(process.exitCode).toBeUndefined();
	});

	it("continues an interactive parent's attempt without a second start or child-owned restart", async () => {
		const parent = beginInstallationTelemetry({
			agentDir,
			settingsManager: SettingsManager.create(projectDir, agentDir),
			source: "interactive",
			cwd: projectDir,
		});
		expect(parent).toBeDefined();
		vi.stubEnv(INSTALLATION_TELEMETRY_CONTEXT_ENV, parent!.environment()[INSTALLATION_TELEMETRY_CONTEXT_ENV]!);
		vi.stubEnv(SELF_UPDATE_INTERACTIVE_CHILD_ENV, "1");
		try {
			await handlePackageCommand(["update", "--self"]);
		} finally {
			parent?.dispose();
		}

		expect(installationEvents().filter((event) => event.stage === "started")).toHaveLength(1);
		expect(installationEvents().filter((event) => event.stage === "completed")).toEqual([
			expect.objectContaining({ outcome: "success" }),
		]);
		expect(installationEvents().every((event) => event.installation_source === "interactive")).toBe(true);
		expect(new Set(installationEvents().map((event) => event.installation_attempt_id)).size).toBe(1);
		expect(mocks.launchCoordinator).not.toHaveBeenCalled();
		expect(stages()).not.toContain("ready:success");
		expect(process.env[INSTALLATION_TELEMETRY_CONTEXT_ENV]).toBeUndefined();
	});

	it("preserves a project opt-out for failed CLI updates", async () => {
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ telemetry: { enabled: false } }),
		);
		mocks.spawn.mockImplementation(() => packageProcess(23));

		await handlePackageCommand(["update", "--self"]);

		expect(mocks.events).toEqual([]);
		expect(mocks.spawn).toHaveBeenCalledOnce();
		expect(readInstallationTelemetryState(agentDir)).toHaveLength(0);
		expect(process.exitCode).toBe(1);
	});
});

function interactiveReceiver(settingsManager: SettingsManager) {
	return {
		settingsManager,
		connectionState: { activeSessionId: "active-session", sessionFile: join(projectDir, "session.jsonl") },
		fullscreenEnabled: false,
		options: { daemonSocketPath: join(tempDirectory, "update.sock"), onShutdown: vi.fn(async () => {}) },
		getCurrentCwd: () => process.cwd(),
		stopWorkingLoader: vi.fn(),
		stop: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleReloadCommand: vi.fn(async () => true),
		ui: { terminal: { drainInput: vi.fn(async () => {}) }, stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() },
		agentConnection: { dispose: vi.fn(async () => {}) },
	};
}

type InteractiveReceiver = ReturnType<typeof interactiveReceiver>;
const handleInteractiveUpdate = (
	InteractiveMode.prototype as unknown as {
		handleUpdateCommand(this: InteractiveReceiver, args: string): Promise<void>;
	}
).handleUpdateCommand;

async function runInteractiveUpdate(receiver: InteractiveReceiver) {
	const updateProcess = process as NodeJS.Process & {
		execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never;
	};
	const originalExecve = updateProcess.execve;
	const originalNodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
	const execve = vi.fn((_file: string, _args: string[], _env: NodeJS.ProcessEnv) => undefined as never);
	updateProcess.execve = execve;
	Object.defineProperty(process.versions, "node", { ...originalNodeVersion, value: "26.1.0" });
	try {
		await handleInteractiveUpdate.call(receiver, "--self");
	} finally {
		updateProcess.execve = originalExecve;
		if (originalNodeVersion) Object.defineProperty(process.versions, "node", originalNodeVersion);
	}
	return execve;
}

describe.skipIf(process.platform === "win32")("interactive update telemetry handoff", () => {
	it("shares the parent attempt with the updater and clears one-shot context before relaunch", async () => {
		mocks.spawnSync.mockImplementation((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
			const properties = JSON.parse(options.env[INSTALLATION_TELEMETRY_CONTEXT_ENV]!) as TelemetryProperties;
			writeInstallationTelemetryState(agentDir, {
				version: 1,
				createdAt: Date.now(),
				cwd: projectDir,
				properties: { ...properties, target_version: "999.0.0" },
				completeOnReady: false,
			});
			return { status: 0, signal: null };
		});

		const execve = await runInteractiveUpdate(interactiveReceiver(SettingsManager.create(projectDir, agentDir)));

		const updaterEnv = mocks.spawnSync.mock.calls[0][2].env as NodeJS.ProcessEnv;
		const relaunchEnv = execve.mock.calls[0][2] as NodeJS.ProcessEnv;
		const start = installationEvents().find((event) => event.stage === "started")!;
		expect(updaterEnv[SELF_UPDATE_INTERACTIVE_CHILD_ENV]).toBe("1");
		expect(JSON.parse(updaterEnv[INSTALLATION_TELEMETRY_CONTEXT_ENV]!)).toMatchObject({
			installation_attempt_id: start.installation_attempt_id,
			installation_source: "interactive",
		});
		expect(relaunchEnv[INSTALLATION_TELEMETRY_CONTEXT_ENV]).toBeUndefined();
		expect(installationEvents().filter((event) => event.stage === "daemon_restart")).toEqual([
			expect.objectContaining({ installation_attempt_id: start.installation_attempt_id, target_version: "999.0.0" }),
			expect.objectContaining({ installation_attempt_id: start.installation_attempt_id, target_version: "999.0.0" }),
		]);
		expect(stages()).toEqual([
			"started:started",
			"daemon_restart:started",
			"daemon_restart:success",
			"relaunch:started",
		]);
		expect(mocks.spawnSync).toHaveBeenCalledOnce();
		expect(execve).toHaveBeenCalledOnce();
		expect(mocks.flush).toHaveBeenCalledOnce();
	});

	it.each(["global", "project", "environment", "dnt", "offline"])(
		"propagates the %s opt-out to both subprocess environments",
		async (scope) => {
			if (scope === "global")
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ telemetry: { enabled: false } }));
			if (scope === "project") {
				mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
				writeFileSync(
					join(projectDir, CONFIG_DIR_NAME, "settings.json"),
					JSON.stringify({ telemetry: { enabled: false } }),
				);
			}
			if (scope === "environment") vi.stubEnv("PRIME_AGENT_TELEMETRY", "0");
			if (scope === "dnt") vi.stubEnv("DO_NOT_TRACK", "1");
			if (scope === "offline") vi.stubEnv("PI_OFFLINE", "1");
			vi.stubEnv(INSTALLATION_TELEMETRY_CONTEXT_ENV, "stale-parent-context");

			const execve = await runInteractiveUpdate(interactiveReceiver(SettingsManager.create(projectDir, agentDir)));

			for (const environment of [
				mocks.spawnSync.mock.calls[0][2].env,
				execve.mock.calls[0][2],
			] as NodeJS.ProcessEnv[]) {
				expect(environment.PRIME_AGENT_TELEMETRY).toBe("0");
				expect(environment[INSTALLATION_TELEMETRY_CONTEXT_ENV]).toBeUndefined();
			}
			expect(mocks.events).toEqual([]);
			expect(readInstallationTelemetryState(agentDir)).toHaveLength(0);
			expect(mocks.launchCoordinator).toHaveBeenCalledOnce();
			expect(execve).toHaveBeenCalledOnce();
		},
	);

	it("does not emit restart or readiness for a child reporting no installation change", async () => {
		mocks.spawnSync.mockReturnValue({ status: SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE, signal: null });
		const receiver = interactiveReceiver(SettingsManager.create(projectDir, agentDir));

		const execve = await runInteractiveUpdate(receiver);

		expect(stages()).toEqual(["started:started"]);
		expect(execve).not.toHaveBeenCalled();
		expect(mocks.launchCoordinator).not.toHaveBeenCalled();
		expect(receiver.handleReloadCommand).toHaveBeenCalledOnce();
		expect(receiver.ui.start).toHaveBeenCalledOnce();
	});

	it("reports a failed updater spawn while preserving relaunch of the current installation", async () => {
		mocks.spawnSync.mockReturnValue({
			status: null,
			signal: null,
			error: Object.assign(new Error("spawn /private/credential-path failed"), { code: "ENOENT" }),
		});

		const execve = await runInteractiveUpdate(interactiveReceiver(SettingsManager.create(projectDir, agentDir)));

		expect(stages()).toEqual(["started:started", "package_install:failed", "completed:failed", "relaunch:started"]);
		expect(mocks.launchCoordinator).not.toHaveBeenCalled();
		expect(execve).toHaveBeenCalledOnce();
		expect(JSON.stringify(mocks.events)).not.toContain("credential-path");
	});
});
