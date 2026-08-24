import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.js";
import { emptyGoalState, type GoalState } from "../../src/core/goals.js";
import { HOST_REQUEST_GATEWAY_VERSION, type HostRequestContext } from "../../src/core/kernel/index.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { type DurableApprovalSecretProof, digestObject } from "../../src/core/workflow/contracts.js";
import {
	createPrimeWorkflowBuiltinAdapters,
	type PrimeWorkflowAuthenticatedAdapterFactory,
} from "../../src/core/workflow/prime-loop.js";
import { createPersistedSessionWorkflowHost } from "../../src/core/workflow/session-host-factory.js";
import { createPrimeWorkflowFixture } from "./prime-loop-fixtures.js";

const EPOCH = { storeEpoch: 1, coordinatorEpoch: 1 } as const;

function freezePersisted<T>(value: T, seen = new Set<object>()): T {
	if (typeof value !== "object" || value === null || seen.has(value)) return value;
	if (ArrayBuffer.isView(value)) return value;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		freezePersisted((value as Record<PropertyKey, unknown>)[key], seen);
	}
	return Object.freeze(value);
}

function forgeRecipeRegistration(
	recipe: Awaited<ReturnType<typeof createPrimeWorkflowFixture>>["snapshots"]["recipe"],
): Awaited<ReturnType<typeof createPrimeWorkflowFixture>>["snapshots"]["recipe"] {
	const forged = structuredClone(recipe);
	if (forged.registrationReceipt === undefined || forged.registrationReceiptProof === undefined)
		throw new Error("prime_fixture_registration_receipt_missing");
	forged.recipeBinding.overfittingGate.freshnessDigest = "f".repeat(64);
	forged.recipeDigest = digestObject(forged.recipeBinding);
	forged.registrationReceipt.payload.recipeDigest = forged.recipeDigest;
	forged.registrationReceipt.receipt.payloadDigest = digestObject(forged.registrationReceipt.payload);
	const bindingDigest = digestObject({
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
	forged.registrationReceipt.receipt.bindingDigest = bindingDigest;
	forged.registrationReceipt.consumptionWitness.bindingDigest = bindingDigest;
	forged.registrationReceiptProof.bindingDigest = bindingDigest;
	forged.registrationReceiptProof.witnessDigest = digestObject(forged.registrationReceipt.consumptionWitness);
	forged.registrationReceipt.receipt.verificationDigest = digestObject({
		...forged.registrationReceipt.receipt,
		verificationDigest: "",
	});
	forged.registrationReceiptDigest = forged.registrationReceipt.receipt.verificationDigest;
	forged.registrationReceiptProof.receiptDigest = digestObject(forged.registrationReceipt.receipt);
	forged.registrationReceiptProof.admissionPreimageDigest = forged.recipeDigest;
	const {
		signature: _signature,
		verificationDigest: _verificationDigest,
		...signedFields
	} = forged.registrationReceipt.receipt;
	forged.registrationReceiptProof.signedReceiptPreimageDigest = digestObject(signedFields);
	const { admissionDigest: _admissionDigest, ...withoutAdmissionDigest } = forged;
	forged.admissionDigest = digestObject(withoutAdmissionDigest);
	return freezePersisted(forged);
}

function goalProjection(initial: GoalState = emptyGoalState()): {
	read(): GoalState;
	compareAndSwap(expected: GoalState, next: GoalState): boolean;
} {
	let current = structuredClone(initial);
	return {
		read: () => structuredClone(current),
		compareAndSwap: (expected, next) => {
			if (JSON.stringify(expected) !== JSON.stringify(current)) return false;
			current = structuredClone(next);
			return true;
		},
	};
}

interface OwnerProcessReady {
	readonly child: ChildProcess;
	readonly ready: Promise<{
		readonly approvalRequestId: string;
		readonly proof: DurableApprovalSecretProof;
		readonly goal: GoalState;
		readonly prime: boolean;
	}>;
}

function startOwnerProcess(artifactRoot: string): OwnerProcessReady {
	const script = `
import { emptyGoalState } from "./src/core/goals.ts";
import { createPersistedSessionWorkflowHost } from "./src/core/workflow/session-host-factory.ts";
import { createPrimeWorkflowFixture } from "./test/workflow/prime-loop-fixtures.ts";
const artifactRoot = process.argv[1];
const workflowId = "prime-loop-session";
const epoch = { storeEpoch: 1, coordinatorEpoch: 1 };
const fixture = await createPrimeWorkflowFixture(artifactRoot, workflowId, epoch);
let goal = emptyGoalState();
let approvalProof;
const host = await createPersistedSessionWorkflowHost({
  artifactRoot, rootSessionId: workflowId, workflowId, genesisEpoch: epoch,
  primeWorkflowSnapshots: fixture.snapshots, primeWorkflowAdaptersFactory: fixture.adaptersFactory,
  approvalSecretDelivery: ({ proof }) => { approvalProof = proof; },
  goalProjection: { read: () => structuredClone(goal), compareAndSwap: (expected, next) => {
    if (JSON.stringify(expected) !== JSON.stringify(goal)) return false;
    goal = structuredClone(next); return true;
  } },
});
if (host.primeWorkflow === undefined) throw new Error("prime_workflow_not_composed");
console.log(JSON.stringify({ kind: "ready", prime: true }));
const pending = await host.execute({ kind: "start", request: {
  workflowId, objective: "prove durable Prime authority", requestedProfile: "parallel", maxWorkers: 3,
} });
if (pending.approvalRequest === null) throw new Error("prime_approval_not_pending");
if (approvalProof === undefined) throw new Error("prime_approval_proof_not_delivered");
console.log(JSON.stringify({ kind: "pending", approvalRequestId: pending.approvalRequest.approvalRequestId, proof: approvalProof, goal: host.status().goal }));
setInterval(() => undefined, 1000);
`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, artifactRoot], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let readyResolve: (value: {
		readonly approvalRequestId: string;
		readonly proof: DurableApprovalSecretProof;
		readonly goal: GoalState;
		readonly prime: boolean;
	}) => void;
	let readyReject: (error: Error) => void;
	const ready = new Promise<{
		readonly approvalRequestId: string;
		readonly proof: DurableApprovalSecretProof;
		readonly goal: GoalState;
		readonly prime: boolean;
	}>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
		for (const line of stdout.split("\n").slice(0, -1)) {
			try {
				const message = JSON.parse(line) as {
					kind?: string;
					prime?: boolean;
					approvalRequestId?: string;
					proof?: DurableApprovalSecretProof;
					goal?: GoalState;
				};
				if (
					message.kind === "pending" &&
					message.prime === undefined &&
					message.approvalRequestId !== undefined &&
					message.proof !== undefined &&
					message.goal !== undefined
				)
					readyResolve({
						approvalRequestId: message.approvalRequestId,
						proof: message.proof,
						goal: message.goal,
						prime: true,
					});
			} catch {
				// Wait until a complete JSON line is available.
			}
		}
		stdout = stdout.slice(stdout.lastIndexOf("\n") + 1);
	});
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	child.once("error", (error) => readyReject(error));
	child.once("close", (code, signal) => {
		if (code !== null && code !== 0) readyReject(new Error(`owner process exited ${code}: ${stderr}`));
		if (signal !== null && signal !== "SIGTERM")
			readyReject(new Error(`owner process exited by ${signal}: ${stderr}`));
	});
	return { child, ready };
}

async function waitForOwnerReady(owner: OwnerProcessReady): Promise<{
	readonly approvalRequestId: string;
	readonly proof: DurableApprovalSecretProof;
	readonly goal: GoalState;
	readonly prime: boolean;
}> {
	return await Promise.race([
		owner.ready,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("owner process did not publish approval")), 15_000),
		),
	]);
}

async function stopOwnerProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

describe("production Prime workflow composition", () => {
	it("rejects an adapter that replaces durable recipe admission with a no-op", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "prime-loop-noop-admission-"));
		const workflowId = "prime-loop-noop-admission";
		try {
			const fixture = await createPrimeWorkflowFixture(artifactRoot, workflowId, EPOCH);
			const bypassFactory: PrimeWorkflowAuthenticatedAdapterFactory = async (input) => {
				const authentic = await fixture.adaptersFactory(input);
				return createPrimeWorkflowBuiltinAdapters({
					...input,
					runId: input.snapshots.skills[0]?.attemptId ?? "noop-admission-run",
					executionKey: input.snapshots.skills[0]?.snapshotDigest ?? digestObject(input.snapshots.recipe),
					skillExecution: authentic.skillExecution,
					consumeRecipeAdmission: async () => undefined as never,
				});
			};
			await expect(
				createPersistedSessionWorkflowHost({
					artifactRoot,
					rootSessionId: workflowId,
					workflowId,
					genesisEpoch: EPOCH,
					primeWorkflowSnapshots: fixture.snapshots,
					primeWorkflowAdaptersFactory: bypassFactory,
					goalProjection: goalProjection(),
				}),
			).rejects.toThrow(/admission_consumption_unbound/i);
		} finally {
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});

	it("rejects a structurally rehashed recipe whose host registration signature was reused", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "prime-loop-forged-registration-"));
		const workflowId = "prime-loop-forged-registration";
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			const fixture = await createPrimeWorkflowFixture(artifactRoot, workflowId, EPOCH);
			const snapshots = freezePersisted({
				...fixture.snapshots,
				recipe: forgeRecipeRegistration(fixture.snapshots.recipe),
			});
			await expect(
				createPersistedSessionWorkflowHost({
					artifactRoot,
					rootSessionId: workflowId,
					workflowId,
					genesisEpoch: EPOCH,
					primeWorkflowSnapshots: snapshots,
					primeWorkflowAdaptersFactory: fixture.adaptersFactory,
					goalProjection: goalProjection(),
				}),
			).rejects.toThrow(/signature|receipt|registration|cryptograph|trusted/i);
		} finally {
			await host?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});

	it("binds the composed Prime workflow through AgentSession services", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "prime-loop-agent-session-"));
		const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
		const artifactRoot = sessionManager.getSessionArtifactDir();
		if (artifactRoot === undefined) throw new Error("agent_session_artifact_root_missing");
		const fixture = await createPrimeWorkflowFixture(artifactRoot, sessionManager.getSessionId(), EPOCH);
		const services = await createAgentSessionServices({
			cwd,
			agentDir: cwd,
			settingsManager: SettingsManager.inMemory(),
			goalAuthoritySourceResolver: {
				resolve: async () => ({
					objectGeneration: "1",
					bytes: new TextEncoder().encode("prime loop goal"),
					parsedObjective: "prove AgentSession Prime binding",
					boundaryIds: ["preserve-host-authority"],
					gateIds: ["prime-binding-proven"],
				}),
			},
			primeWorkflowSnapshots: fixture.snapshots,
			primeWorkflowAdaptersFactory: fixture.adaptersFactory,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		const created = await createAgentSessionFromServices({ services, sessionManager });
		try {
			const pending = await created.session.executeWorkflowCommand({
				kind: "start",
				request: {
					workflowId: sessionManager.getSessionId(),
					objective: "prove AgentSession Prime binding",
					requestedProfile: "parallel",
					maxWorkers: 2,
					acceptanceChecks: ["prime-binding-proven"],
					protectedInvariants: ["preserve-host-authority"],
					goalContract: {
						authoritativeSource: {
							kind: "immutable_object",
							uri: "fixture://prime-loop-production/objective",
							objectGeneration: "1",
							objectDigest: "32a231cb4e7b7fc052ca311baf25deaffe72ceb1073d93683a4bc168bea32eff",
							objectSizeBytes: 15,
							parsedObjective: "prove AgentSession Prime binding",
							boundaryIds: ["preserve-host-authority"],
							gateIds: ["prime-binding-proven"],
						},
						successMetrics: [
							{
								metricId: "prime-binding",
								requirementId: "prime-binding-proven",
								direction: "at_least",
								target: 1,
								tolerance: 0,
								measurement: "public_integration",
								guardIds: ["preserve-host-authority"],
							},
						],
						nonGoalIds: ["activity-is-not-completion"],
						budgets: {
							tokenLimit: 100_000,
							wallTimeLimitSeconds: 3_600,
							spendLimitMicrounits: 0,
						},
					},
				},
			});
			expect(pending.status).toBe("awaiting_user");
			expect(pending.approvalRequest?.question).toContain("maxWorkers=2");
		} finally {
			await created.session.disposeAsync();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("composes one authenticated Prime host, fences a live owner, and reopens after owner death", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "prime-loop-production-"));
		await chmod(artifactRoot, 0o700);
		const workflowId = "prime-loop-session";
		const owner = startOwnerProcess(artifactRoot);
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			const ownerReady = await waitForOwnerReady(owner);
			expect(ownerReady.prime).toBe(true);

			const liveOwnerFixture = await createPrimeWorkflowFixture(artifactRoot, workflowId, EPOCH);
			await expect(
				createPersistedSessionWorkflowHost({
					artifactRoot,
					rootSessionId: workflowId,
					workflowId,
					genesisEpoch: EPOCH,
					primeWorkflowSnapshots: liveOwnerFixture.snapshots,
					primeWorkflowAdaptersFactory: liveOwnerFixture.adaptersFactory,
					goalProjection: goalProjection(),
				}),
			).rejects.toThrow(/workflow_append_lease_foreign_owner/);

			await stopOwnerProcess(owner.child);
			const recoveredEpoch = { storeEpoch: 1, coordinatorEpoch: 2 } as const;
			const recoveredFixture = await createPrimeWorkflowFixture(artifactRoot, workflowId, recoveredEpoch);
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: workflowId,
				workflowId,
				genesisEpoch: recoveredEpoch,
				primeWorkflowSnapshots: recoveredFixture.snapshots,
				primeWorkflowAdaptersFactory: recoveredFixture.adaptersFactory,
				goalProjection: goalProjection(ownerReady.goal),
			});
			expect(host.primeWorkflow).toBeDefined();
			expect(host.primeWorkflow?.runtimeStore).toBe(host.runtimeStore);
			expect(host.primeWorkflow?.snapshots.recipe.workflowId).toBe(workflowId);
			expect(host.primeWorkflow?.plannerDirective).toContain("<prime_workflow>");
			for (const stage of recoveredFixture.snapshots.recipe.recipeBinding.proposal.stages) {
				expect(host.primeWorkflow?.plannerDirective).toContain(stage.id);
			}
			expect(host.primeWorkflow?.plannerDirective).toContain("activity, utilization, and tokens are not progress");
			expect(host.primeWorkflow?.plannerDirective).toContain("completion gate");
			expect(host.primeWorkflow?.skillExecution).toBeDefined();
			expect(host.primeWorkflow?.unavailableSubsystems).toEqual(
				expect.arrayContaining(["scheduler_resources", "learning"]),
			);
			expect(host.status().status).toBe("awaiting_user");
			expect(host.status().approvalRequest?.approvalRequestId).toBe(ownerReady.approvalRequestId);
			expect(host.status().approvalRequest?.question).toContain("cloud compute");
			expect(host.status().approvalRequest?.question).toContain("maxWorkers=3");
			expect(host.status().approvalRequest?.options.map((option) => option.optionId)).toEqual(
				expect.arrayContaining(["approve", "approve_cloud", "decline", "cancel", "revise", "restart"]),
			);
			await expect(
				host.execute({
					kind: "respond",
					approvalRequestId: ownerReady.approvalRequestId,
					optionId: "approve_cloud",
					proof: ownerReady.proof,
				}),
			).rejects.toThrow(/stale|epoch|secret proof/);
			// After the reopen the old owner's one-use proof is itself stale, so the rejection now
			// lands on proof validation rather than the epoch comparison. The property under test —
			// a superseded owner cannot approve, and the workflow stays awaiting_user — is unchanged.
			expect(host.status().status).toBe("awaiting_user");
			const capability = host.resolveHostRequestCapability?.("mempalace.recall");
			expect(capability?.capabilities).toEqual([]);
			const recall = host.hostRequestHandlers?.["workflow.v1.mempalace.recall"];
			const propose = host.hostRequestHandlers?.["workflow.v1.mempalace.propose"];
			const autoresearch = host.hostRequestHandlers?.["workflow.v1.autoresearch.run"];
			expect(recall).toBeDefined();
			expect(propose).toBeDefined();
			expect(autoresearch).toBeDefined();
			if (recall === undefined || propose === undefined || autoresearch === undefined)
				throw new Error("prime_kernel_handlers_missing");
			await expect(recall({ query: "prime", limit: 1 })).rejects.toThrow(/capability_invalid/);
			await expect(autoresearch({ recipe_digest: "a".repeat(64), evidence_refs: [] })).rejects.toThrow(
				/capability_invalid/,
			);
			const foreignContext: HostRequestContext = {
				requestId: "foreign-request",
				version: HOST_REQUEST_GATEWAY_VERSION,
				signal: new AbortController().signal,
				capability: {
					workflowId: "foreign-workflow",
					decisionId: "foreign-decision",
					decisionRevision: 1,
					capabilities: ["mempalace.recall"],
					nonce: "foreign-nonce",
					expiresAt: Date.now() + 60_000,
				},
				isCurrent: () => true,
			};
			await expect(recall({ query: "prime", limit: 1 }, foreignContext)).rejects.toThrow(/capability_invalid/);
			const replay = await host.runtimeStore.replay({ workflowId, fromSequence: 1, expectedStoreEpoch: 1 });
			expect(replay.events.filter((event) => event.payload.kind === "workflow_started")).toHaveLength(1);
			await expect(host.recoverBeforeResume()).resolves.toBeUndefined();
		} finally {
			await stopOwnerProcess(owner.child);
			await host?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});

	it("runs built-in kernel handlers only after the structured approval boundary", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "prime-loop-kernel-"));
		await chmod(artifactRoot, 0o700);
		const workflowId = "prime-loop-kernel";
		let proof: DurableApprovalSecretProof | undefined;
		let proofs: Readonly<Record<string, DurableApprovalSecretProof>> | undefined;
		let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			const fixture = await createPrimeWorkflowFixture(artifactRoot, workflowId, EPOCH);
			host = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: workflowId,
				workflowId,
				genesisEpoch: EPOCH,
				primeWorkflowSnapshots: fixture.snapshots,
				primeWorkflowAdaptersFactory: fixture.adaptersFactory,
				approvalSecretDelivery: ({ proof: delivered, proofs: deliveredProofs }) => {
					proof = delivered;
					proofs = deliveredProofs;
				},
				goalProjection: goalProjection(),
			});
			const pending = await host.execute({
				kind: "start",
				request: {
					workflowId,
					objective: "exercise bounded Prime kernel handlers",
					requestedProfile: "parallel",
					maxWorkers: 2,
				},
			});
			expect(pending.status).toBe("awaiting_user");
			if (pending.approvalRequest === null || proof === undefined || proofs?.approve_cloud === undefined)
				throw new Error("prime_approval_not_delivered");
			const approved = await host.execute({
				kind: "respond",
				approvalRequestId: pending.approvalRequest.approvalRequestId,
				optionId: "approve_cloud",
				proof: proofs.approve_cloud,
			});
			expect(approved.status).toBe("active");
			const recall = host.hostRequestHandlers?.["workflow.v1.mempalace.recall"];
			const propose = host.hostRequestHandlers?.["workflow.v1.mempalace.propose"];
			const autoresearch = host.hostRequestHandlers?.["workflow.v1.autoresearch.run"];
			if (recall === undefined || propose === undefined || autoresearch === undefined)
				throw new Error("prime_kernel_handlers_missing");
			const contextFor = (requestType: string, requestId: string): HostRequestContext => ({
				requestId,
				version: HOST_REQUEST_GATEWAY_VERSION,
				signal: new AbortController().signal,
				capability: host?.resolveHostRequestCapability?.(requestType) ?? { capabilities: [] },
				isCurrent: () => true,
			});
			const recallContext = contextFor("mempalace.recall", "mempalace-recall");
			const recallOutput = await recall({ query: "prime", limit: 1 }, recallContext);
			expect(recallOutput).toMatchObject({
				skill_id: "mempalace",
				output_kind: "evidence",
				can_authorize: false,
			});
			await expect(recall({ query: "prime", limit: 1 }, recallContext)).resolves.toMatchObject({
				skill_id: "mempalace",
				can_authorize: false,
			});
			await expect(
				propose(
					{ knowledge_kind: "how", source_evidence_refs: [{ digest: "invalid" }] },
					contextFor("mempalace.propose", "mempalace-propose"),
				),
			).rejects.toThrow(/evidence_ref.*invalid/);
			const autoresearchOutput = await autoresearch(
				{ recipe_digest: fixture.snapshots.recipe.recipeDigest, evidence_refs: [] },
				contextFor("autoresearch.run", "autoresearch-run"),
			);
			expect(autoresearchOutput).toMatchObject({
				skill_id: "autoresearch",
				output_kind: "evidence",
				can_authorize: false,
			});
		} finally {
			await host?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});
});
