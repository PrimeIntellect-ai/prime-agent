import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { RlmTokenBudgetConfig, RlmTokenBudgetStatus } from "../src/core/rlm-token-budget.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/types.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type SetResult = RlmTokenBudgetStatus & { globalSaved: boolean; globalError?: string };

type ExhaustedEvent = Extract<AgentConnectionSessionEvent, { type: "rlm_token_budget_exhausted" }>;

type Context = {
	agentConnection: {
		getRlmTokenBudgetStatus: () => Promise<RlmTokenBudgetStatus>;
		setRlmTokenBudget: (
			config: RlmTokenBudgetConfig | undefined,
			options?: { global?: boolean },
		) => Promise<SetResult>;
	};
	chatContainer: Container;
	ui: { requestRender: () => void };
	showWarning: (message: string) => void;
	showError: (message: string) => void;
};

/** Minimum surface `handleEvent` touches before the switch it dispatches on. */
type EventContext = {
	isInitialized: boolean;
	footer: { invalidate: () => void };
	activityTracker: { handleEvent: (event: AgentConnectionSessionEvent) => void };
	chatContainer: Container;
	ui: { requestRender: () => void };
};

type Prototype = {
	handleRlmTokenBudgetCommand(this: Context, args: string): Promise<void>;
	formatRlmTokenBudgetStatus(this: Context, status: RlmTokenBudgetStatus): string;
	handleEvent(this: EventContext, event: AgentConnectionSessionEvent): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as Prototype;

// Object.create keeps the real prototype reachable, so the event switch runs against real methods.
function makeEventContext(): EventContext {
	const context = Object.create(InteractiveMode.prototype) as EventContext;
	context.isInitialized = true;
	context.footer = { invalidate: vi.fn() };
	context.activityTracker = { handleEvent: vi.fn() };
	context.chatContainer = new Container();
	context.ui = { requestRender: vi.fn() };
	return context;
}

function renderAll(container: Container, width = 120): string {
	return container.children
		.flatMap((child) => child.render(width))
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "");
}

const activeStatus: RlmTokenBudgetStatus = {
	config: { totalTokens: 1_000_000, schedule: "split", factor: 0.5, fanout: 3 },
	source: "chat",
	depth: 0,
	allowanceTokens: 500_000,
	tokensUsed: 12_000,
	subtreePoolTokens: 500_000,
	exhausted: false,
};

function makeContext(overrides: Partial<Context["agentConnection"]> = {}): Context {
	// Built on the prototype so shared render helpers resolve exactly as they do in the real class.
	return Object.assign(Object.create(InteractiveMode.prototype) as Context, {
		agentConnection: {
			getRlmTokenBudgetStatus: vi.fn(async () => activeStatus),
			setRlmTokenBudget: vi.fn(async (config, options) => ({
				...activeStatus,
				config: config ?? null,
				globalSaved: options?.global === true,
			})),
			...overrides,
		},
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		showWarning: vi.fn(),
		showError: vi.fn(),
	});
}

describe("InteractiveMode /rlm-token-budget", () => {
	beforeAll(() => initTheme("dark"));

	it("shows current state including the depth-local allowance", async () => {
		const context = makeContext();

		await prototype.handleRlmTokenBudgetCommand.call(context, "");

		expect(context.agentConnection.getRlmTokenBudgetStatus).toHaveBeenCalledOnce();
		expect(context.agentConnection.setRlmTokenBudget).not.toHaveBeenCalled();
		const rendered = renderAll(context.chatContainer);
		expect(rendered).toContain("RLM token budget: 1000000 tokens");
		expect(rendered).toContain("schedule=split");
		expect(rendered).toContain("12000/500000 used at depth 0");
	});

	it("reports a disabled budget", async () => {
		const context = makeContext({
			getRlmTokenBudgetStatus: vi.fn(async () => ({
				...activeStatus,
				config: null,
				source: "default" as const,
				allowanceTokens: null,
				subtreePoolTokens: null,
			})),
		});

		await prototype.handleRlmTokenBudgetCommand.call(context, "");

		expect(renderAll(context.chatContainer)).toContain("RLM token budget: off (default)");
	});

	it("sets a budget with schedule knobs and saves it globally", async () => {
		const context = makeContext();

		await prototype.handleRlmTokenBudgetCommand.call(context, "800k --schedule geometric --factor 0.25 --global");

		expect(context.agentConnection.setRlmTokenBudget).toHaveBeenCalledWith(
			{ totalTokens: 800_000, schedule: "geometric", factor: 0.25, fanout: 3 },
			{ global: true },
		);
		expect(renderAll(context.chatContainer)).toContain(
			"RLM token budget set: 800000 tokens, schedule=geometric, factor=0.25, fanout=3 and saved as global default",
		);
	});

	it("disables budgeting with off", async () => {
		const context = makeContext();

		await prototype.handleRlmTokenBudgetCommand.call(context, "off");

		expect(context.agentConnection.setRlmTokenBudget).toHaveBeenCalledWith(undefined, { global: false });
		expect(renderAll(context.chatContainer)).toContain("RLM token budget disabled");
	});

	it("warns on malformed input without calling the connection", async () => {
		const context = makeContext();

		await prototype.handleRlmTokenBudgetCommand.call(context, "1000 --schedule bogus");

		expect(context.showWarning).toHaveBeenCalledWith(expect.stringContaining("Unknown schedule"));
		expect(context.agentConnection.setRlmTokenBudget).not.toHaveBeenCalled();
	});

	it("surfaces a global-save error without losing the successful chat update", async () => {
		const context = makeContext({
			setRlmTokenBudget: vi.fn(async () => ({
				...activeStatus,
				globalSaved: false,
				globalError: "disk full",
			})),
		});

		await prototype.handleRlmTokenBudgetCommand.call(context, "500k --global");

		expect(renderAll(context.chatContainer)).toContain("RLM token budget set: 500000 tokens");
		expect(context.showError).toHaveBeenCalledWith(
			"RLM token budget set for this chat, but the global default was not saved: disk full",
		);
	});

	it("confirms the bounds it applied and the allowance this session ended up with", async () => {
		const context = makeContext({
			setRlmTokenBudget: vi.fn(async (config) => ({
				...activeStatus,
				config: config ?? null,
				allowanceTokens: 300_000,
				subtreePoolTokens: 300_000,
				globalSaved: false,
			})),
		});

		await prototype.handleRlmTokenBudgetCommand.call(context, "600k --floor 50k");

		expect(context.agentConnection.setRlmTokenBudget).toHaveBeenCalledWith(
			{ totalTokens: 600_000, schedule: "split", factor: 0.5, fanout: 3, minTokens: 50_000 },
			{ global: false },
		);
		const rendered = renderAll(context.chatContainer, 200);
		expect(rendered).toContain(
			"RLM token budget set: 600000 tokens, schedule=split, factor=0.5, fanout=3, floor=50000",
		);
		expect(rendered).toContain("this session: 12000/300000 used at depth 0; subtree pool 300000");
		expect(rendered).not.toContain("ceiling=");
	});

	it("reports only the bounds that are configured, in floor/ceiling wording", () => {
		const bounded = prototype.formatRlmTokenBudgetStatus.call({} as Context, {
			...activeStatus,
			config: {
				totalTokens: 600_000,
				schedule: "split",
				factor: 0.5,
				fanout: 3,
				minTokens: 50_000,
				maxTokens: 600_000,
			},
		});
		expect(bounded).toContain("floor=50000 ceiling=600000");
		expect(bounded).not.toContain("range=");

		const unbounded = prototype.formatRlmTokenBudgetStatus.call({} as Context, activeStatus);
		expect(unbounded).toContain("RLM token budget: 1000000 tokens schedule=split factor=0.5 fanout=3 (chat)");
		expect(unbounded).not.toContain("floor=");
		expect(unbounded).not.toContain("ceiling=");
		expect(unbounded).not.toContain("range=");
	});
});

describe("InteractiveMode RLM token budget exhaustion notice", () => {
	beforeAll(() => initTheme("dark"));

	it("explains the stop with the used/allowance numbers and both recoveries", async () => {
		const context = makeEventContext();

		await prototype.handleEvent.call(context, {
			type: "rlm_token_budget_exhausted",
			depth: 0,
			tokensUsed: 512_345,
			allowanceTokens: 500_000,
		});

		const rendered = renderAll(context.chatContainer, 200);
		expect(rendered).toContain("RLM token budget spent: 512345 of 500000 tokens used.");
		expect(rendered).toContain("This run stopped at the end of the turn");
		expect(rendered).toContain("Raise it with /rlm-token-budget <tokens> or turn it off with /rlm-token-budget off.");
		expect(rendered).not.toContain("at depth");
		expect(context.ui.requestRender).toHaveBeenCalled();
	});

	it("names the depth when the exhausted session is a subagent", async () => {
		const context = makeEventContext();
		const event: ExhaustedEvent = {
			type: "rlm_token_budget_exhausted",
			depth: 2,
			tokensUsed: 61_000,
			allowanceTokens: 60_000,
		};

		await prototype.handleEvent.call(context, event);

		expect(renderAll(context.chatContainer, 200)).toContain(
			"RLM token budget spent at depth 2: 61000 of 60000 tokens used.",
		);
	});
});
