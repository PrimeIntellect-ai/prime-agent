import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHarness, type Harness } from "./harness.js";

/** A promise with its resolve/reject functions exposed. */
export interface Deferred<T = void> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

export function createDeferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * A before_agent_start gate as an extension factory: `reached` resolves when the
 * hook first runs (optionally filtered by prompt), `release()` lets gated runs
 * proceed, and `runs` records the prompts the hook observed.
 */
export function gatedHook(options: { prompt?: string } = {}): {
	factory: (pi: ExtensionAPI) => void;
	reached: Promise<void>;
	release: () => void;
	runs: string[];
} {
	const reached = createDeferred();
	const gate = createDeferred();
	const runs: string[] = [];
	return {
		factory: (pi) => {
			pi.on("before_agent_start", async (event) => {
				if (options.prompt !== undefined && event.prompt !== options.prompt) return;
				runs.push(event.prompt);
				reached.resolve();
				await gate.promise;
			});
		},
		reached: reached.promise,
		release: gate.resolve,
		runs,
	};
}

/** Force the harness agent's streaming flag, replacing the `as { isStreaming: boolean }` cast idiom. */
export function withStreaming(harness: Harness, on: boolean): void {
	(harness.session.agent.state as { isStreaming: boolean }).isStreaming = on;
}

export interface WaitingHarness {
	harness: Harness;
	releaseToolExecution: () => void;
	promptPromise: Promise<void>;
	waitForToolStart: Promise<void>;
}

/**
 * Harness whose first turn calls a gated "wait" tool: the run stays streaming
 * until `releaseToolExecution()` is called, so tests can queue inputs mid-run.
 */
export async function createWaitingHarness(
	options: { tools?: AgentTool[]; extensionFactories?: Array<(pi: ExtensionAPI) => void> } = {},
): Promise<WaitingHarness> {
	const toolRelease = createDeferred();
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({
		tools: [waitTool, ...(options.tools ?? [])],
		extensionFactories: options.extensionFactories,
	});
	const waitForToolStart = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				unsubscribe();
				resolve();
			}
		});
	});
	return {
		harness,
		releaseToolExecution: toolRelease.resolve,
		promptPromise: harness.session.prompt("start"),
		waitForToolStart,
	};
}
