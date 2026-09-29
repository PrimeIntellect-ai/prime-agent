import type { Api, Model } from "@earendil-works/pi-ai";
import type { ProviderRetryPolicy } from "../provider-retry.js";
import { compileActionSpace } from "./action-space.js";
import { createModelDecisionFunction, routerThinkingLevel } from "./decide.js";
import { ROUTER_CLOSE_GRACE_MS, runSystemRouterLoop } from "./loop.js";
import { StdioRouterEnvironment } from "./stdio-environment.js";
import {
	type ParsedSystemRouterRunSpec,
	parseEnvironmentActions,
	type RouterEnvironment,
	type SystemRouterRunResult,
} from "./types.js";

/** The environment the segment runner needs: the loop contract plus the init handshake. */
export interface RouterSegmentEnvironment extends RouterEnvironment {
	/** Initialize the adapter and return its environment info (default action space), if any. */
	init(): Promise<Record<string, unknown> | undefined>;
}

export interface RouterSegmentOptions {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	sessionId?: string;
	policy?: ProviderRetryPolicy;
	/** Defaults to a StdioRouterEnvironment built from the spec. */
	env?: RouterSegmentEnvironment;
	/** External abort (host shutdown): ends the run failed("aborted"). */
	signal?: AbortSignal;
}

/**
 * Run one bounded router segment: always init the adapter (it carries the
 * init payload, e.g. a ROM path), resolve the action space (the spec's
 * declaration wins over the adapter's defaults), then run the loop. The
 * adapter is closed on every path, including init failures and a missing
 * action space, so the subprocess never leaks.
 */
export async function runRouterSegment(
	spec: ParsedSystemRouterRunSpec,
	options: RouterSegmentOptions,
): Promise<SystemRouterRunResult> {
	const env =
		options.env ??
		new StdioRouterEnvironment({
			command: spec.environment.stdio.command,
			...(spec.environment.stdio.cwd ? { cwd: spec.environment.stdio.cwd } : {}),
			requestTimeoutMs: spec.environment.stdio.requestTimeoutMs,
			...(spec.environment.stdio.init !== undefined ? { init: spec.environment.stdio.init } : {}),
		});
	const segmentStartedAt = Date.now();
	if (options.signal?.aborted) {
		// Disposal can win the race before the segment starts: do not even
		// spawn the adapter for an already-aborted run.
		return segmentAbortedResult(options.model, "Router aborted before the segment started.");
	}
	try {
		let environment: Awaited<ReturnType<RouterSegmentEnvironment["init"]>>;
		try {
			// The segment timeout bounds the whole segment, adapter init included.
			environment = await raceInitAgainstSegmentTimeout(
				env.init(),
				spec.timeoutMs,
				segmentStartedAt,
				options.signal,
			);
		} catch (error) {
			// Timeout errors keep the budget message (System 2 may raise the
			// timeout); an adapter failure must not masquerade as one.
			if (error instanceof RouterSegmentInitTimeoutError) throw error;
			if (error instanceof RouterSegmentAbortedError) throw error;
			throw new Error(`environment adapter init failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		// Init can win the race in the same tick the budget expires; a
		// leftover budget below 1ms must not hand the loop a 1ms deadline
		// that still dispatches reset past the declared segment timeout.
		const loopBudgetMs = spec.timeoutMs - (Date.now() - segmentStartedAt);
		if (loopBudgetMs <= 0) {
			throw new RouterSegmentInitTimeoutError(
				`environment adapter init exceeded the segment timeout of ${spec.timeoutMs}ms`,
			);
		}
		const actions = parseEnvironmentActions(spec.actions, environment?.actions);
		if (!actions) {
			throw new Error("system_router.run has no action space: declare one or use an adapter that supplies its own");
		}
		const { byName } = compileActionSpace(actions);
		return await runSystemRouterLoop({
			env,
			goal: spec.goal,
			actions,
			decide: createModelDecisionFunction({
				model: options.model,
				apiKey: options.apiKey,
				headers: options.headers,
				sessionId: options.sessionId,
				policy: options.policy,
				actions: byName,
			}),
			model: {
				id: options.model.id,
				provider: options.model.provider,
				input: options.model.input ?? [],
				thinkingLevel: routerThinkingLevel(options.model),
			},
			gate: spec.gate,
			...(options.signal ? { signal: options.signal } : {}),
			maxSteps: spec.maxSteps,
			// The loop's deadline covers the remaining segment budget after init.
			timeoutMs: loopBudgetMs,
			historySteps: spec.historySteps,
			observationChars: spec.observationChars,
		});
	} catch (error) {
		// An external abort during init unwinds as the aborted result, not a
		// rejected host request; every other error keeps surfacing.
		if (error instanceof RouterSegmentAbortedError) {
			return segmentAbortedResult(options.model, "Router aborted during adapter init.");
		}
		throw error;
	} finally {
		// The loop closes the env on its own paths; this guards the window
		// between init and the loop so the adapter process never leaks. The
		// grace keeps a wedged-but-forwardable container adapter stoppable.
		await env
			.close({
				budgetMs: Math.max(0, spec.timeoutMs - (Date.now() - segmentStartedAt)) + ROUTER_CLOSE_GRACE_MS,
			})
			.catch(() => {});
	}
}

/** Timeout marker: keeps the budget message; other init errors are adapter failures. */
class RouterSegmentInitTimeoutError extends Error {}

/** Abort marker: the external signal fired before the loop took over. */
class RouterSegmentAbortedError extends Error {}

/** The failed("aborted") result for a segment that never recorded a step. */
function segmentAbortedResult(model: Model<Api>, summary: string): SystemRouterRunResult {
	return {
		status: "failed",
		reason: "aborted",
		summary,
		steps: 0,
		executed: 0,
		refused: 0,
		trace: [],
		model: { provider: model.provider, id: model.id, thinkingLevel: routerThinkingLevel(model) },
		usage: { inputTokens: 0, outputTokens: 0 },
	};
}

/** Race adapter init against the segment budget without leaking a late rejection. */
async function raceInitAgainstSegmentTimeout<T>(
	work: Promise<T>,
	timeoutMs: number,
	startedAt: number,
	signal?: AbortSignal,
): Promise<T> {
	const remaining = timeoutMs - (Date.now() - startedAt);
	if (remaining <= 0) {
		void work.catch(() => {});
		throw new RouterSegmentInitTimeoutError(
			`environment adapter init exceeded the segment timeout of ${timeoutMs}ms: segment budget already exhausted before init`,
		);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new RouterSegmentInitTimeoutError(
						`environment adapter init exceeded the segment timeout of ${timeoutMs}ms`,
					),
				),
			remaining,
		);
		if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
	});
	void timeout.catch(() => {});
	void work.catch(() => {});
	// An external abort must end the init wait immediately (the segment budget
	// can be far away); its rejection is handled like the timeout's.
	let onAbort: (() => void) | undefined;
	const abort = new Promise<never>((_, reject) => {
		if (signal?.aborted) {
			reject(new RouterSegmentAbortedError());
			return;
		}
		if (signal) {
			onAbort = () => reject(new RouterSegmentAbortedError());
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	void abort.catch(() => {});
	try {
		return await Promise.race([work, timeout, abort]);
	} catch (error) {
		throw error instanceof Error ? error : new Error(String(error));
	} finally {
		if (timer) clearTimeout(timer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	}
}
