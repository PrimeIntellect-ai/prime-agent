/** Wire-safe types for the immediate /rlm-max-depth state APIs. */

export type RlmMaxDepthSource = "default" | "env" | "global" | "inherited" | "chat";

export interface RlmMaxDepthStatus {
	maxDepth: number;
	source: RlmMaxDepthSource;
}

export interface SetRlmMaxDepthResult extends RlmMaxDepthStatus {
	globalSaved: boolean;
	globalError?: string;
}
