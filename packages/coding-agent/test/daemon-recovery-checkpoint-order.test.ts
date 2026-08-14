import { describe, expect, it } from "vitest";
import { shouldDeferRecoveryCheckpoint } from "../src/modes/daemon/daemon-mode.js";

describe("worker recovery checkpoint ordering", () => {
	it("defers settlement events until runtime flags have quiesced", () => {
		for (const event of [
			"agent_end",
			"turn_end",
			"message_end",
			"tool_execution_end",
			"compaction_end",
			"auto_retry_end",
			"bash_end",
		]) {
			expect(shouldDeferRecoveryCheckpoint(event)).toBe(true);
		}
	});

	it("records start events immediately", () => {
		for (const event of ["agent_start", "turn_start", "tool_execution_start", "bash_start"]) {
			expect(shouldDeferRecoveryCheckpoint(event)).toBe(false);
		}
	});
});
