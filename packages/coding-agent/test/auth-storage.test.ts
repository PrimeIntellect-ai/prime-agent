import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { AuthStorage, FileAuthStorageBackend } from "../src/core/auth-storage.js";
import { InProcessAgentConnection } from "../src/modes/agent-connection/in-process-agent-connection.js";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.js";

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
		// Single pass: backslashes become separators and quotes are escaped, so no
		// escape sequence can be produced and then re-escaped by a later pass.
		return value.replace(/[\\"]/g, (ch) => (ch === "\\" ? "/" : '\\"'));
	}

	describe("API key resolution", () => {
		test("resolves stored keys as literals or environment variable names", async () => {
			const envVar = "TEST_AUTH_API_KEY_12345";
			const previous = process.env[envVar];
			process.env[envVar] = "env-api-key-value";
			delete process.env.literal_api_key_value;
			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "sk-ant-literal-key" },
					openai: { type: "api_key", key: envVar },
					google: { type: "api_key", key: "literal_api_key_value" },
				});

				authStorage = AuthStorage.create(authJsonPath);

				await expect(authStorage.getApiKey("anthropic")).resolves.toBe("sk-ant-literal-key");
				await expect(authStorage.getApiKey("openai")).resolves.toBe("env-api-key-value");
				await expect(authStorage.getApiKey("google")).resolves.toBe("literal_api_key_value");
			} finally {
				if (previous === undefined) delete process.env[envVar];
				else process.env[envVar] = previous;
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

			test("CLI-only credentials never count as Agent auth, and Agent writes never touch the CLI config", async () => {
				authStorage = createStorage();
				const cliBefore = readFileSync(primeConfigPath, "utf8");
				await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
				expect(authStorage.hasAuth("prime-inference")).toBe(false);
				expect(authStorage.getAuthStatus("prime-inference")).toEqual({ configured: false });
				expect(authStorage.getCurrentAuthSourceToken("prime-inference")).toBeUndefined();
				expect(authStorage.markAuthStale("prime-inference")).toBe(false);
				expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
				expect(authStorage.getPrimeInferenceTeamSelection()).toBeUndefined();

				authStorage.setPrimeInferenceApiKey("agent-key", team);
				expect(statSync(authJsonPath).mode & 0o777).toBe(0o600);
				await expect(createStorage().getApiKey("prime-inference")).resolves.toBe("agent-key");
				authStorage.logout("prime-inference");
				expect(createStorage().has("prime-inference")).toBe(false);
				expect(readFileSync(primeConfigPath, "utf8")).toBe(cliBefore);
				expect(authStorage.drainErrors()).toEqual([]);
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

		describe("caching", () => {
			test.each([
				{ name: "successful command runs once per process and across instances", fails: false },
				{ name: "failed command is cached, never retried", fails: true },
			])("$name", async ({ fails }) => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");
				const counterPath = toShPath(counterFile);
				const tail = fails ? "exit 1" : 'echo "key-value"';
				writeAuthJson({
					anthropic: {
						type: "api_key",
						key: `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; ${tail}'`,
					},
					openai: { type: "api_key", key: "!echo key-openai" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const expected = fails ? undefined : "key-value";
				await expect(authStorage.getApiKey("anthropic")).resolves.toBe(expected);
				await expect(authStorage.getApiKey("anthropic")).resolves.toBe(expected);
				// A second instance shares the process-wide command cache.
				await expect(AuthStorage.create(authJsonPath).getApiKey("anthropic")).resolves.toBe(expected);
				// Distinct commands are cached under distinct keys.
				await expect(authStorage.getApiKey("openai")).resolves.toBe("key-openai");

				expect(parseInt(readFileSync(counterFile, "utf-8").trim(), 10)).toBe(1);
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

		test.each(["set", "remove"])("%s preserves unrelated external edits", (operation) => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Another process adds a provider after this instance loaded the file.
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			if (operation === "set") authStorage.set("anthropic", { type: "api_key", key: "new-anthropic" });
			else authStorage.remove("anthropic");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic?.key).toBe(operation === "set" ? "new-anthropic" : undefined);
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
		test("runtime override takes priority over auth.json until it is removed", async () => {
			writeAuthJson({ anthropic: { type: "api_key", key: "!echo stored-key" } });

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("runtime-key");

			authStorage.removeRuntimeApiKey("anthropic");
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("stored-key");
		});
	});

	describe("atomic conditional credential writes", () => {
		function credential(access: string): { type: "oauth"; access: string; refresh: string; expires: number } {
			return {
				type: "oauth",
				access,
				refresh: "r",
				expires: Date.now() + 3600_000,
			};
		}

		test("moveStagedCredential refuses to clobber a bystander written by ANOTHER instance", () => {
			const clientA = AuthStorage.create(authJsonPath);
			const clientB = AuthStorage.create(authJsonPath);
			// A stages its login...
			const staged = credential("staged-for-attempt");
			const bystander = credential("ordinary-login");
			clientA.set("mcp:acme-2--attempt-1", staged);
			// ...then B's ordinary login writes the real key: A's per-instance
			// cache cannot see it, so only a fresh on-disk read can refuse.
			clientB.set("mcp:acme-2", bystander);

			const move = clientA.moveStagedCredential("mcp:acme-2--attempt-1", "mcp:acme-2");

			expect(move).toEqual({ status: "occupied" });
			// A fresh reader sees the bystander byte-for-byte; the staged key survives.
			const fresh = AuthStorage.create(authJsonPath);
			expect(fresh.get("mcp:acme-2")).toEqual(bystander);
			expect(fresh.get("mcp:acme-2--attempt-1")).toEqual(staged);
		});

		test("moveStagedCredential moves atomically when the real key is empty on disk", () => {
			const clientA = AuthStorage.create(authJsonPath);
			const clientB = AuthStorage.create(authJsonPath);
			const staged = credential("staged-for-attempt");
			clientA.set("mcp:acme-2--attempt-1", staged);
			// B (a generic /logout in another client) removes the real key: the
			// fresh on-disk read inside the move sees the honest empty state.
			clientB.logout("mcp:acme-2");

			const move = clientA.moveStagedCredential("mcp:acme-2--attempt-1", "mcp:acme-2");

			expect(move.status).toBe("moved");
			if (move.status === "moved") {
				expect(move.credential).toEqual(staged);
			}
			const fresh = AuthStorage.create(authJsonPath);
			expect(fresh.get("mcp:acme-2")).toEqual(staged);
			expect(fresh.list()).toEqual(["mcp:acme-2"]);
		});

		test("removeIfCredentialMatches deletes ONLY the exact own credential", () => {
			const clientA = AuthStorage.create(authJsonPath);
			const clientB = AuthStorage.create(authJsonPath);
			clientA.set("mcp:acme-2", credential("mine"));
			// B replaces the credential with a NEWER one after our move: the exact-own check must refuse to delete it.
			const newer = credential("newer-login");
			clientB.set("mcp:acme-2", newer);

			const removedStale = clientA.removeIfCredentialMatches("mcp:acme-2", credential("mine"));
			const removedNewer = clientB.removeIfCredentialMatches("mcp:acme-2", newer);

			expect(removedStale).toBe(false);
			expect(removedNewer).toBe(true);
			expect(AuthStorage.create(authJsonPath).list()).toEqual([]);
		});

		test("replaceStagedCredential refuses when the expected old credential was deleted (absence is a change)", () => {
			// Full-identity CAS: the captured expected-old must match the CURRENT on-disk value INCLUDING absence. A nonempty
			// expectedOld with an ABSENT real slot is a CHANGED value — the replace must refuse, not treat the emptied slot as
			// free.
			const clientA = AuthStorage.create(authJsonPath);
			const expectedOld = credential("previous-credential");
			clientA.set("mcp:acme-2", expectedOld);
			const captured = clientA.getVerified("mcp:acme-2");
			expect(captured).toBeDefined();
			// Another client deletes the real credential while our attempt is in flight.
			AuthStorage.create(authJsonPath).removeVerified("mcp:acme-2");
			const stagedKey = "mcp:acme-2--attempt-1";
			clientA.set(stagedKey, credential("our-credential"));

			const move = clientA.replaceStagedCredential(stagedKey, "mcp:acme-2", captured);

			expect(move.status, "a deleted expected-old value must refuse the replace").toBe("occupied");
			const fresh = AuthStorage.create(authJsonPath);
			expect(fresh.get("mcp:acme-2"), "nothing may land on the changed slot").toBeUndefined();
			expect(fresh.get(stagedKey), "our staged credential must stay staged").toBeDefined();
		});

		test("restoreCredentialIfAbsent never overwrites a newer writer", () => {
			const clientA = AuthStorage.create(authJsonPath);
			const clientB = AuthStorage.create(authJsonPath);
			clientA.set("mcp:acme-2--attempt-1", credential("staged-for-attempt"));
			const newer = credential("newer-login");
			clientB.set("mcp:acme-2--attempt-1", newer);

			const restored = clientA.restoreCredentialIfAbsent("mcp:acme-2--attempt-1", credential("staged-for-attempt"));

			expect(restored).toBe(false);
			expect(AuthStorage.create(authJsonPath).get("mcp:acme-2--attempt-1")).toEqual(newer);
		});
	});
});

function structuredFailureMessage(kind: string, status: number, errorMessage: string): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		diagnostics: [{ type: "provider_stream_failure", timestamp: Date.now(), details: { kind, status } }],
	};
}

const provider401Message = () => structuredFailureMessage("auth", 401, "401 Unauthorized: invalid API key");
const provider500Message = () => structuredFailureMessage("server_error", 500, "500 Internal Server Error");
const unstructured401Message = () =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 status code (no body)" });

interface StaleAuthCase {
	name: string;
	settings: HarnessOptions["settings"];
	responses: () => AssistantMessage[];
	calls: number;
	retryAttempts: number[];
	stale: boolean;
}

const staleAuthCases: StaleAuthCase[] = [
	{
		name: "structured 401 retries once, then marks the current auth stale",
		settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		responses: () => [provider401Message(), provider401Message(), provider401Message()],
		calls: 2,
		retryAttempts: [1],
		stale: true,
	},
	{
		name: "unstructured 401 error text does not mark auth stale",
		settings: { retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 } },
		responses: () => [unstructured401Message()],
		calls: 1,
		retryAttempts: [],
		stale: false,
	},
	{
		name: "structured permission (403) failures do not mark auth stale",
		settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		responses: () => [
			structuredFailureMessage("permission", 403, "403 model access denied by organization policy"),
			fauxAssistantMessage("unused"),
		],
		calls: 1,
		retryAttempts: [],
		stale: false,
	},
	{
		// Wait-for-usage is disabled so quick-retry exhaustion stays terminal here.
		name: "a captured auth failure stays stale when the final retryable error is not auth",
		settings: {
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, provider: { waitForUsage: { enabled: false } } },
		},
		responses: () => [provider401Message(), provider500Message(), provider500Message()],
		calls: 3,
		retryAttempts: [1, 2],
		stale: true,
	},
	{
		name: "concrete auth failures are marked stale when retry is disabled",
		settings: { retry: { enabled: false } },
		responses: () => [provider401Message()],
		calls: 1,
		retryAttempts: [],
		stale: true,
	},
];

describe("issue #4491 provider auth stale after repeated 401", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	/** The harness configures two auth sources; mark both so the provider is fully locked out. */
	function lockOutProvider(harness: Harness, provider: string): void {
		const registry = harness.session.modelRegistry;
		for (let i = 0; i < 2 && registry.getProviderAuthStatus(provider).source !== "stale"; i++) {
			expect(registry.markProviderAuthStale(provider)).toBe(true);
		}
		expect(registry.getProviderAuthStatus(provider)).toMatchObject({ configured: false, source: "stale" });
	}

	test.each(staleAuthCases)("$name", async ({ settings, responses, calls, retryAttempts, stale }) => {
		const harness = await createHarness({ settings });
		harnesses.push(harness);
		harness.setResponses(responses());

		await harness.session.prompt("hello");

		const provider = harness.getModel().provider;
		expect(harness.faux.state.callCount).toBe(calls);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual(retryAttempts);
		expect(harness.eventsOfType("auth_stale")).toHaveLength(stale ? 1 : 0);
		expect(harness.authStorage.hasAuth(provider)).toBe(!stale);
		if (stale) {
			expect(harness.authStorage.getAuthStatus(provider)).toEqual({
				configured: false,
				source: "stale",
				label: "expired",
			});
			await expect(harness.authStorage.getApiKey(provider)).resolves.toBeUndefined();
		}
	});

	test("emits stale auth source tokens for daemon clients after a structured 401", async () => {
		const harness = await createHarness({
			provider: "prime-inference",
			settings: { retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([provider401Message()]);

		await harness.session.prompt("hello");

		const authStaleEvents = harness.eventsOfType("auth_stale");
		expect(authStaleEvents).toHaveLength(1);
		expect(authStaleEvents[0]?.provider).toBe("prime-inference");
		expect(authStaleEvents[0]?.sourceTokens).toMatchObject([{ provider: "prime-inference", source: "runtime" }]);
		expect(harness.authStorage.getAuthStatus("prime-inference")).toEqual({
			configured: false,
			source: "stale",
			label: "expired",
		});
	});

	test("marks captured auth failures stale when retry backoff is cancelled", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 } },
		});
		harnesses.push(harness);
		harness.setResponses([provider401Message(), provider401Message()]);
		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hello");
		await sawRetryStart;
		harness.session.abortRetry();
		await promptPromise;

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auth_stale")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).toContain("Retry cancelled");
		await expect(harness.authStorage.getApiKey(harness.getModel().provider)).resolves.toBeUndefined();
	});

	test("marks each failed auth source stale when credentials change during retry backoff", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 } },
		});
		harnesses.push(harness);
		harness.setResponses([provider401Message(), provider401Message()]);
		let changedCredentials = false;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && !changedCredentials) {
				changedCredentials = true;
				harness.authStorage.setRuntimeApiKey(harness.getModel().provider, "fresh-key");
			}
		});

		await harness.session.prompt("hello");

		expect(changedCredentials).toBe(true);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.authStorage.getAuthStatus(harness.getModel().provider)).toEqual({
			configured: false,
			source: "stale",
			label: "expired",
		});
		await expect(harness.authStorage.getApiKey(harness.getModel().provider)).resolves.toBeUndefined();
	});

	test("only a resolvable explicit model selection clears a stale-auth lockout", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const provider = harness.getModel().provider;
		lockOutProvider(harness, provider);
		const runtime = {
			session: harness.session,
			setRebindSession() {},
			setBeforeSessionInvalidate() {},
		} as unknown as AgentSessionRuntime;
		const connection = new InProcessAgentConnection(runtime);

		// A mistyped model id must not unlock the provider it failed to switch to.
		await expect(connection.setModel(provider, "not-a-model")).rejects.toThrow("Model not found");
		expect(harness.authStorage.hasAuth(provider)).toBe(false);
		expect(harness.session.modelRegistry.getProviderAuthStatus(provider)).toMatchObject({ source: "stale" });

		const model = harness.getModel();
		await connection.setModel(model.provider, model.id);

		expect(harness.authStorage.hasAuth(provider)).toBe(true);
		expect(harness.session.modelRegistry.getProviderAuthStatus(provider).source).not.toBe("stale");
	});
});
