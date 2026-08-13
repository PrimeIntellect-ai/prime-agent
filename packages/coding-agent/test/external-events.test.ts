import { describe, expect, it, vi } from "vitest";
import {
	createExternalEventHostHandler,
	EXTERNAL_EVENT_MAX_RETAINED_IDS,
	EXTERNAL_EVENT_MAX_TEXT_CHARS,
	ExternalEventRegistry,
} from "../src/core/external-events.js";

describe("external event host registry", () => {
	it("coalesces by producer name and stable event ID", async () => {
		const registry = new ExternalEventRegistry();
		const emit = vi.fn(async () => "queued" as const);
		const handler = createExternalEventHostHandler(registry, emit);
		const payload = {
			name: "matrix",
			event_id: "$event operator",
			text: "operator message",
			delivery_policy: "steer",
		};

		await expect(handler(payload)).resolves.toMatchObject({ deliveryStatus: "queued" });
		await expect(handler({ ...payload, text: "duplicate" })).resolves.toMatchObject({
			deliveryStatus: "coalesced",
		});
		await expect(handler({ ...payload, name: "other" })).resolves.toMatchObject({ deliveryStatus: "queued" });
		await expect(handler({ ...payload, name: "matrix $event", event_id: "operator" })).resolves.toMatchObject({
			deliveryStatus: "queued",
		});
		expect(emit).toHaveBeenCalledTimes(3);
	});

	it("rejects malformed or oversized inputs before admission", async () => {
		const registry = new ExternalEventRegistry();
		const emit = vi.fn(async () => "delivered" as const);
		const handler = createExternalEventHostHandler(registry, emit);
		const payload = { name: "watch", event_id: "event", text: "message", delivery_policy: "followUp" };

		await expect(handler({ ...payload, name: " " })).rejects.toThrow("name cannot be empty");
		await expect(handler({ ...payload, text: "x".repeat(EXTERNAL_EVENT_MAX_TEXT_CHARS + 1) })).rejects.toThrow(
			"text is too long",
		);
		await expect(handler({ ...payload, delivery_policy: "next" })).rejects.toThrow("delivery_policy must be");
		expect(emit).not.toHaveBeenCalled();
	});

	it("bounds completed IDs and rejects admission after disposal", async () => {
		const registry = new ExternalEventRegistry();
		for (let index = 0; index <= EXTERNAL_EVENT_MAX_RETAINED_IDS; index++) {
			await expect(registry.admit("watch", String(index), async () => "queued")).resolves.toBe("queued");
		}
		expect(registry.size).toBe(EXTERNAL_EVENT_MAX_RETAINED_IDS);
		await expect(registry.admit("watch", "0", async () => "queued")).resolves.toBe("queued");
		registry.dispose();
		expect(registry.size).toBe(0);
		await expect(registry.admit("watch", "later", async () => "queued")).rejects.toThrow("session was disposed");
	});

	it("shares an in-flight failure with duplicates and permits a later retry", async () => {
		const registry = new ExternalEventRegistry();
		let rejectFirst!: (error: Error) => void;
		const firstAdmission = new Promise<"delivered">((_resolve, reject) => {
			rejectFirst = reject;
		});
		const emit = vi.fn().mockReturnValueOnce(firstAdmission).mockResolvedValueOnce("delivered");
		const handler = createExternalEventHostHandler(registry, emit);
		const payload = { name: "watch", event_id: "retry", text: "event", delivery_policy: "followUp" };

		const first = handler(payload);
		const duplicate = handler({ ...payload, text: "duplicate" });
		expect(emit).toHaveBeenCalledTimes(0);
		const firstFailure = expect(first).rejects.toThrow("busy");
		const duplicateFailure = expect(duplicate).rejects.toThrow("busy");
		await Promise.resolve();
		expect(emit).toHaveBeenCalledTimes(1);
		rejectFirst(new Error("busy"));
		await Promise.all([firstFailure, duplicateFailure]);

		await expect(handler(payload)).resolves.toMatchObject({ deliveryStatus: "delivered" });
		expect(emit).toHaveBeenCalledTimes(2);
	});
});
