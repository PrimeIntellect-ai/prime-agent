import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
	acceptSandboxRuntimeActivation,
	closeSandboxRuntimeActivation,
} from "../src/modes/daemon/sandbox/prime-sandbox-activation.js";
import {
	performSandboxRuntimeHandshake,
	type SandboxHandshakeIo,
} from "../src/modes/daemon/sandbox/prime-sandbox-handshake.js";
import {
	closeSandboxHomeRuntimeConnection,
	connectAndActivateSandboxRuntime,
	proxyNextSandboxInference,
	SandboxHomeRuntimeConnection,
} from "../src/modes/daemon/sandbox/prime-sandbox-home-connection.js";
import {
	decodeSandboxInferenceReply,
	decodeSandboxRequestDeliveryAck,
	encodeSandboxInferenceRequest,
} from "../src/modes/daemon/sandbox/prime-sandbox-inference.js";
import {
	buildSandboxLaunchConfig,
	decodeSandboxLaunchConfig,
} from "../src/modes/daemon/sandbox/prime-sandbox-launch-config.js";
import {
	createPrimeSandboxProviderPort,
	type SandboxFetchPort,
} from "../src/modes/daemon/sandbox/prime-sandbox-provider.js";
import {
	buildSandboxReadinessBundle,
	decodeSandboxReadinessBundle,
} from "../src/modes/daemon/sandbox/prime-sandbox-readiness-bundle.js";
import {
	closeSandboxTcpListener,
	listenSandboxRuntimeTcp,
	type SandboxTcpIo,
} from "../src/modes/daemon/sandbox/prime-sandbox-tcp.js";
import {
	closeSandboxTransportChannel,
	copySandboxEd25519PublicKey,
	decryptSandboxTransportFrame,
	encryptSandboxTransportFrame,
	generateSandboxEd25519KeyPair,
	randomSandboxHandshakeBytes,
	signSandboxReadinessBundle,
} from "../src/modes/daemon/sandbox/prime-sandbox-transport.js";

const SANDBOX_ID = "sb_abcdef012345";

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

async function setup() {
	const homeIdentity = await generateSandboxEd25519KeyPair();
	const runtimeIdentity = await generateSandboxEd25519KeyPair();
	const protocolNonce = randomSandboxHandshakeBytes();
	if (!homeIdentity.ok || !runtimeIdentity.ok || !protocolNonce.ok) throw new Error("setup failed");
	const homePublicKey = copySandboxEd25519PublicKey(homeIdentity.value);
	const launcherPublicKey = copySandboxEd25519PublicKey(runtimeIdentity.value);
	if (homePublicKey === undefined || launcherPublicKey === undefined) throw new Error("setup failed");
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
	if (!launchBytes.ok) throw new Error("setup failed");
	const launchConfig = decodeSandboxLaunchConfig(launchBytes.bytes);
	if (!launchConfig.ok) throw new Error("setup failed");
	const fields = {
		launcherPublicKey,
		homePublicKey,
		archiveSha256,
		manifestSha256,
		launcherSha256,
		protocolNonce: protocolNonce.value,
	};
	const signature = await signSandboxReadinessBundle(runtimeIdentity.value, fields);
	if (!signature.ok) throw new Error("setup failed");
	const bundle = buildSandboxReadinessBundle({ ...fields, signature: signature.value });
	if (!bundle.ok) throw new Error("setup failed");
	const decoded = decodeSandboxReadinessBundle(bundle.bytes);
	if (!decoded.ok) throw new Error("setup failed");
	return {
		homeIdentity: homeIdentity.value,
		runtimeIdentity: runtimeIdentity.value,
		protocolNonce: protocolNonce.value,
		launchConfig: launchConfig.config,
		bundleText: new TextDecoder().decode(bundle.bytes),
	};
}

describe("Home-private sandbox runtime connection", () => {
	test("keeps the endpoint private while completing native handshake and activation", async () => {
		const state = await setup();
		let finishRuntime: ((value: boolean) => void) | undefined;
		const runtimeDone = new Promise<boolean>((resolve) => {
			finishRuntime = resolve;
		});
		const listener = await listenSandboxRuntimeTcp(async (io) => {
			const handshake = await performSandboxRuntimeHandshake(
				io,
				state.runtimeIdentity,
				state.launchConfig,
				state.protocolNonce,
			);
			if (!handshake.ok) {
				finishRuntime?.(false);
				return;
			}
			const frame = await readFrame(io);
			if (frame === undefined) {
				finishRuntime?.(false);
				return;
			}
			const activated = await acceptSandboxRuntimeActivation(handshake.channel, frame);
			if (!activated.ok) {
				finishRuntime?.(false);
				return;
			}
			const written = await io.writeExact(activated.value.ackFrame, 3_000);
			if (!written) {
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
				if (requestFrame.ok) requestFrame.value.fill(0);
				finishRuntime?.(false);
				return;
			}
			requestFrame.value.fill(0);
			const ackFrame = await readFrame(io);
			if (ackFrame === undefined) {
				finishRuntime?.(false);
				return;
			}
			const ackPlaintext = await decryptSandboxTransportFrame(handshake.channel, ackFrame);
			ackFrame.fill(0);
			if (!ackPlaintext.ok || ackPlaintext.value.streamId !== 0n) {
				finishRuntime?.(false);
				return;
			}
			const ack = decodeSandboxRequestDeliveryAck(ackPlaintext.value.plaintext);
			ackPlaintext.value.plaintext.fill(0);
			if (!ack.ok || ack.value !== 1n) {
				finishRuntime?.(false);
				return;
			}
			const replyFrame = await readFrame(io);
			if (replyFrame === undefined) {
				finishRuntime?.(false);
				return;
			}
			const replyPlaintext = await decryptSandboxTransportFrame(handshake.channel, replyFrame);
			replyFrame.fill(0);
			if (!replyPlaintext.ok || replyPlaintext.value.streamId !== 0n) {
				finishRuntime?.(false);
				return;
			}
			const reply = decodeSandboxInferenceReply(replyPlaintext.value.plaintext);
			replyPlaintext.value.plaintext.fill(0);
			if (
				!reply.ok ||
				!reply.value.ok ||
				reply.value.requestId !== 1n ||
				reply.value.text !== "home model response"
			) {
				finishRuntime?.(false);
				return;
			}
			await io.waitClosed();
			closeSandboxRuntimeActivation(activated.value.activation);
			closeSandboxTransportChannel(handshake.channel);
			finishRuntime?.(true);
		});
		if (!listener.ok) throw new Error("listen failed");
		let stage = 0;
		const dispatch: SandboxFetchPort = async () => {
			stage += 1;
			if (stage === 1) {
				return new Response(
					JSON.stringify({
						gateway_url: "https://gateway.example.com/base/",
						user_ns: "user_ns",
						job_id: "job_123",
						token: "test-token",
						expires_at: "2099-09-04T12:30:00Z",
						is_vm: false,
					}),
				);
			}
			if (stage === 2) return new Response(JSON.stringify({ stdout: state.bundleText, stderr: "", exit_code: 0 }));
			if (stage === 3) return new Response(JSON.stringify({ exposures: [] }));
			if (stage === 4) {
				return new Response(
					JSON.stringify({
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
					}),
				);
			}
			if (stage === 5) return new Response(JSON.stringify({}));
			return new Response(JSON.stringify({ exposures: [] }));
		};
		const provider = createPrimeSandboxProviderPort("test-api-key", SANDBOX_ID, dispatch);
		if (!provider.ok) throw new Error("provider failed");
		const readiness = await provider.value.bootstrapAndLaunch();
		if (!readiness.ok) throw new Error("launch failed");
		expect(await provider.value.exposeRuntime()).toEqual({ ok: true });
		const connected = await connectAndActivateSandboxRuntime(
			provider.value,
			state.homeIdentity,
			readiness.value,
			"prime-inference/test-model",
		);
		expect(connected.ok).toBe(true);
		if (!connected.ok) return;
		expect(Object.keys(connected.value)).toEqual([]);
		expect(Object.hasOwn(connected.value, "host")).toBe(false);
		expect(Object.hasOwn(connected.value, "port")).toBe(false);
		let proxied: Readonly<{ model: string; input: string }> = Object.freeze({ model: "", input: "" });
		expect(
			await proxyNextSandboxInference(connected.value, async (request) => {
				proxied = request;
				return Object.freeze({ ok: true, text: "home model response" });
			}),
		).toEqual({ ok: true, value: true });
		expect(proxied).toEqual({ model: "prime-inference/test-model", input: "private prompt" });
		expect(await closeSandboxHomeRuntimeConnection(connected.value)).toEqual({ ok: true, value: true });
		expect(await runtimeDone).toBe(true);
		expect(await provider.value.unexposeAndProveAbsent()).toEqual({ ok: true });
		expect(await provider.value.close()).toEqual({ ok: true });
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
		expect(stage).toBe(6);
	});

	test("aborts and settles the socket after provider connection", async () => {
		const state = await setup();
		const controller = new AbortController();
		let closed = false;
		const io: SandboxTcpIo = Object.freeze({
			async readExact() {
				controller.abort();
				return undefined;
			},
			async writeExact() {
				return false;
			},
			close() {
				closed = true;
			},
			async waitClosed() {},
		});
		let stage = 0;
		const provider = createPrimeSandboxProviderPort(
			"test-api-key",
			SANDBOX_ID,
			async () => {
				stage += 1;
				if (stage === 1) {
					return new Response(
						JSON.stringify({
							gateway_url: "https://gateway.example.com/base/",
							user_ns: "user_ns",
							job_id: "job_123",
							token: "test-token",
							expires_at: "2099-09-04T12:30:00Z",
							is_vm: false,
						}),
					);
				}
				if (stage === 2)
					return new Response(JSON.stringify({ stdout: state.bundleText, stderr: "", exit_code: 0 }));
				if (stage === 3) return new Response(JSON.stringify({ exposures: [] }));
				if (stage === 4) {
					return new Response(
						JSON.stringify({
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
						}),
					);
				}
				if (stage === 5) return new Response(JSON.stringify({}));
				return new Response(JSON.stringify({ exposures: [] }));
			},
			async () => Object.freeze({ ok: true, value: io }),
		);
		if (!provider.ok) throw new Error("provider failed");
		const readiness = await provider.value.bootstrapAndLaunch();
		if (!readiness.ok) throw new Error("launch failed");
		expect(await provider.value.exposeRuntime()).toEqual({ ok: true });
		expect(
			await connectAndActivateSandboxRuntime(
				provider.value,
				state.homeIdentity,
				readiness.value,
				"model",
				controller.signal,
			),
		).toEqual({ ok: false, code: "ABORTED" });
		expect(closed).toBe(true);
		expect(await provider.value.unexposeAndProveAbsent()).toEqual({ ok: true });
		expect(await provider.value.close()).toEqual({ ok: true });
		expect(stage).toBe(6);
	});

	test("rejects forged readiness and connection capabilities", async () => {
		expect(() => new SandboxHomeRuntimeConnection({})).toThrow();
		expect(await closeSandboxHomeRuntimeConnection(Object.freeze({}))).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		const state = await setup();
		const provider = createPrimeSandboxProviderPort("test-api-key", SANDBOX_ID, async () => new Response("{}"));
		if (!provider.ok) throw new Error("provider failed");
		expect(
			await connectAndActivateSandboxRuntime(provider.value, state.homeIdentity, Object.freeze({}), "model"),
		).toEqual({
			ok: false,
			code: "READINESS_INVALID",
		});
	});
});
