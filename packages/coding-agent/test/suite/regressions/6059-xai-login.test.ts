import type { AutocompleteItem, Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS, parseSlashCommand } from "../../../src/core/slash-commands.js";
import {
	type AuthenticationResult,
	ProviderAuthFlows,
	type ProviderAuthFlowsHost,
} from "../../../src/modes/interactive/auth-flows.js";
import type { AuthSelectorProvider } from "../../../src/modes/interactive/components/oauth-selector.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const xaiOptions: AuthSelectorProvider[] = [
	{ id: "xai", name: "xAI", authType: "oauth" },
	{ id: "xai", name: "xAI", authType: "api_key" },
];
const savedCredential = { type: "api_key" as const, key: "old-test-key" };

type LoginContext = {
	createAuthFlows: () => ProviderAuthFlows;
	showConfigurationMenu: (tab: string) => Promise<void>;
	prepareForModelSelectionAfterLogin: (result: AuthenticationResult) => Promise<boolean>;
	showModelSelector: () => void;
	showError: (message: string) => void;
};
const prototype = InteractiveMode.prototype as unknown as {
	handleLoginCommand(this: LoginContext, args: string): Promise<void>;
	getLoginArgumentCompletions(this: LoginContext, prefix: string): AutocompleteItem[] | null;
};

describe("ENG-6059 provider-specific login", () => {
	let harness: Harness;
	let overlays: Component[];
	let host: ProviderAuthFlowsHost;
	let flows: ProviderAuthFlows;

	beforeAll(() => initTheme("dark"));
	beforeEach(async () => {
		vi.stubEnv("XAI_API_KEY", "");
		harness = await createHarness();
		overlays = [];
		host = {
			ui: {
				terminal: { columns: 100, rows: 30 },
				requestRender: vi.fn(),
				showOverlay: vi.fn((component: Component): OverlayHandle => {
					overlays.push(component);
					return {
						hide: vi.fn(),
						setHidden: vi.fn(),
						isHidden: () => false,
						focus: vi.fn(),
						unfocus: vi.fn(),
						isFocused: () => true,
					};
				}),
			} as unknown as TUI,
			modelRegistry: harness.session.modelRegistry,
			showStatus: vi.fn(),
			showError: vi.fn(),
			getAvailableModels: vi.fn(async () => [{ provider: "xai" }]),
			onAuthChanged: vi.fn(async () => {}),
		};
		flows = new ProviderAuthFlows(host);
	});
	afterEach(() => {
		harness.cleanup();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	function context(): LoginContext {
		return {
			createAuthFlows: () => flows,
			showConfigurationMenu: vi.fn(async () => {}),
			prepareForModelSelectionAfterLogin: vi.fn(async () => false),
			showModelSelector: vi.fn(),
			showError: host.showError,
		};
	}

	function output(index = overlays.length - 1): string {
		return stripAnsi(overlays[index].render(100).join("\n"));
	}

	it("routes /login xai without changing the bare /login configuration menu", async () => {
		expect(parseSlashCommand("/login xai")).toEqual({ name: "login", args: "xai" });
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "login")).toMatchObject({
			argumentHint: "[provider]",
			takesArgument: true,
		});
		const runLogin = vi.spyOn(flows, "runLogin").mockResolvedValue({ status: "cancelled" });
		const ctx = context();
		await prototype.handleLoginCommand.call(ctx, "");
		expect(ctx.showConfigurationMenu).toHaveBeenCalledWith("providers");
		expect(runLogin).not.toHaveBeenCalled();
		await prototype.handleLoginCommand.call(ctx, "xai");
		expect(runLogin).toHaveBeenCalledWith({ providerId: "xai" });
		expect(ctx.prepareForModelSelectionAfterLogin).not.toHaveBeenCalled();
		await prototype.handleLoginCommand.call(ctx, "xai extra");
		expect(ctx.showError).toHaveBeenCalledWith("Usage: /login [provider]");
	});

	it("completes each provider once and keeps the selected model after xAI login", async () => {
		vi.spyOn(flows, "getLoginProviderOptions").mockReturnValue(xaiOptions);
		vi.spyOn(flows, "runLogin").mockResolvedValue({
			status: "success",
			providerId: "xai",
			providerName: "xAI",
			authType: "oauth",
		});
		const ctx = context();
		expect(prototype.getLoginArgumentCompletions.call(ctx, "x")?.map((item) => item.value)).toEqual(["xai"]);
		expect(prototype.getLoginArgumentCompletions.call(ctx, "missing")).toBeNull();
		await prototype.handleLoginCommand.call(ctx, "xai");
		expect(ctx.showModelSelector).not.toHaveBeenCalled();
	});

	it.each([0, 1])("shows only xAI methods and selects auth type %s", async (index) => {
		vi.spyOn(flows, "getLoginProviderOptions").mockReturnValue([
			...xaiOptions,
			{ id: "other", name: "Other", authType: "api_key" },
		]);
		const loginProvider = vi.spyOn(flows, "loginProvider").mockResolvedValue({ status: "cancelled" });
		const result = flows.runLogin({ providerId: "xai" });
		expect(output()).toContain("Login to xAI");
		expect(output()).toContain("Use a subscription");
		expect(output()).toContain("Use an API key");
		expect(output()).not.toContain("Other");
		if (index === 1) overlays[0].handleInput?.("\x1b[B");
		overlays[0].handleInput?.("\r");
		await result;
		expect(loginProvider).toHaveBeenCalledWith(xaiOptions[index]);
	});

	it("rejects an unknown provider without starting authentication", async () => {
		const result = await flows.runLogin({ providerId: "missing-provider" });
		expect(result).toEqual({ status: "failed" });
		expect(overlays).toHaveLength(0);
		expect(host.showError).toHaveBeenCalledWith(expect.stringContaining("Unknown login provider"));
	});

	it("cancels the method picker without replacing credentials", async () => {
		harness.authStorage.set("xai", savedCredential);
		vi.spyOn(flows, "getLoginProviderOptions").mockReturnValue(xaiOptions);
		const result = flows.runLogin({ providerId: "xai" });
		overlays[0].handleInput?.("\x1b");
		expect(await result).toEqual({ status: "cancelled" });
		expect(harness.authStorage.get("xai")).toEqual(savedCredential);
	});

	it("uses the existing environment key only after explicit selection, without copying it", async () => {
		vi.stubEnv("XAI_API_KEY", "test-env-secret");
		harness.authStorage.set("xai", savedCredential);
		const result = flows.loginProvider(xaiOptions[1]);
		expect(output()).toContain("Use XAI_API_KEY");
		expect(output()).toContain("Enter a new API key");
		expect(output()).not.toContain("test-env-secret");
		expect(harness.authStorage.get("xai")).toEqual(savedCredential);
		overlays.at(-1)?.handleInput?.("\r");
		expect(await result).toMatchObject({ status: "success", authType: "api_key" });
		expect(harness.authStorage.get("xai")).toBeUndefined();
		expect(host.onAuthChanged).toHaveBeenCalledOnce();
		expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining("no key copied"));
	});

	it("does not claim success when the backend cannot use the environment key", async () => {
		vi.stubEnv("XAI_API_KEY", "test-env-secret");
		harness.authStorage.set("xai", savedCredential);
		host.getAvailableModels = vi.fn(async () => []);
		const result = flows.loginProvider(xaiOptions[1]);
		overlays.at(-1)?.handleInput?.("\r");
		expect(await result).toEqual({ status: "failed" });
		expect(host.showStatus).not.toHaveBeenCalled();
		expect(host.showError).toHaveBeenCalledWith(expect.stringContaining("enter an API key"));
	});

	it("stops when removing the saved credential fails", async () => {
		vi.stubEnv("XAI_API_KEY", "test-env-secret");
		harness.authStorage.set("xai", savedCredential);
		vi.spyOn(harness.authStorage, "removeVerified").mockImplementation(() => {
			throw new Error("Cannot write auth.json");
		});
		const result = flows.loginProvider(xaiOptions[1]);
		overlays.at(-1)?.handleInput?.("\r");
		expect(await result).toEqual({ status: "failed" });
		expect(harness.authStorage.get("xai")).toEqual(savedCredential);
		expect(host.onAuthChanged).not.toHaveBeenCalled();
		expect(host.showStatus).not.toHaveBeenCalled();
		expect(host.showError).toHaveBeenCalledWith(expect.stringContaining("Cannot write auth.json"));
	});

	it("cancels environment-key selection without deleting the saved credential", async () => {
		vi.stubEnv("XAI_API_KEY", "test-env-secret");
		harness.authStorage.set("xai", savedCredential);
		const result = flows.loginProvider(xaiOptions[1]);
		overlays.at(-1)?.handleInput?.("\x1b");
		expect(await result).toEqual({ status: "cancelled" });
		expect(harness.authStorage.get("xai")).toEqual(savedCredential);
		expect(host.onAuthChanged).not.toHaveBeenCalled();
	});

	it.each(["cancel", "empty", "replace"])(
		"preserves the old subscription until key entry completes: %s",
		async (action) => {
			const subscription = {
				type: "oauth" as const,
				access: "test-access",
				refresh: "test-refresh",
				expires: Date.now() + 60_000,
			};
			harness.authStorage.set("xai", subscription);
			const result = flows.loginProvider(xaiOptions[1]);
			expect(output()).toContain("replaces the saved credential");
			expect(harness.authStorage.get("xai")).toEqual(subscription);
			if (action === "replace") overlays[0].handleInput?.("new-test-key");
			overlays[0].handleInput?.(action === "cancel" ? "\x1b" : "\r");
			expect(await result).toMatchObject({
				status: action === "cancel" ? "cancelled" : action === "empty" ? "failed" : "success",
			});
			expect(harness.authStorage.get("xai")).toEqual(
				action === "replace" ? { type: "api_key", key: "new-test-key" } : subscription,
			);
		},
	);

	it.each([false, true])(
		"refreshes model metadata after authentication and ignores replaced sessions: %s",
		async (replaceSession) => {
			const model = harness.getModel();
			const state = {
				sessionId: "session-1",
				model,
				scopedModels: [{ model }],
				serviceTier: "default",
				availableThinkingLevels: ["off"],
			};
			const ctx = {
				agentConnection: { getState: vi.fn(async () => state) },
				connectionState: { sessionId: "session-1" },
				invalidateConnectionModels: vi.fn(),
				getConnectionAvailableModels: vi.fn(async () => {
					if (replaceSession) ctx.connectionState.sessionId = "session-2";
					return [];
				}),
				patchConnectionState: vi.fn(),
				subagentSummaryLine: { invalidate: vi.fn() },
				setupAutocompleteProvider: vi.fn(),
			};
			const refresh = (
				InteractiveMode.prototype as unknown as {
					refreshConnectionModelsAfterAuthChange(this: typeof ctx): Promise<void>;
				}
			).refreshConnectionModelsAfterAuthChange;
			await refresh.call(ctx);
			expect(ctx.getConnectionAvailableModels.mock.invocationCallOrder[0]).toBeLessThan(
				ctx.agentConnection.getState.mock.invocationCallOrder[0],
			);
			if (replaceSession) {
				expect(ctx.patchConnectionState).not.toHaveBeenCalled();
			} else {
				expect(ctx.patchConnectionState).toHaveBeenCalledWith({
					model,
					scopedModels: state.scopedModels,
					serviceTier: "default",
					availableThinkingLevels: ["off"],
				});
				expect(ctx.setupAutocompleteProvider).toHaveBeenCalledOnce();
			}
		},
	);
});
