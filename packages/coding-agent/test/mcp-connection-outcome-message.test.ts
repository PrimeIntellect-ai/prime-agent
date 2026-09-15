import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { type Component, Container, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpConnectionStore } from "../src/core/mcp/connection-store.js";
import {
	convertToLlm,
	createMcpConnectionOutcomeMessage,
	formatMcpConnectionOutcomeNotice,
	isMcpConnectionOutcomeMessage,
	MCP_CONNECTION_OUTCOME_CUSTOM_TYPE,
} from "../src/core/messages.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import {
	MalformedMcpConnectionOutcomeMessageComponent,
	McpConnectionOutcomeMessageComponent,
} from "../src/modes/interactive/components/mcp-connection-outcome-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

// The connect flows verify through the real verifyMcpConnection seam; the
// emit-site tests pin each outcome variant by controlling it directly.
const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("../src/core/mcp/service-catalog.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/mcp/service-catalog.js")>();
	return { ...actual, verifyMcpConnection: verifyMock };
});

function callPrivate<TThis extends object, TResult>(name: string, self: TThis, ...args: unknown[]): TResult {
	const method = (InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => TResult>)[name];
	return method.apply(self, args);
}

function rendered(component: Component): string {
	return stripAnsi(component.render(120).join("\n"))
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

/** Wrapping-aware contains: collapsed bodies wrap across rendered lines. */
function flat(component: Component): string {
	return rendered(component).replace(/\s+/g, " ").trim();
}

function outcomeComponent(details: Parameters<typeof createMcpConnectionOutcomeMessage>[0]) {
	return new McpConnectionOutcomeMessageComponent(createMcpConnectionOutcomeMessage(details));
}

const connected = {
	label: "Linear",
	source: "login",
	verification: "connected",
	toolCount: 12,
	activation: "active",
} as const;

describe("McpConnectionOutcomeMessageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders the connected outcome like a harness refinement: purple diamond header, soft body", () => {
		const component = outcomeComponent(connected);
		const output = rendered(component);
		const lines = output.split("\n");
		expect(lines.filter((line) => line.trim()).map((line) => line.trimEnd())).toEqual([
			" ◆ Connected Linear · 12 tools verified",
			" Connected Linear (12 tools verified).",
		]);
		const raw = component.render(120).join("\n");
		expect(raw).toContain(theme.fg("refinementHeader", "◆ Connected Linear · 12 tools verified"));
		expect(raw).toContain(theme.fg("refinementSummary", " Connected Linear (12 tools verified)."));
		expect(raw).not.toContain("Ctrl+O");
	});

	test("keeps the diamond header for unverified, unsaved, and tool-count-less outcomes", () => {
		expect(rendered(outcomeComponent({ ...connected, toolCount: undefined }))).toContain("◆ Connected Linear");
		const unverified = outcomeComponent({
			label: "Linear",
			source: "retry",
			verification: "unverified",
			issue: "the endpoint rejected the stored credentials (reconnect)",
			activation: "active",
		});
		expect(rendered(unverified)).toContain("◆ Verification did not complete · Linear saved");
		expect(flat(unverified)).toContain(
			"Verification did not complete: the endpoint rejected the stored credentials (reconnect). The connection is saved; retry from /plugins.",
		);
		const unsaved = outcomeComponent({
			label: "Linear",
			source: "retry",
			verification: "unsaved",
			activation: "active",
		});
		expect(rendered(unsaved)).toContain("◆ Verification result not recorded · Linear saved");
		expect(flat(unsaved)).toContain(
			"The verification result could not be saved. The connection is saved; retry from /plugins.",
		);
	});

	test("carries the existing saved-but-unverified login wording and the account prefix", () => {
		const component = outcomeComponent({
			label: "Acme (acme-2)",
			source: "login",
			verification: "unverified",
			issue: "the endpoint did not respond in time",
			connectionId: "acme-2",
			addedAccount: true,
			activation: "active",
		});
		expect(rendered(component)).toContain("◆ Verification did not complete · Acme (acme-2) saved");
		expect(flat(component)).toContain(
			"Added account acme-2. Login succeeded for Acme (acme-2), but connection verification did not complete: the endpoint did not respond in time. The connection is saved; retry from /plugins.",
		);
	});

	test("reports a saved-but-inactive change in the body, not the header", () => {
		const output = rendered(outcomeComponent({ ...connected, activation: "inactive" }));
		expect(output).toContain("◆ Connected Linear · 12 tools verified");
		expect(output).toContain(
			"Connected Linear (12 tools verified). The change remains saved, but it is not active in this session.",
		);
	});

	test("expands to the metadata line and collapses back without it", () => {
		const component = outcomeComponent({
			label: "Acme (acme-2)",
			source: "login",
			verification: "connected",
			toolCount: 7,
			connectionId: "acme-2",
			addedAccount: true,
			activation: "active",
		});
		expect(rendered(component)).not.toContain("login flow");
		component.setExpanded(true);
		expect(rendered(component)).toContain("login flow · account acme-2 · active in this session");
		component.setExpanded(false);
		expect(rendered(component)).not.toContain("login flow");
	});

	test("replays from the transcript through the conversation renderer, malformed entries included", () => {
		const message = createMcpConnectionOutcomeMessage(connected);
		const [replay] = buildConversationComponents([message], {
			ui: {} as TUI,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
		});
		expect(replay).toBeInstanceOf(McpConnectionOutcomeMessageComponent);
		expect(replay!.render(120)).toEqual(outcomeComponent(connected).render(120));

		const malformed = {
			role: "custom" as const,
			customType: MCP_CONNECTION_OUTCOME_CUSTOM_TYPE,
			content: "Connected Linear.",
			display: true,
			details: { label: 42 },
			timestamp: 0,
		};
		const [broken] = buildConversationComponents([malformed], {
			ui: {} as TUI,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
		});
		expect(broken).toBeInstanceOf(MalformedMcpConnectionOutcomeMessageComponent);
		expect(rendered(broken!)).toContain("[Malformed MCP connection outcome message]");
	});

	test("hides non-displayed outcomes from the transcript renderer", () => {
		const message = createMcpConnectionOutcomeMessage(connected, false);
		const components = buildConversationComponents([message], {
			ui: {} as TUI,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
		});
		expect(components).toHaveLength(0);
	});

	test("guards the persisted shape and keeps the outcome out of LLM context", () => {
		const message = createMcpConnectionOutcomeMessage(connected);
		expect(isMcpConnectionOutcomeMessage(message)).toBe(true);
		expect(isMcpConnectionOutcomeMessage({ ...message, customType: "other" })).toBe(false);
		expect(isMcpConnectionOutcomeMessage({ ...message, details: { ...connected, verification: "nope" } })).toBe(
			false,
		);
		expect(convertToLlm([message])).toEqual([]);
	});

	test("formatMcpConnectionOutcomeNotice keeps the exact legacy wording for every variant", () => {
		expect(formatMcpConnectionOutcomeNotice(connected)).toBe("Connected Linear (12 tools verified).");
		expect(
			formatMcpConnectionOutcomeNotice({
				label: "Acme (acme-2)",
				source: "login",
				verification: "connected",
				toolCount: 7,
				connectionId: "acme-2",
				addedAccount: true,
				activation: "active",
			}),
		).toBe("Added account acme-2. Connected Acme (acme-2) (7 tools verified).");
		expect(
			formatMcpConnectionOutcomeNotice({
				label: "Linear",
				source: "login",
				verification: "unsaved",
				activation: "active",
			}),
		).toBe(
			"Login succeeded for Linear, but the verification result could not be saved. The connection is saved; retry from /plugins.",
		);
	});
});

type OutcomeFake = Record<string, unknown> & {
	agentConnection: { appendCustomMessage: ReturnType<typeof vi.fn> };
};

function createOutcomeFake(): {
	fake: OutcomeFake;
	appendCustomMessage: ReturnType<typeof vi.fn>;
	store: McpConnectionStore;
	authStorage: AuthStorage;
	showStatus: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
} {
	const appendCustomMessage = vi.fn(async () => {});
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const store = McpConnectionStore.open(join(mkdtempSync(join(tmpdir(), "mcp-outcome-")), "mcp-connections.json"));
	const authStorage = AuthStorage.inMemory();
	const fake = {
		agentConnection: { appendCustomMessage },
		mcpConnectionStore: store,
		modelRegistry: { authStorage },
		ui: { requestRender: vi.fn() },
		showStatus,
		showWarning,
		handleReloadCommand: vi.fn(async () => true),
		connectionState: { isStreaming: false, isCompacting: false, messageCount: 0 },
		chatContainer: new Container(),
		pulseTimer: undefined,
		uiServices: {
			settingsManager: {
				getGlobalMcpServers: () => undefined,
				getMcpCatalogSources: () => [],
			},
		},
	} as unknown as OutcomeFake;
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return { fake, appendCustomMessage, store, authStorage, showStatus, showWarning };
}

const retryService = {
	serviceId: "acme-2",
	label: "Acme · acme-2",
	connectionStatus: "pending",
	connectionIds: ["acme-2"],
};

const retryTarget = { url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false };

function seedPendingRecord(store: McpConnectionStore): void {
	const at = Date.now();
	store.upsert({
		connectionId: "acme-2",
		serviceId: "acme",
		endpoint: "https://mcp.acme.test/mcp",
		label: "Acme · acme-2",
		status: "pending",
		createdAt: at,
		updatedAt: at,
	});
}

describe("MCP connect outcome emit sites", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		verifyMock.mockReset();
		resetOAuthProviders();
	});

	afterAll(() => {
		vi.restoreAllMocks();
	});

	test("retry verification records a connected outcome as a durable chat message, not a status line", async () => {
		const { fake, appendCustomMessage, store, showStatus } = createOutcomeFake();
		seedPendingRecord(store);
		verifyMock.mockResolvedValue({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: retryTarget.url,
			label: "Acme · acme-2",
			status: "connected",
			verifiedAt: Date.now(),
			toolCount: 12,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		await callPrivate("connectServiceFromPicker", fake, retryService, retryTarget, { catalogServiceId: "acme" });

		expect(appendCustomMessage).toHaveBeenCalledTimes(1);
		const [appended] = appendCustomMessage.mock.calls[0]!;
		expect(appended).toMatchObject({
			customType: MCP_CONNECTION_OUTCOME_CUSTOM_TYPE,
			display: true,
			content: "Connected Acme · acme-2 (12 tools verified).",
		});
		expect(appended.details).toEqual({
			label: "Acme · acme-2",
			source: "retry",
			verification: "connected",
			toolCount: 12,
			activation: "active",
		});
		// The outcome line is no longer a transient status message.
		expect(JSON.stringify(showStatus.mock.calls)).not.toContain("tools verified");
	});

	test("retry verification keeps the saved-but-unverified wording in the durable body", async () => {
		const { fake, appendCustomMessage, store } = createOutcomeFake();
		seedPendingRecord(store);
		verifyMock.mockResolvedValue({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: retryTarget.url,
			label: "Acme · acme-2",
			status: "pending",
			lastError: "http-unauthorized",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		await callPrivate("connectServiceFromPicker", fake, retryService, retryTarget, { catalogServiceId: "acme" });

		const [appended] = appendCustomMessage.mock.calls[0]!;
		expect(appended.details).toMatchObject({
			source: "retry",
			verification: "unverified",
			issue: "the endpoint rejected the stored credentials (reconnect)",
			activation: "active",
		});
		expect(appended.content).toBe(
			"Verification did not complete: the endpoint rejected the stored credentials (reconnect). The connection is saved; retry from /plugins.",
		);
	});

	test("login completion records the added-account connected outcome", async () => {
		const { fake, appendCustomMessage, authStorage } = createOutcomeFake();
		(fake as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: vi.fn(async (serverId: string) => {
				authStorage.set(`mcp:${serverId}`, {
					type: "oauth",
					access: "synthetic",
					refresh: "r",
					expires: Date.now() + 3600_000,
					endpoint: "https://mcp.acme.test/mcp",
				});
				return { status: "success" } as const;
			}),
		});
		verifyMock.mockResolvedValue({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme (acme-2)",
			status: "connected",
			verifiedAt: Date.now(),
			toolCount: 7,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		await callPrivate(
			"connectServiceFromPicker",
			fake,
			// The real accounts-picker row: its label feeds the outcome line, so
			// the composed name keeps the picker's wording.
			{
				serviceId: "acme",
				label: "Add another account",
				connectionStatus: "not_connected",
				connectionIds: [],
				connectable: true,
			},
			{ url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false },
			{ catalogServiceId: "acme", addAccount: true, knownIds: new Set(["acme"]) },
		);

		expect(appendCustomMessage).toHaveBeenCalledTimes(1);
		const [appended] = appendCustomMessage.mock.calls[0]!;
		expect(appended.content).toBe("Added account acme-2. Connected Add another account (acme-2) (7 tools verified).");
		expect(appended.details).toEqual({
			label: "Add another account (acme-2)",
			source: "login",
			verification: "connected",
			toolCount: 7,
			connectionId: "acme-2",
			addedAccount: true,
			activation: "active",
		});
	});

	test("a login whose verification result cannot be saved reports pending, never Connected", async () => {
		const { fake, appendCustomMessage, authStorage } = createOutcomeFake();
		(fake as Record<string, unknown>).createAuthFlows = () => ({
			runMcpLogin: vi.fn(async (serverId: string) => {
				authStorage.set(`mcp:${serverId}`, {
					type: "oauth",
					access: "synthetic",
					refresh: "r",
					expires: Date.now() + 3600_000,
					endpoint: "https://mcp.acme.test/mcp",
				});
				return { status: "success" } as const;
			}),
		});
		verifyMock.mockRejectedValue(new Error("simulated verification failure"));

		await callPrivate(
			"connectServiceFromPicker",
			fake,
			{ serviceId: "acme", label: "Acme", connectionStatus: "not_connected", connectionIds: [], connectable: true },
			{ url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false },
			{},
		);

		const [appended] = appendCustomMessage.mock.calls[0]!;
		expect(appended.details).toMatchObject({ source: "login", verification: "unsaved", activation: "active" });
		expect(appended.content).toContain("Login succeeded for Acme");
		expect(appended.content).toContain("could not be saved");
		expect(appended.content).not.toContain("Connected Acme");
	});

	test("a mid-stream connect queues the durable outcome for the next safe boundary", async () => {
		const { fake, appendCustomMessage, showStatus } = createOutcomeFake();
		(fake as Record<string, unknown>).connectionState = {
			isStreaming: true,
			isCompacting: false,
			messageCount: 0,
		};

		await callPrivate("completeMcpConnectionOutcome", fake, {
			label: "Linear",
			source: "login",
			verification: "connected",
			toolCount: 3,
		});

		// In-flight only: the transient line says the activation is deferred.
		expect(appendCustomMessage).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(
			"Connected Linear (3 tools verified). It will activate automatically when the current turn finishes.",
		);

		callPrivate("updateConnectionStateFromEvent", fake, { type: "agent_end" } as AgentConnectionSessionEvent);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(appendCustomMessage).toHaveBeenCalledTimes(1);
		const [appended] = appendCustomMessage.mock.calls[0]!;
		expect(appended.details).toEqual({
			label: "Linear",
			source: "login",
			verification: "connected",
			toolCount: 3,
			activation: "active",
		});
	});

	test("a failed reload still records the outcome, marked not active in this session", async () => {
		const { fake, appendCustomMessage } = createOutcomeFake();
		(fake as Record<string, unknown>).handleReloadCommand = vi.fn(async () => false);

		await callPrivate("completeMcpConnectionOutcome", fake, {
			label: "Linear",
			source: "login",
			verification: "connected",
			toolCount: 3,
		});

		const [appended] = appendCustomMessage.mock.calls[0]!;
		expect(appended.details).toMatchObject({ verification: "connected", activation: "inactive" });
		expect(appended.content).toBe(
			"Connected Linear (3 tools verified). The change remains saved, but it is not active in this session.",
		);
	});

	test("falls back to the transient line when the durable append fails", async () => {
		const { fake, showWarning } = createOutcomeFake();
		(fake as Record<string, unknown>).agentConnection = {
			appendCustomMessage: vi.fn(async () => {
				throw new Error("connection down");
			}),
		};

		await callPrivate("completeMcpConnectionOutcome", fake, {
			label: "Linear",
			source: "login",
			verification: "connected",
			toolCount: 3,
		});

		expect(showWarning).toHaveBeenCalledWith("Connected Linear (3 tools verified).");
	});
});
