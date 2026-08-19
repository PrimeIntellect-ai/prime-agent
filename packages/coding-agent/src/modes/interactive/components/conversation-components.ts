import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Component, MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { isAgentSessionMessage } from "../../../core/agent-messages.js";
import {
	COMPACTION_OUTCOME_CUSTOM_TYPE,
	isCompactionOutcomeMessage,
	isRefinementOutcomeMessage,
	isSessionSlashCommandMessage,
	isSessionSlashCommandResultMessage,
	REFINEMENT_OUTCOME_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
} from "../../../core/messages.js";
import { AgentMessageComponent } from "./agent-message.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { BashExecutionComponent } from "./bash-execution.js";
import {
	CompactionOutcomeMessageComponent,
	MalformedCompactionOutcomeMessageComponent,
} from "./compaction-outcome-message.js";
import { InjectedPromptMessageComponent, isInjectedPromptMessage } from "./injected-prompt-message.js";
import { IPythonCellComponent } from "./ipython-cell.js";
import {
	MalformedRefinementOutcomeMessageComponent,
	RefinementOutcomeMessageComponent,
} from "./refinement-outcome-message.js";
import { SlashCommandMessageComponent } from "./slash-command-message.js";
import { SlashCommandResultMessageComponent } from "./slash-command-result-message.js";
import {
	selectLatestToolExpandHint,
	ToolExecutionComponent,
	type ToolExecutionDefinition,
	type ToolExecutionOptions,
} from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

export interface ConversationComponentsOptions {
	ui: TUI;
	cwd: string;
	toolOptions: ToolExecutionOptions;
	getToolDefinition: (name: string) => ToolExecutionDefinition | undefined;
	markdownTheme?: MarkdownTheme;
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
	toolsExpanded?: boolean;
	agentMessagesExpanded?: boolean;
	editDiffsExpanded?: boolean;
	isRecognizedSlashCommand?: (name: string) => boolean;
}

export function isCompactAgentMessageNeighbor(component: Component | undefined): boolean {
	return (
		component instanceof AgentMessageComponent ||
		component instanceof ToolExecutionComponent ||
		component instanceof IPythonCellComponent ||
		component instanceof BashExecutionComponent
	);
}

function readUserText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("");
}

/** Build conversation components from a message list, matching tool results to their calls. */
export function buildConversationComponents(
	messages: readonly AgentMessage[],
	options: ConversationComponentsOptions,
): Component[] {
	const components: Component[] = [];
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const expanded = options.toolsExpanded ?? false;
	const agentMessagesExpanded = options.agentMessagesExpanded ?? false;
	const editDiffsExpanded = options.editDiffsExpanded ?? false;

	for (const message of messages) {
		if (message.role === "assistant") {
			components.push(
				new AssistantMessageComponent(
					message,
					options.hideThinkingBlock ?? false,
					options.markdownTheme,
					options.hiddenThinkingLabel ?? "Thinking...",
					{
						expanded,
						precededByToolActivity:
							components.at(-1) instanceof ToolExecutionComponent ||
							components.at(-1) instanceof AgentMessageComponent,
					},
				),
			);
			for (const content of message.content) {
				if (content.type !== "toolCall") {
					continue;
				}
				const tool = new ToolExecutionComponent(
					content.name,
					content.id,
					content.arguments,
					{ ...options.toolOptions, includeImageDimensions: false },
					options.getToolDefinition(content.name),
					options.ui,
					options.cwd,
				);
				tool.setExpanded(expanded);
				tool.setAgentMessagesExpanded(agentMessagesExpanded);
				tool.setEditDiffsExpanded(editDiffsExpanded);
				tool.markExecutionStarted();
				tool.setArgsComplete();
				selectLatestToolExpandHint(components, tool);
				components.push(tool);
				if (message.stopReason === "aborted" || message.stopReason === "error") {
					tool.updateResult({
						content: [{ type: "text", text: message.errorMessage || "Operation aborted" }],
						isError: true,
					});
				} else {
					pendingTools.set(content.id, tool);
				}
			}
		} else if (message.role === "toolResult") {
			pendingTools.get(message.toolCallId)?.updateResult(message);
			pendingTools.delete(message.toolCallId);
		} else if (
			message.role === "custom" &&
			(message.customType === SESSION_SLASH_COMMAND_CUSTOM_TYPE ||
				message.customType === SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE)
		) {
			if (!message.display) continue;
			if (isSessionSlashCommandMessage(message)) {
				components.push(new SlashCommandMessageComponent(message.content));
			} else if (isSessionSlashCommandResultMessage(message)) {
				components.push(new SlashCommandResultMessageComponent(message));
			} else {
				components.push(new UserMessageComponent("[Malformed session command message]", options.markdownTheme));
			}
		} else if (message.role === "custom" && message.customType === COMPACTION_OUTCOME_CUSTOM_TYPE) {
			if (!message.display) continue;
			components.push(
				isCompactionOutcomeMessage(message)
					? new CompactionOutcomeMessageComponent(message)
					: new MalformedCompactionOutcomeMessageComponent(),
			);
		} else if (message.role === "custom" && message.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE) {
			if (!message.display) continue;
			const component = isRefinementOutcomeMessage(message)
				? new RefinementOutcomeMessageComponent(message)
				: new MalformedRefinementOutcomeMessageComponent();
			component.setExpanded(expanded);
			components.push(component);
		} else if (isAgentSessionMessage(message) && message.display) {
			const component = new AgentMessageComponent(message, options.markdownTheme, {
				suppressLeadingSpace: isCompactAgentMessageNeighbor(components.at(-1)),
			});
			component.setExpanded(agentMessagesExpanded);
			components.push(component);
		} else if (isInjectedPromptMessage(message) && message.display) {
			const component = new InjectedPromptMessageComponent(message, options.markdownTheme);
			component.setExpanded(expanded);
			components.push(component);
		} else if (message.role === "user") {
			const text = readUserText(message.content);
			const hasContent =
				typeof message.content === "string" ? message.content.length > 0 : message.content.length > 0;
			// An image-only prompt has no text; show a placeholder rather than dropping it.
			const display = text || (hasContent ? "[image]" : "");
			if (display) {
				components.push(new UserMessageComponent(display, options.markdownTheme, options.isRecognizedSlashCommand));
			}
		}
		// Non-conversational messages (bash/branch-summary/compaction/other custom) aren't shown.
	}
	return components;
}
