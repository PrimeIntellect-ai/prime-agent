import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type * as PiAi from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHarnessState, planRefinement } from "../../../src/core/refinement/index.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

describe("issue #1290 refiner overview truncation: entries cut to the per-entry window must be marked", () => {
	let tempDir: string | undefined;

	beforeEach(() => {
		completeSimpleMock.mockReset();
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	function makeTempDir(): string {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-1290-"));
		return tempDir;
	}

	function assistantText(text: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "prime-inference",
			model: "openai/gpt-5.5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function createRefineModel(): Model<"openai-completions"> {
		return {
			id: "openai/gpt-5.5",
			name: "GPT 5.5",
			api: "openai-completions",
			provider: "prime-inference",
			baseUrl: "https://inference.primeintellect.ai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		};
	}

	it("tells the refiner when an entry is longer than the overview shows", async () => {
		const state = loadHarnessState(makeTempDir(), "local");
		const visibleHead = "OPERATING PROCEDURE - do not restate blocks already recorded here.";
		const hiddenTail = "SUBAGENT LIFECYCLE: delete an action's children only at an approved boundary.";
		state.entries.prompt.long_note = {
			id: "long_note",
			kind: "prompt",
			title: "Long note",
			content: `${visibleHead} ${"filler clause. ".repeat(60)}${hiddenTail}`,
			path: "general",
			scope: "local",
			reference: {},
			arguments: {},
			metadata: {},
			source: "agent",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			version: 1,
		};

		completeSimpleMock.mockResolvedValueOnce(
			assistantText(JSON.stringify({ summary: "no-op", rationale: "none", expectedOutcome: "none", edits: [] })),
		);

		await planRefinement(
			[{ role: "user", content: "consider the long note", timestamp: Date.now() } satisfies AgentMessage],
			state,
			[],
			createRefineModel(),
			"api-key",
			{},
		);

		const userPrompt: string = completeSimpleMock.mock.calls[0][1].messages[0].content[0].text;
		const entryLine = userPrompt.split("\n").find((line: string) => line.includes("[local:long_note]"));

		expect(entryLine).toBeDefined();
		expect(entryLine).toContain(visibleHead);
		// The tail sits beyond the per-entry window, so the refiner never receives it.
		expect(userPrompt).not.toContain(hiddenTail);
		// An update replaces the whole entry, so a refiner that cannot tell a fragment
		// from a complete entry will silently drop everything it was not shown.
		expect(entryLine).toMatch(/\.\.\.|not shown|truncated/);
	});

	it("tells the refiner that an update replaces the entry and what the truncation marker means", async () => {
		const state = loadHarnessState(makeTempDir(), "local");
		completeSimpleMock.mockResolvedValueOnce(
			assistantText(JSON.stringify({ summary: "no-op", rationale: "none", expectedOutcome: "none", edits: [] })),
		);

		await planRefinement(
			[{ role: "user", content: "anything", timestamp: Date.now() } satisfies AgentMessage],
			state,
			[],
			createRefineModel(),
			"api-key",
			{},
		);

		const request = completeSimpleMock.mock.calls[0][1];
		expect(request.systemPrompt).toContain("replaces the entry's entire");
		expect(request.systemPrompt).toContain("chars not shown");
	});
});
