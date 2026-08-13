import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyRefinementProposal,
	getGlobalHarnessStateDir,
	getLocalHarnessStateDir,
	type HarnessScope,
	type HarnessState,
	loadHarnessState,
	type RefinementKind,
	saveHarnessState,
} from "../../../src/core/refinement/index.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

function seedEntry(state: HarnessState, scope: HarnessScope, kind: RefinementKind, id: string, content: string): void {
	const result = applyRefinementProposal(
		state,
		{
			summary: `Seed ${scope} ${kind}`,
			rationale: "Regression fixture",
			expectedOutcome: "Entry is available to the refiner",
			edits: [{ action: "create", kind, id, title: `${kind} ${id}`, content }],
		},
		{ id: `seed_${scope}_${kind}_${id}`, scope },
	);
	if (!result.appliedEdits[0]?.applied) {
		throw new Error(`Failed to seed ${scope}:${kind}:${id}`);
	}
}

function updateProposal(kind: RefinementKind, id: string, content: string): string {
	return JSON.stringify({
		summary: `Update ${kind}`,
		rationale: "The expanded card appeared relevant",
		expectedOutcome: "Only the exact visible entry changes",
		edits: [{ action: "update", kind, id, title: `${kind} ${id}`, content }],
	});
}

describe("PR #1317 refiner visibility identity", () => {
	let harness: Harness | undefined;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		if (previousAgentDir === undefined) {
			delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
		} else {
			process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("keeps expansion and update authority isolated across kinds sharing an id", async () => {
		harness = await createHarness({ persistSession: true });
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir());
		if (!localDir) throw new Error("Expected a persisted local harness directory");

		const state = loadHarnessState(localDir, "local");
		const promptTail = "PROMPT SECRET TAIL: this must not be disclosed or authorized.";
		const promptContent = `PROMPT HEAD ${"filler ".repeat(80)}${promptTail}`;
		const memoryContent = "MEMORY CARD: fully visible and safe to expand.";
		seedEntry(state, "local", "prompt", "card", promptContent);
		seedEntry(state, "local", "memory", "card", memoryContent);
		saveHarnessState(localDir, state);

		let initialPrompt = "";
		let expansionPrompt = "";
		harness.setResponses([
			(context) => {
				initialPrompt = getMessageText(context.messages[0]);
				return fauxAssistantMessage(JSON.stringify({ expand: ["local:memory:card"] }));
			},
			(context) => {
				expansionPrompt = getMessageText(context.messages.at(-1));
				return fauxAssistantMessage(updateProposal("prompt", "card", "unauthorized replacement"));
			},
		]);

		const result = await harness.session.refine({ instructions: "Review the card entries" });

		expect(initialPrompt).toContain("[local:prompt:card]");
		expect(initialPrompt).toContain("[local:memory:card]");
		expect(expansionPrompt).toContain('identifier="local:memory:card"');
		expect(expansionPrompt).toContain(memoryContent);
		expect(expansionPrompt).not.toContain(promptTail);
		expect(result.appliedEdits[0]).toMatchObject({
			kind: "prompt",
			id: "card",
			applied: false,
			error: "entry was not shown in full; update refused",
		});
		expect(loadHarnessState(localDir, "local").entries.prompt.card.content).toBe(promptContent);
	});

	it("keeps expansion and update authority isolated across scopes sharing a kind and id", async () => {
		harness = await createHarness({ persistSession: true });
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		const globalDir = getGlobalHarnessStateDir();
		const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir());
		if (!localDir) throw new Error("Expected a persisted local harness directory");

		const globalState = loadHarnessState(globalDir, "global");
		const localState = loadHarnessState(localDir, "local");
		const globalContent = "GLOBAL MEMORY CARD: fully visible context.";
		const localTail = "LOCAL SECRET TAIL: this must remain unchanged.";
		const localContent = `LOCAL MEMORY HEAD ${"filler ".repeat(80)}${localTail}`;
		seedEntry(globalState, "global", "memory", "card", globalContent);
		seedEntry(localState, "local", "memory", "card", localContent);
		saveHarnessState(globalDir, globalState);
		saveHarnessState(localDir, localState);

		let expansionPrompt = "";
		harness.setResponses([
			fauxAssistantMessage(JSON.stringify({ expand: ["global:memory:card"] })),
			(context) => {
				expansionPrompt = getMessageText(context.messages.at(-1));
				return fauxAssistantMessage(updateProposal("memory", "card", "unauthorized local replacement"));
			},
		]);

		const result = await harness.session.refine({ instructions: "Review the shared memory card" });

		expect(expansionPrompt).toContain('identifier="global:memory:card"');
		expect(expansionPrompt).toContain(globalContent);
		expect(expansionPrompt).not.toContain(localTail);
		expect(result.appliedEdits[0]).toMatchObject({
			kind: "memory",
			id: "card",
			applied: false,
			error: "entry was not shown in full; update refused",
		});
		expect(loadHarnessState(localDir, "local").entries.memory.card.content).toBe(localContent);
		expect(loadHarnessState(globalDir, "global").entries.memory.card.content).toBe(globalContent);
	});
});
