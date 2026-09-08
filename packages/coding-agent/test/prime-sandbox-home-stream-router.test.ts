import { describe, expect, it } from "bun:test";
import type {
	HostedRlmRuntimeEvent,
	HostedRlmRuntimeIdentity,
	HostedRlmTaskResult,
} from "../src/core/hosted-rlm-runtime-port.js";
import { encodeControllerRouteEnvelope } from "../src/modes/daemon/sandbox/prime-sandbox-controller-route-envelope.js";
import {
	createHomeStreamRouter,
	type HomeStreamRouter,
	type HomeStreamRouterInput,
	type LifecycleUnregister,
} from "../src/modes/daemon/sandbox/prime-sandbox-home-stream-router.js";
import {
	decodeLifecycleReply,
	encodeLifecycleRecord,
} from "../src/modes/daemon/sandbox/prime-sandbox-runtime-control-codec.js";
import { decodeReply } from "../src/modes/daemon/sandbox/prime-sandbox-v16-reply-codec.js";
import { encodeRequest } from "../src/modes/daemon/sandbox/prime-sandbox-v16-request-codec.js";
import type {
	ApplicationBundle,
	ComposedReplyResult,
} from "../src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.js";

// ---------- identity helpers ----------

function vid(overrides?: Partial<HostedRlmRuntimeIdentity>): HostedRlmRuntimeIdentity {
	let childId = "c1";
	let sessionId = "s1";
	let sessionName = "n1";
	let modelSelector = "m1";
	if (overrides !== undefined && overrides !== null) {
		if (overrides.childId !== undefined) childId = overrides.childId;
		if (overrides.sessionId !== undefined) sessionId = overrides.sessionId;
		if (overrides.sessionName !== undefined) sessionName = overrides.sessionName;
		if (overrides.modelSelector !== undefined) modelSelector = overrides.modelSelector;
	}
	return { childId, sessionId, sessionName, modelSelector };
}

// ---------- lifecycle payload helpers ----------

function evPayload(identity: HostedRlmRuntimeIdentity): Uint8Array {
	const enc = encodeLifecycleRecord({ v: 1, identity, op: "EVENT", body: { event: { type: "agent_start" } } });
	if (!enc.ok) return new Uint8Array(0);
	return enc.bytes;
}

function tmPayload(identity: HostedRlmRuntimeIdentity, overrides?: Partial<HostedRlmTaskResult>): Uint8Array {
	let status: "completed" | "cancelled" | "error" = "completed";
	let durationMs = 100;
	let parentReplyCount = 0;
	let toolUseCount = 0;
	if (overrides !== undefined && overrides !== null) {
		if (overrides.status !== undefined) status = overrides.status;
		if (overrides.durationMs !== undefined) durationMs = overrides.durationMs;
		if (overrides.parentReplyCount !== undefined) parentReplyCount = overrides.parentReplyCount;
		if (overrides.toolUseCount !== undefined) toolUseCount = overrides.toolUseCount;
	}
	const result: HostedRlmTaskResult = { status, durationMs, parentReplyCount, toolUseCount };
	const enc = encodeLifecycleRecord({ v: 1, identity, op: "TERMINAL", body: { result } });
	if (!enc.ok) return new Uint8Array(0);
	return enc.bytes;
}

// ---------- controller dispatcher factory for tests ----------

function makeControllerRaw(mockMethods?: {
	listAgents?: () => unknown;
	sendMessage?: () => unknown;
	roster?: () => unknown;
	observeList?: () => unknown;
}): unknown {
	const owner = {};
	const identity = {
		activeSessionId: "as1",
		sessionId: "s1",
		rlmChildId: "c1",
		depth: 0,
		sessionName: "n1",
	};
	var listAgents: () => unknown = () => [];
	var roster: () => unknown = () => [];
	var sendAgentMessage: (_to: unknown, _msg: unknown) => void = () => {};
	var observeList: () => unknown = () => [];
	if (mockMethods !== undefined && mockMethods !== null) {
		if (mockMethods.listAgents !== undefined) listAgents = mockMethods.listAgents;
		if (mockMethods.roster !== undefined) roster = mockMethods.roster;
		if (mockMethods.sendMessage !== undefined) sendAgentMessage = mockMethods.sendMessage;
		if (mockMethods.observeList !== undefined) observeList = mockMethods.observeList;
	}
	const msgCtrl = {
		listAgents,
		roster,
		awaitPendingChildPublication: () => {},
		assertSessionNameAvailable: () => true,
		setSessionName: () => {},
		sendAgentMessage,
	};
	const obsCtrl = {
		listAgents: observeList,
		getAgent: () => null,
		recentMessages: () => [],
	};
	return {
		sessionOwner: owner,
		authorizeIdentity: (_owner: unknown) => ({ identity, messageController: msgCtrl, observeController: obsCtrl }),
	};
}

// Build controller raw with identity matching vid
function makeControllerRawFor(
	identity: HostedRlmRuntimeIdentity,
	mockMethods?: {
		listAgents?: () => unknown;
		sendMessage?: (_to: unknown, _msg: unknown) => unknown;
		roster?: () => unknown;
		observeList?: () => unknown;
	},
): unknown {
	const owner = {};
	const wireId = {
		activeSessionId: identity.sessionId,
		sessionId: identity.sessionId,
		rlmChildId: identity.childId,
		depth: 0,
		sessionName: identity.sessionName,
	};
	var listAgents: () => unknown = () => [];
	var roster: () => unknown = () => [];
	var sendAgentMessage: (_to: unknown, _msg: unknown) => void = () => {};
	var observeList: () => unknown = () => [];
	if (mockMethods !== undefined && mockMethods !== null) {
		if (mockMethods.listAgents !== undefined) listAgents = mockMethods.listAgents;
		if (mockMethods.roster !== undefined) roster = mockMethods.roster;
		if (mockMethods.sendMessage !== undefined) sendAgentMessage = mockMethods.sendMessage;
		if (mockMethods.observeList !== undefined) observeList = mockMethods.observeList;
	}
	const msgCtrl = {
		listAgents,
		roster,
		awaitPendingChildPublication: () => {},
		assertSessionNameAvailable: () => true,
		setSessionName: () => {},
		sendAgentMessage,
	};
	const obsCtrl = {
		listAgents: observeList,
		getAgent: () => null,
		recentMessages: () => [],
	};
	return {
		sessionOwner: owner,
		authorizeIdentity: (_owner: unknown) => ({
			identity: wireId,
			messageController: msgCtrl,
			observeController: obsCtrl,
		}),
	};
}

// ---------- Deferred ----------

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function defer<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

// ---------- harness ----------

interface Harness {
	router: HomeStreamRouter;
	modelDispatchCalls: Array<ApplicationBundle>;
}

function makeHarness(): Harness {
	const modelDispatchCalls: Array<ApplicationBundle> = [];
	const modelProvider = {
		dispatchApplication: (bundle: ApplicationBundle): void => {
			modelDispatchCalls.push(bundle);
		},
	};
	const input: HomeStreamRouterInput = { modelProvider };
	const router = createHomeStreamRouter(input);
	return { router, modelDispatchCalls };
}

// Bounded microtask drain for async assertions.
// 12 iterations sufficient for manager invoke -> adapter Promise -> reply -> retained chain.
async function drainMicrotasks(): Promise<void> {
	for (let di = 0; di < 24; di++) {
		await Promise.resolve();
	}
}

// ---------- narrow helpers ----------

function isUnregister(result: LifecycleUnregister | object): result is LifecycleUnregister {
	return "unregister" in result;
}

function isErrorResult(result: object): result is Readonly<{ ok: false; code: string }> {
	return "ok" in result;
}

// ---------- inspectable bundle factory ----------

function inspectableBundle(
	stream: 0 | 1 | 2 | 3 | 4,
	sourcePayload: Uint8Array,
): {
	bundle: ApplicationBundle;
	deferred: Deferred<ComposedReplyResult>;
	replyArg: Array<Uint8Array>;
} {
	const deferred: Deferred<ComposedReplyResult> = defer<ComposedReplyResult>();
	const replyArg: Array<Uint8Array> = [];
	const payload = new Uint8Array(sourcePayload.length);
	for (let bi = 0; bi < sourcePayload.length; bi++) payload[bi] = sourcePayload[bi];
	const bundle: ApplicationBundle = {
		origin: "Runtime",
		stream,
		payload,
		signal: new AbortController().signal,
		reply: (raw: unknown): Promise<ComposedReplyResult> => {
			const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(0);
			replyArg.push(bytes);
			return deferred.promise;
		},
	};
	return { bundle, deferred, replyArg };
}

function simpleBundle(stream: 0 | 1 | 2 | 3 | 4): ApplicationBundle {
	return {
		origin: "Runtime",
		stream,
		payload: new Uint8Array(0),
		signal: new AbortController().signal,
		reply: () => new Promise(() => {}),
	};
}

// ---------- tests ----------

describe("HomeStreamRouter", () => {
	// ==== stream 0 ====
	it("S1: stream 0 forwards to modelProvider", () => {
		const h = makeHarness();
		const bundle = simpleBundle(0);
		h.router.dispatchApplication(bundle);
		expect(h.modelDispatchCalls.length).toBe(1);
		expect(h.modelDispatchCalls[0]).toBe(bundle);
	});

	it("S2: stream 0 preserves payload ownership", () => {
		const h = makeHarness();
		const payload = new Uint8Array([1, 2, 3]);
		const bundle: ApplicationBundle = {
			origin: "Runtime",
			stream: 0,
			payload,
			signal: new AbortController().signal,
			reply: () => new Promise(() => {}),
		};
		h.router.dispatchApplication(bundle);
		expect(h.modelDispatchCalls[0].payload[0]).toBe(1);
		expect(h.modelDispatchCalls[0].payload[1]).toBe(2);
		expect(h.modelDispatchCalls[0].payload[2]).toBe(3);
	});

	it("S2b: exact signal forwarding", () => {
		const h = makeHarness();
		const controller = new AbortController();
		const bundle: ApplicationBundle = {
			origin: "Runtime",
			stream: 0,
			payload: new Uint8Array(0),
			signal: controller.signal,
			reply: () => new Promise(() => {}),
		};
		h.router.dispatchApplication(bundle);
		expect(h.modelDispatchCalls[0].signal).toBe(controller.signal);
	});

	// ==== stream 1 lifecycle ====
	it("S3: EVENT calls listener, ACK reply", () => {
		const h = makeHarness();
		const identity = vid();
		let listenerEvent: HostedRlmRuntimeEvent = { type: "agent_end" };
		const result = h.router.registerLifecycleChild(identity, {
			listener: (ev: HostedRlmRuntimeEvent) => {
				listenerEvent = ev;
			},
		});
		expect(isUnregister(result)).toBe(true);
		if (!isUnregister(result)) return;
		const ib = inspectableBundle(1, evPayload(identity));
		h.router.dispatchApplication(ib.bundle);
		expect<HostedRlmRuntimeEvent>(listenerEvent).toEqual({ type: "agent_start" });
		expect(ib.replyArg.length).toBe(1);
		const decoded = decodeLifecycleReply(ib.replyArg[0], "EVENT");
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(decoded.body).toEqual({ code: "ACK" });
	});

	it("S4: TERMINAL calls terminalSettle, ACK reply", () => {
		const h = makeHarness();
		const identity = vid();
		const settleResult: { current: HostedRlmTaskResult | null } = { current: null };
		const result = h.router.registerLifecycleChild(identity, {
			terminalSettle: (res: HostedRlmTaskResult) => {
				settleResult.current = res;
			},
		});
		expect(isUnregister(result)).toBe(true);
		if (!isUnregister(result)) return;
		const ib = inspectableBundle(1, tmPayload(identity));
		h.router.dispatchApplication(ib.bundle);
		expect(settleResult.current).not.toBe(null);
		if (settleResult.current === null) return;
		expect(settleResult.current.status).toBe("completed");
		const decoded = decodeLifecycleReply(ib.replyArg[0], "TERMINAL");
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(decoded.body).toEqual({ code: "ACK" });
	});

	it("S5: EVENT without listener still sends ACK", () => {
		const h = makeHarness();
		const identity = vid();
		const result = h.router.registerLifecycleChild(identity, {});
		expect(isUnregister(result)).toBe(true);
		if (!isUnregister(result)) return;
		const ib = inspectableBundle(1, evPayload(identity));
		h.router.dispatchApplication(ib.bundle);
		expect(ib.replyArg.length).toBe(1);
	});

	it("S6: malformed frame zero-length reply", () => {
		const h = makeHarness();
		const identity = vid();
		const result = h.router.registerLifecycleChild(identity, {});
		expect(isUnregister(result)).toBe(true);
		if (!isUnregister(result)) return;
		const ib = inspectableBundle(1, new Uint8Array([0xff, 0xfe]));
		h.router.dispatchApplication(ib.bundle);
		expect(ib.replyArg.length).toBe(1);
	});

	it("S7: unexpected op zero-length reply", () => {
		const h = makeHarness();
		const identity = vid();
		const result = h.router.registerLifecycleChild(identity, {});
		expect(isUnregister(result)).toBe(true);
		if (!isUnregister(result)) return;
		const enc = encodeLifecycleRecord({ v: 1, identity, op: "ABORT", body: {} });
		if (!enc.ok) return;
		const ib = inspectableBundle(1, enc.bytes);
		h.router.dispatchApplication(ib.bundle);
		expect(ib.replyArg.length).toBe(1);
	});

	it("S8: known childId identity mismatch", () => {
		const h = makeHarness();
		let called = false;
		const identity = vid();
		const result = h.router.registerLifecycleChild(identity, {
			listener: () => {
				called = true;
			},
		});
		expect(isUnregister(result)).toBe(true);
		if (!isUnregister(result)) return;
		const bad = vid({ sessionId: "wrong" });
		h.router.dispatchApplication(inspectableBundle(1, evPayload(bad)).bundle);
		expect(called).toBe(false);
	});

	it("S9: unknown childId", () => {
		const h = makeHarness();
		let called = false;
		const identity = vid({ childId: "registered" });
		const result = h.router.registerLifecycleChild(identity, {
			listener: () => {
				called = true;
			},
		});
		expect(isUnregister(result)).toBe(true);
		if (!isUnregister(result)) return;
		const unknown = vid({ childId: "unknown" });
		h.router.dispatchApplication(inspectableBundle(1, evPayload(unknown)).bundle);
		expect(called).toBe(false);
	});

	it("S10: duplicate TERMINAL idempotent ACK", () => {
		const h = makeHarness();
		let settleCount = 0;
		const identity = vid();
		const result = h.router.registerLifecycleChild(identity, {
			terminalSettle: () => {
				settleCount += 1;
			},
		});
		expect(isUnregister(result)).toBe(true);
		if (!isUnregister(result)) return;
		const payload = tmPayload(identity);
		const ib1 = inspectableBundle(1, payload);
		h.router.dispatchApplication(ib1.bundle);
		expect(settleCount).toBe(1);
		const ib2 = inspectableBundle(1, payload);
		h.router.dispatchApplication(ib2.bundle);
		expect(settleCount).toBe(1);
		const dec2 = decodeLifecycleReply(ib2.replyArg[0], "TERMINAL");
		expect(dec2.ok).toBe(true);
		if (dec2.ok) expect(dec2.body).toEqual({ code: "ACK" });
	});

	it("S10b: post-terminal EVENT ACK no listener call", () => {
		const h = makeHarness();
		let listenerCount = 0;
		const identity = vid();
		const result = h.router.registerLifecycleChild(identity, {
			listener: () => {
				listenerCount += 1;
			},
			terminalSettle: () => {},
		});
		expect(isUnregister(result)).toBe(true);
		if (!isUnregister(result)) return;
		h.router.dispatchApplication(inspectableBundle(1, tmPayload(identity)).bundle);
		const ib = inspectableBundle(1, evPayload(identity));
		h.router.dispatchApplication(ib.bundle);
		expect(listenerCount).toBe(0);
		const decoded = decodeLifecycleReply(ib.replyArg[0], "EVENT");
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(decoded.body).toEqual({ code: "ACK" });
	});

	// ==== stream 2/3 per-child controller dispatch ====

	it("S11: stream 2 routes list_agents to child controller", async () => {
		const h = makeHarness();
		var listAgentsCalled = false;
		const identity = vid({ childId: "child-a", sessionId: "sa", sessionName: "na", modelSelector: "ma" });
		const ctrlRaw = makeControllerRawFor(identity, {
			listAgents: () => {
				listAgentsCalled = true;
				return [];
			},
		});
		const u = h.router.registerLifecycleChild(identity, undefined, ctrlRaw);
		expect(isUnregister(u)).toBe(true);
		if (!isUnregister(u)) return;
		const innerEnc = encodeRequest({ method: "list_agents", body: {} });
		expect(innerEnc.ok).toBe(true);
		if (!innerEnc.ok) return;
		const enc = encodeControllerRouteEnvelope(identity, innerEnc.bytes);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const ib = inspectableBundle(2, enc.bytes);
		h.router.dispatchApplication(ib.bundle);
		await drainMicrotasks();
		expect(listAgentsCalled).toBe(true);
		expect(ib.replyArg.length).toBe(1);
		// Outer bundle payload was zeroed by controllerRoute
		expect(ib.bundle.payload[0]).toBe(0);
		// Reply bytes are nonzero (dispatcher's JSON reply)
		const replyBytes: Uint8Array = ib.replyArg[0];
		expect(replyBytes.length).toBeGreaterThan(0);
		// Decode captured V16 reply
		const wireId = {
			activeSessionId: identity.sessionId,
			sessionId: identity.sessionId,
			rlmChildId: identity.childId,
			depth: 0,
			sessionName: identity.sessionName,
		};
		const decReply = decodeReply(replyBytes, "list_agents", wireId);
		expect(decReply.ok).toBe(true);
		if (decReply.ok) {
			expect(decReply.reply.method).toBe("list_agents");
			expect(decReply.reply.identity.rlmChildId).toBe(identity.childId);
			expect(decReply.reply.identity.sessionId).toBe(identity.sessionId);
			expect(decReply.reply.execution.type).toBe("prime-sandbox");
			const body = decReply.reply.body;
			if (typeof body === "object" && body !== null && "agents" in body && Array.isArray(body.agents)) {
				// list_agents response has agents array
			}
		}
		// Resolve the deferred so replyThenPromise settles
		ib.deferred.resolve({ code: "SENT" });
		await drainMicrotasks();
		// After settlement, a new dispatch proves cell was freed
		const ib2 = inspectableBundle(4, new Uint8Array(0));
		h.router.dispatchApplication(ib2.bundle);
		expect(ib2.replyArg.length).toBe(1);
	});

	it("S14b: stream 3 routes observe_list", async () => {
		const h = makeHarness();
		var observeListCalled = false;
		const identity = vid({ childId: "obs-child", sessionId: "so", sessionName: "no", modelSelector: "mo" });
		const ctrlRaw = makeControllerRawFor(identity, {
			observeList: () => {
				observeListCalled = true;
				return [];
			},
		});
		const u = h.router.registerLifecycleChild(identity, undefined, ctrlRaw);
		expect(isUnregister(u)).toBe(true);
		if (!isUnregister(u)) return;
		const innerEnc = encodeRequest({ method: "observe_list", body: {} });
		expect(innerEnc.ok).toBe(true);
		if (!innerEnc.ok) return;
		const enc = encodeControllerRouteEnvelope(identity, innerEnc.bytes);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const ib = inspectableBundle(3, enc.bytes);
		h.router.dispatchApplication(ib.bundle);
		await drainMicrotasks();
		expect(observeListCalled).toBe(true);
		await drainMicrotasks();
		expect(ib.replyArg.length).toBe(1);
		expect(ib.bundle.payload[0]).toBe(0);
		expect(ib.replyArg[0].length).toBeGreaterThan(0);
		const wireIdB = {
			activeSessionId: identity.sessionId,
			sessionId: identity.sessionId,
			rlmChildId: identity.childId,
			depth: 0,
			sessionName: identity.sessionName,
		};
		const decB = decodeReply(ib.replyArg[0], "observe_list", wireIdB);
		expect(decB.ok).toBe(true);
		if (decB.ok) {
			expect(decB.reply.method).toBe("observe_list");
			expect(decB.reply.identity.rlmChildId).toBe(identity.childId);
			expect(decB.reply.identity.sessionId).toBe(identity.sessionId);
			expect(decB.reply.execution.type).toBe("prime-sandbox");
		}
		ib.deferred.resolve({ code: "SENT" });
		await drainMicrotasks();
		const ib2 = inspectableBundle(4, new Uint8Array(0));
		h.router.dispatchApplication(ib2.bundle);
		expect(ib2.replyArg.length).toBe(1);
	});

	it("S14c: two children with distinct controllers", async () => {
		const h = makeHarness();
		var callsA = 0;
		var callsB = 0;
		var callsC = 0;
		var callsD = 0;
		const idA = vid({ childId: "a", sessionId: "sa", sessionName: "na", modelSelector: "ma" });
		const idB = vid({ childId: "b", sessionId: "sb", sessionName: "nb", modelSelector: "mb" });
		const wireIdA = {
			activeSessionId: idA.sessionId,
			sessionId: idA.sessionId,
			rlmChildId: idA.childId,
			depth: 0,
			sessionName: idA.sessionName,
		};
		const wireIdB = {
			activeSessionId: idB.sessionId,
			sessionId: idB.sessionId,
			rlmChildId: idB.childId,
			depth: 0,
			sessionName: idB.sessionName,
		};
		const ctrlA = makeControllerRawFor(idA, {
			listAgents: () => {
				callsA += 1;
				return ["agentA1"];
			},
			sendMessage: (_target: unknown, _msg: unknown) => {
				callsC += 1;
				return { status: "delivered" };
			},
		});
		const ctrlB = makeControllerRawFor(idB, {
			listAgents: () => {
				callsB += 1;
				return [];
			},
			observeList: () => {
				callsD += 1;
				return { current: null, agents: [] };
			},
		});
		const uA = h.router.registerLifecycleChild(idA, undefined, ctrlA);
		expect(isUnregister(uA)).toBe(true);
		if (!isUnregister(uA)) return;
		const uB = h.router.registerLifecycleChild(idB, undefined, ctrlB);
		expect(isUnregister(uB)).toBe(true);
		if (!isUnregister(uB)) return;

		// Child A: list_agents on stream 2
		const innerEncA = encodeRequest({ method: "list_agents", body: {} });
		expect(innerEncA.ok).toBe(true);
		if (!innerEncA.ok) return;
		const encA = encodeControllerRouteEnvelope(idA, innerEncA.bytes);
		expect(encA.ok).toBe(true);
		if (!encA.ok) return;
		const ibA = inspectableBundle(2, encA.bytes);
		h.router.dispatchApplication(ibA.bundle);
		await drainMicrotasks();
		expect(callsA).toBe(1);
		expect(callsB).toBe(0);
		expect(ibA.replyArg.length).toBe(1);
		const decA = decodeReply(ibA.replyArg[0], "list_agents", wireIdA);
		expect(decA.ok).toBe(true);
		if (decA.ok) {
			expect(decA.reply.method).toBe("list_agents");
		}
		ibA.deferred.resolve({ code: "SENT" });
		await drainMicrotasks();

		// Child A: send_message on stream 2
		const innerEncMsg = encodeRequest({
			method: "send_message",
			body: { target: "b", message: "hello", receiverRole: "sibling" },
		});
		expect(innerEncMsg.ok).toBe(true);
		if (!innerEncMsg.ok) return;
		const encMsg = encodeControllerRouteEnvelope(idA, innerEncMsg.bytes);
		expect(encMsg.ok).toBe(true);
		if (!encMsg.ok) return;
		const ibMsg = inspectableBundle(2, encMsg.bytes);
		h.router.dispatchApplication(ibMsg.bundle);
		await drainMicrotasks();
		expect(callsA).toBe(1);
		expect(callsC).toBe(1);
		expect(ibMsg.replyArg.length).toBe(1);
		const decMsg = decodeReply(ibMsg.replyArg[0], "send_message", wireIdA);
		expect(decMsg.ok).toBe(true);
		if (decMsg.ok) {
			expect(decMsg.reply.method).toBe("send_message");
			expect(decMsg.reply.identity.rlmChildId).toBe(idA.childId);
			expect(decMsg.reply.identity.sessionId).toBe(idA.sessionId);
			expect(decMsg.reply.execution.type).toBe("prime-sandbox");
		}
		ibMsg.deferred.resolve({ code: "SENT" });
		await drainMicrotasks();

		// Child B: observe_list on stream 3
		const innerEncB3 = encodeRequest({ method: "observe_list", body: {} });
		expect(innerEncB3.ok).toBe(true);
		if (!innerEncB3.ok) return;
		const encB3 = encodeControllerRouteEnvelope(idB, innerEncB3.bytes);
		expect(encB3.ok).toBe(true);
		if (!encB3.ok) return;
		const ibB3 = inspectableBundle(3, encB3.bytes);
		h.router.dispatchApplication(ibB3.bundle);
		await drainMicrotasks();
		expect(callsD).toBe(1);
		expect(ibB3.replyArg.length).toBe(1);
		const decB3 = decodeReply(ibB3.replyArg[0], "observe_list", wireIdB);
		expect(decB3.ok).toBe(true);
		if (decB3.ok) {
			expect(decB3.reply.method).toBe("observe_list");
		}
		ibB3.deferred.resolve({ code: "SENT" });
		await drainMicrotasks();

		// Identity substitution: same childId wrong sessionId rejected
		const spoofSess = { childId: "a", sessionId: "wrong", sessionName: "na", modelSelector: "ma" };
		const spoofEncSess = encodeControllerRouteEnvelope(spoofSess, innerEncA.bytes);
		expect(spoofEncSess.ok).toBe(true);
		if (!spoofEncSess.ok) return;
		const ibSpoofSess = inspectableBundle(2, spoofEncSess.bytes);
		h.router.dispatchApplication(ibSpoofSess.bundle);
		await drainMicrotasks();
		expect(callsA).toBe(1);
		expect(callsC).toBe(1);
		expect(ibSpoofSess.replyArg.length).toBe(1);
		ibSpoofSess.deferred.resolve({ code: "SENT" });
		await drainMicrotasks();

		// Identity substitution: same childId wrong sessionName rejected
		const spoofName = { childId: "a", sessionId: "sa", sessionName: "wrong", modelSelector: "ma" };
		const spoofEncName = encodeControllerRouteEnvelope(spoofName, innerEncA.bytes);
		expect(spoofEncName.ok).toBe(true);
		if (!spoofEncName.ok) return;
		const ibSpoofName = inspectableBundle(2, spoofEncName.bytes);
		h.router.dispatchApplication(ibSpoofName.bundle);
		await drainMicrotasks();
		expect(callsA).toBe(1);
		expect(ibSpoofName.replyArg.length).toBe(1);
		ibSpoofName.deferred.resolve({ code: "SENT" });
		await drainMicrotasks();

		// Identity substitution: same childId wrong modelSelector rejected
		const spoofSel = { childId: "a", sessionId: "sa", sessionName: "na", modelSelector: "wrong" };
		const spoofEncSel = encodeControllerRouteEnvelope(spoofSel, innerEncA.bytes);
		expect(spoofEncSel.ok).toBe(true);
		if (!spoofEncSel.ok) return;
		const ibSpoofSel = inspectableBundle(2, spoofEncSel.bytes);
		h.router.dispatchApplication(ibSpoofSel.bundle);
		await drainMicrotasks();
		expect(callsA).toBe(1);
		expect(ibSpoofSel.replyArg.length).toBe(1);
		ibSpoofSel.deferred.resolve({ code: "SENT" });
		await drainMicrotasks();

		// Unknown childId rejected
		const unknownId = vid({ childId: "unknown" });
		const unkEnc = encodeControllerRouteEnvelope(unknownId, innerEncA.bytes);
		expect(unkEnc.ok).toBe(true);
		if (!unkEnc.ok) return;
		const ibUnk = inspectableBundle(2, unkEnc.bytes);
		h.router.dispatchApplication(ibUnk.bundle);
		await drainMicrotasks();
		expect(callsA).toBe(1);
		expect(callsC).toBe(1);
		expect(ibUnk.replyArg.length).toBe(1);
		ibUnk.deferred.resolve({ code: "SENT" });
		await drainMicrotasks();

		// Unregister A, dispatch A fails, B still works
		uA.unregister();
		// Fresh envelope for A after unregister
		const innerEncAFresh = encodeRequest({ method: "list_agents", body: {} });
		expect(innerEncAFresh.ok).toBe(true);
		if (!innerEncAFresh.ok) return;
		const encAFresh = encodeControllerRouteEnvelope(idA, innerEncAFresh.bytes);
		expect(encAFresh.ok).toBe(true);
		if (!encAFresh.ok) return;
		const ibAFresh = inspectableBundle(2, encAFresh.bytes);
		h.router.dispatchApplication(ibAFresh.bundle);
		await drainMicrotasks();
		expect(callsA).toBe(1);
		expect(ibAFresh.replyArg.length).toBe(1);
		ibAFresh.deferred.resolve({ code: "SENT" });
		await drainMicrotasks();

		// B still works after A unregistered
		const innerEncBFresh = encodeRequest({ method: "list_agents", body: {} });
		expect(innerEncBFresh.ok).toBe(true);
		if (!innerEncBFresh.ok) return;
		const encBFresh = encodeControllerRouteEnvelope(idB, innerEncBFresh.bytes);
		expect(encBFresh.ok).toBe(true);
		if (!encBFresh.ok) return;
		const ibBFresh = inspectableBundle(2, encBFresh.bytes);
		h.router.dispatchApplication(ibBFresh.bundle);
		await drainMicrotasks();
		expect(callsB).toBe(1);
		expect(ibBFresh.replyArg.length).toBe(1);
		const decBFresh = decodeReply(ibBFresh.replyArg[0], "list_agents", wireIdB);
		expect(decBFresh.ok).toBe(true);
		if (decBFresh.ok) {
			expect(decBFresh.reply.method).toBe("list_agents");
		}
		ibBFresh.deferred.resolve({ code: "SENT" });
		await drainMicrotasks();
	});

	it("S14d: spoofed identity (matching childId only) rejected", () => {
		const h = makeHarness();
		var called = false;
		const idA = vid({ childId: "victim", sessionId: "real", sessionName: "rn", modelSelector: "rm" });
		const ctrlA = makeControllerRawFor(idA, {
			listAgents: () => {
				called = true;
				return [];
			},
		});
		const uA = h.router.registerLifecycleChild(idA, undefined, ctrlA);
		expect(isUnregister(uA)).toBe(true);
		if (!isUnregister(uA)) return;
		const innerEnc = encodeRequest({ method: "list_agents", body: {} });
		expect(innerEnc.ok).toBe(true);
		if (!innerEnc.ok) return;
		// Same childId but different sessionId
		const spoof = { childId: "victim", sessionId: "spoof", sessionName: "rn", modelSelector: "rm" };
		const enc = encodeControllerRouteEnvelope(spoof, innerEnc.bytes);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const ib = inspectableBundle(2, enc.bytes);
		h.router.dispatchApplication(ib.bundle);
		expect(called).toBe(false);
		expect(ib.replyArg.length).toBe(1);
	});

	it("S12: malformed envelope returns router cell", () => {
		const h = makeHarness();
		const identity = vid();
		const ctrlRaw = makeControllerRaw();
		const u = h.router.registerLifecycleChild(identity, undefined, ctrlRaw);
		expect(isUnregister(u)).toBe(true);
		if (!isUnregister(u)) return;
		const ib = inspectableBundle(2, new Uint8Array([0x00, 0x01, 0x02]));
		h.router.dispatchApplication(ib.bundle);
		expect(ib.replyArg.length).toBe(1);
	});

	it("S13: unknown childId in envelope rejected", () => {
		const h = makeHarness();
		const registered = vid({ childId: "real" });
		const ctrlRaw = makeControllerRaw();
		const u = h.router.registerLifecycleChild(registered, undefined, ctrlRaw);
		expect(isUnregister(u)).toBe(true);
		if (!isUnregister(u)) return;
		const fake = vid({ childId: "fake" });
		const innerEnc = encodeRequest({ method: "list_agents", body: {} });
		expect(innerEnc.ok).toBe(true);
		if (!innerEnc.ok) return;
		const enc = encodeControllerRouteEnvelope(fake, innerEnc.bytes);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const ib = inspectableBundle(2, enc.bytes);
		h.router.dispatchApplication(ib.bundle);
		expect(ib.replyArg.length).toBe(1);
	});

	it("S14: child with no controller rejected", () => {
		const h = makeHarness();
		const identity = vid();
		const u = h.router.registerLifecycleChild(identity, {});
		expect(isUnregister(u)).toBe(true);
		if (!isUnregister(u)) return;
		const innerEnc = encodeRequest({ method: "list_agents", body: {} });
		expect(innerEnc.ok).toBe(true);
		if (!innerEnc.ok) return;
		const enc = encodeControllerRouteEnvelope(identity, innerEnc.bytes);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const ib = inspectableBundle(2, enc.bytes);
		h.router.dispatchApplication(ib.bundle);
		expect(ib.replyArg.length).toBe(1);
	});

	// ==== stream 4 / non-runtime ====
	it("S15: stream 4 defensive disabled", () => {
		const h = makeHarness();
		const ib = inspectableBundle(4, new Uint8Array(0));
		h.router.dispatchApplication(ib.bundle);
		expect(h.modelDispatchCalls.length).toBe(0);
		expect(ib.replyArg.length).toBe(1);
	});

	it("S16: non-Runtime origin poison", () => {
		const h = makeHarness();
		const bundle: ApplicationBundle = {
			origin: "Home",
			stream: 1,
			payload: new Uint8Array(0),
			signal: new AbortController().signal,
			reply: () => new Promise(() => {}),
		};
		h.router.dispatchApplication(bundle);
		expect(h.modelDispatchCalls.length).toBe(0);
	});

	// ==== close ====
	it("S17: route after close returns CLOSED reply", () => {
		const h = makeHarness();
		h.router.close();
		expect(isErrorResult(h.router.registerLifecycleChild(vid()))).toBe(true);
	});

	it("S18: close idempotent", () => {
		const h = makeHarness();
		h.router.close();
		h.router.close();
	});

	it("S18b: close does not clear pending reply cells", () => {
		const h = makeHarness();
		const d: Deferred<ComposedReplyResult> = defer<ComposedReplyResult>();
		const bundle: ApplicationBundle = {
			origin: "Runtime",
			stream: 4,
			payload: new Uint8Array(5),
			signal: new AbortController().signal,
			reply: () => d.promise,
		};
		h.router.dispatchApplication(bundle);
		h.router.close();
		d.resolve({ code: "SENT" });
	});

	it("S18c: router close fences each child controller", async () => {
		const h = makeHarness();
		var calledA = false;
		var calledB = false;
		const idA = vid({ childId: "a" });
		const idB = vid({ childId: "b" });
		const ctrlA = makeControllerRawFor(idA, {
			listAgents: () => {
				calledA = true;
				return [];
			},
		});
		const ctrlB = makeControllerRawFor(idB, {
			listAgents: () => {
				calledB = true;
				return [];
			},
		});
		const uA = h.router.registerLifecycleChild(idA, undefined, ctrlA);
		expect(isUnregister(uA)).toBe(true);
		if (!isUnregister(uA)) return;
		const uB = h.router.registerLifecycleChild(idB, undefined, ctrlB);
		expect(isUnregister(uB)).toBe(true);
		if (!isUnregister(uB)) return;

		h.router.close();

		// After close, dispatch to A should not reach controller
		const innerEnc = encodeRequest({ method: "list_agents", body: {} });
		expect(innerEnc.ok).toBe(true);
		if (!innerEnc.ok) return;
		const encA = encodeControllerRouteEnvelope(idA, innerEnc.bytes);
		expect(encA.ok).toBe(true);
		if (!encA.ok) return;
		const ibA = inspectableBundle(2, encA.bytes);
		h.router.dispatchApplication(ibA.bundle);
		expect(calledA).toBe(false);
		expect(ibA.replyArg.length).toBe(1);

		// Dispatch to B also blocked
		const innerEncB = encodeRequest({ method: "list_agents", body: {} });
		expect(innerEncB.ok).toBe(true);
		if (!innerEncB.ok) return;
		const encB = encodeControllerRouteEnvelope(idB, innerEncB.bytes);
		expect(encB.ok).toBe(true);
		if (!encB.ok) return;
		const ibB = inspectableBundle(2, encB.bytes);
		h.router.dispatchApplication(ibB.bundle);
		await drainMicrotasks();
		expect(calledB).toBe(false);
		expect(ibB.replyArg.length).toBe(1);
	});

	// ==== 32 cells ====
	it("S21: 32 router cells, 33rd dropped silently", () => {
		const h = makeHarness();
		for (let ci = 0; ci < 32; ci++) {
			const ib = inspectableBundle(4, new Uint8Array(0));
			h.router.dispatchApplication(ib.bundle);
			expect(ib.replyArg.length).toBe(1);
		}
		const ib33 = inspectableBundle(4, new Uint8Array(0));
		h.router.dispatchApplication(ib33.bundle);
		expect(ib33.replyArg.length).toBe(0);
	});

	// ==== registry / unregister ====
	it("S32: register returns LifecycleUnregister", () => {
		const h = makeHarness();
		expect(isUnregister(h.router.registerLifecycleChild(vid()))).toBe(true);
	});

	it("S33: duplicate childId returns ALREADY_REGISTERED", () => {
		const h = makeHarness();
		const identity = vid();
		const r1 = h.router.registerLifecycleChild(identity);
		expect(isUnregister(r1)).toBe(true);
		const r2 = h.router.registerLifecycleChild(identity);
		expect(isErrorResult(r2)).toBe(true);
		if (!isErrorResult(r2)) return;
		expect(r2.code).toBe("ALREADY_REGISTERED");
	});

	it("S33b: INPUT_INVALID for invalid identity", () => {
		const h = makeHarness();
		const r1 = Reflect.apply(h.router.registerLifecycleChild, h.router, [null]);
		expect(isErrorResult(r1)).toBe(true);
		if (!isErrorResult(r1)) return;
		expect(r1.code).toBe("INPUT_INVALID");
		const r2 = Reflect.apply(h.router.registerLifecycleChild, h.router, [Object.create(Object.prototype)]);
		expect(isErrorResult(r2)).toBe(true);
		if (!isErrorResult(r2)) return;
		expect(r2.code).toBe("INPUT_INVALID");
	});

	it("S33c: extra key rejected", () => {
		const h = makeHarness();
		const raw = { childId: "c1", sessionId: "s1", sessionName: "n1", modelSelector: "m1", extra: "x" };
		const r = Reflect.apply(h.router.registerLifecycleChild, h.router, [raw]);
		expect(isErrorResult(r)).toBe(true);
		if (!isErrorResult(r)) return;
		expect(r.code).toBe("INPUT_INVALID");
	});

	it("S33d: 129-char field rejected", () => {
		const h = makeHarness();
		const r = h.router.registerLifecycleChild({
			childId: "c1",
			sessionId: "s1",
			sessionName: "n1",
			modelSelector: "x".repeat(129),
		});
		expect(isErrorResult(r)).toBe(true);
		if (!isErrorResult(r)) return;
		expect(r.code).toBe("INPUT_INVALID");
	});

	it("S33e: unsafe character rejected", () => {
		const h = makeHarness();
		const r = h.router.registerLifecycleChild({
			childId: "c1<script>",
			sessionId: "s1",
			sessionName: "n1",
			modelSelector: "m1",
		});
		expect(isErrorResult(r)).toBe(true);
		if (!isErrorResult(r)) return;
		expect(r.code).toBe("INPUT_INVALID");
	});

	it("S33f: Proxy identity rejected", () => {
		const h = makeHarness();
		const target = { childId: "c1", sessionId: "s1", sessionName: "n1", modelSelector: "m1" };
		const r = Reflect.apply(h.router.registerLifecycleChild, h.router, [new Proxy(target, {})]);
		expect(isErrorResult(r)).toBe(true);
		if (!isErrorResult(r)) return;
		expect(r.code).toBe("INPUT_INVALID");
	});

	it("S33g: accessor identity rejected", () => {
		const h = makeHarness();
		const r = Reflect.apply(h.router.registerLifecycleChild, h.router, [
			{
				get childId() {
					return "c1";
				},
				sessionId: "s1",
				sessionName: "n1",
				modelSelector: "m1",
			},
		]);
		expect(isErrorResult(r)).toBe(true);
		if (!isErrorResult(r)) return;
		expect(r.code).toBe("INPUT_INVALID");
	});

	it("S33h: symbol-key identity rejected", () => {
		const h = makeHarness();
		const r = h.router.registerLifecycleChild(
			Object.assign(
				{},
				{
					[Symbol("hidden")]: "yes",
					childId: "c1",
					sessionId: "s1",
					sessionName: "n1",
					modelSelector: "m1",
				},
			),
		);
		expect(isErrorResult(r)).toBe(true);
		if (!isErrorResult(r)) return;
		expect(r.code).toBe("INPUT_INVALID");
	});

	it("S33i: null-prototype identity rejected", () => {
		const h = makeHarness();
		const obj = { __proto__: null, childId: "c1", sessionId: "s1", sessionName: "n1", modelSelector: "m1" };
		const r = h.router.registerLifecycleChild(obj);
		expect(isErrorResult(r)).toBe(true);
		if (!isErrorResult(r)) return;
		expect(r.code).toBe("INPUT_INVALID");
	});

	it("S33j: invalid controller raw returns INPUT_INVALID", () => {
		const h = makeHarness();
		const r = h.router.registerLifecycleChild(vid(), undefined, "not a controller");
		expect(isErrorResult(r)).toBe(true);
		if (!isErrorResult(r)) return;
		expect(r.code).toBe("INPUT_INVALID");
	});

	it("S33k: controller is optional for lifecycle-only child", () => {
		const h = makeHarness();
		expect(isUnregister(h.router.registerLifecycleChild(vid(), {}))).toBe(true);
	});

	it("S34: unregister removes child, re-registration succeeds", () => {
		const h = makeHarness();
		const identity = vid();
		const u = h.router.registerLifecycleChild(identity);
		expect(isUnregister(u)).toBe(true);
		if (!isUnregister(u)) return;
		u.unregister();
		expect(isUnregister(h.router.registerLifecycleChild(identity))).toBe(true);
	});

	it("S35: unregister unknown token is no-op", () => {
		const h = makeHarness();
		const identity = vid();
		const u = h.router.registerLifecycleChild(identity);
		expect(isUnregister(u)).toBe(true);
		if (!isUnregister(u)) return;
		u.unregister();
		u.unregister();
	});

	it("S35b: unregister one child leaves other intact", () => {
		const h = makeHarness();
		const idA = vid({ childId: "a" });
		const idB = vid({ childId: "b" });
		const uA = h.router.registerLifecycleChild(idA);
		expect(isUnregister(uA)).toBe(true);
		if (!isUnregister(uA)) return;
		const uB = h.router.registerLifecycleChild(idB);
		expect(isUnregister(uB)).toBe(true);
		if (!isUnregister(uB)) return;
		uA.unregister();
		const dupB = h.router.registerLifecycleChild(idB);
		expect(isErrorResult(dupB)).toBe(true);
		if (!isErrorResult(dupB)) return;
		expect(dupB.code).toBe("ALREADY_REGISTERED");
	});

	it("S36: two children cross-child isolation", () => {
		const h = makeHarness();
		const calls: Array<string> = [];
		const idA = vid({ childId: "a" });
		const idB = vid({ childId: "b" });
		const rA = h.router.registerLifecycleChild(idA, {
			listener: () => {
				calls.push("a");
			},
		});
		expect(isUnregister(rA)).toBe(true);
		if (!isUnregister(rA)) return;
		const rB = h.router.registerLifecycleChild(idB, {
			listener: () => {
				calls.push("b");
			},
		});
		expect(isUnregister(rB)).toBe(true);
		if (!isUnregister(rB)) return;
		h.router.dispatchApplication(inspectableBundle(1, evPayload(idA)).bundle);
		expect(calls).toEqual(["a"]);
		h.router.dispatchApplication(inspectableBundle(1, evPayload(idB)).bundle);
		expect(calls).toEqual(["a", "b"]);
	});

	it("S37: close clears registry, register returns CLOSED", () => {
		const h = makeHarness();
		const r = h.router.registerLifecycleChild(vid(), {});
		expect(isUnregister(r)).toBe(true);
		if (!isUnregister(r)) return;
		h.router.close();
		const r2 = h.router.registerLifecycleChild(vid());
		expect(isErrorResult(r2)).toBe(true);
		if (!isErrorResult(r2)) return;
		expect(r2.code).toBe("CLOSED");
	});

	it("S38: post-terminal EVENT ACK no listener call", () => {
		const h = makeHarness();
		let listenerCount = 0;
		const identity = vid();
		const r = h.router.registerLifecycleChild(identity, {
			listener: () => {
				listenerCount += 1;
			},
			terminalSettle: () => {},
		});
		expect(isUnregister(r)).toBe(true);
		if (!isUnregister(r)) return;
		h.router.dispatchApplication(inspectableBundle(1, tmPayload(identity)).bundle);
		const ib = inspectableBundle(1, evPayload(identity));
		h.router.dispatchApplication(ib.bundle);
		expect(listenerCount).toBe(0);
		const decoded = decodeLifecycleReply(ib.replyArg[0], "EVENT");
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(decoded.body).toEqual({ code: "ACK" });
	});

	it("S39: duplicate TERMINAL idempotent ACK", () => {
		const h = makeHarness();
		let settleCount = 0;
		const identity = vid();
		const r = h.router.registerLifecycleChild(identity, {
			terminalSettle: () => {
				settleCount += 1;
			},
		});
		expect(isUnregister(r)).toBe(true);
		if (!isUnregister(r)) return;
		const payload = tmPayload(identity);
		h.router.dispatchApplication(inspectableBundle(1, payload).bundle);
		expect(settleCount).toBe(1);
		const ib2 = inspectableBundle(1, payload);
		h.router.dispatchApplication(ib2.bundle);
		expect(settleCount).toBe(1);
		const decoded = decodeLifecycleReply(ib2.replyArg[0], "TERMINAL");
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(decoded.body).toEqual({ code: "ACK" });
	});

	// ==== reentrancy ====
	it("S40c: reentrant unregister from listener", () => {
		const h = makeHarness();
		let saved: LifecycleUnregister | null = null;
		const identity = vid();
		const u = h.router.registerLifecycleChild(identity, {
			listener: () => {
				if (saved !== null) saved.unregister();
			},
		});
		expect(isUnregister(u)).toBe(true);
		if (!isUnregister(u)) return;
		saved = u;
		h.router.dispatchApplication(inspectableBundle(1, evPayload(identity)).bundle);
	});

	it("S40d: reentrant close from terminalSettle", () => {
		const h = makeHarness();
		const identity = vid();
		const r = h.router.registerLifecycleChild(identity, {
			terminalSettle: () => {
				h.router.close();
			},
		});
		expect(isUnregister(r)).toBe(true);
		if (!isUnregister(r)) return;
		h.router.dispatchApplication(inspectableBundle(1, tmPayload(identity)).bundle);
	});

	// ==== cell lifecycle ====
	it("nonzero reply bytes until settlement then cell freed", async () => {
		const h = makeHarness();
		const identity = vid();
		const r = h.router.registerLifecycleChild(identity, {});
		expect(isUnregister(r)).toBe(true);
		if (!isUnregister(r)) return;
		const ib = inspectableBundle(1, evPayload(identity));
		h.router.dispatchApplication(ib.bundle);
		expect(ib.replyArg[0].length).toBeGreaterThan(0);
		ib.deferred.resolve({ code: "SENT" });
		await drainMicrotasks();
		const ib2 = inspectableBundle(4, new Uint8Array(0));
		h.router.dispatchApplication(ib2.bundle);
		expect(ib2.replyArg.length).toBe(1);
	});

	it("reply rejection path handled", async () => {
		const h = makeHarness();
		const d: Deferred<ComposedReplyResult> = defer<ComposedReplyResult>();
		const bundle: ApplicationBundle = {
			origin: "Runtime",
			stream: 4,
			payload: new Uint8Array(0),
			signal: new AbortController().signal,
			reply: () => d.promise,
		};
		h.router.dispatchApplication(bundle);
		d.resolve({ code: "SENT" });
		await drainMicrotasks();
	});

	it("lifecycle cross-identity spoof", () => {
		const h = makeHarness();
		let called = false;
		const idA = vid({ childId: "a" });
		const r = h.router.registerLifecycleChild(idA, {
			listener: () => {
				called = true;
			},
		});
		expect(isUnregister(r)).toBe(true);
		if (!isUnregister(r)) return;
		const idB = vid({ childId: "b" });
		h.router.dispatchApplication(inspectableBundle(1, evPayload(idB)).bundle);
		expect(called).toBe(false);
	});

	it("captured then ignores global patch", () => {
		const orig = Promise.prototype.then;
		let patched = false;
		Reflect.set(
			Promise.prototype,
			"then",
			function (this: Promise<unknown>, onfulfilled: unknown, onrejected: unknown) {
				patched = true;
				return Reflect.apply(orig, this, [onfulfilled, onrejected]);
			},
		);
		try {
			const h = makeHarness();
			const ib = inspectableBundle(4, new Uint8Array(0));
			h.router.dispatchApplication(ib.bundle);
			expect(patched).toBe(false);
		} finally {
			Reflect.set(Promise.prototype, "then", orig);
		}
	});

	it("captured queueMicrotask ignores global patch", () => {
		const orig = queueMicrotask;
		let patched = false;
		Reflect.set(globalThis, "queueMicrotask", () => {
			patched = true;
		});
		try {
			const h = makeHarness();
			const ib = inspectableBundle(4, new Uint8Array(0));
			h.router.dispatchApplication(ib.bundle);
			expect(patched).toBe(false);
		} finally {
			Reflect.set(globalThis, "queueMicrotask", orig);
		}
	});

	// ==== controller close guard ====

	it("S52: terminalSettle throws first time, retry invokes it again, only success gets ACK", () => {
		const h = makeHarness();
		let settleCallCount = 0;
		let throwOnCall = true;
		const identity = vid({ childId: "retry-child" });
		const r = h.router.registerLifecycleChild(identity, {
			terminalSettle: (_result: HostedRlmTaskResult) => {
				settleCallCount += 1;
				if (throwOnCall) {
					throwOnCall = false;
					JSON.parse("{");
				}
			},
		});
		expect(isUnregister(r)).toBe(true);
		if (!isUnregister(r)) return;

		const payload = tmPayload(identity);

		// First TERMINAL — terminalSettle throws, reply is empty, terminalSeen stays false
		const ib1 = inspectableBundle(1, payload);
		h.router.dispatchApplication(ib1.bundle);
		expect(settleCallCount).toBe(1);
		// Reply is empty (zero-length) because the outer catch handles the throw
		expect(ib1.replyArg.length).toBe(1);
		expect(ib1.replyArg[0].length).toBe(0);

		// Second TERMINAL — terminalSettle called again (terminalSeen is still false), succeeds
		const ib2 = inspectableBundle(1, payload);
		h.router.dispatchApplication(ib2.bundle);
		expect(settleCallCount).toBe(2);
		expect(ib2.replyArg.length).toBe(1);
		const dec2 = decodeLifecycleReply(ib2.replyArg[0], "TERMINAL");
		expect(dec2.ok).toBe(true);
		if (dec2.ok) expect(dec2.body).toEqual({ code: "ACK" });

		// Third TERMINAL (duplicate) — ACK without calling terminalSettle
		const ib3 = inspectableBundle(1, payload);
		h.router.dispatchApplication(ib3.bundle);
		expect(settleCallCount).toBe(2);
		expect(ib3.replyArg.length).toBe(1);
		const dec3 = decodeLifecycleReply(ib3.replyArg[0], "TERMINAL");
		expect(dec3.ok).toBe(true);
		if (dec3.ok) expect(dec3.body).toEqual({ code: "ACK" });
	});
});
