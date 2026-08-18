import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const EMPTY_CATCH = /catch(\s*\([^)]*\))?\s*\{\s*\}/g;

function collectTsFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules") collectTsFiles(full, out);
		} else if (entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

describe("no silent catch blocks", () => {
	test("every empty catch in packages/*/src carries an explanatory comment", () => {
		const srcDirs = readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => join(REPO_ROOT, "packages", e.name, "src"));

		const offenders: string[] = [];
		for (const srcDir of srcDirs) {
			let files: string[];
			try {
				files = collectTsFiles(srcDir);
			} catch {
				// Package without a src dir.
				continue;
			}
			for (const file of files) {
				const content = readFileSync(file, "utf-8");
				for (const match of content.matchAll(EMPTY_CATCH)) {
					const line = content.slice(0, match.index).split("\n").length;
					offenders.push(`${relative(REPO_ROOT, file)}:${line}`);
				}
			}
		}

		expect(
			offenders,
			`Empty catch blocks swallow errors silently. Log the error (getLogger from @earendil-works/pi-ai) or add a comment inside the block explaining why ignoring it is safe:\n${offenders.join("\n")}`,
		).toEqual([]);
	});
});
