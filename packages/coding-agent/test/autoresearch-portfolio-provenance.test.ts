import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
	AUTO_RESEARCH_LEGACY_PROVENANCE_IMPORT_SCHEMA_VERSION,
	type AutoResearchLegacyProvenanceImportInput,
	computeAutoResearchLegacyProvenanceBindingDigest,
	computeAutoResearchLegacyProvenanceOperationDigest,
	computeAutoResearchLegacyProvenanceResourceDigest,
	importAutoResearchLegacyScalarRunProvenance,
} from "../src/core/autoresearch/portfolio-provenance.js";
import { AUTO_RESEARCH_PROVENANCE } from "../src/core/autoresearch/provenance.js";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import {
	canonicalJsonBytes,
	digestObject,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowJournalHead,
	type WorkflowRuntimeStore,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import {
	createPersistedSessionWorkflowHost,
	type PersistedSessionWorkflowHost,
	type PersistedWorkflowCompletionReadinessAuthority,
	type PersistedWorkflowCompletionReceiptIssuer,
} from "../src/core/workflow/session-host-factory.js";

const WORKFLOW_ID = "workflow-legacy-import";
const ROOT_SESSION_ID = "session-legacy-import";
const NOW = "2026-08-17T15:00:00.000Z";
const GENESIS_EPOCH: WorkflowEpochRef = { storeEpoch: 3, coordinatorEpoch: 4 };

function createGoalProjection(): { read(): GoalState; compareAndSwap(expected: GoalState, next: GoalState): boolean } {
	let goal = emptyGoalState();
	return {
		read: () => structuredClone(goal),
		compareAndSwap: (expected, next) => {
			if (JSON.stringify(goal) !== JSON.stringify(expected)) return false;
			goal = structuredClone(next);
			return true;
		},
	};
}

function unusedReadinessAuthority(): PersistedWorkflowCompletionReadinessAuthority {
	const unused = async (): Promise<never> => {
		throw new Error("unused completion readiness authority in provenance integration test");
	};
	return {
		resolveReadiness: unused,
		resolveDigestSources: unused,
		resolveDecision: unused,
		validateDecision: unused,
		validateEvidence: unused,
		validateScorecard: unused,
		validateProgress: unused,
		validateResources: unused,
	};
}

interface CapturedHostAuthority {
	runtimeStore: WorkflowRuntimeStore;
	receiptContext: WorkflowHostReceiptConsumerContext;
	issueReceipt: PersistedWorkflowCompletionReceiptIssuer;
}

async function openHost(
	root: string,
	captured: { current?: CapturedHostAuthority },
): Promise<PersistedSessionWorkflowHost> {
	return createPersistedSessionWorkflowHost({
		artifactRoot: root,
		rootSessionId: ROOT_SESSION_ID,
		workflowId: WORKFLOW_ID,
		genesisEpoch: GENESIS_EPOCH,
		now: () => NOW,
		goalProjection: createGoalProjection(),
		completionReadinessAuthorityFactory: ({ runtimeStore, receiptContext, issueReceipt }) => {
			captured.current = { runtimeStore, receiptContext, issueReceipt };
			return { runtimeStore, authority: unusedReadinessAuthority() };
		},
	});
}

async function currentHostTuple(runtimeStore: WorkflowRuntimeStore): Promise<{
	epoch: WorkflowEpochRef;
	head: WorkflowJournalHead;
	stateDigest: string;
	revision: number;
	executionIdentity: string;
	sessionId: string;
}> {
	const durable = runtimeStore.durableContext;
	if (durable === undefined) throw new Error("test host has no durable epoch");
	const epoch = durable.epochRef;
	const replay = await runtimeStore.replay({
		workflowId: WORKFLOW_ID,
		fromSequence: 0,
		expectedStoreEpoch: epoch.storeEpoch,
	});
	if (replay.quarantined || replay.head.eventDigest === null || replay.head.sequence < 1)
		throw new Error("test host has no authenticated current head");
	return {
		epoch,
		head: replay.head,
		stateDigest: replay.head.eventDigest,
		revision: replay.head.sequence,
		executionIdentity: durable.currentLeaseRef().processIdentity,
		sessionId: ROOT_SESSION_ID,
	};
}

function legacyRunJson(): string {
	return JSON.stringify({
		schema_version: 2,
		run_id: "legacy-scalar-1",
		created_at: "2026-08-17T14:00:00.000Z",
		repo: "/fixture/repo",
		branch: "main",
		goal: "reduce the score",
		scope: ["src"],
		metric: { name: "score", direction: "lower", command: "python3 scripts/score.py", json_key: null },
		guard: null,
		target: 0,
		max_candidates: null,
		timeout_seconds: 30,
		docs: {
			goal_path: "autoresearch/goal.md",
			decisions_path: "autoresearch/decisions.md",
			goal_sha256: "goal-digest",
			decisions_sha256: "decisions-digest",
		},
		parallel: {
			max_parallel: "bank",
			max_parallel_resolved: 1,
			worktree_root: "/tmp/autoresearch-worktrees",
			prepare: null,
			lease_seconds: 120,
			allocation: { window: 8, min_per_role: 2, plateau_k: 4 },
		},
	});
}

function legacyEventsJsonl(): string {
	return [
		JSON.stringify({
			schema_version: 2,
			run_id: "legacy-scalar-1",
			seq: 0,
			time: "2026-08-17T14:00:01.000Z",
			event: "baseline",
			head: "base-commit",
			metric: 7,
			verify_log: "logs/baseline-verify.log",
			guard_log: null,
		}),
		JSON.stringify({
			schema_version: 2,
			run_id: "legacy-scalar-1",
			seq: 1,
			time: "2026-08-17T14:00:02.000Z",
			event: "stopped",
			reason: "user stop",
			head: "base-commit",
			metric: 7,
			unresolved_candidates: [],
		}),
	].join("\n");
}

function createInput(input: {
	captured: CapturedHostAuthority;
	legacyRef: WorkflowArtifactRef;
	legacyBytes: Uint8Array;
	receipt: WorkflowVerifiedHostReceipt;
	current: Awaited<ReturnType<typeof currentHostTuple>>;
}): AutoResearchLegacyProvenanceImportInput {
	const runJson = legacyRunJson();
	const eventsJsonl = legacyEventsJsonl();
	const contentDigest = sha256Hex(input.legacyBytes);
	return {
		schemaVersion: AUTO_RESEARCH_LEGACY_PROVENANCE_IMPORT_SCHEMA_VERSION,
		kind: "legacy_scalar_run_provenance_import",
		operation: "import",
		artifact: { schemaVersion: 2, runJson, eventsJsonl, contentDigest },
		legacyArtifactRef: input.legacyRef,
		provenance: AUTO_RESEARCH_PROVENANCE[0]!,
		receipt: input.receipt,
		receiptContext: input.captured.receiptContext,
		workflowId: WORKFLOW_ID,
		hostContext: {
			runtimeStore: input.captured.runtimeStore,
			now: () => NOW,
			executionIdentity: input.current.executionIdentity,
			sessionId: input.current.sessionId,
		},
	};
}

async function validInput(): Promise<{
	input: AutoResearchLegacyProvenanceImportInput;
	root: string;
	host: PersistedSessionWorkflowHost;
	captured: CapturedHostAuthority;
}> {
	const root = await mkdtemp(join(tmpdir(), "autoresearch-portfolio-provenance-"));
	const capturedHolder: { current?: CapturedHostAuthority } = {};
	const host = await openHost(root, capturedHolder);
	await host.execute({ kind: "start", request: { workflowId: WORKFLOW_ID, objective: "import legacy evidence" } });
	const captured = capturedHolder.current;
	if (captured === undefined) throw new Error("production receipt authority was not captured");
	const runJson = legacyRunJson();
	const eventsJsonl = legacyEventsJsonl();
	const legacyBytes = canonicalJsonBytes({ runJson, eventsJsonl });
	const published = await captured.runtimeStore.publishArtifact({
		workflowId: WORKFLOW_ID,
		payloadKind: "evidence",
		codec: "canonical_json",
		bytes: legacyBytes,
		sourceEventSequence: 1,
		idempotencyKey: "legacy-scalar-1",
	});
	const legacyRef = published.envelope.ref;
	const current = await currentHostTuple(captured.runtimeStore);
	const contentDigest = sha256Hex(legacyBytes);
	const legalProvenanceDigest = digestObject(AUTO_RESEARCH_PROVENANCE[0]);
	const resourceDigest = computeAutoResearchLegacyProvenanceResourceDigest({
		legacyArtifactRef: legacyRef,
		contentDigest,
		legalProvenanceDigest,
	});
	const operationDigest = computeAutoResearchLegacyProvenanceOperationDigest({
		workflowId: WORKFLOW_ID,
		resourceDigest,
		executionIdentity: current.executionIdentity,
		sessionId: current.sessionId,
	});
	const bindingDigest = computeAutoResearchLegacyProvenanceBindingDigest({
		legacyArtifactRef: legacyRef,
		contentDigest,
		legalProvenanceDigest,
		resourceDigest,
		operationDigest,
		executionIdentity: current.executionIdentity,
		sessionId: current.sessionId,
		workflowEpoch: current.epoch,
		journalHead: current.head,
		stateDigest: current.stateDigest,
		revision: current.revision,
	});
	const receipt = await captured.issueReceipt({
		receiptKind: "capability",
		workflowId: WORKFLOW_ID,
		bindingDigest,
		capability: "autoresearch.legacy_scalar_provenance_import",
		resourceDigest,
		operationDigest,
		executionIdentity: current.executionIdentity,
		sessionId: current.sessionId,
		receiptId: "legacy-import-receipt",
		oneUse: true,
		issuedAt: NOW,
		stateDigest: current.stateDigest,
		revision: current.revision,
	});
	return {
		input: createInput({ captured, legacyRef, legacyBytes, receipt, current }),
		root,
		host,
		captured,
	};
}

function principalAuthorizationInput(
	input: AutoResearchLegacyProvenanceImportInput,
): WorkflowHostPrincipalCapabilityAuthorizationInput {
	const capabilityBinding = input.receipt.capabilityBinding;
	if (capabilityBinding === undefined) throw new Error("legacy import test receipt has no capability binding");
	const durable = input.hostContext.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("legacy import test host has no durable context");
	return {
		receipt: input.receipt,
		workflowId: input.workflowId,
		bindingDigest: input.receipt.bindingDigest,
		resourceDigest: capabilityBinding.resourceDigest,
		operationDigest: capabilityBinding.operationDigest,
		stateDigest: input.receipt.stateDigest,
		revision: input.receipt.revision,
		epochRef: durable.epochRef,
		capability: "autoresearch.legacy_scalar_provenance_import",
		executionIdentity: capabilityBinding.executionIdentity ?? undefined,
		sessionId: capabilityBinding.sessionId ?? undefined,
	};
}

describe("AutoResearch legacy scalar portfolio provenance import", () => {
	it("imports opaque content-addressed bytes through the persisted host authority", async () => {
		const fixture = await validInput();
		try {
			const evidence = await importAutoResearchLegacyScalarRunProvenance(fixture.input);
			const expectedBytes = canonicalJsonBytes({
				runJson: fixture.input.artifact.runJson,
				eventsJsonl: fixture.input.artifact.eventsJsonl,
			});

			expect(evidence.schemaVersion).toBe(1);
			expect(evidence.kind).toBe("legacy_scalar_run_provenance_evidence");
			expect(Reflect.ownKeys(evidence).sort()).toEqual(
				[
					"contentBytes",
					"contentDigest",
					"hostReceipt",
					"kind",
					"legacyArtifactRef",
					"legacyRunId",
					"provenance",
					"schemaVersion",
				].sort(),
			);
			expect("runJson" in evidence).toBe(false);
			expect("eventsJsonl" in evidence).toBe(false);
			expect("candidate" in evidence).toBe(false);
			expect("frontier" in evidence).toBe(false);
			expect("measurement" in evidence).toBe(false);
			expect("metric" in evidence).toBe(false);
			expect(evidence.legacyRunId).toBe("legacy-scalar-1");
			expect(evidence.contentDigest).toBe(sha256Hex(expectedBytes));
			expect(evidence.contentBytes).toEqual([...expectedBytes]);
			expect(evidence.legacyArtifactRef.artifactId).toBe(`evidence:${evidence.contentDigest}`);
			expect(evidence.legacyArtifactRef.relativePath).toBe(`artifacts/evidence/${evidence.contentDigest}`);
			expect(evidence.hostReceipt.oneUse).toBe(true);
			expect(evidence.hostReceipt.payloadDigest).not.toBe(evidence.contentDigest);
			expect(evidence.hostReceipt.receiptKind).toBe("capability");
			expect(evidence.hostReceipt.capabilityBinding).toEqual({
				capability: "autoresearch.legacy_scalar_provenance_import",
				resourceDigest: computeAutoResearchLegacyProvenanceResourceDigest({
					legacyArtifactRef: evidence.legacyArtifactRef,
					contentDigest: evidence.contentDigest,
					legalProvenanceDigest: digestObject(evidence.provenance),
				}),
				operationDigest: expect.any(String),
				executionIdentity: fixture.input.hostContext.executionIdentity,
				sessionId: ROOT_SESSION_ID,
			});
			expect(evidence.provenance).toEqual(AUTO_RESEARCH_PROVENANCE[0]);
			expect(Object.isFrozen(evidence)).toBe(true);
			expect(Object.isFrozen(evidence.contentBytes)).toBe(true);
			expect(Object.isFrozen(evidence.legacyArtifactRef)).toBe(true);
			expect(Object.isFrozen(evidence.provenance)).toBe(true);
			expect(Object.isFrozen(evidence.hostReceipt)).toBe(true);
		} finally {
			await fixture.host.dispose?.();
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("persists the one-use consumption witness across host reopen and rejects forged or resumed imports", async () => {
		const fixture = await validInput();
		try {
			await importAutoResearchLegacyScalarRunProvenance(fixture.input);
			await fixture.host.dispose?.();
			const reopenedHolder: { current?: CapturedHostAuthority } = {};
			const reopened = await openHost(fixture.root, reopenedHolder);
			const reopenedAuthority = reopenedHolder.current;
			if (reopenedAuthority === undefined) throw new Error("reopened receipt authority was not captured");
			const reopenedInput = {
				...fixture.input,
				receiptContext: reopenedAuthority.receiptContext,
				hostContext: {
					runtimeStore: reopenedAuthority.runtimeStore,
					now: () => NOW,
					executionIdentity: fixture.input.hostContext.executionIdentity,
					sessionId: ROOT_SESSION_ID,
				},
			};
			const reopenedEvidence = await importAutoResearchLegacyScalarRunProvenance(reopenedInput);
			expect(reopenedEvidence.hostReceipt.receiptId).toBe(fixture.input.receipt.receiptId);

			const forged = {
				...reopenedInput,
				receipt: { ...reopenedInput.receipt, signature: Buffer.from("forged").toString("base64") },
			};
			await expect(importAutoResearchLegacyScalarRunProvenance(forged)).rejects.toThrow(
				/unsigned|unverifiable|signature|cryptograph/i,
			);
			const resume = { ...reopenedInput, operation: "resume" } as unknown as AutoResearchLegacyProvenanceImportInput;
			await expect(importAutoResearchLegacyScalarRunProvenance(resume)).rejects.toThrow(/resume|read.only|import/i);
			await reopened.dispose?.();
		} finally {
			await fixture.host.dispose?.();
			await rm(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects non-production refs, envelope codec tampering, legal tampering, stale authority, and unknown fields", async () => {
		const fixture = await validInput();
		try {
			const authorization = principalAuthorizationInput(fixture.input);
			const authorizer = fixture.input.receiptContext.principalAuthorizer;
			await expect(
				authorizer.authorize({ ...authorization, capability: "child_output_delivery_ack" }),
			).rejects.toThrow();
			await expect(
				authorizer.authorize({
					...authorization,
					receipt: { ...fixture.input.receipt, issuerId: "caller-forged" },
				}),
			).rejects.toThrow();
			await expect(
				authorizer.authorize({
					...authorization,
					receipt: { ...fixture.input.receipt, keyId: "forged-key-owner" },
				}),
			).rejects.toThrow();
			const ownerSubstitutionContext: WorkflowHostReceiptConsumerContext = {
				...fixture.input.receiptContext,
				principalAuthorizer: {
					authorize: async (request) => {
						const decision = await authorizer.authorize(request);
						return { ...decision, keyOwnerPrincipal: "caller-forged" };
					},
				},
			};
			await expect(
				importAutoResearchLegacyScalarRunProvenance({
					...fixture.input,
					receiptContext: ownerSubstitutionContext,
				}),
			).rejects.toThrow(/principal|owner|authorization/i);
			const missingPrincipalAuthorizer = {
				...fixture.input.receiptContext,
				principalAuthorizer: undefined,
			} as unknown as WorkflowHostReceiptConsumerContext;
			await expect(
				importAutoResearchLegacyScalarRunProvenance({
					...fixture.input,
					receiptContext: missingPrincipalAuthorizer,
				}),
			).rejects.toThrow(
				/^CONTRACT_CHANGE: portfolio provenance import requires the generic host principalAuthorizer seam\.$/,
			);
			const unknown = {
				...fixture.input,
				authority: { candidate: true },
			} as unknown as AutoResearchLegacyProvenanceImportInput;
			await expect(importAutoResearchLegacyScalarRunProvenance(unknown)).rejects.toThrow(/unknown|exact|field/i);
			const hidden = { ...fixture.input } as Record<PropertyKey, unknown>;
			Object.defineProperty(hidden, "authority", { enumerable: false, value: { candidate: true } });
			await expect(
				importAutoResearchLegacyScalarRunProvenance(hidden as unknown as AutoResearchLegacyProvenanceImportInput),
			).rejects.toThrow(/unknown|exact|field/i);
			const symbol = Symbol("authority");
			Object.defineProperty(hidden, symbol, { enumerable: true, value: true });
			await expect(
				importAutoResearchLegacyScalarRunProvenance(hidden as unknown as AutoResearchLegacyProvenanceImportInput),
			).rejects.toThrow(/unknown|exact|field/i);
			const contentMismatch = {
				...fixture.input,
				artifact: { ...fixture.input.artifact, contentDigest: "f".repeat(64) },
			};
			await expect(importAutoResearchLegacyScalarRunProvenance(contentMismatch)).rejects.toThrow(/digest/i);
			for (const unsafeRef of [
				{ artifactId: "legacy-scalar-1", relativePath: fixture.input.legacyArtifactRef.relativePath },
				{ artifactId: `evidence:${fixture.input.legacyArtifactRef.digest}`, relativePath: "../payload" },
			]) {
				await expect(
					importAutoResearchLegacyScalarRunProvenance({
						...fixture.input,
						legacyArtifactRef: { ...fixture.input.legacyArtifactRef, ...unsafeRef },
					}),
				).rejects.toThrow(/path|artifact|id/i);
			}
			for (const tamperedEnvelope of [{ codec: "utf8" as const }, { payloadKind: "handoff" as const }]) {
				const originalResolver = fixture.input.receiptContext.artifactResolver;
				const tamperedContext = {
					...fixture.input.receiptContext,
					artifactResolver: {
						resolve: async (ref: WorkflowArtifactRef) => {
							const result = await originalResolver.resolve(ref);
							if (digestObject(ref) !== digestObject(fixture.input.legacyArtifactRef)) return result;
							return { ...result, envelope: { ...result.envelope, ...tamperedEnvelope } };
						},
					},
				};
				await expect(
					importAutoResearchLegacyScalarRunProvenance({ ...fixture.input, receiptContext: tamperedContext }),
				).rejects.toThrow(/codec|payload|envelope|artifact/i);
			}
			await expect(
				importAutoResearchLegacyScalarRunProvenance({
					...fixture.input,
					provenance: { ...fixture.input.provenance, license: "GPL-3.0-only" },
				}),
			).rejects.toThrow(/provenance|manifest|receipt|binding/i);
			await expect(
				importAutoResearchLegacyScalarRunProvenance({
					...fixture.input,
					receipt: { ...fixture.input.receipt, payloadDigest: "e".repeat(64) },
				}),
			).rejects.toThrow(/digest|artifact|receipt/i);
			const revoked = fixture.input.receiptContext.revokedReceiptIds as Set<string>;
			revoked.add(fixture.input.receipt.receiptId);
			await expect(importAutoResearchLegacyScalarRunProvenance(fixture.input)).rejects.toThrow(
				/revoked|unverifiable|receipt/i,
			);
			revoked.delete(fixture.input.receipt.receiptId);
			await expect(
				importAutoResearchLegacyScalarRunProvenance({
					...fixture.input,
					hostContext: {
						runtimeStore: fixture.captured.runtimeStore,
						now: () => "2026-08-17T21:00:00.000Z",
						executionIdentity: fixture.input.hostContext.executionIdentity,
						sessionId: ROOT_SESSION_ID,
					},
				}),
			).rejects.toThrow(/expired|freshness|unverifiable|receipt/i);
			const staleEpoch = fixture.captured.runtimeStore.durableContext;
			if (staleEpoch === undefined) throw new Error("test host has no durable context");
			const staleRuntimeStore = Object.create(fixture.captured.runtimeStore) as WorkflowRuntimeStore;
			Object.defineProperty(staleRuntimeStore, "durableContext", {
				enumerable: true,
				value: {
					...staleEpoch,
					epochRef: { ...staleEpoch.epochRef, storeEpoch: staleEpoch.epochRef.storeEpoch + 1 },
				},
			});
			await expect(
				importAutoResearchLegacyScalarRunProvenance({
					...fixture.input,
					hostContext: {
						runtimeStore: staleRuntimeStore,
						now: () => NOW,
						executionIdentity: fixture.input.hostContext.executionIdentity,
						sessionId: ROOT_SESSION_ID,
					},
				}),
			).rejects.toThrow(/replay|epoch|store|host context/i);
			const staleHeadRuntimeStore = Object.create(fixture.captured.runtimeStore) as WorkflowRuntimeStore;
			Object.defineProperty(staleHeadRuntimeStore, "replay", {
				enumerable: true,
				value: async (replayInput: Parameters<WorkflowRuntimeStore["replay"]>[0]) => {
					const result = await fixture.captured.runtimeStore.replay(replayInput);
					return {
						...result,
						head: { ...result.head, sequence: result.head.sequence + 1 },
					};
				},
			});
			await expect(
				importAutoResearchLegacyScalarRunProvenance({
					...fixture.input,
					hostContext: {
						runtimeStore: staleHeadRuntimeStore,
						now: () => NOW,
						executionIdentity: fixture.input.hostContext.executionIdentity,
						sessionId: ROOT_SESSION_ID,
					},
				}),
			).rejects.toThrow(/revision|state|receipt|current/i);
		} finally {
			await fixture.host.dispose?.();
			await rm(fixture.root, { recursive: true, force: true });
		}
	});
});
