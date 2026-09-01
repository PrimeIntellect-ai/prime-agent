import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({
	args: [] as string[],
	child: undefined as (EventEmitter & { connected: boolean }) | undefined,
}));

vi.mock("node:child_process", () => ({
	spawn(_command: string, args: string[], _options: SpawnOptions): ChildProcess {
		spawnState.args = args;
		const child = Object.assign(new EventEmitter(), {
			connected: true,
			disconnect: vi.fn(),
			kill: vi.fn(),
			send: vi.fn(),
		});
		spawnState.child = child;
		return child as unknown as ChildProcess;
	},
}));

import { DAEMON_CATALOG_START_TIMEOUT_MS, DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";

afterEach(() => {
	vi.useRealTimers();
	spawnState.args = [];
	spawnState.child = undefined;
});

describe("daemon catalog startup", () => {
	it("uses the dedicated entrypoint and allows a cold start past five seconds", async () => {
		vi.useFakeTimers();
		const client = new DaemonCatalogClient(() => {});
		const starting = client.start();

		expect(DAEMON_CATALOG_START_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
		expect(spawnState.args.some((arg) => /daemon-catalog-entry\.(?:js|ts)$/.test(arg))).toBe(true);
		await vi.advanceTimersByTimeAsync(6000);
		spawnState.child?.emit("message", { type: "ready" });
		await expect(starting).resolves.toBeUndefined();
	});

	it("rejects immediately when the catalog exits during startup", async () => {
		vi.useFakeTimers();
		const client = new DaemonCatalogClient(() => {});
		const starting = client.start();

		spawnState.child?.emit("exit", 1, null);
		await expect(starting).rejects.toThrow(/exited during startup/);
	});
});
