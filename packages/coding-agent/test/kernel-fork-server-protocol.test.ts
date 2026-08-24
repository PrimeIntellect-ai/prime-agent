import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ForkedKernelHandle, ForkServer, ForkServerUnavailable } from "../src/core/kernel/fork-server.js";
import { ORPHAN_PROCESS_JOURNAL_ENV } from "../src/core/orphan-process-journal.js";

// Drives the REAL Python forkserver script through the REAL ForkServer class.
// Stub Python modules stand in for IPython/ipykernel so the forked child stays
// alive without a real kernel — fork itself is safe here even on macOS because
// the child never touches the frameworks that make fork-without-exec unsafe.
const STUB_KERNELAPP = [
	"import os",
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
	"        # Env knob: lets tests fork a child that exits immediately (the",
	"        # per-kernel env is applied in the child before start()).",
	"        if os.environ.get('STUB_KERNEL_EXIT'):",
	"            return",
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

	async function spawnStubKernel(
		target: ForkServer = server!,
		env?: Record<string, string | undefined>,
	): Promise<ForkedKernelHandle> {
		const handle = await target.spawnKernel({ connectionPath: join(tempDir, "conn.json"), env });
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

	it("reports already-exited after reap and fails closed on an unknown fork id", async () => {
		const handle = await spawnStubKernel();
		expect(await handle.kill("TERM")).toBe("signaled");
		await vi.waitFor(async () => {
			expect(await handle.kill("TERM")).toBe("already-exited");
		});
		// A fork id the forkserver never issued: nothing may be signaled.
		expect(await server!.killChild(999_999, "TERM")).toBe("unknown-pid");
		expect(await server!.isChildAlive(999_999)).toBe(false);
	}, 15_000);

	it("liveness reflects the reap table on external child death", async () => {
		const handle = await spawnStubKernel();
		expect(await handle.isAlive()).toBe(true);
		// External death (not via the protocol): proves the SIGCHLD reaper drives
		// the registry independently of the kill path.
		process.kill(handle.pid, "SIGTERM");
		await vi.waitFor(async () => {
			expect(await handle.isAlive()).toBe(false);
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

	it("a fast-exiting child never lands alive; its handle stays already-exited across new forks", async () => {
		// STUB_KERNEL_EXIT makes the forked child return from start() immediately,
		// so it can be reaped as early as the OS allows relative to the parent-side
		// registry insertion — the SIGCHLD-blocked fork bookkeeping must still
		// record it under its own id and mark exactly that entry not-alive.
		const fast = await spawnStubKernel(server!, { STUB_KERNEL_EXIT: "1" });
		await vi.waitFor(async () => {
			expect(await fast.isAlive()).toBe(false);
		});
		expect(await fast.kill("TERM")).toBe("already-exited");
		// Id-keying invariant: a later fork gets a fresh id (even if the OS reuses
		// the pid, which we can't force), and the old handle's answers don't change.
		const next = await spawnStubKernel();
		expect(await next.isAlive()).toBe(true);
		expect(await fast.isAlive()).toBe(false);
		expect(await fast.kill("TERM")).toBe("already-exited");
		expect(await next.kill("TERM")).toBe("signaled");
	}, 15_000);

	it("evicted registry entries fail closed (unknown-pid/false), recent ones stay answerable", async () => {
		// A tiny history bound (argv[2] to the script) makes FIFO eviction reachable.
		const bounded = new ForkServer({ python: "python3", historyBound: 2 });
		try {
			const oldest = await spawnStubKernel(bounded, { STUB_KERNEL_EXIT: "1" });
			await vi.waitFor(async () => {
				expect(await oldest.kill("TERM")).toBe("already-exited");
			});
			const middle = await spawnStubKernel(bounded, { STUB_KERNEL_EXIT: "1" });
			const newest = await spawnStubKernel(bounded, { STUB_KERNEL_EXIT: "1" });
			// Three entries against a bound of 2: the oldest id has been evicted.
			expect(await oldest.kill("TERM")).toBe("unknown-pid");
			expect(await oldest.isAlive()).toBe(false);
			for (const handle of [middle, newest]) {
				await vi.waitFor(async () => {
					expect(await handle.kill("TERM")).toBe("already-exited");
				});
				expect(await handle.isAlive()).toBe(false);
			}
		} finally {
			bounded.dispose();
		}
	}, 15_000);

	it("keeps live entries answerable past the history bound and evicts only exited ones", async () => {
		// A live child must never be evicted: an evicted-live entry would read
		// dead to the liveness monitor and be unroutable for kill — the exact
		// orphan leak this forkserver exists to prevent.
		const bounded = new ForkServer({ python: "python3", historyBound: 2 });
		try {
			const oldest = await spawnStubKernel(bounded);
			expect(await oldest.isAlive()).toBe(true);
			const middle = await spawnStubKernel(bounded);
			const newest = await spawnStubKernel(bounded);
			// Three live entries against a bound of 2: none may be evicted.
			expect(await oldest.isAlive()).toBe(true);
			expect(await middle.isAlive()).toBe(true);
			expect(await newest.isAlive()).toBe(true);
			// Once dead entries exist, the next fork sweeps them out instead.
			expect(await oldest.kill("TERM")).toBe("signaled");
			expect(await middle.kill("TERM")).toBe("signaled");
			await vi.waitFor(async () => {
				expect(await oldest.isAlive()).toBe(false);
				expect(await middle.isAlive()).toBe(false);
			});
			const extra = await spawnStubKernel(bounded);
			// Bound 2 with two dead entries: both are evicted, the live ones stay.
			expect(await oldest.kill("TERM")).toBe("unknown-pid");
			expect(await middle.kill("TERM")).toBe("unknown-pid");
			expect(await newest.isAlive()).toBe(true);
			expect(await extra.isAlive()).toBe(true);
			expect(await newest.kill("TERM")).toBe("signaled");
			expect(await extra.kill("TERM")).toBe("signaled");
		} finally {
			bounded.dispose();
		}
	}, 15_000);

	it("handle kill/isAlive reject with ForkServerUnavailable when the server is dead", async () => {
		const handle = await spawnStubKernel();
		server!.dispose();
		await expect(handle.kill("TERM")).rejects.toBeInstanceOf(ForkServerUnavailable);
		await expect(handle.isAlive()).rejects.toBeInstanceOf(ForkServerUnavailable);
	}, 15_000);

	describe("forkserver orphan journal", () => {
		let journalPath = "";
		const savedJournal = process.env[ORPHAN_PROCESS_JOURNAL_ENV];

		interface JournalRecord {
			pid: number;
			active: boolean;
		}

		function readJournal(): JournalRecord[] {
			if (!existsSync(journalPath)) return [];
			return readFileSync(journalPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as JournalRecord);
		}

		beforeEach(() => {
			journalPath = join(tempDir, "orphans.jsonl");
			process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		});

		afterEach(() => {
			if (savedJournal === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
			else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = savedJournal;
		});

		it("disposing a live forkserver delivers the kill and writes inactive", async () => {
			await spawnStubKernel();
			const records = readJournal();
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({ active: true });
			server!.dispose();
			const after = readJournal();
			expect(after).toHaveLength(2);
			expect(after[1]).toMatchObject({ pid: records[0]!.pid, active: false });
		}, 15_000);

		it("a forkserver exit observed by the handle writes inactive", async () => {
			await spawnStubKernel();
			const forkserverPid = readJournal()[0]!.pid;
			process.kill(forkserverPid, "SIGKILL");
			// The exit event drives markDead → dispose with the exit already observed.
			await vi.waitFor(() => {
				const records = readJournal();
				expect(records).toHaveLength(2);
				expect(records[1]).toMatchObject({ pid: forkserverPid, active: false });
			});
		}, 15_000);

		it("a never-started forkserver writes no journal records on dispose", () => {
			const idle = new ForkServer({ python: "python3" });
			idle.dispose();
			expect(readJournal()).toHaveLength(0);
		});

		it("an unconfirmed kill with no observed exit leaves no inactive record", () => {
			const unconfirmed = new ForkServer({ python: "python3" });
			const internals = unconfirmed as unknown as {
				proc?: { pid?: number; exitCode: number | null; signalCode: string | null; kill(): boolean };
			};
			internals.proc = { pid: 424242, exitCode: null, signalCode: null, kill: () => false };
			unconfirmed.dispose();
			expect(readJournal().some((r) => r.pid === 424242)).toBe(false);
		});
	});
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
