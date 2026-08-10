import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createRlmSafeTerminalResultTerminalMessage,
	MAX_RLM_SAFE_TERMINAL_MESSAGE_BYTES,
	materializedTerminalMessageId,
	openRlmDurableOperationStore,
	readRlmDurableOperationRegistry,
} from "../src/core/rlm-durable-operations.js";

const uuid = (tail: number) => `00000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;
const parentId = uuid(1);
const assignmentId = uuid(2);
const operationId = uuid(3);
const deliveryId = uuid(4);
const childSessionId = uuid(5);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "rlm-safe-terminal-"));
	roots.push(root);
	const parentArtifacts = join(root, "parent-artifacts");
	const childArtifacts = join(root, "child-artifacts");
	mkdirSync(parentArtifacts);
	mkdirSync(childArtifacts);
	const parentFile = join(root, "parent.jsonl");
	const childFile = join(root, "child.jsonl");
	writeFileSync(parentFile, `${JSON.stringify({ type: "session", id: parentId })}\n`);
	writeFileSync(childFile, `${JSON.stringify({ type: "session", id: childSessionId })}\n`);
	const store = openRlmDurableOperationStore(parentArtifacts);
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
	const outbox = (message: ReturnType<typeof createRlmSafeTerminalResultTerminalMessage>) => ({
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
	});
	return { root, parentArtifacts, childArtifacts, childFile, store, outbox };
}

describe("C03 generic safe-terminal envelope", () => {
	it("uses only the exact generic keys and retains the opaque projection verbatim", () => {
		const projection = '{"unrelated":true,"nested":{"anything":"caller-owned"}}';
		const message = createRlmSafeTerminalResultTerminalMessage("human presentation", projection, 1);
		expect(message).toEqual({
			role: "custom",
			customType: "rlm_safe_terminal_result",
			content: "human presentation",
			display: true,
			details: { kind: "safe_terminal_result_v1", projection },
			timestamp: 1,
		});
		expect(Object.keys(message.details).sort()).toEqual(["kind", "projection"]);
	});

	it("permits caller-owned mismatched presentation without interpreting projection", () => {
		const f = fixture();
		const message = createRlmSafeTerminalResultTerminalMessage("status unavailable", '{"status":"completed"}', 1);
		expect(() => f.store.appendOutbox(f.outbox(message))).not.toThrow();
	});

	it("rejects unknown envelope keys and the full near-cap overflow while legacy remains 24KiB", () => {
		const f = fixture();
		const valid = createRlmSafeTerminalResultTerminalMessage("presentation", "{}", 1);
		expect(() =>
			f.store.appendOutbox(f.outbox({ ...valid, details: { ...valid.details, extra: true } } as never)),
		).toThrow(/details/);
		const base = createRlmSafeTerminalResultTerminalMessage("presentation", "", 1);
		const overhead = Buffer.byteLength(JSON.stringify(base));
		expect(() =>
			createRlmSafeTerminalResultTerminalMessage(
				"presentation",
				"x".repeat(MAX_RLM_SAFE_TERMINAL_MESSAGE_BYTES - overhead + 32),
				1,
			),
		).toThrow(/too large/);
		const legacy = {
			role: "custom" as const,
			customType: "rlm_child_terminal_notice" as const,
			content: "x".repeat(24 * 1024),
			display: true as const,
			details: { kind: "cancelled" as const, childId: "child", sessionName: "child" },
			timestamp: 1,
		};
		expect(() => f.store.appendOutbox(f.outbox(legacy as never))).toThrow(/too large/);
	});

	it("stores the exact message once with deterministic digest, import, restart, and materialization", () => {
		const f = fixture();
		const message = createRlmSafeTerminalResultTerminalMessage("arbitrary presentation", '{"safe":"opaque"}', 1);
		expect(f.store.appendOutbox(f.outbox(message))).toBe("new");
		expect(
			f.store.appendOutbox(
				f.outbox(createRlmSafeTerminalResultTerminalMessage("arbitrary presentation", '{"safe":"opaque"}', 1)),
			),
		).toBe("already_recorded");
		expect(
			f.store.recordTerminal({ parentSessionId: parentId, assignmentId, operationId, deliveryId, terminal: "done" }),
		).toBe(true);
		expect(f.store.importOutbox(f.outbox(message))).toBe("new");
		expect(f.store.pendingInbox()).toHaveLength(1);
		expect(f.store.pendingInbox()[0]!.message).toEqual(message);
		expect(readFileSync(join(f.childArtifacts, "rlm-terminal-outbox.jsonl"), "utf8")).toContain(
			JSON.stringify(message.details.projection),
		);
		expect(
			f.store.markMaterializedDelivery({
				parentSessionId: parentId,
				assignmentId,
				operationId,
				deliveryId,
				sessionMessageId: materializedTerminalMessageId(deliveryId),
			}),
		).toBe("new");
		const restarted = openRlmDurableOperationStore(f.parentArtifacts, {
			trustedChildRecoveryRoots: () => ({
				childSessionId,
				childSessionFile: f.childFile,
				childSessionRoot: f.root,
				childArtifactDir: f.childArtifacts,
				childArtifactRoot: f.root,
			}),
		});
		expect(restarted.pendingInbox()).toEqual([]);
		expect(
			readRlmDurableOperationRegistry(f.parentArtifacts, () => ({
				childSessionId,
				childSessionFile: f.childFile,
				childSessionRoot: f.root,
				childArtifactDir: f.childArtifacts,
				childArtifactRoot: f.root,
			})).deliveries.size,
		).toBe(1);
	});

	it("retains malformed JSONL recovery without introducing a provider or queue path", () => {
		const f = fixture();
		appendFileSync(join(f.parentArtifacts, "rlm-terminal-inbox.jsonl"), "{bad}\n");
		expect(readRlmDurableOperationRegistry(f.parentArtifacts).hasUncertainRecords).toBe(true);
	});
});
