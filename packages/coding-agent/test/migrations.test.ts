import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	migrateAuthToAuthJson,
	migrateLegacySessionDirsToSessionRoot,
	migrateSessionsFromAgentRoot,
} from "../src/migrations.js";
import { parseSettingsDocument } from "../src/settings-files.js";

describe("session migrations", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("migrates legacy API keys from YAML without changing the settings format", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;
		const settingsPath = join(agentDir, "settings.yml");
		writeFileSync(
			settingsPath,
			`apiKeys:
  fake-provider: fake-key
modelRoles:
  copilot-grok: github-copilot/grok-4.5:high
`,
		);

		expect(migrateAuthToAuthJson()).toEqual(["fake-provider"]);
		expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))).toEqual({
			"fake-provider": { type: "api_key", key: "fake-key" },
		});
		expect(parseSettingsDocument(readFileSync(settingsPath, "utf8"))).toEqual({
			modelRoles: { "copilot-grok": "github-copilot/grok-4.5:high" },
		});
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
	});

	it("moves legacy per-cwd session files into the flat session root", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const sessionsDir = join(agentDir, "sessions");
		const legacyDir = join(sessionsDir, "--tmp-project--");
		mkdirSync(legacyDir, { recursive: true });
		const legacyFile = join(legacyDir, "session-1.jsonl");
		const sessionLines = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			},
			{
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
		];
		writeFileSync(legacyFile, `${sessionLines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		migrateLegacySessionDirsToSessionRoot();

		const migratedFile = join(sessionsDir, "session-1.jsonl");
		expect(existsSync(legacyFile)).toBe(false);
		expect(existsSync(legacyDir)).toBe(false);
		expect(readFileSync(migratedFile, "utf8")).toContain('"id":"session-1"');
	});

	it("moves root session files using only the JSONL header", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const legacyFile = join(agentDir, "session-root.jsonl");
		writeFileSync(
			legacyFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-root",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			})}\n${"x".repeat(128 * 1024)}\n`,
		);

		migrateSessionsFromAgentRoot();

		const migratedFile = join(agentDir, "sessions", "session-root.jsonl");
		expect(existsSync(legacyFile)).toBe(false);
		expect(readFileSync(migratedFile, "utf8")).toContain('"id":"session-root"');
	});

	it("does not move session files from non-legacy subdirectories", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const sessionsDir = join(agentDir, "sessions");
		const nonLegacyDir = join(sessionsDir, "exports");
		mkdirSync(nonLegacyDir, { recursive: true });
		const nestedFile = join(nonLegacyDir, "session-2.jsonl");
		writeFileSync(
			nestedFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-2",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			})}\n`,
		);

		migrateLegacySessionDirsToSessionRoot();

		expect(existsSync(nestedFile)).toBe(true);
		expect(existsSync(join(sessionsDir, "session-2.jsonl"))).toBe(false);
	});
});
