import type { AppKeybinding } from "../../core/keybindings.js";

export interface FeatureHintContext {
	getKeybinding(action: AppKeybinding): string | undefined;
	isResidentSession: boolean;
}

interface FeatureHintDefinition {
	id: string;
	getText(context: FeatureHintContext): string | undefined;
}

export interface FeatureHint {
	id: string;
	text: string;
}

export const FEATURE_HINTS: readonly FeatureHintDefinition[] = [
	{
		id: "side-question",
		getText: () => "Use /btw <question> to ask questions without interrupting your agent.",
	},
	{
		id: "prompt-stash",
		getText: ({ getKeybinding }) => {
			const key = getKeybinding("app.prompt.stash");
			return key ? `Press ${key} to stash your prompt and restore it later.` : undefined;
		},
	},
	{
		id: "follow-up",
		getText: ({ getKeybinding }) => {
			const key = getKeybinding("app.message.followUp");
			return key ? `Press ${key} to send a message after your agent finishes.` : undefined;
		},
	},
	{
		id: "heartbeat",
		getText: () => "Use /heartbeat every 10m <instruction> to repeat a task on a schedule.",
	},
	{
		id: "subagents",
		getText: () => "Prime Agent can delegate tasks to subagents and run them in parallel.",
	},
	{
		id: "agents-view",
		getText: ({ getKeybinding, isResidentSession }) => {
			if (!isResidentSession) return undefined;
			const key = getKeybinding("app.agents.back");
			return key ? `Hit ${key} for Session View: search running, idle, and inactive sessions.` : undefined;
		},
	},
	{
		id: "session-rewind",
		getText: () => "Run /tree to open the session tree and return to a previous message.",
	},
	{
		id: "steering",
		getText: () => "Send a message while your agent works to steer its current task.",
	},
	{
		id: "agent-messaging",
		getText: () => "Agents can message each other to share context and coordinate their work.",
	},
	{
		id: "goal",
		getText: () => "Use /goal <objective> to keep your agent working until the goal is complete.",
	},
	{
		id: "refine",
		getText: () => "Use /refine to turn useful lessons into reusable skills, memory, and prompts.",
	},
	{
		id: "trace-sharing",
		getText: () => "Share traces with Prime Intellect using /traces on to train open-source LLMs.",
	},
	{
		id: "persistent-ipython",
		getText: () => "Compaction removes IPython variables over 16 MiB; smaller state persists.",
	},
	{
		id: "context-usage",
		getText: () => "Use /context to check token usage, cost, and remaining context.",
	},
	{
		id: "session-fork",
		getText: () => "Use /fork to start a new session from an earlier prompt.",
	},
	{
		id: "compaction",
		getText: () => "Use /compact <instructions> to summarize old messages and free up context.",
	},
	{
		id: "auto-compaction",
		getText: () => "Prime Agent automatically compacts long sessions before context fills up.",
	},
	{
		id: "auto-refine",
		getText: () => "Prime Agent self-improves by refining skills, memories, prompts, and subagents.",
	},
	{
		id: "background-running",
		getText: ({ isResidentSession }) =>
			isResidentSession ? "You can close the terminal while your agent keeps running in the background." : undefined,
	},
] as const;

export class FeatureHintDeck {
	private remaining: FeatureHint[] = [];
	private previousId: string | undefined;

	constructor(private readonly random: () => number = Math.random) {}

	next(context: FeatureHintContext): FeatureHint | undefined {
		if (this.remaining.length === 0) {
			this.refill(context);
		}
		const hint = this.remaining.pop();
		if (hint) {
			this.previousId = hint.id;
		}
		return hint;
	}

	private refill(context: FeatureHintContext): void {
		const hints = FEATURE_HINTS.flatMap((hint) => {
			const text = hint.getText(context);
			return text ? [{ id: hint.id, text }] : [];
		});
		for (let index = hints.length - 1; index > 0; index--) {
			const random = Math.min(0.999999999, Math.max(0, this.random()));
			const target = Math.floor(random * (index + 1));
			[hints[index], hints[target]] = [hints[target]!, hints[index]!];
		}
		if (hints.length > 1 && hints[hints.length - 1]?.id === this.previousId) {
			[hints[0], hints[hints.length - 1]] = [hints[hints.length - 1]!, hints[0]!];
		}
		this.remaining = hints;
	}
}
