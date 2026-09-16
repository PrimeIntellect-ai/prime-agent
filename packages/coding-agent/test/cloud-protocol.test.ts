import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	advanceCursor,
	CLOUD_MAX_MESSAGE_BYTES,
	CLOUD_PROTOCOL_VERSION,
	type CloudCommandReceipt,
	type CloudCommandRequest,
	type CloudHello,
	type CloudMessage,
	type CloudSnapshot,
	type CloudSubmit,
	canonicalJson,
	cloudCursor,
	cloudIdProblem,
	cloudRequestDigest,
	cloudRequestProblem,
	cursorAtOrBefore,
	isCloudDigest,
	newCloudClientId,
	newCloudCommandId,
	newCloudSessionId,
	newCloudTaskId,
	parseCloudMessage,
	serializeCloudMessage,
} from "../src/core/cloud/protocol.js";

const startTaskRequest: CloudCommandRequest = { kind: "start_task", taskId: "task-1", prompt: "hello cloud" };
const steerRequest: CloudCommandRequest = { kind: "steer", taskId: "task-1", text: "and then verify" };
const cancelTaskRequest: CloudCommandRequest = { kind: "cancel_task", taskId: "task-1" };

function receipt(overrides: Partial<CloudCommandReceipt> = {}): CloudCommandReceipt {
	return {
		commandId: "cmd-1",
		digest: cloudRequestDigest(startTaskRequest),
		state: "accepted",
		submittedAt: "2026-09-16T00:00:00.000Z",
		updatedAt: "2026-09-16T00:00:00.000Z",
		uncertain: false,
		...overrides,
	};
}

function validHello(): CloudHello {
	return {
		type: "hello",
		protocolVersion: CLOUD_PROTOCOL_VERSION,
		generation: 2,
		clientId: "client-a",
		sessionId: "sess-1",
	};
}

function validSnapshot(): CloudSnapshot {
	return {
		type: "snapshot",
		sessionId: "sess-1",
		generation: 2,
		cursor: { generation: 2, sequence: 2 },
		status: "idle",
		state: { cwd: "/tmp", modelId: "openai/gpt-5.5", queuedCommandIds: ["cmd-1"] },
		events: [
			{
				sequence: 1,
				kind: "command_accepted",
				recordedAt: "2026-09-16T00:00:00.000Z",
				receipt: receipt(),
			},
			{
				sequence: 2,
				kind: "session_status",
				recordedAt: "2026-09-16T00:00:00.000Z",
				status: "idle",
			},
		],
	};
}

function roundTrip(message: CloudMessage): CloudMessage {
	const serialized = serializeCloudMessage(message);
	const parsed = parseCloudMessage(serialized);
	if (!parsed.ok) {
		throw new Error(`round-trip parse failed: ${parsed.error}`);
	}
	return parsed.message;
}

function problemOf(value: unknown): string {
	const parsed = parseCloudMessage(value);
	if (!parsed.ok) {
		return parsed.error;
	}
	throw new Error("expected a validation problem");
}

describe("canonicalJson", () => {
	it("sorts object keys at every depth regardless of insertion order", () => {
		const first = { b: 1, a: { d: 2, c: 3 } };
		const second = { a: { c: 3, d: 2 }, b: 1 };
		expect(canonicalJson(first)).toEqual(canonicalJson(second));
		expect(canonicalJson(first)).toEqual('{"a":{"c":3,"d":2},"b":1}');
	});

	it("preserves array order and escapes strings exactly like JSON", () => {
		expect(canonicalJson(["b", "a"])).toEqual('["b","a"]');
		expect(canonicalJson({ text: 'a"b\n' })).toEqual(JSON.stringify({ text: 'a"b\n' }));
	});

	it("treats -0 as 0", () => {
		expect(canonicalJson({ a: -0 })).toEqual('{"a":0}');
	});

	it("rejects values outside JSON", () => {
		expect(() => canonicalJson({ x: undefined })).toThrow();
		expect(() => canonicalJson({ x: () => 1 })).toThrow();
		expect(() => canonicalJson({ x: Symbol("s") })).toThrow();
		expect(() => canonicalJson({ x: 1n })).toThrow();
		expect(() => canonicalJson({ x: Number.NaN })).toThrow();
		expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow();
		expect(() => canonicalJson(new Date())).toThrow();
	});

	it("rejects values nested beyond the depth bound", () => {
		let deep: unknown = { value: 1 };
		for (let index = 0; index < 70; index++) {
			deep = { value: deep };
		}
		expect(() => canonicalJson(deep)).toThrow();
	});
});

describe("cloudRequestDigest", () => {
	it("is stable across key order", () => {
		expect(cloudRequestDigest({ kind: "start_task", taskId: "task-1", prompt: "hi" })).toEqual(
			cloudRequestDigest({ prompt: "hi", taskId: "task-1", kind: "start_task" }),
		);
	});

	it("changes with the request", () => {
		expect(cloudRequestDigest(startTaskRequest)).not.toEqual(
			cloudRequestDigest({ kind: "start_task", taskId: "task-1", prompt: "hi there" }),
		);
		expect(cloudRequestDigest(startTaskRequest)).not.toEqual(cloudRequestDigest(steerRequest));
		expect(cloudRequestDigest(startTaskRequest)).not.toEqual(cloudRequestDigest(cancelTaskRequest));
	});

	it("uses a domain-separated sha256 format", () => {
		const digest = cloudRequestDigest(startTaskRequest);
		expect(isCloudDigest(digest)).toBe(true);
		expect(digest).not.toEqual(
			`sha256:${createHash("sha256").update(canonicalJson(startTaskRequest)).digest("hex")}`,
		);
		expect(isCloudDigest("sha256:zz")).toBe(false);
		expect(isCloudDigest("md5:0000")).toBe(false);
	});
});

describe("stable ids and cursors", () => {
	it("generates unique prefixed ids", () => {
		expect(newCloudClientId()).toMatch(/^client_[0-9a-f-]{36}$/);
		expect(newCloudCommandId()).toMatch(/^cmd_[0-9a-f-]{36}$/);
		expect(newCloudSessionId()).toMatch(/^sess_[0-9a-f-]{36}$/);
		expect(newCloudTaskId()).toMatch(/^task_[0-9a-f-]{36}$/);
		expect(newCloudClientId()).not.toEqual(newCloudClientId());
		expect(newCloudTaskId()).not.toEqual(newCloudTaskId());
	});

	it("validates cursor construction", () => {
		expect(cloudCursor(1, 0)).toEqual({ generation: 1, sequence: 0 });
		expect(() => cloudCursor(0, 0)).toThrow();
		expect(() => cloudCursor(1, -1)).toThrow();
		expect(() => cloudCursor(1.5, 0)).toThrow();
		expect(advanceCursor({ generation: 1, sequence: 4 })).toEqual({ generation: 1, sequence: 5 });
	});

	it("compares cursors only inside one generation", () => {
		expect(cursorAtOrBefore({ generation: 1, sequence: 3 }, { generation: 1, sequence: 4 })).toBe(true);
		expect(cursorAtOrBefore({ generation: 1, sequence: 4 }, { generation: 1, sequence: 4 })).toBe(true);
		expect(cursorAtOrBefore({ generation: 1, sequence: 5 }, { generation: 1, sequence: 4 })).toBe(false);
		expect(() => cursorAtOrBefore({ generation: 1, sequence: 1 }, { generation: 2, sequence: 1 })).toThrow();
	});
});

describe("parseCloudMessage and serializeCloudMessage", () => {
	it("round-trips every message kind", () => {
		const messages: CloudMessage[] = [
			validHello(),
			{ ...validHello(), cursor: { generation: 2, sequence: 2 } },
			validSnapshot(),
			{ type: "subscribe", sessionId: "sess-1", cursor: { generation: 2, sequence: 1 } },
			{
				type: "submit",
				sessionId: "sess-1",
				generation: 2,
				commandId: "cmd-1",
				request: startTaskRequest,
				digest: cloudRequestDigest(startTaskRequest),
			},
			{ type: "get_command", sessionId: "sess-1", generation: 2, commandId: "cmd-1" },
			{ type: "get_command", sessionId: "sess-1", generation: 2, claim: true },
			{
				type: "command",
				sessionId: "sess-1",
				generation: 2,
				receipt: receipt(),
				request: canonicalJson(startTaskRequest),
			},
			{
				type: "command",
				sessionId: "sess-1",
				generation: 2,
				receipt: receipt({ state: "failed", error: "boom", uncertain: true }),
			},
			{ type: "ack", sessionId: "sess-1", cursor: { generation: 2, sequence: 4 } },
		];
		for (const message of messages) {
			expect(roundTrip(message)).toEqual(message);
		}
	});

	it("parses validated objects as well as wire strings", () => {
		expect(parseCloudMessage(validHello())).toEqual({ ok: true, message: validHello() });
	});

	it("serializes to canonical bytes independent of key order", () => {
		const first: CloudSubmit = {
			type: "submit",
			sessionId: "sess-1",
			generation: 2,
			commandId: "cmd-1",
			request: startTaskRequest,
			digest: cloudRequestDigest(startTaskRequest),
		};
		const second = {
			digest: cloudRequestDigest(startTaskRequest),
			request: { prompt: "hello cloud", taskId: "task-1", kind: "start_task" },
			commandId: "cmd-1",
			generation: 2,
			sessionId: "sess-1",
			type: "submit",
		} as unknown as CloudSubmit;
		expect(serializeCloudMessage(second)).toEqual(serializeCloudMessage(first));
	});

	it("rejects unparseable and oversized wire strings", () => {
		expect(parseCloudMessage("{oops").ok).toBe(false);
		expect(parseCloudMessage("x".repeat(CLOUD_MAX_MESSAGE_BYTES + 1)).ok).toBe(false);
	});

	it("rejects non-object and unknown-type frames", () => {
		expect(parseCloudMessage(42).ok).toBe(false);
		expect(parseCloudMessage(null).ok).toBe(false);
		expect(parseCloudMessage([]).ok).toBe(false);
		expect(parseCloudMessage({ protocolVersion: 1 }).ok).toBe(false);
		expect(parseCloudMessage({ type: "goodbye" }).ok).toBe(false);
	});

	it("validates hello frames", () => {
		expect(problemOf({ ...validHello(), protocolVersion: 2 })).toContain("must equal 1");
		expect(problemOf({ ...validHello(), clientId: "" })).toContain("hello.clientId");
		expect(problemOf({ ...validHello(), extra: true })).toContain("unexpected field");
		expect(parseCloudMessage({ ...validHello(), capabilities: ["time_travel"] }).ok).toBe(false);
		expect(problemOf({ ...validHello(), cursor: { generation: 3, sequence: 0 } })).toContain(
			"hello.cursor.generation must match hello.generation",
		);
		expect(parseCloudMessage({ ...validHello(), cursor: { generation: 0, sequence: 0 } }).ok).toBe(false);
		const withoutSession = { ...validHello() } as Partial<CloudHello>;
		delete withoutSession.sessionId;
		expect(problemOf(withoutSession)).toContain("hello.sessionId");
		const withoutGeneration = { ...validHello() } as Partial<CloudHello>;
		delete withoutGeneration.generation;
		expect(problemOf(withoutGeneration)).toContain("hello.generation");
		expect(parseCloudMessage({ ...validHello(), generation: 0 }).ok).toBe(false);
	});

	it("validates submit request kinds and bounds", () => {
		const base = { type: "submit", sessionId: "sess-1", generation: 2, commandId: "cmd-1" };
		const longText = "x".repeat(70_000);
		expect(
			parseCloudMessage({ ...base, request: { kind: "start_task", taskId: "task-1", prompt: longText } }).ok,
		).toBe(false);
		expect(parseCloudMessage({ ...base, request: { kind: "steer", taskId: "task-1", text: longText } }).ok).toBe(
			false,
		);
		expect(
			parseCloudMessage({ ...base, request: { kind: "start_task", taskId: "t".repeat(200), prompt: "hi" } }).ok,
		).toBe(false);
		expect(parseCloudMessage({ ...base, request: { kind: "prompt", text: "hi" } }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, request: { kind: "start_task", taskId: "task-1" }, extra: 1 }).ok).toBe(
			false,
		);
		expect(problemOf({ ...base, request: { kind: "steer", taskId: "task-1" } })).toContain("request.text");
		expect(problemOf({ ...base, request: { kind: "cancel_task" } })).toContain("request.taskId");
		expect(parseCloudMessage({ ...base, commandId: "x".repeat(200), request: startTaskRequest }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, generation: 0, request: startTaskRequest }).ok).toBe(false);
	});

	it("requires a submit digest that matches the canonical digest of the request", () => {
		const base = { type: "submit", sessionId: "sess-1", generation: 2, commandId: "cmd-1" };
		expect(problemOf({ ...base, request: startTaskRequest })).toContain("submit.digest");
		expect(parseCloudMessage({ ...base, request: startTaskRequest, digest: "nope" }).ok).toBe(false);
		expect(problemOf({ ...base, request: startTaskRequest, digest: cloudRequestDigest(steerRequest) })).toContain(
			"submit.digest must equal the canonical digest of submit.request",
		);
		expect(
			parseCloudMessage({ ...base, request: startTaskRequest, digest: cloudRequestDigest(startTaskRequest) }).ok,
		).toBe(true);
	});

	it("validates snapshot invariants", () => {
		const base = validSnapshot();
		expect(problemOf({ ...base, cursor: { generation: 1, sequence: 2 } })).toContain(
			"snapshot.cursor.generation must match snapshot.generation",
		);
		expect(problemOf({ ...base, cursor: { generation: 2, sequence: 1 } })).toContain(
			"snapshot.cursor.sequence must match the last event sequence",
		);
		expect(
			problemOf({ ...base, cursor: { generation: 2, sequence: 2 }, events: [...base.events].reverse() }),
		).toContain("must strictly increase");
		const tooManyQueued = Array.from({ length: 100 }, (_, index) => `cmd-${index}`);
		expect(parseCloudMessage({ ...base, state: { ...base.state, queuedCommandIds: tooManyQueued } }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, status: "sideways" }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, events: [{ ...base.events[0], sequence: 0 }] }).ok).toBe(false);
		expect(
			parseCloudMessage({
				...base,
				cursor: { generation: 2, sequence: 1 },
				events: [{ ...base.events[0], sequence: 1 }],
			}).ok,
		).toBe(true);
	});

	it("bounds snapshot tails on both parse and serialize", () => {
		const events = Array.from({ length: 300 }, (_, index) => ({
			sequence: index + 1,
			kind: "session_status" as const,
			recordedAt: "2026-09-16T00:00:00.000Z",
			status: "idle" as const,
		}));
		const snapshot = { ...validSnapshot(), events };
		expect(parseCloudMessage(snapshot).ok).toBe(false);
		expect(() => serializeCloudMessage(snapshot as unknown as CloudSnapshot)).toThrow(/invalid cloud message/);
	});

	it("validates get_command frames", () => {
		const base = { type: "get_command", sessionId: "sess-1", generation: 2 };
		expect(problemOf({ ...base, claim: true, commandId: "cmd-1" })).toContain("cannot be combined");
		expect(parseCloudMessage({ ...base, claim: "yes" }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, claim: true }).ok).toBe(true);
		const withoutGeneration = { ...base } as Partial<Record<string, unknown>>;
		delete withoutGeneration.generation;
		expect(problemOf(withoutGeneration)).toContain("get_command.generation");
	});

	it("validates command receipt frames", () => {
		const base = { type: "command", sessionId: "sess-1", generation: 2 };
		expect(parseCloudMessage({ ...base, receipt: { ...receipt(), state: "sideways" } }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, receipt: receipt({ digest: "nope" }) }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, receipt: { ...receipt(), uncertain: "maybe" } }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, receipt: receipt(), request: "{oops" }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, receipt: receipt(), request: '{"kind":"sideways"}' }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, receipt: receipt(), request: canonicalJson(startTaskRequest) }).ok).toBe(
			true,
		);
		const withoutGeneration = { ...base } as Partial<Record<string, unknown>>;
		delete withoutGeneration.generation;
		expect(problemOf(withoutGeneration)).toContain("command.generation");
	});

	it("validates client event ack frames as a cursor only", () => {
		const base = { type: "ack", sessionId: "sess-1", cursor: { generation: 2, sequence: 4 } };
		expect(parseCloudMessage(base).ok).toBe(true);
		expect(problemOf({ ...base, extra: true })).toContain("unexpected field");
		expect(problemOf({ ...base, sessionId: "" })).toContain("ack.sessionId");
		expect(problemOf({ ...base, generation: 2 })).toContain("unexpected field");
		const withoutCursor = { ...base } as Partial<Record<string, unknown>>;
		delete withoutCursor.cursor;
		expect(problemOf(withoutCursor)).toContain("ack.cursor must be an object");
		expect(problemOf({ ...base, cursor: { generation: 0, sequence: 4 } })).toContain("ack.cursor.generation");
		expect(problemOf({ ...base, cursor: { generation: 2, sequence: -1 } })).toContain("ack.cursor.sequence");
		expect(problemOf({ ...base, cursor: { generation: 2.5, sequence: 4 } })).toContain("ack.cursor.generation");
		expect(problemOf({ ...base, cursor: { generation: 2, sequence: 4, extra: 1 } })).toContain("unexpected field");
	});

	it("throws when serializing an invalid message", () => {
		expect(() =>
			serializeCloudMessage({
				type: "hello",
				protocolVersion: CLOUD_PROTOCOL_VERSION,
				generation: 1,
				sessionId: "sess-1",
			} as unknown as CloudHello),
		).toThrow(/invalid cloud message/);
	});

	it("exposes request and id runtime validation", () => {
		expect(cloudRequestProblem(startTaskRequest)).toBeUndefined();
		expect(cloudRequestProblem(steerRequest)).toBeUndefined();
		expect(cloudRequestProblem(cancelTaskRequest)).toBeUndefined();
		expect(cloudRequestProblem({ kind: "start_task" })).toContain("request.taskId");
		expect(cloudIdProblem("cmd-1")).toBeUndefined();
		expect(cloudIdProblem("")).toContain("at most");
	});
});

describe("cloud module exports", () => {
	it("re-exports the protocol and journal from the index", async () => {
		const cloud = await import("../src/core/cloud/index.js");
		expect(typeof cloud.parseCloudMessage).toBe("function");
		expect(typeof cloud.serializeCloudMessage).toBe("function");
		expect(typeof cloud.CloudCommandJournal).toBe("function");
		expect(cloud.CLOUD_PROTOCOL_VERSION).toBe(1);
	});
});
