import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeApiKeyChainCredential } from "./auth-storage.js";

const OPENAI_CODEX_PROVIDER = "openai-codex";

export interface CodexHomeAuthResult {
	configuredHomes: string[];
	loadedHomes: string[];
}

function expandHomePath(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	return resolve(trimmed);
}

function readAccessToken(home: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || !("tokens" in parsed)) return undefined;
		const tokens = (parsed as { tokens?: unknown }).tokens;
		if (!tokens || typeof tokens !== "object" || !("access_token" in tokens)) return undefined;
		const accessToken = (tokens as { access_token?: unknown }).access_token;
		return typeof accessToken === "string" && accessToken.trim() ? accessToken.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** Load configured Codex CLI credentials into an ordered process-local chain. */
export function applyCodexHomes(
	authTarget: { setRuntimeApiKeyChain(provider: string, credentials: readonly RuntimeApiKeyChainCredential[]): void },
	configuredHomes: readonly string[],
): CodexHomeAuthResult {
	const homes = [...new Set(configuredHomes.map(expandHomePath))];
	const loadedHomes: string[] = [];
	const credentials: RuntimeApiKeyChainCredential[] = [];
	for (const home of homes) {
		const key = readAccessToken(home);
		if (!key) continue;
		loadedHomes.push(home);
		credentials.push({ key, label: home });
	}
	authTarget.setRuntimeApiKeyChain(OPENAI_CODEX_PROVIDER, credentials);
	return { configuredHomes: homes, loadedHomes };
}
