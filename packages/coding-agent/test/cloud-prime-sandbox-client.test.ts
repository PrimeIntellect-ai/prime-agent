import { describe, expect, it } from "vitest";
import {
	MAX_EXEC_TIMEOUT_SECONDS,
	MAX_TRANSFER_BYTES,
	PRIME_SANDBOX_CREATE_MAX_ATTEMPTS,
	type PrimeSandboxAuth,
	PrimeSandboxClient,
	PrimeSandboxError,
	type PrimeSandboxVmCreateRequest,
} from "../src/core/cloud/prime-sandbox-client.js";
import {
	expectErrorOf,
	type FetchMock,
	type FetchResponder,
	fetchRecorder,
	formOf,
	headerOf,
	jsonBodyOf,
	jsonResponse,
} from "./cloud-prime-api-fakes.js";

const API_KEY = "prime-api-key-123";
const BASE_URL = "https://prime-api.example.com";
const GATEWAY_URL = "https://sandbox-gw.example.com";
const SANDBOX_ID = "sb-123.abc_def";

const expectError = (promise: Promise<unknown>) => expectErrorOf(promise, PrimeSandboxError);

const transientFailure = (): Response => {
	throw new Error("transient network failure");
};

function makeClient(fetchMock: FetchMock, options: Record<string, unknown> = {}): PrimeSandboxClient {
	return new PrimeSandboxClient({
		apiKey: API_KEY,
		baseUrl: BASE_URL,
		fetchFn: fetchMock as unknown as typeof fetch,
		...options,
	});
}

/** A client over a recorded fetch that answers from the responder list (the last repeats). */
function clientOver(responders: FetchResponder[], options: Record<string, unknown> = {}) {
	const { mock, calls } = fetchRecorder(responders);
	return { client: makeClient(mock, options), mock, calls };
}

function constructorFault(build: () => unknown): PrimeSandboxError | undefined {
	try {
		build();
	} catch (candidate) {
		return candidate as PrimeSandboxError;
	}
	return undefined;
}

/** The authoritative GET/create wire shape: camelCase with memoryGB/diskSizeGB. */
function sandboxBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: SANDBOX_ID,
		name: "worker-host",
		dockerImage: "ubuntu:24.04",
		startCommand: null,
		cpuCores: 4,
		memoryGB: 8,
		diskSizeGB: 20,
		diskMountPath: "/workspace",
		gpuCount: 0,
		gpuType: null,
		vm: true,
		network_allowlist: null,
		network_denylist: null,
		status: "RUNNING",
		timeoutMinutes: 120,
		idleTimeoutMinutes: null,
		terminationReason: null,
		environmentVars: null,
		secrets: null,
		labels: ["prime-agent:test"],
		createdAt: "2026-09-16T00:00:00Z",
		updatedAt: "2026-09-16T00:00:00Z",
		startedAt: "2026-09-16T00:01:00Z",
		terminatedAt: null,
		exitCode: null,
		errorType: null,
		errorMessage: null,
		userId: "user-1",
		teamId: "team-1",
		kubernetesJobId: "job-1",
		region: "us",
		registryCredentialsId: null,
		pendingImageBuildId: null,
		...overrides,
	};
}

function authBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		gateway_url: GATEWAY_URL,
		user_ns: "ns_user1",
		job_id: "job_abc",
		token: "gateway-token-xyz",
		expires_at: "2026-09-16T01:00:00Z",
		is_vm: true,
		...overrides,
	};
}

function auth(): PrimeSandboxAuth {
	return {
		sandboxId: SANDBOX_ID,
		gatewayUrl: GATEWAY_URL,
		userNamespace: "ns_user1",
		jobId: "job_abc",
		token: "gateway-token-xyz",
		expiresAt: "2026-09-16T01:00:00Z",
	};
}

function createRequest(): PrimeSandboxVmCreateRequest {
	return {
		name: "worker-host",
		dockerImage: "ubuntu:24.04",
		cpuCores: 4,
		memoryGb: 8,
		diskSizeGb: 20,
		timeoutMinutes: 120,
		labels: ["prime-agent:test"],
	};
}

function invalidCreate(overrides: Record<string, unknown>): PrimeSandboxVmCreateRequest {
	return { ...createRequest(), ...overrides } as PrimeSandboxVmCreateRequest;
}

describe("PrimeSandboxClient construction", () => {
	it.each([
		["requires a non-empty api key", () => new PrimeSandboxClient({ apiKey: "", baseUrl: BASE_URL })],
		[
			"rejects a zero request timeout",
			() => new PrimeSandboxClient({ apiKey: API_KEY, baseUrl: BASE_URL, requestTimeoutMs: 0 }),
		],
	])("%s", (_label, build) => {
		const caught = constructorFault(build);
		expect(caught).toBeInstanceOf(PrimeSandboxError);
		expect(caught?.code).toBe("invalid_request");
	});

	it("rejects non-https base URLs and URLs with credentials or query parts", () => {
		for (const baseUrl of [
			"ftp://prime-api.example.com",
			"http://prime-api.example.com",
			"https://user:pass@prime-api.example.com",
			"https://prime-api.example.com/base?x=1",
			"https://prime-api.example.com/base#frag",
			"not a url",
		]) {
			const caught = constructorFault(() => new PrimeSandboxClient({ apiKey: API_KEY, baseUrl }));
			expect(caught, `expected ${baseUrl} to be rejected`).toBeInstanceOf(PrimeSandboxError);
			expect(caught?.code).toBe("invalid_request");
		}
	});

	it("allows plain http only for loopback hosts when allowInsecureLocalhost is set", () => {
		const loopbackBases = ["http://localhost:9000", "http://127.0.0.1:9000", "http://[::1]:9000"];
		for (const baseUrl of loopbackBases) {
			const withoutFlag = constructorFault(() => new PrimeSandboxClient({ apiKey: API_KEY, baseUrl }));
			expect(withoutFlag, `expected ${baseUrl} to require the flag`).toBeInstanceOf(PrimeSandboxError);
			expect(withoutFlag?.code).toBe("invalid_request");
			expect(() => new PrimeSandboxClient({ apiKey: API_KEY, baseUrl, allowInsecureLocalhost: true })).not.toThrow();
		}
		const remoteWithFlag = constructorFault(
			() => new PrimeSandboxClient({ apiKey: API_KEY, baseUrl: "http://example.com", allowInsecureLocalhost: true }),
		);
		expect(remoteWithFlag).toBeInstanceOf(PrimeSandboxError);
		expect(remoteWithFlag?.code).toBe("invalid_request");
	});

	it("normalizes base URLs given with or without the /api/v1 suffix", async () => {
		for (const baseUrl of [
			"https://prime-api.example.com",
			"https://prime-api.example.com/",
			"https://prime-api.example.com/api/v1",
			"https://prime-api.example.com/api/v1/",
		]) {
			const { mock, calls } = fetchRecorder([() => jsonResponse(sandboxBody())]);
			const client = new PrimeSandboxClient({
				apiKey: API_KEY,
				baseUrl,
				fetchFn: mock as unknown as typeof fetch,
			});
			await client.createVmSandbox(createRequest());
			expect(calls[0].url, `base ${baseUrl}`).toBe("https://prime-api.example.com/api/v1/sandbox");
		}
	});
});

describe("createVmSandbox", () => {
	it("posts a snake_case VM create body to /api/v1/sandbox with bearer auth", async () => {
		const { client, calls } = clientOver([() => jsonResponse(sandboxBody())], { teamId: "team-1" });
		const sandbox = await client.createVmSandbox({
			...createRequest(),
			startCommand: { executable: "/usr/bin/sleep", args: ["infinity"] },
			idleTimeoutMinutes: 30,
			environmentVars: { PRIME_TEAM_ID: "team-1" },
			secrets: { PRIME_API_KEY: "sk-live" },
		});
		expect(sandbox.id).toBe(SANDBOX_ID);
		expect(sandbox.memoryGb).toBe(8);
		expect(sandbox.diskSizeGb).toBe(20);
		expect(sandbox.vm).toBe(true);
		expect(sandbox.status).toBe("RUNNING");
		expect(calls.length).toBe(1);
		expect(calls[0].url).toBe(`${BASE_URL}/api/v1/sandbox`);
		expect(headerOf(calls[0].init).Authorization).toBe(`Bearer ${API_KEY}`);
		const body = jsonBodyOf(calls[0].init);
		expect(body).toMatchObject({
			name: "worker-host",
			docker_image: "ubuntu:24.04",
			cpu_cores: 4,
			memory_gb: 8,
			disk_size_gb: 20,
			gpu_count: 0,
			vm: true,
			timeout_minutes: 120,
			idle_timeout_minutes: 30,
			team_id: "team-1",
			start_command: { executable: "/usr/bin/sleep", args: ["infinity"] },
			environment_vars: { PRIME_TEAM_ID: "team-1" },
			secrets: { PRIME_API_KEY: "sk-live" },
			labels: ["prime-agent:test"],
		});
		expect(typeof body.idempotency_key).toBe("string");
		expect((body.idempotency_key as string).length).toBeGreaterThan(0);
		expect("region" in body).toBe(false);
	});

	it("reuses one idempotency key across transient-failure retries", async () => {
		const { client, calls } = clientOver([transientFailure, transientFailure, () => jsonResponse(sandboxBody())]);
		const sandbox = await client.createVmSandbox({ ...createRequest(), idempotencyKey: "key-42" });
		expect(sandbox.id).toBe(SANDBOX_ID);
		expect(calls.length).toBe(PRIME_SANDBOX_CREATE_MAX_ATTEMPTS);
		expect(calls.map((call) => jsonBodyOf(call.init).idempotency_key)).toEqual(["key-42", "key-42", "key-42"]);
	});

	it("accepts a max-length idempotency key and sends it verbatim", async () => {
		const { client, calls } = clientOver([() => jsonResponse(sandboxBody())]);
		const key = "k".repeat(128);
		await client.createVmSandbox({ ...createRequest(), idempotencyKey: key });
		expect(jsonBodyOf(calls[0].init).idempotency_key).toBe(key);
	});

	it("gives up after the retry budget and surfaces the last transient error", async () => {
		const { client, calls } = clientOver([transientFailure]);
		const error = await expectError(client.createVmSandbox(createRequest()));
		expect(error.code).toBe("network");
		expect(calls.length).toBe(PRIME_SANDBOX_CREATE_MAX_ATTEMPTS);
	});

	it("does not retry HTTP failures", async () => {
		const { client, calls } = clientOver([() => jsonResponse({ detail: "quota exceeded" }, 402)]);
		const error = await expectError(client.createVmSandbox(createRequest()));
		expect(error.code).toBe("http");
		expect(error.status).toBe(402);
		expect(calls.length).toBe(1);
	});

	it("times out without hanging when the fetch ignores the abort signal", async () => {
		const { client, calls } = clientOver([() => new Promise<Response>(() => {})], { requestTimeoutMs: 25 });
		const error = await expectError(client.createVmSandbox(createRequest()));
		expect(error.code).toBe("timeout");
		expect(calls.length).toBe(PRIME_SANDBOX_CREATE_MAX_ATTEMPTS);
	});

	it("rejects invalid create requests before fetching", async () => {
		const { client, calls } = clientOver([() => jsonResponse(sandboxBody())]);
		const cases: PrimeSandboxVmCreateRequest[] = [
			invalidCreate({ name: "" }),
			invalidCreate({ name: "x".repeat(101) }),
			invalidCreate({ name: "x", dockerImage: "has space" }),
			invalidCreate({ name: "x", dockerImage: "", cpuCores: 4 }),
			invalidCreate({ cpuCores: 0.05 }),
			invalidCreate({ cpuCores: 16.5 }),
			invalidCreate({ memoryGb: 0.05 }),
			invalidCreate({ memoryGb: 64.5 }),
			invalidCreate({ diskSizeGb: 0.05 }),
			invalidCreate({ diskSizeGb: 1000.5 }),
			invalidCreate({ gpuCount: 9 }),
			invalidCreate({ gpuCount: 1 }),
			invalidCreate({ gpuCount: 0, gpuType: "H200_141GB" }),
			invalidCreate({ timeoutMinutes: 0 }),
			invalidCreate({ timeoutMinutes: 1441 }),
			invalidCreate({ idleTimeoutMinutes: 0 }),
			invalidCreate({ idleTimeoutMinutes: 121 }),
			invalidCreate({ startCommand: { executable: "", args: [] } }),
			invalidCreate({ startCommand: { executable: "/bin/sh", args: ["-c", 42] as unknown as string[] } }),
			invalidCreate({ startCommand: { executable: "/bin/sh\0", args: [] } }),
			invalidCreate({ startCommand: { executable: "/bin/sh", args: ["a\0b"] } }),
			invalidCreate({ region: "us" }),
			invalidCreate({ labels: [""] }),
			invalidCreate({ labels: ["a".repeat(257)] }),
			invalidCreate({ environmentVars: { "1BAD": "v" } }),
			invalidCreate({ environmentVars: { GOOD_KEY: "v\0" } }),
			invalidCreate({ secrets: { GOOD_KEY: 123 as unknown as string } }),
			invalidCreate({ networkAllowlist: [], networkDenylist: ["a.com"] }),
			invalidCreate({ networkAllowlist: ["has space.com"] }),
			invalidCreate({ networkAllowlist: ["https://a.com"] }),
			invalidCreate({ networkAllowlist: ["a.com:443"] }),
			invalidCreate({ networkAllowlist: ["user@a.com"] }),
			invalidCreate({ networkAllowlist: ["a.com?q"] }),
			invalidCreate({ networkAllowlist: ["*"] }),
			invalidCreate({ networkAllowlist: ["a.*.com"] }),
			invalidCreate({ networkAllowlist: ["::1"] }),
			invalidCreate({ networkAllowlist: ["10.0.0.0/33"] }),
			invalidCreate({ networkAllowlist: ["a..com"] }),
			invalidCreate({ networkAllowlist: Array.from({ length: 257 }, () => "a.com") }),
			invalidCreate({ idempotencyKey: "" }),
			invalidCreate({ idempotencyKey: "-leading-dash" }),
			invalidCreate({ idempotencyKey: "a b" }),
			invalidCreate({ idempotencyKey: "a/b" }),
			invalidCreate({ idempotencyKey: "a\0b" }),
			invalidCreate({ idempotencyKey: "a".repeat(129) }),
		];
		for (const request of cases) {
			const error = await expectError(client.createVmSandbox(request));
			expect(error.code, `expected invalid_request for ${JSON.stringify(request)}`).toBe("invalid_request");
		}
		expect(calls.length).toBe(0);
	});

	it("accepts the documented egress entry grammar and sends it as snake_case", async () => {
		const { client, calls } = clientOver([() => jsonResponse(sandboxBody())]);
		await client.createVmSandbox({
			...createRequest(),
			networkAllowlist: ["api.pinference.ai", "*.example.com", "1.2.3.4", "10.0.0.0/8"],
		});
		const body = jsonBodyOf(calls[0].init);
		expect(body.network_allowlist).toEqual(["api.pinference.ai", "*.example.com", "1.2.3.4", "10.0.0.0/8"]);
		expect("network_denylist" in body).toBe(false);
	});

	it("allows an empty allowlist (deny all) and an empty denylist (allow all)", async () => {
		const allowNone = clientOver([() => jsonResponse(sandboxBody())]);
		await allowNone.client.createVmSandbox({ ...createRequest(), networkAllowlist: [] });
		expect(jsonBodyOf(allowNone.calls[0].init).network_allowlist).toEqual([]);

		const denyNone = clientOver([() => jsonResponse(sandboxBody())]);
		await denyNone.client.createVmSandbox({ ...createRequest(), networkDenylist: [] });
		expect(jsonBodyOf(denyNone.calls[0].init).network_denylist).toEqual([]);
	});

	it("rejects malformed 2xx create responses, including wrong memory/disk aliases", async () => {
		const wrongMemoryAlias = sandboxBody();
		delete wrongMemoryAlias.memoryGB;
		wrongMemoryAlias.memoryGb = 8;
		const wrongDiskAlias = sandboxBody();
		delete wrongDiskAlias.diskSizeGB;
		wrongDiskAlias.diskSizeGb = 20;
		const cases: Record<string, unknown>[] = [
			{ id: "sb_123" },
			wrongMemoryAlias,
			wrongDiskAlias,
			{ ...sandboxBody(), status: "EXPLODED" },
			{ ...sandboxBody(), vm: "true" },
			{ ...sandboxBody(), vm: null },
			{ ...sandboxBody(), createdAt: "not-a-date" },
			{ ...sandboxBody(), cpuCores: "4" },
			{ ...sandboxBody(), network_allowlist: "api.pinference.ai" },
			{ ...sandboxBody(), network_denylist: [42] },
		];
		for (const body of cases) {
			const { client } = clientOver([() => jsonResponse(body)]);
			const error = await expectError(client.createVmSandbox(createRequest()));
			expect(error.code, `expected invalid_response for ${JSON.stringify(body)}`).toBe("invalid_response");
		}
	});
});

describe("getSandbox", () => {
	it("fetches a sandbox by id from /api/v1/sandbox/{id} and parses egress fields", async () => {
		const { client, calls } = clientOver([
			() => jsonResponse(sandboxBody({ status: "PAUSED", network_allowlist: ["api.pinference.ai"] })),
		]);
		const sandbox = await client.getSandbox(SANDBOX_ID);
		expect(calls.length).toBe(1);
		expect(calls[0].url).toBe(`${BASE_URL}/api/v1/sandbox/${encodeURIComponent(SANDBOX_ID)}`);
		expect(headerOf(calls[0].init).Authorization).toBe(`Bearer ${API_KEY}`);
		expect(sandbox.status).toBe("PAUSED");
		// Egress lists are snake_case on the wire and camelCase on the model.
		expect(sandbox.networkAllowlist).toEqual(["api.pinference.ai"]);
		expect(sandbox.networkDenylist).toBeNull();
		expect(sandbox.region).toBe("us");
	});

	it("rejects unsafe sandbox ids before fetching", async () => {
		const { client, calls } = clientOver([() => jsonResponse(sandboxBody())]);
		for (const id of ["../sandbox", "a b", "", "a/b"]) {
			const error = await expectError(client.getSandbox(id));
			expect(error.code).toBe("invalid_request");
		}
		expect(calls.length).toBe(0);
	});
});

describe("deleteSandbox", () => {
	it("deletes a sandbox at /api/v1/sandbox/{id}", async () => {
		const { client, calls } = clientOver([() => jsonResponse({ deleted: true })]);
		await client.deleteSandbox(SANDBOX_ID);
		expect(calls[0].url).toBe(`${BASE_URL}/api/v1/sandbox/${encodeURIComponent(SANDBOX_ID)}`);
		expect(calls[0].init?.method).toBe("DELETE");
		expect(headerOf(calls[0].init).Authorization).toBe(`Bearer ${API_KEY}`);
	});

	it("treats an already-missing sandbox as an idempotent delete", async () => {
		const { client } = clientOver([() => jsonResponse({ error: "missing" }, 404)]);
		await expect(client.deleteSandbox(SANDBOX_ID)).resolves.toBeUndefined();
	});

	it("rejects non-object delete responses", async () => {
		const { client } = clientOver([() => jsonResponse("deleted")]);
		const error = await expectError(client.deleteSandbox(SANDBOX_ID));
		expect(error.code).toBe("invalid_response");
	});
});

describe("getSandboxAuth", () => {
	it("posts to /api/v1/sandbox/{id}/auth and parses the gateway credentials", async () => {
		const { client, calls } = clientOver([() => jsonResponse(authBody())]);
		const result = await client.getSandboxAuth(SANDBOX_ID);
		expect(calls[0].url).toBe(`${BASE_URL}/api/v1/sandbox/${encodeURIComponent(SANDBOX_ID)}/auth`);
		expect(calls[0].init?.method).toBe("POST");
		expect(headerOf(calls[0].init).Authorization).toBe(`Bearer ${API_KEY}`);
		expect(result).toEqual({
			sandboxId: SANDBOX_ID,
			gatewayUrl: GATEWAY_URL,
			userNamespace: "ns_user1",
			jobId: "job_abc",
			token: "gateway-token-xyz",
			expiresAt: "2026-09-16T01:00:00Z",
		});
	});

	it("rejects non-https gateway URLs except loopback with the explicit flag", async () => {
		const remote = fetchRecorder([() => jsonResponse(authBody({ gateway_url: "http://sandbox-gw.example.com" }))]);
		const error = await expectError(makeClient(remote.mock).getSandboxAuth(SANDBOX_ID));
		expect(error.code).toBe("invalid_response");

		const loopback = fetchRecorder([() => jsonResponse(authBody({ gateway_url: "http://[::1]:9393" }))]);
		const allowed = await makeClient(loopback.mock, { allowInsecureLocalhost: true }).getSandboxAuth(SANDBOX_ID);
		expect(allowed.gatewayUrl).toBe("http://[::1]:9393");
		const denied = await expectError(makeClient(loopback.mock).getSandboxAuth(SANDBOX_ID));
		expect(denied.code).toBe("invalid_response");
	});

	it("rejects gateway URLs with query parts and unsafe namespace segments", async () => {
		for (const overrides of [{ gateway_url: "https://gw.example.com?x=1" }, { user_ns: "a/b" }, { job_id: "b c" }]) {
			const { client } = clientOver([() => jsonResponse(authBody(overrides))]);
			const error = await expectError(client.getSandboxAuth(SANDBOX_ID));
			expect(error.code).toBe("invalid_response");
		}
	});

	it("rejects auth responses missing required fields", async () => {
		const body = authBody();
		const { token, ...withoutToken } = body;
		void token;
		const { client } = clientOver([() => jsonResponse(withoutToken)]);
		const error = await expectError(client.getSandboxAuth(SANDBOX_ID));
		expect(error.code).toBe("invalid_response");
	});
});

describe("execContainerCommand", () => {
	it("fetches auth then posts a snake_case exec body to the gateway", async () => {
		const { client, calls } = clientOver([
			(record) =>
				record.url.endsWith("/auth")
					? jsonResponse(authBody())
					: jsonResponse({ stdout: "ok", stderr: "", exit_code: 0 }),
		]);
		const result = await client.execContainerCommand(SANDBOX_ID, {
			command: "uname -a",
			workingDir: "/workspace",
			env: { A: "b" },
			timeoutSeconds: 60,
		});
		expect(result).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
		expect(calls.map((call) => call.url)).toEqual([
			`${BASE_URL}/api/v1/sandbox/${encodeURIComponent(SANDBOX_ID)}/auth`,
			`${GATEWAY_URL}/ns_user1/job_abc/exec`,
		]);
		const execInit = calls[1].init;
		expect(headerOf(execInit).Authorization).toBe("Bearer gateway-token-xyz");
		expect(jsonBodyOf(execInit)).toMatchObject({
			command: "uname -a",
			sandbox_id: SANDBOX_ID,
			working_dir: "/workspace",
			env: { A: "b" },
			timeout: 60,
		});
	});

	it("defaults the exec timeout to 300 seconds and supports run-as user", async () => {
		const { client, calls } = clientOver([() => jsonResponse({ stdout: "", stderr: "warn", exit_code: 2 })]);
		const result = await client.execContainerCommand(SANDBOX_ID, { command: "ls", user: "nobody" }, { auth: auth() });
		expect(result.exitCode).toBe(2);
		const body = jsonBodyOf(calls[0].init);
		expect(body.timeout).toBe(300);
		expect(body.user).toBe("nobody");
	});

	it("rejects auth that belongs to another sandbox and invalid commands", async () => {
		const { client, calls } = clientOver([() => jsonResponse({ stdout: "", stderr: "", exit_code: 0 })]);
		const otherSandboxAuth = { ...auth(), sandboxId: "sb-other" };
		const mismatch = await expectError(
			client.execContainerCommand(SANDBOX_ID, { command: "ls" }, { auth: otherSandboxAuth }),
		);
		expect(mismatch.code).toBe("invalid_request");
		for (const request of [
			{ command: "  " },
			{ command: "a\0b" },
			{ command: "ls", timeoutSeconds: 0 },
			{ command: "ls", timeoutSeconds: MAX_EXEC_TIMEOUT_SECONDS + 1 },
			{ command: "ls", workingDir: "" },
			{ command: "ls", env: { "1BAD": "v" } },
		]) {
			const error = await expectError(client.execContainerCommand(SANDBOX_ID, request, { auth: auth() }));
			expect(error.code, `expected invalid_request for ${JSON.stringify(request)}`).toBe("invalid_request");
		}
		expect(calls.length).toBe(0);
	});

	it("maps gateway 408, 409, and 502 sandbox_not_found to typed error codes", async () => {
		const cases: Array<{ status: number; body: unknown; code: string }> = [
			{ status: 408, body: { detail: "server busy" }, code: "request_timeout" },
			{ status: 409, body: { detail: "conflict" }, code: "conflict" },
			{ status: 502, body: { error: "sandbox_not_found" }, code: "sandbox_not_found" },
			{ status: 502, body: { detail: "other upstream" }, code: "http" },
			{ status: 500, body: { detail: "boom" }, code: "http" },
		];
		for (const { status, body, code } of cases) {
			const { client } = clientOver([() => jsonResponse(body, status)]);
			const error = await expectError(client.execContainerCommand(SANDBOX_ID, { command: "ls" }, { auth: auth() }));
			expect(error.code, `HTTP ${status} should map to ${code}`).toBe(code);
			expect(error.status).toBe(status);
		}
	});

	it("rejects malformed exec responses", async () => {
		for (const body of [{ stdout: "x" }, { stdout: "x", stderr: "", exit_code: "0" }]) {
			const { client } = clientOver([() => jsonResponse(body)]);
			const error = await expectError(client.execContainerCommand(SANDBOX_ID, { command: "ls" }, { auth: auth() }));
			expect(error.code).toBe("invalid_response");
		}
	});
});

describe("uploadFile", () => {
	it("uploads multipart bytes with path and sandbox_id params", async () => {
		const { client, calls } = clientOver([
			() => jsonResponse({ success: true, path: "/tmp/x.tar", size: 4, timestamp: "2026-09-16T00:00:00Z" }),
		]);
		const content = new Uint8Array([1, 2, 3, 4]);
		const result = await client.uploadFile(
			SANDBOX_ID,
			{ path: "/tmp/x.tar", filename: "x.tar", content },
			{ auth: auth() },
		);
		expect(result).toEqual({ success: true, path: "/tmp/x.tar", size: 4, timestamp: "2026-09-16T00:00:00Z" });
		const url = new URL(calls[0].url);
		expect(`${url.origin}${url.pathname}`).toBe(`${GATEWAY_URL}/ns_user1/job_abc/upload`);
		expect(url.searchParams.get("path")).toBe("/tmp/x.tar");
		expect(url.searchParams.get("sandbox_id")).toBe(SANDBOX_ID);
		expect(headerOf(calls[0].init).Authorization).toBe("Bearer gateway-token-xyz");
		const form = formOf(calls[0].init);
		const file = form.get("file");
		expect(file).toBeInstanceOf(File);
		expect((file as File).name).toBe("x.tar");
		expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(content);
	});

	it("rejects oversized content before fetching", async () => {
		const { client, calls } = clientOver([
			() => jsonResponse({ success: true, path: "/x", size: 1, timestamp: "2026-09-16T00:00:00Z" }),
		]);
		const huge = new Uint8Array(MAX_TRANSFER_BYTES + 1);
		const error = await expectError(
			client.uploadFile(SANDBOX_ID, { path: "/x", filename: "x", content: huge }, { auth: auth() }),
		);
		expect(error.code).toBe("too_large");
		expect(calls.length).toBe(0);
	});

	it("rejects invalid filenames, paths, and failure responses", async () => {
		const { client, calls } = clientOver([
			() => jsonResponse({ success: true, path: "/x", size: 1, timestamp: "2026-09-16T00:00:00Z" }),
		]);
		for (const request of [
			{ path: "", filename: "x", content: new Uint8Array(1) },
			{ path: "/x", filename: "a/b", content: new Uint8Array(1) },
			{ path: "/x", filename: "x", content: "bytes" as unknown as Uint8Array },
		]) {
			const error = await expectError(
				client.uploadFile(SANDBOX_ID, request as { path: string; filename: string; content: Uint8Array }, {
					auth: auth(),
				}),
			);
			expect(error.code).toBe("invalid_request");
		}
		expect(calls.length).toBe(0);

		const failure = clientOver([
			() => jsonResponse({ success: false, path: "/x", size: 1, timestamp: "2026-09-16T00:00:00Z" }),
		]);
		const reported = await expectError(
			failure.client.uploadFile(
				SANDBOX_ID,
				{ path: "/x", filename: "x", content: new Uint8Array(1) },
				{ auth: auth() },
			),
		);
		expect(reported.code).toBe("invalid_response");

		const malformed = clientOver([
			() => jsonResponse({ success: true, path: "/x", timestamp: "2026-09-16T00:00:00Z" }),
		]);
		const missingSize = await expectError(
			malformed.client.uploadFile(
				SANDBOX_ID,
				{ path: "/x", filename: "x", content: new Uint8Array(1) },
				{ auth: auth() },
			),
		);
		expect(missingSize.code).toBe("invalid_response");
	});
});

describe("downloadFile", () => {
	it("downloads raw bytes from the gateway with path and sandbox_id params", async () => {
		const bytes = new Uint8Array([9, 8, 7, 6]);
		const { client, calls } = clientOver([() => new Response(bytes)]);
		const result = await client.downloadFile(SANDBOX_ID, "/out/result.tar", { auth: auth() });
		expect(result).toEqual(bytes);
		const url = new URL(calls[0].url);
		expect(`${url.origin}${url.pathname}`).toBe(`${GATEWAY_URL}/ns_user1/job_abc/download`);
		expect(url.searchParams.get("path")).toBe("/out/result.tar");
		expect(url.searchParams.get("sandbox_id")).toBe(SANDBOX_ID);
		expect(headerOf(calls[0].init).Authorization).toBe("Bearer gateway-token-xyz");
	});

	it("falls back to arrayBuffer when the response has no body stream", async () => {
		const bytes = new Uint8Array([1, 1, 2, 3]);
		const bodyless = {
			ok: true,
			status: 200,
			headers: new Headers(),
			body: null,
			arrayBuffer: async () => bytes.slice().buffer,
		} as unknown as Response;
		const { client } = clientOver([() => bodyless]);
		const result = await client.downloadFile(SANDBOX_ID, "/x", { auth: auth() });
		expect(result).toEqual(bytes);
	});

	it("stops before reading a body that declares more than the transfer cap", async () => {
		const oversized = {
			ok: true,
			status: 200,
			headers: new Headers({ "content-length": String(MAX_TRANSFER_BYTES + 1) }),
			body: null,
			arrayBuffer: async () => {
				throw new Error("must not be read");
			},
		} as unknown as Response;
		const { client } = clientOver([() => oversized]);
		const error = await expectError(client.downloadFile(SANDBOX_ID, "/x", { auth: auth() }));
		expect(error.code).toBe("too_large");
	});

	it("maps a 502 sandbox_not_found download to the typed code", async () => {
		const { client } = clientOver([() => jsonResponse({ error: "sandbox_not_found" }, 502)]);
		const error = await expectError(client.downloadFile(SANDBOX_ID, "/x", { auth: auth() }));
		expect(error.code).toBe("sandbox_not_found");
		expect(error.status).toBe(502);
	});
});

describe("waitForRunning", () => {
	it("polls until RUNNING and injects the sleep between polls", async () => {
		const statuses = ["PENDING", "PROVISIONING", "RUNNING"];
		const sleeps: number[] = [];
		const { client, calls } = clientOver([
			() => jsonResponse(sandboxBody({ status: statuses.shift() ?? "RUNNING" })),
		]);
		const sandbox = await client.waitForRunning(SANDBOX_ID, {
			timeoutMs: 60_000,
			pollIntervalMs: 1_000,
			sleepFn: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(sandbox.status).toBe("RUNNING");
		expect(calls.length).toBe(3);
		expect(sleeps).toEqual([1_000, 1_000]);
	});

	it("treats PAUSED as non-terminal and keeps polling", async () => {
		const statuses = ["PAUSED", "RUNNING"];
		const { client } = clientOver([() => jsonResponse(sandboxBody({ status: statuses.shift() ?? "RUNNING" }))]);
		const sandbox = await client.waitForRunning(SANDBOX_ID, {
			timeoutMs: 60_000,
			pollIntervalMs: 1,
			sleepFn: async () => {},
		});
		expect(sandbox.status).toBe("RUNNING");
	});

	it("fails fast on terminal statuses with redacted details", async () => {
		const { client } = clientOver([
			() => jsonResponse(sandboxBody({ status: "ERROR", errorType: "OOM", errorMessage: `died near ${API_KEY}` })),
		]);
		const error = await expectError(
			client.waitForRunning(SANDBOX_ID, {
				timeoutMs: 60_000,
				pollIntervalMs: 1,
				sleepFn: async () => {},
			}),
		);
		expect(error.code).toBe("terminal_status");
		expect(error.details).toContain("OOM");
		expect(error.details).not.toContain(API_KEY);
	});

	it("reports a timeout when the budget is exhausted first", async () => {
		const { client } = clientOver([() => jsonResponse(sandboxBody({ status: "PENDING" }))]);
		const error = await expectError(
			client.waitForRunning(SANDBOX_ID, {
				timeoutMs: 40,
				pollIntervalMs: 1,
				sleepFn: async () => {},
			}),
		);
		expect(error.code).toBe("timeout");
		expect(error.details).toContain("PENDING");
	});

	it("rejects invalid wait options", async () => {
		const { client, calls } = clientOver([() => jsonResponse(sandboxBody())]);
		const zeroBudget = await expectError(client.waitForRunning(SANDBOX_ID, { timeoutMs: 0, pollIntervalMs: 1 }));
		expect(zeroBudget.code).toBe("invalid_request");
		const badInterval = await expectError(client.waitForRunning(SANDBOX_ID, { timeoutMs: 100, pollIntervalMs: 0 }));
		expect(badInterval.code).toBe("invalid_request");
		expect(calls.length).toBe(0);
	});
});

describe("secret redaction and bounded reads", () => {
	it("redacts the api key from HTTP error details", async () => {
		const { client } = clientOver([() => jsonResponse({ detail: `upstream rejected ${API_KEY} for this key` }, 500)]);
		const error = await expectError(client.getSandbox(SANDBOX_ID));
		expect(error.code).toBe("http");
		expect(error.details).not.toContain(API_KEY);
		expect(error.details).toContain("[redacted]");
	});

	it("redacts the gateway token from upload error details", async () => {
		const { client } = clientOver([() => jsonResponse({ detail: "token gateway-token-xyz leaked" }, 500)]);
		const error = await expectError(
			client.uploadFile(SANDBOX_ID, { path: "/x", filename: "x", content: new Uint8Array(1) }, { auth: auth() }),
		);
		expect(error.details).not.toContain("gateway-token-xyz");
		expect(error.details).toContain("[redacted]");
	});

	it("redacts secrets from network failure messages", async () => {
		const { client } = clientOver([
			(): Response => {
				throw new Error(`connection reset while using ${API_KEY}`);
			},
		]);
		const error = await expectError(client.getSandbox(SANDBOX_ID));
		expect(error.code).toBe("network");
		expect(error.message).not.toContain(API_KEY);
		expect(error.message).toContain("[redacted]");
	});

	it("bounds error-body previews regardless of body size", async () => {
		const huge = `z`.repeat(512 * 1024);
		const { client } = clientOver([() => jsonResponse({ detail: huge }, 500)]);
		const error = await expectError(client.getSandbox(SANDBOX_ID));
		expect(error.details).toBeDefined();
		expect((error.details ?? "").length).toBeLessThanOrEqual(520);
	});

	it("rejects JSON bodies over the bounded read cap without parsing them fully", async () => {
		const oversized = `{"detail":"${"x".repeat(33 * 1024 * 1024)}"}`;
		const { client } = clientOver([() => new Response(oversized, { status: 200 })]);
		const error = await expectError(client.getSandbox(SANDBOX_ID));
		expect(error.code).toBe("too_large");
	});
});
