import * as fs from "node:fs";
import {
	appendFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	materializedTerminalMessageId,
	openRlmDurableOperationStore,
	type RlmDurableIo,
	type RlmTerminalMessage,
	readRlmDurableOperationRegistry,
} from "../src/core/rlm-durable-operations.js";

const uuid = (tail: number) => `00000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;
const parentId = uuid(1);
const assignment = uuid(2);
const operation = uuid(3);
const delivery = uuid(4);
const childId = uuid(5);
const childSessionId = uuid(6);

interface Fixture {
	root: string;
	parentFile: string;
	childFile: string;
	parentArtifacts: string;
	childArtifacts: string;
	childSessions: string;
	admission: ReturnType<typeof admission>;
}
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function session(path: string, id: string): void {
	writeFileSync(path, `${JSON.stringify({ type: "session", id, version: 3 })}\n`);
}
function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "rlm-durable-"));
	roots.push(root);
	const parentSessions = join(root, "parent-sessions");
	const childSessions = join(root, "child-sessions");
	const parentArtifacts = join(root, "parent-artifacts");
	const childArtifacts = join(root, "child-artifacts");
	mkdirSync(parentSessions);
	mkdirSync(childSessions);
	mkdirSync(parentArtifacts);
	mkdirSync(childArtifacts);
	const parentFile = join(parentSessions, "parent.jsonl");
	const childFile = join(childSessions, "child.jsonl");
	session(parentFile, parentId);
	session(childFile, childSessionId);
	return {
		root,
		parentFile,
		childFile,
		parentArtifacts,
		childArtifacts,
		childSessions,
		admission: admission(parentFile, root, parentArtifacts, childSessions),
	};
}
function admission(parentFile: string, root: string, _parentArtifacts: string, childSessions: string) {
	return {
		parentSessionId: parentId,
		parentSessionFile: parentFile,
		parentSessionRoot: root,
		parentArtifactRoot: root,
		childId,
		assignmentId: assignment,
		operationId: operation,
		deliveryId: delivery,
		childSessionDir: childSessions,
		requestedModel: { provider: "test", modelId: "model" },
		rlmDepth: 1,
		rlmMaxDepth: 2,
	};
}
function message(content = "terminal"): RlmTerminalMessage {
	return {
		role: "custom",
		customType: "rlm_child_terminal_notice",
		content,
		display: true,
		details: { kind: "cancelled", childId, sessionName: "child" },
		timestamp: 1,
	};
}
function outbox(f: Fixture, terminal: "done" | "error" | "cancelled" = "done", content = "terminal") {
	return {
		parentSessionId: parentId,
		parentSessionFile: f.parentFile,
		parentSessionRoot: f.root,
		parentArtifactRoot: f.root,
		childSessionId,
		childSessionFile: f.childFile,
		childSessionRoot: f.root,
		childArtifactDir: f.childArtifacts,
		childArtifactRoot: f.root,
		childId,
		assignmentId: assignment,
		operationId: operation,
		deliveryId: delivery,
		terminal,
		message: message(content),
	};
}
function outboxRecord(input: ReturnType<typeof outbox>): Record<string, unknown> {
	const {
		parentSessionRoot: _parentSessionRoot,
		parentArtifactRoot: _parentArtifactRoot,
		childSessionRoot: _childSessionRoot,
		childArtifactDir: _childArtifactDir,
		childArtifactRoot: _childArtifactRoot,
		...record
	} = input;
	return { version: 1, type: "terminal", ...record, recordedAt: new Date().toISOString() };
}

function trustedRoots(f: Fixture) {
	return () => ({
		childSessionId,
		childSessionFile: f.childFile,
		childSessionRoot: f.root,
		childArtifactDir: f.childArtifacts,
		childArtifactRoot: f.root,
	});
}
function appendRecord(path: string, record: Record<string, unknown>): void {
	appendFileSync(path, `${JSON.stringify(record)}\n`);
}

function materialize(store: ReturnType<typeof openRlmDurableOperationStore>, f: Fixture): void {
	expect(
		store.markMaterialized({
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			childSessionId,
			childSessionFile: f.childFile,
			childSessionRoot: f.root,
			childArtifactDir: f.childArtifacts,
			childArtifactRoot: f.root,
		}),
	).toBe(true);
}

function mode(path: string): number {
	return lstatSync(path).mode & 0o777;
}

describe("RLM durable operation store", () => {
	it("records sibling session/artifact layout with owner-only durable files and deterministic ids", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		const admitted = store.admit(f.admission);
		expect(admitted.lifecycle).toBe("admitted");
		expect(mode(f.parentArtifacts)).toBe(0o700);
		expect(mode(join(f.parentArtifacts, "rlm-operation-ledger.jsonl"))).toBe(0o600);
		expect(materializedTerminalMessageId(delivery)).toBe(`rlm-terminal-${delivery}`);
		materialize(store, f);
		expect(store.appendOutbox(outbox(f))).toBe("new");
		expect(mode(join(f.childArtifacts, "rlm-terminal-outbox.jsonl"))).toBe(0o600);
		expect(
			store.recordTerminal({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				terminal: "done",
			}),
		).toBe(true);
		expect(store.importOutbox(outbox(f))).toBe("new");
		expect(
			store.markMaterializedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				sessionMessageId: materializedTerminalMessageId(delivery),
			}),
		).toBe("new");
		expect(mode(join(f.parentArtifacts, "rlm-terminal-consumed.jsonl"))).toBe(0o600);
	});

	it("makes exact materialization retries idempotent after the lifecycle advances", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		materialize(store, f);
		expect(
			store.markMaterialized({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				childSessionId,
				childSessionFile: f.childFile,
				childSessionRoot: f.root,
				childArtifactDir: f.childArtifacts,
				childArtifactRoot: f.root,
			}),
		).toBe(true);
	});

	it("makes exact duplicates idempotent and conflicting terminal body uncertain/fail-closed", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		expect(store.admit(f.admission).key).toContain(operation);
		materialize(store, f);
		expect(store.appendOutbox(outbox(f))).toBe("new");
		expect(store.appendOutbox(outbox(f))).toBe("already_recorded");
		expect(() => store.appendOutbox(outbox(f, "done", "different"))).toThrow(/Conflicting/);
		store.recordTerminal({
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			deliveryId: delivery,
			terminal: "done",
		});
		// A physically injected second body is never last-write-wins.
		appendFileSync(
			join(f.childArtifacts, "rlm-terminal-outbox.jsonl"),
			`${JSON.stringify(outboxRecord(outbox(f, "done", "different")))}\n`,
		);
		const rebuilt = readRlmDurableOperationRegistry(f.parentArtifacts);
		expect(rebuilt.operations.get(JSON.stringify([parentId, assignment, operation]))?.uncertain).toBe(true);
		expect(rebuilt.hasUncertainRecords).toBe(true);
	});

	it("requires outbox then ledger then inbox then transcript-consumption", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		materialize(store, f);
		expect(
			store.recordTerminal({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				terminal: "done",
			}),
		).toBe(false);
		expect(() => store.importOutbox(outbox(f))).toThrow(/ledger-recorded/);
		store.appendOutbox(outbox(f));
		expect(
			store.recordTerminal({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				terminal: "done",
			}),
		).toBe(true);
		store.importOutbox(outbox(f));
		expect(
			store.markMaterializedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				sessionMessageId: materializedTerminalMessageId(delivery),
			}),
		).toBe("new");
		expect(
			store.markMaterializedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				sessionMessageId: materializedTerminalMessageId(delivery),
			}),
		).toBe("already_materialized");
	});

	it("globally quarantines prior and later operations after an unkeyed complete corrupt record", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		materialize(store, f);
		expect(store.appendOutbox(outbox(f))).toBe("new");
		expect(
			store.recordTerminal({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				terminal: "done",
			}),
		).toBe(true);
		expect(store.importOutbox(outbox(f))).toBe("new");

		const ledger = join(f.parentArtifacts, "rlm-operation-ledger.jsonl");
		appendFileSync(ledger, "{this is a complete but unkeyed corrupt record}\n");
		const later = JSON.parse(readFileSync(ledger, "utf8").split("\n")[0]!) as Record<string, unknown>;
		const laterAssignment = uuid(10);
		const laterOperation = uuid(11);
		const laterDelivery = uuid(12);
		appendRecord(ledger, {
			...later,
			childId: uuid(13),
			assignmentId: laterAssignment,
			operationId: laterOperation,
			deliveryId: laterDelivery,
		});

		const rebuilt = store.rebuild();
		const aKey = JSON.stringify([parentId, assignment, operation]);
		const bKey = JSON.stringify([parentId, laterAssignment, laterOperation]);
		expect(rebuilt.hasUncertainRecords).toBe(true);
		expect(rebuilt.operations.get(aKey)?.uncertain).toBe(true);
		expect(rebuilt.deliveries.get(JSON.stringify([aKey, delivery]))?.uncertain).toBe(true);
		expect(rebuilt.operations.get(bKey)?.uncertain).toBe(true);
		expect(store.pendingInbox()).toEqual([]);
		expect(store.importPendingOutboxes()).toBe(0);
		expect(() =>
			store.admit({ ...f.admission, assignmentId: uuid(14), operationId: uuid(15), deliveryId: uuid(16) }),
		).toThrow(/globally uncertain/);
		expect(
			store.markMaterialized({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				childSessionId,
				childSessionFile: f.childFile,
				childSessionRoot: f.root,
				childArtifactDir: f.childArtifacts,
				childArtifactRoot: f.root,
			}),
		).toBe(false);
		expect(
			store.recordTerminal({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				terminal: "done",
			}),
		).toBe(false);
		expect(() => store.appendOutbox(outbox(f))).toThrow(/globally uncertain/);
		expect(() => store.importOutbox(outbox(f))).toThrow(/globally uncertain/);
		expect(() =>
			store.markMaterializedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				sessionMessageId: materializedTerminalMessageId(delivery),
			}),
		).toThrow(/globally uncertain/);
		expect(
			store.recordDeleteIntent({ parentSessionId: parentId, assignmentId: assignment, operationId: operation }),
		).toBe(false);
		expect(
			store.recordRelease(
				{ parentSessionId: parentId, assignmentId: assignment, operationId: operation },
				"released",
			),
		).toBe(false);
		// Quarantine has no recovery/mutation writes; only the intentionally injected
		// corrupt record and the later valid admission are present after the original facts.
		expect(readFileSync(ledger, "utf8").split("\n")).toHaveLength(6);
	});

	it("globally quarantines a complete malformed record even when it carries a valid-looking key", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		const ledger = join(f.parentArtifacts, "rlm-operation-ledger.jsonl");
		appendRecord(ledger, {
			version: 1,
			type: "materialized",
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			childSessionId: "not-a-uuid",
			childSessionFile: f.childFile,
			childSessionRoot: f.root,
			childArtifactDir: f.childArtifacts,
			childArtifactRoot: f.root,
			recordedAt: new Date().toISOString(),
		});
		const rebuilt = store.rebuild();
		expect(rebuilt).toMatchObject({ hasUncertainRecords: true, hasGlobalUncertainty: true });
		expect(rebuilt.operations.get(JSON.stringify([parentId, assignment, operation]))?.uncertain).toBe(true);
		expect(() =>
			store.admit({
				...f.admission,
				childId: uuid(20),
				assignmentId: uuid(21),
				operationId: uuid(22),
				deliveryId: uuid(23),
			}),
		).toThrow(/globally uncertain/);
	});

	it("ignores and repairs every non-newline final tail before a subsequent append", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		const ledger = join(f.parentArtifacts, "rlm-operation-ledger.jsonl");
		appendFileSync(ledger, '{"version":1,"type":"admitted"');
		expect(readRlmDurableOperationRegistry(f.parentArtifacts).hasUncertainRecords).toBe(false);
		appendFileSync(ledger, "\n");
		expect(readRlmDurableOperationRegistry(f.parentArtifacts).hasUncertainRecords).toBe(true);

		const g = fixture();
		const torn = openRlmDurableOperationStore(g.parentArtifacts);
		torn.admit(g.admission);
		const tornLedger = join(g.parentArtifacts, "rlm-operation-ledger.jsonl");
		const complete = readFileSync(tornLedger, "utf8").trimEnd();
		writeFileSync(tornLedger, complete);
		expect(readRlmDurableOperationRegistry(g.parentArtifacts).operations.size).toBe(0);
		torn.admit(g.admission);
		expect(readRlmDurableOperationRegistry(g.parentArtifacts).operations.size).toBe(1);
		expect(readFileSync(tornLedger, "utf8")).toMatch(/\n$/);
	});

	it("rejects UUID, terminal projection, traversal, symlink escape, and forged session identity", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		expect(() => store.admit({ ...f.admission, operationId: "not-a-uuid" })).toThrow(/canonical UUID/);
		expect(() => store.admit({ ...f.admission, parentSessionFile: f.childFile })).toThrow(/does not match/);
		const outside = join(f.root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(f.root, "escape"));
		expect(() => store.admit({ ...f.admission, parentArtifactRoot: join(f.root, "escape") })).toThrow(/escapes/);
		store.admit(f.admission);
		materialize(store, f);
		expect(() => store.appendOutbox({ ...outbox(f), terminal: "completed" as never })).toThrow(/Unknown terminal/);
	});

	it("uses a write-all loop, fails zero-progress writes before fsync, and leaves no claimed admission", () => {
		const f = fixture();
		let writes = 0;
		let syncs = 0;
		const partial = {
			...fs,
			writeSync: (fd: number, data: Buffer, offset: number, length: number) => {
				writes++;
				return fs.writeSync(fd, data, offset, Math.max(1, Math.min(length, 3)));
			},
			fsyncSync: (fd: number) => {
				syncs++;
				return fs.fsyncSync(fd);
			},
		} as unknown as RlmDurableIo;
		const store = openRlmDurableOperationStore(f.parentArtifacts, { io: partial });
		store.admit(f.admission);
		expect(writes).toBeGreaterThan(1);
		expect(syncs).toBeGreaterThan(0);
		const zero = { ...fs, writeSync: () => 0 } as unknown as RlmDurableIo;
		const g = fixture();
		const broken = openRlmDurableOperationStore(g.parentArtifacts, { io: zero });
		expect(() => broken.admit(g.admission)).toThrow(/no forward progress/);
		expect(readRlmDurableOperationRegistry(g.parentArtifacts).operations.size).toBe(0);
	});

	it("does not make a cache cut authoritative and passive reads do not repair it", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		store.rebuild();
		const index = join(f.parentArtifacts, "rlm-active-index.json");
		writeFileSync(index, "torn");
		const before = readFileSync(index, "utf8");
		const passive = readRlmDurableOperationRegistry(f.parentArtifacts);
		expect(passive.operations.size).toBe(1);
		expect(readFileSync(index, "utf8")).toBe(before);
		const renameCut = {
			...fs,
			renameSync: () => {
				throw new Error("cut before rename");
			},
		} as unknown as RlmDurableIo;
		expect(openRlmDurableOperationStore(f.parentArtifacts, { io: renameCut }).rebuild().operations.size).toBe(1);
		expect(readRlmDurableOperationRegistry(f.parentArtifacts).operations.size).toBe(1);
	});

	it("projects a body-free cache after terminal delivery", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		const secret = "terminal body must never reach index";
		store.admit(f.admission);
		materialize(store, f);
		store.appendOutbox(outbox(f, "done", secret));
		store.recordTerminal({
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			deliveryId: delivery,
			terminal: "done",
		});
		store.importOutbox(outbox(f, "done", secret));
		store.rebuild();
		const index = JSON.parse(readFileSync(join(f.parentArtifacts, "rlm-active-index.json"), "utf8"));
		expect(JSON.stringify(index)).not.toContain(secret);
		expect(index.deliveries[0]).not.toHaveProperty("outboxRecord");
		expect(index.deliveries[0]).not.toHaveProperty("inboxRecord");
		expect(index.deliveries[0]).not.toHaveProperty("message");
	});

	it("allows one exact deleted-assignment discard, never a materialized delivery", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		materialize(store, f);
		store.appendOutbox(outbox(f));
		store.recordTerminal({
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			deliveryId: delivery,
			terminal: "done",
		});
		store.importOutbox(outbox(f));
		appendFileSync(
			join(f.parentArtifacts, "rlm-operation-ledger.jsonl"),
			`${JSON.stringify({ version: 1, type: "deleted", parentSessionId: parentId, assignmentId: assignment, operationId: operation, recordedAt: new Date().toISOString() })}\n`,
		);
		expect(
			store.markDiscardedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				reason: "deleted",
			}),
		).toBe("new");
		expect(
			store.markDiscardedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				reason: "deleted",
			}),
		).toBe("already_discarded");
	});
	it("refuses alternate contained artifacts for both outbox append and import", () => {
		const f = fixture();
		const alternate = join(f.root, "alternate-child-artifacts");
		mkdirSync(alternate);
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		materialize(store, f);
		const stranded = { ...outbox(f), childArtifactDir: alternate };
		expect(() => store.appendOutbox(stranded)).toThrow(/conflicts/);
		store.appendOutbox(outbox(f));
		store.recordTerminal({
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			deliveryId: delivery,
			terminal: "done",
		});
		expect(() => store.importOutbox(stranded)).toThrow(/conflicts/);
		expect(() => readFileSync(join(alternate, "rlm-terminal-outbox.jsonl"), "utf8")).toThrow();
	});

	it("does not authorize a raw outbox stranded in an alternate contained artifact", () => {
		const f = fixture();
		const alternate = join(f.root, "raw-alternate-child-artifacts");
		mkdirSync(alternate);
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		// Simulate an old/wrong writer by placing otherwise valid production facts
		// directly in JSONL, with the outbox under a contained but non-materialized dir.
		appendRecord(join(f.parentArtifacts, "rlm-operation-ledger.jsonl"), {
			version: 1,
			type: "materialized",
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			childSessionId,
			childSessionFile: f.childFile,
			childSessionRoot: f.root,
			childArtifactDir: f.childArtifacts,
			childArtifactRoot: f.root,
			recordedAt: new Date().toISOString(),
		});
		appendRecord(join(f.parentArtifacts, "rlm-operation-ledger.jsonl"), {
			version: 1,
			type: "terminal_recorded",
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			deliveryId: delivery,
			terminal: "done",
			recordedAt: new Date().toISOString(),
		});
		appendRecord(
			join(alternate, "rlm-terminal-outbox.jsonl"),
			outboxRecord({ ...outbox(f), childArtifactDir: alternate }),
		);
		const rebuilt = readRlmDurableOperationRegistry(f.parentArtifacts, trustedRoots(f));
		const key = JSON.stringify([parentId, assignment, operation]);
		const rawDelivery = rebuilt.deliveries.get(JSON.stringify([key, delivery]));
		expect(rebuilt.operations.get(key)?.uncertain).toBe(true);
		expect(rawDelivery?.outboxed).toBe(false);
		expect(rawDelivery?.uncertain).toBe(true);
	});

	it("does not authorize a raw sibling-session/artifact substitution under trusted broad roots", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		const siblingSessionId = uuid(7);
		const siblingFile = join(f.childSessions, "sibling.jsonl");
		const siblingArtifacts = join(f.root, "sibling-artifacts");
		session(siblingFile, siblingSessionId);
		mkdirSync(siblingArtifacts);
		// These are raw production JSONL facts, not calls to materialization helpers.
		appendRecord(join(f.parentArtifacts, "rlm-operation-ledger.jsonl"), {
			version: 1,
			type: "materialized",
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			childSessionId: siblingSessionId,
			childSessionFile: siblingFile,
			childSessionRoot: f.root,
			childArtifactDir: siblingArtifacts,
			childArtifactRoot: f.root,
			recordedAt: new Date().toISOString(),
		});
		appendRecord(
			join(siblingArtifacts, "rlm-terminal-outbox.jsonl"),
			outboxRecord({ ...outbox(f), childSessionId: siblingSessionId, childSessionFile: siblingFile }),
		);
		const rebuilt = readRlmDurableOperationRegistry(f.parentArtifacts, trustedRoots(f));
		expect(rebuilt.operations.get(JSON.stringify([parentId, assignment, operation]))?.uncertain).toBe(true);
		expect(rebuilt.deliveries.size).toBe(0);
	});

	it("marks a raw terminal ledger fact without its durable outbox uncertain after restart", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		appendRecord(join(f.parentArtifacts, "rlm-operation-ledger.jsonl"), {
			version: 1,
			type: "materialized",
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			childSessionId,
			childSessionFile: f.childFile,
			childSessionRoot: f.root,
			childArtifactDir: f.childArtifacts,
			childArtifactRoot: f.root,
			recordedAt: new Date().toISOString(),
		});
		appendRecord(join(f.parentArtifacts, "rlm-operation-ledger.jsonl"), {
			version: 1,
			type: "terminal_recorded",
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			deliveryId: delivery,
			terminal: "done",
			recordedAt: new Date().toISOString(),
		});
		const restarted = openRlmDurableOperationStore(f.parentArtifacts, { trustedChildRecoveryRoots: trustedRoots(f) });
		const rebuilt = restarted.rebuild();
		const key = JSON.stringify([parentId, assignment, operation]);
		const deliveryKey = JSON.stringify([key, delivery]);
		expect(rebuilt.operations.get(key)?.uncertain).toBe(true);
		expect(rebuilt.deliveries.get(deliveryKey)?.outboxed).toBe(false);
		expect(rebuilt.deliveries.get(deliveryKey)?.uncertain).toBe(true);
		expect(() => restarted.importOutbox(outbox(f))).toThrow(/exact materialized/);
	});

	it("fails closed on raw deleted-then-terminal ledger ordering", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		appendRecord(join(f.parentArtifacts, "rlm-operation-ledger.jsonl"), {
			version: 1,
			type: "materialized",
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			childSessionId,
			childSessionFile: f.childFile,
			childSessionRoot: f.root,
			childArtifactDir: f.childArtifacts,
			childArtifactRoot: f.root,
			recordedAt: new Date().toISOString(),
		});
		for (const type of ["deleted", "terminal_recorded"] as const) {
			appendRecord(join(f.parentArtifacts, "rlm-operation-ledger.jsonl"), {
				version: 1,
				type,
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				...(type === "terminal_recorded" ? { deliveryId: delivery, terminal: "done" } : {}),
				recordedAt: new Date().toISOString(),
			});
		}
		const rebuilt = readRlmDurableOperationRegistry(f.parentArtifacts, trustedRoots(f));
		const key = JSON.stringify([parentId, assignment, operation]);
		const rawDelivery = rebuilt.deliveries.get(JSON.stringify([key, delivery]));
		expect(rebuilt.operations.get(key)?.uncertain).toBe(true);
		expect(rebuilt.hasUncertainRecords).toBe(true);
		expect(rawDelivery?.outboxed).toBe(false);
		expect(rawDelivery?.uncertain).toBe(true);
	});

	it("cryptographically binds inbox immutable facts and body to the durable outbox", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		materialize(store, f);
		store.appendOutbox(outbox(f));
		store.recordTerminal({
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			deliveryId: delivery,
			terminal: "done",
		});
		const { recordedAt: _recordedAt, ...fact } = outboxRecord(outbox(f)) as Record<string, unknown>;
		appendRecord(join(f.parentArtifacts, "rlm-terminal-inbox.jsonl"), {
			...fact,
			type: "received",
			parentSessionFile: f.childFile,
			receivedAt: new Date().toISOString(),
		});
		const rebuilt = readRlmDurableOperationRegistry(f.parentArtifacts, trustedRoots(f));
		const key = JSON.stringify([JSON.stringify([parentId, assignment, operation]), delivery]);
		expect(rebuilt.deliveries.get(key)?.uncertain).toBe(true);
		expect(rebuilt.deliveries.get(key)?.received).toBe(false);
	});

	it("rejects unknown record/message fields and forged consumed ids during reduction", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts);
		store.admit(f.admission);
		appendRecord(join(f.parentArtifacts, "rlm-operation-ledger.jsonl"), {
			...f.admission,
			version: 1,
			type: "admitted",
			recordedAt: new Date().toISOString(),
			surprise: "provider body",
		});
		expect(readRlmDurableOperationRegistry(f.parentArtifacts).hasUncertainRecords).toBe(true);
		const unsafe = { ...message(), customType: "agent_message", details: { stack: "secret" } };
		expect(() => store.appendOutbox({ ...outbox(f), message: unsafe as never })).toThrow(/approved/);
	});

	it("enforces terminal-before-release and rejects terminal resurrection after an exact deletion", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts) as ReturnType<
			typeof openRlmDurableOperationStore
		> & {
			recordRelease: (
				input: { parentSessionId: string; assignmentId: string; operationId: string },
				type: "released" | "deleted",
			) => boolean;
		};
		store.admit(f.admission);
		expect(
			store.recordRelease(
				{ parentSessionId: parentId, assignmentId: assignment, operationId: operation },
				"deleted",
			),
		).toBe(false);
		materialize(store, f);
		store.appendOutbox(outbox(f));
		expect(
			store.recordTerminal({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				terminal: "done",
			}),
		).toBe(true);
		expect(
			store.recordRelease(
				{ parentSessionId: parentId, assignmentId: assignment, operationId: operation },
				"deleted",
			),
		).toBe(true);
		expect(
			store.recordTerminal({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				terminal: "done",
			}),
		).toBe(false);
	});

	it("does not advance terminal/import authority across outbox or inbox fsync cuts", () => {
		const f = fixture();
		let cutNow = false;
		const cut = {
			...fs,
			fsyncSync: (fd: number) => {
				if (cutNow) throw new Error("outbox fsync cut");
				return fs.fsyncSync(fd);
			},
		} as unknown as RlmDurableIo;
		const store = openRlmDurableOperationStore(f.parentArtifacts, { io: cut });
		store.admit(f.admission);
		materialize(store, f);
		cutNow = true;
		expect(() => store.appendOutbox(outbox(f))).toThrow(/fsync cut/);
		// The append was never reported as durable; callers must not advance to
		// the terminal/inbox steps on an I/O cut.
		expect(readFileSync(join(f.parentArtifacts, "rlm-operation-ledger.jsonl"), "utf8")).not.toContain(
			"terminal_recorded",
		);
	});

	it("retains inbox and consumed facts across independent fsync cuts, then retries one delivery", () => {
		const f = fixture();
		const fdPaths = new Map<number, string>();
		let failInbox = false;
		let failConsumed = false;
		const io = {
			...fs,
			openSync: ((path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
				const fd = fs.openSync(path, flags, mode);
				fdPaths.set(fd, String(path));
				return fd;
			}) as typeof fs.openSync,
			closeSync: ((fd: number) => {
				fdPaths.delete(fd);
				return fs.closeSync(fd);
			}) as typeof fs.closeSync,
			fsyncSync: ((fd: number) => {
				const path = fdPaths.get(fd) ?? "";
				if (failInbox && path.endsWith("rlm-terminal-inbox.jsonl")) throw new Error("inbox fsync cut");
				if (failConsumed && path.endsWith("rlm-terminal-consumed.jsonl")) throw new Error("consumed fsync cut");
				return fs.fsyncSync(fd);
			}) as typeof fs.fsyncSync,
		} as unknown as RlmDurableIo;
		const store = openRlmDurableOperationStore(f.parentArtifacts, { io, trustedChildRecoveryRoots: trustedRoots(f) });
		store.admit(f.admission);
		materialize(store, f);
		store.appendOutbox(outbox(f));
		store.recordTerminal({
			parentSessionId: parentId,
			assignmentId: assignment,
			operationId: operation,
			deliveryId: delivery,
			terminal: "done",
		});

		failInbox = true;
		expect(() => store.importOutbox(outbox(f))).toThrow("inbox fsync cut");
		// The receiver cannot advance to consumed after the failed acknowledgement.
		expect(
			openRlmDurableOperationStore(f.parentArtifacts, { trustedChildRecoveryRoots: trustedRoots(f) }).pendingInbox(),
		).toHaveLength(1);
		failInbox = false;
		const afterInboxRestart = openRlmDurableOperationStore(f.parentArtifacts, {
			io,
			trustedChildRecoveryRoots: trustedRoots(f),
		});
		expect(afterInboxRestart.importOutbox(outbox(f))).toBe("already_received");
		expect(afterInboxRestart.pendingInbox()).toHaveLength(1);

		// Model the real transcript's deterministic id. A consumed fsync cut leaves
		// this transcript fact and the durable inbox visible to the next importer.
		const transcriptIds = new Set<string>();
		transcriptIds.add(materializedTerminalMessageId(delivery));
		failConsumed = true;
		expect(() =>
			afterInboxRestart.markMaterializedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				sessionMessageId: materializedTerminalMessageId(delivery),
			}),
		).toThrow("consumed fsync cut");
		const afterConsumedRestart = openRlmDurableOperationStore(f.parentArtifacts, {
			trustedChildRecoveryRoots: trustedRoots(f),
		});
		expect(afterConsumedRestart.pendingInbox()).toHaveLength(0);
		expect(transcriptIds).toEqual(new Set([materializedTerminalMessageId(delivery)]));
		failConsumed = false;
		expect(
			afterConsumedRestart.markMaterializedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				sessionMessageId: materializedTerminalMessageId(delivery),
			}),
		).toBe("already_materialized");
	});
	it("retains a live exact delete intent until terminal, then deletes and discards without materialization", () => {
		const f = fixture();
		const store = openRlmDurableOperationStore(f.parentArtifacts, { trustedChildRecoveryRoots: trustedRoots(f) });
		store.admit(f.admission);
		materialize(store, f);
		expect(
			store.recordDeleteIntent({ parentSessionId: parentId, assignmentId: assignment, operationId: operation }),
		).toBe(true);
		expect(
			store.recordRelease(
				{ parentSessionId: parentId, assignmentId: assignment, operationId: operation },
				"deleted",
			),
		).toBe(false);
		store.appendOutbox(outbox(f, "cancelled"));
		expect(
			store.recordTerminal({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				terminal: "cancelled",
			}),
		).toBe(true);
		expect(
			store.recordRelease(
				{ parentSessionId: parentId, assignmentId: assignment, operationId: operation },
				"deleted",
			),
		).toBe(true);
		expect(store.importPendingOutboxes()).toBe(1);
		expect(store.pendingInbox()).toHaveLength(1);
		expect(
			store.markDiscardedDelivery({
				parentSessionId: parentId,
				assignmentId: assignment,
				operationId: operation,
				deliveryId: delivery,
				reason: "deleted",
			}),
		).toBe("new");
		const registry = store.rebuild();
		expect(registry.operations.get(JSON.stringify([parentId, assignment, operation]))).toMatchObject({
			lifecycle: "deleted",
			deleteIntent: true,
		});
		expect(
			registry.deliveries.get(JSON.stringify([JSON.stringify([parentId, assignment, operation]), delivery])),
		).toMatchObject({
			consumed: "discarded",
		});
	});
});
