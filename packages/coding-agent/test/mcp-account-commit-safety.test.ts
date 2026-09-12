// Offline safety regressions for ENG-6108 MCP account lifecycle.
// Exercise real store/auth locks, nonce ownership, full-identity credential CAS,
// compensation, explicit logout/remove, and guarded interactive login routes.
// Only dialogs/provider effects and deterministic atomic-write/barrier seams are fake.
// Durable cancelled attempts retain an inactive shell and release their nonce;
// failed initial writes must never produce a ghost record or nonce.
// All auth/record files are temporary. Fetch is denied; no browser or live OAuth.

import { randomUUID } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthCredential, AuthStorage } from "../src/core/auth-storage.js";
import {
	logoutMcpAccount,
	type McpConnectionRecord,
	McpConnectionStore,
	resolveMcpAccountLogoutTarget,
} from "../src/core/mcp/connection-store.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

// The store's atomic write is the coordinated seam for write-failure
// regressions: a hoisted counter injects a failure on the Nth durable write so
// any flush stage (reserve, finalize, later flush) can fail deterministically;
// every other write keeps the real disk path.
const writeControl = vi.hoisted(() => ({ writeCount: 0, failOnNthWrite: 0 }));
vi.mock("../src/utils/atomic-file.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/atomic-file.js")>();
	return {
		...actual,
		writeFileAtomicSync: ((path: string, data: string, options: unknown) => {
			writeControl.writeCount += 1;
			if (writeControl.failOnNthWrite === writeControl.writeCount) {
				throw new Error("injected durable-commit failure");
			}
			return actual.writeFileAtomicSync(path, data, options as never);
		}) as typeof actual.writeFileAtomicSync,
	};
});

function reservation(connectionId: string, attemptId: string, serviceId = "acme"): McpConnectionRecord {
	const now = Date.now();
	return {
		connectionId,
		serviceId,
		endpoint: "https://mcp.acme.test/mcp",
		label: `Acme (${connectionId})`,
		status: "pending",
		createdAt: now,
		updatedAt: now,
		attemptId,
	};
}

/** Fail fast when a store promise never settles (hang detection). */
async function mustSettle<T>(promise: Promise<T>, timeoutMs = 2000, label = "store promise"): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

describe("MCP account reservation commit safety (store level)", () => {
	let tempDir: string;
	let storePath: string;
	let store: McpConnectionStore;
	let realFetch: typeof globalThis.fetch;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-reserve-safety-"));
		storePath = join(tempDir, "mcp-connections.json");
		store = McpConnectionStore.open(storePath);
		writeControl.writeCount = 0;
		writeControl.failOnNthWrite = 0;
		realFetch = globalThis.fetch;
		globalThis.fetch = (() => {
			throw new Error("unexpected network fetch in offline mcp-account-commit-safety test");
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it.each(["reserve", "claim"] as const)(
		"a failed initial %s directory setup settles without queuing a ghost",
		async (kind) => {
			const dataDir = join(tempDir, "account-data");
			const savedDir = join(tempDir, "saved-account-data");
			const recordPath = join(dataDir, "mcp-connections.json");
			const isolated = McpConnectionStore.open(recordPath);
			const existing = { ...reservation("acme", randomUUID()), status: "connected" as const };
			delete existing.attemptId;
			isolated.upsert(existing);
			await isolated.flush();
			const before = McpConnectionStore.open(recordPath).get("acme");
			renameSync(dataDir, savedDir);
			writeFileSync(dataDir, "a file blocks directory preparation");
			const result = await mustSettle(
				kind === "reserve"
					? isolated.reserveConnectionId(reservation("acme-2", randomUUID()))
					: isolated.claimConnectionId({ connectionId: "acme", attemptId: randomUUID() }),
			);
			expect(result).toBe(false);
			rmSync(dataDir);
			renameSync(savedDir, dataDir);
			isolated.upsert(reservation("unrelated", randomUUID()));
			await isolated.flush();
			const truth = McpConnectionStore.open(recordPath);
			expect(truth.get("acme-2"), "denied reserve must not requeue after setup recovers").toBeUndefined();
			expect(truth.get("acme"), "denied claim must not stamp a nonce after setup recovers").toEqual(before);
		},
	);

	it("denies a reservation whose durable write fails, and never materializes it later (no ghost)", async () => {
		const wonFirst = await mustSettle(store.reserveConnectionId(reservation("acme", randomUUID())));
		expect(wonFirst).toBe(true);

		writeControl.failOnNthWrite = writeControl.writeCount + 1;
		const won = await mustSettle(store.reserveConnectionId(reservation("acme-2", randomUUID())));
		expect(won, "a failed durable commit must deny the caller before it starts a login").toBe(false);

		// Any later successful flush (here: an unrelated upsert) must not retry
		// the denied reservation into a ghost pending record.
		store.upsert(reservation("unrelated", randomUUID(), "other"));
		await store.flush();
		const fresh = McpConnectionStore.open(storePath);
		expect(fresh.get("acme-2"), "a denied reservation must never appear in the persisted records").toBeUndefined();
		expect(store.get("acme-2"), "a denied reservation must never appear in memory either").toBeUndefined();
		expect(fresh.get("unrelated")).toBeDefined();
	});

	it("every batched reserve settles when their shared flush write fails (no hung promise, no ghost)", async () => {
		// Two reserves queued before the first flush splices: both land in ONE
		// batch whose single durable write is injected to fail.
		writeControl.failOnNthWrite = 1;
		const first = store.reserveConnectionId(reservation("acme-2", randomUUID()));
		const second = store.reserveConnectionId(reservation("acme-3", randomUUID()));
		const [firstWon, secondWon] = await Promise.all([
			mustSettle(first, 2000, "first batched reserve"),
			mustSettle(second, 2000, "second batched reserve"),
		]);
		expect(firstWon, "a failed shared commit must deny the first reserve").toBe(false);
		expect(secondWon, "a failed shared commit must deny every reserve in the batch — none may hang").toBe(false);

		// A later flush must not materialize either denied reservation.
		store.upsert(reservation("unrelated", randomUUID(), "other"));
		await store.flush();
		const fresh = McpConnectionStore.open(storePath);
		expect(fresh.get("acme-2")).toBeUndefined();
		expect(fresh.get("acme-3")).toBeUndefined();
		expect(fresh.get("unrelated")).toBeDefined();
	});

	it("batched claims settle when their shared flush write fails (no hung promise, no ghost nonce)", async () => {
		// An EXISTING record (any status) can be claimed for a guarded
		// reconnect. Claims are one-shot ops: a failed shared write must
		// settle EVERY claim false — never hang, never requeue — and no
		// ghost nonce may survive on a later flush.
		const now = Date.now();
		store.upsert({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme (acme-2)",
			status: "connected",
			createdAt: now,
			updatedAt: now,
		});
		await store.flush();
		writeControl.failOnNthWrite = writeControl.writeCount + 1;
		const first = store.claimConnectionId({ connectionId: "acme-2", attemptId: randomUUID() });
		const second = store.claimConnectionId({ connectionId: "acme-2", attemptId: randomUUID() });
		const [firstClaimed, secondClaimed] = await Promise.all([
			mustSettle(first, 2000, "first batched claim"),
			mustSettle(second, 2000, "second batched claim"),
		]);
		expect(firstClaimed, "a failed shared commit must deny every claim in the batch — none may hang").toBe(false);
		expect(secondClaimed).toBe(false);

		// A later flush must not materialize either denied claim's nonce.
		store.upsert(reservation("unrelated", randomUUID(), "other"));
		await store.flush();
		const fresh = McpConnectionStore.open(storePath);
		expect(fresh.get("acme-2")?.attemptId, "a denied claim must never stamp a ghost nonce").toBeUndefined();
		expect(fresh.get("acme-2")?.status, "the claimed record itself must survive untouched").toBe("connected");
	});

	it("a CAS replace refuses when the expected old credential was deleted (absence is a change)", async () => {
		// Full-identity CAS: the captured expected-old must match the CURRENT
		// on-disk value INCLUDING absence. A nonempty expectedOld with an
		// ABSENT real slot is a CHANGED value — the replace must refuse, not
		// treat the emptied slot as free.
		const authPath = join(tempDir, "auth.json");
		const clientA = AuthStorage.create(authPath);
		const expectedOld: AuthCredential = {
			type: "oauth",
			access: "previous-credential",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		clientA.set("mcp:acme-2", expectedOld);
		const captured = clientA.getVerified("mcp:acme-2");
		expect(captured).toBeDefined();
		// Another client deletes the real credential while our attempt is in flight.
		AuthStorage.create(authPath).removeVerified("mcp:acme-2");
		const stagedKey = `mcp:acme-2--${randomUUID()}`;
		clientA.set(stagedKey, {
			type: "oauth",
			access: "our-credential",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		const move = clientA.replaceStagedCredential(stagedKey, "mcp:acme-2", captured);
		expect(move.status, "a deleted expected-old value must refuse the replace — absence is a change").not.toBe(
			"replaced",
		);
		const truth = AuthStorage.create(authPath);
		expect(truth.get("mcp:acme-2"), "nothing may land on the changed slot").toBeUndefined();
		expect(truth.get(stagedKey), "our staged credential must stay staged").toBeDefined();
	});

	it("removeReservation is owned by the attempt nonce, not by the id alone", async () => {
		const nonce = randomUUID();
		expect(await store.reserveConnectionId(reservation("acme-2", nonce))).toBe(true);
		// A wrong (stale or foreign) nonce must not remove the pending account.
		expect(await store.removeReservation("acme-2", `${nonce}-wrong`)).toBe(false);
		expect(store.get("acme-2"), "a foreign nonce must leave the reservation untouched").toBeDefined();
		// The owning nonce removes exactly its own reservation.
		expect(await store.removeReservation("acme-2", nonce)).toBe(true);
		expect(store.get("acme-2")).toBeUndefined();
		const fresh = McpConnectionStore.open(storePath);
		expect(fresh.get("acme-2")).toBeUndefined();
	});

	it("finalizeAttempt runs the credential commit only for the owning attempt", async () => {
		const nonce = randomUUID();
		expect(await store.reserveConnectionId(reservation("acme-2", nonce))).toBe(true);

		let commitRan = false;
		expect(
			await store.finalizeAttempt({
				connectionId: "acme-2",
				attemptId: `${nonce}-wrong`,
				commit: (record) => {
					commitRan = true;
					return record;
				},
			}),
			"a foreign nonce must lose the guarded commit",
		).toBe("denied");
		expect(commitRan, "a foreign nonce must never run the commit callback").toBe(false);
		expect(store.get("acme-2")?.status, "the reservation must still be pending").toBe("pending");

		let ownedCommitRan = false;
		expect(
			await store.finalizeAttempt({
				connectionId: "acme-2",
				attemptId: nonce,
				commit: (record) => {
					ownedCommitRan = true;
					return { ...record, status: "connected", toolCount: 3 };
				},
			}),
		).toBe("committed");
		expect(ownedCommitRan).toBe(true);
		expect(store.get("acme-2")).toMatchObject({ status: "connected", toolCount: 3 });

		// After removal, even the owning nonce cannot resurrect the account.
		await store.remove("acme-2");
		await store.flush();
		let lateCommitRan = false;
		expect(
			await store.finalizeAttempt({
				connectionId: "acme-2",
				attemptId: nonce,
				commit: (record) => {
					lateCommitRan = true;
					return record;
				},
			}),
			"finalize after the account is gone must be denied",
		).toBe("denied");
		expect(lateCommitRan).toBe(false);
	});

	it("a finalize whose durable write fails is compensated: account key untouched, staged restored", async () => {
		const nonce = randomUUID();
		expect(await store.reserveConnectionId(reservation("acme-2", nonce))).toBe(true);
		const stagedKey = `mcp:acme-2--${nonce}`;
		const realKey = "mcp:acme-2";
		const authStorage = AuthStorage.inMemory();
		const stagedCredential = {
			type: "oauth" as const,
			access: "staged-credential",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		authStorage.set(stagedKey, stagedCredential);

		// Fail the finalize's own durable write (the reserve already committed).
		writeControl.failOnNthWrite = writeControl.writeCount + 1;
		const committed = await mustSettle(
			store.finalizeAttempt({
				connectionId: "acme-2",
				attemptId: nonce,
				// The REAL interactive commit/compensate pairing: the commit
				// moves the staged credential to the account key under the store
				// lock; the compensate rolls that move back under the same lock
				// when the record write fails.
				commit: (record) => {
					const staged = authStorage.get(stagedKey);
					if (staged) {
						authStorage.set(realKey, staged);
						authStorage.remove(stagedKey);
					}
					return { ...record, status: "connected" };
				},
				compensate: () => {
					const moved = authStorage.get(realKey);
					if (moved) {
						authStorage.set(stagedKey, moved);
						authStorage.remove(realKey);
					}
				},
			}),
		);

		expect(committed, "a failed durable write must report a compensated finalize").toBe("compensated");
		expect(
			authStorage.get(realKey),
			"a not-committed finalize must not leave the moved credential on the account key",
		).toBeUndefined();
		expect(
			authStorage.get(stagedKey),
			"the compensation must restore the staged credential for the caller to discard or retry",
		).toEqual(stagedCredential);
		// The persisted record must not claim connected either.
		expect(McpConnectionStore.open(storePath).get("acme-2")?.status ?? "pending").not.toBe("connected");
	});

	it("an account Remove interleaved with a finalize under the store lock leaves no final credential", async () => {
		const nonce = randomUUID();
		expect(await store.reserveConnectionId(reservation("acme-2", nonce))).toBe(true);
		const authStorage = AuthStorage.inMemory();
		const stagedKey = `mcp:acme-2--${nonce}`;
		authStorage.set(stagedKey, {
			type: "oauth",
			access: "staged-credential",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});

		// A minimal fake-this driving the REAL interactive Remove action
		// (store-locked removeAccount: record + credential logout in one
		// locked section) — what the account picker runs when another client
		// removes a pending account mid-login.
		const fake = {
			mcpConnectionStore: store,
			modelRegistry: { authStorage },
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			isAgentStreaming: () => false,
			isAgentCompacting: () => false,
			handleReloadCommand: vi.fn(async () => true),
			settingsManager: { getGlobalMcpServers: () => undefined },
			uiServices: { settingsManager: { getGlobalMcpServers: () => undefined } },
		} as unknown as Record<string, unknown>;
		Object.setPrototypeOf(fake, InteractiveMode.prototype);
		const runRealRemove = (): Promise<void> =>
			(
				fake as unknown as {
					connectServiceFromPicker: (this: unknown, ...args: unknown[]) => Promise<void>;
				}
			).connectServiceFromPicker.call(fake, {
				serviceId: "acme-2",
				label: "Acme (acme-2)",
				connectionStatus: "pending",
				connectionIds: ["acme-2"],
				removeAction: true,
			});

		// The finalize holds the store lock; mid-commit, the Remove's logout
		// runs (auth-only) while its record removal queues behind the lock —
		// the documented interleaving.
		const committed = await mustSettle(
			store.finalizeAttempt({
				connectionId: "acme-2",
				attemptId: nonce,
				commit: (record) => {
					// Fire the REAL Remove action mid-callback (its locked
					// removeAccount op queues behind this flush) — deliberately
					// not awaited: the commit callback runs under the lock.
					void runRealRemove();
					const staged = authStorage.get(stagedKey);
					if (staged) {
						authStorage.set("mcp:acme-2", staged);
						authStorage.remove(stagedKey);
					}
					return { ...record, status: "connected" };
				},
			}),
		);
		expect(committed).toBe("committed");
		// Let the interleaved Remove finish its queued record removal.
		await new Promise((resolve) => setTimeout(resolve, 50));
		await store.flush();

		expect(
			authStorage.get("mcp:acme-2"),
			"a Remove must win over a concurrent finalize: no final credential may survive it",
		).toBeUndefined();
		expect(store.get("acme-2"), "the record removal stands").toBeUndefined();
	});

	it("a commit callback that throws mid-move is compensated: no stranded credential", async () => {
		const nonce = randomUUID();
		expect(await store.reserveConnectionId(reservation("acme-2", nonce))).toBe(true);
		const stagedKey = `mcp:acme-2--${nonce}`;
		const realKey = "mcp:acme-2";
		const authStorage = AuthStorage.inMemory();
		authStorage.set(stagedKey, {
			type: "oauth",
			access: "staged-credential",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});

		// The commit moves the staged credential, then throws BEFORE returning
		// the record: a partial caller-side move. The compensation must cover
		// this too, regardless of registration order.
		const committed = await mustSettle(
			store.finalizeAttempt({
				connectionId: "acme-2",
				attemptId: nonce,
				commit: () => {
					const staged = authStorage.get(stagedKey);
					if (staged) {
						authStorage.set(realKey, staged);
						authStorage.remove(stagedKey);
					}
					throw new Error("injected partial commit failure");
				},
				compensate: () => {
					const moved = authStorage.get(realKey);
					if (moved) {
						authStorage.set(stagedKey, moved);
						authStorage.remove(realKey);
					}
				},
			}),
		);

		expect(committed, "a thrown commit must report a compensated finalize").toBe("compensated");
		expect(
			authStorage.get(realKey),
			"a commit that threw mid-move must not strand the moved credential on the account key",
		).toBeUndefined();
		expect(authStorage.get(stagedKey)).toBeDefined();
	});

	it("a FAILED compensation must surface recovery, not silently claim the account unchanged", async () => {
		const nonce = randomUUID();
		expect(await store.reserveConnectionId(reservation("acme-2", nonce))).toBe(true);
		const stagedKey = `mcp:acme-2--${nonce}`;
		const realKey = "mcp:acme-2";
		const authStorage = AuthStorage.inMemory();
		authStorage.set(stagedKey, {
			type: "oauth",
			access: "staged-credential",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});

		// Fail the finalize's durable write; the compensation itself then fails
		// after a PARTIAL rollback (staged restored, real key not cleared).
		writeControl.failOnNthWrite = writeControl.writeCount + 1;
		const outcome = await mustSettle(
			store.finalizeAttempt({
				connectionId: "acme-2",
				attemptId: nonce,
				commit: (record) => {
					const staged = authStorage.get(stagedKey);
					if (staged) {
						authStorage.set(realKey, staged);
						authStorage.remove(stagedKey);
					}
					return { ...record, status: "connected" };
				},
				compensate: () => {
					const moved = authStorage.get(realKey);
					if (moved) authStorage.set(stagedKey, moved);
					throw new Error("injected compensation failure");
				},
			}),
		);

		// A failed rollback must surface recovery explicitly — never a plain
		// "not committed" implying the account is unchanged — and the moved
		// credential must be retained somewhere so it can be recovered.
		expect(outcome).toBe("recovery-required");
		expect(authStorage.get(realKey) ?? authStorage.get(stagedKey), "recovery data must be retained").toBeDefined();
	});

	it("the conditional move compares persisted credentials inside the AUTH backend lock (store->auth gap interleave)", async () => {
		// Two REAL file-backed storage instances share one credential file.
		const authPath = join(tempDir, "auth.json");
		const clientA = AuthStorage.create(authPath);
		const otherClient = AuthStorage.create(authPath);
		const nonce = randomUUID();
		expect(await store.reserveConnectionId(reservation("acme-2", nonce))).toBe(true);
		const stagedKey = `mcp:acme-2--${nonce}`;
		const realKey = "mcp:acme-2";
		const stagedCredential: AuthCredential = {
			type: "oauth",
			access: "staged-credential",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		clientA.set(stagedKey, stagedCredential);
		const bystander = {
			type: "oauth" as const,
			access: "other-client-ordinary-login",
			refresh: "other-client-refresh",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};

		// The REAL interactive commit/compensate pairing, with an ordinary login
		// from ANOTHER client landing in the gap between the store lock and the
		// auth backend lock (ordinary logins never hold the store lock).
		let movedCredential: AuthCredential | undefined;
		const finalization = await mustSettle(
			store.finalizeAttempt({
				connectionId: "acme-2",
				attemptId: nonce,
				commit: (record) => {
					otherClient.set(realKey, { ...bystander });
					const move = clientA.moveStagedCredential(stagedKey, realKey);
					if (move.status === "occupied") {
						throw new Error("account key occupied by another login");
					}
					if (move.status === "moved") {
						movedCredential = move.credential;
					}
					return record;
				},
				compensate: () => {
					if (!movedCredential) return;
					clientA.restoreCredentialIfAbsent(stagedKey, movedCredential);
					clientA.removeIfCredentialMatches(realKey, movedCredential);
				},
			}),
		);

		// The bystander landed on disk BEFORE the conditional move's critical
		// section: the move must refuse inside the AUTH backend lock, not act
		// on a stale read taken under only the store lock.
		expect(finalization).toBe("compensated");
		const truth = AuthStorage.create(authPath);
		const surviving = truth.get(realKey);
		expect(surviving).toBeDefined();
		expect(JSON.stringify(surviving), "the interposed ordinary-login credential must survive byte-for-byte").toBe(
			JSON.stringify(bystander),
		);
		expect(JSON.stringify(truth.get(stagedKey)), "our own staged credential must be intact after the refusal").toBe(
			JSON.stringify(stagedCredential),
		);
	});

	it("a generic logout racing a finalize under the store lock leaves no orphan credential", async () => {
		// The REAL generic-logout route order today: the auth mutation runs
		// FIRST with no store lock, then the attempt-cancel queues on the
		// store. A finalize holding the store lock therefore moves its staged
		// credential into the key the logout just emptied, and the late cancel
		// deletes the record ONLY — an orphan credential survives the logout.
		const authPath = join(tempDir, "auth.json");
		const clientA = AuthStorage.create(authPath);
		const nonce = randomUUID();
		expect(await store.reserveConnectionId(reservation("acme-2", nonce))).toBe(true);
		const stagedKey = `mcp:acme-2--${nonce}`;
		const realKey = "mcp:acme-2";
		const stagedCredential: AuthCredential = {
			type: "oauth",
			access: "staged-credential",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		clientA.set(stagedKey, stagedCredential);
		const bystander = {
			type: "oauth" as const,
			access: "other-client-ordinary-login",
			refresh: "other-client-refresh",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		clientA.set(realKey, bystander);

		let movedCredential: AuthCredential | undefined;
		const routeLogouts: Array<Promise<unknown>> = [];
		const finalization = await mustSettle(
			store.finalizeAttempt({
				connectionId: "acme-2",
				attemptId: nonce,
				commit: (record) => {
					// The REAL one-op generic-logout handler fires while THIS
					// finalize holds the store lock: it queues its
					// store-locked op behind our flush and mutates no auth
					// until that op runs.
					routeLogouts.push(logoutMcpAccount("mcp:acme-2", store, clientA));
					const move = clientA.moveStagedCredential(stagedKey, realKey);
					if (move.status === "occupied") {
						throw new Error("account key occupied by another login");
					}
					if (move.status === "moved") {
						movedCredential = move.credential;
					}
					return record;
				},
				compensate: () => {
					if (!movedCredential) return;
					clientA.restoreCredentialIfAbsent(stagedKey, movedCredential);
					clientA.removeIfCredentialMatches(realKey, movedCredential);
				},
			}),
		);
		// Let the queued route op run after our flush.
		for (const routeLogout of routeLogouts) await routeLogout;

		expect(finalization).not.toBe("committed");
		const truth = AuthStorage.create(authPath);
		expect(truth.get(realKey), "the logout must win the race: no orphan credential may survive it").toBeUndefined();
		const record = store.get("acme-2");
		expect(record?.status ?? "gone", "no record may claim the account connected").not.toBe("connected");
	});

	it("a staged-key logout queued behind a finalize-first move leaves no orphan (stale second store)", async () => {
		// The generic /logout route on a SECOND client resolves the staged-key
		// target from its own CACHED records OUTSIDE the store lock, then
		// queues the one-op removal. If OUR finalize owns the lock and moves
		// the staged credential to the REAL key first, the queued op can then
		// remove ONLY the already-consumed staged key while deleting the
		// record — a REAL credential with no record. Invariant: a surviving
		// credential must have a surviving record.
		const authPath = join(tempDir, "auth.json");
		const clientA = AuthStorage.create(authPath);
		const otherClient = AuthStorage.create(authPath);
		const storeB = McpConnectionStore.open(storePath);
		const nonce = randomUUID();
		expect(await store.reserveConnectionId(reservation("acme-2", nonce))).toBe(true);
		const stagedKey = `mcp:acme-2--${nonce}`;
		const realKey = "mcp:acme-2";
		const stagedCredential: AuthCredential = {
			type: "oauth",
			access: "staged-credential",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		clientA.set(stagedKey, stagedCredential);
		// Warm the second client's cached records so its route resolution
		// sees the pending attempt (the stale cache a real second client
		// holds between its own flushes).
		await storeB.flush();

		let movedCredential: AuthCredential | undefined;
		const routeLogouts: Array<Promise<unknown>> = [];
		const finalization = await mustSettle(
			store.finalizeAttempt({
				connectionId: "acme-2",
				attemptId: nonce,
				commit: (record) => {
					// The other client's generic /logout of the STAGED
					// provider, fired while OUR finalize holds the store file
					// lock: the REAL exported handler resolves from the stale
					// second store's cache, then its op queues behind us.
					routeLogouts.push(logoutMcpAccount(stagedKey, storeB, otherClient));
					const move = clientA.moveStagedCredential(stagedKey, realKey);
					if (move.status === "occupied") {
						throw new Error("account key occupied by another login");
					}
					if (move.status === "moved") {
						movedCredential = move.credential;
					}
					return record;
				},
				compensate: () => {
					if (!movedCredential) return;
					clientA.restoreCredentialIfAbsent(stagedKey, movedCredential);
					clientA.removeIfCredentialMatches(realKey, movedCredential);
				},
			}),
		);
		const routeOutcomes: Array<unknown> = [];
		for (const routeLogout of routeLogouts) routeOutcomes.push(await routeLogout);

		// The finalize won the lock first: the move + record write committed.
		expect(finalization).toBe("committed");
		const truth = AuthStorage.create(authPath);
		const survivingCredential = truth.get(realKey);
		const survivingRecord = McpConnectionStore.open(storePath).get("acme-2");
		expect(
			survivingCredential === undefined || survivingRecord !== undefined,
			"no orphan: a staged-key logout queued behind a finalize-first move must not delete the record while the moved credential lives on the real key",
		).toBe(true);
		if (survivingCredential !== undefined) {
			// Fail-closed refusal with the account intact is acceptable — but
			// a stale staged logout that leaves the account CONNECTED must not
			// claim removal to the user.
			expect(
				JSON.stringify(routeOutcomes),
				"a refused stale staged logout must not claim removal while the account remains connected",
			).not.toContain('"removed"');
		}
	});

	it("a staged-key logout with BOTH credentials present preserves the account shell and invalidates the attempt", async () => {
		// An ordinary login populated the REAL key while our staged credential
		// still exists. The user logs out the STAGED provider — aborting OUR
		// attempt. The contract: our staged credential is removed and our
		// attempt's ownership is invalidated, but the RECORD (the account
		// shell the other login's credential occupies) is PRESERVED — record
		// deletion is the explicit Remove action's job, never conditioned on
		// an unlocked auth existence snapshot. A later finalize with the old
		// nonce must be denied and must not remove the preserved record.
		const authPath = join(tempDir, "auth.json");
		const clientA = AuthStorage.create(authPath);
		const otherClient = AuthStorage.create(authPath);
		const nonce = randomUUID();
		expect(await store.reserveConnectionId(reservation("acme-2", nonce))).toBe(true);
		const stagedKey = `mcp:acme-2--${nonce}`;
		const realKey = "mcp:acme-2";
		const ourStaged: AuthCredential = {
			type: "oauth",
			access: "our-staged-credential",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		clientA.set(stagedKey, ourStaged);
		const bystander = {
			type: "oauth" as const,
			access: "other-client-ordinary-login",
			refresh: "other-client-refresh",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		otherClient.set(realKey, bystander);

		// The staged-key logout through the REAL exported handler.
		await logoutMcpAccount(stagedKey, store, clientA);

		const truth = AuthStorage.create(authPath);
		expect(truth.get(stagedKey), "our staged credential must be removed").toBeUndefined();
		expect(
			JSON.stringify(truth.get(realKey)),
			"the other login's credential must survive byte-for-byte — it was not the logout target",
		).toBe(JSON.stringify(bystander));
		// The account shell must be PRESERVED: a generic staged logout cancels
		// the attempt, it does not delete the record — full deletion is the
		// explicit Remove action.
		expect(
			store.get("acme-2"),
			"the staged logout must preserve the account shell — record deletion is the explicit Remove action's job",
		).toBeDefined();

		// The old nonce is invalidated: a later finalize is denied...
		const finalization = await mustSettle(
			store.finalizeAttempt({
				connectionId: "acme-2",
				attemptId: nonce,
				commit: (record) => {
					clientA.set(realKey, ourStaged);
					return record;
				},
			}),
		);
		expect(finalization, "the old attempt nonce must be invalidated").toBe("denied");
		// ...and the denied cleanup must not remove the preserved record or
		// touch the other login's credential.
		expect(
			store.get("acme-2"),
			"a denied late finalize must not remove the preserved bystander record",
		).toBeDefined();
		expect(
			JSON.stringify(AuthStorage.create(authPath).get(realKey)),
			"the denied finalize must never touch the other login's credential",
		).toBe(JSON.stringify(bystander));
	});
});

describe("MCP account guarded OAuth commit (interactive add-account seam)", () => {
	let tempDir: string;
	let store: McpConnectionStore;
	let authStorage: AuthStorage;
	let realFetch: typeof globalThis.fetch;

	type FakeThis = Record<string, unknown>;

	function buildFake(
		runMcpLogin: (serverId: string) => Promise<{ status: string }>,
		settingsServers?: Record<string, { type: "http"; url: string }>,
	): FakeThis {
		const fake = {
			mcpConnectionStore: store,
			modelRegistry: { authStorage },
			createAuthFlows: () => ({ runMcpLogin }),
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
			isAgentStreaming: () => false,
			isAgentCompacting: () => false,
			handleReloadCommand: vi.fn(async () => true),
			settingsManager: {
				getGlobalMcpServers: () => settingsServers,
				getMcpCatalogSources: () => [],
			},
			uiServices: { settingsManager: { getGlobalMcpServers: () => settingsServers } },
		} as unknown as FakeThis;
		Object.setPrototypeOf(fake, InteractiveMode.prototype);
		return fake;
	}

	function callInitialConnect(fake: FakeThis, serviceId = "acme"): Promise<void> {
		const label = serviceId === "acme" ? "Acme" : `Service ${serviceId}`;
		return (
			fake as unknown as {
				connectServiceFromPicker: (this: unknown, ...args: unknown[]) => Promise<void>;
			}
		).connectServiceFromPicker.call(
			fake,
			{
				serviceId,
				label,
				connectionStatus: "not_connected",
				connectionIds: [],
				connectable: true,
			},
			{ url: "https://mcp.acme.test/mcp", usesOAuth: true, managedBySettings: false },
			{ knownIds: new Set([serviceId]) },
		);
	}

	function callMcpLoginCommand(fake: FakeThis, name: string): Promise<void> {
		return (
			fake as unknown as {
				handleMcpCommand: (this: unknown, args: string | undefined) => Promise<void>;
			}
		).handleMcpCommand.call(fake, `login ${name}`);
	}

	function callRemove(fake: FakeThis, connectionId: string): Promise<void> {
		return (
			fake as unknown as {
				connectServiceFromPicker: (this: unknown, ...args: unknown[]) => Promise<void>;
			}
		).connectServiceFromPicker.call(fake, {
			serviceId: connectionId,
			label: `Acme (${connectionId})`,
			connectionStatus: "connected",
			connectionIds: [connectionId],
			removeAction: true,
		});
	}

	function callAddAccount(
		fake: FakeThis,
		serviceId = "acme",
		endpointUrl = "https://mcp.acme.test/mcp",
	): Promise<void> {
		const label = serviceId === "acme" ? "Acme" : `Service ${serviceId}`;
		return (
			fake as unknown as {
				connectServiceFromPicker: (this: unknown, ...args: unknown[]) => Promise<void>;
			}
		).connectServiceFromPicker.call(
			fake,
			{
				serviceId,
				label,
				connectionStatus: "not_connected",
				connectionIds: [],
				connectable: true,
			},
			{ url: endpointUrl, usesOAuth: true, managedBySettings: false },
			{ catalogServiceId: serviceId, addAccount: true, knownIds: new Set([serviceId]) },
		);
	}

	/** A login dialog stand-in that writes the STAGED credential, like the real provider login does. */
	function stagedLogin(midFlight?: (stagedServerId: string) => Promise<void>) {
		return async (serverId: string): Promise<{ status: string }> => {
			if (!serverId.includes("--")) throw new Error(`login must target the staged id, got ${serverId}`);
			await midFlight?.(serverId);
			authStorage.set(`mcp:${serverId}`, {
				type: "oauth",
				access: `staged-for-${serverId}`,
				refresh: "r",
				expires: Date.now() + 3600_000,
				endpoint: "https://mcp.acme.test/mcp",
			});
			return { status: "success" };
		};
	}

	function stagedLeftovers(): string[] {
		return authStorage.list().filter((id) => id.startsWith("mcp:acme-2--"));
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-guarded-commit-"));
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		authStorage = AuthStorage.inMemory();
		writeControl.writeCount = 0;
		writeControl.failOnNthWrite = 0;
		resetOAuthProviders();
		realFetch = globalThis.fetch;
		globalThis.fetch = (() => {
			throw new Error("unexpected network fetch in offline mcp-account-commit-safety test");
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("an OAuth SUCCESS arriving after the reservation was removed leaves no credential and no record", async () => {
		const fake = buildFake(
			stagedLogin(async (stagedServerId) => {
				const nonce = stagedServerId.split("--")[1] ?? "";
				// Another client removes OUR pending reservation mid-login (the
				// account-picker Remove semantics: logout + record removal).
				authStorage.logout("mcp:acme-2");
				store.remove("acme-2");
				await store.flush();
				expect(nonce).not.toBe("");
			}),
		);
		await callAddAccount(fake);

		expect(authStorage.get("mcp:acme-2"), "the late credential must never land on the account key").toBeUndefined();
		expect(store.get("acme-2"), "no record may be resurrected").toBeUndefined();
		expect(McpConnectionStore.open(join(tempDir, "mcp-connections.json")).get("acme-2")).toBeUndefined();
		expect(stagedLeftovers(), "the staged credential must be discarded").toEqual([]);
		const messages = JSON.stringify((fake.showStatus as ReturnType<typeof vi.fn>).mock.calls);
		expect(messages).toContain("login result was discarded");
	});

	it("an OAuth SUCCESS after a same-id new owner preserves the new owner byte-for-byte", async () => {
		const fake = buildFake(
			stagedLogin(async (stagedServerId) => {
				const staleNonce = stagedServerId.split("--")[1] ?? "";
				// Our attempt is cancelled from elsewhere, then a second client
				// wins the SAME id with its own nonce and completes its own
				// guarded finalize before our late login resolves.
				expect(await store.removeReservation("acme-2", staleNonce)).toBe(true);
				const ownerNonce = randomUUID();
				expect(await store.reserveConnectionId(reservation("acme-2", ownerNonce))).toBe(true);
				authStorage.set(`mcp:acme-2--${ownerNonce}`, {
					type: "oauth",
					access: "second-owner-credential",
					refresh: "second-owner-refresh",
					expires: Date.now() + 3600_000,
					endpoint: "https://mcp.acme.test/mcp",
				});
				const committed = await store.finalizeAttempt({
					connectionId: "acme-2",
					attemptId: ownerNonce,
					commit: (record) => {
						const staged = authStorage.get(`mcp:acme-2--${ownerNonce}`);
						if (staged) {
							authStorage.set("mcp:acme-2", staged);
							authStorage.remove(`mcp:acme-2--${ownerNonce}`);
						}
						return record;
					},
				});
				expect(committed).toBe("committed");
			}),
		);
		await callAddAccount(fake);

		const ownerCredential = authStorage.get("mcp:acme-2");
		expect(ownerCredential).toMatchObject({
			type: "oauth",
			access: "second-owner-credential",
			refresh: "second-owner-refresh",
			endpoint: "https://mcp.acme.test/mcp",
		});
		expect(JSON.stringify(ownerCredential), "the new owner's credential must be preserved byte-for-byte").toBe(
			JSON.stringify({
				type: "oauth",
				access: "second-owner-credential",
				refresh: "second-owner-refresh",
				expires: (ownerCredential as { expires: number }).expires,
				endpoint: "https://mcp.acme.test/mcp",
			}),
		);
		const ownerRecord = store.get("acme-2");
		expect(ownerRecord).toMatchObject({
			connectionId: "acme-2",
			serviceId: "acme",
			status: "pending",
			endpoint: "https://mcp.acme.test/mcp",
		});
		expect(stagedLeftovers(), "the stale attempt's staged credential must be discarded").toEqual([]);
		const messages = JSON.stringify((fake.showStatus as ReturnType<typeof vi.fn>).mock.calls);
		expect(messages).toContain("login result was discarded");
	});

	it("removing a credential-only account (no record) still logs the credential out", async () => {
		// A legacy or ordinary-login credential exists WITHOUT a store record:
		// the Remove action must still delete the credential, not skip the auth
		// cleanup just because the record is missing.
		authStorage.set("mcp:acme-2", {
			type: "oauth",
			access: "credential-only-legacy",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		const fake = buildFake(async () => {
			throw new Error("no login may run during a Remove");
		});
		await callRemove(fake, "acme-2");

		expect(
			authStorage.get("mcp:acme-2"),
			"a Remove of a credential-only account must log the credential out — no leaked token",
		).toBeUndefined();
	});

	it("a finalize never overwrites or compensate-deletes a credential written by an ordinary login", async () => {
		const ordinaryCredential = {
			type: "oauth" as const,
			access: "ordinary-login-credential",
			refresh: "ordinary-refresh",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		const fake = buildFake(
			stagedLogin(async () => {
				// Another client's ORDINARY login writes the final key directly
				// while OUR reservation (nonce unchanged) is still pending.
				authStorage.set("mcp:acme-2", { ...ordinaryCredential });
			}),
		);
		await callAddAccount(fake);

		const bystander = authStorage.get("mcp:acme-2");
		expect(bystander).toBeDefined();
		expect(JSON.stringify(bystander), "the ordinary-login credential must survive finalization byte-for-byte").toBe(
			JSON.stringify(ordinaryCredential),
		);
		expect(stagedLeftovers(), "our staged credential must be cleaned up, not clobber the final key").toEqual([]);
	});

	it("a bystander written by ANOTHER client's ordinary login survives finalization (two real storage instances)", async () => {
		// Two REAL file-backed AuthStorage instances share one credential file,
		// like two clients: the UI runs on instance A; another client's
		// ordinary login writes the final key through instance B after our
		// staging but before our finalize. The occupancy check must see it
		// (no cached get) and the move must be conditional — never an
		// unconditional overwrite.
		const authPath = join(tempDir, "auth.json");
		authStorage = AuthStorage.create(authPath);
		const otherClient = AuthStorage.create(authPath);
		const bystander = {
			type: "oauth" as const,
			access: "other-client-ordinary-login",
			refresh: "other-client-refresh",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		const fake = buildFake(async (serverId: string) => {
			if (!serverId.includes("--")) throw new Error(`login must target the staged id, got ${serverId}`);
			// Our dialog stages the credential first...
			authStorage.set(`mcp:${serverId}`, {
				type: "oauth",
				access: `staged-for-${serverId}`,
				refresh: "r",
				expires: Date.now() + 3600_000,
				endpoint: "https://mcp.acme.test/mcp",
			});
			// ...then the OTHER client's ordinary login writes the final key.
			otherClient.set("mcp:acme-2", { ...bystander });
			return { status: "success" };
		});
		await callAddAccount(fake);

		// The file is the truth: read it through a FRESH instance.
		const truth = AuthStorage.create(authPath);
		const surviving = truth.get("mcp:acme-2");
		expect(surviving).toBeDefined();
		expect(JSON.stringify(surviving), "the other client's ordinary-login credential must survive byte-for-byte").toBe(
			JSON.stringify(bystander),
		);
		expect(
			Object.keys(truth.getAll()).filter((id) => id.startsWith("mcp:acme-2--")),
			"our staged credential must be cleaned up, never clobbering the final key",
		).toEqual([]);
	});

	it("a removeAccount whose record write fails after the logout must report the real state", async () => {
		// A real record and credential exist; the Remove action runs, the
		// logout commits, but the RECORD write fails. The UI must not then
		// claim the account is "still connected" (the credential is gone) nor
		// pretend the removal succeeded.
		const now = Date.now();
		store.upsert({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme (acme-2)",
			status: "connected",
			createdAt: now,
			updatedAt: now,
			attemptId: randomUUID(),
		});
		await store.flush();
		authStorage.set("mcp:acme-2", {
			type: "oauth",
			access: "account-credential",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		// The in-memory auth backend performs no file writes, so the NEXT
		// durable write is the removeAccount's record write.
		writeControl.failOnNthWrite = writeControl.writeCount + 1;
		const fake = buildFake(async () => {
			throw new Error("no login may run during a Remove");
		});
		await callRemove(fake, "acme-2");

		const messages = JSON.stringify([
			...(fake.showStatus as ReturnType<typeof vi.fn>).mock.calls,
			...(fake.showWarning as ReturnType<typeof vi.fn>).mock.calls,
		]);
		// The record write failed, so the record survives.
		expect(store.get("acme-2"), "the record write failed: the record must survive").toBeDefined();
		// The logout already committed and must REMAIN EFFECTIVE: restoring the
		// credential to make the metadata failure look atomic is not honest.
		expect(
			authStorage.get("mcp:acme-2"),
			"an explicit logout must remain effective — never restored to fake atomicity",
		).toBeUndefined();
		// Claiming "still connected" while the credential is gone is false.
		expect(messages).not.toContain("still connected");
		// The removal must not be reported as succeeded either.
		expect(messages).not.toContain("Removed account acme-2.");
	});

	it("a Remove whose AUTH-FILE write fails must not report success while the credential persists on disk", async () => {
		// The auth cleanup goes through logout -> remove ->
		// persistProviderChange, which SWALLOWS write errors: the in-memory
		// cache says the credential is gone while the disk still has it. The
		// auth cleanup must be verified against the DISK, and the UI must not
		// claim the account was removed while the credential persists.
		const authPath = join(tempDir, "auth.json");
		authStorage = AuthStorage.create(authPath);
		const now = Date.now();
		store.upsert({
			connectionId: "acme-2",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme (acme-2)",
			status: "connected",
			createdAt: now,
			updatedAt: now,
			attemptId: randomUUID(),
		});
		await store.flush();
		authStorage.set("mcp:acme-2", {
			type: "oauth",
			access: "account-credential",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		// The next durable write is the logout's auth-file write: inject its
		// failure (the record write after it succeeds).
		writeControl.failOnNthWrite = writeControl.writeCount + 1;
		const fake = buildFake(async () => {
			throw new Error("no login may run during a Remove");
		});
		await callRemove(fake, "acme-2");

		const truth = AuthStorage.create(authPath);
		expect(
			truth.get("mcp:acme-2"),
			"the credential must be verified against the disk, not the in-memory cache",
		).toBeDefined();
		// The op resolves "failed" (try again), but today the working records
		// map already deleted the record BEFORE the auth cleanup threw — the
		// batch write then persists that deletion anyway. A failed op must
		// change NOTHING: the record must remain, in memory and on disk.
		expect(
			store.get("acme-2"),
			"a failed removeAccount must not leave a half-applied state: the record must remain in memory",
		).toBeDefined();
		expect(
			McpConnectionStore.open(join(tempDir, "mcp-connections.json")).get("acme-2"),
			"a failed removeAccount must not persist the record deletion to disk either",
		).toBeDefined();
		const messages = JSON.stringify([
			...(fake.showStatus as ReturnType<typeof vi.fn>).mock.calls,
			...(fake.showWarning as ReturnType<typeof vi.fn>).mock.calls,
		]);
		expect(messages).not.toContain("Removed account acme-2.");
		expect(messages).not.toContain("Disconnected");
	});

	it("a generic logout of the account key while our finalize is pending cancels the attempt (no reactivation)", async () => {
		// Two REAL file-backed instances share one credential file. Our
		// add-account attempt is pending; another client's ordinary login
		// writes the account key, and the user then logs that account out
		// through the generic logout route's effect (a real logout on the
		// other client's instance). The pending attempt must be CANCELLED
		// through shared store ordering — our late finalize must not
		// reactivate the account the user just logged out.
		const authPath = join(tempDir, "auth.json");
		authStorage = AuthStorage.create(authPath);
		const otherClient = AuthStorage.create(authPath);
		const fake = buildFake(async (serverId: string) => {
			if (!serverId.includes("--")) throw new Error(`login must target the staged id, got ${serverId}`);
			authStorage.set(`mcp:${serverId}`, {
				type: "oauth",
				access: `staged-for-${serverId}`,
				refresh: "r",
				expires: Date.now() + 3600_000,
				endpoint: "https://mcp.acme.test/mcp",
			});
			otherClient.set("mcp:acme-2", {
				type: "oauth",
				access: "other-client-ordinary-login",
				refresh: "other-client-refresh",
				expires: Date.now() + 3600_000,
				endpoint: "https://mcp.acme.test/mcp",
			});
			// The REAL generic-logout route for an MCP account key: the
			// exported one-op handler (verified credential deletion +
			// pending-attempt cancellation in ONE store-locked op), called
			// through the other client's real storage instance.
			expect(await logoutMcpAccount("mcp:acme-2", store, otherClient)).toBe("removed");
			return { status: "success" };
		});
		await callAddAccount(fake);

		const truth = AuthStorage.create(authPath);
		expect(
			truth.get("mcp:acme-2"),
			"the user logged the account out: our pending finalize must not reactivate it",
		).toBeUndefined();
		expect(
			Object.keys(truth.getAll()).filter((id) => id.startsWith("mcp:acme-2--")),
			"our staged credential must be discarded, never landed",
		).toEqual([]);
		const record = store.get("acme-2");
		expect(record?.status ?? "gone", "no record may claim the account connected").not.toBe("connected");
	});

	it("logging out a staged key cancels the attempt even when the connection id contains a double hyphen", async () => {
		// A catalog service whose id itself contains "--" allocates ids like
		// "my--service-2". The generic logout route's host hook must derive the
		// WHOLE base id from the staged provider id — an unconditional
		// split("--")[0] resolves "my" and the attempt survives: the user's
		// logout cannot abort the login it targeted.
		const fake = buildFake(async (serverId: string) => {
			if (!serverId.includes("--")) throw new Error(`login must target the staged id, got ${serverId}`);
			authStorage.set(`mcp:${serverId}`, {
				type: "oauth",
				access: `staged-for-${serverId}`,
				refresh: "r",
				expires: Date.now() + 3600_000,
				endpoint: "https://mcp.my-service.test/mcp",
			});
			// The user selects the STAGED provider in the generic logout
			// route: the REAL exported resolver + one-op handler run BEFORE
			// any auth mutation (no copied route literals).
			const stagedProviderId = `mcp:${serverId}`;
			const target = resolveMcpAccountLogoutTarget(stagedProviderId, store.records());
			expect(target.connectionId, "the resolver must keep the whole double-hyphen base id").toBe("my--service-2");
			await logoutMcpAccount(stagedProviderId, store, authStorage);
			return { status: "success" };
		});
		await callAddAccount(fake, "my--service", "https://mcp.my-service.test/mcp");

		// The shell-preservation contract: the staged-key logout cancels the
		// attempt (nonce invalidated) but PRESERVES the account shell record
		// for the WHOLE base id — the derivation targeted the right account,
		// never a split("--")[0] fragment.
		const shell = store.get("my--service-2");
		expect(shell, "the account shell for the whole double-hyphen base id must be preserved").toBeDefined();
		expect(shell?.attemptId, "the aborted attempt's nonce must be invalidated").toBeUndefined();
		expect(
			authStorage.list().filter((id) => id.startsWith("mcp:my--service-2--")),
			"the staged credential must be cleaned",
		).toEqual([]);
		expect(authStorage.get("mcp:my--service-2"), "no credential may land on the account key").toBeUndefined();
	});

	it("a generic logout whose disk write fails must not cancel the pending attempt as if it succeeded", async () => {
		// The route's logout is non-throwing today: an auth-file write failure
		// is swallowed (the in-memory cache says the credential is gone while
		// the disk still has it), and the hook then cancels the pending attempt
		// anyway. A logout that did not durably happen must not act as if it
		// did — no cancel-as-success while the credential persists on disk.
		const authPath = join(tempDir, "auth.json");
		authStorage = AuthStorage.create(authPath);
		const otherClient = AuthStorage.create(authPath);
		const fake = buildFake(async (serverId: string) => {
			if (!serverId.includes("--")) throw new Error(`login must target the staged id, got ${serverId}`);
			authStorage.set(`mcp:${serverId}`, {
				type: "oauth",
				access: `staged-for-${serverId}`,
				refresh: "r",
				expires: Date.now() + 3600_000,
				endpoint: "https://mcp.acme.test/mcp",
			});
			otherClient.set("mcp:acme-2", {
				type: "oauth",
				access: "other-client-ordinary-login",
				refresh: "other-client-refresh",
				expires: Date.now() + 3600_000,
				endpoint: "https://mcp.acme.test/mcp",
			});
			// The user's generic logout: the auth-file write is injected to
			// fail, and the REAL exported one-op handler runs (verified
			// credential deletion + attempt cancel in one store-locked op).
			writeControl.failOnNthWrite = writeControl.writeCount + 1;
			const outcome = await logoutMcpAccount("mcp:acme-2", store, authStorage);
			expect(outcome, "a failed verified removal must fail the whole op").toBe("failed");
			const midTruth = AuthStorage.create(authPath);
			if (midTruth.get("mcp:acme-2") !== undefined) {
				// The credential still persists on disk: the logout did not
				// durably happen, so the pending attempt RECORD must remain
				// too — no cancel-as-success, in memory and on disk.
				expect(
					store.get("acme-2"),
					"the pending attempt record itself must remain when the logout did not durably happen",
				).toBeDefined();
				expect(
					McpConnectionStore.open(join(tempDir, "mcp-connections.json")).get("acme-2"),
					"the pending attempt record must also remain on disk",
				).toBeDefined();
			}
			return { status: "success" };
		});
		await callAddAccount(fake);

		const truth = AuthStorage.create(authPath);
		expect(
			Object.keys(truth.getAll()).filter((id) => id.startsWith("mcp:acme-2--")),
			"our staged credential must be discarded either way",
		).toEqual([]);
	});

	it("an initial-connect OAuth SUCCESS arriving after an actual logout must not reactivate the account", async () => {
		// The account has an existing grant; the user starts a reconnect from
		// the service catalog (the REAL initial connect path — no addAccount),
		// then actually logs the account out while the login dialog is open.
		// The late login result must not reactivate the account.
		const authPath = join(tempDir, "auth.json");
		authStorage = AuthStorage.create(authPath);
		authStorage.set("mcp:acme", {
			type: "oauth",
			access: "existing-grant",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		const fake = buildFake(async (serverId: string) => {
			// The user's ACTUAL logout races the open login dialog: the REAL
			// exported one-op handler on the same files. (The flow now stages
			// the login under the reserved base id's attempt key.)
			await logoutMcpAccount("mcp:acme", store, authStorage);
			// The dialog completes afterwards — the real provider effect.
			authStorage.set(`mcp:${serverId}`, {
				type: "oauth",
				access: "late-login-credential",
				refresh: "r",
				expires: Date.now() + 3600_000,
				endpoint: "https://mcp.acme.test/mcp",
			});
			return { status: "success" };
		});
		await callInitialConnect(fake);

		const truth = AuthStorage.create(authPath);
		expect(
			truth.get("mcp:acme"),
			"a late login success must not reactivate the account the user logged out",
		).toBeUndefined();
	});

	it("a /mcp login OAuth SUCCESS arriving after an actual logout must not reactivate the account", async () => {
		// Same invariant through the REAL /mcp login command path.
		const authPath = join(tempDir, "auth.json");
		authStorage = AuthStorage.create(authPath);
		authStorage.set("mcp:acme", {
			type: "oauth",
			access: "existing-grant",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		const fake = buildFake(
			async (serverId: string) => {
				await logoutMcpAccount("mcp:acme", store, authStorage);
				authStorage.set(`mcp:${serverId}`, {
					type: "oauth",
					access: "late-login-credential",
					refresh: "r",
					expires: Date.now() + 3600_000,
					endpoint: "https://mcp.acme.test/mcp",
				});
				return { status: "success" };
			},
			{ acme: { type: "http", url: "https://mcp.acme.test/mcp" } },
		);
		await callMcpLoginCommand(fake, "acme");

		const truth = AuthStorage.create(authPath);
		expect(
			truth.get("mcp:acme"),
			"a late /mcp login success must not reactivate the account the user logged out",
		).toBeUndefined();
	});

	it("a cancelled reconnect preserves the existing credential and account unchanged", async () => {
		// The user dismisses the login dialog (a cancelled login): the
		// existing grant and the store state must survive byte-for-byte.
		const authPath = join(tempDir, "auth.json");
		authStorage = AuthStorage.create(authPath);
		const existing = {
			type: "oauth" as const,
			access: "existing-grant",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		authStorage.set("mcp:acme", existing);
		const account = { ...reservation("acme", randomUUID()), status: "connected" as const };
		delete account.attemptId;
		store.upsert(account);
		await store.flush();
		const before = store.get("acme");
		const fake = buildFake(async () => ({ status: "cancelled" }), {
			acme: { type: "http", url: "https://mcp.acme.test/mcp" },
		});
		await callMcpLoginCommand(fake, "acme");

		const truth = AuthStorage.create(authPath);
		expect(
			JSON.stringify(truth.get("mcp:acme")),
			"a cancelled reconnect must leave the existing credential unchanged",
		).toBe(JSON.stringify(existing));
		expect(store.get("acme"), "cancel must preserve all existing account metadata").toEqual(before);
		expect(McpConnectionStore.open(join(tempDir, "mcp-connections.json")).get("acme")).toEqual(before);
	});

	it("a late reconnect SUCCESS must not overwrite a newer external credential (full-identity CAS)", async () => {
		// Our reconnect login is in flight when a NEWER external credential
		// appears at the account key (an ordinary login in another client).
		// Our late success must never clobber it — byte-for-byte.
		const authPath = join(tempDir, "auth.json");
		authStorage = AuthStorage.create(authPath);
		const otherClient = AuthStorage.create(authPath);
		const newer = {
			type: "oauth" as const,
			access: "newer-external-credential",
			refresh: "newer-refresh",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		const fake = buildFake(async (serverId: string) => {
			otherClient.set("mcp:acme", { ...newer });
			authStorage.set(`mcp:${serverId}`, {
				type: "oauth",
				access: "our-late-login-credential",
				refresh: "r",
				expires: Date.now() + 3600_000,
				endpoint: "https://mcp.acme.test/mcp",
			});
			return { status: "success" };
		});
		await callInitialConnect(fake);

		const truth = AuthStorage.create(authPath);
		const surviving = truth.get("mcp:acme");
		expect(surviving).toBeDefined();
		expect(JSON.stringify(surviving), "a newer external credential must never be overwritten by a late login").toBe(
			JSON.stringify(newer),
		);
	});

	it("a /mcp login on a CONNECTED account performs a guarded reconnect, never a disconnect", async () => {
		// LOGIN INTENT on a connected account must run the guarded OAuth
		// reconnect (claim + staged login + CAS finalize) — routing through the
		// picker's action dispatch takes the DISCONNECT branch and removes the
		// account's credential instead of logging in.
		const authPath = join(tempDir, "auth.json");
		authStorage = AuthStorage.create(authPath);
		authStorage.set("mcp:acme", {
			type: "oauth",
			access: "existing-grant",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		const now = Date.now();
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "connected",
			createdAt: now,
			updatedAt: now,
		});
		await store.flush();
		const fake = buildFake(async (serverId: string) => {
			authStorage.set(`mcp:${serverId}`, {
				type: "oauth",
				access: "reconnect-credential",
				refresh: "r",
				expires: Date.now() + 3600_000,
				endpoint: "https://mcp.acme.test/mcp",
			});
			return { status: "success" };
		});
		await callMcpLoginCommand(fake, "acme");

		const truth = AuthStorage.create(authPath);
		const credential = truth.get("mcp:acme");
		expect(credential).toBeDefined();
		expect(
			(credential as { access: string }).access,
			"a /mcp login must reconnect the account, never disconnect it",
		).toBe("reconnect-credential");
		expect(store.get("acme"), "the account record must survive a login").toBeDefined();
	});

	it("a /mcp login on a PENDING account performs a guarded reconnect, never just a verification", async () => {
		// LOGIN INTENT on a connected account must run the guarded OAuth
		// reconnect (claim + staged login + CAS finalize) — routing through the
		// picker's action dispatch takes the DISCONNECT branch and removes the
		// account's credential instead of logging in.
		const authPath = join(tempDir, "auth.json");
		authStorage = AuthStorage.create(authPath);
		authStorage.set("mcp:acme", {
			type: "oauth",
			access: "existing-grant",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		});
		const now = Date.now();
		store.upsert({
			connectionId: "acme",
			serviceId: "acme",
			endpoint: "https://mcp.acme.test/mcp",
			label: "Acme",
			status: "pending",
			createdAt: now,
			updatedAt: now,
		});
		await store.flush();
		const fake = buildFake(async (serverId: string) => {
			authStorage.set(`mcp:${serverId}`, {
				type: "oauth",
				access: "reconnect-credential",
				refresh: "r",
				expires: Date.now() + 3600_000,
				endpoint: "https://mcp.acme.test/mcp",
			});
			return { status: "success" };
		});
		await callMcpLoginCommand(fake, "acme");

		const truth = AuthStorage.create(authPath);
		const credential = truth.get("mcp:acme");
		expect(credential).toBeDefined();
		expect(
			(credential as { access: string }).access,
			"a /mcp login must reconnect the account, never disconnect it",
		).toBe("reconnect-credential");
		expect(store.get("acme"), "the account record must survive a login").toBeDefined();
	});

	it("a cancelled /mcp login reports failure, not success", async () => {
		// The name-routed login must PROPAGATE the guarded connect's outcome:
		// an endpoint resolving is not login success. The cancelled outcome
		// survives routing and the existing credential stays unchanged.
		const authPath = join(tempDir, "auth.json");
		authStorage = AuthStorage.create(authPath);
		const existing = {
			type: "oauth" as const,
			access: "existing-grant",
			refresh: "r",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		authStorage.set("mcp:acme", existing);
		const fake = buildFake(async () => ({ status: "cancelled" }), {
			acme: { type: "http", url: "https://mcp.acme.test/mcp" },
		});
		const outcome = await (
			fake as unknown as {
				connectMcpAccountByName: (
					this: unknown,
					name: string,
				) => Promise<{ resolved: boolean; result: { status: string } }>;
			}
		).connectMcpAccountByName.call(fake, "acme");
		expect(outcome.resolved).toBe(true);
		expect(outcome.result.status, "endpoint resolution must not turn cancellation into success").toBe("cancelled");
		expect(
			JSON.stringify(AuthStorage.create(authPath).get("mcp:acme")),
			"a cancelled login must leave the existing credential unchanged",
		).toBe(JSON.stringify(existing));
	});

	it("a /mcp login for a double-hyphen id routes through the guarded connect, never a raw bypass", async () => {
		// A settings-configured server whose id itself contains "--" must
		// resolve EXACTLY and log in through the guarded staged flow — no
		// blanket double-hyphen refusal may drop it to a raw unguarded write.
		let sawStagedId = false;
		const fake = buildFake(
			async (serverId: string) => {
				sawStagedId = serverId.startsWith("my--service--") && serverId !== "my--service";
				authStorage.set(`mcp:${serverId}`, {
					type: "oauth",
					access: "guarded-login-credential",
					refresh: "r",
					expires: Date.now() + 3600_000,
					endpoint: "https://mcp.my-service.test/mcp",
				});
				return { status: "success" };
			},
			{ "my--service": { type: "http", url: "https://mcp.my-service.test/mcp" } },
		);
		await callMcpLoginCommand(fake, "my--service");

		expect(sawStagedId, "the double-hyphen id must log in through the guarded staged flow").toBe(true);
		const credential = authStorage.get("mcp:my--service");
		expect(credential).toBeDefined();
		expect((credential as { access: string }).access).toBe("guarded-login-credential");
	});

	it("a refused finalize of a fresh reservation preserves the account shell and releases only the nonce", async () => {
		// Our fresh add-account attempt reserved the id; a NEWER external
		// credential appeared at the account key mid-login. The finalize
		// refuses (occupied) and the cleanup must NOT delete the record — the
		// shell the newer credential lives behind — releasing only OUR nonce.
		const authPath = join(tempDir, "auth.json");
		authStorage = AuthStorage.create(authPath);
		const otherClient = AuthStorage.create(authPath);
		const newer = {
			type: "oauth" as const,
			access: "newer-external-credential",
			refresh: "newer-refresh",
			expires: Date.now() + 3600_000,
			endpoint: "https://mcp.acme.test/mcp",
		};
		const fake = buildFake(async (serverId: string) => {
			if (!serverId.includes("--")) throw new Error(`login must target the staged id, got ${serverId}`);
			otherClient.set("mcp:acme-2", { ...newer });
			authStorage.set(`mcp:${serverId}`, {
				type: "oauth",
				access: `staged-for-${serverId}`,
				refresh: "r",
				expires: Date.now() + 3600_000,
				endpoint: "https://mcp.acme.test/mcp",
			});
			return { status: "success" };
		});
		await callAddAccount(fake);

		const truth = AuthStorage.create(authPath);
		expect(JSON.stringify(truth.get("mcp:acme-2")), "the newer external credential must survive byte-for-byte").toBe(
			JSON.stringify(newer),
		);
		const shell = store.get("acme-2");
		expect(
			shell,
			"a refused finalize must preserve the account shell — never delete the record the newer writer's credential lives behind",
		).toBeDefined();
		expect(shell?.attemptId, "only OUR nonce may be released").toBeUndefined();
		expect(
			Object.keys(truth.getAll()).filter((id) => id.startsWith("mcp:acme-2--")),
			"our staged credential must be discarded",
		).toEqual([]);
	});
	it.each(["fresh", "legacy"] as const)(
		"a cancelled %s login preserves a newer writer's shell and releases its nonce",
		async (kind) => {
			const authPath = join(tempDir, "auth.json");
			authStorage = AuthStorage.create(authPath);
			const otherClient = AuthStorage.create(authPath);
			const oldCredential: AuthCredential = { type: "oauth", access: "old", refresh: "old-refresh", expires: 1000 };
			const newer: AuthCredential = { type: "oauth", access: "newer", refresh: "newer-refresh", expires: 2000 };
			if (kind === "legacy") authStorage.set("mcp:acme", oldCredential);
			let entered = false;
			const fake = buildFake(async () => {
				entered = true;
				otherClient.set("mcp:acme", newer);
				return { status: "cancelled" };
			});
			await callInitialConnect(fake);
			expect(entered).toBe(true);
			expect(AuthStorage.create(authPath).get("mcp:acme")).toEqual(newer);
			const shell = McpConnectionStore.open(join(tempDir, "mcp-connections.json")).get("acme");
			expect(shell, "durable shell must survive cancellation regardless of auth snapshot").toBeDefined();
			expect(shell?.attemptId).toBeUndefined();
			expect(shell?.status).not.toBe("connected");
		},
	);

	it.each(["my--service", "unresolved-service"])(
		"generic MCP login for %s never falls back to an unguarded dialog",
		async (name) => {
			let stagedId: string | undefined;
			const fake = buildFake(
				async (serverId) => {
					stagedId = serverId;
					await logoutMcpAccount(`mcp:${name}`, store, authStorage);
					authStorage.set(`mcp:${serverId}`, { type: "oauth", access: "late", refresh: "r", expires: 1000 });
					return { status: "success" };
				},
				name === "my--service" ? { [name]: { type: "http", url: "https://mcp.acme.test/mcp" } } : undefined,
			);
			// Invoke REAL createAuthFlows on the fake receiver. Its real host hook
			// delegates back into the real ByName/guard; only the private dialog is fake.
			const createRealFlows = (
				InteractiveMode.prototype as unknown as {
					createAuthFlows: (this: unknown) => {
						loginProvider: (option: {
							id: string;
							name: string;
							authType: "oauth";
							category: "service";
						}) => Promise<{ status: string }>;
						showLoginDialog: (...args: unknown[]) => Promise<{ status: string }>;
					};
				}
			).createAuthFlows;
			const flows = createRealFlows.call(fake);
			const rawDialog = vi.spyOn(flows, "showLoginDialog").mockResolvedValue({ status: "failed" });
			const result = await flows.loginProvider({ id: `mcp:${name}`, name, authType: "oauth", category: "service" });
			expect(rawDialog, "outer MCP route must never call the raw credential-writing dialog").not.toHaveBeenCalled();
			expect(result.status).not.toBe("success");
			if (name === "my--service") expect(stagedId).toMatch(/^my--service--.+/);
			else expect(stagedId).toBeUndefined();
			expect(authStorage.get(`mcp:${name}`)).toBeUndefined();
		},
	);
	it("a reconnect finalize write failure restores the old credential and releases only its nonce", async () => {
		const authPath = join(tempDir, "auth.json");
		authStorage = AuthStorage.create(authPath);
		const previous: AuthCredential = {
			type: "oauth",
			access: "previous",
			refresh: "previous-refresh",
			expires: 1000,
		};
		authStorage.set("mcp:acme", previous);
		const account = { ...reservation("acme", randomUUID()), status: "connected" as const };
		delete account.attemptId;
		store.upsert(account);
		await store.flush();
		const before = store.get("acme");
		const fake = buildFake(async (serverId) => {
			authStorage.set(`mcp:${serverId}`, {
				type: "oauth",
				access: "replacement",
				refresh: "replacement-refresh",
				expires: 2000,
			});
			// Auth CAS move writes first; the following record commit must fail.
			writeControl.failOnNthWrite = writeControl.writeCount + 2;
			return { status: "success" };
		});
		await callMcpLoginCommand(fake, "acme");
		expect(AuthStorage.create(authPath).get("mcp:acme")).toEqual(previous);
		expect(McpConnectionStore.open(join(tempDir, "mcp-connections.json")).get("acme")).toEqual(before);
		expect(Object.keys(AuthStorage.create(authPath).getAll()).filter((id) => id.startsWith("mcp:acme--"))).toEqual(
			[],
		);
	});

	it("failed cancellation cleanup reports recovery and cannot clear its nonce on a later flush", async () => {
		const fake = buildFake(async () => {
			// In-memory auth needs no file write: fail the release's record write.
			writeControl.failOnNthWrite = writeControl.writeCount + 1;
			return { status: "cancelled" };
		});
		await callInitialConnect(fake);
		expect(fake.showWarning).toHaveBeenCalled();
		const retained = store.get("acme");
		expect(retained?.attemptId, "failed cleanup keeps retry/recovery ownership data").toBeDefined();
		store.upsert(reservation("unrelated", randomUUID()));
		await store.flush();
		expect(McpConnectionStore.open(join(tempDir, "mcp-connections.json")).get("acme")).toEqual(retained);
	});
});
