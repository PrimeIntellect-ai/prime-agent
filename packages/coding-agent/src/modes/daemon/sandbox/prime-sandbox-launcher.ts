import { closeSync, writeSync } from "node:fs";
import {
	closeSandboxLaunchConfig,
	copyLaunchConfigArchiveSha256,
	copyLaunchConfigHomePublicKey,
	copyLaunchConfigLauncherSha256,
	copyLaunchConfigManifestSha256,
} from "./prime-sandbox-launch-config.js";
import { readProtectedSandboxLaunchConfig } from "./prime-sandbox-launch-config-file.js";
import {
	closeSandboxReadinessBundle,
	copyReadinessArchiveSha256,
	copyReadinessHomePublicKey,
	copyReadinessLauncherPublicKey,
	copyReadinessLauncherSha256,
	copyReadinessManifestSha256,
	copyReadinessProtocolNonce,
	copyReadinessSignature,
	decodeSandboxReadinessBundle,
} from "./prime-sandbox-readiness-bundle.js";
import { verifySandboxReadinessBundle } from "./prime-sandbox-transport.js";
import { equalBytes } from "./prime-sandbox-validation.js";

interface SandboxPeerProcess {
	readonly stdio: readonly unknown[];
	readonly exited: Promise<number>;
	kill(signal: number): void;
	unref(): void;
}

declare var Bun: {
	file(descriptor: number): { stream(): ReadableStream<Uint8Array> };
	spawn(
		argv: string[],
		options: {
			readonly cwd: string;
			readonly env: Readonly<Record<string, string>>;
			readonly detached: boolean;
			readonly stdio: readonly ["ignore", "ignore", "ignore", "pipe"];
		},
	): SandboxPeerProcess;
};

const EXECUTABLE = "/opt/prime-agent-sandbox-v1/prime-agent-runtime-v1/prime-agent";
const WORKSPACE = "/tmp/prime-agent-workspace-v1";
const EXIT_FAILURE = 91;
const MAX_READINESS_BYTES = 1_024;
const READINESS_TIMEOUT_MS = 5_000;
const TERMINATION_TIMEOUT_MS = 1_000;
const PEER_ENVIRONMENT = Object.freeze({
	HOME: WORKSPACE,
	TMPDIR: `${WORKSPACE}/tmp`,
	PATH: "/usr/local/bin:/usr/bin:/bin",
	LANG: "C.UTF-8",
	LC_ALL: "C.UTF-8",
});

function zero(...values: (Uint8Array | undefined)[]): void {
	for (const value of values) value?.fill(0);
}

async function readRendezvous(descriptor: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
	const reader = Bun.file(descriptor).stream().getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let total = 0;
	const reading = (async (): Promise<Uint8Array<ArrayBuffer> | undefined> => {
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				if (next.value.byteLength < 1 || total > MAX_READINESS_BYTES - next.value.byteLength) return undefined;
				const copy = new Uint8Array(new ArrayBuffer(next.value.byteLength));
				copy.set(next.value);
				chunks.push(copy);
				total += copy.byteLength;
			}
			if (total < 1) return undefined;
			const result = new Uint8Array(new ArrayBuffer(total));
			let offset = 0;
			for (const chunk of chunks) {
				result.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return result;
		} catch {
			return undefined;
		} finally {
			for (const chunk of chunks) chunk.fill(0);
		}
	})();
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => {
			timedOut = true;
			void reader.cancel().then(
				() => resolve(undefined),
				() => resolve(undefined),
			);
		}, READINESS_TIMEOUT_MS);
	});
	const result = await Promise.race([reading, timeout]);
	if (timer !== undefined) clearTimeout(timer);
	if (timedOut) await reading;
	try {
		reader.releaseLock();
	} catch {
		result?.fill(0);
		return undefined;
	}
	return result;
}

async function readinessMatchesConfig(bytes: Uint8Array): Promise<boolean> {
	const config = readProtectedSandboxLaunchConfig();
	const readiness = decodeSandboxReadinessBundle(bytes);
	if (!config.ok || !readiness.ok) {
		if (config.ok) closeSandboxLaunchConfig(config.value);
		if (readiness.ok) closeSandboxReadinessBundle(readiness.readiness);
		return false;
	}
	const configHome = copyLaunchConfigHomePublicKey(config.value);
	const configArchive = copyLaunchConfigArchiveSha256(config.value);
	const configManifest = copyLaunchConfigManifestSha256(config.value);
	const configLauncher = copyLaunchConfigLauncherSha256(config.value);
	const launcherPublicKey = copyReadinessLauncherPublicKey(readiness.readiness);
	const homePublicKey = copyReadinessHomePublicKey(readiness.readiness);
	const archiveSha256 = copyReadinessArchiveSha256(readiness.readiness);
	const manifestSha256 = copyReadinessManifestSha256(readiness.readiness);
	const launcherSha256 = copyReadinessLauncherSha256(readiness.readiness);
	const protocolNonce = copyReadinessProtocolNonce(readiness.readiness);
	const signature = copyReadinessSignature(readiness.readiness);
	try {
		if (
			configHome === undefined ||
			configArchive === undefined ||
			configManifest === undefined ||
			configLauncher === undefined ||
			launcherPublicKey === undefined ||
			homePublicKey === undefined ||
			archiveSha256 === undefined ||
			manifestSha256 === undefined ||
			launcherSha256 === undefined ||
			protocolNonce === undefined ||
			signature === undefined ||
			!equalBytes(configHome, homePublicKey) ||
			!equalBytes(configArchive, archiveSha256) ||
			!equalBytes(configManifest, manifestSha256) ||
			!equalBytes(configLauncher, launcherSha256)
		) {
			return false;
		}
		const verified = await verifySandboxReadinessBundle(
			{
				launcherPublicKey,
				homePublicKey,
				archiveSha256,
				manifestSha256,
				launcherSha256,
				protocolNonce,
			},
			signature,
		);
		return verified.ok && verified.value;
	} catch {
		return false;
	} finally {
		zero(
			configHome,
			configArchive,
			configManifest,
			configLauncher,
			launcherPublicKey,
			homePublicKey,
			archiveSha256,
			manifestSha256,
			launcherSha256,
			protocolNonce,
			signature,
		);
		closeSandboxLaunchConfig(config.value);
		closeSandboxReadinessBundle(readiness.readiness);
	}
}

async function terminatePeer(peer: SandboxPeerProcess): Promise<boolean> {
	try {
		peer.kill(9);
	} catch {
		return false;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), TERMINATION_TIMEOUT_MS);
	});
	try {
		const exited = peer.exited.then(() => true).catch(() => false);
		return await Promise.race([exited, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function writeStdout(bytes: Uint8Array): boolean {
	try {
		return writeSync(1, bytes, 0, bytes.byteLength) === bytes.byteLength;
	} catch {
		return false;
	}
}

async function main(): Promise<number> {
	let peer: SandboxPeerProcess;
	try {
		peer = Bun.spawn([EXECUTABLE, "--internal-sandbox-peer"], {
			cwd: WORKSPACE,
			env: PEER_ENVIRONMENT,
			detached: true,
			stdio: ["ignore", "ignore", "ignore", "pipe"],
		});
	} catch {
		return EXIT_FAILURE;
	}
	const descriptor = peer.stdio[3];
	if (typeof descriptor !== "number") {
		await terminatePeer(peer);
		return EXIT_FAILURE;
	}
	let readiness: Uint8Array<ArrayBuffer> | undefined;
	try {
		readiness = await readRendezvous(descriptor);
	} finally {
		try {
			closeSync(descriptor);
		} catch {
			readiness?.fill(0);
			readiness = undefined;
		}
	}
	if (readiness === undefined || !(await readinessMatchesConfig(readiness))) {
		readiness?.fill(0);
		await terminatePeer(peer);
		return EXIT_FAILURE;
	}
	if (!writeStdout(readiness)) {
		readiness.fill(0);
		await terminatePeer(peer);
		return EXIT_FAILURE;
	}
	readiness.fill(0);
	peer.unref();
	return 0;
}

process.exit(await main());
