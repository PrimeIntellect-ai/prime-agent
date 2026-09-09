import { describe, expect, it } from "bun:test";
import type {
	CreateHostedRlmSubagentRuntimeOptions,
	HostedRlmAllocationSettlement,
	SubagentRuntimeHost,
} from "../src/core/rlm-runtime.js";
import {
	bindDaemonHostedRuntime,
	type DaemonHostedRuntimeActivation,
} from "../src/modes/daemon/daemon-hosted-runtime-binding.js";

function localHost(dispose: () => Promise<void>): SubagentRuntimeHost {
	return {
		createRlmSubagentRuntime: (): Promise<never> => Promise.reject(new Error("unused")),
		deleteRlmSubagentRuntime: (): Promise<void> => Promise.resolve(),
		disposeRlmSubagentRuntimes: dispose,
	};
}

function hostedOptions(): CreateHostedRlmSubagentRuntimeOptions {
	return Object.freeze({
		sandbox: true,
		id: "child",
		sessionId: "session",
		activeSessionId: "active",
		parentSessionId: "parent-session",
		parentActiveSessionId: "parent-active",
		sessionName: "child-name",
		modelSelector: "provider/model",
		thinkingLevel: "medium",
		serviceTier: "default",
		spawnedByRequestId: undefined,
		scopedModels: Object.freeze([]),
		activeToolNames: Object.freeze([]),
		allowedToolNames: undefined,
		includeGoals: true,
		includeCompactSkill: true,
		rlmDepth: 1,
		rlmMaxDepth: 4,
		rlmParentNodeId: "child",
	});
}

describe("daemon hosted runtime binding", () => {
	it("leaves the local host byte-for-byte unextended when activation is absent", () => {
		let effects = 0;
		const host = localHost((): Promise<void> => {
			effects += 1;
			return Promise.resolve();
		});
		const keys = Object.keys(host);
		const bound = bindDaemonHostedRuntime(host, undefined, Object.freeze({ parent: true }));
		expect(bound).toBe(host);
		expect(Object.keys(bound)).toEqual(keys);
		expect(bound.createHostedRlmSubagentRuntime).toBeUndefined();
		expect(bound.releaseHostedRlmSubagentRuntime).toBeUndefined();
		expect(bound.deleteHostedRlmSubagentRuntime).toBeUndefined();
		expect(effects).toBe(0);
	});

	it("rejects malformed activation records without extending the host", () => {
		let getterEffects = 0;
		const create = (): void => {};
		const release = (): Promise<void> => Promise.resolve();
		const remove = (): Promise<void> => Promise.resolve();
		const dispose = (): Promise<void> => Promise.resolve();
		const notFrozen: DaemonHostedRuntimeActivation = {
			createHostedRlmSubagentRuntime: create,
			releaseHostedRlmSubagentRuntime: release,
			deleteHostedRlmSubagentRuntime: remove,
			disposeHostedRlmSubagentRuntimes: dispose,
		};
		const getterRecord: DaemonHostedRuntimeActivation = Object.freeze({
			get createHostedRlmSubagentRuntime() {
				getterEffects += 1;
				return create;
			},
			releaseHostedRlmSubagentRuntime: release,
			deleteHostedRlmSubagentRuntime: remove,
			disposeHostedRlmSubagentRuntimes: dispose,
		});
		const valid: DaemonHostedRuntimeActivation = Object.freeze({
			createHostedRlmSubagentRuntime: create,
			releaseHostedRlmSubagentRuntime: release,
			deleteHostedRlmSubagentRuntime: remove,
			disposeHostedRlmSubagentRuntimes: dispose,
		});
		const wrongOrder: DaemonHostedRuntimeActivation = Object.freeze({
			disposeHostedRlmSubagentRuntimes: dispose,
			createHostedRlmSubagentRuntime: create,
			releaseHostedRlmSubagentRuntime: release,
			deleteHostedRlmSubagentRuntime: remove,
		});
		const proxiedMethod: DaemonHostedRuntimeActivation = Object.freeze({
			createHostedRlmSubagentRuntime: new Proxy(create, {
				apply: (): unknown => {
					getterEffects += 1;
					return undefined;
				},
			}),
			releaseHostedRlmSubagentRuntime: release,
			deleteHostedRlmSubagentRuntime: remove,
			disposeHostedRlmSubagentRuntimes: dispose,
		});
		const proxy = new Proxy(valid, {
			get: (): unknown => {
				getterEffects += 1;
				return create;
			},
		});
		for (const malformed of [notFrozen, getterRecord, wrongOrder, proxiedMethod, proxy]) {
			const host = localHost((): Promise<void> => Promise.resolve());
			const keys = Object.keys(host);
			expect(bindDaemonHostedRuntime(host, malformed, Object.freeze({ parent: true }))).toBe(host);
			expect(Object.keys(host)).toEqual(keys);
			expect(host.createHostedRlmSubagentRuntime).toBeUndefined();
			expect(host.deleteHostedRlmSubagentRuntime).toBeUndefined();
		}
		expect(getterEffects).toBe(0);
	});

	it("captures hosted receivers and composes one parent-scoped dispose", async (): Promise<void> => {
		const calls: string[] = [];
		const receivers: object[] = [];
		const settlements: unknown[] = [];
		const parentRuntime = Object.freeze({ parent: true });
		const runtime = Object.freeze({ runtime: true });
		const activation: DaemonHostedRuntimeActivation = Object.freeze({
			createHostedRlmSubagentRuntime(
				parent: unknown,
				_options: CreateHostedRlmSubagentRuntimeOptions,
				settle: HostedRlmAllocationSettlement,
			): void {
				calls.push(parent === parentRuntime ? "create" : "create-wrong-parent");
				receivers.push(this);
				settle(Object.freeze({ ok: false }));
			},
			releaseHostedRlmSubagentRuntime(
				parent: unknown,
				_runtime: unknown,
				_options: CreateHostedRlmSubagentRuntimeOptions,
				status: "done" | "error" | "cancelled",
			): Promise<void> {
				calls.push(parent === parentRuntime ? `release:${status}` : "release-wrong-parent");
				receivers.push(this);
				return Promise.resolve();
			},
			deleteHostedRlmSubagentRuntime(parent: unknown, childId: string, _runtime?: unknown): Promise<void> {
				calls.push(parent === parentRuntime ? `delete:${childId}` : "delete-wrong-parent");
				receivers.push(this);
				return Promise.resolve();
			},
			disposeHostedRlmSubagentRuntimes(parent: unknown): Promise<void> {
				calls.push(parent === parentRuntime ? "dispose-hosted" : "dispose-wrong-parent");
				receivers.push(this);
				return Promise.resolve();
			},
		});
		const host = localHost((): Promise<void> => {
			calls.push("dispose-local");
			return Promise.resolve();
		});
		const bound = bindDaemonHostedRuntime(host, activation, parentRuntime);
		const create = bound.createHostedRlmSubagentRuntime;
		const release = bound.releaseHostedRlmSubagentRuntime;
		const remove = bound.deleteHostedRlmSubagentRuntime;
		const dispose = bound.disposeRlmSubagentRuntimes;
		expect(create).toBeDefined();
		expect(release).toBeDefined();
		expect(remove).toBeDefined();
		expect(dispose).toBeDefined();
		if (create === undefined || release === undefined || remove === undefined || dispose === undefined) return;
		create(hostedOptions(), (value: unknown): void => {
			settlements.push(value);
		});
		await release(runtime, hostedOptions(), "cancelled");
		await remove("child", runtime);
		const firstDispose = Promise.resolve(dispose());
		const secondDispose = Promise.resolve(dispose());
		expect(firstDispose).toBe(secondDispose);
		await firstDispose;
		expect(settlements).toEqual([{ ok: false }]);
		expect(calls).toEqual(["create", "release:cancelled", "delete:child", "dispose-local", "dispose-hosted"]);
		expect(receivers).toEqual([activation, activation, activation, activation]);
	});

	it("rejects a hosted dispose capability that lies about returning a Promise", async (): Promise<void> => {
		const activation: DaemonHostedRuntimeActivation = {
			createHostedRlmSubagentRuntime(): void {},
			releaseHostedRlmSubagentRuntime(): Promise<void> {
				return Promise.resolve();
			},
			deleteHostedRlmSubagentRuntime(): Promise<void> {
				return Promise.resolve();
			},
			disposeHostedRlmSubagentRuntimes(): Promise<void> {
				return Promise.resolve();
			},
		};
		Object.defineProperty(activation, "disposeHostedRlmSubagentRuntimes", {
			value: (): unknown => undefined,
			writable: false,
			enumerable: true,
			configurable: false,
		});
		Object.freeze(activation);
		const host = bindDaemonHostedRuntime(
			localHost((): Promise<void> => Promise.resolve()),
			activation,
			Object.freeze({ parent: true }),
		);
		const dispose = host.disposeRlmSubagentRuntimes;
		expect(dispose).toBeDefined();
		if (dispose === undefined) return;
		await expect(Promise.resolve(dispose())).rejects.toThrow("Hosted runtime disposal did not return a Promise");
	});

	it("attempts hosted dispose after local failure and preserves the first error", async (): Promise<void> => {
		const localError = new Error("local cleanup failed");
		let hostedDisposeCalls = 0;
		const activation: DaemonHostedRuntimeActivation = Object.freeze({
			createHostedRlmSubagentRuntime(): void {},
			releaseHostedRlmSubagentRuntime(): Promise<void> {
				return Promise.resolve();
			},
			deleteHostedRlmSubagentRuntime(): Promise<void> {
				return Promise.resolve();
			},
			disposeHostedRlmSubagentRuntimes(): Promise<void> {
				hostedDisposeCalls += 1;
				return Promise.resolve();
			},
		});
		const host = bindDaemonHostedRuntime(
			localHost((): Promise<void> => Promise.reject(localError)),
			activation,
			Object.freeze({ parent: true }),
		);
		const dispose = host.disposeRlmSubagentRuntimes;
		expect(dispose).toBeDefined();
		if (dispose === undefined) return;
		await expect(Promise.resolve(dispose())).rejects.toBe(localError);
		expect(hostedDisposeCalls).toBe(1);
	});
});
