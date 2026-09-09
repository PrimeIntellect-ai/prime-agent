import { describe, expect, test } from "bun:test";
import type { SandboxHandshakeIo } from "../src/modes/daemon/sandbox/prime-sandbox-handshake.js";
import {
	closeSandboxTcpListener,
	connectSandboxRuntimeTcp,
	listenSandboxRuntimeTcp,
	SandboxTcpListener,
	waitSandboxTcpListenerClosed,
} from "../src/modes/daemon/sandbox/prime-sandbox-tcp.js";

function bytes(text: string): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(text);
}

describe("bounded sandbox TCP transport", () => {
	test("streams exact fragmented bytes and accepts a new connection after close", async () => {
		const accepted: SandboxHandshakeIo[] = [];
		let notify: (() => void) | undefined;
		const listener = await listenSandboxRuntimeTcp((io) => {
			accepted.push(io);
			notify?.();
		});
		if (!listener.ok) throw new Error("listen failed");
		async function nextAccepted(): Promise<SandboxHandshakeIo> {
			if (accepted.length === 0) {
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
				notify = undefined;
			}
			const io = accepted.shift();
			if (io === undefined) throw new Error("accept failed");
			return io;
		}
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const connected = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
			if (!connected.ok) throw new Error("connect failed");
			const serverIo = await nextAccepted();
			expect(await connected.value.writeExact(bytes("abc"), 1_000)).toBe(true);
			expect(await connected.value.writeExact(bytes("def"), 1_000)).toBe(true);
			expect(await serverIo.readExact(6, 1_000)).toEqual(bytes("abcdef"));
			expect(await serverIo.writeExact(bytes("reply"), 1_000)).toBe(true);
			expect(await connected.value.readExact(2, 1_000)).toEqual(bytes("re"));
			expect(await connected.value.readExact(3, 1_000)).toEqual(bytes("ply"));
			connected.value.close();
			serverIo.close();
		}
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});

	test("rejects a concurrent connection and closes timed-out reads", async () => {
		let resolveFirst: ((io: SandboxHandshakeIo) => void) | undefined;
		const accepted = new Promise<SandboxHandshakeIo>((resolve) => {
			resolveFirst = resolve;
		});
		const listener = await listenSandboxRuntimeTcp((io) => resolveFirst?.(io));
		if (!listener.ok) throw new Error("listen failed");
		const first = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (!first.ok) throw new Error("connect failed");
		const firstServer = await accepted;
		const second = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (second.ok) {
			expect(await second.value.readExact(1, 100)).toBeUndefined();
			second.value.close();
		}
		expect(await first.value.readExact(1, 10)).toBeUndefined();
		expect(await first.value.writeExact(bytes("x"), 100)).toBe(false);
		first.value.close();
		firstServer.close();
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});

	test("rejects invalid endpoints, duplicate listeners, and forged listener capabilities", async () => {
		expect(await connectSandboxRuntimeTcp("", 9443)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(await connectSandboxRuntimeTcp("127.0.0.1", 0)).toEqual({ ok: false, code: "INPUT_INVALID" });
		const aborted = new AbortController();
		aborted.abort();
		expect(await connectSandboxRuntimeTcp("127.0.0.1", 9443, aborted.signal)).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(await connectSandboxRuntimeTcp("127.0.0.1", 9443, new Proxy(aborted.signal, {}))).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(() => new SandboxTcpListener({})).toThrow();
		expect(await closeSandboxTcpListener(Object.freeze({}))).toEqual({ ok: false, code: "INPUT_INVALID" });
		const first = await listenSandboxRuntimeTcp(() => undefined);
		if (!first.ok) throw new Error("listen failed");
		expect(await listenSandboxRuntimeTcp(() => undefined)).toEqual({ ok: false, code: "LISTEN_FAILED" });
		const waiting = waitSandboxTcpListenerClosed(first.value);
		expect(await closeSandboxTcpListener(first.value)).toEqual({ ok: true, value: true });
		expect(await waiting).toEqual({ ok: true, value: true });
		expect(await closeSandboxTcpListener(first.value)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	test("rejects hostile write buffers without invoking proxy traps", async () => {
		let resolveServer: ((io: SandboxHandshakeIo) => void) | undefined;
		const accepted = new Promise<SandboxHandshakeIo>((resolve) => {
			resolveServer = resolve;
		});
		const listener = await listenSandboxRuntimeTcp((io) => resolveServer?.(io));
		if (!listener.ok) throw new Error("listen failed");
		const client = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (!client.ok) throw new Error("connect failed");
		const server = await accepted;
		const hostile = new Proxy(bytes("x"), {
			get() {
				throw new Error("trap invoked");
			},
		});
		expect(await server.writeExact(hostile, 100)).toBe(false);
		expect(await client.value.readExact(1, 100)).toBeUndefined();
		client.value.close();
		server.close();
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});
});
