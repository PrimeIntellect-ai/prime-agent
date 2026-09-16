import {
	appendFileSync,
	chmodSync,
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fullReadCounter = vi.hoisted(() => ({ suffix: undefined as string | undefined, count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], options?: never) => {
			// Suffix match: repair resolves the realpath (/private/var vs /var on macOS).
			if (fullReadCounter.suffix !== undefined && String(path).endsWith(fullReadCounter.suffix)) {
				fullReadCounter.count++;
			}
			return actual.readFileSync(path, options);
		}) as typeof actual.readFileSync,
	};
});

import { computeOwnAndTotalUsage } from "../../src/core/context-tree.js";
import {
	type FileEntry,
	findMostRecentSession,
	loadEntriesFromFile,
	loadEntriesFromFileAsync,
	migrateSessionEntries,
	readSessionInfo,
	resolveSessionRlmDepth,
	SessionManager,
} from "../../src/core/session-manager.js";
import { sessionUsageSummaryFrom } from "../../src/core/usage.js";

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const HEADER = '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}';
	const MESSAGE =
		'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}';

	it.each<[string, string | undefined, string[]]>([
		["a missing file", undefined, []],
		["an empty file", "", []],
		["a file without a session header", `${MESSAGE}\n`, []],
		["malformed JSON", "not json\n", []],
		["a valid session file", `${HEADER}\n${MESSAGE}\n`, ["session", "message"]],
		[
			"a file with a malformed line between valid ones",
			`${HEADER}\nnot valid json\n${MESSAGE}\n`,
			["session", "message"],
		],
	])("loads %s", (_label, content, expectedTypes) => {
		const file = join(tempDir, "session.jsonl");
		if (content !== undefined) writeFileSync(file, content);

		expect(loadEntriesFromFile(file).map((entry) => entry.type)).toEqual(expectedTypes);
	});

	it("yields while parsing a multi-megabyte session below the streaming threshold", async () => {
		const file = join(tempDir, "buffered.jsonl");
		writeFileSync(
			file,
			[
				'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "x".repeat(5 * 1024 * 1024), timestamp: 1 },
				}),
			].join("\n"),
		);
		const setImmediateSpy = vi.spyOn(globalThis, "setImmediate");
		try {
			const entries = await loadEntriesFromFileAsync(file, { streamThresholdBytes: Number.MAX_SAFE_INTEGER });
			expect(entries).toHaveLength(2);
			expect(setImmediateSpy).toHaveBeenCalled();
		} finally {
			setImmediateSpy.mockRestore();
		}
	});

	it("streams large sessions with the same parsing semantics as the Buffer loader", async () => {
		const file = join(tempDir, "streamed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\r\n' +
				"\r\n" +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"héllo 世界","timestamp":1}}',
		);

		const streamed = await loadEntriesFromFileAsync(file, { streamThresholdBytes: 0 });
		expect(streamed).toEqual(loadEntriesFromFile(file));
	});

	it("only treats LF bytes as JSONL record boundaries", async () => {
		const file = join(tempDir, "unicode-separators.jsonl");
		const content = "before\u2028middle\u2029after";
		writeFileSync(
			file,
			[
				'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content, timestamp: 1 },
				}),
			].join("\n"),
		);

		const streamed = await loadEntriesFromFileAsync(file, { streamThresholdBytes: 0 });
		expect(streamed).toEqual(loadEntriesFromFile(file));
		expect(streamed[1]).toMatchObject({ type: "message", message: { content } });
		expect((await readSessionInfo(file))?.firstMessage).toBe(content);
	});

	it("streams a multi-megabyte JSONL record without losing following entries", async () => {
		const file = join(tempDir, "large-record.jsonl");
		const largeContent = "x".repeat(2 * 1024 * 1024);
		writeFileSync(
			file,
			[
				'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}',
				JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: largeContent, timestamp: 1 },
				}),
				'{"type":"message","id":"2","parentId":"1","timestamp":"2025-01-01T00:00:02Z","message":{"role":"user","content":"after","timestamp":2}}',
			].join("\n"),
		);

		const entries = await loadEntriesFromFileAsync(file, { streamThresholdBytes: 0 });
		expect(entries).toHaveLength(3);
		expect(entries[2]).toMatchObject({ type: "message", id: "2" });
	});
});

describe("session tree metadata", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-tree-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Writes a legacy JSONL header (no rlmDepth unless supplied) and returns the file path. */
	function writeLegacySession(relativePath: string, header: Record<string, unknown>): string {
		const file = join(tempDir, relativePath);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir, ...header })}\n`,
		);
		return file;
	}

	function headerOf(file: string): Record<string, unknown> {
		return JSON.parse(readFileSync(file, "utf8").split("\n")[0] ?? "{}");
	}

	it.each(["2.5", "2oops", "9007199254740993"])("rejects invalid RLM_DEPTH value %s", (value) => {
		vi.stubEnv("RLM_DEPTH", value);
		expect(() => SessionManager.create(tempDir, tempDir)).toThrow("RLM_DEPTH must be a non-negative integer");
	});

	// An unsafe parent depth must not be persisted as a derived child depth.
	it.each<[number, number | undefined]>([
		[2, 3],
		[Number.MAX_SAFE_INTEGER, undefined],
	])("derives a child depth from parent depth %s", async (parentDepth, expected) => {
		const parent = SessionManager.create(tempDir, tempDir);
		parent.newSession({ rlmDepth: parentDepth });
		parent.flushNow();
		const parentFile = parent.getSessionFile();
		if (!parentFile) throw new Error("Missing parent session file");

		const child = SessionManager.create(tempDir, tempDir);
		child.newSession({ parentSession: parentFile });
		child.flushNow();
		const childFile = child.getSessionFile();
		if (!childFile) throw new Error("Missing child session file");

		expect(child.getHeader()?.rlmDepth).toBe(expected);
		expect(headerOf(childFile)).toMatchObject({ parentSession: parentFile });
		expect(headerOf(childFile).rlmDepth).toBe(expected);
		expect(await readSessionInfo(childFile)).toMatchObject({ parentSessionPath: parentFile });
	});

	// A legacy source (no rlmDepth) resolves to root depth on both reference edges.
	it.each([0, 2, undefined])("copies source depth %s across branch and fork reference edges", (depth) => {
		const source = SessionManager.create(tempDir, tempDir);
		source.newSession({ rlmDepth: depth });
		const leafId = source.appendMessage({ role: "user", content: "fork here", timestamp: 1 });
		source.flushNow();
		const sourceFile = source.getSessionFile();
		if (!sourceFile) throw new Error("Missing source session file");
		const expected = depth ?? 0;

		expect(SessionManager.forkFrom(sourceFile, tempDir, tempDir).getHeader()?.rlmDepth).toBe(expected);

		const branched = SessionManager.open(sourceFile, tempDir);
		branched.createBranchedSession(leafId);
		expect(branched.getHeader()?.rlmDepth).toBe(expected);
	});

	it("leaves derived child depth unknown when a legacy parent has no depth", () => {
		const parentFile = writeLegacySession("legacy-parent.jsonl", { id: "parent" });
		const child = SessionManager.create(tempDir, tempDir);
		child.newSession({ parentSession: parentFile });

		expect(child.getHeader()).toMatchObject({ parentSession: parentFile });
		expect(child.getHeader()?.rlmDepth).toBeUndefined();
	});

	it("infers root depth when materializing a legacy fork", () => {
		const session = SessionManager.inMemory(tempDir);
		session.newSession({ parentSession: join(tempDir, "legacy-parent.jsonl"), rlmDepth: undefined });

		const header = headerOf(session.materializeSessionFile(tempDir));

		expect(header).toMatchObject({ parentSession: join(tempDir, "legacy-parent.jsonl"), rlmDepth: 0 });
	});

	/**
	 * Legacy depth inference: nested `sub-*` directories under the session root
	 * count as depth, a readable parent header wins over path inference, and a
	 * persisted depth wins over both.
	 */
	it.each<[string, () => { header: Record<string, unknown>; file: string; expected: number }]>([
		[
			"counts nested subagent directories",
			() => ({
				header: { parentSession: join(tempDir, "missing-parent.jsonl") },
				file: join(tempDir, "session-artifacts", "root", "sub-1234abcd", "sub-deadbeef", "child.jsonl"),
				expected: 2,
			}),
		],
		[
			"ignores a matching segment outside the trailing subagent path",
			() => ({
				header: { parentSession: join(tempDir, "missing-parent.jsonl") },
				file: join(tempDir, "sub-deadbeef", "sessions", "child.jsonl"),
				expected: 0,
			}),
		],
		[
			"prefers the parent header depth over path inference",
			() => ({
				header: { parentSession: writeLegacySession("parent.jsonl", { id: "parent", rlmDepth: 4 }) },
				file: join(tempDir, "sub-1234abcd", "sub-deadbeef", "child.jsonl"),
				expected: 5,
			}),
		],
		[
			"resolves relative parent paths from each legacy session directory",
			() => {
				writeLegacySession("grandparent.jsonl", { id: "grandparent", rlmDepth: 4 });
				writeLegacySession("parent.jsonl", { id: "parent", parentSession: "grandparent.jsonl" });
				return {
					header: { parentSession: "../parent.jsonl" },
					file: join(tempDir, "sub-1234abcd", "child.jsonl"),
					expected: 5,
				};
			},
		],
		[
			"prefers a valid persisted depth over path inference",
			() => ({
				header: { parentSession: join(tempDir, "parent.jsonl"), rlmDepth: 7 },
				file: join(tempDir, "sub-1234abcd", "sub-deadbeef", "session.jsonl"),
				expected: 7,
			}),
		],
	])("resolveSessionRlmDepth %s", (_label, build) => {
		const { header, file, expected } = build();

		expect(resolveSessionRlmDepth(header, file)).toBe(expected);
	});

	/** Reading or opening a legacy session infers its depth; only open() backfills it on disk. */
	it.each<[string, { setup: () => string; expected: number }]>([
		[
			"a nested subagent child",
			{
				// The parent file is missing, so only the nested path carries the depth.
				setup: () =>
					writeLegacySession(join("session-artifacts", "root", "sub-1234abcd", "sub-deadbeef", "child.jsonl"), {
						id: "child",
						parentSession: join(tempDir, "missing-parent.jsonl"),
					}),
				expected: 2,
			},
		],
		[
			"a legacy fork with a readable source depth",
			{
				setup: () => {
					const sourceFile = writeLegacySession("source.jsonl", { id: "source", rlmDepth: 2 });
					return writeLegacySession("fork.jsonl", { id: "fork", parentSession: sourceFile });
				},
				expected: 2,
			},
		],
		[
			"a legacy fork whose source is missing",
			{
				setup: () => writeLegacySession("fork.jsonl", { id: "fork", parentSession: join(tempDir, "source.jsonl") }),
				expected: 0,
			},
		],
	])("infers and backfills the depth of %s on open", async (_label, { setup, expected }) => {
		const file = setup();

		expect(resolveSessionRlmDepth(headerOf(file), file)).toBe(expected);
		expect((await readSessionInfo(file))?.rlmDepth).toBe(expected);
		// readSessionInfo must not rewrite the file.
		expect(headerOf(file).rlmDepth).toBeUndefined();

		expect(SessionManager.open(file).getHeader()?.rlmDepth).toBe(expected);
		expect(headerOf(file).rlmDepth).toBe(expected);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSession(name: string, id: string, mtimeSeconds?: number): string {
		const file = join(tempDir, name);
		writeFileSync(file, `{"type":"session","id":"${id}","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n`);
		if (mtimeSeconds !== undefined) utimesSync(file, mtimeSeconds, mtimeSeconds);
		return file;
	}

	it.each<[string, () => { dir: string; expected: string | null }]>([
		["returns null for an empty directory", () => ({ dir: tempDir, expected: null })],
		["returns null for a non-existent directory", () => ({ dir: join(tempDir, "nonexistent"), expected: null })],
		[
			"ignores non-jsonl files",
			() => {
				writeFileSync(join(tempDir, "file.txt"), "hello");
				writeFileSync(join(tempDir, "file.json"), "{}");
				return { dir: tempDir, expected: null };
			},
		],
		[
			"ignores jsonl files without a valid session header",
			() => {
				writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
				return { dir: tempDir, expected: null };
			},
		],
		[
			"returns the single valid session file",
			() => ({ dir: tempDir, expected: writeSession("session.jsonl", "abc") }),
		],
		[
			"returns the most recently modified session",
			() => {
				writeSession("older.jsonl", "old", 1000);
				return { dir: tempDir, expected: writeSession("newer.jsonl", "new", 2000) };
			},
		],
		[
			"skips invalid files and returns the valid one",
			() => {
				writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"not-session"}\n');
				return { dir: tempDir, expected: writeSession("valid.jsonl", "abc") };
			},
		],
	])("%s", (_label, build) => {
		const { dir, expected } = build();

		expect(findMostRecentSession(dir)).toBe(expected);
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// The suspicion gate must keep clean opens at ONE full read (the loader's own).
	it.each([
		[
			"a clean large session",
			(): string[] => {
				const filler = "x".repeat(2048);
				const lines: string[] = [];
				for (let index = 0; index < 2000; index++) {
					lines.push(
						JSON.stringify({
							type: "message",
							id: `m${index}`,
							parentId: index === 0 ? null : `m${index - 1}`,
							message: { role: "user", content: filler, timestamp: index },
						}),
					);
				}
				return lines;
			},
		],
		[
			"a benign trailing blank line",
			(): string[] => [
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					message: { role: "user", content: "hi", timestamp: 1 },
				}),
				"",
			],
		],
	])("opens %s with exactly one full read", (_name, buildLines) => {
		const file = join(tempDir, "gate.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "gate-session",
			timestamp: "2026-01-01T00:00:00Z",
			cwd: "/tmp",
		};
		writeFileSync(file, `${[JSON.stringify(header), ...buildLines()].join("\n")}\n`);
		fullReadCounter.suffix = "gate.jsonl";
		fullReadCounter.count = 0;

		try {
			SessionManager.open(file, tempDir);
			expect(fullReadCounter.count).toBe(1);
		} finally {
			fullReadCounter.suffix = undefined;
		}
	});

	it("repairs crash damage at open: torn tail truncated, zero-filled record recovered, appends stay separate lines", () => {
		const file = join(tempDir, "crashed.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "crashed-session",
			timestamp: "2026-01-01T00:00:00Z",
			cwd: "/tmp",
		};
		const kept = {
			type: "message",
			id: "m1",
			parentId: null,
			message: { role: "user", content: "kept", timestamp: 1 },
		};
		const zeroFilled = {
			type: "message",
			id: "m2",
			parentId: "m1",
			message: { role: "user", content: "recovered", timestamp: 2 },
		};
		const damaged = `${JSON.stringify(header)}\n${JSON.stringify(kept)}\n\u0000\u0000\u0000\u0000${JSON.stringify(zeroFilled)}\n{"type":"message","id":"torn`;
		writeFileSync(file, damaged);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const sm = SessionManager.open(file, tempDir);
			expect(sm.getHeader()?.id).toBe("crashed-session");
			expect(sm.getEntries().map((entry) => entry.id)).toEqual(["m1", "m2"]);
			sm.appendMessage({ role: "user", content: "after crash", timestamp: 3 });
			sm.flushNow();

			const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
			const parsed = lines.map((line) => JSON.parse(line));
			expect(parsed.map((entry) => entry.id ?? entry.type)).toEqual([
				"crashed-session",
				"m1",
				"m2",
				expect.any(String),
			]);
			expect(parsed.at(-1)?.message?.content).toBe("after crash");
			expect(errorSpy).toHaveBeenCalledTimes(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("repairs a damaged transcript through its symlink alias at the real file", () => {
		const realFile = join(tempDir, "real.jsonl");
		const alias = join(tempDir, "alias.jsonl");
		const header = { type: "session", version: 3, id: "sym-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" };
		writeFileSync(realFile, `${JSON.stringify(header)}\n{"type":"message","id":"torn`);
		chmodSync(realFile, 0o600);
		symlinkSync(realFile, alias);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			SessionManager.open(alias, tempDir);
			expect(lstatSync(alias).isSymbolicLink()).toBe(true);
			const repaired = readFileSync(realFile, "utf-8");
			expect(repaired.endsWith("\n")).toBe(true);
			expect(repaired).not.toContain("torn");
			expect(statSync(realFile).mode & 0o777).toBe(0o600);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it.each<[string, string]>([
		["an empty file", ""],
		[
			"a file without a valid header",
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n',
		],
		["garbage content", "garbage content\n"],
	])("truncates and rewrites %s at the explicit path", (_label, content) => {
		const file = join(tempDir, "recovered.jsonl");
		writeFileSync(file, content);

		const sm = SessionManager.open(file, tempDir);

		expect(sm.getSessionFile()).toBe(file);
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");
		const persisted = readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
		expect(persisted).toHaveLength(1);
		expect(JSON.parse(persisted[0])).toMatchObject({ type: "session", id: sm.getSessionId() });
		// Reopening the recovered file resumes the same session.
		expect(SessionManager.open(file, tempDir).getSessionId()).toBe(sm.getSessionId());
	});
});

describe("session info usage totals", () => {
	it("scan and resident computation agree on whole-file own spend, forks and attributions included", async () => {
		const tempDir = join(tmpdir(), `session-usage-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const usage = (input: number, output: number, cost: number, cacheRead = 10, cacheWrite = 5) => ({
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens: input + output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			});
			const msg = (id: string, parentId: string | null, role: string, u?: unknown) =>
				({ type: "message", id, parentId, message: { role, content: "x", timestamp: 1, usage: u } }) as const;
			const file = join(tempDir, "usage.jsonl");
			const lines = [
				{ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" },
				msg("m1", null, "user"),
				msg("m2", "m1", "assistant", usage(1000, 200, 0.5)),
				// On-disk original usage; the loader folds the aggregate below onto it in memory.
				msg("m3", "m1", "assistant", usage(2000, 300, 1.0)),
				{
					type: "child_usage_attributed",
					id: "a1",
					parentId: "m3",
					targetId: "m3",
					childUsage: usage(500, 100, 0.4),
					aggregateUsage: usage(2500, 400, 1.4, 20, 10),
				},
				{
					type: "compaction",
					id: "c1",
					parentId: "m3",
					summary: "compacted",
					firstKeptEntryId: "m3",
					tokensBefore: 5000,
					usage: usage(100, 20, 0.05),
				},
				{
					type: "branch_summary",
					id: "b1",
					parentId: "c1",
					fromId: "m1",
					summary: "left",
					usage: usage(60, 8, 0.02),
				},
			];
			writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

			const entries = SessionManager.open(file).getEntries();
			const resident = sessionUsageSummaryFrom(computeOwnAndTotalUsage(entries, entries).ownUsage);

			const scanned = (await readSessionInfo(file))?.usage;
			expect(scanned).toMatchObject({ inputTokens: 3220, outputTokens: 528 });
			expect(scanned?.cost).toBeCloseTo(1.57);
			expect(resident).toEqual(scanned);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("readSessionInfo incremental scans", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-scan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const header = { type: "session", version: 3, id: "scan1", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" };
	const msg = (id: string, parentId: string | null, role: string, text: string) => ({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01Z",
		message: { role, content: text, timestamp: 1 },
	});
	const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;

	it("scans the last recorded model from model_change entries and assistant messages", async () => {
		const file = join(tempDir, "model.jsonl");
		writeFileSync(
			file,
			[
				line(header),
				line({ type: "model_change", id: "mc1", parentId: null, provider: "openai", modelId: "gpt-4o" }),
				line(msg("m1", "mc1", "user", "hi")),
				line({
					type: "message",
					id: "m2",
					parentId: "m1",
					message: {
						role: "assistant",
						content: "x",
						timestamp: 1,
						provider: "prime-inference",
						model: "glm-4.7",
					},
				}),
			].join(""),
		);
		expect((await readSessionInfo(file))?.model).toEqual({ provider: "prime-inference", modelId: "glm-4.7" });

		const bare = join(tempDir, "bare.jsonl");
		writeFileSync(bare, line(header));
		expect((await readSessionInfo(bare))?.model).toBeUndefined();
	});

	it("coalesces concurrent unchanged readers and gives post-append readers the fresh snapshot", async () => {
		const file = join(tempDir, "serialized.jsonl");
		let content = line(header);
		for (let i = 0; i < 20000; i++) {
			content += line(msg(`m${i}`, i === 0 ? null : `m${i - 1}`, "user", `filler message ${i} ${"x".repeat(120)}`));
		}
		writeFileSync(file, content);

		const [first, second] = await Promise.all([readSessionInfo(file), readSessionInfo(file)]);
		expect(first?.messageCount).toBe(20000);
		expect(second).toBe(first);

		const early = readSessionInfo(file);
		// Let the scan stat the file and start streaming before the append.
		await new Promise((resolveTick) => setImmediate(resolveTick));
		appendFileSync(file, line(msg("late", "m19999", "assistant", "post-append entry")));
		const late = await readSessionInfo(file);
		expect(late?.messageCount).toBe(20001);
		expect((await early)?.messageCount).toBeLessThanOrEqual(20001);
	});

	it("resumes from the scanned offset: prefix never re-read, torn tail folded exactly once", async () => {
		const file = join(tempDir, "incremental.jsonl");
		const torn = line(msg("m2", "m1", "assistant", "answer"));
		writeFileSync(file, line(header) + line(msg("m1", null, "user", "original question")) + torn.slice(0, 20));
		expect((await readSessionInfo(file))?.messageCount).toBe(1);

		// Same-length positional write into the scanned prefix, keeping the inode:
		// outside the writer model, so consumed bytes are never re-read.
		const position = readFileSync(file, "utf8").indexOf("original question");
		const fd = openSync(file, "r+");
		try {
			writeSync(fd, Buffer.from("modified question"), 0, 17, position);
		} finally {
			closeSync(fd);
		}
		appendFileSync(file, torn.slice(20));

		const info = await readSessionInfo(file);
		expect(info?.messageCount).toBe(2);
		expect(info?.firstMessage).toBe("original question");
	});

	// The rename row preserves the 16 bytes before the old offset, so only the
	// replaced inode identifies it; the truncate row keeps the inode, so only
	// the changed prefix tail does.
	it.each([
		{ mode: "rename", first: "name variant AAAA", rewrittenFirst: "name variant BBBB" },
		{ mode: "truncate", first: "first draft AAAAAA", rewrittenFirst: "rewritten opening line" },
	])("rescans from byte 0 after a grown $mode rewrite", async ({ mode, first, rewrittenFirst }) => {
		const file = join(tempDir, `${mode}-rewrite.jsonl`);
		writeFileSync(
			file,
			line(header) + line(msg("m1", null, "user", first)) + line(msg("m2", "m1", "assistant", "stable reply")),
		);
		expect((await readSessionInfo(file))?.firstMessage).toBe(first);

		const rewritten =
			line(header) +
			line(msg("m1", null, "user", rewrittenFirst)) +
			line(msg("m2", "m1", "assistant", "stable reply")) +
			line(msg("m3", "m2", "assistant", "appended"));
		if (mode === "rename") {
			const tempPath = join(tempDir, "rewrite.tmp");
			writeFileSync(tempPath, rewritten);
			renameSync(tempPath, file);
		} else {
			writeFileSync(file, rewritten);
		}

		const info = await readSessionInfo(file);
		expect(info?.messageCount).toBe(3);
		expect(info?.firstMessage).toBe(rewrittenFirst);
	});

	it("invalidates scanned bytes after crash repair and resumes later appends", async () => {
		const file = join(tempDir, "repaired-scan.jsonl");
		writeFileSync(
			file,
			line(header) +
				line(msg("m1", null, "user", "kept")) +
				"\0\0" +
				line(msg("m2", "m1", "user", "recovered")) +
				'{"type":"message","id":"torn',
		);
		expect((await readSessionInfo(file))?.messageCount).toBe(1);
		const manager = SessionManager.open(file, tempDir);
		expect((await readSessionInfo(file))?.messageCount).toBe(2);
		manager.appendMessage({ role: "user", content: "after repair", timestamp: 3 });
		manager.flushNow();
		const scanned = await readSessionInfo(file);
		expect(scanned?.messageCount).toBe(3);
		expect(scanned?.allMessagesText).toContain("recovered");
		expect(scanned?.allMessagesText).toContain("after repair");
	});

	it("evicts scan state when the file disappears so a recreated file rescans", async () => {
		const file = join(tempDir, "recreated.jsonl");
		writeFileSync(file, line(header) + line(msg("m1", null, "user", "before delete")));
		const fixedTime = new Date("2026-01-02T00:00:00Z");
		utimesSync(file, fixedTime, fixedTime);
		expect((await readSessionInfo(file))?.firstMessage).toBe("before delete");

		rmSync(file);
		expect(await readSessionInfo(file)).toBeNull();

		writeFileSync(file, line(header) + line(msg("m1", null, "user", "after recreate")));
		utimesSync(file, fixedTime, fixedTime);
		expect((await readSessionInfo(file))?.firstMessage).toBe("after recreate");
	});
});

describe("migrateSessionEntries", () => {
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: 2,
	};

	it("stamps the current version and links v1 entries into a parent chain", () => {
		const entries = [
			{ type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{ type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
			{ type: "message", timestamp: "2025-01-01T00:00:02Z", message: assistant },
		] as unknown as FileEntry[];

		migrateSessionEntries(entries);

		const [header, first, second] = entries as unknown as Array<Record<string, unknown>>;
		// v3 is current after the hookMessage->custom migration.
		expect(header!.version).toBe(3);
		expect(String(first!.id)).toHaveLength(8);
		expect(first!.parentId).toBeNull();
		expect(String(second!.id)).toHaveLength(8);
		expect(second!.parentId).toBe(first!.id);
	});

	it("is idempotent for entries that already carry ids", () => {
		const entries = [
			{ type: "session", id: "sess-1", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "message",
				id: "def67890",
				parentId: "abc12345",
				timestamp: "2025-01-01T00:00:02Z",
				message: assistant,
			},
		] as unknown as FileEntry[];

		migrateSessionEntries(entries);

		const [, first, second] = entries as unknown as Array<Record<string, unknown>>;
		expect(first!.id).toBe("abc12345");
		expect(second!.id).toBe("def67890");
		expect(second!.parentId).toBe("abc12345");
	});
});
