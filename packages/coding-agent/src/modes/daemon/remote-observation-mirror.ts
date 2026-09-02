/**
 * B11-a/b: remote observation event decoder + bounded in-memory transition/transcript core.
 * B11-b adds captureSnapshot/fromSnapshot via remote-observation-snapshot.ts codec.
 */
import type { RemoteHostEventSequence, RemoteHostSessionState } from "./remote-agent-host-protocol.js";
import {
	decodeRemoteObservationSnapshotV1,
	type RemoteObservationSnapshotV1,
	type SnapshotRejectionCode,
} from "./remote-observation-snapshot.js";

const MAX_ID = 128,
	MAX_SNAP_ID = 128;
const MAX_REASON = 256,
	MAX_CMD = 10_000,
	MAX_ERR_CODE = 128,
	MAX_ERR_MSG = 512;
const MAX_TEXT = 100_000,
	MAX_THINK = 200_000,
	MAX_TOOL = 50_000,
	MAX_BASH_OUT = 500_000;
const MAX_DTEXT = 50_000,
	MAX_DTHINK = 100_000,
	MAX_DTOOL = 25_000,
	MAX_BASH_DELTA = 50_000;
const MAX_RECORDS = 200,
	MAX_RECAP = 100;
const SESSION_STATES = new Set(["running", "idle", "inactive"]);
const KNOWN_ERR_CODES = new Set([
	"INTERNAL_ERROR",
	"UNKNOWN_COMMAND",
	"INVALID_SESSION",
	"SESSION_DESTROYED",
	"SESSION_TIMEOUT",
	"COMPACT_FAILED",
	"CHECKPOINT_FAILED",
	"BASH_FAILED",
	"RESOURCE_EXHAUSTED",
	"UNAUTHORIZED",
	"PROTOCOL_ERROR",
	"BUILD_MISMATCH",
	"CAPABILITY_MISMATCH",
	"UNKNOWN",
]);

export function isKnownObservationErrorCode(code: string): boolean {
	return KNOWN_ERR_CODES.has(code);
}
/** Exact ISO 8601 millisecond with Z suffix: YYYY-MM-DDTHH:mm:ss.sssZ — must roundtrip. */
const EXACT_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSafePosInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function isBoundedStr(v: unknown, max: number): v is string {
	return typeof v === "string" && v.length > 0 && v.length <= max;
}
function isValidId(v: unknown): v is string {
	return typeof v === "string" && /^[A-Za-z0-9_\-.:@+=]+$/.test(v) && v.length <= MAX_ID;
}

/**
 * Verify `value` is a plain object whose own enumerable + nonenumerable data
 * property names and symbols match exactly `required` + `optional`.
 *
 * Checks:
 *  - prototype is Object.prototype (plain object)
 *  - every own descriptor is a data descriptor (no accessors)
 *  - every required key is present as an own data property
 *  - every optional key, if present, has a defined value (not own-undefined)
 *  - no extra own property names or symbols beyond the allowed set
 */
function isPlainDataObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
	if (Object.getOwnPropertySymbols(value).length > 0) return false;
	for (const key of Object.getOwnPropertyNames(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
			return false;
		}
	}
	return true;
}

function exactObjectKeys(value: unknown, required: readonly string[], optional: readonly string[]): boolean {
	if (!isPlainDataObject(value)) return false;
	const allowed = new Set<string>([...required, ...optional]);
	const keys = Object.keys(value);
	return keys.every((key) => allowed.has(key)) && required.every((key) => keys.includes(key));
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

/** Exact canonical ISO 8601 millisecond timestamp: must produce same string when roundtripped. */
function isValidEmittedAt(s: string): boolean {
	if (!EXACT_ISO_RE.test(s)) return false;
	const d = new Date(s);
	return !Number.isNaN(d.getTime()) && d.toISOString() === s;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MirrorRejectionCode =
	| "NOT_AN_OBJECT"
	| "INVALID_TYPE"
	| "MISSING_TYPE"
	| "INVALID_CURSOR_TYPE"
	| "INVALID_ID"
	| "INVALID_SEQUENCE"
	| "INVALID_EMITTED_AT"
	| "IDENTITY_MISMATCH"
	| "CURSOR_MISMATCH"
	| "SEQUENCE_MISMATCH"
	| "DUPLICATE_SEQUENCE"
	| "GAP_DETECTED"
	| "INVALID_BODY_TYPE"
	| "INVALID_SESSION_STATE"
	| "INVALID_MESSAGE_INDEX"
	| "INVALID_MESSAGE_COUNT"
	| "INVALID_BASH_STATE"
	| "INVALID_COMPACT_STATE"
	| "INVALID_CHECKPOINT_STATE"
	| "INVALID_ERROR_CODE"
	| "INVALID_SNAPSHOT_ID"
	| "INVALID_EXIT_CODE"
	| "INVALID_BOOLEAN"
	| "INVALID_NUMBER"
	| "INVALID_STRING"
	| "UNKNOWN_FIELD"
	| "MALFORMED_OPTIONAL"
	| "OVERFLOW"
	| "ACCESSOR_DETECTED";

export interface MirrorAssistantRecord {
	readonly index: number;
	text: string;
	thinking: string;
	toolCallText: string;
	emittedAt: string;
	updatedAt: string;
	textTruncated: boolean;
	thinkingTruncated: boolean;
	toolCallTruncated: boolean;
}
export interface BashState {
	command: string;
	output: string;
	exitCode: number | null;
	cancelled: boolean;
	truncated: boolean;
}
export interface RecapEntry {
	readonly eventSequence: number;
	readonly type: string;
	readonly messageIndex?: number;
}
export interface MirrorActivity {
	readonly agentRunning: boolean;
	readonly messageCount: number;
	readonly sessionState: RemoteHostSessionState | null;
	readonly compacting: boolean;
	readonly checkpointing: boolean;
}
export interface MirrorIngestResult {
	readonly accepted: boolean;
	readonly rejectionCode?: MirrorRejectionCode;
	readonly hasGap: boolean;
	readonly needsReplay: boolean;
}
export type LastFailureMarker =
	| { readonly type: "error"; readonly code: string }
	| { readonly type: "compact_failed" }
	| { readonly type: "checkpoint_failed" }
	| { readonly type: "none" };
export type CoreStateDTO = RemoteObservationSnapshotV1;

type DecodedBody =
	| { type: "session_created"; sessionId: string; workspaceId: string }
	| { type: "session_destroyed"; reason?: string }
	| { type: "agent_start" }
	| { type: "agent_end"; messages: number }
	| { type: "agent_text_delta"; index: number; text: string }
	| { type: "agent_thinking_delta"; index: number; text: string }
	| { type: "agent_toolcall_delta"; index: number; text: string }
	| { type: "bash_start"; command: string }
	| { type: "bash_delta"; text: string }
	| { type: "bash_end"; exitCode: number; cancelled: boolean; truncated: boolean }
	| { type: "compact_start" }
	| { type: "compact_end"; keptMessages: number }
	| { type: "compact_failed" }
	| { type: "error"; code: string }
	| { type: "checkpoint_start" }
	| { type: "checkpoint_complete"; snapshotId: string }
	| { type: "checkpoint_failed" }
	| { type: "session_state"; state: RemoteHostSessionState };

// ---------------------------------------------------------------------------
// Mirror class
// ---------------------------------------------------------------------------

export class RemoteObservationMirror {
	private readonly hostId: string;
	private readonly generation: string;
	private readonly sessionId: string;
	private cursor: RemoteHostEventSequence = 0;
	private cursorTimestamp = "";
	private hasGap = false;
	private needsReplay = false;
	private readonly records: Map<number, MirrorAssistantRecord> = new Map();
	private readonly recOrder: number[] = [];
	private nextMsgIdx = 0;
	private agentRunning = false;
	private msgCount = 0;
	private sessionState: RemoteHostSessionState | null = null;
	private compacting = false;
	private checkpointing = false;
	private bash: BashState | null = null;
	private readonly recap: RecapEntry[] = [];
	/** Preserved until an explicit session-success boundary or recovery clears it. */
	private lastFailure: LastFailureMarker = { type: "none" };

	constructor(opts: { hostId: string; generation: string; sessionId: string; initialNextIndex?: number }) {
		if (!isValidId(opts.hostId)) throw new Error("Invalid hostId");
		if (!isValidId(opts.generation)) throw new Error("Invalid generation");
		if (!isValidId(opts.sessionId)) throw new Error("Invalid sessionId");
		this.hostId = opts.hostId;
		this.generation = opts.generation;
		this.sessionId = opts.sessionId;
		if (opts.initialNextIndex !== undefined) {
			if (!isSafePosInt(opts.initialNextIndex)) throw new Error("Invalid initialNextIndex");
			this.nextMsgIdx = opts.initialNextIndex;
		}
	}

	get identity() {
		return Object.freeze({ hostId: this.hostId, generation: this.generation, sessionId: this.sessionId });
	}

	// -----------------------------------------------------------------------
	// ingestEvent
	// -----------------------------------------------------------------------
	ingestEvent(raw: unknown): MirrorIngestResult {
		// Validate frame as exact plain object with 6 own data keys
		if (!exactObjectKeys(raw, ["type", "id", "sequence", "cursor", "emittedAt", "body"], []))
			return rej("NOT_AN_OBJECT");
		const frame = raw as Record<string, unknown>;

		if (frame.type !== "event") return rej("INVALID_TYPE");
		if (!isValidId(frame.id as string)) return rej("INVALID_ID");
		if (!isSafePosInt(frame.sequence) || (frame.sequence as number) < 1) return rej("INVALID_SEQUENCE");

		// Validate cursor as exact plain object with 4 keys
		if (!exactObjectKeys(frame.cursor, ["hostId", "generation", "sessionId", "sequence"], []))
			return rej("INVALID_CURSOR_TYPE");
		const cursor = frame.cursor as Record<string, unknown>;
		if (!isValidId(cursor.hostId) || cursor.hostId !== this.hostId) return rej("IDENTITY_MISMATCH");
		if (!isValidId(cursor.generation) || cursor.generation !== this.generation) return rej("IDENTITY_MISMATCH");
		if (!isValidId(cursor.sessionId) || cursor.sessionId !== this.sessionId) return rej("IDENTITY_MISMATCH");
		if (!isSafePosInt(cursor.sequence) || (cursor.sequence as number) < 1) return rej("CURSOR_MISMATCH");
		if ((cursor.sequence as number) !== (frame.sequence as number)) return rej("CURSOR_MISMATCH");

		if (typeof frame.emittedAt !== "string" || !isValidEmittedAt(frame.emittedAt as string))
			return rej("INVALID_EMITTED_AT");

		const seq = frame.sequence as RemoteHostEventSequence;
		const emittedAt = frame.emittedAt as string;

		if (seq <= this.cursor) {
			return { accepted: false, hasGap: this.hasGap, needsReplay: this.needsReplay };
		}

		// Validate all descriptors before reading body.type.
		if (!isPlainDataObject(frame.body)) return rej("INVALID_BODY_TYPE");
		const body = frame.body;
		if (typeof body.type !== "string" || !body.type.length) return rej("INVALID_BODY_TYPE");

		// Future sequence: decode fully, set gap flags, no cursor/content mutation
		if (seq > this.cursor + 1) {
			if (!this.decodeBody(body)) return rej("INVALID_BODY_TYPE");
			this.hasGap = true;
			this.needsReplay = true;
			return rej("GAP_DETECTED", true, true);
		}

		// Gap-gated: validate body structurally for caller's rejection evidence
		if (this.hasGap) {
			if (!this.decodeBody(body))
				return { accepted: false, rejectionCode: "INVALID_BODY_TYPE", hasGap: true, needsReplay: true };
			return { accepted: false, rejectionCode: "GAP_DETECTED", hasGap: true, needsReplay: true };
		}

		const decoded = this.decodeBody(body);
		if (!decoded) return rej("INVALID_BODY_TYPE");
		const pre = this.capturePreflight();
		const preErr = this.validatePreflight(decoded, pre);
		if (preErr) {
			if (preErr.hasGap || preErr.needsReplay) {
				this.hasGap = true;
				this.needsReplay = true;
			}
			return { ...preErr, hasGap: this.hasGap, needsReplay: this.needsReplay };
		}

		this.commit(decoded, seq, emittedAt);
		return ok();
	}

	/**
	 * Clear gap ONLY when expectedCursor exactly equals current cursor.
	 * Accepts cursor 0 for gap-at-start recovery.
	 */
	markReplayRecovered(expectedCursor: RemoteHostEventSequence): boolean {
		if (!isSafePosInt(expectedCursor)) return false;
		if (expectedCursor !== this.cursor) return false;
		this.hasGap = false;
		this.needsReplay = false;
		return true;
	}

	// -----------------------------------------------------------------------
	// Decode body — strict field validation
	// -----------------------------------------------------------------------
	private decodeBody(body: Record<string, unknown>): DecodedBody | null {
		const t = body.type as string;
		switch (t) {
			case "session_created":
				if (!exactObjectKeys(body, ["type", "sessionId", "workspaceId"], [])) return null;
				if (!isValidId(body.sessionId) || !isValidId(body.workspaceId)) return null;
				return {
					type: "session_created",
					sessionId: body.sessionId as string,
					workspaceId: body.workspaceId as string,
				};
			case "session_destroyed": {
				if (!exactObjectKeys(body, ["type"], ["reason"])) return null;
				if (
					body.reason !== undefined &&
					(typeof body.reason !== "string" || (body.reason as string).length > MAX_REASON)
				)
					return null;
				const d: DecodedBody = { type: "session_destroyed" };
				if (body.reason !== undefined) d.reason = (body.reason as string).slice(0, MAX_REASON);
				return d;
			}
			case "agent_start":
				return exactObjectKeys(body, ["type"], []) ? { type: "agent_start" } : null;
			case "agent_end": {
				if (!exactObjectKeys(body, ["type", "messages"], [])) return null;
				return isSafePosInt(body.messages) ? { type: "agent_end", messages: body.messages as number } : null;
			}
			case "agent_text_delta":
			case "agent_thinking_delta":
			case "agent_toolcall_delta": {
				if (!exactObjectKeys(body, ["type", "index", "text"], [])) return null;
				if (!isSafePosInt(body.index) || typeof body.text !== "string") return null;
				const perMax =
					t === "agent_thinking_delta" ? MAX_DTHINK : t === "agent_toolcall_delta" ? MAX_DTOOL : MAX_DTEXT;
				return (body.text as string).length <= perMax
					? ({ type: t, index: body.index as number, text: body.text as string } as DecodedBody)
					: null;
			}
			case "bash_start":
				if (!exactObjectKeys(body, ["type", "command"], [])) return null;
				return typeof body.command === "string" && (body.command as string).length <= MAX_CMD
					? { type: "bash_start", command: body.command as string }
					: null;
			case "bash_delta": {
				if (!exactObjectKeys(body, ["type", "text"], [])) return null;
				if (typeof body.text !== "string" || (body.text as string).length > MAX_BASH_DELTA) return null;
				return { type: "bash_delta", text: body.text as string };
			}
			case "bash_end": {
				if (!exactObjectKeys(body, ["type", "exitCode", "cancelled", "truncated"], [])) return null;
				if (!Number.isSafeInteger(body.exitCode)) return null;
				if (typeof body.cancelled !== "boolean" || typeof body.truncated !== "boolean") return null;
				return {
					type: "bash_end",
					exitCode: body.exitCode as number,
					cancelled: body.cancelled as boolean,
					truncated: body.truncated as boolean,
				};
			}
			case "compact_start":
				return exactObjectKeys(body, ["type"], []) ? { type: "compact_start" } : null;
			case "compact_end": {
				if (!exactObjectKeys(body, ["type", "keptMessages"], [])) return null;
				return isSafePosInt(body.keptMessages)
					? { type: "compact_end", keptMessages: body.keptMessages as number }
					: null;
			}
			case "compact_failed": {
				if (!exactObjectKeys(body, ["type", "error"], [])) return null;
				if (typeof body.error !== "string" || (body.error as string).length > MAX_ERR_MSG) return null;
				return { type: "compact_failed" };
			}
			case "error": {
				if (!exactObjectKeys(body, ["type", "code", "message"], [])) return null;
				if (typeof body.code !== "string" || body.code.length === 0 || (body.code as string).length > MAX_ERR_CODE)
					return null;
				if (typeof body.message !== "string" || (body.message as string).length > MAX_ERR_MSG) return null;
				return {
					type: "error",
					code: isKnownObservationErrorCode(body.code as string) ? (body.code as string) : "UNKNOWN",
				};
			}
			case "checkpoint_start":
				return exactObjectKeys(body, ["type"], []) ? { type: "checkpoint_start" } : null;
			case "checkpoint_complete": {
				if (!exactObjectKeys(body, ["type", "snapshotId"], [])) return null;
				return isBoundedStr(body.snapshotId, MAX_SNAP_ID)
					? { type: "checkpoint_complete", snapshotId: body.snapshotId as string }
					: null;
			}
			case "checkpoint_failed": {
				if (!exactObjectKeys(body, ["type", "error"], [])) return null;
				if (typeof body.error !== "string" || (body.error as string).length > MAX_ERR_MSG) return null;
				return { type: "checkpoint_failed" };
			}
			case "session_state": {
				if (!exactObjectKeys(body, ["type", "state"], [])) return null;
				return typeof body.state === "string" && SESSION_STATES.has(body.state)
					? { type: "session_state", state: body.state as RemoteHostSessionState }
					: null;
			}
			default:
				return null;
		}
	}

	// -----------------------------------------------------------------------
	// Preflight (immutable snapshot for semantic validation)
	// -----------------------------------------------------------------------
	private capturePreflight(): {
		cursor: RemoteHostEventSequence;
		hasGap: boolean;
		needsReplay: boolean;
		nextMsgIdx: number;
		agentRunning: boolean;
		msgCount: number;
		sessionState: RemoteHostSessionState | null;
		compacting: boolean;
		checkpointing: boolean;
		bash: BashState | null;
		recap: readonly RecapEntry[];
		records: ReadonlyMap<number, MirrorAssistantRecord>;
		recOrder: readonly number[];
	} {
		return {
			cursor: this.cursor,
			hasGap: this.hasGap,
			needsReplay: this.needsReplay,
			nextMsgIdx: this.nextMsgIdx,
			agentRunning: this.agentRunning,
			msgCount: this.msgCount,
			sessionState: this.sessionState,
			compacting: this.compacting,
			checkpointing: this.checkpointing,
			bash: this.bash ? { ...this.bash } : null,
			recap: [...this.recap],
			records: new Map(this.records),
			recOrder: [...this.recOrder],
		};
	}

	private validatePreflight(
		d: DecodedBody,
		pre: {
			cursor: RemoteHostEventSequence;
			hasGap: boolean;
			needsReplay: boolean;
			nextMsgIdx: number;
			agentRunning: boolean;
			msgCount: number;
			sessionState: RemoteHostSessionState | null;
			compacting: boolean;
			checkpointing: boolean;
			bash: BashState | null;
			recap: readonly RecapEntry[];
			records: ReadonlyMap<number, MirrorAssistantRecord>;
			recOrder: readonly number[];
		},
	): MirrorIngestResult | null {
		switch (d.type) {
			case "session_created":
			case "session_destroyed":
			case "session_state":
				return null;
			case "agent_start":
				return pre.agentRunning ? rej("INVALID_SESSION_STATE") : null;
			case "agent_end":
				return !pre.agentRunning
					? rej("INVALID_SESSION_STATE")
					: !isSafePosInt(d.messages)
						? rej("INVALID_MESSAGE_COUNT")
						: null;
			case "agent_text_delta":
			case "agent_thinking_delta":
			case "agent_toolcall_delta": {
				if (!isSafePosInt(d.index) || typeof d.text !== "string") return rej("INVALID_MESSAGE_INDEX");
				if (pre.records.size === 0) {
					if (d.index !== pre.nextMsgIdx)
						return { accepted: false, hasGap: true, needsReplay: true, rejectionCode: "GAP_DETECTED" };
					return null;
				}
				const maxIdx = Math.max(...pre.recOrder);
				if (d.index < maxIdx - MAX_RECORDS)
					return { accepted: false, hasGap: true, needsReplay: true, rejectionCode: "GAP_DETECTED" };
				if (d.index > maxIdx + 1)
					return { accepted: false, hasGap: true, needsReplay: true, rejectionCode: "GAP_DETECTED" };
				if (!pre.records.has(d.index) && d.index !== pre.nextMsgIdx)
					return { accepted: false, hasGap: true, needsReplay: true, rejectionCode: "GAP_DETECTED" };
				return null;
			}
			case "bash_start":
				return (pre.bash && pre.bash.exitCode === null) ||
					typeof d.command !== "string" ||
					d.command.length > MAX_CMD
					? rej("INVALID_BASH_STATE")
					: null;
			case "bash_delta":
				return !pre.bash || pre.bash.exitCode !== null || typeof d.text !== "string"
					? rej("INVALID_BASH_STATE")
					: null;
			case "bash_end":
				return !pre.bash ||
					pre.bash.exitCode !== null ||
					!Number.isSafeInteger(d.exitCode) ||
					typeof d.cancelled !== "boolean" ||
					typeof d.truncated !== "boolean"
					? rej("INVALID_BASH_STATE")
					: null;
			case "compact_start":
				return pre.compacting || pre.checkpointing ? rej("INVALID_COMPACT_STATE") : null;
			case "compact_end":
				return !pre.compacting || !isSafePosInt(d.keptMessages) ? rej("INVALID_COMPACT_STATE") : null;
			case "compact_failed":
				return pre.compacting ? null : rej("INVALID_COMPACT_STATE");
			case "error":
				return d.code.length > 0 ? null : rej("INVALID_ERROR_CODE");
			case "checkpoint_start":
				return pre.checkpointing || pre.compacting ? rej("INVALID_CHECKPOINT_STATE") : null;
			case "checkpoint_complete":
				return !pre.checkpointing || !isBoundedStr(d.snapshotId, MAX_SNAP_ID)
					? rej("INVALID_CHECKPOINT_STATE")
					: null;
			case "checkpoint_failed":
				return pre.checkpointing ? null : rej("INVALID_CHECKPOINT_STATE");
		}
	}

	// -----------------------------------------------------------------------
	// Commit
	// -----------------------------------------------------------------------
	private commit(d: DecodedBody, seq: RemoteHostEventSequence, emittedAt: string): void {
		this.cursor = seq;
		this.cursorTimestamp = emittedAt;
		this.hasGap = false;
		this.needsReplay = false;

		// Preserve the last fixed failure marker until a new session is created.
		if (d.type === "error") this.lastFailure = { type: "error", code: d.code };
		else if (d.type === "compact_failed") this.lastFailure = { type: "compact_failed" };
		else if (d.type === "checkpoint_failed") this.lastFailure = { type: "checkpoint_failed" };
		else if (d.type === "session_created") this.lastFailure = { type: "none" };

		switch (d.type) {
			case "session_created":
			case "session_destroyed":
				break;
			case "agent_start":
				this.agentRunning = true;
				break;
			case "agent_end":
				this.agentRunning = false;
				this.msgCount = d.messages;
				break;
			case "agent_text_delta":
			case "agent_thinking_delta":
			case "agent_toolcall_delta":
				this.applyDelta(d, emittedAt);
				break;
			case "bash_start":
				this.bash = { command: d.command, output: "", exitCode: null, cancelled: false, truncated: false };
				break;
			case "bash_delta": {
				const out = this.bash!.output + d.text;
				const trunc = out.length > MAX_BASH_OUT;
				this.bash = {
					...this.bash!,
					output: trunc ? out.slice(0, MAX_BASH_OUT) : out,
					truncated: this.bash!.truncated || trunc,
				};
				break;
			}
			case "bash_end":
				this.bash = {
					...this.bash!,
					exitCode: d.exitCode,
					cancelled: d.cancelled,
					truncated: this.bash!.truncated || d.truncated,
				};
				break;
			case "compact_start":
				this.compacting = true;
				break;
			case "compact_end":
			case "compact_failed":
				this.compacting = false;
				break;
			case "error":
				break;
			case "checkpoint_start":
				this.checkpointing = true;
				break;
			case "checkpoint_complete":
			case "checkpoint_failed":
				this.checkpointing = false;
				break;
			case "session_state":
				this.sessionState = d.state;
				break;
		}

		this.recap.push({
			eventSequence: seq,
			type: d.type,
			...(d.type === "agent_text_delta" || d.type === "agent_thinking_delta" || d.type === "agent_toolcall_delta"
				? { messageIndex: d.index }
				: {}),
		});
		if (this.recap.length > MAX_RECAP) this.recap.shift();
	}

	private applyDelta(
		d: { type: "agent_text_delta" | "agent_thinking_delta" | "agent_toolcall_delta"; index: number; text: string },
		emittedAt: string,
	): void {
		const idx = d.index;
		let rec = this.records.get(idx);
		if (!rec) {
			if (this.records.size >= MAX_RECORDS) this.trimRec();
			rec = {
				index: idx,
				text: "",
				thinking: "",
				toolCallText: "",
				emittedAt,
				updatedAt: emittedAt,
				textTruncated: false,
				thinkingTruncated: false,
				toolCallTruncated: false,
			};
			this.records.set(idx, rec);
			this.recOrder.push(idx);
			if (idx >= this.nextMsgIdx) this.nextMsgIdx = idx + 1;
		} else rec.updatedAt = emittedAt;

		const txt = d.text;
		if (d.type === "agent_text_delta") {
			const n = rec.text + txt;
			if (n.length > MAX_TEXT) {
				rec.text = n.slice(0, MAX_TEXT);
				rec.textTruncated = true;
			} else rec.text = n;
		} else if (d.type === "agent_thinking_delta") {
			const n = rec.thinking + txt;
			if (n.length > MAX_THINK) {
				rec.thinking = n.slice(0, MAX_THINK);
				rec.thinkingTruncated = true;
			} else rec.thinking = n;
		} else {
			const n = rec.toolCallText + txt;
			if (n.length > MAX_TOOL) {
				rec.toolCallText = n.slice(0, MAX_TOOL);
				rec.toolCallTruncated = true;
			} else rec.toolCallText = n;
		}
	}

	private trimRec(): void {
		while (this.recOrder.length >= MAX_RECORDS) {
			const idx = this.recOrder.shift()!;
			this.records.delete(idx);
		}
	}

	getRecapDelta(from: number): { entries: RecapEntry[]; signalGap: boolean } {
		if (typeof from !== "number" || !Number.isInteger(from) || from < 0 || from > this.cursor)
			return { entries: [], signalGap: true };
		const oldest = this.recap.length > 0 ? this.recap[0].eventSequence : this.cursor + 1;
		const entries = this.recap.filter((e) => e.eventSequence > from);
		return { entries, signalGap: from + 1 < oldest || this.hasGap || (entries.length === 0 && from < this.cursor) };
	}

	captureCoreState(): CoreStateDTO {
		return deepFreeze({
			version: "1" as const,
			hostId: this.hostId,
			generation: this.generation,
			sessionId: this.sessionId,
			capturedAt: new Date().toISOString(),
			cursor: this.cursor,
			cursorTimestamp: this.cursorTimestamp,
			hasGap: this.hasGap,
			needsReplay: this.needsReplay,
			nextMessageIndex: this.nextMsgIdx,
			records: this.recOrder.map((idx) => {
				const r = this.records.get(idx)!;
				return {
					index: r.index,
					text: r.text,
					thinking: r.thinking,
					toolCallText: r.toolCallText,
					emittedAt: r.emittedAt,
					updatedAt: r.updatedAt,
					textTruncated: r.textTruncated,
					thinkingTruncated: r.thinkingTruncated,
					toolCallTruncated: r.toolCallTruncated,
				};
			}),
			messageCount: this.msgCount,
			agentRunning: this.agentRunning,
			sessionState: this.sessionState,
			compacting: this.compacting,
			checkpointing: this.checkpointing,
			bash: this.bash
				? {
						command: this.bash.command,
						output: this.bash.output,
						exitCode: this.bash.exitCode,
						cancelled: this.bash.cancelled,
						truncated: this.bash.truncated,
					}
				: null,
			recap: this.recap.map((e) => ({
				eventSequence: e.eventSequence,
				type: e.type,
				...(e.messageIndex !== undefined ? { messageIndex: e.messageIndex } : {}),
			})),
			lastFailure: this.lastFailure,
		});
	}

	// Getters
	get currentCursor(): RemoteHostEventSequence {
		return this.cursor;
	}
	get cursorTimestampValue(): string {
		return this.cursorTimestamp;
	}
	get hasGapFlag(): boolean {
		return this.hasGap;
	}
	get needsReplayFlag(): boolean {
		return this.needsReplay;
	}
	get currentNextMessageIndex(): number {
		return this.nextMsgIdx;
	}
	get agentRunningVal(): boolean {
		return this.agentRunning;
	}
	get msgCountVal(): number {
		return this.msgCount;
	}
	get sessionStateVal(): RemoteHostSessionState | null {
		return this.sessionState;
	}
	get compactingVal(): boolean {
		return this.compacting;
	}
	get checkpointingVal(): boolean {
		return this.checkpointing;
	}
	get currentActivity(): MirrorActivity {
		return Object.freeze({
			agentRunning: this.agentRunning,
			messageCount: this.msgCount,
			sessionState: this.sessionState,
			compacting: this.compacting,
			checkpointing: this.checkpointing,
		});
	}
	get currentBash(): BashState | null {
		return this.bash ? Object.freeze({ ...this.bash }) : null;
	}
	get transcriptRecordCount(): number {
		return this.records.size;
	}
	get recapEntries(): readonly RecapEntry[] {
		return this.recap.map((e) => Object.freeze({ ...e }));
	}
	getRecord(index: number): Readonly<MirrorAssistantRecord> | undefined {
		const r = this.records.get(index);
		return r ? Object.freeze({ ...r }) : undefined;
	}
	get lastFailureValue(): LastFailureMarker {
		return Object.freeze({ ...this.lastFailure });
	}
	// -----------------------------------------------------------------------
	// captureSnapshot — alias for captureCoreState (RemoteObservationSnapshotV1)
	// -----------------------------------------------------------------------
	captureSnapshot(): RemoteObservationSnapshotV1 {
		return this.captureCoreState();
	}

	// -----------------------------------------------------------------------
	// fromSnapshot — decode + construct from a snapshot value (atomic)
	// -----------------------------------------------------------------------
	/**
	 * Decode and validate a snapshot, then construct a new mirror with exact
	 * restored state. Fully decodes/preflights before constructing/mutating.
	 * Requires exact caller-bound identity. No partial restore/default repair.
	 * Returns { success: true, mirror } on success, or { success: false, code }
	 * on validation failure.
	 */
	static fromSnapshot(
		snapshot: unknown,
		expectedIdentity: { hostId: string; generation: string; sessionId: string },
	): { success: true; mirror: RemoteObservationMirror } | { success: false; code: SnapshotRejectionCode } {
		const decoded = decodeRemoteObservationSnapshotV1(snapshot, expectedIdentity);
		if (!decoded.success) return { success: false, code: decoded.code };

		const s = decoded.value;

		// Construct mirror with identity and initial next message index
		const m = new RemoteObservationMirror({
			hostId: s.hostId,
			generation: s.generation,
			sessionId: s.sessionId,
			initialNextIndex: s.nextMessageIndex,
		});

		// Restore cursor/cursorTimestamp
		m.cursor = s.cursor;
		m.cursorTimestamp = s.cursorTimestamp;

		// Restore gap flags
		m.hasGap = s.hasGap;
		m.needsReplay = s.needsReplay;

		// Restore records
		for (const rec of s.records) {
			m.records.set(rec.index, {
				index: rec.index,
				text: rec.text,
				thinking: rec.thinking,
				toolCallText: rec.toolCallText,
				emittedAt: rec.emittedAt,
				updatedAt: rec.updatedAt,
				textTruncated: rec.textTruncated,
				thinkingTruncated: rec.thinkingTruncated,
				toolCallTruncated: rec.toolCallTruncated,
			});
			m.recOrder.push(rec.index);
		}

		// Restore activity/state
		m.msgCount = s.messageCount;
		m.agentRunning = s.agentRunning;
		m.sessionState = s.sessionState;
		m.compacting = s.compacting;
		m.checkpointing = s.checkpointing;

		// Restore bash
		m.bash = s.bash
			? {
					command: s.bash.command,
					output: s.bash.output,
					exitCode: s.bash.exitCode,
					cancelled: s.bash.cancelled,
					truncated: s.bash.truncated,
				}
			: null;

		// Restore recap
		for (const e of s.recap) {
			m.recap.push({
				eventSequence: e.eventSequence,
				type: e.type,
				...(e.messageIndex !== undefined ? { messageIndex: e.messageIndex } : {}),
			});
		}

		// Restore lastFailure
		m.lastFailure = s.lastFailure;

		return { success: true, mirror: m };
	}
}

function ok(): MirrorIngestResult {
	return { accepted: true, hasGap: false, needsReplay: false };
}
function rej(code: MirrorRejectionCode, hasGap = false, needsReplay = false): MirrorIngestResult {
	return { accepted: false, rejectionCode: code, hasGap, needsReplay };
}
