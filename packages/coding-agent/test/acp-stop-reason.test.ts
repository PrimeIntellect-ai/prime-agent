import { describe, expect, it } from "vitest";
import type { AgentAutonomousStatus } from "../src/core/autonomous.js";
import { acpStopReason } from "../src/modes/acp/acp-stop-reason.js";

function status(overrides: Partial<AgentAutonomousStatus> = {}): AgentAutonomousStatus {
	return {
		enabled: true,
		continuationsUsed: 0,
		turnsUsed: 0,
		tokensUsed: 0,
		limits: {
			maxContinuations: 3,
			maxTurns: 100,
			maxTokens: 80_000,
			timeoutMs: 30 * 60 * 1000,
		},
		gates: { commands: [], maxRetries: 1, timeoutMs: 60_000 },
		gateAttempts: {},
		...overrides,
	} as AgentAutonomousStatus;
}

describe("ACP stop reasons", () => {
	it("reports cancellation ahead of any autonomous state", () => {
		expect(acpStopReason({ cancelled: true })).toBe("cancelled");
		expect(acpStopReason({ cancelled: true, autonomous: status({ tokensUsed: 999_999 }) })).toBe("cancelled");
	});

	it("ends the turn normally without autonomous mode", () => {
		expect(acpStopReason({ cancelled: false })).toBe("end_turn");
		expect(acpStopReason({ cancelled: false, autonomous: status({ enabled: false }) })).toBe("end_turn");
	});

	it("maps token exhaustion to max_tokens", () => {
		expect(acpStopReason({ cancelled: false, autonomous: status({ tokensUsed: 80_000 }) })).toBe("max_tokens");
	});

	it("never reports a stopped autonomous run as a clean end_turn", () => {
		const timedOut = status({ startedAt: Date.now() - 60 * 60 * 1000 });
		expect(acpStopReason({ cancelled: false, autonomous: timedOut })).toBe("max_turn_requests");
		expect(acpStopReason({ cancelled: false, autonomous: status({ turnsUsed: 100 }) })).toBe("max_turn_requests");
		expect(acpStopReason({ cancelled: false, autonomous: status({ continuationsUsed: 3 }) })).toBe(
			"max_turn_requests",
		);
	});

	it("ends the turn when autonomous mode is enabled but no limit was hit", () => {
		expect(acpStopReason({ cancelled: false, autonomous: status({ turnsUsed: 1 }) })).toBe("end_turn");
	});
});
