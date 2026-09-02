import { jest } from "bun:test";
import { readFile } from "node:fs/promises";
import { describe, expect, vi } from "vitest";

type AnyFunction = (...args: never[]) => unknown;
type ViCompat = Record<string, AnyFunction>;

const compat = vi as unknown as ViCompat;
const nativeSetTimeout = globalThis.setTimeout;
process.env.DO_NOT_TRACK ??= "1";
// Do not let the parent Prime Agent daemon make CLI tests operate on live sessions.
for (const name of Object.keys(process.env)) {
	if (name.startsWith("PRIME_AGENT_INTERNAL_") || name.startsWith("RLM_")) {
		delete process.env[name];
	}
}
delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
delete process.env.PRIME_AGENT_KERNEL_OWNER_PID;
const gitConfigCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
process.env[`GIT_CONFIG_KEY_${gitConfigCount}`] = "commit.gpgsign";
process.env[`GIT_CONFIG_VALUE_${gitConfigCount}`] = "false";
process.env.GIT_CONFIG_COUNT = String(gitConfigCount + 1);
const originalEnv = new Map<string, string | undefined>();
const originalGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();

compat.hoisted ??= (factory: AnyFunction) => factory();
compat.mocked ??= (value: unknown) => value;
compat.setSystemTime ??= (value: Date | number) => jest.setSystemTime(value);
compat.advanceTimersByTime = (milliseconds: number) => {
	const targetTime = Date.now() + milliseconds;
	jest.advanceTimersByTime(milliseconds);
	jest.setSystemTime(targetTime);
	return vi;
};
const flushMicrotasks = async (): Promise<void> => {
	// Timer callbacks in these tests often cross several awaited boundaries before
	// scheduling the next timer. Keep fake time still while those jobs settle.
	for (let index = 0; index < 8; index++) await Promise.resolve();
};

compat.advanceTimersByTimeAsync ??= async (milliseconds: number) => {
	await flushMicrotasks();
	let remaining = milliseconds;
	while (remaining > 0) {
		const step = Math.min(remaining, 10);
		const targetTime = Date.now() + step;
		jest.advanceTimersByTime(step);
		jest.setSystemTime(targetTime);
		remaining -= step;
		await flushMicrotasks();
	}
	if (milliseconds === 0) {
		jest.advanceTimersByTime(0);
		await flushMicrotasks();
	}
};
compat.runAllTimersAsync ??= async () => {
	await flushMicrotasks();
	for (let pass = 0; pass < 10_000 && jest.getTimerCount() > 0; pass++) {
		jest.runAllTimers();
		await flushMicrotasks();
	}
};
compat.advanceTimersToNextTimerAsync ??= async () => {
	await flushMicrotasks();
	jest.advanceTimersToNextTimer();
	await flushMicrotasks();
};
compat.runOnlyPendingTimersAsync ??= async () => {
	await flushMicrotasks();
	jest.runOnlyPendingTimers();
	await flushMicrotasks();
};
compat.waitFor ??= async (assertion: AnyFunction, options: { timeout?: number; interval?: number } = {}) => {
	const timeout = options.timeout ?? 1_000;
	const interval = options.interval ?? 20;
	const deadline = Date.now() + timeout;
	let lastError: unknown;
	while (Date.now() <= deadline) {
		try {
			return await assertion();
		} catch (error) {
			lastError = error;
		}
		if (jest.isFakeTimers()) {
			const targetTime = Date.now() + interval;
			jest.advanceTimersByTime(interval);
			jest.setSystemTime(targetTime);
			await flushMicrotasks();
			// Promise jobs alone do not let spawned-process and socket events run.
			await readFile("/dev/null");
		} else {
			await new Promise((resolve) => nativeSetTimeout(resolve, interval));
		}
	}
	throw lastError ?? new Error(`waitFor timed out after ${timeout} ms`);
};

const expectCompat = expect as typeof expect & {
	poll?: (actual: () => unknown | Promise<unknown>, options?: { timeout?: number; interval?: number }) => unknown;
};
expectCompat.poll ??= (actual: () => unknown | Promise<unknown>, options?: { timeout?: number; interval?: number }) =>
	new Proxy(
		{},
		{
			get:
				(_target, matcher: string) =>
				async (...args: unknown[]) =>
					vi.waitFor(async () => {
						const received = await actual();
						const expectation = expect(received) as unknown as Record<string, unknown>;
						const assertion = expectation[matcher];
						if (typeof assertion !== "function") {
							throw new Error(`expect.poll does not support matcher: ${matcher}`);
						}
						return assertion.apply(expectation, args);
					}, options),
		},
	);

compat.stubEnv ??= (name: string, value: string | undefined) => {
	if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
};
compat.unstubAllEnvs ??= () => {
	for (const [name, value] of originalEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	originalEnv.clear();
};
compat.stubGlobal ??= (name: PropertyKey, value: unknown) => {
	if (!originalGlobals.has(name)) originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};
compat.unstubAllGlobals ??= () => {
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals.clear();
};

(describe as typeof describe & { sequential?: typeof describe }).sequential ??= describe;
