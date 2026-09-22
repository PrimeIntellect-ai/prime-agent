import { describe, expect, it, vi } from "vitest";

import {
	CommandSessionProtoError,
	canonicalUuidKey,
	decodeCommandSessionEventResponse,
} from "../src/core/cloud/command-session-proto.js";
import {
	DEFAULT_KEEPALIVE_INTERVAL_SECONDS,
	MAX_PROCESS_INPUT_BYTES,
	type VmGatewayAuth,
	type VmProcessAuthSource,
	VmProcessClient,
	type VmProcessClientOptions,
	VmProcessError,
} from "../src/core/cloud/vm-process-client.js";
import {
	expectErrorOf,
	type FetchMock,
	type FetchResponder,
	fetchRecorder,
	headerOf,
	jsonResponse,
} from "./cloud-prime-api-fakes.js";

const GATEWAY_URL = "https://sandbox-gw.example.com";
const NS = "ns_user1";
const JOB = "job_abc";
const BASE = `${GATEWAY_URL}/${NS}/${JOB}`;
const TOKEN = "gateway-token-one";
const REFRESH_TOKEN = "gateway-token-two";
const SESSION_UUID = "7dd7ad0e-6f23-4a75-8d46-1e4a25ac9c12";
const PID = 4242;

function rpcUrl(method: string): string {
	return `${BASE}/command_session.CommandSession/${method}`;
}

function auth(overrides: Partial<VmGatewayAuth> = {}): VmGatewayAuth {
	return { gatewayUrl: GATEWAY_URL, userNamespace: NS, jobId: JOB, token: TOKEN, ...overrides };
}

const expectError = (promise: Promise<unknown>) => expectErrorOf(promise, VmProcessError);

function makeClient(mock: FetchMock, options: Partial<VmProcessClientOptions> = {}) {
	const authSource: VmProcessAuthSource = {
		getAuth: async () => auth(),
		refreshAuth: async () => auth({ token: REFRESH_TOKEN }),
	};
	return new VmProcessClient({
		auth: authSource,
		fetchFn: mock as unknown as typeof fetch,
		...options,
	});
}

/** A client over a recorded fetch that answers from the responder list (the last repeats). */
function vmCase(responders: FetchResponder[], options: Partial<VmProcessClientOptions> = {}) {
	const { mock, calls } = fetchRecorder(responders);
	return { client: makeClient(mock, options), mock, calls };
}

// ---------------------------------------------------------------------------
// Independent test-side protobuf helpers (deliberately re-implemented here so
// the tests do not exercise the production codec for fixture building)
// ---------------------------------------------------------------------------

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function tvarint(value: number): Uint8Array {
	const bytes: number[] = [];
	let remaining = value;
	while (remaining >= 0x80) {
		bytes.push((remaining & 0x7f) | 0x80);
		remaining = Math.floor(remaining / 128);
	}
	bytes.push(remaining);
	return Uint8Array.from(bytes);
}

function ttag(field: number, wire: number): Uint8Array {
	return tvarint((field << 3) | wire);
}

function tlenField(field: number, payload: Uint8Array): Uint8Array {
	return concat(ttag(field, 2), tvarint(payload.byteLength), payload);
}

function tstrField(field: number, value: string): Uint8Array {
	return tlenField(field, new TextEncoder().encode(value));
}

function tvarintField(field: number, value: number): Uint8Array {
	return concat(ttag(field, 0), tvarint(value));
}

interface TField {
	field: number;
	wire: number;
	varint?: number;
	bytes?: Uint8Array;
}

function* tfields(input: Uint8Array): Generator<TField> {
	let pos = 0;
	const readVarint = (): number => {
		let value = 0;
		let shift = 0;
		while (true) {
			if (pos >= input.byteLength) {
				throw new Error("fixture decode: truncated varint");
			}
			const byte = input[pos];
			pos++;
			value += (byte & 0x7f) * 2 ** shift;
			if ((byte & 0x80) === 0) return value;
			shift += 7;
		}
	};
	while (pos < input.byteLength) {
		const tag = readVarint();
		const field = Math.floor(tag / 8);
		const wire = tag % 8;
		if (wire === 0) {
			yield { field, wire, varint: readVarint() };
		} else if (wire === 2) {
			const length = readVarint();
			yield { field, wire, bytes: input.slice(pos, pos + length) };
			pos += length;
		} else {
			throw new Error(`fixture decode: unsupported wire type ${wire}`);
		}
	}
}

function findField(input: Uint8Array | undefined, field: number): TField | undefined {
	return [...tfields(input ?? new Uint8Array(0))].find((entry) => entry.field === field);
}

function strOf(field: TField | undefined): string {
	return new TextDecoder().decode(field?.bytes ?? new Uint8Array(0));
}

function bodyBytes(init: RequestInit | undefined): Uint8Array {
	if (!(init?.body instanceof Uint8Array)) {
		throw new Error("expected Uint8Array request body");
	}
	return init.body;
}

function unwrapEnvelope(body: Uint8Array): { flags: number; payload: Uint8Array } {
	expect(body.byteLength).toBeGreaterThanOrEqual(5);
	const flags = body[0];
	const length = (body[1] << 24) | (body[2] << 16) | (body[3] << 8) | body[4];
	expect(length).toBe(body.byteLength - 5);
	return { flags, payload: body.slice(5) };
}

// --- event fixtures ---

function eventFrame(event: Uint8Array): Uint8Array {
	return tlenField(1, event);
}

function startEvent(pid: number): Uint8Array {
	return eventFrame(tlenField(1, tvarintField(1, pid)));
}

function dataEvent(kind: "stdout" | "stderr" | "pty", data: Uint8Array): Uint8Array {
	return eventFrame(tlenField(2, tlenField(kind === "stdout" ? 1 : kind === "stderr" ? 2 : 3, data)));
}

function endEvent(options: { exitCode: number; exited?: boolean; status?: string; error?: string }): Uint8Array {
	const exitCode = options.exitCode;
	const zigzag = (exitCode << 1) ^ (exitCode >> 31);
	const body = concat(
		tvarintField(1, zigzag),
		tvarintField(2, options.exited === false ? 0 : 1),
		tstrField(3, options.status ?? "exited"),
	);
	const withError = options.error === undefined ? body : concat(body, tstrField(4, options.error));
	return eventFrame(tlenField(3, withError));
}

function keepaliveEvent(): Uint8Array {
	return eventFrame(tlenField(4, new Uint8Array(0)));
}

function envelope(payload: Uint8Array, flags = 0): Uint8Array {
	const header = new Uint8Array(5);
	header[0] = flags;
	const length = payload.byteLength;
	header[1] = (length >>> 24) & 0xff;
	header[2] = (length >>> 16) & 0xff;
	header[3] = (length >>> 8) & 0xff;
	header[4] = length & 0xff;
	return concat(header, payload);
}

function endOfStream(json: unknown = {}): Uint8Array {
	return envelope(new TextEncoder().encode(JSON.stringify(json)), 0x02);
}

function streamContentType(): Record<string, string> {
	return { "Content-Type": "application/connect+proto" };
}

function streamResponse(...frames: Uint8Array[]): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of frames) {
					controller.enqueue(frame);
				}
				controller.close();
			},
		}),
		{ status: 200, headers: streamContentType() },
	);
}

function unaryOk(body: Uint8Array = new Uint8Array(0)): Response {
	return new Response(body, { status: 200, headers: { "Content-Type": "application/proto" } });
}

const noSleep = async () => undefined;

const startRequest = {
	command: { cmd: "/opt/prime/bin/daemon", args: ["--port", "9090"], envs: { HOME: "/root" }, cwd: "/workspace" },
	stdin: false,
	sessionUuid: SESSION_UUID,
};

describe("CommandSession protobuf oneofs", () => {
	it("rejects envelopes carrying multiple event members", () => {
		const start = tlenField(1, tvarintField(1, PID));
		const end = tlenField(3, concat(tvarintField(1, 0), tvarintField(2, 1), tstrField(3, "exited")));
		expect(() => decodeCommandSessionEventResponse(eventFrame(concat(start, end)), "test")).toThrow(
			CommandSessionProtoError,
		);
	});

	it("rejects data events carrying multiple output members", () => {
		const data = tlenField(
			2,
			concat(tlenField(1, new TextEncoder().encode("stdout")), tlenField(2, new TextEncoder().encode("stderr"))),
		);
		expect(() => decodeCommandSessionEventResponse(eventFrame(data), "test")).toThrow(CommandSessionProtoError);
	});
});

describe("canonicalUuidKey", () => {
	it("accepts and canonicalizes every spelling the platform accepts", () => {
		expect(canonicalUuidKey(SESSION_UUID, "sessionUuid")).toBe(SESSION_UUID);
		expect(canonicalUuidKey(SESSION_UUID.toUpperCase(), "sessionUuid")).toBe(SESSION_UUID);
		expect(canonicalUuidKey(`{${SESSION_UUID}}`, "sessionUuid")).toBe(SESSION_UUID);
		expect(canonicalUuidKey(`urn:uuid:${SESSION_UUID}`, "sessionUuid")).toBe(SESSION_UUID);
	});

	it("rejects garbage and the nil UUID", () => {
		for (const bad of [
			"",
			"not-a-uuid",
			"00000000-0000-0000-0000-000000000000",
			SESSION_UUID.replace("-", ""),
			`urn:uuid:xyz`,
		]) {
			let caught: unknown;
			try {
				canonicalUuidKey(bad, "sessionUuid");
			} catch (error) {
				caught = error;
			}
			expect(caught, `expected ${JSON.stringify(bad)} to be rejected`).toBeInstanceOf(CommandSessionProtoError);
			expect((caught as CommandSessionProtoError).kind).toBe("invalid_input");
		}
	});
});

describe("VmProcessClient.start", () => {
	it("sends an enveloped Start request with auth and Connect headers", async () => {
		const { client, calls } = vmCase([
			() =>
				streamResponse(
					envelope(startEvent(PID)),
					envelope(dataEvent("stdout", new Uint8Array([65]))),
					envelope(endEvent({ exitCode: 0 })),
				),
		]);
		const stream = await client.start(startRequest, { connectTimeoutMs: 0, sleepFn: noSleep });

		expect(calls.length).toBe(1);
		const { url, init } = calls[0];
		expect(url).toBe(rpcUrl("Start"));
		const headers = headerOf(init);
		expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(headers["Content-Type"]).toBe("application/connect+proto");
		expect(headers["Connect-Protocol-Version"]).toBe("1");
		expect(headers["Keepalive-Ping-Interval"]).toBe(String(DEFAULT_KEEPALIVE_INTERVAL_SECONDS));
		// An explicit zero deadline is sent as "0": sandboxd must not apply its default timeout.
		expect(headers["Connect-Timeout-Ms"]).toBe("0");

		const { flags, payload } = unwrapEnvelope(bodyBytes(init));
		expect(flags).toBe(0);
		const fields = [...tfields(payload)];
		const spec = fields.find((f) => f.field === 1);
		const stdinField = fields.find((f) => f.field === 4);
		const sessionField = fields.find((f) => f.field === 5);
		expect(spec?.bytes).toBeDefined();
		const specFields = [...tfields(spec?.bytes ?? new Uint8Array(0))];
		expect(strOf(specFields[0])).toBe("/opt/prime/bin/daemon");
		expect(strOf(specFields[1])).toBe("--port");
		const envFields = [...tfields(findField(spec?.bytes, 3)?.bytes ?? new Uint8Array(0))];
		expect(strOf(envFields[0])).toBe("HOME");
		expect(strOf(envFields[1])).toBe("/root");
		expect(strOf(specFields.at(-1))).toBe("/workspace");
		expect(stdinField?.varint).toBe(0);
		expect(strOf(sessionField)).toBe(SESSION_UUID);

		await expect(stream.started).resolves.toBe(PID);
		await stream.release();
	});

	it("canonicalizes session UUID spellings onto the wire", async () => {
		const { client, calls } = vmCase([
			() => streamResponse(envelope(startEvent(PID)), envelope(endEvent({ exitCode: 3 }))),
		]);
		const stream = await client.start(
			{
				...startRequest,
				sessionUuid: SESSION_UUID.toUpperCase(),
			},
			{ sleepFn: noSleep },
		);
		expect(strOf(findField(unwrapEnvelope(bodyBytes(calls[0].init)).payload, 5))).toBe(SESSION_UUID);
		await expect(stream.exit).resolves.toMatchObject({ exitCode: 3 });
	});

	it("accepts the deployed partial end event shape without faulting the stream", async () => {
		// The deployed CommandSession service marks every EndEvent field
		// optional and observed exits carry only a subset (sometimes none):
		// the end event itself is the terminal signal and must never fault.
		const partialEnd = (body: Uint8Array): Uint8Array => eventFrame(tlenField(3, body));
		const scenarios = [
			{ label: "exit code only", body: tvarintField(1, ((0 << 1) ^ (0 >> 31)) | 0) },
			{ label: "status only", body: tstrField(3, "exited") },
			{ label: "exited flag only", body: tvarintField(2, 1) },
			{ label: "no fields at all", body: new Uint8Array(0) },
		];
		for (const scenario of scenarios) {
			const { client } = vmCase([
				() => streamResponse(envelope(startEvent(PID)), envelope(partialEnd(scenario.body))),
			]);
			const stream = await client.start({ ...startRequest, sessionUuid: SESSION_UUID }, { sleepFn: noSleep });
			const end = await stream.exit;
			expect(end.kind).toBe("end");
			expect(end.exited).toBe(true);
			await stream.release();
		}
		// Fields that ARE present still decode faithfully.
		const full = vmCase([
			() => streamResponse(envelope(startEvent(PID)), envelope(endEvent({ exitCode: 7, status: "stopped" }))),
		]);
		const stream = await full.client.start({ ...startRequest, sessionUuid: SESSION_UUID }, { sleepFn: noSleep });
		await expect(stream.exit).resolves.toMatchObject({ exitCode: 7, exited: true, status: "stopped" });
		await stream.release();
	});

	it("rejects invalid session UUIDs before any network call", async () => {
		const { client, calls } = vmCase([() => streamResponse()]);
		for (const bad of ["not-a-uuid", "", "00000000-0000-0000-0000-000000000000", "urn:uuid:xyz"]) {
			const error = await expectError(client.start({ ...startRequest, sessionUuid: bad }, { sleepFn: noSleep }));
			expect(error.code).toBe("invalid_request");
		}
		expect(calls.length).toBe(0);
	});

	it("delivers events in order and resolves exit, skipping keepalives", async () => {
		const { client } = vmCase([
			() =>
				streamResponse(
					envelope(startEvent(PID)),
					envelope(keepaliveEvent()),
					envelope(dataEvent("stdout", new Uint8Array([0x68, 0x69]))),
					envelope(dataEvent("stderr", new Uint8Array([0x65, 0x72, 0x72]))),
					envelope(dataEvent("pty", new Uint8Array([0x70]))),
					envelope(endEvent({ exitCode: -1, status: "exited", error: "boom" })),
				),
		]);
		const stream = await client.start(startRequest, { sleepFn: noSleep });
		const seen: string[] = [];
		for await (const event of stream) {
			if (event.kind === "start") {
				seen.push(`start:${event.pid}`);
			} else if (event.kind === "stdout" || event.kind === "stderr" || event.kind === "pty") {
				seen.push(`${event.kind}:${Buffer.from(event.data).toString("latin1")}`);
			} else if (event.kind === "end") {
				seen.push(`end:${event.exitCode}:${event.status}:${event.error ?? ""}`);
			}
		}
		expect(seen).toEqual(["start:4242", "stdout:hi", "stderr:err", "pty:p", "end:-1:exited:boom"]);
		await expect(stream.exit).resolves.toMatchObject({ exitCode: -1, exited: true, error: "boom" });
	});

	it("releases the resident transport without terminating the process", async () => {
		let cancelSeen = false;
		const { client, calls } = vmCase([
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(envelope(startEvent(PID)));
						},
						cancel() {
							cancelSeen = true;
						},
					}),
					{ status: 200, headers: streamContentType() },
				),
			() => unaryOk(),
		]);
		const stream = await client.start(startRequest, { sleepFn: noSleep, connectTimeoutMs: 0 });
		expect(stream.released).toBe(false);
		await stream.release();
		expect(stream.released).toBe(true);
		expect(cancelSeen).toBe(true);
		expect(calls[0].init?.signal?.aborted).toBe(true);
		// The defining property of release: nothing was signalled, nothing else was called.
		expect(calls.length).toBe(1);
		const exitError = await expectError(stream.exit);
		expect(exitError.code).toBe("released");
		const rest: string[] = [];
		for await (const event of stream) {
			rest.push(event.kind);
		}
		expect(rest).toEqual(["start"]);
	});

	it("retries Start with identical bytes after a pre-start drop (create-or-attach)", async () => {
		const { client, calls } = vmCase([
			() => streamResponse(), // drops before any event
			() => streamResponse(envelope(startEvent(PID)), envelope(endEvent({ exitCode: 0 }))),
		]);
		const sleep = vi.fn(noSleep);
		const stream = await client.start(startRequest, {
			sleepFn: sleep,
			maxReconnects: 2,
			reconnectBaseDelayMs: 500,
		});
		expect(calls.length).toBe(2);
		expect(calls[0].url).toBe(rpcUrl("Start"));
		expect(calls[1].url).toBe(rpcUrl("Start"));
		expect(Buffer.from(bodyBytes(calls[0].init))).toEqual(Buffer.from(bodyBytes(calls[1].init)));
		expect(sleep).toHaveBeenCalledWith(500);
		await expect(stream.started).resolves.toBe(PID);
		await expect(stream.exit).resolves.toMatchObject({ exitCode: 0 });
	});

	it("re-attaches with Connect by session selector after a post-start drop", async () => {
		const { client, calls } = vmCase([
			() => streamResponse(envelope(startEvent(PID)), envelope(dataEvent("stdout", new Uint8Array([1])))),
			// Retained-session replay: start + end, like sandboxd retention.
			() =>
				streamResponse(
					envelope(startEvent(PID)),
					envelope(endEvent({ exitCode: 5, status: "exited" })),
					endOfStream(),
				),
		]);
		const stream = await client.start(startRequest, { sleepFn: noSleep, maxReconnects: 3 });
		await expect(stream.exit).resolves.toMatchObject({ exitCode: 5 });
		expect(calls.length).toBe(2);
		expect(calls[1].url).toBe(rpcUrl("Connect"));
		const { payload } = unwrapEnvelope(bodyBytes(calls[1].init));
		expect(strOf(findField(findField(payload, 1)?.bytes, 3))).toBe(SESSION_UUID);
		await expect(stream.started).resolves.toBe(PID);
	});

	it("connect() attaches without starting and replays a retained exit", async () => {
		const { client, calls } = vmCase([
			() => streamResponse(envelope(startEvent(PID)), envelope(endEvent({ exitCode: 1 })), endOfStream()),
		]);
		const stream = await client.connect(SESSION_UUID, { sleepFn: noSleep });
		expect(calls[0].url).toBe(rpcUrl("Connect"));
		await expect(stream.started).resolves.toBe(PID);
		await expect(stream.exit).resolves.toMatchObject({ exitCode: 1 });
	});

	it("surfaces fatal stream answers without reconnecting", async () => {
		const cases: Record<string, () => Response> = {
			not_found: () => jsonResponse({ code: "not_found", message: "process with session_uuid not found" }, 404),
			failed_precondition: () => jsonResponse({ code: "failed_precondition", message: "spec conflict" }, 412),
			invalid_argument: () => jsonResponse({ code: "invalid_argument", message: "bad session_uuid" }, 400),
			sandbox_not_found: () => jsonResponse({ error: "sandbox_not_found", message: "sandbox is gone" }, 502),
		};
		for (const [code, respond] of Object.entries(cases)) {
			const { client, calls } = vmCase([respond]);
			const error = await expectError(client.start(startRequest, { sleepFn: noSleep }));
			expect(error.code, code).toBe(code);
			// One fetch: the fault was definitive, so the reconnect budget is untouched.
			expect(calls.length).toBe(1);
		}
	});

	it("exhausts the reconnect budget and surfaces the last fault", async () => {
		const { client, calls } = vmCase([
			() => streamResponse(envelope(startEvent(PID))),
			() => streamResponse(envelope(startEvent(PID))),
			() => streamResponse(envelope(startEvent(PID))),
		]);
		const sleep = vi.fn(noSleep);
		const stream = await client.start(startRequest, {
			sleepFn: sleep,
			maxReconnects: 1,
			reconnectBaseDelayMs: 100,
		});
		// The first attempt (which start() awaits) succeeds; the drop happens after.
		const error = await expectError(stream.exit);
		expect(error.code).toBe("network");
		expect(calls.length).toBe(2); // initial + one reattach
		expect(sleep).toHaveBeenCalledWith(100);
	});

	it("re-auths once per attempt when the stream attempt answers 401", async () => {
		const { mock, calls } = fetchRecorder([
			() => jsonResponse({ code: "unauthenticated", message: "expired" }, 401),
			() => streamResponse(envelope(startEvent(PID)), envelope(endEvent({ exitCode: 0 }))),
			() => jsonResponse({ code: "unauthenticated", message: "expired" }, 401),
		]);
		const authSource: VmProcessAuthSource = {
			getAuth: async () => auth(),
			refreshAuth: async () => auth({ token: REFRESH_TOKEN }),
		};
		const refreshSpy = vi.spyOn(authSource, "refreshAuth");
		const client = new VmProcessClient({
			auth: authSource,
			fetchFn: mock as unknown as typeof fetch,
		});
		const stream = await client.start(startRequest, { sleepFn: noSleep });
		expect(calls.length).toBe(2);
		expect(headerOf(calls[1].init).Authorization).toBe(`Bearer ${REFRESH_TOKEN}`);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		await expect(stream.exit).resolves.toMatchObject({ exitCode: 0 });
	});

	it("rejects non-connect+proto stream responses", async () => {
		const { client, calls } = vmCase([
			() => new Response("nope", { status: 200, headers: { "Content-Type": "text/plain" } }),
		]);
		const error = await expectError(client.start(startRequest, { sleepFn: noSleep, maxReconnects: 0 }));
		expect(error.code).toBe("invalid_response");
		expect(calls.length).toBe(1);
	});

	it("bounds frame size and aborts on oversize frames", async () => {
		const big = envelope(new Uint8Array(64 * 1024).fill(0x41));
		const { client } = vmCase(
			[
				() => streamResponse(envelope(startEvent(PID)), envelope(big)),
				() => streamResponse(envelope(startEvent(PID)), envelope(endEvent({ exitCode: 0 }))),
			],
			{ maxEventFrameBytes: 32 * 1024 },
		);
		const stream = await client.start(startRequest, { sleepFn: noSleep });
		const error = await expectError(stream.exit);
		expect(error.code).toBe("too_large");
	});

	it("rejects compressed frames it never negotiated", async () => {
		const { client } = vmCase([() => streamResponse(envelope(startEvent(PID)), envelope(startEvent(PID), 0x01))]);
		const stream = await client.start(startRequest, { sleepFn: noSleep });
		const error = await expectError(stream.exit);
		expect(error.code).toBe("invalid_response");
	});

	it("treats a truncated frame at EOF as a recoverable network fault", async () => {
		const truncated = envelope(startEvent(PID)).slice(0, 9); // header promises more payload bytes than delivered
		const { client, calls } = vmCase([
			() => streamResponse(envelope(startEvent(PID)), truncated),
			() => streamResponse(envelope(startEvent(PID)), envelope(endEvent({ exitCode: 0 }))),
		]);
		const stream = await client.start(startRequest, { sleepFn: noSleep });
		await expect(stream.exit).resolves.toMatchObject({ exitCode: 0 });
		expect(calls.length).toBe(2);
	});

	it("surfaces end-of-stream error frames with their Connect code", async () => {
		const { client, calls } = vmCase([
			() => streamResponse(envelope(startEvent(PID))),
			() =>
				streamResponse(
					envelope(startEvent(PID)),
					endOfStream({ error: { code: "not_found", message: "session expired" } }),
				),
		]);
		const stream = await client.start(startRequest, { sleepFn: noSleep });
		const error = await expectError(stream.exit);
		expect(error.code).toBe("not_found");
		expect(error.message).toBe("session expired");
		expect(calls.length).toBe(2);
	});

	it("stops reading while the consumer is behind, then resumes (backpressure)", async () => {
		const frames = [envelope(startEvent(PID))];
		for (let index = 0; index < 5; index++) {
			frames.push(envelope(dataEvent("stdout", Uint8Array.of(index))));
		}
		frames.push(envelope(endEvent({ exitCode: 0 })));
		let pulls = 0;
		let position = 0;
		const { client } = vmCase([
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							pulls++;
							if (position < frames.length) {
								controller.enqueue(frames[position]);
								position++;
							} else {
								controller.close();
							}
						},
					}),
					{ status: 200, headers: streamContentType() },
				),
		]);
		const stream = await client.start(startRequest, { sleepFn: noSleep, maxPendingEvents: 2 });
		// start() already consumed one event; the pump may buffer at most two more
		// before it stops pulling. Drain slowly and check everything arrives.
		const seen: number[] = [];
		for await (const event of stream) {
			if (event.kind === "stdout") {
				seen.push(event.data[0]);
			}
		}
		expect(seen).toEqual([0, 1, 2, 3, 4]);
		expect(pulls).toBeGreaterThan(3);
		expect(pulls).toBeLessThanOrEqual(frames.length + 1);
		await expect(stream.exit).resolves.toMatchObject({ exitCode: 0 });
	});
});

describe("VmProcessClient control RPCs", () => {
	it("sendInput posts a unary SendInput with selector, bytes, and idempotency key", async () => {
		const { client, calls } = vmCase([() => unaryOk()]);
		const inputUuid = "11111111-2222-3333-4444-555555555555";
		await client.sendInput(SESSION_UUID, "stdin", new Uint8Array([0xde, 0xad]), {
			inputUuid,
			connectTimeoutMs: 5_000,
		});
		const { url, init } = calls[0];
		expect(url).toBe(rpcUrl("SendInput"));
		const headers = headerOf(init);
		expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(headers["Content-Type"]).toBe("application/proto");
		expect(headers["Connect-Timeout-Ms"]).toBe("5000");
		const fields = [...tfields(bodyBytes(init))];
		const selector = fields.find((f) => f.field === 1);
		expect(strOf(findField(selector?.bytes, 3))).toBe(SESSION_UUID);
		const input = fields.find((f) => f.field === 2);
		expect([...(findField(input?.bytes, 1)?.bytes ?? new Uint8Array(0))]).toEqual([0xde, 0xad]);
		expect(strOf(fields.find((f) => f.field === 3))).toBe(inputUuid);
	});

	it("sendInput writes to the pty channel when asked", async () => {
		const { client, calls } = vmCase([() => unaryOk()]);
		await client.sendInput(SESSION_UUID, "pty", new Uint8Array([0x0d]));
		const input = findField(bodyBytes(calls[0].init), 2);
		expect(findField(input?.bytes, 2)).toBeDefined();
	});

	it("sendInput retries transient faults with identical bytes and backoff", async () => {
		const sleep = vi.fn(noSleep);
		const { client, calls } = vmCase(
			[
				() => jsonResponse({ code: "unavailable", message: "gateway busy" }, 503),
				() => jsonResponse({ code: "deadline_exceeded", message: "slow" }, 504),
				() => unaryOk(),
			],
			{ sleepFn: sleep },
		);
		await client.sendInput(SESSION_UUID, "stdin", new Uint8Array([1]));
		expect(calls.length).toBe(3);
		expect(Buffer.from(bodyBytes(calls[0].init))).toEqual(Buffer.from(bodyBytes(calls[1].init)));
		expect(Buffer.from(bodyBytes(calls[1].init))).toEqual(Buffer.from(bodyBytes(calls[2].init)));
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenNthCalledWith(1, 500);
		expect(sleep).toHaveBeenNthCalledWith(2, 1000);
	});

	it("sendInput fails fast on permanent answers", async () => {
		const { client, calls } = vmCase([() => jsonResponse({ code: "not_found", message: "process not found" }, 404)]);
		const error = await expectError(client.sendInput(SESSION_UUID, "stdin", new Uint8Array([1])));
		expect(error.code).toBe("not_found");
		expect(error.message).toBe("process not found");
		expect(calls.length).toBe(1);
	});

	it("sendInput refreshes auth once on 401, then surfaces the second", async () => {
		const { mock, calls } = fetchRecorder([
			() => jsonResponse({ code: "unauthenticated", message: "expired" }, 401),
			() => jsonResponse({ code: "unauthenticated", message: "expired again" }, 401),
		]);
		const authSource: VmProcessAuthSource = {
			getAuth: async () => auth(),
			refreshAuth: async () => auth({ token: REFRESH_TOKEN }),
		};
		const refreshSpy = vi.spyOn(authSource, "refreshAuth");
		const client = new VmProcessClient({ auth: authSource, fetchFn: mock as unknown as typeof fetch });
		const error = await expectError(client.sendInput(SESSION_UUID, "stdin", new Uint8Array([1])));
		expect(error.code).toBe("unauthenticated");
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(calls.length).toBe(2);
		expect(headerOf(calls[1].init).Authorization).toBe(`Bearer ${REFRESH_TOKEN}`);
	});

	it("validates input bounds before the network", async () => {
		const { client, calls } = vmCase([() => unaryOk()]);
		const empty = await expectError(client.sendInput(SESSION_UUID, "stdin", new Uint8Array(0)));
		expect(empty.code).toBe("invalid_request");
		const tooLarge = await expectError(
			client.sendInput(SESSION_UUID, "stdin", new Uint8Array(MAX_PROCESS_INPUT_BYTES + 1)),
		);
		expect(tooLarge.code).toBe("too_large");
		const badUuid = await expectError(client.sendInput("nope", "stdin", new Uint8Array([1])));
		expect(badUuid.code).toBe("invalid_request");
		expect(calls.length).toBe(0);
	});

	it("rejects malformed unary responses", async () => {
		for (const response of [
			new Response(new Uint8Array(0), { status: 200, headers: { "Content-Type": "application/json" } }),
			unaryOk(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff])),
		]) {
			const { client, calls } = vmCase([() => response]);
			const error = await expectError(client.sendInput(SESSION_UUID, "stdin", new Uint8Array([1])));
			expect(error.code).toBe("invalid_response");
			expect(calls.length).toBe(1);
		}
	});

	it("sendSignal encodes terminate as 15 and kill as 9 with a key", async () => {
		const { client, calls } = vmCase([() => unaryOk(), () => unaryOk()]);
		const signalUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		await client.sendSignal(SESSION_UUID, "terminate", { signalUuid });
		await client.sendSignal(SESSION_UUID, "kill", { signalUuid });
		expect(calls[0].url).toBe(rpcUrl("SendSignal"));
		expect(findField(bodyBytes(calls[0].init), 2)?.varint).toBe(15);
		expect(strOf(findField(bodyBytes(calls[0].init), 3))).toBe(signalUuid);
		expect(findField(bodyBytes(calls[1].init), 2)?.varint).toBe(9);
	});

	it("resize encodes an Update with the PTY size", async () => {
		const { client, calls } = vmCase([() => unaryOk()]);
		await client.resize(SESSION_UUID, { cols: 120, rows: 40 });
		expect(calls[0].url).toBe(rpcUrl("Update"));
		const size = findField(findField(bodyBytes(calls[0].init), 2)?.bytes, 1);
		expect(findField(size?.bytes, 1)?.varint).toBe(120);
		expect(findField(size?.bytes, 2)?.varint).toBe(40);
	});

	it("maps gateway-shaped errors and never leaks the token", async () => {
		const { client } = vmCase([
			() => jsonResponse({ error: "sandbox_not_found", message: `token ${TOKEN} in body` }, 502),
		]);
		const error = await expectError(client.sendInput(SESSION_UUID, "stdin", new Uint8Array([1])));
		expect(error.code).toBe("sandbox_not_found");
		expect(error.message).not.toContain(TOKEN);
		expect(error.details).not.toContain(TOKEN);
	});

	it("maps non-JSON HTTP errors by status", async () => {
		const { client } = vmCase([
			() => new Response("boom", { status: 500, headers: { "Content-Type": "text/plain" } }),
		]);
		const error = await expectError(client.sendInput(SESSION_UUID, "stdin", new Uint8Array([1])));
		expect(error.code).toBe("internal");
		expect(error.status).toBe(500);
	});
});
