import { describe, expect, test } from "vitest";
import { deriveAutomaticSessionName, formatTerminalIdentityTitle } from "../src/modes/interactive/interactive-mode.js";

describe("terminal identity", () => {
	test("derives a concise task label from the first prompt", () => {
		expect(deriveAutomaticSessionName("  Review   the Slack bridge routing  ")).toBe(
			"Review the Slack bridge routing",
		);
		expect(deriveAutomaticSessionName("/reload")).toBeUndefined();
		expect(
			deriveAutomaticSessionName(
				"Investigate why the Prime Agent Slack bridge does not deliver messages to an existing thread",
			),
		).toBe("Investigate why the Prime Agent Slack bridge does…");
	});

	test("puts the stable short id and task first for desktop terminal tabs", () => {
		expect(
			formatTerminalIdentityTitle({
				appTitle: "Prime Agent",
				sessionId: "01a0092b-fc99-72af-a405-ca7992bb0689",
				sessionName: "Slack bridge routing",
				cwd: "/home/tami/pi-slack",
			}),
		).toBe("[B0689] — Slack bridge routing — pi-slack | Prime Agent");
	});
});
