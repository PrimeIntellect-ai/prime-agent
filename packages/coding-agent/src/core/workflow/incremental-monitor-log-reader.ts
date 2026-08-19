import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { lstat, open as openFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_EVENTS = 100;
const DEFAULT_MAX_ELAPSED_MS = 50;
const DEFAULT_MAX_PARTIAL_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_SEEN_EVENT_IDS = 100_000;
const DEFAULT_MAX_SEEN_EVENT_IDS_SERIALIZED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_LARGEST_RETAINED_VALUES = 8;
const MAX_SAFE_PAGE_BYTES = 64 * 1024 * 1024;
const MAX_SAFE_PAGE_EVENTS = 100_000;
const MAX_SAFE_ELAPSED_MS = 10 * 60 * 1000;
const MAX_SAFE_BASELINE_BYTES = 64 * 1024 * 1024;
const MAX_SAFE_PARTIAL_LINE_BYTES = 16 * 1024 * 1024;
const MAX_SAFE_SEEN_EVENT_IDS = 100_000;
const MAX_SAFE_SEEN_EVENT_IDS_SERIALIZED_BYTES = 16 * 1024 * 1024;
const MAX_SAFE_LARGEST_RETAINED_VALUES = 1024;
const MAX_READ_CHUNK_BYTES = 64 * 1024;
const MAX_SOURCE_CHECKPOINT_BYTES = 4096;
const MAX_RETAINED_EVENT_SERIALIZED_BYTES = 5 * 1024 * 1024;
const PHYSICAL_OPERATION_BYTES = 1;
const CHECKPOINT_READ_BYTES = 256;
const MIN_PAGE_METADATA_BYTES = 8;
const MIN_USABLE_PAGE_BYTES = 16;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** Explicit policy used to establish the first cursor for a source file. */
export type MonitorLogBaseline =
	| { readonly mode: "from_start" }
	| { readonly mode: "from_end" }
	| { readonly mode: "bounded_historical"; readonly maxBytes: number };

/** Stable identity for the file generation observed by one cursor. */
export interface MonitorLogSourceIdentity {
	readonly kind: "inode" | "platform_generation";
	readonly device: number | null;
	readonly inode: number | null;
	readonly generation: string;
}

/** Metadata returned by a filesystem stat operation. */
export interface MonitorLogFileSnapshot {
	readonly sizeBytes: number;
	readonly sourceIdentity: MonitorLogSourceIdentity;
	readonly sourceMutationFingerprint?: string;
}

/** Positional file handle kept open for one page to eliminate path read TOCTOU. */
export interface IncrementalMonitorLogFileHandle {
	stat(): Promise<MonitorLogFileSnapshot>;
	readAt(byteOffset: number, maxBytes: number): Promise<Uint8Array>;
	close(): Promise<void>;
}

/** Public filesystem port used by the reader and its boundary tests. */
export interface IncrementalMonitorLogFileSystem {
	open(path: string): Promise<IncrementalMonitorLogFileHandle>;
}

/** Host-owned authority that authenticates the canonical cursor payload. */
export interface IncrementalMonitorLogCursorAuthority {
	sign(payload: string): string;
	verify(payload: string, mac: string): boolean;
}

/** Durable page limits. Every page observes all three limits. */
export interface IncrementalMonitorLogPageLimits {
	readonly maxBytes: number;
	readonly maxEvents: number;
	readonly maxElapsedMs: number;
}

/** Durable cursor containing only source identity, position, partial text, policy, and IDs. */
export interface IncrementalMonitorLogCursor {
	readonly version: 1;
	readonly cursorMac: string;
	readonly sourceIdentity: MonitorLogSourceIdentity;
	readonly sourceCheckpoint: MonitorLogSourceCheckpoint | null;
	readonly byteOffset: number;
	readonly trailingPartialLine: string;
	readonly trailingPartialLineBytes: string;
	readonly baseline: MonitorLogBaseline;
	readonly baselineOmittedBytes: number;
	readonly skipLeadingPartialLine: boolean;
	readonly seenEventIds: readonly string[];
}

/** Bounded content checkpoint used to detect copytruncate/regrowth and inode reuse. */
export interface MonitorLogSourceCheckpoint {
	readonly sourceSizeBytes: number;
	readonly contentProofComplete: boolean;
	readonly sourceMutationFingerprint: string | null;
	readonly prefixDigest: string;
	readonly prefixBytes: number;
	readonly anchorOffset: number;
	readonly anchorDigest: string;
	readonly anchorBytes: number;
	readonly tailOffset: number;
	readonly tailDigest: string;
	readonly tailBytes: number;
}

/** Optional event metadata type for callers that need to pair a parsed event with its identity. */
export interface MonitorLogEvent<TEvent> {
	readonly id: string;
	readonly value: TEvent;
	readonly sourceByteOffset: number;
}

/** One bounded retained value reported by page telemetry. */
export interface MonitorLogRetainedValueTelemetry {
	readonly kind: "cursor" | "event";
	readonly type: string;
	readonly serializedBytes: number;
}

/** Bounded metadata about retained cursor and parsed event state. */
export interface MonitorLogRetentionTelemetry {
	readonly cursorSerializedBytes: number;
	readonly cursorPartialLineBytes: number;
	readonly cursorEventIdBytes: number;
	readonly serializedEventBytes: number;
	readonly contentBytesRead: number;
	readonly checkpointBytesRead: number;
	readonly metadataBytes: number;
	readonly physicalBytes: number;
	readonly retainedEventCount: number;
	readonly largestRetainedValues: readonly MonitorLogRetainedValueTelemetry[];
}

/** Page continuation state. The cursor is repeated here for handoff-oriented callers. */
export interface IncrementalMonitorLogContinuation {
	readonly hasMore: boolean;
	readonly cursor: IncrementalMonitorLogCursor;
}

/** Ephemeral release handle for parsed event results. */
export interface IncrementalMonitorLogEphemeralResult {
	readonly release: () => void;
	readonly released: boolean;
}

/** Bounded result returned by one incremental read. */
export interface IncrementalMonitorLogPage<TEvent> {
	readonly events: readonly TEvent[];
	readonly cursor: IncrementalMonitorLogCursor;
	readonly continuation: IncrementalMonitorLogContinuation;
	readonly telemetry: MonitorLogRetentionTelemetry;
	readonly ephemeral: IncrementalMonitorLogEphemeralResult;
}

/** Reader options. The reader itself retains no page buffers between calls. */
export interface IncrementalMonitorLogReaderOptions<TEvent> {
	readonly path: string;
	readonly baseline: MonitorLogBaseline;
	readonly cursorAuthority: IncrementalMonitorLogCursorAuthority;
	readonly fileSystem?: IncrementalMonitorLogFileSystem;
	readonly parseLine?: (line: string) => TEvent | null;
	readonly isRelevant?: (event: TEvent) => boolean;
	readonly eventIdentity?: (
		event: TEvent,
		line: string,
		sourceByteOffset: number,
		sourceIdentity: MonitorLogSourceIdentity,
	) => string;
	readonly limits?: Partial<IncrementalMonitorLogPageLimits>;
	readonly maxPartialLineBytes?: number;
	readonly maxSeenEventIds?: number;
	readonly maxSeenEventIdsSerializedBytes?: number;
	readonly maxLargestRetainedValues?: number;
	readonly clock?: () => number;
}

/** Reader object whose only durable input/output is the caller-owned cursor. */
export interface IncrementalMonitorLogReader<TEvent> {
	readPage(cursor?: IncrementalMonitorLogCursor): Promise<IncrementalMonitorLogPage<TEvent>>;
}

interface NormalizedOptions<TEvent> {
	readonly path: string;
	readonly baseline: MonitorLogBaseline;
	readonly cursorAuthority: IncrementalMonitorLogCursorAuthority;
	readonly fileSystem: IncrementalMonitorLogFileSystem;
	readonly parseLine: (line: string) => TEvent | null;
	readonly isRelevant: (event: TEvent) => boolean;
	readonly eventIdentity: (
		event: TEvent,
		line: string,
		sourceByteOffset: number,
		sourceIdentity: MonitorLogSourceIdentity,
	) => string;
	readonly limits: IncrementalMonitorLogPageLimits;
	readonly maxPartialLineBytes: number;
	readonly maxSeenEventIds: number;
	readonly maxSeenEventIdsSerializedBytes: number;
	readonly maxLargestRetainedValues: number;
	readonly checkpointReadBytes: number;
	readonly finalCheckpointPhysicalBytes: number;
	readonly clock: () => number;
}

interface DecodedBytes {
	readonly text: string;
	readonly incomplete: Uint8Array;
}

interface ProcessedLine {
	readonly status: "processed" | "defer";
	readonly eventBytes: number;
	readonly eventType: string | null;
}

interface PhysicalBudgetTelemetry {
	readonly contentBytesRead: number;
	readonly checkpointBytesRead: number;
	readonly metadataBytes: number;
	readonly physicalBytes: number;
}

function invalidInput(message: string): Error {
	return new Error(`incremental_monitor_log_${message}`);
}

function safeInteger(value: number, label: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || value < minimum) throw invalidInput(`${label}_invalid`);
	return value;
}

function normalizeBaseline(value: unknown): MonitorLogBaseline {
	const record = value as Record<string, unknown>;
	const keys = record?.mode === "bounded_historical" ? ["mode", "maxBytes"] : ["mode"];
	assertClosedRecord(value, keys, "baseline");
	const baseline = value as Partial<MonitorLogBaseline>;
	if (baseline.mode === "from_start" || baseline.mode === "from_end") return { mode: baseline.mode };
	if (baseline.mode === "bounded_historical" && typeof baseline.maxBytes === "number") {
		const maxBytes = safeInteger(baseline.maxBytes, "baseline_max_bytes", 1);
		if (maxBytes > MAX_SAFE_BASELINE_BYTES) throw invalidInput("baseline_max_bytes_unsafe");
		return { mode: baseline.mode, maxBytes };
	}
	throw invalidInput("baseline_invalid");
}

function normalizeLimits(
	limits: Partial<IncrementalMonitorLogPageLimits> | undefined,
): IncrementalMonitorLogPageLimits {
	const maxBytes = safeInteger(limits?.maxBytes ?? DEFAULT_MAX_BYTES, "max_bytes", MIN_USABLE_PAGE_BYTES);
	const maxEvents = safeInteger(limits?.maxEvents ?? DEFAULT_MAX_EVENTS, "max_events", 1);
	if (maxBytes > MAX_SAFE_PAGE_BYTES) throw invalidInput("max_bytes_unsafe");
	if (maxEvents > MAX_SAFE_PAGE_EVENTS) throw invalidInput("max_events_unsafe");
	const maxElapsedMs = limits?.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
	if (!Number.isFinite(maxElapsedMs) || maxElapsedMs <= 0 || maxElapsedMs > MAX_SAFE_ELAPSED_MS)
		throw invalidInput("max_elapsed_ms_invalid");
	return { maxBytes, maxEvents, maxElapsedMs };
}

function normalizeBound(value: number | undefined, fallback: number, label: string): number {
	return safeInteger(value ?? fallback, label, 1);
}

function normalizeCappedBound(value: number | undefined, fallback: number, label: string, maximum: number): number {
	const normalized = normalizeBound(value, fallback, label);
	if (normalized > maximum) throw invalidInput(`${label}_unsafe`);
	return normalized;
}

function checkpointPhysicalBytes(checkpointReadBytes: number): number {
	return (PHYSICAL_OPERATION_BYTES + checkpointReadBytes) * 3 + PHYSICAL_OPERATION_BYTES * 2;
}

function numberStatField(value: number | bigint, label: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0) throw invalidInput(`${label}_invalid`);
	return number;
}

function digest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestBytes(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function identityFromStats(stats: Stats): MonitorLogSourceIdentity {
	const device = numberStatField(stats.dev, "device");
	const inode = numberStatField(stats.ino, "inode");
	if (inode > 0) {
		return {
			kind: "inode",
			device,
			inode,
			generation: `inode:${device}:${inode}:birth:${stats.birthtimeMs}`,
		};
	}
	return {
		kind: "platform_generation",
		device: device > 0 ? device : null,
		inode: null,
		generation: `generation:${digest(`${stats.birthtimeMs}:${stats.mode}`)}`,
	};
}

function mutationFingerprintFromStats(stats: Stats): string {
	return digest(`${stats.mtimeMs}:${stats.ctimeMs}:${stats.mode}`);
}

function snapshotFromStats(stats: Stats): MonitorLogFileSnapshot {
	return {
		sizeBytes: numberStatField(stats.size, "size"),
		sourceIdentity: identityFromStats(stats),
		sourceMutationFingerprint: mutationFingerprintFromStats(stats),
	};
}

function sameIdentity(left: MonitorLogSourceIdentity, right: MonitorLogSourceIdentity): boolean {
	return (
		left.kind === right.kind &&
		left.device === right.device &&
		left.inode === right.inode &&
		left.generation === right.generation
	);
}

function assertClosedRecord(
	value: unknown,
	keys: readonly string[],
	label: string,
): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidInput(`${label}_invalid`);
	const actualKeys = Object.keys(value).sort();
	const expectedKeys = [...keys].sort();
	if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index]))
		throw invalidInput(`${label}_fields_invalid`);
}

function validateIdentity(identity: unknown): MonitorLogSourceIdentity {
	assertClosedRecord(identity, ["kind", "device", "inode", "generation"], "cursor_source_identity");
	const candidate = identity as Partial<MonitorLogSourceIdentity>;
	const kind = candidate.kind;
	const device = candidate.device;
	const inode = candidate.inode;
	const generation = candidate.generation;
	if (
		(kind !== "inode" && kind !== "platform_generation") ||
		device === undefined ||
		(device !== null && (!Number.isSafeInteger(device) || device < 0)) ||
		inode === undefined ||
		(inode !== null && (!Number.isSafeInteger(inode) || inode < 0)) ||
		typeof generation !== "string" ||
		generation.length === 0 ||
		generation.length > 256
	)
		throw invalidInput("cursor_source_identity_invalid");
	return {
		kind,
		device,
		inode,
		generation,
	};
}

function normalizeSnapshot(snapshot: MonitorLogFileSnapshot): MonitorLogFileSnapshot {
	const sizeBytes = safeInteger(snapshot.sizeBytes, "snapshot_size");
	const sourceMutationFingerprint = snapshot.sourceMutationFingerprint;
	if (
		sourceMutationFingerprint !== undefined &&
		(typeof sourceMutationFingerprint !== "string" ||
			sourceMutationFingerprint.length === 0 ||
			sourceMutationFingerprint.length > 256)
	)
		throw invalidInput("snapshot_mutation_fingerprint_invalid");
	return {
		sizeBytes,
		sourceIdentity: validateIdentity(snapshot.sourceIdentity),
		sourceMutationFingerprint,
	};
}

function sameBaseline(left: MonitorLogBaseline, right: MonitorLogBaseline): boolean {
	if (left.mode !== right.mode) return false;
	return (
		left.mode !== "bounded_historical" || (right.mode === "bounded_historical" && left.maxBytes === right.maxBytes)
	);
}

function baselineStart(
	snapshot: MonitorLogFileSnapshot,
	baseline: MonitorLogBaseline,
): {
	offset: number;
	omittedBytes: number;
	skipLeadingPartialLine: boolean;
} {
	if (baseline.mode === "from_start") return { offset: 0, omittedBytes: 0, skipLeadingPartialLine: false };
	if (baseline.mode === "from_end") {
		return { offset: snapshot.sizeBytes, omittedBytes: snapshot.sizeBytes, skipLeadingPartialLine: false };
	}
	const offset = Math.max(0, snapshot.sizeBytes - baseline.maxBytes);
	return { offset, omittedBytes: offset, skipLeadingPartialLine: offset > 0 };
}

function emptySourceCheckpoint(): null {
	return null;
}

function sameSourceCheckpoint(
	left: MonitorLogSourceCheckpoint | null,
	right: MonitorLogSourceCheckpoint | null,
): boolean {
	if (left === null || right === null) return left === right;
	return (
		left.prefixDigest === right.prefixDigest &&
		left.prefixBytes === right.prefixBytes &&
		left.anchorOffset === right.anchorOffset &&
		left.anchorDigest === right.anchorDigest &&
		left.anchorBytes === right.anchorBytes &&
		left.tailOffset === right.tailOffset &&
		left.tailDigest === right.tailDigest &&
		left.tailBytes === right.tailBytes
	);
}

function sameSizeSourceMutationChanged(
	checkpoint: MonitorLogSourceCheckpoint,
	snapshot: MonitorLogFileSnapshot,
): boolean {
	if (checkpoint.sourceSizeBytes !== snapshot.sizeBytes) return false;
	return sourceMutationChanged(checkpoint, snapshot);
}

function sourceMutationChanged(checkpoint: MonitorLogSourceCheckpoint, snapshot: MonitorLogFileSnapshot): boolean {
	return (
		checkpoint.sourceMutationFingerprint === null ||
		snapshot.sourceMutationFingerprint === undefined ||
		checkpoint.sourceMutationFingerprint !== snapshot.sourceMutationFingerprint
	);
}

async function computeSourceCheckpoint(
	snapshot: MonitorLogFileSnapshot,
	anchorOffset: number,
	readAt: (byteOffset: number, maxBytes: number) => Promise<Uint8Array>,
	reference: MonitorLogSourceCheckpoint | null = null,
	readLimit = MAX_SOURCE_CHECKPOINT_BYTES,
): Promise<MonitorLogSourceCheckpoint> {
	const requestedPrefixBytes = reference?.prefixBytes ?? Math.min(MAX_SOURCE_CHECKPOINT_BYTES, snapshot.sizeBytes);
	const prefixBytes = Math.min(requestedPrefixBytes, snapshot.sizeBytes, readLimit);
	const prefix = prefixBytes === 0 ? new Uint8Array() : await readAt(0, prefixBytes);
	const checkpointAnchorOffset = reference?.anchorOffset ?? anchorOffset;
	const boundedAnchorOffset = Math.min(checkpointAnchorOffset, snapshot.sizeBytes);
	const requestedAnchorBytes = reference?.anchorBytes ?? Math.min(boundedAnchorOffset, MAX_SOURCE_CHECKPOINT_BYTES);
	const anchorBytes = Math.min(requestedAnchorBytes, boundedAnchorOffset, readLimit);
	const anchorStart = boundedAnchorOffset - anchorBytes;
	const anchor = anchorBytes === 0 ? new Uint8Array() : await readAt(anchorStart, anchorBytes);
	const checkpointTailOffset = Math.min(reference?.tailOffset ?? snapshot.sizeBytes, snapshot.sizeBytes);
	const requestedTailBytes = reference?.tailBytes ?? Math.min(checkpointTailOffset, MAX_SOURCE_CHECKPOINT_BYTES);
	const tailBytes = Math.min(requestedTailBytes, checkpointTailOffset, readLimit);
	const tailStart = checkpointTailOffset - tailBytes;
	const tail = tailBytes === 0 ? new Uint8Array() : await readAt(tailStart, tailBytes);
	return {
		sourceSizeBytes: snapshot.sizeBytes,
		contentProofComplete: prefix.byteLength === snapshot.sizeBytes,
		sourceMutationFingerprint: snapshot.sourceMutationFingerprint ?? null,
		prefixDigest: digestBytes(prefix),
		prefixBytes: prefix.byteLength,
		anchorOffset: checkpointAnchorOffset,
		anchorDigest: digestBytes(anchor),
		anchorBytes: anchor.byteLength,
		tailOffset: checkpointTailOffset,
		tailDigest: digestBytes(tail),
		tailBytes: tail.byteLength,
	};
}

function cursorForSnapshot(
	snapshot: MonitorLogFileSnapshot,
	baseline: MonitorLogBaseline,
	seenEventIds: readonly string[] = [],
	authority: IncrementalMonitorLogCursorAuthority,
): IncrementalMonitorLogCursor {
	const start = baselineStart(snapshot, baseline);
	return withCursorMac(
		{
			version: 1,
			sourceCheckpoint: emptySourceCheckpoint(),
			sourceIdentity: snapshot.sourceIdentity,
			byteOffset: start.offset,
			trailingPartialLine: "",
			trailingPartialLineBytes: "",
			baseline,
			baselineOmittedBytes: start.omittedBytes,
			skipLeadingPartialLine: start.skipLeadingPartialLine,
			seenEventIds: [...seenEventIds],
		},
		authority,
	);
}

function cursorForTruncation(
	cursor: IncrementalMonitorLogCursor,
	authority: IncrementalMonitorLogCursorAuthority,
): IncrementalMonitorLogCursor {
	return withCursorMac(
		{
			...cursor,
			sourceCheckpoint: emptySourceCheckpoint(),
			byteOffset: 0,
			trailingPartialLine: "",
			trailingPartialLineBytes: "",
			baselineOmittedBytes: 0,
			skipLeadingPartialLine: false,
		},
		authority,
	);
}

function cursorForReplacement(
	snapshot: MonitorLogFileSnapshot,
	cursor: IncrementalMonitorLogCursor,
	authority: IncrementalMonitorLogCursorAuthority,
): IncrementalMonitorLogCursor {
	return cursorForSnapshot(snapshot, cursor.baseline, cursor.seenEventIds, authority);
}

async function alignBoundedHistoricalCursor(
	cursor: IncrementalMonitorLogCursor,
	readAt: (byteOffset: number, maxBytes: number) => Promise<Uint8Array>,
): Promise<IncrementalMonitorLogCursor> {
	if (cursor.baseline.mode !== "bounded_historical" || cursor.byteOffset === 0) return cursor;
	const predecessor = await readAt(cursor.byteOffset - 1, 1);
	return { ...cursor, skipLeadingPartialLine: predecessor.byteLength === 0 || predecessor[0] !== 10 };
}

function decodeBase64(value: string): Uint8Array {
	if (value.length === 0) return new Uint8Array();
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value) throw invalidInput("cursor_partial_bytes_invalid");
	return new Uint8Array(bytes);
}

function isIncompleteUtf8Suffix(bytes: Uint8Array): boolean {
	if (bytes.length === 0) return true;
	const first = bytes[0];
	const expectedLength =
		first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
	if (expectedLength === 0 || bytes.length >= expectedLength) return false;
	for (let index = 1; index < bytes.length; index += 1) {
		if (bytes[index] < 0x80 || bytes[index] > 0xbf) return false;
	}
	if (bytes.length > 1) {
		const second = bytes[1];
		if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second > 0x9f)) return false;
		if ((first === 0xf0 && second < 0x90) || (first === 0xf4 && second > 0x8f)) return false;
	}
	return true;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function encodeBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

type CursorWithoutMac = Omit<IncrementalMonitorLogCursor, "cursorMac">;

function cursorPayloadFor(cursor: CursorWithoutMac): string {
	const sourceCheckpoint = cursor.sourceCheckpoint;
	const payload = {
		version: cursor.version,
		sourceIdentity: {
			kind: cursor.sourceIdentity.kind,
			device: cursor.sourceIdentity.device,
			inode: cursor.sourceIdentity.inode,
			generation: cursor.sourceIdentity.generation,
		},
		sourceCheckpoint:
			sourceCheckpoint === null
				? null
				: {
						sourceSizeBytes: sourceCheckpoint.sourceSizeBytes,
						contentProofComplete: sourceCheckpoint.contentProofComplete,
						sourceMutationFingerprint: sourceCheckpoint.sourceMutationFingerprint,
						prefixDigest: sourceCheckpoint.prefixDigest,
						prefixBytes: sourceCheckpoint.prefixBytes,
						anchorOffset: sourceCheckpoint.anchorOffset,
						anchorDigest: sourceCheckpoint.anchorDigest,
						anchorBytes: sourceCheckpoint.anchorBytes,
						tailOffset: sourceCheckpoint.tailOffset,
						tailDigest: sourceCheckpoint.tailDigest,
						tailBytes: sourceCheckpoint.tailBytes,
					},
		byteOffset: cursor.byteOffset,
		trailingPartialLine: cursor.trailingPartialLine,
		trailingPartialLineBytes: cursor.trailingPartialLineBytes,
		baseline:
			cursor.baseline.mode === "bounded_historical"
				? { mode: cursor.baseline.mode, maxBytes: cursor.baseline.maxBytes }
				: { mode: cursor.baseline.mode },
		baselineOmittedBytes: cursor.baselineOmittedBytes,
		skipLeadingPartialLine: cursor.skipLeadingPartialLine,
		seenEventIds: cursor.seenEventIds,
	};
	return JSON.stringify(payload);
}

function withCursorMac(
	cursor: CursorWithoutMac,
	authority: IncrementalMonitorLogCursorAuthority,
): IncrementalMonitorLogCursor {
	const payload = cursorPayloadFor(cursor);
	const mac = authority.sign(payload);
	if (typeof mac !== "string" || mac.length === 0 || mac.length > 256) throw invalidInput("cursor_authority_invalid");
	return { ...cursor, cursorMac: mac };
}

function validateSourceCheckpoint(value: unknown): MonitorLogSourceCheckpoint | null {
	if (value === null) return null;
	assertClosedRecord(
		value,
		[
			"sourceSizeBytes",
			"contentProofComplete",
			"sourceMutationFingerprint",
			"prefixDigest",
			"prefixBytes",
			"anchorOffset",
			"anchorDigest",
			"anchorBytes",
			"tailOffset",
			"tailDigest",
			"tailBytes",
		],
		"cursor_source_checkpoint",
	);
	const candidate = value as Partial<MonitorLogSourceCheckpoint>;
	const sourceSizeBytes = candidate.sourceSizeBytes;
	const contentProofComplete = candidate.contentProofComplete;
	const sourceMutationFingerprint = candidate.sourceMutationFingerprint;
	const prefixDigest = candidate.prefixDigest;
	const prefixBytes = candidate.prefixBytes;
	const anchorOffset = candidate.anchorOffset;
	const anchorDigest = candidate.anchorDigest;
	const anchorBytes = candidate.anchorBytes;
	const tailOffset = candidate.tailOffset;
	const tailDigest = candidate.tailDigest;
	const tailBytes = candidate.tailBytes;
	if (
		typeof prefixDigest !== "string" ||
		!/^[0-9a-f]{64}$/.test(prefixDigest) ||
		typeof anchorDigest !== "string" ||
		!/^[0-9a-f]{64}$/.test(anchorDigest) ||
		typeof sourceSizeBytes !== "number" ||
		!Number.isSafeInteger(sourceSizeBytes) ||
		sourceSizeBytes < 0 ||
		typeof contentProofComplete !== "boolean" ||
		(contentProofComplete && prefixBytes !== undefined && prefixBytes !== sourceSizeBytes) ||
		(sourceMutationFingerprint !== null &&
			(typeof sourceMutationFingerprint !== "string" ||
				sourceMutationFingerprint.length === 0 ||
				sourceMutationFingerprint.length > 256)) ||
		typeof prefixBytes !== "number" ||
		!Number.isSafeInteger(prefixBytes) ||
		prefixBytes < 0 ||
		prefixBytes > MAX_SOURCE_CHECKPOINT_BYTES ||
		prefixBytes > sourceSizeBytes ||
		typeof anchorOffset !== "number" ||
		!Number.isSafeInteger(anchorOffset) ||
		anchorOffset < 0 ||
		anchorOffset > sourceSizeBytes ||
		typeof anchorBytes !== "number" ||
		!Number.isSafeInteger(anchorBytes) ||
		anchorBytes < 0 ||
		anchorBytes > MAX_SOURCE_CHECKPOINT_BYTES ||
		anchorBytes > anchorOffset ||
		typeof tailDigest !== "string" ||
		!/^[0-9a-f]{64}$/.test(tailDigest) ||
		typeof tailOffset !== "number" ||
		!Number.isSafeInteger(tailOffset) ||
		tailOffset < 0 ||
		tailOffset > sourceSizeBytes ||
		typeof tailBytes !== "number" ||
		!Number.isSafeInteger(tailBytes) ||
		tailBytes < 0 ||
		tailBytes > MAX_SOURCE_CHECKPOINT_BYTES ||
		tailBytes > tailOffset
	)
		throw invalidInput("cursor_source_checkpoint_invalid");
	return {
		sourceSizeBytes,
		contentProofComplete,
		sourceMutationFingerprint,
		prefixDigest,
		prefixBytes,
		anchorOffset,
		anchorDigest,
		anchorBytes,
		tailOffset,
		tailDigest,
		tailBytes,
	};
}

function normalizeCursor(
	cursor: IncrementalMonitorLogCursor,
	baseline: MonitorLogBaseline,
	maxPartialLineBytes: number,
	maxSeenEventIds: number,
	maxSeenEventIdsSerializedBytes: number,
	authority: IncrementalMonitorLogCursorAuthority,
): IncrementalMonitorLogCursor {
	assertClosedRecord(
		cursor,
		[
			"version",
			"cursorMac",
			"sourceIdentity",
			"sourceCheckpoint",
			"byteOffset",
			"trailingPartialLine",
			"trailingPartialLineBytes",
			"baseline",
			"baselineOmittedBytes",
			"skipLeadingPartialLine",
			"seenEventIds",
		],
		"cursor",
	);
	if (cursor.version !== 1) throw invalidInput("cursor_version_invalid");
	if (typeof cursor.cursorMac !== "string" || cursor.cursorMac.length === 0 || cursor.cursorMac.length > 256)
		throw invalidInput("cursor_mac_invalid");
	const sourceIdentity = validateIdentity(cursor.sourceIdentity);
	const sourceCheckpoint = validateSourceCheckpoint(cursor.sourceCheckpoint);
	if (sourceCheckpoint === null) throw invalidInput("cursor_source_checkpoint_required");
	const suppliedCursorMac = cursor.cursorMac;
	const cursorBaseline = normalizeBaseline(cursor.baseline);
	if (!sameBaseline(cursorBaseline, baseline)) throw invalidInput("cursor_baseline_mismatch");
	if (typeof cursor.trailingPartialLine !== "string") throw invalidInput("cursor_partial_line_invalid");
	if (typeof cursor.trailingPartialLineBytes !== "string") throw invalidInput("cursor_partial_bytes_invalid");
	if (cursor.trailingPartialLine.length > maxPartialLineBytes || cursor.trailingPartialLineBytes.length > 8)
		throw invalidInput("cursor_partial_line_limit_exceeded");
	const trailingBytes = decodeBase64(cursor.trailingPartialLineBytes);
	if (
		trailingBytes.byteLength > 3 ||
		cursor.trailingPartialLine.includes("\n") ||
		!isIncompleteUtf8Suffix(trailingBytes)
	)
		throw invalidInput("cursor_partial_bytes_invalid");
	const encodedPartialText = new TextEncoder().encode(cursor.trailingPartialLine);
	const normalizedPartial = decodeBytesPreservingIncomplete(concatBytes(encodedPartialText, trailingBytes));
	if (normalizedPartial.text !== cursor.trailingPartialLine || !sameBytes(normalizedPartial.incomplete, trailingBytes))
		throw invalidInput("cursor_partial_line_invalid");
	if (encodedPartialText.byteLength + trailingBytes.byteLength > maxPartialLineBytes)
		throw invalidInput("cursor_partial_line_limit_exceeded");
	if (!Number.isSafeInteger(cursor.byteOffset) || cursor.byteOffset < 0) throw invalidInput("cursor_offset_invalid");
	if (cursor.byteOffset > sourceCheckpoint.sourceSizeBytes) throw invalidInput("cursor_offset_checkpoint_invalid");
	if (!Number.isSafeInteger(cursor.baselineOmittedBytes) || cursor.baselineOmittedBytes < 0)
		throw invalidInput("cursor_baseline_omitted_bytes_invalid");
	if (cursor.baselineOmittedBytes > cursor.byteOffset) throw invalidInput("cursor_baseline_omitted_bytes_invalid");
	if (typeof cursor.skipLeadingPartialLine !== "boolean") throw invalidInput("cursor_leading_partial_line_invalid");
	if (
		!Array.isArray(cursor.seenEventIds) ||
		cursor.seenEventIds.some((id) => typeof id !== "string" || id.length === 0)
	)
		throw invalidInput("cursor_event_ids_invalid");
	if (cursor.seenEventIds.length > maxSeenEventIds) throw invalidInput("cursor_event_ids_limit_exceeded");
	if (new Set(cursor.seenEventIds).size !== cursor.seenEventIds.length)
		throw invalidInput("cursor_event_ids_duplicate");
	const seenEventIdsSerializedBytes = serializeEventIds(cursor.seenEventIds);
	if (seenEventIdsSerializedBytes > maxSeenEventIdsSerializedBytes)
		throw invalidInput("cursor_event_ids_serialized_limit_exceeded");
	const canonicalCursor: CursorWithoutMac = {
		version: 1,
		sourceIdentity,
		sourceCheckpoint,
		byteOffset: cursor.byteOffset,
		trailingPartialLine: cursor.trailingPartialLine,
		trailingPartialLineBytes: encodeBase64(trailingBytes),
		baseline: cursorBaseline,
		baselineOmittedBytes: cursor.baselineOmittedBytes,
		skipLeadingPartialLine: cursor.skipLeadingPartialLine,
		seenEventIds: [...cursor.seenEventIds],
	};
	let verified = false;
	try {
		verified = authority.verify(cursorPayloadFor(canonicalCursor), suppliedCursorMac);
	} catch (error) {
		throw invalidInput(error instanceof Error ? "cursor_authority_failed" : "cursor_authority_invalid");
	}
	if (verified !== true) throw invalidInput("cursor_mac_mismatch");
	return { ...canonicalCursor, cursorMac: suppliedCursorMac };
}

function runtimeType(value: unknown): string {
	return typeof value === "object" && value !== null ? "object" : typeof value;
}

function defaultJsonParser<TEvent>(line: string): TEvent | null {
	if (line.trim().length === 0) return null;
	try {
		return JSON.parse(line) as TEvent;
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}

function defaultEventIdentity<TEvent>(
	event: TEvent,
	line: string,
	sourceByteOffset: number,
	sourceIdentity: MonitorLogSourceIdentity,
): string {
	const scope = `${sourceIdentity.generation}:offset:${sourceByteOffset}`;
	if (typeof event === "object" && event !== null) {
		const record = event as Record<string, unknown>;
		for (const key of ["eventId", "event_id", "id", "sequence"]) {
			try {
				const value = record[key];
				if (
					(typeof value === "string" && value.length > 0) ||
					(typeof value === "number" && Number.isSafeInteger(value))
				)
					return `${scope}:id:${String(value)}`;
			} catch (error) {
				if (error instanceof Error) continue;
				throw error;
			}
		}
	}
	return `${scope}:line:${digest(line)}`;
}

function decodeBytesPreservingIncomplete(bytes: Uint8Array): DecodedBytes {
	if (bytes.length === 0) return { text: "", incomplete: new Uint8Array() };
	const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
	const maxSuffix = Math.min(3, bytes.length);
	for (let suffixLength = 0; suffixLength <= maxSuffix; suffixLength += 1) {
		const split = bytes.length - suffixLength;
		try {
			return {
				text: fatalDecoder.decode(bytes.subarray(0, split)),
				incomplete: bytes.slice(split),
			};
		} catch (error) {
			if (!(error instanceof TypeError)) throw error;
		}
	}
	return { text: new TextDecoder().decode(bytes), incomplete: new Uint8Array() };
}

function decodeCompleteLine(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	if (left.length === 0) return right;
	if (right.length === 0) return left;
	const combined = new Uint8Array(left.length + right.length);
	combined.set(left, 0);
	combined.set(right, left.length);
	return combined;
}

function serializeCursor(cursor: IncrementalMonitorLogCursor): number {
	return new TextEncoder().encode(JSON.stringify(cursor)).byteLength;
}

function serializeEventIds(eventIds: readonly string[]): number {
	let bytes = 2;
	for (const [index, eventId] of eventIds.entries()) {
		if (typeof eventId !== "string") throw invalidInput("event_id_serialization_invalid");
		if (eventId.length > MAX_SAFE_SEEN_EVENT_IDS_SERIALIZED_BYTES) throw invalidInput("event_id_oversize");
		bytes += (index === 0 ? 0 : 1) + Buffer.byteLength(JSON.stringify(eventId), "utf8");
		if (bytes > MAX_SAFE_SEEN_EVENT_IDS_SERIALIZED_BYTES) return bytes;
	}
	return bytes;
}

function serializedEventValueBytes(value: unknown): number {
	const seen = new Set<object>();
	const bounded = (candidate: unknown, depth: number): number => {
		if (depth > 100) throw invalidInput("event_serialization_depth");
		if (candidate === null) return 4;
		switch (typeof candidate) {
			case "string":
				return Buffer.byteLength(JSON.stringify(candidate), "utf8");
			case "number":
			case "boolean":
				return Number.isFinite(candidate) ? Buffer.byteLength(String(candidate), "utf8") : 4;
			case "undefined":
			case "function":
			case "symbol":
				return 4;
			case "bigint":
				throw invalidInput("event_serialization_invalid");
			case "object":
				break;
		}
		if (seen.has(candidate)) throw invalidInput("event_serialization_circular");
		let prototype: object | null;
		try {
			prototype = Object.getPrototypeOf(candidate);
		} catch (error) {
			throw invalidInput(error instanceof Error ? "event_serialization_unsafe" : "event_serialization_failed");
		}
		if (prototype !== null && prototype !== Object.prototype && !Array.isArray(candidate))
			return Buffer.byteLength("[externalized]", "utf8");
		seen.add(candidate);
		try {
			if (Array.isArray(candidate)) {
				let bytes = 2;
				for (let index = 0; index < candidate.length; index += 1) {
					const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
					if (descriptor !== undefined && !("value" in descriptor))
						throw invalidInput("event_serialization_unsafe");
					const itemBytes =
						descriptor === undefined || descriptor.value === undefined ? 4 : bounded(descriptor.value, depth + 1);
					bytes += (index === 0 ? 0 : 1) + itemBytes;
					if (bytes > MAX_RETAINED_EVENT_SERIALIZED_BYTES) throw invalidInput("event_serialized_oversize");
				}
				return bytes;
			}
			const keys = Object.keys(candidate);
			let bytes = 2;
			for (const [index, key] of keys.entries()) {
				const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
				if (descriptor === undefined || !("value" in descriptor)) throw invalidInput("event_serialization_unsafe");
				const keyBytes = Buffer.byteLength(JSON.stringify(key), "utf8");
				const valueBytes = bounded(descriptor.value, depth + 1);
				bytes += (index === 0 ? 0 : 1) + keyBytes + 1 + valueBytes;
				if (bytes > MAX_RETAINED_EVENT_SERIALIZED_BYTES) throw invalidInput("event_serialized_oversize");
			}
			return bytes;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("incremental_monitor_log_")) throw error;
			throw invalidInput("event_serialization_failed");
		} finally {
			seen.delete(candidate);
		}
	};
	return bounded(value, 0);
}

function createTelemetry(
	cursor: IncrementalMonitorLogCursor,
	eventMetadata: readonly { readonly bytes: number; readonly type: string }[],
	maxLargestRetainedValues: number,
	physical: PhysicalBudgetTelemetry,
): MonitorLogRetentionTelemetry {
	const cursorSerializedBytes = serializeCursor(cursor);
	const cursorPartialLineBytes =
		new TextEncoder().encode(cursor.trailingPartialLine).byteLength +
		decodeBase64(cursor.trailingPartialLineBytes).byteLength;
	const cursorEventIdBytes = serializeEventIds(cursor.seenEventIds);
	const serializedEventBytes = eventMetadata.reduce((total, event) => total + event.bytes, 0);
	const values: MonitorLogRetainedValueTelemetry[] = [
		{ kind: "cursor", type: "cursor", serializedBytes: cursorSerializedBytes },
		{ kind: "cursor", type: "cursor_partial_line", serializedBytes: cursorPartialLineBytes },
		{ kind: "cursor", type: "cursor_event_ids", serializedBytes: cursorEventIdBytes },
		...eventMetadata.map((event) => ({ kind: "event" as const, type: event.type, serializedBytes: event.bytes })),
	];
	values.sort((left, right) => right.serializedBytes - left.serializedBytes);
	return {
		cursorSerializedBytes,
		cursorPartialLineBytes,
		cursorEventIdBytes,
		serializedEventBytes,
		contentBytesRead: physical.contentBytesRead,
		checkpointBytesRead: physical.checkpointBytesRead,
		metadataBytes: physical.metadataBytes,
		physicalBytes: physical.physicalBytes,
		retainedEventCount: eventMetadata.length,
		largestRetainedValues: values.slice(0, maxLargestRetainedValues),
	};
}

function createNormalizedOptions<TEvent>(
	options: IncrementalMonitorLogReaderOptions<TEvent>,
): NormalizedOptions<TEvent> {
	if (typeof options.path !== "string" || options.path.length === 0 || options.path.length > 4096)
		throw invalidInput("path_invalid");
	if (
		typeof options.cursorAuthority !== "object" ||
		options.cursorAuthority === null ||
		typeof options.cursorAuthority.sign !== "function" ||
		typeof options.cursorAuthority.verify !== "function"
	)
		throw invalidInput("cursor_authority_required");
	const baseline = normalizeBaseline(options.baseline);
	const limits = normalizeLimits(options.limits);
	const checkpointReadBytes = Math.max(
		1,
		Math.min(CHECKPOINT_READ_BYTES, Math.floor((limits.maxBytes - MIN_PAGE_METADATA_BYTES) / 15)),
	);
	return {
		path: options.path,
		baseline,
		cursorAuthority: options.cursorAuthority,
		fileSystem: options.fileSystem ?? createNodeIncrementalMonitorLogFileSystem(),
		parseLine: options.parseLine ?? defaultJsonParser<TEvent>,
		isRelevant: options.isRelevant ?? (() => true),
		eventIdentity: options.eventIdentity ?? defaultEventIdentity,
		limits,
		maxPartialLineBytes: normalizeCappedBound(
			options.maxPartialLineBytes,
			DEFAULT_MAX_PARTIAL_LINE_BYTES,
			"max_partial_line_bytes",
			MAX_SAFE_PARTIAL_LINE_BYTES,
		),
		maxSeenEventIds: normalizeCappedBound(
			options.maxSeenEventIds,
			DEFAULT_MAX_SEEN_EVENT_IDS,
			"max_seen_event_ids",
			MAX_SAFE_SEEN_EVENT_IDS,
		),
		maxSeenEventIdsSerializedBytes: (() => {
			const value = safeInteger(
				options.maxSeenEventIdsSerializedBytes ?? DEFAULT_MAX_SEEN_EVENT_IDS_SERIALIZED_BYTES,
				"max_seen_event_ids_serialized_bytes",
				2,
			);
			if (value > MAX_SAFE_SEEN_EVENT_IDS_SERIALIZED_BYTES)
				throw invalidInput("max_seen_event_ids_serialized_bytes_unsafe");
			return value;
		})(),
		maxLargestRetainedValues: normalizeCappedBound(
			options.maxLargestRetainedValues,
			DEFAULT_MAX_LARGEST_RETAINED_VALUES,
			"max_largest_retained_values",
			MAX_SAFE_LARGEST_RETAINED_VALUES,
		),
		checkpointReadBytes,
		finalCheckpointPhysicalBytes: checkpointPhysicalBytes(checkpointReadBytes),
		clock: options.clock ?? (() => performance.now()),
	};
}

/** Create the Node positional filesystem adapter used by the default reader. */
export function createNodeIncrementalMonitorLogFileSystem(): IncrementalMonitorLogFileSystem {
	return {
		open: async (path) => {
			const pathSnapshot = async (): Promise<MonitorLogFileSnapshot> => {
				const stats = await lstat(path);
				if (stats.isSymbolicLink()) throw invalidInput("symlink_rejected");
				if (!stats.isFile()) throw invalidInput("source_not_regular_file");
				return snapshotFromStats(stats);
			};
			await pathSnapshot();
			const file = await openFile(path, fsConstants.O_RDONLY | O_NOFOLLOW);
			let closed = false;
			try {
				const expectedHandle = snapshotFromStats(await file.stat());
				const assertStable = async (): Promise<MonitorLogFileSnapshot> => {
					if (closed) throw invalidInput("handle_closed");
					const handleSnapshot = snapshotFromStats(await file.stat());
					const currentPath = await pathSnapshot();
					if (!sameIdentity(expectedHandle.sourceIdentity, handleSnapshot.sourceIdentity))
						throw invalidInput("source_changed_retry");
					if (!sameIdentity(expectedHandle.sourceIdentity, currentPath.sourceIdentity))
						throw invalidInput("source_changed_retry");
					return handleSnapshot;
				};
				await assertStable();
				return {
					stat: assertStable,
					readAt: async (byteOffset, maxBytes) => {
						safeInteger(byteOffset, "read_offset");
						safeInteger(maxBytes, "read_max_bytes", 1);
						await assertStable();
						const buffer = Buffer.allocUnsafe(maxBytes);
						let bytesRead = 0;
						while (bytesRead < maxBytes) {
							const result = await file.read(buffer, bytesRead, maxBytes - bytesRead, byteOffset + bytesRead);
							if (result.bytesRead <= 0) break;
							bytesRead += result.bytesRead;
						}
						await assertStable();
						return new Uint8Array(buffer.subarray(0, bytesRead));
					},
					close: async () => {
						if (closed) return;
						closed = true;
						await file.close();
					},
				};
			} catch (error) {
				closed = true;
				await file.close().catch(() => undefined);
				throw error;
			}
		},
	};
}

class IncrementalMonitorLogBudgetExceeded extends Error {
	constructor() {
		super("incremental_monitor_log_budget_exceeded");
	}
}

/**
 * Create a stateless incremental reader over a newline-delimited monitor log.
 * Args:
 * options: Source path, explicit baseline, parser/filter, page bounds, and optional filesystem port.
 * Return: Reader whose pages contain only relevant parsed events and a durable cursor.
 */
export function createIncrementalMonitorLogReader<TEvent>(
	options: IncrementalMonitorLogReaderOptions<TEvent>,
): IncrementalMonitorLogReader<TEvent> {
	const normalized = createNormalizedOptions(options);

	const readPage = async (inputCursor?: IncrementalMonitorLogCursor): Promise<IncrementalMonitorLogPage<TEvent>> => {
		const startedAt = normalized.clock();
		const inputState =
			inputCursor === undefined
				? undefined
				: normalizeCursor(
						inputCursor,
						normalized.baseline,
						normalized.maxPartialLineBytes,
						normalized.maxSeenEventIds,
						normalized.maxSeenEventIdsSerializedBytes,
						normalized.cursorAuthority,
					);
		let handle: IncrementalMonitorLogFileHandle | undefined;
		let rollbackCursor = inputState;
		let knownSnapshot: MonitorLogFileSnapshot | undefined;
		const events: TEvent[] = [];
		const eventMetadata: Array<{ readonly bytes: number; readonly type: string }> = [];
		let contentBytesRead = 0;
		let checkpointBytesRead = 0;
		let metadataBytes = 0;
		let physicalBytes = 0;
		const assertDeadline = (): void => {
			if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs)
				throw new IncrementalMonitorLogBudgetExceeded();
		};
		const chargePhysical = (bytes: number, metadata: boolean): void => {
			if (physicalBytes + bytes > normalized.limits.maxBytes) throw new IncrementalMonitorLogBudgetExceeded();
			physicalBytes += bytes;
			if (metadata) metadataBytes += bytes;
		};

		const buildPage = (
			cursor: IncrementalMonitorLogCursor,
			hasMore: boolean,
			pageEvents: readonly TEvent[],
			metadata: readonly { readonly bytes: number; readonly type: string }[],
			enforceDeadline = true,
		): IncrementalMonitorLogPage<TEvent> => {
			if (enforceDeadline) assertDeadline();
			const telemetry = createTelemetry(cursor, metadata, normalized.maxLargestRetainedValues, {
				contentBytesRead,
				checkpointBytesRead,
				metadataBytes,
				physicalBytes,
			});
			if (enforceDeadline) assertDeadline();
			let retainedEvents = [...pageEvents];
			let released = false;
			const ephemeral: IncrementalMonitorLogEphemeralResult = {
				release: () => {
					retainedEvents = [];
					released = true;
				},
				get released() {
					return released;
				},
			};
			return {
				get events(): readonly TEvent[] {
					return retainedEvents;
				},
				cursor,
				continuation: { hasMore, cursor },
				telemetry,
				ephemeral,
			};
		};

		try {
			assertDeadline();
			chargePhysical(PHYSICAL_OPERATION_BYTES, true);
			handle = await normalized.fileSystem.open(normalized.path);
			assertDeadline();
			const readAtBounded = async (
				byteOffset: number,
				maxBytes: number,
				kind: "content" | "checkpoint",
				reserveBytes = 0,
			): Promise<Uint8Array> => {
				safeInteger(byteOffset, "read_offset");
				safeInteger(maxBytes, "read_max_bytes", 1);
				const availableBytes = normalized.limits.maxBytes - physicalBytes - PHYSICAL_OPERATION_BYTES - reserveBytes;
				if (availableBytes < 1) throw new IncrementalMonitorLogBudgetExceeded();
				const requestBytes = Math.min(maxBytes, availableBytes);
				assertDeadline();
				const bytes = await handle!.readAt(byteOffset, requestBytes);
				if (bytes.byteLength > requestBytes) throw invalidInput("filesystem_read_exceeded_bound");
				chargePhysical(PHYSICAL_OPERATION_BYTES, true);
				chargePhysical(bytes.byteLength, false);
				if (kind === "content") contentBytesRead += bytes.byteLength;
				else checkpointBytesRead += bytes.byteLength;
				assertDeadline();
				return bytes;
			};
			const statBounded = async (): Promise<MonitorLogFileSnapshot> => {
				assertDeadline();
				chargePhysical(PHYSICAL_OPERATION_BYTES, true);
				const rawSnapshot = await handle!.stat();
				assertDeadline();
				const snapshot = normalizeSnapshot(rawSnapshot);
				assertDeadline();
				return snapshot;
			};
			const firstSnapshot = await statBounded();
			knownSnapshot = firstSnapshot;

			let state =
				inputState ?? cursorForSnapshot(firstSnapshot, normalized.baseline, [], normalized.cursorAuthority);
			if (!sameIdentity(state.sourceIdentity, firstSnapshot.sourceIdentity)) {
				state = cursorForReplacement(firstSnapshot, state, normalized.cursorAuthority);
				if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs)
					throw new IncrementalMonitorLogBudgetExceeded();
				state = await alignBoundedHistoricalCursor(state, (offset, length) =>
					readAtBounded(offset, length, "checkpoint", normalized.finalCheckpointPhysicalBytes),
				);
				if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs)
					throw new IncrementalMonitorLogBudgetExceeded();
			} else if (firstSnapshot.sizeBytes < state.byteOffset) {
				state = cursorForTruncation(state, normalized.cursorAuthority);
			} else if (inputState?.sourceCheckpoint !== null && inputState?.sourceCheckpoint !== undefined) {
				let preflightCheckpointReadsCompleted = 0;
				const currentCheckpoint = await computeSourceCheckpoint(
					firstSnapshot,
					state.byteOffset,
					async (offset, length) => {
						if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs)
							throw new IncrementalMonitorLogBudgetExceeded();
						const bytes = await readAtBounded(
							offset,
							Math.min(length, normalized.checkpointReadBytes),
							"checkpoint",
							preflightCheckpointReadsCompleted === 0
								? (PHYSICAL_OPERATION_BYTES + normalized.checkpointReadBytes) * 2
								: preflightCheckpointReadsCompleted === 1
									? PHYSICAL_OPERATION_BYTES + normalized.checkpointReadBytes
									: PHYSICAL_OPERATION_BYTES,
						);
						preflightCheckpointReadsCompleted += 1;
						if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs)
							throw new IncrementalMonitorLogBudgetExceeded();
						return bytes;
					},
					inputState.sourceCheckpoint,
					normalized.checkpointReadBytes,
				);
				const checkpointMatches = sameSourceCheckpoint(inputState.sourceCheckpoint, currentCheckpoint);
				const sourceProofIncomplete =
					!inputState.sourceCheckpoint.contentProofComplete ||
					inputState.sourceCheckpoint.sourceMutationFingerprint === null ||
					firstSnapshot.sourceMutationFingerprint === undefined;
				if (
					checkpointMatches &&
					sourceProofIncomplete &&
					state.trailingPartialLine.length === 0 &&
					(inputState.sourceCheckpoint.sourceSizeBytes !== firstSnapshot.sizeBytes ||
						sourceMutationChanged(inputState.sourceCheckpoint, firstSnapshot)) &&
					state.baseline.mode !== "from_end"
				)
					throw invalidInput("rebaseline_required");
				if (inputState.sourceCheckpoint.sourceSizeBytes === firstSnapshot.sizeBytes) {
					if (checkpointMatches && sameSizeSourceMutationChanged(inputState.sourceCheckpoint, firstSnapshot))
						throw invalidInput("rebaseline_required");
					if (!checkpointMatches) state = cursorForTruncation(state, normalized.cursorAuthority);
				} else if (!checkpointMatches) {
					state = cursorForTruncation(state, normalized.cursorAuthority);
				}
			}
			if (state.baseline.mode === "bounded_historical" && state.byteOffset > 0 && state.skipLeadingPartialLine) {
				if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs)
					throw new IncrementalMonitorLogBudgetExceeded();
				const predecessor = await readAtBounded(
					state.byteOffset - 1,
					1,
					"checkpoint",
					normalized.finalCheckpointPhysicalBytes,
				);
				if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs)
					throw new IncrementalMonitorLogBudgetExceeded();
				state = { ...state, skipLeadingPartialLine: predecessor.byteLength === 0 || predecessor[0] !== 10 };
			}
			rollbackCursor = state.sourceCheckpoint === null ? inputState : state;

			const sourceIdentity = state.sourceIdentity;
			let byteOffset = state.byteOffset;
			let trailingPartialLine = state.trailingPartialLine;
			let trailingPartialBytes = decodeBase64(state.trailingPartialLineBytes);
			let partialByteLength = new TextEncoder().encode(trailingPartialLine).byteLength + trailingPartialBytes.length;
			let skipLeadingPartialLine = state.skipLeadingPartialLine;
			const seenEventIds = new Set(state.seenEventIds);
			const nextSeenEventIds = [...state.seenEventIds];
			// A positional read that crosses the deadline is charged, then rejected; no bytes or cursor state are committed.
			const readContent = async (offset: number, maxBytes: number): Promise<Uint8Array> => {
				return readAtBounded(offset, maxBytes, "content");
			};

			const appendPartial = (bytes: Uint8Array): void => {
				if (bytes.length === 0) return;
				const decoded = decodeBytesPreservingIncomplete(concatBytes(trailingPartialBytes, bytes));
				trailingPartialLine += decoded.text;
				trailingPartialBytes = decoded.incomplete;
				partialByteLength += bytes.length;
				if (partialByteLength > normalized.maxPartialLineBytes) throw invalidInput("partial_line_limit_exceeded");
			};

			const processLine = (lineBytes: Uint8Array, lineOffset: number): ProcessedLine => {
				const previousPartial = trailingPartialLine;
				const previousPartialBytes = trailingPartialBytes;
				const previousPartialByteLength = partialByteLength;
				const decodedLineBytes = concatBytes(trailingPartialBytes, lineBytes);
				const lineText = decodeCompleteLine(decodedLineBytes);
				const line = previousPartial + lineText;
				const eventSourceOffset = lineOffset - previousPartialByteLength;
				const restore = (): ProcessedLine => {
					trailingPartialLine = previousPartial;
					trailingPartialBytes = previousPartialBytes;
					partialByteLength = previousPartialByteLength;
					return { status: "defer", eventBytes: 0, eventType: null };
				};
				if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs) return restore();
				if (skipLeadingPartialLine) {
					skipLeadingPartialLine = false;
					trailingPartialLine = "";
					trailingPartialBytes = new Uint8Array();
					partialByteLength = 0;
					return { status: "processed", eventBytes: 0, eventType: null };
				}
				const parsed = normalized.parseLine(line);
				if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs) return restore();
				const relevant = parsed !== null && normalized.isRelevant(parsed);
				if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs) return restore();
				if (parsed === null || !relevant) {
					trailingPartialLine = "";
					trailingPartialBytes = new Uint8Array();
					partialByteLength = 0;
					return { status: "processed", eventBytes: 0, eventType: null };
				}
				const eventId = normalized.eventIdentity(parsed, line, eventSourceOffset, sourceIdentity);
				if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs) return restore();
				if (typeof eventId !== "string" || eventId.length === 0) throw invalidInput("event_identity_invalid");
				if (seenEventIds.has(eventId)) {
					trailingPartialLine = "";
					trailingPartialBytes = new Uint8Array();
					partialByteLength = 0;
					return { status: "processed", eventBytes: 0, eventType: null };
				}
				if (events.length >= normalized.limits.maxEvents) return restore();
				if (nextSeenEventIds.length >= normalized.maxSeenEventIds) throw invalidInput("dedup_limit_exceeded");
				const nextIdsBytes = serializeEventIds([...nextSeenEventIds, eventId]);
				if (nextIdsBytes > normalized.maxSeenEventIdsSerializedBytes)
					throw invalidInput("dedup_serialized_limit_exceeded");
				const serializedEventBytes = serializedEventValueBytes(parsed);
				if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs) return restore();
				seenEventIds.add(eventId);
				nextSeenEventIds.push(eventId);
				trailingPartialLine = "";
				trailingPartialBytes = new Uint8Array();
				partialByteLength = 0;
				events.push(parsed);
				eventMetadata.push({ bytes: serializedEventBytes, type: runtimeType(parsed) });
				return { status: "processed", eventBytes: serializedEventBytes, eventType: runtimeType(parsed) };
			};

			let stop = false;
			while (
				!stop &&
				contentBytesRead < normalized.limits.maxBytes &&
				events.length < normalized.limits.maxEvents &&
				physicalBytes + normalized.finalCheckpointPhysicalBytes + PHYSICAL_OPERATION_BYTES <
					normalized.limits.maxBytes
			) {
				if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs) break;
				const snapshot = await statBounded();
				knownSnapshot = snapshot;
				if (!sameIdentity(snapshot.sourceIdentity, sourceIdentity)) throw invalidInput("source_changed_retry");
				if (snapshot.sizeBytes < byteOffset) throw invalidInput("source_changed_retry");
				if (byteOffset >= snapshot.sizeBytes) break;
				const remainingForContent =
					normalized.limits.maxBytes -
					physicalBytes -
					normalized.finalCheckpointPhysicalBytes -
					PHYSICAL_OPERATION_BYTES;
				if (remainingForContent < 1) break;
				const requestBytes = Math.min(
					MAX_READ_CHUNK_BYTES,
					contentBytesRead < normalized.limits.maxBytes ? remainingForContent : 0,
					snapshot.sizeBytes - byteOffset,
				);
				const chunkOffset = byteOffset;
				const bytes = await readContent(chunkOffset, requestBytes);
				if (bytes.byteLength === 0) break;
				let segmentStart = 0;
				for (let index = 0; index < bytes.byteLength; index += 1) {
					if (bytes[index] !== 10) continue;
					if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs) {
						stop = true;
						break;
					}
					const processed = processLine(bytes.subarray(segmentStart, index), chunkOffset + segmentStart);
					if (processed.status === "defer") {
						stop = true;
						break;
					}
					segmentStart = index + 1;
					byteOffset = chunkOffset + segmentStart;
					if (events.length >= normalized.limits.maxEvents) {
						stop = true;
						break;
					}
				}
				if (!stop) {
					appendPartial(bytes.subarray(segmentStart));
					byteOffset = chunkOffset + bytes.byteLength;
				} else if (segmentStart > 0) {
					byteOffset = chunkOffset + segmentStart;
				}
			}

			if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs)
				throw new IncrementalMonitorLogBudgetExceeded();
			const finalSnapshot = await statBounded();
			knownSnapshot = finalSnapshot;
			if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs)
				throw new IncrementalMonitorLogBudgetExceeded();
			if (!sameIdentity(finalSnapshot.sourceIdentity, sourceIdentity)) throw invalidInput("source_changed_retry");
			if (finalSnapshot.sizeBytes < byteOffset) throw invalidInput("source_changed_retry");
			if (finalSnapshot.sourceMutationFingerprint !== firstSnapshot.sourceMutationFingerprint)
				throw invalidInput("source_changed_retry");
			let finalCheckpointReadsCompleted = 0;
			const finalCheckpoint = await computeSourceCheckpoint(
				finalSnapshot,
				byteOffset,
				async (offset, length) => {
					if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs)
						throw new IncrementalMonitorLogBudgetExceeded();
					const bytes = await readAtBounded(
						offset,
						Math.min(length, normalized.checkpointReadBytes),
						"checkpoint",
						finalCheckpointReadsCompleted === 0
							? (normalized.checkpointReadBytes + PHYSICAL_OPERATION_BYTES) * 2 + PHYSICAL_OPERATION_BYTES
							: finalCheckpointReadsCompleted === 1
								? normalized.checkpointReadBytes + PHYSICAL_OPERATION_BYTES * 2
								: PHYSICAL_OPERATION_BYTES,
					);
					finalCheckpointReadsCompleted += 1;
					if (normalized.clock() - startedAt >= normalized.limits.maxElapsedMs)
						throw new IncrementalMonitorLogBudgetExceeded();
					return bytes;
				},
				null,
				normalized.checkpointReadBytes,
			);
			const verifiedSnapshot = await statBounded();
			knownSnapshot = verifiedSnapshot;
			if (!sameIdentity(verifiedSnapshot.sourceIdentity, sourceIdentity)) throw invalidInput("source_changed_retry");
			if (verifiedSnapshot.sizeBytes < byteOffset) throw invalidInput("source_changed_retry");
			if (verifiedSnapshot.sizeBytes !== firstSnapshot.sizeBytes) throw invalidInput("source_changed_retry");
			if (verifiedSnapshot.sourceMutationFingerprint !== firstSnapshot.sourceMutationFingerprint)
				throw invalidInput("source_changed_retry");
			const finalCursor = withCursorMac(
				{
					version: 1,
					sourceIdentity,
					sourceCheckpoint: finalCheckpoint,
					byteOffset,
					trailingPartialLine,
					trailingPartialLineBytes: encodeBase64(trailingPartialBytes),
					baseline: normalized.baseline,
					baselineOmittedBytes: state.baselineOmittedBytes,
					skipLeadingPartialLine,
					seenEventIds: [...nextSeenEventIds],
				},
				normalized.cursorAuthority,
			);
			return buildPage(finalCursor, byteOffset < verifiedSnapshot.sizeBytes, events, eventMetadata);
		} catch (error) {
			if (!(error instanceof IncrementalMonitorLogBudgetExceeded)) throw error;
			const cursor = rollbackCursor ?? inputState;
			if (cursor === undefined) throw error;
			const hasMore = knownSnapshot === undefined || cursor.byteOffset < knownSnapshot.sizeBytes;
			return buildPage(cursor, hasMore, [], []);
		} finally {
			await handle?.close().catch(() => undefined);
		}
	};

	return { readPage };
}
