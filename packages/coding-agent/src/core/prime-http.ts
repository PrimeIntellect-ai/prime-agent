/** Shared helpers for the Prime HTTP boundary used by agent traces and Prime Inference auth. */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberField(data: Record<string, unknown>, key: string): number | undefined {
	const value = data[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringEnv(name: string): string | undefined {
	const value = process.env[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseResponseObject(text: string): Record<string, unknown> | undefined {
	if (!text.trim()) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function readResponseMessage(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	if (!text.trim()) {
		return response.statusText || "Unknown error";
	}

	const parsed = parseResponseObject(text);
	if (parsed) {
		const error = parsed.error;
		if (isRecord(error)) {
			const message = stringField(error, "message");
			if (message) return message;
		}
		const detail = stringField(parsed, "detail");
		if (detail) return detail;
		const message = stringField(parsed, "message");
		if (message) return message;
	}

	return text.trim();
}

export interface PrimeFetchTimeoutOptions {
	/** Thrown when the request timer fires, and used as the abort reason. */
	timeoutError: Error;
	signal?: AbortSignal;
	/** Thrown instead of the caller abort reason when `signal` aborts. */
	cancelledError?: Error;
}

export async function fetchWithTimeout(
	fetchFn: typeof fetch,
	url: string | URL,
	init: RequestInit,
	timeoutMs: number,
	options: PrimeFetchTimeoutOptions,
): Promise<Response> {
	const { timeoutError, signal, cancelledError } = options;
	if (cancelledError && signal?.aborted) {
		throw cancelledError;
	}

	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort(timeoutError);
	}, timeoutMs);
	timeout.unref();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) {
		onAbort();
	} else {
		signal?.addEventListener("abort", onAbort, { once: true });
	}

	try {
		return await fetchFn(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (cancelledError && signal?.aborted) {
			throw cancelledError;
		}
		if (timedOut) {
			throw timeoutError;
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}
}
