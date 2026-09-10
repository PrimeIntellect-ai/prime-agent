import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
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
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

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
		vi.stubEnv("COLORTERM", "truecolor");
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterAll(() => vi.unstubAllEnvs());

	test("shows a spaced accent harness header before its semantic summary", () => {
		const message = createRefinementOutcomeMessage(result());
		const component = new RefinementOutcomeMessageComponent(message);

		const collapsed = rendered(component);
		const content = collapsed.split("\n").filter((line) => line.trim());
		expect(content[0]?.trimEnd()).toBe(" ◆ Harness refined · 1 prompt created");
		expect(content[1]).toBe(" Added local guidance to make conversational responses rhyme.");
		expect(component.render(120)[1]).toContain(theme.fg("accent", "◆ Harness refined · 1 prompt created"));
		expect(collapsed.split("\n")[0].trim()).toBe("");
		expect(collapsed.split("\n").at(-1)?.trim()).toBe("");
		expect(collapsed).not.toContain("Ctrl+O");
		expect(collapsed).not.toContain("[refinement]");
		expect(collapsed).not.toContain("rhyme-response-guidance");
		expectChatInset(collapsed.split("\n"));
		// Collapsed rows stay compact: entry details only render when expanded.
		expect(collapsed).not.toContain("Rhyme response guidance");
		expect(collapsed).not.toContain("prompts/rhyme-response-guidance.md");
		expect(collapsed).not.toContain('"content"');

		component.setExpanded(true);
		const expanded = rendered(component);
		expect(expanded).toContain("Created local prompt `rhyme-response-guidance`");
		expect(expanded).toContain(" Title");
		expect(expanded).toContain("+ Rhyme response guidance");
		expect(expanded).toContain(" Description");
		expect(expanded).toContain("+ Make conversational responses rhyme.");
		expect(expanded).toContain(" Path");
		expect(expanded).toContain("prompts/rhyme-response-guidance.md");
		expect(expanded).not.toContain("Ctrl+O");
		expectChatInset(expanded.split("\n"));
		// Structured rows, not a JSON dump.
		expect(expanded).not.toContain('"content":');
		expect(expanded).not.toContain('"title":');
		expect(expanded).not.toContain('"path":');
		expect(expanded).not.toContain("+1 {");

		component.setExpanded(false);
		expect(rendered(component)).toBe(collapsed);
	});

	test("gives long semantic summaries two preview lines beneath the harness header", () => {
		const long = result();
		long.summary =
			"Created local memory entries for the verifiers project context and running subagent tracking, plus a reusable subagent spec for parallel codebase exploration.";
		const component = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(long));

		const lines = component.render(80).map((line) => stripAnsi(line));
		const content = lines.filter((line) => line.trim().length > 0);
		expect(content).toHaveLength(3);
		expect(content[0]).toContain("Harness refined · 1 prompt created");
		expect(content[1]).toContain("Created local memory entries for the verifiers project context");
		expect(content[2]).toContain("…");
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
		expect(output).toContain(" Description");
		expect(output).toContain("  1 - Respond plainly.");
		expect(output).toContain("  1 + Respond in rhyme.");
		expect(output).toContain(" Tone guidance");
		expect(output).toContain("Deleted local prompt `obsolete-guidance`");
		expect(output).toContain("  1 - Use prose.");
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
		expect(collapsed).toContain("Harness partially refined · 2/3 edits applied");
		expect(collapsed).not.toContain("`linear`");
		expect(collapsed).not.toContain("`osint-tips`");
		expect(collapsed).not.toContain("`stale-note`");
		expectChatInset(collapsed.split("\n"));

		component.setExpanded(true);
		const expanded = rendered(component);
		expectChatInset(expanded.split("\n"));
		expect(expanded).toContain("+ Linear issues");
		expect(expanded).toContain("+ Read and write Linear issues via MCP.");
		expect(expanded).toContain('+ {"type":"python","import":"linear","callable":"run"}');
		expect(expanded).toContain('+ {"name":{"type":"string","required":true}}');
		expect(expanded).toContain("  1 - Use blogs.");
		expect(expanded).toContain("  1 + Use blogs and acknowledgements.");
		expect(expanded).toContain("Failed to delete local prompt `stale-note`: entry not found");
		expect(expanded).toContain(" Stale note");
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

	test("shows memory action counts and file-style Title and Description backgrounds without changing the message", () => {
		const before = entry({ kind: "memory", title: "Old title", content: "    preserve indentation\nOld guidance" });
		const after = entry({ ...before, title: "New title", content: "    preserve indentation\nNew guidance" });
		const message = createRefinementOutcomeMessage({
			...result(),
			summary: "Remembered the project's authentication conventions.",
			appliedEdits: [
				{
					action: "update",
					kind: "memory",
					id: before.id,
					before,
					after,
					applied: true,
					reason: "Repeated user preference",
				},
			],
		});
		const original = JSON.stringify(message);
		const component = new RefinementOutcomeMessageComponent(message);
		expect(rendered(component)).toContain("◆ Harness refined · 1 memory updated");
		component.setExpanded(true);
		const rows = component.render(80);
		const output = rows.map(stripAnsi).join("\n");
		expect(output).toMatch(/ Title +\n/);
		expect(output).toMatch(/ Description +\n/);
		expect(output).toContain("     preserve indentation");
		expect(output).toContain("Reason: Repeated user preference");
		const removed = rows.find((row) => stripAnsi(row).includes("- Old guidance"))!;
		const added = rows.find((row) => stripAnsi(row).includes("+ New guidance"))!;
		expect(removed.startsWith(` ${theme.bg("toolDiffRemovedBg", "").slice(0, -5)}`)).toBe(true);
		expect(added.startsWith(` ${theme.bg("toolDiffAddedBg", "").slice(0, -5)}`)).toBe(true);
		expect(visibleWidth(removed)).toBe(80);
		expect(visibleWidth(added)).toBe(80);
		expect(output).not.toContain("Content");
		for (const width of [12, 24, 40, 80]) {
			for (const row of component.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
		expect(JSON.stringify(message)).toBe(original);
	});

	test("labels no-change, failed, partial, and rollback outcomes honestly and preserves failure details", () => {
		const failed = { ...result().appliedEdits[0]!, applied: false, error: "Permission denied" };
		for (const [edits, rollbackOf, expected] of [
			[[], undefined, "Harness unchanged · no edits applied"],
			[[failed], undefined, "Harness refinement failed · 0/1 edits applied"],
			[[failed], "old-refinement", "Harness rollback failed · 0/1 edits applied"],
			[[...result().appliedEdits, failed], "old-refinement", "Harness partially rolled back · 1/2 edits applied"],
			[result().appliedEdits, "old-refinement", "Harness rollback completed · 1 edit applied"],
		] as const) {
			const component = new RefinementOutcomeMessageComponent(
				createRefinementOutcomeMessage({
					...result(),
					summary: "",
					appliedEdits: [...edits],
					rollbackOf,
				}),
			);
			expect(rendered(component)).toContain(expected);
			expect(rendered(component)).toContain("No summary was recorded");
			component.setExpanded(true);
			if (rollbackOf) expect(rendered(component)).toContain(`rollback of ${rollbackOf}`);
			if (edits.some((edit) => !edit.applied)) expect(rendered(component)).toContain("Permission denied");
			if (edits.every((edit) => !edit.applied)) {
				expect(component.render(120).join("\n")).not.toContain(theme.bg("toolDiffAddedBg", "").slice(0, -5));
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
		expect(stripAnsi(component!.render(120).join("\n"))).toContain("+ Make conversational responses rhyme.");
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
