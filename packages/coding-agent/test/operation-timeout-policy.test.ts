import { describe, expect, it } from "vitest";
import type { OperationRecord } from "../src/modes/daemon/operation-ledger.js";
import {
	evaluateOperationDeadline,
	resolveOperationTimeoutPolicy,
} from "../src/modes/daemon/operation-timeout-policy.js";

function record(overrides: Partial<OperationRecord>): OperationRecord {
	return {
		schemaVersion: 1,
		operationId: "op-1",
		activeSessionId: "active-1",
		kind: "tool",
		phase: "active",
		status: "open",
		startedAt: "2026-08-10T10:00:00.000Z",
		updatedAt: "2026-08-10T10:00:00.000Z",
		lastMeaningfulProgressAt: "2026-08-10T10:00:00.000Z",
		...overrides,
	};
}

describe("operation timeout policy", () => {
	it("records a phase-specific absolute deadline without using the five-minute alert as a kill cap", () => {
		const policy = resolveOperationTimeoutPolicy("tool", "ipython", Date.parse("2026-08-10T10:00:00.000Z"));
		expect(policy).toMatchObject({
			timeoutClass: "owned-tool-hard-cap",
			warningAfterMs: 5 * 60_000,
			enforcement: "owned_only",
		});
		expect(policy.deadlineAt).toBe("2026-08-10T12:00:00.000Z");
	});

	it("never auto-cancels an unowned or unverifiable operation", () => {
		const deadlineAt = "2026-08-10T10:01:00.000Z";
		for (const ownershipStatus of [undefined, "unowned", "uncertain"] as const) {
			expect(
				evaluateOperationDeadline(
					record({ deadlineAt, timeoutClass: "owned-tool-hard-cap", ownershipStatus }),
					Date.parse("2026-08-10T10:02:00.000Z"),
				),
			).toBe("warn");
		}
	});

	it("permits cancellation only after process ownership is proven", () => {
		const owned = record({
			deadlineAt: "2026-08-10T10:01:00.000Z",
			timeoutClass: "owned-tool-hard-cap",
			ownershipStatus: "owned",
		});
		expect(evaluateOperationDeadline(owned, Date.parse("2026-08-10T10:02:00.000Z"))).toBe("warn");
		expect(evaluateOperationDeadline(owned, Date.parse("2026-08-10T10:02:00.000Z"), true)).toBe("cancel");
	});

	it("keeps provider and turn deadlines advisory", () => {
		const providerPolicy = resolveOperationTimeoutPolicy("provider", undefined, 0);
		expect(providerPolicy.enforcement).toBe("advisory");
		expect(
			evaluateOperationDeadline(
				record({
					kind: "provider",
					deadlineAt: providerPolicy.deadlineAt,
					timeoutClass: providerPolicy.timeoutClass,
				}),
				Date.parse(providerPolicy.deadlineAt) + 1,
			),
		).toBe("warn");
	});
});
