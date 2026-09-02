/**
 * B11-a: remote observation event decoder + bounded in-memory transition/transcript core.
 * No snapshot/restore, name, usage, pending, connection health, or observer DTO.
 */
import { isValidISODateString } from "../../core/execution-location.js";
import type { RemoteHostEventSequence, RemoteHostSessionState } from "./remote-agent-host-protocol.js";

const MAX_ID = 128,
	MAX_HOST_ID = 128,
	MAX_GEN = 128,
	MAX_SESS_ID = 128,
	MAX_WS_ID = 128,
	MAX_SNAP_ID = 128;
const MAX_REASON = 256,
	MAX_CMD = 10_000,
	MAX_ERR_CODE = 128;
const MAX_TEXT = 100_000,
	MAX_THINK = 200_000,
	MAX_TOOL = 50_000,
	MAX_BASH_OUT = 500_000;
const MAX_DTEXT = 50_000,
	MAX_DTHINK = 100_000,
	MAX_DTOOL = 25_000;
const MAX_RECORDS = 200,
	MAX_RECAP = 100;
const SESSION_STATES = new Set(["running", "idle", "inactive"]);
const KNOWN_ERR = new Set([
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

function isPosSafeInt(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
}
function isBoundedStr(v: unknown, max: number): v is string {
	return typeof v === "string" && v.length > 0 && v.length <= max;
}
function isNonNegInt(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
function exactKeys(obj: Record<string, unknown>, req: readonly string[], opt: readonly string[]): boolean {
	const all = new Set(req);
	for (const k of opt) all.add(k);
	const keys = Object.keys(obj);
	return keys.length >= req.length && keys.length <= all.size && keys.every((k) => all.has(k));
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
	| "OVERFLOW";

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
export interface CoreStateDTO {
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
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
	readonly recap: ReadonlyArray<RecapEntry>;
}

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

interface PreflightState {
	readonly cursor: RemoteHostEventSequence;
	readonly hasGap: boolean;
	readonly needsReplay: boolean;
	readonly nextMsgIdx: number;
	readonly agentRunning: boolean;
	readonly msgCount: number;
	readonly sessionState: RemoteHostSessionState | null;
	readonly compacting: boolean;
	readonly checkpointing: boolean;
	readonly bash: {
		command: string;
		output: string;
		exitCode: number | null;
		cancelled: boolean;
		truncated: boolean;
	} | null;
	readonly recap: readonly RecapEntry[];
	readonly records: ReadonlyMap<number, MirrorAssistantRecord>;
	readonly recOrder: readonly number[];
}

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

	constructor(opts: { hostId: string; generation: string; sessionId: string; initialNextIndex?: number }) {
		if (!isBoundedStr(opts.hostId, MAX_HOST_ID)) throw new Error("Invalid hostId");
		if (!isBoundedStr(opts.generation, MAX_GEN)) throw new Error("Invalid generation");
		if (!isBoundedStr(opts.sessionId, MAX_SESS_ID)) throw new Error("Invalid sessionId");
		this.hostId = opts.hostId;
		this.generation = opts.generation;
		this.sessionId = opts.sessionId;
		if (opts.initialNextIndex !== undefined) {
			if (!isPosSafeInt(opts.initialNextIndex)) throw new Error("Invalid initialNextIndex");
			this.nextMsgIdx = opts.initialNextIndex;
		}
	}

	get identity() {
		return { hostId: this.hostId, generation: this.generation, sessionId: this.sessionId };
	}

	// -----------------------------------------------------------------------
	// ingestEvent
	// -----------------------------------------------------------------------
	ingestEvent(raw: unknown): MirrorIngestResult {
		if (!raw || typeof raw !== "object" || Object.getPrototypeOf(raw) !== Object.prototype)
			return rej("NOT_AN_OBJECT");
		const frame = raw as Record<string, unknown>;
		const fkeys = Object.keys(frame);
		const reqKeys = ["type", "id", "sequence", "cursor", "emittedAt", "body"] as const;
		const allowedKeys = new Set<string>(reqKeys as unknown as string[]);
		if (fkeys.some((k) => !allowedKeys.has(k)) || reqKeys.some((k) => !fkeys.includes(k)))
			return rej(fkeys.length < reqKeys.length ? "MALFORMED_OPTIONAL" : "UNKNOWN_FIELD");
		if (frame.type !== "event") return rej("INVALID_TYPE");
		if (typeof frame.id !== "string" || !frame.id.length || frame.id.length > MAX_ID) return rej("INVALID_ID");
		if (!isPosSafeInt(frame.sequence) || (frame.sequence as number) < 1) return rej("INVALID_SEQUENCE");

		if (!frame.cursor || typeof frame.cursor !== "object") return rej("INVALID_CURSOR_TYPE");
		const cursor = frame.cursor as Record<string, unknown>;
		if (!exactKeys(cursor, ["hostId", "generation", "sessionId", "sequence"], [])) return rej("MALFORMED_OPTIONAL");
		if (!isBoundedStr(cursor.hostId, MAX_HOST_ID) || cursor.hostId !== this.hostId) return rej("IDENTITY_MISMATCH");
		if (!isBoundedStr(cursor.generation, MAX_GEN) || cursor.generation !== this.generation)
			return rej("IDENTITY_MISMATCH");
		if (!isBoundedStr(cursor.sessionId, MAX_SESS_ID) || cursor.sessionId !== this.sessionId)
			return rej("IDENTITY_MISMATCH");
		if (!isPosSafeInt(cursor.sequence) || (cursor.sequence as number) !== (frame.sequence as number))
			return rej("CURSOR_MISMATCH");

		if (
			typeof frame.emittedAt !== "string" ||
			frame.emittedAt.length === 0 ||
			frame.emittedAt.length > 64 ||
			!isValidISODateString(frame.emittedAt)
		)
			return rej("INVALID_EMITTED_AT");

		const seq = frame.sequence as RemoteHostEventSequence;
		const emittedAt = frame.emittedAt as string;

		if (seq <= this.cursor) return stale();

		// Future sequence: validate structure fully, set gap flags, no mutation of cursor/content
		if (seq > this.cursor + 1) {
			if (!frame.body || typeof frame.body !== "object" || Object.getPrototypeOf(frame.body) !== Object.prototype)
				return rej("INVALID_BODY_TYPE");
			const body = frame.body as Record<string, unknown>;
			if (typeof body.type !== "string" || !body.type.length) return rej("INVALID_BODY_TYPE");
			if (!this.decodeBody(body)) return rej("INVALID_BODY_TYPE");
			this.hasGap = true;
			this.needsReplay = true;
			return rej("GAP_DETECTED", true, true);
		}

		if (this.hasGap) return { accepted: false, rejectionCode: "GAP_DETECTED", hasGap: true, needsReplay: true };

		if (!frame.body || typeof frame.body !== "object" || Object.getPrototypeOf(frame.body) !== Object.prototype)
			return rej("INVALID_BODY_TYPE");
		const body = frame.body as Record<string, unknown>;
		if (typeof body.type !== "string" || !body.type.length) return rej("INVALID_BODY_TYPE");

		const decoded = this.decodeBody(body);
		if (!decoded) return rej("INVALID_BODY_TYPE");
		const pre = this.capturePreflight();
		const preErr = this.validatePreflight(decoded, pre);
		if (preErr) return { ...preErr, hasGap: this.hasGap, needsReplay: this.needsReplay };

		this.commit(decoded, seq, emittedAt);
		return ok();
	}

	markReplayRecovered(expectedCursor: RemoteHostEventSequence): boolean {
		if (!isPosSafeInt(expectedCursor) || expectedCursor < this.cursor) return false;
		this.hasGap = false;
		this.needsReplay = false;
		if (expectedCursor > this.cursor) this.cursor = expectedCursor;
		return true;
	}

	// -----------------------------------------------------------------------
	// Decode body — strict field validation
	// -----------------------------------------------------------------------
	private decodeBody(body: Record<string, unknown>): DecodedBody | null {
		const t = body.type as string;
		switch (t) {
			case "session_created":
				if (!exactKeys(body, ["type", "sessionId", "workspaceId"], [])) return null;
				if (!isBoundedStr(body.sessionId, MAX_SESS_ID) || !isBoundedStr(body.workspaceId, MAX_WS_ID)) return null;
				return {
					type: "session_created",
					sessionId: body.sessionId as string,
					workspaceId: body.workspaceId as string,
				};
			case "session_destroyed": {
				if (!exactKeys(body, ["type"], ["reason"])) return null;
				if (
					body.reason !== undefined &&
					(typeof body.reason !== "string" || (body.reason as string).length > MAX_REASON)
				)
					return null;
				const d: DecodedBody = { type: "session_destroyed" };
				if (body.reason !== undefined) d.reason = body.reason as string;
				return d;
			}
			case "agent_start":
				return exactKeys(body, ["type"], []) ? { type: "agent_start" } : null;
			case "agent_end": {
				if (!exactKeys(body, ["type", "messages"], [])) return null;
				return isNonNegInt(body.messages) ? { type: "agent_end", messages: body.messages as number } : null;
			}
			case "agent_text_delta":
			case "agent_thinking_delta":
			case "agent_toolcall_delta": {
				if (!exactKeys(body, ["type", "index", "text"], [])) return null;
				if (!isNonNegInt(body.index) || typeof body.text !== "string") return null;
				const perMax =
					t === "agent_thinking_delta" ? MAX_DTHINK : t === "agent_toolcall_delta" ? MAX_DTOOL : MAX_DTEXT;
				return (body.text as string).length <= perMax
					? ({ type: t, index: body.index as number, text: body.text as string } as DecodedBody)
					: null;
			}
			case "bash_start":
				if (!exactKeys(body, ["type", "command"], [])) return null;
				return typeof body.command === "string" && (body.command as string).length <= MAX_CMD
					? { type: "bash_start", command: body.command as string }
					: null;
			case "bash_delta":
				return exactKeys(body, ["type", "text"], []) && typeof body.text === "string"
					? { type: "bash_delta", text: body.text as string }
					: null;
			case "bash_end": {
				if (!exactKeys(body, ["type", "exitCode", "cancelled", "truncated"], [])) return null;
				return Number.isInteger(body.exitCode) &&
					typeof body.cancelled === "boolean" &&
					typeof body.truncated === "boolean"
					? {
							type: "bash_end",
							exitCode: body.exitCode as number,
							cancelled: body.cancelled as boolean,
							truncated: body.truncated as boolean,
						}
					: null;
			}
			case "compact_start":
				return exactKeys(body, ["type"], []) ? { type: "compact_start" } : null;
			case "compact_end": {
				if (!exactKeys(body, ["type", "keptMessages"], [])) return null;
				return isNonNegInt(body.keptMessages)
					? { type: "compact_end", keptMessages: body.keptMessages as number }
					: null;
			}
			case "compact_failed":
				return exactKeys(body, ["type", "error"], []) && typeof body.error === "string"
					? { type: "compact_failed" }
					: null;
			case "error": {
				if (!exactKeys(body, ["type", "code", "message"], [])) return null;
				if (typeof body.code !== "string" || body.code.length === 0 || (body.code as string).length > MAX_ERR_CODE)
					return null;
				if (typeof body.message !== "string") return null;
				return { type: "error", code: KNOWN_ERR.has(body.code as string) ? (body.code as string) : "UNKNOWN" };
			}
			case "checkpoint_start":
				return exactKeys(body, ["type"], []) ? { type: "checkpoint_start" } : null;
			case "checkpoint_complete": {
				if (!exactKeys(body, ["type", "snapshotId"], [])) return null;
				return isBoundedStr(body.snapshotId, MAX_SNAP_ID)
					? { type: "checkpoint_complete", snapshotId: body.snapshotId as string }
					: null;
			}
			case "checkpoint_failed":
				return exactKeys(body, ["type", "error"], []) && typeof body.error === "string"
					? { type: "checkpoint_failed" }
					: null;
			case "session_state": {
				if (!exactKeys(body, ["type", "state"], [])) return null;
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
	private capturePreflight(): PreflightState {
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

	private validatePreflight(d: DecodedBody, pre: PreflightState): MirrorIngestResult | null {
		switch (d.type) {
			case "session_created":
			case "session_destroyed":
			case "session_state":
				return null;
			case "agent_start":
				return pre.agentRunning ? rej("INVALID_SESSION_STATE") : null;
			case "agent_end":
				return !pre.agentRunning || !isNonNegInt(d.messages)
					? rej(!pre.agentRunning ? "INVALID_SESSION_STATE" : "INVALID_MESSAGE_COUNT")
					: null;
			case "agent_text_delta":
			case "agent_thinking_delta":
			case "agent_toolcall_delta": {
				if (!isNonNegInt(d.index) || typeof d.text !== "string") return rej("INVALID_MESSAGE_INDEX");
				if (pre.records.size === 0)
					return d.index !== 0
						? { accepted: false, hasGap: true, needsReplay: true, rejectionCode: "GAP_DETECTED" }
						: null;
				const maxIdx = Math.max(...pre.recOrder);
				if (d.index > maxIdx + 1 || d.index < maxIdx - MAX_RECORDS)
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
					!Number.isInteger(d.exitCode) ||
					typeof d.cancelled !== "boolean" ||
					typeof d.truncated !== "boolean"
					? rej("INVALID_BASH_STATE")
					: null;
			case "compact_start":
				return pre.compacting ? rej("INVALID_COMPACT_STATE") : null;
			case "compact_end":
				return !pre.compacting || !isNonNegInt(d.keptMessages) ? rej("INVALID_COMPACT_STATE") : null;
			case "compact_failed":
				return pre.compacting ? null : rej("INVALID_COMPACT_STATE");
			case "error":
				return d.code.length > 0 ? null : rej("INVALID_ERROR_CODE");
			case "checkpoint_start":
				return pre.checkpointing ? rej("INVALID_CHECKPOINT_STATE") : null;
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
				const truncated = out.length > MAX_BASH_OUT;
				this.bash = {
					...this.bash!,
					output: truncated ? out.slice(0, MAX_BASH_OUT) : out,
					truncated: this.bash!.truncated || truncated,
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
				break; // code already allowlist-mapped; raw message discarded
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

	// -----------------------------------------------------------------------
	// Immutable core state DTO for persistence layer
	// -----------------------------------------------------------------------
	captureCoreState(): CoreStateDTO {
		return deepFreeze({
			hostId: this.hostId,
			generation: this.generation,
			sessionId: this.sessionId,
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
		});
	}

	// Getters (immutable snapshots)
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
		return this.bash ? { ...this.bash } : null;
	}
	get transcriptRecordCount(): number {
		return this.records.size;
	}
	get recapEntries(): readonly RecapEntry[] {
		return [...this.recap];
	}
	getRecord(index: number): Readonly<MirrorAssistantRecord> | undefined {
		const r = this.records.get(index);
		return r ? Object.freeze({ ...r }) : undefined;
	}
}

function ok(): MirrorIngestResult {
	return { accepted: true, hasGap: false, needsReplay: false };
}
function stale(): MirrorIngestResult {
	return { accepted: false, hasGap: false, needsReplay: false };
}
function rej(code: MirrorRejectionCode, hasGap = false, needsReplay = false): MirrorIngestResult {
	return { accepted: false, rejectionCode: code, hasGap, needsReplay };
}
