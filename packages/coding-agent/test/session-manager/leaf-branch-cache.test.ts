import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

// SessionManager caches the live leaf's branch path (getBranch() reads) because
// agent-session re-reads it on every assistant message end. These tests pin the
// cache's contract: identical reads share the array, appends extend it, every
// other leaf move drops it, and non-leaf reads never poison it.
describe("SessionManager leaf branch cache", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	function persistedSession(): SessionManager {
		const dir = mkdtempSync(join(tmpdir(), "pi-leaf-branch-cache-"));
		tempDirs.push(dir);
		return SessionManager.create(dir, join(dir, "sessions"));
	}

	const ids = (session: SessionManager) => session.getBranch().map((entry) => entry.id);

	// Walks the served path and checks it against the byId parent chain, so a
	// stale or half-extended cache cannot pass by returning the right ids only.
	function expectChainMatches(session: SessionManager, expected: string[]): void {
		const branch = session.getBranch();
		expect(branch.map((entry) => entry.id)).toEqual(expected);
		for (let index = 1; index < branch.length; index++) {
			expect(branch[index]!.parentId).toBe(branch[index - 1]!.id);
			expect(session.getEntry(branch[index]!.id)).toBe(branch[index]);
		}
	}

	function seedTwo() {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage(userMsg("one"));
		const secondId = session.appendMessage(assistantMsg("two"));
		return { session, firstId, secondId };
	}

	it("serves one shared cached array that appends extend in place", () => {
		const { session, firstId, secondId } = seedTwo();
		const first = session.getBranch();
		expect(session.getBranch()).toBe(first); // repeated leaf reads share the array
		expect(first.map((entry) => entry.id)).toEqual([firstId, secondId]);

		const thirdId = session.appendCustomMessageEntry("note", "hello", false);
		expectChainMatches(session, [firstId, secondId, thirdId]);
		// An append extends the same array the earlier read handed out.
		expect(session.getBranch()).toBe(first);

		const fourthId = session.appendMessage(userMsg("four"));
		expectChainMatches(session, [firstId, secondId, thirdId, fourthId]);
	});

	it("drops the cache on every leaf-changing operation and re-caches the new path", () => {
		const { session, firstId, secondId } = seedTwo();
		expect(ids(session)).toEqual([firstId, secondId]); // populates the cache

		// branch(): the abandoned path must not leak, and a sibling append re-roots.
		session.branch(firstId);
		expectChainMatches(session, [firstId]);
		const siblingId = session.appendMessage(userMsg("sibling"));
		expectChainMatches(session, [firstId, siblingId]);
		// Branching back to the abandoned entry must not resurrect the old cache.
		session.branch(secondId);
		expectChainMatches(session, [firstId, secondId]);

		// resetLeaf(): an empty branch, then the next append re-roots the tree.
		session.resetLeaf();
		expect(session.getLeafId()).toBeNull();
		expect(session.getBranch()).toEqual([]);
		const rootId = session.appendMessage(userMsg("root again"));
		expect(session.getEntry(rootId)?.parentId).toBeNull();
		expectChainMatches(session, [rootId]);

		// branchWithSummary(): the summary entry becomes the new leaf, and the
		// compaction appended after it lands on the summarized branch.
		const summaryId = session.branchWithSummary(secondId, "summary of the abandoned path");
		expectChainMatches(session, [firstId, secondId, summaryId]);
		const compactionId = session.appendCompaction("compaction summary", rootId, 1234, {
			readFiles: [],
			modifiedFiles: [],
		});
		expectChainMatches(session, [firstId, secondId, summaryId, compactionId]);
	});

	it("returns the correct suffix for a mid-branch read without poisoning the leaf cache", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage(userMsg("one"));
		const secondId = session.appendMessage(assistantMsg("two"));
		const thirdId = session.appendMessage(userMsg("three"));
		const fourthId = session.appendMessage(assistantMsg("four"));

		const leafPath = session.getBranch();
		expect(ids(session)).toEqual([firstId, secondId, thirdId, fourthId]);

		const suffix = session.getBranch(secondId);
		expect(suffix.map((entry) => entry.id)).toEqual([firstId, secondId]);
		expect(suffix).not.toBe(leafPath);

		// The mid-branch read must not have replaced the cached leaf path...
		expect(session.getBranch()).toBe(leafPath);
		// ...nor cached a suffix as if it were the leaf path.
		const fifthId = session.appendMessage(userMsg("five"));
		expectChainMatches(session, [firstId, secondId, thirdId, fourthId, fifthId]);
	});

	it("rolls a failed append back out of a held branch array and recovers on the next append and reload", () => {
		const session = persistedSession();
		const firstId = session.appendMessage(userMsg("one"));
		const held = session.getBranch(); // the live cached array

		// The append persists, so it reaches the cached array in place...
		vi.spyOn(session, "flushNow").mockImplementationOnce(() => {
			throw new Error("flush failed");
		});
		expect(() => session.appendCustomMessageEntryWithRollback("note", "unsaved", false)).toThrow("flush failed");

		// ...and the rollback takes it back out of that same array.
		expect(held.map((entry) => entry.id)).toEqual([firstId]);
		expect(session.getLeafId()).toBe(firstId);
		expectChainMatches(session, [firstId]);

		// A failing persist never extends the cache in the first place.
		const heldAgain = session.getBranch();
		vi.spyOn(session, "_persist").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		expect(() => session.appendCustomMessageEntryWithRollback("note", "unsaved again", false)).toThrow("disk full");

		expect(heldAgain.map((entry) => entry.id)).toEqual([firstId]);
		expectChainMatches(session, [firstId]);

		// The next append starts from the rolled-back leaf and stays coherent (its assistant entry also writes the file).
		const secondId = session.appendMessage(assistantMsg("two"));
		expectChainMatches(session, [firstId, secondId]);
		session.setSessionFile(session.getSessionFile()!); // same path, same leaf id, fresh entry objects
		expectChainMatches(session, [firstId, secondId]); // the served objects are the reloaded ones
	});
});
