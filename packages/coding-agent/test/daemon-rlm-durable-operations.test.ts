import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openRlmDurableOperationStore, readRlmDurableOperationRegistry } from "../src/core/rlm-durable-operations.js";

const uuid = (tail: number) => `00000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;
const roots: string[] = [];
afterEach(() =>
	roots.splice(0).forEach((root) => {
		rmSync(root, { recursive: true, force: true });
	}),
);

function createOperation(tail: number) {
	const root = mkdtempSync(join(tmpdir(), "daemon-rlm-durable-"));
	roots.push(root);
	const artifacts = join(root, "artifacts");
	const parent = join(root, "parent.jsonl");
	mkdirSync(artifacts);
	const parentId = uuid(1);
	writeFileSync(parent, `${JSON.stringify({ type: "session", id: parentId })}\n`);
	const store = openRlmDurableOperationStore(artifacts);
	const assignmentId = uuid(tail);
	const operationId = uuid(tail + 10);
	const deliveryId = uuid(tail + 20);
	store.admit({
		parentSessionId: parentId,
		parentSessionFile: parent,
		parentSessionRoot: root,
		parentArtifactRoot: root,
		childId: "reused-selector",
		assignmentId,
		operationId,
		deliveryId,
		childSessionDir: root,
		requestedModel: { provider: "test", modelId: "test" },
		rlmDepth: 1,
		rlmMaxDepth: 2,
	});
	return { root, artifacts, store, parentId, assignmentId, operationId, deliveryId };
}

describe("daemon RLM durable operation identity fences", () => {
	it("admission is authoritative before work and passive reads neither wake nor write", () => {
		const f = createOperation(2);
		const before = readRlmDurableOperationRegistry(f.artifacts);
		expect(before.operations).toHaveLength(1);
		expect(before.operations.get(JSON.stringify([f.parentId, f.assignmentId, f.operationId]))?.lifecycle).toBe(
			"admitted",
		);
		// A passive catalog/list projection is reducer-only: no child session, outbox,
		// inbox, transcript, or prompt task is manufactured merely by inspection.
		expect(before.deliveries).toHaveLength(0);
		expect(readRlmDurableOperationRegistry(f.artifacts).operations).toHaveLength(1);
	});

	it("separates reused-selector A/B operations so stale A cannot release or delete B", () => {
		const f = createOperation(2);
		const assignmentB = uuid(3);
		const operationB = uuid(13);
		const deliveryB = uuid(23);
		f.store.admit({
			parentSessionId: f.parentId,
			parentSessionFile: join(f.root, "parent.jsonl"),
			parentSessionRoot: f.root,
			parentArtifactRoot: f.root,
			childId: "reused-selector",
			assignmentId: assignmentB,
			operationId: operationB,
			deliveryId: deliveryB,
			childSessionDir: f.root,
			requestedModel: { provider: "test", modelId: "test" },
			rlmDepth: 1,
			rlmMaxDepth: 2,
		});
		// Neither A nor B can transition without its own materialized terminal; in
		// particular a stale A callback has no selector-only capability over B.
		expect(
			f.store.recordRelease(
				{ parentSessionId: f.parentId, assignmentId: f.assignmentId, operationId: f.operationId },
				"deleted",
			),
		).toBe(false);
		expect(
			f.store.recordRelease(
				{ parentSessionId: f.parentId, assignmentId: assignmentB, operationId: operationB },
				"deleted",
			),
		).toBe(false);
		const registry = f.store.rebuild();
		expect(registry.operations.get(JSON.stringify([f.parentId, assignmentB, operationB]))?.lifecycle).toBe(
			"admitted",
		);
	});

	it("keeps late A terminal/release/delete facts disjoint from a reused B operation and parent generation", () => {
		const f = createOperation(2);
		const assignmentB = uuid(3);
		const operationB = uuid(13);
		const deliveryB = uuid(23);
		f.store.admit({
			parentSessionId: f.parentId,
			parentSessionFile: join(f.root, "parent.jsonl"),
			parentSessionRoot: f.root,
			parentArtifactRoot: f.root,
			childId: "reused-selector",
			assignmentId: assignmentB,
			operationId: operationB,
			deliveryId: deliveryB,
			childSessionDir: f.root,
			requestedModel: { provider: "test", modelId: "B-different-operation" },
			rlmDepth: 1,
			rlmMaxDepth: 2,
		});
		// A's held callback has no B operation capability, even after the daemon
		// parent incarnation is replaced: no B terminal/outbox/inbox/registry fact.
		expect(
			f.store.recordTerminal({
				parentSessionId: f.parentId,
				assignmentId: f.assignmentId,
				operationId: operationB,
				deliveryId: deliveryB,
				terminal: "done",
			}),
		).toBe(false);
		expect(
			f.store.recordRelease(
				{ parentSessionId: f.parentId, assignmentId: f.assignmentId, operationId: operationB },
				"deleted",
			),
		).toBe(false);
		const rebuilt = f.store.rebuild();
		expect(rebuilt.operations.get(JSON.stringify([f.parentId, assignmentB, operationB]))).toMatchObject({
			lifecycle: "admitted",
			deliveryId: deliveryB,
		});
		expect(rebuilt.deliveries).toHaveLength(0);
	});

	it("makes passive catalog reduction read-only with pending disk facts", () => {
		const f = createOperation(2);
		const before = readdirSync(f.artifacts).sort();
		const ledgerPath = join(f.artifacts, "rlm-operation-ledger.jsonl");
		const size = statSync(ledgerPath).size;
		// This is the same reducer used by list/catalog discovery: it neither opens
		// child runtime directories nor manufactures indexes, outboxes, inboxes, or
		// transcript work merely because a durable admission is visible on disk.
		const passive = readRlmDurableOperationRegistry(f.artifacts);
		expect(passive.operations).toHaveLength(1);
		expect(readdirSync(f.artifacts).sort()).toEqual(before);
		expect(statSync(ledgerPath).size).toBe(size);
		expect(f.store.pendingInbox()).toEqual([]);
	});
});
