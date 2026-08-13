import { Text } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import type { CustomMessage } from "../src/core/messages.js";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.js";
import { initTheme, preloadCodeHighlighter } from "../src/modes/interactive/theme/theme.js";

describe("CustomMessageComponent", () => {
	beforeAll(async () => {
		await preloadCodeHighlighter();
		initTheme("dark");
	});

	it("rainbow-styles workflow completion messages without changing their text", () => {
		const message: CustomMessage<unknown> = {
			role: "custom",
			customType: "workflow-complete",
			content: "Workflow audit completed",
			display: true,
			timestamp: 1,
		};

		const rendered = new CustomMessageComponent(message).render(80).join("\n");
		expect(stripAnsi(rendered)).toContain("[workflow-complete]");
		expect(stripAnsi(rendered)).toContain("Workflow audit completed");
		expect(rendered).toContain("\x1b[38;2;");
		expect(rendered).not.toContain("\x1b[0m");
	});
	it("does not rewrite output owned by a custom renderer", () => {
		const message: CustomMessage<unknown> = {
			role: "custom",
			customType: "owned",
			content: "Workflow",
			display: true,
			timestamp: 1,
		};
		const owned = "\x1b[31mWorkflow\x1b[39m";
		const rendered = new CustomMessageComponent(message, () => new Text(owned, 0, 0)).render(80).join("\n");
		expect(rendered).toContain(owned);
		expect(rendered).not.toContain("\x1b[38;2;");
	});
});
