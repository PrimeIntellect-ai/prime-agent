import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { NATIVE_PLATFORMS } from "../src/utils/native-installation.js";

interface Step {
	name?: string;
	env?: Record<string, string>;
	run?: string;
	uses?: string;
	if?: string;
	"continue-on-error"?: boolean;
	with?: Record<string, string>;
}
interface Job {
	needs?: string | string[];
	env?: Record<string, string>;
	permissions?: Record<string, string>;
	environment?: { name?: string } | string;
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
// The same command the release workflow uses to enumerate publishable platforms.
const releasePlatforms = spawnSync(process.execPath, [join(repository, "scripts/release-platforms.mjs")], {
	encoding: "utf8",
})
	.stdout.trim()
	.split("\n");
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
		expect(validation.needs).toEqual(expect.arrayContaining(["context", "build"]));
		expect(validation["runs-on"]).toBe(`\${{ matrix.runner }}`);
		expect(validation.strategy?.matrix.include).toEqual([
			{ platform: "darwin-arm64", runner: "macos-15" },
			{ platform: "darwin-x64", runner: "macos-15-intel" },
		]);
		// Publication is a chain: everything the release publishes has to pass
		// through assemble (receipts) and github-release (recorded digests) first.
		const assemble = release.jobs.assemble!;
		expect(assemble.needs).toEqual(expect.arrayContaining(["build", "validate-macos"]));
		const githubRelease = release.jobs["github-release"]!;
		expect(githubRelease.needs).toEqual(expect.arrayContaining(["assemble", "sign"]));
		const publish = release.jobs["publish-r2"]!;
		expect(publish.needs).toEqual(expect.arrayContaining(["github-release"]));
		expect(publish.if).toContain("github.event_name != 'pull_request'");
		requiresSuccess(validation);
		requiresSuccess(assemble);
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
		const assemble = release.jobs.assemble!;
		const gate = step(assemble, "Match native validation to publication artifacts");
		expect(gate.if).toBeUndefined();
		expect(gate.run).toContain(
			"verify-macos-validation-receipts.mjs release-artifacts/production macos-validation production",
		);
		expect(gate.run).toContain("verify-macos-validation-receipts.mjs release-artifacts/beta macos-validation beta");
		// The receipt gate runs before anything leaves this job, and every job that
		// writes to R2, npm, the tap or a GitHub release runs after assemble.
		const publishers = [
			"publish-r2",
			"publish-beta-r2",
			"github-release",
			"github-release-beta",
			"finalize-release",
			"publish-npm",
			"tap-bump",
		];
		for (const entry of Object.values(release.jobs)) {
			const writes = (entry.steps ?? []).filter((candidate) =>
				/aws s3 cp|gh release (?:upload|create|edit)|gh api --method|npm publish|git (?:-C \S+ )?push/.test(
					candidate.run ?? "",
				),
			);
			if (writes.length === 0) continue;
			expect(publishers).toContain(Object.keys(release.jobs).find((name) => release.jobs[name] === entry));
		}
		for (const name of publishers) {
			const job = release.jobs[name]!;
			const needs = typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
			expect(needs.length).toBeGreaterThan(0);
		}
		const uploads = assemble.steps.filter((entry) => entry.uses?.startsWith("actions/upload-artifact@"));
		expect(uploads.length).toBeGreaterThan(0);
		for (const upload of uploads) expect(assemble.steps.indexOf(gate)).toBeLessThan(assemble.steps.indexOf(upload));
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
		// The artifact tests read the RELEASE archive, never the test-signer one.
		expect(test.run).toMatch(
			/PRIME_AGENT_TEST_ARCHIVE="\$RELEASE_ARCHIVE" \\\n\s*npx --ignore-scripts tsx [^\n]*test\/compiled-artifact\.test\.ts/,
		);
		const upload = build.steps.find((entry) => entry.uses?.startsWith("actions/upload-artifact@"))!;
		expect(upload.with?.path).toContain("binaries.json");
		expect(build.steps.indexOf(test)).toBeLessThan(build.steps.indexOf(upload));
		requiresSuccess(build);
		expect(release.jobs.standalone!.with?.build_ref).toBe(`\${{ needs.context.outputs.build_ref }}`);
	});

	it("signs a test-signer build in the standalone job for the end-to-end updater test and never uploads it", () => {
		const build = standalone.jobs.build!;
		// The OIDC token is the only credential, and the caller passes exactly that through.
		expect(build.permissions).toEqual({ contents: "read", "id-token": "write" });
		expect(release.jobs.standalone!.permissions).toEqual({ contents: "read", "id-token": "write" });
		expect(build.environment).toBeUndefined();
		expect(JSON.stringify(build)).not.toMatch(/secrets\.(?!GITHUB_TOKEN\b)/);
		expect(build.steps.some((entry) => entry.uses?.startsWith("sigstore/cosign-installer@"))).toBe(true);

		const names = build.steps.map((entry) => entry.name);
		const order = [
			"Assemble native archive",
			"Resolve the signer identity of this job",
			"Compile a test-signer binary for the updater test",
			"Sign the test archives with this job's identity",
			"Remove the build paths from the test machine",
			"Test extracted application without JavaScript runtimes on PATH",
		];
		expect(order.map((name) => names.indexOf(name))).toEqual(
			[...order].map((_, index, all) => names.indexOf(all[0]!) + index),
		);

		// The identity is resolved from a real certificate before anything is compiled against it,
		// and the caller path would mean this job can sign as the release: that fails hard.
		const resolve = step(build, "Resolve the signer identity of this job");
		expect(resolve.run).toContain("cosign sign-blob --yes --bundle");
		expect(resolve.run).toContain("workflow_path=.github/workflows/standalone-binaries.yml");
		expect(resolve.run).toContain("caller_path=.github/workflows/build-binaries.yml");
		expect(resolve.run).toMatch(
			/if verifies "https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\/\$\{caller_path\}@\$\{GITHUB_REF\}"; then\n\s*echo "::error::[^\n]*\n\s*exit 1/,
		);
		expect(resolve.run).toContain(`--arg refPattern "^\${escaped_ref}\\$"`);
		for (const field of [
			"repositoryUri",
			"workflowRepositoryUri",
			"workflowPath",
			"oidcIssuer",
			"runnerEnvironment",
			"refPattern",
		]) {
			expect(resolve.run).toContain(`${field}:`);
		}
		expect(resolve.run).toContain('> "$RUNNER_TEMP/test-release/signer.json"');

		// Exactly one step compiles with the override, into a sibling directory it deletes again.
		const compile = step(build, "Compile a test-signer binary for the updater test");
		expect(compile.run).toContain(
			'node packages/coding-agent/scripts/build-binary.mjs --platform "$TARGET_PLATFORM" --test-signer-json "$RUNNER_TEMP/test-release/signer.json"',
		);
		expect(compile.run).toContain(
			'node scripts/assemble-release-archives.mjs packages/coding-agent/binaries-test-signer "$RUNNER_TEMP/test-release/current" "$RELEASE_VERSION"',
		);
		expect(compile.run).toContain(
			'node scripts/assemble-release-archives.mjs packages/coding-agent/binaries-test-signer "$RUNNER_TEMP/test-release/next" 99.0.0',
		);
		expect(compile.run).toContain("rm -rf packages/coding-agent/binaries-test-signer");
		for (const workflow of [release, standalone]) {
			for (const [jobId, job] of Object.entries(workflow.jobs)) {
				for (const entry of job.steps ?? []) {
					if (entry === compile) continue;
					expect(JSON.stringify(entry), `${jobId}: ${entry.name}`).not.toContain("--test-signer-json");
					expect(JSON.stringify(entry), `${jobId}: ${entry.name}`).not.toContain(
						"__PRIME_AGENT_RELEASE_SIGNER_OVERRIDE__",
					);
				}
			}
		}

		// Both SHA256SUMS are signed and verified against the exact identity before the test runs.
		const sign = step(build, "Sign the test archives with this job's identity");
		expect(sign.run).toContain("for channel in current next; do");
		expect(sign.run).toContain('cosign sign-blob --yes --bundle "$sums.sigstore.json" "$sums"');
		expect(sign.run).toContain('--certificate-identity "$SIGNER_IDENTITY"');
		expect(sign.run).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
		for (const [name, value] of [
			[
				"PRIME_AGENT_TEST_ARCHIVE",
				"$RUNNER_TEMP/test-release/current/prime-agent-$RELEASE_VERSION-$TARGET_PLATFORM.tar.gz",
			],
			["PRIME_AGENT_TEST_SIGNATURE_BUNDLE", "$RUNNER_TEMP/test-release/current/SHA256SUMS.sigstore.json"],
			["PRIME_AGENT_TEST_NEXT_ARCHIVE", "$RUNNER_TEMP/test-release/next/prime-agent-99.0.0-$TARGET_PLATFORM.tar.gz"],
			["PRIME_AGENT_TEST_NEXT_SIGNATURE_BUNDLE", "$RUNNER_TEMP/test-release/next/SHA256SUMS.sigstore.json"],
		]) {
			expect(sign.run).toContain(`echo "${name}=${value}"`);
		}
		const test = step(build, "Test extracted application without JavaScript runtimes on PATH");
		expect(test.run).toContain("test/native-installer.test.ts");
		for (const name of [
			"PRIME_AGENT_TEST_ARCHIVE",
			"PRIME_AGENT_TEST_SIGNATURE_BUNDLE",
			"PRIME_AGENT_TEST_NEXT_ARCHIVE",
			"PRIME_AGENT_TEST_NEXT_SIGNATURE_BUNDLE",
		]) {
			expect(test.run).toContain(`test -f "$${name}"`);
		}

		// The uploaded artifact - what the release consumes - reads only the release directory.
		const upload = build.steps.find((entry) => entry.uses?.startsWith("actions/upload-artifact@"))!;
		const paths = upload.with!.path!.trim().split("\n");
		expect(paths).toEqual(
			["*.tar.gz", "SHA256SUMS", "binaries.json"].map((name) => `\${{ runner.temp }}/standalone/${name}`),
		);
		expect(upload.with!.path).not.toContain("test-release");
		expect(upload.with!.path).not.toContain("binaries-test-signer");
		expect(compile.run).not.toContain("$RUNNER_TEMP/standalone/");
		expect(compile.run).toContain('test "$(find "$RUNNER_TEMP/standalone" -type f | wc -l | tr -d \' \')" -eq 3');

		// validate-macos runs the production-pinned binary; nothing there can sign as the release,
		// so the signed updater test does not run there.
		const macos = step(release.jobs["validate-macos"]!, "Verify and exercise exact final Mac archives");
		const vitest = macos.run!.split("\n").filter((line) => line.includes("vitest/dist/cli.js"));
		expect(vitest).toHaveLength(1);
		expect(vitest[0]).toContain("test/compiled-artifact.test.ts");
		expect(vitest[0]).not.toContain("native-installer.test.ts");
	});

	it.skipIf(process.platform === "win32")(
		"the test-signer signing step verifies both bundles against the exact identity and exports the env contract",
		() => {
			const sign = step(standalone.jobs.build!, "Sign the test archives with this job's identity").run!;
			const directory = mkdtempSync(join(tmpdir(), "prime-standalone-sign-"));
			const shim = (accepted: string) => `
cosign() {
  case "$1" in
    sign-blob) printf '{"bundle":true}' > "$4" ;;
    verify-blob) [ "$7" = "${accepted}" ] ;;
    *) echo "unexpected cosign call: $*" >&2; return 99 ;;
  esac
}
`;
			const env = {
				RUNNER_TEMP: directory,
				GITHUB_ENV: join(directory, "env"),
				SIGNER_IDENTITY: "https://github.com/o/r/.github/workflows/standalone-binaries.yml@refs/pull/12/merge",
				RELEASE_VERSION: "1.2.3",
				TARGET_PLATFORM: "darwin-arm64",
			};
			const sha = (body: string) =>
				spawnSync("bash", ["-c", "printf '%s' \"$1\" | shasum -a 256 | cut -d' ' -f1", "_", body], {
					encoding: "utf8",
				}).stdout.trim();
			try {
				for (const [channel, file] of [
					["current", "prime-agent-1.2.3-darwin-arm64.tar.gz"],
					["next", "prime-agent-99.0.0-darwin-arm64.tar.gz"],
				]) {
					mkdirSync(join(directory, "test-release", channel!), { recursive: true });
					writeFileSync(join(directory, "test-release", channel!, file!), channel!);
					writeFileSync(join(directory, "test-release", channel!, "SHA256SUMS"), `${sha(channel!)}  ${file}\n`);
				}
				const ok = runStepScript(sign, shim(env.SIGNER_IDENTITY), env);
				expect(ok.status, ok.stderr).toBe(0);
				expect(readFileSync(join(directory, "env"), "utf8")).toBe(
					[
						`PRIME_AGENT_TEST_ARCHIVE=${directory}/test-release/current/prime-agent-1.2.3-darwin-arm64.tar.gz`,
						`PRIME_AGENT_TEST_SIGNATURE_BUNDLE=${directory}/test-release/current/SHA256SUMS.sigstore.json`,
						`PRIME_AGENT_TEST_NEXT_ARCHIVE=${directory}/test-release/next/prime-agent-99.0.0-darwin-arm64.tar.gz`,
						`PRIME_AGENT_TEST_NEXT_SIGNATURE_BUNDLE=${directory}/test-release/next/SHA256SUMS.sigstore.json`,
						"",
					].join("\n"),
				);
				for (const channel of ["current", "next"]) {
					expect(readFileSync(join(directory, "test-release", channel, "SHA256SUMS.sigstore.json"), "utf8")).toBe(
						'{"bundle":true}',
					);
				}
				rmSync(join(directory, "env"));
				// A certificate with any other identity, or a checksum that no longer matches, stops the job.
				const wrong = runStepScript(
					sign,
					shim("https://github.com/o/r/.github/workflows/build-binaries.yml@refs/pull/12/merge"),
					env,
				);
				expect(wrong.status).toBe(1);
				writeFileSync(join(directory, "test-release/next/prime-agent-99.0.0-darwin-arm64.tar.gz"), "tampered");
				const tampered = runStepScript(sign, shim(env.SIGNER_IDENTITY), env);
				expect(tampered.status).toBe(1);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	// test-policy: allow conditional-or-disabled-test -- git and tar fixtures only run on posix hosts
	it.skipIf(process.platform === "win32")(
		"the test-signer steps refuse a certificate naming the caller workflow",
		() => {
			const resolve = step(standalone.jobs.build!, "Resolve the signer identity of this job").run!;
			const directory = mkdtempSync(join(tmpdir(), "prime-standalone-signer-"));
			const shim = (identity: string) => `
cosign() {
  case "$1" in
    sign-blob) printf '{}' > "$4" ;;
    verify-blob) [ "$7" = "${identity}" ] ;;
    *) echo "unexpected cosign call: $*" >&2; return 99 ;;
  esac
}
`;
			const env = {
				RUNNER_TEMP: directory,
				GITHUB_REPOSITORY: "o/r",
				GITHUB_REF: "refs/pull/12/merge",
				GITHUB_SHA: "abc",
				GITHUB_RUN_ID: "1",
				GITHUB_RUN_ATTEMPT: "1",
				GITHUB_ENV: join(directory, "env"),
			};
			try {
				const called = runStepScript(
					resolve,
					shim("https://github.com/o/r/.github/workflows/standalone-binaries.yml@refs/pull/12/merge"),
					env,
				);
				expect(called.status, called.stderr).toBe(0);
				expect(JSON.parse(readFileSync(join(directory, "test-release/signer.json"), "utf8"))).toEqual({
					repositoryUri: "https://github.com/o/r",
					workflowRepositoryUri: "https://github.com/o/r",
					workflowPath: ".github/workflows/standalone-binaries.yml",
					oidcIssuer: "https://token.actions.githubusercontent.com",
					runnerEnvironment: "github-hosted",
					refPattern: "^refs/pull/12/merge$",
				});
				expect(/^refs\/pull\/12\/merge$/.test("refs/pull/12/merge")).toBe(true);
				expect(/^refs\/pull\/12\/merge$/.test("refs/pull/120/merge")).toBe(false);
				expect(readFileSync(join(directory, "env"), "utf8")).toContain(
					"SIGNER_IDENTITY=https://github.com/o/r/.github/workflows/standalone-binaries.yml@refs/pull/12/merge\n",
				);
				rmSync(join(directory, "env"));

				const caller = runStepScript(
					resolve,
					shim("https://github.com/o/r/.github/workflows/build-binaries.yml@refs/pull/12/merge"),
					env,
				);
				expect(caller.status).toBe(1);
				expect(caller.stderr).toContain("could sign as the production release identity");

				const other = runStepScript(
					resolve,
					shim("https://github.com/o/r/.github/workflows/standalone-binaries.yml@refs/heads/other"),
					env,
				);
				expect(other.status).toBe(1);
				expect(other.stderr).toContain("names neither");
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

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

	// test-policy: allow conditional-or-disabled-test -- git and tar fixtures only run on posix hosts
	it.skipIf(process.platform === "win32")(
		"selects both real packer paths for PR validation without allowing publication",
		() => {
			expect(release.on).toHaveProperty("pull_request");
			const directory = mkdtempSync(join(tmpdir(), "prime-release-context-"));
			try {
				const output = join(directory, "output");
				const context = step(release.jobs.context!, "Resolve release context");
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
				expect(release.jobs["publish-r2"]!.if).toContain("github.event_name != 'pull_request'");
				expect(release.jobs["publish-r2"]!.environment).toEqual({
					name: `\${{ needs.context.outputs.publish_environment }}`,
				});
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});

function runStepScript(script: string, shims: string, env: Record<string, string>): SpawnSyncReturns<string> {
	return spawnSync("bash", ["-e", "-o", "pipefail", "-c", `${shims}\n${script}`], {
		cwd: env.GITHUB_WORKSPACE ?? mkdtempSync(join(tmpdir(), "prime-release-step-")),
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
}

const BUILD_REF = "1111111111111111111111111111111111111111";
const OTHER_REF = "2222222222222222222222222222222222222222";
const TAG_OBJECT = "3333333333333333333333333333333333333333";

/** A `gh` shim whose `api repos/<r>/git/ref/tags/<tag>` answers with the given fixture. */
function ghTagShim(
	ref: { object: { type: string; sha: string }; ref?: string } | "404" | "500",
	peeled = OTHER_REF,
): string {
	const body = ref === "404" || ref === "500" ? "" : JSON.stringify({ ref: ref.ref ?? "refs/tags/v1.2.3", ...ref });
	return `
gh() {
  case "$*" in
    "api repos/o/r/git/ref/tags/v1.2.3")
      ${ref === "404" ? 'echo "gh: Not Found (HTTP 404)" >&2; return 1' : ""}
      ${ref === "500" ? 'echo "gh: Internal Server Error (HTTP 500)" >&2; return 1' : ""}
      printf '%s' '${body}' ;;
    "api repos/o/r/git/tags/${TAG_OBJECT} --jq .object.sha")
      echo "${peeled}" ;;
    *) echo "unexpected gh call: $*" >&2; return 99 ;;
  esac
}
`;
}

describe("release ordering: nothing is public before verification", () => {
	const githubRelease = release.jobs["github-release"]!;
	const publish = release.jobs["publish-r2"]!;
	const verify = release.jobs.verify!;
	const finalize = release.jobs["finalize-release"]!;

	it("chains github-release -> publish-r2 -> verify -> finalize-release -> publish-npm / tap-bump", () => {
		expect(publish.needs).toContain("github-release");
		expect(verify.needs).toContain("publish-r2");
		expect(verify.needs).not.toContain("finalize-release");
		expect(finalize.needs).toContain("verify");
		expect(release.jobs["pack-npm"]!.needs).toContain("verify");
		expect(release.jobs["publish-npm"]!.needs).toEqual(expect.arrayContaining(["pack-npm", "finalize-release"]));
		expect(release.jobs["tap-bump"]!.needs).toContain("finalize-release");
		for (const job of [githubRelease, publish, verify, finalize]) requiresSuccess(job);
	});

	it("signs the beta SHA256SUMS and publishes the bundle next to it, verified against the pinned identity (round 5, finding 4)", () => {
		const sign = release.jobs.sign!;
		// sign runs for the beta as well as production; it holds only id-token/attestations, no secret.
		expect(sign.if).toContain("needs.context.outputs.publish_beta == 'true'");
		expect(sign.if).toContain("needs.context.outputs.publish_production == 'true'");
		expect(sign.environment).toBeUndefined();
		expect(sign.permissions).toEqual({ attestations: "write", contents: "read", "id-token": "write" });
		expect(JSON.stringify(sign)).not.toMatch(/secrets\./);
		const betaDownload = sign.steps.find(
			(entry) => entry.uses?.startsWith("actions/download-artifact@") && entry.with?.name === "release-final-beta",
		)!;
		expect(betaDownload.with).toEqual({ name: "release-final-beta", path: "beta-artifacts" });
		expect(betaDownload.if).toBe("env.PUBLISH_BETA == 'true'");
		const betaSign = step(sign, "Sign the beta SHA256SUMS with a keyless cosign signature");
		expect(betaSign.if).toBe("env.PUBLISH_BETA == 'true'");
		expect(betaSign.run).toContain("(cd beta-artifacts && sha256sum --check SHA256SUMS)");
		expect(betaSign.run).toMatch(
			/cosign sign-blob --yes \\\n\s*--bundle beta-signatures\/SHA256SUMS\.sigstore\.json \\\n\s*beta-artifacts\/SHA256SUMS/,
		);
		// The same identity as the production signature: this workflow file at the ref that ran.
		expect(betaSign.run).toContain(
			`--certificate-identity "https://github.com/\${GITHUB_REPOSITORY}/.github/workflows/build-binaries.yml@\${GITHUB_REF}"`,
		);
		expect(step(sign, "Attest beta build provenance").if).toBe("env.PUBLISH_BETA == 'true'");
		const betaUpload = step(sign, "Upload beta signatures");
		expect(betaUpload.if).toBe("env.PUBLISH_BETA == 'true'");
		expect(betaUpload.with).toEqual({
			name: "release-beta-signatures",
			path: "beta-signatures/SHA256SUMS.sigstore.json",
			"if-no-files-found": "error",
		});
		// Production steps are gated on production so a beta-only run does not fail on missing artifacts.
		for (const name of [
			"Sign SHA256SUMS with a keyless cosign signature",
			"Generate an SBOM per archive",
			"Attest build provenance",
			"Upload signatures",
		]) {
			expect(step(sign, name).if, name).toBe("env.PUBLISH_PRODUCTION == 'true'");
		}

		const beta = release.jobs["publish-beta-r2"]!;
		expect(beta.needs).toEqual(expect.arrayContaining(["assemble", "sign"]));
		expect(beta.steps.some((entry) => entry.uses?.startsWith("actions/checkout@"))).toBe(false);
		const bundleDownload = step(beta, "Download beta signatures");
		expect(bundleDownload.with).toEqual({ name: "release-beta-signatures", path: "artifacts" });
		expect(step(beta, "Download assembled beta artifacts").with?.path).toBe("artifacts");
		expect(step(beta, "Refuse anything that is not a beta artifact").run).toContain(
			"test -s artifacts/SHA256SUMS.sigstore.json",
		);
		const verify = step(beta, "Verify the beta signature bundle against the pinned release identity");
		expect(verify.env).toBeUndefined(); // no credential in the env of the verifying step
		expect(verify.run).toContain("--bundle artifacts/SHA256SUMS.sigstore.json");
		expect(verify.run).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
		expect(verify.run).toContain(
			`--certificate-identity "https://github.com/\${GITHUB_REPOSITORY}/.github/workflows/build-binaries.yml@refs/heads/\${DEFAULT_BRANCH}"`,
		);
		expect(verify.run).toMatch(/\n\s*artifacts\/SHA256SUMS\s*$/);
		expect(beta.env?.DEFAULT_BRANCH).toBe(`\${{ github.event.repository.default_branch }}`);
		const names = beta.steps.map((entry) => entry.name);
		expect(names.indexOf(verify.name!)).toBeLessThan(names.indexOf("Upload immutable beta objects"));
		// The upload loop publishes everything in artifacts/ except the two pointers: the bundle rides along.
		const upload = step(beta, "Upload immutable beta objects");
		expect(upload.run).toContain("for file in artifacts/*; do");
		expect(upload.run).toContain("beta|beta.json) continue ;;");
		expect(upload.run).not.toMatch(/sigstore/);
	});

	it("publish-r2 writes only the immutable prefix and never a channel pointer", () => {
		const names = publish.steps.map((entry) => entry.name);
		expect(names).not.toContain("Advance the production channel pointers");
		const upload = step(publish, "Upload immutable release objects");
		expect(upload.run).toContain(`prefix="releases/v\${PRODUCTION_VERSION}"`);
		expect(upload.run).toContain("stable|latest.json) continue ;;");
		for (const entry of publish.steps) {
			expect(entry.run ?? "").not.toMatch(
				/s3:\/\/\$\{R2_BUCKET\}\/(?:stable|latest\.json|install\.sh|install-beta\.sh)\b/,
			);
			expect(entry.run ?? "").not.toContain("publish_pointer");
		}
	});

	it("verify reads the immutable prefix from the public URL with the cosign identity pinned, before finalize", () => {
		expect(verify.environment).toBeUndefined();
		expect(verify.steps.some((entry) => entry.uses?.startsWith("actions/checkout@"))).toBe(false);
		expect(verify.steps.some((entry) => entry.uses?.startsWith("actions/download-artifact@"))).toBe(false);
		const download = step(verify, "Download the immutable release objects from the public URL");
		expect(download.run).toContain(`base="\${R2_PUBLIC_BASE_URL%/}/releases/v\${PRODUCTION_VERSION}"`);
		expect(download.run).toContain("--proto '=https'");
		const cosign = step(verify, "Verify the cosign signature over SHA256SUMS");
		expect(cosign.run).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
		expect(cosign.run).toContain(
			`--certificate-identity "https://github.com/\${GITHUB_REPOSITORY}/.github/workflows/build-binaries.yml@refs/heads/\${DEFAULT_BRANCH}"`,
		);
		const digests = step(verify, "Verify the digests and run the published binary");
		expect(digests.run).toContain("sha256sum --check expected.sums");
		expect(digests.run).toContain("extracted/prime-agent --version");
	});

	it("finalize-release undrafts, proves the tag, and advances the pointers last with step-scoped credentials", () => {
		expect(finalize.environment).toEqual(publish.environment);
		expect(finalize.steps.some((entry) => entry.uses?.startsWith("actions/checkout@"))).toBe(false);
		const names = finalize.steps.map((entry) => entry.name);
		const order = [
			"Verify every artifact against the digest GitHub recorded",
			"Refuse an existing tag at another commit and re-check the draft",
			"Publish the release and prove the tag points at BUILD_REF",
			"Advance the production channel pointers",
		];
		expect(order.map((name) => names.indexOf(name))).toEqual(
			[...order.keys()].map((index) => names.length - order.length + index),
		);
		const pointers = step(finalize, "Advance the production channel pointers");
		expect(finalize.steps.indexOf(pointers)).toBe(finalize.steps.length - 1);
		expect(Object.keys(pointers.env ?? {})).toEqual(
			expect.arrayContaining(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT_URL"]),
		);
		for (const [name, value] of Object.entries(finalize.env ?? {})) {
			if (name === "GH_TOKEN") continue;
			expect(String(value)).not.toContain("secrets.");
		}
		for (const entry of finalize.steps) {
			if (entry === pointers) continue;
			expect(Object.values(entry.env ?? {}).join(" ")).not.toContain("secrets.");
		}
		for (const pointer of ["latest.json", "stable", "install.sh", "install-beta.sh"]) {
			// Spelled out in full: the release checker allows exactly these destinations, here only.
			expect(pointers.run).toContain(`aws s3 cp artifacts/${pointer} "s3://\${R2_BUCKET}/${pointer}"`);
			expect(pointers.run).toContain(`verify_pointer artifacts/${pointer} ${pointer}`);
		}
		expect(pointers.run).not.toMatch(/aws s3 cp "?\$file"? "s3:\/\/\$\{R2_BUCKET\}\/\$\{key\}"/);
		const publishStep = step(finalize, "Publish the release and prove the tag points at BUILD_REF");
		expect(publishStep.run).toContain('gh release edit "$TAG" --draft=false --latest');
		expect(publishStep.run).toContain('if [ "$tagged" != "$BUILD_REF" ]; then');
		const recheck = step(finalize, "Refuse an existing tag at another commit and re-check the draft");
		expect(recheck.run).toContain("cmp -s /tmp/current-assets.json /tmp/recorded-assets.json");
		// A re-run after publish must finish the pointer move; every tampered state is
		// still refused by the tag pre-check and the asset comparison.
		expect(recheck.run).toContain('if [ "$(jq -r .isDraft /tmp/release.json)" != true ]; then');
		expect(recheck.run).toContain("finishing the channel pointers");
		// The rollback guard: a stale re-run of an older version must refuse.
		expect(recheck.run).toContain("| jq -sr --arg current");
		// `gh --jq` prints raw strings, so the stream must be tojson'd before jq slurps it.
		expect(recheck.run).toContain("| tojson");
		expect(recheck.run).toContain("refusing to move the channel");
		expect(recheck.run).toContain('test "$(jq -r .targetCommitish /tmp/release.json)" = "$BUILD_REF"');
	});

	it("github-release drafts without a tag and refuses an existing tag at another commit", () => {
		const names = githubRelease.steps.map((entry) => entry.name);
		expect(names.indexOf("Refuse an existing tag at another commit")).toBeLessThan(
			names.indexOf("Create or refresh the draft release"),
		);
		const create = step(githubRelease, "Create or refresh the draft release");
		expect(create.run).toContain("--draft");
		expect(create.run).not.toContain("--draft=false");
		expect(create.run).not.toMatch(/git\/refs/); // the draft never creates a ref
		expect(create.run).toContain('test "$(jq -r .isDraft /tmp/release.json)" = true');
	});

	it("github-release leaves an already published release untouched so a re-run can finish", () => {
		const create = step(githubRelease, "Create or refresh the draft release").run!;
		const shim = `
gh() {
  case "$*" in
    "release view v1.2.3 --json isDraft --jq .isDraft") printf 'false\\n' ;;
    "release download v1.2.3 --dir artifacts --clobber") : ;;
    *) echo "unexpected gh call: $*" >&2; return 99 ;;
  esac
}
`;
		const result = runStepScript(create, shim, { PRODUCTION_VERSION: "1.2.3" });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("already published");
		// The published assets become the authoritative bytes: no re-signing, so the
		// non-byte-stable sigstore bundle and SBOMs stay consistent with R2.
		expect(result.stdout).toContain("reusing its assets");
		expect(create).toContain('gh release download "$TAG" --dir artifacts --clobber');
	});

	// test-policy: allow conditional-or-disabled-test -- git and tar fixtures only run on posix hosts
	describe.skipIf(process.platform === "win32")("the tag pre-check (bash, fake gh)", () => {
		const precheck = step(githubRelease, "Refuse an existing tag at another commit").run!;
		const env = { GITHUB_REPOSITORY: "o/r", PRODUCTION_VERSION: "1.2.3", BUILD_REF };

		it.each([
			["no tag yet", ghTagShim("404"), 0],
			["a lightweight tag at BUILD_REF", ghTagShim({ object: { type: "commit", sha: BUILD_REF } }), 0],
			[
				"an annotated tag peeling to BUILD_REF",
				ghTagShim({ object: { type: "tag", sha: TAG_OBJECT } }, BUILD_REF),
				0,
			],
			["a lightweight tag at another commit", ghTagShim({ object: { type: "commit", sha: OTHER_REF } }), 1],
			[
				"an annotated tag peeling to another commit",
				ghTagShim({ object: { type: "tag", sha: TAG_OBJECT } }, OTHER_REF),
				1,
			],
			["an API failure that is not 404", ghTagShim("500"), 1],
			[
				"a ref answer for a different tag name",
				ghTagShim({ ref: "refs/tags/v1.2.30", object: { type: "commit", sha: BUILD_REF } }),
				1,
			],
		])("%s", (_label, shim, status) => {
			const result = runStepScript(precheck, shim, env);
			expect(result.status, result.stderr + result.stdout).toBe(status);
			if (status === 1 && _label.includes("another commit")) expect(result.stderr).toContain("refusing to publish");
		});

		it("refuses a BUILD_REF that is not a full commit SHA", () => {
			const result = runStepScript(precheck, ghTagShim("404"), { ...env, BUILD_REF: "main" });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("not a full commit SHA");
		});

		it("finalize-release re-checks the recorded assets and lets a published re-run finish", () => {
			const recheck = step(finalize, "Refuse an existing tag at another commit and re-check the draft").run!;
			const recorded = [
				{ name: "SHA256SUMS", size: 1, digest: "sha256:aa" },
				{ name: "install.sh", size: 2, digest: "sha256:bb" },
			];
			const shims = (options: {
				isDraft?: boolean;
				target?: string;
				assets?: { name: string; digest: string }[];
				tag?: string;
				published?: string[];
			}) => `
gh() {
  case "$*" in
    "api repos/o/r/git/ref/tags/v1.2.3")
      ${options.tag ? `printf '%s' '${JSON.stringify({ ref: "refs/tags/v1.2.3", object: { type: "commit", sha: options.tag } })}'` : 'echo "gh: Not Found (HTTP 404)" >&2; return 1'} ;;
    *"select(.draft == false)"*)
      ${options.published === undefined ? `printf '%s\\n' '"1.2.3"'` : options.published.length === 0 ? ":" : `printf '%s\\n' ${options.published.map((version) => `'"${version}"'`).join(" ")}`} ;;
    "release view v1.2.3 --json isDraft,targetCommitish")
      printf '%s' '${JSON.stringify({ isDraft: options.isDraft ?? true, targetCommitish: options.target ?? BUILD_REF })}' ;;
    "api repos/o/r/releases --paginate --jq .[] | select(.tag_name == \\"v1.2.3\\") | .id") echo 42 ;;
    "api repos/o/r/releases/42/assets --paginate --jq [.[] | {name: .name, digest: .digest}] | sort_by(.name)")
      printf '%s' '${JSON.stringify(options.assets ?? recorded)}' | jq 'map({name, digest}) | sort_by(.name)' ;;
    *) echo "unexpected gh call: $*" >&2; return 99 ;;
  esac
}
mkdir -p manifest
printf '%s' '${JSON.stringify(recorded)}' > manifest/github-assets.json
`;
			const good = runStepScript(recheck, shims({}), env);
			expect(good.status, good.stderr).toBe(0);
			expect(good.stdout).toContain("2 assets unchanged");
			expect(runStepScript(recheck, shims({ tag: BUILD_REF }), env).status).toBe(0);
			expect(runStepScript(recheck, shims({ tag: OTHER_REF }), env).status).toBe(1);
			expect(runStepScript(recheck, shims({ target: OTHER_REF }), env).status).toBe(1);
			// A re-run after this job's own publish finds the release published: it must
			// let the re-run finish the channel pointers (the tag pre-check and the asset
			// comparison above still refuse every tampered state).
			const rerun = runStepScript(recheck, shims({ isDraft: false }), env);
			expect(rerun.status, rerun.stderr).toBe(0);
			expect(rerun.stdout).toContain("finishing the channel pointers");
			const rerunTagged = runStepScript(recheck, shims({ isDraft: false, tag: BUILD_REF }), env);
			expect(rerunTagged.status, rerunTagged.stderr).toBe(0);
			// The previous version being live is the normal release case, and an empty
			// published set is a first release: both must proceed.
			const normalTrain = runStepScript(recheck, shims({ published: ["1.2.2"] }), env);
			expect(normalTrain.status, normalTrain.stderr).toBe(0);
			const firstRelease = runStepScript(recheck, shims({ published: [] }), env);
			expect(firstRelease.status, firstRelease.stderr).toBe(0);
			// A stale re-run must never roll the channel back to an older version.
			const rollback = runStepScript(recheck, shims({ published: ["1.2.2", "1.2.4"] }), env);
			expect(rollback.status, rollback.stderr).toBe(1);
			expect(rollback.stderr).toContain("Newer release v1.2.4");
			const rollbackPublished = runStepScript(recheck, shims({ published: ["1.2.4"], isDraft: false }), env);
			expect(rollbackPublished.status, rollbackPublished.stderr).toBe(1);
			const swapped = runStepScript(
				recheck,
				shims({ assets: [recorded[0]!, { name: "install.sh", digest: "sha256:ee" }] }),
				env,
			);
			expect(swapped.status).toBe(1);
			expect(swapped.stderr).toContain("no longer match");
			const extra = runStepScript(
				recheck,
				shims({ assets: [...recorded, { name: "evil.sh", digest: "sha256:ff" }] }),
				env,
			);
			expect(extra.status).toBe(1);
			expect(runStepScript(recheck, shims({ assets: [recorded[0]!] }), env).status).toBe(1);
		});

		it("finalize-release proves the tag points at BUILD_REF after publishing", () => {
			const publishStep = step(finalize, "Publish the release and prove the tag points at BUILD_REF").run!;
			const shims = (tagSha: string) => `
gh() {
  case "$*" in
    "release edit v1.2.3 --draft=false --latest") echo "published" ;;
    "api repos/o/r/git/ref/tags/v1.2.3") printf '%s' '${JSON.stringify({ ref: "refs/tags/v1.2.3", object: { type: "commit", sha: tagSha } })}' ;;
    "release view v1.2.3 --json isDraft --jq .isDraft") echo false ;;
    *) echo "unexpected gh call: $*" >&2; return 99 ;;
  esac
}
`;
			expect(runStepScript(publishStep, shims(BUILD_REF), env).status).toBe(0);
			const wrong = runStepScript(publishStep, shims(OTHER_REF), env);
			expect(wrong.status).toBe(1);
			expect(wrong.stderr).toContain(`points at ${OTHER_REF}, not ${BUILD_REF}`);
		});
	});
});

describe("npm publication is split into an unprivileged pack job and a code-free publish job", () => {
	const pack = release.jobs["pack-npm"]!;
	const publishNpm = release.jobs["publish-npm"]!;

	it("pack-npm builds from BUILD_REF without any credential", () => {
		expect(pack.environment).toBeUndefined();
		expect(pack.needs).toContain("verify");
		const checkout = pack.steps.find((entry) => entry.uses?.startsWith("actions/checkout@"))!;
		expect(checkout.with?.ref).toBe(`\${{ env.BUILD_REF }}`);
		expect(checkout.with?.["persist-credentials"]).toBe(false);
		expect(step(pack, "Install dependencies").run).toContain("npm ci --ignore-scripts\nnpm rebuild esbuild");
		expect(step(pack, "Build").run).toBe("npm run build");
		const packStep = step(pack, "Build the npm package set");
		expect(packStep.run).toContain("node scripts/pack-npm-packages.mjs");
		expect(packStep.run).toContain('--version "$PRODUCTION_VERSION"');
		expect(packStep.run).toContain("--archives release-artifacts/production");
		expect(packStep.run).toContain("--receipts release-artifacts/production/latest.json");
		expect(packStep.run).toContain("--out-dir npm-packages");
		expect(pack.steps.indexOf(step(pack, "Build"))).toBeLessThan(pack.steps.indexOf(packStep));
		const upload = step(pack, "Upload the npm package set");
		expect(upload.with?.name).toBe("npm-packages");
		expect(upload.with?.path).toContain("npm-packages/artifacts/*.tgz");
		expect(upload.with?.path).toContain("npm-packages/manifest.json");
		for (const env of [pack.env ?? {}, ...pack.steps.map((entry) => entry.env ?? {})]) {
			expect(Object.values(env).join(" ")).not.toContain("secrets.");
		}
		expect(pack.if).toContain("vars.NPM_PUBLISH_ENABLED == 'true'");
	});

	it("publish-npm holds only the OIDC token and touches no repository code", () => {
		expect(publishNpm.environment).toEqual({ name: "release-npm" });
		expect(publishNpm.if).toContain("vars.NPM_PUBLISH_ENABLED == 'true'");
		expect(release.jobs["publish-npm"]).toMatchObject({ permissions: { "id-token": "write" } });
		expect(Object.keys((publishNpm as unknown as { permissions: Record<string, string> }).permissions)).toEqual([
			"id-token",
		]);
		for (const entry of publishNpm.steps) {
			expect(entry.uses ?? "").not.toMatch(/actions\/checkout/);
			expect(entry.run ?? "").not.toMatch(/npm (?:ci|install|rebuild|run)\b|npx|node scripts\//);
		}
		const download = publishNpm.steps.find((entry) => entry.uses?.startsWith("actions/download-artifact@"))!;
		expect(download.with).toEqual({ name: "npm-packages", path: "npm-packages" });
		const node = publishNpm.steps.find((entry) => entry.uses?.startsWith("actions/setup-node@"))!;
		expect(node.with).toEqual({ "node-version": "24", "registry-url": "https://registry.npmjs.org" });
		const publishStep = step(publishNpm, "Publish every package with provenance");
		expect(publishStep.run).toContain('npm publish "$path" --provenance --access public --ignore-scripts');
		expect(publishStep.run).toContain("'.publishOrder[]'");
	});

	// test-policy: allow conditional-or-disabled-test -- git and tar fixtures only run on posix hosts
	it.skipIf(process.platform === "win32")(
		"publishes in manifest order and refuses a tarball whose digest changed",
		() => {
			const publishStep = step(publishNpm, "Publish every package with provenance").run!;
			const directory = mkdtempSync(join(tmpdir(), "prime-npm-publish-"));
			try {
				mkdirSync(join(directory, "npm-packages/artifacts"), { recursive: true });
				const packages = [
					{ name: "@prime-intellect/agent-linux-x64", tarball: "linux.tgz", body: "linux" },
					{ name: "@prime-intellect/ai", tarball: "ai.tgz", body: "ai" },
					{ name: "prime-agent", tarball: "front.tgz", body: "front" },
				];
				for (const entry of packages)
					writeFileSync(join(directory, "npm-packages/artifacts", entry.tarball), entry.body);
				const sha = (body: string) =>
					spawnSync("bash", ["-c", "printf '%s' \"$1\" | sha256sum | cut -d' ' -f1", "_", body], {
						encoding: "utf8",
					}).stdout.trim();
				const manifest = {
					publishOrder: ["prime-agent", "@prime-intellect/agent-linux-x64", "@prime-intellect/ai"],
					packages: packages.map((entry) => ({
						name: entry.name,
						tarball: entry.tarball,
						sha256: sha(entry.body),
					})),
				};
				writeFileSync(join(directory, "npm-packages/manifest.json"), JSON.stringify(manifest));
				const shim = 'npm() { echo "npm $*"; }';
				const run = () =>
					spawnSync("bash", ["-e", "-o", "pipefail", "-c", `${shim}\n${publishStep}`], {
						cwd: directory,
						encoding: "utf8",
					});
				const ok = run();
				expect(ok.status, ok.stderr).toBe(0);
				expect(ok.stdout.trim().split("\n")).toEqual(
					["front.tgz", "linux.tgz", "ai.tgz"].map(
						(tarball) =>
							`npm publish npm-packages/artifacts/${tarball} --provenance --access public --ignore-scripts`,
					),
				);
				writeFileSync(join(directory, "npm-packages/artifacts/linux.tgz"), "tampered");
				const tampered = run();
				expect(tampered.status).toBe(1);
				expect(tampered.stderr).toContain("Digest mismatch for linux.tgz");
				expect(tampered.stdout).toContain("front.tgz"); // the first publish happened, the tampered one did not
				expect(tampered.stdout).not.toContain("linux.tgz --provenance");
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});

// test-policy: allow conditional-or-disabled-test -- git and tar fixtures only run on posix hosts
describe.skipIf(process.platform === "win32")(
	"immutable uploads treat only an explicit 404 from head-object as absent (fake aws)",
	() => {
		const DIGEST_FILE = "prime-agent-1.2.3-linux-x64.tar.gz";
		/**
		 * A fake `aws` whose `s3api head-object` answers as configured. Uploads are recorded in
		 * calls.log and stashed so the read-back download returns the same bytes.
		 */
		const shim = (head: { exit: number; stderr: string } | "exists") => `
aws() {
  echo "aws $*" >> "$LOG"
  case "$1 $2" in
    "s3api head-object")
      ${head === "exists" ? 'echo "{}"; return 0' : `echo '${head.stderr}' >&2; return ${head.exit}`} ;;
    "s3 cp")
      if [ "\${4#s3://}" != "$4" ]; then cp "$3" "$STASH/$(basename "$3")"; else cp "$STASH/$(basename "$3")" "$4"; fi ;;
    *) echo "unexpected aws call: $*" >&2; return 99 ;;
  esac
}
`;
		const run = (
			jobId: string,
			stepName: string,
			head: Parameters<typeof shim>[0],
			existing?: string,
			extraFiles: Record<string, string> = {},
		) => {
			const workspace = mkdtempSync(join(tmpdir(), "prime-head-object-"));
			mkdirSync(join(workspace, "artifacts"));
			mkdirSync(join(workspace, "stash"));
			writeFileSync(join(workspace, "artifacts", DIGEST_FILE), "release bytes");
			for (const [name, body] of Object.entries(extraFiles)) writeFileSync(join(workspace, "artifacts", name), body);
			if (existing !== undefined) writeFileSync(join(workspace, "stash", DIGEST_FILE), existing);
			const result = spawnSync(
				"bash",
				["-c", `${shim(head)}\ncd "$WORKSPACE"\n${step(release.jobs[jobId]!, stepName).run}`],
				{
					cwd: workspace,
					env: {
						...process.env,
						WORKSPACE: workspace,
						LOG: join(workspace, "calls.log"),
						STASH: join(workspace, "stash"),
						R2_BUCKET: "bucket",
						R2_ENDPOINT_URL: "https://r2.invalid",
						PRODUCTION_VERSION: "1.2.3",
						BETA_VERSION: "1.2.3",
					},
					encoding: "utf8",
				},
			);
			let calls: string[] = [];
			try {
				calls = readFileSync(join(workspace, "calls.log"), "utf8").trim().split("\n");
			} catch {
				calls = [];
			}
			rmSync(workspace, { recursive: true, force: true });
			return { result, calls, uploads: calls.filter((call) => /^aws s3 cp .* s3:\/\//.test(call)) };
		};
		const NOT_FOUND = "An error occurred (404) when calling the HeadObject operation: Not Found";
		const FORBIDDEN = "An error occurred (403) when calling the HeadObject operation: Forbidden";

		for (const [jobId, stepName] of [
			["publish-r2", "Upload immutable release objects"],
			["publish-beta-r2", "Upload immutable beta objects"],
		] as const) {
			describe(jobId, () => {
				it("uploads when head-object reports an explicit 404", () => {
					const { result, uploads } = run(jobId, stepName, { exit: 254, stderr: NOT_FOUND });
					expect(result.status, result.stderr).toBe(0);
					expect(uploads).toEqual([
						expect.stringContaining(
							`aws s3 cp artifacts/${DIGEST_FILE} s3://bucket/releases/v1.2.3/${DIGEST_FILE}`,
						),
					]);
					expect(result.stdout).toContain(`published releases/v1.2.3/${DIGEST_FILE}`);
				});

				it("refuses to upload when head-object fails with 403", () => {
					const { result, uploads } = run(jobId, stepName, { exit: 254, stderr: FORBIDDEN });
					expect(result.status).toBe(1);
					expect(uploads).toEqual([]);
					expect(result.stderr).toContain("refusing to guess whether it exists");
					expect(result.stderr).toContain(FORBIDDEN);
				});

				it("refuses to upload when head-object fails for any other reason", () => {
					for (const head of [
						{ exit: 255, stderr: NOT_FOUND }, // a 404 message from an unexpected exit code
						{ exit: 254, stderr: "" }, // no diagnostic at all
						{ exit: 254, stderr: "Could not connect to the endpoint URL: https://r2.invalid" },
						{ exit: 1, stderr: "aws: command not found" },
						{ exit: 254, stderr: "An error occurred (404) when calling the GetObject operation: Not Found" },
					]) {
						const { result, uploads } = run(jobId, stepName, head);
						expect(result.status, JSON.stringify(head)).toBe(1);
						expect(uploads, JSON.stringify(head)).toEqual([]);
					}
				});

				it("uploads SHA256SUMS.sigstore.json next to SHA256SUMS and never a pointer (round 5, finding 4)", () => {
					const { result, uploads } = run(jobId, stepName, { exit: 254, stderr: NOT_FOUND }, undefined, {
						SHA256SUMS: "sums",
						"SHA256SUMS.sigstore.json": '{"bundle":true}',
						...(jobId === "publish-r2"
							? { stable: "1.2.3", "latest.json": "{}" }
							: { beta: "1.2.3", "beta.json": "{}" }),
					});
					expect(result.status, result.stderr).toBe(0);
					const version = "1.2.3";
					const names = uploads.map((call) => call.match(/ s3:\/\/bucket\/(\S+)/)![1]);
					expect(names.sort()).toEqual(
						[
							`releases/v${version}/${DIGEST_FILE}`,
							`releases/v${version}/SHA256SUMS`,
							`releases/v${version}/SHA256SUMS.sigstore.json`,
						].sort(),
					);
					const bundle = uploads.find((call) => call.includes("SHA256SUMS.sigstore.json"))!;
					expect(bundle).toContain("--content-type application/json");
					expect(bundle).toContain("--endpoint-url https://r2.invalid");
				});

				it("never uploads over an object with different bytes, but a same-bytes rerun finishes", () => {
					// Both channels use the same immutability contract (round 10: a re-run of the same
					// version must be able to finish what it already published).
					const { result, uploads } = run(jobId, stepName, "exists", "different bytes");
					expect(uploads).toEqual([]);
					expect(result.status).toBe(1);
					expect(result.stderr).toContain("Refusing to overwrite");
					// The same bytes already stored is a no-op rerun, not an error.
					const rerun = run(jobId, stepName, "exists", "release bytes");
					expect(rerun.result.status, rerun.result.stderr).toBe(0);
					expect(rerun.uploads).toEqual([]);
					expect(rerun.result.stdout).toContain("unchanged");
				});
			});
		}
	},
);

describe("tap-bump reruns safely and never touches the tap's default branch", () => {
	const tap = release.jobs["tap-bump"]!;
	const bump = step(tap, "Open or refresh the formula bump pull request");

	it("leases the push on the branch it fetched and edits an existing pull request", () => {
		expect(bump.run).toContain(
			`lease=$(git -C "$workdir" ls-remote --heads origin "refs/heads/\${branch}" | cut -f1)`,
		);
		expect(bump.run).toContain(`git -C "$workdir" push origin "refs/heads/\${branch}:refs/heads/\${branch}"`);
		expect(bump.run).toContain(`--force-with-lease="refs/heads/\${branch}:\${lease}"`);
		expect(bump.run).not.toMatch(/git push origin "\$branch"/);
		expect(bump.run).not.toMatch(/push[^\n]*--force(?!-with-lease)/);
		expect(bump.run).toContain('test "$default_branch" != "$branch"');
		// The pull request is edited by its head branch, a value the checker can prove is not an option.
		expect(bump.run).toContain('gh pr edit "$branch" --repo "$TAP_REPO"');
		expect(bump.run).not.toContain('gh pr edit "$existing"');
		expect(bump.run).toContain('gh pr create --repo "$TAP_REPO" --head "$branch" --base "$default_branch"');
		// The job never changes directory: the checker only allows `cd` into downloaded artifacts.
		expect(bump.run).not.toMatch(/(^|[;&|(]\s*|\n\s*)(cd|pushd|popd)\b/);
		// The formula is rewritten with bash parameter expansion alone: no sed (whose e/w/r commands run
		// programs and write files), no awk, no interpreter, no heredoc, in a job that holds the tap token.
		expect(bump.run).not.toMatch(/<<|\bsed\b|\bawk\b|\bpython3?\b|\bnode\b|\bperl\b|\bruby\b/);
		// The step never spells its token, and the clone target lives under the runner's temp directory.
		expect(bump.run).not.toContain("GH_TOKEN");
		expect(bump.run).toContain('workdir="$RUNNER_TEMP/tap"');
		expect(bump.run).toContain('gh repo clone "https://github.com/$' + '{TAP_REPO}" "$workdir" -- --depth 1');
		expect(bump.run).toContain('[[ "$PRODUCTION_VERSION" =~ $version_pattern ]]');
		expect(bump.run).toContain('[[ "$digest" =~ ^[0-9a-f]{64}$ ]]');
	});

	// test-policy: allow conditional-or-disabled-test -- git and tar fixtures only run on posix hosts
	describe.skipIf(process.platform === "win32")("the step script (bash, fake gh/git)", () => {
		const BRANCH = "prime-agent-1.2.3";
		const digests = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].map(
			(platform, index) => [platform, String(index + 4).repeat(64)] as const,
		);
		const formula = [
			"class PrimeAgent < Formula",
			'  version "1.2.2"',
			'  url "https://example.invalid/releases/v1.2.2/prime-agent-1.2.2-darwin-arm64.tar.gz"',
			...digests.flatMap(([platform]) => [`  # ${platform}`, `  sha256 "${"0".repeat(64)}"`]),
			"end",
			"",
		].join("\n");
		const shims = (options: {
			remoteSha?: string;
			existingPr?: string;
			merged?: boolean;
			defaultBranch?: string;
			version?: string;
		}) => `
log="$GITHUB_WORKSPACE/calls.log"
gh() {
  echo "gh $*" >> "$log"
  case "$1 $2" in
    "repo clone") mkdir -p "$4/Formula"; cp "$GITHUB_WORKSPACE/formula.rb" "$4/Formula/prime-agent.rb" ;;
    "pr list") printf '%s' '${options.existingPr ?? ""}' ;;
    "pr edit"|"pr create") ;;
    *) echo "unexpected gh call: $*" >&2; return 99 ;;
  esac
}
git() {
  echo "git $*" >> "$log"
  if [ "$1" = -C ]; then shift 2; fi
  while [ "$1" = -c ]; do shift 2; done
  case "$1" in
    symbolic-ref) echo '${options.defaultBranch ?? "main"}' ;;
    ls-remote) ${options.remoteSha ? `printf '%s\\trefs/heads/%s\\n' '${options.remoteSha}' '${BRANCH}'` : "true"} ;;
    diff) return ${options.merged ? 0 : 1} ;;
    switch|commit|push) ;;
    *) echo "unexpected git call: $*" >&2; return 99 ;;
  esac
}
`;
		const run = (options: Parameters<typeof shims>[0]) => {
			const workspace = mkdtempSync(join(tmpdir(), "prime-tap-bump-"));
			mkdirSync(join(workspace, "artifacts"));
			writeFileSync(
				join(workspace, "artifacts/SHA256SUMS"),
				`${digests.map(([platform, digest]) => `${digest}  prime-agent-${options.version ?? "1.2.3"}-${platform}.tar.gz`).join("\n")}\n`,
			);
			writeFileSync(join(workspace, "formula.rb"), formula);
			const result = runStepScript(bump.run!, shims(options), {
				GITHUB_WORKSPACE: workspace,
				RUNNER_TEMP: workspace,
				GH_TOKEN: "token",
				PRODUCTION_VERSION: options.version ?? "1.2.3",
				TAP_REPO: "o/tap",
			});
			const calls = readFileSync(join(workspace, "calls.log"), "utf8").trim().split("\n");
			const edited = (() => {
				try {
					return readFileSync(join(workspace, "tap/Formula/prime-agent.rb"), "utf8");
				} catch {
					return "";
				}
			})();
			rmSync(workspace, { recursive: true, force: true });
			return { result, calls, edited };
		};
		const pushes = (calls: string[]) => calls.filter((call) => / push /.test(call));

		it("pushes with an empty lease and opens the pull request on the first run", () => {
			const { result, calls, edited } = run({});
			expect(result.status, result.stderr).toBe(0);
			expect(pushes(calls)).toEqual([
				`git -C ${calls.find((call) => call.startsWith("gh repo clone"))!.split(" ")[4]} push origin refs/heads/${BRANCH}:refs/heads/${BRANCH} --force-with-lease=refs/heads/${BRANCH}:`,
			]);
			expect(
				calls.some((call) =>
					call.startsWith(`gh pr create --repo o/tap --head ${BRANCH} --base main --title prime-agent 1.2.3`),
				),
			).toBe(true);
			expect(calls.some((call) => call.startsWith("gh pr edit"))).toBe(false);
			expect(edited).toContain('version "1.2.3"');
			expect(edited).toContain("/releases/v1.2.3/");
			for (const [platform, digest] of digests) expect(edited).toContain(`# ${platform}\n  sha256 "${digest}"`);
		});

		it("on a rerun leases the push on the fetched branch head and edits the existing pull request", () => {
			const { result, calls } = run({ remoteSha: OTHER_REF, existingPr: "7" });
			expect(result.status, result.stderr).toBe(0);
			const [push, ...rest] = pushes(calls);
			expect(rest).toEqual([]);
			expect(push).toContain(
				`push origin refs/heads/${BRANCH}:refs/heads/${BRANCH} --force-with-lease=refs/heads/${BRANCH}:${OTHER_REF}`,
			);
			expect(
				calls.some((call) => call.startsWith(`gh pr edit ${BRANCH} --repo o/tap --title prime-agent 1.2.3`)),
			).toBe(true);
			expect(result.stdout).toContain("Refreshed pull request #7");
			expect(calls.some((call) => call.startsWith("gh pr create"))).toBe(false);
		});

		it("refuses a version that is not a version before anything reaches the formula", () => {
			for (const version of ["1.2.3;rm -rf /", "1.2.3/e whoami", "1.2.3&", "v1.2.3", "", "1.2.3 4"]) {
				const { result, calls, edited } = run({ version });
				expect(result.status, version).toBe(1);
				expect(result.stderr, version).toContain("PRODUCTION_VERSION is not a version");
				expect(edited, version).toBe(formula);
				expect(pushes(calls), version).toEqual([]);
			}
			// A prerelease is a version.
			const { result, edited } = run({ version: "1.2.3-beta.1" });
			expect(result.status, result.stderr).toBe(0);
			expect(edited).toContain('version "1.2.3-beta.1"');
			expect(edited).toContain("/releases/v1.2.3-beta.1/");
		});

		it("does nothing once the formula already describes the version", () => {
			const { result, calls } = run({ merged: true, remoteSha: OTHER_REF });
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("nothing to push");
			expect(pushes(calls)).toEqual([]);
			expect(calls.some((call) => call.startsWith("gh pr"))).toBe(false);
		});

		it("never pushes to the default branch, even when the clone's HEAD is the bump branch", () => {
			for (const options of [{}, { remoteSha: OTHER_REF, existingPr: "7" }]) {
				const { calls } = run(options);
				for (const push of pushes(calls)) {
					expect(push).not.toMatch(/\bmain\b/);
					expect(push).toMatch(
						new RegExp(
							` origin refs/heads/${BRANCH}:refs/heads/${BRANCH} --force-with-lease=refs/heads/${BRANCH}:`,
						),
					);
				}
			}
			const { result, calls } = run({ defaultBranch: BRANCH });
			expect(result.status).toBe(1);
			expect(pushes(calls)).toEqual([]);
		});
	});
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
