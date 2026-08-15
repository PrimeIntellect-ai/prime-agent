import { afterEach, describe, expect, it } from "vitest";
import { wrapKernelSpawn } from "../src/core/kernel/spawn-wrapper.js";

describe("wrapKernelSpawn", () => {
	const original = process.env.PRIME_AGENT_KERNEL_WRAPPER;

	afterEach(() => {
		if (original === undefined) delete process.env.PRIME_AGENT_KERNEL_WRAPPER;
		else process.env.PRIME_AGENT_KERNEL_WRAPPER = original;
	});

	it("passes through when unset", () => {
		delete process.env.PRIME_AGENT_KERNEL_WRAPPER;
		expect(wrapKernelSpawn("python", ["-m", "x"])).toEqual({ command: "python", args: ["-m", "x"] });
	});

	it("passes through when empty", () => {
		process.env.PRIME_AGENT_KERNEL_WRAPPER = "  ";
		expect(wrapKernelSpawn("python", ["-m", "x"])).toEqual({ command: "python", args: ["-m", "x"] });
	});

	it("parses a JSON array prefix", () => {
		process.env.PRIME_AGENT_KERNEL_WRAPPER = JSON.stringify(["/usr/bin/sandbox-exec", "-f", "/p with space.sb"]);
		expect(wrapKernelSpawn("python", ["-m", "x"])).toEqual({
			command: "/usr/bin/sandbox-exec",
			args: ["-f", "/p with space.sb", "python", "-m", "x"],
		});
	});

	it("parses a whitespace-separated prefix", () => {
		process.env.PRIME_AGENT_KERNEL_WRAPPER = "sandbox-exec -f /tmp/p.sb";
		expect(wrapKernelSpawn("python", [])).toEqual({
			command: "sandbox-exec",
			args: ["-f", "/tmp/p.sb", "python"],
		});
	});

	it("falls back to whitespace splitting on invalid JSON", () => {
		process.env.PRIME_AGENT_KERNEL_WRAPPER = "[not-json";
		expect(wrapKernelSpawn("python", []).command).toBe("[not-json");
	});
});
