import { randomUUID } from "node:crypto";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "./rpc-types.js";

export interface RpcExtensionUiBridge {
	uiContext: ExtensionUIContext;
	handleResponse(response: RpcExtensionUIResponse): boolean;
	close(): void;
}

export function createRpcExtensionUiBridge(output: (request: RpcExtensionUIRequest) => void): RpcExtensionUiBridge {
	const pending = new Map<string, (response: RpcExtensionUIResponse) => void>();
	let closed = false;

	const createDialogPromise = <T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> => {
		if (closed || opts?.signal?.aborted) {
			return Promise.resolve(defaultValue);
		}
		const id = randomUUID();
		return new Promise((resolve) => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timeout) clearTimeout(timeout);
				opts?.signal?.removeEventListener("abort", onAbort);
				pending.delete(id);
			};
			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout) {
				timeout = setTimeout(onAbort, opts.timeout);
			}
			pending.set(id, (response) => {
				cleanup();
				resolve(parseResponse(response));
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	};

	const fireAndForget = (request: Record<string, unknown>) => {
		output({ type: "extension_ui_request", id: randomUUID(), ...request } as RpcExtensionUIRequest);
	};

	const uiContext: ExtensionUIContext = {
		select: (title, options, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{ method: "select", title, options, timeout: opts?.timeout },
				(response) =>
					"cancelled" in response && response.cancelled
						? undefined
						: "value" in response
							? response.value
							: undefined,
			),
		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (response) =>
				"cancelled" in response && response.cancelled
					? false
					: "confirmed" in response
						? response.confirmed
						: false,
			),
		input: (title, placeholder, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{ method: "input", title, placeholder, timeout: opts?.timeout },
				(response) =>
					"cancelled" in response && response.cancelled
						? undefined
						: "value" in response
							? response.value
							: undefined,
			),
		notify: (message, notifyType) => fireAndForget({ method: "notify", message, notifyType }),
		onTerminalInput: () => () => {},
		setStatus: (statusKey, statusText) => fireAndForget({ method: "setStatus", statusKey, statusText }),
		setWorkingMessage: (_message?: string) => {},
		setWorkingVisible: (_visible: boolean) => {},
		setWorkingIndicator: (_options?: WorkingIndicatorOptions) => {},
		setHiddenThinkingLabel: (_label?: string) => {},
		setWidget: (widgetKey: string, content: unknown, options?: ExtensionWidgetOptions) => {
			if (content === undefined || Array.isArray(content)) {
				fireAndForget({
					method: "setWidget",
					widgetKey,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				});
			}
		},
		setFooter: (_factory: unknown) => {},
		setHeader: (_factory: unknown) => {},
		setTitle: (title) => fireAndForget({ method: "setTitle", title }),
		custom: async () => undefined as never,
		pasteToEditor(text) {
			this.setEditorText(text);
		},
		setEditorText: (text) => fireAndForget({ method: "set_editor_text", text }),
		getEditorText: () => "",
		editor: (title, prefill) =>
			createDialogPromise(undefined, undefined, { method: "editor", title, prefill }, (response) =>
				"cancelled" in response && response.cancelled
					? undefined
					: "value" in response
						? response.value
						: undefined,
			),
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: (_name: string) => undefined,
		setTheme: (_theme: string | Theme) => ({ success: false, error: "Theme switching not supported in RPC mode" }),
		getToolsExpanded: () => false,
		setToolsExpanded: (_expanded: boolean) => {},
	};

	return {
		uiContext,
		handleResponse(response) {
			const resolve = pending.get(response.id);
			if (!resolve) {
				return false;
			}
			pending.delete(response.id);
			resolve(response);
			return true;
		},
		close() {
			closed = true;
			for (const [id, resolve] of pending) {
				resolve({ type: "extension_ui_response", id, cancelled: true });
			}
			pending.clear();
		},
	};
}
