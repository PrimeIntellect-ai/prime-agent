import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCronJobStore } from "../../../src/core/cron-jobs.js";
import * as sessionManager from "../../../src/core/session-manager.js";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import type { DaemonCommand, DaemonResponse } from "../../../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import type { RlmSpawnLedger } from "../../../src/modes/daemon/rlm-ledger.js";
import { createHarness, type Harness } from "../harness.js";
import { createDeferred } from "../scheduling.js";

interface SupervisorHarness {
	defaultSessionConfig: { agentDir: string };
	rlmSpawnLedger(): RlmSpawnLedger;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	broadcastHeartbeatsChanged(): void;
	passiveScheduledJobs?: { rows: unknown[]; scannedAt: number };
	passiveScheduledJobsScan?: Promise<unknown[]>;
}

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function createSupervisorHarness(): Promise<SupervisorHarness> {
	const harness = await createHarness();
	harnesses.push(harness);
	const directory = harness.tempDir;
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorHarness;
}

function createSavedSession(directory: string, name: string) {
	const manager = sessionManager.SessionManager.create(directory, join(directory, "sessions"));
	manager.newSession();
	manager.appendSessionInfo(name);
	manager.appendMessage({ role: "user", content: name, timestamp: 1 });
	manager.flushNow();
	return manager;
}

function armPassiveHeartbeat(manager: sessionManager.SessionManager, directory: string) {
	const store = AgentCronJobStore.forSessionArtifacts();
	store.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);
	return store.createHeartbeat({
		activeSessionId: manager.getSessionId(),
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile()!,
		cwd: directory,
		scheduleText: "every 1h",
		prompt: "continue",
	});
}

function listHeartbeats(supervisor: SupervisorHarness, id: string) {
	return supervisor.handleCommand({} as DaemonSocketClient, { id, type: "heartbeats_list" });
}

function within(ms: number, label: string): Promise<never> {
	return new Promise((_, reject) => {
		const timer = globalThis.setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
		timer.unref?.();
	});
}

function heartbeatIds(response: DaemonResponse | undefined): string[] {
	const data = (response as { data?: { heartbeats?: Array<{ job: { id: string; status: string } }> } }).data;
	return (data?.heartbeats ?? []).map((heartbeat) => heartbeat.job.id);
}

function heartbeatStatus(response: DaemonResponse | undefined, jobId: string): string {
	const data = (response as { data?: { heartbeats?: Array<{ job: { id: string; status: string } }> } }).data;
	return data?.heartbeats?.find((heartbeat) => heartbeat.job.id === jobId)?.job.status ?? "";
}

function cronJobIds(response: DaemonResponse | undefined): string[] {
	const data = (response as { data?: { jobs?: Array<{ id: string }> } }).data;
	return (data?.jobs ?? []).map((job) => job.id).sort();
}

/**
 * Stalls the next scheduled-catalog scan inside its ledger read: the scan
 * keeps its already-read ledger rows (pre-mutation state) and only its
 * publication is held back, so releasing it models an older scan that
 * finishes after a newer one.
 */
function stallNextFamilyScan(supervisor: SupervisorHarness) {
	const ledger = supervisor.rlmSpawnLedger();
	const realFamily = ledger.family.bind(ledger);
	const stalled = createDeferred();
	const stalledScanRead = createDeferred();
	const spy = vi.spyOn(ledger, "family").mockImplementation(async (...args: Parameters<typeof realFamily>) => {
		const infos = await realFamily(...args);
		stalledScanRead.resolve();
		if (spy.mock.calls.length === 1) await stalled.promise;
		return infos;
	});
	return { spy, stalled, stalledScanRead };
}

/** Waits until the shared in-flight scan slot is empty again. */
async function awaitSharedScanSlotCleared(supervisor: SupervisorHarness): Promise<void> {
	await vi.waitFor(() => expect(supervisor.passiveScheduledJobsScan).toBeUndefined(), {
		timeout: 2_000,
		interval: 10,
	});
}

/** Yields past the microtask queue so a released background scan settles. */
async function flushBackgroundScans(): Promise<void> {
	await Promise.race([
		new Promise<void>((resolve) => globalThis.setImmediate(resolve)),
		within(1_000, "the event loop to flush"),
	]);
}

describe("heartbeats_list response latency", () => {
	it("shares one scheduled-catalog scan across concurrent heartbeats_list requests", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = createSavedSession(directory, "scheduled");
		const job = armPassiveHeartbeat(manager, directory);
		const family = vi.spyOn(supervisor.rlmSpawnLedger(), "family");

		const responses = await Promise.all(
			["list-1", "list-2", "list-3", "list-4", "list-5"].map((id) => listHeartbeats(supervisor, id)),
		);
		for (const response of responses) {
			expect(response).toMatchObject({ success: true });
			expect(heartbeatIds(response)).toEqual([job.id]);
		}
		// One scan served all five concurrent requests instead of one each.
		expect(family).toHaveBeenCalledTimes(1);
		// The stored snapshot serves later requests without any rescan.
		await expect(listHeartbeats(supervisor, "list-6")).resolves.toMatchObject({ success: true });
		expect(family).toHaveBeenCalledTimes(1);
	});

	it("answers from the stored snapshot while a saved-session scan is in flight", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = createSavedSession(directory, "scheduled");
		const job = armPassiveHeartbeat(manager, directory);
		const sessionFile = manager.getSessionFile()!;

		// Warm the shared snapshot.
		await expect(listHeartbeats(supervisor, "warm")).resolves.toMatchObject({ success: true });

		// A sibling metadata scan (cold chat opens, renames) stalls mid-read.
		const readSessionInfo = sessionManager.readSessionInfo;
		const scanStarted = createDeferred();
		const releaseScan = createDeferred();
		const readSpy = vi.spyOn(sessionManager, "readSessionInfo").mockImplementation(async (...args) => {
			scanStarted.resolve();
			await releaseScan.promise;
			return readSessionInfo(...args);
		});
		const siblings = supervisor.rlmSpawnLedger().siblings(sessionFile);
		await scanStarted.promise;
		const readsAtBlock = readSpy.mock.calls.length;

		// The catalog request must answer from the snapshot without joining
		// the blocked scan or waiting on the serialized ledger queue.
		const listPromise = listHeartbeats(supervisor, "list-1");
		try {
			const response = await Promise.race([listPromise, within(1_000, "the snapshot-served heartbeats_list")]);
			expect(response).toMatchObject({ success: true });
			expect(heartbeatIds(response)).toEqual([job.id]);
			expect(readSpy.mock.calls.length).toBe(readsAtBlock);
		} finally {
			releaseScan.resolve();
			await siblings;
			// Drain a deadline-lost request so it cannot leak into later tests.
			await listPromise.catch(() => undefined);
			readSpy.mockRestore();
		}
	});

	it("does not queue a cold heartbeats_list behind a sibling metadata scan", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = createSavedSession(directory, "scheduled");
		const job = armPassiveHeartbeat(manager, directory);
		const sessionFile = manager.getSessionFile()!;

		// The sibling scan blocks inside its first metadata read; the catalog
		// scan must not wait for that read to finish.
		const readSessionInfo = sessionManager.readSessionInfo;
		const scanStarted = createDeferred();
		const releaseScan = createDeferred();
		let firstRead = true;
		const readSpy = vi.spyOn(sessionManager, "readSessionInfo").mockImplementation(async (...args) => {
			if (firstRead) {
				firstRead = false;
				scanStarted.resolve();
				await releaseScan.promise;
			}
			return readSessionInfo(...args);
		});
		const siblings = supervisor.rlmSpawnLedger().siblings(sessionFile);
		await scanStarted.promise;

		const listPromise = listHeartbeats(supervisor, "list-1");
		try {
			const response = await Promise.race([listPromise, within(1_000, "the cold heartbeats_list")]);
			expect(response).toMatchObject({ success: true });
			expect(heartbeatIds(response)).toEqual([job.id]);
		} finally {
			releaseScan.resolve();
			await siblings;
			// Drain a deadline-lost request so it cannot leak into later tests.
			await listPromise.catch(() => undefined);
			readSpy.mockRestore();
		}
	});

	it("keeps catalog rows correct after create, update, and delete", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = createSavedSession(directory, "scheduled");
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);

		expect(heartbeatIds(await listHeartbeats(supervisor, "list-1"))).toEqual([]);

		// A durable create lands (as every daemon-owned mutation does) with a
		// heartbeats_changed broadcast that drops the stored snapshot.
		const job = store.createHeartbeat({
			activeSessionId: manager.getSessionId(),
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile()!,
			cwd: directory,
			scheduleText: "every 1h",
			prompt: "continue",
		});
		supervisor.broadcastHeartbeatsChanged();
		expect(heartbeatIds(await listHeartbeats(supervisor, "list-2"))).toEqual([job.id]);

		store.manageHeartbeat(manager.getSessionId(), job.id, "pause");
		supervisor.broadcastHeartbeatsChanged();
		const paused = await listHeartbeats(supervisor, "list-3");
		expect(heartbeatIds(paused)).toEqual([job.id]);
		expect(heartbeatStatus(paused, job.id)).toBe("paused");

		store.manageHeartbeat(manager.getSessionId(), job.id, "stop");
		supervisor.broadcastHeartbeatsChanged();
		expect(heartbeatIds(await listHeartbeats(supervisor, "list-4"))).toEqual([]);
	});

	it("refreshes an aged snapshot in the background while still serving it", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = createSavedSession(directory, "scheduled");
		const job = armPassiveHeartbeat(manager, directory);
		const family = vi.spyOn(supervisor.rlmSpawnLedger(), "family");

		await expect(listHeartbeats(supervisor, "warm")).resolves.toMatchObject({ success: true });
		expect(family).toHaveBeenCalledTimes(1);

		// Age the snapshot past the refresh floor.
		supervisor.passiveScheduledJobs!.scannedAt = Date.now() - 60_000;
		const response = await Promise.race([
			listHeartbeats(supervisor, "list-1"),
			within(1_000, "the stale-served heartbeats_list"),
		]);
		expect(response).toMatchObject({ success: true });
		expect(heartbeatIds(response)).toEqual([job.id]);

		// The aged snapshot triggered a background refresh; a later request
		// reads the refreshed snapshot without another scan.
		await vi.waitFor(() => expect(family).toHaveBeenCalledTimes(2));
		await expect(listHeartbeats(supervisor, "list-2")).resolves.toMatchObject({ success: true });
		expect(family).toHaveBeenCalledTimes(2);
	});

	it("keeps a newer snapshot when an older in-flight scan finishes last", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const first = createSavedSession(directory, "first");
		const firstJob = armPassiveHeartbeat(first, directory);

		// Warm the snapshot, age it, and let the background refresh stall with
		// pre-write ledger rows already read.
		await expect(listHeartbeats(supervisor, "warm")).resolves.toMatchObject({ success: true });
		const { spy, stalled, stalledScanRead } = stallNextFamilyScan(supervisor);
		supervisor.passiveScheduledJobs!.scannedAt = Date.now() - 60_000;
		await expect(listHeartbeats(supervisor, "stale-serve")).resolves.toMatchObject({ success: true });
		await Promise.race([stalledScanRead.promise, within(1_000, "the stalled refresh scan to start")]);

		// A second session's heartbeat lands while the refresh is stalled.
		const second = createSavedSession(directory, "second");
		const secondJob = armPassiveHeartbeat(second, directory);

		// A cron_list drives a newer per-caller scan that completes first and
		// publishes the post-write rows.
		const cron = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "cron-1",
			type: "cron_list",
			includeInactive: true,
		});
		expect(cronJobIds(cron)).toEqual([firstJob.id, secondJob.id].sort());
		expect(heartbeatIds(await listHeartbeats(supervisor, "after-newer-scan")).sort()).toEqual(
			[firstJob.id, secondJob.id].sort(),
		);

		// Releasing the older stalled refresh must not republish its pre-write
		// rows over the newer snapshot.
		stalled.resolve();
		await awaitSharedScanSlotCleared(supervisor);
		expect(heartbeatIds(await listHeartbeats(supervisor, "final")).sort()).toEqual(
			[firstJob.id, secondJob.id].sort(),
		);
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("serves the stored snapshot to lists that arrive while the background refresh is in flight", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = createSavedSession(directory, "scheduled");
		const job = armPassiveHeartbeat(manager, directory);

		// Warm the snapshot, age it, and stall the background refresh it starts.
		await expect(listHeartbeats(supervisor, "warm")).resolves.toMatchObject({ success: true });
		const { spy, stalled, stalledScanRead } = stallNextFamilyScan(supervisor);
		supervisor.passiveScheduledJobs!.scannedAt = Date.now() - 60_000;
		await expect(listHeartbeats(supervisor, "stale-serve")).resolves.toMatchObject({ success: true });
		await Promise.race([stalledScanRead.promise, within(1_000, "the background refresh to start")]);

		// A list that arrives during the refresh answers from the still-present
		// snapshot instead of queueing behind the stalled scan.
		const duringRefresh = listHeartbeats(supervisor, "during-refresh");
		try {
			const response = await Promise.race([duringRefresh, within(1_000, "the snapshot-served heartbeats_list")]);
			expect(response).toMatchObject({ success: true });
			expect(heartbeatIds(response)).toEqual([job.id]);
		} finally {
			stalled.resolve();
			await awaitSharedScanSlotCleared(supervisor);
			// Drain a deadline-lost request so it cannot leak into later tests.
			await duringRefresh.catch(() => undefined);
		}
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("reflects a completed heartbeat stop on the next list without serving the pre-mutation scan", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = createSavedSession(directory, "scheduled");
		const job = armPassiveHeartbeat(manager, directory);

		// Warm the snapshot, age it, and stall the pre-mutation refresh it starts.
		await expect(listHeartbeats(supervisor, "warm")).resolves.toMatchObject({ success: true });
		const { stalled, stalledScanRead } = stallNextFamilyScan(supervisor);
		supervisor.passiveScheduledJobs!.scannedAt = Date.now() - 60_000;
		await expect(listHeartbeats(supervisor, "stale-serve")).resolves.toMatchObject({ success: true });
		await Promise.race([stalledScanRead.promise, within(1_000, "the pre-mutation refresh to start")]);

		// Stop the heartbeat and broadcast the daemon-owned mutation.
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);
		store.manageHeartbeat(manager.getSessionId(), job.id, "stop");
		supervisor.broadcastHeartbeatsChanged();

		// The next list must reflect the stop promptly: it cannot join the
		// pre-mutation scan still in flight.
		const stopped = listHeartbeats(supervisor, "after-stop");
		try {
			const response = await Promise.race([stopped, within(1_000, "the post-mutation heartbeats_list")]);
			expect(response).toMatchObject({ success: true });
			expect(heartbeatIds(response)).toEqual([]);
		} finally {
			stalled.resolve();
			// Drain a deadline-lost request so it cannot leak into later tests.
			await stopped.catch(() => undefined);
		}

		// The detached pre-mutation scan settling late must not republish rows.
		await flushBackgroundScans();
		await expect(listHeartbeats(supervisor, "final")).resolves.toMatchObject({ success: true });
		expect(heartbeatIds(await listHeartbeats(supervisor, "final-check"))).toEqual([]);
	});

	it("does not return pre-change rows from the detached scan for lists starting after the broadcast", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = createSavedSession(directory, "scheduled");
		const job = armPassiveHeartbeat(manager, directory);

		// Warm the snapshot, age it, and stall the pre-change refresh it starts.
		await expect(listHeartbeats(supervisor, "warm")).resolves.toMatchObject({ success: true });
		const { stalled, stalledScanRead } = stallNextFamilyScan(supervisor);
		supervisor.passiveScheduledJobs!.scannedAt = Date.now() - 60_000;
		await expect(listHeartbeats(supervisor, "stale-serve")).resolves.toMatchObject({ success: true });
		await Promise.race([stalledScanRead.promise, within(1_000, "the pre-change refresh to start")]);

		// A second session's heartbeat lands with the daemon-owned broadcast.
		const second = createSavedSession(directory, "second");
		const secondJob = armPassiveHeartbeat(second, directory);
		supervisor.broadcastHeartbeatsChanged();

		// The list that starts after the broadcast must not await the detached
		// pre-change scan; it rescans and serves both heartbeats.
		const afterBroadcast = listHeartbeats(supervisor, "after-broadcast");
		try {
			const response = await Promise.race([afterBroadcast, within(1_000, "the post-broadcast heartbeats_list")]);
			expect(response).toMatchObject({ success: true });
			expect(heartbeatIds(response).sort()).toEqual([job.id, secondJob.id].sort());
		} finally {
			stalled.resolve();
			// Drain a deadline-lost request so it cannot leak into later tests.
			await afterBroadcast.catch(() => undefined);
		}

		// The detached pre-change scan settling late must not republish rows.
		await flushBackgroundScans();
		const final = await listHeartbeats(supervisor, "final");
		expect(heartbeatIds(final).sort()).toEqual([job.id, secondJob.id].sort());
	});
});
