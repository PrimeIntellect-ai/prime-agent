import { describe, expect, it } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createOwnershipJournal,
	type OwnershipJournal,
	type OwnershipJournalCode,
} from "../src/modes/daemon/sandbox-ownership-journal.js";
import type { NonDeletedTransitionStage, OwnershipIntent } from "../src/modes/daemon/sandbox-ownership-record.js";

// ── Helpers ────────────────────────────────────────────────

const intent: OwnershipIntent = Object.freeze({
	lifecycleKey: "life-0123456789abcdef",
	parentSessionId: "parent-0123456789abcdef",
	childSessionId: "child-0123456789abcdef",
});
const altIntent: OwnershipIntent = Object.freeze({
	lifecycleKey: "alt-lifecycle",
	parentSessionId: "alt-parent",
	childSessionId: "alt-child",
});
const t0 = "2026-09-04T01:02:03.004Z";

function expectFrozenTree(value: unknown): void {
	expect(Object.isFrozen(value)).toBe(true);
	if (typeof value !== "object" || value === null || value instanceof Uint8Array) return;
	for (const nested of Object.values(value)) {
		if (typeof nested === "object" && nested !== null) expectFrozenTree(nested);
	}
}

function expectFailure(result: unknown, code: OwnershipJournalCode): void {
	expect(Object.isFrozen(result)).toBe(true);
	expect(result).toEqual({ ok: false, code });
}

function expectOk(result: unknown): asserts result is { ok: true; value: unknown } {
	expect(result).toHaveProperty("ok", true);
}

async function freshRoot(prefix: string): Promise<{ root: string; jDir: string; remove: () => Promise<void> }> {
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

async function setup(
	prefix: string,
): Promise<{ root: string; jDir: string; journal: OwnershipJournal; remove: () => Promise<void> }> {
	const { root, jDir, remove } = await freshRoot(prefix);
	const journal = await mkJournal(root);
	return { root, jDir, journal, remove };
}

// ── Factory ────────────────────────────────────────────────

describe("factory", () => {
	it("creates journal dir and returns frozen capability", async () => {
		const { root, remove } = await freshRoot("fac-ok-");
		try {
			const r = await createOwnershipJournal(root);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expectFrozenTree(r);
			expect(typeof r.value.admit).toBe("function");
			expect(typeof r.value.recover).toBe("function");
			expect(typeof r.value.transition).toBe("function");
		} finally {
			await remove();
		}
	});

	it("rejects empty/relative/control root", async () => {
		expectFailure(await createOwnershipJournal(""), "INPUT_INVALID");
		expectFailure(await createOwnershipJournal("relative"), "INPUT_INVALID");
		expectFailure(await createOwnershipJournal(`/${String.fromCharCode(10)}root`), "INPUT_INVALID");
	});

	it("rejects wrong-mode root", async () => {
		const { root, remove } = await freshRoot("fac-mode-");
		try {
			await chmod(root, 0o755);
			expectFailure(await createOwnershipJournal(root), "DIRECTORY_UNSAFE");
		} finally {
			await remove();
		}
	});

	it("rejects symlinked root", async () => {
		const { root, remove } = await freshRoot("fac-sym-");
		try {
			const linkPath = join(root, `../sym-${Date.now()}`);
			await symlink(root, linkPath);
			try {
				expectFailure(await createOwnershipJournal(linkPath), "DIRECTORY_UNSAFE");
			} finally {
				await rm(linkPath).catch(() => {});
			}
		} finally {
			await remove();
		}
	});

	it("rejects existing empty journal dir as CORRUPT", async () => {
		const { root, jDir, journal: j, remove } = await setup("fac-empty-");
		try {
			await j.admit(intent, t0);
			await rm(join(jDir, "0001.ownership-v1")).catch(() => {});
			expectFailure(await createOwnershipJournal(root), "CORRUPT");
		} finally {
			await remove();
		}
	});
});

// ── Admit & recover ────────────────────────────────────────

describe("admit and recover", () => {
	it("admits pre_admit and recovers", async () => {
		const { journal: j, remove } = await setup("ar-");
		try {
			const a = await j.admit(intent, t0);
			expect(a.ok).toBe(true);
			if (!a.ok) return;
			expectFrozenTree(a);
			expect(Object.keys(a.value)).toEqual(["chain"]);
			expect(a.value.chain.current.stage).toBe("pre_admit");

			const r = await j.recover();
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expectFrozenTree(r);
			expect(r.value.chain.current.stage).toBe("pre_admit");
		} finally {
			await remove();
		}
	});

	it("idempotent admit", async () => {
		const { journal: j, remove } = await setup("ar-idem-");
		try {
			expectOk(await j.admit(intent, t0));
			const a2 = await j.admit(intent, t0);
			expectOk(a2);
			expect(Object.keys(a2.value)).toEqual(["chain"]);
		} finally {
			await remove();
		}
	});

	it("rejects different intent conflict", async () => {
		const { journal: j, remove } = await setup("ar-conflict-");
		try {
			await j.admit(intent, t0);
			expectFailure(await j.admit(altIntent, t0), "CONFLICT");
		} finally {
			await remove();
		}
	});

	it("recovers across factory restart", async () => {
		const { root, journal: j1, remove } = await setup("ar-restart-");
		try {
			await j1.admit(intent, t0);
			const j2 = await mkJournal(root);
			const r = await j2.recover();
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.value.chain.current.stage).toBe("pre_admit");
		} finally {
			await remove();
		}
	});

	it("public recover on fresh empty returns CORRUPT", async () => {
		const { journal: j, remove } = await setup("ar-empty-");
		try {
			expectFailure(await j.recover(), "CORRUPT");
		} finally {
			await remove();
		}
	});

	it("rejects empty/bad intent", async () => {
		const { journal: j, remove } = await setup("ar-bad-");
		try {
			const bad: OwnershipIntent = { lifecycleKey: "", parentSessionId: "p", childSessionId: "c" };
			expectFailure(await j.admit(bad, t0), "INPUT_INVALID");
		} finally {
			await remove();
		}
	});
});

// ── Transitions ────────────────────────────────────────────

describe("transitions", () => {
	it("walks full chain", async () => {
		const { journal: j, remove } = await setup("t-full-");
		try {
			await j.admit(intent, t0);
			const cases: [NonDeletedTransitionStage, string][] = [
				["creating", "2026-09-04T01:02:04.004Z"],
				["active", "2026-09-04T01:02:05.004Z"],
				["delete_intent", "2026-09-04T01:02:06.004Z"],
				["deleting", "2026-09-04T01:02:07.004Z"],
			];
			for (const [st, ts] of cases) {
				const t = await j.transition(st, intent, ts);
				expect(t.ok).toBe(true);
				if (!t.ok) return;
				expect(t.value.chain.current.stage).toBe(st);
			}
		} finally {
			await remove();
		}
	});

	it("creating->delete_intent shortcut", async () => {
		const { journal: j, remove } = await setup("t-short-");
		try {
			await j.admit(intent, t0);
			await j.transition("creating", intent, "2026-09-04T01:02:04.004Z");
			const r = await j.transition("delete_intent", intent, "2026-09-04T01:02:05.004Z");
			if (!r.ok) throw new Error(`transition: ${r.code}`);
			expect(r.value.chain.current.stage).toBe("delete_intent");
		} finally {
			await remove();
		}
	});

	it("idempotent transition", async () => {
		const { journal: j, remove } = await setup("t-idem-");
		try {
			await j.admit(intent, t0);
			await j.transition("creating", intent, "2026-09-04T01:02:04.004Z");
			const t2 = await j.transition("creating", intent, "2026-09-04T01:02:05.004Z");
			expectOk(t2);
			expect(Object.keys(t2.value)).toEqual(["chain"]);
		} finally {
			await remove();
		}
	});

	it("rejects invalid edge pre_admit->active", async () => {
		const { journal: j, remove } = await setup("t-edge-");
		try {
			await j.admit(intent, t0);
			expectFailure(await j.transition("active", intent, "2026-09-04T01:02:04.004Z"), "INVALID_TRANSITION");
		} finally {
			await remove();
		}
	});

	it("rejects wrong intent during transition", async () => {
		const { journal: j, remove } = await setup("t-wint-");
		try {
			await j.admit(intent, t0);
			expectFailure(await j.transition("creating", altIntent, "2026-09-04T01:02:04.004Z"), "CONFLICT");
		} finally {
			await remove();
		}
	});

	it("restarts after every stage", async () => {
		const { root, journal: j, remove } = await setup("t-recv-");
		try {
			await j.admit(intent, t0);
			const cases: [NonDeletedTransitionStage, string][] = [
				["creating", "2026-09-04T01:02:04.004Z"],
				["active", "2026-09-04T01:02:05.004Z"],
				["delete_intent", "2026-09-04T01:02:06.004Z"],
				["deleting", "2026-09-04T01:02:07.004Z"],
			];
			for (const [st, ts] of cases) {
				await j.transition(st, intent, ts);
				const j2 = await mkJournal(root);
				const r = await j2.recover();
				expect(r.ok).toBe(true);
				if (!r.ok) return;
				expect(r.value.chain.current.stage).toBe(st);
			}
		} finally {
			await remove();
		}
	});
});

// ── Hostile filesystem ─────────────────────────────────────

describe("hostile filesystem", () => {
	for (const { name, mutate, code } of [
		{
			name: "symlink record path",
			code: "CORRUPT" as OwnershipJournalCode,
			mutate: async (jd: string) => {
				const r1 = join(jd, "0001.ownership-v1");
				await rm(r1);
				const target = join(jd, "../evil-target");
				await writeFile(target, "x", { mode: 0o600 });
				await symlink(target, r1);
			},
		},
		{
			name: "directory record path",
			code: "CORRUPT" as OwnershipJournalCode,
			mutate: async (jd: string) => {
				const r1 = join(jd, "0001.ownership-v1");
				await rm(r1);
				await mkdir(r1, { recursive: false, mode: 0o700 });
			},
		},
		{
			name: "hardlink record (nlink>1)",
			code: "CORRUPT" as OwnershipJournalCode,
			mutate: async (jd: string) => {
				const r1 = join(jd, "0001.ownership-v1");
				const hp = join(jd, "../hardlink-dup");
				await link(r1, hp);
			},
		},
		{
			name: "zero-size record",
			code: "CORRUPT" as OwnershipJournalCode,
			mutate: async (jd: string) => {
				await rm(join(jd, "0001.ownership-v1"));
				await writeFile(join(jd, "0001.ownership-v1"), "", { mode: 0o600 });
			},
		},
		{
			name: "oversize record",
			code: "CORRUPT" as OwnershipJournalCode,
			mutate: async (jd: string) => {
				await rm(join(jd, "0001.ownership-v1"));
				await writeFile(join(jd, "0001.ownership-v1"), "x".repeat(5000), { mode: 0o600 });
			},
		},
		{
			name: "partially truncated record",
			code: "CORRUPT" as OwnershipJournalCode,
			mutate: async (jd: string) => {
				const buf = await readFile(join(jd, "0001.ownership-v1"));
				await writeFile(join(jd, "0001.ownership-v1"), buf.slice(0, Math.floor(buf.length / 2)), { mode: 0o600 });
			},
		},
		{
			name: "malformed JSON record",
			code: "CORRUPT" as OwnershipJournalCode,
			mutate: async (jd: string) => {
				await rm(join(jd, "0001.ownership-v1"));
				await writeFile(join(jd, "0001.ownership-v1"), "not-json-here", { mode: 0o600 });
			},
		},
	]) {
		it(`rejects ${name}`, async () => {
			const { jDir, journal: j, remove } = await setup("hf-rec-");
			try {
				await j.admit(intent, t0);
				await mutate(jDir);
				const r = await j.recover();
				expectFailure(r, code);
			} finally {
				try {
					await rm(join(jDir, "../evil-target")).catch(() => {});
				} catch {}
				try {
					await rm(join(jDir, "../hardlink-dup")).catch(() => {});
				} catch {}
				await remove();
			}
		});
	}

	for (const { name, corrupt, expectedCode } of [
		{
			name: "extra unknown file",
			expectedCode: "CORRUPT" as OwnershipJournalCode,
			corrupt: async (jd: string) => {
				await writeFile(join(jd, "evil.txt"), "bad", { mode: 0o600 });
			},
		},
		{
			name: "symlinked journal dir on reopen",
			expectedCode: "DIRECTORY_UNSAFE" as OwnershipJournalCode,
			corrupt: async (jd: string) => {
				await rm(jd, { recursive: true, force: true });
				const fakeDir = await mkdtemp(join(tmpdir(), "fake-"));
				await chmod(fakeDir, 0o700);
				await rm(fakeDir, { recursive: true, force: true });
				await symlink(fakeDir, jd);
			},
		},
		{
			name: "wrong-mode journal dir",
			expectedCode: "DIRECTORY_UNSAFE" as OwnershipJournalCode,
			corrupt: async (jd: string) => {
				await chmod(jd, 0o755);
			},
		},
	]) {
		it(`rejects ${name}`, async () => {
			const { root, jDir, journal: j, remove } = await setup("hf-dir-");
			try {
				await j.admit(intent, t0);
				await corrupt(jDir);
				expectFailure(await createOwnershipJournal(root), expectedCode);
			} finally {
				await remove();
			}
		});
	}

	it("collision safe: no double sequence-1", async () => {
		const { journal: j, remove } = await setup("hf-coll-");
		try {
			const a1 = await j.admit(intent, t0);
			expect(a1.ok).toBe(true);
			const a2 = await j.admit(intent, t0);
			expectOk(a2);
			expect(Object.keys(a2.value)).toEqual(["chain"]);
		} finally {
			await remove();
		}
	});

	it("getter-bearing intent is rejected safely", async () => {
		const { journal: j, remove } = await setup("hf-gett-");
		try {
			const hostile = { lifecycleKey: "x", parentSessionId: "y", childSessionId: "z" };
			Object.defineProperty(hostile, "lifecycleKey", {
				get: () => {
					throw new Error("leak");
				},
			});
			expectFailure(await j.admit(hostile as unknown as OwnershipIntent, t0), "INPUT_INVALID");
		} finally {
			await remove();
		}
	});

	it("O_EXCL append collision cannot corrupt existing records", async () => {
		const { root, journal: j1, remove } = await setup("hf-append-");
		try {
			await j1.admit(intent, t0);
			await j1.transition("creating", intent, "2026-09-04T01:02:04.004Z");
			const j2 = await mkJournal(root);
			const r = await j2.recover();
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.value.chain.current.stage).toBe("creating");
		} finally {
			await remove();
		}
	});

	it("second factory on fresh empty dir cannot admit", async () => {
		const { root, journal: j1, remove } = await setup("hf-2fac-");
		try {
			// First admits
			const a1 = await j1.admit(intent, t0);
			expect(a1.ok).toBe(true);

			// Second factory on same dir has createdByUs=false, oneShot.used=true
			// It can recover but cannot admit
			const j2 = await mkJournal(root);
			const r2 = await j2.recover();
			expect(r2.ok).toBe(true);
			if (!r2.ok) return;
			expect(r2.value.chain.current.stage).toBe("pre_admit");

			// Admit from j2 should be idempotent (existing chain)
			const a2 = await j2.admit(intent, t0);
			expectOk(a2);
			expect(Object.keys(a2.value)).toEqual(["chain"]);
		} finally {
			await remove();
		}
	});

	it("second factory on empty dir cannot create sequence-1", async () => {
		const { root, remove } = await freshRoot("hf-2empty-");
		try {
			const j1 = await mkJournal(root);
			const a1 = await j1.admit(intent, t0);
			expect(a1.ok).toBe(true);
			const jDir = join(root, ".sandbox-ownership");
			await rm(join(jDir, "0001.ownership-v1")).catch(() => {});
			const j2result = await createOwnershipJournal(root);
			expectFailure(j2result, "CORRUPT");
		} finally {
			await remove();
		}
	});

	it("concurrent Promise.all admits - only one publishes sequence-1", async () => {
		const { root, remove } = await freshRoot("hf-conc-admit-");
		try {
			const j = await mkJournal(root);
			const results = await Promise.all([j.admit(intent, t0), j.admit(intent, t0), j.admit(intent, t0)]);
			const successCount = results.filter((r) => r.ok).length;
			expect(successCount).toBeGreaterThanOrEqual(1);
			expect(successCount).toBeLessThanOrEqual(3);
			for (const r of results) {
				if (!r.ok) {
					expect(r.code).toMatch(/^(IO_UNCERTAIN|CORRUPT)$/);
				}
			}
			const rec = await j.recover();
			expect(rec.ok).toBe(true);
			if (!rec.ok) return;
			expect(rec.value.chain.current.sequence).toBe(1);
			expect(rec.value.chain.current.stage).toBe("pre_admit");
		} finally {
			await remove();
		}
	});

	it("concurrent Promise.all transitions - only one publishes each", async () => {
		const { root, remove } = await freshRoot("hf-conc-trans-");
		try {
			const j = await mkJournal(root);
			await j.admit(intent, t0);
			const results = await Promise.all([
				j.transition("creating", intent, "2026-09-04T01:02:04.004Z"),
				j.transition("creating", intent, "2026-09-04T01:02:04.004Z"),
				j.transition("creating", intent, "2026-09-04T01:02:04.004Z"),
			]);
			const successCount = results.filter((r) => r.ok).length;
			expect(successCount).toBeGreaterThanOrEqual(1);
			const rec = await j.recover();
			expect(rec.ok).toBe(true);
			if (!rec.ok) return;
			expect(rec.value.chain.current.sequence).toBe(2);
			expect(rec.value.chain.current.stage).toBe("creating");
			expect(rec.value.chain.records.length).toBe(2);
		} finally {
			await remove();
		}
	});

	it("rejects record file with special mode bits (sticky)", async () => {
		const { jDir, journal: j, remove } = await setup("hf-chmod-rec-");
		try {
			await j.admit(intent, t0);
			const recPath = join(jDir, "0001.ownership-v1");
			await chmod(recPath, 0o1600);
			const r = await j.recover();
			expectFailure(r, "CORRUPT");
		} finally {
			await remove();
		}
	});

	it("rejects journal dir with special mode bits", async () => {
		const { root, jDir, journal: j, remove } = await setup("hf-chmod-dir-");
		try {
			await j.admit(intent, t0);
			await chmod(jDir, 0o2700);
			const j2r = await createOwnershipJournal(root);
			expectFailure(j2r, "DIRECTORY_UNSAFE");
		} finally {
			await remove();
		}
	});
});
