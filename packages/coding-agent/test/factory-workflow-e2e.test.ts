/**
 * End-to-end factory workflow tests over the real kernel bridge.
 *
 * The python-side executor tests fake the kernel host, so they cannot catch a
 * host request the TypeScript side never registered, or a kernel payload that
 * drifted from the host handler's contract -- the exact class of bug a fake
 * host passes silently. This suite closes that gap for the factory stack: a real
 * AgentSession with a real Python kernel, real in-process child sessions, and a
 * scripted model (no live model, no tokens). The kernel executes `rlm.harness`
 * and `rlm.factory` against the seeded local harness state, children spawn through
 * the real `rlm.run` host path into in-process child sessions, milestones must
 * survive the real `factory.progress` host handler to reach the parent
 * conversation, and status/stop/resume round-trip over the same bridge.
 *
 * One parent session and one kernel serve the whole file; every scenario waits
 * for its own milestone before the next drive, so the suite stays fast.
 *
 * Kernel python: this suite pins PRIME_AGENT_KERNEL_PYTHON to (in order) the
 * caller's pin, the checkout-local runtime venv, or the shared kernel venv
 * resolved exactly like the bootstrap resolves it (PRIME_AGENT_KERNEL_VENV /
 * XDG, including the bootstrap's XDG fallback dir for unwritable primary
 * parents). A pinned python is never rebuilt, so pinning is what keeps a dev
 * checkout from touching the shared ~/.prime/agent/kernel-venv that live user
 * sessions run on. The shared venv is only pinned when the production
 * readiness probe (RUNTIME_READY_CHECK) passes for it, i.e. when the bootstrap
 * itself would accept it; a stale shared venv is not. Pinning the shared venv
 * also PREPENDS this checkout's runtime source on PYTHONPATH (the venv's
 * installed runtime is not this checkout's), so the kernel always runs the
 * code under test; caller PYTHONPATH entries are kept after it. Create the
 * checkout-local venv once per checkout:
 *
 *   cd prime-agent-runtime
 *   uv venv .venv
 *   uv pip install --python .venv/bin/python -e . dill requests httpx pyyaml \
 *     tomli python-dotenv pandas numpy scipy beautifulsoup4 lxml pydantic tyro
 *
 * When no python is usable AND the shared kernel venv exists, the standard
 * bootstrap would rebuild that venv under live sessions, so the suite refuses
 * to boot and fails with the recipe above. With no pre-existing shared venv
 * (CI), the standard bootstrap builds it; CI pre-warms that via `npx tsx
 * src/core/kernel/bootstrap-cli.ts` (test:ci), so no test pays a venv build.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { getKernelVenvDir, getXdgKernelVenvDir, RUNTIME_READY_CHECK } from "../src/core/kernel/bootstrap.js";
import { convertToLlm, FACTORY_PROGRESS_NOTICE_CUSTOM_TYPE } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { getSessionArtifactPath, SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { waitForHeadlessCompletion } from "../src/modes/headless-completion.js";
import { getCodingAgentFixtureModel } from "./fixture-models.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getCodingAgentFixtureModel("anthropic", "claude-sonnet-4-5");

// ---------------------------------------------------------------------------
// Kernel python: PRIME_AGENT_KERNEL_PYTHON, else the repo-local runtime venv,
// else the shared kernel venv when the bootstrap's own readiness probe passes
// for it (a pinned python is never rebuilt). The header comment explains why.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const KERNEL_REQUIRED_IMPORTS = [
	"rlm.repl",
	"rlm.factory",
	"dill",
	"requests",
	"httpx",
	"yaml",
	"tomli",
	"dotenv",
	"pandas",
	"numpy",
	"scipy",
	"bs4",
	"lxml",
	"pydantic",
	"tyro",
].join(", ");

interface ResolvedKernelPython {
	python: string;
	sharedVenv: boolean;
	/** PYTHONPATH the kernel needs (the shared venv runs this checkout's runtime source). */
	pythonPath: string | undefined;
}

function resolveKernelPython(): ResolvedKernelPython | undefined {
	// PRIME_AGENT_KERNEL_PYTHON first, then the checkout-local runtime venv,
	// then the shared kernel venv resolved exactly like the bootstrap resolves
	// it (PRIME_AGENT_KERNEL_VENV/XDG via getKernelVenvDir, never a hard-coded
	// path). A shared venv python is accepted only when the production
	// readiness probe passes for it: a pinned python is never rebuilt, so
	// pinning it cannot disturb the live sessions that share that venv.
	const sharedVenvPythons = [getKernelVenvDir(), getXdgKernelVenvDir()].map((dir) => join(dir, "bin", "python"));
	const candidates = [
		{ python: process.env.PRIME_AGENT_KERNEL_PYTHON, sharedVenv: false },
		{ python: join(REPO_ROOT, "prime-agent-runtime", ".venv", "bin", "python"), sharedVenv: false },
		...sharedVenvPythons.map((python) => ({ python, sharedVenv: true })),
	].filter((candidate): candidate is { python: string; sharedVenv: boolean } => Boolean(candidate.python));
	for (const candidate of candidates) {
		if (!existsSync(candidate.python)) continue;
		// The shared venv's installed runtime is not this checkout's (the
		// factory stack is not on main), so the kernel must import THIS
		// checkout's runtime source: it is always prepended to PYTHONPATH so
		// the suite provably runs the code under test, with any caller-provided
		// entries kept after it. The repo-local venv is an editable install
		// of this checkout already, so it needs no injected path.
		const pythonPath = candidate.sharedVenv
			? [join(REPO_ROOT, "prime-agent-runtime", "src"), process.env.PYTHONPATH]
					.filter((entry): entry is string => Boolean(entry))
					.join(delimiter)
			: process.env.PYTHONPATH;
		const env = pythonPath ? { ...process.env, PYTHONPATH: pythonPath } : process.env;
		const check = spawnSync(candidate.python, ["-c", `import ${KERNEL_REQUIRED_IMPORTS}`], {
			encoding: "utf8",
			env,
			timeout: 30_000,
		});
		if (check.status !== 0) continue;
		if (candidate.sharedVenv) {
			// Only a python the bootstrap itself would accept is safe to pin.
			const ready = spawnSync(candidate.python, ["-c", RUNTIME_READY_CHECK], {
				encoding: "utf8",
				env,
				timeout: 30_000,
			});
			if (ready.status !== 0) continue;
		}
		return { ...candidate, pythonPath };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Scripted model plumbing (the MockAssistantStream recipe: a streamFn closure
// that answers from the last message's text, so the same closure scripts the
// parent's turns and every in-process child's turn).
// ---------------------------------------------------------------------------

const DRIVE_MARKER = "E2E-DRIVE";

type ChildScriptStep =
	| { kind: "text"; text: string }
	| { kind: "error"; message: string }
	| { kind: "gate"; releaseAnswer: string };

interface ChildScript {
	marker: string;
	answers: ChildScriptStep[];
}

function usage(input = 7, output = 3): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function assistantMessage(text: string, messageUsage = usage()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: messageUsage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** A structured permanent provider failure: the session must not retry it. */
function assistantFailureMessage(message: string): AssistantMessage {
	return {
		...assistantMessage(""),
		content: [],
		stopReason: "error",
		errorMessage: message,
		diagnostics: [
			{ type: "provider_stream_failure", timestamp: Date.now(), details: { kind: "invalid_request", status: 400 } },
		],
	};
}

function messageText(message: AgentMessage | undefined): string {
	if (!message) return "";
	if (message.role === "user" || message.role === "custom") {
		const content = message.content;
		if (typeof content === "string") return content;
		return content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
	return "";
}

/** Race a promise against a wall-clock deadline without a test-side sleep. */
async function awaitWithDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	const signal = AbortSignal.timeout(timeoutMs);
	return await Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error(message)), { once: true });
		}),
	]);
}

// ---------------------------------------------------------------------------
// Factory specs. Scenario 1 creates its machine over the bridge with
// rlm.harness.create_factory; the rest are seeded into the local harness state
// file before session creation (the kernel loads them through
// RLM_HARNESS_STATE_DIR, exactly like scripts/factory-eval.ts seeds).
// ---------------------------------------------------------------------------

const LOOP_MACHINE = {
	run: { failure_policy: "continue", max_parallel: 4 },
	states: [
		{
			id: "draft",
			entry: true,
			subagent: { prompt: "E2E-STATE:DRAFT Write the draft.", name: "e2e-draft" },
			outputs: [{ name: "draft", type: "text" }],
		},
		{
			id: "reviewing",
			subagent: {
				prompt:
					"E2E-STATE:REVIEWING Review the draft.\nDraft: {draft}\nFix report: {fix_report}\nReturn one fenced JSON verdict.",
				name: "e2e-reviewing",
			},
			inputs: [
				{ name: "draft", type: "text", from: "draft.draft" },
				{ name: "fix_report", type: "json", from: "fixing.fix_report", optional: true },
			],
			outputs: [{ name: "verdict", type: "json" }],
			max_entries: 4,
		},
		{
			id: "fixing",
			subagent: {
				prompt: "E2E-STATE:FIXING Fix the findings.\nVerdict: {verdict}\nReturn one fenced JSON fix report.",
				name: "e2e-fixing",
			},
			inputs: [{ name: "verdict", type: "json", from: "reviewing.verdict" }],
			outputs: [{ name: "fix_report", type: "json" }],
			max_entries: 3,
		},
	],
	transitions: [
		{ from: "draft", to: "reviewing" },
		{ from: "reviewing", to: "fixing", when: { output: "verdict", path: "approved", op: "eq", value: false } },
		{ from: "fixing", to: "reviewing" },
	],
};

const DIAMOND_MACHINE = {
	run: { failure_policy: "continue", max_parallel: 4 },
	states: [
		{
			id: "split",
			entry: true,
			subagent: { prompt: "E2E-STATE:SPLIT Produce the fan-out value.", name: "e2e-split" },
			outputs: [{ name: "fan", type: "text" }],
		},
		{
			id: "left",
			subagent: { prompt: "E2E-STATE:LEFT Left branch: {fan}", name: "e2e-left" },
			inputs: [{ name: "fan", type: "text", from: "split.fan" }],
			outputs: [{ name: "left_out", type: "text" }],
		},
		{
			id: "right",
			subagent: { prompt: "E2E-STATE:RIGHT Right branch: {fan}", name: "e2e-right" },
			inputs: [{ name: "fan", type: "text", from: "split.fan" }],
			outputs: [{ name: "right_out", type: "text" }],
		},
		{
			id: "join",
			subagent: { prompt: "E2E-STATE:JOIN Left: {left_in}\nRight: {right_in}", name: "e2e-join" },
			inputs: [
				{ name: "left_in", type: "text", from: "left.left_out" },
				{ name: "right_in", type: "text", from: "right.right_out" },
			],
			outputs: [{ name: "joined", type: "text" }],
		},
	],
	transitions: [
		{ from: "split", to: "left" },
		{ from: "split", to: "right" },
		{ from: "left", to: "join" },
		{ from: "right", to: "join" },
	],
};

// The failing state fails at spawn admission: an unsupported thinking level
// makes the real rlm.run host call throw (no child session starts, no network
// -- a bogus model reference would trigger provider auth preflights), which
// is the production failure shape the escalate policy guards.
const ESCALATION_MACHINE = {
	run: { failure_policy: "escalate", max_parallel: 4 },
	states: [
		{
			id: "flaky",
			entry: true,
			subagent: {
				prompt: "E2E-STATE:FLAKY Do the risky thing.",
				name: "e2e-flaky",
				thinking: "e2e-unsupported-thinking",
			},
			failure_policy: "escalate",
		},
		{
			id: "fixer",
			subagent: { prompt: "E2E-STATE:FIXER Clean up after the failure.", name: "e2e-fixer" },
			outputs: [{ name: "fixed", type: "text" }],
		},
	],
	transitions: [{ from: "flaky", to: "fixer" }],
};

const STOP_MACHINE = {
	run: { failure_policy: "continue", max_parallel: 4 },
	states: [
		{ id: "hold", entry: true, subagent: { prompt: "E2E-STATE:HOLD Work slowly.", name: "e2e-hold" } },
		{ id: "after", subagent: { prompt: "E2E-STATE:AFTER Follow up.", name: "e2e-after" } },
	],
	transitions: [{ from: "hold", to: "after" }],
};

const NONBLOCKING_MACHINE = {
	run: { failure_policy: "continue", max_parallel: 4 },
	states: [
		{
			id: "slowgate",
			entry: true,
			subagent: { prompt: "E2E-STATE:SLOWGATE Take your time.", name: "e2e-slowgate" },
			outputs: [{ name: "go", type: "text" }],
		},
		{
			id: "final",
			subagent: { prompt: "E2E-STATE:FINAL Finish: {go}", name: "e2e-final" },
			inputs: [{ name: "go", type: "text", from: "slowgate.go" }],
		},
	],
	transitions: [{ from: "slowgate", to: "final" }],
};

const DAG_CHAIN = {
	run: { failure_policy: "continue", max_parallel: 4 },
	nodes: [
		{
			id: "alpha",
			subagent: { prompt: "E2E-STATE:ALPHA Start the chain.", name: "e2e-alpha" },
			outputs: [{ name: "alpha_out", type: "text" }],
		},
		{
			id: "beta",
			subagent: { prompt: "E2E-STATE:BETA Continue: {alpha_out}", name: "e2e-beta" },
			inputs: [{ name: "alpha_out", type: "text", from: "alpha.alpha_out" }],
			outputs: [{ name: "beta_out", type: "text" }],
		},
		{
			id: "gamma",
			subagent: { prompt: "E2E-STATE:GAMMA Finish: {beta_out}", name: "e2e-gamma" },
			inputs: [{ name: "beta_out", type: "text", from: "beta.beta_out" }],
		},
	],
};

/** A local harness_state.json body seeding the given factory entries. */
function harnessStateFileBody(factoryEntries: Record<string, unknown>): string {
	return `${JSON.stringify(
		{
			schema: 1,
			entries: { prompt: {}, memory: {}, skill: {}, subagent: {}, factory: factoryEntries },
			refinements: [],
		},
		null,
		2,
	)}\n`;
}

function factoryEntry(id: string, title: string, spec: { machine?: unknown; dag?: unknown }): Record<string, unknown> {
	const now = new Date().toISOString();
	return {
		id,
		kind: "factory",
		title,
		content: `${title} (factory workflow e2e)`,
		path: "factory-workflow-e2e",
		scope: "local",
		reference: {},
		arguments: spec,
		metadata: { source: "factory-workflow-e2e" },
		source: "agent",
		created_at: now,
		updated_at: now,
		version: 1,
	};
}

// ---------------------------------------------------------------------------
// Python cell bodies (each prints exactly one JSON line).
// ---------------------------------------------------------------------------

function jsonLiteral(value: unknown): string {
	return JSON.stringify(JSON.stringify(value));
}

function createAndRunCell(entryId: string, machine: unknown): string {
	return [
		"import json",
		`machine = json.loads(${jsonLiteral(machine)})`,
		`spec = rlm.harness.create_factory(${JSON.stringify(`${entryId} machine`)}, "created over the bridge", id=${JSON.stringify(entryId)}, machine=machine)`,
		"started = await rlm.factory.run(spec.id)",
		'print(json.dumps({"spec_id": spec.id, "run_id": started["run_id"], "started": sorted(started["started"]), "nodes": started["nodes"]}))',
	].join("\n");
}

function runCell(entryId: string): string {
	return [
		"import json",
		`started = await rlm.factory.run(${JSON.stringify(entryId)})`,
		'print(json.dumps({"run_id": started["run_id"], "started": sorted(started["started"]), "nodes": started["nodes"], "pending": sorted(started["pending"])}))',
	].join("\n");
}

function statusCell(runId: string): string {
	return [
		"import json",
		`status = await rlm.factory.status(${JSON.stringify(runId)})`,
		"print(json.dumps({",
		'    "state": status["state"],',
		'    "usage": status["usage"],',
		'    "nodes": {node["id"]: {"status": node["status"], "entries_used": node["entries_used"], "error": node.get("error")} for node in status["nodes"]},',
		'    "events": [{"kind": e["kind"], "stage": e.get("stage"), "milestone": e.get("milestone"), "detail": e.get("detail"), "node": e.get("node")} for e in status["events"]],',
		"}))",
	].join("\n");
}

function stopCell(runId: string): string {
	return [
		"import json",
		`result = await rlm.factory.stop(${JSON.stringify(runId)})`,
		"print(json.dumps(result))",
	].join("\n");
}

function resumeCell(runId: string): string {
	return [
		"import json",
		`result = await rlm.factory.resume(${JSON.stringify(runId)})`,
		'print(json.dumps({"state": result["state"], "started": result["started"], "pending": result["pending"]}))',
	].join("\n");
}

// ---------------------------------------------------------------------------
// The bridge suite.
// ---------------------------------------------------------------------------

// A cold kernel-venv build can happen inside the first test (the pinned path
// above refused to boot); budget for it like the sibling kernel-heavy files.
// test-policy: allow explicit-test-timeout -- bounds a real cold kernel-venv bootstrap inside the first test, not the assertion
describe("factory workflows over the real kernel bridge", { tags: ["kernel-heavy"], timeout: 180_000 }, () => {
	let tempDir: string;
	let session: AgentSession;
	const driveCells: string[] = [];
	const childScripts = new Map<string, ChildScript>();
	const gatedChildren: Array<{ marker: string; release: () => void }> = [];
	const taskPrompts: string[] = [];
	const unexpectedPrompts: string[] = [];
	let driveCounter = 0;

	function installChildScript(marker: string, answers: ChildScriptStep[]): void {
		if (childScripts.has(marker)) throw new Error(`child script ${marker} already installed`);
		// Markers dispatch by substring match, so two markers must never be a
		// substring of one another (E2E-STATE:HOLD vs E2E-STATE:SLOWGATE).
		for (const existing of childScripts.keys()) {
			if (marker.includes(existing) || existing.includes(marker)) {
				throw new Error(`child script marker ${marker} collides with ${existing}`);
			}
		}
		childScripts.set(marker, { marker, answers: [...answers] });
	}

	interface GateWaiter {
		marker: string;
		resolve: () => void;
	}
	const gateWaiters: GateWaiter[] = [];

	function gatedCount(marker: string): number {
		return gatedChildren.filter((gate) => gate.marker === marker).length;
	}

	function awaitGateRegistered(marker: string): Promise<void> {
		if (gatedCount(marker) > 0) return Promise.resolve();
		return new Promise((resolve) => {
			gateWaiters.push({ marker, resolve });
		});
	}

	function releaseGates(marker: string): void {
		const held = gatedChildren.filter((gate) => gate.marker === marker);
		for (const gate of held) gate.release();
		for (const gate of held) gatedChildren.splice(gatedChildren.indexOf(gate), 1);
	}

	function childStream(taskText: string): ReturnType<typeof createAssistantMessageEventStream> {
		const stream = createAssistantMessageEventStream();
		taskPrompts.push(taskText);
		const marker = [...childScripts.keys()].find((m) => taskText.includes(m));
		const fail = (message: string) =>
			queueMicrotask(() => stream.push({ type: "error", reason: "error", error: assistantFailureMessage(message) }));
		if (marker === undefined) {
			fail(`no child script for task: ${taskText.slice(0, 160)}`);
			return stream;
		}
		const step = childScripts.get(marker)?.answers.shift();
		if (step === undefined) {
			fail(`no scripted answer left for ${marker}`);
			return stream;
		}
		if (step.kind === "gate") {
			gatedChildren.push({
				marker,
				release: () => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage(step.releaseAnswer) });
				},
			});
			for (const waiter of gateWaiters.filter((waiter) => waiter.marker === marker)) {
				gateWaiters.splice(gateWaiters.indexOf(waiter), 1);
				waiter.resolve();
			}
			return stream;
		}
		if (step.kind === "error") {
			fail(step.message);
			return stream;
		}
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage(step.text) }));
		return stream;
	}

	const streamFn: StreamFn = (_streamModel, context) => {
		const stream = createAssistantMessageEventStream();
		const last = context.messages[context.messages.length - 1];
		const text = messageText(last);
		if (last?.role === "toolResult") {
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: assistantMessage("kernel cell complete") }),
			);
			return stream;
		}
		if (text.includes("[factory-progress run:")) {
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: assistantMessage("factory milestone noticed") }),
			);
			return stream;
		}
		if (text.includes("[child-exited:") || text.includes("[child-failed")) {
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: assistantMessage("child lifecycle noticed") }),
			);
			return stream;
		}
		if (text.includes(DRIVE_MARKER)) {
			const code = driveCells.shift();
			if (code === undefined) {
				queueMicrotask(() =>
					stream.push({ type: "error", reason: "error", error: assistantFailureMessage("no drive cell queued") }),
				);
				return stream;
			}
			driveCounter += 1;
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "toolUse",
					message: {
						...assistantMessage(""),
						content: [
							{
								type: "toolCall",
								id: `e2e-drive-${driveCounter}`,
								name: "ipython",
								arguments: { code },
							},
						],
						stopReason: "toolUse",
					},
				});
			});
			return stream;
		}
		if (text.includes("[task from parent]")) return childStream(text);
		unexpectedPrompts.push(text.slice(0, 200));
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage("noted") }));
		return stream;
	};

	/** Run one kernel cell through a scripted parent turn and parse its JSON line. */
	async function driveCell(code: string): Promise<Record<string, any>> {
		// A previous scenario's notice (e.g. a cancelled-child terminal notice)
		// may still be admitting as a wake turn; let it settle first.
		await session.waitForHeadlessIdle();
		driveCells.push(code);
		await session.prompt(`${DRIVE_MARKER} Execute the prepared Python kernel cell (${driveCells.length}).`);
		const toolResults = session.messages.filter(
			(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
		);
		const last = toolResults[toolResults.length - 1];
		if (!last) throw new Error("drive cell produced no tool result");
		const text = last.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		if (last.isError) throw new Error(`kernel cell failed: ${text}`);
		const lines = text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		for (let index = lines.length - 1; index >= 0; index--) {
			if (!lines[index].startsWith("{")) continue;
			try {
				return JSON.parse(lines[index]) as Record<string, any>;
			} catch {}
		}
		throw new Error(`no JSON line in kernel cell output: ${text}`);
	}

	function factoryNotices(runId: string, kind?: string): Array<{ content: string; index: number }> {
		const found: Array<{ content: string; index: number }> = [];
		session.messages.forEach((message, index) => {
			if (message.role !== "custom") return;
			const custom = message as unknown as { customType?: string; content?: string };
			if (custom.customType !== FACTORY_PROGRESS_NOTICE_CUSTOM_TYPE) return;
			if (typeof custom.content !== "string") return;
			if (!custom.content.startsWith(`[factory-progress run:${runId}]`)) return;
			if (kind && !custom.content.startsWith(`[factory-progress run:${runId}] ${kind}:`)) return;
			found.push({ content: custom.content, index });
		});
		return found;
	}

	interface NoticeWaiter {
		runId: string;
		kind: string;
		resolve: (notice: { content: string; index: number }) => void;
	}
	const noticeWaiters: NoticeWaiter[] = [];

	function flushNoticeWaiters(): void {
		for (const waiter of [...noticeWaiters]) {
			const notice = factoryNotices(waiter.runId, waiter.kind)[0];
			if (!notice) continue;
			noticeWaiters.splice(noticeWaiters.indexOf(waiter), 1);
			waiter.resolve(notice);
		}
	}

	function awaitFactoryNotice(kind: string, runId: string): Promise<{ content: string; index: number }> {
		const notice = factoryNotices(runId, kind)[0];
		if (notice) return Promise.resolve(notice);
		return new Promise((resolve) => {
			noticeWaiters.push({ runId, kind, resolve });
		});
	}

	async function waitForFactoryNotice(kind: string, runId: string): Promise<{ content: string; index: number }> {
		try {
			return await awaitWithDeadline(awaitFactoryNotice(kind, runId), 25_000, "factory milestone deadline");
		} catch (error) {
			// A timed-out wait must not leave its waiter registered: every
			// later session event would rescan all messages per stale waiter.
			for (const waiter of [...noticeWaiters]) {
				if (waiter.runId === runId && waiter.kind === kind) {
					noticeWaiters.splice(noticeWaiters.indexOf(waiter), 1);
				}
			}
			// Surface the run's real state instead of a bare timeout.
			let diagnostics = "";
			try {
				const status = await driveCell(statusCell(runId));
				const roster = await session.listRlmSubagents();
				diagnostics = JSON.stringify({
					status,
					roster: roster.subagents.map((child) => ({
						session_name: child.session_name,
						status: child.status,
					})),
					taskPrompts,
					unexpectedPrompts,
				});
			} catch (diagnosticError) {
				diagnostics = String(diagnosticError);
			}
			throw new Error(`${error}; run diagnostics: ${diagnostics}`);
		}
	}

	/** Wait for the milestone to land AND be consumed by a real parent turn. */
	async function settleAfterNotice(kind: string, runId: string): Promise<{ content: string; index: number }> {
		const notice = await waitForFactoryNotice(kind, runId);
		await waitForHeadlessCompletion(session, { waitForRlmQuiescence: true });
		const consumed = session.messages.slice(notice.index + 1).some((message) => message.role === "assistant");
		if (!consumed) throw new Error(`factory ${kind} notice for run ${runId} never reached a parent turn`);
		return notice;
	}

	let previousKernelPython: string | undefined;
	let previousPythonPath: string | undefined;

	beforeAll(() => {
		// Snapshot first so afterAll restores the caller's values (or their
		// absence) whatever we pin over them.
		previousKernelPython = process.env.PRIME_AGENT_KERNEL_PYTHON;
		previousPythonPath = process.env.PYTHONPATH;
		const resolved = resolveKernelPython();
		if (resolved) {
			process.env.PRIME_AGENT_KERNEL_PYTHON = resolved.python;
			if (resolved.pythonPath) process.env.PYTHONPATH = resolved.pythonPath;
		}
		// No usable python at all and a shared kernel venv exists (either path
		// the bootstrap may write: the primary dir, or its XDG fallback when
		// the primary's parent is not creatable): the standard bootstrap would
		// rebuild that venv under live user sessions, so refuse instead. CI
		// never has a pre-existing shared venv, so the bootstrap there is a
		// safe build that bootstrap-cli pre-warms.
		if (!resolved && (existsSync(getKernelVenvDir()) || existsSync(getXdgKernelVenvDir()))) {
			throw new Error(
				"No usable kernel python: point PRIME_AGENT_KERNEL_PYTHON at a factory-capable kernel " +
					"python, or create the checkout-local venv (cd prime-agent-runtime && uv venv .venv && " +
					"uv pip install --python .venv/bin/python -e . dill requests httpx pyyaml tomli python-dotenv " +
					"pandas numpy scipy beautifulsoup4 lxml pydantic tyro), or refresh the shared venv. " +
					"Refusing the standard kernel bootstrap because it would rebuild the shared kernel " +
					"venv that live sessions run on.",
			);
		}
		tempDir = join(tmpdir(), `pi-factory-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		// Seed the local harness state BEFORE session creation so the kernel's
		// rlm.harness loads it from RLM_HARNESS_STATE_DIR.
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const artifactDir = getSessionArtifactPath(sessionManager.getSessionDir(), sessionManager.getSessionId());
		const harnessDir = join(artifactDir, "harness");
		mkdirSync(harnessDir, { recursive: true });
		writeFileSync(
			join(harnessDir, "harness_state.json"),
			harnessStateFileBody({
				"e2e-diamond": factoryEntry("e2e-diamond", "diamond fan-out and join", { machine: DIAMOND_MACHINE }),
				"e2e-escalation": factoryEntry("e2e-escalation", "escalation pause and resume", {
					machine: ESCALATION_MACHINE,
				}),
				"e2e-stop-mid-run": factoryEntry("e2e-stop-mid-run", "stop mid-run", { machine: STOP_MACHINE }),
				"e2e-dag-chain": factoryEntry("e2e-dag-chain", "dag chain through the compiler", { dag: DAG_CHAIN }),
				"e2e-nonblocking": factoryEntry("e2e-nonblocking", "nonblocking admission", {
					machine: NONBLOCKING_MACHINE,
				}),
			}),
		);

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
		});
		// Milestone notices land through the prompt-injection pipeline (their own
		// message events), so every event safely re-checks the notice waiters.
		session.subscribe(() => flushNoticeWaiters());
	});

	afterAll(() => {
		session?.dispose();
		if (previousKernelPython === undefined) delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		else process.env.PRIME_AGENT_KERNEL_PYTHON = previousKernelPython;
		if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
		else process.env.PYTHONPATH = previousPythonPath;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("runs a guarded review/fix loop machine to done, with optional input re-binding", async () => {
		installChildScript("E2E-STATE:DRAFT", [{ kind: "text", text: "draft v1" }]);
		installChildScript("E2E-STATE:REVIEWING", [
			{
				kind: "text",
				text: '```json\n{"verdict": {"approved": false, "findings": ["finding-1"]}}\n```',
			},
			{
				kind: "text",
				text: '```json\n{"verdict": {"approved": true, "findings": []}}\n```',
			},
		]);
		installChildScript("E2E-STATE:FIXING", [
			{
				kind: "text",
				text: '```json\n{"fix_report": {"fixed": ["finding-1"], "marker": "FIX-REPORT-PRESENT"}}\n```',
			},
		]);

		const started = await driveCell(createAndRunCell("e2e-loop-machine", LOOP_MACHINE));
		const runId = started.run_id as string;
		expect(started.spec_id).toBe("e2e-loop-machine");
		expect(started.started).toEqual(["draft"]);

		const notice = await settleAfterNotice("finished", runId);
		expect(notice.content).toContain("run complete");

		const status = await driveCell(statusCell(runId));
		expect(status.state).toBe("done");
		expect(status.usage.transitions_fired).toBe(3);
		expect(status.nodes.draft).toMatchObject({ status: "done", entries_used: 1 });
		expect(status.nodes.reviewing).toMatchObject({ status: "done", entries_used: 2 });
		expect(status.nodes.fixing).toMatchObject({ status: "done", entries_used: 1 });

		// The optional fix_report input re-binds on every re-entry through the
		// real bridge: null sentinel on the first review, the fixer's JSON on
		// the second.
		const reviewingPrompts = taskPrompts.filter((prompt) => prompt.includes("E2E-STATE:REVIEWING"));
		expect(reviewingPrompts).toHaveLength(2);
		expect(reviewingPrompts[0]).toContain("Fix report: null");
		expect(reviewingPrompts[0]).toContain("draft v1");
		expect(reviewingPrompts[1]).toContain("FIX-REPORT-PRESENT");

		expect(unexpectedPrompts).toEqual([]);
	});

	it("fans one settle out to two branches and joins both answers", async () => {
		installChildScript("E2E-STATE:SPLIT", [{ kind: "text", text: "fan out" }]);
		installChildScript("E2E-STATE:LEFT", [{ kind: "text", text: "LEFT-OUT" }]);
		installChildScript("E2E-STATE:RIGHT", [{ kind: "text", text: "RIGHT-OUT" }]);
		installChildScript("E2E-STATE:JOIN", [{ kind: "text", text: "joined" }]);

		const started = await driveCell(runCell("e2e-diamond"));
		const runId = started.run_id as string;
		await settleAfterNotice("finished", runId);

		const status = await driveCell(statusCell(runId));
		expect(status.state).toBe("done");
		// split->left, split->right, then one join fire; the second join edge is
		// blocked by max_entries and the pending entry re-binds the second input.
		expect(status.usage.transitions_fired).toBe(3);
		for (const node of ["split", "left", "right", "join"]) {
			expect(status.nodes[node]).toMatchObject({ status: "done", entries_used: 1 });
		}
		const joinPrompt = taskPrompts.find((prompt) => prompt.includes("E2E-STATE:JOIN"));
		expect(joinPrompt).toContain("LEFT-OUT");
		expect(joinPrompt).toContain("RIGHT-OUT");

		expect(unexpectedPrompts).toEqual([]);
	});

	it("escalates a failing child to a paused run and completes it on resume", async () => {
		installChildScript("E2E-STATE:FIXER", [{ kind: "text", text: "cleanup complete" }]);

		const started = await driveCell(runCell("e2e-escalation"));
		const runId = started.run_id as string;

		const paused = await settleAfterNotice("paused", runId);
		expect(paused.content).toContain("state flaky failed");
		expect(paused.content).toContain(`resume with await rlm.factory.resume('${runId}')`);

		const pausedStatus = await driveCell(statusCell(runId));
		expect(pausedStatus.state).toBe("paused");
		expect(pausedStatus.nodes.flaky.status).toBe("error");
		expect(pausedStatus.nodes.flaky.error).toContain("spawn admission failed");
		expect(pausedStatus.nodes.fixer).toMatchObject({ status: "pending" });

		const resumed = await driveCell(resumeCell(runId));
		// The resumed run finishes in the kernel's background control loop. The
		// flaky entry keeps its recorded error, so the run completes failed
		// with the fixer done -- the executor's escalate-completion shape.
		expect(resumed.state).toBe("running");
		const failed = await settleAfterNotice("failed", runId);
		expect(failed.content).toContain("completed with state error(s): flaky");

		const finalStatus = await driveCell(statusCell(runId));
		expect(finalStatus.state).toBe("failed");
		expect(finalStatus.nodes.fixer).toMatchObject({ status: "done", entries_used: 1 });
		expect(finalStatus.nodes.flaky.status).toBe("error");
		expect(finalStatus.nodes.flaky.error).toContain("spawn admission failed");

		expect(unexpectedPrompts).toEqual([]);
	});

	it("stops a mid-flight run and cancels its children through the real delete path", async () => {
		installChildScript("E2E-STATE:HOLD", [{ kind: "gate", releaseAnswer: "hold released" }]);
		installChildScript("E2E-STATE:AFTER", [{ kind: "text", text: "after" }]);

		const started = await driveCell(runCell("e2e-stop-mid-run"));
		const runId = started.run_id as string;
		expect(started.started).toEqual(["hold"]);

		await awaitWithDeadline(awaitGateRegistered("E2E-STATE:HOLD"), 15_000, "gated child never started");
		const roster = await session.listRlmSubagents();
		const held = roster.subagents.filter((child) => child.session_name.startsWith("sw-hold-"));
		expect(held).toHaveLength(1);
		expect(held[0].status).toBe("running");

		const stopped = await driveCell(stopCell(runId));
		expect(stopped.state).toBe("stopped");
		expect(stopped.cancelled).toEqual(["hold", "after"]);

		// Best-effort cleanup only: stop() already deleted the held child through
		// the real delete path, so this push lands on an abandoned stream.
		releaseGates("E2E-STATE:HOLD");
		const status = await driveCell(statusCell(runId));
		expect(status.state).toBe("stopped");
		expect(status.nodes.after).toMatchObject({ status: "cancelled" });
		// stop() halts the in-flight entry; its instance settles cancelled,
		// never error (that would mean the child errored on its own).
		expect(status.nodes.hold.status).toBe("cancelled");

		// The real delete path removed the running child from the roster.
		const rosterAfter = await session.listRlmSubagents();
		expect(rosterAfter.subagents.some((child) => child.session_name.startsWith("sw-hold-"))).toBe(false);

		await waitForHeadlessCompletion(session, { waitForRlmQuiescence: true });
		expect(unexpectedPrompts).toEqual([]);
	});

	it("compiles and runs a dag-form spec through the same bridge", async () => {
		installChildScript("E2E-STATE:ALPHA", [{ kind: "text", text: "ALPHA-OUT" }]);
		installChildScript("E2E-STATE:BETA", [{ kind: "text", text: "BETA-OUT" }]);
		installChildScript("E2E-STATE:GAMMA", [{ kind: "text", text: "GAMMA-OUT" }]);

		const started = await driveCell(runCell("e2e-dag-chain"));
		const runId = started.run_id as string;
		await settleAfterNotice("finished", runId);

		const status = await driveCell(statusCell(runId));
		expect(status.state).toBe("done");
		expect(status.usage.transitions_fired).toBe(2);
		for (const node of ["alpha", "beta", "gamma"]) {
			expect(status.nodes[node]).toMatchObject({ status: "done", entries_used: 1 });
		}
		const gammaPrompt = taskPrompts.find((prompt) => prompt.includes("E2E-STATE:GAMMA"));
		expect(gammaPrompt).toContain("BETA-OUT");

		expect(unexpectedPrompts).toEqual([]);
	});

	it("returns from run() before any child settles; the milestone arrives as its own wake", async () => {
		installChildScript("E2E-STATE:SLOWGATE", [{ kind: "gate", releaseAnswer: "GATE-OPEN" }]);
		installChildScript("E2E-STATE:FINAL", [{ kind: "text", text: "final done" }]);

		const started = await driveCell(runCell("e2e-nonblocking"));
		const runId = started.run_id as string;
		expect(started.started).toEqual(["slowgate"]);

		// The parent turn completed while the child is gated in flight: no
		// milestone for this run can exist yet.
		await awaitWithDeadline(awaitGateRegistered("E2E-STATE:SLOWGATE"), 15_000, "gated child never started");
		expect(factoryNotices(runId)).toEqual([]);

		const roster = await session.listRlmSubagents();
		const gated = roster.subagents.filter((child) => child.session_name.startsWith("sw-slowgate"));
		expect(gated).toHaveLength(1);
		expect(gated[0].status).toBe("running");

		// The finished milestone lands only after the gate releases -- strictly
		// after the drive turn's messages.
		const turnEndMessageCount = session.messages.length;
		releaseGates("E2E-STATE:SLOWGATE");
		const notice = await settleAfterNotice("finished", runId);
		expect(notice.index).toBeGreaterThanOrEqual(turnEndMessageCount);

		const status = await driveCell(statusCell(runId));
		expect(status.state).toBe("done");
		expect(status.nodes.slowgate).toMatchObject({ status: "done", entries_used: 1 });
		expect(status.nodes.final).toMatchObject({ status: "done", entries_used: 1 });
		const finalPrompt = taskPrompts.find((prompt) => prompt.includes("E2E-STATE:FINAL"));
		expect(finalPrompt).toContain("GATE-OPEN");

		expect(unexpectedPrompts).toEqual([]);
	});
});
