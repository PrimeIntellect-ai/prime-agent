import { describe, expect, it } from "vitest";
import { SessionAlreadyActiveError } from "../src/core/session-lease.js";
import {
	DaemonSessionCreateError,
	DaemonSessionRecoveringError,
	DaemonUpdateRestartingError,
	deserializeDaemonCreateError,
	deserializeDaemonError,
	isDaemonUpdateRestartingError,
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

describe("session_recovering wire round-trip", () => {
	it("serializes for old clients (readable message) and deserializes for new clients (typed, retryable)", () => {
		const error = new DaemonSessionRecoveringError("active-gap");
		const errorInfo = serializeDaemonError(error);
		expect(errorInfo).toEqual({ code: "session_recovering", activeSessionId: "active-gap" });
		// Old client / new daemon: errorInfo is ignored, the message alone must carry the state.
		expect(error.message).toBe("Active session active-gap is recovering; retry shortly");
		const roundTripped = deserializeDaemonError({
			type: "response",
			command: "attach",
			success: false,
			error: error.message,
			errorInfo,
		});
		expect(roundTripped).toBeInstanceOf(DaemonSessionRecoveringError);
		expect((roundTripped as DaemonSessionRecoveringError).activeSessionId).toBe("active-gap");
		// New client / old daemon: a plain unknown-session failure stays a plain error.
		const legacy = deserializeDaemonError({
			type: "response",
			command: "attach",
			success: false,
			error: "Unknown active session: active-gap",
		});
		expect(legacy).not.toBeInstanceOf(DaemonSessionRecoveringError);
	});
});

describe("update_restarting wire round-trip", () => {
	it("serializes for old clients (readable message) and deserializes for new clients (typed, retryable)", () => {
		const error = new DaemonUpdateRestartingError();
		const errorInfo = serializeDaemonError(error);
		expect(errorInfo).toEqual({ code: "update_restarting" });
		expect(error.message).toBe("Daemon is preparing an update restart");
		const roundTripped = deserializeDaemonError({
			type: "response",
			command: "create",
			success: false,
			error: error.message,
			errorInfo,
		});
		expect(roundTripped).toBeInstanceOf(DaemonUpdateRestartingError);
		const legacy = deserializeDaemonError({
			type: "response",
			command: "create",
			success: false,
			error: "Daemon is preparing an update restart",
		});
		expect(legacy).not.toBeInstanceOf(DaemonUpdateRestartingError);
		expect(isDaemonUpdateRestartingError(legacy)).toBe(true);
		expect(isDaemonUpdateRestartingError(new Error("Unknown active session: active-gap"))).toBe(false);
	});
});
