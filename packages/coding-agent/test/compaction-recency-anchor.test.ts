import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact, generateSummary } from "../src/core/compaction/index.js";
import { createFileOps } from "../src/core/compaction/utils.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning = false): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-Reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

function promptOfCall(callIndex: number): string {
	const call = completeSimpleMock.mock.calls[callIndex]!;
	const options = call[1] as {
		messages: { content: Array<{ type: string; text?: string }> }[];
	};
	return options.messages[0].content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block)
		.map((block) => block.text)
		.join("\n");
}

const conversationMessages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary recency anchor", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("includes the recency anchor block when an anchor is provided", async () => {
		await generateSummary(
			conversationMessages,
			createModel(),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			"## Goal\nprevious summary",
			undefined,
			undefined,
			undefined,
			"the widget shipped and all tests pass",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const prompt = promptOfCall(0);
		expect(prompt).toContain("<recent-state-anchor>");
		expect(prompt).toContain("</recent-state-anchor>");
		expect(prompt).toContain("the widget shipped and all tests pass");
		expect(prompt).toContain("retained messages below are authoritative");
		// The anchor is data: it lands after the previous summary, before the instructions.
		expect(prompt.indexOf("</previous-summary>")).toBeLessThan(prompt.indexOf("<recent-state-anchor>"));
		expect(prompt.indexOf("</recent-state-anchor>")).toBeLessThan(prompt.indexOf("Use this EXACT format"));
	});

	it("omits the anchor block when no anchor is provided", async () => {
		await generateSummary(
			conversationMessages,
			createModel(),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			"## Goal\nprevious summary",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(promptOfCall(0)).not.toContain("<recent-state-anchor>");
	});
});

describe("compact recency anchor wiring", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	function createPreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
		const fileOps = createFileOps();
		fileOps.edited.add("pkg/fix.ts");
		return {
			firstKeptEntryId: "kept-1",
			messagesToSummarize: conversationMessages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1234,
			// prepareCompaction strips file-list blocks before this value reaches the update prompt.
			previousSummary: "## Goal\nship the widget",
			recentStateAnchor: "widget shipped, tests green",
			fileOps,
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
			...overrides,
		};
	}

	it("passes the anchor into the history summarization call and appends fresh file lists once", async () => {
		const result = await compact(createPreparation(), createModel(), "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const prompt = promptOfCall(0);
		expect(prompt).toContain("<recent-state-anchor>\nNewest assistant message");
		expect(prompt).toContain("widget shipped, tests green");
		expect(prompt).toContain("retained messages below are authoritative");
		expect(prompt).toContain("<previous-summary>\n## Goal\nship the widget");

		// Exactly one fresh file-list append; details stay the source of truth.
		expect(result.summary).toBe("## Goal\nTest summary\n\n<modified-files>\npkg/fix.ts\n</modified-files>");
		expect(result.details).toEqual({ readFiles: [], modifiedFiles: ["pkg/fix.ts"] });
	});

	it("anchors the history slice (not the turn-prefix slice) of a split turn", async () => {
		const preparation = createPreparation({
			isSplitTurn: true,
			turnPrefixMessages: conversationMessages,
		});

		const result = await compact(preparation, createModel(), "test-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		const historyPrompt = promptOfCall(0);
		const turnPrefixPrompt = promptOfCall(1);
		expect(historyPrompt).toContain("<recent-state-anchor>");
		expect(historyPrompt).toContain("widget shipped, tests green");
		// The turn-prefix call summarizes a prefix of the retained turn; its own
		// prompt already frames the retained suffix, and no anchor is injected.
		expect(turnPrefixPrompt).toContain("PREFIX of a turn");
		expect(turnPrefixPrompt).not.toContain("<recent-state-anchor>");

		// Split-turn summary format is unchanged, with one fresh file append.
		expect(result.summary).toBe(
			"## Goal\nTest summary\n\n---\n\n**Turn Context (split turn):**\n\n## Goal\nTest summary\n\n<modified-files>\npkg/fix.ts\n</modified-files>",
		);
	});

	it("compacts without an anchor and without file operations", async () => {
		const preparation = createPreparation({
			recentStateAnchor: undefined,
			previousSummary: undefined,
			fileOps: createFileOps(),
		});
		const result = await compact(preparation, createModel(), "test-key");

		expect(promptOfCall(0)).not.toContain("<recent-state-anchor>");
		expect(promptOfCall(0)).not.toContain("<previous-summary>");
		expect(result.summary).toBe("## Goal\nTest summary");
		expect(result.details).toEqual({ readFiles: [], modifiedFiles: [] });
	});
});
