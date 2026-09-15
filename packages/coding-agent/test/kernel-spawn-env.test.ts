import { describe, expect, it } from "vitest";
import { kernelSpawnEnv } from "../src/core/kernel/repl-manager.js";

describe("kernelSpawnEnv", () => {
	it("strips TSX_TSCONFIG_PATH so kernel bash() shells discover per-cwd", () => {
		const env = kernelSpawnEnv(
			{ TSX_TSCONFIG_PATH: "/nonexistent/stale/tsconfig.json", PATH: "/bin" },
			undefined,
			1234,
		);
		expect(env.TSX_TSCONFIG_PATH).toBeUndefined();
		expect(env.PATH).toBe("/bin");
	});

	it("merges option env over the source env and stamps the owner pid", () => {
		const env = kernelSpawnEnv({ HOME: "/home/a", CUSTOM: "one" }, { CUSTOM: "two" }, 42);
		expect(env.HOME).toBe("/home/a");
		expect(env.CUSTOM).toBe("two");
		expect(env.PRIME_AGENT_KERNEL_OWNER_PID).toBe("42");
	});

	it("defaults the owner pid to the current process", () => {
		const env = kernelSpawnEnv({}, undefined);
		expect(env.PRIME_AGENT_KERNEL_OWNER_PID).toBe(String(process.pid));
	});
});
