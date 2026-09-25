import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { EventStream } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner, imageBlocksFromAttachments } from "../src/core/tools/ipython.js";
import { getCodingAgentFixtureModel } from "./fixture-models.js";
import { assistantMsg, createTestResourceLoader } from "./utilities.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function bundledAttachImageSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "attach-image");
	return {
		name: "attach-image",
		importName: "attach_image",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

describe("attach-image skill over the kernel host bridge", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-attach-image-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads an on-disk image into the tool result as an ImageContent block", async () => {
		const imagePath = join(tempDir, "sample.png");
		writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`print(await attach_image(${JSON.stringify(imagePath)}))`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toContain("Loaded 1 image(s) into context");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/png");
		expect(result.attachments?.[0]?.data).toBe(PNG_BASE64);

		const blocks = imageBlocksFromAttachments(result.attachments);
		expect(blocks).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("compresses large attached images before storing them in the tool result", async () => {
		const imagePath = join(tempDir, "large.png");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
from PIL import Image
img = Image.new("RGB", (2400, 1800), (32, 64, 96))
img.save(${JSON.stringify(imagePath)})
print(await attach_image(${JSON.stringify(imagePath)}))
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("Resized for efficient inline rendering/replay");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/jpeg");
		expect(result.attachments?.[0]?.data.length).toBeLessThanOrEqual(350_000);
	});

	it("reports when compressed animated images are flattened to their first frame", async () => {
		const imagePath = join(tempDir, "animated.gif");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
from PIL import Image
frames = [Image.new("RGB", (1300, 10), color) for color in ("red", "blue")]
frames[0].save(${JSON.stringify(imagePath)}, save_all=True, append_images=frames[1:], duration=50, loop=0)
print(await attach_image(${JSON.stringify(imagePath)}))
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("animated image flattened to first frame");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/jpeg");
		expect(result.attachments?.[0]?.data.length).toBeLessThanOrEqual(350_000);
	});

	it("uses a neutral background when compressing transparent images", async () => {
		const imagePath = join(tempDir, "transparent.png");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
from PIL import Image, ImageDraw
img = Image.new("RGBA", (1300, 10), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
draw.rectangle((0, 0, 1299, 9), fill=(255, 255, 255, 255))
img.save(${JSON.stringify(imagePath)})
print(await attach_image(${JSON.stringify(imagePath)}))
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("transparent pixels composited on #888888 background");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/jpeg");
		expect(result.attachments?.[0]?.data.length).toBeLessThanOrEqual(350_000);
	});

	it("rejects oversized pixel counts before loading an image into context", async () => {
		const imagePath = join(tempDir, "huge.png");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import struct
import zlib


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


png = bytes([137, 80, 78, 71, 13, 10, 26, 10])
png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", 6001, 6001, 8, 2, 0, 0, 0))
png += png_chunk(b"IEND", b"")
with open(${JSON.stringify(imagePath)}, "wb") as file:
    file.write(png)
try:
    await attach_image(${JSON.stringify(imagePath)})
except ValueError as error:
    print(f"ValueError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("images must be at most 36MP");
		expect(result.attachments).toBeUndefined();
	});

	it("rejects undecodable images before emitting any attachment", async () => {
		const validImagePath = join(tempDir, "valid.png");
		const corruptImagePath = join(tempDir, "corrupt.png");
		writeFileSync(validImagePath, Buffer.from(PNG_BASE64, "base64"));

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import struct
import zlib


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


png = bytes([137, 80, 78, 71, 13, 10, 26, 10])
png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", 10, 10, 8, 2, 0, 0, 0))
png += png_chunk(b"IEND", b"")
with open(${JSON.stringify(corruptImagePath)}, "wb") as file:
    file.write(png)
try:
    await attach_image(${JSON.stringify(validImagePath)}, ${JSON.stringify(corruptImagePath)})
except ValueError as error:
    print(f"ValueError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("is not a readable supported image");
		expect(result.attachments).toBeUndefined();
	});

	it("errors without emitting an attachment when the model is not vision-capable", async () => {
		const imagePath = join(tempDir, "sample.png");
		writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "openai/gpt-oss-120b", input: ["text"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await attach_image(${JSON.stringify(imagePath)})
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe(
			"RuntimeError: openai/gpt-oss-120b does not support vision. " +
				"Tell the user to switch to a vision-capable model to load images into context.",
		);
		expect(result.attachments).toBeUndefined();
	});

	it("rejects a non-image file", async () => {
		const notImage = join(tempDir, "notes.txt");
		writeFileSync(notImage, "just text");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await attach_image(${JSON.stringify(notImage)})
except ValueError as error:
    print(f"ValueError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toContain("is not a supported image");
		expect(result.attachments).toBeUndefined();
	});

	it("fails the cell loudly when an emitted attachment exceeds the size cap", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, { pythonSkills: [] });
		const manager = await provisioner.ensure();
		const result = await manager.execute(`
from rlm import emit
emit({"application/vnd.prime-agent.attachment+json": {"mime_type": "image/png", "data": "A" * 10_000_001}})
print("done")
`);

		expect(result.status).toBe("error");
		expect(result.stderr).toContain("attachment dropped");
		expect(result.attachments).toBeUndefined();
	});
});

describe("agent-observe skill over the kernel host bridge", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-agent-observe-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("routes list/get/recent over the host bridge and validates argument types locally", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const record = (type: string, payload: Record<string, unknown>) => {
			requests.push({ type, payload });
		};
		const packagePath = join(getBundledSkillsDir(), "agent-observe");
		const skill: PythonSkillRuntimeInfo = {
			name: "agent-observe",
			importName: "agent_observe",
			packagePath,
			pyprojectPath: join(packagePath, "pyproject.toml"),
		};
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [skill],
			hostHandlers: {
				"agent_observe.list": async (payload) => {
					record("agent_observe.list", payload);
					return { agents: [{ activeSessionId: "alpha" }, { activeSessionId: "beta" }] };
				},
				"agent_observe.get": async (payload) => {
					record("agent_observe.get", payload);
					return { agent: { activeSessionId: payload.target, status: "model" } };
				},
				"agent_observe.recent": async (payload) => {
					record("agent_observe.recent", payload);
					return { messages: [{ index: 1, role: "assistant", text: "working", truncated: false }] };
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
agents = await agent_observe.list_agents()
agent = await agent_observe.get_agent("beta")
recent = await agent_observe.recent_messages("beta", limit=3, max_chars=120)
try:
    await agent_observe.get_agent(123)
except TypeError as error:
    print(f"TypeError: {error}")
print(json.dumps({"agents": agents, "agent": agent, "recent": recent}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		const lines = result.stdout.trim().split("\n");
		expect(lines[0]).toBe("TypeError: target must be str, got int");
		const output = JSON.parse(lines[1]);
		expect(output.agents.agents).toHaveLength(2);
		expect(output.agent.agent).toMatchObject({ activeSessionId: "beta", status: "model" });
		expect(output.recent.messages).toEqual([{ index: 1, role: "assistant", text: "working", truncated: false }]);
		expect(requests.map((request) => request.type)).toEqual([
			"agent_observe.list",
			"agent_observe.get",
			"agent_observe.recent",
		]);
		expect(requests[2].payload).toMatchObject({
			type: "agent_observe.recent",
			target: "beta",
			limit: 3,
			max_chars: 120,
		});
	});
});

/**
 * A session whose model cannot see images, pinned to an image model, with a
 * spied child runtime so no real child process runs.
 */
function createTextOnlyImageSession(settings: Record<string, unknown> = { imageModel: "claude-haiku-4-5" }): {
	agentSession: AgentSession;
	spawns: Array<{ prompt: string; kwargs: Record<string, unknown> }>;
} {
	const dir = mkdtempSync(join(tmpdir(), "pi-attach-image-session-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	const base = getCodingAgentFixtureModel("anthropic", "claude-opus-4-7");
	const sessionModel = { ...base, id: "claude-opus-4-7-text-only", input: ["text"] } as typeof base;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: sessionModel, systemPrompt: "Test", tools: [] },
		streamFn: () => {
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(event) => event.type === "done",
				(event: any) => event.message,
			);
			stream.push({ type: "done", reason: "stop", message: assistantMsg("ok") });
			return stream;
		},
	});
	const auth = AuthStorage.create(join(dir, "auth.json"));
	auth.setRuntimeApiKey("anthropic", "test-key");
	const agentSession = new AgentSession({
		agent,
		sessionManager: SessionManager.create(dir, join(dir, "sessions")),
		settingsManager: SettingsManager.create(dir, dir),
		cwd: dir,
		modelRegistry: ModelRegistry.create(auth, dir),
		resourceLoader: createTestResourceLoader(),
	});
	const spawns: Array<{ prompt: string; kwargs: Record<string, unknown> }> = [];
	const childRuntime = agentSession as unknown as {
		runRlmChild: (prompt: string, kwargs: Record<string, unknown>) => Promise<{ rlm_child_id: string }>;
		collectRlmChildren: () => Promise<{ results: unknown[] }>;
		deleteRlmSubagent: () => Promise<unknown>;
		_rlmChildSessions: Map<string, { session: { getLastAssistantText: () => string; dispose: () => void } }>;
	};
	childRuntime.runRlmChild = async (prompt, kwargs) => {
		spawns.push({ prompt, kwargs });
		const id = `child-${spawns.length}`;
		childRuntime._rlmChildSessions.set(id, {
			session: {
				getLastAssistantText: () => "A bridge at sunset, with a harbour below.",
				dispose: () => {},
			},
		});
		childRuntime.collectRlmChildren = async () => ({
			results: [{ rlm_child_id: id, status: "done", settled: true }],
		});
		childRuntime.deleteRlmSubagent = async () => ({});
		return { rlm_child_id: id };
	};
	return { agentSession, spawns };
}

describe("attach-image delegation to the session image model", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;
	let session: AgentSession | undefined;
	let sessionDir: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-attach-image-delegate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		session?.dispose();
		session = undefined;
		if (sessionDir) rmSync(sessionDir, { recursive: true, force: true });
		sessionDir = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads the image with the image model instead of raising when the session model is text-only", async () => {
		const imagePath = join(tempDir, "sample.png");
		writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));
		const { agentSession, spawns } = createTextOnlyImageSession();
		session = agentSession;
		sessionDir = agentSession.sessionManager.getCwd();

		const handlers = (
			agentSession as unknown as {
				_createKernelHostHandlers(): Record<
					string,
					(payload: Record<string, unknown>) => Promise<Record<string, unknown>>
				>;
			}
		)._createKernelHostHandlers();
		const requests: Array<Record<string, unknown>> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": handlers["model.info"]!,
				"vision.read": async (payload) => {
					requests.push(payload);
					return handlers["vision.read"]!(payload);
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`print(await attach_image(${JSON.stringify(imagePath)}))`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("A bridge at sunset, with a harbour below.");
		expect(result.stdout).toContain("Read by anthropic/claude-haiku-4-5");
		expect(result.stdout).not.toContain("does not support vision");
		// The image is never attached: only the reading reaches the session.
		expect(result.attachments).toBeUndefined();
		expect(spawns).toHaveLength(1);
		expect(spawns[0]?.kwargs).toEqual({ model: "anthropic/claude-haiku-4-5" });
		// The delegated read carries a focused question, not just bytes.
		expect(requests).toHaveLength(1);
		expect(String(requests[0]?.question ?? "")).toContain("Describe what this image shows");
	});

	it("surfaces the host's actionable refusal instead of the generic capability error", async () => {
		const imagePath = join(tempDir, "sample.png");
		writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "openai/gpt-oss-120b", input: ["text"] }),
				"vision.read": async () => ({
					error: "This turn attaches images, but the selected model (openai/gpt-oss-120b) does not accept image input.\n\nPick one:\n- Switch the session model with /model, or\n- Set an image model with /image-model <model>, or imageModel in settings.json",
				}),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await attach_image(${JSON.stringify(imagePath)})
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("/image-model <model>");
		expect(result.stdout).not.toContain("does not support vision");
		expect(result.attachments).toBeUndefined();
	});

	/**
	 * The refusal the skill surfaces when the delegated read cannot run. The
	 * skill turns any `error` into a RuntimeError, so the reason has to be the
	 * real one: "pick an image model" is wrong when a model is already set.
	 */
	async function delegatedReadError(settings: Record<string, unknown>): Promise<string> {
		const { agentSession } = createTextOnlyImageSession(settings);
		session = agentSession;
		sessionDir = agentSession.sessionManager.getCwd();
		const handlers = (
			agentSession as unknown as {
				_createKernelHostHandlers(): Record<
					string,
					(payload: Record<string, unknown>) => Promise<Record<string, unknown>>
				>;
			}
		)._createKernelHostHandlers();
		const result = await handlers["vision.read"]!({
			images: [{ mime_type: "image/png", data: PNG_BASE64 }],
			question: "What does this image show?",
		});
		return String(result.error ?? "");
	}

	it("names the blocking setting when images.blockImages stops a delegated read", async () => {
		const error = await delegatedReadError({ imageModel: "claude-haiku-4-5", images: { blockImages: true } });

		expect(error).toContain("images.blockImages");
		expect(error).not.toContain("Pick one:");
	});

	it("names the configured image model instead of asking for one when it cannot serve", async () => {
		const error = await delegatedReadError({ imageModel: "openai/gpt-5.5" });

		expect(error).toContain('imageModel "openai/gpt-5.5"');
		expect(error).not.toContain("Pick one:");
	});
});
