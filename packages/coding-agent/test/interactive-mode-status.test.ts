import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ServiceTier } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { emptyGoalState } from "../src/core/goals.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { InProcessAgentConnection } from "../src/modes/agent-connection/in-process-agent-connection.js";
import type {
	AgentConnectionExtensionUiRequest,
	AgentConnectionExtensionUiResponse,
	AgentConnectionModel,
	AgentConnectionModelCatalog,
	AgentConnectionSessionContext,
	AgentConnectionSnapshot,
	AgentConnectionState,
} from "../src/modes/agent-connection/types.js";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { QueueSelection } from "../src/modes/interactive/queue-selection.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createDeferred } from "./suite/scheduling.js";

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

function createConnectionState(overrides: Partial<AgentConnectionState> = {}): AgentConnectionState {
	return {
		activeSessionId: "active-1",
		cwd: "/tmp/project",
		thinkingLevel: "medium",
		serviceTier: "default",
		availableThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "session-1",
		leafId: null,
		autoCompactionEnabled: true,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		compactionCount: 0,
		goal: emptyGoalState(),
		scopedModels: [],
		activeToolNames: ["ipython"],
		contextUsage: undefined,
		...overrides,
	};
}

type RenderSessionContextHarness = {
	pendingTools: Map<string, ToolExecutionComponent>;
	ipythonToolComponents: Map<string, unknown>;
	lateIpythonSentAgentMessages: Map<string, unknown[]>;
	toolOutputExpanded: boolean;
	chatContainer: Container;
	editor: { addToHistory?: (text: string) => void };
	footer: { invalidate: () => void };
	updateEditorBorderColor: () => void;
	resetPendingToolState: () => void;
	preloadToolDefinitions: (toolNames: string[]) => Promise<void>;
	settingsManager: { getShowImages: () => boolean };
	getCachedToolDefinition: () => undefined;
	getCurrentCwd: () => string;
	getRetryAttempt: () => number;
	ui: { requestRender: () => void };
	addMessageToChat: (message: AgentMessage, options?: { populateHistory?: boolean }) => void;
	showWarning: (warningMessage: string) => void;
	connectionState?: AgentConnectionState;
};

type RenderSessionContextOptions = {
	updateFooter?: boolean;
	populateHistory?: boolean;
	clearChat?: boolean;
	limitTranscript?: boolean;
};

const renderSessionContext = (
	InteractiveMode.prototype as unknown as {
		renderSessionContext(
			this: RenderSessionContextHarness,
			sessionContext: AgentConnectionSessionContext,
			options?: RenderSessionContextOptions,
		): Promise<void>;
	}
).renderSessionContext;

function createRenderSessionContextHarness(overrides: Partial<RenderSessionContextHarness> = {}): {
	harness: RenderSessionContextHarness;
	chatContainer: Container;
	addMessageToChat: ReturnType<typeof vi.fn>;
	addToHistory: ReturnType<typeof vi.fn>;
} {
	const chatContainer = overrides.chatContainer ?? new Container();
	const addMessageToChat = vi.fn(() => {
		chatContainer.addChild({ render: () => ["assistant"], invalidate: () => {} });
	});
	const addToHistory = vi.fn();
	const harness: RenderSessionContextHarness = {
		pendingTools: new Map<string, ToolExecutionComponent>(),
		ipythonToolComponents: new Map<string, unknown>(),
		lateIpythonSentAgentMessages: new Map<string, unknown[]>(),
		toolOutputExpanded: false,
		chatContainer,
		editor: { addToHistory },
		footer: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		resetPendingToolState: vi.fn(),
		preloadToolDefinitions: vi.fn(async () => {}),
		settingsManager: { getShowImages: () => true },
		getCachedToolDefinition: () => undefined,
		getCurrentCwd: () => process.cwd(),
		getRetryAttempt: () => 0,
		ui: { requestRender: vi.fn() },
		addMessageToChat,
		showWarning: vi.fn(),
		...overrides,
	};
	Object.setPrototypeOf(harness, InteractiveMode.prototype);
	return { harness, chatContainer, addMessageToChat, addToHistory };
}

function userMessage(content: string, timestamp: number): Extract<AgentMessage, { role: "user" }> {
	return { role: "user", content, timestamp };
}

async function renderMessages(
	harness: RenderSessionContextHarness,
	messages: AgentMessage[],
	options?: RenderSessionContextOptions,
): Promise<void> {
	await renderSessionContext.call(
		harness,
		{ messages, thinkingLevel: "medium", serviceTier: "default", model: null },
		options,
	);
}

describe("InteractiveMode.renderSessionContext", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders only the recent tail for very long initial transcripts", async () => {
		const { harness, chatContainer, addMessageToChat } = createRenderSessionContextHarness();
		const messages = Array.from({ length: 405 }, (_, index) => userMessage(`message ${index}`, index));

		await renderMessages(harness, messages, { limitTranscript: true });

		expect(addMessageToChat).toHaveBeenCalledTimes(400);
		expect(addMessageToChat.mock.calls[0]?.[0]).toMatchObject({ content: "message 5" });
		expect(renderAll(chatContainer)).toContain("Showing latest 400 of 405 messages for faster open.");
	});

	test("keeps equal-timestamp legacy messages after the compaction summary", async () => {
		const { harness, addMessageToChat } = createRenderSessionContextHarness();
		const earlier = userMessage("earlier", 4);
		const summary = {
			role: "compactionSummary",
			summary: "legacy summary",
			tokensBefore: 123,
			timestamp: 5,
		} as AgentMessage;
		const equalLater = userMessage("equal later", 5);

		await renderMessages(harness, [summary, earlier, equalLater]);
		expect(addMessageToChat.mock.calls.map((call) => call[0])).toEqual([earlier, summary, equalLater]);
	});

	test("orders the compaction summary at its exact boundary before bounding the initial transcript", async () => {
		const { harness, addMessageToChat } = createRenderSessionContextHarness();
		const retained = Array.from({ length: 5 }, (_, index) => userMessage(`retained ${index}`, 5));
		const summary = {
			role: "compactionSummary",
			summary: "summary",
			tokensBefore: 123,
			retainedMessageCount: retained.length,
			timestamp: 5,
		} as AgentMessage;
		const later = Array.from({ length: 399 }, (_, index) => userMessage(`later ${index}`, 5));

		await renderMessages(harness, [summary, ...retained, ...later], { limitTranscript: true });

		expect(addMessageToChat).toHaveBeenCalledTimes(400);
		expect(addMessageToChat.mock.calls[0]?.[0]).toBe(summary);
		expect(addMessageToChat.mock.calls[1]?.[0]).toMatchObject({ content: "later 0" });
	});

	test("preserves the full transcript when rebuilding a cleared transcript", async () => {
		const { harness, chatContainer, addMessageToChat } = createRenderSessionContextHarness();
		chatContainer.addChild({ render: () => ["old transcript"], invalidate: () => {} });
		const messages = Array.from({ length: 405 }, (_, index) => userMessage(`message ${index}`, index));

		await renderMessages(harness, messages, { clearChat: true });

		expect(addMessageToChat).toHaveBeenCalledTimes(405);
		expect(addMessageToChat.mock.calls[0]?.[0]).toMatchObject({ content: "message 0" });
		expect(renderAll(chatContainer)).not.toContain("old transcript");
		expect(renderAll(chatContainer)).not.toContain("for faster open");
	});

	test("populates editor history from the full transcript when initial rendering is capped", async () => {
		const { harness, addMessageToChat, addToHistory } = createRenderSessionContextHarness();
		const messages = Array.from({ length: 405 }, (_, index) => userMessage(`message ${index}`, index));

		await renderMessages(harness, messages, { populateHistory: true, limitTranscript: true });

		expect(addMessageToChat).toHaveBeenCalledTimes(400);
		expect(addToHistory).toHaveBeenCalledTimes(405);
		expect(addToHistory.mock.calls[0]?.[0]).toBe("message 0");
		expect(addToHistory.mock.calls.at(-1)?.[0]).toBe("message 404");
	});
});

describe("InteractiveMode connection events", () => {
	type ConnectionEventListener = (event: any) => Promise<void> | void;

	afterEach(() => vi.useRealTimers());

	function createSubscribeHarness(overrides: Record<string, any> = {}): {
		fakeThis: Record<string, any>;
		emit: ConnectionEventListener;
	} {
		let listener: ConnectionEventListener | undefined;
		const fakeThis: Record<string, any> = {
			agentConnection: {
				subscribe: vi.fn((callback: ConnectionEventListener) => {
					listener = callback;
					return vi.fn();
				}),
			},
			sessionEventQueue: Promise.resolve(),
			sessionEventGeneration: 0,
			handleEvent: vi.fn(async () => {}),
			refreshCommandCatalogForCurrentSession: vi.fn(async () => {}),
			renderResyncedSession: vi.fn(async () => {}),
			resetSideQuestion: vi.fn(),
			resetExtensionUI: vi.fn(),
			applyConnectionStateSnapshot: vi.fn(),
			resetCurrentSessionRenderState: vi.fn(),
			rebindCurrentSession: vi.fn(async () => {}),
			renderInitialMessages: vi.fn(async () => {}),
			ui: { requestRender: vi.fn() },
			handleConnectionExtensionUiRequest: vi.fn(),
			showError: vi.fn(),
			...overrides,
		};
		(InteractiveMode.prototype as unknown as { subscribeToAgent(this: unknown): void }).subscribeToAgent.call(
			fakeThis,
		);
		return { fakeThis, emit: (event) => listener?.(event) };
	}

	const callOrder = (mock: unknown): number =>
		(mock as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0] as number;

	const renderResyncedSession = (
		InteractiveMode.prototype as unknown as {
			renderResyncedSession(this: unknown, snapshot: AgentConnectionSnapshot): Promise<void>;
		}
	).renderResyncedSession;

	function createResyncHarness(overrides: Record<string, any> = {}): Record<string, any> {
		const fakeThis: Record<string, any> = {
			applyConnectionStateSnapshot: vi.fn(),
			refreshQueueSelectionFromState: vi.fn(),
			restoreTurnStartFromMessages: vi.fn(),
			replaceSubagentSummary: vi.fn(),
			updateWorkingLoaderMessage: vi.fn(),
			getSessionContextFromConnectionSnapshot: vi.fn(() => ({
				messages: [],
				thinkingLevel: "medium",
				model: null,
			})),
			renderSessionContext: vi.fn(async () => {}),
			restoreStreamingMessageFromSnapshot: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			flushPendingBashComponents: vi.fn(),
			updateTerminalTitle: vi.fn(),
			refreshTopBarCost: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			syncGoalTray: vi.fn(),
			syncWorkingLoader: vi.fn(),
			getGoalState: () => emptyGoalState(),
			isAgentCompacting: () => false,
			isBashRunning: () => false,
			isAgentStreaming: () => false,
			...overrides,
		};
		Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
		return fakeThis;
	}

	test("degrades heartbeat refresh failures while updating the pending display during rebind", async () => {
		const rebindCurrentSession = (
			InteractiveMode.prototype as unknown as { rebindCurrentSession(this: InteractiveMode): Promise<void> }
		).rebindCurrentSession;
		const updatePendingMessagesDisplay = vi.fn();
		const subscribeToAgent = vi.fn();
		const subscribeToRosterBar = vi.fn(async () => {});
		const getState = vi.fn(async () => createConnectionState());
		const harness = {
			unsubscribe: undefined,
			localSessionHost: undefined,
			toolDefinitionCache: { clear: vi.fn() },
			applyRuntimeSettings: vi.fn(),
			bindLocalSessionExtensions: true,
			bindCurrentSessionExtensions: vi.fn(async () => {}),
			subscribeToAgent,
			subscribeToRosterBar,
			agentConnection: { getState },
			patchConnectionState: vi.fn(),
			refreshQueueSelectionFromState: vi.fn(),
			updatePendingMessagesDisplay,
			refreshHeartbeatCatalog: vi.fn(async () => {
				throw new Error("heartbeat unavailable");
			}),
			updateAvailableProviderCount: vi.fn(async () => {}),
			updateEditorBorderColor: vi.fn(),
			updateTerminalTitle: vi.fn(),
			refreshTopBarCost: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			syncGoalTray: vi.fn(),
			syncWorkingLoader: vi.fn(),
			getGoalState: () => emptyGoalState(),
		} as unknown as InteractiveMode;

		await expect(rebindCurrentSession.call(harness)).resolves.toBeUndefined();
		expect(updatePendingMessagesDisplay).toHaveBeenCalledOnce();
		// The queue re-sync must run after subscribing, or updates in the gap are lost.
		expect(getState.mock.invocationCallOrder[0]).toBeGreaterThan(
			subscribeToAgent.mock.invocationCallOrder[0] as number,
		);
	});

	test("clears extension UI and rebinds in order when a connection-backed session is replaced", async () => {
		const { fakeThis, emit } = createSubscribeHarness();
		const state = createConnectionState();

		await emit({ type: "session_replaced", state, messages: [] });

		expect(callOrder(fakeThis.resetExtensionUI)).toBeLessThan(callOrder(fakeThis.applyConnectionStateSnapshot));
		expect(callOrder(fakeThis.applyConnectionStateSnapshot)).toBeLessThan(
			callOrder(fakeThis.resetCurrentSessionRenderState),
		);
		expect(callOrder(fakeThis.resetCurrentSessionRenderState)).toBeLessThan(callOrder(fakeThis.rebindCurrentSession));
		expect(callOrder(fakeThis.rebindCurrentSession)).toBeLessThan(callOrder(fakeThis.renderInitialMessages));
		expect(fakeThis.applyConnectionStateSnapshot).toHaveBeenCalledWith(state);
	});

	test("resynchronizes transcript state without destructive session teardown", async () => {
		const { fakeThis, emit } = createSubscribeHarness();
		const snapshot = { state: createConnectionState(), messages: [] as [] };

		await emit({ type: "session_resynced", snapshot });

		expect(fakeThis.renderResyncedSession).toHaveBeenCalledWith(snapshot);
		// The command catalog must be current before the resynced transcript renders.
		expect(callOrder(fakeThis.refreshCommandCatalogForCurrentSession)).toBeLessThan(
			callOrder(fakeThis.renderResyncedSession),
		);
		expect(fakeThis.resetSideQuestion).not.toHaveBeenCalled();
		expect(fakeThis.resetExtensionUI).not.toHaveBeenCalled();
		expect(fakeThis.resetCurrentSessionRenderState).not.toHaveBeenCalled();
		expect(fakeThis.rebindCurrentSession).not.toHaveBeenCalled();
	});

	test("drops a resync superseded while its command catalog refreshes", async () => {
		const catalogStarted = createDeferred<void>();
		const catalog = createDeferred<void>();
		const { fakeThis, emit } = createSubscribeHarness({
			refreshCommandCatalogForCurrentSession: vi.fn(() => {
				catalogStarted.resolve();
				return catalog.promise;
			}),
		});

		const resync = emit({ type: "session_resynced", snapshot: { state: createConnectionState(), messages: [] } });
		await catalogStarted.promise;
		expect(fakeThis.refreshCommandCatalogForCurrentSession).toHaveBeenCalledOnce();
		const replacement = emit({ type: "session_replaced", state: createConnectionState(), messages: [] });
		catalog.resolve();
		await Promise.all([resync, replacement]);

		expect(fakeThis.renderResyncedSession).not.toHaveBeenCalled();
		expect(fakeThis.renderInitialMessages).toHaveBeenCalledOnce();
	});

	test("drops a queued source event after the session is replaced", async () => {
		let releaseQueue: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});
		const { fakeThis, emit } = createSubscribeHarness({ sessionEventQueue: blocked });

		const staleEvent = emit({ type: "session_event", event: { type: "message_update" } });
		const replacement = emit({ type: "session_replaced", state: createConnectionState() });
		releaseQueue?.();
		await Promise.all([staleEvent, replacement]);

		expect(fakeThis.handleEvent).not.toHaveBeenCalled();
		expect(fakeThis.renderInitialMessages).toHaveBeenCalledOnce();
	});

	test("exits stale queue browsing when a resync replaces the queue snapshot", async () => {
		const queueSelection = new QueueSelection();
		let editorText = "draft";
		queueSelection.move({ steering: [], followUp: ["queued"] }, editorText, -1);
		editorText = "queued";
		const snapshot: AgentConnectionSnapshot = {
			state: createConnectionState({ sessionActions: { queuedCount: 0, steering: [], followUps: [] } }),
			messages: [],
		};
		const fakeThis = createResyncHarness({
			connectionState: createConnectionState({
				sessionActions: { queuedCount: 1, steering: [], followUps: ["queued"] },
			}),
			queueSelection,
			pendingQueueEdit: undefined,
			pendingQueueMove: false,
			isApplyingQueueSelectionText: false,
			editor: {
				getText: () => editorText,
				setText: (text: string) => {
					editorText = text;
				},
			},
		});
		fakeThis.applyConnectionStateSnapshot.mockImplementation((state: AgentConnectionState) => {
			fakeThis.connectionState = state;
		});
		// The real queue re-sync must decide that the browsed entry is gone.
		delete fakeThis.refreshQueueSelectionFromState;

		await renderResyncedSession.call(fakeThis, snapshot);

		expect(queueSelection.isBrowsing).toBe(false);
		expect(editorText).toBe("draft");
	});

	test("preserves client-local work while rendering a resynchronized snapshot", async () => {
		const sideQuestion = { id: "side-1", status: "running" };
		const extensionRequests = new Map([["request-1", { cancelLocal: vi.fn() }]]);
		const activeBashComponent = {};
		const streamingMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "Still reasoning" }],
		} as AgentConnectionSnapshot["streamingMessage"];
		const snapshot: AgentConnectionSnapshot = {
			state: createConnectionState({ isCompacting: true, isBashRunning: true, isStreaming: true }),
			messages: [userMessage("Still working", 100)],
			streamingMessage,
		};
		const startAssistantStreamingMessage = vi.fn();
		const fakeThis = createResyncHarness({
			turnStartedAt: 1,
			workingStartedAt: 1,
			sideQuestionEvent: sideQuestion,
			activeConnectionExtensionUiRequests: extensionRequests,
			activeBashComponent,
			isAgentCompacting: () => true,
			isBashRunning: () => true,
			isAgentStreaming: () => true,
			streamingComponent: {},
			streamingMessage: {},
			getSessionContextFromConnectionSnapshot: vi.fn(() => ({
				messages: snapshot.messages,
				thinkingLevel: "medium",
				model: null,
			})),
			restoreStreamingMessageFromSnapshot: vi.fn((message: AgentConnectionSnapshot["streamingMessage"]) => {
				if (message?.role === "assistant") startAssistantStreamingMessage(message);
			}),
			refreshCommandCatalogForCurrentSession: vi.fn(async () => {}),
		});
		// The real turn-start restore must derive the timers from the snapshot messages.
		delete fakeThis.restoreTurnStartFromMessages;

		await renderResyncedSession.call(fakeThis, snapshot);

		expect(fakeThis.sideQuestionEvent).toBe(sideQuestion);
		expect(fakeThis.activeConnectionExtensionUiRequests).toBe(extensionRequests);
		expect(fakeThis.activeBashComponent).toBe(activeBashComponent);
		expect(fakeThis.renderSessionContext).toHaveBeenCalledWith(expect.anything(), {
			clearChat: true,
			updateFooter: true,
			limitTranscript: true,
		});
		expect(startAssistantStreamingMessage).toHaveBeenCalledWith(streamingMessage);
		expect(fakeThis.turnStartedAt).toBe(100);
		expect(fakeThis.workingStartedAt).toBe(100);
		expect(fakeThis.updateWorkingLoaderMessage).toHaveBeenCalledOnce();
		// A resync render must not re-refresh the catalog the resync handler already refreshed.
		expect(fakeThis.refreshCommandCatalogForCurrentSession).not.toHaveBeenCalled();
	});

	test("finishes local bash UI when a resync proves the operation ended", async () => {
		const bashComponent = { setComplete: vi.fn() };
		const snapshot: AgentConnectionSnapshot = {
			state: createConnectionState({ isCompacting: false, isBashRunning: false, isStreaming: false }),
			messages: [],
		};
		const fakeThis = createResyncHarness({
			activeBashComponent: bashComponent,
			streamingComponent: {},
			streamingMessage: {},
			isAgentCompacting: () => true,
			isBashRunning: () => true,
		});

		await renderResyncedSession.call(fakeThis, snapshot);

		expect(bashComponent.setComplete).toHaveBeenCalledWith(undefined, false);
		expect(fakeThis.activeBashComponent).toBeUndefined();
		expect(fakeThis.flushPendingBashComponents).toHaveBeenCalledOnce();
	});

	test("RES-1306: shows a queued turn's prompt while its own pre-turn compaction holds it in preparing", () => {
		initTheme("dark");
		const queuedMessagesContainer = new Container();
		const fakeThis = createResyncHarness({
			queuedMessagesContainer,
			pendingMessagesContainer: new Container(),
			pendingBashComponents: [],
		});
		delete fakeThis.updatePendingMessagesDisplay;
		const render = (phase: "preparing" | "running") => {
			const active = { kind: "turn" as const, phase, label: "queued before compaction" };
			fakeThis.connectionState = createConnectionState({
				sessionActions: { queuedCount: 0, steering: [], followUps: [], active },
			});
			fakeThis.updatePendingMessagesDisplay();
			return renderAll(queuedMessagesContainer);
		};
		expect(render("preparing")).toContain("queued before compaction");
		expect(render("running")).toBe("");
	});

	test("renderCurrentSessionState waits for replacement handling before rendering", async () => {
		const calls: string[] = [];
		const fakeThis = {
			sessionEventQueue: Promise.resolve().then(() => {
				calls.push("replacement");
			}),
			resetCurrentSessionRenderState: () => calls.push("reset"),
			renderInitialMessages: async () => calls.push("messages"),
			updatePendingMessagesDisplay: () => calls.push("display"),
			syncWorkingLoader: () => calls.push("loader"),
		};

		await (
			InteractiveMode.prototype as unknown as {
				renderCurrentSessionState(this: typeof fakeThis): Promise<void>;
			}
		).renderCurrentSessionState.call(fakeThis);

		expect(calls).toEqual(["replacement", "reset", "messages", "display", "loader"]);
	});

	test("throttles session_status top bar refreshes to one per second; direct refreshes reset the window", async () => {
		vi.useFakeTimers();
		const { fakeThis, emit } = createSubscribeHarness({
			patchConnectionState: vi.fn(),
			renderRecap: vi.fn(),
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			activityTracker: { handleEvent: vi.fn() },
			updateWorkingLoaderMessage: vi.fn(),
			updateTerminalTitle: vi.fn(),
		});
		Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
		const getContextTree = vi.fn(async () => ({ totalUsage: { cost: { total: 5 } } }));
		fakeThis.agentConnection.getContextTree = getContextTree;

		await emit({ type: "session_status", recap: "working" });
		expect(getContextTree).toHaveBeenCalledOnce();
		await emit({ type: "session_status", recap: "still working" });
		expect(getContextTree).toHaveBeenCalledOnce();
		// session_info_changed routes the same throttled refresh through handleEvent's switch.
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: unknown, event: unknown): Promise<void>;
			}
		).handleEvent;
		await handleEvent.call(fakeThis, { type: "session_info_changed" });
		expect(getContextTree).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(1_100);
		await emit({ type: "session_status", recap: "done" });
		expect(getContextTree).toHaveBeenCalledTimes(2);
		(InteractiveMode.prototype as unknown as { refreshTopBarCost(this: unknown): void }).refreshTopBarCost.call(
			fakeThis,
		);
		expect(getContextTree).toHaveBeenCalledTimes(3);
		await emit({ type: "session_status", recap: "again" });
		expect(getContextTree).toHaveBeenCalledTimes(3);
	});
});

describe("InteractiveMode connection extension UI", () => {
	type ActiveConnectionExtensionUiRequest = { cancelLocal(): void };

	type ConnectionExtensionUiCancelHarness = {
		activeConnectionExtensionUiRequests: Map<string, ActiveConnectionExtensionUiRequest>;
		agentConnection: {
			respondToExtensionUiRequest(requestId: string, response: AgentConnectionExtensionUiResponse): Promise<void>;
		};
		showError(message: string): void;
		cancelActiveConnectionExtensionUiRequests(): void;
	};

	type ConnectionExtensionUiHandlerHarness = ConnectionExtensionUiCancelHarness & {
		resolveConnectionExtensionUiRequest(
			request: AgentConnectionExtensionUiRequest,
		): Promise<AgentConnectionExtensionUiResponse | undefined>;
		handleConnectionExtensionUiRequest(request: AgentConnectionExtensionUiRequest): Promise<void>;
	};

	const prototype = InteractiveMode.prototype as unknown as ConnectionExtensionUiHandlerHarness;

	test("reset cancellation responds to active connection UI requests", async () => {
		const cancelLocal = vi.fn();
		const fakeThis = Object.create(InteractiveMode.prototype) as ConnectionExtensionUiCancelHarness;
		fakeThis.activeConnectionExtensionUiRequests = new Map([["request-1", { cancelLocal }]]);
		fakeThis.agentConnection = {
			respondToExtensionUiRequest: vi.fn(async () => {}),
		};
		fakeThis.showError = vi.fn();

		prototype.cancelActiveConnectionExtensionUiRequests.call(fakeThis);
		await Promise.resolve();

		expect(fakeThis.activeConnectionExtensionUiRequests.size).toBe(0);
		expect(cancelLocal).toHaveBeenCalledTimes(1);
		expect(fakeThis.agentConnection.respondToExtensionUiRequest).toHaveBeenCalledWith("request-1", {
			cancelled: true,
		});
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("connection UI handler does not double respond after reset cancellation", async () => {
		const fakeThis = Object.create(InteractiveMode.prototype) as ConnectionExtensionUiHandlerHarness;
		fakeThis.activeConnectionExtensionUiRequests = new Map();
		fakeThis.agentConnection = {
			respondToExtensionUiRequest: vi.fn(async () => {}),
		};
		fakeThis.showError = vi.fn();
		fakeThis.resolveConnectionExtensionUiRequest = vi.fn(
			() =>
				new Promise<AgentConnectionExtensionUiResponse | undefined>(() => {
					// Intentionally left pending until cancellation wins the race.
				}),
		);

		const request: AgentConnectionExtensionUiRequest = {
			id: "request-1",
			method: "select",
			payload: {},
		};
		const handling = prototype.handleConnectionExtensionUiRequest.call(fakeThis, request);
		expect(fakeThis.activeConnectionExtensionUiRequests.size).toBe(1);

		prototype.cancelActiveConnectionExtensionUiRequests.call(fakeThis);
		await handling;

		expect(fakeThis.agentConnection.respondToExtensionUiRequest).toHaveBeenCalledTimes(1);
		expect(fakeThis.agentConnection.respondToExtensionUiRequest).toHaveBeenCalledWith("request-1", {
			cancelled: true,
		});
		expect(fakeThis.activeConnectionExtensionUiRequests.size).toBe(0);
	});
});

function createFakeConnectionSession(commandName: string): AgentSessionRuntime["session"] {
	return {
		extensionRunner: { getRegisteredCommands: () => [] },
		promptTemplates: [
			{
				name: commandName,
				sourceInfo: {
					path: `/${commandName}.md`,
					source: `/${commandName}.md`,
					scope: "project",
					origin: "top-level",
				},
			},
		],
		resourceLoader: {
			getSkills: () => ({ skills: [] }),
			getPrompts: () => ({ prompts: [] }),
			getThemes: () => ({ themes: [] }),
			getExtensions: () => ({ extensions: [], errors: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
		},
		modelRegistry: { refreshModelCatalog: async () => ({ models: [], configuredProviders: [] }) },
		refreshModelMetadata: vi.fn(),
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionDir: () => "/tmp/sessions",
			getLeafId: () => null,
			getEntries: () => [],
		},
		getAvailableThinkingLevels: () => ["medium"],
		getActiveToolNames: () => [],
		getContextUsage: () => undefined,
		thinkingLevel: "medium",
		serviceTier: "default",
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: commandName,
		autoCompactionEnabled: true,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
		goalState: emptyGoalState(),
		scopedModels: [],
		subscribe: () => () => {},
		messages: [],
	} as unknown as AgentSessionRuntime["session"];
}

class EventEmittingReplacementRuntime {
	private rebindSession: Parameters<AgentSessionRuntime["setRebindSession"]>[0];

	constructor(
		public session: AgentSessionRuntime["session"],
		private readonly replacement: AgentSessionRuntime["session"],
	) {}

	setRebindSession(callback?: Parameters<AgentSessionRuntime["setRebindSession"]>[0]): void {
		this.rebindSession = callback;
	}

	setBeforeSessionInvalidate(): void {}

	newSession(): Promise<{ cancelled: boolean }> {
		return this.replaceSession();
	}

	switchSession(): Promise<{ cancelled: boolean }> {
		return this.replaceSession();
	}

	async fork(): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.replaceSession();
	}

	private async replaceSession(): Promise<{ cancelled: boolean }> {
		this.session = this.replacement;
		await this.rebindSession?.(this.replacement);
		return { cancelled: false };
	}
}

describe("InteractiveMode session switch command catalog", () => {
	test.each(["switchSession", "newSession", "fork"] as const)(
		"refreshes the command catalog for an event-emitting in-process %s replacement exactly once before replay",
		async (operation) => {
			const sourceSession = createFakeConnectionSession("source-command");
			const targetSession = createFakeConnectionSession("target-command");
			const runtime = new EventEmittingReplacementRuntime(sourceSession, targetSession);
			const connection = new InProcessAgentConnection(runtime as unknown as AgentSessionRuntime);
			const getCommands = vi.spyOn(connection, "getCommands");
			const calls: string[] = [];
			const fakeThis = {
				agentConnection: connection,
				sessionEventQueue: Promise.resolve(),
				sessionEventGeneration: 0,
				connectionCommands: await connection.getCommands(),
				connectionModelsRefreshVersion: 0,
				bindLocalSessionExtensions: false,
				uiServices: { getThemes: () => [] },
				toolDefinitionCache: { clear: vi.fn() },
				applyRuntimeSettings: vi.fn(),
				applyConnectionModelCatalog: vi.fn(),
				showLoadedResources: vi.fn(),
				refreshHeartbeatCatalog: vi.fn(async () => {}),
				updateAvailableProviderCount: vi.fn(async () => {}),
				updateEditorBorderColor: vi.fn(),
				updateTerminalTitle: vi.fn(),
				refreshTopBarCost: vi.fn(),
				setGoalAnnouncementBaseline: vi.fn(),
				syncGoalTray: vi.fn(),
				getGoalState: () => emptyGoalState(),
				resetSideQuestion: vi.fn(),
				resetExtensionUI: vi.fn(),
				applyConnectionStateSnapshot: vi.fn(),
				resetCurrentSessionRenderState: vi.fn(() => calls.push("reset")),
				queueSelection: { selected: undefined },
				setupAutocompleteProvider: vi.fn(() => calls.push("catalog")),
				renderInitialMessages: vi.fn(async () => {
					calls.push("render");
					expect(fakeThis.connectionCommands.map((command) => command.name)).toEqual(["target-command"]);
				}),
				updatePendingMessagesDisplay: vi.fn(),
				syncWorkingLoader: vi.fn(),
				ui: { requestRender: vi.fn() },
				handleEvent: vi.fn(),
				handleConnectionExtensionUiRequest: vi.fn(),
				showError: vi.fn(),
			};
			Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
			const interactiveHarness = fakeThis as typeof fakeThis & {
				subscribeToAgent(): void;
				renderCurrentSessionState(): Promise<void>;
			};
			interactiveHarness.subscribeToAgent();

			if (operation === "switchSession") await connection.switchSession("/target/session.jsonl");
			else if (operation === "newSession") await connection.newSession();
			else await connection.fork("entry-1");
			expect(fakeThis.showError).not.toHaveBeenCalled();
			await interactiveHarness.renderCurrentSessionState();

			expect(calls).toEqual(["reset", "catalog", "render", "reset", "render"]);
			expect(getCommands).toHaveBeenCalledTimes(2); // initial catalog + one replacement refresh
			expect(targetSession.refreshModelMetadata).toHaveBeenCalledOnce();
		},
	);

	test("keeps catalog refresh failures nonfatal and drops stale dynamic commands", async () => {
		const setupAutocompleteProvider = vi.fn();
		const fakeThis = Object.create(InteractiveMode.prototype) as {
			agentConnection: { getCommands(): Promise<never> };
			connectionCommands: unknown[];
			setupAutocompleteProvider(): void;
			refreshCommandCatalogForCurrentSession(): Promise<void>;
		};
		fakeThis.agentConnection = {
			getCommands: vi.fn(async () => {
				throw new Error("catalog unavailable");
			}),
		};
		fakeThis.connectionCommands = [{ name: "stale-command" }];
		fakeThis.setupAutocompleteProvider = setupAutocompleteProvider;

		await expect(fakeThis.refreshCommandCatalogForCurrentSession()).resolves.toBeUndefined();

		expect(fakeThis.connectionCommands).toEqual([]);
		expect(setupAutocompleteProvider).toHaveBeenCalledOnce();
	});
});

describe("InteractiveMode model catalog staleness", () => {
	type CatalogHarness = {
		agentConnection: {
			getModelCatalog: () => Promise<AgentConnectionModelCatalog>;
			getState: () => Promise<AgentConnectionState>;
			getCommands: () => Promise<unknown[]>;
			getResourceSnapshot: () => Promise<unknown>;
		};
		connectionCommands: unknown[];
		connectionResourceSnapshot: unknown;
		connectionModelCatalog: AgentConnectionModel[];
		connectionConfiguredProviders: Set<string>;
		connectionModelsFetchedAt: number;
		connectionModelsRefreshVersion: number;
		connectionModelsRefreshInFlight: { version: number; promise: Promise<AgentConnectionModel[]> } | undefined;
		uiServices: { modelRegistry: ModelRegistry };
		getScopedModelState(): AgentConnectionState["scopedModels"];
		applyConnectionStateSnapshot(state: AgentConnectionState): void;
		getCachedModelCandidates(): AgentConnectionModel[];
		getAvailableConnectionModels(): AgentConnectionModel[];
		getConnectionAvailableModels(): Promise<AgentConnectionModel[]>;
		findExactModelMatch(searchTerm: string): Promise<AgentConnectionModel | undefined>;
		refreshConnectionCatalog(): Promise<void>;
	};

	const createModel = (provider: string, id: string): AgentConnectionModel =>
		({
			provider,
			id,
			name: id,
			cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		}) as AgentConnectionModel;

	function createCatalogHarness(
		options: {
			connectionModels?: AgentConnectionModel[];
			catalogModels?: AgentConnectionModel[];
			registryModels?: AgentConnectionModel[];
			fetched?: boolean;
			scopedModels?: AgentConnectionState["scopedModels"];
			getModelCatalog?: () => Promise<AgentConnectionModelCatalog>;
			getCommands?: () => Promise<unknown[]>;
		} = {},
	): CatalogHarness {
		const connectionModels = options.connectionModels ?? [];
		const catalogModels = options.catalogModels ?? connectionModels;
		const registryModels = options.registryModels ?? [];
		const modelRegistry = {
			authStorage: AuthStorage.inMemory(),
			refresh: vi.fn(),
			getError: vi.fn(() => undefined),
			getAvailable: vi.fn(() => registryModels),
			hasConfiguredAuth: vi.fn(() => false),
			getProviderAuthStatus: vi.fn(() => ({ configured: false })),
			find: vi.fn((provider: string, modelId: string) =>
				registryModels.find((model) => model.provider === provider && model.id === modelId),
			),
		} as unknown as ModelRegistry;
		const fakeThis = Object.create(InteractiveMode.prototype) as CatalogHarness;
		fakeThis.agentConnection = {
			getModelCatalog:
				options.getModelCatalog ??
				vi.fn(async () => ({
					models: catalogModels,
					configuredProviders: catalogModels.map((model) => model.provider),
				})),
			getState: vi.fn(async () => createConnectionState()),
			getCommands: options.getCommands ?? vi.fn(async () => []),
			getResourceSnapshot: vi.fn(async () => ({})),
			setModel: vi.fn(async () => {}),
		} as never;
		fakeThis.connectionCommands = [];
		fakeThis.connectionResourceSnapshot = undefined;
		fakeThis.connectionModelCatalog = [...connectionModels];
		fakeThis.connectionConfiguredProviders = new Set(connectionModels.map((model) => model.provider));
		fakeThis.connectionModelsFetchedAt = options.fetched ? Date.now() : 0;
		fakeThis.connectionModelsRefreshVersion = 0;
		fakeThis.connectionModelsRefreshInFlight = undefined;
		fakeThis.uiServices = { modelRegistry };
		fakeThis.getScopedModelState = vi.fn(() => options.scopedModels ?? []);
		fakeThis.applyConnectionStateSnapshot = vi.fn();
		return fakeThis;
	}

	test.each([
		{
			label: "refreshes cached candidates for an exact model miss",
			cached: ["alpha"],
			fetched: true,
			registry: [] as string[],
			catalog: ["beta"],
			search: "beta",
			expected: "beta" as string | undefined,
		},
		{
			label: "does not exact-match a local fallback before the daemon catalog loads",
			cached: [] as string[],
			fetched: false,
			registry: ["local-only"],
			catalog: [] as string[],
			search: "local-only",
			expected: undefined as string | undefined,
		},
	])("$label", async ({ cached, fetched, registry, catalog, search, expected }) => {
		const harness = createCatalogHarness({
			connectionModels: cached.map((id) => createModel("openai", id)),
			catalogModels: catalog.map((id) => createModel("openai", id)),
			registryModels: registry.map((id) => createModel("openai", id)),
			fetched,
		});

		await expect(harness.findExactModelMatch(search)).resolves.toEqual(
			expected === undefined ? undefined : expect.objectContaining({ id: expected }),
		);
		expect(harness.agentConnection.getModelCatalog).toHaveBeenCalledTimes(1);
	});

	test("keeps local fallback models out of the cached candidates", () => {
		const harness = createCatalogHarness({ registryModels: [createModel("openai", "local-only")] });

		expect(harness.getCachedModelCandidates()).toEqual([]);
	});

	test("keeps cached daemon models visible with scoped models without refetching", async () => {
		const scoped = createModel("openai", "scoped");
		const cached = createModel("anthropic", "catalog");
		const harness = createCatalogHarness({
			connectionModels: [cached],
			fetched: true,
			scopedModels: [{ model: scoped }],
		});

		expect(harness.getCachedModelCandidates()).toEqual([scoped, cached]);
		await expect(harness.findExactModelMatch("catalog")).resolves.toEqual(cached);
		expect(harness.agentConnection.getModelCatalog).not.toHaveBeenCalled();
	});

	test("does not let a stale model refresh overwrite a newer catalog refresh", async () => {
		const oldModel = createModel("openai", "old");
		const freshModel = createModel("openai", "fresh");
		const oldModels = createDeferred<AgentConnectionModelCatalog>();
		const getModelCatalog = vi
			.fn<() => Promise<AgentConnectionModelCatalog>>()
			.mockImplementationOnce(() => oldModels.promise)
			.mockImplementationOnce(async () => ({ models: [freshModel], configuredProviders: [freshModel.provider] }));
		const harness = createCatalogHarness({ getModelCatalog });

		const staleRefresh = harness.getConnectionAvailableModels();
		await harness.refreshConnectionCatalog();
		oldModels.resolve({ models: [oldModel], configuredProviders: [oldModel.provider] });

		await expect(staleRefresh).resolves.toEqual([freshModel]);
		expect(harness.getAvailableConnectionModels()).toEqual([freshModel]);
	});

	test("keeps the refreshed model catalog when the command catalog fails", async () => {
		const cachedModel = createModel("openai", "cached");
		const freshModel = createModel("openai", "fresh");
		const harness = createCatalogHarness({
			connectionModels: [cachedModel],
			catalogModels: [freshModel],
			fetched: true,
			getCommands: vi.fn(async () => {
				throw new Error("commands unavailable");
			}),
		});

		await expect(harness.refreshConnectionCatalog()).resolves.toBeUndefined();

		expect(harness.connectionCommands).toEqual([]);
		expect(harness.getAvailableConnectionModels()).toEqual([expect.objectContaining({ id: "fresh" })]);
		expect(harness.connectionModelsFetchedAt).toBeGreaterThan(0);
	});
});

describe("InteractiveMode live context usage", () => {
	type LiveContextHarness = {
		connectionState: Pick<AgentConnectionState, "contextUsage"> | undefined;
		activityTracker: { getStatus(): { tokens: number } };
		isAgentStreaming(): boolean;
		contextUsageTokenBaseline: number;
		getConnectionContextUsage(): AgentConnectionState["contextUsage"];
	};
	const prototype = InteractiveMode.prototype as unknown as LiveContextHarness;

	function createHarness(
		opts: { streaming?: boolean; inFlight?: number; baseline?: number } = {},
	): LiveContextHarness {
		const fakeThis = Object.create(InteractiveMode.prototype) as LiveContextHarness;
		fakeThis.connectionState = { contextUsage: undefined };
		fakeThis.activityTracker = { getStatus: () => ({ tokens: opts.inFlight ?? 0 }) };
		fakeThis.isAgentStreaming = () => opts.streaming ?? false;
		fakeThis.contextUsageTokenBaseline = opts.baseline ?? 0;
		return fakeThis;
	}

	const SNAPSHOT = { contextWindow: 100_000, tokens: 42_000, percent: 42 };

	test.each([
		// Idle sessions report the daemon snapshot verbatim.
		{ label: "returns the snapshot verbatim when idle", opts: {}, snapshot: SNAPSHOT, expected: SNAPSHOT },
		{
			label: "adds in-flight streaming output to the snapshot baseline while streaming",
			opts: { streaming: true, inFlight: 3_000 },
			snapshot: SNAPSHOT,
			expected: { contextWindow: 100_000, tokens: 45_000, percent: 45 },
		},
		{
			// Tracker holds 5k from a failed attempt (baseline), now 6k after 1k of the retry:
			// only the 1k generated since the refresh counts as in-flight.
			label: "only adds output beyond the refresh baseline (auto-retry does not double count)",
			opts: { streaming: true, inFlight: 6_000, baseline: 5_000 },
			snapshot: SNAPSHOT,
			expected: { contextWindow: 100_000, tokens: 43_000, percent: 43 },
		},
		{
			label: "does not add in-flight output when not streaming",
			opts: { streaming: false, inFlight: 3_000 },
			snapshot: SNAPSHOT,
			expected: SNAPSHOT,
		},
		{
			label: "passes through an unknown (post-compaction) snapshot without inflating it",
			opts: { streaming: true, inFlight: 3_000 },
			snapshot: { contextWindow: 100_000, tokens: null, percent: null },
			expected: { contextWindow: 100_000, tokens: null, percent: null },
		},
		{
			label: "returns undefined when there is no snapshot yet",
			opts: { streaming: true, inFlight: 3_000 },
			snapshot: undefined,
			expected: undefined,
		},
	])("$label", ({ opts, snapshot, expected }) => {
		const fakeThis = createHarness(opts);
		fakeThis.connectionState = { contextUsage: snapshot as AgentConnectionState["contextUsage"] };

		expect(prototype.getConnectionContextUsage.call(fakeThis)).toEqual(expected);
	});

	type RefreshHarness = {
		agentConnection: { getSessionStats(): Promise<{ contextUsage: unknown } | undefined> };
		connectionState: { sessionId?: string; contextUsage?: unknown };
		activityTracker: { getStatus(): { tokens: number } };
		contextUsageTokenBaseline: number;
		contextUsageRefresh: { generation: number; lastSuccessGeneration: number };
		patchConnectionState(patch: Record<string, unknown>): void;
		refreshConnectionContextUsage(): Promise<void>;
	};
	const refresh = (InteractiveMode.prototype as unknown as RefreshHarness).refreshConnectionContextUsage;

	function createRefreshHarness(
		getSessionStats: RefreshHarness["agentConnection"]["getSessionStats"],
	): RefreshHarness & { patched: Record<string, unknown>[] } {
		const fakeThis = Object.create(InteractiveMode.prototype) as RefreshHarness & {
			patched: Record<string, unknown>[];
		};
		fakeThis.patched = [];
		fakeThis.activityTracker = { getStatus: () => ({ tokens: 0 }) };
		fakeThis.contextUsageTokenBaseline = 0;
		fakeThis.contextUsageRefresh = { generation: 0, lastSuccessGeneration: 0 };
		fakeThis.connectionState = { sessionId: "session-A", contextUsage: undefined };
		fakeThis.patchConnectionState = (patch) => fakeThis.patched.push(patch);
		fakeThis.agentConnection = { getSessionStats };
		return fakeThis;
	}

	test("refreshConnectionContextUsage drops stale stats after a session switch and applies the next refresh", async () => {
		const stale = createDeferred<{ contextUsage: unknown }>();
		const freshContextUsage = { contextWindow: 200_000, tokens: 20_000, percent: 10 };
		const getSessionStats = vi
			.fn<RefreshHarness["agentConnection"]["getSessionStats"]>()
			.mockImplementationOnce(() => stale.promise)
			.mockResolvedValueOnce({ contextUsage: freshContextUsage });
		const fakeThis = createRefreshHarness(getSessionStats);

		const staleRefresh = refresh.call(fakeThis);
		await Promise.resolve();
		fakeThis.connectionState = { sessionId: "session-B", contextUsage: undefined };
		stale.resolve({ contextUsage: { contextWindow: 100_000, tokens: 50_000, percent: 50 } });
		await staleRefresh;

		// Stats belonged to session-A; the next refresh for session-B must still apply normally.
		expect(fakeThis.patched).toEqual([]);
		await refresh.call(fakeThis);
		expect(fakeThis.patched).toEqual([{ contextUsage: freshContextUsage }]);
		expect(getSessionStats).toHaveBeenCalledTimes(2);
	});

	test("refreshConnectionContextUsage keeps a newer successful same-session response", async () => {
		const first = createDeferred<{ contextUsage: unknown }>();
		const second = createDeferred<{ contextUsage: unknown }>();
		let request = 0;
		const fakeThis = createRefreshHarness(() => (++request === 1 ? first.promise : second.promise));

		const olderRefresh = refresh.call(fakeThis);
		const newerRefresh = refresh.call(fakeThis);
		second.resolve({ contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } });
		await newerRefresh;
		first.resolve({ contextUsage: { tokens: 90, contextWindow: 100, percent: 90 } });
		await olderRefresh;

		expect(fakeThis.patched).toEqual([{ contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } }]);
	});

	test.each(["failure", "no stats"] as const)(
		"refreshConnectionContextUsage lets an older successful response survive a newer %s",
		async (newerResult) => {
			const first = createDeferred<{ contextUsage: unknown }>();
			let request = 0;
			const fakeThis = createRefreshHarness(() => {
				if (++request === 1) return first.promise;
				return newerResult === "failure"
					? Promise.reject(new Error("stats unavailable"))
					: Promise.resolve(undefined);
			});

			const olderRefresh = refresh.call(fakeThis);
			await refresh.call(fakeThis);
			first.resolve({ contextUsage: { tokens: 90, contextWindow: 100, percent: 90 } });
			await olderRefresh;

			expect(fakeThis.patched).toEqual([{ contextUsage: { tokens: 90, contextWindow: 100, percent: 90 } }]);
		},
	);
});

describe("InteractiveMode Fast mode concurrency", () => {
	type FastCommandContext = {
		connectionState?: { sessionId: string; serviceTier: ServiceTier; thinkingLevel: ThinkingLevel };
		serviceTierChangeQueue: Promise<void>;
		agentConnection: {
			setServiceTier: (serviceTier: ServiceTier) => Promise<void>;
			getState: () => Promise<{ sessionId: string; serviceTier: ServiceTier }>;
		};
		footer: { invalidate: () => void };
		subagentSummaryLine: { invalidate: () => void };
		showStatus: (message: string) => void;
		showError: (message: string) => void;
		patchConnectionState: (patch: Record<string, unknown>) => void;
		getCurrentModel: () => Model<Api> | undefined;
		currentModelSupportsFastMode: () => boolean;
		getConnectionContextUsage: () => undefined;
		getAvailableServiceTiers: () => ServiceTier[];
		enqueueServiceTierChange: (
			computeTier: () => ServiceTier | undefined,
			formatStatus: (t: ServiceTier) => string,
		) => void;
	};

	type FastInteractiveModePrototype = {
		currentModelSupportsFastMode(this: FastCommandContext): boolean;
		handleFastCommand(this: FastCommandContext): void;
		handleTierCommand(this: FastCommandContext, arg: string): void;
		getAvailableServiceTiers(this: FastCommandContext): ServiceTier[];
		enqueueServiceTierChange(
			this: FastCommandContext,
			computeTier: () => ServiceTier | undefined,
			formatStatus: (serviceTier: ServiceTier) => string,
		): void;
		getModelContextLabel(this: FastCommandContext, maxWidth: number): string;
	};

	const fastInteractiveModePrototype = InteractiveMode.prototype as unknown as FastInteractiveModePrototype;

	function testModel(provider: string, id: string, api: Api): Model<Api> {
		return {
			id,
			name: id,
			api,
			provider,
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
	}

	function makeFastContext(model: Model<Api> = testModel("openai-codex", "gpt-5.5", "openai-codex-responses")) {
		const context: FastCommandContext = {
			connectionState: { sessionId: "session-1", serviceTier: "default", thinkingLevel: "high" },
			serviceTierChangeQueue: Promise.resolve(),
			agentConnection: undefined as never,
			footer: { invalidate: vi.fn() },
			subagentSummaryLine: { invalidate: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			patchConnectionState: vi.fn((patch: Record<string, unknown>) => {
				context.connectionState = { ...context.connectionState, ...patch } as FastCommandContext["connectionState"];
			}),
			getCurrentModel: () => model,
			getConnectionContextUsage: () => undefined,
			currentModelSupportsFastMode: () => fastInteractiveModePrototype.currentModelSupportsFastMode.call(context),
			getAvailableServiceTiers: () => fastInteractiveModePrototype.getAvailableServiceTiers.call(context),
			enqueueServiceTierChange: (computeTier, formatStatus) =>
				fastInteractiveModePrototype.enqueueServiceTierChange.call(context, computeTier, formatStatus),
		};
		context.agentConnection = {
			setServiceTier: vi.fn(async (serviceTier) => {
				context.connectionState = { ...context.connectionState!, serviceTier };
			}),
			getState: vi.fn(async () => ({
				sessionId: context.connectionState!.sessionId,
				serviceTier: context.connectionState!.serviceTier,
			})),
		};
		return context;
	}

	test("serializes rapid toggles and applies both results in order", async () => {
		const context = makeFastContext();
		const firstToggle = createDeferred<void>();
		let toggleCall = 0;
		context.agentConnection.setServiceTier = vi.fn(async (serviceTier) => {
			toggleCall += 1;
			if (toggleCall === 1) await firstToggle.promise;
			context.connectionState = { ...context.connectionState!, serviceTier };
		});

		fastInteractiveModePrototype.handleFastCommand.call(context);
		fastInteractiveModePrototype.handleFastCommand.call(context);
		await Promise.resolve();

		expect(context.agentConnection.setServiceTier).toHaveBeenCalledOnce();
		expect(context.agentConnection.setServiceTier).toHaveBeenCalledWith("priority");

		firstToggle.resolve();
		await context.serviceTierChangeQueue;

		expect(context.agentConnection.setServiceTier).toHaveBeenNthCalledWith(1, "priority");
		expect(context.agentConnection.setServiceTier).toHaveBeenNthCalledWith(2, "default");
		expect(context.patchConnectionState).toHaveBeenNthCalledWith(1, { serviceTier: "priority" });
		expect(context.patchConnectionState).toHaveBeenNthCalledWith(2, { serviceTier: "default" });
		expect(context.showStatus).toHaveBeenNthCalledWith(1, "Fast mode: on");
		expect(context.showStatus).toHaveBeenNthCalledWith(2, "Fast mode: off");
		expect(context.connectionState?.serviceTier).toBe("default");
	});
	test("drops a queued toggle after switching sessions", async () => {
		let releaseQueue!: () => void;
		const context = makeFastContext();
		const originalConnection = context.agentConnection;
		context.serviceTierChangeQueue = new Promise<void>((resolve) => {
			releaseQueue = resolve;
		});

		fastInteractiveModePrototype.handleFastCommand.call(context);
		context.agentConnection = {
			setServiceTier: vi.fn(async () => {}),
			getState: vi.fn(
				async (): Promise<{ sessionId: string; serviceTier: ServiceTier }> => ({
					sessionId: "session-2",
					serviceTier: "default",
				}),
			),
		};
		context.connectionState = { sessionId: "session-2", serviceTier: "default", thinkingLevel: "high" };
		releaseQueue();
		await context.serviceTierChangeQueue;

		expect(originalConnection.setServiceTier).not.toHaveBeenCalled();
		expect(context.agentConnection.setServiceTier).not.toHaveBeenCalled();
	});
	test("does not apply an in-flight toggle result to a replacement session", async () => {
		const toggleStarted = createDeferred<void>();
		const finishToggle = createDeferred<void>();
		const context = makeFastContext();
		const originalConnection = context.agentConnection;
		originalConnection.setServiceTier = vi.fn(() => {
			toggleStarted.resolve();
			return finishToggle.promise;
		});

		fastInteractiveModePrototype.handleFastCommand.call(context);
		await toggleStarted.promise;
		expect(originalConnection.setServiceTier).toHaveBeenCalledWith("priority");

		context.agentConnection = {
			setServiceTier: vi.fn(async () => {}),
			getState: vi.fn(
				async (): Promise<{ sessionId: string; serviceTier: ServiceTier }> => ({
					sessionId: "session-2",
					serviceTier: "default",
				}),
			),
		};
		context.connectionState = { sessionId: "session-2", serviceTier: "default", thinkingLevel: "high" };
		finishToggle.resolve();
		await context.serviceTierChangeQueue;

		expect(context.patchConnectionState).not.toHaveBeenCalled();
		expect(context.showStatus).not.toHaveBeenCalled();
	});

	test.each([
		["openai", "openai-responses", true],
		["openai-codex", "openai-codex-responses", false],
	] as const)("/tier flex on $0 reaches the connection: $2", async (provider, api, reaches) => {
		const context = makeFastContext(testModel(provider, "gpt-5.5", api));

		fastInteractiveModePrototype.handleTierCommand.call(context, "flex");
		await context.serviceTierChangeQueue;

		if (reaches) {
			expect(context.agentConnection.setServiceTier).toHaveBeenCalledWith("flex");
			expect(context.patchConnectionState).toHaveBeenCalledWith({ serviceTier: "flex" });
			expect(context.showError).not.toHaveBeenCalled();
		} else {
			expect(context.agentConnection.setServiceTier).not.toHaveBeenCalled();
			expect(context.patchConnectionState).not.toHaveBeenCalled();
			expect(context.showError).toHaveBeenCalledOnce();
		}
	});
});
