import { type BigIntStats, closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { decodeSandboxLaunchConfig, type SandboxLaunchConfig } from "./prime-sandbox-launch-config.js";

const LAUNCH_CONFIG_PATH = "/opt/prime-agent-sandbox-v1/prime-agent-runtime-v1/prime-agent-launch.json";
const MAX_BYTES = 1_024;
const EXPECTED_MODE = 0o444n;
// The protected runtime is built only for the pinned Linux/amd64 target.
const O_CLOEXEC_LINUX = 0x80_000;

export type SandboxLaunchConfigFileResult =
	| Readonly<{ ok: true; value: SandboxLaunchConfig }>
	| Readonly<{ ok: false; code: "CONFIG_INVALID" }>;

function failure(): Readonly<{ ok: false; code: "CONFIG_INVALID" }> {
	return Object.freeze({ ok: false, code: "CONFIG_INVALID" });
}

function validMetadata(value: BigIntStats): boolean {
	return (
		value.isFile() &&
		value.uid === 0n &&
		value.gid === 0n &&
		value.nlink === 1n &&
		(value.mode & 0o7777n) === EXPECTED_MODE &&
		value.size > 0n &&
		value.size <= BigInt(MAX_BYTES)
	);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.nlink === right.nlink &&
		left.mode === right.mode &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

export function readProtectedSandboxLaunchConfig(): SandboxLaunchConfigFileResult {
	let descriptor: number | undefined;
	let bytes: Uint8Array<ArrayBuffer> | undefined;
	try {
		descriptor = openSync(LAUNCH_CONFIG_PATH, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC_LINUX);
		const before = fstatSync(descriptor, { bigint: true });
		if (!validMetadata(before)) return failure();
		const size = Number(before.size);
		bytes = new Uint8Array(new ArrayBuffer(size));
		let offset = 0;
		while (offset < size) {
			const count = readSync(descriptor, bytes, offset, size - offset, offset);
			if (count < 1) return failure();
			offset += count;
		}
		const after = fstatSync(descriptor, { bigint: true });
		if (!validMetadata(after) || !sameFile(before, after)) return failure();
		const decoded = decodeSandboxLaunchConfig(bytes);
		if (!decoded.ok) return failure();
		closeSync(descriptor);
		descriptor = undefined;
		return Object.freeze({ ok: true, value: decoded.config });
	} catch {
		return failure();
	} finally {
		bytes?.fill(0);
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// The caller receives only the fixed failure/success surface.
			}
		}
	}
}
