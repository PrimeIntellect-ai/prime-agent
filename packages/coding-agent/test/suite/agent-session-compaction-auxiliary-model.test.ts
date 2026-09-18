import type * as PiAi from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../src/core/compaction/utils.js";
import { createHarness } from "./harness.js";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return { ...actual, completeSimple: completeSimpleMock };
});
describe("AgentSession compaction auxiliary model", () => {
	const cases: Array<[string, { auxiliaryModel?: string; window?: number }, string]> = [
		["routes compaction summaries to the auxiliary model", { auxiliaryModel: "faux/aux-model" }, "aux-model"],
		["falls back when the auxiliary model is unusable", { auxiliaryModel: "faux/missing-model" }, "session-model"],
		["falls back when the window is too small", { auxiliaryModel: "faux/aux-model", window: 8192 }, "session-model"],
		["falls back to the session model when no auxiliary model is configured", {}, "session-model"],
	];
	it.each(cases)("%s", async (_label, options, expectedModel) => {
		completeSimpleMock.mockReset().mockResolvedValue(fauxAssistantMessage("Test summary"));
		const warnSpy = vi.spyOn(console, "warn");
		warnSpy.mockReset().mockImplementation(() => {});
		const harness = await createHarness({
			models: [
				{ id: "session-model", name: "Session Model", reasoning: true },
				{ id: "aux-model", name: "Aux Model", contextWindow: options.window },
			],
			settings: { auxiliaryModel: options.auxiliaryModel, compaction: { keepRecentTokens: 1 } },
			persistSession: true,
		});
		harness.session.setThinkingLevel("medium");
		harness.setResponses([fauxAssistantMessage("one response"), fauxAssistantMessage("two response")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const result = await harness.session.compact();
		const calls = completeSimpleMock.mock.calls.filter(
			(call) => (call[1] as { systemPrompt?: string }).systemPrompt === SUMMARIZATION_SYSTEM_PROMPT,
		);
		expect(calls.length).toBeGreaterThan(0);
		expect(result.summary).toContain("Test summary");
		for (const call of calls) {
			expect(call[0]).toMatchObject({ provider: "faux", id: expectedModel });
			expect(call[2]).not.toHaveProperty("reasoning");
		}
		const fallbackWarn = expectedModel === "session-model" ? options.auxiliaryModel : undefined;
		const expectedWarnings = fallbackWarn
			? [`Warning: auxiliaryModel "${fallbackWarn}" unusable for compaction summary; using the session model.`]
			: [];
		expect(warnSpy.mock.calls.map(([message]) => String(message))).toStrictEqual(expectedWarnings);
		harness.cleanup();
	});
});
