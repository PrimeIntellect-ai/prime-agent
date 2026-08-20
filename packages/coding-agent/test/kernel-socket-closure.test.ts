import { describe, expect, it } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

type Translator = {
	translateSocketClosure<T>(this: unknown, operation: Promise<T>): Promise<T>;
};

function makeManager(state: string, stderr = ""): KernelManager {
	const manager = Object.create(KernelManager.prototype) as KernelManager;
	Object.assign(manager, { state, kernelStderr: stderr, options: {} });
	return manager;
}

const translate = (KernelManager.prototype as unknown as Translator).translateSocketClosure;

describe("KernelManager zmq closure translation", () => {
	it("passes successful operations through untouched", async () => {
		await expect(translate.call(makeManager("running"), Promise.resolve("frames"))).resolves.toBe("frames");
	});

	it("rethrows unrelated errors verbatim", async () => {
		await expect(translate.call(makeManager("running"), Promise.reject(new Error("boom")))).rejects.toThrow("boom");
	});

	it("translates the raw libzmq EAGAIN text during startup into a retriable kernel error", async () => {
		const rejection = Promise.reject(new Error("Operation was not possible or timed out"));
		await expect(translate.call(makeManager("starting", "ImportError: mcp"), rejection)).rejects.toThrow(
			/IPython kernel channel closed while starting up \(retriable\)[\s\S]*ImportError: mcp/,
		);
	});

	it("translates a closed-socket rejection outside startup", async () => {
		const rejection = Promise.reject(new Error("Socket is closed"));
		await expect(translate.call(makeManager("running"), rejection)).rejects.toThrow(
			/IPython kernel channel closed while communicating \(retriable\)/,
		);
	});
});
