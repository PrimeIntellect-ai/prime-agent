import { describe, expect, it } from "vitest";
import { startSandboxRelayListenerCore } from "../src/core/sandbox-relay-listener-core.js";

const PATH = "/sandbox-relay/a1b2c3d4e5f60718293a4b5c6d7e8f90";
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accepted) => {
		resolve = accepted;
	});
	return { promise, resolve };
}
function authFixture() {
	const grant = new Uint8Array(48);
	for (let index = 0; index < grant.length; index += 1) grant[index] = 0x21 + ((index * 7 + 13) % 0x5e);
	return { grant, grantText: new TextDecoder().decode(grant) };
}
function request(grant: string) {
	return {
		method: "GET",
		url: PATH,
		rawHeaders: ["Host", "localhost", "Upgrade", "websocket", "Connection", "Upgrade", "X-Prime-Grant", grant],
		headers: { host: "localhost", upgrade: "websocket", connection: "Upgrade", "x-prime-grant": grant },
	};
}

function harness(
	options: Readonly<{
		admission?: "gate" | "fail";
		setup?: "fail" | "malformed";
		upgrade?: "gate" | "malformed";
		synchronousUpgrade?: Readonly<{ request: unknown; head: unknown }>;
	}> = {},
) {
	const log: string[] = [];
	const serverClosed = deferred<Readonly<{ status: "closed" }>>();
	const socketClosed = deferred<Readonly<{ status: "closed" }>>();
	const wsClosed = deferred<Readonly<{ status: "closed" }>>();
	const admissionGate = deferred<Readonly<{ status: "admitted" }>>();
	const upgradeGate = deferred<void>();
	let onTcp: ((raw: unknown) => void) | null = null;
	let onUpgrade: ((request: unknown, head: unknown) => void) | null = null;
	let wsCloseCalls = 0;
	let socketCloseCalls = 0;
	let serverCloseCalls = 0;
	let subscriptionCloseCalls = 0;
	const ws = Object.freeze({
		handle: Object.freeze({ type: "ws-handle" }),
		closed: wsClosed.promise,
		resume: () => {
			log.push("resume");
			return Object.freeze({ status: "resumed" });
		},
		close: async () => {
			wsCloseCalls += 1;
			log.push("ws-close");
			wsClosed.resolve(Object.freeze({ status: "closed" }));
			socketClosed.resolve(Object.freeze({ status: "closed" }));
			return Object.freeze({ status: "closing" });
		},
	});
	const upgradeSubscription = Object.freeze({
		close: async () => {
			subscriptionCloseCalls += 1;
			log.push("upgrade-unsubscribe");
			return Object.freeze({ status: "closed" });
		},
	});
	const socket = Object.freeze({
		closed: socketClosed.promise,
		pause: () => {
			log.push("pause");
			return Object.freeze({ status: "paused" });
		},
		subscribeUpgrade: (callback: (request: unknown, head: unknown) => void) => {
			onUpgrade = callback;
			log.push("subscribe-upgrade");
			if (options.synchronousUpgrade) callback(options.synchronousUpgrade.request, options.synchronousUpgrade.head);
			return upgradeSubscription;
		},
		upgrade: async (_raw: unknown) => {
			log.push("upgrade-start");
			if (options.upgrade === "gate") await upgradeGate.promise;
			log.push("upgrade-finish");
			return options.upgrade === "malformed"
				? Object.freeze({ status: "upgraded", webSocket: ws, extra: true })
				: Object.freeze({ status: "upgraded", webSocket: ws });
		},
		reject: async (_raw: unknown) => {
			log.push("reject");
			socketClosed.resolve(Object.freeze({ status: "closed" }));
			return Object.freeze({ status: "rejected" });
		},
		close: async () => {
			socketCloseCalls += 1;
			log.push("socket-close");
			socketClosed.resolve(Object.freeze({ status: "closed" }));
			return Object.freeze({ status: "closing" });
		},
	});
	const server = Object.freeze({
		closed: serverClosed.promise,
		listen: async (raw: unknown) => {
			log.push("listen");
			onTcp = (raw as { onTcp: (value: unknown) => void }).onTcp;
			return Object.freeze({ status: "listening", host: "127.0.0.1", port: 34567 });
		},
		close: async () => {
			serverCloseCalls += 1;
			log.push("server-close");
			serverClosed.resolve(Object.freeze({ status: "closed" }));
			return Object.freeze({ status: "closing" });
		},
	});
	const handlerSubscription = Object.freeze({
		close: async () => {
			subscriptionCloseCalls += 1;
			log.push("handler-unsubscribe");
			return Object.freeze({ status: "closed" });
		},
	});
	const admit = async () => {
		log.push("admit");
		if (options.admission === "gate") return await admissionGate.promise;
		if (options.admission === "fail") return Object.freeze({ status: "error" });
		return Object.freeze({ status: "admitted" });
	};
	const setup = async (_raw: unknown) => {
		log.push("setup");
		if (options.setup === "fail") return Object.freeze({ status: "error", subscription: handlerSubscription });
		if (options.setup === "malformed")
			return Object.freeze({ status: "ready", subscription: handlerSubscription, extra: true });
		return Object.freeze({ status: "ready", subscription: handlerSubscription });
	};
	return {
		server,
		socket,
		log,
		admit,
		setup,
		admissionGate,
		upgradeGate,
		emitTcp: () => {
			if (!onTcp) throw new Error("not listening");
			onTcp(socket);
		},
		emitUpgrade: (rawRequest: unknown, head: unknown) => {
			if (!onUpgrade) throw new Error("not subscribed");
			onUpgrade(rawRequest, head);
		},
		counts: () => ({ wsCloseCalls, socketCloseCalls, serverCloseCalls, subscriptionCloseCalls }),
	};
}
function input(grant: unknown, h: ReturnType<typeof harness>, overrides: Record<string, unknown> = {}) {
	return Object.freeze({
		grant,
		path: PATH,
		server: h.server,
		admit: h.admit,
		setup: h.setup,
		timeouts: Object.freeze({ admissionMs: 100, upgradeMs: 100, setupMs: 100, closeMs: 100 }),
		...overrides,
	});
}

describe("sandbox relay listener ownership core", () => {
	it("disposes authentication and observes server closure when later factory validation fails", async () => {
		const auth = authFixture();
		const h = harness();
		expect(await startSandboxRelayListenerCore(input(auth.grant, h, { setup: 7 }))).toEqual({
			ok: false,
			code: "INPUT_INVALID",
			cleanupConfirmed: true,
		});
		expect([...auth.grant].every((value) => value === 0)).toBe(true);
		expect(h.counts().serverCloseCalls).toBe(1);
	});

	it("persists admission before upgrading and resumes only after handler setup", async () => {
		const auth = authFixture();
		const h = harness({ admission: "gate" });
		const started = await startSandboxRelayListenerCore(input(auth.grant, h));
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		expect(started.listener.status()).toMatchObject({
			phase: "listening",
			tcp: 0,
			pending: 0,
			upgraded: 0,
			admitted: 0,
		});
		h.emitTcp();
		expect(started.listener.status()).toMatchObject({ phase: "tcp", tcp: 1 });
		const rawRequest = request(auth.grantText);
		h.emitUpgrade(rawRequest, Buffer.alloc(0));
		expect(started.listener.status()).toMatchObject({ phase: "pending", tcp: 1, pending: 1 });
		expect(rawRequest.rawHeaders.at(-1)).toBe("");
		expect(Object.hasOwn(rawRequest.headers, "x-prime-grant")).toBe(false);
		expect(h.log).toContain("admit");
		expect(h.log).not.toContain("upgrade-start");
		h.admissionGate.resolve(Object.freeze({ status: "admitted" }));
		expect(await started.listener.connected).toEqual({ ok: true });
		expect(started.listener.status()).toMatchObject({
			phase: "admitted",
			tcp: 1,
			pending: 0,
			upgraded: 0,
			admitted: 1,
		});
		expect(h.log.indexOf("admit")).toBeLessThan(h.log.indexOf("upgrade-start"));
		expect(h.log.indexOf("upgrade-finish")).toBeLessThan(h.log.indexOf("setup"));
		expect(h.log.indexOf("setup")).toBeLessThan(h.log.indexOf("resume"));
		const first = started.listener.close();
		expect(started.listener.close()).toBe(first);
		expect(await first).toEqual({ ok: true });
		expect(started.listener.status()).toMatchObject({
			phase: "closed",
			tcp: 0,
			pending: 0,
			upgraded: 0,
			admitted: 0,
		});
		expect(h.counts()).toEqual({
			wsCloseCalls: 1,
			socketCloseCalls: 0,
			serverCloseCalls: 1,
			subscriptionCloseCalls: 2,
		});
	});

	it("scrubs credentials, erases a nonempty head, rejects it, and never admits", async () => {
		const auth = authFixture();
		const h = harness();
		const started = await startSandboxRelayListenerCore(input(auth.grant, h));
		if (!started.ok) throw new Error("start failed");
		h.emitTcp();
		const rawRequest = request(auth.grantText);
		const head = Buffer.from([7, 8, 9]);
		h.emitUpgrade(rawRequest, head);
		expect([...head]).toEqual([0, 0, 0]);
		expect(rawRequest.rawHeaders.at(-1)).toBe("");
		expect(Object.hasOwn(rawRequest.headers, "x-prime-grant")).toBe(false);
		expect(await started.listener.connected).toEqual({ ok: false, code: "HEAD_NONEMPTY" });
		expect(h.log).not.toContain("admit");
		expect(h.log).not.toContain("upgrade-start");
		expect((await started.listener.close()).ok).toBe(true);
	});

	it("scrubs a duplicate actual request before rejecting the second upgrade", async () => {
		const auth = authFixture();
		const h = harness({ admission: "gate" });
		const started = await startSandboxRelayListenerCore(input(auth.grant, h));
		if (!started.ok) throw new Error("start failed");
		h.emitTcp();
		h.emitUpgrade(request(auth.grantText), Buffer.alloc(0));
		const duplicate = request(auth.grantText);
		h.emitUpgrade(duplicate, Buffer.alloc(0));
		expect(duplicate.rawHeaders.at(-1)).toBe("");
		expect(Object.hasOwn(duplicate.headers, "x-prime-grant")).toBe(false);
		expect(await started.listener.connected).toEqual({ ok: false, code: "AUTH_FAILED" });
		expect((await started.listener.close()).ok).toBe(true);
	});

	it("does not upgrade when durable admission fails", async () => {
		const auth = authFixture();
		const h = harness({ admission: "fail" });
		const started = await startSandboxRelayListenerCore(input(auth.grant, h));
		if (!started.ok) throw new Error("start failed");
		h.emitTcp();
		h.emitUpgrade(request(auth.grantText), Buffer.alloc(0));
		expect(await started.listener.connected).toEqual({ ok: false, code: "ADMISSION_FAILED" });
		expect(h.log).not.toContain("upgrade-start");
		expect((await started.listener.close()).ok).toBe(true);
	});

	it("closes a WebSocket and returned subscription when handler setup rejects", async () => {
		const auth = authFixture();
		const h = harness({ setup: "fail" });
		const started = await startSandboxRelayListenerCore(input(auth.grant, h));
		if (!started.ok) throw new Error("start failed");
		h.emitTcp();
		h.emitUpgrade(request(auth.grantText), Buffer.alloc(0));
		expect(await started.listener.connected).toEqual({ ok: false, code: "SETUP_FAILED" });
		await started.listener.close();
		expect(h.counts().wsCloseCalls).toBe(1);
		expect(h.counts().subscriptionCloseCalls).toBe(2);
		expect(h.log).not.toContain("resume");
	});

	it("owns a synchronous upgrade callback and closes the subscription after setup", async () => {
		const auth = authFixture();
		const rawRequest = request(auth.grantText);
		const h = harness({ synchronousUpgrade: { request: rawRequest, head: Buffer.alloc(0) } });
		const started = await startSandboxRelayListenerCore(input(auth.grant, h));
		if (!started.ok) throw new Error("start failed");
		h.emitTcp();
		expect(await started.listener.connected).toEqual({ ok: true });
		expect(rawRequest.rawHeaders.at(-1)).toBe("");
		expect((await started.listener.close()).ok).toBe(true);
		expect(h.counts().subscriptionCloseCalls).toBe(2);
	});

	it("closes owners discovered inside malformed upgrade and setup results", async () => {
		for (const options of [{ upgrade: "malformed" as const }, { setup: "malformed" as const }]) {
			const auth = authFixture();
			const h = harness(options);
			const started = await startSandboxRelayListenerCore(input(auth.grant, h));
			if (!started.ok) throw new Error("start failed");
			h.emitTcp();
			h.emitUpgrade(request(auth.grantText), Buffer.alloc(0));
			expect((await started.listener.connected).ok).toBe(false);
			await started.listener.close();
			expect(h.counts().wsCloseCalls).toBe(1);
			if ("setup" in options) expect(h.counts().subscriptionCloseCalls).toBe(2);
		}
	});

	it("serializes close behind a pending admission without upgrading", async () => {
		const auth = authFixture();
		const h = harness({ admission: "gate" });
		const started = await startSandboxRelayListenerCore(input(auth.grant, h));
		if (!started.ok) throw new Error("start failed");
		h.emitTcp();
		h.emitUpgrade(request(auth.grantText), Buffer.alloc(0));
		const closing = started.listener.close();
		h.admissionGate.resolve(Object.freeze({ status: "admitted" }));
		expect(await closing).toEqual({ ok: true });
		expect(h.log).not.toContain("upgrade-start");
		expect(await started.listener.connected).toEqual({ ok: false, code: "CLOSED" });
	});

	it("closes a WebSocket that arrives after the upgrade timeout", async () => {
		const auth = authFixture();
		const h = harness({ upgrade: "gate" });
		const started = await startSandboxRelayListenerCore(
			input(auth.grant, h, {
				timeouts: Object.freeze({ admissionMs: 100, upgradeMs: 2, setupMs: 100, closeMs: 100 }),
			}),
		);
		if (!started.ok) throw new Error("start failed");
		h.emitTcp();
		h.emitUpgrade(request(auth.grantText), Buffer.alloc(0));
		expect(await started.listener.connected).toEqual({ ok: false, code: "UPGRADE_TIMEOUT" });
		h.upgradeGate.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await started.listener.close();
		expect(h.counts().wsCloseCalls).toBe(1);
	});

	it("drains a WebSocket close task that appears after close starts during upgrade", async () => {
		const auth = authFixture();
		const h = harness({ upgrade: "gate" });
		const started = await startSandboxRelayListenerCore(input(auth.grant, h));
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		h.emitTcp();
		h.emitUpgrade(request(auth.grantText), Buffer.alloc(0));
		for (let turn = 0; turn < 8 && !h.log.includes("upgrade-start"); turn += 1) await Promise.resolve();
		expect(h.log).toContain("upgrade-start");
		const closing = started.listener.close();
		h.upgradeGate.resolve();
		expect(await closing).toEqual({ ok: true });
		expect(h.counts().wsCloseCalls).toBe(1);
	});
});
