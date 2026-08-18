import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createHostRequestHandler,
	type HostRequestContext,
	type RegisteredHostRequestHandlers,
} from "../../src/core/kernel/index.js";
import { createHarness, type Harness } from "./harness.js";

const CONTEXT_CELL = {
	code: 'from rlm import host_request\nawait host_request("test.context", {"runContext": "spoofed", "mode": "capture"})',
};

function latestTask(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function filesContain(root: string, needle: string): boolean {
	if (!existsSync(root)) return false;
	for (const name of readdirSync(root)) {
		const path = `${root}/${name}`;
		if (statSync(path).isDirectory()) {
			if (filesContain(path, needle)) return true;
		} else if (readFileSync(path).includes(Buffer.from(needle))) {
			return true;
		}
	}
	return false;
}

function contextHandler(captured: HostRequestContext[]): RegisteredHostRequestHandlers {
	return {
		"test.context": createHostRequestHandler(async (payload, context) => {
			captured.push(context);
			if (payload.mode === "fail") throw new Error("host handler failed");
			if (payload.mode === "block") {
				await new Promise<never>((_resolve, reject) => {
					const abort = () => reject(new Error("host handler aborted"));
					context.signal.addEventListener("abort", abort, { once: true });
					if (context.signal.aborted) abort();
				});
			}
			return { observed: true };
		}),
	};
}

describe("AgentSession run-scoped kernel context", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("isolates sequential contexts, ignores payload spoofing, clears terminal scopes, and never persists them", async () => {
		const captured: HostRequestContext[] = [];
		const harness = await createHarness({
			hostRequestHandlers: contextHandler(captured),
			persistSession: true,
		});
		harnesses.push(harness);
		const first = { marker: "run-context-secret-first" };
		const second = { marker: "run-context-secret-second" };

		for (const [prompt, runContext] of [
			["first", first],
			["second", second],
		] as const) {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("ipython", CONTEXT_CELL), { stopReason: "toolUse" }),
				fauxAssistantMessage(`${prompt} done`),
			]);
			await harness.session.promptAndWait(prompt, { runContext });
		}

		expect(captured).toHaveLength(2);
		expect(captured.map((context) => context.runContext)).toEqual([first, second]);
		expect(captured.map((context) => context.recursionDepth)).toEqual([0, 0]);
		expect(captured.every((context) => context.sessionId === harness.session.sessionId)).toBe(true);
		await vi.waitFor(() => expect(captured.every((context) => context.signal.aborted)).toBe(true));

		const recovery = JSON.stringify(harness.session.getSessionActionRecoverySnapshot());
		expect(recovery).not.toContain(first.marker);
		expect(recovery).not.toContain(second.marker);
		await harness.session.disposeAsync();
		expect(filesContain(harness.tempDir, first.marker)).toBe(false);
		expect(filesContain(harness.tempDir, second.marker)).toBe(false);
	});

	it("keeps concurrent sessions isolated", async () => {
		const leftCaptured: HostRequestContext[] = [];
		const rightCaptured: HostRequestContext[] = [];
		const left = await createHarness({ hostRequestHandlers: contextHandler(leftCaptured) });
		const right = await createHarness({ hostRequestHandlers: contextHandler(rightCaptured) });
		harnesses.push(left, right);
		const leftContext = { side: "left" };
		const rightContext = { side: "right" };
		for (const harness of [left, right]) {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("ipython", CONTEXT_CELL), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
		}

		await Promise.all([
			left.session.promptAndWait("left", { runContext: leftContext }),
			right.session.promptAndWait("right", { runContext: rightContext }),
		]);

		expect(leftCaptured).toHaveLength(1);
		expect(rightCaptured).toHaveLength(1);
		expect(leftCaptured[0]?.runContext).toBe(leftContext);
		expect(rightCaptured[0]?.runContext).toBe(rightContext);
		expect(leftCaptured[0]?.sessionId).toBe(left.session.sessionId);
		expect(rightCaptured[0]?.sessionId).toBe(right.session.sessionId);
	});

	it("clears contexts after host failure and cancellation", async () => {
		const captured: HostRequestContext[] = [];
		const harness = await createHarness({ hostRequestHandlers: contextHandler(captured) });
		harnesses.push(harness);
		const failureCell = {
			code: 'from rlm import host_request\nawait host_request("test.context", {"mode": "fail"})',
		};
		const failureContext = { kind: "failure" };
		harness.setResponses([fauxAssistantMessage(fauxToolCall("ipython", failureCell), { stopReason: "toolUse" })]);
		await harness.session.prompt("fail", { runContext: failureContext });
		await vi.waitFor(() => expect(captured[0]?.signal.aborted).toBe(true));
		expect(captured[0]?.runContext).toBe(failureContext);

		const blockingCell = {
			code: 'from rlm import host_request\nawait host_request("test.context", {"mode": "block"})',
		};
		harness.setResponses([fauxAssistantMessage(fauxToolCall("ipython", blockingCell), { stopReason: "toolUse" })]);
		const cancellationContext = { kind: "cancellation" };
		const prompt = harness.session.prompt("cancel", { runContext: cancellationContext });
		await vi.waitFor(() => expect(captured).toHaveLength(2));
		await harness.session.abort();
		await Promise.allSettled([prompt]);
		expect(captured[1]?.signal.aborted).toBe(true);
		expect(captured[1]?.runContext).toBe(cancellationContext);
	});

	it("propagates one root context to sibling and nested child executions", async () => {
		const captured: HostRequestContext[] = [];
		const harness = await createHarness({
			hostRequestHandlers: contextHandler(captured),
			rlmMaxDepth: 2,
		});
		harnesses.push(harness);
		const runContext = { request: "family-context" };
		const response = (context: Context) => {
			const last = context.messages.at(-1);
			if (last?.role === "toolResult") return fauxAssistantMessage("done");
			const task = latestTask(context);
			if (task.includes("child-a")) {
				return fauxAssistantMessage(
					fauxToolCall("ipython", {
						code: 'from rlm import host_request\nawait host_request("test.context")\nawait rlm("grandchild", name="grandchild")',
					}),
					{ stopReason: "toolUse" },
				);
			}
			if (task.includes("child-b") || task.includes("grandchild")) {
				return fauxAssistantMessage(
					fauxToolCall("ipython", {
						code: 'from rlm import host_request\nawait host_request("test.context")',
					}),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage(
				fauxToolCall("ipython", {
					code: 'from rlm import host_request\nawait rlm("child-a", name="child-a")\nawait rlm("child-b", name="child-b")\nawait host_request("test.context")',
				}),
				{ stopReason: "toolUse" },
			);
		};
		harness.setResponses(Array.from({ length: 16 }, () => response));

		await harness.session.promptAndWait("root", { runContext });
		await vi.waitFor(
			() => {
				const inherited = captured.filter((context) => context.runContext === runContext);
				const depthCounts = new Map<number, number>();
				for (const context of inherited) {
					depthCounts.set(context.recursionDepth, (depthCounts.get(context.recursionDepth) ?? 0) + 1);
				}
				expect(depthCounts.get(0)).toBeGreaterThanOrEqual(1);
				expect(depthCounts.get(1)).toBeGreaterThanOrEqual(2);
				expect(depthCounts.get(2)).toBeGreaterThanOrEqual(1);
				expect(new Set(inherited.map((context) => context.sessionId)).size).toBe(4);
			},
			{ timeout: 10_000 },
		);
	});
});
