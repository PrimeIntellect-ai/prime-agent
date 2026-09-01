import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AvoStore } from "../../../src/core/avo/index.js";

describe("issue #7: stale AVO store writers", () => {
	it("rejects a stale direct writer without overwriting newer persisted state", () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "prime-avo-stale-writer-"));
		const now = () => "2026-08-31T00:00:00.000Z";
		try {
			const stale = new AvoStore(artifactDir, "shared-session", now);
			const current = new AvoStore(artifactDir, "shared-session", now);
			current.initialize("Preserve the current writer");

			expect(() => stale.initialize("Overwrite from a stale snapshot")).toThrow(
				/AVO state changed on disk; reopen the store before writing/,
			);
			expect(() => stale.getState()).toThrow(/reopen the store before writing/);

			const persisted = JSON.parse(readFileSync(join(artifactDir, "avo", "state.json"), "utf8")) as {
				objective?: string;
			};
			expect(persisted.objective).toBe("Preserve the current writer");
			expect(new AvoStore(artifactDir, "shared-session", now).getState().objective).toBe(
				"Preserve the current writer",
			);
		} finally {
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});

	it("does not make an active writer stale when another store only reads current state", () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "prime-avo-current-reader-"));
		try {
			const writer = new AvoStore(artifactDir, "shared-session", () => "2026-08-31T00:00:00.000Z");
			writer.initialize("Keep read-only construction inert");
			const statePath = join(artifactDir, "avo", "state.json");
			const beforeRead = readFileSync(statePath, "utf8");

			const reader = new AvoStore(artifactDir, "shared-session", () => "2026-08-31T01:00:00.000Z");
			expect(reader.getState().objective).toBe("Keep read-only construction inert");
			expect(readFileSync(statePath, "utf8")).toBe(beforeRead);

			expect(() => writer.setHorizon("long")).not.toThrow();
			expect(new AvoStore(artifactDir, "shared-session").getState().routing.horizon).toBe("long");
		} finally {
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});
});
