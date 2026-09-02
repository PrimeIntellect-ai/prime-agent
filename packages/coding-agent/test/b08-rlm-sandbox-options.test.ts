import { readdir as readdirAsync, stat as statAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { normalizeSandboxOptions } from "../src/core/execution-location.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	normalizeRequestedRlmSubagentSandbox,
	normalizeRequestedRlmSubagentSandboxOptions,
	type SubagentRuntimeHost,
} from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-opus-4-5");

let tempDir: string;
let session: AgentSession | undefined;

function createSession(
	options: { depth?: number; maxDepth?: number; subagentRuntimeHost?: SubagentRuntimeHost } = {},
): AgentSession {
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
	const settingsManager = SettingsManager.create(tempDir, tempDir);

	const agent = new Agent({
		convertToLlm,
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "",
			tools: [],
			thinkingLevel: "off",
		},
		streamFn: () => createAssistantMessageEventStream(),
	});

	const s = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
		resourceLoader: createTestResourceLoader(),
		subagentRuntimeHost: options.subagentRuntimeHost,
		rlmDepth: options.depth,
		rlmMaxDepth: options.maxDepth,
	});
	session = s;
	return s;
}

describe("B08 rlm.run sandbox options", () => {
	beforeEach(() => {
		tempDir = join(tmpdir(), `b08-rlm-sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
	});

	// -- normalizeSandboxOptions (core) --

	it("normalizeSandboxOptions accepts undefined", () => {
		expect(normalizeSandboxOptions(undefined)).toBeUndefined();
	});

	it("normalizeSandboxOptions accepts null", () => {
		expect(normalizeSandboxOptions(null)).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects array", () => {
		expect(normalizeSandboxOptions([1, 2])).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects revoked proxy without throwing", () => {
		const { proxy, revoke } = Proxy.revocable({ region: "us-east-1" }, {});
		revoke();
		expect(() => normalizeSandboxOptions(proxy)).not.toThrow();
		expect(normalizeSandboxOptions(proxy)).toBeUndefined();
	});

	it("normalizeSandboxOptions rejects revoked proxy (empty)", () => {
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		expect(() => normalizeSandboxOptions(proxy)).not.toThrow();
		expect(normalizeSandboxOptions(proxy)).toBeUndefined();
	});

	it("normalizeSandboxOptions returns frozen empty object with zero own keys", () => {
		const result = normalizeSandboxOptions({});
		expect(result).toBeDefined();
		expect(Object.isFrozen(result!)).toBe(true);
		expect(Object.keys(result!)).toEqual([]);
	});

	it("normalizeSandboxOptions returns frozen region copy with one own key", () => {
		const result = normalizeSandboxOptions({ region: "us-east-1" });
		expect(result).toEqual({ region: "us-east-1" });
		expect(Object.isFrozen(result!)).toBe(true);
		expect(Object.keys(result!)).toEqual(["region"]);
	});

	it("normalizeSandboxOptions does not echo rejected values in result", () => {
		expect(normalizeSandboxOptions({ apiKey: "sk-1234567890abcdef" })).toBeUndefined();
	});

	// -- normalizeRequestedRlmSubagentSandbox --

	it("accepts undefined sandbox kwarg", () => {
		expect(normalizeRequestedRlmSubagentSandbox(undefined)).toBeUndefined();
	});

	it("accepts sandbox=true", () => {
		expect(normalizeRequestedRlmSubagentSandbox(true)).toBe(true);
	});

	it("accepts sandbox=false", () => {
		expect(normalizeRequestedRlmSubagentSandbox(false)).toBe(false);
	});

	it("rejects non-boolean sandbox", () => {
		expect(() => normalizeRequestedRlmSubagentSandbox("true")).toThrow("rlm.run sandbox must be a boolean");
		expect(() => normalizeRequestedRlmSubagentSandbox(1)).toThrow("rlm.run sandbox must be a boolean");
		expect(() => normalizeRequestedRlmSubagentSandbox(null)).toThrow("rlm.run sandbox must be a boolean");
	});

	// -- normalizeRequestedRlmSubagentSandboxOptions (delegates to normalizeSandboxOptions) --

	it("accepts undefined sandbox_options", () => {
		expect(normalizeRequestedRlmSubagentSandboxOptions(undefined, false)).toBeUndefined();
	});

	it("accepts empty object when sandbox=true", () => {
		const result = normalizeRequestedRlmSubagentSandboxOptions({}, true);
		expect(result).toEqual({});
	});

	it("accepts region when sandbox=true", () => {
		const result = normalizeRequestedRlmSubagentSandboxOptions({ region: "us-east-1" }, true);
		expect(result).toEqual({ region: "us-east-1" });
	});

	it("rejects sandbox_options when sandbox is false", () => {
		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ region: "us-east-1" }, false)).toThrow(
			"rlm.run sandbox_options requires sandbox=true",
		);
	});

	it("rejects sandbox_options when sandbox is undefined", () => {
		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ region: "us-east-1" }, undefined)).toThrow(
			"rlm.run sandbox_options requires sandbox=true",
		);
	});

	it("rejects non-object sandbox_options", () => {
		expect(() => normalizeRequestedRlmSubagentSandboxOptions("string", true)).toThrow(
			"rlm.run sandbox_options contains invalid fields",
		);
		expect(() => normalizeRequestedRlmSubagentSandboxOptions(42, true)).toThrow(
			"rlm.run sandbox_options contains invalid fields",
		);
		expect(() => normalizeRequestedRlmSubagentSandboxOptions(null, true)).toThrow(
			"rlm.run sandbox_options contains invalid fields",
		);
		expect(() => normalizeRequestedRlmSubagentSandboxOptions(["a"], true)).toThrow(
			"rlm.run sandbox_options contains invalid fields",
		);
	});

	it("rejects unknown keys in sandbox_options", () => {
		expect(() =>
			normalizeRequestedRlmSubagentSandboxOptions({ workspaceId: "ws-123", region: "us-east-1" }, true),
		).toThrow("rlm.run sandbox_options contains invalid fields");
		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ env: { PATH: "/danger" } }, true)).toThrow(
			"rlm.run sandbox_options contains invalid fields",
		);
		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ apiKey: "sk-123" }, true)).toThrow(
			"rlm.run sandbox_options contains invalid fields",
		);
		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ token: "secret" }, true)).toThrow(
			"rlm.run sandbox_options contains invalid fields",
		);
	});

	it("rejects invalid region string", () => {
		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ region: "" }, true)).toThrow(
			"rlm.run sandbox_options contains invalid fields",
		);
		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ region: 42 }, true)).toThrow(
			"rlm.run sandbox_options contains invalid fields",
		);
		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ region: "UPPERCASE" }, true)).toThrow(
			"rlm.run sandbox_options contains invalid fields",
		);
		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ region: "-starts-with-hyphen" }, true)).toThrow(
			"rlm.run sandbox_options contains invalid fields",
		);
	});

	it("accepts valid region strings", () => {
		expect(normalizeRequestedRlmSubagentSandboxOptions({ region: "us-east-1" }, true)).toEqual({
			region: "us-east-1",
		});
		expect(normalizeRequestedRlmSubagentSandboxOptions({ region: "eu-west-2" }, true)).toEqual({
			region: "eu-west-2",
		});
		expect(normalizeRequestedRlmSubagentSandboxOptions({ region: "a" }, true)).toEqual({ region: "a" });
	});

	// -- Supplied options stay frozen and own-key-correct through normalization --

	it("normalized empty sandbox_options stays frozen with zero own keys", () => {
		const result = normalizeRequestedRlmSubagentSandboxOptions({}, true);
		expect(result).toEqual({});
		expect(Object.isFrozen(result!)).toBe(true);
		expect(Object.keys(result!)).toEqual([]);
	});

	it("normalized region sandbox_options stays frozen with one own key", () => {
		const result = normalizeRequestedRlmSubagentSandboxOptions({ region: "us-east-1" }, true);
		expect(result).toEqual({ region: "us-east-1" });
		expect(Object.isFrozen(result!)).toBe(true);
		expect(Object.keys(result!)).toEqual(["region"]);
		// No undefined fields
		expect("region" in result!).toBe(true);
		const r = result as { region?: string };
		expect(r.region).toBe("us-east-1");
	});

	// -- Integration: runRlmChild with sandbox kwargs --

	it("omitted sandbox runs child without error", async () => {
		const root = createSession({ maxDepth: 3 });
		const handle = await root.runRlmChild("test prompt");
		expect(handle.rlm_child_id).toBeTruthy();
	});

	it("sandbox=false runs child without error", async () => {
		const root = createSession({ maxDepth: 3 });
		const handle = await root.runRlmChild("test prompt", { sandbox: false });
		expect(handle.rlm_child_id).toBeTruthy();
	});

	it("sandbox=true rejects without calling the provider model", async () => {
		let modelCallCount = 0;
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "",
				tools: [],
				thinkingLevel: "off",
			},
			streamFn: () => {
				modelCallCount++;
				return createAssistantMessageEventStream();
			},
		});
		const root = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
			rlmDepth: 0,
			rlmMaxDepth: 3,
		});
		session = root;
		await expect(root.runRlmChild("test prompt", { sandbox: true })).rejects.toThrow(
			"Sandbox execution is not available for this session",
		);
		expect(modelCallCount).toBe(0);
	});

	it("sandbox=true produces no new files (async tree snapshot)", async () => {
		const root = createSession({ maxDepth: 3 });
		async function treeSnapshot(dir: string): Promise<string[]> {
			const entries: string[] = [];
			try {
				const names = await readdirAsync(dir);
				for (const name of names.sort()) {
					const child = join(dir, name);
					const s = await statAsync(child);
					entries.push(s.isDirectory() ? `${name}/` : name);
					if (s.isDirectory() && !name.startsWith("node_modules")) {
						entries.push(...(await treeSnapshot(child)).map((e) => `${name}/${e}`));
					}
				}
			} catch {
				// dir does not exist yet
			}
			return entries;
		}
		const before = await treeSnapshot(tempDir);
		await expect(root.runRlmChild("test prompt", { sandbox: true })).rejects.toThrow(
			"Sandbox execution is not available for this session",
		);
		const after = await treeSnapshot(tempDir);
		expect(after).toEqual(before);
	});

	it("sandbox=true produces no child listing entry and no child_update event", async () => {
		const root = createSession({ maxDepth: 3 });
		const rlmChildUpdates: unknown[] = [];
		const unsub = root.subscribe((event) => {
			if (event.type === "rlm_child_update") rlmChildUpdates.push(event);
		});
		const childrenBefore = await root.listRlmSubagents();
		await expect(root.runRlmChild("test prompt", { sandbox: true })).rejects.toThrow(
			"Sandbox execution is not available for this session",
		);
		const childrenAfter = await root.listRlmSubagents();
		expect(childrenAfter.subagents.length).toBe(childrenBefore.subagents.length);
		expect(rlmChildUpdates).toEqual([]);
		unsub();
	});

	it("sandbox=true with empty options without host is rejected", async () => {
		const root = createSession({ maxDepth: 3 });
		await expect(root.runRlmChild("test prompt", { sandbox: true, sandbox_options: {} })).rejects.toThrow(
			"Sandbox execution is not available for this session",
		);
	});

	it("sandbox=true with region without host is rejected", async () => {
		const root = createSession({ maxDepth: 3 });
		await expect(
			root.runRlmChild("test prompt", { sandbox: true, sandbox_options: { region: "eu-west-1" } }),
		).rejects.toThrow("Sandbox execution is not available for this session");
	});

	it("rejects sandbox_options without sandbox=true", async () => {
		const root = createSession({ maxDepth: 3 });
		await expect(root.runRlmChild("test prompt", { sandbox_options: { region: "us-east-1" } })).rejects.toThrow(
			"rlm.run sandbox_options requires sandbox=true",
		);
	});

	it("rejects sandbox_options with sandbox=false", async () => {
		const root = createSession({ maxDepth: 3 });
		await expect(
			root.runRlmChild("test prompt", { sandbox: false, sandbox_options: { region: "us-east-1" } }),
		).rejects.toThrow("rlm.run sandbox_options requires sandbox=true");
	});

	it("rejects sandbox_options with invalid region", async () => {
		const root = createSession({ maxDepth: 3 });
		await expect(root.runRlmChild("test prompt", { sandbox: true, sandbox_options: { region: "" } })).rejects.toThrow(
			"rlm.run sandbox_options contains invalid fields",
		);
	});

	it("rejects sandbox_options with unknown keys", async () => {
		const root = createSession({ maxDepth: 3 });
		await expect(
			root.runRlmChild("test prompt", { sandbox: true, sandbox_options: { apiKey: "sk-123" } }),
		).rejects.toThrow("rlm.run sandbox_options contains invalid fields");
	});

	// -- Coexistence with name/model/thinking --

	it("sandbox=true coexists with name kwarg (rejected)", async () => {
		const root = createSession({ maxDepth: 3 });
		await expect(root.runRlmChild("test prompt", { sandbox: true, name: "my-child" })).rejects.toThrow(
			"Sandbox execution is not available for this session",
		);
	});

	it("sandbox=true coexists with model kwarg (rejected)", async () => {
		const root = createSession({ maxDepth: 3 });
		await expect(
			root.runRlmChild("test prompt", { sandbox: true, model: "anthropic/claude-opus-4-5" }),
		).rejects.toThrow("Sandbox execution is not available for this session");
	});

	it("sandbox=true coexists with thinking kwarg (rejected)", async () => {
		const root = createSession({ maxDepth: 3 });
		await expect(root.runRlmChild("test prompt", { sandbox: true, thinking: "off" })).rejects.toThrow(
			"Sandbox execution is not available for this session",
		);
	});

	it("sandbox=true coexists with name, model, and thinking combined (rejected)", async () => {
		const root = createSession({ maxDepth: 3 });
		await expect(
			root.runRlmChild("test prompt", {
				sandbox: true,
				name: "combined-child",
				model: "anthropic/claude-opus-4-5",
				thinking: "off",
			}),
		).rejects.toThrow("Sandbox execution is not available for this session");
	});

	// -- Host delegation: options reach SubagentRuntimeHost correctly --

	it("sandbox=true reaches host with sandbox=true, no options", async () => {
		let receivedOpts: CreateRlmSubagentRuntimeOptions | undefined;
		let hostResolved = false;
		const host: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async (options) => {
				receivedOpts = options;
				hostResolved = true;
				throw new Error("host-call-recorded");
			},
			deleteRlmSubagentRuntime: async () => {},
		};
		const root = createSession({ maxDepth: 3, subagentRuntimeHost: host });
		await root.runRlmChild("test prompt", { sandbox: true });
		for (let i = 0; i < 100; i++) {
			if (hostResolved) break;
			await sleep(10);
		}
		expect(hostResolved).toBe(true);
		expect(receivedOpts!.sandbox).toBe(true);
		expect(receivedOpts!.sandboxOptions).toBeUndefined();
	});

	it("sandbox=true with options reaches host with frozen sandboxOptions", async () => {
		let receivedOpts: CreateRlmSubagentRuntimeOptions | undefined;
		let hostResolved = false;
		const host: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async (options) => {
				receivedOpts = options;
				hostResolved = true;
				throw new Error("host-call-recorded");
			},
			deleteRlmSubagentRuntime: async () => {},
		};
		const root = createSession({ maxDepth: 3, subagentRuntimeHost: host });
		await root.runRlmChild("test prompt", { sandbox: true, sandbox_options: { region: "eu-west-1" } });
		for (let i = 0; i < 100; i++) {
			if (hostResolved) break;
			await sleep(10);
		}
		expect(hostResolved).toBe(true);
		expect(receivedOpts!.sandbox).toBe(true);
		// Verify the received object is the frozen snapshot, not a copy
		expect(Object.isFrozen(receivedOpts!.sandboxOptions!)).toBe(true);
		expect(Object.keys(receivedOpts!.sandboxOptions!)).toEqual(["region"]);
		expect(receivedOpts!.sandboxOptions).toEqual({ region: "eu-west-1" });
	});

	it("sandbox=true with empty options reaches host with frozen empty sandboxOptions", async () => {
		let receivedOpts: CreateRlmSubagentRuntimeOptions | undefined;
		let hostResolved = false;
		const host: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async (options) => {
				receivedOpts = options;
				hostResolved = true;
				throw new Error("host-call-recorded");
			},
			deleteRlmSubagentRuntime: async () => {},
		};
		const root = createSession({ maxDepth: 3, subagentRuntimeHost: host });
		await root.runRlmChild("test prompt", { sandbox: true, sandbox_options: {} });
		for (let i = 0; i < 100; i++) {
			if (hostResolved) break;
			await sleep(10);
		}
		expect(hostResolved).toBe(true);
		expect(receivedOpts!.sandbox).toBe(true);
		expect(Object.keys(receivedOpts!.sandboxOptions!)).toEqual([]);
		expect(Object.isFrozen(receivedOpts!.sandboxOptions!)).toBe(true);
	});

	it("omitted sandbox does not set sandbox on host options", async () => {
		let receivedOpts: CreateRlmSubagentRuntimeOptions | undefined;
		let hostResolved = false;
		const host: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async (options) => {
				receivedOpts = options;
				hostResolved = true;
				throw new Error("host-call-recorded");
			},
			deleteRlmSubagentRuntime: async () => {},
		};
		const root = createSession({ maxDepth: 3, subagentRuntimeHost: host });
		await root.runRlmChild("test prompt");
		for (let i = 0; i < 100; i++) {
			if (hostResolved) break;
			await sleep(10);
		}
		expect(hostResolved).toBe(true);
		expect(receivedOpts!.sandbox).toBeUndefined();
		expect(receivedOpts!.sandboxOptions).toBeUndefined();
	});

	it("sandbox=false does not set sandbox on host options", async () => {
		let receivedOpts: CreateRlmSubagentRuntimeOptions | undefined;
		let hostResolved = false;
		const host: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async (options) => {
				receivedOpts = options;
				hostResolved = true;
				throw new Error("host-call-recorded");
			},
			deleteRlmSubagentRuntime: async () => {},
		};
		const root = createSession({ maxDepth: 3, subagentRuntimeHost: host });
		await root.runRlmChild("test prompt", { sandbox: false });
		for (let i = 0; i < 100; i++) {
			if (hostResolved) break;
			await sleep(10);
		}
		expect(hostResolved).toBe(true);
		expect(receivedOpts!.sandbox).toBeUndefined();
		expect(receivedOpts!.sandboxOptions).toBeUndefined();
	});

	// -- Python bridge: snake_case kwarg accepted --

	it("sandbox_options snake_case kwarg reaches host", async () => {
		let receivedOpts: CreateRlmSubagentRuntimeOptions | undefined;
		let hostResolved = false;
		const host: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async (options) => {
				receivedOpts = options;
				hostResolved = true;
				throw new Error("host-call-recorded");
			},
			deleteRlmSubagentRuntime: async () => {},
		};
		const root = createSession({ maxDepth: 3, subagentRuntimeHost: host });
		await root.runRlmChild("test prompt", { sandbox: true, sandbox_options: { region: "us-west-2" } });
		for (let i = 0; i < 100; i++) {
			if (hostResolved) break;
			await sleep(10);
		}
		expect(hostResolved).toBe(true);
		expect(receivedOpts!.sandbox).toBe(true);
		expect(receivedOpts!.sandboxOptions).toEqual({ region: "us-west-2" });
	});

	// -- Existing unsupported kwargs still rejected --

	it("rejects unsupported rlm.run kwargs loudly", async () => {
		const root = createSession();
		await expect(root.runRlmChild("nested", { temperature: 0 })).rejects.toThrow(
			"Unsupported rlm.run kwargs: temperature",
		);
	});
});
