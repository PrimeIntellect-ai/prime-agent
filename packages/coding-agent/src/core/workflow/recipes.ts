import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	canonicalJsonBytes,
	digestObject,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	type WorkflowEpochRef,
	type WorkflowEvidenceCommandObservation,
	type WorkflowEvidenceEnvelope,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowTask,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { validateWorkflowEvidenceEnvelope } from "./evidence.js";
import {
	parseWorkflowCanonicalPath,
	validateWorkflowTaskGraph,
	type WorkflowTaskGraph,
	type WorkflowTaskGraphContext,
} from "./task-graph.js";

export type { WorkflowTaskGraphContext } from "./task-graph.js";

/** Bounded limits for the proposal-only recipe surface. */
export const WORKFLOW_RECIPE_LIMITS = Object.freeze({
	maxStages: 64,
	maxGates: 64,
	maxCapabilities: 64,
	maxEvidencePolicies: 128,
	maxEdges: 256,
	maxFanOuts: 32,
	maxFanOutBranches: 16,
	maxLoops: 16,
	maxLoopTraversals: 32,
	maxEvidenceBytes: 8_388_608,
	maxEvidenceItems: 256,
});

export const WORKFLOW_RECIPE_SCHEMA_VERSION = 1;
export const WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID = "universal-host-decision-gate";
export const WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID = "pre_evaluation_overfitting";
/** Canonical intent-first TDD gate vocabulary. */
export const WORKFLOW_RECIPE_INTENT_TDD_GATE_ID = "intent-tdd";
export const WORKFLOW_RECIPE_IMPLEMENTATION_RECIPE_ID = "builtin:superpowers-prime-implementation";
export const WORKFLOW_RECIPE_HOST_AUTHORITY_ID = "prime-workflow-host-authority";

export const WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS = Object.freeze([
	"intent",
	"acceptance-red",
	"implementation-green",
	"integration",
	"metamorphic",
	"independent-verification",
	"adversarial-review",
] as const);

/** Registered host role backing each intent-TDD stage id. Stage ids are not themselves roles. */
const INTENT_TDD_STAGE_ROLES: Readonly<Record<string, string>> = Object.freeze({
	intent: "recon",
	"acceptance-red": "verify",
	"implementation-green": "implementation",
	integration: "integration",
	metamorphic: "verification",
	"independent-verification": "verification",
	"adversarial-review": "red-team",
});

export const WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_KINDS = Object.freeze([
	"intent_forbidden_outcomes",
	"black_box_acceptance_red",
	"implementation_green",
	"real_integration",
	"metamorphic_race_mutation_anti_cheating",
	"independent_verification",
	"adversarial_review",
] as const);

export const WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_CLAIMS = Object.freeze([
	"intent",
	"forbidden_outcomes",
	"public_boundary",
	"observed_failure",
	"candidate_sha",
	"green_result",
	"integration_sha",
	"durability_or_authority_receipt",
	"metamorphic",
	"race",
	"mutation",
	"anti_cheating",
	"reviewed_head",
	"no_base_merge",
	"worktree_decision",
] as const);

export const WORKFLOW_RECIPE_INTENT_TDD_PROMOTION_CONSTRAINTS = Object.freeze([
	"reject_unit_only",
	"reject_count_only",
	"reject_coverage_only",
	"coverage_diagnostic_only",
	"reject_mock_only",
	"require_real_integration",
	"require_independent_verification",
	"require_adversarial_review",
	"require_exact_candidate_sha",
	"require_integration_sha",
	"require_reviewed_head",
	"require_no_base_merge",
	"require_worktree_decision",
] as const);

/** Canonical forbidden outcomes bound into every intent-TDD evidence receipt. */
export const WORKFLOW_RECIPE_INTENT_TDD_FORBIDDEN_OUTCOMES = Object.freeze({
	intent: Object.freeze(["goal_unbound", "forbidden_outcome_unbound"]),
	"acceptance-red": Object.freeze(["promotion_without_red", "keyword_only_evidence", "red_after_implementation"]),
	"implementation-green": Object.freeze(["green_without_prior_red", "candidate_not_immutable"]),
	integration: Object.freeze(["integration_without_candidate", "authority_without_durable_receipt"]),
	metamorphic: Object.freeze(["mutation_not_rejected", "race_not_serialized", "anti_cheating_bypass"]),
	"independent-verification": Object.freeze(["verification_by_implementer", "review_without_exact_head"]),
	"adversarial-review": Object.freeze(["review_without_attack_artifact", "merge_or_worktree_bypass"]),
} as const);

export type WorkflowRecipeIntentTddEvidenceClaim = (typeof WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_CLAIMS)[number];
export type WorkflowRecipeIntentTddPromotionConstraint =
	(typeof WORKFLOW_RECIPE_INTENT_TDD_PROMOTION_CONSTRAINTS)[number];

export interface WorkflowRecipeIntentTddEvidenceRequirement {
	stageId: (typeof WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS)[number];
	evidenceKind: (typeof WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_KINDS)[number];
	requiredClaims: readonly WorkflowRecipeIntentTddEvidenceClaim[];
}

const WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_REQUIREMENTS: readonly WorkflowRecipeIntentTddEvidenceRequirement[] =
	Object.freeze([
		{
			stageId: "intent",
			evidenceKind: "intent_forbidden_outcomes",
			requiredClaims: ["intent", "forbidden_outcomes"],
		},
		{
			stageId: "acceptance-red",
			evidenceKind: "black_box_acceptance_red",
			requiredClaims: ["public_boundary", "observed_failure", "forbidden_outcomes"],
		},
		{
			stageId: "implementation-green",
			evidenceKind: "implementation_green",
			requiredClaims: ["candidate_sha", "green_result"],
		},
		{
			stageId: "integration",
			evidenceKind: "real_integration",
			requiredClaims: ["candidate_sha", "integration_sha", "durability_or_authority_receipt"],
		},
		{
			stageId: "metamorphic",
			evidenceKind: "metamorphic_race_mutation_anti_cheating",
			requiredClaims: ["candidate_sha", "metamorphic", "race", "mutation", "anti_cheating"],
		},
		{
			stageId: "independent-verification",
			evidenceKind: "independent_verification",
			requiredClaims: ["candidate_sha", "reviewed_head"],
		},
		{
			stageId: "adversarial-review",
			evidenceKind: "adversarial_review",
			requiredClaims: ["candidate_sha", "integration_sha", "reviewed_head", "no_base_merge", "worktree_decision"],
		},
	]);

const WORKFLOW_RECIPE_INTENT_TDD_PROMOTION_CONSTRAINTS_VALUE: readonly WorkflowRecipeIntentTddPromotionConstraint[] =
	WORKFLOW_RECIPE_INTENT_TDD_PROMOTION_CONSTRAINTS;

const BUILTIN_SUPERPOWERS_SKILL_IDS = Object.freeze([
	"brainstorming",
	"writing-plans",
	"recon",
	"review",
	"implementer",
	"test-driven-development",
	"systematic-debugging",
] as const);

interface WorkflowRecipeSnapshotFile {
	relativePath: string;
	bytesDigest: string;
	sizeBytes: number;
	contentBase64: string;
}

interface WorkflowRecipeCanonicalSnapshotArtifact {
	snapshotDigest: string;
	manifestDigest: string;
	bytesDigest: string;
	snapshotSizeBytes: number;
	manifestSizeBytes: number;
	files: readonly WorkflowRecipeSnapshotFile[];
	provenanceDigest?: string;
}

const canonicalSnapshotArtifactCache = new Map<string, WorkflowRecipeCanonicalSnapshotArtifact>();
const BUILTIN_SUPERPOWERS_SKILL_SOURCE_IDS: Readonly<Record<string, string>> = Object.freeze({
	recon: "using-superpowers",
	review: "receiving-code-review",
	implementer: "subagent-driven-development",
});
const BUILTIN_NATIVE_SKILL_SOURCE_IDS: Readonly<Record<string, string>> = Object.freeze({
	autoresearch: "workflow-autoresearch",
	mempalace: "mempalace",
});

function readCanonicalSnapshotArtifact(kind: string, id: string): WorkflowRecipeCanonicalSnapshotArtifact {
	const cacheKey = `${kind}:${id}`;
	const cached = canonicalSnapshotArtifactCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
	const sourceId =
		kind === "vendored-superpowers-skill"
			? (BUILTIN_SUPERPOWERS_SKILL_SOURCE_IDS[id] ?? id)
			: kind === "prime-native-capability"
				? (BUILTIN_NATIVE_SKILL_SOURCE_IDS[id] ?? id)
				: id;
	const sourceRoot =
		kind === "vendored-superpowers-skill"
			? join(packageRoot, "skills", "superpowers", sourceId)
			: join(packageRoot, "skills", sourceId);
	const readFiles = (directory: string, prefix = ""): WorkflowRecipeSnapshotFile[] => {
		const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
			compareCodePointStrings(left.name, right.name),
		);
		const files: WorkflowRecipeSnapshotFile[] = [];
		for (const entry of entries) {
			if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
			const absolutePath = join(directory, entry.name);
			const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
			const stat = lstatSync(absolutePath);
			if (entry.isDirectory()) {
				files.push(...readFiles(absolutePath, relativePath));
				continue;
			}
			if (!entry.isFile() || stat.isSymbolicLink())
				throw new Error(`Workflow recipe snapshot contains a non-regular file: ${relativePath}`);
			const bytes = readFileSync(absolutePath);
			files.push({
				relativePath,
				bytesDigest: sha256Hex(bytes),
				sizeBytes: bytes.byteLength,
				contentBase64: Buffer.from(bytes).toString("base64"),
			});
		}
		return files;
	};
	const files = readFiles(sourceRoot);
	let provenance:
		| {
				sourceFileDigest: string;
				upstreamFileDigest: string;
				patchesFileDigest: string;
				noticeFileDigest: string;
				licenseFileDigest: string;
				upstreamSha: string;
		  }
		| undefined;
	if (kind === "vendored-superpowers-skill") {
		const vendorRoot = join(packageRoot, "skills", "superpowers");
		const metadataNames = ["SOURCE.json", "UPSTREAM.md", "PATCHES.md", "THIRD_PARTY_NOTICE.md", "LICENSE"] as const;
		const metadataFiles = metadataNames.map((name) => {
			const absolutePath = join(vendorRoot, name);
			const stat = lstatSync(absolutePath);
			if (!stat.isFile() || stat.isSymbolicLink())
				throw new Error(`Vendored Superpowers provenance file is not a regular file: ${name}`);
			const bytes = readFileSync(absolutePath);
			return {
				relativePath: name,
				bytesDigest: sha256Hex(bytes),
				sizeBytes: bytes.byteLength,
				contentBase64: Buffer.from(bytes).toString("base64"),
			};
		});
		let sourceRecord: unknown;
		try {
			sourceRecord = JSON.parse(readFileSync(join(vendorRoot, "SOURCE.json"), "utf8")) as unknown;
		} catch (error: unknown) {
			throw new Error("Vendored Superpowers SOURCE.json is not valid JSON.", { cause: error });
		}
		if (
			!isRecord(sourceRecord) ||
			typeof sourceRecord.sourceCommit !== "string" ||
			!/^[0-9a-f]{40}$/u.test(sourceRecord.sourceCommit)
		)
			throw new Error("Vendored Superpowers SOURCE.json is missing its exact upstream commit.");
		files.push(...metadataFiles);
		provenance = {
			sourceFileDigest: metadataFiles[0].bytesDigest,
			upstreamFileDigest: metadataFiles[1].bytesDigest,
			patchesFileDigest: metadataFiles[2].bytesDigest,
			noticeFileDigest: metadataFiles[3].bytesDigest,
			licenseFileDigest: metadataFiles[4].bytesDigest,
			upstreamSha: sourceRecord.sourceCommit,
		};
	}
	files.sort((left, right) => compareCodePointStrings(left.relativePath, right.relativePath));
	if (files.length === 0) throw new Error(`Workflow recipe snapshot source is empty: ${sourceRoot}`);
	const manifest = {
		kind,
		id,
		revision: 1,
		files: files.map(({ relativePath, bytesDigest, sizeBytes }) => ({ relativePath, bytesDigest, sizeBytes })),
		...(provenance === undefined ? {} : { provenance }),
	};
	const snapshot = { ...manifest, files };
	const manifestBytes = canonicalJsonBytes(manifest);
	const snapshotBytes = canonicalJsonBytes(snapshot);
	const artifact = Object.freeze({
		snapshotDigest: digestObject(manifest),
		manifestDigest: sha256Hex(manifestBytes),
		bytesDigest: sha256Hex(snapshotBytes),
		snapshotSizeBytes: snapshotBytes.byteLength,
		manifestSizeBytes: manifestBytes.byteLength,
		files: Object.freeze(files.map((file) => Object.freeze(file))),
		...(provenance === undefined ? {} : { provenanceDigest: digestObject(provenance) }),
	});
	canonicalSnapshotArtifactCache.set(cacheKey, artifact);
	return artifact;
}

const BUILTIN_SUPERPOWERS_SKILL_SNAPSHOT_DIGESTS = Object.freeze(
	BUILTIN_SUPERPOWERS_SKILL_IDS.map(
		(skillId) => readCanonicalSnapshotArtifact("vendored-superpowers-skill", skillId).snapshotDigest,
	),
);

interface WorkflowRecipeCanonicalNativeSnapshot {
	id: "autoresearch" | "mempalace";
	snapshotDigest: string;
	manifestDigest: string;
	bytesDigest: string;
	registryDigest: string;
	verificationReceiptDigest: string;
	snapshotArtifactRef: WorkflowRecipeArtifactRef;
	manifestArtifactRef: WorkflowRecipeArtifactRef;
	verificationReceiptId: string;
	verificationKeyId: string;
}

interface WorkflowRecipeCanonicalSkillSnapshot {
	skillId: string;
	snapshotDigest: string;
	manifestDigest: string;
	bytesDigest: string;
	registryDigest: string;
	verificationReceiptDigest: string;
	snapshotArtifactRef: WorkflowRecipeArtifactRef;
	manifestArtifactRef: WorkflowRecipeArtifactRef;
	verificationReceiptId: string;
	verificationKeyId: string;
}

function canonicalSnapshotRegistryDigest(
	kind: string,
	id: string,
	snapshotDigest: string,
	manifestDigest: string,
	bytesDigest: string,
): string {
	return digestObject({ kind, id, snapshotDigest, manifestDigest, bytesDigest, owner: "prime-host", immutable: true });
}

function canonicalSnapshotReceiptDigest(kind: string, id: string, registryDigest: string): string {
	return digestObject({ kind, id, registryDigest, issuer: WORKFLOW_RECIPE_HOST_AUTHORITY_ID });
}

function canonicalSnapshotArtifactRef(
	kind: string,
	id: string,
	digest: string,
	sizeBytes: number,
): WorkflowRecipeArtifactRef {
	return {
		artifactId: `${kind}:${id}:snapshot`,
		relativePath: `artifacts/${kind}/${id}/snapshot.json`,
		digest,
		sizeBytes,
		sourceEventSequence: 1,
	};
}

function canonicalManifestArtifactRef(
	kind: string,
	id: string,
	digest: string,
	sizeBytes: number,
): WorkflowRecipeArtifactRef {
	return {
		artifactId: `${kind}:${id}:manifest`,
		relativePath: `artifacts/${kind}/${id}/manifest.json`,
		digest,
		sizeBytes,
		sourceEventSequence: 1,
	};
}

const WORKFLOW_RECIPE_CANONICAL_NATIVE_SNAPSHOTS: Readonly<
	Record<"autoresearch" | "mempalace", WorkflowRecipeCanonicalNativeSnapshot>
> = freezeDeep(
	Object.fromEntries(
		(["autoresearch", "mempalace"] as const).map((id) => {
			const artifact = readCanonicalSnapshotArtifact("prime-native-capability", id);
			const snapshotDigest = artifact.snapshotDigest;
			const manifestDigest = artifact.manifestDigest;
			const bytesDigest = artifact.bytesDigest;
			const registryDigest = canonicalSnapshotRegistryDigest(
				"prime-native-capability",
				id,
				snapshotDigest,
				manifestDigest,
				bytesDigest,
			);
			return [
				id,
				{
					id,
					snapshotDigest,
					manifestDigest,
					bytesDigest,
					registryDigest,
					verificationReceiptDigest: canonicalSnapshotReceiptDigest("prime-native-capability", id, registryDigest),
					snapshotArtifactRef: canonicalSnapshotArtifactRef(
						"prime-native-capability",
						id,
						bytesDigest,
						artifact.snapshotSizeBytes,
					),
					manifestArtifactRef: canonicalManifestArtifactRef(
						"prime-native-capability",
						id,
						manifestDigest,
						artifact.manifestSizeBytes,
					),
					verificationReceiptId: `builtin-prime-${id}-receipt`,
					verificationKeyId: "prime-host-loader-key",
				},
			] as const;
		}),
	) as Record<"autoresearch" | "mempalace", WorkflowRecipeCanonicalNativeSnapshot>,
) as Readonly<Record<"autoresearch" | "mempalace", WorkflowRecipeCanonicalNativeSnapshot>>;

const WORKFLOW_RECIPE_CANONICAL_SUPERPOWERS_SKILL_REGISTRY: readonly WorkflowRecipeCanonicalSkillSnapshot[] =
	freezeDeep(
		BUILTIN_SUPERPOWERS_SKILL_SNAPSHOT_DIGESTS.map((snapshotDigest, index) => {
			const skillId = BUILTIN_SUPERPOWERS_SKILL_IDS[index] ?? "";
			const artifact = readCanonicalSnapshotArtifact("vendored-superpowers-skill", skillId);
			const manifestDigest = artifact.manifestDigest;
			const bytesDigest = artifact.bytesDigest;
			const registryDigest = canonicalSnapshotRegistryDigest(
				"vendored-superpowers-skill",
				skillId,
				snapshotDigest,
				manifestDigest,
				bytesDigest,
			);
			return {
				skillId,
				snapshotDigest,
				manifestDigest,
				bytesDigest,
				registryDigest,
				verificationReceiptDigest: canonicalSnapshotReceiptDigest(
					"vendored-superpowers-skill",
					skillId,
					registryDigest,
				),
				snapshotArtifactRef: canonicalSnapshotArtifactRef(
					"vendored-superpowers-skill",
					skillId,
					bytesDigest,
					artifact.snapshotSizeBytes,
				),
				manifestArtifactRef: canonicalManifestArtifactRef(
					"vendored-superpowers-skill",
					skillId,
					manifestDigest,
					artifact.manifestSizeBytes,
				),
				verificationReceiptId: `vendored-superpowers-${skillId}-receipt`,
				verificationKeyId: "superpowers-vendor-key",
			};
		}),
	) as readonly WorkflowRecipeCanonicalSkillSnapshot[];

export const WORKFLOW_RECIPE_CANONICAL_NATIVE_CAPABILITY_SNAPSHOTS = freezeDeep(
	Object.values(WORKFLOW_RECIPE_CANONICAL_NATIVE_SNAPSHOTS).map((snapshot) => ({
		...snapshot,
		immutable: true as const,
		builtIn: true as const,
	})),
) as readonly WorkflowRecipeNativeCapabilitySnapshot[];
export const WORKFLOW_RECIPE_CANONICAL_SUPERPOWERS_SKILL_SNAPSHOTS = freezeDeep(
	WORKFLOW_RECIPE_CANONICAL_SUPERPOWERS_SKILL_REGISTRY.map((snapshot) => ({
		...snapshot,
		immutable: true as const,
		vendored: true as const,
	})),
) as readonly WorkflowRecipeSuperpowersSkillSnapshot[];

function builtinSuperpowersSkillDigest(skillId: string): string {
	const snapshot = WORKFLOW_RECIPE_CANONICAL_SUPERPOWERS_SKILL_REGISTRY.find(
		(candidate) => candidate.skillId === skillId,
	);
	if (snapshot === undefined) throw new Error(`Unknown built-in Superpowers skill ${skillId}.`);
	return snapshot.snapshotDigest;
}

export function getWorkflowRecipeSuperpowersCatalogDigests(input: {
	recipes: readonly WorkflowRecipeProposal[];
	skillSnapshots: readonly WorkflowRecipeSuperpowersSkillSnapshot[];
}): {
	snapshotDigest: string;
	provenanceDigest: string;
	verificationReceiptDigest: string;
	recipeCatalogDigest: string;
} {
	const recipes = Object.freeze(input.recipes.map(normalizeProposal).sort(compareByRecipeId));
	const skillSnapshots = Object.freeze(
		[...input.skillSnapshots].sort((left, right) => compareCodePointStrings(left.skillId, right.skillId)),
	);
	const snapshotDigest = digestObject({
		kind: "vendored-superpowers-catalog-bytes",
		skillSnapshots,
		recipes: stripUndefined(recipes),
	});
	const recipeCatalogDigest = digestObject(stripUndefined(recipes));
	const provenanceDigest = digestObject({
		kind: "vendored-superpowers-catalog-provenance",
		snapshotDigest,
		recipeCatalogDigest,
		skillRegistryDigest: digestObject(skillSnapshots),
	});
	return {
		snapshotDigest,
		provenanceDigest,
		verificationReceiptDigest: digestObject({
			kind: "vendored-superpowers-catalog-receipt",
			snapshotDigest,
			provenanceDigest,
			recipeCatalogDigest,
			issuer: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
		}),
		recipeCatalogDigest,
	};
}

export const WORKFLOW_RECIPE_NATIVE_CAPABILITIES = Object.freeze(["autoresearch", "mempalace"] as const);
export const WORKFLOW_RECIPE_OPTIONAL_CAPABILITIES = Object.freeze(["superpowers"] as const);

export const WORKFLOW_RECIPE_OVERFITTING_CHECKS = Object.freeze([
	"metric_preregistration_lock",
	"sample_adequacy",
	"train_eval_separation",
	"test_contamination",
	"repeated_holdout_peeking",
	"proxy_exploitation",
	"variance_replicate_stability",
	"hidden_adversarial_generalization",
] as const);

export type WorkflowRecipeOverfittingCheck = (typeof WORKFLOW_RECIPE_OVERFITTING_CHECKS)[number];
export type WorkflowRecipeBlockingBoundary = "holdout" | "promotion" | "milestone_acceptance" | "completion";
export type WorkflowRecipeEdgeKind = "forward" | "back";

/** Generic evidence-producing stage metadata. It never carries authority. */
export interface StageSpec {
	id: string;
	role: string;
	taskId: string;
	evidencePolicyId: string;
	capabilityIds?: readonly string[];
	capabilities?: readonly string[];
	generatedOutputPaths?: readonly string[];
	lockPaths?: readonly string[];
	/** Cheapest worker tier that can do this stage's work; the host maps it to a model selector. */
	computeClass?: WorkflowRecipeComputeClass;
}

export const WORKFLOW_RECIPE_COMPUTE_CLASSES = Object.freeze(["cheap", "standard", "deep"] as const);
export type WorkflowRecipeComputeClass = (typeof WORKFLOW_RECIPE_COMPUTE_CLASSES)[number];

/** Host-resolved gate metadata. A gate can propose evidence but cannot authorize. */
export interface GateSpec {
	id: string;
	kind: string;
	stageIds?: readonly string[];
	evidencePolicyId?: string;
}

/** A capability reference resolved by the host registry. */
export interface CapabilityRequirement {
	id: string;
	name: string;
	optional?: boolean;
	snapshotDigest?: string;
}

/** Bounded evidence metadata; evidence bytes remain outside the recipe. */
export interface EvidencePolicy {
	id: string;
	maxBytes: number;
	maxItems: number;
	independent?: boolean;
	kind?: string;
	requiredClaims?: readonly WorkflowRecipeIntentTddEvidenceClaim[];
}

export interface EdgeSpec {
	id: string;
	from: string;
	to: string;
	kind?: WorkflowRecipeEdgeKind;
	gateId?: string;
}

export interface FanOutSpec {
	id: string;
	from: string;
	branchStageIds?: readonly string[];
	branches?: readonly string[];
	joinStageId: string;
	maxBranches?: number;
}

export interface LoopSpec {
	id: string;
	from: string;
	to: string;
	gateId?: string;
	maxTraversals?: number;
	progressEvidencePolicyId?: string;
	exhaustionGateId?: string;
}

export interface PreEvaluationOverfittingReviewSpec {
	evidencePolicyId: string;
	checks: readonly WorkflowRecipeOverfittingCheck[];
	blockingBoundaries: readonly WorkflowRecipeBlockingBoundary[];
	opaqueHoldoutRef?: string;
}

/** Host-only holdout identity; no proposer or worker can resolve its bytes. */
export interface WorkflowRecipeOpaqueHoldout {
	handleId: string;
	manifestDigest: string;
	resolverContextId: string;
	authorizationReceiptDigest: string;
	owner: "host";
	hidden: true;
	opaque: true;
	hostResolverOnly: true;
	authenticated: true;
	returnsEvidenceOnly: true;
	returnsBytes: false;
}

export interface WorkflowRecipeNativeCapabilitySnapshot {
	id: "autoresearch" | "mempalace";
	snapshotDigest: string;
	manifestDigest: string;
	bytesDigest: string;
	registryDigest: string;
	verificationReceiptDigest: string;
	/** Immutable artifact references and receipt identity are supplied by the host loader. */
	snapshotArtifactRef: WorkflowRecipeArtifactRef;
	manifestArtifactRef: WorkflowRecipeArtifactRef;
	verificationReceiptId: string;
	verificationKeyId: string;
	immutable: true;
	builtIn: true;
}

export interface WorkflowRecipeArtifactRef {
	artifactId: string;
	relativePath: string;
	digest: string;
	sizeBytes: number;
	sourceEventSequence: number;
}

export interface WorkflowRecipeUniversalGateBinding {
	gateId: typeof WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID;
	stageIds: readonly string[];
	decisionDigest: string;
	scorecardDigest: string;
	evaluatorDigest: string;
	terminal: true;
	hostOwned: true;
}

export interface WorkflowRecipeIntentTddGateBinding {
	gateId: typeof WORKFLOW_RECIPE_INTENT_TDD_GATE_ID;
	stageIds: readonly (typeof WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS)[number][];
	evidenceKinds: readonly (typeof WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_KINDS)[number][];
	blocking: true;
	hostOwned: true;
	evidenceRequirements: readonly WorkflowRecipeIntentTddEvidenceRequirement[];
	promotionConstraints: readonly WorkflowRecipeIntentTddPromotionConstraint[];
}

export interface WorkflowRecipeOverfittingGateContract {
	gateId: typeof WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID;
	blocking: true;
	freshnessDigest: string;
	reviewerResultDigest: string;
	authenticatedReviewer: true;
	opaqueHoldoutManifestDigest: string;
	opaqueHoldoutEvidenceDigest: string;
	hostReceiptDigest: string;
}

export interface WorkflowRecipeOverfittingGateReceiptPayload {
	gateId: typeof WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID;
	blocking: true;
	freshnessDigest: string;
	reviewerResultDigest: string;
	authenticatedReviewer: true;
	opaqueHoldoutManifestDigest: string;
	opaqueHoldoutEvidenceDigest: string;
}

export interface WorkflowRecipePathBoundaryBinding {
	descriptorKind: "host_workspace_descriptor";
	effectBoundaryKind: "host_effect_boundary";
	descriptorDigest: string;
	effectBoundaryDigest: string;
	/** Concrete host roots are part of the binding; symlink/effect resolution remains host-owned. */
	workspacePaths: readonly string[];
	generatedOutputPaths: readonly string[];
}

export type WorkflowRecipeHostReceiptKind =
	| "opaque_holdout"
	| "universal_gate"
	| "overfitting_gate"
	| "intent_tdd_gate"
	| "process_evidence"
	| "tdd_evidence"
	| "native_capability_snapshot"
	| "superpowers_skill_snapshot"
	| "superpowers_catalog"
	| "recipe_registration";

/** Host-owned context and receipt consumption proof supplied by the production boundary. */
export interface WorkflowRecipeHostReceiptProof {
	proofKind: "ed25519-one-use";
	authorityId: typeof WORKFLOW_RECIPE_HOST_AUTHORITY_ID;
	receiptDigest: string;
	witnessDigest: string;
	workflowId: string;
	hostKeyId: string;
	bindingDigest: string;
	currentHeadDigest: string;
	currentDecisionDigest: string;
	currentEpochRef: WorkflowEpochRef;
	consumptionSequence: number;
	/** The persisted authority verified the signed receipt preimage. */
	signatureVerified: true;
	signatureDigest: string;
	/** Digest and size of the exact immutable artifact bytes verified by the authority. */
	artifactBytesDigest: string;
	artifactSizeBytes: number;
	artifactImmutable: true;
	/** The persisted authority atomically recorded the one-use consumption witness. */
	oneUseConsumed: true;
	/** Host-authenticated registration preimage anchors used by persisted admission consumers. */
	admissionPreimageDigest?: string;
	signedReceiptPreimageDigest?: string;
}

export interface WorkflowRecipeAdmissionHostRegistrationProof extends WorkflowRecipeHostReceiptProof {
	admissionPreimageDigest: string;
	signedReceiptPreimageDigest: string;
}

/**
 * Narrow host boundary supplied by the persisted authority; recipes never mint this proof.
 * The resolver must resolve the signed artifact, verify its bytes and key signature, consume its
 * one-use receipt through durable CAS, and bind the returned proof to every input context field.
 */
interface WorkflowRecipeAuthenticatedReceiptResolver {
	verifyConsumedReceipt(input: {
		receipt: WorkflowVerifiedHostReceipt;
		payload: unknown;
		consumptionWitness: WorkflowRecipeReceiptConsumptionWitness;
		workflowId: string;
		expectedBindingDigest: string;
		currentHeadDigest: string;
		currentEpochRef: WorkflowEpochRef;
		currentDecisionDigest: string;
		hostKeyId: string;
		/** Registration receipts must be re-authorized over this exact admission preimage. */
		expectedAdmissionPreimageDigest?: string;
	}): WorkflowRecipeHostReceiptProof | null;
	/**
	 * Host-owned admission transaction. The implementation re-resolves the registration artifact and signature,
	 * records the one-use witness and idempotency decision durably, and invokes the consumer only for the first
	 * authenticated admission. Recipes never implement this transaction locally.
	 */
	consumeAdmissionAtHost?(input: {
		admission: WorkflowRecipeAdmissionArtifact;
		registration: WorkflowRecipeVerifiedHostReceipt<WorkflowRecipeRegisteredManifest>;
		expectedBindingDigest: string;
		expectedAdmissionPreimageDigest: string;
		workflowId: string;
		currentHeadDigest: string;
		currentDecisionDigest: string;
		currentEpochRef: WorkflowEpochRef;
		currentRevision: number;
		consumer: () => void;
	}): Promise<WorkflowRecipeAdmissionHostConsumption>;
}

interface WorkflowRecipeAdmissionHostConsumption {
	status: "consumed" | "already_consumed";
	registration: WorkflowRecipeVerifiedHostReceipt<WorkflowRecipeRegisteredManifest>;
	proof: WorkflowRecipeAdmissionHostRegistrationProof;
}

const workflowRecipeAdmissionConsumptionProofBrand: unique symbol = Symbol(
	"workflow-recipe-admission-consumption-proof",
);
const workflowRecipeAdmissionConsumptionProofs = new WeakSet<object>();

/** Opaque proof issued only after the host's durable admission transaction succeeds. */
export interface WorkflowRecipeAdmissionConsumptionProof {
	readonly [workflowRecipeAdmissionConsumptionProofBrand]: true;
	readonly workflowId: string;
	readonly admissionDigest: string;
	readonly status: WorkflowRecipeAdmissionHostConsumption["status"];
}

/** Verify that a returned proof was issued by the authenticated recipe consumer in this process. */
export function isWorkflowRecipeAdmissionConsumptionProof(
	value: unknown,
	admission: WorkflowRecipeAdmissionArtifact,
): value is WorkflowRecipeAdmissionConsumptionProof {
	return (
		typeof value === "object" &&
		value !== null &&
		workflowRecipeAdmissionConsumptionProofs.has(value) &&
		(value as WorkflowRecipeAdmissionConsumptionProof).workflowId === admission.workflowId &&
		(value as WorkflowRecipeAdmissionConsumptionProof).admissionDigest === admission.admissionDigest &&
		((value as WorkflowRecipeAdmissionConsumptionProof).status === "consumed" ||
			(value as WorkflowRecipeAdmissionConsumptionProof).status === "already_consumed")
	);
}

interface WorkflowRecipeHostContext {
	authorityId: typeof WORKFLOW_RECIPE_HOST_AUTHORITY_ID;
	hostKeyId: string;
	workflowId: string;
	registryManifestDigest: string;
	epochRef: WorkflowEpochRef;
	currentDecisionDigest: string;
	headDigest: string;
	issuedAt: string;
	validUntil: string;
	pathBoundaryDigest: string;
	contextDigest: string;
	receiptContext: WorkflowHostReceiptConsumerContext;
	authenticatedReceiptResolver: WorkflowRecipeAuthenticatedReceiptResolver;
	/** Host-authorized independent reviewer principals; required for implementation TDD. */
	reviewerPrincipalDigests?: readonly string[];
}

export interface WorkflowRecipeReceiptConsumptionWitness extends WorkflowHostReceiptConsumptionWitness {
	headDigest: string;
}

/**
 * A recipe receipt is a host-verified repository receipt plus its host-resolved payload.
 * The compiler never creates keys, signatures, receipt IDs, or consumption witnesses.
 */
export interface WorkflowRecipeVerifiedHostReceipt<TPayload> {
	receipt: WorkflowVerifiedHostReceipt;
	payload: TPayload;
	consumptionWitness: WorkflowRecipeReceiptConsumptionWitness;
}

export interface WorkflowRecipeRegisteredManifest {
	recipeId: string;
	revision: number;
	recipeDigest: string;
	registryManifestDigest: string;
	immutable: true;
}

export interface WorkflowRecipeCatalogBinding {
	sourceId: "superpowers";
	snapshotDigest: string;
	provenanceDigest: string;
	verificationReceiptDigest: string;
	recipeCatalogDigest: string;
	skillSnapshotDigests: readonly string[];
}

export interface WorkflowRecipeSuperpowersCatalogReceiptPayload {
	sourceId: "superpowers";
	snapshotDigest: string;
	provenanceDigest: string;
	verificationReceiptDigest: string;
	recipeCatalogDigest: string;
	skillSnapshotDigests: readonly string[];
	hostVerified: true;
	vendored: true;
}

export interface WorkflowRecipeSuperpowersSkillSnapshot {
	skillId: string;
	snapshotDigest: string;
	manifestDigest: string;
	bytesDigest: string;
	registryDigest: string;
	verificationReceiptDigest: string;
	snapshotArtifactRef: WorkflowRecipeArtifactRef;
	manifestArtifactRef: WorkflowRecipeArtifactRef;
	verificationReceiptId: string;
	verificationKeyId: string;
	immutable: true;
	vendored: true;
}

export interface WorkflowRecipeSuperpowersSkillBinding {
	skillId: string;
	snapshotDigest: string;
	role: string;
	gateId: string;
	readOnly: boolean;
	ownedPathKinds: readonly ("code" | "tests" | "artifacts")[];
	authority: readonly [];
}

export interface WorkflowRecipeHostResolutionPort {
	registryManifestDigest: string;
	pathBoundary: WorkflowRecipePathBoundaryBinding;
	context: WorkflowRecipeHostContext;
	nativeCapabilitySnapshots: readonly WorkflowRecipeNativeCapabilitySnapshot[];
	nativeCapabilitySnapshotReceipts?: readonly WorkflowRecipeVerifiedHostReceipt<WorkflowRecipeNativeCapabilitySnapshot>[];
	opaqueHoldoutReceipt: WorkflowRecipeVerifiedHostReceipt<WorkflowRecipeOpaqueHoldout>;
	universalGateReceipt: WorkflowRecipeVerifiedHostReceipt<WorkflowRecipeUniversalGateBinding>;
	overfittingGateReceipt: WorkflowRecipeVerifiedHostReceipt<WorkflowRecipeOverfittingGateReceiptPayload>;
	registeredManifestReceipt?: WorkflowRecipeVerifiedHostReceipt<WorkflowRecipeRegisteredManifest>;
	superpowersSkillSnapshots?: readonly WorkflowRecipeSuperpowersSkillSnapshot[];
	superpowersSkillSnapshotReceipts?: readonly WorkflowRecipeVerifiedHostReceipt<WorkflowRecipeSuperpowersSkillSnapshot>[];
	intentTddGateReceipt?: WorkflowRecipeVerifiedHostReceipt<WorkflowRecipeIntentTddGateBinding>;
	superpowersCatalogReceipt?: WorkflowRecipeVerifiedHostReceipt<WorkflowRecipeSuperpowersCatalogReceiptPayload>;
}

/** Minimal persisted host authority needed to re-authorize an immutable admission. */
export type WorkflowRecipeAdmissionHostResolutionPort = Pick<
	WorkflowRecipeHostResolutionPort,
	"registryManifestDigest" | "pathBoundary" | "context"
>;

export interface WorkflowRecipeOverlays {
	universalHostGateIds?: readonly string[];
	universalHostGates?: readonly string[];
	preEvaluationOverfitting?: PreEvaluationOverfittingReviewSpec;
}

/** The intentionally small proposal artifact. It describes bindings, not runtime behavior. */
export interface WorkflowRecipeProposal {
	recipeId: string;
	revision: number;
	taskGraphDigest?: string;
	graphDigest?: string;
	effectiveGraphDigest?: string;
	requiredSkillSnapshotDigests?: readonly string[];
	stages: readonly StageSpec[];
	gates: readonly GateSpec[];
	capabilities: readonly CapabilityRequirement[];
	evidencePolicies: readonly EvidencePolicy[];
	edges: readonly EdgeSpec[];
	fanOuts?: readonly FanOutSpec[];
	loops?: readonly LoopSpec[];
	overlays: WorkflowRecipeOverlays;
}

export interface WorkflowRecipeRegistry {
	registryId: string;
	registryRevision: number;
	manifestDigest: string;
	roles: readonly string[];
	gates: readonly string[];
	capabilities: readonly string[];
	gateKinds: Readonly<Record<string, string>>;
	capabilityNames: Readonly<Record<string, string>>;
}

export const WORKFLOW_RECIPE_REGISTRY_ID = "prime-workflow-recipe-host";
export const WORKFLOW_RECIPE_REGISTRY_REVISION = 1;

const WORKFLOW_RECIPE_GATE_KINDS = Object.freeze({
	[WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID]: "host_adjudication",
	[WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID]: "overfitting_review",
	judge: "judge",
	unify: "unify",
	"edge-test": "edge_test",
	[WORKFLOW_RECIPE_INTENT_TDD_GATE_ID]: "tdd_lifecycle",
	scorecard: "scorecard",
	decision: "decision",
	invariant: "invariant",
	check: "check",
});

const WORKFLOW_RECIPE_CAPABILITY_NAMES = Object.freeze({
	read: "read_workspace",
	read_external_evidence: "read_external_evidence",
	write_owned_paths: "write_owned_paths",
	invoke_host_effect: "invoke_host_effect",
	shell: "shell",
	ipython: "ipython",
	edit: "edit",
	recursive_spawn: "recursive_spawn",
	verification: "verification",
	red_team: "red_team",
	autoresearch: "autoresearch",
	mempalace: "mempalace",
	superpowers: "superpowers",
});

/**
 * Roles a task may declare. The DAG shape is the planner's to choose; the vocabulary is not.
 * A stage outside this list is rejected rather than silently treated as ordinary implementation.
 */
export const WORKFLOW_TASK_ROLES = Object.freeze([
	"recon",
	"lens",
	"verify",
	"verification",
	"synthesize",
	"red-team",
	"attack",
	"architect",
	"judge",
	"unify",
	"edge-test",
	"implementation",
	"integration",
	"planning",
	"design",
	"review",
] as const);
export type WorkflowTaskRole = (typeof WORKFLOW_TASK_ROLES)[number];

/** Roles that must appear somewhere in an accepted graph, so checks cannot be omitted. */
export const WORKFLOW_REQUIRED_TASK_ROLES = Object.freeze(["verification", "red-team"] as const);

const WORKFLOW_RECIPE_REGISTRY_MANIFEST_PREIMAGE = Object.freeze({
	registryId: WORKFLOW_RECIPE_REGISTRY_ID,
	registryRevision: WORKFLOW_RECIPE_REGISTRY_REVISION,
	roles: Object.freeze([
		"recon",
		"lens",
		"verify",
		"verification",
		"synthesize",
		"synthesis",
		"red-team",
		"red_team",
		"host_adjudication",
		"attack",
		"architect",
		"judge",
		"unify",
		"edge-test",
		"implementation",
		"integration",
		"planning",
		"design",
		"review",
		"implementer",
	]),
	gateKinds: WORKFLOW_RECIPE_GATE_KINDS,
	capabilityNames: WORKFLOW_RECIPE_CAPABILITY_NAMES,
});

export const WORKFLOW_RECIPE_REGISTRY_MANIFEST_DIGEST = digestObject(WORKFLOW_RECIPE_REGISTRY_MANIFEST_PREIMAGE);

export const DEFAULT_WORKFLOW_RECIPE_REGISTRY: WorkflowRecipeRegistry = Object.freeze({
	registryId: WORKFLOW_RECIPE_REGISTRY_ID,
	registryRevision: WORKFLOW_RECIPE_REGISTRY_REVISION,
	manifestDigest: WORKFLOW_RECIPE_REGISTRY_MANIFEST_DIGEST,
	roles: WORKFLOW_RECIPE_REGISTRY_MANIFEST_PREIMAGE.roles,
	gates: Object.freeze([
		WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID,
		WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID,
		"judge",
		"unify",
		"edge-test",
		WORKFLOW_RECIPE_INTENT_TDD_GATE_ID,
		"scorecard",
		"decision",
		"invariant",
		"check",
	]),
	capabilities: Object.freeze(Object.values(WORKFLOW_RECIPE_CAPABILITY_NAMES)),
	gateKinds: WORKFLOW_RECIPE_GATE_KINDS,
	capabilityNames: WORKFLOW_RECIPE_CAPABILITY_NAMES,
});

export type WorkflowRecipeErrorCode =
	| "recipe_invalid"
	| "recipe_field_unknown"
	| "authority_like_field"
	| "hidden_handle_exposed"
	| "unknown_role"
	| "unknown_gate"
	| "unknown_capability"
	| "capability_status_invalid"
	| "stage_compute_class_invalid"
	| "missing_evidence"
	| "missing_universal_gate"
	| "missing_overfitting_review"
	| "unbounded_loop"
	| "unbounded_fanout"
	| "path_overlap"
	| "recipe_edge_mismatch"
	| "recipe_edge_cycle"
	| "recipe_fanout_mismatch"
	| "recipe_loop_invalid"
	| "registry_invalid"
	| "recipe_catalog_duplicate"
	| "opaque_holdout_unresolved"
	| "capability_snapshot_invalid"
	| "universal_gate_contract_invalid"
	| "overfitting_gate_contract_invalid"
	| "intent_tdd_gate_invalid"
	| "catalog_source_invalid"
	| "compiled_graph_mismatch"
	| "recipe_registration_required"
	| "task_graph_invalid"
	| "task_binding_mismatch"
	| "recipe_not_found";

export class WorkflowRecipeCompileError extends Error {
	readonly code: WorkflowRecipeErrorCode;

	constructor(code: WorkflowRecipeErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "WorkflowRecipeCompileError";
		this.code = code;
	}
}

export interface WorkflowRecipeTaskSidecarEntry {
	taskId: string;
	taskDigest: string;
	generatedOutputPaths: readonly string[];
	lockPaths: readonly string[];
}

export interface WorkflowRecipeTaskSidecar {
	baseTaskGraphDigest: string;
	entries: readonly WorkflowRecipeTaskSidecarEntry[];
	pathBoundary: WorkflowRecipePathBoundaryBinding;
	sidecarDigest: string;
}

/** Exact task/stage projection consumed by the scheduler before lease acquisition. */
export interface WorkflowRecipeAdmissionTaskBinding {
	taskId: string;
	taskDigest: string;
	stageId: string;
	stageDigest: string;
	role: string;
	requiredSkillSnapshotDigests: readonly string[];
	gateIds: readonly string[];
	ownedPaths: readonly string[];
	generatedOutputPaths: readonly string[];
	lockPaths: readonly string[];
}

/**
 * The exact recipe preimage signed by the host registration receipt.
 * Keeping this preimage in the admission lets a consumer independently prove
 * that every stage, gate, snapshot, path, and topology field is still the
 * registered value rather than merely a self-recomputed admission digest.
 */
export interface WorkflowRecipeAdmissionRecipeBinding {
	schemaVersion: number;
	workflowId: string;
	recipeId: string;
	revision: number;
	registryManifestDigest: string;
	proposal: WorkflowRecipeProposal;
	effectiveGraphDigest: string;
	baseTaskGraphDigest: string;
	sidecarDigest: string;
	graphContextDigest: string;
	opaqueHoldout: WorkflowRecipeOpaqueHoldout;
	universalGate: WorkflowRecipeUniversalGateBinding;
	overfittingGate: WorkflowRecipeOverfittingGateContract;
	capabilitySnapshotDigests: readonly string[];
	nativeCapabilitySnapshots: readonly WorkflowRecipeNativeCapabilitySnapshot[];
	superpowersSkillSnapshots: readonly WorkflowRecipeSuperpowersSkillSnapshot[];
	taskBindings: readonly WorkflowRecipeAdmissionTaskBinding[];
	intentTddGate?: WorkflowRecipeIntentTddGateBinding;
	catalogBinding?: WorkflowRecipeCatalogBinding;
	evidenceBindings: readonly WorkflowRecipeEvidenceBinding[];
	evidenceBindingDigest: string;
	evidenceEnvelopeDigests: readonly string[];
	hostReceiptDigests: readonly string[];
	snapshotReceiptDigests: readonly string[];
	hostBinding: {
		contextDigest: string;
		headDigest: string;
		currentDecisionDigest: string;
		epochRef: WorkflowEpochRef;
		pathBoundary: WorkflowRecipePathBoundaryBinding;
		receiptDigests: readonly string[];
	};
}

export interface WorkflowRecipeAdmissionArtifact {
	kind: "workflow_recipe_admission";
	admissionDigest: string;
	workflowId: string;
	recipeId: string;
	revision: number;
	recipeDigest: string;
	effectiveGraphDigest: string;
	baseTaskGraphDigest: string;
	sidecarDigest: string;
	registryManifestDigest: string;
	capabilitySnapshotDigests: readonly string[];
	skillSnapshotDigests: readonly string[];
	nativeCapabilitySnapshots: readonly WorkflowRecipeNativeCapabilitySnapshot[];
	superpowersSkillSnapshots: readonly WorkflowRecipeSuperpowersSkillSnapshot[];
	taskBindings: readonly WorkflowRecipeAdmissionTaskBinding[];
	intentTddGate?: WorkflowRecipeIntentTddGateBinding;
	pathBoundary: WorkflowRecipePathBoundaryBinding;
	catalogBindingDigest?: string;
	registrationReceiptDigest: string;
	hostReceiptDigests: readonly string[];
	snapshotReceiptDigests: readonly string[];
	hostHeadDigest: string;
	hostDecisionDigest: string;
	hostEpochRef: WorkflowEpochRef;
	hostContextDigest: string;
	evidenceBindings: readonly WorkflowRecipeEvidenceBinding[];
	evidenceBindingDigest: string;
	evidenceEnvelopeDigests: readonly string[];
	graphContextDigest: string;
	/** The signed recipe preimage and registration receipt are immutable authority evidence. */
	recipeBinding: WorkflowRecipeAdmissionRecipeBinding;
	registrationReceipt?: WorkflowRecipeVerifiedHostReceipt<WorkflowRecipeRegisteredManifest>;
	registrationReceiptProof?: WorkflowRecipeAdmissionHostRegistrationProof;
}

/** Production-facing handoff for the scheduler's admission verifier. */
export interface WorkflowRecipeAdmissionConsumer {
	consumeWorkflowRecipeAdmission(admission: WorkflowRecipeAdmissionArtifact): void;
}

export interface CompiledWorkflowRecipe {
	kind: "compiled";
	recipe: WorkflowRecipeProposal;
	recipeDigest: string;
	graph: WorkflowTaskGraph;
	tasks: readonly WorkflowTask[];
	sidecar: WorkflowRecipeTaskSidecar;
	effectiveGraphDigest: string;
	registryManifestDigest: string;
	opaqueHoldout: WorkflowRecipeOpaqueHoldout;
	universalGate: WorkflowRecipeUniversalGateBinding;
	overfittingGate: WorkflowRecipeOverfittingGateContract;
	capabilitySnapshotDigests: readonly string[];
	nativeCapabilitySnapshots: readonly WorkflowRecipeNativeCapabilitySnapshot[];
	superpowersSkillSnapshots: readonly WorkflowRecipeSuperpowersSkillSnapshot[];
	intentTddGate?: WorkflowRecipeIntentTddGateBinding;
	admission: WorkflowRecipeAdmissionArtifact;
}

export interface WorkflowRecipeCompileInput {
	proposal: WorkflowRecipeProposal;
	tasks: readonly WorkflowTask[];
	graphContext: WorkflowTaskGraphContext;
	registry?: WorkflowRecipeRegistry;
	host?: WorkflowRecipeHostResolutionPort;
	registeredManifest?: WorkflowRecipeRegisteredManifest;
	catalogBinding?: WorkflowRecipeCatalogBinding;
	evidence?: readonly WorkflowRecipeEvidenceBinding[];
}

export interface WorkflowRecipeEvidenceBinding {
	stageId: (typeof WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS)[number];
	envelope: WorkflowEvidenceEnvelope;
	validationReceipt: WorkflowVerifiedHostReceipt;
	/** Host-issued process observation receipt bound to the exact command output. */
	processReceipt: WorkflowRecipeVerifiedHostReceipt<WorkflowEvidenceCommandObservation> | null;
	/** Host clock receipt used by the public evidence validator at consumption time. */
	trustedClockReceipt: WorkflowVerifiedHostReceipt;
	consumptionWitness: WorkflowRecipeReceiptConsumptionWitness;
	/** Host-bound typed intent, requirement, and forbidden-outcome digests. */
	intentBinding: WorkflowRecipeIntentTddEvidenceIntentBinding;
	baseSha: string;
	/** Immutable pre-implementation base used by the RED and GREEN ordering proof. */
	preCandidateSha: string;
	candidateSha: string;
	integrationSha: string | null;
	reviewedHeadSha: string;
	ancestorShas: readonly string[];
	baseAncestorShas: readonly string[];
	noBaseMerge: true;
	worktreeDecision: "isolated" | "shared-safe";
	/** Canonical configured worktree and exact status snapshot used by the host resolver. */
	worktreeRoot: string;
	worktreeStatusDigest: string;
	outOfScopePaths: readonly string[];
	/** Identity and exact attack artifact are required for the independent review stages. */
	reviewerIdentityDigest: string | null;
	reviewerRole: "independent" | "adversarial" | null;
	attackResultArtifactRef: WorkflowRecipeArtifactRef | null;
}

export interface WorkflowRecipeIntentTddEvidenceIntentBinding {
	goalDigest: string;
	requirementDigest: string;
	forbiddenOutcomeDigest: string;
}

export interface WorkflowRecipeCatalog {
	recipes: readonly WorkflowRecipeProposal[];
}

export interface WorkflowRecipeSuperpowersCatalogSource {
	sourceId: "superpowers";
	snapshotDigest: string;
	provenanceDigest: string;
	verificationReceiptDigest: string;
	recipeCatalogDigest: string;
	hostVerified: true;
	vendored: true;
	skillSnapshots: readonly WorkflowRecipeSuperpowersSkillSnapshot[];
	recipes: readonly WorkflowRecipeProposal[];
}

export interface WorkflowRecipeResolutionInput {
	requestedRecipeId: string;
	optional?: boolean;
	proposal?: WorkflowRecipeProposal;
	superpowersCatalog?: readonly WorkflowRecipeProposal[];
	superpowersSource?: WorkflowRecipeSuperpowersCatalogSource;
	catalog?: WorkflowRecipeCatalog | readonly WorkflowRecipeProposal[];
	tasks: readonly WorkflowTask[];
	graphContext: WorkflowTaskGraphContext;
	registry?: WorkflowRecipeRegistry;
	host?: WorkflowRecipeHostResolutionPort;
	registeredManifest?: WorkflowRecipeRegisteredManifest;
}

export interface WorkflowRecipeCapabilityGap {
	kind: "capability_gap";
	code: "capability_gap";
	capability: "superpowers";
	requestedRecipeId: string;
	disposition: "blocked";
	fallback: "none";
}

export type WorkflowRecipeResolution = CompiledWorkflowRecipe | WorkflowRecipeCapabilityGap;

const AUTHORITY_LIKE_FIELDS = new Set([
	"authority",
	"authorize",
	"approval",
	"canApprove",
	"canAuthorize",
	"completion",
	"evaluator",
	"authorityCapabilities",
	"emitsEvidenceOnly",
	"hostOwned",
	"owner",
	"permissions",
	"writeAuthority",
]);
const HIDDEN_HANDLE_FIELDS = new Set([
	"hiddenHoldoutHandle",
	"hiddenHandle",
	"holdoutHandle",
	"hiddenBytes",
	"hiddenHoldoutBytes",
	"holdoutBytes",
	"opaqueHoldout",
	"rawBytes",
	"byteData",
	"bytes",
	"data",
	"rawHoldout",
	"resolverContext",
	"resolverHandle",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Reflect.ownKeys(value).every((key) => {
		if (typeof key !== "string") return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return (
			descriptor !== undefined &&
			descriptor.enumerable &&
			descriptor.get === undefined &&
			descriptor.set === undefined
		);
	});
}

function fail(code: WorkflowRecipeErrorCode, message: string): never {
	throw new WorkflowRecipeCompileError(code, message);
}

function assertNoHiddenMembers(value: unknown, label: string, seen = new Set<object>()): void {
	if (typeof value === "function") fail("recipe_invalid", `${label} contains executable state.`);
	if (typeof value !== "object" || value === null) return;
	if (seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const key of Reflect.ownKeys(value)) {
			if (key === "length") continue;
			if (
				typeof key !== "string" ||
				!/^(0|[1-9][0-9]*)$/u.test(key) ||
				!Object.prototype.propertyIsEnumerable.call(value, key)
			)
				fail("recipe_invalid", `${label} contains a hidden array member.`);
		}
		for (let index = 0; index < value.length; index += 1) {
			if (!Object.hasOwn(value, index)) fail("recipe_invalid", `${label} contains a sparse array.`);
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (descriptor?.get !== undefined || descriptor?.set !== undefined)
				fail("recipe_invalid", `${label} contains accessor-backed array state.`);
			assertNoHiddenMembers(value[index], `${label}[${index}]`, seen);
		}
		return;
	}
	if (!isRecord(value)) fail("recipe_invalid", `${label} contains a non-canonical object.`);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			typeof key !== "string" ||
			descriptor === undefined ||
			!descriptor.enumerable ||
			descriptor.get !== undefined ||
			descriptor.set !== undefined
		)
			fail("recipe_invalid", `${label} contains hidden or accessor state.`);
		assertNoHiddenMembers(descriptor.value, `${label}.${key}`, seen);
	}
}

function compareCodePointStrings(left: string, right: string): number {
	const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
	const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
	const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
	for (let index = 0; index < sharedLength; index += 1) {
		if (leftCodePoints[index] !== rightCodePoints[index]) return leftCodePoints[index] - rightCodePoints[index];
	}
	return leftCodePoints.length - rightCodePoints.length;
}

function compareById<T extends { id: string }>(left: T, right: T): number {
	return compareCodePointStrings(left.id, right.id);
}

function compareByRecipeId(left: WorkflowRecipeProposal, right: WorkflowRecipeProposal): number {
	return compareCodePointStrings(left.recipeId, right.recipeId);
}

function edgeEndpointKey(from: string, to: string): string {
	return JSON.stringify([from, to]);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) fail("recipe_invalid", `${label} must be a plain object.`);
	return value;
}

function assertClosedRecord(value: unknown, label: string, allowedKeys: readonly string[]): Record<string, unknown> {
	const record = assertRecord(value, label);
	const allowed = new Set(allowedKeys);
	const unknownKeys = Object.keys(record).filter((key) => !allowed.has(key));
	for (const key of unknownKeys) {
		if (AUTHORITY_LIKE_FIELDS.has(key)) fail("authority_like_field", `${label} contains ${key}.`);
		if (HIDDEN_HANDLE_FIELDS.has(key)) fail("hidden_handle_exposed", `${label} contains ${key}.`);
	}
	if (unknownKeys.length > 0) fail("recipe_field_unknown", `${label} contains ${unknownKeys[0]}.`);
	return record;
}

function nonEmptyString(value: unknown, label: string, code: WorkflowRecipeErrorCode = "recipe_invalid"): string {
	if (typeof value !== "string" || value.length === 0) fail(code, `${label} must be a non-empty string.`);
	return value;
}

function positiveInteger(
	value: unknown,
	label: string,
	code: WorkflowRecipeErrorCode = "recipe_invalid",
	maximum?: number,
): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (maximum !== undefined && (value as number) > maximum))
		fail(code, `${label} must be a positive bounded integer.`);
	return value as number;
}

function sortedUniqueStrings(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0))
		fail("recipe_invalid", `${label} must be a non-empty string array.`);
	const values = value as string[];
	if (new Set(values).size !== values.length) fail("recipe_invalid", `${label} contains duplicates.`);
	return Object.freeze([...values].sort(compareCodePointStrings));
}

function canonicalSortedStrings(value: unknown, label: string): readonly string[] {
	const canonical = sortedUniqueStrings(value, label);
	if (digestObject(value) !== digestObject(canonical)) fail("recipe_invalid", `${label} is not canonically ordered.`);
	return canonical;
}

function uniqueStringsInOrder(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0))
		fail("recipe_invalid", `${label} must be a non-empty string array.`);
	const values = value as string[];
	if (new Set(values).size !== values.length) fail("recipe_invalid", `${label} contains duplicates.`);
	return Object.freeze([...values]);
}

function freezeDeep<T>(value: T): T {
	if (typeof value === "function") fail("recipe_invalid", "recipe values cannot contain executable state.");
	if (typeof value !== "object" || value === null) return value;
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined)
			fail("recipe_invalid", "recipe values cannot contain accessors or hidden properties.");
		freezeDeep(descriptor.value);
	}
	return Object.isFrozen(value) ? value : Object.freeze(value);
}

function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
	if (typeof value === "function") return false;
	if (typeof value !== "object" || value === null) return true;
	if (seen.has(value)) return true;
	if (!Object.isFrozen(value)) return false;
	seen.add(value);
	return Reflect.ownKeys(value).every((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return (
			descriptor !== undefined &&
			descriptor.get === undefined &&
			descriptor.set === undefined &&
			isDeepFrozen(descriptor.value, seen)
		);
	});
}

function stripUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripUndefined);
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (child !== undefined) result[key] = stripUndefined(child);
	}
	return result;
}

function cloneStrings(value: readonly string[] | undefined): readonly string[] {
	return Object.freeze([...(value ?? [])]);
}

function normalizePath(value: string, label: string, roots: readonly string[]): string {
	if (value.normalize("NFC") !== value) fail("recipe_invalid", `${label} is not canonically normalized.`);
	try {
		parseWorkflowCanonicalPath(value);
	} catch {
		fail("recipe_invalid", `${label} is not a canonical relative path.`);
	}
	const parts = value.split("/");
	const isWithinRoot = roots.some((root) => {
		const rootParts = root.split("/");
		return rootParts.length <= parts.length && rootParts.every((part, index) => part === parts[index]);
	});
	if (!isWithinRoot) fail("recipe_invalid", `${label} is outside the workspace boundary.`);
	return value;
}

function normalizeRoots(value: unknown, label: string): readonly string[] {
	const roots = sortedUniqueStrings(value, label);
	for (const root of roots) {
		if (root.normalize("NFC") !== root) fail("recipe_invalid", `${label} contains a non-canonical root.`);
		try {
			parseWorkflowCanonicalPath(root);
		} catch {
			fail("recipe_invalid", `${label} contains a non-canonical root.`);
		}
	}
	for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
			if (pathOverlaps(roots[leftIndex], roots[rightIndex]))
				fail("recipe_invalid", `${label} contains overlapping roots.`);
		}
	}
	return roots;
}

function pathOverlaps(left: string, right: string): boolean {
	const leftParts = left.split("/");
	const rightParts = right.split("/");
	const prefix = (shorter: readonly string[], longer: readonly string[]): boolean =>
		shorter.length <= longer.length && shorter.every((part, index) => part === longer[index]);
	return prefix(leftParts, rightParts) || prefix(rightParts, leftParts);
}

function taskDependsOn(
	task: WorkflowTask,
	targetTaskId: string,
	byId: ReadonlyMap<string, WorkflowTask>,
	seen = new Set<string>(),
): boolean {
	if (task.dependencyTaskIds.includes(targetTaskId)) return true;
	if (seen.has(task.taskId)) return false;
	seen.add(task.taskId);
	return task.dependencyTaskIds.some((dependencyId) => {
		const dependency = byId.get(dependencyId);
		return dependency !== undefined && taskDependsOn(dependency, targetTaskId, byId, seen);
	});
}

function taskOrderingAllowsOverlap(
	leftTaskId: string,
	rightTaskId: string,
	byId: ReadonlyMap<string, WorkflowTask>,
): boolean {
	const left = byId.get(leftTaskId);
	const right = byId.get(rightTaskId);
	return (
		(left !== undefined && taskDependsOn(left, rightTaskId, byId)) ||
		(right !== undefined && taskDependsOn(right, leftTaskId, byId))
	);
}

function readStringArray(
	record: Record<string, unknown>,
	primary: string,
	alias: string,
	label: string,
): readonly string[] {
	const primaryValue = record[primary];
	const aliasValue = record[alias];
	if (primaryValue !== undefined && aliasValue !== undefined) {
		const first = sortedUniqueStrings(primaryValue, `${label}.${primary}`);
		const second = sortedUniqueStrings(aliasValue, `${label}.${alias}`);
		if (digestObject(first) !== digestObject(second))
			fail("recipe_invalid", `${label} has conflicting capability arrays.`);
		return first;
	}
	if (primaryValue !== undefined) return sortedUniqueStrings(primaryValue, `${label}.${primary}`);
	if (aliasValue !== undefined) return sortedUniqueStrings(aliasValue, `${label}.${alias}`);
	return Object.freeze([] as string[]);
}

function normalizeStage(value: unknown): StageSpec {
	const record = assertClosedRecord(value, "stage", [
		"id",
		"role",
		"taskId",
		"evidencePolicyId",
		"capabilityIds",
		"capabilities",
		"generatedOutputPaths",
		"lockPaths",
		"computeClass",
	]);
	const computeClass = record.computeClass;
	if (computeClass !== undefined && !(WORKFLOW_RECIPE_COMPUTE_CLASSES as readonly unknown[]).includes(computeClass))
		fail("stage_compute_class_invalid", "stage.computeClass must be cheap, standard, or deep.");
	return {
		id: nonEmptyString(record.id, "stage.id"),
		role: nonEmptyString(record.role, "stage.role"),
		taskId: nonEmptyString(record.taskId, "stage.taskId"),
		evidencePolicyId: nonEmptyString(record.evidencePolicyId, "stage.evidencePolicyId", "missing_evidence"),
		capabilityIds: readStringArray(record, "capabilityIds", "capabilities", "stage"),
		generatedOutputPaths: sortedUniqueStrings(record.generatedOutputPaths ?? [], "stage.generatedOutputPaths"),
		lockPaths: sortedUniqueStrings(record.lockPaths ?? [], "stage.lockPaths"),
		...(computeClass === undefined ? {} : { computeClass: computeClass as WorkflowRecipeComputeClass }),
	};
}

function normalizeGate(value: unknown): GateSpec {
	const record = assertClosedRecord(value, "gate", ["id", "kind", "stageIds", "evidencePolicyId"]);
	return {
		id: nonEmptyString(record.id, "gate.id"),
		kind: nonEmptyString(record.kind, "gate.kind"),
		stageIds:
			record.stageIds === undefined
				? Object.freeze([] as string[])
				: record.id === WORKFLOW_RECIPE_INTENT_TDD_GATE_ID
					? uniqueStringsInOrder(record.stageIds, "gate.stageIds")
					: sortedUniqueStrings(record.stageIds, "gate.stageIds"),
		evidencePolicyId: nonEmptyString(record.evidencePolicyId, "gate.evidencePolicyId", "missing_evidence"),
	};
}

function normalizeCapability(value: unknown): CapabilityRequirement {
	const record = assertClosedRecord(value, "capability", ["id", "name", "optional", "snapshotDigest"]);
	if (record.optional !== undefined && typeof record.optional !== "boolean")
		fail("capability_status_invalid", "capability.optional must be boolean.");
	if (record.snapshotDigest !== undefined) nonEmptyString(record.snapshotDigest, "capability.snapshotDigest");
	return {
		id: nonEmptyString(record.id, "capability.id"),
		name: nonEmptyString(record.name, "capability.name"),
		optional: record.optional as boolean | undefined,
		snapshotDigest: record.snapshotDigest as string | undefined,
	};
}

function normalizeEvidencePolicy(value: unknown): EvidencePolicy {
	const record = assertClosedRecord(value, "evidence policy", [
		"id",
		"maxBytes",
		"maxItems",
		"independent",
		"kind",
		"requiredClaims",
	]);
	if (record.independent !== undefined && typeof record.independent !== "boolean")
		fail("recipe_invalid", "evidence policy independence is invalid.");
	if (record.kind !== undefined) nonEmptyString(record.kind, "evidence policy.kind");
	const requiredClaims =
		record.requiredClaims === undefined
			? undefined
			: uniqueStringsInOrder(record.requiredClaims, "evidence policy.requiredClaims");
	if (
		requiredClaims?.some(
			(claim) => !WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_CLAIMS.includes(claim as WorkflowRecipeIntentTddEvidenceClaim),
		)
	)
		fail("recipe_invalid", "evidence policy.requiredClaims contains an unknown claim.");
	return {
		id: nonEmptyString(record.id, "evidence policy.id"),
		maxBytes: positiveInteger(
			record.maxBytes,
			"evidence policy.maxBytes",
			"recipe_invalid",
			WORKFLOW_RECIPE_LIMITS.maxEvidenceBytes,
		),
		maxItems: positiveInteger(
			record.maxItems,
			"evidence policy.maxItems",
			"recipe_invalid",
			WORKFLOW_RECIPE_LIMITS.maxEvidenceItems,
		),
		independent: record.independent as boolean | undefined,
		kind: record.kind as string | undefined,
		requiredClaims: requiredClaims as readonly WorkflowRecipeIntentTddEvidenceClaim[] | undefined,
	};
}

function normalizeEdge(value: unknown): EdgeSpec {
	const record = assertClosedRecord(value, "edge", ["id", "from", "to", "kind", "gateId"]);
	const kind = record.kind ?? "forward";
	if (kind !== "forward" && kind !== "back") fail("recipe_invalid", "edge.kind is invalid.");
	return {
		id: nonEmptyString(record.id, "edge.id"),
		from: nonEmptyString(record.from, "edge.from"),
		to: nonEmptyString(record.to, "edge.to"),
		kind,
		gateId: record.gateId === undefined ? undefined : nonEmptyString(record.gateId, "edge.gateId"),
	};
}

function normalizeFanOut(value: unknown): FanOutSpec {
	const record = assertClosedRecord(value, "fan-out", [
		"id",
		"from",
		"branchStageIds",
		"branches",
		"joinStageId",
		"maxBranches",
	]);
	const branches = readStringArray(record, "branchStageIds", "branches", "fan-out");
	if (branches.length === 0) fail("recipe_fanout_mismatch", "fan-out must declare branches.");
	return {
		id: nonEmptyString(record.id, "fan-out.id"),
		from: nonEmptyString(record.from, "fan-out.from"),
		branchStageIds: branches,
		joinStageId: nonEmptyString(record.joinStageId, "fan-out.joinStageId"),
		maxBranches: record.maxBranches as number | undefined,
	};
}

function normalizeLoop(value: unknown): LoopSpec {
	const record = assertClosedRecord(value, "loop", [
		"id",
		"from",
		"to",
		"gateId",
		"maxTraversals",
		"progressEvidencePolicyId",
		"exhaustionGateId",
	]);
	return {
		id: nonEmptyString(record.id, "loop.id"),
		from: nonEmptyString(record.from, "loop.from"),
		to: nonEmptyString(record.to, "loop.to"),
		gateId: record.gateId === undefined ? undefined : nonEmptyString(record.gateId, "loop.gateId"),
		maxTraversals: record.maxTraversals as number | undefined,
		progressEvidencePolicyId:
			record.progressEvidencePolicyId === undefined
				? undefined
				: nonEmptyString(record.progressEvidencePolicyId, "loop.progressEvidencePolicyId"),
		exhaustionGateId:
			record.exhaustionGateId === undefined
				? undefined
				: nonEmptyString(record.exhaustionGateId, "loop.exhaustionGateId"),
	};
}

function normalizeOpaqueHoldout(value: unknown): WorkflowRecipeOpaqueHoldout {
	const record = assertClosedRecord(value, "opaque holdout", [
		"handleId",
		"manifestDigest",
		"resolverContextId",
		"authorizationReceiptDigest",
		"owner",
		"hidden",
		"opaque",
		"hostResolverOnly",
		"authenticated",
		"returnsEvidenceOnly",
		"returnsBytes",
	]);
	if (
		record.owner !== "host" ||
		record.hidden !== true ||
		record.opaque !== true ||
		record.hostResolverOnly !== true ||
		record.authenticated !== true ||
		record.returnsEvidenceOnly !== true ||
		record.returnsBytes !== false
	)
		fail("opaque_holdout_unresolved", "opaque holdout must be host-authenticated and return evidence only.");
	return {
		handleId: nonEmptyString(record.handleId, "opaque holdout.handleId", "opaque_holdout_unresolved"),
		manifestDigest: nonEmptyString(
			record.manifestDigest,
			"opaque holdout.manifestDigest",
			"opaque_holdout_unresolved",
		),
		resolverContextId: nonEmptyString(
			record.resolverContextId,
			"opaque holdout.resolverContextId",
			"opaque_holdout_unresolved",
		),
		authorizationReceiptDigest: nonEmptyString(
			record.authorizationReceiptDigest,
			"opaque holdout.authorizationReceiptDigest",
			"opaque_holdout_unresolved",
		),
		owner: "host",
		hidden: true,
		opaque: true,
		hostResolverOnly: true,
		authenticated: true,
		returnsEvidenceOnly: true,
		returnsBytes: false,
	};
}

function normalizeOverlays(value: unknown): WorkflowRecipeOverlays {
	const overlays = assertClosedRecord(value, "recipe overlays", [
		"universalHostGateIds",
		"universalHostGates",
		"preEvaluationOverfitting",
	]);
	const gateIds = readStringArray(overlays, "universalHostGateIds", "universalHostGates", "recipe overlays");
	let review: PreEvaluationOverfittingReviewSpec | undefined;
	if (overlays.preEvaluationOverfitting !== undefined) {
		const record = assertClosedRecord(overlays.preEvaluationOverfitting, "overfitting review", [
			"evidencePolicyId",
			"checks",
			"blockingBoundaries",
			"opaqueHoldoutRef",
		]);
		const checks = sortedUniqueStrings(record.checks, "overfitting review.checks");
		const boundaries = sortedUniqueStrings(record.blockingBoundaries, "overfitting review.blockingBoundaries");
		review = {
			evidencePolicyId: nonEmptyString(
				record.evidencePolicyId,
				"overfitting review.evidencePolicyId",
				"missing_overfitting_review",
			),
			checks: checks as readonly WorkflowRecipeOverfittingCheck[],
			blockingBoundaries: boundaries as readonly WorkflowRecipeBlockingBoundary[],
			opaqueHoldoutRef: nonEmptyString(
				record.opaqueHoldoutRef,
				"overfitting review.opaqueHoldoutRef",
				"missing_overfitting_review",
			),
		};
	}
	return { universalHostGateIds: gateIds, preEvaluationOverfitting: review };
}

function normalizeProposal(input: WorkflowRecipeProposal): WorkflowRecipeProposal {
	assertNoHiddenMembers(input, "recipe proposal");
	const record = assertClosedRecord(input, "recipe proposal", [
		"recipeId",
		"revision",
		"taskGraphDigest",
		"graphDigest",
		"effectiveGraphDigest",
		"requiredSkillSnapshotDigests",
		"stages",
		"gates",
		"capabilities",
		"evidencePolicies",
		"edges",
		"fanOuts",
		"loops",
		"overlays",
	]);
	const taskGraphDigest = record.taskGraphDigest;
	const graphDigest = record.graphDigest;
	const effectiveGraphDigest = record.effectiveGraphDigest;
	const requiredSkillSnapshotDigests =
		record.requiredSkillSnapshotDigests === undefined
			? undefined
			: sortedUniqueStrings(record.requiredSkillSnapshotDigests, "requiredSkillSnapshotDigests");
	if (taskGraphDigest !== undefined && typeof taskGraphDigest !== "string")
		fail("recipe_invalid", "taskGraphDigest is invalid.");
	if (graphDigest !== undefined && typeof graphDigest !== "string") fail("recipe_invalid", "graphDigest is invalid.");
	if (effectiveGraphDigest !== undefined && typeof effectiveGraphDigest !== "string")
		fail("recipe_invalid", "effectiveGraphDigest is invalid.");
	if (taskGraphDigest !== undefined && graphDigest !== undefined && taskGraphDigest !== graphDigest)
		fail("compiled_graph_mismatch", "task graph digest aliases disagree.");
	if (
		!Array.isArray(record.stages) ||
		record.stages.length === 0 ||
		record.stages.length > WORKFLOW_RECIPE_LIMITS.maxStages
	)
		fail("recipe_invalid", "recipe stages are outside their bound.");
	if (!Array.isArray(record.gates) || record.gates.length > WORKFLOW_RECIPE_LIMITS.maxGates)
		fail("recipe_invalid", "recipe gates are outside their bound.");
	if (!Array.isArray(record.capabilities) || record.capabilities.length > WORKFLOW_RECIPE_LIMITS.maxCapabilities)
		fail("recipe_invalid", "recipe capabilities are outside their bound.");
	if (
		!Array.isArray(record.evidencePolicies) ||
		record.evidencePolicies.length > WORKFLOW_RECIPE_LIMITS.maxEvidencePolicies
	)
		fail("recipe_invalid", "recipe evidence policies are outside their bound.");
	if (!Array.isArray(record.edges) || record.edges.length > WORKFLOW_RECIPE_LIMITS.maxEdges)
		fail("recipe_invalid", "recipe edges are outside their bound.");
	const stages = record.stages.map(normalizeStage).sort(compareById);
	const gates = record.gates.map(normalizeGate).sort(compareById);
	const capabilities = record.capabilities.map(normalizeCapability).sort(compareById);
	const evidencePolicies = record.evidencePolicies.map(normalizeEvidencePolicy).sort(compareById);
	const edges = record.edges.map(normalizeEdge).sort(compareById);
	const fanOutValues = record.fanOuts === undefined ? [] : record.fanOuts;
	if (!Array.isArray(fanOutValues)) fail("recipe_invalid", "recipe fan-outs are not an array.");
	const fanOuts = fanOutValues.map(normalizeFanOut).sort(compareById);
	const loopValues = record.loops === undefined ? [] : record.loops;
	if (!Array.isArray(loopValues)) fail("recipe_invalid", "recipe loops are not an array.");
	const loops = loopValues.map(normalizeLoop).sort(compareById);
	if (fanOuts.length > WORKFLOW_RECIPE_LIMITS.maxFanOuts)
		fail("recipe_invalid", "recipe fan-outs are outside their bound.");
	if (loops.length > WORKFLOW_RECIPE_LIMITS.maxLoops) fail("recipe_invalid", "recipe loops are outside their bound.");
	return {
		recipeId: nonEmptyString(record.recipeId, "recipeId"),
		revision: positiveInteger(record.revision, "revision"),
		taskGraphDigest: taskGraphDigest as string | undefined,
		graphDigest: graphDigest as string | undefined,
		effectiveGraphDigest: effectiveGraphDigest as string | undefined,
		requiredSkillSnapshotDigests,
		stages: Object.freeze(stages),
		gates: Object.freeze(gates),
		capabilities: Object.freeze(capabilities),
		evidencePolicies: Object.freeze(evidencePolicies),
		edges: Object.freeze(edges),
		fanOuts: Object.freeze(fanOuts),
		loops: Object.freeze(loops),
		overlays: normalizeOverlays(record.overlays),
	};
}

function assertUnique(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length) fail("recipe_invalid", `${label} contains duplicates.`);
}

function assertRegistryValue(
	value: string,
	known: readonly string[],
	code: WorkflowRecipeErrorCode,
	label: string,
): void {
	if (!known.includes(value)) fail(code, `${label} ${value} is not host-registered.`);
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
	if (actual.length !== expected.length) return false;
	return actual.every((value, index) => value === expected[index]);
}

function sameStringRecord(
	actual: Readonly<Record<string, unknown>>,
	expected: Readonly<Record<string, string>>,
): boolean {
	const actualKeys = Object.keys(actual).sort(compareCodePointStrings);
	const expectedKeys = Object.keys(expected).sort(compareCodePointStrings);
	return sameStringSet(actualKeys, expectedKeys) && actualKeys.every((key) => actual[key] === expected[key]);
}

function normalizeRegistry(input: WorkflowRecipeRegistry | undefined): WorkflowRecipeRegistry {
	if (input === undefined) return DEFAULT_WORKFLOW_RECIPE_REGISTRY;
	const record = assertClosedRecord(input, "workflow recipe registry", [
		"registryId",
		"registryRevision",
		"manifestDigest",
		"roles",
		"gates",
		"capabilities",
		"gateKinds",
		"capabilityNames",
	]);
	if (
		record.registryId !== WORKFLOW_RECIPE_REGISTRY_ID ||
		record.registryRevision !== WORKFLOW_RECIPE_REGISTRY_REVISION ||
		record.manifestDigest !== WORKFLOW_RECIPE_REGISTRY_MANIFEST_DIGEST
	)
		fail("registry_invalid", "recipe registry identity or manifest digest is not host-registered.");
	const roles = sortedUniqueStrings(record.roles, "workflow recipe registry.roles");
	const gates = sortedUniqueStrings(record.gates, "workflow recipe registry.gates");
	const capabilities = sortedUniqueStrings(record.capabilities, "workflow recipe registry.capabilities");
	const gateKinds = assertRecord(record.gateKinds, "workflow recipe registry.gateKinds");
	const capabilityNames = assertRecord(record.capabilityNames, "workflow recipe registry.capabilityNames");
	if (
		Object.values(gateKinds).some((value) => typeof value !== "string") ||
		Object.values(capabilityNames).some((value) => typeof value !== "string")
	)
		fail("registry_invalid", "recipe registry bindings must contain strings.");
	const expectedRoles = [...DEFAULT_WORKFLOW_RECIPE_REGISTRY.roles].sort(compareCodePointStrings);
	const expectedGates = [...DEFAULT_WORKFLOW_RECIPE_REGISTRY.gates].sort(compareCodePointStrings);
	const expectedCapabilities = [...DEFAULT_WORKFLOW_RECIPE_REGISTRY.capabilities].sort(compareCodePointStrings);
	if (
		!sameStringSet(roles, expectedRoles) ||
		!sameStringSet(gates, expectedGates) ||
		!sameStringSet(capabilities, expectedCapabilities) ||
		!sameStringRecord(gateKinds, DEFAULT_WORKFLOW_RECIPE_REGISTRY.gateKinds) ||
		!sameStringRecord(capabilityNames, DEFAULT_WORKFLOW_RECIPE_REGISTRY.capabilityNames)
	)
		fail("registry_invalid", "recipe registry must match the host-owned closed registry.");
	return DEFAULT_WORKFLOW_RECIPE_REGISTRY;
}

function normalizeRegisteredManifest(value: WorkflowRecipeRegisteredManifest): WorkflowRecipeRegisteredManifest {
	const record = assertClosedRecord(value, "registered recipe manifest", [
		"recipeId",
		"revision",
		"recipeDigest",
		"registryManifestDigest",
		"immutable",
	]);
	if (record.immutable !== true) fail("compiled_graph_mismatch", "registered recipe manifest is not immutable.");
	return {
		recipeId: nonEmptyString(record.recipeId, "registered recipe manifest.recipeId", "compiled_graph_mismatch"),
		revision: positiveInteger(record.revision, "registered recipe manifest.revision", "compiled_graph_mismatch"),
		recipeDigest: nonEmptyString(
			record.recipeDigest,
			"registered recipe manifest.recipeDigest",
			"compiled_graph_mismatch",
		),
		registryManifestDigest: nonEmptyString(
			record.registryManifestDigest,
			"registered recipe manifest.registryManifestDigest",
			"compiled_graph_mismatch",
		),
		immutable: true,
	};
}

function validateOverlays(
	proposal: WorkflowRecipeProposal,
	stageIds: ReadonlySet<string>,
	gateById: ReadonlyMap<string, GateSpec>,
	evidenceById: ReadonlyMap<string, EvidencePolicy>,
	registry: WorkflowRecipeRegistry,
): void {
	const gateIds = proposal.overlays.universalHostGateIds ?? [];
	if (gateIds.length !== 1 || gateIds[0] !== WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID)
		fail("missing_universal_gate", "recipe must include the universal host decision gate overlay.");
	assertRegistryValue(WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID, registry.gates, "unknown_gate", "universal host gate");
	const universalGates = [...gateById.values()].filter((gate) => gate.kind === "host_adjudication");
	if (
		universalGates.length !== 1 ||
		universalGates[0]?.id !== WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID ||
		(universalGates[0]?.stageIds?.length ?? 0) !== 0
	)
		fail("missing_universal_gate", "the universal host gate must be the sole unscoped host-adjudication gate.");
	const universalGate = universalGates[0];
	if (universalGate === undefined || universalGate.evidencePolicyId === undefined) {
		fail("missing_evidence", "the universal host gate must bind evidence.");
	}
	const universalEvidence = evidenceById.get(universalGate.evidencePolicyId);
	if (universalEvidence?.independent !== true)
		fail("missing_universal_gate", "the universal host gate must bind independent evidence.");
	const review = proposal.overlays.preEvaluationOverfitting;
	if (review === undefined)
		fail("missing_overfitting_review", "recipe must include pre-evaluation overfitting review.");
	const reviewGates = [...gateById.values()].filter((gate) => gate.kind === "overfitting_review");
	const reviewGate = gateById.get(WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID);
	if (
		reviewGates.length !== 1 ||
		reviewGate === undefined ||
		reviewGate.kind !== "overfitting_review" ||
		(reviewGate.stageIds?.length ?? 0) !== 0
	)
		fail("missing_overfitting_review", "recipe must include the host overfitting review gate.");
	if (!evidenceById.has(review.evidencePolicyId))
		fail("missing_evidence", "overfitting review evidence policy is missing.");
	if (reviewGate.evidencePolicyId !== review.evidencePolicyId)
		fail("missing_overfitting_review", "overfitting review gate and overlay must bind the same evidence policy.");
	if (evidenceById.get(review.evidencePolicyId)?.independent !== true)
		fail("missing_overfitting_review", "overfitting review must bind independent evidence.");
	if (review.opaqueHoldoutRef === undefined)
		fail("missing_overfitting_review", "overfitting review must bind an opaque host-only holdout reference.");
	if (
		review.checks.length !== WORKFLOW_RECIPE_OVERFITTING_CHECKS.length ||
		WORKFLOW_RECIPE_OVERFITTING_CHECKS.some((check) => !review.checks.includes(check))
	)
		fail("missing_overfitting_review", "overfitting review must carry all eight host checks.");
	const requiredBoundaries: readonly WorkflowRecipeBlockingBoundary[] = [
		"holdout",
		"promotion",
		"milestone_acceptance",
		"completion",
	];
	if (
		review.blockingBoundaries.length !== requiredBoundaries.length ||
		requiredBoundaries.some((boundary) => !review.blockingBoundaries.includes(boundary))
	)
		fail("missing_overfitting_review", "overfitting review must block every protected boundary.");
	for (const gate of gateById.values()) {
		if (gate.stageIds?.some((stageId) => !stageIds.has(stageId)))
			fail("recipe_invalid", `gate ${gate.id} references an unknown stage.`);
	}
}

function normalizePathBoundary(value: unknown): WorkflowRecipePathBoundaryBinding {
	const record = assertClosedRecord(value, "host path boundary", [
		"descriptorKind",
		"effectBoundaryKind",
		"descriptorDigest",
		"effectBoundaryDigest",
		"workspacePaths",
		"generatedOutputPaths",
	]);
	if (record.descriptorKind !== "host_workspace_descriptor" || record.effectBoundaryKind !== "host_effect_boundary")
		fail("recipe_invalid", "sidecar must bind the host workspace descriptor and effect boundary.");
	return {
		descriptorKind: "host_workspace_descriptor",
		effectBoundaryKind: "host_effect_boundary",
		descriptorDigest: nonEmptyString(record.descriptorDigest, "host path boundary.descriptorDigest"),
		effectBoundaryDigest: nonEmptyString(record.effectBoundaryDigest, "host path boundary.effectBoundaryDigest"),
		workspacePaths: normalizeRoots(record.workspacePaths, "host path boundary.workspacePaths"),
		generatedOutputPaths: normalizeRoots(record.generatedOutputPaths, "host path boundary.generatedOutputPaths"),
	};
}

function recipeReceiptBindingDigest(input: {
	kind: WorkflowRecipeHostReceiptKind;
	context: WorkflowRecipeHostContext;
	recipeId: string;
	revision: number;
	payloadDigest: string;
	metadataDigest?: string;
}): string {
	return digestObject({
		kind: "workflow-recipe-receipt-binding",
		receiptKind: input.kind,
		workflowId: input.context.workflowId,
		recipeId: input.recipeId,
		revision: input.revision,
		registryManifestDigest: input.context.registryManifestDigest,
		hostKeyId: input.context.hostKeyId,
		epochRef: input.context.epochRef,
		headDigest: input.context.headDigest,
		currentDecisionDigest: input.context.currentDecisionDigest,
		contextDigest: input.context.contextDigest,
		payloadDigest: input.payloadDigest,
		...(input.metadataDigest === undefined ? {} : { metadataDigest: input.metadataDigest }),
	});
}

function expectedReceiptKind(kind: WorkflowRecipeHostReceiptKind): WorkflowVerifiedHostReceipt["receiptKind"] {
	if (kind === "opaque_holdout" || kind === "intent_tdd_gate") return "capability";
	if (kind === "universal_gate") return "decision";
	if (kind === "overfitting_gate") return "adjudication";
	return "artifact";
}

function normalizeRecipeArtifactRef(value: unknown, label: string): WorkflowRecipeArtifactRef {
	const record = assertClosedRecord(value, label, [
		"artifactId",
		"relativePath",
		"digest",
		"sizeBytes",
		"sourceEventSequence",
	]);
	const relativePath = nonEmptyString(record.relativePath, `${label}.relativePath`);
	try {
		parseWorkflowCanonicalPath(relativePath);
	} catch {
		fail("capability_snapshot_invalid", `${label}.relativePath is not canonical.`);
	}
	const digest = nonEmptyString(record.digest, `${label}.digest`);
	if (!/^[0-9a-f]{64}$/u.test(digest)) fail("capability_snapshot_invalid", `${label}.digest is not SHA-256.`);
	return {
		artifactId: nonEmptyString(record.artifactId, `${label}.artifactId`),
		relativePath,
		digest,
		sizeBytes: positiveInteger(record.sizeBytes, `${label}.sizeBytes`, "capability_snapshot_invalid"),
		sourceEventSequence: positiveInteger(
			record.sourceEventSequence,
			`${label}.sourceEventSequence`,
			"capability_snapshot_invalid",
		),
	};
}

function signedReceiptPreimageDigest(receipt: WorkflowVerifiedHostReceipt): string {
	const { signature: _signature, verificationDigest: _verificationDigest, ...signedFields } = receipt;
	return digestObject(signedFields);
}

function intentTddEvidenceMetadataDigest(binding: WorkflowRecipeEvidenceBinding): string {
	const normalizedAttackResultArtifactRef =
		binding.attackResultArtifactRef === null
			? null
			: normalizeRecipeArtifactRef(binding.attackResultArtifactRef, "TDD attack-result artifact");
	return digestObject({
		stageId: binding.stageId,
		intentBinding: binding.intentBinding,
		processReceiptDigest: digestObject(binding.processReceipt),
		trustedClockReceiptDigest: digestObject(binding.trustedClockReceipt),
		baseSha: binding.baseSha,
		preCandidateSha: binding.preCandidateSha,
		candidateSha: binding.candidateSha,
		integrationSha: binding.integrationSha,
		reviewedHeadSha: binding.reviewedHeadSha,
		ancestorShas: binding.ancestorShas,
		baseAncestorShas: binding.baseAncestorShas,
		noBaseMerge: binding.noBaseMerge,
		...(binding.worktreeRoot === undefined ? {} : { worktreeRoot: binding.worktreeRoot }),
		...(binding.worktreeStatusDigest === undefined ? {} : { worktreeStatusDigest: binding.worktreeStatusDigest }),
		...(binding.outOfScopePaths === undefined ? {} : { outOfScopePaths: binding.outOfScopePaths }),
		worktreeDecision: binding.worktreeDecision,
		reviewerIdentityDigest: binding.reviewerIdentityDigest,
		reviewerRole: binding.reviewerRole,
		attackResultArtifactRef: normalizedAttackResultArtifactRef,
	});
}

function verifyRecipeHostContext(
	context: WorkflowRecipeHostContext,
	registryManifestDigest: string,
	pathBoundary: WorkflowRecipePathBoundaryBinding,
): void {
	assertClosedRecord(context, "workflow recipe host context", [
		"authorityId",
		"hostKeyId",
		"workflowId",
		"registryManifestDigest",
		"epochRef",
		"currentDecisionDigest",
		"headDigest",
		"issuedAt",
		"validUntil",
		"pathBoundaryDigest",
		"contextDigest",
		"receiptContext",
		"authenticatedReceiptResolver",
		"reviewerPrincipalDigests",
	]);
	if (
		context.authorityId !== WORKFLOW_RECIPE_HOST_AUTHORITY_ID ||
		context.hostKeyId.trim().length === 0 ||
		context.registryManifestDigest !== registryManifestDigest ||
		context.pathBoundaryDigest !== digestObject(pathBoundary) ||
		context.workflowId.trim().length === 0 ||
		context.currentDecisionDigest.trim().length === 0 ||
		context.headDigest.trim().length === 0 ||
		!/^[0-9a-f]{64}$/u.test(context.contextDigest) ||
		!/^[0-9a-f]{64}$/u.test(context.headDigest) ||
		!Number.isFinite(Date.parse(context.issuedAt)) ||
		!Number.isFinite(Date.parse(context.validUntil)) ||
		Date.parse(context.validUntil) <= Date.parse(context.issuedAt) ||
		!Number.isSafeInteger(context.epochRef.storeEpoch) ||
		context.epochRef.storeEpoch < 1 ||
		!Number.isSafeInteger(context.epochRef.coordinatorEpoch) ||
		context.epochRef.coordinatorEpoch < 1
	)
		fail("registry_invalid", "host context is incomplete, stale, or bound to another workspace head.");
	const expectedContextDigest = digestObject({
		kind: "workflow-recipe-host-context",
		authorityId: context.authorityId,
		hostKeyId: context.hostKeyId,
		workflowId: context.workflowId,
		registryManifestDigest,
		epochRef: context.epochRef,
		currentDecisionDigest: context.currentDecisionDigest,
		headDigest: context.headDigest,
		issuedAt: context.issuedAt,
		validUntil: context.validUntil,
		pathBoundaryDigest: context.pathBoundaryDigest,
		...(context.reviewerPrincipalDigests === undefined
			? {}
			: { reviewerPrincipalDigests: context.reviewerPrincipalDigests }),
	});
	if (context.contextDigest !== expectedContextDigest)
		fail("registry_invalid", "host context digest does not match the host-issued context.");
	if (typeof context.receiptContext !== "object" || context.receiptContext === null)
		fail("registry_invalid", "host context is missing its authenticated receipt context.");
	if (
		typeof context.authenticatedReceiptResolver !== "object" ||
		context.authenticatedReceiptResolver === null ||
		typeof context.authenticatedReceiptResolver.verifyConsumedReceipt !== "function"
	)
		fail("registry_invalid", "host context is missing its opaque authenticated receipt authority.");
	const receiptContext = assertClosedRecord(context.receiptContext, "workflow recipe receipt context", [
		"receiptResolver",
		"keyResolver",
		"revokedReceiptIds",
		"artifactResolver",
		"principalAuthorizer",
		"revokeReceipt",
		"signer",
	]);
	if (
		typeof receiptContext.receiptResolver !== "object" ||
		receiptContext.receiptResolver === null ||
		typeof (receiptContext.receiptResolver as { resolve?: unknown }).resolve !== "function" ||
		typeof (receiptContext.receiptResolver as { consumeIfOneUse?: unknown }).consumeIfOneUse !== "function" ||
		typeof (receiptContext.receiptResolver as { resolveConsumptionWitness?: unknown }).resolveConsumptionWitness !==
			"function" ||
		typeof receiptContext.keyResolver !== "object" ||
		receiptContext.keyResolver === null ||
		typeof (receiptContext.keyResolver as { resolve?: unknown }).resolve !== "function" ||
		typeof receiptContext.artifactResolver !== "object" ||
		receiptContext.artifactResolver === null ||
		typeof (receiptContext.artifactResolver as { resolve?: unknown }).resolve !== "function" ||
		typeof receiptContext.principalAuthorizer !== "object" ||
		receiptContext.principalAuthorizer === null ||
		typeof (receiptContext.principalAuthorizer as { authorize?: unknown }).authorize !== "function" ||
		(receiptContext.revokeReceipt !== undefined && typeof receiptContext.revokeReceipt !== "function") ||
		typeof (receiptContext.revokedReceiptIds as { has?: unknown }).has !== "function"
	)
		fail("registry_invalid", "host receipt context is not an authenticated resolver context.");
}

function verifyRecipeHostReceipt<TPayload>(input: {
	receipt: WorkflowRecipeVerifiedHostReceipt<TPayload>;
	kind: WorkflowRecipeHostReceiptKind;
	proposal: WorkflowRecipeProposal;
	context: WorkflowRecipeHostContext;
	metadataDigest?: string;
	expectedAdmissionPreimageDigest?: string;
	proofOut?: { value?: WorkflowRecipeHostReceiptProof };
}): TPayload {
	assertClosedRecord(input.receipt, "workflow recipe host receipt wrapper", [
		"receipt",
		"payload",
		"consumptionWitness",
	]);
	const receipt = input.receipt?.receipt;
	if (receipt === undefined || input.receipt.consumptionWitness === undefined)
		fail("opaque_holdout_unresolved", "host receipt is missing its authenticated receipt or one-use witness.");
	assertClosedRecord(receipt, "workflow recipe host receipt", [
		"receiptKind",
		"oneUse",
		"receiptId",
		"issuerId",
		"workflowId",
		"bindingDigest",
		"payloadDigest",
		"artifactRef",
		"issuedAt",
		"validUntil",
		"keyId",
		"signatureAlgorithm",
		"artifactBytesDigest",
		"stateDigest",
		"revision",
		"signature",
		"verificationDigest",
	]);
	assertClosedRecord(receipt.artifactRef, "workflow recipe host receipt artifact", [
		"artifactId",
		"relativePath",
		"digest",
		"sizeBytes",
		"sourceEventSequence",
	]);
	const normalizedArtifactRef = normalizeRecipeArtifactRef(
		receipt.artifactRef,
		"workflow recipe host receipt artifact",
	);
	assertClosedRecord(input.receipt.consumptionWitness, "workflow recipe receipt consumption witness", [
		"receiptId",
		"workflowId",
		"bindingDigest",
		"capability",
		"resourceDigest",
		"operationDigest",
		"receiptDigest",
		"headDigest",
		"consumedAt",
		"consumptionSequence",
	]);
	assertNoHiddenMembers(input.receipt.payload, "workflow recipe host receipt payload");
	const payloadDigest = digestObject(input.receipt.payload);
	const bindingDigest = recipeReceiptBindingDigest({
		kind: input.kind,
		context: input.context,
		recipeId: input.proposal.recipeId,
		revision: input.proposal.revision,
		payloadDigest,
		metadataDigest: input.metadataDigest,
	});
	const proof = input.context.authenticatedReceiptResolver.verifyConsumedReceipt({
		receipt,
		payload: input.receipt.payload,
		consumptionWitness: input.receipt.consumptionWitness,
		workflowId: input.context.workflowId,
		expectedBindingDigest: bindingDigest,
		currentHeadDigest: input.context.headDigest,
		currentEpochRef: input.context.epochRef,
		currentDecisionDigest: input.context.currentDecisionDigest,
		hostKeyId: input.context.hostKeyId,
		...(input.expectedAdmissionPreimageDigest === undefined
			? {}
			: { expectedAdmissionPreimageDigest: input.expectedAdmissionPreimageDigest }),
	});
	if (proof === null)
		fail("opaque_holdout_unresolved", "host authority did not cryptographically consume this one-use receipt.");
	assertNoHiddenMembers(proof, "workflow recipe host receipt proof");
	assertClosedRecord(proof, "workflow recipe host receipt proof", [
		"proofKind",
		"authorityId",
		"receiptDigest",
		"witnessDigest",
		"workflowId",
		"hostKeyId",
		"bindingDigest",
		"currentHeadDigest",
		"currentDecisionDigest",
		"currentEpochRef",
		"consumptionSequence",
		"signatureVerified",
		"signatureDigest",
		"artifactBytesDigest",
		"artifactSizeBytes",
		"artifactImmutable",
		"oneUseConsumed",
		"admissionPreimageDigest",
		"signedReceiptPreimageDigest",
	]);
	if (
		proof.proofKind !== "ed25519-one-use" ||
		proof.authorityId !== WORKFLOW_RECIPE_HOST_AUTHORITY_ID ||
		proof.receiptDigest !== digestObject(receipt) ||
		proof.witnessDigest !== digestObject(input.receipt.consumptionWitness) ||
		proof.workflowId !== input.context.workflowId ||
		proof.hostKeyId !== input.context.hostKeyId ||
		proof.bindingDigest !== bindingDigest ||
		proof.currentHeadDigest !== input.context.headDigest ||
		proof.currentDecisionDigest !== input.context.currentDecisionDigest ||
		digestObject(proof.currentEpochRef) !== digestObject(input.context.epochRef) ||
		proof.consumptionSequence !== input.receipt.consumptionWitness.consumptionSequence ||
		proof.signatureVerified !== true ||
		proof.signatureDigest !== sha256Hex(receipt.signature) ||
		proof.artifactBytesDigest !== receipt.artifactRef.digest ||
		proof.artifactSizeBytes !== receipt.artifactRef.sizeBytes ||
		proof.artifactImmutable !== true ||
		proof.oneUseConsumed !== true ||
		(input.expectedAdmissionPreimageDigest !== undefined &&
			(proof.admissionPreimageDigest !== input.expectedAdmissionPreimageDigest ||
				proof.signedReceiptPreimageDigest !== signedReceiptPreimageDigest(receipt)))
	)
		fail("opaque_holdout_unresolved", "host receipt proof is unsigned, stale, or not bound to its one-use witness.");
	const issuedAt = Date.parse(receipt.issuedAt);
	const validUntil = Date.parse(receipt.validUntil);
	const consumedAt = Date.parse(input.receipt.consumptionWitness.consumedAt);
	if (
		receipt.receiptKind !== expectedReceiptKind(input.kind) ||
		receipt.workflowId !== input.context.workflowId ||
		receipt.bindingDigest !== bindingDigest ||
		receipt.payloadDigest !== payloadDigest ||
		receipt.oneUse !== true ||
		receipt.issuerId.trim().length === 0 ||
		receipt.receiptId.trim().length === 0 ||
		receipt.keyId !== input.context.hostKeyId ||
		receipt.signature.trim().length === 0 ||
		receipt.signatureAlgorithm !== "ed25519" ||
		receipt.stateDigest !== input.context.headDigest ||
		receipt.revision !== input.proposal.revision ||
		!Number.isFinite(issuedAt) ||
		!Number.isFinite(validUntil) ||
		!Number.isFinite(consumedAt) ||
		issuedAt !== Date.parse(input.context.issuedAt) ||
		validUntil <= Date.parse(input.context.issuedAt) ||
		validUntil > Date.parse(input.context.validUntil) ||
		consumedAt < issuedAt ||
		consumedAt >= validUntil ||
		receipt.artifactBytesDigest !== receipt.artifactRef.digest ||
		digestObject(normalizedArtifactRef) !== digestObject(receipt.artifactRef) ||
		!/^[0-9a-f]{64}$/u.test(receipt.artifactBytesDigest) ||
		!/^[0-9a-f]{64}$/u.test(receipt.verificationDigest) ||
		receipt.verificationDigest !== digestObject({ ...receipt, verificationDigest: "" }) ||
		input.receipt.consumptionWitness.receiptId !== receipt.receiptId ||
		input.receipt.consumptionWitness.workflowId !== receipt.workflowId ||
		input.receipt.consumptionWitness.bindingDigest !== receipt.bindingDigest ||
		input.receipt.consumptionWitness.capability !== (receipt.capabilityBinding?.capability ?? null) ||
		input.receipt.consumptionWitness.resourceDigest !== (receipt.capabilityBinding?.resourceDigest ?? null) ||
		input.receipt.consumptionWitness.operationDigest !== (receipt.capabilityBinding?.operationDigest ?? null) ||
		input.receipt.consumptionWitness.receiptDigest !== digestObject(receipt) ||
		input.receipt.consumptionWitness.headDigest !== input.context.headDigest ||
		!Number.isSafeInteger(input.receipt.consumptionWitness.consumptionSequence) ||
		input.receipt.consumptionWitness.consumptionSequence < 1 ||
		input.context.receiptContext.revokedReceiptIds.has(receipt.receiptId)
	)
		fail("opaque_holdout_unresolved", "host receipt is stale, forged, or not consumed at the current host head.");
	if (input.proofOut !== undefined) input.proofOut.value = proof;
	return freezeDeep(input.receipt.payload);
}

function verifyHostSnapshotReceiptMap<TPayload>(input: {
	receipts: readonly WorkflowRecipeVerifiedHostReceipt<TPayload>[] | undefined;
	kind: "native_capability_snapshot" | "superpowers_skill_snapshot";
	proposal: WorkflowRecipeProposal;
	context: WorkflowRecipeHostContext;
	label: string;
	failureCode: WorkflowRecipeErrorCode;
	getId: (payload: TPayload) => string;
}): ReadonlyMap<string, { payload: TPayload; verificationDigest: string }> {
	if (input.receipts === undefined) return new Map();
	const byId = new Map<string, { payload: TPayload; verificationDigest: string }>();
	for (const receipt of input.receipts) {
		let payload: TPayload;
		try {
			payload = verifyRecipeHostReceipt({
				receipt,
				kind: input.kind,
				proposal: input.proposal,
				context: input.context,
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : `${input.label} receipt is invalid`;
			fail(input.failureCode, message);
		}
		const id = input.getId(payload);
		if (id.length === 0 || byId.has(id))
			fail(input.failureCode, `${input.label} receipts contain duplicate identities.`);
		byId.set(id, { payload, verificationDigest: receipt.receipt.verificationDigest });
	}
	return byId;
}

function hostSnapshotReceiptDigests(
	host: WorkflowRecipeHostResolutionPort,
	includeSkillSnapshots: boolean,
): readonly string[] {
	return Object.freeze(
		[
			...(host.nativeCapabilitySnapshotReceipts ?? []),
			...(includeSkillSnapshots ? (host.superpowersSkillSnapshotReceipts ?? []) : []),
		]
			.map((receipt) => receipt.receipt.verificationDigest)
			.sort(compareCodePointStrings),
	);
}

function validateAdmissionSnapshotArtifacts(value: unknown, label: string, kind: "native" | "superpowers"): void {
	if (!Array.isArray(value)) fail("capability_snapshot_invalid", `${label} must be an array.`);
	const canonical =
		kind === "native"
			? WORKFLOW_RECIPE_CANONICAL_NATIVE_CAPABILITY_SNAPSHOTS
			: WORKFLOW_RECIPE_CANONICAL_SUPERPOWERS_SKILL_SNAPSHOTS;
	const identity = kind === "native" ? "id" : "skillId";
	const seen = new Set<string>();
	let previousIdentity = "";
	for (const [index, snapshot] of value.entries()) {
		assertClosedRecord(
			snapshot,
			`${label}[${index}]`,
			kind === "native"
				? [
						"id",
						"snapshotDigest",
						"manifestDigest",
						"bytesDigest",
						"registryDigest",
						"verificationReceiptDigest",
						"snapshotArtifactRef",
						"manifestArtifactRef",
						"verificationReceiptId",
						"verificationKeyId",
						"immutable",
						"builtIn",
					]
				: [
						"skillId",
						"snapshotDigest",
						"manifestDigest",
						"bytesDigest",
						"registryDigest",
						"verificationReceiptDigest",
						"snapshotArtifactRef",
						"manifestArtifactRef",
						"verificationReceiptId",
						"verificationKeyId",
						"immutable",
						"vendored",
					],
		);
		const snapshotIdentity = (snapshot as Record<string, unknown>)[identity];
		const expected = canonical.find(
			(candidate) => (candidate as unknown as Record<string, unknown>)[identity] === snapshotIdentity,
		);
		if (
			expected === undefined ||
			typeof snapshotIdentity !== "string" ||
			seen.has(snapshotIdentity) ||
			(previousIdentity.length > 0 && compareCodePointStrings(previousIdentity, snapshotIdentity) >= 0) ||
			digestObject(snapshot) !== digestObject(expected)
		)
			fail("capability_snapshot_invalid", `${label}[${index}] is not the canonical immutable artifact.`);
		seen.add(snapshotIdentity);
		previousIdentity = snapshotIdentity;
	}
}

function normalizeHostSkillSnapshots(value: unknown): readonly WorkflowRecipeSuperpowersSkillSnapshot[] {
	if (!Array.isArray(value) || value.length === 0)
		fail("catalog_source_invalid", "host Superpowers skill snapshots are required and must be non-empty.");
	const snapshots = value.map((snapshot) => {
		const record = assertClosedRecord(snapshot, "host Superpowers skill snapshot", [
			"skillId",
			"snapshotDigest",
			"manifestDigest",
			"bytesDigest",
			"snapshotArtifactRef",
			"manifestArtifactRef",
			"verificationReceiptId",
			"verificationKeyId",
			"registryDigest",
			"verificationReceiptDigest",
			"immutable",
			"vendored",
		]);
		if (record.immutable !== true || record.vendored !== true)
			fail("catalog_source_invalid", "host Superpowers skill snapshot is not immutable and vendored.");
		const normalized = {
			skillId: nonEmptyString(record.skillId, "host Superpowers skill snapshot.skillId", "catalog_source_invalid"),
			snapshotDigest: nonEmptyString(
				record.snapshotDigest,
				"host Superpowers skill snapshot.snapshotDigest",
				"catalog_source_invalid",
			),
			manifestDigest: nonEmptyString(
				record.manifestDigest,
				"host Superpowers skill snapshot.manifestDigest",
				"catalog_source_invalid",
			),
			bytesDigest: nonEmptyString(
				record.bytesDigest,
				"host Superpowers skill snapshot.bytesDigest",
				"catalog_source_invalid",
			),
			registryDigest: nonEmptyString(
				record.registryDigest,
				"host Superpowers skill snapshot.registryDigest",
				"catalog_source_invalid",
			),
			verificationReceiptDigest: nonEmptyString(
				record.verificationReceiptDigest,
				"host Superpowers skill snapshot.verificationReceiptDigest",
				"catalog_source_invalid",
			),
			snapshotArtifactRef: normalizeRecipeArtifactRef(
				record.snapshotArtifactRef,
				"host Superpowers skill snapshot.snapshotArtifactRef",
			),
			manifestArtifactRef: normalizeRecipeArtifactRef(
				record.manifestArtifactRef,
				"host Superpowers skill snapshot.manifestArtifactRef",
			),
			verificationReceiptId: nonEmptyString(
				record.verificationReceiptId,
				"host Superpowers skill snapshot.verificationReceiptId",
				"catalog_source_invalid",
			),
			verificationKeyId: nonEmptyString(
				record.verificationKeyId,
				"host Superpowers skill snapshot.verificationKeyId",
				"catalog_source_invalid",
			),
			immutable: true as const,
			vendored: true as const,
		};
		const canonical = WORKFLOW_RECIPE_CANONICAL_SUPERPOWERS_SKILL_REGISTRY.find(
			(snapshot) => snapshot.skillId === normalized.skillId,
		);

		if (
			canonical === undefined ||
			canonical.snapshotDigest !== normalized.snapshotDigest ||
			canonical.manifestDigest !== normalized.manifestDigest ||
			canonical.bytesDigest !== normalized.bytesDigest ||
			canonical.registryDigest !== normalized.registryDigest ||
			canonical.verificationReceiptDigest !== normalized.verificationReceiptDigest ||
			digestObject(canonical.snapshotArtifactRef) !== digestObject(normalized.snapshotArtifactRef) ||
			digestObject(canonical.manifestArtifactRef) !== digestObject(normalized.manifestArtifactRef) ||
			canonical.verificationReceiptId !== normalized.verificationReceiptId ||
			canonical.verificationKeyId !== normalized.verificationKeyId
		)
			fail("catalog_source_invalid", "host Superpowers skill snapshot is not in the vendored canonical registry.");
		return normalized;
	});
	const skillIds = new Set(snapshots.map((snapshot) => snapshot.skillId));
	const snapshotDigests = new Set(snapshots.map((snapshot) => snapshot.snapshotDigest));
	if (skillIds.size !== snapshots.length || snapshotDigests.size !== snapshots.length)
		fail("catalog_source_invalid", "host Superpowers skill snapshots contain duplicates.");
	return Object.freeze(snapshots.sort((left, right) => compareCodePointStrings(left.skillId, right.skillId)));
}

function resolveHostPort(
	input: WorkflowRecipeCompileInput,
	proposal: WorkflowRecipeProposal,
	registry: WorkflowRecipeRegistry,
): {
	host: WorkflowRecipeHostResolutionPort;
	superpowersSkillSnapshots: readonly WorkflowRecipeSuperpowersSkillSnapshot[];
	superpowersCatalogReceipt?: WorkflowRecipeSuperpowersCatalogReceiptPayload;
} {
	const host = input.host;
	if (host === undefined) fail("opaque_holdout_unresolved", "recipe compilation requires a host resolution port.");
	assertClosedRecord(host, "workflow recipe host resolution port", [
		"registryManifestDigest",
		"pathBoundary",
		"context",
		"nativeCapabilitySnapshots",
		"nativeCapabilitySnapshotReceipts",
		"opaqueHoldoutReceipt",
		"universalGateReceipt",
		"overfittingGateReceipt",
		"registeredManifestReceipt",
		"superpowersSkillSnapshots",
		"superpowersSkillSnapshotReceipts",
		"intentTddGateReceipt",
		"superpowersCatalogReceipt",
	]);
	if (host.registryManifestDigest !== registry.manifestDigest)
		fail("registry_invalid", "host resolution port is bound to a foreign registry manifest.");
	if (!Array.isArray(host.nativeCapabilitySnapshots))
		fail("capability_snapshot_invalid", "host native capability snapshots are not an array.");
	try {
		verifyRecipeHostContext(host.context, registry.manifestDigest, normalizePathBoundary(host.pathBoundary));
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "verified host context is invalid";
		fail("registry_invalid", message);
	}
	if (
		host.opaqueHoldoutReceipt === undefined ||
		host.universalGateReceipt === undefined ||
		host.overfittingGateReceipt === undefined
	)
		fail("opaque_holdout_unresolved", "host resolution requires verified receipts for every host gate.");
	const superpowersSkillSnapshots =
		proposal.requiredSkillSnapshotDigests === undefined
			? Object.freeze([])
			: normalizeHostSkillSnapshots(host.superpowersSkillSnapshots);
	const skillSnapshotReceipts = verifyHostSnapshotReceiptMap({
		receipts: host.superpowersSkillSnapshotReceipts,
		kind: "superpowers_skill_snapshot",
		proposal,
		context: host.context,
		label: "host Superpowers skill snapshot",
		failureCode: "catalog_source_invalid",
		getId: (payload) => payload.skillId,
	});
	if (superpowersSkillSnapshots.length > 0) {
		if (skillSnapshotReceipts.size !== superpowersSkillSnapshots.length)
			fail("catalog_source_invalid", "every host Superpowers skill snapshot must have a host-issued receipt.");
		for (const snapshot of superpowersSkillSnapshots) {
			const receipt = skillSnapshotReceipts.get(snapshot.skillId);
			if (receipt === undefined || digestObject(receipt.payload) !== digestObject(snapshot))
				fail("catalog_source_invalid", `host Superpowers skill ${snapshot.skillId} is not receipt-bound.`);
		}
	}
	const superpowersCatalogReceipt = resolveSuperpowersCatalogReceipt(proposal, host);
	if (
		proposal.requiredSkillSnapshotDigests !== undefined &&
		digestObject(proposal.requiredSkillSnapshotDigests) !==
			digestObject(
				superpowersSkillSnapshots.map((snapshot) => snapshot.snapshotDigest).sort(compareCodePointStrings),
			)
	)
		fail("catalog_source_invalid", "host Superpowers skill snapshots do not match the recipe manifest.");
	return { host, superpowersSkillSnapshots, superpowersCatalogReceipt };
}

function resolveHostOpaqueHoldout(
	proposal: WorkflowRecipeProposal,
	host: WorkflowRecipeHostResolutionPort,
	_registry: WorkflowRecipeRegistry,
): WorkflowRecipeOpaqueHoldout {
	const holdoutRef = proposal.overlays.preEvaluationOverfitting?.opaqueHoldoutRef;
	if (holdoutRef === undefined) fail("missing_overfitting_review", "opaque holdout reference is missing.");
	const payload = verifyRecipeHostReceipt({
		receipt: host.opaqueHoldoutReceipt,
		kind: "opaque_holdout",
		proposal,
		context: host.context,
	});
	let normalized: WorkflowRecipeOpaqueHoldout;
	try {
		normalized = normalizeOpaqueHoldout(payload);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "host opaque holdout receipt payload is invalid";
		fail("opaque_holdout_unresolved", message);
	}
	if (normalized.handleId !== holdoutRef)
		fail("opaque_holdout_unresolved", "host holdout resolver returned a different handle than requested.");
	return normalized;
}

function deriveUniversalStageIds(proposal: WorkflowRecipeProposal): readonly string[] {
	const stageIds = proposal.stages.map((stage) => stage.id);
	const indegree = new Map(stageIds.map((stageId) => [stageId, 0]));
	const outgoing = new Map<string, string[]>();
	for (const edge of proposal.edges) {
		if (edge.kind === "back" || !indegree.has(edge.from) || !indegree.has(edge.to)) continue;
		const next = outgoing.get(edge.from) ?? [];
		if (!next.includes(edge.to)) {
			next.push(edge.to);
			indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
		}
		outgoing.set(edge.from, next);
	}
	const ready = stageIds.filter((stageId) => indegree.get(stageId) === 0).sort(compareCodePointStrings);
	const ordered: string[] = [];
	while (ready.length > 0) {
		const stageId = ready.shift();
		if (stageId === undefined) break;
		ordered.push(stageId);
		for (const next of outgoing.get(stageId) ?? []) {
			const nextDegree = (indegree.get(next) ?? 0) - 1;
			indegree.set(next, nextDegree);
			if (nextDegree === 0) {
				ready.push(next);
				ready.sort(compareCodePointStrings);
			}
		}
	}
	if (ordered.length !== stageIds.length)
		fail("universal_gate_contract_invalid", "universal gate topology is cyclic.");
	return Object.freeze(ordered);
}

function resolveUniversalGateBinding(
	proposal: WorkflowRecipeProposal,
	host: WorkflowRecipeHostResolutionPort,
	_registry: WorkflowRecipeRegistry,
): WorkflowRecipeUniversalGateBinding {
	const payload = verifyRecipeHostReceipt({
		receipt: host.universalGateReceipt,
		kind: "universal_gate",
		proposal,
		context: host.context,
	});
	let record: Record<string, unknown>;
	try {
		record = assertClosedRecord(payload, "universal gate binding", [
			"gateId",
			"stageIds",
			"decisionDigest",
			"scorecardDigest",
			"evaluatorDigest",
			"terminal",
			"hostOwned",
		]);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "host universal gate returned an invalid binding";
		fail("universal_gate_contract_invalid", message);
	}
	const stageIds = record.stageIds;
	if (
		record.gateId !== WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID ||
		record.terminal !== true ||
		record.hostOwned !== true ||
		record.decisionDigest !== host.context.currentDecisionDigest ||
		!Array.isArray(stageIds) ||
		digestObject(stageIds) !== digestObject(deriveUniversalStageIds(proposal))
	)
		fail("universal_gate_contract_invalid", "universal gate binding is incomplete or aliased.");
	return {
		gateId: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID,
		stageIds: Object.freeze([...(stageIds as string[])]),
		decisionDigest: nonEmptyString(
			record.decisionDigest,
			"universal gate decisionDigest",
			"universal_gate_contract_invalid",
		),
		scorecardDigest: nonEmptyString(
			record.scorecardDigest,
			"universal gate scorecardDigest",
			"universal_gate_contract_invalid",
		),
		evaluatorDigest: nonEmptyString(
			record.evaluatorDigest,
			"universal gate evaluatorDigest",
			"universal_gate_contract_invalid",
		),
		terminal: true,
		hostOwned: true,
	};
}

function resolveOverfittingGateContract(
	proposal: WorkflowRecipeProposal,
	holdout: WorkflowRecipeOpaqueHoldout,
	host: WorkflowRecipeHostResolutionPort,
	_registry: WorkflowRecipeRegistry,
): WorkflowRecipeOverfittingGateContract {
	const payload = verifyRecipeHostReceipt({
		receipt: host.overfittingGateReceipt,
		kind: "overfitting_gate",
		proposal,
		context: host.context,
	});
	let record: Record<string, unknown>;
	try {
		record = assertClosedRecord(payload, "overfitting gate contract", [
			"gateId",
			"blocking",
			"freshnessDigest",
			"reviewerResultDigest",
			"authenticatedReviewer",
			"opaqueHoldoutManifestDigest",
			"opaqueHoldoutEvidenceDigest",
		]);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "host overfitting gate returned an invalid contract";
		fail("overfitting_gate_contract_invalid", message);
	}
	if (
		record.gateId !== WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID ||
		record.blocking !== true ||
		record.authenticatedReviewer !== true ||
		record.opaqueHoldoutManifestDigest !== holdout.manifestDigest
	)
		fail(
			"overfitting_gate_contract_invalid",
			"overfitting gate contract is not a blocking authenticated host result.",
		);
	return {
		gateId: WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID,
		blocking: true,
		freshnessDigest: nonEmptyString(
			record.freshnessDigest,
			"overfitting gate freshnessDigest",
			"overfitting_gate_contract_invalid",
		),
		reviewerResultDigest: nonEmptyString(
			record.reviewerResultDigest,
			"overfitting gate reviewerResultDigest",
			"overfitting_gate_contract_invalid",
		),
		authenticatedReviewer: true,
		opaqueHoldoutManifestDigest: nonEmptyString(
			record.opaqueHoldoutManifestDigest,
			"overfitting gate opaqueHoldoutManifestDigest",
			"overfitting_gate_contract_invalid",
		),
		opaqueHoldoutEvidenceDigest: nonEmptyString(
			record.opaqueHoldoutEvidenceDigest,
			"overfitting gate opaqueHoldoutEvidenceDigest",
			"overfitting_gate_contract_invalid",
		),
		hostReceiptDigest: host.overfittingGateReceipt.receipt.verificationDigest,
	};
}

function validateIntentTddProposal(
	proposal: WorkflowRecipeProposal,
	evidencePolicies: ReadonlyMap<string, EvidencePolicy>,
	gates: ReadonlyMap<string, GateSpec>,
	graph: WorkflowTaskGraph,
): void {
	if (proposal.recipeId !== WORKFLOW_RECIPE_IMPLEMENTATION_RECIPE_ID) return;
	const stagesById = new Map(proposal.stages.map((stage) => [stage.id, stage]));
	if (
		stagesById.size !== WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.length ||
		WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.some((stageId) => !stagesById.has(stageId))
	)
		fail("intent_tdd_gate_invalid", "implementation recipe must bind every intentional TDD lifecycle stage.");
	for (const [index, stageId] of WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.entries()) {
		const stage = stagesById.get(stageId);
		const evidencePolicy = stage === undefined ? undefined : evidencePolicies.get(stage.evidencePolicyId);
		const requirement = WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_REQUIREMENTS[index];
		if (
			evidencePolicy?.kind !== WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_KINDS[index] ||
			requirement === undefined ||
			digestObject(evidencePolicy.requiredClaims ?? []) !== digestObject(requirement.requiredClaims)
		)
			fail("intent_tdd_gate_invalid", `intent TDD stage ${stageId} does not bind its required evidence kind.`);
		const task = stage === undefined ? undefined : graph.byId.get(stage.taskId);
		if (task === undefined) fail("intent_tdd_gate_invalid", `intent TDD stage ${stageId} has no task.`);
		if (stage !== undefined && stage.taskId !== stageId)
			fail("intent_tdd_gate_invalid", `intent TDD stage ${stageId} must bind its canonical task.`);
		const expectedRoles: Readonly<Record<string, string>> = {
			intent: "recon",
			"acceptance-red": "verify",
			"implementation-green": "implementation",
			integration: "integration",
			metamorphic: "verification",
			"independent-verification": "verification",
			"adversarial-review": "red-team",
		};
		if (stage !== undefined && stage.role !== expectedRoles[stageId])
			fail("intent_tdd_gate_invalid", `intent TDD stage ${stageId} has an unauthorized role.`);
		const expectedDependency = index === 0 ? [] : [WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS[index - 1]];
		if (task !== undefined && digestObject(task.dependencyTaskIds) !== digestObject(expectedDependency))
			fail("intent_tdd_gate_invalid", `intent TDD stage ${stageId} is out of order.`);
	}
	if ((proposal.fanOuts?.length ?? 0) !== 0 || (proposal.loops?.length ?? 0) !== 0)
		fail("intent_tdd_gate_invalid", "intent TDD cannot bypass its ordered lifecycle with fan-out or loops.");
	const tddGate = gates.get(WORKFLOW_RECIPE_INTENT_TDD_GATE_ID);
	if (
		tddGate === undefined ||
		tddGate.kind !== "tdd_lifecycle" ||
		tddGate.evidencePolicyId === undefined ||
		evidencePolicies.get(tddGate.evidencePolicyId)?.kind !== "tdd_lifecycle" ||
		tddGate.stageIds?.length !== WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.length ||
		WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.some((stageId, index) => tddGate.stageIds?.[index] !== stageId)
	)
		fail("intent_tdd_gate_invalid", "implementation recipe must bind its host intent TDD lifecycle gate.");
}

function isFullGitSha(value: string): boolean {
	return /^[0-9a-f]{40}$/u.test(value);
}

function gitText(args: readonly string[]): string | null {
	try {
		return execFileSync("git", [...args], {
			cwd: process.cwd(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 1_048_576,
		}).trim();
	} catch {
		return null;
	}
}

function isGitAncestor(ancestorSha: string, descendantSha: string): boolean {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", ancestorSha, descendantSha], {
			cwd: process.cwd(),
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

function gitWorktreeStatus(): { root: string; status: string; paths: readonly string[] } | null {
	const root = gitText(["rev-parse", "--show-toplevel"]);
	const status = gitText(["status", "--porcelain=v1", "--untracked-files=all"]);
	if (root === null || status === null) return null;
	const paths = new Set<string>();
	for (const line of status.length === 0 ? [] : status.split("\n")) {
		if (line.length < 4) return null;
		const pathText = line.slice(3);
		const candidates = pathText.includes(" -> ") ? pathText.split(" -> ") : [pathText];
		for (const candidate of candidates) {
			if (
				candidate.length === 0 ||
				candidate.normalize("NFC") !== candidate ||
				candidate.startsWith("/") ||
				candidate.split("/").some((part) => part === ".." || part.length === 0)
			)
				return null;
			paths.add(candidate);
		}
	}
	return {
		root: resolve(root),
		status,
		paths: Object.freeze([...paths].sort(compareCodePointStrings)),
	};
}

function validateIntentTddGitTopology(binding: WorkflowRecipeEvidenceBinding, stageId: string): void {
	const commitFields = [
		["base", binding.baseSha],
		["pre-candidate", binding.preCandidateSha],
		["candidate", binding.candidateSha],
		["reviewed head", binding.reviewedHeadSha],
		...(binding.integrationSha === null ? [] : [["integration", binding.integrationSha] as const]),
	] as const;
	for (const [label, sha] of commitFields) {
		if (!isFullGitSha(sha) || gitText(["cat-file", "-t", sha]) !== "commit")
			fail("intent_tdd_gate_invalid", `TDD stage ${stageId} must bind a real Git ${label} commit.`);
	}
	if (!isGitAncestor(binding.baseSha, binding.candidateSha))
		fail("intent_tdd_gate_invalid", `TDD stage ${stageId} base is not an ancestor of the candidate commit.`);
	if (binding.preCandidateSha !== binding.baseSha || !isGitAncestor(binding.preCandidateSha, binding.candidateSha))
		fail("intent_tdd_gate_invalid", `TDD stage ${stageId} pre-candidate is not the immutable base commit.`);
	if (binding.integrationSha !== null) {
		if (!isGitAncestor(binding.integrationSha, binding.baseSha))
			fail("intent_tdd_gate_invalid", `TDD stage ${stageId} integration is not an ancestor of or equal to base.`);
		if (!isGitAncestor(binding.integrationSha, binding.candidateSha))
			fail("intent_tdd_gate_invalid", `TDD stage ${stageId} integration is not an ancestor of the candidate.`);
	}
	if (!isGitAncestor(binding.candidateSha, binding.reviewedHeadSha))
		fail("intent_tdd_gate_invalid", `TDD stage ${stageId} reviewed head is not at or after the candidate.`);
	if (binding.noBaseMerge && gitText(["rev-list", "--merges", `${binding.baseSha}..${binding.candidateSha}`]) !== "")
		fail("intent_tdd_gate_invalid", `TDD stage ${stageId} contains a merge of the base line.`);
	if (binding.worktreeDecision !== "isolated" && binding.worktreeDecision !== "shared-safe")
		fail("intent_tdd_gate_invalid", `TDD stage ${stageId} has an invalid worktree decision.`);
	const worktree = gitWorktreeStatus();
	const currentHead = gitText(["rev-parse", "HEAD"]);
	if (worktree === null || currentHead !== binding.reviewedHeadSha)
		fail("intent_tdd_gate_invalid", `TDD stage ${stageId} is not bound to the current Git worktree head.`);
	const worktreeBindingPresent =
		binding.worktreeRoot !== undefined ||
		binding.worktreeStatusDigest !== undefined ||
		binding.outOfScopePaths !== undefined;
	if (
		worktreeBindingPresent &&
		(binding.worktreeRoot === undefined ||
			binding.worktreeStatusDigest === undefined ||
			binding.outOfScopePaths === undefined)
	)
		fail("intent_tdd_gate_invalid", `TDD stage ${stageId} has an incomplete canonical worktree binding.`);
	if (binding.worktreeRoot !== undefined && resolve(binding.worktreeRoot) !== worktree.root)
		fail("intent_tdd_gate_invalid", `TDD stage ${stageId} is bound to a different configured worktree.`);
	if (binding.worktreeStatusDigest !== undefined) {
		if (
			!/^[0-9a-f]{64}$/u.test(binding.worktreeStatusDigest) ||
			sha256Hex(worktree.status) !== binding.worktreeStatusDigest
		)
			fail("intent_tdd_gate_invalid", `TDD stage ${stageId} worktree status changed after host resolution.`);
		if (binding.outOfScopePaths === undefined)
			fail("intent_tdd_gate_invalid", `TDD stage ${stageId} omits the exact out-of-scope worktree decision.`);
		if (
			digestObject(binding.outOfScopePaths) !==
			digestObject([...binding.outOfScopePaths].sort(compareCodePointStrings))
		)
			fail("intent_tdd_gate_invalid", `TDD stage ${stageId} out-of-scope paths are not canonical.`);
		if (digestObject(binding.outOfScopePaths) !== digestObject(worktree.paths))
			fail("intent_tdd_gate_invalid", `TDD stage ${stageId} out-of-scope paths do not match the current worktree.`);
		if (binding.worktreeDecision === "isolated" && worktree.paths.length !== 0)
			fail("intent_tdd_gate_invalid", `TDD stage ${stageId} claims an isolated worktree with out-of-scope changes.`);
	}
}

function inputReceiptRevoked(host: WorkflowRecipeHostResolutionPort, receiptId: string): boolean {
	return host.context.receiptContext.revokedReceiptIds.has(receiptId);
}

function expectedIntentTddEvidenceIntentBinding(
	proposal: WorkflowRecipeProposal,
	stage: StageSpec,
	task: WorkflowTask,
	requirement: WorkflowRecipeIntentTddEvidenceRequirement,
): WorkflowRecipeIntentTddEvidenceIntentBinding {
	return {
		goalDigest: digestObject({
			kind: "intent-tdd-goal",
			recipeId: proposal.recipeId,
			revision: proposal.revision,
			stageId: stage.id,
			taskId: task.taskId,
			objective: task.objective,
		}),
		requirementDigest: digestObject({
			kind: "intent-tdd-requirement",
			stageId: stage.id,
			taskId: task.taskId,
			evidencePolicyId: stage.evidencePolicyId,
			evidenceKind: requirement.evidenceKind,
			requiredClaims: requirement.requiredClaims,
			requirementIds: task.requirementIds,
			completionCriteria: task.completionCriteria,
		}),
		forbiddenOutcomeDigest: digestObject({
			kind: "intent-tdd-forbidden-outcomes",
			stageId: stage.id,
			outcomes:
				WORKFLOW_RECIPE_INTENT_TDD_FORBIDDEN_OUTCOMES[
					stage.id as keyof typeof WORKFLOW_RECIPE_INTENT_TDD_FORBIDDEN_OUTCOMES
				],
		}),
	};
}

function validateIntentTddEvidence(
	proposal: WorkflowRecipeProposal,
	graph: WorkflowTaskGraph,
	host: WorkflowRecipeHostResolutionPort,
	evidence: readonly WorkflowRecipeEvidenceBinding[] | undefined,
): { digest: string; envelopeDigests: readonly string[] } {
	if (proposal.recipeId !== WORKFLOW_RECIPE_IMPLEMENTATION_RECIPE_ID)
		return { digest: digestObject([]), envelopeDigests: Object.freeze([]) };
	if (evidence === undefined || evidence.length !== WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.length)
		fail(
			"intent_tdd_gate_invalid",
			"implementation promotion requires one host-validated evidence envelope per TDD stage.",
		);
	const byStage = new Map<string, WorkflowRecipeEvidenceBinding>();
	for (const binding of evidence) {
		assertNoHiddenMembers(binding, "intent TDD evidence binding");
		assertClosedRecord(binding, "intent TDD evidence binding", [
			"stageId",
			"envelope",
			"validationReceipt",
			"processReceipt",
			"trustedClockReceipt",
			"consumptionWitness",
			"intentBinding",
			"baseSha",
			"preCandidateSha",
			"candidateSha",
			"integrationSha",
			"reviewedHeadSha",
			"ancestorShas",
			"baseAncestorShas",
			"noBaseMerge",
			"worktreeDecision",
			"worktreeRoot",
			"worktreeStatusDigest",
			"outOfScopePaths",
			"reviewerIdentityDigest",
			"reviewerRole",
			"attackResultArtifactRef",
		]);
		if (byStage.has(binding.stageId)) fail("intent_tdd_gate_invalid", "TDD evidence stages must be unique.");
		byStage.set(binding.stageId, binding);
	}
	const envelopeDigests: string[] = [];
	let canonicalBaseSha: string | undefined;
	let canonicalCandidateSha: string | undefined;
	let canonicalIntegrationSha: string | null | undefined;
	let canonicalReviewedHeadSha: string | undefined;
	let previousConsumptionSequence: number | undefined;
	let acceptanceRedConsumptionSequence: number | undefined;
	let implementationGreenConsumptionSequence: number | undefined;
	let independentReviewerIdentityDigest: string | undefined;
	for (const [index, stageId] of WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.entries()) {
		const binding = byStage.get(stageId);
		if (binding === undefined) fail("intent_tdd_gate_invalid", `TDD evidence is missing stage ${stageId}.`);
		const stage = proposal.stages.find((candidate) => candidate.id === stageId);
		if (stage === undefined) fail("intent_tdd_gate_invalid", `TDD evidence is missing proposal stage ${stageId}.`);
		const task = graph.byId.get(stage.taskId);
		if (task === undefined) fail("intent_tdd_gate_invalid", `TDD evidence is missing graph task ${stage.taskId}.`);
		const envelope = binding.envelope;
		assertNoHiddenMembers(envelope, `TDD evidence envelope ${stageId}`);
		assertClosedRecord(envelope, `TDD evidence envelope ${stageId}`, [
			"evidenceId",
			"evidenceRevision",
			"requirementId",
			"claim",
			"result",
			"method",
			"command",
			"artifactObservations",
			"scanner",
			"confidence",
			"limitations",
			"workspaceDigest",
			"configDigest",
			"revisions",
			"evaluatorDigest",
			"parserDigest",
			"guardDigest",
			"updatedDigest",
			"invalidatedByDecisionRef",
			"regressed",
			"auditorDecisionRef",
			"observedAt",
			"freshUntil",
			"freshnessWindowMilliseconds",
		]);
		const envelopeDigest = digestObject(envelope);
		const receipt = binding.validationReceipt;
		const processReceipt = binding.processReceipt;
		const trustedClockReceipt = binding.trustedClockReceipt;
		const witness = binding.consumptionWitness;
		assertClosedRecord(receipt, `TDD validation receipt ${stageId}`, [
			"receiptKind",
			"oneUse",
			"receiptId",
			"issuerId",
			"workflowId",
			"bindingDigest",
			"payloadDigest",
			"artifactRef",
			"issuedAt",
			"validUntil",
			"keyId",
			"signatureAlgorithm",
			"artifactBytesDigest",
			"stateDigest",
			"revision",
			"signature",
			"verificationDigest",
		]);
		assertClosedRecord(receipt.artifactRef, `TDD validation artifact ${stageId}`, [
			"artifactId",
			"relativePath",
			"digest",
			"sizeBytes",
			"sourceEventSequence",
		]);
		if (envelope.command === null) {
			if (processReceipt !== null) {
				fail(
					"intent_tdd_gate_invalid",
					`TDD stage ${stageId} has a process receipt without a command observation.`,
				);
			}
		} else {
			if (processReceipt === null)
				fail("intent_tdd_gate_invalid", `TDD stage ${stageId} command evidence lacks a host process receipt.`);
			assertClosedRecord(processReceipt, `TDD process receipt ${stageId}`, [
				"receipt",
				"payload",
				"consumptionWitness",
			]);
			const processCommand = verifyRecipeHostReceipt({
				receipt: processReceipt,
				kind: "process_evidence",
				proposal,
				context: host.context,
				metadataDigest: digestObject({ stageId, commandDigest: digestObject(envelope.command) }),
			});
			if (digestObject(processCommand) !== digestObject(envelope.command))
				fail("intent_tdd_gate_invalid", `TDD process receipt ${stageId} is not bound to the exact command.`);
		}
		assertClosedRecord(trustedClockReceipt, `TDD trusted clock receipt ${stageId}`, [
			"receiptKind",
			"oneUse",
			"receiptId",
			"issuerId",
			"workflowId",
			"bindingDigest",
			"payloadDigest",
			"artifactRef",
			"issuedAt",
			"validUntil",
			"keyId",
			"signatureAlgorithm",
			"artifactBytesDigest",
			"stateDigest",
			"revision",
			"signature",
			"verificationDigest",
		]);
		assertClosedRecord(trustedClockReceipt.artifactRef, `TDD trusted clock artifact ${stageId}`, [
			"artifactId",
			"relativePath",
			"digest",
			"sizeBytes",
			"sourceEventSequence",
		]);
		const normalizedValidationArtifactRef = normalizeRecipeArtifactRef(
			receipt.artifactRef,
			`TDD validation artifact ${stageId}`,
		);
		assertClosedRecord(witness, `TDD consumption witness ${stageId}`, [
			"receiptId",
			"workflowId",
			"bindingDigest",
			"capability",
			"resourceDigest",
			"operationDigest",
			"receiptDigest",
			"headDigest",
			"consumedAt",
			"consumptionSequence",
		]);
		const intentBindingRecord = assertClosedRecord(binding.intentBinding, `TDD intent binding ${stageId}`, [
			"goalDigest",
			"requirementDigest",
			"forbiddenOutcomeDigest",
		]);
		const requirement = WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_REQUIREMENTS[index];
		if (requirement === undefined)
			fail("intent_tdd_gate_invalid", `TDD evidence requirement ${stageId} is not host-registered.`);
		const expectedIntentBinding = expectedIntentTddEvidenceIntentBinding(proposal, stage, task, requirement);
		if (
			digestObject(intentBindingRecord) !== digestObject(expectedIntentBinding) ||
			Object.values(intentBindingRecord).some((value) => typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
		)
			fail("intent_tdd_gate_invalid", `TDD evidence for ${stageId} is not bound to typed intent outcomes.`);
		const expectedReviewerRole = index === 5 ? "independent" : index === 6 ? "adversarial" : null;
		if (binding.reviewerRole !== expectedReviewerRole)
			fail("intent_tdd_gate_invalid", `TDD evidence for ${stageId} has no canonical reviewer role.`);
		if (expectedReviewerRole === null) {
			if (binding.reviewerIdentityDigest !== null || binding.attackResultArtifactRef !== null)
				fail("intent_tdd_gate_invalid", `TDD stage ${stageId} cannot claim a reviewer artifact.`);
		} else {
			if (
				typeof binding.reviewerIdentityDigest !== "string" ||
				!/^[0-9a-f]{64}$/u.test(binding.reviewerIdentityDigest)
			)
				fail("intent_tdd_gate_invalid", `TDD stage ${stageId} lacks a host-bound reviewer identity.`);
			if (expectedReviewerRole === "independent") independentReviewerIdentityDigest = binding.reviewerIdentityDigest;
			const reviewerPrincipalDigests = host.context.reviewerPrincipalDigests;
			if (
				!Array.isArray(reviewerPrincipalDigests) ||
				digestObject(reviewerPrincipalDigests) !==
					digestObject([...reviewerPrincipalDigests].sort(compareCodePointStrings)) ||
				!reviewerPrincipalDigests.includes(binding.reviewerIdentityDigest)
			)
				fail("intent_tdd_gate_invalid", `TDD stage ${stageId} is not bound to an authorized reviewer principal.`);
			if (
				expectedReviewerRole === "adversarial" &&
				(independentReviewerIdentityDigest === undefined ||
					binding.reviewerIdentityDigest === independentReviewerIdentityDigest)
			)
				fail("intent_tdd_gate_invalid", "independent and adversarial reviewers must be distinct host identities.");
			if (expectedReviewerRole === "adversarial" && binding.attackResultArtifactRef === null)
				fail("intent_tdd_gate_invalid", `TDD stage ${stageId} lacks its exact attack-result artifact.`);
			if (expectedReviewerRole === "independent" && binding.attackResultArtifactRef !== null)
				fail("intent_tdd_gate_invalid", `TDD stage ${stageId} cannot claim an adversarial artifact.`);
		}
		const normalizedAttackResultArtifactRef =
			binding.attackResultArtifactRef === null
				? null
				: normalizeRecipeArtifactRef(binding.attackResultArtifactRef, `TDD attack-result artifact ${stageId}`);
		if (!Array.isArray(binding.ancestorShas) || !Array.isArray(binding.baseAncestorShas))
			fail("intent_tdd_gate_invalid", `TDD evidence for ${stageId} has no SHA ancestry.`);
		const evidenceMetadataDigest = intentTddEvidenceMetadataDigest(binding);
		const expectedReceiptBindingDigest = recipeReceiptBindingDigest({
			kind: "tdd_evidence",
			context: host.context,
			recipeId: proposal.recipeId,
			revision: proposal.revision,
			payloadDigest: envelopeDigest,
			metadataDigest: evidenceMetadataDigest,
		});
		validateIntentTddGitTopology(binding, stageId);
		let verifiedEnvelope: WorkflowEvidenceEnvelope;
		try {
			verifiedEnvelope = verifyRecipeHostReceipt({
				receipt: {
					receipt: binding.validationReceipt,
					payload: envelope,
					consumptionWitness: witness,
				},
				kind: "tdd_evidence",
				proposal,
				context: host.context,
				metadataDigest: evidenceMetadataDigest,
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "host receipt verification failed";
			fail("intent_tdd_gate_invalid", `TDD evidence for ${stageId} is not host-authorized: ${message}`);
		}
		if (digestObject(verifiedEnvelope) !== digestObject(envelope))
			fail("intent_tdd_gate_invalid", `TDD evidence payload ${stageId} changed during host verification.`);
		const observedAt = Date.parse(envelope.observedAt);
		const freshUntil = Date.parse(envelope.freshUntil);
		const consumedAt = Date.parse(witness.consumedAt);
		const invalidArtifactObservation =
			!Array.isArray(envelope.artifactObservations) ||
			envelope.artifactObservations.length === 0 ||
			envelope.artifactObservations.some((observation) => {
				if (!isRecord(observation) || observation.exists !== true || !isRecord(observation.artifactRef))
					return true;
				return (
					typeof observation.verifiedDigest !== "string" ||
					observation.verifiedDigest !== observation.artifactRef.digest ||
					typeof observation.verifiedSizeBytes !== "number" ||
					!Number.isSafeInteger(observation.verifiedSizeBytes) ||
					observation.verifiedSizeBytes <= 0
				);
			});
		if (
			requirement === undefined ||
			typeof envelope.evidenceId !== "string" ||
			envelope.evidenceId.trim().length === 0 ||
			!Number.isSafeInteger(envelope.evidenceRevision) ||
			envelope.evidenceRevision < 1 ||
			typeof envelope.claim !== "string" ||
			typeof envelope.result !== "string" ||
			typeof envelope.method !== "string" ||
			envelope.claim.trim().length === 0 ||
			envelope.result.trim().length === 0 ||
			envelope.method.trim().length === 0 ||
			invalidArtifactObservation ||
			!isFullGitSha(binding.baseSha) ||
			!isRecord(envelope.scanner) ||
			envelope.scanner.scanStatus === "blocked" ||
			envelope.scanner.redactionStatus === "blocked" ||
			envelope.invalidatedByDecisionRef !== null ||
			envelope.regressed !== false ||
			envelope.auditorDecisionRef !== null ||
			!Number.isFinite(observedAt) ||
			!Number.isFinite(freshUntil) ||
			!Number.isFinite(consumedAt) ||
			freshUntil <= observedAt ||
			freshUntil - observedAt !== envelope.freshnessWindowMilliseconds ||
			consumedAt < observedAt ||
			consumedAt >= freshUntil
		)
			fail("intent_tdd_gate_invalid", `TDD evidence for ${stageId} is not valid intent evidence.`);
		if (
			envelope.requirementId !== stageId ||
			(index === 1 && envelope.result !== "observed-failure") ||
			!isFullGitSha(binding.candidateSha) ||
			!isFullGitSha(binding.preCandidateSha) ||
			!isFullGitSha(binding.reviewedHeadSha) ||
			binding.noBaseMerge !== true ||
			binding.ancestorShas.some((sha) => !isFullGitSha(sha)) ||
			new Set(binding.ancestorShas).size !== binding.ancestorShas.length ||
			!binding.ancestorShas.includes(binding.candidateSha) ||
			!binding.ancestorShas.includes(binding.baseSha) ||
			!binding.ancestorShas.includes(binding.reviewedHeadSha) ||
			binding.baseSha === binding.candidateSha ||
			binding.preCandidateSha !== binding.baseSha ||
			binding.baseSha === binding.reviewedHeadSha ||
			binding.baseAncestorShas.some((sha) => !isFullGitSha(sha)) ||
			new Set(binding.baseAncestorShas).size !== binding.baseAncestorShas.length ||
			binding.baseAncestorShas[0] !== binding.baseSha ||
			receipt.receiptKind !== "artifact" ||
			trustedClockReceipt.receiptKind !== "clock" ||
			trustedClockReceipt.oneUse !== true ||
			trustedClockReceipt.issuerId !== WORKFLOW_RECIPE_HOST_AUTHORITY_ID ||
			trustedClockReceipt.workflowId !== host.context.workflowId ||
			trustedClockReceipt.bindingDigest !==
				digestObject({
					evidenceId: envelope.evidenceId,
					workspaceDigest: envelope.workspaceDigest,
					configDigest: envelope.configDigest,
					revisions: envelope.revisions,
				}) ||
			trustedClockReceipt.keyId !== host.context.hostKeyId ||
			trustedClockReceipt.stateDigest !== host.context.headDigest ||
			trustedClockReceipt.revision !== proposal.revision ||
			trustedClockReceipt.signatureAlgorithm !== "ed25519" ||
			trustedClockReceipt.signature.trim().length === 0 ||
			!/^[0-9a-f]{64}$/u.test(trustedClockReceipt.artifactBytesDigest) ||
			trustedClockReceipt.artifactBytesDigest !== trustedClockReceipt.artifactRef.digest ||
			!/^[0-9a-f]{64}$/u.test(trustedClockReceipt.verificationDigest) ||
			trustedClockReceipt.verificationDigest !== digestObject({ ...trustedClockReceipt, verificationDigest: "" }) ||
			inputReceiptRevoked(host, trustedClockReceipt.receiptId) ||
			receipt.workflowId !== host.context.workflowId ||
			receipt.bindingDigest !== expectedReceiptBindingDigest ||
			receipt.issuerId !== WORKFLOW_RECIPE_HOST_AUTHORITY_ID ||
			receipt.keyId !== host.context.hostKeyId ||
			receipt.payloadDigest !== envelopeDigest ||
			receipt.oneUse !== true ||
			receipt.receiptId.trim().length === 0 ||
			typeof receipt.issuerId !== "string" ||
			typeof receipt.keyId !== "string" ||
			typeof receipt.signature !== "string" ||
			receipt.issuerId !== WORKFLOW_RECIPE_HOST_AUTHORITY_ID ||
			receipt.keyId !== host.context.hostKeyId ||
			receipt.signature.trim().length === 0 ||
			receipt.signatureAlgorithm !== "ed25519" ||
			receipt.stateDigest !== host.context.headDigest ||
			receipt.revision !== proposal.revision ||
			!Number.isFinite(Date.parse(receipt.issuedAt)) ||
			!Number.isFinite(Date.parse(receipt.validUntil)) ||
			Date.parse(receipt.issuedAt) !== Date.parse(host.context.issuedAt) ||
			Date.parse(receipt.validUntil) <= Date.parse(host.context.issuedAt) ||
			Date.parse(receipt.validUntil) > Date.parse(host.context.validUntil) ||
			!/^[0-9a-f]{64}$/u.test(receipt.artifactBytesDigest) ||
			receipt.artifactBytesDigest !== receipt.artifactRef.digest ||
			digestObject(normalizedValidationArtifactRef) !== digestObject(receipt.artifactRef) ||
			!/^[0-9a-f]{64}$/u.test(receipt.verificationDigest) ||
			receipt.verificationDigest !== digestObject({ ...receipt, verificationDigest: "" }) ||
			inputReceiptRevoked(host, receipt.receiptId) ||
			witness.receiptId !== receipt.receiptId ||
			witness.workflowId !== receipt.workflowId ||
			witness.bindingDigest !== receipt.bindingDigest ||
			witness.headDigest !== host.context.headDigest ||
			!Number.isFinite(Date.parse(witness.consumedAt)) ||
			Date.parse(witness.consumedAt) < Date.parse(receipt.issuedAt) ||
			Date.parse(witness.consumedAt) >= Date.parse(receipt.validUntil) ||
			!Number.isSafeInteger(witness.consumptionSequence) ||
			witness.consumptionSequence < 1 ||
			!envelope.artifactObservations.some(
				(observation) =>
					digestObject(observation.artifactRef) === digestObject(normalizedValidationArtifactRef) &&
					observation.verifiedDigest === normalizedValidationArtifactRef.digest &&
					observation.verifiedSizeBytes === normalizedValidationArtifactRef.sizeBytes,
			)
		)
			fail("intent_tdd_gate_invalid", `TDD evidence for ${stageId} is not host-validated intent evidence.`);
		if (
			receipt.artifactRef.sourceEventSequence !== witness.consumptionSequence ||
			(previousConsumptionSequence !== undefined && witness.consumptionSequence <= previousConsumptionSequence)
		)
			fail("intent_tdd_gate_invalid", `TDD evidence for ${stageId} is out of durable host receipt order.`);
		if (
			index === 6 &&
			digestObject(normalizedAttackResultArtifactRef) !== digestObject(normalizedValidationArtifactRef)
		)
			fail("intent_tdd_gate_invalid", "adversarial review is not bound to the exact host attack-result artifact.");
		previousConsumptionSequence = witness.consumptionSequence;
		if (index === 1) acceptanceRedConsumptionSequence = witness.consumptionSequence;
		if (index === 2) {
			implementationGreenConsumptionSequence = witness.consumptionSequence;
			if (
				acceptanceRedConsumptionSequence === undefined ||
				acceptanceRedConsumptionSequence >= implementationGreenConsumptionSequence
			)
				fail("intent_tdd_gate_invalid", "implementation evidence must follow the durable acceptance RED receipt.");
		}
		if (canonicalCandidateSha === undefined) canonicalCandidateSha = binding.candidateSha;
		if (canonicalBaseSha === undefined) canonicalBaseSha = binding.baseSha;
		if (binding.baseSha !== canonicalBaseSha)
			fail("intent_tdd_gate_invalid", "TDD evidence must bind one exact base SHA.");
		if (canonicalReviewedHeadSha === undefined) canonicalReviewedHeadSha = binding.reviewedHeadSha;
		if (binding.candidateSha !== canonicalCandidateSha || binding.reviewedHeadSha !== canonicalReviewedHeadSha)
			fail("intent_tdd_gate_invalid", "TDD evidence must bind one exact candidate and reviewed head SHA.");
		if (index < 3) {
			if (binding.integrationSha !== null)
				fail("intent_tdd_gate_invalid", `TDD stage ${stageId} cannot claim an integration SHA yet.`);
		} else {
			if (binding.integrationSha === null || !isFullGitSha(binding.integrationSha))
				fail("intent_tdd_gate_invalid", `TDD stage ${stageId} requires an exact integration SHA.`);
			if (binding.integrationSha === binding.baseSha)
				fail("intent_tdd_gate_invalid", `TDD stage ${stageId} integration must be distinct from the base commit.`);
			if (canonicalIntegrationSha === undefined) canonicalIntegrationSha = binding.integrationSha;
			if (binding.integrationSha !== canonicalIntegrationSha)
				fail("intent_tdd_gate_invalid", "TDD evidence must bind one exact integration SHA.");
		}
		const expectedBaseAncestors =
			index >= 3 && binding.integrationSha !== binding.baseSha
				? [binding.baseSha, binding.integrationSha]
				: [binding.baseSha];
		if (digestObject(binding.baseAncestorShas) !== digestObject(expectedBaseAncestors))
			fail("intent_tdd_gate_invalid", `TDD stage ${stageId} has invalid base ancestry.`);
		const expectedCandidateAncestors = [
			...new Set([
				binding.candidateSha,
				binding.baseSha,
				...(index >= 3 && binding.integrationSha !== null ? [binding.integrationSha] : []),
				binding.reviewedHeadSha,
			]),
		];
		if (digestObject(binding.ancestorShas) !== digestObject(expectedCandidateAncestors))
			fail("intent_tdd_gate_invalid", `TDD stage ${stageId} has invalid candidate ancestry.`);
		if (index === 1) {
			if (
				envelope.command === null ||
				envelope.command.exitState !== "exited" ||
				envelope.command.exitCode === null ||
				envelope.command.exitCode === 0
			)
				fail("intent_tdd_gate_invalid", "acceptance RED evidence must observe a public-boundary failure.");
		} else if (
			(index >= 2 && envelope.command === null) ||
			(index >= 2 && envelope.command?.exitState !== "exited") ||
			(index >= 2 && envelope.command?.exitCode !== 0)
		)
			fail("intent_tdd_gate_invalid", `TDD stage ${stageId} lacks real observed execution evidence.`);
		if (index >= 3) {
			const integrationSha = binding.integrationSha;
			if (integrationSha === null || !binding.ancestorShas.includes(integrationSha))
				fail("intent_tdd_gate_invalid", `TDD stage ${stageId} is not bound to integration ancestry.`);
		}
		envelopeDigests.push(envelopeDigest);
	}
	return {
		digest: digestObject(
			evidence.map((binding) => ({
				stageId: binding.stageId,
				envelopeDigest: digestObject(binding.envelope),
				intentBinding: binding.intentBinding,
				processReceiptDigest: digestObject(binding.processReceipt),
				trustedClockReceiptDigest: digestObject(binding.trustedClockReceipt),
				baseSha: binding.baseSha,
				preCandidateSha: binding.preCandidateSha,
				candidateSha: binding.candidateSha,
				integrationSha: binding.integrationSha,
				reviewedHeadSha: binding.reviewedHeadSha,
				ancestorShas: [...binding.ancestorShas].sort(compareCodePointStrings),
				baseAncestorShas: [...binding.baseAncestorShas].sort(compareCodePointStrings),
				noBaseMerge: binding.noBaseMerge,
				worktreeDecision: binding.worktreeDecision,
				...(binding.worktreeRoot === undefined ? {} : { worktreeRoot: binding.worktreeRoot }),
				...(binding.worktreeStatusDigest === undefined
					? {}
					: { worktreeStatusDigest: binding.worktreeStatusDigest }),
				...(binding.outOfScopePaths === undefined ? {} : { outOfScopePaths: binding.outOfScopePaths }),
				reviewerIdentityDigest: binding.reviewerIdentityDigest,
				reviewerRole: binding.reviewerRole,
				attackResultArtifactRef: binding.attackResultArtifactRef,
			})),
		),
		envelopeDigests: Object.freeze(envelopeDigests),
	};
}

function resolveIntentTddGateBinding(
	proposal: WorkflowRecipeProposal,
	host: WorkflowRecipeHostResolutionPort,
	_registry: WorkflowRecipeRegistry,
): WorkflowRecipeIntentTddGateBinding | undefined {
	if (proposal.recipeId !== WORKFLOW_RECIPE_IMPLEMENTATION_RECIPE_ID) return undefined;
	if (host.intentTddGateReceipt === undefined)
		fail("intent_tdd_gate_invalid", "implementation recipe requires a host intent TDD lifecycle binding.");
	const payload = verifyRecipeHostReceipt({
		receipt: host.intentTddGateReceipt,
		kind: "intent_tdd_gate",
		proposal,
		context: host.context,
	});
	let record: Record<string, unknown>;
	try {
		record = assertClosedRecord(payload, "intent TDD gate binding", [
			"gateId",
			"stageIds",
			"evidenceKinds",
			"blocking",
			"hostOwned",
			"evidenceRequirements",
			"promotionConstraints",
		]);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "host TDD lifecycle returned an invalid binding";
		fail("intent_tdd_gate_invalid", message);
	}
	const stageIds = record.stageIds;
	const evidenceKinds = record.evidenceKinds;
	const evidenceRequirements = record.evidenceRequirements;
	const promotionConstraints = record.promotionConstraints;
	if (!Array.isArray(evidenceRequirements) || !Array.isArray(promotionConstraints))
		fail("intent_tdd_gate_invalid", "host intent TDD receipt has no intent-level evidence requirements.");
	const normalizedRequirements = evidenceRequirements.map((requirement, index) => {
		const requirementRecord = assertClosedRecord(requirement, `TDD evidence requirement ${index}`, [
			"stageId",
			"evidenceKind",
			"requiredClaims",
		]);
		const requiredClaims = uniqueStringsInOrder(
			requirementRecord.requiredClaims,
			`TDD evidence requirement ${index}.requiredClaims`,
		);
		if (
			typeof requirementRecord.stageId !== "string" ||
			typeof requirementRecord.evidenceKind !== "string" ||
			requiredClaims.some(
				(claim) =>
					!WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_CLAIMS.includes(claim as WorkflowRecipeIntentTddEvidenceClaim),
			)
		)
			fail("intent_tdd_gate_invalid", `intent TDD evidence requirement ${index} is not canonical.`);
		return {
			stageId: requirementRecord.stageId as WorkflowRecipeIntentTddEvidenceRequirement["stageId"],
			evidenceKind: requirementRecord.evidenceKind as WorkflowRecipeIntentTddEvidenceRequirement["evidenceKind"],
			requiredClaims: requiredClaims as readonly WorkflowRecipeIntentTddEvidenceClaim[],
		};
	});
	const normalizedConstraints = uniqueStringsInOrder(promotionConstraints, "TDD promotion constraints");
	if (
		normalizedConstraints.some(
			(constraint) =>
				!WORKFLOW_RECIPE_INTENT_TDD_PROMOTION_CONSTRAINTS.includes(
					constraint as WorkflowRecipeIntentTddPromotionConstraint,
				),
		)
	)
		fail("intent_tdd_gate_invalid", "intent TDD promotion constraints are not canonical.");
	if (
		record.gateId !== WORKFLOW_RECIPE_INTENT_TDD_GATE_ID ||
		record.blocking !== true ||
		record.hostOwned !== true ||
		!Array.isArray(stageIds) ||
		stageIds.length !== WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.length ||
		WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.some((stageId, index) => stageIds[index] !== stageId) ||
		!Array.isArray(evidenceKinds) ||
		evidenceKinds.length !== WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_KINDS.length ||
		WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_KINDS.some((kind, index) => evidenceKinds[index] !== kind) ||
		digestObject(normalizedRequirements) !== digestObject(WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_REQUIREMENTS) ||
		digestObject(normalizedConstraints) !== digestObject(WORKFLOW_RECIPE_INTENT_TDD_PROMOTION_CONSTRAINTS_VALUE)
	)
		fail("intent_tdd_gate_invalid", "host intent TDD binding omits required evidence or protections.");
	return {
		gateId: WORKFLOW_RECIPE_INTENT_TDD_GATE_ID,
		stageIds: WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
		evidenceKinds: WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_KINDS,
		blocking: true,
		hostOwned: true,
		evidenceRequirements: WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_REQUIREMENTS,
		promotionConstraints: WORKFLOW_RECIPE_INTENT_TDD_PROMOTION_CONSTRAINTS_VALUE,
	};
}

function resolveNativeCapabilitySnapshots(
	proposal: WorkflowRecipeProposal,
	host: WorkflowRecipeHostResolutionPort,
): readonly WorkflowRecipeNativeCapabilitySnapshot[] {
	const snapshots = host.nativeCapabilitySnapshots;
	const snapshotReceipts = verifyHostSnapshotReceiptMap({
		receipts: host.nativeCapabilitySnapshotReceipts,
		kind: "native_capability_snapshot",
		proposal,
		context: host.context,
		label: "native capability snapshot",
		failureCode: "capability_snapshot_invalid",
		getId: (payload) => payload.id,
	});
	const byId = new Map<string, WorkflowRecipeNativeCapabilitySnapshot>();
	for (const snapshot of snapshots) {
		const record = assertClosedRecord(snapshot, "native capability snapshot", [
			"id",
			"snapshotDigest",
			"manifestDigest",
			"bytesDigest",
			"registryDigest",
			"verificationReceiptDigest",
			"snapshotArtifactRef",
			"manifestArtifactRef",
			"verificationReceiptId",
			"verificationKeyId",
			"immutable",
			"builtIn",
		]);
		const id = record.id as "autoresearch" | "mempalace";
		if (id !== "autoresearch" && id !== "mempalace")
			fail("capability_snapshot_invalid", "native capability snapshot id is not host-native.");
		if (byId.has(id)) fail("capability_snapshot_invalid", `native capability ${id} is duplicated.`);
		if (record.immutable !== true || record.builtIn !== true)
			fail("capability_snapshot_invalid", `native capability ${id} is not immutable and built-in.`);
		const normalized = {
			id,
			snapshotDigest: nonEmptyString(
				record.snapshotDigest,
				"native capability snapshot.snapshotDigest",
				"capability_snapshot_invalid",
			),
			snapshotArtifactRef: normalizeRecipeArtifactRef(
				record.snapshotArtifactRef,
				"native capability snapshot.snapshotArtifactRef",
			),
			manifestArtifactRef: normalizeRecipeArtifactRef(
				record.manifestArtifactRef,
				"native capability snapshot.manifestArtifactRef",
			),
			verificationReceiptId: nonEmptyString(
				record.verificationReceiptId,
				"native capability snapshot.verificationReceiptId",
				"capability_snapshot_invalid",
			),
			verificationKeyId: nonEmptyString(
				record.verificationKeyId,
				"native capability snapshot.verificationKeyId",
				"capability_snapshot_invalid",
			),
			bytesDigest: nonEmptyString(
				record.bytesDigest,
				"native capability snapshot.bytesDigest",
				"capability_snapshot_invalid",
			),
			manifestDigest: nonEmptyString(
				record.manifestDigest,
				"native capability snapshot.manifestDigest",
				"capability_snapshot_invalid",
			),
			registryDigest: nonEmptyString(
				record.registryDigest,
				"native capability snapshot.registryDigest",
				"capability_snapshot_invalid",
			),
			verificationReceiptDigest: nonEmptyString(
				record.verificationReceiptDigest,
				"native capability snapshot.verificationReceiptDigest",
				"capability_snapshot_invalid",
			),
			immutable: true as const,
			builtIn: true as const,
		};
		const canonical = WORKFLOW_RECIPE_CANONICAL_NATIVE_SNAPSHOTS[id];
		if (
			canonical.snapshotDigest !== normalized.snapshotDigest ||
			canonical.manifestDigest !== normalized.manifestDigest ||
			canonical.bytesDigest !== normalized.bytesDigest ||
			canonical.registryDigest !== normalized.registryDigest ||
			canonical.verificationReceiptDigest !== normalized.verificationReceiptDigest ||
			digestObject(canonical.snapshotArtifactRef) !== digestObject(normalized.snapshotArtifactRef) ||
			digestObject(canonical.manifestArtifactRef) !== digestObject(normalized.manifestArtifactRef) ||
			canonical.verificationReceiptId !== normalized.verificationReceiptId ||
			canonical.verificationKeyId !== normalized.verificationKeyId
		)
			fail("capability_snapshot_invalid", `native capability ${id} is not in the canonical host snapshot registry.`);
		const receipt = snapshotReceipts.get(id);
		if (receipt === undefined || digestObject(receipt.payload) !== digestObject(normalized))
			fail("capability_snapshot_invalid", `native capability ${id} is not bound to a host loader receipt.`);
		byId.set(id, normalized);
	}
	if (snapshotReceipts.size !== snapshots.length)
		fail("capability_snapshot_invalid", "every native capability snapshot must have a host-issued loader receipt.");
	const nativeCapabilityIds = ["autoresearch", "mempalace"] as const;
	const declaredNative = proposal.capabilities.flatMap((capability) =>
		nativeCapabilityIds.filter((id) => capability.id === id || capability.name === id),
	);
	const required = proposal.recipeId.startsWith("builtin:") ? nativeCapabilityIds : [...new Set(declaredNative)];
	for (const id of required) {
		if (!byId.has(id) || !proposal.capabilities.some((capability) => capability.name === id))
			fail("capability_snapshot_invalid", `recipe requires immutable native capability ${id}.`);
	}
	return Object.freeze([...byId.values()].sort((left, right) => compareCodePointStrings(left.id, right.id)));
}

function normalizeCatalogBinding(
	value: WorkflowRecipeCatalogBinding | undefined,
	proposal: WorkflowRecipeProposal,
): WorkflowRecipeCatalogBinding | undefined {
	if (value === undefined) {
		if (proposal.recipeId.startsWith("superpowers:"))
			fail("catalog_source_invalid", "Superpowers recipes require a verified catalog binding.");
		return undefined;
	}
	if (proposal.recipeId.startsWith("superpowers:") && proposal.requiredSkillSnapshotDigests === undefined)
		fail("catalog_source_invalid", "Superpowers recipes require exact immutable skill snapshots.");
	const record = assertClosedRecord(value, "recipe catalog binding", [
		"sourceId",
		"snapshotDigest",
		"provenanceDigest",
		"verificationReceiptDigest",
		"recipeCatalogDigest",
		"skillSnapshotDigests",
	]);
	if (record.sourceId !== "superpowers")
		fail("catalog_source_invalid", "catalog source is not host-verified Superpowers.");
	const skillSnapshotDigests = sortedUniqueStrings(
		record.skillSnapshotDigests,
		"catalog binding.skillSnapshotDigests",
	);
	if (skillSnapshotDigests.length === 0)
		fail("catalog_source_invalid", "Superpowers recipes require exact skill snapshots.");
	if (
		proposal.requiredSkillSnapshotDigests !== undefined &&
		digestObject(proposal.requiredSkillSnapshotDigests) !== digestObject(skillSnapshotDigests)
	)
		fail("catalog_source_invalid", "catalog skill snapshots do not match the recipe's required immutable snapshots.");
	return {
		sourceId: "superpowers",
		snapshotDigest: nonEmptyString(record.snapshotDigest, "catalog binding.snapshotDigest", "catalog_source_invalid"),
		provenanceDigest: nonEmptyString(
			record.provenanceDigest,
			"catalog binding.provenanceDigest",
			"catalog_source_invalid",
		),
		verificationReceiptDigest: nonEmptyString(
			record.verificationReceiptDigest,
			"catalog binding.verificationReceiptDigest",
			"catalog_source_invalid",
		),
		recipeCatalogDigest: nonEmptyString(
			record.recipeCatalogDigest,
			"catalog binding.recipeCatalogDigest",
			"catalog_source_invalid",
		),
		skillSnapshotDigests,
	};
}

function normalizeSuperpowersSource(value: unknown): WorkflowRecipeSuperpowersCatalogSource | undefined {
	try {
		const record = assertClosedRecord(value, "Superpowers catalog source", [
			"sourceId",
			"snapshotDigest",
			"provenanceDigest",
			"verificationReceiptDigest",
			"recipeCatalogDigest",
			"hostVerified",
			"vendored",
			"skillSnapshots",
			"recipes",
		]);
		if (
			record.sourceId !== "superpowers" ||
			record.hostVerified !== true ||
			record.vendored !== true ||
			typeof record.skillSnapshots !== "object" ||
			record.skillSnapshots === null ||
			!Array.isArray(record.skillSnapshots) ||
			!Array.isArray(record.recipes)
		)
			return undefined;
		const skillSnapshots = normalizeHostSkillSnapshots(record.skillSnapshots);
		const recipes = normalizeRecipeCatalog(record.recipes);
		const expectedDigests = getWorkflowRecipeSuperpowersCatalogDigests({ recipes, skillSnapshots });
		if (
			record.snapshotDigest !== expectedDigests.snapshotDigest ||
			record.provenanceDigest !== expectedDigests.provenanceDigest ||
			record.verificationReceiptDigest !== expectedDigests.verificationReceiptDigest ||
			record.recipeCatalogDigest !== expectedDigests.recipeCatalogDigest
		)
			return undefined;
		return {
			sourceId: "superpowers",
			snapshotDigest: nonEmptyString(
				record.snapshotDigest,
				"Superpowers catalog snapshotDigest",
				"catalog_source_invalid",
			),
			provenanceDigest: nonEmptyString(
				record.provenanceDigest,
				"Superpowers catalog provenanceDigest",
				"catalog_source_invalid",
			),
			verificationReceiptDigest: nonEmptyString(
				record.verificationReceiptDigest,
				"Superpowers catalog verificationReceiptDigest",
				"catalog_source_invalid",
			),
			recipeCatalogDigest: nonEmptyString(
				record.recipeCatalogDigest,
				"Superpowers catalog recipeCatalogDigest",
				"catalog_source_invalid",
			),
			hostVerified: true,
			vendored: true,
			skillSnapshots: Object.freeze(
				[...skillSnapshots].sort((left, right) => compareCodePointStrings(left.skillId, right.skillId)),
			),
			recipes,
		};
	} catch (error: unknown) {
		if (error instanceof WorkflowRecipeCompileError && error.code === "recipe_catalog_duplicate") throw error;
		return undefined;
	}
}

function resolveSuperpowersCatalogReceipt(
	proposal: WorkflowRecipeProposal,
	host: WorkflowRecipeHostResolutionPort,
): WorkflowRecipeSuperpowersCatalogReceiptPayload | undefined {
	if (!proposal.recipeId.startsWith("superpowers:")) return undefined;
	if (host.superpowersCatalogReceipt === undefined)
		fail("catalog_source_invalid", "Superpowers recipes require a host-issued catalog receipt.");
	const payload = verifyRecipeHostReceipt({
		receipt: host.superpowersCatalogReceipt,
		kind: "superpowers_catalog",
		proposal,
		context: host.context,
	});
	const record = assertClosedRecord(payload, "Superpowers catalog receipt payload", [
		"sourceId",
		"snapshotDigest",
		"provenanceDigest",
		"verificationReceiptDigest",
		"recipeCatalogDigest",
		"skillSnapshotDigests",
		"hostVerified",
		"vendored",
	]);
	if (record.sourceId !== "superpowers" || record.hostVerified !== true || record.vendored !== true)
		fail("catalog_source_invalid", "Superpowers catalog receipt is not host-verified and vendored.");
	const skillSnapshotDigests = sortedUniqueStrings(
		record.skillSnapshotDigests,
		"Superpowers catalog receipt skillSnapshotDigests",
	);
	if (
		proposal.requiredSkillSnapshotDigests === undefined ||
		digestObject(skillSnapshotDigests) !== digestObject(proposal.requiredSkillSnapshotDigests)
	)
		fail("catalog_source_invalid", "Superpowers catalog receipt does not bind the recipe skill snapshots.");
	return {
		sourceId: "superpowers",
		snapshotDigest: nonEmptyString(
			record.snapshotDigest,
			"Superpowers catalog receipt snapshotDigest",
			"catalog_source_invalid",
		),
		provenanceDigest: nonEmptyString(
			record.provenanceDigest,
			"Superpowers catalog receipt provenanceDigest",
			"catalog_source_invalid",
		),
		verificationReceiptDigest: nonEmptyString(
			record.verificationReceiptDigest,
			"Superpowers catalog receipt verificationReceiptDigest",
			"catalog_source_invalid",
		),
		recipeCatalogDigest: nonEmptyString(
			record.recipeCatalogDigest,
			"Superpowers catalog receipt recipeCatalogDigest",
			"catalog_source_invalid",
		),
		skillSnapshotDigests,
		hostVerified: true,
		vendored: true,
	};
}

function validateCapabilities(
	proposal: WorkflowRecipeProposal,
	registry: WorkflowRecipeRegistry,
): ReadonlyMap<string, CapabilityRequirement> {
	assertUnique(
		proposal.capabilities.map((capability) => capability.id),
		"capability ids",
	);
	const byId = new Map<string, CapabilityRequirement>();
	for (const capability of proposal.capabilities) {
		if (registry.capabilityNames[capability.id] !== capability.name)
			fail("unknown_capability", `capability ${capability.id} is not host-registered with that name.`);
		if (capability.optional !== undefined)
			fail(
				"capability_status_invalid",
				"capability optionality is host-derived and cannot be supplied by a proposal.",
			);
		if (capability.snapshotDigest !== undefined)
			fail(
				"capability_status_invalid",
				"capability snapshots are host-resolved and cannot confer authority through a proposal.",
			);
		byId.set(capability.id, capability);
	}
	return byId;
}

function validateEvidencePolicies(proposal: WorkflowRecipeProposal): ReadonlyMap<string, EvidencePolicy> {
	assertUnique(
		proposal.evidencePolicies.map((policy) => policy.id),
		"evidence policy ids",
	);
	const byId = new Map<string, EvidencePolicy>();
	for (const policy of proposal.evidencePolicies) byId.set(policy.id, policy);
	return byId;
}

function validateGates(
	proposal: WorkflowRecipeProposal,
	registry: WorkflowRecipeRegistry,
): ReadonlyMap<string, GateSpec> {
	assertUnique(
		proposal.gates.map((gate) => gate.id),
		"gate ids",
	);
	const byId = new Map<string, GateSpec>();
	for (const gate of proposal.gates) {
		if (registry.gateKinds[gate.id] === undefined) fail("unknown_gate", `gate ${gate.id} is not host-registered.`);
		if (registry.gateKinds[gate.id] !== gate.kind)
			fail("unknown_gate", `gate ${gate.id} does not bind its host-registered kind.`);
		byId.set(gate.id, gate);
	}
	return byId;
}

function validateStages(
	proposal: WorkflowRecipeProposal,
	graph: WorkflowTaskGraph,
	capabilities: ReadonlyMap<string, CapabilityRequirement>,
	evidencePolicies: ReadonlyMap<string, EvidencePolicy>,
	graphContext: WorkflowTaskGraphContext,
	registry: WorkflowRecipeRegistry,
): ReadonlyMap<string, StageSpec> {
	assertUnique(
		proposal.stages.map((stage) => stage.id),
		"stage ids",
	);
	assertUnique(
		proposal.stages.map((stage) => stage.taskId),
		"stage task bindings",
	);
	if (proposal.stages.length !== graph.tasks.length || proposal.stages.some((stage) => !graph.byId.has(stage.taskId)))
		fail("task_binding_mismatch", "every existing task must have exactly one recipe stage binding.");
	const workspaceRoots = normalizeRoots(graphContext.workspacePaths, "workflow workspace roots");
	const generatedOutputRoots = normalizeRoots(graphContext.generatedOutputPaths, "workflow generated-output roots");
	const pathRoots = Object.freeze(
		[...new Set([...workspaceRoots, ...generatedOutputRoots])].sort(compareCodePointStrings),
	);
	for (const task of graph.tasks) {
		for (const path of task.ownedPaths) normalizePath(path, `task ${task.taskId} owned path`, workspaceRoots);
	}
	const byId = new Map<string, StageSpec>();
	for (const stage of proposal.stages) {
		assertRegistryValue(stage.role, registry.roles, "unknown_role", "stage role");
		if (!evidencePolicies.has(stage.evidencePolicyId))
			fail("missing_evidence", `stage ${stage.id} references missing evidence.`);
		for (const capabilityId of stage.capabilityIds ?? []) {
			if (!capabilities.has(capabilityId))
				fail("unknown_capability", `stage ${stage.id} references ${capabilityId}.`);
		}
		if (
			["planning", "design", "recon", "review"].includes(stage.role) &&
			(stage.capabilityIds ?? []).some((capabilityId) =>
				["write_owned_paths", "edit", "invoke_host_effect", "shell", "ipython", "recursive_spawn"].includes(
					capabilityId,
				),
			)
		)
			fail("capability_status_invalid", `${stage.role} stages are read-only and cannot own mutating capabilities.`);
		const boundTask = graph.byId.get(stage.taskId);
		if (
			boundTask !== undefined &&
			["planning", "design", "recon", "review"].includes(stage.role) &&
			boundTask.authority.some((capability) => !["read_workspace", "read_external_evidence"].includes(capability))
		)
			fail("capability_status_invalid", `${stage.role} task authority must remain read-only.`);
		for (const path of stage.generatedOutputPaths ?? [])
			normalizePath(path, `stage ${stage.id} generated output`, generatedOutputRoots);
		for (const path of stage.lockPaths ?? []) normalizePath(path, `stage ${stage.id} lock`, pathRoots);
		byId.set(stage.id, stage);
	}
	const reservations: { taskId: string; path: string }[] = [];
	for (const task of graph.tasks) {
		for (const path of task.ownedPaths) reservations.push({ taskId: task.taskId, path });
	}
	for (const stage of proposal.stages) {
		for (const path of [...(stage.generatedOutputPaths ?? []), ...(stage.lockPaths ?? [])])
			reservations.push({ taskId: stage.taskId, path });
	}
	for (let leftIndex = 0; leftIndex < reservations.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < reservations.length; rightIndex += 1) {
			const left = reservations[leftIndex];
			const right = reservations[rightIndex];
			if (
				left.taskId !== right.taskId &&
				pathOverlaps(left.path, right.path) &&
				!taskOrderingAllowsOverlap(left.taskId, right.taskId, graph.byId)
			)
				fail("path_overlap", `${left.path} overlaps ${right.path}.`);
			if (left.taskId === right.taskId && left.path === right.path)
				fail("path_overlap", `${left.path} is reserved twice.`);
		}
	}
	return byId;
}

function validateEdges(
	proposal: WorkflowRecipeProposal,
	stages: ReadonlyMap<string, StageSpec>,
	gates: ReadonlyMap<string, GateSpec>,
	graph: WorkflowTaskGraph,
): ReadonlyMap<string, EdgeSpec> {
	assertUnique(
		proposal.edges.map((edge) => edge.id),
		"edge ids",
	);
	const outgoing = new Map<string, string[]>();
	const forwardEdges = new Map<string, EdgeSpec>();
	const backEdges = new Set<string>();
	const stageByTaskId = new Map<string, StageSpec>();
	for (const stage of stages.values()) stageByTaskId.set(stage.taskId, stage);
	for (const edge of proposal.edges) {
		if (!stages.has(edge.from) || !stages.has(edge.to) || edge.from === edge.to)
			fail("recipe_edge_mismatch", `edge ${edge.id} references invalid stages.`);
		if (edge.gateId !== undefined && !gates.has(edge.gateId))
			fail("unknown_gate", `edge ${edge.id} references ${edge.gateId}.`);
		if (edge.kind === "back") {
			const endpointKey = edgeEndpointKey(edge.from, edge.to);
			if (backEdges.has(endpointKey))
				fail("recipe_loop_invalid", `recipe has duplicate back edge ${edge.from} -> ${edge.to}.`);
			backEdges.add(endpointKey);
			continue;
		}
		const from = stages.get(edge.from)!;
		const to = stages.get(edge.to)!;
		const toTaskValue = toTask(graph, to.taskId);
		if (!toTaskValue.dependencyTaskIds.includes(from.taskId))
			fail("recipe_edge_mismatch", `edge ${edge.id} does not match task dependencies.`);
		const endpointKey = edgeEndpointKey(edge.from, edge.to);
		if (forwardEdges.has(endpointKey))
			fail("recipe_edge_mismatch", `recipe has duplicate forward edge ${edge.from} -> ${edge.to}.`);
		forwardEdges.set(endpointKey, edge);
		const current = outgoing.get(edge.from) ?? [];
		current.push(edge.to);
		outgoing.set(edge.from, current);
	}
	for (const task of graph.tasks) {
		const toStage = stageByTaskId.get(task.taskId);
		if (toStage === undefined) fail("task_binding_mismatch", `task ${task.taskId} has no recipe stage.`);
		for (const dependencyTaskId of task.dependencyTaskIds) {
			const fromStage = stageByTaskId.get(dependencyTaskId);
			if (fromStage === undefined) fail("task_binding_mismatch", `task ${dependencyTaskId} has no recipe stage.`);
			const endpointKey = edgeEndpointKey(fromStage.id, toStage.id);
			if (!forwardEdges.has(endpointKey))
				fail(
					"recipe_edge_mismatch",
					`task dependency ${dependencyTaskId} -> ${task.taskId} is missing from recipe edges.`,
				);
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (stageId: string): void => {
		if (visiting.has(stageId)) fail("recipe_edge_cycle", "forward recipe edges contain a cycle.");
		if (visited.has(stageId)) return;
		visiting.add(stageId);
		for (const next of outgoing.get(stageId) ?? []) visit(next);
		visiting.delete(stageId);
		visited.add(stageId);
	};
	for (const stageId of stages.keys()) visit(stageId);
	return forwardEdges;
}

function toTask(graph: WorkflowTaskGraph, taskId: string): WorkflowTask {
	const task = graph.byId.get(taskId);
	if (task === undefined) fail("task_binding_mismatch", `task ${taskId} is not in the validated graph.`);
	return task;
}

function validateFanOuts(
	proposal: WorkflowRecipeProposal,
	stages: ReadonlyMap<string, StageSpec>,
	forwardEdges: ReadonlyMap<string, EdgeSpec>,
	graph: WorkflowTaskGraph,
): void {
	assertUnique(
		(proposal.fanOuts ?? []).map((fanOut) => fanOut.id),
		"fan-out ids",
	);
	const usedBranches = new Set<string>();
	const usedSources = new Set<string>();
	for (const fanOut of proposal.fanOuts ?? []) {
		const branchStageIds = fanOut.branchStageIds ?? [];
		if (
			fanOut.maxBranches === undefined ||
			!Number.isSafeInteger(fanOut.maxBranches) ||
			fanOut.maxBranches <= 0 ||
			fanOut.maxBranches > WORKFLOW_RECIPE_LIMITS.maxFanOutBranches
		)
			fail("unbounded_fanout", `fan-out ${fanOut.id} has no bounded branch count.`);
		if (
			branchStageIds.length === 0 ||
			branchStageIds.length > fanOut.maxBranches ||
			new Set(branchStageIds).size !== branchStageIds.length
		)
			fail("recipe_fanout_mismatch", `fan-out ${fanOut.id} has an invalid branch set.`);
		if (
			!stages.has(fanOut.from) ||
			!stages.has(fanOut.joinStageId) ||
			branchStageIds.some((stageId) => !stages.has(stageId)) ||
			fanOut.from === fanOut.joinStageId ||
			branchStageIds.includes(fanOut.from) ||
			branchStageIds.includes(fanOut.joinStageId)
		)
			fail("recipe_fanout_mismatch", `fan-out ${fanOut.id} references an unknown stage.`);
		if (usedSources.has(fanOut.from)) fail("recipe_fanout_mismatch", `fan-out ${fanOut.id} reuses a source stage.`);
		usedSources.add(fanOut.from);
		for (const branchStageId of branchStageIds) {
			if (usedBranches.has(branchStageId))
				fail("recipe_fanout_mismatch", `fan-out ${fanOut.id} reuses branch stage ${branchStageId}.`);
			usedBranches.add(branchStageId);
			const sourceEdge = forwardEdges.get(edgeEndpointKey(fanOut.from, branchStageId));
			const joinEdge = forwardEdges.get(edgeEndpointKey(branchStageId, fanOut.joinStageId));
			if (sourceEdge === undefined || joinEdge === undefined)
				fail("recipe_fanout_mismatch", `fan-out ${fanOut.id} has no explicit join edge for ${branchStageId}.`);
		}
		for (let leftIndex = 0; leftIndex < branchStageIds.length; leftIndex += 1) {
			for (let rightIndex = leftIndex + 1; rightIndex < branchStageIds.length; rightIndex += 1) {
				const leftTaskId = stages.get(branchStageIds[leftIndex])?.taskId;
				const rightTaskId = stages.get(branchStageIds[rightIndex])?.taskId;
				if (
					leftTaskId !== undefined &&
					rightTaskId !== undefined &&
					(taskDependsOn(graph.byId.get(leftTaskId)!, rightTaskId, graph.byId) ||
						taskDependsOn(graph.byId.get(rightTaskId)!, leftTaskId, graph.byId))
				)
					fail("recipe_fanout_mismatch", `fan-out ${fanOut.id} branches must be independent tasks.`);
			}
		}
		const incomingJoinEdges = [...forwardEdges.values()]
			.filter((edge) => edge.to === fanOut.joinStageId)
			.map((edge) => edge.from)
			.sort(compareCodePointStrings);
		if (
			incomingJoinEdges.length !== branchStageIds.length ||
			incomingJoinEdges.some(
				(stageId, index) => stageId !== [...branchStageIds].sort(compareCodePointStrings)[index],
			)
		)
			fail("recipe_fanout_mismatch", `fan-out ${fanOut.id} join inputs do not match its branches.`);
	}
}

function validateLoops(
	proposal: WorkflowRecipeProposal,
	stages: ReadonlyMap<string, StageSpec>,
	gates: ReadonlyMap<string, GateSpec>,
	evidencePolicies: ReadonlyMap<string, EvidencePolicy>,
): void {
	assertUnique(
		(proposal.loops ?? []).map((loop) => loop.id),
		"loop ids",
	);
	for (const loop of proposal.loops ?? []) {
		if (
			loop.maxTraversals === undefined ||
			!Number.isSafeInteger(loop.maxTraversals) ||
			loop.maxTraversals <= 0 ||
			loop.maxTraversals > WORKFLOW_RECIPE_LIMITS.maxLoopTraversals
		)
			fail("unbounded_loop", `loop ${loop.id} has no bounded traversal count.`);
		if (!stages.has(loop.from) || !stages.has(loop.to))
			fail("recipe_loop_invalid", `loop ${loop.id} references an unknown stage.`);
		if (
			loop.gateId === undefined ||
			!gates.has(loop.gateId) ||
			loop.progressEvidencePolicyId === undefined ||
			!evidencePolicies.has(loop.progressEvidencePolicyId) ||
			loop.exhaustionGateId === undefined ||
			!gates.has(loop.exhaustionGateId)
		)
			fail("recipe_loop_invalid", `loop ${loop.id} must bind a gate, progress evidence, and exhaustion gate.`);
		const loopGate = loop.gateId === undefined ? undefined : gates.get(loop.gateId);
		if (loopGate?.kind !== "overfitting_review" && loopGate?.kind !== "edge_test")
			fail("recipe_loop_invalid", `loop ${loop.id} is guarded by a non-repeatable gate.`);
		const backEdgeExists = proposal.edges.some(
			(edge) =>
				edge.kind === "back" && edge.from === loop.from && edge.to === loop.to && edge.gateId === loop.gateId,
		);
		if (!backEdgeExists) fail("recipe_loop_invalid", `loop ${loop.id} has no matching guarded back-edge.`);
	}
	for (const edge of proposal.edges.filter((candidate) => candidate.kind === "back")) {
		if (edge.gateId === undefined || !gates.has(edge.gateId))
			fail("recipe_loop_invalid", `back-edge ${edge.id} must be guarded by a declared gate.`);
		const edgeGate = gates.get(edge.gateId);
		if (edgeGate?.kind !== "overfitting_review" && edgeGate?.kind !== "edge_test")
			fail("recipe_loop_invalid", `back-edge ${edge.id} is guarded by a non-repeatable gate.`);
		if (
			!(proposal.loops ?? []).some(
				(loop) => loop.from === edge.from && loop.to === edge.to && loop.gateId === edge.gateId,
			)
		)
			fail("recipe_loop_invalid", `back-edge ${edge.id} has no finite loop declaration.`);
	}
}

function buildSidecar(
	graph: WorkflowTaskGraph,
	stages: ReadonlyMap<string, StageSpec>,
	pathBoundary: WorkflowRecipePathBoundaryBinding,
): WorkflowRecipeTaskSidecar {
	const entries = graph.tasks.map((task) => {
		const stage = [...stages.values()].find((candidate) => candidate.taskId === task.taskId);
		if (stage === undefined) fail("task_binding_mismatch", `task ${task.taskId} has no sidecar stage.`);
		return {
			taskId: task.taskId,
			taskDigest: digestObject(task),
			generatedOutputPaths: cloneStrings(stage.generatedOutputPaths),
			lockPaths: cloneStrings(stage.lockPaths),
		};
	});
	const sortedEntries = Object.freeze(
		entries.sort((left, right) => compareCodePointStrings(left.taskId, right.taskId)),
	);
	const sidecarWithoutDigest = {
		baseTaskGraphDigest: graph.graphDigest,
		entries: sortedEntries,
		pathBoundary,
	};
	return freezeDeep({ ...sidecarWithoutDigest, sidecarDigest: digestObject(sidecarWithoutDigest) });
}

function buildAdmissionTaskBindings(
	graph: WorkflowTaskGraph,
	stages: ReadonlyMap<string, StageSpec>,
	gates: ReadonlyMap<string, GateSpec>,
): readonly WorkflowRecipeAdmissionTaskBinding[] {
	const globalGateIds = new Set([WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID, WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID]);
	const bindings = graph.tasks.map((task) => {
		const stage = [...stages.values()].find((candidate) => candidate.taskId === task.taskId);
		if (stage === undefined) fail("task_binding_mismatch", `task ${task.taskId} has no admission stage.`);
		const gateIds = [...gates.values()]
			.filter((gate) => globalGateIds.has(gate.id) || (gate.stageIds ?? []).includes(stage.id))
			.map((gate) => gate.id)
			.sort(compareCodePointStrings);
		return {
			taskId: task.taskId,
			taskDigest: digestObject(task),
			stageId: stage.id,
			stageDigest: digestObject(stage),
			role: stage.role,
			requiredSkillSnapshotDigests: cloneStrings(task.requiredSkillSnapshotDigests),
			gateIds: Object.freeze(gateIds),
			ownedPaths: cloneStrings(task.ownedPaths),
			generatedOutputPaths: cloneStrings(stage.generatedOutputPaths),
			lockPaths: cloneStrings(stage.lockPaths),
		};
	});
	return freezeDeep(
		Object.freeze(bindings.sort((left, right) => compareCodePointStrings(left.taskId, right.taskId))),
	) as readonly WorkflowRecipeAdmissionTaskBinding[];
}

/**
 * Compile a proposal against the existing validated task graph.
 *
 * Args:
 * input: Proposal, frozen tasks, graph context, and optional host registry.
 * Return: Immutable proposal, existing tasks, and task-keyed sidecar binding.
 */
function compileWorkflowRecipeInternal(
	input: WorkflowRecipeCompileInput,
	enforceRegistration: boolean,
): CompiledWorkflowRecipe {
	const proposal = normalizeProposal(input.proposal);
	const registry = normalizeRegistry(input.registry);
	const { host, superpowersSkillSnapshots, superpowersCatalogReceipt } = resolveHostPort(input, proposal, registry);
	const pathBoundary = normalizePathBoundary(host.pathBoundary);
	if (
		digestObject(pathBoundary.workspacePaths) !==
			digestObject(normalizeRoots(input.graphContext.workspacePaths, "workflow workspace roots")) ||
		digestObject(pathBoundary.generatedOutputPaths) !==
			digestObject(normalizeRoots(input.graphContext.generatedOutputPaths, "workflow generated-output roots"))
	)
		fail("compiled_graph_mismatch", "host path boundary does not bind the concrete task graph roots.");
	let graph: WorkflowTaskGraph;
	try {
		assertNoHiddenMembers(input.tasks, "workflow task graph");
		graph = validateWorkflowTaskGraph(input.tasks, input.graphContext);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "task graph validation failed";
		fail("task_graph_invalid", message);
	}
	const declaredGraphDigest = proposal.taskGraphDigest ?? proposal.graphDigest;
	if (declaredGraphDigest !== undefined && declaredGraphDigest !== graph.graphDigest)
		fail("compiled_graph_mismatch", "recipe task graph digest does not match the validated graph.");
	const capabilities = validateCapabilities(proposal, registry);
	const nativeCapabilitySnapshots = resolveNativeCapabilitySnapshots(proposal, host);
	const capabilitySnapshotDigests = nativeCapabilitySnapshots
		.map((snapshot) => snapshot.snapshotDigest)
		.sort(compareCodePointStrings);
	const evidencePolicies = validateEvidencePolicies(proposal);
	const gates = validateGates(proposal, registry);
	const stageIds = new Set(proposal.stages.map((stage) => stage.id));
	const stages = validateStages(proposal, graph, capabilities, evidencePolicies, input.graphContext, registry);
	for (const gate of proposal.gates) {
		if (gate.evidencePolicyId === undefined || !evidencePolicies.has(gate.evidencePolicyId))
			fail("missing_evidence", `gate ${gate.id} references missing evidence.`);
		for (const stageId of gate.stageIds ?? [])
			if (!stageIds.has(stageId)) fail("recipe_invalid", `gate ${gate.id} references an unknown stage.`);
	}
	validateOverlays(proposal, stageIds, gates, evidencePolicies, registry);
	validateIntentTddProposal(proposal, evidencePolicies, gates, graph);
	const forwardEdges = validateEdges(proposal, stages, gates, graph);
	validateFanOuts(proposal, stages, forwardEdges, graph);
	validateLoops(proposal, stages, gates, evidencePolicies);
	const opaqueHoldout = resolveHostOpaqueHoldout(proposal, host, registry);
	const universalGate = resolveUniversalGateBinding(proposal, host, registry);
	const overfittingGate = resolveOverfittingGateContract(proposal, opaqueHoldout, host, registry);
	const intentTddGate = resolveIntentTddGateBinding(proposal, host, registry);
	const tddEvidence = validateIntentTddEvidence(proposal, graph, host, input.evidence);
	const evidenceBindings =
		proposal.recipeId === WORKFLOW_RECIPE_IMPLEMENTATION_RECIPE_ID
			? Object.freeze(
					WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.map((stageId) => {
						const binding = input.evidence?.find((candidate) => candidate.stageId === stageId);
						if (binding === undefined)
							fail("intent_tdd_gate_invalid", `TDD evidence is missing stage ${stageId}.`);
						return binding;
					}),
				)
			: Object.freeze([] as WorkflowRecipeEvidenceBinding[]);
	const sidecar = buildSidecar(graph, stages, pathBoundary);
	const taskBindings = buildAdmissionTaskBindings(graph, stages, gates);
	const effectiveGraphDigest = digestObject({
		graphDigest: graph.graphDigest,
		graphContext: {
			workspacePaths: input.graphContext.workspacePaths,
			generatedOutputPaths: input.graphContext.generatedOutputPaths,
			allowedAuthority: input.graphContext.allowedAuthority,
			knownSkillSnapshotDigests: input.graphContext.knownSkillSnapshotDigests,
			namedContracts: input.graphContext.namedContracts,
		},
		sidecar: {
			baseTaskGraphDigest: sidecar.baseTaskGraphDigest,
			entries: sidecar.entries,
			pathBoundary: sidecar.pathBoundary,
		},
	});
	// A supplied digest must still agree (checked immediately below). Requiring one to be
	// supplied added no guarantee: the host computes it here from the graph, context and sidecar,
	// so a producer could only restate that computation. Demanding it made every dynamic task
	// graph uncompilable, since the dynamic producer has no access to the sidecar.
	if (proposal.effectiveGraphDigest !== undefined && proposal.effectiveGraphDigest !== effectiveGraphDigest)
		fail("compiled_graph_mismatch", "recipe effective graph digest does not match the validated sidecar.");
	const canonicalProposal = freezeDeep(
		stripUndefined({
			...proposal,
			taskGraphDigest: graph.graphDigest,
			graphDigest: graph.graphDigest,
			effectiveGraphDigest,
		}),
	) as WorkflowRecipeProposal;
	const catalogBinding = normalizeCatalogBinding(input.catalogBinding, proposal);
	if (proposal.recipeId.startsWith("superpowers:")) {
		if (catalogBinding === undefined || superpowersCatalogReceipt === undefined)
			fail("catalog_source_invalid", "Superpowers recipes require a host-verified catalog binding and receipt.");
		if (
			catalogBinding.snapshotDigest !== superpowersCatalogReceipt.snapshotDigest ||
			catalogBinding.provenanceDigest !== superpowersCatalogReceipt.provenanceDigest ||
			catalogBinding.verificationReceiptDigest !== superpowersCatalogReceipt.verificationReceiptDigest ||
			catalogBinding.recipeCatalogDigest !== superpowersCatalogReceipt.recipeCatalogDigest ||
			digestObject(catalogBinding.skillSnapshotDigests) !==
				digestObject(superpowersCatalogReceipt.skillSnapshotDigests)
		)
			fail("catalog_source_invalid", "recipe catalog binding does not match the host-issued catalog receipt.");
	}
	const registeredManifest =
		input.registeredManifest === undefined ? undefined : normalizeRegisteredManifest(input.registeredManifest);
	let verifiedRegistrationReceipt: WorkflowRecipeVerifiedHostReceipt<WorkflowRecipeRegisteredManifest> | undefined;
	let verifiedRegistrationReceiptProof: WorkflowRecipeAdmissionHostRegistrationProof | undefined;
	const snapshotReceiptDigests = hostSnapshotReceiptDigests(host, superpowersSkillSnapshots.length > 0);
	const hostReceiptDigests = Object.freeze(
		[
			host.opaqueHoldoutReceipt.receipt.verificationDigest,
			host.universalGateReceipt.receipt.verificationDigest,
			host.overfittingGateReceipt.receipt.verificationDigest,
			host.intentTddGateReceipt?.receipt.verificationDigest,
			host.superpowersCatalogReceipt?.receipt.verificationDigest,
		]
			.filter((digest): digest is string => typeof digest === "string" && digest.length > 0)
			.sort(compareCodePointStrings),
	);
	const graphContextDigest = digestObject({
		workspacePaths: input.graphContext.workspacePaths,
		generatedOutputPaths: input.graphContext.generatedOutputPaths,
		allowedAuthority: input.graphContext.allowedAuthority,
		knownSkillSnapshotDigests: input.graphContext.knownSkillSnapshotDigests,
		namedContracts: input.graphContext.namedContracts,
	});
	const recipeDigestValue = {
		schemaVersion: WORKFLOW_RECIPE_SCHEMA_VERSION,
		workflowId: host.context.workflowId,
		recipeId: proposal.recipeId,
		revision: proposal.revision,
		registryManifestDigest: registry.manifestDigest,
		proposal: canonicalProposal,
		effectiveGraphDigest,
		baseTaskGraphDigest: sidecar.baseTaskGraphDigest,
		sidecarDigest: sidecar.sidecarDigest,
		graphContextDigest,
		opaqueHoldout,
		universalGate,
		overfittingGate,
		capabilitySnapshotDigests,
		nativeCapabilitySnapshots,
		superpowersSkillSnapshots,
		taskBindings,
		...(intentTddGate === undefined ? {} : { intentTddGate }),
		...(catalogBinding === undefined ? {} : { catalogBinding }),
		evidenceBindings,
		evidenceBindingDigest: tddEvidence.digest,
		evidenceEnvelopeDigests: tddEvidence.envelopeDigests,
		hostReceiptDigests,
		snapshotReceiptDigests,
		hostBinding: {
			contextDigest: host.context.contextDigest,
			headDigest: host.context.headDigest,
			currentDecisionDigest: host.context.currentDecisionDigest,
			epochRef: host.context.epochRef,
			pathBoundary,
			receiptDigests: Object.freeze([...hostReceiptDigests, ...snapshotReceiptDigests]),
		},
	};
	const recipeDigest = digestObject(recipeDigestValue);
	if (enforceRegistration) {
		if (registeredManifest === undefined)
			fail("recipe_registration_required", "recipe compilation requires an immutable host registration manifest.");
		if (host.registeredManifestReceipt === undefined)
			fail("recipe_registration_required", "recipe compilation requires a host-issued registration receipt.");
		if (
			registeredManifest.registryManifestDigest !== registry.manifestDigest ||
			registeredManifest.recipeId !== proposal.recipeId ||
			registeredManifest.revision !== proposal.revision ||
			registeredManifest.recipeDigest !== recipeDigest
		)
			fail("compiled_graph_mismatch", "recipe semantics do not match the registered immutable manifest.");
		const registrationProofOutput: { value?: WorkflowRecipeHostReceiptProof } = {};
		const registrationReceipt = verifyRecipeHostReceipt({
			receipt: host.registeredManifestReceipt,
			kind: "recipe_registration",
			proposal,
			context: host.context,
			expectedAdmissionPreimageDigest: recipeDigest,
			proofOut: registrationProofOutput,
		});
		let receiptManifest: WorkflowRecipeRegisteredManifest;
		try {
			receiptManifest = normalizeRegisteredManifest(registrationReceipt);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "host registration receipt payload is invalid";
			fail("recipe_registration_required", message);
		}
		if (digestObject(receiptManifest) !== digestObject(registeredManifest))
			fail("compiled_graph_mismatch", "host registration receipt does not bind the registered manifest.");
		verifiedRegistrationReceipt = host.registeredManifestReceipt;
		const verifiedProof = registrationProofOutput.value;
		const admissionPreimageDigest = verifiedProof?.admissionPreimageDigest;
		const signedReceiptPreimageDigestValue = verifiedProof?.signedReceiptPreimageDigest;
		if (
			verifiedProof === undefined ||
			admissionPreimageDigest !== recipeDigest ||
			signedReceiptPreimageDigestValue !== signedReceiptPreimageDigest(host.registeredManifestReceipt.receipt)
		)
			fail("recipe_registration_required", "host registration receipt did not return a durable authority proof.");
		if (admissionPreimageDigest === undefined || signedReceiptPreimageDigestValue === undefined)
			fail("recipe_registration_required", "host registration receipt omitted its authenticated preimage proof.");
		verifiedRegistrationReceiptProof = Object.freeze({
			...verifiedProof,
			admissionPreimageDigest,
			signedReceiptPreimageDigest: signedReceiptPreimageDigestValue,
		});
	}
	const admissionWithoutDigest = {
		kind: "workflow_recipe_admission" as const,
		workflowId: host.context.workflowId,
		recipeId: proposal.recipeId,
		revision: proposal.revision,
		recipeDigest,
		effectiveGraphDigest,
		baseTaskGraphDigest: sidecar.baseTaskGraphDigest,
		sidecarDigest: sidecar.sidecarDigest,
		registryManifestDigest: registry.manifestDigest,
		capabilitySnapshotDigests,
		skillSnapshotDigests: Object.freeze(
			superpowersSkillSnapshots.map((snapshot) => snapshot.snapshotDigest).sort(compareCodePointStrings),
		),
		nativeCapabilitySnapshots,
		superpowersSkillSnapshots,
		taskBindings,
		...(intentTddGate === undefined ? {} : { intentTddGate }),
		pathBoundary,
		...(catalogBinding === undefined ? {} : { catalogBindingDigest: digestObject(catalogBinding) }),
		registrationReceiptDigest:
			host.registeredManifestReceipt === undefined ? "" : host.registeredManifestReceipt.receipt.verificationDigest,
		hostReceiptDigests,
		snapshotReceiptDigests,
		hostHeadDigest: host.context.headDigest,
		hostDecisionDigest: host.context.currentDecisionDigest,
		hostEpochRef: host.context.epochRef,
		hostContextDigest: host.context.contextDigest,
		evidenceBindings,
		evidenceBindingDigest: tddEvidence.digest,
		evidenceEnvelopeDigests: tddEvidence.envelopeDigests,
		graphContextDigest,
		recipeBinding: recipeDigestValue,
		...(verifiedRegistrationReceipt === undefined ? {} : { registrationReceipt: verifiedRegistrationReceipt }),
		...(verifiedRegistrationReceiptProof === undefined
			? {}
			: { registrationReceiptProof: verifiedRegistrationReceiptProof }),
	};
	const admission: WorkflowRecipeAdmissionArtifact = freezeDeep({
		...admissionWithoutDigest,
		admissionDigest: digestObject(admissionWithoutDigest),
	});
	return freezeDeep({
		kind: "compiled",
		recipe: canonicalProposal,
		recipeDigest,
		graph,
		tasks: graph.tasks,
		sidecar,
		effectiveGraphDigest,
		registryManifestDigest: registry.manifestDigest,
		opaqueHoldout,
		universalGate,
		overfittingGate,
		capabilitySnapshotDigests,
		nativeCapabilitySnapshots,
		superpowersSkillSnapshots,
		...(intentTddGate === undefined ? {} : { intentTddGate }),
		admission,
	});
}

/**
 * Compile a recipe only after its host registration manifest has been bound.
 *
 * Args:
 * input: Proposal, host receipts, and the exact registered manifest.
 * Return: Immutable compiled recipe and production admission artifact.
 */
export function compileWorkflowRecipe(input: WorkflowRecipeCompileInput): CompiledWorkflowRecipe {
	return compileWorkflowRecipeInternal(input, true);
}

/**
 * Construct the immutable manifest a fixed host authority must register before admission.
 *
 * Args:
 * input: Proposal, graph, host receipts, and optional Superpowers catalog binding.
 * Return: Exact recipe registration manifest for subsequent compilation.
 */
export function createWorkflowRecipeRegisteredManifest(
	input: WorkflowRecipeCompileInput,
): WorkflowRecipeRegisteredManifest {
	const compiled = compileWorkflowRecipeInternal(input, false);
	return Object.freeze({
		recipeId: compiled.recipe.recipeId,
		revision: compiled.recipe.revision,
		recipeDigest: compiled.recipeDigest,
		registryManifestDigest: compiled.registryManifestDigest,
		immutable: true,
	});
}

/**
 * Validate an immutable compiled admission before handing it to a consumer.
 *
 * Args:
 * admission: Compiled recipe admission artifact.
 * consumer: Host-owned consumer that verifies and records admission.
 * Return: Nothing. The consumer receives the exact immutable artifact.
 */
export function validateWorkflowRecipeAdmission(admission: WorkflowRecipeAdmissionArtifact): void {
	if (!isDeepFrozen(admission)) fail("recipe_invalid", "recipe admission must be deeply immutable.");
	assertNoHiddenMembers(admission, "recipe admission");
	const record = assertClosedRecord(admission, "recipe admission", [
		"kind",
		"admissionDigest",
		"workflowId",
		"recipeId",
		"revision",
		"recipeDigest",
		"effectiveGraphDigest",
		"baseTaskGraphDigest",
		"sidecarDigest",
		"registryManifestDigest",
		"capabilitySnapshotDigests",
		"skillSnapshotDigests",
		"nativeCapabilitySnapshots",
		"superpowersSkillSnapshots",
		"taskBindings",
		"evidenceBindings",
		"intentTddGate",
		"pathBoundary",
		"catalogBindingDigest",
		"registrationReceiptDigest",
		"hostReceiptDigests",
		"snapshotReceiptDigests",
		"hostHeadDigest",
		"hostDecisionDigest",
		"hostEpochRef",
		"hostContextDigest",
		"evidenceBindingDigest",
		"evidenceEnvelopeDigests",
		"graphContextDigest",
		"recipeBinding",
		"registrationReceipt",
		"registrationReceiptProof",
	]);
	if (record.kind !== "workflow_recipe_admission") fail("recipe_invalid", "recipe admission kind is invalid.");
	const recipeBinding = assertClosedRecord(record.recipeBinding, "recipe admission signed recipe binding", [
		"schemaVersion",
		"workflowId",
		"recipeId",
		"revision",
		"registryManifestDigest",
		"proposal",
		"effectiveGraphDigest",
		"baseTaskGraphDigest",
		"sidecarDigest",
		"graphContextDigest",
		"opaqueHoldout",
		"universalGate",
		"overfittingGate",
		"capabilitySnapshotDigests",
		"nativeCapabilitySnapshots",
		"superpowersSkillSnapshots",
		"taskBindings",
		"evidenceBindings",
		"intentTddGate",
		"catalogBinding",
		"evidenceBindingDigest",
		"evidenceEnvelopeDigests",
		"hostReceiptDigests",
		"snapshotReceiptDigests",
		"hostBinding",
	]);
	if (digestObject(recipeBinding) !== record.recipeDigest)
		fail(
			"compiled_graph_mismatch",
			"recipe admission signed recipe binding does not match the registered recipe digest.",
		);
	const signedRecipeBinding = recipeBinding as unknown as WorkflowRecipeAdmissionRecipeBinding;
	for (const [field, value] of [
		["admissionDigest", record.admissionDigest],
		["workflowId", record.workflowId],
		["recipeId", record.recipeId],
		["recipeDigest", record.recipeDigest],
		["effectiveGraphDigest", record.effectiveGraphDigest],
		["baseTaskGraphDigest", record.baseTaskGraphDigest],
		["sidecarDigest", record.sidecarDigest],
		["registryManifestDigest", record.registryManifestDigest],
		["registrationReceiptDigest", record.registrationReceiptDigest],
		["hostHeadDigest", record.hostHeadDigest],
		["hostDecisionDigest", record.hostDecisionDigest],
		["hostContextDigest", record.hostContextDigest],
		["evidenceBindingDigest", record.evidenceBindingDigest],
		["graphContextDigest", record.graphContextDigest],
	] as const)
		nonEmptyString(value, `recipe admission.${field}`);
	if (record.registrationReceipt === undefined || record.registrationReceiptProof === undefined) {
		if (
			record.registrationReceiptDigest !== "" ||
			record.registrationReceipt !== undefined ||
			record.registrationReceiptProof !== undefined
		)
			fail("recipe_registration_required", "recipe admission is missing its signed registration artifact.");
	} else {
		const registration = assertClosedRecord(record.registrationReceipt, "recipe admission registration receipt", [
			"receipt",
			"payload",
			"consumptionWitness",
		]);
		const registrationReceipt = assertClosedRecord(
			registration.receipt,
			"recipe admission registration host receipt",
			[
				"receiptKind",
				"oneUse",
				"receiptId",
				"issuerId",
				"workflowId",
				"bindingDigest",
				"payloadDigest",
				"artifactRef",
				"issuedAt",
				"validUntil",
				"keyId",
				"signatureAlgorithm",
				"artifactBytesDigest",
				"stateDigest",
				"revision",
				"signature",
				"verificationDigest",
			],
		);
		const normalizedRegistrationReceipt = registrationReceipt as unknown as WorkflowVerifiedHostReceipt;
		const registrationPayload = assertClosedRecord(registration.payload, "recipe admission registration payload", [
			"recipeId",
			"revision",
			"recipeDigest",
			"registryManifestDigest",
			"immutable",
		]);
		assertClosedRecord(registration.consumptionWitness, "recipe admission registration witness", [
			"receiptId",
			"workflowId",
			"bindingDigest",
			"capability",
			"resourceDigest",
			"operationDigest",
			"receiptDigest",
			"headDigest",
			"consumedAt",
			"consumptionSequence",
		]);
		const registrationProofRecord = assertClosedRecord(
			record.registrationReceiptProof,
			"recipe admission registration proof",
			[
				"proofKind",
				"authorityId",
				"receiptDigest",
				"witnessDigest",
				"workflowId",
				"hostKeyId",
				"bindingDigest",
				"currentHeadDigest",
				"currentDecisionDigest",
				"currentEpochRef",
				"consumptionSequence",
				"signatureVerified",
				"signatureDigest",
				"artifactBytesDigest",
				"artifactSizeBytes",
				"artifactImmutable",
				"oneUseConsumed",
				"admissionPreimageDigest",
				"signedReceiptPreimageDigest",
			],
		);
		const registrationProof = registrationProofRecord as unknown as WorkflowRecipeHostReceiptProof;
		const expectedRegistrationBindingDigest = digestObject({
			kind: "workflow-recipe-receipt-binding",
			receiptKind: "recipe_registration",
			workflowId: record.workflowId,
			recipeId: record.recipeId,
			revision: record.revision,
			registryManifestDigest: record.registryManifestDigest,
			hostKeyId: registrationReceipt.keyId,
			epochRef: record.hostEpochRef,
			headDigest: record.hostHeadDigest,
			currentDecisionDigest: record.hostDecisionDigest,
			contextDigest: record.hostContextDigest,
			payloadDigest: registrationReceipt.payloadDigest,
		});
		if (
			registrationReceipt.verificationDigest !== digestObject({ ...registrationReceipt, verificationDigest: "" }) ||
			registrationReceipt.verificationDigest !== record.registrationReceiptDigest ||
			registrationReceipt.workflowId !== record.workflowId ||
			registrationReceipt.stateDigest !== record.hostHeadDigest ||
			registrationReceipt.revision !== record.revision ||
			registrationReceipt.payloadDigest !== digestObject(registration.payload) ||
			registrationPayload.recipeId !== record.recipeId ||
			registrationPayload.revision !== record.revision ||
			registrationPayload.recipeDigest !== record.recipeDigest ||
			registrationPayload.registryManifestDigest !== record.registryManifestDigest ||
			registrationPayload.immutable !== true ||
			(registration.consumptionWitness as Record<string, unknown>).receiptId !== registrationReceipt.receiptId ||
			(registration.consumptionWitness as Record<string, unknown>).workflowId !== record.workflowId ||
			(registration.consumptionWitness as Record<string, unknown>).bindingDigest !==
				registrationReceipt.bindingDigest ||
			(registration.consumptionWitness as Record<string, unknown>).headDigest !== record.hostHeadDigest ||
			registrationProof.proofKind !== "ed25519-one-use" ||
			registrationProof.authorityId !== WORKFLOW_RECIPE_HOST_AUTHORITY_ID ||
			registrationProof.receiptDigest !== digestObject(registrationReceipt) ||
			registrationProof.witnessDigest !== digestObject(registration.consumptionWitness) ||
			registrationProof.workflowId !== record.workflowId ||
			registrationProof.hostKeyId !== registrationReceipt.keyId ||
			registrationProof.bindingDigest !== registrationReceipt.bindingDigest ||
			registrationReceipt.bindingDigest !== expectedRegistrationBindingDigest ||
			registrationProof.currentHeadDigest !== record.hostHeadDigest ||
			registrationProof.currentDecisionDigest !== record.hostDecisionDigest ||
			digestObject(registrationProof.currentEpochRef) !== digestObject(record.hostEpochRef) ||
			registrationProof.consumptionSequence !==
				(registration.consumptionWitness as Record<string, unknown>).consumptionSequence ||
			registrationProof.signatureVerified !== true ||
			registrationProof.signatureDigest !== sha256Hex(normalizedRegistrationReceipt.signature) ||
			registrationProof.admissionPreimageDigest !== record.recipeDigest ||
			registrationProof.signedReceiptPreimageDigest !== signedReceiptPreimageDigest(normalizedRegistrationReceipt) ||
			registrationProof.artifactBytesDigest !== normalizedRegistrationReceipt.artifactRef.digest ||
			registrationProof.artifactSizeBytes !== normalizedRegistrationReceipt.artifactRef.sizeBytes ||
			registrationProof.artifactImmutable !== true ||
			registrationProof.oneUseConsumed !== true
		)
			fail(
				"recipe_registration_required",
				"recipe admission registration artifact is not bound to its signed recipe.",
			);
	}
	if (record.registryManifestDigest !== WORKFLOW_RECIPE_REGISTRY_MANIFEST_DIGEST)
		fail("registry_invalid", "recipe admission is bound to a foreign registry manifest.");
	positiveInteger(record.revision, "recipe admission.revision");
	if (
		!Array.isArray(record.capabilitySnapshotDigests) ||
		!Array.isArray(record.skillSnapshotDigests) ||
		!Array.isArray(record.nativeCapabilitySnapshots)
	)
		fail("recipe_invalid", "recipe admission capability bindings are invalid.");
	if (!Array.isArray(record.superpowersSkillSnapshots))
		fail("recipe_invalid", "recipe admission Superpowers bindings are invalid.");
	if (!Array.isArray(record.taskBindings))
		fail("task_binding_mismatch", "recipe admission task bindings are invalid.");
	if (!Array.isArray(record.evidenceBindings))
		fail("intent_tdd_gate_invalid", "recipe admission evidence bindings are invalid.");
	const signedBinding = signedRecipeBinding as unknown as Record<string, unknown>;
	if (
		signedBinding.workflowId !== record.workflowId ||
		signedBinding.recipeId !== record.recipeId ||
		signedBinding.revision !== record.revision ||
		signedBinding.registryManifestDigest !== record.registryManifestDigest ||
		signedBinding.effectiveGraphDigest !== record.effectiveGraphDigest ||
		signedBinding.baseTaskGraphDigest !== record.baseTaskGraphDigest ||
		signedBinding.sidecarDigest !== record.sidecarDigest ||
		signedBinding.graphContextDigest !== record.graphContextDigest ||
		digestObject(signedBinding.capabilitySnapshotDigests) !== digestObject(record.capabilitySnapshotDigests) ||
		digestObject(signedBinding.nativeCapabilitySnapshots) !== digestObject(record.nativeCapabilitySnapshots) ||
		digestObject(signedBinding.superpowersSkillSnapshots) !== digestObject(record.superpowersSkillSnapshots) ||
		digestObject(signedBinding.taskBindings) !== digestObject(record.taskBindings) ||
		digestObject(signedBinding.evidenceBindings) !== digestObject(record.evidenceBindings) ||
		digestObject(signedBinding.intentTddGate ?? null) !== digestObject(record.intentTddGate ?? null) ||
		(record.catalogBindingDigest === undefined
			? signedRecipeBinding.catalogBinding !== undefined
			: signedRecipeBinding.catalogBinding === undefined ||
				record.catalogBindingDigest !== digestObject(signedRecipeBinding.catalogBinding)) ||
		digestObject(signedBinding.evidenceEnvelopeDigests) !== digestObject(record.evidenceEnvelopeDigests) ||
		signedBinding.evidenceBindingDigest !== record.evidenceBindingDigest ||
		digestObject(signedBinding.hostReceiptDigests) !== digestObject(record.hostReceiptDigests) ||
		digestObject(signedBinding.snapshotReceiptDigests) !== digestObject(record.snapshotReceiptDigests) ||
		digestObject(signedBinding.hostBinding) !==
			digestObject({
				contextDigest: record.hostContextDigest,
				headDigest: record.hostHeadDigest,
				currentDecisionDigest: record.hostDecisionDigest,
				epochRef: record.hostEpochRef,
				pathBoundary: record.pathBoundary,
				receiptDigests: [...((signedBinding.hostBinding as Record<string, unknown>).receiptDigests as string[])],
			})
	)
		fail("compiled_graph_mismatch", "recipe admission digest fields do not match the signed recipe binding.");
	if (record.recipeId === WORKFLOW_RECIPE_IMPLEMENTATION_RECIPE_ID) {
		const intentTddGate = assertClosedRecord(record.intentTddGate, "recipe admission intent TDD gate", [
			"gateId",
			"stageIds",
			"evidenceKinds",
			"blocking",
			"hostOwned",
			"evidenceRequirements",
			"promotionConstraints",
		]);
		if (
			intentTddGate.gateId !== WORKFLOW_RECIPE_INTENT_TDD_GATE_ID ||
			intentTddGate.blocking !== true ||
			intentTddGate.hostOwned !== true ||
			digestObject(intentTddGate.stageIds) !== digestObject(WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS) ||
			digestObject(intentTddGate.evidenceKinds) !== digestObject(WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_KINDS) ||
			digestObject(intentTddGate.evidenceRequirements) !==
				digestObject(WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_REQUIREMENTS) ||
			digestObject(intentTddGate.promotionConstraints) !==
				digestObject(WORKFLOW_RECIPE_INTENT_TDD_PROMOTION_CONSTRAINTS)
		)
			fail("task_binding_mismatch", "recipe admission intent-TDD gate fields are not canonical.");
	}
	const signedOverfittingGate = assertClosedRecord(
		signedRecipeBinding.overfittingGate,
		"recipe admission overfitting gate",
		[
			"gateId",
			"blocking",
			"freshnessDigest",
			"reviewerResultDigest",
			"authenticatedReviewer",
			"opaqueHoldoutManifestDigest",
			"opaqueHoldoutEvidenceDigest",
			"hostReceiptDigest",
		],
	);
	if (
		signedOverfittingGate.gateId !== WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID ||
		signedOverfittingGate.blocking !== true ||
		signedOverfittingGate.authenticatedReviewer !== true ||
		Object.values(signedOverfittingGate).some((value) => typeof value !== "string" && value !== true)
	)
		fail("task_binding_mismatch", "recipe admission overfitting gate is not a host-blocking contract.");
	if (
		record.recipeId !== WORKFLOW_RECIPE_IMPLEMENTATION_RECIPE_ID &&
		(record.evidenceBindingDigest !== digestObject([]) ||
			!Array.isArray(record.evidenceEnvelopeDigests) ||
			record.evidenceEnvelopeDigests.length !== 0)
	)
		fail("task_binding_mismatch", "non-implementation recipe admission contains forged intent evidence.");
	validateAdmissionSnapshotArtifacts(record.nativeCapabilitySnapshots, "recipe admission native snapshots", "native");
	validateAdmissionSnapshotArtifacts(
		record.superpowersSkillSnapshots,
		"recipe admission Superpowers snapshots",
		"superpowers",
	);
	if (
		!Array.isArray(record.hostReceiptDigests) ||
		!Array.isArray(record.snapshotReceiptDigests) ||
		!Array.isArray(record.evidenceEnvelopeDigests) ||
		!record.hostReceiptDigests.every((digest) => typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest)) ||
		!record.snapshotReceiptDigests.every((digest) => typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest)) ||
		!record.evidenceEnvelopeDigests.every((digest) => typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest))
	)
		fail("recipe_invalid", "recipe admission host receipt bindings are invalid.");
	const hostEpochRef = isRecord(record.hostEpochRef) ? record.hostEpochRef : undefined;
	const hostStoreEpoch = hostEpochRef?.storeEpoch;
	const hostCoordinatorEpoch = hostEpochRef?.coordinatorEpoch;
	if (
		hostEpochRef === undefined ||
		!Number.isSafeInteger(hostStoreEpoch) ||
		(hostStoreEpoch as number) < 1 ||
		!Number.isSafeInteger(hostCoordinatorEpoch) ||
		(hostCoordinatorEpoch as number) < 1
	)
		fail("recipe_invalid", "recipe admission host epoch is invalid.");
	const capabilitySnapshotDigests = canonicalSortedStrings(
		record.capabilitySnapshotDigests,
		"recipe admission capabilitySnapshotDigests",
	);
	const nativeSnapshotDigests = canonicalSortedStrings(
		(record.nativeCapabilitySnapshots as Array<Record<string, unknown>>)
			.map((snapshot, index) =>
				nonEmptyString(snapshot.snapshotDigest, `recipe admission native snapshot ${index}.snapshotDigest`),
			)
			.sort(compareCodePointStrings),
		"recipe admission native snapshot digests",
	);
	const skillSnapshotDigests = canonicalSortedStrings(
		record.skillSnapshotDigests,
		"recipe admission skillSnapshotDigests",
	);
	const superpowersSnapshotDigests = canonicalSortedStrings(
		(record.superpowersSkillSnapshots as Array<Record<string, unknown>>)
			.map((snapshot, index) =>
				nonEmptyString(snapshot.snapshotDigest, `recipe admission Superpowers snapshot ${index}.snapshotDigest`),
			)
			.sort(compareCodePointStrings),
		"recipe admission Superpowers snapshot digests",
	);
	const snapshotReceiptDigests = canonicalSortedStrings(
		record.snapshotReceiptDigests,
		"recipe admission snapshotReceiptDigests",
	);
	canonicalSortedStrings(record.hostReceiptDigests, "recipe admission hostReceiptDigests");
	if (
		digestObject(capabilitySnapshotDigests) !== digestObject(nativeSnapshotDigests) ||
		digestObject(skillSnapshotDigests) !== digestObject(superpowersSnapshotDigests) ||
		snapshotReceiptDigests.length !== nativeSnapshotDigests.length + superpowersSnapshotDigests.length
	)
		fail("compiled_graph_mismatch", "recipe admission snapshot receipt digests do not match their records.");
	const pathBoundary = normalizePathBoundary(record.pathBoundary);
	const taskIds = new Set<string>();
	for (const [index, value] of (record.taskBindings as unknown[]).entries()) {
		const binding = assertClosedRecord(value, `recipe admission task binding ${index}`, [
			"taskId",
			"taskDigest",
			"stageId",
			"stageDigest",
			"role",
			"requiredSkillSnapshotDigests",
			"gateIds",
			"ownedPaths",
			"generatedOutputPaths",
			"lockPaths",
		]);
		const taskId = nonEmptyString(
			binding.taskId,
			`recipe admission task binding ${index}.taskId`,
			"task_binding_mismatch",
		);
		if (taskIds.has(taskId)) fail("task_binding_mismatch", "recipe admission task bindings contain duplicates.");
		taskIds.add(taskId);
		for (const [field, value] of [
			["taskDigest", binding.taskDigest],
			["stageDigest", binding.stageDigest],
		] as const) {
			const digest = nonEmptyString(
				value,
				`recipe admission task binding ${index}.${field}`,
				"task_binding_mismatch",
			);
			if (!/^[0-9a-f]{64}$/u.test(digest)) fail("task_binding_mismatch", `recipe admission ${field} is invalid.`);
		}
		nonEmptyString(binding.stageId, `recipe admission task binding ${index}.stageId`, "task_binding_mismatch");
		nonEmptyString(binding.role, `recipe admission task binding ${index}.role`, "task_binding_mismatch");
		canonicalSortedStrings(binding.requiredSkillSnapshotDigests, `recipe admission task binding ${index}.skills`);
		const gateIds = canonicalSortedStrings(binding.gateIds, `recipe admission task binding ${index}.gates`);
		if (gateIds.some((gateId) => !DEFAULT_WORKFLOW_RECIPE_REGISTRY.gates.includes(gateId)))
			fail("task_binding_mismatch", `recipe admission task binding ${index} contains an unknown gate.`);
		const ownedPaths = canonicalSortedStrings(
			binding.ownedPaths,
			`recipe admission task binding ${index}.ownedPaths`,
		);
		const generatedPaths = canonicalSortedStrings(
			binding.generatedOutputPaths,
			`recipe admission task binding ${index}.generatedOutputPaths`,
		);
		const lockPaths = canonicalSortedStrings(binding.lockPaths, `recipe admission task binding ${index}.lockPaths`);
		for (const path of ownedPaths)
			normalizePath(path, `recipe admission task binding ${index}.ownedPath`, pathBoundary.workspacePaths);
		for (const path of generatedPaths)
			normalizePath(
				path,
				`recipe admission task binding ${index}.generatedOutputPath`,
				pathBoundary.generatedOutputPaths,
			);
		const lockRoots = Object.freeze([...pathBoundary.workspacePaths, ...pathBoundary.generatedOutputPaths]);
		for (const path of lockPaths) normalizePath(path, `recipe admission task binding ${index}.lockPath`, lockRoots);
		const signedProposal = signedRecipeBinding.proposal;
		const signedStage = signedProposal.stages.find((stage) => stage.id === binding.stageId);
		if (
			signedStage === undefined ||
			signedStage.taskId !== taskId ||
			binding.role !== signedStage.role ||
			binding.stageDigest !== digestObject(signedStage)
		)
			fail("task_binding_mismatch", `recipe admission task binding ${index} is not stage-role bound.`);
		const expectedGateIds = signedProposal.gates
			.filter(
				(gate) =>
					gate.id === WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID ||
					gate.id === WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID ||
					(gate.stageIds ?? []).includes(signedStage.id),
			)
			.map((gate) => gate.id)
			.sort(compareCodePointStrings);
		if (digestObject(gateIds) !== digestObject(expectedGateIds))
			fail("task_binding_mismatch", `recipe admission task binding ${index} has forged topology gates.`);
	}
	if (digestObject([...taskIds]) !== digestObject([...taskIds].sort(compareCodePointStrings)))
		fail("task_binding_mismatch", "recipe admission task bindings are not canonically ordered.");
	const { admissionDigest: _admissionDigest, ...withoutDigest } = record;
	if (record.admissionDigest !== digestObject(withoutDigest))
		fail("compiled_graph_mismatch", "recipe admission digest does not match its immutable contents.");
}

/** Re-resolve and consume the registration receipt at the current host authority. */
export function verifyWorkflowRecipeAdmissionRegistration(input: {
	admission: WorkflowRecipeAdmissionArtifact;
	host: WorkflowRecipeAdmissionHostResolutionPort;
}): void {
	validateWorkflowRecipeAdmission(input.admission);
	if (
		input.admission.workflowId !== input.host.context.workflowId ||
		input.admission.hostHeadDigest !== input.host.context.headDigest ||
		input.admission.hostDecisionDigest !== input.host.context.currentDecisionDigest ||
		digestObject(input.admission.hostEpochRef) !== digestObject(input.host.context.epochRef) ||
		input.admission.hostContextDigest !== input.host.context.contextDigest ||
		input.admission.registryManifestDigest !== input.host.registryManifestDigest
	)
		fail("recipe_registration_required", "recipe admission registration is stale at the current host authority.");
	if (input.admission.registrationReceipt === undefined || input.admission.registrationReceiptProof === undefined)
		fail("recipe_registration_required", "recipe admission has no authenticated registration receipt.");
	const proofOutput: { value?: WorkflowRecipeHostReceiptProof } = {};
	const payload = verifyRecipeHostReceipt({
		receipt: input.admission.registrationReceipt,
		kind: "recipe_registration",
		proposal: input.admission.recipeBinding.proposal,
		context: input.host.context,
		expectedAdmissionPreimageDigest: input.admission.recipeDigest,
		proofOut: proofOutput,
	});
	if (
		digestObject(payload) !== digestObject(input.admission.registrationReceipt.payload) ||
		proofOutput.value?.admissionPreimageDigest !== input.admission.recipeDigest
	)
		fail("recipe_registration_required", "host registration did not re-authorize the exact admission preimage.");
}

async function verifyWorkflowRecipeAdmissionEvidenceAtHost(input: {
	admission: WorkflowRecipeAdmissionArtifact;
	host: WorkflowRecipeAdmissionHostResolutionPort;
}): Promise<void> {
	if (input.admission.recipeId !== WORKFLOW_RECIPE_IMPLEMENTATION_RECIPE_ID) return;
	for (const binding of input.admission.evidenceBindings) {
		const validation = await validateWorkflowEvidenceEnvelope({
			workflowId: input.admission.workflowId,
			evidence: binding.envelope,
			trustedClockReceipt: binding.trustedClockReceipt,
			currentWorkspaceDigest: binding.envelope.workspaceDigest,
			currentConfigDigest: binding.envelope.configDigest,
			currentParserDigest: binding.envelope.parserDigest,
			currentEvaluatorDigest: binding.envelope.evaluatorDigest,
			currentGuardDigest: binding.envelope.guardDigest,
			currentRevisions: binding.envelope.revisions,
			requiredFreshnessMilliseconds: binding.envelope.freshnessWindowMilliseconds,
			artifactResolver: input.host.context.receiptContext.artifactResolver,
			receiptContext: input.host.context.receiptContext,
			currentStateDigest: input.admission.hostHeadDigest,
			currentRevision: input.admission.revision,
		});
		if (!validation.accepted || validation.evidenceDigest !== digestObject(binding.envelope))
			fail(
				"intent_tdd_gate_invalid",
				`host evidence validation rejected the immutable ${binding.stageId} envelope.`,
			);
		if (binding.envelope.command === null) {
			if (binding.processReceipt !== null)
				fail(
					"intent_tdd_gate_invalid",
					`host evidence ${binding.stageId} has a process receipt without a command.`,
				);
		} else {
			const processReceipt = binding.processReceipt;
			if (processReceipt === null)
				fail("intent_tdd_gate_invalid", `host evidence ${binding.stageId} lacks a host process receipt.`);
			const processPayloadDigest = digestObject(processReceipt.payload);
			const expectedProcessBindingDigest = recipeReceiptBindingDigest({
				kind: "process_evidence",
				context: input.host.context,
				recipeId: input.admission.recipeId,
				revision: input.admission.revision,
				payloadDigest: processPayloadDigest,
				metadataDigest: digestObject({
					stageId: binding.stageId,
					commandDigest: digestObject(binding.envelope.command),
				}),
			});
			if (
				processPayloadDigest !== digestObject(binding.envelope.command) ||
				processReceipt.receipt.payloadDigest !== processPayloadDigest ||
				processReceipt.receipt.bindingDigest !== expectedProcessBindingDigest ||
				processReceipt.receipt.oneUse !== true
			)
				fail("intent_tdd_gate_invalid", `host process receipt ${binding.stageId} is not bound to its command.`);
			const resolvedProcessReceipt = await resolveAndVerifyWorkflowHostReceipt({
				context: input.host.context.receiptContext,
				workflowId: input.admission.workflowId,
				expectedBindingDigest: expectedProcessBindingDigest,
				receipt: processReceipt.receipt,
				currentStateDigest: input.admission.hostHeadDigest,
				currentRevision: input.admission.revision,
				trustedNow: input.host.context.issuedAt,
			});
			const processWitness = await input.host.context.receiptContext.receiptResolver.resolveConsumptionWitness({
				receiptId: resolvedProcessReceipt.receiptId,
				workflowId: input.admission.workflowId,
				expectedBindingDigest: expectedProcessBindingDigest,
			});
			if (
				resolvedProcessReceipt.verificationDigest !== processReceipt.receipt.verificationDigest ||
				digestObject({ ...processWitness, headDigest: input.admission.hostHeadDigest }) !==
					digestObject(processReceipt.consumptionWitness)
			)
				fail("intent_tdd_gate_invalid", `host process receipt ${binding.stageId} changed after persistence.`);
		}
		const expectedBindingDigest = recipeReceiptBindingDigest({
			kind: "tdd_evidence",
			context: input.host.context,
			recipeId: input.admission.recipeId,
			revision: input.admission.revision,
			payloadDigest: digestObject(binding.envelope),
			metadataDigest: intentTddEvidenceMetadataDigest(binding),
		});
		const resolvedReceipt = await resolveAndVerifyWorkflowHostReceipt({
			context: input.host.context.receiptContext,
			workflowId: input.admission.workflowId,
			expectedBindingDigest,
			receipt: binding.validationReceipt,
			currentStateDigest: input.admission.hostHeadDigest,
			currentRevision: input.admission.revision,
			trustedNow: input.host.context.issuedAt,
		});
		const witness = await input.host.context.receiptContext.receiptResolver.resolveConsumptionWitness({
			receiptId: resolvedReceipt.receiptId,
			workflowId: input.admission.workflowId,
			expectedBindingDigest,
		});
		if (
			resolvedReceipt.verificationDigest !== binding.validationReceipt.verificationDigest ||
			witness.receiptId !== binding.consumptionWitness.receiptId ||
			witness.workflowId !== binding.consumptionWitness.workflowId ||
			witness.bindingDigest !== binding.consumptionWitness.bindingDigest ||
			witness.consumptionSequence !== binding.consumptionWitness.consumptionSequence
		)
			fail("intent_tdd_gate_invalid", `host evidence receipt ${binding.stageId} changed after persistence.`);
	}
}

/** Re-resolve a persisted registration receipt through the durable host store before dispatch. */
export async function consumeWorkflowRecipeAdmissionAtHost(input: {
	admission: WorkflowRecipeAdmissionArtifact;
	host: WorkflowRecipeAdmissionHostResolutionPort;
	consumer: WorkflowRecipeAdmissionConsumer;
}): Promise<WorkflowRecipeAdmissionConsumptionProof> {
	validateWorkflowRecipeAdmission(input.admission);
	if (typeof input.consumer?.consumeWorkflowRecipeAdmission !== "function")
		fail("recipe_invalid", "recipe admission consumer is not host-provided.");
	const registration = input.admission.registrationReceipt;
	if (registration === undefined) fail("recipe_registration_required", "recipe admission registration is missing.");
	const expectedBindingDigest = digestObject({
		kind: "workflow-recipe-receipt-binding",
		receiptKind: "recipe_registration",
		workflowId: input.admission.workflowId,
		recipeId: input.admission.recipeId,
		revision: input.admission.revision,
		registryManifestDigest: input.admission.registryManifestDigest,
		hostKeyId: registration.receipt.keyId,
		epochRef: input.admission.hostEpochRef,
		headDigest: input.admission.hostHeadDigest,
		currentDecisionDigest: input.admission.hostDecisionDigest,
		contextDigest: input.admission.hostContextDigest,
		payloadDigest: registration.receipt.payloadDigest,
	});
	verifyWorkflowRecipeAdmissionRegistration(input);
	const resolvedReceipt = await resolveAndVerifyWorkflowHostReceipt({
		context: input.host.context.receiptContext,
		workflowId: input.admission.workflowId,
		expectedBindingDigest,
		receipt: registration.receipt,
		currentStateDigest: input.admission.hostHeadDigest,
		currentRevision: input.admission.revision,
		trustedNow: input.host.context.issuedAt,
	});
	const witness = await input.host.context.receiptContext.receiptResolver.resolveConsumptionWitness({
		receiptId: resolvedReceipt.receiptId,
		workflowId: input.admission.workflowId,
		expectedBindingDigest,
	});
	const persistedWitness: WorkflowRecipeReceiptConsumptionWitness = {
		...witness,
		headDigest: input.admission.hostHeadDigest,
	};
	if (
		resolvedReceipt.verificationDigest !== registration.receipt.verificationDigest ||
		digestObject(persistedWitness) !== digestObject(registration.consumptionWitness)
	) {
		fail("recipe_registration_required", "host registration consumption witness changed after persistence.");
	}
	const authority = input.host.context.authenticatedReceiptResolver;
	if (typeof authority.consumeAdmissionAtHost !== "function")
		fail(
			"recipe_registration_required",
			"recipe admission consumption requires the opaque host admission transaction authority.",
		);
	await verifyWorkflowRecipeAdmissionEvidenceAtHost(input);
	let result: WorkflowRecipeAdmissionHostConsumption;
	try {
		result = await authority.consumeAdmissionAtHost({
			admission: input.admission,
			registration,
			expectedBindingDigest,
			expectedAdmissionPreimageDigest: input.admission.recipeDigest,
			workflowId: input.admission.workflowId,
			currentHeadDigest: input.admission.hostHeadDigest,
			currentDecisionDigest: input.admission.hostDecisionDigest,
			currentEpochRef: input.admission.hostEpochRef,
			currentRevision: input.admission.revision,
			consumer: () => input.consumer.consumeWorkflowRecipeAdmission(input.admission),
		});
	} catch (error: unknown) {
		if (error instanceof WorkflowRecipeCompileError) throw error;
		const message = error instanceof Error ? error.message : "host admission transaction failed";
		fail("recipe_registration_required", `host admission transaction failed: ${message}`);
	}
	if (result.status !== "consumed" && result.status !== "already_consumed")
		fail("recipe_registration_required", "host admission transaction returned an invalid idempotency status.");
	const freshRegistration = result.registration;
	if (
		digestObject(freshRegistration.payload) !== digestObject(registration.payload) ||
		digestObject(freshRegistration.receipt) !== digestObject(registration.receipt) ||
		digestObject(freshRegistration.consumptionWitness) !== digestObject(registration.consumptionWitness)
	)
		fail("recipe_registration_required", "host admission transaction returned a different registration artifact.");
	const proofOutput: { value?: WorkflowRecipeHostReceiptProof } = {};
	verifyRecipeHostReceipt({
		receipt: freshRegistration,
		kind: "recipe_registration",
		proposal: input.admission.recipeBinding.proposal,
		context: input.host.context,
		expectedAdmissionPreimageDigest: input.admission.recipeDigest,
		proofOut: proofOutput,
	});
	if (
		proofOutput.value === undefined ||
		digestObject(proofOutput.value) !== digestObject(result.proof) ||
		result.proof.admissionPreimageDigest !== input.admission.recipeDigest ||
		result.proof.signedReceiptPreimageDigest !== signedReceiptPreimageDigest(freshRegistration.receipt)
	)
		fail(
			"recipe_registration_required",
			"host admission transaction returned an unauthenticated registration proof.",
		);
	const consumptionProof = Object.freeze({
		[workflowRecipeAdmissionConsumptionProofBrand]: true as const,
		workflowId: input.admission.workflowId,
		admissionDigest: input.admission.admissionDigest,
		status: result.status,
	});
	workflowRecipeAdmissionConsumptionProofs.add(consumptionProof);
	return consumptionProof;
}

/** Hand an immutable admission to the single host-owned durable consumption boundary. */
export async function consumeWorkflowRecipeAdmission(
	admission: WorkflowRecipeAdmissionArtifact,
	consumer: WorkflowRecipeAdmissionConsumer,
	host?: WorkflowRecipeAdmissionHostResolutionPort,
): Promise<WorkflowRecipeAdmissionConsumptionProof> {
	if (host === undefined)
		fail(
			"recipe_registration_required",
			"recipe admission consumption requires an authenticated host authority; use the host consumption boundary.",
		);
	return consumeWorkflowRecipeAdmissionAtHost({ admission, host, consumer });
}

/** Verify that a host admission is the exact artifact for one current scheduler task. */
export function verifyWorkflowRecipeAdmissionForTask(input: {
	admission: WorkflowRecipeAdmissionArtifact;
	task: WorkflowTask;
	graph: WorkflowTaskGraph;
	epochRef: WorkflowEpochRef;
	workflowId: string;
	currentHostHeadDigest: string;
}): void {
	validateWorkflowRecipeAdmission(input.admission);
	if (
		input.workflowId.trim().length === 0 ||
		!/^[0-9a-f]{64}$/u.test(input.currentHostHeadDigest) ||
		input.admission.workflowId !== input.workflowId ||
		input.admission.hostHeadDigest !== input.currentHostHeadDigest
	)
		fail("task_binding_mismatch", "recipe admission is bound to a different workflow or current host head.");
	if (input.admission.baseTaskGraphDigest !== input.graph.graphDigest)
		fail("task_binding_mismatch", "recipe admission is bound to a different task graph.");
	if (digestObject(input.admission.hostEpochRef) !== digestObject(input.epochRef))
		fail("task_binding_mismatch", "recipe admission is bound to a stale workflow epoch.");
	if (input.admission.taskBindings.length !== input.graph.tasks.length)
		fail("task_binding_mismatch", "recipe admission does not bind every graph task.");
	for (const graphTask of input.graph.tasks) {
		const graphBinding = input.admission.taskBindings.find((binding) => binding.taskId === graphTask.taskId);
		if (graphBinding === undefined || graphBinding.taskDigest !== digestObject(graphTask))
			fail("task_binding_mismatch", "recipe admission task bindings do not exactly cover the current graph.");
	}
	const taskBinding = input.admission.taskBindings.find((binding) => binding.taskId === input.task.taskId);
	if (taskBinding === undefined) fail("task_binding_mismatch", "recipe admission does not bind the current task.");
	if (
		taskBinding.taskDigest !== digestObject(input.task) ||
		digestObject(taskBinding.requiredSkillSnapshotDigests) !==
			digestObject(input.task.requiredSkillSnapshotDigests) ||
		digestObject(taskBinding.ownedPaths) !== digestObject(input.task.ownedPaths)
	)
		fail("task_binding_mismatch", "recipe admission task binding does not match the current task.");
	const graphTask = input.graph.byId.get(input.task.taskId);
	if (graphTask === undefined || digestObject(graphTask) !== taskBinding.taskDigest)
		fail("task_binding_mismatch", "recipe admission task binding does not match the graph index.");
	const pathBoundary = normalizePathBoundary(input.admission.pathBoundary);
	for (const path of taskBinding.ownedPaths)
		normalizePath(path, `recipe admission task ${input.task.taskId} owned path`, pathBoundary.workspacePaths);
	for (const path of taskBinding.generatedOutputPaths)
		normalizePath(
			path,
			`recipe admission task ${input.task.taskId} generated output`,
			pathBoundary.generatedOutputPaths,
		);
	const lockRoots = Object.freeze([...pathBoundary.workspacePaths, ...pathBoundary.generatedOutputPaths]);
	for (const path of taskBinding.lockPaths)
		normalizePath(path, `recipe admission task ${input.task.taskId} lock`, lockRoots);
	if (
		!taskBinding.gateIds.includes(WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID) ||
		!taskBinding.gateIds.includes(WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID)
	)
		fail("task_binding_mismatch", "recipe admission is not topology-bound to its universal host gates.");
	if (input.admission.recipeId === WORKFLOW_RECIPE_IMPLEMENTATION_RECIPE_ID) {
		if (
			input.admission.intentTddGate === undefined ||
			!taskBinding.gateIds.includes(WORKFLOW_RECIPE_INTENT_TDD_GATE_ID)
		)
			fail("task_binding_mismatch", "intent-TDD admission is not topology-bound to the current task.");
	}
	if (
		!taskBinding.gateIds.includes(WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID) ||
		!taskBinding.gateIds.includes(WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID)
	)
		fail("task_binding_mismatch", "recipe admission is missing a topology-derived blocking gate.");
}

function normalizeRecipeCatalog(value: unknown): readonly WorkflowRecipeProposal[] {
	let recipes: unknown;
	if (Array.isArray(value)) {
		recipes = value;
	} else {
		const record = assertClosedRecord(value, "recipe catalog", ["recipes"]);
		recipes = record.recipes;
	}
	if (!Array.isArray(recipes)) fail("recipe_invalid", "recipe catalog recipes must be an array.");
	const normalized = recipes.map(normalizeProposal);
	const ids = new Set<string>();
	for (const recipe of normalized) {
		if (ids.has(recipe.recipeId))
			fail("recipe_catalog_duplicate", `recipe catalog contains ${recipe.recipeId} more than once.`);
		ids.add(recipe.recipeId);
	}
	return Object.freeze(normalized.sort(compareByRecipeId));
}

function resolveRecipeCatalog(input: WorkflowRecipeResolutionInput): readonly WorkflowRecipeProposal[] {
	const catalogs: Array<readonly WorkflowRecipeProposal[]> = [];
	if (input.catalog !== undefined) catalogs.push(normalizeRecipeCatalog(input.catalog));
	if (input.superpowersCatalog !== undefined) catalogs.push(normalizeRecipeCatalog(input.superpowersCatalog));
	if (catalogs.length === 0) return Object.freeze([]);
	const combined = catalogs.flat();
	const ids = new Set<string>();
	for (const recipe of combined) {
		if (ids.has(recipe.recipeId))
			fail("recipe_catalog_duplicate", `recipe catalog contains ${recipe.recipeId} more than once.`);
		ids.add(recipe.recipeId);
	}
	return Object.freeze(combined.sort(compareByRecipeId));
}

function frozenCapabilityGap(requestedRecipeId: string): WorkflowRecipeCapabilityGap {
	return freezeDeep({
		kind: "capability_gap" as const,
		code: "capability_gap" as const,
		capability: "superpowers" as const,
		requestedRecipeId,
		disposition: "blocked" as const,
		fallback: "none" as const,
	});
}

/** Resolve an optional catalog entry without ever falling back to an ordinary DAG. */
export function resolveWorkflowRecipe(input: WorkflowRecipeResolutionInput): WorkflowRecipeResolution {
	const isOptional = input.optional === true || input.requestedRecipeId.startsWith("superpowers:");
	const isSuperpowers = input.requestedRecipeId.startsWith("superpowers:");
	if (isSuperpowers) {
		if (input.catalog !== undefined || input.superpowersCatalog !== undefined) resolveRecipeCatalog(input);
		const source = normalizeSuperpowersSource(input.superpowersSource);
		if (source === undefined || input.catalog !== undefined || input.superpowersCatalog !== undefined)
			return frozenCapabilityGap(input.requestedRecipeId);
		let catalog: readonly WorkflowRecipeProposal[];
		try {
			catalog = normalizeRecipeCatalog(source.recipes);
		} catch (error: unknown) {
			if (error instanceof WorkflowRecipeCompileError && error.code === "recipe_catalog_duplicate") throw error;
			return frozenCapabilityGap(input.requestedRecipeId);
		}
		const selected = catalog.find((recipe) => recipe.recipeId === input.requestedRecipeId);
		if (
			selected === undefined ||
			!selected.capabilities.some(
				(capability) => capability.id === "superpowers" && capability.name === "superpowers",
			) ||
			selected.requiredSkillSnapshotDigests === undefined ||
			(selected.requiredSkillSnapshotDigests !== undefined &&
				digestObject(selected.requiredSkillSnapshotDigests) !==
					digestObject(
						source.skillSnapshots.map((snapshot) => snapshot.snapshotDigest).sort(compareCodePointStrings),
					))
		)
			return frozenCapabilityGap(input.requestedRecipeId);
		return compileWorkflowRecipe({
			proposal: selected,
			tasks: input.tasks,
			graphContext: input.graphContext,
			registry: input.registry,
			host: input.host,
			registeredManifest: input.registeredManifest,
			catalogBinding: {
				sourceId: "superpowers",
				snapshotDigest: source.snapshotDigest,
				provenanceDigest: source.provenanceDigest,
				verificationReceiptDigest: source.verificationReceiptDigest,
				recipeCatalogDigest: source.recipeCatalogDigest,
				skillSnapshotDigests: source.skillSnapshots.map((snapshot) => snapshot.snapshotDigest),
			},
		});
	}
	const catalog = isOptional ? resolveRecipeCatalog(input) : Object.freeze([]);
	if (isOptional) {
		const selected = catalog.find((recipe) => recipe.recipeId === input.requestedRecipeId);
		if (selected === undefined || (input.superpowersCatalog === undefined && input.catalog === undefined))
			return frozenCapabilityGap(input.requestedRecipeId);
		return compileWorkflowRecipe({
			proposal: selected,
			tasks: input.tasks,
			graphContext: input.graphContext,
			registry: input.registry,
			host: input.host,
			registeredManifest: input.registeredManifest,
		});
	}
	if (input.proposal === undefined) fail("recipe_not_found", `recipe ${input.requestedRecipeId} was not provided.`);
	if (input.proposal.recipeId !== input.requestedRecipeId)
		fail("recipe_not_found", `recipe ${input.requestedRecipeId} was not provided.`);
	return compileWorkflowRecipe({
		proposal: input.proposal,
		tasks: input.tasks,
		graphContext: input.graphContext,
		registry: input.registry,
		host: input.host,
		registeredManifest: input.registeredManifest,
	});
}

function builtinEvidence(stageIds: readonly string[]): readonly EvidencePolicy[] {
	return Object.freeze([
		...stageIds.map((stageId) => ({ id: `evidence-${stageId}`, maxBytes: 4096, maxItems: 8, independent: true })),
		{ id: "universal", maxBytes: 8192, maxItems: 8, independent: true },
		{ id: "overfit", maxBytes: 8192, maxItems: 16, independent: true },
	]);
}

function builtinOverlays(recipeKey: string): WorkflowRecipeOverlays {
	return {
		universalHostGateIds: [WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID],
		preEvaluationOverfitting: {
			evidencePolicyId: "overfit",
			checks: WORKFLOW_RECIPE_OVERFITTING_CHECKS,
			blockingBoundaries: ["holdout", "promotion", "milestone_acceptance", "completion"],
			opaqueHoldoutRef: `builtin:${recipeKey}:holdout`,
		},
	};
}

/**
 * Per-role default compute tier and fan-out width.
 * Read-only survey stages run cheap and wide; adjudicating stages run deep.
 * Absent roles fall back to one standard-tier branch.
 */
const BUILTIN_STAGE_COMPUTE: Readonly<Record<string, WorkflowRecipeComputeClass>> = Object.freeze({
	recon: "cheap",
	lens: "cheap",
	attack: "cheap",
	verify: "standard",
	architect: "standard",
	"edge-test": "standard",
	synthesize: "deep",
	"red-team": "deep",
	judge: "deep",
	unify: "deep",
});

/** Capability a role needs beyond plain workspace reads. */
const BUILTIN_STAGE_CAPABILITIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
	verify: ["read", "verification"],
	"red-team": ["read", "red_team"],
	attack: ["read", "red_team"],
	"edge-test": ["read", "verification"],
});

function builtinStages(stageIds: readonly string[]): readonly StageSpec[] {
	return Object.freeze(
		stageIds.map((stageId) => {
			return {
				id: stageId,
				role: stageId,
				taskId: stageId,
				evidencePolicyId: `evidence-${stageId}`,
				capabilityIds: BUILTIN_STAGE_CAPABILITIES[stageId] ?? ["read"],
				generatedOutputPaths: [`artifacts/out/${stageId}.json`],
				lockPaths: [],
				computeClass: BUILTIN_STAGE_COMPUTE[stageId] ?? "standard",
			};
		}),
	);
}

function builtinCapabilities(): readonly CapabilityRequirement[] {
	return Object.freeze([
		{ id: "autoresearch", name: "autoresearch" },
		{ id: "mempalace", name: "mempalace" },
		{ id: "read", name: "read_workspace" },
		{ id: "red_team", name: "red_team" },
		{ id: "verification", name: "verification" },
	]);
}

function builtinImplementationStages(): readonly StageSpec[] {
	const capabilityIdsByStage: Readonly<Record<string, readonly string[]>> = {
		intent: ["read"],
		"acceptance-red": ["read", "verification"],
		"implementation-green": ["read", "edit", "write_owned_paths"],
		integration: ["read", "invoke_host_effect"],
		metamorphic: ["read", "verification"],
		"independent-verification": ["read", "verification"],
		"adversarial-review": ["read", "red_team"],
	};
	return Object.freeze(
		WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.map((stageId) => ({
			id: stageId,
			role: INTENT_TDD_STAGE_ROLES[stageId],
			taskId: stageId,
			evidencePolicyId: `tdd-${stageId}`,
			capabilityIds: capabilityIdsByStage[stageId],
			generatedOutputPaths: [`artifacts/out/${stageId}.json`],
			lockPaths: [],
		})),
	);
}

function builtinImplementationEvidence(): readonly EvidencePolicy[] {
	return Object.freeze([
		...WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.map((stageId, index) => ({
			id: `tdd-${stageId}`,
			maxBytes: 8192,
			maxItems: 32,
			independent: index >= 5,
			kind: WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_KINDS[index],
			requiredClaims: WORKFLOW_RECIPE_INTENT_TDD_EVIDENCE_REQUIREMENTS[index]?.requiredClaims,
		})),
		{ id: "overfit", maxBytes: 8192, maxItems: 16, independent: true, kind: "overfitting_review" },
		{ id: "tdd-lifecycle", maxBytes: 16384, maxItems: 64, independent: true, kind: "tdd_lifecycle" },
	]);
}

function builtinImplementationCapabilities(): readonly CapabilityRequirement[] {
	return Object.freeze([
		...builtinCapabilities(),
		{ id: "superpowers", name: "superpowers" },
		{ id: "edit", name: "edit" },
		{ id: "write_owned_paths", name: "write_owned_paths" },
		{ id: "invoke_host_effect", name: "invoke_host_effect" },
	]);
}

export const BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE: WorkflowRecipeProposal = freezeDeep({
	recipeId: WORKFLOW_RECIPE_IMPLEMENTATION_RECIPE_ID,
	revision: 1,
	requiredSkillSnapshotDigests: BUILTIN_SUPERPOWERS_SKILL_SNAPSHOT_DIGESTS,
	stages: builtinImplementationStages(),
	gates: [
		{ id: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID, kind: "host_adjudication", evidencePolicyId: "tdd-lifecycle" },
		{ id: WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID, kind: "overfitting_review", evidencePolicyId: "overfit" },
		{
			id: WORKFLOW_RECIPE_INTENT_TDD_GATE_ID,
			kind: "tdd_lifecycle",
			stageIds: WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
			evidencePolicyId: "tdd-lifecycle",
		},
	],
	capabilities: builtinImplementationCapabilities(),
	evidencePolicies: builtinImplementationEvidence(),
	edges: WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.slice(1).map((stageId, index) => ({
		id: `tdd-edge-${index}`,
		from: WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS[index],
		to: stageId,
		kind: "forward" as const,
	})),
	fanOuts: [],
	loops: [],
	overlays: builtinOverlays("superpowers-prime-implementation"),
});

export const BUILTIN_SUPERPOWERS_IMPLEMENTATION_RECIPE = BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE;

const RECON_LENS_STAGE_IDS = Object.freeze(["recon", "lens", "verify", "synthesize", "red-team"] as const);
const ATTACK_ARCHITECT_STAGE_IDS = Object.freeze(["attack", "architect", "judge", "unify", "edge-test"] as const);
const DEFAULT_PRIME_STAGE_IDS = Object.freeze([...RECON_LENS_STAGE_IDS, ...ATTACK_ARCHITECT_STAGE_IDS] as const);

export const BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM: WorkflowRecipeProposal = freezeDeep({
	recipeId: "builtin:recon-lens-verify-synthesize-red-team",
	revision: 1,
	stages: builtinStages(RECON_LENS_STAGE_IDS),
	gates: [
		{ id: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID, kind: "host_adjudication", evidencePolicyId: "universal" },
		{ id: WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID, kind: "overfitting_review", evidencePolicyId: "overfit" },
	],
	capabilities: builtinCapabilities(),
	evidencePolicies: builtinEvidence(["recon", "lens", "verify", "synthesize", "red-team"]),
	edges: [
		{ id: "recon-to-lens", from: "recon", to: "lens", kind: "forward" },
		{ id: "lens-to-verify", from: "lens", to: "verify", kind: "forward" },
		{ id: "verify-to-synthesize", from: "verify", to: "synthesize", kind: "forward" },
		{ id: "synthesize-to-red-team", from: "synthesize", to: "red-team", kind: "forward" },
	],
	fanOuts: [],
	loops: [],
	overlays: builtinOverlays("recon-lens-verify-synthesize-red-team"),
});

export const BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST: WorkflowRecipeProposal = freezeDeep({
	recipeId: "builtin:attack-architect-judge-unify-edge-test",
	revision: 1,
	stages: builtinStages(ATTACK_ARCHITECT_STAGE_IDS),
	gates: [
		{ id: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID, kind: "host_adjudication", evidencePolicyId: "universal" },
		{ id: WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID, kind: "overfitting_review", evidencePolicyId: "overfit" },
		{ id: "judge", kind: "judge", stageIds: ["judge"], evidencePolicyId: "evidence-judge" },
		{ id: "unify", kind: "unify", stageIds: ["unify"], evidencePolicyId: "evidence-unify" },
		{ id: "edge-test", kind: "edge_test", stageIds: ["edge-test"], evidencePolicyId: "evidence-edge-test" },
	],
	capabilities: builtinCapabilities(),
	evidencePolicies: builtinEvidence(["attack", "architect", "judge", "unify", "edge-test"]),
	edges: [
		{ id: "attack-to-architect", from: "attack", to: "architect", kind: "forward" },
		{ id: "architect-to-judge", from: "architect", to: "judge", kind: "forward" },
		{ id: "judge-to-unify", from: "judge", to: "unify", kind: "forward" },
		{ id: "unify-to-edge-test", from: "unify", to: "edge-test", kind: "forward" },
		{ id: "edge-test-back", from: "edge-test", to: "architect", kind: "back", gateId: "edge-test" },
	],
	fanOuts: [],
	loops: [
		{
			id: "edge-test-loop",
			from: "edge-test",
			to: "architect",
			gateId: "edge-test",
			maxTraversals: 2,
			progressEvidencePolicyId: "evidence-edge-test",
			exhaustionGateId: "edge-test",
		},
	],
	overlays: builtinOverlays("attack-architect-judge-unify-edge-test"),
});

/**
 * Stage ids for the comprehensive topology: a fanned-out decision pipeline that
 * feeds the intent-TDD implementation chain. Recon and lens branches divide the
 * work by charter rather than repeating it, so each join is a union of findings.
 */
export const COMPREHENSIVE_STAGE_IDS = Object.freeze([
	"scope",
	"recon-code",
	"recon-tests",
	"recon-history",
	"synthesize-recon",
	"lens-intent",
	"lens-correctness",
	"lens-security",
	"synthesize",
	"red-team",
	"adjudicate",
	...WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS,
] as const);

/** Charter per fanned-out branch. Distinct charters are what make a fan-out divide work instead of repeat it. */
export const COMPREHENSIVE_BRANCH_CHARTERS: Readonly<Record<string, string>> = Object.freeze({
	"recon-code": "Read the implementation the objective touches. Report what exists, not what should exist.",
	"recon-tests": "Read the tests and fixtures covering this area. Report what is actually asserted today.",
	"recon-history": "Read git history and prior decisions for this area. Report what was already tried and why.",
	"lens-intent": "Does the proposal serve the stated objective? Name any drift from what was asked.",
	"lens-correctness": "Where is the proposal wrong? Name concrete inputs producing a wrong result.",
	"lens-security": "What does the proposal expose? Name the trust boundary it crosses.",
});

const COMPREHENSIVE_RECON_BRANCHES = Object.freeze(["recon-code", "recon-tests", "recon-history"] as const);
const COMPREHENSIVE_LENS_BRANCHES = Object.freeze(["lens-intent", "lens-correctness", "lens-security"] as const);

const COMPREHENSIVE_COMPUTE: Readonly<Record<string, WorkflowRecipeComputeClass>> = Object.freeze({
	scope: "cheap",
	"recon-code": "cheap",
	"recon-tests": "cheap",
	"recon-history": "cheap",
	"synthesize-recon": "standard",
	"lens-intent": "cheap",
	"lens-correctness": "cheap",
	"lens-security": "cheap",
	synthesize: "deep",
	"red-team": "deep",
	adjudicate: "deep",
	intent: "standard",
	"acceptance-red": "standard",
	"implementation-green": "standard",
	integration: "standard",
	metamorphic: "standard",
	"independent-verification": "deep",
	"adversarial-review": "deep",
});

const COMPREHENSIVE_CAPABILITIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
	"red-team": ["read", "red_team"],
	"adversarial-review": ["read", "red_team"],
	"lens-security": ["read", "red_team"],
	"independent-verification": ["read", "verification"],
	"acceptance-red": ["read", "verification"],
	metamorphic: ["read", "verification"],
	"implementation-green": ["read", "edit", "write_owned_paths"],
	integration: ["read", "invoke_host_effect"],
});

function comprehensiveStages(): readonly StageSpec[] {
	return Object.freeze(
		COMPREHENSIVE_STAGE_IDS.map((stageId) => ({
			id: stageId,
			role: INTENT_TDD_STAGE_ROLES[stageId] ?? comprehensiveRole(stageId),
			taskId: stageId,
			evidencePolicyId: `evidence-${stageId}`,
			capabilityIds: COMPREHENSIVE_CAPABILITIES[stageId] ?? ["read"],
			generatedOutputPaths: [`artifacts/out/${stageId}.json`],
			lockPaths: [],
			computeClass: COMPREHENSIVE_COMPUTE[stageId] ?? "standard",
		})),
	);
}

/** Branch stages carry their family's registry role; only the charter differs per branch. */
function comprehensiveRole(stageId: string): string {
	if (stageId.startsWith("recon")) return "recon";
	if (stageId.startsWith("lens")) return "lens";
	if (stageId === "synthesize-recon") return "synthesize";
	if (stageId === "scope") return "planning";
	if (stageId === "adjudicate") return "host_adjudication";
	return stageId;
}

/**
 * The comprehensive built-in topology: fanned-out recon and lenses, a deep
 * synthesis/red-team/adjudication spine, then the full intent-TDD chain.
 * This is the recipe to select when an objective needs both a decision and an
 * implementation, rather than one or the other.
 */
export const BUILTIN_COMPREHENSIVE_RECIPE: WorkflowRecipeProposal = freezeDeep({
	recipeId: "builtin:comprehensive",
	revision: 1,
	stages: comprehensiveStages(),
	gates: [
		{ id: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID, kind: "host_adjudication", evidencePolicyId: "universal" },
		{ id: WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID, kind: "overfitting_review", evidencePolicyId: "overfit" },
		{
			id: WORKFLOW_RECIPE_INTENT_TDD_GATE_ID,
			kind: "tdd_lifecycle",
			stageIds: [...WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS],
			evidencePolicyId: "evidence-intent",
		},
	],
	capabilities: builtinImplementationCapabilities(),
	evidencePolicies: builtinEvidence([...COMPREHENSIVE_STAGE_IDS]),
	edges: [
		...COMPREHENSIVE_RECON_BRANCHES.map((stageId) => ({
			id: `scope-to-${stageId}`,
			from: "scope",
			to: stageId,
			kind: "forward" as const,
		})),
		...COMPREHENSIVE_RECON_BRANCHES.map((stageId) => ({
			id: `${stageId}-to-synthesize-recon`,
			from: stageId,
			to: "synthesize-recon",
			kind: "forward" as const,
		})),
		...COMPREHENSIVE_LENS_BRANCHES.map((stageId) => ({
			id: `synthesize-recon-to-${stageId}`,
			from: "synthesize-recon",
			to: stageId,
			kind: "forward" as const,
		})),
		...COMPREHENSIVE_LENS_BRANCHES.map((stageId) => ({
			id: `${stageId}-to-synthesize`,
			from: stageId,
			to: "synthesize",
			kind: "forward" as const,
		})),
		{ id: "synthesize-to-red-team", from: "synthesize", to: "red-team", kind: "forward" },
		{ id: "red-team-to-adjudicate", from: "red-team", to: "adjudicate", kind: "forward" },
		{ id: "adjudicate-to-intent", from: "adjudicate", to: "intent", kind: "forward" },
		...WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS.slice(1).map((stageId, index) => ({
			id: `${WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS[index]}-to-${stageId}`,
			from: WORKFLOW_RECIPE_INTENT_TDD_STAGE_IDS[index],
			to: stageId,
			kind: "forward" as const,
		})),
	],
	fanOuts: [
		{
			id: "fanout-recon",
			from: "scope",
			branchStageIds: [...COMPREHENSIVE_RECON_BRANCHES],
			joinStageId: "synthesize-recon",
			maxBranches: COMPREHENSIVE_RECON_BRANCHES.length,
		},
		{
			id: "fanout-lens",
			from: "synthesize-recon",
			branchStageIds: [...COMPREHENSIVE_LENS_BRANCHES],
			joinStageId: "synthesize",
			maxBranches: COMPREHENSIVE_LENS_BRANCHES.length,
		},
	],
	loops: [],
	overlays: builtinOverlays("comprehensive"),
});

export const BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE: WorkflowRecipeProposal = freezeDeep({
	recipeId: "builtin:recon-lens-verify-synthesize-red-team-attack-architect-judge-unify-edge-test",
	revision: 1,
	stages: builtinStages(DEFAULT_PRIME_STAGE_IDS),
	gates: [
		{ id: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID, kind: "host_adjudication", evidencePolicyId: "universal" },
		{ id: WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID, kind: "overfitting_review", evidencePolicyId: "overfit" },
		{ id: "judge", kind: "judge", stageIds: ["judge"], evidencePolicyId: "evidence-judge" },
		{ id: "unify", kind: "unify", stageIds: ["unify"], evidencePolicyId: "evidence-unify" },
		{ id: "edge-test", kind: "edge_test", stageIds: ["edge-test"], evidencePolicyId: "evidence-edge-test" },
	],
	capabilities: builtinCapabilities(),
	evidencePolicies: builtinEvidence([
		"recon",
		"lens",
		"verify",
		"synthesize",
		"red-team",
		"attack",
		"architect",
		"judge",
		"unify",
		"edge-test",
	]),
	edges: [
		{ id: "recon-to-lens", from: "recon", to: "lens", kind: "forward" },
		{ id: "lens-to-verify", from: "lens", to: "verify", kind: "forward" },
		{ id: "verify-to-synthesize", from: "verify", to: "synthesize", kind: "forward" },
		{ id: "synthesize-to-red-team", from: "synthesize", to: "red-team", kind: "forward" },
		{ id: "red-team-to-attack", from: "red-team", to: "attack", kind: "forward" },
		{ id: "attack-to-architect", from: "attack", to: "architect", kind: "forward" },
		{ id: "architect-to-judge", from: "architect", to: "judge", kind: "forward" },
		{ id: "judge-to-unify", from: "judge", to: "unify", kind: "forward" },
		{ id: "unify-to-edge-test", from: "unify", to: "edge-test", kind: "forward" },
		{ id: "edge-test-back", from: "edge-test", to: "architect", kind: "back", gateId: "edge-test" },
	],
	fanOuts: [],
	loops: [
		{
			id: "edge-test-loop",
			from: "edge-test",
			to: "architect",
			gateId: "edge-test",
			maxTraversals: 2,
			progressEvidencePolicyId: "evidence-edge-test",
			exhaustionGateId: "edge-test",
		},
	],
	overlays: builtinOverlays("recon-lens-verify-synthesize-red-team-attack-architect-judge-unify-edge-test"),
});

export const BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM_RECIPE = BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM;
export const BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST_RECIPE = BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST;
export const BUILTIN_WORKFLOW_RECIPE_PROPOSALS = Object.freeze([
	BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE,
	BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM,
	BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST,
	BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE,
] as const);

export function createBuiltinReconLensVerifySynthesizeRedTeamRecipe(): WorkflowRecipeProposal {
	return structuredClone(BUILTIN_RECON_LENS_VERIFY_SYNTHESIZE_RED_TEAM);
}

export function createBuiltinAttackArchitectJudgeUnifyEdgeTestRecipe(): WorkflowRecipeProposal {
	return structuredClone(BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST);
}

export function createBuiltinDefaultPrimeAdaptiveRecipe(): WorkflowRecipeProposal {
	return structuredClone(BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE);
}

export function createBuiltinSuperpowersPrimeImplementationRecipe(): WorkflowRecipeProposal {
	return structuredClone(BUILTIN_SUPERPOWERS_PRIME_IMPLEMENTATION_RECIPE);
}

export const BUILTIN_SUPERPOWERS_METHODOLOGY_MAPPING = freezeDeep({
	sourceId: "superpowers",
	snapshotPolicy: "immutable_host_verified",
	bindings: [
		{
			skillId: "brainstorming",
			snapshotDigest: builtinSuperpowersSkillDigest("brainstorming"),
			role: "planning",
			gateId: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID,
			readOnly: true,
			ownedPathKinds: ["artifacts"],
			authority: [],
		},
		{
			skillId: "writing-plans",
			snapshotDigest: builtinSuperpowersSkillDigest("writing-plans"),
			role: "design",
			gateId: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID,
			readOnly: true,
			ownedPathKinds: ["artifacts"],
			authority: [],
		},
		{
			skillId: "recon",
			snapshotDigest: builtinSuperpowersSkillDigest("recon"),
			role: "recon",
			gateId: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID,
			readOnly: true,
			ownedPathKinds: ["artifacts"],
			authority: [],
		},
		{
			skillId: "review",
			snapshotDigest: builtinSuperpowersSkillDigest("review"),
			role: "review",
			gateId: WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID,
			readOnly: true,
			ownedPathKinds: ["artifacts"],
			authority: [],
		},
		{
			skillId: "implementer",
			snapshotDigest: builtinSuperpowersSkillDigest("implementer"),
			role: "implementer",
			gateId: WORKFLOW_RECIPE_INTENT_TDD_GATE_ID,
			readOnly: false,
			ownedPathKinds: ["code", "tests"],
			authority: [],
		},
		{
			skillId: "test-driven-development",
			snapshotDigest: builtinSuperpowersSkillDigest("test-driven-development"),
			role: "verification",
			gateId: WORKFLOW_RECIPE_INTENT_TDD_GATE_ID,
			readOnly: true,
			ownedPathKinds: ["tests", "artifacts"],
			authority: [],
		},
		{
			skillId: "systematic-debugging",
			snapshotDigest: builtinSuperpowersSkillDigest("systematic-debugging"),
			role: "red_team",
			gateId: WORKFLOW_RECIPE_INTENT_TDD_GATE_ID,
			readOnly: true,
			ownedPathKinds: ["artifacts"],
			authority: [],
		},
	],
	practiceContract: Object.freeze([
		"brainstorming_is_concise_and_not_an_implementation_document",
		"planning_artifacts_are_concise",
		"plans_are_not_required_to_be_implementation_documents",
		"tdd_is_red_then_green",
		"debugging_follows_a_reproduced_failure",
		"verification_is_independent_and_adversarial",
		"substantial_modules_use_isolated_worktrees",
		"review_binds_exact_candidate_and_commit_sha",
		"integration_never_merges_the_base_branch",
	]),
});
