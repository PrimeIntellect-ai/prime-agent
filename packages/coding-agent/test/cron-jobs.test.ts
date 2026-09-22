import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.js";
import {
	type AgentCronJob,
	AgentCronJobStore,
	AgentCronScheduler,
	migrateLegacyCronJobsToSessionArtifacts,
	normalizeHeartbeatDeliveryMode,
	parseAgentCronSchedule,
	parseHeartbeatCommand,
	resolveHeartbeatStreamingBehavior,
	SESSION_SCHEDULED_JOBS_FILENAME,
	shouldDeferHeartbeatCronJob,
} from "../src/core/cron-jobs.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import * as atomicFile from "../src/utils/atomic-file.js";
import { createHarness, type Harness } from "./suite/harness.js";

const start = new Date("2026-01-01T12:34:00.000Z");

describe("parseAgentCronSchedule", () => {
	it("parses one-shot relative schedules", () => {
		const parsed = parseAgentCronSchedule("in 15m", start);

		expect(parsed.schedule).toEqual({ kind: "once", expression: "in 15m" });
		expect(parsed.nextRunAt.toISOString()).toBe("2026-01-01T12:49:00.000Z");
	});

	it("parses cron aliases and five-field cron subsets", () => {
		expect(parseAgentCronSchedule("@hourly", start).nextRunAt.toISOString()).toBe("2026-01-01T13:00:00.000Z");
		expect(parseAgentCronSchedule("*/30 * * * *", start).nextRunAt.toISOString()).toBe("2026-01-01T13:00:00.000Z");
	});

	it("parses recurring heartbeat intervals with seconds", () => {
		const parsed = parseAgentCronSchedule("every 30s", start);

		expect(parsed.schedule).toEqual({ kind: "interval", expression: "every 30s", intervalMs: 30_000 });
		expect(parsed.nextRunAt.toISOString()).toBe("2026-01-01T12:34:30.000Z");
	});

	it("rejects unsupported cron syntax", () => {
		expect(() => parseAgentCronSchedule("0 9 * * MON", start)).toThrow("Invalid cron number");
	});
});

describe("parseHeartbeatCommand", () => {
	it("matches the goal-style status and lifecycle commands", () => {
		expect(parseHeartbeatCommand("/heartbeat")).toEqual({ type: "status" });
		expect(parseHeartbeatCommand("/heartbeat status")).toEqual({ type: "status" });
		expect(parseHeartbeatCommand("/heartbeat pause")).toEqual({ type: "pause" });
		expect(parseHeartbeatCommand("/heartbeat resume")).toEqual({ type: "resume" });
		expect(parseHeartbeatCommand("/heartbeat clear")).toEqual({ type: "clear" });
		expect(parseHeartbeatCommand("/heartbeat stop")).toEqual({ type: "clear" });
	});

	it("leaves delivery mode unset when an instruction omits the delivery option", () => {
		expect(parseHeartbeatCommand("/heartbeat check on me")).toEqual({
			type: "set",
			schedule: "every 5m",
			instruction: "check on me",
		});
	});

	it("accepts explicit heartbeat intervals", () => {
		expect(parseHeartbeatCommand("/heartbeat --every 30s check on me")).toEqual({
			type: "set",
			schedule: "every 30s",
			instruction: "check on me",
		});
		expect(parseHeartbeatCommand("/heartbeat every 10m check status")).toEqual({
			type: "set",
			schedule: "every 10m",
			instruction: "check status",
		});
		expect(parseHeartbeatCommand("/heartbeat every 10m -- check status")).toEqual({
			type: "set",
			schedule: "every 10m",
			instruction: "check status",
		});
	});

	it("opts into follow-up delivery via --follow-up before or after the interval", () => {
		expect(parseHeartbeatCommand("/heartbeat check on me --follow-up")).toEqual({
			type: "set",
			schedule: "every 5m",
			instruction: "check on me",
			deliveryMode: "follow_up",
		});
		expect(parseHeartbeatCommand("/heartbeat --follow-up check on me")).toEqual({
			type: "set",
			schedule: "every 5m",
			instruction: "check on me",
			deliveryMode: "follow_up",
		});
		expect(parseHeartbeatCommand("/heartbeat --follow-up --every 30s check on me")).toEqual({
			type: "set",
			schedule: "every 30s",
			instruction: "check on me",
			deliveryMode: "follow_up",
		});
		expect(parseHeartbeatCommand("/heartbeat every 10m --follow-up check status")).toEqual({
			type: "set",
			schedule: "every 10m",
			instruction: "check status",
			deliveryMode: "follow_up",
		});
		expect(parseHeartbeatCommand("/heartbeat --deliver follow_up check status")).toEqual({
			type: "set",
			schedule: "every 5m",
			instruction: "check status",
			deliveryMode: "follow_up",
		});
		expect(parseHeartbeatCommand("/heartbeat check status --deliver=follow_up")).toEqual({
			type: "set",
			schedule: "every 5m",
			instruction: "check status",
			deliveryMode: "follow_up",
		});
	});

	it("rejects invalid delivery mode values in delivery flag positions", () => {
		for (const command of [
			"/heartbeat --deliver",
			"/heartbeat --deliver=",
			"/heartbeat check status --deliver",
			"/heartbeat check status --deliver=",
		]) {
			expect(() => parseHeartbeatCommand(command)).toThrow('Heartbeat delivery mode must be "steer" or "follow_up"');
		}
		expect(() => parseHeartbeatCommand("/heartbeat --deliver later check status")).toThrow(
			'Heartbeat delivery mode must be "steer" or "follow_up"',
		);
		expect(() => parseHeartbeatCommand("/heartbeat check status --deliver=later")).toThrow(
			'Heartbeat delivery mode must be "steer" or "follow_up"',
		);
		expect(() => parseHeartbeatCommand("/heartbeat every 10m --deliver later check status")).toThrow(
			'Heartbeat delivery mode must be "steer" or "follow_up"',
		);
	});

	it("keeps delivery-like flags in the middle of an instruction as instruction text", () => {
		expect(parseHeartbeatCommand("/heartbeat remind me to mention --follow-up in docs")).toEqual({
			type: "set",
			schedule: "every 5m",
			instruction: "remind me to mention --follow-up in docs",
		});
	});

	it("accepts an explicit --steer flag that keeps the default delivery mode", () => {
		expect(parseHeartbeatCommand("/heartbeat --steer check on me")).toEqual({
			type: "set",
			schedule: "every 5m",
			instruction: "check on me",
			deliveryMode: "steer",
		});
	});
});

describe("AgentCronJobStore", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists, reloads, and cancels jobs", async () => {
		const storePath = makeStorePath(tempDirs);
		const store = new AgentCronJobStore(storePath);
		const job = await store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1h",
			prompt: "check the long run",
			now: start,
		});

		expect(job.nextRunAt).toBe("2026-01-01T13:34:00.000Z");
		expect(new AgentCronJobStore(storePath).list()).toMatchObject([
			{
				id: job.id,
				status: "active",
				prompt: "check the long run",
			},
		]);

		const cancelled = await store.cancel(job.id, new Date("2026-01-01T12:40:00.000Z"));

		expect(cancelled).toMatchObject({ id: job.id, status: "cancelled" });
		expect(store.list()[0]).toMatchObject({ id: job.id, status: "cancelled" });
		expect(store.list()[0]).not.toHaveProperty("nextRunAt");
	});

	it("isolates worker-owned jobs in registered session artifact stores", async () => {
		const root = makeTempDir(tempDirs);
		const firstArtifactDir = join(root, "session-artifacts", "session-1");
		const secondArtifactDir = join(root, "session-artifacts", "session-2");
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact("session-1", firstArtifactDir);
		store.registerSessionArtifact("session-2", secondArtifactDir);
		const first = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: join(root, "sessions", "session-1.jsonl"),
			cwd: root,
			scheduleText: "every 5m",
			prompt: "first heartbeat",
			now: start,
		});
		const second = await store.createHeartbeat({
			activeSessionId: "active-2",
			sessionId: "session-2",
			sessionFile: join(root, "sessions", "session-2.jsonl"),
			cwd: root,
			scheduleText: "every 5m",
			prompt: "second heartbeat",
			now: start,
		});

		const firstOnly = AgentCronJobStore.forSessionArtifacts();
		firstOnly.registerSessionArtifact("session-1", firstArtifactDir);
		expect(firstOnly.list().map((job) => job.id)).toEqual([first.id]);
		expect(firstOnly.list().map((job) => job.id)).not.toContain(second.id);
		expect(existsSync(join(firstArtifactDir, SESSION_SCHEDULED_JOBS_FILENAME))).toBe(true);
		expect(existsSync(join(secondArtifactDir, SESSION_SCHEDULED_JOBS_FILENAME))).toBe(true);
		expect(join(firstArtifactDir, SESSION_SCHEDULED_JOBS_FILENAME)).not.toBe(
			join(secondArtifactDir, SESSION_SCHEDULED_JOBS_FILENAME),
		);
	});

	it("moves active-session jobs to the replacement session artifact store", async () => {
		const root = makeTempDir(tempDirs);
		const firstArtifactDir = join(root, "session-artifacts", "session-1");
		const secondArtifactDir = join(root, "session-artifacts", "session-2");
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact("session-1", firstArtifactDir);
		store.registerSessionArtifact("session-2", secondArtifactDir);
		const heartbeat = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: join(root, "sessions", "session-1.jsonl"),
			cwd: root,
			scheduleText: "every 5m",
			prompt: "follow the active root",
			now: start,
		});

		await store.rebindSessionJobs({
			activeSessionId: "active-1",
			sessionId: "session-2",
			sessionFile: join(root, "sessions", "session-2.jsonl"),
			cwd: root,
		});

		const firstOnly = AgentCronJobStore.forSessionArtifacts();
		firstOnly.registerSessionArtifact("session-1", firstArtifactDir);
		expect(firstOnly.list()).toEqual([]);
		const secondOnly = AgentCronJobStore.forSessionArtifacts();
		secondOnly.registerSessionArtifact("session-2", secondArtifactDir);
		expect(secondOnly.list()).toEqual([
			expect.objectContaining({ id: heartbeat.id, sessionId: "session-2", activeSessionId: "active-1" }),
		]);
	});

	it("migrates the legacy global store into per-session artifact stores", async () => {
		const root = makeTempDir(tempDirs);
		const legacyPath = join(root, "cron-jobs.json");
		const legacy = new AgentCronJobStore(legacyPath);
		const first = await legacy.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: join(root, "sessions", "session-1.jsonl"),
			cwd: root,
			scheduleText: "in 1h",
			prompt: "first migrated job",
			now: start,
		});
		const second = await legacy.create({
			activeSessionId: "active-2",
			sessionId: "session-2",
			sessionFile: join(root, "sessions", "session-2.jsonl"),
			cwd: root,
			scheduleText: "in 2h",
			prompt: "second migrated job",
			now: start,
		});

		expect(migrateLegacyCronJobsToSessionArtifacts(legacyPath)).toBe(2);
		expect(existsSync(legacyPath)).toBe(false);
		const migrated = AgentCronJobStore.forSessionArtifacts();
		migrated.registerSessionArtifact("session-1", join(root, "session-artifacts", "session-1"));
		migrated.registerSessionArtifact("session-2", join(root, "session-artifacts", "session-2"));
		expect(migrated.list().map((job) => job.id)).toEqual(expect.arrayContaining([first.id, second.id]));
	});

	it("marks in-flight legacy dispatches interrupted during migration", async () => {
		const root = makeTempDir(tempDirs);
		const legacyPath = join(root, "cron-jobs.json");
		const legacy = new AgentCronJobStore(legacyPath);
		const heartbeat = await legacy.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: join(root, "sessions", "session-1.jsonl"),
			cwd: root,
			scheduleText: "every 10s",
			prompt: "migrated heartbeat",
			now: start,
		});
		await legacy.claimDue(new Date("2026-01-01T12:34:10.000Z"));

		expect(
			migrateLegacyCronJobsToSessionArtifacts(legacyPath, {
				now: new Date("2026-01-01T12:34:11.000Z"),
			}),
		).toBe(1);
		const migrated = AgentCronJobStore.forSessionArtifacts();
		migrated.registerSessionArtifact("session-1", join(root, "session-artifacts", "session-1"));
		expect(migrated.list()).toEqual([
			expect.objectContaining({
				id: heartbeat.id,
				lastError: "Interrupted before scheduled operation completion",
				nextRunAt: "2026-01-01T12:34:20.000Z",
			}),
		]);
	});

	it("keeps overdue jobs eligible for the scheduler after restart", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		await store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1m",
			prompt: "check the long run",
			now: start,
		});

		expect(store.nextActiveRunAt()?.toISOString()).toBe("2026-01-01T12:35:00.000Z");
	});

	it("keeps one persistent heartbeat per active session", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const first = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 30s",
			prompt: "check on me",
			now: start,
		});
		const second = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "continue the work",
			now: new Date("2026-01-01T12:35:00.000Z"),
		});

		expect(store.getHeartbeat("active-1")).toMatchObject({ id: second.id, prompt: "continue the work" });
		expect(store.list().find((job) => job.id === first.id)).toMatchObject({ status: "cancelled" });
	});

	it("keeps one heartbeat when two creates for a session overlap", async () => {
		const root = makeTempDir(tempDirs);
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact("session-1", join(root, "artifacts", "session-1"));
		const input = {
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 5m",
		};
		await Promise.all([
			store.createHeartbeat({ ...input, prompt: "first", now: start }),
			store.createHeartbeat({ ...input, prompt: "second", now: new Date("2026-01-01T12:35:00.000Z") }),
		]);

		expect(
			store
				.list()
				.map((job) => job.status)
				.sort(),
		).toEqual(["active", "cancelled"]);
	});

	it("keeps a claimed dispatch with its job when another catalog write lands", async () => {
		const root = makeTempDir(tempDirs);
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact("session-1", join(root, "artifacts", "session-1"));
		const heartbeat = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 10s",
			prompt: "check progress",
			now: start,
		});
		const oneShot = await store.create({
			activeSessionId: "active-2",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1h",
			prompt: "one shot",
			now: start,
		});

		const [dispatch] = await store.claimDue(new Date("2026-01-01T12:34:10.000Z"));
		if (!dispatch) throw new Error("Expected heartbeat dispatch");
		await store.cancel(oneShot.id);

		expect(store.getClaimedJob(heartbeat.id)).toBeDefined();
		expect(await store.recordDispatchResult(dispatch.id, { outcome: "ran" })).toMatchObject({
			id: heartbeat.id,
			runCount: 1,
		});
	});

	it("defaults heartbeats to steer delivery and persists an explicit follow_up opt-out", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const steerHeartbeat = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "steer by default",
			now: start,
		});
		expect(steerHeartbeat.deliveryMode).toBe("steer");

		const followUpHeartbeat = await store.createHeartbeat({
			activeSessionId: "active-2",
			sessionId: "session-2",
			sessionFile: "/tmp/session-2.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "queue as follow-up",
			deliveryMode: "follow_up",
			now: start,
		});
		expect(followUpHeartbeat.deliveryMode).toBe("follow_up");
		expect(store.getHeartbeat("active-2")).toMatchObject({ deliveryMode: "follow_up" });
	});

	it("defaults RLM heartbeats to steer delivery and updates the delivery mode", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const rlmHeartbeat = await store.createRlmHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "watch progress",
			now: start,
		});
		expect(rlmHeartbeat.deliveryMode).toBe("steer");

		const updated = await store.updateRlmHeartbeat("active-1", rlmHeartbeat.id, {
			deliveryMode: "follow_up",
			now: new Date("2026-01-01T12:35:00.000Z"),
		});
		expect(updated).toMatchObject({ id: rlmHeartbeat.id, deliveryMode: "follow_up" });
		expect(store.listRlmHeartbeats("active-1")[0]).toMatchObject({ deliveryMode: "follow_up" });
	});

	it("pauses, resumes, and clears heartbeat state", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 30s",
			prompt: "check on me",
			now: start,
		});

		expect(await store.pauseHeartbeat("active-1", new Date("2026-01-01T12:34:10.000Z"))).toMatchObject({
			id: job.id,
			status: "paused",
		});
		expect(store.getHeartbeat("active-1")).not.toHaveProperty("nextRunAt");
		expect(await store.resumeHeartbeat("active-1", new Date("2026-01-01T12:35:00.000Z"))).toMatchObject({
			id: job.id,
			status: "active",
			nextRunAt: "2026-01-01T12:35:30.000Z",
		});
		expect(await store.clearHeartbeat("active-1", new Date("2026-01-01T12:36:00.000Z"))).toMatchObject({
			id: job.id,
			status: "cancelled",
		});
		expect(store.getHeartbeat("active-1")).toBeUndefined();
		expect(store.getLatestHeartbeat("active-1")).toMatchObject({ id: job.id, status: "cancelled" });
	});

	it("rejects one-shot heartbeat schedules", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));

		await expect(
			store.createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: "/tmp/session.jsonl",
				cwd: "/tmp/project",
				scheduleText: "in 5m",
				prompt: "check on me",
				now: start,
			}),
		).rejects.toThrow("Heartbeat schedule must be recurring");
	});

	it("rebinds persisted session jobs to a new daemon active session id", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const userHeartbeat = await store.createHeartbeat({
			activeSessionId: "old-active",
			sessionId: "old-session",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "check on the user",
			now: start,
		});
		const rlmHeartbeat = await store.createRlmHeartbeat({
			activeSessionId: "old-active",
			sessionId: "old-session",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			label: "review",
			scheduleText: "every 10m",
			prompt: "review the latest output",
			now: start,
		});
		await store.createHeartbeat({
			activeSessionId: "other-active",
			sessionId: "other-session",
			sessionFile: "/tmp/other-session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "check on a different session",
			now: start,
		});

		const rebound = await store.rebindSessionJobs({
			activeSessionId: "new-active",
			sessionId: "new-session",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project-restored",
		});

		expect(rebound.map((job) => job.id)).toEqual(expect.arrayContaining([userHeartbeat.id, rlmHeartbeat.id]));
		expect(store.getHeartbeat("old-active")).toBeUndefined();
		expect(store.getHeartbeat("new-active")).toMatchObject({
			id: userHeartbeat.id,
			sessionId: "new-session",
			cwd: "/tmp/project-restored",
		});
		expect(store.listRlmHeartbeats("new-active")[0]).toMatchObject({
			id: rlmHeartbeat.id,
			sessionId: "new-session",
			cwd: "/tmp/project-restored",
		});
		expect(store.getHeartbeat("other-active")).toMatchObject({ prompt: "check on a different session" });
	});

	it("moves live session jobs to a replacement session file", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const cronJob = await store.create({
			activeSessionId: "active-1",
			sessionId: "old-session",
			sessionFile: "/tmp/old-session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1h",
			prompt: "continue the audit",
			now: start,
		});
		const userHeartbeat = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "old-session",
			sessionFile: "/tmp/old-session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "check on the user",
			now: start,
		});
		const rlmHeartbeat = await store.createRlmHeartbeat({
			activeSessionId: "active-1",
			sessionId: "old-session",
			sessionFile: "/tmp/old-session.jsonl",
			cwd: "/tmp/project",
			label: "review",
			scheduleText: "every 10m",
			prompt: "review the latest output",
			now: start,
		});

		const rebound = await store.rebindSessionJobs({
			activeSessionId: "active-1",
			sessionId: "new-session",
			sessionFile: "/tmp/new-session.jsonl",
			cwd: "/tmp/project",
		});

		expect(rebound.map((job) => job.id)).toEqual(
			expect.arrayContaining([cronJob.id, userHeartbeat.id, rlmHeartbeat.id]),
		);
		expect(store.list().filter((job) => job.activeSessionId === "active-1")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: cronJob.id,
					sessionId: "new-session",
					sessionFile: "/tmp/new-session.jsonl",
				}),
				expect.objectContaining({
					id: userHeartbeat.id,
					sessionId: "new-session",
					sessionFile: "/tmp/new-session.jsonl",
				}),
				expect.objectContaining({
					id: rlmHeartbeat.id,
					sessionId: "new-session",
					sessionFile: "/tmp/new-session.jsonl",
				}),
			]),
		);
	});

	it("keeps multiple RLM heartbeats separate from the single user heartbeat", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const userHeartbeat = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "check on the user",
			now: start,
		});
		const firstRlmHeartbeat = await store.createRlmHeartbeat({
			activeSessionId: "rlm-1",
			sessionId: "session-rlm-1",
			sessionFile: "/tmp/session-rlm.jsonl",
			cwd: "/tmp/project",
			label: "tests",
			scheduleText: "every 30s",
			prompt: "rerun focused tests",
			now: start,
		});
		const secondRlmHeartbeat = await store.createRlmHeartbeat({
			activeSessionId: "rlm-1",
			sessionId: "session-rlm-1",
			sessionFile: "/tmp/session-rlm.jsonl",
			cwd: "/tmp/project",
			label: "review",
			scheduleText: "every 10m",
			prompt: "review the latest output",
			now: start,
		});

		expect(store.getHeartbeat("active-1")).toMatchObject({ id: userHeartbeat.id, source: "heartbeat" });
		expect(store.listRlmHeartbeats("active-1")).toEqual([]);
		expect(store.listRlmHeartbeats("rlm-1")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: firstRlmHeartbeat.id, source: "rlm_heartbeat", label: "tests" }),
				expect.objectContaining({ id: secondRlmHeartbeat.id, source: "rlm_heartbeat", label: "review" }),
			]),
		);
		expect(store.getHeartbeat("active-1")).toMatchObject({ id: userHeartbeat.id, status: "active" });
	});

	it("cancels active RLM heartbeats for a released session", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const active = await store.createRlmHeartbeat({
			activeSessionId: "subagent-1",
			sessionId: "session-rlm-1",
			sessionFile: "/tmp/session-rlm.jsonl",
			cwd: "/tmp/project",
			runtimeKind: "subagent",
			label: "active",
			scheduleText: "every 30s",
			prompt: "continue active work",
			now: start,
		});
		const paused = await store.createRlmHeartbeat({
			activeSessionId: "subagent-1",
			sessionId: "session-rlm-1",
			sessionFile: "/tmp/session-rlm.jsonl",
			cwd: "/tmp/project",
			runtimeKind: "subagent",
			label: "paused",
			scheduleText: "every 10m",
			prompt: "continue paused work",
			now: start,
		});
		await store.updateRlmHeartbeat("subagent-1", paused.id, { status: "pause", now: start });
		await store.createRlmHeartbeat({
			activeSessionId: "top-level-1",
			sessionId: "top-level-session",
			sessionFile: "/tmp/top-level.jsonl",
			cwd: "/tmp/project",
			runtimeKind: "top-level",
			label: "top-level",
			scheduleText: "every 5m",
			prompt: "continue top-level work",
			now: start,
		});

		const cancelled = await store.cancelRlmHeartbeatsForSession("subagent-1", new Date("2026-01-01T12:40:00.000Z"));

		expect(cancelled.map((job) => job.id)).toEqual(expect.arrayContaining([active.id, paused.id]));
		expect(store.listRlmHeartbeats("subagent-1")).toEqual([]);
		expect(store.listRlmHeartbeats("subagent-1", { includeInactive: true })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: active.id, status: "cancelled" }),
				expect.objectContaining({ id: paused.id, status: "cancelled" }),
			]),
		);
		expect(store.listRlmHeartbeats("top-level-1")[0]).toMatchObject({ status: "active" });
	});

	it("cancels active and paused jobs for a removed session", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const sessionFile = "/tmp/session-to-remove.jsonl";
		const cron = await store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile,
			cwd: "/tmp/project",
			scheduleText: "in 1h",
			prompt: "check the long run",
			now: start,
		});
		const heartbeat = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile,
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "continue the session",
			now: start,
		});
		await store.pauseHeartbeat("active-1", new Date("2026-01-01T12:35:00.000Z"));
		const rlmHeartbeat = await store.createRlmHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile,
			cwd: "/tmp/project",
			runtimeKind: "top-level",
			label: "rlm",
			scheduleText: "every 10m",
			prompt: "continue internal work",
			now: start,
		});
		const unrelated = await store.create({
			activeSessionId: "active-2",
			sessionId: "session-2",
			sessionFile: "/tmp/other-session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 2h",
			prompt: "keep other session alive",
			now: start,
		});

		const cancelled = await store.cancelJobsForSession(
			{ sessionId: "session-1" },
			new Date("2026-01-01T12:40:00.000Z"),
		);

		expect(cancelled.map((job) => job.id)).toEqual(expect.arrayContaining([cron.id, heartbeat.id, rlmHeartbeat.id]));
		for (const id of [cron.id, heartbeat.id, rlmHeartbeat.id]) {
			expect(store.list().find((job) => job.id === id)).toMatchObject({
				status: "cancelled",
				updatedAt: "2026-01-01T12:40:00.000Z",
			});
			expect(store.list().find((job) => job.id === id)).not.toHaveProperty("nextRunAt");
		}
		expect(store.list().find((job) => job.id === unrelated.id)).toMatchObject({ status: "active" });
	});

	it("returns undefined when updating inactive RLM heartbeats", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const rlmHeartbeat = await store.createRlmHeartbeat({
			activeSessionId: "rlm-1",
			sessionId: "session-rlm-1",
			sessionFile: "/tmp/session-rlm.jsonl",
			cwd: "/tmp/project",
			label: "tests",
			scheduleText: "every 30s",
			prompt: "rerun focused tests",
			now: start,
		});
		await store.deleteRlmHeartbeat("rlm-1", rlmHeartbeat.id, new Date("2026-01-01T12:35:00.000Z"));

		expect(
			await store.updateRlmHeartbeat("rlm-1", rlmHeartbeat.id, {
				prompt: "try to update cancelled heartbeat",
				now: new Date("2026-01-01T12:36:00.000Z"),
			}),
		).toBeUndefined();
		expect(store.listRlmHeartbeats("rlm-1", { includeInactive: true })[0]).toMatchObject({
			id: rlmHeartbeat.id,
			status: "cancelled",
			prompt: "rerun focused tests",
		});
	});

	it("updates and deletes only RLM heartbeats in the matching RLM session", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const userHeartbeat = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "check on the user",
			now: start,
		});
		const rlmHeartbeat = await store.createRlmHeartbeat({
			activeSessionId: "rlm-1",
			sessionId: "session-rlm-1",
			sessionFile: "/tmp/session-rlm.jsonl",
			cwd: "/tmp/project",
			label: "tests",
			scheduleText: "every 30s",
			prompt: "rerun focused tests",
			now: start,
		});

		expect(
			await store.updateRlmHeartbeat("active-1", userHeartbeat.id, {
				prompt: "try to mutate user heartbeat",
				now: new Date("2026-01-01T12:35:00.000Z"),
			}),
		).toBeUndefined();
		expect(
			await store.updateRlmHeartbeat("rlm-2", rlmHeartbeat.id, {
				prompt: "try wrong RLM session",
				now: new Date("2026-01-01T12:35:00.000Z"),
			}),
		).toBeUndefined();

		const updated = await store.updateRlmHeartbeat("rlm-1", rlmHeartbeat.id, {
			label: "focused-tests",
			prompt: "rerun focused tests and inspect failures",
			scheduleText: "every 10m",
			status: "pause",
			now: new Date("2026-01-01T12:35:00.000Z"),
		});

		expect(updated).toMatchObject({
			id: rlmHeartbeat.id,
			label: "focused-tests",
			prompt: "rerun focused tests and inspect failures",
			status: "paused",
			schedule: { expression: "every 10m" },
		});
		expect(updated).not.toHaveProperty("nextRunAt");
		expect(store.getHeartbeat("active-1")).toMatchObject({
			id: userHeartbeat.id,
			prompt: "check on the user",
			status: "active",
		});

		expect(await store.deleteRlmHeartbeat("active-1", userHeartbeat.id)).toBeUndefined();
		expect(
			await store.deleteRlmHeartbeat("rlm-1", rlmHeartbeat.id, new Date("2026-01-01T12:36:00.000Z")),
		).toMatchObject({
			id: rlmHeartbeat.id,
			status: "cancelled",
		});
		expect(store.listRlmHeartbeats("rlm-1")).toEqual([]);
		expect(store.listRlmHeartbeats("rlm-1", { includeInactive: true })[0]).toMatchObject({
			id: rlmHeartbeat.id,
			status: "cancelled",
		});
	});
});

describe("AgentCronScheduler", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs due one-shot jobs and marks them completed", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = await store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1m",
			prompt: "continue the audit",
			now: start,
		});
		const prompts: string[] = [];
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:35:00.000Z"),
			runJob: async (dueJob) => {
				prompts.push(dueJob.prompt);
				return undefined;
			},
		});

		await scheduler.runDue(new Date("2026-01-01T12:35:00.000Z"));

		expect(prompts).toEqual(["continue the audit"]);
		expect(store.list()[0]).toMatchObject({
			id: job.id,
			status: "completed",
			runCount: 1,
			lastRunAt: "2026-01-01T12:35:00.000Z",
		});
		expect(store.list()[0]).not.toHaveProperty("nextRunAt");
	});

	it("does not claim new jobs after a started scheduler is stopped", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = await store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1m",
			prompt: "do not claim",
			now: start,
		});
		const runJob = vi.fn(async () => undefined);
		const scheduler = new AgentCronScheduler(store, { runJob });
		scheduler.start();
		scheduler.stop();

		expect(await scheduler.runDue(new Date("2026-01-01T12:35:00.000Z"))).toBe(0);
		expect(runJob).not.toHaveBeenCalled();
		expect(store.list()[0]).toMatchObject({ id: job.id, status: "active", runCount: 0 });
	});

	it("releases leases and recovers the whole claimed batch when setup fails", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const unrelated = await store.create({
			activeSessionId: "unrelated",
			sessionId: "unrelated",
			sessionFile: "/tmp/unrelated.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 10s",
			prompt: "unrelated",
			now: start,
		});
		const [unrelatedDispatch] = await store.claimDue(new Date("2026-01-01T12:34:10.000Z"));
		if (!unrelatedDispatch) throw new Error("Expected unrelated dispatch");
		const createBatchJob = (activeSessionId: string) =>
			store.create({
				activeSessionId,
				sessionId: activeSessionId,
				sessionFile: `/tmp/${activeSessionId}.jsonl`,
				cwd: "/tmp/project",
				scheduleText: "in 1m",
				prompt: activeSessionId,
				now: start,
			});
		const batch = [
			await createBatchJob("active-1"),
			await createBatchJob("active-2"),
			await createBatchJob("active-3"),
		];
		const endDispatch = vi.fn();
		const beginDispatch = vi.fn((dispatch) => {
			if (dispatch.job.activeSessionId === "active-2") throw new Error("lease setup failed");
			return endDispatch;
		});
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:35:00.000Z"),
			runJob: vi.fn(async () => undefined),
			beginDispatch,
		});

		await expect(scheduler.runDue(new Date("2026-01-01T12:35:00.000Z"))).rejects.toThrow("lease setup failed");
		expect(beginDispatch).toHaveBeenCalledTimes(2);
		expect(endDispatch).toHaveBeenCalledOnce();
		for (const job of batch) {
			expect(store.getClaimedJob(job.id)).toBeUndefined();
			expect(store.list().find((candidate) => candidate.id === job.id)).toMatchObject({
				status: "completed",
				lastError: "Interrupted before scheduled operation completion",
			});
		}
		expect(store.getClaimedJob(unrelated.id)).toMatchObject({ id: unrelated.id });
		expect(await store.recordDispatchResult(unrelatedDispatch.id, { outcome: "ran" })).toMatchObject({
			id: unrelated.id,
		});
	});

	it("reschedules recurring jobs after each run", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		await store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "* * * * *",
			prompt: "poll status",
			now: new Date("2026-01-01T12:34:00.000Z"),
		});
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:35:00.000Z"),
			runJob: async () => undefined,
		});

		await scheduler.runDue(new Date("2026-01-01T12:35:00.000Z"));

		expect(store.list()[0]).toMatchObject({
			status: "active",
			runCount: 1,
			lastRunAt: "2026-01-01T12:35:00.000Z",
			nextRunAt: "2026-01-01T12:36:00.000Z",
		});
	});

	it("reschedules interval heartbeats after each run", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		await store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 30s",
			prompt: "check on me",
			now: start,
		});
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:34:30.000Z"),
			runJob: async () => undefined,
		});

		await scheduler.runDue(new Date("2026-01-01T12:34:30.000Z"));

		expect(store.list()[0]).toMatchObject({
			status: "active",
			runCount: 1,
			lastRunAt: "2026-01-01T12:34:30.000Z",
			nextRunAt: "2026-01-01T12:35:00.000Z",
		});
	});

	it("does not run an RLM heartbeat that was deleted before it became due", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = await store.createRlmHeartbeat({
			activeSessionId: "rlm-1",
			sessionId: "session-rlm-1",
			sessionFile: "/tmp/session-rlm.jsonl",
			cwd: "/tmp/project",
			label: "delete-before-fire",
			scheduleText: "every 30s",
			prompt: "this should never run",
			now: start,
		});
		await store.deleteRlmHeartbeat("rlm-1", job.id, new Date("2026-01-01T12:34:10.000Z"));
		const prompts: string[] = [];
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:34:31.000Z"),
			runJob: async (dueJob) => {
				prompts.push(dueJob.prompt);
				return undefined;
			},
		});

		const handled = await scheduler.runDue(new Date("2026-01-01T12:34:31.000Z"));

		expect(handled).toBe(0);
		expect(prompts).toEqual([]);
		expect(store.listRlmHeartbeats("rlm-1")).toEqual([]);
		expect(store.listRlmHeartbeats("rlm-1", { includeInactive: true })[0]).toMatchObject({
			id: job.id,
			status: "cancelled",
			runCount: 0,
		});
	});

	it("reschedules skipped jobs without recording a run", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const job = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 5m",
			prompt: "check on me",
			now: start,
		});
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:40:00.000Z"),
			runJob: async () => "skipped",
		});

		const handled = await scheduler.runDue(new Date("2026-01-01T12:39:00.000Z"));

		expect(handled).toBe(0);
		expect(store.getHeartbeat("active-1")).toMatchObject({
			id: job.id,
			status: "active",
			nextRunAt: "2026-01-01T12:45:00.000Z",
			lastSkippedAt: "2026-01-01T12:40:00.000Z",
			runCount: 0,
		});
		expect(store.getHeartbeat("active-1")).not.toHaveProperty("lastRunAt");
	});

	it("skips jobs cancelled while earlier due jobs are running", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const first = await store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1m",
			prompt: "first",
			now: start,
		});
		const second = await store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "in 1m",
			prompt: "second",
			now: start,
		});
		const prompts: string[] = [];
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:35:00.000Z"),
			runJob: async (dueJob) => {
				prompts.push(dueJob.prompt);
				if (dueJob.id === first.id) {
					await store.cancel(second.id, new Date("2026-01-01T12:35:00.000Z"));
				}
				return undefined;
			},
		});

		const handled = await scheduler.runDue(new Date("2026-01-01T12:35:00.000Z"));

		expect(handled).toBe(1);
		expect(prompts).toEqual(["first"]);
		expect(store.list()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: first.id, status: "completed", runCount: 1 }),
				expect.objectContaining({ id: second.id, status: "cancelled", runCount: 0 }),
			]),
		);
	});

	it("dispatches different sessions concurrently and advances their schedules before completion", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		for (const index of [1, 2]) {
			await store.createHeartbeat({
				activeSessionId: `active-${index}`,
				sessionId: `session-${index}`,
				sessionFile: `/tmp/session-${index}.jsonl`,
				cwd: "/tmp/project",
				scheduleText: "every 10s",
				prompt: `heartbeat ${index}`,
				now: start,
			});
		}
		const started: string[] = [];
		const releases = new Map<string, () => void>();
		const startedSignals = new Map<string, () => void>();
		const whenBothStarted = Promise.all(
			["active-1", "active-2"].map((id) => new Promise<void>((resolve) => startedSignals.set(id, resolve))),
		);
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:34:10.000Z"),
			runJob: async (job) => {
				started.push(job.activeSessionId);
				startedSignals.get(job.activeSessionId)?.();
				await new Promise<void>((resolve) => releases.set(job.activeSessionId, resolve));
				return undefined;
			},
		});

		const run = scheduler.runDue(new Date("2026-01-01T12:34:10.000Z"));
		// The async lock spans a few I/O ticks; wait for both runJob invocations.
		await whenBothStarted;

		expect(started).toEqual(expect.arrayContaining(["active-1", "active-2"]));
		expect(store.list().map((job) => job.nextRunAt)).toEqual([
			"2026-01-01T12:34:20.000Z",
			"2026-01-01T12:34:20.000Z",
		]);
		for (const release of releases.values()) {
			release();
		}
		await run;
	});

	it("serializes simultaneous jobs that target the same session", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		for (const prompt of ["first", "second"]) {
			await store.create({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: "/tmp/session.jsonl",
				cwd: "/tmp/project",
				scheduleText: "in 1m",
				prompt,
				now: start,
			});
		}
		const started: string[] = [];
		let releaseFirst: () => void = () => {};
		let firstStarted: () => void = () => {};
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:35:00.000Z"),
			runJob: async (job) => {
				started.push(job.prompt);
				if (job.prompt === "first") {
					firstStarted();
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
				return undefined;
			},
		});

		const run = scheduler.runDue(new Date("2026-01-01T12:35:00.000Z"));
		// The async lock spans a few I/O ticks; wait for the first runJob invocation.
		await new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		expect(started).toEqual(["first"]);
		releaseFirst();
		await run;
		expect(started).toEqual(["first", "second"]);
	});

	it("coalesces a missed interval while its previous dispatch is still active", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const heartbeat = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 10s",
			prompt: "check progress",
			now: start,
		});

		expect(await store.claimDue(new Date("2026-01-01T12:34:10.000Z"))).toHaveLength(1);
		expect(await store.claimDue(new Date("2026-01-01T12:34:20.000Z"))).toEqual([]);
		expect(store.list().find((job) => job.id === heartbeat.id)).toMatchObject({
			nextRunAt: "2026-01-01T12:34:30.000Z",
			lastSkippedAt: "2026-01-01T12:34:20.000Z",
			runCount: 0,
		});
	});

	it("reschedules a skipped dispatch from the skip time", async () => {
		const store = new AgentCronJobStore(makeStorePath(tempDirs));
		const heartbeat = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 10s",
			prompt: "check progress",
			now: start,
		});
		const [dispatch] = await store.claimDue(new Date("2026-01-01T12:34:10.000Z"));
		if (!dispatch) {
			throw new Error("Expected heartbeat dispatch");
		}

		await store.recordDispatchResult(dispatch.id, {
			now: new Date("2026-01-01T12:34:17.000Z"),
			outcome: "skipped",
		});

		expect(store.list().find((job) => job.id === heartbeat.id)).toMatchObject({
			nextRunAt: "2026-01-01T12:34:27.000Z",
			lastSkippedAt: "2026-01-01T12:34:17.000Z",
			runCount: 0,
		});
	});

	it("does not replay an uncertain claimed dispatch after recovery", async () => {
		const storePath = makeStorePath(tempDirs);
		const store = new AgentCronJobStore(storePath);
		const heartbeat = await store.createHeartbeat({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			cwd: "/tmp/project",
			scheduleText: "every 10s",
			prompt: "check progress",
			now: start,
		});
		await store.claimDue(new Date("2026-01-01T12:34:10.000Z"));

		const recovered = new AgentCronJobStore(storePath);
		expect(await recovered.recoverInterruptedDispatches(new Date("2026-01-01T12:34:11.000Z"))).toEqual([
			expect.objectContaining({ id: heartbeat.id, lastError: "Interrupted before scheduled operation completion" }),
		]);
		expect(recovered.getClaimedJob(heartbeat.id)).toBeUndefined();
		expect(recovered.getDueJob(heartbeat.id, new Date("2026-01-01T12:34:11.000Z"))).toBeUndefined();
	});

	it("retries a failed startup recovery before the next claim instead of skipping the stale dispatch", async () => {
		vi.useFakeTimers();
		try {
			const store = new AgentCronJobStore(makeStorePath(tempDirs));
			const heartbeat = await store.createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: "/tmp/session.jsonl",
				cwd: "/tmp/project",
				scheduleText: "every 10s",
				prompt: "check progress",
				now: start,
			});
			await store.claimDue(new Date("2026-01-01T12:34:10.000Z"));
			vi.spyOn(store, "recoverInterruptedDispatches").mockRejectedValueOnce(new Error("store busy"));
			const runJob = vi.fn(async () => undefined);
			const scheduler = new AgentCronScheduler(store, { now: () => new Date("2026-01-01T12:34:30.000Z"), runJob });
			scheduler.start();

			await expect(scheduler.runDue(new Date("2026-01-01T12:34:30.000Z"))).rejects.toThrow("store busy");
			expect(store.getClaimedJob(heartbeat.id)).toBeDefined();

			expect(await scheduler.runDue(new Date("2026-01-01T12:34:30.000Z"))).toBe(1);
			expect(runJob).toHaveBeenCalledOnce();
			scheduler.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("shouldDeferHeartbeatCronJob", () => {
	const baseJob: AgentCronJob = {
		id: "job-1",
		status: "active",
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp/project",
		prompt: "check progress",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T12:34:00.000Z",
		updatedAt: "2026-01-01T12:34:00.000Z",
		nextRunAt: "2026-01-01T12:39:00.000Z",
		runCount: 0,
	};

	it("defers follow-up heartbeats while the target session is working", () => {
		for (const source of ["heartbeat", "rlm_heartbeat"] as const) {
			const job = { ...baseJob, source, deliveryMode: "follow_up" as const };

			expect(
				shouldDeferHeartbeatCronJob(job, {
					isStreaming: true,
					isBashRunning: false,
					hasPendingSessionWork: false,
					unfinishedActionCount: 0,
				}),
			).toBe(true);
			expect(
				shouldDeferHeartbeatCronJob(job, {
					isStreaming: false,
					isBashRunning: true,
					hasPendingSessionWork: false,
					unfinishedActionCount: 0,
				}),
			).toBe(true);
			expect(
				shouldDeferHeartbeatCronJob(job, {
					isStreaming: false,
					isBashRunning: false,
					hasPendingSessionWork: false,
					unfinishedActionCount: 1,
				}),
			).toBe(true);
		}
	});

	it("lets steer heartbeats interrupt a plain streaming turn", () => {
		for (const source of ["heartbeat", "rlm_heartbeat"] as const) {
			// Default (undefined) delivery mode is steer.
			for (const job of [
				{ ...baseJob, source },
				{ ...baseJob, source, deliveryMode: "steer" as const },
			]) {
				expect(
					shouldDeferHeartbeatCronJob(job, {
						isStreaming: true,
						isBashRunning: false,
						hasPendingSessionWork: false,
						unfinishedActionCount: 1,
					}),
				).toBe(false);
			}
		}
	});

	it("defers steer heartbeats when delivering would be unsafe or would stack work", () => {
		const job = { ...baseJob, source: "heartbeat" as const, deliveryMode: "steer" as const };

		expect(
			shouldDeferHeartbeatCronJob(job, {
				isStreaming: true,
				isCompacting: true,
				isBashRunning: false,
				hasPendingSessionWork: false,
				unfinishedActionCount: 0,
			}),
		).toBe(true);
		expect(
			shouldDeferHeartbeatCronJob(job, {
				isStreaming: false,
				isBashRunning: true,
				hasPendingSessionWork: false,
				unfinishedActionCount: 0,
			}),
		).toBe(true);
		expect(
			shouldDeferHeartbeatCronJob(job, {
				isStreaming: false,
				isBashRunning: false,
				hasPendingSessionWork: false,
				unfinishedActionCount: 1,
			}),
		).toBe(true);
		expect(
			shouldDeferHeartbeatCronJob(job, {
				isStreaming: false,
				isRetrying: true,
				isBashRunning: false,
				hasPendingSessionWork: false,
				unfinishedActionCount: 0,
			}),
		).toBe(true);
		expect(
			shouldDeferHeartbeatCronJob(job, {
				isStreaming: true,
				isBashRunning: false,
				hasPendingSessionWork: true,
				unfinishedActionCount: 2,
			}),
		).toBe(true);
	});

	it("allows heartbeats when the target session is idle", () => {
		expect(
			shouldDeferHeartbeatCronJob(
				{ ...baseJob, source: "heartbeat" },
				{ isStreaming: false, isBashRunning: false, hasPendingSessionWork: false, unfinishedActionCount: 0 },
			),
		).toBe(false);
	});

	it("does not defer ordinary cron jobs", () => {
		expect(
			shouldDeferHeartbeatCronJob(
				{ ...baseJob, source: "cron" },
				{ isStreaming: true, isBashRunning: true, hasPendingSessionWork: true, unfinishedActionCount: 2 },
			),
		).toBe(false);
	});
});

describe("heartbeat delivery mode", () => {
	it("normalizes valid delivery modes and rejects invalid ones", () => {
		expect(normalizeHeartbeatDeliveryMode(undefined)).toBeUndefined();
		expect(normalizeHeartbeatDeliveryMode(null)).toBeUndefined();
		expect(normalizeHeartbeatDeliveryMode("steer")).toBe("steer");
		expect(normalizeHeartbeatDeliveryMode("follow_up")).toBe("follow_up");
		expect(() => normalizeHeartbeatDeliveryMode("followup")).toThrow(
			'Heartbeat delivery mode must be "steer" or "follow_up"',
		);
	});

	it("resolves delivery mode to a streaming behavior, defaulting to steer", () => {
		expect(resolveHeartbeatStreamingBehavior(undefined)).toBe("steer");
		expect(resolveHeartbeatStreamingBehavior("steer")).toBe("steer");
		expect(resolveHeartbeatStreamingBehavior("follow_up")).toBe("followUp");
	});
});

function makeStorePath(tempDirs: string[]): string {
	const dir = makeTempDir(tempDirs);
	return join(dir, "cron-jobs.json");
}

function makeTempDir(tempDirs: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-cron-"));
	tempDirs.push(dir);
	return dir;
}

// Data-loss guard folded in from the deleted ENG-4519 one-off regression file:
// a due heartbeat must never resurrect a session the user archived or deleted.
describe("AgentCronScheduler session resurrection guard (ENG-4519)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	interface CronDaemonInternals {
		cronStore: AgentCronJobStore;
		cronScheduler: AgentCronScheduler;
		sessions: Map<string, ActiveSessionState>;
	}

	async function createDueHeartbeatDaemon(options: {
		sessionId: (harness: Harness) => string;
		sessionFile: (harness: Harness) => string;
		persistStates?: readonly ("active" | "archived")[];
	}): Promise<{
		harness: Harness;
		internals: CronDaemonInternals;
		createRuntime: ReturnType<typeof vi.fn>;
		jobId: string;
	}> {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		for (const status of options.persistStates ?? []) {
			harness.sessionManager.appendSessionState({ status });
		}
		const createRuntime = vi.fn<CreateAgentSessionRuntimeFactory>(async () => {
			throw new Error("unreachable sessions must not be reopened");
		});
		const daemon = new AgentDaemon(join(harness.tempDir, "daemon.sock"), {
			defaultSessionConfig: {
				agentDir: harness.tempDir,
				cwd: harness.tempDir,
				sessionDir: join(harness.tempDir, "sessions"),
			},
			createRuntime,
		});
		const internals = daemon as unknown as CronDaemonInternals;
		const job = await internals.cronStore.createHeartbeat({
			activeSessionId: "old-active",
			sessionId: options.sessionId(harness),
			sessionFile: options.sessionFile(harness),
			cwd: harness.tempDir,
			scheduleText: "every 10s",
			prompt: "continue scheduled work",
			now: new Date(Date.now() - 20_000),
		});
		return { harness, internals, createRuntime, jobId: job.id };
	}

	it("cancels legacy jobs instead of reopening an archived session", async () => {
		const { harness, internals, createRuntime, jobId } = await createDueHeartbeatDaemon({
			sessionId: (h) => h.session.sessionId,
			sessionFile: (h) => h.session.sessionFile!,
			persistStates: ["active", "archived"],
		});
		const pausedHeartbeat = await internals.cronStore.createRlmHeartbeat({
			activeSessionId: "old-active",
			sessionId: harness.session.sessionId,
			sessionFile: harness.session.sessionFile!,
			cwd: harness.tempDir,
			scheduleText: "every 1m",
			prompt: "check internal work",
			now: new Date(),
		});
		await internals.cronStore.updateRlmHeartbeat("old-active", pausedHeartbeat.id, { status: "pause" });

		await expect(internals.cronScheduler.runDue(new Date())).resolves.toBe(0);

		expect(createRuntime).not.toHaveBeenCalled();
		expect(internals.sessions.size).toBe(0);
		for (const id of [jobId, pausedHeartbeat.id]) {
			expect(internals.cronStore.list().find((job) => job.id === id)).toMatchObject({ status: "cancelled" });
		}
	});

	it("cancels a job without recreating its deleted session file", async () => {
		const deletedSessionFile = (harness: Harness) => join(harness.tempDir, "sessions", "deleted-session.jsonl");
		const { harness, internals, createRuntime, jobId } = await createDueHeartbeatDaemon({
			sessionId: () => "deleted-session",
			sessionFile: deletedSessionFile,
		});

		await expect(internals.cronScheduler.runDue(new Date())).resolves.toBe(0);

		expect(createRuntime).not.toHaveBeenCalled();
		expect(existsSync(deletedSessionFile(harness))).toBe(false);
		expect(internals.sessions.size).toBe(0);
		expect(internals.cronStore.list().find((job) => job.id === jobId)).toMatchObject({ status: "cancelled" });
	});
});

describe("AgentCronJobStore mutation locks", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const holdLock = (path: string) => lock(path, { realpath: false, lockfilePath: `${path}.lock`, stale: 30_000 });

	it("locks only the path a mutation writes", async () => {
		const root = makeTempDir(tempDirs);
		const store = AgentCronJobStore.forSessionArtifacts();
		const seed = async (sessionId: string) => {
			mkdirSync(join(root, "artifacts", sessionId), { recursive: true });
			store.registerSessionArtifact(sessionId, join(root, "artifacts", sessionId));
			return store.create({
				activeSessionId: `active-${sessionId.split("-")[1]}`,
				sessionId,
				sessionFile: `/tmp/${sessionId}.jsonl`,
				cwd: "/tmp/project",
				scheduleText: "every 5m",
				prompt: sessionId,
			});
		};
		const first = await seed("session-1");
		await Promise.all([seed("session-2"), seed("session-3")]);
		const held = await Promise.all(
			["session-2", "session-3"].map((sessionId) =>
				holdLock(join(root, "artifacts", sessionId, SESSION_SCHEDULED_JOBS_FILENAME)),
			),
		);
		try {
			await store.cancel(first.id);
			expect(store.list().find((job) => job.id === first.id)?.status).toBe("cancelled");
			expect(store.list().find((job) => job.id !== first.id)?.status).toBe("active");
		} finally {
			await Promise.all(held.map((release) => release()));
		}
	});

	it("retries a contended lock without blocking the event loop and fsyncs once per write", async () => {
		vi.useFakeTimers();
		try {
			const root = makeTempDir(tempDirs);
			const store = new AgentCronJobStore(join(root, "cron-jobs.json"));
			const writeFileAtomicSync = vi.spyOn(atomicFile, "writeFileAtomicSync");
			const job = await store.create({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: "/tmp/session.jsonl",
				cwd: "/tmp/project",
				scheduleText: "every 5m",
				prompt: "contended",
			});
			const held = await holdLock(join(root, "cron-jobs.json"));
			let settled = false;
			const cancelling = store.cancel(job.id).finally(() => (settled = true));
			await held();
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(50);
			await expect(cancelling).resolves.toMatchObject({ id: job.id, status: "cancelled" });
			for (const options of writeFileAtomicSync.mock.calls.map((call) => call[2])) {
				expect(options).toMatchObject({ fsync: true, mode: 0o600 });
				expect(options).not.toHaveProperty("fsyncDir");
			}
		} finally {
			vi.useRealTimers();
		}
	});
});
