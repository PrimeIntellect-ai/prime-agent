import { describe, expect, it } from "vitest";
import { debtFailures, scan } from "../../../scripts/check-test-policy.mjs";

// The fixture is built from plain strings rather than a template literal, so
// the scan of this file cannot see it: the pin must measure the fixture.
const generatedWorker = [
	"const WORKER_SOURCE = `",
	"while (!existsSync(barrierPath)) {",
	"await new Promise((resolve) => setTimeout(resolve, 5));",
	"}",
	"`;",
].join("\n");

describe("check-test-policy", () => {
	it("scans test code embedded in a generated child-process template string", () => {
		expect(scan(generatedWorker, "store.test.ts")).toEqual([
			expect.objectContaining({ category: "wall-clock-timer", line: 3, detail: "setTimeout/setInterval" }),
		]);
	});

	it("lets frozen debt shrink but never grow", () => {
		const frozen = { "a.test.ts": { "wall-clock-timer": 2 } };
		expect(debtFailures(frozen, { "a.test.ts": { "wall-clock-timer": 2 } })).toEqual([]);
		expect(debtFailures(frozen, { "a.test.ts": { "wall-clock-timer": 3 } })).toEqual([
			expect.objectContaining({ path: "a.test.ts", title: "frozen test-policy debt" }),
		]);
		expect(debtFailures(frozen, {})).toEqual([
			expect.objectContaining({ path: "a.test.ts", title: "stale test-policy debt" }),
		]);
	});
});
