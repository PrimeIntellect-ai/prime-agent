import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Api, fauxAssistantMessage, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudSessionStore } from "../src/core/cloud/cloud-session-store.js";
import type {
	CloudDelegationResultsClient,
	CloudDelegationTunnelClient,
	CloudDelegationVmProcessClient,
	CloudDelegationWorkspaceTransfer,
} from "../src/core/cloud/delegation-orchestrator.js";
import { DirectCloudService, type DirectCloudServiceOptions } from "../src/core/cloud/direct-cloud-service.js";
import type { CloudEvent, CloudInferenceRequest } from "../src/core/cloud/protocol.js";
import { CloudResultStore } from "../src/core/cloud/result-import.js";
import { type CustomEntry, parseSessionEntries } from "../src/core/session-manager.js";
import { CloudInferenceBroker } from "../src/modes/daemon/cloud-inference-broker.js";
import {
	CloudSessionRegistry,
	type CloudSessionRegistryCallbacks,
} from "../src/modes/daemon/cloud-session-registry.js";
import { createDaemonCommandEnvelope, type DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";
import {
	CLOUD_TEST_BRIDGE_TOKEN,
	cloudTemp,
	queueFauxResponse,
	RecordingTunnelTransport,
	seedPrimeInferenceGuestAuth,
	startGuestDaemon,
} from "./cloud-support.js";

/**
 * Strict fake-transport e2e for the supervisor-owned cloud session registry:
 * conversion provisions through fake boundaries, the tunnel attachment drives
 * a REAL in-process guest daemon (faux provider; no network, no paid tokens),
 * session entries mirror into single-writer shadow transcripts before the
 * ack, and remote descendants project child shadows, ledger edges, and
 * roster rows. Recovery, gap fill, and dedupe run against the same on-disk
 * state across registry instances.
 */

const roots: string[] = [];
function temp(): string {
	const value = mkdtempSync(join(tmpdir(), "cloud-session-registry-test-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 5 });
});

const GUEST_SESSION_ID_FOR_DAEMON = "daemon-session-id";

/** A real socket connection to the guest daemon, framed as a tunnel transport. */
interface RegistryHarness {
	registry: CloudSessionRegistry;
	rosterWrites: Map<
		string,
		{ agentId: string; summary: { sessionFile?: string; execution?: { location?: string; connectivity?: string } } }
	>;
	rosterDeletes: string[];
	ledgerEdges: Array<{ childId: string; parent: string; child: string; depth: number; name: string }>;
	ledgerDeletes: Array<{ childId: string; child: string }>;
	sessionEvents: Array<{ activeSessionId: string; type: string }>;
	updates: Array<{ sessionId: string; connectivity?: string }>;
	childUpdates: Array<{
		childId: string;
		parentActiveSessionId: string;
		status: string;
		error?: string;
		answerPreview?: string;
	}>;
	cloudRoot: string;
	sessionDir: string;
	stateDirectory: string;
	store: CloudSessionStore;
	/** Frames the supervisor side sent to the guest (submit requests, open_session payloads). */
	transport: RecordingTunnelTransport;
	/** Every fake VM-process start, newest last; env carries the guest boot model. */
	vmStarts: Array<{ sessionUuid: string; env: Record<string, string> }>;
	/** The recording platform fake; tests flip sandbox status through setSandboxStatus. */
	platform: DirectCloudServiceOptions["platform"];
	setSandboxStatus: (status: string) => void;
}

function buildRegistry(
	root: string,
	guestSocketPath: string,
	options: {
		store?: CloudSessionStore;
		runningProcesses?: Map<string, "running" | "exited">;
		/** Supervisor-side model resolver; makes cloud state carry model objects. */
		resolveModel?: (model: { provider?: string; modelId: string }) => Model<Api> | undefined;
		/** Overrides the writeSessionEvent callback (fan-out wiring in e2e). */
		writeSessionEvent?: CloudSessionRegistryCallbacks["writeSessionEvent"];
		/** Lowers the turn-start window for honest-failure tests. */
		turnStartTimeoutMs?: number;
		/** Liveness sweep cadence for terminal-sandbox tests. */
		sweepIntervalMs?: number;
		/** Wires the brokered-inference hook (the supervisor's broker). */
		onInferenceRequest?: (request: CloudInferenceRequest) => Promise<void>;
		/** Lowers the attachment submit wait for brokered-flow tests. */
		submitWaitMs?: number;
	} = {},
): RegistryHarness {
	const stateDirectory = join(root, "cloud");
	const sessionDir = join(root, "sessions");
	const store = options.store ?? new CloudSessionStore(join(stateDirectory, "sessions"));
	const resultStore = new CloudResultStore(join(stateDirectory, "results"));
	const now = "2026-01-01T00:00:00.000Z";
	const sandbox = {
		id: "sandbox-1",
		name: "cloud",
		dockerImage: "example/cloud:1",
		cpuCores: 4,
		memoryGb: 16,
		diskSizeGb: 50,
		gpuCount: 0,
		vm: true,
		status: "RUNNING",
		timeoutMinutes: 120,
		labels: [],
		createdAt: now,
		updatedAt: now,
	};
	let sandboxStatus = "RUNNING";
	const platform = {
		createVmSandbox: async () => sandbox,
		getSandbox: async () => ({ ...sandbox, status: sandboxStatus }),
		deleteSandbox: async () => undefined,
		getSandboxAuth: async () => ({
			sandboxId: sandbox.id,
			gatewayUrl: "https://gateway.example",
			userNamespace: "user",
			jobId: "job",
			token: "gateway-token",
			expiresAt: "2099-01-01T00:00:00.000Z",
		}),
		uploadFile: async (_sandboxId: string, request: { path: string; content: Uint8Array }) => ({
			path: request.path,
			size: request.content.byteLength,
		}),
		downloadFile: async () => {
			throw new Error("the registry test supplies its own artifact resolver");
		},
	} as unknown as DirectCloudServiceOptions["platform"];
	const workspace: CloudDelegationWorkspaceTransfer = {
		capture: async () => ({
			baseline: {
				repoRoot: root,
				headCommit: null,
				manifestDigest: `sha256:${"b".repeat(64)}`,
			},
			archive: new Uint8Array([1]),
			manifest: new TextEncoder().encode("{}"),
			totalSizeBytes: 3,
			cleanup: () => {},
		}),
		upload: async () => undefined,
	};
	const runningProcesses = options.runningProcesses ?? new Map<string, "running" | "exited">();
	const vmStarts: RegistryHarness["vmStarts"] = [];
	const processClient: CloudDelegationVmProcessClient = {
		start: async (request) => {
			const created = !runningProcesses.has(request.sessionUuid);
			runningProcesses.set(request.sessionUuid, "running");
			vmStarts.push({ sessionUuid: request.sessionUuid, env: { ...request.env } });
			return { sessionUuid: request.sessionUuid, created };
		},
		signalStop: async (sessionUuid) => {
			runningProcesses.set(sessionUuid, "exited");
		},
		status: async (sessionUuid) => {
			const state = runningProcesses.get(sessionUuid);
			if (state === "running") return { state: "running" };
			if (state === "exited") return { state: "exited", exitCode: 0 };
			return { state: "unknown" };
		},
	};
	const results: CloudDelegationResultsClient = {
		fetch: async () => undefined,
		save: async () => undefined,
	};
	const tunnels: CloudDelegationTunnelClient = {
		register: async () => ({
			tunnelId: `tunnel-${Math.random().toString(36).slice(2)}`,
			url: guestSocketPath,
			hostname: "tunnel.example",
			httpUser: "prime-agent",
			httpPassword: "edge-password-0123456789",
			expiresAt: "2099-01-01T00:00:00.000Z",
			frpServerHost: "frp.example",
			frpServerPort: 7000,
			frpToken: "frp-token",
			bindingSecret: "binding-secret",
		}),
		delete: async () => undefined,
		get: async () => ({
			tunnelId: "tunnel",
			url: guestSocketPath,
			hostname: "tunnel.example",
			httpUser: "u",
			expiresAt: "2099-01-01T00:00:00.000Z",
		}),
	};
	const serviceOptions: DirectCloudServiceOptions = {
		stateDirectory,
		apiKey: "platform-key",
		inferenceApiKey: "inference-only-key",
		dockerImage: "example/cloud:1",
		store,
		resultStore,
		platform,
		workspace,
		process: processClient,
		results,
		readiness: { isReady: async () => true },
		tunnels,
		recordFilter: () => true,
	};
	const service = new DirectCloudService(serviceOptions);

	const rosterWrites = new Map<
		string,
		{ agentId: string; summary: { sessionFile?: string; execution?: { location?: string; connectivity?: string } } }
	>();
	const ledgerEdges: RegistryHarness["ledgerEdges"] = [];
	const ledgerDeletes: RegistryHarness["ledgerDeletes"] = [];
	const sessionEvents: RegistryHarness["sessionEvents"] = [];
	const updates: RegistryHarness["updates"] = [];
	const childUpdates: RegistryHarness["childUpdates"] = [];
	const callbacks: CloudSessionRegistryCallbacks = {
		log: () => undefined,
		writeRosterEntry: (entry) => {
			rosterWrites.set(entry.agentId, {
				agentId: entry.agentId,
				summary: entry.summary as never,
			});
		},
		deleteRosterEntry: (agentId) => {
			rosterDeletes.push(agentId);
			rosterWrites.delete(agentId);
		},
		appendLedgerEdge: async (input) => {
			ledgerEdges.push(input);
		},
		deleteLedgerChild: async (input) => {
			ledgerDeletes.push(input);
		},
		writeSessionEvent: options.writeSessionEvent
			? (activeSessionId, event, meta) => options.writeSessionEvent!(activeSessionId, event, meta)
			: (activeSessionId, event) => {
					sessionEvents.push({ activeSessionId, type: (event as { type: string }).type });
					return true;
				},
		writeSessionStatus: () => undefined,
		broadcastCloudSessionUpdate: (record) => {
			updates.push({ sessionId: record.sessionId, connectivity: record.connectivity });
		},
		pushChildUpdate: (update) => {
			childUpdates.push(update);
		},
		cloudFamilyRows: () => [],
		deliverCloudAgentMessage: async () => {
			throw new Error("no cloud message delivery expected in this suite");
		},
		attachedClientCount: () => 0,
	};
	const rosterDeletes: string[] = [];
	const transport = new RecordingTunnelTransport();
	const registry = new CloudSessionRegistry({
		stateDirectory,
		sessionDir,
		cwd: root,
		callbacks,
		service,
		transport,
		bridgeToken: CLOUD_TEST_BRIDGE_TOKEN,
		reconnectDelayMs: 50,
		submitWaitMs: options.submitWaitMs ?? 5_000,
		...(options.turnStartTimeoutMs === undefined ? {} : { turnStartTimeoutMs: options.turnStartTimeoutMs }),
		...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
		...(options.resolveModel === undefined ? {} : { resolveModel: options.resolveModel }),
		...(options.onInferenceRequest === undefined ? {} : { onInferenceRequest: options.onInferenceRequest }),
		artifactResolver: {
			fetch: async () => {
				throw new Error("no artifacts expected in this suite");
			},
		},
	});
	return {
		registry,
		rosterWrites,
		rosterDeletes,
		ledgerEdges,
		ledgerDeletes,
		sessionEvents,
		updates,
		childUpdates,
		cloudRoot: root,
		sessionDir,
		stateDirectory,
		store,
		transport,
		vmStarts,
		platform,
		setSandboxStatus: (status: string) => {
			sandboxStatus = status;
		},
	};
}

/**
 * Drains the event loop until the observable settles: registry attachments,
 * mirror ticks, and socket frames all complete across turns, never a clock.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 20_000, what = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe("CloudSessionRegistry (fake transport, real guest daemon)", () => {
	it("converts an idle session, mirrors prompt entries into a durable shadow before ack, and serves attach from the shadow", async () => {
		const root = cloudTemp("cloud-session-registry-test-");
		const guestSessionId = `sess_${GUEST_SESSION_ID_FOR_DAEMON}`;
		const daemon = await startGuestDaemon(root, 1, guestSessionId);
		const harness = buildRegistry(root, join(root, "guest.sock"));
		try {
			const info = await harness.registry.convertSession({ cwd: root, sessionId: guestSessionId });
			expect(info).toMatchObject({
				connectivity: expect.any(String),
				location: "converted-root",
			});
			expect(info.sessionFile).toBeDefined();
			const record = harness.store.get(info.sessionId)!;
			expect(record).toMatchObject({
				shadowSessionFile: info.sessionFile,
				location: "converted-root",
				observedLifecycle: "running",
				desiredLifecycle: "running",
			});
			expect(record.tunnelState).toBe("registered");
			// The shadow claims the remote session identity locally.
			const shadowEntries = parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8"));
			expect(shadowEntries[0]).toMatchObject({ type: "session", id: info.sessionId });

			// The roster row carries the cloud execution marker.
			await waitFor(() =>
				[...harness.rosterWrites.values()].some((row) => row.summary.execution?.location === "cloud"),
			);
			const rootRow = harness.rosterWrites.get(info.sessionId);
			expect(rootRow).toBeDefined();

			// A prompt rides the v2 attachment into real guest inference.
			queueFauxResponse(root, "cloud registry answer");
			const target = harness.registry.resolveActive(record.activeSessionId!)!;
			expect(target).toBeDefined();
			const response = await harness.registry.handleSessionCommand(
				{ type: "prompt", activeSessionId: record.activeSessionId!, message: "say the thing" },
				target,
			);
			expect(response.success).toBe(true);

			// The guest's session entries mirror into the shadow, durably,
			// before the registry acknowledges the batch.
			await waitFor(() =>
				parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).some(
					(entry) => entry.type === "message" && JSON.stringify(entry).includes("cloud registry answer"),
				),
			);
			const mirrored = parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8"));
			const ids = mirrored.map((entry) => (entry.type === "session" ? "header" : entry.id));
			expect(new Set(ids).size).toBe(ids.length); // dedupe: no duplicate lines
			// The ack cursor advanced only after the shadow held the entries.
			const after = harness.store.get(info.sessionId)!;
			expect(after.ackCursor.sequence).toBeGreaterThan(0);
			expect(after.ackCursor.sequence).toBeLessThanOrEqual(after.eventCursor.sequence);

			// Attach serves snapshot + state from the shadow and cached meta.
			const attach = harness.registry.attachSnapshot(target);
			expect(attach.messages.some((message) => message.role === "user")).toBe(true);
			expect(attach.summary.execution).toMatchObject({ location: "cloud" });
			expect(attach.children).toEqual([]);
			// Live session events reached the supervisor fan-out.
			await waitFor(() => harness.sessionEvents.some((event) => event.type === "message_start"));
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemon.stop().catch(() => undefined);
		}
	});

	it("serves the full TUI bootstrap for a converted session: catalog, resources, state with model, streamed replies, and reattach", async () => {
		const root = temp();
		const guestSessionId = `sess_${GUEST_SESSION_ID_FOR_DAEMON}_bootstrap`;
		const fauxModel: Model<Api> = {
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
		} as Model<Api>;
		const resolveModel = (model: { provider?: string; modelId: string }): Model<Api> | undefined =>
			model.provider === "faux" && model.modelId === "faux-1" ? fauxModel : undefined;
		const daemon = await startGuestDaemon(root, 1, guestSessionId);
		// The registry's event callback fans out through the supervisor's real
		// writeCloudSessionEvent once the stub exists (the production wiring).
		let eventFanout: CloudSessionRegistryCallbacks["writeSessionEvent"] | undefined;
		let broker: CloudInferenceBroker | undefined;
		const harness = buildRegistry(root, join(root, "guest.sock"), {
			resolveModel,
			writeSessionEvent: (activeSessionId, event, meta) => eventFanout?.(activeSessionId, event, meta) ?? false,
			// The supervisor's brokered-inference hook: the guest opens this
			// session on a non-prime model, which the guest stubs onto the
			// cloud-broker api, so the turn's completion rides the local
			// broker exactly like a real session's non-prime model would.
			onInferenceRequest: (request) => broker!.runRequest(request),
		});
		// The local provider the broker resolves faux/faux-1 against and
		// streams from; the sandbox holds no provider credential.
		const registration = registerFauxProvider({ models: [{ id: "faux-1", contextWindow: 128_000 }] });
		broker = new CloudInferenceBroker({
			resolveModel: (selector) =>
				selector.provider === "faux" ? (registration.getModel(selector.modelId) as Model<Api>) : undefined,
			sendFrame: (frame) => harness.registry.sendInferenceFrame(frame),
			onUsage: (sessionId, remoteSessionId, usage) =>
				harness.registry.recordBrokeredUsage(sessionId, remoteSessionId, usage),
		});
		// The supervisor's model-catalog seam, as the daemon would own it.
		const catalogStub = {
			find: (provider: string, modelId: string) =>
				provider === "faux" && modelId === "faux-1" ? fauxModel : undefined,
			refreshModelCatalog: async () => ({ models: [fauxModel], configuredProviders: ["faux"] }),
			refreshAvailableModels: async () => [fauxModel],
		};
		type GateFrame = {
			id?: string;
			type?: string;
			command?: string;
			success?: boolean;
			data?: Record<string, unknown>;
			activeSessionId?: string;
			event?: { type?: string };
			snapshot?: { state?: { model?: { provider: string; id: string } }; messages?: Array<{ role: string }> };
		};
		const writes: GateFrame[] = [];
		const client = {
			id: "bootstrap-client",
			socket: { destroyed: false },
			attachedActiveSessionIds: new Set<string>(),
			detachInput: () => undefined,
			supportsExtensionUi: false,
			capabilities: new Set<string>(),
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			ready: Promise.resolve(),
			ownership: { assertCurrent: vi.fn(async () => undefined) },
			workers: new Map(),
			clients: new Set([client]),
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
			cloud: () => harness.registry,
			modelCatalog: () => catalogStub,
			write: vi.fn((_client: unknown, message: GateFrame) => {
				writes.push(message);
				return true;
			}),
			log: () => undefined,
		}) as unknown as { handleLine(client: unknown, line: string): Promise<void> };
		eventFanout = (activeSessionId, event, meta) =>
			(
				supervisor as unknown as {
					writeCloudSessionEvent(activeSessionId: string, event: unknown, meta: unknown): boolean;
				}
			).writeCloudSessionEvent(activeSessionId, event, meta);
		let commandCounter = 0;
		const send = async (command: Omit<DaemonCommand, "id">) => {
			const id = `bootstrap-${++commandCounter}`;
			await supervisor.handleLine(
				client,
				JSON.stringify(createDaemonCommandEnvelope({ ...command, id } as DaemonCommand, id, client.id)),
			);
			return writes.find((frame) => frame.id === id && frame.type === "response");
		};
		try {
			// Conversion records the canonical selector the guest opens with.
			const info = await harness.registry.convertSession({
				cwd: root,
				sessionId: guestSessionId,
				model: "faux/faux-1",
			});
			const record = harness.store.get(info.sessionId)!;
			await waitFor(
				() => [...harness.rosterWrites.values()].some((row) => row.summary.execution?.location === "cloud"),
				10_000,
				"cloud roster row",
			);

			// The attach bootstrap reads every answer success: the daemon
			// catalog serves model reads, and the local resource surface is
			// empty for a sandbox-resident session.
			const catalog = await send({
				type: "get_model_catalog",
				activeSessionId: record.activeSessionId!,
			} as never);
			expect(catalog).toMatchObject({ command: "get_model_catalog", success: true });
			expect(catalog?.data).toMatchObject({ configuredProviders: ["faux"] });
			const available = await send({
				type: "get_available_models",
				activeSessionId: record.activeSessionId!,
			} as never);
			expect(available?.data).toMatchObject({ models: [expect.objectContaining({ provider: "faux" })] });
			const resources = await send({
				type: "get_resource_snapshot",
				activeSessionId: record.activeSessionId!,
			} as never);
			expect(resources?.data).toMatchObject({
				contextFiles: [],
				skills: [],
				prompts: [],
				extensions: [],
				themes: [],
				diagnostics: { skills: [], prompts: [], extensions: [], themes: [] },
			});
			const commands = await send({
				type: "get_commands",
				activeSessionId: record.activeSessionId!,
			} as never);
			expect(commands?.data).toEqual({ commands: [] });

			// Rendered tools resolve without a guest round-trip: the builtin
			// definition is identical to the runtime's registry, and extension
			// tools resolve to no definition instead of an error.
			const builtinTool = await send({
				type: "get_tool_definition",
				activeSessionId: record.activeSessionId!,
				name: "ipython",
			} as never);
			expect(builtinTool).toMatchObject({
				command: "get_tool_definition",
				success: true,
				data: {
					toolDefinition: {
						name: "ipython",
						label: "ipython",
						description: expect.stringContaining("persistent Python REPL"),
					},
				},
			});
			const unknownTool = await send({
				type: "get_tool_definition",
				activeSessionId: record.activeSessionId!,
				name: "extension_tool",
			} as never);
			expect(unknownTool).toMatchObject({ command: "get_tool_definition", success: true });
			expect((unknownTool as { data?: { toolDefinition?: unknown } }).data?.toolDefinition).toBeUndefined();

			// State carries the resolved current model and its thinking levels
			// so the prompt bar renders model and thinking.
			for (const type of ["get_state", "get_connection_state"] as const) {
				const state = await send({ type, activeSessionId: record.activeSessionId! } as never);
				expect(state).toMatchObject({ command: type, success: true });
				expect(state?.data?.model).toMatchObject({ provider: "faux", id: "faux-1" });
				expect((state?.data?.availableThinkingLevels as string[]).length).toBeGreaterThan(0);
			}

			// Enter the row: attach serves the shadow snapshot and marks the
			// client as the event subscriber for the cloud row.
			const attach = await send({ type: "attach", activeSessionId: record.activeSessionId! } as never);
			expect(attach).toMatchObject({ command: "attach", success: true });
			expect(writes.some((frame) => frame.type === "session_attached")).toBe(true);

			// A prompt round-trips through the brokered guest: the local
			// provider answers the relayed request, and the reply mirrors
			// into the shadow AND streams to the attached client as session
			// events.
			registration.setResponses([fauxAssistantMessage("bootstrap parity answer")]);
			const prompt = await send({
				type: "prompt",
				activeSessionId: record.activeSessionId!,
				message: "run the bootstrap parity check",
			} as never);
			expect(prompt).toMatchObject({ command: "prompt", success: true });
			await waitFor(
				() =>
					parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).some(
						(entry) => entry.type === "message" && JSON.stringify(entry).includes("bootstrap parity answer"),
					),
				20_000,
				"mirrored assistant answer",
			);
			await waitFor(
				() =>
					writes.some(
						(frame) =>
							frame.type === "session_event" &&
							frame.activeSessionId === record.activeSessionId &&
							frame.event?.type === "message_end",
					),
				20_000,
				"streamed assistant reply",
			);
			// The full turn's lifecycle reaches the attached client: the
			// loader spins up on agent_start and lands on agent_end.
			expect(
				writes.some(
					(frame) =>
						frame.type === "session_event" &&
						frame.activeSessionId === record.activeSessionId &&
						frame.event?.type === "agent_start",
				),
			).toBe(true);
			await waitFor(
				() =>
					writes.some(
						(frame) =>
							frame.type === "session_event" &&
							frame.activeSessionId === record.activeSessionId &&
							frame.event?.type === "agent_end",
					),
				20_000,
				"agent_end relay",
			);
			// The meta flip pushed its own client state update, both directions.
			await waitFor(
				() =>
					writes.some(
						(frame) =>
							frame.type === "session_event" &&
							frame.activeSessionId === record.activeSessionId &&
							frame.event?.type === "streaming_state" &&
							(frame.event as { streaming?: boolean }).streaming === false,
					),
				20_000,
				"streaming flip push",
			);
			// The turn ended: state reports isStreaming false, so the prompt
			// spinner cannot stick.
			const settledState = await send({
				type: "get_connection_state",
				activeSessionId: record.activeSessionId!,
			} as never);
			expect(settledState?.data).toMatchObject({ isStreaming: false });
			// The roster row now carries the current model and cumulative usage.
			await waitFor(
				() => {
					const candidate = [...harness.rosterWrites.values()].find(
						(entry) => entry.summary.execution?.location === "cloud",
					);
					const summary = candidate?.summary as unknown as { usage?: { inputTokens: number } } | undefined;
					return summary?.usage !== undefined;
				},
				20_000,
				"roster row model and usage",
			);
			const row = [...harness.rosterWrites.values()].find(
				(candidate) => candidate.summary.execution?.location === "cloud",
			);
			expect(row).toBeDefined();
			const rowSummary = row!.summary as unknown as {
				model?: { provider: string; id: string };
				usage?: { inputTokens: number; outputTokens: number };
			};
			expect(rowSummary.model).toMatchObject({ provider: "faux", id: "faux-1" });
			// The relayed completion's usage is the local provider's honest
			// accounting: the row carries the same cumulative totals the
			// guest's transcript holds.
			const brokered = daemon.rootSession?.messages.at(-1) as
				| { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }
				| undefined;
			const brokeredInput = brokered?.usage?.input ?? 0;
			const brokeredOutput = brokered?.usage?.output ?? 0;
			const brokeredCacheRead = brokered?.usage?.cacheRead ?? 0;
			expect(rowSummary.usage).toMatchObject({ inputTokens: brokeredInput, outputTokens: brokeredOutput });

			// The prompt bar's context tray carries honest usage: the mirrored
			// cumulative totals against the model's context window.
			const brokeredTotal = brokeredInput + brokeredOutput + brokeredCacheRead;
			const contextState = await send({
				type: "get_connection_state",
				activeSessionId: record.activeSessionId!,
			} as never);
			expect(contextState?.data?.contextUsage).toEqual({
				tokens: brokeredTotal,
				contextWindow: 128_000,
				percent: (brokeredTotal / 128_000) * 100,
			});

			// Shadow-served reads answer for cloud rows: stats, forking
			// lists, and the last answer, all without a guest round-trip.
			const stats = await send({
				type: "get_session_stats",
				activeSessionId: record.activeSessionId!,
			} as never);
			expect(stats?.data).toMatchObject({
				userMessages: 1,
				assistantMessages: 1,
				// user + assistant + the injected harness-digest custom message
				totalMessages: 3,
				tokens: {
					input: brokeredInput,
					output: brokeredOutput,
					cacheRead: brokeredCacheRead,
					total: brokeredTotal,
				},
				cost: 0,
				contextUsage: { tokens: brokeredTotal, contextWindow: 128_000 },
			});
			const forking = await send({
				type: "get_user_messages_for_forking",
				activeSessionId: record.activeSessionId!,
			} as never);
			expect((forking?.data?.messages as Array<{ entryId: string; text: string }>).length).toBe(1);
			expect((forking?.data?.messages as Array<{ text: string }>)[0]?.text).toContain(
				"run the bootstrap parity check",
			);
			const lastAnswer = await send({
				type: "get_last_assistant_text",
				activeSessionId: record.activeSessionId!,
			} as never);
			expect(lastAnswer?.data?.text).toBe("bootstrap parity answer");

			// Leave to the agents view and re-enter: reattach replays the
			// full conversation with the same model in state.
			const reattach = await send({ type: "attach", activeSessionId: record.activeSessionId! } as never);
			expect(reattach).toMatchObject({ command: "attach", success: true });
			const attachedFrames = writes.filter((frame) => frame.type === "session_attached");
			const latestSnapshot = attachedFrames.at(-1)?.snapshot;
			expect(latestSnapshot?.state?.model).toMatchObject({ provider: "faux", id: "faux-1" });
			expect(
				latestSnapshot?.messages?.some(
					(message) => message.role === "assistant" && JSON.stringify(message).includes("bootstrap parity answer"),
				),
			).toBe(true);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			registration.unregister();
			await daemon.stop().catch(() => undefined);
		}
		// test-policy: allow explicit-test-timeout -- real in-process guest daemon e2e; the 30s default flakes on loaded runners
	}, 60_000);

	it("projects remote descendants as child shadows with parent edges and roster rows, and removes them on delete", async () => {
		const root = cloudTemp("cloud-session-registry-test-");
		const guestSessionId = `sess_${GUEST_SESSION_ID_FOR_DAEMON}_child`;
		const daemon = await startGuestDaemon(root, 1, guestSessionId);
		const harness = buildRegistry(root, join(root, "guest.sock"));
		try {
			const info = await harness.registry.convertSession({ cwd: root, sessionId: guestSessionId });
			const record = harness.store.get(info.sessionId)!;
			const target = harness.registry.resolveActive(record.activeSessionId!)!;
			queueFauxResponse(root, "parent answer");
			await harness.registry.handleSessionCommand(
				{ type: "prompt", activeSessionId: record.activeSessionId!, message: "spawn nothing yet" },
				target,
			);
			await waitFor(() => harness.registry.resolveActive(record.activeSessionId!) !== undefined);

			// A real recursive child through the guest's runtime host.
			const runtime = daemon.rootRuntime!;
			const session = daemon.rootSession!;
			const child = await runtime.createRlmSubagentRuntime({
				parentSession: session!,
				id: "child-reg-1",
				prompt: "child task",
				sessionName: "cloudkid",
				sessionDir: join(root, "child-session"),
				model: session!.model as never,
				thinkingLevel: session!.thinkingLevel,
				serviceTier: session!.serviceTier ?? "auto",
				scopedModels: [...session!.scopedModels],
				activeToolNames: [],
				customTools: [],
				includeGoals: false,
				includeCompactSkill: true,
				rlmDepth: 1,
				rlmMaxDepth: 4,
				rlmParentNodeId: "child-reg-1",
			});
			expect(child.session.sessionName).toBe("cloudkid");

			// roster_delta announces the child; child_update carries its session file.
			await waitFor(() => harness.registry.liveSummaries().some((summary) => summary.rlmChildId === "child-reg-1"));
			const childSummary = harness.registry.liveSummaries().find((summary) => summary.rlmChildId === "child-reg-1")!;
			expect(childSummary.execution).toMatchObject({ location: "cloud" });
			expect(childSummary.runtimeKind).toBe("subagent");
			expect(childSummary.parentSessionPath).toBe(record.shadowSessionFile);
			// The child's shadow mirrors its session entries.
			await waitFor(() => existsSync(childSummary.sessionFile!));
			const childShadowEntries = parseSessionEntries(readFileSync(childSummary.sessionFile!, "utf8"));
			expect(childShadowEntries[0]).toMatchObject({ type: "session", rlmDepth: 1 });
			// The ledger edge records the local parent-child relationship.
			await waitFor(() =>
				harness.ledgerEdges.some(
					(edge) => edge.childId === "child-reg-1" && basename(edge.parent) === `${info.sessionId}.jsonl`,
				),
			);
			const edge = harness.ledgerEdges.find((edge) => edge.childId === "child-reg-1")!;
			expect(basename(edge.child)).not.toBe(basename(edge.parent));
			expect(realpathSync(dirname(edge.child))).toBe(realpathSync(harness.sessionDir));

			// Deleting the child through the cloud protocol retracts the row.
			await harness.registry.handleSessionCommand(
				{ type: "delete_rlm_subagent", activeSessionId: record.activeSessionId!, childId: "child-reg-1" },
				{
					...target,
					descendant: false,
				},
			);
			await waitFor(() => !harness.registry.liveSummaries().some((summary) => summary.rlmChildId === "child-reg-1"));
			await waitFor(
				() =>
					harness.rosterDeletes.length > 0 &&
					harness.ledgerDeletes.some((entry) => entry.childId === "child-reg-1"),
			);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemon.stop().catch(() => undefined);
		}
	});

	it("recovers rows and reconnects after a supervisor restart, filling the gap without duplicates", async () => {
		const root = cloudTemp("cloud-session-registry-test-");
		const guestSessionId = `sess_${GUEST_SESSION_ID_FOR_DAEMON}_restart`;
		const daemon = await startGuestDaemon(root, 1, guestSessionId);
		const guestSocket = join(root, "guest.sock");
		const runningProcesses = new Map<string, "running" | "exited">();
		const harness = buildRegistry(root, guestSocket, { runningProcesses });
		let info: Awaited<ReturnType<CloudSessionRegistry["convertSession"]>>;
		try {
			info = await harness.registry.convertSession({ cwd: root, sessionId: guestSessionId });
			const record = harness.store.get(info.sessionId)!;
			const target = harness.registry.resolveActive(record.activeSessionId!)!;
			queueFauxResponse(root, "before restart");
			await harness.registry.handleSessionCommand(
				{ type: "prompt", activeSessionId: record.activeSessionId!, message: "before the restart" },
				target,
			);
			await waitFor(() =>
				parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).some((entry) =>
					JSON.stringify(entry).includes("before the restart"),
				),
			);
			const beforeCount = parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).length;

			// Supervisor restart: dispose the registry (attachments stop), drive
			// one more guest turn through the protocol directly (the gap), then
			// recover with a fresh registry over the same durable state.
			await harness.registry.dispose();
			await driveGuestTurnDirect(guestSocket, record.sessionId, root, "during the restart gap");

			const second = buildRegistry(root, guestSocket, { store: harness.store, runningProcesses });
			await second.registry.recover();
			await waitFor(() => second.registry.resolveActive(record.activeSessionId!) !== undefined);
			// The row address is durable: the same activeSessionId resolves.
			expect(second.registry.resolveActive(record.activeSessionId!)).toBeDefined();
			// Gap fill: the shadow catches up and never duplicates a line.
			await waitFor(() =>
				parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).some((entry) =>
					JSON.stringify(entry).includes("during the restart gap"),
				),
			);
			const after = parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8"));
			expect(after.length).toBeGreaterThan(beforeCount);
			const ids = after.map((entry) => (entry.type === "session" ? "header" : entry.id));
			expect(new Set(ids).size).toBe(ids.length);
			const rec = second.store.get(record.sessionId)!;
			expect(rec.ackCursor.sequence).toBeGreaterThan(0);
			await second.registry.dispose();
		} finally {
			await daemon.stop().catch(() => undefined);
		}
	});

	it("keeps a stopped session locally readable and marks the record stopped", async () => {
		const root = cloudTemp("cloud-session-registry-test-");
		const guestSessionId = `sess_${GUEST_SESSION_ID_FOR_DAEMON}_stop`;
		const daemon = await startGuestDaemon(root, 1, guestSessionId);
		const harness = buildRegistry(root, join(root, "guest.sock"));
		try {
			const info = await harness.registry.convertSession({ cwd: root, sessionId: guestSessionId });
			const record = harness.store.get(info.sessionId)!;
			const target = harness.registry.resolveActive(record.activeSessionId!)!;
			queueFauxResponse(root, "final answer");
			await harness.registry.handleSessionCommand(
				{ type: "prompt", activeSessionId: record.activeSessionId!, message: "final turn" },
				target,
			);
			await waitFor(() =>
				parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).some((entry) =>
					JSON.stringify(entry).includes("final answer"),
				),
			);
			const stopped = await harness.registry.stopSession(info.sessionId, false);
			expect(stopped.status).toBe("stopped");
			expect(stopped.connectivity).toBe("stopped");
			const after = harness.store.get(info.sessionId)!;
			expect(after.observedLifecycle).toBe("stopped");
			expect(after.cleanupState).toBe("released");
			// The shadow remains an ordinary, locally readable transcript.
			expect(existsSync(after.shadowSessionFile!)).toBe(true);
			const rows = harness.registry.liveSummaries();
			expect(rows).toHaveLength(0);
			const listed = await harness.registry.listSessions();
			expect(listed.find((entry) => entry.sessionId === info.sessionId)).toMatchObject({
				connectivity: "stopped",
				status: "stopped",
			});
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemon.stop().catch(() => undefined);
		}
	});

	it("brokers a guest inference request through the wired local broker and records its usage", async () => {
		const root = cloudTemp("cloud-session-registry-test-");
		const guestSessionId = "sess_broker_e2e";
		const registration = registerFauxProvider({ models: [{ id: "faux-1", contextWindow: 100_000 }] });
		registration.setResponses([fauxAssistantMessage("brokered answer")]);
		// A fake guest bridge: it answers hello with a snapshot and lets the
		// test push frames onto the attachment's connection.
		const server: Server = createServer();
		const sockets = new Set<Socket>();
		const received: Array<Record<string, unknown>> = [];
		const guestSocket = join(root, "broker-guest.sock");
		server.on("connection", (socket: Socket) => {
			sockets.add(socket);
			let buffer = "";
			socket.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.length === 0) continue;
					try {
						const parsed = JSON.parse(line) as Record<string, unknown>;
						received.push(parsed);
						if (parsed.type === "hello") {
							socket.write(
								`${JSON.stringify({
									type: "snapshot",
									sessionId: guestSessionId,
									generation: 1,
									cursor: { generation: 1, sequence: 0 },
									status: "idle",
									state: { cwd: root, modelId: "faux/faux-1", queuedCommandIds: [] },
									events: [],
								})}\n`,
							);
						}
					} catch {
						// A non-JSON line is not this test's concern.
					}
				}
			});
			socket.on("close", () => sockets.delete(socket));
		});
		await new Promise<void>((resolve) => server.listen(guestSocket, resolve));
		let broker: CloudInferenceBroker | undefined;
		const harness = buildRegistry(root, guestSocket, {
			resolveModel: (model) =>
				model.provider === "faux" && model.modelId === "faux-1"
					? (registration.getModel("faux-1") as Model<Api>)
					: undefined,
			submitWaitMs: 50,
			onInferenceRequest: (request) => broker!.runRequest(request),
		});
		broker = new CloudInferenceBroker({
			resolveModel: (selector) =>
				selector.provider === "faux" ? (registration.getModel(selector.modelId) as Model<Api>) : undefined,
			sendFrame: (frame) => harness.registry.sendInferenceFrame(frame),
			onUsage: (sessionId, remoteSessionId, usage) =>
				harness.registry.recordBrokeredUsage(sessionId, remoteSessionId, usage),
		});
		try {
			const info = await harness.registry.convertSession({
				cwd: root,
				sessionId: guestSessionId,
				model: "faux/faux-1",
			});
			const record = harness.store.get(info.sessionId)!;
			expect(record.observedLifecycle).toBe("running");
			// The attachment is live once the fake bridge answered hello.
			await waitFor(() => received.some((frame) => frame.type === "subscribe"));
			sockets.forEach((socket) => {
				socket.write(
					`${JSON.stringify({
						type: "inference_request",
						sessionId: info.sessionId,
						remoteSessionId: info.sessionId,
						requestId: "req_e2e_1",
						model: { provider: "faux", modelId: "faux-1" },
						payload: {
							messages: [{ role: "user", content: "say it", timestamp: 1 }],
							options: { systemPrompt: "You are a test assistant." },
						},
					})}\n`,
				);
			});
			await waitFor(() =>
				received.some((frame) => frame.type === "inference_end" && frame.requestId === "req_e2e_1"),
			);
			// Events streamed in order before the terminal end frame.
			const inference = received.filter(
				(frame) => typeof frame.type === "string" && frame.type.startsWith("inference_"),
			);
			expect(inference.at(-1)).toMatchObject({ type: "inference_end", requestId: "req_e2e_1" });
			expect(inference.slice(0, -1).every((frame) => frame.type === "inference_event")).toBe(true);
			expect(inference.length).toBeGreaterThan(2);
			// Brokered usage is locally accounted, so the cloud row's context
			// meter covers brokered models exactly like mirrored ones.
			const target = harness.registry.resolveActive(record.activeSessionId!)!;
			const stats = await harness.registry.handleSessionCommand(
				{ type: "get_session_stats", activeSessionId: record.activeSessionId! },
				target,
			);
			const tokens = (stats as { data?: { tokens?: { input: number; output: number } } }).data?.tokens;
			expect(tokens?.input ?? 0).toBeGreaterThan(0);
			expect(tokens?.output ?? 0).toBeGreaterThan(0);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			registration.unregister();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			for (const socket of sockets) socket.destroy();
		}
	});
});

describe("CloudSessionRegistry command translation (v2 attachment)", () => {
	it("fails prompt_and_wait honestly when the submitted turn never starts", async () => {
		const root = temp();
		const guestSessionId = "sess_wait_for_turn";
		const daemon = await startGuestDaemon(root, 1, guestSessionId);
		const harness = buildRegistry(root, join(root, "guest.sock"), { turnStartTimeoutMs: 1_500 });
		try {
			const info = await harness.registry.convertSession({ cwd: root, sessionId: guestSessionId });
			const record = harness.store.get(info.sessionId)!;
			const target = harness.registry.resolveActive(record.activeSessionId!)!;
			await waitFor(
				() => harness.registry.resolveActive(record.activeSessionId!)!.summary.execution !== undefined,
				10_000,
				"target ready",
			);

			// The guest stops serving before the prompt is submitted, so the
			// turn can never start. prompt_and_wait must fail honestly instead
			// of settling on the not-yet-started idle state.
			await daemon.stop();
			queueFauxResponse(root, "never delivered");
			const settled = await harness.registry.handleSessionCommand(
				{ type: "prompt_and_wait", activeSessionId: record.activeSessionId!, message: "never runs" },
				target,
			);
			expect(settled.success).toBe(false);
			expect(String((settled as { error?: unknown }).error)).toContain("did not start the submitted turn");
		} finally {
			await harness.registry.dispose();
			await daemon.stop().catch(() => undefined);
		}
	});

	it("marks a live session lost when its sandbox terminates, and releases the attachment", async () => {
		const root = temp();
		const guestSessionId = "sess_sweep_lost";
		const daemon = await startGuestDaemon(root, 1, guestSessionId);
		const harness = buildRegistry(root, join(root, "guest.sock"), { sweepIntervalMs: 50 });
		try {
			const info = await harness.registry.convertSession({ cwd: root, sessionId: guestSessionId });
			const record = harness.store.get(info.sessionId)!;
			await waitFor(
				() => harness.registry.resolveActive(record.activeSessionId!)?.summary.execution !== undefined,
				10_000,
				"target ready",
			);
			expect(harness.registry.resolveActive(record.activeSessionId!)).toBeDefined();

			// The platform reports the sandbox TERMINATED (its lifetime
			// timeout): the sweep must mark the record lost and release the
			// attachment instead of letting it retry against a dead sandbox.
			harness.setSandboxStatus("TERMINATED");
			await waitFor(
				() => harness.store.get(record.sessionId)?.observedLifecycle === "lost",
				10_000,
				"lost after sweep",
			);
			await waitFor(
				() => harness.registry.resolveActive(record.activeSessionId!) === undefined,
				10_000,
				"live row released",
			);
			const lost = harness.store.get(record.sessionId)!;
			expect(lost.lastError).toContain("TERMINATED");
		} finally {
			await harness.registry.dispose();
			await daemon.stop().catch(() => undefined);
			// The guest daemon coalesces mirror passes on setImmediate; a
			// queued pass that outlives stop() would write its durable outbox
			// after this suite's afterEach removed the temp root. One
			// setImmediate turn (the queue is FIFO and drains fully) runs any
			// pending pass while the root still exists.
			await new Promise((resolve) => setImmediate(resolve));
		}
	});

	it("refuses prompts against a disconnected session with actionable guidance", async () => {
		const root = temp();
		const guestSessionId = "sess_disconnected_prompt";
		const daemon = await startGuestDaemon(root, 1, guestSessionId);
		const harness = buildRegistry(root, join(root, "guest.sock"));
		try {
			const info = await harness.registry.convertSession({ cwd: root, sessionId: guestSessionId });
			const record = harness.store.get(info.sessionId)!;
			const target = harness.registry.resolveActive(record.activeSessionId!)!;
			await waitFor(
				() => harness.registry.resolveActive(record.activeSessionId!)!.summary.execution !== undefined,
				10_000,
				"target ready",
			);

			// Simulate a dead tunnel: stop the attachment so requireConnected
			// refuses, and the refusal names the recovery commands.
			await harness.registry.stopAttachment(record.sessionId);
			const refused = await harness.registry.handleSessionCommand(
				{ type: "prompt", activeSessionId: record.activeSessionId!, message: "never runs" },
				target,
			);
			expect(refused.success).toBe(false);
			const error = String((refused as { error?: unknown }).error);
			expect(error).toContain("/cloud reprovision");
			expect(error).toContain("/cloud stop");
		} finally {
			await harness.registry.dispose();
			await daemon.stop().catch(() => undefined);
		}
	});

	it("translates the normal session command surface onto cloud commands", async () => {
		const root = cloudTemp("cloud-session-registry-test-");
		const guestSessionId = "sess_translate_me";
		const daemon = await startGuestDaemon(root, 1, guestSessionId);
		const harness = buildRegistry(root, join(root, "guest.sock"));
		try {
			const info = await harness.registry.convertSession({ cwd: root, sessionId: guestSessionId });
			const record = harness.store.get(info.sessionId)!;
			const target = harness.registry.resolveActive(record.activeSessionId!)!;
			await waitFor(() => harness.registry.resolveActive(record.activeSessionId!)!.summary.execution !== undefined);

			// Name changes mirror as session_info entries into the shadow.
			// Steer and follow-up each drive one faux inference turn.
			queueFauxResponse(root, "answer for steer");
			queueFauxResponse(root, "answer for follow up");
			const renamed = await harness.registry.handleSessionCommand(
				{ type: "set_session_name", activeSessionId: record.activeSessionId!, name: "cloud-registry-suite" },
				target,
			);
			expect(renamed.success).toBe(true);
			await waitFor(() =>
				parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).some(
					(entry) => entry.type === "session_info" && entry.name === "cloud-registry-suite",
				),
			);

			// steer / follow_up ride the same durable command surface.
			const steered = await harness.registry.handleSessionCommand(
				{ type: "steer", activeSessionId: record.activeSessionId!, message: "steer this" },
				target,
			);
			expect(steered.success).toBe(true);
			const followed = await harness.registry.handleSessionCommand(
				{ type: "follow_up", activeSessionId: record.activeSessionId!, message: "follow that" },
				target,
			);
			expect(followed.success).toBe(true);

			// Model and thinking-level changes fail honestly on unknown prime
			// models instead of silently falling back; non-prime providers
			// stub to the local broker, where an unknown model fails at
			// inference time.
			const modelFailure = await harness.registry.handleSessionCommand(
				{
					type: "set_model",
					activeSessionId: record.activeSessionId!,
					provider: "prime-inference",
					modelId: "gpt-not-real",
				},
				target,
			);
			expect(modelFailure.success).toBe(false);
			const thinking = await harness.registry.handleSessionCommand(
				{ type: "set_thinking_level", activeSessionId: record.activeSessionId!, level: "off" },
				target,
			);
			expect(thinking.success).toBe(true);

			// Unknown child ids fail the receipt honestly.
			const cancelFailure = await harness.registry.handleSessionCommand(
				{ type: "cancel_rlm_child", activeSessionId: record.activeSessionId!, childId: "missing-child" },
				target,
			);
			expect(cancelFailure.success).toBe(false);

			// Read-only snapshots come from the shadow, no tunnel round-trip.
			const state = await harness.registry.handleSessionCommand(
				{ type: "get_state", activeSessionId: record.activeSessionId! },
				target,
			);
			expect(state.success).toBe(true);
			const header = await harness.registry.handleSessionCommand(
				{ type: "get_session_header", activeSessionId: record.activeSessionId! },
				target,
			);
			expect(header.success).toBe(true);
			const queue = await harness.registry.handleSessionCommand(
				{ type: "get_queue", activeSessionId: record.activeSessionId! },
				target,
			);
			expect(queue.success).toBe(true);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemon.stop().catch(() => undefined);
		}
	});

	it("answers a cancelled prompt admission honestly and never admits twice", async () => {
		const root = cloudTemp("cloud-session-registry-test-");
		const guestSessionId = "sess_admission_cancel";
		const daemon = await startGuestDaemon(root, 1, guestSessionId);
		const harness = buildRegistry(root, join(root, "guest.sock"));
		try {
			const info = await harness.registry.convertSession({ cwd: root, sessionId: guestSessionId });
			const record = harness.store.get(info.sessionId)!;
			const target = harness.registry.resolveActive(record.activeSessionId!)!;
			// The supervisor marks the admission cancelled before ownership.
			const cancelled = await harness.registry.handleSessionCommand(
				{ type: "prompt", activeSessionId: record.activeSessionId!, message: "never mind" },
				target,
				{ isCancelled: () => true, markOwned: () => undefined },
			);
			expect(cancelled).toMatchObject({ success: false });
			const failureText = (cancelled as { error?: string }).error;
			expect(failureText).toContain("Prompt admission was cancelled");
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemon.stop().catch(() => undefined);
		}
	});

	it("reprovisions a stopped session: same session id, new generation, shadow keeps its history", async () => {
		const root = cloudTemp("cloud-session-registry-test-");
		const guestSessionId = "sess_reprovision_me";
		const daemonOne = await startGuestDaemon(root, 1, guestSessionId);
		const runningProcesses = new Map<string, "running" | "exited">();
		const harness = buildRegistry(root, join(root, "guest.sock"), { runningProcesses });
		try {
			const info = await harness.registry.convertSession({
				cwd: root,
				sessionId: guestSessionId,
				sessionName: "reprovision",
			});
			const record = harness.store.get(info.sessionId)!;
			const target = harness.registry.resolveActive(record.activeSessionId!)!;
			queueFauxResponse(root, "before reprovision");
			await harness.registry.handleSessionCommand(
				{ type: "prompt", activeSessionId: record.activeSessionId!, message: "one turn before" },
				target,
			);
			await waitFor(() =>
				parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).some((entry) =>
					JSON.stringify(entry).includes("before reprovision"),
				),
			);
			const beforeEntries = parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8"));

			// Stop: the guest daemon goes away with the sandbox.
			await harness.registry.stopSession(info.sessionId, false);
			await daemonOne.stop();
			const stopped = harness.store.get(info.sessionId)!;
			expect(stopped.observedLifecycle).toBe("stopped");
			expect(harness.registry.liveSummaries()).toHaveLength(0);

			// A fresh sandbox incarnation hosts the same logical session.
			const daemonTwo = await startGuestDaemon(root, 2, guestSessionId);
			let reprovisioned: Awaited<ReturnType<CloudSessionRegistry["reprovisionSession"]>>;
			try {
				reprovisioned = await harness.registry.reprovisionSession(info.sessionId);
				expect(reprovisioned.generation).toBe(2);
				expect(reprovisioned.sessionId).toBe(info.sessionId);
				expect(reprovisioned.connectivity).not.toBe("stopped");
				const after = harness.store.get(info.sessionId)!;
				expect(after.observedLifecycle).toBe("running");
				// The roster row returns under the same durable session id.
				await waitFor(() =>
					harness.registry.liveSummaries().some((summary) => summary.sessionId === info.sessionId),
				);
				// The shadow kept its history and records the generation boundary.
				const entries = parseSessionEntries(readFileSync(after.shadowSessionFile!, "utf8"));
				const marker = entries.find(
					(entry): entry is CustomEntry =>
						entry.type === "custom" && entry.customType === "prime-agent.cloud-generation",
				);
				expect(marker?.data).toMatchObject({ generation: 2 });
				expect(entries.length).toBeGreaterThan(beforeEntries.length);
				// Drain the registry first so in-flight guest settles land
				// while the guest's durable state is still on disk.
				await harness.registry.dispose();
			} finally {
				await daemonTwo.stop().catch(() => undefined);
				// A bounded turn drain lets the guest's final in-flight mirror
				// settles land before teardown removes its durable state.
				for (let turn = 0; turn < 10; turn++) {
					await new Promise((resolve) => setImmediate(resolve));
				}
			}
			void reprovisioned;
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemonOne.stop().catch(() => undefined);
		}
	});

	it("preserves the canonical provider-qualified model from supervisor create through the record and guest open, across reprovision", async () => {
		const root = cloudTemp("cloud-session-registry-test-");
		seedPrimeInferenceGuestAuth(root);
		// The public catalog background refresh may fetch unauthenticated and
		// best-effort; the private route itself must resolve from the seeded
		// entitlement cache, never an authenticated network call.
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify({ data: [] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const harness = buildRegistry(root, join(root, "guest.sock"));
		// The real supervisor command path drives the real registry.
		const supervisor = supervisorForRegistry(harness.registry, {
			...localSummaryFixture(root),
			model: modelFixture("prime-inference", "internal/glm-5.3-fast"),
		});
		let daemonOne: Awaited<ReturnType<typeof startGuestDaemon>> | undefined;
		let daemonTwo: Awaited<ReturnType<typeof startGuestDaemon>> | undefined;
		try {
			const created = (await supervisor.handleCommand(makeDaemonClient(), {
				id: "cmd-create-model",
				type: "cloud_session_create",
				activeSessionId: "active-local",
			})) as { success?: boolean; data?: { session?: { sessionId?: string; connectivity?: string } } };
			expect(created.success).toBe(true);
			const sessionId = created.data?.session?.sessionId;
			expect(sessionId).toBeDefined();

			// The registry record persists the exact canonical selector.
			const record = harness.store.get(sessionId!)!;
			expect(record.model).toBe("prime-inference/internal/glm-5.3-fast");

			// The sandbox boot env carries the exact selector: the guest
			// splits it at the first slash into the provider `prime-inference`
			// and the model id `internal/glm-5.3-fast`.
			expect(harness.vmStarts.at(-1)?.env.PRIME_AGENT_CLOUD_MODEL).toBe("prime-inference/internal/glm-5.3-fast");

			// The registry allocated the session id before any compute, exactly
			// like the sandbox env is set in production; the guest boots under
			// that id, the attachment connects, and the queued open_session
			// delivers the canonical selector.
			daemonOne = await startGuestDaemon(root, 1, sessionId!);
			await waitFor(
				() =>
					openSessionSubmits(harness.transport).length === 1 &&
					daemonOne?.rootSession?.model?.id === "internal/glm-5.3-fast",
			);
			expect(openSessionSubmits(harness.transport)[0].model).toBe("prime-inference/internal/glm-5.3-fast");
			expect(daemonOne?.rootSession?.model).toMatchObject({
				provider: "prime-inference",
				id: "internal/glm-5.3-fast",
			});

			// Stop: the guest daemon goes away with the sandbox.
			await harness.registry.stopSession(sessionId!, false);
			await daemonOne?.stop();

			// A fresh incarnation must re-open the same canonical model, never
			// a re-prefixed selector or the sandbox image default. The fresh
			// sandbox carries fresh guest state, exactly like a new VM.
			daemonTwo = await startGuestDaemon(root, 2, sessionId!, join(root, "guest-daemon-state-two"));
			const reprovisioned = (await supervisor.handleCommand(makeDaemonClient(), {
				id: "cmd-reprovision-model",
				type: "cloud_session_reprovision",
				activeSessionId: sessionId!,
			})) as { success?: boolean; data?: { session?: { generation?: number } } };
			expect(reprovisioned.success).toBe(true);
			expect(reprovisioned.data?.session?.generation).toBe(2);
			expect(harness.vmStarts.at(-1)?.env.PRIME_AGENT_CLOUD_MODEL).toBe("prime-inference/internal/glm-5.3-fast");
			await waitFor(
				() =>
					openSessionSubmits(harness.transport).length === 2 &&
					daemonTwo?.rootSession?.model?.id === "internal/glm-5.3-fast",
			);
			expect(openSessionSubmits(harness.transport)[1].model).toBe("prime-inference/internal/glm-5.3-fast");
			expect(daemonTwo?.rootSession?.model).toMatchObject({
				provider: "prime-inference",
				id: "internal/glm-5.3-fast",
			});
			// The regenerated durable record still holds the canonical selector.
			expect(harness.store.get(sessionId!)?.model).toBe("prime-inference/internal/glm-5.3-fast");
			// Every model resolution was cache-served: no authenticated
			// entitlement fetch ever fired.
			const entitlementFetches = fetchMock.mock.calls.filter(([, init]) =>
				new Headers(init?.headers).has("Authorization"),
			);
			expect(entitlementFetches).toHaveLength(0);
		} finally {
			vi.unstubAllGlobals();
			await harness.registry.dispose().catch(() => undefined);
			await daemonOne?.stop().catch(() => undefined);
			await daemonTwo?.stop().catch(() => undefined);
		}
	});
});

/** A resolvable model for the summary the supervisor conversion serializes. */
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

/** An idle local session summary: convertible, with no messages yet. */
function localSummaryFixture(root: string): Record<string, unknown> {
	return {
		id: "active-local",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		activeSessionId: "active-local",
		sessionId: "durable-local-owner",
		cwd: root,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 1,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

/** Minimal supervisor client for handleCommand on the real prototype. */
function makeDaemonClient(): { id: string; socket: { destroyed: boolean }; capabilities: Set<string> } {
	return { id: "client-model-serialization", socket: { destroyed: false }, capabilities: new Set() };
}

/** Structural view of the supervisor seams the conversion path drives. */
interface SupervisorStub {
	handleCommand: (client: unknown, command: unknown) => Promise<unknown>;
	cloud: () => CloudSessionRegistry | undefined;
	findWorkerForClient: (client: unknown, selector: string) => Promise<unknown>;
	write: (client: unknown, message: unknown) => boolean;
	log: (message: string) => void;
	clients: Set<unknown>;
}

/** The real supervisor command path over the real registry; only the worker lookup is stubbed. */
function supervisorForRegistry(registry: CloudSessionRegistry, summary: Record<string, unknown>): SupervisorStub {
	const supervisor = Object.create(DaemonSupervisor.prototype) as unknown as SupervisorStub;
	const properties = supervisor as unknown as Record<string, unknown>;
	properties.cloud = () => registry;
	properties.findWorkerForClient = vi.fn(async () => ({ worker: {}, summary }));
	properties.write = vi.fn(() => true);
	properties.log = () => undefined;
	properties.clients = new Set([makeDaemonClient()]);
	return supervisor;
}

/** Every open_session request the supervisor side submitted to the guest. */
function openSessionSubmits(transport: RecordingTunnelTransport): Array<{ model?: string }> {
	return transport.sentFrames
		.map((frame) => JSON.parse(frame) as { type?: string; request?: { kind?: string; model?: string } })
		.filter((frame) => frame.type === "submit" && frame.request?.kind === "open_session")
		.map((frame) => frame.request!);
}

/** Submit one prompt + ack batches directly over the guest socket (the gap source). */
async function driveGuestTurnDirect(
	guestSocketPath: string,
	sessionId: string,
	root: string,
	text: string,
): Promise<void> {
	queueFauxResponse(root, text);
	const { cloudRequestDigest } = await import("../src/core/cloud/protocol.js");
	const socket = createConnection(guestSocketPath);
	socket.setNoDelay(true);
	const frames: CloudEvent[] = [];
	let buffer = "";
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.length === 0) continue;
			try {
				const parsed = JSON.parse(line) as {
					type?: string;
					events?: CloudEvent[];
					generation?: number;
					cursor?: { sequence: number };
				};
				if (parsed.type === "snapshot" || parsed.type === "events") {
					frames.push(...(parsed.events ?? []));
					const tail = (parsed.events ?? []).at(-1)?.sequence ?? parsed.cursor?.sequence ?? 0;
					socket.write(
						`${JSON.stringify({ type: "ack", sessionId, cursor: { generation: parsed.generation ?? 1, sequence: tail } })}\n`,
					);
				}
			} catch {
				// ignore
			}
		}
	});
	await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	socket.write(
		`${JSON.stringify({
			type: "hello",
			protocolVersion: 3,
			generation: 1,
			clientId: "gap_driver",
			sessionId,
			authToken: CLOUD_TEST_BRIDGE_TOKEN,
		})}\n`,
	);
	// Subscribe immediately: the tail-resumed snapshot replays from zero, so
	// frames arrive on data events. Live pushes then carry the command
	// receipt and the mirrored session entry - data-driven, never a clock.
	socket.write(`${JSON.stringify({ type: "subscribe", sessionId, cursor: { generation: 1, sequence: 0 } })}\n`);
	await waitFor(() => frames.length > 0);
	const request = { kind: "prompt", text: `say: ${text}` } as const;
	const commandId = `gap_${text.replace(/\s+/g, "_")}`;
	socket.write(
		`${JSON.stringify({
			type: "submit",
			sessionId,
			generation: 1,
			commandId,
			request,
			digest: cloudRequestDigest(request),
		})}\n`,
	);
	// The subscribed push stream carries the prompt's terminal state, then the
	// mirror's session entry for it; both arrive as socket data events.
	await waitFor(() =>
		frames.some(
			(event) =>
				event.kind === "command_state" &&
				(event.receipt as { commandId?: string }).commandId === commandId &&
				(event.receipt as { state?: string }).state === "completed",
		),
	);
	await waitFor(() =>
		frames.some((event) => event.kind === "session_entry" && JSON.stringify(event.entry).includes(text)),
	);
	// A bounded turn drain lets the acks flush before the socket is torn down.
	for (let turn = 0; turn < 10; turn++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	socket.destroy();
	await closed;
}
