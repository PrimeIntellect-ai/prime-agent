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

function expectChatInset(lines: string[]): void {
	for (const line of lines) {
		if (line.trim().length > 0) {
			expect(line.startsWith(" "), `missing left inset: ${JSON.stringify(line)}`).toBe(true);
		}
	}
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
		expect(content[0]).toBe(" Added local guidance to make conversational responses rhyme.");
		expect(content[1]).toContain("Refinement · 1 edit applied");
		expect(content[1]).toContain("Ctrl+O to expand");
		expect(collapsed).not.toContain("[refinement]");
		expect(collapsed).toContain("╰─ Created local prompt `rhyme-response-guidance`");
		expectChatInset(collapsed.split("\n"));
		// Collapsed rows stay compact: entry details only render when expanded.
		expect(collapsed).not.toContain("Rhyme response guidance");
		expect(collapsed).not.toContain("prompts/rhyme-response-guidance.md");
		expect(collapsed).not.toContain('"content"');

		component.setExpanded(true);
		const expanded = rendered(component);
		expect(expanded).toContain("Created local prompt `rhyme-response-guidance`");
		expect(expanded).toContain("Title      Rhyme response guidance");
		expect(expanded).toContain("Content    Make conversational responses rhyme.");
		expect(expanded).toContain("Path       prompts/rhyme-response-guidance.md");
		expect(expanded).toContain("Ctrl+O to collapse");
		expectChatInset(expanded.split("\n"));
		// Structured rows, not a JSON dump.
		expect(expanded).not.toContain('"content":');
		expect(expanded).not.toContain('"title":');
		expect(expanded).not.toContain('"path":');
		expect(expanded).not.toContain("+1 {");

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
		expect(content).toHaveLength(4);
		expect(content[0]).toContain("Created local memory entries for the verifiers project context");
		expect(content[1]).toContain("…");
		expect(content[2]).toContain("1 edit applied");
		expect(content[2]).toContain("Ctrl+O to expand");
		expect(content[3]).toContain("╰─ Created local prompt `rhyme-response-guidance`");
		expectChatInset(lines);
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

	test("renders structured before and after rows for updates and deletes", () => {
		const base = result();
		const before = entry({ id: "tone-guidance", title: "Tone guidance", content: "Respond plainly." });
		const after = entry({ id: "tone-guidance", title: "Tone guidance", content: "Respond in rhyme.", version: 2 });
		const deleted = entry({ id: "obsolete-guidance", title: "Obsolete guidance", content: "Use prose." });
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
		expectChatInset(output.split("\n"));

		expect(output).toContain("Updated local prompt `tone-guidance`");
		expect(output).toContain("Content  - Respond plainly.");
		expect(output).toMatch(/ {13}\+ Respond in rhyme\./);
		expect(output).toContain("Title      Tone guidance");
		expect(output).toContain("Deleted local prompt `obsolete-guidance`");
		expect(output).toContain("Content    Use prose.");
		expect(output).not.toContain('"content":');
	});

	test("renders create, update, and failed edits as structured sections with the chat inset", () => {
		const created = entry({
			id: "linear",
			kind: "skill",
			title: "Linear issues",
			content: "Read and write Linear issues via MCP.",
			path: "skills/linear/SKILL.md",
			reference: { type: "python", import: "linear", callable: "run" },
			arguments: { name: { type: "string", required: true } },
		});
		const before = entry({ id: "osint-tips", kind: "memory", title: "OSINT tips", content: "Use blogs." });
		const after = entry({
			id: "osint-tips",
			kind: "memory",
			title: "OSINT tips",
			content: "Use blogs and acknowledgements.",
		});
		const message = createRefinementOutcomeMessage({
			...result(),
			appliedEdits: [
				{
					action: "create",
					kind: "skill",
					id: created.id,
					title: created.title,
					content: created.content,
					path: created.path,
					after: created,
					applied: true,
				},
				{ action: "update", kind: "memory", id: before.id, before, after, applied: true },
				{
					action: "delete",
					kind: "prompt",
					id: "stale-note",
					title: "Stale note",
					content: "Old session note.",
					applied: false,
					error: "entry not found",
				},
			],
		});
		const component = new RefinementOutcomeMessageComponent(message);

		const collapsed = rendered(component);
		expect(collapsed).toContain("Refinement · 2/3 edits applied");
		expect(collapsed).toContain("╰─ Created local skill `linear`");
		expect(collapsed).toContain("╰─ Updated local memory `osint-tips`");
		expect(collapsed).toContain("╰─ Failed to delete local prompt `stale-note`: entry not found");
		expectChatInset(collapsed.split("\n"));

		component.setExpanded(true);
		const expanded = rendered(component);
		expectChatInset(expanded.split("\n"));
		expect(expanded).toContain("Title      Linear issues");
		expect(expanded).toContain("Content    Read and write Linear issues via MCP.");
		expect(expanded).toContain('Reference  {"type":"python","import":"linear","callable":"run"}');
		expect(expanded).toContain('Arguments  {"name":{"type":"string","required":true}}');
		expect(expanded).toContain("Content  - Use blogs.");
		expect(expanded).toMatch(/ {13}\+ Use blogs and acknowledgements\./);
		expect(expanded).toContain("Failed to delete local prompt `stale-note`: entry not found");
		expect(expanded).toContain("Title      Stale note");
		// The raw JSON-diff blob is gone.
		expect(expanded).not.toContain('"content":');
		expect(expanded).not.toContain('"title":');
		expect(expanded).not.toContain("+1 {");

		for (const width of [80, 40, 24, 12]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(width);
			}
		}
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
		expect(stripAnsi(component!.render(120).join("\n"))).toContain("Content    Make conversational responses rhyme.");
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
