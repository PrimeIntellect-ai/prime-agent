// Shared faux-provider driver extension for the parity harnesses
// (visual_parity.py, tool_card_parity.py, compact_parity.py): registers the
// faux provider with scripted responses read from PRIME_AGENT_FAUX_SCRIPT
// (same harness contract the Rust rewrite uses). Verification harness only;
// never installed for real users.
import {
	registerFauxProvider,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	getApiProvider,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";

// The daemon's post-turn dashboard status line (daemon-session-summarizer).
// It normally resolves to a small prime-inference model, but a daemon whose
// status-line request falls back to the session model would otherwise
// consume a scripted response and desync the faux queue mid-script.
const AGENT_STATUS_SYSTEM_PROMPT_PREFIX =
	"You generate a status line for an AI coding agent dashboard.";

function isStatusLineRequest(context) {
	return (
		typeof context?.systemPrompt === "string" &&
		context.systemPrompt.startsWith(AGENT_STATUS_SYSTEM_PROMPT_PREFIX)
	);
}

export default function registerVisualFaux(pi) {
	const scriptPath = process.env.PRIME_AGENT_FAUX_SCRIPT;
	const script = scriptPath ? JSON.parse(readFileSync(scriptPath, "utf8")) : {};
	const provider = script.provider || "faux";
	const modelId = script.modelId || "faux-1";
	const faux = registerFauxProvider({
		provider,
		api: "faux",
		models: [
			{
				id: modelId,
				name: script.modelName || "Faux Model",
				reasoning: script.reasoning ?? false,
				contextWindow: script.contextWindow ?? 128000,
			},
		],
		tokensPerSecond: script.tokensPerSecond,
	});
	const responses = (script.responses || []).map((entry) => {
		let content;
		if (typeof entry === "string") {
			content = [fauxText(entry)];
		} else if (Array.isArray(entry.content)) {
			content = entry.content.map((block) => {
				if (block.type === "thinking") return fauxThinking(block.thinking);
				if (block.type === "toolCall") return fauxToolCall(block.name, block.arguments, { id: block.id });
				return fauxText(block.text);
			});
		} else {
			content = [fauxText(entry.text || "")];
		}
		const stopReason =
			entry.stopReason ||
			(content.some((block) => block.type === "toolCall") ? "toolUse" : "stop");
		// Optional scripted error text (the Rust faux script's contract):
		// rides the message with `stopReason: "error"`, so overflow-recovery
		// harnesses can script provider overflow responses.
		return fauxAssistantMessage(content, { stopReason, errorMessage: entry.errorMessage });
	});
	faux.setResponses(responses);
	const apiProvider = getApiProvider(faux.api);
	if (!apiProvider) {
		throw new Error("Faux API provider was not registered");
	}
	const scriptedStreamSimple = apiProvider.streamSimple;
	const streamSimple = (model, context, options) => {
		if (isStatusLineRequest(context)) {
			// Serve the dashboard status line from a canned empty verdict that
			// parses to no recap — the same visible state as the skipped
			// request — without consuming a scripted response.
			const stream = createAssistantMessageEventStream();
			const message = fauxAssistantMessage([fauxText("")], { stopReason: "stop" });
			message.api = model.api;
			message.provider = model.provider;
			message.model = model.id;
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		}
		return scriptedStreamSimple(model, context, options);
	};
	pi.registerProvider(provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: faux.getModel().baseUrl,
		streamSimple,
		models: faux.models.map((model) => ({
			api: model.api,
			baseUrl: model.baseUrl,
			contextWindow: model.contextWindow,
			cost: model.cost,
			id: model.id,
			input: model.input,
			maxTokens: model.maxTokens,
			name: model.name,
			reasoning: model.reasoning,
		})),
	});
}
