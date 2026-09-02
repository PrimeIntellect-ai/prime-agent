import { describe, expect, it } from "vitest";
import {
	decodeSandboxBootstrapPayload,
	encodeSandboxBootstrapPayload,
	withBootstrapGrant,
} from "../src/core/sandbox-bootstrap-payload.js";
import { createSandboxFd3BootstrapBridge } from "../src/core/sandbox-fd3-bootstrap-bridge.js";
import { parseSandboxBootstrapMode, SANDBOX_RUNTIME_BOOTSTRAP_FD } from "../src/core/sandbox-fd3-bootstrap-mode.js";
import type { StdinSource } from "../src/core/sandbox-stdin-bootstrap-frame.js";

const NONCE = "0123456789abcdef0123456789abcdef";
const BUILD_ID = "a1b2c3d4e5f6071829a0b1c2d3e4f50617283940a1b2c3d4e5f6071829304150";

function payload(): Uint8Array {
	const result = encodeSandboxBootstrapPayload({
		metadata: {
			hostId: "home-host",
			generation: "generation-1",
			sessionId: "session-1",
			relayUrl: "wss://relay.example.com/prime/v1",
			buildIdentity: {
				buildId: BUILD_ID,
				daemonProtocolVersion: 7,
				daemonSchemaRevision: 25,
			},
			connectTimeoutMs: 30_000,
		},
		grant: new TextEncoder().encode("A".repeat(50)),
	});
	if (!result.ok) throw new Error("fixture failed");
	return result.value;
}

function frame(value: Uint8Array): Uint8Array {
	const output = new Uint8Array(4 + value.byteLength);
	new DataView(output.buffer).setUint32(0, value.byteLength, false);
	output.set(value, 4);
	return output;
}

function source(value: Uint8Array): StdinSource {
	const dataHandlers: Array<(chunk: Uint8Array) => void> = [];
	const endHandlers: Array<() => void> = [];
	const errorHandlers: Array<(error: Error) => void> = [];
	return {
		on(event, listener) {
			if (event === "data") dataHandlers.push(listener as (chunk: Uint8Array) => void);
			else if (event === "end") endHandlers.push(listener as () => void);
			else errorHandlers.push(listener as (error: Error) => void);
		},
		removeListener(event, listener) {
			const handlers = event === "data" ? dataHandlers : event === "end" ? endHandlers : errorHandlers;
			const index = handlers.indexOf(listener as never);
			if (index >= 0) handlers.splice(index, 1);
		},
		resume() {
			for (const listener of [...dataHandlers]) listener(value);
			for (const listener of [...endHandlers]) listener();
		},
	};
}

interface Harness {
	readonly input: Readonly<Record<string, unknown>>;
	readonly events: string[];
	readonly launched: unknown[];
	readonly published: Uint8Array[];
	readonly written: Uint8Array[];
	readonly closeCalls: { value: number };
	readonly closeRuntime: (result?: unknown) => void;
}

function harness(overrides: Readonly<Record<string, unknown>> = {}): Harness {
	const events: string[] = [];
	const launched: unknown[] = [];
	const published: Uint8Array[] = [];
	const written: Uint8Array[] = [];
	const closeCalls = { value: 0 };
	let resolveClosed!: (value: unknown) => void;
	const closed = new Promise<unknown>((resolve) => {
		resolveClosed = resolve;
	});
	const monitor = Object.freeze({
		ready: Promise.resolve(Object.freeze({ ok: true as const, pid: 712 })),
		closed,
		close(): Promise<unknown> {
			closeCalls.value += 1;
			resolveClosed(Object.freeze({ ok: true as const }));
			return closed;
		},
	});
	const writable = {
		write(value: Uint8Array, callback: (result: unknown) => void): unknown {
			events.push("write");
			written.push(new Uint8Array(value));
			callback(Object.freeze({ status: "written" }));
			return Object.freeze({ status: "started" });
		},
		release(callback: (result: unknown) => void): unknown {
			callback(Object.freeze({ status: "released" }));
			return Object.freeze({ status: "started" });
		},
		end(callback: (result: unknown) => void): unknown {
			events.push("end");
			callback(Object.freeze({ status: "ended" }));
			return Object.freeze({ status: "started" });
		},
	};
	const launcher = {
		launch(request: unknown): Promise<unknown> {
			events.push("launch");
			launched.push(request);
			return Promise.resolve(Object.freeze({ status: "started", writable, monitor }));
		},
	};
	const publisher = {
		publish(value: Uint8Array): Promise<unknown> {
			events.push("publish");
			published.push(new Uint8Array(value));
			value.fill(0);
			return Promise.resolve(Object.freeze({ status: "published" }));
		},
	};
	const input = {
		stdinSource: source(frame(payload())),
		launcher,
		publisher,
		readyNonce: NONCE,
		timeouts: {
			frameReadTimeoutMs: 100,
			credentialWriteTimeoutMs: 100,
			launchTimeoutMs: 100,
			monitorTimeoutMs: 100,
			publishTimeoutMs: 100,
		},
		...overrides,
	};
	return { input, events, launched, published, written, closeCalls, closeRuntime: resolveClosed };
}

async function decodeWritten(value: Uint8Array) {
	const length = new DataView(value.buffer).getUint32(0, false);
	const body = value.slice(4);
	expect(length).toBe(body.byteLength);
	const decoded = decodeSandboxBootstrapPayload(body);
	if (!decoded.ok) throw new Error("forwarded PAB1 invalid");
	let grant = "";
	const consumed = await withBootstrapGrant(decoded.value.grant, async (bytes) => {
		grant = new TextDecoder().decode(bytes);
	});
	if (!consumed.ok) throw new Error("grant invalid");
	return { metadata: decoded.value.metadata, grant };
}

describe("sandbox FD3 bootstrap bridge", () => {
	it("forwards the canonical PAB1 before readiness and publishes only the canonical line", async () => {
		const h = harness();
		const result = await createSandboxFd3BootstrapBridge(h.input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(h.events).toEqual(["launch", "write", "end", "publish"]);
		expect(h.launched).toEqual([{ readyNonce: NONCE }]);
		expect(Object.isFrozen(h.launched[0])).toBe(true);
		expect(new TextDecoder().decode(h.published[0])).toBe(`PRIME_AGENT_READY ${NONCE} 712\n`);
		const forwarded = await decodeWritten(h.written[0]);
		expect(forwarded.grant).toBe("A".repeat(50));
		expect(forwarded.metadata).toMatchObject({
			hostId: "home-host",
			generation: "generation-1",
			sessionId: "session-1",
			relayUrl: "wss://relay.example.com/prime/v1",
		});
		expect(result.session.pid).toBe(712);
	});

	it("returns one shared close promise and maps the runtime lifetime", async () => {
		const h = harness();
		const result = await createSandboxFd3BootstrapBridge(h.input);
		if (!result.ok) throw new Error("bridge failed");
		const first = result.session.close();
		const second = result.session.close();
		expect(first).toBe(second);
		expect(await first).toEqual({ ok: true });
		expect(await result.session.lifetime).toEqual({ ok: true });
		expect(h.closeCalls.value).toBe(1);
	});

	it("waits for write callbacks before it observes readiness", async () => {
		const h = harness();
		let writeCallback: unknown = null;
		let endCallback: unknown = null;
		const writable = {
			write(_value: Uint8Array, callback: (result: unknown) => void) {
				writeCallback = callback;
				return { status: "started" };
			},
			release(callback: (result: unknown) => void) {
				callback({ status: "released" });
				return { status: "started" };
			},
			end(callback: (result: unknown) => void) {
				endCallback = callback;
				return { status: "started" };
			},
		};
		const originalLauncher = h.input.launcher as { launch: (raw: unknown) => Promise<unknown> };
		const launcher = {
			async launch(raw: unknown) {
				const started = (await originalLauncher.launch(raw)) as Readonly<Record<string, unknown>>;
				return Object.freeze({ ...started, writable });
			},
		};
		let settled = false;
		const running = createSandboxFd3BootstrapBridge({ ...h.input, launcher }).then((value) => {
			settled = true;
			return value;
		});
		for (let attempt = 0; attempt < 20 && writeCallback === null; attempt += 1) await Promise.resolve();
		expect(settled).toBe(false);
		expect(writeCallback).not.toBeNull();
		if (typeof writeCallback === "function") writeCallback({ status: "written" });
		for (let attempt = 0; attempt < 20 && endCallback === null; attempt += 1) await Promise.resolve();
		expect(endCallback).not.toBeNull();
		if (typeof endCallback === "function") endCallback({ status: "ended" });
		expect((await running).ok).toBe(true);
	});

	it("lets cleanup uncertainty dominate a credential failure", async () => {
		const h = harness();
		const baseLauncher = h.input.launcher as { launch: (raw: unknown) => Promise<unknown> };
		const launcher = {
			async launch(raw: unknown) {
				const started = (await baseLauncher.launch(raw)) as Readonly<Record<string, unknown>>;
				const writable = {
					write(_value: Uint8Array, callback: (result: unknown) => void) {
						callback({ status: "error" });
						return { status: "started" };
					},
					release() {
						return { status: "started" };
					},
					end() {
						return { status: "started" };
					},
				};
				const original = started.monitor as Readonly<Record<string, unknown>>;
				const monitor = Object.freeze({
					ready: original.ready,
					closed: original.closed,
					close: () =>
						Promise.resolve(Object.freeze({ ok: false, code: "CLEANUP_UNCONFIRMED", cleanupConfirmed: false })),
				});
				return Object.freeze({ status: "started", writable, monitor });
			},
		};
		const result = await createSandboxFd3BootstrapBridge({ ...h.input, launcher });
		expect(result).toEqual({ ok: false, error: { code: "CLEANUP_UNCERTAIN" } });
	});

	it("closes a runtime that returns malformed readiness", async () => {
		const h = harness();
		const base = h.input.launcher as { launch: (raw: unknown) => Promise<unknown> };
		const launcher = {
			async launch(raw: unknown) {
				const started = (await base.launch(raw)) as Readonly<Record<string, unknown>>;
				const original = started.monitor as { close: () => Promise<unknown>; closed: Promise<unknown> };
				const monitor = Object.freeze({
					ready: Promise.resolve(Object.freeze({ ok: true, pid: 0 })),
					closed: original.closed,
					close: () => original.close(),
				});
				return Object.freeze({ status: "started", writable: started.writable, monitor });
			},
		};
		const result = await createSandboxFd3BootstrapBridge({ ...h.input, launcher });
		expect(result).toEqual({ ok: false, error: { code: "READY_FAILED" } });
		expect(h.closeCalls.value).toBe(1);
	});

	it("closes the runtime when publishing readiness fails", async () => {
		const h = harness({ publisher: { publish: () => Promise.resolve({ status: "error" }) } });
		const result = await createSandboxFd3BootstrapBridge(h.input);
		expect(result).toEqual({ ok: false, error: { code: "PUBLISH_UNCERTAIN" } });
		expect(h.closeCalls.value).toBe(1);
	});

	it("rejects a non-native launch thenable without assimilating it", async () => {
		let thenCalled = false;
		const thenable: Record<string, unknown> = {};
		Object.defineProperty(thenable, `th${"en"}`, {
			enumerable: true,
			value: () => {
				thenCalled = true;
			},
		});
		const h = harness({ launcher: { launch: () => thenable } });
		const result = await createSandboxFd3BootstrapBridge(h.input);
		expect(result).toEqual({ ok: false, error: { code: "LAUNCH_FAILED" } });
		expect(thenCalled).toBe(false);
	});

	it("rejects hostile outer descriptors and aliases without throwing", async () => {
		const h = harness();
		const getter = { ...h.input } as Record<string, unknown>;
		Object.defineProperty(getter, "readyNonce", {
			enumerable: true,
			get() {
				throw new Error("no");
			},
		});
		expect(await createSandboxFd3BootstrapBridge(getter)).toEqual({ ok: false, error: { code: "INPUT_INVALID" } });
		expect(await createSandboxFd3BootstrapBridge(new Proxy(h.input, {}))).toEqual({
			ok: false,
			error: { code: "INPUT_INVALID" },
		});
		expect(await createSandboxFd3BootstrapBridge({ ...h.input, publisher: h.input.launcher })).toEqual({
			ok: false,
			error: { code: "INPUT_INVALID" },
		});
	});
});

describe("sandbox bootstrap reserved mode parser", () => {
	it("accepts only the two exact reserved modes", () => {
		expect(parseSandboxBootstrapMode(["--prime-agent-fd3-bootstrap", "--ready-nonce", NONCE])).toEqual({
			ok: true,
			mode: "wrapper",
			readyNonce: NONCE,
		});
		expect(parseSandboxBootstrapMode(["--prime-agent-runtime-fd3", "--ready-nonce", NONCE])).toEqual({
			ok: true,
			mode: "runtime",
			readyNonce: NONCE,
		});
		expect(SANDBOX_RUNTIME_BOOTSTRAP_FD).toBe(3);
	});

	it("rejects invalid argv", () => {
		const cases: readonly unknown[] = [
			[],
			["--prime-agent-fd3-bootstrap", "--ready-nonce", NONCE, "extra"],
			["--ready-nonce", NONCE, "--prime-agent-fd3-bootstrap"],
			["--prime-agent-fd3-bootstrap", "--ready-nonce", NONCE.toUpperCase()],
			["--prime-agent-runtime-fd3", "--ready-nonce", "0".repeat(31)],
		];
		for (const argv of cases) expect(parseSandboxBootstrapMode(argv)).toEqual({ ok: false });
	});

	it("rejects proxies and extra non-enumerable properties", () => {
		expect(parseSandboxBootstrapMode(new Proxy(["--prime-agent-fd3-bootstrap", "--ready-nonce", NONCE], {}))).toEqual(
			{ ok: false },
		);
		const argv = ["--prime-agent-fd3-bootstrap", "--ready-nonce", NONCE];
		Object.defineProperty(argv, "extra", { value: true });
		expect(parseSandboxBootstrapMode(argv)).toEqual({ ok: false });
	});
});
