import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	env?: Record<string, string>;
	with?: Record<string, string>;
}
interface Matrix {
	include: { channel?: string; platform: string; runner: string }[];
}
interface TestMatrix {
	include: {
		name: string;
		package: string;
		command: string;
		install_node: boolean;
		build: boolean;
		install_uv: boolean;
	}[];
}
interface Job {
	needs?: string | string[];
	if?: string;
	"continue-on-error"?: boolean;
	"runs-on"?: string;
	strategy?: { "fail-fast"?: boolean; matrix: Matrix | TestMatrix | string };
	outputs?: Record<string, string>;
	steps: Step[];
	uses?: string;
	with?: Record<string, string>;
}
interface Workflow {
	concurrency?: { "cancel-in-progress"?: boolean | string; group?: string; queue?: string };
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
const ci: Workflow = parse(readFileSync(join(repository, ".github/workflows/ci.yml"), "utf8"));
const matrixResolver = join(repository, "scripts/release-macos-validation-matrix.mjs");

function step(job: Job, name: string): Step {
	const found = job.steps.find((entry) => entry.name === name);
	expect(found, `Missing workflow step: ${name}`).toBeDefined();
	return found!;
}

function matrix(job: Job): Matrix {
	const value = job.strategy?.matrix;
	expect(value).toBeTypeOf("object");
	return value as Matrix;
}

function resolveValidationMatrix(publishProduction: boolean, publishBeta: boolean) {
	return spawnSync(process.execPath, [matrixResolver, String(publishProduction), String(publishBeta)], {
		encoding: "utf8",
	});
}

function exercisePackStep(
	publishProduction: boolean,
	publishBeta: boolean,
	failChannel = "",
): {
	status: number | null;
	stderr: string;
	args: Record<string, string | undefined>;
	started: string[];
	finished: string[];
} {
	const directory = mkdtempSync(join(tmpdir(), "prime-release-pack-"));
	try {
		const pack = step(release.jobs.build!, "Pack enabled release channels");
		const harness = `npm() {
  arguments="$*"
  channel=
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --channel ]; then
      channel="$2"
      break
    fi
    shift
  done
  [ "$channel" = stable ] || [ "$channel" = beta ] || return 96
  printf '%s\n' "$arguments" > "$MOCK_PACK_DIR/call-$channel"
  touch "$MOCK_PACK_DIR/started-$channel"
  if [ "$MOCK_EXPECT_BOTH" = true ]; then
    peer=stable
    [ "$channel" = stable ] && peer=beta
    attempts=0
    until [ -f "$MOCK_PACK_DIR/started-$peer" ]; do
      attempts=$((attempts + 1))
      [ "$attempts" -lt 200 ] || return 97
      sleep 0.01
    done
  fi
  [ "$MOCK_SLOW_CHANNEL" != "$channel" ] || sleep 0.1
  touch "$MOCK_PACK_DIR/finished-$channel"
  [ "$MOCK_FAIL_CHANNEL" != "$channel" ] || return 42
}
${pack.run}`;
		const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", harness], {
			cwd: repository,
			env: {
				...process.env,
				PUBLISH_PRODUCTION: String(publishProduction),
				PUBLISH_BETA: String(publishBeta),
				PRODUCTION_VERSION: "1.2.3",
				BETA_VERSION: "1.2.3-beta.4",
				PRIME_AGENT_DOWNLOAD_BASE_URL: "https://downloads.example.test/prime-agent",
				MOCK_PACK_DIR: directory,
				MOCK_EXPECT_BOTH: String(publishProduction && publishBeta),
				MOCK_FAIL_CHANNEL: failChannel,
				MOCK_SLOW_CHANNEL: failChannel === "stable" ? "beta" : failChannel === "beta" ? "stable" : "",
			},
			encoding: "utf8",
			timeout: 5_000,
		});
		const channels = ["stable", "beta"];
		return {
			status: result.status,
			stderr: result.stderr,
			args: Object.fromEntries(
				channels.map((channel) => [
					channel,
					existsSync(join(directory, `call-${channel}`))
						? readFileSync(join(directory, `call-${channel}`), "utf8").trim()
						: undefined,
				]),
			),
			started: channels.filter((channel) => existsSync(join(directory, `started-${channel}`))),
			finished: channels.filter((channel) => existsSync(join(directory, `finished-${channel}`))),
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
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

describe("CI test matrix setup pruning", () => {
	it("declares the exact setup requirements and keeps every test command unchanged", () => {
		const testMatrix = ci.jobs.test!.strategy!.matrix as TestMatrix;
		expect(testMatrix.include).toEqual([
			{
				name: "agent-core",
				package: "packages/agent",
				command: "npm test",
				install_node: true,
				build: false,
				install_uv: false,
			},
			{
				name: "ai",
				package: "packages/ai",
				command: "npm test",
				install_node: true,
				build: false,
				install_uv: false,
			},
			{
				name: "tui",
				package: "packages/tui",
				command: "npm test",
				install_node: true,
				build: false,
				install_uv: false,
			},
			{
				name: "coding-agent 1/3",
				package: "packages/coding-agent",
				command: "npm run test:ci -- --shard=1/3",
				install_node: true,
				build: true,
				install_uv: true,
			},
			{
				name: "coding-agent 2/3",
				package: "packages/coding-agent",
				command: "npm run test:ci -- --shard=2/3",
				install_node: true,
				build: true,
				install_uv: true,
			},
			{
				name: "coding-agent 3/3",
				package: "packages/coding-agent",
				command: "npm run test:ci -- --shard=3/3",
				install_node: true,
				build: true,
				install_uv: true,
			},
			{
				name: "coding-agent process smoke",
				package: "packages/coding-agent",
				command: "npm run test:process",
				install_node: true,
				build: false,
				install_uv: false,
			},
			{
				name: "coding-agent kernel",
				package: "packages/coding-agent",
				command: "npm run test:kernel",
				install_node: true,
				build: false,
				install_uv: true,
			},
			{
				name: "runtime python",
				package: "prime-agent-runtime",
				command: "uv run python -m unittest discover -s test",
				install_node: false,
				build: false,
				install_uv: true,
			},
		]);
	});

	it("guards only the test fanout setup and build steps with their matrix flags", () => {
		const testJob = ci.jobs.test!;
		for (const name of ["Setup Node.js", "Install system dependencies", "Install dependencies"]) {
			expect(step(testJob, name).if).toBe("matrix.install_node");
		}
		expect(step(testJob, "Build").if).toBe("matrix.build");
		expect(step(testJob, "Install uv").if).toBe("matrix.install_uv");

		const buildCheck = ci.jobs["build-check"]!;
		for (const name of ["Setup Node.js", "Install system dependencies", "Install dependencies", "Build", "Check"]) {
			expect(step(buildCheck, name).if).toBeUndefined();
		}
	});
});

describe("release workflow signature gates", () => {
	it("keeps queued release runs non-cancelling for FIFO safety", () => {
		expect(release.concurrency?.group).toBe(
			`\${{ github.event_name == 'pull_request' && format('release-validation-pr-{0}', github.event.pull_request.number) || 'release-prime-agent' }}`,
		);
		expect(release.concurrency?.["cancel-in-progress"]).toBe(false);
		expect(release.concurrency?.queue).toBe("max");
	});

	it("joins exact stable and beta pack commands before smoke tests and uploads", () => {
		const build = release.jobs.build!;
		const pack = step(build, "Pack enabled release channels");
		expect(build.steps.some((entry) => entry.name === "Pack production release")).toBe(false);
		expect(build.steps.some((entry) => entry.name === "Pack beta release")).toBe(false);
		expect(pack.if).toBeUndefined();
		expect(pack.run).toContain(String.raw`--channel stable \
    --version "$PRODUCTION_VERSION" \
    --base-url "$PRIME_AGENT_DOWNLOAD_BASE_URL" \
    --binary-dir packages/coding-agent/binaries \
    --out-dir packages/coding-agent/release/production &`);
		expect(pack.run).toContain(String.raw`--channel beta \
    --version "$BETA_VERSION" \
    --base-url "$PRIME_AGENT_DOWNLOAD_BASE_URL" \
    --binary-dir packages/coding-agent/binaries \
    --out-dir packages/coding-agent/release/beta &`);
		expect(pack.run).toContain('pack_pids+=("$!")');
		expect(pack.run).toContain(`for index in "\${!pack_pids[@]}"`);
		expect(pack.run).toContain(`wait "\${pack_pids[$index]}"`);

		const smoke = step(build, "Smoke test installer with npm 12");
		expect(smoke.run).toContain('test "$("$NPM_CONFIG_PREFIX/bin/prime-agent" --version)" = "$SMOKE_VERSION"');
		for (const prerequisite of ["Install dependencies", "Build", "Check"]) {
			expect(build.steps.indexOf(step(build, prerequisite))).toBeLessThan(build.steps.indexOf(pack));
		}
		expect(build.steps.indexOf(pack)).toBeLessThan(build.steps.indexOf(smoke));
		for (const upload of ["Upload production artifacts", "Upload beta artifacts"]) {
			expect(build.steps.indexOf(pack)).toBeLessThan(build.steps.indexOf(step(build, upload)));
		}
	});

	it("starts both enabled pack commands concurrently and waits for both", () => {
		const result = exercisePackStep(true, true);
		expect(result.status, result.stderr).toBe(0);
		expect(result.started).toEqual(["stable", "beta"]);
		expect(result.finished).toEqual(["stable", "beta"]);
		expect(result.args).toEqual({
			stable:
				"run release:pack -- --channel stable --version 1.2.3 --base-url https://downloads.example.test/prime-agent --binary-dir packages/coding-agent/binaries --out-dir packages/coding-agent/release/production",
			beta: "run release:pack -- --channel beta --version 1.2.3-beta.4 --base-url https://downloads.example.test/prime-agent --binary-dir packages/coding-agent/binaries --out-dir packages/coding-agent/release/beta",
		});
	});

	it.each(["stable", "beta"])("waits for both packers and fails when %s fails", (failChannel) => {
		const result = exercisePackStep(true, true, failChannel);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(`Failed to pack ${failChannel === "stable" ? "production" : "beta"} release.`);
		expect(result.started).toEqual(["stable", "beta"]);
		expect(result.finished).toEqual(["stable", "beta"]);
	});

	it.each([
		[true, false, "stable"],
		[false, true, "beta"],
	] as const)("packs one enabled channel (%s, %s)", (publishProduction, publishBeta, channel) => {
		const result = exercisePackStep(publishProduction, publishBeta);
		expect(result.status, result.stderr).toBe(0);
		expect(result.started).toEqual([channel]);
		expect(result.finished).toEqual([channel]);
		expect(result.args[channel]).toBeDefined();
	});

	it("fails pack setup when no channel is enabled", () => {
		const result = exercisePackStep(false, false);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("At least one release channel must be enabled.");
		expect(result.started).toEqual([]);
		expect(result.finished).toEqual([]);
	});

	it("keeps every external release action pinned to a full commit", () => {
		for (const workflow of [release, standalone]) {
			for (const job of Object.values(workflow.jobs)) {
				for (const action of job.steps ?? []) {
					if (action.uses && !action.uses.startsWith("./")) expect(action.uses).toMatch(/@[0-9a-f]{40}$/);
				}
			}
		}
	});

	it("makes Release Prime Agent the only CI owner of standalone validation", () => {
		expect(release.on).toHaveProperty("pull_request");
		expect(release.on).toHaveProperty("push");
		expect(ci.jobs.standalone).toBeUndefined();
		for (const job of Object.values(ci.jobs)) {
			expect(job.uses ?? "").not.toContain("standalone-binaries.yml");
		}
		expect(release.jobs.standalone?.uses).toBe("./.github/workflows/standalone-binaries.yml");
		expect(release.jobs.build?.needs).toEqual(expect.arrayContaining(["release-context", "standalone"]));

		const aggregate = ci.jobs["build-check-test"]!;
		expect(aggregate.needs).toEqual(["trust", "build-check", "test"]);
		const verify = step(aggregate, "Verify CI results");
		expect(verify.run).not.toContain("STANDALONE");
		expect(verify.env).not.toHaveProperty("STANDALONE_RESULT");
	});
	it("requires successful build and dynamic native final validation before publication", () => {
		const context = release.jobs["release-context"]!;
		expect(context.outputs?.macos_validation_matrix).toBe(`\${{ steps.context.outputs.macos_validation_matrix }}`);
		const validation = release.jobs["validate-macos"]!;
		expect(validation.needs).toEqual(expect.arrayContaining(["release-context", "build"]));
		expect(validation["runs-on"]).toBe(`\${{ matrix.runner }}`);
		expect(validation.strategy?.["fail-fast"]).toBe(false);
		expect(validation.strategy?.matrix).toBe(
			`\${{ fromJSON(needs.release-context.outputs.macos_validation_matrix) }}`,
		);
		expect(validation.if).toBeUndefined();
		expect(validation.steps.some((entry) => entry.id === "gate")).toBe(false);
		for (const entry of validation.steps) expect(entry.if ?? "").not.toContain("steps.gate");

		const publish = release.jobs.publish!;
		expect(publish.needs).toEqual(expect.arrayContaining(["build", "validate-macos"]));
		expect(publish.if).toBe("github.event_name != 'pull_request'");
		requiresSuccess(validation);
		requiresSuccess(publish);
	});

	it.each([
		{
			name: "pull request dual channel",
			publishProduction: true,
			publishBeta: true,
			include: [
				{ channel: "production", platform: "darwin-arm64", runner: "macos-15" },
				{ channel: "production", platform: "darwin-x64", runner: "macos-15-intel" },
				{ channel: "beta", platform: "darwin-arm64", runner: "macos-15" },
				{ channel: "beta", platform: "darwin-x64", runner: "macos-15-intel" },
			],
		},
		{
			name: "ordinary beta-only release",
			publishProduction: false,
			publishBeta: true,
			include: [
				{ channel: "beta", platform: "darwin-arm64", runner: "macos-15" },
				{ channel: "beta", platform: "darwin-x64", runner: "macos-15-intel" },
			],
		},
		{
			name: "production-only release",
			publishProduction: true,
			publishBeta: false,
			include: [
				{ channel: "production", platform: "darwin-arm64", runner: "macos-15" },
				{ channel: "production", platform: "darwin-x64", runner: "macos-15-intel" },
			],
		},
	])("resolves exactly the enabled macOS entries for $name", ({ publishProduction, publishBeta, include }) => {
		const result = resolveValidationMatrix(publishProduction, publishBeta);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ include });
	});

	it("fails closed when no release channel is enabled", () => {
		const result = resolveValidationMatrix(false, false);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("At least one release channel must be enabled");
	});

	it("tests final channel archives before uploading receipts, then checks receipts before external writes", () => {
		const validation = release.jobs["validate-macos"]!;
		const verify = step(validation, "Verify and exercise exact final Mac archive");
		expect(verify.run).not.toContain("for channel in production beta");
		expect(verify.run).toContain("validate-macos-release.mjs");
		expect(verify.run).toContain("standalone-reference/binaries.json");
		expect(verify.run).toContain("test/compiled-artifact.test.ts");
		expect(verify.run).not.toMatch(/\|\|\s*(?:true|:)|continue-on-error/);
		expect(validation.steps.indexOf(verify)).toBeLessThan(
			validation.steps.indexOf(step(validation, "Upload native validation receipt")),
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

	it("keeps exact channel artifact and unique receipt paths through publisher validation", () => {
		const validation = release.jobs["validate-macos"]!;
		const channelDownload = step(validation, "Download exact final channel artifacts");
		expect(channelDownload.with).toMatchObject({
			name: `prime-agent-\${{ matrix.channel }}`,
			path: `\${{ runner.temp }}/final-artifacts/prime-agent-\${{ matrix.channel }}`,
		});
		const identityDownload = step(validation, "Download tested executable identity");
		expect(identityDownload.with).toMatchObject({
			name: `standalone-\${{ matrix.platform }}`,
			path: `\${{ runner.temp }}/standalone-reference`,
		});
		const upload = step(validation, "Upload native validation receipt");
		expect(upload.with).toMatchObject({
			name: `macos-validation-\${{ matrix.channel }}-\${{ matrix.platform }}`,
			path: `\${{ runner.temp }}/macos-validation/\${{ matrix.channel }}-\${{ matrix.platform }}.json`,
			"if-no-files-found": "error",
		});

		const publisherDownload = step(release.jobs.publish!, "Download native validation receipts");
		expect(publisherDownload.with).toMatchObject({
			pattern: "macos-validation-*",
			path: "macos-validation",
			"merge-multiple": true,
		});
	});

	it.each([{ channel: "production" }, { channel: "beta" }])(
		"finds the downloaded manifest when validating $channel",
		({ channel }) => {
			const validation = release.jobs["validate-macos"]!;
			const directory = mkdtempSync(join(tmpdir(), "prime-release-downloads-"));
			try {
				mkdirSync(join(directory, "packages/coding-agent"), { recursive: true });
				const download = validation.steps.find(
					(entry) =>
						entry.uses?.startsWith("actions/download-artifact@") &&
						entry.name === "Download exact final channel artifacts",
				);
				expect(download, `Missing download step`).toBeDefined();
				const destination = download!
					.with!.path!.replace(`\${{ runner.temp }}`, directory)
					.replace(`\${{ matrix.channel }}`, channel);
				mkdirSync(destination, { recursive: true });
				writeFileSync(join(destination, channel === "production" ? "latest.json" : "beta.json"), "{}");
				writeFileSync(join(destination, "prime-agent-1.2.3-darwin-arm64.tar.gz"), "");
				const result = spawnSync(
					"bash",
					[
						"-e",
						"-o",
						"pipefail",
						"-c",
						`node() { test -f "$2/latest.json" || test -f "$2/beta.json"; }
npx() { test -f "$PRIME_AGENT_TEST_ARCHIVE"; printf '%s\\n' "$PRIME_AGENT_TEST_ARCHIVE"; }
${step(validation, "Verify and exercise exact final Mac archive").run}`,
					],
					{
						cwd: directory,
						env: {
							...process.env,
							RUNNER_TEMP: directory,
							TARGET_PLATFORM: "darwin-arm64",
							CHANNEL: channel,
						},
						encoding: "utf8",
					},
				);
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout.trim()).toBe(
					join(directory, `final-artifacts/prime-agent-${channel}/prime-agent-1.2.3-darwin-arm64.tar.gz`),
				);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("retains every standalone target and only uploads tested executable identities", () => {
		const build = standalone.jobs.build!;
		expect(matrix(build).include.map((entry) => entry.platform)).toEqual(releasePlatforms);
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
		for (const entry of matrix(build).include) {
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
				expect(JSON.parse(values.macos_validation_matrix)).toEqual({
					include: [
						{ channel: "production", platform: "darwin-arm64", runner: "macos-15" },
						{ channel: "production", platform: "darwin-x64", runner: "macos-15-intel" },
						{ channel: "beta", platform: "darwin-arm64", runner: "macos-15" },
						{ channel: "beta", platform: "darwin-x64", runner: "macos-15-intel" },
					],
				});
				const pack = step(release.jobs.build!, "Pack enabled release channels");
				expect(pack.run?.match(/npm run release:pack/g)).toHaveLength(2);
				expect(pack.run).toContain("--channel stable");
				expect(pack.run).toContain("--channel beta");
				expect(pack.run?.match(/--binary-dir packages\/coding-agent\/binaries/g)).toHaveLength(2);
				expect(release.jobs.publish!.if).toBe("github.event_name != 'pull_request'");
			} finally {
				rmSync(directory, { recursive: true, force: true });
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
