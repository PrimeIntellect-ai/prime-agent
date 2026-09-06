import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const workflow = JSON.parse(
	execFileSync(
		process.execPath,
		[
			"-e",
			"console.log(JSON.stringify(Bun.YAML.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))))",
			join(repoRoot, ".github/workflows/build-binaries.yml"),
		],
		{ encoding: "utf8" },
	),
) as {
	jobs: { publish: { steps: { name: string; run?: string }[] } };
};
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The publish job runs on Ubuntu and uses GNU sha256sum.
describe.skipIf(process.platform !== "linux")("release publish preflight", () => {
	for (const channel of ["production", "beta"] as const) {
		const stepName =
			channel === "production" ? "Publish production channel to R2" : "Publish immutable beta artifacts to R2";
		const script = workflow.jobs.publish.steps.find((step) => step.name === stepName)?.run;
		if (!script) throw new Error(`Missing publish step: ${stepName}`);

		test.each(["complete", "missing-all", "missing-one", "corrupt", "empty-inventory"])(
			`${channel} checks the archive inventory before uploading: %s`,
			(state) => {
				const root = mkdtempSync(join(tmpdir(), "prime-release-publish-"));
				roots.push(root);
				const artifacts = join(root, "release-artifacts", channel);
				const tools = join(root, "tools");
				const log = join(root, "uploads.log");
				mkdirSync(artifacts, { recursive: true });
				mkdirSync(tools);
				const names = ["prime-agent-1.2.3-linux-x64.tar.gz", "prime-agent-1.2.3-darwin-arm64.tar.gz"];
				const content = Buffer.from("archive bytes");
				const hash = createHash("sha256").update(content).digest("hex");
				for (const name of names) writeFileSync(join(artifacts, name), content);
				writeFileSync(join(artifacts, "SHA256SUMS"), names.map((name) => `${hash}  ${name}\n`).join(""));
				writeFileSync(join(artifacts, channel === "production" ? "stable" : "beta"), "v1.2.3\n");
				writeFileSync(join(artifacts, channel === "production" ? "latest.json" : "beta.json"), "{}\n");

				if (state === "missing-all") {
					for (const name of names) rmSync(join(artifacts, name));
				} else if (state === "missing-one") {
					rmSync(join(artifacts, names[1]));
				} else if (state === "corrupt") {
					writeFileSync(join(artifacts, names[1]), "corrupt");
				} else if (state === "empty-inventory") {
					writeFileSync(join(artifacts, "SHA256SUMS"), "");
				}

				writeFileSync(join(tools, "aws"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$UPLOAD_LOG"\n');
				chmodSync(join(tools, "aws"), 0o755);
				const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
					cwd: root,
					encoding: "utf8",
					env: {
						PATH: `${tools}:/usr/bin:/bin`,
						UPLOAD_LOG: log,
						R2_BUCKET: "fixture",
						R2_ENDPOINT_URL: "https://uploads.invalid",
						PRODUCTION_VERSION: "1.2.3",
						BETA_VERSION: "1.2.3",
					},
				});
				if (state === "complete") {
					expect(result.status, result.stderr).toBe(0);
					const uploads = readFileSync(log, "utf8").trim().split("\n");
					expect(uploads.filter((line) => line.includes(".tar.gz"))).toHaveLength(2);
					expect(uploads[2]).toContain("/SHA256SUMS");
				} else {
					expect(result.status).not.toBe(0);
					expect(existsSync(log)).toBe(false);
				}
			},
		);
	}
});
