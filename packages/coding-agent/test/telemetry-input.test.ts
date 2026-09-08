import { describe, expect, it, vi } from "vitest";
import {
	observeTelemetryInput,
	sanitizeTelemetryInputMetadata,
	subscribeTelemetryInputs,
} from "../src/core/telemetry-input.js";

describe("safe input observation", () => {
	it("never allocates an ID or reads metadata when consent is disabled", async () => {
		const session = {};
		const randomId = vi.fn();
		const read = vi.fn();
		const unsubscribe = subscribeTelemetryInputs(session, vi.fn(), { isEnabled: () => false, randomId });
		const metadata = Object.defineProperty({}, "inputId", { get: read });
		await expect(observeTelemetryInput(session, metadata as never, async () => 42)).resolves.toBe(42);
		expect(randomId).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
		unsubscribe();
	});

	it("does not let observation initialization or delivery errors change prompt results", async () => {
		const session = {};
		let unsubscribe = subscribeTelemetryInputs(session, vi.fn(), {
			isEnabled: () => true,
			randomId: () => {
				throw new Error("entropy unavailable");
			},
		});
		await expect(observeTelemetryInput(session, undefined, async () => 42)).resolves.toBe(42);
		unsubscribe();
		unsubscribe = subscribeTelemetryInputs(
			session,
			() => {
				throw new Error("listener failed");
			},
			{ isEnabled: () => true },
		);
		const original = new Error("original failure");
		await expect(
			observeTelemetryInput(session, undefined, async () => {
				throw original;
			}),
		).rejects.toBe(original);
		unsubscribe();
	});

	it("keeps only random analytics IDs, bounded categories and approved recovery actions", () => {
		const inputId = "10000000-0000-4000-8000-000000000001";
		const sanitized = sanitizeTelemetryInputMetadata({
			inputId,
			clientSessionId: "private-session",
			recoveryAction: "private-action",
			setupContext: {
				providerCategory: "customer-provider",
				authSource: "private-key",
				teamScope: "team-123",
				endpointCategory: "https://private.example",
			},
			message: "private prompt",
		});
		expect(sanitized).toEqual({
			inputId,
			setupContext: {
				providerCategory: "unknown",
				modelCategory: "unknown",
				authSource: "unknown",
				teamScope: "unknown",
				endpointCategory: "unknown",
			},
		});
		expect(sanitizeTelemetryInputMetadata({ inputId: "private-path" })).toBeUndefined();
	});
});
