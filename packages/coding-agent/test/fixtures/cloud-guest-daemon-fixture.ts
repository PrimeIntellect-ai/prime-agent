/**
 * Test fixture: the resident guest cloud daemon with a faux provider.
 *
 * Spawned by the uploaded bridge inside loopback e2e tests, exactly the way
 * the sandbox image spawns `prime-agent --mode daemon`: the bridge sets
 * PRIME_AGENT_INTERNAL_CLOUD_DAEMON=1 plus the fixed-name cloud env, and this
 * process hosts a real AgentSession through runCloudDaemonMode. Inference is
 * an in-process file-driven api (no network, no paid tokens): each provider
 * call consumes one queued AssistantMessage step from a JSONL file the test
 * process controls.
 *
 * Env:
 * - PRIME_AGENT_TEST_FAUX_RESPONSES: JSONL file; each line is one
 *   AssistantMessage JSON step. The first line is consumed atomically per call.
 * - PRIME_AGENT_TEST_FAUX_ECHO: "1" answers with a canned response when no
 *   step is queued (deterministic multi-turn and recursion runs).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	registerApiProvider,
	type StreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { AgentSession } from "../../src/core/agent-session.js";
import type { CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.js";
import { createAgentSessionServices } from "../../src/core/agent-session-services.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { convertToLlm } from "../../src/core/messages.js";
import { runCloudDaemonMode } from "../../src/modes/cloud/cloud-daemon.js";

// Read lazily: in-process tests set these env vars per-test, after import.
const responsesFile = () => process.env.PRIME_AGENT_TEST_FAUX_RESPONSES ?? "";
const echoMode = () => process.env.PRIME_AGENT_TEST_FAUX_ECHO === "1";
const fauxApi = `faux-${process.pid}`;
const fauxProvider = "faux";
const fauxModelId = "faux-1";

/** Pop the next queued response step, or synthesize a canned echo response. */
function nextResponseStep(): AssistantMessage {
	const file = responsesFile();
	if (file !== "" && existsSync(file)) {
		for (let attempt = 0; attempt < 50; attempt++) {
			try {
				const contents = readFileSync(file, "utf8");
				const lines = contents.split("\n").filter((line) => line.trim().length > 0);
				if (lines.length === 0) break;
				const step = JSON.parse(lines[0] as string) as AssistantMessage;
				const rest = lines.slice(1).join("\n");
				writeFileSync(`${file}.tmp`, rest.length > 0 ? `${rest}\n` : "", { mode: 0o600 });
				renameSync(`${file}.tmp`, file);
				return step;
			} catch {
				// A concurrent consume; retry briefly.
			}
		}
	}
	if (!echoMode()) {
		throw new Error("faux provider has no queued response step");
	}
	return {
		role: "assistant",
		content: [{ type: "text", text: "faux-ack" }],
		api: fauxApi,
		provider: fauxProvider,
		timestamp: Date.now(),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AssistantMessage;
}

function emitStep(stream: AssistantMessageEventStream, message: AssistantMessage): void {
	const partial: AssistantMessage = { ...message, content: [] };
	stream.push({ type: "start", partial: { ...partial } });
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (block?.type === "text") {
			partial.content = [...partial.content, { type: "text", text: "" }];
			stream.push({ type: "text_start", contentIndex: index, partial: { ...partial } });
			(partial.content[index] as { type: "text"; text: string }).text = block.text;
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: { ...partial } });
			continue;
		}
		if (block?.type === "thinking") {
			partial.content = [...partial.content, { type: "thinking", thinking: "" }];
			stream.push({ type: "thinking_start", contentIndex: index, partial: { ...partial } });
			(partial.content[index] as { type: "thinking"; thinking: string }).thinking = block.thinking;
			stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				partial: { ...partial },
			});
		}
		if (block?.type === "toolCall") {
			const call = block as { id: string; name: string; arguments: Record<string, unknown> };
			const encoded = JSON.stringify(call.arguments);
			partial.content = [
				...partial.content,
				{ type: "toolCall", id: call.id, name: call.name, arguments: "" } as unknown as ToolCall,
			];
			stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
			(partial.content[index] as unknown as { type: "toolCall"; arguments: string }).arguments = encoded;
			stream.push({
				type: "toolcall_delta",
				contentIndex: index,
				delta: encoded,
				partial: { ...partial },
			});
			stream.push({
				type: "toolcall_end",
				contentIndex: index,
				toolCall: { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments },
				partial: { ...partial },
			});
		}
	}
	const reason: "length" | "stop" | "toolUse" =
		message.stopReason === "length" || message.stopReason === "toolUse" ? message.stopReason : "stop";
	stream.push({ type: "done", reason, message });
	stream.end(message);
}

/**
 * The faux stream. Also rides every provider-config registration below: a
 * `ModelRegistry.refresh()` clears the process-global api-provider registry,
 * and `registerProvider` configs that carry `streamSimple` are re-applied (and
 * so re-registered) on every session open, keeping the faux api available no
 * matter which registry refreshed in between.
 */
const fauxStream = (model: Model<string>, _context: Context, options?: StreamOptions) => {
	const outer = createAssistantMessageEventStream();
	queueMicrotask(async () => {
		try {
			await options?.onResponse?.({ status: 200, headers: {} }, model);
			if (options?.signal?.aborted) {
				const aborted: AssistantMessage = {
					...nextResponseStep(),
					stopReason: "aborted",
				};
				outer.push({ type: "error", reason: "aborted", error: aborted });
				outer.end(aborted);
				return;
			}
			emitStep(outer, nextResponseStep());
		} catch (error) {
			const failed: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: `faux stream failed: ${String(error)}` }],
				api: fauxApi,
				provider: fauxProvider,
				timestamp: Date.now(),
				stopReason: "error",
			} as AssistantMessage;
			outer.push({ type: "error", reason: "error", error: failed });
			outer.end(failed);
		}
	});
	return outer;
};

registerApiProvider(
	{
		api: fauxApi,
		stream: fauxStream,
		streamSimple: fauxStream,
	},
	"cloud-guest-daemon-fixture",
);

const fauxModel: Model<string> = {
	id: fauxModelId,
	name: "Faux Model",
	api: fauxApi,
	provider: fauxProvider,
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
} as Model<string>;

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionOptions }) => {
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		authStorage,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});
	services.modelRegistry.registerProvider(fauxProvider, {
		baseUrl: "http://localhost:0",
		apiKey: "faux-key",
		api: fauxApi,
		streamSimple: fauxStream,
		models: [
			{
				id: fauxModelId,
				name: "Faux Model",
				api: fauxApi,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 16_384,
				baseUrl: "http://localhost:0",
			},
		],
	});
	authStorage.setRuntimeApiKey(fauxProvider, "faux-key");
	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: { model: fauxModel, systemPrompt: "You are a test assistant.", tools: [] },
		convertToLlm,
	});
	// The guest daemon passes host-level session options (subagent depth,
	// agent-message/observe controllers) exactly like the production factory;
	// honor them so guest descendants behave as hosted states.
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: services.settingsManager,
		cwd,
		modelRegistry: services.modelRegistry,
		resourceLoader: services.resourceLoader,
		rlmDepth: sessionOptions?.rlmDepth ?? 0,
		...(sessionOptions as Record<string, never>),
	} as never);
	return {
		session,
		services,
		diagnostics: [],
		extensionsResult: {
			extensions: [],
			errors: [],
		} as never,
	};
};

/**
 * The faux factory plus extra registered providers/models, so guest
 * model-selector tests can exercise slash-bearing and slash-free model ids
 * (e.g. a bundled-style `z-ai/glm` id) without any network or catalog refresh.
 * The faux provider keeps its own model; registering a provider replaces that
 * provider's model list only.
 */
export function createFauxRuntimeFactoryWithModels(
	providers: Array<{ provider: string; apiKey?: string; models: Array<{ id: string; name?: string }> }>,
): CreateAgentSessionRuntimeFactory {
	return async (options) => {
		const runtime = await createRuntime(options);
		for (const config of providers) {
			const apiKey = config.apiKey ?? "faux-key";
			runtime.services.modelRegistry.registerProvider(config.provider, {
				baseUrl: "http://localhost:0",
				apiKey,
				api: fauxApi,
				streamSimple: fauxStream,
				models: config.models.map((model) => ({
					id: model.id,
					name: model.name ?? model.id,
					api: fauxApi,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 16_384,
				})),
			});
			runtime.services.authStorage.setRuntimeApiKey(config.provider, apiKey);
		}
		return runtime;
	};
}

/**
 * The fixture runs as the guest daemon only when the bridge spawned it; the
 * in-process guest-daemon test imports the same factory instead.
 */
export { createRuntime as createFauxRuntimeFactory };

if (process.env.PRIME_AGENT_INTERNAL_CLOUD_DAEMON === "1") {
	// B1 evidence: record (not print) the scoped inference credential the
	// bridge passed, so the e2e test can prove the real env path without
	// leaking it into logs.
	try {
		writeFileSync(
			join(process.env.PRIME_AGENT_CLOUD_AGENT_DIR ?? "/tmp", "credential-seen.json"),
			`${JSON.stringify({ apiKey: process.env.PRIME_API_KEY ?? null })}\n`,
			{ mode: 0o600 },
		);
	} catch {
		// The marker is best-effort evidence; the daemon runs regardless.
	}
	void runCloudDaemonMode({ createRuntime }).catch((error) => {
		console.error(`cloud guest daemon fixture failed: ${String(error)}`);
		process.exit(1);
	});
}
