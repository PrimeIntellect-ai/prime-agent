import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import {
	normalizeRequestedRlmSubagentSandbox,
	normalizeRequestedRlmSubagentSandboxOptions,
} from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-opus-4-5");

let tempDir: string;
let session: AgentSession | undefined;

function createSession(options: { depth?: number; maxDepth?: number } = {}): AgentSession {
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

	// -- normalizeRequestedRlmSubagentSandboxOptions --

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
			"rlm.run sandbox_options must be a plain object",
		);
		expect(() => normalizeRequestedRlmSubagentSandboxOptions(42, true)).toThrow(
			"rlm.run sandbox_options must be a plain object",
		);
		expect(() => normalizeRequestedRlmSubagentSandboxOptions(null, true)).toThrow(
			"rlm.run sandbox_options must be a plain object",
		);
		expect(() => normalizeRequestedRlmSubagentSandboxOptions(["a"], true)).toThrow(
			"rlm.run sandbox_options must be a plain object",
		);
	});

	it("rejects unknown keys in sandbox_options", () => {
		expect(() =>
			normalizeRequestedRlmSubagentSandboxOptions({ workspaceId: "ws-123", region: "us-east-1" }, true),
		).toThrow("rlm.run sandbox_options contains unsupported key: workspaceId");

		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ env: { PATH: "/danger" } }, true)).toThrow(
			"rlm.run sandbox_options contains unsupported key: env",
		);

		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ apiKey: "sk-123" }, true)).toThrow(
			"rlm.run sandbox_options contains unsupported key: apiKey",
		);

		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ token: "secret" }, true)).toThrow(
			"rlm.run sandbox_options contains unsupported key: token",
		);
	});

	it("rejects invalid region string", () => {
		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ region: "" }, true)).toThrow(
			"rlm.run sandbox_options.region contains invalid characters or is too long",
		);

		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ region: 42 }, true)).toThrow(
			"rlm.run sandbox_options.region must be a string",
		);

		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ region: "UPPERCASE" }, true)).toThrow(
			"rlm.run sandbox_options.region contains invalid characters or is too long",
		);

		expect(() => normalizeRequestedRlmSubagentSandboxOptions({ region: "-starts-with-hyphen" }, true)).toThrow(
			"rlm.run sandbox_options.region contains invalid characters or is too long",
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

	it("sandbox=true with no sandbox_options runs child without error", async () => {
		const root = createSession({ maxDepth: 3 });
		const handle = await root.runRlmChild("test prompt", { sandbox: true });
		expect(handle.rlm_child_id).toBeTruthy();
	});

	it("sandbox=true with empty sandbox_options runs child", async () => {
		const root = createSession({ maxDepth: 3 });
		const handle = await root.runRlmChild("test prompt", { sandbox: true, sandbox_options: {} });
		expect(handle.rlm_child_id).toBeTruthy();
	});

	it("sandbox=true with region sandbox_options runs child", async () => {
		const root = createSession({ maxDepth: 3 });
		const handle = await root.runRlmChild("test prompt", {
			sandbox: true,
			sandbox_options: { region: "eu-west-1" },
		});
		expect(handle.rlm_child_id).toBeTruthy();
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
			"rlm.run sandbox_options.region contains invalid characters or is too long",
		);
	});

	it("rejects sandbox_options with unknown keys", async () => {
		const root = createSession({ maxDepth: 3 });
		await expect(
			root.runRlmChild("test prompt", { sandbox: true, sandbox_options: { apiKey: "sk-123" } }),
		).rejects.toThrow("rlm.run sandbox_options contains unsupported key: apiKey");
	});

	// -- Coexistence with name/model/thinking --

	it("sandbox=true coexists with name kwarg", async () => {
		const root = createSession({ maxDepth: 3 });
		const handle = await root.runRlmChild("test prompt", {
			sandbox: true,
			name: "my-child",
		});
		expect(handle.name).toBe("my-child");
	});

	it("sandbox=true coexists with model kwarg", async () => {
		const root = createSession({ maxDepth: 3 });
		const handle = await root.runRlmChild("test prompt", {
			sandbox: true,
			model: "anthropic/claude-opus-4-5",
		});
		expect(handle.rlm_child_id).toBeTruthy();
	});

	it("sandbox=true coexists with thinking kwarg", async () => {
		const root = createSession({ maxDepth: 3 });
		const handle = await root.runRlmChild("test prompt", {
			sandbox: true,
			thinking: "off",
		});
		expect(handle.rlm_child_id).toBeTruthy();
	});

	it("sandbox=true coexists with name, model, and thinking combined", async () => {
		const root = createSession({ maxDepth: 3 });
		const handle = await root.runRlmChild("test prompt", {
			sandbox: true,
			name: "combined-child",
			model: "anthropic/claude-opus-4-5",
			thinking: "off",
		});
		expect(handle.name).toBe("combined-child");
		expect(handle.rlm_child_id).toBeTruthy();
	});

	// -- Python bridge: snake_case kwarg accepted --

	it("accepts sandbox_options snake_case kwarg", async () => {
		const root = createSession({ maxDepth: 3 });
		const handle = await root.runRlmChild("test prompt", {
			sandbox: true,
			sandbox_options: { region: "us-west-2" },
		});
		expect(handle.rlm_child_id).toBeTruthy();
	});
});
