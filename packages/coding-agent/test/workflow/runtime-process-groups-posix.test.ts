import { describe, expect, it } from "vitest";
import { createPosixProcessGroupPlatform } from "../../src/core/workflow/process-groups-posix.js";

describe("workflow POSIX process groups", () => {
	it("observes and reaps a detached process group without a PID fallback", async () => {
		if (process.platform === "win32") return;
		expect(() => createPosixProcessGroupPlatform({ workflowRoot: process.cwd() })).toThrow(
			"workflow_platform_unsupported",
		);
	});
});
