import type * as PiAi from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { createHarness, type Harness } from "./harness.js";

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
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

function emptyProposalResponse(): AssistantMessage {
	return assistantText(
		JSON.stringify({ summary: "no-op", rationale: "nothing to record", expectedOutcome: "none", edits: [] }),
	);
}

describe("AgentSession refinement auxiliary model", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(emptyProposalResponse());
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function createRefineHarness(settings?: { auxiliaryModel?: string }): Promise<Harness> {
		const harness = await createHarness({
			models: [
				{ id: "session-model", name: "Session Model" },
				{ id: "aux-model", name: "Aux Model" },
			],
			settings,
			persistSession: true,
		});
		harnesses.push(harness);
		return harness;
	}

	it("routes refinement planning to the configured auxiliary model", async () => {
		const harness = await createRefineHarness({ auxiliaryModel: "faux/aux-model" });
		await harness.session.refine({ instructions: "record a note" });
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][0]).toMatchObject({
			provider: "faux",
			id: "aux-model",
		});
	});

	it("falls back to the session model when no auxiliary model is configured", async () => {
		const harness = await createRefineHarness();
		await harness.session.refine({ instructions: "record a note" });
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][0]).toMatchObject({
			provider: "faux",
			id: "session-model",
		});
	});

	it("falls back to the session model when the auxiliary model is unusable", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const harness = await createRefineHarness({ auxiliaryModel: "faux/missing-model" });
			await harness.session.refine({ instructions: "record a note" });
			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
			expect(completeSimpleMock.mock.calls[0][0]).toMatchObject({
				provider: "faux",
				id: "session-model",
			});
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('auxiliaryModel "faux/missing-model" unusable for refinement'),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
