import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CompactionAdmissionInput,
	type CompactionAuthorityHost,
	type CompactionCheckpoint,
	type CompactionExternalizationRequest,
	type CompactionExternalizationResult,
	type CompactionLease,
	createCompactionAuthority,
} from "../src/core/index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const ARTIFACT_A = `artifact://sha256/${DIGEST_A}`;
const ARTIFACT_B = `artifact://sha256/${DIGEST_B}`;
const ARTIFACT_C = `artifact://sha256/${DIGEST_C}`;
const ARTIFACT_D = `artifact://sha256/${DIGEST_D}`;
const TRANSIENT_BYTES = 237 * 1024 * 1024;

interface HostFixture {
	readonly host: CompactionAuthorityHost;
	readonly now: { value: number };
	readonly calls: {
		externalize: CompactionExternalizationRequest[];
		checkpoint: string[];
		compact: number;
		recover: string[];
		wake: string[];
	};
}

function lease(workflowId: string, deadlineAtMs = 1_000): CompactionLease {
	return { workflowId, leaseId: "lease-1", acquiredAtMs: 0, deadlineAtMs };
}

function checkpoint(
	workflowId: string,
	queueStateId: string,
	stateIds: readonly string[],
	options: { readonly externalizedState?: CompactionCheckpoint["externalizedState"] } = {},
): CompactionCheckpoint {
	return {
		workflowId,
		checkpointRef: ARTIFACT_A,
		durableBytes: 4_096,
		retainedStateIds: [...stateIds],
		requiredStateIds: [...stateIds],
		queueStateId,
		stateDigest: DIGEST_A,
		externalizedState: options.externalizedState ?? [],
		evictedStateIds: [],
		remainingTransientBytes: 0,
	};
}

function makeInput(workflowId: string, transientBytes = 0): CompactionAdmissionInput {
	return {
		workflowId,
		contextTokens: 1_200,
		contextWindowTokens: 1_280,
		reserveTokens: 100,
		transientBytes,
		durableState: [
			{ stateId: "goal-1", kind: "goal", bytes: 1_024, digest: DIGEST_A, artifactRef: ARTIFACT_A },
			{ stateId: "authority-1", kind: "authority", bytes: 1_024, digest: DIGEST_B, artifactRef: ARTIFACT_B },
			{ stateId: "evidence-1", kind: "evidence", bytes: 1_024, digest: DIGEST_C, artifactRef: ARTIFACT_C },
			{ stateId: "queue-1", kind: "queue", bytes: 1_024, digest: DIGEST_D, artifactRef: ARTIFACT_D },
		],
		requiredStateIds: ["goal-1", "authority-1", "evidence-1", "queue-1"],
		transientState:
			transientBytes === 0 ? [] : [{ stateId: "notebook-1", kind: "notebook", bytes: transientBytes, digest: null }],
	};
}

function makeHost(
	now: { value: number },
	options: { readonly deadlineAtMs?: number; readonly compactAfter?: number } = {},
): HostFixture {
	const workflowId = "workflow-compaction";
	const stateIds = ["goal-1", "authority-1", "evidence-1", "queue-1"];
	const externalizedState = [{ stateId: "notebook-1", artifactRef: ARTIFACT_B }];
	const durableCheckpoint = checkpoint(workflowId, "queue-1", stateIds, { externalizedState });
	const calls = { externalize: [], checkpoint: [], compact: 0, recover: [], wake: [] } as HostFixture["calls"];
	const host: CompactionAuthorityHost = {
		lease: lease(workflowId, options.deadlineAtMs ?? 1_000),
		nowMs: () => now.value,
		externalizeTransient: async (input): Promise<CompactionExternalizationResult> => {
			calls.externalize.push(input);
			return {
				externalizedState: input.transientState.map((item) => ({ stateId: item.stateId, artifactRef: ARTIFACT_B })),
				evictedStateIds: [],
				remainingTransientBytes: 0,
			};
		},
		checkpointDurable: async (input) => {
			calls.checkpoint.push(JSON.stringify(input));
			return {
				...durableCheckpoint,
				externalizedState: [...input.externalizedState],
				evictedStateIds: [...input.evictedStateIds],
			};
		},
		readDurableCheckpoint: async () => durableCheckpoint,
		compactContext: async (input) => {
			calls.compact += 1;
			if (options.compactAfter !== undefined) now.value = options.compactAfter;
			return {
				status: "completed",
				contextTokensAfter: 900,
				transientBytesAfter: 0,
				durableBytesAfter: input.checkpoint.durableBytes,
				failureReason: null,
			};
		},
		recoverFromCheckpoint: async (input) => {
			calls.recover.push(input.reason);
			return {
				recoveryId: "recovery-1",
				workflowId: input.workflowId,
				checkpointRef: input.checkpointRef,
				requiredStateIds: [...input.requiredStateIds],
				action: "restore_durable_checkpoint",
			};
		},
		wakeCoordinator: async (input) => {
			calls.wake.push(input.wakeIdempotencyKey);
			return { wakeIdempotencyKey: input.wakeIdempotencyKey, status: "owned" };
		},
	};
	return { host, now, calls };
}

interface PersistedCompactionRecord {
	readonly checkpoint: CompactionCheckpoint | null;
	readonly wakeKeys: readonly string[];
}

async function readPersistentCompactionRecord(path: string): Promise<PersistedCompactionRecord> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as PersistedCompactionRecord;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return { checkpoint: null, wakeKeys: [] };
		throw error;
	}
}

function makePersistentHost(
	path: string,
	now: { value: number },
	workflowId: string,
	leaseRef: CompactionLease,
): CompactionAuthorityHost {
	return {
		lease: leaseRef,
		nowMs: () => now.value,
		externalizeTransient: async (input) => ({
			externalizedState: input.transientState.map((item) => ({ stateId: item.stateId, artifactRef: ARTIFACT_B })),
			evictedStateIds: [],
			remainingTransientBytes: 0,
		}),
		checkpointDurable: async (input) => {
			const value: CompactionCheckpoint = {
				workflowId,
				checkpointRef: ARTIFACT_C,
				durableBytes: input.durableState.reduce((total, item) => total + item.bytes, 0),
				retainedStateIds: input.durableState.map((item) => item.stateId),
				requiredStateIds: [...input.requiredStateIds],
				queueStateId: input.queueStateId,
				stateDigest: DIGEST_C,
				externalizedState: [...input.externalizedState],
				evictedStateIds: [...input.evictedStateIds],
				remainingTransientBytes: 0,
			};
			const record = await readPersistentCompactionRecord(path);
			await writeFile(path, JSON.stringify({ ...record, checkpoint: value }), "utf8");
			return value;
		},
		readDurableCheckpoint: async (input) => {
			const record = await readPersistentCompactionRecord(path);
			if (
				record.checkpoint === null ||
				record.checkpoint.workflowId !== input.workflowId ||
				record.checkpoint.checkpointRef !== input.checkpointRef
			)
				throw new Error("checkpoint_missing");
			return record.checkpoint;
		},
		compactContext: async (input) => ({
			status: "completed",
			contextTokensAfter: Math.max(0, input.initialContextTokens - 1),
			transientBytesAfter: 0,
			durableBytesAfter: input.checkpoint.durableBytes,
			failureReason: null,
		}),
		recoverFromCheckpoint: async (input) => ({
			recoveryId: "recovery-persisted",
			workflowId: input.workflowId,
			checkpointRef: input.checkpointRef,
			requiredStateIds: [...input.requiredStateIds],
			action: "restore_durable_checkpoint",
		}),
		wakeCoordinator: async (input) => {
			const record = await readPersistentCompactionRecord(path);
			if (record.wakeKeys.includes(input.wakeIdempotencyKey))
				return { wakeIdempotencyKey: input.wakeIdempotencyKey, status: "already_owned" };
			await writeFile(
				path,
				JSON.stringify({ ...record, wakeKeys: [...record.wakeKeys, input.wakeIdempotencyKey] }),
				"utf8",
			);
			return { wakeIdempotencyKey: input.wakeIdempotencyKey, status: "owned" };
		},
	};
}

describe("workflow compaction authority", () => {
	it("externalizes a 237MB transient kernel value before a bounded durable checkpoint", async () => {
		const now = { value: 100 };
		const fixture = makeHost(now);
		const authority = createCompactionAuthority({ host: fixture.host, checkpointBudgetBytes: 16 * 1024 });

		const admission = await authority.admit({
			...makeInput("workflow-compaction", TRANSIENT_BYTES),
			isCompacting: true,
		});

		expect(admission.status).toBe("admitted");
		expect(admission.state.blocked_on).toBe("compaction");
		expect(admission.state.elapsed_ms).toBe(100);
		expect(fixture.calls.externalize).toHaveLength(1);
		expect(fixture.calls.externalize[0]?.transientState[0]?.bytes).toBe(TRANSIENT_BYTES);
		expect(Object.keys(fixture.calls.externalize[0] ?? {})).toEqual(["workflowId", "transientState", "deadlineAtMs"]);
		expect(fixture.calls.checkpoint).toHaveLength(1);
		expect(fixture.calls.checkpoint[0]).not.toContain("transientState");
		if (admission.admission === null) throw new Error("admission was unexpectedly skipped");
		expect(admission.admission.checkpoint.remainingTransientBytes).toBe(0);
		expect(admission.admission.checkpoint.externalizedState).toEqual([
			{ stateId: "notebook-1", artifactRef: ARTIFACT_B },
		]);

		const result = await authority.run(admission.admission);

		expect(result.status).toBe("completed");
		expect(result.usefulProgress).toBe(true);
		expect(result.compaction?.transientBytesAfter).toBe(0);
		expect(result.wake.status).toBe("owned");
		expect(result.state.blocked_on).toBeNull();
		expect(fixture.calls.compact).toBe(1);
	});

	it("keeps the host deadline fixed and recovers visibly after timeout, without heartbeat progress", async () => {
		const now = { value: 10 };
		const fixture = makeHost(now, { deadlineAtMs: 50, compactAfter: 51 });
		const authority = createCompactionAuthority({ host: fixture.host, checkpointBudgetBytes: 16 * 1024 });
		const admission = await authority.admit({ ...makeInput("workflow-compaction"), isCompacting: true });

		expect(admission.status).toBe("admitted");
		now.value = 40;
		expect(authority.projectState()).toMatchObject({
			blocked_on: "compaction",
			elapsed_ms: 40,
			lease_deadline_ms: 50,
		});

		if (admission.admission === null) throw new Error("admission was unexpectedly skipped");
		const result = await authority.run(admission.admission);

		expect(result.status).toBe("recovery_required");
		expect(result.recoveryIntent?.action).toBe("restore_durable_checkpoint");
		expect(fixture.calls.recover).toEqual(["lease_expired"]);
		expect(fixture.calls.wake).toHaveLength(1);
		expect(result.admission.lease.deadlineAtMs).toBe(50);
		expect(result.state.recovery_intent_ref).toBe("recovery-1");
		expect((await authority.run(admission.admission)).wake).toEqual(result.wake);
		expect(fixture.calls.wake).toHaveLength(1);
	});

	it("does not accept a nested checkpoint mutation after admission", async () => {
		const now = { value: 10 };
		const fixture = makeHost(now);
		const authority = createCompactionAuthority({ host: fixture.host, checkpointBudgetBytes: 16 * 1024 });
		const admitted = await authority.admit({ ...makeInput("workflow-compaction"), isCompacting: true });

		if (admitted.admission === null) throw new Error("admission was unexpectedly skipped");
		Reflect.set(admitted.admission.checkpoint as unknown as { checkpointRef: string }, "checkpointRef", ARTIFACT_B);

		const result = await authority.run(admitted.admission);

		expect(result.status).toBe("completed");
		expect(result.admission.checkpoint.checkpointRef).toBe(ARTIFACT_A);
		expect(fixture.calls.compact).toBe(1);
	});

	it("fails visibly for missing, over-budget, or raw required state instead of starting fresh", async () => {
		const now = { value: 10 };
		const fixture = makeHost(now);
		const authority = createCompactionAuthority({ host: fixture.host, checkpointBudgetBytes: 16 * 1024 });

		await expect(
			authority.admit({ ...makeInput("workflow-compaction"), requiredStateIds: ["goal-1", "missing-1"] }),
		).rejects.toMatchObject({ code: "required_durable_state_missing" });
		const overBudgetAuthority = createCompactionAuthority({ host: fixture.host, checkpointBudgetBytes: 2_000 });
		await expect(overBudgetAuthority.admit(makeInput("workflow-compaction"))).rejects.toMatchObject({
			code: "required_durable_state_over_budget",
		});

		const rawInput = {
			...makeInput("workflow-compaction", 1),
			transientState: [{ stateId: "notebook-1", kind: "notebook", bytes: 1, digest: null, rawValue: "secret" }],
		} as unknown as CompactionAdmissionInput;
		const rawAuthority = createCompactionAuthority({ host: fixture.host, checkpointBudgetBytes: 16 * 1024 });
		await expect(rawAuthority.admit(rawInput)).rejects.toMatchObject({
			code: "transient_raw_value_forbidden",
		});
		const belowThreshold = await authority.admit({
			...makeInput("workflow-compaction"),
			contextTokens: 100,
			isCompacting: true,
		});
		expect(belowThreshold.status).toBe("not_needed");
		expect(fixture.calls.externalize).toHaveLength(0);
	});

	it("reopens from a durable checkpoint and owns a queued wake exactly once", async () => {
		const directory = await mkdtemp(join(tmpdir(), "compaction-authority-"));
		const recordPath = join(directory, "checkpoint.json");
		const now = { value: 20 };
		const leaseRef = lease("workflow-compaction", 1_000);
		try {
			const first = createCompactionAuthority({
				host: makePersistentHost(recordPath, now, "workflow-compaction", leaseRef),
				checkpointBudgetBytes: 16 * 1024,
			});
			const firstAdmission = await first.admit(makeInput("workflow-compaction"));
			if (firstAdmission.admission === null) throw new Error("admission was unexpectedly skipped");
			const firstResult = await first.run(firstAdmission.admission);
			expect(firstResult.wake.status).toBe("owned");

			const reopened = createCompactionAuthority({
				host: makePersistentHost(recordPath, now, "workflow-compaction", leaseRef),
				checkpointBudgetBytes: 16 * 1024,
			});
			const resumed = await reopened.resume({
				workflowId: "workflow-compaction",
				checkpointRef: firstResult.admission.checkpoint.checkpointRef,
				contextTokens: firstResult.admission.contextTokens,
			});
			if (resumed.admission === null) throw new Error("resume was unexpectedly skipped");
			const resumedResult = await reopened.run(resumed.admission);
			const record = await readPersistentCompactionRecord(recordPath);

			expect(resumedResult.status).toBe("completed");
			expect(resumedResult.wake.status).toBe("already_owned");
			expect(record.wakeKeys).toHaveLength(1);
			expect(reopened.projectState().lease_deadline_ms).toBe(1_000);
			expect(reopened.projectState().elapsed_ms).toBe(20);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
