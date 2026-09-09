import { describe, expect, it } from "bun:test";
import { createPrimeSandboxHomeRuntime } from "../src/modes/daemon/sandbox/prime-sandbox-home-runtime.js";
import { decodeModelReplyBytes, encodeModelRequest } from "../src/modes/daemon/sandbox/prime-sandbox-model-codec.js";
import {
	decodeLifecycleRecord,
	encodeLifecycleReply,
} from "../src/modes/daemon/sandbox/prime-sandbox-runtime-control-codec.js";
import { createPrimeSandboxRuntimeControllerRelay } from "../src/modes/daemon/sandbox/prime-sandbox-runtime-controller-relay.js";
import type {
	ApplicationBundle,
	ComposedReplyResult,
	OriginSubmit,
	ReplyResult,
} from "../src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.js";
import { createRuntimeMultiplexer } from "../src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.js";

type Inbound = (streamRaw: unknown, plaintextRaw: unknown) => void;
type SendResult = Readonly<{ code: "SENT" | "FAILED" }>;
type CloseResult = Readonly<{ code: "CLOSED" | "FAILED" }>;

function physicalPair() {
	let homeInbound: Inbound | null = null;
	let runtimeInbound: Inbound | null = null;
	let homeCloses = 0;
	let runtimeCloses = 0;
	function send(peer: Inbound | null, streamRaw: unknown, plaintextRaw: unknown): Promise<SendResult> {
		return new Promise<SendResult>((resolve): void => {
			queueMicrotask((): void => {
				if (peer === null) {
					resolve(Object.freeze({ code: "FAILED" }));
					return;
				}
				try {
					peer(streamRaw, plaintextRaw);
					resolve(Object.freeze({ code: "SENT" }));
				} catch {
					resolve(Object.freeze({ code: "FAILED" }));
				}
			});
		});
	}
	const home = Object.freeze({
		send: (streamRaw: unknown, plaintextRaw: unknown): Promise<SendResult> =>
			send(runtimeInbound, streamRaw, plaintextRaw),
		registerInbound: (handler: Inbound): Readonly<{ code: "REGISTERED" }> => {
			homeInbound = handler;
			return Object.freeze({ code: "REGISTERED" });
		},
		close: (): Promise<CloseResult> => {
			homeCloses += 1;
			return new Promise<CloseResult>((resolve): void => resolve(Object.freeze({ code: "CLOSED" })));
		},
	});
	const runtime = Object.freeze({
		send: (streamRaw: unknown, plaintextRaw: unknown): Promise<SendResult> =>
			send(homeInbound, streamRaw, plaintextRaw),
		registerInbound: (handler: Inbound): Readonly<{ code: "REGISTERED" }> => {
			runtimeInbound = handler;
			return Object.freeze({ code: "REGISTERED" });
		},
		close: (): Promise<CloseResult> => {
			runtimeCloses += 1;
			return new Promise<CloseResult>((resolve): void => resolve(Object.freeze({ code: "CLOSED" })));
		},
	});
	return {
		home,
		runtime,
		homeCloses: (): number => homeCloses,
		runtimeCloses: (): number => runtimeCloses,
	};
}

function observation(label: string, target: string) {
	return {
		activeSessionId: `active-${label}`,
		sessionId: `session-${label}`,
		sessionName: target,
		runtimeKind: "subagent",
		cwd: "/redacted",
		status: "idle",
		isCurrent: false,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		queuedCount: 0,
		isSessionActive: true,
		rlmChildId: `child-${label}`,
		firstMessage: `task-${label}`,
		latestMessage: {
			index: 0,
			role: "assistant",
			timestamp: 1,
			text: `ready-${label}`,
			truncated: false,
			toolCalls: [],
		},
	};
}

function controller(label: string) {
	const owner = Object.freeze({ label });
	const controllerIdentity = {
		activeSessionId: `active-${label}`,
		sessionId: `session-${label}`,
		rlmChildId: `child-${label}`,
		depth: 1,
		sessionName: `name-${label}`,
	};
	const messageController = {
		listAgents: (): unknown => ({
			current: {
				activeSessionId: `active-${label}`,
				sessionId: `session-${label}`,
				sessionName: `name-${label}`,
				runtimeKind: "subagent",
			},
			agents: [],
		}),
		roster: (): unknown => ({ current: { name: `name-${label}`, id: `session-${label}`, depth: 1 }, entries: [] }),
		awaitPendingChildPublication: (): unknown => undefined,
		assertSessionNameAvailable: (): void => {},
		setSessionName: (): void => {},
		sendAgentMessage: (): unknown => ({
			id: `message-${label}`,
			source: "agent_message",
			target: {
				activeSessionId: "active-peer",
				sessionId: "session-peer",
				sessionName: "peer",
				runtimeKind: "subagent",
			},
			from: {
				activeSessionId: `active-${label}`,
				sessionId: `session-${label}`,
				sessionName: `name-${label}`,
				runtimeKind: "subagent",
			},
			fromRelationship: "parent",
			message: `hello-${label}`,
			deliveryStatus: "delivered",
			deliveredAt: "2026-01-01T00:00:00.000Z",
		}),
	};
	const observeController = {
		listAgents: (): unknown => ({ current: observation(label, `name-${label}`), agents: [] }),
		getAgent: (target: string): unknown => ({ agent: observation(label, target) }),
		recentMessages: (): unknown => ({
			agent: observation(label, "peer"),
			messages: [{ index: 0, role: "assistant", text: `ready-${label}`, truncated: false }],
			limit: 1,
			maxChars: 100,
			truncated: false,
		}),
	};
	return {
		controllerDispatcher: {
			sessionOwner: owner,
			authorizeIdentity: (candidate: object): unknown =>
				candidate === owner ? { identity: controllerIdentity, messageController, observeController } : undefined,
		},
		controllerIdentity,
		routeIdentity: {
			childId: `child-${label}`,
			sessionId: `session-${label}`,
			sessionName: `name-${label}`,
			modelSelector: `model-${label}`,
		},
	};
}

async function originCall(origin: OriginSubmit, bytes: Uint8Array): Promise<ReplyResult | null> {
	const submitted = origin.submit(bytes);
	bytes.fill(0);
	if (submitted.code !== "SUBMITTED") return null;
	const delivery = await origin.awaitDelivery(submitted.ticket);
	if (delivery.code !== "CONFIRMED") return null;
	return origin.awaitReply(submitted.ticket);
}

async function settle(
	promise: Promise<unknown>,
): Promise<Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; reason: unknown }>> {
	try {
		return Object.freeze({ ok: true, value: await promise });
	} catch (reason) {
		return Object.freeze({ ok: false, reason });
	}
}

describe("prime sandbox Home parent runtime", () => {
	it("rejects hostile construction before physical registration", () => {
		let registrations = 0;
		const physical = Object.freeze({
			send: (): Promise<SendResult> => Promise.resolve(Object.freeze({ code: "SENT" })),
			registerInbound: (): Readonly<{ code: "REGISTERED" }> => {
				registrations += 1;
				return Object.freeze({ code: "REGISTERED" });
			},
			close: (): Promise<CloseResult> => Promise.resolve(Object.freeze({ code: "CLOSED" })),
		});
		const modelProvider = Object.freeze({
			provide: (): Promise<unknown> => Promise.resolve(Object.freeze({ ok: false, code: "INTERNAL_ERROR" })),
		});
		expect(createPrimeSandboxHomeRuntime({ modelProvider, physicalPort: physical })).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(
			createPrimeSandboxHomeRuntime({ physicalPort: physical, modelProvider: { provide: modelProvider.provide } }),
		).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		const hostile: object = {};
		Object.defineProperty(hostile, "physicalPort", { enumerable: true, get: (): unknown => physical });
		Object.defineProperty(hostile, "modelProvider", { enumerable: true, value: modelProvider });
		expect(createPrimeSandboxHomeRuntime(hostile)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(registrations).toBe(0);
	});

	it("owns one Home mux for two isolated logical children and cascades close", async (): Promise<void> => {
		const pair = physicalPair();
		const replyPromises: Promise<ComposedReplyResult>[] = [];
		const runtimeClosedChildren: string[] = [];
		const runtimeResult = createRuntimeMultiplexer(pair.runtime, {
			dispatchApplication: (bundle: ApplicationBundle): void => {
				const decoded = decodeLifecycleRecord(bundle.payload);
				bundle.payload.fill(0);
				if (!decoded.ok) return;
				let body: Record<string, unknown> | null = null;
				if (decoded.op === "START") body = { code: "ADMITTED" };
				if (decoded.op === "ABORT") body = { status: "aborted" };
				if (decoded.op === "OBSERVE") {
					body = { status: "running", messageCount: 1, toolUseCount: 0, agentRunning: true, parentReplyCount: 0 };
				}
				if (decoded.op === "CLOSE") {
					body = { status: "closed" };
					runtimeClosedChildren.push(decoded.identity.childId);
				}
				if (body === null) return;
				const encoded = encodeLifecycleReply(decoded.op, body);
				if (!encoded.ok) return;
				replyPromises.push(bundle.reply(encoded.bytes));
				encoded.bytes.fill(0);
			},
		});
		expect("code" in runtimeResult).toBe(false);
		if ("code" in runtimeResult) return;
		const signals: AbortSignal[] = [];
		let providerCalls = 0;
		let settlePendingProvider = (_value: unknown): void => {};
		const pendingProvider = new Promise<unknown>((resolve): void => {
			settlePendingProvider = resolve;
		});
		const modelProvider = Object.freeze({
			provide: (_request: unknown, signal: AbortSignal): Promise<unknown> => {
				signals.push(signal);
				providerCalls += 1;
				if (providerCalls === 1) return Promise.resolve(Object.freeze({ ok: false, code: "INTERNAL_ERROR" }));
				return pendingProvider;
			},
		});
		const created = createPrimeSandboxHomeRuntime({ physicalPort: pair.home, modelProvider });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(Object.keys(created.value)).toEqual(["createChild", "close"]);
		expect(Object.isFrozen(created.value)).toBe(true);
		const a = controller("a");
		const b = controller("b");
		const childA = created.value.createChild({
			identity: a.routeIdentity,
			controllerDispatcher: a.controllerDispatcher,
		});
		const childB = created.value.createChild({
			identity: b.routeIdentity,
			controllerDispatcher: b.controllerDispatcher,
		});
		expect(childA.ok).toBe(true);
		expect(childB.ok).toBe(true);
		if (!childA.ok || !childB.ok) return;
		expect(await childA.value.startInitialTask({ prompt: "a" })).toEqual({ ok: true, value: { code: "ADMITTED" } });
		expect(await childB.value.startInitialTask({ prompt: "b" })).toEqual({ ok: true, value: { code: "ADMITTED" } });

		const request = encodeModelRequest({ messages: [] }, null);
		expect(request.ok).toBe(true);
		if (!request.ok) return;
		const modelReply = await originCall(runtimeResult.modelToHome, request.bytes);
		expect(modelReply !== null ? modelReply.code : undefined).toBe("REPLY_READY");
		if (modelReply !== null && modelReply.code === "REPLY_READY") {
			const decoded = decodeModelReplyBytes(modelReply.payload);
			expect(decoded).toEqual({ ok: true, reply: { ok: false, code: "INTERNAL_ERROR" } });
			modelReply.payload.fill(0);
		}
		expect(signals).toHaveLength(1);
		expect(await childB.value.abort()).toEqual({ ok: true, value: { status: "aborted" } });

		const relayB = createPrimeSandboxRuntimeControllerRelay(
			b.routeIdentity,
			b.controllerIdentity,
			runtimeResult.messagesToHome,
			runtimeResult.observeRequestsToHome,
		);
		expect(relayB.ok).toBe(true);
		if (!relayB.ok) return;
		expect(
			await settle(
				relayB.adapter.invoke(
					"send_message",
					{ target: "peer", message: "hello-b", receiverRole: "child" },
					new AbortController().signal,
				),
			),
		).toMatchObject({ ok: true, value: { id: "message-b", message: "hello-b" } });
		expect(await childA.value.close()).toEqual({ ok: true, value: { status: "closed" } });
		expect(pair.homeCloses()).toBe(0);
		expect(
			await settle(relayB.adapter.invoke("observe_get", { target: "peer" }, new AbortController().signal)),
		).toMatchObject({ ok: true, value: { agent: { activeSessionId: "active-b", sessionName: "peer" } } });

		for (let index = 0; index < 30; index++) {
			const extra = controller(`extra-${index}`);
			expect(
				created.value.createChild({
					identity: extra.routeIdentity,
					controllerDispatcher: extra.controllerDispatcher,
				}),
			).toMatchObject({ ok: true });
		}
		const overflow = controller("overflow");
		expect(
			created.value.createChild({
				identity: overflow.routeIdentity,
				controllerDispatcher: overflow.controllerDispatcher,
			}),
		).toEqual({ ok: false, code: "INVALID_INPUT" });

		const pendingRequest = encodeModelRequest({ messages: [] }, null);
		expect(pendingRequest.ok).toBe(true);
		if (!pendingRequest.ok) return;
		const pendingModelReply = originCall(runtimeResult.modelToHome, pendingRequest.bytes);
		for (let index = 0; index < 32 && providerCalls < 2; index++) await Promise.resolve();
		expect(providerCalls).toBe(2);

		const firstClose = created.value.close();
		const secondClose = created.value.close();
		expect(firstClose).toBe(secondClose);
		expect(
			created.value.createChild({ identity: a.routeIdentity, controllerDispatcher: a.controllerDispatcher }),
		).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
		for (let index = 0; index < 512; index++) {
			if (signals.length === 2 && signals[1].aborted) break;
			await Promise.resolve();
		}
		expect(signals.length === 2 && signals[1].aborted).toBe(true);
		settlePendingProvider(Object.freeze({ ok: false, code: "INTERNAL_ERROR" }));
		expect(await firstClose).toEqual({ code: "CLOSED" });
		expect(runtimeClosedChildren.slice(0, 2)).toEqual(["child-a", "child-b"]);
		expect(runtimeClosedChildren).toHaveLength(32);
		expect(pair.homeCloses()).toBe(1);
		expect(pair.runtimeCloses()).toBe(0);
		expect(await runtimeResult.close()).toEqual({ code: "CLEAN" });
		expect(pair.runtimeCloses()).toBe(1);
		const pendingModelResult = await pendingModelReply;
		if (pendingModelResult !== null && pendingModelResult.code === "REPLY_READY") pendingModelResult.payload.fill(0);
		expect(replyPromises.length).toBeGreaterThan(0);
	});
});
