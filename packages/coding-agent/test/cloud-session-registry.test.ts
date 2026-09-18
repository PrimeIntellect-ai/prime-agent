import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type {
	CloudTunnelConnection,
	CloudTunnelTransport,
	CloudTunnelTransportError,
} from "../src/core/cloud/bridge/tunnel-transport.js";
import { CloudSessionStore } from "../src/core/cloud/cloud-session-store.js";
import type {
	CloudDelegationResultsClient,
	CloudDelegationTunnelClient,
	CloudDelegationVmProcessClient,
	CloudDelegationWorkspaceTransfer,
} from "../src/core/cloud/delegation-orchestrator.js";
import { DirectCloudService, type DirectCloudServiceOptions } from "../src/core/cloud/direct-cloud-service.js";
import type { CloudEvent } from "../src/core/cloud/protocol.js";
import { CloudResultStore } from "../src/core/cloud/result-import.js";
import { type CustomEntry, parseSessionEntries } from "../src/core/session-manager.js";
import { CloudGuestDaemon, parseCloudDaemonEnv } from "../src/modes/cloud/cloud-daemon.js";
import {
	CloudSessionRegistry,
	type CloudSessionRegistryCallbacks,
} from "../src/modes/daemon/cloud-session-registry.js";
import { createFauxRuntimeFactory } from "./fixtures/cloud-guest-daemon-fixture.js";

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

const BRIDGE_TOKEN = "t".repeat(64);
const GUEST_SESSION_ID_FOR_DAEMON = "daemon-session-id";

/** A real socket connection to the guest daemon, framed as a tunnel transport. */
class SocketTunnelTransport implements CloudTunnelTransport {
	readonly sentFrames: string[] = [];
	private socket: Socket | undefined;
	private messageHandler: ((message: string) => void) | undefined;
	private closeHandler: ((error?: CloudTunnelTransportError) => void) | undefined;
	private buffer = "";
	private earlyLines: string[] = [];

	async connect(socketPath: string): Promise<CloudTunnelConnection> {
		await new Promise<void>((resolve, reject) => {
			this.socket = createConnection(socketPath);
			this.socket.setNoDelay(true);
			this.socket.once("connect", () => resolve());
			this.socket.once("error", (error) => reject(error));
		});
		this.socket!.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8");
			for (;;) {
				const newline = this.buffer.indexOf("\n");
				if (newline < 0) break;
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				if (line.length === 0) continue;
				if (this.messageHandler !== undefined) this.messageHandler(line);
				else this.earlyLines.push(line);
			}
		});
		this.socket!.on("close", () => this.closeHandler?.());
		return {
			send: (message: string) => {
				this.sentFrames.push(message);
				this.socket?.write(`${message}\n`);
			},
			close: () => this.socket?.destroy(),
			onMessage: (handler) => {
				this.messageHandler = handler;
				for (const line of this.earlyLines.splice(0)) handler(line);
			},
			onClose: (handler) => {
				this.closeHandler = handler;
			},
		};
	}
}

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
}

function daemonEnv(root: string, generation: number, sessionId: string) {
	return parseCloudDaemonEnv(
		{
			PRIME_AGENT_CLOUD_DAEMON_SOCKET: join(root, "guest.sock"),
			PRIME_AGENT_CLOUD_SESSION_ID: sessionId,
			PRIME_AGENT_CLOUD_GENERATION: String(generation),
			PRIME_AGENT_CLOUD_WORKSPACE_DIR: join(root, "workspace"),
			PRIME_AGENT_CLOUD_AGENT_DIR: join(root, "guest-agent"),
			PRIME_AGENT_CLOUD_BRIDGE_TOKEN: BRIDGE_TOKEN,
			PRIME_AGENT_CLOUD_PROMPT_PATH: join(root, "prompt.txt"),
			PRIME_AGENT_CLOUD_MODEL: "",
			PRIME_AGENT_CLOUD_DAEMON_STATE_DIR: join(root, "guest-daemon-state"),
		},
		{ stateDir: join(root, "guest-daemon-state") },
	);
}

async function startGuestDaemon(root: string, generation: number, sessionId: string) {
	const daemon = await CloudGuestDaemon.start(daemonEnv(root, generation, sessionId), {
		createRuntime: createFauxRuntimeFactory,
	});
	daemon.startMirrorLoop();
	return daemon;
}

function buildRegistry(
	root: string,
	guestSocketPath: string,
	options: { store?: CloudSessionStore; runningProcesses?: Map<string, "running" | "exited"> } = {},
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
	const platform = {
		createVmSandbox: async () => sandbox,
		getSandbox: async () => sandbox,
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
	const processClient: CloudDelegationVmProcessClient = {
		start: async (request) => {
			const created = !runningProcesses.has(request.sessionUuid);
			runningProcesses.set(request.sessionUuid, "running");
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
		writeSessionEvent: (activeSessionId, event) => {
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
		attachedClientCount: () => 0,
	};
	const rosterDeletes: string[] = [];
	const transport = new SocketTunnelTransport();
	const registry = new CloudSessionRegistry({
		stateDirectory,
		sessionDir,
		cwd: root,
		callbacks,
		service,
		transport,
		bridgeToken: BRIDGE_TOKEN,
		reconnectDelayMs: 50,
		submitWaitMs: 5_000,
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
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000, what = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function queueFauxResponse(root: string, text: string): void {
	const responsesPath = join(root, "responses.jsonl");
	process.env.PRIME_AGENT_TEST_FAUX_RESPONSES = responsesPath;
	delete process.env.PRIME_AGENT_TEST_FAUX_ECHO;
	const response: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		timestamp: Date.now(),
		usage: {
			input: 3,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 8,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AssistantMessage;
	const existing = existsSync(responsesPath) ? readFileSync(responsesPath, "utf8") : "";
	writeFileSync(responsesPath, `${existing}${JSON.stringify(response)}\n`, { mode: 0o600 });
}

describe("CloudSessionRegistry (fake transport, real guest daemon)", () => {
	it("converts an idle session, mirrors prompt entries into a durable shadow before ack, and serves attach from the shadow", async () => {
		const root = temp();
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
			await waitFor(
				() => [...harness.rosterWrites.values()].some((row) => row.summary.execution?.location === "cloud"),
				10_000,
				"cloud roster row",
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
			await waitFor(
				() =>
					parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).some(
						(entry) => entry.type === "message" && JSON.stringify(entry).includes("cloud registry answer"),
					),
				20_000,
				"mirrored assistant answer",
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
			await waitFor(
				() => harness.sessionEvents.some((event) => event.type === "message_start"),
				20_000,
				"live session events",
			);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemon.stop().catch(() => undefined);
		}
	}, 60_000);

	it("projects remote descendants as child shadows with parent edges and roster rows, and removes them on delete", async () => {
		const root = temp();
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
			await waitFor(() => harness.registry.resolveActive(record.activeSessionId!) !== undefined, 10_000, "row live");

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
			await waitFor(
				() => harness.registry.liveSummaries().some((summary) => summary.rlmChildId === "child-reg-1"),
				20_000,
				"child roster row",
			);
			const childSummary = harness.registry.liveSummaries().find((summary) => summary.rlmChildId === "child-reg-1")!;
			expect(childSummary.execution).toMatchObject({ location: "cloud" });
			expect(childSummary.runtimeKind).toBe("subagent");
			expect(childSummary.parentSessionPath).toBe(record.shadowSessionFile);
			// The child's shadow mirrors its session entries.
			await waitFor(() => existsSync(childSummary.sessionFile!), 20_000, "child shadow file");
			const childShadowEntries = parseSessionEntries(readFileSync(childSummary.sessionFile!, "utf8"));
			expect(childShadowEntries[0]).toMatchObject({ type: "session", rlmDepth: 1 });
			// The ledger edge records the local parent-child relationship.
			await waitFor(
				() =>
					harness.ledgerEdges.some(
						(edge) => edge.childId === "child-reg-1" && basename(edge.parent) === `${info.sessionId}.jsonl`,
					),
				20_000,
				"ledger edge",
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
			await waitFor(
				() => !harness.registry.liveSummaries().some((summary) => summary.rlmChildId === "child-reg-1"),
				20_000,
				"child row removed",
			);
			await waitFor(
				() =>
					harness.rosterDeletes.length > 0 &&
					harness.ledgerDeletes.some((entry) => entry.childId === "child-reg-1"),
				20_000,
				"child ledger delete",
			);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemon.stop().catch(() => undefined);
		}
	}, 60_000);

	it("recovers rows and reconnects after a supervisor restart, filling the gap without duplicates", async () => {
		const root = temp();
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
			await waitFor(
				() =>
					parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).some((entry) =>
						JSON.stringify(entry).includes("before the restart"),
					),
				20_000,
				"pre-restart mirror",
			);
			const beforeCount = parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).length;

			// Supervisor restart: dispose the registry (attachments stop), drive
			// one more guest turn through the protocol directly (the gap), then
			// recover with a fresh registry over the same durable state.
			await harness.registry.dispose();
			await driveGuestTurnDirect(guestSocket, record.sessionId, root, "during the restart gap");

			const second = buildRegistry(root, guestSocket, { store: harness.store, runningProcesses });
			await second.registry.recover();
			await waitFor(
				() => second.registry.resolveActive(record.activeSessionId!) !== undefined,
				20_000,
				"recovered row",
			);
			// The row address is durable: the same activeSessionId resolves.
			expect(second.registry.resolveActive(record.activeSessionId!)).toBeDefined();
			// Gap fill: the shadow catches up and never duplicates a line.
			await waitFor(
				() =>
					parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).some((entry) =>
						JSON.stringify(entry).includes("during the restart gap"),
					),
				20_000,
				"gap fill",
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
	}, 60_000);

	it("keeps a stopped session locally readable and marks the record stopped", async () => {
		const root = temp();
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
			await waitFor(
				() =>
					parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).some((entry) =>
						JSON.stringify(entry).includes("final answer"),
					),
				20_000,
				"final mirror",
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
	}, 60_000);
});

describe("CloudSessionRegistry command translation (v2 attachment)", () => {
	it("translates the normal session command surface onto cloud commands", async () => {
		const root = temp();
		const guestSessionId = "sess_translate_me";
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

			// Name changes mirror as session_info entries into the shadow.
			// Steer and follow-up each drive one faux inference turn.
			queueFauxResponse(root, "answer for steer");
			queueFauxResponse(root, "answer for follow up");
			const renamed = await harness.registry.handleSessionCommand(
				{ type: "set_session_name", activeSessionId: record.activeSessionId!, name: "cloud-registry-suite" },
				target,
			);
			expect(renamed.success).toBe(true);
			await waitFor(
				() =>
					parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).some(
						(entry) => entry.type === "session_info" && entry.name === "cloud-registry-suite",
					),
				20_000,
				"mirrored session name",
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

			// Model and thinking-level changes fail honestly on unknown models
			// instead of silently falling back.
			const modelFailure = await harness.registry.handleSessionCommand(
				{
					type: "set_model",
					activeSessionId: record.activeSessionId!,
					provider: "openai",
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
	}, 60_000);

	it("answers a cancelled prompt admission honestly and never admits twice", async () => {
		const root = temp();
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
	}, 60_000);

	it("reprovisions a stopped session: same session id, new generation, shadow keeps its history", async () => {
		const root = temp();
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
			await waitFor(
				() =>
					parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8")).some((entry) =>
						JSON.stringify(entry).includes("before reprovision"),
					),
				20_000,
				"pre-reprovision mirror",
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
				await waitFor(
					() => harness.registry.liveSummaries().some((summary) => summary.sessionId === info.sessionId),
					20_000,
					"reprovisioned roster row",
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
				// Let the guest's final mirror tick drain before teardown
				// removes its durable state.
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			void reprovisioned;
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemonOne.stop().catch(() => undefined);
		}
	}, 90_000);
});

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
			protocolVersion: 2,
			generation: 1,
			clientId: "gap_driver",
			sessionId,
			authToken: BRIDGE_TOKEN,
		})}\n`,
	);
	const request = { kind: "prompt", text: `say: ${text}` } as const;
	socket.write(
		`${JSON.stringify({
			type: "submit",
			sessionId,
			generation: 1,
			commandId: `gap_${text.replace(/\s+/g, "_")}`,
			request,
			digest: cloudRequestDigest(request),
		})}\n`,
	);
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		if (frames.some((event) => event.kind === "session_entry" && JSON.stringify(event.entry).includes(text))) {
			break;
		}
	}
	await new Promise((resolve) => setTimeout(resolve, 300));
	socket.destroy();
	await closed;
}
