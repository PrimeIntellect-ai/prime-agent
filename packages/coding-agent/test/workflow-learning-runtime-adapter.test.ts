import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
	type WorkflowArtifactEnvelope,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowEventPayload,
	type WorkflowEvidenceEnvelope,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowRevisionTuple,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import type {
	WorkflowLearningExperienceInput,
	WorkflowLearningHost,
	WorkflowLearningHostSnapshot,
	WorkflowLearningHostWitness,
	WorkflowLearningPorts,
} from "../src/core/workflow/learning-controller.js";
import {
	createWorkflowLearningRuntimeAdapterForSessionHost,
	createWorkflowLearningRuntimeAdapterWithDurableEffects,
	issueWorkflowLearningSessionHostIdentity,
	type WorkflowLearningApprovedAuthority,
	type WorkflowLearningRuntimeBinding,
	workflowLearningAuthorityBindingDigest,
} from "../src/core/workflow/learning-runtime-adapter.js";
import { createLocalWorkflowJournalKeyProvider } from "../src/core/workflow/local-journal-keyring.js";
import type { WorkflowDeferredEventOwnerValidators } from "../src/core/workflow/reducer.js";
import {
	createPersistedSessionWorkflowHost,
	type PersistedSessionWorkflowHost,
} from "../src/core/workflow/session-host-factory.js";

const WORKFLOW_ID = "learning-runtime-intent";
const ROOT_SESSION_ID = "learning-runtime-session";
const GENESIS_EPOCH = { storeEpoch: 1, coordinatorEpoch: 1 } as const;
const REVISIONS: WorkflowRevisionTuple = {
	contractRevision: 1,
	scorecardRevision: 1,
	planRevision: 1,
	configRevision: 1,
	evidenceRevision: 1,
};
const NOW = "2026-08-16T00:00:00.000Z";
const LATER = "2026-08-16T01:00:00.000Z";

function deferredOwnerValidators(): WorkflowDeferredEventOwnerValidators {
	return {
		autoresearch: () => undefined,
		runtime: () => undefined,
		effect: () => undefined,
		recovery: () => undefined,
	};
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function stripReceiptPayload(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => stripReceiptPayload(item));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "hostReceipt" && key !== "receipt" && key !== "receipts")
			.map(([key, item]) => [key, stripReceiptPayload(item)]),
	);
}

function boundReceiptDigest(kind: string, payload: unknown, receipt: WorkflowVerifiedHostReceipt): string {
	return digestObject({
		kind,
		payloadDigest: digestObject(stripReceiptPayload(payload)),
		receiptId: receipt.receiptId,
		receiptPayloadDigest: receipt.payloadDigest,
	});
}

function receipt(id: string, bindingDigest = `${id}-binding`): WorkflowVerifiedHostReceipt {
	const normalizedBindingDigest = /^[0-9a-f]{64}$/u.test(bindingDigest)
		? bindingDigest
		: digestObject({ kind: "learning-runtime-fixture-binding", bindingDigest });
	return createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: id,
		issuerId: "fixture-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: normalizedBindingDigest,
		payloadDigest: `${id}-payload`,
		artifactRef: {
			artifactId: `receipt-${id}`,
			relativePath: `artifacts/evidence/${"0".repeat(64)}`,
			digest: "0".repeat(64),
			sizeBytes: 0,
			sourceEventSequence: 0,
		},
		issuedAt: NOW,
		validUntil: LATER,
		keyId: `key-${id}`,
		stateDigest: "state-1",
		revision: 1,
		oneUse: true,
	});
}

function rebindReceipt(
	receiptValue: WorkflowVerifiedHostReceipt,
	kind: string,
	payload: unknown,
): WorkflowVerifiedHostReceipt {
	return createFixtureHostReceipt({
		receiptKind: receiptValue.receiptKind,
		receiptId: receiptValue.receiptId,
		issuerId: receiptValue.issuerId,
		workflowId: receiptValue.workflowId,
		bindingDigest: boundReceiptDigest(kind, payload, receiptValue),
		payloadDigest: receiptValue.payloadDigest,
		artifactRef: receiptValue.artifactRef,
		issuedAt: receiptValue.issuedAt,
		validUntil: receiptValue.validUntil,
		keyId: receiptValue.keyId,
		stateDigest: receiptValue.stateDigest,
		revision: receiptValue.revision,
		oneUse: receiptValue.oneUse,
	});
}

function witness(
	stage: string,
	candidateId: string | null,
	refValue: WorkflowArtifactRef,
	current: WorkflowLearningHostSnapshot,
	payloadDigest: string,
	witnessKind: WorkflowLearningHostWitness["witnessKind"] = "evidence",
): WorkflowLearningHostWitness {
	return {
		witnessId: `${stage}-${refValue.artifactId}`,
		witnessKind,
		workflowId: current.workflowId,
		stage,
		candidateId,
		evidenceRef: refValue,
		payloadDigest,
		bytesDigest: refValue.digest,
		bytesSize: refValue.sizeBytes,
		revision: current.currentRevision,
		storeEpoch: current.storeEpoch ?? 1,
		coordinatorEpoch: current.coordinatorEpoch ?? 1,
		stateHeadDigest: current.stateHeadDigest ?? "head-1",
		trustedNow: current.trustedNow,
		oneUse: true,
	};
}

async function createFsResolver(
	root: string,
	receiptContext: WorkflowHostReceiptConsumerContext,
): Promise<WorkflowArtifactResolver> {
	return {
		resolve: async (refValue: WorkflowArtifactRef) => {
			if (!refValue.relativePath.startsWith("artifacts/") || refValue.artifactId.startsWith("receipt-"))
				return receiptContext.artifactResolver.resolve(refValue);
			const bytes = new Uint8Array(await readFile(join(root, refValue.relativePath)));
			const metadataPath = join(
				root,
				"artifacts",
				refValue.relativePath.split("/")[1]!,
				`${refValue.digest}.metadata.json`,
			);
			const envelope = parseCanonicalJsonBytes(
				new Uint8Array(await readFile(metadataPath)),
			) as unknown as WorkflowArtifactEnvelope;
			if (!sameBytes(canonicalJsonBytes(envelope), new Uint8Array(await readFile(metadataPath))))
				throw new Error("fixture metadata is not canonical");
			return {
				envelope,
				exists: true as const,
				bytes,
				verifiedDigest: sha256Hex(bytes),
				verifiedSizeBytes: bytes.byteLength,
			};
		},
	};
}

function createGoalProjection(path: string): {
	read(): GoalState;
	compareAndSwap(expected: GoalState, next: GoalState): boolean;
} {
	let goal = emptyGoalState();
	if (existsSync(path)) goal = JSON.parse(readFileSync(path, "utf8")) as GoalState;
	return {
		read: () => structuredClone(goal),
		compareAndSwap: (_expected, next) => {
			goal = structuredClone(next);
			writeFileSync(path, canonicalJsonBytes(goal), { mode: 0o600 });
			return true;
		},
	};
}

async function bootstrapWorkflow(host: PersistedSessionWorkflowHost): Promise<void> {
	const runtime = host.runtimeStore;
	const replay = await runtime.replay({ workflowId: WORKFLOW_ID, fromSequence: 0, expectedStoreEpoch: 1 });
	if (replay.events.some((event) => event.payload.kind === "workflow_started")) return;
	await host.execute({
		kind: "start",
		request: {
			workflowId: WORKFLOW_ID,
			objective: "persist learning state",
			acceptanceChecks: ["learning-runtime-state"],
			protectedInvariants: ["durable-learning-cas"],
		},
	});
}

async function runLearningRuntimeWorker(
	mode:
		| "commit"
		| "duplicate"
		| "replay"
		| "effects-crash"
		| "effects-reconcile"
		| "effects-reopen"
		| "adapter-promote"
		| "adapter-rollback"
		| "adapter-reopen",
	root: string,
	handoffPath: string,
): Promise<void> {
	const workerUrl = pathToFileURL(join(process.cwd(), "test", "workflow-learning-runtime-worker.ts")).href;
	const source = `import { runLearningRuntimeWorker } from ${JSON.stringify(workerUrl)}; await runLearningRuntimeWorker(${JSON.stringify(mode)}, ${JSON.stringify(root)}, ${JSON.stringify(handoffPath)});`;
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", source], {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0 && output.includes(`process-worker:${mode}:ok`)) resolve();
			else reject(new Error(`learning worker ${mode} failed (${code}): ${output}`));
		});
	});
}

async function writeAcceptanceRecord(root: string, host: PersistedSessionWorkflowHost): Promise<void> {
	const runtime = host.runtimeStore;
	const durable = runtime.durableContext;
	if (durable === undefined) throw new Error("workflow runtime did not expose its durable context");
	const epochRef = durable.epochRef;
	const replay = await runtime.replay({
		workflowId: WORKFLOW_ID,
		fromSequence: 0,
		expectedStoreEpoch: epochRef.storeEpoch,
	});
	const keyProvider = createLocalWorkflowJournalKeyProvider({
		sessionArtifactRoot: root,
		rootSessionId: ROOT_SESSION_ID,
	});
	const key = await keyProvider.current(WORKFLOW_ID, epochRef);
	const unsigned = {
		version: 1,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		head: replay.head,
		acceptance: { acceptanceCheckIds: ["state-replays"], protectedInvariantIds: ["durable-cas"] },
		keyId: key.keyId,
		generationId: key.generationId,
	};
	const mac = createHmac("sha256", key.secret).update(canonicalJsonBytes(unsigned)).digest("hex");
	await writeFile(
		join(root, "workflows", WORKFLOW_ID, "side-records", "acceptance.json"),
		canonicalJsonBytes({ ...unsigned, mac }),
		{ mode: 0o600 },
	);
}

function createPorts(current: WorkflowLearningHostSnapshot): WorkflowLearningPorts {
	const host: WorkflowLearningHost = {
		current: async () => current,
		createCandidate: async () => {
			throw new Error("candidate stage is not used by this intent test");
		},
		runShadow: async () => {
			throw new Error("shadow stage is not used by this intent test");
		},
		runCanary: async () => {
			throw new Error("canary stage is not used by this intent test");
		},
		runIndependentRedTeam: async () => {
			throw new Error("red-team stage is not used by this intent test");
		},
		resolveDecision: async () => {
			throw new Error("decision stage is not used by this intent test");
		},
		classifyCandidate: async () => {
			throw new Error("candidate classifier is not used by this intent test");
		},
		resolveEvidence: async ({ stage, candidateId, evidenceRefs, payloadDigest }) =>
			evidenceRefs.map((refValue) => witness(stage, candidateId, refValue, current, payloadDigest)),
		promote: async () => {
			throw new Error("promotion stage is not used by this intent test");
		},
		reconcilePromotion: async () => {
			throw new Error("promotion reconciliation is not used by this intent test");
		},
		proposeRollback: async () => {
			throw new Error("rollback stage is not used by this intent test");
		},
		applyRollback: async () => {
			throw new Error("rollback application is not used by this intent test");
		},
	};
	return {
		evidenceValidator: {
			validate: async () => ({ accepted: true, code: "accepted", evidenceDigest: "evidence-digest", findings: [] }),
		},
		decisionGate: {
			validateVerdicts: async () => undefined,
			authorize: async () => "authorized",
		},
		receiptPort: {
			verify: async ({ receipt: value, bindingDigest, stage, candidateId }) =>
				witness(stage, candidateId, value.artifactRef, current, bindingDigest, "receipt"),
			consume: async ({ receipt: value, bindingDigest, stage, candidateId }) =>
				witness(stage, candidateId, value.artifactRef, current, bindingDigest, "receipt"),
		},
		host,
		eventSink: undefined,
	};
}

function createExperience(
	sourceEventRef: WorkflowArtifactRef,
	progressRef: WorkflowArtifactRef,
): WorkflowLearningExperienceInput {
	const evidence: WorkflowEvidenceEnvelope = {
		evidenceId: "evidence-durable-1",
		evidenceRevision: REVISIONS.evidenceRevision,
		requirementId: "requirement-durable",
		claim: "The durable host observed the learning progress.",
		result: "exit-zero",
		method: "host-runtime-intent",
		command: null,
		artifactObservations: [
			{
				artifactRef: progressRef,
				exists: true,
				verifiedDigest: progressRef.digest,
				verifiedSizeBytes: progressRef.sizeBytes,
			},
		],
		scanner: {
			scannerDigest: "scanner-durable",
			scanStatus: "passed",
			redactionStatus: "not_required",
			findingCodes: [],
			findingDigest: "findings-durable",
		},
		confidence: "high",
		limitations: [],
		workspaceDigest: "workspace-1",
		configDigest: "config-1",
		revisions: REVISIONS,
		evaluatorDigest: "evaluator-1",
		parserDigest: "parser-1",
		guardDigest: "guard-1",
		updatedDigest: "updated-durable",
		invalidatedByDecisionRef: null,
		regressed: false,
		auditorDecisionRef: null,
		observedAt: NOW,
		freshUntil: LATER,
		freshnessWindowMilliseconds: 3_600_000,
	};
	const value: WorkflowLearningExperienceInput = {
		experienceId: "experience-durable-1",
		workflowId: WORKFLOW_ID,
		source: "host",
		outcome: "positive",
		progressKind: "verified",
		progressEvidenceRefs: [progressRef],
		evidence: [evidence],
		committedAt: NOW,
		sourceEventRef,
		hostReceipt: receipt("experience"),
	};
	value.hostReceipt = rebindReceipt(value.hostReceipt, "committed_experience", {
		experienceId: value.experienceId,
		workflowId: value.workflowId,
		outcome: value.outcome,
		progressKind: value.progressKind,
		progressEvidenceRefs: value.progressEvidenceRefs,
		evidenceDigest: digestObject(value.evidence),
		sourceEventRef: value.sourceEventRef,
	});
	return value;
}

async function publishFixtureArtifact(host: PersistedSessionWorkflowHost, id: string): Promise<WorkflowArtifactRef> {
	const bytes = canonicalJsonBytes({ fixture: id });
	return (
		await host.runtimeStore.publishArtifact({
			workflowId: WORKFLOW_ID,
			payloadKind: "evidence",
			bytes,
			codec: "canonical_json",
			sourceEventSequence: 0,
			idempotencyKey: `fixture:${id}`,
		})
	).envelope.ref;
}

async function createBinding(
	host: PersistedSessionWorkflowHost,
	root: string,
	current: WorkflowLearningHostSnapshot,
	approvedRefs: {
		scorecardRef: WorkflowArtifactRef;
		evaluatorRef: WorkflowArtifactRef;
		metricRef: WorkflowArtifactRef;
	},
): Promise<WorkflowLearningRuntimeBinding> {
	const replay = await host.runtimeStore.replay({
		workflowId: WORKFLOW_ID,
		fromSequence: 1,
		expectedStoreEpoch: current.storeEpoch ?? 1,
	});
	const active = JSON.parse(
		await readFile(join(root, "workflows", WORKFLOW_ID, "side-records", "active-generation.json"), "utf8"),
	) as { leaseRef: WorkflowLearningRuntimeBinding["leaseRef"] };
	const epochRef = replay.head.epochRef;
	current.storeEpoch = epochRef.storeEpoch;
	current.coordinatorEpoch = epochRef.coordinatorEpoch;
	const approvedAuthorityWithoutReceipt: Omit<WorkflowLearningApprovedAuthority, "receipt"> = {
		...approvedRefs,
		decisionRef: {
			decisionId: "approved-scorecard-decision",
			decisionScope: { kind: "workflow", workflowId: WORKFLOW_ID, rootSessionId: ROOT_SESSION_ID },
			revision: current.currentRevision,
			storeEpoch: epochRef.storeEpoch,
			coordinatorEpoch: epochRef.coordinatorEpoch,
			decisionDigest: "a".repeat(64),
		},
		owner: "autoresearch",
		producer: "autoresearch",
		kind: "methodology",
		sampleSize: 1,
		effectThreshold: 0.01,
		tolerance: 0.01,
		maxCostMicrounits: 100,
		maxLatencyMilliseconds: 100,
		evaluatorDigest: approvedRefs.evaluatorRef.digest,
		metricDigest: approvedRefs.metricRef.digest,
	};
	const approvedAuthority: WorkflowLearningApprovedAuthority = {
		...approvedAuthorityWithoutReceipt,
		receipt: receipt(
			"approved-authority",
			workflowLearningAuthorityBindingDigest({
				workflowId: WORKFLOW_ID,
				expectedHead: replay.head,
				epochRef,
				stateHeadDigest: current.stateHeadDigest ?? "head-1",
				authority: approvedAuthorityWithoutReceipt,
			}),
		),
	};
	return {
		workflowId: WORKFLOW_ID,
		expectedHead: replay.head,
		epochRef,
		leaseRef: active.leaseRef,
		writerIdentity: active.leaseRef.writerIdentity,
		executionKey: "learning-runtime-execution",
		ownerId: "learning-runtime-host",
		phase: "refining",
		semanticStateDigest: current.stateHeadDigest ?? "head-1",
		expectedGenerations: { workflow: epochRef.storeEpoch },
		approvedAuthority,
	};
}

it("persists authenticated learning state through the real session runtime and replays after reopen", async () => {
	const root = await mkdtemp(join(tmpdir(), "learning-runtime-intent-"));
	let first: PersistedSessionWorkflowHost | undefined;
	let second: PersistedSessionWorkflowHost | undefined;
	try {
		first = await createPersistedSessionWorkflowHost({
			artifactRoot: root,
			rootSessionId: ROOT_SESSION_ID,
			workflowId: WORKFLOW_ID,
			goalProjection: createGoalProjection(join(root, "goal-projection.json")),
			genesisEpoch: GENESIS_EPOCH,
			deferredOwnerValidators: deferredOwnerValidators(),
			writerIdentity: "learning-runtime-writer",
			processIdentity: "learning-runtime-process-a",
		});
		await bootstrapWorkflow(first);
		await writeAcceptanceRecord(root, first);
		const receiptContext = createFixtureHostReceiptConsumerContext();
		const resolver = await createFsResolver(join(root, "workflows", WORKFLOW_ID), receiptContext);
		const scorecardRef = await publishFixtureArtifact(first, "approved-scorecard");
		const evaluatorRef = await publishFixtureArtifact(first, "approved-evaluator");
		const metricRef = await publishFixtureArtifact(first, "approved-metric");
		const current: WorkflowLearningHostSnapshot = {
			workflowId: WORKFLOW_ID,
			stateDigest: "state-1",
			workspaceDigest: "workspace-1",
			configDigest: "config-1",
			parserDigest: "parser-1",
			evaluatorDigest: "evaluator-1",
			guardDigest: "guard-1",
			revisions: REVISIONS,
			currentRevision: 1,
			trustedNow: NOW,
			trustedClockReceipt: receipt("clock"),
			requiredFreshnessMilliseconds: 1,
			baselineRevision: 1,
			baselineDigest: "baseline-1",
			evaluatorBaselineDigest: "evaluator-baseline-1",
			metricBaselineDigest: "metric-baseline-1",
			revisionRegistryDigest: "registry-1",
			artifactResolver: resolver,
			receiptContext,
			storeEpoch: 1,
			coordinatorEpoch: 1,
			stateHeadDigest: "d".repeat(64),
		};
		const sourceEventRef = await publishFixtureArtifact(first, "source-event");
		const progressRef = await publishFixtureArtifact(first, "progress");
		const experience = createExperience(sourceEventRef, progressRef);
		let injectGoalHeadMovement = true;
		const authority = {
			runtimeStore: first.runtimeStore,
			artifactResolver: resolver,
			readBinding: async () => {
				const binding = await createBinding(first!, root, current, { scorecardRef, evaluatorRef, metricRef });
				if (!injectGoalHeadMovement) return binding;
				injectGoalHeadMovement = false;
				const expectedHead = {
					workflowId: WORKFLOW_ID,
					sequence: 0,
					eventDigest: null,
					epochRef: binding.epochRef,
				};
				const { receipt: _receipt, ...approvedAuthorityWithoutReceipt } = binding.approvedAuthority;
				return {
					...binding,
					expectedHead,
					approvedAuthority: {
						...approvedAuthorityWithoutReceipt,
						receipt: receipt(
							"approved-authority-stale-head",
							workflowLearningAuthorityBindingDigest({
								workflowId: WORKFLOW_ID,
								expectedHead,
								epochRef: binding.epochRef,
								stateHeadDigest: current.stateHeadDigest ?? "head-1",
								authority: approvedAuthorityWithoutReceipt,
							}),
						),
					},
				};
			},
		};
		const ports = createPorts(current);
		const adapter = await createWorkflowLearningRuntimeAdapterForSessionHost({
			host: issueWorkflowLearningSessionHostIdentity(first),
			ports,
			artifactResolver: resolver,
			readBinding: authority.readBinding,
		});
		const committed = await adapter.commitExperience(experience);
		expect(committed.experienceId).toBe(experience.experienceId);
		const durableAdapter = await createWorkflowLearningRuntimeAdapterWithDurableEffects({
			host: issueWorkflowLearningSessionHostIdentity(first),
			ports,
			artifactResolver: resolver,
			readBinding: authority.readBinding,
			effectAuthority: {
				runtimeStore: first.runtimeStore,
				durableContext: first.runtimeStore.durableContext!,
				reconcilePromotion: ports.host.reconcilePromotion,
				promote: ports.host.promote,
				proposeRollback: ports.host.proposeRollback,
				applyRollback: ports.host.applyRollback,
			},
		});
		expect((await durableAdapter.getState()).experiences).toHaveLength(1);
		await expect(
			createWorkflowLearningRuntimeAdapterWithDurableEffects({
				host: issueWorkflowLearningSessionHostIdentity(first),
				ports,
				artifactResolver: resolver,
				readBinding: authority.readBinding,
				effectAuthority: undefined as never,
			}),
		).rejects.toThrow("durable effect authority is required");
		await expect(
			createWorkflowLearningRuntimeAdapterWithDurableEffects({
				host: { runtimeStore: first.runtimeStore } as never,
				ports,
				artifactResolver: resolver,
				readBinding: authority.readBinding,
				effectAuthority: {
					runtimeStore: first.runtimeStore,
					durableContext: first.runtimeStore.durableContext!,
					reconcilePromotion: ports.host.reconcilePromotion,
					promote: ports.host.promote,
					proposeRollback: ports.host.proposeRollback,
					applyRollback: ports.host.applyRollback,
				},
			}),
		).rejects.toThrow("opaque persisted session host identity");
		const persistedExperienceEvent = (
			await first.runtimeStore.replay({ workflowId: WORKFLOW_ID, fromSequence: 1, expectedStoreEpoch: 1 })
		).events.find((event) => event.payload.kind === "refinement_recorded");
		expect(persistedExperienceEvent).toBeDefined();
		const persistedExperienceRef = (
			persistedExperienceEvent!.payload as Extract<WorkflowEventPayload, { kind: "refinement_recorded" }>
		).evidenceRefs[0]!;
		const persistedExperienceArtifact = parseCanonicalJsonBytes(
			new Uint8Array((await resolver.resolve(persistedExperienceRef)).bytes),
		) as { resultIdentity: string; authorityReceipt: unknown };
		expect(persistedExperienceArtifact.resultIdentity).toBe(experience.experienceId);
		expect(persistedExperienceArtifact.authorityReceipt).toBeNull();
		const duplicate = await adapter.commitExperience(experience);
		expect(duplicate.experienceId).toBe(experience.experienceId);
		const raceSourceRef = await publishFixtureArtifact(first, "race-source-event");
		const raceProgressRef = await publishFixtureArtifact(first, "race-progress");
		const raceExperience: WorkflowLearningExperienceInput = {
			...experience,
			experienceId: "experience-durable-race",
			sourceEventRef: raceSourceRef,
			progressEvidenceRefs: [raceProgressRef],
			evidence: experience.evidence.map((item) => ({
				...item,
				evidenceId: "evidence-durable-race",
				artifactObservations: item.artifactObservations.map((observation) => ({
					...observation,
					artifactRef: raceProgressRef,
					verifiedDigest: raceProgressRef.digest,
					verifiedSizeBytes: raceProgressRef.sizeBytes,
				})),
			})),
			hostReceipt: receipt("experience-durable-race"),
		};
		raceExperience.hostReceipt = rebindReceipt(raceExperience.hostReceipt, "committed_experience", {
			experienceId: raceExperience.experienceId,
			workflowId: raceExperience.workflowId,
			outcome: raceExperience.outcome,
			progressKind: raceExperience.progressKind,
			progressEvidenceRefs: raceExperience.progressEvidenceRefs,
			evidenceDigest: digestObject(raceExperience.evidence),
			sourceEventRef: raceExperience.sourceEventRef,
		});
		const racingAdapter = await createWorkflowLearningRuntimeAdapterForSessionHost({
			host: issueWorkflowLearningSessionHostIdentity(first),
			ports,
			artifactResolver: resolver,
			readBinding: () => createBinding(first!, root, current, { scorecardRef, evaluatorRef, metricRef }),
		});
		const raceResults = await Promise.all([
			adapter.commitExperience(raceExperience),
			racingAdapter.commitExperience(raceExperience),
		]);
		expect(raceResults.map((result) => result.experienceId)).toEqual([
			"experience-durable-race",
			"experience-durable-race",
		]);
		expect(
			(
				await first.runtimeStore.replay({ workflowId: WORKFLOW_ID, fromSequence: 1, expectedStoreEpoch: 1 })
			).events.filter((event) => event.payload.kind === "refinement_recorded"),
		).toHaveLength(2);

		await first.dispose?.();
		first = undefined;
		second = await createPersistedSessionWorkflowHost({
			artifactRoot: root,
			rootSessionId: ROOT_SESSION_ID,
			workflowId: WORKFLOW_ID,
			goalProjection: createGoalProjection(join(root, "goal-projection.json")),
			genesisEpoch: GENESIS_EPOCH,
			deferredOwnerValidators: deferredOwnerValidators(),
			writerIdentity: "learning-runtime-writer",
			processIdentity: "learning-runtime-process-a",
		});
		const secondAuthority = {
			runtimeStore: second.runtimeStore,
			artifactResolver: resolver,
			readBinding: () => createBinding(second!, root, current, { scorecardRef, evaluatorRef, metricRef }),
		};
		const replayed = await createWorkflowLearningRuntimeAdapterForSessionHost({
			host: issueWorkflowLearningSessionHostIdentity(second),
			ports,
			artifactResolver: resolver,
			readBinding: secondAuthority.readBinding,
		});
		expect((await replayed.getState()).experiences).toHaveLength(2);
		expect((await replayed.commitExperience(experience)).experienceId).toBe(experience.experienceId);
	} finally {
		await second?.dispose?.();
		await first?.dispose?.();
		await rm(root, { recursive: true, force: true });
	}
}, 60_000);

it("replays the authenticated learning event after an actual process restart", async () => {
	const root = await mkdtemp(join(tmpdir(), "learning-runtime-process-intent-"));
	const handoffPath = join(root, "handoff.json");
	try {
		await runLearningRuntimeWorker("commit", root, handoffPath);
		await runLearningRuntimeWorker("duplicate", root, handoffPath);
		await runLearningRuntimeWorker("replay", root, handoffPath);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("reconciles a crash-bound promotion and idempotently verifies rollback after process restart", async () => {
	const root = await mkdtemp(join(tmpdir(), "learning-runtime-effects-intent-"));
	const handoffPath = join(root, "handoff.json");
	try {
		await runLearningRuntimeWorker("effects-crash", root, handoffPath);
		await runLearningRuntimeWorker("effects-reconcile", root, handoffPath);
		await runLearningRuntimeWorker("effects-reopen", root, handoffPath);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("promotes and rolls back a future rule through the public adapter across process restarts", async () => {
	const root = await mkdtemp(join(tmpdir(), "learning-runtime-adapter-rule-intent-"));
	const handoffPath = join(root, "handoff.json");
	try {
		await runLearningRuntimeWorker("adapter-promote", root, handoffPath);
		await runLearningRuntimeWorker("adapter-rollback", root, handoffPath);
		await runLearningRuntimeWorker("adapter-reopen", root, handoffPath);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 60_000);
