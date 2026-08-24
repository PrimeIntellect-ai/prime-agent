import { isAgentSessionMessage } from "../../core/agent-messages.js";
import type { AgentConnectionSessionEvent } from "../agent-connection/index.js";

export type AgentActivity = "waiting" | "thinking" | "writing" | "writing-code" | "executing";

export interface AgentActivityStatus {
	activity: AgentActivity;
	direction: "down" | "up";
	tokens: number;
}

export const AGENT_ACTIVITY_LABELS: Record<AgentActivity, string> = {
	waiting: "Waiting",
	thinking: "Thinking",
	writing: "Writing",
	"writing-code": "Writing code",
	executing: "Executing",
};

const CHARS_PER_TOKEN_ESTIMATE = 4;

export class AgentActivityTracker {
	private activity: AgentActivity = "waiting";
	private completedTokens = 0;
	private streamingUsageTokens = 0;
	private streamingChars = 0;
	private runningToolCount = 0;
	// Providers like Anthropic only report usage at the start and end of a message, so the
	// live count leans on the character estimate in between. Keeping the reported value
	// monotonic prevents it from dipping when authoritative usage arrives at message end.
	private reportedTokens = 0;

	handleEvent(event: AgentConnectionSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.activity = "waiting";
				this.runningToolCount = 0;
				break;

			case "message_start":
				if (event.message.role === "user" || isAgentSessionMessage(event.message)) {
					this.reset();
				} else if (event.message.role === "assistant") {
					this.activity = "waiting";
					this.streamingUsageTokens = 0;
					this.streamingChars = 0;
				}
				break;

			case "message_update": {
				if (event.message.role !== "assistant") break;
				const streamEvent = event.assistantMessageEvent;
				switch (streamEvent.type) {
					case "thinking_start":
					case "thinking_delta":
						this.activity = "thinking";
						break;
					case "text_start":
					case "text_delta":
						this.activity = "writing";
						break;
					case "toolcall_start":
					case "toolcall_delta":
						this.activity = "writing-code";
						break;
					default:
						break;
				}
				if ("delta" in streamEvent) {
					this.streamingChars += streamEvent.delta.length;
				}
				this.streamingUsageTokens = event.message.usage.output;
				break;
			}

			case "message_end":
				if (event.message.role !== "assistant") break;
				this.completedTokens +=
					event.message.usage.output > 0 ? event.message.usage.output : this.estimatedStreamingTokens();
				this.streamingUsageTokens = 0;
				this.streamingChars = 0;
				this.activity = "waiting";
				break;

			case "tool_execution_start":
				this.runningToolCount++;
				this.activity = "executing";
				break;

			case "tool_execution_end":
				this.runningToolCount = Math.max(0, this.runningToolCount - 1);
				if (this.runningToolCount === 0) {
					this.activity = "waiting";
				}
				break;

			default:
				break;
		}
		this.reportedTokens = Math.max(this.reportedTokens, this.currentTokens());
	}

	getStatus(): AgentActivityStatus {
		return {
			activity: this.activity,
			direction: this.activity === "waiting" || this.activity === "executing" ? "up" : "down",
			tokens: this.reportedTokens,
		};
	}

	private currentTokens(): number {
		return this.completedTokens + Math.max(this.streamingUsageTokens, this.estimatedStreamingTokens());
	}

	reset(): void {
		this.activity = "waiting";
		this.completedTokens = 0;
		this.streamingUsageTokens = 0;
		this.streamingChars = 0;
		this.runningToolCount = 0;
		this.reportedTokens = 0;
	}

	private estimatedStreamingTokens(): number {
		return Math.round(this.streamingChars / CHARS_PER_TOKEN_ESTIMATE);
	}
}

export function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}
