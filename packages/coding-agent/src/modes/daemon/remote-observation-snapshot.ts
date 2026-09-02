/**
 * B11-b: RemoteObservationSnapshotV1 codec — exact observation state capture/restore.
 *
 * Encodes/decodes the complete mirror core for exact restart:
 * version, hostId/generation/sessionId, capturedAt, cursor/cursorTimestamp,
 * gap flags, nextMessageIndex, transcript records, activity/session/compact/
 * checkpoint state, bash, recap, lastFailure. No raw remote error messages.
 *
 * The decoder validates every descriptor before reads: rejects accessors,
 * symbols, nonenumerables, sparse arrays, undefined, prototypes,
 * missing/extra keys. Every optional is exact: present malformed rejects.
 * Constructs new recursively frozen DTOs with no input alias.
 *
 * Cumulative budget: <=1 MiB UTF-8 JSON-equivalent bytes, <=2,000 nodes,
 * depth <=8; per-string limits from B11-a. Any impossible/corrupt snapshot
 * fails closed with SnapshotRejectionCode.
 */
import type { RemoteHostEventSequence, RemoteHostSessionState } from "./remote-agent-host-protocol.js";

export type {
	RemoteHostEventSequence,
	RemoteHostSessionState,
} from "./remote-agent-host-protocol.js";
// ---------------------------------------------------------------------------
// Re-export types from mirror
// ---------------------------------------------------------------------------
export type {
	BashState,
	LastFailureMarker,
	MirrorActivity,
	MirrorAssistantRecord,
	MirrorRejectionCode,
	RecapEntry,
} from "./remote-observation-mirror.js";

// ---------------------------------------------------------------------------
// SnapshotRejectionCode — fixed set, no raw remote error messages
// ---------------------------------------------------------------------------
export type SnapshotRejectionCode =
	| "NOT_AN_OBJECT"
	| "MISSING_VERSION"
	| "INVALID_VERSION"
	| "INVALID_ID"
	| "INVALID_CAPTURED_AT"
	| "INVALID_CURSOR_TIMESTAMP"
	| "INVALID_CURSOR"
	| "INVALID_GAP_INVARIANT"
	| "INVALID_NEXT_MESSAGE_INDEX"
	| "INVALID_MESSAGE_COUNT"
	| "INVALID_ACTIVITY_STATE"
	| "INVALID_SESSION_STATE"
	| "INVALID_BASH_STATE"
	| "INVALID_BASH_STRUCTURE"
	| "INVALID_BOOLEAN"
	| "INVALID_NUMBER"
	| "INVALID_STRING"
	| "INVALID_TIMESTAMP_ORDER"
	| "INVALID_RECORD_INDEX"
	| "INVALID_RECORD_COUNT"
	| "INVALID_RECORD_STRUCTURE"
	| "INVALID_RECAP_COUNT"
	| "INVALID_RECAP_ENTRY"
	| "INVALID_RECAP_SEQUENCE"
	| "INVALID_RECAP_TYPE"
	| "INVALID_LAST_FAILURE"
	| "INVALID_COMPACT_STATE"
	| "INVALID_CHECKPOINT_STATE"
	| "IDENTITY_MISMATCH"
	| "ACCESSOR_DETECTED"
	| "SPARSE_ARRAY"
	| "SYMBOL_DETECTED"
	| "NONENUMERABLE_DETECTED"
	| "PROTOTYPE_POLLUTION"
	| "UNKNOWN_FIELD"
	| "MALFORMED_OPTIONAL"
	| "OVERFLOW_BYTES"
	| "OVERFLOW_NODES"
	| "OVERFLOW_DEPTH"
	| "STRING_OVERFLOW"
	| "CORRUPT_SNAPSHOT";

// ---------------------------------------------------------------------------
// RemoteObservationSnapshotV1 — versioned snapshot type
// ---------------------------------------------------------------------------
export interface RemoteObservationSnapshotV1 {
	readonly version: "1";
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly capturedAt: string;
	readonly cursor: RemoteHostEventSequence;
	readonly cursorTimestamp: string;
	readonly hasGap: boolean;
	readonly needsReplay: boolean;
	readonly nextMessageIndex: number;
	readonly records: ReadonlyArray<{
		readonly index: number;
		readonly text: string;
		readonly thinking: string;
		readonly toolCallText: string;
		readonly emittedAt: string;
		readonly updatedAt: string;
		readonly textTruncated: boolean;
		readonly thinkingTruncated: boolean;
		readonly toolCallTruncated: boolean;
	}>;
	readonly messageCount: number;
	readonly agentRunning: boolean;
	readonly sessionState: RemoteHostSessionState | null;
	readonly compacting: boolean;
	readonly checkpointing: boolean;
	readonly bash: {
		readonly command: string;
		readonly output: string;
		readonly exitCode: number | null;
		readonly cancelled: boolean;
		readonly truncated: boolean;
	} | null;
	readonly recap: ReadonlyArray<{
		readonly eventSequence: number;
		readonly type: string;
		readonly messageIndex?: number;
	}>;
	readonly lastFailure:
		| { readonly type: "error"; readonly code: string }
		| { readonly type: "compact_failed" }
		| { readonly type: "checkpoint_failed" }
		| { readonly type: "none" };
}

// ---------------------------------------------------------------------------
// Decode result
// ---------------------------------------------------------------------------
export type SnapshotDecodeResult =
	| { readonly success: true; readonly value: RemoteObservationSnapshotV1 }
	| { readonly success: false; readonly code: SnapshotRejectionCode };

// ---------------------------------------------------------------------------
// Constants (mirror B11-a bounds)
// ---------------------------------------------------------------------------
const MAX_ID = 128;
const MAX_CMD = 10_000;
const MAX_ERR_CODE = 128;
const MAX_TEXT = 100_000;
const MAX_THINK = 200_000;
const MAX_TOOL = 50_000;
const MAX_BASH_OUT = 500_000;
const MAX_RECORDS = 200;
const MAX_RECAP = 100;
const MAX_NODES = 2_000;
const MAX_DEPTH = 8;
const MAX_BYTES = 1_048_576; // 1 MiB

const EXACT_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const KNOWN_RECAP_TYPES = new Set([
	"session_created",
	"session_destroyed",
	"agent_start",
	"agent_end",
	"agent_text_delta",
	"agent_thinking_delta",
	"agent_toolcall_delta",
	"bash_start",
	"bash_delta",
	"bash_end",
	"compact_start",
	"compact_end",
	"compact_failed",
	"error",
	"checkpoint_start",
	"checkpoint_complete",
	"checkpoint_failed",
	"session_state",
]);

const SESSION_STATES = new Set(["running", "idle", "inactive"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSafePosInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isValidId(v: unknown): v is string {
	return typeof v === "string" && /^[A-Za-z0-9_\-.:@+=]+$/.test(v) && v.length > 0 && v.length <= MAX_ID;
}

function isValidCanonicalTimestamp(s: string): boolean {
	if (!EXACT_ISO_RE.test(s)) return false;
	const d = new Date(s);
	return !Number.isNaN(d.getTime()) && d.toISOString() === s;
}

// ---------------------------------------------------------------------------
// Plain-data validators (mirrors B11-a pattern)
// ---------------------------------------------------------------------------

/** Check that value is a plain object (prototype === Object.prototype)
 *  with no symbols, and no accessor/nonenumerable/own-undefined data props. */
function isPlainDataObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
	if (Object.getOwnPropertySymbols(value).length > 0) return false;
	for (const key of Object.getOwnPropertyNames(value)) {
		const desc = Object.getOwnPropertyDescriptor(value, key);
		if (!desc || !desc.enumerable || !("value" in desc) || desc.value === undefined) return false;
	}
	return true;
}

function exactObjectKeys(
	value: unknown,
	required: readonly string[],
	optional: readonly string[],
): value is Record<string, unknown> {
	if (!isPlainDataObject(value)) return false;
	const allowed = new Set<string>([...required, ...optional]);
	const keys = Object.keys(value);
	return keys.every((k) => allowed.has(k)) && required.every((k) => keys.includes(k));
}

/** Check that value is a true Array with no sparse holes and plain-object items (when object items). */
function isPlainArray(value: unknown): value is unknown[] {
	if (!Array.isArray(value)) return false;
	// Reject non-standard prototype
	if (Object.getPrototypeOf(value) !== Array.prototype) return false;
	// Reject sparse arrays
	for (let i = 0; i < value.length; i++) {
		if (!(i in value)) return false;
	}
	// Reject non-enumerable props and symbols
	if (Object.getOwnPropertySymbols(value).length > 0) return false;
	for (const key of Object.getOwnPropertyNames(value)) {
		if (key === "length") continue;
		const desc = Object.getOwnPropertyDescriptor(value, key);
		if (!desc || !desc.enumerable || !("value" in desc)) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Budget walker — validates cumulative node/depth/byte budget
// ---------------------------------------------------------------------------
interface BudgetAccum {
	bytes: number;
	nodes: number;
}

function budgetBytesForString(s: string): number {
	// Rough UTF-8 estimate: ASCII = 1, non-ASCII up to 4 bytes
	let bytes = 0;
	for (let i = 0; i < s.length; i++) {
		const cp = s.charCodeAt(i);
		if (cp < 0x80) bytes += 1;
		else if (cp < 0x800) bytes += 2;
		else if (cp < 0xd800 || cp > 0xdfff) bytes += 3;
		else bytes += 4; // surrogate pair case
	}
	return bytes;
}

/**
 * Fail-closed budget check on the RAW input, before any structural reads.
 *
 * Recursively walks the raw value without invoking accessors: only own data
 * descriptors are inspected, so getters never execute. Counts cumulative
 * UTF-8 JSON-equivalent bytes, container nodes (objects + arrays), and
 * nesting depth. Container-node counting is required so a full 200-record
 * snapshot (306 containers) stays decodable while pathological structures
 * are still bounded. Cyclic/impossible-JSON references fail closed.
 *
 * Returns a rejection code, or null when within budget.
 * Safe recursion: maximum depth <= MAX_DEPTH (8).
 */
function budgetReject(v: unknown, path: Set<object>, depth: number, acc: BudgetAccum): SnapshotRejectionCode | null {
	if (depth > MAX_DEPTH) return "OVERFLOW_DEPTH";

	if (v === null) {
		acc.bytes += 4;
		if (acc.bytes > MAX_BYTES) return "OVERFLOW_BYTES";
		return null;
	}
	if (typeof v === "boolean") {
		acc.bytes += v ? 4 : 5;
		if (acc.bytes > MAX_BYTES) return "OVERFLOW_BYTES";
		return null;
	}
	if (typeof v === "number") {
		acc.bytes += String(v).length;
		if (acc.bytes > MAX_BYTES) return "OVERFLOW_BYTES";
		return null;
	}
	if (typeof v === "string") {
		if (v.length > MAX_BYTES) return "OVERFLOW_BYTES";
		acc.bytes += budgetBytesForString(v) + 2;
		if (acc.bytes > MAX_BYTES) return "OVERFLOW_BYTES";
		return null;
	}
	if (typeof v !== "object") {
		acc.bytes += 8; // function, symbol, bigint — opaque leaf
		return null;
	}

	// ---- object or array container ----
	acc.nodes++;
	if (acc.nodes > MAX_NODES) return "OVERFLOW_NODES";
	if (path.has(v)) return "CORRUPT_SNAPSHOT";
	path.add(v);

	if (Array.isArray(v)) {
		acc.bytes += 2;
		if (v.length > MAX_NODES) {
			path.delete(v);
			return "OVERFLOW_NODES";
		}
		for (let i = 0; i < v.length; i++) {
			if (!(i in v)) continue; // sparse hole — later rejected
			const desc = Object.getOwnPropertyDescriptor(v, i);
			if (!desc || !("value" in desc)) continue; // accessor — later rejected
			acc.bytes += 1;
			const err = budgetReject(desc.value, path, depth + 1, acc);
			if (err) {
				path.delete(v);
				return err;
			}
		}
		path.delete(v);
		return null;
	}

	acc.bytes += 2;
	for (const key of Object.getOwnPropertyNames(v)) {
		if (key === "length" && Array.isArray(v)) continue;
		const desc = Object.getOwnPropertyDescriptor(v, key);
		if (!desc || !desc.enumerable || !("value" in desc)) continue; // nonenumerable/accessor — later rejected
		acc.bytes += budgetBytesForString(key) + 3;
		acc.bytes += 1;
		const err = budgetReject(desc.value, path, depth + 1, acc);
		if (err) {
			path.delete(v);
			return err;
		}
	}
	path.delete(v);
	return null;
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/**
 * Strictly decode and validate a raw value as RemoteObservationSnapshotV1.
 *
 * Validates every descriptor before reads. Constructs new recursively frozen
 * DTOs with no input alias. Checks cumulative budget (bytes/nodes/depth),
 * per-string limits, cross-field invariants, and identity match.
 *
 * Returns a result type — never throws.
 */
export function decodeRemoteObservationSnapshotV1(
	raw: unknown,
	expectedIdentity: { hostId: string; generation: string; sessionId: string },
): SnapshotDecodeResult {
	// ---- Cumulative budget first (fail closed on raw, no getter execution) ----
	const budgetErr = budgetReject(raw, new Set<object>(), 0, { bytes: 0, nodes: 0 });
	if (budgetErr) return fail(budgetErr);

	// ---- Top-level object shape ----
	if (!isPlainDataObject(raw)) return fail("NOT_AN_OBJECT");

	// Validate all required+optional keys first — no extra, no missing
	// Required: version, hostId, generation, sessionId, capturedAt, cursor,
	//   cursorTimestamp, hasGap, needsReplay, nextMessageIndex, records,
	//   messageCount, agentRunning, sessionState, compacting, checkpointing,
	//   recap, lastFailure
	// Optional: bash (can be null)
	const required = [
		"version",
		"hostId",
		"generation",
		"sessionId",
		"capturedAt",
		"cursor",
		"cursorTimestamp",
		"hasGap",
		"needsReplay",
		"nextMessageIndex",
		"records",
		"messageCount",
		"agentRunning",
		"sessionState",
		"compacting",
		"checkpointing",
		"recap",
		"lastFailure",
	];
	const optional = ["bash"];

	if (!exactObjectKeys(raw, required, optional)) {
		// Distinguish between missing version vs other errors
		const obj = raw as Record<string, unknown>;
		if (obj.version === undefined) return fail("MISSING_VERSION");
		return fail("UNKNOWN_FIELD");
	}

	const d = raw as Record<string, unknown>;

	// ---- version ----
	if (d.version !== "1") return fail("INVALID_VERSION");

	// ---- IDs ----
	if (!isValidId(d.hostId) || !isValidId(d.generation) || !isValidId(d.sessionId)) return fail("INVALID_ID");

	// ---- Identity match ----
	if (
		d.hostId !== expectedIdentity.hostId ||
		d.generation !== expectedIdentity.generation ||
		d.sessionId !== expectedIdentity.sessionId
	)
		return fail("IDENTITY_MISMATCH");

	// ---- capturedAt ----
	if (typeof d.capturedAt !== "string" || !isValidCanonicalTimestamp(d.capturedAt)) return fail("INVALID_CAPTURED_AT");

	// ---- cursor ----
	if (!isSafePosInt(d.cursor)) return fail("INVALID_CURSOR");

	// ---- cursorTimestamp ----
	// Empty if cursor === 0, canonical and <= capturedAt otherwise
	if (typeof d.cursorTimestamp !== "string") return fail("INVALID_CURSOR_TIMESTAMP");
	if (d.cursor === 0) {
		if (d.cursorTimestamp !== "") return fail("INVALID_CURSOR_TIMESTAMP");
	} else {
		if (!isValidCanonicalTimestamp(d.cursorTimestamp as string)) return fail("INVALID_CURSOR_TIMESTAMP");
		if ((d.cursorTimestamp as string) > (d.capturedAt as string)) return fail("INVALID_TIMESTAMP_ORDER");
	}

	// ---- booleans ----
	if (typeof d.hasGap !== "boolean" || typeof d.needsReplay !== "boolean") return fail("INVALID_BOOLEAN");
	if (typeof d.agentRunning !== "boolean" || typeof d.compacting !== "boolean" || typeof d.checkpointing !== "boolean")
		return fail("INVALID_BOOLEAN");

	// ---- Gap invariant ----
	if (d.hasGap !== d.needsReplay) return fail("INVALID_GAP_INVARIANT");

	// ---- nextMessageIndex ----
	if (!isSafePosInt(d.nextMessageIndex)) return fail("INVALID_NEXT_MESSAGE_INDEX");

	// ---- messageCount ----
	if (!isSafePosInt(d.messageCount) || (d.messageCount as number) < (d.nextMessageIndex as number))
		return fail("INVALID_MESSAGE_COUNT");

	// ---- sessionState ----
	if (d.sessionState !== null && (typeof d.sessionState !== "string" || !SESSION_STATES.has(d.sessionState)))
		return fail("INVALID_SESSION_STATE");

	// ---- records ----
	if (!isPlainArray(d.records)) return fail("INVALID_RECORD_STRUCTURE");
	const recordsRaw = d.records as unknown[];
	if (recordsRaw.length > MAX_RECORDS) return fail("INVALID_RECORD_COUNT");

	let expectedNextIndex = d.nextMessageIndex as number;
	let lastRecordIndex = -1;
	const recordsOut: Array<{
		index: number;
		text: string;
		thinking: string;
		toolCallText: string;
		emittedAt: string;
		updatedAt: string;
		textTruncated: boolean;
		thinkingTruncated: boolean;
		toolCallTruncated: boolean;
	}> = [];

	for (let i = 0; i < recordsRaw.length; i++) {
		const recRaw = recordsRaw[i];
		if (
			!exactObjectKeys(
				recRaw,
				[
					"index",
					"text",
					"thinking",
					"toolCallText",
					"emittedAt",
					"updatedAt",
					"textTruncated",
					"thinkingTruncated",
					"toolCallTruncated",
				],
				[],
			)
		)
			return fail("INVALID_RECORD_STRUCTURE");

		const rec = recRaw as Record<string, unknown>;

		if (!isSafePosInt(rec.index) || (rec.index as number) < (lastRecordIndex === -1 ? 0 : lastRecordIndex + 1))
			return fail("INVALID_RECORD_INDEX");
		if ((rec.index as number) >= (d.nextMessageIndex as number)) return fail("INVALID_RECORD_INDEX");

		// Duplicate index check
		if (i > 0 && (rec.index as number) <= lastRecordIndex) return fail("INVALID_RECORD_INDEX");

		if (typeof rec.text !== "string" || typeof rec.thinking !== "string" || typeof rec.toolCallText !== "string")
			return fail("INVALID_STRING");
		if (
			(rec.text as string).length > MAX_TEXT ||
			(rec.thinking as string).length > MAX_THINK ||
			(rec.toolCallText as string).length > MAX_TOOL
		)
			return fail("STRING_OVERFLOW");

		if (typeof rec.emittedAt !== "string" || !isValidCanonicalTimestamp(rec.emittedAt as string))
			return fail("INVALID_CAPTURED_AT");
		if (typeof rec.updatedAt !== "string" || !isValidCanonicalTimestamp(rec.updatedAt as string))
			return fail("INVALID_CAPTURED_AT");

		// emittedAt <= updatedAt
		if ((rec.emittedAt as string) > (rec.updatedAt as string)) return fail("INVALID_TIMESTAMP_ORDER");
		// updatedAt <= cursorTimestamp (unless cursorTimestamp is empty — cursor=0 with no records)
		if ((d.cursor as number) > 0 && (rec.updatedAt as string) > (d.cursorTimestamp as string))
			return fail("INVALID_TIMESTAMP_ORDER");

		if (
			typeof rec.textTruncated !== "boolean" ||
			typeof rec.thinkingTruncated !== "boolean" ||
			typeof rec.toolCallTruncated !== "boolean"
		)
			return fail("INVALID_BOOLEAN");

		lastRecordIndex = rec.index as number;
		expectedNextIndex = Math.max(expectedNextIndex, (rec.index as number) + 1);

		recordsOut.push({
			index: rec.index as number,
			text: rec.text as string,
			thinking: rec.thinking as string,
			toolCallText: rec.toolCallText as string,
			emittedAt: rec.emittedAt as string,
			updatedAt: rec.updatedAt as string,
			textTruncated: rec.textTruncated as boolean,
			thinkingTruncated: rec.thinkingTruncated as boolean,
			toolCallTruncated: rec.toolCallTruncated as boolean,
		});
	}

	// Retained suffix must end at nextMessageIndex - 1
	if (recordsOut.length > 0) {
		if (lastRecordIndex !== (d.nextMessageIndex as number) - 1) return fail("INVALID_RECORD_INDEX");
	}

	// ---- bash ----
	let bashOut: RemoteObservationSnapshotV1["bash"] = null;
	if ("bash" in d) {
		if (d.bash === null) {
			bashOut = null;
		} else {
			if (!exactObjectKeys(d.bash, ["command", "output", "exitCode", "cancelled", "truncated"], []))
				return fail("INVALID_BASH_STRUCTURE");
			const b = d.bash as Record<string, unknown>;

			if (typeof b.command !== "string" || (b.command as string).length > MAX_CMD) return fail("INVALID_STRING");
			if (typeof b.output !== "string" || (b.output as string).length > MAX_BASH_OUT) return fail("STRING_OVERFLOW");
			if (b.exitCode !== null && !Number.isSafeInteger(b.exitCode)) return fail("INVALID_NUMBER");
			if (typeof b.cancelled !== "boolean" || typeof b.truncated !== "boolean") return fail("INVALID_BOOLEAN");

			bashOut = {
				command: b.command as string,
				output: b.output as string,
				exitCode: b.exitCode as number | null,
				cancelled: b.cancelled as boolean,
				truncated: b.truncated as boolean,
			};

			// If exitCode !== null and cancelled is true, bash is finished
			// If exitCode === null, bash is running — agentRunning cannot be true simultaneously
			if (b.exitCode === null && d.agentRunning) return fail("INVALID_ACTIVITY_STATE");
		}
	}

	// ---- compact+checkpoint validity ----
	// Cannot both be true
	if (d.compacting && d.checkpointing) return fail("INVALID_COMPACT_STATE");

	// ---- recap ----
	if (!isPlainArray(d.recap)) return fail("INVALID_RECAP_ENTRY");
	const recapRaw = d.recap as unknown[];
	if (recapRaw.length > MAX_RECAP) return fail("INVALID_RECAP_COUNT");

	let lastRecapSeq = -1;
	const recapOut: Array<{
		eventSequence: number;
		type: string;
		messageIndex?: number;
	}> = [];

	for (let i = 0; i < recapRaw.length; i++) {
		const entryRaw = recapRaw[i];
		if (!isPlainDataObject(entryRaw)) return fail("INVALID_RECAP_ENTRY");
		const entryKeys = Object.keys(entryRaw as Record<string, unknown>);
		if (entryKeys.length < 2) return fail("INVALID_RECAP_ENTRY");

		// eventSequence + type required, messageIndex optional
		if (!exactObjectKeys(entryRaw, ["eventSequence", "type"], ["messageIndex"])) return fail("INVALID_RECAP_ENTRY");

		const entry = entryRaw as Record<string, unknown>;

		if (!isSafePosInt(entry.eventSequence) || (entry.eventSequence as number) < 1) return fail("INVALID_RECAP_ENTRY");

		// Strictly increasing
		if ((entry.eventSequence as number) <= lastRecapSeq) return fail("INVALID_RECAP_SEQUENCE");
		lastRecapSeq = entry.eventSequence as number;

		// eventSequence must be <= cursor
		if ((entry.eventSequence as number) > (d.cursor as number)) return fail("INVALID_RECAP_SEQUENCE");

		if (typeof entry.type !== "string" || !KNOWN_RECAP_TYPES.has(entry.type)) return fail("INVALID_RECAP_TYPE");

		let mi: number | undefined;
		if ("messageIndex" in entry) {
			if (!isSafePosInt(entry.messageIndex)) return fail("INVALID_NUMBER");
			// messageIndex must refer to a possible assistant record index
			// It must be < nextMessageIndex (since records are only for assistant messages)
			if ((entry.messageIndex as number) >= (d.nextMessageIndex as number)) return fail("INVALID_NUMBER");
			mi = entry.messageIndex as number;
		}

		recapOut.push({
			eventSequence: entry.eventSequence as number,
			type: entry.type as string,
			...(mi !== undefined ? { messageIndex: mi } : {}),
		});
	}

	// ---- lastFailure ----
	if (!isPlainDataObject(d.lastFailure)) return fail("INVALID_LAST_FAILURE");
	const lf = d.lastFailure as Record<string, unknown>;
	const lfType = lf.type;
	if (
		typeof lfType !== "string" ||
		(lfType !== "error" && lfType !== "compact_failed" && lfType !== "checkpoint_failed" && lfType !== "none")
	)
		return fail("INVALID_LAST_FAILURE");

	switch (lfType) {
		case "error": {
			if (!exactObjectKeys(lf, ["type", "code"], [])) return fail("INVALID_LAST_FAILURE");
			if (typeof lf.code !== "string" || lf.code.length === 0 || (lf.code as string).length > MAX_ERR_CODE)
				return fail("INVALID_LAST_FAILURE");
			break;
		}
		case "compact_failed":
		case "checkpoint_failed":
		case "none":
			if (!exactObjectKeys(lf, ["type"], [])) return fail("INVALID_LAST_FAILURE");
			break;
	}

	// ---- Build deeply frozen snapshot ----
	const snapshot: RemoteObservationSnapshotV1 = deepFreeze({
		version: "1",
		hostId: d.hostId as string,
		generation: d.generation as string,
		sessionId: d.sessionId as string,
		capturedAt: d.capturedAt as string,
		cursor: d.cursor as RemoteHostEventSequence,
		cursorTimestamp: d.cursorTimestamp as string,
		hasGap: d.hasGap as boolean,
		needsReplay: d.needsReplay as boolean,
		nextMessageIndex: d.nextMessageIndex as number,
		records: recordsOut,
		messageCount: d.messageCount as number,
		agentRunning: d.agentRunning as boolean,
		sessionState: d.sessionState as RemoteHostSessionState | null,
		compacting: d.compacting as boolean,
		checkpointing: d.checkpointing as boolean,
		bash: bashOut,
		recap: recapOut,
		lastFailure:
			lfType === "error"
				? { type: "error" as const, code: lf.code as string }
				: { type: lfType as "compact_failed" | "checkpoint_failed" | "none" },
	});

	return { success: true, value: snapshot };
}

function fail(code: SnapshotRejectionCode): SnapshotDecodeResult {
	return { success: false, code };
}

function deepFreeze<T>(o: T): T {
	if (o === null || typeof o !== "object") return o;
	if (Array.isArray(o)) {
		for (const v of o) deepFreeze(v);
		Object.freeze(o);
		return o;
	}
	if (Object.getPrototypeOf(o) !== Object.prototype) return o;
	for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
	Object.freeze(o);
	return o;
}
