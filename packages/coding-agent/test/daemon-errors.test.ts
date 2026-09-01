import { describe, expect, it } from "vitest";
import { SessionAlreadyActiveError } from "../src/core/session-lease.js";
import {
	DaemonSessionCreateError,
	deserializeDaemonCreateError,
	deserializeDaemonError,
	RlmChildRosterChangedError,
	serializeDaemonError,
} from "../src/modes/daemon/daemon-errors.js";

describe("deserializeDaemonCreateError", () => {
	it("wraps generic create failures so the CLI boundary prints one line instead of rethrowing", () => {
		const error = deserializeDaemonCreateError({
			type: "response",
			command: "create",
			success: false,
			error: "Failed to spawn session worker: spawn node EMFILE",
		});
		expect(error).toBeInstanceOf(DaemonSessionCreateError);
		expect(error.message).toContain("EMFILE");
	});

	it("preserves typed daemon errors for their dedicated boundaries", () => {
		const error = deserializeDaemonCreateError({
			type: "response",
			command: "create",
			success: false,
			error: "session already active",
			errorInfo: { code: "session_already_active", sessionPath: "/tmp/session.jsonl" },
		});
		expect(error).toBeInstanceOf(SessionAlreadyActiveError);
	});
});

describe("RLM child roster errors", () => {
	it("round-trips the authoritative sequence mismatch", () => {
		const source = new RlmChildRosterChangedError(17, 18);
		const errorInfo = serializeDaemonError(source);
		expect(errorInfo).toEqual({
			code: "rlm_child_roster_changed",
			expectedEventSequence: 17,
			actualEventSequence: 18,
		});

		const restored = deserializeDaemonError({
			type: "response",
			command: "cancel_rlm_child",
			success: false,
			error: source.message,
			errorInfo,
		});
		expect(restored).toBeInstanceOf(RlmChildRosterChangedError);
		expect(restored).toMatchObject({ expectedEventSequence: 17, actualEventSequence: 18 });
	});
});
