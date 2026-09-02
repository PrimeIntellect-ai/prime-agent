/**
 * B11-b: RemoteObservationSnapshotV1 codec — exact observation state capture/restore.
 *
 * Uses shared jsonPreflight/checkJsonSafe from remote-host-frame-codec for
 * budget and JSON safety validation, and KNOWN_ERR_CODES from the mirror for
 * fixed lastFailure code validation.
 *
 * Validates every descriptor before reads: rejects accessors, symbols,
 * nonenumerables, sparse arrays, undefined, prototypes, missing/extra keys.
 * Every optional is exact: present malformed rejects. Constructs new
 * recursively frozen DTOs with no input alias.
 */
import type { RemoteHostEventSequence, RemoteHostSessionState } from "./remote-agent-host-protocol.js";
import { jsonPreflight } from "./remote-host-frame-codec.js";
import { KNOWN_ERR_CODES } from "./remote-observation-mirror.js";

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
	| "INVALID_RECAP_MESSAGE_INDEX"
	| "INVALID_LAST_FAILURE"
	| "INVALID_LAST_FAILURE_CODE"
	| "INVALID_IDENTITY"
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
	| "CORRUPT_SNAPSHOT"
	| "REFLECTION_FAILURE"
	| "INVALID_JSON";

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
// Constants (B11-a bounds)
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

const AGENT_DELTA_TYPES = new Set(["agent_text_delta", "agent_thinking_delta", "agent_toolcall_delta"]);

const SESSION_STATES = new Set(["running", "idle", "inactive"]);

// ---------------------------------------------------------------------------
// Container-node/depth walker (descriptor-safe, Proxy-safe, <=2000/<=8)
// ---------------------------------------------------------------------------

/**
 * Count container nodes (objects + arrays) and max nesting depth.
 *
 * Descriptor-safe: only walks own enumerable data descriptors.
 * Proxy-safe: wrapped so revoked/hostile Proxy returns OVERFLOW_NODES
 * and never throws. Enforces a snapshot-specific <=2000 nodes, <=8 depth
 * constraint (tighter than the shared codec's 10k/64).
 */
function countContainerNodes(v: unknown): { nodes: number; depth: number } | null {
	try {
		return countContainerNodesInner(v, new Set<object>(), 0);
	} catch {
		return null;
	}
}

function countContainerNodesInner(
	v: unknown,
	seen: Set<object>,
	depth: number,
): { nodes: number; depth: number } | null {
	if (v === null || typeof v !== "object") return { nodes: 0, depth };
	if (depth > MAX_DEPTH) return { nodes: depth, depth: depth };
	if (seen.has(v)) return { nodes: 0, depth };
	seen.add(v);

	let nodes = 1;
	let maxDepth = depth + 1;

	if (Array.isArray(v)) {
		for (let i = 0; i < v.length; i++) {
			if (!(i in v)) continue;
			const desc = Object.getOwnPropertyDescriptor(v, i);
			if (!desc || !("value" in desc)) continue;
			const inner = countContainerNodesInner(desc.value, seen, depth + 1);
			if (!inner || inner.nodes > MAX_NODES) return null;
			nodes += inner.nodes;
			if (inner.depth > maxDepth) maxDepth = inner.depth;
		}
		seen.delete(v);
		return nodes > MAX_NODES ? null : { nodes, depth: maxDepth };
	}

	// Plain object
	for (const key of Object.keys(v)) {
		const desc = Object.getOwnPropertyDescriptor(v, key);
		if (!desc || !desc.enumerable || !("value" in desc)) continue;
		const inner = countContainerNodesInner(desc.value, seen, depth + 1);
		if (!inner || inner.nodes > MAX_NODES) return null;
		nodes += inner.nodes;
		if (inner.depth > maxDepth) maxDepth = inner.depth;
	}
	seen.delete(v);
	return nodes > MAX_NODES ? null : { nodes, depth: maxDepth };
}

// ---------------------------------------------------------------------------
// Budget check: shared jsonPreflight for bytes (1 MiB) + our container walker
// ---------------------------------------------------------------------------

function checkBudget(
	raw: unknown,
	expectedIdentity: { hostId: string; generation: string; sessionId: string },
): SnapshotRejectionCode | null {
	// Validate expectedIdentity first (exact/safe IDs)
	if (
		!expectedIdentity ||
		typeof expectedIdentity !== "object" ||
		typeof expectedIdentity.hostId !== "string" ||
		typeof expectedIdentity.generation !== "string" ||
		typeof expectedIdentity.sessionId !== "string" ||
		!expectedIdentity.hostId ||
		!expectedIdentity.generation ||
		!expectedIdentity.sessionId ||
		!/^[A-Za-z0-9_\-.:@+=]+$/.test(expectedIdentity.hostId) ||
		expectedIdentity.hostId.length > MAX_ID ||
		!/^[A-Za-z0-9_\-.:@+=]+$/.test(expectedIdentity.generation) ||
		expectedIdentity.generation.length > MAX_ID ||
		!/^[A-Za-z0-9_\-.:@+=]+$/.test(expectedIdentity.sessionId) ||
		expectedIdentity.sessionId.length > MAX_ID
	) {
		return "INVALID_IDENTITY";
	}

	// Shared jsonPreflight for byte budget + JSON safety
	const preflight = jsonPreflight(raw);
	if (!preflight.ok) return "OVERFLOW_BYTES";

	// Descriptor-safe container-node walker
	const counts = countContainerNodes(raw);
	if (!counts) return "OVERFLOW_NODES";
	if (counts.depth > MAX_DEPTH) return "OVERFLOW_DEPTH";

	return null;
}

// ---------------------------------------------------------------------------
// Plain-data validators
// ---------------------------------------------------------------------------

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

/**
 * Strict plain-array check:
 * - true Array with Array.prototype
 * - no sparse holes
 * - no extra own keys beyond "length" and canonical numeric indices
 * - no own-undefined elements
 * - no accessor/nonenumerable numeric-index descriptors
 * - no symbol keys
 * - Proxy traps fail: Proxy has a non-standard prototype or throws on descriptors
 */
function isPlainArray(value: unknown): value is unknown[] {
	if (!Array.isArray(value)) return false;
	if (Object.getPrototypeOf(value) !== Array.prototype) return false;
	if (Object.getOwnPropertySymbols(value).length > 0) return false;

	// All own property names must be "length" or canonical numeric indices
	const names = Object.getOwnPropertyNames(value);
	for (const name of names) {
		if (name === "length") continue;
		const idx = Number(name);
		if (!Number.isSafeInteger(idx) || idx < 0) return false;
		if (idx !== Math.floor(idx)) return false;
		if (idx >= value.length) return false;
	}

	// Every index must be an own data descriptor with defined value
	for (let i = 0; i < value.length; i++) {
		if (!(i in value)) return false;
		const desc = Object.getOwnPropertyDescriptor(value, String(i));
		if (!desc || !desc.enumerable || !("value" in desc) || desc.value === undefined) return false;
	}

	return true;
}

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
// Decoder
// ---------------------------------------------------------------------------

export function decodeRemoteObservationSnapshotV1(
	raw: unknown,
	expectedIdentity: { hostId: string; generation: string; sessionId: string },
): SnapshotDecodeResult {
	// ---- Cumulative budget first (fail closed, Proxy-safe) ----
	const budgetErr = checkBudget(raw, expectedIdentity);
	if (budgetErr) return fail(budgetErr);

	// ---- Top-level object shape ----
	if (!isPlainDataObject(raw)) return fail("NOT_AN_OBJECT");

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
		"bash",
		"recap",
		"lastFailure",
	];

	if (!exactObjectKeys(raw, required, [])) {
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
	if (typeof d.cursorTimestamp !== "string") return fail("INVALID_CURSOR_TIMESTAMP");
	if (d.cursor === 0) {
		if (d.cursorTimestamp !== "") return fail("INVALID_CURSOR_TIMESTAMP");
	} else {
		if (!isValidCanonicalTimestamp(d.cursorTimestamp as string)) return fail("INVALID_CURSOR_TIMESTAMP");
		if ((d.cursorTimestamp as string) > (d.capturedAt as string)) return fail("INVALID_TIMESTAMP_ORDER");
	}

	// ---- booleans ----
	if (
		typeof d.hasGap !== "boolean" ||
		typeof d.needsReplay !== "boolean" ||
		typeof d.agentRunning !== "boolean" ||
		typeof d.compacting !== "boolean" ||
		typeof d.checkpointing !== "boolean"
	)
		return fail("INVALID_BOOLEAN");

	// ---- Gap invariant ----
	if (d.hasGap !== d.needsReplay) return fail("INVALID_GAP_INVARIANT");

	// ---- nextMessageIndex ----
	if (!isSafePosInt(d.nextMessageIndex)) return fail("INVALID_NEXT_MESSAGE_INDEX");

	// ---- messageCount (independent counter, accept any safe integer) ----
	if (!isSafePosInt(d.messageCount)) return fail("INVALID_NUMBER");

	// ---- sessionState ----
	if (d.sessionState !== null && (typeof d.sessionState !== "string" || !SESSION_STATES.has(d.sessionState)))
		return fail("INVALID_SESSION_STATE");

	// ---- bash (REQUIRED, may be null) ----
	let bashOut: RemoteObservationSnapshotV1["bash"] = null;
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
	}

	// ---- compact+checkpoint mutual exclusion ----
	if (d.compacting && d.checkpointing) return fail("INVALID_ACTIVITY_STATE");

	// ---- records ----
	if (!isPlainArray(d.records)) return fail("INVALID_RECORD_STRUCTURE");
	const recordsRaw = d.records as unknown[];
	if (recordsRaw.length > MAX_RECORDS) return fail("INVALID_RECORD_COUNT");

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

		if (!isSafePosInt(rec.index)) return fail("INVALID_RECORD_INDEX");
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

		if ((rec.emittedAt as string) > (rec.updatedAt as string)) return fail("INVALID_TIMESTAMP_ORDER");
		if ((d.cursor as number) > 0 && (rec.updatedAt as string) > (d.cursorTimestamp as string))
			return fail("INVALID_TIMESTAMP_ORDER");

		if (
			typeof rec.textTruncated !== "boolean" ||
			typeof rec.thinkingTruncated !== "boolean" ||
			typeof rec.toolCallTruncated !== "boolean"
		)
			return fail("INVALID_BOOLEAN");

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

	// ---- Contiguous record suffix ----
	// first index === nextMessageIndex - records.length
	// each subsequent index === prior + 1
	if (recordsOut.length > 0) {
		const expectedFirst = (d.nextMessageIndex as number) - recordsOut.length;
		if (recordsOut[0].index !== expectedFirst) return fail("INVALID_RECORD_INDEX");
		for (let i = 1; i < recordsOut.length; i++) {
			if (recordsOut[i].index !== recordsOut[i - 1].index + 1) return fail("INVALID_RECORD_INDEX");
		}
	}

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

		if (!exactObjectKeys(entryRaw, ["eventSequence", "type"], ["messageIndex"])) return fail("INVALID_RECAP_ENTRY");

		const entry = entryRaw as Record<string, unknown>;

		if (!isSafePosInt(entry.eventSequence) || (entry.eventSequence as number) < 1) return fail("INVALID_RECAP_ENTRY");

		if ((entry.eventSequence as number) <= lastRecapSeq) return fail("INVALID_RECAP_SEQUENCE");
		lastRecapSeq = entry.eventSequence as number;

		if ((entry.eventSequence as number) > (d.cursor as number)) return fail("INVALID_RECAP_SEQUENCE");

		if (typeof entry.type !== "string" || !KNOWN_RECAP_TYPES.has(entry.type)) return fail("INVALID_RECAP_TYPE");

		// messageIndex: present exactly for agent delta types, absent for others
		const isDelta = AGENT_DELTA_TYPES.has(entry.type as string);
		const hasMi = "messageIndex" in entry;

		if (isDelta && !hasMi) return fail("INVALID_RECAP_MESSAGE_INDEX");
		if (!isDelta && hasMi) return fail("INVALID_RECAP_MESSAGE_INDEX");

		let mi: number | undefined;
		if (hasMi) {
			if (!isSafePosInt(entry.messageIndex)) return fail("INVALID_NUMBER");
			if ((entry.messageIndex as number) >= (d.nextMessageIndex as number))
				return fail("INVALID_RECAP_MESSAGE_INDEX");
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

	let lfOut: RemoteObservationSnapshotV1["lastFailure"];

	switch (lfType) {
		case "error": {
			if (!exactObjectKeys(lf, ["type", "code"], [])) return fail("INVALID_LAST_FAILURE");
			if (typeof lf.code !== "string" || lf.code.length === 0 || (lf.code as string).length > MAX_ERR_CODE)
				return fail("INVALID_LAST_FAILURE");
			if (!KNOWN_ERR_CODES.has(lf.code as any)) return fail("INVALID_LAST_FAILURE_CODE");
			lfOut = { type: "error", code: lf.code as string };
			break;
		}
		case "compact_failed":
			if (!exactObjectKeys(lf, ["type"], [])) return fail("INVALID_LAST_FAILURE");
			lfOut = { type: "compact_failed" };
			break;
		case "checkpoint_failed":
			if (!exactObjectKeys(lf, ["type"], [])) return fail("INVALID_LAST_FAILURE");
			lfOut = { type: "checkpoint_failed" };
			break;
		case "none":
			if (!exactObjectKeys(lf, ["type"], [])) return fail("INVALID_LAST_FAILURE");
			lfOut = { type: "none" };
			break;
	}

	// ---- Build deeply frozen snapshot (no alias to input) ----
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
		lastFailure: lfOut,
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
