import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	copySandboxRuntimeReadiness,
	createPrimeSandboxProviderPort,
	type PrimeSandboxProviderPort,
	type SandboxFetchPort,
	type SandboxRuntimeConnectPort,
} from "../src/modes/daemon/sandbox/prime-sandbox-provider.js";
import type { SandboxTcpIo } from "../src/modes/daemon/sandbox/prime-sandbox-tcp.js";
import { prepareFileUpload, type SandboxArtifactKind } from "../src/modes/daemon/sandbox/prime-sandbox-upload-body.js";

const API_KEY = "pi_test_control_key";
const SANDBOX_ID = "sb_abcdef012345";
const TOKEN = "gateway.token-value_123";
const roots: string[] = [];

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function authResponse(overrides: Readonly<Record<string, unknown>> = {}): Response {
	return jsonResponse({
		gateway_url: "https://gateway.example.com/base/",
		user_ns: "user_ns",
		job_id: "job_123",
		token: TOKEN,
		expires_at: "2099-09-04T12:30:00Z",
		is_vm: false,
		...overrides,
	});
}

function exposureRow(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
	return Object.freeze({
		exposure_id: "exp_abcdef",
		sandbox_id: SANDBOX_ID,
		port: 9443,
		name: "prime-agent-runtime-v1",
		url: "",
		tls_socket: "",
		protocol: "TCP",
		external_port: 23456,
		external_endpoint: "runtime.example.com:23456",
		created_at: "2099-09-04T12:30:00Z",
		...overrides,
	});
}

function headers(init: RequestInit): Headers {
	return new Headers(init.headers);
}

async function bodyBytes(init: RequestInit): Promise<Uint8Array> {
	const body = init.body;
	if (body === undefined || body === null) return new Uint8Array(0);
	if (body instanceof Uint8Array) {
		const copy = new Uint8Array(body.byteLength);
		copy.set(body);
		return copy;
	}
	if (body instanceof ReadableStream) return new Uint8Array(await new Response(body).arrayBuffer());
	throw new Error("unexpected test request body");
}

async function artifact(kind: SandboxArtifactKind, bytes: Uint8Array) {
	const directory = await mkdtemp(join(tmpdir(), "prime-provider-test-"));
	roots.push(directory);
	const path = join(directory, "runtime.tar.gz");
	await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
	await chmod(path, 0o600);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const result = await prepareFileUpload(kind, path, bytes.byteLength, digest);
	if (!result.ok) throw new Error(result.code);
	return result.value;
}

async function archive(bytes: Uint8Array) {
	return artifact("release", bytes);
}

function readinessLine(): string {
	const key = `${"A".repeat(43)}=`;
	const signature = `${"A".repeat(86)}==`;
	return `BUNDLE v3 ${key} ${key} ${key} ${key} ${key} ${key} ${signature}`;
}

function provider(dispatch: SandboxFetchPort, connect?: SandboxRuntimeConnectPort): PrimeSandboxProviderPort {
	const result = createPrimeSandboxProviderPort(API_KEY, SANDBOX_ID, dispatch, connect);
	if (!result.ok) throw new Error(result.code);
	return result.value;
}

afterEach(async () => {
	while (roots.length > 0) {
		const path = roots.pop();
		if (path !== undefined) await rm(path, { force: true, recursive: true });
	}
});

describe("Home-private Prime Sandbox provider adapter", () => {
	test("rejects malformed factory inputs", () => {
		const dispatch: SandboxFetchPort = async () => jsonResponse({});
		expect(createPrimeSandboxProviderPort("", SANDBOX_ID, dispatch)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(createPrimeSandboxProviderPort(API_KEY, "sandbox", dispatch)).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
	});

	test("requires a complete exposure absence proof before close", async () => {
		let calls = 0;
		const port = provider(async (url, init) => {
			calls += 1;
			expect(url).toBe(`${"https://api.primeintellect.ai"}/api/v1/sandbox/${SANDBOX_ID}/expose`);
			expect(init.method).toBe("GET");
			return jsonResponse({ exposures: [] });
		});
		expect(await port.close()).toEqual({ ok: false, code: "ABSENCE_UNPROVEN" });
		expect(await port.unexposeAndProveAbsent()).toEqual({ ok: true });
		expect(await port.close()).toEqual({ ok: true });
		expect(calls).toBe(1);
	});

	test("authenticates on the control plane and streams the exact gateway upload", async () => {
		const file = new Uint8Array(2 * 64 * 1024 + 19);
		for (let index = 0; index < file.byteLength; index += 1) file[index] = index % 251;
		const source = await archive(file);
		let calls = 0;
		const port = provider(async (url, init) => {
			calls += 1;
			if (calls === 1) {
				expect(url).toBe(`https://api.primeintellect.ai/api/v1/sandbox/${SANDBOX_ID}/auth`);
				expect(init.method).toBe("POST");
				expect(headers(init).get("authorization")).toBe(`Bearer ${API_KEY}`);
				expect((await bodyBytes(init)).byteLength).toBe(0);
				return authResponse();
			}
			if (calls === 2) {
				const parsed = new URL(url);
				expect(`${parsed.origin}${parsed.pathname}`).toBe(
					"https://gateway.example.com/base/user_ns/job_123/upload",
				);
				expect(parsed.searchParams.get("path")).toBe("/tmp/prime-agent-runtime.tar.gz");
				expect(parsed.searchParams.get("sandbox_id")).toBe(SANDBOX_ID);
				expect(init.method).toBe("POST");
				expect(headers(init).get("authorization")).toBe(`Bearer ${TOKEN}`);
				expect(headers(init).get("content-type")).toMatch(/^multipart\/form-data; boundary=prime-agent-/);
				const received = await bodyBytes(init);
				expect(headers(init).get("content-length")).toBe(String(received.byteLength));
				expect(received.byteLength).toBeGreaterThan(file.byteLength);
				return jsonResponse({
					success: true,
					path: "/tmp/prime-agent-runtime.tar.gz",
					size: file.byteLength,
					timestamp: "2099-09-04T12:30:00Z",
				});
			}
			expect(init.method).toBe("GET");
			return jsonResponse({ exposures: [] });
		});
		expect(await port.uploadRelease(source)).toEqual({ ok: true });
		expect(await port.unexposeAndProveAbsent()).toEqual({ ok: true });
		expect(await port.close()).toEqual({ ok: true });
		expect(calls).toBe(3);
	});

	test("uploads each small public artifact only to its fixed path", async () => {
		const specs: readonly Readonly<{
			kind: SandboxArtifactKind;
			path: string;
			fileName: string;
		}>[] = [
			{
				kind: "manifest",
				path: "/tmp/prime-agent-runtime.manifest.json",
				fileName: "prime-agent-runtime.manifest.json",
			},
			{ kind: "bootstrap", path: "/tmp/prime-agent-bootstrap.pyz", fileName: "prime-agent-bootstrap.pyz" },
			{
				kind: "trust",
				path: "/tmp/prime-agent-bootstrap-trust.json",
				fileName: "prime-agent-bootstrap-trust.json",
			},
		];
		for (const spec of specs) {
			const bytes = new TextEncoder().encode(`public-${spec.kind}`);
			const source = await artifact(spec.kind, bytes);
			let calls = 0;
			const port = provider(async (url, init) => {
				calls += 1;
				if (calls === 1) return authResponse();
				const parsed = new URL(url);
				expect(parsed.searchParams.get("path")).toBe(spec.path);
				const received = await bodyBytes(init);
				expect(new TextDecoder().decode(received)).toContain(`filename="${spec.fileName}"`);
				return jsonResponse({
					success: true,
					path: spec.path,
					size: bytes.byteLength,
					timestamp: "2099-09-04T12:30:00Z",
				});
			});
			const result =
				spec.kind === "manifest"
					? await port.uploadManifest(source)
					: spec.kind === "bootstrap"
						? await port.uploadBootstrap(source)
						: await port.uploadTrust(source);
			expect(result).toEqual({ ok: true });
			expect(calls).toBe(2);
		}
	});

	test("does not consume a prepared artifact through the wrong operation", async () => {
		const bytes = new TextEncoder().encode("public-trust");
		const source = await artifact("trust", bytes);
		let calls = 0;
		const port = provider(async (url, init) => {
			calls += 1;
			if (calls === 1) return authResponse();
			await bodyBytes(init);
			return jsonResponse({
				success: true,
				path: new URL(url).searchParams.get("path"),
				size: bytes.byteLength,
				timestamp: "2099-09-04T12:30:00Z",
			});
		});
		expect(await port.uploadRelease(source)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(await port.uploadTrust(source)).toEqual({ ok: true });
		expect(calls).toBe(2);
	});

	test("pre-abort is definitely not sent and the prepared body is settled", async () => {
		const source = await archive(new Uint8Array([1, 2, 3]));
		let calls = 0;
		const port = provider(async () => {
			calls += 1;
			return authResponse();
		});
		const controller = new AbortController();
		controller.abort();
		expect(await port.uploadRelease(source, controller.signal)).toEqual({ ok: false, code: "NOT_SENT" });
		expect(calls).toBe(0);
	});

	test("does not retry a synchronous post-dispatch failure", async () => {
		const source = await archive(new Uint8Array([1, 2, 3]));
		let calls = 0;
		const port = provider(() => {
			calls += 1;
			throw new Error("private transport failure");
		});
		expect(await port.uploadRelease(source)).toEqual({ ok: false, code: "AMBIGUOUS" });
		expect(calls).toBe(1);
	});

	test("rejects malformed auth and upload responses without retry", async () => {
		for (const mode of ["auth", "upload"]) {
			const source = await archive(new Uint8Array([5, 6, 7]));
			let calls = 0;
			const port = provider(async (_url, init) => {
				calls += 1;
				if (calls === 1) {
					return mode === "auth" ? authResponse({ extra: true }) : authResponse();
				}
				await bodyBytes(init);
				return jsonResponse({
					success: true,
					path: "/tmp/prime-agent-runtime.tar.gz",
					size: 999,
					timestamp: "2099-09-04T12:30:00Z",
				});
			});
			expect(await port.uploadRelease(source)).toEqual({ ok: false, code: "INVALID_RESPONSE" });
			expect(calls).toBe(mode === "auth" ? 1 : 2);
		}
	});

	test("runs only the fixed bootstrap command once and returns nominal readiness", async () => {
		let calls = 0;
		const line = readinessLine();
		const port = provider(async (url, init) => {
			calls += 1;
			if (calls === 1) return authResponse();
			if (calls === 2) {
				expect(url).toBe("https://gateway.example.com/base/user_ns/job_123/exec");
				expect(init.method).toBe("POST");
				expect(headers(init).get("authorization")).toBe(`Bearer ${TOKEN}`);
				const body = await bodyBytes(init);
				expect(headers(init).get("content-length")).toBe(String(body.byteLength));
				expect(new TextDecoder().decode(body)).toBe(
					`{"command":"/usr/local/bin/python3.11 /tmp/prime-agent-bootstrap.pyz","working_dir":null,"env":{},"sandbox_id":"${SANDBOX_ID}","timeout":180}`,
				);
				return jsonResponse({ stdout: `${line}\n`, stderr: "", exit_code: 0 });
			}
			return jsonResponse({ exposures: [] });
		});
		const launched = await port.bootstrapAndLaunch();
		expect(launched.ok).toBe(true);
		if (launched.ok) {
			const copied = copySandboxRuntimeReadiness(launched.value);
			expect(copied).toBeDefined();
			if (copied !== undefined) expect(new TextDecoder().decode(copied)).toBe(line);
			expect(copySandboxRuntimeReadiness(Object.freeze({}))).toBeUndefined();
		}
		expect(await port.bootstrapAndLaunch()).toEqual({ ok: false, code: "LAUNCH_ALREADY_ATTEMPTED" });
		expect(await port.unexposeAndProveAbsent()).toEqual({ ok: true });
		expect(await port.close()).toEqual({ ok: true });
		expect(calls).toBe(3);
	});

	test("a definitely-not-sent launch does not consume the one-shot claim", async () => {
		let calls = 0;
		const port = provider(async () => {
			calls += 1;
			return jsonResponse({});
		});
		const controller = new AbortController();
		controller.abort();
		expect(await port.bootstrapAndLaunch(controller.signal)).toEqual({ ok: false, code: "NOT_SENT" });
		expect(await port.bootstrapAndLaunch()).toEqual({ ok: false, code: "INVALID_RESPONSE" });
		expect(calls).toBe(1);
	});

	test("rejects noncanonical and non-exact readiness output", async () => {
		const canonical = readinessLine();
		const invalidBase64 = canonical.replace(`${"A".repeat(43)}=`, `${"A".repeat(42)}B=`);
		for (const stdout of [`${invalidBase64}\n`, `${canonical}\n\n`, `${canonical}\ntrailing`]) {
			let calls = 0;
			const port = provider(async () => {
				calls += 1;
				return calls === 1 ? authResponse() : jsonResponse({ stdout, stderr: "", exit_code: 0 });
			});
			expect(await port.bootstrapAndLaunch()).toEqual({ ok: false, code: "INVALID_RESPONSE" });
			expect(await port.bootstrapAndLaunch()).toEqual({ ok: false, code: "LAUNCH_ALREADY_ATTEMPTED" });
			expect(calls).toBe(2);
		}
	});

	test("a completed failing bootstrap is never executed twice", async () => {
		let calls = 0;
		const port = provider(async () => {
			calls += 1;
			return calls === 1 ? authResponse() : jsonResponse({ stdout: "", stderr: "failed", exit_code: 1 });
		});
		expect(await port.bootstrapAndLaunch()).toEqual({ ok: false, code: "COMMAND_FAILED" });
		expect(await port.bootstrapAndLaunch()).toEqual({ ok: false, code: "LAUNCH_ALREADY_ATTEMPTED" });
		expect(calls).toBe(2);
	});

	test("rejects an overlapping private runtime connection attempt", async () => {
		let stage = 0;
		const dispatch: SandboxFetchPort = async () => {
			stage += 1;
			if (stage === 1) return jsonResponse({ exposures: [] });
			if (stage === 2) return jsonResponse(exposureRow());
			if (stage === 3) return jsonResponse({});
			return jsonResponse({ exposures: [] });
		};
		let resolveConnect: ((value: Readonly<{ ok: true; value: SandboxTcpIo }>) => void) | undefined;
		const io: SandboxTcpIo = Object.freeze({
			async readClassified() {
				return Object.freeze({ type: "IO_FAILURE" });
			},
			async readExact() {
				return undefined;
			},
			async writeExact() {
				return false;
			},
			close() {},
			async waitClosed() {},
		});
		const connect: SandboxRuntimeConnectPort = async () =>
			await new Promise<Readonly<{ ok: true; value: SandboxTcpIo }>>((resolve) => {
				resolveConnect = resolve;
			});
		const port = provider(dispatch, connect);
		expect(await port.exposeRuntime()).toEqual({ ok: true });
		const first = port.connectRuntime();
		expect(await port.connectRuntime()).toEqual({ ok: false, code: "CONNECT_FAILED" });
		resolveConnect?.(Object.freeze({ ok: true, value: io }));
		expect(await first).toEqual({ ok: true, value: io });
		expect(await port.unexposeAndProveAbsent()).toEqual({ ok: true });
		expect(await port.close()).toEqual({ ok: true });
		expect(stage).toBe(4);
	});

	test("connects through the private exposure without returning endpoint metadata", async () => {
		let stage = 0;
		const dispatch: SandboxFetchPort = async (url, init) => {
			stage += 1;
			if (stage === 1) {
				expect(init.method).toBe("GET");
				return jsonResponse({ exposures: [] });
			}
			if (stage === 2) {
				expect(init.method).toBe("POST");
				return jsonResponse(exposureRow());
			}
			if (stage === 3) {
				expect(init.method).toBe("DELETE");
				return jsonResponse({});
			}
			expect(stage).toBe(4);
			expect(url).toBe(`${"https://api.primeintellect.ai"}/api/v1/sandbox/${SANDBOX_ID}/expose`);
			return jsonResponse({ exposures: [] });
		};
		let connectedHost = "";
		let connectedPort = 0;
		let closed = false;
		let resolveClosed: (() => void) | undefined;
		const closedPromise = new Promise<void>((resolve) => {
			resolveClosed = resolve;
		});
		const io: SandboxTcpIo = Object.freeze({
			async readClassified() {
				return Object.freeze({ type: "IO_FAILURE" });
			},
			async readExact() {
				return undefined;
			},
			async writeExact() {
				return false;
			},
			close() {
				if (closed) return;
				closed = true;
				resolveClosed?.();
			},
			async waitClosed() {
				await closedPromise;
			},
		});
		const connect: SandboxRuntimeConnectPort = async (host, port) => {
			if (typeof host !== "string" || typeof port !== "number") return { ok: false, code: "INPUT_INVALID" };
			connectedHost = host;
			connectedPort = port;
			return { ok: true, value: io };
		};
		const port = provider(dispatch, connect);
		expect(await port.connectRuntime()).toEqual({ ok: false, code: "CONNECT_FAILED" });
		expect(await port.exposeRuntime()).toEqual({ ok: true });
		const connected = await port.connectRuntime();
		expect(connected).toEqual({ ok: true, value: io });
		expect(connectedHost).toBe("runtime.example.com");
		expect(connectedPort).toBe(23456);
		expect(Object.hasOwn(connected, "host")).toBe(false);
		expect(Object.hasOwn(connected, "port")).toBe(false);
		expect(await port.connectRuntime()).toEqual({ ok: false, code: "CONNECT_FAILED" });
		expect(await port.unexposeAndProveAbsent()).toEqual({ ok: true });
		expect(closed).toBe(true);
		expect(await port.close()).toEqual({ ok: true });
		expect(stage).toBe(4);
	});

	test("exposes fixed TCP 9443 then unexposes and proves zero matches", async () => {
		let calls = 0;
		const port = provider(async (url, init) => {
			calls += 1;
			if (calls === 1) {
				expect(init.method).toBe("GET");
				return jsonResponse({ exposures: [] });
			}
			if (calls === 2) {
				expect(init.method).toBe("POST");
				expect(url).toBe(`https://api.primeintellect.ai/api/v1/sandbox/${SANDBOX_ID}/expose`);
				expect(new TextDecoder().decode(await bodyBytes(init))).toBe(
					'{"port":9443,"name":"prime-agent-runtime-v1","protocol":"TCP"}',
				);
				return jsonResponse(exposureRow());
			}
			if (calls === 3) {
				expect(init.method).toBe("DELETE");
				expect(url).toBe(`https://api.primeintellect.ai/api/v1/sandbox/${SANDBOX_ID}/expose/exp_abcdef`);
				return new Response(null, { status: 204 });
			}
			expect(init.method).toBe("GET");
			return jsonResponse({ exposures: [] });
		});
		expect(await port.exposeRuntime()).toEqual({ ok: true });
		expect(await port.close()).toEqual({ ok: false, code: "ABSENCE_UNPROVEN" });
		expect(await port.unexposeAndProveAbsent()).toEqual({ ok: true });
		expect(await port.close()).toEqual({ ok: true });
		expect(calls).toBe(4);
	});

	test("recovers one exact existing exposure for deletion", async () => {
		let calls = 0;
		const port = provider(async (_url, init) => {
			calls += 1;
			if (calls === 1) return jsonResponse({ exposures: [exposureRow()] });
			if (calls === 2) {
				expect(init.method).toBe("DELETE");
				return new Response(null, { status: 204 });
			}
			return jsonResponse({ exposures: [] });
		});
		expect(await port.unexposeAndProveAbsent()).toEqual({ ok: true });
		expect(await port.close()).toEqual({ ok: true });
		expect(calls).toBe(3);
	});

	test("recovery accepts audited nullable optional exposure fields", async () => {
		let calls = 0;
		const nullable = exposureRow({
			protocol: null,
			external_port: null,
			external_endpoint: null,
			created_at: null,
		});
		const port = provider(async () => {
			calls += 1;
			if (calls === 1) return jsonResponse({ exposures: [nullable] });
			if (calls === 2) return new Response(null, { status: 204 });
			return jsonResponse({ exposures: [] });
		});
		expect(await port.unexposeAndProveAbsent()).toEqual({ ok: true });
		expect(await port.close()).toEqual({ ok: true });
	});

	test("blocks conflicting or duplicate exposure state without deleting it", async () => {
		for (const rows of [
			[exposureRow({ name: "other" })],
			[exposureRow(), exposureRow({ exposure_id: "exp_second" })],
		]) {
			let calls = 0;
			const port = provider(async () => {
				calls += 1;
				return jsonResponse({ exposures: rows });
			});
			expect(await port.unexposeAndProveAbsent()).toEqual({ ok: false, code: "ABSENCE_UNPROVEN" });
			expect(calls).toBe(1);
		}
	});

	test("rejects an invalid exposed endpoint and keeps absence unproven", async () => {
		let calls = 0;
		const port = provider(async () => {
			calls += 1;
			return calls === 1
				? jsonResponse({ exposures: [] })
				: jsonResponse(exposureRow({ external_endpoint: "runtime.example.com:65536" }));
		});
		expect(await port.exposeRuntime()).toEqual({ ok: false, code: "INVALID_RESPONSE" });
		expect(await port.close()).toEqual({ ok: false, code: "ABSENCE_UNPROVEN" });
	});

	test("caller abort settles an in-flight fetch before returning", async () => {
		let calls = 0;
		const port = provider(async (_url, init) => {
			calls += 1;
			if (calls > 1) return jsonResponse({ exposures: [] });
			return new Promise<Response>((_resolve, reject) => {
				const signal = init.signal;
				if (signal === null || signal === undefined) return reject(new Error("missing signal"));
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		});
		const controller = new AbortController();
		const pending = port.unexposeAndProveAbsent(controller.signal);
		await Promise.resolve();
		controller.abort();
		expect(await pending).toEqual({ ok: false, code: "ABORTED" });
		expect(await port.unexposeAndProveAbsent()).toEqual({ ok: true });
		expect(await port.close()).toEqual({ ok: true });
		expect(calls).toBe(2);
	});

	test("early close aborts active operations but preserves later unexpose", async () => {
		let calls = 0;
		const port = provider(async (_url, init) => {
			calls += 1;
			if (calls > 1) return jsonResponse({ exposures: [] });
			return new Promise<Response>((_resolve, reject) => {
				const signal = init.signal;
				if (signal === null || signal === undefined) return reject(new Error("missing signal"));
				signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
			});
		});
		const pending = port.unexposeAndProveAbsent();
		await Promise.resolve();
		expect(await port.close()).toEqual({ ok: false, code: "ABSENCE_UNPROVEN" });
		expect(await pending).toEqual({ ok: false, code: "CLOSED" });
		expect(await port.unexposeAndProveAbsent()).toEqual({ ok: true });
		expect(await port.close()).toEqual({ ok: true });
		expect(calls).toBe(2);
	});

	test("cancels a non-2xx response body and does not retry", async () => {
		let cancelled = false;
		let calls = 0;
		const port = provider(async () => {
			calls += 1;
			const stream = new ReadableStream<Uint8Array>({
				cancel() {
					cancelled = true;
				},
			});
			return new Response(stream, { status: 503 });
		});
		expect(await port.unexposeAndProveAbsent()).toEqual({ ok: false, code: "HTTP_STATUS" });
		expect(calls).toBe(1);
		expect(cancelled).toBe(true);
	});

	test("rejects an oversized bounded response before JSON parsing", async () => {
		const oversized = new Uint8Array(1024 * 1024 + 1);
		const port = provider(async () => new Response(oversized));
		expect(await port.unexposeAndProveAbsent()).toEqual({ ok: false, code: "BODY_TOO_LARGE" });
	});
});
