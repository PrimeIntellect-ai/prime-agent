import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

const runtimePython = resolve("../../prime-agent-runtime/.venv/bin/python");
const fallbackPython = join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python");

function resolveKernelPython(): string | null {
	for (const python of [process.env.PRIME_AGENT_KERNEL_PYTHON, runtimePython, fallbackPython]) {
		if (!python || !existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, mcp, rlm"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

const MCP_SERVER = `import asyncio, json, os, sys
from pathlib import Path
Path(sys.argv[1]).write_text(str(os.getpid()))
async def main():
    while line := await asyncio.get_running_loop().run_in_executor(None, sys.stdin.readline):
        request = json.loads(line)
        if request.get("id") is None:
            continue
        if request["method"] == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "shutdown-fixture", "version": "1"}}
        elif request["method"] == "tools/list":
            result = {"tools": [{"name": "fixture.echo", "description": "echo", "inputSchema": {"type": "object"}}]}
        else:
            result = {"content": [{"type": "text", "text": "ok"}]}
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
asyncio.run(main())
`;

function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!pidExists(pid)) return true;
		await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 25));
	}
	return !pidExists(pid);
}

describeIfKernel("real REPL kernel MCP shutdown", { tags: ["kernel-heavy"] }, () => {
	let dir = "";
	let fixture = "";
	let pidFile = "";

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-mcp-shutdown-"));
		fixture = join(dir, "stdio_server.py");
		pidFile = join(dir, "stdio.pid");
		writeFileSync(fixture, MCP_SERVER);
	});

	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("closes a stdio MCP child on graceful shutdown", async () => {
		let manager: ReplKernelManager | undefined = new ReplKernelManager({
			python: python as string,
			cwd: resolve("../../prime-agent-runtime"),
			hostHandlers: {
				"mcp.config": async () => ({
					type: "stdio",
					command: python as string,
					args: [fixture, pidFile],
				}),
			},
		});
		try {
			const opened = await manager.execute(
				"import rlm.mcp as mcp; tools = await mcp.list_tools('fixture'); [t['name'] for t in tools]",
			);
			expect(opened.status, opened.stderr || opened.error?.traceback.join("\n")).toBe("ok");
			expect(opened.result).toContain("fixture.echo");
			const childPid = Number(readFileSync(pidFile, "utf8"));
			expect(pidExists(childPid)).toBe(true);

			await manager.shutdown();
			expect(await waitForExit(childPid, 2_000)).toBe(true);
			manager = undefined;
		} finally {
			await manager?.kill();
		}
	});
});
