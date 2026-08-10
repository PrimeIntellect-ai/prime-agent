/** Real daemon C03 terminal recovery: no hand-written lifecycle facts or fake runtimes. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { materializedTerminalMessageId, readRlmDurableOperationRegistry } from "../src/core/rlm-durable-operations.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";
import {
	type BarrierScriptedProvider,
	createBarrierScriptedProvider,
	type ProviderScript,
} from "./swarm/production-scripted-provider.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanups.length) await cleanups.pop()?.();
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

const usage = (input: number, output: number) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: {
		input: input * 0.000001,
		output: output * 0.000002,
		cacheRead: 0,
		cacheWrite: 0,
		total: input * 0.000001 + output * 0.000002,
	},
});

function providerRegistration(models: readonly BarrierScriptedProvider["models"][number][]) {
	return {
		baseUrl: models[0]!.baseUrl,
		apiKey: "fixture-key",
		api: models[0]!.api,
		models: models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	};
}

async function createRealDaemonFixture(root: string, scripted: BarrierScriptedProvider) {
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const model = scripted.models[0]!;
	authStorage.setRuntimeApiKey(model.provider, "fixture-key");
	modelRegistry.registerProvider(model.provider, providerRegistration(scripted.models));
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const services = await createAgentSessionServices({
			cwd: runtimeOptions.cwd,
			agentDir: root,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
			telemetryDisabled: true,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			model: runtimeOptions.sessionOptions?.model ?? model,
			thinkingLevel: runtimeOptions.sessionOptions?.thinkingLevel ?? "off",
			serviceTier: runtimeOptions.sessionOptions?.serviceTier,
			scopedModels: runtimeOptions.sessionOptions?.scopedModels,
			initialActiveToolNames: runtimeOptions.sessionOptions?.initialActiveToolNames,
			allowedToolNames: runtimeOptions.sessionOptions?.allowedToolNames,
			customTools: runtimeOptions.sessionOptions?.customTools,
			includeGoals: runtimeOptions.sessionOptions?.includeGoals,
			includeCompactSkill: runtimeOptions.sessionOptions?.includeCompactSkill,
			agentMessageController: runtimeOptions.sessionOptions?.agentMessageController,
			agentObserveController: runtimeOptions.sessionOptions?.agentObserveController,
			rlmHeartbeatController: runtimeOptions.sessionOptions?.rlmHeartbeatController,
			// Test process environment may itself be a maximum-depth RLM child; a
			// daemon-created top-level parent is nevertheless depth zero.
			rlmDepth: runtimeOptions.sessionOptions?.rlmDepth ?? 0,
			rlmMaxDepth: runtimeOptions.sessionOptions?.rlmMaxDepth ?? 1,
			rlmSessionDir: runtimeOptions.sessionOptions?.rlmSessionDir,
			rlmParentNodeId: runtimeOptions.sessionOptions?.rlmParentNodeId,
			rlmParentAgent: runtimeOptions.sessionOptions?.rlmParentAgent,
		});
		return { ...result, services, diagnostics: services.diagnostics };
	};
	const sessionDir = join(root, "sessions");
	const daemon = new AgentDaemon(join(root, `daemon-${randomUUID()}.sock`), {
		defaultSessionConfig: {
			agentDir: root,
			cwd: root,
			sessionDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			telemetryDisabled: true,
		},
		createRuntime,
	});
	return { daemon, sessionDir };
}

type DaemonInternals = {
	createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
	getOrHydrateBoundSessionState(selector: string): Promise<ActiveSessionState>;
	closeSession(state: ActiveSessionState, reason: "shutdown"): Promise<void>;
	sessions: Map<string, ActiveSessionState>;
};

function realRegistry(parentArtifactDir: string) {
	return readRlmDurableOperationRegistry(parentArtifactDir, (operation) => {
		if (
			!operation.childSessionId ||
			!operation.childSessionFile ||
			!operation.childSessionRoot ||
			!operation.childArtifactDir ||
			!operation.childArtifactRoot
		)
			return undefined;
		return {
			childSessionId: operation.childSessionId,
			childSessionFile: operation.childSessionFile,
			childSessionRoot: operation.childSessionRoot,
			childArtifactDir: operation.childArtifactDir,
			childArtifactRoot: operation.childArtifactRoot,
		};
	});
}

function terminalEntries(session: { sessionManager: Pick<SessionManager, "getEntries"> }, deliveryId: string) {
	const id = materializedTerminalMessageId(deliveryId);
	return session.sessionManager.getEntries().filter((entry) => {
		const candidate = entry as {
			type?: string;
			role?: string;
			customType?: string;
			details?: { id?: string };
			message?: { role?: string; customType?: string; details?: { id?: string } };
		};
		const message = candidate.message ?? candidate;
		return (
			(candidate.type === "message" || candidate.type === "custom_message") &&
			(message.role === "custom" || message.customType === "rlm_child_terminal_notice") &&
			message.details?.id === id
		);
	});
}

describe("C03 real daemon production recovery", () => {
	it("recovers one real daemon-hosted child terminal after a deferred parent append without provider or prompt replay", async () => {
		const root = await mkdtemp(join(tmpdir(), "prime-agent-c03-real-production-"));
		const requestId = "request-9001";
		const script: ProviderScript = {
			requestId,
			blocks: [{ type: "text", chunks: ["real child completed"] }],
			usage: usage(11, 7),
			responseModel: "c03-real-model",
			waitForRelease: true,
		};
		const scripted = createBarrierScriptedProvider({
			api: "c03-real-scripted",
			provider: "c03-real-scripted",
			barrier: { expected: [requestId], timeoutMs: 10_000 },
			models: [{ id: "c03-real-model", responseModel: "c03-real-model" }],
			scripts: { [requestId]: [script] },
		});
		cleanups.push(() => scripted.unregister());
		cleanups.push(() => rm(root, { recursive: true, force: true }));

		const promptAndWait = vi.spyOn(
			(await import("../src/core/agent-session.js")).AgentSession.prototype,
			"promptAndWait",
		);
		const a = await createRealDaemonFixture(root, scripted);
		const aInternals = a.daemon as unknown as DaemonInternals;
		const parentA = await aInternals.createRuntime({ type: "create" });
		const parent = parentA.runtime.session;
		const appendEntered = deferred<void>();
		const releaseStaleAppend = deferred<void>();
		vi.spyOn(parent, "appendDurableRlmTerminalMessage").mockImplementationOnce(async () => {
			appendEntered.resolve();
			await releaseStaleAppend.promise;
			// This is the sole cut: do not materialize a transcript message from A.
			return false;
		});

		const handle = await parent.runRlmChild(`C03 real production child ${requestId}`, {
			name: "c03-real-worker",
			model: "c03-real-scripted/c03-real-model",
		});
		await scripted.open;
		scripted.release([requestId]);
		await appendEntered.promise;

		const parentFile = parent.sessionFile;
		const artifacts = parent.sessionManager.getSessionArtifactDir();
		if (!parentFile || !artifacts) throw new Error("Missing persisted real parent paths");
		const beforeCut = realRegistry(artifacts);
		const operation = [...beforeCut.operations.values()].find(
			(candidate) => candidate.childId === handle.rlm_child_id,
		);
		if (!operation) throw new Error("Missing real C03 operation");
		const delivery = [...beforeCut.deliveries.values()].find(
			(candidate) => candidate.deliveryId === operation.deliveryId,
		);
		if (!delivery) throw new Error("Missing real C03 delivery");
		expect(operation).toMatchObject({ lifecycle: "terminal_recorded" });
		expect(delivery.outboxed).toBe(true);
		expect(delivery.received).toBe(true);
		expect(delivery.consumed).toBeUndefined();
		const c01 = (await readFile(join(artifacts, "rlm-subagents.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(c01).toContainEqual(
			expect.objectContaining({
				childId: handle.rlm_child_id,
				assignmentId: operation.assignmentId,
				operationId: operation.operationId,
				deliveryId: operation.deliveryId,
			}),
		);
		expect(terminalEntries(parent, operation.deliveryId)).toHaveLength(0);
		expect(scripted.observations()).toHaveLength(1);
		expect(promptAndWait).toHaveBeenCalledTimes(1);

		// Manager-owned close removes A before its deferred importer can resume.
		await aInternals.closeSession(parentA, "shutdown");
		expect(aInternals.sessions.has(parentA.activeSessionId)).toBe(false);
		const passiveParent = SessionManager.open(parentFile, a.sessionDir);
		expect(passiveParent.getSessionId()).toBe(parent.sessionId);
		expect(terminalEntries({ sessionManager: passiveParent }, operation.deliveryId)).toHaveLength(0);

		const b = await createRealDaemonFixture(root, scripted);
		const bInternals = b.daemon as unknown as DaemonInternals;
		const parentB = await bInternals.createRuntime({ type: "create", sessionPath: parentFile });
		expect(parentB.eventGeneration).not.toBe(parentA.eventGeneration);
		expect(scripted.observations()).toHaveLength(1);
		expect(promptAndWait).toHaveBeenCalledTimes(1);
		expect(terminalEntries(parentB.runtime.session, operation.deliveryId)).toHaveLength(0);

		const [firstWake, secondWake] = await Promise.all([
			bInternals.getOrHydrateBoundSessionState(handle.rlm_child_id),
			bInternals.getOrHydrateBoundSessionState(handle.rlm_child_id),
		]);
		expect(firstWake).toBe(secondWake);
		expect(terminalEntries(parentB.runtime.session, operation.deliveryId)).toHaveLength(1);
		expect(scripted.observations()).toHaveLength(1);
		expect(promptAndWait).toHaveBeenCalledTimes(1);
		const afterB = realRegistry(artifacts);
		expect(
			[...afterB.deliveries.values()].find((candidate) => candidate.deliveryId === operation.deliveryId),
		).toMatchObject({
			consumed: "materialized",
		});
		await bInternals.getOrHydrateBoundSessionState(handle.rlm_child_id);
		expect(terminalEntries(parentB.runtime.session, operation.deliveryId)).toHaveLength(1);
		expect(promptAndWait).toHaveBeenCalledTimes(1);

		// Releasing the stale A callback after B consumed cannot append or consume.
		releaseStaleAppend.resolve();
		await vi.waitFor(() => expect(terminalEntries(parentB.runtime.session, operation.deliveryId)).toHaveLength(1));
		expect(realRegistry(artifacts).deliveries.get(delivery.key)).toMatchObject({
			consumed: "materialized",
		});

		await bInternals.closeSession(parentB, "shutdown");
		const c = await createRealDaemonFixture(root, scripted);
		const cInternals = c.daemon as unknown as DaemonInternals;
		const parentC = await cInternals.createRuntime({ type: "create", sessionPath: parentFile });
		await cInternals.getOrHydrateBoundSessionState(handle.rlm_child_id);
		expect(
			terminalEntries({ sessionManager: SessionManager.open(parentFile, a.sessionDir) }, operation.deliveryId),
		).toHaveLength(1);
		expect(scripted.observations()).toHaveLength(1);
		expect(promptAndWait).toHaveBeenCalledTimes(1);
		expect([...realRegistry(artifacts).deliveries.values()]).toHaveLength(1);
		await cInternals.closeSession(parentC, "shutdown");
	}, 20_000);

	it("uses the public daemon delete path to retain a live intent until its real cancelled terminal is deleted and discarded", async () => {
		const root = await mkdtemp(join(tmpdir(), "prime-agent-c03-real-delete-"));
		const requestId = "request-9002";
		const scripted = createBarrierScriptedProvider({
			api: "c03-real-delete-scripted",
			provider: "c03-real-delete-scripted",
			barrier: { expected: [requestId], timeoutMs: 10_000 },
			models: [{ id: "c03-real-delete-model", responseModel: "c03-real-delete-model" }],
			scripts: {
				[requestId]: [
					{
						requestId,
						blocks: [{ type: "text", chunks: ["must never reach parent"] }],
						usage: usage(11, 7),
						responseModel: "c03-real-delete-model",
						waitForRelease: true,
					},
				],
			},
		});
		cleanups.push(() => scripted.unregister());
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const fixture = await createRealDaemonFixture(root, scripted);
		const internals = fixture.daemon as unknown as DaemonInternals;
		const parentState = await internals.createRuntime({ type: "create" });
		const parent = parentState.runtime.session;
		const handle = await parent.runRlmChild(`C03 actual cancel ${requestId}`, {
			name: "c03-live-delete-worker",
			model: "c03-real-delete-scripted/c03-real-delete-model",
		});
		await scripted.open;
		const artifacts = parent.sessionManager.getSessionArtifactDir();
		if (!artifacts) throw new Error("Missing persisted real parent artifact");
		const admitted = realRegistry(artifacts);
		const operation = [...admitted.operations.values()].find(
			(candidate) => candidate.childId === handle.rlm_child_id,
		);
		if (!operation) throw new Error("Missing admitted real C03 deletion operation");

		// This is the public session API, which delegates to the real daemon host.
		await parent.deleteRlmSubagent(handle.rlm_child_id);
		expect(terminalEntries(parent, operation.deliveryId)).toHaveLength(0);
		await vi.waitFor(() => {
			const after = realRegistry(artifacts);
			expect(after.operations.get(operation.key)).toMatchObject({ lifecycle: "deleted", deleteIntent: true });
			expect(
				[...after.deliveries.values()].find((delivery) => delivery.deliveryId === operation.deliveryId),
			).toMatchObject({
				consumed: "discarded",
			});
		});
		expect(terminalEntries(parent, operation.deliveryId)).toHaveLength(0);
		expect(parent.messages.filter((message) => message.role === "custom")).toHaveLength(0);
		expect(scripted.observations()).toEqual([
			expect.objectContaining({ requestId, terminal: "aborted", signalAborted: true }),
		]);
		await vi.waitFor(async () => expect((await parent.listRlmSubagents()).subagents).toHaveLength(0));
		await internals.closeSession(parentState, "shutdown");
	}, 20_000);

	it("keeps a real cancelled A fenced while B reuses its public selector", async () => {
		const root = await mkdtemp(join(tmpdir(), "prime-agent-c03-real-reuse-"));
		const aRequest = "request-9002";
		const bRequest = "request-9003";
		const scripted = createBarrierScriptedProvider({
			api: "c03-real-reuse-scripted",
			provider: "c03-real-reuse-scripted",
			barrier: { expected: [aRequest, bRequest], timeoutMs: 10_000 },
			models: [{ id: "c03-real-reuse-model", responseModel: "c03-real-reuse-model" }],
			scripts: {
				[aRequest]: [
					{
						requestId: aRequest,
						blocks: [{ type: "text", chunks: ["A must be discarded"] }],
						usage: usage(11, 7),
						responseModel: "c03-real-reuse-model",
						waitForRelease: true,
					},
				],
				[bRequest]: [
					{
						requestId: bRequest,
						blocks: [{ type: "text", chunks: ["B remains running"] }],
						usage: usage(13, 9),
						responseModel: "c03-real-reuse-model",
						waitForRelease: true,
					},
				],
			},
		});
		cleanups.push(() => scripted.unregister());
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const fixture = await createRealDaemonFixture(root, scripted);
		const internals = fixture.daemon as unknown as DaemonInternals;
		const parentState = await internals.createRuntime({ type: "create" });
		const parent = parentState.runtime.session;
		const name = "c03-reused-public-selector";
		const a = await parent.runRlmChild(`C03 stale A ${aRequest}`, {
			name,
			model: "c03-real-reuse-scripted/c03-real-reuse-model",
		});
		await vi.waitFor(() => expect(scripted.observations()).toHaveLength(1));
		const artifacts = parent.sessionManager.getSessionArtifactDir();
		const parentFile = parent.sessionFile;
		if (!artifacts || !parentFile) throw new Error("Missing persisted real parent paths");
		const aOperation = [...realRegistry(artifacts).operations.values()].find(
			(candidate) => candidate.childId === a.rlm_child_id,
		);
		if (!aOperation) throw new Error("Missing real A operation");

		// This wraps the actual daemon host, after the public delete has fsynced its
		// intent and closed A's registry row, but before its terminal hand-off.
		const daemonHost = (
			parent as unknown as { _subagentRuntimeHost?: import("../src/core/rlm-runtime.js").SubagentRuntimeHost }
		)._subagentRuntimeHost;
		const realDeliver = daemonHost?.deliverRlmSubagentTerminal;
		if (!daemonHost || !realDeliver) throw new Error("Missing real daemon terminal host");
		const aTerminalEntered = deferred<void>();
		const releaseATerminal = deferred<void>();
		daemonHost.deliverRlmSubagentTerminal = async (runtime, options, terminal, message) => {
			if (terminal === "cancelled" && options.operationId === aOperation.operationId) {
				aTerminalEntered.resolve();
				await releaseATerminal.promise;
			}
			return await realDeliver.call(daemonHost, runtime, options, terminal, message);
		};
		cleanups.push(() => {
			daemonHost.deliverRlmSubagentTerminal = realDeliver;
		});

		const deleteA = parent.deleteRlmSubagent(name);
		await aTerminalEntered.promise;
		const whileAHeld = realRegistry(artifacts);
		expect(whileAHeld.operations.get(aOperation.key)).toMatchObject({
			lifecycle: "delete_intent",
			deleteIntent: true,
		});
		expect(
			[...whileAHeld.deliveries.values()].find((delivery) => delivery.deliveryId === aOperation.deliveryId),
		).toBeUndefined();
		const aRegistryRows = (await readFile(join(artifacts, "rlm-subagents.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(aRegistryRows.at(-1)).toMatchObject({
			childId: a.rlm_child_id,
			assignmentId: aOperation.assignmentId,
			operationId: aOperation.operationId,
			status: "deleted",
		});
		const b = await parent.runRlmChild(`C03 replacement B ${bRequest}`, {
			name,
			model: "c03-real-reuse-scripted/c03-real-reuse-model",
		});
		expect(b.rlm_child_id).not.toBe(a.rlm_child_id);
		await scripted.open;
		const bState = await internals.getOrHydrateBoundSessionState(b.rlm_child_id);
		const bFile = bState.runtime.session.sessionFile;
		if (!bFile) throw new Error("Missing B session file");
		const bRegistryBefore = realRegistry(artifacts);
		const bOperation = [...bRegistryBefore.operations.values()].find(
			(operation) => operation.childId === b.rlm_child_id,
		);
		if (!bOperation) throw new Error("Missing real B operation");
		const bDeliveryBefore = [...bRegistryBefore.deliveries.values()].find(
			(delivery) => delivery.deliveryId === bOperation.deliveryId,
		);
		expect(bDeliveryBefore).toBeUndefined();
		const bSessionBefore = await readFile(bFile, "utf8");
		const bRegistryFileBefore = await readFile(join(artifacts, "rlm-subagents.jsonl"), "utf8");
		const parentTranscriptBefore = await readFile(parentFile, "utf8");
		expect(await parent.listRlmSubagents()).toMatchObject({
			subagents: [expect.objectContaining({ rlm_child_id: b.rlm_child_id, session_name: name, status: "running" })],
		});

		releaseATerminal.resolve();
		await deleteA;
		await vi.waitFor(() => {
			const after = realRegistry(artifacts);
			expect(after.operations.get(aOperation.key)).toMatchObject({ lifecycle: "deleted", deleteIntent: true });
			expect(
				[...after.deliveries.values()].find((delivery) => delivery.deliveryId === aOperation.deliveryId),
			).toMatchObject({ consumed: "discarded" });
		});
		const afterA = realRegistry(artifacts);
		expect(afterA.operations.get(bOperation.key)).toEqual(bRegistryBefore.operations.get(bOperation.key));
		expect([...afterA.deliveries.values()].find((delivery) => delivery.deliveryId === bOperation.deliveryId)).toEqual(
			bDeliveryBefore,
		);
		expect(await readFile(bFile, "utf8")).toBe(bSessionBefore);
		expect(await readFile(join(artifacts, "rlm-subagents.jsonl"), "utf8")).toBe(bRegistryFileBefore);
		expect(await readFile(parentFile, "utf8")).toBe(parentTranscriptBefore);
		expect(terminalEntries(parent, aOperation.deliveryId)).toHaveLength(0);
		expect(parent.messages.filter((message) => message.role === "custom")).toHaveLength(0);
		expect(await parent.listRlmSubagents()).toMatchObject({
			subagents: [expect.objectContaining({ rlm_child_id: b.rlm_child_id, session_name: name, status: "running" })],
		});
		expect(scripted.observations()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ requestId: aRequest, terminal: "aborted", signalAborted: true }),
				expect.objectContaining({ requestId: bRequest, signalAborted: false }),
			]),
		);
		await internals.closeSession(parentState, "shutdown");
	}, 20_000);
});
