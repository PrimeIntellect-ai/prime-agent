import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("ignores null content blocks from malformed provider responses", () => {
		initTheme("dark");

		const malformedContent = [null, { type: "text", text: "hello" }] as unknown as AssistantMessage["content"];
		const component = new AssistantMessageComponent(createAssistantMessage(malformedContent));
		expect(stripAnsi(component.render(40).join("\n"))).toContain("hello");

		const updatedContent = [null, { type: "text", text: "hello again" }] as unknown as AssistantMessage["content"];
		component.updateContent(createAssistantMessage(updatedContent));
		expect(stripAnsi(component.render(40).join("\n"))).toContain("hello again");
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "ipython", arguments: { code: "open('file.txt').read()" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders an abort status for messages with tool calls", () => {
		initTheme("dark");

		const message = {
			...createAssistantMessage([
				{ type: "toolCall" as const, id: "tool-1", name: "ipython", arguments: { code: "while True: pass" } },
			]),
			stopReason: "aborted" as const,
			errorMessage: "Operation aborted",
		};
		const rendered = stripAnsi(new AssistantMessageComponent(message).render(80).join("\n"));

		expect(rendered).toContain("Operation aborted");
	});

	test("honors initial expansion for multiline assistant errors", () => {
		initTheme("dark");

		const message = {
			...createAssistantMessage([]),
			stopReason: "error" as const,
			errorMessage: [
				"Provider request failed",
				"Traceback (most recent call last):",
				'  File "/tmp/internal.py", line 12, in run',
				"RuntimeError: backend crashed",
			].join("\n"),
		};
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", { expanded: true });
		const rendered = stripAnsi(component.render(100).join("\n"));

		expect(rendered).toContain("/tmp/internal.py");
		expect(rendered).not.toContain("Ctrl+O to expand");
	});

	test("renders auth recovery guidance inline for simple provider errors", () => {
		initTheme("dark");

		const message = {
			...createAssistantMessage([]),
			stopReason: "error" as const,
			errorMessage: "401 status code (no body)\n\nRun /login to update credentials.",
		};
		const component = new AssistantMessageComponent(message);
		const raw = component.render(120).join("\n");
		const rendered = stripAnsi(raw);

		expect(rendered).toContain("Error: 401 status code (no body) · Run /login to update credentials.");
		expect(rendered).not.toContain("Ctrl+O to expand");
		expect(raw).toContain(theme.getFgAnsi("error"));
	});

	test("renders collapsed multiline assistant errors as errors", () => {
		initTheme("dark");

		const message = {
			...createAssistantMessage([]),
			stopReason: "error" as const,
			errorMessage: [
				"Provider request failed",
				"Traceback (most recent call last):",
				'  File "/tmp/internal.py", line 12, in run',
				"RuntimeError: backend crashed",
			].join("\n"),
		};
		const component = new AssistantMessageComponent(message);
		const raw = component.render(100).join("\n");
		const rendered = stripAnsi(raw);

		expect(rendered).toContain("Error: Provider request failed");
		expect(rendered).toContain("to expand");
		expect(raw).toContain(theme.getFgAnsi("error"));
	});
});

describe("AssistantMessageComponent streaming identity", () => {
	// updateContent applied incrementally (as during daemon streaming) must render
	// byte-identical to a fresh component built from the final message. Guards the
	// reconcile-instead-of-rebuild optimization.
	function expectIdentity(component: AssistantMessageComponent, message: AssistantMessage, width = 90) {
		const incremental = component.render(width);
		const fresh = new AssistantMessageComponent(message).render(width);
		expect(incremental).toEqual(fresh);
	}

	test("growing text block renders identically", () => {
		initTheme("dark");
		const corpus =
			"## Heading\n\nSome paragraph text that wraps.\n\n- one\n- two\n\n```js\nconst a = 1;\n```\n\nEnd.";
		const component = new AssistantMessageComponent();
		let text = "";
		for (let offset = 0; offset < corpus.length; offset += 5) {
			text += corpus.slice(offset, offset + 5);
			const message = createAssistantMessage([{ type: "text", text }]);
			component.updateContent(message);
			expectIdentity(component, message);
		}
	});

	test("thinking then text then tool call renders identically", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();
		const steps: AssistantMessage["content"][] = [
			[{ type: "thinking", thinking: "Let me think" }],
			[{ type: "thinking", thinking: "Let me think about this more carefully." }],
			[
				{ type: "thinking", thinking: "Let me think about this more carefully." },
				{ type: "text", text: "Here is" },
			],
			[
				{ type: "thinking", thinking: "Let me think about this more carefully." },
				{ type: "text", text: "Here is the answer with **bold** text." },
			],
			[
				{ type: "thinking", thinking: "Let me think about this more carefully." },
				{ type: "text", text: "Here is the answer with **bold** text." },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
			],
		];
		for (const content of steps) {
			const message = createAssistantMessage(content);
			component.updateContent(message);
			expectIdentity(component, message);
		}
	});

	test("aborted and error stop reasons render identically after streaming", () => {
		initTheme("dark");
		for (const final of [
			{ stopReason: "aborted" as const, errorMessage: undefined },
			{ stopReason: "error" as const, errorMessage: "Provider exploded" },
		]) {
			const component = new AssistantMessageComponent();
			component.updateContent(createAssistantMessage([{ type: "text", text: "Partial out" }]));
			component.render(90);
			const message = {
				...createAssistantMessage([{ type: "text", text: "Partial output" }]),
				...final,
			};
			component.updateContent(message);
			const incremental = component.render(90);
			const fresh = new AssistantMessageComponent(message).render(90);
			expect(incremental).toEqual(fresh);
		}
	});

	test("hidden thinking renders nothing and the reveal shows the trace", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());

		const thinking = [
			"**Weighing options**",
			"",
			"Some detail about the options.",
			"",
			"**Deciding the approach**",
			"",
			"More detail.",
		].join("\n");
		const message = createAssistantMessage([
			{ type: "thinking", thinking },
			{ type: "text", text: "Answer." },
		]);

		// Hidden by default: no thinking row at all, only the text block renders.
		const hiddenRaw = new AssistantMessageComponent(message, true).render(120).join("\n");
		const hidden = stripAnsi(hiddenRaw);
		expect(hidden).toContain("Answer.");
		expect(hidden).not.toContain("Thinking:");
		expect(hidden).not.toContain("Some detail");
		expect(hiddenRaw).not.toContain(theme.getFgAnsi("thinkingText"));

		// Revealed: the label row with the hide hint, then the dim trace.
		const revealedRaw = new AssistantMessageComponent(message, false).render(120).join("\n");
		const revealed = stripAnsi(revealedRaw);
		expect(revealed).toContain("Thinking: (Ctrl+T to hide)");
		expect(revealed).toContain("Some detail about the options.");
		expect(revealedRaw).toContain(theme.getFgAnsi("thinkingText"));
		expect(revealedRaw).toContain(theme.getFgAnsi("dim"));
		const labelLine = revealedRaw.split("\n").find((line) => line.includes("Thinking:"));
		expect(labelLine).toBeDefined();
		expect(labelLine).not.toContain("\x1b[1m");
	});

	test("a thinking-only message renders nothing while hidden", () => {
		initTheme("dark");

		const message = createAssistantMessage([{ type: "thinking", thinking: "Trace only." }]);
		const lines = new AssistantMessageComponent(message, true).render(80);
		expect(lines).toEqual([]);
	});

	test("setHideThinkingBlock toggles the reveal without stale rows", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());

		const component = new AssistantMessageComponent(undefined, true);
		component.updateContent(createAssistantMessage([{ type: "thinking", thinking: "Trace." }]));
		expect(component.render(120)).toEqual([]);

		component.setHideThinkingBlock(false);
		const revealed = stripAnsi(component.render(120).join("\n"));
		expect(revealed).toContain("Thinking: (Ctrl+T to hide)");
		expect(revealed).toContain("Trace.");

		component.setHideThinkingBlock(true);
		expect(component.render(120)).toEqual([]);
	});

	test("setHideThinkingBlock and setExpanded mid-stream render identically", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();
		const content: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "Deep thoughts here." },
			{ type: "text", text: "Visible answer." },
		];
		const message = createAssistantMessage(content);
		component.updateContent(message);
		component.render(90);

		component.setHideThinkingBlock(true);
		const hidden = component.render(90);
		const freshHidden = new AssistantMessageComponent(message, true).render(90);
		expect(hidden).toEqual(freshHidden);

		component.setHideThinkingBlock(false);
		const shown = component.render(90);
		const freshShown = new AssistantMessageComponent(message, false).render(90);
		expect(shown).toEqual(freshShown);
	});

	test("width change mid-stream renders identically", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();
		const corpus = "A paragraph long enough to wrap at narrow widths with **style** and `code`.";
		let text = "";
		const widths = [40, 90, 60];
		for (let offset = 0, i = 0; offset < corpus.length; offset += 8, i++) {
			text += corpus.slice(offset, offset + 8);
			const message = createAssistantMessage([{ type: "text", text }]);
			component.updateContent(message);
			expectIdentity(component, message, widths[i % widths.length]);
		}
	});
});

describe("AssistantMessageComponent body text color", () => {
	test("renders assistant body text in the softened mdBody color", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "Plain answer." }]),
		);
		const raw = component.render(120).join("\n");

		expect(stripAnsi(raw)).toContain("Plain answer.");
		expect(raw).toContain(theme.getFgAnsi("mdBody"));
	});

	test("keeps heading and inline code colors on top of mdBody", () => {
		initTheme("dark");

		const message = createAssistantMessage([{ type: "text", text: "## Title\n\nBody with `code`." }]);
		const raw = new AssistantMessageComponent(message).render(120).join("\n");

		expect(raw).toContain(theme.getFgAnsi("mdHeading"));
		expect(raw).toContain(theme.getFgAnsi("mdCode"));
		expect(raw).toContain(theme.getFgAnsi("mdBody"));
	});

	test("renders the thinking trace dimmer than the label, never mdBody", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());

		const message = createAssistantMessage([{ type: "thinking", thinking: "Quiet reasoning." }]);
		const raw = new AssistantMessageComponent(message, false).render(120).join("\n");

		expect(stripAnsi(raw)).toContain("Quiet reasoning.");
		expect(raw).toContain(theme.getFgAnsi("dim"));
		expect(raw).toContain(theme.getFgAnsi("thinkingText"));
		expect(raw).not.toContain(theme.getFgAnsi("mdBody"));
	});

	test("keeps assistant prose on mdBody while the thinking trace stays dim", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());

		const message = createAssistantMessage([
			{ type: "thinking", thinking: "Trace line." },
			{ type: "text", text: "Answer prose." },
		]);
		const raw = new AssistantMessageComponent(message, false).render(120).join("\n");

		expect(raw).toContain(theme.getFgAnsi("dim"));
		expect(raw).toContain(theme.getFgAnsi("mdBody"));
		expect(theme.getFgAnsi("dim")).not.toBe(theme.getFgAnsi("mdBody"));
	});
});
