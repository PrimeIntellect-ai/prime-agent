import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudSessionRecord } from "../src/core/cloud/cloud-session-store.js";
import {
	type CloudSessionRegistry,
	type CloudSessionTarget,
	CloudShadowSessionError,
} from "../src/modes/daemon/cloud-session-registry.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonCreateCommand } from "../src/modes/daemon/daemon-worker-protocol.js";

/**
 * Split-brain guard at the supervisor create seam: a registered cloud shadow
 * is the registry's exclusive transcript. A live cloud row serves its roster
 * row instead of opening a worker, and no createOrReuseWorker caller may ever
 * launch a local worker against a shadow path.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Structural view of the supervisor seams under test; the real methods are
 * class-private, so the stub drives them through Object.create(prototype).
 */
interface StubSupervisor {
	cloudRegistry?: CloudSessionRegistry;
	cloud: () => CloudSessionRegistry | undefined;
	defaultSessionConfig: { cwd: string; sessionDir?: string; agentDir?: string };
	catalog: { resolve: (selector: string, cwd?: string, sessionDir?: string) => Promise<string> };
	createOrReuseWorker: (clientId: string, command: DaemonCreateCommand) => Promise<unknown>;
	cloudCreateIntercept: (client: unknown, command: DaemonCreateCommand) => Promise<SessionSummary | undefined>;
	assertNotCloudShadowSession: (sessionPath: string | undefined) => void;
	handleCommand: (client: unknown, command: unknown) => Promise<unknown>;
	write?: (client: unknown, message: unknown) => boolean;
	clients?: Set<never>;
	log?: (message: string) => void;
}

function recordFixture(overrides: Partial<CloudSessionRecord> = {}): CloudSessionRecord {
	const now = new Date().toISOString();
	return {
		version: 1,
		sessionId: "sess_guard_1",
		generation: 1,
		residentProcessUuid: "0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b",
		desiredLifecycle: "running",
		observedLifecycle: "running",
		eventCursor: { generation: 1, sequence: 0 },
		ackCursor: { generation: 1, sequence: 0 },
		cleanupState: "none",
		resultImportState: "pending",
		createdAt: now,
		updatedAt: now,
		shadowSessionFile: "/tmp/shadow/sess_guard_1.jsonl",
		location: "converted-root",
		activeSessionId: "cloud-active-guard",
		...overrides,
	} as CloudSessionRecord;
}

function summaryFixture(record: CloudSessionRecord): SessionSummary {
	return {
		id: record.activeSessionId!,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		activeSessionId: record.activeSessionId!,
		sessionId: record.sessionId,
		sessionFile: record.shadowSessionFile,
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		execution: { location: "cloud", connectivity: "connected" },
	};
}

function stubSupervisor(options: { record: CloudSessionRecord; live: boolean }): StubSupervisor {
	const target: CloudSessionTarget = {
		record: options.record,
		remoteSessionId: options.record.sessionId,
		activeSessionId: options.record.activeSessionId!,
		descendant: false,
		summary: summaryFixture(options.record),
	};
	const registry = {
		recordForShadowFile: vi.fn((path: string) =>
			path === options.record.shadowSessionFile ? options.record : undefined,
		),
		resolveActive: vi.fn(() => (options.live ? target : undefined)),
	} as unknown as CloudSessionRegistry;
	const supervisor = Object.create(DaemonSupervisor.prototype) as unknown as StubSupervisor;
	supervisor.cloudRegistry = registry;
	supervisor.cloud = () => registry;
	supervisor.defaultSessionConfig = { cwd: "/tmp" };
	const props = supervisor as unknown as Record<string, unknown>;
	props.clients = new Set<never>();
	props.log = () => undefined;
	supervisor.catalog = {
		resolve: vi.fn(async () => options.record.shadowSessionFile!),
	};
	return supervisor;
}

describe("supervisor cloud shadow guards", () => {
	it("refuses to open a live cloud shadow through createOrReuseWorker (split-brain guard)", async () => {
		const supervisor = stubSupervisor({ record: recordFixture(), live: true });
		const command: DaemonCreateCommand = {
			type: "create",
			sessionPath: "/tmp/shadow/sess_guard_1.jsonl",
		};
		await expect(supervisor.createOrReuseWorker("client-1", command)).rejects.toThrow(CloudShadowSessionError);
	});

	it("refuses the local open for a stopped cloud shadow too (reprovision instead)", async () => {
		const stopped = recordFixture({
			observedLifecycle: "stopped",
			desiredLifecycle: "stopping",
		});
		const supervisor = stubSupervisor({ record: stopped, live: false });
		const command: DaemonCreateCommand = {
			type: "create",
			sessionPath: "/tmp/shadow/sess_guard_1.jsonl",
		};
		await expect(supervisor.createOrReuseWorker("client-1", command)).rejects.toThrow(
			/is the shadow transcript of cloud session sess_guard_1 \(stopped\)/,
		);
	});

	it("serves the cloud roster row for a live shadow through the create intercept", async () => {
		const supervisor = stubSupervisor({ record: recordFixture(), live: true });
		const summary = await supervisor.cloudCreateIntercept(
			{} as never,
			{
				type: "create",
				sessionPath: "sess_guard_1",
			} as DaemonCreateCommand,
		);
		expect(summary).toBeDefined();
		expect(summary!.execution).toMatchObject({ location: "cloud", connectivity: "connected" });
		expect(summary!.activeSessionId).toBe("cloud-active-guard");
	});

	it("create on a stopped cloud shadow is a typed reprovision error, never a local open", async () => {
		const stopped = recordFixture({
			observedLifecycle: "lost",
			desiredLifecycle: "stopping",
		});
		const supervisor = stubSupervisor({ record: stopped, live: false });
		await expect(
			supervisor.cloudCreateIntercept(
				{} as never,
				{
					type: "create",
					sessionPath: "sess_guard_1",
				} as DaemonCreateCommand,
			),
		).rejects.toThrow(/reprovision it instead of opening it locally/);
	});

	it("leaves ordinary session paths untouched", async () => {
		const supervisor = stubSupervisor({ record: recordFixture(), live: true });
		const createCommand: DaemonCreateCommand = { type: "create" };
		// No sessionPath and no registry hit: the guard is a no-op and the
		// create proceeds into the ordinary worker path (which fails here only
		// because the stub has no workers).
		await expect(supervisor.createOrReuseWorker("client-1", createCommand)).rejects.toThrow();
	});
});

describe("supervisor cloud control-plane routing", () => {
	it("refuses a direct worker transport ticket for a cloud row", async () => {
		const supervisor = stubSupervisor({ record: recordFixture(), live: true });
		await expect(
			supervisor.handleCommand(
				{} as never,
				{
					id: "ticket-1",
					type: "get_direct_worker_transport",
					activeSessionId: "cloud-active-guard",
				} as never,
			),
		).rejects.toThrow(/Direct transport is unavailable for cloud sessions/);
	});

	it("serves attach for a cloud row through the supervisor socket only", async () => {
		const supervisor = stubSupervisor({ record: recordFixture(), live: true });
		const writes: unknown[] = [];
		const properties = supervisor as unknown as Record<string, unknown>;
		properties.write = (client: unknown, message: unknown) => {
			void client;
			writes.push(message);
			return true;
		};
		const client = {
			id: "client-1",
			socket: { destroyed: false },
			attachedActiveSessionIds: new Set<string>(),
			detachInput: () => undefined,
			supportsExtensionUi: false,
			capabilities: new Set(["slim_attach"]),
		};
		const registry = supervisor.cloudRegistry as unknown as {
			attachSnapshot: (target: unknown) => unknown;
		};
		registry.attachSnapshot = () => ({
			summary: summaryFixture(recordFixture()),
			state: {
				activeSessionId: "cloud-active-guard",
				cwd: "/tmp",
				thinkingLevel: "off",
				availableThinkingLevels: [],
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				retryAttempt: 0,
				steeringMode: "all",
				followUpMode: "all",
				serviceTier: "default",
				sessionId: "sess_guard_1",
				leafId: null,
				autoCompactionEnabled: true,
				messageCount: 0,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
				compactionCount: 0,
				goal: { active: false, status: "idle", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 },
				scopedModels: [],
				activeToolNames: [],
				contextUsage: { tokens: null, contextWindow: 0, percent: null },
			},
			messages: [],
			sessionContext: { messages: [], thinkingLevel: "off", serviceTier: "default", model: null },
			children: [],
			lastEventSequence: 0,
		});
		const response = await supervisor.handleCommand(
			client as never,
			{
				id: "attach-1",
				type: "attach",
				activeSessionId: "cloud-active-guard",
			} as never,
		);
		expect(response).toMatchObject({
			type: "response",
			command: "attach",
			success: true,
			data: {
				activeSessionId: "cloud-active-guard",
				snapshot: {
					activeSessionId: "cloud-active-guard",
					summary: { execution: { location: "cloud", connectivity: "connected" } },
				},
				replay: { status: "complete", toSequence: 0 },
			},
		});
		// The client is attached through the supervisor socket; the attach
		// also pushed a session_attached frame with the replay.
		expect(writes.some((message) => (message as { type?: string }).type === "session_attached")).toBe(true);
	});
});
