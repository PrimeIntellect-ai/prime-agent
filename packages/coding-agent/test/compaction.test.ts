import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { readFileSync } from "fs";
import { join } from "path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	findCutPoint,
	prepareCompaction,
	shouldCompact,
} from "../src/core/compaction/index.js";
import { serializeConversation } from "../src/core/compaction/utils.js";
import {
	buildSessionContext,
	type CompactionEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionMessageEntry,
} from "../src/core/session-manager.js";

// ============================================================================
// Test fixtures
// ============================================================================

function loadLargeSessionEntries(): SessionEntry[] {
	const sessionPath = join(__dirname, "fixtures/large-session.jsonl");
	const content = readFileSync(sessionPath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries); // Add id/parentId for v1 fixtures
	return entries.filter((e): e is SessionEntry => e.type !== "session");
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

let entryCounter = 0;
let lastId: string | null = null;

function resetEntryCounter() {
	entryCounter = 0;
	lastId = null;
}

// Reset counter before each test to get predictable IDs
beforeEach(() => {
	resetEntryCounter();
});

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function createCompactionEntry(summary: string, firstKeptEntryId: string): CompactionEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
	};
	lastId = id;
	return entry;
}

function extractText(messages: AgentMessage[]): string {
	return messages
		.map((message) => {
			switch (message.role) {
				case "user":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "assistant":
					return message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join(" ");
				case "branchSummary":
				case "compactionSummary":
					return message.summary;
				case "custom":
				case "toolResult":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "bashExecution":
					return `${message.command}\n${message.output}`;
				default:
					return "";
			}
		})
		.join("\n");
}

// ============================================================================
// Unit tests
// ============================================================================

describe("shouldCompact", () => {
	const settings: CompactionSettings = { enabled: true, reserveTokens: 10000, keepRecentTokens: 20000 };

	it.each([
		["context exceeds the threshold", settings, 95000, 100000, true],
		["context is below the threshold", settings, 89000, 100000, false],
		["compaction is disabled", { ...settings, enabled: false }, 95000, 100000, false],
		["the context window is unknown", settings, 95000, 0, false],
	])("returns %s => %s when %s", (_label, config, contextTokens, contextWindow, expected) => {
		expect(shouldCompact(contextTokens, contextWindow, config)).toBe(expected);
	});
});

describe("findCutPoint", () => {
	const hugeToolResult = () => ({
		role: "toolResult" as const,
		toolCallId: "tc1",
		toolName: "ipython",
		content: [{ type: "text" as const, text: "x".repeat(40_000) }],
		isError: false,
		timestamp: Date.now(),
	});

	// The final assistant run alone blows the budget, so the cut lands on an
	// assistant message mid-turn.
	const splitTurn = (): SessionEntry[] => [
		createMessageEntry(createUserMessage("Turn 1")),
		createMessageEntry(createAssistantMessage("A1")),
		createMessageEntry(createUserMessage("Turn 2")), // index 2: turn start
		createMessageEntry(createAssistantMessage("x".repeat(40_000))),
		createMessageEntry(createAssistantMessage("x".repeat(40_000))), // index 4: cut here
	];

	it.each([
		[
			"keeps everything when the range holds no valid cut point",
			() => [createMessageEntry(createAssistantMessage("a"))],
			1000,
			{ firstKeptEntryIndex: 0 },
		],
		[
			"keeps everything when the whole history fits the budget",
			(): SessionEntry[] => [
				createMessageEntry(createUserMessage("1")),
				createMessageEntry(createAssistantMessage("a", createMockUsage(0, 50, 500, 0))),
				createMessageEntry(createUserMessage("2")),
				createMessageEntry(createAssistantMessage("b", createMockUsage(0, 50, 1000, 0))),
			],
			50000,
			{ firstKeptEntryIndex: 0 },
		],
		[
			// The budget is crossed inside the trailing tool results, past every cut
			// point; the whole history must not be silently kept.
			"keeps only the final turn when the budget is crossed inside trailing tool results",
			(): SessionEntry[] => [
				createMessageEntry(createUserMessage("Turn 1")),
				createMessageEntry(createAssistantMessage("A1", createMockUsage(0, 100, 1000, 0))),
				createMessageEntry(createUserMessage("Turn 2")),
				createMessageEntry(createAssistantMessage("A2", createMockUsage(0, 100, 2000, 0))), // last cut point
				createMessageEntry(hugeToolResult()),
				createMessageEntry(hugeToolResult()),
			],
			1000,
			{ firstKeptEntryIndex: 3 },
		],
		[
			"reports a split turn when the cut lands inside an assistant run",
			splitTurn,
			3000,
			{ firstKeptEntryIndex: 4, isSplitTurn: true, turnStartIndex: 2 },
		],
	])("%s", (_label, makeEntries, keepRecentTokens, expected) => {
		const entries = makeEntries();
		const result = findCutPoint(entries, 0, entries.length, keepRecentTokens);
		expect(result).toMatchObject(expected);
	});
});

describe("prepareCompaction with small sessions", () => {
	it("returns undefined when everything fits in the keep-recent window", () => {
		// Session well under keepRecentTokens (20k default): nothing to summarize,
		// so compaction should be skipped instead of summarizing an empty conversation
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("hello")),
			createMessageEntry(createAssistantMessage("hi there", createMockUsage(5000, 1000))),
			createMessageEntry(createUserMessage("how are you")),
			createMessageEntry(createAssistantMessage("great", createMockUsage(8000, 2000))),
		];

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeUndefined();
	});
});

describe("prepareCompaction with previous compaction", () => {
	it("should preserve kept messages across repeated compactions when they still fit", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)"));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1"));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1"));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2"));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1"));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3", createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1)"));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4", createMockUsage(8000, 2000)));

		const pathEntries = [u1, a1, u2, a2, u3, a3, compaction1, u4, a4];
		const contextBefore = buildSessionContext(pathEntries);
		const preparation = prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toBeDefined();
		expect(preparation!.firstKeptEntryId).toBe(u2.id);
		expect(preparation!.previousSummary).toBe("First summary");
		expect(extractText(preparation!.messagesToSummarize)).not.toContain("First summary");
		expect(preparation!.tokensBefore).toBe(estimateContextTokens(contextBefore.messages).tokens);

		const compaction2: CompactionEntry = {
			type: "compaction",
			id: "compaction2-id",
			parentId: a4.id,
			timestamp: new Date().toISOString(),
			summary: "Second summary",
			firstKeptEntryId: preparation!.firstKeptEntryId,
			tokensBefore: preparation!.tokensBefore,
		};
		const contextAfter = buildSessionContext([...pathEntries, compaction2]);
		const contextAfterText = extractText(contextAfter.messages);

		expect(contextAfterText).toContain("user msg 2 - kept by compaction1");
		expect(contextAfterText).toContain("user msg 3 - kept by compaction1");
	});

	it("should re-summarize previously kept messages when the recent window moves past them", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)".repeat(4)));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1".repeat(4)));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1 ".repeat(12)));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2 ".repeat(12)));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1 ".repeat(12)));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3 ".repeat(12), createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1) ".repeat(12)));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4 ".repeat(12), createMockUsage(8000, 2000)));

		const settings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 100,
		};
		const preparation = prepareCompaction([u1, a1, u2, a2, u3, a3, compaction1, u4, a4], settings);

		expect(preparation).toBeDefined();
		const summarizedText = extractText(preparation!.messagesToSummarize);
		expect(summarizedText).toContain("user msg 2 - kept by compaction1");
		expect(summarizedText).toContain("user msg 3 - kept by compaction1");
		expect(summarizedText).not.toContain("First summary");
		expect(preparation!.previousSummary).toBe("First summary");
	});
});

// ============================================================================
// Integration tests with real session data
// ============================================================================

describe("Large session fixture", () => {
	it("should parse the large session", () => {
		const entries = loadLargeSessionEntries();
		expect(entries.length).toBeGreaterThan(100);

		const messageCount = entries.filter((e) => e.type === "message").length;
		expect(messageCount).toBeGreaterThan(100);
	});

	it("should find cut point in large session", () => {
		const entries = loadLargeSessionEntries();
		const result = findCutPoint(entries, 0, entries.length, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);

		// Cut point should be at a message entry (user or assistant)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should load session correctly", () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);

		expect(loaded.messages.length).toBeGreaterThan(100);
		expect(loaded.model).not.toBeNull();
	});
});

// ============================================================================
// LLM integration tests (skipped without API key)
// ============================================================================
// ============================================================================
// Conversation serialization (merged from compaction-serialization.test.ts)
// ============================================================================

function toolResult(text: string): Message {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "ipython",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("serializeConversation", () => {
	it("truncates long tool results keeping head and tail within the summary budget", () => {
		const head = "A".repeat(1431);
		const tail = "T".repeat(500);
		const result = serializeConversation([toolResult(head + "B".repeat(3069) + tail)]);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain(head);
		expect(result).toContain(tail);
		expect(result).toContain("[... 3069 characters truncated; first 1431 and last 500 kept ...]");
		expect(result).not.toContain("B".repeat(10));
		expect(result.length).toBeLessThanOrEqual("[Tool result]: ".length + 2000);
	});

	it("leaves short tool results untouched", () => {
		const shortContent = "x".repeat(1500);

		expect(serializeConversation([toolResult(shortContent)])).toBe(`[Tool result]: ${shortContent}`);
	});

	it("does not truncate user or assistant messages", () => {
		const longText = "y".repeat(5000);
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const result = serializeConversation([
			{ role: "user", content: [{ type: "text", text: longText }], timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
		]);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
