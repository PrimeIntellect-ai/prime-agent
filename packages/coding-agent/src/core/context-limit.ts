/** Wire-safe types for the /context-limit status APIs. */

export type ContextLimitSource = "chat" | "project" | "global" | "none";

export interface ContextLimitStatus {
	/** Model context window; 0 when unknown. */
	contextWindow: number;
	reserveTokens: number;
	/** Configured cap before anti-thrash clamping; undefined when no cap is set. */
	maxContextTokens?: number;
	source: ContextLimitSource;
	/** Cap after anti-thrash clamping; undefined when no cap is set. */
	effectiveCap?: number;
	/** True when the configured cap was raised to the anti-thrash floor. */
	clamped: boolean;
	/** Context-token point where auto-compaction fires; null when the window is unknown. */
	compactAt: number | null;
	/** Current estimated context tokens; null when unknown. */
	contextTokens: number | null;
	/** Whether auto-compaction is enabled at all. */
	enabled: boolean;
}
