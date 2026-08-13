import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AgentEndEvent,
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionWorkflowPanelData,
	InputEvent,
	InputEventResult,
} from "../src/core/extensions/types.js";
import { createWorkflowExtension, waitForSessionWorkflows } from "../src/core/workflows/extension.js";
import type { WorkflowAgentRunner } from "../src/core/workflows/runtime.js";
import { listWorkflowRuns } from "../src/core/workflows/storage.js";

interface CapturedTool {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	): Promise<AgentToolResult<unknown>>;
}

interface CapturedCommand {
	handler(args: string, context: ExtensionCommandContext): Promise<void>;
}

interface Harness {
	api: ExtensionAPI;
	tool(): CapturedTool;
	command(name: string): CapturedCommand;
	input(
		event: InputEvent,
		context: ExtensionContext,
	): Promise<InputEventResult | undefined> | InputEventResult | undefined;
	beforeAgentStart(prompt: string, context: ExtensionContext): Promise<void> | void;
	agentStart(context: ExtensionContext): Promise<void> | void;
	agentEnd(context: ExtensionContext): Promise<void> | void;
	sent: ReturnType<typeof vi.fn>;
	setActiveTools: ReturnType<typeof vi.fn>;
}

const script = `meta = {"name": "audit", "description": "Audit things"}
phase("Audit")
return await agent(args["prompt"], label="auditor")`;

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createHarness(thinkingLevel = "medium"): Harness {
	let tool: CapturedTool | undefined;
	const commands = new Map<string, CapturedCommand>();
	let inputHandler:
		| ((
				event: InputEvent,
				context: ExtensionContext,
		  ) => Promise<InputEventResult | undefined> | InputEventResult | undefined)
		| undefined;
	let beforeAgentStartHandler:
		| ((event: { type: "before_agent_start"; prompt: string }, context: ExtensionContext) => Promise<void> | void)
		| undefined;
	let agentStartHandler:
		| ((event: { type: "agent_start" }, context: ExtensionContext) => Promise<void> | void)
		| undefined;
	let agentEndHandler: ((event: AgentEndEvent, context: ExtensionContext) => Promise<void> | void) | undefined;
	const sent = vi.fn();
	let activeTools = ["ipython", "workflow"];
	const setActiveTools = vi.fn((tools: string[]) => {
		activeTools = [...tools];
	});
	const api = {
		registerTool(value: unknown) {
			tool = value as CapturedTool;
		},
		registerCommand(name: string, value: unknown) {
			commands.set(name, value as CapturedCommand);
		},
		on(event: string, handler: unknown) {
			if (event === "input") inputHandler = handler as typeof inputHandler;
			if (event === "before_agent_start") beforeAgentStartHandler = handler as typeof beforeAgentStartHandler;
			if (event === "agent_start") agentStartHandler = handler as typeof agentStartHandler;
			if (event === "agent_end") agentEndHandler = handler as typeof agentEndHandler;
		},
		getThinkingLevel: () => thinkingLevel,
		getActiveTools: () => [...activeTools],
		setActiveTools,
		sendMessage: sent,
	} as unknown as ExtensionAPI;
	return {
		api,
		tool: () => {
			if (!tool) throw new Error("tool not registered");
			return tool;
		},
		command: (name) => {
			const command = commands.get(name);
			if (!command) throw new Error(`command not registered: ${name}`);
			return command;
		},
		input: (event, context) => inputHandler?.(event, context),
		beforeAgentStart: (prompt, context) => beforeAgentStartHandler?.({ type: "before_agent_start", prompt }, context),
		agentStart: (context) => agentStartHandler?.({ type: "agent_start" }, context),
		agentEnd: (context) => agentEndHandler?.({ type: "agent_end", messages: [] }, context),
		sent,
		setActiveTools,
	};
}

async function startAdmittedTurn(
	harness: Harness,
	admission: InputEventResult | undefined,
	context: ExtensionContext,
): Promise<void> {
	if (admission?.action !== "transform") throw new Error("expected transformed workflow prompt");
	await harness.beforeAgentStart(admission.text, context);
	await harness.agentStart(context);
}

function createContext(cwd: string, sessionId = "session-test", selections: string[] = [], panelResponses?: string[]) {
	const notifications: Array<{ message: string; type?: string }> = [];
	const editors: Array<{ title: string; content?: string }> = [];
	const workflowPanels: ExtensionWorkflowPanelData[] = [];
	const context = {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: {},
		model: undefined,
		signal: undefined,
		hasUI: true,
		ui: {
			...(panelResponses ? { supportsWorkflowPanel: true } : {}),
			...(panelResponses
				? {
						workflowPanel: vi.fn(async (panel: ExtensionWorkflowPanelData) => {
							workflowPanels.push(panel);
							return panelResponses.shift();
						}),
					}
				: {}),
			confirm: vi.fn(async () => true),
			select: vi.fn(async (_title: string, options: string[]) => {
				const next = selections.shift();
				return next?.startsWith("prefix:") ? options.find((option) => option.startsWith(next.slice(7))) : next;
			}),
			input: vi.fn(async (_title: string, placeholder?: string) => placeholder),
			editor: vi.fn(async (title: string, content?: string) => {
				editors.push({ title, content });
				return undefined;
			}),
			setWidget: vi.fn(),
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
	} as unknown as ExtensionCommandContext;
	return { context, notifications, editors, workflowPanels };
}

function makeTemp(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-workflow-extension-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createRunner(): WorkflowAgentRunner {
	return {
		async run(prompt) {
			return { result: `result:${prompt}`, usage: { input: 1, output: 1, totalTokens: 4, cost: 0 } };
		},
	};
}

describe("dynamic workflow extension", () => {
	it("requires a human ultracode prompt and consumes authorization once", async () => {
		const cwd = makeTemp();
		const agentDir = join(cwd, "agent-home");
		const harness = createHarness();
		await createWorkflowExtension({ agentDir, runnerFactory: createRunner })(harness.api);
		const { context } = createContext(cwd);

		await expect(
			harness.tool().execute("call", { script, args: { prompt: "first" } }, undefined, undefined, context),
		).rejects.toThrow("human-authored `ultracode:` or direct workflow");

		const admission = await harness.input(
			{ type: "input", text: "ultracode: inspect every module", source: "interactive" },
			context,
		);
		expect(admission).toEqual(
			expect.objectContaining({ action: "transform", text: expect.stringContaining("inspect every module") }),
		);
		expect(harness.setActiveTools).not.toHaveBeenCalled();
		await startAdmittedTurn(harness, admission, context);
		expect(harness.setActiveTools).toHaveBeenCalledWith(["workflow"]);
		const launched = await harness
			.tool()
			.execute("call", { script, args: { prompt: "first" } }, undefined, undefined, context);
		expect(launched.content[0]).toEqual(
			expect.objectContaining({ text: expect.stringContaining("background task") }),
		);
		expect(launched.details).toEqual(
			expect.objectContaining({
				status: "async_launched",
				taskType: "local_workflow",
				taskId: expect.stringMatching(/^task_/),
				runId: expect.stringMatching(/^wf_/),
			}),
		);
		expect(context.ui.confirm).not.toHaveBeenCalled();

		await vi.waitFor(() => {
			expect(listWorkflowRuns(cwd, agentDir)[0]).toMatchObject({
				status: "completed",
				workflowName: "audit",
				agentCount: 1,
				sessionId: "session-test",
				progress: {
					currentPhase: "Audit",
					agents: [expect.objectContaining({ label: "auditor", status: "completed", prompt: "first" })],
				},
			});
		});
		expect(context.ui.setWidget).toHaveBeenCalledWith(
			"workflow-active",
			expect.arrayContaining([expect.stringContaining("task ")]),
			{ placement: "belowEditor" },
		);
		expect(context.ui.setWidget).toHaveBeenLastCalledWith("workflow-active", undefined, {
			placement: "belowEditor",
		});
		await harness.agentEnd(context);
		expect(harness.setActiveTools).toHaveBeenLastCalledWith(["ipython", "workflow"]);

		await expect(
			harness.tool().execute("call", { script, args: { prompt: "again" } }, undefined, undefined, context),
		).rejects.toThrow("human-authored `ultracode:` or direct workflow");
	});

	it.each([
		"make a workflow to inspect this repository",
		"create workflows for the release checks",
		"WORKFLOW",
		"compare these Workflows please",
	])("recognizes the whole-word workflow keyword in interactive input: %s", async (text) => {
		const cwd = makeTemp();
		const harness = createHarness();
		await createWorkflowExtension({ agentDir: join(cwd, "agent-home"), runnerFactory: createRunner })(harness.api);
		const { context } = createContext(cwd);

		expect(await harness.input({ type: "input", text, source: "interactive" }, context)).toEqual(
			expect.objectContaining({ action: "transform", text: expect.stringContaining(text) }),
		);
	});

	it.each(["make multiple agents", "use subagents", "workflowish", "work-flow"])(
		"does not treat non-workflow aliases or partial words as workflow requests: %s",
		async (text) => {
			const cwd = makeTemp();
			const harness = createHarness();
			await createWorkflowExtension({ agentDir: join(cwd, "agent-home"), runnerFactory: createRunner })(harness.api);
			const { context } = createContext(cwd);

			expect(await harness.input({ type: "input", text, source: "interactive" }, context)).toEqual({
				action: "continue",
			});
		},
	);

	it("preserves the explicit ultracode prefix as an independent interactive trigger", async () => {
		const cwd = makeTemp();
		const harness = createHarness();
		await createWorkflowExtension({ agentDir: join(cwd, "agent-home"), runnerFactory: createRunner })(harness.api);
		const { context } = createContext(cwd);

		expect(
			await harness.input(
				{ type: "input", text: "please ultracode: inspect the repository", source: "interactive" },
				context,
			),
		).toEqual(
			expect.objectContaining({ action: "transform", text: expect.stringContaining("inspect the repository") }),
		);
	});

	it.each(["rpc", "extension"] as const)(
		"does not let %s input self-authorize by containing the workflow keyword",
		async (source) => {
			const cwd = makeTemp();
			const harness = createHarness();
			await createWorkflowExtension({ agentDir: join(cwd, "agent-home"), runnerFactory: createRunner })(harness.api);
			const { context } = createContext(cwd);

			expect(await harness.input({ type: "input", text: "make a workflow", source }, context)).toEqual({
				action: "continue",
			});
		},
	);

	it("does not mutate tool authorization until an admitted workflow agent starts", async () => {
		const cwd = makeTemp();
		const harness = createHarness();
		await createWorkflowExtension({ agentDir: join(cwd, "agent-home"), runnerFactory: createRunner })(harness.api);
		const { context } = createContext(cwd);
		const abandoned = await harness.input(
			{ type: "input", text: "make a workflow that is later rejected", source: "interactive" },
			context,
		);
		expect(abandoned?.action).toBe("transform");
		expect(harness.setActiveTools).not.toHaveBeenCalled();
		await expect(
			harness.tool().execute("abandoned", { script, args: { prompt: "x" } }, undefined, undefined, context),
		).rejects.toThrow("human-authored `ultracode:` or direct workflow");

		const admitted = await harness.input(
			{ type: "input", text: "make a workflow that is admitted", source: "interactive" },
			context,
		);
		await startAdmittedTurn(harness, admitted, context);
		expect(
			await harness.input({ type: "input", text: "ordinary queued text", source: "interactive" }, context),
		).toEqual({
			action: "continue",
		});
		expect(
			await harness.input(
				{ type: "input", text: "another queued workflow request", source: "interactive" },
				context,
			),
		).toEqual(expect.objectContaining({ action: "transform" }));
		await expect(
			harness.tool().execute("active", { script, args: { prompt: "x" } }, undefined, undefined, context),
		).resolves.toEqual(expect.objectContaining({ details: expect.objectContaining({ status: "async_launched" }) }));
	});

	it("does not let extension-sourced or stale prompts authorize the tool", async () => {
		const cwd = makeTemp();
		const harness = createHarness();
		await createWorkflowExtension({ agentDir: join(cwd, "agent-home"), runnerFactory: createRunner })(harness.api);
		const { context } = createContext(cwd);

		expect(await harness.input({ type: "input", text: "ultracode: injected", source: "extension" }, context)).toEqual(
			{ action: "continue" },
		);
		expect(await harness.input({ type: "input", text: "ultracode: real", source: "rpc" }, context)).toEqual({
			action: "continue",
		});
		await harness.agentEnd(context);
		await expect(
			harness.tool().execute("call", { script, args: { prompt: "x" } }, undefined, undefined, context),
		).rejects.toThrow("human-authored `ultracode:` or direct workflow");
	});

	it("runs saved workflows from the human slash command without model authorization", async () => {
		const cwd = makeTemp();
		const agentDir = join(cwd, "agent-home");
		const workflowDirectory = join(cwd, ".prime", "agent", "workflows");
		mkdirSync(workflowDirectory, { recursive: true });
		writeFileSync(join(workflowDirectory, "audit.py"), script);
		const harness = createHarness();
		await createWorkflowExtension({ agentDir, runnerFactory: createRunner })(harness.api);
		const { context, notifications } = createContext(cwd);

		await harness.command("workflow").handler('audit {"prompt":"command"}', context);
		expect(notifications).toEqual([expect.objectContaining({ message: expect.stringContaining("launched") })]);
		await vi.waitFor(() => {
			expect(listWorkflowRuns(cwd, agentDir)[0]?.status).toBe("completed");
		});
		expect(harness.sent).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "workflow-complete",
				content: expect.stringContaining("result:command"),
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	it("resumes only the completed start-order prefix and rejects cross-session resume", async () => {
		const cwd = makeTemp();
		const agentDir = join(cwd, "agent-home");
		const prompts: string[] = [];
		let blockAgentB = true;
		const runner: WorkflowAgentRunner = {
			async run(prompt, options) {
				prompts.push(prompt);
				if (prompt === "B" && blockAgentB) {
					return await new Promise((_resolve, reject) => {
						const abort = () => reject(options.signal?.reason ?? new Error("aborted"));
						if (options.signal?.aborted) abort();
						else options.signal?.addEventListener("abort", abort, { once: true });
					});
				}
				return { result: prompt, usage: { totalTokens: 1 } };
			},
		};
		const replayScript = `meta = {"name": "replay", "description": "Replay order"}
return await parallel([lambda: agent(args["a"]), lambda: agent("B"), lambda: agent("C")])`;
		const harness = createHarness();
		await createWorkflowExtension({ agentDir, runnerFactory: () => runner })(harness.api);
		const { context, notifications } = createContext(cwd, "session-one");
		const replayAdmission = await harness.input(
			{ type: "input", text: "ultracode: replay test", source: "interactive" },
			context,
		);
		await startAdmittedTurn(harness, replayAdmission, context);
		await harness.tool().execute("call", { script: replayScript, args: { a: "A" } }, undefined, undefined, context);
		await vi.waitFor(() => expect(prompts).toEqual(["A", "B", "C"]));
		const prior = listWorkflowRuns(cwd, agentDir)[0];
		expect(prior).toBeDefined();
		await harness.command("workflows").handler(`stop ${prior?.runId}`, context);
		await vi.waitFor(() =>
			expect(listWorkflowRuns(cwd, agentDir)[0]).toMatchObject({
				status: "stopped",
				progress: {
					agents: expect.arrayContaining([expect.objectContaining({ label: "agent #2", status: "stopped" })]),
				},
			}),
		);
		await harness.agentEnd(context);

		const other = createContext(cwd, "session-two");
		await harness.command("workflows").handler(`resume ${prior?.runId}`, other.context);
		expect(other.notifications.at(-1)).toEqual(
			expect.objectContaining({ message: expect.stringContaining("same Prime Agent session"), type: "error" }),
		);

		blockAgentB = false;
		await harness.command("workflows").handler(`resume ${prior?.runId}`, context);
		await vi.waitFor(() => {
			const resumed = listWorkflowRuns(cwd, agentDir).find((run) => run.metadata?.resumedFrom === prior?.runId);
			expect(resumed).toMatchObject({ status: "completed", replayedCount: 1, result: ["A", "B", "C"] });
		});
		expect(prompts).toEqual(["A", "B", "C", "B", "C"]);
		expect(notifications.some(({ message }) => message.includes("Resumed"))).toBe(true);
	});

	it("opens the hierarchical workflow viewer and shows source, overview, phase, and agent detail", async () => {
		const cwd = makeTemp();
		const harness = createHarness();
		createWorkflowExtension({ runnerFactory: () => createRunner(), agentDir: cwd })(harness.api);
		const first = createContext(cwd);
		const admission = await harness.input(
			{ type: "input", text: "make a workflow to inspect", source: "interactive" },
			first.context,
		);
		expect(admission?.action).toBe("transform");
		await startAdmittedTurn(harness, admission, first.context);
		await harness
			.tool()
			.execute("call-viewer", { script, args: { prompt: "viewer" } }, undefined, undefined, first.context);
		await waitForSessionWorkflows("session-test");
		await harness.agentEnd(first.context);
		const run = listWorkflowRuns(cwd, cwd)[0];
		expect(run).toBeDefined();
		const viewer = createContext(cwd, "session-test", [
			"prefix:✓ audit · completed",
			"Overview",
			"Inspect source",
			"Phase · Audit",
			"prefix:✓ auditor · completed",
			"Back",
			"Back",
			"Close",
		]);
		await harness.command("workflows").handler("", viewer.context);
		expect(
			viewer.editors.some((entry) => entry.title.includes("Workflow") && entry.content?.includes("Usage:")),
		).toBe(true);
		expect(viewer.editors.some((entry) => entry.title.includes("source") && entry.content === script)).toBe(true);
		expect(
			viewer.editors.some(
				(entry) =>
					entry.title.includes("auditor") &&
					entry.content?.includes("Usage: 4 tokens") &&
					entry.content.includes("Prompt:"),
			),
		).toBe(true);
	});

	it("flushes live sub-threshold progress while an agent is still running", async () => {
		const cwd = makeTemp();
		const harness = createHarness();
		let finish: ((value: { result: string }) => void) | undefined;
		const runner: WorkflowAgentRunner = {
			run: vi.fn(
				() =>
					new Promise<{ result: string }>((resolve) => {
						finish = resolve;
					}),
			),
		};
		createWorkflowExtension({ runnerFactory: () => runner, agentDir: cwd })(harness.api);
		const { context } = createContext(cwd);
		const admission = await harness.input(
			{ type: "input", text: "make a workflow to inspect", source: "interactive" },
			context,
		);
		await startAdmittedTurn(harness, admission, context);
		await harness
			.tool()
			.execute("live-progress", { script, args: { prompt: "wait" } }, undefined, undefined, context);
		await new Promise((resolve) => setTimeout(resolve, 250));
		const running = listWorkflowRuns(cwd, cwd)[0];
		expect(running).toMatchObject({
			status: "running",
			phases: ["Audit"],
			progress: { agents: [expect.objectContaining({ label: "auditor", status: "running" })] },
		});
		finish?.({ result: "done" });
		await waitForSessionWorkflows("session-test");
		await harness.agentEnd(context);
	});

	it("uses the transported workflow panel for phase and agent inspection", async () => {
		const cwd = makeTemp();
		const harness = createHarness();
		createWorkflowExtension({ runnerFactory: () => createRunner(), agentDir: cwd })(harness.api);
		const first = createContext(cwd);
		const admission = await harness.input(
			{ type: "input", text: "make a workflow to inspect", source: "interactive" },
			first.context,
		);
		await startAdmittedTurn(harness, admission, first.context);
		await harness
			.tool()
			.execute("call-panel", { script, args: { prompt: "viewer" } }, undefined, undefined, first.context);
		await waitForSessionWorkflows("session-test");
		await harness.agentEnd(first.context);
		const viewer = createContext(
			cwd,
			"session-test",
			["prefix:✓ audit · completed", "Close"],
			["Inspect source", "Back"],
		);

		await harness.command("workflows").handler("", viewer.context);

		expect(viewer.workflowPanels).toHaveLength(2);
		expect(viewer.workflowPanels[0]).toMatchObject({
			workflowName: "audit",
			status: "completed",
			phases: [
				{
					title: "Audit",
					agents: [expect.objectContaining({ label: "auditor", status: "completed", totalTokens: 4 })],
				},
			],
		});
		expect(viewer.editors.some((entry) => entry.title.includes("source") && entry.content === script)).toBe(true);
	});

	it("returns a launch-shaped syntax error and ignores tool-level display metadata", async () => {
		const cwd = makeTemp();
		const agentDir = join(cwd, "agent-home");
		const harness = createHarness();
		await createWorkflowExtension({ agentDir, runnerFactory: createRunner })(harness.api);
		const { context } = createContext(cwd);
		const invalidAdmission = await harness.input(
			{ type: "input", text: "ultracode: invalid workflow", source: "interactive" },
			context,
		);
		await startAdmittedTurn(harness, invalidAdmission, context);
		const result = await harness.tool().execute(
			"call",
			{
				script: 'meta = {"name": "broken", "description": "Broken"}\nreturn await agent(',
				title: "ignored title",
				description: "ignored description",
			},
			undefined,
			undefined,
			context,
		);
		expect(result.details).toEqual(
			expect.objectContaining({
				status: "async_launched",
				taskId: expect.stringMatching(/^task_/),
				runId: expect.stringMatching(/^wf_/),
				error: expect.any(String),
			}),
		);
		expect(listWorkflowRuns(cwd, agentDir)[0]).toMatchObject({
			status: "failed",
			workflowName: "invalid-workflow",
		});
	});

	it("admits RPC/headless prompts only when trusted CLI ultracode mode is configured", async () => {
		const cwd = makeTemp();
		const agentDir = join(cwd, "agent-home");
		const harness = createHarness("xhigh");
		await createWorkflowExtension({ agentDir, runnerFactory: createRunner, ultracode: true })(harness.api);
		const { context } = createContext(cwd);
		const admission = await harness.input({ type: "input", text: "inspect modules", source: "rpc" }, context);
		expect(admission).toEqual(
			expect.objectContaining({ action: "transform", text: expect.stringContaining("inspect modules") }),
		);
		await startAdmittedTurn(harness, admission, context);
		await harness.tool().execute("call", { script, args: { prompt: "cli" } }, undefined, undefined, context);
		expect(context.ui.confirm).not.toHaveBeenCalled();
	});

	it("confines direct script paths to regular project Python files", async () => {
		const root = makeTemp();
		const cwd = join(root, "project");
		const outside = join(root, "outside.py");
		mkdirSync(cwd);
		writeFileSync(outside, script);
		symlinkSync(outside, join(cwd, "linked.py"));
		const harness = createHarness();
		await createWorkflowExtension({ agentDir: join(root, "agent-home"), runnerFactory: createRunner })(harness.api);
		const { context } = createContext(cwd);
		const pathAdmission = await harness.input(
			{ type: "input", text: "ultracode: safe path test", source: "interactive" },
			context,
		);
		await startAdmittedTurn(harness, pathAdmission, context);

		await expect(
			harness.tool().execute("call", { scriptPath: outside }, undefined, undefined, context),
		).rejects.toThrow("inside the session working directory");
		await expect(
			harness.tool().execute("call", { scriptPath: "linked.py" }, undefined, undefined, context),
		).rejects.toThrow("without symlink traversal");
	});

	it("does not activate configured ultracode when effort was clamped below xhigh", async () => {
		const cwd = makeTemp();
		const harness = createHarness("high");
		await createWorkflowExtension({
			agentDir: join(cwd, "agent-home"),
			runnerFactory: createRunner,
			ultracode: true,
		})(harness.api);
		const { context } = createContext(cwd);
		expect(await harness.input({ type: "input", text: "inspect modules", source: "rpc" }, context)).toEqual({
			action: "continue",
		});
	});
});
