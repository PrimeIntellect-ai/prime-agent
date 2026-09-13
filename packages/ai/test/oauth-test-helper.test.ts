import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_TESTS_ENV, resolveApiKey, TEST_AUTH_FILE_ENV } from "./oauth.js";

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof FsModule>();
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
		readFileSync: vi.fn(actual.readFileSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	};
});

import type * as FsModule from "fs";

const LEGACY_REFRESH = "SENTINEL-LEGACY-PI-REFRESH-5347";
const CURRENT_REFRESH = "SENTINEL-CURRENT-PRIME-REFRESH-5347";
const TEST_REFRESH = "SENTINEL-TEST-FILE-REFRESH-5347";

type FetchCall = { url: string; body: string | undefined };

let home: string;
let legacyStore: string;
let currentStore: string;
let testAuthFile: string;
let fetchCalls: FetchCall[];

function pathOf(arg: unknown): string {
	return typeof arg === "string" ? arg : String(arg);
}

function fsPaths(fn: typeof existsSync | typeof readFileSync | typeof writeFileSync): string[] {
	return vi.mocked(fn).mock.calls.map((call) => pathOf(call[0]));
}

function storePaths(paths: string[]): string[] {
	return paths.filter((p) => p.startsWith(join(home, ".pi")) || p.startsWith(join(home, ".prime")));
}

function clearFsCalls(): void {
	vi.mocked(existsSync).mockClear();
	vi.mocked(readFileSync).mockClear();
	vi.mocked(writeFileSync).mockClear();
}

function oauthEntry(refresh: string, expires: number) {
	return { type: "oauth", access: `${refresh}-ACCESS`, refresh, expires };
}

function snapshot(path: string) {
	return { content: readFileSync(path, "utf-8"), mode: statSync(path).mode & 0o777 };
}

describe("test OAuth credential helper", () => {
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "eng5347-home-"));
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(LIVE_TESTS_ENV, "");
		vi.stubEnv(TEST_AUTH_FILE_ENV, "");
		delete process.env[LIVE_TESTS_ENV];
		delete process.env[TEST_AUTH_FILE_ENV];

		legacyStore = join(home, ".pi", "agent", "auth.json");
		currentStore = join(home, ".prime", "agent", "auth.json");
		testAuthFile = join(home, "test-fixtures", "auth.json");
		for (const path of [legacyStore, currentStore, testAuthFile]) {
			mkdirSync(join(path, ".."), { recursive: true });
		}
		writeFileSync(legacyStore, JSON.stringify({ anthropic: oauthEntry(LEGACY_REFRESH, 1) }));
		chmodSync(legacyStore, 0o600);
		writeFileSync(currentStore, JSON.stringify({ anthropic: oauthEntry(CURRENT_REFRESH, 1) }));
		chmodSync(currentStore, 0o600);
		writeFileSync(
			testAuthFile,
			JSON.stringify({
				anthropic: oauthEntry(TEST_REFRESH, 1),
				openai: { type: "api_key", key: "sk-test-file-openai-5347" },
			}),
		);

		fetchCalls = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			fetchCalls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
			return new Response(
				JSON.stringify({
					access_token: "REFRESHED-ACCESS-5347",
					refresh_token: "REFRESHED-REFRESH-5347",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		clearFsCalls();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	it("does nothing without the opt-in, even when a test auth file is configured", async () => {
		vi.stubEnv(TEST_AUTH_FILE_ENV, testAuthFile);
		const legacyBefore = snapshot(legacyStore);
		const currentBefore = snapshot(currentStore);
		const testBefore = snapshot(testAuthFile);
		clearFsCalls();

		await expect(resolveApiKey("anthropic")).resolves.toBeUndefined();
		await expect(resolveApiKey("openai")).resolves.toBeUndefined();

		expect(fetchCalls).toEqual([]);
		expect(fsPaths(existsSync)).toEqual([]);
		expect(fsPaths(readFileSync)).toEqual([]);
		expect(fsPaths(writeFileSync)).toEqual([]);
		expect(snapshot(legacyStore)).toEqual(legacyBefore);
		expect(snapshot(currentStore)).toEqual(currentBefore);
		expect(snapshot(testAuthFile)).toEqual(testBefore);
	});

	it("does nothing with the opt-in when no test auth file is configured", async () => {
		vi.stubEnv(LIVE_TESTS_ENV, "1");

		await expect(resolveApiKey("anthropic")).resolves.toBeUndefined();

		expect(fetchCalls).toEqual([]);
		expect(fsPaths(existsSync)).toEqual([]);
		expect(fsPaths(readFileSync)).toEqual([]);
		expect(fsPaths(writeFileSync)).toEqual([]);
		expect(readFileSync(legacyStore, "utf-8")).toContain(LEGACY_REFRESH);
		expect(readFileSync(currentStore, "utf-8")).toContain(CURRENT_REFRESH);
	});

	it("reads only the test auth file with the opt-in and writes refreshed tokens back there only", async () => {
		vi.stubEnv(LIVE_TESTS_ENV, "1");
		vi.stubEnv(TEST_AUTH_FILE_ENV, testAuthFile);
		const legacyBefore = snapshot(legacyStore);
		const currentBefore = snapshot(currentStore);
		clearFsCalls();

		await expect(resolveApiKey("openai")).resolves.toBe("sk-test-file-openai-5347");
		expect(fetchCalls).toEqual([]);

		await expect(resolveApiKey("anthropic")).resolves.toBe("REFRESHED-ACCESS-5347");

		expect(fetchCalls).toHaveLength(1);
		expect(new URL(fetchCalls[0].url).host).toBe("platform.claude.com");
		expect(fetchCalls[0].body).toContain(TEST_REFRESH);
		expect(fetchCalls[0].body).not.toContain(LEGACY_REFRESH);
		expect(fetchCalls[0].body).not.toContain(CURRENT_REFRESH);

		expect(storePaths(fsPaths(existsSync))).toEqual([]);
		expect(storePaths(fsPaths(readFileSync))).toEqual([]);
		expect(fsPaths(readFileSync)).toEqual([testAuthFile, testAuthFile]);
		expect(fsPaths(writeFileSync)).toEqual([testAuthFile]);

		const testAfter = JSON.parse(readFileSync(testAuthFile, "utf-8"));
		expect(testAfter.anthropic.refresh).toBe("REFRESHED-REFRESH-5347");
		expect(testAfter.anthropic.access).toBe("REFRESHED-ACCESS-5347");
		expect(testAfter.openai).toEqual({ type: "api_key", key: "sk-test-file-openai-5347" });
		expect(statSync(testAuthFile).mode & 0o777).toBe(0o600);
		expect(snapshot(legacyStore)).toEqual(legacyBefore);
		expect(snapshot(currentStore)).toEqual(currentBefore);
	});

	it("refuses a test auth file that points at a real credential store", async () => {
		vi.stubEnv(LIVE_TESTS_ENV, "1");

		for (const store of [currentStore, legacyStore]) {
			vi.stubEnv(TEST_AUTH_FILE_ENV, store);
			await expect(resolveApiKey("anthropic")).rejects.toThrow(/dedicated test credential file/);
		}

		expect(fetchCalls).toEqual([]);
		expect(fsPaths(existsSync)).toEqual([]);
		expect(fsPaths(readFileSync)).toEqual([]);
		expect(fsPaths(writeFileSync)).toEqual([]);
		expect(readFileSync(legacyStore, "utf-8")).toContain(LEGACY_REFRESH);
		expect(readFileSync(currentStore, "utf-8")).toContain(CURRENT_REFRESH);
	});

	it("returns undefined for a missing test auth file without touching the real stores", async () => {
		vi.stubEnv(LIVE_TESTS_ENV, "1");
		const missing = join(home, "test-fixtures", "missing.json");
		vi.stubEnv(TEST_AUTH_FILE_ENV, missing);

		await expect(resolveApiKey("anthropic")).resolves.toBeUndefined();

		expect(fetchCalls).toEqual([]);
		expect(fsPaths(existsSync)).toEqual([missing]);
		expect(fsPaths(readFileSync)).toEqual([]);
		expect(fsPaths(writeFileSync)).toEqual([]);
	});
});
