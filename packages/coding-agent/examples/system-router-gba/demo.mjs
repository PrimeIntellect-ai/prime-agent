// Local demo driver for the Prime Agent system router against the node-mgba GBA adapter.
//
// Runs the REAL router loop (compiled dist: the same loop the session skill
// uses) with a scripted decision function, so the emulator, adapter protocol,
// gating, budgets, and trace are all exercised end-to-end without a model.
// The ROM never enters the repository: pass its path via SYSTEM_ROUTER_ROM.
//
// Requires `npm run build` from the repository root first (dist/ is plain JS).
//
//   node examples/system-router-gba/demo.mjs --adapter node,examples/system-router-gba/adapter.mjs --rom /path/to/game.gba --plan press_a,press_a,wait,press_start
//
// On macOS the adapter must run inside a Linux container (node-mgba has no
// darwin/arm64 build); pass the container command via --adapter as JSON:
//
//   node demo.mjs \
//     --adapter '["docker","run","--rm","-i","--platform","linux/amd64", \
//                 "-v","/path/to/rom-dir:/roms:ro","-e","SYSTEM_ROUTER_ROM=/roms/game.gba", \
//                 "-v","$PWD:/app","-w","/app","node:22-slim", \
//                 "sh","-c","cd /app/examples/system-router-gba && npm i -g npm@latest >/dev/null 2>&1; npm install node-mgba@0.2.9 && node adapter.mjs"]' \
//     --rom /path/to/game.gba --plan press_a,wait,finish
//
// The loop's decision model here is the scripted plan; for a model-driven run
// use the system-router skill from a session (see README.md).
import { parseArgs } from "node:util";
import { runSystemRouterLoop } from "../../dist/core/system-router/loop.js";
import { StdioRouterEnvironment } from "../../dist/core/system-router/stdio-environment.js";
import { parseActionSpace } from "../../dist/core/system-router/types.js";
import { compileActionSpace } from "../../dist/core/system-router/action-space.js";

const { values } = parseArgs({
  options: {
    adapter: { type: "string" }, // "node,adapter.mjs" or a JSON array
    rom: { type: "string" }, // host path, only used for the local-adapter case
    plan: { type: "string" }, // comma-separated actions, e.g. press_a,wait,finish
    "max-steps": { type: "string", default: "25" },
  },
});

const adapterCommand = (() => {
  const raw = values.adapter ?? "node,examples/system-router-gba/adapter.mjs";
  if (raw.startsWith("[")) {
    return JSON.parse(raw);
  }
  return raw.split(",");
})();

const plan = (values.plan ?? "press_a,wait,finish").split(",").map((part) => part.trim()).filter(Boolean);
const maxSteps = Number(values["max-steps"] ?? 25);
const romPath = values.rom ?? process.env.SYSTEM_ROUTER_ROM;

if (!romPath) {
  console.error("Pass --rom (or SYSTEM_ROUTER_ROM) with the local path to your own ROM file.");
  process.exit(1);
}

const env = new StdioRouterEnvironment({
  command: adapterCommand,
  requestTimeoutMs: 30_000,
  // A container-wrapped adapter cannot see the host path; it reads SYSTEM_ROUTER_ROM.
  ...(adapterCommand[0] === "docker" ? {} : { init: { romPath } }),
});

let actions;
try {
  const environment = await env.init();
  actions = parseActionSpace(environment?.actions);
  if (!actions) {
    throw new Error("the adapter did not supply a default action space");
  }
} finally {
  // Pre-loop failures (no action space, an invalid one) must not leave the
  // spawned adapter — including a docker container — running.
  if (!actions) await env.close();
}

const { byName } = compileActionSpace(actions);
let step = 0;
const decide = async () => {
  const action = plan[Math.min(step, plan.length - 1)];
  const compiled = byName.get(action);
  const params = {};
  for (const paramName of Object.keys(compiled.params)) {
    params[paramName] = Object.keys(compiled.params[paramName].choices)[0];
  }
  step += 1;
  return {
    action,
    params,
    confidence: 0.9,
    rawText: `scripted step ${step}: ${action}`,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
};

const result = await runSystemRouterLoop({
  env,
  goal: "Demo: play the opening of the game with the scripted plan.",
  actions,
  decide,
  model: { id: "scripted", provider: "demo", input: [], thinkingLevel: "off" },
  maxSteps,
  timeoutMs: 120_000,
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "failed" ? 1 : 0);
