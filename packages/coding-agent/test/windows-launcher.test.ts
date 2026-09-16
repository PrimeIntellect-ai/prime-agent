import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const shellLauncher = readFileSync(join(repository, "prime-agent.sh"), "utf8");
const credentials = [...shellLauncher.matchAll(/^\s*unset ([A-Z_]+)$/gm)].map((match) => match[1]);
const temporaryDirectories: string[] = [];

const reporter = `
const source = process.argv[1].endsWith("cli.mjs");
console.log(JSON.stringify({
    mode: source ? "source" : "dist",
    args: process.argv.slice(source ? 3 : 2),
    entrypoint: source ? process.argv[2] : process.argv[1],
    cwd: process.cwd(),
    executable: process.execPath,
    launcher: process.env.PRIME_AGENT_LAUNCHER_PATH,
    tsconfig: process.env.TSX_TSCONFIG_PATH,
    buildId: process.env.PRIME_AGENT_BUILD_ID,
    credentials: Object.fromEntries(JSON.parse(process.env.PRIME_LAUNCHER_TEST_KEYS || "[]")
        .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    unrelated: process.env.PRIME_LAUNCHER_TEST_UNRELATED,
}).replace(/[\\u007f-\\uffff]/g, (character) => "\\\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")));
if (process.env.PRIME_LAUNCHER_TEST_WAIT === "1") {
    process.on("SIGTERM", () => {
        console.log("received SIGTERM");
        process.exit(37);
    });
    console.log("ready");
    setInterval(() => {}, 1000);
} else if (process.env.PRIME_LAUNCHER_TEST_SIGNAL) {
    process.kill(process.pid, process.env.PRIME_LAUNCHER_TEST_SIGNAL);
} else {
    process.exit(Number(process.env.PRIME_LAUNCHER_TEST_EXIT || "0"));
}
`;

interface Report {
	mode: string;
	args: string[];
	entrypoint: string;
	cwd: string;
	executable: string;
	launcher: string;
	tsconfig?: string;
	buildId?: string;
	credentials: Record<string, string>;
	unrelated?: string;
}

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "prime launcher space ü-"));
	temporaryDirectories.push(directory);
	const checkout = join(directory, "checkout space 日本語");
	const cwd = join(directory, "caller space Ω");
	const runner = join(checkout, "scripts", "run-prime-agent.mjs");
	const source = join(checkout, "packages", "coding-agent", "src", "cli.ts");
	const bundle = join(checkout, "packages", "coding-agent", "dist", "bundle", "cli.js");
	const tsx = join(checkout, "node_modules", "tsx", "dist", "cli.mjs");
	for (const path of [runner, source, bundle, tsx]) mkdirSync(dirname(path), { recursive: true });
	mkdirSync(cwd);
	copyFileSync(join(repository, "scripts", "run-prime-agent.mjs"), runner);
	copyFileSync(join(repository, "prime-agent.cmd"), join(checkout, "prime-agent.cmd"));
	copyFileSync(join(repository, "prime-agent.ps1"), join(checkout, "prime-agent.ps1"));
	writeFileSync(source, "// The fixture tsx CLI records its entrypoint instead of loading it.\n");
	writeFileSync(tsx, reporter);
	writeFileSync(bundle, reporter);
	writeFileSync(join(checkout, "tsconfig.json"), "{}");
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() === "TSX_TSCONFIG_PATH" || key.startsWith("PRIME_LAUNCHER_TEST_")) delete env[key];
	}
	env.PRIME_AGENT_BUILD_ID = "fixture-build";
	return { checkout, cwd, runner, source, bundle, tsx, env };
}

function report(stdout: string): Report {
	const line = stdout.split(/\r?\n/).find((value) => value.startsWith("{"));
	expect(line, stdout).toBeDefined();
	return JSON.parse(line!) as Report;
}

function run(target: ReturnType<typeof fixture>, args: string[] = [], env = target.env) {
	return spawnSync(process.execPath, [target.runner, ...args], {
		cwd: target.cwd,
		env,
		encoding: "utf8",
		shell: false,
		timeout: 15_000,
	});
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("repository Windows launcher", () => {
	it("runs source through the local tsx JavaScript CLI without changing cwd or arguments", () => {
		const target = fixture();
		const args = [
			"--model",
			"provider/model name",
			"--",
			"prompt 日本語",
			"",
			'a"b',
			"a'b",
			"&|<>^%!$()`",
			"C:\\path with spaces\\",
		];
		const result = run(target, args);
		expect(result.status, result.stderr).toBe(0);
		expect(result.error).toBeUndefined();
		expect(report(result.stdout)).toMatchObject({
			mode: "source",
			args,
			entrypoint: target.source,
			cwd: target.cwd,
			executable: process.execPath,
			launcher: join(target.checkout, process.platform === "win32" ? "prime-agent.cmd" : "prime-agent.sh"),
			tsconfig: join(target.checkout, "tsconfig.json"),
			buildId: "fixture-build",
		});
	});

	it("runs --dist without tsx and preserves exit codes", () => {
		const target = fixture();
		rmSync(target.tsx);
		const result = run(target, ["--dist", "--version"], { ...target.env, PRIME_LAUNCHER_TEST_EXIT: "23" });
		expect(result.status, result.stderr).toBe(23);
		expect(report(result.stdout)).toMatchObject({ mode: "dist", args: ["--version"], entrypoint: target.bundle });
	});

	it("leaves wrapper flags after -- untouched", () => {
		const target = fixture();
		const args = ["--", "--no-env", "--dist", "--model", "literal prompt"];
		const result = run(target, args, {
			...target.env,
			OPENAI_API_KEY: "fixture-key",
			PRIME_LAUNCHER_TEST_KEYS: '["OPENAI_API_KEY"]',
		});
		expect(result.status, result.stderr).toBe(0);
		expect(report(result.stdout)).toMatchObject({
			mode: "source",
			args,
			credentials: { OPENAI_API_KEY: "fixture-key" },
		});
	});

	it.each([[], ["--dist"]])("removes the same credentials as prime-agent.sh with --no-env (%j)", (...flags) => {
		const target = fixture();
		expect(credentials.length).toBeGreaterThan(30);
		const env: NodeJS.ProcessEnv = {
			...target.env,
			...Object.fromEntries(credentials.map((key) => [key, "fixture-secret"])),
			PRIME_LAUNCHER_TEST_KEYS: JSON.stringify(credentials),
			PRIME_LAUNCHER_TEST_UNRELATED: "keep-me",
		};
		const result = run(target, [...flags, "--no-env", "--version"], env);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Running Prime Agent without API keys...");
		expect(report(result.stdout)).toMatchObject({ args: ["--version"], credentials: {}, unrelated: "keep-me" });
		expect(env.OPENAI_API_KEY).toBe("fixture-secret");
	});

	it.skipIf(process.platform !== "win32")("removes case-insensitive Windows credential names", () => {
		const target = fixture();
		for (const key of Object.keys(target.env)) if (key.toUpperCase() === "OPENAI_API_KEY") delete target.env[key];
		const result = run(target, ["--no-env"], {
			...target.env,
			openai_api_key: "fixture-secret",
			PRIME_LAUNCHER_TEST_KEYS: '["openai_api_key", "OPENAI_API_KEY"]',
		});
		expect(result.status, result.stderr).toBe(0);
		expect(report(result.stdout).credentials).toEqual({});
	});

	it("preserves credentials without --no-env and an explicit tsx config", () => {
		const target = fixture();
		const result = run(target, [], {
			...target.env,
			OPENAI_API_KEY: "fixture-secret",
			PRIME_LAUNCHER_TEST_KEYS: '["OPENAI_API_KEY"]',
			TSX_TSCONFIG_PATH: join(target.cwd, "custom.json"),
		});
		expect(result.status, result.stderr).toBe(0);
		expect(report(result.stdout)).toMatchObject({
			credentials: { OPENAI_API_KEY: "fixture-secret" },
			tsconfig: join(target.cwd, "custom.json"),
		});
	});

	it("reports missing dependencies without invoking a global tsx or command shim", () => {
		const target = fixture();
		rmSync(target.tsx);
		const result = run(target);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`tsx not found at ${target.tsx}`);
		expect(result.stderr).toContain("Run npm ci from the repo root first.");
		expect(result.stdout).toBe("");
	});

	it("reports a missing compiled bundle", () => {
		const target = fixture();
		rmSync(target.bundle);
		const result = run(target, ["--dist"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`Bundle not found at ${target.bundle}`);
		expect(result.stderr).toContain("npm run build:windows");
	});

	it("reports an incomplete source checkout", () => {
		const target = fixture();
		rmSync(target.source);
		const result = run(target);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(`Source CLI not found at ${target.source}`);
	});

	it.skipIf(process.platform === "win32")("propagates child termination signals", () => {
		const target = fixture();
		const result = run(target, ["--dist"], { ...target.env, PRIME_LAUNCHER_TEST_SIGNAL: "SIGTERM" });
		expect(result.status).toBeNull();
		expect(result.signal).toBe("SIGTERM");
	});

	it.skipIf(process.platform === "win32")("forwards termination to the CLI and waits for its exit", async () => {
		const target = fixture();
		const child = spawn(process.execPath, [target.runner, "--dist"], {
			cwd: target.cwd,
			env: { ...target.env, PRIME_LAUNCHER_TEST_WAIT: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		const closed = once(child, "close");
		let output = "";
		try {
			await new Promise<void>((resolveReady, reject) => {
				child.once("error", reject);
				child.once("exit", () => reject(new Error(`Exited before ready: ${output}`)));
				child.stdout.on("data", (data: Buffer) => {
					output += data.toString();
					if (output.includes("ready\n")) resolveReady();
				});
			});
			child.kill("SIGTERM");
			const [code, signal] = await closed;
			expect(code).toBe(37);
			expect(signal).toBeNull();
			expect(output).toContain("received SIGTERM");
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	});

	it.skipIf(process.platform !== "win32")("launches the actual cmd wrapper", () => {
		const target = fixture();
		const result = spawnSync(
			process.env.ComSpec ?? "cmd.exe",
			[
				"/d",
				"/s",
				"/c",
				'""%PRIME_LAUNCHER_TEST_CMD%" --dist --model "provider/model name" -- "hello 日本語" "bang!""',
			],
			{
				cwd: target.cwd,
				env: {
					...target.env,
					PRIME_LAUNCHER_TEST_CMD: join(target.checkout, "prime-agent.cmd"),
					PRIME_LAUNCHER_TEST_EXIT: "23",
				},
				encoding: "utf8",
				shell: false,
				windowsVerbatimArguments: true,
				timeout: 15_000,
			},
		);
		expect(result.status, result.stderr).toBe(23);
		expect(report(result.stdout)).toMatchObject({
			mode: "dist",
			cwd: target.cwd,
			args: ["--model", "provider/model name", "--", "hello 日本語", "bang!"],
		});
	});

	it.skipIf(process.platform !== "win32")("launches the actual PowerShell wrapper", () => {
		const target = fixture();
		const result = spawnSync(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				join(target.checkout, "prime-agent.ps1"),
				"--dist",
				"--model",
				"provider/model name",
				"--",
				"hello 日本語",
				"bang!",
			],
			{
				cwd: target.cwd,
				env: { ...target.env, PRIME_LAUNCHER_TEST_EXIT: "23" },
				encoding: "utf8",
				shell: false,
				timeout: 15_000,
			},
		);
		expect(result.status, result.stderr).toBe(23);
		expect(report(result.stdout)).toMatchObject({
			mode: "dist",
			cwd: target.cwd,
			args: ["--model", "provider/model name", "--", "hello 日本語", "bang!"],
		});
	});
});
