/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type SpanAttributes, withSpan } from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import type { Jiti, JitiOptions } from "jiti";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.js";
import { createEventBus, type EventBus } from "../event-bus.js";
import type { ExecOptions } from "../exec.js";
import { execCommand } from "../exec.js";
import { createSyntheticSourceInfo } from "../source-info.js";
// runner.ts imports disposeExtension from this module; both bindings are only
// dereferenced at call time, so the cycle is harmless under ESM live bindings.
import { extensionSpanLabel } from "./runner.js";
import type {
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ScheduledWorkInfo,
	ToolDefinition,
} from "./types.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const extensionDisposals = new WeakMap<Extension, Set<() => void>>();

/** Extension imports slower than this get their own `extensions.<label>_ms` span attribute. */
const SLOW_EXTENSION_LOAD_MS = 100;

/** Per-load timing accumulator behind the `extensions.load` span. */
class ExtensionLoadTiming {
	private errors = 0;
	private readonly byExtension = new Map<string, number>();
	private slowestMs = -1;
	private slowestLabel: string | undefined;

	record(extensionPath: string, durationMs: number, failed: boolean): void {
		if (failed) this.errors += 1;
		const label = extensionSpanLabel(extensionPath);
		this.byExtension.set(label, (this.byExtension.get(label) ?? 0) + durationMs);
		if (durationMs > this.slowestMs) {
			this.slowestMs = durationMs;
			this.slowestLabel = label;
		}
	}

	attributes(): SpanAttributes {
		const attrs: SpanAttributes = { "extensions.errors": this.errors };
		if (this.slowestLabel !== undefined) {
			attrs["extensions.slowest"] = this.slowestLabel;
			attrs["extensions.slowest_ms"] = Math.round(this.slowestMs);
		}
		for (const [label, ms] of this.byExtension) {
			if (ms > SLOW_EXTENSION_LOAD_MS) attrs[`extensions.${label}_ms`] = Math.round(ms);
		}
		return attrs;
	}
}

export function disposeExtension(extension: Extension): void {
	const disposals = extensionDisposals.get(extension);
	if (!disposals) return;
	for (const dispose of disposals) dispose();
	disposals.clear();
}

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function expandPath(p: string): string {
	const normalized = normalizeUnicodeSpaces(p);
	if (normalized.startsWith("~/")) {
		return path.join(os.homedir(), normalized.slice(2));
	}
	if (normalized.startsWith("~")) {
		return path.join(os.homedir(), normalized.slice(1));
	}
	return normalized;
}

function resolvePath(extPath: string, cwd: string): string {
	const expanded = expandPath(extPath);
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const state: { staleMessage?: string } = {};
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		queueExtensionFollowUp: notInitialized,
		cancelExtensionFollowUp: notInitialized,
		// Declaring scheduled work during load is legal but has no host to record
		// it yet; bindCore() replaces these with the session-backed handlers.
		setScheduledWork: () => {},
		clearScheduledWork: () => {},
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		assertActive,
		invalidate: (message) => {
			state.staleMessage ??=
				message ??
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
		},
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		unregisterProvider: (name, extensionPath) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter(
				(registration) =>
					registration.name !== name ||
					(extensionPath !== undefined && registration.extensionPath !== extensionPath),
			);
		},
	};

	return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): ExtensionAPI {
	extensionDisposals.get(extension)?.add(() => {
		try {
			runtime.cancelExtensionFollowUp(extension);
		} catch {
			// The factory can fail before runtime actions are bound.
		}
	});

	const api = {
		on(event: string, handler: HandlerFn): void {
			runtime.assertActive();
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			runtime.assertActive();
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			runtime.assertActive();
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.js").ExtensionContext) => Promise<void> | void;
			},
		): void {
			runtime.assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			runtime.assertActive();
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				runtime.flagValues.set(name, options.default);
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			runtime.assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		getFlag(name: string): boolean | string | undefined {
			runtime.assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.get(name);
		},

		sendMessage(message, options): void {
			runtime.assertActive();
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			runtime.assertActive();
			runtime.sendUserMessage(content, options);
		},

		queueFollowUp(key, content, options) {
			runtime.assertActive();
			return runtime.queueExtensionFollowUp(extension, key, content, options);
		},

		cancelFollowUp(key): boolean {
			runtime.assertActive();
			return runtime.cancelExtensionFollowUp(extension, key);
		},

		setScheduledWork(key: string, work?: ScheduledWorkInfo): void {
			runtime.assertActive();
			runtime.setScheduledWork(key, work);
		},

		clearScheduledWork(key: string): void {
			runtime.assertActive();
			runtime.clearScheduledWork(key);
		},

		appendEntry(customType: string, data?: unknown): void {
			runtime.assertActive();
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void | Promise<void> {
			runtime.assertActive();
			return runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			runtime.assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			runtime.assertActive();
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			runtime.assertActive();
			// Read the host-supplied env at call time so per-session vars (e.g.
			// herdr pane identity) are current, then let an explicit options.env win.
			const sessionEnv = runtime.getExecEnv?.();
			const env = sessionEnv || options?.env ? { ...sessionEnv, ...options?.env } : undefined;
			return execCommand(command, args, options?.cwd ?? cwd, { ...options, env });
		},

		getActiveTools(): string[] {
			runtime.assertActive();
			return runtime.getActiveTools();
		},

		getAllTools() {
			runtime.assertActive();
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			runtime.assertActive();
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			runtime.assertActive();
			return runtime.getCommands();
		},

		setModel(model) {
			runtime.assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			runtime.assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			runtime.assertActive();
			runtime.setThinkingLevel(level);
		},

		registerProvider(name: string, config: ProviderConfig) {
			runtime.assertActive();
			runtime.registerProvider(name, config, extension.path);
			extensionDisposals.get(extension)?.add(() => runtime.unregisterProvider(name, extension.path));
		},

		unregisterProvider(name: string) {
			runtime.assertActive();
			runtime.unregisterProvider(name, extension.path);
		},

		events: {
			emit: (channel, data) => eventBus.emit(channel, data),
			on: (channel, handler) => {
				runtime.assertActive();
				const unsubscribe = eventBus.on(channel, handler);
				extensionDisposals.get(extension)?.add(unsubscribe);
				return () => {
					extensionDisposals.get(extension)?.delete(unsubscribe);
					unsubscribe();
				};
			},
		},
	} as ExtensionAPI;

	return api;
}

/** Context jiti's public factories pass to its internal `createJiti`. */
interface JitiContext {
	onError: (error: Error) => never;
	nativeImport: (id: string | URL) => Promise<unknown>;
	createRequire: typeof createRequire;
}

type InternalCreateJiti = (id: string, options: JitiOptions, context: JitiContext) => Jiti;

interface JitiInternals {
	createJiti: InternalCreateJiti;
	transform: NonNullable<JitiOptions["transform"]>;
}

let jitiInternalsPromise: Promise<JitiInternals | undefined> | undefined;

function jitiInternals(): Promise<JitiInternals | undefined> {
	if (!jitiInternalsPromise) jitiInternalsPromise = loadJitiInternals();
	return jitiInternalsPromise;
}

/**
 * jiti's public factories (`jiti`, `jiti/static`) hard-wire `nativeImport` to
 * `import()`. That hook is the only way to keep an ESM `.js` file (`.mjs`, or
 * `.js` inside a `"type": "module"` package) out of Node's loader: jiti 2.x
 * hands every such file imported asynchronously to `nativeImport` instead of
 * transpiling it, and a native import never consults `virtualModules`, so a
 * prebuilt extension gets its own `node_modules` copy of pi-ai (private API
 * registry, private trace context, ~80 ms to evaluate) instead of the host
 * instance. The internal factory jiti's wrappers call takes the hook as a
 * parameter, so resolve it from the installed package. Undefined where the
 * package files are not on disk (compiled Bun binary).
 */
async function loadJitiInternals(): Promise<JitiInternals | undefined> {
	try {
		const requireFromHere = createRequire(import.meta.url);
		const jitiDir = path.dirname(requireFromHere.resolve("jiti/package.json"));
		const createJiti = requireFromHere(path.join(jitiDir, "dist", "jiti.cjs")) as InternalCreateJiti;
		const transform = requireFromHere(path.join(jitiDir, "dist", "babel.cjs")) as JitiInternals["transform"];
		return typeof createJiti === "function" && typeof transform === "function"
			? { createJiti, transform }
			: undefined;
	} catch {
		return undefined;
	}
}

/** jiti resolves `.js` in a `"type": "module"` package and `.mjs` as native ESM. */
const NATIVE_ESM_EXTENSIONS = new Set([".js", ".mjs"]);

function realpathOrSelf(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

/** Nearest directory with a package.json above `entryPath`, else its own directory. */
function extensionPackageRoot(entryPath: string): string {
	const start = path.dirname(entryPath);
	let dir = start;
	while (true) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
}

/**
 * Predicate for the ESM files an extension owns: `.js`/`.mjs` under the
 * extension's package root, excluding anything under a `node_modules`
 * directory (third-party dependencies keep resolving and loading natively
 * from the extension's own `node_modules`).
 */
function extensionOwnedEsmFile(entryPath: string): (id: string | URL) => boolean {
	const root = realpathOrSelf(extensionPackageRoot(entryPath)) + path.sep;
	return (id) => {
		const spec = typeof id === "string" ? id : id.href;
		let file: string;
		if (spec.startsWith("file:")) {
			file = fileURLToPath(spec);
		} else if (path.isAbsolute(spec)) {
			file = spec;
		} else {
			return false;
		}
		if (!NATIVE_ESM_EXTENSIONS.has(path.extname(file))) return false;
		const real = realpathOrSelf(file);
		return real.startsWith(root) && !real.slice(root.length).split(path.sep).includes("node_modules");
	};
}

async function createExtensionJiti(entryPath: string): Promise<Jiti> {
	const options: JitiOptions = {
		moduleCache: false,
		// Serve pi packages from virtualModules in every mode so extensions share
		// the host's live module instances. Path aliases are not equivalent: with
		// moduleCache disabled, jiti re-evaluates an aliased file into a second,
		// divergent module instance, so host-registered API providers (custom
		// provider transports) vanish inside extensions and calls fail with
		// "No API provider registered for api: <api>". tryNative is disabled so
		// jiti handles ALL imports (not just the entry point).
		virtualModules: (await import("./bundled-modules.js")).VIRTUAL_MODULES,
		tryNative: false,
	};
	const internals = await jitiInternals();
	if (!internals) {
		const { createJiti } = await import("jiti/static");
		return createJiti(import.meta.url, options);
	}
	const owned = extensionOwnedEsmFile(entryPath);
	return internals.createJiti(
		import.meta.url,
		{ ...options, transform: internals.transform },
		{
			onError: (error) => {
				throw error;
			},
			// Refusing the native import of an extension-owned ESM file makes jiti
			// take its fallback for a failed native import: transpile the file, which
			// routes its imports (static and dynamic) through virtualModules like a
			// .ts entry. Everything else (node: builtins, data: URLs, third-party
			// dependencies) imports natively as before.
			nativeImport: (id) =>
				owned(id)
					? Promise.reject(new Error("extension-owned ESM module is transpiled by jiti to share host modules"))
					: import(typeof id === "string" ? id : id.href),
			createRequire,
		},
	);
}

/**
 * Pay the one-time cost of the lazy loader imports (jiti + the bundled host
 * module graph) up front so `extensions.load` attributes it to
 * `extensions.loader_ms` instead of to whichever extension happens to be
 * imported first. Same modules, same order of first use; a failure here is
 * ignored because loadExtensionModule reports it per extension as before.
 */
async function warmExtensionModuleLoader(): Promise<void> {
	try {
		if (!(await jitiInternals())) await import("jiti/static");
		await import("./bundled-modules.js");
	} catch {
		// Surfaced by the per-extension load below.
	}
}

async function loadExtensionModule(extensionPath: string) {
	// jiti and the bundled virtual modules are loaded lazily so that importing
	// the loader (which nearly every startup path does transitively) doesn't pay
	// for the full package graph; the specifiers are literals, so Bun still
	// bundles them into the compiled binary.
	// The entry is imported by its real path so a symlinked extension resolves
	// bare specifiers from its real location, exactly as a native import would.
	const entryPath = realpathOrSelf(extensionPath);
	const jiti = await createExtensionJiti(entryPath);

	const module = await jiti.import(entryPath, { default: true });
	const factory = module as ExtensionFactory;
	return typeof factory !== "function" ? undefined : factory;
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	const disposals = new Set<() => void>();
	const extension: Extension = {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	extensionDisposals.set(extension, disposals);
	return extension;
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd);

	try {
		const factory = await loadExtensionModule(resolvedPath);
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = createExtension(extensionPath, resolvedPath);
		const api = createExtensionAPI(extension, runtime, cwd, eventBus);
		try {
			await factory(api);
		} catch (error) {
			disposeExtension(extension);
			throw error;
		}

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const extension = createExtension(extensionPath, extensionPath);
	const api = createExtensionAPI(extension, runtime, cwd, eventBus);
	try {
		await factory(api);
	} catch (error) {
		disposeExtension(extension);
		throw error;
	}
	return extension;
}

/**
 * Load extensions from paths.
 */
export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult> {
	// One `extensions.load` span per call (attrs: `extensions.count`,
	// `extensions.loader_ms`, `extensions.errors`, `extensions.slowest`,
	// `extensions.slowest_ms`, and `extensions.<label>_ms` for imports slower
	// than SLOW_EXTENSION_LOAD_MS).
	// Load failures stay in `errors` exactly as before; tracing never throws.
	return withSpan("extensions.load", { "extensions.count": paths.length }, async (span) => {
		const extensions: Extension[] = [];
		const errors: Array<{ path: string; error: string }> = [];
		const resolvedEventBus = eventBus ?? createEventBus();
		const runtime = createExtensionRuntime();
		const timing = new ExtensionLoadTiming();

		if (paths.length > 0) {
			const loaderStarted = performance.now();
			await warmExtensionModuleLoader();
			span.setAttributes({ "extensions.loader_ms": Math.round(performance.now() - loaderStarted) });
		}

		for (const extPath of paths) {
			const started = performance.now();
			const { extension, error } = await loadExtension(extPath, cwd, resolvedEventBus, runtime);
			try {
				timing.record(extPath, performance.now() - started, error !== null);
			} catch {
				// Timing bookkeeping must never affect the load result.
			}

			if (error) {
				errors.push({ path: extPath, error });
				continue;
			}

			if (extension) {
				extensions.push(extension);
			}
		}

		try {
			span.setAttributes(timing.attributes());
		} catch {
			// Attribute reporting must never affect the load result.
		}
		return {
			extensions,
			errors,
			runtime,
		};
	});
}

interface PiManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
	prompts?: string[];
}

function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const content = fs.readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content);
		if (pkg.pi && typeof pkg.pi === "object") {
			return pkg.pi as PiManifest;
		}
		return null;
	} catch {
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pi" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	const localExtDir = path.join(cwd, CONFIG_DIR_NAME, "extensions");
	addPaths(discoverExtensionsInDir(localExtDir));

	const globalExtDir = path.join(agentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir));

	for (const p of configuredPaths) {
		const resolved = resolvePath(p, cwd);
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			addPaths(discoverExtensionsInDir(resolved));
			continue;
		}

		addPaths([resolved]);
	}

	return loadExtensions(allPaths, cwd, eventBus);
}
