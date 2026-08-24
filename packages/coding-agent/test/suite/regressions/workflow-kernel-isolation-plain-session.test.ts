import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

/**
 * A session that merely *can* run a workflow must still run code.
 *
 * Regression: the kernel isolation guard threw whenever a workflow host loader was
 * registered, and services register one for every persisted session. That made IPython
 * — the primary tool — fail in every ordinary session with
 * "workflow kernel isolation requires a bound workflow identity".
 */
describe("kernel isolation in a plain session", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("resolves kernel isolation when a workflow host loader exists but no workflow is bound", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		const session = harness.session as unknown as {
			_workflowHostLoader?: () => Promise<void>;
			_resolveKernelIsolation(): unknown;
		};
		// Reproduce the exact production precondition: the capability is registered,
		// but the user never started a workflow.
		session._workflowHostLoader ??= async () => {};

		expect(session._workflowHostLoader).toBeDefined();
		expect(() => session._resolveKernelIsolation()).not.toThrow();
		expect(session._resolveKernelIsolation()).toBeUndefined();
	});
});
