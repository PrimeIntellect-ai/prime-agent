import {
	type CompiledAction,
	compileActionSpace,
	compileDecisionPrompt,
	formatHistoryEntry,
	gateThreshold,
	observationDigest,
} from "./action-space.js";
import type { RouterDecisionFunction } from "./decide.js";
import {
	DEFAULT_ROUTER_HISTORY_STEPS,
	ESCALATE_ACTION,
	FINISH_ACTION,
	type RouterActionSpec,
	type RouterEnvironment,
	type RouterExecution,
	type RouterGateSpec,
	type RouterModelInfo,
	type RouterRunStatus,
	type RouterStepTrace,
	type SystemRouterRunResult,
} from "./types.js";

/** Consecutive gate refusals before the loop stops as stuck. */
export const ROUTER_REFUSAL_STREAK_LIMIT = 3;
/** The same action with the same params on the same observation, this many times, is stuck. */
export const ROUTER_REPETITION_LIMIT = 2;
/**
 * Bounded cleanup grace handed to close() past the deadline: long enough for a
 * container-wrapped adapter (docker run) to relay the close request or
 * SIGTERM and stop (--rm reaps), bounded so a wedged adapter cannot extend a
 * timed-out segment the way the old unbounded waits did.
 */
export const ROUTER_CLOSE_GRACE_MS = 500;

/**
 * Race work against a deadline without leaking a late rejection from the losing
 * side. Work starts through the thunk only while the wall-clock budget remains:
 * the deadline promise resolves no earlier than deadlineAt, and a timer-lag gap
 * between the two must not start a new operation (or its side effects).
 */
async function raceDeadline<T>(
	start: () => Promise<T>,
	deadlineAt: number,
	deadline: Promise<"deadline">,
): Promise<T | "deadline"> {
	if (Date.now() >= deadlineAt) return "deadline";
	// Both losers are marked handled: attach handlers to the promises themselves
	// before the race, never after it resolves.
	const handledWork = start().finally(() => {});
	void handledWork.catch(() => {});
	const result = (await Promise.race([handledWork, deadline])) as T | "deadline";
	if (result === "deadline") {
		// The work may still reject later; it already has a handler, so it cannot crash.
		return "deadline";
	}
	return result;
}

export interface SystemRouterLoopOptions {
	env: RouterEnvironment;
	goal: string;
	actions: Record<string, RouterActionSpec>;
	decide: RouterDecisionFunction;
	model: RouterModelInfo;
	gate?: RouterGateSpec;
	maxSteps: number;
	timeoutMs: number;
	historySteps?: number;
	observationChars?: number;
	/** External abort (host shutdown). The in-flight step completes and the run ends failed("aborted"). */
	signal?: AbortSignal;
}

/** Validate the declared space; called inside the loop's cleanup scope so a
 * reserved name or an empty space cannot leak the adapter process. */
function validateAndCompileActionSpace(actions: Record<string, RouterActionSpec>) {
	const declaredActions = Object.keys(actions);
	if (declaredActions.length === 0) {
		throw new Error("system router action space is empty (finish and escalate are always appended)");
	}
	return compileActionSpace(actions).byName;
}

/**
 * The System 1 step loop: observe -> decide (ONE call) -> gate -> execute -> record.
 * Mirrors the SystemOneHarness controller: a probability on every transition,
 * confidence gates per risk, refusal streaks and a repetition guard toward
 * stuck, explicit budgets, and a complete trace.
 */
export async function runSystemRouterLoop(options: SystemRouterLoopOptions): Promise<SystemRouterRunResult> {
	let byName: Map<string, CompiledAction>;
	const historySteps = options.historySteps ?? DEFAULT_ROUTER_HISTORY_STEPS;
	const observationChars = options.observationChars ?? 6_000;
	const startedAt = Date.now();
	const deadlineAt = startedAt + options.timeoutMs;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"deadline">((resolve) => {
		const remaining = deadlineAt - Date.now();
		deadlineTimer = setTimeout(() => resolve("deadline"), Math.max(0, remaining));
	});
	// A late deadline resolution must never surface as an unhandled rejection; it never rejects,
	// but attach a handler anyway so the invariant is structural, not incidental.
	void deadline.catch(() => {});
	// A decision that loses the deadline race keeps running detached; its
	// signal stops the provider retry sleeps so no extra model requests run
	// past the segment's wall-clock budget.
	const decisionAbort = new AbortController();
	// Disposal must stop in-flight decision retries immediately, not at the
	// next step boundary: the external signal aborts the decision calls too.
	const abortInFlightDecision = () => decisionAbort.abort();
	options.signal?.addEventListener("abort", abortInFlightDecision, { once: true });

	const trace: RouterStepTrace[] = [];
	const history: string[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	let executed = 0;
	let refused = 0;
	let refusalStreak = 0;
	let repeatDigest: string | null = null;
	const repeatCounts = new Map<string, number>();

	const finish = (status: RouterRunStatus, reason: string, summary: string): SystemRouterRunResult => ({
		status,
		reason,
		steps: trace.length,
		executed,
		refused,
		trace,
		summary,
		model: {
			provider: options.model.provider,
			id: options.model.id,
			thinkingLevel: options.model.thinkingLevel,
		},
		usage: { inputTokens, outputTokens },
	});

	try {
		byName = validateAndCompileActionSpace(options.actions);
		// A pre-aborted signal must not mutate the external environment first.
		if (options.signal?.aborted) {
			return finish("failed", "aborted", "Router aborted before reset.");
		}
		try {
			const resetResult = await raceDeadline(() => options.env.reset(options.goal), deadlineAt, deadline);
			if (resetResult === "deadline") {
				return finish(
					"incomplete",
					"timeout",
					`Stopped before the first step: the segment timeout of ${options.timeoutMs}ms elapsed during reset.`,
				);
			}
		} catch (error) {
			return finish(
				"failed",
				"environment_error",
				`Environment failed resetting at segment start: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		for (let step = 0; step < options.maxSteps; step += 1) {
			if (options.signal?.aborted) {
				return finish("failed", "aborted", "Router aborted before the current step.");
			}
			let observation: Awaited<ReturnType<RouterEnvironment["observe"]>> | "deadline";
			try {
				observation = await raceDeadline(() => options.env.observe(), deadlineAt, deadline);
			} catch (error) {
				return finish(
					"failed",
					"environment_error",
					`Environment failed observing at step ${step}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (observation === "deadline") {
				return finish(
					"incomplete",
					"timeout",
					`Stopped at step ${step}: the segment timeout of ${options.timeoutMs}ms elapsed.`,
				);
			}
			// A terminal observation must not outrank an abort that fired during
			// observe(), or the wall clock passing the deadline mid-observe.
			if (options.signal?.aborted) {
				return finish("failed", "aborted", "Router aborted while observing the current step.");
			}
			if (Date.now() >= deadlineAt) {
				return finish(
					"incomplete",
					"timeout",
					`Stopped at step ${step}: the segment timeout of ${options.timeoutMs}ms elapsed while observing.`,
				);
			}
			if (observation.terminal) {
				return finish(
					"done",
					"environment_terminal",
					`Environment reported terminal state at step ${step} after ${executed} executed action(s).`,
				);
			}
			const digest = observationDigest(observation);
			const prompt = compileDecisionPrompt({
				goal: options.goal,
				observation,
				history: historySteps > 0 ? history.slice(-historySteps) : [],
				actions: byName,
				observationChars,
			});
			const decisionStarted = Date.now();
			let decision: Awaited<ReturnType<RouterDecisionFunction>> | "deadline";
			try {
				decision = await raceDeadline(
					() =>
						options.decide({
							prompt,
							...(observation.image ? { image: observation.image } : {}),
							signal: decisionAbort.signal,
						}),
					deadlineAt,
					deadline,
				);
			} catch (error) {
				return finish(
					"failed",
					"decision_model_error",
					`Decision function threw at step ${step}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (decision === "deadline") {
				return finish(
					"incomplete",
					"timeout",
					`Stopped at step ${step}: the segment timeout of ${options.timeoutMs}ms elapsed mid-decision.`,
				);
			}
			const latencyMs = Date.now() - decisionStarted;
			inputTokens += decision.usage?.inputTokens ?? 0;
			outputTokens += decision.usage?.outputTokens ?? 0;

			if (decision.modelError) {
				// A disposal abort mid-decision surfaces as stopReason "aborted"
				// -> modelError; the abort result takes precedence over the
				// model-failure report.
				if (options.signal?.aborted) {
					return finish("failed", "aborted", "Router aborted during the current step.");
				}
				const stepTrace: RouterStepTrace = {
					step,
					timestampMs: decisionStarted,
					latencyMs,
					action: null,
					params: {},
					confidence: null,
					gate: { threshold: 0, verdict: "parse_failure" },
					observationDigest: digest,
					observationChars: observation.text.length,
					result: decision.modelError,
					terminal: false,
					thinkingLevel: options.model.thinkingLevel,
					...(decision.usage ? { usage: decision.usage } : {}),
				};
				trace.push(stepTrace);
				return finish(
					"failed",
					"decision_model_error",
					`Decision model failed at step ${step}: ${decision.modelError}`,
				);
			}

			const action = decision.action ? byName.get(decision.action) : undefined;
			if (!action || decision.action === null || decision.confidence === null) {
				refusalStreak += 1;
				refused += 1;
				const reason = decision.parseError ?? "decision was not a valid choice";
				trace.push({
					step,
					timestampMs: decisionStarted,
					latencyMs,
					action: null,
					params: {},
					confidence: null,
					gate: { threshold: 0, verdict: "parse_failure" },
					observationDigest: digest,
					observationChars: observation.text.length,
					result: `refused: ${reason}`,
					terminal: false,
					thinkingLevel: options.model.thinkingLevel,
					...(decision.usage ? { usage: decision.usage } : {}),
				});
				if (refusalStreak >= ROUTER_REFUSAL_STREAK_LIMIT) {
					return finish(
						"stuck",
						"no_confident_decision",
						`Stopped at step ${step}: ${refusalStreak} consecutive decisions were not a valid choice from the action space.`,
					);
				}
				history.push("invalid decision -> refused");
				continue;
			}

			const threshold = gateThreshold(options.gate ?? {}, action);
			if (decision.confidence < threshold) {
				refusalStreak += 1;
				refused += 1;
				const result = `refused: confidence ${decision.confidence.toFixed(2)} below ${action.risk} gate ${threshold.toFixed(2)}`;
				trace.push({
					step,
					timestampMs: decisionStarted,
					latencyMs,
					action: action.name,
					params: decision.params,
					confidence: decision.confidence,
					gate: { threshold, verdict: "refused" },
					observationDigest: digest,
					observationChars: observation.text.length,
					result,
					terminal: false,
					thinkingLevel: options.model.thinkingLevel,
					...(decision.usage ? { usage: decision.usage } : {}),
				});
				history.push(formatHistoryEntry(action.name, decision.params, "refused below gate"));
				if (refusalStreak >= ROUTER_REFUSAL_STREAK_LIMIT) {
					return finish(
						"stuck",
						"no_confident_decision",
						`Stopped at step ${step}: no action cleared its confidence gate for ${refusalStreak} consecutive decisions.`,
					);
				}
				continue;
			}

			// The gate passed. An abort during the in-flight decision must not
			// be reported as successful work (e.g. finish after a shutdown signal).
			if (options.signal?.aborted) {
				return finish("failed", "aborted", "Router aborted during the current step.");
			}
			refusalStreak = 0;
			if (action.name === FINISH_ACTION) {
				trace.push({
					step,
					timestampMs: decisionStarted,
					latencyMs,
					action: action.name,
					params: {},
					confidence: decision.confidence,
					gate: { threshold, verdict: "pass" },
					observationDigest: digest,
					observationChars: observation.text.length,
					result: "goal declared reached",
					terminal: true,
					thinkingLevel: options.model.thinkingLevel,
					...(decision.usage ? { usage: decision.usage } : {}),
				});
				return finish(
					"done",
					"goal_reached",
					`Goal declared reached at step ${step} after ${executed} executed action(s).`,
				);
			}
			if (action.name === ESCALATE_ACTION) {
				trace.push({
					step,
					timestampMs: decisionStarted,
					latencyMs,
					action: action.name,
					params: {},
					confidence: decision.confidence,
					gate: { threshold, verdict: "pass" },
					observationDigest: digest,
					observationChars: observation.text.length,
					result: "escalation requested",
					terminal: true,
					thinkingLevel: options.model.thinkingLevel,
					...(decision.usage ? { usage: decision.usage } : {}),
				});
				return finish(
					"escalated",
					"escalation_requested",
					`Escalated at step ${step} after ${executed} executed action(s); review the trace and steer.`,
				);
			}

			// Repeated-state detection: the same action with the same params on
			// the same observation, whether adjacent or interleaved with other
			// repeats. JSON of the sorted entries cannot collide the way
			// key=value&... can (params {a: "x&b=y"} vs {a: "x", b: "y"} would
			// otherwise match).
			const canonicalParams = JSON.stringify(
				Object.fromEntries(
					Object.keys(decision.params)
						.sort()
						.map((key) => [key, decision.params[key]]),
				),
			);
			const signature = `${digest}:${action.name}:${canonicalParams}`;
			if (digest !== repeatDigest) {
				// The observation moved: past counts are stale.
				repeatCounts.clear();
				repeatDigest = digest;
			}
			const repeatCount = repeatCounts.get(signature) ?? 0;
			repeatCounts.set(signature, repeatCount + 1);
			if (repeatCount + 1 >= ROUTER_REPETITION_LIMIT) {
				refused += 1;
				trace.push({
					step,
					timestampMs: decisionStarted,
					latencyMs,
					action: action.name,
					params: decision.params,
					confidence: decision.confidence,
					gate: { threshold, verdict: "pass" },
					observationDigest: digest,
					observationChars: observation.text.length,
					result: `repeated ${action.name} on the same observation ${repeatCount + 1} times`,
					terminal: false,
					thinkingLevel: options.model.thinkingLevel,
					...(decision.usage ? { usage: decision.usage } : {}),
				});
				return finish(
					"stuck",
					"repeated_state",
					`Stopped at step ${step}: ${action.name} repeated on the same observation ${repeatCount + 1} times.`,
				);
			}

			// Execute only while the wall-clock budget remains: a dispatched
			// action applies a side effect the loop cannot take back.
			if (Date.now() >= deadlineAt) {
				return finish(
					"incomplete",
					"timeout",
					`Stopped at step ${step}: the segment timeout of ${options.timeoutMs}ms elapsed before execution.`,
				);
			}
			let executionResult: RouterExecution | "deadline";
			try {
				executionResult = await raceDeadline(
					() => options.env.execute(action.name, decision.params),
					deadlineAt,
					deadline,
				);
			} catch (error) {
				// A disposal abort fails the in-flight request (the close fails
				// all pending responses); the abort result outranks the adapter
				// failure report.
				if (options.signal?.aborted) {
					return finish("failed", "aborted", "Router aborted during the current step.");
				}
				// The dispatch may have reached the adapter before the rejection
				// (e.g. a request timeout after the write): count the execution and
				// record the unknown outcome like the deadline branch, instead of
				// letting a supervisor retry a possibly-applied action.
				executed += 1;
				const message = `Environment failed executing ${action.name} at step ${step}: ${error instanceof Error ? error.message : String(error)} (outcome unknown)`;
				trace.push({
					step,
					timestampMs: decisionStarted,
					latencyMs,
					action: action.name,
					params: decision.params,
					confidence: decision.confidence,
					gate: { threshold, verdict: "pass" },
					observationDigest: digest,
					observationChars: observation.text.length,
					result: message,
					terminal: false,
					thinkingLevel: options.model.thinkingLevel,
					...(decision.usage ? { usage: decision.usage } : {}),
				});
				return finish("failed", "environment_error", message);
			}
			// A disposal abort that fired mid-execute outranks the recorded
			// outcome: the run ends failed("aborted") per the signal contract.
			if (options.signal?.aborted) {
				return finish("failed", "aborted", "Router aborted during the current step.");
			}
			if (executionResult === "deadline") {
				// The dispatch already reached the adapter and the request is
				// not cancelled, so the outcome is unknown: record it (and
				// count the execution) instead of letting a supervisor retry
				// the action believing nothing ran.
				executed += 1;
				trace.push({
					step,
					timestampMs: decisionStarted,
					latencyMs,
					action: action.name,
					params: decision.params,
					confidence: decision.confidence,
					gate: { threshold, verdict: "pass" },
					observationDigest: digest,
					observationChars: observation.text.length,
					result: `dispatched ${action.name}; outcome unknown (segment timeout elapsed mid-execution)`,
					terminal: false,
					thinkingLevel: options.model.thinkingLevel,
					...(decision.usage ? { usage: decision.usage } : {}),
				});
				return finish(
					"incomplete",
					"timeout",
					`Stopped at step ${step}: the segment timeout of ${options.timeoutMs}ms elapsed mid-execution; the dispatched action's outcome is unknown.`,
				);
			}
			executed += 1;
			const resultText =
				executionResult.text.length > 240 ? `${executionResult.text.slice(0, 237)}...` : executionResult.text;
			trace.push({
				step,
				timestampMs: decisionStarted,
				latencyMs,
				action: action.name,
				params: decision.params,
				confidence: decision.confidence,
				gate: { threshold, verdict: "pass" },
				observationDigest: digest,
				observationChars: observation.text.length,
				result: resultText,
				terminal: executionResult.terminal === true,
				thinkingLevel: options.model.thinkingLevel,
				...(decision.usage ? { usage: decision.usage } : {}),
			});
			history.push(formatHistoryEntry(action.name, decision.params, resultText));
			if (executionResult.terminal) {
				return finish(
					"done",
					"environment_terminal",
					`Environment reported terminal state at step ${step} after ${executed} executed action(s).`,
				);
			}
		}
		return finish(
			"incomplete",
			"max_steps",
			`Stopped after ${options.maxSteps} steps: the segment step budget is exhausted; review the trace and steer.`,
		);
	} finally {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		options.signal?.removeEventListener("abort", abortInFlightDecision);
		decisionAbort.abort();
		// Adapter cleanup must not extend the segment the way the old
		// unbounded waits did: hand close() the remaining budget plus the
		// bounded grace, never the old 2.5s.
		await options.env
			.close({ budgetMs: Math.max(0, deadlineAt - Date.now()) + ROUTER_CLOSE_GRACE_MS })
			.catch(() => {});
	}
}
