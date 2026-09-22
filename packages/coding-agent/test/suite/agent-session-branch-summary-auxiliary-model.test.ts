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
describe("AgentSession branch summary auxiliary model", () => {
	type Case = { auxiliaryModel?: string; window?: number; sessionWindow?: number; stub?: boolean };
	const cases: Array<[string, Case, string]> = [
		["routes branch summaries to the auxiliary model", { auxiliaryModel: "faux/aux-model" }, "aux-model"],
		["falls back when the auxiliary model is unusable", { auxiliaryModel: "faux/missing-model" }, "session-model"],
		["falls back when the window is small", { auxiliaryModel: "faux/aux-model", window: 8192 }, "session-model"],
		["falls back when only the body fits", { auxiliaryModel: "faux/aux-model", window: 30000 }, "session-model"],
		[
			"falls back when the reserve outgrows the window",
			{ auxiliaryModel: "faux/aux-model", window: 8192, sessionWindow: 16400, stub: true },
			"session-model",
		],
	];
	it.each(cases)("%s", async (_label, options, expectedModel) => {
		completeSimpleMock.mockReset().mockResolvedValue(fauxAssistantMessage("Test summary"));
		const warnSpy = vi.spyOn(console, "warn");
		warnSpy.mockReset().mockImplementation(() => {});
		const harness = await createHarness({
			models: [
				{ id: "session-model", name: "Session Model", contextWindow: options.sessionWindow },
				{ id: "aux-model", name: "Aux Model", contextWindow: options.window },
			],
			settings: { auxiliaryModel: options.auxiliaryModel },
			persistSession: true,
		});
		const turnText = "long branch turn text ".repeat(options.window ? 600 : 1);
		harness.setResponses([1, 2, 3].map(() => fauxAssistantMessage(turnText)));
		for (const _ of [1, 2, 3]) await harness.session.prompt(turnText);
		const [rootNode] = harness.sessionManager.getTree();
		const result = await harness.session.navigateTree(rootNode.entry.id, { summarize: true });
		const calls = completeSimpleMock.mock.calls.filter(
			(call) => (call[1] as { systemPrompt?: string }).systemPrompt === SUMMARIZATION_SYSTEM_PROMPT,
		);
		expect(calls.length).toBe(options.stub ? 0 : 1);
		expect(result.summaryEntry?.summary).toContain(options.stub ? "No content to summarize" : "Test summary");
		for (const call of calls) {
			expect(call[0]).toMatchObject({ provider: "faux", id: expectedModel });
		}
		const fallbackWarn = expectedModel === "session-model" ? options.auxiliaryModel : undefined;
		const expectedWarnings = fallbackWarn
			? [`Warning: auxiliaryModel "${fallbackWarn}" unusable for branch summary; using the session model.`]
			: [];
		expect(warnSpy.mock.calls.map(([message]) => String(message))).toStrictEqual(expectedWarnings);
		harness.cleanup();
	});
});
