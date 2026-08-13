import { describe, expect, it } from "vitest";
import {
	parseWorkflowScript,
	runWorkflow,
	type WorkflowAgentRunner,
	type WorkflowAgentRunOptions,
	type WorkflowUsage,
} from "../src/core/workflows/runtime.js";

class FakeRunner implements WorkflowAgentRunner {
	readonly prompts: string[] = [];
	active = 0;
	maxActive = 0;

	constructor(private readonly delayMs = 0) {}

	async run(prompt: string, _options: WorkflowAgentRunOptions) {
		this.prompts.push(prompt);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
			if (prompt === "fail") throw new Error("agent failed");
			return {
				result: prompt.toUpperCase(),
				usage: { input: 2, output: 3, totalTokens: 5, cost: 0.01 },
			};
		} finally {
			this.active--;
		}
	}
}

const header = `meta = {"name": "test-flow", "description": "Test workflow"}`;

describe("Python dynamic workflow runtime", () => {
	it("parses literal metadata and rejects executable metadata", async () => {
		await expect(parseWorkflowScript(`${header}\nreturn await agent("ok")`)).resolves.toEqual(
			expect.objectContaining({ meta: { name: "test-flow", description: "Test workflow" } }),
		);
		await expect(
			parseWorkflowScript(`meta = {"name": str("bad"), "description": "no"}\nreturn await agent("ok")`),
		).rejects.toThrow("literal");
		await expect(parseWorkflowScript('return await agent("ok")')).rejects.toThrow("first statement");
		await expect(
			parseWorkflowScript(
				`meta = {
    "name": "comments",  # a closing brace in a comment: }
    "description": "Valid",
}
return await agent("ok")`,
			),
		).resolves.toEqual(expect.objectContaining({ meta: { name: "comments", description: "Valid" } }));
		await expect(
			parseWorkflowScript(`${header}
agent = None
return await agent("x")`),
		).rejects.toThrow("reserved name");
		await expect(
			parseWorkflowScript(`${header}
phase("Read")
result = await agent(
    "x",
    phase="Read",
)
return result`),
		).resolves.toEqual(expect.objectContaining({ meta: expect.objectContaining({ name: "test-flow" }) }));
	});

	it("runs parallel agents concurrently and preserves result order", async () => {
		const runner = new FakeRunner(20);
		const result = await runWorkflow(
			`${header}
phase("Scan")
return await parallel([
    lambda: agent("first", label="one"),
    lambda: agent("second", label="two"),
])`,
			{ runner, concurrency: 2 },
		);

		expect(result.result).toEqual(["FIRST", "SECOND"]);
		expect(result.phases).toEqual(["Scan"]);
		expect(result.agentCount).toBe(2);
		expect(result.usage.totalTokens).toBe(10);
		expect(runner.maxActive).toBe(2);
	});

	it("pipelines each item through sequential stages", async () => {
		const runner = new FakeRunner();
		const result = await runWorkflow(
			`${header}
return await pipeline(
    ["a", "b"],
    lambda item, original, index: agent("scan-" + item),
    lambda previous, original, index: agent(previous + "-verify"),
)`,
			{ runner },
		);

		expect(result.result).toEqual(["SCAN-A-VERIFY", "SCAN-B-VERIFY"]);
		expect(runner.prompts.slice(0, 2)).toEqual(["scan-a", "scan-b"]);
		expect(runner.prompts.slice(2).sort()).toEqual(["SCAN-A-verify", "SCAN-B-verify"]);
	});

	it("returns None for failed agents and records the error", async () => {
		const runner = new FakeRunner();
		const result = await runWorkflow(`${header}\nreturn await agent("fail")`, { runner });
		expect(result.result).toBeNull();
		expect(result.logs).toEqual([expect.stringContaining("agent failed")]);
	});

	it("enforces agent, serialization, and execution limits", async () => {
		const runner = new FakeRunner();
		await expect(
			runWorkflow(`${header}\nreturn await parallel([lambda: agent("a"), lambda: agent("b")])`, {
				runner,
				maxAgents: 1,
			}),
		).rejects.toThrow("agent cap");
		await expect(
			runWorkflow(`${header}\nwhile True:\n    pass\nreturn await agent("never")`, {
				runner,
				scriptTimeoutMs: 100,
			}),
		).rejects.toThrow("interrupted");
		await expect(runWorkflow(`${header}\nawait agent("value")\nreturn lambda: 1`, { runner })).rejects.toThrow(
			"JSON-serializable",
		);
	});

	it("rejects imports, private introspection, and host file access before execution", async () => {
		await expect(parseWorkflowScript(`${header}\nimport os\nreturn await agent("x")`)).rejects.toThrow("import");
		await expect(
			parseWorkflowScript(`${header}\nvalue = (1).__class__\nreturn await agent(str(value))`),
		).rejects.toThrow("dunder");
		await expect(
			parseWorkflowScript(`${header}\nvalue = open("/etc/passwd").read()\nreturn await agent(value)`),
		).rejects.toThrow("not allowed");
	});

	it("passes args, schema/model options, and replayed results", async () => {
		const runner = new FakeRunner();
		const recorded: Array<{ key: string; occurrence: number; result: unknown }> = [];
		const journal = {
			start: () => undefined,
			replay: (entry: { sequence: number; key: string; occurrence: number }) => ({
				...entry,
				result: { ok: true },
			}),
			record: (entry: { sequence: number; key: string; occurrence: number; result: unknown }) => {
				recorded.push(entry);
			},
		};
		const result = await runWorkflow(
			`${header}
return await agent(
    args["prompt"],
    model="provider/model",
    schema={"type": "object"},
)`,
			{ runner, args: { prompt: "cached" }, journal },
		);
		expect(result.result).toEqual({ ok: true });
		expect(result.replayedCount).toBe(1);
		expect(runner.prompts).toEqual([]);
		expect(recorded).toEqual([]);
	});

	it("cancels the Monty worker and active native child together", async () => {
		const controller = new AbortController();
		let notifyStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		const runner: WorkflowAgentRunner = {
			async run() {
				notifyStarted?.();
				return await new Promise(() => undefined);
			},
		};
		const pending = runWorkflow(`${header}\nreturn await agent("wait")`, {
			runner,
			signal: controller.signal,
			scriptTimeoutMs: 5_000,
		});
		await started;
		const abortedAt = Date.now();
		controller.abort(new Error("cancelled by test"));
		await expect(pending).rejects.toThrow("cancelled by test");
		expect(Date.now() - abortedAt).toBeLessThan(500);
	});

	it("bounds workflow arguments before execution", async () => {
		await expect(
			runWorkflow(`${header}\nreturn await agent("never")`, {
				runner: new FakeRunner(),
				args: { huge: "x".repeat(1024 * 1024) },
			}),
		).rejects.toThrow("args exceed");
	});

	it("canonicalizes line endings and rejects control-character indentation escapes", async () => {
		await expect(parseWorkflowScript(`${header}\rreturn await agent("ok") # hidden\rimport os`)).rejects.toThrow(
			"import",
		);
		await expect(parseWorkflowScript(`${header}\nreturn await agent("ok")\fimport os`)).rejects.toThrow(
			"control character",
		);
		await expect(parseWorkflowScript(`${header}\nｏｐｅｎ = None\nreturn await agent("ok")`)).rejects.toThrow(
			"not allowed",
		);
	});

	it("rejects non-plain host values and invalid usage", async () => {
		const dateRunner: WorkflowAgentRunner = {
			async run() {
				return { result: new Date() };
			},
		};
		const invalidUsageRunner: WorkflowAgentRunner = {
			async run() {
				return { result: "ok", usage: { totalTokens: Number.NaN } };
			},
		};
		await expect(runWorkflow(`${header}\nreturn await agent("date")`, { runner: dateRunner })).rejects.toThrow(
			"plain JSON containers",
		);
		await expect(
			runWorkflow(`${header}\nreturn await agent("usage")`, { runner: invalidUsageRunner }),
		).rejects.toThrow("non-negative safe integer");
		const inheritedUsageRunner: WorkflowAgentRunner = {
			async run() {
				return { result: "ok", usage: Object.create({ totalTokens: -100 }) as Partial<WorkflowUsage> };
			},
		};
		await expect(
			runWorkflow(`${header}\nreturn await agent("usage")`, { runner: inheritedUsageRunner }),
		).rejects.toThrow("plain object");
	});

	it("fails when reported usage exceeds the token target", async () => {
		await expect(
			runWorkflow(`${header}\nreturn await agent("large")`, {
				runner: new FakeRunner(),
				tokenBudget: 4,
			}),
		).rejects.toThrow("token budget exceeded");
	});

	it("rejects unknown metadata and agent option fields", async () => {
		await expect(
			parseWorkflowScript(
				`meta = {"name": "test", "description": "test", "unknown": True}\nreturn await agent("ok")`,
			),
		).rejects.toThrow("unknown workflow meta field");
		await expect(
			runWorkflow(`${header}\nreturn await agent("ok", unknown=True)`, { runner: new FakeRunner() }),
		).rejects.toThrow("unexpected keyword argument");
	});

	it("fails closed when the Monty WASI fallback is forced", async () => {
		const previous = process.env.NAPI_RS_FORCE_WASI;
		try {
			process.env.NAPI_RS_FORCE_WASI = "true";
			await expect(parseWorkflowScript(`${header}\nreturn await agent("ok")`)).rejects.toThrow(
				"WASI is not allowed",
			);
			process.env.NAPI_RS_FORCE_WASI = "error";
			await expect(parseWorkflowScript(`${header}\nreturn await agent("ok")`)).rejects.toThrow(
				"WASI is not allowed",
			);
		} finally {
			if (previous === undefined) delete process.env.NAPI_RS_FORCE_WASI;
			else process.env.NAPI_RS_FORCE_WASI = previous;
		}
	});

	it("rejects f-string expressions without matching comments or ordinary string contents", async () => {
		await expect(
			parseWorkflowScript(`${header}\n# Avoid f" formatting\nx = 'literal f" text'\nreturn await agent(x)`),
		).resolves.toBeDefined();
		await expect(parseWorkflowScript(`${header}\nreturn await agent(rf"{open('x')}")`)).rejects.toThrow("f-strings");
	});
});
