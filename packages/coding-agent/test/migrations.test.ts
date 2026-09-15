import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
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

describe("auth migration", () => {
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

	function makeAgentDir(): string {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-auth-migration-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;
		return agentDir;
	}

	it("preserves the settings file's own mode when stripping apiKeys", () => {
		const agentDir = makeAgentDir();
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-key" } }));
		chmodSync(settingsPath, 0o600);

		migrateAuthToAuthJson();

		expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8")).apiKeys).toBeUndefined();
	});

	it("strips apiKeys through a symlinked settings.json without replacing the alias", () => {
		const agentDir = makeAgentDir();
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
		const agentDir = makeAgentDir();
		writeFileSync(join(agentDir, "oauth.json"), JSON.stringify({ anthropic: { access: "token" } }));
		const target = join(agentDir, "vault-auth.json");
		symlinkSync(target, join(agentDir, "auth.json"));

		migrateAuthToAuthJson();

		expect(lstatSync(join(agentDir, "auth.json")).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(target, "utf-8")).anthropic.type).toBe("oauth");
	});

	it("successful migration leaves no plaintext legacy file behind", () => {
		const agentDir = makeAgentDir();
		const oauthPath = join(agentDir, "oauth.json");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(oauthPath, JSON.stringify({ anthropic: { access: "token", refresh: "refresh-5346" } }), {
			mode: 0o644,
		});
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-key" } }));

		expect(migrateAuthToAuthJson()).toEqual(["anthropic", "openai"]);

		const authPath = join(agentDir, "auth.json");
		expect(statSync(authPath).mode & 0o777).toBe(0o600);
		const auth = JSON.parse(readFileSync(authPath, "utf-8"));
		expect(auth.anthropic).toEqual({ type: "oauth", access: "token", refresh: "refresh-5346" });
		expect(auth.openai).toEqual({ type: "api_key", key: "sk-key" });
		expect(existsSync(oauthPath)).toBe(false);
		expect(existsSync(`${oauthPath}.migrated`)).toBe(false);
		expect(readFileSync(settingsPath, "utf-8")).not.toContain("sk-key");
		expect(readdirSync(agentDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(readdirSync(agentDir).some((name) => name.startsWith("oauth.json"))).toBe(false);
	});

	it("removes a historical oauth.json.migrated once auth.json holds its providers", () => {
		const agentDir = makeAgentDir();
		const backupPath = join(agentDir, "oauth.json.migrated");
		const authContent = JSON.stringify({ anthropic: { type: "oauth", access: "current", refresh: "r" } });
		writeFileSync(join(agentDir, "auth.json"), authContent, { mode: 0o600 });
		writeFileSync(backupPath, JSON.stringify({ anthropic: { access: "old", refresh: "old-refresh" } }), {
			mode: 0o644,
		});

		expect(migrateAuthToAuthJson()).toEqual([]);

		expect(existsSync(backupPath)).toBe(false);
		expect(readFileSync(join(agentDir, "auth.json"), "utf-8")).toBe(authContent);
	});

	it("locks down an oauth.json.migrated whose providers are missing from auth.json and warns", () => {
		const agentDir = makeAgentDir();
		const backupPath = join(agentDir, "oauth.json.migrated");
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ other: { type: "api_key", key: "k" } }), {
			mode: 0o600,
		});
		writeFileSync(backupPath, JSON.stringify({ anthropic: { access: "old", refresh: "old-refresh" } }), {
			mode: 0o644,
		});
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(migrateAuthToAuthJson()).toEqual([]);

		expect(existsSync(backupPath)).toBe(true);
		expect(statSync(backupPath).mode & 0o777).toBe(0o600);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("oauth.json.migrated");
		expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8")).anthropic).toBeUndefined();
	});

	it("merges providers missing from an existing auth.json and removes the legacy sources", () => {
		const agentDir = makeAgentDir();
		const authPath = join(agentDir, "auth.json");
		const oauthPath = join(agentDir, "oauth.json");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				anthropic: { type: "oauth", access: "current", refresh: "current-refresh" },
				openai: { type: "api_key", key: "sk-current" },
			}),
			{ mode: 0o600 },
		);
		writeFileSync(
			oauthPath,
			JSON.stringify({ anthropic: { access: "stale", refresh: "stale-refresh" }, google: { access: "g" } }),
			{ mode: 0o644 },
		);
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-stale", groq: "gsk" } }));

		expect(migrateAuthToAuthJson()).toEqual(["google", "groq"]);

		const auth = JSON.parse(readFileSync(authPath, "utf-8"));
		expect(auth.anthropic).toEqual({ type: "oauth", access: "current", refresh: "current-refresh" });
		expect(auth.openai).toEqual({ type: "api_key", key: "sk-current" });
		expect(auth.google).toEqual({ type: "oauth", access: "g" });
		expect(auth.groq).toEqual({ type: "api_key", key: "gsk" });
		expect(statSync(authPath).mode & 0o777).toBe(0o600);
		expect(existsSync(oauthPath)).toBe(false);
		expect(existsSync(`${oauthPath}.migrated`)).toBe(false);
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(settings).toEqual({ theme: "dark" });
	});

	it("removes legacy sources whose providers are all already in auth.json without rewriting it", () => {
		const agentDir = makeAgentDir();
		const authPath = join(agentDir, "auth.json");
		const oauthPath = join(agentDir, "oauth.json");
		const settingsPath = join(agentDir, "settings.json");
		const authContent = JSON.stringify({
			anthropic: { type: "oauth", access: "current" },
			openai: { type: "api_key", key: "sk-current" },
		});
		writeFileSync(authPath, authContent, { mode: 0o600 });
		writeFileSync(oauthPath, JSON.stringify({ anthropic: { access: "stale" } }));
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-stale" } }));

		expect(migrateAuthToAuthJson()).toEqual([]);

		expect(readFileSync(authPath, "utf-8")).toBe(authContent);
		expect(existsSync(oauthPath)).toBe(false);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "dark" });
	});

	it("leaves an unreadable auth.json and every legacy source in place", () => {
		const agentDir = makeAgentDir();
		const authPath = join(agentDir, "auth.json");
		const oauthPath = join(agentDir, "oauth.json");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(authPath, "{not json", { mode: 0o600 });
		writeFileSync(oauthPath, JSON.stringify({ anthropic: { access: "token" } }), { mode: 0o644 });
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-key" } }));
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(migrateAuthToAuthJson()).toEqual([]);

		expect(readFileSync(authPath, "utf-8")).toBe("{not json");
		expect(existsSync(oauthPath)).toBe(true);
		expect(statSync(oauthPath).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8")).apiKeys).toEqual({ openai: "sk-key" });
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("keeps every credential source when the auth.json write fails", () => {
		const agentDir = makeAgentDir();
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
