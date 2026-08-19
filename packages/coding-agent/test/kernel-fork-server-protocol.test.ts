import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ForkedKernelHandle, ForkServer, ForkServerUnavailable } from "../src/core/kernel/fork-server.js";

// Drives the REAL Python forkserver script through the REAL ForkServer class.
// Stub Python modules stand in for IPython/ipykernel so the forked child stays
// alive without a real kernel — fork itself is safe here even on macOS because
// the child never touches the frameworks that make fork-without-exec unsafe.
const STUB_KERNELAPP = [
	"import time",
	"",
	"",
	"class IPKernelApp:",
	"    @classmethod",
	"    def clear_instance(cls):",
	"        pass",
	"",
	"    @classmethod",
	"    def instance(cls, **_kwargs):",
	"        return cls()",
	"",
	"    def initialize(self, _argv):",
	"        pass",
	"",
	"    def start(self):",
	"        while True:",
	"            time.sleep(1)",
	"",
].join("\n");

function writeStubModules(dir: string): void {
	writeFileSync(join(dir, "IPython.py"), "");
	writeFileSync(join(dir, "jupyter_client.py"), "");
	writeFileSync(join(dir, "nest_asyncio.py"), "");
	const ipykernelDir = join(dir, "ipykernel");
	mkdirSync(ipykernelDir);
	writeFileSync(join(ipykernelDir, "__init__.py"), "");
	writeFileSync(join(ipykernelDir, "kernelapp.py"), STUB_KERNELAPP);
}

function killQuietly(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already exited.
	}
}

const havePython3 = process.platform !== "win32" && spawnSync("python3", ["-V"]).status === 0;
const describeIf = havePython3 ? describe : describe.skip;

describeIf("forkserver kill/liveness protocol (stub python)", () => {
	let tempDir = "";
	let server: ForkServer | undefined;
	let savedPythonPath: string | undefined;
	const leakedPids: number[] = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-forkserver-proto-"));
		const stubDir = join(tempDir, "stubs");
		mkdirSync(stubDir);
		writeStubModules(stubDir);
		// launchEnv is snapshotted at ForkServer construction, so the template
		// imports the stubs.
		savedPythonPath = process.env.PYTHONPATH;
		process.env.PYTHONPATH = stubDir;
		server = new ForkServer({ python: "python3" });
	});

	afterEach(() => {
		if (savedPythonPath === undefined) delete process.env.PYTHONPATH;
		else process.env.PYTHONPATH = savedPythonPath;
		server?.dispose();
		server = undefined;
		// The stub app ignores parent_handle, so leak-proof the test itself.
		for (const pid of leakedPids.splice(0)) killQuietly(pid);
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function spawnStubKernel(): Promise<ForkedKernelHandle> {
		const handle = await server!.spawnKernel({ connectionPath: join(tempDir, "conn.json") });
		leakedPids.push(handle.pid);
		return handle;
	}

	it("kills its own child through the protocol and observes the reap", async () => {
		const handle = await spawnStubKernel();
		expect(await handle.isAlive()).toBe(true);
		expect(await handle.kill("TERM")).toBe("signaled");
		await vi.waitFor(async () => {
			expect(await handle.isAlive()).toBe(false);
		});
		// OS-level confirmation (test-side observation only, never a signal path).
		await vi.waitFor(() => {
			expect(() => process.kill(handle.pid, 0)).toThrow();
		});
	}, 15_000);

	it("reports already-exited after reap and never signals an unknown pid", async () => {
		const handle = await spawnStubKernel();
		expect(await handle.kill("TERM")).toBe("signaled");
		await vi.waitFor(async () => {
			expect(await server!.killChild(handle.pid, "TERM")).toBe("already-exited");
		});
		// A child of the TEST, never of the forkserver: the direct pid-reuse-safety
		// assertion — a pid the forkserver doesn't own is never signaled.
		let decoy: ChildProcess | undefined;
		try {
			decoy = spawn("sleep", ["60"]);
			expect(await server!.killChild(decoy.pid!, "TERM")).toBe("unknown-pid");
			expect(decoy.exitCode).toBe(null);
			expect(decoy.killed).toBe(false);
		} finally {
			decoy?.kill("SIGKILL");
		}
	}, 15_000);

	it("liveness reflects the reap table on external child death", async () => {
		const handle = await spawnStubKernel();
		expect(await server!.isChildAlive(handle.pid)).toBe(true);
		// External death (not via the protocol): proves the SIGCHLD reaper drives
		// the table independently of the kill path.
		process.kill(handle.pid, "SIGTERM");
		await vi.waitFor(async () => {
			expect(await server!.isChildAlive(handle.pid)).toBe(false);
		});
	}, 15_000);

	it("kill outcomes stay correct while sibling children churn and get reaped", async () => {
		// Regression for the SIGCHLD-in-watcher-thread race: external deaths storm
		// the reaper while kill requests are in flight; every reply must still match
		// the child's true state (no false "signaled" for a freed pid).
		const keep = await Promise.all([spawnStubKernel(), spawnStubKernel(), spawnStubKernel()]);
		const churn = await Promise.all([spawnStubKernel(), spawnStubKernel(), spawnStubKernel()]);
		for (const handle of churn) process.kill(handle.pid, "SIGKILL");
		const outcomes = await Promise.all(keep.map((handle) => handle.kill("TERM")));
		expect(outcomes).toEqual(["signaled", "signaled", "signaled"]);
		for (const handle of churn) {
			await vi.waitFor(async () => {
				expect(await handle.kill("TERM")).toBe("already-exited");
			});
		}
	}, 15_000);

	it("handle kill/isAlive reject with ForkServerUnavailable when the server is dead", async () => {
		const handle = await spawnStubKernel();
		server!.dispose();
		await expect(handle.kill("TERM")).rejects.toBeInstanceOf(ForkServerUnavailable);
		await expect(handle.isAlive()).rejects.toBeInstanceOf(ForkServerUnavailable);
	}, 15_000);
});

function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const kernelPython = resolveKernelPython();
// Real ipykernel fork round-trip is linux-only: on darwin the forked child dies
// immediately (fork-without-exec is unsafe there), matching isForkServerEnabled.
const describeIfRealKernel = process.platform === "linux" && kernelPython ? describe : describe.skip;

describeIfRealKernel("forkserver kill/liveness protocol (real kernel)", { tags: ["kernel-heavy"] }, () => {
	it("forks a real ipykernel, resolves ports, kills it via the protocol", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-forkserver-real-"));
		const connectionPath = join(dir, "connection.json");
		writeFileSync(
			connectionPath,
			JSON.stringify({
				ip: "127.0.0.1",
				transport: "tcp",
				shell_port: 0,
				iopub_port: 0,
				stdin_port: 0,
				control_port: 0,
				hb_port: 0,
				signature_scheme: "hmac-sha256",
				key: "test-key",
				kernel_name: "python3",
			}),
			{ mode: 0o600 },
		);
		const server = new ForkServer({ python: kernelPython! });
		let pid: number | undefined;
		try {
			const handle = await server.spawnKernel({ connectionPath });
			pid = handle.pid;
			await vi.waitFor(
				() => {
					const info = JSON.parse(readFileSync(connectionPath, "utf8")) as { shell_port: number };
					expect(info.shell_port).toBeGreaterThan(0);
				},
				{ timeout: 20_000, interval: 250 },
			);
			expect(await handle.isAlive()).toBe(true);
			expect(await handle.kill("TERM")).toBe("signaled");
			await vi.waitFor(
				async () => {
					expect(await handle.isAlive()).toBe(false);
				},
				{ timeout: 20_000, interval: 250 },
			);
		} finally {
			server.dispose();
			killQuietly(pid);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
