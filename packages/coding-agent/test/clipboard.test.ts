import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "child_process";
import { platform } from "os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard } from "../src/utils/clipboard.js";

const mocks = vi.hoisted(() => {
	return {
		clipboard: {
			setText: vi.fn<(text: string) => Promise<void>>(),
		},
		spawnSync: vi.fn(),
		spawn: vi.fn(),
		platform: vi.fn<() => NodeJS.Platform>(),
		isWaylandSession: vi.fn<() => boolean>(),
	};
});

vi.mock("../src/utils/clipboard-native.js", () => {
	return {
		clipboard: mocks.clipboard,
	};
});

vi.mock("child_process", () => {
	return {
		spawnSync: mocks.spawnSync,
		spawn: mocks.spawn,
	};
});

vi.mock("os", () => {
	return {
		platform: mocks.platform,
	};
});

vi.mock("../src/utils/clipboard-image.js", () => {
	return {
		isWaylandSession: mocks.isWaylandSession,
	};
});

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedSpawn = vi.mocked(spawn);
const mockedPlatform = vi.mocked(platform);

let originalWrite: typeof process.stdout.write;
let stdoutWrites: string[];
let nativeResolved = false;

function osc52Writes(): string[] {
	return stdoutWrites.filter((write) => write.startsWith("\x1b]52;c;"));
}

function mockChildProcess(): ReturnType<typeof spawn> {
	const child = new EventEmitter() as ReturnType<typeof spawn>;
	child.stdin = new EventEmitter() as ReturnType<typeof spawn>["stdin"];
	child.stdin!.end = vi.fn();
	child.stdin!.destroy = vi.fn();
	child.kill = vi.fn();
	child.unref = vi.fn();
	mockedSpawn.mockReturnValue(child);
	return child;
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("SSH_CONNECTION", "");
	vi.stubEnv("SSH_CLIENT", "");
	vi.stubEnv("MOSH_CONNECTION", "");
	stdoutWrites = [];
	nativeResolved = false;
	mocks.clipboard.setText.mockReset();
	mocks.spawnSync.mockReset();
	mocks.spawnSync.mockReturnValue({ status: 0, signal: null } as ReturnType<typeof spawnSync>);
	mocks.spawn.mockReset();
	mocks.platform.mockReset();
	mocks.isWaylandSession.mockReset();
	mockedPlatform.mockReturnValue("darwin");
	mocks.isWaylandSession.mockReturnValue(false);
	mocks.clipboard.setText.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		nativeResolved = true;
	});
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
		const [chunk] = args;
		if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
			stdoutWrites.push(chunk);
			return true;
		}
		return originalWrite(...args);
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	vi.unstubAllEnvs();
});

describe("copyToClipboard", () => {
	test("local native success skips OSC 52 and shell fallbacks", async () => {
		await copyToClipboard("hello");

		expect(mocks.clipboard.setText).toHaveBeenCalledWith("hello");
		expect(osc52Writes()).toHaveLength(0);
		expect(mockedSpawnSync).not.toHaveBeenCalled();
		expect(mockedSpawn).not.toHaveBeenCalled();
	});

	test("remote native success emits OSC 52 after native write", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect(osc52Writes()).toHaveLength(0);
			nativeResolved = true;
		});

		await copyToClipboard("hello");

		expect(nativeResolved).toBe(true);
		expect(osc52Writes()).toHaveLength(1);
		expect(mockedSpawnSync).not.toHaveBeenCalled();
	});

	test("local shell fallback success skips OSC 52", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedSpawnSync.mockReturnValue({ status: 0, signal: null } as ReturnType<typeof spawnSync>);

		await copyToClipboard("hello");

		expect(mockedSpawnSync).toHaveBeenCalledWith("pbcopy", [], {
			input: "hello",
			shell: false,
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		expect(osc52Writes()).toHaveLength(0);
	});

	test("uses OSC 52 fallback when native and shell tools fail", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedSpawnSync.mockReturnValue({ status: 1, signal: null } as ReturnType<typeof spawnSync>);

		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(1);
	});

	test("handles an asynchronous wl-copy launch failure and falls back safely", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.isWaylandSession.mockReturnValue(true);
		const child = mockChildProcess();

		const copying = copyToClipboard("hello");
		child.emit("error", new Error("ENOENT"));
		await copying;

		expect(osc52Writes()).toHaveLength(1);
	});

	test("writes Wayland clipboard text through stdin and releases child ownership", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.isWaylandSession.mockReturnValue(true);
		const child = mockChildProcess();

		const copying = copyToClipboard("hello");
		child.emit("spawn");
		child.emit("close", 0, null);
		await copying;

		expect(child.stdin!.end).toHaveBeenCalledWith("hello");
		expect(child.unref).toHaveBeenCalledOnce();
		expect(osc52Writes()).toHaveLength(0);
	});

	test("falls back when wl-copy exits nonzero after accepting stdin", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mocks.isWaylandSession.mockReturnValue(true);
		const child = mockChildProcess();
		mockedSpawnSync.mockReturnValue({ status: 0, signal: null } as ReturnType<typeof spawnSync>);

		const copying = copyToClipboard("hello");
		child.emit("spawn");
		child.emit("close", 1, null);
		await copying;

		expect(child.stdin!.end).toHaveBeenCalledWith("hello");
		expect(mockedSpawnSync).toHaveBeenCalledWith("xclip", ["-selection", "clipboard"], expect.any(Object));
		expect(osc52Writes()).toHaveLength(0);
	});

	test("detaches a hung wl-copy process and falls back at the completion deadline", async () => {
		vi.useFakeTimers();
		try {
			mockedPlatform.mockReturnValue("linux");
			vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
			mocks.isWaylandSession.mockReturnValue(true);
			const child = mockChildProcess();

			const copying = copyToClipboard("hello");
			child.emit("spawn");
			await vi.advanceTimersByTimeAsync(5000);
			await copying;

			expect(child.unref).toHaveBeenCalledOnce();
			expect(child.kill).toHaveBeenCalledWith("SIGKILL");
			expect(child.stdin!.destroy).toHaveBeenCalledOnce();
			expect(osc52Writes()).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(0);
			child.emit("error", new Error("late error"));
		} finally {
			vi.useRealTimers();
		}
	});

	test("passes clipboard text only on stdin and falls back from xclip to xsel", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("DISPLAY", ":0");
		const hostileText = "$(touch /tmp/never) ; echo injected";
		mockedSpawnSync
			.mockReturnValueOnce({ status: 1, signal: null } as ReturnType<typeof spawnSync>)
			.mockReturnValueOnce({ status: 0, signal: null } as ReturnType<typeof spawnSync>);

		await copyToClipboard(hostileText);

		expect(mockedSpawnSync).toHaveBeenNthCalledWith(1, "xclip", ["-selection", "clipboard"], {
			input: hostileText,
			shell: false,
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		expect(mockedSpawnSync).toHaveBeenNthCalledWith(2, "xsel", ["--clipboard", "--input"], {
			input: hostileText,
			shell: false,
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		expect(osc52Writes()).toHaveLength(0);
	});

	test("does not emit oversized OSC 52 payloads", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedSpawnSync.mockReturnValue({ status: 1, signal: null } as ReturnType<typeof spawnSync>);

		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow("Failed to copy to clipboard");
		expect(osc52Writes()).toHaveLength(0);
	});
});
