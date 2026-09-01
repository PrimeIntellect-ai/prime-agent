import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { type CustomMessage, convertToLlm } from "../../../src/core/messages.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

describe("Issue #18 regression: bind canonical delivery to a serialized run generation", () => {
	let harness: Harness | undefined;
	const recordAcceptedAnswer = async (candidateId: string, delivery: string): Promise<void> => {
		await harness!.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: { candidate_id: candidateId, kind: "answer", summary: `${candidateId} answer`, payload: delivery },
		});
		await harness!.session.handleAvoHostRequest("avo.evaluation.record", {
			evaluation: {
				candidate_id: candidateId,
				evaluator_id: "subjective_review",
				status: "pass",
				authority: "model_opinion",
				evidence_refs: [],
				metrics: { reviewed: true },
			},
		});
		await harness!.session.handleAvoHostRequest("avo.cycle.complete", {
			cycle: { candidate_id: candidateId },
		});
	};
	const prepareAcceptedAnswer = async (candidateId: string, delivery: string) => {
		harness = await createHarness({ persistSession: true });
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Prepare a canonical answer");
		await recordAcceptedAnswer(candidateId, delivery);
		const internals = harness.session as unknown as {
			_enforceAvoCompletion: boolean;
			_avoRuntime: {
				getState: () => {
					runId: string;
					status: string;
					delivery: {
						phase: string;
						runId: string;
						candidateId?: string;
						cycleId?: string;
						deliveryDigest?: string;
						stateVersion?: number;
					};
				};
				syncMemory: () => Promise<Record<string, unknown>>;
				store: {
					beginCanonicalDelivery: (gate: unknown) => unknown;
					failCanonicalDelivery: (code: string, reason: string) => unknown;
				};
			};
			_collectAvoSupervisorResults: () => Promise<{
				ingested: number;
				supervision: unknown[];
				errors: string[];
			}>;
			_getAvoCompletionContinuation: (context: {
				message: ReturnType<typeof fauxAssistantMessage>;
				newMessages: Array<ReturnType<typeof fauxAssistantMessage>>;
			}) => Promise<{ customType?: string; details?: unknown; content?: string } | undefined>;
		};
		internals._enforceAvoCompletion = true;
		return internals;
	};

	afterEach(async () => {
		if (harness) {
			await harness.session.dispose();
			harness = undefined;
		}
	});

	it("serializes concurrent stop_gate and complete requests to admit exactly one canonical turn", async () => {
		const readyTool: AgentTool = {
			name: "ready",
			label: "Ready",
			description: "Records verified candidate and triggers parallel delivery requests",
			parameters: Type.Object({}),
			execute: async () => {
				await harness!.session.handleAvoHostRequest("avo.candidate.add", {
					candidate: {
						candidate_id: "candidate-parallel",
						kind: "answer",
						summary: "Parallel candidate",
						payload: "Exact canonical output line.",
					},
				});
				await harness!.session.handleAvoHostRequest("avo.evaluation.record", {
					evaluation: {
						candidate_id: "candidate-parallel",
						evaluator_id: "subjective_review",
						status: "pass",
						authority: "model_opinion",
						evidence_refs: [],
						metrics: { reviewed: true },
					},
				});
				await harness!.session.handleAvoHostRequest("avo.cycle.complete", {
					cycle: { candidate_id: "candidate-parallel" },
				});

				// Invoke stop_gate and complete concurrently across the async boundary
				const [gateResult, completeResult] = await Promise.all([
					harness!.session.handleAvoHostRequest("avo.stop_gate"),
					harness!.session.handleAvoHostRequest("avo.complete"),
				]);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ gateResult, completeResult }),
						},
					],
					details: {},
				};
			},
		};

		harness = await createHarness({
			persistSession: true,
			enforceAvoCompletion: true,
			tools: [readyTool],
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ready", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Exact canonical output line."),
		]);

		await harness.session.prompt("Execute parallel canonical delivery test");

		// Exactly 2 provider turns: 1 tool turn + 1 canonical delivery turn
		expect(harness.faux.state.callCount).toBe(2);

		// Exactly one canonical delivery prompt was queued
		const canonicalPrompts = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "avo_canonical_delivery_required",
		);
		expect(canonicalPrompts).toHaveLength(1);

		// State successfully delivered and completed
		const state = (
			harness.session as unknown as {
				_avoRuntime: {
					getState: () => { status: string; delivery: { phase: string; stateVersion?: number } };
				};
			}
		)._avoRuntime.getState();
		expect(state.status).toBe("completed");
		expect(state.delivery.phase).toBe("delivered");
		expect(state.delivery.stateVersion).toEqual(expect.any(Number));
		expect(canonicalPrompts[0]).toMatchObject({
			details: { stateVersion: state.delivery.stateVersion },
		});
	}, 10_000);

	it("serializes turn-boundary assessment against a concurrent host stop gate", async () => {
		const readyTool: AgentTool = {
			name: "ready_and_race_boundary",
			label: "Ready and race boundary",
			description: "Records a verified candidate and races turn-boundary assessment with the host gate",
			parameters: Type.Object({}),
			execute: async () => {
				await harness!.session.handleAvoHostRequest("avo.candidate.add", {
					candidate: {
						candidate_id: "candidate-boundary-race",
						kind: "answer",
						summary: "Boundary candidate",
						payload: "Boundary canonical output.",
					},
				});
				await harness!.session.handleAvoHostRequest("avo.evaluation.record", {
					evaluation: {
						candidate_id: "candidate-boundary-race",
						evaluator_id: "subjective_review",
						status: "pass",
						authority: "model_opinion",
						evidence_refs: [],
						metrics: { reviewed: true },
					},
				});
				await harness!.session.handleAvoHostRequest("avo.cycle.complete", {
					cycle: { candidate_id: "candidate-boundary-race" },
				});
				const internals = harness!.session as unknown as {
					_completeAvoCanonicalDeliveryIfMatching: (context: {
						message: ReturnType<typeof fauxAssistantMessage>;
						newMessages: Array<ReturnType<typeof fauxAssistantMessage>>;
					}) => Promise<boolean>;
				};
				const boundaryMessage = fauxAssistantMessage("Not the canonical delivery.");
				await Promise.all([
					internals._completeAvoCanonicalDeliveryIfMatching({
						message: boundaryMessage,
						newMessages: [boundaryMessage],
					}),
					harness!.session.handleAvoHostRequest("avo.stop_gate"),
				]);
				return { content: [{ type: "text", text: "boundary race complete" }], details: {} };
			},
		};

		harness = await createHarness({
			persistSession: true,
			enforceAvoCompletion: true,
			tools: [readyTool],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ready_and_race_boundary", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Boundary canonical output."),
		]);

		await harness.session.prompt("Race the turn boundary against the host gate");

		expect(harness.faux.state.callCount).toBe(2);
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "avo_canonical_delivery_required",
			),
		).toHaveLength(1);
		const state = (
			harness.session as unknown as {
				_avoRuntime: { getState: () => { status: string; delivery: { phase: string } } };
			}
		)._avoRuntime.getState();
		expect(state).toMatchObject({ status: "completed", delivery: { phase: "delivered" } });
	});

	it("does not falsely recover an unprompted new run using an older assistant message by digest alone", async () => {
		const canonicalText = "Exact text that repeats across runs.";

		const finishRun1Tool: AgentTool = {
			name: "finish_run_1",
			label: "Finish Run 1",
			description: "Completes run 1",
			parameters: Type.Object({}),
			execute: async () => {
				await harness!.session.handleAvoHostRequest("avo.candidate.add", {
					candidate: {
						candidate_id: "candidate-run1",
						kind: "answer",
						summary: "Run 1 candidate",
						payload: canonicalText,
					},
				});
				await harness!.session.handleAvoHostRequest("avo.evaluation.record", {
					evaluation: {
						candidate_id: "candidate-run1",
						evaluator_id: "subjective_review",
						status: "pass",
						authority: "model_opinion",
						evidence_refs: [],
						metrics: { reviewed: true },
					},
				});
				await harness!.session.handleAvoHostRequest("avo.cycle.complete", {
					cycle: { candidate_id: "candidate-run1" },
				});
				const gate = await harness!.session.handleAvoHostRequest("avo.stop_gate");
				return { content: [{ type: "text", text: JSON.stringify(gate) }], details: {} };
			},
		};

		harness = await createHarness({
			persistSession: true,
			enforceAvoCompletion: true,
			tools: [finishRun1Tool],
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("finish_run_1", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(canonicalText),
		]);

		// Run 1 completes cleanly
		await harness.session.prompt("Run 1 task");
		expect(harness.faux.state.callCount).toBe(2);

		const run1State = (
			harness.session as unknown as { _avoRuntime: { getState: () => { status: string; runId: string } } }
		)._avoRuntime.getState();
		expect(run1State.status).toBe("completed");

		// Start Run 2 in the same session
		const avoRuntime = (
			harness.session as unknown as {
				_avoRuntime: {
					store: {
						startTask: (title: string, desc: string) => unknown;
						beginCanonicalDelivery: (gate: unknown) => unknown;
					};
				};
			}
		)._avoRuntime;
		avoRuntime.store.startTask("Run 2 task", "Run 2 task");

		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "candidate-run2",
				kind: "answer",
				summary: "Run 2 candidate",
				payload: canonicalText, // Identical text digest as Run 1!
			},
		});
		await harness.session.handleAvoHostRequest("avo.evaluation.record", {
			evaluation: {
				candidate_id: "candidate-run2",
				evaluator_id: "subjective_review",
				status: "pass",
				authority: "model_opinion",
				evidence_refs: [],
				metrics: { reviewed: true },
			},
		});
		await harness.session.handleAvoHostRequest("avo.cycle.complete", {
			cycle: { candidate_id: "candidate-run2" },
		});
		const gate2 = (await harness.session.handleAvoHostRequest("avo.stop_gate")) as { stop_gate: { passed: boolean } };
		expect(gate2.stop_gate.passed).toBe(true);
		avoRuntime.store.beginCanonicalDelivery(gate2.stop_gate);
		const pendingRun2 = (
			avoRuntime.store as unknown as {
				getState: () => {
					runId: string;
					delivery: {
						candidateId: string;
						cycleId: string;
						deliveryDigest: string;
						stateVersion: number;
					};
				};
			}
		).getState();
		harness.sessionManager.appendCustomMessageEntry(
			"avo_canonical_delivery_required",
			"Stale same-run canonical request",
			true,
			{
				runId: pendingRun2.runId,
				candidateId: pendingRun2.delivery.candidateId,
				cycleId: pendingRun2.delivery.cycleId,
				deliveryDigest: pendingRun2.delivery.deliveryDigest,
				stateVersion: pendingRun2.delivery.stateVersion - 1,
			},
		);
		harness.sessionManager.appendMessage(fauxAssistantMessage(canonicalText));

		// Restart with a same-run request/response pair from the wrong state version.
		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reopenedManager = SessionManager.open(sessionFile!);
		const model = harness.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const restartedAgent = new Agent({
			getApiKey: () => "faux-key",
			initialState: { model, systemPrompt: "You are a test assistant.", tools: [] },
			convertToLlm,
		});
		restartedAgent.state.messages = reopenedManager.buildSessionContext().messages;

		const reopenedSession = new AgentSession({
			agent: restartedAgent,
			sessionManager: reopenedManager,
			settingsManager: SettingsManager.inMemory(),
			cwd: harness.tempDir,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
			rlmDepth: 0,
			enforceAvoCompletion: true,
		});

		// Verify that Run 2 was NOT falsely completed by Run 1's historical assistant message!
		const stateAfterRestart = (
			reopenedSession as unknown as {
				_avoRuntime: { getState: () => { status: string; runId: string; delivery: { phase: string } } };
			}
		)._avoRuntime.getState();
		expect(stateAfterRestart.status).toBe("active");
		expect(stateAfterRestart.delivery.phase).toBe("pending");

		await reopenedSession.dispose();
	});

	it("recovers a persisted canonical request and response pair for the current run on restart", async () => {
		const canonicalText = "Canonical paired response text.";
		const internals = await prepareAcceptedAnswer("cand-paired", canonicalText);
		const wrong = fauxAssistantMessage("not canonical");
		const canonicalPrompt = (await internals._getAvoCompletionContinuation({
			message: wrong,
			newMessages: [wrong],
		})) as CustomMessage;
		const persistedExact = fauxAssistantMessage(canonicalText);
		harness!.session.agent.state.messages.push(canonicalPrompt, persistedExact);
		harness!.sessionManager.appendCustomMessageEntry(
			canonicalPrompt.customType,
			canonicalPrompt.content,
			canonicalPrompt.display,
			canonicalPrompt.details,
		);
		harness!.sessionManager.appendMessage(persistedExact);
		const providerCallsBeforeRestart = harness!.faux.state.callCount;
		const sessionFile = harness!.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reopenedManager = SessionManager.open(sessionFile!);
		const model = harness!.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const restartedAgent = new Agent({
			getApiKey: () => "faux-key",
			initialState: { model, systemPrompt: "You are a test assistant.", tools: [] },
			convertToLlm,
		});
		restartedAgent.state.messages = reopenedManager.buildSessionContext().messages;
		const reopenedSession = new AgentSession({
			agent: restartedAgent,
			sessionManager: reopenedManager,
			settingsManager: SettingsManager.inMemory(),
			cwd: harness!.tempDir,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
			rlmDepth: 0,
			enforceAvoCompletion: true,
		});

		try {
			expect(harness!.faux.state.callCount).toBe(providerCallsBeforeRestart);
			expect(
				(
					reopenedSession as unknown as {
						_avoRuntime: { getState: () => { status: string; delivery: { phase: string } } };
					}
				)._avoRuntime.getState(),
			).toMatchObject({ status: "completed", delivery: { phase: "delivered" } });
		} finally {
			await reopenedSession.dispose();
		}
	});

	it("recomputes the full gate when canonical ownership mutates during memory sync", async () => {
		const internals = await prepareAcceptedAnswer("candidate-before-sync", "Before sync.");
		let releaseSync!: () => void;
		let markSyncStarted!: () => void;
		const syncStarted = new Promise<void>((resolve) => {
			markSyncStarted = resolve;
		});
		const syncGate = new Promise<void>((resolve) => {
			releaseSync = resolve;
		});
		vi.spyOn(internals._avoRuntime, "syncMemory").mockImplementationOnce(async () => {
			markSyncStarted();
			await syncGate;
			return { ok: true };
		});

		const wrong = fauxAssistantMessage("not canonical");
		const continuation = internals._getAvoCompletionContinuation({ message: wrong, newMessages: [wrong] });
		await syncStarted;
		await recordAcceptedAnswer("candidate-during-sync", "After sync.");
		releaseSync();

		await expect(continuation).resolves.toMatchObject({
			customType: "avo_canonical_delivery_required",
			details: { candidateId: "candidate-during-sync", stateVersion: expect.any(Number) },
		});
		expect(internals._avoRuntime.getState()).toMatchObject({
			status: "active",
			delivery: { phase: "pending", candidateId: "candidate-during-sync" },
		});
	});

	it("recomputes the full gate when canonical ownership mutates during supervisor collection", async () => {
		const internals = await prepareAcceptedAnswer("candidate-before-supervisor", "Before supervisor.");
		let releaseSupervisor!: () => void;
		let markSupervisorStarted!: () => void;
		const supervisorStarted = new Promise<void>((resolve) => {
			markSupervisorStarted = resolve;
		});
		const supervisorGate = new Promise<void>((resolve) => {
			releaseSupervisor = resolve;
		});
		vi.spyOn(internals, "_collectAvoSupervisorResults").mockImplementationOnce(async () => {
			markSupervisorStarted();
			await supervisorGate;
			return { ingested: 0, supervision: [], errors: [] };
		});

		const wrong = fauxAssistantMessage("not canonical");
		const continuation = internals._getAvoCompletionContinuation({ message: wrong, newMessages: [wrong] });
		await supervisorStarted;
		await recordAcceptedAnswer("candidate-during-supervisor", "After supervisor.");
		releaseSupervisor();

		await expect(continuation).resolves.toMatchObject({
			customType: "avo_canonical_delivery_required",
			details: { candidateId: "candidate-during-supervisor", stateVersion: expect.any(Number) },
		});
	});

	it("recomputes the full gate when canonical ownership mutates during repair sync", async () => {
		const internals = await prepareAcceptedAnswer("candidate-before-repair", "Before repair.");
		const store = internals._avoRuntime.store;
		const originalBegin = store.beginCanonicalDelivery.bind(store);
		vi.spyOn(store, "beginCanonicalDelivery")
			.mockImplementationOnce(() => {
				throw new Error("canonical accepted-cycle memory is missing");
			})
			.mockImplementation((gate) => originalBegin(gate));
		let syncCalls = 0;
		let releaseRepairSync!: () => void;
		let markRepairSyncStarted!: () => void;
		const repairSyncStarted = new Promise<void>((resolve) => {
			markRepairSyncStarted = resolve;
		});
		const repairSyncGate = new Promise<void>((resolve) => {
			releaseRepairSync = resolve;
		});
		vi.spyOn(internals._avoRuntime, "syncMemory").mockImplementation(async () => {
			syncCalls += 1;
			if (syncCalls === 2) {
				markRepairSyncStarted();
				await repairSyncGate;
			}
			return { ok: true };
		});

		const wrong = fauxAssistantMessage("not canonical");
		const continuation = internals._getAvoCompletionContinuation({ message: wrong, newMessages: [wrong] });
		await repairSyncStarted;
		await recordAcceptedAnswer("candidate-during-repair", "After repair.");
		releaseRepairSync();

		await expect(continuation).resolves.toMatchObject({
			customType: "avo_canonical_delivery_required",
			details: { candidateId: "candidate-during-repair", stateVersion: expect.any(Number) },
		});
	});

	it("discards a stale canonical action when the generation mutates during queue admission", async () => {
		let releaseAdmission!: () => void;
		let markAdmissionStarted!: () => void;
		const admissionStarted = new Promise<void>((resolve) => {
			markAdmissionStarted = resolve;
		});
		const admissionGate = new Promise<void>((resolve) => {
			releaseAdmission = resolve;
		});
		const readyTool: AgentTool = {
			name: "queue_race",
			label: "Queue race",
			description: "Seals canonical delivery while its queue admission is paused",
			parameters: Type.Object({}),
			execute: async () => {
				await recordAcceptedAnswer("candidate-queue-race", "Queue canonical output.");
				await harness!.session.handleAvoHostRequest("avo.stop_gate");
				return { content: [{ type: "text", text: "queue race complete" }], details: {} };
			},
		};
		harness = await createHarness({ persistSession: true, enforceAvoCompletion: true, tools: [readyTool] });
		const internals = harness.session as unknown as {
			_avoRuntime: {
				getState: () => { status: string; delivery: { phase: string; failureCode?: string } };
				store: { failCanonicalDelivery: (code: string, reason: string) => unknown };
			};
			_queuePreparedPrompt: (...args: unknown[]) => Promise<boolean>;
		};
		const originalQueue = internals._queuePreparedPrompt.bind(internals);
		vi.spyOn(internals, "_queuePreparedPrompt").mockImplementation(async (...args) => {
			const admitted = await originalQueue(...args);
			markAdmissionStarted();
			await admissionGate;
			return admitted;
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("queue_race", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("ordinary post-tool completion"),
		]);

		const prompt = harness.session.prompt("Race canonical queue admission");
		await admissionStarted;
		internals._avoRuntime.store.failCanonicalDelivery("TEST_QUEUE_MUTATION", "test queue mutation");
		releaseAdmission();
		await prompt;

		expect(internals._avoRuntime.getState()).toMatchObject({
			status: "failed",
			delivery: { phase: "failed", failureCode: "TEST_QUEUE_MUTATION" },
		});
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "avo_invariant_failure",
			),
		).toHaveLength(0);
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "avo_canonical_delivery_required",
			),
		).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("hides and protects the sole canonical action from clear, delete, and move queue mutations", async () => {
		const internals = await prepareAcceptedAnswer("candidate-queue-protected", "Protected canonical output.");
		type TestAction = {
			delivery: string;
			lifecycle: { state: string };
			payload: {
				kind: string;
				text: string;
				queueVisible?: boolean;
				customMessage?: { customType?: string };
			};
		};
		const queueInternals = harness!.session as unknown as {
			_avoCanonicalDeliveryDirectBinding?: unknown;
			_queuePreparedPrompt: (...args: unknown[]) => Promise<boolean>;
			_ensurePersistedAvoCanonicalDeliveryAction: () => Promise<void>;
			_cancelSessionActions: (predicate: (action: TestAction) => boolean, error: Error) => TestAction[];
			_actionStore: {
				unfinishedActions: () => readonly TestAction[];
				queuedActions: () => readonly TestAction[];
			};
		};
		await queueInternals._queuePreparedPrompt("steer", "visible one", undefined, { source: "extension" });
		await queueInternals._queuePreparedPrompt("steer", "visible two", undefined, { source: "extension" });
		const wrong = fauxAssistantMessage("not canonical");
		await internals._getAvoCompletionContinuation({ message: wrong, newMessages: [wrong] });
		queueInternals._avoCanonicalDeliveryDirectBinding = undefined;
		await queueInternals._ensurePersistedAvoCanonicalDeliveryAction();

		const canonicalActions = () =>
			queueInternals._actionStore
				.unfinishedActions()
				.filter((action) => action.payload.customMessage?.customType === "avo_canonical_delivery_required");
		expect(canonicalActions()).toHaveLength(1);
		expect(canonicalActions()[0]).toMatchObject({
			delivery: "next_turn_boundary",
			lifecycle: { state: "queued" },
			payload: { queueVisible: false },
		});
		expect(queueInternals._actionStore.queuedActions()[0]).toBe(canonicalActions()[0]);
		expect(harness!.session.getSessionActionSnapshot()).toMatchObject({
			queuedCount: 2,
			steering: ["visible one", "visible two"],
		});

		expect(harness!.session.mutateQueuedMessage("steering", 0, "visible one", { type: "move", direction: 1 })).toBe(
			"applied",
		);
		expect(queueInternals._actionStore.queuedActions()[0]).toBe(canonicalActions()[0]);
		expect(canonicalActions()).toHaveLength(1);

		expect(harness!.session.mutateQueuedMessage("steering", 0, "visible two", { type: "delete" })).toBe("applied");
		expect(canonicalActions()).toHaveLength(1);
		expect(harness!.session.clearQueue()).toEqual({ steering: ["visible one"], followUp: [] });
		expect(canonicalActions()).toHaveLength(1);
		expect(harness!.session.getSessionActionSnapshot()).toMatchObject({ queuedCount: 0, steering: [] });
		expect(
			harness!.session.mutateQueuedMessage("steering", 0, "Protected canonical output.", { type: "delete" }),
		).toBe("rejected");

		expect(
			queueInternals._cancelSessionActions(
				(action) => action.payload.customMessage?.customType === "avo_canonical_delivery_required",
				new Error("simulated internal canonical-action loss"),
			),
		).toHaveLength(1);
		expect(canonicalActions()).toHaveLength(0);
		await queueInternals._ensurePersistedAvoCanonicalDeliveryAction();
		expect(canonicalActions()).toHaveLength(1);
		expect(queueInternals._actionStore.queuedActions()[0]).toBe(canonicalActions()[0]);
	});

	it("ignores a stale same-run success callback with the current delivery text", async () => {
		const internals = await prepareAcceptedAnswer("candidate-current-success", "Shared canonical output.");
		const wrong = fauxAssistantMessage("not canonical");
		const currentPrompt = (await internals._getAvoCompletionContinuation({
			message: wrong,
			newMessages: [wrong],
		})) as CustomMessage;
		const currentDetails = currentPrompt.details as Record<string, unknown>;
		const stalePrompt = {
			...currentPrompt,
			details: {
				...currentDetails,
				stateVersion: Number(currentDetails.stateVersion) - 1,
			},
		} satisfies CustomMessage;
		harness!.session.agent.state.messages.push(stalePrompt, fauxAssistantMessage("Shared canonical output."));
		const successInternals = harness!.session as unknown as {
			_completePersistedAvoCanonicalDeliveryIfPresent: () => boolean;
		};

		expect(successInternals._completePersistedAvoCanonicalDeliveryIfPresent()).toBe(false);
		expect(internals._avoRuntime.getState()).toMatchObject({
			status: "active",
			delivery: { phase: "pending", candidateId: "candidate-current-success" },
		});
	});

	it("ignores a stale same-run delivery failure callback without failing the current generation", async () => {
		const internals = await prepareAcceptedAnswer("candidate-current-failure", "Current canonical output.");
		const wrong = fauxAssistantMessage("not canonical");
		await internals._getAvoCompletionContinuation({ message: wrong, newMessages: [wrong] });
		const pending = internals._avoRuntime.getState();
		const binding = {
			runId: pending.delivery.runId,
			candidateId: pending.delivery.candidateId!,
			cycleId: pending.delivery.cycleId!,
			deliveryDigest: pending.delivery.deliveryDigest!,
			stateVersion: pending.delivery.stateVersion!,
		};
		const failureInternals = harness!.session as unknown as {
			_recordAvoCanonicalDeliveryFailure: (error: unknown, expectedBinding: typeof binding) => boolean;
		};

		expect(
			failureInternals._recordAvoCanonicalDeliveryFailure(new Error("stale same-run callback"), {
				...binding,
				stateVersion: binding.stateVersion - 1,
			}),
		).toBe(false);
		expect(internals._avoRuntime.getState()).toMatchObject({
			status: "active",
			delivery: { phase: "pending", stateVersion: binding.stateVersion },
		});
		const failureMessages = harness!.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "avo_invariant_failure",
		);
		expect(failureMessages).toHaveLength(0);
	});

	it("ignores a stale same-run provider error instead of applying host fallback to the current generation", async () => {
		const internals = await prepareAcceptedAnswer("candidate-current-provider", "Current provider output.");
		const wrong = fauxAssistantMessage("not canonical");
		await internals._getAvoCompletionContinuation({ message: wrong, newMessages: [wrong] });
		const pending = internals._avoRuntime.getState();
		const binding = {
			runId: pending.delivery.runId,
			candidateId: pending.delivery.candidateId!,
			cycleId: pending.delivery.cycleId!,
			deliveryDigest: pending.delivery.deliveryDigest!,
			stateVersion: pending.delivery.stateVersion!,
		};
		const fallbackInternals = harness!.session as unknown as {
			_completeAvoCanonicalDeliveryFromHostFallback: (
				providerFailure: ReturnType<typeof fauxAssistantMessage>,
				expectedBinding: typeof binding,
			) => boolean;
		};

		expect(
			fallbackInternals._completeAvoCanonicalDeliveryFromHostFallback(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "stale provider error" }),
				{ ...binding, deliveryDigest: "0".repeat(64) },
			),
		).toBe(false);
		expect(internals._avoRuntime.getState()).toMatchObject({
			status: "active",
			delivery: { phase: "pending", deliveryDigest: binding.deliveryDigest },
		});
		expect(
			harness!.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "avo_canonical_delivery_host_fallback",
			),
		).toHaveLength(0);
	});
});
