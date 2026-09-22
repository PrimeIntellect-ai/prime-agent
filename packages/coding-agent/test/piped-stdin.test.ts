import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPipedStdin, resolveStdinIdleTimeoutMs, STDIN_IDLE_TIMEOUT_MS_ENV } from "../src/utils/piped-stdin.js";

function ttyStream(): PassThrough {
	const stream = new PassThrough();
	(stream as unknown as { isTTY: boolean }).isTTY = true;
	return stream;
}

afterEach(() => {
	delete process.env[STDIN_IDLE_TIMEOUT_MS_ENV];
	vi.restoreAllMocks();
});

describe("resolveStdinIdleTimeoutMs", () => {
	it("defaults to a short non-interactive window", () => {
		expect(resolveStdinIdleTimeoutMs({})).toBe(250);
	});

	it("honors a clean env override", () => {
		expect(resolveStdinIdleTimeoutMs({ [STDIN_IDLE_TIMEOUT_MS_ENV]: "5000" })).toBe(5000);
	});

	it("allows zero to skip the read entirely", () => {
		expect(resolveStdinIdleTimeoutMs({ [STDIN_IDLE_TIMEOUT_MS_ENV]: "0" })).toBe(0);
	});

	it("falls back to the default on invalid input and clamps the maximum", () => {
		for (const bad of ["abc", "-3", ""]) {
			expect(resolveStdinIdleTimeoutMs({ [STDIN_IDLE_TIMEOUT_MS_ENV]: bad })).toBe(250);
		}
		// Fractional requests floor to whole milliseconds.
		expect(resolveStdinIdleTimeoutMs({ [STDIN_IDLE_TIMEOUT_MS_ENV]: "4.9" })).toBe(4);
		expect(resolveStdinIdleTimeoutMs({ [STDIN_IDLE_TIMEOUT_MS_ENV]: "999999" })).toBe(30_000);
	});
});

describe("readPipedStdin", () => {
	it("returns undefined for a TTY without reading it", async () => {
		const input = ttyStream();
		await expect(readPipedStdin({ input, idleTimeoutMs: 25 })).resolves.toBeUndefined();
	});

	it("returns undefined when stdin was already consumed to end", async () => {
		const input = new PassThrough();
		input.end("already consumed");
		input.resume();
		await new Promise((resolve) => input.once("end", resolve));
		expect(input.readableEnded).toBe(true);
		await expect(readPipedStdin({ input, idleTimeoutMs: 1000 })).resolves.toBeUndefined();
	});

	it("skips the read entirely with a zero idle timeout", async () => {
		const input = new PassThrough();
		await expect(readPipedStdin({ input, idleTimeoutMs: 0 })).resolves.toBeUndefined();
		expect(input.readableFlowing).not.toBe(true);
	});

	it("collects piped content until end", async () => {
		const input = new PassThrough();
		const promise = readPipedStdin({ input, idleTimeoutMs: 1000 });
		input.write("hello\n");
		input.write("world");
		input.end();
		await expect(promise).resolves.toBe("hello\nworld");
	});

	it("resolves undefined when stdin errors", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const input = new PassThrough();
		const promise = readPipedStdin({ input, idleTimeoutMs: 1000 });
		setTimeout(() => input.destroy(new Error("boom")), 5);
		await expect(promise).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it("gives up on a held-open silent pipe instead of hanging", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const input = new PassThrough();
		const promise = readPipedStdin({ input, idleTimeoutMs: 25 });
		await expect(promise).resolves.toBeUndefined();
		// The stream is paused with listeners detached: later bytes stay buffered
		// for a future reader, and stdin cannot keep the process alive.
		expect(input.isPaused()).toBe(true);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps reading a live producer past the idle window", async () => {
		const input = new PassThrough();
		const promise = readPipedStdin({ input, idleTimeoutMs: 50 });
		input.write("chunk-1;");
		for (let index = 2; index <= 5; index++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			input.write(`chunk-${index};`);
		}
		input.end("done");
		await expect(promise).resolves.toBe("chunk-1;chunk-2;chunk-3;chunk-4;chunk-5;done");
	});

	it("returns partial content when the producer goes silent mid-stream", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const input = new PassThrough();
		const promise = readPipedStdin({ input, idleTimeoutMs: 25 });
		input.write("partial");
		await expect(promise).resolves.toBe("partial");
	});
});
