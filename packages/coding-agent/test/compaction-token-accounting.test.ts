import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { estimateEntryTokens, estimateTextTokens, findCutPoint } from "../src/core/compaction/compaction.js";
import type { SessionEntry } from "../src/core/session-manager.js";

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function messageEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-09T00:00:00.000Z",
		message: userMessage(text),
	};
}

describe("compaction token accounting", () => {
	it("preserves ASCII word behavior while charging code punctuation and Korean conservatively", () => {
		expect(estimateTextTokens("abcd")).toBe(1);
		expect(estimateTextTokens("{}[](),:;")).toBe(5);
		expect(estimateTextTokens("가나다라")).toBe(8);
		expect(estimateTextTokens("abc가")).toBe(3);
	});

	it("counts custom messages that participate in rebuilt context", () => {
		const entries: SessionEntry[] = [
			messageEntry("m1", null, "old"),
			{
				type: "custom_message",
				id: "c1",
				parentId: "m1",
				timestamp: "2026-08-09T00:00:01.000Z",
				customType: "checkpoint",
				content: "한".repeat(100),
				display: false,
			},
			messageEntry("m2", "c1", "new"),
		];

		expect(estimateEntryTokens(entries[1])).toBe(200);
		expect(findCutPoint(entries, 0, entries.length, 50)).toMatchObject({
			firstKeptEntryIndex: 1,
			turnStartIndex: 1,
			isSplitTurn: true,
		});
	});

	it("counts branch summaries and ignores metadata-only custom entries", () => {
		const entries: SessionEntry[] = [
			messageEntry("m1", null, "old"),
			{
				type: "branch_summary",
				id: "b1",
				parentId: "m1",
				timestamp: "2026-08-09T00:00:01.000Z",
				fromId: "other-branch",
				summary: "분기요약".repeat(30),
			},
			messageEntry("m2", "b1", "new"),
		];
		const metadataOnly: SessionEntry = {
			type: "custom",
			id: "state1",
			parentId: "b1",
			timestamp: "2026-08-09T00:00:02.000Z",
			customType: "state",
			data: { large: "한".repeat(100) },
		};

		expect(estimateEntryTokens(entries[1])).toBeGreaterThan(50);
		expect(estimateEntryTokens(metadataOnly)).toBe(0);
		expect(findCutPoint(entries, 0, entries.length, 50)).toMatchObject({
			firstKeptEntryIndex: 1,
			turnStartIndex: 1,
			isSplitTurn: true,
		});
	});
});
