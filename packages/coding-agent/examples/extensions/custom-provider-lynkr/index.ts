/**
 * Lynkr Provider Extension
 *
 * Lynkr (https://github.com/Fast-Editor/Lynkr) is an open-source, self-hosted
 * LLM gateway that exposes an OpenAI-compatible API (/v1/chat/completions,
 * /v1/models) in front of local backends (Ollama, llama.cpp, LM Studio, MLX
 * Server) and/or cloud providers it's configured to route to.
 *
 * Because Lynkr already speaks the standard OpenAI Chat Completions wire
 * format, no custom streaming implementation is needed here -- this registers
 * it as an `openai-completions` provider and discovers whatever models are
 * currently configured on the gateway via its `/v1/models` endpoint.
 *
 * Usage:
 *   1. Run Lynkr locally (defaults to http://localhost:8081).
 *   2. pi -e ./packages/coding-agent/examples/extensions/custom-provider-lynkr
 *   3. prime-agent model list   # should list your Lynkr-routed models
 *
 * Lynkr doesn't validate the API key, so any non-empty string works -- set
 * LYNKR_API_KEY if your deployment does enforce one.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASE_URL = "http://localhost:8081/v1";

interface LynkrModel {
	id: string;
	name?: string;
	context_window?: number;
	max_tokens?: number;
}

export default async function (pi: ExtensionAPI) {
	const baseUrl = process.env.LYNKR_BASE_URL ?? DEFAULT_BASE_URL;

	let models: LynkrModel[] = [];
	try {
		const response = await fetch(`${baseUrl}/models`);
		if (response.ok) {
			const payload = (await response.json()) as { data: LynkrModel[] };
			models = payload.data ?? [];
		}
	} catch {
		// Lynkr not running yet -- fall back to an empty model list rather than
		// failing startup. Restart prime-agent once Lynkr is up to pick up models.
	}

	pi.registerProvider("lynkr", {
		name: "Lynkr",
		baseUrl,
		apiKey: process.env.LYNKR_API_KEY ?? "local",
		api: "openai-completions",
		models: models.map((model) => ({
			id: model.id,
			name: model.name ?? model.id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: model.context_window ?? 128000,
			maxTokens: model.max_tokens ?? 16384,
		})),
	});
}
