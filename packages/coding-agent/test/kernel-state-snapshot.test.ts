import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { manifestPathIn, snapshotPathIn } from "../src/core/kernel/state-snapshot.js";

describe("kernel state snapshot paths", () => {
	it("places snapshot + manifest inside the session artifact directory", () => {
		const artifactDir = "/home/u/.prime/agent/session-artifacts/abc-123";
		expect(snapshotPathIn(artifactDir)).toBe(join(artifactDir, "kernel-state.dill"));
		expect(manifestPathIn(artifactDir)).toBe(join(artifactDir, "kernel-state.json"));
	});
});
