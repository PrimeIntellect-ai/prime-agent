import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { NATIVE_PLATFORMS } from "../src/utils/native-installation.js";

interface Step {
	name?: string;
	id?: string;
	run?: string;
	uses?: string;
	if?: string;
	"continue-on-error"?: boolean;
	with?: Record<string, string>;
}
interface Job {
	needs?: string | string[];
	if?: string;
	outputs?: Record<string, string>;
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
// The same command the release workflow uses to enumerate publishable platforms.
const releasePlatforms = spawnSync(process.execPath, [join(repository, "scripts/release-platforms.mjs")], {
	encoding: "utf8",
})
	.stdout.trim()
	.split("\n");
const release: Workflow = parse(readFileSync(join(repository, ".github/workflows/build-binaries.yml"), "utf8"));
const standalone: Workflow = parse(readFileSync(join(repository, ".github/workflows/standalone-binaries.yml"), "utf8"));
// The skip-superseded gate: dependent jobs build only when release-context succeeded on a current tip.
const staleGate = "needs.release-context.result == 'success' && needs.release-context.outputs.stale != 'true'";

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
		expect(publish.if).toBe(`github.event_name != 'pull_request' && ${staleGate}`);
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

	it.each([{ channels: ["production"] }, { channels: ["beta"] }, { channels: ["production", "beta"] }])(
		"finds the downloaded manifests when publishing $channels",
		({ channels }) => {
			const validation = release.jobs["validate-macos"]!;
			const directory = mkdtempSync(join(tmpdir(), "prime-release-downloads-"));
			try {
				mkdirSync(join(directory, "packages/coding-agent"), { recursive: true });
				for (const channel of channels) {
					const name = `prime-agent-${channel}`;
					const download = validation.steps.find(
						(entry) =>
							entry.uses?.startsWith("actions/download-artifact@") &&
							(entry.with?.name === name || entry.with?.pattern === "prime-agent-*"),
					);
					expect(download, `Missing download for ${channel}`).toBeDefined();
					if (download!.if) expect(download!.if).toBe(`env.PUBLISH_${channel.toUpperCase()} == 'true'`);
					// download-artifact nests pattern matches only when more than one artifact matches.
					const destination = download!.with!.path!.replace(`\${{ runner.temp }}`, directory);
					const path = download!.with!.name || channels.length === 1 ? destination : join(destination, name);
					mkdirSync(path, { recursive: true });
					writeFileSync(join(path, channel === "production" ? "latest.json" : "beta.json"), "{}");
					writeFileSync(join(path, "prime-agent-1.2.3-darwin-arm64.tar.gz"), "");
				}
				const result = spawnSync(
					"bash",
					[
						"-e",
						"-o",
						"pipefail",
						"-c",
						`node() { test -f "$2/latest.json" || test -f "$2/beta.json"; }
npx() { test -f "$PRIME_AGENT_TEST_ARCHIVE"; printf '%s\\n' "$PRIME_AGENT_TEST_ARCHIVE"; }
${step(validation, "Verify and exercise exact final Mac archives").run}`,
					],
					{
						cwd: directory,
						env: {
							...process.env,
							RUNNER_TEMP: directory,
							TARGET_PLATFORM: "darwin-arm64",
							PUBLISH_PRODUCTION: String(channels.includes("production")),
							PUBLISH_BETA: String(channels.includes("beta")),
						},
						encoding: "utf8",
					},
				);
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout.trim().split("\n")).toEqual(
					channels.map((channel) =>
						join(directory, `final-artifacts/prime-agent-${channel}/prime-agent-1.2.3-darwin-arm64.tar.gz`),
					),
				);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("retains every standalone target and only uploads tested executable identities", () => {
		const build = standalone.jobs.build!;
		expect(build.strategy?.matrix.include.map((entry) => entry.platform)).toEqual(releasePlatforms);
		// Each target must be compiled explicitly; the host default cannot produce a cross-build.
		expect(step(build, "Compile standalone application").run).toContain(`--platform \${{ matrix.platform }}`);
		const test = step(build, "Test extracted application without JavaScript runtimes on PATH");
		expect(test.run).toContain("test/compiled-artifact.test.ts");
		expect(test.run).toContain("test/release-signatures.test.ts");
		const upload = build.steps.find((entry) => entry.uses?.startsWith("actions/upload-artifact@"))!;
		expect(upload.with?.path).toContain("binaries.json");
		expect(build.steps.indexOf(test)).toBeLessThan(build.steps.indexOf(upload));
		requiresSuccess(build);
		expect(release.jobs.standalone!.with?.build_ref).toBe(`\${{ needs.release-context.outputs.build_ref }}`);
	});

	it("executes every archive on its own libc, musl archives inside Alpine", () => {
		const build = standalone.jobs.build!;
		const glibc = step(build, "Test extracted application without JavaScript runtimes on PATH");
		const musl = step(build, "Test extracted application on Alpine without JavaScript runtimes");
		// A cross-compiled musl archive cannot run on the glibc runner that built it.
		expect(glibc.if).toBe(`\${{ !contains(matrix.platform, 'musl') }}`);
		expect(musl.if).toBe(`\${{ contains(matrix.platform, 'musl') }}`);
		expect(musl.run).toContain("docker run");
		expect(musl.run).toContain("alpine:");
		expect(musl.run).toContain("prime-agent --version");
		expect(musl.run).toContain("prime-agent --help");
		const upload = build.steps.find((entry) => entry.uses?.startsWith("actions/upload-artifact@"))!;
		expect(build.steps.indexOf(musl)).toBeLessThan(build.steps.indexOf(upload));
		// A container smoke test only proves execution when the runner matches the target architecture.
		for (const entry of build.strategy!.matrix.include) {
			if (!entry.platform.startsWith("linux-")) continue;
			expect(entry.runner.endsWith("-arm"), entry.platform).toBe(entry.platform.includes("arm64"));
		}
	});

	it("keeps one platform set across the installer, the release scripts, and the workflows", () => {
		expect([...NATIVE_PLATFORMS]).toEqual(releasePlatforms);
		const stage = step(release.jobs.build!, "Verify and stage standalone binaries");
		// A hardcoded list here silently drops newly published platforms from a release.
		expect(stage.run).toContain("node scripts/release-platforms.mjs");
		for (const platform of releasePlatforms) expect(stage.run).not.toContain(` ${platform} `);
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
				expect(release.jobs.publish!.if).toBe(`github.event_name != 'pull_request' && ${staleGate}`);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("wires the staleness check into the standalone, build, validation, and publish gates", () => {
		const context = release.jobs["release-context"]!;
		const staleness = step(context, "Skip superseded push builds");
		expect(staleness.id).toBe("staleness");
		expect(context.outputs?.stale).toBe(`\${{ steps.staleness.outputs.stale }}`);
		for (const name of ["standalone", "build", "validate-macos", "publish"]) {
			const job = release.jobs[name]!;
			expect([job.needs ?? []].flat()).toContain("release-context");
			expect(job.if).toContain(staleGate);
		}
	});

	// test-policy: allow conditional-or-disabled-test -- the step script is POSIX bash, matching the packer-paths guard
	it.skipIf(process.platform === "win32")(
		"marks only superseded beta pushes stale and fails open when the tip check breaks",
		() => {
			const staleness = step(release.jobs["release-context"]!, "Skip superseded push builds");
			for (const scenario of [
				{ event: "pull_request", refType: "branch", production: "false", gh: undefined, stale: "false" },
				{ event: "push", refType: "tag", production: "false", gh: undefined, stale: "false" },
				{ event: "push", refType: "branch", production: "true", gh: "tip", stale: "false" },
				{ event: "push", refType: "branch", production: "false", gh: "broken", stale: "false" },
				{ event: "push", refType: "branch", production: "false", gh: "tip", stale: "true" },
			]) {
				const directory = mkdtempSync(join(tmpdir(), "prime-release-staleness-"));
				try {
					if (scenario.gh) {
						const bin = join(directory, "bin");
						mkdirSync(bin);
						writeFileSync(
							join(bin, "gh"),
							scenario.gh === "tip" ? "#!/bin/sh\necho tip-sha\n" : "#!/bin/sh\nexit 1\n",
						);
						chmodSync(join(bin, "gh"), 0o755);
					}
					const output = join(directory, "output");
					const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", staleness.run!], {
						cwd: repository,
						env: {
							...process.env,
							...(scenario.gh ? { PATH: `${join(directory, "bin")}:${process.env.PATH}` } : {}),
							GITHUB_EVENT_NAME: scenario.event,
							GITHUB_REF_TYPE: scenario.refType,
							GITHUB_REF_NAME: "main",
							GITHUB_REPOSITORY: "PrimeIntellect-ai/prime-agent",
							GITHUB_SHA: "run-sha",
							GITHUB_OUTPUT: output,
							PUBLISH_PRODUCTION: scenario.production,
						},
						encoding: "utf8",
					});
					expect(result.status, result.stderr).toBe(0);
					expect(readFileSync(output, "utf8")).toBe(`stale=${scenario.stale}\n`);
				} finally {
					rmSync(directory, { recursive: true, force: true });
				}
			}
		},
	);
});

describe("release manifest schemas", () => {
	const manifestV1Platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
	const binaries = releasePlatforms.map((platform, index) => ({
		platform,
		file: `prime-agent-1.2.4-${platform}.tar.gz`,
		sha256: (index + 1).toString(16).padStart(64, "0"),
		executableSha256: (index + 11).toString(16).padStart(64, "0"),
	}));
	const tarballs = [
		["prime-agent-ai", "1"],
		["prime-agent-core", "2"],
		["prime-agent-tui", "3"],
		["prime-agent", "4"],
	].map(([name, hash]) => ({
		name,
		file: `${name}-1.2.4.tgz`,
		sha256: hash.repeat(64),
	}));

	it.each([
		["stable", "latest.json"],
		["beta", "beta.json"],
	] as const)("writes the %s channel with v1 and v2 binary schemas", (channel, manifestName) => {
		const directory = mkdtempSync(join(tmpdir(), "prime-release-manifest-"));
		try {
			const result = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`import { writeReleaseMetadata } from ${JSON.stringify(join(repository, "scripts/pack-prime-agent-release.mjs"))}; writeReleaseMetadata(${JSON.stringify(
						{
							artifactsDir: directory,
							channel,
							releaseVersion: "1.2.4",
							codingAgentTarball: "prime-agent-1.2.4.tgz",
							tarballs,
							binaries,
						},
					)});`,
				],
				{ encoding: "utf8" },
			);
			expect(result.status, result.stderr).toBe(0);

			const manifest = JSON.parse(readFileSync(join(directory, manifestName), "utf8"));
			expect(manifest.version).toBe("v1.2.4");
			expect(manifest.tarballs).toEqual(
				tarballs.map(({ name: packageName, file, sha256 }) => ({ package: packageName, file, sha256 })),
			);
			expect(manifest.binaries.map((entry: { platform: string }) => entry.platform)).toEqual(manifestV1Platforms);
			expect(manifest.binariesV2.map((entry: { platform: string }) => entry.platform)).toEqual(releasePlatforms);
			expect(manifest.binariesV2.map((entry: { platform: string }) => entry.platform)).toEqual(
				expect.arrayContaining([
					"linux-arm64-musl",
					"linux-x64-baseline",
					"linux-x64-musl",
					"linux-x64-musl-baseline",
				]),
			);
			expect(readFileSync(join(directory, channel), "utf8")).toBe("v1.2.4\n");

			const expectedChecksums = [...tarballs, ...binaries]
				.map((artifact) => `${artifact.sha256}  ${artifact.file}`)
				.join("\n");
			expect(readFileSync(join(directory, "SHA256SUMS"), "utf8")).toBe(`${expectedChecksums}\n`);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
