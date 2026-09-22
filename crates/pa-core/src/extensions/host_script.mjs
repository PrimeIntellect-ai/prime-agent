// Extension host script, stage 2 (protocol 2).
//
// The Rust half of this pair is `crates/pa-core/src/extensions/`
// (`host.rs` spawns this script and owns the lifecycle; `client.rs` +
// `framing.rs` own the dispatch; `script.rs` materializes this bundle next
// to the vendored jiti runtime). Design: `docs/extensions-runner-design.md`
// §2.2-2.3. The protocol is private and versioned; both ends ship in the
// same release, so they always match.
//
// Stage 2 turns the stage-1 protocol peer into the extension runtime:
//   - `hello` loads every resolved extension path with jiti/static
//     (`moduleCache: false`, same loader as the TS product), runs each
//     module's default factory against the `pi` API object, and reports the
//     registrations that landed (tools, commands, flags, shortcuts,
//     message-renderer types, providers) plus per-path load errors.
//   - Post-hello registration methods forward a `registration` notification.
//   - `tool_execute` dispatches a registered tool's `execute` with a ctx
//     whose action methods call back into the host (`ctxToken` RPC);
//     `onUpdate` streams `tool_update` notifications.
//   - `event` dispatches handlers in load/registration order through the
//     error boundary (chaining semantics per event type are stage 3).
//   - `command_execute`/`shortcut_execute` dispatch registered handlers.
//   - `shutdown` emits `session_shutdown` to handlers, then exits.
//
// Import aliasing (TS loader.ts `getAliases` / bundled-modules.ts): the
// `@earendil-works/*`, `@mariozechner/*`, and `typebox` specifiers resolve
// to the shim modules materialized next to this script. `typebox` /
// `pi-ai` get a real Type builder (JSON-Schema-compatible schemas) and
// `pi-coding-agent` the `defineTool` identity; packages with no
// sidecar-representable surface resolve to the empty `unsupported` module,
// whose absent exports degrade to `undefined` at use (v1 documented
// degradation, design doc §2.6/R3).
//
// Wire: newline-delimited JSON over stdio, both directions.
//   host -> sidecar: `{"id":N,"method":...,"params":...}` requests,
//                    `{"method":...,"params":...}` notifications (no reply).
//   sidecar -> host: `{"id":N,"result":...}` / `{"id":N,"error":{...}}` replies,
//                    `{"ctxToken":...,"method":...,"params":...}` ctx requests,
//                    `{"method":...,"params":...}` notifications
//                    (`extension_error`, `registration`, `tool_update`).
// Requests are handled one at a time in arrival order; a hanging handler
// is abandoned by the host's per-request timeout and the process kill.

import readline from "node:readline";

// Keep in sync with `pa_types::extension_rpc::EXTENSION_RPC_PROTOCOL`.
const PROTOCOL = 2;
// Keep in sync with `EXTENSION_HOST_NODE_MAJOR_FLOOR`.
const NODE_FLOOR = 18;

// The exact TS loader strings (loader.ts loadExtension / loadExtensions):
// user-visible copy, keep byte-identical.
const FACTORY_ERROR = (p) => `Extension does not export a valid factory function: ${p}`;
const LOAD_ERROR = (message) => `Failed to load extension: ${message}`;
const NOT_INITIALIZED =
  "Extension runtime not initialized. Action methods cannot be called during extension loading.";

function nodeMajor() {
  return Number(process.versions.node.split(".")[0] || 0);
}

function writeLine(value, done) {
  process.stdout.write(JSON.stringify(value) + "\n", done);
}

function writeReply(id, result, error, done) {
  const envelope = error !== undefined ? { id, error } : { id, result };
  process.stdout.write(JSON.stringify(envelope) + "\n", done);
}

function notify(method, params) {
  writeLine({ method, params });
}

function reportError(extensionPath, event, error) {
  const err = error instanceof Error ? error : new Error(String(error));
  notify("extension_error", {
    extensionPath,
    event,
    error: err.message,
    stack: err.stack,
  });
}

// Drop non-JSON values (functions, symbols) from values that cross the wire:
// TypeBox schemas are JSON, but a custom schema may carry helpers.
function sanitize(value) {
  return JSON.parse(
    JSON.stringify(value, (key, item) => (typeof item === "function" ? undefined : item)),
  );
}

// --- ctx RPC (sidecar -> host) ----------------------------------------------

// ctxToken -> { resolve, reject } for ctx calls awaiting a host reply.
const pendingCtx = new Map();

function callCtx(method, params) {
  const ctxToken = `ctx-${++ctxCounter}`;
  return new Promise((resolve, reject) => {
    pendingCtx.set(ctxToken, { resolve, reject });
    writeLine({ ctxToken, method, params });
  });
}
let ctxCounter = 0;

function settleCtxReply(line) {
  const settled = pendingCtx.get(line.ctxToken);
  if (!settled) return false;
  pendingCtx.delete(line.ctxToken);
  if (line.error !== undefined) {
    settled.reject(Object.assign(new Error(line.error.message), line.error));
  } else {
    settled.resolve(line.result);
  }
  return true;
}

// --- host timers (TS runner.ts createTimerBindings: same error boundary) ----

const activeTimers = new Set();

function hostTimer(kind, ownerPath, callback, ms) {
  const handle = kind === "setTimeout" ? setTimeout(run, ms) : setInterval(run, ms);
  function clear() {
    clearTimeout(handle);
    clearInterval(handle);
    activeTimers.delete(clear);
  }
  function run() {
    if (kind === "setTimeout") clear();
    try {
      Promise.resolve(callback()).catch((err) =>
        reportError(ownerPath, `ctx.${kind}`, err),
      );
    } catch (err) {
      reportError(ownerPath, `ctx.${kind}`, err);
    }
  }
  activeTimers.add(clear);
  return handle;
}

function clearHostTimers() {
  for (const clear of activeTimers) clear();
}

// --- the loaded extension world ---------------------------------------------

// One entry per successfully loaded extension, in load order. The shape
// mirrors the TS `Extension` object (loader.ts createExtension): live
// functions stay here, the serializable registration crosses the wire.
function createExtensionState(extensionPath, resolvedPath) {
  return {
    path: extensionPath,
    resolvedPath,
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
    providers: [],
  };
}

const extensions = [];
// Extension-path -> state; registrations from a runtime notification replace
// one extension's contribution.
const extensionsByPath = new Map();
// Flag values: CLI-provided values (hello `flagValues`) seed the map so they
// override registered defaults, matching the TS `setFlagValue` end state.
const flagValues = new Map();

// The shared cross-extension event bus (TS core/event-bus.ts createEventBus).
const eventBus = (() => {
  const channels = new Map();
  return {
    emit(channel, data) {
      const listeners = channels.get(channel) || [];
      for (const listener of listeners) listener(data);
    },
    on(channel, handler) {
      const list = channels.get(channel) || [];
      list.push(handler);
      channels.set(channel, list);
      return () => {
        const next = (channels.get(channel) || []).filter((h) => h !== handler);
        channels.set(channel, next);
      };
    },
  };
})();

// `runtime` mirrors loader.ts createExtensionRuntime: action methods throw
// the fixed not-initialized message until the load cycle finished (bindCore
// equivalent); afterwards they call the host over ctx RPC.
let runtimeBound = false;

function actionMethod(name) {
  return (...args) => {
    if (!runtimeBound) {
      throw new Error(NOT_INITIALIZED);
    }
    return callCtx(name, sanitize({ args }));
  };
}

function piApiFor(extension) {
  const assertActive = () => {};
  const api = {
    on(event, handler) {
      assertActive();
      const list = extension.handlers.get(event) ?? [];
      list.push(handler);
      extension.handlers.set(event, list);
      if (runtimeBound) registrationChanged(extension);
    },
    registerTool(tool) {
      assertActive();
      extension.tools.set(tool.name, tool);
      if (runtimeBound) registrationChanged(extension);
    },
    registerCommand(name, options) {
      assertActive();
      extension.commands.set(name, { name, ...options });
      if (runtimeBound) registrationChanged(extension);
    },
    registerShortcut(key, options) {
      assertActive();
      extension.shortcuts.set(key, { key, extensionPath: extension.path, ...options });
      if (runtimeBound) registrationChanged(extension);
    },
    registerFlag(name, options) {
      assertActive();
      extension.flags.set(name, { name, extensionPath: extension.path, ...options });
      if (options.default !== undefined && !flagValues.has(name)) {
        flagValues.set(name, options.default);
      }
      if (runtimeBound) registrationChanged(extension);
    },
    registerMessageRenderer(customType, renderer) {
      assertActive();
      extension.messageRenderers.set(customType, renderer);
      if (runtimeBound) registrationChanged(extension);
    },
    getFlag(name) {
      assertActive();
      if (!extension.flags.has(name)) return undefined;
      return flagValues.get(name);
    },
    // Action methods: pre-bind throwing stubs (TS createExtensionRuntime),
    // post-load ctx RPC. Signatures match the TS ExtensionAPI; the arguments
    // cross the wire sanitized.
    sendMessage: actionMethod("send_message"),
    sendUserMessage: actionMethod("send_user_message"),
    appendEntry: actionMethod("append_entry"),
    setSessionName: actionMethod("set_session_name"),
    getSessionName: actionMethod("get_session_name"),
    setLabel: actionMethod("set_label"),
    exec: actionMethod("exec"),
    getActiveTools: actionMethod("get_active_tools"),
    getAllTools: actionMethod("get_all_tools"),
    setActiveTools: actionMethod("set_active_tools"),
    getCommands: actionMethod("get_commands"),
    setModel: actionMethod("set_model"),
    getThinkingLevel: actionMethod("get_thinking_level"),
    setThinkingLevel: actionMethod("set_thinking_level"),
    registerProvider(name, config) {
      assertActive();
      if (config && (config.streamSimple || config.oauth)) {
        reportError(
          extension.path,
          "register_provider",
          new Error(
            `registerProvider('${name}') with streamSimple/oauth is not supported in the Rust extension host (v1)`,
          ),
        );
        return;
      }
      extension.providers = extension.providers.filter((p) => p.name !== name);
      extension.providers.push({ name, config });
      if (runtimeBound) registrationChanged(extension);
    },
    unregisterProvider(name) {
      assertActive();
      extension.providers = extension.providers.filter((p) => p.name !== name);
      if (runtimeBound) registrationChanged(extension);
    },
    events: eventBus,
  };
  return api;
}

function registrationOf(extension) {
  const tools = [];
  for (const tool of extension.tools.values()) {
    const wire = {
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description ?? "",
      parameters: sanitize(tool.parameters ?? { type: "object" }),
    };
    if (tool.promptSnippet !== undefined) wire.promptSnippet = tool.promptSnippet;
    if (tool.promptGuidelines !== undefined && tool.promptGuidelines.length > 0) {
      wire.promptGuidelines = tool.promptGuidelines;
    }
    if (tool.executionMode !== undefined) wire.executionMode = tool.executionMode;
    tools.push(wire);
  }
  const commands = [];
  for (const command of extension.commands.values()) {
    const wire = { name: command.name };
    if (command.description !== undefined) wire.description = command.description;
    commands.push(wire);
  }
  const flags = [];
  for (const flag of extension.flags.values()) {
    const wire = { name: flag.name, type: flag.type === "string" ? "string" : "boolean" };
    if (flag.description !== undefined) wire.description = flag.description;
    if (flag.default !== undefined) wire.default = flag.default;
    flags.push(wire);
  }
  const shortcuts = [];
  for (const shortcut of extension.shortcuts.values()) {
    const wire = { key: shortcut.key };
    if (shortcut.description !== undefined) wire.description = shortcut.description;
    shortcuts.push(wire);
  }
  return {
    path: extension.path,
    resolvedPath: extension.resolvedPath,
    events: [...extension.handlers.keys()],
    tools,
    commands,
    flags,
    shortcuts,
    messageRendererTypes: [...extension.messageRenderers.keys()],
    providers: extension.providers.map((p) => ({
      name: p.name,
      config: sanitize(p.config ?? {}),
    })),
  };
}

function registrationChanged(extension) {
  notify("registration", {
    extensionPath: extension.path,
    registration: registrationOf(extension),
  });
}

// --- module loading (TS loader.ts loadExtensionModule/loadExtension) --------

async function createLoader() {
  const { createJiti } = await import(
    new URL("./vendor/jiti/lib/jiti-static.mjs", import.meta.url).href
  );
  const here = (file) => new URL(file, import.meta.url).href;
  const typebox = here("typebox.mjs");
  const piAi = here("pi-ai.mjs");
  const piCodingAgent = here("pi-coding-agent.mjs");
  const unsupported = here("unsupported.mjs");
  // The TS alias map (loader.ts getAliases) in full. The shims are ESM
  // modules with named exports: jiti resolves aliased imports natively, and
  // names a shim does not export resolve to `undefined` through jiti's
  // interop (the v1 degradation, design doc §2.6).
  const alias = {
    "@earendil-works/pi-coding-agent": piCodingAgent,
    "@earendil-works/pi-agent-core": unsupported,
    "@earendil-works/pi-tui": unsupported,
    "@earendil-works/pi-ai": piAi,
    "@earendil-works/pi-ai/oauth": unsupported,
    "@mariozechner/pi-coding-agent": piCodingAgent,
    "@mariozechner/pi-agent-core": unsupported,
    "@mariozechner/pi-tui": unsupported,
    "@mariozechner/pi-ai": piAi,
    "@mariozechner/pi-ai/oauth": unsupported,
    typebox: typebox,
    "typebox/compile": unsupported,
    "typebox/value": unsupported,
    "@sinclair/typebox": typebox,
    "@sinclair/typebox/compile": unsupported,
    "@sinclair/typebox/value": unsupported,
  };
  return createJiti(import.meta.url, {
    moduleCache: false,
    alias,
  });
}

async function loadExtension(jiti, extensionPath) {
  try {
    const module = await jiti.import(extensionPath, { default: true });
    if (typeof module !== "function") {
      return { error: FACTORY_ERROR(extensionPath) };
    }
    const state = createExtensionState(extensionPath, extensionPath);
    const api = piApiFor(state);
    await module(api);
    return { state };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: LOAD_ERROR(message) };
  }
}

// --- first-wins lookups (TS runner.ts getAllRegisteredTools / getCommand) ---

function findTool(toolName) {
  for (const extension of extensions) {
    const tool = extension.tools.get(toolName);
    if (tool) return { extension, tool };
  }
  return undefined;
}

function findCommand(invocationName) {
  for (const extension of extensions) {
    for (const command of extension.commands.values()) {
      if (command.name === invocationName) return { extension, command };
    }
  }
  return undefined;
}

function findShortcut(key) {
  const normalized = String(key).toLowerCase();
  for (const extension of extensions) {
    for (const [registered, shortcut] of extension.shortcuts) {
      if (String(registered).toLowerCase() === normalized) {
        return { extension, shortcut };
      }
    }
  }
  return undefined;
}

function hasHandlers(eventType) {
  for (const extension of extensions) {
    if (extension.handlers.has(eventType)) return true;
  }
  return false;
}

// --- dispatch through the error boundary (TS runner.ts emit) ----------------

async function dispatchEvent(event) {
  for (const extension of extensions) {
    const handlers = extension.handlers.get(event.type) ?? [];
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (err) {
        reportError(extension.path, event.type, err);
      }
    }
  }
}

// --- ctx for tool execution / commands / handlers ---------------------------

const NO_OP_UI = {
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
  notify: () => {},
  setStatus: () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  custom: async () => undefined,
};

function createContextFor(extension) {
  return {
    ui: NO_OP_UI,
    hasUI: false,
    cwd: helloCwd,
    isIdle: () => callCtx("is_idle", {}),
    signal: undefined,
    abort: () => callCtx("abort", {}),
    hasPendingMessages: () => callCtx("has_pending_messages", {}),
    shutdown: () => callCtx("shutdown", {}),
    getContextUsage: () => callCtx("get_context_usage", {}),
    compact: (options) => callCtx("compact", sanitize({ args: [options] })),
    getSystemPrompt: () => callCtx("get_system_prompt", {}),
    setTimeout: (callback, ms) => hostTimer("setTimeout", extension.path, callback, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle);
      clearInterval(handle);
    },
    setInterval: (callback, ms) => hostTimer("setInterval", extension.path, callback, ms),
    clearInterval: (handle) => {
      clearTimeout(handle);
      clearInterval(handle);
    },
    get sessionManager() {
      throw new Error(
        "ctx.sessionManager is not supported in the Rust extension host (v1)",
      );
    },
    get modelRegistry() {
      throw new Error(
        "ctx.modelRegistry is not supported in the Rust extension host (v1)",
      );
    },
    get model() {
      return callCtx("get_model", {});
    },
    ...Object.fromEntries(
      [
        "sendMessage",
        "sendUserMessage",
        "appendEntry",
        "setSessionName",
        "getSessionName",
        "setLabel",
        "exec",
        "getActiveTools",
        "getAllTools",
        "setActiveTools",
        "getCommands",
        "setModel",
        "getThinkingLevel",
        "setThinkingLevel",
      ].map((method) => [
        method,
        (...args) => {
          const snake = method.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
          return callCtx(snake, sanitize({ args }));
        },
      ]),
    ),
  };
}

// --- request handling --------------------------------------------------------

let helloCwd = process.cwd();

async function handleHello(params) {
  if (params.protocol !== PROTOCOL) {
    return {
      error: {
        message:
          "extension host protocol mismatch: sidecar speaks " +
          PROTOCOL +
          ", host speaks " +
          params.protocol,
      },
    };
  }
  if (nodeMajor() < NODE_FLOOR) {
    return {
      error: {
        message:
          "extension host requires Node >= " + NODE_FLOOR + " (found " + process.versions.node + ")",
      },
    };
  }
  helloCwd = typeof params.cwd === "string" && params.cwd ? params.cwd : process.cwd();
  for (const [name, value] of Object.entries(params.flagValues || {})) {
    flagValues.set(name, value);
  }
  const paths = Array.isArray(params.extensionPaths) ? params.extensionPaths : [];
  const errors = [];
  if (paths.length > 0) {
    const jiti = await createLoader();
    for (const extensionPath of paths) {
      const { state, error } = await loadExtension(jiti, extensionPath);
      if (error) {
        errors.push({ path: extensionPath, error });
        continue;
      }
      extensions.push(state);
      extensionsByPath.set(state.path, state);
    }
  }
  // The load cycle finished: action methods graduate from the throwing
  // pre-bind stubs to ctx RPC (TS bindCore equivalent).
  runtimeBound = true;
  return {
    result: {
      protocol: PROTOCOL,
      extensions: extensions.map(registrationOf),
      errors,
    },
  };
}

async function handleToolExecute(params) {
  const found = findTool(params.toolName);
  if (!found) {
    return { error: { message: `No extension tool named '${params.toolName}'` } };
  }
  const { extension, tool } = found;
  const controller = new AbortController();
  const onUpdate = (result) => {
    notify("tool_update", {
      toolCallId: params.toolCallId,
      result: sanitize(result ?? {}),
    });
  };
  try {
    const result = await tool.execute(
      params.toolCallId,
      params.args ?? {},
      controller.signal,
      onUpdate,
      createContextFor(extension),
    );
    const wire = sanitize(result ?? { content: [] });
    return {
      result: {
        content: Array.isArray(wire.content) ? wire.content : [],
        details: wire.details,
        isError: wire.isError === true,
      },
    };
  } catch (err) {
    reportError(extension.path, "tool_execute", err);
    return { error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

async function handleEvent(params) {
  const event = { type: params.type, ...(params.payload || {}) };
  await dispatchEvent(event);
  // Chaining semantics per event type are stage 3; no handlers -> null.
  return { result: null };
}

async function handleCommandExecute(params) {
  const found = findCommand(params.invocationName);
  if (!found) {
    return { error: { message: `No extension command named '/${params.invocationName}'` } };
  }
  try {
    await found.command.handler(params.args ?? "", createContextFor(found.extension));
    return { result: { ok: true } };
  } catch (err) {
    reportError(found.extension.path, "command_execute", err);
    return { error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

async function handleShortcutExecute(params) {
  const found = findShortcut(params.key);
  if (!found) {
    return { error: { message: `No extension shortcut for key '${params.key}'` } };
  }
  try {
    await found.shortcut.handler(createContextFor(found.extension));
    return { result: { ok: true } };
  } catch (err) {
    reportError(found.extension.path, "shortcut_execute", err);
    return { error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

async function handleRequest(msg) {
  switch (msg.method) {
    case "hello":
      return handleHello(msg.params || {});
    case "ping":
      return { result: { ok: true } };
    case "event":
      return handleEvent(msg.params || {});
    case "tool_execute":
      return handleToolExecute(msg.params || {});
    case "command_execute":
      return handleCommandExecute(msg.params || {});
    case "shortcut_execute":
      return handleShortcutExecute(msg.params || {});
    case "shutdown": {
      // Orderly unload: emit session_shutdown to handlers (TS
      // emitSessionShutdownEvent), then reply and exit.
      if (hasHandlers("session_shutdown")) {
        await dispatchEvent({
          type: "session_shutdown",
          reason: (msg.params && msg.params.reason) || "session_end",
        });
      }
      clearHostTimers();
      return { result: { ok: true }, exit: 0 };
    }
    default:
      return {
        error: { message: "extension host received unknown method '" + msg.method + "'" },
      };
  }
}

// --- main loop ---------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let queue = Promise.resolve();

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    process.stderr.write("extension host: unparsable line: " + line + " (" + err + ")\n");
    process.exit(1);
  }
  // A reply to one of our ctx calls.
  if (msg.ctxToken !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    settleCtxReply(msg);
    return;
  }
  // A ctx request from the host (none exist in protocol 2, but keep the
  // direction honest): there is no id to correlate a reply, so it is a
  // protocol violation worth failing loudly.
  if (msg.ctxToken !== undefined) {
    process.stderr.write("extension host: unexpected ctx request: " + line + "\n");
    return;
  }
  // Host notifications (`cancel`): nothing is cancellable in stage 2;
  // tool/event dispatch cancellation tokens arrive with stage 3.
  if (!("id" in msg)) {
    return;
  }
  queue = queue
    .then(() => handleRequest(msg))
    .then((outcome) => {
      writeReply(msg.id, outcome.result, outcome.error, () => {
        if (outcome.exit !== undefined) {
          process.exit(outcome.exit);
        }
      });
    })
    .catch((err) => {
      writeReply(msg.id, undefined, { message: String((err && err.message) || err) });
    });
});

// Stdin closed: the host is gone, stop (unload timers with us).
rl.on("close", () => {
  clearHostTimers();
  process.exit(0);
});
