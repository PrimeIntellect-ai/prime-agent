import type { WorkflowLeaseRef, WorkflowRuntimeStore } from "./contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes, sha256Hex } from "./contracts.js";
import type { WorkflowReconciliationOutcome, WorkflowRecoveryRequest } from "./recovery.js";
import {
	createWorkflowRuntimeRecoveryCoordinator,
	type WorkflowRuntimeRecoveryClaimInput,
	type WorkflowRuntimeRecoveryClaimStore,
	type WorkflowRuntimeRecoveryCoordinator,
	type WorkflowRuntimeRecoveryDependencies,
	WorkflowRuntimeRecoveryError,
	type WorkflowRuntimeRecoveryReadiness,
	type WorkflowRuntimeRecoveryStartResult,
} from "./runtime-recovery.js";

const CLAIM_RECORD_VERSION = 1 as const;
const CLAIM_NAME_PREFIX = "runtime-recovery-claim-";

/** Dependencies supplied by the host for one already-opened runtime store. */
export type WorkflowRuntimeRecoveryAdapterInput = Omit<
	WorkflowRuntimeRecoveryDependencies,
	"workflowId" | "store" | "recoveryClaims" | "readActiveLeaseRef" | "activeLeaseRef"
> & {
	readonly workflowId: string;
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly activeLeaseRef?: WorkflowLeaseRef;
	readonly readActiveLeaseRef?: () => Promise<WorkflowLeaseRef | null>;
};

/** Recovery methods exposed to the persisted session host. */
export interface WorkflowRuntimeRecoveryAdapter {
	readonly coordinator: WorkflowRuntimeRecoveryCoordinator;
	readonly readiness: () => WorkflowRuntimeRecoveryReadiness;
	recoverBeforeResume(request?: WorkflowRecoveryRequest): Promise<WorkflowRuntimeRecoveryStartResult>;
}

interface DurableRecoveryClaimRecord {
	readonly version: typeof CLAIM_RECORD_VERSION;
	readonly status: "held" | "completed" | "released";
	readonly input: WorkflowRuntimeRecoveryClaimInput;
	readonly outcome: WorkflowReconciliationOutcome | null;
	readonly recordDigest: string;
}

/**
 * Build recovery over the one runtime-store authority already opened by the host.
 *
 * Args:
 * input: Canonical runtime-store authority plus host-owned recovery managers.
 * Return: Recovery coordinator and its host-facing startup methods.
 */
export function createWorkflowRuntimeRecoveryAdapter(
	input: WorkflowRuntimeRecoveryAdapterInput,
): WorkflowRuntimeRecoveryAdapter {
	if (input.workflowId.length === 0 || input.runtimeStore.identity.workflowId !== input.workflowId)
		throw new WorkflowRuntimeRecoveryError("workflow_runtime_store_binding_invalid");
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new WorkflowRuntimeRecoveryError("workflow_recovery_claim_unavailable");
	const recoveryClaims = createDurableRecoveryClaimStore(input.runtimeStore);
	const { runtimeStore: _runtimeStore, workflowId, activeLeaseRef, readActiveLeaseRef, ...hostDependencies } = input;
	const coordinator = createWorkflowRuntimeRecoveryCoordinator({
		...hostDependencies,
		workflowId,
		store: input.runtimeStore,
		recoveryClaims,
		withRecoveryReadBoundary: <T>(boundary: string, operation: () => Promise<T>): Promise<T> =>
			durable.withExclusiveLease(boundary, operation),
		readActiveLeaseRef:
			readActiveLeaseRef ??
			(async () => {
				return activeLeaseRef ?? durable.currentLeaseRef();
			}),
	});
	return {
		coordinator,
		readiness: () => coordinator.readiness(),
		recoverBeforeResume: (request) => coordinator.startRecovery(request),
	};
}

/**
 * Persist recovery claims through the authenticated auxiliary store and lease guard.
 *
 * Args:
 * runtimeStore: The exact runtime store used by the recovery coordinator.
 * Return: Durable compare-and-set claim operations.
 */
export function createDurableRecoveryClaimStore(runtimeStore: WorkflowRuntimeStore): WorkflowRuntimeRecoveryClaimStore {
	const durable = runtimeStore.durableContext;
	if (durable === undefined) throw new WorkflowRuntimeRecoveryError("workflow_recovery_claim_unavailable");

	const claimName = (claimId: string): string => `${CLAIM_NAME_PREFIX}${sha256Hex(claimId).slice(0, 48)}`;
	const claimDigest = (record: Omit<DurableRecoveryClaimRecord, "recordDigest">): string => digestObject(record);
	const encode = (record: Omit<DurableRecoveryClaimRecord, "recordDigest">): Uint8Array =>
		canonicalJsonBytes({ ...record, recordDigest: claimDigest(record) });

	const readRecord = async (claimId: string): Promise<DurableRecoveryClaimRecord | null> => {
		const bytes = await durable.auxiliaryStore.read(claimName(claimId));
		if (bytes === null) return null;
		const parsed = parseCanonicalJsonBytes(bytes);
		if (!isDurableRecoveryClaimRecord(parsed))
			throw new WorkflowRuntimeRecoveryError("workflow_recovery_claim_corrupt");
		const unsigned: Omit<DurableRecoveryClaimRecord, "recordDigest"> = {
			version: parsed.version,
			status: parsed.status,
			input: parsed.input,
			outcome: parsed.outcome,
		};
		if (parsed.recordDigest !== claimDigest(unsigned))
			throw new WorkflowRuntimeRecoveryError("workflow_recovery_claim_corrupt");
		return parsed;
	};

	const assertInputBinding = (record: DurableRecoveryClaimRecord, input: WorkflowRuntimeRecoveryClaimInput): void => {
		if (digestObject(record.input) !== digestObject(input))
			throw new WorkflowRuntimeRecoveryError("workflow_recovery_claim_conflict");
	};

	const withClaimGuard = async <T>(
		input: WorkflowRuntimeRecoveryClaimInput,
		operation: () => Promise<T>,
	): Promise<T> =>
		durable.withExclusiveLease(`workflow-runtime-recovery-claim:${claimName(input.claimId)}`, async () => {
			if (digestObject(durable.currentLeaseRef()) !== digestObject(input.leaseRef))
				throw new WorkflowRuntimeRecoveryError("workflow_recovery_claim_epoch_changed");
			return operation();
		});

	const writeRecord = async (
		input: WorkflowRuntimeRecoveryClaimInput,
		status: DurableRecoveryClaimRecord["status"],
		outcome: WorkflowReconciliationOutcome | null,
	): Promise<void> => {
		await durable.auxiliaryStore.write(
			claimName(input.claimId),
			encode({ version: CLAIM_RECORD_VERSION, status, input, outcome }),
		);
	};

	return {
		acquire: async (input) =>
			withClaimGuard(input, async () => {
				const current = await readRecord(input.claimId);
				if (current !== null) {
					assertInputBinding(current, input);
					if (current.status === "completed") {
						if (current.outcome === null)
							throw new WorkflowRuntimeRecoveryError("workflow_recovery_claim_corrupt");
						return { status: "completed", outcome: current.outcome };
					}
					if (current.status === "held") return { status: "held" };
				}
				await writeRecord(input, "held", null);
				return { status: "acquired" };
			}),
		complete: async (input, outcome) =>
			withClaimGuard(input, async () => {
				const current = await readRecord(input.claimId);
				if (current === null) throw new WorkflowRuntimeRecoveryError("workflow_recovery_claim_missing");
				assertInputBinding(current, input);
				if (current.status === "completed") {
					if (current.outcome === null || digestObject(current.outcome) !== digestObject(outcome))
						throw new WorkflowRuntimeRecoveryError("workflow_recovery_claim_conflict");
					return;
				}
				if (current.status !== "held")
					throw new WorkflowRuntimeRecoveryError("workflow_recovery_claim_state_invalid");
				await writeRecord(input, "completed", outcome);
			}),
		release: async (input) =>
			withClaimGuard(input, async () => {
				const current = await readRecord(input.claimId);
				if (current === null) return;
				assertInputBinding(current, input);
				if (current.status === "held") await writeRecord(input, "released", null);
			}),
	};
}

function isDurableRecoveryClaimRecord(value: unknown): value is DurableRecoveryClaimRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.version === CLAIM_RECORD_VERSION &&
		(candidate.status === "held" || candidate.status === "completed" || candidate.status === "released") &&
		candidate.input !== null &&
		typeof candidate.input === "object" &&
		!Array.isArray(candidate.input) &&
		(candidate.outcome === null || (candidate.outcome !== null && typeof candidate.outcome === "object")) &&
		typeof candidate.recordDigest === "string" &&
		/^[0-9a-f]{64}$/.test(candidate.recordDigest)
	);
}
