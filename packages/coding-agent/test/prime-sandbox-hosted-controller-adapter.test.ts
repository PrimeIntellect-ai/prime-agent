import { describe, expect, mock, test } from "bun:test";
import { createPrimeSandboxHostedControllerAdapter } from "../src/modes/daemon/sandbox/prime-sandbox-hosted-controller-adapter.js";
import { createControllerInvocationAuthorityManager } from "../src/modes/daemon/sandbox/prime-sandbox-v16-invocation.js";
import { decodeReply, encodeReply } from "../src/modes/daemon/sandbox/prime-sandbox-v16-reply-codec.js";

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
		if (!accessorCreated.ok) return;
		const blockedAccessor = await accessorCreated.adapter.invoke("list_agents", {}, activeSignal());
		expect(blockedAccessor).toEqual({ error: "CONTROLLER_FAILURE" });
		expect(accessorCalls).toBe(0);
		expect(JSON.stringify(blockedAccessor).includes("credential-secret")).toBe(false);

		fixture.messageController.listAgents = () => new Proxy({}, {});
		const proxyCreated = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
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
		if (!throwingCreated.ok) return;
		expect(await throwingCreated.adapter.invoke("observe_get", { target: "child" }, activeSignal())).toEqual({
			error: "CONTROLLER_FAILURE",
		});
		fixture.observeController.getAgent = (target: string) => ({
			agent: observeSummary("child-active", "child-session", target, false),
		});
		const recoveredCreated = createPrimeSandboxHostedControllerAdapter(fixture.factoryInput);
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
		if (!created.ok) return;
		const authority = createControllerInvocationAuthorityManager();
		const wrongSession = authority.createSession(created.adapter, identity());
		if (!wrongSession.ok) return;
		const wrongCall = wrongSession.session.invoke("list_agents", {});
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
		if (!inputSession.ok) return;
		const inputCall = inputSession.session.invoke("list_agents", {});
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
		if (!created.ok) return;
		expect(await created.adapter.invoke("set_name", { name: "next" }, activeSignal())).toEqual({});
		expect(ownedBytes).toBeDefined();
		if (ownedBytes !== undefined) {
			expect(ownedBytes.every((value: number) => value === 0)).toBe(true);
		}
	});
});
