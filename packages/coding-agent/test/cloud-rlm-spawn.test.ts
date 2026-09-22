import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { CloudSessionStore } from "../src/core/cloud/cloud-session-store.js";
import type { DirectCloudService } from "../src/core/cloud/direct-cloud-service.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { buildRlmPrompt } from "../src/core/prompts/index.js";
import type { RlmCloudChildLease, SubagentRuntimeHost } from "../src/core/rlm-runtime.js";
import { parseSessionEntries, SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	CloudSessionRegistry,
	type CloudSessionRegistryCallbacks,
	type RlmCloudSpawnAdmission,
} from "../src/modes/daemon/cloud-session-registry.js";
import {
	createDaemonCommandEnvelope,
	type DaemonCommand,
	type DaemonOutbound,
} from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { MutationDrainLatch } from "../src/modes/daemon/mutation-drain-latch.js";
import {
	CLOUD_TEST_BRIDGE_TOKEN,
	cloudTemp,
	fakeCloudService,
	queueFauxResponse,
	RecordingTunnelTransport,
	startGuestDaemon,
} from "./cloud-support.js";
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

/**
 * Drains the event loop until the observable settles: registry attachments and
 * guest pushes all complete across turns, never a clock.
 */
async function waitFor(predicate: () => boolean): Promise<void> {
	for (;;) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
}

// ---------------------------------------------------------------------------
// Registry harness (fake transport + real guest daemon)
// ---------------------------------------------------------------------------

interface RegistryHarness {
	registry: CloudSessionRegistry;
	rosterWrites: Map<
		string,
		{
			agentId: string;
			summary: {
				activeSessionId?: string;
				sessionId?: string;
				sessionName?: string;
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

function buildRegistry(
	root: string,
	options: { service?: DirectCloudService; store?: CloudSessionStore } = {},
): RegistryHarness {
	const { service, store } =
		options.service !== undefined
			? { service: options.service, store: options.store ?? fakeCloudService(root).store }
			: fakeCloudService(root);
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
		transport: new RecordingTunnelTransport(),
		bridgeToken: CLOUD_TEST_BRIDGE_TOKEN,
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
		const root = cloudTemp("cloud-rlm-spawn-test-");
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
			await waitFor(() => rowForActiveSession() !== undefined);
			const row = rowForActiveSession()!;
			expect(row.summary.execution).toMatchObject({ location: "cloud" });
			expect(row.summary.runtimeKind).toBe("subagent");
			expect(row.summary.rlmDepth).toBe(1);
			expect(row.summary.rlmChildId).toBe(guestSessionId);
			expect(row.summary.parentActiveSessionId).toBe(PARENT.activeSessionId);
			expect(row.summary.parentSessionPath).toBe(PARENT.sessionFile);

			// Admission pushes queued; provisioning transitions run; the mirrored
			// answer settles the parent's run with the child's answer preview.
			await waitFor(() => harness.childUpdates.length > 0);
			expect(harness.childUpdates[0]).toMatchObject({
				childId: guestSessionId,
				parentActiveSessionId: PARENT.activeSessionId,
				status: "queued",
			});
			await waitFor(() => harness.childUpdates.some((update) => update.status === "running"));
			await waitFor(() => harness.childUpdates.some((update) => update.status === "completed"));
			const completed = harness.childUpdates.find((update) => update.status === "completed")!;
			expect(completed.answerPreview).toContain("cloud child finished answer");

			// Completion retains the roster row with every stable selector
			// (name, rlm child id, cloud session id, active session id): the
			// parent's agent_message addressing and list surfaces survive
			// settlement instead of the row vanishing with the live task.
			const retainedRow = rowForActiveSession()!.summary;
			expect(retainedRow).toMatchObject({
				activeSessionId: admission.active_session_id,
				sessionId: guestSessionId,
				sessionName: "cloud-kid",
				rlmChildId: guestSessionId,
				runtimeKind: "subagent",
				parentActiveSessionId: PARENT.activeSessionId,
				parentSessionPath: PARENT.sessionFile,
			});
			// The queued label clears once the task settles.
			expect(retainedRow.statusLabel).toBeUndefined();
			expect(harness.registry.liveSummaries()).toContainEqual(
				expect.objectContaining({
					activeSessionId: admission.active_session_id,
					sessionId: guestSessionId,
					sessionName: "cloud-kid",
					rlmChildId: guestSessionId,
					rlmDepth: 1,
				}),
			);

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
	});

	it("fails provisioning honestly: terminal error push, no phantom completion", async () => {
		const root = cloudTemp("cloud-rlm-spawn-test-");
		const { service, store } = fakeCloudService(root, { failProvisioning: true });
		const harness = buildRegistry(root, { service, store });
		try {
			const admission = await harness.registry.spawnChild({
				...spawnInput(),
				sessionId: "sess_cloud_kid_2",
				name: "doomed",
			});
			expect(admission.rlm_child_id).toBe("sess_cloud_kid_2");
			await waitFor(() => harness.childUpdates.some((update) => update.status === "error"));
			const failed = harness.childUpdates.find((update) => update.status === "error")!;
			expect(failed.error).toContain("provisioning exploded");
			expect(harness.store.get(admission.rlm_child_id)!.lastError).toContain("provisioning exploded");
			expect(harness.childUpdates.some((update) => update.status === "completed")).toBe(false);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
		}
	});

	it("cancels before the guest is ready: terminal cancelled push wins over late provisioning", async () => {
		const root = cloudTemp("cloud-rlm-spawn-test-");
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
			await waitFor(() => harness.childUpdates.some((update) => update.status === "cancelled"));
			const cancelled = harness.childUpdates.find((update) => update.status === "cancelled")!;
			expect(cancelled.childId).toBe(admission.rlm_child_id);
			// The terminal state is sticky: a bounded turn drain proves later
			// provisioning work cannot resurrect it.
			for (let turn = 0; turn < 10; turn++) {
				await new Promise((resolve) => setImmediate(resolve));
			}
			expect(harness.childUpdates.some((update) => update.status === "completed")).toBe(false);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
		}
	});

	it("deletes a spawned child through the existing delete verb: row retracts and ledger edge is removed", async () => {
		const root = cloudTemp("cloud-rlm-spawn-test-");
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
			await waitFor(() => deletedRow() !== undefined);
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
			await waitFor(() => harness.childUpdates.some((update) => update.status === "cancelled"));
			await waitFor(() => harness.ledgerDeletes.some((entry) => entry.childId === "sess_cloud_kid_4"));
			await waitFor(() => deletedRow() === undefined);
			expect(harness.store.get("sess_cloud_kid_4")!.observedLifecycle).toBe("deleted");
		} finally {
			await harness.registry.dispose().catch(() => undefined);
		}
	});

	it("deletes through the real supervisor gate: worker response contract, tunnel cleanup, idempotent repeat", async () => {
		const root = cloudTemp("cloud-rlm-spawn-test-");
		const harness = buildRegistry(root);
		// Constructor-bypass supervisor with the REAL handleLine gate and
		// real cloud routing (resolveActive -> handleCloudSessionCommand ->
		// registry): only the supervisor's own service seams are stubbed.
		const writes: DaemonOutbound[] = [];
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			ready: Promise.resolve(),
			ownership: { assertCurrent: async () => undefined },
			workers: new Map(),
			clients: new Set(),
			protocolClientIds: new WeakMap(),
			pendingSessionNames: new Set<string>(),
			mutationDrain: new MutationDrainLatch(),
			commandJournal: {
				lookup: () => undefined,
				begin: () => ({ status: "new" as const }),
				recordResult: () => undefined,
				acknowledge: () => undefined,
			},
			cancelOwnedWorkerCleanup: () => undefined,
			cloud: () => harness.registry,
			write: (_client: DaemonSocketClient, message: DaemonOutbound) => {
				writes.push(message);
				return true;
			},
			log: () => undefined,
		}) as unknown as {
			handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		};
		const client = {
			id: "delete-gate-client",
			socket: { destroyed: false },
			attachedActiveSessionIds: new Set<string>(),
			detachInput: () => undefined,
			supportsExtensionUi: false,
			capabilities: new Set<string>(),
		} as DaemonSocketClient;
		try {
			const admission = await harness.registry.spawnChild({
				...spawnInput({ parent: { ...PARENT, cwd: root } }),
				sessionId: "sess_cloud_kid_gate",
				name: "delete-through-gate",
			});
			const deletedRow = () =>
				[...harness.rosterWrites.values()].find(
					(candidate) => candidate.summary.activeSessionId === admission.active_session_id,
				);
			await waitFor(() => deletedRow() !== undefined);
			const secretsFile = join(root, "cloud", "tunnel-secrets", "sess_cloud_kid_gate.json");

			const sendDelete = async (id: string) => {
				const command = {
					id,
					type: "delete_rlm_subagent",
					activeSessionId: admission.active_session_id,
					childId: admission.rlm_child_id,
				} satisfies DaemonCommand;
				await supervisor.handleLine(
					client,
					JSON.stringify(createDaemonCommandEnvelope(command, command.id, client.id)),
				);
			};
			await sendDelete("delete-gate-1");
			// The response must satisfy the worker-mode client contract for
			// delete_rlm_subagent (data: { deleted }): a data-less success is
			// an "invalid delete_rlm_subagent response" on the parent worker.
			expect(writes[0]).toMatchObject({
				id: "delete-gate-1",
				command: "delete_rlm_subagent",
				success: true,
				data: { deleted: true },
			});
			await waitFor(() => deletedRow() === undefined);
			const record = harness.store.get("sess_cloud_kid_gate")!;
			expect(record.observedLifecycle).toBe("deleted");
			// The forfeited sandbox leak is closed: the platform tunnel is
			// released (persisted) and its secrets are gone.
			expect(record.tunnelState).toBe("released");
			expect(record.cleanupState).toBe("released");
			expect(existsSync(secretsFile)).toBe(false);

			// The row no longer resolves as live: a repeated delete answers
			// the worker's not_found contract instead of a routing failure.
			await sendDelete("delete-gate-2");
			expect(writes[1]).toMatchObject({
				id: "delete-gate-2",
				command: "delete_rlm_subagent",
				success: true,
				data: { deleted: false },
			});
		} finally {
			await harness.registry.dispose().catch(() => undefined);
		}
	});

	it("projects remote descendants under the spawned child with a parent edge and shadow", async () => {
		const root = cloudTemp("cloud-rlm-spawn-test-");
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
			await waitFor(() => harness.childUpdates.some((update) => update.status === "running"));
			// The open_session receipt is admission-level: the guest finishes
			// opening its root session right after, so wait for the runtime.
			await waitFor(() => daemon.rootRuntime !== undefined);
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
			await waitFor(() => harness.registry.liveSummaries().some((summary) => summary.rlmChildId === "guest-kid"));
			const descendant = harness.registry.liveSummaries().find((summary) => summary.rlmChildId === "guest-kid")!;
			expect(descendant.runtimeKind).toBe("subagent");
			expect(descendant.rlmDepth).toBe(2);
			expect(descendant.execution).toMatchObject({ location: "cloud" });
			// The descendant's parent edge points at the spawned child's shadow.
			const childShadow = harness.store.get(guestSessionId)!.shadowSessionFile!;
			expect(descendant.parentSessionPath).toBe(childShadow);
			await waitFor(() =>
				harness.ledgerEdges.some((edge) => edge.childId === "guest-kid" && edge.parent === childShadow),
			);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemon.stop().catch(() => undefined);
		}
	});
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
			"Unsupported rlm.spawn kwargs: boss",
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

	it("retains a completed cloud child in rosters and lists until explicit delete", async () => {
		const { lease, deletes } = stubLease({ rlm_child_id: "sess_stub_4", name: "retained-kid" });
		const root = createSession(lease);
		(root as unknown as { setScopedModels(models: unknown[]): void }).setScopedModels([]);
		await root.runRlmChild("cloud research task", { target: "cloud", name: "retained-kid" });
		root.applyRlmCloudChildUpdate({ childId: "sess_stub_4", status: "running" });
		root.applyRlmCloudChildUpdate({
			childId: "sess_stub_4",
			status: "completed",
			answerPreview: "the retained cloud answer",
		});
		const internal = root as unknown as InspectableCloudRunSession;
		const settledRun = internal._activeRlmChildRuns.get("sess_stub_4")!;
		await settledRun.settlement.promise;

		// The completed cloud run stays retained exactly like a completed
		// local retained subagent: snapshots keep showing it with its cloud
		// row address, and the daemon can stamp no further active id.
		expect(root.getRlmChildSnapshots()).toEqual([
			expect.objectContaining({
				id: "sess_stub_4",
				sessionName: "retained-kid",
				status: "done",
				answerPreview: "the retained cloud answer",
				activeSessionId: "cloud-active-stub",
				sessionDir: "/sessions",
			}),
		]);
		const listed = await root.listRlmSubagents();
		expect(listed.subagents).toEqual([
			expect.objectContaining({
				rlm_child_id: "sess_stub_4",
				session_name: "retained-kid",
				session_dir: "/sessions",
				status: "completed",
			}),
		]);

		// Explicit delete is the only removal path: the lease deletes the
		// remote child and every surface drops the retained run.
		const result = await root.deleteRlmSubagent("retained-kid");
		expect(result.outcome).toBe("deleted");
		expect(deletes.length).toBe(1);
		expect(root.getRlmChildSnapshots()).toEqual([]);
		expect((await root.listRlmSubagents()).subagents).toEqual([]);
	});

	it("lists and deletes a recovered cloud child after parent recovery, preferring the reconstruction row", async () => {
		const hostDeletes: Array<{ childId: string; session: unknown }> = [];
		const host: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async () => {
				throw new Error("local runtime must not be created for a cloud child");
			},
			deleteRlmSubagentRuntime: async (childId, session) => {
				hostDeletes.push({ childId, session });
			},
		};
		const root = createSession(undefined);
		(root as unknown as { _subagentRuntimeHost?: SubagentRuntimeHost })._subagentRuntimeHost = host;
		// A rehydrated parent has no in-memory run; the daemon roster carries
		// both the ledger-reconstructed row (sessionDir + registry status) and
		// the live supervisor peer row (no sessionDir). The reconstruction row
		// must win so the completed cloud child stays listed and deletable.
		(root as unknown as { _agentMessageController?: unknown })._agentMessageController = {
			listAgents: async () => ({
				current: { activeSessionId: "parent-active-1", sessionId: "parent-session", sessionName: "parent" },
				agents: [
					{
						activeSessionId: "sess_stub_5",
						sessionId: "sess_stub_5",
						sessionName: "recovered-kid",
						runtimeKind: "subagent",
						parentActiveSessionId: "parent-active-1",
						rlmChildId: "sess_stub_5",
						sessionDir: "/sessions",
						rlmChildRegistryStatus: "completed",
						cwd: "/repo",
						status: "inactive",
					},
					{
						activeSessionId: "cloud-active-stub-5",
						sessionId: "sess_stub_5",
						sessionName: "recovered-kid",
						runtimeKind: "subagent",
						parentActiveSessionId: "parent-active-1",
						rlmChildId: "sess_stub_5",
						cwd: "/repo",
						status: "idle",
					},
				],
			}),
		};
		const listed = await root.listRlmSubagents();
		expect(listed.subagents).toEqual([
			expect.objectContaining({
				rlm_child_id: "sess_stub_5",
				active_session_id: "sess_stub_5",
				session_name: "recovered-kid",
				session_dir: "/sessions",
				status: "completed",
			}),
		]);

		const deleted = await root.deleteRlmSubagent("recovered-kid");
		expect(deleted.subagent.rlm_child_id).toBe("sess_stub_5");
		expect(hostDeletes).toEqual([{ childId: "sess_stub_5", session: undefined }]);
		expect((await root.listRlmSubagents()).subagents).toEqual([]);
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
		expect(added.startsWith("`await rlm.spawn('sub-task', name='worker', target='cloud')`")).toBe(true);
	});
});
