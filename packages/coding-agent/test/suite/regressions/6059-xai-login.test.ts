import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthFlows, type ProviderAuthFlowsHost } from "../../../src/modes/interactive/auth-flows.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

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

	it("opens the xAI method chooser for /login xai and leaves bare /login unchanged", async () => {
		const ctx = {
			createAuthFlows: () => flows,
			showConfigurationMenu: vi.fn(async () => {}),
			prepareForModelSelectionAfterLogin: vi.fn(async () => false),
			showModelSelector: vi.fn(),
			showError: host.showError,
		};
		const handleLogin = (
			InteractiveMode.prototype as unknown as {
				handleLoginCommand(this: typeof ctx, args: string): Promise<void>;
			}
		).handleLoginCommand;
		await handleLogin.call(ctx, "");
		expect(ctx.showConfigurationMenu).toHaveBeenCalledWith("providers");
		const loginProvider = vi.spyOn(flows, "loginProvider").mockResolvedValue({ status: "cancelled" });
		const pending = handleLogin.call(ctx, "xai");
		const output = stripAnsi(overlays[0].render(100).join("\n"));
		expect(output).toContain("Login to xAI");
		expect(output).toContain("Use a subscription");
		expect(output).toContain("Use an API key");
		overlays[0].handleInput?.("\x1b[B");
		overlays[0].handleInput?.("\r");
		await pending;
		expect(loginProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "xai", authType: "api_key" }));
	});

	it("activates the environment key only after selection and backend confirmation", async () => {
		vi.stubEnv("XAI_API_KEY", "test-env-secret");
		const credential = { type: "api_key" as const, key: "old-test-key" };
		harness.authStorage.set("xai", credential);
		const provider = { id: "xai", name: "xAI", authType: "api_key" as const };
		const pending = flows.loginProvider(provider);
		const output = stripAnsi(overlays.at(-1)!.render(100).join("\n"));
		expect(output).toContain("Use XAI_API_KEY");
		expect(output).not.toContain("test-env-secret");
		expect(harness.authStorage.get("xai")).toEqual(credential);
		overlays.at(-1)?.handleInput?.("\r");
		expect(await pending).toMatchObject({ status: "success", authType: "api_key" });
		expect(harness.authStorage.get("xai")).toBeUndefined();
		expect(host.onAuthChanged).toHaveBeenCalledOnce();
		host.getAvailableModels = vi.fn(async () => []);
		vi.mocked(host.showStatus).mockClear();
		const unavailable = flows.loginProvider(provider);
		overlays.at(-1)?.handleInput?.("\r");
		expect(await unavailable).toEqual({ status: "failed" });
		expect(host.showStatus).not.toHaveBeenCalled();
	});
});
