import { describe, expect, it } from "vitest";
import { PromptAdmissionCancelledError, waitForPromptAdmission } from "../src/core/prompt-admission.js";

describe("waitForPromptAdmission", () => {
	it("observes already-running work when admission is pre-aborted", async () => {
		const abort = new AbortController();
		abort.abort();
		const work = Promise.reject(new Error("late failure"));

		await expect(waitForPromptAdmission(work, abort.signal)).rejects.toThrow("Prompt admission was cancelled.");
		// Let the observed work settle; an unhandled rejection would fail Vitest.
		await Promise.resolve();
	});

	it("rejects with the typed cancellation error when the signal aborts mid-wait", async () => {
		const abort = new AbortController();
		const wait = waitForPromptAdmission(new Promise(() => {}), abort.signal);
		abort.abort();
		await expect(wait).rejects.toBeInstanceOf(PromptAdmissionCancelledError);
	});

	it("passes work through untouched without a signal and settles with the work otherwise", async () => {
		const resolved = Promise.resolve("value");
		expect(waitForPromptAdmission(resolved, undefined)).toBe(resolved);
		await expect(waitForPromptAdmission(resolved, new AbortController().signal)).resolves.toBe("value");
		await expect(
			waitForPromptAdmission(Promise.reject(new Error("work failed")), new AbortController().signal),
		).rejects.toThrow("work failed");
	});
});
