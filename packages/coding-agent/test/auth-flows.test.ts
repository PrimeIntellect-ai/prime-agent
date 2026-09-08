import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import {
	type AuthFlowObservation,
	ProviderAuthFlows,
	type ProviderAuthFlowsHost,
} from "../src/modes/interactive/auth-flows.js";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function createOverlayHandle(): OverlayHandle {
	return {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: () => false,
		focus: vi.fn(),
		unfocus: vi.fn(),
		isFocused: () => true,
	};
}

function createFakeTui(overlays: Component[] = []): TUI {
	return {
		terminal: { columns: 80, rows: 24 },
		requestRender: vi.fn(),
		showOverlay: vi.fn((component: Component) => {
			overlays.push(component);
			return createOverlayHandle();
		}),
	} as unknown as TUI;
}

function createHost(authStorage: AuthStorage): {
	host: ProviderAuthFlowsHost;
	statusMessages: string[];
	errorMessages: string[];
	overlays: Component[];
} {
	const statusMessages: string[] = [];
	const errorMessages: string[] = [];
	const overlays: Component[] = [];
	const modelRegistry = {
		authStorage,
		refresh: vi.fn(),
		getAll: () => [],
		getProviderDisplayName: (providerId: string) => providerId,
		getProviderAuthStatus: (providerId: string) => authStorage.getAuthStatus(providerId),
	} as unknown as ModelRegistry;

	return {
		host: {
			ui: createFakeTui(overlays),
			modelRegistry,
			showStatus: (message) => statusMessages.push(message),
			showError: (message) => errorMessages.push(message),
			getAvailableModels: async () => [],
		},
		statusMessages,
		errorMessages,
		overlays,
	};
}

describe("ProviderAuthFlows", () => {
	let tempDir: string;
	let authJsonPath: string;
	let primeConfigPath: string;
	let originalHome: string | undefined;
	let originalPrimeTeamId: string | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-auth-flows-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
		primeConfigPath = join(tempDir, "prime-config.json");
		writeFileSync(authJsonPath, "{}");
		originalHome = process.env.HOME;
		originalPrimeTeamId = process.env.PRIME_TEAM_ID;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalPrimeTeamId === undefined) {
			delete process.env.PRIME_TEAM_ID;
		} else {
			process.env.PRIME_TEAM_ID = originalPrimeTeamId;
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
	});

	it("preserves the Prime CLI team when login reuses the existing Prime CLI key", async () => {
		process.env.PRIME_TEAM_ID = "env-team";
		writeFileSync(
			primeConfigPath,
			JSON.stringify({
				api_key: "prime-cli-key",
				team_id: "cli-team",
				team_name: "CLI Research",
				team_role: "admin",
			}),
		);
		writeFileSync(
			authJsonPath,
			JSON.stringify({
				[PRIME_INFERENCE_PROVIDER_ID]: {
					type: "api_key",
					key: "legacy-agent-key",
				},
			}),
		);
		const authStorage = AuthStorage.create(authJsonPath, {
			primeCliConfigPath: primeConfigPath,
			usePrimeCliConfig: true,
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				data: { scope: { inference: { write: true } } },
			}),
		);
		const { host, statusMessages, errorMessages } = createHost(authStorage);
		const observations: AuthFlowObservation[] = [];
		host.onAuthObservation = (observation) => observations.push(observation);
		const finish = vi.fn();
		host.onAuthenticationStarted = vi.fn(() => finish);

		const result = await new ProviderAuthFlows(host).runPrimeInferenceLogin();

		expect(errorMessages).toEqual([]);
		expect(result.status).toBe("success");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "success" }));
		expect(observations).toContainEqual(
			expect.objectContaining({
				stage: "credential_validation",
				outcome: "completed",
				method: "existing_configuration",
				validationScope: "identity_scope",
				durationMs: expect.any(Number),
				systemWork: true,
			}),
		);
		expect(
			observations.some(
				(observation) =>
					observation.validationScope === "inference" || observation.validationScope === "selected_context",
			),
		).toBe(false);
		expect(JSON.stringify(observations)).not.toContain("prime-cli-key");
		expect(statusMessages.join("\n")).toContain("Using team from PRIME_TEAM_ID.");

		const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
		expect(config.api_key).toBe("prime-cli-key");
		expect(config.team_id).toBe("cli-team");
		expect(config.team_name).toBe("CLI Research");
		expect(config.team_role).toBe("admin");
		expect(authStorage.has(PRIME_INFERENCE_PROVIDER_ID)).toBe(false);
	});

	it("stores a reused Prime CLI key when Prime CLI config sync is disabled", async () => {
		process.env.HOME = tempDir;
		process.env.PRIME_TEAM_ID = "env-team";
		const defaultPrimeDir = join(tempDir, ".prime");
		mkdirSync(defaultPrimeDir, { recursive: true });
		writeFileSync(join(defaultPrimeDir, "config.json"), JSON.stringify({ api_key: "prime-cli-key" }));
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				data: { scope: { inference: { write: true } } },
			}),
		);
		const { host, errorMessages } = createHost(authStorage);

		const result = await new ProviderAuthFlows(host).runPrimeInferenceLogin();

		expect(errorMessages).toEqual([]);
		expect(result.status).toBe("success");
		expect(fetchMock).toHaveBeenCalledOnce();
		await expect(authStorage.getApiKey(PRIME_INFERENCE_PROVIDER_ID)).resolves.toBe("prime-cli-key");
		expect(authStorage.getAuthStatus(PRIME_INFERENCE_PROVIDER_ID)).toEqual({
			configured: true,
			source: "stored",
		});

		const authData = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<
			string,
			{ type?: string; key?: string }
		>;
		expect(authData[PRIME_INFERENCE_PROVIDER_ID]).toEqual({
			type: "api_key",
			key: "prime-cli-key",
		});
	});

	it("offers Prime Inference logout when auth comes from the Prime CLI config", async () => {
		writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
		const authStorage = AuthStorage.create(authJsonPath, {
			primeCliConfigPath: primeConfigPath,
			usePrimeCliConfig: true,
		});
		const { host, overlays } = createHost(authStorage);

		const logoutResult = new ProviderAuthFlows(host).runLogout();

		expect(overlays).toHaveLength(1);
		expect(stripAnsi(overlays[0]?.render(80).join("\n") ?? "")).toContain("Prime Inference");
		overlays[0]?.handleInput?.("\x1b");
		await expect(logoutResult).resolves.toBeNull();
	});

	it("opens login on the requested MCP Connections category", async () => {
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		const { host, overlays } = createHost(authStorage);

		const loginResult = new ProviderAuthFlows(host).runLogin({ initialCategory: "service" });

		expect(overlays).toHaveLength(1);
		const output = stripAnsi(overlays[0]?.render(80).join("\n") ?? "");
		expect(output).toContain("Serper (web search)");
		expect(output).not.toContain("Anthropic");
		overlays[0]?.handleInput?.("\x1b");
		await expect(loginResult).resolves.toEqual({ status: "cancelled" });
	});

	it("reports an API key save as configured without claiming a provider check", async () => {
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		const { host } = createHost(authStorage);
		const observations: AuthFlowObservation[] = [];
		host.onAuthObservation = (observation) => observations.push(observation);
		const finish = vi.fn();
		host.onAuthenticationStarted = () => finish;
		const fetchMock = vi.spyOn(globalThis, "fetch");
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("private-api-key");

		const result = await new ProviderAuthFlows(host).loginProvider({
			id: "openai",
			name: "OpenAI",
			authType: "api_key",
		});

		expect(result.status).toBe("success");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "success" }));
		expect(observations).toEqual([
			{
				providerId: "openai",
				stage: "credential_discovery",
				outcome: "configured",
				method: "api_key_entry",
				validationScope: "configuration",
			},
			{
				providerId: "openai",
				stage: "credential_validation",
				outcome: "unavailable",
				method: "api_key_entry",
				validationScope: "unchecked",
			},
		]);
		expect(JSON.stringify(observations)).not.toContain("private-api-key");
	});

	it("reports cancellation without manufacturing a failed authentication check", async () => {
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		const { host } = createHost(authStorage);
		const finish = vi.fn();
		host.onAuthenticationStarted = () => finish;
		host.onAuthObservation = vi.fn();
		host.onAuthError = vi.fn();
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockRejectedValue(new Error("Login cancelled"));

		await expect(
			new ProviderAuthFlows(host).loginProvider({ id: "openai", name: "OpenAI", authType: "api_key" }),
		).resolves.toEqual({ status: "cancelled" });
		expect(finish).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" });
		expect(host.onAuthObservation).not.toHaveBeenCalled();
		expect(host.onAuthError).not.toHaveBeenCalled();
	});

	it("reports failed logout separately from cancel and unavailable credentials", async () => {
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		authStorage.set("openai", { type: "api_key", key: "private-api-key" });
		const { host, overlays } = createHost(authStorage);
		const failure = new Error("Permission denied");
		vi.spyOn(authStorage, "logout").mockImplementation(() => {
			throw failure;
		});
		host.onAuthError = vi.fn();
		const finish = vi.fn();

		const result = new ProviderAuthFlows(host).runLogout(finish);
		overlays[0]?.handleInput?.("\r");

		await expect(result).resolves.toBeNull();
		expect(finish).toHaveBeenCalledExactlyOnceWith("failed");
		expect(host.onAuthError).toHaveBeenCalledExactlyOnceWith(failure, "openai", "logout");
	});

	it("does not let optional observation callbacks interrupt a login", async () => {
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		const { host } = createHost(authStorage);
		host.onAuthenticationStarted = () => {
			throw new Error("observer failed");
		};
		host.onAuthObservation = () => {
			throw new Error("observer failed");
		};
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("private-api-key");

		await expect(
			new ProviderAuthFlows(host).loginProvider({ id: "openai", name: "OpenAI", authType: "api_key" }),
		).resolves.toMatchObject({ status: "success" });
	});
});
