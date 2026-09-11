import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Component, MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { isAgentSessionMessage } from "../../../core/agent-messages.js";
import {
	ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	COMPACTION_OUTCOME_CUSTOM_TYPE,
	type CustomMessage,
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
import { readShellCompletion, ShellCompletionComponent } from "./shell-completion.js";
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
	editDiffsExpanded?: boolean;
	isRecognizedSlashCommand?: (name: string) => boolean;
}

export function isCompactAgentMessageNeighbor(component: Component | undefined): boolean {
	return (
		component instanceof AgentMessageComponent ||
		component instanceof ToolExecutionComponent ||
		component instanceof IPythonCellComponent ||
		component instanceof BashExecutionComponent ||
		component instanceof ShellCompletionComponent
	);
}

export interface ConversationSpacing {
	precededByToolActivity: () => boolean;
	shouldAddLeadingSpace: (expanded: boolean) => boolean;
}

/** Keep spacing responsive to hidden thinking and late shell attachment without rendering prior blocks again. */
export function createConversationSpacing(previous: readonly Component[]): ConversationSpacing {
	const last = previous.at(-1);
	let lastIndex = previous.length - 1;
	const getPrevious = (): { component: Component; trailingSpace: boolean } | undefined => {
		if (!last) return undefined;
		if (previous[lastIndex] !== last) lastIndex = previous.indexOf(last);
		let toolSeparator: AssistantMessageComponent | undefined;
		for (let index = lastIndex; index >= 0; index--) {
			const component = previous[index]!;
			if (component instanceof AssistantMessageComponent) {
				const content = component.getSpacingContent();
				if (content === "hidden") continue;
				if (content === "tool-only") {
					toolSeparator ??= component;
					continue;
				}
				return toolSeparator
					? { component: toolSeparator, trailingSpace: true }
					: { component, trailingSpace: component.hasTrailingSpace() };
			}
			if (component instanceof ShellCompletionComponent && !component.isVisible()) continue;
			if (toolSeparator && !isCompactAgentMessageNeighbor(component)) {
				return { component: toolSeparator, trailingSpace: true };
			}
			return { component, trailingSpace: false };
		}
		return toolSeparator ? { component: toolSeparator, trailingSpace: true } : undefined;
	};
	return {
		precededByToolActivity: () => isCompactAgentMessageNeighbor(getPrevious()?.component),
		shouldAddLeadingSpace: (expanded) => {
			const preceding = getPrevious();
			if (preceding?.trailingSpace) return false;
			return expanded ? preceding !== undefined : !isCompactAgentMessageNeighbor(preceding?.component);
		},
	};
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

export function createShellCompletionComponent(
	message: CustomMessage,
	previous: readonly Component[],
): ShellCompletionComponent | undefined {
	if (message.customType !== ASYNC_BASH_COMPLETION_CUSTOM_TYPE) return undefined;
	const spacing = createConversationSpacing(previous);
	const component = new ShellCompletionComponent(message, false, {
		shouldAddLeadingSpace: () => spacing.shouldAddLeadingSpace(true),
	});
	const completion = readShellCompletion(message);
	if (!completion) return component;
	const tools = previous.filter((entry): entry is ToolExecutionComponent => entry instanceof ToolExecutionComponent);
	const cleanups: (() => void)[] = [];
	const attach = () => {
		// A completion can arrive before its creating cell's final tool result.
		if (tools.some((tool) => tool.isResultPending())) return;
		for (const cleanup of cleanups) cleanup();
		const commandMatches = tools.filter(
			(tool) =>
				(tool.getBackgroundShellHandle()?.command ?? tool.getAssignedShellCommand()) === completion.details.command,
		);
		const pidMatches = commandMatches.filter(
			(tool) => tool.getBackgroundShellHandle()?.pid === completion.details.pid,
		);
		const matches = pidMatches.length > 0 ? pidMatches : commandMatches;
		if (matches.length !== 1) return;
		const match = matches[0]!;
		const handle = match.getBackgroundShellHandle();
		if (handle && handle.pid !== completion.details.pid) return;
		if (match.attachShellCompletion(completion)) component.setAttached();
	};
	for (const tool of tools) if (tool.isResultPending()) cleanups.push(tool.onResultUpdate(attach));
	attach();
	return component;
}

/** Build conversation components from a message list, matching tool results to their calls. */
export function buildConversationComponents(
	messages: readonly AgentMessage[],
	options: ConversationComponentsOptions,
): Component[] {
	const components: Component[] = [];
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const expanded = options.toolsExpanded ?? false;
	const editDiffsExpanded = options.editDiffsExpanded ?? false;

	for (const message of messages) {
		if (message.role === "assistant") {
			components.push(
				new AssistantMessageComponent(
					message,
					options.hideThinkingBlock ?? false,
					options.markdownTheme,
					options.hiddenThinkingLabel ?? "Thinking:",
					{
						cwd: options.cwd,
						expanded,
						precededByToolActivity: createConversationSpacing(components).precededByToolActivity,
					},
				),
			);
			for (const content of message.content) {
				if (content.type !== "toolCall") {
					continue;
				}
				const spacing = createConversationSpacing(components);
				const tool = new ToolExecutionComponent(
					content.name,
					content.id,
					content.arguments,
					{
						...options.toolOptions,
						includeImageDimensions: false,
						shouldAddLeadingSpace: () => spacing.shouldAddLeadingSpace(true),
					},
					options.getToolDefinition(content.name),
					options.ui,
					options.cwd,
				);
				tool.setExpanded(expanded);
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
			if (component instanceof RefinementOutcomeMessageComponent) component.setEditDiffsExpanded(editDiffsExpanded);
			components.push(component);
		} else if (isAgentSessionMessage(message) && message.display) {
			const component = new AgentMessageComponent(message, options.markdownTheme, {
				shouldAddLeadingSpace: createConversationSpacing(components).shouldAddLeadingSpace,
			});
			component.setExpanded(expanded);
			components.push(component);
		} else if (isInjectedPromptMessage(message) && message.display) {
			const component =
				createShellCompletionComponent(message, components) ??
				new InjectedPromptMessageComponent(message, options.markdownTheme);
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
