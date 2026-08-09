import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

const python = resolveKernelPython();
const describeIfKernel = python && process.platform !== "win32" ? describe : describe.skip;

describeIfKernel("kernel process-group isolation (real kernel)", { tags: ["kernel-heavy"] }, () => {
	let tempDir: string | undefined;
	let childPid: number | undefined;
	const originalForkserver = process.env.PRIME_AGENT_KERNEL_FORKSERVER;

	afterEach(() => {
		if (childPid !== undefined) {
			try {
				process.kill(childPid, "SIGKILL");
			} catch {
				// The process-group interrupt already reaped it.
			}
		}
		childPid = undefined;
		if (originalForkserver === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
		else process.env.PRIME_AGENT_KERNEL_FORKSERVER = originalForkserver;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	async function expectInterruptReachesDescendants(useForkserver: boolean): Promise<void> {
		process.env.PRIME_AGENT_KERNEL_FORKSERVER = useForkserver ? "1" : "0";
		tempDir = mkdtempSync(join(tmpdir(), `prime-agent-kernel-pgrp-${useForkserver ? "fork" : "direct"}-`));
		const manager = new KernelManager({ python: python as string, cwd: tempDir });
		const controller = new AbortController();
		let output = "";
		let ready!: () => void;
		const readyPromise = new Promise<void>((resolve) => {
			ready = resolve;
		});
		try {
			const execution = manager.execute(
				[
					"import os, subprocess",
					"p = subprocess.Popen(['sleep', '30'])",
					"print(f'READY {os.getpid()} {os.getpgrp()} {p.pid}', flush=True)",
					"p.wait()",
				].join("\n"),
				{
					signal: controller.signal,
					onStream: (chunk) => {
						output += chunk;
						const match = /READY (\d+) (\d+) (\d+)/.exec(output);
						if (match) {
							childPid = Number(match[3]);
							ready();
						}
					},
				},
			);
			await withTimeout(readyPromise, 15_000, "kernel child startup");
			const match = /READY (\d+) (\d+) (\d+)/.exec(output);
			expect(match).not.toBeNull();
			expect(match?.[1]).toBe(match?.[2]);

			controller.abort();
			await expect(withTimeout(execution, 5_000, "interrupted execution")).resolves.toMatchObject({
				status: "aborted",
			});
			const followUp = await withTimeout(manager.execute("print(123)"), 5_000, "follow-up execution");
			expect(followUp.status).toBe("ok");
			expect(followUp.stdout.trim()).toBe("123");
		} finally {
			if (childPid !== undefined) {
				try {
					process.kill(childPid, "SIGKILL");
				} catch {
					// The process-group interrupt already reaped it.
				}
				childPid = undefined;
			}
			await manager.dispose();
		}
	}

	it("interrupts subprocesses launched by a directly spawned kernel", async () => {
		await expectInterruptReachesDescendants(false);
	}, 30_000);

	it.runIf(process.platform === "linux")(
		"interrupts subprocesses launched by a forked kernel",
		async () => {
			await expectInterruptReachesDescendants(true);
		},
		30_000,
	);
});
