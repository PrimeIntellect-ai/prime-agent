import type { WorkflowArtifactRef, WorkflowRuntimeConfigSnapshot } from "./contracts.js";
import { digestObject, parseCanonicalJsonBytes, sha256Hex } from "./contracts.js";

export type {
	WorkflowSettings,
	WorkflowSettingsMigrationPlan,
	WorkflowSettingsStore,
	WorkflowSettingsValue,
} from "./migrations.js";

export interface WorkflowConfigInput {
	configSchemaVersion: number;
	configRevision: number;
	closureMembers: readonly string[];
	executionProfile: "unresolved" | "inline" | "parallel";
	runtimeIdentityDigest: string;
	repositoryPolicyDigest: string;
	workspaceIdentityDigest: string;
	globalSettingsDigest: string;
	projectSettingsDigest: string;
	packageDefaultsDigest: string;
	methodologyManifestDigests: readonly string[];
	nativeMethodologyContractDigest: string;
	skillContentDigests: readonly string[];
	skillDependencyDigests: readonly string[];
	evaluatorDigests: readonly string[];
	parserDigests: readonly string[];
	guardDigests: readonly string[];
	scorecardRuleDigest: string;
	resourceInventoryDigest: string;
	resourceEnvelopePolicyDigest: string;
	egressPolicyDigest: string;
	authorityPolicyDigest: string;
	approvalPolicyDigest: string;
	provenanceManifestDigest: string;
	daemonCapabilityDigest: string;
	decisionLimitsDigest: string;
	schedulerPolicyDigest: string;
	journalFormatDigest: string;
	closureManifestRef: WorkflowArtifactRef;
	closureManifestBytes: Readonly<Uint8Array>;
}

export const SUPPORTED_WORKFLOW_CONFIG_SCHEMA_VERSIONS: readonly number[] = [1, 2];

export interface WorkflowConfigSchemaValidationFailure {
	accepted: false;
	code: "recipe_config_schema_unsupported";
	configSchemaVersion: number;
	failureDigest: string;
}

export type WorkflowConfigSchemaValidationResult =
	| WorkflowConfigSchemaValidationFailure
	| { accepted: true; configSchemaVersion: 1 | 2 };

function schemaVersionDigestValue(configSchemaVersion: number): string {
	if (Number.isNaN(configSchemaVersion)) return "NaN";
	if (configSchemaVersion === Number.POSITIVE_INFINITY) return "Infinity";
	if (configSchemaVersion === Number.NEGATIVE_INFINITY) return "-Infinity";
	if (Object.is(configSchemaVersion, -0)) return "-0";
	return String(configSchemaVersion);
}

export function validateWorkflowConfigSchemaVersion(configSchemaVersion: number): WorkflowConfigSchemaValidationResult {
	if (
		Number.isSafeInteger(configSchemaVersion) &&
		SUPPORTED_WORKFLOW_CONFIG_SCHEMA_VERSIONS.includes(configSchemaVersion)
	) {
		return { accepted: true, configSchemaVersion: configSchemaVersion as 1 | 2 };
	}
	return {
		accepted: false,
		code: "recipe_config_schema_unsupported",
		configSchemaVersion,
		failureDigest: digestObject({
			schemaId: "workflow-config-schema-validation-v1",
			code: "recipe_config_schema_unsupported",
			configSchemaVersion: schemaVersionDigestValue(configSchemaVersion),
			supportedVersions: SUPPORTED_WORKFLOW_CONFIG_SCHEMA_VERSIONS,
		}),
	};
}

export function assertSupportedWorkflowConfigSchemaVersion(configSchemaVersion: number): void {
	const validation = validateWorkflowConfigSchemaVersion(configSchemaVersion);
	if (!validation.accepted)
		throw new Error(
			`${validation.code}: Workflow configuration schema version ${schemaVersionDigestValue(configSchemaVersion)} is unsupported.`,
		);
}

export interface WorkflowConfigAdapter {
	prepare(snapshot: WorkflowRuntimeConfigSnapshot): Promise<void>;
	apply(snapshot: WorkflowRuntimeConfigSnapshot): Promise<void>;
	verify(snapshot: WorkflowRuntimeConfigSnapshot): Promise<void>;
	recover(snapshot: WorkflowRuntimeConfigSnapshot): Promise<void>;
}

export interface WorkflowPreparedRuntimeConfigTransaction {
	readonly snapshot: WorkflowRuntimeConfigSnapshot;
	readonly profileState: "unresolved" | "inline" | "parallel";
	readonly state: "prepared" | "applied" | "verified" | "recovered";
	apply(): Promise<void>;
	verify(): Promise<void>;
	recover(): Promise<void>;
}

export interface WorkflowConfigService {
	snapshot(): WorkflowRuntimeConfigSnapshot;
	prepare(profileState: "unresolved" | "inline" | "parallel"): Promise<WorkflowPreparedRuntimeConfigTransaction>;
}

function assertDigest(value: string, name: string): void {
	if (value.length === 0) throw new Error(`Workflow configuration ${name} digest is empty.`);
}

function assertConfigInput(input: WorkflowConfigInput): void {
	if (
		!Number.isSafeInteger(input.configSchemaVersion) ||
		input.configSchemaVersion < 1 ||
		!Number.isSafeInteger(input.configRevision) ||
		input.configRevision < 1
	)
		throw new Error("Workflow configuration schema and revision must be positive integers.");
	if (
		input.closureMembers.length === 0 ||
		input.closureMembers.some((member) => member.length === 0) ||
		new Set(input.closureMembers).size !== input.closureMembers.length
	)
		throw new Error("Workflow configuration closure members must be non-empty and unique.");
	if (
		input.executionProfile !== "unresolved" &&
		input.executionProfile !== "inline" &&
		input.executionProfile !== "parallel"
	)
		throw new Error("Workflow configuration profile is invalid.");
	for (const [name, value] of Object.entries(input)) {
		if (name.endsWith("Digest") && typeof value === "string") assertDigest(value, name);
		if (
			name.endsWith("Digests") &&
			(!Array.isArray(value) || value.some((digest) => typeof digest !== "string" || digest.length === 0))
		)
			throw new Error(`Workflow configuration ${name} contains an empty or invalid digest.`);
	}
	if (
		input.closureManifestRef.digest.length === 0 ||
		input.closureManifestRef.sizeBytes !== input.closureManifestBytes.byteLength ||
		sha256Hex(input.closureManifestBytes) !== input.closureManifestRef.digest
	)
		throw new Error("Workflow configuration closure is not bound to immutable manifest bytes.");
}

export function resolveWorkflowRuntimeConfig(input: WorkflowConfigInput): WorkflowRuntimeConfigSnapshot {
	assertSupportedWorkflowConfigSchemaVersion(input.configSchemaVersion);
	assertConfigInput(input);
	const manifestBytes = new Uint8Array(input.closureManifestBytes);
	const manifestValue = parseCanonicalJsonBytes(manifestBytes);
	if (
		!Array.isArray(manifestValue) ||
		!manifestValue.every((member): member is string => typeof member === "string" && member.length > 0) ||
		digestObject(manifestValue) !== digestObject(input.closureMembers)
	)
		throw new Error("Workflow runtime closure manifest bytes do not resolve to the authenticated closure members.");
	const closureManifestDigest = digestObject(manifestValue);
	const snapshotWithoutDigest = {
		configSchemaVersion: input.configSchemaVersion,
		configRevision: input.configRevision,
		runtimeIdentityDigest: input.runtimeIdentityDigest,
		repositoryPolicyDigest: input.repositoryPolicyDigest,
		workspaceIdentityDigest: input.workspaceIdentityDigest,
		globalSettingsDigest: input.globalSettingsDigest,
		projectSettingsDigest: input.projectSettingsDigest,
		packageDefaultsDigest: input.packageDefaultsDigest,
		methodologyManifestDigests: [...input.methodologyManifestDigests],
		nativeMethodologyContractDigest: input.nativeMethodologyContractDigest,
		skillContentDigests: [...input.skillContentDigests],
		skillDependencyDigests: [...input.skillDependencyDigests],
		evaluatorDigests: [...input.evaluatorDigests],
		parserDigests: [...input.parserDigests],
		guardDigests: [...input.guardDigests],
		scorecardRuleDigest: input.scorecardRuleDigest,
		resourceInventoryDigest: input.resourceInventoryDigest,
		resourceEnvelopePolicyDigest: input.resourceEnvelopePolicyDigest,
		egressPolicyDigest: input.egressPolicyDigest,
		authorityPolicyDigest: input.authorityPolicyDigest,
		approvalPolicyDigest: input.approvalPolicyDigest,
		provenanceManifestDigest: input.provenanceManifestDigest,
		daemonCapabilityDigest: input.daemonCapabilityDigest,
		closureManifestDigest,
		executionProfile: input.executionProfile,
		decisionLimitsDigest: input.decisionLimitsDigest,
		schedulerPolicyDigest: input.schedulerPolicyDigest,
		journalFormatDigest: input.journalFormatDigest,
		closureManifestRef: { ...input.closureManifestRef },
	};
	const snapshot = {
		...snapshotWithoutDigest,
		resolvedConfigDigest: digestObject(snapshotWithoutDigest),
		closureManifestBytes: manifestBytes,
	} as WorkflowRuntimeConfigSnapshot;
	Object.defineProperty(snapshot, "closureManifestBytes", {
		configurable: false,
		enumerable: true,
		get: () => new Uint8Array(manifestBytes),
	});
	Object.freeze(snapshot.methodologyManifestDigests);
	Object.freeze(snapshot.skillContentDigests);
	Object.freeze(snapshot.skillDependencyDigests);
	Object.freeze(snapshot.evaluatorDigests);
	Object.freeze(snapshot.parserDigests);
	Object.freeze(snapshot.guardDigests);
	Object.freeze(snapshot.closureManifestRef);
	return Object.freeze(snapshot);
}

class PreparedRuntimeConfigTransaction implements WorkflowPreparedRuntimeConfigTransaction {
	private currentState: WorkflowPreparedRuntimeConfigTransaction["state"] = "prepared";

	public constructor(
		public readonly snapshot: WorkflowRuntimeConfigSnapshot,
		public readonly profileState: WorkflowPreparedRuntimeConfigTransaction["profileState"],
		private readonly adapter: WorkflowConfigAdapter,
	) {}

	public get state(): WorkflowPreparedRuntimeConfigTransaction["state"] {
		return this.currentState;
	}

	public async apply(): Promise<void> {
		if (this.currentState !== "prepared") throw new Error("Workflow configuration transaction is not prepared.");
		await this.adapter.apply(this.snapshot);
		this.currentState = "applied";
	}

	public async verify(): Promise<void> {
		if (this.currentState !== "applied")
			throw new Error("Workflow configuration transaction must be applied before verification.");
		await this.adapter.verify(this.snapshot);
		this.currentState = "verified";
	}

	public async recover(): Promise<void> {
		if (this.currentState === "verified") throw new Error("Verified workflow configuration cannot be recovered.");
		await this.adapter.recover(this.snapshot);
		this.currentState = "recovered";
	}
}

export function createWorkflowConfigService(input: {
	input: WorkflowConfigInput;
	adapter: WorkflowConfigAdapter;
}): WorkflowConfigService {
	const baseSnapshot = resolveWorkflowRuntimeConfig(input.input);
	return {
		snapshot: () => baseSnapshot,
		prepare: async (profileState) => {
			const snapshot = resolveWorkflowRuntimeConfig({ ...input.input, executionProfile: profileState });
			await input.adapter.prepare(snapshot);
			return new PreparedRuntimeConfigTransaction(snapshot, profileState, input.adapter);
		},
	};
}

export const createWorkflowRuntimeConfigService = createWorkflowConfigService;
