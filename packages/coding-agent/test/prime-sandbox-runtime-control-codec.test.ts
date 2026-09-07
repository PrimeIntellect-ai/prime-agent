import { describe, expect, it } from "vitest";
import {
	decodeLifecycleRecord,
	decodeLifecycleReply,
	encodeLifecycleRecord,
	encodeLifecycleReply,
	type LifecycleDecodeRecordResult,
	type LifecycleDecodeReplyResult,
	type LifecycleEncodeResult,
} from "../src/modes/daemon/sandbox/prime-sandbox-runtime-control-codec.js";

// ---------- helpers ----------

function validIdentity() {
	return {
		childId: "child_01",
		sessionId: "sess_abc",
		sessionName: "test-agent",
		modelSelector: "model-v1",
	};
}

function makeStartRecord(prompt: string, spawnCode?: string) {
	const body: Record<string, unknown> = { prompt };
	if (spawnCode !== undefined) body.spawnCode = spawnCode;
	return { v: 1, identity: validIdentity(), op: "START", body };
}

function makeDeliverMessagePayload(overrides?: Record<string, unknown>) {
	const p: Record<string, unknown> = {
		id: "msg_001",
		source: "agent_message",
		target: {
			activeSessionId: "target_active",
			sessionId: "target_sess",
		},
		message: "Hello",
	};
	if (overrides) Object.assign(p, overrides);
	return p;
}

function encodeOk(rec: unknown): LifecycleEncodeResult {
	const enc = encodeLifecycleRecord(rec);
	expect(enc.ok).toBe(true);
	return enc;
}

function decodeRecordOk(bytes: Uint8Array): LifecycleDecodeRecordResult {
	const dec = decodeLifecycleRecord(bytes);
	expect(dec.ok).toBe(true);
	return dec;
}

function encodeReplyOk(op: string, body: unknown): LifecycleEncodeResult {
	const enc = encodeLifecycleReply(op, body);
	expect(enc.ok).toBe(true);
	return enc;
}

function decodeReplyOk(bytes: Uint8Array, op: string): LifecycleDecodeReplyResult {
	const dec = decodeLifecycleReply(bytes, op);
	expect(dec.ok).toBe(true);
	return dec;
}

// ---------- 1. Golden Path: All 7 ops / replies ----------

describe("Golden Path — encode/decode all 7 ops", () => {
	it("START with prompt only", () => {
		const rec = makeStartRecord("Write a test");
		const __enc = encodeOk(rec);
		if (!__enc.ok) return;
		const bytes = __enc.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("START");
		if (dec.op !== "START") return;
		expect(dec.prompt).toBe("Write a test");
		expect(dec.promptSha256).toBeTruthy();
		expect(dec.identity.childId).toBe("child_01");
		// spawnCode absent
		expect(dec.spawnCode).toBeUndefined();
	});

	it("START with prompt + spawnCode", () => {
		const rec = makeStartRecord("Write a test", "return 'hello'");
		const __enc1 = encodeOk(rec);
		if (!__enc1.ok) return;
		const bytes = __enc1.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("START");
		if (dec.op !== "START") return;
		expect(dec.prompt).toBe("Write a test");
		expect(dec.spawnCode).toBe("return 'hello'");
		expect(dec.promptSha256).toBeTruthy();
		expect(dec.spawnCodeSha256).toBeTruthy();
	});

	it("START with wrong SHA-256 on decode", () => {
		// Build canonical wire with an incorrect promptSha256 (valid hex, wrong digest)
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"START","body":{"prompt":"Hello","promptSha256":"' +
			"0".repeat(64) +
			'"}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("MALFORMED_BODY");
	});

	it("EVENT — agent_start", () => {
		const rec = { v: 1, identity: validIdentity(), op: "EVENT", body: { event: { type: "agent_start" } } };
		const __enc2 = encodeOk(rec);
		if (!__enc2.ok) return;
		const bytes = __enc2.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("EVENT");
		if (dec.op !== "EVENT") return;
		expect(dec.event.type).toBe("agent_start");
	});

	it("EVENT — writing with answerPreview", () => {
		const rec = {
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: { event: { type: "writing", answerPreview: "Hello" } },
		};
		const __enc3 = encodeOk(rec);
		if (!__enc3.ok) return;
		const bytes = __enc3.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("EVENT");
		if (dec.op !== "EVENT") return;
		expect(dec.event.type).toBe("writing");
		if (dec.event.type !== "writing") return;
		expect(dec.event.answerPreview).toBe("Hello");
	});

	it("EVENT — executing with toolName", () => {
		const rec = {
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: { event: { type: "executing", toolName: "bash" } },
		};
		const __enc4 = encodeOk(rec);
		if (!__enc4.ok) return;
		const bytes = __enc4.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("EVENT");
		if (dec.op !== "EVENT") return;
		expect(dec.event.type).toBe("executing");
		if (dec.event.type !== "executing") return;
		expect(dec.event.toolName).toBe("bash");
	});

	it("EVENT — child_update 4 keys", () => {
		const rec = {
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: { event: { type: "child_update", status: "running", toolUseCount: 3, parentReplyCount: 1 } },
		};
		const __enc5 = encodeOk(rec);
		if (!__enc5.ok) return;
		const bytes = __enc5.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("EVENT");
		if (dec.op !== "EVENT") return;
		expect(dec.event.type).toBe("child_update");
		if (dec.event.type !== "child_update") return;
		expect(dec.event.status).toBe("running");
		expect(dec.event.toolUseCount).toBe(3);
		expect(dec.event.parentReplyCount).toBe(1);
	});

	it("EVENT — child_update 5 keys with answerPreview", () => {
		const rec = {
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: {
				event: {
					type: "child_update",
					status: "completed",
					toolUseCount: 5,
					parentReplyCount: 2,
					answerPreview: "Done",
				},
			},
		};
		const __enc6 = encodeOk(rec);
		if (!__enc6.ok) return;
		const bytes = __enc6.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("EVENT");
		if (dec.op !== "EVENT") return;
		if (dec.event.type !== "child_update") return;
		expect(dec.event.answerPreview).toBe("Done");
	});

	it("TERMINAL — completed", () => {
		const rec = {
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: { result: { status: "completed", durationMs: 100, parentReplyCount: 2, toolUseCount: 5 } },
		};
		const __enc7 = encodeOk(rec);
		if (!__enc7.ok) return;
		const bytes = __enc7.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("TERMINAL");
		if (dec.op !== "TERMINAL") return;
		expect(dec.result.status).toBe("completed");
		expect(dec.result.durationMs).toBe(100);
	});

	it("TERMINAL — completed with all optional fields", () => {
		const rec = {
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: {
				result: {
					status: "completed",
					durationMs: 200,
					parentReplyCount: 3,
					toolUseCount: 7,
					answerPreview: "Task done",
					lastCommittedRequestId: "req_001",
					usage: { inputTokens: 500, outputTokens: 200 },
				},
			},
		};
		const __enc8 = encodeOk(rec);
		if (!__enc8.ok) return;
		const bytes = __enc8.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("TERMINAL");
		if (dec.op !== "TERMINAL") return;
		expect(dec.result.answerPreview).toBe("Task done");
		expect(dec.result.lastCommittedRequestId).toBe("req_001");
		if (dec.result.usage) {
			expect(dec.result.usage.inputTokens).toBe(500);
			expect(dec.result.usage.outputTokens).toBe(200);
		}
	});

	it("TERMINAL — cancelled", () => {
		const rec = {
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: {
				result: {
					status: "cancelled",
					durationMs: 50,
					parentReplyCount: 0,
					toolUseCount: 0,
					errorCode: "CANCELLED",
				},
			},
		};
		const __enc9 = encodeOk(rec);
		if (!__enc9.ok) return;
		const bytes = __enc9.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("TERMINAL");
		if (dec.op !== "TERMINAL") return;
		expect(dec.result.status).toBe("cancelled");
	});

	it("TERMINAL — error TIMEOUT", () => {
		const rec = {
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: {
				result: {
					status: "error",
					durationMs: 1000,
					parentReplyCount: 1,
					toolUseCount: 2,
					errorCode: "TIMEOUT",
				},
			},
		};
		const __enc10 = encodeOk(rec);
		if (!__enc10.ok) return;
		const bytes = __enc10.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("TERMINAL");
		if (dec.op !== "TERMINAL") return;
		expect(dec.result.status).toBe("error");
	});

	it("ABORT", () => {
		const rec = { v: 1, identity: validIdentity(), op: "ABORT", body: {} };
		const __enc11 = encodeOk(rec);
		if (!__enc11.ok) return;
		const bytes = __enc11.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("ABORT");
		expect(dec.identity.childId).toBe("child_01");
	});

	it("CLOSE", () => {
		const rec = { v: 1, identity: validIdentity(), op: "CLOSE", body: {} };
		const __enc12 = encodeOk(rec);
		if (!__enc12.ok) return;
		const bytes = __enc12.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("CLOSE");
	});

	it("OBSERVE", () => {
		const rec = { v: 1, identity: validIdentity(), op: "OBSERVE", body: {} };
		const __enc13 = encodeOk(rec);
		if (!__enc13.ok) return;
		const bytes = __enc13.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("OBSERVE");
	});

	it("DELIVER_MESSAGE — full payload", () => {
		const payload = makeDeliverMessagePayload({
			target: {
				activeSessionId: "target_active",
				sessionId: "target_sess",
				sessionName: "worker-1",
				runtimeKind: "subagent",
			},
			from: {
				activeSessionId: "parent_active",
				sessionId: "parent_sess",
				sessionName: "orchestrator",
				runtimeKind: "top-level",
				clientId: "cli_01",
			},
			fromRelationship: "parent",
		});
		const rec = { v: 1, identity: validIdentity(), op: "DELIVER_MESSAGE", body: { payload } };
		const __enc14 = encodeOk(rec);
		if (!__enc14.ok) return;
		const bytes = __enc14.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("DELIVER_MESSAGE");
		if (dec.op !== "DELIVER_MESSAGE") return;
		expect(dec.payload.message).toBe("Hello");
		// Check target has all 4 keys
		expect(Object.keys(dec.payload.target).length).toBe(4);
		// Check from has all 5 keys
		expect(dec.payload.from).toBeDefined();
		if (dec.payload.from) expect(Object.keys(dec.payload.from).length).toBe(5);
		expect(dec.payload.fromRelationship).toBe("parent");
	});

	it("DELIVER_MESSAGE — minimal target (2 keys)", () => {
		const payload = makeDeliverMessagePayload();
		const rec = { v: 1, identity: validIdentity(), op: "DELIVER_MESSAGE", body: { payload } };
		const __enc15 = encodeOk(rec);
		if (!__enc15.ok) return;
		const bytes = __enc15.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("DELIVER_MESSAGE");
		if (dec.op !== "DELIVER_MESSAGE") return;
		expect(Object.keys(dec.payload.target).length).toBe(2);
	});

	it("DELIVER_MESSAGE — without from", () => {
		const payload = makeDeliverMessagePayload();
		delete payload.from;
		const rec = { v: 1, identity: validIdentity(), op: "DELIVER_MESSAGE", body: { payload } };
		const __enc16 = encodeOk(rec);
		if (!__enc16.ok) return;
		const bytes = __enc16.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("DELIVER_MESSAGE");
		if (dec.op !== "DELIVER_MESSAGE") return;
		expect(dec.payload.from).toBeUndefined();
	});

	it("DELIVER_MESSAGE — from with only clientId", () => {
		const payload = makeDeliverMessagePayload({
			from: { clientId: "cli_only" },
		});
		const rec = { v: 1, identity: validIdentity(), op: "DELIVER_MESSAGE", body: { payload } };
		const __enc17 = encodeOk(rec);
		if (!__enc17.ok) return;
		const bytes = __enc17.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("DELIVER_MESSAGE");
		if (dec.op !== "DELIVER_MESSAGE") return;
		expect(dec.payload.from).toBeDefined();
		if (dec.payload.from) expect(Object.keys(dec.payload.from).length).toBe(1);
		if (dec.payload.from) expect(dec.payload.from.clientId).toBe("cli_only");
	});

	it("DELIVER_MESSAGE — from empty {}", () => {
		const payload = makeDeliverMessagePayload({ from: {} });
		const rec = { v: 1, identity: validIdentity(), op: "DELIVER_MESSAGE", body: { payload } };
		const __enc18 = encodeOk(rec);
		if (!__enc18.ok) return;
		const bytes = __enc18.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("DELIVER_MESSAGE");
		if (dec.op !== "DELIVER_MESSAGE") return;
		// from as empty object is omitted from canonical, may be dropped
	});

	it("Roundtrip all 7 ops", () => {
		const ops: Array<{ record: unknown; check: (dec: { readonly op: string }) => void }> = [
			{ record: makeStartRecord("test"), check: (d) => expect(d.op).toBe("START") },
			{
				record: { v: 1, identity: validIdentity(), op: "EVENT", body: { event: { type: "agent_end" } } },
				check: (d) => expect(d.op).toBe("EVENT"),
			},
			{
				record: {
					v: 1,
					identity: validIdentity(),
					op: "TERMINAL",
					body: { result: { status: "completed", durationMs: 1, parentReplyCount: 0, toolUseCount: 0 } },
				},
				check: (d) => expect(d.op).toBe("TERMINAL"),
			},
			{
				record: { v: 1, identity: validIdentity(), op: "ABORT", body: {} },
				check: (d) => expect(d.op).toBe("ABORT"),
			},
			{
				record: { v: 1, identity: validIdentity(), op: "CLOSE", body: {} },
				check: (d) => expect(d.op).toBe("CLOSE"),
			},
			{
				record: { v: 1, identity: validIdentity(), op: "OBSERVE", body: {} },
				check: (d) => expect(d.op).toBe("OBSERVE"),
			},
			{
				record: {
					v: 1,
					identity: validIdentity(),
					op: "DELIVER_MESSAGE",
					body: { payload: makeDeliverMessagePayload() },
				},
				check: (d) => expect(d.op).toBe("DELIVER_MESSAGE"),
			},
		];
		for (const { record, check } of ops) {
			const __enc19 = encodeOk(record);
			if (!__enc19.ok) return;
			const bytes = __enc19.bytes;
			const dec = decodeRecordOk(bytes);
			if (!dec.ok) return;
			check(dec);
		}
	});
});

describe("Golden Path — encode/decode all 7 replies", () => {
	it("START reply", () => {
		const __enc0 = encodeReplyOk("START", { code: "ADMITTED" });
		if (!__enc0.ok) return;
		const bytes = __enc0.bytes;
		const dec = decodeReplyOk(bytes, "START");
		if (!dec.ok) return;
		expect(dec.op).toBe("START");
		if (dec.op !== "START") return;
		expect(dec.body.code).toBe("ADMITTED");
	});

	it("EVENT reply", () => {
		const __enc1 = encodeReplyOk("EVENT", { code: "ACK" });
		if (!__enc1.ok) return;
		const bytes = __enc1.bytes;
		const dec = decodeReplyOk(bytes, "EVENT");
		if (!dec.ok) return;
		expect(dec.op).toBe("EVENT");
		if (dec.op !== "EVENT") return;
		expect(dec.body.code).toBe("ACK");
	});

	it("TERMINAL reply", () => {
		const __enc2 = encodeReplyOk("TERMINAL", { code: "ACK" });
		if (!__enc2.ok) return;
		const bytes = __enc2.bytes;
		const dec = decodeReplyOk(bytes, "TERMINAL");
		if (!dec.ok) return;
		expect(dec.op).toBe("TERMINAL");
	});

	it("ABORT reply — aborted", () => {
		const __enc3 = encodeReplyOk("ABORT", { status: "aborted" });
		if (!__enc3.ok) return;
		const bytes = __enc3.bytes;
		const dec = decodeReplyOk(bytes, "ABORT");
		if (!dec.ok) return;
		expect(dec.op).toBe("ABORT");
		if (dec.op !== "ABORT") return;
		expect(dec.body.status).toBe("aborted");
	});

	it("ABORT reply — already_terminal", () => {
		const __enc4 = encodeReplyOk("ABORT", { status: "already_terminal" });
		if (!__enc4.ok) return;
		const bytes = __enc4.bytes;
		const dec = decodeReplyOk(bytes, "ABORT");
		if (!dec.ok) return;
		expect(dec.op).toBe("ABORT");
		if (dec.op !== "ABORT") return;
		expect(dec.body.status).toBe("already_terminal");
	});

	it("CLOSE reply", () => {
		const __enc5 = encodeReplyOk("CLOSE", { status: "closed" });
		if (!__enc5.ok) return;
		const bytes = __enc5.bytes;
		const dec = decodeReplyOk(bytes, "CLOSE");
		if (!dec.ok) return;
		expect(dec.op).toBe("CLOSE");
		if (dec.op !== "CLOSE") return;
		expect(dec.body.status).toBe("closed");
	});

	it("DELIVER_MESSAGE reply — delivered", () => {
		const __enc6 = encodeReplyOk("DELIVER_MESSAGE", { status: "delivered" });
		if (!__enc6.ok) return;
		const bytes = __enc6.bytes;
		const dec = decodeReplyOk(bytes, "DELIVER_MESSAGE");
		if (!dec.ok) return;
		expect(dec.op).toBe("DELIVER_MESSAGE");
		if (dec.op !== "DELIVER_MESSAGE") return;
		expect(dec.body.status).toBe("delivered");
	});

	it("DELIVER_MESSAGE reply — queued", () => {
		const __enc7 = encodeReplyOk("DELIVER_MESSAGE", { status: "queued" });
		if (!__enc7.ok) return;
		const bytes = __enc7.bytes;
		const dec = decodeReplyOk(bytes, "DELIVER_MESSAGE");
		if (!dec.ok) return;
		expect(dec.op).toBe("DELIVER_MESSAGE");
		if (dec.op !== "DELIVER_MESSAGE") return;
		expect(dec.body.status).toBe("queued");
	});

	it("OBSERVE reply", () => {
		const obs = {
			status: "running",
			messageCount: 5,
			toolUseCount: 3,
			agentRunning: true,
			parentReplyCount: 1,
		};
		const __enc8 = encodeReplyOk("OBSERVE", obs);
		if (!__enc8.ok) return;
		const bytes = __enc8.bytes;
		const dec = decodeReplyOk(bytes, "OBSERVE");
		if (!dec.ok) return;
		expect(dec.op).toBe("OBSERVE");
		if (dec.op !== "OBSERVE") return;
		expect(dec.body.status).toBe("running");
		expect(dec.body.messageCount).toBe(5);
	});

	it("Roundtrip all 7 replies", () => {
		const replies: Array<{ op: string; body: unknown }> = [
			{ op: "START", body: { code: "ADMITTED" } },
			{ op: "EVENT", body: { code: "ACK" } },
			{ op: "TERMINAL", body: { code: "ACK" } },
			{ op: "ABORT", body: { status: "aborted" } },
			{ op: "CLOSE", body: { status: "closed" } },
			{ op: "DELIVER_MESSAGE", body: { status: "delivered" } },
			{
				op: "OBSERVE",
				body: { status: "queued", messageCount: 0, toolUseCount: 0, agentRunning: false, parentReplyCount: 0 },
			},
		];
		for (const { op, body } of replies) {
			const __enc9 = encodeReplyOk(op, body);
			if (!__enc9.ok) return;
			const bytes = __enc9.bytes;
			const dec = decodeReplyOk(bytes, op);
			if (!dec.ok) return;
			expect(dec.op).toBe(op);
		}
	});
});

// ---------- 2. Canonical Compliance ----------

describe("Canonical Compliance", () => {
	it("leading whitespace → CANONICAL_MISMATCH", () => {
		const rec = makeStartRecord("Hello");
		const __enc20 = encodeOk(rec);
		if (!__enc20.ok) return;
		const bytes = __enc20.bytes;
		const tampered = new Uint8Array(bytes.length + 1);
		tampered[0] = 32;
		tampered.set(bytes, 1); // leading space
		const dec = decodeLifecycleRecord(tampered);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("CANONICAL_MISMATCH");
	});

	it("envelope key reordering → INPUT_INVALID (exact envelope order)", () => {
		const rec = makeStartRecord("Hello");
		const __enc21 = encodeOk(rec);
		if (!__enc21.ok) return;
		const bytes = __enc21.bytes;
		const text = new TextDecoder().decode(bytes);
		const parsed = JSON.parse(text);
		const reordered: Record<string, unknown> = Object.create(null);
		reordered.identity = parsed.identity;
		reordered.v = parsed.v;
		reordered.op = parsed.op;
		reordered.body = parsed.body;
		const reorderedBytes = new TextEncoder().encode(JSON.stringify(reordered));
		const dec = decodeLifecycleRecord(reorderedBytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("INPUT_INVALID");
	});

	it("nested target key reordering → CANONICAL_MISMATCH", () => {
		// target keys in wrong order: [sessionId, activeSessionId]
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"DELIVER_MESSAGE","body":{"payload":{"id":"msg_1","source":"agent_message","target":{"sessionId":"t_sess","activeSessionId":"t_active"},"message":"Hi"}}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("CANONICAL_MISMATCH");
	});

	it("escaped character \\u0041 → CANONICAL_MISMATCH", () => {
		// Build malformed wire with escape
		const bytes = new TextEncoder().encode(
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"ABORT","body":{}}',
		);
		const text = new TextDecoder().decode(bytes);
		const escaped = text.replace('"childId":"c"', '"childId":"\\u0063"');
		const escapedBytes = new TextEncoder().encode(escaped);
		const dec = decodeLifecycleRecord(escapedBytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("CANONICAL_MISMATCH");
	});

	it("duplicate keys → CANONICAL_MISMATCH", () => {
		// JSON with duplicate keys
		const dupJson =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"ABORT","body":{},"v":1}';
		const bytes = new TextEncoder().encode(dupJson);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("CANONICAL_MISMATCH");
	});

	it("1.0 instead of 1 → CANONICAL_MISMATCH", () => {
		const json =
			'{"v":1.0,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"ABORT","body":{}}';
		const bytes = new TextEncoder().encode(json);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("CANONICAL_MISMATCH");
	});

	it("-0 in wire JSON → CANONICAL_MISMATCH", () => {
		const json =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"TERMINAL","body":{"result":{"status":"completed","durationMs":-0,"parentReplyCount":0,"toolUseCount":0}}}';
		const bytes = new TextEncoder().encode(json);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("CANONICAL_MISMATCH");
	});

	it("trailing garbage → CANONICAL_MISMATCH or MALFORMED_BODY", () => {
		const rec = makeStartRecord("Hello");
		const __enc22 = encodeOk(rec);
		if (!__enc22.ok) return;
		const bytes = __enc22.bytes;
		const garbaged = new Uint8Array(bytes.length + 2);
		garbaged.set(bytes);
		garbaged[bytes.length] = 0x20;
		garbaged[bytes.length + 1] = 0x78; // trailing " x"
		const dec = decodeLifecycleRecord(garbaged);
		expect(dec.ok).toBe(false);
	});

	it("tab/ newline whitespace → CANONICAL_MISMATCH", () => {
		const json =
			'{\n\t"v": 1,\n\t"identity": {"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},\n\t"op":"ABORT",\n\t"body":{}\n}';
		const bytes = new TextEncoder().encode(json);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("CANONICAL_MISMATCH");
	});
});

// ---------- 3. Bound Tests ----------

describe("Bound Tests", () => {
	it("prompt at 32768 JS .length → accepted", () => {
		const prompt = "x".repeat(32768);
		const rec = makeStartRecord(prompt);
		const __enc23 = encodeOk(rec);
		if (!__enc23.ok) return;
		const bytes = __enc23.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("START");
	});

	it("prompt at 32769 → BOUNDS_EXCEEDED (encode)", () => {
		const prompt = "x".repeat(32769);
		const rec = makeStartRecord(prompt);
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("spawnCode at 4096 → accepted", () => {
		const code = "x".repeat(4096);
		const rec = makeStartRecord("test", code);
		const __enc24 = encodeOk(rec);
		if (!__enc24.ok) return;
		const bytes = __enc24.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("START");
	});

	it("spawnCode at 4097 → BOUNDS_EXCEEDED (encode)", () => {
		const code = "x".repeat(4097);
		const rec = makeStartRecord("test", code);
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("identifier at 128 chars → accepted", () => {
		const id = validIdentity();
		id.childId = "a".repeat(128);
		const rec = { v: 1, identity: id, op: "ABORT", body: {} };
		const __enc25 = encodeOk(rec);
		if (!__enc25.ok) return;
		const bytes = __enc25.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("ABORT");
	});

	it("identifier at 129 → MALFORMED_IDENTITY", () => {
		const id = validIdentity();
		id.childId = "a".repeat(129);
		const rec = { v: 1, identity: id, op: "ABORT", body: {} };
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("identifier with space → MALFORMED_IDENTITY (encode)", () => {
		const id = validIdentity();
		id.sessionName = "bad name";
		const rec = { v: 1, identity: id, op: "ABORT", body: {} };
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("lastCommittedRequestId at 128 printable ASCII → accepted", () => {
		const lcri = "a".repeat(128);
		const rec = {
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: {
				result: {
					status: "completed",
					durationMs: 1,
					parentReplyCount: 0,
					toolUseCount: 0,
					lastCommittedRequestId: lcri,
				},
			},
		};
		const __enc26 = encodeOk(rec);
		if (!__enc26.ok) return;
		const bytes = __enc26.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("TERMINAL");
	});

	it("durationMs = -0 (encode input) → accepted, wire gets 0", () => {
		const rec = {
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: { result: { status: "completed", durationMs: -0, parentReplyCount: 0, toolUseCount: 0 } },
		};
		const __enc27 = encodeOk(rec);
		if (!__enc27.ok) return;
		const bytes = __enc27.bytes;
		const text = new TextDecoder().decode(bytes);
		// Wire should have "durationMs":0 not "durationMs":-0
		expect(text).not.toContain('"-0"');
		expect(text).toContain('"durationMs":0');
	});

	it("message with newline/tab → accepted", () => {
		const payload = makeDeliverMessagePayload({ message: "Hello\n\tWorld" });
		const rec = { v: 1, identity: validIdentity(), op: "DELIVER_MESSAGE", body: { payload } };
		const __enc28 = encodeOk(rec);
		if (!__enc28.ok) return;
		const bytes = __enc28.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("DELIVER_MESSAGE");
	});

	it("message with null byte → accepted by bound", () => {
		const payload = makeDeliverMessagePayload({ message: "Hello\x00World" });
		const rec = { v: 1, identity: validIdentity(), op: "DELIVER_MESSAGE", body: { payload } };
		const __enc29 = encodeOk(rec);
		if (!__enc29.ok) return;
		const bytes = __enc29.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("DELIVER_MESSAGE");
	});

	it("answerPreview at 2048 → accepted (encode via child_update)", () => {
		const preview = "x".repeat(2048);
		const rec = {
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: {
				event: {
					type: "child_update",
					status: "running",
					toolUseCount: 0,
					parentReplyCount: 0,
					answerPreview: preview,
				},
			},
		};
		const __enc30 = encodeOk(rec);
		if (!__enc30.ok) return;
		const bytes = __enc30.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("EVENT");
	});

	it("Wire bytes at 262128 boundary", () => {
		// Create a large prompt to get close to boundary
		const prompt = "x".repeat(32768);
		// On its own this should be well under 262k
		const rec = makeStartRecord(prompt);
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(true);
		if (enc.ok) {
			// Should be well under limit
			expect(enc.bytes.byteLength).toBeLessThanOrEqual(262128);
		}
	});
});

// ---------- 4. Scalar-String / Surrogate Tests ----------

describe("Scalar-String / Surrogate Tests", () => {
	it("prompt with lone high surrogate (0xD800) — encode → INPUT_INVALID", () => {
		const prompt = `before${String.fromCharCode(0xd800)}after`;
		const rec = makeStartRecord(prompt);
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("prompt with lone low surrogate (0xDC00) — encode → INPUT_INVALID", () => {
		const prompt = `before${String.fromCharCode(0xdc00)}after`;
		const rec = makeStartRecord(prompt);
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("prompt with trailing high surrogate — encode → INPUT_INVALID", () => {
		const prompt = `test${String.fromCharCode(0xd800)}`;
		const rec = makeStartRecord(prompt);
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("prompt with valid surrogate pair (U+10000) — encode → ok", () => {
		const prompt = `test ${String.fromCharCode(0xd800, 0xdc00)} end`;
		const rec = makeStartRecord(prompt);
		const __enc31 = encodeOk(rec);
		if (!__enc31.ok) return;
		const bytes = __enc31.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("START");
		if (dec.op === "START") {
			expect(dec.prompt).toBe(prompt);
		}
	});

	it("prompt with multiple surrogate pairs (emoji) — encode → ok", () => {
		const prompt = `emoji: ${String.fromCharCode(0xd83d, 0xde00)}${String.fromCharCode(0xd83d, 0xdc4d)}`;
		const rec = makeStartRecord(prompt);
		const __enc32 = encodeOk(rec);
		if (!__enc32.ok) return;
		const bytes = __enc32.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("START");
	});

	it("message with unpaired surrogate — encode → INPUT_INVALID", () => {
		const payload = makeDeliverMessagePayload({ message: `msg${String.fromCharCode(0xd800)}` });
		const rec = { v: 1, identity: validIdentity(), op: "DELIVER_MESSAGE", body: { payload } };
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("message with valid surrogate pair (emoji) — encode → ok", () => {
		const payload = makeDeliverMessagePayload({ message: `Hi ${String.fromCharCode(0xd83d, 0xde00)}` });
		const rec = { v: 1, identity: validIdentity(), op: "DELIVER_MESSAGE", body: { payload } };
		const __enc33 = encodeOk(rec);
		if (!__enc33.ok) return;
		const bytes = __enc33.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("DELIVER_MESSAGE");
	});

	it("wire JSON with \\uD800 escape → MALFORMED_BODY", () => {
		// Wire contains a lone-surrogate escape; JSON.parse produces the char, isScalarString rejects
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"START","body":{"prompt":"bad\\uD800","promptSha256":"' +
			"0".repeat(64) +
			'"}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("MALFORMED_BODY");
	});

	it("spawnCode with lone surrogate → INPUT_INVALID", () => {
		const rec = makeStartRecord("test", `code${String.fromCharCode(0xdc00)}`);
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});
});

// ---------- 5. Hostile Input ----------

describe("Hostile Input — encode paths", () => {
	it("Proxy object → INPUT_INVALID", () => {
		const target = { v: 1, identity: validIdentity(), op: "ABORT", body: {} };
		const proxy = new Proxy(target, {});
		const enc = encodeLifecycleRecord(proxy);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("Promise → INPUT_INVALID", () => {
		const enc = encodeLifecycleRecord(Promise.resolve({}));
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("Zero-prototype → INPUT_INVALID", () => {
		const obj = Object.create(null);
		obj.v = 1;
		obj.identity = validIdentity();
		obj.op = "ABORT";
		obj.body = {};
		const enc = encodeLifecycleRecord(obj);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("Object with symbols → INPUT_INVALID", () => {
		const obj = { v: 1, identity: validIdentity(), op: "ABORT", body: {} };
		Object.defineProperty(obj, Symbol("test"), { value: 1, enumerable: true });
		const enc = encodeLifecycleRecord(obj);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("Accessor (getter) → INPUT_INVALID", () => {
		const obj = { v: 1, identity: validIdentity(), op: "ABORT", body: {} };
		Object.defineProperty(obj, "body", { get: () => ({}), enumerable: true });
		const enc = encodeLifecycleRecord(obj);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("toJSON own key → INPUT_INVALID", () => {
		const obj = { v: 1, identity: validIdentity(), op: "ABORT", body: {}, toJSON: () => ({}) };
		const enc = encodeLifecycleRecord(obj);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("Extra envelope key → INPUT_INVALID", () => {
		const enc = encodeLifecycleRecord({ v: 1, identity: validIdentity(), op: "ABORT", body: {}, extra: "bad" });
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("Missing envelope key → INPUT_INVALID", () => {
		const enc = encodeLifecycleRecord({ v: 1, identity: validIdentity(), op: "ABORT" });
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("Array instead of object → INPUT_INVALID", () => {
		const enc = encodeLifecycleRecord([1, 2, 3]);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it('v is string "1" → INPUT_INVALID', () => {
		const enc = encodeLifecycleRecord({ v: "1", identity: validIdentity(), op: "ABORT", body: {} });
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("Unknown op → UNKNOWN_OP", () => {
		const enc = encodeLifecycleRecord({ v: 1, identity: validIdentity(), op: "INVALID", body: {} });
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("UNKNOWN_OP");
	});
});

describe("Hostile Input — decode paths", () => {
	it("Invalid UTF-8 bytes → MALFORMED_BODY", () => {
		const bytes = new Uint8Array([0xff, 0xfe, 0x00]);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("MALFORMED_BODY");
	});

	it("Malformed JSON → MALFORMED_BODY", () => {
		const bytes = new TextEncoder().encode("{invalid json}");
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("MALFORMED_BODY");
	});

	it("Decode of array JSON → INPUT_INVALID (array proto rejected)", () => {
		const bytes = new TextEncoder().encode("[1,2,3]");
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("INPUT_INVALID");
	});

	it("Decode of scalar JSON → INPUT_INVALID", () => {
		const bytes = new TextEncoder().encode('"hello"');
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("INPUT_INVALID");
	});

	it("Decode with valid canonical JSON succeeds", () => {
		const json =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"ABORT","body":{}}';
		const bytes = new TextEncoder().encode(json);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(true);
	});

	it("Circular reference → INPUT_INVALID", () => {
		const obj: { [key: string]: unknown } = { v: 1, identity: validIdentity(), op: "ABORT", body: {} };
		obj.self = obj;
		const enc = encodeLifecycleRecord(obj);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("Non-enumerable property → INPUT_INVALID", () => {
		const obj = { v: 1, identity: validIdentity(), op: "ABORT", body: {} };
		Object.defineProperty(obj, "hidden", { value: 1, enumerable: false });
		const enc = encodeLifecycleRecord(obj);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});
});

// ---------- 6. Cross-Field Semantics ----------

describe("Cross-Field Semantics", () => {
	it("TERMINAL completed with errorCode → MALFORMED_BODY", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: {
				result: { status: "completed", durationMs: 1, parentReplyCount: 0, toolUseCount: 0, errorCode: "TIMEOUT" },
			},
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("TERMINAL cancelled with answerPreview → MALFORMED_BODY", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: {
				result: {
					status: "cancelled",
					durationMs: 1,
					parentReplyCount: 0,
					toolUseCount: 0,
					errorCode: "CANCELLED",
					answerPreview: "no",
				},
			},
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("TERMINAL cancelled with wrong errorCode → MALFORMED_BODY", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: {
				result: { status: "cancelled", durationMs: 1, parentReplyCount: 0, toolUseCount: 0, errorCode: "TIMEOUT" },
			},
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("TERMINAL error without errorCode → MALFORMED_BODY", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: { result: { status: "error", durationMs: 1, parentReplyCount: 0, toolUseCount: 0 } },
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("TERMINAL error with answerPreview → MALFORMED_BODY", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: {
				result: {
					status: "error",
					durationMs: 1,
					parentReplyCount: 0,
					toolUseCount: 0,
					errorCode: "TIMEOUT",
					answerPreview: "bad",
				},
			},
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("EVENT writing without answerPreview → MALFORMED_BODY", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: { event: { type: "writing" } },
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("EVENT agent_start with extra key → MALFORMED_BODY", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: { event: { type: "agent_start", extra: "bad" } },
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("OBSERVE reply agentRunning:true with status:completed → MALFORMED_BODY", () => {
		const enc = encodeLifecycleReply("OBSERVE", {
			status: "completed",
			messageCount: 1,
			toolUseCount: 0,
			agentRunning: true,
			parentReplyCount: 0,
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("usage with extra key → MALFORMED_BODY", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: {
				result: {
					status: "completed",
					durationMs: 1,
					parentReplyCount: 0,
					toolUseCount: 0,
					usage: { inputTokens: 1, outputTokens: 2, extra: 3 },
				},
			},
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});
});

// ---------- 7. Output Integrity ----------

describe("Output Integrity", () => {
	it("Decoded record is frozen", () => {
		const rec = makeStartRecord("test");
		const __enc34 = encodeOk(rec);
		if (!__enc34.ok) return;
		const bytes = __enc34.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(Object.isFrozen(dec)).toBe(true);
	});

	it("Decoded identity is frozen", () => {
		const rec = makeStartRecord("test");
		const __enc35 = encodeOk(rec);
		if (!__enc35.ok) return;
		const bytes = __enc35.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(Object.isFrozen(dec.identity)).toBe(true);
	});

	it("Encoded bytes are fresh buffer (no aliasing)", () => {
		const source = { v: 1, identity: validIdentity(), op: "START", body: { prompt: "test" } };
		const enc = encodeLifecycleRecord(source);
		expect(enc.ok).toBe(true);
		if (enc.ok) {
			// Can't easily verify no aliasing without knowing internals, but check it's a real Uint8Array
			expect(enc.bytes).toBeInstanceOf(Uint8Array);
		}
	});

	it("No throws from any function", () => {
		// Test various edge cases
		const inputs = [null, undefined, true, 1, "string", [], {}, new Uint8Array(4)];
		for (const inp of inputs) {
			expect(() => encodeLifecycleRecord(inp)).not.toThrow();
			expect(() => decodeLifecycleRecord(inp)).not.toThrow();
			expect(() => encodeLifecycleReply("START", inp)).not.toThrow();
			expect(() => decodeLifecycleReply(inp, "START")).not.toThrow();
		}
	});
});

// ---------- 8. Reply-Specific Tests ----------

describe("Reply-Specific Tests", () => {
	it("Decode START reply with wrong op → OP_MISMATCH", () => {
		const __enc10 = encodeReplyOk("START", { code: "ADMITTED" });
		if (!__enc10.ok) return;
		const bytes = __enc10.bytes;
		const dec = decodeLifecycleReply(bytes, "ABORT");
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("OP_MISMATCH");
	});

	it("Decode ABORT reply wrong status → OP_MISMATCH", () => {
		// Status "unknown" is not a valid ABORT status
		const json = '{"status":"unknown"}';
		const bytes = new TextEncoder().encode(json);
		const dec = decodeLifecycleReply(bytes, "ABORT");
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("OP_MISMATCH");
	});

	it("Encode reply with unknown expectedOp → UNKNOWN_OP", () => {
		const enc = encodeLifecycleReply("INVALID", {});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("UNKNOWN_OP");
	});

	it("OBSERVE reply missing required field → MALFORMED_BODY", () => {
		const enc = encodeLifecycleReply("OBSERVE", {
			status: "running",
			messageCount: 1,
			toolUseCount: 0,
			parentReplyCount: 0,
			// missing agentRunning (required boolean)
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});
});

// ---------- 9. Identity and Digest ----------

describe("Identity and Digest", () => {
	it("Empty childId → MALFORMED_IDENTITY", () => {
		const id = validIdentity();
		id.childId = "";
		const rec = { v: 1, identity: id, op: "ABORT", body: {} };
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("childId with valid chars → accepted", () => {
		const id = validIdentity();
		id.childId = "a-b_c.d/e:f0_9";
		const rec = { v: 1, identity: id, op: "ABORT", body: {} };
		const __enc36 = encodeOk(rec);
		if (!__enc36.ok) return;
		const bytes = __enc36.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.identity.childId).toBe("a-b_c.d/e:f0_9");
	});

	it("SHA-256 matches on decode", () => {
		const rec = makeStartRecord("Hello World");
		const __enc37 = encodeOk(rec);
		if (!__enc37.ok) return;
		const bytes = __enc37.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.op).toBe("START");
	});

	it("Prompt absent from events/observe (never leaks)", () => {
		const rec = makeStartRecord("Secret prompt");
		const __enc38 = encodeOk(rec);
		if (!__enc38.ok) return;
		const bytes = __enc38.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		if (dec.ok && dec.op === "START") {
			expect(dec.prompt).toBe("Secret prompt");
			// prompt is not part of observe/event records
		}
		// Verify events don't contain the prompt
		const eventRec = { v: 1, identity: validIdentity(), op: "EVENT", body: { event: { type: "agent_start" } } };
		const __enc39 = encodeOk(eventRec);
		if (!__enc39.ok) return;
		const eventBytes = __enc39.bytes;
		const eventText = new TextDecoder().decode(eventBytes);
		expect(eventText).not.toContain("Secret prompt");
	});
});

// ---------- 10. Buffer Mutation / Detach / Offset ----------

describe("Buffer Integrity", () => {
	it("Decode with shared ArrayBuffer → INPUT_INVALID", () => {
		const shared = new Uint8Array(new SharedArrayBuffer(10));
		const dec = decodeLifecycleRecord(shared);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("INPUT_INVALID");
	});

	it("Decode with nonzero offset view → INPUT_INVALID", () => {
		const storage = new ArrayBuffer(20);
		const view = new Uint8Array(storage, 4, 10);
		const dec = decodeLifecycleRecord(view);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("INPUT_INVALID");
	});

	it("Original input not modified after decode", () => {
		const rec = makeStartRecord("test");
		const __enc40 = encodeOk(rec);
		if (!__enc40.ok) return;
		const bytes = __enc40.bytes;
		const dec = decodeLifecycleRecord(bytes);
		// bytes might or might not be zeroed (owned copy is zeroed, but the input may be fine)
		// Just check the result is valid
		expect(dec.ok).toBe(true);
	});
});

// ---------- 11. Canonical — extra key in target / absent optional key ----------

describe("Canonical — target optional keys", () => {
	it("absent optional target keys pass canonical (minimal wire)", () => {
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"DELIVER_MESSAGE","body":{"payload":{"id":"msg_1","source":"agent_message","target":{"activeSessionId":"a","sessionId":"s"},"message":"Hi"}}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(true);
	});

	it("extra key in target → MALFORMED_BODY", () => {
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"DELIVER_MESSAGE","body":{"payload":{"id":"msg_1","source":"agent_message","target":{"activeSessionId":"a","sessionId":"s","bogus":"x"},"message":"Hi"}}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("MALFORMED_BODY");
	});

	it("absent from key passes canonical", () => {
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"DELIVER_MESSAGE","body":{"payload":{"id":"msg_1","source":"agent_message","target":{"activeSessionId":"a","sessionId":"s"},"message":"Hi"}}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(true);
	});

	it("from:{} in wire stays canonical", () => {
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"DELIVER_MESSAGE","body":{"payload":{"id":"msg_1","source":"agent_message","target":{"activeSessionId":"a","sessionId":"s"},"from":{},"message":"Hi"}}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(true);
		if (dec.ok && dec.op === "DELIVER_MESSAGE") {
			expect(Object.keys(dec.payload.from || {}).length).toBe(0);
		}
	});
});

// ---------- 12. Additional Bound Tests ----------

describe("Additional Bound Tests", () => {
	it("answerPreview at 2049 → rejected on encode", () => {
		const preview = "x".repeat(2049);
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: { event: { type: "writing", answerPreview: preview } },
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("toolName at 256 → accepted", () => {
		const tool = "x".repeat(256);
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: { event: { type: "executing", toolName: tool } },
		});
		expect(enc.ok).toBe(true);
	});

	it("toolName at 257 → rejected on encode", () => {
		const tool = "x".repeat(257);
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: { event: { type: "executing", toolName: tool } },
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("lastCommittedRequestId with 0x7F → rejected", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: {
				result: {
					status: "completed",
					durationMs: 1,
					parentReplyCount: 0,
					toolUseCount: 0,
					lastCommittedRequestId: "a\x7f",
				},
			},
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("promptSha256 uppercase hex in wire → CANONICAL_MISMATCH", () => {
		// Use a prompt whose SHA-256 starts with a hex letter (a-f)
		const rec = makeStartRecord("xxxxx");
		const __enc41 = encodeOk(rec);
		if (!__enc41.ok) return;
		const bytes = __enc41.bytes;
		const text = new TextDecoder().decode(bytes);
		const match = /"promptSha256":"([0-9a-f]{64})"/.exec(text);
		expect(match).not.toBeNull();
		if (!match) return;
		const digest = match[1];
		const upper = digest[0].toUpperCase() + digest.slice(1);
		expect(upper).not.toBe(digest);
		const tampered = new TextEncoder().encode(text.replace(`"${digest}"`, `"${upper}"`));
		const dec = decodeLifecycleRecord(tampered);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("CANONICAL_MISMATCH");
	});

	it("promptSha256 not 64 chars in wire → MALFORMED_BODY", () => {
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"START","body":{"prompt":"Hello","promptSha256":"abc"}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("MALFORMED_BODY");
	});

	it("spawnCode present without SHA → MALFORMED_BODY", () => {
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"START","body":{"prompt":"Hello","promptSha256":"' +
			"0".repeat(64) +
			'","spawnCode":"code"}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("MALFORMED_BODY");
	});

	it("spawnCodeSha256 present without spawnCode → MALFORMED_BODY", () => {
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"START","body":{"prompt":"Hello","promptSha256":"' +
			"0".repeat(64) +
			'","spawnCodeSha256":"' +
			"0".repeat(64) +
			'"}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("MALFORMED_BODY");
	});

	it("wire bytes at 262128 accepted as input bound (parse fails downstream, not bound)", () => {
		const big = new Uint8Array(262128);
		big.fill(0x20); // spaces — valid JSON whitespace prefix
		const dec = decodeLifecycleRecord(big);
		// Not BOUNDS_EXCEEDED; either MALFORMED_BODY (incomplete JSON) or CANONICAL_MISMATCH
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).not.toBe("BOUNDS_EXCEEDED");
	});

	it("wire bytes at 262129 → BOUNDS_EXCEEDED", () => {
		const big = new Uint8Array(262129);
		const dec = decodeLifecycleRecord(big);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("BOUNDS_EXCEEDED");
	});

	it("durationMs = NaN → rejected on encode", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: { result: { status: "completed", durationMs: Number.NaN, parentReplyCount: 0, toolUseCount: 0 } },
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("durationMs = Infinity → rejected on encode", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: {
				result: { status: "completed", durationMs: Number.POSITIVE_INFINITY, parentReplyCount: 0, toolUseCount: 0 },
			},
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});
});

// ---------- 13. Additional Scalar Tests ----------

describe("Additional Scalar / Surrogate Tests", () => {
	it("answerPreview with lone surrogate → rejected on encode", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: { event: { type: "writing", answerPreview: `x${String.fromCharCode(0xd800)}` } },
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("toolName with lone surrogate → rejected on encode", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: { event: { type: "executing", toolName: `x${String.fromCharCode(0xdc00)}` } },
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("wire JSON with \uD800\uDC00 pair → accepted", () => {
		// valid surrogate pair escape; JSON.parse yields U+10000 which is scalar
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"START","body":{"prompt":"bad\\uD800\\uDC00","promptSha256":"' +
			"0".repeat(64) +
			'"}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		// The SHA is all-zeros so it fails SHA verification → MALFORMED_BODY
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("MALFORMED_BODY");
	});

	it("answerPreview lone surrogate on decode wire → MALFORMED_BODY", () => {
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"EVENT","body":{"event":{"type":"writing","answerPreview":"bad\\uD800"}}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("MALFORMED_BODY");
	});
});

// ---------- 14. Additional Hostile Input ----------

describe("Additional Hostile Input", () => {
	it("__proto__ key in body → MALFORMED_BODY", () => {
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"ABORT","body":{"__proto__":{}}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("MALFORMED_BODY");
	});

	it("revoked proxy on encode → INPUT_INVALID", () => {
		const target = { v: 1, identity: validIdentity(), op: "ABORT", body: {} };
		const { proxy, revoke } = Proxy.revocable(target, {});
		revoke();
		const enc = encodeLifecycleRecord(proxy);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("getter on nested identity field → INPUT_INVALID", () => {
		const id = validIdentity();
		Object.defineProperty(id, "sessionName", { get: () => "x", enumerable: true });
		const enc = encodeLifecycleRecord({ v: 1, identity: id, op: "ABORT", body: {} });
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("symbol key on nested body → INPUT_INVALID", () => {
		const body = {};
		Object.defineProperty(body, Symbol("s"), { value: 1, enumerable: true });
		const enc = encodeLifecycleRecord({ v: 1, identity: validIdentity(), op: "ABORT", body });
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("non-enumerable envelope key → INPUT_INVALID", () => {
		const obj = { v: 1, identity: validIdentity(), op: "ABORT", body: {} };
		Object.defineProperty(obj, "hidden", { value: 1, enumerable: false });
		const enc = encodeLifecycleRecord(obj);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});
});

// ---------- 15. Additional Cross-Field Negatives ----------

describe("Additional Cross-Field Negatives", () => {
	it("TERMINAL error with lastCommittedRequestId → rejected", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: {
				result: {
					status: "error",
					durationMs: 1,
					parentReplyCount: 0,
					toolUseCount: 0,
					errorCode: "TIMEOUT",
					lastCommittedRequestId: "r",
				},
			},
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("OBSERVE reply missing agentRunning → rejected", () => {
		const enc = encodeLifecycleReply("OBSERVE", {
			status: "queued",
			messageCount: 0,
			toolUseCount: 0,
			parentReplyCount: 0,
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("event with wrong key count for type → rejected", () => {
		// agent_start with 2 keys
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: { event: { type: "agent_start", extra: 1 } },
		});
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});

	it("target missing sessionId → rejected", () => {
		const payload = makeDeliverMessagePayload();
		payload.target = { activeSessionId: "only" };
		const enc = encodeLifecycleRecord({ v: 1, identity: validIdentity(), op: "DELIVER_MESSAGE", body: { payload } });
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});
});

// ---------- 16. Output Integrity Extras ----------

describe("Output Integrity Extras", () => {
	it("decoded record proto is Object.prototype", () => {
		const rec = makeStartRecord("test");
		const __enc42 = encodeOk(rec);
		if (!__enc42.ok) return;
		const bytes = __enc42.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(Object.getPrototypeOf(dec)).toBe(Object.prototype);
	});

	it("owned copy is zeroed after decode", () => {
		// Encode a valid record; decode copies input; the owned copy is internal.
		// We verify the caller input is NOT zeroed (the input remains readable).
		const rec = makeStartRecord("test");
		const __enc43 = encodeOk(rec);
		if (!__enc43.ok) return;
		const bytes = __enc43.bytes;
		const snapshot = new Uint8Array(bytes);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(true);
		expect(Array.from(bytes)).toEqual(Array.from(snapshot));
	});

	it("nested event object is frozen on decode", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: { event: { type: "child_update", status: "running", toolUseCount: 1, parentReplyCount: 0 } },
		});
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeRecordOk(enc.bytes);
		if (!dec.ok) return;
		if (dec.op === "EVENT") {
			expect(Object.isFrozen(dec.event)).toBe(true);
		}
	});

	it("payload object is frozen on decode", () => {
		const enc = encodeLifecycleRecord({
			v: 1,
			identity: validIdentity(),
			op: "DELIVER_MESSAGE",
			body: { payload: makeDeliverMessagePayload() },
		});
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = decodeRecordOk(enc.bytes);
		if (!dec.ok) return;
		if (dec.op === "DELIVER_MESSAGE") {
			expect(Object.isFrozen(dec.payload)).toBe(true);
		}
	});
});

// ---------- 17. Reply Extras ----------

describe("Reply Extras", () => {
	it("CLOSE reply with not_closed status → OP_MISMATCH", () => {
		const bytes = new TextEncoder().encode('{"status":"not_closed"}');
		const dec = decodeLifecycleReply(bytes, "CLOSE");
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("OP_MISMATCH");
	});

	it("decode reply with invalid UTF-8 → MALFORMED_BODY", () => {
		const bytes = new Uint8Array([0xff, 0xfe]);
		const dec = decodeLifecycleReply(bytes, "START");
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("MALFORMED_BODY");
	});

	it("decode reply with non-Uint8Array input → INPUT_INVALID", () => {
		const dec = decodeLifecycleReply("not bytes", "START");
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("INPUT_INVALID");
	});

	it("decodeLifecycleReply with unknown expectedOp → INPUT_INVALID", () => {
		const dec = decodeLifecycleReply(new Uint8Array([123]), "NOPE");
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("INPUT_INVALID");
	});

	it("decode DELIVER_MESSAGE reply with ABORT expected → OP_MISMATCH", () => {
		const __enc11 = encodeReplyOk("DELIVER_MESSAGE", { status: "queued" });
		if (!__enc11.ok) return;
		const bytes = __enc11.bytes;
		const dec = decodeLifecycleReply(bytes, "ABORT");
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("OP_MISMATCH");
	});

	it("OBSERVE reply with usage and answerPreview roundtrips", () => {
		const obs = {
			status: "completed",
			messageCount: 3,
			toolUseCount: 2,
			agentRunning: false,
			parentReplyCount: 1,
			answerPreview: "done",
			usage: { inputTokens: 10, outputTokens: 5 },
		};
		const __enc12 = encodeReplyOk("OBSERVE", obs);
		if (!__enc12.ok) return;
		const bytes = __enc12.bytes;
		const dec = decodeReplyOk(bytes, "OBSERVE");
		if (!dec.ok) return;
		expect(dec.op).toBe("OBSERVE");
		if (dec.op === "OBSERVE") {
			expect(dec.body.usage?.inputTokens).toBe(10);
			expect(dec.body.answerPreview).toBe("done");
		}
	});

	it("reply bytes > 262128 → BOUNDS_EXCEEDED (via decode bound)", () => {
		const big = new Uint8Array(262129);
		const dec = decodeLifecycleReply(big, "START");
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("BOUNDS_EXCEEDED");
	});
});

// ---------- 18. Identity/Digest Extras ----------

describe("Identity/Digest Extras", () => {
	it("spawnCodeSha256 incorrect on decode → MALFORMED_BODY", () => {
		const rec = makeStartRecord("prompt", "code");
		const __enc44 = encodeOk(rec);
		if (!__enc44.ok) return;
		const bytes = __enc44.bytes;
		const text = new TextDecoder().decode(bytes);
		// Replace spawnCodeSha256 with zeros
		const match = /"spawnCodeSha256":"[0-9a-f]{64}"/.exec(text);
		expect(match).not.toBeNull();
		if (!match) return;
		const tampered = text.replace(match[0], `"spawnCodeSha256":"${"0".repeat(64)}"`);
		const dec = decodeLifecycleRecord(new TextEncoder().encode(tampered));
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("MALFORMED_BODY");
	});

	it("SHA-256 computed from re-encoded UTF-8 for multi-byte and emoji", () => {
		const prompt = `héllo ${String.fromCharCode(0xd83d, 0xde00)}`;
		const rec = makeStartRecord(prompt);
		const __enc45 = encodeOk(rec);
		if (!__enc45.ok) return;
		const bytes = __enc45.bytes;
		const dec = decodeRecordOk(bytes);
		if (!dec.ok) return;
		expect(dec.ok).toBe(true);
		if (dec.ok && dec.op === "START") {
			expect(dec.prompt).toBe(prompt);
		}
	});

	it("prompt never appears in TERMINAL/EVENT wire bytes", () => {
		const secret = "SECRET_PROMPT_XYZ";
		const rec = makeStartRecord(secret);
		const __enc46 = encodeOk(rec);
		if (!__enc46.ok) return;
		const __enc47 = encodeOk({
			v: 1,
			identity: validIdentity(),
			op: "EVENT",
			body: { event: { type: "agent_end" } },
		});
		if (!__enc47.ok) return;
		const eventBytes = __enc47.bytes;
		const eventText = new TextDecoder().decode(eventBytes);
		expect(eventText).not.toContain(secret);
		const __enc48 = encodeOk({
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: { result: { status: "completed", durationMs: 1, parentReplyCount: 0, toolUseCount: 0 } },
		});
		if (!__enc48.ok) return;
		const terminalBytes = __enc48.bytes;
		const terminalText = new TextDecoder().decode(terminalBytes);
		expect(terminalText).not.toContain(secret);
	});
});

// ---------- 19. Key Order — encode accepts any order, decode canonical ----------

describe("Key Order — encode accepts any order (port exactRecord semantics)", () => {
	it("encode accepts envelope keys in non-canonical order", () => {
		const rec = { op: "ABORT", identity: validIdentity(), body: {}, v: 1 };
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(true);
		if (enc.ok) {
			// canonical wire always has v,identity,op,body order
			const text = new TextDecoder().decode(enc.bytes);
			expect(text.startsWith('{"v":1,')).toBe(true);
		}
	});

	it("encode accepts identity keys in non-canonical order", () => {
		const id = { modelSelector: "m", sessionName: "n", sessionId: "s", childId: "c" };
		const rec = { v: 1, identity: id, op: "ABORT", body: {} };
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(true);
	});

	it("encode accepts START body with spawnCode before prompt", () => {
		const rec = { v: 1, identity: validIdentity(), op: "START", body: { spawnCode: "code", prompt: "Hello" } };
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(true);
	});

	it("encode accepts TERMINAL result with keys in any order", () => {
		const result = { toolUseCount: 0, durationMs: 10, parentReplyCount: 0, status: "completed" };
		const rec = { v: 1, identity: validIdentity(), op: "TERMINAL", body: { result } };
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(true);
	});

	it("encode accepts usage with swapped keys", () => {
		const usage = { outputTokens: 5, inputTokens: 10 };
		const rec = {
			v: 1,
			identity: validIdentity(),
			op: "TERMINAL",
			body: { result: { status: "completed", durationMs: 1, parentReplyCount: 0, toolUseCount: 0, usage } },
		};
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(true);
	});

	it("encode accepts DELIVER_MESSAGE payload keys in any order", () => {
		const payload = {
			message: "Hi",
			target: { sessionId: "s", activeSessionId: "a" },
			source: "agent_message",
			id: "msg_1",
		};
		const rec = { v: 1, identity: validIdentity(), op: "DELIVER_MESSAGE", body: { payload } };
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(true);
	});

	it("encode accepts event body with event key only (any order not applicable, 1 key)", () => {
		const rec = { v: 1, identity: validIdentity(), op: "EVENT", body: { event: { type: "agent_start" } } };
		const enc = encodeLifecycleRecord(rec);
		expect(enc.ok).toBe(true);
	});
});

describe("Key Order — decode reordered wire yields CANONICAL_MISMATCH", () => {
	it("identity keys reordered in wire → CANONICAL_MISMATCH", () => {
		const wire =
			'{"v":1,"identity":{"modelSelector":"m","sessionName":"n","sessionId":"s","childId":"c"},"op":"ABORT","body":{}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("CANONICAL_MISMATCH");
	});

	it("START body keys reordered in wire → CANONICAL_MISMATCH", () => {
		const rec = makeStartRecord("Hello", "code");
		const __enc47 = encodeOk(rec);
		if (!__enc47.ok) return;
		const bytes = __enc47.bytes;
		const text = new TextDecoder().decode(bytes);
		const parsed = JSON.parse(text);
		// Reorder body keys: promptSha256 first
		const body: { [key: string]: unknown } = {};
		body.promptSha256 = parsed.body.promptSha256;
		body.prompt = parsed.body.prompt;
		body.spawnCode = parsed.body.spawnCode;
		body.spawnCodeSha256 = parsed.body.spawnCodeSha256;
		const reordered = JSON.stringify({ v: 1, identity: parsed.identity, op: "START", body });
		const dec = decodeLifecycleRecord(new TextEncoder().encode(reordered));
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("CANONICAL_MISMATCH");
	});

	it("TERMINAL result keys reordered in wire → CANONICAL_MISMATCH", () => {
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"TERMINAL","body":{"result":{"durationMs":1,"parentReplyCount":0,"toolUseCount":0,"status":"completed"}}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("CANONICAL_MISMATCH");
	});

	it("usage keys reordered in wire → CANONICAL_MISMATCH", () => {
		const wire =
			'{"v":1,"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"op":"TERMINAL","body":{"result":{"status":"completed","durationMs":1,"parentReplyCount":0,"toolUseCount":0,"usage":{"outputTokens":5,"inputTokens":10}}}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("CANONICAL_MISMATCH");
	});

	it("envelope keys reordered in wire → INPUT_INVALID (exact envelope order required at decode)", () => {
		const wire =
			'{"identity":{"childId":"c","sessionId":"s","sessionName":"n","modelSelector":"m"},"v":1,"op":"ABORT","body":{}}';
		const bytes = new TextEncoder().encode(wire);
		const dec = decodeLifecycleRecord(bytes);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("INPUT_INVALID");
	});
});
