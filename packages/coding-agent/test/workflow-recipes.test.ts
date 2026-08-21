import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	sha256Hex,
	type WorkflowControlCapacityVector,
	type WorkflowEvidenceEnvelope,
	type WorkflowResourceVector,
	type WorkflowTask,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import {
	BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST,
	BUILTIN_COMPREHENSIVE_RECIPE,
	BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM,
	BUILTIN_SUPERPOWERS_METHODOLOGY_MAPPING,
	BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
	COMPREHENSIVE_BRANCH_CHARTERS,
	compileWorkflowRecipe as compileWorkflowRecipeImpl,
	consumeWorkflowRecipeAdmission,
	consumeWorkflowRecipeAdmissionAtHost,
	createWorkflowRecipeRegisteredManifest,
	DEFAULT_WORKFLOW_RECIPE_REGISTRY,
	type EvidencePolicy,
	type GateSpec,
	getWorkflowRecipeSuperpowersCatalogDigests,
	resolveWorkflowRecipe,
	type StageSpec,
	verifyWorkflowRecipeAdmissionForTask,
	WORKFLOW_RECIPE_CANONICAL_NATIVE_CAPABILITY_SNAPSHOTS,
	WORKFLOW_RECIPE_CANONICAL_SUPERPOWERS_SKILL_SNAPSHOTS,
	WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
	WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_KINDS,
	WORKFLOW_RECIPE_INTENT_TDD_FORBIDDEN_OUTCOMES,
	WORKFLOW_RECIPE_INTENT_TDD_GATE_ID,
	WORKFLOW_RECIPE_INTENT_TDD_PROMOTION_CONSTRAINTS,
	WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
	WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID,
	WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID,
	type WorkflowRecipeEvidenceBinding,
	type WorkflowRecipeHostResolutionPort,
	type WorkflowRecipeIntentTddGateBinding,
	type WorkflowRecipeOpaqueHoldout,
	type WorkflowRecipeOverfittingGateReceiptPayload,
	type WorkflowRecipeProposal,
	type WorkflowRecipeReceiptConsumptionWitness,
	type WorkflowRecipeUniversalGateBinding,
	type WorkflowRecipeVerifiedHostReceipt,
	type WorkflowTaskGraphContext,
} from "../src/core/workflow/recipes.js";
import { validateWorkflowTaskGraph } from "../src/core/workflow/task-graph.js";

const resourceVector: WorkflowResourceVector = {
	cpuMilliCores: 1,
	memoryBytes: 1,
	diskBytes: 1,
	ioWeight: 1,
	accelerators: [],
	providers: [],
	networkEgressBytes: 0,
	wallMilliseconds: 1,
	monetaryMicrounits: 0,
};

const controlCapacity: WorkflowControlCapacityVector = {
	processSlots: 0,
	childSessionSlots: 0,
	modelCallSlots: 0,
	modelInputTokens: 0,
	modelOutputTokens: 0,
	verificationSlots: 0,
	redTeamSlots: 0,
	recoverySlots: 0,
};

function task(taskId: string, dependencyTaskIds: readonly string[] = []): WorkflowTask {
	return {
		taskId,
		planRevision: 1,
		objective: taskId,
		requirementIds: [],
		completionCriteria: [],
		dependencyTaskIds,
		ownedPaths: [`src/${taskId}.ts`],
		ownedContracts: [],
		requiredSkillSnapshotDigests: [],
		verificationCommandDigests: [],
		authority: ["read_workspace"],
		declaredResourceVector: resourceVector,
		declaredControlCapacity: controlCapacity,
		status: "ready",
		attemptIds: [],
	};
}

function graphContext(): WorkflowTaskGraphContext {
	return {
		knownSkillSnapshotDigests: [],
		allowedAuthority: ["read_workspace"],
		workspacePaths: ["src"],
		generatedOutputPaths: ["artifacts/out"],
		namedContracts: [],
	};
}

function freezePersisted<T>(value: T, seen = new Set<object>()): T {
	if (typeof value !== "object" || value === null || seen.has(value)) return value;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		const child = (value as Record<PropertyKey, unknown>)[key];
		freezePersisted(child, seen);
	}
	return Object.freeze(value);
}

function forgeAdmissionWithReusedRegistrationSignature(
	compiled: ReturnType<typeof compileWorkflowRecipeImpl>,
	mutate: (admission: ReturnType<typeof compileWorkflowRecipeImpl>["admission"]) => void,
): ReturnType<typeof compileWorkflowRecipeImpl>["admission"] {
	const forged = structuredClone(compiled.admission);
	mutate(forged);
	forged.recipeDigest = digestObject(forged.recipeBinding);
	if (forged.registrationReceipt === undefined || forged.registrationReceiptProof === undefined)
		throw new Error("fixture registration receipt is missing");
	forged.registrationReceipt.payload.recipeDigest = forged.recipeDigest;
	forged.registrationReceipt.receipt.payloadDigest = digestObject(forged.registrationReceipt.payload);
	const registrationBindingDigest = digestObject({
		kind: "workflow-recipe-receipt-binding",
		receiptKind: "recipe_registration",
		workflowId: forged.workflowId,
		recipeId: forged.recipeId,
		revision: forged.revision,
		registryManifestDigest: forged.registryManifestDigest,
		hostKeyId: forged.registrationReceipt.receipt.keyId,
		epochRef: forged.hostEpochRef,
		headDigest: forged.hostHeadDigest,
		currentDecisionDigest: forged.hostDecisionDigest,
		contextDigest: forged.hostContextDigest,
		payloadDigest: forged.registrationReceipt.receipt.payloadDigest,
	});
	forged.registrationReceipt.receipt.bindingDigest = registrationBindingDigest;
	forged.registrationReceipt.consumptionWitness.bindingDigest = registrationBindingDigest;
	forged.registrationReceiptProof.bindingDigest = registrationBindingDigest;
	forged.registrationReceiptProof.witnessDigest = digestObject(forged.registrationReceipt.consumptionWitness);
	forged.registrationReceipt.receipt.verificationDigest = digestObject({
		...forged.registrationReceipt.receipt,
		verificationDigest: "",
	});
	forged.registrationReceiptDigest = forged.registrationReceipt.receipt.verificationDigest;
	forged.registrationReceiptProof.receiptDigest = digestObject(forged.registrationReceipt.receipt);
	const { admissionDigest: _admissionDigest, ...withoutAdmissionDigest } = forged;
	forged.admissionDigest = digestObject(withoutAdmissionDigest);
	return freezePersisted(forged);
}

function hostPort(
	recipeId = "recipe-1",
	revision = 1,
	holdoutRef = "holdout-handle",
	stageIds: readonly string[] = ["recon", "lens", "verify", "synthesize", "red-team"],
	durableRoot?: string,
): WorkflowRecipeHostResolutionPort {
	const pathBoundary = {
		descriptorKind: "host_workspace_descriptor" as const,
		effectBoundaryKind: "host_effect_boundary" as const,
		descriptorDigest: "host-workspace-descriptor",
		effectBoundaryDigest: "host-effect-boundary",
		workspacePaths: ["src"],
		generatedOutputPaths: ["artifacts/out"],
	};
	const baseReceiptContext = createFixtureHostReceiptConsumerContext();
	const consumedAdmissionIds = new Set<string>();
	const reviewerPrincipalDigests = [
		digestObject({ kind: "adversarial-reviewer", stageId: "adversarial-review", workflowId: "workflow-1" }),
		digestObject({
			kind: "independent-reviewer",
			stageId: "independent-verification",
			workflowId: "workflow-1",
		}),
	].sort();
	const contextBase = {
		authorityId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID as "prime-workflow-host-authority",
		hostKeyId: "fixture-key",
		workflowId: "workflow-1",
		registryManifestDigest: DEFAULT_WORKFLOW_RECIPE_REGISTRY.manifestDigest,
		epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
		currentDecisionDigest: "current-decision",
		headDigest: "a".repeat(64),
		issuedAt: "2026-01-01T00:00:00.000Z",
		validUntil: "2026-01-02T00:00:00.000Z",
		pathBoundaryDigest: digestObject(pathBoundary),
		reviewerPrincipalDigests,
	};
	const stableReceiptSequence = (receiptId: string): number => {
		if (receiptId.startsWith("recipe-registration-")) return 1;
		const validationIndex = WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.findIndex(
			(stageId) => receiptId === `tdd-validation-${stageId}`,
		);
		if (validationIndex >= 0) return validationIndex + 1;
		const processIndex = WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.findIndex(
			(stageId) => receiptId === `tdd-process-${stageId}`,
		);
		if (processIndex >= 0) return processIndex + 101;
		return 1;
	};
	const durableWitnessPath = (receiptId: string): string | null =>
		durableRoot === undefined ? null : join(durableRoot, `receipt-${sha256Hex(receiptId)}.json`);
	const readDurableWitness = (receiptId: string): WorkflowRecipeReceiptConsumptionWitness | null => {
		const path = durableWitnessPath(receiptId);
		if (path === null || !existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf8")) as WorkflowRecipeReceiptConsumptionWitness;
	};
	const persistDurableWitness = (witness: WorkflowRecipeReceiptConsumptionWitness): void => {
		const path = durableWitnessPath(witness.receiptId);
		if (path !== null) writeFileSync(path, JSON.stringify(witness), "utf8");
	};
	const receiptContext = {
		...baseReceiptContext,
		keyResolver: {
			resolve: async (keyId: string) => ({
				...(await baseReceiptContext.keyResolver.resolve(keyId)),
				ownerPrincipal: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
			}),
		},
		receiptResolver: {
			...baseReceiptContext.receiptResolver,
			consumeIfOneUse: async (
				input: Parameters<typeof baseReceiptContext.receiptResolver.consumeIfOneUse>[0],
			): Promise<void> => {
				const existing = readDurableWitness(input.receipt.receiptId);
				if (existing !== null) return;
				await baseReceiptContext.receiptResolver.consumeIfOneUse(input);
				const witness = await baseReceiptContext.receiptResolver.resolveConsumptionWitness({
					receiptId: input.receipt.receiptId,
					workflowId: input.workflowId,
					expectedBindingDigest: input.expectedBindingDigest,
				});
				persistDurableWitness({
					...witness,
					headDigest: contextBase.headDigest,
					consumedAt: contextBase.issuedAt,
					consumptionSequence: stableReceiptSequence(input.receipt.receiptId),
				});
			},
			resolveConsumptionWitness: async (
				input: Parameters<typeof baseReceiptContext.receiptResolver.resolveConsumptionWitness>[0],
			): Promise<WorkflowRecipeReceiptConsumptionWitness> => {
				const durable = readDurableWitness(input.receiptId);
				if (durable !== null) return durable;
				const witness = await baseReceiptContext.receiptResolver.resolveConsumptionWitness(input);
				return {
					...witness,
					headDigest: contextBase.headDigest,
					consumedAt: contextBase.issuedAt,
					consumptionSequence: stableReceiptSequence(input.receiptId),
				};
			},
		},
	};
	if (durableRoot !== undefined) mkdirSync(durableRoot, { recursive: true });
	const admissionMarkerPath = (admissionDigest: string): string | null =>
		durableRoot === undefined ? null : join(durableRoot, `admission-${sha256Hex(admissionDigest)}.json`);
	const admissionLockPath = (admissionDigest: string): string | null =>
		durableRoot === undefined ? null : join(durableRoot, `admission-${sha256Hex(admissionDigest)}.lock`);
	const withAdmissionLock = async <T>(admissionDigest: string, operation: () => Promise<T>): Promise<T> => {
		const lockPath = admissionLockPath(admissionDigest);
		if (lockPath === null) return operation();
		while (true) {
			try {
				mkdirSync(lockPath);
				break;
			} catch {
				await new Promise<void>((resolve) => setTimeout(resolve, 1));
			}
		}
		try {
			return await operation();
		} finally {
			rmSync(lockPath, { recursive: true, force: true });
		}
	};
	const authenticatedReceiptResolver = {
		verifyConsumedReceipt: (input: {
			receipt: WorkflowVerifiedHostReceipt;
			consumptionWitness: WorkflowRecipeReceiptConsumptionWitness;
			workflowId: string;
			expectedBindingDigest: string;
			currentHeadDigest: string;
			currentEpochRef: { storeEpoch: number; coordinatorEpoch: number };
			currentDecisionDigest: string;
			hostKeyId: string;
			expectedAdmissionPreimageDigest?: string;
		}) => ({
			proofKind: "ed25519-one-use" as const,
			authorityId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID as "prime-workflow-host-authority",
			receiptDigest: digestObject(input.receipt),
			witnessDigest: digestObject(input.consumptionWitness),
			workflowId: input.workflowId,
			hostKeyId: input.hostKeyId,
			bindingDigest: input.expectedBindingDigest,
			currentHeadDigest: input.currentHeadDigest,
			currentDecisionDigest: input.currentDecisionDigest,
			currentEpochRef: input.currentEpochRef,
			consumptionSequence: input.consumptionWitness.consumptionSequence,
			signatureVerified: true as const,
			signatureDigest: sha256Hex(input.receipt.signature),
			artifactBytesDigest: input.receipt.artifactRef.digest,
			artifactSizeBytes: input.receipt.artifactRef.sizeBytes,
			artifactImmutable: true as const,
			oneUseConsumed: true as const,
			...(input.expectedAdmissionPreimageDigest === undefined
				? {}
				: {
						admissionPreimageDigest: input.expectedAdmissionPreimageDigest,
						signedReceiptPreimageDigest: (() => {
							const {
								signature: _signature,
								verificationDigest: _verificationDigest,
								...signedFields
							} = input.receipt;
							return digestObject(signedFields);
						})(),
					}),
		}),
		consumeAdmissionAtHost: (input: {
			admission: ReturnType<typeof compileWorkflowRecipeImpl>["admission"];
			registration: NonNullable<ReturnType<typeof compileWorkflowRecipeImpl>["admission"]["registrationReceipt"]>;
			expectedBindingDigest: string;
			expectedAdmissionPreimageDigest: string;
			workflowId: string;
			currentHeadDigest: string;
			currentDecisionDigest: string;
			currentEpochRef: { storeEpoch: number; coordinatorEpoch: number };
			currentRevision: number;
			consumer: () => void;
		}) =>
			withAdmissionLock(input.admission.admissionDigest, async () => {
				const artifact = await receiptContext.artifactResolver.resolve(input.registration.receipt.artifactRef);
				const resolvedReceipt = await receiptContext.receiptResolver.resolve({
					receipt: input.registration.receipt,
					workflowId: input.workflowId,
					expectedBindingDigest: input.expectedBindingDigest,
					artifactBytes: artifact.bytes,
					currentStateDigest: input.currentHeadDigest,
					currentRevision: input.currentRevision,
					trustedNow: contextBase.issuedAt,
					keyResolver: receiptContext.keyResolver,
					revokedReceiptIds: receiptContext.revokedReceiptIds,
				});
				let witness: WorkflowRecipeReceiptConsumptionWitness;
				try {
					const resolvedWitness = await receiptContext.receiptResolver.resolveConsumptionWitness({
						receiptId: resolvedReceipt.receiptId,
						workflowId: input.workflowId,
						expectedBindingDigest: input.expectedBindingDigest,
					});
					witness = { ...resolvedWitness, headDigest: input.currentHeadDigest };
				} catch {
					await receiptContext.receiptResolver.consumeIfOneUse({
						receipt: resolvedReceipt,
						workflowId: input.workflowId,
						expectedBindingDigest: input.expectedBindingDigest,
						currentRevision: input.currentRevision,
					});
					const resolvedWitness = await receiptContext.receiptResolver.resolveConsumptionWitness({
						receiptId: resolvedReceipt.receiptId,
						workflowId: input.workflowId,
						expectedBindingDigest: input.expectedBindingDigest,
					});
					witness = { ...resolvedWitness, headDigest: input.currentHeadDigest };
				}
				const proof = authenticatedReceiptResolver.verifyConsumedReceipt({
					receipt: resolvedReceipt,
					consumptionWitness: witness,
					workflowId: input.workflowId,
					expectedBindingDigest: input.expectedBindingDigest,
					currentHeadDigest: input.currentHeadDigest,
					currentEpochRef: input.currentEpochRef,
					currentDecisionDigest: input.currentDecisionDigest,
					hostKeyId: contextBase.hostKeyId,
					expectedAdmissionPreimageDigest: input.expectedAdmissionPreimageDigest,
				});
				if (
					proof === null ||
					proof.admissionPreimageDigest === undefined ||
					proof.signedReceiptPreimageDigest === undefined
				)
					throw new Error("fixture admission proof missing admission anchors");
				const admissionPreimageDigest = proof.admissionPreimageDigest;
				const signedReceiptPreimageDigest = proof.signedReceiptPreimageDigest;
				const admissionProof = { ...proof, admissionPreimageDigest, signedReceiptPreimageDigest };
				const markerPath = admissionMarkerPath(input.admission.admissionDigest);
				const status: "already_consumed" | "consumed" =
					consumedAdmissionIds.has(input.admission.admissionDigest) ||
					(markerPath !== null && existsSync(markerPath))
						? "already_consumed"
						: "consumed";
				if (status === "consumed") {
					if (markerPath !== null)
						writeFileSync(
							markerPath,
							JSON.stringify({
								admissionDigest: input.admission.admissionDigest,
								registrationReceiptDigest: digestObject(resolvedReceipt),
								witnessDigest: digestObject(witness),
								proofDigest: digestObject(admissionProof),
							}),
							"utf8",
						);
					consumedAdmissionIds.add(input.admission.admissionDigest);
					input.consumer();
				}
				return {
					status,
					registration: {
						receipt: resolvedReceipt,
						payload: input.registration.payload,
						consumptionWitness: witness,
					},
					proof: admissionProof,
				};
			}),
	};
	const context = {
		...contextBase,
		contextDigest: digestObject({ kind: "workflow-recipe-host-context", ...contextBase }),
		receiptContext,
		authenticatedReceiptResolver,
	};
	const opaqueHoldout: WorkflowRecipeOpaqueHoldout = {
		handleId: holdoutRef,
		manifestDigest: "holdout-manifest",
		resolverContextId: "holdout-resolver",
		authorizationReceiptDigest: "holdout-authorization",
		owner: "host" as const,
		hidden: true as const,
		opaque: true as const,
		hostResolverOnly: true as const,
		authenticated: true as const,
		returnsEvidenceOnly: true as const,
		returnsBytes: false as const,
	};
	const universalGate: WorkflowRecipeUniversalGateBinding = {
		gateId: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID,
		stageIds: ["recon", "lens", "verify", "synthesize", "red-team"] as const,
		decisionDigest: "current-decision",
		scorecardDigest: "scorecard",
		evaluatorDigest: "evaluator",
		terminal: true as const,
		hostOwned: true as const,
	};
	const overfittingGate: WorkflowRecipeOverfittingGateReceiptPayload = {
		gateId: WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID,
		blocking: true as const,
		freshnessDigest: "freshness",
		reviewerResultDigest: "review-result",
		authenticatedReviewer: true as const,
		opaqueHoldoutManifestDigest: "holdout-manifest",
		opaqueHoldoutEvidenceDigest: "holdout-evidence",
	};
	const intentTddGate: WorkflowRecipeIntentTddGateBinding = {
		gateId: WORKFLOW_RECIPE_INTENT_TDD_GATE_ID,
		stageIds: WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
		evidenceKinds: WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_KINDS,
		blocking: true as const,
		hostOwned: true as const,
		evidenceRequirements: WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.map((stageId, index) => ({
			stageId,
			evidenceKind: WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_KINDS[index],
			requiredClaims:
				index === 0
					? ["intent", "forbidden_outcomes"]
					: index === 1
						? ["public_boundary", "observed_failure", "forbidden_outcomes"]
						: index === 2
							? ["candidate_sha", "green_result"]
							: index === 3
								? ["candidate_sha", "integration_sha", "durability_or_authority_receipt"]
								: index === 4
									? ["candidate_sha", "metamorphic", "race", "mutation", "anti_cheating"]
									: index === 5
										? ["candidate_sha", "reviewed_head"]
										: [
												"candidate_sha",
												"integration_sha",
												"reviewed_head",
												"no_base_merge",
												"worktree_decision",
											],
		})),
		promotionConstraints: WORKFLOW_RECIPE_INTENT_TDD_PROMOTION_CONSTRAINTS,
	};
	return {
		registryManifestDigest: DEFAULT_WORKFLOW_RECIPE_REGISTRY.manifestDigest,
		pathBoundary,
		context,
		nativeCapabilitySnapshots: WORKFLOW_RECIPE_CANONICAL_NATIVE_CAPABILITY_SNAPSHOTS.map((snapshot) => ({
			...snapshot,
			immutable: true as const,
			builtIn: true as const,
		})),
		nativeCapabilitySnapshotReceipts: WORKFLOW_RECIPE_CANONICAL_NATIVE_CAPABILITY_SNAPSHOTS.map((snapshot) =>
			makeRecipeReceipt(context, recipeId, revision, "native_capability_snapshot", {
				...snapshot,
				immutable: true as const,
				builtIn: true as const,
			}),
		),
		superpowersSkillSnapshots: WORKFLOW_RECIPE_CANONICAL_SUPERPOWERS_SKILL_SNAPSHOTS.map((snapshot) => ({
			...snapshot,
			immutable: true as const,
			vendored: true as const,
		})),
		superpowersSkillSnapshotReceipts: WORKFLOW_RECIPE_CANONICAL_SUPERPOWERS_SKILL_SNAPSHOTS.map((snapshot) =>
			makeRecipeReceipt(context, recipeId, revision, "superpowers_skill_snapshot", {
				...snapshot,
				immutable: true as const,
				vendored: true as const,
			}),
		),
		opaqueHoldoutReceipt: makeRecipeReceipt(context, recipeId, revision, "opaque_holdout", opaqueHoldout),
		universalGateReceipt: makeRecipeReceipt(context, recipeId, revision, "universal_gate", {
			...universalGate,
			stageIds,
		}),
		overfittingGateReceipt: makeRecipeReceipt(context, recipeId, revision, "overfitting_gate", overfittingGate),
		intentTddGateReceipt: makeRecipeReceipt(context, recipeId, revision, "intent_tdd_gate", intentTddGate),
	};
}

function makeRecipeReceipt<TPayload>(
	context: WorkflowRecipeHostResolutionPort["context"],
	recipeId: string,
	revision: number,
	kind: string,
	payload: TPayload,
): WorkflowRecipeVerifiedHostReceipt<TPayload> {
	const receiptKind: WorkflowVerifiedHostReceipt["receiptKind"] =
		kind === "opaque_holdout" || kind === "intent_tdd_gate"
			? "capability"
			: kind === "universal_gate"
				? "decision"
				: kind === "overfitting_gate"
					? "adjudication"
					: "artifact";
	const payloadDigest = digestObject(payload);
	const bindingDigest = digestObject({
		kind: "workflow-recipe-receipt-binding",
		receiptKind: kind,
		workflowId: context.workflowId,
		recipeId,
		revision,
		registryManifestDigest: context.registryManifestDigest,
		hostKeyId: context.hostKeyId,
		epochRef: context.epochRef,
		headDigest: context.headDigest,
		currentDecisionDigest: context.currentDecisionDigest,
		contextDigest: context.contextDigest,
		payloadDigest,
	});
	const receipt = createFixtureHostReceipt({
		receiptKind,
		receiptId: `${kind}-${recipeId}-${revision}`,
		issuerId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
		workflowId: context.workflowId,
		bindingDigest,
		payloadDigest,
		artifactRef: {
			artifactId: `recipe-${kind}`,
			relativePath: `artifacts/evidence/${kind}.json`,
			digest: "b".repeat(64),
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		issuedAt: context.issuedAt,
		validUntil: context.validUntil,
		keyId: "fixture-key",
		stateDigest: context.headDigest,
		revision,
		oneUse: true,
	});
	return {
		receipt,
		payload,
		consumptionWitness: recipeConsumptionWitness(receipt, context.headDigest, context.issuedAt, 1),
	};
}

function recipeConsumptionWitness(
	receipt: WorkflowVerifiedHostReceipt,
	headDigest: string,
	consumedAt: string,
	consumptionSequence: number,
): WorkflowRecipeReceiptConsumptionWitness {
	return {
		receiptId: receipt.receiptId,
		workflowId: receipt.workflowId,
		bindingDigest: receipt.bindingDigest,
		capability: receipt.capabilityBinding?.capability ?? null,
		resourceDigest: receipt.capabilityBinding?.resourceDigest ?? null,
		operationDigest: receipt.capabilityBinding?.operationDigest ?? null,
		receiptDigest: digestObject(receipt),
		headDigest,
		consumedAt,
		consumptionSequence,
	};
}

type IntentTddGitRepo = {
	readonly root: string;
	readonly integrationSha: string;
	readonly baseSha: string;
	readonly candidateSha: string;
	readonly reviewedHeadSha: string;
};

// The intent-TDD gate validates evidence against the Git repository the process is standing in, so
// this fixture builds the exact four-commit shape the gate requires in a throwaway repository
// instead of reading whichever commits this checkout happens to sit on. Ignoring the ambient Git
// config and passing an explicit identity keep it working where Git identity is unset or empty.
let intentTddGitRepoCache: IntentTddGitRepo | null = null;

function intentTddGitRepo(): IntentTddGitRepo {
	if (intentTddGitRepoCache !== null) return intentTddGitRepoCache;
	const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-recipe-intent-tdd-")));
	const git = (...args: readonly string[]): string =>
		execFileSync("git", [...args], {
			cwd: root,
			encoding: "utf8",
			input: "",
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_AUTHOR_NAME: "intent-tdd-fixture",
				GIT_AUTHOR_EMAIL: "intent-tdd-fixture@invalid",
				GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
				GIT_COMMITTER_NAME: "intent-tdd-fixture",
				GIT_COMMITTER_EMAIL: "intent-tdd-fixture@invalid",
				GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
			},
		}).trim();
	git("init", "--quiet");
	const emptyTree = git("mktree");
	const commit = (message: string, parent: string | null): string =>
		git("commit-tree", emptyTree, ...(parent === null ? [] : ["-p", parent]), "-m", message);
	const integrationSha = commit("integration", null);
	const baseSha = commit("base", integrationSha);
	const candidateSha = commit("candidate", baseSha);
	const reviewedHeadSha = commit("reviewed-head", candidateSha);
	git("update-ref", "refs/heads/main", reviewedHeadSha);
	git("symbolic-ref", "HEAD", "refs/heads/main");
	intentTddGitRepoCache = { root, integrationSha, baseSha, candidateSha, reviewedHeadSha };
	return intentTddGitRepoCache;
}

afterAll(() => {
	if (intentTddGitRepoCache === null) return;
	rmSync(intentTddGitRepoCache.root, { recursive: true, force: true });
	intentTddGitRepoCache = null;
});

function implementationEvidence(
	host: WorkflowRecipeHostResolutionPort,
	worktreeDecision: "isolated" | "shared-safe" = "shared-safe",
): readonly WorkflowRecipeEvidenceBinding[] {
	const requiredClaimsByStage = [
		["intent", "forbidden_outcomes"],
		["public_boundary", "observed_failure", "forbidden_outcomes"],
		["candidate_sha", "green_result"],
		["candidate_sha", "integration_sha", "durability_or_authority_receipt"],
		["candidate_sha", "metamorphic", "race", "mutation", "anti_cheating"],
		["candidate_sha", "reviewed_head"],
		["candidate_sha", "integration_sha", "reviewed_head", "no_base_merge", "worktree_decision"],
	] as const;
	const repo = intentTddGitRepo();
	// The gate resolves Git from process.cwd(), so the process itself has to stand in the throwaway
	// repository while the recipe compiles. This needs Vitest's forks pool (the default); under
	// `pool: "threads"` process.chdir throws and these tests fail loudly rather than silently.
	const previousCwd = process.cwd();
	process.chdir(repo.root);
	onTestFinished(() => process.chdir(previousCwd));
	const worktreeRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: repo.root,
		encoding: "utf8",
	}).trim();
	const worktreeStatus = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
		cwd: repo.root,
		encoding: "utf8",
	}).trim();
	const outOfScopePaths = [
		...new Set(
			(worktreeStatus.length === 0 ? [] : worktreeStatus.split("\n")).flatMap((line) => {
				const pathText = line.slice(3);
				return pathText.includes(" -> ") ? pathText.split(" -> ") : [pathText];
			}),
		),
	].sort();
	const worktreeStatusDigest = sha256Hex(worktreeStatus);
	const { baseSha, candidateSha, integrationSha, reviewedHeadSha } = repo;
	return WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.map((stageId, index) => {
		const stage = BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.stages.find(
			(candidate) => candidate.id === stageId,
		);
		const stageTask = implementationTasks().find((candidate) => candidate.taskId === stageId);
		if (stage === undefined || stageTask === undefined) throw new Error(`missing TDD fixture stage ${stageId}`);
		const intentBinding = {
			goalDigest: digestObject({
				kind: "intent-tdd-goal",
				recipeId: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
				revision: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
				stageId,
				taskId: stageTask.taskId,
				objective: stageTask.objective,
			}),
			requirementDigest: digestObject({
				kind: "intent-tdd-requirement",
				stageId,
				taskId: stageTask.taskId,
				evidencePolicyId: stage.evidencePolicyId,
				evidenceKind: WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_KINDS[index],
				requiredClaims: requiredClaimsByStage[index],
				requirementIds: stageTask.requirementIds,
				completionCriteria: stageTask.completionCriteria,
			}),
			forbiddenOutcomeDigest: digestObject({
				kind: "intent-tdd-forbidden-outcomes",
				stageId,
				outcomes: WORKFLOW_RECIPE_INTENT_TDD_FORBIDDEN_OUTCOMES[stageId],
			}),
		};
		const output = index === 1 ? { stdout: "", stderr: "expected boundary failure" } : { stdout: "ok", stderr: "" };
		const artifactInput = {
			artifactId: `tdd-${stageId}`,
			relativePath: `artifacts/evidence/tdd-${stageId}.json`,
			digest: "0".repeat(64),
			sizeBytes: 1,
			sourceEventSequence: index + 1,
		};
		const artifactReceipt = createFixtureHostReceipt({
			receiptKind: "artifact",
			receiptId: `tdd-artifact-${stageId}`,
			issuerId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
			workflowId: host.context.workflowId,
			bindingDigest: `tdd-binding-${stageId}`,
			payloadDigest: "placeholder",
			artifactRef: artifactInput,
			issuedAt: host.context.issuedAt,
			validUntil: host.context.validUntil,
			keyId: "fixture-key",
			stateDigest: host.context.headDigest,
			revision: 1,
			oneUse: true,
		});
		const artifactRef = artifactReceipt.artifactRef;
		const reviewerRole = index === 5 ? "independent" : index === 6 ? "adversarial" : null;
		const reviewerIdentityDigest =
			reviewerRole === null
				? null
				: digestObject({ kind: `${reviewerRole}-reviewer`, stageId, workflowId: host.context.workflowId });
		const envelope: WorkflowEvidenceEnvelope = {
			evidenceId: `tdd-evidence-${stageId}`,
			evidenceRevision: 1,
			requirementId: stageId,
			claim:
				index === 0
					? "intent and forbidden user outcomes are explicit"
					: index === 1
						? "public boundary observed the forbidden outcome failure"
						: index === 2
							? "candidate SHA produced the green implementation result"
							: index === 3
								? "candidate SHA integration preserves durability and authority receipt behavior"
								: index === 4
									? "candidate SHA passed metamorphic race mutation and anti-cheating checks"
									: index === 5
										? "candidate SHA was independently verified at the reviewed head"
										: "candidate and integration SHAs passed adversarial review with reviewed head, no base merge, and worktree decision",
			result:
				index === 1
					? "observed-failure"
					: index === 0
						? "intent-recorded"
						: index === 2
							? "green-result"
							: index === 3
								? "real-integration"
								: index === 4
									? "metamorphic-race-mutation-anti-cheating"
									: index === 5
										? "independent-verification"
										: "adversarial-review",
			method:
				index === 0
					? "intent-contract"
					: index === 1
						? "black-box-public-boundary"
						: index >= 3
							? "host-observed-integration"
							: "host-observed-candidate",
			command: {
				commandDigest: digestObject({ stageId, index }),
				exitState: "exited",
				exitCode: index === 1 ? 1 : 0,
				signal: null,
				stdout: output.stdout,
				stderr: output.stderr,
				stdoutBytes: output.stdout.length,
				stderrBytes: output.stderr.length,
				outputDigest: digestObject(output),
				outputTruncated: false,
			},
			artifactObservations: [
				{
					artifactRef,
					exists: true,
					verifiedDigest: artifactRef.digest,
					verifiedSizeBytes: artifactRef.sizeBytes,
				},
			],
			scanner: {
				scannerDigest: "tdd-scanner",
				scanStatus: "passed",
				redactionStatus: "not_required",
				findingCodes: [],
				findingDigest: "tdd-findings",
			},
			confidence: "high",
			limitations: [],
			workspaceDigest: "tdd-workspace",
			configDigest: "tdd-config",
			revisions: {
				contractRevision: 1,
				scorecardRevision: 1,
				planRevision: 1,
				configRevision: 1,
				evidenceRevision: 1,
			},
			evaluatorDigest: "tdd-evaluator",
			parserDigest: "tdd-parser",
			guardDigest: "tdd-guard",
			updatedDigest: "tdd-updated",
			invalidatedByDecisionRef: null,
			regressed: false,
			auditorDecisionRef: null,
			observedAt: host.context.issuedAt,
			freshUntil: host.context.validUntil,
			freshnessWindowMilliseconds: 86_400_000,
		};
		if (envelope.command === null) throw new Error(`missing process command for ${stageId}`);
		const processCommandDigest = digestObject(envelope.command);
		const processReceipt = createFixtureHostReceipt({
			receiptKind: "artifact",
			receiptId: `tdd-process-${stageId}`,
			issuerId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
			workflowId: host.context.workflowId,
			bindingDigest: digestObject({
				kind: "workflow-recipe-receipt-binding",
				receiptKind: "process_evidence",
				workflowId: host.context.workflowId,
				recipeId: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
				revision: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
				registryManifestDigest: host.context.registryManifestDigest,
				hostKeyId: host.context.hostKeyId,
				epochRef: host.context.epochRef,
				headDigest: host.context.headDigest,
				currentDecisionDigest: host.context.currentDecisionDigest,
				contextDigest: host.context.contextDigest,
				payloadDigest: processCommandDigest,
				metadataDigest: digestObject({ stageId, commandDigest: processCommandDigest }),
			}),
			payloadDigest: processCommandDigest,
			artifactRef,
			issuedAt: host.context.issuedAt,
			validUntil: host.context.validUntil,
			keyId: "fixture-key",
			stateDigest: host.context.headDigest,
			revision: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
			oneUse: true,
		});
		const processReceiptBinding: WorkflowRecipeEvidenceBinding["processReceipt"] = {
			receipt: processReceipt,
			payload: envelope.command,
			consumptionWitness: recipeConsumptionWitness(
				processReceipt,
				host.context.headDigest,
				host.context.issuedAt,
				index + 101,
			),
		};
		const trustedClockReceipt = createFixtureHostReceipt({
			receiptKind: "clock",
			receiptId: `tdd-clock-${stageId}`,
			issuerId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
			workflowId: host.context.workflowId,
			bindingDigest: digestObject({
				evidenceId: envelope.evidenceId,
				workspaceDigest: envelope.workspaceDigest,
				configDigest: envelope.configDigest,
				revisions: envelope.revisions,
			}),
			payloadDigest: digestObject({ kind: "tdd-trusted-clock", stageId }),
			artifactRef,
			issuedAt: host.context.issuedAt,
			validUntil: host.context.validUntil,
			keyId: "fixture-key",
			stateDigest: host.context.headDigest,
			revision: 1,
			oneUse: true,
		});
		const validationReceipt = createFixtureHostReceipt({
			receiptKind: "artifact",
			receiptId: `tdd-validation-${stageId}`,
			issuerId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
			workflowId: host.context.workflowId,
			bindingDigest: digestObject({
				kind: "workflow-recipe-receipt-binding",
				receiptKind: "tdd_evidence",
				workflowId: host.context.workflowId,
				recipeId: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
				revision: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
				registryManifestDigest: host.context.registryManifestDigest,
				hostKeyId: host.context.hostKeyId,
				epochRef: host.context.epochRef,
				headDigest: host.context.headDigest,
				currentDecisionDigest: host.context.currentDecisionDigest,
				contextDigest: host.context.contextDigest,
				payloadDigest: digestObject(envelope),
				metadataDigest: digestObject({
					stageId,
					intentBinding,
					processReceiptDigest: digestObject(processReceiptBinding),
					trustedClockReceiptDigest: digestObject(trustedClockReceipt),
					baseSha,
					preCandidateSha: baseSha,
					candidateSha,
					integrationSha: index >= 3 ? integrationSha : null,
					reviewedHeadSha,
					ancestorShas:
						index >= 3
							? [candidateSha, baseSha, integrationSha, reviewedHeadSha]
							: [candidateSha, baseSha, reviewedHeadSha],
					baseAncestorShas: index >= 3 ? [baseSha, integrationSha] : [baseSha],
					noBaseMerge: true,
					worktreeDecision,
					worktreeRoot,
					worktreeStatusDigest,
					outOfScopePaths,
					reviewerIdentityDigest,
					reviewerRole,
					attackResultArtifactRef: index === 6 ? artifactRef : null,
				}),
			}),
			payloadDigest: digestObject(envelope),
			artifactRef,
			issuedAt: host.context.issuedAt,
			validUntil: host.context.validUntil,
			keyId: "fixture-key",
			stateDigest: host.context.headDigest,
			revision: 1,
			oneUse: true,
		});
		return {
			stageId,
			envelope,
			validationReceipt,
			processReceipt: processReceiptBinding,
			trustedClockReceipt,
			consumptionWitness: recipeConsumptionWitness(
				validationReceipt,
				host.context.headDigest,
				host.context.issuedAt,
				index + 1,
			),
			intentBinding,
			baseSha,
			preCandidateSha: baseSha,
			candidateSha,
			integrationSha: index >= 3 ? integrationSha : null,
			reviewedHeadSha,
			ancestorShas:
				index >= 3
					? [candidateSha, baseSha, integrationSha, reviewedHeadSha]
					: [candidateSha, baseSha, reviewedHeadSha],
			baseAncestorShas: index >= 3 ? [baseSha, integrationSha] : [baseSha],
			noBaseMerge: true,
			worktreeDecision,
			worktreeRoot,
			worktreeStatusDigest,
			outOfScopePaths,
			reviewerIdentityDigest,
			reviewerRole,
			attackResultArtifactRef: index === 6 ? artifactRef : null,
		};
	});
}

function rebindIntentEvidenceReceipt(
	host: WorkflowRecipeHostResolutionPort,
	binding: WorkflowRecipeEvidenceBinding,
	overrides: Partial<
		Pick<
			WorkflowRecipeEvidenceBinding,
			"integrationSha" | "ancestorShas" | "baseAncestorShas" | "reviewerIdentityDigest"
		>
	>,
): WorkflowRecipeEvidenceBinding {
	const next = { ...binding, ...overrides };
	const metadataDigest = digestObject({
		stageId: next.stageId,
		intentBinding: next.intentBinding,
		processReceiptDigest: digestObject(next.processReceipt),
		trustedClockReceiptDigest: digestObject(next.trustedClockReceipt),
		baseSha: next.baseSha,
		preCandidateSha: next.preCandidateSha,
		candidateSha: next.candidateSha,
		integrationSha: next.integrationSha,
		reviewedHeadSha: next.reviewedHeadSha,
		ancestorShas: next.ancestorShas,
		baseAncestorShas: next.baseAncestorShas,
		noBaseMerge: next.noBaseMerge,
		worktreeDecision: next.worktreeDecision,
		worktreeRoot: next.worktreeRoot,
		worktreeStatusDigest: next.worktreeStatusDigest,
		outOfScopePaths: next.outOfScopePaths,
		reviewerIdentityDigest: next.reviewerIdentityDigest,
		reviewerRole: next.reviewerRole,
		attackResultArtifactRef: next.attackResultArtifactRef,
	});
	const bindingDigest = digestObject({
		kind: "workflow-recipe-receipt-binding",
		receiptKind: "tdd_evidence",
		workflowId: host.context.workflowId,
		recipeId: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
		revision: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
		registryManifestDigest: host.context.registryManifestDigest,
		hostKeyId: host.context.hostKeyId,
		epochRef: host.context.epochRef,
		headDigest: host.context.headDigest,
		currentDecisionDigest: host.context.currentDecisionDigest,
		contextDigest: host.context.contextDigest,
		payloadDigest: digestObject(next.envelope),
		metadataDigest,
	});
	const receiptWithoutVerificationDigest = {
		...next.validationReceipt,
		bindingDigest,
		verificationDigest: "",
	};
	return {
		...next,
		validationReceipt: {
			...receiptWithoutVerificationDigest,
			verificationDigest: digestObject(receiptWithoutVerificationDigest),
		},
		consumptionWitness: {
			...next.consumptionWitness,
			bindingDigest,
		},
	};
}

const overfittingChecks = [
	"metric_preregistration_lock",
	"sample_adequacy",
	"train_eval_separation",
	"test_contamination",
	"repeated_holdout_peeking",
	"proxy_exploitation",
	"variance_replicate_stability",
	"hidden_adversarial_generalization",
] as const;

function evidencePolicy(id: string): EvidencePolicy {
	return { id, maxBytes: 4096, maxItems: 4, independent: true };
}

function stage(id: string, taskId: string, evidencePolicyId = `evidence-${id}`): StageSpec {
	return {
		id,
		role: id,
		taskId,
		evidencePolicyId,
		capabilityIds: ["read"],
		generatedOutputPaths: [`artifacts/out/${id}.json`],
		lockPaths: [],
	};
}

function proposal(overrides: Partial<WorkflowRecipeProposal> = {}): WorkflowRecipeProposal {
	const stageIds = ["recon", "lens", "verify", "synthesize", "red-team"] as const;
	const stages = stageIds.map((id) => stage(id, id, `evidence-${id}`));
	const evidencePolicies = [
		...stageIds.map((id) => evidencePolicy(`evidence-${id}`)),
		evidencePolicy("universal"),
		evidencePolicy("overfit"),
	];
	const gates: readonly GateSpec[] = [
		{ id: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID, kind: "host_adjudication", evidencePolicyId: "universal" },
		{ id: WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID, kind: "overfitting_review", evidencePolicyId: "overfit" },
	];
	const result = {
		recipeId: "recipe-1",
		revision: 1,
		stages,
		gates,
		capabilities: [{ id: "read", name: "read_workspace" }],
		evidencePolicies,
		edges: stageIds.slice(1).map((id, index) => ({
			id: `edge-${index}`,
			from: stageIds[index],
			to: id,
			kind: "forward" as const,
		})),
		overlays: {
			universalHostGateIds: ["universal-host-decision-gate"],
			preEvaluationOverfitting: {
				evidencePolicyId: "overfit",
				checks: overfittingChecks,
				blockingBoundaries: ["holdout", "promotion", "milestone_acceptance", "completion"],
				opaqueHoldoutRef: "holdout-handle",
			},
		},
		...overrides,
	};
	return {
		...result,
		effectiveGraphDigest: overrides.effectiveGraphDigest ?? effectiveGraphDigestFor(recipeTasks(), result.stages),
	} as WorkflowRecipeProposal;
}

function comprehensiveTasks(): readonly WorkflowTask[] {
	const tddChain = WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.map((stageId, index) =>
		task(stageId, index === 0 ? ["adjudicate"] : [WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS[index - 1]]),
	);
	return [
		task("scope"),
		task("recon-code", ["scope"]),
		task("recon-tests", ["scope"]),
		task("recon-history", ["scope"]),
		task("synthesize-recon", ["recon-code", "recon-tests", "recon-history"]),
		task("lens-intent", ["synthesize-recon"]),
		task("lens-correctness", ["synthesize-recon"]),
		task("lens-security", ["synthesize-recon"]),
		task("synthesize", ["lens-intent", "lens-correctness", "lens-security"]),
		task("red-team", ["synthesize"]),
		task("adjudicate", ["red-team"]),
		...tddChain,
	];
}

function recipeTasks(): readonly WorkflowTask[] {
	return [
		task("recon"),
		task("lens", ["recon"]),
		task("verify", ["lens"]),
		task("synthesize", ["verify"]),
		task("red-team", ["synthesize"]),
	];
}

function effectiveGraphDigestFor(tasks: readonly WorkflowTask[], stages: readonly StageSpec[]): string {
	const graph = validateWorkflowTaskGraph(tasks, graphContext());
	const stageByTaskId = new Map(stages.map((stage) => [stage.taskId, stage]));
	const entries = graph.tasks
		.map((task) => {
			const stage = stageByTaskId.get(task.taskId);
			if (stage === undefined) throw new Error(`missing stage ${task.taskId}`);
			return {
				taskId: task.taskId,
				taskDigest: digestObject(task),
				generatedOutputPaths: [...(stage.generatedOutputPaths ?? [])],
				lockPaths: [...(stage.lockPaths ?? [])],
			};
		})
		.sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0));
	const pathBoundary = hostPort().pathBoundary;
	const sidecar = {
		baseTaskGraphDigest: graph.graphDigest,
		entries,
		pathBoundary,
	};
	return digestObject({
		graphDigest: graph.graphDigest,
		graphContext: {
			workspacePaths: graphContext().workspacePaths,
			generatedOutputPaths: graphContext().generatedOutputPaths,
			allowedAuthority: graphContext().allowedAuthority,
			knownSkillSnapshotDigests: graphContext().knownSkillSnapshotDigests,
			namedContracts: graphContext().namedContracts,
		},
		sidecar,
	});
}

function topologicalStageIds(proposalValue: WorkflowRecipeProposal): readonly string[] {
	const ids = proposalValue.stages.map((stage) => stage.id);
	const indegree = new Map(ids.map((id) => [id, 0]));
	const outgoing = new Map<string, string[]>();
	for (const edge of proposalValue.edges) {
		if (edge.kind === "back") continue;
		const next = outgoing.get(edge.from) ?? [];
		if (!next.includes(edge.to)) {
			next.push(edge.to);
			indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
		}
		outgoing.set(edge.from, next);
	}
	const ready = ids.filter((id) => indegree.get(id) === 0).sort();
	const ordered: string[] = [];
	while (ready.length > 0) {
		const id = ready.shift();
		if (id === undefined) break;
		ordered.push(id);
		for (const next of outgoing.get(id) ?? []) {
			const value = (indegree.get(next) ?? 0) - 1;
			indegree.set(next, value);
			if (value === 0) ready.push(next);
		}
		ready.sort();
	}
	return ordered;
}

function compileWorkflowRecipe(
	input: Parameters<typeof compileWorkflowRecipeImpl>[0],
): ReturnType<typeof compileWorkflowRecipeImpl> {
	const holdoutRef = input.proposal.overlays.preEvaluationOverfitting?.opaqueHoldoutRef ?? "holdout-handle";
	const host = Object.hasOwn(input, "host")
		? input.host
		: hostPort(input.proposal.recipeId, input.proposal.revision, holdoutRef, topologicalStageIds(input.proposal));
	const baseInput = {
		...input,
		host,
	};
	const registeredManifest = Object.hasOwn(input, "registeredManifest")
		? input.registeredManifest
		: createWorkflowRecipeRegisteredManifest(baseInput);
	const registeredHost =
		host !== undefined && registeredManifest !== undefined && host.registeredManifestReceipt === undefined
			? {
					...host,
					registeredManifestReceipt: (() => {
						const payloadDigest = digestObject(registeredManifest);
						const receipt = createFixtureHostReceipt({
							receiptKind: "artifact",
							receiptId: `recipe-registration-${registeredManifest.recipeId}-${registeredManifest.revision}`,
							issuerId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
							workflowId: host.context.workflowId,
							bindingDigest: digestObject({
								kind: "workflow-recipe-receipt-binding",
								receiptKind: "recipe_registration",
								workflowId: host.context.workflowId,
								recipeId: registeredManifest.recipeId,
								revision: registeredManifest.revision,
								registryManifestDigest: host.context.registryManifestDigest,
								hostKeyId: host.context.hostKeyId,
								epochRef: host.context.epochRef,
								headDigest: host.context.headDigest,
								currentDecisionDigest: host.context.currentDecisionDigest,
								contextDigest: host.context.contextDigest,
								payloadDigest,
							}),
							payloadDigest,
							artifactRef: {
								artifactId: "recipe-registration",
								relativePath: "artifacts/evidence/recipe-registration.json",
								digest: "b".repeat(64),
								sizeBytes: 1,
								sourceEventSequence: 1,
							},
							issuedAt: host.context.issuedAt,
							validUntil: host.context.validUntil,
							keyId: "fixture-key",
							stateDigest: host.context.headDigest,
							revision: registeredManifest.revision,
							oneUse: true,
						});
						return {
							receipt,
							payload: registeredManifest,
							consumptionWitness: recipeConsumptionWitness(
								receipt,
								host.context.headDigest,
								host.context.issuedAt,
								1,
							),
						};
					})(),
				}
			: host;
	return compileWorkflowRecipeImpl({ ...baseInput, host: registeredHost, registeredManifest });
}

describe("compact workflow recipe compiler", () => {
	it("compiles proposal stages into existing tasks and a frozen sidecar", () => {
		const compiled = compileWorkflowRecipe({
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});

		expect(compiled.tasks.map(({ taskId }) => taskId)).toEqual(["lens", "recon", "red-team", "synthesize", "verify"]);
		expect(compiled.sidecar.entries).toHaveLength(5);
		expect(compiled.sidecar.entries[0]).toHaveProperty("taskDigest");
		expect(Object.isFrozen(compiled.sidecar)).toBe(true);
		expect(Object.isFrozen(compiled.sidecar.entries)).toBe(true);
	});

	it.each([
		[
			"unknown role",
			() => ({
				stages: proposal().stages.map((stage, index) => (index === 0 ? { ...stage, role: "unknown-role" } : stage)),
			}),
			"unknown_role",
		],
		[
			"unknown gate",
			() => ({ gates: [{ id: "unknown-gate", kind: "unknown", evidencePolicyId: "universal" }] }),
			"unknown_gate",
		],
		["unknown capability", () => ({ capabilities: [{ id: "mystery", name: "mystery" }] }), "unknown_capability"],
	] as const)("rejects %s", (_label, makeOverride, code) => {
		expect(() =>
			compileWorkflowRecipe({
				proposal: proposal(makeOverride()),
				tasks: recipeTasks(),
				graphContext: graphContext(),
			}),
		).toThrow(new RegExp(code));
	});

	it("rejects unbounded loop declarations", () => {
		const attack = structuredClone(BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST);
		const boundedLoop = attack.loops?.[0];
		if (boundedLoop === undefined) throw new Error("fixture loop is missing");
		const malformed = { ...attack, loops: [{ ...boundedLoop, maxTraversals: Number.POSITIVE_INFINITY }] };
		expect(() =>
			compileWorkflowRecipe({ proposal: malformed, tasks: attackTasks(), graphContext: graphContext() }),
		).toThrow(/unbounded_loop/);
	});

	it("rejects unbounded fan-out declarations", () => {
		const malformed = {
			...proposal(),
			fanOuts: [
				{
					id: "fanout",
					from: "recon",
					branchStageIds: ["lens", "verify"],
					joinStageId: "synthesize",
					maxBranches: Number.POSITIVE_INFINITY,
				},
			],
		};
		expect(() =>
			compileWorkflowRecipe({ proposal: malformed, tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/unbounded_fanout/);
	});

	it("rejects overlapping stage output and lock paths", () => {
		const independentTasks = recipeTasks().map((item) => ({ ...item, dependencyTaskIds: [] }));
		const stages = proposal().stages.map((item, index) =>
			index === 1 ? { ...item, generatedOutputPaths: ["artifacts/out/recon.json"] } : item,
		);
		const independentProposal = proposal({
			stages,
			edges: [],
			effectiveGraphDigest: effectiveGraphDigestFor(independentTasks, stages),
		});
		expect(() =>
			compileWorkflowRecipe({
				proposal: independentProposal,
				tasks: independentTasks,
				graphContext: graphContext(),
			}),
		).toThrow(/path_overlap/);
	});

	it("allows overlapping paths when task dependencies serialize ownership", () => {
		const stages = proposal().stages.map((item, index) =>
			index === 1 ? { ...item, lockPaths: ["src/recon.ts"] } : item,
		);
		const serializedProposal = proposal({
			stages,
			effectiveGraphDigest: effectiveGraphDigestFor(recipeTasks(), stages),
		});
		expect(() =>
			compileWorkflowRecipe({ proposal: serializedProposal, tasks: recipeTasks(), graphContext: graphContext() }),
		).not.toThrow();
	});

	it("requires stage evidence, the universal host gate, and overfitting review overlays", () => {
		const noEvidence = proposal({
			stages: proposal().stages.map((stage, index) =>
				index === 0 ? { ...stage, evidencePolicyId: "missing" } : stage,
			),
		});
		expect(() =>
			compileWorkflowRecipe({ proposal: noEvidence, tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/missing_evidence/);
		const noUniversal = proposal({ overlays: { ...proposal().overlays, universalHostGateIds: [] } });
		expect(() =>
			compileWorkflowRecipe({ proposal: noUniversal, tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/missing_universal_gate/);
		const noOverfit = proposal({ overlays: { universalHostGateIds: ["universal-host-decision-gate"] } });
		expect(() =>
			compileWorkflowRecipe({ proposal: noOverfit, tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/missing_overfitting_review/);
	});

	it("rejects authority-like fields and hidden holdout handles", () => {
		const authority = proposal();
		(authority.stages[0] as unknown as Record<string, unknown>).authority = ["accept_completion"];
		expect(() =>
			compileWorkflowRecipe({ proposal: authority, tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/authority_like_field/);
		const hiddenHandle = proposal();
		(hiddenHandle.overlays.preEvaluationOverfitting as unknown as Record<string, unknown>).hiddenHoldoutHandle =
			"secret";
		expect(() =>
			compileWorkflowRecipe({ proposal: hiddenHandle, tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/hidden_handle_exposed/);
	});

	it("rejects caller-controlled registry semantics", () => {
		const callerRegistry = {
			roles: [...DEFAULT_WORKFLOW_RECIPE_REGISTRY.roles, "caller-role"],
			gates: [...DEFAULT_WORKFLOW_RECIPE_REGISTRY.gates],
			capabilities: [...DEFAULT_WORKFLOW_RECIPE_REGISTRY.capabilities],
		};
		const callerProposal = proposal({
			stages: proposal().stages.map((item, index) => (index === 0 ? { ...item, role: "caller-role" } : item)),
		});
		expect(() =>
			compileWorkflowRecipe({
				proposal: callerProposal,
				tasks: recipeTasks(),
				graphContext: graphContext(),
				registry: callerRegistry as unknown as Parameters<typeof compileWorkflowRecipe>[0]["registry"],
			}),
		).toThrow(/registry_invalid/);
	});

	it("requires the immutable host registry identity and rejects gate/capability aliases", () => {
		const alteredRegistry = {
			...DEFAULT_WORKFLOW_RECIPE_REGISTRY,
			registryId: "caller-registry",
		};
		expect(() =>
			compileWorkflowRecipe({
				proposal: proposal(),
				tasks: recipeTasks(),
				graphContext: graphContext(),
				registry: alteredRegistry,
			}),
		).toThrow(/registry_invalid/);
		const gateAlias = proposal({
			gates: proposal().gates.map((gate, index) => (index === 0 ? { ...gate, id: "host_adjudication" } : gate)),
		});
		expect(() =>
			compileWorkflowRecipe({ proposal: gateAlias, tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/unknown_gate|missing_universal_gate/);
		const capabilityAlias = proposal({
			capabilities: [{ id: "read", name: "read_external_evidence" }],
		});
		expect(() =>
			compileWorkflowRecipe({ proposal: capabilityAlias, tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/unknown_capability|registry_invalid/);
	});

	it("does not accept changed semantics for a registered recipe manifest", () => {
		const first = compileWorkflowRecipe({ proposal: proposal(), tasks: recipeTasks(), graphContext: graphContext() });
		const changed = proposal({
			revision: 1,
			stages: proposal().stages.map((stage, index) =>
				index === 0 ? { ...stage, generatedOutputPaths: ["artifacts/out/recon-changed.json"] } : stage,
			),
		});
		const registeredManifest = {
			recipeId: first.recipe.recipeId,
			revision: first.recipe.revision,
			recipeDigest: first.recipeDigest,
			registryManifestDigest: first.registryManifestDigest,
			immutable: true as const,
		};
		expect(() =>
			compileWorkflowRecipe({
				proposal: changed,
				tasks: recipeTasks(),
				graphContext: graphContext(),
				registeredManifest,
			} as unknown as Parameters<typeof compileWorkflowRecipe>[0]),
		).toThrow(/compiled_graph_mismatch|registry_invalid/);
	});

	it("requires host resolution for opaque holdouts", () => {
		const input = {
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
			host: undefined,
		} as unknown as Parameters<typeof compileWorkflowRecipe>[0];
		expect(() => compileWorkflowRecipe(input)).toThrow(/opaque_holdout|missing_overfitting_review/);
	});

	it("requires an immutable host registration for every recipe", () => {
		const input = {
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
			host: hostPort(),
		} as unknown as Parameters<typeof compileWorkflowRecipeImpl>[0];
		expect(() => compileWorkflowRecipeImpl(input)).toThrow(/registered|manifest|registration/i);
	});

	it("requires the signed host registration receipt to bind the exact manifest", () => {
		const host = hostPort();
		const registeredManifest = createWorkflowRecipeRegisteredManifest({
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
			host,
		});
		expect(() =>
			compileWorkflowRecipeImpl({
				proposal: proposal(),
				tasks: recipeTasks(),
				graphContext: graphContext(),
				host,
				registeredManifest,
			}),
		).toThrow(/registration|receipt/i);
	});

	it("does not treat caller resolver callbacks as host authentication", () => {
		const callbackHost = { ...hostPort(), authority: {} } as unknown as WorkflowRecipeHostResolutionPort;
		expect(() =>
			compileWorkflowRecipeImpl({
				proposal: proposal(),
				tasks: recipeTasks(),
				graphContext: graphContext(),
				host: callbackHost,
			}),
		).toThrow(/receipt|authority|verified|registration/i);
	});

	it("does not resolve Superpowers recipes from a generic catalog", () => {
		const result = resolveWorkflowRecipe({
			requestedRecipeId: "superpowers:generic",
			optional: true,
			catalog: [proposal({ recipeId: "superpowers:generic" })],
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});
		expect(result).toMatchObject({ kind: "capability_gap", code: "capability_gap", fallback: "none" });
	});

	it("binds optional Superpowers recipes to exact immutable skill snapshots", () => {
		const sourceSkills = WORKFLOW_RECIPE_CANONICAL_SUPERPOWERS_SKILL_SNAPSHOTS.map((snapshot) => ({
			...snapshot,
			immutable: true as const,
			vendored: true as const,
		}));
		const selected = proposal({
			recipeId: "superpowers:verified",
			requiredSkillSnapshotDigests: sourceSkills.map((snapshot) => snapshot.snapshotDigest),
			capabilities: [
				{ id: "read", name: "read_workspace" },
				{ id: "superpowers", name: "superpowers" },
			],
		});
		const source = {
			sourceId: "superpowers" as const,
			snapshotDigest: "",
			provenanceDigest: "",
			verificationReceiptDigest: "",
			recipeCatalogDigest: "",
			hostVerified: true as const,
			vendored: true as const,
			skillSnapshots: sourceSkills,
			recipes: [selected],
		};
		Object.assign(
			source,
			getWorkflowRecipeSuperpowersCatalogDigests({ recipes: source.recipes, skillSnapshots: sourceSkills }),
		);
		const sourceBinding = {
			sourceId: "superpowers" as const,
			snapshotDigest: source.snapshotDigest,
			provenanceDigest: source.provenanceDigest,
			verificationReceiptDigest: source.verificationReceiptDigest,
			recipeCatalogDigest: source.recipeCatalogDigest,
			skillSnapshotDigests: sourceSkills.map((snapshot) => snapshot.snapshotDigest),
		};
		const sourceHostBase = hostPort(selected.recipeId, selected.revision);
		const sourceHostWithCatalog = {
			...sourceHostBase,
			superpowersCatalogReceipt: makeRecipeReceipt(
				sourceHostBase.context,
				selected.recipeId,
				selected.revision,
				"superpowers_catalog",
				{
					sourceId: "superpowers" as const,
					snapshotDigest: source.snapshotDigest,
					provenanceDigest: source.provenanceDigest,
					verificationReceiptDigest: source.verificationReceiptDigest,
					recipeCatalogDigest: source.recipeCatalogDigest,
					skillSnapshotDigests: sourceSkills.map((snapshot) => snapshot.snapshotDigest),
					hostVerified: true as const,
					vendored: true as const,
				},
			),
		};
		const registeredManifest = createWorkflowRecipeRegisteredManifest({
			proposal: selected,
			tasks: recipeTasks(),
			graphContext: graphContext(),
			host: sourceHostWithCatalog,
			catalogBinding: sourceBinding,
		});
		const sourceHost = {
			...sourceHostWithCatalog,
			registeredManifestReceipt: makeRecipeReceipt(
				sourceHostWithCatalog.context,
				registeredManifest.recipeId,
				registeredManifest.revision,
				"recipe_registration",
				registeredManifest,
			),
		};
		const result = resolveWorkflowRecipe({
			requestedRecipeId: selected.recipeId,
			optional: true,
			superpowersSource: source,
			tasks: recipeTasks(),
			graphContext: graphContext(),
			host: sourceHost,
			registeredManifest,
		});
		expect(result.kind).toBe("compiled");
		if (result.kind === "compiled") expect(result.admission.catalogBindingDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(() =>
			resolveWorkflowRecipe({
				requestedRecipeId: selected.recipeId,
				optional: true,
				superpowersSource: source,
				tasks: recipeTasks(),
				graphContext: graphContext(),
				host: sourceHostBase,
				registeredManifest,
			}),
		).toThrow(/catalog|receipt/i);
		const missingSkills = resolveWorkflowRecipe({
			requestedRecipeId: selected.recipeId,
			optional: true,
			superpowersSource: { ...source, skillSnapshots: [] },
			tasks: recipeTasks(),
			graphContext: graphContext(),
			host: sourceHost,
		});
		expect(missingSkills).toMatchObject({ kind: "capability_gap", fallback: "none" });
	});

	it("requires immutable native AutoResearch and MemPalace snapshots for built-ins", () => {
		expect(
			WORKFLOW_RECIPE_CANONICAL_NATIVE_CAPABILITY_SNAPSHOTS.every(
				(snapshot) => snapshot.snapshotArtifactRef.sizeBytes > 1 && snapshot.manifestArtifactRef.sizeBytes > 1,
			),
		).toBe(true);
		const missingSnapshotsHost = {
			...hostPort(BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM.recipeId),
			nativeCapabilitySnapshots: [],
		};
		expect(() =>
			compileWorkflowRecipe({
				proposal: BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM,
				tasks: recipeTasks(),
				graphContext: graphContext(),
				host: missingSnapshotsHost,
			}),
		).toThrow(/capability|snapshot/);
		const missingSnapshotReceiptHost = {
			...hostPort(BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM.recipeId),
			nativeCapabilitySnapshotReceipts: undefined,
		};
		expect(() =>
			compileWorkflowRecipe({
				proposal: BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM,
				tasks: recipeTasks(),
				graphContext: graphContext(),
				host: missingSnapshotReceiptHost,
			}),
		).toThrow(/capability|snapshot|receipt/);
	});

	it("requires native snapshots for non-builtin recipes that declare native capabilities", () => {
		const nativeRecipe = proposal({
			capabilities: [
				{ id: "read", name: "read_workspace" },
				{ id: "autoresearch", name: "autoresearch" },
			],
		});
		const missingSnapshotsHost = {
			...hostPort(nativeRecipe.recipeId, nativeRecipe.revision),
			nativeCapabilitySnapshots: [],
			nativeCapabilitySnapshotReceipts: [],
		};
		expect(() =>
			compileWorkflowRecipe({
				proposal: nativeRecipe,
				tasks: recipeTasks(),
				graphContext: graphContext(),
				host: missingSnapshotsHost,
			}),
		).toThrow(/capability|snapshot/);
	});

	it("requires universal lifecycle and typed overfitting gate contracts", () => {
		const universal = proposal({
			gates: proposal().gates.map((gate, index) =>
				index === 0 ? { ...gate, lifecycle: { terminal: true } } : gate,
			),
		});
		expect(() =>
			compileWorkflowRecipe({ proposal: universal, tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/recipe_field_unknown|gate/);
		const noTypedReview = proposal();
		expect(() =>
			compileWorkflowRecipe({
				proposal: noTypedReview,
				tasks: recipeTasks(),
				graphContext: graphContext(),
				host: {
					...hostPort(),
					overfittingGateReceipt: {
						...hostPort().overfittingGateReceipt,
						receipt: { ...hostPort().overfittingGateReceipt.receipt, verificationDigest: "f".repeat(64) },
					},
				},
			}),
		).toThrow(/opaque|receipt|overfitting|review/);
	});

	it("requires an effective graph/sidecar digest binding", () => {
		expect(() =>
			compileWorkflowRecipe({
				proposal: proposal({ taskGraphDigest: "stale-base-only" }),
				tasks: recipeTasks(),
				graphContext: graphContext(),
			}),
		).toThrow(/compiled_graph_mismatch/);
	});

	it("freezes capability gaps and exposes a host-bound admission artifact", () => {
		const result = resolveWorkflowRecipe({
			requestedRecipeId: "superpowers:frozen-gap",
			optional: true,
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});
		expect(Object.isFrozen(result)).toBe(true);
		const compiled = compileWorkflowRecipe({
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});
		const admission = (compiled as unknown as Record<string, unknown>).admission;
		expect(admission).toMatchObject({ kind: "workflow_recipe_admission" });
		expect(admission).toHaveProperty("pathBoundary");
	});

	it("hands only an immutable, content-bound admission to the production consumer seam", async () => {
		const compiled = compileWorkflowRecipe({
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});
		const consumed: unknown[] = [];
		const host = hostPort();
		if (compiled.admission.registrationReceipt === undefined)
			throw new Error("fixture registration receipt is missing");
		await host.context.receiptContext.receiptResolver.consumeIfOneUse({
			receipt: compiled.admission.registrationReceipt.receipt,
			workflowId: compiled.admission.workflowId,
			expectedBindingDigest: compiled.admission.registrationReceipt.receipt.bindingDigest,
			currentRevision: compiled.admission.revision,
		});
		await consumeWorkflowRecipeAdmission(
			compiled.admission,
			{
				consumeWorkflowRecipeAdmission: (admission) => consumed.push(admission),
			},
			host,
		);
		expect(consumed).toEqual([compiled.admission]);
		const forged = { ...compiled.admission, recipeDigest: "forged" };
		await expect(
			consumeWorkflowRecipeAdmission(
				forged,
				{
					consumeWorkflowRecipeAdmission: () => undefined,
				},
				host,
			),
		).rejects.toThrow(/immutable|digest/);
		const forgedEvidence = structuredClone(compiled.admission);
		forgedEvidence.evidenceEnvelopeDigests = ["f".repeat(64)];
		await expect(
			consumeWorkflowRecipeAdmission(
				freezePersisted(forgedEvidence),
				{
					consumeWorkflowRecipeAdmission: () => undefined,
				},
				host,
			),
		).rejects.toThrow(/digest|immutable/);
		const forgedStage = structuredClone(compiled.admission);
		const forgedStageBinding = forgedStage.taskBindings[0];
		if (forgedStageBinding === undefined) throw new Error("fixture task binding is missing");
		forgedStageBinding.stageId = "forged-stage";
		await expect(
			consumeWorkflowRecipeAdmission(
				freezePersisted(forgedStage),
				{
					consumeWorkflowRecipeAdmission: () => undefined,
				},
				host,
			),
		).rejects.toThrow(/digest|task|immutable/);
	});

	it("rejects admission consumption without an authenticated host authority", async () => {
		const compiled = compileWorkflowRecipe({
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});
		let consumed = false;
		await expect(
			consumeWorkflowRecipeAdmission(compiled.admission, {
				consumeWorkflowRecipeAdmission: () => {
					consumed = true;
				},
			}),
		).rejects.toThrow(/host|authority|registration/i);
		expect(consumed).toBe(false);
	});

	it("rejects a forged admission that recomputes only its outer digest", async () => {
		const compiled = compileWorkflowRecipe({
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});
		const forged = structuredClone(compiled.admission);
		forged.recipeBinding.taskBindings[0].role = "implementation";
		const { admissionDigest: _admissionDigest, ...withoutDigest } = forged;
		forged.admissionDigest = digestObject(withoutDigest);
		await expect(
			consumeWorkflowRecipeAdmission(
				freezePersisted(forged),
				{
					consumeWorkflowRecipeAdmission: () => undefined,
				},
				hostPort(),
			),
		).rejects.toThrow(/signed|digest|registration|stage|role/i);
	});

	it("rejects a host-registration forgery that weakens the signed overfitting gate", async () => {
		const compiled = compileWorkflowRecipe({
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});
		const forged = forgeAdmissionWithReusedRegistrationSignature(compiled, (admission) => {
			(admission.recipeBinding.overfittingGate as unknown as { blocking: boolean }).blocking = false;
		});
		let consumed = false;
		await expect(
			consumeWorkflowRecipeAdmission(
				forged,
				{
					consumeWorkflowRecipeAdmission: () => {
						consumed = true;
					},
				},
				hostPort(),
			),
		).rejects.toThrow(/registration|signature|authority|digest|gate/i);
		expect(consumed).toBe(false);
	});

	it("rejects a host-registration forgery that substitutes a wrong-goal evidence digest", async () => {
		const compiled = compileWorkflowRecipe({
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});
		const forged = forgeAdmissionWithReusedRegistrationSignature(compiled, (admission) => {
			admission.recipeBinding.evidenceBindingDigest = "f".repeat(64);
			admission.evidenceBindingDigest = admission.recipeBinding.evidenceBindingDigest;
		});
		let consumed = false;
		await expect(
			consumeWorkflowRecipeAdmission(
				forged,
				{
					consumeWorkflowRecipeAdmission: () => {
						consumed = true;
					},
				},
				hostPort(),
			),
		).rejects.toThrow(/registration|signature|authority|digest|evidence/i);
		expect(consumed).toBe(false);
	});

	it("rejects a rehashed admission when the registration signature is reused", async () => {
		const host = hostPort();
		const compiled = compileWorkflowRecipe({
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
			host,
		});
		const forged = structuredClone(
			forgeAdmissionWithReusedRegistrationSignature(compiled, (admission) => {
				admission.recipeBinding.overfittingGate.freshnessDigest = "f".repeat(64);
			}),
		);
		if (forged.registrationReceipt === undefined || forged.registrationReceiptProof === undefined)
			throw new Error("fixture registration receipt is missing");
		forged.registrationReceiptProof.admissionPreimageDigest = forged.recipeDigest;
		const {
			signature: _signature,
			verificationDigest: _verificationDigest,
			...signedFields
		} = forged.registrationReceipt.receipt;
		forged.registrationReceiptProof.signedReceiptPreimageDigest = digestObject(signedFields);
		const { admissionDigest: _admissionDigest, ...withoutAdmissionDigest } = forged;
		forged.admissionDigest = digestObject(withoutAdmissionDigest);
		const persisted = freezePersisted(forged);
		let consumed = false;
		await expect(
			consumeWorkflowRecipeAdmissionAtHost({
				admission: persisted,
				host,
				consumer: {
					consumeWorkflowRecipeAdmission: () => {
						consumed = true;
					},
				},
			}),
		).rejects.toThrow(/cryptograph|signature|receipt|trusted/i);
		expect(consumed).toBe(false);
	});

	it("re-resolves the persisted registration receipt and immutable artifact before host consumption", async () => {
		const host = hostPort();
		const compiled = compileWorkflowRecipe({
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
			host,
		});
		const registration = compiled.admission.registrationReceipt;
		if (registration === undefined || compiled.admission.registrationReceiptProof === undefined)
			throw new Error("fixture registration receipt is missing");
		await host.context.receiptContext.receiptResolver.consumeIfOneUse({
			receipt: registration.receipt,
			workflowId: registration.receipt.workflowId,
			expectedBindingDigest: registration.receipt.bindingDigest,
			currentRevision: registration.receipt.revision,
		});
		const { signature: _signature, verificationDigest: _verificationDigest, ...signedFields } = registration.receipt;
		const proofResolver = host.context.authenticatedReceiptResolver;
		const hostWithAdmissionProof = {
			...host,
			context: {
				...host.context,
				authenticatedReceiptResolver: {
					...proofResolver,
					verifyConsumedReceipt: (input: Parameters<typeof proofResolver.verifyConsumedReceipt>[0]) => {
						const proof = proofResolver.verifyConsumedReceipt(input);
						if (proof === null) return null;
						return {
							...proof,
							admissionPreimageDigest: compiled.admission.recipeDigest,
							signedReceiptPreimageDigest: digestObject(signedFields),
						};
					},
				},
			},
		} as WorkflowRecipeHostResolutionPort;
		let consumed = false;
		await consumeWorkflowRecipeAdmissionAtHost({
			admission: compiled.admission,
			host: hostWithAdmissionProof,
			consumer: {
				consumeWorkflowRecipeAdmission: () => {
					consumed = true;
				},
			},
		});
		expect(consumed).toBe(true);
	});

	it("reopens a persisted admission in a child process before public consumption", async () => {
		const compiled = compileWorkflowRecipe({
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});
		const directory = mkdtempSync(join(tmpdir(), "workflow-recipe-admission-"));
		const admissionPath = join(directory, "admission.json");
		const consumedPath = join(directory, "consumed-admission.json");
		const host = hostPort();
		try {
			writeFileSync(admissionPath, JSON.stringify(compiled.admission), "utf8");
			const digestScript = [
				"const { readFileSync } = require('node:fs');",
				"const { createHash } = require('node:crypto');",
				"const canonical = (value) => {",
				"  if (value === null || typeof value !== 'object') return JSON.stringify(value);",
				"  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';",
				"  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';",
				"};",
				"const value = JSON.parse(readFileSync(process.argv[1], 'utf8'));",
				"const { admissionDigest, ...withoutDigest } = value;",
				"process.stdout.write(createHash('sha256').update(canonical(withoutDigest)).digest('hex'));",
			].join("\n");
			const childDigest = execFileSync(process.execPath, ["-e", digestScript, admissionPath], {
				encoding: "utf8",
				cwd: process.cwd(),
			});
			expect(childDigest).toBe(compiled.admission.admissionDigest);
			const reopened = freezePersisted(
				JSON.parse(readFileSync(admissionPath, "utf8")) as unknown,
			) as typeof compiled.admission;
			if (reopened.registrationReceipt === undefined) throw new Error("fixture registration receipt is missing");
			await host.context.receiptContext.receiptResolver.consumeIfOneUse({
				receipt: reopened.registrationReceipt.receipt,
				workflowId: reopened.workflowId,
				expectedBindingDigest: reopened.registrationReceipt.receipt.bindingDigest,
				currentRevision: reopened.revision,
			});
			await consumeWorkflowRecipeAdmission(
				reopened,
				{
					consumeWorkflowRecipeAdmission: (admission) =>
						writeFileSync(consumedPath, JSON.stringify(admission), "utf8"),
				},
				host,
			);
			expect(JSON.parse(readFileSync(consumedPath, "utf8"))).toEqual(reopened);
			expect(reopened).toEqual(compiled.admission);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("atomically consumes one persisted admission across replay races and host reopen", async () => {
		const durableRoot = mkdtempSync(join(tmpdir(), "workflow-recipe-admission-authority-"));
		try {
			const host = hostPort(
				"recipe-1",
				1,
				"holdout-handle",
				["recon", "lens", "verify", "synthesize", "red-team"],
				durableRoot,
			);
			const compiled = compileWorkflowRecipe({
				proposal: proposal(),
				tasks: recipeTasks(),
				graphContext: graphContext(),
				host,
			});
			const registration = compiled.admission.registrationReceipt;
			if (registration === undefined) throw new Error("fixture registration receipt is missing");
			await host.context.receiptContext.receiptResolver.consumeIfOneUse({
				receipt: registration.receipt,
				workflowId: registration.receipt.workflowId,
				expectedBindingDigest: registration.receipt.bindingDigest,
				currentRevision: registration.receipt.revision,
			});
			let consumerCalls = 0;
			const consumer = {
				consumeWorkflowRecipeAdmission: () => {
					consumerCalls += 1;
				},
			};
			await Promise.all(
				[0, 1].map(() => consumeWorkflowRecipeAdmissionAtHost({ admission: compiled.admission, host, consumer })),
			);
			expect(consumerCalls).toBe(1);
			const markerPath = join(durableRoot, `admission-${sha256Hex(compiled.admission.admissionDigest)}.json`);
			expect(existsSync(markerPath)).toBe(true);
			const childRead = execFileSync(
				process.execPath,
				[
					"-e",
					"const { existsSync } = require('node:fs'); process.stdout.write(String(existsSync(process.argv[1])));",
					markerPath,
				],
				{ encoding: "utf8", cwd: process.cwd() },
			);
			expect(childRead).toBe("true");
			const reopenedHost = hostPort(
				"recipe-1",
				1,
				"holdout-handle",
				["recon", "lens", "verify", "synthesize", "red-team"],
				durableRoot,
			);
			await consumeWorkflowRecipeAdmissionAtHost({
				admission: compiled.admission,
				host: reopenedHost,
				consumer,
			});
			expect(consumerCalls).toBe(1);
		} finally {
			rmSync(durableRoot, { recursive: true, force: true });
		}
	});

	it("rejects a forged witness sequence and signature before durable admission journaling", async () => {
		const durableRoot = mkdtempSync(join(tmpdir(), "workflow-recipe-admission-forgery-"));
		try {
			const host = hostPort(
				"recipe-1",
				1,
				"holdout-handle",
				["recon", "lens", "verify", "synthesize", "red-team"],
				durableRoot,
			);
			const compiled = compileWorkflowRecipe({
				proposal: proposal(),
				tasks: recipeTasks(),
				graphContext: graphContext(),
				host,
			});
			const witnessForgery = structuredClone(compiled.admission);
			if (witnessForgery.registrationReceipt === undefined || witnessForgery.registrationReceiptProof === undefined)
				throw new Error("fixture registration proof is missing");
			witnessForgery.registrationReceipt.consumptionWitness.consumptionSequence = 999;
			witnessForgery.registrationReceiptProof.consumptionSequence = 999;
			witnessForgery.registrationReceiptProof.witnessDigest = digestObject(
				witnessForgery.registrationReceipt.consumptionWitness,
			);
			const { admissionDigest: _admissionDigest, ...withoutAdmissionDigest } = witnessForgery;
			witnessForgery.admissionDigest = digestObject(withoutAdmissionDigest);
			const forgedWitness = freezePersisted(witnessForgery);
			let consumerCalls = 0;
			await expect(
				consumeWorkflowRecipeAdmissionAtHost({
					admission: forgedWitness,
					host,
					consumer: { consumeWorkflowRecipeAdmission: () => (consumerCalls += 1) },
				}),
			).rejects.toThrow(/witness|receipt|digest|registration/i);
			expect(consumerCalls).toBe(0);
			const signatureForgery = structuredClone(compiled.admission);
			if (signatureForgery.registrationReceipt === undefined) throw new Error("fixture registration is missing");
			signatureForgery.registrationReceipt.receipt.signature = "forged-public-signature";
			await expect(
				consumeWorkflowRecipeAdmissionAtHost({
					admission: freezePersisted(signatureForgery),
					host,
					consumer: { consumeWorkflowRecipeAdmission: () => (consumerCalls += 1) },
				}),
			).rejects.toThrow(/signature|digest|receipt|registration/i);
			expect(consumerCalls).toBe(0);
			expect(existsSync(join(durableRoot, `admission-${sha256Hex(compiled.admission.admissionDigest)}.json`))).toBe(
				false,
			);
		} finally {
			rmSync(durableRoot, { recursive: true, force: true });
		}
	});

	it("binds admission to the exact current task, graph epoch, stage, gate, and workspace paths", () => {
		const compiled = compileWorkflowRecipe({
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});
		const currentTask = compiled.graph.byId.get("recon");
		if (currentTask === undefined) throw new Error("fixture task is missing");
		verifyWorkflowRecipeAdmissionForTask({
			admission: compiled.admission,
			task: currentTask,
			graph: compiled.graph,
			epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
			workflowId: compiled.admission.workflowId,
			currentHostHeadDigest: compiled.admission.hostHeadDigest,
		});
		expect(() =>
			verifyWorkflowRecipeAdmissionForTask({
				admission: compiled.admission,
				task: currentTask,
				graph: compiled.graph,
				epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
				workflowId: "foreign-workflow",
				currentHostHeadDigest: compiled.admission.hostHeadDigest,
			}),
		).toThrow(/workflow|head/);
		expect(() =>
			verifyWorkflowRecipeAdmissionForTask({
				admission: compiled.admission,
				task: currentTask,
				graph: compiled.graph,
				epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
				workflowId: compiled.admission.workflowId,
				currentHostHeadDigest: "b".repeat(64),
			}),
		).toThrow(/workflow|head/);
		expect(() =>
			verifyWorkflowRecipeAdmissionForTask({
				admission: compiled.admission,
				task: { ...currentTask, ownedPaths: ["src/forged.ts"] },
				graph: compiled.graph,
				epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
				workflowId: compiled.admission.workflowId,
				currentHostHeadDigest: compiled.admission.hostHeadDigest,
			}),
		).toThrow(/task binding/);
		expect(() =>
			verifyWorkflowRecipeAdmissionForTask({
				admission: compiled.admission,
				task: currentTask,
				graph: { ...compiled.graph, graphDigest: "forged" },
				epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
				workflowId: compiled.admission.workflowId,
				currentHostHeadDigest: compiled.admission.hostHeadDigest,
			}),
		).toThrow(/task graph/);
	});

	it("exports an optional Superpowers methodology mapping without authority", () => {
		expect(BUILTIN_SUPERPOWERS_METHODOLOGY_MAPPING).toBeDefined();
		expect(Object.isFrozen(BUILTIN_SUPERPOWERS_METHODOLOGY_MAPPING)).toBe(true);
	});

	it("requires recipe edges to match direct task dependencies", () => {
		const edges = proposal().edges.map((edge, index) =>
			index === 0 ? { ...edge, from: "recon", to: "verify" } : edge,
		);
		expect(() =>
			compileWorkflowRecipe({ proposal: proposal({ edges }), tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/recipe_edge_mismatch/);
	});

	it("rejects a disconnected fan-out source", () => {
		const fanoutTasks = [
			task("recon"),
			task("lens", ["recon"]),
			task("verify", ["recon"]),
			task("synthesize", ["lens", "verify"]),
			task("red-team", ["synthesize"]),
		];
		const edges = [
			{ id: "recon-to-lens", from: "recon", to: "lens", kind: "forward" as const },
			{ id: "recon-to-verify", from: "recon", to: "verify", kind: "forward" as const },
			{ id: "lens-to-synthesize", from: "lens", to: "synthesize", kind: "forward" as const },
			{ id: "verify-to-synthesize", from: "verify", to: "synthesize", kind: "forward" as const },
			{ id: "synthesize-to-red-team", from: "synthesize", to: "red-team", kind: "forward" as const },
		];
		const fanoutProposal = proposal({
			edges,
			fanOuts: [
				{
					id: "fanout",
					from: "red-team",
					branchStageIds: ["lens", "verify"],
					joinStageId: "synthesize",
					maxBranches: 2,
				},
			],
			effectiveGraphDigest: effectiveGraphDigestFor(fanoutTasks, proposal().stages),
		});
		expect(() =>
			compileWorkflowRecipe({
				proposal: fanoutProposal,
				tasks: fanoutTasks,
				graphContext: graphContext(),
			}),
		).toThrow(/recipe_fanout_mismatch/);
	});

	it("requires fan-out branches to be independent", () => {
		const dependentFanoutTasks = [
			task("recon"),
			task("lens", ["recon"]),
			task("verify", ["recon", "lens"]),
			task("synthesize", ["lens", "verify"]),
			task("red-team", ["synthesize"]),
		];
		const edges = [
			{ id: "recon-to-lens", from: "recon", to: "lens", kind: "forward" as const },
			{ id: "recon-to-verify", from: "recon", to: "verify", kind: "forward" as const },
			{ id: "lens-to-verify", from: "lens", to: "verify", kind: "forward" as const },
			{ id: "lens-to-synthesize", from: "lens", to: "synthesize", kind: "forward" as const },
			{ id: "verify-to-synthesize", from: "verify", to: "synthesize", kind: "forward" as const },
			{ id: "synthesize-to-red-team", from: "synthesize", to: "red-team", kind: "forward" as const },
		];
		const fanoutProposal = proposal({
			edges,
			fanOuts: [
				{
					id: "fanout",
					from: "recon",
					branchStageIds: ["lens", "verify"],
					joinStageId: "synthesize",
					maxBranches: 2,
				},
			],
			effectiveGraphDigest: effectiveGraphDigestFor(dependentFanoutTasks, proposal().stages),
		});
		expect(() =>
			compileWorkflowRecipe({
				proposal: fanoutProposal,
				tasks: dependentFanoutTasks,
				graphContext: graphContext(),
			}),
		).toThrow(/fanout|independent/i);
	});

	it("restricts generated outputs to the host generated-output roots", () => {
		const stages = proposal().stages.map((item, index) =>
			index === 0 ? { ...item, generatedOutputPaths: ["src/generated.json"] } : item,
		);
		expect(() =>
			compileWorkflowRecipe({ proposal: proposal({ stages }), tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/recipe_invalid/);
	});

	it("rejects path aliases in generated outputs", () => {
		const stages = proposal().stages.map((item, index) =>
			index === 0 ? { ...item, generatedOutputPaths: ["artifacts/out/e\u0301.json"] } : item,
		);
		expect(() =>
			compileWorkflowRecipe({ proposal: proposal({ stages }), tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/recipe_invalid/);
	});

	it("rejects weak or aliased host overlay gates", () => {
		const extraHostGate = proposal({
			gates: [
				...proposal().gates,
				{ id: "host_adjudication", kind: "host_adjudication", evidencePolicyId: "universal" },
			],
		});
		expect(() =>
			compileWorkflowRecipe({ proposal: extraHostGate, tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/unknown_gate|missing_universal_gate/);
		const weakEvidence = proposal({
			evidencePolicies: proposal().evidencePolicies.map((policy) =>
				policy.id === "universal" ? { ...policy, independent: false } : policy,
			),
		});
		expect(() =>
			compileWorkflowRecipe({ proposal: weakEvidence, tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/missing_universal_gate/);
	});

	it("requires an opaque host-only holdout binding", () => {
		const review = proposal().overlays.preEvaluationOverfitting;
		if (review === undefined) throw new Error("fixture review is missing");
		const withoutHoldout = proposal({
			overlays: {
				...proposal().overlays,
				preEvaluationOverfitting: { ...review, opaqueHoldoutRef: undefined },
			},
		});
		expect(() =>
			compileWorkflowRecipe({ proposal: withoutHoldout, tasks: recipeTasks(), graphContext: graphContext() }),
		).toThrow(/missing_overfitting_review/);
		const workerHost = hostPort();
		expect(() =>
			compileWorkflowRecipe({
				proposal: proposal(),
				tasks: recipeTasks(),
				graphContext: graphContext(),
				host: {
					...workerHost,
					opaqueHoldoutReceipt: {
						...workerHost.opaqueHoldoutReceipt,
						receipt: { ...workerHost.opaqueHoldoutReceipt.receipt, verificationDigest: "f".repeat(64) },
					},
				},
			}),
		).toThrow(/opaque_holdout_unresolved/);
	});

	it("rejects duplicate optional catalog recipe IDs", () => {
		const duplicate = proposal({ recipeId: "superpowers:duplicate" });
		expect(() =>
			resolveWorkflowRecipe({
				requestedRecipeId: "superpowers:duplicate",
				optional: true,
				catalog: [duplicate, structuredClone(duplicate)],
				tasks: recipeTasks(),
				graphContext: graphContext(),
			}),
		).toThrow(/recipe_catalog_duplicate/);
	});

	it("uses locale-independent canonical ordering", () => {
		const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
			throw new Error("locale-sensitive ordering is forbidden");
		});
		try {
			expect(() =>
				compileWorkflowRecipe({ proposal: proposal(), tasks: recipeTasks(), graphContext: graphContext() }),
			).not.toThrow();
		} finally {
			localeCompare.mockRestore();
		}
	});

	it("canonicalizes order and digest without changing the graph binding", () => {
		const first = compileWorkflowRecipe({ proposal: proposal(), tasks: recipeTasks(), graphContext: graphContext() });
		const second = compileWorkflowRecipe({
			proposal: {
				...proposal(),
				stages: [...proposal().stages].reverse(),
				gates: [...proposal().gates].reverse(),
				evidencePolicies: [...proposal().evidencePolicies].reverse(),
				edges: [...proposal().edges].reverse(),
			},
			tasks: [...recipeTasks()].reverse(),
			graphContext: graphContext(),
		});
		expect(first.recipeDigest).toBe(second.recipeDigest);
		expect(first.effectiveGraphDigest).toBe(second.effectiveGraphDigest);
		expect(digestObject(first.tasks)).toBe(digestObject(second.tasks));
	});

	it("returns a typed capability gap for a requested missing optional recipe", () => {
		const result = resolveWorkflowRecipe({
			requestedRecipeId: "superpowers:panel",
			optional: true,
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});
		expect(result).toMatchObject({ kind: "capability_gap", code: "capability_gap", capability: "superpowers" });
		if (result.kind === "capability_gap") expect(result.fallback).toBe("none");
	});

	it("does not hide a missing optional recipe behind ordinary DAG compilation", () => {
		const result = resolveWorkflowRecipe({
			requestedRecipeId: "superpowers:missing",
			optional: true,
			proposal: proposal(),
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});
		expect(result.kind).toBe("capability_gap");
	});

	it("rejects a proposal whose declared task graph digest does not match", () => {
		expect(() =>
			compileWorkflowRecipe({
				proposal: proposal({ taskGraphDigest: "stale-graph" }),
				tasks: recipeTasks(),
				graphContext: graphContext(),
			}),
		).toThrow(/compiled_graph_mismatch/);
	});

	it("exposes both required built-in topologies as proposal-only graphs", () => {
		expect(BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM.stages.map(({ role }) => role)).toEqual([
			"recon",
			"lens",
			"verify",
			"synthesize",
			"red-team",
		]);
		expect(BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST.stages.map(({ role }) => role)).toEqual([
			"attack",
			"architect",
			"judge",
			"unify",
			"edge-test",
		]);
		expect(BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST.loops?.[0]?.maxTraversals).toBe(2);
	});

	it("compiles both built-in topologies against existing task DAGs", () => {
		const recon = compileWorkflowRecipe({
			proposal: BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM,
			tasks: recipeTasks(),
			graphContext: graphContext(),
		});
		const attack = compileWorkflowRecipe({
			proposal: BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST,
			tasks: attackTasks(),
			graphContext: graphContext(),
		});
		expect(recon.effectiveGraphDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(attack.recipe.overlays.preEvaluationOverfitting?.blockingBoundaries).toContain("completion");
	});

	it("compiles the comprehensive topology with dividing fan-outs and per-stage compute classes", () => {
		const compiled = compileWorkflowRecipe({
			proposal: BUILTIN_COMPREHENSIVE_RECIPE,
			tasks: comprehensiveTasks(),
			graphContext: graphContext(),
		});
		expect(compiled.effectiveGraphDigest).toMatch(/^[0-9a-f]{64}$/);

		// Fan-out branches must divide work, so every branch carries a distinct charter.
		const reconBranches = ["recon-code", "recon-tests", "recon-history"];
		const charters = reconBranches.map((stageId) => COMPREHENSIVE_BRANCH_CHARTERS[stageId]);
		expect(new Set(charters).size).toBe(reconBranches.length);
		expect(charters.every((charter) => charter !== undefined && charter.length > 0)).toBe(true);

		// Survey stages run cheap; adjudicating stages run deep.
		const computeByStage = new Map(compiled.recipe.stages.map((stage) => [stage.id, stage.computeClass]));
		expect(computeByStage.get("recon-code")).toBe("cheap");
		expect(computeByStage.get("lens-security")).toBe("cheap");
		expect(computeByStage.get("red-team")).toBe("deep");
		expect(computeByStage.get("adversarial-review")).toBe("deep");

		// The intent-TDD chain is present and stays linear.
		for (const stageId of WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS) {
			expect(computeByStage.has(stageId)).toBe(true);
		}
	});

	it("requires host-enforced intentional TDD evidence for implementation promotion", () => {
		const implementationHost = hostPort(
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.overlays.preEvaluationOverfitting?.opaqueHoldoutRef,
			WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
		);
		const { intentTddGateReceipt: _intentReceipt, ...withoutTddGate } = implementationHost;
		expect(() =>
			compileWorkflowRecipe({
				proposal: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
				tasks: implementationTasks(),
				graphContext: graphContext(),
				host: withoutTddGate,
			}),
		).toThrow(/intent_tdd_gate_invalid/);
		const compiled = compileWorkflowRecipe({
			proposal: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
			tasks: implementationTasks(),
			graphContext: graphContext(),
			evidence: implementationEvidence(implementationHost),
		});
		expect(compiled.intentTddGate).toMatchObject({
			promotionConstraints: WORKFLOW_RECIPE_INTENT_TDD_PROMOTION_CONSTRAINTS,
			evidenceRequirements: expect.arrayContaining([
				expect.objectContaining({
					stageId: "acceptance-red",
					evidenceKind: "black_box_acceptance_red",
					requiredClaims: ["public_boundary", "observed_failure", "forbidden_outcomes"],
				}),
			]),
		});
		const tddReceipt = implementationHost.intentTddGateReceipt;
		if (tddReceipt === undefined) throw new Error("fixture TDD receipt is missing");
		const weakTddReceipt = makeRecipeReceipt(
			implementationHost.context,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
			"intent_tdd_gate",
			{ ...tddReceipt.payload, promotionConstraints: ["reject_unit_only"] as const },
		);
		expect(() =>
			compileWorkflowRecipe({
				proposal: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
				tasks: implementationTasks(),
				graphContext: graphContext(),
				host: {
					...implementationHost,
					intentTddGateReceipt: weakTddReceipt,
				},
			}),
		).toThrow(/intent_tdd_gate_invalid/);
	});

	it("revalidates persisted intent evidence through the host artifact resolver before consumption", async () => {
		const host = hostPort(
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.overlays.preEvaluationOverfitting?.opaqueHoldoutRef,
			WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
		);
		const evidence = implementationEvidence(host);
		const compiled = compileWorkflowRecipe({
			proposal: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
			tasks: implementationTasks(),
			graphContext: graphContext(),
			host,
			evidence,
		});
		const registration = compiled.admission.registrationReceipt;
		if (registration === undefined) throw new Error("fixture registration receipt is missing");
		for (const binding of evidence) {
			if (binding.processReceipt === null) throw new Error(`fixture process receipt is missing: ${binding.stageId}`);
			await host.context.receiptContext.receiptResolver.consumeIfOneUse({
				receipt: binding.processReceipt.receipt,
				workflowId: binding.processReceipt.receipt.workflowId,
				expectedBindingDigest: binding.processReceipt.receipt.bindingDigest,
				currentRevision: binding.processReceipt.receipt.revision,
			});
			await host.context.receiptContext.receiptResolver.consumeIfOneUse({
				receipt: binding.validationReceipt,
				workflowId: binding.validationReceipt.workflowId,
				expectedBindingDigest: binding.validationReceipt.bindingDigest,
				currentRevision: binding.validationReceipt.revision,
			});
		}
		await host.context.receiptContext.receiptResolver.consumeIfOneUse({
			receipt: registration.receipt,
			workflowId: registration.receipt.workflowId,
			expectedBindingDigest: registration.receipt.bindingDigest,
			currentRevision: registration.receipt.revision,
		});
		let artifactReads = 0;
		const artifactResolver = host.context.receiptContext.artifactResolver;
		const hostWithReads = {
			...host,
			context: {
				...host.context,
				receiptContext: {
					...host.context.receiptContext,
					artifactResolver: {
						resolve: async (ref: Parameters<typeof artifactResolver.resolve>[0]) => {
							artifactReads += 1;
							return artifactResolver.resolve(ref);
						},
					},
				},
			},
		} as WorkflowRecipeHostResolutionPort;
		let consumed = false;
		await consumeWorkflowRecipeAdmissionAtHost({
			admission: compiled.admission,
			host: hostWithReads,
			consumer: {
				consumeWorkflowRecipeAdmission: () => {
					consumed = true;
				},
			},
		});
		expect(consumed).toBe(true);
		expect(artifactReads).toBeGreaterThan(WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.length);
	});

	it("rejects intent-TDD evidence that names non-commit SHAs", () => {
		const host = hostPort(
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.overlays.preEvaluationOverfitting?.opaqueHoldoutRef,
			WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
		);
		const evidence = implementationEvidence(host).map((binding, index) =>
			index === 0
				? {
						...binding,
						baseSha: "4".repeat(40),
						ancestorShas: [binding.candidateSha, "4".repeat(40), binding.reviewedHeadSha],
						baseAncestorShas: ["4".repeat(40)],
					}
				: binding,
		);
		expect(() =>
			compileWorkflowRecipe({
				proposal: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
				tasks: implementationTasks(),
				graphContext: graphContext(),
				host,
				evidence,
			}),
		).toThrow(/commit|git|ancestor|sha/i);
	});

	it("rejects keyword-stuffed RED evidence with an impossible host ordering witness", () => {
		const host = hostPort(
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.overlays.preEvaluationOverfitting?.opaqueHoldoutRef,
			WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
		);
		const evidence = implementationEvidence(host).map((binding) =>
			binding.stageId === "acceptance-red"
				? (() => {
						const envelope = {
							...binding.envelope,
							claim: "intent forbidden outcomes public boundary observed failure candidate sha green result integration sha durability authority receipt metamorphic race mutation anti-cheating reviewed head no base merge worktree decision",
							result: "green",
							method: "keyword-only claim with no durable RED ordering",
						};
						const payloadDigest = digestObject(envelope);
						const metadataDigest = digestObject({
							stageId: binding.stageId,
							intentBinding: binding.intentBinding,
							baseSha: binding.baseSha,
							preCandidateSha: binding.preCandidateSha,
							candidateSha: binding.candidateSha,
							integrationSha: binding.integrationSha,
							reviewedHeadSha: binding.reviewedHeadSha,
							ancestorShas: binding.ancestorShas,
							baseAncestorShas: binding.baseAncestorShas,
							noBaseMerge: binding.noBaseMerge,
							worktreeDecision: binding.worktreeDecision,
							worktreeRoot: binding.worktreeRoot,
							worktreeStatusDigest: binding.worktreeStatusDigest,
							outOfScopePaths: binding.outOfScopePaths,
							reviewerIdentityDigest: binding.reviewerIdentityDigest,
							reviewerRole: binding.reviewerRole,
							attackResultArtifactRef: binding.attackResultArtifactRef,
						});
						const bindingDigest = digestObject({
							kind: "workflow-recipe-receipt-binding",
							receiptKind: "tdd_evidence",
							workflowId: host.context.workflowId,
							recipeId: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
							revision: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
							registryManifestDigest: host.context.registryManifestDigest,
							hostKeyId: host.context.hostKeyId,
							epochRef: host.context.epochRef,
							headDigest: host.context.headDigest,
							currentDecisionDigest: host.context.currentDecisionDigest,
							contextDigest: host.context.contextDigest,
							payloadDigest,
							metadataDigest,
						});
						const receiptWithoutVerificationDigest = {
							...binding.validationReceipt,
							bindingDigest,
							payloadDigest,
							verificationDigest: "",
						};
						const validationReceipt = {
							...receiptWithoutVerificationDigest,
							verificationDigest: digestObject(receiptWithoutVerificationDigest),
						};
						return {
							...binding,
							envelope,
							validationReceipt,
							consumptionWitness: {
								...binding.consumptionWitness,
								bindingDigest,
								consumptionSequence: 99,
							},
						};
					})()
				: binding,
		);
		expect(() =>
			compileWorkflowRecipe({
				proposal: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
				tasks: implementationTasks(),
				graphContext: graphContext(),
				host,
				evidence,
			}),
		).toThrow(/host|ordering|receipt|red/i);
	});

	it("rejects a self-minted no-op host receipt context", () => {
		const baseHost = hostPort();
		const noOpHost = {
			...baseHost,
			context: {
				...baseHost.context,
				authenticatedReceiptResolver: { verifyConsumedReceipt: () => true },
				receiptContext: {
					receiptResolver: {
						resolve: async (input: { receipt: WorkflowVerifiedHostReceipt }) => input.receipt,
						consumeIfOneUse: async () => undefined,
						resolveConsumptionWitness: async (input: {
							receiptId: string;
							workflowId: string;
							bindingDigest: string;
						}) => ({
							receiptId: input.receiptId,
							workflowId: input.workflowId,
							bindingDigest: input.bindingDigest,
							consumedAt: baseHost.context.issuedAt,
							consumptionSequence: 1,
						}),
					},
					keyResolver: {
						resolve: async () => ({ algorithm: "ed25519" as const, verify: () => true }),
					},
					revokedReceiptIds: new Set<string>(),
					artifactResolver: {
						resolve: async (ref: WorkflowVerifiedHostReceipt["artifactRef"]) => ({
							envelope: {
								ref,
								payloadKind: "evidence" as const,
								codec: "canonical_json" as const,
								immutable: true as const,
							},
							exists: true as const,
							bytes: new Uint8Array(ref.sizeBytes),
							verifiedDigest: ref.digest,
							verifiedSizeBytes: ref.sizeBytes,
						}),
					},
				},
			},
		} as unknown as WorkflowRecipeHostResolutionPort;
		expect(() =>
			compileWorkflowRecipe({
				proposal: proposal(),
				tasks: recipeTasks(),
				graphContext: graphContext(),
				host: noOpHost,
			}),
		).toThrow(/authenticated|authority|receipt/i);
	});

	it("rejects self-consistent command evidence without a host process receipt", () => {
		const host = hostPort(
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.overlays.preEvaluationOverfitting?.opaqueHoldoutRef,
			WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
		);
		const evidence = implementationEvidence(host).map((binding, index) => {
			if (index !== 1) return binding;
			const withoutProcessReceipt = structuredClone(binding) as unknown as Record<string, unknown>;
			delete withoutProcessReceipt.processReceipt;
			return withoutProcessReceipt as unknown as WorkflowRecipeEvidenceBinding;
		});
		expect(() =>
			compileWorkflowRecipe({
				proposal: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
				tasks: implementationTasks(),
				graphContext: graphContext(),
				evidence,
			}),
		).toThrow(/process receipt/i);
	});

	it("accepts an explicit shared-safe worktree decision for small intent-TDD changes", () => {
		const host = hostPort(
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.overlays.preEvaluationOverfitting?.opaqueHoldoutRef,
			WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
		);
		const evidence = implementationEvidence(host, "shared-safe");

		expect(() =>
			compileWorkflowRecipe({
				proposal: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
				tasks: implementationTasks(),
				graphContext: graphContext(),
				evidence,
			}),
		).not.toThrow();
	});

	it("requires integration to be an ancestor of or equal to the exact base SHA", () => {
		const host = hostPort(
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.overlays.preEvaluationOverfitting?.opaqueHoldoutRef,
			WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
		);
		const evidence = implementationEvidence(host).map((binding, index) =>
			index < 3
				? binding
				: {
						...binding,
						baseAncestorShas: [binding.baseSha],
					},
		);

		expect(() =>
			compileWorkflowRecipe({
				proposal: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
				tasks: implementationTasks(),
				graphContext: graphContext(),
				evidence,
			}),
		).toThrow(/ancestor|base|integration/i);
	});

	it("rejects intent-TDD evidence that aliases integration to the base commit", () => {
		const host = hostPort(
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.overlays.preEvaluationOverfitting?.opaqueHoldoutRef,
			WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
		);
		const evidence = implementationEvidence(host).map((binding, index) =>
			index < 3
				? binding
				: rebindIntentEvidenceReceipt(host, binding, {
						integrationSha: binding.baseSha,
						baseAncestorShas: [binding.baseSha],
						ancestorShas: [binding.candidateSha, binding.baseSha, binding.reviewedHeadSha],
					}),
		);
		expect(() =>
			compileWorkflowRecipe({
				proposal: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
				tasks: implementationTasks(),
				graphContext: graphContext(),
				host,
				evidence,
			}),
		).toThrow(/integration|base|candidate/i);
	});

	it("rejects a self-minted independent reviewer identity", () => {
		const host = hostPort(
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.overlays.preEvaluationOverfitting?.opaqueHoldoutRef,
			WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
		);
		const evidence = implementationEvidence(host).map((binding, index) =>
			index === 5 ? rebindIntentEvidenceReceipt(host, binding, { reviewerIdentityDigest: "f".repeat(64) }) : binding,
		);
		expect(() =>
			compileWorkflowRecipe({
				proposal: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
				tasks: implementationTasks(),
				graphContext: graphContext(),
				host,
				evidence,
			}),
		).toThrow(/reviewer|principal|identity/i);
	});

	it("exposes only the intent-TDD gate in admission artifacts", () => {
		const host = hostPort(
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.recipeId,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.revision,
			BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE.overlays.preEvaluationOverfitting?.opaqueHoldoutRef,
			WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
		);
		const compiled = compileWorkflowRecipe({
			proposal: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
			tasks: implementationTasks(),
			graphContext: graphContext(),
			evidence: implementationEvidence(host),
		});
		const admission = compiled.admission as unknown as Record<string, unknown>;

		expect(admission).toHaveProperty("intentTddGate");
		expect((admission as { intentTddGate: unknown }).intentTddGate).toEqual(compiled.intentTddGate);
		expect((admission as { recipeBinding: { intentTddGate: unknown } }).recipeBinding.intentTddGate).toEqual(
			compiled.intentTddGate,
		);
		expect(Object.keys(admission).every((key) => !key.toLowerCase().includes("implementationtdd"))).toBe(true);
	});

	it("rejects a reversed intentional TDD dependency", () => {
		const reversedTasks = implementationTasks().map((item) =>
			item.taskId === "implementation-green" ? { ...item, dependencyTaskIds: ["intent"] } : item,
		);
		expect(() =>
			compileWorkflowRecipe({
				proposal: BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
				tasks: reversedTasks,
				graphContext: graphContext(),
			}),
		).toThrow(/edge|TDD|dependency|order/i);
	});

	it("rejects write authority on planning roles", () => {
		const planningStage = proposal().stages.map((item, index) =>
			index === 0 ? { ...item, role: "planning", capabilityIds: ["read", "write_owned_paths"] } : item,
		);
		expect(() =>
			compileWorkflowRecipe({
				proposal: proposal({ stages: planningStage }),
				tasks: recipeTasks(),
				graphContext: graphContext(),
			}),
		).toThrow(/authority|read.only|planning|capability/i);
	});
});

function attackTasks(): readonly WorkflowTask[] {
	return [
		task("attack"),
		task("architect", ["attack"]),
		task("judge", ["architect"]),
		task("unify", ["judge"]),
		task("edge-test", ["unify"]),
	];
}

function implementationTasks(): readonly WorkflowTask[] {
	return [
		task("intent"),
		task("acceptance-red", ["intent"]),
		task("implementation-green", ["acceptance-red"]),
		task("integration", ["implementation-green"]),
		task("metamorphic", ["integration"]),
		task("independent-verification", ["metamorphic"]),
		task("adversarial-review", ["independent-verification"]),
	];
}
