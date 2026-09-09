import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
	acceptSandboxRuntimeActivation,
	closeSandboxRuntimeActivation,
	confirmSandboxHomeActivation,
	createSandboxHomeActivation,
	encryptSandboxHomeActivation,
} from "../src/modes/daemon/sandbox/prime-sandbox-activation.js";
import {
	performSandboxHomeHandshake,
	performSandboxRuntimeHandshake,
	type SandboxHandshakeIo,
} from "../src/modes/daemon/sandbox/prime-sandbox-handshake.js";
import {
	buildSandboxLaunchConfig,
	decodeSandboxLaunchConfig,
} from "../src/modes/daemon/sandbox/prime-sandbox-launch-config.js";
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
	closeSandboxTransportChannel,
	copySandboxEd25519PublicKey,
	decryptSandboxTransportFrame,
	encryptSandboxTransportFrame,
	generateSandboxEd25519KeyPair,
	signSandboxReadinessBundle,
} from "../src/modes/daemon/sandbox/prime-sandbox-transport.js";

interface PendingRead {
	readonly length: number;
	readonly resolve: (value: unknown) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

class MemoryIo implements SandboxHandshakeIo {
	private peer: MemoryIo | undefined;
	private buffered = new Uint8Array(0);
	private pending: PendingRead | undefined;
	private closed = false;
	private readonly mutate: ((value: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>) | undefined;

	constructor(mutate?: (value: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>) {
		this.mutate = mutate;
	}

	connect(peer: MemoryIo): void {
		this.peer = peer;
	}

	async readExact(length: number, timeoutMs: number): Promise<unknown> {
		if (this.closed || this.pending !== undefined || length < 1) return undefined;
		const immediate = this.take(length);
		if (immediate !== undefined) return immediate;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (this.pending?.resolve !== resolve) return;
				this.pending = undefined;
				resolve(undefined);
			}, timeoutMs);
			this.pending = Object.freeze({ length, resolve, timer });
		});
	}

	async writeExact(value: Uint8Array<ArrayBuffer>, _timeoutMs: number): Promise<boolean> {
		const peer = this.peer;
		if (this.closed || peer === undefined || peer.closed) return false;
		const copied = new Uint8Array(new ArrayBuffer(value.byteLength));
		copied.set(value);
		const sent = this.mutate === undefined ? copied : this.mutate(copied);
		for (let index = 0; index < sent.byteLength; index += 1) {
			peer.receive(sent.slice(index, index + 1));
		}
		return true;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.finishPending();
		this.peer?.remoteClose();
	}

	private remoteClose(): void {
		if (this.closed) return;
		this.closed = true;
		this.finishPending();
	}

	private finishPending(): void {
		const pending = this.pending;
		this.pending = undefined;
		if (pending === undefined) return;
		clearTimeout(pending.timer);
		pending.resolve(undefined);
	}

	private receive(value: Uint8Array<ArrayBuffer>): void {
		if (this.closed || this.buffered.byteLength > 4096 - value.byteLength) {
			this.close();
			return;
		}
		const next = new Uint8Array(new ArrayBuffer(this.buffered.byteLength + value.byteLength));
		next.set(this.buffered);
		next.set(value, this.buffered.byteLength);
		this.buffered.fill(0);
		this.buffered = next;
		const pending = this.pending;
		if (pending === undefined) return;
		const taken = this.take(pending.length);
		if (taken === undefined) return;
		this.pending = undefined;
		clearTimeout(pending.timer);
		pending.resolve(taken);
	}

	private take(length: number): Uint8Array<ArrayBuffer> | undefined {
		if (this.buffered.byteLength < length) return undefined;
		const result = this.buffered.slice(0, length);
		const remainder = this.buffered.slice(length);
		this.buffered.fill(0);
		this.buffered = remainder;
		return result;
	}
}

function ioPair(
	mutateRuntime?: (value: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>,
	mutateHome?: (value: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>,
): {
	home: MemoryIo;
	runtime: MemoryIo;
} {
	const home = new MemoryIo(mutateHome);
	const runtime = new MemoryIo(mutateRuntime);
	home.connect(runtime);
	runtime.connect(home);
	return { home, runtime };
}

function sequence(start: number, length: number): Uint8Array<ArrayBuffer> {
	const value = new Uint8Array(new ArrayBuffer(length));
	for (let index = 0; index < length; index += 1) value[index] = (start + index) & 0xff;
	return value;
}

async function setup() {
	const homeIdentity = await generateSandboxEd25519KeyPair();
	const runtimeIdentity = await generateSandboxEd25519KeyPair();
	if (!homeIdentity.ok || !runtimeIdentity.ok) throw new Error("setup failed");
	const homePublicKey = copySandboxEd25519PublicKey(homeIdentity.value);
	const launcherPublicKey = copySandboxEd25519PublicKey(runtimeIdentity.value);
	if (homePublicKey === undefined || launcherPublicKey === undefined) throw new Error("setup failed");
	const archiveSha256 = sequence(0x20, 32);
	const manifestSha256 = sequence(0x40, 32);
	const launcherSha256 = sequence(0x60, 32);
	const protocolNonce = sequence(0x80, 32);
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
	const bundleFields = {
		launcherPublicKey,
		homePublicKey,
		archiveSha256,
		manifestSha256,
		launcherSha256,
		protocolNonce,
	};
	const signature = await signSandboxReadinessBundle(runtimeIdentity.value, bundleFields);
	if (!signature.ok) throw new Error("setup failed");
	const bundle = buildSandboxReadinessBundle({ ...bundleFields, signature: signature.value });
	if (!bundle.ok) throw new Error("setup failed");
	const readiness = decodeSandboxReadinessBundle(bundle.bytes);
	if (!readiness.ok) throw new Error("setup failed");
	return {
		homeIdentity: homeIdentity.value,
		runtimeIdentity: runtimeIdentity.value,
		launchConfig: launchConfig.config,
		readiness: readiness.readiness,
		protocolNonce,
	};
}

async function readWireFrame(io: SandboxHandshakeIo): Promise<Uint8Array<ArrayBuffer> | undefined> {
	const header = await io.readExact(32, 3_000);
	if (!(header instanceof Uint8Array) || Object.getPrototypeOf(header) !== Uint8Array.prototype) return undefined;
	const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(16, false);
	if (length > 262_144) return undefined;
	const payload = await io.readExact(length + 16, 3_000);
	if (!(payload instanceof Uint8Array) || Object.getPrototypeOf(payload) !== Uint8Array.prototype) return undefined;
	const wire = new Uint8Array(new ArrayBuffer(32 + length + 16));
	wire.set(header);
	wire.set(payload, 32);
	header.fill(0);
	payload.fill(0);
	return wire;
}

describe("sandbox mutual handshake", () => {
	test("completes all phases over fragmented duplex I/O and establishes matching channels", async () => {
		const state = await setup();
		const io = ioPair();
		const [home, runtime] = await Promise.all([
			performSandboxHomeHandshake(io.home, state.homeIdentity, state.readiness),
			performSandboxRuntimeHandshake(io.runtime, state.runtimeIdentity, state.launchConfig, state.protocolNonce),
		]);
		expect(home.ok).toBe(true);
		expect(runtime.ok).toBe(true);
		if (!home.ok || !runtime.ok) return;
		const plaintext = sequence(1, 37);
		const sent = await encryptSandboxTransportFrame(home.channel, 0n, plaintext);
		if (!sent.ok) throw new Error("send failed");
		expect(await decryptSandboxTransportFrame(runtime.channel, sent.value)).toEqual({
			ok: true,
			value: { streamId: 0n, plaintext },
		});
		const reply = await encryptSandboxTransportFrame(runtime.channel, 1n, sequence(90, 19));
		if (!reply.ok) throw new Error("send failed");
		expect(await decryptSandboxTransportFrame(home.channel, reply.value)).toEqual({
			ok: true,
			value: { streamId: 1n, plaintext: sequence(90, 19) },
		});
	});

	test("rejects a Home identity that does not match the signed readiness", async () => {
		const state = await setup();
		const wrongHome = await generateSandboxEd25519KeyPair();
		if (!wrongHome.ok) throw new Error("setup failed");
		const io = ioPair();
		const [home, runtime] = await Promise.all([
			performSandboxHomeHandshake(io.home, wrongHome.value, state.readiness),
			performSandboxRuntimeHandshake(io.runtime, state.runtimeIdentity, state.launchConfig, state.protocolNonce),
		]);
		expect(home.ok).toBe(false);
		expect(runtime.ok).toBe(false);
	});

	test("rejects a tampered runtime possession signature", async () => {
		const state = await setup();
		let changed = false;
		const io = ioPair((value) => {
			if (!changed && value.byteLength === 64) {
				changed = true;
				value[0] ^= 1;
			}
			return value;
		});
		const [home, runtime] = await Promise.all([
			performSandboxHomeHandshake(io.home, state.homeIdentity, state.readiness),
			performSandboxRuntimeHandshake(io.runtime, state.runtimeIdentity, state.launchConfig, state.protocolNonce),
		]);
		expect(changed).toBe(true);
		expect(home.ok).toBe(false);
		expect(runtime.ok).toBe(false);
	});

	test("maps missing I/O to a fixed failure and closes", async () => {
		const state = await setup();
		let closes = 0;
		const io: SandboxHandshakeIo = {
			async readExact() {
				return undefined;
			},
			async writeExact() {
				return false;
			},
			close() {
				closes += 1;
			},
		};
		expect(await performSandboxHomeHandshake(io, state.homeIdentity, state.readiness)).toEqual({
			ok: false,
			code: "IO_FAILURE",
		});
		expect(closes).toBe(1);
	});

	test("rejects wrong magic, nonce, ACK, and READY echo", async () => {
		for (const changedWrite of [0, 1, 3, 4]) {
			const state = await setup();
			let writeIndex = 0;
			const io = ioPair((value) => {
				if (writeIndex === changedWrite) value[0] ^= 1;
				writeIndex += 1;
				return value;
			});
			const [home, runtime] = await Promise.all([
				performSandboxHomeHandshake(io.home, state.homeIdentity, state.readiness),
				performSandboxRuntimeHandshake(io.runtime, state.runtimeIdentity, state.launchConfig, state.protocolNonce),
			]);
			expect(home.ok).toBe(false);
			expect(runtime.ok).toBe(false);
		}
	});

	test("rejects hostile runtime inputs before dispatch", async () => {
		const state = await setup();
		const resizable: unknown = Reflect.construct(ArrayBuffer, [32, { maxByteLength: 64 }]);
		if (!(resizable instanceof ArrayBuffer)) throw new Error("setup failed");
		Object.defineProperty(resizable, "resizable", { value: false });
		const hostileNonce = new Uint8Array(resizable);
		const inputs: ReadonlyArray<readonly [unknown, unknown, unknown]> = [
			[Object.freeze({}), state.launchConfig, state.protocolNonce],
			[state.runtimeIdentity, Object.freeze({}), state.protocolNonce],
			[state.runtimeIdentity, state.launchConfig, new Proxy(state.protocolNonce, {})],
			[state.runtimeIdentity, state.launchConfig, Buffer.alloc(32)],
			[state.runtimeIdentity, state.launchConfig, hostileNonce],
		];
		for (const [identity, config, nonce] of inputs) {
			let closes = 0;
			const io: SandboxHandshakeIo = {
				async readExact() {
					throw new Error("must not read");
				},
				async writeExact() {
					throw new Error("must not write");
				},
				close() {
					closes += 1;
				},
			};
			expect(await performSandboxRuntimeHandshake(io, identity, config, nonce)).toEqual({
				ok: false,
				code: "INPUT_INVALID",
			});
			expect(closes).toBe(1);
		}
	});

	test("maps missing runtime I/O to a fixed failure and closes", async () => {
		const state = await setup();
		let closes = 0;
		const io: SandboxHandshakeIo = {
			async readExact() {
				return undefined;
			},
			async writeExact() {
				return false;
			},
			close() {
				closes += 1;
			},
		};
		expect(
			await performSandboxRuntimeHandshake(io, state.runtimeIdentity, state.launchConfig, state.protocolNonce),
		).toEqual({
			ok: false,
			code: "IO_FAILURE",
		});
		expect(closes).toBe(1);
	});

	test("completes handshake and activation through the native TCP listener", async () => {
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
			const frame = await readWireFrame(io);
			if (frame === undefined) {
				closeSandboxTransportChannel(handshake.channel);
				finishRuntime?.(false);
				return;
			}
			const activated = await acceptSandboxRuntimeActivation(handshake.channel, frame);
			frame.fill(0);
			if (!activated.ok) {
				finishRuntime?.(false);
				return;
			}
			const written = await io.writeExact(activated.value.ackFrame, 3_000);
			activated.value.ackFrame.fill(0);
			closeSandboxRuntimeActivation(activated.value.activation);
			closeSandboxTransportChannel(handshake.channel);
			io.close();
			finishRuntime?.(written);
		});
		if (!listener.ok) throw new Error("listen failed");
		const connected = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (!connected.ok) throw new Error("connect failed");
		const handshake = await performSandboxHomeHandshake(connected.value, state.homeIdentity, state.readiness);
		expect(handshake.ok).toBe(true);
		if (!handshake.ok) return;
		const activation = createSandboxHomeActivation();
		if (!activation.ok) throw new Error("activation failed");
		const frame = await encryptSandboxHomeActivation(handshake.channel, activation.value);
		if (!frame.ok) throw new Error("activation failed");
		expect(await connected.value.writeExact(frame.value, 3_000)).toBe(true);
		frame.value.fill(0);
		const ackFrame = await readWireFrame(connected.value);
		if (ackFrame === undefined) throw new Error("activation failed");
		expect(await confirmSandboxHomeActivation(handshake.channel, activation.value, ackFrame)).toEqual({
			ok: true,
			value: true,
		});
		ackFrame.fill(0);
		expect(await runtimeDone).toBe(true);
		connected.value.close();
		closeSandboxTransportChannel(handshake.channel);
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});
});
