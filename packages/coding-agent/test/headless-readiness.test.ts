import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { AgentAutonomousStatus } from "../src/core/autonomous.js";
import { runAcpModeWithConnection } from "../src/modes/acp/acp-mode.js";
import type { AgentConnection } from "../src/modes/agent-connection/types.js";
import { runPrintModeWithConnection } from "../src/modes/print-mode.js";
import { runRpcModeWithConnection } from "../src/modes/rpc/rpc-mode.js";

const output = vi.hoisted(() => ({ write: vi.fn(), flush: vi.fn(async () => {}) }));
vi.mock("../src/core/output-guard.js", () => ({
	takeOverStdout: vi.fn(),
	writeRawStdout: output.write,
	flushRawStdout: output.flush,
}));
vi.mock("../src/utils/shell.js", () => ({ killTrackedDetachedChildren: vi.fn() }));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function fakeConnection() {
	const status: AgentAutonomousStatus = {
		enabled: false,
		continuationsUsed: 0,
		turnsUsed: 0,
		tokensUsed: 0,
		limits: { maxContinuations: 0, maxTurns: 0, maxTokens: 0, timeoutMs: 0 },
		gates: { commands: [], maxRetries: 0, timeoutMs: 0 },
		gateAttempts: {},
	};
	return {
		subscribe: vi.fn(() => () => {}),
		dispose: vi.fn(async () => {}),
		getSessionHeader: vi.fn(async () => undefined),
		getMessages: vi.fn(async () => []),
		getAvailableModels: vi.fn(async () => []),
		promptAndWait: vi.fn(async () => {}),
		waitForIdle: vi.fn(async () => {}),
		waitForHeadlessCompletion: vi.fn(async () => status),
	};
}

let stdin: PassThrough;
let exit: MockInstance<typeof process.exit>;

beforeEach(() => {
	vi.clearAllMocks();
	stdin = new PassThrough();
	vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
	exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});

afterEach(() => {
	stdin.destroy();
	vi.restoreAllMocks();
});

describe("headless readiness lifecycle", () => {
	it.each(["rpc", "acp"])(
		"serves %s while readiness work is pending and waits on stdin EOF before exiting",
		async (mode) => {
			const ready = deferred();
			const fake = fakeConnection();
			const connection = fake as unknown as AgentConnection;
			const onReady = vi.fn(() => ready.promise);
			const run =
				mode === "rpc"
					? runRpcModeWithConnection(connection, { onReady })
					: runAcpModeWithConnection(connection, { onReady });
			void run;
			expect(onReady).toHaveBeenCalledOnce();
			stdin.write(
				mode === "rpc"
					? `${JSON.stringify({ id: "ready-check", type: "get_available_models" })}\n`
					: `${JSON.stringify({ jsonrpc: "2.0", id: "ready-check", method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
			);
			await vi.waitFor(() => expect(output.write).toHaveBeenCalled());
			expect(output.write.mock.calls.some(([line]) => String(line).includes("ready-check"))).toBe(true);
			expect(exit).not.toHaveBeenCalled();
			stdin.end();
			await vi.waitFor(() => expect(fake.dispose).toHaveBeenCalledOnce());
			expect(exit).not.toHaveBeenCalled();
			ready.resolve();
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
		},
	);

	it.each([
		{ mode: "rpc", failure: "throw" },
		{ mode: "rpc", failure: "reject" },
		{ mode: "acp", failure: "throw" },
		{ mode: "acp", failure: "reject" },
	])("preserves $mode EOF shutdown when readiness $failure fails", async ({ mode, failure }) => {
		const fake = fakeConnection();
		const connection = fake as unknown as AgentConnection;
		const onReady = () => {
			if (failure === "throw") throw new Error("optional readiness failed");
			return Promise.reject(new Error("optional readiness failed"));
		};
		void (mode === "rpc"
			? runRpcModeWithConnection(connection, { onReady })
			: runAcpModeWithConnection(connection, { onReady }));
		stdin.end();
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
		expect(fake.dispose).toHaveBeenCalledOnce();
	});

	it("starts print prompts without waiting and finishes readiness before returning", async () => {
		const ready = deferred();
		const fake = fakeConnection();
		const onReady = vi.fn(() => ready.promise);
		let completed = false;
		const run = runPrintModeWithConnection(fake as unknown as AgentConnection, {
			mode: "text",
			initialMessage: "test prompt",
			onReady,
		}).then((result) => {
			completed = true;
			return result;
		});
		await vi.waitFor(() => expect(fake.promptAndWait).toHaveBeenCalledOnce());
		expect(fake.subscribe).toHaveBeenCalledBefore(onReady);
		expect(onReady).toHaveBeenCalledBefore(fake.promptAndWait);
		expect(fake.dispose).toHaveBeenCalledOnce();
		expect(completed).toBe(false);
		ready.resolve();
		await expect(run).resolves.toBe(0);
		expect(exit).not.toHaveBeenCalled();
	});

	it.each(["throw", "reject"])("preserves print success when readiness %s fails", async (failure) => {
		const fake = fakeConnection();
		await expect(
			runPrintModeWithConnection(fake as unknown as AgentConnection, {
				mode: "text",
				initialMessage: "test prompt",
				onReady: () => {
					if (failure === "throw") throw new Error("optional readiness failed");
					return Promise.reject(new Error("optional readiness failed"));
				},
			}),
		).resolves.toBe(0);
		expect(fake.promptAndWait).toHaveBeenCalledOnce();
		expect(fake.dispose).toHaveBeenCalledOnce();
	});

	it("waits for readiness before a controlled print signal exit", async () => {
		const ready = deferred();
		const prompt = deferred();
		const fake = fakeConnection();
		fake.promptAndWait.mockImplementation(() => prompt.promise);
		const original = new Set(process.listeners("SIGTERM"));
		const run = runPrintModeWithConnection(fake as unknown as AgentConnection, {
			mode: "text",
			initialMessage: "test prompt",
			onReady: () => ready.promise,
		});
		await vi.waitFor(() => expect(fake.promptAndWait).toHaveBeenCalledOnce());
		const signal = process.listeners("SIGTERM").find((listener) => !original.has(listener));
		expect(signal).toBeDefined();
		signal?.("SIGTERM");
		await vi.waitFor(() => expect(fake.dispose).toHaveBeenCalledOnce());
		expect(exit).not.toHaveBeenCalled();
		ready.resolve();
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
		prompt.resolve();
		await run;
	});

	it("does not start print readiness when mode initialization fails", async () => {
		const fake = fakeConnection();
		fake.getSessionHeader.mockRejectedValue(new Error("header unavailable"));
		const onReady = vi.fn(async () => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			runPrintModeWithConnection(fake as unknown as AgentConnection, { mode: "json", onReady }),
		).resolves.toBe(1);
		expect(onReady).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith("header unavailable");
		expect(fake.dispose).toHaveBeenCalledOnce();
	});
});
