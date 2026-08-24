import { describe, expect, it } from "vitest";
import { unwiredEffectBroker } from "../src/core/workflow/default-task-runtime-authority.js";

describe("unwired effect broker", () => {
	it("reports that it cannot execute, naming the missing wiring", () => {
		expect(unwiredEffectBroker().readiness()).toEqual({
			canExecute: false,
			blockingReasons: ["workflow_effect_broker_not_wired"],
		});
	});

	it("names the missing wiring when something tries to execute anyway", () => {
		const broker = unwiredEffectBroker();
		// The previous stub was an empty object cast to the interface, so each of these failed as
		// "x is not a function" at whatever point in a long run first reached it.
		expect(() => broker.classify({} as never, {} as never)).toThrow("workflow_effect_broker_not_wired");
		expect(() => broker.execute({} as never, {} as never)).toThrow("workflow_effect_broker_not_wired");
		expect(() => broker.reconcile({} as never, "key", {} as never)).toThrow("workflow_effect_broker_not_wired");
	});

	it("exposes every member the interface declares, so no call lands on undefined", () => {
		const broker = unwiredEffectBroker();
		for (const member of ["classify", "execute", "reconcile", "readiness"] as const)
			expect(typeof broker[member]).toBe("function");
	});
});
