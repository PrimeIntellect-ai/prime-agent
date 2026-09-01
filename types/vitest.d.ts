export * from "@vitest/runner";
export { assert, createExpect, expect } from "@vitest/expect";
export type { Mock, MockedFunction, MockInstance, MockedObject } from "@vitest/spy";

import type { MockInstance } from "@vitest/spy";

type Awaitable<T> = T | Promise<T>;
type CompatMocked<T> = T extends (...args: any[]) => any
	? T & MockInstance<T>
	: T extends object
		? { [K in keyof T]: CompatMocked<T[K]> }
		: T;
export type Mocked<T> = CompatMocked<T>;

type VitestCompat = {
	advanceTimersByTime(milliseconds: number): VitestCompat;
	advanceTimersByTimeAsync(milliseconds: number): Promise<VitestCompat>;
	advanceTimersToNextTimer(): VitestCompat;
	advanceTimersToNextTimerAsync(): Promise<VitestCompat>;
	clearAllMocks(): VitestCompat;
	clearAllTimers(): VitestCompat;
	fn: typeof import("@vitest/spy").fn;
	getTimerCount(): number;
	hoisted<T>(factory: () => T): T;
	isFakeTimers(): boolean;
	isMockFunction(fn: unknown): fn is MockInstance;
	mock(path: string, factory?: () => unknown): void;
	mocked<T>(value: T): CompatMocked<T>;
	resetAllMocks(): VitestCompat;
	restoreAllMocks(): VitestCompat;
	runAllTimers(): VitestCompat;
	runAllTimersAsync(): Promise<VitestCompat>;
	runOnlyPendingTimers(): VitestCompat;
	runOnlyPendingTimersAsync(): Promise<VitestCompat>;
	setSystemTime(value: Date | number): VitestCompat;
	spyOn: typeof import("@vitest/spy").spyOn;
	stubEnv(name: string, value: string | undefined): VitestCompat;
	stubGlobal(name: PropertyKey, value: unknown): VitestCompat;
	unstubAllEnvs(): VitestCompat;
	unstubAllGlobals(): VitestCompat;
	useFakeTimers(options?: { now?: Date | number }): VitestCompat;
	useRealTimers(): VitestCompat;
	waitFor<T>(assertion: () => Awaitable<T>, options?: { timeout?: number; interval?: number }): Promise<T>;
};
export const vi: VitestCompat;
