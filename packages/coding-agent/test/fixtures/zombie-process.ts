import { spawn } from "node:child_process";
import { isZombieProcess } from "../../src/utils/child-process.js";

/** Fork a perl child that exits unreaped while its parent sleeps: a real zombie for liveness pins. */
export async function spawnZombieProcess(childPerl = ""): Promise<{ zombiePid: number; dispose(): void }> {
	const parent = spawn(
		"perl",
		["-e", `$| = 1; my $pid = fork(); if ($pid) { print "$pid\\n"; sleep 30 } else { ${childPerl} exit 0 }`],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	const zombiePid = await new Promise<number>((resolvePid, rejectPid) => {
		const timer = setTimeout(() => rejectPid(new Error("Timed out waiting for the zombie pid")), 5000);
		let output = "";
		parent.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			const parsed = Number.parseInt(output.trim(), 10);
			if (Number.isInteger(parsed) && parsed > 0) {
				clearTimeout(timer);
				resolvePid(parsed);
			}
		});
	});
	const deadline = Date.now() + 5000;
	while (!isZombieProcess(zombiePid) && Date.now() < deadline) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	return { zombiePid, dispose: () => parent.kill("SIGKILL") };
}
