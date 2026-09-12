import { describe, expect, it } from "vitest";
import * as canonical13_0 from "../src/coordination/messaging/host-requests.js";
import * as canonical14_0 from "../src/coordination/observation/host-requests.js";
import * as canonical10_0 from "../src/coordination/scheduling/host-requests.js";
import * as legacy0 from "../src/core/agent-session-config.js";
import * as legacy1 from "../src/core/agent-session-runtime.js";
import * as legacy2 from "../src/core/agent-session-services.js";
import * as legacy3 from "../src/core/kernel/boot-gate.js";
import * as legacy4 from "../src/core/kernel/bootstrap.js";
import * as legacy5 from "../src/core/kernel/index.js";
import * as legacy6 from "../src/core/kernel/repl-manager.js";
import * as legacy7 from "../src/core/kernel/shared.js";
import * as legacy8 from "../src/core/kernel/state-snapshot.js";
import * as legacy9 from "../src/core/sdk.js";
import * as canonical3_0 from "../src/kernel/boot-gate.js";
import * as canonical4_0 from "../src/kernel/bootstrap.js";
import * as canonical7_0 from "../src/kernel/contracts.js";
import * as canonical5_0 from "../src/kernel/index.js";
import * as canonical7_1 from "../src/kernel/process-registry.js";
import * as canonical7_2 from "../src/kernel/protocol.js";
import * as canonical6_0 from "../src/kernel/repl-manager.js";
import * as canonical8_0 from "../src/kernel/state-snapshot.js";
import * as canonical9_0 from "../src/sdk/index.js";
import * as canonical2_0 from "../src/sdk/services.js";
import * as legacy10 from "../src/session/kernel/heartbeat-host-requests.js";
import * as legacy11 from "../src/session/kernel/kernel-environment.js";
import * as legacy12 from "../src/session/kernel/kernel-host-handlers.js";
import * as legacy13 from "../src/session/kernel/message-host-requests.js";
import * as legacy14 from "../src/session/kernel/observe-host-requests.js";
import * as canonical0_0 from "../src/session/runtime/config.js";
import * as canonical12_0 from "../src/session/runtime/host-bridge.js";
import * as canonical11_0 from "../src/session/runtime/kernel-environment.js";
import * as canonical1_0 from "../src/session/runtime/runtime.js";

const compatibilityModules: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
	["core/agent-session-config.ts", legacy0, canonical0_0],
	["core/agent-session-runtime.ts", legacy1, canonical1_0],
	["core/agent-session-services.ts", legacy2, canonical2_0],
	["core/kernel/boot-gate.ts", legacy3, canonical3_0],
	["core/kernel/bootstrap.ts", legacy4, canonical4_0],
	["core/kernel/index.ts", legacy5, canonical5_0],
	["core/kernel/repl-manager.ts", legacy6, canonical6_0],
	["core/kernel/shared.ts", legacy7, { ...canonical7_0, ...canonical7_1, ...canonical7_2 }],
	["core/kernel/state-snapshot.ts", legacy8, canonical8_0],
	["core/sdk.ts", legacy9, canonical9_0],
	["session/kernel/heartbeat-host-requests.ts", legacy10, canonical10_0],
	["session/kernel/kernel-environment.ts", legacy11, canonical11_0],
	["session/kernel/kernel-host-handlers.ts", legacy12, canonical12_0],
	["session/kernel/message-host-requests.ts", legacy13, canonical13_0],
	["session/kernel/observe-host-requests.ts", legacy14, canonical14_0],
];

describe("explicit kernel/runtime compatibility exports", () => {
	it.each(compatibilityModules)("preserves every runtime export and identity at %s", (_path, legacy, canonical) => {
		expect(Object.keys(legacy).sort()).toEqual(Object.keys(canonical).sort());
		for (const name of Object.keys(canonical)) expect(legacy[name]).toBe(canonical[name]);
	});
});
