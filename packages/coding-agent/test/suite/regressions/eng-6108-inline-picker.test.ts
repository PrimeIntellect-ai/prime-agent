import { join } from "node:path";
import { type Component, Container, Input, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import { McpConnectionStore } from "../../../src/core/mcp/connection-store.js";
import type { McpPluginView, McpServiceDescriptor } from "../../../src/core/mcp/service-catalog.js";
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
	vi.unstubAllGlobals();
});

const ENDPOINT = "https://acme.example.test/mcp";
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
	): Promise<void>;
	selectServiceCatalogRow(views: McpPluginView[]): Promise<McpPluginView | undefined>;
	closeServiceCatalogPicker?: () => void;
}
async function fixture(views: McpPluginView[] = [view()]) {
	const harness = await createHarness({ models: [{ id: "offline", name: "Offline" }] });
	harnesses.push(harness);
	const store = McpConnectionStore.open(join(harness.tempDir, "connections.json"));
	const editor = new Input();
	editor.setValue("preserved draft");
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const setFocus = vi.fn();
	const showError = vi.fn();
	const connect = vi.fn(async (_view: McpPluginView, _target: Target | undefined, _options: ActionOptions) => true);
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
	}) as unknown as PickerHost;
	const picker = () => {
		const component = editorContainer.children[0];
		expect(component).toBeInstanceOf(ServiceCatalogPickerComponent);
		return component as ServiceCatalogPickerComponent;
	};
	return { harness, store, editor, editorContainer, mode, picker, connect, setFocus, showError };
}

it("mounts catalog inline, preserves prefill and cancels without auth or draft loss", async () => {
	const f = await fixture([view(), view({ serviceId: "other", label: "Other" })]);
	const done = f.mode.showServiceCatalogPicker("acme");
	const picker = f.picker();
	expect(picker.getSearchInput().getValue()).toBe("acme");
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
		return true;
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
	await done;
	expect(f.connect).toHaveBeenCalledOnce();
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
	await expect(first).resolves.toBeUndefined();
	stale.handleInput("\r");
	oldClose?.();
	expect(f.editorContainer.children).toEqual([next]);
	next.handleInput("\x1b");
	await expect(second).resolves.toBeUndefined();
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
	expect(output).toContain("Accounts — Acme");
	expect(output).toContain("Needs verification");
	expect(output).toContain("Enter verify");
	expect(output).not.toContain("Connected");
	accounts.handleInput("\r");
	await done;
	expect(f.connect).toHaveBeenCalledOnce();
	expect(f.connect.mock.calls[0]?.[0]).toMatchObject({ serviceId: "acme-work", connectionStatus: "pending" });
	expect(f.connect.mock.calls[0]?.[2]).toEqual({ catalogServiceId: "acme" });
	expect(f.editor.getValue()).toBe("preserved draft");
});

it.each(["remove", "add"] as const)("keeps the %s action and identifiers unchanged", async (action) => {
	const f = await fixture();
	const done = f.mode.showAccountPickerForService(
		view({ connectionIds: ["acme-work"] }),
		{ url: ENDPOINT, usesOAuth: true, managedBySettings: false },
		{ knownIds: new Set(["acme"]) },
	);
	const accounts = f.picker();
	accounts.handleInput("\x1b[B");
	if (action === "add") accounts.handleInput("\x1b[B");
	accounts.handleInput("\r");
	await done;
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
