import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "..");
const aiEntryUrl = new URL("../src/index.ts", import.meta.url).href;

const SDK_SPECIFIERS = [
	"@anthropic-ai/sdk",
	"openai",
	"@google/genai",
	"@mistralai/mistralai",
	"@aws-sdk/client-bedrock-runtime",
] as const;

type ProbeResult = {
	loadedSpecifiers: string[];
};

function runProbe(action: string): ProbeResult {
	const script = [
		`const targets = ${JSON.stringify([...SDK_SPECIFIERS])};`,
		`const mod = await import("${aiEntryUrl}");`,
		action,
		`const Module = require("module");`,
		`const cacheKeys = Object.keys(Module._cache);`,
		`const loaded = targets.filter((spec) => cacheKeys.some((k) => k.includes(spec)));`,
		`console.log(JSON.stringify({ loadedSpecifiers: loaded }));`,
	].join("\n");

	const result = spawnSync(process.execPath, ["--eval", script], {
		cwd: packageRoot,
		encoding: "utf8",
	});

	if (result.status !== 0) {
		throw new Error(`Probe failed (exit ${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	}

	const stdoutLines = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const lastLine = stdoutLines.at(-1);
	if (!lastLine) {
		throw new Error(`Probe produced no output\nSTDERR:\n${result.stderr}`);
	}

	return JSON.parse(lastLine) as ProbeResult;
}

describe("lazy provider module loading", () => {
	it("does not load provider SDKs when importing the root barrel", () => {
		const result = runProbe("");
		expect(result.loadedSpecifiers).toEqual([]);
	});

	it("loads only the Anthropic SDK when calling the root lazy wrapper", () => {
		const result = runProbe(
			[
				`const model = {`,
				`  id: "claude-sonnet-4-6",`,
				`  api: "anthropic-messages",`,
				`  provider: "anthropic",`,
				`  baseUrl: "http://127.0.0.1:9",`,
				`  reasoning: true,`,
				`  input: ["text"],`,
				`  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },`,
				`  contextWindow: 200000,`,
				`  maxTokens: 8192,`,
				`};`,
				`const context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };`,
				`try { await mod.streamSimpleAnthropic(model, context).result(); } catch (_e) {}`,
			].join("\n"),
		);

		expect(result.loadedSpecifiers).toEqual(["@anthropic-ai/sdk"]);
	});

	it("loads only the Anthropic SDK when dispatching through streamSimple", () => {
		const result = runProbe(
			[
				`const model = mod.getModel("anthropic", "claude-sonnet-4-6");`,
				`const context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };`,
				`try { await mod.streamSimple(model, context).result(); } catch (_e) {}`,
			].join("\n"),
		);

		expect(result.loadedSpecifiers).toEqual(["@anthropic-ai/sdk"]);
	});
});
