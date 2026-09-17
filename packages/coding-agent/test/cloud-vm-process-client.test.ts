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

const GATEWAY_URL = "https://sandbox-gw.example.com";
const NS = "ns_user1";
const JOB = "job_abc";
const BASE = `${GATEWAY_URL}/${NS}/${JOB}`;
const TOKEN = "gateway-token-one";
const REFRESH_TOKEN = "gateway-token-two";
const SESSION_UUID = "7dd7ad0e-6f23-4a75-8d46-1e4a25ac9c12";
const PID = 4242;

interface Recorded {
	url: string;
	init: RequestInit | undefined;
}

function rpcUrl(method: string): string {
	return `${BASE}/command_session.CommandSession/${method}`;
}

function auth(overrides: Partial<VmGatewayAuth> = {}): VmGatewayAuth {
	return { gatewayUrl: GATEWAY_URL, userNamespace: NS, jobId: JOB, token: TOKEN, ...overrides };
}

type FetchMock = ReturnType<typeof vi.fn>;

function fetchRouter(responders: Array<(record: Recorded, index: number) => Response | Promise<Response>>): {
	mock: FetchMock;
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const record: Recorded = { url: String(input), init };
		calls.push(record);
		const responder = responders[calls.length - 1] ?? responders.at(-1);
		if (responder === undefined) {
			throw new Error(`unexpected fetch #${calls.length} to ${record.url}`);
		}
		return responder(record, calls.length - 1);
	});
	return { mock, calls };
}

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

function headerOf(init: RequestInit | undefined): Record<string, string> {
	const headers = init?.headers;
	if (!headers || Array.isArray(headers) || headers instanceof Headers) {
		throw new Error("expected plain record headers");
	}
	return headers as Record<string, string>;
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

/** Envelope one StartResponse/ConnectResponse message as a stream frame. */
function env(payload: Uint8Array, flags = 0): Uint8Array {
	return envelope(payload, flags);
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

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function expectError(promise: Promise<unknown>): Promise<VmProcessError> {
	try {
		await promise;
	} catch (caught) {
		expect(caught).toBeInstanceOf(VmProcessError);
		return caught as VmProcessError;
	}
	throw new Error("expected the call to fail");
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
		const { mock, calls } = fetchRouter([
			(_record) =>
				streamResponse(
					env(startEvent(PID)),
					env(dataEvent("stdout", new Uint8Array([65]))),
					env(endEvent({ exitCode: 0 })),
				),
		]);
		const client = makeClient(mock);
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
		expect(new TextDecoder().decode(specFields[0]?.bytes ?? new Uint8Array(0))).toBe("/opt/prime/bin/daemon");
		expect(new TextDecoder().decode(specFields[1]?.bytes ?? new Uint8Array(0))).toBe("--port");
		const envEntry = specFields.find((f) => f.field === 3);
		const envFields = [...tfields(envEntry?.bytes ?? new Uint8Array(0))];
		expect(new TextDecoder().decode(envFields[0]?.bytes ?? new Uint8Array(0))).toBe("HOME");
		expect(new TextDecoder().decode(envFields[1]?.bytes ?? new Uint8Array(0))).toBe("/root");
		expect(new TextDecoder().decode(specFields.at(-1)?.bytes ?? new Uint8Array(0))).toBe("/workspace");
		expect(stdinField?.varint).toBe(0);
		expect(new TextDecoder().decode(sessionField?.bytes ?? new Uint8Array(0))).toBe(SESSION_UUID);

		await expect(stream.started).resolves.toBe(PID);
		await stream.release();
	});

	it("canonicalizes session UUID spellings onto the wire", async () => {
		const { mock, calls } = fetchRouter([() => streamResponse(env(startEvent(PID)), env(endEvent({ exitCode: 3 })))]);
		const client = makeClient(mock);
		const stream = await client.start(
			{
				...startRequest,
				sessionUuid: SESSION_UUID.toUpperCase(),
			},
			{ sleepFn: noSleep },
		);
		const sessionField = [...tfields(unwrapEnvelope(bodyBytes(calls[0].init)).payload)].find((f) => f.field === 5);
		expect(new TextDecoder().decode(sessionField?.bytes ?? new Uint8Array(0))).toBe(SESSION_UUID);
		await expect(stream.exit).resolves.toMatchObject({ exitCode: 3 });
	});

	it("rejects invalid session UUIDs before any network call", async () => {
		const { mock, calls } = fetchRouter([() => streamResponse()]);
		const client = makeClient(mock);
		for (const bad of ["not-a-uuid", "", "00000000-0000-0000-0000-000000000000", "urn:uuid:xyz"]) {
			const error = await expectError(client.start({ ...startRequest, sessionUuid: bad }, { sleepFn: noSleep }));
			expect(error.code).toBe("invalid_request");
		}
		expect(calls.length).toBe(0);
	});

	it("delivers events in order and resolves exit, skipping keepalives", async () => {
		const { mock } = fetchRouter([
			() =>
				streamResponse(
					env(startEvent(PID)),
					env(keepaliveEvent()),
					env(dataEvent("stdout", new Uint8Array([0x68, 0x69]))),
					env(dataEvent("stderr", new Uint8Array([0x65, 0x72, 0x72]))),
					env(dataEvent("pty", new Uint8Array([0x70]))),
					env(endEvent({ exitCode: -1, status: "exited", error: "boom" })),
				),
		]);
		const client = makeClient(mock);
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
		const { mock, calls } = fetchRouter([
			() =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(env(startEvent(PID)));
						},
						cancel() {
							cancelSeen = true;
						},
					}),
					{ status: 200, headers: streamContentType() },
				),
			() => unaryOk(),
		]);
		const client = makeClient(mock);
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
		const { mock, calls } = fetchRouter([
			() => streamResponse(), // drops before any event
			() => streamResponse(env(startEvent(PID)), env(endEvent({ exitCode: 0 }))),
		]);
		const client = makeClient(mock);
		const sleep = vi.fn(noSleep);
		const stream = await client.start(startRequest, { sleepFn: sleep, maxReconnects: 2, reconnectBaseDelayMs: 500 });
		expect(calls.length).toBe(2);
		expect(calls[0].url).toBe(rpcUrl("Start"));
		expect(calls[1].url).toBe(rpcUrl("Start"));
		expect(Buffer.from(bodyBytes(calls[0].init))).toEqual(Buffer.from(bodyBytes(calls[1].init)));
		expect(sleep).toHaveBeenCalledWith(500);
		await expect(stream.started).resolves.toBe(PID);
		await expect(stream.exit).resolves.toMatchObject({ exitCode: 0 });
	});

	it("re-attaches with Connect by session selector after a post-start drop", async () => {
		const { mock, calls } = fetchRouter([
			() => streamResponse(env(startEvent(PID)), env(dataEvent("stdout", new Uint8Array([1])))),
			// Retained-session replay: start + end, like sandboxd retention.
			() => streamResponse(env(startEvent(PID)), env(endEvent({ exitCode: 5, status: "exited" })), endOfStream()),
		]);
		const client = makeClient(mock);
		const stream = await client.start(startRequest, { sleepFn: noSleep, maxReconnects: 3 });
		await expect(stream.exit).resolves.toMatchObject({ exitCode: 5 });
		expect(calls.length).toBe(2);
		expect(calls[1].url).toBe(rpcUrl("Connect"));
		const { payload } = unwrapEnvelope(bodyBytes(calls[1].init));
		const selector = [...tfields(payload)].find((f) => f.field === 1);
		const sessionField = [...tfields(selector?.bytes ?? new Uint8Array(0))].find((f) => f.field === 3);
		expect(new TextDecoder().decode(sessionField?.bytes ?? new Uint8Array(0))).toBe(SESSION_UUID);
		await expect(stream.started).resolves.toBe(PID);
	});

	it("connect() attaches without starting and replays a retained exit", async () => {
		const { mock, calls } = fetchRouter([
			() => streamResponse(env(startEvent(PID)), env(endEvent({ exitCode: 1 })), endOfStream()),
		]);
		const client = makeClient(mock);
		const stream = await client.connect(SESSION_UUID, { sleepFn: noSleep });
		expect(calls[0].url).toBe(rpcUrl("Connect"));
		await expect(stream.started).resolves.toBe(PID);
		await expect(stream.exit).resolves.toMatchObject({ exitCode: 1 });
	});

	it("surfaces fatal stream answers without reconnecting", async () => {
		const cases: Record<string, () => Response> = {
			not_found: () => jsonResponse(404, { code: "not_found", message: "process with session_uuid not found" }),
			failed_precondition: () => jsonResponse(412, { code: "failed_precondition", message: "spec conflict" }),
			invalid_argument: () => jsonResponse(400, { code: "invalid_argument", message: "bad session_uuid" }),
			sandbox_not_found: () => jsonResponse(502, { error: "sandbox_not_found", message: "sandbox is gone" }),
		};
		for (const [code, respond] of Object.entries(cases)) {
			const { mock, calls } = fetchRouter([respond]);
			const client = makeClient(mock);
			const error = await expectError(client.start(startRequest, { sleepFn: noSleep }));
			expect(error.code, code).toBe(code);
			// One fetch: the fault was definitive, so the reconnect budget is untouched.
			expect(calls.length).toBe(1);
		}
	});

	it("exhausts the reconnect budget and surfaces the last fault", async () => {
		const { mock, calls } = fetchRouter([
			() => streamResponse(env(startEvent(PID))),
			() => streamResponse(env(startEvent(PID))),
			() => streamResponse(env(startEvent(PID))),
		]);
		const client = makeClient(mock);
		const sleep = vi.fn(noSleep);
		const stream = await client.start(startRequest, { sleepFn: sleep, maxReconnects: 1, reconnectBaseDelayMs: 100 });
		// The first attempt (which start() awaits) succeeds; the drop happens after.
		const error = await expectError(stream.exit);
		expect(error.code).toBe("network");
		expect(calls.length).toBe(2); // initial + one reattach
		expect(sleep).toHaveBeenCalledWith(100);
	});

	it("re-auths once per attempt when the stream attempt answers 401", async () => {
		const { mock, calls } = fetchRouter([
			() => jsonResponse(401, { code: "unauthenticated", message: "expired" }),
			() => streamResponse(env(startEvent(PID)), env(endEvent({ exitCode: 0 }))),
			() => jsonResponse(401, { code: "unauthenticated", message: "expired" }),
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
		const { mock, calls } = fetchRouter([
			() => new Response("nope", { status: 200, headers: { "Content-Type": "text/plain" } }),
		]);
		const client = makeClient(mock);
		const error = await expectError(client.start(startRequest, { sleepFn: noSleep, maxReconnects: 0 }));
		expect(error.code).toBe("invalid_response");
		expect(calls.length).toBe(1);
	});

	it("bounds frame size and aborts on oversize frames", async () => {
		const big = envelope(new Uint8Array(64 * 1024).fill(0x41));
		const { mock } = fetchRouter([
			() => streamResponse(env(startEvent(PID)), env(big)),
			() => streamResponse(env(startEvent(PID)), env(endEvent({ exitCode: 0 }))),
		]);
		const client = makeClient(mock, { maxEventFrameBytes: 32 * 1024 });
		const stream = await client.start(startRequest, { sleepFn: noSleep });
		const error = await expectError(stream.exit);
		expect(error.code).toBe("too_large");
	});

	it("rejects compressed frames it never negotiated", async () => {
		const { mock } = fetchRouter([() => streamResponse(env(startEvent(PID)), env(startEvent(PID), 0x01))]);
		const client = makeClient(mock);
		const stream = await client.start(startRequest, { sleepFn: noSleep });
		const error = await expectError(stream.exit);
		expect(error.code).toBe("invalid_response");
	});

	it("treats a truncated frame at EOF as a recoverable network fault", async () => {
		const truncated = env(startEvent(PID)).slice(0, 9); // header promises more payload bytes than delivered
		const { mock, calls } = fetchRouter([
			() => streamResponse(env(startEvent(PID)), truncated),
			() => streamResponse(env(startEvent(PID)), env(endEvent({ exitCode: 0 }))),
		]);
		const client = makeClient(mock);
		const stream = await client.start(startRequest, { sleepFn: noSleep });
		await expect(stream.exit).resolves.toMatchObject({ exitCode: 0 });
		expect(calls.length).toBe(2);
	});

	it("surfaces end-of-stream error frames with their Connect code", async () => {
		const { mock, calls } = fetchRouter([
			() => streamResponse(env(startEvent(PID))),
			() =>
				streamResponse(
					env(startEvent(PID)),
					endOfStream({ error: { code: "not_found", message: "session expired" } }),
				),
		]);
		const client = makeClient(mock);
		const stream = await client.start(startRequest, { sleepFn: noSleep });
		const error = await expectError(stream.exit);
		expect(error.code).toBe("not_found");
		expect(error.message).toBe("session expired");
		expect(calls.length).toBe(2);
	});

	it("stops reading while the consumer is behind, then resumes (backpressure)", async () => {
		const frames = [env(startEvent(PID))];
		for (let index = 0; index < 5; index++) {
			frames.push(env(dataEvent("stdout", Uint8Array.of(index))));
		}
		frames.push(env(endEvent({ exitCode: 0 })));
		let pulls = 0;
		let position = 0;
		const { mock } = fetchRouter([
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
		const client = makeClient(mock);
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
		const { mock, calls } = fetchRouter([() => unaryOk()]);
		const client = makeClient(mock);
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
		const sessionField = [...tfields(selector?.bytes ?? new Uint8Array(0))].find((f) => f.field === 3);
		expect(new TextDecoder().decode(sessionField?.bytes ?? new Uint8Array(0))).toBe(SESSION_UUID);
		const input = fields.find((f) => f.field === 2);
		const stdinField = [...tfields(input?.bytes ?? new Uint8Array(0))].find((f) => f.field === 1);
		expect([...(stdinField?.bytes ?? new Uint8Array(0))]).toEqual([0xde, 0xad]);
		const keyField = fields.find((f) => f.field === 3);
		expect(new TextDecoder().decode(keyField?.bytes ?? new Uint8Array(0))).toBe(inputUuid);
	});

	it("sendInput writes to the pty channel when asked", async () => {
		const { mock, calls } = fetchRouter([() => unaryOk()]);
		const client = makeClient(mock);
		await client.sendInput(SESSION_UUID, "pty", new Uint8Array([0x0d]));
		const input = [...tfields(bodyBytes(calls[0].init))].find((f) => f.field === 2);
		const ptyField = [...tfields(input?.bytes ?? new Uint8Array(0))].find((f) => f.field === 2);
		expect(ptyField).toBeDefined();
	});

	it("sendInput retries transient faults with identical bytes and backoff", async () => {
		const { mock, calls } = fetchRouter([
			() => jsonResponse(503, { code: "unavailable", message: "gateway busy" }),
			() => jsonResponse(504, { code: "deadline_exceeded", message: "slow" }),
			() => unaryOk(),
		]);
		const sleep = vi.fn(noSleep);
		const client = makeClient(mock, { sleepFn: sleep });
		await client.sendInput(SESSION_UUID, "stdin", new Uint8Array([1]));
		expect(calls.length).toBe(3);
		expect(Buffer.from(bodyBytes(calls[0].init))).toEqual(Buffer.from(bodyBytes(calls[1].init)));
		expect(Buffer.from(bodyBytes(calls[1].init))).toEqual(Buffer.from(bodyBytes(calls[2].init)));
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenNthCalledWith(1, 500);
		expect(sleep).toHaveBeenNthCalledWith(2, 1000);
	});

	it("sendInput fails fast on permanent answers", async () => {
		const { mock, calls } = fetchRouter([
			() => jsonResponse(404, { code: "not_found", message: "process not found" }),
		]);
		const client = makeClient(mock);
		const error = await expectError(client.sendInput(SESSION_UUID, "stdin", new Uint8Array([1])));
		expect(error.code).toBe("not_found");
		expect(error.message).toBe("process not found");
		expect(calls.length).toBe(1);
	});

	it("sendInput refreshes auth once on 401, then surfaces the second", async () => {
		const { mock, calls } = fetchRouter([
			() => jsonResponse(401, { code: "unauthenticated", message: "expired" }),
			() => jsonResponse(401, { code: "unauthenticated", message: "expired again" }),
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
		const { mock, calls } = fetchRouter([() => unaryOk()]);
		const client = makeClient(mock);
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
			const { mock, calls } = fetchRouter([() => response]);
			const client = makeClient(mock);
			const error = await expectError(client.sendInput(SESSION_UUID, "stdin", new Uint8Array([1])));
			expect(error.code).toBe("invalid_response");
			expect(calls.length).toBe(1);
		}
	});

	it("sendSignal encodes terminate as 15 and kill as 9 with a key", async () => {
		const { mock, calls } = fetchRouter([() => unaryOk(), () => unaryOk()]);
		const client = makeClient(mock);
		const signalUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		await client.sendSignal(SESSION_UUID, "terminate", { signalUuid });
		await client.sendSignal(SESSION_UUID, "kill", { signalUuid });
		expect(calls[0].url).toBe(rpcUrl("SendSignal"));
		const termField = [...tfields(bodyBytes(calls[0].init))].find((f) => f.field === 2);
		expect(termField?.varint).toBe(15);
		const keyField = [...tfields(bodyBytes(calls[0].init))].find((f) => f.field === 3);
		expect(new TextDecoder().decode(keyField?.bytes ?? new Uint8Array(0))).toBe(signalUuid);
		const killField = [...tfields(bodyBytes(calls[1].init))].find((f) => f.field === 2);
		expect(killField?.varint).toBe(9);
	});

	it("resize encodes an Update with the PTY size", async () => {
		const { mock, calls } = fetchRouter([() => unaryOk()]);
		const client = makeClient(mock);
		await client.resize(SESSION_UUID, { cols: 120, rows: 40 });
		expect(calls[0].url).toBe(rpcUrl("Update"));
		const fields = [...tfields(bodyBytes(calls[0].init))];
		const pty = fields.find((f) => f.field === 2);
		const size = [...tfields(pty?.bytes ?? new Uint8Array(0))].find((f) => f.field === 1);
		const colsField = [...tfields(size?.bytes ?? new Uint8Array(0))].find((f) => f.field === 1);
		const rowsField = [...tfields(size?.bytes ?? new Uint8Array(0))].find((f) => f.field === 2);
		expect(colsField?.varint).toBe(120);
		expect(rowsField?.varint).toBe(40);
	});

	it("maps gateway-shaped errors and never leaks the token", async () => {
		const { mock } = fetchRouter([
			() => jsonResponse(502, { error: "sandbox_not_found", message: `token ${TOKEN} in body` }),
		]);
		const client = makeClient(mock);
		const error = await expectError(client.sendInput(SESSION_UUID, "stdin", new Uint8Array([1])));
		expect(error.code).toBe("sandbox_not_found");
		expect(error.message).not.toContain(TOKEN);
		expect(error.details).not.toContain(TOKEN);
	});

	it("maps non-JSON HTTP errors by status", async () => {
		const { mock } = fetchRouter([
			() => new Response("boom", { status: 500, headers: { "Content-Type": "text/plain" } }),
		]);
		const client = makeClient(mock);
		const error = await expectError(client.sendInput(SESSION_UUID, "stdin", new Uint8Array([1])));
		expect(error.code).toBe("internal");
		expect(error.status).toBe(500);
	});
});
