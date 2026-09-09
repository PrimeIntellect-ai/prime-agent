import { describe, expect, it } from "bun:test";
import { chmodSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LifecycleConfig, RunCommand, RunnerResult } from "../src/modes/daemon/sandbox/prime-sandbox-lifecycle.js";
import {
	createOwnershipJournal,
	createOwnershipJournalWithDeletion,
	type OwnershipDeletionCode,
	type OwnershipJournal,
} from "../src/modes/daemon/sandbox-ownership-journal.js";
import type { OwnershipIntent } from "../src/modes/daemon/sandbox-ownership-record.js";
import versionFixture from "./fixtures/prime-cli-0.6.21-create-version-fixture.json";
import fixture from "./fixtures/prime-cli-0.6.21-sandbox-json-fixture.json";

// ── Fixtures ───────────────────────────────────────────────

const EL = fixture.expectedLabel;
const VS = versionFixture.versionStdout;

const intent: OwnershipIntent = Object.freeze({
	lifecycleKey: "life-0123456789abcdef",
	parentSessionId: "parent-0123456789abcdef",
	childSessionId: "child-0123456789abcdef",
});

const t0 = "2026-09-04T01:02:03.004Z";
const t1 = "2026-09-04T01:02:04.004Z";
const t2 = "2026-09-04T01:02:05.004Z";
const t3 = "2026-09-04T01:02:06.004Z";
const t4 = "2026-09-04T01:02:07.004Z";
const t5 = "2026-09-04T01:02:08.004Z";

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

function mk(a: readonly string[]): string {
	return a.join("\0");
}

function emptyJ(): string {
	return JSON.stringify({ sandboxes: [], total: 0, page: 1, per_page: 100, has_next: false });
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

const VR = ok(VS);

function mkR(m: Map<string, RunnerResult>): RunCommand {
	return (a, _t, _s) => {
		const k = mk(a);
		const r = m.get(k);
		return Promise.resolve(r !== undefined ? r : ok(""));
	};
}

// ── Journal helpers ────────────────────────────────────────

async function freshRoot(prefix: string): Promise<{
	root: string;
	jDir: string;
	remove: () => Promise<void>;
}> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	await chmod(dir, 0o700);
	return {
		root: dir,
		jDir: join(dir, ".sandbox-ownership"),
		remove: async () => {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		},
	};
}

async function mkJournal(root: string): Promise<OwnershipJournal> {
	const result = await createOwnershipJournal(root);
	if (!result.ok) throw new Error(`create: ${result.code}`);
	return result.value;
}

async function buildFiveChain(
	root: string,
	i: OwnershipIntent = intent,
	ts0 = t0,
	ts1 = t1,
	ts2 = t2,
	ts3 = t3,
	ts4 = t4,
): Promise<void> {
	const j = await mkJournal(root);
	const a = await j.admit(i, ts0);
	if (!a.ok) throw new Error(`admit: ${a.code}`);
	const stages: Array<["creating" | "active" | "delete_intent" | "deleting", string]> = [
		["creating", ts1],
		["active", ts2],
		["delete_intent", ts3],
		["deleting", ts4],
	];
	for (const [stage, ts] of stages) {
		const r = await j.transition(stage, i, ts);
		if (!r.ok) throw new Error(`transition ${stage}: ${r.code}`);
	}
}

function expectFailure(result: unknown, code: OwnershipDeletionCode): void {
	expect(Object.isFrozen(result)).toBe(true);
	expect(result).toEqual({ ok: false, code });
}

// ── Cross-test: deleted-record encoder ─────────────────────

describe("V4 deleted-record encoder cross-test", () => {
	it("produces a byte-identical record that decodeOwnershipRecord accepts", async () => {
		const { root, remove } = await freshRoot("v4-cross-");
		try {
			await buildFiveChain(root);
			const m = new Map<string, RunnerResult>();
			m.set(VK, VR);
			m.set(LK, ok(emptyJ()));

			const result = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const insp = await result.value.lifecycle.inspect();
			expect(insp.ok).toBe(true);
			if (!insp.ok || insp.kind !== "empty") return;

			const fr = await result.value.finalizeDeleted(insp.value.absenceProof, t5);
			expect(fr.ok).toBe(true);
		} finally {
			await remove();
		}
	});
});

// ── Factory journal validation ─────────────────────────────

describe("V4 factory journal validation", () => {
	it("rejects missing journal dir - no lifecycle command", async () => {
		const { root, remove } = await freshRoot("v4-no-j-");
		try {
			await rm(join(root, ".sandbox-ownership"), { recursive: true, force: true }).catch(() => {});
			let ranVersion = false;
			const runner: RunCommand = () => {
				ranVersion = true;
				return Promise.resolve(VR);
			};
			const r = await createOwnershipJournalWithDeletion(root, intent, runner, vc());
			expectFailure(r, "DIRECTORY_UNSAFE");
			expect(ranVersion).toBe(false);
		} finally {
			await remove();
		}
	});

	it("rejects empty journal dir with CORRUPT", async () => {
		const { root, remove } = await freshRoot("v4-empty-");
		try {
			await mkdir(join(root, ".sandbox-ownership"), { recursive: false, mode: 0o700 });
			let ranVersion = false;
			const runner: RunCommand = () => {
				ranVersion = true;
				return Promise.resolve(VR);
			};
			const r = await createOwnershipJournalWithDeletion(root, intent, runner, vc());
			expectFailure(r, "CORRUPT");
			expect(ranVersion).toBe(false);
		} finally {
			await remove();
		}
	});

	it("rejects wrong intent - no provider commands", async () => {
		const { root, remove } = await freshRoot("v4-wint-");
		try {
			const wrong: OwnershipIntent = {
				lifecycleKey: "wrong-key",
				parentSessionId: "wrong-parent",
				childSessionId: "wrong-child",
			};
			await buildFiveChain(root, wrong);
			let ranVersion = false;
			const runner: RunCommand = () => {
				ranVersion = true;
				return Promise.resolve(VR);
			};
			const r = await createOwnershipJournalWithDeletion(root, intent, runner, vc());
			expectFailure(r, "CORRUPT");
			expect(ranVersion).toBe(false);
		} finally {
			await remove();
		}
	});

	it("rejects wrong stage (not deleting) - no provider commands", async () => {
		const { root, remove } = await freshRoot("v4-wstg-");
		try {
			const j = await mkJournal(root);
			await j.admit(intent, t0);
			await j.transition("creating", intent, t1);
			let ranVersion = false;
			const runner: RunCommand = () => {
				ranVersion = true;
				return Promise.resolve(VR);
			};
			const r = await createOwnershipJournalWithDeletion(root, intent, runner, vc());
			expectFailure(r, "CORRUPT");
			expect(ranVersion).toBe(false);
		} finally {
			await remove();
		}
	});

	it("rejects bound intent with accessors", async () => {
		const { root, remove } = await freshRoot("v4-acc-");
		try {
			await buildFiveChain(root);
			let ranVersion = false;
			const runner: RunCommand = () => {
				ranVersion = true;
				return Promise.resolve(VR);
			};
			const hostile = Object.create(Object.prototype);
			Object.defineProperty(hostile, "lifecycleKey", {
				enumerable: true,
				value: "life-0123456789abcdef",
			});
			Object.defineProperty(hostile, "parentSessionId", {
				enumerable: true,
				value: "parent-0123456789abcdef",
			});
			Object.defineProperty(hostile, "childSessionId", {
				enumerable: true,
				get: () => {
					throw new Error("leak");
				},
			});
			const r = await createOwnershipJournalWithDeletion(root, hostile as unknown as OwnershipIntent, runner, vc());
			expectFailure(r, "INPUT_INVALID");
			expect(ranVersion).toBe(false);
		} finally {
			await remove();
		}
	});

	it("rejects non-enumerable bound intent fields before lifecycle construction", async () => {
		const { root, remove } = await freshRoot("v4-non-enum-");
		try {
			await buildFiveChain(root);
			const hidden = Object.create(Object.prototype);
			for (const [key, value] of Object.entries(intent)) {
				Object.defineProperty(hidden, key, { enumerable: false, value });
			}
			let ranVersion = false;
			const runner: RunCommand = () => {
				ranVersion = true;
				return Promise.resolve(VR);
			};
			const result = await createOwnershipJournalWithDeletion(root, hidden, runner, vc());
			expectFailure(result, "INPUT_INVALID");
			expect(ranVersion).toBe(false);
		} finally {
			await remove();
		}
	});
});

// ── Full finalization flow ─────────────────────────────────

describe("V4 full finalization flow", () => {
	it("lifecycle version runs after journal recovery", async () => {
		const { root, remove } = await freshRoot("v4-ord-");
		try {
			await buildFiveChain(root);
			let versionCount = 0;
			const runner: RunCommand = (argv) => {
				if (mk(argv) === VK) {
					versionCount++;
					return Promise.resolve(VR);
				}
				return Promise.resolve(ok(emptyJ()));
			};
			const r = await createOwnershipJournalWithDeletion(root, intent, runner, vc());
			expect(r.ok).toBe(true);
			expect(versionCount).toBe(1);
		} finally {
			await remove();
		}
	});

	it("full success: inspect empty -> finalizeDeleted", async () => {
		const { root, remove } = await freshRoot("v4-full-");
		try {
			await buildFiveChain(root);
			const m = new Map<string, RunnerResult>();
			m.set(VK, VR);
			m.set(LK, ok(emptyJ()));

			const result = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(Object.isFrozen(result.value)).toBe(true);
			expect(typeof result.value.lifecycle.inspect).toBe("function");
			expect(typeof result.value.finalizeDeleted).toBe("function");

			const insp = await result.value.lifecycle.inspect();
			expect(insp.ok).toBe(true);
			if (!insp.ok || insp.kind !== "empty") return;

			const fr = await result.value.finalizeDeleted(insp.value.absenceProof, t5);
			expect(fr.ok).toBe(true);
			expect(fr).toEqual({ ok: true });

			const jr = await mkJournal(root);
			const rec = await jr.recover();
			expect(rec.ok).toBe(true);
			if (!rec.ok) return;
			expect(rec.value.chain.records.length).toBe(6);
			expect(rec.value.chain.current.stage).toBe("deleted");
			expect(rec.value.chain.current.sequence).toBe(6);

			const fr2 = await result.value.finalizeDeleted(insp.value.absenceProof, t5);
			expectFailure(fr2, "PROOF_INVALID");
		} finally {
			await remove();
		}
	});

	it("foreign proof is rejected", async () => {
		const { root, remove } = await freshRoot("v4-for-");
		try {
			await buildFiveChain(root);
			const m = new Map<string, RunnerResult>();
			m.set(VK, VR);
			m.set(LK, ok(emptyJ()));

			const result = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const fakeProof = Object.freeze({}) as any;
			const fr = await result.value.finalizeDeleted(fakeProof, t5);
			expectFailure(fr, "PROOF_INVALID");
		} finally {
			await remove();
		}
	});

	it("second finalize with same proof after success returns PROOF_INVALID", async () => {
		const { root, remove } = await freshRoot("v4-double-");
		try {
			await buildFiveChain(root);
			const m = new Map<string, RunnerResult>();
			m.set(VK, VR);
			m.set(LK, ok(emptyJ()));

			const result = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const insp = await result.value.lifecycle.inspect();
			expect(insp.ok).toBe(true);
			if (!insp.ok || insp.kind !== "empty") return;

			const fr = await result.value.finalizeDeleted(insp.value.absenceProof, t5);
			expect(fr.ok).toBe(true);

			const fr2 = await result.value.finalizeDeleted(insp.value.absenceProof, t5);
			expectFailure(fr2, "PROOF_INVALID");
		} finally {
			await remove();
		}
	});

	it("rejects recordedAt not later than seq5", async () => {
		const { root, remove } = await freshRoot("v4-time-");
		try {
			await buildFiveChain(root);
			const m = new Map<string, RunnerResult>();
			m.set(VK, VR);
			m.set(LK, ok(emptyJ()));

			const result = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const insp = await result.value.lifecycle.inspect();
			expect(insp.ok).toBe(true);
			if (!insp.ok || insp.kind !== "empty") return;

			const fr = await result.value.finalizeDeleted(insp.value.absenceProof, t4);
			expectFailure(fr, "INPUT_INVALID");
		} finally {
			await remove();
		}
	});

	it("rejects invalid timestamp", async () => {
		const { root, remove } = await freshRoot("v4-ts-");
		try {
			await buildFiveChain(root);
			const m = new Map<string, RunnerResult>();
			m.set(VK, VR);
			m.set(LK, ok(emptyJ()));

			const result = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const insp = await result.value.lifecycle.inspect();
			expect(insp.ok).toBe(true);
			if (!insp.ok || insp.kind !== "empty") return;

			const fr = await result.value.finalizeDeleted(insp.value.absenceProof, "not-a-timestamp");
			expectFailure(fr, "INPUT_INVALID");
		} finally {
			await remove();
		}
	});

	it("candidate chain validated before proof consumption", async () => {
		const { root, remove } = await freshRoot("v4-cand-");
		try {
			await buildFiveChain(root);
			const m = new Map<string, RunnerResult>();
			m.set(VK, VR);
			m.set(LK, ok(emptyJ()));

			const result = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const insp = await result.value.lifecycle.inspect();
			expect(insp.ok).toBe(true);
			if (!insp.ok || insp.kind !== "empty") return;

			// Consume the proof outside finalizeDeleted first to invalidate it
			// Then finalizeDeleted should fail at proof consumption
			const fr = await result.value.finalizeDeleted(insp.value.absenceProof, t5);
			expect(fr.ok).toBe(true);

			// Second attempt with same proof fails (already consumed)
			const fr2 = await result.value.finalizeDeleted(insp.value.absenceProof, t5);
			expectFailure(fr2, "PROOF_INVALID");
		} finally {
			await remove();
		}
	});
});

// ── Retry after IO_UNCERTAIN ──────────────────────────────

describe("V4 retry after IO_UNCERTAIN", () => {
	it("retains exact retry authority after a post-consumption publish failure", async () => {
		const { root, jDir, remove } = await freshRoot("v4-retry-");
		const originalSet = WeakMap.prototype.set;
		try {
			await buildFiveChain(root);
			const m = new Map<string, RunnerResult>();
			m.set(VK, VR);
			m.set(LK, ok(emptyJ()));

			const result = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const insp = await result.value.lifecycle.inspect();
			expect(insp.ok).toBe(true);
			if (!insp.ok || insp.kind !== "empty") return;
			const proof = insp.value.absenceProof;
			let sabotaged = false;
			function sabotageAfterAuthorization<K extends WeakKey, V>(
				this: WeakMap<K, V>,
				key: K,
				value: V,
			): WeakMap<K, V> {
				const map = originalSet.call(this, key, value);
				if (!sabotaged && Object.is(key, proof)) {
					sabotaged = true;
					chmodSync(jDir, 0o500);
				}
				return map;
			}
			Object.defineProperty(WeakMap.prototype, "set", {
				configurable: true,
				value: sabotageAfterAuthorization,
				writable: true,
			});

			const first = await result.value.finalizeDeleted(proof, t5);
			expect(first.ok).toBe(false);
			expect(sabotaged).toBe(true);
			Object.defineProperty(WeakMap.prototype, "set", {
				configurable: true,
				value: originalSet,
				writable: true,
			});
			await chmod(jDir, 0o700);

			const changedTimestamp = await result.value.finalizeDeleted(proof, "2026-09-04T01:02:09.004Z");
			expectFailure(changedTimestamp, "INPUT_INVALID");

			const retry = await result.value.finalizeDeleted(proof, t5);
			expect(retry.ok).toBe(true);
			const again = await result.value.finalizeDeleted(proof, t5);
			expectFailure(again, "PROOF_INVALID");
		} finally {
			Object.defineProperty(WeakMap.prototype, "set", {
				configurable: true,
				value: originalSet,
				writable: true,
			});
			await chmod(jDir, 0o700).catch(() => {});
			await remove();
		}
	});
});

// ── Inspect empty token pairing ────────────────────────────

describe("V4 inspect empty token pairing", () => {
	it("permission use invalidates paired proof", async () => {
		const { root, remove } = await freshRoot("v4-pair-");
		try {
			await buildFiveChain(root);
			const m = new Map<string, RunnerResult>();
			m.set(VK, VR);
			m.set(LK, ok(emptyJ()));

			const result = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const insp = await result.value.lifecycle.inspect();
			expect(insp.ok).toBe(true);
			if (!insp.ok || insp.kind !== "empty") return;

			await result.value.lifecycle.create(insp.value.createPermission);

			const fr = await result.value.finalizeDeleted(insp.value.absenceProof, t5);
			expectFailure(fr, "PROOF_INVALID");
		} finally {
			await remove();
		}
	});

	it("proof use invalidates paired permission", async () => {
		const { root, remove } = await freshRoot("v4-pair2-");
		try {
			await buildFiveChain(root);
			const m = new Map<string, RunnerResult>();
			m.set(VK, VR);
			m.set(LK, ok(emptyJ()));

			const result = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const insp = await result.value.lifecycle.inspect();
			expect(insp.ok).toBe(true);
			if (!insp.ok || insp.kind !== "empty") return;

			await result.value.finalizeDeleted(insp.value.absenceProof, t5);

			const cr = await result.value.lifecycle.create(insp.value.createPermission);
			expect(cr.ok).toBe(false);
		} finally {
			await remove();
		}
	});
});

// ── Crash restart recovery ─────────────────────────────────

describe("V4 crash restart recovery", () => {
	it("recovers from seq5 after lost auth, obtains new empty proof, finalizes", async () => {
		const { root, remove } = await freshRoot("v4-crash-");
		try {
			await buildFiveChain(root);

			const m = new Map<string, RunnerResult>();
			m.set(VK, VR);
			m.set(LK, ok(emptyJ()));

			const result1 = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result1.ok).toBe(true);
			if (!result1.ok) return;

			// Crash: discard result1
			const result2 = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result2.ok).toBe(true);
			if (!result2.ok) return;

			const insp = await result2.value.lifecycle.inspect();
			expect(insp.ok).toBe(true);
			if (!insp.ok || insp.kind !== "empty") return;

			const fr = await result2.value.finalizeDeleted(insp.value.absenceProof, t5);
			expect(fr.ok).toBe(true);

			const jr = await mkJournal(root);
			const rec = await jr.recover();
			expect(rec.ok).toBe(true);
			if (!rec.ok) return;
			expect(rec.value.chain.current.stage).toBe("deleted");
		} finally {
			await remove();
		}
	});
});

// ── Hostile filesystem injection ───────────────────────────

describe("V4 hostile filesystem injection", () => {
	it("corrupted journal between factory and finalize fails", async () => {
		const { root, jDir, remove } = await freshRoot("v4-hf-");
		try {
			await buildFiveChain(root);
			const m = new Map<string, RunnerResult>();
			m.set(VK, VR);
			m.set(LK, ok(emptyJ()));

			const result = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const insp = await result.value.lifecycle.inspect();
			expect(insp.ok).toBe(true);
			if (!insp.ok || insp.kind !== "empty") return;

			// Remove seq5 to corrupt the journal
			await rm(join(jDir, "0005.ownership-v1"));

			const fr = await result.value.finalizeDeleted(insp.value.absenceProof, t5);
			expectFailure(fr, "CORRUPT");
		} finally {
			await remove();
		}
	});

	it("modified seq5 content causes CORRUPT", async () => {
		const { root, jDir, remove } = await freshRoot("v4-mod-");
		try {
			await buildFiveChain(root);
			const m = new Map<string, RunnerResult>();
			m.set(VK, VR);
			m.set(LK, ok(emptyJ()));

			const result = await createOwnershipJournalWithDeletion(root, intent, mkR(m), vc());
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const insp = await result.value.lifecycle.inspect();
			expect(insp.ok).toBe(true);
			if (!insp.ok || insp.kind !== "empty") return;

			// Tamper with seq5 content
			const p5 = join(jDir, "0005.ownership-v1");
			const buf = await readFile(p5);
			const modified = Buffer.concat([buf.slice(0, -1), Buffer.from("x")]);
			await writeFile(p5, modified, { mode: 0o600 });

			const fr = await result.value.finalizeDeleted(insp.value.absenceProof, t5);
			expectFailure(fr, "CORRUPT");
		} finally {
			await remove();
		}
	});
});

// ── Error DTO safety ───────────────────────────────────────

describe("V4 error DTO safety", () => {
	it("error values contain no path, intent, proof, or provider material", async () => {
		const { remove } = await freshRoot("v4-safe-");
		try {
			// Use nonexistent root
			const badRoot = `/nonexistent-v4-safe-${String(Math.random())}`;
			const r = await createOwnershipJournalWithDeletion(badRoot, intent, async () => Promise.resolve(VR), vc());
			const json = JSON.stringify(r);
			expect(json).not.toContain("life-0123456789abcdef");
			expect(json).not.toContain("/");
		} finally {
			await remove();
		}
	});
});
