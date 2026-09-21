import { expect, vi } from "vitest";

/**
 * Shared fetch-level fakes for the Prime sandbox/platform wire suites: the
 * recorded fetch router, the JSON response builder, and the request
 * accessors. One implementation keeps the suites focused on the wire
 * contracts they pin instead of re-deriving the same fetch scaffolding per
 * file.
 */

export type FetchMock = ReturnType<typeof vi.fn>;

export interface RecordedFetch {
	url: string;
	init: RequestInit | undefined;
}

/** One planned answer for a recorded fetch call. */
export type FetchResponder = (record: RecordedFetch) => Response | Promise<Response>;

export interface FetchRecorder {
	mock: FetchMock;
	calls: RecordedFetch[];
}

/**
 * A vi.fn fetch that records every call as {url, init} and answers from the
 * responder list in order; the last responder repeats for further calls.
 */
export function fetchRecorder(responders: FetchResponder[]): FetchRecorder {
	const calls: RecordedFetch[] = [];
	const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const record: RecordedFetch = { url, init };
		calls.push(record);
		const responder = responders[calls.length - 1] ?? responders.at(-1);
		if (responder === undefined) {
			throw new Error(`unexpected fetch #${calls.length} to ${record.url}`);
		}
		return responder(record);
	});
	return { mock, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Plain-record request headers; Headers/array shapes fail loudly. */
export function headerOf(init: RequestInit | undefined): Record<string, string> {
	const headers = init?.headers;
	if (!headers || Array.isArray(headers) || headers instanceof Headers) {
		throw new Error("expected plain record headers");
	}
	return headers as Record<string, string>;
}

export function jsonBodyOf(init: RequestInit | undefined): Record<string, unknown> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, unknown>;
}

export function formOf(init: RequestInit | undefined): FormData {
	if (!(init?.body instanceof FormData)) {
		throw new Error("Expected FormData request body");
	}
	return init.body;
}

/** Await a rejection, assert its class, and hand the typed error back. */
export async function expectErrorOf<T extends Error>(
	promise: Promise<unknown>,
	klass: abstract new (...args: never[]) => T,
): Promise<T> {
	try {
		await promise;
	} catch (caught) {
		expect(caught).toBeInstanceOf(klass);
		return caught as T;
	}
	throw new Error("Expected the call to fail");
}
