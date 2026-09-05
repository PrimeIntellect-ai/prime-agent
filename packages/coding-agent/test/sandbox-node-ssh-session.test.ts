import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type NodeSshSessionDependencies, startNodeSshSession } from "../src/core/sandbox-node-ssh-session.js";

class FakeChild extends EventEmitter {
	readonly pid = 4321;
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
}

function request(): Readonly<Record<string, unknown>> {
	return {
		sandboxId: "sb-123",
		remoteExecutable: "/opt/prime-agent/wrapper",
		homeCwd: "/tmp",
		readyNonce: "0123456789abcdef0123456789abcdef",
		homeEnv: { PATH: "/usr/bin", HOME: "/tmp/home", USER: "agent", TMPDIR: "/tmp" },
	};
}

function timeouts(): Readonly<Record<string, number>> {
	return {
		readyTimeoutMs: 50,
		admissionTimeoutMs: 50,
		sigintTimeoutMs: 10,
		sigtermTimeoutMs: 10,
		sigkillTimeoutMs: 10,
		closeConfirmTimeoutMs: 20,
	};
}

interface StartHarness {
	readonly child: FakeChild;
	readonly calls: Array<Readonly<{ command: string; args: readonly string[]; options: SpawnOptions }>>;
	readonly signals: Array<Readonly<{ pid: number; signal: string }>>;
	readonly dependencies: NodeSshSessionDependencies;
}

function harness(closeOnSignal = true): StartHarness {
	const child = new FakeChild();
	const calls: Array<Readonly<{ command: string; args: readonly string[]; options: SpawnOptions }>> = [];
	const signals: Array<Readonly<{ pid: number; signal: string }>> = [];
	const dependencies: NodeSshSessionDependencies = {
		spawn: (command, args, options) => {
			calls.push({ command, args: [...args], options });
			return child as unknown as ChildProcessWithoutNullStreams;
		},
		signal: (pid, signal) => {
			signals.push({ pid, signal });
			if (closeOnSignal) {
				child.emit("exit", null, signal);
				child.emit("close");
			}
			return true;
		},
	};
	return { child, calls, signals, dependencies };
}

async function start(
	h: StartHarness,
	confirmRelayAdmission: () => unknown = () => Promise.resolve(Object.freeze({ status: "admitted" })),
) {
	return await startNodeSshSession(
		{ spawnRequest: request(), confirmRelayAdmission, timeouts: timeouts() },
		h.dependencies,
	);
}

describe("Node SSH session adapter", () => {
	it("spawns the exact fixed SSH argv and exposes composed capabilities", async () => {
		const h = harness();
		const result = await start(h);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0].command).toBe("prime");
		expect(h.calls[0].args).toEqual([
			"sandbox",
			"ssh",
			"--plain",
			"sb-123",
			"--",
			"/opt/prime-agent/wrapper",
			"--prime-agent-fd3-bootstrap",
			"--ready-nonce",
			"0123456789abcdef0123456789abcdef",
		]);
		expect(h.calls[0].options).toMatchObject({
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			detached: true,
			cwd: "/tmp",
		});
		expect(Object.keys(h.calls[0].options.env ?? {}).sort()).toEqual(["HOME", "PATH", "TMPDIR", "USER"]);
		expect(result.credentialWritable).toBeDefined();
		await result.monitor.close();
	});

	it("accepts readiness only after relay admission", async () => {
		const h = harness();
		let admissions = 0;
		const result = await start(h, () => {
			admissions += 1;
			return Promise.resolve(Object.freeze({ status: "admitted" }));
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		h.child.stdout.emit("data", Buffer.from("PRIME_AGENT_READY 0123456789abcdef0123456789abcdef 777\n"));
		expect(await result.monitor.ready).toEqual({ ok: true, pid: 777 });
		expect(admissions).toBe(1);
		await result.monitor.close();
	});

	it("copies stdout without erasing or retaining the Node Buffer", async () => {
		const h = harness();
		const result = await start(h);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const source = Buffer.from("PRIME_AGENT_READY 0123456789abcdef0123456789abcdef 88\n");
		const original = Buffer.from(source);
		h.child.stdout.emit("data", source);
		expect(await result.monitor.ready).toEqual({ ok: true, pid: 88 });
		expect(source).toEqual(original);
		await result.monitor.close();
	});

	it("turns stderr into fail-closed cleanup without retaining its bytes", async () => {
		const h = harness();
		const result = await start(h);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const secret = Buffer.from("remote secret detail");
		const original = Buffer.from(secret);
		h.child.stderr.emit("data", secret);
		const ready = await result.monitor.ready;
		expect(ready).toMatchObject({ ok: false, code: "STDERR" });
		expect(secret).toEqual(original);
		expect(h.signals[0]).toEqual({ pid: -4321, signal: "SIGINT" });
	});

	it("never signals after an observed exit", async () => {
		const h = harness();
		const result = await start(h);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		h.child.emit("exit", 1, null);
		h.child.emit("close");
		expect(await result.monitor.ready).toMatchObject({ ok: false, code: "EXIT" });
		expect(h.signals).toEqual([]);
		expect(h.child.stdin.destroyed).toBe(true);
		expect(h.child.stdout.destroyed).toBe(true);
		expect(h.child.stderr.destroyed).toBe(true);
	});

	it("destroys stdio after bounded final uncertainty", async () => {
		const h = harness(false);
		const result = await start(h);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const closed = await result.monitor.close();
		expect(closed).toEqual({ ok: false, code: "CLEANUP_UNCONFIRMED", cleanupConfirmed: false });
		expect(h.signals.map(({ signal }) => signal)).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
		expect(h.child.stdin.destroyed).toBe(true);
		expect(h.child.stdout.destroyed).toBe(true);
		expect(h.child.stderr.destroyed).toBe(true);
	});

	it("removes its exact event listeners during checked cleanup", async () => {
		const h = harness();
		const result = await start(h);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(h.child.listenerCount("exit")).toBe(1);
		const closing = result.monitor.close();
		expect((await closing).ok).toBe(true);
		expect(h.child.listenerCount("exit")).toBe(0);
		expect(h.child.stdout.listenerCount("data")).toBe(0);
		expect(h.child.stderr.listenerCount("data")).toBe(0);
	});

	it("rejects invalid input without spawning", async () => {
		const h = harness();
		const result = await startNodeSshSession(
			{
				spawnRequest: request(),
				confirmRelayAdmission: () => Promise.resolve({ status: "admitted" }),
				timeouts: { ...timeouts(), extra: 1 },
			},
			h.dependencies,
		);
		expect(result).toEqual({ ok: false, code: "INVALID_INPUT", cleanupConfirmed: true });
		expect(h.calls).toHaveLength(0);
	});

	it("reports synchronous spawn failure without fabricating cleanup", async () => {
		const dependencies: NodeSshSessionDependencies = {
			spawn: () => {
				throw new Error("spawn failed");
			},
			signal: () => true,
		};
		const result = await startNodeSshSession(
			{
				spawnRequest: request(),
				confirmRelayAdmission: () => Promise.resolve({ status: "admitted" }),
				timeouts: timeouts(),
			},
			dependencies,
		);
		expect(result).toEqual({ ok: false, code: "SPAWN_FAILED", cleanupConfirmed: true });
	});

	it("signals an invalid spawned child once and reports cleanup uncertainty", async () => {
		const signals: Array<Readonly<{ pid: number; signal: string }>> = [];
		const dependencies = {
			spawn: () => ({ pid: 54 }) as ChildProcessWithoutNullStreams,
			signal: (pid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL") => {
				signals.push({ pid, signal });
				return true;
			},
		};
		const result = await startNodeSshSession(
			{
				spawnRequest: request(),
				confirmRelayAdmission: () => Promise.resolve({ status: "admitted" }),
				timeouts: timeouts(),
			},
			dependencies,
		);
		expect(result).toEqual({ ok: false, code: "INVALID_CHILD", cleanupConfirmed: false });
		expect(signals).toEqual([{ pid: -54, signal: "SIGKILL" }]);
	});

	it("rejects aliased child streams and signals the process group once", async () => {
		const events = new EventEmitter();
		const shared = new PassThrough();
		const stderr = new PassThrough();
		const signals: number[] = [];
		const child = {
			pid: 92,
			stdin: shared,
			stdout: shared,
			stderr,
			on: events.on.bind(events),
			off: events.off.bind(events),
		};
		const dependencies = {
			spawn: () => child as unknown as ChildProcessWithoutNullStreams,
			signal: (pid: number) => {
				signals.push(pid);
				return true;
			},
		};
		const result = await startNodeSshSession(
			{
				spawnRequest: request(),
				confirmRelayAdmission: () => Promise.resolve({ status: "admitted" }),
				timeouts: timeouts(),
			},
			dependencies,
		);
		expect(result).toEqual({ ok: false, code: "INVALID_CHILD", cleanupConfirmed: false });
		expect(signals).toEqual([-92]);
	});

	it("uses a fresh argv and environment snapshot", async () => {
		const h = harness();
		const rawRequest = request() as Record<string, unknown>;
		const result = await startNodeSshSession(
			{
				spawnRequest: rawRequest,
				confirmRelayAdmission: () => Promise.resolve(Object.freeze({ status: "admitted" })),
				timeouts: timeouts(),
			},
			h.dependencies,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		(rawRequest.homeEnv as Record<string, string>).PATH = "/changed";
		expect(h.calls[0].options.env?.PATH).toBe("/usr/bin");
		expect(h.calls[0].args[3]).toBe("sb-123");
		await result.monitor.close();
	});
});
