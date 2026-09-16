import type * as ChildProcessModule from "child_process";
import { describe, expect, it, vi } from "vitest";
import type * as DaemonUpdateRestartModule from "../src/cli/daemon-update-restart.js";
import type * as ConfigModule from "../src/config.js";

const updateMocks = vi.hoisted(() => ({
	spawnSync: vi.fn(),
	launchCoordinator: vi.fn(),
	binary: false,
}));

vi.mock("../src/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof ConfigModule>()),
	get isBunBinary() {
		return updateMocks.binary;
	},
}));

vi.mock("../src/utils/native-installation.js", () => ({
	getNativeInstallation: () => (updateMocks.binary ? { launcher: "/tmp/managed/bin/prime-agent" } : undefined),
}));

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcessModule>()),
	spawnSync: updateMocks.spawnSync,
}));

vi.mock("../src/cli/daemon-update-restart.js", async (importOriginal) => ({
	...(await importOriginal<typeof DaemonUpdateRestartModule>()),
	launchDaemonUpdateRestartCoordinator: updateMocks.launchCoordinator,
}));

import { buildDaemonUpdateRestartReport } from "../src/cli/daemon-update-restart.js";
import {
	buildUpdateRelaunchArgs,
	InteractiveMode,
	tryExecUpdateRelaunch,
} from "../src/modes/interactive/interactive-mode.js";

describe("buildUpdateRelaunchArgs", () => {
	// [name, existing args, relaunch args] - the resumed session must survive the update.
	it.each([
		[
			"appends the supported resume flag",
			["--model", "gpt-5"],
			["--model", "gpt-5", "--resume", "/tmp/session.jsonl"],
		],
		["keeps an existing resume selection", ["--resume", "/tmp/other.jsonl"], ["--resume", "/tmp/other.jsonl"]],
		[
			"ignores the unsupported session flag as a selection",
			["--session", "/tmp/old.jsonl"],
			["--session", "/tmp/old.jsonl", "--resume", "/tmp/session.jsonl"],
		],
	])("%s", (_name, args, expected) => {
		expect(buildUpdateRelaunchArgs(args, "/tmp/session.jsonl")).toEqual(expected);
	});
});

describe("tryExecUpdateRelaunch", () => {
	it("replaces the current process while preserving argv zero and the environment", () => {
		const environment = { PRIME_AGENT_CODING_AGENT_DIR: "/tmp/agent", OMITTED: undefined };
		const chdir = vi.fn();
		const execve = vi.fn(() => undefined as never);

		expect(
			tryExecUpdateRelaunch(
				{ command: "/usr/bin/node", args: ["--trace-warnings", "/opt/prime-agent/cli.js", "--resume", "session"] },
				{
					platform: "darwin",
					nodeVersion: "26.1.0",
					cwd: "/tmp/project",
					previousCwd: "/tmp/before",
					environment,
					chdir,
					execve,
				},
			),
		).toBe(true);
		expect(chdir).toHaveBeenCalledWith("/tmp/project");
		expect(execve).toHaveBeenCalledWith(
			"/usr/bin/node",
			["/usr/bin/node", "--trace-warnings", "/opt/prime-agent/cli.js", "--resume", "session"],
			{ PRIME_AGENT_CODING_AGENT_DIR: "/tmp/agent" },
		);

		// A thrown execve restores the previous cwd before the fallback runs.
		execve.mockImplementationOnce(() => {
			throw new Error("execve failed");
		});
		expect(() =>
			tryExecUpdateRelaunch(
				{ command: "/usr/bin/node", args: ["cli.js"] },
				{
					platform: "darwin",
					nodeVersion: "26.1.0",
					cwd: "/tmp/project",
					previousCwd: "/tmp/before",
					environment,
					chdir,
					execve,
				},
			),
		).toThrow("execve failed");
		expect(chdir).toHaveBeenLastCalledWith("/tmp/before");
	});

	// The compatible child relaunch must stay in place wherever in-place execve is
	// unsupported: other platforms, Node versions that abort on execve failure, and
	// runtimes without execve at all.
	it.each([
		["win32", "26.1.0", true],
		["os400", "26.1.0", true],
		["linux", "22.22.0", true],
		["linux", "24.13.0", true],
		["linux", "25.8.1", true],
		["linux", "26.0.0", true],
		["linux", "26.1.0", false],
	])(
		"keeps the compatible child relaunch on %s node %s (execve available: %s)",
		(platform, nodeVersion, hasExecve) => {
			const chdir = vi.fn();
			const execve = vi.fn(() => undefined as never);

			expect(
				tryExecUpdateRelaunch(
					{ command: "/usr/bin/node", args: ["cli.js"] },
					{
						platform,
						nodeVersion,
						cwd: "/tmp/project",
						previousCwd: "/tmp/before",
						environment: {},
						chdir,
						execve: hasExecve ? execve : undefined,
					},
				),
			).toBe(false);
			expect(chdir).not.toHaveBeenCalled();
			expect(execve).not.toHaveBeenCalled();
		},
	);
});

describe("interactive self-update relaunch", () => {
	it.skipIf(process.platform === "win32").each([false, true])(
		"tears down and relaunches the TUI with the activated application (compiled: %s)",
		async (binary) => {
			updateMocks.binary = binary;
			const events: string[] = [];
			updateMocks.spawnSync.mockReset();
			updateMocks.spawnSync.mockImplementation(() => {
				events.push("update");
				return { status: 0, signal: null } as never;
			});
			updateMocks.launchCoordinator.mockReset();
			updateMocks.launchCoordinator.mockImplementation(async () => {
				events.push("coordinator");
				return {
					version: 1,
					requestId: "test-request",
					socketPath: "/tmp/update.sock",
					phase: "complete",
					coordinator: { pid: process.pid },
					counts: { total: 0, restored: 0, resumed: 0, failed: 0 },
					failures: [],
					startedAt: "2026-08-21T00:00:00.000Z",
					updatedAt: "2026-08-21T00:00:01.000Z",
				};
			});

			const updateProcess = process as NodeJS.Process & {
				execve?: (file: string, args: string[], environment: NodeJS.ProcessEnv) => never;
			};
			const originalExecve = updateProcess.execve;
			const originalNodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
			const execve = vi.fn((_file: string, _args: string[], _environment: NodeJS.ProcessEnv) => {
				events.push("execve");
				return undefined as never;
			});
			updateProcess.execve = execve;
			Object.defineProperty(process.versions, "node", { ...originalNodeVersion, value: "26.1.0" });

			const receiver = {
				connectionState: {
					activeSessionId: "active-session",
					sessionFile: "/tmp/session.jsonl",
				},
				fullscreenEnabled: false,
				options: {
					daemonSocketPath: "/tmp/update.sock",
					onShutdown: async () => events.push("shutdown"),
				},
				getCurrentCwd: () => process.cwd(),
				stopWorkingLoader: () => events.push("loader-stop"),
				stop: () => events.push("mode-stop"),
				ui: {
					terminal: { drainInput: async () => events.push("drain-input") },
					stop: () => events.push("ui-stop"),
				},
				agentConnection: {
					dispose: async () => events.push("connection-dispose"),
				},
			};
			const handleUpdateCommand = (
				InteractiveMode.prototype as unknown as {
					handleUpdateCommand(this: typeof receiver, args: string): Promise<void>;
				}
			).handleUpdateCommand;

			try {
				await handleUpdateCommand.call(receiver, "");
			} finally {
				updateMocks.binary = false;
				updateProcess.execve = originalExecve;
				if (originalNodeVersion) {
					Object.defineProperty(process.versions, "node", originalNodeVersion);
				}
			}

			expect(events).toEqual([
				"loader-stop",
				"drain-input",
				"ui-stop",
				"update",
				"mode-stop",
				"connection-dispose",
				"shutdown",
				"coordinator",
				"execve",
			]);
			expect(updateMocks.spawnSync).toHaveBeenCalledTimes(1);
			const updateArgs = updateMocks.spawnSync.mock.calls[0]?.[1];
			expect(updateArgs).toEqual(
				binary
					? ["update", "--daemon-socket", "/tmp/update.sock"]
					: [...process.execArgv, process.argv[1], "update", "--daemon-socket", "/tmp/update.sock"],
			);
			expect(execve.mock.calls[0]?.[0]).toBe(binary ? "/tmp/managed/bin/prime-agent" : process.execPath);
			expect(execve.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["--resume", "/tmp/session.jsonl"]));
		},
	);
});

describe("buildDaemonUpdateRestartReport", () => {
	it("reports recovery results when the daemon restart fails", () => {
		const report = buildDaemonUpdateRestartReport({
			version: 1,
			requestId: "test-request",
			socketPath: "/tmp/custom-daemon.sock",
			phase: "failed",
			coordinator: { pid: process.pid },
			counts: { total: 3, restored: 2, resumed: 1, failed: 1 },
			failures: [{ sessionFile: "/tmp/failed.jsonl", message: "create failed" }],
			message: "could not stop predecessor",
			startedAt: "2026-07-14T00:00:00.000Z",
			updatedAt: "2026-07-14T00:00:01.000Z",
		});

		expect(report.info).toEqual(["Restored 2 daemon sessions", "Resumed 1 interrupted session"]);
		expect(report.warnings).toEqual([
			"Updated, but could not restart the daemon (could not stop predecessor).",
			"1 daemon session could not be restored.",
			"Could not restore /tmp/failed.jsonl: create failed",
		]);
	});
});
