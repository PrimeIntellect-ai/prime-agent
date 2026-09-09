import { describe, expect, test } from "bun:test";
import type { SandboxTcpIo } from "../src/modes/daemon/sandbox/prime-sandbox-tcp.js";
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
		const accepted: SandboxTcpIo[] = [];
		let notify: (() => void) | undefined;
		const listener = await listenSandboxRuntimeTcp((io) => {
			accepted.push(io);
			notify?.();
		});
		if (!listener.ok) throw new Error("listen failed");
		async function nextAccepted(): Promise<SandboxTcpIo> {
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
		let resolveFirst: ((io: SandboxTcpIo) => void) | undefined;
		const accepted = new Promise<SandboxTcpIo>((resolve) => {
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
		let resolveServer: ((io: SandboxTcpIo) => void) | undefined;
		const accepted = new Promise<SandboxTcpIo>((resolve) => {
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

describe("TCP classified read", () => {
	test("idle timeout returns TIMEOUT and leaves socket open for later data", async () => {
		let resolveServer: ((io: SandboxTcpIo) => void) | undefined;
		const accepted = new Promise<SandboxTcpIo>((resolve) => {
			resolveServer = resolve;
		});
		const listener = await listenSandboxRuntimeTcp((io) => resolveServer?.(io));
		if (!listener.ok) throw new Error("listen failed");
		const client = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (!client.ok) throw new Error("connect failed");
		const server = await accepted;
		// Read with short timeout - no data sent, should get TIMEOUT
		const result = await client.value.readClassified(5, 50);
		expect(result).toEqual({ type: "TIMEOUT" });
		// Socket should still be open - send data and read again
		expect(await server.writeExact(bytes("hello"), 1000)).toBe(true);
		const result2 = await client.value.readClassified(5, 1000);
		expect(result2.type).toBe("DATA");
		if (result2.type === "DATA") {
			expect(new TextDecoder().decode(result2.data)).toBe("hello");
		}
		client.value.close();
		server.close();
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});

	test("timeout after partial bytes closes socket with IO_FAILURE", async () => {
		let resolveServer: ((io: SandboxTcpIo) => void) | undefined;
		const accepted = new Promise<SandboxTcpIo>((resolve) => {
			resolveServer = resolve;
		});
		const listener = await listenSandboxRuntimeTcp((io) => resolveServer?.(io));
		if (!listener.ok) throw new Error("listen failed");
		const client = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (!client.ok) throw new Error("connect failed");
		const server = await accepted;
		// Send partial data (3 out of 5 bytes)
		expect(await server.writeExact(bytes("abc"), 1000)).toBe(true);
		// Start readClassified for 5 bytes - will get partial then timeout
		const result = await client.value.readClassified(5, 50);
		expect(result.type).toBe("IO_FAILURE");
		// Socket should be closed now
		const result2 = await client.value.readClassified(1, 50);
		expect(result2.type).toBe("IO_FAILURE");
		client.value.close();
		server.close();
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});

	test("EOF returns EOF on idle read", async () => {
		let resolveServer: ((io: SandboxTcpIo) => void) | undefined;
		const accepted = new Promise<SandboxTcpIo>((resolve) => {
			resolveServer = resolve;
		});
		const listener = await listenSandboxRuntimeTcp((io) => resolveServer?.(io));
		if (!listener.ok) throw new Error("listen failed");
		const client = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (!client.ok) throw new Error("connect failed");
		const server = await accepted;
		// Close server side immediately
		server.close();
		// Client should see EOF
		const result = await client.value.readClassified(1, 500);
		expect(result.type).toBe("EOF");
		client.value.close();
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});

	test("exact bytes returned via classified read", async () => {
		let resolveServer: ((io: SandboxTcpIo) => void) | undefined;
		const accepted = new Promise<SandboxTcpIo>((resolve) => {
			resolveServer = resolve;
		});
		const listener = await listenSandboxRuntimeTcp((io) => resolveServer?.(io));
		if (!listener.ok) throw new Error("listen failed");
		const client = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (!client.ok) throw new Error("connect failed");
		const server = await accepted;
		expect(await server.writeExact(bytes("full data!"), 1000)).toBe(true);
		const result = await client.value.readClassified(10, 1000);
		expect(result.type).toBe("DATA");
		if (result.type === "DATA") {
			expect(new TextDecoder().decode(result.data)).toBe("full data!");
		}
		client.value.close();
		server.close();
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});

	test("readExact API unchanged after classified read additions", async () => {
		let resolveServer: ((io: SandboxTcpIo) => void) | undefined;
		const accepted = new Promise<SandboxTcpIo>((resolve) => {
			resolveServer = resolve;
		});
		const listener = await listenSandboxRuntimeTcp((io) => resolveServer?.(io));
		if (!listener.ok) throw new Error("listen failed");
		const client = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (!client.ok) throw new Error("connect failed");
		const server = await accepted;
		expect(await server.writeExact(bytes("oldapi"), 1000)).toBe(true);
		const result = await client.value.readExact(6, 1000);
		expect(result instanceof Uint8Array).toBe(true);
		if (result instanceof Uint8Array) {
			expect(new TextDecoder().decode(result)).toBe("oldapi");
		}
		client.value.close();
		server.close();
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});

	test("EOF with partial bytes returns IO_FAILURE and persists", async () => {
		let resolveServer: ((io: SandboxTcpIo) => void) | undefined;
		const accepted = new Promise<SandboxTcpIo>((resolve) => {
			resolveServer = resolve;
		});
		const listener = await listenSandboxRuntimeTcp((io) => resolveServer?.(io));
		if (!listener.ok) throw new Error("listen failed");
		const client = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (!client.ok) throw new Error("connect failed");
		const server = await accepted;
		// Send 3 bytes then close (FIN)
		expect(await server.writeExact(bytes("abc"), 1000)).toBe(true);
		server.close();
		// Wait for native close so data is settled
		await client.value.waitClosed();
		// Request 10 bytes but only 3 available: partial -> IO_FAILURE, persists
		const result = await client.value.readClassified(10, 50);
		expect(result.type).toBe("IO_FAILURE");
		const result2 = await client.value.readClassified(1, 50);
		expect(result2.type).toBe("IO_FAILURE");
		const result3 = await client.value.readClassified(5, 50);
		expect(result3.type).toBe("IO_FAILURE");
		client.value.close();
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});

	test("readClassified after clean EOF returns EOF deterministically", async () => {
		let resolveServer: ((io: SandboxTcpIo) => void) | undefined;
		const accepted = new Promise<SandboxTcpIo>((resolve) => {
			resolveServer = resolve;
		});
		const listener = await listenSandboxRuntimeTcp((io) => resolveServer?.(io));
		if (!listener.ok) throw new Error("listen failed");
		const client = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (!client.ok) throw new Error("connect failed");
		const server = await accepted;
		// Send data then close properly (FIN)
		expect(await server.writeExact(bytes("data"), 1000)).toBe(true);
		server.close(); // sends FIN
		// Read the data first
		const data = await client.value.readClassified(4, 1000);
		expect(data.type).toBe("DATA");
		// Then read again - should get EOF (clean EOF, no partial)
		const eof = await client.value.readClassified(1, 1000);
		expect(eof.type).toBe("EOF");
		// Subsequent reads also return EOF deterministically
		const eof2 = await client.value.readClassified(1, 50);
		expect(eof2.type).toBe("EOF");
		client.value.close();
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});

	test("drain buffered data after clean EOF, then EOF", async () => {
		let resolveServer: ((io: SandboxTcpIo) => void) | undefined;
		const accepted = new Promise<SandboxTcpIo>((resolve) => {
			resolveServer = resolve;
		});
		const listener = await listenSandboxRuntimeTcp((io) => resolveServer?.(io));
		if (!listener.ok) throw new Error("listen failed");
		const client = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (!client.ok) throw new Error("connect failed");
		const server = await accepted;
		// Send data then close (FIN) - data arrives before end/close
		expect(await server.writeExact(bytes("buffered data"), 1000)).toBe(true);
		server.close();
		// Wait for native close event (close event fires after end+destroy)
		await client.value.waitClosed();
		// After close, buffered data is still readable
		const data = await client.value.readClassified(13, 1000);
		expect(data.type).toBe("DATA");
		if (data.type === "DATA") {
			expect(new TextDecoder().decode(data.data)).toBe("buffered data");
		}
		// After draining, subsequent reads return EOF
		const eof = await client.value.readClassified(1, 50);
		expect(eof.type).toBe("EOF");
		client.value.close();
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});

	test("explicit close with no prior end returns IO_FAILURE, not EOF", async () => {
		let resolveServer: ((io: SandboxTcpIo) => void) | undefined;
		const accepted = new Promise<SandboxTcpIo>((resolve) => {
			resolveServer = resolve;
		});
		const listener = await listenSandboxRuntimeTcp((io) => resolveServer?.(io));
		if (!listener.ok) throw new Error("listen failed");
		const client = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (!client.ok) throw new Error("connect failed");
		const server = await accepted;
		// Close the client side directly (no prior end)
		client.value.close();
		await client.value.waitClosed();
		// After local close without end, reads return IO_FAILURE
		const result = await client.value.readClassified(1, 50);
		expect(result.type).toBe("IO_FAILURE");
		server.close();
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});

	test("hostile invalid lengths at EOF never throw and persist IO_FAILURE", async () => {
		for (const invalid of [-1, 0, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, -0]) {
			let srv: ((io: SandboxTcpIo) => void) | undefined;
			const accepted = new Promise<SandboxTcpIo>((resolve) => {
				srv = resolve;
			});
			const lst = await listenSandboxRuntimeTcp((io) => srv?.(io));
			if (!lst.ok) throw new Error("listen failed");
			const cl = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
			if (!cl.ok) throw new Error("connect failed");
			const sv = await accepted;
			expect(await sv.writeExact(bytes("x"), 1000)).toBe(true);
			sv.close();
			await cl.value.waitClosed();
			// Invalid arg returns IO_FAILURE (no throw)
			const r = await cl.value.readClassified(invalid, 50);
			expect(r.type).toBe("IO_FAILURE");
			// Subsequent valid call also returns IO_FAILURE (persistent)
			const r2 = await cl.value.readClassified(1, 50);
			expect(r2.type).toBe("IO_FAILURE");
			cl.value.close();
			await closeSandboxTcpListener(lst.value);
		}
	});

	test("hostile timeout values at EOF never throw and return IO_FAILURE", async () => {
		for (const invalid of [NaN, -1, 0, 1.5, 600001, Number.MAX_SAFE_INTEGER]) {
			let srv: ((io: SandboxTcpIo) => void) | undefined;
			const accepted = new Promise<SandboxTcpIo>((resolve) => {
				srv = resolve;
			});
			const lst = await listenSandboxRuntimeTcp((io) => srv?.(io));
			if (!lst.ok) throw new Error("listen failed");
			const cl = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
			if (!cl.ok) throw new Error("connect failed");
			const sv = await accepted;
			expect(await sv.writeExact(bytes("x"), 1000)).toBe(true);
			sv.close();
			await cl.value.waitClosed();
			const r = await cl.value.readClassified(1, invalid);
			expect(r.type).toBe("IO_FAILURE");
			cl.value.close();
			await closeSandboxTcpListener(lst.value);
		}
	});

	test("waitClosed waits for native socket close event", async () => {
		let resolveServer: ((io: SandboxTcpIo) => void) | undefined;
		const accepted = new Promise<SandboxTcpIo>((resolve) => {
			resolveServer = resolve;
		});
		const listener = await listenSandboxRuntimeTcp((io) => resolveServer?.(io));
		if (!listener.ok) throw new Error("listen failed");
		const client = await connectSandboxRuntimeTcp("127.0.0.1", 9443);
		if (!client.ok) throw new Error("connect failed");
		const server = await accepted;
		// Close server side, wait for native close event propagation
		server.close();
		await client.value.waitClosed();
		// After waitClosed resolves, the socket close event has fired.
		// Socket is now closed - readClassified returns EOF (clean EOF)
		const result = await client.value.readClassified(1, 50);
		expect(result.type).toBe("EOF");
		client.value.close();
		expect(await closeSandboxTcpListener(listener.value)).toEqual({ ok: true, value: true });
	});
});
