import { describe, expect, it } from "vitest";
import {
	assertHostRequestHandler,
	createHostRequestHandler,
	type HostRequestContext,
} from "../src/core/kernel/index.js";

describe("staged host-request handler authority", () => {
	it("rejects unary factory inputs before they run", () => {
		let calls = 0;
		const unary = async (_payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
			calls += 1;
			return {};
		};

		expect(() => {
			// @ts-expect-error Staged handlers must accept dispatcher context as their second argument.
			createHostRequestHandler(unary);
		}).toThrow("host request handlers must accept payload and context");
		expect(calls).toBe(0);
	});

	it("rejects missing or invalid context before a genuine handler runs", async () => {
		let calls = 0;
		const handler = createHostRequestHandler(async (_payload, _context) => {
			calls += 1;
			return {};
		});

		assertHostRequestHandler(handler);
		// @ts-expect-error A staged handler cannot be invoked without dispatcher context.
		await expect(handler({})).rejects.toThrow("host request context is invalid");
		await expect(handler({}, {} as HostRequestContext)).rejects.toThrow("host request context is invalid");
		expect(calls).toBe(0);
	});

	it("rejects copied-symbol forgeries through WeakSet provenance before they run", () => {
		const genuine = createHostRequestHandler(async (_payload, _context) => ({}));
		let calls = 0;
		const forged = async (): Promise<Record<string, unknown>> => {
			calls += 1;
			return {};
		};
		const brand = Object.getOwnPropertySymbols(genuine)[0];
		Object.defineProperty(forged, brand, Object.getOwnPropertyDescriptor(genuine, brand)!);

		expect(() => assertHostRequestHandler(forged)).toThrow(
			"host request handler is not a dispatcher-created capability",
		);
		expect(calls).toBe(0);
	});
});
