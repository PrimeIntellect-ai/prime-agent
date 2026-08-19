import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createGcloudWorkflowGoalAuthoritySourceResolver } from "../src/core/workflow/goal-authority-source.js";
import type { WorkflowGoalAuthoritySource } from "../src/core/workflow/shell.js";

it("retrieves the exact immutable object generation without a latest-object fallback", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-goal-source-gcloud-"));
	const executablePath = join(root, "gcloud");
	const expectedUrl = "gs://authority/program.md";
	await writeFile(
		executablePath,
		`#!/usr/bin/env node
const expected = ${JSON.stringify(expectedUrl)};
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(["storage", "cp", expected, "-", "--if-generation-match=1786938985509738", "--quiet"])) process.exit(2);
process.stdout.write("goal source");
`,
		{ mode: 0o700 },
	);
	await chmod(executablePath, 0o700);
	const source: WorkflowGoalAuthoritySource = {
		kind: "immutable_object",
		uri: "gs://authority/program.md",
		objectGeneration: "1786938985509738",
		objectDigest: "39368a9b4b46084f37ab63e2e9b0a693a1aab09bdd6407037f2c8260545ccf98",
		objectSizeBytes: 11,
		parsedObjective: "advance the program",
		boundaryIds: ["preserve-source"],
		gateIds: ["program-gate"],
		parsedProgramDigest: "1".repeat(64),
		sourceBindingDigest: "2".repeat(64),
	};
	try {
		const material = await createGcloudWorkflowGoalAuthoritySourceResolver({ executablePath }).resolve(source);
		expect(new TextDecoder().decode(material.bytes)).toBe("goal source");
		expect(material).toMatchObject({
			objectGeneration: source.objectGeneration,
			parsedObjective: source.parsedObjective,
			boundaryIds: source.boundaryIds,
			gateIds: source.gateIds,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
