import { describe, expect, it, vi } from "vitest";
import {
	getTelemetryErrorRecoveryTracker,
	TelemetryErrorRecoveryTracker,
} from "../src/core/telemetry-error-recovery.js";
import type { TelemetryProperties } from "../src/core/telemetry-schema.js";

function failure(id: string, extra: TelemetryProperties = {}): TelemetryProperties {
	return {
		error_id: id,
		component: "provider",
		provider_category: "prime",
		error_code_group: "ECONNRESET",
		error_type: "Error",
		error_subtype: "network_error",
		session_id: "session-a",
		run_id: "run-a",
		recovery_action: "none",
		recovery_outcome: "not_observed",
		...extra,
	};
}

describe("scoped error recovery sequences", () => {
	it("counts distinct failures and emits updates using the original error ID", () => {
		const tracker = new TelemetryErrorRecoveryTracker({ isEnabled: () => true });
		expect(tracker.recordFailure(failure("one"))?.consecutive_failure_count).toBe(1);
		expect(tracker.recordFailure(failure("one"))?.consecutive_failure_count).toBe(1);
		expect(tracker.recordFailure(failure("two"))?.consecutive_failure_count).toBe(2);
		const pending = tracker.noteRecoveryAction("automatic_retry", {
			sessionId: "session-a",
			runId: "run-a",
			retryBackoffMs: 200,
		});
		expect(pending).toHaveLength(2);
		expect(pending[0]).toMatchObject({
			error_id: "one",
			error_event_kind: "recovery_update",
			recovery_outcome: "pending",
			retry_backoff_ms: 200,
		});
		const recovered = tracker.finishRun({
			sessionId: "session-a",
			runId: "run-a",
			providerCategory: "prime",
			outcome: "success",
		});
		expect(recovered.map((event) => event.error_id)).toEqual(["one", "two"]);
		expect(
			recovered.every(
				(event) => event.recovery_outcome === "success" && event.error_event_kind === "recovery_update",
			),
		).toBe(true);
		expect(tracker.recordFailure(failure("three"))?.consecutive_failure_count).toBe(1);
	});

	it("never recovers a different worker session, provider, or unscoped failure", () => {
		const tracker = new TelemetryErrorRecoveryTracker({ isEnabled: () => true });
		tracker.recordFailure(failure("one", { client_session_id: "client-a" }));
		tracker.recordFailure(failure("unscoped", { session_id: null }));
		expect(tracker.noteRecoveryAction("credentials_updated", { clientSessionId: "client-a" })).toEqual([]);
		expect(
			tracker.finishRun({ sessionId: "session-b", clientSessionId: "client-a", runId: "run-b", outcome: "success" }),
		).toEqual([]);
		expect(
			tracker.finishRun({
				sessionId: "session-a",
				runId: "run-b",
				providerCategory: "anthropic",
				outcome: "success",
			}),
		).toEqual([]);
		expect(tracker.finishRun({ runId: "run-b", outcome: "success" })).toEqual([]);
	});

	it.each(["credentials_updated", "provider_changed", "model_changed", "manual_retry"] as const)(
		"observes success after %s without claiming causal proof",
		(action) => {
			const tracker = new TelemetryErrorRecoveryTracker({ isEnabled: () => true });
			tracker.recordFailure(failure("one"));
			tracker.noteRecoveryAction(action, { sessionId: "session-a", targetProviderCategory: "anthropic" });
			expect(
				tracker.finishRun({
					sessionId: "session-a",
					runId: "run-b",
					providerCategory: "anthropic",
					outcome: "success",
				}),
			).toMatchObject([{ error_id: "one", run_id: "run-a", recovery_action: action, recovery_outcome: "success" }]);
		},
	);

	it("retains failed retries for a later successful run and does not call cancellation success", () => {
		const tracker = new TelemetryErrorRecoveryTracker({ isEnabled: () => true });
		tracker.recordFailure(failure("one"));
		tracker.noteRecoveryAction("automatic_retry", { sessionId: "session-a", runId: "run-a" });
		expect(tracker.finishRun({ sessionId: "session-a", runId: "run-a", outcome: "error" })[0].recovery_outcome).toBe(
			"failed",
		);
		tracker.noteRecoveryAction("manual_retry", { sessionId: "session-a" });
		expect(
			tracker.finishRun({ sessionId: "session-a", runId: "run-a", outcome: "cancelled" })[0].recovery_outcome,
		).toBe("cancelled");
		expect(
			tracker.finishRun({ sessionId: "session-a", runId: "run-b", outcome: "success" })[0].recovery_outcome,
		).toBe("success");
	});

	it("does not infer daemon or file recovery from an unrelated successful model run", () => {
		const tracker = new TelemetryErrorRecoveryTracker({ isEnabled: () => true });
		tracker.recordFailure(failure("one", { component: "daemon", error_code_group: "ENOENT" }));
		expect(tracker.noteRecoveryAction("none", { sessionId: "session-a" })).toEqual([]);
		expect(tracker.finishRun({ sessionId: "session-a", runId: "run-b", outcome: "success" })).toEqual([]);
	});
	it("resolves only explicit observed tool errors and restricts provider retry actions", () => {
		const tracker = new TelemetryErrorRecoveryTracker({ isEnabled: () => true });
		tracker.recordFailure(failure("tool-a", { component: "tools" }));
		tracker.recordFailure(failure("tool-b", { component: "tools" }));
		tracker.recordFailure(failure("provider"));
		expect(
			tracker
				.noteRecoveryAction("automatic_retry", { sessionId: "session-a", components: ["provider"] })
				.map((item) => item.error_id),
		).toEqual(["provider"]);
		expect(tracker.finishErrors(["tool-a"], { sessionId: "session-b", runId: "run-a" })).toEqual([]);
		expect(
			tracker.finishErrors(["tool-a", "tool-a"], { sessionId: "session-a", runId: "run-a", components: ["tools"] }),
		).toMatchObject([{ error_id: "tool-a", error_event_kind: "recovery_update", recovery_outcome: "success" }]);
		expect(tracker.finishErrors(["tool-a"], { sessionId: "session-a", runId: "run-a" })).toEqual([]);
		expect(
			tracker.finishRun({ sessionId: "session-a", runId: "run-a", outcome: "success" }).map((item) => item.error_id),
		).toEqual(["provider"]);
	});

	it("checks opt-out before inspecting properties and forgets retained errors", () => {
		let enabled = true;
		const tracker = new TelemetryErrorRecoveryTracker({ isEnabled: () => enabled });
		tracker.recordFailure(failure("one"));
		enabled = false;
		const getter = vi.fn(() => {
			throw new Error("private getter");
		});
		expect(tracker.recordFailure(new Proxy({}, { get: getter }))).toBeUndefined();
		expect(getter).not.toHaveBeenCalled();
		enabled = true;
		expect(tracker.finishRun({ sessionId: "session-a", runId: "run-b", outcome: "success" })).toEqual([]);
	});

	it("keeps unrelated authentication operations out of validated-login recovery", () => {
		const tracker = new TelemetryErrorRecoveryTracker({ isEnabled: () => true });
		for (const operation of ["login", "validate", "refresh", "logout", "discover"])
			tracker.recordFailure(failure(operation, { component: "authentication", operation }));
		const scope = { sessionId: "session-a", operations: ["login", "validate", "refresh"] as const };
		expect(tracker.noteRecoveryAction("credentials_updated", scope).map((error) => error.error_id)).toEqual([
			"login",
			"validate",
			"refresh",
		]);
		expect(tracker.finishErrors(["login", "logout", "discover"], scope).map((error) => error.error_id)).toEqual([
			"login",
		]);
	});

	it.each([
		["prime-inference", "prime-agent-traces", "prime"],
		["openai", "openai-codex", "openai"],
	])("separates %s from %s even when analytics groups both as %s", (first, second, category) => {
		const tracker = new TelemetryErrorRecoveryTracker({ isEnabled: () => true });
		const properties = { component: "authentication", operation: "validate", provider_category: category };
		const original = tracker.recordFailure(failure("first", properties), { provider: first });
		tracker.recordFailure(failure("second", properties), { provider: second });
		tracker.recordFailure(failure("unidentified", properties));
		const scope = { sessionId: "session-a", providerCategory: category, providerIdentity: first };
		expect(tracker.noteRecoveryAction("credentials_updated", scope).map((error) => error.error_id)).toEqual([
			"first",
		]);
		const recovered = tracker.finishErrors(["first", "second", "unidentified"], scope);
		expect(recovered.map((error) => error.error_id)).toEqual(["first"]);
		for (const event of [original, ...recovered]) {
			expect(event).not.toHaveProperty("providerIdentity");
			expect(event).not.toHaveProperty("provider");
		}
		expect(JSON.stringify(recovered)).not.toContain(second);
	});

	it.each(["", "unknown", "custom", "x".repeat(129)])("rejects an invalid local recovery identity", (provider) => {
		const tracker = new TelemetryErrorRecoveryTracker({ isEnabled: () => true });
		tracker.recordFailure(failure("one"), { provider });
		const scope = { sessionId: "session-a", providerIdentity: provider };
		expect(tracker.noteRecoveryAction("credentials_updated", scope)).toEqual([]);
		expect(tracker.finishErrors(["one"], scope)).toEqual([]);
	});

	it("bounds retained errors and expires old failures", () => {
		let now = 10;
		const tracker = new TelemetryErrorRecoveryTracker({
			isEnabled: () => true,
			maxErrors: 2,
			retentionMs: 100,
			now: () => now,
		});
		tracker.recordFailure(failure("one"));
		tracker.recordFailure(failure("two"));
		tracker.recordFailure(failure("three"));
		expect(
			tracker.noteRecoveryAction("manual_retry", { sessionId: "session-a" }).map((event) => event.error_id),
		).toEqual(["two", "three"]);
		now = 111;
		expect(tracker.finishRun({ sessionId: "session-a", runId: "run-b", outcome: "success" })).toEqual([]);
	});

	it("shares a tracker only for the same settings owner and agent directory", () => {
		const owner = {};
		const options = { isEnabled: () => true };
		const tracker = getTelemetryErrorRecoveryTracker(owner, "one", options);
		expect(getTelemetryErrorRecoveryTracker(owner, "one", options)).toBe(tracker);
		expect(getTelemetryErrorRecoveryTracker(owner, "two", options)).not.toBe(tracker);
		expect(getTelemetryErrorRecoveryTracker({}, "one", options)).not.toBe(tracker);
	});
});
