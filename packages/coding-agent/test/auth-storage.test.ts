import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend } from "../src/core/auth-storage.js";

const initialWriteFault = vi.hoisted(() => ({ count: -1 }));
const renameFault = vi.hoisted(() => ({ error: undefined as Error | undefined }));
const absenceIllusion = vi.hoisted(() => ({ paths: new Set<string>() }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeSync: ((fd: number, data: NodeJS.ArrayBufferView | string, offset?: number, length?: number) => {
			if (initialWriteFault.count >= 0) {
				const count = initialWriteFault.count;
				initialWriteFault.count = -1;
				if (count === 0) return 0;
				const bytes =
					typeof data === "string"
						? Buffer.from(data)
						: Buffer.from(data.buffer, data.byteOffset, data.byteLength);
				return actual.writeSync(fd, bytes, offset ?? 0, count);
			}
			return actual.writeSync(fd, data as never, offset as never, length as never);
		}) as typeof actual.writeSync,
		renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
			if (renameFault.error && String(to).endsWith("auth.json")) throw renameFault.error;
			return actual.renameSync(from, to);
		},
		existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
			if (absenceIllusion.paths.has(String(path))) return false;
			return actual.existsSync(path);
		},
	};
});

describe("AuthStorage", () => {
	let tempDir: string;
	let authJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>) {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	describe("API key resolution", () => {
		test("literal API key is returned directly", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "sk-ant-literal-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("sk-ant-literal-key");
		});

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo test-api-key-from-command" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo '  spaced-key  '" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf 'line1\\nline2'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!exit 1" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!nonexistent-command-12345" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf ''" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey as environment variable name resolves to env value", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("ambient environment credentials count as available auth", async () => {
			const originalAwsProfile = process.env.AWS_PROFILE;
			process.env.AWS_PROFILE = "pi-test-profile";

			try {
				authStorage = AuthStorage.inMemory();

				expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBe("<authenticated>");
				expect(authStorage.getAuthStatus("amazon-bedrock")).toEqual({
					configured: false,
					source: "environment",
					label: "ambient credentials",
				});
			} finally {
				if (originalAwsProfile === undefined) {
					delete process.env.AWS_PROFILE;
				} else {
					process.env.AWS_PROFILE = originalAwsProfile;
				}
			}
		});

		test("changed ambient environment credential no longer matches stale auth marker", async () => {
			const originalAwsProfile = process.env.AWS_PROFILE;
			process.env.AWS_PROFILE = "stale-profile";

			try {
				authStorage = AuthStorage.inMemory();
				expect(authStorage.markAuthStale("amazon-bedrock")).toBe(true);
				expect(authStorage.hasAuth("amazon-bedrock")).toBe(false);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBeUndefined();

				process.env.AWS_PROFILE = "fresh-profile";

				expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBe("<authenticated>");
			} finally {
				if (originalAwsProfile === undefined) {
					delete process.env.AWS_PROFILE;
				} else {
					process.env.AWS_PROFILE = originalAwsProfile;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			delete process.env.literal_api_key_value;

			writeAuthJson({
				anthropic: { type: "api_key", key: "literal_api_key_value" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("stored credential updates do not revive stale runtime auth", async () => {
			authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			expect(authStorage.markAuthStale("anthropic")).toBe(true);

			authStorage.set("anthropic", { type: "api_key", key: "stored-key" });

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("stored-key");

			authStorage.remove("anthropic");

			expect(authStorage.getAuthStatus("anthropic")).toEqual({
				configured: false,
				source: "stale",
				label: "expired",
			});
			await expect(authStorage.getApiKey("anthropic")).resolves.toBeUndefined();
		});

		test("changed command-backed stored key no longer matches stale auth marker", async () => {
			const tokenFile = join(tempDir, "command-token");
			writeFileSync(tokenFile, "stale-key");
			const tokenPath = toShPath(tokenFile);
			writeAuthJson({
				anthropic: { type: "api_key", key: `!sh -c 'cat "${tokenPath}"'` },
			});

			authStorage = AuthStorage.create(authJsonPath);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("stale-key");
			expect(authStorage.markAuthStale("anthropic")).toBe(true);
			expect(authStorage.hasAuth("anthropic")).toBe(false);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBeUndefined();

			writeFileSync(tokenFile, "fresh-key");

			expect(authStorage.hasAuth("anthropic")).toBe(true);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("fresh-key");
			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
		});

		describe("Prime Inference isolation", () => {
			let primeConfigPath: string;
			const team = { teamId: "agent-team", name: "Agent Research", role: "admin" };

			beforeEach(() => {
				vi.stubEnv("PRIME_API_KEY", undefined);
				vi.stubEnv("PRIME_TEAM_ID", undefined);
				primeConfigPath = join(tempDir, "prime-config.json");
				writeFileSync(
					primeConfigPath,
					JSON.stringify({ api_key: "cli-key", team_id: "cli-team", base_url: "http://localhost:8000" }),
				);
			});

			afterEach(() => {
				vi.unstubAllEnvs();
			});

			function createStorage() {
				return AuthStorage.create(authJsonPath, {
					primeCliConfigPath: primeConfigPath,
					usePrimeCliConfig: true,
				});
			}

			test("CLI-only credentials never count as Agent auth", async () => {
				authStorage = createStorage();
				await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
				expect(authStorage.hasAuth("prime-inference")).toBe(false);
				expect(authStorage.getAuthStatus("prime-inference")).toEqual({ configured: false });
				expect(authStorage.getCurrentAuthSourceToken("prime-inference")).toBeUndefined();
				expect(authStorage.markAuthStale("prime-inference")).toBe(false);
				expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
				expect(authStorage.getPrimeInferenceTeamSelection()).toBeUndefined();
			});

			test("stored auth and team survive CLI edits, corruption, removal, and Agent reload", async () => {
				writeAuthJson({ "prime-inference": { type: "api_key", key: "agent-key", primeTeam: team } });
				authStorage = createStorage();

				for (const config of [
					JSON.stringify({ api_key: "new-cli-key", team_id: "new-cli-team" }),
					"{invalid-json",
					undefined,
				]) {
					if (config === undefined) rmSync(primeConfigPath);
					else writeFileSync(primeConfigPath, config);
					authStorage.reload();
					await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("agent-key");
					expect(authStorage.getAuthStatus("prime-inference")).toEqual({ configured: true, source: "stored" });
					expect(authStorage.getPrimeInferenceTeamSelection()).toEqual(team);
					expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": team.teamId });
					expect(authStorage.drainErrors()).toEqual([]);
				}
			});

			test("runtime, environment, stored, and models fallback resolve in order without CLI", async () => {
				writeAuthJson({ "prime-inference": { type: "api_key", key: "agent-key", primeTeam: team } });
				authStorage = createStorage();
				authStorage.setFallbackResolver(() => "models-key");
				vi.stubEnv("PRIME_API_KEY", "env-key");
				authStorage.setRuntimeApiKey("prime-inference", "runtime-key");

				await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("runtime-key");
				expect(authStorage.getAuthStatus("prime-inference").source).toBe("runtime");
				expect(authStorage.getPrimeInferenceTeamSelection()).toBeUndefined();
				expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
				authStorage.removeRuntimeApiKey("prime-inference");
				await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("env-key");
				expect(authStorage.getAuthStatus("prime-inference")).toEqual({
					configured: false,
					source: "environment",
					label: "PRIME_API_KEY",
				});
				expect(authStorage.getPrimeInferenceTeamSelection()).toBeUndefined();
				expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
				vi.stubEnv("PRIME_API_KEY", undefined);
				await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("agent-key");
				expect(authStorage.getAuthStatus("prime-inference").source).toBe("stored");
				authStorage.remove("prime-inference");
				await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("models-key");
				expect(authStorage.getAuthStatus("prime-inference").source).toBe("fallback");
				await expect(authStorage.getApiKey("prime-inference", { includeFallback: false })).resolves.toBeUndefined();
			});

			test.each([undefined, null])("missing or personal Agent team never inherits CLI team (%j)", (primeTeam) => {
				writeAuthJson({ "prime-inference": { type: "api_key", key: "agent-key", primeTeam } });
				authStorage = createStorage();
				expect(authStorage.getPrimeInferenceTeamSelection()).toBe(primeTeam);
				expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
			});

			test("PRIME_TEAM_ID overrides headers without changing the stored selection", () => {
				writeAuthJson({ "prime-inference": { type: "api_key", key: "agent-key", primeTeam: team } });
				authStorage = createStorage();
				vi.stubEnv("PRIME_TEAM_ID", "env-team");
				expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "env-team" });
				expect(authStorage.getPrimeInferenceTeamSelection()).toBeUndefined();
				vi.stubEnv("PRIME_TEAM_ID", undefined);
				expect(authStorage.getPrimeInferenceTeamSelection()).toEqual(team);
				expect(authStorage.get("prime-inference")).toMatchObject({ primeTeam: team });
			});

			test("CLI edits cannot revive stale Agent auth or replace its cached team", async () => {
				writeAuthJson({ "prime-inference": { type: "api_key", key: "agent-key", primeTeam: team } });
				authStorage = createStorage();
				expect(authStorage.markAuthStale("prime-inference")).toBe(true);
				writeFileSync(primeConfigPath, JSON.stringify({ api_key: "fresh-cli-key", team_id: "new-cli-team" }));
				expect(authStorage.hasAuth("prime-inference")).toBe(false);
				await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
				expect(authStorage.getAuthStatus("prime-inference")).toEqual({
					configured: false,
					source: "stale",
					label: "expired",
				});
				expect(authStorage.getPrimeInferenceTeamSelection()).toEqual(team);
				authStorage.setPrimeInferenceTeamSelection(null);
				await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
				expect(authStorage.getAuthStatus("prime-inference").source).toBe("stale");
				expect(createStorage().getPrimeInferenceTeamSelection()).toBeNull();
				authStorage.setPrimeInferenceApiKey("fresh-agent-key");
				await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("fresh-agent-key");
				expect(authStorage.getAuthStatus("prime-inference")).toEqual({ configured: true, source: "stored" });
			});

			test("saving an Agent key does not revive stale runtime or environment credentials", async () => {
				authStorage = createStorage();
				vi.stubEnv("PRIME_API_KEY", "env-key");
				authStorage.setRuntimeApiKey("prime-inference", "runtime-key");
				expect(authStorage.markAuthStale("prime-inference")).toBe(true);
				expect(authStorage.markAuthStale("prime-inference")).toBe(true);
				authStorage.setPrimeInferenceApiKey("agent-key");
				await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("agent-key");
				authStorage.remove("prime-inference");
				await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
				vi.stubEnv("PRIME_API_KEY", "fresh-env-key");
				await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("fresh-env-key");
			});

			test("login preserves, clears, or replaces team according to key and explicit selection", () => {
				writeAuthJson({ "prime-inference": { type: "api_key", key: "agent-key", primeTeam: team } });
				authStorage = createStorage();
				authStorage.setPrimeInferenceApiKey("agent-key");
				expect(createStorage().getPrimeInferenceTeamSelection()).toEqual(team);
				authStorage.setPrimeInferenceApiKey("different-key");
				expect(createStorage().get("prime-inference")).toEqual({
					type: "api_key",
					key: "different-key",
					primeTeam: null,
				});
				authStorage.setPrimeInferenceApiKey("imported-key", team);
				expect(createStorage().getPrimeInferenceTeamSelection()).toEqual(team);
				authStorage.setPrimeInferenceApiKey("imported-key", null);
				expect(createStorage().getPrimeInferenceTeamSelection()).toBeNull();
			});

			test.each(["existing", "missing", "directory"])(
				"Agent login, team, and logout leave %s CLI config unchanged",
				async (state) => {
					if (state !== "existing") rmSync(primeConfigPath);
					if (state === "directory") mkdirSync(primeConfigPath);
					const cliState = () => {
						if (!existsSync(primeConfigPath)) return undefined;
						return statSync(primeConfigPath).isDirectory() ? "directory" : readFileSync(primeConfigPath, "utf8");
					};
					const cliBefore = cliState();
					authStorage = createStorage();
					authStorage.setPrimeInferenceApiKey("agent-key", team);
					expect(cliState()).toBe(cliBefore);
					expect(statSync(authJsonPath).mode & 0o777).toBe(0o600);
					const reopened = createStorage();
					await expect(reopened.getApiKey("prime-inference")).resolves.toBe("agent-key");
					expect(reopened.getPrimeInferenceTeamSelection()).toEqual(team);
					authStorage.setPrimeInferenceTeamSelection({ teamId: "new-team", name: "New Team" });
					expect(createStorage().getPrimeInferenceTeamSelection()?.teamId).toBe("new-team");
					expect(cliState()).toBe(cliBefore);
					authStorage.setPrimeInferenceTeamSelection(null);
					expect(createStorage().getPrimeInferenceTeamSelection()).toBeNull();
					expect(cliState()).toBe(cliBefore);
					authStorage.logout("prime-inference");
					expect(createStorage().has("prime-inference")).toBe(false);
					await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
					expect(cliState()).toBe(cliBefore);
					expect(authStorage.drainErrors()).toEqual([]);
				},
			);

			test("key and team changes merge the current disk credential, not a stale instance", () => {
				writeAuthJson({ "prime-inference": { type: "api_key", key: "agent-key", primeTeam: team } });
				authStorage = createStorage();
				const peer = createStorage();
				const peerTeam = { teamId: "peer-team", name: "Peer Team" };
				peer.setPrimeInferenceTeamSelection(peerTeam);
				authStorage.setPrimeInferenceApiKey("agent-key");
				expect(createStorage().getPrimeInferenceTeamSelection()).toEqual(peerTeam);
				peer.setPrimeInferenceApiKey("peer-key", team);
				authStorage.setPrimeInferenceTeamSelection(peerTeam);
				expect(createStorage().get("prime-inference")).toEqual({
					type: "api_key",
					key: "peer-key",
					primeTeam: peerTeam,
				});
			});

			test.each(["rotation", "logout"])("stale team picker cannot overwrite credentials after peer %s", (change) => {
				writeAuthJson({ "prime-inference": { type: "api_key", key: "old-key", primeTeam: team } });
				authStorage = createStorage();
				const peer = createStorage();
				const newTeam = { teamId: "new-team", name: "New Team" };
				if (change === "rotation") peer.setPrimeInferenceApiKey("new-key", newTeam);
				else peer.logout("prime-inference");

				for (const selection of [{ teamId: "stale-team", name: "Stale Team" }, null]) {
					authStorage.setPrimeInferenceTeamSelection(selection, "old-key");
					expect(createStorage().get("prime-inference")).toEqual(
						change === "rotation" ? { type: "api_key", key: "new-key", primeTeam: newTeam } : undefined,
					);
				}
			});

			test.each(["login", "team", "logout"])(
				"failed %s leaves disk, memory, stale state, and CLI unchanged",
				async (operation) => {
					const credential = { type: "api_key", key: "agent-key", primeTeam: team };
					writeAuthJson({ "prime-inference": credential });
					authStorage = createStorage();
					const beforeAuth = readFileSync(authJsonPath, "utf8");
					const beforeCli = readFileSync(primeConfigPath, "utf8");
					expect(authStorage.markAuthStale("prime-inference")).toBe(true);
					renameFault.error = new Error("disk full");
					try {
						expect(() => {
							if (operation === "login") authStorage.setPrimeInferenceApiKey("new-key");
							else if (operation === "team") authStorage.setPrimeInferenceTeamSelection(null);
							else authStorage.logout("prime-inference");
						}).toThrow("disk full");
					} finally {
						renameFault.error = undefined;
					}
					expect(authStorage.get("prime-inference")).toEqual(credential);
					expect(readFileSync(authJsonPath, "utf8")).toBe(beforeAuth);
					expect(readFileSync(primeConfigPath, "utf8")).toBe(beforeCli);
					await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
					expect(authStorage.getAuthStatus("prime-inference").source).toBe("stale");
				},
			);

			test.each(["[]", "null", '"fake-secret"', "1", "true", "{"])(
				"invalid Agent auth rejects startup and verified login without changing disk: %s",
				(content) => {
					writeFileSync(authJsonPath, content);
					authStorage = createStorage();
					expect(authStorage.drainErrors()).toHaveLength(1);
					expect(authStorage.list()).toEqual([]);
					expect(() => authStorage.setPrimeInferenceApiKey("replacement")).toThrow();
					expect(readFileSync(authJsonPath, "utf8")).toBe(content);
					expect(authStorage.list()).toEqual([]);
				},
			);

			test("late invalid auth preserves stale identity through failed changes and permits repaired-file retry", () => {
				const credential = { type: "api_key", key: "agent-key", primeTeam: team };
				writeAuthJson({ "prime-inference": credential });
				authStorage = createStorage();
				expect(authStorage.markAuthStale("prime-inference")).toBe(true);
				writeFileSync(authJsonPath, "[]");
				for (const change of [
					() => authStorage.setPrimeInferenceApiKey("replacement"),
					() => authStorage.setPrimeInferenceTeamSelection(null, "agent-key"),
					() => authStorage.logout("prime-inference"),
				]) {
					expect(change).toThrow();
					expect(readFileSync(authJsonPath, "utf8")).toBe("[]");
					expect(authStorage.get("prime-inference")).toEqual(credential);
					expect(authStorage.getAuthStatus("prime-inference").source).toBe("stale");
				}
				authStorage.reload();
				expect(authStorage.get("prime-inference")).toEqual(credential);
				expect(authStorage.getAuthStatus("prime-inference").source).toBe("stale");
				writeAuthJson({});
				authStorage.setPrimeInferenceApiKey("repaired-key");
				expect(authStorage.getAuthStatus("prime-inference")).toEqual({ configured: true, source: "stored" });
				expect(createStorage().get("prime-inference")).toEqual({
					type: "api_key",
					key: "repaired-key",
					primeTeam: null,
				});
			});
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo 'hello world' | tr ' ' '-'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("hello-world");
		});

		describe("caching", () => {
			test("command is only executed once per process", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("cache persists across AuthStorage instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				const storage1 = AuthStorage.create(authJsonPath);
				await storage1.getApiKey("anthropic");

				const storage2 = AuthStorage.create(authJsonPath);
				await storage2.getApiKey("anthropic");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("different commands are cached separately", async () => {
				writeAuthJson({
					anthropic: { type: "api_key", key: "!echo key-anthropic" },
					openai: { type: "api_key", key: "!echo key-openai" },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const keyA = await authStorage.getApiKey("anthropic");
				const keyB = await authStorage.getApiKey("openai");

				expect(keyA).toBe("key-anthropic");
				expect(keyB).toBe("key-openai");
			});

			test("failed commands are cached (not retried)", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const key1 = await authStorage.getApiKey("anthropic");
				const key2 = await authStorage.getApiKey("anthropic");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_AUTH_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeAuthJson({
						anthropic: { type: "api_key", key: envVarName },
					});

					authStorage = AuthStorage.create(authJsonPath);

					const key1 = await authStorage.getApiKey("anthropic");
					expect(key1).toBe("first-value");

					process.env[envVarName] = "second-value";

					const key2 = await authStorage.getApiKey("anthropic");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});
	});

	describe("oauth lock compromise handling", () => {
		test("returns undefined on compromised lock and allows a later retry", async () => {
			const providerId = `test-oauth-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					return {
						...credentials,
						access: "refreshed-access-token",
						expires: Date.now() + 60_000,
					};
				},
				getApiKey(credentials) {
					return `Bearer ${credentials.access}`;
				},
			});

			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "expired-access-token",
					expires: Date.now() - 10_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			const realLock = lockfile.lock.bind(lockfile);
			const lockSpy = vi.spyOn(lockfile, "lock");
			lockSpy.mockImplementationOnce(async (file, options) => {
				options?.onCompromised?.(new Error("Unable to update lock within the stale threshold"));
				return realLock(file, options);
			});

			const firstTry = await authStorage.getApiKey(providerId);
			expect(firstTry).toBeUndefined();

			lockSpy.mockRestore();

			const secondTry = await authStorage.getApiKey(providerId);
			expect(secondTry).toBe("Bearer refreshed-access-token");
		});
	});

	describe("persistence semantics", () => {
		test("completes a short initial write before loading and saving credentials", () => {
			initialWriteFault.count = 1;
			try {
				authStorage = AuthStorage.create(authJsonPath);
			} finally {
				initialWriteFault.count = -1;
			}

			expect(authStorage.drainErrors()).toEqual([]);
			expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({});
			authStorage.set("openai", { type: "api_key", key: "new-key" });
			expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toMatchObject({
				openai: { type: "api_key", key: "new-key" },
			});
		});

		test("fails initial writes that make no progress before exposing storage", () => {
			const backend = new FileAuthStorageBackend(authJsonPath);
			const consume = vi.fn(() => ({ result: undefined }));
			initialWriteFault.count = 0;
			try {
				expect(() => backend.withLock(consume)).toThrow(/Short write/);
				expect(consume).not.toHaveBeenCalled();
			} finally {
				initialWriteFault.count = -1;
			}
		});

		test("first-run initialization survives a restrictive umask", () => {
			const previousUmask = process.umask(0o700);
			try {
				authStorage = AuthStorage.create(authJsonPath);
				authStorage.set("openai", { type: "api_key", key: "masked-key" });
			} finally {
				process.umask(previousUmask);
			}

			expect(statSync(authJsonPath).mode & 0o777).toBe(0o600);
			const onDisk = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(onDisk.openai.key).toBe("masked-key");
		});

		test.each([
			[
				"an existing target",
				(): { alias: string; target: string } => {
					const target = join(tempDir, "real-auth.json");
					writeFileSync(target, "{}");
					rmSync(authJsonPath, { force: true });
					symlinkSync(target, authJsonPath);
					return { alias: authJsonPath, target };
				},
			],
			[
				"a dangling absolute target",
				(): { alias: string; target: string } => {
					const target = join(tempDir, "vault", "auth.json");
					mkdirSync(join(tempDir, "vault"), { recursive: true });
					symlinkSync(target, authJsonPath);
					return { alias: authJsonPath, target };
				},
			],
			[
				"a dangling relative target under a symlinked directory",
				(): { alias: string; target: string } => {
					const realDir = join(tempDir, "real-dir");
					mkdirSync(realDir, { recursive: true });
					const aliasDir = join(tempDir, "alias-dir");
					symlinkSync(realDir, aliasDir);
					symlinkSync("./credentials.json", join(aliasDir, "auth.json"));
					return { alias: join(aliasDir, "auth.json"), target: join(realDir, "credentials.json") };
				},
			],
		])("writes through a symlinked auth.json (%s) with the alias intact", (_name, setup) => {
			const { alias, target } = setup();
			authStorage = AuthStorage.create(alias);

			authStorage.set("openai", { type: "api_key", key: "through-alias" });

			expect(lstatSync(alias).isSymbolicLink()).toBe(true);
			const real = JSON.parse(readFileSync(target, "utf-8")) as Record<string, { key: string }>;
			expect(real.openai.key).toBe("through-alias");
		});

		test("initialization never replaces credentials another process already saved", () => {
			authStorage = AuthStorage.create(authJsonPath);
			// A rival process persists credentials between the absence check and the write.
			writeAuthJson({ anthropic: { type: "api_key", key: "already-saved" } });
			absenceIllusion.paths.add(authJsonPath);

			try {
				const backend = (authStorage as unknown as { storage: { ensureFileExists(): void } }).storage;
				backend.ensureFileExists();
			} finally {
				absenceIllusion.paths.delete(authJsonPath);
			}

			const onDisk = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(onDisk.anthropic.key).toBe("already-saved");
		});

		test("a write failing at the replace boundary leaves the previous credentials intact", () => {
			writeAuthJson({ anthropic: { type: "api_key", key: "old-key" } });
			authStorage = AuthStorage.create(authJsonPath);
			renameFault.error = new Error("disk full");

			try {
				authStorage.set("anthropic", { type: "api_key", key: "new-key" });
			} finally {
				renameFault.error = undefined;
			}

			expect(authStorage.drainErrors().map((error) => String(error))).toEqual([
				expect.stringContaining("disk full"),
			]);
			const onDisk = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(onDisk.anthropic.key).toBe("old-key");
		});

		test("set preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.set("anthropic", { type: "api_key", key: "new-anthropic" });

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic.key).toBe("new-anthropic");
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("remove preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.remove("anthropic");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic).toBeUndefined();
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("does not overwrite malformed auth file after load error", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();
			authStorage.set("openai", { type: "api_key", key: "openai-key" });

			const raw = readFileSync(authJsonPath, "utf-8");
			expect(raw).toBe("{invalid-json");
		});

		test("removeVerified deletes from disk and memory", () => {
			writeAuthJson({
				"mcp:remote": { type: "api_key", key: "token" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.removeVerified("mcp:remote");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
			expect(updated["mcp:remote"]).toBeUndefined();
			expect(authStorage.get("mcp:remote")).toBeUndefined();
			expect((updated.openai as { key: string }).key).toBe("openai-key");
		});

		test("removeVerified throws while the credential may still exist on disk", () => {
			writeAuthJson({
				"mcp:remote": { type: "api_key", key: "token" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			expect(() => authStorage.removeVerified("mcp:remote")).toThrow();
		});

		test("reload records parse errors and drainErrors clears buffer", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();

			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });

			const firstDrain = authStorage.drainErrors();
			expect(firstDrain.length).toBeGreaterThan(0);
			expect(firstDrain[0]).toBeInstanceOf(Error);

			const secondDrain = authStorage.drainErrors();
			expect(secondDrain).toHaveLength(0);
		});
	});

	describe("auth status", () => {
		test("does not expose stored API keys or OAuth tokens", () => {
			authStorage = AuthStorage.inMemory({
				anthropic: { type: "api_key", key: "secret-api-key" },
				openai: {
					type: "oauth",
					access: "secret-access-token",
					refresh: "secret-refresh-token",
					expires: Date.now() + 1000,
				},
			});

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			expect(authStorage.getAuthStatus("openai")).toEqual({ configured: true, source: "stored" });
			expect(JSON.stringify(authStorage.getAuthStatus("anthropic"))).not.toContain("secret-api-key");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-access-token");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-refresh-token");
		});
	});

	describe("runtime overrides", () => {
		test("runtime override takes priority over auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("runtime-key");
		});

		test("removing runtime override falls back to auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			authStorage.removeRuntimeApiKey("anthropic");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("stored-key");
		});
	});
});
