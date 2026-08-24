import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { canonicalJsonBytes, parseCanonicalJsonBytes, type WorkflowLeaseRef } from "../src/core/workflow/contracts.js";
import {
	createLocalAppendLease,
	createLocalAppendLeaseProcessIdentity,
	type LocalAppendLeaseClock,
} from "../src/core/workflow/local-append-lease.js";

it("persists an authenticated lease, survives restart, renews, asserts, and releases", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-local-append-lease-"));
	const clock = createClock("2030-01-01T00:00:00.000Z");
	const options = {
		sessionArtifactRoot: root,
		rootDigest: "root-digest-1",
		storeEpoch: 7,
		secret: "test-secret",
		ttlMilliseconds: 5_000,
		clock,
	};

	try {
		const first = createLocalAppendLease({ ...options, writerIdentity: "writer-a", processIdentity: "process-a" });
		const acquired = await first.acquire("workflow-1", "writer-a", 1, "process-a");
		expect(acquired).toMatchObject({
			storeEpoch: 7,
			coordinatorEpoch: 1,
			acquisitionEventSequence: 1,
			processIdentity: "process-a",
			rootDigest: "root-digest-1",
			writerIdentity: "writer-a",
		});

		const leasePath = join(root, "workflows", "workflow-1", "append-lease.json");
		const persistedBytes = await readFile(leasePath);
		const persisted = parseCanonicalJsonBytes(persistedBytes);
		expect(persistedBytes).toEqual(Buffer.from(canonicalJsonBytes(persisted)));
		expect(persisted).toMatchObject({
			workflowId: "workflow-1",
			status: "active",
			authentication: { algorithm: "hmac-sha256" },
		});

		const restarted = createLocalAppendLease({
			...options,
			writerIdentity: "writer-a",
			processIdentity: "process-a",
		});
		expect(await restarted.observe("workflow-1")).toEqual({ writerIdentity: "writer-a", leaseRef: acquired });

		clock.advance(1_000);
		await restarted.renew("workflow-1", "writer-a", 1);
		const renewed = await restarted.observe("workflow-1");
		expect(renewed).not.toBeNull();
		expect(renewed?.leaseRef.expiresAt).not.toBe(acquired.expiresAt);
		await restarted.assertOwned({
			workflowId: "workflow-1",
			writerIdentity: "writer-a",
			leaseRef: acquired,
			epochRef: { storeEpoch: 7, coordinatorEpoch: 1 },
			rootDigest: "root-digest-1",
			boundary: "append-with-original-identity",
		});
		await restarted.assertOwned({
			workflowId: "workflow-1",
			writerIdentity: "writer-a",
			leaseRef: renewed!.leaseRef,
			epochRef: { storeEpoch: 7, coordinatorEpoch: 1 },
			rootDigest: "root-digest-1",
			boundary: "append",
		});

		await restarted.release("workflow-1", "writer-a", 1);
		expect(await restarted.observe("workflow-1")).toBeNull();

		const successor = createLocalAppendLease({
			...options,
			writerIdentity: "writer-b",
			processIdentity: "process-b",
		});
		const next = await successor.acquire("workflow-1", "writer-b", 2, "process-b");
		expect(next.acquisitionEventSequence).toBe(2);
		expect(next.writerIdentity).toBe("writer-b");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("fences an expired owner and requires an explicit authenticated rotation", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-local-append-lease-expired-"));
	const clock = createClock("2030-01-01T00:00:00.000Z");
	const options = {
		sessionArtifactRoot: root,
		rootDigest: "root-digest-2",
		storeEpoch: 3,
		secret: "test-secret",
		ttlMilliseconds: 1_000,
		clock,
	};

	try {
		const oldOwner = createLocalAppendLease({
			...options,
			writerIdentity: "writer-old",
			processIdentity: "process-old",
		});
		const previous = await oldOwner.acquire("workflow-2", "writer-old", 4, "process-old");
		clock.advance(1_000);

		await expect(
			oldOwner.assertOwned({
				workflowId: "workflow-2",
				writerIdentity: "writer-old",
				leaseRef: previous,
				epochRef: { storeEpoch: 3, coordinatorEpoch: 4 },
				rootDigest: "root-digest-2",
				boundary: "append",
			}),
		).rejects.toMatchObject({ code: "workflow_append_lease_expired" });
		await expect(oldOwner.renew("workflow-2", "writer-old", 4)).rejects.toMatchObject({
			code: "workflow_append_lease_expired",
		});

		const newOwner = createLocalAppendLease({
			...options,
			writerIdentity: "writer-new",
			processIdentity: "process-new",
		});
		await expect(newOwner.acquire("workflow-2", "writer-new", 5, "process-new")).rejects.toMatchObject({
			code: "workflow_append_lease_expired",
		});

		const next: typeof previous = {
			...previous,
			leaseId: "lease-successor",
			coordinatorEpoch: 5,
			acquisitionEventSequence: 2,
			processIdentity: "process-new",
			writerIdentity: "writer-new",
			acquiredAt: clock.now(),
			expiresAt: clock.addMilliseconds(clock.now(), 1_000),
		};
		await newOwner.rotate({
			workflowId: "workflow-2",
			expectedWriterIdentity: "writer-old",
			expectedLeaseRef: previous,
			nextWriterIdentity: "writer-new",
			nextLeaseRef: next,
		});
		await expect(oldOwner.release("workflow-2", "writer-old", 4)).rejects.toMatchObject({
			code: "workflow_append_lease_stale",
		});
		expect(await newOwner.observe("workflow-2")).toEqual({ writerIdentity: "writer-new", leaseRef: next });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("requires authenticated generation rotation after a definitively dead owner", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-local-append-lease-killed-"));
	const moduleUrl = pathToFileURL(join(process.cwd(), "src/core/workflow/local-append-lease.ts")).href;
	const childSource = `
import { createLocalAppendLease, createLocalAppendLeaseProcessIdentity } from ${JSON.stringify(moduleUrl)};
const root = process.argv[1];
const processIdentity = createLocalAppendLeaseProcessIdentity();
const clock = { now: () => "2030-01-01T00:00:00.000Z", addMilliseconds: (base, amount) => new Date(Date.parse(base) + amount).toISOString() };
const lease = createLocalAppendLease({ sessionArtifactRoot: root, rootDigest: "killed-root", storeEpoch: 9, secret: "killed-secret", ttlMilliseconds: 5_000, clock, writerIdentity: "writer-old", processIdentity });
await lease.acquire("workflow-killed", "writer-old", 3, processIdentity);
console.log("ready");
process.stdin.resume();
`;

	try {
		const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", childSource, root], {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		await new Promise<void>((resolveReady, rejectReady) => {
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
				if (stdout.includes("ready\n")) resolveReady();
			});
			child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
			child.once("error", rejectReady);
			child.once("close", (code, signal) =>
				rejectReady(
					new Error(`child exited before lease acquisition (${code ?? "null"}/${signal ?? "none"}): ${stderr}`),
				),
			);
		});
		child.kill("SIGKILL");
		await new Promise<void>((resolveExit, rejectExit) => {
			child.once("error", rejectExit);
			child.once("close", (_code, signal) => {
				if (signal !== "SIGKILL") {
					rejectExit(new Error(`child was not SIGKILLed: ${signal ?? "none"}`));
					return;
				}
				resolveExit();
			});
		});

		const replacementIdentity = createLocalAppendLeaseProcessIdentity();
		const replacement = createLocalAppendLease({
			sessionArtifactRoot: root,
			rootDigest: "killed-root",
			storeEpoch: 9,
			secret: "killed-secret",
			ttlMilliseconds: 5_000,
			clock: createClock("2030-01-01T00:00:00.000Z"),
			writerIdentity: "writer-new",
			processIdentity: replacementIdentity,
		});
		await expect(replacement.acquire("workflow-killed", "writer-new", 3, replacementIdentity)).rejects.toMatchObject({
			code: "workflow_append_lease_recovery_required",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("does not replace a live or unverifiable process owner", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-local-append-lease-live-"));
	const clock = createClock("2030-01-01T00:00:00.000Z");
	const liveIdentity = createLocalAppendLeaseProcessIdentity();
	const owner = createLocalAppendLease({
		sessionArtifactRoot: root,
		rootDigest: "live-root",
		storeEpoch: 1,
		secret: "live-secret",
		ttlMilliseconds: 5_000,
		clock,
		writerIdentity: "writer-live",
		processIdentity: liveIdentity,
	});
	const replacement = createLocalAppendLease({
		sessionArtifactRoot: root,
		rootDigest: "live-root",
		storeEpoch: 1,
		secret: "live-secret",
		ttlMilliseconds: 5_000,
		clock,
		writerIdentity: "writer-replacement",
		processIdentity: "process-unverifiable",
	});

	try {
		await owner.acquire("workflow-live", "writer-live", 1, liveIdentity);
		await expect(
			replacement.acquire("workflow-live", "writer-replacement", 1, "process-unverifiable"),
		).rejects.toMatchObject({
			code: "workflow_append_lease_owned",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("reuses the held filesystem guard for a nested same-context ownership assertion", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-local-append-lease-nested-"));
	const clock = createClock("2030-01-01T00:00:00.000Z");
	const lease = createLocalAppendLease({
		sessionArtifactRoot: root,
		rootDigest: "nested-root",
		storeEpoch: 1,
		secret: "nested-secret",
		ttlMilliseconds: 5_000,
		clock,
		writerIdentity: "writer-nested",
		processIdentity: "process-nested",
		guardTimeoutMilliseconds: 100,
	});

	try {
		const leaseRef = await lease.acquire("workflow-nested", "writer-nested", 1, "process-nested");
		const input = {
			workflowId: "workflow-nested",
			writerIdentity: "writer-nested",
			leaseRef,
			epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
			rootDigest: "nested-root",
			boundary: "nested-assert",
		};
		await expect(
			lease.withExclusiveGuard(input, async () => {
				await lease.assertOwned(input);
				return "guarded";
			}),
		).resolves.toBe("guarded");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("recovers a lease whose durable MAC uses only the next generation key", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-local-append-lease-recovery-next-"));
	const clock = createClock("2030-01-01T00:00:00.000Z");
	const previousSecret = "recovery-previous-secret";
	const nextSecret = "recovery-next-secret";
	const options = {
		sessionArtifactRoot: root,
		rootDigest: "recovery-root",
		storeEpoch: 1,
		ttlMilliseconds: 5_000,
		clock,
	};

	try {
		const owner = createLocalAppendLease({ ...options, secret: previousSecret });
		const previousLeaseRef = await owner.acquire("workflow-recovery-next", "writer-previous", 1, "process-previous");
		const nextLeaseRef = {
			...previousLeaseRef,
			leaseId: "lease-recovery-next",
			coordinatorEpoch: 2,
			acquisitionEventSequence: 2,
			processIdentity: "process-next",
			writerIdentity: "writer-next",
			acquiredAt: clock.now(),
			expiresAt: clock.addMilliseconds(clock.now(), 5_000),
		};
		owner.prepareSecretRotation(nextSecret);
		await owner.rotate({
			workflowId: "workflow-recovery-next",
			expectedWriterIdentity: "writer-previous",
			expectedLeaseRef: previousLeaseRef,
			nextWriterIdentity: "writer-next",
			nextLeaseRef,
		});

		const recovery = createLocalAppendLease({
			...options,
			secret: "not-a-candidate",
			writerIdentity: "writer-next",
			processIdentity: "process-next",
		});
		await expect(recovery.observe("workflow-recovery-next")).rejects.toMatchObject({
			code: "workflow_append_lease_authentication_invalid",
		});
		await expect(
			recovery.withRecoveryGuard(
				{
					workflowId: "workflow-recovery-next",
					previousLeaseRef,
					nextLeaseRef,
					previousSecret,
					nextSecret,
					rootDigest: "recovery-root",
					boundary: "recovery-next",
				},
				async (observed) => {
					expect(observed).toEqual({ classification: "next", leaseRef: nextLeaseRef });
					await recovery.assertOwned({
						workflowId: "workflow-recovery-next",
						writerIdentity: "writer-next",
						leaseRef: nextLeaseRef,
						epochRef: { storeEpoch: 1, coordinatorEpoch: 2 },
						rootDigest: "recovery-root",
						boundary: "nested-recovery-next",
					});
					return await recovery.observe("workflow-recovery-next");
				},
			),
		).resolves.toEqual({ writerIdentity: "writer-next", leaseRef: nextLeaseRef });
		await expect(recovery.observe("workflow-recovery-next")).rejects.toMatchObject({
			code: "workflow_append_lease_authentication_invalid",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("recovers a lease whose durable MAC uses the previous generation key", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-local-append-lease-recovery-previous-"));
	const clock = createClock("2030-01-01T00:00:00.000Z");
	const previousSecret = "recovery-previous-only";
	const nextSecret = "recovery-next-only";
	const options = {
		sessionArtifactRoot: root,
		rootDigest: "recovery-previous-root",
		storeEpoch: 1,
		ttlMilliseconds: 5_000,
		clock,
	};

	try {
		const owner = createLocalAppendLease({ ...options, secret: previousSecret });
		const previousLeaseRef = await owner.acquire(
			"workflow-recovery-previous",
			"writer-previous",
			1,
			"process-previous",
		);
		const nextLeaseRef = {
			...previousLeaseRef,
			leaseId: "lease-recovery-next-candidate",
			coordinatorEpoch: 2,
			acquisitionEventSequence: 2,
			processIdentity: "process-next",
			writerIdentity: "writer-next",
			acquiredAt: clock.now(),
			expiresAt: clock.addMilliseconds(clock.now(), 5_000),
		};
		const recovery = createLocalAppendLease({
			...options,
			secret: "not-a-candidate",
			writerIdentity: "writer-previous",
			processIdentity: "process-previous",
		});

		await expect(
			recovery.withRecoveryGuard(
				{
					workflowId: "workflow-recovery-previous",
					previousLeaseRef,
					nextLeaseRef,
					previousSecret,
					nextSecret,
					rootDigest: "recovery-previous-root",
					boundary: "recovery-previous",
				},
				async (observed) => {
					expect(observed).toEqual({ classification: "previous", leaseRef: previousLeaseRef });
					await recovery.assertOwned({
						workflowId: "workflow-recovery-previous",
						writerIdentity: "writer-previous",
						leaseRef: previousLeaseRef,
						epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
						rootDigest: "recovery-previous-root",
						boundary: "nested-recovery-previous",
					});
					return observed.classification;
				},
			),
		).resolves.toBe("previous");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("rejects a candidate-key MAC over a mismatched lease tuple", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-local-append-lease-recovery-mismatch-"));
	const clock = createClock("2030-01-01T00:00:00.000Z");
	const previousSecret = "recovery-mismatch-previous";
	const nextSecret = "recovery-mismatch-next";
	const options = {
		sessionArtifactRoot: root,
		rootDigest: "recovery-mismatch-root",
		storeEpoch: 1,
		ttlMilliseconds: 5_000,
		clock,
	};

	try {
		const owner = createLocalAppendLease({ ...options, secret: previousSecret });
		const previousLeaseRef = await owner.acquire(
			"workflow-recovery-mismatch",
			"writer-previous",
			1,
			"process-previous",
		);
		const nextLeaseRef = {
			...previousLeaseRef,
			leaseId: "lease-recovery-mismatch-next",
			coordinatorEpoch: 2,
			acquisitionEventSequence: 2,
			processIdentity: "process-next",
			writerIdentity: "writer-next",
			acquiredAt: clock.now(),
			expiresAt: clock.addMilliseconds(clock.now(), 5_000),
		};
		const mismatchedLeaseRef = { ...nextLeaseRef, writerIdentity: "writer-forged" };
		await remacLeaseFile(
			join(root, "workflows", "workflow-recovery-mismatch", "append-lease.json"),
			mismatchedLeaseRef,
			nextSecret,
		);

		const recovery = createLocalAppendLease({ ...options, secret: "not-a-candidate" });
		await expect(
			recovery.withRecoveryGuard(
				{
					workflowId: "workflow-recovery-mismatch",
					previousLeaseRef,
					nextLeaseRef,
					previousSecret,
					nextSecret,
					rootDigest: "recovery-mismatch-root",
					boundary: "recovery-mismatch",
				},
				async () => "unexpected",
			),
		).rejects.toMatchObject({ code: "workflow_append_lease_recovery_mismatch" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("rejects ambiguous recovery candidates instead of choosing one", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-local-append-lease-recovery-ambiguous-"));
	const clock = createClock("2030-01-01T00:00:00.000Z");
	const secret = "recovery-ambiguous-secret";
	const options = {
		sessionArtifactRoot: root,
		rootDigest: "recovery-ambiguous-root",
		storeEpoch: 1,
		ttlMilliseconds: 5_000,
		clock,
	};

	try {
		const owner = createLocalAppendLease({ ...options, secret });
		const leaseRef = await owner.acquire("workflow-recovery-ambiguous", "writer", 1, "process-writer");
		const nextLeaseRef = { ...leaseRef, leaseId: "lease-recovery-ambiguous-next", coordinatorEpoch: 2 };
		const recovery = createLocalAppendLease({ ...options, secret: "not-a-candidate" });
		await expect(
			recovery.withRecoveryGuard(
				{
					workflowId: "workflow-recovery-ambiguous",
					previousLeaseRef: leaseRef,
					nextLeaseRef,
					previousSecret: secret,
					nextSecret: secret,
					rootDigest: "recovery-ambiguous-root",
					boundary: "recovery-ambiguous",
				},
				async () => "unexpected",
			),
		).rejects.toMatchObject({ code: "workflow_append_lease_recovery_ambiguous" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("holds the recovery filesystem guard for the entire callback", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-local-append-lease-recovery-guard-"));
	const clock = createClock("2030-01-01T00:00:00.000Z");
	const previousSecret = "recovery-guard-previous";
	const nextSecret = "recovery-guard-next";
	const options = {
		sessionArtifactRoot: root,
		rootDigest: "recovery-guard-root",
		storeEpoch: 1,
		ttlMilliseconds: 5_000,
		clock,
	};

	try {
		const owner = createLocalAppendLease({ ...options, secret: previousSecret });
		const previousLeaseRef = await owner.acquire("workflow-recovery-guard", "writer", 1, "process-writer");
		const nextLeaseRef = { ...previousLeaseRef, leaseId: "lease-recovery-guard-next", coordinatorEpoch: 2 };
		const recovery = createLocalAppendLease({ ...options, secret: "not-a-candidate" });
		const contender = createLocalAppendLease({
			...options,
			secret: previousSecret,
			guardTimeoutMilliseconds: 25,
		});
		let entered: () => void = () => undefined;
		let release: () => void = () => undefined;
		const enteredPromise = new Promise<void>((resolvePromise) => (entered = resolvePromise));
		const releasePromise = new Promise<void>((resolvePromise) => (release = resolvePromise));
		const guarded = recovery.withRecoveryGuard(
			{
				workflowId: "workflow-recovery-guard",
				previousLeaseRef,
				nextLeaseRef,
				previousSecret,
				nextSecret,
				rootDigest: "recovery-guard-root",
				boundary: "recovery-guard",
			},
			async () => {
				entered();
				await releasePromise;
				return "released";
			},
		);
		await enteredPromise;
		await expect(contender.observe("workflow-recovery-guard")).rejects.toMatchObject({
			code: "workflow_append_lease_guard_timeout",
		});
		release();
		await expect(guarded).resolves.toBe("released");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("serializes two real processes with a filesystem no-replace acquisition", async () => {
	const root = await mkdtemp(join(tmpdir(), "workflow-local-append-lease-race-"));
	const moduleUrl = pathToFileURL(join(process.cwd(), "src/core/workflow/local-append-lease.ts")).href;
	const childSource = `
import { createLocalAppendLease } from ${JSON.stringify(moduleUrl)};
const root = process.argv[1];
const writer = process.argv[2];
const processIdentity = process.argv[3];
const clock = { now: () => "2030-01-01T00:00:00.000Z", addMilliseconds: (base, amount) => new Date(Date.parse(base) + amount).toISOString() };
const lease = createLocalAppendLease({ sessionArtifactRoot: root, rootDigest: "race-root", storeEpoch: 1, secret: "race-secret", ttlMilliseconds: 5_000, clock, writerIdentity: writer, processIdentity });
try { const ref = await lease.acquire("workflow-race", writer, 1, processIdentity); console.log(JSON.stringify({ ok: true, writer, ref })); }
catch (error) { console.log(JSON.stringify({ ok: false, writer, code: error.code ?? "unknown" })); }
`;

	try {
		const child = (
			writer: string,
			processIdentity: string,
		): Promise<{ ok: boolean; writer: string; code?: string }> =>
			new Promise((resolve, reject) => {
				const processHandle = spawn(
					process.execPath,
					["--import", "tsx/esm", "--input-type=module", "-e", childSource, root, writer, processIdentity],
					{
						cwd: process.cwd(),
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				let stdout = "";
				let stderr = "";
				processHandle.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
				processHandle.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
				processHandle.on("error", reject);
				processHandle.on("close", (exitCode) => {
					if (exitCode !== 0) {
						reject(new Error(`child exited ${exitCode}: ${stderr}`));
						return;
					}
					try {
						resolve(JSON.parse(stdout.trim()) as { ok: boolean; writer: string; code?: string });
					} catch (error) {
						reject(new Error(`invalid child output: ${stdout} ${stderr}`, { cause: error }));
					}
				});
			});

		const results = await Promise.all([child("writer-a", "process-a"), child("writer-b", "process-b")]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toHaveLength(1);
		expect(results.find((result) => !result.ok)?.code).toBe("workflow_append_lease_owned");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function createClock(initial: string): LocalAppendLeaseClock & { advance(milliseconds: number): void } {
	let current = Date.parse(initial);
	return {
		now: () => new Date(current).toISOString(),
		addMilliseconds: (base, milliseconds) => new Date(Date.parse(base) + milliseconds).toISOString(),
		advance: (milliseconds) => {
			current += milliseconds;
		},
	};
}

async function remacLeaseFile(path: string, leaseRef: WorkflowLeaseRef, secret: string): Promise<void> {
	const value = parseCanonicalJsonBytes(await readFile(path));
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("lease record invalid");
	const current = value as unknown as {
		version: number;
		workflowId: string;
		status: string;
		renewedAt: string;
		previousLeaseDigest: string | null;
	};
	const unsigned = {
		version: current.version,
		workflowId: current.workflowId,
		status: current.status,
		leaseRef,
		renewedAt: current.renewedAt,
		previousLeaseDigest: current.previousLeaseDigest,
	};
	const authentication = {
		algorithm: "hmac-sha256",
		mac: createHmac("sha256", secret).update(canonicalJsonBytes(unsigned)).digest("hex"),
	};
	await writeFile(path, canonicalJsonBytes({ ...unsigned, authentication }), { mode: 0o600 });
}
