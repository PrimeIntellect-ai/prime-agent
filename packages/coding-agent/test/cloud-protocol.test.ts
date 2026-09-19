import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CloudEvent } from "../src/core/cloud/protocol.js";
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
	cloudRequestJsonProblem,
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

const promptRequest: CloudCommandRequest = { kind: "prompt", text: "hello cloud", queueIfBusy: true };
const steerRequest: CloudCommandRequest = { kind: "steer", text: "and then verify" };
const followUpRequest: CloudCommandRequest = { kind: "follow_up", text: "one more thing" };
const openSessionRequest: CloudCommandRequest = {
	kind: "open_session",
	cwd: "/workspace",
	model: "openai/gpt-5.5",
	thinking: "high",
	prompt: "start",
};
const abortRequest: CloudCommandRequest = { kind: "abort" };
const releaseRequest: CloudCommandRequest = { kind: "release" };
const sendMessageRequest: CloudCommandRequest = {
	kind: "send_message",
	targetRemoteSessionId: "sess-2",
	message: "ping",
};
const setModelRequest: CloudCommandRequest = { kind: "set_model", provider: "openai", modelId: "gpt-5.5" };
const setThinkingRequest: CloudCommandRequest = { kind: "set_thinking_level", level: "medium" };
const setNameRequest: CloudCommandRequest = { kind: "set_session_name", name: "cloud-root" };
const compactRequest: CloudCommandRequest = { kind: "compact", customInstructions: "keep the plan" };
const cancelChildRequest: CloudCommandRequest = { kind: "cancel_child", childId: "child-1" };
const deleteChildRequest: CloudCommandRequest = { kind: "delete_child", childId: "child-1" };
const extensionUiRequest: CloudCommandRequest = {
	kind: "extension_ui_response",
	requestId: "req-1",
	response: { confirmed: true },
};
const allV2Requests: CloudCommandRequest[] = [
	openSessionRequest,
	promptRequest,
	steerRequest,
	followUpRequest,
	abortRequest,
	sendMessageRequest,
	setModelRequest,
	setThinkingRequest,
	setNameRequest,
	compactRequest,
	cancelChildRequest,
	deleteChildRequest,
	extensionUiRequest,
	releaseRequest,
];

function receipt(overrides: Partial<CloudCommandReceipt> = {}): CloudCommandReceipt {
	return {
		commandId: "cmd-1",
		digest: cloudRequestDigest(promptRequest),
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
		expect(cloudRequestDigest({ kind: "prompt", text: "hi", queueIfBusy: true })).toEqual(
			cloudRequestDigest({ queueIfBusy: true, text: "hi", kind: "prompt" }),
		);
	});

	it("changes with the request", () => {
		expect(cloudRequestDigest(promptRequest)).not.toEqual(
			cloudRequestDigest({ kind: "prompt", text: "hi there", queueIfBusy: true }),
		);
		expect(cloudRequestDigest(promptRequest)).not.toEqual(cloudRequestDigest(steerRequest));
		expect(cloudRequestDigest(steerRequest)).not.toEqual(cloudRequestDigest(followUpRequest));
		expect(cloudRequestDigest(cancelChildRequest)).not.toEqual(cloudRequestDigest(deleteChildRequest));
	});

	it("is defined for every v2 command kind and differs between them", () => {
		const digests = allV2Requests.map((request) => cloudRequestDigest(request));
		for (const digest of digests) {
			expect(isCloudDigest(digest)).toBe(true);
		}
		expect(new Set(digests).size).toBe(allV2Requests.length);
	});

	it("uses a domain-separated sha256 format", () => {
		const digest = cloudRequestDigest(promptRequest);
		expect(isCloudDigest(digest)).toBe(true);
		expect(digest).not.toEqual(`sha256:${createHash("sha256").update(canonicalJson(promptRequest)).digest("hex")}`);
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
				request: promptRequest,
				digest: cloudRequestDigest(promptRequest),
			},
			{ type: "get_command", sessionId: "sess-1", generation: 2, commandId: "cmd-1" },
			{ type: "get_command", sessionId: "sess-1", generation: 2, claim: true },
			{
				type: "command",
				sessionId: "sess-1",
				generation: 2,
				receipt: receipt(),
				request: canonicalJson(promptRequest),
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
			request: promptRequest,
			digest: cloudRequestDigest(promptRequest),
		};
		const second = {
			digest: cloudRequestDigest(promptRequest),
			request: { queueIfBusy: true, text: "hello cloud", kind: "prompt" },
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
		expect(parseCloudMessage({ protocolVersion: 2 }).ok).toBe(false);
		expect(parseCloudMessage({ type: "goodbye" }).ok).toBe(false);
	});

	it("validates hello frames and rejects older protocol versions", () => {
		expect(problemOf({ ...validHello(), protocolVersion: 2 })).toContain("must equal 3");
		expect(problemOf({ ...validHello(), protocolVersion: 4 })).toContain("must equal 3");
		expect(roundTrip(validHello()).type).toBe("hello");
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
		expect(parseCloudMessage({ ...base, request: { kind: "prompt", text: longText } }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, request: { kind: "steer", text: longText } }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, request: { kind: "follow_up", text: longText } }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, request: { kind: "open_session", cwd: "/w", prompt: longText } }).ok).toBe(
			false,
		);
		const promptRequest: CloudCommandRequest = { kind: "prompt", text: "hi" };
		expect(parseCloudMessage({ ...base, request: promptRequest, digest: cloudRequestDigest(promptRequest) }).ok).toBe(
			true,
		);
		expect(
			parseCloudMessage({ ...base, request: promptRequest, digest: cloudRequestDigest(promptRequest), extra: 1 }).ok,
		).toBe(false);
		expect(problemOf({ ...base, request: { kind: "prompt" } })).toContain("request.text");
		expect(problemOf({ ...base, request: { kind: "steer" } })).toContain("request.text");
		expect(problemOf({ ...base, request: { kind: "set_session_name", name: "" } })).toContain("request.name");
		expect(
			cloudRequestProblem({ kind: "extension_ui_response", requestId: "r", response: { a: 1 } }),
		).toBeUndefined();
		expect(
			parseCloudMessage({
				...base,
				request: {
					kind: "extension_ui_response",
					requestId: "r",
					response: { blob: "x".repeat(9_000) },
				},
			}).ok,
		).toBe(false);
		expect(parseCloudMessage({ ...base, commandId: "x".repeat(200), request: promptRequest }).ok).toBe(false);
		expect(parseCloudMessage({ ...base, generation: 0, request: promptRequest }).ok).toBe(false);
	});

	it("rejects the v1 task command surface with typed problems", () => {
		const base = { type: "submit", sessionId: "sess-1", generation: 2, commandId: "cmd-1" };
		expect(problemOf({ ...base, request: { kind: "start_task", taskId: "task-1", prompt: "hi" } })).toContain(
			"request.kind must be one of",
		);
		expect(problemOf({ ...base, request: { kind: "cancel_task", taskId: "task-1" } })).toContain(
			"request.kind must be one of",
		);
		// The v1 steer shape carried a taskId; v2 steer takes text only.
		expect(problemOf({ ...base, request: { kind: "steer", taskId: "task-1", text: "hi" } })).toContain(
			"unexpected field: taskId",
		);
		expect(cloudRequestProblem({ kind: "start_task", taskId: "t", prompt: "hi" } as unknown as object)).toContain(
			"request.kind",
		);
	});

	it("bounds request payload bytes through canonical encoding", () => {
		// Field caps keep requests far under the frame bound; the byte check is
		// defense in depth for every request the journal admits.
		const maxPrompt: CloudCommandRequest = {
			kind: "open_session",
			cwd: "/w",
			prompt: "x".repeat(65_536),
		};
		expect(cloudRequestProblem(maxPrompt)).toBeUndefined();
		expect(cloudRequestJsonProblem(maxPrompt)).toBeUndefined();
		expect(
			cloudRequestJsonProblem({
				kind: "extension_ui_response",
				requestId: "r",
				response: { x: () => 1 },
			} as unknown as CloudCommandRequest),
		).toContain("not canonical JSON");
	});

	it("requires a submit digest that matches the canonical digest of the request", () => {
		const base = { type: "submit", sessionId: "sess-1", generation: 2, commandId: "cmd-1" };
		expect(problemOf({ ...base, request: promptRequest })).toContain("submit.digest");
		expect(parseCloudMessage({ ...base, request: promptRequest, digest: "nope" }).ok).toBe(false);
		expect(problemOf({ ...base, request: promptRequest, digest: cloudRequestDigest(steerRequest) })).toContain(
			"submit.digest must equal the canonical digest of submit.request",
		);
		expect(parseCloudMessage({ ...base, request: promptRequest, digest: cloudRequestDigest(promptRequest) }).ok).toBe(
			true,
		);
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
		expect(parseCloudMessage({ ...base, receipt: receipt(), request: canonicalJson(promptRequest) }).ok).toBe(true);
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

	it("carries an optional protocol authentication token on hello", () => {
		const withToken = roundTrip({ ...validHello(), authToken: "bridge-token-0123456789abcdef" });
		expect(withToken.type).toBe("hello");
		expect(problemOf({ ...validHello(), authToken: "" })).toContain("hello.authToken");
		expect(problemOf({ ...validHello(), authToken: "t".repeat(257) })).toContain("hello.authToken");
		expect(problemOf({ ...validHello(), authToken: "tok", auth: "tok" })).toContain("unexpected field");
	});

	it("validates live events push batches", () => {
		const events: CloudMessage = {
			type: "events",
			sessionId: "sess-1",
			generation: 2,
			events: [
				{
					sequence: 3,
					kind: "output_delta",
					recordedAt: "2026-09-16T00:00:00.000Z",
					taskId: "task-1",
					stream: "stdout",
					text: "chunk\n",
				},
			],
		};
		expect(roundTrip(events).type).toBe("events");
		expect(roundTrip({ ...events, events: [] } as CloudMessage).type).toBe("events");
		expect(problemOf({ ...(events as object), generation: 0 })).toContain("events.generation");
		expect(problemOf({ ...(events as object), sessionId: "" })).toContain("events.sessionId");
		const decreasing = {
			type: "events",
			sessionId: "sess-1",
			generation: 2,
			events: [
				{
					sequence: 3,
					kind: "session_status",
					recordedAt: "2026-09-16T00:00:00.000Z",
					status: "busy",
				},
				{
					sequence: 2,
					kind: "session_status",
					recordedAt: "2026-09-16T00:00:00.000Z",
					status: "idle",
				},
			],
		};
		expect(problemOf(decreasing)).toContain("strictly increase");
	});

	it("validates output_delta event payloads inside event batches", () => {
		const delta = {
			sequence: 1,
			kind: "output_delta",
			recordedAt: "2026-09-16T00:00:00.000Z",
			taskId: "task-1",
			stream: "stdout",
			text: "chunk",
		};
		const wrap = (event: unknown): CloudMessage => {
			return { type: "events", sessionId: "sess-1", generation: 2, events: [event as CloudEvent] };
		};
		expect(problemOf(wrap({ ...delta, stream: "mixed" }))).toContain("events[0].stream");
		expect(problemOf(wrap({ ...delta, taskId: "" }))).toContain("events[0].taskId");
		expect(problemOf(wrap({ ...delta, text: "x".repeat(65_537) }))).toContain("events[0].text");
		expect(problemOf(wrap({ ...delta, extra: 1 }))).toContain("unexpected field");
	});

	it("round-trips the v2 durable and ephemeral event kinds", () => {
		const sessionEntry = {
			sequence: 1,
			kind: "session_entry",
			recordedAt: "2026-09-16T00:00:00.000Z",
			sessionId: "sess-remote-1",
			entryId: "entry-1",
			entry: {
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-09-16T00:00:00.000Z",
				message: { role: "user", content: "hello" },
			},
			artifacts: [
				{ path: "/opt/prime-agent/artifacts/blob.bin", sha256: cloudRequestDigest(promptRequest), bytes: 12 },
			],
		};
		const sessionEvent = {
			sequence: 2,
			kind: "session_event",
			recordedAt: "2026-09-16T00:00:00.000Z",
			sessionId: "sess-remote-1",
			event: { type: "message_update", message: { role: "assistant", content: "par" } },
		};
		const sessionMeta = {
			sequence: 3,
			kind: "session_meta",
			recordedAt: "2026-09-16T00:00:00.000Z",
			sessionId: "sess-remote-1",
			streaming: true,
			runningTools: 1,
			queue: 0,
			recap: "working",
			taskState: "needs_input",
			model: "openai/gpt-5.5",
			connectivityHints: ["tunnel"],
		};
		const rosterDelta = {
			sequence: 4,
			kind: "roster_delta",
			recordedAt: "2026-09-16T00:00:00.000Z",
			rows: [
				{
					childId: "child-1",
					parentRemoteId: "sess-remote-1",
					name: "worker",
					status: "running",
					depth: 1,
					preview: "crunching",
				},
				{ childId: "child-2", parentRemoteId: "child-1", status: "queued", depth: 2 },
			],
		};
		const childUpdate = {
			sequence: 5,
			kind: "child_update",
			recordedAt: "2026-09-16T00:00:00.000Z",
			childId: "child-1",
			status: "completed",
			answerPreview: "done",
			sessionFile: "/sessions/child-1.jsonl",
			model: "openai/gpt-5.5",
		};
		const usage = {
			sequence: 6,
			kind: "usage",
			recordedAt: "2026-09-16T00:00:00.000Z",
			sessionId: "sess-remote-1",
			totals: { inputTokens: 10, outputTokens: 5, cachedTokens: 2, requests: 1 },
			revision: 3,
		};
		const batch: CloudMessage = {
			type: "events",
			sessionId: "sess-1",
			generation: 2,
			events: [sessionEntry, sessionEvent, sessionMeta, rosterDelta, childUpdate, usage] as CloudEvent[],
		};
		expect(roundTrip(batch)).toEqual(batch);
	});

	it("round-trips and validates the v3 cross-boundary family events and commands", () => {
		// Guest -> local: the family roster and agent-message requests.
		const familyRequest = {
			sequence: 1,
			kind: "family_roster_request",
			recordedAt: "2026-09-18T00:00:00.000Z",
			requestId: "famreq_1",
			fromRemoteSessionId: "sess-kid-1",
		};
		const messageRequest = {
			sequence: 2,
			kind: "agent_message_request",
			recordedAt: "2026-09-18T00:00:00.000Z",
			requestId: "msgreq_1",
			fromRemoteSessionId: "sess-kid-1",
			targetSelector: "parent-session",
			message: "reply to the local parent",
		};
		const requestBatch: CloudMessage = {
			type: "events",
			sessionId: "sess-1",
			generation: 2,
			events: [familyRequest, messageRequest] as CloudEvent[],
		};
		expect(roundTrip(requestBatch)).toEqual(requestBatch);
		const wrapEvent = (event: unknown): CloudMessage => ({
			type: "events",
			sessionId: "sess-1",
			generation: 2,
			events: [event as CloudEvent],
		});
		expect(problemOf(wrapEvent({ ...familyRequest, requestId: "" }))).toContain(
			"events[0].requestId must be a string of 1-128",
		);
		expect(problemOf(wrapEvent({ ...messageRequest, targetSelector: "" }))).toContain("targetSelector");
		expect(problemOf(wrapEvent({ ...messageRequest, message: "" }))).toContain("message");
		expect(problemOf(wrapEvent({ ...familyRequest, extra: 1 }))).toContain("unexpected field");

		// Local -> guest: the journaled result commands.
		const rosterResult: CloudCommandRequest = {
			kind: "family_roster_result",
			requestId: "famreq_1",
			entries: [
				{
					id: "sess-kid-1",
					name: "kid-1",
					depth: 1,
					status: "running",
					parentSessionId: "parent-session",
					parentSessionPath: "/sessions/parent.jsonl",
					sessionPath: "/sessions/sess-kid-1.jsonl",
				},
				{ id: "parent-session", depth: 0, status: "running", sessionPath: "/sessions/parent.jsonl" },
			],
		};
		const messageResult: CloudCommandRequest = {
			kind: "agent_message_result",
			requestId: "msgreq_1",
			ok: true,
			receipt: {
				id: "agentmsg_1",
				source: "agent_message",
				target: { activeSessionId: "parent-active", sessionId: "parent-session" },
				message: "reply to the local parent",
				deliveryStatus: "delivered",
				deliveredAt: "2026-09-18T00:00:00.000Z",
				deliveryMode: "steer",
			},
		};
		expect(cloudRequestProblem(rosterResult)).toBeUndefined();
		expect(cloudRequestProblem(messageResult)).toBeUndefined();
		expect(cloudRequestProblem({ kind: "family_roster_result", requestId: "f", entries: "nope" })).toContain(
			"entries must be an array",
		);
		expect(
			cloudRequestProblem({
				kind: "family_roster_result",
				requestId: "f",
				entries: [{ id: "x", depth: 0, status: "busy" }],
			}),
		).toContain("status");
		expect(
			cloudRequestProblem({ kind: "agent_message_result", requestId: "m", ok: true, receipt: undefined }),
		).toContain("receipt is required");
		expect(
			cloudRequestProblem({ kind: "agent_message_result", requestId: "m", ok: false, error: "nope" }),
		).toBeUndefined();
		expect(
			cloudRequestProblem({
				kind: "agent_message_result",
				requestId: "m",
				ok: true,
				receipt: { blob: "x".repeat(3_000) },
			}),
		).toContain("receipt exceeds");

		// v3 optional addressing fields on the existing surface.
		const addressedPrompt: CloudCommandRequest = {
			kind: "prompt",
			text: "work in the descendant",
			queueIfBusy: true,
			targetSessionId: "sess-descendant-1",
		};
		expect(cloudRequestProblem(addressedPrompt)).toBeUndefined();
		expect(cloudRequestProblem({ kind: "prompt", text: "hi", targetSessionId: "" })).toContain("targetSessionId");
		const paritySend: CloudCommandRequest = {
			kind: "send_message",
			targetRemoteSessionId: "sess-descendant-1",
			message: "note",
			messageId: "agentmsg_2",
			from: { activeSessionId: "cloud-active-1", sessionId: "sess-kid-1", runtimeKind: "subagent" },
			fromRelationship: "parent",
		};
		expect(cloudRequestProblem(paritySend)).toBeUndefined();
		expect(cloudRequestProblem({ ...paritySend, fromRelationship: "boss" })).toContain("fromRelationship");
		expect(cloudRequestProblem({ ...paritySend, from: { runtimeKind: "robot" } })).toContain("runtimeKind");
		const uiResponse: CloudCommandRequest = {
			kind: "extension_ui_response",
			requestId: "ui-req-1",
			response: { value: "yes" },
			targetSessionId: "sess-descendant-1",
		};
		expect(cloudRequestProblem(uiResponse)).toBeUndefined();
		const openWithFamily: CloudCommandRequest = {
			kind: "open_session",
			cwd: "/repo",
			family: {
				depth: 1,
				parentSessionId: "parent-session",
				parentSessionFile: "/sessions/parent.jsonl",
				parentName: "local-parent",
			},
		};
		expect(cloudRequestProblem(openWithFamily)).toBeUndefined();
		expect(
			cloudRequestProblem({
				kind: "open_session",
				cwd: "/repo",
				family: { depth: 0, parentSessionId: "p", parentSessionFile: "/p.jsonl" },
			}),
		).toContain("family.depth");

		// Terminal receipts may carry the bounded result payload.
		const commandBase = { type: "command", sessionId: "sess-1", generation: 2 };
		expect(
			parseCloudMessage({ ...commandBase, receipt: { ...receipt(), result: '{"deliveryStatus":"delivered"}' } }).ok,
		).toBe(true);
		expect(problemOf({ ...commandBase, receipt: { ...receipt(), result: "x".repeat(3_000) } })).toContain("result");
	});

	it("bounds v2 event payloads", () => {
		const wrap = (event: unknown): CloudMessage => {
			return { type: "events", sessionId: "sess-1", generation: 2, events: [event as CloudEvent] };
		};
		const entry = {
			sequence: 1,
			kind: "session_entry",
			recordedAt: "2026-09-16T00:00:00.000Z",
			sessionId: "sess-remote-1",
			entryId: "entry-1",
			entry: {
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-09-16T00:00:00.000Z",
				message: { role: "user", content: "x".repeat(300_000) },
			},
		};
		expect(problemOf(wrap(entry))).toContain("must travel as artifact refs");
		expect(problemOf(wrap({ ...entry, entry: "not-an-object" }))).toContain("entry must be a JSON object");
		expect(problemOf(wrap({ ...entry, entry: { id: "e", timestamp: "t" } }))).toContain("entry.type");
		expect(problemOf(wrap({ ...entry, entry: { type: "message", timestamp: "t" } }))).toContain("entry.id");
		expect(problemOf(wrap({ ...entry, entry: { type: "message", id: "e", parentId: 5, timestamp: "t" } }))).toContain(
			"entry.parentId",
		);
		expect(problemOf(wrap({ ...entry, artifacts: [{ path: "/a", sha256: "nope", bytes: 1 }] }))).toContain(
			"artifacts[0].sha256",
		);

		const sessionEvent = {
			sequence: 1,
			kind: "session_event",
			recordedAt: "2026-09-16T00:00:00.000Z",
			sessionId: "sess-remote-1",
			event: { type: "message_update", partial: "x".repeat(200_000) },
		};
		expect(problemOf(wrap(sessionEvent))).toContain("event exceeds");
		expect(problemOf(wrap({ ...sessionEvent, event: { type: "" } }))).toContain("event.type");

		const meta = {
			sequence: 1,
			kind: "session_meta",
			recordedAt: "2026-09-16T00:00:00.000Z",
			sessionId: "sess-remote-1",
			streaming: false,
			runningTools: 0,
			queue: 0,
		};
		expect(problemOf(wrap({ ...meta, streaming: "yes" }))).toContain("streaming");
		expect(problemOf(wrap({ ...meta, taskState: "bored" }))).toContain("taskState");
		expect(problemOf(wrap({ ...meta, connectivityHints: ["ok", 5] }))).toContain("connectivityHints[1]");

		const roster = {
			sequence: 1,
			kind: "roster_delta",
			recordedAt: "2026-09-16T00:00:00.000Z",
			rows: Array.from({ length: 300 }, (_, index) => ({
				childId: `child-${index}`,
				status: "running",
				depth: 1,
			})),
		};
		expect(problemOf(wrap(roster))).toContain("rows must hold at most");
		expect(problemOf(wrap({ ...roster, rows: [{ childId: "c", status: "sleeping", depth: 1 }] }))).toContain(
			"rows[0].status",
		);

		const childUpdate = {
			sequence: 1,
			kind: "child_update",
			recordedAt: "2026-09-16T00:00:00.000Z",
			childId: "child-1",
			status: "running",
		};
		expect(problemOf(wrap({ ...childUpdate, status: "paused" }))).toContain("status");
		expect(problemOf(wrap({ ...childUpdate, answerPreview: "x".repeat(5_000) }))).toContain("answerPreview");

		const usage = {
			sequence: 1,
			kind: "usage",
			recordedAt: "2026-09-16T00:00:00.000Z",
			sessionId: "sess-remote-1",
			totals: { inputTokens: 1, outputTokens: 1, requests: 1 },
			revision: 1,
		};
		expect(problemOf(wrap({ ...usage, totals: { inputTokens: -1, outputTokens: 1, requests: 1 } }))).toContain(
			"totals.inputTokens",
		);
		expect(problemOf(wrap({ ...usage, revision: 1.5 }))).toContain("revision");
	});

	it("grows hello and snapshot capabilities with the v2 feature set", () => {
		const capabilities = [
			"event_stream",
			"command_receipts",
			"session_entries",
			"session_events",
			"roster_stream",
			"family_messages",
			"extension_ui",
			"artifact_refs",
		] as const;
		expect(roundTrip({ ...validHello(), capabilities: [...capabilities] })).toEqual({
			...validHello(),
			capabilities: [...capabilities],
		});
		expect(
			problemOf({ ...validHello(), capabilities: [...capabilities, "made_up"] as unknown as string[] }),
		).toContain("capabilities entry");
		expect(parseCloudMessage({ ...validSnapshot(), capabilities: ["session_entries"] }).ok).toBe(true);
	});

	it("rejects a v1 hello at the version gate", () => {
		// A v2 server answers only v2; a v1 client must fail with the typed
		// version problem, never with a protocol-violation crash.
		const v1Hello = { ...validHello(), protocolVersion: 1 };
		const parsed = parseCloudMessage(v1Hello);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) {
			expect(parsed.error).toContain("hello.protocolVersion must equal 3");
		}
	});

	it("exposes request and id runtime validation", () => {
		for (const request of allV2Requests) {
			expect(cloudRequestProblem(request)).toBeUndefined();
			expect(cloudRequestJsonProblem(request)).toBeUndefined();
		}
		expect(cloudRequestProblem({ kind: "prompt" })).toContain("request.text");
		expect(cloudRequestProblem({ kind: "send_message", targetRemoteSessionId: "", message: "hi" })).toContain(
			"request.targetRemoteSessionId",
		);
		expect(cloudRequestProblem({ kind: "set_model", provider: "openai" })).toContain("request.modelId");
		expect(cloudRequestProblem({ kind: "compact", customInstructions: 5 })).toContain("request.customInstructions");
		expect(cloudRequestProblem({ kind: "cancel_child" })).toContain("request.childId");
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
		expect(cloud.CLOUD_PROTOCOL_VERSION).toBe(3);
	});
});
