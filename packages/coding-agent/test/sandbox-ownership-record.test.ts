import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	createPreAdmitOwnershipRecord,
	decideNonDeletedOwnershipTransition,
	decodeOwnershipRecord,
	type OwnershipIntent,
	type OwnershipRecord,
	type OwnershipSequence,
	type OwnershipStage,
	validateOwnershipChain,
} from "../src/modes/daemon/sandbox-ownership-record.js";

const intent: OwnershipIntent = Object.freeze({
	lifecycleKey: "life-0123456789abcdef",
	parentSessionId: "parent-0123456789abcdef",
	childSessionId: "child-0123456789abcdef",
});
const t0 = "2026-09-04T01:02:03.004Z";

function expectFrozenTree(value: unknown): void {
	expect(Object.isFrozen(value)).toBe(true);
	if (typeof value !== "object" || value === null || value instanceof Uint8Array) return;
	for (const nested of Object.values(value)) {
		if (typeof nested === "object" && nested !== null) expectFrozenTree(nested);
	}
}

function expectFailure(result: unknown, code: string): void {
	expect(result).toEqual({ ok: false, code });
	expect(Object.isFrozen(result)).toBe(true);
	if (typeof result === "object" && result !== null) expect(Object.keys(result)).toEqual(["ok", "code"]);
}

function takeBytes(result: ReturnType<typeof createPreAdmitOwnershipRecord>): Uint8Array {
	if (!result.ok) throw new Error("test setup failed");
	const bytes = result.value.payload.take();
	if (bytes === undefined) throw new Error("payload already consumed");
	return bytes;
}

function createdRecord(result: ReturnType<typeof createPreAdmitOwnershipRecord>): OwnershipRecord {
	if (!result.ok) throw new Error("test setup failed");
	return result.value.record;
}

function buildFixtureRecord(
	sequence: OwnershipSequence,
	stage: OwnershipStage,
	previousDigest: string | null,
	recordedAt: string,
): OwnershipRecord {
	const prefix = `{"version":1,"sequence":${sequence},"stage":${JSON.stringify(stage)},"lifecycleKey":${JSON.stringify(intent.lifecycleKey)},"parentSessionId":${JSON.stringify(intent.parentSessionId)},"childSessionId":${JSON.stringify(intent.childSessionId)},"recordedAt":${JSON.stringify(recordedAt)},"previousDigest":${previousDigest === null ? "null" : JSON.stringify(previousDigest)}`;
	const digest = createHash("sha256").update(new TextEncoder().encode(prefix)).digest("hex");
	return Object.freeze({
		version: 1,
		sequence,
		stage,
		lifecycleKey: intent.lifecycleKey,
		parentSessionId: intent.parentSessionId,
		childSessionId: intent.childSessionId,
		recordedAt,
		previousDigest,
		contentDigest: digest,
	});
}

function chainOf(records: readonly OwnershipRecord[]) {
	const result = validateOwnershipChain(records);
	if (!result.ok) throw new Error("test chain invalid");
	return result.value;
}

function advance(
	records: OwnershipRecord[],
	target: "creating" | "active" | "delete_intent" | "deleting",
	timestamp: string,
): void {
	const result = decideNonDeletedOwnershipTransition(chainOf(records), target, intent, timestamp);
	if (!result.ok || result.idempotent) throw new Error("test transition failed");
	records.push(result.value.record);
	expect(result.value.payload.discard()).toBe(true);
}

describe("ownership canonical record", () => {
	it("creates one frozen pre-admission record and one owned payload", () => {
		const result = createPreAdmitOwnershipRecord(intent, t0);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expectFrozenTree(result);
		expect(result.value.record.sequence).toBe(1);
		expect(result.value.record.stage).toBe("pre_admit");
		expect(result.value.record.previousDigest).toBeNull();
		expect(result.value.record.contentDigest).toMatch(/^[0-9a-f]{64}$/);
		const first = result.value.payload.take();
		expect(first).toBeInstanceOf(Uint8Array);
		expect(result.value.payload.take()).toBeUndefined();
		expect(result.value.payload.discard()).toBe(true);
	});

	it("matches the independently calculated canonical vector", () => {
		const result = createPreAdmitOwnershipRecord(intent, t0);
		if (!result.ok) throw new Error("test setup failed");
		const bytes = result.value.payload.take();
		if (bytes === undefined) throw new Error("payload unavailable");
		expect(new TextDecoder().decode(bytes)).toBe(
			`{"version":1,"sequence":1,"stage":"pre_admit","lifecycleKey":"life-0123456789abcdef","parentSessionId":"parent-0123456789abcdef","childSessionId":"child-0123456789abcdef","recordedAt":"2026-09-04T01:02:03.004Z","previousDigest":null,"contentDigest":"7655040da904f69ebd2e7e30dd83100102320f7540473985e982017517b514bf"}`,
		);
		bytes.fill(0);
	});

	it("discards an untaken payload by erasing its private bytes", () => {
		const result = createPreAdmitOwnershipRecord(intent, t0);
		if (!result.ok) throw new Error("test setup failed");
		expect(result.value.payload.discard()).toBe(true);
		expect(result.value.payload.take()).toBeUndefined();
	});

	for (const badIntent of [
		{ ...intent, lifecycleKey: "" },
		{ ...intent, lifecycleKey: "bad\nkey" },
		{ ...intent, lifecycleKey: "bad\u007fkey" },
		{ ...intent, lifecycleKey: "\ud800" },
		{ ...intent, lifecycleKey: "é".repeat(129) },
	]) {
		it("rejects an invalid intent", () => {
			expectFailure(createPreAdmitOwnershipRecord(badIntent, t0), "INPUT_INVALID");
		});
	}

	for (const timestamp of [
		"2026-09-04T01:02:03Z",
		"2025-02-29T01:02:03.004Z",
		"2026-13-04T01:02:03.004Z",
		"not-a-time",
	]) {
		it(`rejects invalid timestamp ${timestamp}`, () => {
			expectFailure(createPreAdmitOwnershipRecord(intent, timestamp), "INPUT_INVALID");
		});
	}
});

describe("ownership record decoder", () => {
	it("decodes exact canonical bytes and erases the caller buffer", () => {
		const created = createPreAdmitOwnershipRecord(intent, t0);
		const bytes = takeBytes(created);
		const expected = createdRecord(created);
		const result = decodeOwnershipRecord(bytes);
		expect(result).toEqual({ ok: true, value: expected });
		expect(bytes.every((value) => value === 0)).toBe(true);
		expectFrozenTree(result);
	});

	for (const mutate of [
		(text: string) => ` ${text}`,
		(text: string) => text.replace('{"version":1', '{"sequence":1,"version":1').replace(',"sequence":1', ""),
		(text: string) => text.replace('{"version":1', '{"version":1,"version":1'),
		(text: string) => text.replace('"pre_admit"', '"pre_admit\\u0022"'),
		(text: string) => text.slice(0, -1),
		(text: string) => text.replace(/.$/, "x"),
	]) {
		it("rejects noncanonical or corrupt JSON and erases input", () => {
			const bytes = takeBytes(createPreAdmitOwnershipRecord(intent, t0));
			const mutated = new TextEncoder().encode(mutate(new TextDecoder().decode(bytes)));
			bytes.fill(0);
			expectFailure(decodeOwnershipRecord(mutated), "CORRUPT");
			expect(mutated.every((value) => value === 0)).toBe(true);
		});
	}

	it("rejects malformed UTF-8 and erases it", () => {
		const bytes = new Uint8Array([0xc3, 0x28]);
		expectFailure(decodeOwnershipRecord(bytes), "CORRUPT");
		expect(bytes).toEqual(new Uint8Array([0, 0]));
	});

	it("rejects empty and oversized input", () => {
		const empty = new Uint8Array(0);
		expectFailure(decodeOwnershipRecord(empty), "CORRUPT");
		const large = new Uint8Array(4097).fill(1);
		expectFailure(decodeOwnershipRecord(large), "CORRUPT");
		expect(large.every((value) => value === 0)).toBe(true);
	});
});

describe("ownership chain validation and transition", () => {
	it("validates a complete non-deleted chain and freezes copies", () => {
		const records = [createdRecord(createPreAdmitOwnershipRecord(intent, t0))];
		advance(records, "creating", "2026-09-04T01:02:04.004Z");
		advance(records, "active", "2026-09-04T01:02:05.004Z");
		advance(records, "delete_intent", "2026-09-04T01:02:06.004Z");
		advance(records, "deleting", "2026-09-04T01:02:07.004Z");
		const result = validateOwnershipChain(records);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.current.stage).toBe("deleting");
			expectFrozenTree(result);
			expect(result.value.records[0]).not.toBe(records[0]);
		}
	});

	it("accepts all three authorized deleted shortcut shapes during recovery", () => {
		const pre = createdRecord(createPreAdmitOwnershipRecord(intent, t0));
		const directDeleted = buildFixtureRecord(2, "deleted", pre.contentDigest, "2026-09-04T01:02:04.004Z");
		expect(validateOwnershipChain([pre, directDeleted]).ok).toBe(true);

		const records = [pre];
		advance(records, "creating", "2026-09-04T01:02:04.004Z");
		advance(records, "delete_intent", "2026-09-04T01:02:05.004Z");
		const fromIntent = buildFixtureRecord(4, "deleted", records[2].contentDigest, "2026-09-04T01:02:06.004Z");
		expect(validateOwnershipChain([...records, fromIntent]).ok).toBe(true);
		advance(records, "deleting", "2026-09-04T01:02:06.004Z");
		const fromDeleting = buildFixtureRecord(5, "deleted", records[3].contentDigest, "2026-09-04T01:02:07.004Z");
		expect(validateOwnershipChain([...records, fromDeleting]).ok).toBe(true);
	});

	it("rejects gaps, inconsistent intent, broken digest, edge, link, and time", () => {
		const pre = createdRecord(createPreAdmitOwnershipRecord(intent, t0));
		const creating = buildFixtureRecord(2, "creating", pre.contentDigest, "2026-09-04T01:02:04.004Z");
		const active = buildFixtureRecord(3, "active", creating.contentDigest, "2026-09-04T01:02:05.004Z");
		expectFailure(validateOwnershipChain([pre, active]), "CORRUPT");
		expectFailure(validateOwnershipChain([pre, Object.freeze({ ...creating, lifecycleKey: "other" })]), "CORRUPT");
		expectFailure(
			validateOwnershipChain([pre, Object.freeze({ ...creating, contentDigest: "0".repeat(64) })]),
			"CORRUPT",
		);
		expectFailure(
			validateOwnershipChain([pre, buildFixtureRecord(2, "active", pre.contentDigest, "2026-09-04T01:02:04.004Z")]),
			"CORRUPT",
		);
		expectFailure(
			validateOwnershipChain([pre, buildFixtureRecord(2, "creating", "0".repeat(64), "2026-09-04T01:02:04.004Z")]),
			"CORRUPT",
		);
		expectFailure(
			validateOwnershipChain([
				pre,
				buildFixtureRecord(2, "creating", pre.contentDigest, "2026-09-04T01:02:02.004Z"),
			]),
			"CORRUPT",
		);
	});

	it("rejects mutable or accessor-bearing caller records without invoking getters", () => {
		const pre = createdRecord(createPreAdmitOwnershipRecord(intent, t0));
		const mutable = { ...pre };
		expectFailure(validateOwnershipChain([mutable]), "CORRUPT");
		let invoked = false;
		const hostile = Object.create(Object.prototype);
		Object.defineProperty(hostile, "version", {
			enumerable: true,
			get: () => {
				invoked = true;
				throw new Error("secret");
			},
		});
		expectFailure(Reflect.apply(validateOwnershipChain, undefined, [[hostile]]), "CORRUPT");
		expect(invoked).toBe(false);
	});

	it("accepts idempotence only for an exact existing stage and returns current", () => {
		const records = [createdRecord(createPreAdmitOwnershipRecord(intent, t0))];
		advance(records, "creating", "2026-09-04T01:02:04.004Z");
		advance(records, "delete_intent", "2026-09-04T01:02:05.004Z");
		const result = decideNonDeletedOwnershipTransition(
			chainOf(records),
			"creating",
			intent,
			"2026-09-04T01:02:06.004Z",
		);
		expect(result).toEqual({ ok: true, idempotent: true, value: records[2] });
		expectFrozenTree(result);
		expectFailure(
			decideNonDeletedOwnershipTransition(chainOf(records), "active", intent, "2026-09-04T01:02:06.004Z"),
			"INVALID_TRANSITION",
		);
	});

	it("rejects structurally forged validated chains", () => {
		const pre = createdRecord(createPreAdmitOwnershipRecord(intent, t0));
		const forged = { records: [pre], current: pre, intent };
		expectFailure(
			Reflect.apply(decideNonDeletedOwnershipTransition, undefined, [forged, "creating", intent, t0]),
			"CORRUPT",
		);
	});

	it("does not expose a production deleted-record creator", () => {
		const chain = chainOf([createdRecord(createPreAdmitOwnershipRecord(intent, t0))]);
		expectFailure(
			Reflect.apply(decideNonDeletedOwnershipTransition, undefined, [chain, "deleted", intent, t0]),
			"INPUT_INVALID",
		);
	});

	it("rejects conflicting intent and regressing time", () => {
		const records = [createdRecord(createPreAdmitOwnershipRecord(intent, t0))];
		const chain = chainOf(records);
		expectFailure(
			decideNonDeletedOwnershipTransition(chain, "creating", { ...intent, childSessionId: "other" }, t0),
			"CONFLICT",
		);
		expectFailure(
			decideNonDeletedOwnershipTransition(chain, "creating", intent, "2026-09-04T01:02:02.004Z"),
			"INPUT_INVALID",
		);
	});
});
