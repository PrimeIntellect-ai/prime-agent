import { expect, test } from "bun:test";

test("expect.poll rejects unknown matchers instead of passing silently", async () => {
	const poll = (
		expect as unknown as {
			poll(
				actual: () => unknown,
				options: { timeout: number },
			): Record<string, (...args: unknown[]) => Promise<unknown>>;
		}
	).poll;
	const unsupported = poll(() => true, { timeout: 10 });
	await expect(unsupported.toBee!(true)).rejects.toThrow("expect.poll does not support matcher: toBee");
});
