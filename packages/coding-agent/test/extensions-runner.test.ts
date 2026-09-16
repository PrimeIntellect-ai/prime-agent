/**
 * Tests for ExtensionRunner - conflict detection, error handling, tool wrapping.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createExtensionRuntime, discoverAndLoadExtensions } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { ExtensionActions, ExtensionContextActions, ProviderConfig } from "../src/core/extensions/types.js";
import { KeybindingsManager, type KeyId } from "../src/core/keybindings.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("ExtensionRunner", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	const defaultKeybindings = new KeybindingsManager().getEffectiveConfig();

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		modelRegistry = ModelRegistry.create(AuthStorage.create(path.join(tempDir, "auth.json")));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const providerModelConfig: ProviderConfig = {
		baseUrl: "https://provider.test/v1",
		apiKey: "PROVIDER_TEST_KEY",
		api: "openai-completions",
		models: [
			{
				id: "instant-model",
				name: "Instant Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	};

	const extensionActions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};

	const extensionContextActions: ExtensionContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};

	const writeExt = (file: string, code: string) => fs.writeFileSync(path.join(extensionsDir, file), code);
	const shortcutExt = (key: string) =>
		`export default function(pi) { pi.registerShortcut("${key}", { description: "x", handler: async () => {} }); }`;
	const toolExt = (name: string, description: string) => `
		import { Type } from "typebox";
		export default function(pi) {
			pi.registerTool({
				name: "${name}",
				label: "${name}",
				description: "${description}",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		}
	`;

	async function loadRunner() {
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		expect(result.errors).toEqual([]);
		return {
			result,
			runner: new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry),
		};
	}

	const pasteImageKey = (
		Array.isArray(defaultKeybindings["app.clipboard.pasteImage"])
			? (defaultKeybindings["app.clipboard.pasteImage"][0] ?? "")
			: defaultKeybindings["app.clipboard.pasteImage"]
	) as KeyId;

	// An extension may take over a non-reserved built-in key (with a warning); reserved actions win outright.
	const CONFLICT = "conflicts with built-in";
	const OVERRIDE = "built-in shortcut for app.clipboard.pasteImage";
	it.each([
		{ name: "built-in reserved default", key: "ctrl+c", overrides: {}, allowed: false, warning: CONFLICT },
		{
			name: "reserved default freed by a rebind",
			key: "ctrl+l",
			overrides: { "app.model.select": "ctrl+n" },
			allowed: true,
			warning: null,
		},
		{ name: "non-reserved built-in key", key: pasteImageKey, overrides: {}, allowed: true, warning: OVERRIDE },
		{
			name: "rebound reserved action",
			key: "ctrl+x",
			overrides: { "app.interrupt": "ctrl+x" },
			allowed: false,
			warning: CONFLICT,
		},
		{
			name: "key shared with a reserved default",
			key: "ctrl+o",
			overrides: { "app.clipboard.pasteImage": "ctrl+o" },
			allowed: false,
			warning: CONFLICT,
		},
		{ name: "model cycle forward", key: "alt+m", overrides: {}, allowed: false, warning: CONFLICT },
		{ name: "model cycle backward", key: "shift+alt+m", overrides: {}, allowed: false, warning: CONFLICT },
		{
			name: "reserved action with several keys",
			key: "ctrl+y",
			overrides: { "app.clear": ["ctrl+x", "ctrl+y"] },
			allowed: false,
			warning: CONFLICT,
		},
		{
			name: "non-reserved action with several keys",
			key: "ctrl+y",
			overrides: { "app.clipboard.pasteImage": ["ctrl+x", "ctrl+y"] },
			allowed: true,
			warning: OVERRIDE,
		},
	])("shortcut on $name: allowed=$allowed", async ({ key, overrides, allowed, warning }) => {
		writeExt("shortcut.ts", shortcutExt(key));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { runner } = await loadRunner();
			const shortcuts = runner.getShortcuts({ ...defaultKeybindings, ...overrides } as typeof defaultKeybindings);
			const warned = (needle: string) =>
				warnSpy.mock.calls.some((call) => typeof call[0] === "string" && call[0].includes(needle));

			expect(shortcuts.has(key as KeyId)).toBe(allowed);
			// A blocked key must say so; a freed default must not be reported as a conflict at all.
			expect(warned(warning ?? CONFLICT)).toBe(warning !== null);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("warns and keeps the last registration when two extensions claim one shortcut", async () => {
		writeExt("ext1.ts", shortcutExt("ctrl+shift+x"));
		writeExt("ext2.ts", shortcutExt("ctrl+shift+x"));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { runner } = await loadRunner();

			expect(runner.getShortcuts(defaultKeybindings).has("ctrl+shift+x")).toBe(true);
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("collects tools across extensions and keeps the first registration of a name", async () => {
		writeExt("tool-a.ts", toolExt("tool_a", "a"));
		writeExt("tool-b.ts", toolExt("tool_b", "b"));
		writeExt("a-shared.ts", toolExt("shared", "first"));
		writeExt("b-shared.ts", toolExt("shared", "second"));

		const { runner } = await loadRunner();
		const tools = runner.getAllRegisteredTools();

		expect(tools.map((tool) => tool.definition.name).sort()).toEqual(["shared", "tool_a", "tool_b"]);
		expect(tools.find((tool) => tool.definition.name === "shared")?.definition.description).toBe("first");
	});

	it("collects commands, resolves them by invocation name, and suffixes duplicates in order", async () => {
		const cmdExt = (name: string, description: string) =>
			`export default function(pi) { pi.registerCommand("${name}", { description: "${description}", handler: async () => {} }); }`;
		writeExt("cmd-solo.ts", cmdExt("my-cmd", "My command"));
		writeExt("cmd-a.ts", cmdExt("shared-cmd", "First command"));
		writeExt("cmd-b.ts", cmdExt("shared-cmd", "Second command"));

		const { runner } = await loadRunner();
		const commands = runner.getRegisteredCommands();

		expect(commands.map((command) => command.invocationName).sort()).toEqual([
			"my-cmd",
			"shared-cmd:1",
			"shared-cmd:2",
		]);
		expect(runner.getCommand("shared-cmd:1")?.description).toBe("First command");
		expect(runner.getCommand("shared-cmd:2")?.description).toBe("Second command");
		expect(runner.getCommand("my-cmd")?.name).toBe("my-cmd");
		expect(runner.getCommand("not-exists")).toBeUndefined();
		expect(runner.getCommandDiagnostics()).toEqual([]);
	});

	it("collects flags, keeps the first registration, and records set values", async () => {
		const flagExt = (name: string, description: string, value: boolean) =>
			`export default function(pi) { pi.registerFlag("${name}", { description: "${description}", type: "boolean", default: ${value} }); }`;
		writeExt("a-flag.ts", flagExt("shared-flag", "first", true));
		writeExt("b-flag.ts", flagExt("shared-flag", "second", false));

		const { result, runner } = await loadRunner();

		expect(runner.getFlags().get("shared-flag")?.description).toBe("first");
		expect(result.runtime.flagValues.get("shared-flag")).toBe(true);
		runner.setFlagValue("--test-flag", true);
		expect(result.runtime.flagValues.get("--test-flag")).toBe(true);
	});

	it("resolves message renderers and handler registration by type", async () => {
		writeExt(
			"renderer.ts",
			`export default function(pi) {
				pi.registerMessageRenderer("my-type", () => null);
				pi.on("tool_call", async () => undefined);
			}`,
		);

		const { runner } = await loadRunner();

		expect(runner.getMessageRenderer("my-type")).toBeDefined();
		expect(runner.getMessageRenderer("not-exists")).toBeUndefined();
		expect(runner.hasHandlers("tool_call")).toBe(true);
		expect(runner.hasHandlers("agent_end")).toBe(false);
	});

	it("exposes the current abort signal on ExtensionContext", async () => {
		const { runner } = await loadRunner();
		const controller = new AbortController();
		runner.bindCore(extensionActions, { ...extensionContextActions, getSignal: () => controller.signal });

		const ctx = runner.createContext();
		expect(ctx.signal).toBe(controller.signal);
		expect(ctx.signal?.aborted).toBe(false);
		controller.abort();
		expect(ctx.signal?.aborted).toBe(true);
	});

	it("reports handler exceptions to error listeners instead of throwing", async () => {
		writeExt(
			"throws.ts",
			`export default function(pi) { pi.on("context", async () => { throw new Error("Handler error!"); }); }`,
		);

		const { runner } = await loadRunner();
		const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
		runner.onError((error) => errors.push(error));

		await runner.emitContext([]);

		expect(errors).toHaveLength(1);
		expect(errors[0].event).toBe("context");
		expect(errors[0].error).toContain("Handler error!");
	});

	describe("host timers", () => {
		it("reports throwing ctx timer callbacks and keeps other extensions' timers running", async () => {
			const firedMarker = path.join(tempDir, "other-timer-fired");
			writeExt(
				"throwing-timer.ts",
				`export default function(pi) {
					pi.on("context", async (_event, ctx) => {
						// test-policy: allow wall-clock-timer -- callback executes only under Vitest fake timers
					ctx.setTimeout(() => { throw new Error("timer boom"); }, 5);
						// Userland thenable (not a native Promise): its rejection must land in the boundary too.
						// test-policy: allow wall-clock-timer -- callback executes only under Vitest fake timers
					ctx.setTimeout(() => ({ then(_resolve, reject) { reject(new Error("thenable boom")); } }), 5);
					});
				}`,
			);
			writeExt(
				"healthy-timer.ts",
				`import * as fs from "node:fs";
				export default function(pi) {
					pi.on("context", async (_event, ctx) => {
						// test-policy: allow wall-clock-timer -- callback executes only under Vitest fake timers
					ctx.setTimeout(() => fs.writeFileSync(${JSON.stringify(firedMarker)}, "fired"), 5);
					});
				}`,
			);

			const { runner } = await loadRunner();
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError((error) => errors.push(error));

			vi.useFakeTimers();
			try {
				await runner.emitContext([]);
				await expect(vi.advanceTimersByTimeAsync(10)).resolves.not.toThrow();
			} finally {
				vi.useRealTimers();
			}

			expect(errors).toHaveLength(2);
			for (const error of errors) {
				expect(error.extensionPath).toContain("throwing-timer");
				expect(error.event).toBe("setTimeout");
			}
			expect(errors.map((error) => error.error).sort()).toEqual(["thenable boom", "timer boom"]);
			expect(fs.existsSync(firedMarker)).toBe(true);
		});

		it("routes adopted timer failures through the adopting runner", async () => {
			writeExt(
				"adopted-throwing-timer.ts",
				`export default function(pi) {
					// test-policy: allow wall-clock-timer -- callback executes only under Vitest fake timers
					pi.on("context", async (_event, ctx) => { ctx.setTimeout(() => { throw new Error("adopted boom"); }, 5); });
				}`,
			);

			const { result } = await loadRunner();
			const makeRunner = () =>
				new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
			const oldRunner = makeRunner();
			const newRunner = makeRunner();
			const oldErrors: string[] = [];
			const newErrors: string[] = [];
			oldRunner.onError((error) => oldErrors.push(error.error));
			newRunner.onError((error) => newErrors.push(error.error));

			vi.useFakeTimers();
			try {
				await oldRunner.emitContext([]);
				newRunner.adoptHostTimers(oldRunner);
				vi.advanceTimersByTime(10);
			} finally {
				vi.useRealTimers();
			}

			expect(oldErrors).toEqual([]);
			expect(newErrors).toEqual(["adopted boom"]);
		});

		it.each([
			{ name: "invalidate cancels pending ctx timers so nothing fires after unload", clearInExtension: false },
			{ name: "ctx.clearTimeout cancels a pending ctx timer", clearInExtension: true },
		])("$name", async ({ clearInExtension }) => {
			const firedMarker = path.join(tempDir, "timer-fired");
			writeExt(
				"pending-timers.ts",
				`import * as fs from "node:fs";
				export default function(pi) {
					pi.on("context", async (_event, ctx) => {
						const fire = () => fs.writeFileSync(${JSON.stringify(firedMarker)}, "fired");
						// test-policy: allow wall-clock-timer -- callback executes only under Vitest fake timers
						const handle = ctx.setTimeout(fire, 5);
						if (${clearInExtension}) ctx.clearTimeout(handle);
						// test-policy: allow wall-clock-timer -- callback executes only under Vitest fake timers
						else ctx.setInterval(fire, 5);
					});
				}`,
			);

			const { runner } = await loadRunner();

			vi.useFakeTimers();
			try {
				await runner.emitContext([]);
				if (!clearInExtension) runner.invalidate();
				vi.advanceTimersByTime(50);
			} finally {
				vi.useRealTimers();
			}

			expect(fs.existsSync(firedMarker)).toBe(false);
		});

		it("cannot reactivate a fired ctx timeout via handle.refresh()", async () => {
			// Real timers on purpose: the guarantee rides on native Node clearTimeout semantics, which fake timers do not reproduce.
			const countFile = path.join(tempDir, "refresh-fire-count");
			writeExt(
				"refreshing-timer.ts",
				`import * as fs from "node:fs";
				export default function(pi) {
					let handle;
					pi.on("context", async (_event, ctx) => {
						if (!handle) {
							handle = ctx.setTimeout(() => {
								const count = fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, "utf8")) : 0;
								fs.writeFileSync(${JSON.stringify(countFile)}, String(count + 1));
							}, 5);
						} else {
							handle.refresh();
						}
					});
				}`,
			);

			const { runner } = await loadRunner();

			await runner.emitContext([]);
			await vi.waitFor(() => expect(fs.existsSync(countFile)).toBe(true));
			await runner.emitContext([]);
			await new Promise((resolve) => setTimeout(resolve, 40));

			expect(fs.readFileSync(countFile, "utf8")).toBe("1");
		});
	});

	describe("input events", () => {
		const origImages = [{ type: "image" as const, data: "orig", mimeType: "image/png" }];
		const onInput = (body: string) => `export default p => p.on("input", async e => { ${body} });`;
		const globals = globalThis as unknown as { __inputSources?: string[]; __inputReachedSecond?: boolean };

		async function runnerWith(...extensions: string[]) {
			extensions.forEach((code, index) => {
				writeExt(`input-${index}.ts`, code);
			});
			const { runner } = await loadRunner();
			return runner;
		}

		it.each([
			{ name: "no handlers", exts: [] as string[], expected: { action: "continue" } },
			{ name: "a handler returning undefined", exts: [onInput("")], expected: { action: "continue" } },
			{
				name: "an explicit continue",
				exts: [onInput(`return { action: "continue" };`)],
				expected: { action: "continue" },
			},
			{
				name: "a transform that omits images",
				exts: [onInput(`return { action: "transform", text: "T:" + e.text };`)],
				expected: { action: "transform", text: "T:hi", images: origImages },
			},
			{
				name: "a transform that replaces images",
				exts: [
					onInput(
						`return { action: "transform", text: "X", images: [{ type: "image", data: "new", mimeType: "image/jpeg" }] };`,
					),
				],
				expected: {
					action: "transform",
					text: "X",
					images: [{ type: "image", data: "new", mimeType: "image/jpeg" }],
				},
			},
			{
				name: "transforms chained across two handlers",
				exts: [
					onInput(`return { action: "transform", text: e.text + "[1]" };`),
					onInput(`return { action: "transform", text: e.text + "[2]" };`),
				],
				expected: { action: "transform", text: "hi[1][2]", images: origImages },
			},
		])("emitInput resolves $name", async ({ exts, expected }) => {
			const runner = await runnerWith(...exts);

			expect(await runner.emitInput("hi", origImages, "interactive")).toMatchObject(expected);
			expect(runner.hasHandlers("input")).toBe(exts.length > 0);
		});

		it("short-circuits on handled, reports handler errors, and passes the source through", async () => {
			globals.__inputSources = undefined;
			globals.__inputReachedSecond = undefined;
			const runner = await runnerWith(
				onInput(
					`globalThis.__inputSources = [...(globalThis.__inputSources ?? []), e.source];
					if (e.text === "boom") throw new Error("boom");
					if (e.text === "stop") return { action: "handled" };`,
				),
				onInput(`globalThis.__inputReachedSecond = true;`),
			);
			const errors: string[] = [];
			runner.onError((error) => errors.push(error.error));

			expect(await runner.emitInput("stop", undefined, "interactive")).toEqual({ action: "handled" });
			expect(globals.__inputReachedSecond).toBeUndefined();

			expect((await runner.emitInput("boom", undefined, "rpc")).action).toBe("continue");
			expect(errors).toContain("boom");
			expect(globals.__inputReachedSecond).toBe(true);

			await runner.emitInput("plain", undefined, "extension");
			expect(globals.__inputSources).toEqual(["interactive", "rpc", "extension"]);
		});
	});

	it("chains system prompt updates and keeps ctx.getSystemPrompt() in sync", async () => {
		const promptExt = (suffix: string) => `
			export default function(pi) {
				pi.on("before_agent_start", async (_event, ctx) => ({ systemPrompt: ctx.getSystemPrompt() + "\\n${suffix}" }));
			}
		`;
		writeExt("before-agent-start-1.ts", promptExt("first"));
		writeExt("before-agent-start-2.ts", promptExt("second"));

		const { runner } = await loadRunner();
		const errors: string[] = [];
		runner.onError((error) => errors.push(error.error));
		runner.bindCore(extensionActions, extensionContextActions);

		const chained = await runner.emitBeforeAgentStart("hello", undefined, "base", { cwd: tempDir });

		expect(errors).toEqual([]);
		expect(chained).toEqual({ messages: undefined, systemPrompt: "base\nfirst\nsecond" });
	});

	it("chains tool_result content and preserves earlier patches under partial ones", async () => {
		writeExt(
			"tool-result-1.ts",
			`export default function(pi) {
				pi.on("tool_result", async (event) => ({
					content: [...event.content, { type: "text", text: "ext1" }],
					details: { source: "ext1" },
				}));
			}`,
		);
		writeExt(
			"tool-result-2.ts",
			`export default function(pi) {
				pi.on("tool_result", async (event) => ({ content: [...event.content, { type: "text", text: "ext2" }], isError: true }));
			}`,
		);

		const { runner } = await loadRunner();

		const chained = await runner.emitToolResult({
			type: "tool_result",
			toolName: "my_tool",
			toolCallId: "call-1",
			input: {},
			content: [{ type: "text", text: "base" }],
			details: { initial: true },
			isError: false,
		});

		expect(chained?.content?.[0]).toEqual({ type: "text", text: "base" });
		expect(
			chained?.content
				?.slice(1)
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text)
				.sort(),
		).toEqual(["ext1", "ext2"]);
		// The second handler patched only isError, so the first handler's details survive.
		expect(chained?.details).toEqual({ source: "ext1" });
		expect(chained?.isError).toBe(true);
	});

	it("returns asynchronous session-name failures to extensions", async () => {
		const runtime = createExtensionRuntime();
		const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);
		const failure = new Error("duplicate session name");
		runner.bindCore(
			{ ...extensionActions, setSessionName: async () => Promise.reject(failure) },
			extensionContextActions,
		);

		await expect(runtime.setSessionName("duplicate")).rejects.toBe(failure);
	});

	describe("provider registration", () => {
		it("bindCore ignores invalid queued registrations and reports the extension error", () => {
			const runtime = createExtensionRuntime();
			runtime.registerProvider(
				"broken-provider",
				{
					streamSimple: (() => {
						throw new Error("should not run");
					}) as never,
				},
				"/tmp/broken-extension.ts",
			);

			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);
			const errors: string[] = [];
			runner.onError((error) => errors.push(error.extensionPath));

			expect(() => runner.bindCore(extensionActions, extensionContextActions)).not.toThrow();
			expect(errors).toEqual(["/tmp/broken-extension.ts"]);
			expect(() => modelRegistry.refresh()).not.toThrow();
		});

		it("unregister drops queued registrations before bind and live models after bind", () => {
			const runtime = createExtensionRuntime();
			runtime.registerProvider("queued-provider", providerModelConfig);
			runtime.registerProvider("queued-provider", providerModelConfig);
			expect(runtime.pendingProviderRegistrations).toHaveLength(2);
			runtime.unregisterProvider("queued-provider");
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);

			const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);
			runner.bindCore(extensionActions, extensionContextActions);

			runtime.registerProvider("instant-provider", providerModelConfig);
			expect(runtime.pendingProviderRegistrations).toHaveLength(0);
			expect(modelRegistry.find("instant-provider", "instant-model")).toBeDefined();
			runtime.unregisterProvider("instant-provider");
			expect(modelRegistry.find("instant-provider", "instant-model")).toBeUndefined();
		});
	});

	it("passes fork options through to the bound command handler", async () => {
		const runtime = createExtensionRuntime();
		const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);
		const fork = vi.fn(async () => ({ cancelled: false }));

		runner.bindCommandContext({
			waitForIdle: async () => {},
			newSession: async () => ({ cancelled: false }),
			fork,
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {},
		});

		const commandContext = runner.createCommandContext();
		await commandContext.fork("entry-1");
		expect(fork).toHaveBeenCalledWith("entry-1", undefined);

		await commandContext.fork("entry-2", { position: "at" });
		expect(fork).toHaveBeenLastCalledWith("entry-2", { position: "at" });
	});
});
