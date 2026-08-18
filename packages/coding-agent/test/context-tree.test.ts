import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel, type Usage } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { type ContextTreeNode, loadContextTreeChildrenFromDisk } from "../src/core/context-tree.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { addAssistantUsage, cloneUsage, emptyUsage } from "../src/core/usage.js";
import { formatContextTree } from "../src/modes/interactive/components/context-tree-format.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

beforeAll(() => {
	initTheme("dark");
});

function createUsage(input: number, output: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: {
			input: cost,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: cost,
		},
	};
}

function createAssistantMessage(text: string, usage: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string) {
	return {
		role: "user" as const,
		content: text,
		timestamp: Date.now(),
	};
}

/**
 * Write a child agent session into `dir` the way RLM child runs persist them:
 * model change, the spawn prompt as the first user message, and assistant
 * usage. Returns the assistant entry id for attribution.
 */
function writeChildSession(
	dir: string,
	prompt: string,
	assistantUsage: Usage,
): { assistantEntryId: string; sessionManager: SessionManager } {
	mkdirSync(dir, { recursive: true });
	const sessionManager = SessionManager.create(process.cwd(), dir);
	sessionManager.newSession();
	sessionManager.appendModelChange(model.provider, model.id);
	sessionManager.appendMessage(createUserMessage(prompt));
	const assistantEntryId = sessionManager.appendMessage(createAssistantMessage("done", cloneUsage(assistantUsage)));
	return { assistantEntryId, sessionManager };
}

const resolveContextWindow = () => 200000;

let tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "context-tree-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

describe("loadContextTreeChildrenFromDisk", () => {
	it("returns no nodes for a missing or empty rlm session dir", () => {
		expect(loadContextTreeChildrenFromDisk(undefined, resolveContextWindow)).toEqual([]);
		expect(loadContextTreeChildrenFromDisk(join(makeTempDir(), "missing"), resolveContextWindow)).toEqual([]);
		expect(loadContextTreeChildrenFromDisk(makeTempDir(), resolveContextWindow)).toEqual([]);
	});

	it("builds nodes recursively and separates own usage from attributed child usage", () => {
		const rlmDir = makeTempDir();
		const childDir = join(rlmDir, "sub-aaaa1111");
		const grandchildDir = join(childDir, "sub-bbbb2222");

		const childUsage = createUsage(1000, 200, 0.1);
		const grandchildUsage = createUsage(400, 50, 0.04);
		const child = writeChildSession(childDir, "summarize the auth module", childUsage);
		writeChildSession(grandchildDir, "read the oauth callbacks", grandchildUsage);

		// The child folds the grandchild's usage into its assistant message,
		// exactly like _attributeRlmChildUsageToParent does.
		const aggregate = cloneUsage(childUsage);
		addAssistantUsage(aggregate, grandchildUsage);
		child.sessionManager.appendChildUsageAttribution(child.assistantEntryId, grandchildUsage, aggregate);

		const nodes = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow);
		expect(nodes).toHaveLength(1);

		const childNode = nodes[0];
		expect(childNode.id).toBe("sub-aaaa1111");
		expect(childNode.label).toBe("summarize the auth module");
		expect(childNode.status).toBe("done");
		expect(childNode.model).toEqual({ provider: model.provider, id: model.id });
		// Aggregate includes the grandchild; own does not.
		expect(childNode.totalUsage.input).toBe(1400);
		expect(childNode.totalUsage.cost.total).toBeCloseTo(0.14);
		expect(childNode.ownUsage.input).toBe(1000);
		expect(childNode.ownUsage.output).toBe(200);
		expect(childNode.ownUsage.cost.total).toBeCloseTo(0.1);

		expect(childNode.children).toHaveLength(1);
		const grandchildNode = childNode.children[0];
		expect(grandchildNode.id).toBe("sub-bbbb2222");
		expect(grandchildNode.label).toBe("read the oauth callbacks");
		expect(grandchildNode.ownUsage.input).toBe(400);
		expect(grandchildNode.totalUsage.input).toBe(400);
		expect(grandchildNode.children).toEqual([]);

		// Own usage summed over the tree equals the attributed aggregate.
		expect(childNode.ownUsage.input + grandchildNode.ownUsage.input).toBe(childNode.totalUsage.input);
	});

	it("reports context usage from the last assistant message and the model context window", () => {
		const rlmDir = makeTempDir();
		writeChildSession(join(rlmDir, "sub-ctx00001"), "check context", createUsage(1500, 500, 0.02));

		const nodes = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow);
		expect(nodes[0].contextUsage).toEqual({
			tokens: 2000,
			contextWindow: 200000,
			percent: 1,
		});

		// Unknown context window: no context usage at all.
		const unresolved = loadContextTreeChildrenFromDisk(rlmDir, () => undefined);
		expect(unresolved[0].contextUsage).toBeUndefined();
	});

	it("reports unknown context usage after a trailing compaction", () => {
		const rlmDir = makeTempDir();
		const child = writeChildSession(join(rlmDir, "sub-comp0001"), "compact me", createUsage(1500, 500, 0.02));
		child.sessionManager.appendCompaction("summary", child.assistantEntryId, 2000);

		const nodes = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow);
		expect(nodes[0].contextUsage).toEqual({ tokens: null, contextWindow: 200000, percent: null });
	});

	it("derives error and cancelled status from the last assistant stop reason", () => {
		const rlmDir = makeTempDir();
		const errored = writeChildSession(join(rlmDir, "sub-err00001"), "fail", createUsage(100, 10, 0.01));
		errored.sessionManager.appendMessage({
			...createAssistantMessage("boom", createUsage(50, 5, 0.01)),
			stopReason: "error",
		});
		const aborted = writeChildSession(join(rlmDir, "sub-abr00001"), "stop", createUsage(100, 10, 0.01));
		aborted.sessionManager.appendMessage({
			...createAssistantMessage("", createUsage(50, 5, 0.01)),
			stopReason: "aborted",
		});

		const nodes = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow);
		const byId = new Map(nodes.map((n) => [n.id, n]));
		expect(byId.get("sub-err00001")?.status).toBe("error");
		expect(byId.get("sub-abr00001")?.status).toBe("cancelled");
	});

	it("sums only the current branch, excluding abandoned forked paths", () => {
		const rlmDir = makeTempDir();
		const childDir = join(rlmDir, "sub-fork0001");
		mkdirSync(childDir, { recursive: true });

		// Hand-written session with a fork: u1 -> a1 (abandoned) and u1 -> a2 (leaf).
		const header = {
			type: "session",
			version: 3,
			id: "11111111-2222-7333-8444-555555555555",
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
		};
		const entry = (id: string, parentId: string | null, message: unknown) => ({
			type: "message",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			message,
		});
		const lines = [
			header,
			{
				type: "model_change",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				provider: model.provider,
				modelId: model.id,
			},
			entry("u1", "m1", createUserMessage("forked work")),
			entry("a1", "u1", createAssistantMessage("abandoned", createUsage(9000, 900, 0.9))),
			entry("a2", "u1", createAssistantMessage("kept", createUsage(1000, 100, 0.1))),
		];
		writeFileSync(join(childDir, `${header.id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		const nodes = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow);
		expect(nodes).toHaveLength(1);
		// Only the leaf branch (u1 -> a2) counts; the abandoned a1 path does not.
		expect(nodes[0].ownUsage.input).toBe(1000);
		expect(nodes[0].totalUsage.input).toBe(1000);
		expect(nodes[0].contextUsage?.tokens).toBe(1100);
	});

	it("subtracts attributions targeting branch assistants even when the attribution entry is off-branch", () => {
		const rlmDir = makeTempDir();
		const childDir = join(rlmDir, "sub-attr0001");
		mkdirSync(childDir, { recursive: true });

		// a1 received a grandchild attribution, then the session forked from a1:
		// the attribution entry is off-branch but a1 (whose usage was rewritten
		// to the aggregate) is still on it.
		const grandchildUsage = createUsage(500, 50, 0.05);
		const ownAssistantUsage = createUsage(1000, 100, 0.1);
		const aggregate = cloneUsage(ownAssistantUsage);
		addAssistantUsage(aggregate, grandchildUsage);
		const header = {
			type: "session",
			version: 3,
			id: "11111111-2222-7333-8444-666666666666",
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
		};
		const entry = (id: string, parentId: string | null, message: unknown) => ({
			type: "message",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			message,
		});
		const lines = [
			header,
			entry("u1", null, createUserMessage("attributed work")),
			entry("a1", "u1", createAssistantMessage("answer", cloneUsage(ownAssistantUsage))),
			{
				type: "child_usage_attributed",
				id: "x1",
				parentId: "a1",
				timestamp: new Date().toISOString(),
				targetId: "a1",
				childUsage: grandchildUsage,
				aggregateUsage: aggregate,
			},
			entry("u2", "a1", createUserMessage("forked follow-up")),
		];
		writeFileSync(join(childDir, `${header.id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		const nodes = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow);
		expect(nodes).toHaveLength(1);
		// a1 carries the aggregate (1500) on the branch; own must subtract the
		// off-branch attribution back out.
		expect(nodes[0].totalUsage.input).toBe(1500);
		expect(nodes[0].ownUsage.input).toBe(1000);
	});

	it("includes trailing messages after the last assistant in context usage", () => {
		const rlmDir = makeTempDir();
		const child = writeChildSession(join(rlmDir, "sub-trail001"), "trailing", createUsage(1500, 500, 0.02));
		child.sessionManager.appendMessage(createUserMessage("a trailing user message that has not reached the model"));

		const nodes = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow);
		const tokens = nodes[0].contextUsage?.tokens;
		// Last assistant usage is 2000; the trailing message adds an estimate on top.
		expect(tokens).toBeGreaterThan(2000);
	});

	it("skips children that are already represented live", () => {
		const rlmDir = makeTempDir();
		writeChildSession(join(rlmDir, "sub-live0001"), "live child", createUsage(100, 10, 0.01));
		writeChildSession(join(rlmDir, "sub-done0001"), "done child", createUsage(200, 20, 0.02));

		const nodes = loadContextTreeChildrenFromDisk(rlmDir, resolveContextWindow, new Set(["sub-live0001"]));
		expect(nodes.map((node) => node.id)).toEqual(["sub-done0001"]);
	});
});

describe("AgentSession.getContextTree", () => {
	function createSession() {
		const settingsManager = SettingsManager.inMemory();
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model,
					systemPrompt: "You are a helpful assistant.",
					tools: [],
					thinkingLevel: "high",
				},
			}),
			sessionManager,
			settingsManager,
			cwd: process.cwd(),
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
		});
		return { session, sessionManager };
	}

	function syncAgentMessages(session: AgentSession, sessionManager: SessionManager): void {
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
	}

	it("returns a root node whose own usage excludes attributed child usage", () => {
		const { session, sessionManager } = createSession();
		sessionManager.appendMessage(createUserMessage("do the thing"));
		const assistantEntryId = sessionManager.appendMessage(
			createAssistantMessage("on it", createUsage(3000, 600, 0.3)),
		);

		const childUsage = createUsage(500, 100, 0.05);
		const aggregate = createUsage(3500, 700, 0.35);
		sessionManager.appendChildUsageAttribution(assistantEntryId, childUsage, aggregate);
		syncAgentMessages(session, sessionManager);

		const tree = session.getContextTree();
		expect(tree.id).toBe("root");
		expect(tree.status).toBe("active");
		expect(tree.model).toEqual({ provider: model.provider, id: model.id });
		expect(tree.totalUsage.input).toBe(3500);
		expect(tree.totalUsage.cost.total).toBeCloseTo(0.35);
		expect(tree.ownUsage.input).toBe(3000);
		expect(tree.ownUsage.cost.total).toBeCloseTo(0.3);
		// In-memory session, no rlm dir: completed children cannot be discovered.
		expect(tree.children).toEqual([]);
	});

	it("keeps pre-compaction spend in the totals after compaction", () => {
		// Intentional: /context reports cumulative session spend. Compaction
		// shrinks the model-facing context, but tokens already paid for must not
		// vanish from the totals (the old /usage undercounted here).
		const { session, sessionManager } = createSession();
		sessionManager.appendMessage(createUserMessage("expensive early work"));
		sessionManager.appendMessage(createAssistantMessage("done", createUsage(5000, 1000, 0.5)));
		const keptId = sessionManager.appendMessage(createUserMessage("later work"));
		sessionManager.appendCompaction("summary of early work", keptId, 6000);
		sessionManager.appendMessage(createAssistantMessage("after compaction", createUsage(200, 50, 0.02)));
		syncAgentMessages(session, sessionManager);

		const tree = session.getContextTree();
		expect(tree.totalUsage.input).toBe(5200);
		expect(tree.totalUsage.cost.total).toBeCloseTo(0.52);
		expect(tree.ownUsage.input).toBe(5200);
	});
});

describe("formatContextTree", () => {
	function node(overrides: Partial<ContextTreeNode>): ContextTreeNode {
		return {
			id: "root",
			label: "main agent",
			status: "active",
			ownUsage: emptyUsage(),
			totalUsage: emptyUsage(),
			children: [],
			...overrides,
		};
	}

	it("renders a tree with per-agent rows and own-usage totals", () => {
		const root = node({
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			ownUsage: createUsage(40000, 5200, 0.84),
			totalUsage: createUsage(52100, 5950, 1.1),
			contextUsage: { tokens: 62300, contextWindow: 200000, percent: 31.15 },
			children: [
				node({
					id: "sub-aaaa1111",
					label: "summarize auth module",
					status: "done",
					ownUsage: createUsage(12100, 750, 0.21),
					totalUsage: createUsage(12100, 750, 0.21),
					contextUsage: { tokens: 18000, contextWindow: 200000, percent: 9 },
				}),
				node({
					id: "sub-bbbb2222",
					label: "refactor tests",
					status: "running",
					ownUsage: createUsage(8000, 700, 0.13),
					totalUsage: createUsage(8000, 700, 0.13),
				}),
			],
		});

		const output = stripAnsi(formatContextTree(root, 100));
		const lines = output.split("\n");

		expect(lines[0]).toBe("Context");
		expect(output).toContain("Model: anthropic/claude-sonnet-4-5");
		expect(output).toContain("● main agent");
		expect(output).toContain("├─ ✓ summarize auth module");
		expect(output).toContain("└─ ◆ refactor tests");
		// Own usage per row: 45200 -> 45k, 12850 -> 13k, 8700 -> 8.7k.
		expect(output).toContain("45k");
		expect(output).toContain("$0.84");
		expect(output).toContain("31% (62k/200k)");
		// Totals sum own usage across all agents: 66750 -> 67k, $1.18.
		expect(output).toContain("Total: 67k tokens · $1.18 across 3 agents");
		// Detail sections carry the precise numbers /usage used to show.
		expect(output).toContain("Input: 60,100");
		expect(output).toContain("Output: 6,650");
		expect(output).toContain("Total: 66,750");
		expect(output).toContain("Cost\nTotal: $1.1800");
		expect(output).toContain("Context\nCurrent: 62,300 / 200,000 (31.2%)");
	});

	it("reports unknown context after compaction in the detail section", () => {
		const root = node({
			ownUsage: createUsage(900, 100, 0.01),
			totalUsage: createUsage(900, 100, 0.01),
			contextUsage: { tokens: null, contextWindow: 200000, percent: null },
		});
		const output = stripAnsi(formatContextTree(root, 100));
		expect(output).toContain("Current: unknown after compaction");
	});

	it("renders a lone root without tree glyphs or agent count", () => {
		const root = node({ ownUsage: createUsage(900, 100, 0.01), totalUsage: createUsage(900, 100, 0.01) });
		const output = stripAnsi(formatContextTree(root, 100));
		expect(output).toContain("● main agent");
		expect(output).not.toContain("├");
		expect(output).toContain("Total: 1.0k tokens · $0.01");
		expect(output).not.toContain("across");
	});
});
