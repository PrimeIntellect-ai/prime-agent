import { afterEach, describe, expect, it } from "vitest";
import { ForkServerUnavailable, forkKernel, isForkServerEnabled } from "../src/core/kernel/fork-server.js";

const FORK_ENV = "PRIME_AGENT_KERNEL_FORKSERVER";

describe("fork-server gating", () => {
	afterEach(() => {
		delete process.env[FORK_ENV];
	});

	it("is on by default on linux, opt-out via the flag", () => {
		delete process.env[FORK_ENV];
		expect(isForkServerEnabled()).toBe(process.platform === "linux");
		process.env[FORK_ENV] = "0";
		expect(isForkServerEnabled()).toBe(false);
		process.env[FORK_ENV] = "1";
		expect(isForkServerEnabled()).toBe(process.platform === "linux");
	});

	it("rejects with ForkServerUnavailable when opted out so callers fall back", async () => {
		process.env[FORK_ENV] = "0";
		await expect(forkKernel("python3", { connectionPath: "/tmp/nope/connection.json" })).rejects.toBeInstanceOf(
			ForkServerUnavailable,
		);
	});

	it("degrades to ForkServerUnavailable when the interpreter can't start", async () => {
		if (process.platform !== "linux") return;
		await expect(
			forkKernel("/nonexistent/python-binary", { connectionPath: "/tmp/nope/connection.json" }),
		).rejects.toBeInstanceOf(ForkServerUnavailable);
	}, 15_000);

	it("falls back to direct spawn for any PYTHON* startup-env override", async () => {
		if (process.platform !== "linux") return;
		// The guard treats the whole PYTHON* family as startup-affecting, so even a var
		// not explicitly enumerated diverts to direct spawn (no var can be "missed").
		for (const key of ["PYTHONPATH", "PYTHONUSERBASE", "PYTHONDONTWRITEBYTECODE"]) {
			await expect(
				forkKernel("python3", {
					connectionPath: "/tmp/nope/connection.json",
					env: { [key]: "/some/custom/value" },
				}),
			).rejects.toBeInstanceOf(ForkServerUnavailable);
		}
	});
});
