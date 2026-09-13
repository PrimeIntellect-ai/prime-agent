// ENG-5342: provider credentials must not reach the kernel through the host
// environment, and a name holding a known credential value must not be pickled
// into the session's kernel-state snapshot.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

function resolveReplPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		resolve(__dirname, "..", "..", "..", "prime-agent-runtime", ".venv", "bin", "python"),
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveReplPython();
const describeIf = python && process.platform !== "win32" ? describe : describe.skip;

const SYNTHETIC_PRIME_KEY = "sk-synthetic-prime-5342-do-not-use";
const SYNTHETIC_OPENAI_KEY = "sk-synthetic-openai-5342-do-not-use";

describeIf("repl kernel secret retention (real runtime)", { tags: ["kernel-heavy"] }, () => {
	let dir = "";
	let manager: ReplKernelManager | undefined;
	let savedPrime: string | undefined;
	let savedOpenai: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-secrets-"));
		savedPrime = process.env.PRIME_API_KEY;
		savedOpenai = process.env.OPENAI_API_KEY;
		process.env.PRIME_API_KEY = SYNTHETIC_PRIME_KEY;
		process.env.OPENAI_API_KEY = SYNTHETIC_OPENAI_KEY;
	});

	afterEach(async () => {
		if (savedPrime === undefined) delete process.env.PRIME_API_KEY;
		else process.env.PRIME_API_KEY = savedPrime;
		if (savedOpenai === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = savedOpenai;
		await manager?.shutdown({ snapshot: false, drainHostRequests: true });
		manager = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("does not expose host provider credentials to kernel cells or bash cells", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir, env: { RLM_DEPTH: "0" } });
		const probe = await manager.execute(
			[
				"import os, json",
				"print(json.dumps({",
				"  'prime': os.environ.get('PRIME_API_KEY'),",
				"  'openai': os.environ.get('OPENAI_API_KEY'),",
				"  'path': bool(os.environ.get('PATH')),",
				"  'home': bool(os.environ.get('HOME')),",
				"  'rlm_depth': os.environ.get('RLM_DEPTH'),",
				"  'owner': bool(os.environ.get('PRIME_AGENT_KERNEL_OWNER_PID')),",
				"  'credential_like': sorted(k for k in os.environ if any(t in k for t in ('API_KEY', 'TOKEN', 'SECRET'))),",
				"}))",
			].join("\n"),
		);
		expect(probe.status).toBe("ok");
		const seen = JSON.parse(probe.stdout.trim()) as Record<string, unknown>;
		expect(seen.prime).toBeNull();
		expect(seen.openai).toBeNull();
		expect(seen.credential_like).toEqual([]);
		expect(seen.path).toBe(true);
		expect(seen.home).toBe(true);
		expect(seen.rlm_depth).toBe("0");
		expect(seen.owner).toBe(true);

		// bash() children inherit the kernel env, so they run (PATH) without the key.
		const shell = await manager.execute(
			"import subprocess\nprint(subprocess.run(['sh', '-c', 'if [ -z \"$PRIME_API_KEY\" ]; then echo prime=unset; else echo prime=set; fi; command -v sh >/dev/null && echo path-ok'], capture_output=True, text=True).stdout)",
		);
		expect(shell.status).toBe("ok");
		expect(shell.stdout).toContain("prime=unset");
		expect(shell.stdout).toContain("path-ok");
	});

	it("skips top-level names holding a known host credential value when snapshotting", async () => {
		const snapshotPath = join(dir, "kernel-state.dill");
		const manifestPath = join(dir, "kernel-state.json");
		manager = new ReplKernelManager({
			python: python as string,
			cwd: dir,
			snapshot: { path: snapshotPath, manifestPath },
		});
		// The value arrives through some other channel (a config file, a paste); the
		// host still recognises it as the credential it saw in its own environment.
		await manager.execute(
			`launcher_key = ${JSON.stringify(SYNTHETIC_PRIME_KEY)}\npadded_key = ${JSON.stringify(` ${SYNTHETIC_OPENAI_KEY}\n`)}\nkey_bytes = ${JSON.stringify(SYNTHETIC_PRIME_KEY)}.encode()\nplain = 'not a secret at all'\nnumber = 42`,
		);
		const snap = await manager.snapshotState();
		expect(snap).not.toBeNull();
		expect(snap?.saved).toEqual(expect.arrayContaining(["plain", "number"]));
		expect(snap?.saved).not.toContain("launcher_key");
		expect(snap?.saved).not.toContain("padded_key");
		expect(snap?.saved).not.toContain("key_bytes");
		const skipped = new Map(snap?.skipped.map((entry) => [entry.name, entry.reason]));
		for (const name of ["launcher_key", "padded_key", "key_bytes"]) {
			expect(skipped.get(name), name).toBe("matches a credential from the host environment");
		}

		const dill = readFileSync(snapshotPath);
		expect(dill.includes(SYNTHETIC_PRIME_KEY)).toBe(false);
		expect(dill.includes(SYNTHETIC_OPENAI_KEY)).toBe(false);
		expect(dill.includes("not a secret at all")).toBe(true);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { savedNames: string[]; skipped: unknown[] };
		expect(manifest.savedNames).not.toContain("launcher_key");
		expect(manifest.skipped).toEqual(
			expect.arrayContaining([{ name: "launcher_key", reason: "matches a credential from the host environment" }]),
		);
	});
});
