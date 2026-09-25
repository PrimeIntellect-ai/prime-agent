import { describe, expect, it, vi } from "vitest";
import { formatSessionDisplayId } from "../src/modes/daemon/daemon-session-id.js";
import type {
	RemoteAgentHost,
	RemoteAgentMeshSource,
	RemoteAgentMessageTransport,
	RemoteAgentSessionSummary,
} from "../src/modes/daemon/remote-mesh.js";
import { RemoteAgentMeshState, remoteAgentFamilyRelationship } from "../src/modes/daemon/remote-mesh.js";

function remoteSession(overrides: Partial<RemoteAgentSessionSummary> = {}): RemoteAgentSessionSummary {
	return {
		id: "remote-active",
		sessionId: "remote-session",
		activeSessionId: "remote-active",
		sessionName: "remote-agent",
		lifecycle: "live",
		activity: "idle",
		cwd: "/remote/project",
		messageCount: 3,
		attachedClients: 0,
		rlmDepth: 0,
		...overrides,
	};
}

function host(overrides: Partial<RemoteAgentHost> = {}): RemoteAgentHost {
	return { tailnetHost: "milk.tailnet.ts.net", online: true, daemon: true, sessions: [remoteSession()], ...overrides };
}

function mockSource(sessions: () => Promise<RemoteAgentHost[]>) {
	return { listRemoteAgents: vi.fn(sessions) } satisfies RemoteAgentMeshSource & { listRemoteAgents: unknown };
}

describe("RemoteAgentMeshState", () => {
	it("surfaces depth-0 rows with host labels, status, display model, and peer summaries", async () => {
		const state = new RemoteAgentMeshState({
			source: mockSource(async () => [
				host({
					sessions: [
						remoteSession(),
						remoteSession({
							id: "worker-active",
							sessionId: "worker-session",
							sessionName: "worker",
							activity: "working",
							isStreaming: true,
							model: { provider: "anthropic", modelId: "claude-sonnet" },
						}),
						// Remote subagent children have no locally resident parents: dropped.
						remoteSession({ rlmDepth: 1, runtimeKind: "subagent", sessionId: "child-session" }),
					],
				}),
				host({ tailnetHost: "offline.tailnet.ts.net", online: false, daemon: false }),
				host({ tailnetHost: "locked.tailnet.ts.net", locked: true }),
			]),
		});
		await state.refreshIfStale();
		const entries = state.entriesForClients();
		expect(entries[0]).toMatchObject({
			agentId: "remote:milk.tailnet.ts.net#remote-session",
			status: "idle",
		});
		expect(entries[0]!.summary).toMatchObject({
			sessionName: "remote-agent",
			remoteHost: "milk.tailnet.ts.net",
			rosterStatus: "idle",
		});
		const working = state.sessionSummaries()[1]!;
		expect(working).toMatchObject({
			rosterStatus: "running",
			isStreaming: true,
			remoteModel: { provider: "anthropic", modelId: "claude-sonnet" },
		});
		expect(state.peerSummaries()[1]).toMatchObject({ sessionId: "worker-session", rlmDepth: 0, status: "running" });
	});

	it("marks peers offline when they drop or stop answering, clears on recovery, and drops closed rows", async () => {
		const leaving = remoteSession({ sessionId: "closing-session", id: "closing" });
		const source = mockSource(async () => [host({ sessions: [remoteSession(), leaving] })]);
		const rosterChanges: { changed: string[]; removed: string[] }[] = [];
		const state = new RemoteAgentMeshState({
			source,
			refreshTtlMs: 0,
			onRosterChange: (changed, removed) => rosterChanges.push({ changed: [...changed], removed: [...removed] }),
		});
		await state.refreshIfStale();
		expect(state.sessionSummaries()[0]!.remoteOffline).toBeUndefined();

		source.listRemoteAgents.mockResolvedValueOnce([host()]);
		await state.refreshIfStale();
		expect(state.sessionSummaries().map((summary) => summary.sessionId)).toEqual(["remote-session"]);
		expect(rosterChanges.at(-1)!.removed).toEqual(["remote:milk.tailnet.ts.net#closing-session"]);

		source.listRemoteAgents.mockResolvedValueOnce([]);
		await state.refreshIfStale();
		// Rows survive, marked offline: an exceptional label the view renders.
		expect(state.sessionSummaries()[0]).toMatchObject({ remoteOffline: true, rosterStatus: "inactive" });
		expect(state.entriesForClients()[0]).toMatchObject({ status: "inactive", statusLabel: "offline" });

		source.listRemoteAgents.mockResolvedValueOnce([host()]);
		await state.refreshIfStale();
		expect(state.sessionSummaries()[0]!.rosterStatus).toBe("idle");
		expect(state.sessionSummaries()[0]!.remoteOffline).toBeUndefined();
	});

	it("forgets a peer that stays unreachable past the offline TTL", async () => {
		let nowMs = 0;
		const source = mockSource(async () => [host()]);
		const removedIds: string[][] = [];
		const state = new RemoteAgentMeshState({
			source,
			refreshTtlMs: 0,
			offlineTtlMs: 60_000,
			now: () => nowMs,
			onRosterChange: (_c, removed) => removedIds.push([...removed]),
		});
		await state.refreshIfStale();
		nowMs = 10_000;
		source.listRemoteAgents.mockResolvedValueOnce([]);
		await state.refreshIfStale();
		expect(state.sessionSummaries()).toHaveLength(1);
		// Still inside the TTL the offline row stays; past it, the peer is forgotten.
		nowMs = 70_001;
		source.listRemoteAgents.mockResolvedValueOnce([]);
		await state.refreshIfStale();
		expect(state.sessionSummaries()).toHaveLength(0);
		expect(removedIds.at(-1)).toEqual(["remote:milk.tailnet.ts.net#remote-session"]);
	});

	it("bounds scans with the TTL and coalesces concurrent queries onto one scan", async () => {
		let nowMs = 0;
		const source = mockSource(async () => [host()]);
		const state = new RemoteAgentMeshState({
			source,
			refreshTtlMs: 30_000,
			now: () => nowMs,
		});
		expect(await state.refreshIfStale()).toBe(true);
		// Fresh cache: no second scan inside the TTL.
		expect(await state.refreshIfStale()).toBe(false);
		nowMs = 30_001;
		// A slow scan: two concurrent callers still only scan once.
		let releaseScan: (() => void) | undefined;
		source.listRemoteAgents.mockImplementationOnce(
			() => new Promise<RemoteAgentHost[]>((resolve) => (releaseScan = () => resolve([host()]))),
		);
		const first = state.refreshIfStale();
		const second = state.refreshIfStale();
		releaseScan?.();
		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(source.listRemoteAgents).toHaveBeenCalledTimes(2);
	});

	it("matches targets by id or name, reports cross-host ambiguity, and delivers through the transport", async () => {
		const deliveries: unknown[] = [];
		const transport: RemoteAgentMessageTransport = {
			sendAgentMessage: async (delivery) => {
				deliveries.push(delivery);
				return {
					id: "agentmsg_receipt",
					source: "agent_message" as const,
					target: { activeSessionId: "remote-active", sessionId: "remote-session" },
					message: delivery.message,
					deliveryStatus: "delivered" as const,
				};
			},
		};
		const source = mockSource(async () => [
			host(),
			// Names are unique per daemon, not per tailnet: a second host may own
			// another "remote-agent", and name selectors must report both.
			host({
				tailnetHost: "other.tailnet.ts.net",
				sessions: [
					remoteSession({ id: "other-active", activeSessionId: "other-active", sessionId: "other-session" }),
				],
			}),
		]);
		const bare = new RemoteAgentMeshState({ source, refreshTtlMs: 0 });
		await bare.refreshIfStale();
		for (const selector of ["remote-session", "remote-active"]) {
			expect(bare.findMessageTargets(selector)).toHaveLength(1);
			expect(bare.findMessageTargets(selector)[0]!.sessionId).toBe("remote-session");
		}
		expect(bare.findMessageTargets("remote-agent")).toHaveLength(2);
		await expect(
			bare.sendAgentMessage({ target: bare.findMessageTargets("remote-agent")[0]!, message: "hi" }),
		).rejects.toThrow("remote agent messaging is not available");

		const delivering = new RemoteAgentMeshState({ source, transport, refreshTtlMs: 0 });
		await delivering.refreshIfStale();
		const target = delivering.findMessageTargets("remote-agent")[0]!;
		const sent = await delivering.sendAgentMessage({
			target,
			message: "cross the tailnet",
			sender: { sessionId: "local-session", clientId: "client-1" },
			fromRelationship: "sibling",
		});
		expect(sent.deliveryStatus).toBe("delivered");
		expect(deliveries).toMatchObject([
			{ host: { tailnetHost: "milk.tailnet.ts.net" }, message: "cross the tailnet", fromRelationship: "sibling" },
		]);
		// The peer drops: its row stays targetable but delivery reports offline.
		source.listRemoteAgents.mockResolvedValueOnce([]);
		await delivering.refreshIfStale();
		await expect(
			delivering.sendAgentMessage({ target: delivering.findMessageTargets("remote-session")[0]!, message: "hi" }),
		).rejects.toThrow("Remote agent on milk.tailnet.ts.net is offline");
	});

	it("resolves an unnamed remote row from the 12-character id the session table prints", async () => {
		const sessionId = "01a0cba2-0000-7000-8000-abcdef123456";
		const rowId = { id: sessionId, sessionId, activeSessionId: undefined, sessionName: undefined };
		const source = mockSource(async () => [host({ sessions: [remoteSession(rowId)] })]);
		const state = new RemoteAgentMeshState({ source, refreshTtlMs: 0 });
		await state.refreshIfStale();
		// An unnamed row has only its ids, and the table prints the 12-character suffix.
		const printedId = formatSessionDisplayId(sessionId);
		expect(printedId).toBe("abcdef123456");
		expect(state.findMessageTargets(printedId).map((target) => target.sessionId)).toEqual([sessionId]);
		// Two hosts owning that suffix stay ambiguous, exactly like the local selector.
		source.listRemoteAgents.mockResolvedValueOnce([
			host({ sessions: [remoteSession(rowId)] }),
			host({ tailnetHost: "other.tailnet.ts.net", sessions: [remoteSession(rowId)] }),
		]);
		await state.refreshIfStale();
		expect(state.findMessageTargets(printedId)).toHaveLength(2);
	});

	it("treats a depth-0 remote session as a sibling and nothing else", async () => {
		const state = new RemoteAgentMeshState({ source: mockSource(async () => [host()]) });
		await state.refreshIfStale();
		// Depth-0 without parent edges: a sibling of local depth-0 rows, nothing else.
		const target = state.findMessageTargets("remote-agent")[0]!;
		expect(remoteAgentFamilyRelationship({ id: "local", depth: 0, status: "idle" }, target)).toBe("sibling");
		expect(
			remoteAgentFamilyRelationship({ id: "child", depth: 1, status: "running", parentSessionPath: "/p" }, target),
		).toBeUndefined();
	});
});
