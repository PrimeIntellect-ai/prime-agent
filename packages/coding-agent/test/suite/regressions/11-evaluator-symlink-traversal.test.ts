import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createFreshHostDirectory, writeHostFile } from "../../../src/core/host-files.js";
import { stageSpecBenchHostFixtures } from "../../../src/evals/specbench/runner.js";

const temporaryRoots: string[] = [];

function temporaryRoot(label: string): string {
	const root = mkdtempSync(join(tmpdir(), label));
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("issue #11 evaluator host writes", () => {
	test("refuses final and ancestor symlinks without modifying their targets", () => {
		const root = temporaryRoot("prime-issue11-destination-");
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "safe");
		symlinkSync(outside, join(root, "result.json"));

		expect(() => writeHostFile(root, "result.json", "tampered")).toThrow(/symbolic link/);
		expect(readFileSync(outside, "utf8")).toBe("safe");

		rmSync(join(root, "result.json"), { force: true });
		const outsideDirectory = join(root, "outside-directory");
		mkdirSync(outsideDirectory);
		symlinkSync(outsideDirectory, join(root, "cases"));
		expect(() => writeHostFile(root, "cases/result.json", "tampered")).toThrow(/symbolic link/);
		expect(() => readFileSync(join(outsideDirectory, "result.json"))).toThrow();
	});

	test("refuses symlinks in fixture destination ancestors immediately before copying", () => {
		const root = temporaryRoot("prime-issue11-fixture-");
		const workspace = join(root, "workspace");
		const outside = join(root, "outside");
		const source = join(root, "canonical.img");
		mkdirSync(workspace);
		mkdirSync(outside);
		writeFileSync(source, "canonical-image");
		symlinkSync(outside, join(workspace, "fixtures"));
		const digest = createHash("sha256").update(readFileSync(source)).digest("hex");

		expect(() =>
			stageSpecBenchHostFixtures(workspace, [{ sourcePath: source, destinationPath: "fixtures/fs.img", digest }]),
		).toThrow(/symbolic link/);
		expect(() => readFileSync(join(outside, "fs.img"))).toThrow();
	});

	test("creates case roots once and rejects stale directories or symlink replacements", () => {
		const output = temporaryRoot("prime-issue11-case-root-");
		const caseRoot = createFreshHostDirectory(output, "cases/case-a");
		expect(caseRoot).toBe(join(output, "cases", "case-a"));
		expect(() => createFreshHostDirectory(output, "cases/case-a")).toThrow(/refusing unsafe reuse/);

		const outside = join(output, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(output, "cases", "case-b"));
		expect(() => createFreshHostDirectory(output, "cases/case-b")).toThrow(/symbolic link/);
	});
});
