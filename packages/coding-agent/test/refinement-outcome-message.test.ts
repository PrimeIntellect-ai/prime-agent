import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	convertToLlm,
	createRefinementNoticeMessage,
	createRefinementOutcomeMessage,
	isRefinementOutcomeMessage,
} from "../src/core/messages.js";
import type { HarnessEntry, RefinementResult } from "../src/core/refinement/refinement.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { RefinementOutcomeMessageComponent } from "../src/modes/interactive/components/refinement-outcome-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function entry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id: "rhyme-response-guidance",
		kind: "prompt",
		title: "Rhyme response guidance",
		content: "Make conversational responses rhyme.",
		path: "prompts/rhyme-response-guidance.md",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "refinement",
		created_at: "2026-08-18T00:00:00.000Z",
		updated_at: "2026-08-18T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

function result(): RefinementResult {
	const after = entry();
	return {
		id: "refine-rhyme",
		summary: "Added local guidance to make conversational responses rhyme.",
		rationale: "The user requested rhyming guidance.",
		expectedOutcome: "Conversational responses rhyme.",
		appliedEdits: [
			{
				action: "create",
				kind: "prompt",
				id: after.id,
				title: after.title,
				content: after.content,
				path: after.path,
				after,
				applied: true,
			},
		],
		harnessStatePath: "/tmp/harness/state.json",
		scope: "local",
	};
}

function getLlmText(message: unknown): string {
	const content = (message as { content: Array<{ type: string; text?: string }> }).content;
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function rendered(component: RefinementOutcomeMessageComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

describe("RefinementOutcomeMessageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("shows the outcome before quiet metadata and expands through the shared tool toggle", () => {
		const message = createRefinementOutcomeMessage(result());
		const component = new RefinementOutcomeMessageComponent(message);

		const collapsed = rendered(component);
		const content = collapsed.split("\n").filter((line) => line.trim());
		expect(content[0]).toBe("Added local guidance to make conversational responses rhyme.");
		expect(content[1]).toContain("Refinement · 1 edit applied");
		expect(collapsed).not.toContain("[refinement]");
		expect(collapsed).toContain("Added local guidance to make conversational responses rhyme.");
		expect(collapsed).toContain("1 edit applied");
		expect(collapsed).toContain("Ctrl+O to expand");
		expect(collapsed).not.toContain("Created local prompt");
		expect(collapsed).not.toContain('Make conversational responses rhyme."');

		component.setExpanded(true);
		const expanded = rendered(component);
		expect(expanded).toContain("Created local prompt `rhyme-response-guidance`");
		expect(expanded).toContain('"content": "Make conversational responses rhyme."');
		expect(expanded).toContain('"path": "prompts/rhyme-response-guidance.md"');
		expect(expanded).toContain("Ctrl+O to collapse");

		component.setExpanded(false);
		expect(rendered(component)).toBe(collapsed);
	});

	test("gives long outcomes two preview lines without sacrificing the edit count and details hint", () => {
		const long = result();
		long.summary =
			"Created local memory entries for the verifiers project context and running subagent tracking, plus a reusable subagent spec for parallel codebase exploration.";
		const component = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(long));

		const lines = component.render(80).map((line) => stripAnsi(line));
		const content = lines.filter((line) => line.trim().length > 0);
		expect(content).toHaveLength(3);
		expect(content[0]).toContain("Created local memory entries for the verifiers project context");
		expect(content[1]).toContain("…");
		expect(content[2]).toContain("1 edit applied");
		expect(content[2]).toContain("Ctrl+O to expand");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}

		for (const width of [40, 24, 12]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(width);
			}
		}

		component.setExpanded(true);
		expect(rendered(component).replace(/\s+/g, " ")).toContain(long.summary);
	});

	test("renders exact before and after payloads for updates and deletes", () => {
		const base = result();
		const before = entry({ id: "tone-guidance", content: "Respond plainly." });
		const after = entry({ id: "tone-guidance", content: "Respond in rhyme.", version: 2 });
		const deleted = entry({ id: "obsolete-guidance", content: "Use prose." });
		const message = createRefinementOutcomeMessage({
			...base,
			appliedEdits: [
				{ action: "update", kind: "prompt", id: before.id, before, after, applied: true },
				{ action: "delete", kind: "prompt", id: deleted.id, before: deleted, applied: true },
			],
		});
		const component = new RefinementOutcomeMessageComponent(message);
		component.setExpanded(true);
		const output = rendered(component);

		expect(output).toContain("Updated local prompt `tone-guidance`");
		expect(output).toContain("Deleted local prompt `obsolete-guidance`");
		expect(output).toContain('"content": "Respond plainly."');
		expect(output).toContain('"content": "Respond in rhyme."');
		expect(output).toContain('"content": "Use prose."');
	});

	test("replays the durable outcome with the saved tool expansion state", () => {
		const message = createRefinementOutcomeMessage(result());
		const [component] = buildConversationComponents([message], {
			ui: {} as TUI,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
			toolsExpanded: true,
		});

		expect(component).toBeInstanceOf(RefinementOutcomeMessageComponent);
		expect(stripAnsi(component!.render(120).join("\n"))).toContain(
			'"content": "Make conversational responses rhyme."',
		);
	});

	test("uses a typed, presentation-only custom message", () => {
		const message = createRefinementOutcomeMessage(result());
		expect(isRefinementOutcomeMessage(message)).toBe(true);
		expect(convertToLlm([message])).toEqual([]);
		expect(isRefinementOutcomeMessage({ ...message, details: { ...message.details, edits: [{}] } })).toBe(false);
	});

	test("refinement notices pass through to the model while outcomes stay filtered", () => {
		const outcome = createRefinementOutcomeMessage(result());
		const notice = createRefinementNoticeMessage(result(), "self");

		const llm = convertToLlm([outcome, notice]);
		expect(llm).toHaveLength(1);
		expect(llm[0]?.role).toBe("user");
		const text = getLlmText(llm[0]);
		expect(text).toMatch(/^\[self-refinement\]\n\n/);
		expect(text).toContain("Added local guidance to make conversational responses rhyme.");
		expect(text).toContain(
			"- create prompt [local:rhyme-response-guidance] Rhyme response guidance: Make conversational responses rhyme.",
		);
		expect(getLlmText(convertToLlm([createRefinementNoticeMessage(result(), "auto")])[0])).toMatch(
			/^\[auto-refinement\]/,
		);
		expect(getLlmText(convertToLlm([createRefinementNoticeMessage(result(), "user")])[0])).toMatch(
			/^\[user-refinement\]/,
		);
	});
});
