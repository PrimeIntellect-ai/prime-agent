import { describe, expect, it } from "vitest";
import {
	buildChildPrompt,
	buildOrchestratorPrompt,
	DEFAULT_EVAL_CONFIG,
	type EvalConfig,
	parseAnswerLine,
	parseEvalArgs,
	renderMarkdownReport,
	trialResultFromSnapshot,
} from "../scripts/swarm-starvation-eval.js";
import { evaluateMessagingDefenseLines, type MessagingStatsSnapshot } from "../src/core/messaging-stats.js";

function snapshot(overrides: Partial<MessagingStatsSnapshot> = {}): MessagingStatsSnapshot {
	return {
		arrivals: { total: 3, last5m: 3 },
		model_steps: { total: 6, last5m: 6, tokens: 6_000 },
		ingestion_steps: { total: 2, last5m: 2, tokens: 800 },
		context: { estimated_agent_message_tokens: 100, context_tokens: 1_000, share: 0.1 },
		sends: { attempts: 3, failures: 0 },
		...overrides,
	};
}

describe("evaluateMessagingDefenseLines", () => {
	it("passes when every pre-registered line holds", () => {
		const defense = evaluateMessagingDefenseLines(snapshot());
		expect(defense.contextShare).toEqual({ value: 0.1, limit: 0.25, passed: true });
		expect(defense.turnShare.passed).toBe(true);
		expect(defense.costShare).toEqual({ value: 800 / 6_000, limit: 0.2, passed: true });
		expect(defense.verdict).toBe("pass");
	});

	it("fails on the first crossed line", () => {
		const defense = evaluateMessagingDefenseLines(
			snapshot({ ingestion_steps: { total: 3, last5m: 3, tokens: 800 } }),
		);
		expect(defense.turnShare).toEqual({ value: 0.5, limit: 1 / 3, passed: false });
		expect(defense.verdict).toBe("fail");
	});

	it("stays inconclusive instead of passing without measurements", () => {
		const defense = evaluateMessagingDefenseLines(
			snapshot({
				model_steps: { total: 0, last5m: 0, tokens: 0 },
				ingestion_steps: { total: 0, last5m: 0, tokens: 0 },
				context: { estimated_agent_message_tokens: 0, context_tokens: null, share: null },
			}),
		);
		expect(defense.contextShare.passed).toBeNull();
		expect(defense.turnShare.passed).toBeNull();
		expect(defense.verdict).toBe("inconclusive");
	});

	it("treats the exact limit as passing and honors overrides", () => {
		const defense = evaluateMessagingDefenseLines(
			snapshot({
				context: { estimated_agent_message_tokens: 250, context_tokens: 1_000, share: 0.25 },
			}),
			{ contextShare: 0.25 },
		);
		expect(defense.contextShare.passed).toBe(true);
	});
});

describe("swarm eval config and prompts", () => {
	it("parses arguments with defaults and validates the model", () => {
		const config = parseEvalArgs(["--model", "internal/glm-5.2-fast", "--sizes", "2,10"]);
		expect(config).toMatchObject({
			model: "internal/glm-5.2-fast",
			sizes: [2, 10],
			messageSize: "short",
			pattern: "spread",
			trials: 1,
		});
		expect(parseEvalArgs(["--sizes", "2"])).toEqual({ error: "--model is required (provider/id)" });
		expect(parseEvalArgs(["--model", "x/y", "--nonsense"])).toEqual({ error: "Unknown argument: --nonsense" });
	});

	it("builds deterministic child prompts per pattern and message size", () => {
		const config = { ...DEFAULT_EVAL_CONFIG, model: "m" } as EvalConfig;
		const short = buildChildPrompt(1, 481, config);
		expect(short).toContain("481");
		expect(short).toContain("REPORT 481");
		expect(short).toContain("asyncio.sleep(2)");
		expect(short).not.toContain("filler");
		const burst = buildChildPrompt(0, 481, { ...config, pattern: "burst" });
		expect(burst).toContain("Reply immediately");
		const long = buildChildPrompt(0, 481, { ...config, messageSize: "long" });
		expect(long).toContain("200 lines each containing only the word filler");
	});

	it("embeds every child prompt and the answer format in the orchestrator prompt", () => {
		const config = { ...DEFAULT_EVAL_CONFIG, model: "m" } as EvalConfig;
		const prompt = buildOrchestratorPrompt(config, 3, [111, 222, 333]);
		expect(prompt).toContain("3-subagent crew");
		expect(prompt).toContain("111");
		expect(prompt).toContain("333");
		expect(prompt).toContain("ANSWER:");
		expect(prompt).toContain('"""');
	});
});

describe("swarm eval verification and reporting", () => {
	it("parses the ANSWER line", () => {
		expect(parseAnswerLine("work done\nANSWER: 12, 34, 56")).toEqual([12, 34, 56]);
		expect(parseAnswerLine("ANSWER: 12,34")).toEqual([12, 34]);
		expect(parseAnswerLine("no answer")).toBeNull();
		expect(parseAnswerLine(undefined)).toBeNull();
	});

	it("turns task failures and rate-limit errors into instant fail verdicts", () => {
		const config = { ...DEFAULT_EVAL_CONFIG, model: "internal/glm-5.2-fast" } as EvalConfig;
		const ok = trialResultFromSnapshot(config, 5, 1, snapshot(), true, undefined, 12);
		expect(ok.verdict).toBe("pass");
		const wrongAnswer = trialResultFromSnapshot(config, 5, 1, snapshot(), false, undefined, 12);
		expect(wrongAnswer.verdict).toBe("fail");
		const rateLimited = trialResultFromSnapshot(config, 5, 1, snapshot(), true, "rate-limit error during trial", 12);
		expect(rateLimited.verdict).toBe("fail");
		expect(rateLimited.instantFail).toBe("rate-limit error during trial");
	});

	it("renders a markdown report with every trial and a verdict summary", () => {
		const config = { ...DEFAULT_EVAL_CONFIG, model: "internal/glm-5.2-fast" } as EvalConfig;
		const rows = [
			trialResultFromSnapshot(config, 2, 1, snapshot(), true, undefined, 10),
			trialResultFromSnapshot(
				config,
				2,
				2,
				snapshot({ ingestion_steps: { total: 5, last5m: 5, tokens: 5_000 } }),
				true,
				undefined,
				11,
			),
		];
		const report = renderMarkdownReport(rows, config);
		expect(report).toContain("# Swarm starvation eval report");
		expect(report).toContain("context <= 25%");
		expect(report).toContain("| 2 | 1 |");
		expect(report).toContain("1/2 trials failed");
	});
});
