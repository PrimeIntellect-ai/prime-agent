import { spawn } from "node:child_process";
import { generateKeyPairSync, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import {
	canonicalJsonBytes,
	digestObject,
	sha256Hex,
	type WorkflowArtifactCodec,
	type WorkflowArtifactPayloadKind,
	type WorkflowArtifactPublisher,
	type WorkflowArtifactReadResult,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowDecisionRef,
	type WorkflowEpochRef,
	type WorkflowHostReceiptCapability,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import { createNodeWorkflowDescriptorFs } from "../src/core/workflow/node-descriptor-fs.js";
import {
	createSkillSnapshot,
	createWorkflowSkillDescriptorInvocationStore,
	createWorkflowSkillExecutionVerificationContext,
	createWorkflowSkillHostAdapter,
	createWorkflowSkillProductionExecutionAdapter,
	createWorkflowSkillSnapshotService,
	executeWorkflowSkillInvocation,
	getSkillInvocationToken,
	getWorkflowResourceLoaderProvenanceDigests,
	getWorkflowResourceLoaderReceiptBindingDigest,
	revalidateSkillSnapshot,
	validateAndConsumeSkillInvocation,
	validateSkillSnapshot,
	type WorkflowResourceLoaderPort,
	type WorkflowResourceLoaderProvenance,
	type WorkflowResourceLoaderResult,
	type WorkflowSkillActiveHostState,
	type WorkflowSkillActiveHostStateReader,
	type WorkflowSkillBuiltinProvenanceContext,
	type WorkflowSkillDependency,
	type WorkflowSkillDurableInvocationStore,
	type WorkflowSkillExecutionClaimInput,
	type WorkflowSkillExecutionClaimWitness,
	type WorkflowSkillInvocationAdmission,
	type WorkflowSkillInvocationConsumptionWitness,
	type WorkflowSkillInvocationStore,
	type WorkflowSkillManifestSource,
	type WorkflowSkillSnapshot,
	type WorkflowSkillSourceProvenance,
} from "../src/core/workflow/skill-snapshots.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const TRUSTED_NOW = "2026-08-13T00:01:00.000Z";
const DECISION_REF: WorkflowDecisionRef = {
	decisionScope: { kind: "workflow", workflowId: "wf-1", rootSessionId: "root-1" },
	decisionId: "decision-1",
	revision: 1,
	storeEpoch: 1,
	coordinatorEpoch: 1,
	decisionDigest: sha256Hex("decision-1"),
};
const { privateKey: RECEIPT_PRIVATE_KEY, publicKey: RECEIPT_PUBLIC_KEY } = generateKeyPairSync("ed25519");
const { privateKey: CONSUME_PRIVATE_KEY, publicKey: CONSUME_PUBLIC_KEY } = generateKeyPairSync("ed25519");

interface ArtifactFixture {
	resolver: WorkflowArtifactResolver;
	publisher: WorkflowArtifactPublisher;
	bytesByDigest: Map<string, Uint8Array>;
	records: PublishedArtifact[];
	seed(
		ref: WorkflowArtifactRef,
		bytes: Uint8Array,
		payloadKind: WorkflowArtifactPayloadKind,
		codec: WorkflowArtifactCodec,
	): void;
}

interface PublishedArtifact {
	bytes: Uint8Array;
	payloadKind: WorkflowArtifactPayloadKind;
	codec: WorkflowArtifactCodec;
	ref: WorkflowArtifactRef;
}

function createReceipt(
	workflowId: string,
	workspaceDigest: string,
	loaderResultDigest: string,
): WorkflowVerifiedHostReceipt {
	const artifactBytes = new TextEncoder().encode("loader-receipt");
	const artifactRef: WorkflowArtifactRef = {
		artifactId: "loader-receipt",
		relativePath: "artifacts/skills/loader-receipt",
		digest: sha256Hex(artifactBytes),
		sizeBytes: artifactBytes.byteLength,
		sourceEventSequence: 1,
	};
	const receipt: WorkflowVerifiedHostReceipt = {
		receiptKind: "artifact",
		oneUse: true,
		receiptId: "loader-receipt",
		issuerId: "ResourceLoader",
		workflowId,
		bindingDigest: getWorkflowResourceLoaderReceiptBindingDigest({
			workflowId,
			workspaceDigest,
			loaderRevision: 1,
			loaderResultDigest,
		}),
		payloadDigest: loaderResultDigest,
		artifactRef,
		issuedAt: "2026-08-13T00:00:00.000Z",
		validUntil: "2026-08-13T00:05:00.000Z",
		keyId: "loader-key",
		signatureAlgorithm: "ed25519",
		artifactBytesDigest: artifactRef.digest,
		stateDigest: loaderResultDigest,
		revision: 1,
		signature: "loader-signature",
		verificationDigest: "",
	};
	const { signature: _signature, verificationDigest: _verificationDigest, ...signedFields } = receipt;
	const signedReceipt = {
		...signedFields,
		signature: signBytes(null, Buffer.from(canonicalJsonBytes(signedFields)), RECEIPT_PRIVATE_KEY).toString("base64"),
		verificationDigest: "",
	};
	return { ...signedReceipt, verificationDigest: digestObject({ ...signedReceipt, verificationDigest: "" }) };
}

function createReceiptContext(artifacts: WorkflowArtifactResolver): WorkflowHostReceiptConsumerContext {
	const revokedReceiptIds = new Set<string>();
	const consumptionWitnesses = new Map<string, WorkflowHostReceiptConsumptionWitness>();
	const resolveKey = async (keyId: string) => {
		const publicKey =
			keyId === "consume-key" ? CONSUME_PUBLIC_KEY : keyId === "loader-key" ? RECEIPT_PUBLIC_KEY : null;
		if (publicKey === null) throw new Error("unknown receipt verification key");
		return {
			algorithm: "ed25519" as const,
			ownerPrincipal: keyId === "loader-key" ? "ResourceLoader" : "consume-host",
			allowedCapabilities: new Set<WorkflowHostReceiptCapability>(),
			generationId: "skill-snapshot-fixture-generation",
			epochRef: EPOCH,
			fencingDigest: digestObject({ generationId: "skill-snapshot-fixture-generation", epochRef: EPOCH }),
			revoked: false,
			verify: ({ bytes, signature }: { bytes: Readonly<Uint8Array>; signature: string }) =>
				verifyBytes(null, Buffer.from(bytes), publicKey, Buffer.from(signature, "base64")),
		};
	};
	const keyResolver = { resolve: resolveKey };
	return {
		artifactResolver: artifacts,
		revokedReceiptIds,
		keyResolver,
		receiptResolver: {
			resolve: async (input) => {
				const key = await resolveKey(input.receipt.keyId);
				const { signature: _signature, verificationDigest: _verificationDigest, ...signedFields } = input.receipt;
				const issuedAt = Date.parse(input.receipt.issuedAt);
				const validUntil = Date.parse(input.receipt.validUntil);
				if (
					input.revokedReceiptIds.has(input.receipt.receiptId) ||
					input.receipt.workflowId !== input.workflowId ||
					input.receipt.bindingDigest !== input.expectedBindingDigest ||
					input.receipt.stateDigest !== input.currentStateDigest ||
					input.receipt.revision !== input.currentRevision ||
					!Number.isFinite(issuedAt) ||
					!Number.isFinite(validUntil) ||
					Date.parse(input.trustedNow) < issuedAt ||
					Date.parse(input.trustedNow) >= validUntil ||
					input.receipt.artifactBytesDigest !== sha256Hex(input.artifactBytes) ||
					input.receipt.verificationDigest !== digestObject({ ...input.receipt, verificationDigest: "" }) ||
					!key.verify({
						bytes: canonicalJsonBytes(signedFields),
						signature: input.receipt.signature,
					})
				)
					throw new Error("untrusted loader receipt");
				return structuredClone(input.receipt);
			},
			consumeIfOneUse: async (input) => {
				if (!input.receipt.oneUse) return;
				if (
					input.receipt.workflowId !== input.workflowId ||
					input.receipt.bindingDigest !== input.expectedBindingDigest ||
					input.receipt.revision !== input.currentRevision
				)
					throw new Error("loader receipt consumption is not bound to the current host state");
				if (consumptionWitnesses.has(input.receipt.receiptId))
					throw new Error("loader receipt was already consumed");
				consumptionWitnesses.set(input.receipt.receiptId, {
					receiptId: input.receipt.receiptId,
					workflowId: input.workflowId,
					bindingDigest: input.expectedBindingDigest,
					capability: input.receipt.capabilityBinding?.capability ?? null,
					resourceDigest: input.receipt.capabilityBinding?.resourceDigest ?? null,
					operationDigest: input.receipt.capabilityBinding?.operationDigest ?? null,
					receiptDigest: input.receipt.verificationDigest,
					consumedAt: TRUSTED_NOW,
					consumptionSequence: consumptionWitnesses.size + 1,
				});
			},
			resolveConsumptionWitness: async (input) => {
				const witness = consumptionWitnesses.get(input.receiptId);
				if (
					witness === undefined ||
					witness.workflowId !== input.workflowId ||
					witness.bindingDigest !== input.expectedBindingDigest
				)
					throw new Error("loader receipt has no matching durable consumption witness");
				return structuredClone(witness);
			},
		},
		principalAuthorizer: {
			authorize: async () => {
				throw new Error("Skill snapshot fixture has no capability receipt authority.");
			},
		},
	};
}

function createConsumptionWitness(
	input: Parameters<WorkflowSkillDurableInvocationStore["consume"]>[0],
): WorkflowSkillInvocationConsumptionWitness {
	const unsigned = {
		...input,
		keyId: "consume-key",
		signatureAlgorithm: "ed25519" as const,
		signature: "",
		trustedNow: input.trustedNow,
		consumedAt: input.trustedNow,
		consumptionSequence: 1,
	};
	const { signature: _signature, ...signedValue } = unsigned;
	return {
		...unsigned,
		signature: signBytes(null, Buffer.from(canonicalJsonBytes(signedValue)), CONSUME_PRIVATE_KEY).toString("base64"),
	};
}

function createExecutionClaimWitness(input: WorkflowSkillExecutionClaimInput): WorkflowSkillExecutionClaimWitness {
	const unsigned = {
		...input,
		claimKind: "workflow-skill-execution" as const,
		keyId: "consume-key",
		signatureAlgorithm: "ed25519" as const,
		claimedAt: input.trustedNow,
		claimSequence: 1,
		signature: "",
	};
	const { signature: _signature, ...signedValue } = unsigned;
	return {
		...unsigned,
		signature: signBytes(null, Buffer.from(canonicalJsonBytes(signedValue)), CONSUME_PRIVATE_KEY).toString("base64"),
	};
}

function createArtifactFixture(): ArtifactFixture {
	const bytesByDigest = new Map<string, Uint8Array>();
	const metadataByDigest = new Map<string, PublishedArtifact[]>();
	const records: PublishedArtifact[] = [];
	const resolver: WorkflowArtifactResolver = {
		resolve: async (ref): Promise<WorkflowArtifactReadResult> => {
			const bytes = bytesByDigest.get(ref.digest);
			const metadata = metadataByDigest
				.get(ref.digest)
				?.find((candidate) => candidate.ref.artifactId === ref.artifactId);
			if (bytes === undefined || metadata === undefined) throw new Error("artifact_missing");
			return {
				envelope: { ref: metadata.ref, payloadKind: metadata.payloadKind, codec: metadata.codec, immutable: true },
				exists: true,
				bytes: Uint8Array.from(bytes),
				verifiedDigest: sha256Hex(bytes),
				verifiedSizeBytes: bytes.byteLength,
			};
		},
	};
	const publisher: WorkflowArtifactPublisher = {
		publish: async (input) => {
			const digest = sha256Hex(input.bytes);
			bytesByDigest.set(digest, Uint8Array.from(input.bytes));
			const ref: WorkflowArtifactRef = {
				artifactId: input.idempotencyKey,
				relativePath: `artifacts/skills/${digest}`,
				digest,
				sizeBytes: input.bytes.byteLength,
				sourceEventSequence: input.sourceEventSequence,
			};
			const metadataRecords = metadataByDigest.get(digest) ?? [];
			const record = {
				bytes: Uint8Array.from(input.bytes),
				payloadKind: input.payloadKind,
				codec: input.codec,
				ref,
			};
			metadataRecords.push(record);
			records.push(record);
			metadataByDigest.set(digest, metadataRecords);
			return {
				status: "published",
				envelope: { ref, payloadKind: input.payloadKind, codec: input.codec, immutable: true },
			};
		},
	};
	function seed(
		ref: WorkflowArtifactRef,
		bytes: Uint8Array,
		payloadKind: WorkflowArtifactPayloadKind,
		codec: WorkflowArtifactCodec,
	): void {
		bytesByDigest.set(ref.digest, Uint8Array.from(bytes));
		const metadataRecords = metadataByDigest.get(ref.digest) ?? [];
		const record = { bytes: Uint8Array.from(bytes), payloadKind, codec, ref: { ...ref } };
		metadataRecords.push(record);
		records.push(record);
		metadataByDigest.set(ref.digest, metadataRecords);
	}
	return { resolver, publisher, bytesByDigest, records, seed };
}

function createProvenance(
	workflowId: string,
	workspaceDigest: string,
	loaderResult: WorkflowResourceLoaderResult,
): WorkflowResourceLoaderProvenance {
	const digests = getWorkflowResourceLoaderProvenanceDigests(loaderResult, 1);
	return {
		issuedBy: "ResourceLoader",
		issuanceReceipt: createReceipt(workflowId, workspaceDigest, digests.loaderResultDigest),
		loaderRevision: 1,
		workspaceDigest,
		sourceManifestDigest: digests.sourceManifestDigest,
		diagnosticsDigest: digests.diagnosticsDigest,
		artifactPathDigest: digests.artifactPathDigest,
		loaderResultDigest: digests.loaderResultDigest,
		artifactNamespace: "artifacts/skills",
	};
}

async function createFixtureSkill(body: string, kind: "markdown" | "python" = "markdown"): Promise<Skill> {
	const directory = await mkdtemp(join(tmpdir(), "workflow-skill-"));
	const filePath = join(directory, "SKILL.md");
	await writeFile(filePath, body, "utf8");
	const base = {
		name: "fixture",
		description: "fixture skill",
		filePath,
		baseDir: directory,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test", scope: "temporary", baseDir: directory }),
		disableModelInvocation: false,
	};
	if (kind === "python") {
		await writeFile(join(directory, "pyproject.toml"), '[project]\nname = "fixture"\n', "utf8");
		await mkdir(join(directory, "src", "fixture"), { recursive: true });
		await writeFile(join(directory, "src", "fixture", "__init__.py"), "VALUE = 1\n", "utf8");
		return {
			...base,
			kind,
			python: {
				importName: "fixture",
				packagePath: directory,
				pyprojectPath: join(directory, "pyproject.toml"),
			},
		};
	}
	return { ...base, kind };
}

function createInvocationStore(): WorkflowSkillInvocationStore & { calls: number } {
	let calls = 0;
	return {
		durability: "test",
		get calls(): number {
			return calls;
		},
		consume: async (input) => {
			calls += 1;
			return input.consumeSequence === 1 && calls === 1;
		},
	};
}

function createActiveHostStateReader(
	state: WorkflowSkillActiveHostState = {
		workflowId: "wf-1",
		epochRef: EPOCH,
		journalHeadDigest: "head-1",
	},
): WorkflowSkillActiveHostStateReader {
	return {
		read: async () => structuredClone(state),
		withExclusiveLease: async (_workflowId, _boundary, operation) => operation(structuredClone(state)),
	};
}

async function writeActiveHostState(
	path: string,
	state: WorkflowSkillActiveHostState = {
		workflowId: "wf-1",
		epochRef: EPOCH,
		journalHeadDigest: "head-1",
	},
): Promise<void> {
	await writeFile(path, JSON.stringify(state), "utf8");
}

async function waitForFile(path: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		try {
			await readFile(path);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	throw new Error(`Timed out waiting for ${path}.`);
}

function createFileActiveHostStateReader(path: string): WorkflowSkillActiveHostStateReader {
	return {
		read: async () => JSON.parse(await readFile(path, "utf8")) as WorkflowSkillActiveHostState,
		withExclusiveLease: async (_workflowId, _boundary, operation) => {
			const before = JSON.parse(await readFile(path, "utf8")) as WorkflowSkillActiveHostState;
			const result = await operation(before);
			const after = JSON.parse(await readFile(path, "utf8")) as WorkflowSkillActiveHostState;
			if (digestObject(before) !== digestObject(after))
				throw new Error("active durable host state changed during exclusive lease");
			return result;
		},
	};
}

function createLeaseStateReader(
	readState: WorkflowSkillActiveHostState,
	leaseState: WorkflowSkillActiveHostState,
): WorkflowSkillActiveHostStateReader {
	return {
		read: async () => structuredClone(readState),
		withExclusiveLease: async (_workflowId, _boundary, operation) => operation(structuredClone(leaseState)),
	};
}

function createDurableBooleanStore(): WorkflowSkillInvocationStore {
	return {
		durability: "durable",
		activeHostState: createActiveHostStateReader(),
		consume: async () => true,
	};
}

function createDurableWitnessStore(): WorkflowSkillDurableInvocationStore {
	let consumed = false;
	return {
		durability: "durable",
		activeHostState: createActiveHostStateReader(),
		consume: async (input) => {
			if (consumed) throw new Error("durable consume CAS rejected replay");
			consumed = true;
			return createConsumptionWitness(input);
		},
		claimExecution: async (input) => createExecutionClaimWitness(input),
	};
}

function createDescriptorDurableWitnessStore(
	root: string,
	activeHostState: WorkflowSkillActiveHostStateReader = createActiveHostStateReader(),
): WorkflowSkillDurableInvocationStore & { readonly calls: number } {
	let calls = 0;
	const durableStore = createWorkflowSkillDescriptorInvocationStore({
		descriptorFs: createNodeWorkflowDescriptorFs(),
		rootPath: root,
		activeHostState,
		signer: {
			keyId: "consume-key",
			signatureAlgorithm: "ed25519",
			sign: async (bytes) => signBytes(null, Buffer.from(bytes), CONSUME_PRIVATE_KEY).toString("base64"),
		},
	});
	return {
		...durableStore,
		get calls(): number {
			return calls;
		},
		consume: async (input) => {
			calls += 1;
			return durableStore.consume(input);
		},
	};
}

function runDescriptorValidationWorker(input: {
	rootPath: string;
	activeStatePath: string;
	snapshot: WorkflowSkillSnapshot;
	token: string;
	current: Omit<Parameters<typeof validateAndConsumeSkillInvocation>[4], "loader" | "receiptContext">;
	records: readonly PublishedArtifact[];
	privateKey: string;
	loaderPublicKey: string;
	consumePublicKey: string;
}): Promise<number> {
	const script = `
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createNodeWorkflowDescriptorFs } from "./src/core/workflow/node-descriptor-fs.ts";
import { canonicalJsonBytes, digestObject, sha256Hex } from "./src/core/workflow/contracts.ts";
import { createWorkflowSkillDescriptorInvocationStore, validateAndConsumeSkillInvocation } from "./src/core/workflow/skill-snapshots.ts";
const input = JSON.parse(process.argv[1]);
const privateKey = createPrivateKey(input.privateKey);
const loaderPublicKey = createPublicKey(input.loaderPublicKey);
const consumePublicKey = createPublicKey(input.consumePublicKey);
const loaderWitness = input.snapshot.loaderReceiptConsumptionWitness;
const records = input.records;
const artifacts = {
  resolve: async (ref) => {
    const record = records.find((candidate) => candidate.ref.artifactId === ref.artifactId && candidate.ref.digest === ref.digest);
    if (!record) throw new Error("artifact_missing");
    const bytes = Uint8Array.from(Buffer.from(record.bytes, "base64"));
    return {
      envelope: { ref: record.ref, payloadKind: record.payloadKind, codec: record.codec, immutable: true },
      exists: true,
      bytes,
      verifiedDigest: sha256Hex(bytes),
      verifiedSizeBytes: bytes.byteLength,
    };
  },
};
const keyResolver = {
  resolve: async (keyId) => {
    const publicKey = keyId === "loader-key" ? loaderPublicKey : keyId === "consume-key" ? consumePublicKey : null;
    if (!publicKey) throw new Error("unknown receipt verification key");
    const generationId = "skill-snapshot-subprocess-generation";
    const epochRef = input.current.epochRef;
    return {
      algorithm: "ed25519",
      ownerPrincipal: keyId === "loader-key" ? "ResourceLoader" : "consume-host",
      allowedCapabilities: new Set(),
      generationId,
      epochRef,
      fencingDigest: digestObject({ generationId, epochRef }),
      revoked: false,
      verify: ({ bytes, signature }) => verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature, "base64")),
    };
  },
};
const receiptContext = {
  artifactResolver: artifacts,
  revokedReceiptIds: new Set(),
  keyResolver,
  principalAuthorizer: { authorize: async () => { throw new Error("capability authorization is not used by this fixture"); } },
  receiptResolver: {
    resolve: async (receiptInput) => {
      const key = await keyResolver.resolve(receiptInput.receipt.keyId);
      const { signature: _signature, verificationDigest: _verificationDigest, ...signedFields } = receiptInput.receipt;
      const issuedAt = Date.parse(receiptInput.receipt.issuedAt);
      const validUntil = Date.parse(receiptInput.receipt.validUntil);
      if (
        receiptInput.revokedReceiptIds.has(receiptInput.receipt.receiptId) ||
        receiptInput.receipt.workflowId !== receiptInput.workflowId ||
        receiptInput.receipt.bindingDigest !== receiptInput.expectedBindingDigest ||
        receiptInput.receipt.stateDigest !== receiptInput.currentStateDigest ||
        receiptInput.receipt.revision !== receiptInput.currentRevision ||
        !Number.isFinite(issuedAt) ||
        !Number.isFinite(validUntil) ||
        Date.parse(receiptInput.trustedNow) < issuedAt ||
        Date.parse(receiptInput.trustedNow) >= validUntil ||
        receiptInput.receipt.artifactBytesDigest !== sha256Hex(receiptInput.artifactBytes) ||
        receiptInput.receipt.verificationDigest !== digestObject({ ...receiptInput.receipt, verificationDigest: "" }) ||
        !key.verify({ bytes: canonicalJsonBytes(signedFields), signature: receiptInput.receipt.signature })
      ) throw new Error("untrusted loader receipt");
      return structuredClone(receiptInput.receipt);
    },
    consumeIfOneUse: async () => undefined,
    resolveConsumptionWitness: async (witnessInput) => {
      if (
        loaderWitness.receiptId !== witnessInput.receiptId ||
        loaderWitness.workflowId !== witnessInput.workflowId ||
        loaderWitness.bindingDigest !== witnessInput.expectedBindingDigest
      ) throw new Error("loader receipt witness binding mismatch");
      return loaderWitness;
    },
  },
};
const skill = {
  name: input.snapshot.skillName,
  description: "fixture skill",
  kind: input.snapshot.skillKind,
  filePath: input.snapshot.canonicalPath,
  baseDir: input.snapshot.canonicalBaseDir,
  sourceInfo: input.snapshot.sourceInfo,
  disableModelInvocation: input.snapshot.disableModelInvocation,
};
const loader = { getSkills: () => ({ skills: [skill], diagnostics: [] }) };
const store = createWorkflowSkillDescriptorInvocationStore({
  descriptorFs: createNodeWorkflowDescriptorFs(),
  rootPath: input.rootPath,
  activeHostState: {
    read: async () => JSON.parse(await readFile(input.activeStatePath, "utf8")),
    withExclusiveLease: async (_workflowId, _boundary, operation) => {
      const before = JSON.parse(await readFile(input.activeStatePath, "utf8"));
      const result = await operation(before);
      const after = JSON.parse(await readFile(input.activeStatePath, "utf8"));
      if (digestObject(before) !== digestObject(after)) throw new Error("active durable host state changed during exclusive lease");
      return result;
    },
  },
  signer: {
    keyId: "consume-key",
    signatureAlgorithm: "ed25519",
    sign: async (bytes) => sign(null, Buffer.from(bytes), privateKey).toString("base64"),
  },
});
validateAndConsumeSkillInvocation(input.snapshot, input.token, store, artifacts, {
  ...input.current,
  loader,
  receiptContext,
})
  .then(() => process.exit(0))
  .catch((error) => process.exit(
    /active durable host state|stale|foreign|epoch|journal head/i.test(error?.message ?? "") ? 18 :
    /replay|CAS|consume/i.test(error?.message ?? "") ? 17 : 1,
  ));
`;
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				join(process.cwd(), "../../node_modules/tsx/dist/loader.mjs"),
				"--input-type=module",
				"-e",
				script,
				JSON.stringify({
					...input,
					records: input.records.map((record) => ({
						...record,
						bytes: Buffer.from(record.bytes).toString("base64"),
					})),
				}),
			],
			{ cwd: process.cwd(), stdio: "ignore" },
		);
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});
}

function runDescriptorExecutionWorker(input: {
	rootPath: string;
	activeStatePath: string;
	executionStartedPath?: string;
	executionReleasePath?: string;
	snapshot: WorkflowSkillSnapshot;
	admission: WorkflowSkillInvocationAdmission;
	current: Omit<Parameters<typeof validateAndConsumeSkillInvocation>[4], "loader" | "receiptContext">;
	records: readonly PublishedArtifact[];
	privateKey: string;
	loaderPublicKey: string;
	consumePublicKey: string;
}): Promise<number> {
	const script = `
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createNodeWorkflowDescriptorFs } from "./src/core/workflow/node-descriptor-fs.ts";
import { canonicalJsonBytes, digestObject, sha256Hex } from "./src/core/workflow/contracts.ts";
import {
  createWorkflowSkillDescriptorInvocationStore,
  createWorkflowSkillExecutionVerificationContext,
  createWorkflowSkillHostAdapter,
  executeWorkflowSkillInvocation,
} from "./src/core/workflow/skill-snapshots.ts";
const input = JSON.parse(process.argv[1]);
const freezeDeep = (value) => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
};
const snapshot = freezeDeep(input.snapshot);
const admission = freezeDeep(input.admission);
const privateKey = createPrivateKey(input.privateKey);
const loaderPublicKey = createPublicKey(input.loaderPublicKey);
const consumePublicKey = createPublicKey(input.consumePublicKey);
const loaderWitness = snapshot.loaderReceiptConsumptionWitness;
const records = input.records;
const artifacts = {
  resolve: async (ref) => {
    const record = records.find((candidate) => candidate.ref.artifactId === ref.artifactId && candidate.ref.digest === ref.digest);
    if (!record) throw new Error("artifact_missing");
    const bytes = Uint8Array.from(Buffer.from(record.bytes, "base64"));
    return {
      envelope: { ref: record.ref, payloadKind: record.payloadKind, codec: record.codec, immutable: true },
      exists: true,
      bytes,
      verifiedDigest: sha256Hex(bytes),
      verifiedSizeBytes: bytes.byteLength,
    };
  },
};
const keyResolver = {
  resolve: async (keyId) => {
    const publicKey = keyId === "loader-key" ? loaderPublicKey : keyId === "consume-key" ? consumePublicKey : null;
    if (!publicKey) throw new Error("unknown receipt verification key");
    const generationId = "skill-snapshot-subprocess-generation";
    const epochRef = input.current.epochRef;
    return {
      algorithm: "ed25519",
      ownerPrincipal: keyId === "loader-key" ? "ResourceLoader" : "consume-host",
      allowedCapabilities: new Set(),
      generationId,
      epochRef,
      fencingDigest: digestObject({ generationId, epochRef }),
      revoked: false,
      verify: ({ bytes, signature }) => verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature, "base64")),
    };
  },
};
const receiptContext = {
  artifactResolver: artifacts,
  revokedReceiptIds: new Set(),
  keyResolver,
  principalAuthorizer: { authorize: async () => { throw new Error("capability authorization is not used by this fixture"); } },
  receiptResolver: {
    resolve: async (receiptInput) => {
      const key = await keyResolver.resolve(receiptInput.receipt.keyId);
      const { signature: _signature, verificationDigest: _verificationDigest, ...signedFields } = receiptInput.receipt;
      const issuedAt = Date.parse(receiptInput.receipt.issuedAt);
      const validUntil = Date.parse(receiptInput.receipt.validUntil);
      if (
        receiptInput.revokedReceiptIds.has(receiptInput.receipt.receiptId) ||
        receiptInput.receipt.workflowId !== receiptInput.workflowId ||
        receiptInput.receipt.bindingDigest !== receiptInput.expectedBindingDigest ||
        receiptInput.receipt.stateDigest !== receiptInput.currentStateDigest ||
        receiptInput.receipt.revision !== receiptInput.currentRevision ||
        !Number.isFinite(issuedAt) ||
        !Number.isFinite(validUntil) ||
        Date.parse(receiptInput.trustedNow) < issuedAt ||
        Date.parse(receiptInput.trustedNow) >= validUntil ||
        receiptInput.receipt.artifactBytesDigest !== sha256Hex(receiptInput.artifactBytes) ||
        receiptInput.receipt.verificationDigest !== digestObject({ ...receiptInput.receipt, verificationDigest: "" }) ||
        !key.verify({ bytes: canonicalJsonBytes(signedFields), signature: receiptInput.receipt.signature })
      ) throw new Error("untrusted loader receipt");
      return structuredClone(receiptInput.receipt);
    },
    consumeIfOneUse: async () => undefined,
    resolveConsumptionWitness: async (witnessInput) => {
      if (
        loaderWitness.receiptId !== witnessInput.receiptId ||
        loaderWitness.workflowId !== witnessInput.workflowId ||
        loaderWitness.bindingDigest !== witnessInput.expectedBindingDigest
      ) throw new Error("loader receipt witness binding mismatch");
      return loaderWitness;
    },
  },
};
const skill = {
  name: snapshot.skillName,
  description: "fixture skill",
  kind: snapshot.skillKind,
  filePath: snapshot.canonicalPath,
  baseDir: snapshot.canonicalBaseDir,
  sourceInfo: snapshot.sourceInfo,
  disableModelInvocation: snapshot.disableModelInvocation,
};
const loader = { getSkills: () => ({ skills: [skill], diagnostics: [] }) };
const store = createWorkflowSkillDescriptorInvocationStore({
  descriptorFs: createNodeWorkflowDescriptorFs(),
  rootPath: input.rootPath,
  activeHostState: {
    read: async () => JSON.parse(await readFile(input.activeStatePath, "utf8")),
    withExclusiveLease: async (_workflowId, _boundary, operation) => {
      const before = JSON.parse(await readFile(input.activeStatePath, "utf8"));
      const result = await operation(before);
      const after = JSON.parse(await readFile(input.activeStatePath, "utf8"));
      if (digestObject(before) !== digestObject(after)) throw new Error("active durable host state changed during exclusive lease");
      return result;
    },
  },
  signer: {
    keyId: "consume-key",
    signatureAlgorithm: "ed25519",
    sign: async (bytes) => sign(null, Buffer.from(bytes), privateKey).toString("base64"),
  },
});
const host = createWorkflowSkillHostAdapter({
  loader,
  loaderProvenance: snapshot.loaderProvenance,
  artifacts,
  publisher: { publish: async () => { throw new Error("unused"); } },
  receiptContext,
  invocationStore: store,
});
const current = {
  ...input.current,
  loader,
  receiptContext,
};
const verification = createWorkflowSkillExecutionVerificationContext(host, snapshot, current);
executeWorkflowSkillInvocation(admission, { execute: async () => {
  if (input.executionStartedPath) await writeFile(input.executionStartedPath, "started", "utf8");
  if (input.executionReleasePath) {
    for (;;) {
      try {
        await readFile(input.executionReleasePath, "utf8");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }
  return "executed";
} }, verification)
  .then(() => process.exit(0))
  .catch((error) => process.exit(
    /active durable host state|stale|foreign|epoch|journal head/i.test(error?.message ?? "") ? 18 :
    /replay|CAS|claim/i.test(error?.message ?? "") ? 17 : 1,
  ));
`;
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				join(process.cwd(), "../../node_modules/tsx/dist/loader.mjs"),
				"--input-type=module",
				"-e",
				script,
				JSON.stringify({
					...input,
					records: input.records.map((record) => ({
						...record,
						bytes: Buffer.from(record.bytes).toString("base64"),
					})),
				}),
			],
			{ cwd: process.cwd(), stdio: "ignore" },
		);
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});
}

const ADMISSION_MANIFEST_BYTES = new TextEncoder().encode(
	'{"allowedTransitions":["start"],"requiredApprovalGates":["user"],"requiredArtifactKinds":["evidence"],"requiredPressureTests":["red-team"]}',
);

function createAdmissionManifest(): WorkflowSkillManifestSource {
	return {
		artifactRef: {
			artifactId: "manifest-1",
			relativePath: "artifacts/skills/manifest",
			digest: sha256Hex(ADMISSION_MANIFEST_BYTES),
			sizeBytes: ADMISSION_MANIFEST_BYTES.byteLength,
			sourceEventSequence: 1,
		},
		bytes: ADMISSION_MANIFEST_BYTES,
		contentDigest: sha256Hex(ADMISSION_MANIFEST_BYTES),
	};
}

function freezeFixtureDeep<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) freezeFixtureDeep(child);
	return Object.freeze(value);
}

async function createSnapshot(
	body = "skill body",
	dependencyNames: readonly string[] = ["dep-a"],
	skillOverride?: Skill,
	resolverDecorator?: (resolver: WorkflowArtifactResolver) => WorkflowArtifactResolver,
	sourceProvenanceFactory?: (skill: Skill, artifacts: ArtifactFixture) => Promise<WorkflowSkillSourceProvenance>,
	receiptMutator?: (receipt: WorkflowVerifiedHostReceipt) => WorkflowVerifiedHostReceipt,
	includeManifest = true,
	dependencySourcePath?: string,
	loaderOverride?: WorkflowResourceLoaderPort,
	receiptContextDecorator?: (context: WorkflowHostReceiptConsumerContext) => WorkflowHostReceiptConsumerContext,
	contextOverrides?: {
		decisionRef?: WorkflowDecisionRef;
		epochRef?: WorkflowEpochRef;
		dependencyBytesOverride?: unknown;
		manifestGateFields?: {
			requiredApprovalGates: readonly string[];
			requiredArtifactKinds: readonly string[];
			requiredPressureTests: readonly string[];
			allowedTransitions: readonly string[];
		};
	},
): Promise<{
	snapshot: WorkflowSkillSnapshot;
	artifacts: ArtifactFixture;
	loader: WorkflowResourceLoaderPort;
	skill: Skill;
	receiptContext: WorkflowHostReceiptConsumerContext;
	trustedNow: string;
	builtinProvenanceContext?: WorkflowSkillBuiltinProvenanceContext;
}> {
	const workflowId = "wf-1";
	const workspaceDigest = "workspace-1";
	const skill = skillOverride ?? (await createFixtureSkill(body));
	const dependencies: WorkflowSkillDependency[] = dependencyNames.map((name, index) => {
		const declaredBytes = new TextEncoder().encode(name);
		const bytes =
			contextOverrides?.dependencyBytesOverride === undefined
				? declaredBytes
				: (contextOverrides.dependencyBytesOverride as Readonly<Uint8Array>);
		const artifactBytes =
			contextOverrides?.dependencyBytesOverride === undefined
				? declaredBytes
				: Uint8Array.from(contextOverrides.dependencyBytesOverride as ArrayLike<number>);
		return {
			name,
			artifactRef: {
				artifactId: name,
				relativePath: `artifacts/skills/dependencies/${name}`,
				digest: sha256Hex(artifactBytes),
				sizeBytes: artifactBytes.byteLength,
				sourceEventSequence: 1,
			},
			bytes,
			contentDigest: sha256Hex(artifactBytes),
			sourcePath: index === 0 ? dependencySourcePath : undefined,
		};
	});
	const manifestGateFields = contextOverrides?.manifestGateFields ?? {
		requiredApprovalGates: ["user"],
		requiredArtifactKinds: ["evidence"],
		requiredPressureTests: ["red-team"],
		allowedTransitions: ["start"],
	};
	const manifestBytes = canonicalJsonBytes(manifestGateFields);
	const artifacts = createArtifactFixture();
	for (const dependency of dependencies) {
		artifacts.seed(dependency.artifactRef, Uint8Array.from(dependency.bytes), "evidence", "binary");
	}
	artifacts.seed(
		{
			artifactId: "manifest-1",
			relativePath: "artifacts/skills/manifest",
			digest: sha256Hex(manifestBytes),
			sizeBytes: manifestBytes.byteLength,
			sourceEventSequence: 1,
		},
		manifestBytes,
		"evidence",
		"canonical_json",
	);
	const loader: WorkflowResourceLoaderPort = loaderOverride ?? {
		getSkills: () => ({ skills: [skill], diagnostics: [] }),
	};
	const loaderResult = loader.getSkills();
	const baseLoaderProvenance = createProvenance(workflowId, workspaceDigest, loaderResult);
	const loaderProvenance = {
		...baseLoaderProvenance,
		issuanceReceipt: receiptMutator?.(baseLoaderProvenance.issuanceReceipt) ?? baseLoaderProvenance.issuanceReceipt,
	};
	artifacts.seed(
		loaderProvenance.issuanceReceipt.artifactRef,
		new TextEncoder().encode("loader-receipt"),
		"evidence",
		"binary",
	);
	const resolver = resolverDecorator?.(artifacts.resolver) ?? artifacts.resolver;
	const receiptContext = receiptContextDecorator?.(createReceiptContext(resolver)) ?? createReceiptContext(resolver);
	const sourceProvenance =
		sourceProvenanceFactory === undefined ? undefined : await sourceProvenanceFactory(skill, artifacts);
	const builtinProvenanceContext =
		sourceProvenance?.builtin === undefined
			? undefined
			: {
					artifactResolver: resolver,
					keyResolver: receiptContext.keyResolver,
					revokedEventIds: new Set<string>(),
					hostCatalog: {
						vendoredRoot: sourceProvenance.builtin.vendoredRoot,
						registryArtifactRef: sourceProvenance.builtin.registryArtifactRef,
						sourceManifestArtifactRef: sourceProvenance.builtin.sourceManifestArtifactRef,
					},
				};
	const snapshot = await createSkillSnapshot({
		workflowId,
		taskId: "task-1",
		decisionRef: contextOverrides?.decisionRef ?? DECISION_REF,
		journalHeadDigest: "head-1",
		skill,
		dependencies,
		manifest: includeManifest
			? {
					artifactRef: {
						artifactId: "manifest-1",
						relativePath: "artifacts/skills/manifest",
						digest: sha256Hex(manifestBytes),
						sizeBytes: manifestBytes.byteLength,
						sourceEventSequence: 1,
					},
					bytes: manifestBytes,
					contentDigest: sha256Hex(manifestBytes),
				}
			: null,
		artifacts: resolver,
		publisher: artifacts.publisher,
		workflowContractRevision: 1,
		configDigest: "config-1",
		workspaceDigest,
		attemptId: "attempt-1",
		loader,
		loaderProvenance,
		receiptContext,
		trustedNow: TRUSTED_NOW,
		sourceProvenance,
		builtinProvenanceContext,
		epochRef: contextOverrides?.epochRef ?? EPOCH,
		sourceEventSequence: 1,
	});
	return { snapshot, artifacts, loader, skill, receiptContext, trustedNow: TRUSTED_NOW, builtinProvenanceContext };
}

function productionInvocationContext(
	snapshot: WorkflowSkillSnapshot,
	loader: WorkflowResourceLoaderPort,
	receiptContext: WorkflowHostReceiptConsumerContext,
	trustedNow = TRUSTED_NOW,
): Parameters<typeof validateAndConsumeSkillInvocation>[4] {
	return {
		workflowId: "wf-1",
		taskId: "task-1",
		decisionRef: DECISION_REF,
		configDigest: "config-1",
		workspaceDigest: "workspace-1",
		attemptId: "attempt-1",
		epochRef: EPOCH,
		dependencyManifestDigest: snapshot.dependencyManifestDigest,
		loader,
		workflowContractRevision: 1,
		receiptContext,
		trustedNow,
		journalHeadDigest: "head-1",
	} as Parameters<typeof validateAndConsumeSkillInvocation>[4];
}

describe("workflow skill snapshots", () => {
	it("pins immutable content, dependency digests, and machine-readable gate metadata", async () => {
		const { snapshot } = await createSnapshot();

		expect(snapshot.contentDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(snapshot.dependencyManifestDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(snapshot.manifest?.requiredApprovalGates).toEqual(["user"]);
		expect(snapshot.artifactRef.relativePath).toMatch(/^artifacts\/skills\//);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.dependencyRefs)).toBe(true);
	});

	it("changes the immutable snapshot and rejects the old token when a dependency changes", async () => {
		const first = await createSnapshot("skill body", ["dep-a"]);
		const changed = await createSnapshot("skill body", ["dep-b"]);
		expect(changed.snapshot.contentDigest).toBe(first.snapshot.contentDigest);
		expect(changed.snapshot.dependencyDigests).not.toEqual(first.snapshot.dependencyDigests);
		expect(changed.snapshot.snapshotDigest).not.toBe(first.snapshot.snapshotDigest);

		await expect(
			validateAndConsumeSkillInvocation(
				changed.snapshot,
				getSkillInvocationToken(first.snapshot),
				createInvocationStore(),
				changed.artifacts.resolver,
				{
					workflowId: "wf-1",
					taskId: "task-1",
					decisionRef: DECISION_REF,
					configDigest: "config-1",
					workspaceDigest: "workspace-1",
					attemptId: "attempt-1",
					epochRef: EPOCH,
					dependencyManifestDigest: first.snapshot.dependencyManifestDigest,
					loader: changed.loader,
					workflowContractRevision: 1,
					receiptContext: changed.receiptContext,
					trustedNow: changed.trustedNow,
					journalHeadDigest: "head-1",
				},
				{ allowTestStore: true },
			),
		).rejects.toThrow(/token|snapshot/i);
	});

	it("consumes a valid invocation token once and fails closed on reuse", async () => {
		const { snapshot, artifacts, loader, receiptContext, trustedNow } = await createSnapshot();
		const store = createInvocationStore();
		const current = {
			workflowId: "wf-1",
			taskId: "task-1",
			decisionRef: DECISION_REF,
			configDigest: "config-1",
			workspaceDigest: "workspace-1",
			attemptId: "attempt-1",
			epochRef: EPOCH,
			dependencyManifestDigest: snapshot.dependencyManifestDigest,
			loader,
			workflowContractRevision: 1,
			receiptContext,
			trustedNow,
			journalHeadDigest: "head-1",
		};

		await expect(
			validateAndConsumeSkillInvocation(
				snapshot,
				getSkillInvocationToken(snapshot),
				store,
				artifacts.resolver,
				current,
				{ allowTestStore: true },
			),
		).resolves.toBeUndefined();
		await expect(
			validateAndConsumeSkillInvocation(
				snapshot,
				getSkillInvocationToken(snapshot),
				store,
				artifacts.resolver,
				current,
				{ allowTestStore: true },
			),
		).rejects.toThrow(/metadata|consume|token/i);
		expect(store.calls).toBe(2);
	});

	it("returns a production admission contract bound to the durable consumption witness", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		const casRoot = await mkdtemp(join(tmpdir(), "workflow-skill-service-cas-"));
		try {
			const invocationStore = createDescriptorDurableWitnessStore(casRoot);
			const hostAdapter = createWorkflowSkillHostAdapter({
				loader,
				loaderProvenance: snapshot.loaderProvenance,
				artifacts: artifacts.resolver,
				publisher: artifacts.publisher,
				receiptContext,
				invocationStore,
			});
			expect(hostAdapter.invocationStore).not.toBe(invocationStore);
			expect(Object.isFrozen(hostAdapter.invocationStore)).toBe(true);
			expect(Object.isFrozen(hostAdapter.invocationStore.activeHostState)).toBe(true);
			expect(hostAdapter.loader).not.toBe(loader);
			expect(hostAdapter.artifacts).not.toBe(artifacts.resolver);
			expect(hostAdapter.receiptContext).not.toBe(receiptContext);
			expect(hostAdapter.receiptContext.keyResolver).not.toBe(receiptContext.keyResolver);
			expect(hostAdapter.receiptContext.receiptResolver).not.toBe(receiptContext.receiptResolver);
			expect(Object.isFrozen(hostAdapter.loader)).toBe(true);
			expect(Object.isFrozen(hostAdapter.artifacts)).toBe(true);
			expect(Object.isFrozen(hostAdapter.receiptContext)).toBe(true);
			expect(Object.isFrozen(hostAdapter.receiptContext.keyResolver)).toBe(true);
			expect(Object.isFrozen(hostAdapter.receiptContext.revokedReceiptIds)).toBe(true);
			const originalGetSkills = loader.getSkills;
			const originalResolveArtifact = artifacts.resolver.resolve;
			const originalResolveKey = receiptContext.keyResolver.resolve;
			const originalResolveReceipt = receiptContext.receiptResolver.resolve;
			loader.getSkills = () => ({ skills: [], diagnostics: [] });
			artifacts.resolver.resolve = async () => {
				throw new Error("caller-mutated artifact resolver");
			};
			receiptContext.keyResolver.resolve = async () => {
				throw new Error("caller-mutated key resolver");
			};
			receiptContext.receiptResolver.resolve = async () => {
				throw new Error("caller-mutated receipt resolver");
			};
			(receiptContext.revokedReceiptIds as Set<string>).add(snapshot.hostVerificationReceipt.receiptId);
			expect(hostAdapter.receiptContext.revokedReceiptIds.has(snapshot.hostVerificationReceipt.receiptId)).toBe(
				false,
			);
			const productionAdapter = createWorkflowSkillProductionExecutionAdapter(hostAdapter);
			const admission = await productionAdapter.validateAndConsume(
				snapshot,
				getSkillInvocationToken(snapshot),
				productionInvocationContext(snapshot, loader, receiptContext),
			);
			loader.getSkills = originalGetSkills;
			artifacts.resolver.resolve = originalResolveArtifact;
			receiptContext.keyResolver.resolve = originalResolveKey;
			receiptContext.receiptResolver.resolve = originalResolveReceipt;
			(receiptContext.revokedReceiptIds as Set<string>).delete(snapshot.hostVerificationReceipt.receiptId);

			expect(admission).toMatchObject({
				status: "admitted",
				workflowId: "wf-1",
				taskId: "task-1",
				decisionRef: DECISION_REF,
				attemptId: "attempt-1",
				skillName: "fixture",
				skillKind: "markdown",
				disableModelInvocation: false,
				snapshotDigest: snapshot.snapshotDigest,
				invocationTokenId: snapshot.invocationTokenId,
				journalHeadDigest: "head-1",
				trustedNow: TRUSTED_NOW,
				requiredApprovalGates: ["user"],
				requiredArtifactKinds: ["evidence"],
				requiredPressureTests: ["red-team"],
				allowedTransitions: ["start"],
				consumptionWitness: expect.objectContaining({
					keyId: "consume-key",
					trustedNow: TRUSTED_NOW,
				}),
				artifacts: {
					source: { ref: snapshot.sourceArtifactRef, bytes: expect.any(Array) },
					dependencies: expect.any(Array),
					packageFiles: expect.any(Array),
					manifest: expect.any(Object),
				},
			});
			if (admission === undefined) throw new Error("durable admission was not returned");
			const executionVerification = createWorkflowSkillExecutionVerificationContext(
				hostAdapter,
				snapshot,
				productionInvocationContext(snapshot, loader, receiptContext),
			);
			expect(Object.isFrozen(admission)).toBe(true);
			expect(Object.isFrozen(admission.artifacts)).toBe(true);
			expect(Object.isFrozen(admission.artifacts.source.bytes)).toBe(true);
			await expect(
				productionAdapter.execute(
					admission,
					snapshot,
					productionInvocationContext(snapshot, loader, receiptContext),
					{
						execute: async (execution) => {
							expect(execution).not.toHaveProperty("filePath");
							expect(execution.artifacts.source.bytes).toEqual(Array.from(admission.artifacts.source.bytes));
							return execution.artifacts.source.ref.digest;
						},
					},
				),
			).resolves.toBe(snapshot.sourceArtifactRef.digest);
			await expect(
				productionAdapter.execute(
					admission,
					snapshot,
					productionInvocationContext(snapshot, loader, receiptContext),
					{ execute: async () => "replayed" },
				),
			).rejects.toThrow(/execution|CAS|replay|claim/i);
			const pendingUnsigned = { ...admission, status: "pending" as const };
			const { admissionDigest: _pendingDigest, ...pendingFields } = pendingUnsigned;
			const pendingAdmission = freezeFixtureDeep({
				...pendingUnsigned,
				admissionDigest: digestObject(pendingFields),
			} as unknown as WorkflowSkillInvocationAdmission);
			expect(() =>
				executeWorkflowSkillInvocation(
					pendingAdmission,
					{ execute: async () => "unreachable" },
					executionVerification,
				),
			).toThrow(/admitted|status/i);
			const shallowFrozenAdmission = Object.freeze({ ...admission, artifacts: { ...admission.artifacts } });
			expect(() =>
				executeWorkflowSkillInvocation(
					shallowFrozenAdmission,
					{
						execute: async () => "unreachable",
					},
					executionVerification,
				),
			).toThrow(/frozen|immutable/i);
			const forgedFrozenAdmission = Object.freeze({ ...admission, skillName: "forged-skill" });
			expect(() =>
				executeWorkflowSkillInvocation(
					forgedFrozenAdmission,
					{
						execute: async () => "unreachable",
					},
					executionVerification,
				),
			).toThrow(/digest|admission|receipt|binding/i);
			const forgedWitnessStore: WorkflowSkillDurableInvocationStore = {
				durability: "durable",
				activeHostState: createActiveHostStateReader(),
				consume: async (input) => ({ ...createConsumptionWitness(input), signature: "forged-witness-signature" }),
				claimExecution: async (input) => createExecutionClaimWitness(input),
			};
			await expect(
				validateAndConsumeSkillInvocation(
					snapshot,
					getSkillInvocationToken(snapshot),
					forgedWitnessStore,
					artifacts.resolver,
					productionInvocationContext(snapshot, loader, receiptContext),
				),
			).rejects.toThrow(/witness|signature|cryptographic/i);
		} finally {
			await rm(casRoot, { recursive: true, force: true });
		}
	});

	it("reissues a consumed invocation against the post-effect durable head", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		const casRoot = await mkdtemp(join(tmpdir(), "workflow-skill-reissue-cas-"));
		const afterLoaderReceiptExpiry = "2026-08-13T00:06:00.000Z";
		let activeState: WorkflowSkillActiveHostState = {
			workflowId: "wf-1",
			epochRef: EPOCH,
			journalHeadDigest: "head-1",
		};
		const activeHostState: WorkflowSkillActiveHostStateReader = {
			read: async () => structuredClone(activeState),
			withExclusiveLease: async (_workflowId, _boundary, operation) => operation(structuredClone(activeState)),
		};
		try {
			const hostAdapter = createWorkflowSkillHostAdapter({
				loader,
				loaderProvenance: snapshot.loaderProvenance,
				artifacts: artifacts.resolver,
				publisher: artifacts.publisher,
				receiptContext,
				invocationStore: createDescriptorDurableWitnessStore(casRoot, activeHostState),
			});
			const productionAdapter = createWorkflowSkillProductionExecutionAdapter(hostAdapter);
			const current = productionInvocationContext(snapshot, loader, receiptContext);
			const admission = await productionAdapter.validateAndConsume(
				snapshot,
				getSkillInvocationToken(snapshot),
				current,
			);
			if (admission === undefined) throw new Error("durable admission was not returned");
			await productionAdapter.execute(admission, snapshot, current, { execute: async () => "first" });
			activeState = { ...activeState, journalHeadDigest: "head-2" };
			const reissued = await productionAdapter.reissueSnapshot(snapshot, {
				consumeSequence: 2,
				trustedNow: afterLoaderReceiptExpiry,
			});
			expect(reissued.journalHeadDigest).toBe("head-2");
			expect(reissued.snapshotDigest).not.toBe(snapshot.snapshotDigest);
			expect(reissued.invocationTokenId).not.toBe(snapshot.invocationTokenId);
			expect(reissued.contentDigest).toBe(snapshot.contentDigest);
			expect(reissued.dependencyManifestDigest).toBe(snapshot.dependencyManifestDigest);
			const rebasedCurrent = {
				...current,
				journalHeadDigest: "head-2",
				trustedNow: afterLoaderReceiptExpiry,
			};
			const rebasedAdmission = await productionAdapter.validateAndConsume(
				reissued,
				getSkillInvocationToken(reissued),
				rebasedCurrent,
			);
			expect(rebasedAdmission?.status).toBe("admitted");
			if (rebasedAdmission === undefined) throw new Error("rebased admission was not returned");
			await productionAdapter.execute(rebasedAdmission, reissued, rebasedCurrent, { execute: async () => "second" });
			await expect(
				productionAdapter.validateAndConsume(snapshot, getSkillInvocationToken(snapshot), current),
			).rejects.toThrow(/stale|replay|CAS|consum/i);
		} finally {
			await rm(casRoot, { recursive: true, force: true });
		}
	});

	it("rejects malformed immutable bytes before the executor receives them", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		const casRoot = await mkdtemp(join(tmpdir(), "workflow-skill-execution-bytes-"));
		try {
			const hostAdapter = createWorkflowSkillHostAdapter({
				loader,
				loaderProvenance: snapshot.loaderProvenance,
				artifacts: artifacts.resolver,
				publisher: artifacts.publisher,
				receiptContext,
				invocationStore: createDescriptorDurableWitnessStore(casRoot),
			});
			const service = createWorkflowSkillSnapshotService(hostAdapter);
			const admission = await service.validateAndConsume(
				snapshot,
				getSkillInvocationToken(snapshot),
				productionInvocationContext(snapshot, loader, receiptContext),
			);
			if (admission === undefined) throw new Error("durable admission was not returned");
			const executionVerification = createWorkflowSkillExecutionVerificationContext(
				hostAdapter,
				snapshot,
				productionInvocationContext(snapshot, loader, receiptContext),
			);
			const forgedSourceBytes = [...admission.artifacts.source.bytes];
			forgedSourceBytes[0] += 256;
			const forgedUnsigned = {
				...admission,
				artifacts: {
					...admission.artifacts,
					source: { ...admission.artifacts.source, bytes: forgedSourceBytes },
				},
			};
			const { admissionDigest: _admissionDigest, ...unsigned } = forgedUnsigned;
			const forgedAdmission = freezeFixtureDeep({
				...forgedUnsigned,
				admissionDigest: digestObject(unsigned),
			});
			expect(() =>
				executeWorkflowSkillInvocation(
					forgedAdmission,
					{ execute: async () => "unreachable" },
					executionVerification,
				),
			).toThrow(/byte|dense|integer|range/i);
		} finally {
			await rm(casRoot, { recursive: true, force: true });
		}
	});

	it("rejects a rotated host epoch and mutable source before claiming execution", async () => {
		const { snapshot, artifacts, loader, skill, receiptContext } = await createSnapshot();
		const casRoot = await mkdtemp(join(tmpdir(), "workflow-skill-execution-rotation-"));
		try {
			const hostAdapter = createWorkflowSkillHostAdapter({
				loader,
				loaderProvenance: snapshot.loaderProvenance,
				artifacts: artifacts.resolver,
				publisher: artifacts.publisher,
				receiptContext,
				invocationStore: createDescriptorDurableWitnessStore(casRoot),
			});
			const admission = await createWorkflowSkillSnapshotService(hostAdapter).validateAndConsume(
				snapshot,
				getSkillInvocationToken(snapshot),
				productionInvocationContext(snapshot, loader, receiptContext),
			);
			if (admission === undefined) throw new Error("durable admission was not returned");
			const rotatedCurrent = productionInvocationContext(snapshot, loader, receiptContext);
			rotatedCurrent.decisionRef = {
				...DECISION_REF,
				storeEpoch: EPOCH.storeEpoch + 1,
				coordinatorEpoch: EPOCH.coordinatorEpoch + 1,
				decisionDigest: sha256Hex("rotated-decision"),
			};
			rotatedCurrent.epochRef = {
				storeEpoch: EPOCH.storeEpoch + 1,
				coordinatorEpoch: EPOCH.coordinatorEpoch + 1,
			};
			await expect(
				Promise.resolve().then(() =>
					executeWorkflowSkillInvocation(
						admission,
						{ execute: async () => "unreachable" },
						createWorkflowSkillExecutionVerificationContext(hostAdapter, snapshot, rotatedCurrent),
					),
				),
			).rejects.toThrow(/stale|foreign|epoch|binding|context/i);

			await writeFile(skill.filePath, "changed after admission", "utf8");
			await expect(
				Promise.resolve().then(() =>
					executeWorkflowSkillInvocation(
						admission,
						{ execute: async () => "unreachable" },
						createWorkflowSkillExecutionVerificationContext(
							hostAdapter,
							snapshot,
							productionInvocationContext(snapshot, loader, receiptContext),
						),
					),
				),
			).rejects.toThrow(/changed|drift|source|identity/i);
		} finally {
			await rm(casRoot, { recursive: true, force: true });
		}
	});

	it("accepts a loader metadata base directory that contains the individual skill", async () => {
		const skill = await createFixtureSkill("skill body");
		const containingBaseDir = dirname(dirname(skill.filePath));
		const rootedSkill: Skill = {
			...skill,
			baseDir: containingBaseDir,
			sourceInfo: { ...skill.sourceInfo, baseDir: containingBaseDir },
		};

		await expect(createSnapshot("skill body", [], rootedSkill)).resolves.toBeDefined();
	});

	it("rejects a decision reference scoped to a different workflow", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		const current = productionInvocationContext(snapshot, loader, receiptContext);
		current.decisionRef = {
			...DECISION_REF,
			decisionScope: { ...DECISION_REF.decisionScope, workflowId: "other-workflow" },
		};
		await expect(
			validateAndConsumeSkillInvocation(
				snapshot,
				getSkillInvocationToken(snapshot),
				createInvocationStore(),
				artifacts.resolver,
				current,
				{ allowTestStore: true },
			),
		).rejects.toThrow(/workflow|context/i);
	});

	it("integrates with real bundled and user ResourceLoader skills", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-resource-loader-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const bundledDir = join(root, "bundled");
		const userSkillDir = join(agentDir, "skills", "fixture");
		const userPythonSkillDir = join(agentDir, "skills", "python-fixture");
		const builtinSkillDir = join(bundledDir, "workflow-autoresearch");
		await mkdir(userSkillDir, { recursive: true });
		await mkdir(join(userPythonSkillDir, "src", "python_fixture"), { recursive: true });
		await mkdir(builtinSkillDir, { recursive: true });
		const skillBody = "skill body";
		await writeFile(
			join(userSkillDir, "SKILL.md"),
			`---\nname: fixture\ndescription: fixture skill\n---\n${skillBody}`,
			"utf8",
		);
		await writeFile(
			join(userPythonSkillDir, "SKILL.md"),
			"---\nname: python-fixture\ndescription: python fixture skill\n---\npython body",
			"utf8",
		);
		await writeFile(join(userPythonSkillDir, "pyproject.toml"), '[project]\nname = "python-fixture"\n', "utf8");
		await writeFile(join(userPythonSkillDir, "src", "python_fixture", "__init__.py"), "VALUE = 1\n", "utf8");
		await writeFile(
			join(builtinSkillDir, "SKILL.md"),
			"---\nname: workflow-autoresearch\ndescription: bundled skill\n---\nbundled",
			"utf8",
		);
		const previousHome = process.env.HOME;
		process.env.HOME = root;
		try {
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				bundledSkillsDir: bundledDir,
				settingsManager: SettingsManager.inMemory(),
				noExtensions: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();
			const loaded = resourceLoader.getSkills();
			const userSkill = loaded.skills.find((candidate) => candidate.name === "fixture");
			const userPythonSkill = loaded.skills.find((candidate) => candidate.name === "python-fixture");
			const builtinSkill = loaded.skills.find((candidate) => candidate.name === "workflow-autoresearch");
			expect(userSkill).toBeDefined();
			expect(userPythonSkill?.kind).toBe("python");
			expect(builtinSkill?.sourceInfo.source).toBe("builtin");
			expect(builtinSkill?.sourceInfo.baseDir).toBe(bundledDir);
			if (userSkill === undefined) throw new Error("real ResourceLoader did not load user skill");
			const realLoader: WorkflowResourceLoaderPort = {
				getSkills: () => resourceLoader.getSkills(),
			};
			await expect(
				createSnapshot(skillBody, [], userSkill, undefined, undefined, undefined, true, undefined, realLoader),
			).resolves.toBeDefined();
			if (userPythonSkill === undefined) throw new Error("real ResourceLoader did not load Python user skill");
			await expect(
				createSnapshot(
					"python body",
					[],
					userPythonSkill,
					undefined,
					undefined,
					undefined,
					true,
					undefined,
					realLoader,
				),
			).resolves.toBeDefined();
			if (builtinSkill === undefined) throw new Error("real ResourceLoader did not load bundled skill");
			const builtinSourceBytes = Uint8Array.from(await readFile(builtinSkill.filePath));
			const builtinSourceBytesDigest = sha256Hex(builtinSourceBytes);
			const builtinRelativePath = "workflow-autoresearch/SKILL.md";
			const builtinGateFields = {
				requiredApprovalGates: ["user"],
				requiredArtifactKinds: ["evidence"],
				requiredPressureTests: ["red-team"],
				allowedTransitions: ["start"],
			};
			const builtinSourceManifestBytes = canonicalJsonBytes({
				sourceManifestKind: "workflow-skill-source-manifest",
				skillName: "workflow-autoresearch",
				relativePath: builtinRelativePath,
				sourceBytesDigest: builtinSourceBytesDigest,
				...builtinGateFields,
			});
			const builtinSourceManifestDigest = sha256Hex(builtinSourceManifestBytes);
			const builtinRegistryBytes = canonicalJsonBytes({
				registryKind: "workflow-builtin-registry",
				entries: [
					{
						skillName: "workflow-autoresearch",
						relativePath: builtinRelativePath,
						sourceManifestDigest: builtinSourceManifestDigest,
						sourceBytesDigest: builtinSourceBytesDigest,
						sourceEventId: "builtin-event-1",
					},
				],
			});
			const builtinRegistryRef: WorkflowArtifactRef = {
				artifactId: "builtin-registry",
				relativePath: "artifacts/skills/builtin-registry",
				digest: sha256Hex(builtinRegistryBytes),
				sizeBytes: builtinRegistryBytes.byteLength,
				sourceEventSequence: 1,
			};
			const builtinSourceManifestRef: WorkflowArtifactRef = {
				artifactId: "builtin-source-manifest",
				relativePath: "artifacts/skills/builtin-source-manifest",
				digest: builtinSourceManifestDigest,
				sizeBytes: builtinSourceManifestBytes.byteLength,
				sourceEventSequence: 1,
			};
			const builtinSourceRef: WorkflowArtifactRef = {
				artifactId: "builtin-source",
				relativePath: "artifacts/skills/builtin-source",
				digest: builtinSourceBytesDigest,
				sizeBytes: builtinSourceBytes.byteLength,
				sourceEventSequence: 1,
			};
			const builtinVendoredRoot = await realpath(bundledDir);
			const builtinCanonicalPath = await realpath(builtinSkill.filePath);
			const unsignedSourceEvent = {
				eventId: "builtin-event-1",
				skillName: "workflow-autoresearch",
				vendoredRoot: builtinVendoredRoot,
				canonicalPath: builtinCanonicalPath,
				sourceManifestDigest: builtinSourceManifestDigest,
				sourceBytesDigest: builtinSourceBytesDigest,
				sourceEventSequence: 1,
				issuedAt: "2026-08-13T00:00:00.000Z",
				validUntil: "2026-08-13T00:05:00.000Z",
				keyId: "loader-key",
				signatureAlgorithm: "ed25519" as const,
				signature: "",
				eventDigest: "",
			};
			const builtinSourceEvent = {
				...unsignedSourceEvent,
				signature: signBytes(
					null,
					Buffer.from(canonicalJsonBytes(unsignedSourceEvent)),
					RECEIPT_PRIVATE_KEY,
				).toString("base64"),
				eventDigest: digestObject(unsignedSourceEvent),
			};
			const duplicateBuiltinRegistryBytes = canonicalJsonBytes({
				registryKind: "workflow-builtin-registry",
				entries: [
					{
						skillName: "workflow-autoresearch",
						relativePath: builtinRelativePath,
						sourceManifestDigest: builtinSourceManifestDigest,
						sourceBytesDigest: builtinSourceBytesDigest,
						sourceEventId: "builtin-event-1",
					},
					{
						skillName: "workflow-autoresearch",
						relativePath: builtinRelativePath,
						sourceManifestDigest: builtinSourceManifestDigest,
						sourceBytesDigest: builtinSourceBytesDigest,
						sourceEventId: "builtin-event-1",
					},
				],
			});
			const duplicateBuiltinRegistryRef: WorkflowArtifactRef = {
				artifactId: "builtin-registry-duplicate",
				relativePath: "artifacts/skills/builtin-registry-duplicate",
				digest: sha256Hex(duplicateBuiltinRegistryBytes),
				sizeBytes: duplicateBuiltinRegistryBytes.byteLength,
				sourceEventSequence: 1,
			};
			await expect(
				createSnapshot(
					"bundled",
					[],
					builtinSkill,
					undefined,
					async (sourceSkill, builtinArtifacts) => {
						builtinArtifacts.seed(
							duplicateBuiltinRegistryRef,
							duplicateBuiltinRegistryBytes,
							"evidence",
							"canonical_json",
						);
						builtinArtifacts.seed(
							builtinSourceManifestRef,
							builtinSourceManifestBytes,
							"evidence",
							"canonical_json",
						);
						builtinArtifacts.seed(builtinSourceRef, builtinSourceBytes, "evidence", "binary");
						return {
							sourcePath: sourceSkill.filePath,
							sourceBytes: builtinSourceBytes,
							sourceRef: builtinSourceRef,
							packageSources: [],
							builtin: {
								vendoredRoot: bundledDir,
								registryArtifactRef: duplicateBuiltinRegistryRef,
								registryBytes: duplicateBuiltinRegistryBytes,
								sourceManifestArtifactRef: builtinSourceManifestRef,
								sourceManifestBytes: builtinSourceManifestBytes,
								sourceEvent: builtinSourceEvent,
							},
						};
					},
					undefined,
					true,
					undefined,
					realLoader,
				),
			).rejects.toThrow(/duplicate|registry/i);
			const builtinFixture = await createSnapshot(
				"bundled",
				[],
				builtinSkill,
				undefined,
				async (sourceSkill, builtinArtifacts) => {
					builtinArtifacts.seed(builtinRegistryRef, builtinRegistryBytes, "evidence", "canonical_json");
					builtinArtifacts.seed(
						builtinSourceManifestRef,
						builtinSourceManifestBytes,
						"evidence",
						"canonical_json",
					);
					builtinArtifacts.seed(builtinSourceRef, builtinSourceBytes, "evidence", "binary");
					return {
						sourcePath: sourceSkill.filePath,
						sourceBytes: builtinSourceBytes,
						sourceRef: builtinSourceRef,
						packageSources: [],
						builtin: {
							vendoredRoot: bundledDir,
							registryArtifactRef: builtinRegistryRef,
							registryBytes: builtinRegistryBytes,
							sourceManifestArtifactRef: builtinSourceManifestRef,
							sourceManifestBytes: builtinSourceManifestBytes,
							sourceEvent: builtinSourceEvent,
						},
					};
				},
				undefined,
				true,
				undefined,
				realLoader,
			);
			expect(builtinFixture.snapshot.requiredBuiltIn).toBe(true);
			if (builtinFixture.builtinProvenanceContext === undefined)
				throw new Error("built-in fixture did not retain its host provenance context");
			const builtinCurrent = productionInvocationContext(
				builtinFixture.snapshot,
				realLoader,
				builtinFixture.receiptContext,
			);
			builtinCurrent.builtinProvenanceContext = builtinFixture.builtinProvenanceContext;
			await expect(
				revalidateSkillSnapshot(builtinFixture.snapshot, builtinFixture.artifacts.resolver, builtinCurrent),
			).resolves.toMatchObject({ source: expect.any(Object), manifest: expect.any(Object) });
			const builtinInvocationRoot = join(root, "builtin-invocations");
			await mkdir(builtinInvocationRoot, { recursive: true });
			const builtinInvocationStore = createDescriptorDurableWitnessStore(
				builtinInvocationRoot,
				createActiveHostStateReader(),
			);
			const builtinExecution = createWorkflowSkillProductionExecutionAdapter(
				createWorkflowSkillHostAdapter({
					loader: realLoader,
					loaderProvenance: builtinFixture.snapshot.loaderProvenance,
					artifacts: builtinFixture.artifacts.resolver,
					publisher: builtinFixture.artifacts.publisher,
					receiptContext: builtinFixture.receiptContext,
					builtinProvenanceContext: builtinFixture.builtinProvenanceContext,
					invocationStore: builtinInvocationStore,
				}),
			);
			await builtinExecution.validateAndConsume(
				builtinFixture.snapshot,
				getSkillInvocationToken(builtinFixture.snapshot),
				builtinCurrent,
			);
			const reissuedBuiltin = await builtinExecution.reissueSnapshot(builtinFixture.snapshot, {
				consumeSequence: 2,
				trustedNow: "2026-08-13T00:06:00.000Z",
			});
			const reissuedBuiltinCurrent = productionInvocationContext(
				reissuedBuiltin,
				realLoader,
				builtinFixture.receiptContext,
				"2026-08-13T00:06:00.000Z",
			);
			reissuedBuiltinCurrent.builtinProvenanceContext = builtinFixture.builtinProvenanceContext;
			await expect(
				builtinExecution.validateAndConsume(
					reissuedBuiltin,
					getSkillInvocationToken(reissuedBuiltin),
					reissuedBuiltinCurrent,
				),
			).resolves.toMatchObject({ status: "admitted" });
			(builtinFixture.builtinProvenanceContext.revokedEventIds as Set<string>).add("builtin-event-1");
			await expect(
				revalidateSkillSnapshot(builtinFixture.snapshot, builtinFixture.artifacts.resolver, builtinCurrent),
			).rejects.toThrow(/revok|source event|provenance/i);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it("does not establish built-in provenance from caller-controlled labels", async () => {
		const skill = await createFixtureSkill("skill body");
		const labeledBuiltin: Skill = {
			...skill,
			name: "workflow-autoresearch",
			sourceInfo: { ...skill.sourceInfo, source: "builtin" },
		};
		await expect(
			createSnapshot("skill body", [], labeledBuiltin, undefined, async (sourceSkill, artifacts) => {
				const bytes = Uint8Array.from(await readFile(sourceSkill.filePath));
				const sourceRef: WorkflowArtifactRef = {
					artifactId: "fabricated-builtin-source",
					relativePath: "artifacts/skills/fabricated-builtin-source",
					digest: sha256Hex(bytes),
					sizeBytes: bytes.byteLength,
					sourceEventSequence: 1,
				};
				artifacts.seed(sourceRef, bytes, "evidence", "binary");
				return {
					sourcePath: sourceSkill.filePath,
					sourceBytes: bytes,
					sourceRef,
					packageSources: [],
				};
			}),
		).rejects.toThrow(/registry|manifest|source event|provenance/i);
	});

	it("rejects a receipt with a forged signature even when its shape and verification digest are valid", async () => {
		await expect(
			createSnapshot("skill body", [], undefined, undefined, undefined, (receipt) => {
				const forged = { ...receipt, signature: "forged-signature", verificationDigest: "" };
				return { ...forged, verificationDigest: digestObject(forged) };
			}),
		).rejects.toThrow(/signature|receipt|cryptographic/i);
	});

	it("requires a durable resolver witness for a one-use loader receipt", async () => {
		await expect(
			createSnapshot(
				"skill body",
				[],
				undefined,
				undefined,
				undefined,
				undefined,
				true,
				undefined,
				undefined,
				(context) => ({
					...context,
					receiptResolver: {
						...context.receiptResolver,
						consumeIfOneUse: async () => undefined,
						resolveConsumptionWitness: async () => {
							throw new Error("loader receipt witness missing");
						},
					},
				}),
			),
		).rejects.toThrow(/witness|one-use|receipt/i);
	});

	it("rejects unbounded source, dependency, and manifest inputs", async () => {
		const oversizedBody = "x".repeat(2 * 1024 * 1024);
		await expect(createSnapshot(oversizedBody, [])).rejects.toThrow(/size|bound|limit/i);
		await expect(
			createSnapshot(
				"skill body",
				Array.from({ length: 257 }, (_, index) => `dep-${index}`),
			),
		).rejects.toThrow(/depend|limit|bound/i);
		await expect(createSnapshot("skill body", [], undefined, undefined, undefined, undefined, false)).rejects.toThrow(
			/manifest|gate|admission/i,
		);
	});

	it("bounds mutable loader skill and diagnostic arrays before canonicalization", async () => {
		const skill = await createFixtureSkill("skill body");
		const oversizedSkillsLoader: WorkflowResourceLoaderPort = {
			getSkills: () => ({ skills: Array.from({ length: 257 }, () => skill), diagnostics: [] }),
		};
		await expect(
			createSnapshot(
				"skill body",
				[],
				skill,
				undefined,
				undefined,
				undefined,
				true,
				undefined,
				oversizedSkillsLoader,
			),
		).rejects.toThrow(/loader|skill|bound|limit/i);

		const oversizedDiagnosticsLoader: WorkflowResourceLoaderPort = {
			getSkills: () => ({
				skills: [skill],
				diagnostics: Array.from({ length: 257 }, () => ({ type: "warning", message: "diagnostic" })),
			}),
		};
		await expect(
			createSnapshot(
				"skill body",
				[],
				skill,
				undefined,
				undefined,
				undefined,
				true,
				undefined,
				oversizedDiagnosticsLoader,
			),
		).rejects.toThrow(/loader|diagnostic|bound|limit/i);
	});

	it("bounds aggregate ResourceLoader result bytes before snapshotting", async () => {
		const skill = await createFixtureSkill("skill body");
		const oversizedLoader: WorkflowResourceLoaderPort = {
			getSkills: () => ({
				skills: Array.from({ length: 200 }, (_, index) => ({
					...skill,
					name: index === 0 ? skill.name : `loader-${index}`,
					description: "x".repeat(64 * 1024),
				})),
				diagnostics: [],
			}),
		};
		await expect(
			createSnapshot("skill body", [], skill, undefined, undefined, undefined, true, undefined, oversizedLoader),
		).rejects.toThrow(/loader|aggregate|byte|bound|limit/i);
	});

	it("rejects dependency byte coercion and typed-array confusion before hashing", async () => {
		const sparseBytes: number[] = [];
		sparseBytes.length = 5;
		sparseBytes[1] = 101;
		sparseBytes[2] = 112;
		sparseBytes[3] = 45;
		sparseBytes[4] = 97;
		const malformedBytes: unknown[] = [
			[256, 101, 112, 45, 97],
			[-1, 101, 112, 45, 97],
			[1.5, 101, 112, 45, 97],
			sparseBytes,
			new Uint16Array([0, 101, 112, 45, 97]),
		];
		for (const dependencyBytesOverride of malformedBytes) {
			await expect(
				createSnapshot(
					"skill body",
					["dep-a"],
					undefined,
					undefined,
					undefined,
					undefined,
					true,
					undefined,
					undefined,
					undefined,
					{ dependencyBytesOverride },
				),
			).rejects.toThrow(/byte|integer|dense|typed|content/i);
		}
	});

	it("rejects a decision reference whose epochs do not match the snapshot epoch before pinning", async () => {
		await expect(
			createSnapshot(
				"skill body",
				[],
				undefined,
				undefined,
				undefined,
				undefined,
				true,
				undefined,
				undefined,
				undefined,
				{
					decisionRef: { ...DECISION_REF, storeEpoch: DECISION_REF.storeEpoch + 1 },
				},
			),
		).rejects.toThrow(/epoch|decision|stale|binding/i);
	});

	it("binds manifest gate metadata into the immutable snapshot digest", async () => {
		const first = await createSnapshot();
		const changed = await createSnapshot(
			"skill body",
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			true,
			undefined,
			undefined,
			undefined,
			{
				manifestGateFields: {
					requiredApprovalGates: ["admin"],
					requiredArtifactKinds: ["evidence"],
					requiredPressureTests: ["red-team"],
					allowedTransitions: ["start"],
				},
			},
		);
		expect(changed.snapshot.manifest?.requiredApprovalGates).toEqual(["admin"]);
		expect(changed.snapshot.snapshotDigest).not.toBe(first.snapshot.snapshotDigest);
	});

	it("rejects stale and foreign decision epochs before revalidation or durable CAS", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		const casRoot = await mkdtemp(join(tmpdir(), "workflow-skill-epoch-validation-"));
		try {
			const store = createDescriptorDurableWitnessStore(casRoot);
			const staleCurrent = productionInvocationContext(snapshot, loader, receiptContext);
			staleCurrent.epochRef = { storeEpoch: EPOCH.storeEpoch + 1, coordinatorEpoch: EPOCH.coordinatorEpoch };
			await expect(
				validateAndConsumeSkillInvocation(
					snapshot,
					getSkillInvocationToken(snapshot),
					store,
					artifacts.resolver,
					staleCurrent,
				),
			).rejects.toThrow(/epoch|stale|binding|context/i);
			expect(store.calls).toBe(0);

			const foreignCurrent = productionInvocationContext(snapshot, loader, receiptContext);
			foreignCurrent.decisionRef = { ...DECISION_REF, coordinatorEpoch: DECISION_REF.coordinatorEpoch + 1 };
			await expect(revalidateSkillSnapshot(snapshot, artifacts.resolver, foreignCurrent)).rejects.toThrow(
				/epoch|decision|binding|context/i,
			);
		} finally {
			await rm(casRoot, { recursive: true, force: true });
		}
	});

	it("rejects a foreign epoch at durable consumption without claiming the token", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		const casRoot = await mkdtemp(join(tmpdir(), "workflow-skill-epoch-consume-"));
		try {
			const store = createDescriptorDurableWitnessStore(casRoot);
			await expect(
				store.consume({
					workflowId: snapshot.workflowId,
					taskId: snapshot.taskId,
					decisionRef: { ...DECISION_REF, storeEpoch: DECISION_REF.storeEpoch + 1 },
					attemptId: snapshot.attemptId,
					snapshotDigest: snapshot.snapshotDigest,
					invocationTokenId: snapshot.invocationTokenId,
					tokenHash: snapshot.invocationTokenHash,
					configDigest: snapshot.configDigest,
					dependencyManifestDigest: snapshot.authoritativeDependencyManifestDigest,
					consumeSequence: snapshot.consumeSequence,
					expectedEpoch: EPOCH,
					journalHeadDigest: snapshot.journalHeadDigest,
					trustedNow: snapshot.trustedNow,
				}),
			).rejects.toThrow(/epoch|decision|binding/i);
			const admission = await validateAndConsumeSkillInvocation(
				snapshot,
				getSkillInvocationToken(snapshot),
				store,
				artifacts.resolver,
				productionInvocationContext(snapshot, loader, receiptContext),
			);
			expect(admission?.status).toBe("admitted");
		} finally {
			await rm(casRoot, { recursive: true, force: true });
		}
	});

	it("rejects resolver bytes beyond the immutable artifact bound immediately after the read", async () => {
		let dependencyReads = 0;
		await expect(
			createSnapshot("skill body", ["dep-a"], undefined, (base) => ({
				resolve: async (ref) => {
					const resolved = await base.resolve(ref);
					if (ref.artifactId !== "dep-a") return resolved;
					dependencyReads += 1;
					const oversizedBytes = new Uint8Array(1024 * 1024 + 1);
					return {
						...resolved,
						bytes: oversizedBytes,
						verifiedDigest: sha256Hex(oversizedBytes),
						verifiedSizeBytes: oversizedBytes.byteLength,
					};
				},
			})),
		).rejects.toThrow(/byte|bound|limit/i);
		expect(dependencyReads).toBe(1);
	});

	it("rejects rehydrated snapshot arrays before traversing their artifact references", async () => {
		const { snapshot } = await createSnapshot();
		const oversizedSnapshot = {
			...snapshot,
			dependencySourceRefs: Array.from({ length: 257 }, () => snapshot.dependencySourceRefs[0]),
		} as unknown as WorkflowSkillSnapshot;
		expect(() => validateSkillSnapshot(oversizedSnapshot)).toThrow(/array|count|limit/i);
	});

	it("rejects package traversal beyond file-count and depth bounds", async () => {
		const skill = await createFixtureSkill("skill body", "python");
		if (skill.kind !== "python") throw new Error("fixture did not create a Python skill");
		for (let index = 0; index < 257; index += 1) {
			await writeFile(
				join(skill.python.packagePath, "src", "fixture", `extra-${index}.py`),
				`VALUE = ${index}\n`,
				"utf8",
			);
		}
		let rejected = false;
		try {
			await createSnapshot("skill body", [], skill);
		} catch {
			rejected = true;
		}
		expect(rejected).toBe(true);
	});

	it("rejects package traversal beyond the configured directory depth", async () => {
		const skill = await createFixtureSkill("skill body", "python");
		if (skill.kind !== "python") throw new Error("fixture did not create a Python skill");
		let nested = join(skill.python.packagePath, "src", "fixture");
		for (let index = 0; index < 20; index += 1) nested = join(nested, `level-${index}`);
		await mkdir(nested, { recursive: true });
		await writeFile(join(nested, "deep.py"), "VALUE = 1\n", "utf8");
		let rejected = false;
		try {
			await createSnapshot("skill body", [], skill);
		} catch {
			rejected = true;
		}
		expect(rejected).toBe(true);
	});

	it("rejects a sourceless Python package containing bytecode", async () => {
		const skill = await createFixtureSkill("skill body", "python");
		if (skill.kind !== "python") throw new Error("fixture did not create a Python skill");
		const sourcePackage = join(skill.python.packagePath, "src", "fixture");
		await unlink(join(sourcePackage, "__init__.py"));
		await mkdir(join(sourcePackage, "__pycache__"));
		await writeFile(join(sourcePackage, "__pycache__", "__init__.cpython-312.pyc"), Uint8Array.of(0, 1, 2, 3));
		await expect(createSnapshot("skill body", [], skill)).rejects.toThrow(/bytecode|pyc|executable|package/i);
	});

	it("delegates one-use enforcement to the durable CAS instead of a process-local claim", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		const casRoot = await mkdtemp(join(tmpdir(), "workflow-skill-cas-"));
		const store = createDescriptorDurableWitnessStore(casRoot);
		const current = productionInvocationContext(snapshot, loader, receiptContext);
		try {
			await validateAndConsumeSkillInvocation(
				snapshot,
				getSkillInvocationToken(snapshot),
				store,
				artifacts.resolver,
				current,
			);
			await expect(
				validateAndConsumeSkillInvocation(
					snapshot,
					getSkillInvocationToken(snapshot),
					store,
					artifacts.resolver,
					current,
				),
			).rejects.toThrow(/CAS|replay|consume/i);
			expect(store.calls).toBe(2);
		} finally {
			await rm(casRoot, { recursive: true, force: true });
		}
	});

	it("rejects a rotated active epoch inside the descriptor consumption CAS", async () => {
		const { snapshot, loader, receiptContext } = await createSnapshot();
		const casRoot = await mkdtemp(join(tmpdir(), "workflow-skill-cas-active-race-"));
		const rotatedState: WorkflowSkillActiveHostState = {
			workflowId: "wf-1",
			epochRef: { storeEpoch: EPOCH.storeEpoch + 1, coordinatorEpoch: EPOCH.coordinatorEpoch },
			journalHeadDigest: "rotated-head",
		};
		const store = createDescriptorDurableWitnessStore(
			casRoot,
			createLeaseStateReader({ workflowId: "wf-1", epochRef: EPOCH, journalHeadDigest: "head-1" }, rotatedState),
		);
		const current = productionInvocationContext(snapshot, loader, receiptContext);
		try {
			await expect(
				store.consume({
					workflowId: snapshot.workflowId,
					taskId: current.taskId,
					decisionRef: current.decisionRef,
					attemptId: snapshot.attemptId,
					snapshotDigest: snapshot.snapshotDigest,
					invocationTokenId: snapshot.invocationTokenId,
					tokenHash: snapshot.invocationTokenHash,
					configDigest: snapshot.configDigest,
					dependencyManifestDigest: snapshot.authoritativeDependencyManifestDigest,
					consumeSequence: snapshot.consumeSequence,
					expectedEpoch: snapshot.epochRef,
					journalHeadDigest: snapshot.journalHeadDigest,
					trustedNow: snapshot.trustedNow,
				}),
			).rejects.toThrow(/active|stale|foreign|epoch|journal/i);
			await expect(
				readFile(join(casRoot, "skill-invocations", sha256Hex(snapshot.invocationTokenId), "witness")),
			).rejects.toThrow();
		} finally {
			await rm(casRoot, { recursive: true, force: true });
		}
	});

	it("rejects a rotated active epoch inside the descriptor execution-claim CAS", async () => {
		const { snapshot } = await createSnapshot();
		const casRoot = await mkdtemp(join(tmpdir(), "workflow-skill-claim-active-race-"));
		const rotatedState: WorkflowSkillActiveHostState = {
			workflowId: "wf-1",
			epochRef: { storeEpoch: EPOCH.storeEpoch + 1, coordinatorEpoch: EPOCH.coordinatorEpoch },
			journalHeadDigest: "rotated-head",
		};
		const store = createDescriptorDurableWitnessStore(
			casRoot,
			createLeaseStateReader({ workflowId: "wf-1", epochRef: EPOCH, journalHeadDigest: "head-1" }, rotatedState),
		);
		try {
			await expect(
				store.claimExecution({
					workflowId: snapshot.workflowId,
					taskId: snapshot.taskId,
					decisionRef: snapshot.decisionRef,
					attemptId: snapshot.attemptId,
					snapshotDigest: snapshot.snapshotDigest,
					admissionDigest: sha256Hex("admission"),
					invocationTokenId: snapshot.invocationTokenId,
					tokenHash: snapshot.invocationTokenHash,
					configDigest: snapshot.configDigest,
					workspaceDigest: snapshot.workspaceDigest,
					dependencyManifestDigest: snapshot.authoritativeDependencyManifestDigest,
					workflowContractRevision: snapshot.workflowContractRevision,
					consumeSequence: snapshot.consumeSequence,
					expectedEpoch: snapshot.epochRef,
					journalHeadDigest: snapshot.journalHeadDigest,
					trustedNow: snapshot.trustedNow,
				}),
			).rejects.toThrow(/active|stale|foreign|epoch|journal/i);
			await expect(readFile(join(casRoot, "skill-executions", sha256Hex("admission"), "witness"))).rejects.toThrow();
		} finally {
			await rm(casRoot, { recursive: true, force: true });
		}
	});

	it("allows exactly one winner across two durable store instances racing on the same CAS", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		const casRoot = await mkdtemp(join(tmpdir(), "workflow-skill-cas-race-"));
		const activeStatePath = join(casRoot, "active-host-state.json");
		try {
			await writeActiveHostState(activeStatePath);
			const current = productionInvocationContext(snapshot, loader, receiptContext);
			const { loader: _loader, receiptContext: _receiptContext, ...workerCurrent } = current;
			const workerInput = {
				rootPath: casRoot,
				activeStatePath,
				snapshot,
				token: getSkillInvocationToken(snapshot),
				current: workerCurrent,
				records: artifacts.records,
				privateKey: CONSUME_PRIVATE_KEY.export({ format: "pem", type: "pkcs8" }).toString(),
				loaderPublicKey: RECEIPT_PUBLIC_KEY.export({ format: "pem", type: "spki" }).toString(),
				consumePublicKey: CONSUME_PUBLIC_KEY.export({ format: "pem", type: "spki" }).toString(),
			};
			const workerExitCodes = await Promise.all([
				runDescriptorValidationWorker(workerInput),
				runDescriptorValidationWorker(workerInput),
			]);
			expect(workerExitCodes.filter((code) => code === 0)).toHaveLength(1);
			expect(workerExitCodes.filter((code) => code === 17)).toHaveLength(1);

			await expect(
				validateAndConsumeSkillInvocation(
					snapshot,
					getSkillInvocationToken(snapshot),
					createDescriptorDurableWitnessStore(casRoot, createFileActiveHostStateReader(activeStatePath)),
					artifacts.resolver,
					current,
				),
			).rejects.toThrow(/CAS|replay|consume/i);
		} finally {
			await rm(casRoot, { recursive: true, force: true });
		}
	});

	it("allows exactly one execution claim across processes and rejects replay after restart", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		const casRoot = await mkdtemp(join(tmpdir(), "workflow-skill-execution-cas-race-"));
		const activeStatePath = join(casRoot, "active-host-state.json");
		try {
			await writeActiveHostState(activeStatePath);
			const hostAdapter = createWorkflowSkillHostAdapter({
				loader,
				loaderProvenance: snapshot.loaderProvenance,
				artifacts: artifacts.resolver,
				publisher: artifacts.publisher,
				receiptContext,
				invocationStore: createDescriptorDurableWitnessStore(
					casRoot,
					createFileActiveHostStateReader(activeStatePath),
				),
			});
			const admission = await createWorkflowSkillSnapshotService(hostAdapter).validateAndConsume(
				snapshot,
				getSkillInvocationToken(snapshot),
				productionInvocationContext(snapshot, loader, receiptContext),
			);
			if (admission === undefined) throw new Error("durable admission was not returned");
			const current = productionInvocationContext(snapshot, loader, receiptContext);
			const { loader: _loader, receiptContext: _receiptContext, ...workerCurrent } = current;
			const workerInput = {
				rootPath: casRoot,
				activeStatePath,
				snapshot,
				admission,
				current: workerCurrent,
				records: artifacts.records,
				privateKey: CONSUME_PRIVATE_KEY.export({ format: "pem", type: "pkcs8" }).toString(),
				loaderPublicKey: RECEIPT_PUBLIC_KEY.export({ format: "pem", type: "spki" }).toString(),
				consumePublicKey: CONSUME_PUBLIC_KEY.export({ format: "pem", type: "spki" }).toString(),
			};
			const workerExitCodes = await Promise.all([
				runDescriptorExecutionWorker(workerInput),
				runDescriptorExecutionWorker(workerInput),
			]);
			expect(workerExitCodes.filter((code) => code === 0)).toHaveLength(1);
			expect(workerExitCodes.filter((code) => code === 17)).toHaveLength(1);

			expect(await runDescriptorExecutionWorker(workerInput)).toBe(17);
		} finally {
			await rm(casRoot, { recursive: true, force: true });
		}
	});

	it("rejects a fresh-process execution after the durable host epoch rotates", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		const casRoot = await mkdtemp(join(tmpdir(), "workflow-skill-execution-rotation-process-"));
		const activeStatePath = join(casRoot, "active-host-state.json");
		try {
			await writeActiveHostState(activeStatePath);
			const activeHostState = createFileActiveHostStateReader(activeStatePath);
			const hostAdapter = createWorkflowSkillHostAdapter({
				loader,
				loaderProvenance: snapshot.loaderProvenance,
				artifacts: artifacts.resolver,
				publisher: artifacts.publisher,
				receiptContext,
				invocationStore: createDescriptorDurableWitnessStore(casRoot, activeHostState),
			});
			const admission = await createWorkflowSkillProductionExecutionAdapter(hostAdapter).validateAndConsume(
				snapshot,
				getSkillInvocationToken(snapshot),
				productionInvocationContext(snapshot, loader, receiptContext),
			);
			if (admission === undefined) throw new Error("durable admission was not returned");
			await writeActiveHostState(activeStatePath, {
				workflowId: "wf-1",
				epochRef: { storeEpoch: EPOCH.storeEpoch + 1, coordinatorEpoch: EPOCH.coordinatorEpoch },
				journalHeadDigest: "rotated-head",
			});
			const current = productionInvocationContext(snapshot, loader, receiptContext);
			const { loader: _loader, receiptContext: _receiptContext, ...workerCurrent } = current;
			expect(
				await runDescriptorExecutionWorker({
					rootPath: casRoot,
					activeStatePath,
					snapshot,
					admission,
					current: workerCurrent,
					records: artifacts.records,
					privateKey: CONSUME_PRIVATE_KEY.export({ format: "pem", type: "pkcs8" }).toString(),
					loaderPublicKey: RECEIPT_PUBLIC_KEY.export({ format: "pem", type: "spki" }).toString(),
					consumePublicKey: CONSUME_PUBLIC_KEY.export({ format: "pem", type: "spki" }).toString(),
				}),
			).toBe(18);
		} finally {
			await rm(casRoot, { recursive: true, force: true });
		}
	});

	it("rejects a process execution when the durable host rotates during executor effects", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		const casRoot = await mkdtemp(join(tmpdir(), "workflow-skill-execution-fence-process-"));
		const activeStatePath = join(casRoot, "active-host-state.json");
		const executionStartedPath = join(casRoot, "execution-started");
		const executionReleasePath = join(casRoot, "execution-release");
		let execution: Promise<number> | undefined;
		try {
			await writeActiveHostState(activeStatePath);
			const hostAdapter = createWorkflowSkillHostAdapter({
				loader,
				loaderProvenance: snapshot.loaderProvenance,
				artifacts: artifacts.resolver,
				publisher: artifacts.publisher,
				receiptContext,
				invocationStore: createDescriptorDurableWitnessStore(
					casRoot,
					createFileActiveHostStateReader(activeStatePath),
				),
			});
			const productionAdapter = createWorkflowSkillProductionExecutionAdapter(hostAdapter);
			const admission = await productionAdapter.validateAndConsume(
				snapshot,
				getSkillInvocationToken(snapshot),
				productionInvocationContext(snapshot, loader, receiptContext),
			);
			if (admission === undefined) throw new Error("durable admission was not returned");
			const current = productionInvocationContext(snapshot, loader, receiptContext);
			const { loader: _loader, receiptContext: _receiptContext, ...workerCurrent } = current;
			execution = runDescriptorExecutionWorker({
				rootPath: casRoot,
				activeStatePath,
				executionStartedPath,
				executionReleasePath,
				snapshot,
				admission,
				current: workerCurrent,
				records: artifacts.records,
				privateKey: CONSUME_PRIVATE_KEY.export({ format: "pem", type: "pkcs8" }).toString(),
				loaderPublicKey: RECEIPT_PUBLIC_KEY.export({ format: "pem", type: "spki" }).toString(),
				consumePublicKey: CONSUME_PUBLIC_KEY.export({ format: "pem", type: "spki" }).toString(),
			});
			await waitForFile(executionStartedPath);
			await writeActiveHostState(activeStatePath, {
				workflowId: "wf-1",
				epochRef: { storeEpoch: EPOCH.storeEpoch + 1, coordinatorEpoch: EPOCH.coordinatorEpoch },
				journalHeadDigest: "rotated-head",
			});
			await writeFile(executionReleasePath, "release", "utf8");
			expect(await execution).toBe(18);
		} finally {
			await writeFile(executionReleasePath, "cleanup", "utf8").catch(() => undefined);
			await execution?.catch(() => undefined);
			await rm(casRoot, { recursive: true, force: true });
		}
	});

	it("rejects untrusted loader provenance before publishing any snapshot artifact", async () => {
		const skill = await createFixtureSkill("skill body");
		const artifacts = createArtifactFixture();
		const loader: WorkflowResourceLoaderPort = {
			getSkills: () => ({ skills: [skill], diagnostics: [] }),
		};
		const provenance = createProvenance("wf-1", "workspace-1", loader.getSkills());
		const manifest = createAdmissionManifest();
		artifacts.seed(
			provenance.issuanceReceipt.artifactRef,
			new TextEncoder().encode("loader-receipt"),
			"evidence",
			"binary",
		);
		artifacts.seed(manifest.artifactRef, Uint8Array.from(manifest.bytes), "evidence", "canonical_json");
		await expect(
			createSkillSnapshot({
				workflowId: "wf-1",
				taskId: "task-1",
				decisionRef: DECISION_REF,
				journalHeadDigest: "head-1",
				skill,
				dependencies: [],
				manifest,
				artifacts: artifacts.resolver,
				publisher: artifacts.publisher,
				workflowContractRevision: 1,
				configDigest: "config-1",
				workspaceDigest: "workspace-1",
				attemptId: "attempt-1",
				loader,
				loaderProvenance: { ...provenance, artifactNamespace: "artifacts/other" as "artifacts/skills" },
				receiptContext: createReceiptContext(artifacts.resolver),
				trustedNow: TRUSTED_NOW,
				epochRef: EPOCH,
				sourceEventSequence: 1,
			}),
		).rejects.toThrow(/provenance/i);
		expect(artifacts.bytesByDigest.size).toBe(2);
	});

	it("rejects a loader receipt whose verification digest is not resolver-authenticated", async () => {
		const skill = await createFixtureSkill("skill body");
		const artifacts = createArtifactFixture();
		const loader: WorkflowResourceLoaderPort = {
			getSkills: () => ({ skills: [skill], diagnostics: [] }),
		};
		const provenance = createProvenance("wf-1", "workspace-1", loader.getSkills());
		const manifest = createAdmissionManifest();
		artifacts.seed(
			provenance.issuanceReceipt.artifactRef,
			new TextEncoder().encode("loader-receipt"),
			"evidence",
			"binary",
		);
		artifacts.seed(manifest.artifactRef, Uint8Array.from(manifest.bytes), "evidence", "canonical_json");
		await expect(
			createSkillSnapshot({
				workflowId: "wf-1",
				taskId: "task-1",
				decisionRef: DECISION_REF,
				journalHeadDigest: "head-1",
				skill,
				dependencies: [],
				manifest,
				artifacts: artifacts.resolver,
				publisher: artifacts.publisher,
				workflowContractRevision: 1,
				configDigest: "config-1",
				workspaceDigest: "workspace-1",
				attemptId: "attempt-1",
				loader,
				loaderProvenance: {
					...provenance,
					issuanceReceipt: {
						...provenance.issuanceReceipt,
						verificationDigest: sha256Hex("tampered-verification"),
					},
				},
				receiptContext: createReceiptContext(artifacts.resolver),
				trustedNow: TRUSTED_NOW,
				epochRef: EPOCH,
				sourceEventSequence: 1,
			}),
		).rejects.toThrow(/receipt|verification/i);
	});

	it("fails invocation when the trusted receipt resolver revokes the loader receipt", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		(receiptContext.revokedReceiptIds as Set<string>).add(snapshot.hostVerificationReceipt.receiptId);
		await expect(
			validateAndConsumeSkillInvocation(
				snapshot,
				getSkillInvocationToken(snapshot),
				createInvocationStore(),
				artifacts.resolver,
				{
					workflowId: "wf-1",
					taskId: "task-1",
					decisionRef: DECISION_REF,
					configDigest: "config-1",
					workspaceDigest: "workspace-1",
					attemptId: "attempt-1",
					epochRef: EPOCH,
					dependencyManifestDigest: snapshot.dependencyManifestDigest,
					loader,
					workflowContractRevision: 1,
					receiptContext,
					trustedNow: TRUSTED_NOW,
					journalHeadDigest: "head-1",
				},
				{ allowTestStore: true },
			),
		).rejects.toThrow(/receipt|revok/i);
	});

	it("fails invocation when trusted time is outside the loader receipt validity window", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		await expect(
			validateAndConsumeSkillInvocation(
				snapshot,
				getSkillInvocationToken(snapshot),
				createInvocationStore(),
				artifacts.resolver,
				{
					workflowId: "wf-1",
					taskId: "task-1",
					decisionRef: DECISION_REF,
					configDigest: "config-1",
					workspaceDigest: "workspace-1",
					attemptId: "attempt-1",
					epochRef: EPOCH,
					dependencyManifestDigest: snapshot.dependencyManifestDigest,
					loader,
					workflowContractRevision: 1,
					receiptContext,
					trustedNow: "2026-08-13T00:06:00.000Z",
					journalHeadDigest: "head-1",
				},
				{ allowTestStore: true },
			),
		).rejects.toThrow(/receipt|trusted|valid|context/i);
	});

	it("binds the manifest digest to the resolver envelope returned after publication", async () => {
		const { snapshot, artifacts, loader, receiptContext } = await createSnapshot();
		let manifestRead = 0;
		const resolver: WorkflowArtifactResolver = {
			resolve: async (ref) => {
				const resolved = await artifacts.resolver.resolve(ref);
				if (snapshot.manifestArtifactRef !== null && ref.digest === snapshot.manifestArtifactRef.digest) {
					manifestRead += 1;
					if (manifestRead > 0) {
						return {
							...resolved,
							envelope: { ...resolved.envelope, payloadKind: "handoff" },
						};
					}
				}
				return resolved;
			},
		};
		await expect(
			validateAndConsumeSkillInvocation(
				snapshot,
				getSkillInvocationToken(snapshot),
				createInvocationStore(),
				resolver,
				{
					workflowId: "wf-1",
					taskId: "task-1",
					decisionRef: DECISION_REF,
					configDigest: "config-1",
					workspaceDigest: "workspace-1",
					attemptId: "attempt-1",
					epochRef: EPOCH,
					dependencyManifestDigest: snapshot.dependencyManifestDigest,
					loader,
					workflowContractRevision: 1,
					receiptContext,
					trustedNow: TRUSTED_NOW,
					journalHeadDigest: "head-1",
				},
				{ allowTestStore: true },
			),
		).rejects.toThrow(/manifest|artifact/i);
	});

	it("rejects a manifest envelope that drifts between publication and snapshot binding", async () => {
		let manifestResolveCount = 0;
		await expect(
			createSnapshot("skill body", ["dep-a"], undefined, (base) => ({
				resolve: async (ref) => {
					const resolved = await base.resolve(ref);
					if (ref.artifactId.startsWith("skill-manifest:") && manifestResolveCount++ > 0) {
						return { ...resolved, envelope: { ...resolved.envelope, payloadKind: "handoff" } };
					}
					return resolved;
				},
			})),
		).rejects.toThrow(/manifest|envelope|artifact/i);
	});

	it("does not accept a required built-in skill from ordinary ResourceLoader precedence", async () => {
		const skill = await createFixtureSkill("skill body");
		const builtinSkill: Skill = {
			...skill,
			name: "workflow-autoresearch",
			sourceInfo: { ...skill.sourceInfo, source: "project" },
		};
		const artifacts = createArtifactFixture();
		const loader: WorkflowResourceLoaderPort = {
			getSkills: () => ({ skills: [builtinSkill], diagnostics: [] }),
		};
		const provenance = createProvenance("wf-1", "workspace-1", loader.getSkills());
		const manifest = createAdmissionManifest();
		artifacts.seed(
			provenance.issuanceReceipt.artifactRef,
			new TextEncoder().encode("loader-receipt"),
			"evidence",
			"binary",
		);
		artifacts.seed(manifest.artifactRef, Uint8Array.from(manifest.bytes), "evidence", "canonical_json");
		await expect(
			createSkillSnapshot({
				workflowId: "wf-1",
				taskId: "task-1",
				decisionRef: DECISION_REF,
				journalHeadDigest: "head-1",
				skill: builtinSkill,
				dependencies: [],
				manifest,
				artifacts: artifacts.resolver,
				publisher: artifacts.publisher,
				workflowContractRevision: 1,
				configDigest: "config-1",
				workspaceDigest: "workspace-1",
				attemptId: "attempt-1",
				loader,
				loaderProvenance: provenance,
				receiptContext: createReceiptContext(artifacts.resolver),
				trustedNow: TRUSTED_NOW,
				epochRef: EPOCH,
				sourceEventSequence: 1,
			}),
		).rejects.toThrow(/built-in|host|provenance/i);
	});

	it("re-resolves the current loader before consuming an invocation", async () => {
		const { snapshot, artifacts, receiptContext, trustedNow } = await createSnapshot();
		const current = {
			workflowId: "wf-1",
			taskId: "task-1",
			decisionRef: DECISION_REF,
			configDigest: "config-1",
			workspaceDigest: "workspace-1",
			attemptId: "attempt-1",
			epochRef: EPOCH,
			dependencyManifestDigest: snapshot.dependencyManifestDigest,
			loader: { revision: 2, getSkills: () => ({ skills: [], diagnostics: [] }) },
			workflowContractRevision: 2,
			receiptContext,
			trustedNow,
			journalHeadDigest: "head-1",
		};
		await expect(
			validateAndConsumeSkillInvocation(
				snapshot,
				getSkillInvocationToken(snapshot),
				createInvocationStore(),
				artifacts.resolver,
				current,
			),
		).rejects.toThrow(/loader|contract|drift|skill/i);
	});

	it("requires a durable invocation store unless a test-only store is explicitly allowed", async () => {
		const { snapshot, artifacts, loader, receiptContext, trustedNow } = await createSnapshot();
		await expect(
			validateAndConsumeSkillInvocation(
				snapshot,
				getSkillInvocationToken(snapshot),
				{ ...createInvocationStore(), durability: "test" },
				artifacts.resolver,
				{
					workflowId: "wf-1",
					taskId: "task-1",
					decisionRef: DECISION_REF,
					configDigest: "config-1",
					workspaceDigest: "workspace-1",
					attemptId: "attempt-1",
					epochRef: EPOCH,
					dependencyManifestDigest: snapshot.dependencyManifestDigest,
					loader,
					workflowContractRevision: 1,
					receiptContext,
					trustedNow,
					journalHeadDigest: "head-1",
				},
			),
		).rejects.toMatchObject({ code: "workflow_skill_durable_store_required" });
	});

	it("requires a durable invocation store to return a one-use consumption witness", async () => {
		const { snapshot, artifacts, loader, receiptContext, trustedNow } = await createSnapshot();
		await expect(
			validateAndConsumeSkillInvocation(
				snapshot,
				getSkillInvocationToken(snapshot),
				createDurableBooleanStore(),
				artifacts.resolver,
				{
					workflowId: "wf-1",
					taskId: "task-1",
					decisionRef: DECISION_REF,
					configDigest: "config-1",
					workspaceDigest: "workspace-1",
					attemptId: "attempt-1",
					epochRef: EPOCH,
					dependencyManifestDigest: snapshot.dependencyManifestDigest,
					loader,
					workflowContractRevision: 1,
					receiptContext,
					trustedNow,
					journalHeadDigest: "head-1",
				},
			),
		).rejects.toThrow(/witness|durable|consume/i);
	});

	it("fails closed if a durable store reports the same invocation as consumed twice", async () => {
		const { snapshot, artifacts, loader, receiptContext, trustedNow } = await createSnapshot();
		const store = createDurableWitnessStore();
		const current = {
			workflowId: "wf-1",
			taskId: "task-1",
			decisionRef: DECISION_REF,
			configDigest: "config-1",
			workspaceDigest: "workspace-1",
			attemptId: "attempt-1",
			epochRef: EPOCH,
			dependencyManifestDigest: snapshot.dependencyManifestDigest,
			loader,
			workflowContractRevision: 1,
			receiptContext,
			trustedNow,
			journalHeadDigest: "head-1",
		};

		await expect(
			validateAndConsumeSkillInvocation(
				snapshot,
				getSkillInvocationToken(snapshot),
				store,
				artifacts.resolver,
				current,
			),
		).resolves.toMatchObject({ status: "admitted" });
		await expect(
			validateAndConsumeSkillInvocation(
				snapshot,
				getSkillInvocationToken(snapshot),
				store,
				artifacts.resolver,
				current,
			),
		).rejects.toThrow(/already|one-use|consume/i);
	});

	it("canonicalizes dependency closure by code-point stable identity", async () => {
		const skill = await createFixtureSkill("skill body");
		const first = await createSnapshot("skill body", ["z", "😀"], skill);
		const second = await createSnapshot("skill body", ["😀", "z"], skill);

		expect(first.snapshot.dependencyNames).toEqual(["z", "😀"]);
		expect(second.snapshot.dependencyNames).toEqual(first.snapshot.dependencyNames);
		expect(second.snapshot.dependencyManifestDigest).toBe(first.snapshot.dependencyManifestDigest);
		expect(second.snapshot.snapshotDigest).toBe(first.snapshot.snapshotDigest);
	});

	it("rejects an identical-byte dependency replacement at the pinned path", async () => {
		const skill = await createFixtureSkill("skill body");
		const dependencyPath = join(dirname(skill.filePath), "dependency.txt");
		await writeFile(dependencyPath, "dep-a", "utf8");
		const fixture = await createSnapshot(
			"skill body",
			["dep-a"],
			skill,
			undefined,
			undefined,
			undefined,
			true,
			dependencyPath,
		);
		const replacementPath = join(dirname(skill.filePath), "dependency-replacement.txt");
		await writeFile(replacementPath, "dep-a", "utf8");
		await unlink(dependencyPath);
		await symlink(replacementPath, dependencyPath);

		await expect(
			revalidateSkillSnapshot(fixture.snapshot, fixture.artifacts.resolver, {
				workflowId: "wf-1",
				taskId: "task-1",
				decisionRef: DECISION_REF,
				configDigest: "config-1",
				workspaceDigest: "workspace-1",
				attemptId: "attempt-1",
				epochRef: EPOCH,
				dependencyManifestDigest: fixture.snapshot.dependencyManifestDigest,
				loader: fixture.loader,
				workflowContractRevision: 1,
				receiptContext: fixture.receiptContext,
				trustedNow: fixture.trustedNow,
				journalHeadDigest: "head-1",
			}),
		).rejects.toThrow(/dependency|realpath|changed|drift/i);
	});

	it("rejects an identical-byte replacement with a different file identity", async () => {
		const skill = await createFixtureSkill("skill body");
		const dependencyPath = join(dirname(skill.filePath), "dependency.txt");
		await writeFile(dependencyPath, "dep-a", "utf8");
		const fixture = await createSnapshot(
			"skill body",
			["dep-a"],
			skill,
			undefined,
			undefined,
			undefined,
			true,
			dependencyPath,
		);
		await unlink(dependencyPath);
		await writeFile(dependencyPath, "dep-a", "utf8");

		await expect(
			revalidateSkillSnapshot(fixture.snapshot, fixture.artifacts.resolver, {
				workflowId: "wf-1",
				taskId: "task-1",
				decisionRef: DECISION_REF,
				configDigest: "config-1",
				workspaceDigest: "workspace-1",
				attemptId: "attempt-1",
				epochRef: EPOCH,
				dependencyManifestDigest: fixture.snapshot.dependencyManifestDigest,
				loader: fixture.loader,
				workflowContractRevision: 1,
				receiptContext: fixture.receiptContext,
				trustedNow: fixture.trustedNow,
				journalHeadDigest: "head-1",
			}),
		).rejects.toThrow(/dependency|identity|changed|drift/i);
	});

	it("pins every Python package source and manifest byte and rejects package drift", async () => {
		const skill = await createFixtureSkill("skill body", "python");
		const { snapshot, artifacts, loader, receiptContext, trustedNow } = await createSnapshot("skill body", [], skill);
		if (skill.kind !== "python") throw new Error("fixture did not create a Python skill");

		expect(snapshot.packageSourceNames).toEqual(["pyproject.toml", "src/fixture/__init__.py"]);
		expect(snapshot.packageArtifactRefs).toHaveLength(2);
		await writeFile(join(skill.python.packagePath, "src", "fixture", "__init__.py"), "VALUE = 2\n", "utf8");
		await expect(
			revalidateSkillSnapshot(snapshot, artifacts.resolver, {
				workflowId: "wf-1",
				taskId: "task-1",
				decisionRef: DECISION_REF,
				configDigest: "config-1",
				workspaceDigest: "workspace-1",
				attemptId: "attempt-1",
				epochRef: EPOCH,
				dependencyManifestDigest: snapshot.dependencyManifestDigest,
				loader,
				workflowContractRevision: 1,
				receiptContext,
				trustedNow,
				journalHeadDigest: "head-1",
			}),
		).rejects.toThrow(/package|metadata|drift/i);
	});

	it("rejects a Python package path alias even when the aliased bytes are unchanged", async () => {
		const skill = await createFixtureSkill("skill body", "python");
		if (skill.kind !== "python") throw new Error("fixture did not create a Python skill");
		const aliasTarget = join(skill.python.packagePath, "src", "fixture", "alias-target.py");
		const packageSource = join(skill.python.packagePath, "src", "fixture", "__init__.py");
		await writeFile(aliasTarget, "VALUE = 1\n", "utf8");
		const fixture = await createSnapshot("skill body", [], skill);
		await unlink(packageSource);
		await symlink(aliasTarget, packageSource);

		await expect(
			revalidateSkillSnapshot(fixture.snapshot, fixture.artifacts.resolver, {
				workflowId: "wf-1",
				taskId: "task-1",
				decisionRef: DECISION_REF,
				configDigest: "config-1",
				workspaceDigest: "workspace-1",
				attemptId: "attempt-1",
				epochRef: EPOCH,
				dependencyManifestDigest: fixture.snapshot.dependencyManifestDigest,
				loader: fixture.loader,
				workflowContractRevision: 1,
				receiptContext: fixture.receiptContext,
				trustedNow: fixture.trustedNow,
				journalHeadDigest: "head-1",
			}),
		).rejects.toThrow(/alias|package|changed|drift/i);
	});

	it("fails closed when a pinned source artifact is deleted", async () => {
		const { snapshot, artifacts, loader, receiptContext, trustedNow } = await createSnapshot();
		artifacts.bytesByDigest.delete(snapshot.sourceArtifactRef.digest);
		await expect(
			revalidateSkillSnapshot(snapshot, artifacts.resolver, {
				workflowId: "wf-1",
				taskId: "task-1",
				decisionRef: DECISION_REF,
				configDigest: "config-1",
				workspaceDigest: "workspace-1",
				attemptId: "attempt-1",
				epochRef: EPOCH,
				dependencyManifestDigest: snapshot.dependencyManifestDigest,
				loader,
				workflowContractRevision: 1,
				receiptContext,
				trustedNow,
				journalHeadDigest: "head-1",
			}),
		).rejects.toThrow(/source|artifact|immutable/i);
	});

	it("requires host-pinned source bytes to use a binary immutable artifact envelope", async () => {
		await expect(
			createSnapshot("skill body", [], undefined, undefined, async (skill, artifacts) => {
				const bytes = Uint8Array.from(await readFile(skill.filePath));
				const sourceRef: WorkflowArtifactRef = {
					artifactId: "host-source",
					relativePath: "artifacts/skills/host-source",
					digest: sha256Hex(bytes),
					sizeBytes: bytes.byteLength,
					sourceEventSequence: 1,
				};
				artifacts.seed(sourceRef, bytes, "evidence", "canonical_json");
				return {
					sourcePath: skill.filePath,
					sourceBytes: bytes,
					sourceRef,
					packageSources: [],
				};
			}),
		).rejects.toThrow(/artifact|binary|codec|immutable/i);
	});

	it("pins source identity to the realpath and rejects a later symlink swap", async () => {
		const target = await createFixtureSkill("skill body");
		const aliasDirectory = await mkdtemp(join(tmpdir(), "workflow-skill-alias-"));
		const aliasPath = join(aliasDirectory, "SKILL.md");
		await symlink(target.filePath, aliasPath);
		const aliasedSkill: Skill = {
			...target,
			filePath: aliasPath,
			sourceInfo: { ...target.sourceInfo, path: aliasPath },
		};
		const fixture = await createSnapshot("skill body", [], aliasedSkill);
		const canonicalPath = await realpath(target.filePath);
		expect(fixture.snapshot.canonicalPath).toBe(canonicalPath);
		expect(fixture.snapshot.sourceInfo.path).toBe(canonicalPath);

		const replacement = await createFixtureSkill("replacement body");
		await unlink(aliasPath);
		await symlink(replacement.filePath, aliasPath);
		await expect(
			revalidateSkillSnapshot(fixture.snapshot, fixture.artifacts.resolver, {
				workflowId: "wf-1",
				taskId: "task-1",
				decisionRef: DECISION_REF,
				configDigest: "config-1",
				workspaceDigest: "workspace-1",
				attemptId: "attempt-1",
				epochRef: EPOCH,
				dependencyManifestDigest: fixture.snapshot.dependencyManifestDigest,
				loader: fixture.loader,
				workflowContractRevision: 1,
				receiptContext: fixture.receiptContext,
				trustedNow: fixture.trustedNow,
				journalHeadDigest: "head-1",
			}),
		).rejects.toThrow(/path|source|drift|changed/i);
	});
});
