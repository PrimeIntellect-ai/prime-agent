import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "eng-1922-"));
	tempDirectories.push(directory);
	return directory;
}

function socketClient(id: string, activeSessionId: string): { client: DaemonSocketClient; socket: PassThrough } {
	const socket = new PassThrough();
	return {
		socket,
		client: {
			id,
			socket: socket as unknown as Socket,
			transport: "private-framed",
			attachedActiveSessionIds: new Set([activeSessionId]),
			catchupActiveSessionIds: new Set<string>(),
			detachInput: () => {},
			supportsExtensionUi: false,
			capabilities: new Set(),
		} as unknown as DaemonSocketClient,
	};
}

function discardableState(activeSessionId: string): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set(),
		pendingAttaches: 0,
		lastEventSequence: 0,
		extensionUiRequests: new Map(),
		runtime: {
			metadata: { kind: "top-level" },
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

type DaemonInternals = {
	sessions: Map<string, ActiveSessionState>;
	detachClientFromSession(client: DaemonSocketClient, state: ActiveSessionState): void;
	isDiscardableDraft(state: ActiveSessionState): boolean;
	closeSession(state: ActiveSessionState, reason: "killed"): Promise<void>;
	write(client: DaemonSocketClient, message: unknown): boolean;
	log(message: string): void;
};

function createDaemon(root: string): { daemon: AgentDaemon; internals: DaemonInternals } {
	const daemon = new AgentDaemon(join(root, "daemon.sock"), {
		defaultSessionConfig: { agentDir: root, cwd: root },
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
	});
	const internals = daemon as unknown as DaemonInternals;
	internals.write = vi.fn(() => true);
	internals.log = vi.fn();
	return { daemon, internals };
}

async function flushAsyncWork(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

describe("regression #1922: non-worker draft discard", () => {
	it("keeps a discardable draft while an attach is in flight", () => {
		const root = tempDirectory();
		const { internals } = createDaemon(root);
		const state = discardableState("active-1922-attach");
		expect(internals.isDiscardableDraft(state)).toBe(true);
		state.pendingAttaches = 1;
		expect(internals.isDiscardableDraft(state)).toBe(false);
	});

	it("observes closeSession failures when discarding an abandoned draft", async () => {
		const root = tempDirectory();
		const { internals } = createDaemon(root);
		const activeSessionId = "active-1922-detach";
		const { client, socket } = socketClient("client-1922", activeSessionId);
		const state = discardableState(activeSessionId);
		state.clients.add(client);
		internals.sessions.set(activeSessionId, state);
		const closeSession = vi.fn(async () => {
			throw new Error("close failed");
		});
		internals.closeSession = closeSession as never;
		const log = internals.log as unknown as ReturnType<typeof vi.fn>;
		try {
			internals.detachClientFromSession(client, state);
			await flushAsyncWork();
			expect(closeSession).toHaveBeenCalledTimes(1);
			expect(log).toHaveBeenCalledWith(expect.stringContaining(activeSessionId));
		} finally {
			socket.destroy();
		}
	});
});
