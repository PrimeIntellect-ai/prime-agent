import { describe, expect, it, vi } from "vitest";
import type { AgentCronJob, AgentHeartbeatManagementAction } from "../src/core/cron-jobs.js";
import type {
	AgentConnectionHeartbeat,
	AgentConnectionRlmChildAgentSnapshot,
} from "../src/modes/agent-connection/types.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

interface HeartbeatManagementHarness {
	heartbeatCatalog: AgentConnectionHeartbeat[];
	heartbeats: AgentConnectionHeartbeat[];
	agentConnection: {
		manageHeartbeat(
			activeSessionId: string,
			jobId: string,
			action: AgentHeartbeatManagementAction,
		): Promise<AgentCronJob>;
	};
	connectionState: { activeSessionId: string };
	patchConnectionState(patch: { heartbeat: AgentCronJob | null }): void;
	applyHeartbeatCatalog(heartbeats: AgentConnectionHeartbeat[]): void;
	refreshHeartbeatCatalog(): Promise<void>;
	manageHeartbeat(heartbeat: AgentConnectionHeartbeat, action: AgentHeartbeatManagementAction): Promise<void>;
}

interface HeartbeatScopeHarness {
	heartbeatCatalog: AgentConnectionHeartbeat[];
	heartbeats: AgentConnectionHeartbeat[];
	connectionState: { activeSessionId: string; sessionId: string };
	subagentSnapshots: Map<string, AgentConnectionRlmChildAgentSnapshot>;
	heartbeatManager: { setHeartbeats(heartbeats: AgentConnectionHeartbeat[]): void } | undefined;
	ui: { requestRender(): void };
	scheduleHeartbeatManagerRefresh(): void;
	updateSubagentSummaryLine(): void;
	applyHeartbeatCatalog(heartbeats: AgentConnectionHeartbeat[]): void;
}

interface ChildIdentityUpdateHarness {
	subagentSnapshots: Map<string, AgentConnectionRlmChildAgentSnapshot>;
	refreshSubagentSummary(): void;
	updateSubagentSummary(child: AgentConnectionRlmChildAgentSnapshot): void;
}

interface HeartbeatRefreshHarness {
	heartbeats: AgentConnectionHeartbeat[];
	heartbeatManager: object | undefined;
	heartbeatManagerRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	refreshHeartbeatCatalog(): Promise<void>;
	scheduleHeartbeatManagerRefresh(): void;
}

function heartbeat(overrides: Partial<AgentCronJob> = {}): AgentCronJob {
	return {
		id: "heartbeat-1",
		status: "active",
		source: "heartbeat",
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp",
		prompt: "check the session",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		nextRunAt: "2026-01-01T00:05:00.000Z",
		runCount: 0,
		...overrides,
	};
}

describe("interactive heartbeat management", () => {
	it("clears local user-heartbeat state after stopping from the manager", async () => {
		const current = heartbeat();
		const stopped = { ...current, status: "cancelled" as const, nextRunAt: undefined };
		const patches: Array<{ heartbeat: AgentCronJob | null }> = [];
		const harness = Object.create(InteractiveMode.prototype) as HeartbeatManagementHarness;
		harness.heartbeats = [{ job: current }];
		harness.heartbeatCatalog = harness.heartbeats;
		harness.connectionState = { activeSessionId: current.activeSessionId };
		harness.agentConnection = {
			manageHeartbeat: vi.fn(async () => stopped),
		};
		harness.patchConnectionState = (patch) => patches.push(patch);
		harness.applyHeartbeatCatalog = vi.fn();
		harness.refreshHeartbeatCatalog = vi.fn(async () => {});

		await harness.manageHeartbeat({ job: current }, "stop");

		expect(patches).toEqual([{ heartbeat: null }]);
		expect(harness.applyHeartbeatCatalog).toHaveBeenCalledWith([]);
		expect(harness.refreshHeartbeatCatalog).toHaveBeenCalledOnce();
	});

	it("keeps a successful action successful when the catalog refresh fails", async () => {
		const current = heartbeat();
		const paused = { ...current, status: "paused" as const, nextRunAt: undefined };
		const harness = Object.create(InteractiveMode.prototype) as HeartbeatManagementHarness;
		harness.heartbeats = [{ job: current, sessionName: "Primary session" }];
		harness.heartbeatCatalog = harness.heartbeats;
		harness.connectionState = { activeSessionId: current.activeSessionId };
		harness.agentConnection = { manageHeartbeat: vi.fn(async () => paused) };
		harness.patchConnectionState = vi.fn();
		harness.applyHeartbeatCatalog = vi.fn();
		harness.refreshHeartbeatCatalog = vi.fn(async () => {
			throw new Error("worker recovering");
		});

		await expect(harness.manageHeartbeat({ job: current, sessionName: "Primary session" }, "pause")).resolves.toBe(
			undefined,
		);

		expect(harness.applyHeartbeatCatalog).toHaveBeenCalledWith([{ job: paused, sessionName: "Primary session" }]);
		expect(harness.refreshHeartbeatCatalog).toHaveBeenCalledOnce();
	});

	it("scopes the catalog to the current session and its subagents", () => {
		const own = { job: heartbeat() };
		const child = {
			job: heartbeat({ id: "heartbeat-2", activeSessionId: "active-2", sessionId: "session-2" }),
		};
		const unrelated = {
			job: heartbeat({ id: "heartbeat-3", activeSessionId: "active-3", sessionId: "session-3" }),
		};
		const harness = Object.create(InteractiveMode.prototype) as HeartbeatScopeHarness;
		harness.heartbeatCatalog = [];
		harness.heartbeats = [];
		harness.connectionState = { activeSessionId: "active-1", sessionId: "session-1" };
		harness.subagentSnapshots = new Map([
			[
				"child-1",
				{
					id: "child-1",
					activeSessionId: "active-2",
					label: "child",
					status: "running",
					sessionDir: "/tmp/child-1",
				},
			],
		]);
		harness.heartbeatManager = { setHeartbeats: vi.fn() };
		harness.ui = { requestRender: vi.fn() };
		harness.scheduleHeartbeatManagerRefresh = vi.fn();
		harness.updateSubagentSummaryLine = vi.fn();

		harness.applyHeartbeatCatalog([own, child, unrelated]);

		expect(harness.heartbeatCatalog).toEqual([own, child, unrelated]);
		expect(harness.heartbeats).toEqual([own, child]);
		expect(harness.heartbeatManager.setHeartbeats).toHaveBeenCalledWith([own, child]);
		expect(harness.updateSubagentSummaryLine).toHaveBeenCalledOnce();
	});

	it("refreshes heartbeat scope when a known subagent gains its active session id", () => {
		const existing: AgentConnectionRlmChildAgentSnapshot = {
			id: "child-1",
			label: "child",
			status: "running",
			sessionDir: "/tmp/child-1",
		};
		const harness = Object.create(InteractiveMode.prototype) as ChildIdentityUpdateHarness;
		harness.subagentSnapshots = new Map([[existing.id, existing]]);
		harness.refreshSubagentSummary = vi.fn();

		harness.updateSubagentSummary({ ...existing, activeSessionId: "active-2" });

		expect(harness.subagentSnapshots.get(existing.id)?.activeSessionId).toBe("active-2");
		expect(harness.refreshSubagentSummary).toHaveBeenCalledOnce();
	});

	it("refreshes an open manager after the next scheduled run", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const harness = Object.create(InteractiveMode.prototype) as HeartbeatRefreshHarness;
			harness.heartbeats = [{ job: { ...heartbeat(), nextRunAt: "2026-01-01T00:00:01.000Z" } }];
			harness.heartbeatManager = {};
			harness.heartbeatManagerRefreshTimer = undefined;
			harness.refreshHeartbeatCatalog = vi.fn(async () => {});

			harness.scheduleHeartbeatManagerRefresh();
			await vi.advanceTimersByTimeAsync(1_250);

			expect(harness.refreshHeartbeatCatalog).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});
