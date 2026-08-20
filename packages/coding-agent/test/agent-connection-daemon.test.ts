import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { MissingSessionCwdError } from "../src/core/session-cwd.js";
import { SessionImportFileNotFoundError } from "../src/core/session-import-errors.js";
import {
	DAEMON_REFINE_REQUEST_TIMEOUT_MS,
	DaemonAgentConnection,
} from "../src/modes/agent-connection/daemon-agent-connection.js";
import type {
	AgentConnectionEvent,
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSavedSessionInfo,
	AgentConnectionState,
} from "../src/modes/agent-connection/types.js";

import {
	DaemonCapabilityUnavailableError,
	type DaemonClient,
	type DaemonClientCloseListener,
	type DaemonClientMessageListener,
	type DaemonClientRequestOptions,
	type DaemonHello,
	DaemonSocketClosedError,
} from "../src/modes/daemon/daemon-client.js";
import {
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";

class FakeDaemonClient {
	readonly requests: DaemonCommand[] = [];
	readonly requestTimeouts: number[] = [];
	attachResultFactory: ((command: Extract<DaemonCommand, { type: "attach" }>) => DaemonAttachResult) | undefined;
	restoredAttachGate: Promise<void> | undefined;
	restoredAttachCompleted = 0;
	closeCount = 0;
	emitCloseOnClose = false;
	connected = true;
	reconnectCount = 0;
	resetTransportCount = 0;
	reconnectError: Error | undefined;
	attachFailures = 0;
	connectionStateGate: Promise<void> | undefined;
	connectionStateFactory: ((activeSessionId: string) => AgentConnectionState) | undefined;
	rlmChildren: AgentConnectionRlmChildAgentSnapshot[] = [];
	rlmChildrenEventSequence = 12;
	rlmChildrenGate: Promise<void> | undefined;
	abortBashUnknownCommand = false;
	abortAndClearQueueUnknownCommand = false;
	inputPauseAcquireGate: Promise<void> | undefined;
	cronAddGate: Promise<void> | undefined;
	promptGate: Promise<void> | undefined;
	promptError: Error | undefined;
	promptResponseError: string | undefined;
	cancelPromptAdmissionStatus: "cancelled" | "owned" | "unknown" = "owned";
	serverCapabilities = new Set<string>();
	updateRestartSessions: Array<Record<string, unknown>> = [];
	hello: DaemonHello | undefined = {
		type: "daemon_hello",
		socketPath: "/tmp/fake.sock",
		protocol: DAEMON_PROTOCOL_INFO,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		clientId: "fake-client",
		serverCapabilities: ["prompt_admission_cancellation", "session_input_admission"],
	};
	private readonly messageListeners = new Set<DaemonClientMessageListener>();
	private readonly closeListeners = new Set<DaemonClientCloseListener>();

	async request(
		command: DaemonCommand,
		timeoutMs = 30000,
		options: DaemonClientRequestOptions = {},
	): Promise<DaemonResponse> {
		this.requests.push(command);
		this.requestTimeouts.push(timeoutMs);
		switch (command.type) {
			case "prompt":
				if (this.promptGate) await this.promptGate;
				if (this.promptError) throw this.promptError;
				if (this.promptResponseError) {
					return { type: "response", command: command.type, success: false, error: this.promptResponseError };
				}
				return { type: "response", command: command.type, success: true };
			case "prompt_and_wait":
				if (this.promptGate) await this.promptGate;
				if (this.promptError) throw this.promptError;
				return { type: "response", command: command.type, success: true };
			case "cancel_prompt_admission":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { status: this.cancelPromptAdmissionStatus },
				};
			case "list":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { sessions: this.updateRestartSessions },
				};
			case "attach":
				if (this.attachFailures > 0) {
					this.attachFailures--;
					throw new Error("attach failed");
				}
				if (command.activeSessionId === "active-restored" && this.restoredAttachGate) {
					await this.restoredAttachGate;
					this.restoredAttachCompleted++;
				}
				if (command.activeSessionId === "missing") {
					return {
						type: "response",
						command: command.type,
						success: false,
						error: "Unknown active session: missing",
					};
				}
				return {
					type: "response",
					command: command.type,
					success: true,
					data:
						this.attachResultFactory?.(command) ??
						createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 12),
				};
			case "get_queue":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { steering: ["steer"], followUp: ["follow"] },
				};
			case "get_connection_state":
				await this.connectionStateGate;
				return {
					type: "response",
					command: command.type,
					success: true,
					data:
						this.connectionStateFactory?.(command.activeSessionId) ??
						createConnectionState(command.activeSessionId, "session-current"),
				};
			case "get_messages":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { messages: [{ role: "user", content: "current prompt", timestamp: 4 }] },
				};
			case "get_rlm_children":
				await this.rlmChildrenGate;
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { children: this.rlmChildren, eventSequence: this.rlmChildrenEventSequence },
				};
			case "get_resource_snapshot":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						contextFiles: [{ path: "/tmp/AGENTS.md" }],
						skills: [
							{
								name: "demo-skill",
								description: "Demo skill",
								filePath: "/tmp/skills/demo-skill/SKILL.md",
								sourceInfo: {
									path: "/tmp/skills/demo-skill/SKILL.md",
									source: "local",
									scope: "project",
									origin: "top-level",
									baseDir: "/tmp/skills",
								},
							},
						],
						prompts: [],
						extensions: [],
						themes: [],
						diagnostics: {
							skills: [],
							prompts: [],
							extensions: [],
							themes: [],
						},
					},
				};
			case "replace_acp_mcp_servers":
				return { type: "response", command: command.type, success: true };
			case "get_model_catalog":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						models: [getModel("openai", "gpt-5.1")],
						configuredProviders: ["openai"],
					},
				};
			case "get_available_models":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { models: [getModel("openai", "gpt-5.1")] },
				};
			case "get_session_context":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						context: {
							messages: [{ role: "user", content: "context prompt", timestamp: 3 }],
							thinkingLevel: "medium",
							model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
						},
					},
				};
			case "get_session_tree":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						flatNodes: [
							{
								entry: {
									type: "message",
									id: "user-1",
									parentId: null,
									timestamp: "2026-01-01T00:00:00.000Z",
									message: { role: "user", content: "hello", timestamp: 1 },
								},
							},
						],
						leafId: "user-1",
					},
				};
			case "get_tool_definition":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						toolDefinition: {
							name: command.name,
							label: command.name,
							description: `${command.name} description`,
							promptSnippet: `${command.name} prompt`,
							promptGuidelines: [`Use ${command.name}`],
							parameters: { type: "object" },
							renderShell: "self",
						},
					},
				};
			case "clear_queue":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { steering: ["cleared"], followUp: [] },
				};
			case "abort_and_clear_queue":
				if (this.abortAndClearQueueUnknownCommand) {
					return {
						type: "response",
						command: command.type,
						success: false,
						error: "Unknown daemon command: abort_and_clear_queue",
					};
				}
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { steering: ["aborted"], followUp: ["cleared"] },
				};
			case "acquire_session_input_pause":
				if (this.inputPauseAcquireGate) await this.inputPauseAcquireGate;
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { pauseId: "pause-1" },
				};
			case "release_session_input_pause":
				return { type: "response", command: command.type, success: true };
			case "heartbeats_list":
				return this.serverCapabilities.has("heartbeat_catalog")
					? { type: "response", command: command.type, success: true, data: { heartbeats: [] } }
					: {
							type: "response",
							command: command.type,
							success: false,
							error: "Unknown daemon command: heartbeats_list",
						};
			case "heartbeat_manage":
				return this.serverCapabilities.has("heartbeat_management")
					? {
							type: "response",
							command: command.type,
							success: true,
							data: { heartbeat: { id: command.jobId } },
						}
					: {
							type: "response",
							command: command.type,
							success: false,
							error: "Unknown daemon command: heartbeat_manage",
						};
			case "list_saved_sessions": {
				const activeSessionId = "activeSessionId" in command ? command.activeSessionId : undefined;
				options.onProgress?.({
					id: "daemon_test",
					type: "session_list_progress",
					command: "list_saved_sessions",
					...(activeSessionId ? { activeSessionId } : {}),
					loaded: 1,
					total: 2,
				});
				options.onProgress?.({
					id: "daemon_test",
					type: "session_list_item",
					command: "list_saved_sessions",
					...(activeSessionId ? { activeSessionId } : {}),
					session: {
						path: "/tmp/session-a.jsonl",
						id: "session-a",
						cwd: "/tmp",
						name: "Saved session",
						created: "2026-01-01T00:00:00.000Z",
						modified: "2026-01-02T00:00:00.000Z",
						messageCount: 2,
						firstMessage: "hello",
						allMessagesText: "hello world",
					},
				});
				options.onProgress?.({
					id: "daemon_test",
					type: "session_list_progress",
					command: "list_saved_sessions",
					...(activeSessionId ? { activeSessionId } : {}),
					loaded: 2,
					total: 2,
				});
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						sessions: [
							{
								path: "/tmp/session-a.jsonl",
								id: "session-a",
								cwd: "/tmp",
								name: "Saved session",
								created: "2026-01-01T00:00:00.000Z",
								modified: "2026-01-02T00:00:00.000Z",
								messageCount: 2,
								firstMessage: "hello",
								allMessagesText: "hello world",
							},
						],
					},
				};
			}
			case "wait_for_headless_completion":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						enabled: false,
						continuationsUsed: 0,
						turnsUsed: 0,
						tokensUsed: 0,
						limits: { maxContinuations: 0 },
					},
				};
			case "wait_for_idle":
			case "set_scoped_models":
			case "rename_saved_session":
			case "extension_ui_response":
			case "detach":
				return { type: "response", command: command.type, success: true };
			case "cancel_rlm_child":
				if (command.childId === "stale-daemon") {
					return {
						type: "response",
						command: command.type,
						success: false,
						error: "Unknown daemon command: cancel_rlm_child",
					};
				}
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { cancelled: command.childId === "child-1" },
				};
			case "execute_bash":
				if (command.command === "stale-daemon") {
					return {
						type: "response",
						command: command.type,
						success: false,
						error: "Unknown daemon command: execute_bash",
					};
				}
				return { type: "response", command: command.type, success: true };
			case "abort_bash":
				if (this.abortBashUnknownCommand) {
					return {
						type: "response",
						command: command.type,
						success: false,
						error: "Unknown daemon command: abort_bash",
					};
				}
				return { type: "response", command: command.type, success: true };
			case "start_side_question":
				return { type: "response", command: command.type, success: true };
			case "delete_saved_session":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { ok: true, method: "trash" },
				};
			case "refine":
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						id: "refine_daemon",
						summary: "Daemon refinement",
						rationale: "Test daemon refine timeout",
						expectedOutcome: "Refine request completes",
						appliedEdits: [],
						harnessStatePath: "/tmp/harness_state.json",
					},
				};
			case "cron_add":
				await this.cronAddGate;
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						job: {
							id: `cron-${this.requests.filter((request) => request.type === "cron_add").length}`,
							status: "active",
							source: "cron",
							activeSessionId: command.activeSessionId,
							sessionId: "session-current",
							sessionFile: "/tmp/session-current.jsonl",
							cwd: "/tmp/project",
							prompt: command.prompt,
							schedule: { kind: "cron", expression: command.schedule },
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							runCount: 0,
						},
					},
				};
			case "switch_session":
				return {
					type: "response",
					command: command.type,
					success: false,
					error: "Stored session working directory does not exist: /tmp/missing\nSession file: /tmp/session.jsonl\nCurrent working directory: /tmp/current",
					errorInfo: {
						code: "missing_session_cwd",
						issue: {
							sessionFile: "/tmp/session.jsonl",
							sessionCwd: "/tmp/missing",
							fallbackCwd: "/tmp/current",
						},
					},
				};
			case "import_jsonl":
				return {
					type: "response",
					command: command.type,
					success: false,
					error: "File not found: /tmp/not-found.jsonl",
					errorInfo: {
						code: "session_import_file_not_found",
						filePath: "/tmp/not-found.jsonl",
					},
				};
			default:
				throw new Error(`Unexpected command: ${command.type}`);
		}
	}

	supportsServerCapability(capability: string): boolean {
		return this.serverCapabilities.has(capability);
	}

	onMessage(listener: DaemonClientMessageListener): () => void {
		this.messageListeners.add(listener);
		return () => {
			this.messageListeners.delete(listener);
		};
	}

	onClose(listener: DaemonClientCloseListener): () => void {
		this.closeListeners.add(listener);
		return () => {
			this.closeListeners.delete(listener);
		};
	}

	emitMessage(message: DaemonOutbound): void {
		for (const listener of [...this.messageListeners]) {
			listener(message);
		}
	}

	emitClose(error: Error): void {
		for (const listener of [...this.closeListeners]) {
			listener(error);
		}
	}

	enableRequestRecovery(): void {}

	async connect(): Promise<void> {
		if (this.connected) {
			throw new Error("Prime Agent daemon client is already connected");
		}
		this.reconnectCount++;
		if (this.reconnectError) {
			throw this.reconnectError;
		}
		this.connected = true;
	}

	async waitForHello(): Promise<DaemonHello> {
		return this.hello!;
	}

	resetTransportForReconnect(): void {
		this.resetTransportCount++;
		this.connected = false;
	}

	async reconnect(): Promise<void> {
		if (this.connected) {
			return;
		}
		this.reconnectCount++;
		if (this.reconnectError) {
			throw this.reconnectError;
		}
		this.connected = true;
	}

	getMessageListenerCount(): number {
		return this.messageListeners.size;
	}

	getCloseListenerCount(): number {
		return this.closeListeners.size;
	}

	close(): void {
		this.closeCount++;
		this.connected = false;
		if (this.emitCloseOnClose) {
			this.emitClose(new Error("Daemon socket closed"));
		}
	}

	disconnectForReconnect(reason: "shutdown" | "update"): void {
		this.closeCount++;
		this.connected = false;
		this.emitClose(new DaemonSocketClosedError("/tmp/prime-agent.sock", reason));
	}
}

function asDaemonClient(client: FakeDaemonClient): DaemonClient {
	return client as unknown as DaemonClient;
}

function createConnectionState(activeSessionId: string, sessionId: string): AgentConnectionState {
	return {
		activeSessionId,
		cwd: "/tmp/project",
		model: undefined,
		thinkingLevel: "medium",
		serviceTier: "default",
		availableThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionFile: `/tmp/${sessionId}.jsonl`,
		sessionId,
		sessionName: `${sessionId} name`,
		sessionDir: "/tmp/sessions",
		leafId: `${sessionId}-leaf`,
		autoCompactionEnabled: true,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		compactionCount: 0,
		goal: {
			active: false,
			status: "idle",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
		},
		scopedModels: [],
		activeToolNames: ["ipython"],
		contextUsage: undefined,
	};
}

interface CreateAttachResultOptions {
	state?: AgentConnectionState;
	messages?: AgentMessage[];
	streamingMessage?: AgentMessage;
	sessionContext?: DaemonAttachResult["snapshot"]["sessionContext"];
	omitSessionContext?: boolean;
	sessionTree?: DaemonAttachResult["snapshot"]["sessionTree"];
	parent?: DaemonAttachResult["snapshot"]["parent"];
	children?: DaemonAttachResult["snapshot"]["children"];
	replay?: DaemonAttachResult["replay"];
}

function createAttachResult(
	activeSessionId: string,
	clientId: string | undefined,
	capabilities: readonly string[] | undefined,
	lastEventSequence: number,
	options: CreateAttachResultOptions = {},
): DaemonAttachResult {
	const state = options.state ?? createConnectionState(activeSessionId, "session-current");
	const messages = options.messages ?? [];
	const lastEventCursor = { generation: `generation-${activeSessionId}`, sequence: lastEventSequence };
	const summary = {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live" as const,
		activity: "idle" as const,
		isSessionActive: state.isStreaming,
		sessionId: state.sessionId,
		cwd: "/tmp/project",
		isStreaming: state.isStreaming,
		isCompacting: false,
		attachedClients: 1,
		messageCount: messages.length,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...(options.streamingMessage ? { streamingMessage: options.streamingMessage } : {}),
	};
	// Slim shape: the daemon omits top-level state/messages for clients with the
	// "slim_attach" capability, which DaemonAgentConnection always advertises.
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		snapshot: {
			activeSessionId,
			summary,
			state,
			messages,
			...(options.omitSessionContext
				? {}
				: {
						sessionContext:
							options.sessionContext ??
							({
								messages,
								thinkingLevel: state.thinkingLevel,
								serviceTier: state.serviceTier,
								model: state.model ? { provider: state.model.provider, modelId: state.model.id } : null,
							} satisfies NonNullable<DaemonAttachResult["snapshot"]["sessionContext"]>),
					}),
			sessionTree: options.sessionTree ?? { tree: [], leafId: state.leafId },
			lastEventSequence,
			lastEventCursor,
			...(options.parent ? { parent: options.parent } : {}),
			...(options.children ? { children: options.children } : {}),
		},
		replay: options.replay ?? {
			status: "complete",
			toSequence: lastEventSequence,
			toCursor: lastEventCursor,
		},
		lastEventSequence,
		lastEventCursor,
		client: {
			id: clientId ?? "client-1",
			capabilities: (capabilities ?? ["attach_snapshot", "event_sequence"]).filter(
				(capability): capability is DaemonAttachResult["client"]["capabilities"][number] =>
					capability === "attach_snapshot" ||
					capability === "event_sequence" ||
					capability === "extension_ui" ||
					capability === "slim_attach" ||
					capability === "chunked_snapshot",
			),
		},
	};
}

function emitRlmChildUpdate(
	client: FakeDaemonClient,
	activeSessionId: string,
	sequence: number,
	child: AgentConnectionRlmChildAgentSnapshot,
): void {
	client.emitMessage({
		type: "session_event",
		activeSessionId,
		event: { type: "rlm_child_update", child },
		meta: {
			id: `${activeSessionId}:${sequence}`,
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId,
			sequence,
			cursor: { generation: `generation-${activeSessionId}`, sequence },
			emittedAt: "2026-01-01T00:00:00.000Z",
		},
	});
}

function emitSequencedQueueUpdate(client: FakeDaemonClient, activeSessionId: string, sequence: number): void {
	client.emitMessage({
		type: "session_event",
		activeSessionId,
		event: {
			type: "session_action_update",
			actions: { queuedCount: 0, steering: [], followUps: [] },
		},
		meta: {
			id: `${activeSessionId}:${sequence}`,
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId,
			sequence,
			cursor: { generation: `generation-${activeSessionId}`, sequence },
			emittedAt: "2026-01-01T00:00:00.000Z",
		},
	});
}

describe("DaemonAgentConnection", () => {
	it("carries an opt-out-only telemetry policy on attach", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1", {
			telemetryDisabled: true,
		});

		await connection.attach();

		expect(fakeClient.requests[0]).toMatchObject({
			type: "attach",
			activeSessionId: "active-1",
			telemetryDisabled: true,
		});
	});

	it.each([true, false])("capability-gates owned-session recovery context: %s", async (supported) => {
		const fakeClient = new FakeDaemonClient();
		if (supported) fakeClient.serverCapabilities.add("owned_session_recovery_context");
		const recoveryConfig = { cwd: "/tmp/fresh-owner" };
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-owned", {
			ownedSession: true,
			ownedSessionRecoveryConfig: recoveryConfig,
		});

		await connection.attach();

		const request = fakeClient.requests[0];
		if (supported) expect(request).toMatchObject({ recoveryConfig });
		else expect(request).not.toHaveProperty("recoveryConfig");
	});

	it("forwards queueIfBusy for prompt admission", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await connection.prompt("queued input", { streamingBehavior: "followUp", queueIfBusy: true });

		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "prompt",
			activeSessionId: "active-1",
			message: "queued input",
			streamingBehavior: "followUp",
			queueIfBusy: true,
		});
	});

	it("forwards signal-backed prompts with a unique cancellable admission id", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const abort = new AbortController();

		await connection.prompt("startup", { signal: abort.signal, queueIfBusy: true });

		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "prompt",
			activeSessionId: "active-1",
			message: "startup",
			queueIfBusy: true,
			admissionId: expect.stringMatching(/^prompt-admission:/),
		});
	});

	it("cancels rejected signal-backed admission and removes its abort listener", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.promptError = new Error("transport failed");
		fakeClient.cancelPromptAdmissionStatus = "cancelled";
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const abort = new AbortController();
		const add = vi.spyOn(abort.signal, "addEventListener");
		const remove = vi.spyOn(abort.signal, "removeEventListener");

		await expect(connection.prompt("startup", { signal: abort.signal })).rejects.toMatchObject({
			message: "transport failed",
			cancelled: true,
		});
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["prompt", "cancel_prompt_admission"]);
		expect(add).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledOnce();
		expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
	});

	it("preserves a definitive prompt rejection when the signal remains live", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.promptResponseError = "session rejected prompt";
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await expect(connection.prompt("startup", { signal: new AbortController().signal })).rejects.toEqual(
			new Error("session rejected prompt"),
		);
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["prompt"]);
	});

	it("sends zero requests for a pre-aborted prompt", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const abort = new AbortController();
		abort.abort();

		await expect(connection.prompt("startup", { signal: abort.signal })).rejects.toMatchObject({
			status: "cancelled",
		});
		expect(fakeClient.requests).toEqual([]);
	});

	it("accepts a successful prompt response when cancellation reports unknown", async () => {
		const fakeClient = new FakeDaemonClient();
		let releasePrompt = () => {};
		fakeClient.promptGate = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		fakeClient.cancelPromptAdmissionStatus = "unknown";
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const abort = new AbortController();

		const prompt = connection.prompt("startup", { signal: abort.signal });
		abort.abort();
		await vi.waitFor(() =>
			expect(fakeClient.requests.map((request) => request.type)).toContain("cancel_prompt_admission"),
		);
		expect(fakeClient.requests.find((request) => request.type === "cancel_prompt_admission")).not.toHaveProperty(
			"cancelOwned",
		);
		releasePrompt();

		await expect(prompt).resolves.toBeUndefined();
	});

	it("requests owned prompt cancellation when the daemon advertises it", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.serverCapabilities.add("owned_prompt_cancellation");
		let releasePrompt = () => {};
		fakeClient.promptGate = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const abort = new AbortController();

		const prompt = connection.prompt("startup", { signal: abort.signal });
		abort.abort();
		await vi.waitFor(() =>
			expect(fakeClient.requests.map((request) => request.type)).toContain("cancel_prompt_admission"),
		);
		expect(fakeClient.requests.find((request) => request.type === "cancel_prompt_admission")).toMatchObject({
			cancelOwned: true,
		});
		releasePrompt();
		await expect(prompt).resolves.toBeUndefined();
	});

	it("preserves a definitive prompt rejection when cancellation reports owned", async () => {
		const fakeClient = new FakeDaemonClient();
		let releasePrompt = () => {};
		fakeClient.promptGate = new Promise<void>((resolve) => {
			releasePrompt = resolve;
		});
		fakeClient.promptResponseError = "post-ownership validation failed";
		fakeClient.cancelPromptAdmissionStatus = "owned";
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const abort = new AbortController();

		const prompt = connection.prompt("startup", { signal: abort.signal });
		abort.abort();
		await vi.waitFor(() =>
			expect(fakeClient.requests.map((request) => request.type)).toContain("cancel_prompt_admission"),
		);
		releasePrompt();

		await expect(prompt).rejects.toThrow("post-ownership validation failed");
	});

	it("treats a lost prompt response plus unknown cancellation as uncertain", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.promptError = new Error("lost response");
		fakeClient.cancelPromptAdmissionStatus = "unknown";
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await expect(connection.prompt("startup", { signal: new AbortController().signal })).rejects.toMatchObject({
			message: "lost response",
			status: "unknown",
			cancelled: false,
		});
	});

	it("translates unsupported admission cancellation into an admission error", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.promptError = new DaemonCapabilityUnavailableError("prompt", "prompt_admission_cancellation");
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await expect(connection.prompt("startup", { signal: new AbortController().signal })).rejects.toMatchObject({
			status: "unsupported",
		});
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["prompt"]);
	});

	it("uses cancellable admission for promptAndWait", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.promptError = new Error("lost response");
		fakeClient.cancelPromptAdmissionStatus = "cancelled";
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await expect(connection.promptAndWait("wait", { signal: new AbortController().signal })).rejects.toMatchObject({
			status: "cancelled",
		});
		expect(fakeClient.requests.map((request) => request.type)).toEqual([
			"prompt_and_wait",
			"cancel_prompt_admission",
		]);
	});

	it("uses fleet heartbeat scope for residents and session scope for owned workers", async () => {
		const residentClient = new FakeDaemonClient();
		residentClient.serverCapabilities.add("heartbeat_catalog");
		const resident = new DaemonAgentConnection(asDaemonClient(residentClient), "resident-1");
		await resident.listHeartbeats();

		const ownedClient = new FakeDaemonClient();
		ownedClient.serverCapabilities.add("heartbeat_catalog");
		const owned = new DaemonAgentConnection(asDaemonClient(ownedClient), "owned-1", { ownedSession: true });
		await owned.listHeartbeats();

		expect(residentClient.requests.at(-1)).toEqual(expect.objectContaining({ type: "heartbeats_list" }));
		expect(residentClient.requests.at(-1)).not.toHaveProperty("activeSessionId");
		expect(ownedClient.requests.at(-1)).toEqual(
			expect.objectContaining({ type: "heartbeats_list", activeSessionId: "owned-1" }),
		);
	});

	it("serializes concurrent owned-session promotion commands", async () => {
		const fakeClient = new FakeDaemonClient();
		let releaseFirst = () => {};
		fakeClient.cronAddGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1", {
			ownedSession: true,
		});

		const first = connection.addCronJob("0 * * * *", "first");
		const second = connection.addCronJob("30 * * * *", "second");
		await vi.waitFor(() => {
			expect(fakeClient.requests.filter((request) => request.type === "cron_add")).toHaveLength(1);
		});
		releaseFirst();
		await Promise.all([first, second]);

		const commands = fakeClient.requests.filter(
			(command): command is Extract<DaemonCommand, { type: "cron_add" }> => command.type === "cron_add",
		);
		expect(commands.map((command) => command.promoteOwnedSession)).toEqual([true, false]);
	});

	it("gates side-question follow-up transcripts on the daemon capability", async () => {
		const oldDaemonClient = new FakeDaemonClient();
		const oldConnection = new DaemonAgentConnection(asDaemonClient(oldDaemonClient), "active-original");

		// First questions carry no transcript and must keep working on old daemons.
		await oldConnection.startSideQuestion("turn-1", "What changed?");
		expect(oldDaemonClient.requests.map((request) => request.type)).toEqual(["start_side_question"]);

		// Follow-ups would silently lose their side context on an old daemon.
		await expect(
			oldConnection.startSideQuestion("turn-2", "And then?", [{ question: "What changed?", answer: "The parser." }]),
		).rejects.toThrow("older build without side-conversation follow-ups");
		expect(oldDaemonClient.requests).toHaveLength(1);

		const newDaemonClient = new FakeDaemonClient();
		newDaemonClient.serverCapabilities.add("side_question_transcript");
		const newConnection = new DaemonAgentConnection(asDaemonClient(newDaemonClient), "active-original");

		await newConnection.startSideQuestion("turn-2", "And then?", [
			{ question: "What changed?", answer: "The parser." },
		]);
		const sent = newDaemonClient.requests.find(
			(command): command is Extract<DaemonCommand, { type: "start_side_question" }> =>
				command.type === "start_side_question",
		);
		expect(sent?.previousTurns).toEqual([{ question: "What changed?", answer: "The parser." }]);
	});

	it("gates transient bash on the daemon capability", async () => {
		const oldDaemonClient = new FakeDaemonClient();
		const oldConnection = new DaemonAgentConnection(asDaemonClient(oldDaemonClient), "active-original");

		// Regular bash keeps working on old daemons.
		await oldConnection.executeBash("ls");
		expect(oldDaemonClient.requests.map((request) => request.type)).toEqual(["execute_bash"]);

		// A transient run on an old daemon would be recorded into the session.
		await expect(oldConnection.executeBash("ls", { transient: true })).rejects.toThrow(
			"older build without side-conversation bash",
		);
		expect(oldDaemonClient.requests).toHaveLength(1);

		const newDaemonClient = new FakeDaemonClient();
		newDaemonClient.serverCapabilities.add("transient_bash");
		const newConnection = new DaemonAgentConnection(asDaemonClient(newDaemonClient), "active-original");

		await newConnection.executeBash("ls", { excludeFromContext: true, transient: true, runId: "side-run-1" });
		const sent = newDaemonClient.requests.find(
			(command): command is Extract<DaemonCommand, { type: "execute_bash" }> => command.type === "execute_bash",
		);
		expect(sent).toMatchObject({ command: "ls", excludeFromContext: true, transient: true, runId: "side-run-1" });
	});

	it("degrades an unavailable heartbeat catalog without sending an unsupported command", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-original");

		await expect(connection.listHeartbeats()).resolves.toEqual([]);
		expect(fakeClient.requests).toEqual([]);
		await expect(connection.manageHeartbeat("active-original", "job-1", "pause")).rejects.toThrow(
			"requires a newer Prime Agent daemon",
		);
		expect(fakeClient.requests).toEqual([]);
	});

	it("reattaches an open window to its restored session after an update restart", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.emitCloseOnClose = true;
		const restoredMessages: AgentMessage[] = [{ role: "user", content: "restored prompt", timestamp: 2 }];
		fakeClient.updateRestartSessions = [
			{
				id: "active-restored",
				activeSessionId: "active-restored",
				sessionId: "session-current",
				sessionFile: "/tmp/session-current.jsonl",
			},
		];
		fakeClient.attachResultFactory = (command) =>
			createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 1, {
				state: createConnectionState(command.activeSessionId, "session-current"),
				messages: command.activeSessionId === "active-restored" ? restoredMessages : [],
			});
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-original");
		const events: AgentConnectionEvent[] = [];
		const restored = new Promise<AgentConnectionEvent>((resolve) => {
			connection.subscribe((event) => {
				events.push(event);
				if (event.type === "session_resynced") {
					resolve(event);
				}
			});
		});
		await connection.attach();

		fakeClient.emitMessage({
			type: "session_closed",
			activeSessionId: "active-original",
			reason: "update",
		});
		await vi.waitFor(() => {
			expect(fakeClient.closeCount).toBe(1);
			expect(fakeClient.reconnectCount).toBe(1);
		});

		await expect(restored).resolves.toMatchObject({
			type: "session_resynced",
			snapshot: {
				state: { activeSessionId: "active-restored", sessionId: "session-current" },
				messages: restoredMessages,
			},
		});
		expect(fakeClient.reconnectCount).toBe(1);
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach", "list", "attach"]);
		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "attach",
			activeSessionId: "active-restored",
			resumeCursor: undefined,
		});
		await vi.waitFor(() => {
			expect(events).toEqual([
				expect.objectContaining({ type: "connection_status", status: "reconnecting" }),
				expect.objectContaining({
					type: "session_resynced",
					snapshot: expect.objectContaining({
						state: expect.objectContaining({ activeSessionId: "active-restored" }),
					}),
				}),
				{ type: "connection_status", status: "connected" },
			]);
		});
	});

	it("reattaches when an update socket close arrives before the session notice", async () => {
		const fakeClient = new FakeDaemonClient();
		const restoredMessages: AgentMessage[] = [{ role: "user", content: "restored prompt", timestamp: 2 }];
		fakeClient.updateRestartSessions = [
			{
				id: "active-restored",
				activeSessionId: "active-restored",
				sessionId: "session-current",
				sessionFile: "/tmp/session-current.jsonl",
			},
		];
		fakeClient.attachResultFactory = (command) =>
			createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 1, {
				state: createConnectionState(command.activeSessionId, "session-current"),
				messages: command.activeSessionId === "active-restored" ? restoredMessages : [],
			});
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-original");
		const restored = new Promise<AgentConnectionEvent>((resolve) => {
			connection.subscribe((event) => {
				if (event.type === "session_resynced") {
					resolve(event);
				}
			});
		});
		await connection.attach();

		fakeClient.emitClose(new DaemonSocketClosedError("/tmp/prime-agent.sock", "update"));

		await expect(restored).resolves.toMatchObject({
			type: "session_resynced",
			snapshot: {
				state: { activeSessionId: "active-restored", sessionId: "session-current" },
				messages: restoredMessages,
			},
		});
		expect(fakeClient.reconnectCount).toBe(1);
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach", "list", "attach"]);
	});

	it("coordinates one transport reconnect across connections sharing a daemon client", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.emitCloseOnClose = true;
		fakeClient.updateRestartSessions = [
			{
				id: "restored-a",
				activeSessionId: "restored-a",
				sessionId: "session-a",
				sessionFile: "/tmp/session-a.jsonl",
			},
			{
				id: "restored-b",
				activeSessionId: "restored-b",
				sessionId: "session-b",
				sessionFile: "/tmp/session-b.jsonl",
			},
		];
		const sessionIds: Record<string, string> = {
			"active-a": "session-a",
			"active-b": "session-b",
			"restored-a": "session-a",
			"restored-b": "session-b",
		};
		fakeClient.attachResultFactory = (command) =>
			createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 1, {
				state: createConnectionState(command.activeSessionId, sessionIds[command.activeSessionId]!),
			});
		const connectionA = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-a");
		const connectionB = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-b");
		await connectionA.attach();
		await connectionB.attach();
		const restoredA = new Promise<AgentConnectionEvent>((resolve) => {
			connectionA.subscribe((event) => {
				if (event.type === "session_resynced") {
					resolve(event);
				}
			});
		});
		const restoredB = new Promise<AgentConnectionEvent>((resolve) => {
			connectionB.subscribe((event) => {
				if (event.type === "session_resynced") {
					resolve(event);
				}
			});
		});

		fakeClient.emitMessage({ type: "session_closed", activeSessionId: "active-a", reason: "update" });

		await expect(Promise.all([restoredA, restoredB])).resolves.toEqual([
			expect.objectContaining({
				type: "session_resynced",
				snapshot: expect.objectContaining({
					state: expect.objectContaining({ sessionId: "session-a" }),
				}),
			}),
			expect.objectContaining({
				type: "session_resynced",
				snapshot: expect.objectContaining({
					state: expect.objectContaining({ sessionId: "session-b" }),
				}),
			}),
		]);
		expect(fakeClient.closeCount).toBe(1);
		expect(fakeClient.reconnectCount).toBe(1);
	});

	it("does not reconnect after an explicit shutdown session close", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-original");
		const closedEvents: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			if (event.type === "closed") {
				closedEvents.push(event);
			}
		});
		await connection.attach();

		fakeClient.emitMessage({
			type: "session_closed",
			activeSessionId: "active-original",
			reason: "shutdown",
		});
		fakeClient.emitClose(new Error("Daemon socket closed"));
		await Promise.resolve();

		expect(fakeClient.reconnectCount).toBe(0);
		expect(closedEvents).toHaveLength(1);
		expect(closedEvents[0]).toMatchObject({
			type: "closed",
			error: expect.stringContaining("The Prime Agent daemon shut down while this window was attached."),
		});
		const closedError = closedEvents[0]?.type === "closed" ? closedEvents[0].error : undefined;
		expect(closedError).toContain("Session ID: session-current.");
		expect(closedError).toContain("Session file: /tmp/session-current.jsonl.");
		expect(closedError).toContain("Diagnostic log:");
	});

	it("does not infer an update when shutdown closes the socket before the session notice", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-original");
		const closedEvents: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			if (event.type === "closed") {
				closedEvents.push(event);
			}
		});
		await connection.attach();

		fakeClient.emitClose(new DaemonSocketClosedError("/tmp/prime-agent.sock", "shutdown"));
		await Promise.resolve();

		expect(fakeClient.reconnectCount).toBe(0);
		expect(closedEvents).toHaveLength(1);
		const closedError = closedEvents[0]?.type === "closed" ? closedEvents[0].error : undefined;
		expect(closedError).toContain("The Prime Agent daemon shut down while this window was attached.");
	});

	it.each([
		["killed", "The daemon stopped this agent session."],
		["completed", "The daemon closed this agent session after it completed."],
		["replaced", "The daemon replaced this agent session with another session."],
	] as const)("explains a %s session close instead of exposing the raw reason", async (reason, explanation) => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-original");
		const closedEvents: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			if (event.type === "closed") {
				closedEvents.push(event);
			}
		});
		await connection.attach();

		fakeClient.emitMessage({ type: "session_closed", activeSessionId: "active-original", reason });
		await Promise.resolve();

		expect(closedEvents).toHaveLength(1);
		const closedError = closedEvents[0]?.type === "closed" ? closedEvents[0].error : undefined;
		expect(closedError).toContain(explanation);
		expect(closedError).not.toBe(reason);
		expect(closedError).toContain("Session ID: session-current.");
	});

	it("adds recovery and diagnostic context to unexpected daemon disconnects", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-original");
		const closedEvents: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			if (event.type === "closed") {
				closedEvents.push(event);
			}
		});
		await connection.attach();

		fakeClient.emitClose(new Error("ECONNRESET"));
		await Promise.resolve();

		expect(closedEvents).toHaveLength(1);
		const closedError = closedEvents[0]?.type === "closed" ? closedEvents[0].error : undefined;
		expect(closedError).toContain("Lost connection to the Prime Agent daemon. Cause: ECONNRESET");
		expect(closedError).toContain("restart Prime Agent or reopen the session from Agents View");
		expect(closedError).toContain("Session file: /tmp/session-current.jsonl.");
		expect(closedError).toContain("Diagnostic log:");
	});

	it("reports an unannounced clean socket close without treating it as an update", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-original");
		const closedEvents: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			if (event.type === "closed") {
				closedEvents.push(event);
			}
		});
		await connection.attach();

		fakeClient.emitClose(new DaemonSocketClosedError("/tmp/prime-agent.sock"));
		await Promise.resolve();

		expect(fakeClient.reconnectCount).toBe(0);
		expect(closedEvents).toHaveLength(1);
		const closedError = closedEvents[0]?.type === "closed" ? closedEvents[0].error : undefined;
		expect(closedError).toContain("Lost connection to the Prime Agent daemon.");
	});

	it("does not emit a restored session after disposal begins", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.updateRestartSessions = [
			{
				id: "active-restored",
				activeSessionId: "active-restored",
				sessionId: "session-current",
				sessionFile: "/tmp/session-current.jsonl",
			},
		];
		let releaseRestoredAttach: (() => void) | undefined;
		fakeClient.restoredAttachGate = new Promise<void>((resolve) => {
			releaseRestoredAttach = resolve;
		});
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-original");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});
		await connection.attach();

		fakeClient.emitClose(new DaemonSocketClosedError("/tmp/prime-agent.sock", "update"));
		await vi.waitFor(() => {
			expect(
				fakeClient.requests.some(
					(request) => request.type === "attach" && request.activeSessionId === "active-restored",
				),
			).toBe(true);
		});
		await connection.dispose();
		releaseRestoredAttach?.();
		await vi.waitFor(() => {
			expect(fakeClient.restoredAttachCompleted).toBe(1);
		});
		for (let flush = 0; flush < 5; flush++) {
			await Promise.resolve();
		}

		expect(events).toEqual([expect.objectContaining({ type: "connection_status", status: "reconnecting" })]);
		expect(fakeClient.requests.at(-1)).toMatchObject({ type: "detach", activeSessionId: "active-restored" });
	});

	it("returns to normal close handling after update restoration times out", async () => {
		vi.useFakeTimers();
		try {
			const fakeClient = new FakeDaemonClient();
			fakeClient.reconnectError = new Error("daemon unavailable");
			const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-original");
			const closedEvents: AgentConnectionEvent[] = [];
			connection.subscribe((event) => {
				if (event.type === "closed") {
					closedEvents.push(event);
				}
			});
			await connection.attach();

			fakeClient.emitMessage({
				type: "session_closed",
				activeSessionId: "active-original",
				reason: "update",
			});
			await vi.advanceTimersByTimeAsync(120100);

			expect(closedEvents).toHaveLength(1);
			const closedError = closedEvents[0]?.type === "closed" ? closedEvents[0].error : undefined;
			expect(closedError).toContain(
				"The Prime Agent daemon restarted for an update, but this window could not reconnect",
			);
			expect(closedError).toContain("Last error: daemon unavailable");
			expect(closedError).toContain("restart Prime Agent and reopen it from Agents View");
			expect(closedError).toContain("Session ID: session-current.");
			expect(closedError).toContain("Session file: /tmp/session-current.jsonl.");
			expect(closedError).toContain("Diagnostic log:");
			const reconnectCountAfterFailure = fakeClient.reconnectCount;
			fakeClient.emitClose(new Error("Daemon socket closed"));
			await Promise.resolve();

			expect(fakeClient.reconnectCount).toBe(reconnectCountAfterFailure);
			expect(closedEvents).toHaveLength(1);
			await connection.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("reattaches using the replacement session identity after a session switch", async () => {
		const fakeClient = new FakeDaemonClient();
		const restoredMessages: AgentMessage[] = [{ role: "user", content: "switched prompt", timestamp: 3 }];
		fakeClient.updateRestartSessions = [
			{
				id: "active-restored",
				activeSessionId: "active-restored",
				sessionId: "session-next",
				sessionFile: "/tmp/session-next.jsonl",
			},
		];
		fakeClient.attachResultFactory = (command) => {
			const sessionId = command.activeSessionId === "active-restored" ? "session-next" : "session-current";
			return createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 1, {
				state: createConnectionState(command.activeSessionId, sessionId),
				messages: command.activeSessionId === "active-restored" ? restoredMessages : [],
			});
		};
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-original");
		await connection.attach();
		fakeClient.emitMessage({
			type: "session_replaced",
			activeSessionId: "active-original",
			state: createConnectionState("active-original", "session-next"),
			messages: [{ role: "user", content: "switched prompt", timestamp: 2 }],
		});

		const restored = new Promise<AgentConnectionEvent>((resolve) => {
			connection.subscribe((event) => {
				if (event.type === "session_resynced") {
					resolve(event);
				}
			});
		});
		fakeClient.emitMessage({
			type: "session_closed",
			activeSessionId: "active-original",
			reason: "update",
		});
		fakeClient.emitClose(new Error("Daemon socket closed"));

		await expect(restored).resolves.toMatchObject({
			type: "session_resynced",
			snapshot: {
				state: { activeSessionId: "active-restored", sessionId: "session-next" },
				messages: restoredMessages,
			},
		});
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach", "list", "attach"]);
		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "attach",
			activeSessionId: "active-restored",
		});
	});

	it("loads connection state and forwards replacement snapshots through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});
		await connection.attach();

		await expect(connection.getState()).resolves.toMatchObject({
			activeSessionId: "active-1",
			cwd: "/tmp/project",
			sessionId: "session-current",
			sessionName: "session-current name",
			activeToolNames: ["ipython"],
		});

		fakeClient.emitMessage({
			type: "session_replaced",
			activeSessionId: "active-1",
			state: createConnectionState("active-1", "session-next"),
			messages: [{ role: "user", content: "replacement prompt", timestamp: 1 }],
		});
		fakeClient.emitMessage({
			type: "session_replaced",
			activeSessionId: "other",
			state: createConnectionState("other", "ignored"),
			messages: [{ role: "user", content: "ignored", timestamp: 2 }],
		});

		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach"]);
		expect(events).toEqual([
			{
				type: "session_replaced",
				state: expect.objectContaining({
					activeSessionId: "active-1",
					sessionId: "session-next",
					sessionName: "session-next name",
					activeToolNames: ["ipython"],
				}),
				messages: [{ role: "user", content: "replacement prompt", timestamp: 1 }],
			},
		]);
	});

	it("forwards catch-up snapshots as non-destructive resync events", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});
		await connection.attach();
		const messages: AgentMessage[] = [{ role: "user", content: "caught up", timestamp: 2 }];
		const streamingMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "Still reasoning" }],
		} as AgentMessage;
		const snapshot = createAttachResult("active-1", "client-1", undefined, 13, {
			state: { ...createConnectionState("active-1", "session-current"), isStreaming: true },
			messages,
			streamingMessage,
		}).snapshot;

		fakeClient.emitMessage({
			type: "session_resynced",
			activeSessionId: "active-1",
			snapshot,
			meta: {
				id: "active-1:13",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 13,
				cursor: { generation: "generation-active-1", sequence: 13 },
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});

		expect(events).toEqual([
			{
				type: "session_resynced",
				snapshot: expect.objectContaining({
					state: expect.objectContaining({ sessionId: "session-current" }),
					messages,
					streamingMessage,
					lastEventSequence: 13,
				}),
			},
		]);
	});

	it("exposes attach snapshots as the initial connection snapshot", async () => {
		const fakeClient = new FakeDaemonClient();
		const snapshotMessage: AgentMessage = { role: "user", content: "snapshot prompt", timestamp: 1 };
		const messages: AgentMessage[] = [snapshotMessage];
		fakeClient.attachResultFactory = (command) =>
			createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 15, {
				state: createConnectionState(command.activeSessionId, "session-snapshot"),
				messages,
				sessionContext: {
					messages,
					thinkingLevel: "medium",
					serviceTier: "default",
					model: null,
				},
				sessionTree: {
					tree: [
						{
							entry: {
								type: "message",
								id: "user-1",
								parentId: null,
								timestamp: "2026-01-01T00:00:00.000Z",
								message: snapshotMessage,
							},
							children: [],
						},
					],
					leafId: "user-1",
				},
				parent: {
					activeSessionId: "parent-active",
					sessionId: "parent-session",
					nodeId: "parent-node",
					childId: "child-1",
				},
			});
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await connection.attach();

		await expect(connection.getInitialSnapshot()).resolves.toMatchObject({
			state: {
				activeSessionId: "active-1",
				sessionId: "session-snapshot",
			},
			messages,
			sessionContext: {
				messages,
				thinkingLevel: "medium",
				model: null,
			},
			sessionTree: {
				leafId: "user-1",
			},
			parent: {
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				nodeId: "parent-node",
				childId: "child-1",
			},
			lastEventSequence: 15,
			replay: {
				status: "complete",
				toSequence: 15,
			},
		});
		await expect(connection.getState()).resolves.toMatchObject({
			sessionId: "session-snapshot",
		});
		await expect(connection.getMessages()).resolves.toEqual(messages);
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach"]);
	});

	it("preserves the in-flight assistant message when refreshing a stale snapshot", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();
		const streamingMessage: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "partial response" }],
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		fakeClient.emitMessage({
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "message_start", message: streamingMessage },
			meta: {
				id: "active-1:13",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 13,
				cursor: { generation: "generation-active-1", sequence: 13 },
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});

		await expect(connection.getInitialSnapshot()).resolves.toMatchObject({ streamingMessage });
		expect(fakeClient.requests.map((request) => request.type)).toEqual([
			"attach",
			"get_connection_state",
			"get_messages",
			"get_session_context",
		]);
	});

	it("does not stamp independently fetched snapshot data with an event cursor observed mid-fetch", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();
		emitSequencedQueueUpdate(fakeClient, "active-1", 13);
		let releaseState!: () => void;
		fakeClient.connectionStateGate = new Promise<void>((resolveState) => {
			releaseState = resolveState;
		});

		const snapshotPromise = connection.getInitialSnapshot();
		await Promise.resolve();
		emitSequencedQueueUpdate(fakeClient, "active-1", 14);
		releaseState();
		const snapshot = await snapshotPromise;

		expect(snapshot.lastEventCursor).toEqual({ generation: "generation-active-1", sequence: 13 });
		await connection.getState();
		expect(fakeClient.requests.filter((request) => request.type === "get_connection_state")).toHaveLength(2);
	});

	it("times out an attach whose streamed snapshot never completes", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.attachResultFactory = (command) => {
			const result = createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 12);
			return {
				...result,
				snapshotStream: { id: "snapshot-stalled", messageCount: 0, targetChunkBytes: 512 * 1024 },
			};
		};
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1", {
			snapshotTimeoutMs: 10,
		});

		await expect(connection.attach()).rejects.toThrow("Timed out waiting for snapshot snapshot-stalled");
		fakeClient.emitMessage({
			type: "session_snapshot_begin",
			activeSessionId: "active-1",
			snapshotId: "snapshot-stalled",
			snapshot: createAttachResult("active-1", "client-1", undefined, 12).snapshot,
			messageCount: 0,
			targetChunkBytes: 512 * 1024,
		});
		fakeClient.emitMessage({
			type: "session_snapshot_end",
			activeSessionId: "active-1",
			snapshotId: "snapshot-stalled",
			chunkCount: 0,
			lastEventSequence: 12,
		});
		expect((connection as unknown as { snapshotAssemblies: Map<string, unknown> }).snapshotAssemblies.size).toBe(0);
	});

	it("rejects one failed snapshot without interrupting another session on the shared client", async () => {
		const fakeClient = new FakeDaemonClient();
		const sibling = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-2");
		await sibling.attach();
		const siblingEvents: AgentConnectionEvent[] = [];
		sibling.subscribe((event) => {
			siblingEvents.push(event);
		});
		fakeClient.attachResultFactory = (command) => {
			const result = createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 12);
			if (command.activeSessionId !== "active-1") {
				return result;
			}
			const { messages: _messages, ...snapshot } = result.snapshot;
			queueMicrotask(() => {
				fakeClient.emitMessage({
					type: "session_snapshot_begin",
					activeSessionId: command.activeSessionId,
					snapshotId: "snapshot-failed",
					snapshot,
					messageCount: 0,
					targetChunkBytes: 512 * 1024,
				});
				fakeClient.emitMessage({
					type: "session_snapshot_failed",
					activeSessionId: command.activeSessionId,
					snapshotId: "snapshot-failed",
					error: "snapshot encoder failed",
				});
			});
			return {
				...result,
				snapshot: { ...result.snapshot, messages: [] },
				snapshotStream: { id: "snapshot-failed", messageCount: 0, targetChunkBytes: 512 * 1024 },
			};
		};
		const failed = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await expect(failed.attach()).rejects.toThrow("snapshot encoder failed");
		emitSequencedQueueUpdate(fakeClient, "active-2", 13);
		await vi.waitFor(() => expect(siblingEvents).toHaveLength(1));

		expect(siblingEvents[0]).toMatchObject({ type: "session_event", event: { type: "session_action_update" } });
		expect(fakeClient.closeCount).toBe(0);
		await failed.dispose();
		await sibling.dispose();
	});

	it("assembles chunked attach snapshots even when chunks arrive before the attach response continuation", async () => {
		const fakeClient = new FakeDaemonClient();
		const messages: AgentMessage[] = [
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "user", content: "second", timestamp: 2 },
		];
		fakeClient.attachResultFactory = (command) => {
			const full = createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 23, {
				state: createConnectionState(command.activeSessionId, "session-streamed"),
				messages,
			});
			const { messages: _messages, ...snapshotHeader } = full.snapshot;
			queueMicrotask(() => {
				fakeClient.emitMessage({
					type: "session_snapshot_begin",
					activeSessionId: command.activeSessionId,
					snapshotId: "snapshot-streamed",
					snapshot: snapshotHeader,
					messageCount: messages.length,
					targetChunkBytes: 512 * 1024,
				});
				fakeClient.emitMessage({
					type: "session_snapshot_chunk",
					activeSessionId: command.activeSessionId,
					snapshotId: "snapshot-streamed",
					index: 0,
					messages: [messages[0]!],
				});
				fakeClient.emitMessage({
					type: "session_snapshot_chunk",
					activeSessionId: command.activeSessionId,
					snapshotId: "snapshot-streamed",
					index: 1,
					messages: [messages[1]!],
				});
				fakeClient.emitMessage({
					type: "session_snapshot_end",
					activeSessionId: command.activeSessionId,
					snapshotId: "snapshot-streamed",
					chunkCount: 2,
					lastEventSequence: 23,
				});
			});
			return {
				...full,
				snapshot: { ...full.snapshot, messages: [] },
				snapshotStream: {
					id: "snapshot-streamed",
					messageCount: messages.length,
					targetChunkBytes: 512 * 1024,
				},
			};
		};
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});

		await connection.attach();

		await expect(connection.getInitialSnapshot()).resolves.toMatchObject({
			state: { sessionId: "session-streamed" },
			messages,
			lastEventSequence: 23,
		});
		expect(events).toEqual([]);
	});

	it("distinguishes chunked catch-up snapshots from runtime replacements", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});

		const emitSnapshot = (
			purpose: "replacement" | "resync",
			snapshotId: string,
			sequence: number,
			sessionId: string,
		) => {
			const messages: AgentMessage[] = [{ role: "user", content: purpose, timestamp: sequence }];
			const full = createAttachResult("active-1", "client-1", undefined, sequence, {
				state: createConnectionState("active-1", sessionId),
				messages,
			});
			const { messages: _messages, ...snapshot } = full.snapshot;
			fakeClient.emitMessage({
				type: "session_snapshot_begin",
				activeSessionId: "active-1",
				snapshotId,
				snapshot,
				messageCount: messages.length,
				targetChunkBytes: 512 * 1024,
				purpose,
			});
			fakeClient.emitMessage({
				type: "session_snapshot_chunk",
				activeSessionId: "active-1",
				snapshotId,
				index: 0,
				messages,
			});
			fakeClient.emitMessage({
				type: "session_snapshot_end",
				activeSessionId: "active-1",
				snapshotId,
				chunkCount: 1,
				lastEventSequence: sequence,
				lastEventCursor: { generation: "generation-active-1", sequence },
			});
		};

		emitSnapshot("resync", "snapshot-resync", 13, "session-current");
		emitSnapshot("replacement", "snapshot-replacement", 14, "session-next");
		await vi.waitFor(() => expect(events).toHaveLength(2));

		expect(events).toEqual([
			expect.objectContaining({
				type: "session_resynced",
				snapshot: expect.objectContaining({
					state: expect.objectContaining({ sessionId: "session-current" }),
				}),
			}),
			expect.objectContaining({
				type: "session_replaced",
				state: expect.objectContaining({ sessionId: "session-next" }),
			}),
		]);
		expect((connection as unknown as { snapshotAssemblies: Map<string, unknown> }).snapshotAssemblies.size).toBe(0);
	});

	it.each(["replacement", "resync"] as const)(
		"recovers a failed chunked %s snapshot without interrupting a sibling session",
		async (purpose) => {
			const fakeClient = new FakeDaemonClient();
			const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
			const sibling = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-2");
			await Promise.all([connection.attach(), sibling.attach()]);
			const events: AgentConnectionEvent[] = [];
			const siblingEvents: AgentConnectionEvent[] = [];
			connection.subscribe((event) => {
				events.push(event);
			});
			sibling.subscribe((event) => {
				siblingEvents.push(event);
			});
			const recoveredSessionId = purpose === "replacement" ? "session-next" : "session-current";
			fakeClient.connectionStateFactory = (activeSessionId) =>
				createConnectionState(
					activeSessionId,
					activeSessionId === "active-1" ? recoveredSessionId : "session-sibling",
				);
			fakeClient.requests.length = 0;
			const snapshotId = `snapshot-failed-${purpose}`;
			const full = createAttachResult("active-1", "client-1", undefined, 13, {
				state: createConnectionState("active-1", recoveredSessionId),
			});
			const { messages: _messages, ...snapshot } = full.snapshot;
			if (purpose === "replacement") {
				fakeClient.emitMessage({
					type: "session_replaced",
					activeSessionId: "active-1",
					state: createConnectionState("active-1", recoveredSessionId),
					messages: [],
					snapshotFollows: true,
					meta: {
						id: "active-1:13",
						protocol: DAEMON_PROTOCOL_INFO,
						activeSessionId: "active-1",
						sequence: 13,
						cursor: { generation: "generation-active-1", sequence: 13 },
						emittedAt: "2026-01-01T00:00:00.000Z",
					},
				});
			}
			fakeClient.emitMessage({
				type: "session_snapshot_begin",
				activeSessionId: "active-1",
				snapshotId,
				snapshot,
				messageCount: 1,
				targetChunkBytes: 512 * 1024,
				purpose,
			});
			fakeClient.emitMessage({
				type: "session_snapshot_failed",
				activeSessionId: "active-1",
				snapshotId,
				error: `${purpose} snapshot failed`,
			});

			await vi.waitFor(() => expect(events).toHaveLength(1));
			if (purpose === "replacement") {
				expect(events[0]).toMatchObject({
					type: "session_replaced",
					state: { sessionId: recoveredSessionId },
					messages: [{ role: "user", content: "current prompt", timestamp: 4 }],
				});
			} else {
				expect(events[0]).toMatchObject({
					type: "session_resynced",
					snapshot: {
						state: { sessionId: recoveredSessionId },
						messages: [{ role: "user", content: "current prompt", timestamp: 4 }],
					},
				});
			}
			expect(fakeClient.requests.map((request) => request.type)).toEqual([
				"get_connection_state",
				"get_messages",
				"get_session_context",
			]);
			emitSequencedQueueUpdate(fakeClient, "active-2", 13);
			await vi.waitFor(() => expect(siblingEvents).toHaveLength(1));
			expect(siblingEvents[0]).toMatchObject({ type: "session_event", event: { type: "session_action_update" } });
			expect(fakeClient.closeCount).toBe(0);
			expect((connection as unknown as { snapshotAssemblies: Map<string, unknown> }).snapshotAssemblies.size).toBe(
				0,
			);
			await connection.dispose();
			await sibling.dispose();
		},
	);

	it("keeps attach snapshots usable when the daemon omits duplicate session context", async () => {
		const fakeClient = new FakeDaemonClient();
		const messages: AgentMessage[] = [{ role: "user", content: "snapshot prompt", timestamp: 1 }];
		fakeClient.attachResultFactory = (command) =>
			createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 15, {
				state: createConnectionState(command.activeSessionId, "session-snapshot"),
				messages,
				omitSessionContext: true,
			});
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await connection.attach();

		const snapshot = await connection.getInitialSnapshot();
		expect(snapshot).toMatchObject({
			state: {
				activeSessionId: "active-1",
				sessionId: "session-snapshot",
			},
			messages,
			lastEventSequence: 15,
		});
		expect(snapshot.sessionContext).toBeUndefined();
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach"]);

		await expect(connection.getSessionContext()).resolves.toMatchObject({
			messages: [{ role: "user", content: "context prompt", timestamp: 3 }],
		});
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach", "get_session_context"]);
	});

	it("keeps reconnect usable from attach snapshots when replay is unavailable", async () => {
		const fakeClient = new FakeDaemonClient();
		const reconnectedMessages: AgentMessage[] = [{ role: "user", content: "reconnected prompt", timestamp: 2 }];
		let attachCount = 0;
		fakeClient.attachResultFactory = (command) => {
			attachCount++;
			if (attachCount === 1) {
				return createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 12, {
					state: createConnectionState(command.activeSessionId, "session-initial"),
				});
			}
			return createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 20, {
				state: createConnectionState(command.activeSessionId, "session-reconnected"),
				messages: reconnectedMessages,
				sessionContext: {
					messages: reconnectedMessages,
					thinkingLevel: "medium",
					serviceTier: "default",
					model: null,
				},
				replay: {
					status: "unavailable",
					fromSequence: 14,
					toSequence: 20,
					reason: "event_replay_not_available",
				},
			});
		};
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await connection.attach();
		emitSequencedQueueUpdate(fakeClient, "active-1", 14);
		await connection.attach();

		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "attach",
			activeSessionId: "active-1",
			capabilities: ["attach_snapshot", "event_sequence", "extension_ui", "slim_attach", "chunked_snapshot"],
			resumeCursor: {
				activeSessionId: "active-1",
				generation: "generation-active-1",
				sequence: 14,
			},
		});
		await expect(connection.getInitialSnapshot()).resolves.toMatchObject({
			state: {
				sessionId: "session-reconnected",
			},
			messages: reconnectedMessages,
			replay: {
				status: "unavailable",
				fromSequence: 14,
				toSequence: 20,
				reason: "event_replay_not_available",
			},
			lastEventSequence: 20,
		});
		await expect(connection.getState()).resolves.toMatchObject({
			sessionId: "session-reconnected",
		});
		await expect(connection.getMessages()).resolves.toEqual(reconnectedMessages);
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach", "attach"]);
	});

	it("resets a connected transport when reattach fails during supervisor recovery", async () => {
		const fakeClient = new FakeDaemonClient();
		const recoverDaemon = vi.fn(async () => undefined);
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1", {
			recoverDaemon,
			reconnectTimeoutMs: 2000,
		});
		const statuses: string[] = [];
		connection.subscribe((event) => {
			if (event.type === "connection_status") {
				statuses.push(event.status);
			}
		});
		await connection.attach();

		fakeClient.attachFailures = 1;
		fakeClient.connected = false;
		fakeClient.emitClose(new Error("Daemon socket closed"));

		await vi.waitFor(() => expect(statuses).toEqual(["reconnecting", "connected"]));
		expect(recoverDaemon).toHaveBeenCalledTimes(2);
		expect(fakeClient.reconnectCount).toBe(2);
		expect(fakeClient.resetTransportCount).toBe(1);
		expect(fakeClient.requests.filter((request) => request.type === "attach")).toHaveLength(3);
	});

	it("does not reconnect after disposal while daemon recovery is pending", async () => {
		const fakeClient = new FakeDaemonClient();
		let finishRecovery: (() => void) | undefined;
		const recoverDaemon = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishRecovery = resolve;
				}),
		);
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1", {
			recoverDaemon,
			reconnectTimeoutMs: 2000,
		});
		await connection.attach();

		fakeClient.connected = false;
		fakeClient.emitClose(new Error("Daemon socket closed"));
		await vi.waitFor(() => expect(recoverDaemon).toHaveBeenCalledOnce());
		await connection.dispose();
		finishRecovery?.();
		for (let flush = 0; flush < 5; flush++) {
			await Promise.resolve();
		}

		expect(fakeClient.reconnectCount).toBe(0);
	});

	it("isolates subscriber failures during transport recovery", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1", {
			recoverDaemon: async () => undefined,
			reconnectTimeoutMs: 2000,
		});
		const statuses: string[] = [];
		connection.subscribe(async () => {
			throw new Error("broken subscriber");
		});
		connection.subscribe((event) => {
			if (event.type === "connection_status") {
				statuses.push(event.status);
			}
		});
		await connection.attach();

		fakeClient.connected = false;
		fakeClient.emitClose(new Error("Daemon socket closed"));

		await vi.waitFor(() => expect(statuses).toEqual(["reconnecting", "connected"]));
		expect(fakeClient.reconnectCount).toBe(1);
	});

	it("does not let a stalled subscriber block update recovery", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.updateRestartSessions = [
			{
				id: "active-restored",
				activeSessionId: "active-restored",
				sessionId: "session-current",
				sessionFile: "/tmp/session-current.jsonl",
			},
		];
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-original");
		const statuses: string[] = [];
		connection.subscribe(() => new Promise<void>(() => undefined));
		connection.subscribe((event) => {
			if (event.type === "connection_status") {
				statuses.push(event.status);
			}
		});
		await connection.attach();

		fakeClient.emitClose(new DaemonSocketClosedError("/tmp/prime-agent.sock", "update"));

		await vi.waitFor(() => expect(statuses).toEqual(["reconnecting", "connected"]));
		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "attach",
			activeSessionId: "active-restored",
		});
	});

	it.each([true, false])("capability-gates authoritative child-roster reads: %s", async (supported) => {
		const fakeClient = new FakeDaemonClient();
		if (supported) fakeClient.serverCapabilities.add("authoritative_child_roster");
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		const children = connection.getRlmChildSnapshots();
		if (supported) await expect(children).resolves.toEqual([]);
		else await expect(children).rejects.toThrow("authoritative_child_roster");
	});

	it("preserves a newer live child update over an in-flight roster read", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.serverCapabilities.add("authoritative_child_roster");
		let releaseRoster!: () => void;
		fakeClient.rlmChildrenGate = new Promise<void>((resolve) => {
			releaseRoster = resolve;
		});
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		const children = connection.getRlmChildSnapshots();
		emitRlmChildUpdate(fakeClient, "active-1", 13, {
			id: "child-live",
			label: "live child",
			status: "running",
			sessionDir: "/tmp/child-live",
		});
		releaseRoster();

		await expect(children).resolves.toEqual([expect.objectContaining({ id: "child-live", status: "running" })]);
	});

	it("keeps the live child roster after an empty attach snapshot", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.attachResultFactory = (command) =>
			createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 12, { children: [] });
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await connection.attach();
		emitRlmChildUpdate(fakeClient, "active-1", 13, {
			id: "child-live",
			label: "live child",
			status: "running",
			sessionDir: "/tmp/child-live",
		});

		await expect(connection.getInitialSnapshot()).resolves.toMatchObject({
			children: [expect.objectContaining({ id: "child-live", status: "running" })],
		});
	});

	it("refreshes initial snapshots after live events make the cached snapshot stale", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.attachResultFactory = (command) =>
			createAttachResult(command.activeSessionId, command.clientId, command.capabilities, 12, {
				state: createConnectionState(command.activeSessionId, "session-attached"),
				messages: [{ role: "user", content: "attached prompt", timestamp: 1 }],
			});
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");

		await connection.attach();
		emitSequencedQueueUpdate(fakeClient, "active-1", 13);

		const snapshot = await connection.getInitialSnapshot();
		expect(snapshot).toMatchObject({
			state: {
				sessionId: "session-current",
			},
			messages: [{ role: "user", content: "current prompt", timestamp: 4 }],
			sessionContext: {
				messages: [{ role: "user", content: "context prompt", timestamp: 3 }],
			},
		});
		// The session tree is fetched lazily (only when the tree/branch selector is
		// opened), so refreshing the initial snapshot must not request it.
		expect(snapshot.sessionTree).toBeUndefined();
		expect(fakeClient.requests.map((request) => request.type)).toEqual([
			"attach",
			"get_connection_state",
			"get_messages",
			"get_session_context",
		]);
	});

	it("ignores older sequenced events after an attach snapshot", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});

		await connection.attach();
		fakeClient.emitMessage({
			type: "session_replaced",
			activeSessionId: "active-1",
			state: createConnectionState("active-1", "session-old"),
			messages: [{ role: "user", content: "old prompt", timestamp: 1 }],
			meta: {
				id: "active-1:10",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 10,
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});
		fakeClient.emitMessage({
			type: "session_replaced",
			activeSessionId: "active-1",
			state: createConnectionState("active-1", "session-new"),
			messages: [{ role: "user", content: "new prompt", timestamp: 2 }],
			meta: {
				id: "active-1:13",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 13,
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});

		expect(events).toEqual([
			{
				type: "session_replaced",
				state: expect.objectContaining({
					sessionId: "session-new",
				}),
				messages: [{ role: "user", content: "new prompt", timestamp: 2 }],
			},
		]);
		await expect(connection.getState()).resolves.toMatchObject({
			sessionId: "session-new",
		});
	});

	it("sends queue commands through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.serverCapabilities.add("session_input_pause");
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await expect(connection.getQueue()).resolves.toEqual({ steering: ["steer"], followUp: ["follow"] });
		await expect(connection.clearQueue()).resolves.toEqual({ steering: ["cleared"], followUp: [] });
		await expect(connection.abortAndClearQueue()).resolves.toEqual({ steering: ["aborted"], followUp: ["cleared"] });
		const [inputPause, inputPauseAlias] = await Promise.all([
			connection.acquireSessionInputPause("lease-1"),
			connection.acquireSessionInputPause("lease-1"),
		]);
		expect(inputPauseAlias).toBe(inputPause);
		(connection as unknown as { activeSessionId: string }).activeSessionId = "active-2";
		await inputPause.release();
		(connection as unknown as { activeSessionId: string }).activeSessionId = "active-1";
		await connection.waitForIdle();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Test model not found");
		}
		await connection.setScopedModels([{ model, thinkingLevel: "high" }]);

		expect(fakeClient.requests.map((request) => request.type)).toEqual([
			"attach",
			"get_queue",
			"clear_queue",
			"abort_and_clear_queue",
			"acquire_session_input_pause",
			"release_session_input_pause",
			"wait_for_idle",
			"set_scoped_models",
		]);
		expect(fakeClient.requests[1]).toMatchObject({ type: "get_queue", activeSessionId: "active-1" });
		expect(fakeClient.requests[2]).toMatchObject({ type: "clear_queue", activeSessionId: "active-1" });
		expect(fakeClient.requests[3]).toMatchObject({ type: "abort_and_clear_queue", activeSessionId: "active-1" });
		expect(fakeClient.requests[4]).toMatchObject({
			type: "acquire_session_input_pause",
			activeSessionId: "active-1",
			leaseKey: "lease-1",
		});
		expect(fakeClient.requests[5]).toMatchObject({
			type: "release_session_input_pause",
			activeSessionId: "active-1",
			pauseId: "pause-1",
		});
		expect(fakeClient.requests[6]).toMatchObject({ type: "wait_for_idle", activeSessionId: "active-1" });
		expect(fakeClient.requests[7]).toMatchObject({
			type: "set_scoped_models",
			activeSessionId: "active-1",
			scopedModels: [{ model, thinkingLevel: "high" }],
		});

		fakeClient.abortAndClearQueueUnknownCommand = true;
		await expect(connection.abortAndClearQueue()).rejects.toThrow(
			"the daemon is running an older build; restart the daemon and try again",
		);
	});

	it("fails closed when a daemon disconnect invalidates an input pause", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.serverCapabilities.add("session_input_pause");
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});

		const pause = await connection.acquireSessionInputPause("lease-1");
		fakeClient.disconnectForReconnect("shutdown");

		await expect(pause.release()).rejects.toThrow("invalidated by a daemon reconnect");
		await expect(connection.acquireSessionInputPause("lease-1")).rejects.toThrow("connection is closed");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "closed",
				error: expect.stringContaining("fence was invalidated"),
			}),
		);
	});

	it("releases an input pause whose acquisition resolves after disconnect", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.serverCapabilities.add("session_input_pause");
		let releaseAcquire!: () => void;
		fakeClient.inputPauseAcquireGate = new Promise<void>((resolve) => {
			releaseAcquire = resolve;
		});
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		const acquisition = connection.acquireSessionInputPause("lease-1");
		await vi.waitFor(() =>
			expect(fakeClient.requests.some((request) => request.type === "acquire_session_input_pause")).toBe(true),
		);
		fakeClient.disconnectForReconnect("shutdown");
		releaseAcquire();

		await expect(acquisition).rejects.toThrow("acquisition was invalidated by a daemon reconnect");
		expect(fakeClient.requests.filter((request) => request.type === "release_session_input_pause")).toHaveLength(1);
	});

	it("capability-gates the strong RLM completion barrier", async () => {
		const oldDaemonClient = new FakeDaemonClient();
		const oldConnection = new DaemonAgentConnection(asDaemonClient(oldDaemonClient), "active-old");
		await oldConnection.attach();
		await oldConnection.waitForHeadlessCompletion();
		expect(oldDaemonClient.requests.at(-1)).toEqual({
			type: "wait_for_headless_completion",
			activeSessionId: "active-old",
		});
		await expect(oldConnection.waitForHeadlessCompletion({ waitForRlmQuiescence: true })).rejects.toThrow(
			"without RLM quiescence barriers",
		);
		expect(oldDaemonClient.requests.map((request) => request.type)).toEqual([
			"attach",
			"wait_for_headless_completion",
		]);

		const newDaemonClient = new FakeDaemonClient();
		newDaemonClient.serverCapabilities.add("rlm_quiescence_barrier");
		const newConnection = new DaemonAgentConnection(asDaemonClient(newDaemonClient), "active-new");
		await newConnection.attach();
		await newConnection.waitForHeadlessCompletion({ waitForRlmQuiescence: true });
		expect(newDaemonClient.requests.at(-1)).toMatchObject({
			type: "wait_for_headless_completion",
			activeSessionId: "active-new",
			waitForRlmQuiescence: true,
		});
	});

	it("cancels rlm child runs through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await expect(connection.cancelRlmChild("child-1")).resolves.toBe(true);
		await expect(connection.cancelRlmChild("finished-child")).resolves.toBe(false);

		expect(fakeClient.requests[1]).toMatchObject({
			type: "cancel_rlm_child",
			activeSessionId: "active-1",
			childId: "child-1",
		});

		// A daemon from a build that predates the command reports a restart hint
		// instead of the raw protocol error.
		await expect(connection.cancelRlmChild("stale-daemon")).rejects.toThrow(
			"the daemon is running an older build; restart the daemon and try again",
		);
	});

	it("sends bash commands through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await connection.executeBash("echo hi", { excludeFromContext: true });
		await connection.abortBash();

		expect(fakeClient.requests[1]).toMatchObject({
			type: "execute_bash",
			activeSessionId: "active-1",
			command: "echo hi",
			excludeFromContext: true,
		});
		expect(fakeClient.requests[2]).toMatchObject({ type: "abort_bash", activeSessionId: "active-1" });

		// A daemon from a build that predates the command reports a restart hint
		// instead of the raw protocol error.
		await expect(connection.executeBash("stale-daemon")).rejects.toThrow(
			"the daemon is running an older build; restart the daemon and try again",
		);
		fakeClient.abortBashUnknownCommand = true;
		await expect(connection.abortBash()).rejects.toThrow(
			"the daemon is running an older build; restart the daemon and try again",
		);
	});

	it("loads resource snapshots through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await expect(connection.getResourceSnapshot()).resolves.toMatchObject({
			contextFiles: [{ path: "/tmp/AGENTS.md" }],
			skills: [{ name: "demo-skill", filePath: "/tmp/skills/demo-skill/SKILL.md" }],
			diagnostics: { skills: [], prompts: [], extensions: [], themes: [] },
		});

		expect(fakeClient.requests[1]).toMatchObject({
			type: "get_resource_snapshot",
			activeSessionId: "active-1",
		});
	});

	it("capability-gates ACP MCP server replacement", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "session-1");
		expect(connection.supportsAcpMcpServers()).toBe(false);
		await expect(
			connection.replaceAcpMcpServers(
				[
					{
						name: "task",
						type: "http",
						url: "https://task.example/mcp",
						headers: { Authorization: "Bearer task" },
					},
				],
				"owner-a",
			),
		).rejects.toBeInstanceOf(DaemonCapabilityUnavailableError);

		fakeClient.serverCapabilities.add("acp_mcp_servers");
		expect(connection.supportsAcpMcpServers()).toBe(true);
		await connection.releaseAcpMcpServers("owner-a", ["task"]);
		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "replace_acp_mcp_servers",
			ownerId: "owner-a",
			servers: [],
		});
		await connection.dispose();
	});

	it("loads the full model catalog through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		fakeClient.serverCapabilities.add("model_catalog");
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		const catalog = await connection.getModelCatalog();

		expect(catalog.configuredProviders).toEqual(["openai"]);
		expect(catalog.models[0]).toMatchObject({ provider: "openai", id: "gpt-5.1" });
		expect(fakeClient.requests[1]).toMatchObject({
			type: "get_model_catalog",
			activeSessionId: "active-1",
		});
	});

	it("falls back to configured models when the daemon lacks model catalog support", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		const catalog = await connection.getModelCatalog();

		expect(catalog.configuredProviders).toEqual(["openai"]);
		expect(catalog.models[0]).toMatchObject({ provider: "openai", id: "gpt-5.1" });
		expect(fakeClient.requests[1]).toMatchObject({
			type: "get_available_models",
			activeSessionId: "active-1",
		});
	});

	it("loads session context through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();
		fakeClient.emitMessage({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "session_action_update",
				actions: { queuedCount: 0, steering: [], followUps: [] },
			},
			meta: {
				id: "active-1:13",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 13,
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});

		await expect(connection.getSessionContext()).resolves.toEqual({
			messages: [{ role: "user", content: "context prompt", timestamp: 3 }],
			thinkingLevel: "medium",
			model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
		});

		expect(fakeClient.requests[1]).toMatchObject({
			type: "get_session_context",
			activeSessionId: "active-1",
		});
	});

	it("loads session trees through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();
		fakeClient.emitMessage({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "session_action_update",
				actions: { queuedCount: 0, steering: [], followUps: [] },
			},
			meta: {
				id: "active-1:13",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 13,
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});

		await expect(connection.getSessionTree()).resolves.toEqual({
			tree: [
				{
					entry: {
						type: "message",
						id: "user-1",
						parentId: null,
						timestamp: "2026-01-01T00:00:00.000Z",
						message: { role: "user", content: "hello", timestamp: 1 },
					},
					children: [],
				},
			],
			leafId: "user-1",
		});

		expect(fakeClient.requests[1]).toMatchObject({
			type: "get_session_tree",
			activeSessionId: "active-1",
		});
	});

	it("loads serializable tool metadata through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await expect(connection.getToolDefinition("custom_tool")).resolves.toEqual({
			name: "custom_tool",
			label: "custom_tool",
			description: "custom_tool description",
			promptSnippet: "custom_tool prompt",
			promptGuidelines: ["Use custom_tool"],
			parameters: { type: "object" },
			renderShell: "self",
		});

		expect(fakeClient.requests[1]).toMatchObject({
			type: "get_tool_definition",
			activeSessionId: "active-1",
			name: "custom_tool",
		});
	});

	it("forwards daemon session events through the connection boundary", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});
		await connection.attach();

		fakeClient.emitMessage({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "session_action_update",
				actions: { queuedCount: 2, steering: ["interrupt"], followUps: ["later"] },
			},
			meta: {
				id: "active-1:14",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 14,
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});
		fakeClient.emitMessage({
			type: "session_event",
			activeSessionId: "other",
			event: {
				type: "session_action_update",
				actions: { queuedCount: 1, steering: ["ignored"], followUps: [] },
			},
		});

		expect(events).toEqual([
			{
				type: "session_event",
				event: {
					type: "session_action_update",
					actions: { queuedCount: 2, steering: ["interrupt"], followUps: ["later"] },
				},
			},
		]);

		await connection.attach();
		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "attach",
			activeSessionId: "active-1",
			clientId: expect.any(String),
			capabilities: ["attach_snapshot", "event_sequence", "extension_ui", "slim_attach", "chunked_snapshot"],
			resumeCursor: {
				activeSessionId: "active-1",
				generation: "generation-active-1",
				sequence: 14,
			},
		});

		await connection.attach();
		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "attach",
			activeSessionId: "active-1",
			capabilities: ["attach_snapshot", "event_sequence", "extension_ui", "slim_attach", "chunked_snapshot"],
			resumeCursor: {
				activeSessionId: "active-1",
				generation: "generation-active-1",
				sequence: 14,
			},
		});
	});

	it("ignores delayed events from a retired daemon generation", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const steeringUpdates: Array<readonly string[]> = [];
		connection.subscribe((event) => {
			if (event.type === "session_event" && event.event.type === "session_action_update") {
				steeringUpdates.push(event.event.actions.steering);
			}
		});
		await connection.attach();
		const emitQueue = (generation: string, sequence: number, steering: string) => {
			fakeClient.emitMessage({
				type: "session_event",
				activeSessionId: "active-1",
				event: { type: "session_action_update", actions: { queuedCount: 1, steering: [steering], followUps: [] } },
				meta: {
					id: `${generation}:${sequence}`,
					protocol: DAEMON_PROTOCOL_INFO,
					activeSessionId: "active-1",
					sequence,
					cursor: { generation, sequence },
					emittedAt: "2026-01-01T00:00:00.000Z",
				},
			});
		};

		emitQueue("generation-new", 1, "new");
		emitQueue("generation-active-1", 13, "old");
		await vi.waitFor(() => expect(steeringUpdates).toEqual([["new"]]));

		await connection.attach();
		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "attach",
			resumeCursor: { generation: "generation-new", sequence: 1 },
		});
	});

	it("forwards extension UI requests and responses", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});
		await connection.attach();
		expect(fakeClient.requests[0]).toMatchObject({
			type: "attach",
			activeSessionId: "active-1",
			supportsExtensionUi: true,
			clientId: expect.any(String),
			capabilities: ["attach_snapshot", "event_sequence", "extension_ui", "slim_attach", "chunked_snapshot"],
		});

		fakeClient.emitMessage({
			type: "extension_ui_request",
			activeSessionId: "active-1",
			id: "request-1",
			method: "confirm",
			payload: { title: "Confirm", message: "Proceed?" },
		});
		fakeClient.emitMessage({
			type: "extension_ui_request",
			activeSessionId: "other",
			id: "request-2",
			method: "confirm",
			payload: { title: "Ignore", message: "Wrong session" },
		});

		expect(events).toEqual([
			{
				type: "extension_ui_request",
				request: {
					id: "request-1",
					method: "confirm",
					payload: { title: "Confirm", message: "Proceed?" },
				},
			},
		]);

		await connection.respondToExtensionUiRequest("request-1", { confirmed: true });
		expect(fakeClient.requests.at(-1)).toMatchObject({
			type: "extension_ui_response",
			activeSessionId: "active-1",
			requestId: "request-1",
			response: { confirmed: true },
		});
	});

	it("uses an extended timeout for refine requests through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await expect(
			connection.refine({ instructions: "remember this", rollbackId: "refine_previous" }),
		).resolves.toMatchObject({
			id: "refine_daemon",
			appliedEdits: [],
		});

		expect(fakeClient.requests[1]).toMatchObject({
			type: "refine",
			activeSessionId: "active-1",
			instructions: "remember this",
			rollbackId: "refine_previous",
		});
		expect(fakeClient.requests[1]).not.toHaveProperty("global");
		expect(fakeClient.requestTimeouts[0]).toBe(30000);
		expect(fakeClient.requestTimeouts[1]).toBe(DAEMON_REFINE_REQUEST_TIMEOUT_MS);
	});

	it("lists and renames saved sessions through the daemon protocol", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();
		const progress: Array<[number, number]> = [];
		const discovered: AgentConnectionSavedSessionInfo[] = [];

		const sessions = await connection.listSavedSessions("current", {
			onProgress: (loaded, total) => {
				progress.push([loaded, total]);
			},
			onSession: (session) => {
				discovered.push(session);
			},
		});
		await connection.renameSavedSession("/tmp/session-a.jsonl", "Next name");
		await expect(connection.deleteSavedSession("/tmp/session-a.jsonl")).resolves.toEqual({
			ok: true,
			method: "trash",
		});

		expect(sessions).toEqual([
			{
				path: "/tmp/session-a.jsonl",
				id: "session-a",
				cwd: "/tmp",
				name: "Saved session",
				created: new Date("2026-01-01T00:00:00.000Z"),
				modified: new Date("2026-01-02T00:00:00.000Z"),
				messageCount: 2,
				firstMessage: "hello",
				allMessagesText: "hello world",
			},
		]);
		expect(progress).toEqual([
			[1, 2],
			[2, 2],
		]);
		expect(discovered).toEqual(sessions);
		expect(fakeClient.requests[1]).toMatchObject({
			type: "list_saved_sessions",
			activeSessionId: "active-1",
			scope: "current",
		});
		expect(fakeClient.requests[2]).toMatchObject({
			type: "rename_saved_session",
			activeSessionId: "active-1",
			sessionPath: "/tmp/session-a.jsonl",
			name: "Next name",
		});
		expect(fakeClient.requests[3]).toMatchObject({
			type: "delete_saved_session",
			activeSessionId: "active-1",
			sessionPath: "/tmp/session-a.jsonl",
		});
	});

	it("rehydrates daemon recoverable errors for interactive recovery flows", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1");
		await connection.attach();

		await expect(connection.switchSession("/tmp/session.jsonl")).rejects.toBeInstanceOf(MissingSessionCwdError);
		await expect(connection.switchSession("/tmp/session.jsonl")).rejects.toMatchObject({
			issue: {
				sessionFile: "/tmp/session.jsonl",
				sessionCwd: "/tmp/missing",
				fallbackCwd: "/tmp/current",
			},
		});
		await expect(connection.importFromJsonl("/tmp/not-found.jsonl")).rejects.toBeInstanceOf(
			SessionImportFileNotFoundError,
		);
		await expect(connection.importFromJsonl("/tmp/not-found.jsonl")).rejects.toMatchObject({
			filePath: "/tmp/not-found.jsonl",
		});
	});

	it("can close the daemon client when disposed by an owning caller", async () => {
		const fakeClient = new FakeDaemonClient();
		const connection = new DaemonAgentConnection(asDaemonClient(fakeClient), "active-1", {
			closeClientOnDispose: true,
		});
		await connection.attach();

		await connection.dispose();

		expect(fakeClient.requests.at(-1)).toMatchObject({ type: "detach", activeSessionId: "active-1" });
		expect(fakeClient.closeCount).toBe(1);
	});

	it("cleans up daemon client subscriptions when static attach fails", async () => {
		const fakeClient = new FakeDaemonClient();

		await expect(
			DaemonAgentConnection.attach(asDaemonClient(fakeClient), "missing", { closeClientOnDispose: true }),
		).rejects.toThrow("Unknown active session: missing");

		expect(fakeClient.getMessageListenerCount()).toBe(0);
		expect(fakeClient.getCloseListenerCount()).toBe(0);
		expect(fakeClient.requests.map((request) => request.type)).toEqual(["attach", "detach"]);
		expect(fakeClient.closeCount).toBe(1);
	});
});
