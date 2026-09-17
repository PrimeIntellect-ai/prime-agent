/**
 * Minimal hand-rolled protobuf codec for the sandbox `command_session`
 * service, plus the Connect protocol frame envelope used by its streaming
 * RPCs.
 *
 * Authoritative shape: `command_session.proto` in
 * `platform/sandbox/vm-sandboxes/packages/sandboxd/spec` (the sandboxd guest
 * service). Only the messages the orchestrator needs are implemented:
 * StartRequest, ConnectRequest, UpdateRequest, SendInputRequest,
 * SendSignalRequest, and the StartResponse/ConnectResponse event envelope.
 *
 * Why hand-rolled instead of generated: no TypeScript Connect/protobuf codegen
 * package is a declared dependency of this repo (`@connectrpc/*` and
 * `@bufbuild/*` are absent; `protobufjs` exists only as a transitive
 * dependency of `@google/genai` under packages/ai), and the repo's
 * min-release-age dependency policy makes adding one a separate decision. The
 * command_session surface is small and stable, so a strict ~600-line codec
 * keeps this slice dependency-free and fully testable.
 *
 * Strictness contract:
 * - Decoders reject malformed or truncated input instead of defaulting.
 * - Encoders reject invalid requests (non-UUID idempotency keys, empty
 *   commands, out-of-range sizes) before any bytes reach the network.
 * - Strings must be valid UTF-8; bools must be exactly 0 or 1; oneof members
 *   may not repeat; unknown fields are skipped per proto3 rules.
 * - The frame decoder refuses frames larger than its bound so a hostile or
 *   buggy peer cannot force unbounded buffering.
 */

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();

export type CommandSessionProtoErrorKind = "invalid_input" | "invalid_wire";

/** Codec-level error: a bad request value, malformed wire bytes, or an oversize frame. */
export class CommandSessionProtoError extends Error {
	readonly kind: CommandSessionProtoErrorKind;

	constructor(kind: CommandSessionProtoErrorKind, message: string, options?: { cause?: unknown }) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "CommandSessionProtoError";
		this.kind = kind;
	}
}

/** A Connect streaming frame exceeded the decoder's size bound. */
export class OversizeConnectFrameError extends Error {
	readonly maxBytes: number;
	readonly frameBytes: number;

	constructor(maxBytes: number, frameBytes: number) {
		super(`Connect frame of ${frameBytes} bytes exceeds the ${maxBytes} byte limit`);
		this.name = "OversizeConnectFrameError";
		this.maxBytes = maxBytes;
		this.frameBytes = frameBytes;
	}
}

/** Signals the CommandSession service delivers; values are the proto enum values. */
export const VM_SIGNALS = { terminate: 15, kill: 9 } as const;
export type VmSignalName = keyof typeof VM_SIGNALS;

/** Command to run, without a shell (proto `CommandSpec`). */
export interface CommandSpec {
	/** Executable path or name; non-empty, NUL-free. */
	cmd: string;
	/** Arguments passed verbatim; NUL-free strings. */
	args: string[];
	/** Environment overrides applied over the sandbox default. */
	envs?: Record<string, string>;
	/** Working directory; omit to inherit the sandbox default. */
	cwd?: string;
}

/** PTY window size (proto `PTY.Size`). */
export interface PtySize {
	/** Columns; integer 1..65535 (sandboxd casts to winsize cols). */
	cols: number;
	/** Rows; integer 1..65535 (sandboxd casts to winsize rows). */
	rows: number;
}

/** Input write target channel (proto `CommandInput` oneof). */
export type CommandInputChannel = "stdin" | "pty";

/** Raw Start request. `sessionUuid` is the create-or-attach idempotency key. */
export interface StartRequest {
	command: CommandSpec;
	/** Initial PTY size; presence starts the command under a PTY. */
	pty?: PtySize;
	/**
	 * Whether the process gets a real stdin pipe. Explicit on the wire:
	 * sandboxd treats an absent field as `true`, so a resident daemon that
	 * wants no stdin must encode `false`, not omit it.
	 */
	stdin: boolean;
	/**
	 * Caller-supplied create-or-attach key. Re-issuing the identical request
	 * attaches to the session instead of spawning a second process; a
	 * different spec under the same key fails with failed_precondition.
	 */
	sessionUuid: string;
}

// ---------------------------------------------------------------------------
// Wire primitives
// ---------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_32BIT = 5;

const MAX_VARINT_BYTES = 10;
const MAX_UINT32 = 0xffff_ffff;
const MAX_VARINT_VALUE = Number.MAX_SAFE_INTEGER; // decoding uses JavaScript numbers; reject wider values

class Writer {
	private readonly chunks: Uint8Array[] = [];
	private length = 0;

	private push(chunk: Uint8Array): void {
		this.chunks.push(chunk);
		this.length += chunk.byteLength;
	}

	private varint(value: number): void {
		if (!Number.isInteger(value) || value < 0 || value > MAX_VARINT_VALUE) {
			throw new CommandSessionProtoError("invalid_input", `cannot encode ${value} as a varint`);
		}
		let remaining = value;
		while (remaining > MAX_UINT32) {
			this.push(Uint8Array.of((remaining & 0x7f) | 0x80));
			remaining = Math.floor(remaining / 128);
		}
		while (remaining >= 0x80) {
			this.push(Uint8Array.of((remaining & 0x7f) | 0x80));
			remaining >>>= 7;
		}
		this.push(Uint8Array.of(remaining));
	}

	private tag(field: number, wire: number): void {
		this.varint((field << 3) | wire);
	}

	bytesField(field: number, value: Uint8Array): void {
		this.tag(field, WIRE_LEN);
		this.varint(value.byteLength);
		this.push(value);
	}

	stringField(field: number, value: string): void {
		this.bytesField(field, UTF8_ENCODER.encode(value));
	}

	boolField(field: number, value: boolean): void {
		this.tag(field, WIRE_VARINT);
		this.varint(value ? 1 : 0);
	}

	/** Writes a varint field (numbers, enums). */
	varintField(field: number, value: number): void {
		this.tag(field, WIRE_VARINT);
		this.varint(value);
	}

	/** Encodes a nested message field by writing it into a sub-writer. */
	messageField(field: number, write: (writer: Writer) => void): void {
		const sub = new Writer();
		write(sub);
		this.tag(field, WIRE_LEN);
		const encoded = sub.finish();
		this.varint(encoded.byteLength);
		this.push(encoded);
	}

	finish(): Uint8Array {
		const out = new Uint8Array(this.length);
		let offset = 0;
		for (const chunk of this.chunks) {
			out.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return out;
	}
}

class Reader {
	readonly data: Uint8Array;
	pos: number;

	constructor(data: Uint8Array, pos = 0) {
		this.data = data;
		this.pos = pos;
	}

	get eof(): boolean {
		return this.pos >= this.data.byteLength;
	}

	varint(context: string): number {
		let value = 0;
		let shift = 0;
		let count = 0;
		while (true) {
			if (this.pos >= this.data.byteLength) {
				throw new CommandSessionProtoError("invalid_wire", `${context}: truncated varint`);
			}
			const byte = this.data[this.pos];
			this.pos++;
			count++;
			value += (byte & 0x7f) * 2 ** shift;
			if ((byte & 0x80) === 0) {
				if (value > MAX_VARINT_VALUE) {
					throw new CommandSessionProtoError(
						"invalid_wire",
						`${context}: varint exceeds JavaScript safe integer range`,
					);
				}
				return value;
			}
			shift += 7;
			if (count >= MAX_VARINT_BYTES) {
				throw new CommandSessionProtoError("invalid_wire", `${context}: varint exceeds 10 bytes`);
			}
		}
	}

	tag(context: string): { field: number; wire: number } {
		const raw = this.varint(context);
		const field = Math.floor(raw / 8);
		const wire = raw % 8;
		if (field === 0) {
			throw new CommandSessionProtoError("invalid_wire", `${context}: field number 0 is invalid`);
		}
		return { field, wire };
	}

	/** Reads a length-delimited field body as a copied byte array. */
	bytes(context: string): Uint8Array {
		const length = this.varint(context);
		if (length > MAX_UINT32) {
			throw new CommandSessionProtoError("invalid_wire", `${context}: length overflows 32 bits`);
		}
		if (this.pos + length > this.data.byteLength) {
			throw new CommandSessionProtoError("invalid_wire", `${context}: truncated length-delimited field`);
		}
		const value = this.data.slice(this.pos, this.pos + length);
		this.pos += length;
		return value;
	}

	string(context: string): string {
		const raw = this.bytes(context);
		try {
			return UTF8_DECODER.decode(raw);
		} catch (error) {
			throw new CommandSessionProtoError("invalid_wire", `${context}: string is not valid UTF-8`, {
				cause: error,
			});
		}
	}

	uint32(context: string): number {
		const value = this.varint(context);
		if (value > MAX_UINT32) {
			throw new CommandSessionProtoError("invalid_wire", `${context}: value overflows uint32`);
		}
		return value;
	}

	bool(context: string): boolean {
		const value = this.varint(context);
		if (value === 0) return false;
		if (value === 1) return true;
		throw new CommandSessionProtoError("invalid_wire", `${context}: bool must be 0 or 1, got ${value}`);
	}

	sint32(context: string): number {
		const value = this.varint(context);
		if (value > MAX_UINT32) {
			throw new CommandSessionProtoError("invalid_wire", `${context}: zigzag value overflows uint32`);
		}
		return (value >>> 1) ^ -(value & 1);
	}

	skip(wire: number, context: string): void {
		switch (wire) {
			case WIRE_VARINT:
				this.varint(context);
				return;
			case WIRE_64BIT: {
				if (this.pos + 8 > this.data.byteLength) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: truncated 64-bit field`);
				}
				this.pos += 8;
				return;
			}
			case WIRE_LEN:
				this.bytes(context);
				return;
			case WIRE_32BIT: {
				if (this.pos + 4 > this.data.byteLength) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: truncated 32-bit field`);
				}
				this.pos += 4;
				return;
			}
			default:
				throw new CommandSessionProtoError(
					"invalid_wire",
					`${context}: unsupported wire type ${wire} (groups are not valid proto3)`,
				);
		}
	}
}

// ---------------------------------------------------------------------------
// Request validation and encoding
// ---------------------------------------------------------------------------

const CANONICAL_UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Parse and canonicalize a UUID key the way sandboxd does (google/uuid
 * `Parse`: plain, `urn:uuid:`-prefixed, and braced spellings all converge to
 * one lowercase canonical key). The nil UUID is rejected: it is never a valid
 * idempotency key. Throws `CommandSessionProtoError("invalid_input")`.
 */
export function canonicalUuidKey(value: string, field: string): string {
	if (typeof value !== "string") {
		throw new CommandSessionProtoError("invalid_input", `${field} must be a UUID string`);
	}
	let candidate = value.trim();
	if (candidate.toLowerCase().startsWith("urn:uuid:")) {
		candidate = candidate.slice("urn:uuid:".length);
	}
	if (candidate.startsWith("{") && candidate.endsWith("}")) {
		candidate = candidate.slice(1, -1);
	}
	if (!CANONICAL_UUID_PATTERN.test(candidate)) {
		throw new CommandSessionProtoError("invalid_input", `${field} ${JSON.stringify(value)} is not a UUID`);
	}
	const canonical = candidate.toLowerCase();
	if (canonical === NIL_UUID) {
		throw new CommandSessionProtoError("invalid_input", `${field} must not be the nil UUID`);
	}
	return canonical;
}

function requireNulFreeString(value: string, field: string): string {
	if (typeof value !== "string" || value === "" || value.includes("\x00")) {
		throw new CommandSessionProtoError("invalid_input", `${field} must be a non-empty NUL-free string`);
	}
	return value;
}

function encodeCommandSpec(writer: Writer, command: CommandSpec): void {
	if (command === null || typeof command !== "object") {
		throw new CommandSessionProtoError("invalid_input", "command must be a CommandSpec object");
	}
	const cmd = requireNulFreeString(command.cmd, "command.cmd");
	if (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string" || arg.includes("\x00"))) {
		throw new CommandSessionProtoError("invalid_input", "command.args must be an array of NUL-free strings");
	}
	writer.stringField(1, cmd);
	for (const arg of command.args) {
		writer.stringField(2, arg);
	}
	const envs = command.envs ?? {};
	if (envs === null || typeof envs !== "object" || Array.isArray(envs)) {
		throw new CommandSessionProtoError("invalid_input", "command.envs must be a string record");
	}
	for (const [key, value] of Object.entries(envs)) {
		if (key === "" || key.includes("\x00") || key.includes("=")) {
			throw new CommandSessionProtoError(
				"invalid_input",
				`command.envs key ${JSON.stringify(key)} must be non-empty and free of NUL and "="`,
			);
		}
		if (typeof value !== "string" || value.includes("\x00")) {
			throw new CommandSessionProtoError("invalid_input", `command.envs[${key}] must be a NUL-free string`);
		}
		// map<string, string> entries are nested messages: field 1 key, field 2 value.
		writer.messageField(3, (entry) => {
			entry.stringField(1, key);
			entry.stringField(2, value);
		});
	}
	if (command.cwd !== undefined) {
		writer.stringField(4, requireNulFreeString(command.cwd, "command.cwd"));
	}
}

function encodePtySize(writer: Writer, size: PtySize, field: string): void {
	if (
		!Number.isInteger(size?.cols) ||
		!Number.isInteger(size?.rows) ||
		size.cols < 1 ||
		size.cols > 0xffff ||
		size.rows < 1 ||
		size.rows > 0xffff
	) {
		throw new CommandSessionProtoError("invalid_input", `${field} cols and rows must be integers 1..65535`);
	}
	// PTY { size { cols = 1, rows = 2 } }
	writer.messageField(1, (sizeWriter) => {
		sizeWriter.varintField(1, size.cols);
		sizeWriter.varintField(2, size.rows);
	});
}

/** Encode a `StartRequest`. Throws `CommandSessionProtoError("invalid_input")` on invalid values. */
export function encodeStartRequest(request: StartRequest): Uint8Array {
	if (request === null || typeof request !== "object") {
		throw new CommandSessionProtoError("invalid_input", "start request must be an object");
	}
	if (typeof request.stdin !== "boolean") {
		throw new CommandSessionProtoError("invalid_input", "stdin must be an explicit boolean");
	}
	const sessionUuid = canonicalUuidKey(request.sessionUuid, "sessionUuid");
	const writer = new Writer();
	writer.messageField(1, (spec) => encodeCommandSpec(spec, request.command));
	const pty = request.pty;
	if (pty !== undefined) {
		writer.messageField(2, (ptyWriter) => encodePtySize(ptyWriter, pty, "pty"));
	}
	// Field 3 is reserved on the wire; stdin is field 4 and must carry explicit
	// presence because sandboxd defaults an absent field to true.
	writer.boolField(4, request.stdin);
	// session_uuid is field 5.
	writer.stringField(5, sessionUuid);
	return writer.finish();
}

function encodeSelector(writer: Writer, sessionUuid: string): void {
	const canonical = canonicalUuidKey(sessionUuid, "sessionUuid");
	// pid (field 1) is never used by this client; session_uuid is field 3.
	writer.stringField(3, canonical);
}

/** Encode a `ConnectRequest` selecting a session by its UUID. */
export function encodeConnectRequest(sessionUuid: string): Uint8Array {
	const writer = new Writer();
	writer.messageField(1, (selector) => encodeSelector(selector, sessionUuid));
	return writer.finish();
}

/** Encode an `UpdateRequest` resizing a session's PTY. */
export function encodeUpdateRequest(sessionUuid: string, size: PtySize): Uint8Array {
	const writer = new Writer();
	writer.messageField(1, (selector) => encodeSelector(selector, sessionUuid));
	writer.messageField(2, (pty) => encodePtySize(pty, size, "pty"));
	return writer.finish();
}

/** Encode a `SendInputRequest` writing `data` to the session's stdin or PTY. */
export function encodeSendInputRequest(
	sessionUuid: string,
	channel: CommandInputChannel,
	data: Uint8Array,
	inputUuid: string,
): Uint8Array {
	if (!(data instanceof Uint8Array)) {
		throw new CommandSessionProtoError("invalid_input", "input data must be a Uint8Array");
	}
	if (channel !== "stdin" && channel !== "pty") {
		throw new CommandSessionProtoError("invalid_input", "input channel must be stdin or pty");
	}
	const writer = new Writer();
	writer.messageField(1, (selector) => encodeSelector(selector, sessionUuid));
	writer.messageField(2, (input) => {
		// CommandInput oneof: stdin = 1 (bytes), pty = 2 (bytes).
		input.bytesField(channel === "stdin" ? 1 : 2, data);
	});
	writer.stringField(3, canonicalUuidKey(inputUuid, "inputUuid"));
	return writer.finish();
}

/** Encode a `SendSignalRequest` delivering SIGTERM (`terminate`) or SIGKILL (`kill`). */
export function encodeSendSignalRequest(sessionUuid: string, signal: VmSignalName, signalUuid: string): Uint8Array {
	const value = VM_SIGNALS[signal];
	if (value === undefined) {
		throw new CommandSessionProtoError("invalid_input", "signal must be terminate or kill");
	}
	const writer = new Writer();
	writer.messageField(1, (selector) => encodeSelector(selector, sessionUuid));
	writer.varintField(2, value);
	writer.stringField(3, canonicalUuidKey(signalUuid, "signalUuid"));
	return writer.finish();
}

// ---------------------------------------------------------------------------
// Response decoding: the shared CommandSessionEvent envelope
// ---------------------------------------------------------------------------

/** Start event: the process's PID, re-announced on every (re)attach. */
export interface CommandSessionStartEvent {
	kind: "start";
	pid: number;
}

/** Data event: output bytes tagged by channel. */
export interface CommandSessionDataEvent {
	kind: "stdout" | "stderr" | "pty";
	data: Uint8Array;
}

/** End event: the terminal record, replayed for sessions retained after exit. */
export interface CommandSessionEndEvent {
	kind: "end";
	exitCode: number;
	exited: boolean;
	status: string;
	error?: string;
}

/** Keepalive: transport liveness ping; carries no process state. */
export interface CommandSessionKeepaliveEvent {
	kind: "keepalive";
}

export type CommandSessionEvent =
	| CommandSessionStartEvent
	| CommandSessionDataEvent
	| CommandSessionEndEvent
	| CommandSessionKeepaliveEvent;

function decodeEvent(reader: Reader, context: string): CommandSessionEvent {
	let start: CommandSessionStartEvent | undefined;
	let data: CommandSessionDataEvent | undefined;
	let end: CommandSessionEndEvent | undefined;
	let keepalive = false;
	while (!reader.eof) {
		const { field, wire } = reader.tag(context);
		switch (field) {
			case 1: {
				if (wire !== WIRE_LEN) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: start must be length-delimited`);
				}
				if (start !== undefined) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: duplicate oneof member start`);
				}
				start = decodeStartEvent(new Reader(reader.bytes(context)), `${context}.StartEvent`);
				break;
			}
			case 2: {
				if (wire !== WIRE_LEN) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: data must be length-delimited`);
				}
				if (data !== undefined) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: duplicate oneof member data`);
				}
				data = decodeDataEvent(new Reader(reader.bytes(context)), `${context}.DataEvent`);
				break;
			}
			case 3: {
				if (wire !== WIRE_LEN) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: end must be length-delimited`);
				}
				if (end !== undefined) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: duplicate oneof member end`);
				}
				end = decodeEndEvent(new Reader(reader.bytes(context)), `${context}.EndEvent`);
				break;
			}
			case 4: {
				if (wire !== WIRE_LEN) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: keepalive must be length-delimited`);
				}
				if (keepalive) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: duplicate oneof member keepalive`);
				}
				const body = reader.bytes(context); // KeepAlive is an empty message
				if (body.byteLength !== 0) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: keepalive body must be empty`);
				}
				keepalive = true;
				break;
			}
			default:
				reader.skip(wire, `${context}.event.${field}`);
		}
	}
	const memberCount =
		Number(start !== undefined) + Number(data !== undefined) + Number(end !== undefined) + Number(keepalive);
	if (memberCount !== 1) {
		throw new CommandSessionProtoError("invalid_wire", `${context}: expected exactly one event member`);
	}
	if (start !== undefined) {
		return start;
	}
	if (data !== undefined) {
		return data;
	}
	if (end !== undefined) {
		return end;
	}
	if (keepalive) {
		return { kind: "keepalive" };
	}
	throw new CommandSessionProtoError("invalid_wire", `${context}: no event member set`);
}

function decodeStartEvent(reader: Reader, context: string): CommandSessionStartEvent {
	let pid: number | undefined;
	while (!reader.eof) {
		const { field, wire } = reader.tag(context);
		if (field === 1) {
			if (wire !== WIRE_VARINT) {
				throw new CommandSessionProtoError("invalid_wire", `${context}: pid must be a varint`);
			}
			if (pid !== undefined) {
				throw new CommandSessionProtoError("invalid_wire", `${context}: duplicate pid`);
			}
			pid = reader.uint32(`${context}.pid`);
		} else {
			reader.skip(wire, `${context}.${field}`);
		}
	}
	return { kind: "start", pid: pid ?? 0 };
}

function decodeDataEvent(reader: Reader, context: string): CommandSessionDataEvent {
	let stdout: Uint8Array | undefined;
	let stderr: Uint8Array | undefined;
	let pty: Uint8Array | undefined;
	while (!reader.eof) {
		const { field, wire } = reader.tag(context);
		if (wire !== WIRE_LEN) {
			throw new CommandSessionProtoError("invalid_wire", `${context}: output members must be length-delimited`);
		}
		switch (field) {
			case 1:
				if (stdout !== undefined) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: duplicate oneof member stdout`);
				}
				stdout = reader.bytes(context);
				break;
			case 2:
				if (stderr !== undefined) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: duplicate oneof member stderr`);
				}
				stderr = reader.bytes(context);
				break;
			case 3:
				if (pty !== undefined) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: duplicate oneof member pty`);
				}
				pty = reader.bytes(context);
				break;
			default:
				reader.skip(wire, `${context}.${field}`);
		}
	}
	const memberCount = Number(stdout !== undefined) + Number(stderr !== undefined) + Number(pty !== undefined);
	if (memberCount !== 1) {
		throw new CommandSessionProtoError("invalid_wire", `${context}: expected exactly one output member`);
	}
	if (stdout !== undefined) return { kind: "stdout", data: stdout };
	if (stderr !== undefined) return { kind: "stderr", data: stderr };
	if (pty !== undefined) return { kind: "pty", data: pty };
	throw new CommandSessionProtoError("invalid_wire", `${context}: no output member set`);
}

function decodeEndEvent(reader: Reader, context: string): CommandSessionEndEvent {
	let exitCode: number | undefined;
	let exited: boolean | undefined;
	let status: string | undefined;
	let error: string | undefined;
	let errorSeen = false;
	while (!reader.eof) {
		const { field, wire } = reader.tag(context);
		switch (field) {
			case 1:
				if (wire !== WIRE_VARINT) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: exit_code must be a varint`);
				}
				exitCode = reader.sint32(`${context}.exit_code`);
				break;
			case 2:
				if (wire !== WIRE_VARINT) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: exited must be a varint`);
				}
				exited = reader.bool(`${context}.exited`);
				break;
			case 3:
				if (wire !== WIRE_LEN) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: status must be length-delimited`);
				}
				status = reader.string(`${context}.status`);
				break;
			case 4:
				if (wire !== WIRE_LEN) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: error must be length-delimited`);
				}
				error = reader.string(`${context}.error`);
				errorSeen = true;
				break;
			default:
				reader.skip(wire, `${context}.${field}`);
		}
	}
	if (exitCode === undefined || exited === undefined || status === undefined) {
		throw new CommandSessionProtoError("invalid_wire", `${context}: end event misses exit_code, exited, or status`);
	}
	const end: CommandSessionEndEvent = { kind: "end", exitCode, exited, status };
	if (errorSeen) {
		end.error = error;
	}
	return end;
}

/**
 * Decode a `StartResponse` or `ConnectResponse` body (they share the same
 * single `event` field). Returns `undefined` when the response carries no
 * event, which the stream consumer must skip. Throws
 * `CommandSessionProtoError("invalid_wire")` on malformed input.
 */
export function decodeCommandSessionEventResponse(body: Uint8Array, context: string): CommandSessionEvent | undefined {
	if (!(body instanceof Uint8Array)) {
		throw new CommandSessionProtoError("invalid_wire", `${context}: response body must be bytes`);
	}
	const reader = new Reader(body);
	let event: CommandSessionEvent | undefined;
	while (!reader.eof) {
		const { field, wire } = reader.tag(context);
		switch (field) {
			case 1: {
				if (wire !== WIRE_LEN) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: event must be length-delimited`);
				}
				if (event !== undefined) {
					throw new CommandSessionProtoError("invalid_wire", `${context}: duplicate event field`);
				}
				event = decodeEvent(new Reader(reader.bytes(context)), `${context}.CommandSessionEvent`);
				break;
			}
			default:
				reader.skip(wire, `${context}.${field}`);
		}
	}
	return event;
}

// ---------------------------------------------------------------------------
// Connect frame envelope (server-streaming request and response bodies)
// ---------------------------------------------------------------------------

/** End-of-stream flag on a Connect frame (JSON EndStreamResponse payload). */
export const CONNECT_FRAME_END_OF_STREAM = 0x02;
/** Compression flag on a Connect frame; never negotiated by this client. */
export const CONNECT_FRAME_COMPRESSED = 0x01;

/** Envelope one message payload for a Connect streaming request body. */
export function encodeConnectFrame(payload: Uint8Array, flags = 0): Uint8Array {
	const header = new Uint8Array(5);
	header[0] = flags;
	const length = payload.byteLength;
	header[1] = (length >>> 24) & 0xff;
	header[2] = (length >>> 16) & 0xff;
	header[3] = (length >>> 8) & 0xff;
	header[4] = length & 0xff;
	const out = new Uint8Array(5 + length);
	out.set(header, 0);
	out.set(payload, 5);
	return out;
}

/** Incremental Connect frame decoder fed with response body chunks. */
export class ConnectFrameDecoder {
	private buffer: Uint8Array = new Uint8Array(0);
	private readonly maxFrameBytes: number;

	constructor(maxFrameBytes: number) {
		if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1) {
			throw new CommandSessionProtoError("invalid_input", "maxFrameBytes must be a positive integer");
		}
		this.maxFrameBytes = maxFrameBytes;
	}

	/** Bytes buffered while waiting for a complete frame header and body. */
	get bufferedByteLength(): number {
		return this.buffer.byteLength;
	}

	/** Append a response body chunk. */
	push(chunk: Uint8Array): void {
		if (!(chunk instanceof Uint8Array)) {
			throw new CommandSessionProtoError("invalid_wire", "frame decoder accepts byte chunks only");
		}
		if (chunk.byteLength === 0) return;
		const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
		merged.set(this.buffer, 0);
		merged.set(chunk, this.buffer.byteLength);
		this.buffer = merged;
	}

	/**
	 * Pop the next complete frame, or `null` while more bytes are needed. A
	 * frame larger than the bound throws `OversizeConnectFrameError`.
	 */
	next(): { flags: number; payload: Uint8Array } | null {
		if (this.buffer.byteLength < 5) {
			return null;
		}
		const flags = this.buffer[0];
		const length = (this.buffer[1] << 24) | (this.buffer[2] << 16) | (this.buffer[3] << 8) | this.buffer[4];
		if (length < 0) {
			throw new CommandSessionProtoError("invalid_wire", "Connect frame length exceeds 32 bits");
		}
		if (length > this.maxFrameBytes) {
			throw new OversizeConnectFrameError(this.maxFrameBytes, length);
		}
		if (this.buffer.byteLength < 5 + length) {
			return null;
		}
		const payload = this.buffer.slice(5, 5 + length);
		this.buffer = this.buffer.slice(5 + length);
		return { flags, payload };
	}
}
