import { constants, type Dir, type Dirent, type Stats } from "node:fs";
import { type FileHandle, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { types } from "node:util";

import { digestsEqual, isValidDigest } from "./remote-host-frame-codec.js";

// ===========================================================================
// Public types
// ===========================================================================

export type TranscriptEvidence = "exact" | "mismatch" | "absent";

export type SearchSessionTranscriptResult =
	| Readonly<{ ok: true; value: TranscriptEvidence }>
	| Readonly<{ ok: false; error: Readonly<{ code: "INVALID_ARGUMENT" | "SCAN_UNCERTAIN" }> }>;

// ===========================================================================
// Constants
// ===========================================================================

const AGENT_MESSAGE_CUSTOM_TYPE = "agent_message";
const MAX_ENTRIES = 4096;
const MAX_AGGREGATE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_SESSION_DIR_LENGTH = 4096;

const INPUT_KEYS: ReadonlySet<string> = new Set(["sessionDir", "sessionId", "messageId", "semanticDigest"]);

// ===========================================================================
// Printable ASCII check: char codes 32-126 inclusive
// ===========================================================================

function isPrintableAscii(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code < 32 || code > 126) return false;
	}
	return true;
}

// ===========================================================================
// Input types
// ===========================================================================

interface ExactInput {
	sessionDir: string;
	sessionId: string;
	messageId: string;
	semanticDigest: string;
}

type ExactInputResult =
	| Readonly<{ ok: true; value: ExactInput }>
	| Readonly<{ ok: false; error: Readonly<{ code: "INVALID_ARGUMENT" }> }>;

// ===========================================================================
// Synchronous input validation and extraction.
//
// Rejects: non-object, null, Proxy, non-Object.prototype, symbols,
// accessor/non-enumerable/missing/value props, extra/missing keys,
// non-string/bounds/format violations.
// Copies descriptor.value fields after type guards - no `as` assertions.
// ===========================================================================

function exactInput(raw: unknown): ExactInputResult {
	if (typeof raw !== "object" || raw === null) {
		return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
	}

	let descriptorsRet: PropertyDescriptorMap;
	try {
		if (types.isProxy(raw)) {
			return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
		}
		descriptorsRet = Object.getOwnPropertyDescriptors(raw);
		const syms = Object.getOwnPropertySymbols(raw);
		if (syms.length !== 0) {
			return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
		}
		const proto = Object.getPrototypeOf(raw);
		if (proto !== Object.prototype) {
			return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
		}
	} catch {
		return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
	}

	const names = Object.getOwnPropertyNames(descriptorsRet);
	if (names.length !== INPUT_KEYS.size) {
		return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
	}

	const vals: Record<string, unknown> = {};
	for (const name of names) {
		if (!INPUT_KEYS.has(name)) {
			return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
		}
		const desc = descriptorsRet[name];
		if (desc === undefined || !("value" in desc) || !desc.enumerable) {
			return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
		}
		vals[name] = desc.value;
	}

	const sessionDir = vals.sessionDir;
	const sessionId = vals.sessionId;
	const messageId = vals.messageId;
	const semanticDigest = vals.semanticDigest;

	if (typeof sessionDir !== "string" || sessionDir.length === 0) {
		return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
	}
	if (sessionDir.length > MAX_SESSION_DIR_LENGTH) {
		return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
	}
	if (sessionDir.includes("\0")) {
		return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
	}
	if (
		typeof sessionId !== "string" ||
		sessionId.length === 0 ||
		sessionId.length > 128 ||
		!isPrintableAscii(sessionId)
	) {
		return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
	}
	if (
		typeof messageId !== "string" ||
		messageId.length === 0 ||
		messageId.length > 128 ||
		!isPrintableAscii(messageId)
	) {
		return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
	}
	if (typeof semanticDigest !== "string" || !isValidDigest(semanticDigest)) {
		return { ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) };
	}

	return {
		ok: true,
		value: { sessionDir, sessionId, messageId, semanticDigest },
	};
}

// ===========================================================================
// Plain-object guard for parsed JSON records
// ===========================================================================

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	let proto: object | null;
	try {
		proto = Object.getPrototypeOf(value);
	} catch {
		return false;
	}
	if (proto !== null && proto !== Object.prototype) return false;
	const symbols = Object.getOwnPropertySymbols(value);
	if (symbols.length !== 0) return false;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Object.getOwnPropertyNames(value);
	for (const key of keys) {
		const desc = descriptors[key];
		if (desc === undefined) return false;
		if (!("value" in desc) || !desc.enumerable) return false;
	}
	return true;
}

// ===========================================================================
// Raw UTF-8 byte comparison for deterministic filename ordering
// ===========================================================================

function compareRawUtf8(a: string, b: string): number {
	const bufA = Buffer.from(a, "utf-8");
	const bufB = Buffer.from(b, "utf-8");
	const len = Math.min(bufA.length, bufB.length);
	for (let i = 0; i < len; i++) {
		if (bufA[i] !== bufB[i]) return bufA[i] - bufB[i];
	}
	return bufA.length - bufB.length;
}

// ===========================================================================
// Stats check: regular file, not a symlink (matched by O_NOFOLLOW at open),
// nlink === 1 (no extra hardlinks).
// ===========================================================================

function isRegularSingleLink(stats: Stats): boolean {
	return stats.isFile() && stats.nlink === 1;
}

function statsUnchanged(a: Stats, b: Stats): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.uid === b.uid &&
		a.mode === b.mode &&
		a.size === b.size &&
		a.nlink === b.nlink &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs
	);
}

// ===========================================================================
// UTF-8 validation - check that a buffer is valid UTF-8
// ===========================================================================

function isValidUtf8(buffer: Buffer): boolean {
	try {
		const decoded = buffer.toString("utf-8");
		const reencoded = Buffer.from(decoded, "utf-8");
		return reencoded.equals(buffer);
	} catch {
		return false;
	}
}

// ===========================================================================
// Read entire file contents into an exact-size buffer.
//
// Allocate one buffer of `size` bytes. Loop reading chunks into it at
// the appropriate offset. If any read returns 0 bytes before reaching
// `size`, return null (short read). After filling, do a 1-byte read at
// `size` offset to confirm EOF (must return 0).
//
// On any failure, zero the buffer before returning null.
// ===========================================================================

async function readFileContents(handle: FileHandle, size: number): Promise<Buffer | null> {
	const data = Buffer.allocUnsafe(size);
	let ok = false;
	try {
		let position = 0;
		while (position < size) {
			const remaining = size - position;
			const chunkSize = Math.min(READ_CHUNK_BYTES, remaining);
			let bytesRead: number;
			try {
				const result = await handle.read(data, position, chunkSize, position);
				bytesRead = result.bytesRead;
			} catch {
				return null;
			}
			if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > chunkSize) {
				return null;
			}
			position += bytesRead;
		}

		// Confirm EOF: one byte at expected end must read 0
		const eofBuf = Buffer.alloc(1);
		let eofBytesRead: number;
		try {
			const eofResult = await handle.read(eofBuf, 0, 1, size);
			eofBytesRead = eofResult.bytesRead;
		} catch {
			return null;
		} finally {
			eofBuf.fill(0);
		}
		if (eofBytesRead !== 0) {
			return null;
		}

		ok = true;
		return data;
	} finally {
		if (!ok && data.byteLength > 0) {
			try {
				data.fill(0);
			} catch {
				// Swallow erase failure
			}
		}
	}
}

// ===========================================================================
// Split a buffer on newlines, preserving all content.
// Returns an array of line buffers, and a flag for trailing partial line.
// ===========================================================================

interface SplitResult {
	lines: Buffer[];
	hasPartial: boolean;
}

function splitLines(data: Buffer): SplitResult {
	const lines: Buffer[] = [];
	let start = 0;
	for (let i = 0; i < data.length; i++) {
		if (data[i] === 0x0a) {
			lines.push(data.subarray(start, i));
			start = i + 1;
		}
	}
	const hasPartial = start < data.length;
	if (!hasPartial) {
		return { lines, hasPartial: false };
	}
	let end = data.length;
	if (end > start && data[end - 1] === 0x0d) {
		end = end - 1;
	}
	const trailing = data.subarray(start, end);
	if (trailing.length > 0) {
		lines.push(trailing);
		return { lines, hasPartial: true };
	}
	return { lines, hasPartial: false };
}

// ===========================================================================
// Validate and parse a single JSONL line buffer.
// Returns null on invalid JSON or empty line.
// ===========================================================================

function parseJsonLine(line: Buffer): unknown | null {
	if (line.length === 0) return null;
	try {
		const text = line.toString("utf-8");
		const parsed = JSON.parse(text);
		return parsed;
	} catch {
		return null;
	}
}

// ===========================================================================
// Scan one file's contents for session header and matching messages.
//
// Returns:
//   "UNCERTAIN" - file caused uncertainty (I/O, malformed, etc.)
//   TranscriptEvidence - evidence from this file alone
//
// Dominance within one file: uncertainty > mismatch > exact > absent.
// So we do not short-circuit on mismatch; we continue scanning, and
// return uncertainty if any later record is malformed.
// ===========================================================================

type FileScanResult = TranscriptEvidence | "UNCERTAIN";

function scanFileContents(data: Buffer, targetSessionId: string, messageId: string, digest: string): FileScanResult {
	if (data.length === 0) {
		return "UNCERTAIN";
	}

	if (!isValidUtf8(data)) {
		return "UNCERTAIN";
	}

	const { lines, hasPartial } = splitLines(data);

	if (hasPartial) {
		return "UNCERTAIN";
	}

	if (lines.length === 0) {
		return "UNCERTAIN";
	}

	const firstRaw = parseJsonLine(lines[0]);
	if (firstRaw === null) {
		return "UNCERTAIN";
	}
	if (!isPlainObjectRecord(firstRaw)) {
		return "UNCERTAIN";
	}
	if (firstRaw.type !== "session") {
		return "UNCERTAIN";
	}
	if (typeof firstRaw.id !== "string") {
		return "UNCERTAIN";
	}

	const sessionId = firstRaw.id;

	if (sessionId !== targetSessionId) {
		return "absent";
	}

	let evidence: TranscriptEvidence = "absent";

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		const record = parseJsonLine(line);
		if (record === null) {
			return "UNCERTAIN";
		}
		if (!isPlainObjectRecord(record)) {
			return "UNCERTAIN";
		}
		if (record.type !== "message") {
			continue;
		}
		const message = record.message;
		if (typeof message !== "object" || message === null) {
			return "UNCERTAIN";
		}
		if (Array.isArray(message)) {
			return "UNCERTAIN";
		}
		if (!isPlainObjectRecord(message)) {
			return "UNCERTAIN";
		}
		if (message.role !== "custom" || message.customType !== AGENT_MESSAGE_CUSTOM_TYPE) {
			continue;
		}
		const details = message.details;
		if (typeof details !== "object" || details === null || Array.isArray(details)) {
			return "UNCERTAIN";
		}
		if (!isPlainObjectRecord(details)) {
			return "UNCERTAIN";
		}
		if (details.id !== messageId) {
			continue;
		}

		const storedDigest = details.semanticDigest;
		if (typeof storedDigest !== "string") {
			evidence = "mismatch";
			continue;
		}

		if (!isValidDigest(storedDigest)) {
			evidence = "mismatch";
			continue;
		}

		if (!digestsEqual(storedDigest, digest)) {
			evidence = "mismatch";
			continue;
		}

		if (evidence !== "mismatch") {
			evidence = "exact";
		}
	}

	return evidence;
}

// ===========================================================================
// Directory scanner.
//
// Uses manual dir.read() loop (not for-await) so close() is explicit
// and its outcome is checked. Closes in a finally on every path.
// Close uncertainty dominates - return UNCERTAIN.
//
// Counts ALL directory entries, not only JSONL. Bounds at MAX_ENTRIES+1.
// Only .jsonl regular files are returned; any non-file .jsonl is UNCERTAIN.
// Non-.jsonl regular files are silently ignored (but counted).
// ===========================================================================

interface JsonlEntry {
	name: string;
}

async function enumerateSessionFiles(sessionDir: string): Promise<JsonlEntry[] | "UNCERTAIN"> {
	let dir: Dir;
	try {
		dir = await opendir(sessionDir);
	} catch {
		return "UNCERTAIN";
	}

	const entries: JsonlEntry[] = [];
	let totalEntries = 0;
	let result: JsonlEntry[] | "UNCERTAIN" = entries;

	try {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			let dirent: Dirent | null;
			try {
				dirent = await dir.read();
			} catch {
				result = "UNCERTAIN";
				break;
			}
			if (dirent === null) {
				// End of directory
				break;
			}
			totalEntries++;
			if (totalEntries > MAX_ENTRIES) {
				result = "UNCERTAIN";
				break;
			}
			if (!dirent.name.endsWith(".jsonl")) {
				continue;
			}
			if (!dirent.isFile()) {
				result = "UNCERTAIN";
				break;
			}
			entries.push({ name: dirent.name });
		}
	} finally {
		try {
			await dir.close();
		} catch {
			result = "UNCERTAIN";
		}
	}

	if (result === "UNCERTAIN") {
		return "UNCERTAIN";
	}

	entries.sort((a, b) => compareRawUtf8(a.name, b.name));

	return entries;
}

// ===========================================================================
// Process a single file: open, fstat, read, revalidate, close, parse.
//
// `remainingBudget` is the aggregate bytes left before MAX_AGGREGATE_BYTES.
// After fstat, if size exceeds remainingBudget, close and return uncertain.
// This avoids TOCTOU with a separate stat open.
// ===========================================================================

interface ProcessFileResult {
	evidence: FileScanResult;
	fileSize: number;
}

async function processJsonlFile(
	filePath: string,
	targetSessionId: string,
	messageId: string,
	digest: string,
	remainingBudget: number,
): Promise<ProcessFileResult | "UNCERTAIN"> {
	let handle: FileHandle;
	try {
		handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return "UNCERTAIN";
	}

	let closeConsumed = false;
	const closeOnce = async (): Promise<boolean> => {
		if (closeConsumed) return false;
		closeConsumed = true;
		try {
			await handle.close();
			return true;
		} catch {
			return false;
		}
	};

	let data: Buffer | null = null;
	let fileSize = 0;
	let readyToScan = false;
	try {
		const preStats = await handle.stat();
		if (
			isRegularSingleLink(preStats) &&
			Number.isSafeInteger(preStats.size) &&
			preStats.size >= 0 &&
			preStats.size <= MAX_FILE_BYTES &&
			preStats.size <= remainingBudget
		) {
			fileSize = preStats.size;
			data = await readFileContents(handle, preStats.size);
			if (data !== null) {
				const postStats = await handle.stat();
				readyToScan = statsUnchanged(preStats, postStats);
			}
		}
	} catch {
		readyToScan = false;
	}

	const closeOk = await closeOnce();
	if (!closeOk || !readyToScan || data === null) {
		if (data !== null && data.byteLength > 0) data.fill(0);
		return "UNCERTAIN";
	}

	try {
		return {
			evidence: scanFileContents(data, targetSessionId, messageId, digest),
			fileSize,
		};
	} catch {
		return "UNCERTAIN";
	} finally {
		if (data.byteLength > 0) data.fill(0);
	}
}

// ===========================================================================
// Aggregate evidence across files.
//
// - Any "UNCERTAIN" - SCAN_UNCERTAIN
// - Any "mismatch" dominates "exact" and "absent"
// - Any "exact" dominates "absent"
// - All "absent" - "absent"
// ===========================================================================

function aggregateEvidence(fileResults: ProcessFileResult[]): SearchSessionTranscriptResult {
	let evidence: TranscriptEvidence = "absent";

	for (const fr of fileResults) {
		if (fr.evidence === "UNCERTAIN") {
			return Object.freeze({
				ok: false,
				error: Object.freeze({ code: "SCAN_UNCERTAIN" }),
			});
		}
		if (fr.evidence === "mismatch") {
			evidence = "mismatch";
		} else if (fr.evidence === "exact" && evidence !== "mismatch") {
			evidence = "exact";
		}
	}

	return Object.freeze({
		ok: true,
		value: evidence,
	});
}

// ===========================================================================
// Public entry point
// ===========================================================================

export async function searchSessionTranscript(raw: unknown): Promise<SearchSessionTranscriptResult> {
	const inputResult = exactInput(raw);
	if (!inputResult.ok) {
		return Object.freeze({
			ok: false,
			error: inputResult.error,
		});
	}

	const input = inputResult.value;

	const entries = await enumerateSessionFiles(input.sessionDir);
	if (entries === "UNCERTAIN") {
		return Object.freeze({
			ok: false,
			error: Object.freeze({ code: "SCAN_UNCERTAIN" }),
		});
	}

	const fileResults: ProcessFileResult[] = [];
	let aggregateBytes = 0;

	for (const entry of entries) {
		const filePath = join(input.sessionDir, entry.name);
		const remaining = MAX_AGGREGATE_BYTES - aggregateBytes;

		const result = await processJsonlFile(
			filePath,
			input.sessionId,
			input.messageId,
			input.semanticDigest,
			remaining,
		);
		if (result === "UNCERTAIN") {
			return Object.freeze({
				ok: false,
				error: Object.freeze({ code: "SCAN_UNCERTAIN" }),
			});
		}
		aggregateBytes += result.fileSize;
		fileResults.push(result);
	}

	return aggregateEvidence(fileResults);
}
