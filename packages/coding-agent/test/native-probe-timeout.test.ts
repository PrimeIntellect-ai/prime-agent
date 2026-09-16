import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const installer = resolve(__dirname, "../../../install.sh");
// The installer probe deadline is injected so the run is bounded by the product timer under test,
// not by how fast the runner gets through a ten second wall-clock wait.
const PROBE_TIMEOUT_SECONDS = 2;

describe.skipIf(process.platform === "win32")("native executable probe deadlines", () => {
	it.each([
		["rollback", "--version"],
		["rollback", "--help"],
		["recovery", "--version"],
		["recovery", "--help"],
	] as const)(
		"releases the lock after a blocked %s %s probe",
		async (operation, argument) => {
			const root = mkdtempSync(join(tmpdir(), "native-probe-timeout-"));
			const managed = join(root, "managed");
			const probePids = join(root, "probe-pids");
			const lockedProbePids = join(root, "locked-probe-pids");
			const bin = join(managed, "bin");
			mkdirSync(bin, { recursive: true });
			writeFileSync(join(managed, ".managed"), "prime-agent-native-v1\n");
			const targets = ["1.0.0", "1.0.1"].map((version) => {
				const digest = "a".repeat(64);
				const name = `${version}-${process.platform}-${process.arch}-${digest}`;
				const release = join(managed, "releases", name);
				for (const asset of [
					"install.sh",
					"prime-agent-runtime/pyproject.toml",
					"prime-agent-runtime/src/rlm/repl.py",
					"theme/prime.json",
					"export-html/template.html",
					"photon_rs_bg.wasm",
				]) {
					mkdirSync(dirname(join(release, asset)), { recursive: true });
					writeFileSync(join(release, asset), "fixture\n");
				}
				writeFileSync(join(release, "package.json"), JSON.stringify({ version }));
				writeFileSync(join(release, ".archive-sha256"), `${digest}\n`);
				writeFileSync(join(release, ".install-source"), "https://example.invalid\n");
				writeFileSync(
					join(release, "prime-agent"),
					`#!/bin/sh
if [ "$1" = "$BLOCK_ARGUMENT" ] && [ "${version}" = "1.0.0" ]; then
 printf '%s\\n' "$$" >> "$PROBE_PIDS"
 if [ -d "$LOCK_PATH" ]; then printf '%s\\n' "$$" >> "$LOCKED_PROBE_PIDS"; fi
 trap '' TERM
 exec sleep 60
fi
printf '%s\\n' '${version}'
`,
					{ mode: 0o755 },
				);
				return `../releases/${name}/prime-agent`;
			});
			symlinkSync(targets[1], join(bin, "prime-agent"));
			symlinkSync(targets[0], join(bin, "previous"));
			const journal = join(managed, ".activation-state");
			if (operation === "recovery") writeFileSync(journal, `${targets[1]}\n${targets[0]}\n`);
			let child: ChildProcess | undefined;
			let result: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
			try {
				const installerChild = spawn("sh", [installer, "--rollback"], {
					env: {
						...process.env,
						HOME: root,
						PATH: "/usr/bin:/bin",
						PRIME_AGENT_INSTALL_DIR: managed,
						PRIME_AGENT_PROBE_TIMEOUT_SECONDS: String(PROBE_TIMEOUT_SECONDS),
						BLOCK_ARGUMENT: argument,
						PROBE_PIDS: probePids,
						LOCKED_PROBE_PIDS: lockedProbePids,
						LOCK_PATH: join(managed, ".install-lock"),
					},
					stdio: ["ignore", "pipe", "pipe"],
				});
				child = installerChild;
				let output = "";
				installerChild.stdout.on("data", (chunk) => {
					output += chunk.toString();
				});
				installerChild.stderr.on("data", (chunk) => {
					output += chunk.toString();
				});
				result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
					installerChild.once("error", reject);
					installerChild.once("exit", (code, signal) => done({ code, signal }));
				});
				const exited = await result;
				expect(exited.signal, output).toBeNull();
				expect(exited.code, output).not.toBe(0);
				expect(output).toContain(`probe timed out after ${PROBE_TIMEOUT_SECONDS} seconds`);
				// The blocked probe records the lock itself, so the assertion never races the deadline.
				expect(readFileSync(lockedProbePids, "utf8")).toBe(readFileSync(probePids, "utf8"));
				expect(readlinkSync(join(bin, "prime-agent"))).toBe(targets[1]);
				expect(readlinkSync(join(bin, "previous"))).toBe(targets[0]);
				expect(existsSync(join(managed, ".install-lock"))).toBe(false);
				expect(existsSync(journal)).toBe(operation === "recovery");
				for (const pid of readFileSync(probePids, "utf8").trim().split("\n").map(Number))
					expect(() => process.kill(pid, 0)).toThrow();
			} finally {
				if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await result;
				if (existsSync(probePids))
					for (const pid of readFileSync(probePids, "utf8").trim().split("\n").map(Number)) {
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							/* Already exited. */
						}
					}
				rmSync(root, { recursive: true, force: true });
			}
		},
		35000,
	);
});
