import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { type FileHandle, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getProcessStartId } from "../session-lease.js";
import type {
	WorkflowCanonicalJsonObject,
	WorkflowCanonicalJsonValue,
	WorkflowEpochRef,
	WorkflowLeaseRef,
} from "./contracts.js";
import { canonicalJsonBytes, parseCanonicalJsonBytes, sameWorkflowLeaseIdentity } from "./contracts.js";
import type { WorkflowAppendLease } from "./journal.js";

const RECORD_VERSION = 1 as const;
const AUTHENTICATION_ALGORITHM = "hmac-sha256" as const;
const DEFAULT_LEASE_FILE_NAME = "append-lease.json";
const DEFAULT_GUARD_FILE_NAME = "append-lease.guard";
const DEFAULT_GUARD_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_GUARD_RETRY_MILLISECONDS = 5;
const PROCESS_IDENTITY_PREFIX = "process:";
const NOFOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = fsConstants.O_DIRECTORY ?? 0;

let currentProcessIdentity: string | undefined;

export interface LocalAppendLeaseClock {
	now(): string;
	addMilliseconds(base: string, milliseconds: number): string;
}

export interface LocalAppendLeaseOptions {
	readonly sessionArtifactRoot: string;
	readonly rootDigest: string;
	readonly storeEpoch: number;
	readonly secret: Uint8Array | string;
	readonly ttlMilliseconds: number;
	readonly clock: LocalAppendLeaseClock;
	/** Synchronous host hook that replaces its canonical lease before the filesystem guard is released. */
	readonly onLeaseRefUpdated?: (workflowId: string, leaseRef: WorkflowLeaseRef) => void;
	readonly writerIdentity?: string;
	readonly processIdentity?: string;
	readonly leaseFileName?: string;
	readonly guardFileName?: string;
	readonly guardTimeoutMilliseconds?: number;
	readonly guardRetryMilliseconds?: number;
}

export type LocalAppendLeaseRecordStatus = "active" | "released";

export interface LocalAppendLeaseAuthentication {
	readonly algorithm: typeof AUTHENTICATION_ALGORITHM;
	readonly mac: string;
}

export interface LocalAppendLeaseRecord {
	readonly version: typeof RECORD_VERSION;
	readonly workflowId: string;
	readonly status: LocalAppendLeaseRecordStatus;
	readonly leaseRef: WorkflowLeaseRef;
	readonly renewedAt: string;
	readonly previousLeaseDigest: string | null;
	readonly authentication: LocalAppendLeaseAuthentication;
}

export type LocalAppendLeaseRecoveryClassification = "previous" | "next";

export interface LocalAppendLeaseRecoveryObservation {
	readonly classification: LocalAppendLeaseRecoveryClassification;
	readonly leaseRef: WorkflowLeaseRef;
}

export interface LocalAppendLeaseRecoveryInput {
	readonly workflowId: string;
	readonly previousLeaseRef: WorkflowLeaseRef;
	readonly nextLeaseRef: WorkflowLeaseRef;
	readonly previousSecret: Uint8Array | string;
	readonly nextSecret: Uint8Array | string;
	readonly rootDigest: string;
	readonly boundary: string;
	/** Require process-start evidence for both rotation owners before invoking recovery. */
	readonly requireOwnerLiveness?: boolean;
	/** Retain the exactly authenticated generation secret after a successful callback. */
	readonly persistAuthenticatedSecret?: boolean;
}

export class WorkflowLocalAppendLeaseError extends Error {
	readonly code: string;

	constructor(code: string, detail?: string) {
		super(detail === undefined ? code : `${code}: ${detail}`);
		this.name = "WorkflowLocalAppendLeaseError";
		this.code = code;
	}
}

export const LocalAppendLeaseError = WorkflowLocalAppendLeaseError;

interface LeaseFileState {
	readonly bytes: Uint8Array;
	readonly record: LocalAppendLeaseRecord;
}

interface FileHandleStat {
	isFile(): boolean;
	isDirectory(): boolean;
	readonly nlink: number;
	readonly mode: number;
}

interface LocalAppendLeaseRecordWithoutAuthentication {
	readonly version: typeof RECORD_VERSION;
	readonly workflowId: string;
	readonly status: LocalAppendLeaseRecordStatus;
	readonly leaseRef: WorkflowLeaseRef;
	readonly renewedAt: string;
	readonly previousLeaseDigest: string | null;
}

interface FilesystemGuardContext {
	readonly workflowId: string;
	readonly workflowDir: string;
	readonly leasePath: string;
	readonly token: string;
	depth: number;
}

interface DeadOwnerRecoveryContext {
	readonly workflowId: string;
	readonly writerIdentity: string;
	readonly leaseRef: WorkflowLeaseRef;
	readonly epochRef: WorkflowEpochRef;
	readonly rootDigest: string;
	active: boolean;
}

interface RecoveryGuardContext {
	readonly workflowId: string;
	secret: Uint8Array;
	classification: LocalAppendLeaseRecoveryClassification;
	leaseRef: WorkflowLeaseRef;
	active: boolean;
}

export class LocalAppendLease implements WorkflowAppendLease {
	private readonly rootPath: string;
	private secret: Uint8Array;
	private nextRotationSecret: Uint8Array | undefined;
	private readonly activeProcessIdentity = new Map<string, string>();
	private readonly filesystemGuardContext = new AsyncLocalStorage<FilesystemGuardContext>();
	private readonly deadOwnerRecoveryContext = new AsyncLocalStorage<DeadOwnerRecoveryContext>();
	private readonly recoveryGuardContext = new AsyncLocalStorage<RecoveryGuardContext>();

	constructor(private readonly options: LocalAppendLeaseOptions) {
		this.rootPath = resolve(options.sessionArtifactRoot);
		this.secret = normalizeSecret(options.secret);
		validateConfiguration(options);
	}

	async acquire(
		workflowId: string,
		writerIdentity: string,
		coordinatorEpoch: number,
		processIdentity: string,
	): Promise<WorkflowLeaseRef> {
		validateWorkflowId(workflowId);
		validateIdentity(writerIdentity, "writer_identity");
		validateIdentity(processIdentity, "process_identity");
		validatePositiveInteger(coordinatorEpoch, "coordinator_epoch");
		this.assertConfiguredIdentity(writerIdentity, processIdentity);

		return this.withFilesystemGuard(workflowId, async (workflowDir, leasePath) => {
			const current = await readLeaseFileIfPresent(leasePath, this.authenticationSecret(workflowId));
			const now = this.readTrustedNow();
			if (current !== null) {
				this.assertRecordBinding(workflowId, current.record);
				if (current.record.status === "active") {
					const ownerStatus = processIdentityStatus(current.record.leaseRef.processIdentity);
					if (ownerStatus === "dead") {
						throw new WorkflowLocalAppendLeaseError("workflow_append_lease_recovery_required");
					} else if (this.isExpired(current.record.leaseRef, now)) {
						throw new WorkflowLocalAppendLeaseError("workflow_append_lease_expired");
					} else {
						throw new WorkflowLocalAppendLeaseError("workflow_append_lease_owned");
					}
				}
				if (current.record.status === "released")
					this.assertEpochSuccessor(current.record.leaseRef, {
						storeEpoch: this.options.storeEpoch,
						coordinatorEpoch,
					});
			}

			const sequence = current === null ? 1 : current.record.leaseRef.acquisitionEventSequence + 1;
			validatePositiveInteger(sequence, "acquisition_event_sequence");
			const leaseRef = this.createLeaseRef({
				workflowId,
				writerIdentity,
				processIdentity,
				coordinatorEpoch,
				acquisitionEventSequence: sequence,
				now,
			});
			const next = this.createRecord(workflowId, leaseRef, "active", now, current?.record.leaseRef ?? null);
			if (current === null) {
				await createLeaseFileNoReplace(workflowDir, leasePath, encodeRecord(next), this.rootPath);
			} else {
				await replaceLeaseFileCas(workflowDir, leasePath, current.bytes, encodeRecord(next), this.rootPath);
			}
			this.activeProcessIdentity.set(workflowId, processIdentity);
			return leaseRef;
		});
	}

	/**
	 * Use a successor generation key for the next authenticated lease transfer.
	 *
	 * Args:
	 * secret: Secret authenticated by the successor generation.
	 * Return: Nothing.
	 */
	prepareSecretRotation(secret: Uint8Array | string): void {
		this.nextRotationSecret = normalizeSecret(secret);
	}

	/**
	 * Run the authenticated predecessor fence for a definitively dead owner.
	 *
	 * Args:
	 * input: Exact predecessor lease binding read from the durable lease and journal.
	 * operation: Generation-recovery operation that must fence the predecessor before appending.
	 * Return: The operation result.
	 */
	async withDeadOwnerRecovery<T>(
		input: {
			workflowId: string;
			writerIdentity: string;
			leaseRef: WorkflowLeaseRef;
			epochRef: WorkflowEpochRef;
			rootDigest: string;
			boundary: string;
		},
		operation: () => Promise<T>,
	): Promise<T> {
		validateWorkflowId(input.workflowId);
		validateIdentity(input.writerIdentity, "writer_identity");
		validateIdentity(input.boundary, "boundary");
		if (typeof operation !== "function")
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_operation_invalid");
		if (input.rootDigest !== this.options.rootDigest)
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_root_mismatch");
		if (!sameEpoch(input.leaseRef, input.epochRef))
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_epoch_mismatch");

		return this.withFilesystemGuard(input.workflowId, async (_workflowDir, leasePath) => {
			const current = await readRequiredLeaseFile(leasePath, this.authenticationSecret(input.workflowId));
			this.assertRecordBinding(input.workflowId, current.record);
			if (
				current.record.status !== "active" ||
				current.record.leaseRef.writerIdentity !== input.writerIdentity ||
				!sameLeaseRef(current.record.leaseRef, input.leaseRef)
			)
				throw new WorkflowLocalAppendLeaseError("workflow_append_lease_stale");
			if (processIdentityStatus(current.record.leaseRef.processIdentity) !== "dead")
				throw new WorkflowLocalAppendLeaseError("workflow_append_lease_owned");
			return this.deadOwnerRecoveryContext.run(
				{
					workflowId: input.workflowId,
					writerIdentity: input.writerIdentity,
					leaseRef: input.leaseRef,
					epochRef: input.epochRef,
					rootDigest: input.rootDigest,
					active: true,
				},
				operation,
			);
		});
	}

	/**
	 * Hold the filesystem guard while authenticating a durable lease against exactly one generation tuple.
	 *
	 * Args:
	 * input: Workflow, root, boundary, complete predecessor/successor lease refs, and candidate generation secrets.
	 * operation: Recovery callback that receives the exact authenticated lease classification.
	 * Return: The operation result.
	 */
	async withRecoveryGuard<T>(
		input: LocalAppendLeaseRecoveryInput,
		operation: (observed: LocalAppendLeaseRecoveryObservation) => Promise<T>,
	): Promise<T> {
		validateWorkflowId(input.workflowId);
		validateIdentity(input.boundary, "boundary");
		if (typeof operation !== "function")
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_operation_invalid");
		if (input.rootDigest !== this.options.rootDigest)
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_root_mismatch");
		const previousLeaseRef = { ...input.previousLeaseRef };
		const nextLeaseRef = { ...input.nextLeaseRef };
		this.assertRecoveryLeaseRef(previousLeaseRef, input.rootDigest);
		this.assertRecoveryLeaseRef(nextLeaseRef, input.rootDigest);
		if (sameLeaseRef(previousLeaseRef, nextLeaseRef))
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_recovery_ambiguous");
		const previousSecret = normalizeSecret(input.previousSecret);
		const nextSecret = normalizeSecret(input.nextSecret);

		return this.withFilesystemGuard(input.workflowId, async (_workflowDir, leasePath) => {
			const current = await readRequiredLeaseFileWithoutAuthentication(leasePath);
			this.assertRecordBinding(input.workflowId, current.record);
			if (current.record.status !== "active") throw new WorkflowLocalAppendLeaseError("workflow_append_lease_stale");

			const candidates = [
				{
					classification: "previous" as const,
					leaseRef: previousLeaseRef,
					secret: previousSecret,
				},
				{
					classification: "next" as const,
					leaseRef: nextLeaseRef,
					secret: nextSecret,
				},
			] as const;
			const authenticated = candidates.filter((candidate) =>
				hasValidRecordAuthentication(current.record, candidate.secret),
			);
			if (authenticated.length === 0)
				throw new WorkflowLocalAppendLeaseError("workflow_append_lease_authentication_invalid");
			if (authenticated.length !== 1)
				throw new WorkflowLocalAppendLeaseError("workflow_append_lease_recovery_ambiguous");
			const matched = authenticated[0];
			if (!sameLeaseRef(current.record.leaseRef, matched.leaseRef))
				throw new WorkflowLocalAppendLeaseError("workflow_append_lease_recovery_mismatch");
			if (input.requireOwnerLiveness === true)
				assertRecoveryOwnerLiveness(previousLeaseRef, nextLeaseRef, this.options.processIdentity);
			const observed: LocalAppendLeaseRecoveryObservation = {
				classification: matched.classification,
				leaseRef: { ...matched.leaseRef },
			};
			const context: RecoveryGuardContext = {
				workflowId: input.workflowId,
				secret: matched.secret,
				classification: matched.classification,
				leaseRef: { ...matched.leaseRef },
				active: true,
			};
			try {
				const result = await this.recoveryGuardContext.run(context, () => operation(observed));
				if (input.persistAuthenticatedSecret === true) {
					this.secret = new Uint8Array(context.secret);
					this.activeProcessIdentity.set(input.workflowId, context.leaseRef.processIdentity);
				}
				return result;
			} finally {
				context.active = false;
			}
		});
	}

	async renew(workflowId: string, writerIdentity: string, coordinatorEpoch: number): Promise<void> {
		validateWorkflowId(workflowId);
		validateIdentity(writerIdentity, "writer_identity");
		validatePositiveInteger(coordinatorEpoch, "coordinator_epoch");

		await this.withFilesystemGuard(workflowId, async (_workflowDir, leasePath) => {
			const current = await readRequiredLeaseFile(leasePath, this.authenticationSecret(workflowId));
			this.assertRecordBinding(workflowId, current.record);
			this.assertActiveOwner(current.record, workflowId, writerIdentity, coordinatorEpoch);
			const now = this.readTrustedNow();
			this.assertNotExpired(current.record.leaseRef, now);
			this.assertConfiguredProcessIdentity(workflowId, current.record.leaseRef.processIdentity);
			const expiresAt = this.computeExpiry(now);
			const leaseRef: WorkflowLeaseRef = { ...current.record.leaseRef, expiresAt };
			const next = this.createRecord(workflowId, leaseRef, "active", now, current.record.leaseRef);
			await replaceLeaseFileCas(_workflowDir, leasePath, current.bytes, encodeRecord(next), this.rootPath);
			this.options.onLeaseRefUpdated?.(workflowId, { ...leaseRef });
		});
	}

	async assertOwned(input: {
		workflowId: string;
		writerIdentity: string;
		leaseRef: WorkflowLeaseRef;
		epochRef: WorkflowEpochRef;
		rootDigest: string;
		boundary: string;
	}): Promise<void> {
		validateWorkflowId(input.workflowId);
		validateIdentity(input.writerIdentity, "writer_identity");
		validateIdentity(input.boundary, "boundary");
		await this.withFilesystemGuard(input.workflowId, async (_workflowDir, leasePath) => {
			const current = await readRequiredLeaseFile(leasePath, this.authenticationSecret(input.workflowId));
			this.assertOwnedRecord(current.record, input);
		});
	}

	async withExclusiveGuard<T>(
		input: {
			workflowId: string;
			writerIdentity: string;
			leaseRef: WorkflowLeaseRef;
			epochRef: WorkflowEpochRef;
			rootDigest: string;
			boundary: string;
		},
		operation: () => Promise<T>,
	): Promise<T> {
		validateWorkflowId(input.workflowId);
		validateIdentity(input.writerIdentity, "writer_identity");
		validateIdentity(input.boundary, "boundary");
		if (typeof operation !== "function")
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_operation_invalid");
		return this.withFilesystemGuard(input.workflowId, async (_workflowDir, leasePath) => {
			const current = await readRequiredLeaseFile(leasePath, this.authenticationSecret(input.workflowId));
			this.assertOwnedRecord(current.record, input);
			return operation();
		});
	}

	async observe(workflowId: string): Promise<{ writerIdentity: string; leaseRef: WorkflowLeaseRef } | null> {
		validateWorkflowId(workflowId);
		return this.withFilesystemGuard(workflowId, async (_workflowDir, leasePath) => {
			const current = await readLeaseFileIfPresent(leasePath, this.authenticationSecret(workflowId));
			if (current === null) return null;
			this.assertRecordBinding(workflowId, current.record);
			if (current.record.status === "released") return null;
			return { writerIdentity: current.record.leaseRef.writerIdentity, leaseRef: current.record.leaseRef };
		});
	}

	/**
	 * Check whether a persisted process identity is live and start-verifiable in this process.
	 *
	 * Args:
	 * processIdentity: Process identity whose liveness must be established.
	 * Return: True only when the identity has a live, matching process start marker.
	 */
	isProcessIdentityLive(processIdentity: string): boolean {
		return processIdentityStatus(processIdentity) === "live";
	}

	async rotate(input: {
		workflowId: string;
		expectedWriterIdentity: string;
		expectedLeaseRef: WorkflowLeaseRef;
		nextWriterIdentity: string;
		nextLeaseRef: WorkflowLeaseRef;
	}): Promise<void> {
		validateWorkflowId(input.workflowId);
		validateIdentity(input.expectedWriterIdentity, "expected_writer_identity");
		validateIdentity(input.nextWriterIdentity, "next_writer_identity");
		this.assertConfiguredIdentity(input.nextWriterIdentity, input.nextLeaseRef.processIdentity);

		await this.withFilesystemGuard(input.workflowId, async (workflowDir, leasePath) => {
			const current = await readRequiredLeaseFile(leasePath, this.authenticationSecret(input.workflowId));
			this.assertRecordBinding(input.workflowId, current.record);
			if (current.record.status !== "active") throw new WorkflowLocalAppendLeaseError("workflow_append_lease_stale");
			if (
				current.record.leaseRef.writerIdentity !== input.expectedWriterIdentity ||
				!sameLeaseRef(current.record.leaseRef, input.expectedLeaseRef)
			) {
				throw new WorkflowLocalAppendLeaseError("workflow_append_lease_stale");
			}
			if (input.nextLeaseRef.writerIdentity !== input.nextWriterIdentity) {
				throw new WorkflowLocalAppendLeaseError("workflow_append_lease_writer_mismatch");
			}
			if (input.nextLeaseRef.rootDigest !== this.options.rootDigest) {
				throw new WorkflowLocalAppendLeaseError("workflow_append_lease_root_mismatch");
			}
			this.assertEpochSuccessor(current.record.leaseRef, input.nextLeaseRef);
			if (input.nextLeaseRef.acquisitionEventSequence <= current.record.leaseRef.acquisitionEventSequence) {
				throw new WorkflowLocalAppendLeaseError("workflow_append_lease_sequence_invalid");
			}
			const now = this.readTrustedNow();
			this.assertTimestampNotBefore(
				input.nextLeaseRef.acquiredAt,
				current.record.leaseRef.acquiredAt,
				"acquired_at",
			);
			this.assertTimestampAfter(input.nextLeaseRef.expiresAt, now, "expires_at");
			const nextSecret = this.nextRotationSecret ?? this.authenticationSecret(input.workflowId);
			const next = this.createRecord(
				input.workflowId,
				input.nextLeaseRef,
				"active",
				now,
				current.record.leaseRef,
				nextSecret,
			);
			await replaceLeaseFileCas(workflowDir, leasePath, current.bytes, encodeRecord(next), this.rootPath);
			this.secret = nextSecret;
			this.nextRotationSecret = undefined;
			const recoveryGuard = this.recoveryGuardContext.getStore();
			if (recoveryGuard !== undefined && recoveryGuard.active && recoveryGuard.workflowId === input.workflowId) {
				recoveryGuard.secret = nextSecret;
				recoveryGuard.classification = "next";
				recoveryGuard.leaseRef = input.nextLeaseRef;
			}
			const recovery = this.deadOwnerRecoveryContext.getStore();
			if (recovery !== undefined) recovery.active = false;
			this.activeProcessIdentity.set(input.workflowId, input.nextLeaseRef.processIdentity);
		});
	}

	async release(workflowId: string, writerIdentity: string, coordinatorEpoch: number): Promise<void> {
		validateWorkflowId(workflowId);
		validateIdentity(writerIdentity, "writer_identity");
		validatePositiveInteger(coordinatorEpoch, "coordinator_epoch");
		await this.withFilesystemGuard(workflowId, async (workflowDir, leasePath) => {
			const current = await readRequiredLeaseFile(leasePath, this.authenticationSecret(workflowId));
			this.assertRecordBinding(workflowId, current.record);
			if (current.record.status === "released") {
				if (
					current.record.leaseRef.writerIdentity !== writerIdentity ||
					current.record.leaseRef.coordinatorEpoch !== coordinatorEpoch
				) {
					throw new WorkflowLocalAppendLeaseError("workflow_append_lease_stale");
				}
				return;
			}
			this.assertActiveOwner(current.record, workflowId, writerIdentity, coordinatorEpoch);
			const now = this.readTrustedNow();
			this.assertNotExpired(current.record.leaseRef, now);
			const next = this.createRecord(workflowId, current.record.leaseRef, "released", now, current.record.leaseRef);
			await replaceLeaseFileCas(workflowDir, leasePath, current.bytes, encodeRecord(next), this.rootPath);
		});
	}

	private async withFilesystemGuard<T>(
		workflowId: string,
		operation: (workflowDir: string, leasePath: string) => Promise<T>,
	): Promise<T> {
		const workflowDir = await ensureWorkflowDirectory(this.rootPath, workflowId);
		const leasePath = join(workflowDir, this.options.leaseFileName ?? DEFAULT_LEASE_FILE_NAME);
		const guardPath = join(workflowDir, this.options.guardFileName ?? DEFAULT_GUARD_FILE_NAME);
		const currentContext = this.filesystemGuardContext.getStore();
		if (
			currentContext !== undefined &&
			currentContext.workflowId === workflowId &&
			currentContext.workflowDir === workflowDir &&
			currentContext.leasePath === leasePath
		) {
			currentContext.depth += 1;
			try {
				return await operation(workflowDir, leasePath);
			} finally {
				currentContext.depth -= 1;
			}
		}
		const releaseGuard = await acquireFilesystemGuard(
			workflowDir,
			guardPath,
			this.options,
			this.rootPath,
			workflowId,
		);
		const context: FilesystemGuardContext = {
			workflowId,
			workflowDir,
			leasePath,
			token: randomUUID(),
			depth: 1,
		};
		try {
			return await this.filesystemGuardContext.run(context, () => operation(workflowDir, leasePath));
		} finally {
			await releaseGuard();
		}
	}

	private createLeaseRef(input: {
		readonly workflowId: string;
		readonly writerIdentity: string;
		readonly processIdentity: string;
		readonly coordinatorEpoch: number;
		readonly acquisitionEventSequence: number;
		readonly now: string;
	}): WorkflowLeaseRef {
		return {
			storeEpoch: this.options.storeEpoch,
			coordinatorEpoch: input.coordinatorEpoch,
			leaseId: `append-lease:${input.workflowId}:${randomUUID()}`,
			acquisitionEventSequence: input.acquisitionEventSequence,
			processIdentity: input.processIdentity,
			rootDigest: this.options.rootDigest,
			writerIdentity: input.writerIdentity,
			acquiredAt: input.now,
			expiresAt: this.computeExpiry(input.now),
		};
	}

	private createRecord(
		workflowId: string,
		leaseRef: WorkflowLeaseRef,
		status: LocalAppendLeaseRecordStatus,
		renewedAt: string,
		previous: WorkflowLeaseRef | null,
		secret = this.authenticationSecret(workflowId),
	): LocalAppendLeaseRecord {
		const unsigned: LocalAppendLeaseRecordWithoutAuthentication = {
			version: RECORD_VERSION,
			workflowId,
			status,
			leaseRef,
			renewedAt,
			previousLeaseDigest: previous === null ? null : digestLeaseRef(previous),
		};
		return {
			...unsigned,
			authentication: {
				algorithm: AUTHENTICATION_ALGORITHM,
				mac: hmacHex(secret, canonicalJsonBytes(unsigned)),
			},
		};
	}

	private assertRecordBinding(workflowId: string, record: LocalAppendLeaseRecord): void {
		if (record.workflowId !== workflowId)
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_workflow_mismatch");
		if (record.leaseRef.rootDigest !== this.options.rootDigest)
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_root_mismatch");
		if (record.leaseRef.storeEpoch !== this.options.storeEpoch)
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_epoch_mismatch");
	}

	private assertOwnedRecord(
		record: LocalAppendLeaseRecord,
		input: {
			workflowId: string;
			writerIdentity: string;
			leaseRef: WorkflowLeaseRef;
			epochRef: WorkflowEpochRef;
			rootDigest: string;
			boundary: string;
		},
	): void {
		this.assertRecordBinding(input.workflowId, record);
		if (record.status !== "active") throw new WorkflowLocalAppendLeaseError("workflow_append_lease_stale");
		if (input.rootDigest !== this.options.rootDigest || record.leaseRef.rootDigest !== input.rootDigest) {
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_root_mismatch");
		}
		if (
			record.leaseRef.writerIdentity !== input.writerIdentity ||
			!sameWorkflowLeaseIdentity(record.leaseRef, input.leaseRef)
		) {
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_stale");
		}
		const recoveryGuardRecord = this.isRecoveryGuardRecord(record, input);
		if (!sameEpoch(record.leaseRef, input.epochRef) && !recoveryGuardRecord)
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_epoch_mismatch");
		if (!recoveryGuardRecord) {
			this.assertConfiguredIdentity(input.writerIdentity, record.leaseRef.processIdentity);
			this.assertNotExpired(record.leaseRef, this.readTrustedNow());
		}
	}

	private isRecoveryGuardRecord(
		record: LocalAppendLeaseRecord,
		input: {
			workflowId: string;
			writerIdentity: string;
			leaseRef: WorkflowLeaseRef;
			epochRef: WorkflowEpochRef;
			rootDigest: string;
			boundary: string;
		},
	): boolean {
		const deadOwnerRecovery = this.deadOwnerRecoveryContext.getStore();
		if (
			deadOwnerRecovery !== undefined &&
			deadOwnerRecovery.active &&
			deadOwnerRecovery.workflowId === input.workflowId &&
			deadOwnerRecovery.writerIdentity === input.writerIdentity &&
			sameLeaseRef(deadOwnerRecovery.leaseRef, input.leaseRef) &&
			sameEpoch(deadOwnerRecovery.epochRef, input.epochRef) &&
			deadOwnerRecovery.rootDigest === input.rootDigest &&
			processIdentityStatus(record.leaseRef.processIdentity) === "dead"
		)
			return true;
		const recoveryGuard = this.recoveryGuardContext.getStore();
		return (
			recoveryGuard !== undefined &&
			recoveryGuard.active &&
			recoveryGuard.workflowId === input.workflowId &&
			sameLeaseRef(recoveryGuard.leaseRef, input.leaseRef) &&
			record.leaseRef.processIdentity === recoveryGuard.leaseRef.processIdentity &&
			(processIdentityStatus(record.leaseRef.processIdentity) === "dead" ||
				record.leaseRef.processIdentity === this.options.processIdentity)
		);
	}

	private assertActiveOwner(
		record: LocalAppendLeaseRecord,
		workflowId: string,
		writerIdentity: string,
		coordinatorEpoch: number,
	): void {
		if (record.status !== "active") throw new WorkflowLocalAppendLeaseError("workflow_append_lease_stale");
		if (
			record.workflowId !== workflowId ||
			record.leaseRef.writerIdentity !== writerIdentity ||
			record.leaseRef.coordinatorEpoch !== coordinatorEpoch
		) {
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_stale");
		}
		this.assertConfiguredProcessIdentity(workflowId, record.leaseRef.processIdentity);
		this.assertNotExpired(record.leaseRef, this.readTrustedNow());
	}

	private assertConfiguredIdentity(writerIdentity: string, processIdentity: string): void {
		if (this.options.writerIdentity !== undefined && this.options.writerIdentity !== writerIdentity) {
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_writer_mismatch");
		}
		if (this.options.processIdentity !== undefined && this.options.processIdentity !== processIdentity) {
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_process_mismatch");
		}
	}

	private assertRecoveryLeaseRef(leaseRef: WorkflowLeaseRef, rootDigest: string): void {
		if (leaseRef.rootDigest !== rootDigest || leaseRef.rootDigest !== this.options.rootDigest) {
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_root_mismatch");
		}
		if (leaseRef.storeEpoch !== this.options.storeEpoch) {
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_epoch_mismatch");
		}
	}

	private authenticationSecret(workflowId?: string): Uint8Array {
		const recovery = this.recoveryGuardContext.getStore();
		if (
			recovery !== undefined &&
			recovery.active &&
			(workflowId === undefined || recovery.workflowId === workflowId)
		) {
			return recovery.secret;
		}
		return this.secret;
	}

	private assertConfiguredProcessIdentity(workflowId: string, processIdentity: string): void {
		const expected = this.options.processIdentity ?? this.activeProcessIdentity.get(workflowId);
		if (expected === undefined)
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_process_identity_unavailable");
		if (expected !== processIdentity) throw new WorkflowLocalAppendLeaseError("workflow_append_lease_stale");
	}

	private assertEpochSuccessor(previous: WorkflowEpochRef, next: WorkflowEpochRef): void {
		if (!isPositiveInteger(next.storeEpoch) || !isPositiveInteger(next.coordinatorEpoch)) {
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_epoch_invalid");
		}
		const storeAdvanced =
			next.storeEpoch > previous.storeEpoch && next.coordinatorEpoch === previous.coordinatorEpoch;
		const coordinatorAdvanced =
			next.storeEpoch === previous.storeEpoch && next.coordinatorEpoch > previous.coordinatorEpoch;
		if (!storeAdvanced && !coordinatorAdvanced)
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_epoch_invalid");
		if (next.storeEpoch !== this.options.storeEpoch)
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_epoch_mismatch");
	}

	private readTrustedNow(): string {
		const now = this.options.clock.now();
		validateTimestamp(now, "trusted_now");
		return now;
	}

	private computeExpiry(now: string): string {
		const expiresAt = this.options.clock.addMilliseconds(now, this.options.ttlMilliseconds);
		this.assertTimestampAfter(expiresAt, now, "expires_at");
		return expiresAt;
	}

	private isExpired(leaseRef: WorkflowLeaseRef, now: string): boolean {
		return Date.parse(now) >= Date.parse(leaseRef.expiresAt);
	}

	private assertNotExpired(leaseRef: WorkflowLeaseRef, now: string): void {
		if (this.isExpired(leaseRef, now)) throw new WorkflowLocalAppendLeaseError("workflow_append_lease_expired");
	}

	private assertTimestampNotBefore(value: string, lowerBound: string, field: string): void {
		validateTimestamp(value, field);
		if (Date.parse(value) < Date.parse(lowerBound))
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_clock_regressed", field);
	}

	private assertTimestampAfter(value: string, lowerBound: string, field: string): void {
		validateTimestamp(value, field);
		if (Date.parse(value) <= Date.parse(lowerBound))
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_ttl_invalid", field);
	}
}

export function createLocalAppendLease(options: LocalAppendLeaseOptions): LocalAppendLease {
	return new LocalAppendLease(options);
}

/**
 * Build the process identity persisted in a local append lease.
 *
 * Args:
 * pid: Process identifier to bind to the identity marker.
 * Return: A PID and process-start identity suitable for lease fencing.
 */
export function createLocalAppendLeaseProcessIdentity(pid = process.pid): string {
	if (pid === process.pid && currentProcessIdentity !== undefined) return currentProcessIdentity;
	const processStartId = getProcessStartId(pid);
	const identity =
		processStartId === undefined
			? `${PROCESS_IDENTITY_PREFIX}${pid}:runtime:${randomUUID()}`
			: `${PROCESS_IDENTITY_PREFIX}${pid}:${processStartId}`;
	if (pid === process.pid) currentProcessIdentity = identity;
	return identity;
}

export const createWorkflowLocalAppendLease = createLocalAppendLease;

function validateConfiguration(options: LocalAppendLeaseOptions): void {
	if (options.sessionArtifactRoot.length === 0)
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_root_unavailable");
	if (options.rootDigest.length === 0)
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_root_digest_invalid");
	validatePositiveInteger(options.storeEpoch, "store_epoch");
	validatePositiveInteger(options.ttlMilliseconds, "ttl_milliseconds");
	if (options.writerIdentity !== undefined) validateIdentity(options.writerIdentity, "writer_identity");
	if (options.processIdentity !== undefined) validateIdentity(options.processIdentity, "process_identity");
	if (options.leaseFileName !== undefined) validateComponent(options.leaseFileName, "lease_file_name");
	if (options.guardFileName !== undefined) validateComponent(options.guardFileName, "guard_file_name");
	if (options.guardTimeoutMilliseconds !== undefined)
		validatePositiveInteger(options.guardTimeoutMilliseconds, "guard_timeout_milliseconds");
	if (options.guardRetryMilliseconds !== undefined)
		validatePositiveInteger(options.guardRetryMilliseconds, "guard_retry_milliseconds");
	if (options.onLeaseRefUpdated !== undefined && typeof options.onLeaseRefUpdated !== "function")
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_update_hook_invalid");
	if (typeof options.clock.now !== "function" || typeof options.clock.addMilliseconds !== "function") {
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_clock_invalid");
	}
}

function normalizeSecret(secret: Uint8Array | string): Uint8Array {
	const bytes = typeof secret === "string" ? new TextEncoder().encode(secret) : new Uint8Array(secret);
	if (bytes.byteLength === 0) throw new WorkflowLocalAppendLeaseError("workflow_append_lease_secret_invalid");
	return bytes;
}

function validateWorkflowId(workflowId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(workflowId))
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_workflow_id_invalid");
}

function validateComponent(component: string, field: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(component) || component === "." || component === "..") {
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_path_invalid", field);
	}
}

function validateIdentity(identity: string, field: string): void {
	if (identity.length === 0 || identity.includes("\u0000"))
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_identity_invalid", field);
}

function validatePositiveInteger(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_number_invalid", field);
}

function isPositiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function validateTimestamp(value: string, field: string): void {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_timestamp_invalid", field);
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function sameLeaseRef(left: WorkflowLeaseRef, right: WorkflowLeaseRef): boolean {
	return (
		sameEpoch(left, right) &&
		left.leaseId === right.leaseId &&
		left.acquisitionEventSequence === right.acquisitionEventSequence &&
		left.processIdentity === right.processIdentity &&
		left.rootDigest === right.rootDigest &&
		left.writerIdentity === right.writerIdentity &&
		left.acquiredAt === right.acquiredAt &&
		left.expiresAt === right.expiresAt
	);
}

function digestLeaseRef(leaseRef: WorkflowLeaseRef): string {
	return hmacHex(new TextEncoder().encode("lease-digest"), canonicalJsonBytes(leaseRef));
}

function processIdentityStatus(identity: string): "dead" | "live" | "unverifiable" {
	const parsed = parseProcessIdentity(identity);
	if (parsed === null) return "unverifiable";
	if (identity === currentProcessIdentity && parsed.pid === process.pid) return "live";
	try {
		process.kill(parsed.pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unverifiable";
	}
	if (parsed.processStartId?.startsWith("runtime:")) return "unverifiable";
	if (parsed.processStartId === undefined) return "unverifiable";
	const currentStartId = getProcessStartId(parsed.pid);
	if (currentStartId === undefined) return "unverifiable";
	return currentStartId === parsed.processStartId ? "live" : "dead";
}

function assertRecoveryOwnerLiveness(
	previousLeaseRef: WorkflowLeaseRef,
	nextLeaseRef: WorkflowLeaseRef,
	currentProcessIdentity: string | undefined,
): void {
	const previousStatus = processIdentityStatus(previousLeaseRef.processIdentity);
	if (previousStatus !== "dead")
		throw new WorkflowLocalAppendLeaseError(
			previousStatus === "live"
				? "workflow_append_lease_recovery_previous_owner_live"
				: "workflow_append_lease_recovery_previous_owner_unverifiable",
		);
	const nextStatus = processIdentityStatus(nextLeaseRef.processIdentity);
	if (nextStatus === "dead") return;
	if (nextStatus === "live" && nextLeaseRef.processIdentity === currentProcessIdentity) return;
	throw new WorkflowLocalAppendLeaseError(
		nextStatus === "live"
			? "workflow_append_lease_recovery_next_owner_live"
			: "workflow_append_lease_recovery_next_owner_unverifiable",
	);
}

function parseProcessIdentity(identity: string): { pid: number; processStartId?: string } | null {
	if (!identity.startsWith(PROCESS_IDENTITY_PREFIX)) return null;
	const separator = identity.indexOf(":", PROCESS_IDENTITY_PREFIX.length);
	const pid = Number(
		separator < 0
			? identity.slice(PROCESS_IDENTITY_PREFIX.length)
			: identity.slice(PROCESS_IDENTITY_PREFIX.length, separator),
	);
	const processStartId = separator < 0 ? undefined : identity.slice(separator + 1);
	if (!Number.isSafeInteger(pid) || pid <= 0 || (processStartId !== undefined && processStartId.length === 0))
		return null;
	return { pid, ...(processStartId === undefined ? {} : { processStartId }) };
}

function hmacHex(secret: Uint8Array, bytes: Uint8Array): string {
	return createHmac("sha256", secret).update(bytes).digest("hex");
}

function unsignedRecord(record: LocalAppendLeaseRecord): LocalAppendLeaseRecordWithoutAuthentication {
	return {
		version: record.version,
		workflowId: record.workflowId,
		status: record.status,
		leaseRef: record.leaseRef,
		renewedAt: record.renewedAt,
		previousLeaseDigest: record.previousLeaseDigest,
	};
}

function encodeRecord(record: LocalAppendLeaseRecord): Uint8Array {
	return canonicalJsonBytes(record);
}

async function ensureWorkflowDirectory(rootPath: string, workflowId: string): Promise<string> {
	await ensureDirectory(rootPath);
	const workflowsPath = join(rootPath, "workflows");
	await ensureDirectory(workflowsPath);
	const workflowDir = join(workflowsPath, workflowId);
	await ensureDirectory(workflowDir);
	return workflowDir;
}

async function ensureDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const handle = await open(path, fsConstants.O_RDONLY | DIRECTORY_FLAG | NOFOLLOW_FLAG);
	try {
		const stat = (await handle.stat()) as FileHandleStat;
		if (!stat.isDirectory()) throw new WorkflowLocalAppendLeaseError("workflow_append_lease_directory_invalid");
	} finally {
		await handle.close();
	}
}

async function readLeaseFileIfPresent(path: string, secret: Uint8Array): Promise<LeaseFileState | null> {
	const state = await readLeaseFileWithoutAuthentication(path);
	if (state === null) return null;
	assertRecordAuthentication(state.record, secret);
	return state;
}

async function readLeaseFileWithoutAuthentication(path: string): Promise<LeaseFileState | null> {
	let handle: FileHandle;
	try {
		handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw new WorkflowLocalAppendLeaseError(
			"workflow_append_lease_read_failed",
			error instanceof Error ? error.message : undefined,
		);
	}
	try {
		const stat = (await handle.stat()) as FileHandleStat;
		if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600)
			throw new WorkflowLocalAppendLeaseError("workflow_append_lease_file_invalid");
		const bytes = new Uint8Array(await handle.readFile());
		return { bytes, record: parseRecordWithoutAuthentication(bytes) };
	} finally {
		await handle.close();
	}
}

async function readRequiredLeaseFile(path: string, secret: Uint8Array): Promise<LeaseFileState> {
	const state = await readLeaseFileIfPresent(path, secret);
	if (state === null) throw new WorkflowLocalAppendLeaseError("workflow_append_lease_missing");
	return state;
}

async function readRequiredLeaseFileWithoutAuthentication(path: string): Promise<LeaseFileState> {
	const state = await readLeaseFileWithoutAuthentication(path);
	if (state === null) throw new WorkflowLocalAppendLeaseError("workflow_append_lease_missing");
	return state;
}

async function createLeaseFileNoReplace(
	workflowDir: string,
	path: string,
	bytes: Uint8Array,
	rootPath: string,
): Promise<void> {
	let handle: FileHandle;
	try {
		handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW_FLAG, 0o600);
	} catch (error) {
		if (isNodeError(error, "EEXIST")) throw new WorkflowLocalAppendLeaseError("workflow_append_lease_cas_conflict");
		throw error;
	}
	try {
		await assertPrivateFile(handle);
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncAncestors(workflowDir, rootPath);
}

async function replaceLeaseFileCas(
	workflowDir: string,
	path: string,
	expectedBytes: Uint8Array,
	nextBytes: Uint8Array,
	rootPath: string,
): Promise<void> {
	const observed = await readFileBytes(path);
	if (!sameBytes(observed, expectedBytes))
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_cas_conflict");
	const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let tempHandle: FileHandle | undefined;
	try {
		tempHandle = await open(
			tempPath,
			fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW_FLAG,
			0o600,
		);
		await assertPrivateFile(tempHandle);
		await tempHandle.writeFile(nextBytes);
		await tempHandle.sync();
	} finally {
		if (tempHandle !== undefined) await tempHandle.close();
	}
	try {
		await rename(tempPath, path);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
	await syncAncestors(workflowDir, rootPath);
	const committed = await readFileBytes(path);
	if (!sameBytes(committed, nextBytes)) throw new WorkflowLocalAppendLeaseError("workflow_append_lease_cas_conflict");
}

async function readFileBytes(path: string): Promise<Uint8Array> {
	let handle: FileHandle;
	try {
		handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
	} catch (error) {
		throw new WorkflowLocalAppendLeaseError(
			"workflow_append_lease_read_failed",
			error instanceof Error ? error.message : undefined,
		);
	}
	try {
		await assertPrivateFile(handle);
		return new Uint8Array(await handle.readFile());
	} finally {
		await handle.close();
	}
}

async function assertPrivateFile(handle: { stat(): Promise<unknown> }): Promise<void> {
	const stat = (await handle.stat()) as FileHandleStat;
	if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600)
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_file_invalid");
}

async function syncAncestors(workflowDir: string, rootPath: string): Promise<void> {
	await syncDirectory(workflowDir);
	await syncDirectory(dirname(workflowDir));
	await syncDirectory(rootPath);
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, fsConstants.O_RDONLY | DIRECTORY_FLAG | NOFOLLOW_FLAG);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function acquireFilesystemGuard(
	workflowDir: string,
	guardPath: string,
	options: LocalAppendLeaseOptions,
	rootPath: string,
	workflowId: string,
): Promise<() => Promise<void>> {
	const timeout = options.guardTimeoutMilliseconds ?? DEFAULT_GUARD_TIMEOUT_MILLISECONDS;
	const retry = options.guardRetryMilliseconds ?? DEFAULT_GUARD_RETRY_MILLISECONDS;
	const startedAt = process.hrtime.bigint();
	let handle: FileHandle | undefined;
	while (true) {
		try {
			handle = await open(
				guardPath,
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW_FLAG,
				0o600,
			);
			const guard = canonicalJsonBytes({
				version: RECORD_VERSION,
				workflowId,
				processIdentity: options.processIdentity ?? "",
				token: randomUUID(),
			});
			await handle.writeFile(guard);
			await handle.sync();
			await handle.close();
			await syncAncestors(workflowDir, rootPath);
			return async (): Promise<void> => {
				try {
					await unlink(guardPath);
				} catch (error) {
					if (!isNodeError(error, "ENOENT")) throw error;
				}
				await syncAncestors(workflowDir, rootPath);
			};
		} catch (error) {
			if (handle !== undefined) await handle.close().catch(() => undefined);
			if (!isNodeError(error, "EEXIST")) throw error;
			if (await reclaimDeadFilesystemGuard(guardPath, workflowId)) continue;
			const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
			if (elapsed >= timeout) throw new WorkflowLocalAppendLeaseError("workflow_append_lease_guard_timeout");
			await delay(retry);
		}
	}
}

async function reclaimDeadFilesystemGuard(guardPath: string, workflowId: string): Promise<boolean> {
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await readFile(guardPath));
	} catch (error) {
		return isNodeError(error, "ENOENT");
	}
	let value: WorkflowCanonicalJsonValue;
	try {
		value = parseCanonicalJsonBytes(bytes);
	} catch {
		return false;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		value.version !== RECORD_VERSION ||
		value.workflowId !== workflowId ||
		typeof value.processIdentity !== "string" ||
		value.processIdentity.length === 0 ||
		typeof value.token !== "string" ||
		value.token.length === 0
	)
		return false;
	if (processIdentityStatus(value.processIdentity) !== "dead") return false;
	try {
		await unlink(guardPath);
		return true;
	} catch (error) {
		return isNodeError(error, "ENOENT");
	}
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function parseRecordWithoutAuthentication(bytes: Uint8Array): LocalAppendLeaseRecord {
	let value: WorkflowCanonicalJsonValue;
	try {
		value = parseCanonicalJsonBytes(bytes);
	} catch (error) {
		throw new WorkflowLocalAppendLeaseError(
			"workflow_append_lease_record_invalid",
			error instanceof Error ? error.message : undefined,
		);
	}
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"version",
			"workflowId",
			"status",
			"leaseRef",
			"renewedAt",
			"previousLeaseDigest",
			"authentication",
		])
	)
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_record_invalid");
	if (
		value.version !== RECORD_VERSION ||
		typeof value.workflowId !== "string" ||
		(value.status !== "active" && value.status !== "released") ||
		typeof value.renewedAt !== "string"
	)
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_record_invalid");
	if (value.previousLeaseDigest !== null && typeof value.previousLeaseDigest !== "string")
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_record_invalid");
	if (
		!isLeaseRefValue(value.leaseRef) ||
		!isRecord(value.authentication) ||
		!hasExactKeys(value.authentication, ["algorithm", "mac"]) ||
		value.authentication.algorithm !== AUTHENTICATION_ALGORITHM ||
		typeof value.authentication.mac !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.authentication.mac)
	)
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_record_invalid");
	const record: LocalAppendLeaseRecord = {
		version: RECORD_VERSION,
		workflowId: value.workflowId,
		status: value.status,
		leaseRef: value.leaseRef,
		renewedAt: value.renewedAt,
		previousLeaseDigest: value.previousLeaseDigest,
		authentication: { algorithm: AUTHENTICATION_ALGORITHM, mac: value.authentication.mac },
	};
	return record;
}

function assertRecordAuthentication(record: LocalAppendLeaseRecord, secret: Uint8Array): void {
	if (!hasValidRecordAuthentication(record, secret))
		throw new WorkflowLocalAppendLeaseError("workflow_append_lease_authentication_invalid");
}

function hasValidRecordAuthentication(record: LocalAppendLeaseRecord, secret: Uint8Array): boolean {
	const expected = hmacHex(secret, canonicalJsonBytes(unsignedRecord(record)));
	return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(record.authentication.mac, "hex"));
}

function isRecord(value: WorkflowCanonicalJsonValue): value is Record<string, WorkflowCanonicalJsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, WorkflowCanonicalJsonValue>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isLeaseRefValue(value: WorkflowCanonicalJsonValue): value is WorkflowCanonicalJsonObject & WorkflowLeaseRef {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"storeEpoch",
			"coordinatorEpoch",
			"leaseId",
			"acquisitionEventSequence",
			"processIdentity",
			"rootDigest",
			"writerIdentity",
			"acquiredAt",
			"expiresAt",
		])
	)
		return false;
	return (
		isPositiveIntegerValue(value.storeEpoch) &&
		isPositiveIntegerValue(value.coordinatorEpoch) &&
		typeof value.leaseId === "string" &&
		value.leaseId.length > 0 &&
		isPositiveIntegerValue(value.acquisitionEventSequence) &&
		typeof value.processIdentity === "string" &&
		value.processIdentity.length > 0 &&
		typeof value.rootDigest === "string" &&
		value.rootDigest.length > 0 &&
		typeof value.writerIdentity === "string" &&
		value.writerIdentity.length > 0 &&
		typeof value.acquiredAt === "string" &&
		Number.isFinite(Date.parse(value.acquiredAt)) &&
		typeof value.expiresAt === "string" &&
		Number.isFinite(Date.parse(value.expiresAt)) &&
		Date.parse(value.expiresAt) > Date.parse(value.acquiredAt)
	);
}

function isPositiveIntegerValue(value: WorkflowCanonicalJsonValue): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function isNodeError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
