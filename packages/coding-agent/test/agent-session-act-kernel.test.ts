import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { actCancellationCapability } from "../src/core/act-cancellation.js";
import type { ActProjectionEvent } from "../src/core/act-events.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { ExtensionAPI } from "../src/index.js";
import { createHarness } from "./suite/harness.js";

function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((path): path is string => Boolean(path));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		if (spawnSync(python, ["-c", "import ipykernel, IPython"], { encoding: "utf8" }).status === 0) return python;
	}
	return null;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function containsObjectKey(value: unknown, key: string): boolean {
	if (!value || typeof value !== "object") return false;
	if (Object.hasOwn(value, key)) return true;
	return Object.values(value).some((entry) => containsObjectKey(entry, key));
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;
const runtimeSource = join(import.meta.dirname, "../../../prime-agent-runtime/src");

describeIfKernel("AgentSession Act integration", { tags: ["kernel-heavy"] }, () => {
	let priorPython: string | undefined;
	let priorPythonPath: string | undefined;
	let priorForkserver: string | undefined;

	beforeAll(() => {
		priorPython = process.env.PRIME_AGENT_KERNEL_PYTHON;
		priorPythonPath = process.env.PYTHONPATH;
		priorForkserver = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
		process.env.PRIME_AGENT_KERNEL_PYTHON = python as string;
		process.env.PYTHONPATH = [runtimeSource, priorPythonPath].filter(Boolean).join(delimiter);
		process.env.PRIME_AGENT_KERNEL_FORKSERVER = "0";
	});

	afterAll(() => {
		if (priorPython === undefined) delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		else process.env.PRIME_AGENT_KERNEL_PYTHON = priorPython;
		if (priorPythonPath === undefined) delete process.env.PYTHONPATH;
		else process.env.PYTHONPATH = priorPythonPath;
		if (priorForkserver === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
		else process.env.PRIME_AGENT_KERNEL_FORKSERVER = priorForkserver;
	});

	it("returns the exact shared object through an explicitly selected retained model", async () => {
		const provider = "faux-act-kernel";
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }, { id: "deepseek-model" }],
			settings: {
				rlmActDefaultModel: "@luna",
				modelRoles: {
					luna: `${provider}/luna-model`,
					deepseek: `${provider}/deepseek-model`,
				},
			},
		});
		try {
			const actEvents: ActProjectionEvent[] = [];
			const journalTailAtEvent: string[] = [];
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "act_event") return;
				actEvents.push(event);
				journalTailAtEvent.push(harness.sessionManager.getBranch().at(-1)?.type ?? "missing");
			});
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("shared_ipython", {
						code: "inner_models = await rlm.find_models('deepseek')\nlane_saw_root = root_object\nrlm.done(root_object)\nafter_done = True",
					}),
					{ stopReason: "toolUse" },
				),
			]);
			const ipython = harness.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("root session has no IPython tool");
			const result = await ipython.execute("act-integration", {
				code: `root_object = object()
returned = await rlm.act("return the root object", model="@deepseek")
print(returned is root_object, lane_saw_root is root_object, inner_models[0].selector, "after_done" in globals())`,
			});
			const text = result.content.find((content) => content.type === "text")?.text ?? "";
			expect(text).toContain("True True @deepseek False");
			expect(harness.session.getContextTree().children.find((node) => node.id === "act")?.model?.id).toBe(
				"deepseek-model",
			);
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
			expect(actEvents.map((event) => event.event)).toEqual(["start", "cell_start", "cell_terminal", "terminal"]);
			expect(actEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
			expect(new Set(actEvents.map((event) => event.actId)).size).toBe(1);
			expect(actEvents.every((event) => event.outerToolCallId === "act-integration")).toBe(true);
			expect(journalTailAtEvent).toEqual(["act_start", "act_start", "act_start", "act_terminal"]);
			expect(actEvents[0]).toMatchObject({
				event: "start",
				prompt: "return the root object",
				promptTruncated: false,
				model: { provider, id: "deepseek-model" },
				cancellationCapability: actCancellationCapability(),
			});
			expect(actEvents.at(-1)).toMatchObject({
				event: "terminal",
				status: "done",
				prompt: "return the root object",
				model: { provider, id: "deepseek-model" },
				cancellationCapability: actCancellationCapability(),
				usage: expect.objectContaining({ totalTokens: expect.any(Number), cost: expect.any(Object) }),
				errorTruncated: false,
			});
			expect(containsObjectKey(actEvents, "value")).toBe(false);
			expect(() => JSON.stringify(actEvents)).not.toThrow();
			unsubscribe();
		} finally {
			harness.cleanup();
		}
	}, 60_000);
	it("projects a recoverable real-kernel cell error before exact completion", async () => {
		const provider = "faux-act-kernel-progress";
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			const actEvents: ActProjectionEvent[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "act_event") actEvents.push(event);
			});
			let providerSawError = false;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "raise ValueError('projection boom')" }), {
					stopReason: "toolUse",
				}),
				(context) => {
					providerSawError = context.messages.some(
						(message) =>
							message.role === "toolResult" && JSON.stringify(message.content).includes("projection boom"),
					);
					return fauxAssistantMessage(
						fauxToolCall("shared_ipython", { code: "rlm.done(root_projection_object)" }),
						{ stopReason: "toolUse" },
					);
				},
			]);
			const ipython = harness.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("root session has no IPython tool");
			const result = await ipython.execute("act-progress-integration", {
				code: `root_projection_object = object()
projection_result = await rlm.act("recover from the first cell")
print(projection_result is root_projection_object)`,
			});
			expect(result.content.find((content) => content.type === "text")?.text).toContain("True");
			expect(providerSawError).toBe(true);
			expect(actEvents.map((event) => event.event)).toEqual([
				"start",
				"cell_start",
				"cell_terminal",
				"cell_start",
				"cell_terminal",
				"terminal",
			]);
			expect(actEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
			expect(actEvents.every((event) => event.outerToolCallId === "act-progress-integration")).toBe(true);
			const cells = actEvents.filter((event) => event.event === "cell_terminal");
			expect(cells.map((event) => event.cellId)).toEqual(["cell-1", "cell-2"]);
			expect(cells[0]).toMatchObject({ status: "error", error: expect.stringContaining("projection boom") });
			expect(cells[1]).toMatchObject({ status: "ok" });
			expect(actEvents.at(-1)).toMatchObject({ event: "terminal", status: "done" });
			expect(containsObjectKey(actEvents, "value")).toBe(false);
		} finally {
			harness.cleanup();
		}
	}, 60_000);

	it("admits a concurrent root cell once after the Act outer execution is idle", async () => {
		const provider = "faux-act-foreground";
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		const markerDir = mkdtempSync(join(tmpdir(), "prime-act-foreground-"));
		const markerPath = join(markerDir, "release");
		try {
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("shared_ipython", {
						code: `import asyncio as _asyncio
from pathlib import Path as _Path
while not _Path(${JSON.stringify(markerPath)}).exists():
    await _asyncio.sleep(0.01)
foreground_count = globals().get("foreground_count", 0) + 1
rlm.done(foreground_count)`,
					}),
					{ stopReason: "toolUse" },
				),
			]);
			const ipython = harness.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("root session has no IPython tool");
			const act = ipython.execute("act-foreground", {
				code: `act_result = await rlm.act("wait for release")`,
			});
			const internals = harness.session as unknown as {
				_actLane?: { running: boolean };
				_ipythonKernelProvisioner?: {
					manager?: { execute(code: string): Promise<{ status: string }> };
				};
			};
			await vi.waitFor(() => expect(internals._actLane?.running).toBe(true), { timeout: 10_000 });
			const manager = internals._ipythonKernelProvisioner?.manager;
			if (!manager) throw new Error("root kernel did not start");
			let queuedSettlements = 0;
			const queued = manager
				.execute(`foreground_count = globals().get("foreground_count", 0) + 1`)
				.then((result) => {
					queuedSettlements++;
					return result;
				});
			await Promise.resolve();
			expect(queuedSettlements).toBe(0);
			writeFileSync(markerPath, "release");
			await act;
			await expect(queued).resolves.toMatchObject({ status: "ok" });
			expect(queuedSettlements).toBe(1);
			const check = await manager.execute("print(act_result, foreground_count)");
			expect(check).toMatchObject({ status: "ok", stdout: expect.stringContaining("1 2") });
		} finally {
			harness.cleanup();
			rmSync(markerDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("queues steering without disclosing or interrupting a cell-active Act", async () => {
		const provider = "faux-act-steering-kernel";
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		const markerDir = mkdtempSync(join(tmpdir(), "prime-act-steering-"));
		const startedPath = join(markerDir, "started");
		const releasePath = join(markerDir, "release");
		try {
			let steeringSeen = false;
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("shared_ipython", {
						code: `import asyncio as _asyncio
from pathlib import Path as _Path
_Path(${JSON.stringify(startedPath)}).write_text("started")
while not _Path(${JSON.stringify(releasePath)}).exists():
    await _asyncio.sleep(0.01)
steered_kernel_value = 41`,
					}),
					{ stopReason: "toolUse" },
				),
				(context) => {
					steeringSeen = context.messages.some(
						(message) =>
							message.role === "user" && JSON.stringify(message.content).includes("managed-kernel steering"),
					);
					return fauxAssistantMessage(
						fauxToolCall("shared_ipython", { code: "rlm.done(steered_kernel_value + 1)" }),
						{ stopReason: "toolUse" },
					);
				},
			]);
			const ipython = harness.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("root session has no IPython tool");
			const act = ipython.execute("act-steering-kernel", {
				code: `managed_steering_result = await rlm.act("wait for managed steering")
print(managed_steering_result)`,
			});
			await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true), { timeout: 10_000 });
			let steeringSettled = false;
			const steering = harness.session.steer("managed-kernel steering").then(() => {
				steeringSettled = true;
			});
			await Promise.resolve();
			expect(steeringSettled).toBe(false);
			writeFileSync(releasePath, "release");
			await steering;
			const result = await act;
			expect(result.content.find((content) => content.type === "text")?.text).toContain("42");
			expect(steeringSeen).toBe(false);
		} finally {
			harness.cleanup();
			rmSync(markerDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("restores completed lane context and root namespace after restart", async () => {
		const provider = "faux-act-kernel-restart";
		const settings = { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } };
		const first = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings,
			persistSession: true,
			preserveTempDir: true,
		});
		const sessionFile = first.session.sessionFile;
		if (!sessionFile) throw new Error("persistent harness has no session file");
		const tempDir = first.tempDir;
		try {
			first.setResponses([
				fauxAssistantMessage(
					fauxToolCall("shared_ipython", { code: "persisted_act_value = 41\nrlm.done(persisted_act_value)" }),
					{ stopReason: "toolUse" },
				),
			]);
			const ipython = first.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("root session has no IPython tool");
			const result = await ipython.execute("act-restart-first", {
				code: 'first_result = await rlm.act("remember the restart value")\nprint(first_result)',
			});
			expect(result.content.find((content) => content.type === "text")?.text).toContain("41");
		} finally {
			await first.session.disposeAsync();
			first.cleanup();
		}

		const resumed = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings,
			tempDir,
			sessionFile,
		});
		try {
			let retainedPromptSeen = false;
			resumed.setResponses([
				(context) => {
					retainedPromptSeen = context.messages.some(
						(message) =>
							message.role === "user" && JSON.stringify(message.content).includes("remember the restart value"),
					);
					return fauxAssistantMessage(
						fauxToolCall("shared_ipython", { code: "rlm.done(persisted_act_value + 1)" }),
						{ stopReason: "toolUse" },
					);
				},
			]);
			const ipython = resumed.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("resumed root session has no IPython tool");
			const result = await ipython.execute("act-restart-second", {
				code: 'second_result = await rlm.act("reuse the restart value")\nprint(second_result)',
			});
			expect(result.content.find((content) => content.type === "text")?.text).toContain("42");
			expect(retainedPromptSeen).toBe(true);
		} finally {
			resumed.cleanup();
		}
	}, 60_000);

	it("waits for Act cleanup and snapshot before a replacement session becomes usable", async () => {
		const provider = "faux-act-kernel-replacement";
		const settings = { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } };
		const first = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings,
			persistSession: true,
			preserveTempDir: true,
		});
		const sessionFile = first.session.sessionFile;
		if (!sessionFile) throw new Error("persistent harness has no session file");
		const tempDir = first.tempDir;
		const effectPath = join(tempDir, "replacement.effects");
		try {
			first.setResponses([
				fauxAssistantMessage(
					fauxToolCall("shared_ipython", {
						code: `from pathlib import Path as _Path
import asyncio as _asyncio
replacement_marker = object()
with _Path(${JSON.stringify(effectPath)}).open("a") as _effect:
    _effect.write("once\\n")
await _asyncio.sleep(60)`,
					}),
					{ stopReason: "toolUse" },
				),
			]);
			const ipython = first.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("root session has no IPython tool");
			const running = ipython.execute("act-replacement-cancel", {
				code: `import rlm
try:
    await rlm.act("cancel before replacement")
except rlm.ActCancelledError:
    print("replacement-act-cancelled")`,
			});
			await vi.waitFor(() => expect(existsSync(effectPath)).toBe(true), { timeout: 10_000 });
			const disposal = first.session.disposeAsync();
			const concurrentDisposal = first.session.disposeAsync();
			const cancelled = await running;
			expect(cancelled.content.find((content) => content.type === "text")?.text).toContain(
				"replacement-act-cancelled",
			);
			await Promise.all([disposal, concurrentDisposal]);
			expect(first.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal")).toEqual([
				expect.objectContaining({ status: "cancelled" }),
			]);
			expect(readFileSync(effectPath, "utf8").trim().split("\n")).toEqual(["once"]);
		} finally {
			first.cleanup();
		}

		const replacement = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings,
			tempDir,
			sessionFile,
		});
		try {
			const ipython = replacement.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("replacement root session has no IPython tool");
			const result = await ipython.execute("act-replacement-reuse", {
				code: `import asyncio as _asyncio
await _asyncio.sleep(0.25)
print(replacement_marker is replacement_marker, "replacement-reused")`,
			});
			expect(result.content.find((content) => content.type === "text")?.text).toContain("True replacement-reused");
			expect(readFileSync(effectPath, "utf8").trim().split("\n")).toEqual(["once"]);
			replacement.appendResponses([fauxAssistantMessage("replacement prompt succeeded")]);
			await replacement.session.prompt("continue in replacement session");
			expect(replacement.session.getLastAssistantText()).toBe("replacement prompt succeeded");
			await replacement.session.disposeAsync();
		} finally {
			replacement.cleanup();
			rmSync(tempDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("switches the current session after managed Act cleanup without a sibling recovery terminal", async () => {
		const provider = "faux-act-same-file-replacement";
		const directory = mkdtempSync(join(tmpdir(), "prime-agent-act-same-file-replacement-"));
		const childPidPath = join(directory, "managed-child.pid");
		let childPid = 0;
		const faux = registerFauxProvider({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
		});
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(provider, "faux-key");
		const settingsManager = SettingsManager.inMemory({
			rlmActDefaultModel: "@luna",
			modelRoles: { luna: `${provider}/luna-model` },
		});
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
			sessionOptions,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: directory,
				authStorage,
				settingsManager,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((model) => ({
									id: model.id,
									name: model.name,
									api: model.api,
									reasoning: model.reasoning,
									input: model.input,
									cost: model.cost,
									contextWindow: model.contextWindow,
									maxTokens: model.maxTokens,
								})),
							});
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel("sol-model"),
					...sessionOptions,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const sessionManager = SessionManager.create(directory, join(directory, "sessions"));
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: directory,
			agentDir: directory,
			sessionManager,
		});
		await runtime.session.bindExtensions({});
		try {
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("shared_ipython", {
						code: "replacement_effect = globals().get('replacement_effect', 0) + 1",
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("shared_ipython", {
						code: `%%bash
sleep 60 &
echo $! > ${childPidPath}
wait $!`,
					}),
					{ stopReason: "toolUse" },
				),
			]);
			const events: ActProjectionEvent[] = [];
			const unsubscribe = runtime.session.subscribe((event) => {
				if (event.type === "act_event") events.push(event);
			});
			const ipython = runtime.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("root session has no IPython tool");
			const running = ipython.execute("same-file-replacement", {
				code: `import rlm
try:
    await rlm.act("run managed shell until replacement")
except rlm.ActCancelledError:
    print("replacement-cancelled")`,
			});
			await vi.waitFor(() => expect(existsSync(childPidPath)).toBe(true), { timeout: 10_000 });
			childPid = Number(readFileSync(childPidPath, "utf8").trim());
			const sessionFile = runtime.session.sessionFile;
			if (!sessionFile) throw new Error("persistent runtime has no session file");

			await runtime.switchSession(sessionFile);
			await running;

			expect(processAlive(childPid)).toBe(false);
			const actId = events.find((event) => event.event === "start")?.actId;
			if (!actId) throw new Error("Act did not publish its start");
			const physicalTerminals = readFileSync(sessionFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type?: string; actId?: string; status?: string })
				.filter((entry) => entry.type === "act_terminal" && entry.actId === actId);
			expect(physicalTerminals).toEqual([expect.objectContaining({ status: "cancelled" })]);
			const branchTerminals = runtime.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "act_terminal" && entry.actId === actId);
			expect(branchTerminals).toEqual([expect.objectContaining({ status: "cancelled" })]);
			const actNode = runtime.session.getContextTree().children.find((node) => node.id === "act");
			const branchUsage = branchTerminals[0]?.type === "act_terminal" ? branchTerminals[0].usage : undefined;
			expect(actNode?.totalUsage).toEqual(branchUsage);
			expect(events.filter((event) => event.event === "terminal")).toEqual([
				expect.objectContaining({ actId, status: "cancelled" }),
			]);
			const eventCount = events.length;
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(events).toHaveLength(eventCount);

			const replacementIpython = runtime.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!replacementIpython) throw new Error("replacement session has no IPython tool");
			const namespace = await replacementIpython.execute("same-file-replacement-namespace", {
				code: "print(replacement_effect)",
			});
			expect(namespace.content.find((content) => content.type === "text")?.text).toContain("1");
			faux.appendResponses([fauxAssistantMessage("replacement prompt succeeded")]);
			await runtime.session.prompt("continue after managed replacement");
			expect(runtime.session.getLastAssistantText()).toBe("replacement prompt succeeded");
			unsubscribe();
		} finally {
			await runtime.dispose();
			faux.unregister();
			if (childPid > 0 && processAlive(childPid)) process.kill(childPid, "SIGKILL");
			rmSync(directory, { recursive: true, force: true });
		}
	}, 90_000);

	it("rejects textual completion and permits a later successful Act", async () => {
		const provider = "faux-act-text";
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage("finished without the terminal cell"),
				fauxAssistantMessage(fauxToolCall("shared_ipython", { code: "rlm.done(7)" }), {
					stopReason: "toolUse",
				}),
			]);
			const ipython = harness.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("root session has no IPython tool");
			const result = await ipython.execute("act-text-recovery", {
				code: `import rlm
try:
    await rlm.act("finish only in text")
except rlm.ActError as error:
    print(type(error).__name__, str(error))
recovered = await rlm.act("recover with done")
print("recovered", recovered)`,
			});
			const text = result.content.find((content) => content.type === "text")?.text ?? "";
			expect(text).toContain("ActError Act ended without calling rlm.done()");
			expect(text).toContain("recovered 7");
		} finally {
			harness.cleanup();
		}
	}, 60_000);

	it("cancels awaited Python, synchronous Python, and managed bash through the root session", async () => {
		const provider = "faux-act-root-cancel";
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		const directory = mkdtempSync(join(tmpdir(), "prime-agent-root-act-cancel-"));
		const bashPidPath = join(directory, "bash.pid");
		const childPidPath = join(directory, "child.pid");
		let bashPid = 0;
		let childPid = 0;
		try {
			const ipython = harness.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("root session has no IPython tool");
			await ipython.execute("root-cancel-setup", { code: "integrated_cancel_marker = object()" });
			const internals = harness.session as unknown as {
				_actLane?: {
					active?: { cellActive: boolean };
					running: boolean;
					session?: { agent: { hasQueuedMessages(): boolean } };
				};
				_rootForeground: { busy: boolean };
			};
			const cases = [
				{
					label: "awaited",
					effectPath: join(directory, "awaited.effects"),
					code: (effectPath: string) =>
						`from pathlib import Path as _Path
import asyncio as _asyncio
with _Path(${JSON.stringify(effectPath)}).open("a") as _effect:
    _effect.write("once\\n")
await _asyncio.sleep(60)`,
				},
				{
					label: "synchronous",
					effectPath: join(directory, "synchronous.effects"),
					code: (effectPath: string) =>
						`from pathlib import Path as _Path
with _Path(${JSON.stringify(effectPath)}).open("a") as _effect:
    _effect.write("once\\n")
while True:
    pass`,
				},
				{
					label: "bash",
					effectPath: join(directory, "bash.effects"),
					code: (effectPath: string) =>
						`%%bash
echo once >> ${effectPath}
echo $$ > ${bashPidPath}
sleep 60 &
echo $! > ${childPidPath}
wait`,
				},
			];
			for (const [index, cancellation] of cases.entries()) {
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall("shared_ipython", { code: cancellation.code(cancellation.effectPath) }),
						{ stopReason: "toolUse" },
					),
				]);
				const terminalCount = harness.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "act_terminal").length;
				const running = ipython.execute(`root-cancel-${cancellation.label}`, {
					code: `import rlm
try:
    await rlm.act(${JSON.stringify(`cancel ${cancellation.label}`)})
except rlm.ActCancelledError:
    print(${JSON.stringify(`${cancellation.label}-act-cancelled`)})`,
				});
				await vi.waitFor(() => expect(existsSync(cancellation.effectPath)).toBe(true), { timeout: 10_000 });
				if (cancellation.label === "bash") {
					await vi.waitFor(() => expect(existsSync(childPidPath)).toBe(true), { timeout: 10_000 });
					bashPid = Number(readFileSync(bashPidPath, "utf8").trim());
					childPid = Number(readFileSync(childPidPath, "utf8").trim());
				}
				let steeringError: Promise<unknown> | undefined;
				if (index === 0) {
					steeringError = harness.session.steer("cancel this queued Act steering").then(
						() => undefined,
						(error: unknown) => error,
					);
				}
				const cancelledAt = Date.now();
				await harness.session.abort();
				expect(Date.now() - cancelledAt).toBeLessThan(2_000);
				expect(internals._actLane?.running).toBe(false);
				expect(internals._rootForeground.busy).toBe(false);
				if (steeringError) await expect(steeringError).resolves.toBeUndefined();
				expect(internals._actLane?.session?.agent.hasQueuedMessages()).toBe(false);
				const result = await running;
				expect(result.content.find((content) => content.type === "text")?.text).toContain(
					`${cancellation.label}-act-cancelled`,
				);
				const terminals = harness.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal");
				expect(terminals).toHaveLength(terminalCount + 1);
				expect(terminals.at(-1)).toMatchObject({ status: "cancelled" });
				expect(readFileSync(cancellation.effectPath, "utf8").trim().split("\n")).toEqual(["once"]);
				if (cancellation.label === "bash") {
					expect({ bash: processAlive(bashPid), child: processAlive(childPid) }).toEqual({
						bash: false,
						child: false,
					});
				}
				const reused = await ipython.execute(`root-cancel-${cancellation.label}-reuse`, {
					code: "print(integrated_cancel_marker is integrated_cancel_marker, 'root-reused')",
				});
				expect(reused.content.find((content) => content.type === "text")?.text).toContain("True root-reused");
			}
			harness.appendResponses([
				fauxAssistantMessage("queued steering applied"),
				fauxAssistantMessage("root prompt succeeded after cancellation"),
			]);
			await harness.session.prompt("continue after integrated Act cancellation");
			expect(harness.session.getLastAssistantText()).toBe("root prompt succeeded after cancellation");
		} finally {
			for (const pid of [childPid, bashPid]) {
				if (pid > 0 && processAlive(pid)) process.kill(pid, "SIGKILL");
			}
			harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);

	it("projects host-side lane cancellation into awaited inner Python", async () => {
		const provider = "faux-act-host-cancel";
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("shared_ipython", {
						code: "print('host-cancel-started', flush=True)\nimport asyncio\nawait asyncio.sleep(60)",
					}),
					{ stopReason: "toolUse" },
				),
			]);
			const ipython = harness.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("root session has no IPython tool");
			const running = ipython.execute("act-host-cancel", {
				code: `import rlm
try:
    await rlm.act("wait until the host cancels")
except rlm.ActCancelledError:
    print("host-act-cancelled")`,
			});
			const internals = harness.session as unknown as {
				_actLane?: { active?: { cellActive: boolean }; dispose(): void };
			};
			await vi.waitFor(() => expect(internals._actLane?.active?.cellActive).toBe(true), { timeout: 10_000 });
			internals._actLane?.dispose();
			const cancelled = await running;
			const cancelledText = cancelled.content.find((content) => content.type === "text")?.text ?? "";
			expect(cancelledText).toContain("host-act-cancelled");
			const reused = await ipython.execute("act-host-cancel-reuse", { code: "print('root-reused')" });
			const reusedText = reused.content.find((content) => content.type === "text")?.text ?? "";
			expect(reusedText).toContain("root-reused");
		} finally {
			harness.cleanup();
		}
	}, 60_000);

	it("cancels awaited inner Python and leaves the root kernel reusable", async () => {
		const provider = "faux-act-cancel";
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("shared_ipython", {
						code: "print('act-started', flush=True)\nimport asyncio\nawait asyncio.sleep(60)",
					}),
					{ stopReason: "toolUse" },
				),
			]);
			const ipython = harness.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("root session has no IPython tool");
			const cancelled = await ipython.execute("act-cancel", {
				code: `import asyncio
import rlm
act_task = asyncio.create_task(rlm.act("wait cooperatively"))
await asyncio.sleep(0.1)
act_task.cancel()
try:
    await act_task
except rlm.ActCancelledError:
    print("act-cancelled")
await asyncio.sleep(0.2)
print("after-cancel-grace")`,
			});
			const cancelledText = cancelled.content.find((content) => content.type === "text")?.text ?? "";
			expect(cancelledText).toContain("act-started");
			expect(cancelledText).toContain("act-cancelled");
			expect(cancelledText).toContain("after-cancel-grace");
			const reused = await ipython.execute("act-cancel-reuse", { code: "print('root-reused')" });
			const reusedText = reused.content.find((content) => content.type === "text")?.text ?? "";
			expect(reusedText).toContain("root-reused");
		} finally {
			harness.cleanup();
		}
	}, 60_000);

	it("interrupts synchronous Act Python once and preserves the root namespace", async () => {
		const provider = "faux-act-sync-cancel";
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("shared_ipython", {
						code: "print('sync-act-started', flush=True)\nwhile True:\n    pass",
					}),
					{ stopReason: "toolUse" },
				),
			]);
			const ipython = harness.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("root session has no IPython tool");
			const controller = new AbortController();
			const running = ipython.execute(
				"act-sync-cancel",
				{
					code: `import rlm
sync_marker = object()
try:
    await rlm.act("run synchronous Python until cancelled")
except rlm.ActCancelledError:
    print("sync-act-cancelled")`,
				},
				controller.signal,
			);
			const internals = harness.session as unknown as { _actLane?: { active?: { cellActive: boolean } } };
			await vi.waitFor(() => expect(internals._actLane?.active?.cellActive).toBe(true), { timeout: 10_000 });
			const cancelledAt = Date.now();
			controller.abort();
			const cancelled = await running;
			expect(Date.now() - cancelledAt).toBeLessThan(2_000);
			expect(cancelled.details).toMatchObject({ status: "aborted" });
			expect(cancelled.content.find((content) => content.type === "text")?.text).toContain("sync-act-cancelled");
			const terminals = harness.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal");
			expect(terminals).toHaveLength(1);
			expect(terminals[0]).toMatchObject({ status: "cancelled" });
			const reused = await ipython.execute("act-sync-cancel-reuse", {
				code: "print(sync_marker is sync_marker, 'root-reused')",
			});
			expect(reused.content.find((content) => content.type === "text")?.text).toContain("True root-reused");
		} finally {
			harness.cleanup();
		}
	}, 60_000);

	it("interrupts blocking Act bash and terminates its scoped process group", async () => {
		const provider = "faux-act-bash-cancel";
		const harness = await createHarness({
			provider,
			models: [{ id: "sol-model" }, { id: "luna-model" }],
			settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
		});
		const directory = mkdtempSync(join(tmpdir(), "prime-agent-act-bash-cancel-"));
		const bashPidPath = join(directory, "bash.pid");
		const childPidPath = join(directory, "child.pid");
		const completedPath = join(directory, "completed");
		let bashPid = 0;
		let childPid = 0;
		try {
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("shared_ipython", {
						code: `%%bash
echo $$ > ${bashPidPath}
sleep 60 &
echo $! > ${childPidPath}
echo bash-act-started
wait
echo completed > ${completedPath}`,
					}),
					{ stopReason: "toolUse" },
				),
			]);
			const ipython = harness.session.agent.state.tools.find((tool) => tool.name === "ipython");
			if (!ipython) throw new Error("root session has no IPython tool");
			const controller = new AbortController();
			const running = ipython.execute(
				"act-bash-cancel",
				{
					code: `import rlm
import subprocess
bash_marker = object()
unrelated_process = subprocess.Popen(["sleep", "60"], start_new_session=True)
try:
    await rlm.act("run blocking bash until cancelled")
except rlm.ActCancelledError:
    print("bash-act-cancelled")
finally:
    print("unrelated-process-alive", unrelated_process.poll() is None)
    unrelated_process.terminate()
    unrelated_process.wait(timeout=2)`,
				},
				controller.signal,
			);
			await vi.waitFor(() => expect(existsSync(childPidPath)).toBe(true), { timeout: 10_000 });
			bashPid = Number(readFileSync(bashPidPath, "utf8").trim());
			childPid = Number(readFileSync(childPidPath, "utf8").trim());
			const cancelledAt = Date.now();
			controller.abort();
			const cancelled = await running;
			expect(Date.now() - cancelledAt).toBeLessThan(2_000);
			expect(cancelled.details).toMatchObject({ status: "aborted" });
			const cancelledText = cancelled.content.find((content) => content.type === "text")?.text ?? "";
			expect(cancelledText).toContain("bash-act-cancelled");
			expect(cancelledText).toContain("unrelated-process-alive True");
			expect(existsSync(completedPath)).toBe(false);
			expect({ bash: processAlive(bashPid), child: processAlive(childPid) }).toEqual({ bash: false, child: false });
			const terminals = harness.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal");
			expect(terminals).toHaveLength(1);
			expect(terminals[0]).toMatchObject({ status: "cancelled" });
			const reused = await ipython.execute("act-bash-cancel-reuse", {
				code: "print(bash_marker is bash_marker, 'root-reused')",
			});
			expect(reused.content.find((content) => content.type === "text")?.text).toContain("True root-reused");
		} finally {
			for (const pid of [childPid, bashPid]) {
				if (pid > 0 && processAlive(pid)) process.kill(pid, "SIGKILL");
			}
			harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);

	it.skipIf(process.platform !== "linux")(
		"cancels a synchronous Act on a forked kernel and completes teardown",
		async () => {
			const savedPythonPath = process.env.PYTHONPATH;
			const savedForkserver = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
			delete process.env.PYTHONPATH;
			process.env.PRIME_AGENT_KERNEL_FORKSERVER = "1";
			const provider = "faux-act-forked-cancel";
			const directory = mkdtempSync(join(tmpdir(), "prime-agent-forked-act-cancel-"));
			const effectPath = join(directory, "forked.effects");
			let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
			try {
				harness = await createHarness({
					provider,
					models: [{ id: "sol-model" }, { id: "luna-model" }],
					settings: { rlmActDefaultModel: "@luna", modelRoles: { luna: `${provider}/luna-model` } },
				});
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall("shared_ipython", {
							code: `from pathlib import Path as _Path
forked_act_marker = object()
with _Path(${JSON.stringify(effectPath)}).open("a") as _effect:
    _effect.write("once\\n")
while True:
    pass`,
						}),
						{ stopReason: "toolUse" },
					),
				]);
				const ipython = harness.session.agent.state.tools.find((tool) => tool.name === "ipython");
				if (!ipython) throw new Error("root session has no IPython tool");
				const running = ipython.execute("act-forked-cancel", {
					code: `import rlm
try:
    await rlm.act("cancel synchronous Python on the forked kernel")
except rlm.ActCancelledError:
    print("forked-act-cancelled")`,
				});
				await vi.waitFor(() => expect(existsSync(effectPath)).toBe(true), { timeout: 15_000 });
				const provisioner = harness.session as unknown as {
					_ipythonKernelProvisioner?: { manager?: { kernelPid?: number; kernel?: unknown } };
				};
				expect(provisioner._ipythonKernelProvisioner?.manager?.kernelPid).toBeGreaterThan(0);
				expect(provisioner._ipythonKernelProvisioner?.manager?.kernel).toBeUndefined();
				await harness.session.abort();
				const cancelled = await running;
				expect(cancelled.content.find((content) => content.type === "text")?.text).toContain(
					"forked-act-cancelled",
				);
				expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "act_terminal")).toEqual([
					expect.objectContaining({ status: "cancelled" }),
				]);
				expect(readFileSync(effectPath, "utf8").trim().split("\n")).toEqual(["once"]);
				const reused = await ipython.execute("act-forked-reuse", {
					code: `import asyncio as _asyncio
await _asyncio.sleep(0.25)
print(forked_act_marker is forked_act_marker, "forked-root-reused")`,
				});
				expect(reused.content.find((content) => content.type === "text")?.text).toContain(
					"True forked-root-reused",
				);
				await harness.session.disposeAsync();
			} finally {
				harness?.cleanup();
				rmSync(directory, { recursive: true, force: true });
				if (savedPythonPath === undefined) delete process.env.PYTHONPATH;
				else process.env.PYTHONPATH = savedPythonPath;
				if (savedForkserver === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
				else process.env.PRIME_AGENT_KERNEL_FORKSERVER = savedForkserver;
			}
		},
		60_000,
	);
});
