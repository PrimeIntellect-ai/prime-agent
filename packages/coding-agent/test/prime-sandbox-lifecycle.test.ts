import { describe, expect, it } from "bun:test";
import {
	type Clock,
	type CreatePermission,
	createSandboxLifecycle,
	type DelayFn,
	type LifecycleConfig,
	type RunCommand,
	type RunnerResult,
	type SandboxHandle,
} from "../src/modes/daemon/sandbox/prime-sandbox-lifecycle.js";
import versionFixture from "./fixtures/prime-cli-0.6.21-create-version-fixture.json";
import fixture from "./fixtures/prime-cli-0.6.21-sandbox-json-fixture.json";

const EL = fixture.expectedLabel;
const VS = versionFixture.versionStdout;

function vc(): LifecycleConfig {
	return Object.freeze({
		primeCliPath: "/usr/local/bin/prime",
		label: EL,
		image: "ubuntu:24.04",
		name: "test-sandbox",
		cpuCores: 1,
		memoryGb: 1,
		diskSizeGb: 5,
		sandboxTimeoutMinutes: 60,
		operationTimeoutMs: 60000,
		pollIntervalMs: 500,
	});
}

function ok(s: string, se = "", ec = 0): RunnerResult {
	return Object.freeze({ ok: true, value: Object.freeze({ stdout: s, stderr: se, exitCode: ec, durationMs: 100 }) });
}

function fail(c: string): RunnerResult {
	return Object.freeze({ ok: false, code: c }) as unknown as RunnerResult;
}

function mk(a: readonly string[]): string {
	return a.join("\0");
}

function emptyJ(): string {
	return JSON.stringify({ sandboxes: [], total: 0, page: 1, per_page: 100, has_next: false });
}

function makeGetResponse(overrides: Record<string, unknown>): string {
	return JSON.stringify({ ...fixture.get, ...overrides });
}

const VK = mk(["/usr/local/bin/prime", "--version"]);
const LK = mk([
	"/usr/local/bin/prime",
	"--plain",
	"sandbox",
	"list",
	"--label",
	EL,
	"--page",
	"1",
	"--num",
	"100",
	"--output",
	"json",
]);
const GK = mk(["/usr/local/bin/prime", "--plain", "sandbox", "get", "sb_abc123", "--output", "json"]);

function mkR(m: Map<string, RunnerResult>): RunCommand {
	return (a, _t, _s) => {
		const k = mk(a);
		const r = m.get(k);
		return Promise.resolve(r !== undefined ? r : ok(""));
	};
}

const VR = ok(VS);

describe("Construction", () => {
	it("accepts config + version gate", async () => {
		const r = await createSandboxLifecycle(mkR(new Map([[VK, VR]])), vc());
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(Object.isFrozen(r.value)).toBe(true);
			expect(typeof r.value.lifecycle.inspect).toBe("function");
			expect(typeof r.value.lifecycle.create).toBe("function");
			expect(typeof r.value.lifecycle.waitUntilReady).toBe("function");
			expect(typeof r.value.lifecycle.deleteAndProveAbsent).toBe("function");
			expect(typeof r.value.proofConsumer.consumeProof).toBe("function");
		}
	});
	it("CONFIG_REJECTED: rel path", async () => {
		const r = await createSandboxLifecycle(async () => ok(""), { ...vc(), primeCliPath: "x" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CONFIG_REJECTED");
	});
	it("CONFIG_REJECTED: empty label", async () => {
		const r = await createSandboxLifecycle(async () => ok(""), { ...vc(), label: "" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CONFIG_REJECTED");
	});
	it("VERSION_MISMATCH: runner fail", async () => {
		const r = await createSandboxLifecycle(mkR(new Map([[VK, fail("SPAWN_FAILED")]])), vc());
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("VERSION_MISMATCH");
	});
	it("VERSION_MISMATCH: nonzero exit", async () => {
		const r = await createSandboxLifecycle(mkR(new Map([[VK, ok("", "", 1)]])), vc());
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("VERSION_MISMATCH");
	});
	it("VERSION_MISMATCH: wrong output", async () => {
		const r = await createSandboxLifecycle(mkR(new Map([[VK, ok("bad\n")]])), vc());
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("VERSION_MISMATCH");
	});
	it("VERSION_MISMATCH: throws", async () => {
		const r = await createSandboxLifecycle(() => {
			throw new Error("x");
		}, vc());
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("VERSION_MISMATCH");
	});
	it("CONFIG_REJECTED: clock throws", async () => {
		const r = await createSandboxLifecycle(mkR(new Map([[VK, VR]])), vc(), {
			now: () => {
				throw new Error("x");
			},
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CONFIG_REJECTED");
	});
	it("freezes result", async () => {
		const r = await createSandboxLifecycle(mkR(new Map([[VK, VR]])), vc());
		expect(Object.isFrozen(r)).toBe(true);
	});
});

describe("Inspect", () => {
	const oneJ = JSON.stringify({
		sandboxes: [
			{
				id: "sb_abc123",
				name: "",
				image: "u:1",
				status: "RUNNING",
				resources: "1CPU",
				region: null,
				labels: [EL],
				created_at: "2026-09-04 01:02:03 UTC",
				timeout_minutes: 60,
				expires_at: null,
			},
		],
		total: 1,
		page: 1,
		per_page: 100,
		has_next: false,
	});

	it("empty returns permission+absenceProof pair", async () => {
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(emptyJ())],
				]),
			),
			vc(),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const i = await r.value.lifecycle.inspect();
		expect(i.ok).toBe(true);
		if (!i.ok) return;
		expect(i.kind).toBe("empty");
		expect(Object.keys(i.value)).toEqual(["createPermission", "absenceProof"]);
	});
	it("single returns handle", async () => {
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(oneJ)],
					[GK, ok(JSON.stringify(fixture.get))],
				]),
			),
			vc(),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const i = await r.value.lifecycle.inspect();
		expect(i.ok).toBe(true);
		if (!i.ok) return;
		expect(i.kind).toBe("single");
		expect(Object.keys(i.value)).toEqual([]);
	});
	it("COLLISION", async () => {
		const l2 = structuredClone(fixture.list);
		l2.sandboxes.push({ ...l2.sandboxes[0], id: "sb_02" });
		l2.total = 2;
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(JSON.stringify(l2))],
				]),
			),
			vc(),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const i = await r.value.lifecycle.inspect();
		expect(i.ok).toBe(false);
		if (!i.ok) expect(i.code).toBe("COLLISION");
	});
	it("ABORTED", async () => {
		const c = new AbortController();
		c.abort();
		const r = await createSandboxLifecycle(mkR(new Map([[VK, VR]])), vc());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const i = await r.value.lifecycle.inspect(c.signal);
		expect(i.ok).toBe(false);
		if (!i.ok) expect(i.code).toBe("ABORTED");
	});
});

describe("Create", () => {
	const CS =
		"\nSuccessfully created sandbox sb_abc123\nUse 'prime sandbox get sb_abc123' to check the sandbox status\n";
	const CK = mk([
		"/usr/local/bin/prime",
		"--plain",
		"sandbox",
		"create",
		"ubuntu:24.04",
		"--name",
		"test-sandbox",
		"--cpu-cores",
		"1",
		"--memory-gb",
		"1",
		"--disk-size-gb",
		"5",
		"--timeout-minutes",
		"60",
		"--label",
		EL,
		"--yes",
	]);

	it("creates and returns handle", async () => {
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(emptyJ())],
					[CK, ok(CS)],
					[GK, ok(JSON.stringify(fixture.get))],
				]),
			),
			vc(),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const insp = await r.value.lifecycle.inspect();
		expect(insp.ok).toBe(true);
		if (!insp.ok || insp.kind !== "empty") return;
		const cr = await r.value.lifecycle.create(insp.value.createPermission);
		expect(cr.ok).toBe(true);
		if (cr.ok) expect(Object.keys(cr.value)).toEqual([]);
	});
	it("TOKEN_CONSUMED", async () => {
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(emptyJ())],
					[CK, ok(CS)],
					[GK, ok(JSON.stringify(fixture.get))],
				]),
			),
			vc(),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const insp = await r.value.lifecycle.inspect();
		expect(insp.ok).toBe(true);
		if (!insp.ok || insp.kind !== "empty") return;
		await r.value.lifecycle.create(insp.value.createPermission);
		const s = await r.value.lifecycle.create(insp.value.createPermission);
		expect(s.ok).toBe(false);
		if (!s.ok) expect(s.code).toBe("TOKEN_CONSUMED");
	});
	it("TOKEN_INVALID", async () => {
		const r = await createSandboxLifecycle(mkR(new Map([[VK, VR]])), vc());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const cr = await r.value.lifecycle.create(Object.freeze({}) as unknown as CreatePermission);
		expect(cr.ok).toBe(false);
		if (!cr.ok) expect(cr.code).toBe("TOKEN_INVALID");
	});
	it("RECOVERY_REQUIRED", async () => {
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(emptyJ())],
					[CK, ok("bad\n")],
				]),
			),
			vc(),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const insp = await r.value.lifecycle.inspect();
		expect(insp.ok).toBe(true);
		if (!insp.ok || insp.kind !== "empty") return;
		const cr = await r.value.lifecycle.create(insp.value.createPermission);
		expect(cr.ok).toBe(false);
		if (!cr.ok) expect(cr.code).toBe("RECOVERY_REQUIRED");
	});
});

describe("WaitUntilReady", () => {
	const oneJ = JSON.stringify({
		sandboxes: [
			{
				id: "sb_abc123",
				name: "",
				image: "u:1",
				status: "RUNNING",
				resources: "1CPU",
				region: null,
				labels: [EL],
				created_at: "2026-09-04 01:02:03 UTC",
				timeout_minutes: 60,
				expires_at: null,
			},
		],
		total: 1,
		page: 1,
		per_page: 100,
		has_next: false,
	});

	it("RUNNING ok", async () => {
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(oneJ)],
					[GK, ok(JSON.stringify({ ...fixture.get, status: "RUNNING" }))],
				]),
			),
			vc(),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const insp = await r.value.lifecycle.inspect();
		expect(insp.ok).toBe(true);
		if (!insp.ok || insp.kind !== "single") return;
		const w = await r.value.lifecycle.waitUntilReady(insp.value);
		expect(w.ok).toBe(true);
	});
	it("ERROR terminal", async () => {
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(oneJ)],
					[GK, ok(JSON.stringify({ ...fixture.get, status: "ERROR" }))],
				]),
			),
			vc(),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const insp = await r.value.lifecycle.inspect();
		expect(insp.ok).toBe(true);
		if (!insp.ok || insp.kind !== "single") return;
		const w = await r.value.lifecycle.waitUntilReady(insp.value);
		expect(w.ok).toBe(false);
		if (!w.ok) expect(w.code).toBe("READY_TERMINAL");
	});
	it("HANDLE_INVALID", async () => {
		const r = await createSandboxLifecycle(mkR(new Map([[VK, VR]])), vc());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const w = await r.value.lifecycle.waitUntilReady(Object.freeze({}) as unknown as SandboxHandle);
		expect(w.ok).toBe(false);
		if (!w.ok) expect(w.code).toBe("HANDLE_INVALID");
	});
});

describe("DeleteAndProveAbsent", () => {
	it("HANDLE_INVALID", async () => {
		const r = await createSandboxLifecycle(mkR(new Map([[VK, VR]])), vc());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const dr = await r.value.lifecycle.deleteAndProveAbsent(Object.freeze({}) as unknown as SandboxHandle);
		expect(dr.ok).toBe(false);
		if (!dr.ok) expect(dr.code).toBe("HANDLE_INVALID");
	});

	it("malformed absence evidence never mints a proof or reissues delete", async () => {
		const deleteKey = mk(["/usr/local/bin/prime", "--plain", "sandbox", "delete", "sb_abc123", "--yes"]);
		let listCalls = 0;
		let deleteCalls = 0;
		const runner: RunCommand = (argv) => {
			const key = mk(argv);
			if (key === VK) return Promise.resolve(VR);
			if (key === LK) {
				listCalls++;
				return Promise.resolve(ok(listCalls === 1 ? JSON.stringify(fixture.list) : "{"));
			}
			if (key === GK) return Promise.resolve(ok(JSON.stringify(fixture.get)));
			if (key === deleteKey) {
				deleteCalls++;
				return Promise.resolve(fail("TIMED_OUT"));
			}
			return Promise.resolve(ok(""));
		};
		const created = await createSandboxLifecycle(runner, vc());
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const inspected = await created.value.lifecycle.inspect();
		expect(inspected.ok).toBe(true);
		if (!inspected.ok || inspected.kind !== "single") return;
		const deleted = await created.value.lifecycle.deleteAndProveAbsent(inspected.value);
		expect(deleted).toEqual({ ok: false, code: "ABSENCE_UNCERTAIN" });
		expect(deleteCalls).toBe(1);
		const repeated = await created.value.lifecycle.deleteAndProveAbsent(inspected.value);
		expect(repeated).toEqual({ ok: false, code: "DUPLICATE_DELETE" });
		expect(deleteCalls).toBe(1);
	});
});

describe("Edge", () => {
	it("ABORTED propagation", async () => {
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, fail("ABORTED")],
				]),
			),
			vc(),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const i = await r.value.lifecycle.inspect();
		expect(i.ok).toBe(false);
		if (!i.ok) expect(i.code).toBe("ABORTED");
	});
	it("TIMED_OUT -> UNCERTAIN", async () => {
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, fail("TIMED_OUT")],
				]),
			),
			vc(),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const i = await r.value.lifecycle.inspect();
		expect(i.ok).toBe(false);
		if (!i.ok) expect(i.code).toBe("UNCERTAIN");
	});
	it("no private data in errors", async () => {
		const c = new AbortController();
		c.abort();
		const r = await createSandboxLifecycle(mkR(new Map([[VK, VR]])), vc());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const i = await r.value.lifecycle.inspect(c.signal);
		const js = JSON.stringify(i);
		expect(js).not.toContain("sb_");
		expect(js).not.toContain(EL);
	});
	it("foreign handle cross-adapter", async () => {
		const oneJ = JSON.stringify({
			sandboxes: [
				{
					id: "sb_0a",
					name: "",
					image: "u:1",
					status: "RUNNING",
					resources: "1CPU",
					region: null,
					labels: [EL],
					created_at: "2026-09-04 01:02:03 UTC",
					timeout_minutes: 60,
					expires_at: null,
				},
			],
			total: 1,
			page: 1,
			per_page: 100,
			has_next: false,
		});
		const gkx = mk(["/usr/local/bin/prime", "--plain", "sandbox", "get", "sb_0a", "--output", "json"]);
		const a1 = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(oneJ)],
					[gkx, ok(JSON.stringify({ ...fixture.get, id: "sb_0a" }))],
				]),
			),
			vc(),
		);
		expect(a1.ok).toBe(true);
		if (!a1.ok) return;
		const insp = await a1.value.lifecycle.inspect();
		expect(insp.ok).toBe(true);
		if (!insp.ok || insp.kind !== "single") return;
		const a2 = await createSandboxLifecycle(mkR(new Map([[VK, VR]])), vc());
		expect(a2.ok).toBe(true);
		if (!a2.ok) return;
		const w = await a2.value.lifecycle.waitUntilReady(insp.value);
		expect(w.ok).toBe(false);
		if (!w.ok) expect(w.code).toBe("HANDLE_INVALID");
	});
	it("permission cross-adapter", async () => {
		const a1 = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(emptyJ())],
				]),
			),
			vc(),
		);
		expect(a1.ok).toBe(true);
		if (!a1.ok) return;
		const insp = await a1.value.lifecycle.inspect();
		expect(insp.ok).toBe(true);
		if (!insp.ok || insp.kind !== "empty") return;
		const a2 = await createSandboxLifecycle(mkR(new Map([[VK, VR]])), vc());
		expect(a2.ok).toBe(true);
		if (!a2.ok) return;
		const cr = await a2.value.lifecycle.create(insp.value.createPermission);
		expect(cr.ok).toBe(false);
		if (!cr.ok) expect(cr.code).toBe("TOKEN_INVALID");
	});
});
describe("ProofConsumer", () => {
	it("full flow: delete produces proof, consume once ok, second fails, foreign rejects", async () => {
		const oneJ = JSON.stringify({
			sandboxes: [
				{
					id: "sb_0f",
					name: "",
					image: "u:1",
					status: "RUNNING",
					resources: "1CPU",
					region: null,
					labels: [EL],
					created_at: "2026-09-04 01:02:03 UTC",
					timeout_minutes: 60,
					expires_at: null,
				},
			],
			total: 1,
			page: 1,
			per_page: 100,
			has_next: false,
		});
		const gk = mk(["/usr/local/bin/prime", "--plain", "sandbox", "get", "sb_0f", "--output", "json"]);
		const dk = mk(["/usr/local/bin/prime", "--plain", "sandbox", "delete", "sb_0f", "--yes"]);
		const m = new Map();
		m.set(VK, VR);
		m.set(LK, ok(oneJ));
		m.set(gk, ok(makeGetResponse({ id: "sb_0f" })));
		m.set(dk, ok("Deleted.\n"));
		let deleteCalls = 0;
		const runner = (a: readonly string[], _t: number, _s?: AbortSignal) => {
			const k = mk(a);
			const r = m.get(k);
			if (k === LK) {
				m.set(LK, ok(emptyJ()));
			}
			if (k === dk) deleteCalls++;
			return Promise.resolve(r !== undefined ? r : ok(""));
		};
		const r = await createSandboxLifecycle(runner, vc());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const bundle = r.value;
		const insp = await bundle.lifecycle.inspect();
		expect(insp.ok).toBe(true);
		if (!insp.ok || insp.kind !== "single") return;
		const delResult = await bundle.lifecycle.deleteAndProveAbsent(insp.value);
		expect(deleteCalls).toBe(1);
		expect(delResult.ok).toBe(true);
		if (!delResult.ok) return;
		const proof = delResult.value;
		const consume1 = bundle.proofConsumer.consumeProof(proof);
		expect(consume1.ok).toBe(true);
		const consume2 = bundle.proofConsumer.consumeProof(proof);
		expect(consume2.ok).toBe(false);
		if (!consume2.ok) expect(consume2.code).toBe("PROOF_INVALID");
		const r2 = await createSandboxLifecycle(mkR(new Map([[VK, VR]])), vc());
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;
		const foreignResult = r2.value.proofConsumer.consumeProof(proof);
		expect(foreignResult.ok).toBe(false);
		if (!foreignResult.ok) expect(foreignResult.code).toBe("PROOF_INVALID");
	});
});
describe("Delay deadline bound", () => {
	it("injected hanging delay produces UNCERTAIN under bounded guard", async () => {
		const hangDelay: DelayFn = () => new Promise(() => {});
		const shortCfg = { ...vc(), operationTimeoutMs: 200, pollIntervalMs: 1000 };
		const oneJ = JSON.stringify({
			sandboxes: [
				{
					id: "sb_0c",
					name: "",
					image: "u:1",
					status: "PENDING",
					resources: "1CPU",
					region: null,
					labels: [EL],
					created_at: "2026-09-04 01:02:03 UTC",
					timeout_minutes: 60,
					expires_at: null,
				},
			],
			total: 1,
			page: 1,
			per_page: 100,
			has_next: false,
		});
		const gk0c = mk(["/usr/local/bin/prime", "--plain", "sandbox", "get", "sb_0c", "--output", "json"]);
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(oneJ)],
					[gk0c, ok(makeGetResponse({ id: "sb_0c", status: "PENDING" }))],
				]),
			),
			shortCfg,
			undefined,
			hangDelay,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const bundle = r.value;
		const insp = await bundle.lifecycle.inspect();
		expect(insp.ok).toBe(true);
		if (!insp.ok || insp.kind !== "single") return;
		const t0 = Date.now();
		const w = await bundle.lifecycle.waitUntilReady(insp.value);
		const elapsed = Date.now() - t0;
		expect(w.ok).toBe(false);
		if (!w.ok) expect(w.code).toBe("UNCERTAIN");
		expect(elapsed).toBeLessThan(5000);
	});

	it("caller abort beats a hanging injected delay", async () => {
		const pendingList = JSON.stringify({
			...fixture.list,
			sandboxes: fixture.list.sandboxes.map((row) => ({ ...row, status: "PENDING" })),
		});
		const hangDelay: DelayFn = () => new Promise(() => {});
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(pendingList)],
					[GK, ok(makeGetResponse({ status: "PENDING" }))],
				]),
			),
			{ ...vc(), operationTimeoutMs: 1000, pollIntervalMs: 1000 },
			undefined,
			hangDelay,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const inspected = await r.value.lifecycle.inspect();
		expect(inspected.ok).toBe(true);
		if (!inspected.ok || inspected.kind !== "single") return;
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const startedAt = Date.now();
		const result = await r.value.lifecycle.waitUntilReady(inspected.value, controller.signal);
		expect(result).toEqual({ ok: false, code: "ABORTED" });
		expect(Date.now() - startedAt).toBeLessThan(500);
	});
});
describe("Strict config validation", () => {
	it("rejects config with extra keys", async () => {
		const c = { ...vc(), extraKey: true };
		const r = await createSandboxLifecycle(async () => ok(""), c);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CONFIG_REJECTED");
	});
	it("rejects config with missing keys", async () => {
		const { primeCliPath: _, ...rest } = vc();
		const r = await createSandboxLifecycle(async () => ok(""), rest as any);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CONFIG_REJECTED");
	});
	it("rejects config with symbol keys", async () => {
		const c = Object.assign({}, vc(), { [Symbol("x")]: 1 });
		const r = await createSandboxLifecycle(async () => ok(""), c);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CONFIG_REJECTED");
	});
	it("rejects image starting with dash", async () => {
		const r = await createSandboxLifecycle(async () => ok(""), { ...vc(), image: "-image" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CONFIG_REJECTED");
	});
});

describe("Static clock poll limits", () => {
	it("POLL_LIMIT under static clock", async () => {
		const staticClock: Clock = { now: () => 1000 };
		const immediateDelay: DelayFn = async () => "elapsed";
		const oneJ = JSON.stringify({
			sandboxes: [
				{
					id: "sb_0d",
					name: "",
					image: "u:1",
					status: "PENDING",
					resources: "1CPU",
					region: null,
					labels: [EL],
					created_at: "2026-09-04 01:02:03 UTC",
					timeout_minutes: 60,
					expires_at: null,
				},
			],
			total: 1,
			page: 1,
			per_page: 100,
			has_next: false,
		});
		const gk0d = mk(["/usr/local/bin/prime", "--plain", "sandbox", "get", "sb_0d", "--output", "json"]);
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(oneJ)],
					[gk0d, ok(makeGetResponse({ id: "sb_0d", status: "PENDING" }))],
				]),
			),
			{ ...vc(), pollIntervalMs: 10 },
			staticClock,
			immediateDelay,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const bundle = r.value;
		const insp = await bundle.lifecycle.inspect();
		expect(insp.ok).toBe(true);
		if (!insp.ok || insp.kind !== "single") return;
		const w = await bundle.lifecycle.waitUntilReady(insp.value);
		expect(w.ok).toBe(false);
		if (!w.ok) expect(w.code).toBe("POLL_LIMIT");
	});
	it("infinite pagination blocked by completed flag", async () => {
		let listCalls = 0;
		const infRunner: RunCommand = (a, _t, _s) => {
			if (a[1] === "--version") return Promise.resolve(VR);
			const pageFlag = a.indexOf("--page");
			if (pageFlag >= 0) {
				listCalls++;
				const page = Number(a[pageFlag + 1]);
				const first = (page - 1) * 100;
				const sandboxes = Array.from({ length: 100 }, (_, offset) => ({
					...fixture.list.sandboxes[0],
					id: `sb_${(first + offset).toString(16).padStart(8, "0")}`,
				}));
				return Promise.resolve(
					ok(
						JSON.stringify({
							sandboxes,
							total: 100_000,
							page,
							per_page: 100,
							has_next: true,
						}),
					),
				);
			}
			return Promise.resolve(ok(""));
		};
		const r = await createSandboxLifecycle(infRunner, vc());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const insp = await r.value.lifecycle.inspect();
		expect(listCalls).toBe(1000);
		expect(insp.ok).toBe(false);
		if (!insp.ok) expect(insp.code).toBe("UNCERTAIN");
	});
});
describe("Container proof in waitUntilReady", () => {
	it("rejects VM sandbox", async () => {
		const oneJ = JSON.stringify({
			sandboxes: [
				{
					id: "sb_0e",
					name: "",
					image: "u:1",
					status: "RUNNING",
					resources: "1CPU",
					region: null,
					labels: [EL],
					created_at: "2026-09-04 01:02:03 UTC",
					timeout_minutes: 60,
					expires_at: null,
				},
			],
			total: 1,
			page: 1,
			per_page: 100,
			has_next: false,
		});
		const gk0e = mk(["/usr/local/bin/prime", "--plain", "sandbox", "get", "sb_0e", "--output", "json"]);
		const r = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(oneJ)],
					[gk0e, ok(makeGetResponse({ id: "sb_0e", vm: true, type: "VM" }))],
				]),
			),
			vc(),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const insp = await r.value.lifecycle.inspect();
		// inspect already rejects VM, so this should be UNCERTAIN
		expect(insp.ok).toBe(false);
	});

	it("runner non-finite exitCode => UNCERTAIN", async () => {
		const m = new Map([
			[VK, VR],
			[LK, { ok: true, value: { stdout: "", stderr: "", exitCode: Infinity, durationMs: 100 } } as any],
		]);
		const r = await createSandboxLifecycle(mkR(m), vc());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const insp = await r.value.lifecycle.inspect();
		expect(insp.ok).toBe(false);
		if (!insp.ok) expect(insp.code).toBe("UNCERTAIN");
	});
	it("runner unknown failure code => UNCERTAIN", async () => {
		const m = new Map([
			[VK, VR],
			[LK, { ok: false, code: "MYSTERY_FAILURE" } as any],
		]);
		const r = await createSandboxLifecycle(mkR(m), vc());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const insp = await r.value.lifecycle.inspect();
		expect(insp.ok).toBe(false);
		if (!insp.ok) expect(insp.code).toBe("UNCERTAIN");
	});
	it("Proxy config ownKeys throws => CONFIG_REJECTED", async () => {
		const proxy = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error("x");
				},
			},
		);
		const r = await createSandboxLifecycle(async () => ok(""), proxy as any);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CONFIG_REJECTED");
	});
	it("Proxy config getOwnPropertyDescriptor throws => CONFIG_REJECTED", async () => {
		const proxy = new Proxy(
			{ primeCliPath: "/x" },
			{
				getOwnPropertyDescriptor() {
					throw new Error("x");
				},
			},
		);
		const r = await createSandboxLifecycle(async () => ok(""), proxy as any);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("CONFIG_REJECTED");
	});
});

describe("Hostile runner result validation", () => {
	it("runner with extra keys => UNCERTAIN", async () => {
		const m = new Map([
			[VK, VR],
			[LK, { ok: true, value: { stdout: "", stderr: "", exitCode: 0, durationMs: 100 }, extra: true } as any],
		]);
		const r = await createSandboxLifecycle(mkR(m), vc());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const insp = await r.value.lifecycle.inspect();
		expect(insp.ok).toBe(false);
		if (!insp.ok) expect(insp.code).toBe("UNCERTAIN");
	});
	it("runner with symbol key => UNCERTAIN", async () => {
		const rv: any = { ok: true, value: { stdout: "", stderr: "", exitCode: 0, durationMs: 100 } };
		Object.defineProperty(rv, Symbol("x"), { value: 1 });
		const m = new Map([
			[VK, VR],
			[LK, rv],
		]);
		const r = await createSandboxLifecycle(mkR(m), vc());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const insp = await r.value.lifecycle.inspect();
		expect(insp.ok).toBe(false);
		if (!insp.ok) expect(insp.code).toBe("UNCERTAIN");
	});

	it("copies validated runner data without invoking Proxy get traps", async () => {
		const proxiedVersion = new Proxy(VR, {
			get: (_target, key) => {
				if (key === "then") return undefined;
				throw new Error("runner getter invoked");
			},
		});
		const result = await createSandboxLifecycle(async () => proxiedVersion, vc());
		expect(result.ok).toBe(true);
	});
});

describe("Inspect empty absence proof", () => {
	it("is genuine, frozen, one-shot, and factory-bound", async () => {
		const first = await createSandboxLifecycle(
			mkR(
				new Map([
					[VK, VR],
					[LK, ok(emptyJ())],
				]),
			),
			vc(),
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const inspected = await first.value.lifecycle.inspect();
		expect(inspected.ok).toBe(true);
		if (!inspected.ok || inspected.kind !== "empty") return;
		expect(Object.isFrozen(inspected.value)).toBe(true);

		const second = await createSandboxLifecycle(mkR(new Map([[VK, VR]])), vc());
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.value.proofConsumer.consumeProof(inspected.value.absenceProof)).toEqual({
			ok: false,
			code: "PROOF_INVALID",
		});
		expect(first.value.proofConsumer.consumeProof(inspected.value.absenceProof)).toEqual({ ok: true });
		expect(first.value.proofConsumer.consumeProof(inspected.value.absenceProof)).toEqual({
			ok: false,
			code: "PROOF_INVALID",
		});
	});

	it("permission use invalidates its paired proof before a failed create", async () => {
		const runner: RunCommand = (argv) => {
			const key = mk(argv);
			if (key === VK) return Promise.resolve(VR);
			if (key === LK) return Promise.resolve(ok(emptyJ()));
			return Promise.resolve(fail("SPAWN_FAILED"));
		};
		const created = await createSandboxLifecycle(runner, vc());
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const inspected = await created.value.lifecycle.inspect();
		expect(inspected.ok).toBe(true);
		if (!inspected.ok || inspected.kind !== "empty") return;
		expect(await created.value.lifecycle.create(inspected.value.createPermission)).toEqual({
			ok: false,
			code: "RECOVERY_REQUIRED",
		});
		expect(created.value.proofConsumer.consumeProof(inspected.value.absenceProof)).toEqual({
			ok: false,
			code: "PROOF_INVALID",
		});
	});

	it("proof use invalidates its paired permission before provider effects", async () => {
		let providerEffects = 0;
		const runner: RunCommand = (argv) => {
			const key = mk(argv);
			if (key === VK) return Promise.resolve(VR);
			if (key === LK) return Promise.resolve(ok(emptyJ()));
			providerEffects++;
			return Promise.resolve(ok(""));
		};
		const created = await createSandboxLifecycle(runner, vc());
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const inspected = await created.value.lifecycle.inspect();
		expect(inspected.ok).toBe(true);
		if (!inspected.ok || inspected.kind !== "empty") return;
		expect(created.value.proofConsumer.consumeProof(inspected.value.absenceProof)).toEqual({ ok: true });
		expect(await created.value.lifecycle.create(inspected.value.createPermission)).toEqual({
			ok: false,
			code: "TOKEN_CONSUMED",
		});
		expect(providerEffects).toBe(0);
	});
});
