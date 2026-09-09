import { describe, expect, mock, test } from "bun:test";
import type {
	HostedControllerDispatcher,
	RouteResult,
} from "../src/modes/daemon/sandbox/prime-sandbox-hosted-controller-adapter.js";
import {
	createPrimeSandboxHostedControllerAdapter,
	createPrimeSandboxHostedControllerDispatcher,
} from "../src/modes/daemon/sandbox/prime-sandbox-hosted-controller-adapter.js";
import { createControllerInvocationAuthorityManager } from "../src/modes/daemon/sandbox/prime-sandbox-v16-invocation.js";
import { decodeReply, encodeReply } from "../src/modes/daemon/sandbox/prime-sandbox-v16-reply-codec.js";
import { encodeRequest } from "../src/modes/daemon/sandbox/prime-sandbox-v16-request-codec.js";
import type {
	ApplicationBundle,
	ComposedReplyResult,
} from "../src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.js";

function identity() {
	return {
		activeSessionId: "home-active",
		sessionId: "home-session",
		rlmChildId: "home-child",
		depth: 1,
		sessionName: "home-name",
	};
}

function observeSummary(activeSessionId: string, sessionId: string, sessionName: string, isCurrent: boolean) {
	return {
		activeSessionId: activeSessionId,
		sessionId: sessionId,
		sessionName: sessionName,
		runtimeKind: "subagent",
		cwd: "/secret/workspace",
		status: "idle",
		isCurrent: isCurrent,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 2,
		queuedCount: 0,
		isSessionActive: true,
		rlmChildId: isCurrent ? "home-child" : "child",
		firstMessage: "authorized observation",
		latestMessage: {
			index: 1,
			role: "assistant",
			timestamp: 10,
			text: "ready",
			truncated: false,
			toolCalls: ["agent_message"],
		},
	};
}

function createFixture() {
	const owner = Object.freeze({ owner: "private-home-capability" });
	const signals: AbortSignal[] = [];
	const calls = {
		listAgents: 0,
		roster: 0,
		awaitPending: 0,
		assertName: 0,
		setName: 0,
		send: 0,
		observeList: 0,
		observeGet: 0,
		observeRecent: 0,
	};
	const received: { message: unknown; name: unknown; recent: unknown } = {
		message: undefined,
		name: undefined,
		recent: undefined,
	};
	const messageController: {
		listAgents: (signal: AbortSignal) => unknown;
		roster: (signal: AbortSignal) => unknown;
		awaitPendingChildPublication: (selector: string, signal: AbortSignal) => unknown;
		assertSessionNameAvailable: (input: unknown, signal: AbortSignal) => unknown;
		setSessionName: (name: string, signal: AbortSignal) => unknown;
		sendAgentMessage: (input: unknown, signal: AbortSignal) => unknown;
	} = {
		listAgents: (signal: AbortSignal) => {
			signals.push(signal);
			calls.listAgents += 1;
			return {
				current: {
					activeSessionId: "home-active",
					sessionId: "home-session",
					sessionName: "home-name",
					runtimeKind: "subagent",
				},
				agents: [
					{
						activeSessionId: "child-active",
						sessionId: "child-session",
						sessionName: "child",
						runtimeKind: "subagent",
						cwd: "/secret/workspace",
						sessionDir: "/secret/session-dir",
						provider: "secret-provider",
						isStreaming: false,
						unfinishedActionCount: 0,
						rlmChildId: "child",
						rlmDepth: 2,
						status: "idle",
					},
				],
			};
		},
		roster: (signal: AbortSignal) => {
			signals.push(signal);
			calls.roster += 1;
			return {
				current: { name: "home-name", id: "home-session", depth: 1 },
				entries: [{ relationship: "child", name: "child", id: "child-session", depth: 2, status: "idle" }],
			};
		},
		awaitPendingChildPublication: (selector: string, signal: AbortSignal) => {
			signals.push(signal);
			calls.awaitPending += 1;
			return selector === "child" ? "child-session" : undefined;
		},
		assertSessionNameAvailable: (input: unknown, signal: AbortSignal) => {
			signals.push(signal);
			calls.assertName += 1;
			received.name = input;
		},
		setSessionName: (name: string, signal: AbortSignal) => {
			signals.push(signal);
			calls.setName += 1;
			received.name = name;
		},
		sendAgentMessage: (input: unknown, signal: AbortSignal) => {
			signals.push(signal);
			calls.send += 1;
			received.message = input;
			return {
				id: "agentmsg_1",
				source: "agent_message",
				target: {
					activeSessionId: "child-active",
					sessionId: "child-session",
					sessionName: "child",
					runtimeKind: "subagent",
				},
				from: {
					activeSessionId: "home-active",
					sessionId: "home-session",
					sessionName: "home-name",
					runtimeKind: "subagent",
				},
				fromRelationship: "parent",
				message: "hello",
				deliveryStatus: "delivered",
				deliveredAt: "2026-01-01T00:00:00.000Z",
			};
		},
	};
	const observeController: {
		listAgents: (signal: AbortSignal) => unknown;
		getAgent: (target: string, signal: AbortSignal) => unknown;
		recentMessages: (input: unknown, signal: AbortSignal) => unknown;
	} = {
		listAgents: (signal: AbortSignal) => {
			signals.push(signal);
			calls.observeList += 1;
			return {
				current: observeSummary("home-active", "home-session", "home-name", true),
				agents: [observeSummary("child-active", "child-session", "child", false)],
			};
		},
		getAgent: (target: string, signal: AbortSignal) => {
			signals.push(signal);
			calls.observeGet += 1;
			return { agent: observeSummary("child-active", "child-session", target, false) };
		},
		recentMessages: (input: unknown, signal: AbortSignal) => {
			signals.push(signal);
			calls.observeRecent += 1;
			received.recent = input;
			return {
				agent: observeSummary("child-active", "child-session", "child", false),
				messages: [
					{ index: 0, role: "user", text: "task", truncated: false },
					{ index: 1, role: "assistant", text: "ready", truncated: false },
				],
				limit: 2,
				maxChars: 200,
				truncated: false,
			};
		},
	};
	const factoryInput = {
		sessionOwner: owner,
		authorizeIdentity: (candidate: object) =>
			candidate === owner
				? { identity: identity(), messageController: messageController, observeController: observeController }
				: undefined,
	};
	return { owner, signals, calls, received, messageController, observeController, factoryInput };
}

function activeSignal(): AbortSignal {
	return new AbortController().signal;
}

describe("prime sandbox hosted controller adapter", () => {
	test("maps all nine methods once and preserves semantic inputs", async () => {
		const fixture = createFixture();
		const created = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const signal = activeSignal();

		const results = [];
		results.push(await created.adapter.invoke("list_agents", {}, signal));
		results.push(await created.adapter.invoke("roster", {}, signal));
		results.push(await created.adapter.invoke("await_pending", { selector: "child" }, signal));
		results.push(
			await created.adapter.invoke(
				"assert_name",
				{ name: "next", depth: 2, parentSessionId: "home-session", ignoreSessionId: null },
				signal,
			),
		);
		results.push(await created.adapter.invoke("set_name", { name: "next" }, signal));
		results.push(
			await created.adapter.invoke(
				"send_message",
				{ target: "child", message: "hello", receiverRole: "child" },
				signal,
			),
		);
		results.push(await created.adapter.invoke("observe_list", {}, signal));
		results.push(await created.adapter.invoke("observe_get", { target: "child" }, signal));
		results.push(
			await created.adapter.invoke("observe_recent", { target: "child", limit: 2, maxChars: 200 }, signal),
		);

		expect(fixture.calls).toEqual({
			listAgents: 1,
			roster: 1,
			awaitPending: 1,
			assertName: 1,
			setName: 1,
			send: 1,
			observeList: 1,
			observeGet: 1,
			observeRecent: 1,
		});
		expect(fixture.signals).toHaveLength(9);
		expect(fixture.signals.every((receivedSignal) => receivedSignal === signal)).toBe(true);
		expect(results[2]).toBe("child-session");
		expect(results[3]).toEqual({});
		expect(results[4]).toEqual({});
		expect(results[5]).toMatchObject({ source: "agent_message", message: "hello" });
		expect(fixture.received.message).toEqual({ target: "child", message: "hello", receiverRole: "child" });
		expect(fixture.received.recent).toEqual({ target: "child", limit: 2, maxChars: 200 });
		expect(Object.isFrozen(results[0])).toBe(true);
		const serialized = JSON.stringify(results);
		expect(serialized.includes("/secret/")).toBe(false);
		expect(serialized.includes("secret-provider")).toBe(false);
	});

	test("rejects hostile factory inputs without reading accessors", () => {
		let getterCalls = 0;
		const hostile = {};
		Object.defineProperty(hostile, "sessionOwner", {
			enumerable: true,
			get: () => {
				getterCalls += 1;
				return {};
			},
		});
		expect(createPrimeSandboxHostedControllerAdapter(hostile)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(getterCalls).toBe(0);

		const fixture = createFixture();
		const wrong = {
			sessionOwner: {},
			authorizeIdentity: fixture.factoryInput.authorizeIdentity,
		};
		expect(createPrimeSandboxHostedControllerAdapter(wrong)).toEqual({ ok: false, code: "WRONG_OWNER" });
		const other = createFixture();
		const mixed = {
			sessionOwner: fixture.owner,
			authorizeIdentity: other.factoryInput.authorizeIdentity,
		};
		expect(createPrimeSandboxHostedControllerAdapter(mixed)).toEqual({ ok: false, code: "WRONG_OWNER" });
		expect(fixture.calls.listAgents).toBe(0);
		expect(other.calls.listAgents).toBe(0);
	});

	test("revalidates exact bodies and maps hostile controller output", async () => {
		const fixture = createFixture();
		const created = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const symbolBody = { target: "child" };
		Object.defineProperty(symbolBody, Symbol("hidden"), { value: true });
		expect(await created.adapter.invoke("observe_get", symbolBody, activeSignal())).toEqual({
			error: "INPUT_INVALID",
		});
		expect(await created.adapter.invoke("observe_get", { target: "child", extra: true }, activeSignal())).toEqual({
			error: "INPUT_INVALID",
		});
		expect(fixture.calls.observeGet).toBe(0);

		const cycle = {};
		Object.defineProperty(cycle, "agent", { value: cycle, enumerable: true });
		fixture.observeController.getAgent = () => cycle;
		const hostileCreated = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(hostileCreated.ok).toBe(true);
		if (!hostileCreated.ok) return;
		expect(await hostileCreated.adapter.invoke("observe_get", { target: "child" }, activeSignal())).toEqual({
			error: "CONTROLLER_FAILURE",
		});
	});

	test("rebuilds aliases and blocks accessor, proxy, and credential output", async () => {
		const fixture = createFixture();
		const shared = {
			activeSessionId: "child-active",
			sessionId: "child-session",
			sessionName: "child",
			cwd: "/secret/workspace",
			isStreaming: false,
			unfinishedActionCount: 0,
		};
		fixture.messageController.listAgents = () => ({
			current: { activeSessionId: "home-active", sessionId: "home-session" },
			agents: [shared, shared],
		});
		const created = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const rebuilt = await created.adapter.invoke("list_agents", {}, activeSignal());
		if (typeof rebuilt === "object" && rebuilt !== null) {
			const agents = Reflect.get(rebuilt, "agents");
			expect(Array.isArray(agents)).toBe(true);
			if (Array.isArray(agents)) {
				expect(Object.is(agents[0], agents[1])).toBe(false);
				expect(Object.isFrozen(agents[0])).toBe(true);
			}
		}

		let thenCalls = 0;
		const plainOutput = {
			current: { activeSessionId: "home-active", sessionId: "home-session" },
			agents: [shared],
		};
		// biome-ignore lint/suspicious/noThenProperty: this is the hostile accessor under test.
		Object.defineProperty(plainOutput, "then", {
			get: () => {
				thenCalls += 1;
				return undefined;
			},
		});
		fixture.messageController.listAgents = () => plainOutput;
		const thenCreated = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(thenCreated.ok).toBe(true);
		if (!thenCreated.ok) return;
		const thenResult = await thenCreated.adapter.invoke("list_agents", {}, activeSignal());
		expect(thenCalls).toBe(0);
		expect(thenResult).toMatchObject({ current: { sessionId: "home-session" } });

		let accessorCalls = 0;
		const hostileAgent = {};
		Object.defineProperty(hostileAgent, "activeSessionId", {
			enumerable: true,
			get: () => {
				accessorCalls += 1;
				return "credential-secret";
			},
		});
		fixture.messageController.listAgents = () => ({
			current: { activeSessionId: "home-active", sessionId: "home-session" },
			agents: [hostileAgent],
		});
		const accessorCreated = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(accessorCreated.ok).toBe(true);
		if (!accessorCreated.ok) return;
		const blockedAccessor = await accessorCreated.adapter.invoke("list_agents", {}, activeSignal());
		expect(blockedAccessor).toEqual({ error: "CONTROLLER_FAILURE" });
		expect(accessorCalls).toBe(0);
		expect(JSON.stringify(blockedAccessor).includes("credential-secret")).toBe(false);

		fixture.messageController.listAgents = () => new Proxy({}, {});
		const proxyCreated = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(proxyCreated.ok).toBe(true);
		if (!proxyCreated.ok) return;
		expect(await proxyCreated.adapter.invoke("list_agents", {}, activeSignal())).toEqual({
			error: "CONTROLLER_FAILURE",
		});
	});

	test("handles abort before and during settlement", async () => {
		const fixture = createFixture();
		let settle: ((value: unknown) => void) | undefined;
		const pending = new Promise<unknown>((resolve) => {
			settle = resolve;
		});
		fixture.observeController.getAgent = () => pending;
		const created = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const before = new AbortController();
		before.abort();
		expect(await created.adapter.invoke("observe_get", { target: "child" }, before.signal)).toEqual({
			error: "CONTROLLER_FAILURE",
		});
		expect(fixture.calls.observeGet).toBe(0);

		const during = new AbortController();
		const operation = created.adapter.invoke("observe_get", { target: "child" }, during.signal);
		during.abort();
		if (settle !== undefined) settle({ agent: observeSummary("child-active", "child-session", "child", false) });
		expect(await operation).toEqual({ error: "CONTROLLER_FAILURE" });
	});

	test("maps rejection and dynamic errors without creating an outage", async () => {
		const fixture = createFixture();
		let attempts = 0;
		fixture.observeController.getAgent = (target: string) => {
			attempts += 1;
			if (attempts === 1) return Promise.reject(new Error("credential=secret"));
			return { agent: observeSummary("child-active", "child-session", target, false) };
		};
		const created = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(await created.adapter.invoke("observe_get", { target: "child" }, activeSignal())).toEqual({
			error: "CONTROLLER_FAILURE",
		});
		expect(await created.adapter.invoke("observe_get", { target: "child" }, activeSignal())).toMatchObject({
			agent: { activeSessionId: "child-active", sessionId: "child-session", sessionName: "child" },
		});
		expect(attempts).toBe(2);
		fixture.observeController.getAgent = () => JSON.parse("{");
		const throwingCreated = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(throwingCreated.ok).toBe(true);
		if (!throwingCreated.ok) return;
		expect(await throwingCreated.adapter.invoke("observe_get", { target: "child" }, activeSignal())).toEqual({
			error: "CONTROLLER_FAILURE",
		});
		fixture.observeController.getAgent = (target: string) => ({
			agent: observeSummary("child-active", "child-session", target, false),
		});
		const recoveredCreated = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(recoveredCreated.ok).toBe(true);
		if (!recoveredCreated.ok) return;
		expect(await recoveredCreated.adapter.invoke("observe_get", { target: "child" }, activeSignal())).toMatchObject({
			agent: { sessionName: "child" },
		});
	});

	test("maps identity and target mismatch to wrong owner", async () => {
		const fixture = createFixture();
		fixture.messageController.listAgents = () => ({
			current: { activeSessionId: "other-active", sessionId: "other-session" },
			agents: [],
		});
		fixture.messageController.sendAgentMessage = () => ({
			id: "agentmsg_2",
			source: "agent_message",
			target: { activeSessionId: "other", sessionId: "other" },
			message: "hello",
			deliveryStatus: "queued",
			queuedAt: "2026-01-01T00:00:00.000Z",
		});
		const created = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(await created.adapter.invoke("list_agents", {}, activeSignal())).toEqual({ error: "WRONG_OWNER" });
		expect(
			await created.adapter.invoke(
				"send_message",
				{ target: "child", message: "hello", receiverRole: "child" },
				activeSignal(),
			),
		).toEqual({ error: "WRONG_OWNER" });
	});

	test("reports unavailable optional Home methods without public lifecycle authority", async () => {
		const fixture = createFixture();
		const factoryInput = {
			sessionOwner: fixture.owner,
			authorizeIdentity: (candidate: object) =>
				candidate === fixture.owner
					? {
							identity: identity(),
							messageController: {
								listAgents: fixture.messageController.listAgents,
								sendAgentMessage: fixture.messageController.sendAgentMessage,
							},
							observeController: fixture.observeController,
						}
					: undefined,
		};
		const created = createPrimeSandboxHostedControllerAdapter(factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(await created.adapter.invoke("roster", {}, activeSignal())).toEqual({ error: "METHOD_UNAVAILABLE" });
		expect(await created.adapter.invoke("await_pending", { selector: "child" }, activeSignal())).toEqual({
			error: "METHOD_UNAVAILABLE",
		});
		expect(
			await created.adapter.invoke(
				"assert_name",
				{ name: "next", depth: 2, parentSessionId: "home-session", ignoreSessionId: null },
				activeSignal(),
			),
		).toEqual({ error: "METHOD_UNAVAILABLE" });
		expect(await created.adapter.invoke("set_name", { name: "next" }, activeSignal())).toEqual({
			error: "METHOD_UNAVAILABLE",
		});
		expect(Reflect.get(created.adapter, "close")).toBeUndefined();
	});

	test("canonicalizes local-only ownership and input errors on the V16 wire", async () => {
		const fixture = createFixture();
		fixture.messageController.listAgents = () => ({
			current: { activeSessionId: "other-active", sessionId: "other-session" },
			agents: [],
		});
		const created = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const authority = createControllerInvocationAuthorityManager();
		const wrongSession = authority.createSession(created.adapter, identity());
		expect(wrongSession.ok).toBe(true);
		if (!wrongSession.ok) return;
		const wrongCall = wrongSession.session.invoke("list_agents", {});
		expect(wrongCall.ok).toBe(true);
		if (!wrongCall.ok) return;
		expect(wrongSession.session.pollDispatch().ok).toBe(true);
		for (let index: number = 0; index < 8; index++) await Promise.resolve();
		const wrongReply = wrongSession.session.pollReply(wrongCall.callClaim);
		expect(wrongReply.ok).toBe(true);
		if (wrongReply.ok) expect(wrongReply.reply).toEqual({ error: "CONTROLLER_FAILURE" });
		await wrongSession.session.close();

		const inputIdentity = {
			activeSessionId: "input-active",
			sessionId: "input-session",
			rlmChildId: "input-child",
			depth: 1,
			sessionName: "input-name",
		};
		const inputAdapter = {
			invoke: async () => ({ error: "INPUT_INVALID" }),
		};
		const inputSession = authority.createSession(inputAdapter, inputIdentity);
		expect(inputSession.ok).toBe(true);
		if (!inputSession.ok) return;
		const inputCall = inputSession.session.invoke("list_agents", {});
		expect(inputCall.ok).toBe(true);
		if (!inputCall.ok) return;
		expect(inputSession.session.pollDispatch().ok).toBe(true);
		for (let index: number = 0; index < 8; index++) await Promise.resolve();
		const inputReply = inputSession.session.pollReply(inputCall.callClaim);
		expect(inputReply.ok).toBe(true);
		if (inputReply.ok) expect(inputReply.reply).toEqual({ error: "CONTROLLER_FAILURE" });
		await inputSession.session.close();
		await authority.cleanup();
	});

	test("round trips through V16 invocation with the exact hosted discriminator", async () => {
		const fixture = createFixture();
		const created = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const authority = createControllerInvocationAuthorityManager();
		const sessionResult = authority.createSession(created.adapter, identity());
		expect(sessionResult.ok).toBe(true);
		if (!sessionResult.ok) return;
		const invoked = sessionResult.session.invoke("send_message", {
			target: "child",
			message: "hello",
			receiverRole: "child",
		});
		expect(invoked.ok).toBe(true);
		if (!invoked.ok) return;
		const dispatched = sessionResult.session.pollDispatch();
		expect(dispatched.ok).toBe(true);
		for (let index: number = 0; index < 8; index++) await Promise.resolve();
		const reply = sessionResult.session.pollReply(invoked.callClaim);
		expect(reply.ok).toBe(true);
		if (reply.ok) {
			expect(reply.reply).toMatchObject({ source: "agent_message", message: "hello" });
		}
		expect(dispatched.ok ? dispatched.dispatch.method : "").toBe("send_message");
		const directBody = await created.adapter.invoke(
			"send_message",
			{ target: "child", message: "hello", receiverRole: "child" },
			activeSignal(),
		);
		const encoded = encodeReply("send_message", directBody, identity());
		expect(encoded.ok).toBe(true);
		if (encoded.ok) {
			const decoded = decodeReply(encoded.bytes, "send_message", identity());
			expect(decoded.ok).toBe(true);
			if (decoded.ok) expect(decoded.reply.execution).toEqual({ type: "prime-sandbox" });
		}
		await sessionResult.session.close();
		await authority.cleanup();
	});

	test("zeroes the owned reply-codec byte buffer after sanitizing", async () => {
		let ownedBytes: Uint8Array | undefined;
		const originalEncodeReply = encodeReply;
		const originalDecodeReply = decodeReply;
		mock.module("../src/modes/daemon/sandbox/prime-sandbox-v16-reply-codec.js", () => ({
			encodeReply: (method: unknown, raw: unknown, wireIdentity: unknown) => {
				const encoded = originalEncodeReply(method, raw, wireIdentity);
				if (encoded.ok) ownedBytes = encoded.bytes;
				return encoded;
			},
			decodeReply: originalDecodeReply,
		}));
		const fixture = createFixture();
		const created = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(await created.adapter.invoke("set_name", { name: "next" }, activeSignal())).toEqual({});
		expect(ownedBytes).toBeDefined();
		if (ownedBytes !== undefined) {
			expect(ownedBytes.every((value: number) => value === 0)).toBe(true);
		}
	});
});
describe("prime sandbox hosted controller dispatcher", () => {
	function deferredPromise<T = unknown>(): { promise: Promise<T>; resolve: (value: T) => void } {
		let resolve: (value: T) => void = () => {};
		const promise = new Promise<T>((res) => {
			resolve = res;
		});
		return { promise, resolve };
	}

	async function microtaskDrain(): Promise<void> {
		for (let index: number = 0; index < 8; index++) await Promise.resolve();
	}

	function isUint8Array(value: unknown): value is Uint8Array {
		return value !== null && typeof value === "object" && value.constructor === Uint8Array;
	}

	const signalActive: AbortSignal = new AbortController().signal;

	const signalAborted: AbortSignal = (() => {
		const ac = new AbortController();
		ac.abort();
		return ac.signal;
	})();

	const bytesMalformed: Uint8Array = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);

	const resultSent: ComposedReplyResult = { code: "SENT" };

	function freshSendMessageBytes(): Uint8Array {
		const encResult = encodeRequest({
			method: "send_message",
			body: { target: "child", message: "hello", receiverRole: "child" },
		});
		expect(encResult.ok).toBe(true);
		if (!encResult.ok) return new Uint8Array(0);
		return encResult.bytes;
	}

	function freshObserveListBytes(): Uint8Array {
		const encResult = encodeRequest({ method: "observe_list", body: {} });
		expect(encResult.ok).toBe(true);
		if (!encResult.ok) return new Uint8Array(0);
		return encResult.bytes;
	}

	const wireIdentity = Object.freeze({
		activeSessionId: "home-active",
		sessionId: "home-session",
		rlmChildId: "home-child",
		depth: 1,
		sessionName: "home-name",
	});

	// ====== Scope Tests N1-N8 ======

	test("N1: valid V16 send_message on Runtime stream 2 returns HANDLED, payload zeroed, reply called with nonzero encoded bytes, cell retained until reply settle", async () => {
		const fixture = createFixture();
		// 63 never-settling controller promises for filler cells
		const neverDefers: Array<{ promise: Promise<unknown>; resolve: (value: unknown) => void }> = [];
		for (let i: number = 0; i < 63; i++) {
			neverDefers.push(deferredPromise());
		}
		// 64th call uses original fixture's sendAgentMessage (returns sync valid output)
		const originalSend: (input: unknown, signal: AbortSignal) => unknown = fixture.messageController.sendAgentMessage;
		let callIdx: number = 0;
		fixture.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			const idx: number = callIdx;
			callIdx += 1;
			if (idx < 63) return neverDefers[idx].promise;
			return originalSend(_input, _signal);
		};

		const replyDefer: { promise: Promise<ComposedReplyResult>; resolve: (value: ComposedReplyResult) => void } =
			deferredPromise<ComposedReplyResult>();
		let replyCount: number = 0;
		let replyPayload: unknown;
		const replyCapture = async (payloadRaw: unknown): Promise<ComposedReplyResult> => {
			replyCount += 1;
			replyPayload = payloadRaw;
			return await replyDefer.promise;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		// Fill 63 cells
		for (let i: number = 0; i < 63; i++) {
			const b: ApplicationBundle = {
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			};
			expect(dispatcher.route(b)).toBe("HANDLED");
		}

		// 64th: N1 target cell
		const originalPayload: Uint8Array = freshSendMessageBytes();
		const payloadBeforeRoute: Uint8Array = new Uint8Array(originalPayload);
		const bTarget: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: payloadBeforeRoute,
			signal: signalActive,
			reply: replyCapture,
		};
		expect(dispatcher.route(bTarget)).toBe("HANDLED");

		for (let i: number = 0; i < payloadBeforeRoute.length; i++) {
			expect(payloadBeforeRoute[i]).toBe(0);
		}

		await microtaskDrain();

		expect(replyCount).toBe(1);
		expect(isUint8Array(replyPayload)).toBe(true);
		if (isUint8Array(replyPayload)) {
			expect(replyPayload.length).toBeGreaterThan(0);
			const decodeResult = decodeReply(replyPayload, "send_message", wireIdentity);
			expect(decodeResult.ok).toBe(true);
			if (decodeResult.ok) {
				expect(decodeResult.reply.method).toBe("send_message");
				expect(decodeResult.reply.identity).toEqual(wireIdentity);
				expect(decodeResult.reply.execution).toEqual({ type: "prime-sandbox" });
				expect(decodeResult.reply.body).toMatchObject({ source: "agent_message" });
			}
		}

		// Cell still held by replyPromise
		const bHeld: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(bHeld)).toBe("NO_CAPACITY");

		// Resolve reply -> cell freed
		replyDefer.resolve(resultSent);
		await microtaskDrain();

		const bFreed: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(bFreed)).toBe("HANDLED");
	});
	test("N2: valid V16 observe_list on Runtime stream 3 returns HANDLED, payload zeroed, reply called with nonzero encoded bytes, cell retained until reply settle", async () => {
		const fixture = createFixture();
		// 63 never-settling stream-2 filler cells via sendAgentMessage
		const neverDefers: Array<{ promise: Promise<unknown>; resolve: (value: unknown) => void }> = [];
		for (let i: number = 0; i < 63; i++) {
			neverDefers.push(deferredPromise());
		}
		let callIdx: number = 0;
		fixture.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			const idx: number = callIdx;
			callIdx += 1;
			return neverDefers[idx].promise;
		};

		const replyDefer: { promise: Promise<ComposedReplyResult>; resolve: (value: ComposedReplyResult) => void } =
			deferredPromise<ComposedReplyResult>();
		let replyCount: number = 0;
		let replyPayload: unknown;
		const replyCapture = async (payloadRaw: unknown): Promise<ComposedReplyResult> => {
			replyCount += 1;
			replyPayload = payloadRaw;
			return await replyDefer.promise;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		// Fill 63 cells with stream-2 message bundles
		for (let i: number = 0; i < 63; i++) {
			const b: ApplicationBundle = {
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			};
			expect(dispatcher.route(b)).toBe("HANDLED");
		}

		// 64th: stream-3 observe_list target cell
		const payloadBeforeRoute: Uint8Array = freshObserveListBytes();
		const bTarget: ApplicationBundle = {
			origin: "Runtime",
			stream: 3,
			payload: payloadBeforeRoute,
			signal: signalActive,
			reply: replyCapture,
		};
		expect(dispatcher.route(bTarget)).toBe("HANDLED");

		for (let i: number = 0; i < payloadBeforeRoute.length; i++) {
			expect(payloadBeforeRoute[i]).toBe(0);
		}

		await microtaskDrain();

		expect(replyCount).toBe(1);
		expect(isUint8Array(replyPayload)).toBe(true);
		if (isUint8Array(replyPayload)) {
			expect(replyPayload.length).toBeGreaterThan(0);
			const decodeResult = decodeReply(replyPayload, "observe_list", wireIdentity);
			expect(decodeResult.ok).toBe(true);
			if (decodeResult.ok) {
				expect(decodeResult.reply.method).toBe("observe_list");
				expect(decodeResult.reply.identity).toEqual(wireIdentity);
				expect(decodeResult.reply.execution).toEqual({ type: "prime-sandbox" });
				expect(fixture.calls.observeList).toBe(1);
			}
		}

		// Cell still held by replyPromise
		const bHeld: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(bHeld)).toBe("NO_CAPACITY");

		// Resolve reply -> cell freed
		replyDefer.resolve(resultSent);
		await microtaskDrain();

		const bFreed: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(bFreed)).toBe("HANDLED");
	});
	test("N3: non-Runtime origin with valid V16 bytes on stream 2 returns NOT_HANDLED, payload untouched, reply not called", () => {
		const fixture = createFixture();
		let replyCount: number = 0;
		const replyCapture = async (_payloadRaw: unknown): Promise<ComposedReplyResult> => {
			replyCount += 1;
			return resultSent;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		const originalPayload: Uint8Array = freshSendMessageBytes();
		const payloadSnapshot: Uint8Array = new Uint8Array(originalPayload);
		const b: ApplicationBundle = {
			origin: "Home",
			stream: 2,
			payload: payloadSnapshot,
			signal: signalActive,
			reply: replyCapture,
		};
		const result: RouteResult = dispatcher.route(b);
		expect(result).toBe("NOT_HANDLED");

		expect(payloadSnapshot.length).toBe(originalPayload.length);
		for (let i: number = 0; i < payloadSnapshot.length; i++) {
			expect(payloadSnapshot[i]).toBe(originalPayload[i]);
		}
		expect(replyCount).toBe(0);
	});

	test("N4: Runtime-origin stream 0/1/4 each returns NOT_HANDLED, payload untouched, reply not called", () => {
		const fixture = createFixture();
		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		const streams: Array<0 | 1 | 4> = [0, 1, 4];
		for (let si: number = 0; si < streams.length; si++) {
			let replyCount: number = 0;
			const replyCapture = async (_payloadRaw: unknown): Promise<ComposedReplyResult> => {
				replyCount += 1;
				return resultSent;
			};
			const originalPayload: Uint8Array = freshSendMessageBytes();
			const payloadSnapshot: Uint8Array = new Uint8Array(originalPayload);
			const b: ApplicationBundle = {
				origin: "Runtime",
				stream: streams[si],
				payload: payloadSnapshot,
				signal: signalActive,
				reply: replyCapture,
			};
			expect(dispatcher.route(b)).toBe("NOT_HANDLED");
			for (let i: number = 0; i < payloadSnapshot.length; i++) {
				expect(payloadSnapshot[i]).toBe(originalPayload[i]);
			}
			expect(replyCount).toBe(0);
		}
	});

	test("N5: route() after close() returns CLOSED, payload untouched, reply not called", () => {
		const fixture = createFixture();
		let replyCount: number = 0;
		const replyCapture = async (_payloadRaw: unknown): Promise<ComposedReplyResult> => {
			replyCount += 1;
			return resultSent;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		dispatcher.close();

		const originalPayload: Uint8Array = freshSendMessageBytes();
		const payloadSnapshot: Uint8Array = new Uint8Array(originalPayload);
		const b: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: payloadSnapshot,
			signal: signalActive,
			reply: replyCapture,
		};
		expect(dispatcher.route(b)).toBe("CLOSED");
		for (let i: number = 0; i < payloadSnapshot.length; i++) {
			expect(payloadSnapshot[i]).toBe(originalPayload[i]);
		}
		expect(replyCount).toBe(0);
	});

	test("N6: malformed V16 bytes on Runtime stream 2 returns INVALID, payload zeroed, zero-length reply, cell retained until reply settle", async () => {
		const fixture = createFixture();
		const neverDefers: Array<{ promise: Promise<unknown>; resolve: (value: unknown) => void }> = [];
		for (let i: number = 0; i < 63; i++) {
			neverDefers.push(deferredPromise());
		}
		let callIndex: number = 0;
		fixture.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			const idx: number = callIndex;
			callIndex += 1;
			return neverDefers[idx].promise;
		};

		let replyCount: number = 0;
		let replyPayload: unknown;
		const replyDefer: { promise: Promise<ComposedReplyResult>; resolve: (value: ComposedReplyResult) => void } =
			deferredPromise<ComposedReplyResult>();
		const replyCapture = async (payloadRaw: unknown): Promise<ComposedReplyResult> => {
			replyCount += 1;
			replyPayload = payloadRaw;
			return await replyDefer.promise;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		for (let i: number = 0; i < 63; i++) {
			const b: ApplicationBundle = {
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			};
			expect(dispatcher.route(b)).toBe("HANDLED");
		}

		const malformedPayload: Uint8Array = new Uint8Array(bytesMalformed);
		const b64: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: malformedPayload,
			signal: signalActive,
			reply: replyCapture,
		};
		expect(dispatcher.route(b64)).toBe("INVALID");

		for (let i: number = 0; i < malformedPayload.length; i++) {
			expect(malformedPayload[i]).toBe(0);
		}

		await microtaskDrain();

		expect(replyCount).toBe(1);
		expect(isUint8Array(replyPayload)).toBe(true);
		if (isUint8Array(replyPayload)) {
			expect(replyPayload.length).toBe(0);
		}

		const b65: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b65)).toBe("NO_CAPACITY");

		replyDefer.resolve(resultSent);
		await microtaskDrain();

		const b66: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b66)).toBe("HANDLED");
	});

	test("N7: method/stream mismatch (observe_list on stream 2) returns INVALID, payload zeroed, zero-length reply, cell retained until reply settle", async () => {
		const fixture = createFixture();
		const neverDefers: Array<{ promise: Promise<unknown>; resolve: (value: unknown) => void }> = [];
		for (let i: number = 0; i < 63; i++) {
			neverDefers.push(deferredPromise());
		}
		let callIndex: number = 0;
		fixture.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			const idx: number = callIndex;
			callIndex += 1;
			return neverDefers[idx].promise;
		};

		let replyCount: number = 0;
		let replyPayload: unknown;
		const replyDefer: { promise: Promise<ComposedReplyResult>; resolve: (value: ComposedReplyResult) => void } =
			deferredPromise<ComposedReplyResult>();
		const replyCapture = async (payloadRaw: unknown): Promise<ComposedReplyResult> => {
			replyCount += 1;
			replyPayload = payloadRaw;
			return await replyDefer.promise;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		for (let i: number = 0; i < 63; i++) {
			const b: ApplicationBundle = {
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			};
			expect(dispatcher.route(b)).toBe("HANDLED");
		}

		const misBytes: Uint8Array = freshObserveListBytes();
		const b64: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: misBytes,
			signal: signalActive,
			reply: replyCapture,
		};
		expect(dispatcher.route(b64)).toBe("INVALID");

		for (let i: number = 0; i < misBytes.length; i++) {
			expect(misBytes[i]).toBe(0);
		}

		await microtaskDrain();

		expect(replyCount).toBe(1);
		expect(isUint8Array(replyPayload)).toBe(true);
		if (isUint8Array(replyPayload)) {
			expect(replyPayload.length).toBe(0);
		}

		const b65: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b65)).toBe("NO_CAPACITY");

		replyDefer.resolve(resultSent);
		await microtaskDrain();

		const b66: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b66)).toBe("HANDLED");
	});

	test("N8: pre-aborted signal on stream 2 returns HANDLED, payload zeroed, controller never called, reply never called, cell released", async () => {
		const fixture = createFixture();
		const neverDefers: Array<{ promise: Promise<unknown>; resolve: (value: unknown) => void }> = [];
		for (let i: number = 0; i < 64; i++) {
			neverDefers.push(deferredPromise());
		}
		let callIndex: number = 0;
		fixture.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			const idx: number = callIndex;
			callIndex += 1;
			return neverDefers[idx].promise;
		};
		let replyCount: number = 0;
		const replyCapture = async (_payloadRaw: unknown): Promise<ComposedReplyResult> => {
			replyCount += 1;
			return resultSent;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		for (let i: number = 0; i < 63; i++) {
			const b: ApplicationBundle = {
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			};
			expect(dispatcher.route(b)).toBe("HANDLED");
		}

		const abortedPayload: Uint8Array = freshSendMessageBytes();
		const b64: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: abortedPayload,
			signal: signalAborted,
			reply: replyCapture,
		};
		expect(dispatcher.route(b64)).toBe("HANDLED");

		for (let i: number = 0; i < abortedPayload.length; i++) {
			expect(abortedPayload[i]).toBe(0);
		}

		expect(callIndex).toBe(63);
		expect(replyCount).toBe(0);

		const b65: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b65)).toBe("NO_CAPACITY");

		await microtaskDrain();

		const b66: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b66)).toBe("HANDLED");
	});

	// ====== Capacity and Byte Zero Tests N9-N11 ======

	test("N9: 64 cells full returns NO_CAPACITY; resolve + drain frees cell", async () => {
		const fixture = createFixture();
		const defers: Array<{ promise: Promise<unknown>; resolve: (value: unknown) => void }> = [];
		for (let i: number = 0; i < 65; i++) {
			defers.push(deferredPromise());
		}
		let callIndex: number = 0;
		fixture.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			const idx: number = callIndex;
			callIndex += 1;
			return defers[idx].promise;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		for (let i: number = 0; i < 64; i++) {
			const b: ApplicationBundle = {
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			};
			expect(dispatcher.route(b)).toBe("HANDLED");
		}

		const b65: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b65)).toBe("NO_CAPACITY");

		defers[0].resolve({ id: "agentmsg_1", source: "agent_message", deliveryStatus: "delivered" });
		await microtaskDrain();

		const b66: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b66)).toBe("HANDLED");
	});

	test("N10: reply bytes zeroed after settlement", async () => {
		const fixture = createFixture();
		const replyDefer: { promise: Promise<ComposedReplyResult>; resolve: (value: ComposedReplyResult) => void } =
			deferredPromise<ComposedReplyResult>();
		const capturedPayloads: Array<unknown> = [];
		const replySpy = async (payloadRaw: unknown): Promise<ComposedReplyResult> => {
			capturedPayloads.push(payloadRaw);
			return await replyDefer.promise;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		const b: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: replySpy,
		};
		expect(dispatcher.route(b)).toBe("HANDLED");

		await microtaskDrain();

		expect(capturedPayloads.length).toBeGreaterThanOrEqual(1);
		if (capturedPayloads.length >= 1) {
			const raw: unknown = capturedPayloads[0];
			expect(isUint8Array(raw)).toBe(true);
			if (isUint8Array(raw)) {
				const bytes: Uint8Array = raw;
				expect(bytes.length).toBeGreaterThan(0);
				let hasNonzero: boolean = false;
				for (let i: number = 0; i < bytes.length; i++) {
					if (bytes[i] !== 0) {
						hasNonzero = true;
						break;
					}
				}
				expect(hasNonzero).toBe(true);

				replyDefer.resolve(resultSent);
				await microtaskDrain();

				let allZero: boolean = true;
				for (let i: number = 0; i < bytes.length; i++) {
					if (bytes[i] !== 0) {
						allZero = false;
						break;
					}
				}
				expect(allZero).toBe(true);
			}
		}
	});

	test("N11: two dispatcher instances isolated", async () => {
		const fixtureA = createFixture();
		const fixtureB = createFixture();
		const defersA: Array<{ promise: Promise<unknown>; resolve: (value: unknown) => void }> = [];
		for (let i: number = 0; i < 65; i++) {
			defersA.push(deferredPromise());
		}
		let callIndexA: number = 0;
		fixtureA.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			const idx: number = callIndexA;
			callIndexA += 1;
			return defersA[idx].promise;
		};

		const createdA = createPrimeSandboxHostedControllerDispatcher(fixtureA.factoryInput);
		expect(createdA.ok).toBe(true);
		const createdB = createPrimeSandboxHostedControllerDispatcher(fixtureB.factoryInput);
		expect(createdB.ok).toBe(true);
		if (!createdA.ok || !createdB.ok) return;

		const dA: HostedControllerDispatcher = createdA.value;
		const dB: HostedControllerDispatcher = createdB.value;

		for (let i: number = 0; i < 64; i++) {
			const b: ApplicationBundle = {
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			};
			expect(dA.route(b)).toBe("HANDLED");
		}

		expect(
			dB.route({
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			}),
		).toBe("HANDLED");

		dA.close();

		expect(
			dB.route({
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			}),
		).toBe("HANDLED");

		expect(
			dA.route({
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			}),
		).toBe("CLOSED");
	});

	// ====== Adversarial Tests A1-A7 ======

	test("A1: three-stage lifecycle retention chain", async () => {
		const fixture = createFixture();
		const neverDefers: Array<{ promise: Promise<unknown>; resolve: (value: unknown) => void }> = [];
		for (let i: number = 0; i < 63; i++) {
			neverDefers.push(deferredPromise());
		}
		const settleDefer: { promise: Promise<unknown>; resolve: (value: unknown) => void } = deferredPromise();
		const replyDefer: { promise: Promise<ComposedReplyResult>; resolve: (value: ComposedReplyResult) => void } =
			deferredPromise<ComposedReplyResult>();

		let callIdx: number = 0;
		fixture.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			const idx: number = callIdx;
			callIdx += 1;
			if (idx < 63) return neverDefers[idx].promise;
			return settleDefer.promise;
		};

		const replySpyA1 = async (_payloadRaw: unknown): Promise<ComposedReplyResult> => {
			return await replyDefer.promise;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		for (let i: number = 0; i < 63; i++) {
			const b: ApplicationBundle = {
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			};
			expect(dispatcher.route(b)).toBe("HANDLED");
		}

		const b64: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: replySpyA1,
		};
		expect(dispatcher.route(b64)).toBe("HANDLED");

		settleDefer.resolve({ id: "agentmsg_1", source: "agent_message", deliveryStatus: "delivered" });
		await microtaskDrain();

		const b65: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b65)).toBe("NO_CAPACITY");

		replyDefer.resolve(resultSent);
		await microtaskDrain();

		const b66: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b66)).toBe("HANDLED");
	});

	test("A2: capacity while slow reply pending after fast dispatch", async () => {
		const fixture = createFixture();
		const neverDefers: Array<{ promise: Promise<unknown>; resolve: (value: unknown) => void }> = [];
		for (let i: number = 0; i < 63; i++) {
			neverDefers.push(deferredPromise());
		}
		let callIdx2: number = 0;
		fixture.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			const idx: number = callIdx2;
			callIdx2 += 1;
			if (idx < 63) return neverDefers[idx].promise;
			return { id: "agentmsg_1", source: "agent_message", deliveryStatus: "delivered" };
		};

		const replyDefer2: { promise: Promise<ComposedReplyResult>; resolve: (value: ComposedReplyResult) => void } =
			deferredPromise<ComposedReplyResult>();
		const replySpy2 = async (_payloadRaw: unknown): Promise<ComposedReplyResult> => {
			return await replyDefer2.promise;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		for (let i: number = 0; i < 63; i++) {
			const b: ApplicationBundle = {
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			};
			expect(dispatcher.route(b)).toBe("HANDLED");
		}

		const b64: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: replySpy2,
		};
		expect(dispatcher.route(b64)).toBe("HANDLED");

		await microtaskDrain();

		const b65: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b65)).toBe("NO_CAPACITY");
	});

	test("A3: settled handler receives CONTROLLER_FAILURE from invoke total path", async () => {
		const fixture = createFixture();
		fixture.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			return Promise.reject();
		};
		const replyDefer: { promise: Promise<ComposedReplyResult>; resolve: (value: ComposedReplyResult) => void } =
			deferredPromise<ComposedReplyResult>();
		let replyCount: number = 0;
		let replyPayload: unknown;
		const replyCapture = async (payloadRaw: unknown): Promise<ComposedReplyResult> => {
			replyCount += 1;
			replyPayload = payloadRaw;
			return await replyDefer.promise;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		const b: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: replyCapture,
		};
		expect(dispatcher.route(b)).toBe("HANDLED");

		await microtaskDrain();

		expect(replyCount).toBe(1);
		expect(isUint8Array(replyPayload)).toBe(true);
		if (isUint8Array(replyPayload)) {
			expect(replyPayload.length).toBeGreaterThan(0);
			const decodeResult = decodeReply(replyPayload, "send_message", wireIdentity);
			expect(decodeResult.ok).toBe(true);
			if (decodeResult.ok) {
				expect(decodeResult.reply.method).toBe("send_message");
				expect(decodeResult.reply.identity).toEqual(wireIdentity);
				expect(decodeResult.reply.execution).toEqual({ type: "prime-sandbox" });
				expect(decodeResult.reply.body).toEqual({ error: "CONTROLLER_FAILURE" });
			}
		}

		replyDefer.resolve(resultSent);
		await microtaskDrain();

		if (isUint8Array(replyPayload)) {
			let allZero: boolean = true;
			for (let i: number = 0; i < replyPayload.length; i++) {
				if (replyPayload[i] !== 0) {
					allZero = false;
					break;
				}
			}
			expect(allZero).toBe(true);
		}

		const b2: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b2)).toBe("HANDLED");
	});

	test("A4: close before settlement suppresses reply", async () => {
		const fixture = createFixture();
		const controllerDefer: { promise: Promise<unknown>; resolve: (value: unknown) => void } = deferredPromise();
		let replyCalled: boolean = false;
		fixture.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			return controllerDefer.promise;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		const b: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => {
				replyCalled = true;
				return resultSent;
			},
		};
		expect(dispatcher.route(b)).toBe("HANDLED");

		dispatcher.close();

		controllerDefer.resolve({ id: "agentmsg_1", source: "agent_message", deliveryStatus: "delivered" });
		await microtaskDrain();

		expect(replyCalled).toBe(false);
	});

	test("A5: abort after dispatch suppresses reply, cell released", async () => {
		const fixture = createFixture();
		const neverDefers: Array<{ promise: Promise<unknown>; resolve: (value: unknown) => void }> = [];
		for (let i: number = 0; i < 64; i++) {
			neverDefers.push(deferredPromise());
		}
		const controllerDefer: { promise: Promise<unknown>; resolve: (value: unknown) => void } = deferredPromise();
		let callIdx5: number = 0;
		let replyCalled: boolean = false;
		fixture.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			const idx: number = callIdx5;
			callIdx5 += 1;
			if (idx < 63) return neverDefers[idx].promise;
			return controllerDefer.promise;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		for (let i: number = 0; i < 63; i++) {
			const b: ApplicationBundle = {
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			};
			expect(dispatcher.route(b)).toBe("HANDLED");
		}

		const ac = new AbortController();
		const b64: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: ac.signal,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => {
				replyCalled = true;
				return resultSent;
			},
		};
		expect(dispatcher.route(b64)).toBe("HANDLED");

		ac.abort();

		controllerDefer.resolve({ id: "agentmsg_1", source: "agent_message", deliveryStatus: "delivered" });
		await microtaskDrain();

		expect(replyCalled).toBe(false);

		const b66: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b66)).toBe("HANDLED");
	});

	test("A6: fulfilled cleanup microtask ordering", async () => {
		const fixture = createFixture();
		const neverDefers: Array<{ promise: Promise<unknown>; resolve: (value: unknown) => void }> = [];
		for (let i: number = 0; i < 64; i++) {
			neverDefers.push(deferredPromise());
		}
		const settleDefer: { promise: Promise<unknown>; resolve: (value: unknown) => void } = deferredPromise();
		const replyDefer: { promise: Promise<ComposedReplyResult>; resolve: (value: ComposedReplyResult) => void } =
			deferredPromise<ComposedReplyResult>();
		let callIdx6: number = 0;
		fixture.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			const idx: number = callIdx6;
			callIdx6 += 1;
			if (idx < 63) return neverDefers[idx].promise;
			return settleDefer.promise;
		};
		const replySpy6 = async (_payloadRaw: unknown): Promise<ComposedReplyResult> => {
			return await replyDefer.promise;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		for (let i: number = 0; i < 63; i++) {
			const b: ApplicationBundle = {
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			};
			expect(dispatcher.route(b)).toBe("HANDLED");
		}

		const b64: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: replySpy6,
		};
		expect(dispatcher.route(b64)).toBe("HANDLED");

		settleDefer.resolve({ id: "agentmsg_1", source: "agent_message", deliveryStatus: "delivered" });
		for (let index: number = 0; index < 2; index++) await Promise.resolve();

		const b65: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b65)).toBe("NO_CAPACITY");

		replyDefer.resolve(resultSent);
		await Promise.resolve();

		const b66: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b66)).toBe("NO_CAPACITY");

		await microtaskDrain();

		const b67: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b67)).toBe("HANDLED");
	});

	test("A7: rejected cleanup microtask ordering (CONTROLLER_FAILURE settled path)", async () => {
		const fixture = createFixture();
		const neverDefers: Array<{ promise: Promise<unknown>; resolve: (value: unknown) => void }> = [];
		for (let i: number = 0; i < 64; i++) {
			neverDefers.push(deferredPromise());
		}
		const replyDefer: { promise: Promise<ComposedReplyResult>; resolve: (value: ComposedReplyResult) => void } =
			deferredPromise<ComposedReplyResult>();
		let callIdx7: number = 0;
		fixture.messageController.sendAgentMessage = (_input: unknown, _signal: AbortSignal) => {
			const idx: number = callIdx7;
			callIdx7 += 1;
			if (idx < 63) return neverDefers[idx].promise;
			return Promise.reject();
		};
		const replySpy7 = async (_payloadRaw: unknown): Promise<ComposedReplyResult> => {
			return await replyDefer.promise;
		};

		const created = createPrimeSandboxHostedControllerDispatcher(fixture.factoryInput);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const dispatcher: HostedControllerDispatcher = created.value;

		for (let i: number = 0; i < 63; i++) {
			const b: ApplicationBundle = {
				origin: "Runtime",
				stream: 2,
				payload: freshSendMessageBytes(),
				signal: signalActive,
				reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
			};
			expect(dispatcher.route(b)).toBe("HANDLED");
		}

		const b64: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: replySpy7,
		};
		expect(dispatcher.route(b64)).toBe("HANDLED");

		for (let index: number = 0; index < 2; index++) await Promise.resolve();

		const b65: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b65)).toBe("NO_CAPACITY");

		replyDefer.resolve(resultSent);
		await Promise.resolve();

		const b66: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b66)).toBe("NO_CAPACITY");

		await microtaskDrain();

		const b67: ApplicationBundle = {
			origin: "Runtime",
			stream: 2,
			payload: freshSendMessageBytes(),
			signal: signalActive,
			reply: async (_payloadRaw: unknown): Promise<ComposedReplyResult> => resultSent,
		};
		expect(dispatcher.route(b67)).toBe("HANDLED");
	});
});
