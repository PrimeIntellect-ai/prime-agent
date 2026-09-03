import { createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createNodeSandboxRelayServer } from "../src/core/sandbox-relay-listener-adapter.js";
import { startSandboxRelayListenerCore } from "../src/core/sandbox-relay-listener-core.js";

const PATH = "/sandbox-relay/a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TIMEOUTS = Object.freeze({ admissionMs: 500, upgradeMs: 500, setupMs: 500, closeMs: 500 });

function grantFixture(value: number) {
	const grant = new Uint8Array(48).fill(value);
	return { grant, text: new TextDecoder().decode(grant) };
}

function nodeServer() {
	const created = createNodeSandboxRelayServer(Object.freeze({ closeTimeoutMs: 100, maxPayloadBytes: 1024 * 1024 }));
	if (!created.ok) throw new Error("node server factory failed");
	return created.server;
}

function waitEvent(target: WebSocket, event: "open" | "close"): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${event} timeout`)), 1_000);
		target.once(event, () => {
			clearTimeout(timer);
			resolve();
		});
		target.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

describe("node sandbox relay listener adapter", () => {
	it("binds loopback, scrubs the real header slots, and resumes only after setup", async () => {
		const grant = grantFixture(0x41);
		const events: string[] = [];
		let serverHandle: WebSocket | null = null;
		let onMessage: ((data: WebSocket.RawData) => void) | null = null;
		const started = await startSandboxRelayListenerCore(
			Object.freeze({
				grant: grant.grant,
				path: PATH,
				server: nodeServer(),
				admit: async () => {
					events.push("admit");
					return Object.freeze({ status: "admitted" });
				},
				setup: async (raw: unknown) => {
					const handle = (raw as { webSocket?: unknown }).webSocket;
					if (!(handle instanceof WebSocket)) return Object.freeze({ status: "error" });
					serverHandle = handle;
					onMessage = () => events.push("message");
					handle.on("message", onMessage);
					events.push("setup");
					return Object.freeze({
						status: "ready",
						subscription: Object.freeze({
							close: async () => {
								if (onMessage) handle.off("message", onMessage);
								return Object.freeze({ status: "closed" });
							},
						}),
					});
				},
				timeouts: TIMEOUTS,
			}),
		);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		expect([...grant.grant].every((value) => value === 0)).toBe(true);
		expect(started.host).toBe("127.0.0.1");
		const client = new WebSocket(`ws://${started.host}:${started.port}${PATH}`, {
			headers: { "X-Prime-Grant": grant.text },
		});
		await waitEvent(client, "open");
		expect(await started.listener.connected).toEqual({ ok: true });
		expect(serverHandle).toBeInstanceOf(WebSocket);
		expect(events).toEqual(["admit", "setup"]);
		client.send("hello");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(events).toEqual(["admit", "setup", "message"]);
		const clientClosed = waitEvent(client, "close");
		expect(await started.listener.close()).toEqual({ ok: true });
		await clientClosed;
		expect(started.listener.status()).toMatchObject({ phase: "closed", tcp: 0, admitted: 0 });
	});

	it("passes the actual nonempty Node upgrade head for erasure and fail-closed rejection", async () => {
		const grant = grantFixture(0x42);
		let admissions = 0;
		const started = await startSandboxRelayListenerCore(
			Object.freeze({
				grant: grant.grant,
				path: PATH,
				server: nodeServer(),
				admit: async () => {
					admissions += 1;
					return Object.freeze({ status: "admitted" });
				},
				setup: async () => Object.freeze({ status: "error" }),
				timeouts: TIMEOUTS,
			}),
		);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const socket = createConnection({ host: started.host, port: started.port });
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const key = Buffer.from("0123456789abcdef").toString("base64");
		socket.write(
			[
				`GET ${PATH} HTTP/1.1`,
				`Host: ${started.host}:${started.port}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Key: ${key}`,
				"Sec-WebSocket-Version: 13",
				`X-Prime-Grant: ${grant.text}`,
				"",
				"X",
			].join("\r\n"),
		);
		expect(await started.listener.connected).toEqual({ ok: false, code: "HEAD_NONEMPTY" });
		expect(admissions).toBe(0);
		expect(await started.listener.close()).toEqual({ ok: true });
		socket.destroy();
	});

	it("delivers the bounded second TCP connection so the core fails closed", async () => {
		const grant = grantFixture(0x43);
		const started = await startSandboxRelayListenerCore(
			Object.freeze({
				grant: grant.grant,
				path: PATH,
				server: nodeServer(),
				admit: async () => Object.freeze({ status: "admitted" }),
				setup: async () => Object.freeze({ status: "error" }),
				timeouts: TIMEOUTS,
			}),
		);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const first = createConnection({ host: started.host, port: started.port });
		await new Promise<void>((resolve, reject) => {
			first.once("connect", resolve);
			first.once("error", reject);
		});
		const second = createConnection({ host: started.host, port: started.port });
		await new Promise<void>((resolve, reject) => {
			second.once("connect", resolve);
			second.once("error", reject);
		});
		expect(await started.listener.connected).toEqual({ ok: false, code: "DUPLICATE_CONNECTION" });
		expect(await started.listener.close()).toEqual({ ok: true });
		first.destroy();
		second.destroy();
	});

	it("rejects a malformed WebSocket handshake after durable admission without hanging upgrade", async () => {
		const grant = grantFixture(0x44);
		let admissions = 0;
		let setups = 0;
		const started = await startSandboxRelayListenerCore(
			Object.freeze({
				grant: grant.grant,
				path: PATH,
				server: nodeServer(),
				admit: async () => {
					admissions += 1;
					return Object.freeze({ status: "admitted" });
				},
				setup: async () => {
					setups += 1;
					return Object.freeze({ status: "error" });
				},
				timeouts: TIMEOUTS,
			}),
		);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const socket = createConnection({ host: started.host, port: started.port });
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		socket.write(
			[
				`GET ${PATH} HTTP/1.1`,
				`Host: ${started.host}:${started.port}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				"Sec-WebSocket-Key: invalid",
				"Sec-WebSocket-Version: 13",
				`X-Prime-Grant: ${grant.text}`,
				"",
				"",
			].join("\r\n"),
		);
		expect(await started.listener.connected).toEqual({ ok: false, code: "TRANSPORT_FAILED" });
		expect(admissions).toBe(1);
		expect(setups).toBe(0);
		expect(await started.listener.close()).toEqual({ ok: true });
		socket.destroy();
	});

	it("never transfers a second TCP owner after the first connection closes", async () => {
		const server = nodeServer() as {
			listen: (raw: unknown) => Promise<unknown>;
			close: () => Promise<unknown>;
			closed: Promise<unknown>;
		};
		let transferred = 0;
		let resolveOwner!: (owner: { closed: Promise<unknown> }) => void;
		const firstTransferred = new Promise<{ closed: Promise<unknown> }>((resolve) => {
			resolveOwner = resolve;
		});
		let resolveDrop!: () => void;
		const dropped = new Promise<void>((resolve) => {
			resolveDrop = resolve;
		});
		const listened = (await server.listen(
			Object.freeze({
				host: "127.0.0.1",
				onDrop: () => resolveDrop(),
				onTcp: (raw: unknown) => {
					transferred += 1;
					resolveOwner(raw as { closed: Promise<unknown> });
				},
			}),
		)) as { status: string; host: string; port: number };
		expect(listened).toMatchObject({ status: "listening", host: "127.0.0.1" });
		const first = createConnection({ host: listened.host, port: listened.port });
		await new Promise<void>((resolve, reject) => {
			first.once("connect", resolve);
			first.once("error", reject);
		});
		const firstOwner = await firstTransferred;
		first.destroy();
		await firstOwner.closed;
		const second = createConnection({ host: listened.host, port: listened.port });
		await new Promise<void>((resolve, reject) => {
			second.once("connect", resolve);
			second.once("error", reject);
		});
		await dropped;
		expect(transferred).toBe(1);
		second.destroy();
		expect(await server.close()).toMatchObject({ status: "closing" });
		expect(await server.closed).toEqual({ status: "closed" });
	});
});
