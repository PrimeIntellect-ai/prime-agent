import { types } from "node:util";

const WRAPPER_FLAG = "--prime-agent-fd3-bootstrap";
const RUNTIME_FLAG = "--prime-agent-runtime-fd3";
const NONCE_FLAG = "--ready-nonce";
const NONCE_RE = /^[0-9a-f]{32}$/;

export const SANDBOX_RUNTIME_BOOTSTRAP_FD = 3;

export type SandboxBootstrapModeResult =
	| Readonly<{ ok: true; mode: "wrapper" | "runtime"; readyNonce: string }>
	| Readonly<{ ok: false }>;

export function parseSandboxBootstrapMode(raw: unknown): SandboxBootstrapModeResult {
	try {
		if (
			typeof raw !== "object" ||
			raw === null ||
			types.isProxy(raw) ||
			!Array.isArray(raw) ||
			Object.getPrototypeOf(raw) !== Array.prototype ||
			raw.length !== 3 ||
			Object.getOwnPropertySymbols(raw).length !== 0
		)
			return Object.freeze({ ok: false as const });
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== 4 || !names.includes("length")) return Object.freeze({ ok: false as const });
		const values: unknown[] = [];
		for (let index = 0; index < 3; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				return Object.freeze({ ok: false as const });
			}
			values.push(descriptor.value);
		}
		const mode = values[0] === WRAPPER_FLAG ? "wrapper" : values[0] === RUNTIME_FLAG ? "runtime" : null;
		const readyNonce = values[2];
		if (mode === null || values[1] !== NONCE_FLAG || typeof readyNonce !== "string" || !NONCE_RE.test(readyNonce)) {
			return Object.freeze({ ok: false as const });
		}
		return Object.freeze({ ok: true as const, mode, readyNonce });
	} catch {
		return Object.freeze({ ok: false as const });
	}
}
