import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureStartupCwd } from "../src/cli/startup-cwd.js";

function withDeletedCwd(run: (root: string) => void): void {
	const originalCwd = process.cwd();
	const root = mkdtempSync(join(tmpdir(), "prime-agent-deleted-cwd-"));
	const deletedCwd = join(root, "deleted");
	mkdirSync(deletedCwd);

	try {
		process.chdir(deletedCwd);
		rmdirSync(deletedCwd);
		run(root);
	} finally {
		process.chdir(originalCwd);
		rmSync(root, { recursive: true, force: true });
	}
}

describe("ensureStartupCwd", () => {
	it("reports a deleted working directory without a Node stack trace", () => {
		withDeletedCwd(() => {
			const logs: string[] = [];

			expect(ensureStartupCwd([], { log: (message) => logs.push(message) })).toBe(false);
			expect(logs).toEqual([
				"Error: Current working directory no longer exists.",
				"Change to an existing directory or run prime-agent --cwd /path/to/project.",
			]);
		});
	});

	it("recovers through an absolute --cwd", () => {
		withDeletedCwd((root) => {
			const replacementCwd = join(root, "replacement");
			mkdirSync(replacementCwd);

			expect(ensureStartupCwd(["--cwd", replacementCwd], { log: () => {} })).toBe(true);
			expect(realpathSync(process.cwd())).toBe(realpathSync(replacementCwd));
		});
	});

	it("preserves cwd-independent help and version commands", () => {
		withDeletedCwd(() => {
			expect(ensureStartupCwd(["--help"], { log: () => {} })).toBe(true);
			expect(ensureStartupCwd(["--version"], { log: () => {} })).toBe(true);
			expect(ensureStartupCwd(["--", "--help"], { log: () => {} })).toBe(false);
		});
	});
});
