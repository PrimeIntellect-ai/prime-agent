import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	migrateAuthToAuthJson,
	migrateLegacySessionDirsToSessionRoot,
	migrateSessionsFromAgentRoot,
} from "../src/migrations.js";

const atomicWriteMock = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock("../src/utils/atomic-file.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/atomic-file.js")>();
	return {
		...actual,
		writeFileAtomicSync: (path: string, data: string, options?: object) => {
			if (atomicWriteMock.error && path.endsWith("auth.json")) throw atomicWriteMock.error;
			return actual.writeFileAtomicSync(path, data, options);
		},
	};
});

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

describe("auth migration ordering", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		vi.restoreAllMocks();
		atomicWriteMock.error = undefined;
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves the settings file's own mode when stripping apiKeys", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-auth-migration-mode-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-key" } }));
		chmodSync(settingsPath, 0o600);

		migrateAuthToAuthJson();

		expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8")).apiKeys).toBeUndefined();
	});

	it("strips apiKeys through a symlinked settings.json without replacing the alias", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-auth-migration-symlink-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;
		const realSettings = join(agentDir, "dotfiles-settings.json");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(realSettings, JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-key" } }));
		symlinkSync(realSettings, settingsPath);

		migrateAuthToAuthJson();

		expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(realSettings, "utf-8")).apiKeys).toBeUndefined();
		expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8")).openai.key).toBe("sk-key");
	});

	it("migrates credentials through a dangling auth.json symlink to its target", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-auth-migration-dangling-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;
		writeFileSync(join(agentDir, "oauth.json"), JSON.stringify({ anthropic: { access: "token" } }));
		const target = join(agentDir, "vault-auth.json");
		symlinkSync(target, join(agentDir, "auth.json"));

		migrateAuthToAuthJson();

		expect(lstatSync(join(agentDir, "auth.json")).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(target, "utf-8")).anthropic.type).toBe("oauth");
	});

	it("keeps every credential source when the auth.json write fails", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-auth-migration-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;
		const oauthPath = join(agentDir, "oauth.json");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(oauthPath, JSON.stringify({ anthropic: { access: "token" } }));
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-key" } }));
		atomicWriteMock.error = new Error("disk full");

		expect(() => migrateAuthToAuthJson()).toThrow("disk full");

		// A crash at the destination write must leave both sources recoverable.
		expect(existsSync(join(agentDir, "auth.json"))).toBe(false);
		expect(existsSync(oauthPath)).toBe(true);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8")).apiKeys).toEqual({ openai: "sk-key" });
	});
});
