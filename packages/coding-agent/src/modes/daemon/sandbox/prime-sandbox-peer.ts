import { closeSync, writeSync } from "node:fs";
import {
	acceptSandboxRuntimeActivation,
	closeSandboxRuntimeActivation,
	type SandboxRuntimeActivation,
} from "./prime-sandbox-activation.js";
import { performSandboxRuntimeHandshake } from "./prime-sandbox-handshake.js";
import {
	closeSandboxLaunchConfig,
	copyLaunchConfigArchiveSha256,
	copyLaunchConfigHomePublicKey,
	copyLaunchConfigLauncherSha256,
	copyLaunchConfigManifestSha256,
} from "./prime-sandbox-launch-config.js";
import { readProtectedSandboxLaunchConfig } from "./prime-sandbox-launch-config-file.js";
import { buildSandboxReadinessBundle } from "./prime-sandbox-readiness-bundle.js";
import {
	closeSandboxTcpListener,
	listenSandboxRuntimeTcp,
	type SandboxTcpIo,
	type SandboxTcpListener,
	waitSandboxTcpListenerClosed,
} from "./prime-sandbox-tcp.js";
import {
	closeSandboxEd25519KeyPair,
	closeSandboxTransportChannel,
	copySandboxEd25519PublicKey,
	generateSandboxEd25519KeyPair,
	randomSandboxHandshakeBytes,
	SANDBOX_TRANSPORT_HEADER_BYTES,
	SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES,
	SANDBOX_TRANSPORT_TAG_BYTES,
	type SandboxEd25519KeyPair,
	type SandboxTransportChannel,
	signSandboxReadinessBundle,
} from "./prime-sandbox-transport.js";
import { isExactUint8Array as exactBytes } from "./prime-sandbox-validation.js";

const EXIT_FAILURE = 91;
const ACTIVATION_TIMEOUT_MS = 3_000;

function zero(...values: (Uint8Array | undefined)[]): void {
	for (const value of values) value?.fill(0);
}

async function readActivationFrame(io: SandboxTcpIo): Promise<Uint8Array<ArrayBuffer> | undefined> {
	try {
		const header = await io.readExact(SANDBOX_TRANSPORT_HEADER_BYTES, ACTIVATION_TIMEOUT_MS);
		if (!exactBytes(header) || header.byteLength !== SANDBOX_TRANSPORT_HEADER_BYTES) return undefined;
		const plaintextBytes = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(16, false);
		if (plaintextBytes > SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES) {
			header.fill(0);
			return undefined;
		}
		const payload = await io.readExact(plaintextBytes + SANDBOX_TRANSPORT_TAG_BYTES, ACTIVATION_TIMEOUT_MS);
		if (!exactBytes(payload) || payload.byteLength !== plaintextBytes + SANDBOX_TRANSPORT_TAG_BYTES) {
			header.fill(0);
			return undefined;
		}
		const wireBytes = SANDBOX_TRANSPORT_HEADER_BYTES + payload.byteLength;
		const wire = new Uint8Array(new ArrayBuffer(wireBytes));
		wire.set(header);
		wire.set(payload, SANDBOX_TRANSPORT_HEADER_BYTES);
		zero(header, payload);
		return wire;
	} catch {
		return undefined;
	}
}

function writeRendezvous(bytes: Uint8Array): boolean {
	try {
		const written = writeSync(3, bytes, 0, bytes.byteLength);
		if (written !== bytes.byteLength) return false;
		closeSync(3);
		return true;
	} catch {
		try {
			closeSync(3);
		} catch {
			// The peer exits with one fixed failure and no output.
		}
		return false;
	}
}

async function main(): Promise<number> {
	const configResult = readProtectedSandboxLaunchConfig();
	if (!configResult.ok) return EXIT_FAILURE;
	const config = configResult.value;
	const homePublicKey = copyLaunchConfigHomePublicKey(config);
	const archiveSha256 = copyLaunchConfigArchiveSha256(config);
	const manifestSha256 = copyLaunchConfigManifestSha256(config);
	const launcherSha256 = copyLaunchConfigLauncherSha256(config);
	const identityResult = await generateSandboxEd25519KeyPair();
	const protocolNonceResult = randomSandboxHandshakeBytes();
	if (
		homePublicKey === undefined ||
		archiveSha256 === undefined ||
		manifestSha256 === undefined ||
		launcherSha256 === undefined ||
		!identityResult.ok ||
		!protocolNonceResult.ok
	) {
		zero(homePublicKey, archiveSha256, manifestSha256, launcherSha256);
		closeSandboxLaunchConfig(config);
		return EXIT_FAILURE;
	}
	const identity: SandboxEd25519KeyPair = identityResult.value;
	const protocolNonce = protocolNonceResult.value;
	const launcherPublicKey = copySandboxEd25519PublicKey(identity);
	if (launcherPublicKey === undefined) {
		zero(homePublicKey, archiveSha256, manifestSha256, launcherSha256, protocolNonce);
		closeSandboxEd25519KeyPair(identity);
		closeSandboxLaunchConfig(config);
		return EXIT_FAILURE;
	}
	const fields = {
		launcherPublicKey,
		homePublicKey,
		archiveSha256,
		manifestSha256,
		launcherSha256,
		protocolNonce,
	};
	const signature = await signSandboxReadinessBundle(identity, fields);
	if (!signature.ok) {
		zero(launcherPublicKey, homePublicKey, archiveSha256, manifestSha256, launcherSha256, protocolNonce);
		closeSandboxEd25519KeyPair(identity);
		closeSandboxLaunchConfig(config);
		return EXIT_FAILURE;
	}
	const bundle = buildSandboxReadinessBundle({ ...fields, signature: signature.value });
	zero(launcherPublicKey, homePublicKey, archiveSha256, manifestSha256, launcherSha256, signature.value);
	if (!bundle.ok) {
		zero(protocolNonce);
		closeSandboxEd25519KeyPair(identity);
		closeSandboxLaunchConfig(config);
		return EXIT_FAILURE;
	}
	let listener: SandboxTcpListener | undefined;
	let activeIo: SandboxTcpIo | undefined;
	let activeChannel: SandboxTransportChannel | undefined;
	let sessionActivation: SandboxRuntimeActivation | undefined;
	let shuttingDown = false;

	const shutdown = async (exitCode: number): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		activeIo?.close();
		if (activeChannel !== undefined) closeSandboxTransportChannel(activeChannel);
		if (sessionActivation !== undefined) closeSandboxRuntimeActivation(sessionActivation);
		if (listener !== undefined) await closeSandboxTcpListener(listener);
		closeSandboxEd25519KeyPair(identity);
		closeSandboxLaunchConfig(config);
		zero(protocolNonce, bundle.bytes);
		process.exit(exitCode);
	};
	process.once("SIGTERM", () => void shutdown(0));
	process.once("SIGINT", () => void shutdown(0));

	const listened = await listenSandboxRuntimeTcp(async (io) => {
		if (shuttingDown) {
			io.close();
			return;
		}
		activeIo = io;
		const handshake = await performSandboxRuntimeHandshake(io, identity, config, protocolNonce);
		if (!handshake.ok) {
			if (activeIo === io) activeIo = undefined;
			return;
		}
		activeChannel = handshake.channel;
		if (sessionActivation !== undefined) {
			closeSandboxTransportChannel(handshake.channel);
			io.close();
			activeChannel = undefined;
			activeIo = undefined;
			return;
		}
		const frame = await readActivationFrame(io);
		if (frame === undefined) {
			closeSandboxTransportChannel(handshake.channel);
			io.close();
			activeChannel = undefined;
			activeIo = undefined;
			return;
		}
		const activation = await acceptSandboxRuntimeActivation(handshake.channel, frame);
		frame.fill(0);
		if (!activation.ok) {
			io.close();
			activeChannel = undefined;
			activeIo = undefined;
			return;
		}
		const written = await io.writeExact(activation.value.ackFrame, ACTIVATION_TIMEOUT_MS);
		activation.value.ackFrame.fill(0);
		if (!written) {
			closeSandboxRuntimeActivation(activation.value.activation);
			closeSandboxTransportChannel(handshake.channel);
			io.close();
			activeChannel = undefined;
			activeIo = undefined;
			return;
		}
		sessionActivation = activation.value.activation;
		await io.waitClosed();
		closeSandboxTransportChannel(handshake.channel);
		if (activeChannel === handshake.channel) activeChannel = undefined;
		if (activeIo === io) activeIo = undefined;
	});
	if (!listened.ok) {
		closeSandboxEd25519KeyPair(identity);
		closeSandboxLaunchConfig(config);
		zero(protocolNonce, bundle.bytes);
		return EXIT_FAILURE;
	}
	listener = listened.value;
	void waitSandboxTcpListenerClosed(listener)
		.then(() => {
			if (!shuttingDown) void shutdown(EXIT_FAILURE);
		})
		.catch(() => {
			if (!shuttingDown) void shutdown(EXIT_FAILURE);
		});
	if (!writeRendezvous(bundle.bytes)) {
		shuttingDown = true;
		await closeSandboxTcpListener(listener);
		closeSandboxEd25519KeyPair(identity);
		closeSandboxLaunchConfig(config);
		zero(protocolNonce, bundle.bytes);
		return EXIT_FAILURE;
	}
	bundle.bytes.fill(0);
	return 0;
}

const exitCode = await main();
if (exitCode !== 0) process.exit(exitCode);
