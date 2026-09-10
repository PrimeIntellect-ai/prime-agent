import { readFileSync } from "node:fs";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Component, Container, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type CustomMessage, createAsyncBashCompletionMessage } from "../../../src/core/messages.js";
import {
	buildConversationComponents,
	createShellCompletionComponent,
} from "../../../src/modes/interactive/components/conversation-components.js";
import {
	readBackgroundShellHandle,
	ShellCompletionComponent,
} from "../../../src/modes/interactive/components/shell-completion.js";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const ui = { requestRender: vi.fn() } as unknown as TUI;
const code = "job = bash('printf done')\njob";
const result = {
	content: [{ type: "text" as const, text: "<BashHandle pid=42 running command='printf done'>" }],
	details: {
		result: "<BashHandle pid=42 running command='printf done'>",
		stdout: "launch output",
		status: "ok",
		durationMs: 3,
	},
	isError: false,
};
const completion = (exitCode = 0, pid = 42, command = "printf done") =>
	createAsyncBashCompletionMessage({ pid, command, exitCode }, 10000);
const render = (components: readonly Component[]) =>
	components
		.flatMap((component) => component.render(240))
		.map(stripAnsi)
		.join("\n");
const tool = (id = "launch", source = code) =>
	new ToolExecutionComponent("ipython", id, { code: source }, {}, undefined, ui, "/tmp");
const options = { ui, cwd: "/tmp", toolOptions: {}, getToolDefinition: () => undefined };
interface ModePresentation {
	createDisplayedCustomMessageComponent(message: CustomMessage): Component;
}
function liveCompletion(message: CustomMessage, tools: Component[]): Component {
	const chatContainer = new Container();
	for (const entry of tools) chatContainer.addChild(entry);
	const mode = Object.assign(Object.create(InteractiveMode.prototype), { chatContainer });
	return (mode as ModePresentation).createDisplayedCustomMessageComponent(message);
}
function expand(components: readonly Component[]) {
	for (const component of components)
		if ("setExpanded" in component && typeof component.setExpanded === "function") component.setExpanded(true);
}

describe("#2193 shell completion presentation", () => {
	let harness: Harness | undefined;
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});
	it.each([0, 7])("matches live and replay rendering for exit %i without changing the trace", async (exitCode) => {
		const ipython: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "test shell",
			parameters: Type.Object({ code: Type.String() }),
			execute: async () => result,
		};
		harness = await createHarness({ tools: [ipython], persistSession: true });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code }, { id: "launch" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Other work."),
		]);
		await harness.session.prompt("Run in background");
		const notice = completion(exitCode);
		await harness.session.sendCustomMessage(notice, { triggerTurn: false });
		const messages = harness.session.messages;
		const serialized = JSON.stringify(messages);
		const sessionFile = harness.sessionManager.getSessionFile()!;
		const trace = readFileSync(sessionFile, "utf8");
		const replay = buildConversationComponents(messages, options).filter(
			(entry) => entry instanceof ToolExecutionComponent || entry instanceof ShellCompletionComponent,
		);
		const launch = tool();
		launch.markExecutionStarted();
		launch.updateResult(result);
		expect(launch.hasRunningBackgroundShell()).toBe(true);
		expect(render([launch])).not.toContain("✓");
		const storedNotice = messages.find(
			(message): message is CustomMessage => message.role === "custom" && message.customType === notice.customType,
		)!;
		const live = [launch, liveCompletion(storedNotice, [launch])];
		expect(launch.hasRunningBackgroundShell()).toBe(false);
		expect(render(live)).toBe(render(replay));
		expect(render(live)).toContain(exitCode === 0 ? "✓" : "✗");
		expect(render(live)).toContain("cell 3ms");
		expect(render(live)).not.toMatch(/Shell message received|Background shell command|pid 42|exit 0|cycle detail/);
		if (exitCode !== 0) expect(render(live)).toContain("exit 7");
		expand(live);
		expand(replay);
		expect(render(live)).toBe(render(replay));
		for (const line of notice.content.split("\n").filter(Boolean)) expect(render([launch])).toContain(line);
		expect(render([launch])).toContain("launch output");
		expect(render([live[1]!])).toContain("pid 42");
		expect(JSON.stringify(messages)).toBe(serialized);
		expect(readFileSync(sessionFile, "utf8")).toBe(trace);
	});
	it("converges when completion is delivered before the final tool result", () => {
		const launch = tool();
		launch.markExecutionStarted();
		const notice = completion();
		const event = liveCompletion(notice, [launch]);
		expect(render([event])).toContain("Background shell command finished");
		launch.updateResult(result, true);
		expect(render([event])).toContain("Background shell command finished");
		launch.updateResult(result);
		expect(render([event])).toBe("");
		expect(render([launch])).toContain("✓");
		const messages: AgentMessage[] = [
			fauxAssistantMessage(fauxToolCall("ipython", { code }, { id: "launch" }), { stopReason: "toolUse" }),
			notice,
			{ role: "toolResult", toolCallId: "launch", toolName: "ipython", ...result, timestamp: 10001 },
		];
		const replay = buildConversationComponents(messages, options).filter(
			(entry) => entry instanceof ToolExecutionComponent || entry instanceof ShellCompletionComponent,
		);
		expand([launch, event]);
		expand(replay);
		expect(render([launch, event])).toBe(render(replay));
	});
	it.each([0, 8])("retains unmatched exit %i as one compact line and raw full output", (exitCode) => {
		const notice = completion(exitCode, 99);
		const launch = tool();
		launch.updateResult(result);
		const event = createShellCompletionComponent(notice, [launch])!;
		expect(event.render(100)).toHaveLength(1);
		expect(render([event])).toBe(
			exitCode === 0 ? " ✓ Background shell command finished" : " ✗ Background shell command failed · exit 8",
		);
		expand([event]);
		for (const line of notice.content.split("\n").filter(Boolean)) expect(render([event])).toContain(line);
		expect(launch.hasRunningBackgroundShell()).toBe(true);
	});
	it("keeps duplicate candidates, reused PIDs, and assignment-only launches unmatched", () => {
		const first = tool("first");
		first.updateResult(result);
		const second = tool("second");
		second.updateResult(result);
		expect(render([createShellCompletionComponent(completion(), [first, second])!])).toContain(
			"Background shell command finished",
		);
		expect(render([createShellCompletionComponent(completion(0, 42, "different command"), [first])!])).toContain(
			"Background shell command finished",
		);
		const hidden = tool("hidden", "job = bash('printf done')");
		hidden.updateResult({ ...result, details: { status: "ok" } });
		expect(render([createShellCompletionComponent(completion(), [hidden])!])).toContain(
			"Background shell command finished",
		);
	});
	it("never overwrites an earlier raw notification with a duplicate", () => {
		const launch = tool();
		launch.updateResult(result);
		const first = createShellCompletionComponent(completion(), [launch])!;
		const secondNotice = { ...completion(), content: "second raw completion" };
		const second = createShellCompletionComponent(secondNotice, [launch, first])!;
		expand([launch, first, second]);
		expect(render([launch])).toContain("Shell message received.");
		expect(render([second])).toContain("second raw completion");
	});
	it("matches escaped literal commands exactly and recognizes already finished handles", () => {
		for (const command of ["printf 'a'", 'printf "b"', "printf first\nprintf second", "printf C:\\temp"]) {
			const literal = JSON.stringify(command);
			expect(
				readBackgroundShellHandle(`bash(${literal})`, {
					result: `<BashHandle pid=42 exit_code=-9 command=${literal}>`,
				}),
			).toEqual({ pid: 42, command, exitCode: -9 });
		}
		expect(readBackgroundShellHandle("bash('other')", result.details)).toBeUndefined();
		expect(readBackgroundShellHandle("job", result.details)).toBeUndefined();
		expect(readBackgroundShellHandle(code, { result: "42" })).toBeUndefined();
		expect(readBackgroundShellHandle("bash('printf done' + suffix)", result.details)).toBeUndefined();
		const launch = tool();
		launch.updateResult({
			...result,
			details: { ...result.details, result: result.details.result.replace("running", "exit_code=0") },
		});
		expect(render([launch])).toContain("✓");
		expect(launch.hasRunningBackgroundShell()).toBe(false);
	});
	it("renders malformed legacy metadata without crashing or dropping raw content", () => {
		const notice = { ...completion(), timestamp: Number.NaN };
		const launch = tool();
		launch.updateResult(result);
		const event = createShellCompletionComponent(notice, [launch])!;
		expand([launch, event]);
		expect(render([launch, event])).toContain("unknown time");
		expect(render([launch])).toContain("Source: bash");
		const malformed = createShellCompletionComponent({ ...notice, details: { pid: "42" } }, [])!;
		expand([malformed]);
		expect(render([malformed])).toContain("Source: bash");
	});
});
