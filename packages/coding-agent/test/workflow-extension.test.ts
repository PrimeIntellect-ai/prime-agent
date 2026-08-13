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
	InputEvent,
	InputEventResult,
} from "../src/core/extensions/types.js";
import { createWorkflowExtension } from "../src/core/workflows/extension.js";
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
	agentEnd(context: ExtensionContext): Promise<void> | void;
	sent: ReturnType<typeof vi.fn>;
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
	let agentEndHandler: ((event: AgentEndEvent, context: ExtensionContext) => Promise<void> | void) | undefined;
	const sent = vi.fn();
	const api = {
		registerTool(value: unknown) {
			tool = value as CapturedTool;
		},
		registerCommand(name: string, value: unknown) {
			commands.set(name, value as CapturedCommand);
		},
		on(event: string, handler: unknown) {
			if (event === "input") inputHandler = handler as typeof inputHandler;
			if (event === "agent_end") agentEndHandler = handler as typeof agentEndHandler;
		},
		getThinkingLevel: () => thinkingLevel,
		getActiveTools: () => ["ipython", "workflow"],
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
		agentEnd: (context) => agentEndHandler?.({ type: "agent_end", messages: [] }, context),
		sent,
	};
}

function createContext(cwd: string, sessionId = "session-test") {
	const notifications: Array<{ message: string; type?: string }> = [];
	const context = {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: {},
		model: undefined,
		signal: undefined,
		hasUI: true,
		ui: {
			confirm: vi.fn(async () => true),
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
	} as unknown as ExtensionCommandContext;
	return { context, notifications };
}

function makeTemp(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-workflow-extension-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createRunner(): WorkflowAgentRunner {
	return {
		async run(prompt) {
			return { result: `result:${prompt}`, usage: { totalTokens: 4 } };
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
		await harness.agentEnd(context);

		await expect(
			harness.tool().execute("call", { script, args: { prompt: "again" } }, undefined, undefined, context),
		).rejects.toThrow("human-authored `ultracode:` or direct workflow");
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
		await harness.input({ type: "input", text: "ultracode: replay test", source: "interactive" }, context);
		await harness.tool().execute("call", { script: replayScript, args: { a: "A" } }, undefined, undefined, context);
		await vi.waitFor(() => expect(prompts).toEqual(["A", "B", "C"]));
		const prior = listWorkflowRuns(cwd, agentDir)[0];
		expect(prior).toBeDefined();
		await harness.command("workflows").handler(`stop ${prior?.runId}`, context);
		await vi.waitFor(() => expect(listWorkflowRuns(cwd, agentDir)[0]?.status).toBe("stopped"));

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

	it("returns a launch-shaped syntax error and ignores tool-level display metadata", async () => {
		const cwd = makeTemp();
		const agentDir = join(cwd, "agent-home");
		const harness = createHarness();
		await createWorkflowExtension({ agentDir, runnerFactory: createRunner })(harness.api);
		const { context } = createContext(cwd);
		await harness.input({ type: "input", text: "ultracode: invalid workflow", source: "interactive" }, context);
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
		await harness.input({ type: "input", text: "ultracode: safe path test", source: "interactive" }, context);

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
