import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { RlmTokenBudgetConfig, RlmTokenBudgetStatus } from "../src/core/rlm-token-budget.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type SetResult = RlmTokenBudgetStatus & { globalSaved: boolean; globalError?: string };

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
	formatRlmTokenBudgetStatus: (status: RlmTokenBudgetStatus) => string;
};

type Prototype = {
	handleRlmTokenBudgetCommand(this: Context, args: string): Promise<void>;
	formatRlmTokenBudgetStatus(this: Context, status: RlmTokenBudgetStatus): string;
};

const prototype = InteractiveMode.prototype as unknown as Prototype;

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
	return {
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
		formatRlmTokenBudgetStatus: (status) => prototype.formatRlmTokenBudgetStatus.call({} as Context, status),
	};
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
});
