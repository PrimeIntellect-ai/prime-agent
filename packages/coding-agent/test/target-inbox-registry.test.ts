import { describe, expect, it } from "vitest";
import {
	createTargetInboxRegistry,
	type TargetInboxRegistry,
	type TargetInboxRegistryResult,
} from "../src/modes/daemon/target-inbox-registry.js";

const IDENTITY = Object.freeze({ hostId: "home", generation: "gen-1", sessionId: "session-1" });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolveValue: (value: T) => void = () => {
		throw new Error("deferred not initialized");
	};
	const promise = new Promise<T>((resolve) => {
		resolveValue = resolve;
	});
	return { promise, resolve: resolveValue };
}

function expectSuccess<T>(result: TargetInboxRegistryResult<T>): T {
	if (!result.ok) throw new Error(`unexpected registry error: ${result.error.code}`);
	return result.value;
}

function success(value: unknown = undefined): Readonly<{ ok: true; value: unknown }> {
	return Object.freeze({ ok: true as const, value });
}

async function createHarness(options?: { current?: "current" | "stale"; entryCloseStatus?: "closed" | "error" }) {
	const order: string[] = [];
	let createCount = 0;
	let entryCloseCount = 0;
	const entry = {
		receive: async () => success(),
		send: async () => success(),
		dispatchPending: async () => success(),
		close: async () => {
			entryCloseCount += 1;
			order.push("entry");
			return Object.freeze({ status: options?.entryCloseStatus ?? "closed" });
		},
	};
	const catalog = {
		isCurrent: async () => Object.freeze({ status: options?.current ?? "current" }),
		close: async () => {
			order.push("catalog");
			return Object.freeze({ status: "closed" as const });
		},
	};
	const factory = {
		create: async () => {
			createCount += 1;
			return Object.freeze({ ok: true as const, value: entry });
		},
		close: async () => {
			order.push("factory");
			return Object.freeze({ status: "closed" as const });
		},
	};
	const created = await createTargetInboxRegistry({ catalog, factory });
	return {
		registry: expectSuccess(created),
		order,
		counts: () => ({ createCount, entryCloseCount }),
	};
}

describe("target inbox registry", () => {
	it("creates once per exact identity and returns fresh frozen non-owning views", async () => {
		const harness = await createHarness();
		const first = expectSuccess(await harness.registry.get(IDENTITY));
		const second = expectSuccess(await harness.registry.get({ ...IDENTITY }));
		expect(harness.counts().createCount).toBe(1);
		expect(first).not.toBe(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.getOwnPropertyNames(first).sort()).toEqual(["dispatchPending", "receive", "send"]);
		expect(await first.receive({ frame: "one" })).toEqual({ ok: true, value: undefined });
		expect(await first.send({ frame: "two" })).toEqual({ ok: true, value: undefined });
		expect(await first.dispatchPending()).toEqual({ ok: true, value: undefined });
	});

	it("uses collision-free nested identities", async () => {
		const harness = await createHarness();
		expect((await harness.registry.get({ hostId: "ab", generation: "c", sessionId: "d" })).ok).toBe(true);
		expect((await harness.registry.get({ hostId: "a", generation: "bc", sessionId: "d" })).ok).toBe(true);
		expect((await harness.registry.get({ hostId: "a", generation: "b", sessionId: "cd" })).ok).toBe(true);
		expect(harness.counts().createCount).toBe(3);
		const invalid = await harness.registry.get({ hostId: "a\0b", generation: "c", sessionId: "d" });
		expect(invalid).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("checks current identity before factory creation", async () => {
		const harness = await createHarness({ current: "stale" });
		const result = await harness.registry.get(IDENTITY);
		expect(result).toEqual({ ok: false, error: { code: "STALE" } });
		expect(harness.counts().createCount).toBe(0);
	});

	it("serializes entry operations FIFO", async () => {
		const firstGate = deferred<Readonly<{ ok: true; value: undefined }>>();
		const calls: string[] = [];
		const entry = {
			receive: () => {
				calls.push("receive-start");
				return firstGate.promise;
			},
			send: async () => {
				calls.push("send");
				return success();
			},
			dispatchPending: async () => success(),
			close: async () => Object.freeze({ status: "closed" as const }),
		};
		const created = await createTargetInboxRegistry({
			catalog: {
				isCurrent: async () => ({ status: "current" as const }),
				close: async () => ({ status: "closed" as const }),
			},
			factory: {
				create: async () => ({ ok: true as const, value: entry }),
				close: async () => ({ status: "closed" as const }),
			},
		});
		const registry = expectSuccess(created);
		const view = expectSuccess(await registry.get(IDENTITY));
		const first = view.receive({});
		const second = view.send({});
		await Promise.resolve();
		expect(calls).toEqual(["receive-start"]);
		firstGate.resolve(Object.freeze({ ok: true as const, value: undefined }));
		expect((await first).ok).toBe(true);
		expect((await second).ok).toBe(true);
		expect(calls).toEqual(["receive-start", "send"]);
	});

	it("rejects synchronous injected reentry without deadlock", async () => {
		let registry: TargetInboxRegistry | null = null;
		let nested: Promise<TargetInboxRegistryResult<unknown>> | null = null;
		const entry = {
			receive: async () => {
				nested = registry?.get(IDENTITY) ?? null;
				return success();
			},
			send: async () => success(),
			dispatchPending: async () => success(),
			close: async () => ({ status: "closed" as const }),
		};
		const created = await createTargetInboxRegistry({
			catalog: {
				isCurrent: async () => ({ status: "current" as const }),
				close: async () => ({ status: "closed" as const }),
			},
			factory: {
				create: async () => ({ ok: true as const, value: entry }),
				close: async () => ({ status: "closed" as const }),
			},
		});
		registry = expectSuccess(created);
		const view = expectSuccess(await registry.get(IDENTITY));
		expect((await view.receive({})).ok).toBe(true);
		if (!nested) throw new Error("missing nested call");
		expect(await nested).toEqual({ ok: false, error: { code: "REENTRY" } });
	});

	it("keeps a permanent tombstone and closes an entry once", async () => {
		const harness = await createHarness();
		await harness.registry.get(IDENTITY);
		expect(await harness.registry.closeIdentity(IDENTITY)).toEqual({ ok: true, value: undefined });
		expect(await harness.registry.closeIdentity(IDENTITY)).toEqual({ ok: true, value: undefined });
		expect(await harness.registry.get(IDENTITY)).toEqual({ ok: false, error: { code: "STALE" } });
		expect(harness.counts().entryCloseCount).toBe(1);
	});

	it("drains entry work admitted before closeIdentity", async () => {
		const gate = deferred<Readonly<{ ok: true; value: undefined }>>();
		const order: string[] = [];
		const entry = {
			receive: () => gate.promise,
			send: async () => success(),
			dispatchPending: async () => success(),
			close: async () => {
				order.push("close");
				return { status: "closed" as const };
			},
		};
		const created = await createTargetInboxRegistry({
			catalog: {
				isCurrent: async () => ({ status: "current" as const }),
				close: async () => ({ status: "closed" as const }),
			},
			factory: {
				create: async () => ({ ok: true as const, value: entry }),
				close: async () => ({ status: "closed" as const }),
			},
		});
		const registry = expectSuccess(created);
		const view = expectSuccess(await registry.get(IDENTITY));
		const admitted = view.receive({});
		const closing = registry.closeIdentity(IDENTITY);
		expect(await view.send({})).toEqual({ ok: false, error: { code: "CLOSED" } });
		expect(order).toEqual([]);
		gate.resolve(Object.freeze({ ok: true as const, value: undefined }));
		expect((await admitted).ok).toBe(true);
		expect((await closing).ok).toBe(true);
		expect(order).toEqual(["close"]);
	});

	it("rejects entry calls after closeIdentity admission while an earlier get finishes", async () => {
		const gate = deferred<Readonly<{ status: "current" }>>();
		const entry = {
			receive: async () => success(),
			send: async () => success(),
			dispatchPending: async () => success(),
			close: async () => ({ status: "closed" as const }),
		};
		const registry = expectSuccess(
			await createTargetInboxRegistry({
				catalog: { isCurrent: () => gate.promise, close: async () => ({ status: "closed" as const }) },
				factory: {
					create: async () => ({ ok: true as const, value: entry }),
					close: async () => ({ status: "closed" as const }),
				},
			}),
		);
		const admittedGet = registry.get(IDENTITY);
		const followup = admittedGet.then(async (result) => await expectSuccess(result).send({}));
		const closing = registry.closeIdentity(IDENTITY);
		gate.resolve(Object.freeze({ status: "current" as const }));
		expect(await followup).toEqual({ ok: false, error: { code: "CLOSED" } });
		expect((await closing).ok).toBe(true);
	});

	it("drains globally admitted get before close and rejects later calls", async () => {
		const gate = deferred<Readonly<{ status: "current" }>>();
		const order: string[] = [];
		const entry = {
			receive: async () => success(),
			send: async () => success(),
			dispatchPending: async () => success(),
			close: async () => {
				order.push("entry");
				return { status: "closed" as const };
			},
		};
		const created = await createTargetInboxRegistry({
			catalog: {
				isCurrent: () => gate.promise,
				close: async () => {
					order.push("catalog");
					return { status: "closed" as const };
				},
			},
			factory: {
				create: async () => ({ ok: true as const, value: entry }),
				close: async () => {
					order.push("factory");
					return { status: "closed" as const };
				},
			},
		});
		const registry = expectSuccess(created);
		const admitted = registry.get(IDENTITY);
		const closing = registry.close();
		expect(await registry.get({ ...IDENTITY, sessionId: "later" })).toEqual({ ok: false, error: { code: "CLOSED" } });
		gate.resolve(Object.freeze({ status: "current" as const }));
		expect((await admitted).ok).toBe(true);
		expect((await closing).ok).toBe(true);
		expect(order).toEqual(["entry", "factory", "catalog"]);
	});

	it("closes entries in true reverse creation order then factory and catalog", async () => {
		const order: string[] = [];
		const catalog = {
			isCurrent: async () => ({ status: "current" as const }),
			close: async () => {
				order.push("catalog");
				return { status: "closed" as const };
			},
		};
		const factory = {
			create: async (raw: unknown) => {
				if (typeof raw !== "object" || raw === null) throw new Error("bad identity");
				const name = Object.getOwnPropertyDescriptor(raw, "sessionId")?.value;
				return {
					ok: true as const,
					value: {
						receive: async () => success(),
						send: async () => success(),
						dispatchPending: async () => success(),
						close: async () => {
							order.push(String(name));
							return { status: "closed" as const };
						},
					},
				};
			},
			close: async () => {
				order.push("factory");
				return { status: "closed" as const };
			},
		};
		const registry = expectSuccess(await createTargetInboxRegistry({ catalog, factory }));
		await registry.get({ ...IDENTITY, sessionId: "one" });
		await registry.get({ ...IDENTITY, sessionId: "two" });
		expect((await registry.close()).ok).toBe(true);
		expect(order).toEqual(["two", "one", "factory", "catalog"]);
	});

	it("shares close and lets cleanup uncertainty dominate", async () => {
		const harness = await createHarness({ entryCloseStatus: "error" });
		await harness.registry.get(IDENTITY);
		const first = harness.registry.close();
		const second = harness.registry.close();
		expect(first).toBe(second);
		expect(await first).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
		expect(harness.counts().entryCloseCount).toBe(1);
	});

	it("preliminary-closes catalog and factory on malformed outer input", async () => {
		const order: string[] = [];
		const catalog = {
			isCurrent: async () => ({ status: "current" as const }),
			close: async () => {
				order.push("catalog");
				return { status: "closed" as const };
			},
		};
		const factory = {
			create: async () => ({ ok: false as const, error: { code: "x" } }),
			close: async () => {
				order.push("factory");
				return { status: "closed" as const };
			},
		};
		const result = await createTargetInboxRegistry({ catalog, factory, extra: true });
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(order).toEqual(["factory", "catalog"]);
	});

	it("rejects aliased owners and closes the alias once", async () => {
		let closes = 0;
		const alias = {
			isCurrent: async () => ({ status: "current" as const }),
			create: async () => ({ ok: false as const, error: { code: "x" } }),
			close: async () => {
				closes += 1;
				return { status: "closed" as const };
			},
		};
		const result = await createTargetInboxRegistry({ catalog: alias, factory: alias });
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(closes).toBe(1);
	});

	it("preliminary-closes malformed created entries", async () => {
		let entryCloses = 0;
		const candidate = {
			receive: async () => success(),
			send: async () => success(),
			dispatchPending: async () => success(),
			close: async () => {
				entryCloses += 1;
				return { status: "closed" as const };
			},
		};
		const registry = expectSuccess(
			await createTargetInboxRegistry({
				catalog: {
					isCurrent: async () => ({ status: "current" as const }),
					close: async () => ({ status: "closed" as const }),
				},
				factory: {
					create: async () => ({ ok: true as const, value: candidate, extra: true }),
					close: async () => ({ status: "closed" as const }),
				},
			}),
		);
		expect(await registry.get(IDENTITY)).toEqual({ ok: false, error: { code: "UNCERTAIN" } });
		expect(entryCloses).toBe(1);
	});

	it("lets malformed-entry cleanup uncertainty dominate", async () => {
		const candidate = {
			receive: async () => success(),
			send: async () => success(),
			dispatchPending: async () => success(),
			close: async () => ({ status: "error" as const }),
		};
		const registry = expectSuccess(
			await createTargetInboxRegistry({
				catalog: {
					isCurrent: async () => ({ status: "current" as const }),
					close: async () => ({ status: "closed" as const }),
				},
				factory: {
					create: async () => ({ ok: true as const, value: candidate, extra: true }),
					close: async () => ({ status: "closed" as const }),
				},
			}),
		);
		expect(await registry.get(IDENTITY)).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
	});

	it("rejects non-native Promise results", async () => {
		const catalog = {
			// biome-ignore lint/suspicious/noThenProperty: explicitly exercise thenable rejection
			isCurrent: () => ({ then: () => undefined }),
			close: async () => ({ status: "closed" as const }),
		};
		const factory = {
			create: async () => ({ ok: false as const, error: { code: "x" } }),
			close: async () => ({ status: "closed" as const }),
		};
		const registry = expectSuccess(await createTargetInboxRegistry({ catalog, factory }));
		expect(await registry.get(IDENTITY)).toEqual({ ok: false, error: { code: "UNCERTAIN" } });
	});

	it("rejects hostile identity descriptors without calling the catalog", async () => {
		let calls = 0;
		const registry = expectSuccess(
			await createTargetInboxRegistry({
				catalog: {
					isCurrent: async () => {
						calls += 1;
						return { status: "current" as const };
					},
					close: async () => ({ status: "closed" as const }),
				},
				factory: {
					create: async () => ({ ok: false as const, error: { code: "x" } }),
					close: async () => ({ status: "closed" as const }),
				},
			}),
		);
		const hostile = Object.create(null);
		Object.defineProperty(hostile, "hostId", { get: () => "home", enumerable: true });
		Object.defineProperty(hostile, "generation", { value: "gen-1", enumerable: true });
		Object.defineProperty(hostile, "sessionId", { value: "session-1", enumerable: true });
		expect(await registry.get(hostile)).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(await registry.get(new Proxy({ ...IDENTITY }, {}))).toEqual({
			ok: false,
			error: { code: "INVALID_ARGUMENT" },
		});
		expect(calls).toBe(0);
	});
	it("returns CLOSE_UNCERTAIN when factory close fails during registry close", async () => {
		const order: string[] = [];
		const entry = {
			receive: async () => success(),
			send: async () => success(),
			dispatchPending: async () => success(),
			close: async () => {
				order.push("entry");
				return Object.freeze({ status: "closed" });
			},
		};
		const registry = expectSuccess(
			await createTargetInboxRegistry({
				catalog: {
					isCurrent: async () => Object.freeze({ status: "current" }),
					close: async () => {
						order.push("catalog");
						return Object.freeze({ status: "closed" });
					},
				},
				factory: {
					create: async () => Object.freeze({ ok: true, value: entry }),
					close: async () => {
						order.push("factory");
						return Object.freeze({ status: "error" });
					},
				},
			}),
		);
		await registry.get(IDENTITY);
		const result = await registry.close();
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
		expect(order).toEqual(["entry", "factory", "catalog"]);
	});

	it("returns CLOSE_UNCERTAIN when catalog close fails during registry close", async () => {
		const order: string[] = [];
		const entry = {
			receive: async () => success(),
			send: async () => success(),
			dispatchPending: async () => success(),
			close: async () => {
				order.push("entry");
				return Object.freeze({ status: "closed" });
			},
		};
		const registry = expectSuccess(
			await createTargetInboxRegistry({
				catalog: {
					isCurrent: async () => Object.freeze({ status: "current" }),
					close: async () => {
						order.push("catalog");
						return Object.freeze({ status: "error" });
					},
				},
				factory: {
					create: async () => Object.freeze({ ok: true, value: entry }),
					close: async () => {
						order.push("factory");
						return Object.freeze({ status: "closed" });
					},
				},
			}),
		);
		await registry.get(IDENTITY);
		const result = await registry.close();
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
		expect(order).toEqual(["entry", "factory", "catalog"]);
	});
});
