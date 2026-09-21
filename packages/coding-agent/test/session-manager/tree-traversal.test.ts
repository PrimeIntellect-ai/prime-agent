import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { loadEntriesFromFile, type SessionEntry, SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

describe("SessionManager append and tree traversal", () => {
	describe("append operations", () => {
		const cases: Array<{
			name: string;
			seed: (session: SessionManager) => string[];
			append: (session: SessionManager) => string;
			type: string;
			expectEntry?: (entry: SessionEntry, seedIds: string[]) => void;
		}> = [
			{
				name: "appendMessage creates entry with correct parentId chain",
				seed: (session) => [session.appendMessage(userMsg("first"))],
				append: (session) => session.appendMessage(assistantMsg("second")),
				type: "message",
			},
			{
				name: "appendThinkingLevelChange integrates into tree",
				seed: (session) => [session.appendMessage(userMsg("hello"))],
				append: (session) => session.appendThinkingLevelChange("high"),
				type: "thinking_level_change",
				expectEntry: (entry) => expect(entry).toMatchObject({ thinkingLevel: "high" }),
			},
			{
				name: "appendModelChange integrates into tree",
				seed: (session) => [session.appendMessage(userMsg("hello"))],
				append: (session) => session.appendModelChange("openai", "gpt-4"),
				type: "model_change",
				expectEntry: (entry) => expect(entry).toMatchObject({ provider: "openai", modelId: "gpt-4" }),
			},
			{
				name: "appendCompaction integrates into tree and persists customInstructions",
				seed: (session) => {
					const firstId = session.appendMessage(userMsg("1"));
					return [firstId, session.appendMessage(assistantMsg("2"))];
				},
				append: (session) =>
					session.appendCompaction(
						"summary",
						session.getEntries()[0]!.id,
						1000,
						undefined,
						undefined,
						"focus on xyz",
					),
				type: "compaction",
				expectEntry: (entry, seedIds) =>
					expect(entry).toMatchObject({
						summary: "summary",
						firstKeptEntryId: seedIds[0],
						tokensBefore: 1000,
						customInstructions: "focus on xyz",
					}),
			},
			{
				name: "appendCustomEntry integrates into tree",
				seed: (session) => [session.appendMessage(userMsg("hello"))],
				append: (session) => session.appendCustomEntry("my_data", { key: "value" }),
				type: "custom",
				expectEntry: (entry) => expect(entry).toMatchObject({ customType: "my_data", data: { key: "value" } }),
			},
		];
		it.each(cases)("$name", ({ seed, append, type, expectEntry }) => {
			const session = SessionManager.inMemory();
			const seedIds = seed(session);
			const appendedId = append(session);
			const followingId = session.appendMessage(userMsg("after"));

			const entries = session.getEntries();
			const appended = entries.find((e) => e.id === appendedId)!;
			expect(appended.type).toBe(type);
			expect(appended.parentId).toBe(seedIds.at(-1) ?? null);
			expectEntry?.(appended, seedIds);
			// The entry after the appended one parents to it, pinning the chain.
			expect(entries.find((e) => e.id === followingId)?.parentId).toBe(appendedId);
		});
	});

	describe("getPath", () => {
		it("returns full path from root to leaf", () => {
			const session = SessionManager.inMemory();

			const id1 = session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));
			const id3 = session.appendThinkingLevelChange("high");
			const id4 = session.appendMessage(userMsg("3"));

			const path = session.getBranch();
			expect(path).toHaveLength(4);
			expect(path.map((e) => e.id)).toEqual([id1, id2, id3, id4]);
		});
	});

	describe("getTree", () => {
		it("returns empty array for empty session", () => {
			const session = SessionManager.inMemory();
			expect(session.getTree()).toEqual([]);
		});

		it("returns tree with branches after branch", () => {
			const session = SessionManager.inMemory();

			const id1 = session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));
			const id3 = session.appendMessage(userMsg("3"));

			session.branch(id2);
			const id4 = session.appendMessage(userMsg("4-branch"));
			session.branch(id2);
			const id5 = session.appendMessage(userMsg("5-branch"));

			const tree = session.getTree();
			expect(tree).toHaveLength(1);

			const root = tree[0];
			expect(root.entry.id).toBe(id1);
			expect(root.children).toHaveLength(1);

			const node2 = root.children[0];
			expect(node2.entry.id).toBe(id2);
			expect(node2.children).toHaveLength(3); // id3, id4, and id5 are siblings

			const childIds = node2.children.map((c) => c.entry.id).sort();
			expect(childIds).toEqual([id3, id4, id5].sort());
		});

		it("handles deep branching", () => {
			const session = SessionManager.inMemory();

			// Main path: 1 -> 2 -> 3 -> 4
			const _id1 = session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));
			const id3 = session.appendMessage(userMsg("3"));
			const _id4 = session.appendMessage(assistantMsg("4"));

			session.branch(id2);
			const id5 = session.appendMessage(userMsg("5"));
			const _id6 = session.appendMessage(assistantMsg("6"));

			// Branch from 5: 5 -> 7
			session.branch(id5);
			const _id7 = session.appendMessage(userMsg("7"));

			const tree = session.getTree();

			const node2 = tree[0].children[0];
			expect(node2.children).toHaveLength(2); // id3 and id5

			const node5 = node2.children.find((c) => c.entry.id === id5)!;
			expect(node5.children).toHaveLength(2); // id6 and id7

			const node3 = node2.children.find((c) => c.entry.id === id3)!;
			expect(node3.children).toHaveLength(1); // id4
		});
	});

	describe("branch", () => {
		it("throws for non-existent entry", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));

			expect(() => session.branch("nonexistent")).toThrow("Entry nonexistent not found");
		});
	});

	describe("branchWithSummary", () => {
		it("throws for non-existent entry", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));

			expect(() => session.branchWithSummary("nonexistent", "summary")).toThrow("Entry nonexistent not found");
		});
	});

	describe("getLeafEntry", () => {
		it("returns undefined for empty session", () => {
			const session = SessionManager.inMemory();
			expect(session.getLeafEntry()).toBeUndefined();
		});

		it("returns current leaf entry", () => {
			const session = SessionManager.inMemory();

			session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));

			const leaf = session.getLeafEntry();
			expect(leaf).toBeDefined();
			expect(leaf!.id).toBe(id2);
		});
	});

	describe("getEntry", () => {
		it("returns undefined for non-existent id", () => {
			const session = SessionManager.inMemory();
			expect(session.getEntry("nonexistent")).toBeUndefined();
		});
	});

	describe("buildSessionContext with branches", () => {
		it("returns messages from current branch only", () => {
			const session = SessionManager.inMemory();

			// Main: 1 -> 2 -> 3
			session.appendMessage(userMsg("msg1"));
			const id2 = session.appendMessage(assistantMsg("msg2"));
			session.appendMessage(userMsg("msg3"));

			session.branch(id2);
			session.appendMessage(assistantMsg("msg4-branch"));

			const ctx = session.buildSessionContext();
			expect(ctx.messages).toHaveLength(3); // msg1, msg2, msg4-branch (not msg3)

			expect((ctx.messages[0] as any).content).toBe("msg1");
			expect((ctx.messages[1] as any).content[0].text).toBe("msg2");
			expect((ctx.messages[2] as any).content[0].text).toBe("msg4-branch");
		});
	});
});

describe("createBranchedSession", () => {
	it("throws for non-existent entry", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("hello"));

		expect(() => session.createBranchedSession("nonexistent")).toThrow("Entry nonexistent not found");
	});

	it("extracts correct path from branched tree", () => {
		const session = SessionManager.inMemory();

		const id1 = session.appendMessage(userMsg("1"));
		const id2 = session.appendMessage(assistantMsg("2"));
		session.appendMessage(userMsg("3"));

		session.branch(id2);
		const id4 = session.appendMessage(userMsg("4"));
		const id5 = session.appendMessage(assistantMsg("5"));

		// In-memory branching rebuilds this session (no new file): the entries become the path to id5.
		expect(session.createBranchedSession(id5)).toBeUndefined();

		const entries = session.getEntries();
		expect(entries).toHaveLength(4);
		expect(entries.map((e) => e.id)).toEqual([id1, id2, id4, id5]);
	});

	it("does not duplicate entries when forking from first user message", () => {
		const tempDir = join(tmpdir(), `session-fork-dedup-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		try {
			const session = SessionManager.create(tempDir, tempDir);
			const id1 = session.appendMessage(userMsg("first question"));
			session.appendMessage(assistantMsg("first answer"));
			session.appendMessage(userMsg("second question"));
			session.appendMessage(assistantMsg("second answer"));

			// Fork from the very first user message (no assistant in the branched path)
			const newFile = session.createBranchedSession(id1);
			expect(newFile).toBeDefined();

			// The branched path has no assistant, so the file should not exist yet
			// (deferred to _persist on first assistant, matching newSession() contract)
			expect(existsSync(newFile!)).toBe(false);

			// Simulate extension adding entry before assistant (like preset on turn_start)
			session.appendCustomEntry("preset-state", { name: "plan" });

			// Now the assistant responds
			session.appendMessage(assistantMsg("new answer"));

			expect(existsSync(newFile!)).toBe(true);
			const content = readFileSync(newFile!, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			const records = lines.map((line) => JSON.parse(line));

			expect(records.filter((r) => r.type === "session")).toHaveLength(1);

			const entryIds = records
				.filter((r) => r.type !== "session")
				.map((r) => r.id)
				.filter((id): id is string => typeof id === "string");
			expect(new Set(entryIds).size).toBe(entryIds.length);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("writes file immediately when forking from a point with assistant messages", () => {
		const tempDir = join(tmpdir(), `session-fork-with-assistant-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		try {
			const session = SessionManager.create(tempDir, tempDir);
			session.appendMessage(userMsg("first question"));
			const id2 = session.appendMessage(assistantMsg("first answer"));
			session.appendMessage(userMsg("second question"));
			session.appendMessage(assistantMsg("second answer"));

			// Fork including the assistant message
			const newFile = session.createBranchedSession(id2);
			expect(newFile).toBeDefined();

			expect(existsSync(newFile!)).toBe(true);
			const content = readFileSync(newFile!, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			const records = lines.map((line) => JSON.parse(line));
			expect(records.filter((r) => r.type === "session")).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

// Merged from custom-session-id.test.ts
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("SessionManager session ids", () => {
	it.each<[string, () => SessionManager]>([
		["a freshly constructed session", () => SessionManager.inMemory()],
		[
			"newSession() without options",
			() => {
				const session = SessionManager.inMemory();
				session.newSession();
				return session;
			},
		],
		[
			"newSession() with options but no id",
			() => {
				const session = SessionManager.inMemory();
				session.newSession({ parentSession: "parent.jsonl" });
				return session;
			},
		],
		[
			"a branched session",
			() => {
				const session = SessionManager.inMemory();
				session.createBranchedSession(session.appendMessage(userMsg("hello")));
				return session;
			},
		],
	])("generates a UUIDv7 id for %s", (_name, create) => {
		const session = create();

		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
	});

	it("uses a caller-provided id for the session and its header", () => {
		const session = SessionManager.inMemory();

		session.newSession({ id: "my-custom-id" });

		expect(session.getSessionId()).toBe("my-custom-id");
		expect(session.getHeader()!.id).toBe("my-custom-id");
	});

	it("forks a legacy session file with a fresh UUIDv7 id and migrated entries", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-legacy-fork-"));
		try {
			const sourcePath = join(tempDir, "source.jsonl");
			writeFileSync(
				sourcePath,
				`${[
					JSON.stringify({
						type: "session",
						id: "legacy-session-id",
						timestamp: new Date().toISOString(),
						cwd: tempDir,
					}),
					JSON.stringify({
						type: "message",
						timestamp: new Date().toISOString(),
						message: { role: "user", content: "hello", timestamp: Date.now() },
					}),
				].join("\n")}\n`,
			);

			const forked = SessionManager.forkFrom(sourcePath, tempDir, tempDir);

			const header = forked.getHeader();
			expect(header!.id).toMatch(UUID_V7_RE);
			expect(header!.parentSession).toBe(sourcePath);

			const messageEntries = loadEntriesFromFile(forked.getSessionFile()!).filter(
				(entry) => entry.type === "message",
			);
			expect(messageEntries).toHaveLength(1);
			expect(messageEntries[0]).toMatchObject({ type: "message", parentId: null });
			expect(messageEntries[0]!.id).toEqual(expect.any(String));
			expect(forked.buildSessionContext().messages).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
