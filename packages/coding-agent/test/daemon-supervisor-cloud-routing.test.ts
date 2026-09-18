import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import type { CloudSessionRegistry } from "../src/modes/daemon/cloud-session-registry.js";
import type { DaemonCommand, DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

/**
 * Legacy one-shot delegation routing through the supervisor-owned registry:
 * the deprecated cloud_delegate* commands stay functional for in-flight
 * clients, now served by the supervisor's registry instead of a session
 * worker. Owner scoping uses the durable session id, delegation targets the
 * session's cwd, progress frames carry the client's addressing, and the
 * caller-supplied steer identity rides through for guest dedupe.
 */

function makeClient(): DaemonSocketClient {
	return {
		id: "client-1",
		socket: { destroyed: false } as unknown as Socket,
		attachedActiveSessionIds: new Set(),
		detachInput: () => undefined,
		supportsExtensionUi: false,
		capabilities: new Set(),
	};
}

function summaryFixture(): SessionSummary {
	return {
		id: "active-cloud",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		activeSessionId: "active-cloud",
		sessionId: "durable-cloud-owner",
		cwd: "/repo/cloud",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 1,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

/** Structural view of the supervisor's private command surface. */
interface RoutingStubSupervisor {
	handleCommand: (client: DaemonSocketClient, command: DaemonCommand) => Promise<DaemonOutbound | undefined>;
	cloud: () => CloudSessionRegistry | undefined;
	findWorkerForClient: (client: DaemonSocketClient, selector: string) => Promise<unknown>;
	write: (client: DaemonSocketClient, message: DaemonOutbound) => boolean;
	log: (message: string) => void;
	clients: Set<never>;
}

function stubSupervisor(): {
	supervisor: RoutingStubSupervisor;
	registry: Record<string, ReturnType<typeof vi.fn>>;
	writes: DaemonOutbound[];
} {
	const delegation = {
		id: "sess_cloud-1",
		activeSessionId: "durable-cloud-owner",
		status: "running" as const,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		promptPreview: "fix it",
		resultReady: false,
		resultApplied: false,
	};
	const registry = {
		legacyDelegate: vi.fn(async (request: { onProgress?: (progress: never) => void }) => {
			request.onProgress?.({
				sessionId: delegation.id,
				phase: "allocating",
				detail: "allocating sandbox",
			} as never);
			return delegation;
		}),
		legacyList: vi.fn(async () => [delegation]),
		legacyStop: vi.fn(async () => ({ ...delegation, status: "stopped" as const })),
		legacyApply: vi.fn(async () => ({ ...delegation, status: "completed" as const, resultApplied: true })),
		legacySteer: vi.fn(async () => ({
			delegation: { ...delegation, status: "running" as const },
			commandId: "cmd_steer_1",
			state: "acknowledged" as const,
		})),
	} as unknown as Record<string, ReturnType<typeof vi.fn>>;
	const stubRegistry = registry as unknown as CloudSessionRegistry;
	const writes: DaemonOutbound[] = [];
	const supervisor = Object.create(DaemonSupervisor.prototype) as unknown as RoutingStubSupervisor;
	const properties = supervisor as unknown as Record<string, unknown>;
	properties.cloud = () => stubRegistry;
	properties.findWorkerForClient = vi.fn(async () => ({
		worker: {} as never,
		summary: summaryFixture(),
	}));
	properties.write = vi.fn((client: DaemonSocketClient, message: DaemonOutbound) => {
		void client;
		writes.push(message);
		return true;
	});
	properties.log = () => undefined;
	properties.clients = new Set([makeClient()]);
	return { supervisor, registry, writes };
}

describe("supervisor legacy one-shot cloud routing (deprecated surface)", () => {
	it("routes the legacy commands through the registry with owner scoping and cwd", async () => {
		const { supervisor, registry, writes } = stubSupervisor();
		const client = makeClient();
		const run = await supervisor.handleCommand(client, {
			id: "cloud-run-1",
			type: "cloud_delegate",
			activeSessionId: "active-cloud",
			delegationId: "sess_cloud-1",
			prompt: "fix it",
		});
		expect(run).toMatchObject({
			type: "response",
			command: "cloud_delegate",
			success: true,
			data: { delegation: { id: "sess_cloud-1", status: "running" } },
		});
		// Owner scoping uses the durable session id and the session's cwd.
		expect(registry.legacyDelegate).toHaveBeenCalledWith(
			expect.objectContaining({
				activeSessionId: "durable-cloud-owner",
				delegationId: "sess_cloud-1",
				cwd: "/repo/cloud",
				prompt: "fix it",
			}),
		);
		// Progress frames carry the client's addressing and the mapped phase.
		const progress = writes.find((message) => message.type === "cloud_delegate_progress");
		expect(progress).toMatchObject({
			type: "cloud_delegate_progress",
			id: "cloud-run-1",
			activeSessionId: "active-cloud",
			delegationId: "sess_cloud-1",
			phase: "provisioning",
		});

		await supervisor.handleCommand(client, {
			id: "cloud-list-1",
			type: "cloud_delegations_list",
			activeSessionId: "active-cloud",
		});
		await supervisor.handleCommand(client, {
			id: "cloud-stop-1",
			type: "cloud_delegation_stop",
			activeSessionId: "active-cloud",
			delegationId: "sess_cloud-1",
			forfeit: false,
		});
		await supervisor.handleCommand(client, {
			id: "cloud-apply-1",
			type: "cloud_delegation_apply",
			activeSessionId: "active-cloud",
			delegationId: "sess_cloud-1",
		});
		const steerResponse = await supervisor.handleCommand(client, {
			id: "cloud-steer-1",
			type: "cloud_delegation_steer",
			activeSessionId: "active-cloud",
			delegationId: "sess_cloud-1",
			text: "tighten the loop",
			steerId: "steer-identity-1",
		});
		expect(steerResponse).toMatchObject({
			type: "response",
			command: "cloud_delegation_steer",
			success: true,
			data: { steered: expect.objectContaining({ state: "acknowledged" }) },
		});
		expect(registry.legacyList).toHaveBeenCalledWith("durable-cloud-owner");
		expect(registry.legacyStop).toHaveBeenCalledWith("durable-cloud-owner", "sess_cloud-1", false);
		expect(registry.legacyApply).toHaveBeenCalledWith("durable-cloud-owner", "sess_cloud-1", "/repo/cloud");
		// The caller-supplied steer identity rides through so retried daemon
		// commands deduplicate on the guest journal.
		expect(registry.legacySteer).toHaveBeenCalledWith(
			"durable-cloud-owner",
			"sess_cloud-1",
			"tighten the loop",
			"steer-identity-1",
		);
	});

	it("rejects the legacy surface when cloud is unconfigured", async () => {
		const supervisor = Object.create(DaemonSupervisor.prototype) as unknown as RoutingStubSupervisor;
		const properties = supervisor as unknown as Record<string, unknown>;
		properties.cloud = () => undefined;
		properties.clients = new Set();
		properties.log = () => undefined;
		const propertiesFind = supervisor as unknown as {
			findWorkerForClient: (client: DaemonSocketClient, selector: string) => Promise<unknown>;
		};
		propertiesFind.findWorkerForClient = vi.fn(async () => ({ worker: {} as never, summary: summaryFixture() }));
		await expect(
			supervisor.handleCommand(makeClient(), {
				id: "cloud-list-2",
				type: "cloud_delegations_list",
				activeSessionId: "active-cloud",
			} as DaemonCommand),
		).rejects.toThrow(/Cloud sessions are not configured/);
	});
});
