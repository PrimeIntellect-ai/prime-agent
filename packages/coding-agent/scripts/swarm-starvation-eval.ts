#!/usr/bin/env node
/**
 * Swarm starvation eval — PR B of the swarm communication feature set.
 * https://app.notion.com/p/3dc72940136f81459434f29f1a88f73f
 *
 * Drives a real in-process orchestrator session (children spawn via rlm.spawn,
 * replies arrive as agent messages) across crew sizes x message sizes x arrival
 * patterns, then scores each trial against the pre-registered defense lines:
 *   context <= 25%   agent-message share of working context
 *   turns  <= 1/3    agent-triggered model steps over all steps
 *   cost   <= 20%    ingestion-step usage tokens over all step tokens
 * Rate-limit errors during a trial are an instant fail.
 *
 * This script spends real model tokens. It never runs in CI; the deterministic
 * pieces (defense lines, prompts, verification, reports) are unit-tested in
 * test/swarm-eval.test.ts.
 *
 * Usage:
 *   npx tsx scripts/swarm-starvation-eval.ts \
 *     --model internal/glm-5.2-fast --sizes 2,5,10,20,40 \
 *     --msg-size short --pattern spread --trials 1 --out ./swarm-eval-reports
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { AuthStorage } from "../src/core/auth-storage.js";
import { getAgentDir } from "../src/config.js";
import {
	evaluateMessagingDefenseLines,
	MESSAGING_DEFENSE_LINE_LIMITS,
	type MessagingStatsSnapshot,
} from "../src/core/messaging-stats.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createAgentSession } from "../src/core/sdk.js";

export type MessageSize = "short" | "long";
export type ArrivalPattern = "spread" | "burst";

export interface EvalConfig {
	model: string;
	sizes: number[];
	messageSize: MessageSize;
	pattern: ArrivalPattern;
	trials: number;
	gapSeconds: number;
	timeoutMinutes: number;
	outDir: string;
	seed: number;
}

export const DEFAULT_EVAL_CONFIG: Pick<
	EvalConfig,
	"sizes" | "messageSize" | "pattern" | "trials" | "gapSeconds" | "timeoutMinutes" | "seed"
> = {
	sizes: [2, 5, 10, 20, 40],
	messageSize: "short",
	pattern: "spread",
	trials: 1,
	gapSeconds: 2,
	timeoutMinutes: 15,
	seed: 1,
};

export function parseEvalArgs(argv: string[], defaults = DEFAULT_EVAL_CONFIG): EvalConfig | { error: string } {
	const args = { ...defaults, model: "", outDir: "", sizes: [...defaults.sizes] } as EvalConfig;
	const rest = [...argv];
	while (rest.length > 0) {
		const arg = rest.shift() as string;
		const value = (flag: string): string => {
			const next = rest.shift();
			if (next === undefined) throw new Error(`Missing value for ${flag}`);
			return next;
		};
		switch (arg) {
			case "--model":
				args.model = value(arg);
				break;
			case "--sizes":
				args.sizes = value(arg)
					.split(",")
					.map((raw) => Number(raw.trim()))
					.filter((n) => n > 0);
				break;
			case "--msg-size":
				args.messageSize = value(arg) === "long" ? "long" : "short";
				break;
			case "--pattern":
				args.pattern = value(arg) === "burst" ? "burst" : "spread";
				break;
			case "--trials":
				args.trials = Math.max(1, Number(value(arg)));
				break;
			case "--gap-seconds":
				args.gapSeconds = Math.max(0, Number(value(arg)));
				break;
			case "--timeout-minutes":
				args.timeoutMinutes = Math.max(1, Number(value(arg)));
				break;
			case "--out":
				args.outDir = value(arg);
				break;
			case "--seed":
				args.seed = Number(value(arg));
				break;
			case "--help":
			case "-h":
				return { error: "help" };
			default:
				return { error: `Unknown argument: ${arg}` };
		}
	}
	if (!args.model) return { error: "--model is required (provider/id)" };
	if (args.sizes.length === 0) return { error: "--sizes must contain at least one positive size" };
	if (!args.outDir) args.outDir = `swarm-eval-reports/${new Date().toISOString().replace(/[:.]/g, "-")}`;
	return args;
}

function seededSecrets(seed: number, count: number): number[] {
	// Deterministic 3-digit secrets from a simple hash chain; evals must be reproducible.
	const secrets: number[] = [];
	let digest = createHash("sha256").update(`${seed}:${count}:0`).digest();
	for (let i = 0; i < count; i++) {
		if (i % 2 === 0) digest = createHash("sha256").update(digest).digest();
		secrets.push(100 + (digest[0] * 256 + digest[1]) % 900);
	}
	return secrets;
}

export function buildChildPrompt(index: number, secret: number, config: EvalConfig): string {
	const lines = [
		`Coordination eval child ${index + 1}.`,
		`Your secret number is ${secret}.`,
		config.pattern === "spread"
			? `Before replying, run \`await asyncio.sleep(${index * config.gapSeconds})\` in the ipython tool, then continue.`
			: "Reply immediately without waiting.",
		`Reply to your parent with exactly: REPORT ${secret}${
			config.messageSize === "long" ? ", followed by 200 lines each containing only the word filler" : ""
		}.`,
		"Use `await agent_message.send(..., receiver_role='parent')` to reply, then end your turn. Do nothing else.",
	];
	return lines.join("\n");
}

export function buildOrchestratorPrompt(config: EvalConfig, size: number, secrets: number[]): string {
	const childPromptBlocks = secrets
		.map((secret, i) => `- Child c${i + 1} prompt (copy verbatim):\n  """\n  ${buildChildPrompt(i, secret, config).replaceAll("\n", "\n  ")}\n  """`)
		.join("\n");
	return [
		`Coordination eval. You are the orchestrator of a ${size}-subagent crew.`,
		"",
		"1. In one message, spawn every child below with `await rlm.spawn(...)` using the exact child prompt text given for it.",
		"2. Each child replies to you with a REPORT line containing its secret number.",
		`3. When all ${size} children have replied, output exactly one line:`,
		"   ANSWER: <secret numbers of c1, c2, ... in child-name order, comma-separated>",
		"Never emit the ANSWER line before every child has replied. End your turn only after emitting it.",
		"",
		"Child prompts:",
		childPromptBlocks,
	].join("\n");
}

/** Parse the final ANSWER line; returns null when absent or malformed. */
export function parseAnswerLine(text: string | undefined): number[] | null {
	const match = /ANSWER:\s*([0-9]+(?:\s*,\s*[0-9]+)*)/i.exec(text ?? "");
	if (!match) return null;
	const numbers = match[1].split(",").map((raw) => Number(raw.trim()));
	return numbers.length > 0 && numbers.every((n) => Number.isInteger(n)) ? numbers : null;
}

export interface SwarmEvalTrialResult {
	size: number;
	messageSize: MessageSize;
	pattern: ArrivalPattern;
	trial: number;
	model: string;
	taskSuccess: boolean;
	instantFail: string | undefined;
	arrivals: number;
	arrivalsLast5m: number;
	modelSteps: number;
	ingestionSteps: number;
	modelStepTokens: number;
	ingestionStepTokens: number;
	estimatedAgentMessageTokens: number;
	contextTokens: number | null;
	defense: ReturnType<typeof evaluateMessagingDefenseLines>;
	verdict: "pass" | "fail" | "inconclusive";
	seconds: number;
}

export function trialResultFromSnapshot(
	config: EvalConfig,
	size: number,
	trial: number,
	snapshot: MessagingStatsSnapshot,
	taskSuccess: boolean,
	instantFail: string | undefined,
	seconds: number,
): SwarmEvalTrialResult {
	const defense = evaluateMessagingDefenseLines(snapshot);
	return {
		size,
		messageSize: config.messageSize,
		pattern: config.pattern,
		trial,
		model: config.model,
		taskSuccess,
		instantFail,
		arrivals: snapshot.arrivals.total,
		arrivalsLast5m: snapshot.arrivals.last5m,
		modelSteps: snapshot.model_steps.total,
		ingestionSteps: snapshot.ingestion_steps.total,
		modelStepTokens: snapshot.model_steps.tokens,
		ingestionStepTokens: snapshot.ingestion_steps.tokens,
		estimatedAgentMessageTokens: snapshot.context.estimated_agent_message_tokens,
		contextTokens: snapshot.context.context_tokens,
		defense,
		verdict:
			instantFail !== undefined || !taskSuccess
				? "fail"
				: defense.verdict,
		seconds,
	};
}

export function renderMarkdownReport(results: SwarmEvalTrialResult[], config: EvalConfig): string {
	const header = [
		"# Swarm starvation eval report",
		"",
		`- model: ${config.model}`,
		`- sizes: ${config.sizes.join(", ")}`,
		`- message size: ${config.messageSize}  |  arrival pattern: ${config.pattern}  |  trials per config: ${config.trials}`,
		`- defense lines: context <= ${(MESSAGING_DEFENSE_LINE_LIMITS.contextShare * 100).toFixed(0)}%, turns <= ${(MESSAGING_DEFENSE_LINE_LIMITS.turnShare * 100).toFixed(0)}%, cost <= ${(MESSAGING_DEFENSE_LINE_LIMITS.costShare * 100).toFixed(0)}% (a trial with a rate-limit error or a wrong final answer fails instantly)`,
		"",
		"| size | trial | arrivals | steps | ing. steps | ctx share | turn share | cost share | task | verdict |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
	const rows = results.map((row) =>
		[
			row.size,
			row.trial,
			row.arrivals,
			row.modelSteps,
			row.ingestionSteps,
			pct(row.defense.contextShare.value),
			pct(row.defense.turnShare.value),
			pct(row.defense.costShare.value),
			row.taskSuccess ? "ok" : "failed",
			row.instantFail ?? row.verdict,
		].join(" | "),
	);
	const failures = results.filter((row) => row.verdict === "fail");
	const summary = [
		"",
		"## Verdict",
		"",
		failures.length === 0
			? `All ${results.length} trials passed every defense line.`
			: `${failures.length}/${results.length} trials failed: ${failures.map((row) => `size ${row.size}/trial ${row.trial}`).join(", ")}.`,
		"",
	];
	return [...header, ...rows.map((row) => `| ${row} |`), ...summary].join("\n");
}

async function runTrial(config: EvalConfig, size: number, trial: number): Promise<SwarmEvalTrialResult> {
	const startedAt = Date.now();
	const realAgentDir = getAgentDir();
	const tempRoot = join(tmpdir(), `swarm-eval-${Date.now()}-${trial}-${size}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempRoot, { recursive: true });

	const authStorage = AuthStorage.create(join(realAgentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, join(realAgentDir, "models.json"));
	const settingsManager = SettingsManager.create(tempRoot, tempRoot);
	const sessionManager = SessionManager.create(tempRoot, join(tempRoot, "sessions"));

	const [provider, ...modelIdParts] = config.model.split("/");
	const modelId = modelIdParts.join("/");
	const model = modelRegistry.find(provider, modelId);
	if (!model) throw new Error(`Model ${config.model} not found in the registry`);

	const secrets = seededSecrets(config.seed + size * 31 + trial, size);
	const prompt = buildOrchestratorPrompt(config, size, secrets);

	const { session } = await createAgentSession({
		cwd: tempRoot,
		authStorage,
		modelRegistry,
		settingsManager,
		sessionManager,
		model,
		includeGoals: false,
	});
	try {
		await session.prompt(prompt);
		const deadline = Date.now() + config.timeoutMinutes * 60_000;
		while (Date.now() < deadline) {
			const subs = await session.listRlmSubagents();
			const unsettled = subs.subagents.filter((child) => child.status === "running").length;
			const answer = parseAnswerLine(session.getLastAssistantText());
			if (!session.isStreaming && unsettled === 0 && answer !== null) break;
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
		const answer = parseAnswerLine(session.getLastAssistantText());
		const taskSuccess = answer !== null && answer.length === size && answer.every((n, i) => n === secrets[i]);

		let instantFail: string | undefined;
		for (const message of session.agent.state.messages) {
			const candidate = message as { role: string; stopReason?: string; errorMessage?: string };
			if (
				candidate.role === "assistant" &&
				candidate.stopReason === "error" &&
				/429|rate limit|too many requests/i.test(String(candidate.errorMessage ?? ""))
			) {
				instantFail = "rate-limit error during trial";
				break;
			}
		}

		const seconds = (Date.now() - startedAt) / 1000;
		return trialResultFromSnapshot(config, size, trial, session.messagingStats(), taskSuccess, instantFail, seconds);
	} finally {
		await session.dispose();
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	const config = parseEvalArgs(argv);
	if ("error" in config) {
		console.error(config.error === "help" ? "See the header of this file for usage." : config.error);
		process.exit(config.error === "help" ? 0 : 1);
	}
	const results: SwarmEvalTrialResult[] = [];
	for (const size of config.sizes) {
		for (let trial = 1; trial <= config.trials; trial++) {
			// eslint-disable-next-line no-console
			console.log(`running crew size ${size} trial ${trial}/${config.trials} on ${config.model}`);
			try {
				results.push(await runTrial(config, size, trial));
			} catch (error) {
				// eslint-disable-next-line no-console
				console.error(`trial failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	if (results.length === 0) {
		// eslint-disable-next-line no-console
		console.error("no trials completed");
		process.exit(1);
	}
	const markdown = renderMarkdownReport(results, config);
	mkdirSync(config.outDir, { recursive: true });
	writeFileSync(join(config.outDir, "report.md"), markdown);
	writeFileSync(join(config.outDir, "report.json"), JSON.stringify({ config, results }, null, 2));
	// eslint-disable-next-line no-console
	console.log(markdown);
	// eslint-disable-next-line no-console
	console.log(`reports written to ${config.outDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	void main().catch((error: unknown) => {
		// eslint-disable-next-line no-console
		console.error(error);
		process.exit(1);
	});
}
