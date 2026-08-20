import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { convertToLlm, createRefinementOutcomeMessage, isRefinementOutcomeMessage } from "../src/core/messages.js";
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

function rendered(component: RefinementOutcomeMessageComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

describe("RefinementOutcomeMessageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("collapses to a labeled one-liner and expands through the shared tool toggle", () => {
		const message = createRefinementOutcomeMessage(result());
		const component = new RefinementOutcomeMessageComponent(message);

		const collapsed = rendered(component);
		expect(collapsed).toContain("[refinement]");
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
	});

	test("truncates the collapsed summary so the line never wraps", () => {
		const long = result();
		long.summary =
			"Created local memory entries for the verifiers project context and running subagent tracking, plus a reusable subagent spec for parallel codebase exploration.";
		const component = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(long));

		const lines = component.render(80).map((line) => stripAnsi(line));
		const content = lines.filter((line) => line.trim().length > 0);
		expect(content).toHaveLength(2);
		expect(content[1]).toContain("…");
		expect(content[1]).toContain("1 edit applied");
		expect(content[1]).toContain("Ctrl+O to expand");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}

		for (const width of [40, 24, 12]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(width);
			}
		}
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
});
