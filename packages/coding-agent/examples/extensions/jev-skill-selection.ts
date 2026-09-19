import {
	type ExtensionAPI,
	filterSkillsInSystemPrompt,
	JevClient,
	type JevSkill,
	selectSkillWithJev,
} from "@earendil-works/pi-coding-agent";

const OPERATIONAL_SKILLS = new Set(["agent-message", "agent-observe", "compact", "goal", "refine", "rlm-heartbeat"]);

function enabled(): boolean {
	return process.env.PREME_AGENT_JEV_SKILL_SELECTION === "1";
}

function mode(): "advisory" | "filter" {
	return process.env.PREME_AGENT_JEV_SKILL_MODE === "filter" ? "filter" : "advisory";
}

/**
 * Optionally uses LocalJev to recommend the most relevant skill for each prompt.
 * Set PREME_AGENT_JEV_SKILL_SELECTION=1 to enable it.
 */
export default function jevSkillSelection(pi: ExtensionAPI): void {
	if (!enabled()) return;

	pi.on("before_agent_start", async (event) => {
		const skills = (event.systemPromptOptions.skills ?? [])
			.filter((skill) => !skill.disableModelInvocation)
			.map<JevSkill>((skill) => ({ name: skill.name, description: skill.description }));
		const client = new JevClient({
			baseUrl: process.env.LOCALJEV_URL,
			apiKey: process.env.LOCALJEV_API_KEY,
			timeoutMs: Number(process.env.PREME_AGENT_JEV_TIMEOUT_MS ?? 1500),
		});
		const selection = await selectSkillWithJev(
			client,
			event.prompt,
			skills,
			Number(process.env.PREME_AGENT_JEV_MIN_CONFIDENCE ?? 0.55),
		);
		if (!selection) return;

		if (mode() === "filter") {
			const selected = [selection.name, ...OPERATIONAL_SKILLS];
			return { systemPrompt: filterSkillsInSystemPrompt(event.systemPrompt, selected) };
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\nJev suggests the most relevant skill is \`${selection.name}\`. Verify the match before using it.`,
		};
	});
}
