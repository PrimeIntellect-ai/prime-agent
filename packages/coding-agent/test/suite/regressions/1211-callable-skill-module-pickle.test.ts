import { describe, expect, it } from "vitest";
import { buildRlmBootstrapCode } from "../../../src/core/tools/ipython.js";

const SKILL = {
	name: "demo-skill",
	importName: "demo_skill",
	packagePath: "/tmp/demo-skill",
	pyprojectPath: "/tmp/demo-skill/pyproject.toml",
};

// The kernel state snapshot pickles each top-level name with dill. dill saves
// modules by reference, but its dispatch is keyed on the exact type, so the
// ModuleType subclass the bootstrap wraps callable skills in fell through to the
// generic reduce path and raised TypeError. Every Python skill exposing run()
// was dropped from the snapshot, and so was any user variable holding one.
// The behavioural round-trip lives in test/kernel-state-roundtrip.test.ts.
describe("regression #1211: callable Python skill modules survive the kernel state snapshot", () => {
	const code = buildRlmBootstrapCode([SKILL]);

	it("gives the callable skill module wrapper a pickle-by-reference reducer", () => {
		expect(code).toContain("def __reduce__(self):");
		expect(code).toContain("return (_prime_agent_importlib.import_module, (self.__name__,))");
	});

	it("reduces through importlib rather than a kernel-local helper", () => {
		// A reducer naming a function defined in the kernel namespace would be
		// pickled by value, dragging the wrapper class into the payload and
		// reintroducing the failure it is meant to avoid.
		const reducer = code.slice(code.indexOf("def __reduce__(self):"));
		const returned = reducer.slice(0, reducer.indexOf("\n", reducer.indexOf("return ")));
		expect(returned).toContain("_prime_agent_importlib.import_module");
		expect(returned).not.toContain("_prime_agent_wrap_skill_module");
	});

	it("only defines the wrapper when the session has Python skills", () => {
		expect(buildRlmBootstrapCode()).not.toContain("__reduce__");
	});
});
