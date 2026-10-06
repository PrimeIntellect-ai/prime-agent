#!/usr/bin/env node
/**
 * Golden corpus harness for the cloud session wire protocol (pa-types).
 *
 * Runs the REAL TypeScript protocol.ts (TS `origin/feat/direct-cloud-sandbox
 * @ 193d42bf`, the pin recorded in corpus.json) and records:
 *   - canonical bytes + digests for valid frames, requests, and events,
 *   - exact problem strings for invalid cases,
 * so the Rust port (`tests/cloud_protocol_golden.rs`) can assert
 * byte-identical parity. Two runs produce an identical corpus file.
 *
 * Usage:
 *   CLOUD_PROTOCOL_TS=/path/to/protocol.ts node harness.mjs
 * The TS source can be extracted from any checkout of this repo's shared
 * history:
 *   git show 193d42bf:packages/coding-agent/src/core/cloud/protocol.ts \
 *     > /tmp/cloud-protocol.ts
 * The recording hashes the exact TS source bytes into the corpus provenance
 * (`sourceSha256`); the Rust golden test pins that digest, so a corpus
 * recorded against a drifted source fails the parity gate instead of
 * silently claiming the pin.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tsPath = process.env.CLOUD_PROTOCOL_TS ?? "/tmp/cloud-protocol.ts";
const tsSource = fs.readFileSync(tsPath);
const tsSourceSha256 = createHash("sha256").update(tsSource).digest("hex");
const protocol = await import(tsPath);
const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "corpus.json");

const FRAME_CAPS = [
	"event_stream",
	"command_receipts",
	"session_entries",
	"session_events",
	"roster_stream",
	"family_messages",
	"extension_ui",
	"artifact_refs",
];
const RECEIPT = {
	commandId: "cmd_1",
	digest: "sha256:e7dfe480c4463263a93755ec83d15829b19df0698e8b764baa4b5e9a3d7bc727",
	state: "accepted",
	submittedAt: "2026-09-29T00:00:00.000Z",
	updatedAt: "2026-09-29T00:00:00.001Z",
	uncertain: false,
};
const RECEIPT_DONE = { ...RECEIPT, commandId: "cmd_9", state: "completed", result: "ok" };

// ---------------------------------------------------------------- valid frames

function hello({ version = 3, generation = 1, cursor, caps } = {}) {
	const frame = {
		type: "hello",
		protocolVersion: version,
		generation,
		clientId: "client_1",
		sessionId: "sess_1",
	};
	if (cursor) frame.cursor = cursor;
	if (caps) frame.capabilities = caps;
	return frame;
}

const frames = [
	{
		name: "hello_min",
		value: hello(),
	},
	{
		name: "hello_full",
		value: hello({
			generation: 2,
			cursor: { generation: 2, sequence: 7 },
			caps: FRAME_CAPS,
		}),
	},
	{
		name: "hello_auth",
		value: { ...hello(), authToken: "tok_1" },
	},
	{
		name: "snapshot_minimal_bounds",
		value: {
			type: "snapshot",
			sessionId: "sess_1",
			generation: 2,
			cursor: { generation: 2, sequence: 0 },
			status: "idle",
			state: { cwd: "", modelId: "m", queuedCommandIds: [] },
			events: [],
		},
	},
	{
		name: "snapshot_min",
		value: {
			type: "snapshot",
			sessionId: "sess_1",
			generation: 2,
			cursor: { generation: 2, sequence: 0 },
			status: "idle",
			state: { cwd: "/work", modelId: "prime-inference/internal/glm-5.3-fast", queuedCommandIds: [] },
			events: [],
		},
	},
	{
		name: "snapshot_all_events",
		value: {
			type: "snapshot",
			sessionId: "sess_1",
			generation: 2,
			cursor: { generation: 2, sequence: 12 },
			status: "busy",
			state: { cwd: "/work", modelId: "m/x", activeCommandId: "cmd_1", queuedCommandIds: ["cmd_2", "cmd_3"] },
			events: [
				{ sequence: 1, kind: "command_accepted", recordedAt: "t", receipt: RECEIPT },
				{ sequence: 2, kind: "command_state", recordedAt: "t", receipt: RECEIPT_DONE },
				{ sequence: 3, kind: "session_status", recordedAt: "t", status: "busy" },
				{ sequence: 4, kind: "output_delta", recordedAt: "t", taskId: "task_1", stream: "stdout", text: "chunk" },
				{ sequence: 5, kind: "output_delta", recordedAt: "t", taskId: "task_1", stream: "stderr", text: "" },
				{
					sequence: 6,
					kind: "session_entry",
					recordedAt: "t",
					sessionId: "remote_1",
					entryId: "entry_1",
					entry: { type: "message", id: "m1", parentId: null, timestamp: "t", role: "user" },
					artifacts: [{ path: "art://big", sha256: RECEIPT.digest, bytes: 262_145 }],
				},
				{ sequence: 7, kind: "session_event", recordedAt: "t", sessionId: "remote_1", event: { type: "tool_call", name: "bash" } },
				{
					sequence: 8,
					kind: "session_meta",
					recordedAt: "t",
					sessionId: "remote_1",
					streaming: true,
					runningTools: 1,
					queue: 0,
					recap: "working",
					taskState: "needs_input",
					model: "prime-inference/internal/glm-5.3-fast",
					connectivityHints: ["tunnel down"],
				},
				{
					sequence: 9,
					kind: "roster_delta",
					recordedAt: "t",
					rows: [{ childId: "rlm_1", parentRemoteId: "remote_1", name: "worker", status: "running", depth: 1, preview: "step 2" }],
				},
				{
					sequence: 10,
					kind: "child_update",
					recordedAt: "t",
					childId: "rlm_1",
					status: "completed",
					answerPreview: "done",
					sessionFile: "/shadows/remote-child.jsonl",
					model: "openai/gpt-5.5",
				},
				{ sequence: 11, kind: "usage", recordedAt: "t", sessionId: "remote_1", totals: { inputTokens: 120, outputTokens: 80, cachedTokens: 64, requests: 2 }, revision: 1 },
				{ sequence: 12, kind: "family_roster_request", recordedAt: "t", requestId: "famreq_1", fromRemoteSessionId: "remote_root" },
			],
			capabilities: ["event_stream", "session_entries"],
		},
	},
	{
		name: "subscribe",
		value: { type: "subscribe", sessionId: "sess_1", cursor: { generation: 1, sequence: 3 } },
	},
	{
		name: "events_frame",
		value: {
			type: "events",
			sessionId: "sess_1",
			generation: 1,
			events: [
				{ sequence: 4, kind: "session_status", recordedAt: "t", status: "busy" },
				{ sequence: 5, kind: "child_update", recordedAt: "t", childId: "rlm_1", status: "queued" },
			],
		},
	},
	{
		name: "get_command_poll_next",
		value: { type: "get_command", sessionId: "sess_1", generation: 1 },
	},
	{
		name: "get_command_poll_one",
		value: { type: "get_command", sessionId: "sess_1", generation: 1, commandId: "cmd_1" },
	},
	{
		name: "get_command_claim",
		value: { type: "get_command", sessionId: "sess_1", generation: 1, claim: true },
	},
	{
		name: "command_receipt",
		value: { type: "command", sessionId: "sess_1", generation: 1, receipt: RECEIPT },
	},
	{
		name: "command_claim_handoff",
		value: { type: "command", sessionId: "sess_1", generation: 1, receipt: RECEIPT, request: '{"kind":"prompt","text":"hi"}' },
	},
	{
		name: "ack",
		value: { type: "ack", sessionId: "sess_1", cursor: { generation: 1, sequence: 9 } },
	},
	{
		name: "inference_request",
		value: {
			type: "inference_request",
			sessionId: "sess_1",
			remoteSessionId: "remote_1",
			requestId: "inf_1",
			model: { provider: "prime-inference", modelId: "internal/glm-5.3-fast" },
			thinking: "high",
			payload: { messages: [{ role: "user", content: "hi" }], options: { temperature: 0.5 } },
		},
	},
	{
		name: "inference_request_min",
		value: {
			type: "inference_request",
			sessionId: "sess_1",
			remoteSessionId: "remote_1",
			requestId: "inf_1",
			model: { provider: "openai", modelId: "gpt-5.5" },
			payload: { messages: [] },
		},
	},
	{
		name: "inference_event",
		value: { type: "inference_event", sessionId: "sess_1", requestId: "inf_1", event: { type: "message_start" } },
	},
	{
		name: "inference_end",
		value: { type: "inference_end", sessionId: "sess_1", requestId: "inf_1", message: { role: "assistant", content: "done" } },
	},
	{
		name: "inference_error_empty",
		value: { type: "inference_error", sessionId: "sess_1", requestId: "inf_1", error: "" },
	},
	{
		name: "inference_error",
		value: { type: "inference_error", sessionId: "sess_1", requestId: "inf_1", error: "rate limited" },
	},
];

// --------------------------------------------------------------- valid requests

function submit(request) {
	return {
		type: "submit",
		sessionId: "sess_1",
		generation: 1,
		commandId: "cmd_1",
		request,
		digest: protocol.cloudRequestDigest(request),
	};
}

const requests = [
	{ name: "open_session_min", value: { kind: "open_session", cwd: "/work" } },
	{
		name: "open_session_full",
		value: {
			kind: "open_session",
			cwd: "/work",
			model: "prime-inference/internal/glm-5.3-fast",
			thinking: "high",
			seedTranscriptArtifact: "art://seed",
			prompt: "start the session",
			family: { depth: 1, parentSessionId: "sess_local", parentSessionFile: "/sessions/local.jsonl", parentName: "root" },
			modelMetadata: { name: "GLM 5.3", contextWindow: 128000, maxTokens: 16384, reasoning: true },
		},
	},
	{ name: "prompt", value: { kind: "prompt", text: "hi", queueIfBusy: true, targetSessionId: "remote_child" } },
	{ name: "steer", value: { kind: "steer", text: "stop" } },
	{ name: "follow_up", value: { kind: "follow_up", text: "more" } },
	{ name: "abort", value: { kind: "abort" } },
	{
		name: "send_message",
		value: {
			kind: "send_message",
			targetRemoteSessionId: "remote_child",
			message: "status update",
			messageId: "agentmsg_9",
			from: { activeSessionId: "act_1", sessionId: "sess_1", sessionName: "root", runtimeKind: "top-level" },
			fromRelationship: "child",
		},
	},
	{ name: "set_model", value: { kind: "set_model", provider: "prime-inference", modelId: "internal/glm-5.3-fast" } },
	{ name: "set_thinking_level", value: { kind: "set_thinking_level", level: "high" } },
	{ name: "set_session_name", value: { kind: "set_session_name", name: "worker" } },
	{ name: "compact", value: { kind: "compact", customInstructions: "keep the plan" } },
	{ name: "cancel_child", value: { kind: "cancel_child", childId: "rlm_1" } },
	{ name: "delete_child", value: { kind: "delete_child", childId: "rlm_1" } },
	{
		name: "extension_ui_response",
		value: { kind: "extension_ui_response", requestId: "ext_1", response: { choice: "ok", depth: 2 }, targetSessionId: "remote_child" },
	},
	{ name: "release", value: { kind: "release" } },
	{
		name: "family_roster_result",
		value: { kind: "family_roster_result", requestId: "famreq_1", entries: [{ id: "sess_local", depth: 0, status: "running" }] },
	},
	{
		name: "agent_message_result_ok",
		value: { kind: "agent_message_result", requestId: "msgreq_1", ok: true, receipt: { id: "agentmsg_9", deliveryStatus: "delivered" } },
	},
	// The wire domain of a receipt is any canonical-JSON object: the empty
	// object is protocol-valid (the validator requires only ok/receipt
	// pairing, objectness, canonicalizability, and the size cap — never
	// the deliverer's id/deliveryStatus fields), so the Rust typed carrier
	// must deserialize it too.
	{
		name: "agent_message_result_ok_empty_receipt",
		value: { kind: "agent_message_result", requestId: "msgreq_5", ok: true, receipt: {} },
	},
	{ name: "agent_message_result_err", value: { kind: "agent_message_result", requestId: "msgreq_2", ok: false, error: "unknown target" } },
];

// Submit frames carrying requests (digest parity through the frame).
// submit() needs cloudRequestDigest, so these are built after the requests.
const submitFrames = [];
{
	const openSessionFull = {
	kind: "open_session",
	cwd: "/work",
	model: "prime-inference/internal/glm-5.3-fast",
	thinking: "high",
	seedTranscriptArtifact: "art://seed",
	prompt: "start the session",
	family: { depth: 1, parentSessionId: "sess_local", parentSessionFile: "/sessions/local.jsonl", parentName: "root" },
	modelMetadata: { name: "GLM 5.3", contextWindow: 128000, maxTokens: 16384, reasoning: true },
};
	submitFrames.push({ name: "submit_prompt", value: submit({ kind: "prompt", text: "hi" }) });
	submitFrames.push({ name: "submit_open_session", value: submit(openSessionFull) });
	submitFrames.push({
		name: "submit_send_message",
		value: submit({
			kind: "send_message",
			targetRemoteSessionId: "remote_child",
			message: "status update",
			messageId: "agentmsg_9",
			from: { activeSessionId: "act_1", sessionId: "sess_1", sessionName: "root", runtimeKind: "top-level" },
			fromRelationship: "child",
		}),
	});
	// UTF-16 key order through the full submit path: the digest covers the
	// astral key before the private-use key, and the serialized frame pins
	// the exact canonical bytes.
	submitFrames.push({
		name: "submit_utf16_keys",
		value: submit({
			kind: "extension_ui_response",
			requestId: "ext_1",
			response: { a: 0, "\uE000": 1, "\uD800\uDC00": 2 },
			targetSessionId: "remote_child",
		}),
	});
}

// JS-number parity: raw JSON whose number literals exercise String(number)
// rendering. Recorded as rawJson so the corpus keeps the literal forms.
const numberCases = [
	'{"kind":"extension_ui_response","requestId":"ext_1","response":{"integral_float":2.0,"half":0.5,"neg_zero":-0,"expo_hi":1e21,"expo_lo":1e-7,"plain_big":1e20,"beyond_2_53":9007199254740993,"neg_beyond_2_53":-9007199254740993,"pi":3.14159}}',
	'{"kind":"prompt","text":"numbers stay flat inside strings: 2.0 -0 1e21"}',
	// JS sorts object keys by UTF-16 code units, not by scalar value: the
	// astral key (surrogates D800 DC00) sorts before the private-use key
	// (E000) and after the ASCII key, so the canonical bytes and the
	// request digest pin that exact order.
	'{"kind":"extension_ui_response","requestId":"ext_1","response":{"a":0,"\\uE000":1,"\\uD800\\uDC00":2}}',
];

// Raw wire spellings TS accepts: integral floats (1.0, 1e0) and integer
// literals beyond i64/beyond 2^53, which JSON.parse stores as doubles.
// Recorded as raw JSON strings (JSON.stringify would re-render a JS value
// and lose the spellings) with the canonical bytes the TS side serializes.
const rawParses = [
	{ name: "hello_float_spellings", rawJson: '{"type":"hello","protocolVersion":3.0,"generation":1.0,"clientId":"c","sessionId":"s"}' },
	{ name: "hello_exponent_spellings", rawJson: '{"type":"hello","protocolVersion":3e0,"generation":1e0,"clientId":"c","sessionId":"s"}' },
	{ name: "hello_cursor_floats", rawJson: '{"type":"hello","protocolVersion":3,"generation":2.0,"clientId":"c","sessionId":"s","cursor":{"generation":2.0,"sequence":7.0}}' },
	{ name: "hello_generation_beyond_i64", rawJson: '{"type":"hello","protocolVersion":3,"generation":9223372036854775808,"clientId":"c","sessionId":"s"}' },
	{ name: "hello_generation_beyond_2_53", rawJson: '{"type":"hello","protocolVersion":3,"generation":9007199254740993,"clientId":"c","sessionId":"s"}' },
	{
		name: "submit_generation_exponent",
		rawJson: `{"type":"submit","sessionId":"s","generation":1e0,"commandId":"c","request":{"kind":"prompt","text":"hi"},"digest":"${protocol.cloudRequestDigest({ kind: "prompt", text: "hi" })}"}`,
	},
	{ name: "events_frame_floats", rawJson: '{"type":"events","sessionId":"s","generation":1e0,"events":[{"sequence":1.0,"kind":"session_status","recordedAt":"t","status":"idle"},{"sequence":2.0,"kind":"session_status","recordedAt":"t","status":"busy"}]}' },
	{ name: "session_meta_floats", rawJson: '{"type":"events","sessionId":"s","generation":1,"events":[{"sequence":1.0,"kind":"session_meta","recordedAt":"t","sessionId":"r","streaming":true,"runningTools":2.0,"queue":-0.0}]}' },
];

// TS accepts every integral JS number the validators see; the Rust typed
// layer holds u64 and refuses (never saturates or wraps) integral doubles
// above 2^64 - 2^11. Recorded as the DOCUMENTED typed-domain divergence:
// the TS side's ok + serialized bytes are the runtime evidence, and the
// Rust golden test pins the exact Rust rejection separately.
const divergentParses = [
	{ name: "hello_generation_1e20", rawJson: '{"type":"hello","protocolVersion":3,"generation":1e20,"clientId":"c","sessionId":"s"}' },
	{ name: "hello_generation_1e21", rawJson: '{"type":"hello","protocolVersion":3,"generation":1e21,"clientId":"c","sessionId":"s"}' },
	{
		name: "session_meta_running_tools_1e20",
		rawJson: '{"type":"events","sessionId":"s","generation":1,"events":[{"sequence":1,"kind":"session_meta","recordedAt":"t","sessionId":"r","streaming":true,"runningTools":1e20,"queue":0}]}',
	},
];

// ---------------------------------------------------------------- valid events

const events = [
	{ name: "command_accepted", value: { sequence: 1, kind: "command_accepted", recordedAt: "t", receipt: RECEIPT } },
	{ name: "command_state_terminal", value: { sequence: 1, kind: "command_state", recordedAt: "t", receipt: RECEIPT_DONE } },
	{ name: "session_status", value: { sequence: 1, kind: "session_status", recordedAt: "t", status: "starting" } },
	{ name: "output_delta_empty", value: { sequence: 1, kind: "output_delta", recordedAt: "t", taskId: "task_1", stream: "stdout", text: "" } },
	{
		name: "session_entry_parent_null",
		value: { sequence: 1, kind: "session_entry", recordedAt: "t", sessionId: "remote_1", entryId: "entry_1", entry: { type: "message", id: "m1", parentId: null, timestamp: "t" } },
	},
	{ name: "session_event", value: { sequence: 1, kind: "session_event", recordedAt: "t", sessionId: "remote_1", event: { type: "tool_call", name: "bash" } } },
	{ name: "session_meta_min", value: { sequence: 1, kind: "session_meta", recordedAt: "t", sessionId: "remote_1", streaming: false, runningTools: 0, queue: 0 } },
	{ name: "roster_delta", value: { sequence: 1, kind: "roster_delta", recordedAt: "t", rows: [] } },
	{ name: "child_update", value: { sequence: 1, kind: "child_update", recordedAt: "t", childId: "rlm_1", status: "queued" } },
	{ name: "usage_no_cache", value: { sequence: 1, kind: "usage", recordedAt: "t", sessionId: "remote_1", totals: { inputTokens: 1, outputTokens: 2, requests: 3 }, revision: 0 } },
	{ name: "family_roster_request", value: { sequence: 1, kind: "family_roster_request", recordedAt: "t", requestId: "famreq_1", fromRemoteSessionId: "remote_root" } },
	{ name: "agent_message_request", value: { sequence: 1, kind: "agent_message_request", recordedAt: "t", requestId: "msgreq_1", fromRemoteSessionId: "remote_child", targetSelector: "sibling-worker", message: "status update" } },
	// UTF-16 bounds: 64 astral chars = 128 units, exactly at the selector cap.
	{
		name: "agent_message_request_astral_bound",
		value: { sequence: 1, kind: "agent_message_request", recordedAt: "t", requestId: "msgreq_2", fromRemoteSessionId: "remote_child", targetSelector: "\u{1F600}".repeat(64), message: "m" },
	},
];

// --------------------------------------------------------------- invalid cases

const invalid = [];
function caseAt(validator, value, rawJson) {
	invalid.push({ validator, value, rawJson });
}

// message-level
caseAt("message", "not an object");
caseAt("message", { type: "nope" });
caseAt("message", {});
caseAt("message", { type: "hello" });
caseAt("message", { type: "hello", protocolVersion: 4, generation: 1, clientId: "c", sessionId: "s" });
caseAt("message", { type: "hello", protocolVersion: 2.5, generation: 1, clientId: "c", sessionId: "s" });
caseAt("message", { type: "hello", protocolVersion: 3, generation: 0, clientId: "c", sessionId: "s" });
caseAt("message", { type: "hello", protocolVersion: 3, generation: 1, clientId: "", sessionId: "s" });
caseAt("message", { type: "hello", protocolVersion: 3, generation: 1, clientId: "c", sessionId: "s", extra: 1 });
caseAt("message", { type: "hello", protocolVersion: 3, generation: 1, clientId: "c", sessionId: "s", authToken: "" });
caseAt("message", { type: "hello", protocolVersion: 3, generation: 2, clientId: "c", sessionId: "s", cursor: { generation: 3, sequence: 0 } });
caseAt("message", { type: "hello", protocolVersion: 3, generation: 1, clientId: "c", sessionId: "s", cursor: { generation: 1, sequence: -1 } });
caseAt("message", { type: "hello", protocolVersion: 3, generation: 1, clientId: "c", sessionId: "s", capabilities: "event_stream" });
caseAt("message", { type: "hello", protocolVersion: 3, generation: 1, clientId: "c", sessionId: "s", capabilities: ["nope"] });
caseAt("message", { type: "hello", protocolVersion: 3, generation: 1, clientId: "c", sessionId: "s", capabilities: [...FRAME_CAPS, ...FRAME_CAPS, "event_stream"] });
caseAt("message", { type: "snapshot", sessionId: "s", generation: 1, cursor: { generation: 1, sequence: 0 }, status: "idle", state: { cwd: "/w", modelId: "m" }, events: [] });
caseAt("message", { type: "snapshot", sessionId: "s", generation: 1, cursor: { generation: 1, sequence: 0 }, status: "idle", state: {}, events: [] });
caseAt("message", { type: "snapshot", sessionId: "s", generation: 1, cursor: { generation: 1, sequence: 0 }, status: "idle", state: { cwd: "/w", modelId: "m", queuedCommandIds: "x" }, events: [] });
caseAt("message", { type: "snapshot", sessionId: "s", generation: 1, cursor: { generation: 1, sequence: 0 }, status: "idle", state: { cwd: "/w", modelId: "m", queuedCommandIds: [1] }, events: [] });
caseAt("message", { type: "snapshot", sessionId: "s", generation: 1, cursor: { generation: 1, sequence: 0 }, status: "nope", state: { cwd: "/w", modelId: "m", queuedCommandIds: [] }, events: [] });
caseAt("message", { type: "snapshot", sessionId: "s", generation: 1, cursor: { generation: 2, sequence: 0 }, status: "idle", state: { cwd: "/w", modelId: "m", queuedCommandIds: [] }, events: [] });
caseAt("message", { type: "snapshot", sessionId: "s", generation: 1, cursor: { generation: 1, sequence: 0 }, status: "idle", state: { cwd: "/w", modelId: "m", queuedCommandIds: [] }, events: [{ sequence: 1, kind: "session_status", recordedAt: "t", status: "idle" }] });
caseAt("message", { type: "snapshot", sessionId: "s", generation: 1, cursor: { generation: 1, sequence: 2 }, status: "idle", state: { cwd: "/w", modelId: "m", queuedCommandIds: [] }, events: [{ sequence: 1, kind: "session_status", recordedAt: "t", status: "idle" }, { sequence: 1, kind: "session_status", recordedAt: "t", status: "idle" }] });
caseAt("message", { type: "snapshot", sessionId: "s", generation: 1, cursor: { generation: 1, sequence: 0 }, status: "idle", state: { cwd: "x".repeat(4097), modelId: "m", queuedCommandIds: [] }, events: [] });
caseAt("message", { type: "subscribe", sessionId: "s", cursor: { generation: 1, sequence: -1 } });
caseAt("message", { type: "subscribe", sessionId: "s", cursor: null });
caseAt("message", { type: "events", sessionId: "s", generation: 1, events: {} });
caseAt("message", { type: "events", sessionId: "s", generation: 1, events: [{ sequence: 1, kind: "session_status", recordedAt: "t", status: "idle" }, { sequence: 1, kind: "session_status", recordedAt: "t", status: "idle" }] });
caseAt("message", { type: "submit", sessionId: "s", generation: 1, commandId: "c", request: { kind: "nope" }, digest: RECEIPT.digest });
caseAt("message", { type: "submit", sessionId: "s", generation: 1, commandId: "c", request: { kind: "prompt", text: "hi" }, digest: "sha256:00" });
caseAt("message", { type: "submit", sessionId: "s", generation: 1, commandId: "c", request: { kind: "prompt", text: "hi" }, digest: protocol.cloudDigest("not the request") });
caseAt("message", { type: "get_command", sessionId: "s", generation: 1, commandId: "c", claim: true });
caseAt("message", { type: "get_command", sessionId: "s", generation: 1, claim: "yes" });
caseAt("message", { type: "command", sessionId: "s", generation: 1, receipt: { ...RECEIPT, uncertain: "yes" } });
caseAt("message", { type: "command", sessionId: "s", generation: 1, receipt: RECEIPT, request: "{oops" });
caseAt("message", { type: "command", sessionId: "s", generation: 1, receipt: RECEIPT, request: '{"kind":"nope"}' });
caseAt("message", { type: "command", sessionId: "s", generation: 1, receipt: { ...RECEIPT, digest: "short" } });
caseAt("message", { type: "ack", sessionId: "s", cursor: { generation: 0, sequence: 1 } });
caseAt("message", { type: "inference_request", sessionId: "s", remoteSessionId: "r", requestId: "q", model: "m", payload: { messages: [] } });
caseAt("message", { type: "inference_request", sessionId: "s", remoteSessionId: "r", requestId: "q", model: { provider: "", modelId: "x".repeat(257) }, payload: { messages: [] } });
caseAt("message", { type: "inference_request", sessionId: "s", remoteSessionId: "r", requestId: "q", model: { provider: "p", modelId: "m" }, payload: {} });
caseAt("message", { type: "inference_request", sessionId: "s", remoteSessionId: "r", requestId: "q", model: { provider: "p", modelId: "m" }, payload: { messages: [], options: [] } });
caseAt("message", { type: "inference_request", sessionId: "s", remoteSessionId: "r", requestId: "q", model: { provider: "p", modelId: "m" }, thinking: "x".repeat(129), payload: { messages: [] } });
caseAt("message", { type: "inference_event", sessionId: "s", requestId: "q", event: [] });
caseAt("message", { type: "inference_end", sessionId: "s", requestId: "q", message: "not an object" });
caseAt("message", { type: "inference_error", sessionId: "s", requestId: "q", error: "x".repeat(2049) });

// event-level
caseAt("event", "not an object");
caseAt("event", { sequence: 0, recordedAt: "t", kind: "session_status", status: "idle" });
caseAt("event", { sequence: 1, kind: "session_status", status: "idle" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "nope" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_status", status: "paused" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_status", status: "idle", extra: true });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "output_delta", taskId: "", stream: "stdout", text: "" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "output_delta", taskId: "task_1", stream: "both", text: "" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "command_accepted", receipt: { ...RECEIPT, state: "nope" } });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "command_accepted", receipt: null });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "command_accepted" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_entry", sessionId: "r", entryId: "e", entry: "not an object" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_entry", sessionId: "r", entryId: "e", entry: { type: "", id: "m", timestamp: "t" } });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_entry", sessionId: "r", entryId: "e", entry: { type: "message", id: "m", parentId: 5, timestamp: "t" } });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_entry", sessionId: "r", entryId: "e", entry: { type: "message", id: "m", timestamp: "t" }, artifacts: "nope" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_entry", sessionId: "r", entryId: "e", entry: { type: "message", id: "m", timestamp: "t" }, artifacts: [{ path: "p", sha256: "nope", bytes: 1 }] });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_event", sessionId: "r", event: { type: "" } });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_event", sessionId: "r", event: "not an object" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_meta", sessionId: "r", streaming: "yes", runningTools: 0, queue: 0 });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_meta", sessionId: "r", streaming: true, runningTools: -1, queue: 0 });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_meta", sessionId: "r", streaming: true, runningTools: 0, queue: 0, taskState: "done" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_meta", sessionId: "r", streaming: true, runningTools: 0, queue: 0, connectivityHints: ["" ] });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "roster_delta", rows: "nope" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "roster_delta", rows: [{ childId: "c", status: "nope", depth: 0 }] });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "roster_delta", rows: [{ childId: "c", status: "queued", depth: 0, parentRemoteId: "" }] });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "child_update", childId: "c", status: "nope" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "child_update", childId: "c", status: "queued", model: "x".repeat(257) });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "usage", sessionId: "r", totals: { inputTokens: -1, outputTokens: 0, requests: 0 }, revision: 0 });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "usage", sessionId: "r", totals: { inputTokens: 0, outputTokens: 0, cachedTokens: -1, requests: 0 }, revision: 0 });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "usage", sessionId: "r", totals: { inputTokens: 0, outputTokens: 0, requests: 0 }, revision: -1 });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "agent_message_request", requestId: "f", fromRemoteSessionId: "r", targetSelector: "x".repeat(129), message: "m" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "family_roster_request", requestId: "", fromRemoteSessionId: "r" });

// request-level
caseAt("request", "not an object");
caseAt("request", { kind: "nope" });
caseAt("request", {});
caseAt("request", { kind: "open_session" });
caseAt("request", { kind: "open_session", cwd: "" });
caseAt("request", { kind: "open_session", cwd: "/w", extra: 1 });
caseAt("request", { kind: "open_session", cwd: "/w", model: "x".repeat(257) });
caseAt("request", { kind: "open_session", cwd: "/w", family: { depth: 0, parentSessionId: "p", parentSessionFile: "/p" } });
caseAt("request", { kind: "open_session", cwd: "/w", family: { depth: 1.5, parentSessionId: "p", parentSessionFile: "/p" } });
caseAt("request", { kind: "open_session", cwd: "/w", modelMetadata: { name: "n", contextWindow: 128000, maxTokens: 16384, reasoning: "yes" } });
caseAt("request", { kind: "open_session", cwd: "/w", modelMetadata: { name: "n", contextWindow: 0, maxTokens: 1, reasoning: true } });
caseAt("request", { kind: "prompt" });
caseAt("request", { kind: "prompt", text: "" });
caseAt("request", { kind: "prompt", text: "hi", queueIfBusy: "yes" });
caseAt("request", { kind: "steer", text: "" });
caseAt("request", { kind: "abort", extra: 1 });
caseAt("request", { kind: "release", why: "done" });
caseAt("request", { kind: "set_model", provider: "", modelId: "m" });
caseAt("request", { kind: "set_thinking_level", level: "x".repeat(65) });
caseAt("request", { kind: "set_session_name", name: "x".repeat(129) });
caseAt("request", { kind: "compact", customInstructions: "x".repeat(65_537) });
caseAt("request", { kind: "cancel_child", childId: "" });
caseAt("request", { kind: "delete_child" });
caseAt("request", { kind: "extension_ui_response", requestId: "r" });
caseAt("request", { kind: "extension_ui_response", requestId: "r", response: { deep: null } , targetSessionId: "x".repeat(129) });
caseAt("request", { kind: "family_roster_result", requestId: "f", entries: [{ id: "a", depth: 0, status: "nope" }] });
caseAt("request", { kind: "agent_message_result", requestId: "f", ok: true });
caseAt("request", { kind: "send_message", targetRemoteSessionId: "r", message: "m", fromRelationship: "cousin" });
caseAt("request", { kind: "prompt", text: "hi", targetSessionId: "" });

// requestJson-level (public helper, callable on any value)
caseAt("requestJson", { kind: "prompt", text: "x".repeat(200_000) });

// parse-level (wire strings; the not-valid-JSON reason is engine-specific,
// recorded here only for the prefix)
caseAt("parse", null, "{nope");
caseAt("parse", null, '{"type":"hello"}');

// serialize-level (invalid message -> throw with the invalid-cloud-message
// prefix; deep entry -> canonical depth throw)
caseAt("serialize", { type: "events", sessionId: "s", generation: 1, events: [{ sequence: 1, kind: "session_status", recordedAt: "t", status: "idle" }, { sequence: 1, kind: "session_status", recordedAt: "t", status: "idle" }] });
let deep = { bottom: true };
for (let i = 0; i < 61; i++) deep = { a: deep };
deep = { type: "deep", a: deep };
caseAt("serialize", {
	type: "events",
	sessionId: "s",
	generation: 1,
	events: [{ sequence: 1, kind: "session_event", recordedAt: "t", sessionId: "r", event: deep }],
});

// id-level
caseAt("id", "");
caseAt("id", "x".repeat(129));
caseAt("id", 5);

// strict hex digests: TS isCloudDigest is [0-9a-f]{64}, so g-z and
// uppercase spellings are invalid wherever a digest appears
caseAt("message", { type: "submit", sessionId: "s", generation: 1, commandId: "c", request: { kind: "prompt", text: "hi" }, digest: `sha256:${"g".repeat(64)}` });
caseAt("message", { type: "command", sessionId: "s", generation: 1, receipt: { ...RECEIPT, digest: `sha256:${"g".repeat(64)}` } });
caseAt("message", { type: "command", sessionId: "s", generation: 1, receipt: { ...RECEIPT, digest: RECEIPT.digest.toUpperCase() } });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_entry", sessionId: "r", entryId: "e", entry: { type: "message", id: "m", timestamp: "t" }, artifacts: [{ path: "p", sha256: `sha256:${"g".repeat(64)}`, bytes: 1 }] });

// missing submit.request: the request validator runs on the absent value
// (this digest is the canonical digest of `null`, so only the request
// check catches the frame)
caseAt("message", { type: "submit", sessionId: "s", generation: 1, commandId: "c", digest: protocol.cloudDigest("null") });

// terminal newline is NOT a JS `$` edge: the ECMAScript `$` (no flags)
// matches only at InputLength, so an LF/CR-suffixed digest is a length-65
// digest and fails the shape check exactly like any other non-hex string
caseAt("message", { type: "command", sessionId: "s", generation: 1, receipt: { ...RECEIPT, digest: RECEIPT.digest + "\n" } });
caseAt("message", { type: "command", sessionId: "s", generation: 1, receipt: { ...RECEIPT, digest: RECEIPT.digest + "\r" } });
caseAt("message", { type: "submit", sessionId: "s", generation: 1, commandId: "c", request: { kind: "prompt", text: "hi" }, digest: protocol.cloudRequestDigest({ kind: "prompt", text: "hi" }) + "\n" });
caseAt("event", { sequence: 1, recordedAt: "t", kind: "session_entry", sessionId: "r", entryId: "e", entry: { type: "message", id: "m", timestamp: "t" }, artifacts: [{ path: "p", sha256: RECEIPT.digest + "\n", bytes: 1 }] });

// unexpected-field order: Object.keys yields array indices ascending
// first, then the remaining keys in insertion order (never sorted)
caseAt("message", { type: "hello", protocolVersion: 3, generation: 1, clientId: "c", sessionId: "s", zz: 1, aa: 2 });
caseAt("message", { type: "hello", protocolVersion: 3, generation: 1, clientId: "c", sessionId: "s", b: 1, 5: 2, 10: 3 });
caseAt("message", { type: "hello", protocolVersion: 3, generation: 1, clientId: "c", sessionId: "s", 4294967294: 1 });
caseAt("message", { type: "hello", protocolVersion: 3, generation: 1, clientId: "c", sessionId: "s", 4294967295: 1, zz: 2 });
caseAt("request", { kind: "prompt", text: "hi", zz: 1, aa: 2 });

// JS integer spellings the validators must reject, and float spellings
// that cross-check generation/cursor/sequence comparisons
caseAt("message", { type: "hello", protocolVersion: 3, generation: 0.5, clientId: "c", sessionId: "s" });
caseAt("message", { type: "hello", protocolVersion: 3, generation: 2, clientId: "c", sessionId: "s", cursor: { generation: 3.0, sequence: 0 } });
caseAt("message", { type: "events", sessionId: "s", generation: 1, events: [{ sequence: 2.0, kind: "session_status", recordedAt: "t", status: "idle" }, { sequence: 1.0, kind: "session_status", recordedAt: "t", status: "idle" }] });
caseAt("message", { type: "snapshot", sessionId: "s", generation: 1, cursor: { generation: 1, sequence: 3.0 }, status: "idle", state: { cwd: "/w", modelId: "m", queuedCommandIds: [] }, events: [{ sequence: 1.0, kind: "session_status", recordedAt: "t", status: "idle" }, { sequence: 2.0, kind: "session_status", recordedAt: "t", status: "idle" }] });
// NOTE: raw 1e400 is deliberately NOT recorded: V8's JSON.parse accepts it
// as Infinity and reports a validation problem, while serde_json refuses
// it at parse time ("number out of range"), so only the not-valid-JSON
// prefix class is engine-pinned, not a byte-identical replay.

// ------------------------------------------------------------------ record TS

const corpus = {
	provenance: {
		source: "packages/coding-agent/src/core/cloud/protocol.ts",
		commit: "193d42bf (origin/feat/direct-cloud-sandbox)",
		// SHA-256 over the exact TS source bytes this corpus was recorded
		// from; the Rust golden test pins it, so recording against a
		// drifted or mislabeled source fails the parity gate.
		sourceSha256: tsSourceSha256,
		sourceBytes: tsSource.byteLength,
		protocolVersion: protocol.CLOUD_PROTOCOL_VERSION,
		protocolName: protocol.CLOUD_PROTOCOL_NAME,
		recordedWith: "node " + process.version,
	},
	frames: [],
	requests: [],
	events: [],
	numbers: [],
	rawParses: [],
	divergentParses: [],
	invalid: [],
};

for (const frame of [...frames, ...submitFrames]) {
	const problem = protocol.cloudMessageProblem(frame.value);
	if (problem !== undefined) throw new Error(`valid frame ${frame.name} rejected by TS: ${problem}`);
	corpus.frames.push({ name: frame.name, value: frame.value, serialized: protocol.serializeCloudMessage(frame.value) });
}

for (const request of requests) {
	const problem = protocol.cloudRequestProblem(request.value);
	if (problem !== undefined) throw new Error(`valid request ${request.name} rejected by TS: ${problem}`);
	const isFrame = request.value.type !== undefined;
	corpus.requests.push({
		name: request.name,
		value: request.value,
		canonical: protocol.canonicalJson(request.value),
		digest: isFrame ? undefined : protocol.cloudRequestDigest(request.value),
	});
}

for (const rawJson of numberCases) {
	const value = JSON.parse(rawJson);
	const problem = protocol.cloudRequestProblem(value);
	if (problem !== undefined) throw new Error(`number case rejected by TS: ${problem}\n${rawJson}`);
	corpus.numbers.push({
		rawJson,
		canonical: protocol.canonicalJson(value),
		digest: protocol.cloudRequestDigest(value),
	});
}

for (const { name, rawJson } of rawParses) {
	const parsed = protocol.parseCloudMessage(rawJson);
	if (!parsed.ok) throw new Error(`raw parse case ${name} rejected by TS: ${parsed.error}`);
	corpus.rawParses.push({ name, rawJson, serialized: protocol.serializeCloudMessage(parsed.message) });
}

for (const { name, rawJson } of divergentParses) {
	const parsed = protocol.parseCloudMessage(rawJson);
	if (!parsed.ok) throw new Error(`divergent parse case ${name} unexpectedly rejected by TS: ${parsed.error}`);
	corpus.divergentParses.push({
		name,
		rawJson,
		divergence: "rust-typed-u64-domain",
		serialized: protocol.serializeCloudMessage(parsed.message),
	});
}

for (const event of events) {
	const problem = protocol.cloudEventProblem(event.value);
	if (problem !== undefined) throw new Error(`valid event ${event.name} rejected by TS: ${problem}`);
	corpus.events.push({ name: event.name, value: event.value, canonical: protocol.canonicalJson(event.value) });
}

for (const { validator, value, rawJson } of invalid) {
	switch (validator) {
		case "message": {
			const problem = protocol.cloudMessageProblem(value);
			if (problem === undefined) throw new Error(`invalid message case unexpectedly valid: ${JSON.stringify(value)}`);
			corpus.invalid.push({ validator, value, problem });
			break;
		}
		case "event": {
			const problem = protocol.cloudEventProblem(value);
			if (problem === undefined) throw new Error(`invalid event case unexpectedly valid: ${JSON.stringify(value)}`);
			corpus.invalid.push({ validator, value, problem });
			break;
		}
		case "request": {
			const problem = protocol.cloudRequestProblem(value);
			if (problem === undefined) throw new Error(`invalid request case unexpectedly valid: ${JSON.stringify(value)}`);
			corpus.invalid.push({ validator, value, problem });
			break;
		}
		case "requestJson": {
			const problem = protocol.cloudRequestJsonProblem(value);
			if (problem === undefined) throw new Error(`invalid requestJson case unexpectedly valid`);
			corpus.invalid.push({ validator, value, problem });
			break;
		}
		case "parse": {
			const result = protocol.parseCloudMessage(rawJson);
			if (result.ok) throw new Error(`parse case unexpectedly ok: ${rawJson}`);
			corpus.invalid.push({ validator, rawJson, problem: result.error });
			break;
		}
		case "serialize": {
			try {
				protocol.serializeCloudMessage(value);
				throw new Error(`serialize case unexpectedly ok: ${JSON.stringify(value)}`);
			} catch (error) {
				corpus.invalid.push({ validator, value, problem: String(error.message ?? error) });
			}
			break;
		}
		case "id": {
			const problem = protocol.cloudIdProblem(value);
			if (problem === undefined) throw new Error(`id case unexpectedly valid: ${JSON.stringify(value)}`);
			corpus.invalid.push({ validator, value, problem });
			break;
		}
		default:
			throw new Error(`unknown validator ${validator}`);
	}
}

fs.writeFileSync(outPath, JSON.stringify(corpus, null, "\t") + "\n");
console.log(
	`corpus: ${corpus.frames.length} frames, ${corpus.requests.length} requests, ${corpus.events.length} events, ${corpus.numbers.length} number cases, ${corpus.rawParses.length} raw parse cases, ${corpus.divergentParses.length} divergent parse cases, ${corpus.invalid.length} invalid cases (ts source sha256 ${tsSourceSha256}) -> ${outPath}`,
);
