import { fauxAssistantMessage, fauxToolCall, type UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildActCallerHistory, layoutActHistoryText } from "../src/core/act-history-snapshot.js";
import type { SessionEntry, SessionEntryBase } from "../src/core/session-manager.js";

function base(id: string, parentId: string | null): SessionEntryBase {
	return { type: "test", id, parentId, timestamp: "2026-08-11T00:00:00.000Z" };
}

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
	const message: UserMessage = { role: "user", content: text, timestamp: 0 };
	return { ...base(id, parentId), type: "message", message };
}

function callEntry(id: string, parentId: string | null, toolCallId: string, text: string): SessionEntry {
	return {
		...base(id, parentId),
		type: "message",
		message: fauxAssistantMessage(fauxToolCall("shared_ipython", { code: text }, { id: toolCallId })),
	};
}

describe("Act caller history snapshots", () => {
	it("renders only messages after the previous same-depth Act", () => {
		const entries: SessionEntry[] = [
			userEntry("before", null, "before the first act"),
			callEntry("previous", "before", "previous-call", "previous act"),
			userEntry("between", "previous", "between outer acts"),
			userEntry("nested-result", "between", "after nested act"),
			callEntry("current", "nested-result", "current-call", "current act"),
		];
		const history = buildActCallerHistory(entries, "current-call", "previous-call");

		expect(history.text).toContain("between outer acts");
		expect(history.text).toContain("after nested act");
		expect(history.text).not.toContain("before the first act");
		expect(history.messageCount).toBe(2);
		expect(history.images).toHaveLength(1);
		const png = Buffer.from(history.images[0]?.data ?? "", "base64");
		expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		expect(png.readUInt32BE(16)).toBe(1280);
		expect(png.readUInt32BE(20)).toBe(1280);
	});

	it("uses caller tool-call boundaries without including the current call", () => {
		const entries: SessionEntry[] = [
			callEntry("previous", null, "previous-call", "previous act"),
			userEntry("delta", "previous", "between calls"),
			callEntry("current", "delta", "current-call", "current act"),
		];
		const history = buildActCallerHistory(entries, "current-call", "previous-call");

		expect(history.text).toContain("between calls");
		expect(history.text).not.toContain("current act");
		expect(history.text).not.toContain("previous act");
	});

	it("returns no frame before the first Act at a depth", () => {
		const history = buildActCallerHistory([userEntry("only", null, "root context")]);

		expect(history).toEqual({ text: "", images: [], messageCount: 0, truncated: false });
	});

	it("bounds long deltas to eight frames with an elision marker", () => {
		const history = buildActCallerHistory(
			[
				callEntry("previous", null, "previous-call", "previous act"),
				userEntry("large", "previous", "x".repeat(100_000)),
				callEntry("current", "large", "current-call", "current act"),
			],
			"current-call",
			"previous-call",
		);

		expect(history.truncated).toBe(true);
		expect(history.text).toContain("characters elided");
		expect(history.images).toHaveLength(8);
	});

	it("preserves the tail when newlines consume the frame budget", () => {
		const layout = layoutActHistoryText(`${"line\n".repeat(1_000)}TAIL_TOKEN`);

		expect(layout.truncated).toBe(true);
		expect(layout.pages).toHaveLength(8);
		expect(layout.pages.at(-1)).toContain("TAIL_TOKEN");
	});

	it("starts the next line at column zero after an exact-width line", () => {
		const layout = layoutActHistoryText(`${"x".repeat(128)}\nY`);

		expect(layout.pages.join("").indexOf("Y")).toBe(128);
	});
});
