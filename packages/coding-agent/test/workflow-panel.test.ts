import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionWorkflowPanelData } from "../src/core/extensions/types.js";
import { WorkflowPanelComponent } from "../src/modes/interactive/components/workflow-panel.js";
import { initTheme, preloadCodeHighlighter, theme } from "../src/modes/interactive/theme/theme.js";

const data: ExtensionWorkflowPanelData = {
	cwd: "/tmp/project",
	runId: "wf_test",
	workflowName: "read-package-name",
	description: "Read root package.json and report the package name",
	status: "completed",
	durationMs: 4_000,
	agentCount: 1,
	phases: [
		{
			title: "Inspect",
			agents: [
				{
					id: 1,
					label: "read:package.json",
					status: "completed",
					model: "openai-codex/gpt-5.6-sol",
					effort: "low",
					totalTokens: 24_600,
					cost: 0.12,
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: "2026-01-01T00:00:04.000Z",
					prompt: "Read only package.json.",
					resultPreview: '{"name":"prime-agent"}',
				},
			],
		},
	],
	actions: ["Inspect source", "Save to project", "Back"],
};

describe("WorkflowPanelComponent", () => {
	beforeAll(async () => {
		await preloadCodeHighlighter();
		initTheme("dark");
	});

	it("renders Claude-style phase and agent panes with persisted details", () => {
		const requestRender = vi.fn();
		const done = vi.fn();
		const component = new WorkflowPanelComponent({ requestRender } as never, theme, data, done);
		const rendered = component.render(120).map(stripAnsi).join("\n");
		expect(rendered).toContain("read-package-name");
		expect(rendered).toContain("Phases");
		expect(rendered).toContain("Inspect 1/1");
		expect(rendered).toContain("read:package.json");
		expect(rendered).toContain("24.6k tok");
		expect(rendered).toContain("Actions");
	});

	it("opens agent detail and returns to the panel through configured selection actions", () => {
		const done = vi.fn();
		const component = new WorkflowPanelComponent({ requestRender: vi.fn() } as never, theme, data, done);
		component.handleInput("\r");
		component.handleInput("\r");
		const detail = component.render(100).map(stripAnsi).join("\n");
		expect(detail).toContain("Prompt");
		expect(detail).toContain("Outcome");
		expect(detail).toContain("openai-codex/gpt-5.6-sol");
		component.handleInput("\x1b");
		expect(component.render(100).map(stripAnsi).join("\n")).toContain("Phases");
		expect(done).not.toHaveBeenCalled();
	});

	it("keeps actions visible and borders within a 24-row terminal", () => {
		const agents = Array.from({ length: 40 }, (_, index) => ({
			id: index + 1,
			label: `agent-${index + 1}`,
			status: "completed" as const,
		}));
		const component = new WorkflowPanelComponent(
			{ requestRender: vi.fn(), terminal: { rows: 24 } } as never,
			theme,
			{ ...data, agentCount: agents.length, phases: [{ title: "Many", agents }] },
			vi.fn(),
		);
		component.handleInput("\t");
		component.handleInput("\t");
		for (let index = 0; index < data.actions.length - 1; index++) component.handleInput("\x1b[B");
		const rendered = component.render(120);
		expect(rendered.length).toBeLessThanOrEqual(24);
		expect(rendered.map(stripAnsi).join("\n")).toContain("[Back]");
		expect(rendered.every((line) => visibleWidth(line) <= 120)).toBe(true);
	});

	it("scrolls long agent prompts with configured selection bindings", () => {
		const longPrompt = Array.from({ length: 40 }, (_, index) => `prompt line ${index + 1}`).join("\n");
		const component = new WorkflowPanelComponent(
			{ requestRender: vi.fn() } as never,
			theme,
			{
				...data,
				phases: [{ ...data.phases[0]!, agents: [{ ...data.phases[0]!.agents[0]!, prompt: longPrompt }] }],
			},
			vi.fn(),
		);
		component.handleInput("\r");
		component.handleInput("\r");
		expect(component.render(100).map(stripAnsi).join("\n")).not.toContain("prompt line 40");
		for (let index = 0; index < 20; index++) component.handleInput("\x1b[B");
		expect(component.render(100).map(stripAnsi).join("\n")).toContain("prompt line 40");
	});

	it("uses a stacked layout for narrow runs with empty planned phases", () => {
		const component = new WorkflowPanelComponent(
			{ requestRender: vi.fn() } as never,
			theme,
			{ ...data, agentCount: 0, phases: [{ title: "Waiting", agents: [] }] },
			vi.fn(),
		);
		const rendered = component.render(48).map(stripAnsi).join("\n");
		expect(rendered).toContain("Waiting 0/0");
		expect(rendered).toContain("No agents started");
	});

	it("polls live run data, preserves stable agent selection, and disposes its timer", () => {
		vi.useFakeTimers();
		try {
			const requestRender = vi.fn();
			const refreshed: ExtensionWorkflowPanelData = {
				...data,
				status: "running",
				actions: ["Stop", ...data.actions],
				phases: [
					{
						...data.phases[0]!,
						agents: [data.phases[0]!.agents[0]!, { id: 2, label: "verifier", status: "running" }],
					},
				],
			};
			const refresh = vi.fn(() => refreshed);
			const done = vi.fn();
			const component = new WorkflowPanelComponent({ requestRender } as never, theme, data, done, refresh);
			component.handleInput("\t");
			component.handleInput("\t");
			component.handleInput("\x1b[B");
			vi.advanceTimersByTime(250);
			expect(refresh).toHaveBeenCalledOnce();
			expect(component.selectedAgent?.id).toBe(1);
			expect(component.render(100).map(stripAnsi).join("\n")).toContain("verifier");
			component.handleInput("\r");
			expect(done).toHaveBeenCalledWith({ action: "Save to project" });
			component.dispose();
			vi.advanceTimersByTime(500);
			expect(refresh).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("selects panel actions without hardcoded action keys", () => {
		const done = vi.fn();
		const component = new WorkflowPanelComponent({ requestRender: vi.fn() } as never, theme, data, done);
		component.handleInput("\t");
		component.handleInput("\t");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ action: "Save to project" });
	});
});
