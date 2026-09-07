import type * as ChildProcessModule from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.js";
import { signalProcessGroupOrProcess } from "../src/utils/child-process.js";
import {
	captureWindowsProcessCreationTime,
	createWindowsProcessTreeSignal,
} from "../src/utils/windows-process-signal.js";

const calls = vi.hoisted(() => ({ spawn: vi.fn() }));
const actualChildProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcessModule;
vi.mock("node:child_process", () => ({ ...actualChildProcess, spawn: calls.spawn }));

const ffi = (
	Reflect.get(globalThis, "Bun") as {
		FFI: { dlopen: (...args: unknown[]) => unknown; ptr: (buffer: Uint32Array) => unknown };
	}
).FFI;
const platform = process.platform;
const creationTime = 134909123456789013n;
const handle = {};
let helper: EventEmitter & { unref: ReturnType<typeof vi.fn> };
let open: ReturnType<typeof vi.fn>;
let query: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
let unload: ReturnType<typeof vi.fn>;

beforeEach(() => {
	Object.defineProperty(process, "platform", { value: "win32" });
	helper = Object.assign(new EventEmitter(), { unref: vi.fn() });
	calls.spawn.mockReset().mockReturnValue(helper);
	open = vi.fn(() => handle);
	query = vi.fn((_handle, creation: Uint32Array) => {
		creation[0] = Number(creationTime & 0xffffffffn);
		creation[1] = Number(creationTime >> 32n);
		return true;
	});
	close = vi.fn(() => true);
	unload = vi.fn();
	vi.spyOn(ffi, "dlopen").mockReturnValue({
		symbols: { OpenProcess: open, GetProcessTimes: query, CloseHandle: close },
		close: unload,
	});
	vi.spyOn(ffi, "ptr").mockImplementation((buffer) => buffer);
});

afterEach(() => {
	Object.defineProperty(process, "platform", { value: platform });
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("Windows process identity capture", () => {
	it("preserves FILETIME precision and closes the single queried handle", () => {
		expect(captureWindowsProcessCreationTime(42)).toBe(creationTime.toString());
		expect(open).toHaveBeenCalledWith(0x1000, false, 42);
		expect(query.mock.calls[0]![0]).toBe(handle);
		expect(close.mock.calls).toEqual([[handle]]);
		expect(unload).toHaveBeenCalledTimes(1);
	});

	it("closes the pin if querying fails and does not close a denied handle", () => {
		query.mockReturnValueOnce(false);
		expect(() => captureWindowsProcessCreationTime(42)).toThrow("creation time");
		expect(close.mock.calls).toEqual([[handle]]);
		close.mockClear();
		open.mockReturnValueOnce(null);
		expect(() => captureWindowsProcessCreationTime(42)).toThrow("identity verification");
		expect(close).not.toHaveBeenCalled();
		expect(unload).toHaveBeenCalledTimes(2);
	});

	it("fails closed if releasing the capture handle fails", () => {
		close.mockReturnValueOnce(false);
		const failure = vi.fn();
		signalProcessGroupOrProcess(42, "SIGKILL", failure);
		expect(failure.mock.calls[0]![0].message).toContain("Cannot close");
		expect(calls.spawn).not.toHaveBeenCalled();
		expect(unload).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid IDs before opening native state", () => {
		for (const pid of [0, -1, 1.5, 0x100000000, Number.NaN]) {
			expect(() => captureWindowsProcessCreationTime(pid)).toThrow("Invalid process ID");
		}
		expect(open).not.toHaveBeenCalled();
	});

	it("passes the exact identity to canonical PowerShell without changing force policy", () => {
		for (const signal of ["SIGTERM", "SIGKILL"] as const) {
			const command = createWindowsProcessTreeSignal(42, signal);
			expect(command.command).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
			const script = Buffer.from(command.args.at(-1)!, "base64").toString("utf16le");
			expect(script).toContain(`'${creationTime}'`);
			expect(script).toContain("/PID $targetId /T");
			expect(script.includes("/F")).toBe(signal === "SIGKILL");
		}
	});
});

describe("Windows shared signal failures", () => {
	it("fails closed without throwing or spawning when the native adapter is unavailable", () => {
		vi.mocked(ffi.dlopen).mockImplementation(() => {
			throw new Error("adapter unavailable");
		});
		const failure = vi.fn();
		const kill = vi.spyOn(process, "kill");
		expect(() => signalProcessGroupOrProcess(42, "SIGTERM", failure)).not.toThrow();
		expect(failure.mock.calls[0]![0].message).toBe("adapter unavailable");
		expect(calls.spawn).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
	});

	it("reports synchronous spawn failure without a PID-only fallback", () => {
		calls.spawn.mockImplementationOnce(() => {
			throw new Error("helper blocked");
		});
		const failure = vi.fn();
		const kill = vi.spyOn(process, "kill");
		expect(() => signalProcessGroupOrProcess(42, "SIGKILL", failure)).not.toThrow();
		expect(failure.mock.calls[0]![0].message).toBe("helper blocked");
		expect(kill).not.toHaveBeenCalled();
		expect(close.mock.calls).toEqual([[handle]]);
	});

	it.each(["error", "nonzero"])("reports %s only once and never retries a raw PID", (event) => {
		const failure = vi.fn();
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		signalProcessGroupOrProcess(42, "SIGKILL", failure);
		if (event === "error") helper.emit("error", new Error("ENOENT"));
		helper.emit("exit", 3);
		expect(failure).toHaveBeenCalledTimes(1);
		expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
		expect(calls.spawn).toHaveBeenCalledTimes(1);
		expect(calls.spawn.mock.calls[0]![2]).toEqual({ stdio: "ignore", detached: true, windowsHide: true });
		expect(helper.unref).toHaveBeenCalledTimes(1);
	});
});

function ownedProcess() {
	return Object.assign(new EventEmitter(), {
		pid: 4242,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
		unref: vi.fn(),
	});
}

function finishOwned(proc: ReturnType<typeof ownedProcess>, code = 0) {
	proc.exitCode = code;
	proc.emit("exit", code, null);
	proc.emit("close", code, null);
}

describe("owned exec failure reporting", () => {
	it.each([false, true])(
		"reports two failed attempts without abandoning a live child (already aborted: %s)",
		async (aborted) => {
			vi.useFakeTimers();
			vi.spyOn(console, "error").mockImplementation(() => {});
			const proc = ownedProcess();
			const blocked = () => {
				throw new Error("PowerShell blocked");
			};
			calls.spawn.mockReturnValueOnce(proc).mockImplementationOnce(blocked).mockImplementationOnce(blocked);
			const controller = new AbortController();
			if (aborted) controller.abort();
			const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
			let result: Awaited<ReturnType<typeof execCommand>> | undefined;
			const pending = execCommand("owned", [], process.cwd(), { signal: controller.signal, timeout: 60000 });
			pending.then((value) => {
				result = value;
			});
			try {
				proc.stdout.write("before failure");
				controller.abort();
				await vi.advanceTimersByTimeAsync(4999);
				expect(result).toBeUndefined();
				expect(calls.spawn).toHaveBeenCalledTimes(2);
				await vi.advanceTimersByTimeAsync(1);
				expect(result?.code).toBe(1);
				expect(result?.killed).toBe(false);
				expect(result?.stderr).toContain("owned process 4242");
				expect(result?.stderr).toContain("PowerShell blocked");
				expect(result?.stdout).toBe("before failure");
				expect(proc.exitCode).toBeNull();
				expect(proc.listenerCount("exit")).toBeGreaterThan(0);
				expect(proc.listenerCount("error")).toBeGreaterThan(0);
				expect(proc.listenerCount("close")).toBeGreaterThan(0);
				expect(proc.stdout.destroyed).toBe(false);
				expect(proc.kill).not.toHaveBeenCalled();
				expect(proc.unref).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(0);
				expect(removeAbort).toHaveBeenCalled();
				const chunk = { toString: vi.fn(() => "discard this output") };
				proc.stdout.emit("data", chunk);
				proc.stderr.emit("data", chunk);
				expect(chunk.toString).not.toHaveBeenCalled();
			} finally {
				finishOwned(proc);
				await pending;
			}
			expect(proc.stdout.destroyed).toBe(true);
			expect(proc.stderr.destroyed).toBe(true);
			for (const event of ["error", "exit", "close"]) expect(proc.listenerCount(event)).toBe(0);
		},
	);

	it("retains the five-second escalation after TERM failure and waits for successful KILL exit", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const proc = ownedProcess();
		calls.spawn.mockReturnValueOnce(proc).mockImplementationOnce(() => {
			throw new Error("TERM blocked");
		});
		const controller = new AbortController();
		let result: Awaited<ReturnType<typeof execCommand>> | undefined;
		const pending = execCommand("owned", [], process.cwd(), { signal: controller.signal });
		pending.then((value) => {
			result = value;
		});
		controller.abort();
		await vi.advanceTimersByTimeAsync(5000);
		expect(calls.spawn).toHaveBeenCalledTimes(3);
		const script = Buffer.from(calls.spawn.mock.calls[2]![1].at(-1), "base64").toString("utf16le");
		expect(script).toContain("/T /F");
		expect(result).toBeUndefined();
		helper.emit("exit", 0);
		finishOwned(proc, 137);
		expect(await pending).toMatchObject({ code: 137, killed: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not replace a real owned exit with a late helper failure", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const proc = ownedProcess();
		calls.spawn.mockReturnValueOnce(proc).mockImplementationOnce(() => {
			throw new Error("TERM blocked");
		});
		const controller = new AbortController();
		const pending = execCommand("owned", [], process.cwd(), { signal: controller.signal });
		controller.abort();
		await vi.advanceTimersByTimeAsync(5000);
		proc.exitCode = 0;
		proc.emit("exit", 0, null);
		helper.emit("error", new Error("late helper failure"));
		proc.emit("close", 0, null);
		expect(await pending).toMatchObject({ code: 0, killed: true, stderr: "" });
		expect(proc.stdout.destroyed).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});
