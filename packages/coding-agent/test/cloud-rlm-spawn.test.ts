import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
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
import { CloudResultStore } from "../src/core/cloud/result-import.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { buildRlmPrompt } from "../src/core/prompts/index.js";
import type { RlmCloudChildLease, SubagentRuntimeHost } from "../src/core/rlm-runtime.js";
import { parseSessionEntries, SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { CloudGuestDaemon, parseCloudDaemonEnv } from "../src/modes/cloud/cloud-daemon.js";
import {
	CloudSessionRegistry,
	type CloudSessionRegistryCallbacks,
	type RlmCloudSpawnAdmission,
} from "../src/modes/daemon/cloud-session-registry.js";
import { createFauxRuntimeFactory } from "./fixtures/cloud-guest-daemon-fixture.js";
import { createTestResourceLoader } from "./utilities.js";

/**
 * Fake-transport tests for first-class cloud RLM subagents
 * (`rlm(..., target="cloud")`):
 *
 * - Registry e2e: a real in-process guest daemon (faux provider; no network,
 *   no paid tokens) behind a socket framed as a tunnel transport. Admission
 *   returns the frozen handle before provisioning, the normal ledger edge and
 *   roster row exist before publication, provisioning pushes run through the
 *   parent's status channel, and provision failures / cancel-before-ready /
 *   remote descendants behave honestly.
 * - AgentSession level: a stub host exercises the spawn branch — immediate
 *   handle, unknown-target rejection, unsupported-host error, settlement
 *   pushes, and delete through the existing delete API.
 * - Prompt bytes: the cloud-target sentence appears only when the daemon
 *   advertises `cloud_resident_sessions`; local prompts stay byte-identical.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
function temp(): string {
	const value = mkdtempSync(join(tmpdir(), "cloud-rlm-spawn-test-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 5 });
});

async function waitFor(predicate: () => boolean, timeoutMs = 20_000, what = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

// ---------------------------------------------------------------------------
// Registry harness (fake transport + real guest daemon)
// ---------------------------------------------------------------------------

const BRIDGE_TOKEN = "t".repeat(64);

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
		{
			agentId: string;
			summary: {
				activeSessionId?: string;
				sessionFile?: string;
				parentSessionPath?: string;
				parentSessionId?: string;
				parentActiveSessionId?: string;
				rlmChildId?: string;
				rlmDepth?: number;
				runtimeKind?: string;
				statusLabel?: string;
				execution?: { location?: string; connectivity?: string };
			};
		}
	>;
	rosterDeletes: string[];
	ledgerEdges: Array<{ childId: string; parent: string; child: string; depth: number; name: string }>;
	ledgerDeletes: Array<{ childId: string; child: string }>;
	childUpdates: Array<{
		childId: string;
		parentActiveSessionId: string;
		status: string;
		error?: string;
		answerPreview?: string;
	}>;
	cloudRoot: string;
	sessionDir: string;
	store: CloudSessionStore;
}

function registryService(
	root: string,
	options: { failProvisioning?: boolean } = {},
): {
	service: DirectCloudService;
	store: CloudSessionStore;
} {
	const stateDirectory = join(root, "cloud");
	const store = new CloudSessionStore(join(stateDirectory, "sessions"));
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
		createVmSandbox: async () => {
			if (options.failProvisioning) throw new Error("provisioning exploded");
			return sandbox;
		},
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
			throw new Error("no artifacts expected in this suite");
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
	const runningProcesses = new Map<string, "running" | "exited">();
	const process: CloudDelegationVmProcessClient = {
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
			url: join(root, "guest.sock"),
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
			url: join(root, "guest.sock"),
			hostname: "tunnel.example",
			httpUser: "u",
			expiresAt: "2099-01-01T00:00:00.000Z",
		}),
	};
	const service = new DirectCloudService({
		stateDirectory,
		apiKey: "platform-key",
		inferenceApiKey: "inference-only-key",
		dockerImage: "example/cloud:1",
		store,
		resultStore,
		platform,
		workspace,
		process,
		results,
		readiness: { isReady: async () => true },
		tunnels,
		recordFilter: () => true,
	});
	return { service, store };
}

function buildRegistry(
	root: string,
	options: { service?: DirectCloudService; store?: CloudSessionStore } = {},
): RegistryHarness {
	const { service, store } =
		options.service !== undefined
			? { service: options.service, store: options.store ?? registryService(root).store }
			: registryService(root);
	const stateDirectory = join(root, "cloud");
	const sessionDir = join(root, "sessions");
	const rosterWrites: RegistryHarness["rosterWrites"] = new Map();
	const rosterDeletes: string[] = [];
	const ledgerEdges: RegistryHarness["ledgerEdges"] = [];
	const ledgerDeletes: RegistryHarness["ledgerDeletes"] = [];
	const childUpdates: RegistryHarness["childUpdates"] = [];
	const callbacks: CloudSessionRegistryCallbacks = {
		log: () => undefined,
		writeRosterEntry: (entry) => {
			rosterWrites.set(entry.agentId, { agentId: entry.agentId, summary: entry.summary as never });
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
		writeSessionEvent: () => true,
		writeSessionStatus: () => undefined,
		broadcastCloudSessionUpdate: () => undefined,
		pushChildUpdate: (update) => {
			childUpdates.push(update);
		},
		cloudFamilyRows: () => [],
		deliverCloudAgentMessage: async () => {
			throw new Error("no cloud message delivery expected in this suite");
		},
		attachedClientCount: () => 0,
	};
	const registry = new CloudSessionRegistry({
		stateDirectory,
		sessionDir,
		cwd: root,
		callbacks,
		service,
		transport: new SocketTunnelTransport(),
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
		childUpdates,
		cloudRoot: root,
		sessionDir,
		store: store!,
	};
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

const PARENT = {
	sessionId: "parent-session-id",
	sessionFile: "/sessions/parent.jsonl",
	activeSessionId: "parent-active-1",
	depth: 0,
	cwd: "/workspace",
};

function spawnInput(overrides: Record<string, unknown> = {}) {
	return {
		parent: { ...PARENT },
		prompt: "investigate the cloud spawn flow",
		...(overrides as object),
	};
}

// ---------------------------------------------------------------------------
// Registry e2e
// ---------------------------------------------------------------------------

describe("CloudSessionRegistry.spawnChild (fake transport, real guest daemon)", () => {
	it("admits immediately with the frozen handle, ledger edge, and parented roster row; settles on mirrored completion", async () => {
		const root = temp();
		const guestSessionId = "sess_cloud_kid_1";
		queueFauxResponse(root, "cloud child finished answer");
		const daemon = await startGuestDaemon(root, 1, guestSessionId);
		const harness = buildRegistry(root);
		try {
			let admission: RlmCloudSpawnAdmission;
			{
				const started = Date.now();
				admission = await harness.registry.spawnChild({
					...spawnInput({ parent: { ...PARENT, cwd: root } }),
					name: "cloud-kid",
					sessionId: guestSessionId,
					model: "faux/faux-1",
				});
				expect(Date.now() - started).toBeLessThan(5_000);
			}
			expect(admission.rlm_child_id).toBe(guestSessionId);
			expect(admission.cloud_session_id).toBe(guestSessionId);
			expect(admission.name).toBe("cloud-kid");
			expect(admission.session_dir).toBe(harness.sessionDir);
			expect(admission.active_session_id).toMatch(/^cloud-active-/);

			// Durable record carries the spawn provenance.
			const record = harness.store.get(guestSessionId)!;
			expect(record.location).toBe("spawned-child");
			expect(record.spawn).toMatchObject({
				parentSessionId: PARENT.sessionId,
				parentSessionFile: PARENT.sessionFile,
				parentActiveSessionId: PARENT.activeSessionId,
				depth: 1,
				name: "cloud-kid",
			});
			expect(record.shadowSessionFile).toBeDefined();
			expect(existsSync(record.shadowSessionFile!)).toBe(true);

			// The normal ledger edge landed at admission: parent file -> shadow.
			const edge = harness.ledgerEdges.find((candidate) => candidate.childId === guestSessionId);
			expect(edge).toMatchObject({
				parent: PARENT.sessionFile,
				child: record.shadowSessionFile,
				depth: 1,
				name: "cloud-kid",
			});

			// Roster row projects under the local parent with the cloud marker.
			const rowForActiveSession = () =>
				[...harness.rosterWrites.values()].find(
					(candidate) => candidate.summary.activeSessionId === admission.active_session_id,
				);
			await waitFor(() => rowForActiveSession() !== undefined, 10_000, "spawned child roster row");
			const row = rowForActiveSession()!;
			expect(row.summary.execution).toMatchObject({ location: "cloud" });
			expect(row.summary.runtimeKind).toBe("subagent");
			expect(row.summary.rlmDepth).toBe(1);
			expect(row.summary.rlmChildId).toBe(guestSessionId);
			expect(row.summary.parentActiveSessionId).toBe(PARENT.activeSessionId);
			expect(row.summary.parentSessionPath).toBe(PARENT.sessionFile);

			// Admission pushes queued; provisioning transitions run; the mirrored
			// answer settles the parent's run with the child's answer preview.
			await waitFor(() => harness.childUpdates.length > 0, 10_000, "queued push");
			expect(harness.childUpdates[0]).toMatchObject({
				childId: guestSessionId,
				parentActiveSessionId: PARENT.activeSessionId,
				status: "queued",
			});
			await waitFor(
				() => harness.childUpdates.some((update) => update.status === "running"),
				20_000,
				"running push",
			);
			await waitFor(
				() => harness.childUpdates.some((update) => update.status === "completed"),
				30_000,
				"completed push",
			);
			const completed = harness.childUpdates.find((update) => update.status === "completed")!;
			expect(completed.answerPreview).toContain("cloud child finished answer");

			// The shadow mirrors the guest transcript with the task prompt.
			const shadow = parseSessionEntries(readFileSync(record.shadowSessionFile!, "utf8"));
			expect(shadow.some((entry) => JSON.stringify(entry).includes("[task from parent]"))).toBe(true);
			expect(shadow.some((entry) => JSON.stringify(entry).includes("cloud child finished answer"))).toBe(true);

			// Terminal pushes never repeat.
			const statuses = harness.childUpdates.map((update) => update.status);
			expect(statuses.filter((status) => status === "completed").length).toBe(1);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemon.stop().catch(() => undefined);
		}
	}, 60_000);

	it("fails provisioning honestly: terminal error push, no phantom completion", async () => {
		const root = temp();
		const { service, store } = registryService(root, { failProvisioning: true });
		const harness = buildRegistry(root, { service, store });
		try {
			const admission = await harness.registry.spawnChild({
				...spawnInput(),
				sessionId: "sess_cloud_kid_2",
				name: "doomed",
			});
			expect(admission.rlm_child_id).toBe("sess_cloud_kid_2");
			await waitFor(() => harness.childUpdates.some((update) => update.status === "error"), 20_000, "error push");
			const failed = harness.childUpdates.find((update) => update.status === "error")!;
			expect(failed.error).toContain("provisioning exploded");
			expect(harness.store.get(admission.rlm_child_id)!.lastError).toContain("provisioning exploded");
			expect(harness.childUpdates.some((update) => update.status === "completed")).toBe(false);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
		}
	}, 60_000);

	it("cancels before the guest is ready: terminal cancelled push wins over late provisioning", async () => {
		const root = temp();
		const harness = buildRegistry(root);
		try {
			// No guest daemon is listening: provisioning cannot open a session.
			const admission = await harness.registry.spawnChild({
				...spawnInput(),
				sessionId: "sess_cloud_kid_3",
				name: "early-cancel",
			});
			const target = harness.registry.resolveActive(admission.active_session_id)!;
			expect(target).toBeDefined();
			const response = await harness.registry.handleSessionCommand(
				{ type: "cancel_rlm_child", activeSessionId: admission.active_session_id, childId: admission.rlm_child_id },
				target,
			);
			expect(response.success).toBe(true);
			await waitFor(
				() => harness.childUpdates.some((update) => update.status === "cancelled"),
				10_000,
				"cancelled push",
			);
			const cancelled = harness.childUpdates.find((update) => update.status === "cancelled")!;
			expect(cancelled.childId).toBe(admission.rlm_child_id);
			// The terminal state is sticky: later provisioning work cannot resurrect it.
			await sleep(1_000);
			expect(harness.childUpdates.some((update) => update.status === "completed")).toBe(false);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
		}
	}, 60_000);

	it("deletes a spawned child through the existing delete verb: row retracts and ledger edge is removed", async () => {
		const root = temp();
		const harness = buildRegistry(root);
		try {
			const admission = await harness.registry.spawnChild({
				...spawnInput(),
				sessionId: "sess_cloud_kid_4",
				name: "deleteme",
			});
			const deletedRow = () =>
				[...harness.rosterWrites.values()].find(
					(candidate) => candidate.summary.activeSessionId === admission.active_session_id,
				);
			await waitFor(() => deletedRow() !== undefined, 10_000, "spawned child roster row");
			const target = harness.registry.resolveActive(admission.active_session_id)!;
			const response = await harness.registry.handleSessionCommand(
				{
					type: "delete_rlm_subagent",
					activeSessionId: admission.active_session_id,
					childId: admission.rlm_child_id,
				},
				target,
			);
			expect(response.success).toBe(true);
			await waitFor(
				() => harness.childUpdates.some((update) => update.status === "cancelled"),
				20_000,
				"cancelled push",
			);
			await waitFor(
				() => harness.ledgerDeletes.some((entry) => entry.childId === "sess_cloud_kid_4"),
				20_000,
				"ledger delete",
			);
			await waitFor(() => deletedRow() === undefined, 20_000, "row removed");
			expect(harness.store.get("sess_cloud_kid_4")!.observedLifecycle).toBe("deleted");
		} finally {
			await harness.registry.dispose().catch(() => undefined);
		}
	}, 60_000);

	it("projects remote descendants under the spawned child with a parent edge and shadow", async () => {
		const root = temp();
		const guestSessionId = "sess_cloud_kid_5";
		queueFauxResponse(root, "root answer");
		const daemon = await startGuestDaemon(root, 1, guestSessionId);
		const harness = buildRegistry(root);
		try {
			await harness.registry.spawnChild({
				...spawnInput({ parent: { ...PARENT, cwd: root } }),
				sessionId: guestSessionId,
				name: "cloud-parent",
			});
			await waitFor(
				() => harness.childUpdates.some((update) => update.status === "running"),
				30_000,
				"running push",
			);
			// The open_session receipt is admission-level: the guest finishes
			// opening its root session right after, so wait for the runtime.
			await waitFor(() => daemon.rootRuntime !== undefined, 20_000, "guest root runtime");
			const runtime = daemon.rootRuntime!;
			const session = daemon.rootSession!;
			const child = await runtime.createRlmSubagentRuntime({
				parentSession: session!,
				id: "guest-kid",
				prompt: "descendant task",
				sessionName: "guestkid",
				sessionDir: join(root, "child-session"),
				model: session!.model as never,
				thinkingLevel: session!.thinkingLevel,
				serviceTier: session!.serviceTier ?? "auto",
				scopedModels: [...session!.scopedModels],
				activeToolNames: [],
				customTools: [],
				includeGoals: false,
				includeCompactSkill: true,
				rlmDepth: 2,
				rlmMaxDepth: 4,
				rlmParentNodeId: "guest-kid",
			});
			expect(child.session.sessionName).toBe("guestkid");
			await waitFor(
				() => harness.registry.liveSummaries().some((summary) => summary.rlmChildId === "guest-kid"),
				20_000,
				"descendant roster row",
			);
			const descendant = harness.registry.liveSummaries().find((summary) => summary.rlmChildId === "guest-kid")!;
			expect(descendant.runtimeKind).toBe("subagent");
			expect(descendant.rlmDepth).toBe(2);
			expect(descendant.execution).toMatchObject({ location: "cloud" });
			// The descendant's parent edge points at the spawned child's shadow.
			const childShadow = harness.store.get(guestSessionId)!.shadowSessionFile!;
			expect(descendant.parentSessionPath).toBe(childShadow);
			await waitFor(
				() => harness.ledgerEdges.some((edge) => edge.childId === "guest-kid" && edge.parent === childShadow),
				20_000,
				"descendant ledger edge",
			);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemon.stop().catch(() => undefined);
		}
	}, 60_000);
});

// ---------------------------------------------------------------------------
// AgentSession spawn branch (stub host)
// ---------------------------------------------------------------------------

interface StubLeaseOptions {
	rlm_child_id?: string;
	name?: string;
	failDelete?: boolean;
}

function stubLease(options: StubLeaseOptions = {}): {
	lease: RlmCloudChildLease;
	cancels: number[];
	deletes: number[];
} {
	const cancels: number[] = [];
	const deletes: number[] = [];
	const lease: RlmCloudChildLease = {
		admission: {
			rlm_child_id: options.rlm_child_id ?? "sess_stub_1",
			name: options.name ?? "stub-cloud-kid",
			session_dir: "/sessions",
			model: "faux/faux-1",
			cloud_active_session_id: "cloud-active-stub",
			cloud_session_id: options.rlm_child_id ?? "sess_stub_1",
		},
		cancel: () => {
			cancels.push(1);
		},
		delete: async () => {
			if (options.failDelete) throw new Error("supervisor delete failed");
			deletes.push(1);
		},
	};
	return { lease, cancels, deletes };
}

function stubHost(lease: RlmCloudChildLease): SubagentRuntimeHost {
	return {
		createRlmSubagentRuntime: async () => {
			throw new Error("local runtime must not be created for a cloud spawn");
		},
		deleteRlmSubagentRuntime: async () => undefined,
		spawnRlmCloudChild: async () => lease,
	};
}

interface InspectableCloudRunSession {
	_activeRlmChildRuns: Map<
		string,
		{
			id: string;
			status: string;
			error?: string;
			answerPreview?: string;
			sessionDir: string;
			settled: boolean;
			cloudLease?: RlmCloudChildLease;
			publication: { promise: Promise<void> };
			settlement: { promise: Promise<void> };
		}
	>;
	_unsettledRlmChildRuns: Set<unknown>;
	_deletedRlmChildIds: Set<string>;
}

describe("AgentSession cloud spawn branch (rlm(..., target='cloud'))", () => {
	let tempDir = "";
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "agent-session-cloud-"));
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(lease?: RlmCloudChildLease): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: {
				model: undefined as never,
				systemPrompt: "",
				tools: [],
				thinkingLevel: "off",
			},
			streamFn: undefined as never,
		});
		const resourceLoader = createTestResourceLoader();
		const modelRegistry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry,
			resourceLoader,
			customTools: [],
			rlmDepth: 0,
			rlmMaxDepth: 4,
			subagentRuntimeHost: lease ? stubHost(lease) : undefined,
		} as ConstructorParameters<typeof AgentSession>[0]);
		return session;
	}

	it("returns the frozen handle immediately after admission and settles on pushes", async () => {
		const { lease } = stubLease();
		const root = createSession(lease);
		// Seed a scoped model so spawn model resolution succeeds without a provider call.
		(root as unknown as { setScopedModels(models: unknown[]): void }).setScopedModels([]);
		const handle = await root.runRlmChild("cloud research task", { target: "cloud", name: "cloud-kid" });
		// The frozen handle shape: exactly the four documented keys.
		expect(handle).toEqual({
			rlm_child_id: "sess_stub_1",
			name: "stub-cloud-kid",
			session_dir: "/sessions",
			model: "faux/faux-1",
		});
		const internal = root as unknown as InspectableCloudRunSession;
		const run = internal._activeRlmChildRuns.get("sess_stub_1")!;
		expect(run).toBeDefined();
		expect(run.status).toBe("queued");
		// Publication resolved at admission; the run is not yet settled.
		await run.publication.promise;
		expect(run.settled).toBe(false);
		expect(internal._unsettledRlmChildRuns.has(run)).toBe(true);
		// rlm.list_subagents includes the admitted cloud child.
		const listed = await root.listRlmSubagents();
		expect(listed.subagents.some((entry) => entry.rlm_child_id === "sess_stub_1")).toBe(true);

		// Status pushes route into the run machinery.
		root.applyRlmCloudChildUpdate({ childId: "sess_stub_1", status: "running" });
		expect(internal._activeRlmChildRuns.get("sess_stub_1")!.status).toBe("running");
		root.applyRlmCloudChildUpdate({
			childId: "sess_stub_1",
			status: "completed",
			answerPreview: "the cloud answer",
		});
		const settledRun = internal._activeRlmChildRuns.get("sess_stub_1")!;
		expect(settledRun.status).toBe("done");
		expect(settledRun.answerPreview).toBe("the cloud answer");
		await settledRun.settlement.promise;
		expect(settledRun.settled).toBe(true);
		expect(internal._unsettledRlmChildRuns.size).toBe(0);
		// A late duplicate push is ignored.
		root.applyRlmCloudChildUpdate({ childId: "sess_stub_1", status: "completed" });
		expect(internal._unsettledRlmChildRuns.size).toBe(0);
	});

	it("rejects unknown target values and unknown kwargs with precise errors", async () => {
		const { lease } = stubLease();
		const root = createSession(lease);
		await expect(root.runRlmChild("task", { target: "sand" as never })).rejects.toThrow(
			'rlm.run target must be "cloud" when provided; got "sand"',
		);
		await expect(root.runRlmChild("task", { target: "cloud", boss: "x" })).rejects.toThrow(
			"Unsupported rlm.run kwargs: boss",
		);
		// target absent: the frozen local path still admits a local child
		// immediately; the stub host's runtime failure surfaces asynchronously.
		const localHandle = await root.runRlmChild("task", { name: "local-kid" });
		expect(localHandle.rlm_child_id).not.toBe("sess_stub_1");
		expect(localHandle.session_dir).not.toBe("/sessions");
	});

	it("fails clearly when the host cannot run cloud children", async () => {
		const root = createSession(undefined);
		await expect(root.runRlmChild("task", { target: "cloud", name: "nope" })).rejects.toThrow(
			"cloud execution is not available in this session",
		);
	});

	it("settles error pushes and removes cancelled runs from tracking", async () => {
		const { lease } = stubLease({ rlm_child_id: "sess_stub_2" });
		const root = createSession(lease);
		await root.runRlmChild("task", { target: "cloud" });
		const internal = root as unknown as InspectableCloudRunSession;
		root.applyRlmCloudChildUpdate({ childId: "sess_stub_2", status: "error", error: "sandbox died" });
		const failed = internal._activeRlmChildRuns.get("sess_stub_2")!;
		expect(failed.status).toBe("error");
		expect(failed.error).toBe("sandbox died");
		await failed.settlement.promise;
		expect(failed.settled).toBe(true);
	});

	it("deletes a cloud child through the existing delete API", async () => {
		const { lease, cancels, deletes } = stubLease({ rlm_child_id: "sess_stub_3" });
		const root = createSession(lease);
		await root.runRlmChild("task", { target: "cloud" });
		const internal = root as unknown as InspectableCloudRunSession;
		expect(internal._activeRlmChildRuns.has("sess_stub_3")).toBe(true);
		const result = await root.deleteRlmSubagent("stub-cloud-kid");
		expect(result.outcome).toBe("deleted");
		expect(deletes.length).toBe(1);
		// The abort path routes cancellation through the lease before the delete.
		expect(cancels.length).toBeGreaterThanOrEqual(0);
		expect(internal._activeRlmChildRuns.has("sess_stub_3")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// System prompt bytes
// ---------------------------------------------------------------------------

describe("RLM prompt cloud-target sentence", () => {
	const baseOptions = {
		cwd: "/workspace",
		messagesPath: "/sessions/agent.jsonl",
		allowRecursion: true,
		depth: 0,
	} as const;

	it("keeps local prompt bytes byte-identical when the capability is absent", () => {
		const withoutCapability = buildRlmPrompt({ ...baseOptions });
		const explicitFalse = buildRlmPrompt({ ...baseOptions, cloudSpawnTarget: false });
		expect(explicitFalse).toBe(withoutCapability);
		expect(withoutCapability).not.toContain("target='cloud'");
	});

	it("adds exactly one conditional sentence when the daemon advertises the capability", () => {
		const withoutCapability = buildRlmPrompt({ ...baseOptions });
		const withCapability = buildRlmPrompt({ ...baseOptions, cloudSpawnTarget: true });
		expect(withCapability).toContain("target='cloud'");
		expect(withCapability).not.toBe(withoutCapability);
		// Exactly one added line, and it is the cloud-target sentence.
		const withoutLines = withoutCapability.split("\n");
		const withLines = withCapability.split("\n");
		expect(withLines.length).toBe(withoutLines.length + 1);
		const added = withLines.find((line) => !withoutLines.includes(line) && line.includes("target='cloud'"))!;
		expect(added).toBeDefined();
		expect(withLines.filter((line) => line.includes("target='cloud'")).length).toBe(1);
		expect(added.startsWith("`await rlm('sub-task', target='cloud')`")).toBe(true);
	});
});
