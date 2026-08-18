import {
	createHostRequestHandler,
	type HostRequestContext,
	type HostRequestHandlerImplementation,
} from "../src/core/kernel/index.js";

let nextSyntheticHostRequestId = 0;

/** Create a distinct, current dispatcher context for direct host-handler tests. */
export function createSyntheticHostRequestContext(): HostRequestContext {
	const requestNumber = ++nextSyntheticHostRequestId;
	const controller = new AbortController();
	return {
		requestId: `test-host-request-${requestNumber}`,
		generation: requestNumber,
		signal: controller.signal,
		isCurrent: () => !controller.signal.aborted,
	};
}

/** Invoke a production-shaped handler with a synthetic dispatcher context. */
export function invokeHostRequest(
	handler: HostRequestHandlerImplementation,
	payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return handler(payload, createSyntheticHostRequestContext());
}

/** Build staged context-aware fixture handlers through the production factory. */
export function createTestHostHandlers<
	T extends Record<
		string,
		(payload: Record<string, unknown>, context: HostRequestContext) => Promise<Record<string, unknown>>
	>,
>(handlers: T): Record<keyof T, HostRequestHandlerImplementation> {
	return Object.fromEntries(
		Object.entries(handlers).map(([type, handler]) => [type, createHostRequestHandler(handler)]),
	) as unknown as Record<keyof T, HostRequestHandlerImplementation>;
}
