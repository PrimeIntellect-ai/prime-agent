import { describe, expect, test } from "vitest";
import { renderModelsFile } from "../scripts/render-models.js";

describe("generated model serialization", () => {
	test.each([undefined, [], ["priority", "ultrafast"], ['tier"\n;']])(
		"preserves optional service tier metadata: %j",
		(supportedServiceTiers) => {
			const output = renderModelsFile({
				"openai-codex": {
					"test-model": {
						id: "test-model",
						name: "Test model",
						api: "openai-codex-responses",
						provider: "openai-codex",
						baseUrl: "https://chatgpt.com/backend-api",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
						supportedServiceTiers,
					},
				},
			});
			if (supportedServiceTiers === undefined) {
				expect(output).not.toContain("supportedServiceTiers:");
			} else {
				expect(output).toContain(`supportedServiceTiers: ${JSON.stringify(supportedServiceTiers)},`);
			}
		},
	);

	test("escapes remote strings before writing TypeScript source", () => {
		const id = 'vendor/model";\nexport const injected = true; //';
		const name = 'Model "name"\nwith a newline';
		const output = renderModelsFile({
			"prime-inference": {
				[id]: {
					id,
					name,
					api: "openai-completions",
					provider: "prime-inference",
					baseUrl: "https://api.pinference.ai/api/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
			},
		});

		expect(output).toContain(`\t\t${JSON.stringify(id)}: {`);
		expect(output).toContain(`\t\t\tid: ${JSON.stringify(id)},`);
		expect(output).toContain(`\t\t\tname: ${JSON.stringify(name)},`);
		expect(output).not.toContain(`name: "${name}",`);
	});
});
