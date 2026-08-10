/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import { createHash } from "node:crypto";
import {
	findEnvKeys,
	getEnvApiKey,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@earendil-works/pi-ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.js";
import {
	clearPrimeCliCredentials,
	getPrimeCliConfigPath,
	loadPrimeCliConfig,
	PRIME_INFERENCE_PROVIDER_ID,
	type PrimeCliConfig,
	type PrimeTeam,
	savePrimeCliApiKey,
	savePrimeCliTeamSelection,
} from "./prime-inference-auth.js";
import { resolveConfigValue, resolveConfigValueUncached } from "./resolve-config-value.js";

export type PrimeTeamCredential = {
	teamId: string;
	name: string;
	slug?: string;
	role?: string;
	createdAt?: string;
};

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
	primeTeam?: PrimeTeamCredential | null;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

export type AuthStatus = {
	configured: boolean;
	source?:
		| "stored"
		| "runtime"
		| "environment"
		| "prime_cli"
		| "fallback"
		| "models_json_key"
		| "models_json_command"
		| "stale";
	label?: string;
};

export type AuthStorageOptions = {
	primeCliConfigPath?: string;
	usePrimeCliConfig?: boolean;
};

type LockResult<T> = {
	result: T;
	next?: string;
};

type ActiveAuthStatusSource = Exclude<NonNullable<AuthStatus["source"]>, "stale">;

export type AuthSourceToken = {
	provider: string;
	source: ActiveAuthStatusSource;
	identityFingerprint: string;
	valueFingerprint: string;
};

type AuthSourceCandidate = {
	source: ActiveAuthStatusSource;
	configured: boolean;
	label?: string;
	identityFingerprint: string;
	valueFingerprint?: string;
	resolveValueFingerprint?: () => string | undefined;
};

type AuthApiKeyResult = {
	apiKey?: string;
	sourceToken?: AuthSourceToken;
};

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	constructor(private authPath: string = join(getAgentDir(), "auth.json")) {}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", "utf-8");
			chmodSync(this.authPath, 0o600);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private staleAuthSources: Map<string, AuthSourceToken[]> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private loadError: Error | null = null;
	private errors: Error[] = [];

	private constructor(
		private storage: AuthStorageBackend,
		private options: AuthStorageOptions = {},
	) {
		this.reload();
	}

	static create(authPath?: string, options?: AuthStorageOptions): AuthStorage {
		const authOptions = options ?? { usePrimeCliConfig: authPath === undefined };
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")), authOptions);
	}

	static fromStorage(storage: AuthStorageBackend, options?: AuthStorageOptions): AuthStorage {
		return new AuthStorage(storage, options);
	}

	static inMemory(data: AuthStorageData = {}, options?: AuthStorageOptions): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage, options);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.clearStaleAuthSource(provider, "runtime");
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.clearStaleAuthSource(provider, "runtime");
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private fingerprintAuthSource(source: ActiveAuthStatusSource, material: string): string {
		const digest = createHash("sha256").update(source).update("\0").update(material).digest("hex");
		return `${source}:${digest}`;
	}

	private createAuthSourceCandidate(options: {
		source: ActiveAuthStatusSource;
		configured: boolean;
		identityMaterial: string;
		valueMaterial?: string;
		label?: string;
		resolveValueMaterial?: () => string | undefined;
	}): AuthSourceCandidate {
		return {
			configured: options.configured,
			source: options.source,
			...(options.label ? { label: options.label } : {}),
			identityFingerprint: this.fingerprintAuthSource(options.source, `identity:${options.identityMaterial}`),
			...(options.valueMaterial !== undefined
				? {
						valueFingerprint: this.fingerprintAuthSource(
							options.source,
							`value:${options.identityMaterial}\0${options.valueMaterial}`,
						),
					}
				: {}),
			...(options.resolveValueMaterial
				? {
						resolveValueFingerprint: () => {
							const valueMaterial = options.resolveValueMaterial?.();
							return valueMaterial === undefined
								? undefined
								: this.fingerprintAuthSource(
										options.source,
										`value:${options.identityMaterial}\0${valueMaterial}`,
									);
						},
					}
				: {}),
		};
	}

	private getStoredCredentialValueMaterial(providerId: string, credential: AuthCredential): string | undefined {
		if (credential.type === "api_key") {
			if (credential.key.startsWith("!")) {
				const resolvedKey = resolveConfigValueUncached(credential.key);
				return resolvedKey === undefined ? undefined : `api_key:command:${credential.key}\0${resolvedKey}`;
			}
			return `api_key:${credential.key}\0${resolveConfigValue(credential.key) ?? ""}`;
		}
		const provider = getOAuthProvider(providerId);
		const apiKey = provider?.getApiKey(credential) ?? credential.access;
		return `oauth:${apiKey}\0${credential.refresh}\0${credential.expires}`;
	}

	private getRuntimeAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const apiKey = this.runtimeOverrides.get(provider);
		if (!apiKey) {
			return undefined;
		}
		return {
			label: "--api-key",
			...this.createAuthSourceCandidate({
				configured: false,
				source: "runtime",
				identityMaterial: provider,
				valueMaterial: apiKey,
			}),
		};
	}

	private getPrimeCliAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const apiKey = this.getPrimeCliApiKey(provider);
		if (!apiKey) {
			return undefined;
		}
		return {
			label: "Prime CLI",
			...this.createAuthSourceCandidate({
				configured: false,
				source: "prime_cli",
				identityMaterial: provider,
				valueMaterial: apiKey,
			}),
		};
	}

	private getStoredAuthCandidate(
		provider: string,
		options?: { resolveCommandValue?: boolean; resolvedCommandValue?: string },
	): AuthSourceCandidate | undefined {
		const credential = this.data[provider];
		if (!credential) {
			return undefined;
		}
		const isCommandApiKey = credential.type === "api_key" && credential.key.startsWith("!");
		const identityMaterial = isCommandApiKey ? `api_key:command:${credential.key}` : `${provider}:${credential.type}`;
		const commandValueMaterial =
			isCommandApiKey && options?.resolvedCommandValue !== undefined
				? `api_key:command:${credential.key}\0${options.resolvedCommandValue}`
				: undefined;
		return this.createAuthSourceCandidate({
			configured: true,
			source: "stored",
			identityMaterial,
			valueMaterial:
				commandValueMaterial ??
				(isCommandApiKey && !options?.resolveCommandValue
					? undefined
					: this.getStoredCredentialValueMaterial(provider, credential)),
			resolveValueMaterial: isCommandApiKey
				? () => this.getStoredCredentialValueMaterial(provider, credential)
				: undefined,
		});
	}

	private getEnvironmentAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const envKeys = findEnvKeys(provider);
		const envKey = envKeys?.[0];
		const apiKey = getEnvApiKey(provider);
		if (!apiKey) {
			return undefined;
		}
		const label = envKey ?? "ambient credentials";
		const identityMaterial = envKey ?? this.getAmbientEnvironmentIdentityMaterial(provider);
		return this.createAuthSourceCandidate({
			configured: false,
			source: "environment",
			label,
			identityMaterial,
			valueMaterial: `${identityMaterial}\0${apiKey}`,
		});
	}

	private getAmbientEnvironmentIdentityMaterial(provider: string): string {
		if (provider === "amazon-bedrock") {
			if (process.env.AWS_PROFILE) return `amazon-bedrock:profile:${process.env.AWS_PROFILE}`;
			if (process.env.AWS_ACCESS_KEY_ID) {
				return `amazon-bedrock:access-key:${process.env.AWS_ACCESS_KEY_ID}:${process.env.AWS_SECRET_ACCESS_KEY ?? ""}:${process.env.AWS_SESSION_TOKEN ?? ""}`;
			}
			if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
				return `amazon-bedrock:bearer:${process.env.AWS_BEARER_TOKEN_BEDROCK}`;
			}
			if (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
				return `amazon-bedrock:ecs-relative:${process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`;
			}
			if (process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
				return `amazon-bedrock:ecs-full:${process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI}`;
			}
			if (process.env.AWS_WEB_IDENTITY_TOKEN_FILE) {
				return `amazon-bedrock:web-identity:${process.env.AWS_WEB_IDENTITY_TOKEN_FILE}`;
			}
		}
		if (provider === "google-vertex") {
			const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "";
			const location = process.env.GOOGLE_CLOUD_LOCATION ?? "";
			const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "application-default";
			return `google-vertex:${project}:${location}:${credentialsPath}`;
		}
		return provider;
	}

	private getFallbackAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const apiKey = this.fallbackResolver?.(provider);
		if (!apiKey) {
			return undefined;
		}
		return this.createAuthSourceCandidate({
			configured: false,
			source: "fallback",
			label: "custom provider config",
			identityMaterial: provider,
			valueMaterial: apiKey,
		});
	}

	private getAuthSourceCandidates(provider: string, options?: { includeFallback?: boolean }): AuthSourceCandidate[] {
		const fallbackCandidate =
			options?.includeFallback === false ? undefined : this.getFallbackAuthCandidate(provider);
		const candidates =
			provider === PRIME_INFERENCE_PROVIDER_ID
				? [
						this.getRuntimeAuthCandidate(provider),
						this.getEnvironmentAuthCandidate(provider),
						this.getPrimeCliAuthCandidate(provider),
						this.getStoredAuthCandidate(provider),
						fallbackCandidate,
					]
				: [
						this.getRuntimeAuthCandidate(provider),
						this.getStoredAuthCandidate(provider),
						this.getEnvironmentAuthCandidate(provider),
						fallbackCandidate,
					];
		return candidates.filter((candidate): candidate is AuthSourceCandidate => candidate !== undefined);
	}

	private isAuthSourceStale(provider: string, candidate: AuthSourceCandidate): boolean {
		const matchingStale = this.getMatchingStaleAuthSources(provider, candidate);
		if (matchingStale.length === 0) {
			return false;
		}
		const valueFingerprint = candidate.valueFingerprint ?? candidate.resolveValueFingerprint?.();
		return Boolean(valueFingerprint && matchingStale.some((token) => token.valueFingerprint === valueFingerprint));
	}

	private getMatchingStaleAuthSources(provider: string, candidate: AuthSourceCandidate): AuthSourceToken[] {
		const stale = this.staleAuthSources.get(provider);
		if (!stale) {
			return [];
		}
		return stale.filter(
			(token) => token.source === candidate.source && token.identityFingerprint === candidate.identityFingerprint,
		);
	}

	private getAvailableAuthCandidate(
		provider: string,
		options?: { includeFallback?: boolean },
	): { candidate?: AuthSourceCandidate; hasStaleCandidate: boolean } {
		let hasStaleCandidate = false;
		for (const candidate of this.getAuthSourceCandidates(provider, options)) {
			if (this.isAuthSourceStale(provider, candidate)) {
				hasStaleCandidate = true;
				continue;
			}
			return { candidate, hasStaleCandidate };
		}
		return { hasStaleCandidate };
	}

	private toAuthStatus(candidate: AuthSourceCandidate): AuthStatus {
		return {
			configured: candidate.configured,
			source: candidate.source,
			...(candidate.label ? { label: candidate.label } : {}),
		};
	}

	private getAuthStatusFromCandidates(provider: string): AuthStatus {
		const { candidate, hasStaleCandidate } = this.getAvailableAuthCandidate(provider);
		if (candidate) {
			return this.toAuthStatus(candidate);
		}
		if (hasStaleCandidate) {
			return { configured: false, source: "stale", label: "expired" };
		}
		return { configured: false };
	}

	markAuthStale(provider: string): boolean {
		const token = this.getCurrentAuthSourceToken(provider);
		return token ? this.markAuthSourceStale(token) : false;
	}

	private getAuthSourceTokenForCandidate(
		provider: string,
		candidate: AuthSourceCandidate,
	): AuthSourceToken | undefined {
		const valueFingerprint = candidate.valueFingerprint ?? candidate.resolveValueFingerprint?.();
		if (!valueFingerprint) {
			return undefined;
		}
		return {
			provider,
			source: candidate.source,
			identityFingerprint: candidate.identityFingerprint,
			valueFingerprint,
		};
	}

	getCurrentAuthSourceToken(provider: string): AuthSourceToken | undefined {
		const { candidate } = this.getAvailableAuthCandidate(provider);
		if (!candidate) {
			return undefined;
		}
		return this.getAuthSourceTokenForCandidate(provider, candidate);
	}

	markAuthSourceStale(token: AuthSourceToken): boolean {
		if (token.provider.length === 0) {
			return false;
		}
		const stale = this.staleAuthSources.get(token.provider) ?? [];
		if (
			!stale.some(
				(existing) =>
					existing.source === token.source &&
					existing.identityFingerprint === token.identityFingerprint &&
					existing.valueFingerprint === token.valueFingerprint,
			)
		) {
			stale.push(token);
		}
		this.staleAuthSources.set(token.provider, stale);
		return true;
	}

	private clearStaleAuthSource(provider: string, source: ActiveAuthStatusSource): void {
		const stale = this.staleAuthSources.get(provider);
		if (!stale) {
			return;
		}
		const next = stale.filter((token) => token.source !== source);
		if (next.length === 0) {
			this.staleAuthSources.delete(provider);
		} else {
			this.staleAuthSources.set(provider, next);
		}
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
		if (this.loadError) {
			return;
		}

		try {
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[provider] ?? undefined;
	}

	/**
	 * Set credential for a provider.
	 */
	set(provider: string, credential: AuthCredential): void {
		this.clearStaleAuthSource(provider, "stored");
		this.data[provider] = credential;
		this.persistProviderChange(provider, credential);
	}

	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): void {
		this.clearStaleAuthSource(provider, "stored");
		delete this.data[provider];
		this.persistProviderChange(provider, undefined);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		return this.getAvailableAuthCandidate(provider).candidate !== undefined;
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		return this.getAuthStatusFromCandidates(provider);
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		this.set(providerId, { type: "oauth", ...credentials });
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		if (provider === PRIME_INFERENCE_PROVIDER_ID && this.isPrimeCliConfigEnabled()) {
			try {
				clearPrimeCliCredentials(this.getEnabledPrimeCliConfigPath());
				this.clearStaleAuthSource(provider, "prime_cli");
			} catch (error) {
				this.recordError(error);
				throw error;
			}
		}
		this.remove(provider);
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		const result = await this.storage.withLockAsync(async (current) => {
			const currentData = this.parseStorageData(current);
			this.data = currentData;
			this.loadError = null;

			const cred = currentData[providerId];
			if (cred?.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < cred.expires) {
				return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
			}

			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(currentData)) {
				if (value.type === "oauth") {
					oauthCreds[key] = value;
				}
			}

			const refreshed = await getOAuthApiKey(providerId, oauthCreds);
			if (!refreshed) {
				return { result: null };
			}

			const merged: AuthStorageData = {
				...currentData,
				[providerId]: { type: "oauth", ...refreshed.newCredentials },
			};
			this.data = merged;
			this.loadError = null;
			return { result: refreshed, next: JSON.stringify(merged, null, 2) };
		});

		return result;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. Prime Inference: environment variable, Prime CLI config, auth.json
	 * 3. Other providers: auth.json, environment variable
	 * 4. Fallback resolver (models.json custom providers)
	 */
	async getApiKeyWithSourceToken(
		providerId: string,
		options?: { includeFallback?: boolean },
	): Promise<AuthApiKeyResult> {
		// Runtime override takes highest priority
		const runtimeCandidate = this.getRuntimeAuthCandidate(providerId);
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey && runtimeCandidate && !this.isAuthSourceStale(providerId, runtimeCandidate)) {
			return {
				apiKey: runtimeKey,
				sourceToken: this.getAuthSourceTokenForCandidate(providerId, runtimeCandidate),
			};
		}

		const envCandidate = this.getEnvironmentAuthCandidate(providerId);
		const envKey = getEnvApiKey(providerId);
		if (
			providerId === PRIME_INFERENCE_PROVIDER_ID &&
			envKey &&
			envCandidate &&
			!this.isAuthSourceStale(providerId, envCandidate)
		) {
			return {
				apiKey: envKey,
				sourceToken: this.getAuthSourceTokenForCandidate(providerId, envCandidate),
			};
		}

		if (providerId === PRIME_INFERENCE_PROVIDER_ID) {
			const primeCliCandidate = this.getPrimeCliAuthCandidate(providerId);
			const primeCliKey = this.getPrimeCliApiKey(providerId);
			if (primeCliKey && primeCliCandidate && !this.isAuthSourceStale(providerId, primeCliCandidate)) {
				return {
					apiKey: primeCliKey,
					sourceToken: this.getAuthSourceTokenForCandidate(providerId, primeCliCandidate),
				};
			}
		}

		const cred = this.data[providerId];

		if (cred?.type === "api_key") {
			const storedCandidate = this.getStoredAuthCandidate(providerId);
			if (storedCandidate && !this.isAuthSourceStale(providerId, storedCandidate)) {
				const hasStaleRecord = this.getMatchingStaleAuthSources(providerId, storedCandidate).length > 0;
				const apiKey =
					cred.key.startsWith("!") && hasStaleRecord
						? resolveConfigValueUncached(cred.key)
						: resolveConfigValue(cred.key);
				const sourceToken =
					apiKey === undefined
						? undefined
						: this.getAuthSourceTokenForCandidate(
								providerId,
								cred.key.startsWith("!")
									? (this.getStoredAuthCandidate(providerId, { resolvedCommandValue: apiKey }) ??
											storedCandidate)
									: storedCandidate,
							);
				return { apiKey, sourceToken };
			}
		}

		if (cred?.type === "oauth") {
			const storedCandidate = this.getStoredAuthCandidate(providerId);
			if (storedCandidate && !this.isAuthSourceStale(providerId, storedCandidate)) {
				const provider = getOAuthProvider(providerId);
				if (!provider) {
					// Unknown OAuth provider, can't get API key
					return {};
				}

				// Check if token needs refresh
				const needsRefresh = Date.now() >= cred.expires;

				if (needsRefresh) {
					// Use locked refresh to prevent race conditions
					try {
						const result = await this.refreshOAuthTokenWithLock(providerId);
						if (result) {
							const refreshedCandidate = this.getStoredAuthCandidate(providerId);
							return {
								apiKey: result.apiKey,
								sourceToken: refreshedCandidate
									? this.getAuthSourceTokenForCandidate(providerId, refreshedCandidate)
									: undefined,
							};
						}
					} catch (error) {
						this.recordError(error);
						// Refresh failed - re-read file to check if another instance succeeded
						this.reload();
						const updatedCred = this.data[providerId];

						if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
							// Another instance refreshed successfully, use those credentials
							const updatedCandidate = this.getStoredAuthCandidate(providerId);
							return {
								apiKey: provider.getApiKey(updatedCred),
								sourceToken: updatedCandidate
									? this.getAuthSourceTokenForCandidate(providerId, updatedCandidate)
									: undefined,
							};
						}

						// Refresh truly failed - return undefined so model discovery skips this provider
						// User can /login to re-authenticate (credentials preserved for retry)
						return {};
					}
				} else {
					// Token not expired, use current access token
					return {
						apiKey: provider.getApiKey(cred),
						sourceToken: this.getAuthSourceTokenForCandidate(providerId, storedCandidate),
					};
				}
			}
		}

		// Other providers preserve auth.json priority over environment variables.
		if (
			providerId !== PRIME_INFERENCE_PROVIDER_ID &&
			envKey &&
			envCandidate &&
			!this.isAuthSourceStale(providerId, envCandidate)
		) {
			return {
				apiKey: envKey,
				sourceToken: this.getAuthSourceTokenForCandidate(providerId, envCandidate),
			};
		}

		// Fall back to custom resolver (e.g., models.json custom providers)
		if (options?.includeFallback !== false) {
			const fallbackCandidate = this.getFallbackAuthCandidate(providerId);
			if (fallbackCandidate && !this.isAuthSourceStale(providerId, fallbackCandidate)) {
				return {
					apiKey: this.fallbackResolver?.(providerId) ?? undefined,
					sourceToken: this.getAuthSourceTokenForCandidate(providerId, fallbackCandidate),
				};
			}
		}

		return {};
	}

	async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
		const result = await this.getApiKeyWithSourceToken(providerId, options);
		return result.apiKey;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}

	setPrimeInferenceTeamSelection(team: PrimeTeam | null): void {
		if (this.isPrimeCliConfigEnabled()) {
			try {
				savePrimeCliTeamSelection(team, this.getEnabledPrimeCliConfigPath());
			} catch (error) {
				this.recordError(error);
				throw error;
			}
			return;
		}

		const credential = this.data[PRIME_INFERENCE_PROVIDER_ID];
		if (credential?.type !== "api_key") {
			return;
		}
		this.set(PRIME_INFERENCE_PROVIDER_ID, {
			...credential,
			primeTeam: team ? this.toPrimeTeamCredential(team) : null,
		});
	}

	setPrimeInferenceApiKey(apiKey: string): void {
		if (this.isPrimeCliConfigEnabled()) {
			try {
				const configPath = this.getEnabledPrimeCliConfigPath();
				const config = loadPrimeCliConfig(configPath);
				const existingCredential = this.data[PRIME_INFERENCE_PROVIDER_ID];
				const legacyPrimeTeam = existingCredential?.type === "api_key" ? existingCredential.primeTeam : undefined;
				if (config.apiKey !== apiKey) {
					savePrimeCliApiKey(apiKey, configPath);
				} else if (!config.teamIdFromEnv && (legacyPrimeTeam === null || (!config.teamId && legacyPrimeTeam))) {
					savePrimeCliTeamSelection(legacyPrimeTeam, configPath);
				}
				this.clearStaleAuthSource(PRIME_INFERENCE_PROVIDER_ID, "prime_cli");
			} catch (error) {
				this.recordError(error);
				throw error;
			}
			if (this.data[PRIME_INFERENCE_PROVIDER_ID]) {
				this.remove(PRIME_INFERENCE_PROVIDER_ID);
			}
			return;
		}

		const existingCredential = this.data[PRIME_INFERENCE_PROVIDER_ID];
		const existingPrimeTeam = existingCredential?.type === "api_key" ? existingCredential.primeTeam : undefined;
		this.set(PRIME_INFERENCE_PROVIDER_ID, {
			type: "api_key",
			key: apiKey,
			...(existingPrimeTeam !== undefined ? { primeTeam: existingPrimeTeam } : {}),
		});
	}

	getPrimeInferenceTeamSelection(): PrimeTeamCredential | null | undefined {
		let config: PrimeCliConfig | undefined;
		if (this.isPrimeCliConfigEnabled()) {
			config = this.getPrimeCliConfig(PRIME_INFERENCE_PROVIDER_ID);
			if (config?.teamIdFromEnv) {
				return undefined;
			}
		}

		const credential = this.data[PRIME_INFERENCE_PROVIDER_ID];
		const authSource = this.getAuthStatus(PRIME_INFERENCE_PROVIDER_ID).source;
		if (authSource === "runtime" || authSource === "environment") {
			return undefined;
		}
		if (authSource === "prime_cli") {
			if (credential?.type === "api_key" && credential.primeTeam === null) {
				return null;
			}
			if (config?.teamId) {
				return this.toPrimeTeamCredential({
					teamId: config.teamId,
					name: config.teamName ?? "Prime CLI team",
					...(config.teamRole ? { role: config.teamRole } : {}),
				});
			}
			if (credential?.type === "api_key" && credential.primeTeam) {
				return credential.primeTeam;
			}
			return null;
		}
		if (credential?.type === "api_key" && credential.primeTeam !== undefined) {
			return credential.primeTeam;
		}
		if (!config?.apiKey && config?.teamId) {
			return this.toPrimeTeamCredential({
				teamId: config.teamId,
				name: config.teamName ?? "Prime CLI team",
				...(config.teamRole ? { role: config.teamRole } : {}),
			});
		}
		return undefined;
	}

	getProviderHeaders(providerId: string): Record<string, string> | undefined {
		if (providerId !== PRIME_INFERENCE_PROVIDER_ID) {
			return undefined;
		}

		const primeCliConfig = this.getPrimeCliConfig(providerId);
		if (primeCliConfig?.teamIdFromEnv) {
			return primeCliConfig.teamId ? { "X-Prime-Team-ID": primeCliConfig.teamId } : undefined;
		}

		const teamId = this.getPrimeInferenceTeamSelection()?.teamId;
		return teamId ? { "X-Prime-Team-ID": teamId } : undefined;
	}

	getPrimeCliConfigPath(): string | undefined {
		if (!this.isPrimeCliConfigEnabled()) {
			return undefined;
		}
		return getPrimeCliConfigPath(this.options.primeCliConfigPath);
	}

	private toPrimeTeamCredential(team: PrimeTeam): PrimeTeamCredential {
		const credential: PrimeTeamCredential = {
			teamId: team.teamId,
			name: team.name,
		};
		if (team.slug) {
			credential.slug = team.slug;
		}
		if (team.role) {
			credential.role = team.role;
		}
		if (team.createdAt) {
			credential.createdAt = team.createdAt;
		}
		return credential;
	}

	private getPrimeCliConfig(providerId: string): PrimeCliConfig | undefined {
		if (providerId !== PRIME_INFERENCE_PROVIDER_ID) {
			return undefined;
		}
		if (!this.isPrimeCliConfigEnabled()) {
			return undefined;
		}
		return loadPrimeCliConfig(this.options.primeCliConfigPath);
	}

	private getPrimeCliApiKey(providerId: string): string | undefined {
		return this.getPrimeCliConfig(providerId)?.apiKey;
	}

	private getEnabledPrimeCliConfigPath(): string {
		const configPath = this.getPrimeCliConfigPath();
		if (!configPath) {
			throw new Error("Prime CLI config is not enabled");
		}
		return configPath;
	}

	private isPrimeCliConfigEnabled(): boolean {
		return Boolean(this.options.usePrimeCliConfig || this.options.primeCliConfigPath);
	}
}
