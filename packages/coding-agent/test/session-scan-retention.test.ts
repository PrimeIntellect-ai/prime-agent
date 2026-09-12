import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionInfo, SessionManager } from "../src/core/session-manager.js";
import * as fileLines from "../src/utils/file-lines.js";

const timestamp = "2026-01-01T00:00:00Z";
const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};

function assistantLines(count: number, start = 0): string {
	return Array.from({ length: count }, (_, offset) => {
		const index = start + offset;
		return `${JSON.stringify({
			type: "message",
			id: `m${index}`,
			parentId: index === 0 ? null : `m${index - 1}`,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "reply" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				stopReason: "stop",
				timestamp: 1,
				usage,
			},
		})}\n`;
	}).join("");
}

function writeSession(dir: string, id: string, messages: string): string {
	const path = join(dir, `${id}.jsonl`);
	writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: dir, rlmDepth: 0 })}\n`);
	appendFileSync(path, messages);
	return path;
}

const expectedUsage = (count: number) => ({ inputTokens: count, outputTokens: count * 2, cost: count * 3 });

describe("session scan retention", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "session-scan-retention-"));
	});

	afterEach(async () => {
		rmSync(dir, { recursive: true, force: true });
		await SessionManager.listAll(undefined, dir);
		vi.restoreAllMocks();
	});

	it("keeps a 2,000-session catalog with 150,000 usage entries warm across repeated refreshes", async () => {
		const messages = assistantLines(75);
		for (let index = 0; index < 2_000; index++) {
			writeSession(dir, `session-${index.toString().padStart(4, "0")}`, messages);
		}
		const reads = vi.spyOn(fileLines, "readLinesAsBuffers");
		const cold = await SessionManager.listAll(undefined, dir);
		expect(cold).toHaveLength(2_000);
		expect(cold.every((session) => session.messageCount === 75)).toBe(true);
		expect(cold[0]?.usage).toEqual(expectedUsage(75));
		expect(reads).toHaveBeenCalledTimes(2_000);

		reads.mockClear();
		for (let pass = 0; pass < 3; pass++) {
			expect(await SessionManager.listAll(undefined, dir)).toEqual(cold);
		}
		expect(reads, "unchanged catalog refreshes must not reopen transcripts").not.toHaveBeenCalled();
	});

	it("evicts the least recently used state when appended usage exceeds the retained bound", async () => {
		const count = 100_000;
		const messages = assistantLines(count);
		const paths = ["a", "b", "c", "d"].map((id) => writeSession(dir, id, messages));
		for (const path of paths) {
			expect((await readSessionInfo(path))?.usage).toEqual(expectedUsage(count));
		}
		const [a, b, c, d] = paths;
		const reads = vi.spyOn(fileLines, "readLinesAsBuffers");
		await readSessionInfo(a);
		expect(reads).not.toHaveBeenCalled();

		const start = statSync(a).size;
		appendFileSync(a, assistantLines(1, count));
		const appended = await readSessionInfo(a);
		expect(appended?.messageCount).toBe(count + 1);
		expect(appended?.usage).toEqual(expectedUsage(count + 1));
		expect(reads).toHaveBeenCalledExactlyOnceWith(a, { start, end: statSync(a).size - 1 });

		reads.mockClear();
		for (const path of [c, d, a]) await readSessionInfo(path);
		expect(reads).not.toHaveBeenCalled();
		expect((await readSessionInfo(b))?.usage).toEqual(expectedUsage(count));
		expect(reads).toHaveBeenCalledExactlyOnceWith(b, { start: 0, end: statSync(b).size - 1 });
	});

	it.each(["missing read", "directory listing", "missing directory"])(
		"releases usage entries after removal detected by %s",
		async (mode) => {
			const messages = assistantLines(100_000);
			const survivor = writeSession(dir, "a", messages);
			const others = ["b", "c"].map((id) => writeSession(dir, id, messages));
			const removedDir = mode === "missing directory" ? join(dir, "removed") : dir;
			mkdirSync(removedDir, { recursive: true });
			const removed = writeSession(removedDir, "d", messages);
			for (const path of [survivor, ...others, removed]) await readSessionInfo(path);

			rmSync(mode === "missing directory" ? removedDir : removed, { recursive: true });
			if (mode === "missing read") {
				expect(await readSessionInfo(removed)).toBeNull();
			} else if (mode === "missing directory") {
				expect(await SessionManager.listAll(undefined, removedDir)).toEqual([]);
			} else {
				expect(await SessionManager.listAll(undefined, dir)).toHaveLength(3);
			}

			const replacement = writeSession(dir, "e", messages);
			expect((await readSessionInfo(replacement))?.usage).toEqual(expectedUsage(100_000));
			const reads = vi.spyOn(fileLines, "readLinesAsBuffers");
			expect((await readSessionInfo(survivor))?.usage).toEqual(expectedUsage(100_000));
			expect(reads, "removed states must not consume the surviving catalog's budget").not.toHaveBeenCalled();
		},
	);
});
