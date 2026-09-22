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

	test("renders a plain connected outcome as the purple diamond header ALONE, never a restated body", () => {
		const component = outcomeComponent(connected);
		const output = rendered(component);
		const lines = output.split("\n");
		// One line only: the body restated the header ("Connected Linear · 12
		// tools verified / Connected Linear (12 tools verified).").
		expect(lines.filter((line) => line.trim()).map((line) => line.trimEnd())).toEqual([
			" ◆ Connected Linear · 12 tools verified",
		]);
		expect(flat(component)).not.toContain("(12 tools verified)");
		const raw = component.render(120).join("\n");
		expect(raw).toContain(theme.fg("refinementHeader", "◆ Connected Linear · 12 tools verified"));
		expect(raw).not.toContain("Ctrl+O");
		// The persisted content keeps the full sentence for status-line fallbacks.
		expect(createMcpConnectionOutcomeMessage(connected).content).toBe("Connected Linear (12 tools verified).");
	});

	test("the body carries only the detail the header omits, for every variant", () => {
		expect(flat(outcomeComponent({ ...connected, toolCount: undefined }))).toBe("◆ Connected Linear");
		expect(
			flat(
				outcomeComponent({
					...connected,
					connectionId: "acme-2",
					addedAccount: true,
				}),
			),
		).toBe("◆ Connected Linear · 12 tools verified Added account acme-2.");
	});

	test("keeps the diamond header for unverified and unsaved outcomes, with the body carrying only the new detail", () => {
		const unverified = outcomeComponent({
			label: "Linear",
			source: "retry",
			verification: "unverified",
			issue: "the endpoint rejected the stored credentials (reconnect)",
			activation: "active",
		});
		const unverifiedLines = rendered(unverified)
			.split("\n")
			.filter((line) => line.trim());
		expect(unverifiedLines[0]).toContain("◆");
		expect(unverifiedLines[0]).toContain("Linear saved");
		// The body adds the reason and the next step; it never restates the header.
		expect(flat(unverified)).toContain("Retry from /plugins.");
		expect(flat(unverified)).not.toMatch(/Verification did not complete.*Verification did not complete/);
		const unsaved = outcomeComponent({
			label: "Linear",
			source: "retry",
			verification: "unsaved",
			activation: "active",
		});
		const unsavedLines = rendered(unsaved)
			.split("\n")
			.filter((line) => line.trim());
		expect(unsavedLines[0]).toContain("◆");
		expect(unsavedLines[0]).toContain("Linear saved");
		expect(flat(unsaved)).toContain("Retry verification");
	});

	test("names the service, never the picked row, and tells a rejected token what to do", () => {
		// Kevin, live testing: a fake PAT rendered "[Malformed MCP connection outcome message]" (the guard did not know
		// source "paste"), and adding an account read "Connected Add another account (linear-2)".
		const rejected = {
			label: "GitHub",
			source: "paste",
			verification: "unverified",
			issue: "the endpoint rejected the stored credentials (reconnect)",
			issueCategory: "http-unauthorized",
			activation: "active",
		} as const;
		const rejectedFlat = flat(outcomeComponent(rejected));
		expect(rejectedFlat).toContain("Token not accepted");
		expect(rejectedFlat).toContain("Paste a new token from /mcp.");
		expect(isMcpConnectionOutcomeMessage(createMcpConnectionOutcomeMessage(rejected))).toBe(true);
	});

	test("a paste outcome keeps the diamond entry honest: token saved, never 'login succeeded'", () => {
		const connectedPaste = {
			label: "GitHub",
			source: "paste",
			verification: "connected",
			toolCount: 9,
			activation: "active",
		} as const;
		expect(flat(outcomeComponent(connectedPaste))).toContain("◆ Connected GitHub");
		expect(createMcpConnectionOutcomeMessage(connectedPaste).content).toBe("Connected GitHub (9 tools verified).");

		const unverifiedPaste = {
			label: "GitHub",
			source: "paste",
			verification: "unverified",
			issue: "the endpoint rejected the stored credentials (reconnect)",
			activation: "active",
		} as const;
		expect(flat(outcomeComponent(unverifiedPaste))).toContain("GitHub saved");
		expect(flat(outcomeComponent(unverifiedPaste))).toContain("Paste a new token from /mcp.");
		expect(createMcpConnectionOutcomeMessage(unverifiedPaste).content).toBe(
			"Token saved for GitHub, but connection verification did not complete: the endpoint rejected the stored credentials (reconnect). The connection is saved; retry from /plugins.",
		);

		const unsavedPaste = {
			label: "GitHub",
			source: "paste",
			verification: "unsaved",
			activation: "active",
		} as const;
		expect(flat(outcomeComponent(unsavedPaste))).toContain("Retry verification from /mcp.");
		expect(createMcpConnectionOutcomeMessage(unsavedPaste).content).toBe(
			"Token saved for GitHub, but the verification result could not be saved. The connection is saved; retry from /plugins.",
		);
		// The expanded metadata origin names the paste flow.
		const expanded = new McpConnectionOutcomeMessageComponent(createMcpConnectionOutcomeMessage(unverifiedPaste));
		expanded.setExpanded(true);
		expect(rendered(expanded)).toContain("paste flow");
	});

	test("reports a saved-but-inactive change in the body, not the header", () => {
		const inactiveFlat = flat(outcomeComponent({ ...connected, activation: "inactive" }));
		expect(inactiveFlat).toContain("not active in this session.");
		// The deferred-activation sentence is the ONLY body: no restated header.
		expect(inactiveFlat).not.toMatch(/Connected Linear.*Connected Linear/);
	});

	// The unverified-warning colour assertion is folded into "warning outcomes
	// render the warning diamond, never the success purple or error red".
	test("warning outcomes render the warning diamond, never the success purple or error red", () => {
		// Kevin: purple means success. An unfinished verification and a disconnect are warnings — orange diamonds.
		const component = outcomeComponent({ kind: "disconnect", label: "Granola", removal: "removed" });
		expect(flat(component)).toContain("◆ Disconnected Granola");
		const raw = component.render(120).join("\n");
		expect(raw).toContain(theme.fg("warning", "◆ Disconnected Granola"));
		expect(raw).not.toContain(theme.fg("refinementHeader", "◆ Disconnected Granola"));
		expect(raw).not.toContain(theme.fg("error", "◆ Disconnected Granola"));
		const unverified = {
			label: "GitHub",
			source: "paste",
			verification: "unverified",
			issue: "the endpoint returned an HTTP error",
			activation: "active",
		} as const;
		const lines = outcomeComponent(unverified).render(120);
		expect(lines.join("\n")).not.toContain(
			theme.fg("refinementHeader", "◆ Verification did not complete · GitHub saved"),
		);
		expect(lines.join("\n")).not.toContain(theme.fg("refinementSummary", " The endpoint returned an HTTP error"));
	});

	test("a disconnect body adds only the honest extra state", () => {
		expect(flat(outcomeComponent({ kind: "disconnect", label: "Granola", removal: "credential-only" }))).toContain(
			"No saved connection entry existed; the stored credential was removed.",
		);
		expect(flat(outcomeComponent({ kind: "disconnect", label: "Granola", removal: "preserved" }))).toContain(
			"was kept and now shows as not connected.",
		);
	});

	test("a disconnect expands to its own metadata line and survives transcript replay", () => {
		const details = { kind: "disconnect", label: "Granola", removal: "removed", connectionId: "granola" } as const;
		const component = outcomeComponent(details);
		component.setExpanded(true);
		expect(rendered(component)).toContain("account removed · account granola · active in this session");
		const message = createMcpConnectionOutcomeMessage(details);
		expect(message.content).toBe("Disconnected Granola.");
		expect(isMcpConnectionOutcomeMessage(message)).toBe(true);
		expect(isMcpConnectionOutcomeMessage({ ...message, details: { ...details, removal: "nope" } })).toBe(false);
		expect(convertToLlm([message])).toEqual([]);
		const [replay] = buildConversationComponents([message], {
			ui: {} as TUI,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
		});
		expect(replay).toBeInstanceOf(McpConnectionOutcomeMessageComponent);
		expect(replay!.render(120)).toEqual(outcomeComponent(details).render(120));
	});

	test("no rendered outcome line ever contains a newline", () => {
		const variants = [
			connected,
			{ ...connected, activation: "inactive" },
			{ label: "L", source: "retry", verification: "unverified", issue: "t" },
			{ kind: "disconnect", label: "G", removal: "credential-only" },
		] as const;
		for (const details of variants) {
			for (const expanded of [false, true]) {
				const component = outcomeComponent(details);
				component.setExpanded(expanded);
				for (const line of component.render(60)) expect(line).not.toContain("\n");
			}
		}
	});

	// The expand/collapse metadata-line contract is pinned with the transcript-replay test below (the disconnect
	// variant asserts the metadata line and the replayed component in one place).

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

	// The saved-but-unverified durable wording is pinned ONCE, at the same retry seam, in mcp-activation-queue.test.ts
	// ("pending account retries verification without a new login").

	// The added-account durable outcome (details and content) is pinned at the add-account SEAM in
	// mcp-activation-queue.test.ts ("adding an account allocates a new connection id...").

	// The unsaved-login outcome wording is pinned ONCE, at the picker seam, in mcp-activation-queue.test.ts ("a login
	// whose verification result cannot be saved reports pending, never Connected").

	test.each([
		{
			name: "connect",
			details: { label: "Linear", source: "login", verification: "connected", toolCount: 3 },
			deferredStatus:
				"Connected Linear (3 tools verified). It will activate automatically when the current turn finishes.",
			expected: { verification: "connected" },
			reloadSucceeds: true,
		},
		{
			name: "disconnect",
			details: { kind: "disconnect", label: "Granola", removal: "removed" },
			deferredStatus: undefined,
			expected: { kind: "disconnect", removal: "removed", activation: "inactive" },
			reloadSucceeds: false,
		},
	])(
		"a mid-stream $name queues the durable outcome for the next safe boundary",
		async ({ details, deferredStatus, expected, reloadSucceeds }) => {
			const { fake, appendCustomMessage, showStatus } = createOutcomeFake();
			(fake as Record<string, unknown>).connectionState = {
				isStreaming: true,
				isCompacting: false,
				messageCount: 0,
			};
			if (!reloadSucceeds) {
				(fake as Record<string, unknown>).handleReloadCommand = vi.fn(async () => false);
			}
			await callPrivate("completeMcpConnectionOutcome", fake, details as never);
			// In-flight only: nothing durable yet; the connect variant's transient line says the activation is deferred.
			expect(appendCustomMessage).not.toHaveBeenCalled();
			if (deferredStatus !== undefined) {
				expect(showStatus).toHaveBeenCalledWith(deferredStatus);
			}
			// The queued activation's durable append is the concrete completion signal — never a timer.
			const boundaryAppend = new Promise<void>((resolve) => {
				appendCustomMessage.mockImplementation(async () => {
					resolve();
				});
			});
			callPrivate("updateConnectionStateFromEvent", fake, { type: "agent_end" } as AgentConnectionSessionEvent);
			await boundaryAppend;
			const [appended] = appendCustomMessage.mock.calls[0]!;
			expect(appended.details).toMatchObject(expected);
			if (reloadSucceeds) {
				expect(appended.details.activation).toBe("active");
			}
		},
	);

	// A failed reload marking the outcome "inactive" is pinned by the boundary
	// table's disconnect case (reloadSucceeds: false → activation "inactive")
	// and the saved-but-inactive body test in the component section.

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

/** Seed a connected account plus its credential, the state a disconnect acts on. */
function seedConnectedAccount(store: McpConnectionStore, authStorage: AuthStorage, connectionId: string): void {
	const at = Date.now();
	store.upsert({
		connectionId,
		serviceId: "granola",
		endpoint: "https://mcp.granola.test/mcp",
		label: "Granola",
		status: "connected",
		createdAt: at,
		updatedAt: at,
	});
	authStorage.set(`mcp:${connectionId}`, {
		type: "oauth",
		access: "synthetic",
		refresh: "r",
		expires: at + 3600_000,
		endpoint: "https://mcp.granola.test/mcp",
	});
}

describe("MCP disconnect outcome emit sites", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	// The picker's Remove row recording the durable "◆ Disconnected" entry is pinned end-to-end at the chain seam in
	// service-catalog-picker.test.ts ("the accounts Disconnect row removes that account and records the durable entry").

	test("a failed /mcp logout warns and records nothing: no entry may claim it is done", async () => {
		const { fake, appendCustomMessage, store, authStorage, showWarning } = createOutcomeFake();
		seedConnectedAccount(store, authStorage, "granola");
		vi.spyOn(authStorage, "removeVerified").mockImplementation(() => {
			throw new Error("auth file is read-only");
		});

		await callPrivate("handleMcpCommand", fake, "logout granola");

		expect(appendCustomMessage).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith("The change could not be saved; try logging out granola again.");
		vi.restoreAllMocks();
	});

	// The mid-stream DISCONNECT variant is folded into the boundary table above (failed reload →
	// activation: "inactive"); the generic /logout route's durable disconnect is pinned at the route
	// seam in mcp-activation-queue.test.ts ("the REAL generic /logout fired inside the finalize
	// commit..."), and a refused logout staying honest is pinned in auth-flows.test.ts.
});
