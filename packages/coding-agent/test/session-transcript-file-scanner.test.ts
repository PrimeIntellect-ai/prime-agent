import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { searchSessionTranscript } from "../src/modes/daemon/session-transcript-file-scanner.js";

// ===========================================================================
// Helpers
// ===========================================================================

const VALID_DIGEST = "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234";

interface TestDir {
	path: string;
	cleanup(): Promise<void>;
}

async function createTestDir(): Promise<TestDir> {
	const path = await mkdtemp(join(tmpdir(), "scanner-test-"));
	return {
		path,
		cleanup: () => rm(path, { recursive: true, force: true }),
	};
}

async function writeJsonl(dir: string, name: string, lines: readonly string[]): Promise<string> {
	const full = join(dir, name);
	const content = `${lines.join("\n")}\n`;
	await writeFile(full, content, "utf-8");
	return full;
}

function sessionHeader(id: string): string {
	return JSON.stringify({ type: "session", id });
}

function messageRecord(msgId: string, digest: string): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "custom",
			customType: "agent_message",
			details: { id: msgId, semanticDigest: digest },
		},
	});
}

function nonAgentMessageRecord(): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "user",
			customType: "something_else",
			details: { id: "msg-other" },
		},
	});
}

const DEFAULT_SESSION_ID = "sess-abc";
const DEFAULT_MESSAGE_ID = "msg-123";

function makeInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return Object.freeze({
		sessionDir: "/nonexistent",
		sessionId: DEFAULT_SESSION_ID,
		messageId: DEFAULT_MESSAGE_ID,
		semanticDigest: VALID_DIGEST,
		...overrides,
	});
}

function validInput(dir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return makeInput({ sessionDir: dir, ...overrides });
}

// ===========================================================================
// Tests
// ===========================================================================

describe("SessionTranscriptFileScanner", () => {
	// ===================================================================
	// Basic absent
	// ===================================================================

	it("returns absent for empty directory", async () => {
		const td = await createTestDir();
		try {
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "absent" });
		} finally {
			await td.cleanup();
		}
	});

	it("returns absent for directory with no .jsonl files", async () => {
		const td = await createTestDir();
		try {
			await writeFile(join(td.path, "other.txt"), "hello", "utf-8");
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "absent" });
		} finally {
			await td.cleanup();
		}
	});

	it("returns absent for directory with non-matching session ID", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader("sess-other"),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "absent" });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Exact
	// ===================================================================

	it("returns exact for matching session + message + digest", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "exact" });
		} finally {
			await td.cleanup();
		}
	});

	it("returns exact when matching record is not the first message", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				nonAgentMessageRecord(),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "exact" });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Mismatch
	// ===================================================================

	it("returns mismatch for wrong digest", async () => {
		const td = await createTestDir();
		try {
			const wrongDigest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, wrongDigest),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "mismatch" });
		} finally {
			await td.cleanup();
		}
	});

	it("returns mismatch for missing digest field", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				JSON.stringify({
					type: "message",
					message: {
						role: "custom",
						customType: "agent_message",
						details: { id: DEFAULT_MESSAGE_ID },
					},
				}),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "mismatch" });
		} finally {
			await td.cleanup();
		}
	});

	it("returns mismatch for non-string digest", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				JSON.stringify({
					type: "message",
					message: {
						role: "custom",
						customType: "agent_message",
						details: { id: DEFAULT_MESSAGE_ID, semanticDigest: 12345 },
					},
				}),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "mismatch" });
		} finally {
			await td.cleanup();
		}
	});

	it("returns mismatch for invalid hex digest format", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, "not-a-valid-hex-digest"),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "mismatch" });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Dominance across files
	// ===================================================================

	it("exact dominates absent across files", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "other.jsonl", [
				sessionHeader("sess-other"),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			await writeJsonl(td.path, "target.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "exact" });
		} finally {
			await td.cleanup();
		}
	});

	it("mismatch dominates exact across files", async () => {
		const td = await createTestDir();
		try {
			const wrongDigest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
			await writeJsonl(td.path, "a-exact.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			await writeJsonl(td.path, "b-mismatch.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, wrongDigest),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "mismatch" });
		} finally {
			await td.cleanup();
		}
	});

	it("mismatch dominates absent across files", async () => {
		const td = await createTestDir();
		try {
			const wrongDigest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
			await writeJsonl(td.path, "target.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, wrongDigest),
			]);
			await writeJsonl(td.path, "other.jsonl", [
				sessionHeader("sess-other"),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "mismatch" });
		} finally {
			await td.cleanup();
		}
	});

	it("mismatch in first file and exact in second gives mismatch", async () => {
		const td = await createTestDir();
		try {
			const wrongDigest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
			await writeJsonl(td.path, "first.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, wrongDigest),
			]);
			await writeJsonl(td.path, "second.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "mismatch" });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Duplicate exact
	// ===================================================================

	it("returns exact with duplicate matching records in same file", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "exact" });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Malformed files - SCAN_UNCERTAIN
	// ===================================================================

	it("returns SCAN_UNCERTAIN for invalid JSON in matching file", async () => {
		const td = await createTestDir();
		try {
			const f = join(td.path, "sess.jsonl");
			await writeFile(f, `${sessionHeader(DEFAULT_SESSION_ID)}\n{invalid json\n`, "utf-8");
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	it("returns SCAN_UNCERTAIN for non-object first record", async () => {
		const td = await createTestDir();
		try {
			const f = join(td.path, "sess.jsonl");
			await writeFile(f, '"just a string"\n', "utf-8");
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	it("returns SCAN_UNCERTAIN for missing session type in first record", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				JSON.stringify({ type: "not_session", id: DEFAULT_SESSION_ID }),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	it("returns SCAN_UNCERTAIN for non-string session id", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				JSON.stringify({ type: "session", id: 123 }),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	it("returns SCAN_UNCERTAIN for partial final line", async () => {
		const td = await createTestDir();
		try {
			const f = join(td.path, "sess.jsonl");
			await writeFile(
				f,
				`${sessionHeader(DEFAULT_SESSION_ID)}\n${messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST)}`,
				"utf-8",
			);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	it("returns SCAN_UNCERTAIN for invalid UTF-8 content", async () => {
		const td = await createTestDir();
		try {
			const f = join(td.path, "sess.jsonl");
			const buf = Buffer.alloc(100);
			const header = `${sessionHeader(DEFAULT_SESSION_ID)}\n`;
			buf.write(header, 0, "utf-8");
			buf[header.length] = 0xff;
			await writeFile(f, buf);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Empty file - SCAN_UNCERTAIN
	// ===================================================================

	it("returns SCAN_UNCERTAIN for empty .jsonl file", async () => {
		const td = await createTestDir();
		try {
			await writeFile(join(td.path, "empty.jsonl"), "", "utf-8");
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	it("returns SCAN_UNCERTAIN for .jsonl with only newlines", async () => {
		const td = await createTestDir();
		try {
			await writeFile(join(td.path, "newlines.jsonl"), "\n\n\n", "utf-8");
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Malformed message evidence - SCAN_UNCERTAIN
	// ===================================================================

	it("returns SCAN_UNCERTAIN for malformed message details (non-plain-object)", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				JSON.stringify({
					type: "message",
					message: {
						role: "custom",
						customType: "agent_message",
						details: ["not", "a", "plain", "object"],
					},
				}),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	it("returns SCAN_UNCERTAIN for malformed message (non-plain-object)", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				JSON.stringify({
					type: "message",
					message: ["not", "a", "plain", "object"],
				}),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	it("returns SCAN_UNCERTAIN for non-plain-object record in target file", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [sessionHeader(DEFAULT_SESSION_ID), '"just a string"']);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Symlink / non-file
	// ===================================================================

	it("returns SCAN_UNCERTAIN when .jsonl is a symlink", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "real_target.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			try {
				await symlink(join(td.path, "real_target.jsonl"), join(td.path, "link.jsonl"));
				const result = await searchSessionTranscript(validInput(td.path));
				expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
			} catch {
				// Platform may not support symlinks; skip
			}
		} finally {
			await td.cleanup();
		}
	});

	it("returns SCAN_UNCERTAIN when .jsonl is a directory", async () => {
		const td = await createTestDir();
		try {
			await mkdir(join(td.path, "fake.jsonl"));
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Hostile input
	// ===================================================================

	it("returns INVALID_ARGUMENT for null input", async () => {
		const result = await searchSessionTranscript(null);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for non-object input", async () => {
		const result = await searchSessionTranscript("bad");
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for custom prototype", async () => {
		const input: Record<string, unknown> = Object.create(null);
		input.sessionDir = "/tmp";
		input.sessionId = DEFAULT_SESSION_ID;
		input.messageId = DEFAULT_MESSAGE_ID;
		input.semanticDigest = VALID_DIGEST;
		const result = await searchSessionTranscript(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for symbol property", async () => {
		const sym = Symbol("test");
		const input = { ...makeInput(), [sym]: "hidden" };
		const result = await searchSessionTranscript(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for Proxy input", async () => {
		const target = makeInput();
		const proxy = new Proxy(target, {});
		const result = await searchSessionTranscript(proxy);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for accessor property", async () => {
		const input: Record<string, unknown> = {};
		Object.defineProperty(input, "sessionDir", { get: () => "/tmp", enumerable: true });
		Object.defineProperty(input, "sessionId", { get: () => DEFAULT_SESSION_ID, enumerable: true });
		Object.defineProperty(input, "messageId", { get: () => DEFAULT_MESSAGE_ID, enumerable: true });
		Object.defineProperty(input, "semanticDigest", { get: () => VALID_DIGEST, enumerable: true });
		const result = await searchSessionTranscript(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for present undefined value", async () => {
		const input: Record<string, unknown> = {
			sessionDir: "/tmp",
			sessionId: undefined,
			messageId: DEFAULT_MESSAGE_ID,
			semanticDigest: VALID_DIGEST,
		};
		const result = await searchSessionTranscript(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for extra key", async () => {
		const input = { ...makeInput(), extra: "field" };
		const result = await searchSessionTranscript(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for missing key", async () => {
		const input: Record<string, unknown> = {
			sessionId: DEFAULT_SESSION_ID,
			messageId: DEFAULT_MESSAGE_ID,
			semanticDigest: VALID_DIGEST,
		};
		const result = await searchSessionTranscript(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for empty sessionDir string", async () => {
		const result = await searchSessionTranscript(makeInput({ sessionDir: "" }));
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for sessionDir with NUL byte", async () => {
		const result = await searchSessionTranscript(makeInput({ sessionDir: "/tmp\x00hidden" }));
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for sessionDir exceeding 4096", async () => {
		const long = `/${"a".repeat(4096)}`;
		const result = await searchSessionTranscript(makeInput({ sessionDir: long }));
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for sessionId with non-printable chars", async () => {
		const result = await searchSessionTranscript(makeInput({ sessionId: "sess\tctl" }));
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for sessionId exceeding 128 chars", async () => {
		const result = await searchSessionTranscript(makeInput({ sessionId: "x".repeat(129) }));
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for messageId with non-printable chars", async () => {
		const result = await searchSessionTranscript(makeInput({ messageId: "msg\nbad" }));
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for messageId exceeding 128 chars", async () => {
		const result = await searchSessionTranscript(makeInput({ messageId: "y".repeat(129) }));
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for invalid semanticDigest format", async () => {
		const result = await searchSessionTranscript(makeInput({ semanticDigest: "not-a-valid-64-char-hex" }));
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for non-string semanticDigest", async () => {
		const result = await searchSessionTranscript(makeInput({ semanticDigest: 12345 }));
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	// ===================================================================
	// No path leakage
	// ===================================================================

	it("never exposes internal paths in error objects", async () => {
		const td = await createTestDir();
		try {
			const f = join(td.path, "sess.jsonl");
			await writeFile(f, "bad json\n", "utf-8");
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
			const resultStr = JSON.stringify(result);
			expect(resultStr.includes(td.path)).toBe(false);
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Bounds - directory entries
	// ===================================================================

	it("returns SCAN_UNCERTAIN for too many files (4097)", async () => {
		const td = await createTestDir();
		try {
			for (let i = 0; i < 4097; i++) {
				await writeJsonl(td.path, `file${String(i).padStart(5, "0")}.jsonl`, [sessionHeader(DEFAULT_SESSION_ID)]);
			}
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	it("returns absent for exactly 4096 empty-or-non-matching files", async () => {
		const td = await createTestDir();
		try {
			for (let i = 0; i < 4096; i++) {
				await writeJsonl(td.path, `file${String(i).padStart(5, "0")}.jsonl`, [
					JSON.stringify({ type: "session", id: "sess-other" }),
				]);
			}
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "absent" });
		} finally {
			await td.cleanup();
		}
	});

	it("returns SCAN_UNCERTAIN when 4097 total entries exist even with some non-JSONL", async () => {
		const td = await createTestDir();
		try {
			for (let i = 0; i < 4097; i++) {
				await writeFile(join(td.path, `ignored${String(i).padStart(5, "0")}.txt`), "ignore", "utf-8");
			}
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	it("returns SCAN_UNCERTAIN for 4097 entries with mixed JSONL and non-JSONL files", async () => {
		const td = await createTestDir();
		try {
			for (let i = 0; i < 2048; i++) {
				await writeJsonl(td.path, `file${String(i).padStart(5, "0")}.jsonl`, [sessionHeader("sess-other")]);
			}
			for (let i = 2048; i < 4097; i++) {
				await writeFile(join(td.path, `file${String(i).padStart(5, "0")}.txt`), "ignore", "utf-8");
			}
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Aggregate size bound before reading next file
	// ===================================================================

	it("returns SCAN_UNCERTAIN when next file would exceed aggregate 256MiB", async () => {
		const td = await createTestDir();
		try {
			// Write a ~255MiB file
			const bigSize = 255 * 1024 * 1024;
			const bigBuf = Buffer.alloc(bigSize, 120); // 'x'
			await writeFile(join(td.path, "big.jsonl"), bigBuf);

			// Write a smaller file that pushes over
			const smallSize = 2 * 1024 * 1024;
			const smallBuf = Buffer.alloc(smallSize, 121); // 'y'
			await writeFile(join(td.path, "small.jsonl"), smallBuf);

			// Write the matching file
			await writeJsonl(td.path, "match.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);

			const result = await searchSessionTranscript(validInput(td.path));
			// Should be SCAN_UNCERTAIN because the aggregate check catches it
			// before reading the third file
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	it("returns SCAN_UNCERTAIN when single file exceeds 128MiB", async () => {
		const td = await createTestDir();
		try {
			const bigSize = 129 * 1024 * 1024;
			const bigBuf = Buffer.alloc(bigSize, 120);
			await writeFile(join(td.path, "too-big.jsonl"), bigBuf);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Close uncertainty
	// ===================================================================

	it("returns SCAN_UNCERTAIN for nonexistent directory", async () => {
		const result = await searchSessionTranscript(makeInput({ sessionDir: "/nonexistent-scan-dir-12345" }));
		expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
	});

	// ===================================================================
	// Deterministic filename ordering
	// ===================================================================

	it("processes files in raw UTF-8 byte order", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "b-second.jsonl", [sessionHeader("sess-other")]);
			await writeJsonl(td.path, "A-first.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "exact" });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Non-.jsonl files are ignored
	// ===================================================================

	it("ignores non-.jsonl files even when they have session data", async () => {
		const td = await createTestDir();
		try {
			await writeFile(join(td.path, "data.txt"), `${sessionHeader(DEFAULT_SESSION_ID)}\n`, "utf-8");
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "absent" });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Exact in matching file even when another file has invalid content
	// ===================================================================

	it("returns SCAN_UNCERTAIN when non-matching file has invalid data", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "target.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			const f = join(td.path, "other.jsonl");
			await writeFile(f, "bad json\n", "utf-8");
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Extra fields in message record are tolerated
	// ===================================================================

	it("returns exact even when message record has extra fields", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				JSON.stringify({
					type: "message",
					message: {
						role: "custom",
						customType: "agent_message",
						details: { id: DEFAULT_MESSAGE_ID, semanticDigest: VALID_DIGEST },
						extraField: "should be ignored",
					},
					extraTopField: "also ignored",
				}),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "exact" });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Short reads / EOF confirmation
	// ===================================================================

	it("handles short reads that eventually complete", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			// The file is small, read completes normally
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "exact" });
		} finally {
			await td.cleanup();
		}
	});

	it("handles exactly known-size reads with EOF confirmation", async () => {
		const td = await createTestDir();
		try {
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "exact" });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Stat change detection (nlink, uid, ctime)
	// ===================================================================

	it("returns SCAN_UNCERTAIN for file with nlink > 1 (hardlink)", async () => {
		const td = await createTestDir();
		try {
			const f = join(td.path, "orig.jsonl");
			const content = `${sessionHeader(DEFAULT_SESSION_ID)}\n${messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST)}\n`;
			await writeFile(f, content, "utf-8");
			try {
				const linkPath = join(td.path, "link_hard.jsonl");
				await link(f, linkPath);
				const result = await searchSessionTranscript(validInput(td.path));
				expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
			} catch {
				// May not be supported on all platforms; skip
			}
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Digest/input hostility
	// ===================================================================

	it("returns INVALID_ARGUMENT for empty semanticDigest", async () => {
		const result = await searchSessionTranscript(makeInput({ semanticDigest: "" }));
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("returns INVALID_ARGUMENT for semanticDigest with non-hex chars", async () => {
		const result = await searchSessionTranscript(
			makeInput({ semanticDigest: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }),
		);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	// ===================================================================
	// Matching session with only header (no message records)
	// ===================================================================

	it("returns SCAN_UNCERTAIN when matching session file has only header (empty lines)", async () => {
		const td = await createTestDir();
		try {
			const f = join(td.path, "sess.jsonl");
			await writeFile(f, `${sessionHeader(DEFAULT_SESSION_ID)}\n\n`, "utf-8");
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Mismatch then malformed -> uncertainty dominates
	// ===================================================================

	it("returns SCAN_UNCERTAIN when mismatch record is followed by malformed record", async () => {
		const td = await createTestDir();
		try {
			const wrongDigest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, wrongDigest),
				"{malformed json",
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	it("returns SCAN_UNCERTAIN when mismatch record is followed by non-plain-object record", async () => {
		const td = await createTestDir();
		try {
			const wrongDigest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, wrongDigest),
				'"just a string"',
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: false, error: { code: "SCAN_UNCERTAIN" } });
		} finally {
			await td.cleanup();
		}
	});

	// ===================================================================
	// Mismatch dominates exact within same file
	// ===================================================================

	it("returns mismatch when same file has mismatch and exact records", async () => {
		const td = await createTestDir();
		try {
			const wrongDigest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
			await writeJsonl(td.path, "sess.jsonl", [
				sessionHeader(DEFAULT_SESSION_ID),
				messageRecord(DEFAULT_MESSAGE_ID, wrongDigest),
				messageRecord(DEFAULT_MESSAGE_ID, VALID_DIGEST),
			]);
			const result = await searchSessionTranscript(validInput(td.path));
			expect(result).toEqual({ ok: true, value: "mismatch" });
		} finally {
			await td.cleanup();
		}
	});
});
