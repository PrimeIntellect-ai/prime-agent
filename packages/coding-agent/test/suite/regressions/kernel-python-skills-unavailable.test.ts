import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE } from "../../../src/core/messages.js";
import { createHarness, getMessageText } from "../harness.js";

describe("Python skills unavailable message", () => {
	it("queues the unavailable-skill report as next-turn context the model sees", async () => {
		const harness = await createHarness();
		try {
			let providerSawUnavailableSkills = false;
			harness.setResponses([
				(context) => {
					providerSawUnavailableSkills = context.messages.some((message) =>
						getMessageText(message).includes("failed to import into the Python kernel"),
					);
					return fauxAssistantMessage("queued turn complete");
				},
			]);

			(
				harness.session as unknown as { _onPythonSkillsUnavailable(errors: Record<string, string>): void }
			)._onPythonSkillsUnavailable({
				websearch: "No module named 'websearch'",
				edit: "boom",
			});
			await harness.session.prompt("go");

			const delivered = harness.session.messages.find(
				(message) => message.role === "custom" && message.customType === PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
			);
			expect(delivered).toMatchObject({ display: true, details: { skills: ["websearch", "edit"] } });
			expect(getMessageText(delivered!)).toContain("- websearch: No module named 'websearch'");
			expect(getMessageText(delivered!)).toContain("- edit: boom");
			expect(providerSawUnavailableSkills).toBe(true);
		} finally {
			harness.cleanup();
		}
	});
});
