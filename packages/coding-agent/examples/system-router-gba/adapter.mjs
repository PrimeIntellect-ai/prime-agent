// node-mgba adapter for the Prime Agent system router (examples/system-router-gba).
//
// Speaks the router's newline-delimited JSON adapter protocol on stdio:
//   {"id", "type": "init", "init": {...}}          -> {"id", "ok": true, "environment": {"actions": {...}}}
//   {"id", "type": "reset", "goal": "..."}        -> {"id", "ok": true}
//   {"id", "type": "observe"}                     -> {"id", "ok": true, "observation": {...}}
//   {"id", "type": "execute", "action", "params"} -> {"id", "ok": true, "text": "..."}
//
// node-mgba ships prebuilt native shims for Linux/Windows x64 only; on macOS
// run this adapter inside a Linux container (see README.md).
import { createInterface } from "node:readline";
import { Mgba } from "node-mgba";

const BUTTONS = ["a", "b", "l", "r", "up", "down", "left", "right", "start", "select"];
const PRESS_FRAMES = 8; // frames a button is held
const SETTLE_FRAMES = 30; // frames the game runs after a press
const BOOT_FRAMES = 120; // frames run after load before the reset snapshot

const config = {
  romPath: null,
  screen: false, // attach base64 PNG screenshots to observations
  memoryReads: [], // [{address, size (1|2|4), label}]
};

let emu = null;
let resetHandle = null;
let tickCount = 0;
let lastDigest = null;
let lastResultDigest = null;

function actionSpace() {
  const actions = {
    wait: {
      description:
        "Run the game for about one second (60 frames) without pressing anything. Use when the screen is mid-animation or a dialog is advancing on its own.",
      risk: "read",
    },
  };
  for (const button of BUTTONS) {
    actions[`press_${button}`] = {
      description:
        `Press the ${button.toUpperCase()} button for ${PRESS_FRAMES} frames` +
        (button === "a" ? " to confirm, talk, or interact." : "."),
      risk: "read",
    };
  }
  return actions;
}

function reply(id, ok, extra) {
  const payload = { id, ok, ...extra };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function shortDigest(buffer) {
  // fnv1a over the first bytes of EWRAM: a cheap "did the state change" signal.
  let hash = 0x811c9dc5;
  for (let i = 0; i < buffer.length; i += 1) {
    hash ^= buffer[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function ewramDigest() {
  const region = await emu.memory.readRegion("EWRAM", 0, 256);
  return shortDigest(region);
}

async function readMemoryFields() {
  const fields = {};
  for (const read of config.memoryReads) {
    const value =
      read.size === 4
        ? await emu.memory.read32LE(read.address)
        : read.size === 2
          ? await emu.memory.read16LE(read.address)
          : await emu.memory.read8(read.address);
    fields[read.label] = value;
  }
  return fields;
}

async function observation() {
  const digest = await ewramDigest();
  const changed = digest !== lastDigest;
  lastDigest = digest;
  // No frame/tick counter in the observation: a monotonic counter would make
  // every observation digest unique and defeat repeated-state detection.
  const fields = { ram_digest: digest, ...(await readMemoryFields()) };
  const text = [
    `EWRAM digest ${digest} (${changed ? "changed since last look" : "unchanged since last look"}).`,
    ...config.memoryReads.map((read) => `${read.label}: ${fields[read.label]}`),
    "Game screen reference: the adapter can capture PNG screenshots; the action model here works from RAM signals and history.",
  ]
    .filter(Boolean)
    .join("\n");
  const observation = { text, fields };
  if (config.screen) {
    const png = await emu.screen.toPng();
    observation.image = png.toString("base64");
  }
  return observation;
}

async function handle(message) {
  switch (message.type) {
    case "init": {
      const init = message.init ?? {};
      const romPath = init.romPath ?? process.env.SYSTEM_ROUTER_ROM;
      if (!romPath) {
        throw new Error("init.romPath (or SYSTEM_ROUTER_ROM) is required to load a ROM");
      }
      config.romPath = romPath;
      config.screen = init.screen === true;
      config.memoryReads = Array.isArray(init.memoryReads)
        ? init.memoryReads.filter(
            (read) =>
              Number.isInteger(read.address) &&
              [1, 2, 4].includes(read.size) &&
              typeof read.label === "string" &&
              read.label,
          )
        : [];
      emu = await Mgba.load(romPath);
      await emu.controls.tick(BOOT_FRAMES);
      tickCount = BOOT_FRAMES;
      resetHandle = await emu.states.save();
      lastDigest = await ewramDigest();
      lastResultDigest = lastDigest;
      return { environment: { actions: actionSpace() } };
    }
    case "reset": {
      if (!emu) throw new Error("adapter is not initialized");
      await emu.states.restore(resetHandle);
      tickCount = BOOT_FRAMES;
      lastDigest = await ewramDigest();
      lastResultDigest = lastDigest;
      return {};
    }
    case "observe": {
      if (!emu) throw new Error("adapter is not initialized");
      return { observation: await observation() };
    }
    case "execute": {
      if (!emu) throw new Error("adapter is not initialized");
      const action = message.action;
      if (action === "wait") {
        await emu.controls.tick(SETTLE_FRAMES * 2);
        tickCount += SETTLE_FRAMES * 2;
      } else if (action.startsWith("press_")) {
        const button = action.slice("press_".length).toUpperCase();
        if (!BUTTONS.includes(button.toLowerCase())) {
          throw new Error(`unknown button: ${button}`);
        }
        await emu.controls.press(button, PRESS_FRAMES);
        await emu.controls.tick(SETTLE_FRAMES);
        tickCount += PRESS_FRAMES + SETTLE_FRAMES;
      } else if (action === "finish" || action === "escalate") {
        return { text: `${action} recorded by the adapter without input.` };
      } else {
        throw new Error(`unknown action: ${action}`);
      }
      const digest = await ewramDigest();
      const changed = digest !== lastResultDigest;
      lastResultDigest = digest;
      return { text: `${action} executed; EWRAM digest ${digest} (${changed ? "state changed" : "state unchanged"}).` };
    }
    case "close": {
      if (emu) await emu.close();
      return {};
    }
    default:
      throw new Error(`unknown request type: ${message.type}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const message = JSON.parse(trimmed);
  handle(message)
    .then((extra) => reply(message.id, true, extra))
    .catch((error) => reply(message.id, false, { error: String(error?.message ?? error) }))
    .finally(() => {
      if (message.type === "close") {
        rl.close();
        process.exit(0);
      }
    });
});
