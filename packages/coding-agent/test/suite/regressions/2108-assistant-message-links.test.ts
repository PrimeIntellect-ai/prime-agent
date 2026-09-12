import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, getCapabilities, setCapabilities, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.js";
import { buildConversationComponents } from "../../../src/modes/interactive/components/conversation-components.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../../../src/modes/interactive/theme/theme.js";

import { createHarness } from "../harness.js";

const cwd = resolve("/tmp/session #1 100%/project");
const reportUrl = pathToFileURL(resolve(cwd, "audit-out/report.md")).href;
let message: AssistantMessage;

function linkTargets(lines: string[]): string[] {
	return [...new Set([...lines.join("\n").matchAll(/\x1b\]8;;([^\x1b]+)\x1b\\/g)].map((match) => match[1]))];
}

describe("assistant Markdown file links", () => {
	const capabilities = getCapabilities();
	beforeAll(async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("[Audit report](audit-out/report.md)")]);
			await harness.session.prompt("Link the audit report.");
			const response = harness.session.messages.find((entry) => entry.role === "assistant");
			if (!response || response.role !== "assistant") throw new Error("Missing faux assistant response");
			message = response;
		} finally {
			harness.cleanup();
		}
	});
	beforeEach(() => {
		initTheme("dark");
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	});
	afterEach(() => setCapabilities(capabilities));

	test.each([
		["audit-out/report.md", reportUrl],
		["#overview", "#overview"],
		["./audit-out/report.md", reportUrl],
		["../report.md", pathToFileURL(resolve(cwd, "../report.md")).href],
		["/tmp/report.md", pathToFileURL("/tmp/report.md").href],
		["<audit-out/my report.md>", pathToFileURL(resolve(cwd, "audit-out/my report.md")).href],
		["audit-out/my%20report.md", pathToFileURL(resolve(cwd, "audit-out/my report.md")).href],
		["audit-out/report%23draft%25.md", pathToFileURL(resolve(cwd, "audit-out/report#draft%.md")).href],
		["audit-out/report.md#findings", `${reportUrl}#findings`],
		["file:///tmp/report.md", "file:///tmp/report.md"],
		["C:/repo/report.md", "file:///C:/repo/report.md"],
		[String.raw`C:\repo\report.md`, "file:///C:/repo/report.md"],
		["<D:/repo/my report.md>", "file:///D:/repo/my%20report.md"],
		["D:/repo/report%23draft.md#findings", "file:///D:/repo/report%23draft.md#findings"],
		["https://example.com/report?q=1#findings", "https://example.com/report?q=1#findings"],
		["http://example.com/report", "http://example.com/report"],
		["mailto:reader@example.com", "mailto:reader@example.com"],
		["https://[invalid", "https://[invalid"],
	])("resolves %s without changing the label", (href, expected) => {
		const component = new AssistantMessageComponent(
			{ ...message, content: [{ type: "text", text: `[Audit report](${href})` }] },
			false,
			undefined,
			{ cwd },
		);
		const lines = component.render(80);
		expect(linkTargets(lines)).toEqual([expected]);
		expect(stripAnsi(lines.join("\n")).trim()).toBe("Audit report");
	});

	test.each(["addMessageToChat", "startAssistantStreamingMessage"] as const)(
		"%s uses the attached session cwd and produces an openable target",
		(method) => {
			const chatContainer = new Container();
			const mode = Object.assign(Object.create(InteractiveMode.prototype), {
				chatContainer,
				connectionState: { cwd },
				uiServices: { getInitialCwd: () => resolve("/tmp/different-launch-directory") },
				getMarkdownThemeWithSettings: getMarkdownTheme,
			}) as {
				addMessageToChat(message: AssistantMessage): void;
				startAssistantStreamingMessage(message: AssistantMessage): void;
			};
			mode[method](message);
			const targets = linkTargets(chatContainer.render(80));
			expect(targets).toEqual([reportUrl]);
			const onOpenUrl = vi.fn();
			const ui = Object.assign(Object.create(TUI.prototype), { onOpenUrl }) as {
				openHyperlink(url: string): void;
			};
			ui.openHyperlink(targets[0]);
			expect(onOpenUrl).toHaveBeenCalledExactlyOnceWith(reportUrl);
		},
	);

	test("conversation replay carries the session cwd", () => {
		const components = buildConversationComponents([message], {
			cwd,
			ui: new TUI({} as TUI["terminal"]),
			toolOptions: {},
			getToolDefinition: () => undefined,
		});
		expect(linkTargets(components.flatMap((component) => component.render(80)))).toEqual([reportUrl]);
	});

	test("streamed reference links and thinking links retain their base after invalidation", () => {
		const component = new AssistantMessageComponent(undefined, false, undefined, { cwd });
		component.updateContent({ ...message, content: [{ type: "text", text: "[Audit report][report]" }] }, true);
		expect(linkTargets(component.render(80))).toEqual([]);
		component.updateContent(
			{
				...message,
				content: [
					{ type: "thinking", thinking: "[Audit report](audit-out/report.md)" },
					{ type: "text", text: "[Audit report][report]\n\n[report]: audit-out/report.md" },
				],
			},
			false,
		);
		expect(linkTargets(component.render(80))).toEqual([reportUrl]);
		component.invalidate();
		expect(linkTargets(component.render(8))).toEqual([reportUrl]);
	});

	test("keeps the visible path fallback when the terminal does not support hyperlinks", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const component = new AssistantMessageComponent(message, false, undefined, { cwd });
		const lines = component.render(80);
		expect(linkTargets(lines)).toEqual([]);
		expect(stripAnsi(lines.join("\n")).trim()).toBe("Audit report (audit-out/report.md)");
	});
});
