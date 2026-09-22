import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { CustomMessage } from "./messages.js";

export const TOOL_INTENT_RECOVERY_CUSTOM_TYPE = "tool_intent_recovery";

/** Hidden model-facing retry message. */
export function createToolIntentRecoveryMessage(timestamp = Date.now()): CustomMessage {
	return {
		role: "custom",
		customType: TOOL_INTENT_RECOVERY_CUSTOM_TYPE,
		content:
			"Your previous reply ended before it was complete. If you were about to call a tool, call it now within the user's existing instructions and permissions; otherwise finish the reply. Do not repeat the preamble.",
		display: false,
		timestamp,
	};
}

/**
 * Match protocol finishes eligible for a retry when no tool call was delivered.
 * `toolUse` qualifies on any model; `length` only when the model's catalog entry
 * sets `compat.retryOnTruncatedToolCall`. A plain `stop` never qualifies.
 */
export function isDroppedToolCallStop(message: AssistantMessage, model: Model<string> | undefined): boolean {
	if (message.content.some((part) => part.type === "toolCall")) {
		return false;
	}
	switch (message.stopReason) {
		case "toolUse":
			return true;
		case "length":
			return retriesOnTruncatedToolCall(model);
		default:
			return false;
	}
}

function retriesOnTruncatedToolCall(model: Model<string> | undefined): boolean {
	if (model?.api !== "openai-completions") {
		return false;
	}
	// `Model<string>` erases the per-API compat type; the api check selects it.
	return (model as Model<"openai-completions">).compat?.retryOnTruncatedToolCall === true;
}
