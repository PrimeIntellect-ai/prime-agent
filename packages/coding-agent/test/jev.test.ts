import { describe, expect, it } from "vitest";
import { filterSkillsInSystemPrompt, JevClient, type JevSkill, selectSkillWithJev } from "../src/core/jev.js";

const skills: JevSkill[] = [
	{ name: "debugging", description: "Diagnose and fix failing software." },
	{ name: "docs", description: "Write and review technical documentation." },
];

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("JevClient", () => {
	it("posts a typed choice request and returns the selected answer", async () => {
		let request: Request | undefined;
		const client = new JevClient({
			baseUrl: "http://localhost:8080",
			fetchImpl: async (input, init) => {
				request = new Request(input, init);
				return response({
					answers: {
						skill: {
							type: "choice",
							choice: "debugging",
							probabilities: { debugging: 0.9, docs: 0.1 },
							confidence: 0.8,
						},
					},
				});
			},
		});

		const result = await client.decideSkill("The build fails with a TypeScript error", skills);
		expect(result).toEqual({ name: "debugging", confidence: 0.8 });
		expect(request?.url).toBe("http://localhost:8080/v1/systemone");
		expect(await request?.json()).toMatchObject({ model: "jev-latest" });
	});

	it("returns no selection when Jev is unavailable", async () => {
		const client = new JevClient({
			fetchImpl: async () => response({ detail: "offline" }, 503),
		});
		expect(await selectSkillWithJev(client, "anything", skills, 0.5)).toBeUndefined();
	});
});

describe("filterSkillsInSystemPrompt", () => {
	it("keeps selected skill entries and the available-skills wrapper", () => {
		const prompt = [
			"Rules",
			"<available_skills>",
			"  <skill>",
			"    <name>debugging</name>",
			"  </skill>",
			"  <skill>",
			"    <name>docs</name>",
			"  </skill>",
			"</available_skills>",
		].join("\n");
		expect(filterSkillsInSystemPrompt(prompt, ["debugging"])).toContain("<name>debugging</name>");
		expect(filterSkillsInSystemPrompt(prompt, ["debugging"])).not.toContain("<name>docs</name>");
	});
});
