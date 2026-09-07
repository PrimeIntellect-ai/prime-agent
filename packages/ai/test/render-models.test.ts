import { describe, expect, test } from "vitest";
import { renderModelsFile } from "../scripts/render-models.js";

describe("generated model serialization", () => {
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
