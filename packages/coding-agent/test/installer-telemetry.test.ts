import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeTelemetryProperties } from "../src/core/telemetry-schema.js";

const installerSource = readFileSync(resolve("../../install.sh"), "utf8");
const mainCallIndex = installerSource.lastIndexOf('\nmain "$@"');
const installationId = "fbb3d0de-4322-4e3c-84c2-14d37c9dc9c9";
const tempDirs: string[] = [];

interface InstallerEvent {
	id: string;
	name: string;
	timestamp: string;
	properties: Record<string, string | number | boolean | null>;
}
interface InstallerBatch {
	schema_version: number;
	installation_id: string;
	events: InstallerEvent[];
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "installer-telemetry-test-")));
	tempDirs.push(dir);
	const bin = join(dir, "bin");
	const agentDir = join(dir, "agent");
	const projectDir = join(dir, "project");
	const tempDir = join(dir, "tmp");
	for (const path of [bin, agentDir, projectDir, tempDir]) mkdirSync(path);
	const requestsPath = join(dir, "requests.jsonl");
	const batchesPath = join(dir, "batches.jsonl");
	const helper = join(dir, "fake-fetch.cjs");
	writeFileSync(
		helper,
		`const fs = require("node:fs");
const path = require("node:path");
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  if (parsed.host !== "telemetry.invalid") throw new Error("Unexpected network request");
  fs.appendFileSync(process.env.TEST_REQUESTS, JSON.stringify({method:options.method || "GET",url:String(url),headers:options.headers}) + "\\n");
  if (process.env.TEST_HANG === "1") return new Promise(() => {});
  if (parsed.pathname.endsWith("/capabilities")) {
    if (process.env.TEST_DISABLE_ON_DISCOVERY === "1") fs.writeFileSync(path.join(process.env.PRIME_AGENT_CODING_AGENT_DIR, "settings.json"), '{"telemetry":false}');
    return new Response(process.env.TEST_CAPABILITIES || '{"schema_versions":[1,2],"schema_revision":3}');
  }
  fs.appendFileSync(process.env.TEST_BATCHES, options.body + "\\n");
  return new Response('{"accepted":20}');
};`,
	);
	writeFileSync(
		join(bin, "node"),
		`#!/bin/sh\nexec ${shellQuote(process.execPath)} --require ${shellQuote(helper)} "$@"\n`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(bin, "npm"),
		`#!/bin/sh
if [ "$1" = --version ]; then printf '11.12.1\\n'; exit 0; fi
[ "$1" = install ] || exit 91
if [ "\${TEST_DISABLE_DURING_INSTALL:-}" = 1 ]; then printf '{"telemetry":false}' >"$PRIME_AGENT_CODING_AGENT_DIR/settings.json"; fi
exit "\${TEST_INSTALL_STATUS:-0}"
`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(bin, "curl"),
		`#!/bin/sh
url=
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; output="$1" ;;
    https://downloads.invalid/*) url="$1" ;;
  esac
  shift
done
case "$url" in
  */stable) [ "\${TEST_RELEASE_STATUS:-0}" = 0 ] || exit "$TEST_RELEASE_STATUS"; printf '%s' "\${TEST_TARGET_VERSION:-1.2.3}" >"$output" ;;
  */SHA256SUMS) printf 'abc  prime-agent-1.2.3.tgz\\n' >"$output" ;;
  *.tgz) [ "\${TEST_DOWNLOAD_STATUS:-0}" = 0 ] || exit "$TEST_DOWNLOAD_STATUS"; printf 'fake tarball with secret prompt' >"$output" ;;
  *) exit 92 ;;
esac
`,
		{ mode: 0o755 },
	);
	writeFileSync(join(bin, "sha256sum"), `#!/bin/sh\nexit "\${TEST_VERIFY_STATUS:-0}"\n`, { mode: 0o755 });
	const script = join(dir, "installer.sh");
	const env: NodeJS.ProcessEnv = {
		PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
		HOME: join(dir, "home"),
		TMPDIR: tempDir,
		PRIME_AGENT_CODING_AGENT_DIR: agentDir,
		PRIME_AGENT_DOWNLOAD_BASE_URL: "https://downloads.invalid",
		PRIME_AGENT_INSTALLER_PLAIN: "1",
		PRIME_AGENT_TELEMETRY_ENDPOINT: "https://telemetry.invalid/api/v1/agent-analytics/events",
		TEST_BATCHES: batchesPath,
		TEST_REQUESTS: requestsPath,
	};
	function run(overrides: NodeJS.ProcessEnv = {}, suffix = 'main "$@"') {
		writeFileSync(
			script,
			`${installerSource.slice(0, mainCallIndex)}\nprime_agent_prompt_yes_no() { return 2; }\n${suffix}\n`,
		);
		return spawnSync("/bin/sh", [script], {
			cwd: projectDir,
			env: { ...env, ...overrides },
			encoding: "utf8",
			timeout: 12000,
		});
	}
	function batches(): InstallerBatch[] {
		return existsSync(batchesPath)
			? readFileSync(batchesPath, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as InstallerBatch)
			: [];
	}
	function writeGlobal(value: unknown) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(value));
	}
	function writeProject(value: unknown) {
		const settingsDir = join(projectDir, ".prime", "agent");
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(value));
	}
	return {
		dir,
		bin,
		agentDir,
		projectDir,
		tempDir,
		env,
		requestsPath,
		batchesPath,
		run,
		batches,
		writeGlobal,
		writeProject,
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("installer outcome telemetry", () => {
	it("records actual install stages using the shared contract and links later readiness separately", () => {
		const f = fixture();
		writeFileSync(join(f.agentDir, "telemetry.json"), JSON.stringify({ version: 1, installationId }), {
			mode: 0o600,
		});
		const result = f.run();
		expect(result.status, result.stderr).toBe(0);
		const [batch] = f.batches();
		expect(batch.schema_version).toBe(2);
		expect(batch.installation_id).toBe(installationId);
		expect(batch.events.map(({ properties: p }) => `${p.stage}:${p.outcome}`)).toEqual([
			"started:started",
			"requirements:started",
			"requirements:success",
			"release_lookup:started",
			"release_lookup:success",
			"download:started",
			"download:success",
			"verification:started",
			"verification:success",
			"package_install:started",
			"package_install:success",
			"completed:success",
		]);
		for (const event of batch.events) {
			expect(event.name).toBe("agent installation stage");
			expect(sanitizeTelemetryProperties(event.name, event.properties)).toEqual(event.properties);
			expect(event.properties.duration_ms).toBeNull();
		}
		expect(new Set(batch.events.map((event) => event.id)).size).toBe(batch.events.length);
		expect(new Set(batch.events.map((event) => event.properties.installation_attempt_id)).size).toBe(1);
		const markers = join(f.agentDir, "telemetry-installations");
		const [markerName] = readdirSync(markers);
		expect(lstatSync(markers).mode & 0o777).toBe(0o700);
		expect(lstatSync(join(markers, markerName)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(join(markers, markerName), "utf8"))).toMatchObject({
			version: 1,
			cwd: f.projectDir,
			completeOnReady: false,
			properties: {
				installation_attempt_id: batch.events[0].properties.installation_attempt_id,
				installation_action: "install",
				installation_source: "shell_installer",
				target_version: "1.2.3",
			},
		});
		expect(readdirSync(f.tempDir)).toEqual([]);
		expect(JSON.stringify(batch)).not.toMatch(
			/downloads\.invalid|secret prompt|prime-agent-install\.|settings\.json/,
		);
		expect(JSON.stringify(batch)).not.toContain(f.dir);
		expect(result.stdout + result.stderr).not.toContain(installationId);
	});

	it.each(["internal", "test", "private-origin", ""])("categorizes installer traffic from origin %j", (origin) => {
		const f = fixture();
		const result = f.run({ PRIME_AGENT_TELEMETRY_ORIGIN: origin });
		expect(result.status, result.stderr).toBe(0);
		const [batch] = f.batches();
		const expected = origin === "internal" || origin === "test" ? origin : "unknown";
		for (const event of batch.events) expect(event.properties.workload_origin).toBe(expected);
		expect(JSON.stringify(batch)).not.toContain("private-origin");
	});

	it.each([
		["release_lookup", "release_lookup_failed", "TEST_RELEASE_STATUS", "22", 1],
		["download", "download_failed", "TEST_DOWNLOAD_STATUS", "23", 23],
		["verification", "verification_failed", "TEST_VERIFY_STATUS", "24", 24],
		["package_install", "install_failed", "TEST_INSTALL_STATUS", "25", 25],
	])("preserves %s failures and stops subsequent installer work", (stage, reason, variable, value, status) => {
		const f = fixture();
		const result = f.run({ [variable]: value });
		expect(result.status, result.stderr).toBe(status);
		const events = f.batches()[0].events;
		expect(events.slice(-2).map((event) => event.properties)).toMatchObject([
			{ stage, outcome: "failed", reason, exit_code: status },
			{ stage: "completed", outcome: "failed", reason, exit_code: status },
		]);
		expect(
			events.some((event) => event.properties.stage === "package_install" && event.properties.outcome === "success"),
		).toBe(false);
		expect(existsSync(join(f.agentDir, "telemetry-installations"))).toBe(false);
	});

	it("records failed requirements without claiming an installation attempt succeeded", () => {
		const f = fixture();
		const result = f.run({}, 'start_preflight_checks() { :; }\nfinish_preflight_checks() { return 4; }\nmain "$@"');
		expect(result.status, result.stderr).toBe(4);
		expect(
			f
				.batches()[0]
				.events.slice(-2)
				.map((event) => event.properties),
		).toMatchObject([
			{ stage: "requirements", outcome: "failed", reason: "requirements_unavailable", exit_code: 4 },
			{ stage: "completed", outcome: "failed", reason: "requirements_unavailable", exit_code: 4 },
		]);
	});

	it("records declined Node bootstrap as cancellation while preserving its failure exit", () => {
		const f = fixture();
		const result = f.run(
			{},
			'prime_agent_prompt_yes_no() { return 1; }\nstart_preflight_checks() { :; }\nfinish_preflight_checks() { return 4; }\nmain "$@"',
		);
		expect(result.status, result.stderr).toBe(4);
		expect(f.batches()[0].events.at(-1)?.properties).toMatchObject({
			stage: "completed",
			outcome: "cancelled",
			reason: "declined",
			exit_code: 4,
		});
	});

	it("omits unapproved versions and all raw release or command text", () => {
		const f = fixture();
		const result = f.run({ TEST_TARGET_VERSION: "1.2.3-private-model-name" });
		expect(result.status).toBe(1);
		const [batch] = f.batches();
		expect(JSON.stringify(batch)).not.toContain("private-model-name");
		expect(batch.events.every((event) => event.properties.target_version === undefined)).toBe(true);
		expect(batch.events.every((event) => event.properties.version === "0.0.0")).toBe(true);
	});

	it("preserves a declined install as cancellation with exit zero", () => {
		const f = fixture();
		const result = f.run({}, 'prime_agent_prompt_yes_no() { return 1; }\nmain "$@"');
		expect(result.status).toBe(0);
		expect(f.batches()[0].events.at(-1)?.properties).toMatchObject({
			stage: "completed",
			outcome: "cancelled",
			reason: "declined",
			exit_code: 0,
		});
		expect(f.batches()[0].events.filter((event) => event.properties.stage === "completed")).toHaveLength(1);
	});

	it("preserves signal exit status and interruption instead of recording success", () => {
		const f = fixture();
		const result = f.run(
			{},
			"prime_agent_install_traps\nprime_agent_telemetry_begin\nprime_agent_telemetry_stage=download\nkill -TERM $$",
		);
		expect(result.status).toBe(143);
		expect(f.batches()[0].events.at(-1)?.properties).toMatchObject({
			stage: "completed",
			outcome: "cancelled",
			reason: "interrupted",
			exit_code: 143,
		});
	});

	it.each([
		["PRIME_AGENT_TELEMETRY", "0"],
		["PRIME_AGENT_TELEMETRY", " FaLsE "],
		["PRIME_AGENT_TELEMETRY", "off"],
		["PRIME_AGENT_TELEMETRY", "no"],
		["DO_NOT_TRACK", "1"],
		["DO_NOT_TRACK", "true"],
		["PI_OFFLINE", "yes"],
	])("honors %s=%s before creating an identity or buffering observations", (name, value) => {
		const f = fixture();
		expect(f.run({ [name]: value }).status).toBe(0);
		expect(existsSync(join(f.agentDir, "telemetry.json"))).toBe(false);
		expect(existsSync(f.requestsPath)).toBe(false);
		expect(readdirSync(f.tempDir)).toEqual([]);
	});

	it.each([false, { enabled: false }])("honors legacy and nested settings opt-outs: %j", (telemetry) => {
		for (const scope of ["global", "project"]) {
			const f = fixture();
			if (scope === "global") f.writeGlobal({ telemetry });
			else f.writeProject({ telemetry });
			expect(f.run().status).toBe(0);
			expect(existsSync(join(f.agentDir, "telemetry.json"))).toBe(false);
			expect(existsSync(f.requestsPath)).toBe(false);
		}
	});

	it("preserves explicit environment enablement and higher-priority offline opt-out", () => {
		const f = fixture();
		f.writeGlobal({ telemetry: false });
		expect(f.run({ PRIME_AGENT_TELEMETRY: "on" }).status).toBe(0);
		expect(f.batches()).toHaveLength(1);
		const offline = fixture();
		expect(offline.run({ PRIME_AGENT_TELEMETRY: "1", DO_NOT_TRACK: "1" }).status).toBe(0);
		expect(existsSync(offline.requestsPath)).toBe(false);
	});

	it.each(["{", "null", "[]", '{"telemetry":"false"}', '{"telemetry":{"enabled":"false"}}'])(
		"fails closed for malformed settings %s",
		(settings) => {
			const f = fixture();
			writeFileSync(join(f.agentDir, "settings.json"), settings);
			expect(f.run().status).toBe(0);
			expect(existsSync(f.requestsPath)).toBe(false);
			expect(existsSync(join(f.agentDir, "telemetry.json"))).toBe(false);
		},
	);

	it("fails closed on non-regular settings and identity files", () => {
		for (const name of ["settings.json", "telemetry.json"]) {
			const f = fixture();
			const target = join(f.dir, "target.json");
			writeFileSync(
				target,
				JSON.stringify(name === "settings.json" ? { telemetry: false } : { version: 1, installationId }),
			);
			symlinkSync(target, join(f.agentDir, name));
			expect(f.run().status).toBe(0);
			expect(existsSync(f.requestsPath)).toBe(false);
			expect(lstatSync(join(f.agentDir, name)).isSymbolicLink()).toBe(true);
		}
	});

	it("drops queued observations and readiness markers when disabled during install", () => {
		const f = fixture();
		expect(f.run({ TEST_DISABLE_DURING_INSTALL: "1" }).status).toBe(0);
		expect(existsSync(f.requestsPath)).toBe(false);
		expect(existsSync(join(f.agentDir, "telemetry-installations"))).toBe(false);
		expect(readdirSync(f.tempDir)).toEqual([]);
	});

	it("does not misidentify custom packages as a Prime Agent installation", () => {
		const f = fixture();
		f.run({ PRIME_AGENT_PACKAGE: "private-package" });
		expect(existsSync(f.requestsPath)).toBe(false);
		expect(existsSync(join(f.agentDir, "telemetry.json"))).toBe(false);
	});

	it("does not resume an attempt after an observed opt-out is re-enabled", () => {
		const f = fixture();
		const result = f.run(
			{},
			`prime_agent_install_traps
prime_agent_telemetry_begin
printf '{"telemetry":false}' >"$PRIME_AGENT_CODING_AGENT_DIR/settings.json"
prime_agent_telemetry_record requirements started
printf '{"telemetry":true}' >"$PRIME_AGENT_CODING_AGENT_DIR/settings.json"
prime_agent_telemetry_begin
prime_agent_telemetry_record requirements success`,
		);
		expect(result.status).toBe(0);
		expect(existsSync(f.requestsPath)).toBe(false);
		expect(readdirSync(f.tempDir)).toEqual([]);
	});

	it("rechecks consent after discovery and removes a pending readiness marker", () => {
		const f = fixture();
		expect(f.run({ TEST_DISABLE_ON_DISCOVERY: "1" }).status).toBe(0);
		expect(f.batches()).toEqual([]);
		expect(readdirSync(join(f.agentDir, "telemetry-installations"))).toEqual([]);
	});

	it.each([
		'{"schema_versions":[1],"schema_revision":3}',
		'{"schema_versions":[1,2],"schema_revision":2}',
		'{"schema_versions":[1,2]}',
		'{"schema_versions":[1,2],"schema_revision":"3"}',
		"malformed",
	])("does not send the new event to collectors without revision 3: %s", (capabilities) => {
		const f = fixture();
		expect(f.run({ TEST_CAPABILITIES: capabilities }).status).toBe(0);
		expect(f.batches()).toEqual([]);
	});

	it("bounds the complete upload attempt without changing installer success", () => {
		const f = fixture();
		const started = performance.now();
		const result = f.run({ TEST_HANG: "1" });
		expect(result.status, result.stderr).toBe(0);
		expect(performance.now() - started).toBeLessThan(7000);
		expect(f.batches()).toEqual([]);
	});

	it("expands a tilde agent-directory override before reading opt-out settings", () => {
		const f = fixture();
		const agentDir = join(f.env.HOME ?? "", "custom-agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), '{"telemetry":false}');
		expect(f.run({ PRIME_AGENT_CODING_AGENT_DIR: "~/custom-agent" }).status).toBe(0);
		expect(existsSync(f.requestsPath)).toBe(false);
		expect(existsSync(join(agentDir, "telemetry.json"))).toBe(false);
	});

	it("creates identity files privately and rejects symlink marker directories", () => {
		const f = fixture();
		const markersTarget = join(f.dir, "marker-target");
		mkdirSync(markersTarget);
		symlinkSync(markersTarget, join(f.agentDir, "telemetry-installations"));
		expect(f.run().status).toBe(0);
		expect(lstatSync(join(f.agentDir, "telemetry.json")).mode & 0o777).toBe(0o600);
		expect(readdirSync(markersTarget)).toEqual([]);
		expect(f.batches()).toHaveLength(1);
	});

	it.each([16, 21])("bounds %s pending readiness markers and prunes only marker files", (count) => {
		const f = fixture();
		const directory = join(f.agentDir, "telemetry-installations");
		mkdirSync(directory, { mode: 0o700 });
		const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
		const now = Date.now();
		const marker = (index: number, createdAt = now - (100 - index) * 1_000) => ({
			version: 1,
			createdAt,
			cwd: f.projectDir,
			completeOnReady: false,
			properties: {
				installation_attempt_id: id(index),
				installation_action: "install",
				installation_source: "shell_installer",
				target_version: "1.2.3",
			},
		});
		for (let index = 0; index < count; index++)
			writeFileSync(join(directory, `${id(index)}.json`), JSON.stringify(marker(index)), { mode: 0o600 });
		writeFileSync(
			join(directory, `${id(1_000)}.json`),
			JSON.stringify(marker(1_000, now - 8 * 24 * 60 * 60 * 1_000)),
		);
		writeFileSync(join(directory, `${id(1_001)}.json`), "malformed");
		writeFileSync(join(directory, `${id(1_002)}.json`), JSON.stringify({ ...marker(1_002), properties: {} }));
		writeFileSync(join(directory, `${id(1_003)}.json`), JSON.stringify(marker(1_004)));
		writeFileSync(join(directory, `${id(1_004)}.json`), JSON.stringify(marker(1_004, now + 120_000)));
		writeFileSync(join(directory, `${id(1_005)}.json`), "x".repeat(20_000));
		const unrelated = join(directory, "notes.json");
		writeFileSync(unrelated, "unrelated data");
		const link = join(directory, `${id(1_006)}.json`);
		symlinkSync(unrelated, link);
		const unrelatedText = join(directory, `${id(1_007)}.txt`);
		writeFileSync(unrelatedText, "unrelated text");
		const unrelatedDirectory = join(directory, `${id(1_008)}.json`);
		mkdirSync(unrelatedDirectory);
		writeFileSync(join(unrelatedDirectory, "keep.txt"), "nested unrelated data");
		const result = f.run();
		expect(result.status, result.stderr).toBe(0);
		const markerFiles = readdirSync(directory).filter(
			(name) => /^[0-9a-f-]{36}\.json$/.test(name) && lstatSync(join(directory, name)).isFile(),
		);
		expect(markerFiles).toHaveLength(16);
		for (let index = 0; index < count; index++)
			expect(markerFiles.includes(`${id(index)}.json`)).toBe(index >= count - 15);
		for (let index = 1_000; index <= 1_006; index++)
			expect(existsSync(join(directory, `${id(index)}.json`))).toBe(false);
		expect(readFileSync(unrelated, "utf8")).toBe("unrelated data");
		expect(readFileSync(unrelatedText, "utf8")).toBe("unrelated text");
		expect(readFileSync(join(unrelatedDirectory, "keep.txt"), "utf8")).toBe("nested unrelated data");
		const newId = f.batches()[0].events[0].properties.installation_attempt_id;
		expect(markerFiles).toContain(`${newId}.json`);
	});

	it("latches environment opt-out even before Node is available", () => {
		const f = fixture();
		const result = f.run(
			{},
			`prime_agent_install_traps
PRIME_AGENT_TELEMETRY=" fAlSe "
export PRIME_AGENT_TELEMETRY
command() { return 1; }
prime_agent_telemetry_begin
unset -f command
PRIME_AGENT_TELEMETRY=true
prime_agent_telemetry_begin
prime_agent_telemetry_record requirements success`,
		);
		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(f.requestsPath)).toBe(false);
		expect(existsSync(join(f.agentDir, "telemetry.json"))).toBe(false);
	});

	it("does not collect before Node can parse consent, then observes only later stages", () => {
		const f = fixture();
		const result = f.run(
			{},
			`prime_agent_install_traps
command() { return 1; }
prime_agent_telemetry_begin
prime_agent_telemetry_record requirements started
unset -f command
prime_agent_telemetry_begin
prime_agent_telemetry_record requirements success`,
		);
		expect(result.status, result.stderr).toBe(0);
		expect(f.batches()[0].events.map((event) => `${event.properties.stage}:${event.properties.outcome}`)).toEqual([
			"started:started",
			"requirements:success",
			"completed:success",
		]);
	});
});
