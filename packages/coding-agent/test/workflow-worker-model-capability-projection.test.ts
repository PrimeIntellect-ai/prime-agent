import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import { SessionManager } from "../src/core/session-manager.js";
import { digestObject } from "../src/core/workflow/contracts.js";
import type {
	WorkerModelCapabilityBlocker,
	WorkerModelPolicy,
} from "../src/core/workflow/worker-model-capability-gate.js";
import { createAgentConnectionState } from "../src/modes/agent-connection/snapshot.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { summaryForActiveSession, summaryForInactiveSession } from "../src/modes/daemon/daemon-session-list.js";

const POLICY: WorkerModelPolicy = {
	provider: "openai-codex",
	model: "gpt-5.6-luna",
	reasoning: "max",
	allowFallback: false,
	policyRevision: "policy-7",
};

function makeBlocker(): WorkerModelCapabilityBlocker {
	const blocker: Omit<WorkerModelCapabilityBlocker, "blockerDigest"> & { blockerDigest: string } = {
		kind: "blocked_model_capability",
		workflowId: "workflow-projection",
		taskId: "task-luna",
		goalId: "goal-luna",
		requestedPolicy: POLICY,
		safeReason: "Luna unavailable",
		authRevision: "auth-1",
		capabilityRevision: "capability-1",
		policyRevision: POLICY.policyRevision,
		preflightDigest: "a".repeat(64),
		receiptDigest: "b".repeat(64),
		retryEligible: true,
		retryAt: "2026-08-17T00:01:30.000Z",
		desiredWorkers: 2,
		activeWorkers: 0,
		idleCapacity: 2,
		idleReason: "catalog_unavailable",
		queuedWorkDigest: "c".repeat(64),
		summary: {
			kind: "blocked_model_capability",
			taskId: "task-luna",
			goalId: "goal-luna",
			text: "gpt-5.6-luna unavailable: Luna unavailable",
		},
		projection: {
			kind: "blocked_model_capability",
			workflowId: "workflow-projection",
			taskId: "task-luna",
			goalId: "goal-luna",
			queueState: "queued",
			blockerDigest: "d".repeat(64),
		},
		blockerDigest: "",
	};
	const { blockerDigest: _ignored, ...withoutDigest } = blocker;
	const blockerDigest = digestObject({ ...withoutDigest, projection: { ...blocker.projection, blockerDigest: "" } });
	return { ...blocker, blockerDigest, projection: { ...blocker.projection, blockerDigest } };
}

function makeSessionInfo(blocker: WorkerModelCapabilityBlocker): SessionInfo {
	return {
		path: "/tmp/model-projection.jsonl",
		id: "session-model-projection",
		cwd: "/tmp",
		rlmDepth: 0,
		created: new Date("2026-08-17T00:00:00.000Z"),
		modified: new Date("2026-08-17T00:01:00.000Z"),
		messageCount: 2,
		firstMessage: "run the worker",
		allMessagesText: "run the worker",
		agentStatus: {
			summary: "stale summarizer output",
			taskState: "needs_input",
			basedOnMessageCount: 2,
		},
		workerModelCapabilityBlocker: blocker,
	} as unknown as SessionInfo;
}

function makeActiveState(blocker: WorkerModelCapabilityBlocker): ActiveSessionState {
	const session = {
		model: { provider: POLICY.provider, id: POLICY.model },
		thinkingLevel: POLICY.reasoning,
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		sessionFile: "/tmp/model-projection.jsonl",
		sessionId: "session-model-projection",
		rlmDepth: 0,
		sessionName: "model projection",
		getWorkerModelCapabilityBlocker: () => blocker,
		sessionManager: {
			getCwd: () => "/tmp",
			getHeader: () => ({ timestamp: "2026-08-17T00:00:00.000Z" }),
			getSessionDir: () => "/tmp",
			getLeafId: () => "leaf-model-projection",
			getEntries: () => [],
			hasUserContent: () => true,
			getLatestAgentStatus: () => ({ summary: "stale summarizer output" }),
		},
		messages: [{ role: "user", content: "run the worker" }] as unknown as AgentMessage[],
		hasRunningRlmChildren: () => false,
		unfinishedActionCount: 0,
		isSessionActive: false,
		getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
		state: { pendingToolCalls: new Set() },
	};
	return {
		activeSessionId: "active-model-projection",
		clients: new Set(),
		lastEventSequence: 0,
		summaryState: {
			summary: "stale summarizer output",
			taskState: "needs_input",
			basedOnMessageCount: 1,
		},
		runtime: { metadata: { kind: "top-level", createdAt: 1 }, diagnostics: [], session },
	} as unknown as ActiveSessionState;
}

function makeConnectionRuntime(blocker: WorkerModelCapabilityBlocker): AgentSessionRuntime {
	const active = makeActiveState(blocker);
	const session = active.runtime.session as unknown as Record<string, unknown>;
	Object.assign(session, {
		serviceTier: "default",
		getAvailableThinkingLevels: () => ["max"],
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		goalState: undefined,
		scopedModels: [],
		getActiveToolNames: () => [],
		getContextUsage: () => ({ tokens: 0 }),
	});
	return active.runtime as unknown as AgentSessionRuntime;
}

it("projects the durable Luna blocker over stale needs_input in list and attach state", () => {
	const blocker = makeBlocker();
	const inactive = summaryForInactiveSession(makeSessionInfo(blocker));
	const active = summaryForActiveSession(makeActiveState(blocker));
	const snapshot = createAgentConnectionState(makeConnectionRuntime(blocker), "active-model-projection");

	for (const projection of [inactive, active]) {
		expect(projection).toMatchObject({
			workerModelCapabilityBlocker: {
				kind: "blocked_model_capability",
				requestedPolicy: POLICY,
				safeReason: "Luna unavailable",
				taskId: "task-luna",
				goalId: "goal-luna",
				retryEligible: true,
			},
			taskState: "blocked_model_capability",
		});
		expect(projection.taskState).not.toBe("needs_input");
	}
	expect(snapshot.workerModelCapabilityBlocker).toEqual(blocker);
});

it("reconstructs the blocker from the public session file after a restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "worker-model-projection-restart-"));
	try {
		const sessionDir = join(root, "sessions");
		const manager = SessionManager.create(root, sessionDir);
		manager.materializeSessionFile();
		const blocker = makeBlocker();
		manager.appendAgentStatus({
			summary: "stale summarizer output",
			taskState: "needs_input",
			basedOnMessageCount: 0,
		});
		manager.appendWorkerModelCapabilityBlocker(blocker);

		const restarted = await SessionManager.list(root, sessionDir);
		expect(restarted).toHaveLength(1);
		const summary = summaryForInactiveSession(restarted[0]!);
		expect(summary).toMatchObject({
			taskState: "blocked_model_capability",
			workerModelCapabilityBlocker: blocker,
		});
		expect(summary.taskState).not.toBe("needs_input");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
