import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type * as PiAi from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyRefinementProposal,
	type HarnessEntryIdentity,
	loadHarnessState,
	planRefinement,
	reviewAutoRefine,
} from "../../../src/core/refinement/index.js";

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

	it("passes the rendered harness overview to the auto-refine reviewer", async () => {
		const state = loadHarnessState(makeTempDir(), "local");
		const distinctiveToken = "REVIEW_OVERVIEW_DISTINCTIVE_TOKEN";
		state.entries.prompt.card = {
			id: "card",
			kind: "prompt",
			title: "Card",
			content: distinctiveToken,
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
			assistantText(JSON.stringify({ shouldRefine: true, rationale: "review-visible" })),
		);

		const review = await reviewAutoRefine(
			[{ role: "user", content: "review the trajectory", timestamp: Date.now() } satisfies AgentMessage],
			state,
			[],
			createRefineModel(),
			"api-key",
			{ reason: "turn_interval", turnsSinceLastReview: 1 },
		);

		const requestText: string = completeSimpleMock.mock.calls[0][1].messages[0].content[0].text;
		const overviewStart = requestText.indexOf("<current_harness_state>");
		const overviewEnd = requestText.indexOf("</current_harness_state>", overviewStart);
		expect(overviewStart).toBeGreaterThanOrEqual(0);
		expect(overviewEnd).toBeGreaterThan(overviewStart);
		const overviewBlock = requestText.slice(overviewStart, overviewEnd);
		expect(overviewBlock).toContain(`- [local:prompt:card] Card (general, v1): ${distinctiveToken}`);
		expect(overviewBlock).toContain(distinctiveToken);
		expect(overviewBlock).not.toContain("[object Object]");
		expect(review).toMatchObject({ shouldRefine: true, rationale: "review-visible" });
	});

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
		const entryLine = userPrompt.split("\n").find((line: string) => line.includes("[local:prompt:long_note]"));

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

	it("expands an entry on request and applies the update it could not otherwise make", async () => {
		const state = loadHarnessState(makeTempDir(), "local");
		const tail = "SUBAGENT LIFECYCLE: delete children only at an approved boundary.";
		state.entries.prompt.long_note = {
			id: "long_note",
			kind: "prompt",
			title: "Long note",
			content: `HEAD. ${"filler clause. ".repeat(60)}${tail}`,
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

		completeSimpleMock
			.mockResolvedValueOnce(assistantText(JSON.stringify({ expand: ["local:prompt:long_note"] })))
			.mockResolvedValueOnce(
				assistantText(
					JSON.stringify({
						summary: "s",
						rationale: "r",
						expectedOutcome: "e",
						edits: [
							{
								action: "update",
								kind: "prompt",
								id: "long_note",
								title: "Long note",
								content: "rewritten in full",
							},
						],
					}),
				),
			);

		const plan = await planRefinement(
			[{ role: "user", content: "update the long note", timestamp: Date.now() } satisfies AgentMessage],
			state,
			[],
			createRefineModel(),
			"api-key",
			{},
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		// Round two must carry the prior assistant turn plus the expanded entry.
		const second = completeSimpleMock.mock.calls[1][1];
		expect(second.messages).toHaveLength(3);
		expect(second.messages[1].role).toBe("assistant");
		expect(second.messages[2].content[0].text).toContain(tail);
		expect(plan.fullyVisibleIds?.has("local:prompt:long_note")).toBe(true);

		const result = applyRefinementProposal(state, plan.proposal, { id: "r1", fullyVisibleIds: plan.fullyVisibleIds });
		expect(result.appliedEdits[0].applied).toBe(true);
		expect(state.entries.prompt.long_note.content).toBe("rewritten in full");
	});

	it("refuses an update to an entry the refiner never saw in full", () => {
		const state = loadHarnessState(makeTempDir(), "local");
		state.entries.prompt.long_note = {
			id: "long_note",
			kind: "prompt",
			title: "Long note",
			content: "x".repeat(2000),
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

		const result = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "e",
				edits: [{ action: "update", kind: "prompt", id: "long_note", title: "Long note", content: "short delta" }],
			},
			{ id: "r2", fullyVisibleIds: new Set<HarnessEntryIdentity>() },
		);

		expect(result.appliedEdits[0]).toMatchObject({
			applied: false,
			error: "entry was not shown in full; update refused",
		});
		expect(state.entries.prompt.long_note.content).toHaveLength(2000);
	});

	it("lets the refiner update a short entry without an expansion round", async () => {
		const state = loadHarnessState(makeTempDir(), "local");
		state.entries.memory.card = {
			id: "card",
			kind: "memory",
			title: "Card",
			content: "A short routing card.",
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
			assistantText(
				JSON.stringify({
					summary: "s",
					rationale: "r",
					expectedOutcome: "e",
					edits: [{ action: "update", kind: "memory", id: "card", title: "Card", content: "A shorter card." }],
				}),
			),
		);

		const plan = await planRefinement(
			[{ role: "user", content: "tighten the card", timestamp: Date.now() } satisfies AgentMessage],
			state,
			[],
			createRefineModel(),
			"api-key",
			{},
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(plan.fullyVisibleIds?.has("local:memory:card")).toBe(true);
		const result = applyRefinementProposal(state, plan.proposal, { id: "r3", fullyVisibleIds: plan.fullyVisibleIds });
		expect(result.appliedEdits[0].applied).toBe(true);
	});

	it("expands several entries at once and across rounds", async () => {
		const state = loadHarnessState(makeTempDir(), "local");
		for (const name of ["alpha", "beta", "gamma"]) {
			state.entries.prompt[name] = {
				id: name,
				kind: "prompt",
				title: name,
				content: `${name.toUpperCase()} head. ${"filler. ".repeat(60)}${name}-tail`,
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
		}

		completeSimpleMock
			.mockResolvedValueOnce(assistantText(JSON.stringify({ expand: ["local:prompt:alpha", "local:prompt:beta"] })))
			.mockResolvedValueOnce(assistantText(JSON.stringify({ expand: ["local:prompt:gamma"] })))
			.mockResolvedValueOnce(
				assistantText(
					JSON.stringify({
						summary: "s",
						rationale: "r",
						expectedOutcome: "e",
						edits: [
							{ action: "update", kind: "prompt", id: "alpha", title: "alpha", content: "A" },
							{ action: "update", kind: "prompt", id: "gamma", title: "gamma", content: "G" },
						],
					}),
				),
			);

		const plan = await planRefinement(
			[{ role: "user", content: "revise these", timestamp: Date.now() } satisfies AgentMessage],
			state,
			[],
			createRefineModel(),
			"api-key",
			{},
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(3);
		const round2 = completeSimpleMock.mock.calls[1][1].messages[2].content[0].text;
		expect(round2).toContain("alpha-tail");
		expect(round2).toContain("beta-tail");
		const round3 = completeSimpleMock.mock.calls[2][1].messages[4].content[0].text;
		expect(round3).toContain("gamma-tail");
		expect([...(plan.fullyVisibleIds ?? [])].sort()).toEqual([
			"local:prompt:alpha",
			"local:prompt:beta",
			"local:prompt:gamma",
		]);

		const result = applyRefinementProposal(state, plan.proposal, { id: "r4", fullyVisibleIds: plan.fullyVisibleIds });
		expect(result.appliedEdits.every((edit) => edit.applied)).toBe(true);
	});

	it("accepts the canonical identifier form the overview renders", async () => {
		const state = loadHarnessState(makeTempDir(), "local");
		state.entries.prompt.note = {
			id: "note",
			kind: "prompt",
			title: "Note",
			content: `HEAD. ${"filler. ".repeat(60)}note-tail`,
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

		completeSimpleMock
			.mockResolvedValueOnce(assistantText(JSON.stringify({ expand: ["local:prompt:note"] })))
			.mockResolvedValueOnce(
				assistantText(
					JSON.stringify({
						summary: "s",
						rationale: "r",
						expectedOutcome: "e",
						edits: [{ action: "update", kind: "prompt", id: "note", title: "Note", content: "rewritten" }],
					}),
				),
			);

		const plan = await planRefinement(
			[{ role: "user", content: "revise", timestamp: Date.now() } satisfies AgentMessage],
			state,
			[],
			createRefineModel(),
			"api-key",
			{},
		);

		expect(completeSimpleMock.mock.calls[1][1].messages[2].content[0].text).toContain("note-tail");
		expect(plan.fullyVisibleIds?.has("local:prompt:note")).toBe(true);
	});

	it("stops expanding after the round limit and still returns a proposal", async () => {
		const state = loadHarnessState(makeTempDir(), "local");
		state.entries.prompt.note = {
			id: "note",
			kind: "prompt",
			title: "Note",
			content: `HEAD. ${"filler. ".repeat(60)}note-tail`,
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
		// A refiner that only ever asks to expand, never proposing edits.
		completeSimpleMock.mockResolvedValue(assistantText(JSON.stringify({ expand: ["local:prompt:note"] })));

		const plan = await planRefinement(
			[{ role: "user", content: "go", timestamp: Date.now() } satisfies AgentMessage],
			state,
			[],
			createRefineModel(),
			"api-key",
			{},
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(4);
		expect(plan.proposal.edits).toEqual([]);
		const lastInjected = completeSimpleMock.mock.calls[3][1].messages.at(-1).content[0].text;
		expect(lastInjected).toContain("last expansion round");
	});

	it("withholds an entry that does not fit the expansion budget and says so", async () => {
		const state = loadHarnessState(makeTempDir(), "local");
		state.entries.prompt.huge = {
			id: "huge",
			kind: "prompt",
			title: "Huge",
			content: "x".repeat(120_000),
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
		completeSimpleMock
			.mockResolvedValueOnce(
				assistantText(JSON.stringify({ expand: ["local:prompt:huge", "local:prompt:missing"] })),
			)
			.mockResolvedValueOnce(
				assistantText(JSON.stringify({ summary: "s", rationale: "r", expectedOutcome: "e", edits: [] })),
			);

		const plan = await planRefinement(
			[{ role: "user", content: "go", timestamp: Date.now() } satisfies AgentMessage],
			state,
			[],
			createRefineModel(),
			"api-key",
			{},
		);

		const injected = completeSimpleMock.mock.calls[1][1].messages[2].content[0].text;
		expect(injected).toContain("expansion budget exhausted");
		expect(injected).toContain("local:prompt:missing: not found");
		expect(plan.fullyVisibleIds?.has("local:prompt:huge")).toBe(false);
	});
});
