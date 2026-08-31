import { lstatSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { AuthStorage, type AuthStorageData } from "./auth-storage.js";

export const PRIME_AGENT_EPHEMERAL_AUTH_FILE_ENV = "PRIME_AGENT_EPHEMERAL_AUTH_FILE";

const cachedEphemeralAuth = new Map<string, AuthStorageData>();

function readEphemeralAuthFile(path: string): AuthStorageData {
	try {
		const metadata = lstatSync(path);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error(`ephemeral auth source must be a regular file: ${path}`);
		}
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`ephemeral auth source must contain a JSON object: ${path}`);
		}
		return parsed as AuthStorageData;
	} finally {
		rmSync(path, { force: true });
	}
}

export function createAgentAuthStorage(options: {
	authPath: string;
	usePrimeCliConfig: boolean;
	environment?: NodeJS.ProcessEnv;
}): AuthStorage {
	const ephemeralPath = options.environment?.[PRIME_AGENT_EPHEMERAL_AUTH_FILE_ENV]?.trim();
	if (!ephemeralPath) {
		return AuthStorage.create(options.authPath, { usePrimeCliConfig: options.usePrimeCliConfig });
	}

	const normalizedPath = resolve(ephemeralPath);
	let data = cachedEphemeralAuth.get(normalizedPath);
	if (!data) {
		data = readEphemeralAuthFile(normalizedPath);
		cachedEphemeralAuth.set(normalizedPath, data);
	}
	return AuthStorage.inMemory(data, { usePrimeCliConfig: false });
}
