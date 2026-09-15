import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, Container, Input, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import { McpConnectionStore } from "../../../src/core/mcp/connection-store.js";
import type { McpPluginView, McpServiceDescriptor } from "../../../src/core/mcp/service-catalog.js";
import { McpTokenPastePanelComponent } from "../../../src/modes/interactive/components/mcp-token-paste-panel.js";
import { ServiceCatalogPickerComponent } from "../../../src/modes/interactive/components/service-catalog-picker.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme, preloadCodeHighlighter } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const harnesses: Harness[] = [];
beforeAll(async () => {
	initTheme("dark");
	await preloadCodeHighlighter();
});
beforeEach(() => {
	setKeybindings(new KeybindingsManager());
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Network forbidden in inline picker tests");
		}),
	);
});
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
	while (localCatalogDirs.length) rmSync(localCatalogDirs.pop()!, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

const ENDPOINT = "https://acme.example.test/mcp";
const PASTE_ENDPOINT = "https://paste.example.test/mcp";
const localCatalogDirs: string[] = [];
function view(overrides: Partial<McpPluginView> = {}): McpPluginView {
	return {
		serviceId: "acme",
		label: "Acme",
		connectionStatus: "not_connected",
		connectable: true,
		usesOAuth: true,
		source: "catalog",
		connectionIds: [],
		...overrides,
	};
}
const descriptor: McpServiceDescriptor = {
	serviceId: "acme",
	label: "Acme",
	aliases: [],
	transport: { type: "http", url: ENDPOINT },
	authStrategy: "oauth",
	setup: { status: "ready" },
	metadataReviewed: true,
	legacyBuiltin: false,
};
interface Target {
	url?: string;
	usesOAuth: boolean;
	managedBySettings: boolean;
}
interface ActionOptions {
	catalogServiceId?: string;
	addAccount?: boolean;
	knownIds?: ReadonlySet<string>;
}
interface PickerHost {
	showServiceCatalogPicker(query?: string): Promise<void>;
	showAccountPickerForService(
		service: McpPluginView,
		target: Target,
		options: { knownIds: Set<string> },
	): Promise<"catalog" | "closed">;
	selectServiceCatalogRow(
		views: McpPluginView[],
	): Promise<{ status: "selected"; service: McpPluginView } | { status: "cancelled" } | { status: "back" }>;
	closeServiceCatalogPicker?: () => void;
}
async function fixture(views: McpPluginView[] = [view()], options: { settings?: Record<string, unknown> } = {}) {
	const harness = await createHarness({
		models: [{ id: "offline", name: "Offline" }],
		...(options.settings ? { settings: options.settings as never } : {}),
	});
	harnesses.push(harness);
	const store = McpConnectionStore.open(join(harness.tempDir, "connections.json"));
	const editor = new Input();
	editor.setValue("preserved draft");
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const setFocus = vi.fn();
	const showError = vi.fn();
	const connect = vi.fn(async (_view: McpPluginView, _target: Target | undefined, _options: ActionOptions) => ({
		ran: true,
	}));
	const mode = Object.assign(Object.create(InteractiveMode.prototype) as object, {
		editor,
		editorContainer,
		ui: {
			terminal: { rows: 24 },
			requestRender: vi.fn(),
			setFocus,
			showOverlay: vi.fn(() => {
				throw new Error("Inline picker must not mount an overlay");
			}),
		},
		uiServices: { modelRegistry: harness.session.modelRegistry, settingsManager: harness.settingsManager },
		buildServiceCatalogViews: () => ({ services: [descriptor], views, diagnostics: [] }),
		getMcpConnectionStore: () => store,
		connectServiceFromPicker: connect,
		showError,
		showWarning: vi.fn(),
		// The prototype object never runs the constructor, so the field the
		// inline auth/paste panel closers live in starts as a real array.
		inlineAuthPanelClosers: [],
	}) as unknown as PickerHost;
	const picker = () => {
		const component = editorContainer.children[0];
		expect(component).toBeInstanceOf(ServiceCatalogPickerComponent);
		return component as ServiceCatalogPickerComponent;
	};
	return { harness, store, editor, editorContainer, mode, picker, connect, setFocus, showError };
}

/**
 * Wait for the picker chain to RE-ENTER: a freshly mounted picker that is not
 * the previous instance. Every re-entry (Kevin, live testing) rebuilds the
 * surface from the live stores, so tests can assert the new instance's rows.
 */
async function nextPicker(
	f: Awaited<ReturnType<typeof fixture>>,
	previous: ServiceCatalogPickerComponent,
): Promise<ServiceCatalogPickerComponent> {
	await vi.waitFor(() => {
		expect(f.editorContainer.children[0]).toBeInstanceOf(ServiceCatalogPickerComponent);
		expect(f.editorContainer.children[0]).not.toBe(previous);
	});
	return f.picker();
}

/** Write a validated local service-catalog source file and return its path. */
function writeLocalCatalog(entries: Record<string, unknown>[]): string {
	const dir = mkdtempSync(join(tmpdir(), "eng6108-reentry-"));
	localCatalogDirs.push(dir);
	const file = join(dir, "services.json");
	writeFileSync(
		file,
		JSON.stringify({
			version: 1,
			entries,
		}),
		"utf8",
	);
	return file;
}

it("mounts catalog inline, preserves prefill and cancels without auth or draft loss", async () => {
	const f = await fixture([view(), view({ serviceId: "other", label: "Other" })]);
	const done = f.mode.showServiceCatalogPicker("acme");
	const picker = f.picker();
	expect(picker.getSearchInput()?.getValue()).toBe("acme");
	expect(stripAnsi(picker.render(80).join("\n"))).not.toContain("Other");
	expect(f.setFocus).toHaveBeenLastCalledWith(picker);
	picker.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
	expect(f.editor.getValue()).toBe("preserved draft");
	expect(f.setFocus).toHaveBeenLastCalledWith(f.editor);
	expect(f.connect).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});

it("restores editor before awaiting the callback and ignores duplicate Enter/cancel", async () => {
	const f = await fixture();
	let release!: () => void;
	const operation = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.connect.mockImplementation(async () => {
		expect(f.editorContainer.children).toEqual([f.editor]);
		await operation;
		return { ran: true };
	});
	const done = f.mode.showServiceCatalogPicker();
	const picker = f.picker();
	picker.handleInput("\r");
	picker.handleInput("\r");
	picker.handleInput("\x1b");
	await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
	let finished = false;
	void done.then(() => {
		finished = true;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	expect(f.setFocus.mock.calls.filter(([component]) => component === f.editor)).toHaveLength(1);
	release();
	// The action ran, so the chain RE-ENTERS the catalog instead of dropping
	// to the prompt; Esc closes the reopened picker and only then ends.
	const reopened = await nextPicker(f, picker);
	expect(reopened.getSearchInput()).toBeDefined();
	reopened.handleInput("\x1b");
	await done;
	expect(f.connect).toHaveBeenCalledOnce();
	expect(f.editorContainer.children).toEqual([f.editor]);
});

it.each(["catalog", "accounts"] as const)(
	"reports rejected %s callbacks without leaking their error text or replacing a later selector",
	async (surface) => {
		const f = await fixture();
		let reject!: (reason: Error) => void;
		f.connect.mockImplementation(
			() =>
				new Promise((_resolve, fail) => {
					reject = fail;
				}),
		);
		const done =
			surface === "catalog"
				? f.mode.showServiceCatalogPicker()
				: f.mode.showAccountPickerForService(
						view({ connectionIds: ["acme-work"] }),
						{ url: ENDPOINT, usesOAuth: true, managedBySettings: false },
						{ knownIds: new Set(["acme"]) },
					);
		f.picker().handleInput("\r");
		await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
		const next = new Input();
		f.editorContainer.clear();
		f.editorContainer.addChild(next);
		reject(new Error("access_token=DO_NOT_DISPLAY"));
		await done;
		expect(f.showError).toHaveBeenCalledWith("MCP connection action did not complete. Try again.");
		expect(JSON.stringify(f.showError.mock.calls)).not.toContain("DO_NOT_DISPLAY");
		expect(f.editorContainer.children).toEqual([next]);
	},
);

it("settles a stale picker as cancellation without restoring or invoking its old row", async () => {
	const f = await fixture();
	const done = f.mode.showServiceCatalogPicker();
	const stale = f.picker();
	const next: Component = new Input();
	f.editorContainer.clear();
	f.editorContainer.addChild(next);
	stale.handleInput("\r");
	await done;
	expect(f.connect).not.toHaveBeenCalled();
	expect(f.editorContainer.children).toEqual([next]);
	expect(f.setFocus.mock.calls.filter(([component]) => component === f.editor)).toHaveLength(0);
});

it("opening a replacement picker settles the old promise, whose late close cannot hide it", async () => {
	const f = await fixture();
	const first = f.mode.selectServiceCatalogRow([view()]);
	const stale = f.picker();
	const oldClose = f.mode.closeServiceCatalogPicker;
	const second = f.mode.selectServiceCatalogRow([view({ label: "Replacement" })]);
	const next = f.picker();
	await expect(first).resolves.toEqual({ status: "cancelled" });
	stale.handleInput("\r");
	oldClose?.();
	expect(f.editorContainer.children).toEqual([next]);
	next.handleInput("\x1b");
	await expect(second).resolves.toEqual({ status: "cancelled" });
});

it("catalog to accounts preserves ownership, grouping and real per-account pending state", async () => {
	const service = view({ connectionIds: ["acme-work"], connectionStatus: "connected" });
	const f = await fixture([service]);
	f.harness.authStorage.set("mcp:acme-work", {
		type: "oauth",
		access: "synthetic",
		refresh: "r",
		expires: Date.now() + 3600_000,
		endpoint: ENDPOINT,
	});
	f.store.upsert({
		connectionId: "acme-work",
		serviceId: "acme",
		endpoint: ENDPOINT,
		label: "Work",
		status: "pending",
		createdAt: 1,
		updatedAt: 1,
	});
	await f.store.flush();
	const done = f.mode.showServiceCatalogPicker();
	const catalog = f.picker();
	catalog.handleInput("\r");
	await vi.waitFor(() => expect(f.picker()).not.toBe(catalog));
	const accounts = f.picker();
	catalog.handleInput("\x1b");
	expect(f.editorContainer.children).toEqual([accounts]);
	const output = stripAnsi(accounts.render(100).join("\n"));
	expect(output).toContain("Acme MCP");
	expect(output).toContain("Reconnect");
	expect(output).toContain("Enter verify");
	// The redesign drops the right-hand status column; the hint carries the
	// per-row action.
	expect(output).not.toContain("Needs verification");
	accounts.handleInput("\r");
	await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
	expect(f.connect.mock.calls[0]?.[0]).toMatchObject({ serviceId: "acme-work", connectionStatus: "pending" });
	expect(f.connect.mock.calls[0]?.[2]).toEqual({ catalogServiceId: "acme" });
	// Re-entry (Kevin, live testing): the action ran, so the SAME accounts
	// menu reopens freshly built — never the prompt. The mocked action stored
	// nothing, so the row set is unchanged; the surface is new.
	const reopened = await nextPicker(f, accounts);
	expect(reopened.getSearchInput()).toBeUndefined();
	const again = stripAnsi(reopened.render(100).join("\n"));
	expect(again).toContain("Acme MCP");
	expect(again).toContain("Reconnect");
	expect(again).toContain("Enter verify");
	reopened.handleInput("\x1b");
	await done;
	expect(f.editor.getValue()).toBe("preserved draft");
	expect(f.editorContainer.children).toEqual([f.editor]);
});

it.each(["remove", "add"] as const)("keeps the %s action and identifiers unchanged", async (action) => {
	// The fixture's view list is what re-entry reads: keep the account
	// present so the (mocked) action re-enters the accounts menu.
	const f = await fixture([view({ connectionIds: ["acme-work"] })]);
	const done = f.mode.showAccountPickerForService(
		view({ connectionIds: ["acme-work"] }),
		{ url: ENDPOINT, usesOAuth: true, managedBySettings: false },
		{ knownIds: new Set(["acme"]) },
	);
	const accounts = f.picker();
	accounts.handleInput("\x1b[B");
	if (action === "add") accounts.handleInput("\x1b[B");
	accounts.handleInput("\r");
	// The action ran (mocked): the accounts menu re-enters with the same rows,
	// and Esc ends the chain.
	const reopened = await nextPicker(f, accounts);
	expect(reopened.getSearchInput()).toBeUndefined();
	reopened.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
	expect(f.connect).toHaveBeenCalledOnce();
	if (action === "remove") {
		expect(f.connect.mock.calls[0]?.[0]).toMatchObject({ serviceId: "acme-work", removeAction: true });
	} else {
		expect(f.connect.mock.calls[0]?.[0]).toMatchObject({ serviceId: "acme", connectionIds: [] });
		expect(f.connect.mock.calls[0]?.[2]).toEqual({
			catalogServiceId: "acme",
			addAccount: true,
			knownIds: new Set(["acme"]),
		});
	}
});

async function connectedAccountFixture() {
	const f = await settingsFixture();
	const now = Date.now();
	f.harness.authStorage.set("mcp:acme-work", {
		type: "oauth",
		access: "synthetic-access",
		refresh: "r",
		expires: now + 3600_000,
		endpoint: ENDPOINT,
	});
	f.store.upsert({
		connectionId: "acme-work",
		serviceId: "acme",
		endpoint: ENDPOINT,
		label: "Work",
		status: "connected",
		verifiedAt: now,
		toolCount: 2,
		createdAt: now,
		updatedAt: now,
	});
	await f.store.flush();
	const removeAccount = vi.spyOn(f.store, "removeAccount");
	const done = f.mode.showAccountPickerForService(
		view({ connectionIds: ["acme-work"], connectionStatus: "connected" }),
		{ url: ENDPOINT, usesOAuth: true, managedBySettings: false },
		{ knownIds: new Set(["acme"]) },
	);
	return { f, removeAccount, done, accounts: f.picker() };
}

it("Enter on the accounts Reconnect row re-verifies, then re-enters the same accounts menu", async () => {
	// Kevin (live testing): Enter on the first row must not disconnect the
	// account — that is the Disconnect row's job. The relabelled Reconnect row
	// re-verifies; the record and the credential both survive, and the SAME
	// accounts menu reopens with the refreshed status (never the prompt).
	const { f, removeAccount, done, accounts } = await connectedAccountFixture();
	expect(stripAnsi(accounts.render(100).join("\n"))).toContain("Enter reconnect");
	expect(stripAnsi(accounts.render(100).join("\n"))).not.toContain("Enter disconnect");
	accounts.handleInput("\r");
	const reopened = await nextPicker(f, accounts);
	expect(reopened.getSearchInput()).toBeUndefined();
	// Same accounts menu, freshly built: the offline verification left the
	// account saved, so the Reconnect row still reads as a pending re-verify.
	const again = stripAnsi(reopened.render(100).join("\n"));
	expect(again).toContain("Reconnect");
	expect(again).toContain("Enter verify");
	reopened.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
	expect(removeAccount).not.toHaveBeenCalled();
	expect(f.store.get("acme-work")).toBeDefined();
	expect(f.harness.authStorage.getVerified("mcp:acme-work")).toBeDefined();
	expect(f.reserve).not.toHaveBeenCalled();
	expect(f.claim).not.toHaveBeenCalled();
	expect(f.authFlow).not.toHaveBeenCalled();
	// The network-denied environment makes the verification fail, which keeps
	// this test offline; the honest outcome is a retry that leaves the account
	// saved — never a removal.
	expect(f.appendOutcome).toHaveBeenCalledOnce();
	expect(f.appendOutcome.mock.calls[0]?.[0]).toMatchObject({
		customType: "mcp_connection_outcome",
		details: { source: "retry", verification: "unverified" },
	});
});

it("Enter on the accounts Disconnect row still removes that account and records the durable entry", async () => {
	// Re-entry decision (Kevin, live testing): disconnecting the LAST account
	// leaves the service with no accounts, so the chain reopens the CATALOG —
	// the user is never dropped to the prompt. The real /mcp flow enters the
	// accounts menu from the catalog row.
	const f = await settingsFixture();
	const now = Date.now();
	f.harness.authStorage.set("mcp:acme-work", {
		type: "oauth",
		access: "synthetic-access",
		refresh: "r",
		expires: now + 3600_000,
		endpoint: ENDPOINT,
	});
	f.store.upsert({
		connectionId: "acme-work",
		serviceId: "acme",
		endpoint: ENDPOINT,
		label: "Work",
		status: "connected",
		verifiedAt: now,
		toolCount: 2,
		createdAt: now,
		updatedAt: now,
	});
	await f.store.flush();
	const removeAccount = vi.spyOn(f.store, "removeAccount");
	const done = f.mode.showServiceCatalogPicker("acme");
	const catalog = f.picker();
	expect(stripAnsi(catalog.render(100).join("\n"))).toContain("Work");
	catalog.handleInput("\r");
	const accounts = await nextPicker(f, catalog);
	expect(stripAnsi(accounts.render(100).join("\n"))).toContain("Work MCP");
	accounts.handleInput("\x1b[B");
	expect(stripAnsi(accounts.render(100).join("\n"))).toContain("Enter disconnect");
	accounts.handleInput("\r");
	// The last account is gone: the CATALOG reopens (search box = catalog
	// surface), freshly built — the removed pinned service no longer lists a
	// connection.
	const reopened = await nextPicker(f, accounts);
	expect(reopened.getSearchInput()).toBeDefined();
	expect(stripAnsi(reopened.render(100).join("\n"))).not.toContain("Work MCP");
	reopened.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
	expect(removeAccount).toHaveBeenCalledOnce();
	expect(f.store.get("acme-work")).toBeUndefined();
	expect(f.harness.authStorage.getVerified("mcp:acme-work")).toBeUndefined();
	expect(f.reload).toHaveBeenCalledOnce();
	// The durable "◆ Disconnected" entry rides the remove path: the change
	// survives in the chat instead of a status line that scrolls away.
	expect(f.appendOutcome).toHaveBeenCalledOnce();
	expect(f.appendOutcome.mock.calls[0]?.[0]).toMatchObject({
		customType: "mcp_connection_outcome",
		details: { kind: "disconnect", label: "Work", connectionId: "acme-work" },
	});
});

it("shows exactly one Reconnect and one Disconnect row for the whole service, then one add row", async () => {
	// Kevin (live testing): "instead of reconnect linear and linear-2 and
	// disconnect linear and linear-2, make it just one reconnect and
	// disconnect" — several accounts keep the menu THREE rows; the account id
	// comes from the sub-picker opened on Enter, never the row label.
	const f = await fixture();
	const now = Date.now();
	for (const id of ["acme-work", "acme-personal"]) {
		f.harness.authStorage.set(`mcp:${id}`, {
			type: "oauth",
			access: "synthetic",
			refresh: "r",
			expires: now + 3600_000,
			endpoint: ENDPOINT,
		});
		f.store.upsert({
			connectionId: id,
			serviceId: "acme",
			endpoint: ENDPOINT,
			label: id,
			status: "connected",
			verifiedAt: now,
			toolCount: 2,
			createdAt: now,
			updatedAt: now,
		});
	}
	await f.store.flush();
	const done = f.mode.showAccountPickerForService(
		view({ connectionIds: ["acme-work", "acme-personal"], connectionStatus: "connected" }),
		{ url: ENDPOINT, usesOAuth: true, managedBySettings: false },
		{ knownIds: new Set(["acme"]) },
	);
	const accounts = f.picker();
	const output = stripAnsi(accounts.render(100).join("\n"));
	expect(output).toContain("Acme MCP");
	// Three rows, in order — no per-account pairs anywhere.
	expect(output.indexOf("Reconnect")).toBeLessThan(output.indexOf("Disconnect"));
	expect(output.indexOf("Disconnect")).toBeLessThan(output.indexOf("Add another account"));
	expect(output).not.toContain("Reconnect acme-work");
	expect(output).not.toContain("Disconnect acme-work");
	expect(output).not.toContain("Reconnect acme-personal");
	expect(output).not.toContain("Disconnect acme-personal");
	// Enter on the multi-account rows names the account-selection step.
	expect(output).toContain("Enter choose account");
	// No account-name rows survive: every label is the action itself.
	expect(output).not.toContain("Acme ·");
	// Esc still closes the whole chain without acting.
	accounts.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
	expect(f.connect).not.toHaveBeenCalled();
});

it("pins the single-account accounts menu: Reconnect, Disconnect, Add another account", async () => {
	// Kevin (live testing): the menu is exactly THREE rows for a single
	// account too — Enter acts on it directly, with no id suffix on the
	// labels and no sub-picker in between.
	const f = await fixture();
	const now = Date.now();
	f.harness.authStorage.set("mcp:acme-work", {
		type: "oauth",
		access: "synthetic",
		refresh: "r",
		expires: now + 3600_000,
		endpoint: ENDPOINT,
	});
	f.store.upsert({
		connectionId: "acme-work",
		serviceId: "acme",
		endpoint: ENDPOINT,
		label: "Work",
		status: "connected",
		verifiedAt: now,
		toolCount: 2,
		createdAt: now,
		updatedAt: now,
	});
	await f.store.flush();
	const done = f.mode.showAccountPickerForService(
		view({ connectionIds: ["acme-work"], connectionStatus: "connected" }),
		{ url: ENDPOINT, usesOAuth: true, managedBySettings: false },
		{ knownIds: new Set(["acme"]) },
	);
	const accounts = f.picker();
	const output = stripAnsi(accounts.render(100).join("\n"));
	expect(output).toContain("Acme MCP");
	expect(output.indexOf("Reconnect")).toBeLessThan(output.indexOf("Disconnect"));
	expect(output.indexOf("Disconnect")).toBeLessThan(output.indexOf("Add another account"));
	expect(output).not.toContain("Reconnect acme-work");
	expect(output).not.toContain("Disconnect acme-work");
	// Single account: Enter on Reconnect acts directly — the re-verify hint,
	// not the account-selection step.
	expect(output).toContain("Enter reconnect");
	expect(output).not.toContain("Enter choose account");
	accounts.handleInput("\x1b");
	await done;
	expect(f.connect).not.toHaveBeenCalled();
});

it("multi-account Reconnect opens an account sub-picker; picking one acts on THAT account", async () => {
	// Kevin (live testing): with several accounts there is a second picker
	// after Reconnect that selects one — "linear", "linear-2" — and the
	// action runs on the picked connection id only. The fixture's view list
	// is what re-entry reads, so the accounts menu re-enters after the
	// (mocked) action ran.
	const f = await fixture([view({ connectionIds: ["acme-work", "acme-personal"], connectionStatus: "connected" })]);
	const now = Date.now();
	for (const id of ["acme-work", "acme-personal"]) {
		f.harness.authStorage.set(`mcp:${id}`, {
			type: "oauth",
			access: "synthetic",
			refresh: "r",
			expires: now + 3600_000,
			endpoint: ENDPOINT,
		});
		f.store.upsert({
			connectionId: id,
			serviceId: "acme",
			endpoint: ENDPOINT,
			label: id,
			status: "connected",
			verifiedAt: now,
			toolCount: 2,
			createdAt: now,
			updatedAt: now,
		});
	}
	await f.store.flush();
	const done = f.mode.showAccountPickerForService(
		view({ connectionIds: ["acme-work", "acme-personal"], connectionStatus: "connected" }),
		{ url: ENDPOINT, usesOAuth: true, managedBySettings: false },
		{ knownIds: new Set(["acme"]) },
	);
	const accounts = f.picker();
	accounts.handleInput("\r"); // → Reconnect: open the account sub-picker
	const sub = await nextPicker(f, accounts);
	expect(sub.getSearchInput()).toBeUndefined();
	const subOutput = stripAnsi(sub.render(100).join("\n"));
	expect(subOutput).toContain("Accounts");
	expect(subOutput).toContain("acme-work");
	expect(subOutput).toContain("acme-personal");
	// The sub-picker never nests deeper: its rows are the accounts, so Enter
	// acts — it does not open another picker.
	sub.handleInput("\x1b[B"); // → acme-personal
	expect(stripAnsi(sub.render(100).join("\n"))).toContain("Enter reconnect");
	sub.handleInput("\r");
	await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce());
	expect(f.connect.mock.calls[0]?.[0]).toMatchObject({
		serviceId: "acme-personal",
		connectionStatus: "connected",
	});
	expect(f.connect.mock.calls[0]?.[0]?.removeAction).toBeFalsy();
	expect(f.connect.mock.calls[0]?.[2]).toEqual({ catalogServiceId: "acme" });
	// The action ran: the accounts menu re-enters (the sub-picker is never a
	// surface of its own), and Esc ends the chain.
	const reopened = await nextPicker(f, sub);
	expect(reopened.getSearchInput()).toBeUndefined();
	const again = stripAnsi(reopened.render(100).join("\n"));
	expect(again).toContain("Acme MCP");
	expect(again).toContain("Enter choose account");
	reopened.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
});

it.each([
	{ key: "\x1b", label: "Esc" },
	{ key: "\x1b[D", label: "left arrow" },
])("the sub-picker's $label returns to the accounts menu without acting", async ({ key }) => {
	const f = await fixture();
	const now = Date.now();
	for (const id of ["acme-work", "acme-personal"]) {
		f.harness.authStorage.set(`mcp:${id}`, {
			type: "oauth",
			access: "synthetic",
			refresh: "r",
			expires: now + 3600_000,
			endpoint: ENDPOINT,
		});
		f.store.upsert({
			connectionId: id,
			serviceId: "acme",
			endpoint: ENDPOINT,
			label: id,
			status: "connected",
			verifiedAt: now,
			toolCount: 2,
			createdAt: now,
			updatedAt: now,
		});
	}
	await f.store.flush();
	const done = f.mode.showAccountPickerForService(
		view({ connectionIds: ["acme-work", "acme-personal"], connectionStatus: "connected" }),
		{ url: ENDPOINT, usesOAuth: true, managedBySettings: false },
		{ knownIds: new Set(["acme"]) },
	);
	const accounts = f.picker();
	accounts.handleInput("\r"); // → Reconnect: open the account sub-picker
	const sub = await nextPicker(f, accounts);
	sub.handleInput(key);
	// Back, never close: the service's accounts menu re-mounts freshly built
	// and nothing acted — no connect, no status noise.
	const reopened = await nextPicker(f, sub);
	expect(reopened.getSearchInput()).toBeUndefined();
	const again = stripAnsi(reopened.render(100).join("\n"));
	expect(again).toContain("Acme MCP");
	expect(again).toContain("Reconnect");
	expect(again).toContain("Enter choose account");
	expect(f.connect).not.toHaveBeenCalled();
	// The chain is still open: Esc from the accounts menu closes it.
	reopened.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
});

it("left arrow from the accounts menu returns to a freshly mounted catalog", async () => {
	// Kevin (live testing): "make it so left arrow from a /mcp config page
	// goes to /mcp menu with all the mcps" — the catalog is the picker chain's
	// parent surface, and it re-mounts fresh (no search prefill).
	const f = await fixture([view({ connectionIds: ["acme-work"], connectionStatus: "connected" })]);
	const done = f.mode.showServiceCatalogPicker("acme");
	const catalog = f.picker();
	catalog.handleInput("\r"); // → the service's accounts menu
	const accounts = await nextPicker(f, catalog);
	expect(accounts.getSearchInput()).toBeUndefined();
	expect(stripAnsi(accounts.render(100).join("\n"))).toContain("← back");
	accounts.handleInput("\x1b[D");
	const reopened = await nextPicker(f, accounts);
	// The catalog surface, freshly mounted: the search box is back and EMPTY —
	// the "acme" prefill that opened the chain did not survive the back.
	expect(reopened.getSearchInput()).toBeDefined();
	expect(reopened.getSearchInput()?.getValue()).toBe("");
	const output = stripAnsi(reopened.render(100).join("\n"));
	expect(output).toContain("Acme");
	reopened.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
});

it("left arrow in the catalog is inert: the chain stays open on the same picker", async () => {
	// The catalog is the chain's root — there is no parent surface to go back
	// to, so the left arrow stays with the search box.
	const f = await fixture([view(), view({ serviceId: "other", label: "Other" })]);
	const done = f.mode.showServiceCatalogPicker();
	const catalog = f.picker();
	catalog.handleInput("\x1b[D");
	// Nothing settled and nothing re-mounted: the back key did not navigate.
	expect(f.editorContainer.children[0]).toBe(catalog);
	// The key was an edit, not navigation: search still filters afterwards.
	catalog.handleInput("o");
	catalog.handleInput("t");
	const output = stripAnsi(catalog.render(100).join("\n"));
	expect(output).toContain("Other");
	expect(output).not.toContain("Acme");
	catalog.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
});

async function settingsFixture() {
	const f = await fixture();
	// Restore the real view builder and mutation callback on the production prototype.
	Reflect.deleteProperty(f.mode, "buildServiceCatalogViews");
	Reflect.deleteProperty(f.mode, "connectServiceFromPicker");
	const showStatus = vi.fn();
	const reload = vi.fn(async () => {});
	const appendOutcome = vi.fn(async (_message: Record<string, unknown>) => {});
	const authFlow = vi.fn(() => {
		throw new Error("OAuth must not run for settings-only actions");
	});
	Object.assign(f.mode, {
		showStatus,
		handleReloadCommand: reload,
		createAuthFlows: authFlow,
		agentConnection: { appendCustomMessage: appendOutcome },
	});
	const reserve = vi.spyOn(f.store, "reserveConnectionId");
	const claim = vi.spyOn(f.store, "claimConnectionId");
	return { ...f, showStatus, reload, appendOutcome, authFlow, reserve, claim };
}

it("real stdio view routes explicit Disable directly to the existing settings mutator, not account cards", async () => {
	const f = await settingsFixture();
	f.harness.settingsManager.setGlobalMcpServer(
		"stdio-proof",
		{ type: "stdio", command: "synthetic-not-executed", enabled: true },
		true,
	);
	const writeSettings = vi.spyOn(f.harness.settingsManager, "setGlobalMcpServer");
	const done = f.mode.showServiceCatalogPicker("stdio-proof");
	const picker = f.picker();
	const output = stripAnsi(picker.render(100).join("\n"));
	expect(output).toContain("Enter disable local server");
	expect(output).not.toContain("Add another account");
	expect(output).not.toContain("Remove stdio-proof");
	picker.handleInput("\r");
	picker.handleInput("\r");
	// The disable RAN (a real settings change): the chain re-enters the CATALOG
	// — freshly built, so the disabled server now shows its settings-guidance
	// row — and Esc ends it.
	const reopened = await nextPicker(f, picker);
	expect(reopened.getSearchInput()).toBeDefined();
	for (const character of "stdio-proof") reopened.handleInput(character);
	const after = stripAnsi(reopened.render(120).join("\n"));
	expect(after).toContain("stdio-proof");
	expect(after).toContain("Enter settings guidance");
	reopened.handleInput("\x1b");
	await done;
	expect(f.harness.settingsManager.getGlobalMcpServers()?.["stdio-proof"]?.enabled).toBe(false);
	expect(writeSettings).toHaveBeenCalledOnce();
	expect(f.reload).toHaveBeenCalledOnce();
	expect(f.editorContainer.children).toEqual([f.editor]);
	expect(f.authFlow).not.toHaveBeenCalled();
	expect(f.reserve).not.toHaveBeenCalled();
	expect(f.claim).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});

it("captured disabled stdio guidance cannot disable a server re-enabled while the picker is open", async () => {
	const f = await settingsFixture();
	const config = { type: "stdio" as const, command: "synthetic-not-executed", enabled: false };
	f.harness.settingsManager.setGlobalMcpServer("stdio-proof", config, true);
	const done = f.mode.showServiceCatalogPicker("stdio-proof");
	const picker = f.picker();
	expect(stripAnsi(picker.render(100).join("\n"))).toContain("Enter settings guidance");
	f.harness.settingsManager.setGlobalMcpServer("stdio-proof", { ...config, enabled: true }, true);
	const writeSettings = vi.spyOn(f.harness.settingsManager, "setGlobalMcpServer");
	picker.handleInput("\r");
	await done;
	expect(f.harness.settingsManager.getGlobalMcpServers()?.["stdio-proof"]?.enabled).toBe(true);
	expect(writeSettings).not.toHaveBeenCalled();
	expect(f.reload).not.toHaveBeenCalled();
	expect(f.showStatus).toHaveBeenCalled();
	expect(f.authFlow).not.toHaveBeenCalled();
	expect(f.reserve).not.toHaveBeenCalled();
	expect(f.claim).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});

it.each(["anonymous", "missing-bearer"] as const)(
	"real %s HTTP without a saved account exposes only non-mutating settings guidance",
	async (kind) => {
		const f = await settingsFixture();
		vi.stubEnv("ENG_6108_MISSING_BEARER", "");
		f.harness.settingsManager.setGlobalMcpServer(
			"http-proof",
			{
				type: "http",
				url: ENDPOINT,
				...(kind === "missing-bearer" ? { bearerTokenEnvVar: "ENG_6108_MISSING_BEARER" } : {}),
			},
			true,
		);
		const writeSettings = vi.spyOn(f.harness.settingsManager, "setGlobalMcpServer");
		const done = f.mode.showServiceCatalogPicker("http-proof");
		const picker = f.picker();
		const output = stripAnsi(picker.render(100).join("\n"));
		expect(output).toContain("Enter settings guidance");
		expect(output).not.toContain("Add another account");
		expect(output).not.toContain("Remove http-proof");
		picker.handleInput("\r");
		await done;
		expect(f.editorContainer.children).toEqual([f.editor]);
		expect(writeSettings).not.toHaveBeenCalled();
		expect(f.authFlow).not.toHaveBeenCalled();
		expect(f.reserve).not.toHaveBeenCalled();
		expect(f.claim).not.toHaveBeenCalled();
		expect(f.store.records()).toEqual([]);
		expect(f.showStatus).toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	},
);

it.each([false, true])("nonOAuth pending HTTP follows real Verify without OAuth (saved=%s)", async (saved) => {
	const f = await settingsFixture();
	vi.stubEnv("ENG_6108_PRESENT_BEARER", "synthetic-env-token");
	f.harness.settingsManager.setGlobalMcpServer(
		"http-proof",
		{ type: "http", url: ENDPOINT, bearerTokenEnvVar: "ENG_6108_PRESENT_BEARER" },
		true,
	);
	if (saved) {
		f.store.upsert({
			connectionId: "http-proof",
			serviceId: "http-proof",
			endpoint: ENDPOINT,
			label: "HTTP",
			status: "pending",
			createdAt: 1,
			updatedAt: 1,
		});
		await f.store.flush();
	}
	const done = f.mode.showServiceCatalogPicker("http-proof");
	const catalog = f.picker();
	if (saved) {
		expect(stripAnsi(catalog.render(100).join("\n"))).toContain("Enter manage saved account");
		catalog.handleInput("\r");
		await vi.waitFor(() => expect(f.picker()).not.toBe(catalog));
	}
	const picker = f.picker();
	const output = stripAnsi(picker.render(100).join("\n"));
	expect(output).toContain("Enter verify");
	expect(output).not.toContain("Add another account");
	if (saved) {
		// Accounts menu: the relabelled Reconnect row replaces the account-name
		// row and its trailing status; the hint carries the verify action.
		expect(output).toContain("Reconnect");
		expect(output).not.toContain("Needs verification");
	} else {
		expect(output).toContain("Needs verification");
	}
	if (!saved) expect(output).not.toContain("Remove saved data");
	picker.handleInput("\r");
	// The verify RAN, so the accounts menu re-enters freshly built: the failed
	// verification persisted the saved-account record, so even the (saved=false)
	// case now manages saved data instead of dropping to the prompt.
	const reopened = await nextPicker(f, picker);
	expect(reopened.getSearchInput()).toBeUndefined();
	const again = stripAnsi(reopened.render(100).join("\n"));
	expect(again).toContain("Remove saved data for http-proof");
	reopened.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
	// Global fetch is denied: this proves the existing verifier ran, not a login,
	// while keeping all tests offline and the failed verification honest.
	expect(fetch).toHaveBeenCalled();
	expect(f.store.get("http-proof")?.status).toBe("pending");
	expect(f.store.get("http-proof")?.lastError).toBeDefined();
	expect(f.store.get("http-proof")?.verifiedAt).toBeUndefined();
	expect(f.reload).toHaveBeenCalledOnce();
	// The failed verification outcome is a durable chat entry, never a login.
	expect(f.appendOutcome).toHaveBeenCalledOnce();
	expect(f.appendOutcome.mock.calls[0]?.[0]).toMatchObject({
		customType: "mcp_connection_outcome",
		details: { source: "retry", verification: "unverified" },
	});
	expect(f.authFlow).not.toHaveBeenCalled();
	expect(f.reserve).not.toHaveBeenCalled();
	expect(f.claim).not.toHaveBeenCalled();
	expect(process.env.ENG_6108_PRESENT_BEARER).toBe("synthetic-env-token");
});

it.each(["record", "credential-only"] as const)(
	"real nonOAuth HTTP %s cleanup removes saved data but keeps server settings and environment token",
	async (saved) => {
		const f = await settingsFixture();
		vi.stubEnv("ENG_6108_SAVED_BEARER", "");
		const config = { type: "http" as const, url: ENDPOINT, bearerTokenEnvVar: "ENG_6108_SAVED_BEARER" };
		f.harness.settingsManager.setGlobalMcpServer("http-proof", config, true);
		f.harness.authStorage.set("mcp:http-proof", {
			type: "oauth",
			access: "synthetic-saved-token",
			refresh: "r",
			endpoint: ENDPOINT,
			expires: Date.now() + 3600_000,
		});
		if (saved === "record") {
			f.store.upsert({
				connectionId: "http-proof",
				serviceId: "http-proof",
				endpoint: ENDPOINT,
				label: "HTTP",
				status: "error",
				createdAt: 1,
				updatedAt: 1,
			});
			await f.store.flush();
		}
		const done = f.mode.showServiceCatalogPicker("http-proof");
		const catalog = f.picker();
		// Credential-only + absent bearer has connectionIds=[] in the core view.
		// The UI still discovers real saved data without changing the core inventory.
		expect(stripAnsi(catalog.render(100).join("\n"))).toContain("Enter manage saved account");
		catalog.handleInput("\r");
		await vi.waitFor(() => expect(f.picker()).not.toBe(catalog));
		const accounts = f.picker();
		expect(stripAnsi(accounts.render(100).join("\n"))).toContain("Enter settings guidance");
		expect(stripAnsi(accounts.render(100).join("\n"))).not.toContain("Add another account");
		accounts.handleInput("\x1b[B");
		const output = stripAnsi(accounts.render(100).join("\n"));
		expect(output).toContain("Enter remove saved data");
		// The panel description now carries the settings-managed explainer
		// (asserted per wrapped line, ~50 columns like the onboarding copy).
		expect(output).toContain("Saved account data for a settings-managed server.");
		expect(output).toContain("environment token.");
		// Changing the environment does not change the meaning of saved-data cleanup.
		vi.stubEnv("ENG_6108_SAVED_BEARER", "synthetic-current-token");
		accounts.handleInput("\r");
		// The removal RAN and the service has no saved account left: the chain
		// re-enters the CATALOG, where the settings-managed server is still
		// visible — now honestly in its nothing-saved state.
		const reopened = await nextPicker(f, accounts);
		expect(reopened.getSearchInput()).toBeDefined();
		const after = stripAnsi(reopened.render(120).join("\n"));
		expect(after).toContain("http-proof");
		expect(after).not.toContain("Remove saved data");
		reopened.handleInput("\x1b");
		await done;
		expect(f.editorContainer.children).toEqual([f.editor]);
		expect(f.harness.authStorage.getVerified("mcp:http-proof")).toBeUndefined();
		expect(f.store.get("http-proof")).toBeUndefined();
		expect(f.harness.settingsManager.getGlobalMcpServers()?.["http-proof"]).toEqual(config);
		expect(process.env.ENG_6108_SAVED_BEARER).toBe("synthetic-current-token");
		expect(f.reload).toHaveBeenCalledOnce();
		expect(f.authFlow).not.toHaveBeenCalled();
		expect(f.reserve).not.toHaveBeenCalled();
		expect(f.claim).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	},
);

it("saved HTTP guidance stays inert if the bearer environment changes after rendering", async () => {
	const f = await settingsFixture();
	vi.stubEnv("ENG_6108_GUIDANCE_BEARER", "");
	f.harness.settingsManager.setGlobalMcpServer(
		"http-proof",
		{ type: "http", url: ENDPOINT, bearerTokenEnvVar: "ENG_6108_GUIDANCE_BEARER" },
		true,
	);
	f.store.upsert({
		connectionId: "http-proof",
		serviceId: "http-proof",
		endpoint: ENDPOINT,
		label: "HTTP",
		status: "pending",
		createdAt: 1,
		updatedAt: 1,
	});
	await f.store.flush();
	const done = f.mode.showServiceCatalogPicker("http-proof");
	const catalog = f.picker();
	catalog.handleInput("\r");
	await vi.waitFor(() => expect(f.picker()).not.toBe(catalog));
	const accounts = f.picker();
	expect(stripAnsi(accounts.render(100).join("\n"))).toContain("Enter settings guidance");
	vi.stubEnv("ENG_6108_GUIDANCE_BEARER", "synthetic-new-token");
	accounts.handleInput("\r");
	await done;
	expect(f.authFlow).not.toHaveBeenCalled();
	expect(f.reload).not.toHaveBeenCalled();
	expect(f.reserve).not.toHaveBeenCalled();
	expect(f.claim).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
	expect(f.store.get("http-proof")?.status).toBe("pending");
});

/**
 * A real-picker fixture whose service catalog comes from a declared LOCAL
 * catalog source file (the same resolution production uses), with the REAL
 * view builder, connect action, and paste flow — for driving the paste-panel
 * re-entry rows.
 */
async function localCatalogFixture(entries: Record<string, unknown>[]) {
	const file = writeLocalCatalog(entries);
	const f = await fixture([], { settings: { mcpCatalogSources: [file] } });
	Reflect.deleteProperty(f.mode, "buildServiceCatalogViews");
	Reflect.deleteProperty(f.mode, "connectServiceFromPicker");
	const showStatus = vi.fn();
	const reload = vi.fn(async () => {});
	const appendOutcome = vi.fn(async (_message: Record<string, unknown>) => {});
	const authFlow = vi.fn(() => {
		throw new Error("OAuth must not run for paste-only fixtures");
	});
	Object.assign(f.mode, {
		showStatus,
		handleReloadCommand: reload,
		createAuthFlows: authFlow,
		agentConnection: { appendCustomMessage: appendOutcome },
	});
	return { ...f, showStatus, reload, appendOutcome, authFlow };
}

const pasteEntry = {
	server: "paste-svc",
	service: "paste-svc",
	label: "Paste Service",
	url: PASTE_ENDPOINT,
	aliases: [],
	transport: { type: "http", url: PASTE_ENDPOINT },
	auth: { strategy: "api_key", clientRegistration: "unknown" },
	setup: {
		status: "requires-setup",
		reason: "Requires a paste token.",
		fields: [{ id: "PASTE_SVC_TOKEN", label: "Paste Service token", required: true, kind: "bearer-token" }],
	},
	verification: { status: "unverified" },
	legacyBuiltin: false,
	provenance: [{ source: "user" }],
};

it("a submitted paste token re-enters the accounts menu with the new account", async () => {
	const f = await localCatalogFixture([pasteEntry]);
	const done = f.mode.showServiceCatalogPicker("paste-svc");
	const catalog = f.picker();
	const output = stripAnsi(catalog.render(100).join("\n"));
	expect(output).toContain("Paste Service");
	catalog.handleInput("\r");
	// The paste panel mounts INLINE (never an overlay) over the editor.
	await vi.waitFor(() => expect(f.editorContainer.children[0]).toBeInstanceOf(McpTokenPastePanelComponent));
	const panel = f.editorContainer.children[0] as McpTokenPastePanelComponent;
	for (const character of "synthetic-pasted-token") panel.handleInput(character);
	panel.handleInput("\r");
	// The paste RAN and the service now owns an account: the accounts menu
	// re-enters — success or failure, the surface is state, not the verdict.
	const reopened = await nextPicker(f, catalog);
	expect(reopened.getSearchInput()).toBeUndefined();
	const again = stripAnsi(reopened.render(100).join("\n"));
	expect(again).toContain("Paste Service MCP");
	expect(again).toContain("Reconnect");
	expect(again).toContain("Disconnect");
	// The token is stored under the shared MCP credential key and never leaks
	// into the rendered surface.
	const credential = f.harness.authStorage.get("mcp:paste-svc");
	expect(credential).toMatchObject({ type: "mcp_static_token", bearer: "synthetic-pasted-token" });
	expect(again).not.toContain("synthetic-pasted-token");
	expect(f.appendOutcome).toHaveBeenCalledOnce();
	expect(f.appendOutcome.mock.calls[0]?.[0]).toMatchObject({
		customType: "mcp_connection_outcome",
		details: { source: "paste" },
	});
	reopened.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
});

it("Esc in the paste panel returns to the catalog that opened it", async () => {
	const f = await localCatalogFixture([pasteEntry]);
	const done = f.mode.showServiceCatalogPicker("paste-svc");
	const catalog = f.picker();
	catalog.handleInput("\r");
	await vi.waitFor(() => expect(f.editorContainer.children[0]).toBeInstanceOf(McpTokenPastePanelComponent));
	const panel = f.editorContainer.children[0] as McpTokenPastePanelComponent;
	panel.handleInput("\x1b");
	// Cancel stored NOTHING, so the surface that opened the panel — the
	// catalog — re-enters, not the prompt and not an empty accounts menu.
	const reopened = await nextPicker(f, catalog);
	expect(reopened.getSearchInput()).toBeDefined();
	for (const character of "paste-svc") reopened.handleInput(character);
	const again = stripAnsi(reopened.render(120).join("\n"));
	expect(again).toContain("Paste Service");
	expect(f.harness.authStorage.get("mcp:paste-svc")).toBeUndefined();
	expect(f.store.records()).toEqual([]);
	expect(f.appendOutcome).not.toHaveBeenCalled();
	reopened.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
});

it("a blocked action (login in progress) reports its status and never re-enters", async () => {
	const f = await settingsFixture();
	const now = Date.now();
	f.store.upsert({
		connectionId: "acme-work",
		serviceId: "acme",
		endpoint: ENDPOINT,
		label: "Work",
		status: "pending",
		createdAt: now,
		updatedAt: now,
		attemptId: "attempt-in-flight",
	});
	await f.store.flush();
	const done = f.mode.showServiceCatalogPicker("acme");
	const catalog = f.picker();
	catalog.handleInput("\r");
	const accounts = await nextPicker(f, catalog);
	expect(stripAnsi(accounts.render(100).join("\n"))).toContain("login in progress");
	accounts.handleInput("\r");
	// The action is blocked BEFORE it starts: the status line is the outcome
	// and the chain ends right there — no picker re-enters, no loop.
	await done;
	expect(f.showStatus).toHaveBeenCalledWith("Login in progress. Finish it or remove the account to cancel.");
	expect(f.editorContainer.children).toEqual([f.editor]);
	expect(f.appendOutcome).not.toHaveBeenCalled();
});

it("disconnecting one of several accounts re-enters that service's accounts menu without the removed row", async () => {
	// Re-entry decision (Kevin, live testing): the accounts menu is ONE
	// Reconnect/Disconnect pair for the whole service, so Enter on Disconnect
	// opens the account sub-picker; disconnecting the chosen account leaves a
	// sibling, so the SAME service's accounts menu reopens — freshly built,
	// the removed account gone and a fresh status read.
	const f = await settingsFixture();
	const now = Date.now();
	// "acme-work" sorts before "acme-zzz", so the store's file (written sorted)
	// keeps the row order deterministic after the disk reload in re-entry.
	const second = "acme-zzz";
	for (const id of ["acme-work", second]) {
		f.harness.authStorage.set(`mcp:${id}`, {
			type: "oauth",
			access: "synthetic",
			refresh: "r",
			expires: now + 3600_000,
			endpoint: ENDPOINT,
		});
		f.store.upsert({
			connectionId: id,
			serviceId: "acme",
			endpoint: ENDPOINT,
			label: id,
			status: "connected",
			verifiedAt: now,
			toolCount: 2,
			createdAt: now,
			updatedAt: now,
		});
	}
	await f.store.flush();
	const removeAccount = vi.spyOn(f.store, "removeAccount");
	const done = f.mode.showServiceCatalogPicker("acme");
	const catalog = f.picker();
	catalog.handleInput("\r");
	const accounts = await nextPicker(f, catalog);
	const before = stripAnsi(accounts.render(100).join("\n"));
	// The real flow pins a vanished-source service from the store, so the
	// header names the surviving record's label — the ROWS are what changed:
	// one Reconnect and one Disconnect for the whole service, no id pairs.
	expect(before).toContain("MCP");
	expect(before.indexOf("Reconnect")).toBeLessThan(before.indexOf("Disconnect"));
	expect(before).not.toContain("Reconnect acme-work");
	expect(before).not.toContain(`Reconnect ${second}`);
	accounts.handleInput("\x1b[B"); // → Disconnect (the service-wide chooser)
	accounts.handleInput("\r");
	// The account sub-picker: same choice-list shape, one row per account,
	// and Esc backs out instead of closing the chain.
	const sub = await nextPicker(f, accounts);
	expect(sub.getSearchInput()).toBeUndefined();
	const subOutput = stripAnsi(sub.render(100).join("\n"));
	expect(subOutput).toContain("Accounts");
	expect(subOutput).toContain("Esc back");
	expect(subOutput.indexOf("acme-work")).toBeLessThan(subOutput.indexOf(second));
	expect(subOutput).toContain("Enter disconnect");
	sub.handleInput("\r"); // → acme-work
	const reopened = await nextPicker(f, sub);
	// Same surface, rebuilt from the live store: acme-work is gone, the
	// sibling remains (single-account labels lose the id suffix).
	expect(reopened.getSearchInput()).toBeUndefined();
	const after = stripAnsi(reopened.render(100).join("\n"));
	expect(after).not.toContain("acme-work");
	expect(after).toContain("Reconnect");
	expect(after).toContain("Disconnect");
	expect(f.store.get("acme-work")).toBeUndefined();
	expect(f.store.get(second)).toBeDefined();
	expect(removeAccount).toHaveBeenCalledOnce();
	expect(f.appendOutcome).toHaveBeenCalledOnce();
	expect(f.appendOutcome.mock.calls[0]?.[0]).toMatchObject({
		details: { kind: "disconnect", connectionId: "acme-work" },
	});
	reopened.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
});

it("a cancelled add-another-account keeps the accounts menu open with no second account", async () => {
	const f = await settingsFixture();
	f.harness.settingsManager.setGlobalMcpServer("acme", { type: "http", url: ENDPOINT, oauth: true }, true);
	const now = Date.now();
	f.harness.authStorage.set("mcp:acme", {
		type: "oauth",
		access: "synthetic",
		refresh: "r",
		expires: now + 3600_000,
		endpoint: ENDPOINT,
	});
	f.store.upsert({
		connectionId: "acme",
		serviceId: "acme",
		endpoint: ENDPOINT,
		label: "Acme",
		status: "connected",
		verifiedAt: now,
		toolCount: 1,
		createdAt: now,
		updatedAt: now,
	});
	await f.store.flush();
	Object.assign(f.mode, { createAuthFlows: () => ({ runMcpLogin: vi.fn(async () => ({ status: "cancelled" })) }) });
	const done = f.mode.showServiceCatalogPicker("acme");
	const catalog = f.picker();
	catalog.handleInput("\r");
	const accounts = await nextPicker(f, catalog);
	expect(stripAnsi(accounts.render(100).join("\n"))).toContain("Add another account");
	accounts.handleInput("\x1b[B");
	accounts.handleInput("\x1b[B"); // → Add another account
	accounts.handleInput("\r");
	// Cancel still RAN a login attempt, so the accounts menu re-enters. The
	// guarded flow DELIBERATELY preserves the reserved shell for the new id
	// (no credential, no claim), so it shows as a removable second account.
	const reopened = await nextPicker(f, accounts);
	expect(reopened.getSearchInput()).toBeUndefined();
	const after = stripAnsi(reopened.render(100).join("\n"));
	expect(after).toContain("Reconnect");
	expect(after).toContain("Disconnect");
	// A settings-declared server lists only its own row in the accounts menu
	// (pre-existing view semantics); the preserved shell stays in the store,
	// claim released and no credential stored for the new id.
	expect(f.store.get("acme-2")?.attemptId).toBeUndefined();
	expect(f.harness.authStorage.get("mcp:acme-2")).toBeUndefined();
	expect(f.appendOutcome).not.toHaveBeenCalled();
	reopened.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
});

it("a cancelled connect from the catalog re-enters the accounts menu of its preserved shell", async () => {
	const f = await settingsFixture();
	f.harness.settingsManager.setGlobalMcpServer("acme", { type: "http", url: ENDPOINT, oauth: true }, true);
	Object.assign(f.mode, { createAuthFlows: () => ({ runMcpLogin: vi.fn(async () => ({ status: "cancelled" })) }) });
	const done = f.mode.showServiceCatalogPicker("acme");
	const catalog = f.picker();
	expect(stripAnsi(catalog.render(100).join("\n"))).toContain("Enter connect");
	catalog.handleInput("\r");
	// The login was cancelled, and the guarded flow DELIBERATELY preserves the
	// reserved pending shell (no credential, no claim). Something IS stored,
	// so the chain re-enters that service's accounts menu — where the shell
	// can be re-verified or removed — never the prompt.
	const reopened = await nextPicker(f, catalog);
	expect(reopened.getSearchInput()).toBeUndefined();
	const after = stripAnsi(reopened.render(100).join("\n"));
	expect(after).toContain("Reconnect");
	expect(after).toContain("Disconnect");
	expect(f.store.get("acme")?.attemptId).toBeUndefined();
	expect(f.harness.authStorage.get("mcp:acme")).toBeUndefined();
	expect(f.appendOutcome).not.toHaveBeenCalled();
	reopened.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
});

it("a committed connect from the catalog re-enters the accounts menu for the service just connected", async () => {
	const f = await settingsFixture();
	f.harness.settingsManager.setGlobalMcpServer("acme", { type: "http", url: ENDPOINT, oauth: true }, true);
	const now = Date.now();
	Object.assign(f.mode, {
		createAuthFlows: () => ({
			runMcpLogin: vi.fn(async (serverId: string) => {
				// The staged login writes the STAGED credential; the guarded
				// finalize moves it to the real account key.
				f.harness.authStorage.set(`mcp:${serverId}`, {
					type: "oauth",
					access: "new-grant",
					refresh: "r",
					expires: now + 3600_000,
					endpoint: ENDPOINT,
				});
				return { status: "success" as const };
			}),
		}),
	});
	const done = f.mode.showServiceCatalogPicker("acme");
	const catalog = f.picker();
	catalog.handleInput("\r");
	// The login committed: the service now owns an account, so the ACCOUNTS
	// menu re-enters for it (offline verification is honestly unverified).
	const reopened = await nextPicker(f, catalog);
	expect(reopened.getSearchInput()).toBeUndefined();
	const after = stripAnsi(reopened.render(100).join("\n"));
	expect(after).toContain("Reconnect");
	expect(after).toContain("Disconnect");
	expect(f.store.get("acme")).toBeDefined();
	expect(f.harness.authStorage.getVerified("mcp:acme")).toBeDefined();
	expect(f.appendOutcome).toHaveBeenCalledOnce();
	reopened.handleInput("\x1b");
	await done;
	expect(f.editorContainer.children).toEqual([f.editor]);
});
