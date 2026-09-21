import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type AgentFamilyCatalogEntry,
	type AgentSessionMessageReceipt,
	assertAgentFamilyReach,
} from "../src/core/agent-messages.js";
import type { CloudSessionStore } from "../src/core/cloud/cloud-session-store.js";
import type { CloudFamilyRow } from "../src/core/cloud/protocol.js";
import { parseSessionEntries } from "../src/core/session-manager.js";
import { AgentRoster } from "../src/modes/daemon/agent-roster.js";
import {
	CloudSessionRegistry,
	type CloudSessionRegistryCallbacks,
	type CloudSessionTarget,
	type RlmCloudSpawnAdmission,
} from "../src/modes/daemon/cloud-session-registry.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import {
	CLOUD_TEST_BRIDGE_TOKEN,
	cloudTemp,
	fakeCloudService,
	queueFauxResponse,
	RecordingTunnelTransport,
	startGuestDaemon,
} from "./cloud-support.js";

/**
 * Fake-transport e2e for the final first-class cloud session parity slice:
 *
 * - agent_message both directions across the boundary: local -> cloud with
 *   admission-gated receipts, and cloud -> local / cloud -> cloud through the
 *   durable family_roster_request / agent_message_request events answered by
 *   journaled result commands.
 * - remote descendants are addressable: prompt, attach, and message route
 *   into the descendant's remote session.
 * - a supervisor restart reconstructs spawn trackers and replays the current
 *   child status (or terminal result) into the surviving local parent run
 *   without re-admitting the task prompt.
 * - extension-UI requests relay from cloud rows (the session_event wire) and
 *   responses route back to the owning remote session.
 */

/**
 * Drains the event loop until the observable settles: guest mirrors, registry
 * replays, and socket frames all complete across turns, never a clock.
 */
async function waitFor(predicate: () => boolean): Promise<void> {
	for (;;) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
}

// ---------------------------------------------------------------------------
// Registry harness: real in-process guest daemons behind socket transports.
// ---------------------------------------------------------------------------

const LOCAL_PARENT = {
	sessionId: "parent-session-id",
	sessionFile: "/sessions/parent.jsonl",
	activeSessionId: "parent-active-1",
	sessionName: "local-parent",
	depth: 0,
};

interface LocalDeliveryRecord {
	source: CloudSessionTarget;
	targetSelector: string;
	message: string;
}

interface FamilyHarness {
	registry: CloudSessionRegistry;
	store: CloudSessionStore;
	childUpdates: Array<{
		childId: string;
		parentActiveSessionId: string;
		status: string;
		error?: string;
		answerPreview?: string;
	}>;
	sessionEvents: Array<{ activeSessionId: string; type: string; event?: unknown }>;
	localDeliveries: LocalDeliveryRecord[];
	familyRows: Array<{ targetId: string; rows: CloudFamilyRow[] }>;
	/** The supervisor-equivalent delivery routing used by the harness. */
	deliver: (input: {
		source: CloudSessionTarget;
		targetSelector: string;
		message: string;
	}) => Promise<AgentSessionMessageReceipt>;
}

function familyEntryFor(summary: {
	sessionId: string;
	sessionName?: string;
	rlmDepth?: number;
	parentSessionId?: string;
	parentSessionPath?: string;
	sessionFile?: string;
}): AgentFamilyCatalogEntry {
	const depth = summary.rlmDepth ?? 0;
	return {
		id: summary.sessionId,
		...(summary.sessionName ? { name: summary.sessionName } : {}),
		depth,
		status: "running",
		...(depth > 0 && summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
		...(depth > 0 && summary.parentSessionPath ? { parentSessionPath: summary.parentSessionPath } : {}),
		...(summary.sessionFile ? { sessionPath: summary.sessionFile } : {}),
	};
}

function buildFamilyRegistry(
	root: string,
	guestSockets: Map<string, string>,
	options: { store?: CloudSessionStore } = {},
): FamilyHarness {
	const { service, store } = fakeCloudService(root, {
		sandboxId: "sandbox-family-1",
		store: options.store,
		guestSocketUrl: (sessionId) => guestSockets.get(sessionId) ?? join(root, "guest.sock"),
	});
	const childUpdates: FamilyHarness["childUpdates"] = [];
	const sessionEvents: FamilyHarness["sessionEvents"] = [];
	const localDeliveries: LocalDeliveryRecord[] = [];
	const familyRows: FamilyHarness["familyRows"] = [];
	const registryRef: { current?: CloudSessionRegistry } = {};

	/** The supervisor-equivalent family rows: self, local parent, siblings. */
	const cloudFamilyRows = (target: CloudSessionTarget): CloudFamilyRow[] => {
		const self = target.summary;
		const selfDepth = self.rlmDepth ?? 0;
		const rows: CloudFamilyRow[] = [
			{
				id: self.sessionId,
				...(self.sessionName ? { name: self.sessionName } : {}),
				depth: selfDepth,
				status: "running",
				...(self.parentSessionId ? { parentSessionId: self.parentSessionId } : {}),
				...(self.parentSessionPath ? { parentSessionPath: self.parentSessionPath } : {}),
				...(self.sessionFile ? { sessionPath: self.sessionFile } : {}),
			},
		];
		if (selfDepth > 0) {
			rows.push({
				id: LOCAL_PARENT.sessionId,
				name: LOCAL_PARENT.sessionName,
				depth: selfDepth - 1,
				status: "running",
				sessionPath: LOCAL_PARENT.sessionFile,
			});
			for (const other of registryRef.current?.liveSummaries() ?? []) {
				if (other.sessionId === self.sessionId) continue;
				if ((other.rlmDepth ?? 0) !== selfDepth) continue;
				rows.push({
					id: other.sessionId,
					...(other.sessionName ? { name: other.sessionName } : {}),
					depth: selfDepth,
					status: "running",
					parentSessionId: LOCAL_PARENT.sessionId,
					parentSessionPath: LOCAL_PARENT.sessionFile,
					...(other.sessionFile ? { sessionPath: other.sessionFile } : {}),
				});
			}
		}
		familyRows.push({ targetId: self.sessionId, rows });
		return rows;
	};

	/** The supervisor-equivalent delivery: cloud peers first, then local. */
	const deliver = async (input: {
		source: CloudSessionTarget;
		targetSelector: string;
		message: string;
	}): Promise<AgentSessionMessageReceipt> => {
		const registry = registryRef.current!;
		const cloudTarget = registry.resolveActive(input.targetSelector);
		if (cloudTarget !== undefined) {
			assertAgentFamilyReach(familyEntryFor(input.source.summary), familyEntryFor(cloudTarget.summary));
			const response = await registry.handleSessionCommand(
				{
					type: "send_message",
					targetActiveSessionId: input.targetSelector,
					message: input.message,
					fromActiveSessionId: input.source.summary.activeSessionId ?? input.source.summary.id,
					agentOrigin: true,
				},
				cloudTarget,
				undefined,
				input.source.summary,
			);
			if (!response.success) throw new Error(response.error ?? "cloud send failed");
			return (response.data ?? {}) as AgentSessionMessageReceipt;
		}
		localDeliveries.push(input);
		return {
			id: `agentmsg_local_${localDeliveries.length}`,
			source: "agent_message",
			target: { activeSessionId: LOCAL_PARENT.activeSessionId, sessionId: LOCAL_PARENT.sessionId },
			message: input.message,
			deliveryStatus: "delivered",
			deliveredAt: new Date().toISOString(),
			deliveryMode: "steer",
		};
	};

	const callbacks: CloudSessionRegistryCallbacks = {
		log: () => undefined,
		writeRosterEntry: () => undefined,
		deleteRosterEntry: () => undefined,
		appendLedgerEdge: async () => undefined,
		deleteLedgerChild: async () => undefined,
		writeSessionEvent: (activeSessionId, event) => {
			sessionEvents.push({ activeSessionId, type: (event as { type: string }).type, event });
			return true;
		},
		writeSessionStatus: () => undefined,
		broadcastCloudSessionUpdate: () => undefined,
		pushChildUpdate: (update) => {
			childUpdates.push(update);
		},
		cloudFamilyRows,
		deliverCloudAgentMessage: deliver,
		attachedClientCount: () => 0,
	};
	const registry = new CloudSessionRegistry({
		stateDirectory: join(root, "cloud"),
		sessionDir: join(root, "sessions"),
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
	registryRef.current = registry;
	return { registry, store, childUpdates, sessionEvents, localDeliveries, familyRows, deliver };
}

function parentSummaryInput() {
	return {
		sessionId: LOCAL_PARENT.sessionId,
		sessionName: LOCAL_PARENT.sessionName,
		rlmDepth: 0,
		sessionFile: LOCAL_PARENT.sessionFile,
		activeSessionId: LOCAL_PARENT.activeSessionId,
		runtimeKind: "top-level" as const,
	};
}

async function spawnKid(
	harness: FamilyHarness,
	root: string,
	sessionId: string,
	name: string,
	options: { prompt?: string } = {},
): Promise<RlmCloudSpawnAdmission> {
	const admission = await harness.registry.spawnChild({
		parent: {
			sessionId: LOCAL_PARENT.sessionId,
			sessionFile: LOCAL_PARENT.sessionFile,
			activeSessionId: LOCAL_PARENT.activeSessionId,
			depth: 0,
			cwd: root,
		},
		prompt: options.prompt ?? "do the family parity task",
		name,
		sessionId,
	});
	await waitFor(() =>
		harness.childUpdates.some((update) => update.childId === sessionId && update.status === "running"),
	);
	return admission;
}

// ---------------------------------------------------------------------------
// Registry e2e
// ---------------------------------------------------------------------------

describe("cloud family parity (fake transport, real guest daemons)", () => {
	it("delivers local->cloud agent messages with admission-gated receipts and payload parity", async () => {
		const root = cloudTemp("cloud-family-parity-");
		const kidId = "sess_family_kid_a";
		queueFauxResponse(root, "kid a finished");
		// The admitted agent message also wakes the idle guest for a turn.
		queueFauxResponse(root, "kid a message turn answer");
		const daemon = await startGuestDaemon(root, 1, kidId, undefined, join(root, "kid-a.sock"));
		const guestSockets = new Map([[kidId, join(root, "kid-a.sock")]]);
		const harness = buildFamilyRegistry(root, guestSockets);
		try {
			const admission = await spawnKid(harness, root, kidId, "kid-a");
			const target = harness.registry.resolveActive(admission.active_session_id)!;
			const response = await harness.registry.handleSessionCommand(
				{
					type: "send_message",
					targetActiveSessionId: admission.active_session_id,
					message: "ping from the local parent",
					fromActiveSessionId: LOCAL_PARENT.activeSessionId,
					agentOrigin: true,
				},
				target,
				undefined,
				parentSummaryInput() as never,
			);
			expect(response.success).toBe(true);
			const receipt = ((response as { data?: unknown }).data ?? {}) as AgentSessionMessageReceipt;
			expect(receipt.deliveryStatus).toBe("delivered");
			expect(receipt.message).toBe("ping from the local parent");
			expect(receipt.from).toMatchObject({ sessionId: LOCAL_PARENT.sessionId });
			expect(receipt.target).toMatchObject({ sessionId: kidId });
			expect(receipt.deliveredAt).toBeDefined();
			// The receipt landed only after the guest admitted the message:
			// the guest session already holds the structured custom entry with
			// the same message id and the parent-relationship framing.
			const messages = daemon.rootSession!.messages;
			const delivered = messages.find(
				(message) =>
					message.role === "custom" &&
					(message as { customType?: string }).customType === "agent_message" &&
					JSON.stringify((message as { details?: unknown }).details).includes("ping from the local parent"),
			);
			expect(delivered).toBeDefined();
			const details = (
				delivered as {
					details?: { id?: string; fromRelationship?: string; from?: { sessionId?: string } };
				}
			).details;
			expect(details?.id).toBe(receipt.id);
			expect(details?.from?.sessionId).toBe(LOCAL_PARENT.sessionId);
			expect(details?.fromRelationship).toBe("parent");
			// The shadow mirrors the same structured entry.
			await waitFor(() =>
				parseSessionEntries(readFileSync(harness.store.get(kidId)!.shadowSessionFile!, "utf8")).some((entry) =>
					JSON.stringify(entry).includes("ping from the local parent"),
				),
			);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemon.stop().catch(() => undefined);
		}
	});

	it("routes descendant prompt, attach, and messages into the remote descendant session", async () => {
		const root = cloudTemp("cloud-family-parity-");
		const kidId = "sess_family_kid_b";
		queueFauxResponse(root, "kid b finished");
		const daemon = await startGuestDaemon(root, 1, kidId, undefined, join(root, "kid-b.sock"));
		const guestSockets = new Map([[kidId, join(root, "kid-b.sock")]]);
		const harness = buildFamilyRegistry(root, guestSockets);
		try {
			const admission = await spawnKid(harness, root, kidId, "kid-b");
			await waitFor(() => daemon.rootRuntime !== undefined);
			const runtime = daemon.rootRuntime!;
			const session = daemon.rootSession!;
			const child = await runtime.createRlmSubagentRuntime({
				parentSession: session!,
				id: "guest-kid-b1",
				prompt: "descendant task",
				sessionName: "guestkidb",
				sessionDir: join(root, "descendant-session"),
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
				rlmParentNodeId: "guest-kid-b1",
			});
			expect(child.session.sessionName).toBe("guestkidb");
			await waitFor(() => harness.registry.liveSummaries().some((summary) => summary.rlmChildId === "guest-kid-b1"));
			const descendantSummary = harness.registry
				.liveSummaries()
				.find((summary) => summary.rlmChildId === "guest-kid-b1")!;
			expect(descendantSummary.execution).toMatchObject({ location: "cloud" });
			await waitFor(() => existsSync(descendantSummary.sessionFile!));

			// The descendant is addressable by active id AND remote session id.
			const byActive = harness.registry.resolveActive(descendantSummary.activeSessionId!)!;
			const bySessionId = harness.registry.resolveActive(descendantSummary.sessionId)!;
			expect(byActive.descendant).toBe(true);
			expect(bySessionId.remoteSessionId).toBe(byActive.remoteSessionId);
			expect(byActive.summary.rlmDepth).toBe(2);

			// Attach serves the descendant snapshot from its shadow.
			const attach = harness.registry.attachSnapshot(byActive);
			expect(attach.summary.activeSessionId).toBe(descendantSummary.activeSessionId);
			expect(attach.state).toMatchObject({ activeSessionId: descendantSummary.activeSessionId });

			// A prompt addressed at the descendant row routes into that session.
			queueFauxResponse(root, "descendant prompt answer");
			const prompted = await harness.registry.handleSessionCommand(
				{
					type: "prompt",
					activeSessionId: descendantSummary.activeSessionId!,
					message: "work inside the descendant",
				},
				byActive,
			);
			expect(prompted.success).toBe(true);
			await waitFor(() =>
				parseSessionEntries(readFileSync(descendantSummary.sessionFile!, "utf8")).some((entry) =>
					JSON.stringify(entry).includes("work inside the descendant"),
				),
			);
			await waitFor(() =>
				parseSessionEntries(readFileSync(descendantSummary.sessionFile!, "utf8")).some((entry) =>
					JSON.stringify(entry).includes("descendant prompt answer"),
				),
			);
			// The attach snapshot now serves the descendant's transcript.
			const attachAfter = harness.registry.attachSnapshot(byActive);
			expect(attachAfter.messages.length).toBeGreaterThan(0);
			// The root session never saw the descendant's prompt.
			const rootShadow = parseSessionEntries(readFileSync(harness.store.get(kidId)!.shadowSessionFile!, "utf8"));
			expect(rootShadow.some((entry) => JSON.stringify(entry).includes("work inside the descendant"))).toBe(false);

			// Messages addressed at the descendant deliver into that session.
			// The sender is the spawned child (the descendant's actual parent),
			// matching the nuclear-family reach the supervisor enforces.
			const kidTarget = harness.registry.resolveActive(admission.active_session_id)!;
			queueFauxResponse(root, "descendant message answer");
			const sent = await harness.registry.handleSessionCommand(
				{
					type: "send_message",
					targetActiveSessionId: descendantSummary.activeSessionId!,
					message: "note for the descendant",
					fromActiveSessionId: kidTarget.summary.activeSessionId,
					agentOrigin: true,
				},
				byActive,
				undefined,
				kidTarget.summary,
			);
			expect(sent.success).toBe(true);
			const descendantReceipt = ((sent as { data?: unknown }).data ?? {}) as AgentSessionMessageReceipt;
			expect(descendantReceipt.deliveryStatus).toBe("delivered");
			expect(descendantReceipt.target).toMatchObject({ sessionId: byActive.remoteSessionId });
			const descendantState = daemon.stateForRemoteSessionId(byActive.remoteSessionId);
			expect(descendantState).toBeDefined();
			await waitFor(() =>
				descendantState!.runtime.session.messages.some(
					(message) =>
						message.role === "custom" &&
						JSON.stringify((message as { details?: unknown }).details).includes("note for the descendant"),
				),
			);
			const deliveredNote = descendantState!.runtime.session.messages.find(
				(message) =>
					message.role === "custom" &&
					JSON.stringify((message as { details?: unknown }).details).includes("note for the descendant"),
			) as { details?: { fromRelationship?: string; from?: { sessionId?: string } } };
			expect(deliveredNote.details?.fromRelationship).toBe("parent");
			expect(deliveredNote.details?.from?.sessionId).toBe(kidId);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemon.stop().catch(() => undefined);
		}
	});

	it("serves the guest family roster and relays cloud->local and cloud->cloud sends over the durable path", async () => {
		const root = cloudTemp("cloud-family-parity-");
		const kidA = "sess_family_kid_c1";
		const kidB = "sess_family_kid_c2";
		queueFauxResponse(root, "kid a initial answer");
		queueFauxResponse(root, "kid b initial answer");
		// The sibling message wakes kid B for one more turn.
		queueFauxResponse(root, "kid b sibling turn answer");
		const daemonA = await startGuestDaemon(root, 1, kidA, undefined, join(root, "kid-c1.sock"));
		const daemonB = await startGuestDaemon(root, 1, kidB, undefined, join(root, "kid-c2.sock"));
		const guestSockets = new Map([
			[kidA, join(root, "kid-c1.sock")],
			[kidB, join(root, "kid-c2.sock")],
		]);
		const harness = buildFamilyRegistry(root, guestSockets);
		try {
			const admissionA = await spawnKid(harness, root, kidA, "kid-c1");
			const admissionB = await spawnKid(harness, root, kidB, "kid-c2");
			expect(admissionA.rlm_child_id).toBe(kidA);
			expect(admissionB.rlm_child_id).toBe(kidB);

			// The guest kernel asks its family roster through the observe plane:
			// parent + cloud sibling with live facts for resident rows.
			const roster = (await daemonA.rootSession!.handleAgentObserveHostRequest("agent_observe.list")) as {
				current: { sessionId: string };
				agents: Array<{
					relationship?: string;
					sessionId: string;
					sessionName?: string;
					rlmDepth?: number;
				}>;
			};
			expect(roster.current).toMatchObject({ sessionId: kidA });
			const parentEntry = roster.agents.find((entry) => entry.relationship === "parent");
			expect(parentEntry).toMatchObject({
				sessionId: LOCAL_PARENT.sessionId,
				sessionName: LOCAL_PARENT.sessionName,
			});
			const siblingEntry = roster.agents.find((entry) => entry.sessionId === kidB);
			expect(siblingEntry).toMatchObject({ relationship: "sibling", sessionName: "kid-c2" });

			// cloud -> local: the guest kernel send rides the durable path and
			// resolves with the receipt the supervisor-side delivery produced.
			const localSend = (await daemonA.rootSession!.handleAgentMessageHostRequest("agent_message.send", {
				target: LOCAL_PARENT.sessionId,
				message: "kid c1 reporting to the local parent",
			})) as AgentSessionMessageReceipt;
			expect(localSend.deliveryStatus).toBe("delivered");
			expect(localSend.message).toBe("kid c1 reporting to the local parent");
			expect(harness.localDeliveries).toHaveLength(1);
			expect(harness.localDeliveries[0]).toMatchObject({
				targetSelector: LOCAL_PARENT.sessionId,
				message: "kid c1 reporting to the local parent",
			});
			expect(harness.localDeliveries[0].source.summary.sessionId).toBe(kidA);

			// cloud -> cloud: the sibling send delivers into kid B's guest.
			const cloudSend = (await daemonA.rootSession!.handleAgentMessageHostRequest("agent_message.send", {
				target: kidB,
				message: "hey sibling, share your notes",
			})) as AgentSessionMessageReceipt;
			expect(cloudSend.deliveryStatus).toBe("delivered");
			expect(cloudSend.target).toMatchObject({ sessionId: kidB });
			await waitFor(() =>
				daemonB.rootSession!.messages.some(
					(message) =>
						message.role === "custom" &&
						JSON.stringify((message as { details?: unknown }).details).includes("hey sibling, share your notes"),
				),
			);
			const deliveredToB = daemonB.rootSession!.messages.find(
				(message) =>
					message.role === "custom" &&
					JSON.stringify((message as { details?: unknown }).details).includes("hey sibling, share your notes"),
			) as { details?: { fromRelationship?: string; from?: { sessionId?: string } } };
			expect(deliveredToB.details?.fromRelationship).toBe("sibling");
			expect(deliveredToB.details?.from?.sessionId).toBe(kidA);

			// Guest-local rows merge with the remote rows: a guest child shows
			// up in the guest's own roster at the shifted depth.
			const runtime = daemonA.rootRuntime!;
			const session = daemonA.rootSession!;
			await runtime.createRlmSubagentRuntime({
				parentSession: session!,
				id: "guest-kid-c1-child",
				prompt: "inner task",
				sessionName: "innerkid",
				sessionDir: join(root, "inner-session"),
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
				rlmParentNodeId: "guest-kid-c1-child",
			});
			const rosterWithChild = (await daemonA.rootSession!.handleAgentObserveHostRequest("agent_observe.list")) as {
				agents: Array<{ relationship?: string; sessionId: string; parentActiveSessionId?: string }>;
			};
			const childEntry = rosterWithChild.agents.find((entry) => entry.relationship === "child");
			expect(childEntry).toBeDefined();
			expect(childEntry!.parentActiveSessionId).toBe(daemonA.rootStateRef!.activeSessionId);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemonA.stop().catch(() => undefined);
			await daemonB.stop().catch(() => undefined);
		}
	});

	it("replays current child status and terminal results into the surviving parent run after a supervisor restart", async () => {
		const root = cloudTemp("cloud-family-parity-");
		const kidId = "sess_family_kid_d";
		queueFauxResponse(root, "kid d terminal answer");
		const daemon = await startGuestDaemon(root, 1, kidId, undefined, join(root, "kid-d.sock"));
		const guestSockets = new Map([[kidId, join(root, "kid-d.sock")]]);
		const harness = buildFamilyRegistry(root, guestSockets);
		try {
			await spawnKid(harness, root, kidId, "kid-d");
			await waitFor(() => harness.childUpdates.some((update) => update.status === "completed"));
			const shadowFile = harness.store.get(kidId)!.shadowSessionFile!;
			const taskPrompts = () =>
				parseSessionEntries(readFileSync(shadowFile, "utf8")).filter((entry) =>
					JSON.stringify(entry).includes("[task from parent]"),
				);
			expect(taskPrompts()).toHaveLength(1);

			// Supervisor restart: a fresh registry over the same durable state.
			await harness.registry.dispose();
			const guestSockets2 = new Map([[kidId, join(root, "kid-d.sock")]]);
			const second = buildFamilyRegistry(root, guestSockets2, { store: harness.store });
			try {
				await second.registry.recover();
				await waitFor(() =>
					second.childUpdates.some((update) => update.childId === kidId && update.status === "completed"),
				);
				const replay = second.childUpdates.find(
					(update) => update.childId === kidId && update.status === "completed",
				)!;
				expect(replay.answerPreview).toContain("kid d terminal answer");
				expect(replay.parentActiveSessionId).toBe(LOCAL_PARENT.activeSessionId);
				// The terminal replay is sticky: a bounded turn drain proves no
				// phantom running pushes arrive after the replay settles.
				for (let turn = 0; turn < 10; turn++) {
					await new Promise((resolve) => setImmediate(resolve));
				}
				expect(second.childUpdates.some((update) => update.childId === kidId && update.status === "running")).toBe(
					false,
				);
				// No re-admission: the task prompt appears exactly once.
				expect(taskPrompts()).toHaveLength(1);
			} finally {
				await second.registry.dispose().catch(() => undefined);
			}
		} finally {
			await daemon.stop().catch(() => undefined);
		}
	});

	it("replays the current (non-terminal) status of an in-flight child after a restart", async () => {
		const root = cloudTemp("cloud-family-parity-");
		const kidId = "sess_family_kid_e";
		// No queued response: the guest's initial turn stays in flight.
		delete process.env.PRIME_AGENT_TEST_FAUX_RESPONSES;
		process.env.PRIME_AGENT_TEST_FAUX_ECHO = "1";
		const daemon = await startGuestDaemon(root, 1, kidId, undefined, join(root, "kid-e.sock"));
		const guestSockets = new Map([[kidId, join(root, "kid-e.sock")]]);
		const harness = buildFamilyRegistry(root, guestSockets);
		try {
			await spawnKid(harness, root, kidId, "kid-e");
			// The admitted task prompt is durable in the shadow before the
			// restart, so the replay reads honest state.
			const shadowFile = harness.store.get(kidId)!.shadowSessionFile!;
			await waitFor(() =>
				parseSessionEntries(readFileSync(shadowFile, "utf8")).some((entry) =>
					JSON.stringify(entry).includes("[task from parent]"),
				),
			);
			await harness.registry.dispose();
			const second = buildFamilyRegistry(root, new Map([[kidId, join(root, "kid-e.sock")]]), {
				store: harness.store,
			});
			try {
				await second.registry.recover();
				await waitFor(() => second.childUpdates.some((update) => update.childId === kidId));
				const replay = second.childUpdates.find((update) => update.childId === kidId)!;
				// The durable shadow holds the admitted task prompt: the
				// honest replay is running (or already terminal), never queued.
				expect(["running", "completed"]).toContain(replay.status);
			} finally {
				await second.registry.dispose().catch(() => undefined);
			}
		} finally {
			await daemon.stop().catch(() => undefined);
		}
	});

	it("relays extension ui requests from cloud rows and routes responses to the owning remote session", async () => {
		const root = cloudTemp("cloud-family-parity-");
		const kidId = "sess_family_kid_f";
		queueFauxResponse(root, "kid f answer");
		const daemon = await startGuestDaemon(root, 1, kidId, undefined, join(root, "kid-f.sock"));
		const guestSockets = new Map([[kidId, join(root, "kid-f.sock")]]);
		const harness = buildFamilyRegistry(root, guestSockets);
		try {
			await spawnKid(harness, root, kidId, "kid-f");
			const runtime = daemon.rootRuntime!;
			const session = daemon.rootSession!;
			const child = await runtime.createRlmSubagentRuntime({
				parentSession: session!,
				id: "guest-kid-f1",
				prompt: "descendant task",
				sessionName: "guestkidf",
				sessionDir: join(root, "descendant-session"),
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
				rlmParentNodeId: "guest-kid-f1",
			});
			void child;
			await waitFor(() => harness.registry.liveSummaries().some((summary) => summary.rlmChildId === "guest-kid-f1"));
			const descendantSummary = harness.registry
				.liveSummaries()
				.find((summary) => summary.rlmChildId === "guest-kid-f1")!;
			await waitFor(() => existsSync(descendantSummary.sessionFile!));

			// Request direction: the guest's session_event wire carries the
			// request; the registry relays it under the descendant row address.
			const appended = daemon.protocolServer.appendEvent({
				kind: "session_event",
				recordedAt: new Date().toISOString(),
				sessionId: descendantSummary.sessionId,
				event: {
					type: "extension_ui_request",
					request: { requestId: "ui-req-1", kind: "select", title: "Approve?", options: ["yes", "no"] },
				} as never,
			});
			expect(appended).toBeDefined();
			await waitFor(() =>
				harness.sessionEvents.some(
					(recorded) =>
						recorded.activeSessionId === descendantSummary.activeSessionId &&
						recorded.type === "extension_ui_request",
				),
			);

			// Response direction: the command carries the owning remote
			// session; the descendant's pending request resolves.
			const descendantState = daemon.stateForRemoteSessionId(descendantSummary.sessionId)!;
			let resolved: unknown;
			const pending = new Promise<unknown>((resolve) => {
				resolved = resolve;
			});
			descendantState.extensionUiRequests.set("ui-req-1", {
				resolve: (response: unknown) => {
					(resolved as (value: unknown) => void)(response);
				},
			} as never);
			const target = harness.registry.resolveActive(descendantSummary.activeSessionId!)!;
			const answered = await harness.registry.handleSessionCommand(
				{
					type: "extension_ui_response",
					activeSessionId: descendantSummary.activeSessionId!,
					requestId: "ui-req-1",
					response: { value: "yes" },
				},
				target,
			);
			expect(answered.success).toBe(true);
			await expect(pending).resolves.toEqual({ value: "yes" });
			expect(descendantState.extensionUiRequests.has("ui-req-1")).toBe(false);
		} finally {
			await harness.registry.dispose().catch(() => undefined);
			await daemon.stop().catch(() => undefined);
		}
	});
});

// ---------------------------------------------------------------------------
// Stub shapes for the local-side composition tests.
// ---------------------------------------------------------------------------

interface SessionSummaryLike {
	id: string;
	lifecycle: string;
	activity: string;
	isSessionActive: boolean;
	activeSessionId: string;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	isStreaming: boolean;
	isCompacting: boolean;
	attachedClients: number;
	messageCount?: number;
	rlmDepth?: number;
	runtimeKind?: string;
	sessionActions: { queuedCount: number; steering: unknown[]; followUps: unknown[] };
	firstMessage?: string;
	[key: string]: unknown;
}

interface SupervisorStub {
	handleCommand(
		client: unknown,
		command: Record<string, unknown> & { type: string },
	): Promise<{ type: string; command: string; success: boolean; data?: unknown; error?: string } | unknown>;
	deliverCloudAgentMessage(input: {
		source: { summary: SessionSummaryLike; [key: string]: unknown };
		targetSelector: string;
		message: string;
	}): Promise<AgentSessionMessageReceipt>;
}

function makeSupervisorClient(): unknown {
	return {
		id: "client-family-parity",
		socket: { destroyed: false },
		attachedActiveSessionIds: new Set(),
		detachInput: () => undefined,
		supportsExtensionUi: false,
		capabilities: new Set(),
	};
}

interface WorkerInternals {
	sessions: Map<string, ActiveSessionStateLike>;
	listSupervisorAgentPeers: ReturnType<typeof vi.fn>;
	createAgentObserveListResult(current: ActiveSessionStateLike): Promise<{
		current: { activeSessionId: string };
		agents: Array<{
			activeSessionId: string;
			sessionId?: string;
			sessionName?: string;
			runtimeKind?: string;
			status: string;
			isCurrent: boolean;
			isStreaming: boolean;
			messageCount?: number;
			queuedCount?: number;
			attachedClients?: number;
			isSessionActive?: boolean;
			firstMessage?: string;
		}>;
	}>;
}

interface ActiveSessionStateLike {
	activeSessionId: string;
	clients: Set<unknown>;
	pendingAttaches: number;
	lastEventSequence: number;
	eventGeneration: string;
	extensionUiRequests: Map<string, unknown>;
	runtime: Record<string, unknown>;
}

function makeWorkerState(activeSessionId: string): ActiveSessionStateLike {
	return {
		activeSessionId,
		clients: new Set(),
		pendingAttaches: 0,
		lastEventSequence: 0,
		eventGeneration: "gen",
		extensionUiRequests: new Map(),
		runtime: {
			metadata: { kind: "top-level" as const, createdAt: 1 },
			cwd: "/repo",
			diagnostics: [],
			session: {
				sessionId: "parent-session",
				sessionName: "local-parent",
				sessionFile: "/sessions/parent.jsonl",
				cwd: "/repo",
				rlmDepth: 0,
				isStreaming: false,
				isCompacting: false,
				isSessionActive: false,
				messages: [],
				unfinishedActionCount: 0,
				sessionManager: { getCwd: () => "/repo", getHeader: () => undefined },
				hasRunningRlmChildren: () => false,
				getSessionActionSnapshot: () => ({ queuedCount: 0 }),
				state: { pendingToolCalls: new Set() },
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Local-side composition: supervisor peers and the worker-side merges.
// ---------------------------------------------------------------------------

describe("cloud family parity: local-side roster composition", () => {
	function cloudKidSummary(activeSessionId: string, overrides: Record<string, unknown> = {}): SessionSummaryLike {
		const sessionId = activeSessionId.replace("cloud-active-", "sess_");
		return {
			id: activeSessionId,
			lifecycle: "live",
			activity: "working",
			isSessionActive: true,
			activeSessionId,
			sessionId,
			sessionFile: `/sessions/${sessionId}.jsonl`,
			sessionName: activeSessionId,
			cwd: "/repo",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 1,
			messageCount: 2,
			rlmDepth: 1,
			runtimeKind: "subagent",
			rlmChildId: sessionId,
			parentActiveSessionId: "parent-active-1",
			parentSessionId: "parent-session",
			parentSessionPath: "/sessions/parent.jsonl",
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			firstMessage: "[task from parent]",
			...overrides,
		} as SessionSummaryLike;
	}

	it("lists resident cloud rows as agent peers with the revision-32 observe fields", async () => {
		const supervisor = Object.create(DaemonSupervisor.prototype) as unknown as SupervisorStub;
		const properties = supervisor as unknown as Record<string, unknown>;
		const requesterWorker = {
			descriptor: {
				authenticationToken: "worker-token-1",
				rootActiveSessionId: "parent-active-1",
				lifecycle: "ready",
				socketPath: "/tmp/worker.sock",
				workerId: "worker-1",
			},
			client: {},
		};
		properties.workers = new Map([["worker-1", requesterWorker]]);
		properties.cloud = () =>
			({
				liveSummaries: () => [cloudKidSummary("cloud-active-kid-1")],
			}) as never;
		properties.roster = () => new AgentRoster((path: string) => path);
		properties.clients = new Set();

		const response = await supervisor.handleCommand(makeSupervisorClient(), {
			type: "list_agent_peers",
			workerToken: "worker-token-1",
		});
		expect(response).toMatchObject({
			type: "response",
			command: "list_agent_peers",
			success: true,
			data: {
				peers: [
					expect.objectContaining({
						activeSessionId: "cloud-active-kid-1",
						sessionId: "sess_kid-1",
						runtimeKind: "subagent",
						rlmDepth: 1,
						rlmChildId: "sess_kid-1",
						messageCount: 2,
						queuedCount: 0,
						attachedClients: 1,
						isSessionActive: true,
						isCompacting: false,
						firstMessage: "[task from parent]",
					}),
				],
			},
		});
	});

	it("routes local->cloud send_message through the supervisor with reach checks and a receipt", async () => {
		const supervisor = Object.create(DaemonSupervisor.prototype) as unknown as SupervisorStub;
		const properties = supervisor as unknown as Record<string, unknown>;
		const parentSummary = {
			id: "parent-active-1",
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			activeSessionId: "parent-active-1",
			sessionId: "parent-session",
			sessionFile: "/sessions/parent.jsonl",
			sessionName: "local-parent",
			cwd: "/repo",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			rlmDepth: 0,
			runtimeKind: "top-level",
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		};
		const kidTarget = cloudKidSummary("cloud-active-kid-1");
		const calls: Array<{ withSource: unknown; command: unknown }> = [];
		properties.cloud = () =>
			({
				resolveActive: (selector: string) =>
					selector === "cloud-active-kid-1" || selector === "sess_kid-1"
						? {
								record: { sessionId: "sess_kid-1", location: "spawned-child" },
								remoteSessionId: "sess_kid-1",
								activeSessionId: "cloud-active-kid-1",
								descendant: false,
								summary: kidTarget,
							}
						: selector === "parent-active-1"
							? {
									record: { sessionId: "parent-session" },
									remoteSessionId: "parent-session",
									activeSessionId: "parent-active-1",
									descendant: false,
									summary: parentSummary,
								}
							: undefined,
				handleSessionCommand: async (command: unknown, target: unknown, admission: unknown, source: unknown) => {
					calls.push({ withSource: source, command });
					void target;
					void admission;
					return {
						type: "response",
						command: "send_message",
						success: true,
						data: {
							id: "agentmsg_receipt_1",
							source: "agent_message",
							target: { activeSessionId: "cloud-active-kid-1", sessionId: "sess_kid-1" },
							message: "parent to kid",
							deliveryStatus: "delivered",
							deliveredAt: "2026-09-18T00:00:00.000Z",
							deliveryMode: "steer",
						},
					};
				},
				requireCloudRegistry: () => (properties.cloud as () => unknown)(),
			}) as never;
		properties.findWorkerForClient = async () => ({ worker: { id: "worker-parent" }, summary: parentSummary });
		properties.roster = () => new AgentRoster((path: string) => path);
		properties.clients = new Set();

		const response = await supervisor.handleCommand(makeSupervisorClient(), {
			type: "send_message",
			targetActiveSessionId: "cloud-active-kid-1",
			message: "parent to kid",
			fromActiveSessionId: "parent-active-1",
			agentOrigin: true,
		});
		expect(response).toMatchObject({
			type: "response",
			command: "send_message",
			success: true,
			data: { id: "agentmsg_receipt_1", deliveryStatus: "delivered" },
		});
		// The supervisor passed the local sender's summary so the guest's
		// agent-message entry and receipt carry the real endpoint.
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			withSource: { sessionId: "parent-session", activeSessionId: "parent-active-1" },
			command: {
				type: "send_message",
				targetActiveSessionId: "cloud-active-kid-1",
				message: "parent to kid",
			},
		});

		// An agent-origin send from an unrelated local session is refused by
		// the nuclear-family reach check before it reaches the guest.
		const strangerSummary = {
			...parentSummary,
			id: "stranger-active",
			activeSessionId: "stranger-active",
			sessionId: "stranger-session",
			sessionFile: "/sessions/stranger.jsonl",
			sessionName: "stranger",
		};
		properties.findWorkerForClient = async () => ({
			worker: { id: "worker-stranger" },
			summary: strangerSummary,
		});
		await expect(
			supervisor.handleCommand(makeSupervisorClient(), {
				type: "send_message",
				targetActiveSessionId: "cloud-active-kid-1",
				message: "not family",
				fromActiveSessionId: "stranger-active",
				agentOrigin: true,
			}),
		).rejects.toThrow("Agent reach is limited to parent, siblings, and children");
	});

	it("delivers cloud->local agent messages through the supervisor with reach checks", async () => {
		const supervisor = Object.create(DaemonSupervisor.prototype) as unknown as SupervisorStub;
		const properties = supervisor as unknown as Record<string, unknown>;
		const parentSummary = {
			id: "parent-active-1",
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			activeSessionId: "parent-active-1",
			sessionId: "parent-session",
			sessionFile: "/sessions/parent.jsonl",
			sessionName: "local-parent",
			cwd: "/repo",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		};
		const foreignSummary = {
			...parentSummary,
			sessionId: "foreign-session",
			sessionFile: "/sessions/foreign.jsonl",
			activeSessionId: "foreign-active",
			id: "foreign-active",
		};
		const kidTarget = cloudKidSummary("cloud-active-kid-1");
		const requestWorkerCalls: unknown[] = [];
		properties.cloud = () =>
			({
				resolveActive: (selector: string) =>
					selector === "sess_kid-1"
						? {
								record: { sessionId: "sess_kid-1", location: "spawned-child" },
								remoteSessionId: "sess_kid-1",
								activeSessionId: "cloud-active-kid-1",
								descendant: false,
								summary: kidTarget,
							}
						: undefined,
				handleSessionCommand: async (command: unknown, target: unknown, admission: unknown, source: unknown) => {
					void command;
					void admission;
					expect(target).toMatchObject({ summary: kidTarget });
					expect(source).toMatchObject({ sessionId: "parent-session" });
					return {
						type: "response",
						command: "send_message",
						success: true,
						data: {
							id: "agentmsg_cloud_to_cloud",
							source: "agent_message",
							target: { activeSessionId: "cloud-active-kid-1", sessionId: "sess_kid-1" },
							message: "sibling note",
							deliveryStatus: "delivered",
						},
					};
				},
			}) as never;
		properties.findWorker = async (selector: string) => {
			if (selector === "parent-session" || selector === "parent-active-1") {
				return { worker: { id: "worker-parent" }, summary: parentSummary };
			}
			return { worker: { id: "worker-foreign" }, summary: foreignSummary };
		};
		properties.requireAvailableWorkerClient = (worker: { id: string }) => ({
			requestWorker: async (frame: unknown) => {
				requestWorkerCalls.push({ worker: worker.id, frame });
				return {
					type: "response",
					success: true,
					data: {
						id: "agentmsg_local_receipt",
						source: "agent_message",
						target: { activeSessionId: "parent-active-1", sessionId: "parent-session" },
						message: "kid to parent",
						deliveryStatus: "delivered",
					},
				};
			},
		});

		// A cloud child messaging its local parent: reachable ("parent").
		const receipt = await supervisor.deliverCloudAgentMessage({
			source: {
				record: { sessionId: "sess_kid-1", location: "spawned-child" },
				remoteSessionId: "sess_kid-1",
				activeSessionId: "cloud-active-kid-1",
				descendant: false,
				summary: kidTarget,
			},
			targetSelector: "parent-session",
			message: "kid to parent",
		});
		expect(receipt).toMatchObject({ id: "agentmsg_local_receipt", deliveryStatus: "delivered" });
		expect(requestWorkerCalls).toHaveLength(1);
		expect(requestWorkerCalls[0]).toMatchObject({
			worker: "worker-parent",
			frame: {
				type: "worker_deliver_message",
				targetActiveSessionId: "parent-active-1",
				message: "kid to parent",
				sender: { activeSessionId: "cloud-active-kid-1", sessionId: "sess_kid-1", runtimeKind: "subagent" },
			},
		});

		// An unrelated local session is outside the nuclear family.
		await expect(
			supervisor.deliverCloudAgentMessage({
				source: {
					record: { sessionId: "sess_kid-1", location: "spawned-child" },
					remoteSessionId: "sess_kid-1",
					activeSessionId: "cloud-active-kid-1",
					descendant: false,
					summary: kidTarget,
				},
				targetSelector: "foreign-session",
				message: "not reachable",
			}),
		).rejects.toThrow("Agent reach is limited to parent, siblings, and children");
	});

	it("merges reachable cloud peers into agent_observe.list (worker side)", async () => {
		const daemon = new AgentDaemon("/tmp/unused-family-parity.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const internals = daemon as unknown as WorkerInternals;
		const current = makeWorkerState("parent-active-1");
		internals.sessions.set(current.activeSessionId, current);
		internals.listSupervisorAgentPeers = vi.fn(async () => [
			{
				// A reachable cloud child (nuclear family: child of current).
				activeSessionId: "cloud-active-kid-1",
				sessionId: "sess_kid-1",
				sessionName: "kid-1",
				runtimeKind: "subagent" as const,
				cwd: "/repo",
				isStreaming: false,
				unfinishedActionCount: 0,
				rlmDepth: 1,
				status: "running" as const,
				parentActiveSessionId: "parent-active-1",
				parentSessionId: "parent-session",
				parentSessionPath: "/sessions/parent.jsonl",
				sessionPath: "/sessions/sess_kid-1.jsonl",
				rlmChildId: "sess_kid-1",
				messageCount: 3,
				queuedCount: 1,
				attachedClients: 2,
				isSessionActive: true,
				isCompacting: false,
				firstMessage: "[task from parent]",
			},
			{
				// A foreign worker's subagent: a child of a different parent,
				// outside the current session's nuclear family.
				activeSessionId: "other-active-1",
				sessionId: "other-session",
				sessionName: "stranger",
				runtimeKind: "subagent" as const,
				cwd: "/elsewhere",
				isStreaming: false,
				unfinishedActionCount: 0,
				rlmDepth: 1,
				status: "idle" as const,
				parentActiveSessionId: "other-parent-active",
				parentSessionId: "other-parent",
				parentSessionPath: "/sessions/other-parent.jsonl",
				sessionPath: "/sessions/other-session.jsonl",
				rlmChildId: "other-session",
			},
		]);
		const listed = await internals.createAgentObserveListResult(current);
		const cloudRow = listed.agents.find((agent) => agent.activeSessionId === "cloud-active-kid-1");
		expect(cloudRow).toMatchObject({
			sessionId: "sess_kid-1",
			sessionName: "kid-1",
			runtimeKind: "subagent",
			status: "busy",
			isCurrent: false,
			isStreaming: false,
			messageCount: 3,
			queuedCount: 1,
			attachedClients: 2,
			isSessionActive: true,
			firstMessage: "[task from parent]",
		});
		expect(listed.agents.some((agent) => agent.activeSessionId === "other-active-1")).toBe(false);
	});
});
