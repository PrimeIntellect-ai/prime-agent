import { digestObject } from "../workflow/contracts.js";
import type { KnowledgeRecallInput, KnowledgeStore } from "./knowledge-store.js";
import {
	freezeKnowledgeValue,
	type KnowledgeKind,
	type KnowledgePrivacyClass,
	type KnowledgeRecord,
	type KnowledgeScope,
	validateKnowledgeRecord,
} from "./records.js";

export interface KnowledgeMempalaceRecallInput extends Omit<KnowledgeRecallInput, "query" | "kind"> {
	query: string;
	kind?: KnowledgeKind;
	route?: "direct" | "prefer" | "require";
	scope?: KnowledgeScope;
	privacyAtMost?: KnowledgePrivacyClass;
}

export type KnowledgeMemPalaceRecallInput = KnowledgeMempalaceRecallInput;

export interface KnowledgeMempalaceIndex {
	upsert(record: KnowledgeRecord): Promise<void>;
	delete?(recordId: string, fence?: KnowledgeMempalaceFence): Promise<void>;
	search(input: KnowledgeMempalaceRecallInput): Promise<readonly KnowledgeRecord[]>;
	/** Return the index's durable canonical fence, or null when it has no indexed records. */
	readFence?(): Promise<KnowledgeMempalaceFence | null>;
}

export type KnowledgeMempalaceOutboxOperation = "upsert" | "delete";

export interface KnowledgeMempalaceFence {
	knowledgeStoreEpoch: number;
	coordinatorEpoch: number;
	knowledgeJournalSequence: number;
	knowledgeJournalDigest: string;
}

export interface KnowledgeMempalaceOutboxEntry {
	idempotencyKey: string;
	operation: KnowledgeMempalaceOutboxOperation;
	recordId: string;
	revision: number;
	canonicalDigest: string;
	sourceDigest: string | null;
	tombstoneFingerprint: string | null;
	fence: KnowledgeMempalaceFence;
	record: KnowledgeRecord | null;
}

export interface KnowledgeMempalaceOutbox {
	append(entry: KnowledgeMempalaceOutboxEntry): Promise<void>;
	pending(): Promise<readonly KnowledgeMempalaceOutboxEntry[]>;
	acknowledge?(idempotencyKey: string, fence: KnowledgeMempalaceFence): Promise<void>;
}

export type KnowledgeMempalaceHealthStatus = "healthy" | "disabled" | "degraded" | "blocked" | "lagging";

export interface KnowledgeMempalaceHealth {
	status: KnowledgeMempalaceHealthStatus;
	reason: string | null;
	pending: number;
	lastFence: KnowledgeMempalaceFence | null;
}

export type MemPalaceIndex = KnowledgeMempalaceIndex;
export type KnowledgeMemPalaceIndex = KnowledgeMempalaceIndex;
export type KnowledgeMemPalaceOutbox = KnowledgeMempalaceOutbox;
export type MemPalaceOutbox = KnowledgeMempalaceOutbox;

export interface KnowledgeMempalaceBoundary {
	accept(record: KnowledgeRecord): Promise<KnowledgeRecord>;
	project(record: KnowledgeRecord): Promise<KnowledgeRecord>;
	recall(input: KnowledgeMempalaceRecallInput): Promise<readonly KnowledgeRecord[]>;
	health(): Promise<KnowledgeMempalaceHealth>;
	drain(): Promise<KnowledgeMempalaceHealth>;
}

export type MemPalaceBoundary = KnowledgeMempalaceBoundary;
export type KnowledgeMemPalaceBoundary = KnowledgeMempalaceBoundary;

export interface KnowledgeMempalaceBoundaryConstructionInput {
	store: KnowledgeStore;
	index?: KnowledgeMempalaceIndex;
	outbox?: KnowledgeMempalaceOutbox;
	now?: () => string;
}

const MEMPALACE_OUTBOX_REQUIRED_REASON = "MemPalace durable outbox is required when an index is configured.";
const MEMPALACE_INDEX_FENCE_REQUIRED_REASON = "MemPalace index durable fence is required for healthy status.";
const MAX_MEMPALACE_RESULTS = 10_000;

function projectionBlockReason(record: KnowledgeRecord, now: string | undefined): string | null {
	if (record.status !== "active") return null;
	if (now === undefined) return "MemPalace projection requires a host trusted clock.";
	if (now !== undefined && !Number.isFinite(Date.parse(now))) return "MemPalace trusted clock is invalid.";
	if (
		now !== undefined &&
		record.retention.expiresAt !== undefined &&
		Date.parse(record.retention.expiresAt) <= Date.parse(now)
	)
		return "Canonical retention has expired.";
	if (
		now !== undefined &&
		record.evidenceRefs.some(
			(ref) =>
				Date.parse(ref.validationReceipt.issuedAt) > Date.parse(now) ||
				Date.parse(ref.validationReceipt.validUntil) <= Date.parse(now),
		)
	)
		return "Canonical evidence is stale.";
	if (
		now !== undefined &&
		(Date.parse(record.privacy.secretScan.issuedAt) > Date.parse(now) ||
			Date.parse(record.privacy.secretScan.validUntil) <= Date.parse(now))
	)
		return "Canonical secret-scan evidence is stale.";
	if (record.privacy.class === "private" || record.privacy.class === "restricted")
		return "Privacy policy blocks MemPalace projection.";
	return null;
}

/**
 * Construct the optional MemPalace projection boundary.
 *
 * Args:
 * input: Canonical store and optional derived index.
 * Return: Read/project-only boundary with no durable writer or authority.
 */
export function createKnowledgeMempalaceBoundary(
	input: KnowledgeMempalaceBoundaryConstructionInput,
): KnowledgeMempalaceBoundary {
	let lastFailure: string | null = null;
	let blockedReason: string | null = null;
	let lastFence: KnowledgeMempalaceFence | null = null;
	const latestRevision = new Map<string, number>();

	const canonicalFence = async (): Promise<KnowledgeMempalaceFence | null> => {
		const projection = await input.store.read();
		const records = Object.values(projection.records);
		const latest = records.reduce<KnowledgeRecord | null>(
			(current, candidate) =>
				current === null ||
				candidate.commitRef.knowledgeJournalSequence > current.commitRef.knowledgeJournalSequence
					? candidate
					: current,
			null,
		);
		if (latest === null) return null;
		const authenticatedCommit = await input.store.readAuthenticatedCommit(latest.commitRef.knowledgeJournalSequence);
		if (
			authenticatedCommit === null ||
			digestObject(authenticatedCommit.epochRef) !== digestObject(latest.commitRef.workflowEpochRef)
		)
			throw new Error("MemPalace health cannot authenticate the canonical index fence.");
		return {
			knowledgeStoreEpoch: latest.commitRef.knowledgeStoreEpoch,
			coordinatorEpoch: latest.commitRef.workflowEpochRef.coordinatorEpoch,
			knowledgeJournalSequence: latest.commitRef.knowledgeJournalSequence,
			knowledgeJournalDigest: authenticatedCommit.eventDigest,
		};
	};

	const health = async (): Promise<KnowledgeMempalaceHealth> => {
		let pending = 0;
		if (input.outbox !== undefined) {
			try {
				pending = (await input.outbox.pending()).length;
			} catch {
				lastFailure ??= "MemPalace outbox is unavailable.";
			}
		}
		if (input.index !== undefined && input.outbox !== undefined) {
			if (input.index.readFence === undefined) {
				lastFailure ??= MEMPALACE_INDEX_FENCE_REQUIRED_REASON;
			} else {
				try {
					const [expectedFence, indexedFence] = await Promise.all([canonicalFence(), input.index.readFence()]);
					if (digestObject(expectedFence) !== digestObject(indexedFence))
						lastFailure ??= "MemPalace index fence is stale or missing.";
				} catch {
					lastFailure ??= "MemPalace index fence is unavailable.";
				}
			}
		}
		return freezeKnowledgeValue({
			status:
				blockedReason !== null
					? "blocked"
					: lastFailure !== null
						? "degraded"
						: input.index === undefined
							? "disabled"
							: input.outbox === undefined
								? "degraded"
								: pending > 0
									? "lagging"
									: "healthy",
			reason:
				blockedReason ??
				lastFailure ??
				(input.index !== undefined && input.outbox === undefined ? MEMPALACE_OUTBOX_REQUIRED_REASON : null),
			pending,
			lastFence,
		});
	};

	const buildOutboxEntry = async (record: KnowledgeRecord): Promise<KnowledgeMempalaceOutboxEntry> => {
		const authenticatedCommit = await input.store.readAuthenticatedCommit(record.commitRef.knowledgeJournalSequence);
		if (authenticatedCommit === null || authenticatedCommit.sequence !== record.commitRef.knowledgeJournalSequence)
			throw new Error("MemPalace fence is missing the authenticated canonical journal event.");
		const operation = record.status === "retracted" ? "delete" : "upsert";
		const fence = {
			knowledgeStoreEpoch: record.commitRef.knowledgeStoreEpoch,
			coordinatorEpoch: record.commitRef.workflowEpochRef.coordinatorEpoch,
			knowledgeJournalSequence: record.commitRef.knowledgeJournalSequence,
			knowledgeJournalDigest: authenticatedCommit.eventDigest,
		};
		return {
			idempotencyKey: `mempalace:${record.recordId}:${record.revision}:${operation}:${
				record.tombstone?.deletionFingerprint ?? record.contentDigest
			}`,
			operation,
			recordId: record.recordId,
			revision: record.revision,
			canonicalDigest: operation === "delete" ? "" : digestObject(record),
			sourceDigest: operation === "delete" ? null : record.sourceDigest,
			tombstoneFingerprint: record.tombstone?.deletionFingerprint ?? null,
			fence,
			record: null,
		};
	};

	const appendOutbox = async (entry: KnowledgeMempalaceOutboxEntry): Promise<boolean> => {
		if (input.outbox === undefined) return input.index === undefined;
		try {
			await input.outbox.append(freezeKnowledgeValue(entry));
			return true;
		} catch (error) {
			lastFailure = error instanceof Error ? error.message : "MemPalace outbox append failed.";
			return false;
		}
	};

	const applyEntry = async (entry: KnowledgeMempalaceOutboxEntry): Promise<void> => {
		const priorRevision = latestRevision.get(entry.recordId);
		const projection = await input.store.read();
		const canonical = projection.records[entry.recordId];
		const authenticatedCommit = await input.store.readAuthenticatedCommit(entry.fence.knowledgeJournalSequence);
		if (
			canonical === undefined ||
			canonical.commitRef.knowledgeStoreEpoch !== entry.fence.knowledgeStoreEpoch ||
			canonical.commitRef.workflowEpochRef.coordinatorEpoch !== entry.fence.coordinatorEpoch ||
			authenticatedCommit === null ||
			authenticatedCommit.sequence !== entry.fence.knowledgeJournalSequence ||
			authenticatedCommit.eventDigest !== entry.fence.knowledgeJournalDigest ||
			canonical.recordId !== entry.recordId
		)
			throw new Error("MemPalace outbox entry is stale or not bound to the canonical record.");
		if (canonical.revision > entry.revision) {
			if (input.outbox?.acknowledge === undefined)
				throw new Error("MemPalace outbox entry is stale or not bound to the canonical record.");
			await input.outbox.acknowledge(entry.idempotencyKey, entry.fence);
			blockedReason = null;
			lastFailure = null;
			return;
		}
		if (canonical.commitRef.knowledgeJournalSequence !== entry.fence.knowledgeJournalSequence)
			throw new Error("MemPalace outbox entry is stale or not bound to the canonical record.");
		if (
			entry.operation === "upsert" &&
			input.store.revalidate !== undefined &&
			!(await input.store.revalidate(canonical))
		) {
			blockedReason = "Canonical source evidence is no longer resolver-verified.";
			lastFailure = blockedReason;
			if (input.outbox?.acknowledge !== undefined) await input.outbox.acknowledge(entry.idempotencyKey, entry.fence);
			return;
		}
		if (entry.operation === "upsert") {
			const reason = projectionBlockReason(canonical, input.now?.());
			if (reason !== null) {
				blockedReason = reason;
				lastFailure = reason;
				if (input.outbox?.acknowledge !== undefined)
					await input.outbox.acknowledge(entry.idempotencyKey, entry.fence);
				return;
			}
		}
		if (
			(entry.operation === "upsert" &&
				(canonical.status !== "active" ||
					canonical.sourceDigest !== entry.sourceDigest ||
					digestObject(canonical) !== entry.canonicalDigest)) ||
			(entry.operation === "delete" &&
				(canonical.status !== "retracted" ||
					canonical.tombstone?.deletionFingerprint !== entry.tombstoneFingerprint))
		)
			throw new Error("MemPalace outbox entry is stale or not bound to the canonical record.");
		if (priorRevision !== undefined && entry.revision <= priorRevision) {
			if (input.outbox?.acknowledge !== undefined) await input.outbox.acknowledge(entry.idempotencyKey, entry.fence);
			return;
		}
		if (input.index === undefined) return;
		if (input.outbox?.acknowledge !== undefined && input.index.readFence === undefined)
			throw new Error("MemPalace index durable fence is required before acknowledging projection effects.");
		if (input.index.readFence !== undefined) {
			let indexedFence: KnowledgeMempalaceFence | null = null;
			try {
				indexedFence = await input.index.readFence();
			} catch {
				lastFailure = "MemPalace index fence is corrupt or unavailable; rebuilding from canonical state.";
			}
			if (digestObject(indexedFence) === digestObject(entry.fence)) {
				latestRevision.set(entry.recordId, entry.revision);
				lastFence = freezeKnowledgeValue(entry.fence);
				blockedReason = null;
				if (input.outbox?.acknowledge !== undefined)
					await input.outbox.acknowledge(entry.idempotencyKey, entry.fence);
				lastFailure = null;
				return;
			}
		}
		if (entry.operation === "delete") {
			if (input.index.delete === undefined) throw new Error("MemPalace index cannot apply canonical tombstones.");
			await input.index.delete(entry.recordId, entry.fence);
		} else {
			await input.index.upsert(freezeKnowledgeValue(canonical));
		}
		if (input.index.readFence !== undefined) {
			const appliedFence = await input.index.readFence();
			if (digestObject(appliedFence) !== digestObject(entry.fence))
				throw new Error("MemPalace index effect did not durably publish its canonical fence.");
		}
		latestRevision.set(entry.recordId, entry.revision);
		lastFence = freezeKnowledgeValue(entry.fence);
		blockedReason = null;
		if (input.outbox?.acknowledge !== undefined) await input.outbox.acknowledge(entry.idempotencyKey, entry.fence);
		lastFailure = null;
	};

	const accept = async (candidate: KnowledgeRecord): Promise<KnowledgeRecord> => {
		if (
			candidate === null ||
			typeof candidate !== "object" ||
			candidate.commitRef === null ||
			typeof candidate.commitRef !== "object"
		)
			throw new Error("MemPalace cannot accept a record before canonical commit.");
		const validatedCandidate = validateKnowledgeRecord(candidate);
		if (validatedCandidate.status !== "active" && validatedCandidate.status !== "retracted")
			throw new Error("MemPalace accepts active canonical records and tombstones only.");
		const projection = await input.store.read();
		const canonical = projection.records[validatedCandidate.recordId];
		if (canonical === undefined) throw new Error("MemPalace cannot accept a record before canonical commit.");
		if (digestObject(canonical) !== digestObject(validatedCandidate))
			throw new Error("MemPalace record is not the exact committed canonical revision.");
		if (canonical.commitRef.proposalId !== canonical.proposalId || canonical.commitRef.knowledgeJournalSequence <= 0)
			throw new Error("MemPalace record does not carry a canonical commit receipt.");
		const result = freezeKnowledgeValue(canonical);
		const blockReason = projectionBlockReason(result, input.now?.());
		if (blockReason !== null) {
			blockedReason = blockReason;
			return result;
		}
		if (
			result.status === "active" &&
			input.store.revalidate !== undefined &&
			!(await input.store.revalidate(result))
		) {
			blockedReason = "Canonical source evidence is no longer resolver-verified.";
			return result;
		}
		const priorRevision = latestRevision.get(result.recordId);
		if (priorRevision !== undefined && result.revision <= priorRevision) return result;
		let entry: KnowledgeMempalaceOutboxEntry;
		try {
			entry = await buildOutboxEntry(result);
		} catch (error) {
			lastFailure = error instanceof Error ? error.message : "MemPalace authentication fence failed.";
			return result;
		}
		const appended = await appendOutbox(entry);
		if (!appended && input.index !== undefined) return result;
		try {
			await applyEntry(entry);
		} catch (error) {
			lastFailure = error instanceof Error ? error.message : "MemPalace projection failed.";
		}
		return result;
	};

	const drain = async (): Promise<KnowledgeMempalaceHealth> => {
		if (input.outbox === undefined) return health();
		try {
			for (const entry of await input.outbox.pending()) {
				try {
					await applyEntry(entry);
				} catch (error) {
					lastFailure = error instanceof Error ? error.message : "MemPalace projection failed.";
				}
			}
		} catch (error) {
			lastFailure = error instanceof Error ? error.message : "MemPalace outbox is unavailable.";
		}
		return health();
	};

	const recall = async (recallInput: KnowledgeMempalaceRecallInput): Promise<readonly KnowledgeRecord[]> => {
		if (
			recallInput === null ||
			typeof recallInput !== "object" ||
			typeof recallInput.query !== "string" ||
			recallInput.query.trim().length === 0
		)
			throw new Error("MemPalace recall query is required.");
		const canonicalInput = freezeKnowledgeValue({
			query: recallInput.query.trim(),
			principal: recallInput.principal,
			trustedClockReceipt: recallInput.trustedClockReceipt,
			...(recallInput.kind === undefined ? {} : { kind: recallInput.kind }),
			...(recallInput.scope === undefined ? {} : { scope: recallInput.scope }),
			...(recallInput.workspaceId === undefined ? {} : { workspaceId: recallInput.workspaceId }),
			...(recallInput.sessionId === undefined ? {} : { sessionId: recallInput.sessionId }),
			...(recallInput.userId === undefined ? {} : { userId: recallInput.userId }),
			...(recallInput.pathPrefix === undefined ? {} : { pathPrefix: recallInput.pathPrefix }),
			...(recallInput.privacyAtMost === undefined ? {} : { privacyAtMost: recallInput.privacyAtMost }),
		});
		const route = recallInput.route ?? "prefer";
		if (route !== "direct" && route !== "prefer" && route !== "require")
			throw new Error("MemPalace recall route is invalid.");
		const canonical = await input.store.recall(canonicalInput);
		if (route === "direct") return freezeKnowledgeValue(canonical);
		if (route === "require") {
			if (input.now === undefined) throw new Error("MemPalace indexed projection requires a host trusted clock.");
			if (input.index === undefined || input.outbox === undefined)
				throw new Error("MemPalace indexed projection and durable outbox are required for this recall route.");
			const indexedHealth = await health();
			if (indexedHealth.status !== "healthy")
				throw new Error(`MemPalace indexed projection is ${indexedHealth.status} for this recall route.`);
			if (input.index.readFence === undefined)
				throw new Error("MemPalace indexed projection fence is required for this recall route.");
			const indexedFence = await input.index.readFence();
			const expectedFence = await canonicalFence();
			if (digestObject(indexedFence) !== digestObject(expectedFence))
				throw new Error("MemPalace indexed projection fence is stale for this recall route.");
			try {
				const indexed = await input.index.search(canonicalInput);
				if (indexed.length > MAX_MEMPALACE_RESULTS) throw new Error("MemPalace index returned too many results.");
				const canonicalById = new Map(canonical.map((record) => [record.recordId, record]));
				for (const indexedRecord of indexed) {
					const canonicalRecord = canonicalById.get(indexedRecord.recordId);
					if (canonicalRecord === undefined || digestObject(canonicalRecord) !== digestObject(indexedRecord))
						throw new Error("MemPalace indexed projection is not the authenticated canonical result.");
				}
				if (canonical.some((record) => !indexed.some((candidate) => candidate.recordId === record.recordId)))
					throw new Error("MemPalace indexed projection is missing a canonical recall result.");
			} catch (error) {
				lastFailure = error instanceof Error ? error.message : "MemPalace recall is degraded.";
				throw new Error("MemPalace indexed projection is required but unavailable.");
			}
			return freezeKnowledgeValue(canonical);
		}
		if (input.index !== undefined) {
			try {
				const indexed = await input.index.search(canonicalInput);
				if (indexed.length > MAX_MEMPALACE_RESULTS) throw new Error("MemPalace index returned too many results.");
			} catch (error) {
				lastFailure = error instanceof Error ? error.message : "MemPalace recall is degraded.";
			}
		}
		return freezeKnowledgeValue(canonical);
	};

	return { accept, project: accept, recall, health, drain };
}

export const createMemPalaceBoundary = createKnowledgeMempalaceBoundary;
export const createKnowledgeMempalace = createKnowledgeMempalaceBoundary;
export const createKnowledgeMemPalaceBoundary = createKnowledgeMempalaceBoundary;
