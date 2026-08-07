import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentCronJob,
	AgentCronJobStore,
	AgentCronScheduler,
	formatAgentCronJob,
} from "../../../src/core/cron-jobs.js";
import { formatHeartbeatPromptContent } from "../../../src/core/messages.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

const START = new Date("2026-01-01T12:00:00.000Z");

function createStore(tempDirs: string[]): AgentCronJobStore {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-820-"));
	tempDirs.push(dir);
	return new AgentCronJobStore(join(dir, "cron-jobs.json"));
}

function createEveryFiveMinuteHeartbeat(store: AgentCronJobStore): AgentCronJob {
	return store.createHeartbeat({
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp/project",
		scheduleText: "every 5m",
		prompt: "Report which heartbeat number this is and what changed since the previous one.",
		now: START,
	});
}

function heartbeatJob(overrides: Partial<AgentCronJob> = {}): AgentCronJob {
	return {
		id: "heartbeat-1",
		status: "active",
		source: "heartbeat",
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp/project",
		prompt: "Report which heartbeat number this is and what changed since the previous one.",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: START.toISOString(),
		updatedAt: START.toISOString(),
		nextRunAt: "2026-01-01T12:05:00.000Z",
		runCount: 0,
		...overrides,
	};
}

/**
 * A heartbeat that came due while its session was busy was consumed and lost:
 * `claimDueInState` advanced `nextRunAt` before the busy check, and the skip branch
 * advanced it again from the skip time. Nothing counted the swallowed fires, and the
 * delivered prompt was byte-identical on every beat, so the agent could not tell
 * "beat 3 of 3" from "beat 3 of 40".
 */
describe("issue #820 heartbeat fires skipped on a busy session", () => {
	const tempDirs: string[] = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("keeps the schedule phase and counts the fire when a beat is declined", async () => {
		const store = createStore(tempDirs);
		const job = createEveryFiveMinuteHeartbeat(store);
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:06:30.000Z"),
			runJob: async () => "skipped",
		});

		await scheduler.runDue(new Date("2026-01-01T12:05:00.000Z"));

		expect(store.list().find((candidate) => candidate.id === job.id)).toMatchObject({
			// Advancing from the skipped beat (12:05) instead of the skip time (12:06:30)
			// keeps "every 5m" on its original phase.
			nextRunAt: "2026-01-01T12:10:00.000Z",
			missedRunCount: 1,
			runCount: 0,
		});
	});

	it("coalesces every fire swallowed by a long busy window into one count", async () => {
		const store = createStore(tempDirs);
		const job = createEveryFiveMinuteHeartbeat(store);
		// The beat due at 12:05 is declined 22 minutes later, so 12:10, 12:15 and 12:20
		// also came and went while the session stayed busy.
		const scheduler = new AgentCronScheduler(store, {
			now: () => new Date("2026-01-01T12:27:00.000Z"),
			runJob: async () => "skipped",
		});

		await scheduler.runDue(new Date("2026-01-01T12:05:00.000Z"));

		const skipped = store.list().find((candidate) => candidate.id === job.id);
		expect(skipped).toMatchObject({ missedRunCount: 5, runCount: 0 });
		// The re-armed fire is always in the future, so a busy session cannot make the
		// scheduler spin on an already-due job.
		expect(Date.parse(skipped!.nextRunAt!)).toBeGreaterThan(Date.parse("2026-01-01T12:27:00.000Z"));
	});

	it("accumulates across skips and clears the backlog once a beat is delivered", async () => {
		const store = createStore(tempDirs);
		const job = createEveryFiveMinuteHeartbeat(store);

		const [firstDispatch] = store.claimDue(new Date("2026-01-01T12:05:00.000Z"));
		store.recordDispatchResult(firstDispatch.id, {
			now: new Date("2026-01-01T12:06:00.000Z"),
			outcome: "skipped",
		});
		const [secondDispatch] = store.claimDue(new Date("2026-01-01T12:10:00.000Z"));
		store.recordDispatchResult(secondDispatch.id, {
			now: new Date("2026-01-01T12:11:00.000Z"),
			outcome: "skipped",
		});

		expect(store.list().find((candidate) => candidate.id === job.id)).toMatchObject({ missedRunCount: 2 });

		const [thirdDispatch] = store.claimDue(new Date("2026-01-01T12:15:00.000Z"));
		store.recordDispatchResult(thirdDispatch.id, {
			now: new Date("2026-01-01T12:15:30.000Z"),
			outcome: "ran",
		});

		const delivered = store.list().find((candidate) => candidate.id === job.id);
		expect(delivered).toMatchObject({ runCount: 1 });
		expect(delivered).not.toHaveProperty("missedRunCount");
	});

	it("reports the backlog in the daemon job listing", () => {
		expect(formatAgentCronJob(heartbeatJob())).not.toContain("missed=");
		expect(
			formatAgentCronJob(heartbeatJob({ missedRunCount: 3, lastSkippedAt: "2026-01-01T12:20:00.000Z" })),
		).toContain("missed=3");
	});

	it("puts the beat number, previous delivery, and skipped fires in the delivered text", () => {
		const first = formatHeartbeatPromptContent(heartbeatJob());
		expect(first).toContain("beat 1");
		expect(first).toContain("schedule every 5m");
		expect(first).toContain("first delivery");
		expect(first).not.toContain("skipped");
		expect(first.endsWith(heartbeatJob().prompt)).toBe(true);

		const later = formatHeartbeatPromptContent(
			heartbeatJob({
				runCount: 2,
				lastRunAt: "2026-01-01T12:05:00.000Z",
				missedRunCount: 2,
				lastSkippedAt: "2026-01-01T12:15:00.000Z",
			}),
		);
		expect(later).toContain("beat 3");
		expect(later).toContain("previous delivery 2026-01-01T12:05:00.000Z");
		expect(later).toContain("2 scheduled fires skipped while this session was busy");
		expect(later).toContain("most recent 2026-01-01T12:15:00.000Z");

		expect(formatHeartbeatPromptContent(heartbeatJob({ missedRunCount: 1 }))).toContain("1 scheduled fire skipped");
	});

	it("delivers the backlog notice to the model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let providerMessages: Message[] = [];
		harness.setResponses([
			(context) => {
				providerMessages = [...context.messages];
				return fauxAssistantMessage("heartbeat handled");
			},
		]);

		await harness.session.promptHeartbeat(
			heartbeatJob({
				runCount: 2,
				lastRunAt: "2026-01-01T12:05:00.000Z",
				missedRunCount: 2,
				lastSkippedAt: "2026-01-01T12:15:00.000Z",
			}),
		);

		const delivered = getMessageText(providerMessages.at(-1));
		expect(delivered).toContain("beat 3");
		expect(delivered).toContain("2 scheduled fires skipped while this session was busy");
		expect(delivered).toContain("Report which heartbeat number this is");
	});
});
