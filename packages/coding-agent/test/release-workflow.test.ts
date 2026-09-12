import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
	name?: string;
	run?: string;
	uses?: string;
	if?: string;
	"continue-on-error"?: boolean;
	with?: Record<string, string>;
}
interface Job {
	needs?: string | string[];
	if?: string;
	"continue-on-error"?: boolean;
	"runs-on"?: string;
	strategy?: { matrix: { include: { platform: string; runner: string }[] } };
	steps: Step[];
	with?: Record<string, string>;
}
interface Workflow {
	jobs: Record<string, Job>;
	on: Record<string, unknown>;
}

const repository = resolve(__dirname, "../../..");
const release: Workflow = parse(readFileSync(join(repository, ".github/workflows/build-binaries.yml"), "utf8"));
const standalone: Workflow = parse(readFileSync(join(repository, ".github/workflows/standalone-binaries.yml"), "utf8"));

function step(job: Job, name: string): Step {
	const found = job.steps.find((entry) => entry.name === name);
	expect(found, `Missing workflow step: ${name}`).toBeDefined();
	return found!;
}

function requiresSuccess(job: Job): void {
	expect(job["continue-on-error"]).toBeUndefined();
	// GitHub adds success() unless a status-check function overrides it.
	expect(job.if ?? "").not.toMatch(/(?:always|failure|cancelled|success)\s*\(/);
	for (const entry of job.steps ?? []) {
		expect(entry["continue-on-error"]).toBeUndefined();
		expect(entry.if ?? "").not.toMatch(/(?:always|failure|cancelled)\s*\(/);
	}
}

describe("release workflow signature gates", () => {
	it("requires successful build and both native final validation jobs before publication", () => {
		const validation = release.jobs["validate-macos"]!;
		expect(validation.needs).toEqual(expect.arrayContaining(["release-context", "build"]));
		expect(validation["runs-on"]).toBe(`\${{ matrix.runner }}`);
		expect(validation.strategy?.matrix.include).toEqual([
			{ platform: "darwin-arm64", runner: "macos-15" },
			{ platform: "darwin-x64", runner: "macos-15-intel" },
		]);
		const publish = release.jobs.publish!;
		expect(publish.needs).toEqual(expect.arrayContaining(["build", "validate-macos"]));
		expect(publish.if).toBe("github.event_name != 'pull_request'");
		requiresSuccess(validation);
		requiresSuccess(publish);
	});

	it("tests final channel archives before uploading receipts, then checks receipts before external writes", () => {
		const validation = release.jobs["validate-macos"]!;
		const verify = step(validation, "Verify and exercise exact final Mac archives");
		expect(verify.run).toContain("for channel in production beta");
		expect(verify.run).toContain("validate-macos-release.mjs");
		expect(verify.run).toContain("standalone-reference/binaries.json");
		expect(verify.run).toContain("test/compiled-artifact.test.ts");
		expect(verify.run).not.toMatch(/\|\|\s*(?:true|:)|continue-on-error/);
		expect(validation.steps.indexOf(verify)).toBeLessThan(
			validation.steps.indexOf(step(validation, "Upload native validation receipts")),
		);
		const publish = release.jobs.publish!;
		const gate = step(publish, "Match native validation to publication artifacts");
		expect(gate.if).toBeUndefined();
		expect(gate.run).toContain(
			"verify-macos-validation-receipts.mjs release-artifacts/production macos-validation production",
		);
		expect(gate.run).toContain("verify-macos-validation-receipts.mjs release-artifacts/beta macos-validation beta");
		const writes = publish.steps.filter((entry) =>
			/aws s3 cp|gh release (?:upload|create|edit)|gh api --method/.test(entry.run ?? ""),
		);
		expect(writes.length).toBeGreaterThan(0);
		for (const write of writes) expect(publish.steps.indexOf(gate)).toBeLessThan(publish.steps.indexOf(write));
	});

	it("retains all four standalone targets and only uploads tested executable identities", () => {
		const build = standalone.jobs.build!;
		expect(build.strategy?.matrix.include.map((entry) => entry.platform)).toEqual([
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
		]);
		const test = step(build, "Test extracted application without JavaScript runtimes on PATH");
		expect(test.run).toContain("test/compiled-artifact.test.ts");
		expect(test.run).toContain("test/release-signatures.test.ts");
		const upload = build.steps.find((entry) => entry.uses?.startsWith("actions/upload-artifact@"))!;
		expect(upload.with?.path).toContain("binaries.json");
		expect(build.steps.indexOf(test)).toBeLessThan(build.steps.indexOf(upload));
		requiresSuccess(build);
		expect(release.jobs.standalone!.with?.build_ref).toBe(`\${{ needs.release-context.outputs.build_ref }}`);
	});

	it.skipIf(process.platform === "win32")(
		"selects both real packer paths for PR validation without allowing publication",
		() => {
			expect(release.on).toHaveProperty("pull_request");
			const directory = mkdtempSync(join(tmpdir(), "prime-release-context-"));
			try {
				const output = join(directory, "output");
				const context = step(release.jobs["release-context"]!, "Resolve release context");
				const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", context.run!], {
					cwd: repository,
					env: {
						...process.env,
						EVENT_NAME: "pull_request",
						GITHUB_SHA_VALUE: "abcdef0123456789",
						RUN_NUMBER: "5",
						RUN_ATTEMPT: "1",
						GITHUB_OUTPUT: output,
					},
					encoding: "utf8",
				});
				expect(result.status, result.stderr).toBe(0);
				const values = Object.fromEntries(
					readFileSync(output, "utf8")
						.trim()
						.split("\n")
						.map((line) => line.split("=")),
				);
				expect(values).toMatchObject({
					publish_beta: "true",
					publish_production: "true",
					build_ref: "abcdef0123456789",
				});
				expect(values.beta_version).toBe(`${values.production_version}-beta.5.1.abcdef0`);
				for (const [name, channel] of [
					["Pack production release", "stable"],
					["Pack beta release", "beta"],
				]) {
					const pack = step(release.jobs.build!, name!);
					expect(pack.run).toContain("npm run release:pack");
					expect(pack.run).toContain(`--channel ${channel}`);
					expect(pack.run).toContain("--binary-dir packages/coding-agent/binaries");
				}
				expect(release.jobs.publish!.if).toBe("github.event_name != 'pull_request'");
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});
