import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { getAgentDir, getPackageDir, getSessionsDir } from "./config.js";

export interface DoctorCheck {
	name: string;
	ok: boolean;
	detail: string;
}

export interface DoctorReport {
	ok: boolean;
	checks: DoctorCheck[];
}

function commandVersion(command: string): string | undefined {
	const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
	const result = spawnSync(executable, ["--version"], {
		encoding: "utf-8",
		windowsHide: true,
		shell: process.platform === "win32",
	});
	return result.status === 0 ? result.stdout.trim() : undefined;
}

export function runDoctorChecks(fix = false): DoctorReport {
	const agentDir = getAgentDir();
	const sessionsDir = getSessionsDir(agentDir);
	if (fix) {
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionsDir, { recursive: true });
	}
	const nodeVersion = commandVersion("node");
	const npmVersion = commandVersion("npm");
	const checks: DoctorCheck[] = [
		{
			name: "node",
			ok: nodeVersion !== undefined,
			detail: nodeVersion ?? "Node.js was not found",
		},
		{
			name: "npm",
			ok: npmVersion !== undefined,
			detail: npmVersion ?? "npm was not found",
		},
		{
			name: "agent-directory",
			ok: existsSync(agentDir),
			detail: agentDir,
		},
		{
			name: "sessions-directory",
			ok: existsSync(sessionsDir),
			detail: sessionsDir,
		},
		{
			name: "package-directory",
			ok: existsSync(getPackageDir()),
			detail: getPackageDir(),
		},
	];
	return { ok: checks.every((check) => check.ok), checks };
}
