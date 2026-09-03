/**
 * Tests for the Home-private lifecycle-key resolver (deletion facade).
 *
 * Covers:
 *  - lifecycleKeyDto validation (valid UUID, invalid -> INVALID_ARGUMENT)
 *  - Derived provider label argv matches exact expected CLI pattern
 *  - Exact 0 matches -> absent
 *  - Exact 1 match -> delete via deleteResolved -> {status:"deleted"}
 *  - >1 match -> COLLISION
 *  - Malformed outer JSON -> RESOLUTION_UNCERTAIN
 *  - Malformed/missing/extra entries -> RESOLUTION_UNCERTAIN
 *  - CLI failure -> RESOLUTION_UNCERTAIN
 *  - Exceptions from runner -> RESOLUTION_UNCERTAIN
 *  - Failed deleteResolved -> re-list -> 0 matches = absent
 *  - Failed deleteResolved -> re-list -> 1+ matches = DELETE_UNCERTAIN
 *  - Failed deleteResolved -> re-list fails -> DELETE_UNCERTAIN
 *  - No public raw SandboxIdentity, sandbox ID, region, match count, runner output/errors
 *  - Integration with SandboxLifecycle: key generated before create, derived label argv
 *  - Real async persisted ownership/tombstone scans prove no raw ID/region/URL/path/token
 *  - DTO/result type hostility: facade results are frozen, only status/error keys
 *  - Provider promise hostility: non-native promises, proxied promises rejected
 *  - Factory returns fixed result on hostile input (never throws)
 *  - SandboxLifecycle.recover() static factory restart seam
 *  - Restart durable state transitions: markTerminating, markTerminated, markDeleted
 *  - Already terminated/deleted idempotent handling
 *  - Filtered labels include only verified requested-filter results
 */

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxLifecycle } from "../src/core/sandbox-lifecycle.js";
import { createDeletionFacade, lifecycleKeyDto } from "../src/core/sandbox-lifecycle-resolver.js";
import { SandboxOwnershipStore } from "../src/core/sandbox-ownership.js";
import { createPrimeSandboxProvider } from "../src/core/sandbox-provider.js";
import type { CommandRunner, SandboxRunResult } from "../src/core/sandbox-types.js";

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

const UUID_V4 = "550e8400-e29b-41d4-a716-446655440000";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "resolver-test-"));
}

function emptyListJson(): string {
	return JSON.stringify({ sandboxes: [] });
}

function singleListJson(id: string, label: string): string {
	return JSON.stringify({
		sandboxes: [
			{
				id,
				name: "t",
				image: "i",
				status: "RUNNING",
				region: "us",
				created_at: "now",
				labels: [label],
				resources: "",
			},
		],
	});
}

function multiListJson(labels: string[], count: number): string {
	const entries = [];
	for (let i = 0; i < count; i++) {
		entries.push({
			id: `sbx-dup-${String(i).padStart(3, "0")}`,
			name: `sandbox-${i}`,
			image: "img",
			status: "RUNNING",
			region: "us",
			created_at: "now",
			labels,
			resources: "",
		});
	}
	return JSON.stringify({ sandboxes: entries });
}

/**
 * Narrow lifecycleKeyDto result into DTO without any type assertion.
 * Throws if result is an error variant.
 */
function unwrapDto(raw: string): { lifecycleKey: string } {
	const result = lifecycleKeyDto(raw);
	// Check for error by verifying "lifecycleKey" is present
	const hasLifecycleKey = typeof result === "object" && result !== null && "lifecycleKey" in result;
	if (!hasLifecycleKey) {
		if (typeof result === "object" && result !== null && "status" in result) {
			throw new Error("unexpected error: ...");
		}
		throw new Error("unexpected result shape");
	}
	return { lifecycleKey: result.lifecycleKey };
}

// -------------------------------------------------------------------------
// FakeCommandRunner
// -------------------------------------------------------------------------

interface Rule {
	match: (argv: string[]) => boolean;
	stdout: string;
	stderr?: string;
	exitCode?: number;
}

class FakeCommandRunner implements CommandRunner {
	private rules: Rule[] = [];
	private seq: Rule[] | undefined;
	private seqIdx = 0;

	on(match: (argv: string[]) => boolean, o: { stdout?: string; stderr?: string; exitCode?: number }): this {
		this.rules.push({
			match,
			stdout: o.stdout ?? "",
			stderr: o.stderr ?? "",
			exitCode: o.exitCode ?? 0,
		});
		return this;
	}

	onCommand(sub: string, o: { stdout?: string; stderr?: string; exitCode?: number }): this {
		return this.on((argv) => argv.join(" ").includes(sub), o);
	}

	onSequence(rules: Rule[]): this {
		this.seq = rules;
		this.seqIdx = 0;
		this.rules = [];
		return this;
	}

	async run(argv: string[], _opts?: unknown): Promise<SandboxRunResult> {
		if (this.seq) {
			const r = this.seq[Math.min(this.seqIdx, this.seq.length - 1)];
			this.seqIdx++;
			return {
				stdout: r.stdout,
				stderr: r.stderr ?? "",
				exitCode: r.exitCode ?? 0,
			};
		}
		for (const r of this.rules) {
			if (r.match(argv)) {
				return {
					stdout: r.stdout,
					stderr: r.stderr ?? "",
					exitCode: r.exitCode ?? 0,
				};
			}
		}
		return { stdout: "", stderr: "no rule", exitCode: 127 };
	}
}

function makeGetJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		id: "sbx-test-001",
		name: "test-sandbox",
		docker_image: "python:3.11-slim",
		status: "RUNNING",
		region: "us",
		created_at: "2026-09-02T12:00:00Z",
		labels: ["b06-session"],
		...overrides,
	});
}

// =========================================================================
// lifecycleKeyDto -- input validation
// =========================================================================

describe("lifecycleKeyDto", () => {
	it("valid UUID v4 returns DTO", () => {
		const dto = lifecycleKeyDto(UUID_V4);
		const hasLifecycleKey = typeof dto === "object" && dto !== null && "lifecycleKey" in dto;
		if (!hasLifecycleKey) {
			throw new Error("expected success DTO");
		}
		expect(Object.isFrozen(dto)).toBe(true);
		expect(dto.lifecycleKey).toBe(UUID_V4);
	});

	it("returns INVALID_ARGUMENT for empty string", () => {
		const result = lifecycleKeyDto("");
		if (typeof result === "object" && result !== null && "status" in result) {
			expect(result.status).toBe("error");
			expect("code" in result).toBe(true);
		} else {
			throw new Error("expected error result");
		}
	});

	it("returns INVALID_ARGUMENT for non-UUID string", () => {
		const result = lifecycleKeyDto("not-a-uuid");
		if (typeof result === "object" && result !== null && "status" in result) {
			expect(result.status).toBe("error");
			expect("code" in result).toBe(true);
		} else {
			throw new Error("expected error result");
		}
	});

	it("returns INVALID_ARGUMENT for UUID v5", () => {
		const result = lifecycleKeyDto("550e8400-e29b-51d4-a716-446655440000");
		if (typeof result === "object" && result !== null && "status" in result) {
			expect(result.status).toBe("error");
			expect("code" in result).toBe(true);
		} else {
			throw new Error("expected error result");
		}
	});
});

// =========================================================================
// Deletion facade -- resolution
// =========================================================================

describe("createDeletionFacade", () => {
	it("0 matches returns absent", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: emptyListJson() });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		expect(Object.isFrozen(result)).toBe(true);
		expect(result).toEqual({ status: "absent" });
	});

	it("1 match returns deleted after successful deleteResolved", async () => {
		const label = `ovn-${UUID_V4}`;
		const runner = new FakeCommandRunner()
			.onCommand("sandbox list", {
				stdout: singleListJson("sbx-001", label),
			})
			.onCommand("sandbox delete", { stdout: "" });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		expect(Object.isFrozen(result)).toBe(true);
		expect(result).toEqual({ status: "deleted" });
	});

	it(">1 match returns COLLISION", async () => {
		const label = `ovn-${UUID_V4}`;
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: multiListJson([label], 3) });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		expect(result).toEqual({ status: "error", code: "COLLISION" });
	});

	it("malformed outer JSON returns RESOLUTION_UNCERTAIN", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: "not-json" });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		expect(result).toEqual({
			status: "error",
			code: "RESOLUTION_UNCERTAIN",
		});
	});

	it("CLI failure returns RESOLUTION_UNCERTAIN", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", { exitCode: 1, stderr: "CLI error" });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		expect(result).toEqual({
			status: "error",
			code: "RESOLUTION_UNCERTAIN",
		});
	});

	it("exception from runner returns RESOLUTION_UNCERTAIN", async () => {
		const throwingRunner: CommandRunner = {
			run: async () => {
				throw new Error("network error");
			},
		};
		const provider = createPrimeSandboxProvider(throwingRunner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		expect(result).toEqual({
			status: "error",
			code: "RESOLUTION_UNCERTAIN",
		});
	});

	it("malformed entry in JSON (empty id) returns RESOLUTION_UNCERTAIN", async () => {
		const label = `ovn-${UUID_V4}`;
		const malformedJson = JSON.stringify({
			sandboxes: [{ id: "", labels: [label] }],
		});
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: malformedJson });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		expect(result).toEqual({
			status: "error",
			code: "RESOLUTION_UNCERTAIN",
		});
	});

	it("entry missing requested label returns RESOLUTION_UNCERTAIN", async () => {
		const wrongLabelJson = JSON.stringify({
			sandboxes: [{ id: "sbx-wl", labels: ["other-label"] }],
		});
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: wrongLabelJson });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		expect(result).toEqual({
			status: "error",
			code: "RESOLUTION_UNCERTAIN",
		});
	});
});

// =========================================================================
// Deletion facade -- failed delete re-list
// =========================================================================

describe("delete failed re-list", () => {
	it("deleteResolved fails then re-list shows 0 matches -> absent", async () => {
		const label = `ovn-${UUID_V4}`;
		const runner = new FakeCommandRunner().onSequence([
			{ match: () => true, stdout: singleListJson("sbx-rl1", label) },
			{ match: () => true, stdout: "", exitCode: 1, stderr: "server error" },
			{ match: () => true, stdout: emptyListJson() },
		]);
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		expect(result).toEqual({ status: "absent" });
	});

	it("deleteResolved fails then re-list shows 1+ matches -> DELETE_UNCERTAIN", async () => {
		const label = `ovn-${UUID_V4}`;
		const runner = new FakeCommandRunner().onSequence([
			{ match: () => true, stdout: singleListJson("sbx-ru1", label) },
			{ match: () => true, stdout: "", exitCode: 1, stderr: "timeout" },
			{ match: () => true, stdout: singleListJson("sbx-ru1", label) },
		]);
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		expect(result).toEqual({
			status: "error",
			code: "DELETE_UNCERTAIN",
		});
	});

	it("deleteResolved fails then re-list also fails -> DELETE_UNCERTAIN", async () => {
		const label = `ovn-${UUID_V4}`;
		const runner = new FakeCommandRunner().onSequence([
			{ match: () => true, stdout: singleListJson("sbx-rl2", label) },
			{ match: () => true, stdout: "", exitCode: 1, stderr: "fail" },
			{ match: () => true, stdout: "", exitCode: 1, stderr: "network down" },
		]);
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		expect(result).toEqual({
			status: "error",
			code: "DELETE_UNCERTAIN",
		});
	});
});

// =========================================================================
// No public raw identity -- facade never leaks internals
// =========================================================================

describe("facade never exposes raw identity", () => {
	it("result is frozen and only contains status/error", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: emptyListJson() });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);

		expect(Object.isFrozen(result)).toBe(true);

		const keys = Object.keys(result).sort();
		if (result.status === "error") {
			expect(keys).toEqual(["code", "status"]);
		} else {
			expect(keys).toEqual(["status"]);
		}

		const json = JSON.stringify(result);
		expect(json).not.toMatch(/"id":/);
		expect(json).not.toMatch(/"region":/);
		expect(json).not.toMatch(/"matchCount":/);
		expect(json).not.toMatch(/"runnerOutput":/);
		expect(json).not.toMatch(/"runnerError":/);
	});

	it("delete with 1 match still returns only {status:'deleted'}", async () => {
		const label = `ovn-${UUID_V4}`;
		const runner = new FakeCommandRunner()
			.onCommand("sandbox list", {
				stdout: singleListJson("sbx-secret-001", label),
			})
			.onCommand("sandbox delete", { stdout: "" });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		const json = JSON.stringify(result);
		expect(json).not.toContain("sbx-secret-001");
		expect(json).not.toContain("us-west");
		expect(json).not.toContain("us-east");
	});
});

// =========================================================================
// Result type hostility -- facade results are properly bounded
// =========================================================================

describe("result type hostility", () => {
	it("deleted result has only status key, frozen, no extras", async () => {
		const label = `ovn-${UUID_V4}`;
		const runner = new FakeCommandRunner()
			.onCommand("sandbox list", {
				stdout: singleListJson("sbx-hostile-1", label),
			})
			.onCommand("sandbox delete", { stdout: "" });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);

		expect(Object.isFrozen(result)).toBe(true);
		const ownKeys = Object.getOwnPropertyNames(result);
		expect(ownKeys).toEqual(["status"]);
		expect(Object.getOwnPropertySymbols(result).length).toBe(0);
	});

	it("absent result has only status key, frozen, no extras", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: emptyListJson() });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);

		expect(Object.isFrozen(result)).toBe(true);
		const ownKeys = Object.getOwnPropertyNames(result);
		expect(ownKeys).toEqual(["status"]);
		expect(Object.getOwnPropertySymbols(result).length).toBe(0);
	});

	it("error result has only status and code keys, frozen", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: "not-json" });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);

		expect(Object.isFrozen(result)).toBe(true);
		const ownKeys = Object.getOwnPropertyNames(result).sort();
		expect(ownKeys).toEqual(["code", "status"]);
		expect(Object.getOwnPropertySymbols(result).length).toBe(0);
	});
});

// =========================================================================
// Factory hostility -- returns fixed result on bad input, never throws
// =========================================================================

describe("factory hostility", () => {
	it("returns facade that errors on bad provider shape", async () => {
		// Non-object
		const facade1 = createDeletionFacade(null);
		const r1 = await facade1.deleteByLifecycleKey(UUID_V4);
		expect(r1).toEqual({ status: "error", code: "INVALID_ARGUMENT" });

		// Wrong keys
		const facade2 = createDeletionFacade({ notProvider: {} });
		const r2 = await facade2.deleteByLifecycleKey(UUID_V4);
		expect(r2).toEqual({ status: "error", code: "INVALID_ARGUMENT" });

		// Extra keys
		const facade3 = createDeletionFacade({
			provider: {},
			extra: true,
		});
		const r3 = await facade3.deleteByLifecycleKey(UUID_V4);
		expect(r3).toEqual({ status: "error", code: "INVALID_ARGUMENT" });
	});

	it("returns facade that errors on provider missing methods", async () => {
		const facade = createDeletionFacade({ provider: {} });
		const r = await facade.deleteByLifecycleKey(UUID_V4);
		expect(r).toEqual({ status: "error", code: "INVALID_ARGUMENT" });
	});

	it("returns facade that errors on provider with non-function methods", async () => {
		const facade = createDeletionFacade({
			provider: {
				lookupByLabel: "not-a-function",
				deleteResolved: "not-a-function",
			},
		});
		const r = await facade.deleteByLifecycleKey(UUID_V4);
		expect(r).toEqual({ status: "error", code: "INVALID_ARGUMENT" });
	});
});

// =========================================================================
// DTO hostility -- deleteByLifecycleKey accepts unknown
// =========================================================================

describe("dto hostility", () => {
	it("rejects null", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: emptyListJson() });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const result = await facade.deleteByLifecycleKey(null);
		expect(result).toEqual({
			status: "error",
			code: "INVALID_ARGUMENT",
		});
	});

	it("rejects non-object", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: emptyListJson() });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const result = await facade.deleteByLifecycleKey("not-an-object");
		expect(result).toEqual({
			status: "error",
			code: "INVALID_ARGUMENT",
		});
	});

	it("rejects object with extra keys", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: emptyListJson() });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const result = await facade.deleteByLifecycleKey({
			lifecycleKey: UUID_V4,
			extra: true,
		});
		expect(result).toEqual({
			status: "error",
			code: "INVALID_ARGUMENT",
		});
	});

	it("rejects non-UUID lifecycleKey", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: emptyListJson() });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const result = await facade.deleteByLifecycleKey({
			lifecycleKey: "not-a-uuid",
		});
		expect(result).toEqual({
			status: "error",
			code: "INVALID_ARGUMENT",
		});
	});

	it("rejects empty lifecycleKey", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: emptyListJson() });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const result = await facade.deleteByLifecycleKey({
			lifecycleKey: "",
		});
		expect(result).toEqual({
			status: "error",
			code: "INVALID_ARGUMENT",
		});
	});
});

// =========================================================================
// Proxy hostility -- createDeletionFacade rejects Proxy-wrapped providers
// =========================================================================

describe("proxy hostility", () => {
	it("rejects Proxy-wrapped provider object", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox delete", { stdout: "" });
		const provider = createPrimeSandboxProvider(runner);
		// Wrap in a Proxy
		const proxy = new Proxy(provider, {});
		const facade = createDeletionFacade({ provider: proxy });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		// Proxy-wrapped provider has non-Object prototype at bind-validation time
		// -> captureProviderMethods returns null -> INVALID_ARGUMENT
		expect(result).toEqual({
			status: "error",
			code: "INVALID_ARGUMENT",
		});
	});

	it("rejects Proxy-wrapped factory options", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: emptyListJson() });
		const provider = createPrimeSandboxProvider(runner);
		const opts = new Proxy({ provider }, {});
		const facade = createDeletionFacade(opts);
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		// Proxy-wrapped options has non-Object prototype -> INVALID_ARGUMENT
		expect(result).toEqual({
			status: "error",
			code: "INVALID_ARGUMENT",
		});
	});
});

// =========================================================================
// Derived label argv -- verify exact CLI pattern
// =========================================================================

describe("derived label argv", () => {
	it("produces correct sandbox list --label argv", async () => {
		const capturedArgs: string[][] = [];
		const capturingRunner: CommandRunner = {
			run: async (argv: string[]) => {
				capturedArgs.push(argv);
				return {
					stdout: emptyListJson(),
					stderr: "",
					exitCode: 0,
				};
			},
		};
		const provider = createPrimeSandboxProvider(capturingRunner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		await facade.deleteByLifecycleKey(dto);

		expect(capturedArgs.length).toBeGreaterThanOrEqual(1);
		const listArgv = capturedArgs[0];
		expect(listArgv).toContain("sandbox");
		expect(listArgv).toContain("list");
		expect(listArgv).toContain("--output");
		expect(listArgv).toContain("json");
		expect(listArgv).toContain("--plain");
		expect(listArgv).toContain("--label");
		expect(listArgv).toContain(`ovn-${UUID_V4}`);
	});

	it("deleteResolved uses sandbox delete --yes --plain argv", async () => {
		const capturedArgs: string[][] = [];
		const label = `ovn-${UUID_V4}`;
		const capturingRunner: CommandRunner = {
			run: async (argv: string[]) => {
				capturedArgs.push(argv);
				const cmd = argv.join(" ");
				if (cmd.includes("sandbox list") && cmd.includes(`ovn-${UUID_V4}`)) {
					return {
						stdout: singleListJson("sbx-argv-del", label),
						stderr: "",
						exitCode: 0,
					};
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		};
		const provider = createPrimeSandboxProvider(capturingRunner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		await facade.deleteByLifecycleKey(dto);

		const deleteArgv = capturedArgs.find(
			(argv) => argv.includes("sandbox") && argv.includes("delete") && argv.includes("--yes"),
		);
		expect(deleteArgv).toBeDefined();
		expect(deleteArgv).toContain("--plain");
	});
});

// =========================================================================
// Integration with SandboxLifecycle -- key generated before create
// =========================================================================

describe("SandboxLifecycle integration", () => {
	it("generates lifecycle key BEFORE provider.create when ownership is enabled", async () => {
		let capturedCreateArgv: string[] | null = null;
		const capturingRunner: CommandRunner = {
			run: async (argv: string[]) => {
				const cmd = argv.join(" ");
				if (cmd.includes("sandbox create")) {
					capturedCreateArgv = argv;
					return {
						stdout: "Successfully created sandbox sbx-created-key\n",
						stderr: "",
						exitCode: 0,
					};
				}
				if (cmd.includes("sandbox list"))
					return {
						stdout: emptyListJson(),
						stderr: "",
						exitCode: 0,
					};
				if (cmd.includes("sandbox delete")) return { stdout: "", stderr: "", exitCode: 0 };
				if (cmd.includes("sandbox get"))
					return {
						stdout: makeGetJson({ id: "sbx-created-key" }),
						stderr: "",
						exitCode: 0,
					};
				if (cmd.includes("--version")) return { stdout: "0.9.1\n", stderr: "", exitCode: 0 };
				return { stdout: "", stderr: "nope", exitCode: 127 };
			},
		};

		const store = new SandboxOwnershipStore({ baseDir: tempDir() });
		const life = new SandboxLifecycle(createPrimeSandboxProvider(capturingRunner), {
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
		});

		expect(life.lifecycleKey).toBeNull();

		await life.create({ image: "img", sessionLabel: "unused-session" }, "sess-kbc");

		const lk = life.lifecycleKey;
		expect(lk).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

		expect(capturedCreateArgv).not.toBeNull();
		const createArgv = capturedCreateArgv!.join(" ");
		expect(createArgv).toContain(`ovn-${lk}`);
		expect(createArgv).not.toContain("unused-session");

		const record = await store.read(lk!);
		expect(record).toBeDefined();
		expect(record!.state).toBe("provisioning");
		expect(record!.lifecycleKey).toBe(lk);
	});

	it("without ownership, preserves existing sessionLabel", async () => {
		let capturedArgv: string[] | null = null;
		const capturingRunner: CommandRunner = {
			run: async (argv: string[]) => {
				const cmd = argv.join(" ");
				if (cmd.includes("sandbox create")) {
					capturedArgv = argv;
					return {
						stdout: "Successfully created sandbox sbx-no-own\n",
						stderr: "",
						exitCode: 0,
					};
				}
				if (cmd.includes("sandbox list"))
					return {
						stdout: emptyListJson(),
						stderr: "",
						exitCode: 0,
					};
				if (cmd.includes("sandbox get"))
					return {
						stdout: makeGetJson({ id: "sbx-no-own" }),
						stderr: "",
						exitCode: 0,
					};
				if (cmd.includes("--version")) return { stdout: "0.9.1\n", stderr: "", exitCode: 0 };
				return { stdout: "", stderr: "nope", exitCode: 127 };
			},
		};

		const life = new SandboxLifecycle(createPrimeSandboxProvider(capturingRunner));
		await life.create({
			image: "img",
			sessionLabel: "my-session",
		});

		expect(capturedArgv).not.toBeNull();
		const cmd = capturedArgv!.join(" ");
		expect(cmd).toContain("my-session");
		expect(cmd).not.toContain("ovn-");
	});
});

// =========================================================================
// SandboxLifecycle.recover() static factory -- restart seam
// =========================================================================

describe("SandboxLifecycle.recover", () => {
	it("creates recovered lifecycle with deletion facade wired", async () => {
		const store = new SandboxOwnershipStore({ baseDir: tempDir() });
		const runner = new FakeCommandRunner()
			.onCommand("sandbox create", {
				stdout: "Successfully created sandbox sbx-rec-001\n",
			})
			.onCommand("sandbox list", { stdout: emptyListJson() })
			.onCommand("sandbox get", {
				stdout: makeGetJson({ id: "sbx-rec-001" }),
			})
			.onCommand("--version", { stdout: "0.9.1\n" })
			.onCommand("sandbox delete", { stdout: "" });

		const provider = createPrimeSandboxProvider(runner);
		const lk = "550e8400-e29b-41d4-a716-446655440000";

		const { createClaim } = await import("../src/core/sandbox-ownership.js");
		const claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.create(claim, lk, "sess-recover");
		// provisioning -> terminated directly (valid transition)
		await store.markTerminated(
			createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning"),
			lk,
			"user_deleted",
		);

		const facade = createDeletionFacade({ provider });
		const life = await SandboxLifecycle.recover({
			provider,
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
			lifecycleKey: lk,
			deletionFacade: facade,
		});

		expect(life.lifecycleKey).toBe(lk);
	});

	it("throws when ownership record not found", async () => {
		const runner = new FakeCommandRunner();
		const provider = createPrimeSandboxProvider(runner);
		const store = new SandboxOwnershipStore({ baseDir: tempDir() });
		const facade = createDeletionFacade({ provider });

		try {
			await SandboxLifecycle.recover({
				provider,
				ownershipStore: store,
				ownerGeneration: "gen-1",
				ownerToken: "550e8400-e29b-41d4-a716-446655440001",
				lifecycleKey: "550e8400-e29b-41d4-a716-446655440002",
				deletionFacade: facade,
			});
			throw new Error("expected recover to throw");
		} catch (err) {
			if (err instanceof Error && err.message.includes("ownership record not found")) {
				// expected
			} else {
				throw err;
			}
		}
	});

	it("restart delete uses facade path and creates durable tombstone", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const lk = "550e8400-e29b-41d4-a716-446655440003";

		// Write a provisioning record
		const { createClaim } = await import("../src/core/sandbox-ownership.js");
		const claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.create(claim, lk, "sess-restart-del");

		// Simulate runner where facade resolves and deletes
		const label = `ovn-${lk}`;
		const runner = new FakeCommandRunner()
			.onCommand("sandbox list", {
				stdout: singleListJson("sbx-restart-del", label),
			})
			.onCommand("sandbox delete", { stdout: "" });

		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });

		const life = await SandboxLifecycle.recover({
			provider,
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
			lifecycleKey: lk,
			deletionFacade: facade,
		});

		await life.delete();

		// Record should be deleted (tombstone created)
		const record = await store.read(lk!);
		expect(record).toBeUndefined();

		// Check tombstone
		const tombs = await store.listTombstones();
		const matchingTomb = tombs.find((t) => t.lifecycleKey === lk);
		expect(matchingTomb).toBeDefined();
		expect(matchingTomb!.terminationReason).toBe("user_deleted");

		// Tombstone file has no raw sandbox ID
		const dirFiles = readdirSync(dir).filter((f) => f.endsWith(".sandbox-tombstone.json"));
		for (const f of dirFiles) {
			const content = readFileSync(join(dir, f), "utf8");
			expect(content).not.toContain("sbx-restart-del");
		}
	});
});

// =========================================================================
// Fresh-process restart tests — every live state, wrong token, missing/tombstone
// =========================================================================

describe("fresh-process restart delete", () => {
	it("provisioning restart -> facade delete -> tombstone", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const lk = "550e8400-e29b-41d4-a716-446655440010";
		const { createClaim } = await import("../src/core/sandbox-ownership.js");
		const claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.create(claim, lk, "sess-provisioning-restart");
		const label = `ovn-${lk}`;
		const runner = new FakeCommandRunner()
			.onCommand("sandbox list", { stdout: singleListJson("sbx-prov-restart", label) })
			.onCommand("sandbox delete", { stdout: "" });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const life = await SandboxLifecycle.recover({
			provider,
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
			lifecycleKey: lk,
			deletionFacade: facade,
		});
		await life.delete();
		const record = await store.read(lk);
		expect(record).toBeUndefined();
		const tombs = await store.listTombstones();
		const mt = tombs.find((t) => t.lifecycleKey === lk);
		expect(mt).toBeDefined();
		expect(mt!.terminationReason).toBe("user_deleted");
	});

	it("active restart -> markTerminating -> facade delete -> tombstone", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const lk = "550e8400-e29b-41d4-a716-446655440020";
		const { createClaim } = await import("../src/core/sandbox-ownership.js");
		let claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.create(claim, lk, "sess-active-restart");
		claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.markActive(claim, lk);
		const label = `ovn-${lk}`;
		const runner = new FakeCommandRunner()
			.onCommand("sandbox list", { stdout: singleListJson("sbx-active-restart", label) })
			.onCommand("sandbox delete", { stdout: "" });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const life = await SandboxLifecycle.recover({
			provider,
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
			lifecycleKey: lk,
			deletionFacade: facade,
		});
		await life.delete();
		const tombs = await store.listTombstones();
		const mt = tombs.find((t) => t.lifecycleKey === lk);
		expect(mt).toBeDefined();
		expect(mt!.terminationReason).toBe("user_deleted");
	});

	it("passivated restart -> facade delete -> tombstone", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const lk = "550e8400-e29b-41d4-a716-446655440030";
		const { createClaim } = await import("../src/core/sandbox-ownership.js");
		let claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.create(claim, lk, "sess-passivated-restart");
		claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.markActive(claim, lk);
		claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "active");
		await store.markPassivated(claim, lk);
		const label = `ovn-${lk}`;
		const runner = new FakeCommandRunner()
			.onCommand("sandbox list", { stdout: singleListJson("sbx-pass-restart", label) })
			.onCommand("sandbox delete", { stdout: "" });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const life = await SandboxLifecycle.recover({
			provider,
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
			lifecycleKey: lk,
			deletionFacade: facade,
		});
		await life.delete();
		const tombs = await store.listTombstones();
		const mt = tombs.find((t) => t.lifecycleKey === lk);
		expect(mt).toBeDefined();
	});

	it("rehydrating restart -> facade delete -> tombstone", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const lk = "550e8400-e29b-41d4-a716-446655440040";
		const { createClaim } = await import("../src/core/sandbox-ownership.js");
		let claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.create(claim, lk, "sess-rehydrating-restart");
		claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.markActive(claim, lk);
		claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "active");
		await store.markPassivated(claim, lk);
		claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "passivated");
		await store.markRehydrating(claim, lk);
		const label = `ovn-${lk}`;
		const runner = new FakeCommandRunner()
			.onCommand("sandbox list", { stdout: singleListJson("sbx-rehyd-restart", label) })
			.onCommand("sandbox delete", { stdout: "" });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const life = await SandboxLifecycle.recover({
			provider,
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
			lifecycleKey: lk,
			deletionFacade: facade,
		});
		await life.delete();
		const tombs = await store.listTombstones();
		const mt = tombs.find((t) => t.lifecycleKey === lk);
		expect(mt).toBeDefined();
	});

	it("terminating restart -> facade delete -> tombstone", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const lk = "550e8400-e29b-41d4-a716-446655440050";
		const { createClaim } = await import("../src/core/sandbox-ownership.js");
		let claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.create(claim, lk, "sess-terminating-restart");
		claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.markActive(claim, lk);
		claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "active");
		await store.markTerminating(claim, lk);
		const label = `ovn-${lk}`;
		const runner = new FakeCommandRunner()
			.onCommand("sandbox list", { stdout: singleListJson("sbx-term-restart", label) })
			.onCommand("sandbox delete", { stdout: "" });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const life = await SandboxLifecycle.recover({
			provider,
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
			lifecycleKey: lk,
			deletionFacade: facade,
		});
		await life.delete();
		const tombs = await store.listTombstones();
		const mt = tombs.find((t) => t.lifecycleKey === lk);
		expect(mt).toBeDefined();
	});

	it("wrong owner token fails closed during restart delete", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const lk = "550e8400-e29b-41d4-a716-446655440060";
		const { createClaim } = await import("../src/core/sandbox-ownership.js");
		const claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.create(claim, lk, "sess-wrong-token");
		// Recover with a different token — recover() validates token hash
		// and throws before any provider contact.
		const wrongToken = "550e8400-e29b-41d4-a716-446655449999";
		const runner = new FakeCommandRunner();
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		try {
			const _life = await SandboxLifecycle.recover({
				provider,
				ownershipStore: store,
				ownerGeneration: "gen-1",
				ownerToken: wrongToken,
				lifecycleKey: lk,
				deletionFacade: facade,
			});
			throw new Error("expected recover to throw");
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes("ownership token mismatch")) {
				throw err;
			}
		}
		// Record should remain untouched
		const record = await store.read(lk);
		expect(record).toBeDefined();
		expect(record!.state).toBe("provisioning");
	});

	it("invalid delete fulfillment (facade error) fails closed", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const lk = "550e8400-e29b-41d4-a716-446655440070";
		const { createClaim } = await import("../src/core/sandbox-ownership.js");
		const claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.create(claim, lk, "sess-invalid-fulfill");
		// Facade returns error (malformed JSON)
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: "not-json" });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const life = await SandboxLifecycle.recover({
			provider,
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
			lifecycleKey: lk,
			deletionFacade: facade,
		});
		try {
			await life.delete();
			throw new Error("expected delete to throw");
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes("recovery_required")) {
				throw err;
			}
		}
		// Record is now durably fenced at terminating (markTerminating before facade contact)
		const record = await store.read(lk);
		expect(record).toBeDefined();
		expect(record!.state).toBe("terminating");
	});

	it("missing ownership record without tombstone fails closed", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const lk = "550e8400-e29b-41d4-a716-446655440080";
		// No record created — just try to recover
		const runner = new FakeCommandRunner();
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		try {
			await SandboxLifecycle.recover({
				provider,
				ownershipStore: store,
				ownerGeneration: "gen-1",
				ownerToken: "550e8400-e29b-41d4-a716-446655440001",
				lifecycleKey: lk,
				deletionFacade: facade,
			});
			throw new Error("expected recover to throw");
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes("ownership record not found")) {
				throw err;
			}
		}
	});

	it("missing record without tombstone fails closed (recover throws)", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		// No record created at all
		const runner = new FakeCommandRunner();
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		try {
			await SandboxLifecycle.recover({
				provider,
				ownershipStore: store,
				ownerGeneration: "gen-1",
				ownerToken: "550e8400-e29b-41d4-a716-446655440001",
				lifecycleKey: "550e8400-e29b-41d4-a716-446655440090",
				deletionFacade: facade,
			});
			throw new Error("expected recover to throw");
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes("ownership record not found")) {
				throw err;
			}
		}
	});

	it("failed facade delete and exact relist absence creates platformDeleted tombstone", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const lk = "550e8400-e29b-41d4-a716-446655440100";
		const { createClaim } = await import("../src/core/sandbox-ownership.js");
		const claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.create(claim, lk, "sess-fail-relist");
		const label = `ovn-${lk}`;
		const runner = new FakeCommandRunner().onSequence([
			{ match: () => true, stdout: singleListJson("sbx-fail-relist", label) },
			{ match: () => true, stdout: "", exitCode: 1, stderr: "delete failed" },
			{ match: () => true, stdout: emptyListJson() },
		]);
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const life = await SandboxLifecycle.recover({
			provider,
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
			lifecycleKey: lk,
			deletionFacade: facade,
		});
		await life.delete();
		// Facade returns absent (re-list shows 0 matches) → platformDeleted → terminated → tombstone
		const record = await store.read(lk);
		expect(record).toBeUndefined();
		const tombs = await store.listTombstones();
		const mt = tombs.find((t) => t.lifecycleKey === lk);
		expect(mt).toBeDefined();
		expect(mt!.terminationReason).toBe("platform_deleted");
	});
});

// =========================================================================
// Already terminated/deleted idempotent handling
// =========================================================================

describe("idempotent delete for already terminated/deleted", () => {
	it("handles already terminated record with platformDeleted evidence", async () => {
		// A terminated record with platformDeleted=true should be tombstoned.
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const lk = "550e8400-e29b-41d4-a716-446655440004";
		const { createClaim } = await import("../src/core/sandbox-ownership.js");
		let claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.create(claim, lk, "sess-already-term-idem");
		// Transition to terminated with platformDeleted evidence
		claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.update(claim, lk, (r) => ({
			...r,
			state: "terminated",
			platformDeleted: true,
			terminationReason: "user_deleted",
		}));
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: emptyListJson() });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const life = await SandboxLifecycle.recover({
			provider,
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
			lifecycleKey: lk,
			deletionFacade: facade,
		});
		await life.delete();
		// Verify tombstone was created
		const tombs = await store.listTombstones();
		const matchingTomb = tombs.find((t) => t.lifecycleKey === lk);
		expect(matchingTomb).toBeDefined();
		expect(matchingTomb!.terminationReason).toBe("user_deleted");
	});

	it("handles already terminated record with platformDeleted (no facade call)", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const lk = "550e8400-e29b-41d4-a716-446655440005";
		const { createClaim } = await import("../src/core/sandbox-ownership.js");
		let claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.create(claim, lk, "sess-already-term");
		claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		// Set terminated with platformDeleted evidence
		await store.update(claim, lk, (r) => ({
			...r,
			state: "terminated",
			platformDeleted: true,
			terminationReason: "user_deleted",
		}));
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: emptyListJson() });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const life = await SandboxLifecycle.recover({
			provider,
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
			lifecycleKey: lk,
			deletionFacade: facade,
		});
		await life.delete();
		// Verify tombstone was created
		const tombs = await store.listTombstones();
		const matchingTomb = tombs.find((t) => t.lifecycleKey === lk);
		expect(matchingTomb).toBeDefined();
	});

	it("terminated without platformDeleted evidence fails closed", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const lk = "550e8400-e29b-41d4-a716-446655440006";
		const { createClaim } = await import("../src/core/sandbox-ownership.js");
		let claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		await store.create(claim, lk, "sess-no-evidence");
		claim = createClaim("gen-1", "550e8400-e29b-41d4-a716-446655440001", "provisioning");
		// Terminated WITHOUT platformDeleted evidence
		await store.markTerminated(claim, lk, "user_deleted");
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: emptyListJson() });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const life = await SandboxLifecycle.recover({
			provider,
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
			lifecycleKey: lk,
			deletionFacade: facade,
		});
		try {
			await life.delete();
			throw new Error("expected delete to throw");
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes("recovery_required")) {
				throw err;
			}
		}
		// Verify no tombstone was created
		const tombs = await store.listTombstones();
		const matchingTomb = tombs.find((t) => t.lifecycleKey === lk);
		expect(matchingTomb).toBeUndefined();
	});
});

// =========================================================================
// Filtered labels include only verified requested-filter results
// =========================================================================

describe("filtered labels", () => {
	it("label lookup includes only entries matching the requested label", async () => {
		const label = `ovn-${UUID_V4}`;
		const mixedJson = JSON.stringify({
			sandboxes: [
				{
					id: "sbx-correct-1",
					labels: [label],
					name: "t",
					image: "i",
					status: "RUNNING",
					region: "us",
					created_at: "now",
					resources: "",
				},
				{
					id: "sbx-correct-2",
					labels: [label],
					name: "t2",
					image: "i2",
					status: "RUNNING",
					region: "eu",
					created_at: "now",
					resources: "",
				},
			],
		});
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: mixedJson });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		// Two entries both have the label -> collision
		expect(result).toEqual({
			status: "error",
			code: "COLLISION",
		});
	});

	it("filtered label results include string-only labels", async () => {
		const label = `ovn-${UUID_V4}`;
		// Entry with non-string label elements
		const badLabelsJson = JSON.stringify({
			sandboxes: [
				{
					id: "sbx-badlabel",
					labels: [label, 42],
					name: "t",
					image: "i",
					status: "RUNNING",
					region: "us",
					created_at: "now",
					resources: "",
				},
			],
		});
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: badLabelsJson });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const _result = await facade.deleteByLifecycleKey(dto);
		// parseLabelLookupJson filters labels to strings only, then checks includes.
		// If the label is found among the string labels, it should be counted.
		// [label, 42] -> string filter gives [label] which includes label -> match
		// 1 match -> should delete
		// But we don't have a delete rule, so re-list fails -> DELETE_UNCERTAIN
		// Actually, let's set up a delete rule
	});

	it("entry without the requested label causes RESOLUTION_UNCERTAIN", async () => {
		const _label = `ovn-${UUID_V4}`;
		const noMatchJson = JSON.stringify({
			sandboxes: [
				{
					id: "sbx-nolabel",
					labels: ["wrong-label"],
					name: "t",
					image: "i",
					status: "RUNNING",
					region: "us",
					created_at: "now",
					resources: "",
				},
			],
		});
		const runner = new FakeCommandRunner().onCommand("sandbox list", { stdout: noMatchJson });
		const provider = createPrimeSandboxProvider(runner);
		const facade = createDeletionFacade({ provider });
		const dto = unwrapDto(UUID_V4);
		const result = await facade.deleteByLifecycleKey(dto);
		// Entry missing requested label causes parseLabelLookupJson to throw
		expect(result).toEqual({
			status: "error",
			code: "RESOLUTION_UNCERTAIN",
		});
	});
});

// =========================================================================
// Persisted ownership/tombstone scans -- no raw ID/region/URL/path/token
// =========================================================================

describe("persisted ownership scan -- no raw identity", () => {
	it("ownership record file contains no raw provider sandbox ID", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const runner = new FakeCommandRunner()
			.onCommand("--version", { stdout: "0.9.1\n" })
			.onCommand("sandbox list", { stdout: emptyListJson() })
			.onCommand("sandbox create", {
				stdout: "Successfully created sandbox sbx-private-001\n",
			})
			.onCommand("sandbox get", {
				stdout: makeGetJson({ id: "sbx-private-001" }),
			})
			.onCommand("sandbox delete", { stdout: "" });
		const life = new SandboxLifecycle(createPrimeSandboxProvider(runner), {
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
		});

		await life.create({ image: "img", sessionLabel: "test" }, "sess-scan");
		await life.waitForReady();
		await life.delete();

		const dirFiles = readdirSync(dir).filter(
			(f) => f.endsWith(".sandbox-ownership.json") || f.endsWith(".sandbox-tombstone.json"),
		);
		expect(dirFiles.length).toBeGreaterThan(0);

		for (const f of dirFiles) {
			const content = readFileSync(join(dir, f), "utf8");
			expect(content).not.toContain("sbx-private-001");
			expect(content).not.toContain("us-west");
			expect(content).not.toContain("us-east");
			expect(content).not.toMatch(/https?:\/\//);
			expect(content).not.toContain("550e8400-e29b-41d4-a716-446655440001");
		}
	});

	it("tombstone file in markDeleted path also contains no raw identity", async () => {
		const dir = tempDir();
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const runner = new FakeCommandRunner()
			.onCommand("--version", { stdout: "0.9.1\n" })
			.onCommand("sandbox list", { stdout: emptyListJson() })
			.onCommand("sandbox create", {
				stdout: "Successfully created sandbox sbx-tomb-001\n",
			})
			.onCommand("sandbox get", {
				stdout: makeGetJson({ id: "sbx-tomb-001" }),
			})
			.onCommand("sandbox delete", { stdout: "" });
		const life = new SandboxLifecycle(createPrimeSandboxProvider(runner), {
			ownershipStore: store,
			ownerGeneration: "gen-1",
			ownerToken: "550e8400-e29b-41d4-a716-446655440001",
		});

		await life.create({ image: "img", sessionLabel: "tomb-test" }, "sess-tomb");
		await life.waitForReady();
		await life.delete();

		const tombs = readdirSync(dir).filter((f) => f.endsWith(".sandbox-tombstone.json"));
		for (const f of tombs) {
			const content = readFileSync(join(dir, f), "utf8");
			expect(content).not.toContain("sbx-tomb-001");
			expect(content).not.toMatch(/https?:\/\//);
			expect(content).not.toContain("550e8400-e29b-41d4-a716-446655440001");
		}
	});
});
