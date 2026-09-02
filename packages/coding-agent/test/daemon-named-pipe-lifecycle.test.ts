import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { windowsNamedPipeUserScope } from "../src/modes/daemon/daemon-socket.js";

const cliPath = resolve(__dirname, "../src/cli.ts");

// Exercises the full supervisor→worker handshake: daemon start → client
// connect/hello → session create (worker spawn → socket/named-pipe connect →
// hello → auth → ready) → list → shutdown → process exit. On win32 both the
// daemon and its session workers communicate over named pipes; elsewhere they
// use unix sockets, so the test runs on every platform.

const tempDirs: string[] = [];
const children: ChildProcess[] = [];
const workerPids = new Set<number>();
const childDiagnostics = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

/** Unique per-run socket: a named pipe on win32, a unix socket under the temp dir elsewhere. */
function uniqueSocketPath(root: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\prime-agent-lifecycle-${windowsNamedPipeUserScope()}-${process.pid}-${Date.now()}`;
	}
	return join(root, `daemon-lifecycle-${process.pid}.sock`);
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolveExit, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for process exit")), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolveExit();
		});
	});
}

/** Best-effort process-tree kill: taskkill on win32, process group SIGTERM elsewhere. */
async function killProcessTree(pid: number): Promise<void> {
	if (process.platform === "win32") {
		await new Promise<void>((resolveKill) => {
			const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.once("error", () => resolveKill());
			killer.once("exit", () => resolveKill());
		});
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	}
}

async function connectDaemon(
	client: DaemonClient,
	daemon: ChildProcess,
	socketPath: string,
	deadline: number,
): Promise<void> {
	while (Date.now() < deadline) {
		if (daemon.exitCode !== null || daemon.signalCode !== null) {
			const diag = childDiagnostics.get(daemon);
			throw new Error(
				`Daemon exited during startup (code ${daemon.exitCode}, signal ${daemon.signalCode})\n` +
					`stdout:\n${diag?.stdout ?? ""}\nstderr:\n${diag?.stderr ?? ""}`,
			);
		}
		try {
			await client.connect(3_000);
			await client.waitForHello(5_000);
			return;
		} catch {
			client.close();
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
		}
	}
	throw new Error(`Timed out connecting to daemon at ${socketPath}`);
}

describe("daemon lifecycle through the supervisor-worker handshake", () => {
	it("starts a daemon, creates a session through the worker pipe handshake, and shuts down", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-daemon-lifecycle-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		const cwd = join(root, "cwd");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const socketPath = uniqueSocketPath(root);

		// 1. Start a real daemon supervisor.
		const daemon = spawn(
			process.execPath,
			[cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
			{
				cwd,
				env: {
					...process.env,
					PI_OFFLINE: "1",
					[ENV_AGENT_DIR]: agentDir,
				},
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
				windowsHide: process.platform === "win32",
			},
		);
		children.push(daemon);
		const diag = { stdout: "", stderr: "" };
		childDiagnostics.set(daemon, diag);
		daemon.stdout?.on("data", (chunk: Buffer) => (diag.stdout += chunk.toString("utf8")));
		daemon.stderr?.on("data", (chunk: Buffer) => (diag.stderr += chunk.toString("utf8")));
		const daemonExited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
			daemon.once("exit", (code, signal) => resolveExit({ code, signal })),
		);

		const client = new DaemonClient(socketPath);
		try {
			// 2. Connect and receive the daemon hello over the socket/named pipe.
			await connectDaemon(client, daemon, socketPath, Date.now() + 60_000);
			expect(client.hello?.type).toBe("daemon_hello");

			// 3. Create a session. The supervisor spawns a worker that opens its
			//    own socket/named pipe and completes connect → hello → auth.
			const created = await client.request(
				{
					type: "create",
					config: { cwd, agentDir, sessionDir, noTools: true, noExtensions: true },
				},
				120_000,
			);
			expect(created.success).toBe(true);
			if (!created.success) {
				throw new Error(created.error);
			}
			const summary = created.data as { activeSessionId?: string; id?: string; workerPid?: number } | undefined;
			expect(summary).toBeTruthy();
			const activeSessionId = summary?.activeSessionId ?? summary?.id;
			expect(activeSessionId).toBeTruthy();
			if (summary?.workerPid) {
				workerPids.add(summary.workerPid);
			}

			// 4. List sessions and confirm the created session is visible.
			const listed = await client.request({ type: "list" }, 15_000);
			expect(listed.success).toBe(true);
			if (!listed.success) {
				throw new Error(listed.error);
			}
			const sessions =
				(listed.data as { sessions?: Array<{ id?: string; activeSessionId?: string }> }).sessions ?? [];
			expect(
				sessions.some((session) => session.id === activeSessionId || session.activeSessionId === activeSessionId),
			).toBe(true);

			// 5. Shut the daemon down gracefully.
			const shutdown = await client.request({ type: "shutdown" }, 20_000);
			expect(shutdown.success).toBe(true);
		} finally {
			client.close();
		}

		// 6. The daemon process exits cleanly after shutdown.
		const exit = await Promise.race([
			daemonExited,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("Daemon did not exit within 15s after shutdown")), 15_000),
			),
		]);
		expect(exit.signal).toBeNull();
		expect(exit.code).toBe(0);
	}, 240_000);
});

afterEach(async () => {
	for (const child of children) {
		if (child.pid && child.exitCode === null && child.signalCode === null) {
			await killProcessTree(child.pid);
		}
	}
	await Promise.all([...children].map((child) => waitForExit(child).catch(() => undefined)));
	for (const pid of workerPids) {
		await killProcessTree(pid).catch(() => undefined);
	}
	children.length = 0;
	workerPids.clear();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
