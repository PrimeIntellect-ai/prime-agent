import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { GOAL_CONTEXT_CUSTOM_TYPE, type GoalContextDetails } from "../../../core/goals.js";
import {
	type CustomMessage,
	HEARTBEAT_PROMPT_CUSTOM_TYPE,
	type HeartbeatPromptDetails,
	IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
	type IpythonStateRestoredDetails,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
	type RlmChildFailureDetails,
	type RlmChildTerminalNoticeDetails,
} from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { expandCollapseHint } from "./keybinding-hints.js";

type InjectedPromptDetails =
	| GoalContextDetails
	| HeartbeatPromptDetails
	| IpythonStateRestoredDetails
	| RlmChildFailureDetails
	| RlmChildTerminalNoticeDetails;
type InjectedPromptMessage = CustomMessage<InjectedPromptDetails>;

export function isInjectedPromptMessage(message: AgentMessage): message is InjectedPromptMessage {
	return (
		message.role === "custom" &&
		(message.customType === HEARTBEAT_PROMPT_CUSTOM_TYPE ||
			message.customType === GOAL_CONTEXT_CUSTOM_TYPE ||
			message.customType === IPYTHON_STATE_RESTORED_CUSTOM_TYPE ||
			message.customType === RLM_CHILD_FAILURE_CUSTOM_TYPE ||
			message.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE)
	);
}

function readCustomText(message: CustomMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

function collapseText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function goalLabel(details: GoalContextDetails | undefined): string {
	switch (details?.kind) {
		case "continuation":
			return "Goal continuation";
		case "budget_limit":
			return "Goal budget limit";
		case "objective_updated":
			return "Goal updated";
		default:
			return "Goal context";
	}
}

function compactHeartbeatSchedule(schedule: string | undefined): string {
	const trimmed = schedule?.trim();
	if (!trimmed) {
		return "prompt";
	}
	return trimmed.replace(/^every\s+/i, "");
}

function heartbeatPromptSchedule(schedule: string | undefined): string {
	const compact = compactHeartbeatSchedule(schedule);
	return compact === "prompt" ? "scheduled" : `every ${compact}`;
}

export class InjectedPromptMessageComponent extends Container {
	private readonly content = new Container();
	private readonly header = new Text("", 1, 0);
	private expanded = false;

	constructor(
		private readonly message: InjectedPromptMessage,
		private readonly markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(this.content);
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) {
			return;
		}
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.content.clear();
		this.header.setText(this.headerText());
		this.content.addChild(this.header);
		if (this.expanded && this.message.customType !== IPYTHON_STATE_RESTORED_CUSTOM_TYPE) {
			this.content.addChild(
				new Markdown(readCustomText(this.message), 1, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
			return;
		}
	}

	private headerText(): string {
		if (this.message.customType === HEARTBEAT_PROMPT_CUSTOM_TYPE) {
			return this.heartbeatHeaderText();
		}
		if (this.message.customType === IPYTHON_STATE_RESTORED_CUSTOM_TYPE) {
			const details = this.message.details as IpythonStateRestoredDetails | undefined;
			const label = details?.restored === false ? "Started fresh IPython kernel" : "Restored IPython kernel state";
			return `${theme.fg("accent", "◆")} ${theme.fg("muted", label)}`;
		}
		if (
			this.message.customType === RLM_CHILD_FAILURE_CUSTOM_TYPE ||
			this.message.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE
		) {
			const hint = this.expanded ? "" : ` ${expandCollapseHint("app.tools.expand", false)}`;
			return theme.fg("muted", "RLM child status") + theme.fg("dim", hint);
		}

		const details = this.message.details;
		const title = goalLabel(details as GoalContextDetails | undefined);
		const meta = this.metaText();
		const hint = this.expanded ? "" : ` ${expandCollapseHint("app.tools.expand", false)}`;
		return theme.fg("muted", title) + meta + theme.fg("dim", hint);
	}

	private heartbeatHeaderText(): string {
		const details = this.message.details as HeartbeatPromptDetails | undefined;
		const pulse = theme.fg("error", "♥");
		const schedule = theme.fg("muted", heartbeatPromptSchedule(details?.schedule));
		const hint = this.expanded ? "" : ` ${expandCollapseHint("app.tools.expand", false)}`;
		return `${pulse} ${theme.fg("muted", "Heartbeat prompt")}${theme.fg("dim", " · ")}${schedule}${theme.fg("dim", hint)}`;
	}

	private metaText(): string {
		const details = this.message.details;
		const goal = details as GoalContextDetails | undefined;
		if (!goal?.objective) {
			return "";
		}
		const prefixWidth = visibleWidth("Goal continuation · ");
		return theme.fg("muted", ` · ${truncateToWidth(collapseText(goal.objective), Math.max(20, 90 - prefixWidth))}`);
	}
}
