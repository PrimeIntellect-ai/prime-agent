import type { CreateRlmSubagentRuntimeOptions, RlmSubagentRuntime } from "../src/core/rlm-runtime.js";

declare module "../src/core/rlm-runtime.js" {
	interface SubagentRuntimeHost {
		/** Compile-time compatibility for pre-fire-and-forget tests only. */
		releaseRlmSubagentRuntime?: (
			runtime: RlmSubagentRuntime,
			options: CreateRlmSubagentRuntimeOptions,
			status: "done" | "error" | "cancelled",
		) => Promise<void>;
	}
}
