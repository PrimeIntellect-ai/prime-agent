import { expect, it } from "vitest";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	type DurableDecisionKind,
	type DurableDecisionRecord,
	type DurableDecisionStage,
	digestObject,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowConcreteEffect,
	type WorkflowEffectPreimage,
	type WorkflowHostReceiptConsumerContext,
} from "../src/core/workflow/contracts.js";
import {
	createHostDecisionGate,
	type FreshStageRunner,
	type WorkflowDecisionContext,
	type WorkflowDecisionGate,
	type WorkflowDecisionHost,
	type WorkflowDecisionHostObservation,
	type WorkflowFreshGateFence,
	type WorkflowOperation,
	type WorkflowStageObservation,
	type WorkflowTypedOperation,
	type WorkflowWriteSetReservation,
	type WorkflowWriteSetReservationStore,
} from "../src/core/workflow/decision-gate.js";

const NOW = "2026-08-13T00:00:00.000Z";
const EXPIRES_AT = "2026-08-13T00:05:00.000Z";
const REQUIRED_STAGES: readonly DurableDecisionStage[] = [
	"recon",
	"lens",
	"lens",
	"verification",
	"synthesis",
	"red_team",
];

const MUTATION_PREIMAGE_REF: WorkflowArtifactRef = {
	artifactId: "mutation-1",
	relativePath: "operations/mutation-1",
	digest: "mutation-digest",
	sizeBytes: 1,
	sourceEventSequence: 1,
};

function createConcreteEffectForKind(kind: DurableDecisionKind): WorkflowConcreteEffect {
	const target =
		kind === "configuration_revision" || kind === "profile_selection"
			? "settings"
			: kind === "goal_binding" ||
					kind === "goal_transition" ||
					kind === "goal_contract" ||
					kind === "completion" ||
					kind === "cancellation"
				? "goal"
				: "session_projection";
	return {
		kind: "session_mutation",
		operationId: "operation-1",
		target,
		mutationPreimageRef: MUTATION_PREIMAGE_REF,
	};
}

const MATERIAL_CONCRETE_EFFECT = createConcreteEffectForKind("resource_envelope");
const MATERIAL_EFFECT_DIGEST = sha256Hex(canonicalJsonBytes(MATERIAL_CONCRETE_EFFECT));
const DECISION_BOUNDARY_DIGEST = digestObject({
	currentRevision: 1,
	configDigest: "config",
	profileDigest: "profile",
	revisionRegistryDigest: "revision-registry",
});
const CLASSIFIED_TARGET_DIGEST = digestObject({
	target: "target",
	readSet: [],
	boundaryDigest: DECISION_BOUNDARY_DIGEST,
});
const CLASSIFIED_EFFECT_DIGEST = digestObject({
	effect: MATERIAL_EFFECT_DIGEST,
	writeSet: ["session_projection"],
	boundaryDigest: DECISION_BOUNDARY_DIGEST,
});

const MATERIAL_OPERATION: WorkflowTypedOperation = {
	schemaVersion: 1,
	kind: "resource_envelope",
	targetDigest: "target",
	effectDigest: MATERIAL_EFFECT_DIGEST,
	preconditionDigest: "precondition",
	readSet: [],
	writeSet: ["session_projection"],
	effectFacts: {
		contractMutation: false,
		authorityMutation: true,
		resourceEnvelopeMutation: true,
		externalSideEffect: true,
		destructiveOrIrreversible: false,
		localWrite: false,
	},
};

interface GateFixture {
	gate: WorkflowDecisionGate;
	decision: DurableDecisionRecord & { decisionScope: { kind: "workflow"; workflowId: string; rootSessionId: string } };
	operation: WorkflowOperation;
	decisionHost: WorkflowDecisionHost;
	reservationStore: WorkflowWriteSetReservationStore & { released: WorkflowWriteSetReservation[] };
	stageRunner: FreshStageRunner;
	freshGateFence: WorkflowFreshGateFence;
	context: WorkflowDecisionContext;
	stageRefs: readonly WorkflowArtifactRef[];
}

function artifactKey(ref: WorkflowArtifactRef): string {
	return `${ref.artifactId}:${ref.relativePath}:${ref.sourceEventSequence}`;
}

function createContext(overlappingWriteSets: readonly (readonly string[])[] = []): WorkflowDecisionContext {
	return {
		stateDigest: "state",
		objectiveDigest: "objective",
		contractDigest: "contract",
		scorecardDigest: "scorecard",
		planDigest: "plan",
		workspaceDigest: "workspace",
		evidenceDigest: "evidence",
		parserDigest: "parser",
		evaluatorDigest: "evaluator",
		guardDigest: "guard",
		regressionDigest: "none",
		blockerDigest: null,
		redTeamDigest: "red-team",
		executionKey: "execution-key",
		currentRevision: 1,
		configDigest: "config",
		profileDigest: "profile",
		revisionRegistryDigest: "revision-registry",
		storeEpoch: 1,
		coordinatorEpoch: 1,
		now: NOW,
		overlappingWriteSets,
	};
}

function createObservation(
	context: WorkflowDecisionContext,
	currentDecision: DurableDecisionRecord & {
		decisionScope: { kind: "workflow"; workflowId: string; rootSessionId: string };
	},
): WorkflowDecisionHostObservation {
	return {
		context,
		trustedNow: context.now,
		revisionsDigest: "revisions",
		requiredCapabilities: [
			"observe_workflow",
			"request_user_approval",
			"invoke_host_effect",
			"consume_resource_lease",
			"write_owned_paths",
		],
		currentDecision: structuredClone(currentDecision),
	};
}

function createOperation(
	typed: WorkflowTypedOperation = MATERIAL_OPERATION,
	concrete: WorkflowConcreteEffect = createConcreteEffectForKind(typed.kind),
): WorkflowOperation {
	const bytes = canonicalJsonBytes(concrete);
	const preimageDigest = sha256Hex(bytes);
	return {
		kind: typed.kind,
		preimageRef: {
			artifactId: "operation-1",
			relativePath: "operations/operation-1",
			digest: preimageDigest,
			sizeBytes: bytes.byteLength,
			sourceEventSequence: 1,
		},
		preimageDigest,
	};
}

function createPreimage(
	operation: WorkflowOperation,
	concrete: WorkflowConcreteEffect = createConcreteEffectForKind(operation.kind),
): WorkflowEffectPreimage {
	const bytes = canonicalJsonBytes(concrete);
	return {
		artifactRef: operation.preimageRef,
		codec: "canonical_json",
		immutable: true,
		bytes,
		verifiedDigest: sha256Hex(bytes),
		verifiedSizeBytes: bytes.byteLength,
	};
}

function createReservationStore(): WorkflowWriteSetReservationStore & {
	released: WorkflowWriteSetReservation[];
} {
	const released: WorkflowWriteSetReservation[] = [];
	return {
		released,
		reserve: async (input) => ({
			reservationId: "reservation-1",
			decisionId: input.decisionId,
			revision: input.revision,
			normalizedPaths: input.normalizedPaths,
			reservationDigest: "reservation-digest",
			expectedHeadDigest: input.expectedHeadDigest,
			status: "held",
		}),
		assertHeld: async ({ reservation }) => {
			if (reservation.status !== "held") throw new Error("Reservation is not held.");
		},
		release: async ({ reservation }) => {
			released.push(reservation);
		},
	};
}

function createFreshGateFence(): WorkflowFreshGateFence {
	const claims = new Set<string>();
	return {
		claim: async (input) => {
			const key = digestObject(input);
			if (claims.has(key)) return "already_claimed";
			claims.add(key);
			return "claimed";
		},
	};
}

function createDecision(): DurableDecisionRecord & {
	decisionScope: { kind: "workflow"; workflowId: string; rootSessionId: string };
} {
	const placeholderRef: WorkflowArtifactRef = {
		artifactId: "placeholder",
		relativePath: "decisions/placeholder",
		digest: "placeholder",
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
	const placeholderReceipt = createFixtureHostReceipt({
		receiptKind: "adjudication",
		receiptId: "placeholder-receipt",
		issuerId: "decision-host",
		workflowId: "wf-1",
		bindingDigest: "placeholder",
		payloadDigest: "placeholder",
		artifactRef: placeholderRef,
		issuedAt: NOW,
		validUntil: EXPIRES_AT,
		keyId: "decision-host-key",
		stateDigest: "state",
		revision: 1,
	});
	return {
		decisionScope: { kind: "workflow", workflowId: "wf-1", rootSessionId: "session-1" },
		decisionId: "decision-1",
		revision: 1,
		parentDecisionIds: [],
		kind: "resource_envelope",
		hostClassification: {
			classifier: "host",
			rulesetDigest: "test-rules",
			effectClasses: ["authority_or_resource"],
			normalizedReadSet: [],
			normalizedWriteSet: ["session_projection"],
			derivedMateriality: "consequential",
			requiresUserApproval: true,
			reasonCodes: ["authority_or_resource"],
			classifiedTargetDigest: CLASSIFIED_TARGET_DIGEST,
			classifiedEffectDigest: CLASSIFIED_EFFECT_DIGEST,
		},
		storeEpoch: 1,
		coordinatorEpoch: 1,
		targetDigest: "target",
		effectDigest: MATERIAL_EFFECT_DIGEST,
		preconditionDigest: "precondition",
		authority: [
			"observe_workflow",
			"request_user_approval",
			"invoke_host_effect",
			"consume_resource_lease",
			"write_owned_paths",
		],
		expiresAt: EXPIRES_AT,
		objectiveDigest: "objective",
		contractDigest: "contract",
		scorecardDigest: "scorecard",
		planDigest: "plan",
		stateDigest: "state",
		workspaceDigest: "workspace",
		evidenceDigest: "evidence",
		parserDigest: "parser",
		evaluatorDigest: "evaluator",
		guardDigest: "guard",
		regressionDigest: "none",
		blockerDigest: null,
		redTeamDigest: "red-team",
		readSet: [],
		writeSet: ["session_projection"],
		attemptToken: "attempt-token",
		nonce: "nonce",
		executionKey: "execution-key",
		proposerSessionId: "proposer",
		lensSessionIds: [],
		verifierSessionId: "verifier",
		synthesizerSessionId: "synthesizer",
		redTeamSessionId: "red-team",
		stagePlan: {
			stages: ["recon", "lens", "lens", "verification", "synthesis", "red_team"],
			lensRoles: [null, "primary", "secondary", null, null, null],
			charterDigests: ["recon", "lens-primary", "lens-secondary", "verification", "synthesis", "red-team"],
			planDigest: "stage-plan",
		},
		stageVerdicts: [],
		hostAdjudication: {
			stage: "host_adjudication",
			decisionId: "decision-1",
			decisionRevision: 1,
			executionIdentity: "unissued",
			sessionId: "unissued",
			inputStateDigest: "state",
			operationDigest: "unissued",
			verdictArtifactRef: placeholderRef,
			verdictDigest: "unissued",
			hostReceipt: placeholderReceipt,
			disposition: "rejected",
		},
		artifactRefs: [],
		disposition: "proposed",
	};
}

async function createGateFixture(
	typed: WorkflowTypedOperation = MATERIAL_OPERATION,
	concrete: WorkflowConcreteEffect = createConcreteEffectForKind(typed.kind),
): Promise<GateFixture> {
	const operation = createOperation(typed, concrete);
	const operationBytes = canonicalJsonBytes(concrete);
	const baseReceiptContext = createFixtureHostReceiptConsumerContext();
	const stageRefs: WorkflowArtifactRef[] = [];
	for (let index = 0; index < REQUIRED_STAGES.length; index += 1) {
		const seedRef: WorkflowArtifactRef = {
			artifactId: `stage-${index + 1}`,
			relativePath: `decisions/stage-${index + 1}`,
			digest: "seed",
			sizeBytes: 0,
			sourceEventSequence: index + 1,
		};
		const artifact = await baseReceiptContext.artifactResolver.resolve(seedRef);
		stageRefs.push({ ...seedRef, digest: artifact.verifiedDigest, sizeBytes: artifact.verifiedSizeBytes });
	}
	const receiptContext: WorkflowHostReceiptConsumerContext = {
		...baseReceiptContext,
		artifactResolver: {
			resolve: async (ref) => {
				if (artifactKey(ref) === artifactKey(operation.preimageRef)) {
					return {
						envelope: { ref, payloadKind: "evidence", codec: "canonical_json", immutable: true },
						exists: true,
						bytes: operationBytes,
						verifiedDigest: sha256Hex(operationBytes),
						verifiedSizeBytes: operationBytes.byteLength,
					};
				}
				return baseReceiptContext.artifactResolver.resolve(ref);
			},
		},
	};
	const context = createContext();
	const reservationStore = createReservationStore();
	const freshGateFence = createFreshGateFence();
	const decision = createDecision();
	const decisionHost: WorkflowDecisionHost = {
		receiptContext,
		observe: async () => createObservation(context, decision),
		current: async () => createObservation(context, decision),
		resolveOperation: async () => ({ typed, preimage: createPreimage(operation, concrete) }),
		issueStageExecutionIdentity: async (input) => ({
			executionIdentity: `${input.decisionId}:${input.stage}:${input.lensRole ?? "none"}:execution`,
			sessionId: `${input.decisionId}:${input.stage}:${input.lensRole ?? "none"}:session`,
			bindingDigest: input.bindingDigest,
		}),
		resolveStageOutput: async (input) => ({
			decisionId: input.decisionId,
			decisionRevision: input.revision,
			stage: input.stage,
			lensRole: input.lensRole,
			stageId: input.executionIdentity,
			disposition: "accepted",
			sessionId: input.sessionId,
			executionIdentity: input.executionIdentity,
			storeEpoch: input.epochRef.storeEpoch,
			coordinatorEpoch: input.epochRef.coordinatorEpoch,
			inputStateDigest: input.stateDigest,
			evidenceDigest: input.observation.evidenceDigest,
			artifactRefs: input.observation.outputArtifactRefs,
			independence: {
				freshContext: true,
				distinctSessionIdentity: true,
				distinctExecutionIdentity: true,
				sharedConversation: false,
				sharedMutableOutput: false,
				inputStateDigest: input.stateDigest,
				charterDigest: input.charterDigest,
				limitationRefs: [],
			},
		}),
		issueAdjudicationReceipt: async (input) =>
			createFixtureHostReceipt({
				receiptKind: "adjudication",
				oneUse: true,
				receiptId: `${input.decisionId}:adjudication`,
				issuerId: "decision-host",
				workflowId: input.workflowId,
				bindingDigest: input.bindingDigest,
				payloadDigest: input.verdictDigest,
				artifactRef: input.verdictArtifactRef,
				issuedAt: NOW,
				validUntil: input.validUntil,
				keyId: "decision-host-key",
				stateDigest: "state",
				revision: input.decisionRevision,
			}),
	};
	const stageRunner: FreshStageRunner = {
		run: async (input) => {
			const stageIndex = input.priorVerdicts.length;
			const ref = stageRefs[stageIndex];
			if (ref === undefined) throw new Error("Missing stage fixture artifact.");
			return {
				sessionId: input.hostSessionId,
				executionIdentity: input.hostExecutionIdentity,
				outputDigest: `output-${stageIndex + 1}`,
				evidenceDigest: `evidence-${stageIndex + 1}`,
				outputArtifactRefs: [ref],
			};
		},
	};
	return {
		gate: createHostDecisionGate({ rulesetDigest: "test-rules", decisionHost, reservationStore, freshGateFence }),
		decision,
		operation,
		decisionHost,
		reservationStore,
		stageRunner,
		freshGateFence,
		context,
		stageRefs,
	};
}

it("derives consequential materiality from resolver-verified operation bytes", async () => {
	const fixture = await createGateFixture();
	const classification = await fixture.gate.classify(fixture.operation);
	expect(classification.derivedMateriality).toBe("consequential");
	expect(classification.requiresUserApproval).toBe(true);
	expect(classification.classifier).toBe("host");
});

it("treats a configuration revision as consequential even when effect facts are empty", async () => {
	const configurationEffect = createConcreteEffectForKind("configuration_revision");
	const configurationOperation: WorkflowTypedOperation = {
		...MATERIAL_OPERATION,
		kind: "configuration_revision",
		effectDigest: sha256Hex(canonicalJsonBytes(configurationEffect)),
		readSet: [],
		writeSet: ["settings"],
		effectFacts: {
			contractMutation: false,
			authorityMutation: false,
			resourceEnvelopeMutation: false,
			externalSideEffect: false,
			destructiveOrIrreversible: false,
			localWrite: false,
		},
	};
	const fixture = await createGateFixture(configurationOperation, configurationEffect);
	const classification = await fixture.gate.classify(fixture.operation);
	expect(classification.derivedMateriality).toBe("consequential");
	expect(classification.requiresUserApproval).toBe(true);
});

it("rejects a canonical concrete effect mismatched to the decision kind", async () => {
	const fixture = await createGateFixture(MATERIAL_OPERATION, createConcreteEffectForKind("configuration_revision"));
	await expect(fixture.gate.classify(fixture.operation)).rejects.toThrow(/concrete effect|closed operation/i);
});

it("rejects typed operation metadata whose effect digest differs from concrete bytes", async () => {
	const fixture = await createGateFixture({ ...MATERIAL_OPERATION, effectDigest: "forged-effect-digest" });
	await expect(fixture.gate.classify(fixture.operation)).rejects.toThrow(/preimage|stale|forged/i);
});

it("rejects a gate when the operation requires unavailable host authority", async () => {
	const fixture = await createGateFixture();
	const originalObserve = fixture.decisionHost.observe;
	const originalCurrent = fixture.decisionHost.current;
	fixture.decisionHost.observe = async (input) => ({
		...(await originalObserve(input)),
		requiredCapabilities: ["observe_workflow", "request_user_approval"],
	});
	fixture.decisionHost.current = async (input) => ({
		...(await originalCurrent(input)),
		requiredCapabilities: ["observe_workflow", "request_user_approval"],
	});
	await expect(
		fixture.gate.runFreshSixStageGate(fixture.decision, fixture.operation, "state", fixture.stageRunner),
	).rejects.toThrow(/authority|capabilit/i);
});

it("rejects a decision that omits authority required by the resolved operation", async () => {
	const fixture = await createGateFixture();
	fixture.decision.authority = ["observe_workflow", "request_user_approval"];
	await expect(
		fixture.gate.runFreshSixStageGate(fixture.decision, fixture.operation, "state", fixture.stageRunner),
	).rejects.toThrow(/authority|capabilit/i);
});

it("rejects an operation whose preimage digest is stale", async () => {
	const fixture = await createGateFixture();
	const staleOperation: WorkflowOperation = { ...fixture.operation, preimageDigest: "stale" };
	await expect(fixture.gate.classify(staleOperation)).rejects.toThrow(/preimage|stale|forged/i);
});

it("rejects stage gating when the current objective closure is stale", async () => {
	const fixture = await createGateFixture();
	fixture.context.objectiveDigest = "changed-objective";
	await expect(
		fixture.gate.runFreshSixStageGate(fixture.decision, fixture.operation, "state", fixture.stageRunner),
	).rejects.toThrow(/stale|digest/i);
	expect(fixture.reservationStore.released).toHaveLength(0);
});

it("rejects a self-consistent prior decision revision against the independently observed current revision", async () => {
	const fixture = await createGateFixture();
	fixture.context.currentRevision = 2;
	await expect(
		fixture.gate.runFreshSixStageGate(fixture.decision, fixture.operation, "state", fixture.stageRunner),
	).rejects.toThrow(/revision|stale/i);
	expect(fixture.reservationStore.released).toHaveLength(0);
});

it("rejects a decision whose boundary predates the current configuration before fresh stages", async () => {
	const fixture = await createGateFixture();
	fixture.context.configDigest = "changed-config";
	await expect(
		fixture.gate.runFreshSixStageGate(fixture.decision, fixture.operation, "state", fixture.stageRunner),
	).rejects.toThrow(/classification|stale|forged/i);
	expect(fixture.reservationStore.released).toHaveLength(0);
});

it.each(["configDigest", "profileDigest", "revisionRegistryDigest"] as const)(
	"rejects authorization when the current %s boundary changes",
	(field) =>
		(async () => {
			const fixture = await createGateFixture();
			const gated = await fixture.gate.runFreshSixStageGate(
				fixture.decision,
				fixture.operation,
				"state",
				fixture.stageRunner,
			);
			fixture.context[field] = `changed-${field}`;
			await expect(fixture.gate.authorize(gated, fixture.operation)).resolves.toBe("rejected");
		})(),
);

it("requires six fresh stages and host adjudication before approval", async () => {
	const fixture = await createGateFixture();
	const result = await fixture.gate.runFreshSixStageGate(
		fixture.decision,
		fixture.operation,
		"state",
		fixture.stageRunner,
	);
	expect(result.stageVerdicts.map((verdict) => verdict.stage)).toEqual(REQUIRED_STAGES);
	expect(result.stageVerdicts.map((verdict) => verdict.lensRole)).toEqual([
		null,
		"primary",
		"secondary",
		null,
		null,
		null,
	]);
	expect(new Set(result.stageVerdicts.map((verdict) => verdict.stageId)).size).toBe(6);
	expect(result.hostAdjudication.disposition).toBe("accepted");
	expect(result.hostAdjudication.verdictArtifactRef.digest).not.toBe("");
	expect(result.disposition).toBe("awaiting_user");
	await fixture.gate.validateVerdicts(result);
});

it("uses the durable fence to reject a second fresh gate for the same proposal", async () => {
	const fixture = await createGateFixture();
	const first = await fixture.gate.runFreshSixStageGate(
		fixture.decision,
		fixture.operation,
		"state",
		fixture.stageRunner,
	);
	await expect(
		fixture.gate.runFreshSixStageGate(fixture.decision, fixture.operation, "state", fixture.stageRunner),
	).rejects.toThrow(/fresh|fence|claimed|replay/i);
	await expect(
		fixture.gate.runFreshSixStageGate(first, fixture.operation, "state", fixture.stageRunner),
	).rejects.toThrow(/disposition|fresh|fence|claimed|replay/i);
});

it("rejects a fresh gate when both attempt credentials are mutated", async () => {
	const fixture = await createGateFixture();
	const forged = {
		...fixture.decision,
		attemptToken: "forged-attempt-token",
		nonce: "forged-nonce",
	};
	await expect(
		fixture.gate.runFreshSixStageGate(forged, fixture.operation, "state", fixture.stageRunner),
	).rejects.toThrow(/attempt|authority|stale|binding/i);
	expect(fixture.reservationStore.released).toHaveLength(0);
});

it("rejects an execution identity that is not bound to the decision attempt tuple", async () => {
	const fixture = await createGateFixture();
	const originalIssueStageExecutionIdentity = fixture.decisionHost.issueStageExecutionIdentity;
	fixture.decisionHost.issueStageExecutionIdentity = async (input) => ({
		...(await originalIssueStageExecutionIdentity(input)),
		bindingDigest: "forged-execution-binding",
	});
	await expect(
		fixture.gate.runFreshSixStageGate(fixture.decision, fixture.operation, "state", fixture.stageRunner),
	).rejects.toThrow(/binding|identity|attempt/i);
});

it("validates every persisted host-classification field without re-resolving an operation", async () => {
	const fixture = await createGateFixture();
	const gated = await fixture.gate.runFreshSixStageGate(
		fixture.decision,
		fixture.operation,
		"state",
		fixture.stageRunner,
	);
	gated.hostClassification = { ...gated.hostClassification, derivedMateriality: "routine" };
	await expect(fixture.gate.validateVerdicts(gated)).rejects.toThrow(
		/classification|authority|materiality|stale|forged/i,
	);
});

it("rejects self-consistent classification substitutions when validating without an operation", async () => {
	const fixture = await createGateFixture();
	const gated = await fixture.gate.runFreshSixStageGate(
		fixture.decision,
		fixture.operation,
		"state",
		fixture.stageRunner,
	);
	const forged = {
		...gated,
		hostClassification: {
			...gated.hostClassification,
			effectClasses: ["public_interface"] as const,
			reasonCodes: ["public_interface"] as const,
			derivedMateriality: "material" as const,
			requiresUserApproval: true,
		},
	};
	await expect(fixture.gate.validateVerdicts(forged)).rejects.toThrow(
		/classification|authority|materiality|stale|forged/i,
	);
});

it("rejects a host verdict that swaps a resolved artifact reference", async () => {
	const fixture = await createGateFixture();
	let stageIndex = 0;
	const resolveStageOutput = fixture.decisionHost.resolveStageOutput;
	fixture.decisionHost.resolveStageOutput = async (input) => {
		const verdict = await resolveStageOutput(input);
		const swappedRef = fixture.stageRefs[fixture.stageRefs.length - stageIndex - 1];
		stageIndex += 1;
		if (swappedRef === undefined) throw new Error("Missing swapped artifact fixture.");
		return { ...verdict, artifactRefs: [swappedRef] };
	};
	await expect(
		fixture.gate.runFreshSixStageGate(fixture.decision, fixture.operation, "state", fixture.stageRunner),
	).rejects.toThrow(/artifact|output|reference/i);
});

it("rejects adjudication bound to a different current operation digest", async () => {
	const fixture = await createGateFixture();
	const gated = await fixture.gate.runFreshSixStageGate(
		fixture.decision,
		fixture.operation,
		"state",
		fixture.stageRunner,
	);
	const operationDigest = "different-operation";
	const adjudication = gated.hostAdjudication;
	const bindingDigest = digestObject({
		decisionId: gated.decisionId,
		revision: gated.revision,
		operationDigest,
		stateDigest: adjudication.inputStateDigest,
		epochRef: { storeEpoch: gated.storeEpoch, coordinatorEpoch: gated.coordinatorEpoch },
		executionIdentity: adjudication.executionIdentity,
		sessionId: adjudication.sessionId,
		verdictArtifactRef: adjudication.verdictArtifactRef,
		verdictDigest: adjudication.verdictDigest,
	});
	const receipt = createFixtureHostReceipt({
		receiptKind: "adjudication",
		oneUse: true,
		receiptId: "forged-adjudication",
		issuerId: "decision-host",
		workflowId: "wf-1",
		bindingDigest,
		payloadDigest: adjudication.verdictDigest,
		artifactRef: adjudication.verdictArtifactRef,
		issuedAt: NOW,
		validUntil: EXPIRES_AT,
		keyId: "decision-host-key",
		stateDigest: "state",
		revision: gated.revision,
	});
	const forged = {
		...gated,
		hostAdjudication: { ...adjudication, operationDigest, hostReceipt: receipt },
	};
	await expect(fixture.gate.authorize(forged, fixture.operation)).resolves.toBe("rejected");
});

it("does not replay the same gated decision twice", async () => {
	const fixture = await createGateFixture();
	const gated = await fixture.gate.runFreshSixStageGate(
		fixture.decision,
		fixture.operation,
		"state",
		fixture.stageRunner,
	);
	await expect(fixture.gate.authorize(gated, fixture.operation)).resolves.toBe("awaiting_user");
	await expect(fixture.gate.authorize(gated, fixture.operation)).resolves.toBe("rejected");
});

it("rejects reused stage output identity without mutating the input decision", async () => {
	const fixture = await createGateFixture();
	let firstObservation: WorkflowStageObservation | null = null;
	const reusedRunner: FreshStageRunner = {
		run: async (input) => {
			firstObservation ??= await fixture.stageRunner.run(input);
			return firstObservation;
		},
	};
	await expect(
		fixture.gate.runFreshSixStageGate(fixture.decision, fixture.operation, "state", reusedRunner),
	).rejects.toThrow(/identity|fresh|bound/i);
	expect(fixture.decision.stageVerdicts).toHaveLength(0);
	expect(fixture.reservationStore.released).toHaveLength(1);
});

it("returns a conflict for an overlapping current write-set", async () => {
	const fixture = await createGateFixture();
	const gated = await fixture.gate.runFreshSixStageGate(
		fixture.decision,
		fixture.operation,
		"state",
		fixture.stageRunner,
	);
	fixture.context.overlappingWriteSets = [["session_projection"]];
	await expect(fixture.gate.authorize(gated, fixture.operation)).resolves.toBe("conflicted");
});
