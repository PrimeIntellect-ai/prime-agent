import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.js";

describe("/switch session model persistence", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("changes only the active model when default persistence is disabled", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: { defaultProvider: "faux", defaultModel: "faux-1" },
		});
		harnesses.push(harness);

		await harness.session.setModel(harness.getModel("faux-2")!, { persistDefault: false });
		await harness.settingsManager.flush();

		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.settingsManager.getDefaultProvider()).toBe("faux");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-1");
		expect(harness.settingsManager.getGlobalSettings()).toMatchObject({
			defaultProvider: "faux",
			defaultModel: "faux-1",
		});
	});

	it("still updates the configured default for an explicit model selection", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			settings: { defaultProvider: "faux", defaultModel: "faux-1" },
		});
		harnesses.push(harness);

		await harness.session.setModel(harness.getModel("faux-2")!);
		await harness.settingsManager.flush();

		expect(harness.settingsManager.getDefaultProvider()).toBe("faux");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-2");
	});
});
