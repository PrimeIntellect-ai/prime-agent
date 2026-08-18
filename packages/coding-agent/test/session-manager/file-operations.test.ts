import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findMostRecentSession,
	loadEntriesFromFile,
	loadEntriesFromFileAsync,
	readSessionInfo,
	resolveSessionRlmDepth,
	SessionManager,
} from "../../src/core/session-manager.js";

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for file without valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for malformed JSON", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("skips malformed lines but keeps valid ones", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
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
	it.each(["2.5", "2oops", "9007199254740993"])("rejects invalid RLM_DEPTH value %s", (value) => {
		const tempDir = join(tmpdir(), `invalid-root-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		vi.stubEnv("RLM_DEPTH", value);
		try {
			expect(() => SessionManager.create(tempDir, tempDir)).toThrow("RLM_DEPTH must be a non-negative integer");
		} finally {
			vi.unstubAllEnvs();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not persist an unsafe derived depth", () => {
		const tempDir = join(tmpdir(), `max-parent-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const parent = SessionManager.create(tempDir, tempDir);
			parent.newSession({ rlmDepth: Number.MAX_SAFE_INTEGER });
			parent.flushNow();
			const parentFile = parent.getSessionFile();
			if (!parentFile) throw new Error("Missing parent session file");

			const child = SessionManager.create(tempDir, tempDir);
			child.newSession({ parentSession: parentFile });

			expect(child.getHeader()?.rlmDepth).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("persists a derived depth and exposes parent linkage from the header", async () => {
		const tempDir = join(tmpdir(), `session-tree-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const parent = SessionManager.create(tempDir, tempDir);
			parent.newSession({ rlmDepth: 2 });
			parent.flushNow();
			const parentFile = parent.getSessionFile();
			if (!parentFile) throw new Error("Missing parent session file");

			const child = SessionManager.create(tempDir, tempDir);
			child.newSession({ parentSession: parentFile });
			child.flushNow();
			const childFile = child.getSessionFile();
			if (!childFile) throw new Error("Missing child session file");

			const header = JSON.parse(readFileSync(childFile, "utf8").split("\n")[0] ?? "{}");
			expect(header).toMatchObject({ parentSession: parentFile, rlmDepth: 3 });
			expect(await readSessionInfo(childFile)).toMatchObject({
				parentSessionPath: parentFile,
				rlmDepth: 3,
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it.each([0, 2])("copies source depth %i across branch and fork reference edges", (depth) => {
		const tempDir = join(tmpdir(), `session-reference-depth-test-${depth}-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const source = SessionManager.create(tempDir, tempDir);
			source.newSession({ rlmDepth: depth });
			const leafId = source.appendMessage({ role: "user", content: "fork here", timestamp: 1 });
			source.flushNow();
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("Missing source session file");

			const forked = SessionManager.forkFrom(sourceFile, tempDir, tempDir);
			expect(forked.getHeader()?.rlmDepth).toBe(depth);

			const branched = SessionManager.open(sourceFile, tempDir);
			branched.createBranchedSession(leafId);
			expect(branched.getHeader()?.rlmDepth).toBe(depth);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves legacy root depth across branch and fork reference edges", () => {
		const tempDir = join(tmpdir(), `legacy-session-reference-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const source = SessionManager.create(tempDir, tempDir);
			source.newSession({ rlmDepth: undefined });
			const leafId = source.appendMessage({ role: "user", content: "fork here", timestamp: 1 });
			source.flushNow();
			const sourceFile = source.getSessionFile();
			if (!sourceFile) throw new Error("Missing source session file");

			expect(SessionManager.forkFrom(sourceFile, tempDir, tempDir).getHeader()?.rlmDepth).toBe(0);
			const branched = SessionManager.open(sourceFile, tempDir);
			branched.createBranchedSession(leafId);
			expect(branched.getHeader()?.rlmDepth).toBe(0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("leaves derived child depth unknown when a legacy parent has no depth", () => {
		const tempDir = join(tmpdir(), `legacy-parent-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const parentFile = join(tempDir, "legacy-parent.jsonl");
			writeFileSync(
				parentFile,
				`${JSON.stringify({ type: "session", id: "parent", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir })}\n`,
			);
			const child = SessionManager.create(tempDir, tempDir);
			child.newSession({ parentSession: parentFile });
			expect(child.getHeader()).toMatchObject({ parentSession: parentFile });
			expect(child.getHeader()?.rlmDepth).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("infers root depth when materializing a legacy fork", () => {
		const tempDir = join(tmpdir(), `materialized-legacy-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const parentFile = join(tempDir, "legacy-parent.jsonl");
			const session = SessionManager.inMemory(tempDir);
			session.newSession({ parentSession: parentFile, rlmDepth: undefined });

			const sessionFile = session.materializeSessionFile(tempDir);
			const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0] ?? "{}");
			expect(header).toMatchObject({ parentSession: parentFile });
			expect(header.rlmDepth).toBe(0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("infers and backfills legacy child depth from nested subagent directories on open", async () => {
		const tempDir = join(tmpdir(), `legacy-session-tree-test-${Date.now()}-${Math.random()}`);
		const parentFile = join(tempDir, "parent.jsonl");
		const childDir = join(tempDir, "session-artifacts", "root", "sub-1234abcd", "sub-deadbeef");
		const childFile = join(childDir, "child.jsonl");
		mkdirSync(childDir, { recursive: true });
		try {
			const header = {
				type: "session" as const,
				id: "child",
				timestamp: "2025-01-01T00:00:01Z",
				cwd: tempDir,
				parentSession: parentFile,
			};
			writeFileSync(childFile, `${JSON.stringify(header)}\n`);

			expect(resolveSessionRlmDepth(header, childFile)).toBe(2);
			expect((await readSessionInfo(childFile))?.rlmDepth).toBe(2);
			expect(JSON.parse(readFileSync(childFile, "utf8").split("\n")[0] ?? "{}").rlmDepth).toBeUndefined();

			expect(SessionManager.open(childFile).getHeader()?.rlmDepth).toBe(2);
			expect(JSON.parse(readFileSync(childFile, "utf8").split("\n")[0] ?? "{}").rlmDepth).toBe(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("copies and backfills a readable source depth for a legacy fork", async () => {
		const tempDir = join(tmpdir(), `legacy-fork-source-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const sourceFile = join(tempDir, "source.jsonl");
			const forkFile = join(tempDir, "fork.jsonl");
			writeFileSync(
				sourceFile,
				`${JSON.stringify({
					type: "session",
					id: "source",
					timestamp: "2025-01-01T00:00:00Z",
					cwd: tempDir,
					rlmDepth: 2,
				})}
`,
			);
			const forkHeader = {
				type: "session" as const,
				id: "fork",
				timestamp: "2025-01-01T00:00:01Z",
				cwd: tempDir,
				parentSession: sourceFile,
			};
			writeFileSync(
				forkFile,
				`${JSON.stringify(forkHeader)}
`,
			);

			expect(resolveSessionRlmDepth(forkHeader, forkFile)).toBe(2);
			expect((await readSessionInfo(forkFile))?.rlmDepth).toBe(2);
			expect(JSON.parse(readFileSync(forkFile, "utf8").split("\n")[0] ?? "{}").rlmDepth).toBeUndefined();

			expect(SessionManager.open(forkFile).getHeader()?.rlmDepth).toBe(2);
			expect(JSON.parse(readFileSync(forkFile, "utf8").split("\n")[0] ?? "{}").rlmDepth).toBe(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("treats a legacy fork in the sessions directory as a root", async () => {
		const tempDir = join(tmpdir(), `legacy-fork-depth-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const forkFile = join(tempDir, "fork.jsonl");
			const header = {
				type: "session" as const,
				id: "fork",
				timestamp: "2025-01-01T00:00:01Z",
				cwd: tempDir,
				parentSession: join(tempDir, "source.jsonl"),
			};
			writeFileSync(forkFile, `${JSON.stringify(header)}\n`);

			expect(resolveSessionRlmDepth(header, forkFile)).toBe(0);
			expect((await readSessionInfo(forkFile))?.rlmDepth).toBe(0);
			expect(SessionManager.open(forkFile).getHeader()?.rlmDepth).toBe(0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not count a matching segment outside the trailing subagent path", () => {
		const sessionFile = join(tmpdir(), "sub-deadbeef", "sessions", "child.jsonl");
		expect(resolveSessionRlmDepth({ parentSession: "/missing-parent.jsonl" }, sessionFile)).toBe(0);
	});

	it("prefers the parent header depth over path inference", () => {
		const tempDir = join(tmpdir(), `parent-header-depth-test-${Date.now()}-${Math.random()}`);
		const parentFile = join(tempDir, "parent.jsonl");
		const childFile = join(tempDir, "sub-1234abcd", "sub-deadbeef", "child.jsonl");
		mkdirSync(tempDir, { recursive: true });
		try {
			writeFileSync(
				parentFile,
				`${JSON.stringify({
					type: "session",
					id: "parent",
					timestamp: "2025-01-01T00:00:00Z",
					cwd: tempDir,
					rlmDepth: 4,
				})}
`,
			);

			expect(resolveSessionRlmDepth({ parentSession: parentFile }, childFile)).toBe(5);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves relative parent paths from each legacy session directory", () => {
		const tempDir = join(tmpdir(), `relative-parent-depth-test-${Date.now()}-${Math.random()}`);
		const grandparentFile = join(tempDir, "grandparent.jsonl");
		const parentFile = join(tempDir, "parent.jsonl");
		const childDir = join(tempDir, "sub-1234abcd");
		const childFile = join(childDir, "child.jsonl");
		mkdirSync(childDir, { recursive: true });
		try {
			writeFileSync(
				grandparentFile,
				`${JSON.stringify({
					type: "session",
					id: "grandparent",
					timestamp: "2025-01-01T00:00:00Z",
					cwd: tempDir,
					rlmDepth: 4,
				})}
`,
			);
			writeFileSync(
				parentFile,
				`${JSON.stringify({
					type: "session",
					id: "parent",
					timestamp: "2025-01-01T00:00:01Z",
					cwd: tempDir,
					parentSession: "grandparent.jsonl",
				})}
`,
			);

			expect(resolveSessionRlmDepth({ parentSession: "../parent.jsonl" }, childFile)).toBe(5);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prefers a valid persisted depth over path inference", () => {
		const sessionFile = join(tmpdir(), "sub-1234abcd", "sub-deadbeef", "session.jsonl");
		expect(resolveSessionRlmDepth({ parentSession: "/parent.jsonl", rlmDepth: 7 }, sessionFile)).toBe(7);
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

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
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

	it("truncates and rewrites empty file with valid header", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm = SessionManager.open(emptyFile, tempDir);

		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		const content = readFileSync(emptyFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());
	});

	it("truncates and rewrites file without valid header", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		writeFileSync(
			noHeaderFile,
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n',
		);

		const sm = SessionManager.open(noHeaderFile, tempDir);

		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		const content = readFileSync(noHeaderFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());
	});

	it("preserves explicit session file path when recovering from corrupted file", () => {
		const explicitPath = join(tempDir, "my-session.jsonl");
		writeFileSync(explicitPath, "");

		const sm = SessionManager.open(explicitPath, tempDir);

		expect(sm.getSessionFile()).toBe(explicitPath);
	});

	it("subsequent loads of recovered file work correctly", () => {
		const corruptedFile = join(tempDir, "corrupted.jsonl");
		writeFileSync(corruptedFile, "garbage content\n");

		const sm1 = SessionManager.open(corruptedFile, tempDir);
		const sessionId = sm1.getSessionId();

		const sm2 = SessionManager.open(corruptedFile, tempDir);
		expect(sm2.getSessionId()).toBe(sessionId);
		expect(sm2.getHeader()?.type).toBe("session");
	});
});
