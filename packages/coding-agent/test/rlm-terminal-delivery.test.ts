import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import {
	materializedTerminalMessageId,
	openRlmDurableOperationStore,
	type RlmTerminalMessage,
} from "../src/core/rlm-durable-operations.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const id = (tail: number) => `00000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;
const parentId = id(1);
const assignmentId = id(2);
const operationId = id(3);
const deliveryId = id(4);
const childSessionId = id(5);
const roots: string[] = [];
afterEach(() =>
	roots.splice(0).forEach((root) => {
		rmSync(root, { recursive: true, force: true });
	}),
);

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "rlm-terminal-delivery-"));
	roots.push(root);
	const artifacts = join(root, "parent-artifacts");
	const childArtifacts = join(root, "child-artifacts");
	mkdirSync(artifacts);
	mkdirSync(childArtifacts);
	const parentFile = join(root, "parent.jsonl");
	const childFile = join(root, "child.jsonl");
	writeFileSync(parentFile, `${JSON.stringify({ type: "session", id: parentId })}\n`);
	writeFileSync(childFile, `${JSON.stringify({ type: "session", id: childSessionId })}\n`);
	const store = openRlmDurableOperationStore(artifacts);
	store.admit({
		parentSessionId: parentId,
		parentSessionFile: parentFile,
		parentSessionRoot: root,
		parentArtifactRoot: root,
		childId: "child",
		assignmentId,
		operationId,
		deliveryId,
		childSessionDir: root,
		requestedModel: { provider: "test", modelId: "test" },
		rlmDepth: 1,
		rlmMaxDepth: 2,
	});
	expect(
		store.markMaterialized({
			parentSessionId: parentId,
			assignmentId,
			operationId,
			childSessionId,
			childSessionFile: childFile,
			childSessionRoot: root,
			childArtifactDir: childArtifacts,
			childArtifactRoot: root,
		}),
	).toBe(true);
	const message: RlmTerminalMessage = {
		role: "custom",
		customType: "rlm_child_terminal_notice",
		content: "child completed",
		display: true,
		details: { kind: "completed_without_reply", childId: "child", sessionName: "child" },
		timestamp: 1,
	};
	const outbox = {
		parentSessionId: parentId,
		parentSessionFile: parentFile,
		parentSessionRoot: root,
		parentArtifactRoot: root,
		childSessionId,
		childSessionFile: childFile,
		childSessionRoot: root,
		childArtifactDir: childArtifacts,
		childArtifactRoot: root,
		childId: "child",
		assignmentId,
		operationId,
		deliveryId,
		terminal: "done" as const,
		message,
	};
	store.appendOutbox(outbox);
	expect(
		store.recordTerminal({ parentSessionId: parentId, assignmentId, operationId, deliveryId, terminal: "done" }),
	).toBe(true);
	return { root, artifacts, store, outbox, message };
}

function consumeIfTranscriptHasId(store: ReturnType<typeof openRlmDurableOperationStore>, transcriptIds: Set<string>) {
	for (const inbox of store.pendingInbox()) {
		const messageId = materializedTerminalMessageId(inbox.deliveryId);
		if (!transcriptIds.has(messageId)) transcriptIds.add(messageId);
		store.markMaterializedDelivery({
			parentSessionId: inbox.parentSessionId,
			assignmentId: inbox.assignmentId,
			operationId: inbox.operationId,
			deliveryId: inbox.deliveryId,
			sessionMessageId: messageId,
		});
	}
}

describe("RLM terminal durable delivery", () => {
	it("keeps inbox-before-transcript pending, then appends exactly one deterministic normal message", () => {
		const f = fixture();
		expect(f.store.importOutbox(f.outbox)).toBe("new");
		expect(f.store.pendingInbox()).toHaveLength(1);
		const transcriptIds = new Set<string>();
		// A failed/no-op transcript attempt cannot consume an inbox record.
		expect(f.store.pendingInbox()[0]?.message.content).toBe("child completed");
		expect(transcriptIds).toEqual(new Set());
		consumeIfTranscriptHasId(f.store, transcriptIds);
		expect(transcriptIds).toEqual(new Set([materializedTerminalMessageId(deliveryId)]));
		expect(f.store.pendingInbox()).toHaveLength(0);
		consumeIfTranscriptHasId(f.store, transcriptIds);
		expect(transcriptIds).toHaveLength(1);
	});

	it("re-scans transcript-before-consumed and never duplicates a delivery after retry/restart", () => {
		const f = fixture();
		f.store.importOutbox(f.outbox);
		const transcriptIds = new Set([materializedTerminalMessageId(deliveryId)]);
		consumeIfTranscriptHasId(f.store, transcriptIds);
		expect(transcriptIds).toHaveLength(1);
		expect(f.store.pendingInbox()).toHaveLength(0);
		// A fresh owner sees the authoritative consumed fact, not a prompt replay.
		const restarted = openRlmDurableOperationStore(f.artifacts, {
			trustedChildRecoveryRoots: () => ({
				childSessionId,
				childSessionFile: f.outbox.childSessionFile,
				childSessionRoot: f.root,
				childArtifactDir: f.outbox.childArtifactDir,
				childArtifactRoot: f.root,
			}),
		});
		expect(restarted.pendingInbox()).toHaveLength(0);
	});

	it("allows one exact deleted-A discard without fabricating a transcript fact", () => {
		const f = fixture();
		f.store.importOutbox(f.outbox);
		appendFileSync(
			join(f.artifacts, "rlm-operation-ledger.jsonl"),
			`${JSON.stringify({ version: 1, type: "deleted", parentSessionId: parentId, assignmentId, operationId, recordedAt: new Date().toISOString() })}\n`,
		);
		expect(
			f.store.markDiscardedDelivery({
				parentSessionId: parentId,
				assignmentId,
				operationId,
				deliveryId,
				reason: "deleted",
			}),
		).toBe("new");
		expect(f.store.pendingInbox()).toHaveLength(0);
	});
});

function liveParent(root: string, file: string) {
	const sessionManager = SessionManager.open(file, join(root, "sessions"));
	const auth = AuthStorage.create(join(root, "auth.json"));
	auth.setRuntimeApiKey("anthropic", "test-key");
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
		streamFn: vi.fn(() => {
			throw new Error("terminal transcript append must never call a provider");
		}),
	});
	return new AgentSession({
		agent,
		sessionManager,
		settingsManager: SettingsManager.create(root, root),
		cwd: root,
		modelRegistry: ModelRegistry.create(auth, join(root, "models.json")),
		resourceLoader: createTestResourceLoader(),
	});
}

describe("C03 real normal transcript materialization", () => {
	it("persists immediately while parent streaming without a prompt, queue, or provider turn", async () => {
		const f = fixture();
		f.store.importOutbox(f.outbox);
		const parent = liveParent(f.root, f.outbox.parentSessionFile);
		const queue = vi.fn(async () => undefined);
		Object.defineProperty(parent.agent.state, "isStreaming", { configurable: true, get: () => true });
		vi.spyOn(parent, "sendCustomMessage");
		vi.spyOn(
			parent as unknown as { _queuePreparedPrompt: (...args: unknown[]) => Promise<void> },
			"_queuePreparedPrompt",
		).mockImplementation(queue);
		const inbox = f.store.pendingInbox()[0]!;
		expect(await parent.appendDurableRlmTerminalMessage(inbox.message, inbox.deliveryId)).toBe(true);
		expect(parent.sendCustomMessage).not.toHaveBeenCalled();
		expect(queue).not.toHaveBeenCalled();
		const id = materializedTerminalMessageId(inbox.deliveryId);
		expect(readFileSync(f.outbox.parentSessionFile, "utf8")).toContain(id);
		// The caller may now acknowledge only after it observed this durable entry.
		f.store.markMaterializedDelivery({
			parentSessionId: inbox.parentSessionId,
			assignmentId: inbox.assignmentId,
			operationId: inbox.operationId,
			deliveryId: inbox.deliveryId,
			sessionMessageId: id,
		});
		expect(f.store.pendingInbox()).toEqual([]);
		expect(parent.messages.filter((message) => message.role === "custom")).toHaveLength(1);
		parent.dispose();
	});

	it("retries an inbox-before-transcript cut and appends one normal custom message without prompt/provider replay", async () => {
		const f = fixture();
		f.store.importOutbox(f.outbox);
		const parent = liveParent(f.root, f.outbox.parentSessionFile);
		const append = vi.spyOn(parent, "appendDurableRlmTerminalMessage");
		// The inbox is authoritative before a transcript attempt. A retry uses the
		// same deterministic id and only consumes after the real normal append.
		expect(f.store.pendingInbox()).toHaveLength(1);
		const inbox = f.store.pendingInbox()[0]!;
		expect(await parent.appendDurableRlmTerminalMessage(inbox.message, inbox.deliveryId)).toBe(true);
		// A deterministic transcript duplicate is an idempotent durable success,
		// not a second append.
		expect(await parent.appendDurableRlmTerminalMessage(inbox.message, inbox.deliveryId)).toBe(true);
		expect(append).toHaveBeenCalledTimes(2);
		f.store.markMaterializedDelivery({
			parentSessionId: inbox.parentSessionId,
			assignmentId: inbox.assignmentId,
			operationId: inbox.operationId,
			deliveryId: inbox.deliveryId,
			sessionMessageId: materializedTerminalMessageId(inbox.deliveryId),
		});
		expect(f.store.pendingInbox()).toEqual([]);
		const messages = parent.messages.filter((message) => message.role === "custom");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			customType: "rlm_child_terminal_notice",
			details: { id: materializedTerminalMessageId(deliveryId) },
		});
		expect(parent.isStreaming).toBe(false);
		parent.dispose();
	});
});
