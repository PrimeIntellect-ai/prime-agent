import { describe, expect, it, vi } from "vitest";
import { executeMcpDeclarationCommand, parseMcpDeclarationCommand } from "../src/core/mcp/mcp-declaration-command.js";
import {
	type McpProbeSession,
	type McpProbeTransport,
	previewMcpDeclarationProbe,
	runMcpDeclarationProbe,
} from "../src/core/mcp/mcp-probe.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const declaration = { name: "catalog", url: "https://catalog.test/mcp", enabled: true };

describe("MCP declaration probe contract", () => {
	it("returns a bounded offline declaration preview", () => {
		expect(previewMcpDeclarationProbe(declaration)).toEqual({
			url: "https://catalog.test/mcp",
			method: "POST",
			redirect: "error",
			requestKind: "mcp-initialize",
		});
	});

	it("never calls a legacy injected transport when the declaration command is probed", async () => {
		const settings = SettingsManager.inMemory();
		settings.setMcpDeclarationDocument("user", { version: 1, servers: { catalog: declaration } });
		let opens = 0;
		const executeWithLegacyExtra = executeMcpDeclarationCommand as unknown as (
			command: ReturnType<typeof parseMcpDeclarationCommand>,
			settings: SettingsManager,
			admission: undefined,
			legacyOptions: { probeTransport: { open(): unknown } },
		) => Promise<unknown>;

		await expect(
			executeWithLegacyExtra(parseMcpDeclarationCommand(["test", "catalog"]), settings, undefined, {
				probeTransport: {
					open() {
						opens++;
						throw new Error("transport must remain unreachable");
					},
				},
			}),
		).resolves.toEqual(previewMcpDeclarationProbe(declaration));
		expect(opens).toBe(0);
	});
});

function fakeTransport(calls: string[], overrides: Partial<McpProbeSession> = {}): McpProbeTransport {
	return {
		async open({ url }) {
			calls.push(`open:${url}`);
			return {
				async request(request) {
					calls.push(request.method);
				},
				async close() {
					calls.push("close");
				},
				...overrides,
			};
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("MCP injected probe execution boundary", () => {
	it("uses only initialize then tools/list and always closes the injected session", async () => {
		const calls: string[] = [];
		await expect(runMcpDeclarationProbe(declaration, fakeTransport(calls), { trusted: true })).resolves.toEqual({
			initialized: true,
			toolsListed: true,
		});
		expect(calls).toEqual(["open:https://catalog.test/mcp", "initialize", "tools/list", "close"]);
		expect(calls.join(" ")).not.toContain("tools/call");
	});

	it.each([
		["disabled", { ...declaration, enabled: false }, { trusted: true }, "disabled"],
		["offline", declaration, { trusted: true, offline: true }, "offline"],
		["untrusted", declaration, {}, "not trusted"],
	] as const)("blocks %s before opening a transport", async (_name, input, options, message) => {
		const calls: string[] = [];
		await expect(runMcpDeclarationProbe(input, fakeTransport(calls), options)).rejects.toThrow(message);
		expect(calls).toEqual([]);
	});

	it("redacts injected transport failures and closes the session", async () => {
		const calls: string[] = [];
		const transport = fakeTransport(calls, {
			async request(request) {
				calls.push(request.method);
				throw new Error("https://alice:secret@catalog.test/mcp?token=secret");
			},
		});
		await expect(runMcpDeclarationProbe(declaration, transport, { trusted: true })).rejects.toThrow(
			"MCP probe failed.",
		);
		expect(calls).toEqual(["open:https://catalog.test/mcp", "initialize", "close"]);
	});

	it("reports a redacted cleanup failure after a successful handshake", async () => {
		const calls: string[] = [];
		const transport = fakeTransport(calls, {
			async close() {
				calls.push("close");
				throw new Error("https://alice:secret@catalog.test/mcp?token=secret");
			},
		});
		await expect(runMcpDeclarationProbe(declaration, transport, { trusted: true })).rejects.toThrow(
			"MCP probe failed.",
		);
		expect(calls).toEqual(["open:https://catalog.test/mcp", "initialize", "tools/list", "close"]);
	});

	it("closes a transport session that resolves after the operation deadline", async () => {
		const lateOpen = deferred<McpProbeSession>();
		let closeCalls = 0;
		let abortListeners = 0;
		const transport: McpProbeTransport = {
			open({ signal }) {
				signal.addEventListener("abort", () => {
					abortListeners++;
				});
				return lateOpen.promise;
			},
		};
		await expect(runMcpDeclarationProbe(declaration, transport, { trusted: true, timeoutMs: 10 })).rejects.toThrow(
			"MCP probe timed out.",
		);
		expect(abortListeners).toBe(1);
		lateOpen.resolve({
			request: async () => undefined,
			close: async () => {
				closeCalls++;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(closeCalls).toBe(1);
	});

	it("reports late close failures without revealing transport data", async () => {
		const lateOpen = deferred<McpProbeSession>();
		const reported: Error[] = [];
		const transport: McpProbeTransport = { open: () => lateOpen.promise };
		await expect(
			runMcpDeclarationProbe(declaration, transport, {
				trusted: true,
				timeoutMs: 10,
				onLateCleanupFailure: (error) => reported.push(error),
			}),
		).rejects.toThrow("MCP probe timed out.");
		lateOpen.resolve({
			request: async () => undefined,
			close: async () => {
				throw new Error("https://alice:secret@catalog.test/mcp?token=secret");
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(reported.map((error) => error.message)).toEqual(["MCP probe failed."]);
	});

	it("keeps fractional positive timeout budgets above zero", async () => {
		const calls: string[] = [];
		const delays: number[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: (...args: unknown[]) => void,
			delay?: number,
			...args: unknown[]
		) => {
			delays.push(Number(delay));
			return originalSetTimeout(callback, delay, ...args);
		}) as typeof setTimeout);
		try {
			await expect(
				runMcpDeclarationProbe(declaration, fakeTransport(calls), { trusted: true, timeoutMs: 0.5 }),
			).resolves.toEqual({ initialized: true, toolsListed: true });
			expect(delays).toContain(1);
			expect(delays).not.toContain(0);
		} finally {
			timerSpy.mockRestore();
		}
	});

	it("does not retain deadline listeners or timers after a completed probe", async () => {
		const calls: string[] = [];
		await runMcpDeclarationProbe(declaration, fakeTransport(calls), { trusted: true, timeoutMs: 10 });
		await new Promise((resolve) => setTimeout(resolve, 15));
		expect(calls).toEqual(["open:https://catalog.test/mcp", "initialize", "tools/list", "close"]);
	});
});
