import { describe, expect, it } from "vitest";
import { SessionAlreadyActiveError } from "../src/core/session-lease.js";
import { DaemonSessionCreateError, deserializeDaemonCreateError } from "../src/modes/daemon/daemon-errors.js";

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
