import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { KERNEL_PROCESS_SANDBOX_ENV, KernelManager } from "../../../src/core/kernel/index.js";
import {
	buildKernelBenchAgentSandboxArgs,
	kernelBenchAgentEnvironment,
	kernelBenchKernelSandboxEnvironment,
	prepareKernelBenchConfig,
} from "../../../src/evals/kernelbench/runner.js";

const kernelPython = join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python");
const sandboxSupported =
	process.platform === "linux" &&
	spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0 &&
	spawnSync(kernelPython, ["-c", "import ipykernel"], { stdio: "ignore" }).status === 0;

let cleanupPaths: string[] = [];

afterEach(() => {
	for (const path of cleanupPaths.reverse()) rmSync(path, { recursive: true, force: true });
	cleanupPaths = [];
	delete process.env[KERNEL_PROCESS_SANDBOX_ENV];
	delete process.env.ISSUE23_PROVIDER_TOKEN;
});

function connectToProvider(port: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		let response = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			response += chunk;
		});
		socket.on("end", () => resolve(response));
		socket.on("error", reject);
	});
}

describe("issue #23 KernelBench agent sandbox", () => {
	test("stages provider-only auth, disables MCP tools, and scrubs the host environment", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-kernelbench-agent-config-"));
		try {
			const source = join(root, "source");
			const destination = join(root, "destination");
			mkdirSync(source);
			writeFileSync(
				join(source, "settings.json"),
				JSON.stringify({
					defaultProvider: "google-vertex",
					mcpServers: { github: { url: "https://example.invalid" } },
					bundledSkills: { websearch: true },
				}),
			);
			writeFileSync(
				join(source, "auth.json"),
				JSON.stringify({
					"google-vertex": { type: "api_key", key: "provider-secret" },
					"mcp:github": { type: "api_key", key: "mcp-secret" },
					openrouter: { type: "api_key", key: "unselected-secret" },
				}),
			);
			writeFileSync(join(source, "models.json"), JSON.stringify({ providers: {} }));
			writeFileSync(join(source, "telemetry.json"), JSON.stringify({ token: "telemetry-secret" }));

			prepareKernelBenchConfig(source, destination, "google-vertex");

			expect(JSON.parse(readFileSync(join(destination, "settings.json"), "utf8"))).toMatchObject({
				mcpServers: {},
				bundledSkills: { websearch: false },
			});
			expect(JSON.parse(readFileSync(join(destination, "auth.json"), "utf8"))).toEqual({
				"google-vertex": { type: "api_key", key: "provider-secret" },
			});
			expect(existsSync(join(destination, "models.json"))).toBe(true);
			expect(existsSync(join(destination, "telemetry.json"))).toBe(false);

			const environment = kernelBenchAgentEnvironment(
				{
					PATH: "/host/bin",
					GITHUB_TOKEN: "github-secret",
					NODE_OPTIONS: "--require=/tmp/host-hook.js",
					PYTHONPATH: "/tmp/host-python",
					SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock",
					DOCKER_HOST: "unix:///run/docker.sock",
					CUDA_VISIBLE_DEVICES: "0",
				},
				"/opt/KernelBench",
				"/tmp/kernelbench-build-cache",
			);
			expect(environment).toMatchObject({
				CUDA_VISIBLE_DEVICES: "0",
				GOOGLE_VERTEX_GOOGLE_SEARCH: "0",
				PI_OFFLINE: "1",
				UV_OFFLINE: "1",
			});
			for (const name of ["GITHUB_TOKEN", "NODE_OPTIONS", "PYTHONPATH", "SSH_AUTH_SOCK", "DOCKER_HOST"]) {
				expect(environment[name]).toBeUndefined();
			}

			const sandbox = buildKernelBenchAgentSandboxArgs(
				"/usr/bin/true",
				[],
				"/tmp/kernelbench-case",
				"/tmp/kernelbench-case/workspace",
				["/tmp/kernelbench-case/workspace/reference.py"],
				environment,
			);
			const serialized = sandbox.join("\0");
			for (const path of [join(homedir(), ".ssh"), join(homedir(), ".config", "gcloud")]) {
				if (existsSync(path)) expect(serialized).toContain(`--tmpfs\0${path}`);
			}
			const netrc = join(homedir(), ".netrc");
			if (existsSync(netrc)) expect(serialized).toContain(`--ro-bind\0/dev/null\0${netrc}`);
			expect(serialized).toContain("--tmpfs\0/run");
			expect(sandbox).toContain("--clearenv");
			expect(serialized).not.toContain("github-secret");
			expect(serialized).not.toContain("ssh-agent.sock");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux" || spawnSync("bwrap", ["--version"]).status !== 0)(
		"keeps provider transport functional while masking host credentials and runtime sockets",
		async () => {
			const caseRoot = mkdtempSync(join(tmpdir(), "prime-kernelbench-agent-boundary-"));
			const workspace = join(caseRoot, "workspace");
			const providerAuthPath = join(caseRoot, "runtime", "agent", "auth.json");
			mkdirSync(workspace, { recursive: true });
			mkdirSync(join(caseRoot, "runtime", "agent"), { recursive: true });
			writeFileSync(providerAuthPath, "provider-file-secret");

			const provider = createServer();
			await new Promise<void>((resolve, reject) => {
				provider.once("error", reject);
				provider.listen(0, "127.0.0.1", resolve);
			});
			const address = provider.address();
			if (!address || typeof address === "string") throw new Error("provider test server did not bind TCP");

			try {
				const environment = kernelBenchAgentEnvironment(
					{ ...process.env, ISSUE23_PROVIDER_TOKEN: "provider-env-secret" },
					caseRoot,
					join(caseRoot, "build-cache"),
				);
				const probe = `
import json, os, pathlib, socket

connection = socket.create_connection(("127.0.0.1", ${address.port}), timeout=1)
connection.close()
print(json.dumps({
    "auth": pathlib.Path(${JSON.stringify(providerAuthPath)}).read_text(encoding="utf-8"),
    "codex_hidden": not pathlib.Path(${JSON.stringify(join(homedir(), ".codex", "memories", "MEMORY.md"))}).exists(),
    "runtime_hidden": not pathlib.Path("/run/user").exists(),
    "secret_env": os.environ.get("ISSUE23_PROVIDER_TOKEN"),
}))
`;
				const args = buildKernelBenchAgentSandboxArgs(
					"/usr/bin/python3",
					["-I", "-c", probe],
					caseRoot,
					workspace,
					[],
					environment,
				);
				const result = spawnSync(args[0]!, args.slice(1), {
					cwd: workspace,
					encoding: "utf8",
					env: environment,
					timeout: 10_000,
				});
				expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
				expect(JSON.parse(result.stdout.trim())).toEqual({
					auth: "provider-file-secret",
					codex_hidden: true,
					runtime_hidden: true,
					secret_env: null,
				});
			} finally {
				await new Promise<void>((resolve) => provider.close(() => resolve()));
				rmSync(caseRoot, { recursive: true, force: true });
			}
		},
	);

	test
		.skipIf(!sandboxSupported)
		.sequential("keeps provider transport outside a credential-free, network-isolated model kernel", async () => {
			const caseRoot = mkdtempSync(join(tmpdir(), "prime-kernelbench-issue23-"));
			cleanupPaths.push(caseRoot);
			const workspace = join(caseRoot, "workspace");
			const agentDir = join(caseRoot, "runtime", "agent");
			const sessionDir = join(caseRoot, "runtime", "sessions");
			const supervisorDir = join(caseRoot, "runtime", "supervisor");
			const buildCache = join(caseRoot, "build-cache");
			const kernelbenchRoot = join(caseRoot, "KernelBench");
			for (const path of [workspace, agentDir, sessionDir, supervisorDir, buildCache, kernelbenchRoot]) {
				mkdirSync(path, { recursive: true });
			}
			const providerAuthPath = join(agentDir, "auth.json");
			writeFileSync(providerAuthPath, "provider-file-secret");
			const hostCredentialPath = join(
				homedir(),
				`.prime-kernelbench-issue23-host-secret-${randomBytes(8).toString("hex")}`,
			);
			writeFileSync(hostCredentialPath, "host-file-secret", { mode: 0o600 });
			cleanupPaths.push(hostCredentialPath);

			const provider = createServer((socket) => socket.end("provider-ok"));
			await new Promise<void>((resolve, reject) => {
				provider.once("error", reject);
				provider.listen(0, "127.0.0.1", resolve);
			});
			const address = provider.address();
			if (!address || typeof address === "string") throw new Error("provider test server did not bind TCP");
			expect(await connectToProvider(address.port)).toBe("provider-ok");

			const kernelSandboxEnvironment = kernelBenchKernelSandboxEnvironment({
				workspace,
				agentDir,
				sessionDir,
				supervisorDir,
				buildCache,
				kernelbenchRoot,
				providerAuthPath,
				kernelPython,
			});
			const kernelSandbox = JSON.parse(kernelSandboxEnvironment[KERNEL_PROCESS_SANDBOX_ENV]!) as {
				argv: string[];
			};
			const serializedKernelSandbox = kernelSandbox.argv.join("\0");
			expect(serializedKernelSandbox).toContain("--dev-bind\0/dev\0/dev");
			expect(serializedKernelSandbox).toContain("--ro-bind\0/sys\0/sys");
			Object.assign(process.env, kernelSandboxEnvironment, { ISSUE23_PROVIDER_TOKEN: "provider-env-secret" });
			const manager = new KernelManager({ python: kernelPython, cwd: workspace });
			try {
				const result = await manager.execute(`
import json, os, socket

def read_or_none(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return None

try:
    connection = socket.create_connection(("127.0.0.1", ${address.port}), timeout=0.25)
    connection.close()
    network_blocked = False
except OSError:
    network_blocked = True

with open("kernel-output.txt", "w", encoding="utf-8") as handle:
    handle.write("candidate-write")
with open(${JSON.stringify(join(buildCache, "build-output.txt"))}, "w", encoding="utf-8") as handle:
    handle.write("build-write")

print(json.dumps({
    "host_credential": read_or_none(${JSON.stringify(hostCredentialPath)}),
    "provider_file": read_or_none(${JSON.stringify(providerAuthPath)}),
    "provider_env": os.environ.get("ISSUE23_PROVIDER_TOKEN"),
    "network_blocked": network_blocked,
}))
`);
				expect(result.status).toBe("ok");
				expect(JSON.parse(result.stdout.trim())).toEqual({
					host_credential: null,
					provider_file: null,
					provider_env: null,
					network_blocked: true,
				});
				expect(readFileSync(join(workspace, "kernel-output.txt"), "utf8")).toBe("candidate-write");
				expect(readFileSync(join(buildCache, "build-output.txt"), "utf8")).toBe("build-write");
			} finally {
				await manager.dispose();
				await new Promise<void>((resolve) => provider.close(() => resolve()));
			}
		});
});
