// Independent ed02 Bugbot ownership regressions. Production verifier, manager,
// file-backed store/claim/finalize and auth CAS; only network/probe timing is fake.
// Offline: temporary files, denied fetch, synthetic credentials, no OAuth dialog.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpOAuthProvider } from "@earendil-works/pi-ai/mcp";
import { registerOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthCredential, AuthStorage } from "../src/core/auth-storage.js";
import { type McpConnectionRecord, McpConnectionStore } from "../src/core/mcp/connection-store.js";
import { type McpServiceDescriptor, verifyMcpConnection } from "../src/core/mcp/service-catalog.js";

const ID = "ownership-proof";
const URL = "https://ownership.example.test/mcp";
const KEY = `mcp:${ID}`;
const _SERVICE: McpServiceDescriptor = {
	serviceId: ID,
	label: "Ownership",
	aliases: [],
	transport: { type: "http", url: URL },
	authStrategy: "oauth",
	setup: { status: "ready" },
	metadataReviewed: true,
	legacyBuiltin: false,
};
function barrier() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
function credential(access = "synthetic-old", endpoint = URL): AuthCredential {
	return { type: "oauth", access, refresh: "synthetic-refresh", expires: Date.now() + 3_600_000, endpoint };
}
function record(overrides: Partial<McpConnectionRecord> = {}): McpConnectionRecord {
	return {
		connectionId: ID,
		serviceId: ID,
		endpoint: URL,
		label: "Saved account",
		status: "error",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("MCP verification ownership across persisted claims", () => {
	let directory: string;
	let auth: AuthStorage;
	let otherAuth: AuthStorage;
	let store: McpConnectionStore;
	let otherStore: McpConnectionStore;
	let storePath: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "mcp-verify-owner-"));
		const authPath = join(directory, "auth.json");
		storePath = join(directory, "connections.json");
		auth = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		otherAuth = AuthStorage.create(authPath, { usePrimeCliConfig: false });
		store = McpConnectionStore.open(storePath);
		otherStore = McpConnectionStore.open(storePath);
		resetOAuthProviders();
		registerOAuthProvider(createMcpOAuthProvider({ server: ID, label: "Ownership", url: URL }));
		vi.stubGlobal(
			"fetch",
			vi.fn(() => {
				throw new Error("Network forbidden in verification ownership tests");
			}),
		);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		resetOAuthProviders();
		rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});
	const persisted = () => McpConnectionStore.open(storePath).get(ID);
	async function seed(overrides: Partial<McpConnectionRecord> = {}) {
		store.upsert(record(overrides));
		await store.flush();
	}
	function verify(probe: NonNullable<Parameters<typeof verifyMcpConnection>[0]["probe"]>, usesOAuth = true) {
		return verifyMcpConnection({
			authStorage: auth,
			connectionStore: store,
			connectionId: ID,
			serviceId: ID,
			label: "Probe must not rename saved account",
			endpoint: URL,
			usesOAuth,
			probe,
		});
	}
	async function finalize(attemptId: string, access = "synthetic-new") {
		const expected = otherAuth.getVerified(KEY);
		const staged = `${KEY}--${attemptId}`;
		otherAuth.set(staged, credential(access));
		return otherStore.finalizeAttempt({
			connectionId: ID,
			attemptId,
			commit: (current) => {
				const replaced = otherAuth.replaceStagedCredential(staged, KEY, expected);
				if (replaced.status !== "replaced") throw new Error("Synthetic finalize CAS refused");
				const { attemptId: _finished, ...settled } = current;
				return { ...settled, label: "Finalized account", status: "connected", verifiedAt: 777, toolCount: 77 };
			},
		});
	}

	it("control: a current unowned probe persists successfully", async () => {
		auth.set(KEY, credential());
		await seed();
		const result = await verify(async () => ({ ok: true, toolCount: 3 }));
		expect(result.status).toBe("connected");
		expect(persisted()).toMatchObject({ status: "connected", toolCount: 3 });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("probe started before another client's claim cannot erase the claim or deny real finalize", async () => {
		auth.set(KEY, credential());
		await seed();
		const entered = barrier();
		const finish = barrier();
		const probing = verify(async () => {
			entered.release();
			await finish.promise;
			return { ok: true, toolCount: 2 };
		});
		await entered.promise;
		const claimed = await otherStore.claimConnectionId({ connectionId: ID, attemptId: "live-login" });
		const claimedRecord = persisted();
		finish.release();
		const result = await probing;
		const afterProbe = persisted();
		const finalized = await finalize("live-login");
		expect(claimed).toBe(true);
		expect(afterProbe, "verification must not mutate the live claim").toEqual(claimedRecord);
		expect(finalized, "OAuth finalization must still own its nonce").toBe("committed");
		expect(otherAuth.getVerified(KEY)).toMatchObject({ access: "synthetic-new", endpoint: URL });
		expect(result.status, "a discarded probe must not report a newly connected grant").not.toBe("connected");
	});

	it.each(["missing", "unbound"] as const)(
		"%s-grant failure path leaves an existing first-login reservation untouched",
		async (kind) => {
			if (kind === "unbound") auth.set(KEY, credential("synthetic-old", "https://other.example.test/mcp"));
			const reserved = await otherStore.reserveConnectionId(record({ status: "pending", attemptId: "first-login" }));
			const before = persisted();
			const probe = vi.fn(async () => ({ ok: true as const, toolCount: 1 }));
			const result = await verify(probe);
			const after = persisted();
			const finalized = await finalize("first-login");
			expect(reserved).toBe(true);
			expect(after).toEqual(before);
			expect(finalized).toBe("committed");
			expect(probe).not.toHaveBeenCalled();
			expect(result.status).not.toBe("connected");
		},
	);

	it("a throwing probe cannot use an unconditional catch write to replace a newly claimed account", async () => {
		auth.set(KEY, credential());
		await seed();
		const entered = barrier();
		const finish = barrier();
		const probing = verify(async () => {
			entered.release();
			await finish.promise;
			throw new Error("synthetic probe failure");
		});
		await entered.promise;
		await otherStore.claimConnectionId({ connectionId: ID, attemptId: "throw-race" });
		const before = persisted();
		finish.release();
		await probing;
		const after = persisted();
		const finalized = await finalize("throw-race");
		expect(after).toEqual(before);
		expect(finalized).toBe("committed");
	});

	it("same-token finalize wins over an older probe and keeps finalized record metadata", async () => {
		auth.set(KEY, credential());
		await seed();
		const entered = barrier();
		const finish = barrier();
		const probing = verify(async () => {
			entered.release();
			await finish.promise;
			return { ok: true, toolCount: 2 };
		});
		await entered.promise;
		await otherStore.claimConnectionId({ connectionId: ID, attemptId: "finalize-first" });
		const finalized = await finalize("finalize-first", "synthetic-old");
		const before = persisted();
		finish.release();
		await probing;
		expect(finalized).toBe("committed");
		expect(persisted()).toEqual(before);
		expect(persisted()).toMatchObject({ label: "Finalized account", verifiedAt: 777, toolCount: 77 });
	});

	// Both anonymous-probe races pin ONE invariant: a probe that started with
	// no record of its own must never resurrect or overwrite account state
	// another client created (or removed) while the probe was in flight.
	it.each([
		{
			name: "removal does not resurrect the record",
			mutate: async () => otherStore.removeAccount({ connectionId: ID, authCleanup: () => false }),
			expect: "gone",
		},
		{
			name: "a new reservation from another instance is never overwritten",
			mutate: async () => otherStore.reserveConnectionId(record({ status: "pending", attemptId: "new-owner" })),
			expect: "pending",
		},
	])("an anonymous probe racing store changes: $name", async ({ mutate, expect: expected }) => {
		// The reservation case starts from NO record (a truly anonymous probe);
		// the removal case starts from a seeded record.
		if (expected === "gone") await seed();
		const entered = barrier();
		const finish = barrier();
		const probing = verify(async () => {
			entered.release();
			await finish.promise;
			return { ok: true, toolCount: 2 };
		}, false);
		await entered.promise;
		await mutate();
		const before = persisted();
		finish.release();
		const result = await probing;
		if (expected === "gone") {
			expect(persisted()).toBeUndefined();
		} else {
			expect(persisted()?.attemptId).toBe("new-owner");
			expect(persisted()).toEqual(before);
		}
		expect(result.status).not.toBe("connected");
	});
});
