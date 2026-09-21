import { describe, expect, it } from "vitest";
import { HARNESS_DIGEST_CUSTOM_TYPE } from "../../src/core/messages.js";
import {
	type BranchSummaryEntry,
	buildSessionContext,
	type CustomMessageEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "../../src/core/session-manager.js";

const T = "2025-01-01T00:00:00Z";
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function msg(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionMessageEntry {
	const base = { type: "message" as const, id, parentId, timestamp: T };
	if (role === "user") return { ...base, message: { role, content: text, timestamp: 1 } };
	return {
		...base,
		message: {
			role,
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage,
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function branchSummary(id: string, parentId: string | null, summary: string, fromId: string): BranchSummaryEntry {
	return { type: "branch_summary", id, parentId, timestamp: T, summary, fromId };
}

function digestEntry(id: string, parentId: string | null, digest: string): CustomMessageEntry {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp: T,
		customType: HARNESS_DIGEST_CUSTOM_TYPE,
		content: digest,
		details: { digest },
		display: false,
	};
}

/**
 * Builds a linear parent-linked entry fixture from compact specs (ids 1..n,
 * each parented to the previous one): "u text"/"a text" = user/assistant
 * message, "d digest"/"n note" = harness-digest/unrelated custom message,
 * "t level"/"s tier"/"m provider model" = change entries, and
 * "c summary|kept[|instructions[|snapshot]]" = compaction with
 * firstKeptEntryId = the 1-based id in `kept`.
 */
function chain(...specs: string[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	for (const [index, spec] of specs.entries()) {
		const id = String(index + 1);
		const kind = spec[0];
		const text = spec.slice(2);
		if (kind === "u" || kind === "a") {
			entries.push(msg(id, parentId, kind === "u" ? "user" : "assistant", text));
		} else if (kind === "d") {
			entries.push(digestEntry(id, parentId, text));
		} else if (kind === "n") {
			entries.push({
				type: "custom_message",
				id,
				parentId,
				timestamp: T,
				customType: "extension.note",
				content: text,
				display: true,
			});
		} else if (kind === "t") {
			entries.push({ type: "thinking_level_change", id, parentId, timestamp: T, thinkingLevel: text });
		} else if (kind === "s") {
			entries.push({
				type: "service_tier_change",
				id,
				parentId,
				timestamp: T,
				serviceTier: text as "default" | "priority",
			});
		} else if (kind === "m") {
			const [provider, modelId] = text.split(" ");
			entries.push({ type: "model_change", id, parentId, timestamp: T, provider, modelId });
		} else if (kind === "c") {
			const [summary, kept, instructions = "", snapshot] = text.split("|").map((part) => part.trim());
			entries.push({
				type: "compaction",
				id,
				parentId,
				timestamp: T,
				summary,
				firstKeptEntryId: kept,
				tokensBefore: 1000,
				...(instructions ? { customInstructions: instructions } : {}),
				...(snapshot ? { harnessDigest: snapshot } : {}),
			});
		} else {
			throw new Error(`unknown chain spec: ${spec}`);
		}
		parentId = id;
	}
	return entries;
}

const digestOf = (messages: ReturnType<typeof buildSessionContext>["messages"]) =>
	messages
		.filter((m) => m.role === "custom" && m.customType === HARNESS_DIGEST_CUSTOM_TYPE)
		.map((m) => (m as { details: { digest: string } }).details.digest);

const textOf = (m: ReturnType<typeof buildSessionContext>["messages"][number]): string => {
	const content = (m as { content?: string | Array<{ text?: string }> }).content;
	return typeof content === "string" ? content : (content?.[0]?.text ?? "");
};

describe("buildSessionContext", () => {
	it("empty entries returns empty context", () => {
		expect(buildSessionContext([])).toMatchObject({
			messages: [],
			thinkingLevel: "off",
			serviceTier: "default",
			model: null,
		});
	});

	it("tracks thinking level changes", () => {
		expect(buildSessionContext(chain("u hello", "t high", "a thinking hard")).thinkingLevel).toBe("high");
	});

	it("tracks service tier changes on the active branch", () => {
		const entries = chain("u hello", "s priority", "a fast response", "s default");
		expect(buildSessionContext(entries, "3").serviceTier).toBe("priority");
		expect(buildSessionContext(entries, "4").serviceTier).toBe("default");
	});

	it("tracks model from model change entry", () => {
		expect(buildSessionContext(chain("u hello", "m openai gpt-4", "a hi")).model).toMatchObject({
			provider: "anthropic",
			modelId: "claude-test",
		});
	});

	it("includes summary before kept messages", () => {
		const ctx = buildSessionContext(chain("u first", "u second", "c First turn summarized|2", "u third"));
		const head = ctx.messages[0] as { role: string; summary: string };
		expect(head.role).toBe("compactionSummary");
		expect(head.summary).toContain("First turn summarized");
		expect(ctx.messages.slice(1).map(textOf)).toEqual(["second", "third"]);
	});

	it("carries customInstructions onto the summary message", () => {
		const ctx = buildSessionContext(
			chain("u first", "a response", "c Summary|1|focus on the auth refactor", "u second"),
		);
		expect((ctx.messages[0] as { customInstructions?: string }).customInstructions).toBe(
			"focus on the auth refactor",
		);
	});

	it("multiple compactions uses latest", () => {
		const ctx = buildSessionContext(
			chain("u a", "a b", "c First summary|1", "u c", "a d", "c Second summary|4", "u e"),
		);
		expect((ctx.messages[0] as { summary: string }).summary).toContain("Second summary");
		expect(ctx.messages.slice(1).map(textOf)).toEqual(["c", "d", "e"]);
	});

	it("includes branch summary in path", () => {
		const entries = chain("u start", "a response", "u abandoned path");
		entries.push(branchSummary("4", "2", "Summary of abandoned work", "3"));
		entries.push(msg("5", "4", "user", "new direction"));
		const ctx = buildSessionContext(entries, "5");
		expect((ctx.messages[2] as any).summary).toContain("Summary of abandoned work");
		expect((ctx.messages[3] as any).content).toBe("new direction");
	});

	it("uses last entry when leafId not found", () => {
		expect(buildSessionContext(chain("u hello", "a hi"), "nonexistent").messages).toHaveLength(2);
	});

	it("handles orphaned entries gracefully", () => {
		const entries: SessionEntry[] = [msg("1", null, "user", "hello"), msg("2", "missing", "assistant", "orphan")];
		expect(buildSessionContext(entries, "2").messages).toHaveLength(1);
	});

	describe("harness digest dedupe", () => {
		it("keeps only the newest digest custom message", () => {
			const ctx = buildSessionContext(chain("u hello", "d digest-a", "a first reply", "d digest-b"));
			expect(digestOf(ctx.messages)).toEqual(["digest-b"]);
			expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "custom"]);
		});

		it("keeps only the newest digest on the navigated branch", () => {
			const entries = chain("u hello", "d digest-old", "u branch point", "d digest-branch-a");
			entries.push(digestEntry("5", "3", "digest-branch-b"));
			expect(digestOf(buildSessionContext(entries, "4").messages)).toEqual(["digest-branch-a"]);
			expect(digestOf(buildSessionContext(entries, "5").messages)).toEqual(["digest-branch-b"]);
		});

		it("leaves sessions without digests and non-digest custom messages unchanged", () => {
			const ctx = buildSessionContext(chain("u hello", "n note one", "a reply", "n note two", "u again"));
			expect(digestOf(ctx.messages)).toEqual([]);
			expect(ctx.messages.map((m) => m.role)).toEqual(["user", "custom", "assistant", "custom", "user"]);
		});

		it("drops retained digest messages when the compaction snapshot is newer", () => {
			const ctx = buildSessionContext(
				chain(
					"d retained digest",
					"u kept question",
					"a kept answer",
					"c Summary|1||snapshot digest",
					"u after compaction",
				),
			);
			expect(digestOf(ctx.messages)).toEqual([]);
			expect((ctx.messages[0] as { harnessDigest?: string }).harnessDigest).toBe("snapshot digest");
		});

		it("keeps the newest post-compaction digest and drops the superseded snapshot", () => {
			const ctx = buildSessionContext(
				chain("u question", "a answer", "c Summary|1||snapshot digest", "d newest digest"),
			);
			expect(digestOf(ctx.messages)).toEqual(["newest digest"]);
			expect((ctx.messages[0] as { harnessDigest?: string }).harnessDigest).toBeUndefined();
		});

		it("keeps the newest retained digest when the compaction has no snapshot", () => {
			const ctx = buildSessionContext(
				chain("d retained old", "d retained newest", "u kept question", "c Summary|1", "u after compaction"),
			);
			expect(digestOf(ctx.messages)).toEqual(["retained newest"]);
			expect((ctx.messages[0] as { harnessDigest?: string }).harnessDigest).toBeUndefined();
		});
	});
});
