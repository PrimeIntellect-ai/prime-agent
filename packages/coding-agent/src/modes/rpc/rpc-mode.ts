/**
 * RPC mode: headless operation with JSON commands on stdin and JSON responses/events on stdout.
 */

import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import { InProcessAgentConnection } from "../agent-connection/in-process-agent-connection.js";
import type {
	AgentConnection,
	AgentConnectionExtensionUiResponse,
	AgentConnectionSessionWatcher,
} from "../agent-connection/types.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import { createRpcExtensionUiBridge } from "./rpc-extension-ui-context.js";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.js";

export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcObservedSessionEvent,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.js";

interface RpcModeConnectionOptions {
	bindHeadlessExtensions?: (options: {
		uiContext: ReturnType<typeof createRpcExtensionUiBridge>["uiContext"];
		shutdownHandler: () => void;
	}) => Promise<void>;
}

export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	const connection = new InProcessAgentConnection(runtimeHost);
	return runRpcModeWithConnectionInternal(connection, {
		bindHeadlessExtensions: (options) => connection.bindHeadlessExtensions(options),
	});
}

export async function runRpcModeWithConnection(connection: AgentConnection): Promise<never> {
	return runRpcModeWithConnectionInternal(connection);
}

async function runRpcModeWithConnectionInternal(
	connection: AgentConnection,
	options: RpcModeConnectionOptions = {},
): Promise<never> {
	takeOverStdout();
	const output = (value: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(value));
	};
	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse =>
		(data === undefined
			? { id, type: "response", command, success: true }
			: { id, type: "response", command, success: true, data }) as RpcResponse;
	const error = (id: string | undefined, command: string, message: string): RpcResponse => ({
		id,
		type: "response",
		command,
		success: false,
		error: message,
	});

	let shutdownRequested = false;
	let shuttingDown = false;
	let detachInput = () => {};
	let inputEnded = false;
	let promptResponsePending = false;
	let promptCommandTail = Promise.resolve();
	const bufferedConnectionOutputs: object[] = [];
	const pendingConnectionUiRequests = new Set<string>();
	const signalCleanupHandlers: Array<() => void> = [];
	const extensionUi = createRpcExtensionUiBridge(output);
	const observationCommandTails = new Map<string, Promise<void>>();

	interface ActiveObservation {
		watcher: AgentConnectionSessionWatcher;
		unsubscribe: () => void;
		ready: boolean;
		closed: boolean;
		pendingEvents: object[];
	}
	const observations = new Map<string, ActiveObservation>();
	const isDialogMethod = (method: string) =>
		method === "select" || method === "confirm" || method === "input" || method === "editor";

	const outputConnectionEvent = (event: object) => {
		if (promptResponsePending) {
			bufferedConnectionOutputs.push(event);
			return;
		}
		output(event);
	};
	const flushConnectionEvents = () => {
		for (const event of bufferedConnectionOutputs.splice(0)) {
			output(event);
		}
	};
	const stopObservation = async (activeSessionId: string) => {
		const observation = observations.get(activeSessionId);
		if (!observation) return;
		observations.delete(activeSessionId);
		observation.unsubscribe();
		await observation.watcher.close();
	};
	const activateObservation = (activeSessionId: string) => {
		const observation = observations.get(activeSessionId);
		if (!observation || observation.ready) return;
		observation.ready = true;
		for (const event of observation.pendingEvents.splice(0)) {
			outputConnectionEvent(event);
		}
		if (observation.closed) {
			void stopObservation(activeSessionId);
		}
	};

	const unsubscribe = connection.subscribe((event) => {
		if (event.type === "session_event") {
			outputConnectionEvent(event.event);
			return;
		}
		if (event.type === "extension_error") {
			outputConnectionEvent({
				type: "extension_error",
				extensionPath: event.extensionPath,
				event: event.event,
				error: event.error,
			});
			return;
		}
		if (event.type === "extension_ui_request") {
			const method = event.request.method === "setEditorText" ? "set_editor_text" : event.request.method;
			if (inputEnded && isDialogMethod(method)) {
				void connection.respondToExtensionUiRequest(event.request.id, { cancelled: true }).catch(() => undefined);
				return;
			}
			if (
				method === "select" ||
				method === "confirm" ||
				method === "input" ||
				method === "editor" ||
				method === "notify" ||
				method === "setStatus" ||
				method === "setWidget" ||
				method === "setTitle" ||
				method === "set_editor_text"
			) {
				if (isDialogMethod(method)) {
					pendingConnectionUiRequests.add(event.request.id);
				}
				output({
					type: "extension_ui_request",
					id: event.request.id,
					method,
					...event.request.payload,
				});
			}
			return;
		}
		if (event.type === "closed") {
			void shutdown(event.error ? 1 : 0);
		}
	});

	const cancelPendingExtensionUi = async () => {
		extensionUi.close();
		const requestIds = [...pendingConnectionUiRequests];
		pendingConnectionUiRequests.clear();
		await Promise.allSettled(requestIds.map((id) => connection.respondToExtensionUiRequest(id, { cancelled: true })));
	};

	async function shutdown(exitCode = 0): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		await cancelPendingExtensionUi();
		for (const cleanup of signalCleanupHandlers) cleanup();
		unsubscribe();
		detachInput();
		process.stdin.pause();
		await Promise.allSettled([...observations.keys()].map((activeSessionId) => stopObservation(activeSessionId)));
		await connection.dispose();
		process.exit(exitCode);
	}

	for (const signal of ["SIGTERM", ...(process.platform === "win32" ? [] : ["SIGHUP"])] as NodeJS.Signals[]) {
		const handler = () => {
			killTrackedDetachedChildren();
			void shutdown(signal === "SIGHUP" ? 129 : 143);
		};
		process.on(signal, handler);
		signalCleanupHandlers.push(() => process.off(signal, handler));
	}

	if (options.bindHeadlessExtensions) {
		await options.bindHeadlessExtensions({
			uiContext: extensionUi.uiContext,
			shutdownHandler: () => {
				shutdownRequested = true;
			},
		});
	}

	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;
		switch (command.type) {
			case "prompt":
				await connection.prompt(command.message, {
					images: command.images,
					streamingBehavior: command.streamingBehavior,
					source: "rpc",
				});
				return success(id, command.type);
			case "steer":
				await connection.steer(command.message, command.images);
				return success(id, command.type);
			case "follow_up":
				await connection.followUp(command.message, command.images);
				return success(id, command.type);
			case "abort":
				await connection.abort();
				return success(id, command.type);
			case "new_session":
				return success(
					id,
					command.type,
					await connection.newSession(
						command.parentSession ? { parentSession: command.parentSession } : undefined,
					),
				);
			case "get_state": {
				const state = await connection.getState();
				const rpcState: RpcSessionState = {
					model: state.model,
					thinkingLevel: state.thinkingLevel,
					isStreaming: state.isStreaming,
					isCompacting: state.isCompacting,
					steeringMode: state.steeringMode,
					followUpMode: state.followUpMode,
					sessionFile: state.sessionFile,
					sessionId: state.sessionId,
					sessionName: state.sessionName,
					autoCompactionEnabled: state.autoCompactionEnabled,
					messageCount: state.messageCount,
					sessionActions: state.sessionActions,
					goal: state.goal,
				};
				return success(id, command.type, rpcState);
			}
			case "set_model":
				return success(id, command.type, await connection.setModel(command.provider, command.modelId));
			case "cycle_model":
				return success(id, command.type, (await connection.cycleModel()) ?? null);
			case "get_available_models":
				return success(id, command.type, { models: await connection.getAvailableModels() });
			case "set_thinking_level":
				await connection.setThinkingLevel(command.level);
				return success(id, command.type);
			case "cycle_thinking_level": {
				const level = await connection.cycleThinkingLevel();
				return success(id, command.type, level ? { level } : null);
			}
			case "set_steering_mode":
				await connection.setSteeringMode(command.mode);
				return success(id, command.type);
			case "set_follow_up_mode":
				await connection.setFollowUpMode(command.mode);
				return success(id, command.type);
			case "compact":
				return success(id, command.type, await connection.compact(command.customInstructions));
			case "refine":
				return success(
					id,
					command.type,
					await connection.refine({
						instructions: command.instructions,
						rollbackId: command.rollbackId,
						global: command.global,
					}),
				);
			case "set_auto_compaction":
				await connection.setAutoCompactionEnabled(command.enabled);
				return success(id, command.type);
			case "set_auto_retry":
				await connection.setAutoRetryEnabled(command.enabled);
				return success(id, command.type);
			case "abort_retry":
				await connection.abortRetry();
				return success(id, command.type);
			case "bash":
				return success(id, command.type, await connection.executeBashAndWait(command.command));
			case "abort_bash":
				await connection.abortBash();
				return success(id, command.type);
			case "get_session_stats":
				return success(id, command.type, await connection.getSessionStats());
			case "export_html":
				return success(id, command.type, { path: await connection.exportToHtml(command.outputPath) });
			case "switch_session":
				return success(id, command.type, await connection.switchSession(command.sessionPath));
			case "fork": {
				const result = await connection.fork(command.entryId);
				return success(id, command.type, { text: result.selectedText, cancelled: result.cancelled });
			}
			case "clone": {
				const { leafId } = await connection.getSessionTree();
				if (!leafId) return error(id, command.type, "Cannot clone session: no current entry selected");
				const result = await connection.fork(leafId, { position: "at" });
				return success(id, command.type, { cancelled: result.cancelled });
			}
			case "get_fork_messages":
				return success(id, command.type, { messages: await connection.getUserMessagesForForking() });
			case "get_last_assistant_text":
				return success(id, command.type, { text: await connection.getLastAssistantText() });
			case "set_session_name": {
				const name = command.name.trim();
				if (!name) return error(id, command.type, "Session name cannot be empty");
				await connection.setSessionName(name);
				return success(id, command.type);
			}
			case "get_messages":
				return success(id, command.type, { messages: await connection.getMessages() });
			case "send_message":
				return success(
					id,
					command.type,
					await connection.sendAgentMessage(command.targetActiveSessionId, command.message),
				);
			case "agent_messages_status":
				return success(id, command.type, await connection.getAgentMessageStatus());
			case "agent_messages_pause":
				return success(id, command.type, await connection.pauseAgentMessages());
			case "agent_messages_resume":
				return success(id, command.type, await connection.resumeAgentMessages());
			case "agent_messages_clear":
				return success(id, command.type, { cleared: await connection.clearAgentMessages() });
			case "list_schedules":
				return success(id, command.type, {
					jobs: await connection.listCronJobs({ includeInactive: command.includeInactive }),
				});
			case "add_schedule":
				return success(id, command.type, {
					job: await connection.addCronJob(command.schedule, command.prompt),
				});
			case "cancel_schedule":
				return success(id, command.type, { job: await connection.cancelCronJob(command.jobId) });
			case "list_heartbeats":
				return success(id, command.type, { heartbeats: await connection.listHeartbeats() });
			case "get_heartbeat":
				return success(id, command.type, { heartbeat: (await connection.getHeartbeat()) ?? null });
			case "set_heartbeat":
				return success(id, command.type, {
					heartbeat: await connection.setHeartbeat(command.schedule, command.prompt, command.deliveryMode),
				});
			case "update_heartbeat":
				return success(id, command.type, {
					heartbeat: (await connection.updateHeartbeat(command.action)) ?? null,
				});
			case "manage_heartbeat":
				return success(id, command.type, {
					heartbeat: await connection.manageHeartbeat(command.activeSessionId, command.jobId, command.action),
				});
			case "observe": {
				const existing = observations.get(command.activeSessionId);
				if (existing) {
					return success(id, command.type, { messages: await existing.watcher.getMessages() });
				}
				const watcher = await connection.watchSession(command.activeSessionId);
				if (!watcher) throw new Error(`Unknown active session: ${command.activeSessionId}`);
				const observation: ActiveObservation = {
					watcher,
					unsubscribe: () => {},
					ready: false,
					closed: false,
					pendingEvents: [],
				};
				observations.set(command.activeSessionId, observation);
				observation.unsubscribe = watcher.subscribe((event) => {
					let observed: object | undefined;
					if (event.type === "session_event") {
						observed = {
							type: "observed_session_event",
							activeSessionId: command.activeSessionId,
							event: event.event,
						};
					} else if (event.type === "closed") {
						observed = {
							type: "observed_session_closed",
							activeSessionId: command.activeSessionId,
							error: event.error,
						};
						observation.closed = true;
					}
					if (!observed) return;
					if (observation.ready) {
						outputConnectionEvent(observed);
						if (observation.closed) void stopObservation(command.activeSessionId);
					} else {
						observation.pendingEvents.push(observed);
					}
				});
				try {
					return success(id, command.type, { messages: await watcher.getMessages() });
				} catch (observationError) {
					await stopObservation(command.activeSessionId);
					throw observationError;
				}
			}
			case "unobserve":
				await stopObservation(command.activeSessionId);
				return success(id, command.type);
			case "get_commands": {
				const commands: RpcSlashCommand[] = (await connection.getCommands()).map((available) => ({
					name: available.name,
					description: available.description,
					source: available.source,
					sourceInfo: available.sourceInfo,
				}));
				return success(id, command.type, { commands });
			}
			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			return;
		}
		if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || typeof parsed.type !== "string") {
			output(error(undefined, "parse", "Invalid command: expected an object with a string type"));
			return;
		}

		if (parsed.type === "extension_ui_response") {
			const response = parsed as RpcExtensionUIResponse;
			if (extensionUi.handleResponse(response)) return;
			pendingConnectionUiRequests.delete(response.id);
			const daemonResponse: AgentConnectionExtensionUiResponse =
				"cancelled" in response && response.cancelled
					? { cancelled: true }
					: "value" in response
						? { value: response.value }
						: { confirmed: "confirmed" in response && response.confirmed };
			await connection.respondToExtensionUiRequest(response.id, daemonResponse).catch(() => undefined);
			return;
		}

		const command = parsed as RpcCommand;
		const executeCommand = async () => {
			const isPrompt = command.type === "prompt";
			if (isPrompt) promptResponsePending = true;
			try {
				output(await handleCommand(command));
				if (command.type === "observe") activateObservation(command.activeSessionId);
			} catch (commandError: unknown) {
				output(
					error(
						command.id,
						command.type,
						commandError instanceof Error ? commandError.message : String(commandError),
					),
				);
			} finally {
				if (isPrompt) {
					promptResponsePending = false;
					flushConnectionEvents();
				}
			}
			if (shutdownRequested) await shutdown();
		};
		if (command.type === "observe" || command.type === "unobserve") {
			const previous = observationCommandTails.get(command.activeSessionId) ?? Promise.resolve();
			const ordered = previous.then(executeCommand, executeCommand);
			const tail = ordered.then(
				() => undefined,
				() => undefined,
			);
			observationCommandTails.set(command.activeSessionId, tail);
			await ordered;
			if (observationCommandTails.get(command.activeSessionId) === tail) {
				observationCommandTails.delete(command.activeSessionId);
			}
			return;
		}
		if (command.type === "prompt") {
			const ordered = promptCommandTail.then(executeCommand, executeCommand);
			promptCommandTail = ordered.then(
				() => undefined,
				() => undefined,
			);
			await ordered;
			return;
		}
		await executeCommand();
	};

	const pendingInputHandlers = new Set<Promise<void>>();
	const dispatchInputLine = (line: string) => {
		const pending = handleInputLine(line).finally(() => pendingInputHandlers.delete(pending));
		pendingInputHandlers.add(pending);
	};
	const onInputEnd = () => {
		inputEnded = true;
		detachInput();
		process.stdin.pause();
		queueMicrotask(() => {
			void cancelPendingExtensionUi()
				.then(() => Promise.allSettled([...pendingInputHandlers]))
				.then(() => connection.waitForIdle())
				.then(
					() => shutdown(),
					() => shutdown(1),
				);
		});
	};
	process.stdin.on("end", onInputEnd);
	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, dispatchInputLine);
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	return new Promise(() => {});
}
