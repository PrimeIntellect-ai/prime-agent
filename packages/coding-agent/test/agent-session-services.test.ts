import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MESSAGE_SKILL_NAME, type AgentSessionMessageController } from "../src/core/agent-messages.js";
import { AGENT_OBSERVE_SKILL_NAME, type AgentObserveController } from "../src/core/agent-observe.js";
import {
	type AgentSessionWorkflowHostFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
	createDefaultPrimeWorkflowWorkerLauncher,
} from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import type { DefaultPrimeTaskRuntimeAuthorityFactory } from "../src/core/workflow/default-prime.js";
import type { DefaultPrimeWorkerTaskCapsule } from "../src/core/workflow/default-task-runtime.js";
import type { WorkflowPrimeStageEvidenceAdapter } from "../src/core/workflow/task-runtime-authority.js";
import {
	WORKER_MODEL_ID,
	WORKER_MODEL_PROVIDER,
	WORKER_MODEL_REASONING,
	WORKER_MODEL_SELECTOR,
} from "../src/core/workflow/worker-model-capability-gate.js";

describe("createAgentSessionFromServices", () => {
	const cleanupPaths: string[] = [];
	const unregisters: Array<() => void> = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (unregisters.length > 0) {
			unregisters.pop()?.();
		}
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path && existsSync(path)) {
				rmSync(path, { recursive: true, force: true });
			}
		}
	});

	it("forwards the authenticated task-runtime composition through the public host factory", async () => {
		const tempDir = join(
			tmpdir(),
			`pi-session-task-runtime-forwarding-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const runtimeVersion = "0.147.0-alpha.10";
		const taskRuntimeAuthorityFactory = vi.fn() as unknown as DefaultPrimeTaskRuntimeAuthorityFactory;
		const taskRuntimePrimeAdapter = {} as WorkflowPrimeStageEvidenceAdapter;
		let received: Parameters<AgentSessionWorkflowHostFactory>[0] | undefined;
		const workflowHostFactory: AgentSessionWorkflowHostFactory = async (input) => {
			received = input;
			throw new Error("task_runtime_forwarding_probe");
		};
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager: SettingsManager.inMemory(),
			workflowHostFactory,
			runtimeVersion,
			taskRuntimeAuthorityFactory,
			taskRuntimePrimeAdapter,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		await expect(
			createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			}),
		).rejects.toThrow("task_runtime_forwarding_probe");
		expect(received).toMatchObject({
			runtimeVersion,
			taskRuntimeAuthorityFactory,
			taskRuntimePrimeAdapter,
			progressWakeDelivery: expect.any(Function),
		});
	});

	it("holds kernel prewarm behind workflow construction setup", async () => {
		const tempDir = join(tmpdir(), `pi-session-workflow-prewarm-gate-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const prewarm = vi.spyOn(IpythonKernelProvisioner.prototype, "prewarm").mockImplementation(() => {});
		let prewarmCallsAtFactory: number | undefined;
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager: SettingsManager.inMemory(),
			workflowHostFactory: async () => {
				prewarmCallsAtFactory = prewarm.mock.calls.length;
				throw new Error("workflow_setup_gate_probe");
			},
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		await expect(
			createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
				prewarmIpythonKernel: true,
			}),
		).rejects.toThrow("workflow_setup_gate_probe");
		expect(prewarmCallsAtFactory).toBe(0);
	});

	it.each(["runtime", "environment", "prime_cli"] as const)(
		"accepts a valid %s credential source without config-file authentication",
		async (source) => {
			const tempDir = join(tmpdir(), `pi-session-worker-readiness-${source}-${Date.now()}`);
			mkdirSync(tempDir, { recursive: true });
			cleanupPaths.push(tempDir);
			const faux = registerFauxProvider();
			unregisters.push(() => faux.unregister());
			const authStorage = AuthStorage.inMemory();
			const modelRegistry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
			const workerModel = {
				...faux.getModel(),
				provider: WORKER_MODEL_PROVIDER,
				id: WORKER_MODEL_ID,
			} as Model<string>;
			vi.spyOn(modelRegistry, "find").mockReturnValue(workerModel as Model<never>);
			vi.spyOn(modelRegistry, "getExecutableModels").mockResolvedValue([workerModel as Model<never>]);
			vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockResolvedValue({ ok: true, apiKey: "valid-worker-key" });
			vi.spyOn(modelRegistry, "getCurrentProviderAuthSourceToken").mockReturnValue({
				provider: WORKER_MODEL_PROVIDER,
				source,
				identityFingerprint: `${source}-identity`,
				valueFingerprint: `${source}-value`,
			});
			vi.spyOn(modelRegistry, "getProviderAuthStatus").mockReturnValue({ configured: false, source });

			const services = await createAgentSessionServices({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
			});
			const availability = services.workerModelCapabilityAvailability;
			if (availability === undefined) throw new Error("worker_model_availability_missing");
			await expect(
				availability({
					workflowId: "workflow-readiness",
					policy: {
						provider: WORKER_MODEL_PROVIDER,
						model: WORKER_MODEL_ID,
						reasoning: WORKER_MODEL_REASONING,
						allowFallback: false,
						policyRevision: "policy-revision",
					},
					stateDigest: "state-digest",
					revision: 1,
					epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
				}),
			).resolves.toMatchObject({
				authenticated: true,
				safeReason: "available",
				idleCapacity: 1,
			});
			expect(WORKER_MODEL_SELECTOR).toBe(`${WORKER_MODEL_PROVIDER}/${WORKER_MODEL_ID}`);
		},
	);

	it("rejects missing or invalid worker authentication even when the model is executable", async () => {
		const tempDir = join(tmpdir(), `pi-session-worker-readiness-invalid-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const modelRegistry = ModelRegistry.create(AuthStorage.inMemory(), join(tempDir, "models.json"));
		const workerModel = {
			id: WORKER_MODEL_ID,
			name: WORKER_MODEL_ID,
			provider: WORKER_MODEL_PROVIDER,
			api: "faux",
			baseUrl: "http://localhost:0",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		} as Model<string>;
		vi.spyOn(modelRegistry, "find").mockReturnValue(workerModel as Model<never>);
		vi.spyOn(modelRegistry, "getExecutableModels").mockResolvedValue([workerModel as Model<never>]);
		vi.spyOn(modelRegistry, "getApiKeyAndHeaders").mockResolvedValue({ ok: false, error: "invalid credential" });
		vi.spyOn(modelRegistry, "getCurrentProviderAuthSourceToken").mockReturnValue(undefined);
		vi.spyOn(modelRegistry, "getProviderAuthStatus").mockReturnValue({ configured: false, source: "stale" });

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		const availability = services.workerModelCapabilityAvailability;
		if (availability === undefined) throw new Error("worker_model_availability_missing");
		await expect(
			availability({
				workflowId: "workflow-readiness",
				policy: {
					provider: WORKER_MODEL_PROVIDER,
					model: WORKER_MODEL_ID,
					reasoning: WORKER_MODEL_REASONING,
					allowFallback: false,
					policyRevision: "policy-revision",
				},
				stateDigest: "state-digest",
				revision: 1,
				epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
			}),
		).resolves.toMatchObject({
			authenticated: false,
			idleCapacity: 0,
			safeReason: "worker_model_authentication_unavailable",
		});
	});

	it("fails closed before creating a child directory when worker admission is absent", async () => {
		const tempDir = join(
			tmpdir(),
			`pi-session-worker-admission-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});
		try {
			const internal = session as unknown as { _rlmSessionDir?: string };
			const beforeChildren = internal._rlmSessionDir ? readdirSync(internal._rlmSessionDir) : [];
			await expect(
				session.runWorkflowRlmChild("run Luna", "luna-child", undefined, {
					workflowId: session.sessionId,
					taskId: "task-luna",
					attemptId: "attempt-luna",
					executionKey: "execution-luna",
					epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
					deadlineAt: new Date(Date.now() + 60_000).toISOString(),
				}),
			).rejects.toThrow("workflow_worker_model_dispatch admission binding is unavailable");
			const afterChildren = internal._rlmSessionDir ? readdirSync(internal._rlmSessionDir) : [];
			expect(afterChildren).toEqual(beforeChildren);
		} finally {
			session.dispose();
		}
	});

	it("terminalizes a normal workflow child without waiting behind heartbeat backlog", async () => {
		let reportProgress: ((progressDigest: string) => void) | undefined;
		const deadlineAt = new Date(Date.now() + 60_000).toISOString();
		const session = {
			cancelRlmChildRun: vi.fn(() => true),
			runWorkflowRlmChild: vi.fn(
				async (
					_prompt: string,
					_sessionName: string,
					_model: string | undefined,
					_launchContext: unknown,
					onMeaningfulProgress: (progressDigest: string) => void,
				) => {
					reportProgress = onMeaningfulProgress;
					return {
						rlm_child_id: "child-fast",
						name: "prime-recon",
						session_dir: "/tmp/prime-recon",
						model: "openai-codex/gpt-5.6-luna",
					};
				},
			),
			awaitRlmChildCompletion: vi.fn(async () => ({
				status: "completed" as const,
				output: "bounded terminal result",
				error: null,
				retryable: false,
			})),
		};
		const neverCommittedHeartbeat = new Promise<void>(() => undefined);
		const reportHeartbeat = vi.fn(async () => neverCommittedHeartbeat);
		const launcher = createDefaultPrimeWorkflowWorkerLauncher({
			session,
			workerModel: "openai-codex/gpt-5.6-luna",
		});
		const launch = await launcher({
			workflowId: "workflow-fast-terminal",
			taskId: "recon",
			attemptId: "attempt-recon",
			executionKey: "execution-recon",
			epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
			prompt: "recon",
			taskCapsule: { capsuleDigest: "capsule-digest" } as DefaultPrimeWorkerTaskCapsule,
			sessionName: "prime-recon",
			reportHeartbeat,
			deadlineAt,
		});
		if (reportProgress === undefined) throw new Error("workflow_progress_callback_missing");
		reportProgress("progress-1");
		reportProgress("progress-2");

		await expect(launch.completion).resolves.toMatchObject({
			kind: "worker",
			status: "completed",
			output: "bounded terminal result",
			binding: {
				workflowId: "workflow-fast-terminal",
				taskId: "recon",
				attemptId: "attempt-recon",
				executionKey: "execution-recon",
			},
		});
		expect(reportHeartbeat).toHaveBeenCalledTimes(1);
		await expect(launch.terminate?.("task_resource_lease_expired")).resolves.toBe(true);
		expect(session.cancelRlmChildRun).toHaveBeenCalledWith("child-fast", "task_resource_lease_expired");
		expect(session.awaitRlmChildCompletion).toHaveBeenCalledTimes(2);
		expect(session.runWorkflowRlmChild).toHaveBeenCalledWith(
			"recon",
			"prime-recon",
			"openai-codex/gpt-5.6-luna",
			expect.objectContaining({ deadlineAt }),
			expect.any(Function),
		);
	});

	it("forwards the scheduler task capsule and rejects a worker launch without one", async () => {
		const session = {
			cancelRlmChildRun: vi.fn(() => true),
			awaitRlmChildCompletion: vi.fn(async () => ({
				status: "completed" as const,
				output: "capsule-bound result",
				error: null,
				retryable: false,
			})),
			runWorkflowRlmChild: vi.fn(async () => ({
				rlm_child_id: "child-capsule",
				name: "capsule-worker",
				session_dir: "/tmp/capsule-worker",
				model: "openai-codex/gpt-5.6-luna",
			})),
		};
		const launcher = createDefaultPrimeWorkflowWorkerLauncher({
			session,
			workerModel: "openai-codex/gpt-5.6-luna",
		});
		const request = {
			workflowId: "workflow-capsule",
			taskId: "task-capsule",
			attemptId: "attempt-capsule",
			executionKey: "execution-capsule",
			epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
			prompt: "capsule task",
			taskCapsule: { capsuleDigest: "capsule-digest" } as DefaultPrimeWorkerTaskCapsule,
			sessionName: "capsule-worker",
			reportHeartbeat: vi.fn(async () => undefined),
		};

		await launcher(request);
		expect(session.runWorkflowRlmChild).toHaveBeenCalledWith(
			"capsule task",
			"capsule-worker",
			"openai-codex/gpt-5.6-luna",
			expect.objectContaining({ capsuleDigest: "capsule-digest" }),
			expect.any(Function),
		);

		await expect(launcher({ ...request, taskCapsule: undefined, prompt: "missing capsule" })).rejects.toThrow(
			"workflow_worker_task_capsule_required",
		);
		expect(session.runWorkflowRlmChild).toHaveBeenCalledTimes(1);
	});

	it("shows the telemetry disclosure independently of the Herdr reporter", async () => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		const tempDir = join(tmpdir(), `pi-session-telemetry-notice-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const settingsManager = SettingsManager.inMemory();

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			noBuiltinHerdrReporter: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		expect(services.diagnostics).toContainEqual(
			expect.objectContaining({ type: "info", message: expect.stringContaining("pseudonymous usage") }),
		);
		expect(settingsManager.getTelemetryNoticeShown()).toBe(true);
	});

	it("honors an explicit daemon-carried telemetry opt-out", async () => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		const tempDir = join(tmpdir(), `pi-session-daemon-telemetry-opt-out-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const settingsManager = SettingsManager.inMemory();
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			telemetryDisabled: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		expect(services.diagnostics).not.toContainEqual(
			expect.objectContaining({ message: expect.stringContaining("pseudonymous usage") }),
		);
		expect(settingsManager.getTelemetryNoticeShown()).toBe(false);

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			telemetryDisabled: true,
		});
		try {
			expect(existsSync(join(tempDir, "telemetry.json"))).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it("does not install top-level telemetry for a resumed child session", async () => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		const tempDir = join(tmpdir(), `pi-session-child-telemetry-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager: SettingsManager.inMemory({ telemetry: { noticeShown: true } }),
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		sessionManager.newSession({ rlmDepth: 1 });

		const { session } = await createAgentSessionFromServices({ services, sessionManager });
		try {
			expect(session.rlmDepth).toBe(1);
			expect(existsSync(join(tempDir, "telemetry.json"))).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it("forwards daemon-backed agent message controllers into AgentSession", async () => {
		const tempDir = join(tmpdir(), `pi-session-services-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);

		const faux = registerFauxProvider();
		unregisters.push(() => faux.unregister());

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noPromptTemplates: true,
				noThemes: true,
				skillsOverride: () => ({
					skills: [
						{
							name: AGENT_MESSAGE_SKILL_NAME,
							description: "hidden agent message skill",
							filePath: "<test:agent-message>",
							baseDir: tempDir,
							sourceInfo: createSyntheticSourceInfo("<test:agent-message>", { source: "test" }),
							disableModelInvocation: true,
							kind: "python" as const,
							python: {
								importName: "agent_message",
								packagePath: tempDir,
								pyprojectPath: join(tempDir, "pyproject.toml"),
							},
						},
					],
					diagnostics: [],
				}),
			},
		});
		services.modelRegistry.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});

		const agentMessageController: AgentSessionMessageController = {
			listAgents: () => ({
				current: { activeSessionId: "current", sessionId: "session-current", runtimeKind: "top-level" },
				agents: [
					{
						activeSessionId: "worker",
						sessionId: "session-worker",
						runtimeKind: "top-level",
						cwd: tempDir,
						isStreaming: false,
						unfinishedActionCount: 0,
					},
				],
			}),
			sendAgentMessage: async () => {
				throw new Error("not used");
			},
		};

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			model: faux.getModel(),
			agentMessageController,
		});

		try {
			expect(() => session.handleAgentMessageHostRequest("agent_message.list")).toThrow(
				"unknown agent message request",
			);
			expect(
				(
					session as unknown as {
						_createKernelHostHandlers(): Record<string, unknown>;
					}
				)._createKernelHostHandlers(),
			).not.toHaveProperty("agent_message.send");
		} finally {
			session.dispose();
		}
	});

	it("hides daemon-backed orchestration skills unless their host bridges are available", async () => {
		const tempDir = join(tmpdir(), `pi-session-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);

		const authStorage = AuthStorage.inMemory();
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		const createSession = async (options: Parameters<typeof createAgentSessionFromServices>[0]) => {
			const { session } = await createAgentSessionFromServices(options);
			return session;
		};
		const visibleSkillNames = (session: unknown) =>
			(
				session as {
					_modelVisibleSkills(): Array<{ name: string }>;
				}
			)
				._modelVisibleSkills()
				.map((skill) => skill.name);
		const kernelHostHandlers = (session: unknown) =>
			(
				session as {
					_createKernelHostHandlers(): Record<string, unknown>;
				}
			)._createKernelHostHandlers();

		const withoutControllers = await createSession({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions-without")),
		});
		try {
			expect(visibleSkillNames(withoutControllers)).not.toContain(AGENT_MESSAGE_SKILL_NAME);
			expect(visibleSkillNames(withoutControllers)).not.toContain(AGENT_OBSERVE_SKILL_NAME);
		} finally {
			withoutControllers.dispose();
		}

		const agentObserveController: AgentObserveController = {
			listAgents: () => ({
				current: {
					activeSessionId: "current",
					sessionId: "session-current",
					runtimeKind: "top-level",
					cwd: tempDir,
					status: "idle",
					isCurrent: true,
					isStreaming: false,
					isCompacting: false,
					attachedClients: 1,
					messageCount: 0,
					queuedCount: 0,
					isSessionActive: false,
				},
				agents: [],
			}),
			getAgent: () => {
				throw new Error("not used");
			},
			recentMessages: () => {
				throw new Error("not used");
			},
		};
		const withControllers = await createSession({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions-with")),
			agentObserveController,
		});
		try {
			expect(visibleSkillNames(withControllers)).toContain(AGENT_OBSERVE_SKILL_NAME);
			expect(visibleSkillNames(withControllers)).not.toContain(AGENT_MESSAGE_SKILL_NAME);
		} finally {
			withControllers.dispose();
		}

		const agentMessageController: AgentSessionMessageController = {
			listAgents: () => ({
				current: { activeSessionId: "current", sessionId: "session-current" },
				agents: [],
			}),
			sendAgentMessage: async () => {
				throw new Error("not used");
			},
		};
		const withMessageController = await createSession({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions-with-message")),
			agentMessageController,
		});
		try {
			expect(visibleSkillNames(withMessageController)).toContain(AGENT_MESSAGE_SKILL_NAME);
			expect(kernelHostHandlers(withMessageController)).toHaveProperty("agent_message.send");
		} finally {
			withMessageController.dispose();
		}
	});
});
