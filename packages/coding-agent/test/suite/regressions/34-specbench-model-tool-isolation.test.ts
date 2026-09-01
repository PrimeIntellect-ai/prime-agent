import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { KERNEL_PROCESS_SANDBOX_ENV, KernelManager } from "../../../src/core/kernel/index.js";
import { specBenchKernelSandboxEnvironment } from "../../../src/evals/specbench/runner.js";

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
	delete process.env.ISSUE34_PROVIDER_TOKEN;
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

describe.skipIf(!sandboxSupported)("issue #34 SpecBench model-tool isolation", () => {
	test.sequential("keeps provider transport outside a credential-free, network-isolated model kernel", async () => {
		const caseRoot = mkdtempSync(join(tmpdir(), "prime-agent-issue34-"));
		cleanupPaths.push(caseRoot);
		const workspace = join(caseRoot, "workspace");
		const agentDir = join(caseRoot, "runtime", "agent");
		const sessionDir = join(caseRoot, "runtime", "sessions");
		const supervisorDir = join(caseRoot, "runtime", "supervisor");
		for (const path of [workspace, agentDir, sessionDir, supervisorDir]) mkdirSync(path, { recursive: true });
		const providerAuthPath = join(agentDir, "auth.json");
		writeFileSync(providerAuthPath, "provider-file-secret");
		const hostCredentialPath = join(homedir(), `.prime-agent-issue34-host-secret-${randomBytes(8).toString("hex")}`);
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

		Object.assign(
			process.env,
			specBenchKernelSandboxEnvironment({
				workspace,
				agentDir,
				sessionDir,
				supervisorDir,
				providerAuthPath,
				kernelPython,
			}),
			{ ISSUE34_PROVIDER_TOKEN: "provider-env-secret" },
		);
		const manager = new KernelManager({ python: kernelPython, cwd: workspace });
		try {
			const result = await manager.execute(`
import json, os, socket

try:
    with open(${JSON.stringify(hostCredentialPath)}, "r", encoding="utf-8") as handle:
        host_credential = handle.read()
except OSError:
    host_credential = None

try:
    with open(${JSON.stringify(providerAuthPath)}, "r", encoding="utf-8") as handle:
        provider_file = handle.read()
except OSError:
    provider_file = None

try:
    connection = socket.create_connection(("127.0.0.1", ${address.port}), timeout=0.25)
    connection.close()
    network_blocked = False
except OSError:
    network_blocked = True

with open("kernel-output.txt", "w", encoding="utf-8") as handle:
    handle.write("candidate-write")

print(json.dumps({
    "host_credential": host_credential,
    "provider_file": provider_file,
    "provider_env": os.environ.get("ISSUE34_PROVIDER_TOKEN"),
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
			expect(existsSync(join(workspace, "kernel-output.txt"))).toBe(true);
			expect(readFileSync(join(workspace, "kernel-output.txt"), "utf8")).toBe("candidate-write");
		} finally {
			await manager.dispose();
			await new Promise<void>((resolve) => provider.close(() => resolve()));
		}
	});
});
