import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkSourceOwnership } from "./check-source-ownership.mjs";

function check(files, overrides = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "prime-source-ownership-"));
	try {
		writeFileSync(
			join(cwd, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { noLib: true, noEmit: true, module: "preserve" }, include: ["src/**/*"] }),
		);
		for (const [name, source] of Object.entries(files)) {
			const path = join(cwd, "src", name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, source);
		}
		return checkSourceOwnership({
			cwd,
			sourceDir: "src",
			policy: {
				coreFiles: [],
				legacyFacades: [],
				compatibilityAdapters: {},
				executableFacades: {},
				groupingDirectories: ["", "session", "coordination", "modes"],
				parentFiles: ["index.ts", "session/agent-session.ts"],
				executionToUi: [],
				...overrides,
			},
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

const rules = (diagnostics) => diagnostics.map((diagnostic) => diagnostic.rule);

test("rejects new core files and requires removal of resolved baseline entries", () => {
	assert.deepEqual(rules(check({ "core/new.ts": "export const added = true;" })), ["new-core-file"]);
	assert.deepEqual(rules(check({ "core/new.js": "export const added = true;" })), ["new-core-file"]);
	assert.deepEqual(check({ "core/old.ts": "export const existing = true;" }, { coreFiles: ["core/old.ts"] }), []);
	assert.deepEqual(rules(check({ "index.ts": "export {};" }, { coreFiles: ["core/deleted.ts"] })), ["stale-baseline"]);
});

test("requires export-only compatibility modules, not code hidden beside re-exports", () => {
	const files = {
		"core/old.ts": 'export { value } from "../kernel/value.js";',
		"kernel/value.ts": "export const value = 1;",
	};
	const policy = { coreFiles: ["core/old.ts"], legacyFacades: ["core/old.ts"] };
	assert.deepEqual(check(files, policy), []);
	assert.deepEqual(
		rules(check({ ...files, "core/old.ts": `${files["core/old.ts"]}\nexport const duplicate = 2;` }, policy)),
		["facade-implementation"],
	);
});

test("legacy facades reject wildcard and namespace exports", () => {
	for (const source of ['export * from "../kernel/value.js";', 'export * as kernel from "../kernel/value.js";']) {
		assert.deepEqual(
			rules(check({ "core/old.ts": source }, { coreFiles: ["core/old.ts"], legacyFacades: ["core/old.ts"] })),
			["facade-implementation"],
		);
	}
});

test("requires canonical imports, including type-only imports and re-export chains", () => {
	const files = {
		"core/old.ts": 'export type { Result } from "../kernel/contracts.js";',
		"kernel/contracts.ts": "export interface Result {}",
		"session/input/consumer.ts": 'import type { Result } from "../../core/old.js"; export type Output = Result;',
	};
	const policy = { coreFiles: ["core/old.ts"], legacyFacades: ["core/old.ts"] };
	assert.deepEqual(rules(check(files, policy)), ["legacy-import"]);
	assert.deepEqual(
		rules(
			check({ ...files, "session/input/consumer.ts": 'export type { Result } from "../../core/old.js";' }, policy),
		),
		["legacy-import"],
	);
	assert.deepEqual(
		check(
			{
				...files,
				"session/input/consumer.ts":
					'import type { Result } from "../../kernel/contracts.js"; export type Output = Result;',
			},
			policy,
		),
		[],
	);
});

test("resolves extensionless directory and package subpath imports to legacy owners", () => {
	const files = {
		"core/kernel/index.ts": 'export { value } from "../../kernel/value.js";',
		"kernel/value.ts": "export const value = 1;",
	};
	const policy = { coreFiles: ["core/kernel/index.ts"], legacyFacades: ["core/kernel/index.ts"] };
	for (const module of [
		"../../core/kernel",
		"@earendil-works/pi-coding-agent/core/kernel",
		"../../core/kernel/index.js",
	]) {
		assert.deepEqual(
			rules(check({ ...files, "session/input/consumer.ts": `import { value } from "${module}";` }, policy)),
			["legacy-import"],
		);
	}
});

test("distinguishes real imports from comments, template text and ordinary strings", () => {
	const files = {
		"session/runtime/worker.ts":
			'// import { create } from "../../sdk/index.js";\nconst example = `import("../../sdk/index.js")`;\nconst note = "require(\\\"@earendil-works/pi-tui\\\")";\nexport { example, note };',
	};
	assert.deepEqual(check(files), []);
});

test("rejects runtime imports of public SDK barrels through static, nested and package syntax", () => {
	for (const source of [
		'import { create } from "../../sdk/index.js";',
		'import type { Result } from "../../sdk/index.js";',
		'export const load = () => import("../../sdk/index.js");',
		'export type Result = import("../../sdk/index.js").Result;',
		'import { create } from "@earendil-works/pi-coding-agent";',
	]) {
		assert.deepEqual(rules(check({ "session/runtime/worker.ts": source })), ["runtime-sdk-barrel"], source);
	}
	assert.deepEqual(
		check({
			"session/runtime/worker.ts":
				'import type { Result } from "../../sdk/contracts.js"; export type Factory = () => Result;',
		}),
		[],
	);
});

test("contracts cannot import controllers even through erased imports", () => {
	for (const source of [
		'import type { State } from "./controller.js";',
		'import { type State } from "./controller.js";',
		'export type { State } from "./controller.js";',
	]) {
		assert.deepEqual(rules(check({ "session/goals/contracts.ts": source })), ["contracts-controller"]);
	}
	assert.deepEqual(
		check({
			"session/goals/controller.ts": 'import type { State } from "./contracts.js";',
			"session/goals/contracts.ts": "export interface State {}",
		}),
		[],
	);
});

test("contracts protect declared non-controller implementations with exact shrinking type exceptions", () => {
	const file = "session/children/runtime-contracts.ts";
	const source = 'import type { SessionChildren } from "./children.js";';
	const policy = { protectedImplementations: ["session/children/children.ts"] };
	assert.deepEqual(rules(check({ [file]: source }, policy)), ["contracts-controller"]);
	const legacyPolicy = { ...policy, contractTypeEdges: [`${file} -> session/children/children.ts`] };
	assert.deepEqual(check({ [file]: source }, legacyPolicy), []);
	assert.deepEqual(rules(check({ [file]: 'import { SessionChildren } from "./children.js";' }, legacyPolicy)), [
		"contracts-controller",
		"stale-baseline",
	]);
	assert.deepEqual(rules(check({ [file]: "export interface ChildState {}" }, legacyPolicy)), ["stale-baseline"]);
	assert.deepEqual(check({ [file]: 'import type { ChildState } from "./child-types.js";' }, policy), []);
});

test("explicitly named contract modules receive the same implementation boundary", () => {
	assert.deepEqual(
		rules(
			check(
				{ "session/input/prepared-actions.ts": 'import type { Controller } from "../goals/controller.js";' },
				{ contractFiles: ["session/input/prepared-actions.ts"] },
			),
		),
		["contracts-controller"],
	);
});

test("execution permits terminal type contracts but rejects runtime renderer dependencies", () => {
	for (const source of [
		'import type { Component } from "@earendil-works/pi-tui";',
		'import { type Component } from "@earendil-works/pi-tui";',
		'export type { Component } from "@earendil-works/pi-tui";',
	]) {
		assert.deepEqual(check({ "session/tools/execution.ts": source }), []);
	}
	for (const source of [
		'import { Text } from "@earendil-works/pi-tui";',
		'import { Text, type Component } from "@earendil-works/pi-tui";',
		'import "@earendil-works/pi-tui";',
		'import {} from "@earendil-works/pi-tui";',
		'export const load = () => require("@earendil-works/pi-tui");',
	]) {
		assert.deepEqual(rules(check({ "session/tools/execution.ts": source })), ["execution-ui"], source);
	}
});

test("headless adapters and future tool owners also enforce terminal boundaries", () => {
	for (const file of [
		"modes/daemon/workers/worker.ts",
		"modes/rpc/server.ts",
		"modes/acp/server.ts",
		"modes/agent-connection/connection.ts",
		"tools/bash.ts",
		"extensions/runner.ts",
		"mcp/client.ts",
	]) {
		assert.deepEqual(
			rules(check({ [file]: 'import { Text } from "@earendil-works/pi-tui";' })),
			["execution-ui"],
			file,
		);
	}
});

test("execution/UI exceptions are exact edges and must shrink when removed", () => {
	const files = { "session/tools/execution.ts": 'import { Text } from "@earendil-works/pi-tui";' };
	const policy = { executionToUi: ["session/tools/execution.ts -> @earendil-works/pi-tui"] };
	assert.deepEqual(check(files, policy), []);
	assert.deepEqual(rules(check({ ...files, "session/tools/other.ts": files["session/tools/execution.ts"] }, policy)), [
		"execution-ui",
	]);
	assert.deepEqual(rules(check({ "session/tools/execution.ts": "export {};" }, policy)), ["stale-baseline"]);
});

test("parent grouping folders admit only explicit composition/contract paths", () => {
	assert.deepEqual(check({ "session/agent-session.ts": "export class AgentSession {}" }), []);
	assert.deepEqual(rules(check({ "session/misc.ts": "export const work = () => 1;" })), ["parent-implementation"]);
	assert.deepEqual(rules(check({ "coordination/misc.ts": "export interface HiddenHelper {}" })), [
		"parent-implementation",
	]);
});

test("legacy executable exceptions permit only the reviewed canonical import", () => {
	const policy = {
		coreFiles: ["core/kernel/bootstrap-cli.ts"],
		executableFacades: { "core/kernel/bootstrap-cli.ts": "cli/bootstrap-kernel.ts" },
	};
	assert.deepEqual(check({ "core/kernel/bootstrap-cli.ts": 'import "../../cli/bootstrap-kernel.js";' }, policy), []);
	assert.deepEqual(
		rules(
			check(
				{ "core/kernel/bootstrap-cli.ts": 'import "../../cli/bootstrap-kernel.js"; console.log("extra");' },
				policy,
			),
		),
		["changed-executable-facade"],
	);
});

test("legacy adapter exceptions cannot silently acquire more implementation", () => {
	const source = "export class LegacyAdapter { build() { return this.prepare(); } }";
	const policy = {
		compatibilityAdapters: {
			"session/kernel/kernel.ts": {
				sha256: createHash("sha256").update(source).digest("hex"),
				reason: "preserve legacy build return value",
			},
		},
	};
	assert.deepEqual(check({ "session/kernel/kernel.ts": source }, policy), []);
	assert.deepEqual(rules(check({ "session/kernel/kernel.ts": `${source}\nexport const extra = 1;` }, policy)), [
		"changed-compatibility-adapter",
	]);
});
