import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Skill } from "../../src/core/skills.js";
import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import { resolveWorkflowRuntimeConfig } from "../../src/core/workflow/config.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	sha256Hex,
	type WorkflowArtifactCodec,
	type WorkflowArtifactPayloadKind,
	type WorkflowArtifactPublisher,
	type WorkflowArtifactReadResult,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowControlCapacityVector,
	type WorkflowDecisionRef,
	type WorkflowEpochRef,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowResourceVector,
	type WorkflowTask,
	type WorkflowVerifiedHostReceipt,
} from "../../src/core/workflow/contracts.js";
import { createNodeWorkflowDescriptorFs } from "../../src/core/workflow/node-descriptor-fs.js";
import {
	createPrimeWorkflowBuiltinAdapters,
	type PrimeWorkflowAuthenticatedAdapterFactory,
	type PrimeWorkflowSnapshots,
} from "../../src/core/workflow/prime-loop.js";
import {
	BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM,
	compileWorkflowRecipe,
	consumeWorkflowRecipeAdmissionAtHost,
	createWorkflowRecipeRegisteredManifest,
	DEFAULT_WORKFLOW_RECIPE_REGISTRY,
	WORKFLOW_RECIPE_CANONICAL_NATIVE_CAPABILITY_SNAPSHOTS,
	WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
	WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID,
	WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID,
	type WorkflowRecipeAdmissionArtifact,
	type WorkflowRecipeAdmissionHostRegistrationProof,
	type WorkflowRecipeHostResolutionPort,
	type WorkflowRecipeOpaqueHoldout,
	type WorkflowRecipeOverfittingGateReceiptPayload,
	type WorkflowRecipeProposal,
	type WorkflowRecipeReceiptConsumptionWitness,
	type WorkflowRecipeUniversalGateBinding,
	type WorkflowRecipeVerifiedHostReceipt,
} from "../../src/core/workflow/recipes.js";
import {
	createSkillSnapshot,
	createWorkflowSkillDescriptorInvocationStore,
	createWorkflowSkillProductionExecutionAdapter,
	createWorkflowSkillRuntimeStoreHostStateReader,
	getWorkflowResourceLoaderProvenanceDigests,
	getWorkflowResourceLoaderReceiptBindingDigest,
	type WorkflowResourceLoaderPort,
	type WorkflowResourceLoaderResult,
	type WorkflowSkillDependency,
	type WorkflowSkillSnapshot,
} from "../../src/core/workflow/skill-snapshots.js";

const { privateKey: SKILL_EXECUTION_PRIVATE_KEY } = generateKeyPairSync("ed25519");

const TRUSTED_NOW = "2030-01-01T00:00:00.000Z";
const VALID_UNTIL = "2035-01-01T00:00:00.000Z";
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

interface PublishedArtifact {
	readonly bytes: Uint8Array;
	readonly payloadKind: WorkflowArtifactPayloadKind;
	readonly codec: WorkflowArtifactCodec;
	readonly ref: WorkflowArtifactRef;
}

interface ArtifactFixture {
	readonly resolver: WorkflowArtifactResolver;
	readonly publisher: WorkflowArtifactPublisher;
	readonly seed: (
		ref: WorkflowArtifactRef,
		bytes: Uint8Array,
		payloadKind: WorkflowArtifactPayloadKind,
		codec: WorkflowArtifactCodec,
	) => void;
}

interface SkillFixture {
	readonly snapshot: WorkflowSkillSnapshot;
	readonly loader: WorkflowResourceLoaderPort;
	readonly artifacts: ArtifactFixture;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
}

function createArtifactFixture(): ArtifactFixture {
	const records = new Map<string, PublishedArtifact>();
	const resolver: WorkflowArtifactResolver = {
		resolve: async (ref): Promise<WorkflowArtifactReadResult> => {
			const record = records.get(`${ref.artifactId}:${ref.digest}`);
			if (record === undefined) throw new Error("prime_fixture_artifact_missing");
			return {
				envelope: { ref: record.ref, payloadKind: record.payloadKind, codec: record.codec, immutable: true },
				exists: true,
				bytes: Uint8Array.from(record.bytes),
				verifiedDigest: sha256Hex(record.bytes),
				verifiedSizeBytes: record.bytes.byteLength,
			};
		},
	};
	const seed = (
		ref: WorkflowArtifactRef,
		bytes: Uint8Array,
		payloadKind: WorkflowArtifactPayloadKind,
		codec: WorkflowArtifactCodec,
	): void => {
		records.set(`${ref.artifactId}:${ref.digest}`, {
			bytes: Uint8Array.from(bytes),
			payloadKind,
			codec,
			ref: { ...ref },
		});
	};
	const publisher: WorkflowArtifactPublisher = {
		publish: async (input) => {
			const digest = sha256Hex(input.bytes);
			const ref: WorkflowArtifactRef = {
				artifactId: input.idempotencyKey,
				relativePath: `artifacts/skills/${digest}`,
				digest,
				sizeBytes: input.bytes.byteLength,
				sourceEventSequence: input.sourceEventSequence,
			};
			const key = `${ref.artifactId}:${ref.digest}`;
			if (!records.has(key)) seed(ref, input.bytes, input.payloadKind, input.codec);
			return {
				status: records.has(key) ? "already_published" : "published",
				envelope: { ref, payloadKind: input.payloadKind, codec: input.codec, immutable: true },
			};
		},
	};
	return { resolver, publisher, seed };
}

function fixtureArtifactBytes(ref: WorkflowArtifactRef): Uint8Array {
	return canonicalJsonBytes({
		artifactId: ref.artifactId,
		relativePath: ref.relativePath,
		sourceEventSequence: ref.sourceEventSequence,
		payloadDigest: "fixture",
	});
}

function recipeReceipt<TPayload>(
	context: WorkflowRecipeHostResolutionPort["context"],
	proposal: WorkflowRecipeProposal,
	kind: string,
	payload: TPayload,
): WorkflowRecipeVerifiedHostReceipt<TPayload> {
	const receiptKind: WorkflowVerifiedHostReceipt["receiptKind"] =
		kind === "opaque_holdout"
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
		recipeId: proposal.recipeId,
		revision: proposal.revision,
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
		receiptId: `prime-fixture-${kind}-${proposal.recipeId}`,
		issuerId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
		workflowId: context.workflowId,
		bindingDigest,
		payloadDigest,
		artifactRef: {
			artifactId: `prime-fixture-${kind}`,
			relativePath: `artifacts/evidence/${kind}.json`,
			digest: "0".repeat(64),
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		issuedAt: context.issuedAt,
		validUntil: context.validUntil,
		keyId: context.hostKeyId,
		stateDigest: context.headDigest,
		revision: proposal.revision,
		oneUse: true,
	});
	return {
		receipt,
		payload,
		consumptionWitness: {
			receiptId: receipt.receiptId,
			workflowId: receipt.workflowId,
			bindingDigest: receipt.bindingDigest,
			capability: receipt.capabilityBinding?.capability ?? null,
			resourceDigest: receipt.capabilityBinding?.resourceDigest ?? null,
			operationDigest: receipt.capabilityBinding?.operationDigest ?? null,
			receiptDigest: digestObject(receipt),
			headDigest: context.headDigest,
			consumedAt: context.issuedAt,
			consumptionSequence: 1,
		},
	};
}

function recipeHost(
	workflowId: string,
	epochRef: WorkflowEpochRef,
	proposal: WorkflowRecipeProposal,
	headDigest = sha256Hex("prime-fixture-head"),
): WorkflowRecipeHostResolutionPort {
	const pathBoundary = {
		descriptorKind: "host_workspace_descriptor" as const,
		effectBoundaryKind: "host_effect_boundary" as const,
		descriptorDigest: digestObject({ workflowId, kind: "descriptor" }),
		effectBoundaryDigest: digestObject({ workflowId, kind: "effect-boundary" }),
		workspacePaths: ["src"],
		generatedOutputPaths: ["artifacts/out"],
	};
	const { revokeReceipt: _revokeReceipt, ...baseReceiptContext } = createFixtureHostReceiptConsumerContext();
	const contextBase = {
		authorityId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID as "prime-workflow-host-authority",
		hostKeyId: "fixture-key",
		workflowId,
		registryManifestDigest: DEFAULT_WORKFLOW_RECIPE_REGISTRY.manifestDigest,
		epochRef,
		currentDecisionDigest: sha256Hex("prime-fixture-decision"),
		headDigest,
		issuedAt: TRUSTED_NOW,
		validUntil: VALID_UNTIL,
		pathBoundaryDigest: digestObject(pathBoundary),
	};
	const receiptContext: WorkflowHostReceiptConsumerContext = {
		...baseReceiptContext,
		keyResolver: {
			resolve: async (keyId) => ({
				...(await baseReceiptContext.keyResolver.resolve(keyId)),
				ownerPrincipal: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
			}),
		},
		receiptResolver: {
			...baseReceiptContext.receiptResolver,
			resolveConsumptionWitness: async (input) => ({
				...(await baseReceiptContext.receiptResolver.resolveConsumptionWitness(input)),
				consumedAt: contextBase.issuedAt,
				consumptionSequence: 1,
			}),
		},
	};
	const consumedAdmissionIds = new Set<string>();
	const context = {
		...contextBase,
		contextDigest: digestObject({ kind: "workflow-recipe-host-context", ...contextBase }),
		receiptContext,
		authenticatedReceiptResolver: {
			verifyConsumedReceipt: (input: {
				receipt: WorkflowVerifiedHostReceipt;
				payload: unknown;
				consumptionWitness: WorkflowRecipeReceiptConsumptionWitness;
				workflowId: string;
				expectedBindingDigest: string;
				currentHeadDigest: string;
				currentEpochRef: WorkflowEpochRef;
				currentDecisionDigest: string;
				hostKeyId: string;
				expectedAdmissionPreimageDigest?: string;
			}) => {
				const { signature: _signature, verificationDigest: _verificationDigest, ...signedFields } = input.receipt;
				const payload = input.payload as { recipeDigest?: unknown };
				return {
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
					...(typeof payload.recipeDigest === "string"
						? {
								admissionPreimageDigest: payload.recipeDigest,
								signedReceiptPreimageDigest: digestObject(signedFields),
							}
						: {}),
				};
			},
			consumeAdmissionAtHost: async (input: {
				admission: WorkflowRecipeAdmissionArtifact;
				registration: NonNullable<WorkflowRecipeAdmissionArtifact["registrationReceipt"]>;
				expectedBindingDigest: string;
				expectedAdmissionPreimageDigest: string;
				workflowId: string;
				currentHeadDigest: string;
				currentDecisionDigest: string;
				currentEpochRef: WorkflowEpochRef;
				currentRevision: number;
				consumer: () => void;
			}) => {
				const witness: WorkflowRecipeReceiptConsumptionWitness = {
					receiptId: input.registration.receipt.receiptId,
					workflowId: input.workflowId,
					bindingDigest: input.expectedBindingDigest,
					capability: input.registration.receipt.capabilityBinding?.capability ?? null,
					resourceDigest: input.registration.receipt.capabilityBinding?.resourceDigest ?? null,
					operationDigest: input.registration.receipt.capabilityBinding?.operationDigest ?? null,
					receiptDigest: digestObject(input.registration.receipt),
					headDigest: input.currentHeadDigest,
					consumedAt: input.registration.receipt.issuedAt,
					consumptionSequence: 1,
				};
				const status: "consumed" | "already_consumed" = consumedAdmissionIds.has(input.admission.admissionDigest)
					? "already_consumed"
					: "consumed";
				if (status === "consumed") {
					consumedAdmissionIds.add(input.admission.admissionDigest);
					input.consumer();
				}
				const proof = context.authenticatedReceiptResolver.verifyConsumedReceipt({
					receipt: input.registration.receipt,
					payload: input.registration.payload,
					consumptionWitness: witness,
					workflowId: input.workflowId,
					expectedBindingDigest: input.expectedBindingDigest,
					currentHeadDigest: input.currentHeadDigest,
					currentEpochRef: input.currentEpochRef,
					currentDecisionDigest: input.currentDecisionDigest,
					hostKeyId: input.registration.receipt.keyId,
					expectedAdmissionPreimageDigest: input.expectedAdmissionPreimageDigest,
				});
				if (proof === null) throw new Error("fixture admission proof missing");
				return {
					status,
					registration: { ...input.registration, consumptionWitness: witness },
					proof: proof as WorkflowRecipeAdmissionHostRegistrationProof,
				};
			},
		},
	};
	const universalGate: WorkflowRecipeUniversalGateBinding = {
		gateId: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID,
		stageIds: proposal.stages.map((stage) => stage.id),
		decisionDigest: context.currentDecisionDigest,
		scorecardDigest: digestObject({ workflowId, kind: "scorecard" }),
		evaluatorDigest: digestObject({ workflowId, kind: "evaluator" }),
		terminal: true as const,
		hostOwned: true as const,
	};
	const opaqueHoldout: WorkflowRecipeOpaqueHoldout = {
		handleId: proposal.overlays.preEvaluationOverfitting?.opaqueHoldoutRef ?? `prime-fixture-holdout:${workflowId}`,
		manifestDigest: digestObject({ workflowId, kind: "holdout-manifest" }),
		resolverContextId: `prime-fixture-resolver:${workflowId}`,
		authorizationReceiptDigest: digestObject({ workflowId, kind: "holdout-receipt" }),
		owner: "host" as const,
		hidden: true as const,
		opaque: true as const,
		hostResolverOnly: true as const,
		authenticated: true as const,
		returnsEvidenceOnly: true as const,
		returnsBytes: false as const,
	};
	const overfittingGate: WorkflowRecipeOverfittingGateReceiptPayload = {
		gateId: WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID,
		blocking: true as const,
		freshnessDigest: digestObject({ workflowId, kind: "freshness" }),
		reviewerResultDigest: digestObject({ workflowId, kind: "review" }),
		authenticatedReviewer: true as const,
		opaqueHoldoutManifestDigest: opaqueHoldout.manifestDigest,
		opaqueHoldoutEvidenceDigest: digestObject({ workflowId, kind: "holdout-evidence" }),
	};
	const nativeCapabilitySnapshots = WORKFLOW_RECIPE_CANONICAL_NATIVE_CAPABILITY_SNAPSHOTS.map((snapshot) => ({
		...snapshot,
		immutable: true as const,
		builtIn: true as const,
	}));
	const host: WorkflowRecipeHostResolutionPort = {
		registryManifestDigest: DEFAULT_WORKFLOW_RECIPE_REGISTRY.manifestDigest,
		pathBoundary,
		context,
		nativeCapabilitySnapshots,
		nativeCapabilitySnapshotReceipts: nativeCapabilitySnapshots.map((snapshot) =>
			recipeReceipt(context, proposal, "native_capability_snapshot", snapshot),
		),
		opaqueHoldoutReceipt: recipeReceipt(context, proposal, "opaque_holdout", opaqueHoldout),
		universalGateReceipt: recipeReceipt(context, proposal, "universal_gate", universalGate),
		overfittingGateReceipt: recipeReceipt(context, proposal, "overfitting_gate", overfittingGate),
	};
	const registeredManifest = createWorkflowRecipeRegisteredManifest({
		proposal,
		tasks: createPrimeWorkflowTasks(),
		graphContext: graphContext(),
		host,
	});
	return {
		...host,
		registeredManifestReceipt: recipeReceipt(context, proposal, "recipe_registration", registeredManifest),
	};
}

function graphContext() {
	return {
		knownSkillSnapshotDigests: [],
		allowedAuthority: ["read_workspace" as const],
		workspacePaths: ["src"],
		generatedOutputPaths: ["artifacts/out"],
		namedContracts: [],
	};
}

export function createPrimeWorkflowTasks(): readonly WorkflowTask[] {
	const stageIds = ["recon", "lens", "verify", "synthesize", "red-team"] as const;
	return stageIds.map((taskId, index) => ({
		taskId,
		planRevision: 1,
		objective: taskId,
		requirementIds: [],
		completionCriteria: [],
		dependencyTaskIds: index === 0 ? [] : [stageIds[index - 1]],
		ownedPaths: [`src/${taskId}.ts`],
		ownedContracts: [],
		requiredSkillSnapshotDigests: [],
		verificationCommandDigests: [],
		authority: ["read_workspace" as const],
		declaredResourceVector: resourceVector,
		declaredControlCapacity: controlCapacity,
		status: "ready" as const,
		attemptIds: [],
	}));
}

function configSnapshot(contentDigest: string, epochRef: WorkflowEpochRef) {
	const closureMembers = ["prime-workflow", "authenticated-snapshots"];
	const closureManifestBytes = canonicalJsonBytes(closureMembers);
	const digest = (value: string): string => digestObject({ value });
	return resolveWorkflowRuntimeConfig({
		configSchemaVersion: 1,
		configRevision: 1,
		closureMembers,
		executionProfile: "parallel",
		runtimeIdentityDigest: digest("runtime"),
		repositoryPolicyDigest: digest("repository"),
		workspaceIdentityDigest: digest("workspace"),
		globalSettingsDigest: digest("global"),
		projectSettingsDigest: digest("project"),
		packageDefaultsDigest: digest("packages"),
		methodologyManifestDigests: [digest("methodology")],
		nativeMethodologyContractDigest: digest("native-methodology"),
		skillContentDigests: [contentDigest],
		skillDependencyDigests: [],
		evaluatorDigests: [digest("evaluator")],
		parserDigests: [digest("parser")],
		guardDigests: [digest("guard")],
		scorecardRuleDigest: digest("scorecard"),
		resourceInventoryDigest: digest("inventory"),
		resourceEnvelopePolicyDigest: digest("envelope"),
		egressPolicyDigest: digest("egress"),
		authorityPolicyDigest: digest("authority"),
		approvalPolicyDigest: digest("approval"),
		provenanceManifestDigest: digest("provenance"),
		daemonCapabilityDigest: digest("daemon"),
		decisionLimitsDigest: digest("limits"),
		schedulerPolicyDigest: digest("scheduler"),
		journalFormatDigest: digest("journal"),
		closureManifestRef: {
			artifactId: `prime-config-closure:${epochRef.storeEpoch}:${epochRef.coordinatorEpoch}`,
			relativePath: "artifacts/workflow/config/closure.json",
			digest: sha256Hex(closureManifestBytes),
			sizeBytes: closureManifestBytes.byteLength,
			sourceEventSequence: 1,
		},
		closureManifestBytes,
	});
}

async function skillSnapshot(
	artifactRoot: string,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	configDigest: string,
): Promise<SkillFixture> {
	const skillDir = join(artifactRoot, "prime-snapshot-skill");
	await mkdir(skillDir, { recursive: true });
	const filePath = join(skillDir, "SKILL.md");
	const body = "# Prime snapshot fixture\n\nThis immutable skill is admitted before scheduling.\n";
	await writeFile(filePath, body, "utf8");
	const skill: Skill = {
		name: "prime-snapshot-fixture",
		description: "Authenticated Prime workflow snapshot fixture",
		filePath,
		baseDir: skillDir,
		sourceInfo: createSyntheticSourceInfo(filePath, {
			source: "test",
			scope: "temporary",
			baseDir: skillDir,
		}),
		disableModelInvocation: false,
		kind: "markdown",
	};
	const loader: WorkflowResourceLoaderPort = { getSkills: () => ({ skills: [skill], diagnostics: [] }) };
	const loaderResult: WorkflowResourceLoaderResult = loader.getSkills();
	const loaderDigests = getWorkflowResourceLoaderProvenanceDigests(loaderResult, 1);
	const loaderReceipt = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: `prime-loader:${workflowId}`,
		issuerId: "ResourceLoader",
		workflowId,
		bindingDigest: getWorkflowResourceLoaderReceiptBindingDigest({
			workflowId,
			workspaceDigest: digestObject({ workflowId, kind: "workspace" }),
			loaderRevision: 1,
			loaderResultDigest: loaderDigests.loaderResultDigest,
		}),
		payloadDigest: loaderDigests.loaderResultDigest,
		artifactRef: {
			artifactId: `prime-loader-artifact:${workflowId}`,
			relativePath: "artifacts/skills/loader-receipt",
			digest: "0".repeat(64),
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		issuedAt: TRUSTED_NOW,
		validUntil: VALID_UNTIL,
		keyId: "fixture-key",
		stateDigest: loaderDigests.loaderResultDigest,
		revision: 1,
		oneUse: true,
	});
	const workspaceDigest = digestObject({ workflowId, kind: "workspace" });
	const artifacts = createArtifactFixture();
	artifacts.seed(
		loaderReceipt.artifactRef,
		fixtureArtifactBytes(loaderReceipt.artifactRef),
		"evidence",
		"canonical_json",
	);
	const baseReceiptContext = createFixtureHostReceiptConsumerContext();
	const receiptContext: WorkflowHostReceiptConsumerContext = {
		...baseReceiptContext,
		keyResolver: {
			resolve: async (keyId) => ({
				...(await baseReceiptContext.keyResolver.resolve(keyId)),
				ownerPrincipal: "ResourceLoader",
			}),
		},
		artifactResolver: artifacts.resolver,
	};
	const manifestFields = {
		requiredApprovalGates: ["user"],
		requiredArtifactKinds: ["evidence"],
		requiredPressureTests: ["red-team"],
		allowedTransitions: ["start"],
	};
	const manifestBytes = canonicalJsonBytes(manifestFields);
	const manifestRef: WorkflowArtifactRef = {
		artifactId: `prime-manifest:${workflowId}`,
		relativePath: "artifacts/skills/manifest",
		digest: sha256Hex(manifestBytes),
		sizeBytes: manifestBytes.byteLength,
		sourceEventSequence: 1,
	};
	artifacts.seed(manifestRef, manifestBytes, "evidence", "canonical_json");
	const snapshot = await createSkillSnapshot({
		workflowId,
		taskId: "recon",
		decisionRef: {
			decisionScope: { kind: "workflow", workflowId, rootSessionId: workflowId },
			decisionId: `prime-decision:${workflowId}`,
			revision: 1,
			storeEpoch: epochRef.storeEpoch,
			coordinatorEpoch: epochRef.coordinatorEpoch,
			decisionDigest: digestObject({ workflowId, kind: "decision" }),
		} satisfies WorkflowDecisionRef,
		journalHeadDigest: sha256Hex(`prime-head:${workflowId}`),
		skill,
		dependencies: [] satisfies readonly WorkflowSkillDependency[],
		manifest: { artifactRef: manifestRef, bytes: manifestBytes, contentDigest: sha256Hex(manifestBytes) },
		artifacts: artifacts.resolver,
		publisher: artifacts.publisher,
		workflowContractRevision: 1,
		configDigest,
		workspaceDigest,
		attemptId: `prime-attempt:${workflowId}`,
		loader,
		loaderProvenance: {
			issuedBy: "ResourceLoader",
			issuanceReceipt: loaderReceipt,
			loaderRevision: 1,
			workspaceDigest,
			sourceManifestDigest: loaderDigests.sourceManifestDigest,
			diagnosticsDigest: loaderDigests.diagnosticsDigest,
			artifactPathDigest: loaderDigests.artifactPathDigest,
			loaderResultDigest: loaderDigests.loaderResultDigest,
			artifactNamespace: "artifacts/skills",
		},
		receiptContext,
		trustedNow: TRUSTED_NOW,
		epochRef,
		sourceEventSequence: 1,
	});
	return { snapshot, loader, artifacts, receiptContext };
}

/** Build cryptographically checked config, recipe, and skill snapshots for the public host test. */
export async function createPrimeWorkflowFixture(
	artifactRoot: string,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	headDigest?: string,
): Promise<{
	snapshots: PrimeWorkflowSnapshots;
	recipeHost: WorkflowRecipeHostResolutionPort;
	adaptersFactory: PrimeWorkflowAuthenticatedAdapterFactory;
}> {
	const bodyDigest = sha256Hex("# Prime snapshot fixture\n\nThis immutable skill is admitted before scheduling.\n");
	const config = configSnapshot(bodyDigest, epochRef);
	const skillFixture = await skillSnapshot(artifactRoot, workflowId, epochRef, config.resolvedConfigDigest);
	const skill = skillFixture.snapshot;
	const proposal = BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM;
	const tasks = createPrimeWorkflowTasks();
	const graph = graphContext();
	const host = recipeHost(workflowId, epochRef, proposal, headDigest);
	const registeredManifest = createWorkflowRecipeRegisteredManifest({ proposal, tasks, graphContext: graph, host });
	const registeredManifestReceipt = recipeReceipt(host.context, proposal, "recipe_registration", registeredManifest);
	await host.context.receiptContext.receiptResolver.consumeIfOneUse({
		receipt: registeredManifestReceipt.receipt,
		workflowId,
		expectedBindingDigest: registeredManifestReceipt.receipt.bindingDigest,
		currentRevision: proposal.revision,
	});
	const registeredHost = { ...host, registeredManifestReceipt };
	const recipe = compileWorkflowRecipe({
		proposal,
		tasks,
		graphContext: graph,
		host: registeredHost,
		registeredManifest,
	}).admission;
	const snapshots: PrimeWorkflowSnapshots = Object.freeze({ config, recipe, skills: Object.freeze([skill]) });
	const adaptersFactory: PrimeWorkflowAuthenticatedAdapterFactory = async (input) => {
		const skillCasRoot = join(artifactRoot, "prime-skill-invocations");
		await mkdir(skillCasRoot, { recursive: true });
		const skillExecution = createWorkflowSkillProductionExecutionAdapter({
			loader: skillFixture.loader,
			loaderProvenance: skill.loaderProvenance,
			artifacts: skillFixture.artifacts.resolver,
			publisher: skillFixture.artifacts.publisher,
			receiptContext: skillFixture.receiptContext,
			invocationStore: createWorkflowSkillDescriptorInvocationStore({
				descriptorFs: createNodeWorkflowDescriptorFs(),
				rootPath: skillCasRoot,
				activeHostState: createWorkflowSkillRuntimeStoreHostStateReader(input.runtimeStore),
				signer: {
					keyId: "prime-skill-execution-key",
					signatureAlgorithm: "ed25519",
					sign: async (bytes) =>
						signBytes(null, Buffer.from(bytes), SKILL_EXECUTION_PRIVATE_KEY).toString("base64"),
				},
			}),
		});
		return createPrimeWorkflowBuiltinAdapters({
			...input,
			runId: skill.attemptId,
			executionKey: skill.snapshotDigest,
			skillExecution,
			consumeRecipeAdmission: (admission) =>
				consumeWorkflowRecipeAdmissionAtHost({
					admission,
					host: registeredHost,
					consumer: { consumeWorkflowRecipeAdmission: () => undefined },
				}),
		});
	};
	return { snapshots, recipeHost: registeredHost, adaptersFactory };
}
