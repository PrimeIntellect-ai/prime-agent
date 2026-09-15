import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentFamilyCatalogEntry } from "../src/core/agent-messages.js";
import {
	createAgentObserveMessagePreview,
	normalizeObserveLimit,
	normalizeObserveMaxChars,
	normalizeObserveRecursive,
	selectAgentObserveRoster,
} from "../src/core/agent-observe.js";

describe("agent observe helpers", () => {
	it("creates bounded text previews", () => {
		const preview = createAgentObserveMessagePreview(
			{
				role: "user",
				content: [{ type: "text", text: "abcdefghijklmnopqrstuvwxyz" }],
				timestamp: 123,
			},
			4,
			8,
		);

		expect(preview).toEqual({
			index: 4,
			role: "user",
			timestamp: 123,
			text: "abcdefgh",
			truncated: true,
		});
	});

	it("includes assistant tool call names without exposing arguments", () => {
		const preview = createAgentObserveMessagePreview(
			fauxAssistantMessage(fauxToolCall("bash", { command: "secret" }), { stopReason: "toolUse" }),
			2,
			200,
		);

		expect(preview.text).toBe("[tool_call:bash]");
		expect(preview.toolCalls).toEqual(["bash"]);
		expect(preview.text).not.toContain("secret");
	});

	it("includes assistant thinking text in previews", () => {
		const preview = createAgentObserveMessagePreview(
			fauxAssistantMessage(fauxThinking("working through the plan")),
			1,
			200,
		);

		expect(preview.text).toBe("working through the plan");
		expect(preview.truncated).toBe(false);
	});

	it("validates bounds", () => {
		expect(normalizeObserveLimit(undefined)).toBe(8);
		expect(normalizeObserveLimit(50)).toBe(50);
		expect(() => normalizeObserveLimit(0)).toThrow("between 1 and 50");
		expect(normalizeObserveMaxChars(undefined)).toBe(800);
		expect(normalizeObserveMaxChars(80)).toBe(80);
		expect(() => normalizeObserveMaxChars(2_001)).toThrow("between 80 and 2000");
	});
});

describe("agent observe recursive roster", () => {
	interface Entry {
		id: string;
		name: string;
		depth: number;
		parentId?: string;
	}

	const tree: Entry[] = [
		{ id: "root", name: "root", depth: 0 },
		{ id: "researcher", name: "researcher", depth: 1, parentId: "root" },
		{ id: "reviewer", name: "reviewer", depth: 1, parentId: "root" },
		{ id: "analyst", name: "analyst", depth: 2, parentId: "researcher" },
		{ id: "writer", name: "writer", depth: 2, parentId: "researcher" },
		{ id: "scraper", name: "scraper", depth: 3, parentId: "analyst" },
	];

	const catalog = tree.map(
		(entry): AgentFamilyCatalogEntry => ({
			id: entry.id,
			name: entry.name,
			depth: entry.depth,
			status: "running",
			...(entry.parentId ? { parentSessionId: entry.parentId } : {}),
		}),
	);

	it("keeps the default roster nuclear", () => {
		const roster = selectAgentObserveRoster(catalog[1], catalog, false);
		expect(roster.map((member) => [member.relationship, member.entry.id])).toEqual([
			["parent", "root"],
			["sibling", "reviewer"],
			["child", "analyst"],
			["child", "writer"],
		]);
	});

	it("appends descendants breadth-first as read-only rows when recursive", () => {
		const roster = selectAgentObserveRoster(catalog[1], catalog, true);
		expect(roster.map((member) => [member.relationship, member.entry.id])).toEqual([
			["parent", "root"],
			["sibling", "reviewer"],
			["child", "analyst"],
			["child", "writer"],
			["descendant", "scraper"],
		]);
	});

	it("keeps the root recursive roster free of unrelated subtrees", () => {
		const roster = selectAgentObserveRoster(catalog[2], catalog, true);
		expect(roster.map((member) => member.entry.id)).toEqual(["root", "researcher"]);
	});

	it("validates the recursive flag", () => {
		expect(normalizeObserveRecursive(undefined)).toBe(false);
		expect(normalizeObserveRecursive(true)).toBe(true);
		expect(() => normalizeObserveRecursive("yes")).toThrow("recursive must be a boolean");
	});
});
