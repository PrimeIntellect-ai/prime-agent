import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.js";
import { gatedHook, withStreaming } from "./scheduling.js";

describe("AgentSession action contracts", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("parses session commands only through prompt provenance", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("literal handled")]);

		await harness.session.prompt("/compact");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "session_slash_command",
			),
		).toBe(true);

		await harness.session.steer("/compact", undefined, { resumeIfIdle: true });
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["/compact"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("runs input handlers before deciding whether busy submissions enter a queue", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) =>
						event.text === "handled"
							? { action: "handled" }
							: { action: "transform", text: `transformed:${event.text}` },
					);
				},
			],
		});
		harnesses.push(harness);
		withStreaming(harness, true);

		await harness.session.prompt("queued", { streamingBehavior: "followUp" });
		await harness.session.prompt("handled", { streamingBehavior: "followUp" });

		expect(harness.session.getFollowUpMessages()).toEqual(["transformed:queued"]);
		expect(harness.session.queuedActionCount).toBe(1);
		withStreaming(harness, false);
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: ["transformed:queued"] });
	});

	it("wakes idle sessions with literal text and coalesces stable event IDs", async () => {
		const gate = gatedHook({ prompt: " /compact wake now" });
		const harness = await createHarness({ extensionFactories: [gate.factory] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		const first = harness.session.handleExternalEventHostRequest({
			name: "matrix",
			event_id: "$idle",
			text: " /compact wake now",
			delivery_policy: "followUp",
		});
		await gate.reached;
		let duplicateSettled = false;
		const duplicate = harness.session
			.handleExternalEventHostRequest({
				name: "matrix",
				event_id: "$idle",
				text: "duplicate body",
				delivery_policy: "steer",
			})
			.finally(() => {
				duplicateSettled = true;
			});
		await Promise.resolve();
		expect(duplicateSettled).toBe(false);

		gate.release();
		await expect(first).resolves.toMatchObject({
			accepted: true,
			deliveryStatus: "delivered",
			eventId: "$idle",
		});
		await expect(duplicate).resolves.toMatchObject({ accepted: true, deliveryStatus: "coalesced" });
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual([]);
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "external_event",
			),
		).toEqual([
			expect.objectContaining({
				content: " /compact wake now",
				details: { name: "matrix", eventId: "$idle" },
			}),
		]);
	});

	it("applies declared external-event delivery while busy", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		withStreaming(harness, true);

		await expect(
			harness.session.handleExternalEventHostRequest({
				name: "watch",
				event_id: "steer-1",
				text: "steer event",
				delivery_policy: "steer",
			}),
		).resolves.toMatchObject({ deliveryStatus: "queued" });
		await expect(
			harness.session.handleExternalEventHostRequest({
				name: "watch",
				event_id: "follow-1",
				text: "follow event",
				delivery_policy: "followUp",
			}),
		).resolves.toMatchObject({ deliveryStatus: "queued" });
		expect(harness.session.getSteeringMessages()).toEqual(["steer event"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["follow event"]);
		withStreaming(harness, false);
		harness.session.clearQueue();
	});

	it("bounds pending external events and closes admission on disposal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		withStreaming(harness, true);
		for (let index = 0; index < 128; index++) {
			await harness.session.handleExternalEventHostRequest({
				name: "bounded",
				event_id: String(index),
				text: `event ${index}`,
				delivery_policy: "followUp",
			});
		}
		await expect(
			harness.session.handleExternalEventHostRequest({
				name: "bounded",
				event_id: "overflow",
				text: "overflow",
				delivery_policy: "followUp",
			}),
		).rejects.toThrow("queue is full");
		withStreaming(harness, false);
		harness.session.clearQueue();
		const disposing = harness.session.disposeAsync();
		await expect(
			harness.session.handleExternalEventHostRequest({
				name: "bounded",
				event_id: "after-dispose",
				text: "after disposal",
				delivery_policy: "steer",
			}),
		).rejects.toThrow("session was disposed");
		await disposing;
	});

	it("registers the external-event kernel host method", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const handlers = (
			harness.session as unknown as { _createKernelHostHandlers(): Record<string, unknown> }
		)._createKernelHostHandlers();
		expect(handlers["session.external_event.emit"]).toBeTypeOf("function");
	});

	it("gives nextTurn delivery precedence over triggerTurn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.sendCustomMessage(
			{ customType: "precedence", content: "context only", display: true },
			{ triggerTurn: true, deliverAs: "nextTurn" },
		);

		expect(harness.session.messages).toEqual([]);
		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);

		await harness.session.prompt("consume context");
		expect(harness.session.messages.map((message) => message.role)).toEqual(["custom", "user", "assistant"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("restores normalized payloads without interception, parsing, or an idle wake", async () => {
		let inputHandlerRuns = 0;
		let extensionCommandRuns = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						inputHandlerRuns++;
						return { action: "transform", text: "rewritten" };
					});
					pi.registerCommand("literal", {
						description: "must stay literal",
						handler: async () => {
							extensionCommandRuns++;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("steer done"), fauxAssistantMessage("follow-up done")]);

		await harness.session.restoreFollowUpMessage("/compact");
		await harness.session.restoreSteeringMessage("/literal keep text");
		await Promise.resolve();

		expect(inputHandlerRuns).toBe(0);
		expect(extensionCommandRuns).toBe(0);
		expect(harness.session.getSteeringMessages()).toEqual(["/literal keep text"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["/compact"]);
		expect(harness.session.messages).toEqual([]);

		expect(harness.session.resumeQueuedWork()).toBe(true);
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["/literal keep text", "/compact"]);
		expect(inputHandlerRuns).toBe(0);
		expect(extensionCommandRuns).toBe(0);
	});
});
