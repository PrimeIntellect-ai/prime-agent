import type * as ChildProcessModule from "child_process";
import { describe, expect, it, vi } from "vitest";
import type * as DaemonUpdateRestartModule from "../src/cli/daemon-update-restart.js";

const updateMocks = vi.hoisted(() => ({
	spawnSync: vi.fn(),
	launchCoordinator: vi.fn(),
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
	buildUpdateChildArgs,
	buildUpdateRelaunchArgs,
	InteractiveMode,
	resolveInteractiveUpdateDaemonSocketPath,
	tryExecUpdateRelaunch,
	updateArgsIncludeSelf,
} from "../src/modes/interactive/interactive-mode.js";

describe("buildUpdateRelaunchArgs", () => {
	it("relaunches the current session with the supported resume flag", () => {
		expect(buildUpdateRelaunchArgs(["--model", "gpt-5"], "/tmp/session.jsonl")).toEqual([
			"--model",
			"gpt-5",
			"--resume",
			"/tmp/session.jsonl",
		]);
	});

	it("keeps an existing resume selection", () => {
		expect(buildUpdateRelaunchArgs(["--resume", "/tmp/other.jsonl"], "/tmp/session.jsonl")).toEqual([
			"--resume",
			"/tmp/other.jsonl",
		]);
	});

	it("does not treat the unsupported session flag as an existing selection", () => {
		expect(buildUpdateRelaunchArgs(["--session", "/tmp/old.jsonl"], "/tmp/session.jsonl")).toEqual([
			"--session",
			"/tmp/old.jsonl",
			"--resume",
			"/tmp/session.jsonl",
		]);
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
				{ platform: "darwin", cwd: "/tmp/project", environment, chdir, execve },
			),
		).toBe(true);
		expect(chdir).toHaveBeenCalledWith("/tmp/project");
		expect(execve).toHaveBeenCalledWith(
			"/usr/bin/node",
			["/usr/bin/node", "--trace-warnings", "/opt/prime-agent/cli.js", "--resume", "session"],
			{ PRIME_AGENT_CODING_AGENT_DIR: "/tmp/agent" },
		);
	});

	it.each(["win32", "os400"])("keeps the compatible child relaunch on %s", (platform) => {
		const chdir = vi.fn();
		const execve = vi.fn(() => undefined as never);

		expect(
			tryExecUpdateRelaunch(
				{ command: "node", args: ["cli.js"] },
				{ platform, cwd: "/tmp/project", environment: {}, chdir, execve },
			),
		).toBe(false);
		expect(chdir).not.toHaveBeenCalled();
		expect(execve).not.toHaveBeenCalled();
	});

	it("keeps the compatible child relaunch when execve is unavailable", () => {
		expect(
			tryExecUpdateRelaunch(
				{ command: "/usr/bin/node", args: ["cli.js"] },
				{ platform: "linux", cwd: "/tmp/project", environment: {}, chdir: vi.fn() },
			),
		).toBe(false);
	});
});

describe("interactive self-update relaunch", () => {
	it.skipIf(process.platform === "win32")(
		"tears down and replaces the TUI process without waiting for a child TUI to quit",
		async () => {
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
			const execve = vi.fn((_file: string, _args: string[], _environment: NodeJS.ProcessEnv) => {
				events.push("execve");
				return undefined as never;
			});
			updateProcess.execve = execve;

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
				updateProcess.execve = originalExecve;
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
			expect(execve.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["--resume", "/tmp/session.jsonl"]));
		},
	);
});

describe("buildUpdateChildArgs", () => {
	it("passes the active custom socket to the deferred self-update child", () => {
		expect(buildUpdateChildArgs(["--self", "--force"], "/tmp/custom-daemon.sock")).toEqual([
			"--self",
			"--force",
			"--daemon-socket",
			"/tmp/custom-daemon.sock",
		]);
	});

	it("keeps an explicitly selected update socket", () => {
		expect(buildUpdateChildArgs(["--self", "--daemon-socket", "/tmp/explicit.sock"], "/tmp/active.sock")).toEqual([
			"--self",
			"--daemon-socket",
			"/tmp/explicit.sock",
		]);
		expect(
			resolveInteractiveUpdateDaemonSocketPath(
				["--self", "--daemon-socket", "/tmp/explicit.sock"],
				"/tmp/active.sock",
			),
		).toBe("/tmp/explicit.sock");
		expect(updateArgsIncludeSelf(["--daemon-socket", "/tmp/explicit.sock"])).toBe(true);
	});
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
