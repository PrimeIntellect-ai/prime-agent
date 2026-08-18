import { describe, expect, it } from "vitest";
import { execEnvForSession, filterClientEnv, withClientEnv } from "../src/modes/daemon/daemon-client-env.js";

describe("filterClientEnv", () => {
	it("keeps only allowlisted keys", () => {
		expect(filterClientEnv({ HERDR_PANE_ID: "w1:p1", PATH: "/evil", HERDR_ENV: "1" })).toEqual({
			HERDR_PANE_ID: "w1:p1",
			HERDR_ENV: "1",
		});
	});

	it("returns undefined for missing or empty env", () => {
		expect(filterClientEnv(undefined)).toBeUndefined();
		expect(filterClientEnv({})).toBeUndefined();
		expect(filterClientEnv({ PATH: "/evil" })).toBeUndefined();
	});
});

describe("withClientEnv", () => {
	it("applies env during fn, unsetting omitted allowlisted keys, and restores afterwards", async () => {
		process.env.HERDR_PANE_ID = "original";
		process.env.HERDR_WORKSPACE_ID = "ambient";
		delete process.env.HERDR_TAB_ID;
		let seenPane: string | undefined;
		let seenTab: string | undefined;
		let seenWorkspace: string | undefined = "unset";
		await withClientEnv({ HERDR_PANE_ID: "w2:p1", HERDR_TAB_ID: "t1" }, async () => {
			seenPane = process.env.HERDR_PANE_ID;
			seenTab = process.env.HERDR_TAB_ID;
			seenWorkspace = process.env.HERDR_WORKSPACE_ID;
		});
		expect(seenPane).toBe("w2:p1");
		expect(seenTab).toBe("t1");
		expect(seenWorkspace).toBeUndefined();
		expect(process.env.HERDR_PANE_ID).toBe("original");
		expect(process.env.HERDR_TAB_ID).toBeUndefined();
		expect(process.env.HERDR_WORKSPACE_ID).toBe("ambient");
		delete process.env.HERDR_PANE_ID;
		delete process.env.HERDR_WORKSPACE_ID;
	});

	it("restores even when fn throws", async () => {
		process.env.HERDR_PANE_ID = "original";
		await expect(
			withClientEnv({ HERDR_PANE_ID: "w2:p1" }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(process.env.HERDR_PANE_ID).toBe("original");
		delete process.env.HERDR_PANE_ID;
	});

	it("serializes overlapping windows so envs never mix", async () => {
		delete process.env.HERDR_PANE_ID;
		const seen: Array<string | undefined> = [];
		const slow = withClientEnv({ HERDR_PANE_ID: "a" }, async () => {
			await new Promise((r) => setTimeout(r, 20));
			seen.push(process.env.HERDR_PANE_ID);
		});
		const fast = withClientEnv({ HERDR_PANE_ID: "b" }, async () => {
			seen.push(process.env.HERDR_PANE_ID);
		});
		await Promise.all([slow, fast]);
		expect(seen).toEqual(["a", "b"]);
		expect(process.env.HERDR_PANE_ID).toBeUndefined();
	});

	it("runs fn directly without env", async () => {
		let ran = false;
		await withClientEnv(undefined, async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});

	it("env-less loads never run inside an env window", async () => {
		delete process.env.HERDR_PANE_ID;
		let seenByEnvless: string | undefined = "unset";
		const windowed = withClientEnv({ HERDR_PANE_ID: "a" }, async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		const envless = withClientEnv(undefined, async () => {
			seenByEnvless = process.env.HERDR_PANE_ID;
		});
		await Promise.all([windowed, envless]);
		expect(seenByEnvless).toBeUndefined();
	});

	it("execEnvForSession pins keys independent of active env windows", async () => {
		const baseline = execEnvForSession();
		await withClientEnv({ HERDR_PANE_ID: "window-only" }, async () => {
			expect(execEnvForSession()).toStrictEqual(baseline);
			expect(execEnvForSession({ HERDR_PANE_ID: "w9:p9" })).toStrictEqual({
				HERDR_ENV: undefined,
				HERDR_PANE_ID: "w9:p9",
				HERDR_SOCKET_PATH: undefined,
				HERDR_TAB_ID: undefined,
				HERDR_WORKSPACE_ID: undefined,
			});
		});
	});

	it("env windows wait for in-flight env-less loads", async () => {
		delete process.env.HERDR_PANE_ID;
		const order: string[] = [];
		const envless = withClientEnv(undefined, async () => {
			await new Promise((r) => setTimeout(r, 20));
			order.push(`envless:${process.env.HERDR_PANE_ID}`);
		});
		const windowed = withClientEnv({ HERDR_PANE_ID: "b" }, async () => {
			order.push(`windowed:${process.env.HERDR_PANE_ID}`);
		});
		await Promise.all([envless, windowed]);
		expect(order).toEqual(["envless:undefined", "windowed:b"]);
		expect(process.env.HERDR_PANE_ID).toBeUndefined();
	});
});
