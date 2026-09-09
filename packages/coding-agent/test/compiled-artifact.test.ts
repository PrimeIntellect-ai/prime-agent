import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http2";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";

const archive = process.env.PRIME_AGENT_TEST_ARCHIVE;
const uv = process.env.PRIME_AGENT_TEST_UV;
const children = new Set<ChildProcess>();
let root = "";
let extracted = "";
let binary = "";
let home = "";
let cwd = "";
let socket = "";
let environment: NodeJS.ProcessEnv;

async function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeout = 30000, input?: string) {
	const child = spawn(binary, args, { cwd, env: { ...environment, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	child.stdin.end(input);
	return await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Artifact timed out: ${args.join(" ")}\n${stderr}`));
		}, timeout);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			children.delete(child);
			done({ code, stdout, stderr });
		});
	});
}

function sessionArgs(): string[] {
	return [
		"--offline",
		"--daemon-socket",
		socket,
		"--no-context-files",
		"--no-extensions",
		"-e",
		join(cwd, "extension.ts"),
		"--provider",
		"artifact-faux",
		"--model",
		"artifact",
	];
}

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const content = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(content));
	return Buffer.concat([length, content, crc]);
}

describe.skipIf(!archive)("extracted standalone archive", () => {
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pa-bin-")));
		extracted = join(root, "extracted app");
		mkdirSync(extracted);
		execFileSync("tar", ["-xzf", resolve(archive!), "-C", extracted]);
		binary = join(extracted, "prime-agent");
		const bin = join(root, "bin");
		mkdirSync(bin);
		for (const command of [
			"sh",
			"bash",
			"ps",
			"kill",
			"env",
			"uname",
			"which",
			"cat",
			"mkdir",
			"rm",
			"ls",
			"sleep",
		]) {
			const source = ["/bin", "/usr/bin"].map((path) => join(path, command)).find(existsSync);
			if (source) symlinkSync(source, join(bin, command));
		}
		if (uv) symlinkSync(resolve(uv), join(bin, "uv"));
	});
	beforeEach(() => {
		home = mkdtempSync(join(root, "home-"));
		cwd = join(home, "project with spaces");
		mkdirSync(cwd);
		socket = join(home, "d.sock");
		environment = {
			HOME: home,
			PATH: join(root, "bin"),
			TMPDIR: root,
			SHELL: "/bin/sh",
			DO_NOT_TRACK: "1",
			PRIME_AGENT_CODING_AGENT_DIR: join(home, "agent"),
			PRIME_AGENT_INSTALL_UV: "0",
			UV_CACHE_DIR: join(root, "uv-cache"),
			UV_PYTHON_INSTALL_DIR: join(root, "python"),
		};
		mkdirSync(environment.PRIME_AGENT_CODING_AGENT_DIR!);
		writeFileSync(
			join(environment.PRIME_AGENT_CODING_AGENT_DIR!, "settings.json"),
			JSON.stringify({ retry: { enabled: false } }),
		);
		copyFileSync(resolve(__dirname, "fixtures/compiled-artifact-extension.ts"), join(cwd, "extension.ts"));
	});
	afterEach(async () => {
		for (const child of children) child.kill("SIGTERM");
		const client = new DaemonClient(socket);
		try {
			await client.connect(1000);
			const hello = await client.waitForHello();
			await client.request({ type: "shutdown", force: true });
			if (hello.supervisorPid) {
				await expect
					.poll(
						() => {
							try {
								process.kill(hello.supervisorPid!, 0);
								return false;
							} catch {
								return true;
							}
						},
						{ timeout: 10000 },
					)
					.toBe(true);
			}
		} catch (error) {
			if (existsSync(socket)) throw error;
		} finally {
			client.close();
		}
		for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		children.clear();
	});
	afterAll(() => {
		if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	it("has verified checksums, clean sidecars, and runtime-free help/version startup", async () => {
		const sum = createHash("sha256").update(readFileSync(archive!)).digest("hex");
		expect(readFileSync(join(dirname(archive!), "SHA256SUMS"), "utf8")).toContain(`${sum}  ${basename(archive!)}`);
		const listing = execFileSync("tar", ["-tzf", archive!], { encoding: "utf8" });
		expect(listing).not.toMatch(/(^|\/)(node_modules|\.venv|__pycache__|\.pytest_cache)(\/|$)/m);
		for (const name of [
			"prime-agent-runtime/src/rlm/repl.py",
			"photon_rs_bg.wasm",
			"export-html/template.css",
			"export-html/template.js",
			"theme/prime.json",
		])
			expect(listing).toContain(name);
		for (const name of ["node", "npm", "bun"]) expect(existsSync(join(environment.PATH!, name))).toBe(false);
		const metadata = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8"));
		expect(metadata.name).toBe("@earendil-works/pi-coding-agent");
		expect(await run(["--version"])).toMatchObject({ code: 0, stdout: `${metadata.version}\n` });
		const help = await run(["--help"]);
		expect(help.code, help.stderr).toBe(0);
		expect(help.stdout).toContain("Python REPL");
	});

	it("loads extensions and skills, flushes piped output, and starts an owned daemon", async () => {
		const result = await run([...sessionArgs(), "--no-tools", "-p", "artifact test"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(`artifact-ok:${"x".repeat(131072)}:complete`);
		expect(JSON.parse(readFileSync(join(cwd, "loaded-assets.json"), "utf8")).skills.length).toBeGreaterThan(0);
		const client = new DaemonClient(socket);
		try {
			await client.connect();
			const hello = await client.waitForHello();
			expect(hello.runtime?.executablePath).toBe(binary);
			expect((await client.request({ type: "list" })).success).toBe(true);
		} finally {
			client.close();
		}
	});

	it("loads Photon WASM to resize an attachment and exports HTML with its theme", async () => {
		const header = Buffer.alloc(13);
		header.writeUInt32BE(3000, 0);
		header.writeUInt32BE(1, 4);
		header[8] = 8;
		header[9] = 2;
		const png = Buffer.concat([
			Buffer.from("89504e470d0a1a0a", "hex"),
			pngChunk("IHDR", header),
			pngChunk("IDAT", deflateSync(Buffer.alloc(9001))),
			pngChunk("IEND", Buffer.alloc(0)),
		]);
		writeFileSync(join(cwd, "wide.png"), png);
		const result = await run([...sessionArgs(), "--no-tools", "-p", "@wide.png", "artifact image"], {
			PRIME_AGENT_ARTIFACT_CASE: "image",
		});
		expect(result.code, result.stderr).toBe(0);
		const sessionsRoot = join(environment.PRIME_AGENT_CODING_AGENT_DIR!, "sessions");
		const sessions = readdirSync(sessionsRoot, { recursive: true })
			.map(String)
			.filter((path) => path.endsWith(".jsonl"));
		expect(sessions.length).toBeGreaterThan(0);
		const output = join(cwd, "export.html");
		const exported = await run(["session", "export", join(sessionsRoot, sessions[0]!), output]);
		expect(exported.code, exported.stderr).toBe(0);
		const html = readFileSync(output, "utf8");
		const encoded = html.match(/<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/)?.[1];
		expect(encoded, "HTML export must embed its session data").toBeDefined();
		expect(Buffer.from(encoded!, "base64").toString("utf8").includes("artifact image")).toBe(true);
	});

	it("handles RPC state and shell requests over pipes and exits on EOF", async () => {
		const input = [
			{ id: "state", type: "get_state" },
			{ id: "shell", type: "bash", command: "printf artifact-rpc-shell" },
		]
			.map((command) => `${JSON.stringify(command)}\n`)
			.join("");
		const result = await run([...sessionArgs(), "--no-tools", "--mode", "rpc"], {}, 30000, input);
		expect(result.code, result.stderr).toBe(0);
		const frames = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(frames.find((frame) => frame.id === "state")).toMatchObject({
			success: true,
			data: { model: { provider: "artifact-faux" } },
		});
		expect(frames.find((frame) => frame.id === "shell")).toMatchObject({
			success: true,
			data: { output: "artifact-rpc-shell", exitCode: 0 },
		});
	});

	it("selects Bedrock from AWS environment credentials and loads its bundled request path", async () => {
		const requests: string[] = [];
		const server = createServer((request, response) => {
			requests.push(request.url ?? "");
			response.writeHead(400, { "Content-Type": "application/json", "x-amzn-errortype": "ValidationException" });
			response.end(JSON.stringify({ message: "artifact-bedrock-request-ok" }));
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing local provider port");
		try {
			const result = await run(
				[
					"--offline",
					"--daemon-socket",
					socket,
					"--no-tools",
					"--no-extensions",
					"--no-skills",
					"-p",
					"offline provider test",
				],
				{
					AWS_ACCESS_KEY_ID: "artifact-test",
					AWS_SECRET_ACCESS_KEY: "artifact-test",
					AWS_REGION: "us-east-1",
					AWS_EC2_METADATA_DISABLED: "true",
					AWS_ENDPOINT_URL_BEDROCK_RUNTIME: `http://127.0.0.1:${address.port}`,
				},
			);
			expect(
				requests.some((path) => path.includes("converse-stream")),
				result.stderr + result.stdout,
			).toBe(true);
			expect(result.code).not.toBe(0);
			expect(result.stderr + result.stdout).toContain("artifact-bedrock-request-ok");
		} finally {
			await new Promise<void>((done) => server.close(() => done()));
		}
	});

	it("bootstraps the shipped Python sources and executes persistent cells and shell commands", async () => {
		expect(uv, "Set PRIME_AGENT_TEST_UV to an absolute uv executable for artifact validation").toBeTruthy();
		const result = await run(
			[...sessionArgs(), "--tools", "ipython", "-p", "artifact python"],
			{ PRIME_AGENT_ARTIFACT_CASE: "python" },
			180000,
		);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("artifact-python-result 42");
		expect(result.stdout).toContain("artifact-shell-ok");
		const bootstrap = JSON.parse(readFileSync(join(home, ".prime/agent/kernel-venv/.bootstrap-version"), "utf8"));
		expect(bootstrap.runtime).toMatch(/^sha256:/);
		expect(bootstrap.pythonSkills.length).toBeGreaterThan(0);
		expect(
			bootstrap.pythonSkills.every((skill: { packagePath: string }) => skill.packagePath.startsWith(extracted)),
		).toBe(true);
	}, 200000);
});
