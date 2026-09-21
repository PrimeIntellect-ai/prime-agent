import type { Socket } from "node:net";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import type { CloudSessionRegistry, RlmCloudSpawnAdmission } from "../src/modes/daemon/cloud-session-registry.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_COMMAND_COMPATIBILITY,
	type DaemonCommand,
	type DaemonOutbound,
	meetsDaemonCommandCompatibility,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";

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

/** A minimal resolvable model for the summary the conversion path serializes. */
function modelFixture(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://localhost:0",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	} as Model<Api>;
}

describe("supervisor resident conversion model serialization", () => {
	it("serializes the summary model as the canonical provider/modelId selector the guest splits at the first slash", async () => {
		const cases: Array<{ provider: string; id: string; expected: string }> = [
			// A private Prime Inference route whose model id itself contains a
			// slash: the raw id would be split into the wrong provider/modelId.
			{
				provider: "prime-inference",
				id: "internal/glm-5.3-fast",
				expected: "prime-inference/internal/glm-5.3-fast",
			},
			// A bundled z-ai/glm id under its provider.
			{ provider: "openrouter", id: "z-ai/glm-4.5", expected: "openrouter/z-ai/glm-4.5" },
			// A provider and model id without slashes.
			{ provider: "mistral", id: "zai-glm-5-2", expected: "mistral/zai-glm-5-2" },
		];
		for (const { provider, id, expected } of cases) {
			const convertSession = vi.fn(
				async (_input: {
					cwd: string;
					sessionName?: string;
					model?: string;
					thinking?: string;
					timeoutMinutes?: number;
				}) => ({
					sessionId: "sess_cloud_serialized",
					generation: 1,
					connectivity: "connected",
					status: "running",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				}),
			);
			const supervisor = Object.create(DaemonSupervisor.prototype) as unknown as RoutingStubSupervisor;
			const properties = supervisor as unknown as Record<string, unknown>;
			properties.cloud = () => ({ convertSession }) as unknown as CloudSessionRegistry;
			properties.findWorkerForClient = vi.fn(async () => ({
				worker: {} as never,
				summary: { ...summaryFixture(), model: modelFixture(provider, id) },
			}));
			properties.write = vi.fn(() => true);
			properties.log = () => undefined;
			properties.clients = new Set([makeClient()]);

			const response = await supervisor.handleCommand(makeClient(), {
				id: "cloud-create-model",
				type: "cloud_session_create",
				activeSessionId: "active-cloud",
			});

			expect(response).toMatchObject({
				type: "response",
				command: "cloud_session_create",
				success: true,
				data: { session: { sessionId: "sess_cloud_serialized" } },
			});
			expect(convertSession).toHaveBeenCalledWith(expect.objectContaining({ model: expected }));
		}
	});

	it("omits the model when the idle session has none", async () => {
		const convertSession = vi.fn(
			async (_input: { cwd: string; sessionName?: string; model?: string; timeoutMinutes?: number }) => ({
				sessionId: "sess_cloud_no_model",
				generation: 1,
				connectivity: "connected",
				status: "running",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			}),
		);
		const supervisor = Object.create(DaemonSupervisor.prototype) as unknown as RoutingStubSupervisor;
		const properties = supervisor as unknown as Record<string, unknown>;
		properties.cloud = () => ({ convertSession }) as unknown as CloudSessionRegistry;
		properties.findWorkerForClient = vi.fn(async () => ({
			worker: {} as never,
			summary: summaryFixture(),
		}));
		properties.write = vi.fn(() => true);
		properties.log = () => undefined;
		properties.clients = new Set([makeClient()]);

		await supervisor.handleCommand(makeClient(), {
			id: "cloud-create-no-model",
			type: "cloud_session_create",
			activeSessionId: "active-cloud",
		});

		expect(convertSession).toHaveBeenCalledTimes(1);
		const input = convertSession.mock.calls[0][0] as { model?: string };
		expect("model" in input).toBe(false);
	});
});

/**
 * Gate regression for first-class cloud RLM children: `cloud_spawn_child` is
 * declared in the daemon protocol (control-plane, capability-gated on
 * `cloud_resident_sessions`) and implemented in the supervisor's
 * `handleCommand`, but the supervisor's command allowlist once omitted it —
 * the gate answered "Unknown daemon command: cloud_spawn_child" before the
 * case could run, so every `rlm(..., target="cloud")` spawn failed.
 *
 * The harness drives the REAL `handleLine` gate (parse → allowlist → journal →
 * mutation drain → `handleCommand` → registry case); only the registry,
 * worker-lookup, and name-availability seams are stubbed.
 */

interface SpawnGateSupervisor {
	handleLine(client: DaemonSocketClient, line: string): Promise<void>;
	cloud: () => CloudSessionRegistry | undefined;
	findWorkerForClient: (client: DaemonSocketClient, selector: string) => Promise<unknown>;
	assertSupervisorSessionNameAvailable: (target: unknown, name: string) => Promise<void>;
	write: (client: DaemonSocketClient, message: DaemonOutbound) => boolean;
	log: (message: string) => void;
}

function spawnParentSummary(): SessionSummary {
	return {
		...summaryFixture(),
		sessionFile: "/sessions/durable-cloud-owner.jsonl",
		rlmDepth: 0,
	};
}

function spawnAdmissionFixture(): RlmCloudSpawnAdmission {
	return {
		rlm_child_id: "sess_cloud_spawned",
		name: "cloud-kid",
		session_dir: "/sessions/sess_cloud_spawned",
		model: "faux/faux-1",
		cloud_session_id: "sess_cloud_spawned",
		active_session_id: "cloud-active-spawned",
	};
}

function spawnGateSupervisor(options: {
	spawnChild: (input: unknown) => Promise<RlmCloudSpawnAdmission>;
	writes: DaemonOutbound[];
}) {
	const spawnChild = vi.fn(options.spawnChild);
	const registry = { spawnChild } as unknown as CloudSessionRegistry;
	const assertNameAvailable = vi.fn(async () => undefined);
	const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		ready: Promise.resolve(),
		ownership: { assertCurrent: vi.fn(async () => undefined) },
		workers: new Map(),
		clients: new Set([makeClient()]),
		protocolClientIds: new WeakMap(),
		pendingSessionNames: new Set<string>(),
		mutationDrain: new MutationDrainLatch(),
		commandJournal: {
			lookup: vi.fn(() => undefined),
			begin: vi.fn(() => ({ status: "new" as const })),
			recordResult: vi.fn(),
			acknowledge: vi.fn(),
		},
		cancelOwnedWorkerCleanup: vi.fn(),
		findWorkerForClient: vi.fn(async () => ({ worker: {} as never, summary: spawnParentSummary() })),
		assertSupervisorSessionNameAvailable: assertNameAvailable,
		cloud: () => registry,
		write: vi.fn((client: DaemonSocketClient, message: DaemonOutbound) => {
			void client;
			options.writes.push(message);
			return true;
		}),
		log: () => undefined,
	}) as unknown as SpawnGateSupervisor;
	return { supervisor, spawnChild, assertNameAvailable };
}

describe("supervisor cloud_spawn_child command gate", () => {
	it("admits cloud_spawn_child through the real gate and reaches the registry-backed handler", async () => {
		const admission = spawnAdmissionFixture();
		const writes: DaemonOutbound[] = [];
		const { supervisor, spawnChild } = spawnGateSupervisor({ spawnChild: async () => admission, writes });
		const client = makeClient();
		const command = {
			id: "spawn-1",
			type: "cloud_spawn_child",
			parentActiveSessionId: "active-cloud",
			prompt: "investigate the cloud spawn gate",
			name: "cloud-kid",
			model: "faux/faux-1",
		} satisfies DaemonCommand;

		await supervisor.handleLine(client, JSON.stringify(createDaemonCommandEnvelope(command, command.id, client.id)));

		// The command passed the supervisor's allowlist and ran the handler
		// case against the registry seam (parent address, depth, and options).
		expect(spawnChild).toHaveBeenCalledWith(
			expect.objectContaining({
				parent: expect.objectContaining({
					sessionId: "durable-cloud-owner",
					sessionFile: "/sessions/durable-cloud-owner.jsonl",
					activeSessionId: "active-cloud",
					depth: 0,
					cwd: "/repo/cloud",
				}),
				prompt: "investigate the cloud spawn gate",
				name: "cloud-kid",
				model: "faux/faux-1",
			}),
		);
		expect(writes).toEqual([
			expect.objectContaining({
				id: "spawn-1",
				command: "cloud_spawn_child",
				success: true,
				data: { admission },
			}),
		]);
	});

	it("answers with the handler's domain error for an empty prompt, not the gate rejection", async () => {
		const writes: DaemonOutbound[] = [];
		const { supervisor, spawnChild } = spawnGateSupervisor({
			spawnChild: async () => spawnAdmissionFixture(),
			writes,
		});
		const client = makeClient();
		const command = {
			id: "spawn-2",
			type: "cloud_spawn_child",
			parentActiveSessionId: "active-cloud",
			prompt: "   ",
		} satisfies DaemonCommand;

		await supervisor.handleLine(client, JSON.stringify(createDaemonCommandEnvelope(command, command.id, client.id)));

		expect(spawnChild).not.toHaveBeenCalled();
		expect(writes).toEqual([
			expect.objectContaining({
				id: "spawn-2",
				command: "cloud_spawn_child",
				success: false,
				error: "cloud_spawn_child prompt must not be empty",
			}),
		]);
	});

	it("keeps the command capability-gated so an old daemon never receives it", () => {
		// Admitting the command at the supervisor boundary does not weaken the
		// negotiated wire contract: a daemon that does not advertise
		// cloud_resident_sessions (schema revision 31) still refuses it, so a
		// new client surfaces DaemonCapabilityUnavailableError before sending.
		const compatibility = DAEMON_COMMAND_COMPATIBILITY.cloud_spawn_child;
		expect(compatibility).toEqual({ minProtocol: 7, minSchemaRevision: 31, capability: "cloud_resident_sessions" });
		const oldDaemonHello = {
			protocol: { name: "prime-agent.daemon" as const, version: 7 },
			schemaRevision: 30,
			serverCapabilities: ["cloud_sessions", "cloud_tunnel"] as const,
		};
		expect(meetsDaemonCommandCompatibility(oldDaemonHello, compatibility)).toBe(false);
	});
});

/**
 * Bootstrap-read parity for cloud rows: the daemon catalog and local resource
 * surface answer authoritatively at the supervisor instead of failing as
 * unsupported guest commands (the abort that broke the TUI attach).
 */
describe("supervisor cloud bootstrap read parity", () => {
	const catalogModel = {
		id: "faux-1",
		name: "Faux Model",
		api: "faux",
		provider: "faux",
		baseUrl: "http://localhost:0",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	} as unknown as Model<Api>;
	const catalogStub = {
		find: (provider: string, modelId: string) =>
			provider === "faux" && modelId === "faux-1" ? catalogModel : undefined,
		refreshModelCatalog: async () => ({ models: [catalogModel], configuredProviders: ["faux"] }),
		refreshAvailableModels: async () => [catalogModel],
	};
	const cloudStub = {
		resolveActive: () => ({ record: { sessionId: "sess_cloud_boot" }, remoteSessionId: "sess_cloud_boot" }),
		handleSessionCommand: async (command: DaemonCommand) => ({
			id: command.id,
			type: "response",
			command: command.type,
			success: true,
			data: { served: "registry" },
		}),
	};

	function bootstrapRoutingSupervisor(): {
		handleCommand(client: unknown, command: DaemonCommand): Promise<DaemonOutbound | undefined>;
	} {
		return Object.assign(Object.create(DaemonSupervisor.prototype), {
			cloud: () => cloudStub,
			modelCatalog: () => catalogStub,
			log: () => undefined,
		}) as never;
	}

	it("serves get_model_catalog and get_available_models from the supervisor catalog", async () => {
		const supervisor = bootstrapRoutingSupervisor();
		const catalog = await supervisor.handleCommand(makeClient(), {
			id: "boot-catalog",
			type: "get_model_catalog",
			activeSessionId: "active-cloud",
		});
		expect(catalog).toMatchObject({
			command: "get_model_catalog",
			success: true,
			data: { models: [expect.objectContaining({ provider: "faux" })], configuredProviders: ["faux"] },
		});
		const available = await supervisor.handleCommand(makeClient(), {
			id: "boot-available",
			type: "get_available_models",
			activeSessionId: "active-cloud",
		});
		expect(available).toMatchObject({
			command: "get_available_models",
			success: true,
			data: { models: [expect.objectContaining({ provider: "faux" })] },
		});
	});

	it("serves the empty local resource surface and command list for a cloud row", async () => {
		const supervisor = bootstrapRoutingSupervisor();
		const resources = await supervisor.handleCommand(makeClient(), {
			id: "boot-resources",
			type: "get_resource_snapshot",
			activeSessionId: "active-cloud",
		});
		expect(resources).toMatchObject({
			command: "get_resource_snapshot",
			success: true,
			data: {
				contextFiles: [],
				skills: [],
				prompts: [],
				extensions: [],
				themes: [],
				diagnostics: { skills: [], prompts: [], extensions: [], themes: [] },
			},
		});
		const commands = await supervisor.handleCommand(makeClient(), {
			id: "boot-commands",
			type: "get_commands",
			activeSessionId: "active-cloud",
		});
		expect(commands).toMatchObject({ command: "get_commands", success: true, data: { commands: [] } });
	});

	it("routes get_connection_state to the registry command surface", async () => {
		const supervisor = bootstrapRoutingSupervisor();
		const state = await supervisor.handleCommand(makeClient(), {
			id: "boot-connection-state",
			type: "get_connection_state",
			activeSessionId: "active-cloud",
		});
		expect(state).toMatchObject({
			command: "get_connection_state",
			success: true,
			data: { served: "registry" },
		});
	});

	it("still refuses genuinely unsupported guest commands", async () => {
		const supervisor = bootstrapRoutingSupervisor();
		const refused = await supervisor.handleCommand(makeClient(), {
			id: "boot-unsupported",
			type: "get_context_tree",
			activeSessionId: "active-cloud",
		});
		expect(refused).toMatchObject({
			command: "get_context_tree",
			success: false,
			error: expect.stringContaining("is not supported on a cloud session"),
		});
	});
});
