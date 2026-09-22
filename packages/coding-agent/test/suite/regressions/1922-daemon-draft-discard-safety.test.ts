import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand } from "../../../src/modes/daemon/daemon-protocol.js";

// Regression tests for #1922: non-worker draft discards must be best-effort
// (a closeSession rejection must not kill the process), a draft with an
// in-flight attach must not be discarded, and get_rlm_children must return the
// same merged roster (resident + passivated children) as the attach snapshot.

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-1922-"));
	tempDirectories.push(directory);
	return directory;
}

function makeClient(id: string, activeSessionId: string): DaemonSocketClient {
	return {
		id,
		socket: { destroyed: false } as Socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		detachInput: vi.fn(),
		supportsExtensionUi: false,
		capabilities: new Set(),
	} as unknown as DaemonSocketClient;
}

function makeEmptyTopLevelDraft(activeSessionId: string): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set(),
		pendingAttaches: 0,
		lastEventSequence: 0,
		extensionUiRequests: new Map(),
		runtime: {
			metadata: { kind: "top-level", createdAt: 1 },
			session: {
				messages: [],
				isBashRunning: false,
				isSessionActive: false,
				hasRunningRlmChildren: () => false,
				sessionManager: { hasUserContent: () => false },
			},
		},
	} as unknown as ActiveSessionState;
}

interface PassiveChildStub {
	entry: {
		childId: string;
		sessionName: string;
		sessionDir: string;
		prompt?: string;
		model?: { provider: string; modelId: string };
		status: string;
	};
	info: { name?: string };
	chain: Array<{ childId: string }>;
	rootParentState: ActiveSessionState;
}

interface DaemonInternals {
	sessions: Map<string, ActiveSessionState>;
	handleCommand(
		client: DaemonSocketClient,
		command: DaemonCommand,
	): Promise<{
		success: boolean;
		data?: { children?: Array<{ id: string; sessionName: string; status: string }>; eventSequence: number };
	}>;
	broadcastToSession(state: ActiveSessionState, message: unknown): void;
	detachClientFromSession(client: DaemonSocketClient, state: ActiveSessionState): void;
	isDiscardableDraft(state: ActiveSessionState): boolean;
	closeSession(state: ActiveSessionState, reason: "killed"): Promise<void>;
	listPassiveRlmSubagents(): Promise<PassiveChildStub[]>;
	log: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
}

function createDaemon(): { daemon: AgentDaemon; internals: DaemonInternals } {
	const root = tempDirectory();
	const daemon = new AgentDaemon(join(root, "daemon.sock"), {
		defaultSessionConfig: { agentDir: root, cwd: root },
		createRuntime: vi.fn(),
	});
	const internals = daemon as unknown as DaemonInternals;
	internals.log = vi.fn();
	internals.write = vi.fn();
	return { daemon, internals };
}

async function flushAsyncWork(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	// test-policy: allow wall-clock-timer -- pre-policy pattern inherited from main cf07c5a3f era, grandfathered on main
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

function bashEndMessage(state: ActiveSessionState): unknown {
	return {
		type: "session_event",
		activeSessionId: state.activeSessionId,
		event: { type: "bash_end", exitCode: 0, cancelled: false, truncated: false },
	};
}

async function withUnhandledRejectionCapture(
	run: (onUnhandled: (reason: unknown) => void) => Promise<void>,
): Promise<unknown[]> {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await run(onUnhandled);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	return unhandled;
}

describe("#1922 non-worker draft discard safety", () => {
	it("does not discard a client-less draft while an attach is in flight", async () => {
		const { internals } = createDaemon();
		const state = makeEmptyTopLevelDraft("draft-mid-attach");
		internals.sessions.set(state.activeSessionId, state);
		expect(internals.isDiscardableDraft(state)).toBe(true);

		state.pendingAttaches = 1;
		expect(internals.isDiscardableDraft(state)).toBe(false);

		// A turn/compaction/bash end in that window must not close the draft.
		const closeSession = vi.fn(async () => {});
		internals.closeSession = closeSession as unknown as typeof internals.closeSession;
		internals.broadcastToSession(state, bashEndMessage(state));
		await flushAsyncWork();
		expect(closeSession).not.toHaveBeenCalled();
		expect(internals.sessions.get(state.activeSessionId)).toBe(state);
	});

	it("observes closeSession rejections when a broadcast discards an abandoned draft", async () => {
		const { internals } = createDaemon();
		const state = makeEmptyTopLevelDraft("draft-broadcast");
		internals.sessions.set(state.activeSessionId, state);
		const closeSession = vi.fn(() => Promise.reject(new Error("teardown failed")));
		internals.closeSession = closeSession as unknown as typeof internals.closeSession;

		const unhandled = await withUnhandledRejectionCapture(async () => {
			internals.broadcastToSession(state, bashEndMessage(state));
			await flushAsyncWork();
		});

		expect(closeSession).toHaveBeenCalledWith(state, "killed");
		expect(internals.log).toHaveBeenCalledWith(
			expect.stringContaining(`failed to discard abandoned empty draft ${state.activeSessionId}`),
		);
		expect(unhandled).toEqual([]);
	});

	it("observes closeSession rejections when a detach discards an abandoned draft", async () => {
		const { internals } = createDaemon();
		const state = makeEmptyTopLevelDraft("draft-detach");
		internals.sessions.set(state.activeSessionId, state);
		const client = makeClient("client-1", state.activeSessionId);
		state.clients.add(client);
		const closeSession = vi.fn(() => Promise.reject(new Error("teardown failed")));
		internals.closeSession = closeSession as unknown as typeof internals.closeSession;

		const unhandled = await withUnhandledRejectionCapture(async () => {
			internals.detachClientFromSession(client, state);
			await flushAsyncWork();
		});

		expect(closeSession).toHaveBeenCalledWith(state, "killed");
		expect(internals.log).toHaveBeenCalledWith(
			expect.stringContaining(`failed to discard abandoned empty draft ${state.activeSessionId}`),
		);
		expect(unhandled).toEqual([]);
	});
});

describe("#1922 get_rlm_children includes passivated children", () => {
	it("returns the merged roster the attach snapshot advertises after passivation", async () => {
		const { internals } = createDaemon();
		const parent = makeEmptyTopLevelDraft("parent-with-passive-child");
		internals.sessions.set(parent.activeSessionId, parent);
		// Post-passivation live roster: the parent's session only reports resident
		// children, so the closed child is absent from getRlmChildSnapshots().
		(parent.runtime.session as { getRlmChildSnapshots(): unknown[] }).getRlmChildSnapshots = () => [];
		internals.listPassiveRlmSubagents = async () => [
			{
				entry: {
					childId: "child-1",
					sessionName: "real-worker",
					sessionDir: "/tmp/child-1",
					prompt: "complete and persist",
					status: "completed",
				},
				info: { name: "real-worker" },
				chain: [{ childId: "child-1" }],
				rootParentState: parent,
			},
		];

		const response = await internals.handleCommand(makeClient("client-1", parent.activeSessionId), {
			type: "get_rlm_children",
			activeSessionId: parent.activeSessionId,
		});

		expect(response.success).toBe(true);
		expect(response.data?.children?.map((child) => child.id)).toEqual(["child-1"]);
		expect(response.data?.children?.[0]).toMatchObject({
			sessionName: "real-worker",
			status: "done",
		});
		expect(response.data?.eventSequence).toBe(parent.lastEventSequence);
	});

	it("pairs the roster with the sequence from before the passive walk, not after", async () => {
		const { internals } = createDaemon();
		const parent = makeEmptyTopLevelDraft("parent-sequence-race");
		internals.sessions.set(parent.activeSessionId, parent);
		(parent.runtime.session as { getRlmChildSnapshots(): unknown[] }).getRlmChildSnapshots = () => [];
		// A child event lands while the awaited passive walk is in flight; the
		// response must not claim that newer sequence for the older roster.
		internals.listPassiveRlmSubagents = async () => {
			parent.lastEventSequence = parent.lastEventSequence + 5;
			return [];
		};

		const response = await internals.handleCommand(makeClient("client-1", parent.activeSessionId), {
			type: "get_rlm_children",
			activeSessionId: parent.activeSessionId,
		});

		expect(parent.lastEventSequence).toBe(5);
		expect(response.data?.eventSequence).toBe(0);
	});
});
