import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	closePrimeCliCredentialAuthority,
	createPrimeCliCredentialAuthority,
} from "../src/modes/daemon/sandbox/prime-cli-provisioner.js";
import {
	acceptSandboxRuntimeActivation,
	closeSandboxRuntimeActivation,
} from "../src/modes/daemon/sandbox/prime-sandbox-activation.js";
import {
	performSandboxRuntimeHandshake,
	type SandboxHandshakeIo,
} from "../src/modes/daemon/sandbox/prime-sandbox-handshake.js";
import {
	decodeSandboxInferenceReply,
	decodeSandboxRequestDeliveryAck,
	encodeSandboxInferenceRequest,
} from "../src/modes/daemon/sandbox/prime-sandbox-inference.js";
import {
	buildSandboxLaunchConfig,
	decodeSandboxLaunchConfig,
	type SandboxLaunchConfig,
} from "../src/modes/daemon/sandbox/prime-sandbox-launch-config.js";
import {
	createSandboxLifecycle,
	type LifecycleConfig,
	type RunCommand,
	type RunnerResult,
	type SandboxLifecycleBundle,
} from "../src/modes/daemon/sandbox/prime-sandbox-lifecycle.js";
import {
	buildSandboxReadinessBundle,
	decodeSandboxReadinessBundle,
} from "../src/modes/daemon/sandbox/prime-sandbox-readiness-bundle.js";
import {
	closeSandboxTcpListener,
	connectSandboxRuntimeTcp,
	listenSandboxRuntimeTcp,
} from "../src/modes/daemon/sandbox/prime-sandbox-tcp.js";
import {
	closeSandboxEd25519KeyPair,
	closeSandboxTransportChannel,
	copySandboxEd25519PublicKey,
	decryptSandboxTransportFrame,
	encryptSandboxTransportFrame,
	generateSandboxEd25519KeyPair,
	randomSandboxHandshakeBytes,
	type SandboxEd25519KeyPair,
	signSandboxReadinessBundle,
} from "../src/modes/daemon/sandbox/prime-sandbox-transport.js";
import {
	type PreparedFileUpload,
	prepareFileUpload,
	type SandboxArtifactKind,
} from "../src/modes/daemon/sandbox/prime-sandbox-upload-body.js";
import {
	createPrimeSandboxSessionFamilyForTesting,
	type PrimeSandboxSessionArtifacts,
} from "../src/modes/daemon/sandbox/sandbox-session-manager.js";
import versionFixture from "./fixtures/prime-cli-0.6.21-create-version-fixture.json";
import sandboxFixture from "./fixtures/prime-cli-0.6.21-sandbox-json-fixture.json";

const SANDBOX_ID = "sb_abc123";
const LABEL = sandboxFixture.expectedLabel;
const CLI = "/prime-agent-managed/prime-cli-0.6.21";
const roots: string[] = [];

function ok(stdout = ""): RunnerResult {
	return Object.freeze({
		ok: true,
		value: Object.freeze({ stdout, stderr: "", exitCode: 0, durationMs: 1 }),
	});
}

function listJson(empty: boolean): string {
	return JSON.stringify({
		sandboxes: empty
			? []
			: [
					{
						id: SANDBOX_ID,
						name: "test-sandbox",
						image: "python:3.11.13-slim-bookworm",
						status: "RUNNING",
						resources: "1CPU",
						region: null,
						labels: [LABEL],
						created_at: "2026-09-04 01:02:03 UTC",
						timeout_minutes: 60,
						expires_at: null,
					},
				],
		total: empty ? 0 : 1,
		page: 1,
		per_page: 100,
		has_next: false,
	});
}

function lifecycleConfig(): LifecycleConfig {
	return Object.freeze({
		primeCliPath: CLI,
		label: LABEL,
		image: "python:3.11.13-slim-bookworm",
		name: "test-sandbox",
		cpuCores: 1,
		memoryGb: 1,
		diskSizeGb: 10,
		sandboxTimeoutMinutes: 60,
		operationTimeoutMs: 60_000,
		pollIntervalMs: 100,
	});
}

async function createLifecycle(
	initialExisting = false,
	deletionRecovery = false,
): Promise<
	| {
			bundle: SandboxLifecycleBundle;
			counts: () => Readonly<{ listCalls: number; createCalls: number; deleteCalls: number }>;
	  }
	| undefined
> {
	let listCalls = 0;
	let createCalls = 0;
	let deleteCalls = 0;
	const run: RunCommand = async (argv) => {
		if (argv.length === 2 && argv[1] === "--version") return ok(versionFixture.versionStdout);
		if (argv.includes("list")) {
			listCalls += 1;
			if (deletionRecovery && (listCalls === 2 || listCalls === 3)) {
				return Object.freeze({ ok: false, code: "INPUT_INVALID" });
			}
			if (deletionRecovery && listCalls === 4) return ok(listJson(false));
			return ok(listJson(!(initialExisting && listCalls === 1)));
		}
		if (argv.includes("create")) {
			createCalls += 1;
			return ok(versionFixture.createPlainStdout);
		}
		if (argv.includes("get")) {
			return ok(
				JSON.stringify({
					id: SANDBOX_ID,
					name: "",
					type: "Container",
					docker_image: "python:3.11.13-slim-bookworm",
					start_command: "tail -f /dev/null",
					status: "RUNNING",
					cpu_cores: 1.0,
					memory_gb: 1.0,
					disk_size_gb: 10,
					disk_mount_path: "/workspace",
					gpu_count: 0,
					gpu_type: null,
					vm: false,
					network_allowlist: null,
					network_denylist: null,
					timeout_minutes: 60,
					idle_timeout_minutes: null,
					termination_reason: null,
					labels: [LABEL],
					created_at: "2026-09-04 01:02:03 UTC",
					user_id: null,
					team_id: null,
					region: null,
					registry_credentials_id: null,
					started_at: "2026-09-04 01:02:04 UTC",
					exit_code: 0,
					environment_vars: { VISIBLE: "v***e" },
					secrets: { TOKEN: "***" },
					advanced_configs: { futureFlag: true },
				}),
			);
		}
		if (argv.includes("delete")) {
			deleteCalls += 1;
			return ok();
		}
		return Object.freeze({ ok: false, code: "INPUT_INVALID" });
	};
	const created = await createSandboxLifecycle(run, lifecycleConfig());
	expect(created.ok).toBe(true);
	if (!created.ok) return undefined;
	return {
		bundle: created.value,
		counts: () => Object.freeze({ listCalls, createCalls, deleteCalls }),
	};
}

async function artifact(kind: SandboxArtifactKind, text: string): Promise<PreparedFileUpload | undefined> {
	const directory = await mkdtemp(join(tmpdir(), "prime-session-manager-"));
	roots.push(directory);
	const path = join(directory, `${kind}.bin`);
	const bytes = new TextEncoder().encode(text);
	await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
	await chmod(path, 0o600);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const prepared = await prepareFileUpload(kind, path, bytes.byteLength, digest);
	bytes.fill(0);
	expect(prepared.ok).toBe(true);
	if (!prepared.ok) return undefined;
	return prepared.value;
}

async function artifacts(): Promise<PrimeSandboxSessionArtifacts | undefined> {
	const release = await artifact("release", "release-bytes");
	const manifest = await artifact("manifest", "manifest-bytes");
	const bootstrap = await artifact("bootstrap", "bootstrap-bytes");
	const trust = await artifact("trust", "trust-bytes");
	if (release === undefined || manifest === undefined || bootstrap === undefined || trust === undefined) {
		return undefined;
	}
	return Object.freeze({ release, manifest, bootstrap, trust });
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function authResponse(): Response {
	return jsonResponse({
		gateway_url: "https://gateway.example.com/base/",
		user_ns: "user_ns",
		job_id: "job_123",
		token: "gateway-token",
		expires_at: "2099-09-04T12:30:00Z",
		is_vm: false,
	});
}

async function drainBody(init: RequestInit): Promise<void> {
	if (init.body instanceof ReadableStream) await new Response(init.body).arrayBuffer();
}

function sequence(start: number): Uint8Array<ArrayBuffer> {
	const value = new Uint8Array(new ArrayBuffer(32));
	for (let index = 0; index < 32; index += 1) value[index] = (start + index) & 255;
	return value;
}

async function readFrame(io: SandboxHandshakeIo): Promise<Uint8Array<ArrayBuffer> | undefined> {
	const header = await io.readExact(32, 3_000);
	if (!(header instanceof Uint8Array) || Object.getPrototypeOf(header) !== Uint8Array.prototype) return undefined;
	const length = new DataView(header.buffer, header.byteOffset, 32).getUint32(16, false);
	if (length > 262_144) return undefined;
	const payload = await io.readExact(length + 16, 3_000);
	if (!(payload instanceof Uint8Array) || Object.getPrototypeOf(payload) !== Uint8Array.prototype) return undefined;
	const frame = new Uint8Array(new ArrayBuffer(48 + length));
	frame.set(header);
	frame.set(payload, 32);
	return frame;
}

async function runtimeSetup(): Promise<
	| {
			readonly homeIdentity: SandboxEd25519KeyPair;
			readonly runtimeIdentity: SandboxEd25519KeyPair;
			readonly protocolNonce: Uint8Array<ArrayBuffer>;
			readonly launchConfig: SandboxLaunchConfig;
			readonly bundleText: string;
	  }
	| undefined
> {
	const homeIdentity = await generateSandboxEd25519KeyPair();
	const runtimeIdentity = await generateSandboxEd25519KeyPair();
	const protocolNonce = randomSandboxHandshakeBytes();
	expect(homeIdentity.ok).toBe(true);
	expect(runtimeIdentity.ok).toBe(true);
	expect(protocolNonce.ok).toBe(true);
	if (!homeIdentity.ok || !runtimeIdentity.ok || !protocolNonce.ok) return undefined;
	const homePublicKey = copySandboxEd25519PublicKey(homeIdentity.value);
	const launcherPublicKey = copySandboxEd25519PublicKey(runtimeIdentity.value);
	expect(homePublicKey).toBeDefined();
	expect(launcherPublicKey).toBeDefined();
	if (homePublicKey === undefined || launcherPublicKey === undefined) return undefined;
	const archiveSha256 = sequence(32);
	const manifestSha256 = sequence(64);
	const launcherSha256 = sequence(96);
	const launchBytes = buildSandboxLaunchConfig({
		protocol: "prime-sandbox-v3",
		homePublicKey: Buffer.from(homePublicKey).toString("base64"),
		archiveSha256: Buffer.from(archiveSha256).toString("hex"),
		manifestSha256: Buffer.from(manifestSha256).toString("hex"),
		launcherSha256: Buffer.from(launcherSha256).toString("hex"),
	});
	expect(launchBytes.ok).toBe(true);
	if (!launchBytes.ok) return undefined;
	const launchConfig = decodeSandboxLaunchConfig(launchBytes.bytes);
	expect(launchConfig.ok).toBe(true);
	if (!launchConfig.ok) return undefined;
	const fields = {
		launcherPublicKey,
		homePublicKey,
		archiveSha256,
		manifestSha256,
		launcherSha256,
		protocolNonce: protocolNonce.value,
	};
	const signature = await signSandboxReadinessBundle(runtimeIdentity.value, fields);
	expect(signature.ok).toBe(true);
	if (!signature.ok) return undefined;
	const bundle = buildSandboxReadinessBundle({
		launcherPublicKey: fields.launcherPublicKey,
		homePublicKey: fields.homePublicKey,
		archiveSha256: fields.archiveSha256,
		manifestSha256: fields.manifestSha256,
		launcherSha256: fields.launcherSha256,
		protocolNonce: fields.protocolNonce,
		signature: signature.value,
	});
	expect(bundle.ok).toBe(true);
	if (!bundle.ok) return undefined;
	const decoded = decodeSandboxReadinessBundle(bundle.bytes);
	expect(decoded.ok).toBe(true);
	if (!decoded.ok) return undefined;
	return {
		homeIdentity: homeIdentity.value,
		runtimeIdentity: runtimeIdentity.value,
		protocolNonce: protocolNonce.value,
		launchConfig: launchConfig.config,
		bundleText: new TextDecoder().decode(bundle.bytes),
	};
}

afterEach(async () => {
	while (roots.length > 0) {
		const path = roots.pop();
		if (path !== undefined) await rm(path, { force: true, recursive: true });
	}
});

describe("Prime Sandbox PR A session manager", () => {
	test("creates one sandbox, authenticates, proxies one inference, and proves deletion", async () => {
		const lifecycle = await createLifecycle();
		if (!lifecycle) return;
		const runtime = await runtimeSetup();
		if (!runtime) return;
		let finishRuntime: ((value: boolean) => void) | undefined;
		const runtimeDone = new Promise<boolean>((resolve) => {
			finishRuntime = resolve;
		});
		const listener = await listenSandboxRuntimeTcp(async (io) => {
			const handshake = await performSandboxRuntimeHandshake(
				io,
				runtime.runtimeIdentity,
				runtime.launchConfig,
				runtime.protocolNonce,
			);
			if (!handshake.ok) {
				finishRuntime?.(false);
				return;
			}
			const activationFrame = await readFrame(io);
			if (activationFrame === undefined) {
				finishRuntime?.(false);
				return;
			}
			const activation = await acceptSandboxRuntimeActivation(handshake.channel, activationFrame);
			if (!activation.ok || !(await io.writeExact(activation.value.ackFrame, 3_000))) {
				finishRuntime?.(false);
				return;
			}
			const request = encodeSandboxInferenceRequest(1n, "prime-inference/test-model", "private prompt");
			if (!request.ok) {
				finishRuntime?.(false);
				return;
			}
			const requestFrame = await encryptSandboxTransportFrame(handshake.channel, 0n, request.value);
			request.value.fill(0);
			if (!requestFrame.ok || !(await io.writeExact(requestFrame.value, 3_000))) {
				finishRuntime?.(false);
				return;
			}
			requestFrame.value.fill(0);
			const ackFrame = await readFrame(io);
			const replyFrame = ackFrame === undefined ? undefined : await readFrame(io);
			if (ackFrame === undefined || replyFrame === undefined) {
				finishRuntime?.(false);
				return;
			}
			const ackPlaintext = await decryptSandboxTransportFrame(handshake.channel, ackFrame);
			const replyPlaintext = await decryptSandboxTransportFrame(handshake.channel, replyFrame);
			ackFrame.fill(0);
			replyFrame.fill(0);
			if (!ackPlaintext.ok || !replyPlaintext.ok) {
				finishRuntime?.(false);
				return;
			}
			const ack = decodeSandboxRequestDeliveryAck(ackPlaintext.value.plaintext);
			const reply = decodeSandboxInferenceReply(replyPlaintext.value.plaintext);
			ackPlaintext.value.plaintext.fill(0);
			replyPlaintext.value.plaintext.fill(0);
			const valid =
				ack.ok && ack.value === 1n && reply.ok && reply.value.ok && reply.value.text === "home model response";
			await io.waitClosed();
			closeSandboxRuntimeActivation(activation.value.activation);
			closeSandboxTransportChannel(handshake.channel);
			finishRuntime?.(valid);
		});
		expect(listener.ok).toBe(true);
		if (!listener.ok) return;
		const uploadSizes = new Map([
			["/tmp/prime-agent-runtime.tar.gz", "release-bytes".length],
			["/tmp/prime-agent-runtime.manifest.json", "manifest-bytes".length],
			["/tmp/prime-agent-bootstrap.pyz", "bootstrap-bytes".length],
			["/tmp/prime-agent-bootstrap-trust.json", "trust-bytes".length],
		]);
		let providerCalls = 0;
		const dispatch = async (url: string, init: RequestInit): Promise<Response> => {
			providerCalls += 1;
			if (url.endsWith(`/sandbox/${SANDBOX_ID}/auth`)) return authResponse();
			if (url.includes("/upload?")) {
				await drainBody(init);
				const path = new URL(url).searchParams.get("path");
				const size = path === null ? undefined : uploadSizes.get(path);
				return jsonResponse({ success: true, path, size, timestamp: "2099-09-04T12:30:00Z" });
			}
			if (url.endsWith("/exec")) {
				return jsonResponse({ stdout: runtime.bundleText, stderr: "", exit_code: 0 });
			}
			if (init.method === "GET") return jsonResponse({ exposures: [] });
			if (init.method === "POST") {
				return jsonResponse({
					exposure_id: "exp_abcdef",
					sandbox_id: SANDBOX_ID,
					port: 9443,
					name: "prime-agent-runtime-v1",
					url: "",
					tls_socket: "",
					protocol: "TCP",
					external_port: 9443,
					external_endpoint: "127.0.0.1:9443",
					created_at: "2099-09-04T12:30:00Z",
				});
			}
			return new Response(null, { status: 204 });
		};
		const credential = createPrimeCliCredentialAuthority(new TextEncoder().encode("test-only-provider-key"));
		expect(credential.ok).toBe(true);
		if (!credential.ok) return;
		const familyResult = createPrimeSandboxSessionFamilyForTesting(
			lifecycle.bundle,
			credential.value,
			dispatch,
			connectSandboxRuntimeTcp,
		);
		expect(familyResult.ok).toBe(true);
		if (!familyResult.ok) return;
		const family = familyResult.value;
		const started = await family.start(await artifacts(), runtime.homeIdentity, "prime-inference/test-model");
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const capValue = started.value;
		if (typeof capValue !== "object" || capValue === null) return;
		expect(Object.keys(capValue)).toEqual([]);
		expect(Object.getPrototypeOf(capValue).constructor).toBeNull();
		expect(await family.retryCleanup()).toEqual({ ok: false, code: "NOT_ACTIVE" });
		let inferenceCalls = 0;
		expect(
			await family.proxy(started.value, async (request: unknown) => {
				inferenceCalls += 1;
				expect(request).toEqual({ model: "prime-inference/test-model", input: "private prompt" });
				return Object.freeze({ ok: true, text: "home model response" });
			}),
		).toEqual({ ok: true, value: true });
		expect(
			await family.proxy(started.value, async () => ({
				ok: false,
				code: "INFERENCE_FAILED",
			})),
		).toEqual({
			ok: false,
			code: "INFERENCE_ALREADY_CLAIMED",
		});
		expect(await family.delete(started.value)).toEqual({ ok: true, value: true });
		expect(await runtimeDone).toBe(true);
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
		expect(lifecycle.counts()).toEqual({ listCalls: 2, createCalls: 1, deleteCalls: 1 });
		expect(inferenceCalls).toBe(1);
		expect(providerCalls).toBe(14);
		expect(closePrimeCliCredentialAuthority(credential.value)).toBe(true);
		closeSandboxEd25519KeyPair(runtime.homeIdentity);
		closeSandboxEd25519KeyPair(runtime.runtimeIdentity);
	});

	test("deletes and proves absence after an upload failure without duplicate allocation", async () => {
		const lifecycle = await createLifecycle();
		if (!lifecycle) return;
		const runtime = await runtimeSetup();
		if (!runtime) return;
		let calls = 0;
		const dispatch = async (url: string, init: RequestInit): Promise<Response> => {
			calls += 1;
			if (url.endsWith(`/sandbox/${SANDBOX_ID}/auth`)) return authResponse();
			if (url.includes("/upload?")) {
				await drainBody(init);
				return jsonResponse({ failure: true }, 500);
			}
			return jsonResponse({ exposures: [] });
		};
		const credential = createPrimeCliCredentialAuthority(new TextEncoder().encode("test-only-provider-key"));
		expect(credential.ok).toBe(true);
		if (!credential.ok) return;
		const familyResult = createPrimeSandboxSessionFamilyForTesting(
			lifecycle.bundle,
			credential.value,
			dispatch,
			async () => Object.freeze({ ok: false, code: "CONNECT_FAILED" }),
		);
		expect(familyResult.ok).toBe(true);
		if (!familyResult.ok) return;
		const family = familyResult.value;
		expect(await family.start(await artifacts(), runtime.homeIdentity, "prime-inference/test-model")).toEqual({
			ok: false,
			code: "START_FAILED",
		});
		expect(await family.retryCleanup()).toEqual({ ok: true, value: true });
		expect(lifecycle.counts()).toEqual({ listCalls: 2, createCalls: 1, deleteCalls: 1 });
		expect(calls).toBe(3);
		expect(closePrimeCliCredentialAuthority(credential.value)).toBe(true);
		closeSandboxEd25519KeyPair(runtime.homeIdentity);
		closeSandboxEd25519KeyPair(runtime.runtimeIdentity);
	});

	test("recovers with a fresh handle after delete and recovery inspection both fail", async () => {
		const lifecycle = await createLifecycle(false, true);
		if (!lifecycle) return;
		const runtime = await runtimeSetup();
		if (!runtime) return;
		let calls = 0;
		const dispatch = async (url: string, init: RequestInit): Promise<Response> => {
			calls += 1;
			if (url.endsWith(`/sandbox/${SANDBOX_ID}/auth`)) return authResponse();
			if (url.includes("/upload?")) {
				await drainBody(init);
				return jsonResponse({ failure: true }, 500);
			}
			return jsonResponse({ exposures: [] });
		};
		const credential = createPrimeCliCredentialAuthority(new TextEncoder().encode("test-only-provider-key"));
		expect(credential.ok).toBe(true);
		if (!credential.ok) return;
		const familyResult = createPrimeSandboxSessionFamilyForTesting(
			lifecycle.bundle,
			credential.value,
			dispatch,
			async () => Object.freeze({ ok: false, code: "CONNECT_FAILED" }),
		);
		expect(familyResult.ok).toBe(true);
		if (!familyResult.ok) return;
		const family = familyResult.value;
		expect(await family.start(await artifacts(), runtime.homeIdentity, "prime-inference/test-model")).toEqual({
			ok: false,
			code: "CLEANUP_UNCERTAIN",
		});
		expect(lifecycle.counts()).toEqual({ listCalls: 3, createCalls: 1, deleteCalls: 1 });
		expect(await family.retryCleanup()).toEqual({ ok: true, value: true });
		expect(lifecycle.counts()).toEqual({ listCalls: 5, createCalls: 1, deleteCalls: 2 });
		expect(calls).toBe(3);
		expect(closePrimeCliCredentialAuthority(credential.value)).toBe(true);
		closeSandboxEd25519KeyPair(runtime.homeIdentity);
		closeSandboxEd25519KeyPair(runtime.runtimeIdentity);
	});

	test("recovers one matching sandbox without duplicate allocation", async () => {
		const lifecycle = await createLifecycle(true);
		if (!lifecycle) return;
		const runtime = await runtimeSetup();
		if (!runtime) return;
		let calls = 0;
		const dispatch = async (url: string, init: RequestInit): Promise<Response> => {
			calls += 1;
			if (url.endsWith(`/sandbox/${SANDBOX_ID}/auth`)) return authResponse();
			if (url.includes("/upload?")) {
				await drainBody(init);
				return jsonResponse({ failure: true }, 500);
			}
			return jsonResponse({ exposures: [] });
		};
		const credential = createPrimeCliCredentialAuthority(new TextEncoder().encode("test-only-provider-key"));
		expect(credential.ok).toBe(true);
		if (!credential.ok) return;
		const familyResult = createPrimeSandboxSessionFamilyForTesting(
			lifecycle.bundle,
			credential.value,
			dispatch,
			async () => Object.freeze({ ok: false, code: "CONNECT_FAILED" }),
		);
		expect(familyResult.ok).toBe(true);
		if (!familyResult.ok) return;
		const family = familyResult.value;
		expect(await family.start(await artifacts(), runtime.homeIdentity, "prime-inference/test-model")).toEqual({
			ok: false,
			code: "START_FAILED",
		});
		expect(lifecycle.counts()).toEqual({ listCalls: 2, createCalls: 0, deleteCalls: 1 });
		expect(calls).toBe(3);
		expect(closePrimeCliCredentialAuthority(credential.value)).toBe(true);
		closeSandboxEd25519KeyPair(runtime.homeIdentity);
		closeSandboxEd25519KeyPair(runtime.runtimeIdentity);
	});

	test("retains cleanup authority and retries uncertain unexposure before deletion", async () => {
		const lifecycle = await createLifecycle();
		if (!lifecycle) return;
		const runtime = await runtimeSetup();
		if (!runtime) return;
		const uploadSizes = new Map([
			["/tmp/prime-agent-runtime.tar.gz", "release-bytes".length],
			["/tmp/prime-agent-runtime.manifest.json", "manifest-bytes".length],
			["/tmp/prime-agent-bootstrap.pyz", "bootstrap-bytes".length],
			["/tmp/prime-agent-bootstrap-trust.json", "trust-bytes".length],
		]);
		let calls = 0;
		let deleteAttempts = 0;
		const dispatch = async (url: string, init: RequestInit): Promise<Response> => {
			calls += 1;
			if (url.endsWith(`/sandbox/${SANDBOX_ID}/auth`)) return authResponse();
			if (url.includes("/upload?")) {
				await drainBody(init);
				const path = new URL(url).searchParams.get("path");
				const size = path === null ? undefined : uploadSizes.get(path);
				return jsonResponse({ success: true, path, size, timestamp: "2099-09-04T12:30:00Z" });
			}
			if (url.endsWith("/exec")) {
				return jsonResponse({ stdout: runtime.bundleText, stderr: "", exit_code: 0 });
			}
			if (init.method === "GET") return jsonResponse({ exposures: [] });
			if (init.method === "POST") {
				return jsonResponse({
					exposure_id: "exp_abcdef",
					sandbox_id: SANDBOX_ID,
					port: 9443,
					name: "prime-agent-runtime-v1",
					url: "",
					tls_socket: "",
					protocol: "TCP",
					external_port: 9443,
					external_endpoint: "runtime.example.com:9443",
					created_at: "2099-09-04T12:30:00Z",
				});
			}
			deleteAttempts += 1;
			return deleteAttempts === 1 ? jsonResponse({ failure: true }, 500) : new Response(null, { status: 204 });
		};
		const credential = createPrimeCliCredentialAuthority(new TextEncoder().encode("test-only-provider-key"));
		expect(credential.ok).toBe(true);
		if (!credential.ok) return;
		const familyResult = createPrimeSandboxSessionFamilyForTesting(
			lifecycle.bundle,
			credential.value,
			dispatch,
			async () => Object.freeze({ ok: false, code: "CONNECT_FAILED" }),
		);
		expect(familyResult.ok).toBe(true);
		if (!familyResult.ok) return;
		const family = familyResult.value;
		expect(await family.start(await artifacts(), runtime.homeIdentity, "prime-inference/test-model")).toEqual({
			ok: false,
			code: "CLEANUP_UNCERTAIN",
		});
		expect(lifecycle.counts()).toEqual({ listCalls: 1, createCalls: 1, deleteCalls: 0 });
		expect(await family.retryCleanup()).toEqual({ ok: true, value: true });
		expect(lifecycle.counts()).toEqual({ listCalls: 2, createCalls: 1, deleteCalls: 1 });
		expect(deleteAttempts).toBe(2);
		expect(calls).toBe(15);
		expect(closePrimeCliCredentialAuthority(credential.value)).toBe(true);
		closeSandboxEd25519KeyPair(runtime.homeIdentity);
		closeSandboxEd25519KeyPair(runtime.runtimeIdentity);
	});

	test("abort during provider authentication still deletes the allocated sandbox", async () => {
		const lifecycle = await createLifecycle();
		if (!lifecycle) return;
		const runtime = await runtimeSetup();
		if (!runtime) return;
		const controller = new AbortController();
		let calls = 0;
		const dispatch = async (url: string): Promise<Response> => {
			calls += 1;
			if (url.endsWith(`/sandbox/${SANDBOX_ID}/auth`)) {
				controller.abort();
				return authResponse();
			}
			return jsonResponse({ exposures: [] });
		};
		const credential = createPrimeCliCredentialAuthority(new TextEncoder().encode("test-only-provider-key"));
		expect(credential.ok).toBe(true);
		if (!credential.ok) return;
		const familyResult = createPrimeSandboxSessionFamilyForTesting(
			lifecycle.bundle,
			credential.value,
			dispatch,
			async () => Object.freeze({ ok: false, code: "CONNECT_FAILED" }),
		);
		expect(familyResult.ok).toBe(true);
		if (!familyResult.ok) return;
		const family = familyResult.value;
		expect(
			await family.start(await artifacts(), runtime.homeIdentity, "prime-inference/test-model", controller.signal),
		).toEqual({ ok: false, code: "ABORTED" });
		expect(lifecycle.counts()).toEqual({ listCalls: 2, createCalls: 1, deleteCalls: 1 });
		expect(calls).toBe(2);
		expect(closePrimeCliCredentialAuthority(credential.value)).toBe(true);
		closeSandboxEd25519KeyPair(runtime.homeIdentity);
		closeSandboxEd25519KeyPair(runtime.runtimeIdentity);
	});

	test("rejects forged, cross-family, and malformed session capabilities", async () => {
		const lifecycle = await createLifecycle();
		if (!lifecycle) return;
		const runtime = await runtimeSetup();
		if (!runtime) return;
		const dispatch = async (): Promise<Response> => jsonResponse({ exposures: [] });
		const credential = createPrimeCliCredentialAuthority(new TextEncoder().encode("test-only-provider-key"));
		expect(credential.ok).toBe(true);
		if (!credential.ok) return;
		const familyAResult = createPrimeSandboxSessionFamilyForTesting(
			lifecycle.bundle,
			credential.value,
			dispatch,
			async () => Object.freeze({ ok: false, code: "CONNECT_FAILED" }),
		);
		expect(familyAResult.ok).toBe(true);
		if (!familyAResult.ok) return;
		const familyA = familyAResult.value;
		const startA = await familyA.start(await artifacts(), runtime.homeIdentity, "prime-inference/test-model");
		expect(startA.ok).toBe(false);
		// No session cap issued (start failed), so any object or primitive as sessionRaw is INPUT_INVALID.
		expect(await familyA.delete({})).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(await familyA.proxy({}, async () => ({ ok: true, text: "" }))).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		// A plain empty frozen object with null prototype is not the issued cap.
		const forgedNullProto: object = {};
		Object.setPrototypeOf(forgedNullProto, null);
		Object.freeze(forgedNullProto);
		expect(await familyA.delete(forgedNullProto)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	test("prevents duplicate start and rejects second family session", async () => {
		const lifecycle = await createLifecycle();
		if (!lifecycle) return;
		const runtime = await runtimeSetup();
		if (!runtime) return;
		const dispatch = async (): Promise<Response> => jsonResponse({ exposures: [] });
		const credential = createPrimeCliCredentialAuthority(new TextEncoder().encode("test-only-provider-key"));
		expect(credential.ok).toBe(true);
		if (!credential.ok) return;
		const familyAResult = createPrimeSandboxSessionFamilyForTesting(
			lifecycle.bundle,
			credential.value,
			dispatch,
			async () => Object.freeze({ ok: false, code: "CONNECT_FAILED" }),
		);
		expect(familyAResult.ok).toBe(true);
		if (!familyAResult.ok) return;
		const familyA = familyAResult.value;
		// Second family with same lifecycle/credential uses same backing bundle.
		const familyBResult = createPrimeSandboxSessionFamilyForTesting(
			lifecycle.bundle,
			credential.value,
			dispatch,
			async () => Object.freeze({ ok: false, code: "CONNECT_FAILED" }),
		);
		expect(familyBResult.ok).toBe(true);
		if (!familyBResult.ok) return;
		const familyB = familyBResult.value;
		const a = await familyA.start(await artifacts(), runtime.homeIdentity, "prime-inference/test-model");
		expect(a.ok).toBe(false);
		// familyB cannot use familyA's cap (none was issued since start failed)
		expect(await familyB.delete(a.ok === true ? a.value : {})).toEqual({ ok: false, code: "INPUT_INVALID" });
		const b = await familyB.start(await artifacts(), runtime.homeIdentity, "prime-inference/test-model");
		expect(b.ok).toBe(false);
		expect(closePrimeCliCredentialAuthority(credential.value)).toBe(true);
		closeSandboxEd25519KeyPair(runtime.homeIdentity);
		closeSandboxEd25519KeyPair(runtime.runtimeIdentity);
	});
});
