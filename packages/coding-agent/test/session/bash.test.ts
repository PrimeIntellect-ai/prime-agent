import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { BashResult } from "../../src/core/bash-executor.js";
import type { BashExecutionMessage } from "../../src/core/messages.js";
import { SessionBash, type SessionBashEvent, type SessionBashHost } from "../../src/session/tools/bash.js";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function result(output = "done"): BashResult {
	return { output, exitCode: 0, cancelled: false, truncated: false };
}

function createShell(overrides: Partial<SessionBashHost> = {}) {
	const events: SessionBashEvent[] = [];
	const messages: BashExecutionMessage[] = [];
	const onStateChange = vi.fn();
	const onUserBashEnd = vi.fn(async () => {});
	const host: SessionBashHost = {
		getCwd: () => "/workspace",
		getShellCommandPrefix: () => undefined,
		getShellPath: () => undefined,
		isStreaming: () => false,
		intercept: async () => undefined,
		emit: (event) => events.push(event),
		appendMessage: (message) => messages.push(message),
		onStateChange,
		onUserBashEnd,
		executeBash: (command, onChunk, options) => shell.executeBash(command, onChunk, options),
		recordBashResult: (command, outcome, options) => shell.recordBashResult(command, outcome, options),
		...overrides,
	};
	const shell = new SessionBash(host);
	return { shell, events, messages, onStateChange, onUserBashEnd };
}

describe("SessionBash", () => {
	it("reads current shell settings and cwd while recording the original command", async () => {
		let cwd = "/first";
		let prefix = "set -e";
		const { shell, messages } = createShell({ getCwd: () => cwd, getShellCommandPrefix: () => prefix });
		const calls: string[][] = [];
		const chunks: string[] = [];
		const options = {
			excludeFromContext: true,
			operations: {
				exec: vi.fn(async (command, directory, execution) => {
					calls.push([command, directory]);
					execution.onData(Buffer.from("output"));
					return { exitCode: 0 };
				}),
			},
		} satisfies Parameters<SessionBash["executeBash"]>[2];
		await shell.executeBash("first", (chunk) => chunks.push(chunk), options);
		cwd = "/second";
		prefix = "";
		await shell.executeBash("second", undefined, options);
		expect(calls).toEqual([
			["set -e\nfirst", "/first"],
			["second", "/second"],
		]);
		expect(chunks).toEqual(["output"]);
		expect(messages.map((message) => [message.command, message.excludeFromContext])).toEqual([
			["first", true],
			["second", true],
		]);
	});

	it("holds the user slot during interception and honours abort before execution", async () => {
		const gate = deferred();
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const { shell, events, messages } = createShell({
			intercept: async () => {
				await gate.promise;
				return { operations: { exec } };
			},
		});
		const run = shell.runUserBash("cancel me", { runId: "first" });
		expect(shell.isBashRunning).toBe(true);
		await expect(shell.runUserBash("second")).rejects.toThrow("already running");
		shell.abortBash();
		gate.resolve();
		await run;
		expect(exec).not.toHaveBeenCalled();
		expect(messages).toMatchObject([{ command: "cancel me", cancelled: true, output: "" }]);
		expect(events).toEqual([
			{ type: "bash_start", command: "cancel me", excludeFromContext: false, runId: "first" },
			{ type: "bash_end", exitCode: undefined, cancelled: true, truncated: false, runId: "first" },
		]);
		expect(shell.isBashRunning).toBe(false);
	});

	it("keeps an extension replacement result authoritative when abort arrives during interception", async () => {
		const gate = deferred();
		const exec = vi.fn(async () => ({ exitCode: 1 }));
		const replacement = { ...result("replacement"), truncated: true, fullOutputPath: "/output/complete" };
		const { shell, events, messages } = createShell({
			intercept: async () => {
				await gate.promise;
				return { result: replacement, operations: { exec } };
			},
		});
		const run = shell.runUserBash("intercepted");
		shell.abortBash();
		gate.resolve();
		await run;
		expect(exec).not.toHaveBeenCalled();
		expect(messages).toMatchObject([replacement]);
		expect(events.at(-1)).toMatchObject({
			type: "bash_end",
			cancelled: false,
			truncated: true,
			fullOutputPath: "/output/complete",
		});
	});

	it("releases the slot on interception failure without fabricating execution events", async () => {
		let fail = true;
		const { shell, events, messages, onStateChange, onUserBashEnd } = createShell({
			intercept: async () => {
				if (fail) throw new Error("dispatch failed");
				return { result: result() };
			},
		});
		await expect(shell.runUserBash("first")).rejects.toThrow("dispatch failed");
		expect(shell.isBashRunning).toBe(false);
		expect(onStateChange).toHaveBeenCalledOnce();
		expect(onUserBashEnd).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		expect(messages).toEqual([]);
		fail = false;
		await shell.runUserBash("second");
		expect(messages).toHaveLength(1);
	});

	it.each(["execution", "replacement", "failure"] as const)(
		"keeps transient %s output out of pending messages and persistence",
		async (mode) => {
			const { shell, events, messages } = createShell({
				isStreaming: () => true,
				intercept: async () =>
					mode === "replacement"
						? { result: result() }
						: {
								operations: {
									exec: async (_command, _cwd, options) => {
										if (mode === "failure") throw new Error("failed");
										options.onData(Buffer.from("transient"));
										return { exitCode: 0 };
									},
								},
							},
			});
			await shell.runUserBash("side command", { transient: true, runId: "side" });
			expect(events[0]).toMatchObject({ type: "bash_start", transient: true, runId: "side" });
			expect(events.at(-1)).toMatchObject({ type: "bash_end", transient: true, runId: "side" });
			expect(messages).toEqual([]);
			expect(shell.hasPendingBashMessages).toBe(false);
			shell.flushPendingMessages();
			expect(messages).toEqual([]);
		},
	);

	it("flushes deferred output in order only at the explicit flush boundary", () => {
		let streaming = true;
		const { shell, messages } = createShell({ isStreaming: () => streaming });
		shell.recordBashResult("first", result("one"));
		shell.recordBashResult("second", result("two"), { excludeFromContext: true });
		streaming = false;
		expect(messages).toEqual([]);
		expect(shell.hasPendingBashMessages).toBe(true);
		shell.flushPendingMessages();
		shell.flushPendingMessages();
		expect(messages.map((message) => message.command)).toEqual(["first", "second"]);
		expect(messages[1]?.excludeFromContext).toBe(true);
		expect(shell.hasPendingBashMessages).toBe(false);
	});

	it("allows a completion subscriber to synchronously start another user command", async () => {
		const events: SessionBashEvent[] = [];
		let secondRun: Promise<void> | undefined;
		const { shell, messages } = createShell({
			intercept: async (event) => ({ result: result(event.command) }),
			emit: (event) => {
				events.push(event);
				if (event.type === "bash_end" && event.runId === "first") {
					expect(shell.isBashRunning).toBe(false);
					secondRun = shell.runUserBash("second", { runId: "second" });
				}
			},
		});
		await shell.runUserBash("first", { runId: "first" });
		await secondRun;
		expect(messages.map((message) => message.command)).toEqual(["first", "second"]);
		expect(events.filter((event) => event.type === "bash_end").map((event) => event.runId)).toEqual([
			"first",
			"second",
		]);
		expect(shell.isBashRunning).toBe(false);
	});
});
