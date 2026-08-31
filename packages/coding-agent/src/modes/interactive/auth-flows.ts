import * as path from "node:path";
import { getProviders, type OAuthProviderId, type OAuthSelectPrompt } from "@earendil-works/pi-ai";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { getAuthPath, getDocsPath } from "../../config.js";
import type { ModelRegistry } from "../../core/model-registry.js";
import {
	checkPrimeAgentTracesAccess,
	checkPrimeInferenceAccess,
	fetchPrimeTeams,
	loadPrimeCliConfig,
	loginPrimeAgentTraces,
	loginPrimeInference,
	PRIME_AGENT_TRACES_PROVIDER_ID,
	PRIME_AGENT_TRACES_PROVIDER_NAME,
	PRIME_INFERENCE_PROVIDER_ID,
	PRIME_INFERENCE_PROVIDER_NAME,
	type PrimeTeam,
	resolvePrimeAgentTracesBaseUrl,
} from "../../core/prime-inference-auth.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../core/provider-display-names.js";
import { SERPER_CREDENTIAL_ID, SERPER_CREDENTIAL_NAME } from "../../core/websearch-credential.js";
import { showFullPaneOverlay } from "./components/centered-overlay.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import {
	type AuthSelectorCategory,
	type AuthSelectorProvider,
	compareAuthSelectorProviders,
	OAuthSelectorComponent,
} from "./components/oauth-selector.js";
import { PrimeTeamSelectorComponent } from "./components/prime-team-selector.js";
import { theme } from "./theme/theme.js";

export type AuthenticationResult =
	| {
			status: "success";
			providerId: string;
			providerName: string;
			authType: "oauth" | "api_key";
			/** "service" credentials (e.g. web search) don't affect model selection. */
			kind?: "provider" | "service";
	  }
	| { status: "cancelled" }
	| { status: "failed" };

export const BEDROCK_PROVIDER_ID = "amazon-bedrock";

export const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

export async function getAnthropicSubscriptionAuthWarning(
	modelRegistry: ModelRegistry,
	model: { provider: string } | undefined,
): Promise<string | undefined> {
	if (!model || model.provider !== "anthropic") {
		return undefined;
	}

	const storedCredential = modelRegistry.authStorage.get("anthropic");
	if (storedCredential?.type === "oauth") {
		return ANTHROPIC_SUBSCRIPTION_AUTH_WARNING;
	}

	try {
		const apiKey = await modelRegistry.getApiKeyForProvider(model.provider);
		if (isAnthropicSubscriptionAuthKey(apiKey)) {
			return ANTHROPIC_SUBSCRIPTION_AUTH_WARNING;
		}
	} catch {
		// Ignore auth lookup failures for warning-only checks.
	}
	return undefined;
}

const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

export function isApiKeyLoginProvider(
	providerId: string,
	oauthProviderIds: ReadonlySet<string>,
	builtInProviderIds: ReadonlySet<string> = BUILT_IN_MODEL_PROVIDERS,
): boolean {
	if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) {
		return true;
	}
	if (builtInProviderIds.has(providerId)) {
		return false;
	}
	return !oauthProviderIds.has(providerId);
}

export interface ProviderAuthFlowsHost {
	readonly ui: TUI;
	readonly modelRegistry: ModelRegistry;
	showStatus(message: string): void;
	showError(message: string): void;
	/** Models currently visible to the host; used to detect providers configured via external credentials. */
	getAvailableModels(): Promise<ReadonlyArray<{ provider: string }>>;
	/** Invoked after stored credentials change so the host can refresh dependent UI. */
	onAuthChanged?(): void | Promise<void>;
	/** Invoked after a successful login (e.g. to surface billing warnings). */
	onLoginCompleted?(): void;
}

export interface ProviderLoginOptions {
	authType?: "oauth" | "api_key";
	initialCategory?: AuthSelectorCategory;
}

/** Shared auth dialogs: host-specific refresh and billing effects remain outside the flow. */
export class ProviderAuthFlows {
	constructor(private readonly host: ProviderAuthFlowsHost) {}

	/**
	 * Run the OAuth login flow for an MCP integration server.
	 *
	 * The provider must already be registered (the McpManager does this as
	 * `mcp:<server>`). On success the credentials land in auth.json and the
	 * caller should reload resources so the integration's skill enables.
	 */
	runMcpLogin(server: string, label?: string): Promise<AuthenticationResult> {
		const providerId = `mcp:${server}`;
		const provider = this.host.modelRegistry.authStorage.getOAuthProviders().find((p) => p.id === providerId);
		if (!provider) {
			this.host.showError(`Unknown MCP integration: ${server}`);
			return Promise.resolve({ status: "failed" });
		}
		return this.showLoginDialog(providerId, label ?? provider.name, "service");
	}

	runLogin(options: ProviderLoginOptions = {}): Promise<AuthenticationResult> {
		const { authType, initialCategory } = options;
		const providerOptions = this.getLoginProviderOptions(authType);
		if (providerOptions.length === 0) {
			this.host.showStatus(
				authType === "oauth"
					? "No subscription providers available."
					: authType === "api_key"
						? "No API key providers available."
						: "No providers available.",
			);
			return Promise.resolve({ status: "failed" });
		}

		return new Promise((resolve) => {
			let handle: OverlayHandle | undefined;
			const close = () => {
				handle?.hide();
				this.host.ui.requestRender();
			};
			const selector = new OAuthSelectorComponent(
				"login",
				this.host.modelRegistry.authStorage,
				providerOptions,
				async (providerOption: AuthSelectorProvider) => {
					close();
					resolve(await this.loginProvider(providerOption));
				},
				() => {
					close();
					resolve({ status: "cancelled" });
				},
				(providerId) => this.host.modelRegistry.getProviderAuthStatus(providerId),
				{ getRows: () => this.host.ui.terminal.rows, initialCategory },
			);
			handle = showFullPaneOverlay(this.host.ui, selector, 78);
		});
	}

	loginProvider(providerOption: AuthSelectorProvider): Promise<AuthenticationResult> {
		const kind = providerOption.category === "service" ? "service" : "provider";
		if (providerOption.authType === "oauth") {
			return this.showLoginDialog(providerOption.id, providerOption.name, kind);
		}
		if (providerOption.id === PRIME_INFERENCE_PROVIDER_ID) {
			return this.runPrimeInferenceLogin();
		}
		if (providerOption.id === BEDROCK_PROVIDER_ID) {
			return this.showBedrockSetupDialog(providerOption.id, providerOption.name);
		}
		return this.showApiKeyLoginDialog(providerOption.id, providerOption.name, kind);
	}

	runLogout(): Promise<string | null> {
		const providerOptions = this.getLogoutProviderOptions();
		if (providerOptions.length === 0) {
			this.host.showStatus(
				"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
			);
			return Promise.resolve(null);
		}

		return new Promise((resolve) => {
			let handle: OverlayHandle | undefined;
			const close = () => {
				handle?.hide();
				this.host.ui.requestRender();
			};
			const selector = new OAuthSelectorComponent(
				"logout",
				this.host.modelRegistry.authStorage,
				providerOptions,
				async (providerOption: AuthSelectorProvider) => {
					close();

					try {
						this.host.modelRegistry.authStorage.logout(providerOption.id);
						this.host.modelRegistry.refresh();
						await this.host.onAuthChanged?.();
						const message =
							providerOption.authType === "oauth"
								? `Logged out of ${providerOption.name}`
								: `Removed stored API key for ${providerOption.name}. Environment variables and models.json config are unchanged.`;
						this.host.showStatus(message);
						resolve(providerOption.id);
					} catch (error: unknown) {
						this.host.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
						resolve(null);
					}
				},
				() => {
					close();
					resolve(null);
				},
				undefined,
				{ getRows: () => this.host.ui.terminal.rows },
			);
			handle = showFullPaneOverlay(this.host.ui, selector, 78);
		});
	}

	getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[] {
		const authStorage = this.host.modelRegistry.authStorage;
		const oauthProviders = authStorage.getOAuthProviders();
		const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
		const options: AuthSelectorProvider[] = oauthProviders.map((provider) => ({
			id: provider.id,
			name: provider.name,
			authType: "oauth",
			// MCP integrations (mcp:<server>) are services, not model providers.
			...(provider.id.startsWith("mcp:") ? { category: "service" as const } : {}),
		}));

		const modelProviders = new Set(this.host.modelRegistry.getAll().map((model) => model.provider));
		for (const providerId of modelProviders) {
			if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) {
				continue;
			}
			options.push({
				id: providerId,
				name: this.host.modelRegistry.getProviderDisplayName(providerId),
				authType: "api_key",
			});
		}

		// Serper is a skill credential, not a model provider, so add it manually.
		options.push({
			id: SERPER_CREDENTIAL_ID,
			name: SERPER_CREDENTIAL_NAME,
			authType: "api_key",
			category: "service",
		});

		const filteredOptions = authType ? options.filter((option) => option.authType === authType) : options;
		return filteredOptions.sort(compareAuthSelectorProviders);
	}

	private getLogoutProviderOptions(): AuthSelectorProvider[] {
		const authStorage = this.host.modelRegistry.authStorage;
		const options: AuthSelectorProvider[] = [];

		const oauthProvidersById = new Map(authStorage.getOAuthProviders().map((p) => [p.id, p]));
		for (const providerId of authStorage.list()) {
			const credential = authStorage.get(providerId);
			if (!credential) {
				continue;
			}
			const isSerper = providerId === SERPER_CREDENTIAL_ID;
			const isMcp = providerId.startsWith("mcp:");
			const name = isSerper
				? SERPER_CREDENTIAL_NAME
				: isMcp
					? (oauthProvidersById.get(providerId)?.name ?? providerId.slice("mcp:".length))
					: this.host.modelRegistry.getProviderDisplayName(providerId);
			options.push({
				id: providerId,
				name,
				authType: credential.type,
				category: isSerper || isMcp ? "service" : "provider",
			});
		}

		if (!options.some((option) => option.id === PRIME_INFERENCE_PROVIDER_ID)) {
			const primeInferenceStatus = authStorage.getAuthStatus(PRIME_INFERENCE_PROVIDER_ID);
			if (primeInferenceStatus.source === "prime_cli") {
				options.push({
					id: PRIME_INFERENCE_PROVIDER_ID,
					name: PRIME_INFERENCE_PROVIDER_NAME,
					authType: "api_key",
				});
			}
		}

		return options.sort((a, b) => a.name.localeCompare(b.name));
	}

	private async completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
		statusSuffix?: string,
		kind: "provider" | "service" = "provider",
		credentialPath: string = getAuthPath(),
	): Promise<AuthenticationResult> {
		this.host.modelRegistry.refresh();

		const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;
		await this.host.onAuthChanged?.();
		this.host.showStatus(
			`${actionLabel}. Credentials saved to ${credentialPath}${statusSuffix ? `. ${statusSuffix}` : ""}`,
		);
		this.host.onLoginCompleted?.();
		return {
			status: "success",
			providerId,
			providerName,
			authType,
			kind,
		};
	}

	private async completeExternalProviderSetup(
		providerId: string,
		providerName: string,
	): Promise<AuthenticationResult> {
		this.host.modelRegistry.refresh();
		await this.host.onAuthChanged?.();
		this.host.showStatus(`${providerName} uses external credentials. Select a model after configuring them.`);
		return {
			status: "success",
			providerId,
			providerName,
			authType: "api_key",
		};
	}

	private async hasAvailableProviderModels(providerId: string): Promise<boolean> {
		const models = await this.host.getAvailableModels();
		return models.some((model) => model.provider === providerId);
	}

	private async showBedrockSetupDialog(providerId: string, providerName: string): Promise<AuthenticationResult> {
		const dialog = new LoginDialogComponent(this.host.ui, providerId, () => {}, providerName, "Amazon Bedrock setup");
		const handle = showFullPaneOverlay(this.host.ui, dialog, 88);
		const closeDialog = () => {
			handle.hide();
			this.host.ui.requestRender();
		};

		try {
			await dialog.showContinueInfo([
				theme.fg("text", "Amazon Bedrock uses AWS credentials instead of a single API key."),
				theme.fg("text", "Configure an AWS profile, IAM keys, bearer token, or role-based credentials."),
				theme.fg("muted", "See:"),
				theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
			]);
			closeDialog();
			if (!(await this.hasAvailableProviderModels(providerId))) {
				this.host.showStatus(`${providerName} credentials were not detected. Configure them, then reopen /model.`);
				return { status: "cancelled" };
			}
			return await this.completeExternalProviderSetup(providerId, providerName);
		} catch (error: unknown) {
			closeDialog();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.host.showError(`Failed to set up ${providerName}: ${errorMsg}`);
				return { status: "failed" };
			}
			return { status: "cancelled" };
		}
	}

	private showPrimeTeamSelector(
		teams: PrimeTeam[],
		currentTeamId: string | undefined,
	): Promise<PrimeTeam | null | undefined> {
		return new Promise((resolve) => {
			let handle: OverlayHandle | undefined;
			const close = () => {
				handle?.hide();
				this.host.ui.requestRender();
			};
			const selector = new PrimeTeamSelectorComponent(
				teams,
				currentTeamId,
				(team) => {
					close();
					resolve(team);
				},
				() => {
					close();
					resolve(undefined);
				},
				{ getRows: () => this.host.ui.terminal.rows },
			);
			handle = showFullPaneOverlay(this.host.ui, selector, 78);
		});
	}

	private getPrimeInferenceDefaultTeamStatus(): string {
		const configPath = this.host.modelRegistry.authStorage.getPrimeCliConfigPath();
		if (configPath) {
			let config: ReturnType<typeof loadPrimeCliConfig>;
			try {
				config = loadPrimeCliConfig(configPath);
			} catch {
				return "Using personal account.";
			}
			if (config.teamIdFromEnv) {
				return "Using team from PRIME_TEAM_ID.";
			}
			if (config.teamName) {
				return `Using team "${config.teamName}".`;
			}
			if (config.teamId) {
				return "Using Prime CLI team.";
			}
		}
		const storedTeam = this.host.modelRegistry.authStorage.getPrimeInferenceTeamSelection();
		if (storedTeam) {
			return `Using team "${storedTeam.name}".`;
		}
		if (storedTeam === null) {
			return "Using personal account.";
		}
		return "Using personal account.";
	}

	private async selectPrimeInferenceTeam(apiKey: string, dialog: LoginDialogComponent): Promise<string | undefined> {
		try {
			const config = loadPrimeCliConfig(this.host.modelRegistry.authStorage.getPrimeCliConfigPath());
			if (config.teamIdFromEnv) {
				this.host.modelRegistry.authStorage.reload();
				return "Using team from PRIME_TEAM_ID.";
			}

			dialog.showProgress("Loading Prime teams...");
			const teams = await fetchPrimeTeams(apiKey, config.baseUrl, { signal: dialog.signal });
			if (dialog.signal.aborted) {
				return this.getPrimeInferenceDefaultTeamStatus();
			}
			if (teams.length === 0) {
				this.host.modelRegistry.authStorage.setPrimeInferenceTeamSelection(null);
				return "Using personal account.";
			}

			const storedTeam = this.host.modelRegistry.authStorage.getPrimeInferenceTeamSelection();
			const currentTeamId = storedTeam === null ? undefined : (storedTeam?.teamId ?? config.teamId);
			const selectedTeam = await this.showPrimeTeamSelector(teams, currentTeamId);
			if (selectedTeam !== undefined) {
				this.host.modelRegistry.authStorage.setPrimeInferenceTeamSelection(selectedTeam);
			}
			return selectedTeam
				? `Using team "${selectedTeam.name}".`
				: selectedTeam === null
					? "Using personal account."
					: this.getPrimeInferenceDefaultTeamStatus();
		} catch {
			this.host.modelRegistry.authStorage.reload();
			return this.getPrimeInferenceDefaultTeamStatus();
		}
	}

	private async completePrimeInferenceLogin(
		apiKey: string,
		dialog: LoginDialogComponent,
		closeDialog: () => void,
	): Promise<AuthenticationResult> {
		this.host.modelRegistry.authStorage.setPrimeInferenceApiKey(apiKey);
		const teamStatus = await this.selectPrimeInferenceTeam(apiKey, dialog);

		closeDialog();
		return await this.completeProviderAuthentication(
			PRIME_INFERENCE_PROVIDER_ID,
			PRIME_INFERENCE_PROVIDER_NAME,
			"api_key",
			teamStatus,
			"provider",
			this.host.modelRegistry.authStorage.getPrimeCliConfigPath() ?? getAuthPath(),
		);
	}

	private async completePrimeAgentTracesLogin(apiKey: string, closeDialog: () => void): Promise<AuthenticationResult> {
		this.host.modelRegistry.authStorage.set(PRIME_AGENT_TRACES_PROVIDER_ID, {
			type: "api_key",
			key: apiKey,
		});

		closeDialog();
		return await this.completeProviderAuthentication(
			PRIME_AGENT_TRACES_PROVIDER_ID,
			PRIME_AGENT_TRACES_PROVIDER_NAME,
			"api_key",
		);
	}

	async runPrimeInferenceLogin(): Promise<AuthenticationResult> {
		const dialog = new LoginDialogComponent(
			this.host.ui,
			PRIME_INFERENCE_PROVIDER_ID,
			(_success, _message) => {},
			PRIME_INFERENCE_PROVIDER_NAME,
		);

		const handle = showFullPaneOverlay(this.host.ui, dialog, {
			maxContentWidth: 88,
			suspendFullscreenMouse: true,
		});

		const closeDialog = () => {
			handle.hide();
			this.host.ui.requestRender();
		};

		// The browser challenge gets its own controller so a manually pasted key
		// can stop the polling without tearing down the dialog.
		const browserAbort = new AbortController();
		const onDialogAbort = () => browserAbort.abort();
		dialog.signal.addEventListener("abort", onDialogAbort, { once: true });

		let manualInputArmed = false;
		let resolveManualKey: (entry: { apiKey: string; source: "manual" }) => void = () => {};
		const manualKeyEntry = new Promise<{ apiKey: string; source: "manual" }>((resolve) => {
			resolveManualKey = resolve;
		});
		const armManualInput = (prompt: string): void => {
			manualInputArmed = true;
			void (async () => {
				let value = (await dialog.showManualInput(prompt)).trim();
				while (!value) {
					value = (await dialog.waitForInput()).trim();
				}
				resolveManualKey({ apiKey: value, source: "manual" });
			})().catch(() => {
				// Cancellation surfaces through the dialog signal.
			});
		};

		try {
			const browserLogin = loginPrimeInference(
				{
					onAuth: (info) => {
						dialog.showAuth(info.url, info.instructions);
						armManualInput("Complete the sign-in in your browser, or paste an API key below:");
					},
					onProgress: (message) => {
						dialog.showProgress(message);
					},
					signal: browserAbort.signal,
				},
				{
					configPath: this.host.modelRegistry.authStorage.getPrimeCliConfigPath(),
				},
			);
			// When the browser challenge cannot start or breaks down, keep the dialog
			// open and fall back to plain API key entry instead of failing outright.
			const browserLoginOrFallback = browserLogin.catch((error: unknown) => {
				if (browserAbort.signal.aborted) {
					throw error;
				}
				const errorMsg = error instanceof Error ? error.message : String(error);
				dialog.showProgress(`Browser sign-in unavailable (${errorMsg}).`);
				if (!manualInputArmed) {
					armManualInput("Paste a Prime API key below:");
				}
				return manualKeyEntry;
			});
			// Once the browser flow has settled into manual fallback, nothing above
			// rejects on cancel anymore, so the dialog signal must end the race too.
			const dialogCancelled = new Promise<never>((_, reject) => {
				dialog.signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
			});
			// Promise.race observes the rejections below, but keep dedicated handlers
			// so neither an aborted browser flow nor a cancelled dialog can surface
			// as an unhandled rejection.
			browserLoginOrFallback.catch(() => {});
			dialogCancelled.catch(() => {});

			const result = await Promise.race([browserLoginOrFallback, manualKeyEntry, dialogCancelled]);
			if (dialog.signal.aborted) {
				closeDialog();
				return { status: "cancelled" };
			}

			if (result.source === "manual") {
				browserAbort.abort();
				dialog.showProgress("Checking Prime Inference access...");
				const config = loadPrimeCliConfig(this.host.modelRegistry.authStorage.getPrimeCliConfigPath());
				const access = await checkPrimeInferenceAccess(result.apiKey, config.baseUrl, { signal: dialog.signal });
				if (dialog.signal.aborted) {
					closeDialog();
					return { status: "cancelled" };
				}
				if (!access.ok) {
					const status = access.status === undefined ? "" : `HTTP ${access.status}: `;
					throw new Error(`Prime API key does not have Prime Inference access (${status}${access.message})`);
				}
			}

			return await this.completePrimeInferenceLogin(result.apiKey, dialog, closeDialog);
		} catch (error: unknown) {
			closeDialog();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (!dialog.signal.aborted && errorMsg !== "Login cancelled") {
				this.host.showError(`Failed to login to ${PRIME_INFERENCE_PROVIDER_NAME}: ${errorMsg}`);
				return { status: "failed" };
			}
			return { status: "cancelled" };
		} finally {
			dialog.signal.removeEventListener("abort", onDialogAbort);
		}
	}

	async runPrimeAgentTracesLogin(): Promise<AuthenticationResult> {
		const dialog = new LoginDialogComponent(
			this.host.ui,
			PRIME_AGENT_TRACES_PROVIDER_ID,
			(_success, _message) => {},
			PRIME_AGENT_TRACES_PROVIDER_NAME,
		);

		const handle = showFullPaneOverlay(this.host.ui, dialog, {
			maxContentWidth: 88,
			suspendFullscreenMouse: true,
		});

		const closeDialog = () => {
			handle.hide();
			this.host.ui.requestRender();
		};

		const browserAbort = new AbortController();
		const onDialogAbort = () => browserAbort.abort();
		dialog.signal.addEventListener("abort", onDialogAbort, { once: true });

		let manualInputArmed = false;
		let resolveManualKey: (entry: { apiKey: string; source: "manual" }) => void = () => {};
		const manualKeyEntry = new Promise<{ apiKey: string; source: "manual" }>((resolve) => {
			resolveManualKey = resolve;
		});
		const armManualInput = (prompt: string): void => {
			manualInputArmed = true;
			void (async () => {
				let value = (await dialog.showManualInput(prompt)).trim();
				while (!value) {
					value = (await dialog.waitForInput()).trim();
				}
				resolveManualKey({ apiKey: value, source: "manual" });
			})().catch(() => {
				// Cancellation surfaces through the dialog signal.
			});
		};

		try {
			const browserLogin = loginPrimeAgentTraces({
				onAuth: (info) => {
					dialog.showAuth(info.url, info.instructions);
					armManualInput("Complete the sign-in in your browser, or paste a Prime API key below:");
				},
				onProgress: (message) => {
					dialog.showProgress(message);
				},
				signal: browserAbort.signal,
			});
			const browserLoginOrFallback = browserLogin.catch((error: unknown) => {
				if (browserAbort.signal.aborted) {
					throw error;
				}
				const errorMsg = error instanceof Error ? error.message : String(error);
				dialog.showProgress(`Browser sign-in unavailable (${errorMsg}).`);
				if (!manualInputArmed) {
					armManualInput("Paste a Prime API key below:");
				}
				return manualKeyEntry;
			});
			const dialogCancelled = new Promise<never>((_, reject) => {
				dialog.signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
			});
			browserLoginOrFallback.catch(() => {});
			dialogCancelled.catch(() => {});

			const result = await Promise.race([browserLoginOrFallback, manualKeyEntry, dialogCancelled]);
			if (dialog.signal.aborted) {
				closeDialog();
				return { status: "cancelled" };
			}

			if (result.source === "manual") {
				browserAbort.abort();
				dialog.showProgress("Checking Prime Agent trace access...");
				const access = await checkPrimeAgentTracesAccess(result.apiKey, resolvePrimeAgentTracesBaseUrl(), {
					signal: dialog.signal,
				});
				if (dialog.signal.aborted) {
					closeDialog();
					return { status: "cancelled" };
				}
				if (!access.ok) {
					const status = access.status === undefined ? "" : `HTTP ${access.status}: `;
					throw new Error(`Prime API key does not have Prime Agent trace access (${status}${access.message})`);
				}
			}

			return await this.completePrimeAgentTracesLogin(result.apiKey, closeDialog);
		} catch (error: unknown) {
			closeDialog();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (!dialog.signal.aborted && errorMsg !== "Login cancelled") {
				this.host.showError(`Failed to login to ${PRIME_AGENT_TRACES_PROVIDER_NAME}: ${errorMsg}`);
				return { status: "failed" };
			}
			return { status: "cancelled" };
		} finally {
			dialog.signal.removeEventListener("abort", onDialogAbort);
		}
	}

	private async showApiKeyLoginDialog(
		providerId: string,
		providerName: string,
		kind: "provider" | "service" = "provider",
	): Promise<AuthenticationResult> {
		const dialog = new LoginDialogComponent(this.host.ui, providerId, (_success, _message) => {}, providerName);

		const handle = showFullPaneOverlay(this.host.ui, dialog, 88);

		const closeDialog = () => {
			handle.hide();
			this.host.ui.requestRender();
		};

		try {
			const apiKey = (await dialog.showPrompt("Enter API key:")).trim();
			if (!apiKey) {
				throw new Error("API key cannot be empty.");
			}

			this.host.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });

			closeDialog();
			return await this.completeProviderAuthentication(providerId, providerName, "api_key", undefined, kind);
		} catch (error: unknown) {
			closeDialog();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.host.showError(`Failed to save API key for ${providerName}: ${errorMsg}`);
				return { status: "failed" };
			}
			return { status: "cancelled" };
		}
	}

	private showOAuthLoginSelect(dialogHandle: OverlayHandle, prompt: OAuthSelectPrompt): Promise<string | undefined> {
		return new Promise((resolve) => {
			dialogHandle.setHidden(true);
			let selectorHandle: OverlayHandle | undefined;
			const restoreDialog = () => {
				selectorHandle?.hide();
				dialogHandle.setHidden(false);
				dialogHandle.focus();
				this.host.ui.requestRender();
			};
			const labels = prompt.options.map((option) => option.label);
			const selector = new ExtensionSelectorComponent(
				prompt.message,
				labels,
				(optionLabel) => {
					restoreDialog();
					resolve(prompt.options.find((option) => option.label === optionLabel)?.id);
				},
				() => {
					restoreDialog();
					resolve(undefined);
				},
				{ getRows: () => this.host.ui.terminal.rows },
			);
			selectorHandle = showFullPaneOverlay(this.host.ui, selector, 76);
		});
	}

	private async showLoginDialog(
		providerId: string,
		providerName: string,
		kind: "provider" | "service" = "provider",
	): Promise<AuthenticationResult> {
		const providerInfo = this.host.modelRegistry.authStorage
			.getOAuthProviders()
			.find((provider) => provider.id === providerId);

		const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

		const dialog = new LoginDialogComponent(this.host.ui, providerId, (_success, _message) => {}, providerName);

		const dialogHandle = showFullPaneOverlay(this.host.ui, dialog, {
			maxContentWidth: 88,
			suspendFullscreenMouse: true,
		});

		let manualCodeResolve: ((code: string) => void) | undefined;
		let manualCodeReject: ((err: Error) => void) | undefined;
		const manualCodePromise = new Promise<string>((resolve, reject) => {
			manualCodeResolve = resolve;
			manualCodeReject = reject;
		});

		const closeDialog = () => {
			dialogHandle.hide();
			this.host.ui.requestRender();
		};

		try {
			await this.host.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
				onAuth: (info: { url: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions);

					if (usesCallbackServer) {
						dialog
							.showManualInput("Paste redirect URL below, or complete login in browser:")
							.then((value) => {
								if (value && manualCodeResolve) {
									manualCodeResolve(value);
									manualCodeResolve = undefined;
								}
							})
							.catch(() => {
								if (manualCodeReject) {
									manualCodeReject(new Error("Login cancelled"));
									manualCodeReject = undefined;
								}
							});
					} else if (providerId === "github-copilot") {
						dialog.showWaiting("Waiting for browser authentication...");
					}
				},

				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					return dialog.showPrompt(prompt.message, prompt.placeholder);
				},

				onProgress: (message: string) => {
					dialog.showProgress(message);
				},

				onSelect: (prompt: OAuthSelectPrompt) => this.showOAuthLoginSelect(dialogHandle, prompt),

				onManualCodeInput: () => manualCodePromise,

				signal: dialog.signal,
			});

			closeDialog();
			return await this.completeProviderAuthentication(providerId, providerName, "oauth", undefined, kind);
		} catch (error: unknown) {
			closeDialog();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.host.showError(`Failed to login to ${providerName}: ${errorMsg}`);
				return { status: "failed" };
			}
			return { status: "cancelled" };
		}
	}
}
