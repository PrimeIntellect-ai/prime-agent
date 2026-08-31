import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonWorkerCommand, DaemonWorkerPeerGrant } from "../src/modes/daemon/daemon-worker-protocol.js";

interface WorkerInternals {
	handleLine(client: DaemonSocketClient, line: string): Promise<void>;
	handleWorkerCommand(client: DaemonSocketClient, command: DaemonWorkerCommand): Promise<void>;
	supervisorClaims: Map<DaemonSocketClient, { claim: { supervisorGeneration: string }; ownerFingerprint: string }>;
	peerGrants: Map<string, DaemonWorkerPeerGrant>;
	peerClaims: Map<DaemonSocketClient, DaemonWorkerPeerGrant>;
	sessions: Map<string, ActiveSessionState>;
	fencePeerTransports(): void;
}

interface FakePeerSocket {
	client: DaemonSocketClient;
	responses: { command: string; success: boolean; error?: string }[];
	endMock: ReturnType<typeof vi.fn>;
}

function makeWorkerDaemon(): WorkerInternals {
	const daemon = new AgentDaemon("/tmp/prime-agent-peer-test.sock", {
		defaultSessionConfig: { agentDir: "/tmp/prime-agent-peer-test-agent", cwd: "/tmp" },
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
		worker: { authenticationToken: "worker-token", workerInstanceId: "instance-1" },
	});
	return daemon as unknown as WorkerInternals;
}

function makeSocketClient(id: string, authenticated: boolean): FakePeerSocket {
	const responses: FakePeerSocket["responses"] = [];
	const endMock = vi.fn();
	const socket = {
		destroyed: false,
		write: (data: string | Buffer) => {
			responses.push(JSON.parse(String(data)) as FakePeerSocket["responses"][number]);
			return true;
		},
		end: endMock,
	} as unknown as Socket;
	return {
		client: {
			id,
			socket,
			attachedActiveSessionIds: new Set(),
			authenticated,
			transport: "jsonl",
			detachInput: () => {},
			supportsExtensionUi: false,
			capabilities: new Set(),
		},
		responses,
		endMock,
	};
}

function makeGrant(overrides: Partial<DaemonWorkerPeerGrant> = {}): DaemonWorkerPeerGrant {
	return {
		grantId: "grant-1",
		token: "peer-token",
		expiresAt: new Date(Date.now() + 10_000).toISOString(),
		purpose: "session_client",
		workerInstanceId: "instance-1",
		activeSessionId: "active-1",
		issuerGeneration: "gen-1",
		...overrides,
	};
}

async function registerGrant(
	internals: WorkerInternals,
	supervisor: FakePeerSocket,
	grant: DaemonWorkerPeerGrant,
): Promise<{ success: boolean; error?: string }> {
	await internals.handleWorkerCommand(supervisor.client, {
		id: `register-${grant.grantId}`,
		type: "worker_register_peer_transport",
		grant,
	});
	return supervisor.responses.at(-1)!;
}

function makeSupervisor(internals: WorkerInternals): FakePeerSocket {
	const supervisor = makeSocketClient("supervisor-1", true);
	supervisor.client.authenticationRole = "supervisor";
	internals.supervisorClaims.set(supervisor.client, {
		claim: { supervisorGeneration: "gen-1" },
		ownerFingerprint: "fp",
	});
	return supervisor;
}

async function authenticatePeer(
	internals: WorkerInternals,
	peer: FakePeerSocket,
	overrides: Record<string, unknown> = {},
): Promise<{ success: boolean; error?: string }> {
	await internals.handleLine(
		peer.client,
		JSON.stringify({
			id: "auth-1",
			type: "peer_auth",
			grantId: "grant-1",
			token: "peer-token",
			workerInstanceId: "instance-1",
			purpose: "session_client",
			...overrides,
		}),
	);
	return peer.responses.at(-1)!;
}

describe("daemon worker peer transport", () => {
	it("admits exactly one peer_auth per registered grant and burns the grant before checking it", async () => {
		const internals = makeWorkerDaemon();
		const supervisor = makeSupervisor(internals);
		internals.sessions.set("active-1", {} as ActiveSessionState);
		expect(await registerGrant(internals, supervisor, makeGrant())).toMatchObject({ success: true });

		const peer = makeSocketClient("peer-1", false);
		expect(await authenticatePeer(internals, peer)).toMatchObject({ success: true });
		expect(peer.client.authenticationRole).toBe("session_client");
		expect(internals.peerClaims.get(peer.client)).toMatchObject({ activeSessionId: "active-1" });
		expect(internals.peerGrants.size).toBe(0);

		const replay = makeSocketClient("peer-2", false);
		expect(await authenticatePeer(internals, replay)).toMatchObject({
			success: false,
			error: expect.stringContaining("Peer authentication failed"),
		});
		expect(replay.endMock).toHaveBeenCalled();
	});

	it("rejects invalid grants at registration time", async () => {
		const internals = makeWorkerDaemon();
		const supervisor = makeSupervisor(internals);
		internals.sessions.set("active-1", {} as ActiveSessionState);
		const invalidGrants = [
			makeGrant({ issuerGeneration: "stale-gen" }),
			makeGrant({ workerInstanceId: "instance-2" }),
			makeGrant({ activeSessionId: "active-9" }),
			makeGrant({ expiresAt: new Date(Date.now() - 1).toISOString() }),
			makeGrant({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
		];
		for (const grant of invalidGrants) {
			expect(await registerGrant(internals, supervisor, grant)).toMatchObject({
				success: false,
				error: expect.stringContaining("Peer transport grant is invalid"),
			});
		}
		expect(internals.peerGrants.size).toBe(0);
	});

	it("rejects an expired grant on presentation and ends the socket", async () => {
		const internals = makeWorkerDaemon();
		internals.peerGrants.set("grant-1", makeGrant({ expiresAt: new Date(Date.now() - 1).toISOString() }));

		const peer = makeSocketClient("peer-1", false);
		expect(await authenticatePeer(internals, peer)).toMatchObject({ success: false });
		expect(peer.endMock).toHaveBeenCalled();
		expect(internals.peerGrants.size).toBe(0);
	});

	it("rejects peer_auth for a different worker incarnation", async () => {
		const internals = makeWorkerDaemon();
		internals.peerGrants.set("grant-1", makeGrant({ workerInstanceId: "instance-2" }));

		const peer = makeSocketClient("peer-1", false);
		expect(await authenticatePeer(internals, peer, { workerInstanceId: "instance-2" })).toMatchObject({
			success: false,
		});
		expect(peer.endMock).toHaveBeenCalled();
	});

	it("ends a pre-auth socket that sends anything but an authentication command", async () => {
		const internals = makeWorkerDaemon();
		const stranger = makeSocketClient("stranger-1", false);
		await internals.handleLine(stranger.client, JSON.stringify({ id: "l1", type: "list" }));
		expect(stranger.responses.at(-1)).toMatchObject({ success: false });
		expect(stranger.endMock).toHaveBeenCalled();
		expect(stranger.client.authenticated).toBe(false);
	});

	it("scopes an authenticated peer to the session plane of its granted session", async () => {
		const internals = makeWorkerDaemon();
		internals.peerGrants.set("grant-1", makeGrant());
		const peer = makeSocketClient("peer-1", false);
		expect(await authenticatePeer(internals, peer)).toMatchObject({ success: true });

		const rejected = [
			{ id: "other-session", type: "get_state", activeSessionId: "active-2" },
			{ id: "control-plane", type: "list" },
			{ id: "worker-control", type: "worker_subscribe", activeSessionId: "active-1" },
			{ id: "unknown-command", type: "no_such_command", activeSessionId: "active-1" },
		];
		for (const command of rejected) {
			await internals.handleLine(peer.client, JSON.stringify(command));
			expect(peer.responses.at(-1)).toMatchObject({
				success: false,
				error: expect.stringContaining("not allowed on this direct peer transport"),
			});
		}

		// An in-scope session-plane command passes admission (and then fails only
		// because this fixture has no live session behind the id).
		await internals.handleLine(
			peer.client,
			JSON.stringify({ id: "in-scope", type: "wait_for_idle", activeSessionId: "active-1" }),
		);
		expect(peer.responses.at(-1)?.error ?? "").not.toContain("not allowed on this direct peer transport");
	});

	it("fences grants and live peers during worker update preparation until the update is cancelled", async () => {
		const internals = makeWorkerDaemon();
		const supervisor = makeSupervisor(internals);
		internals.sessions.set("active-1", {} as ActiveSessionState);
		internals.peerGrants.set("grant-1", makeGrant());
		const peer = makeSocketClient("peer-1", false);
		expect(await authenticatePeer(internals, peer)).toMatchObject({ success: true });

		internals.fencePeerTransports();

		expect(peer.endMock).toHaveBeenCalled();
		expect(internals.peerClaims.size).toBe(0);
		expect(await registerGrant(internals, supervisor, makeGrant({ grantId: "grant-2" }))).toMatchObject({
			success: false,
		});

		await internals.handleWorkerCommand(supervisor.client, { id: "cancel-1", type: "worker_cancel_update" });
		expect(supervisor.responses.at(-1)).toMatchObject({ success: true });
		expect(await registerGrant(internals, supervisor, makeGrant({ grantId: "grant-3" }))).toMatchObject({
			success: true,
		});
	});
});
