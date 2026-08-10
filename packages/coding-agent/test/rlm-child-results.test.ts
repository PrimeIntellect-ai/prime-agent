import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	canonicalChildResultBytes,
	createOrGetTerminalChildResult,
	getChildResultProjection,
	MAX_STREAM_CHUNK_BYTES,
	readOwnedArtifact,
	recordChildResultDisposition,
	resolveOwnedChildResult,
	setC04ProcessIdentitySeamForTest,
} from "../src/core/rlm-child-results.js";
import { createRlmSafeTerminalResultTerminalMessage } from "../src/core/rlm-durable-operations.js";
import { SessionManager } from "../src/core/session-manager.js";

const ids = [
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
	"33333333-3333-4333-8333-333333333333",
	"44444444-4444-4444-8444-444444444444",
	"55555555-5555-4555-8555-555555555555",
];
function owner(file: string) {
	return {
		parentSessionId: ids[0],
		childSessionId: ids[1],
		childSessionFile: file,
		assignmentId: ids[2],
		operationId: ids[3],
		deliveryId: ids[4],
	};
}
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.filter((key) => object[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
		.join(",")}}`;
}

function authority(file: string) {
	const state = dirname(dirname(file));
	const parentFile = join(state, "sessions", `${ids[0]}.jsonl`);
	const parentArtifacts = join(state, "session-artifacts", ids[0]);
	mkdirSync(parentArtifacts, { recursive: true, mode: 0o700 });
	writeFileSync(parentFile, `${JSON.stringify({ type: "session", id: ids[0] })}\n`, { mode: 0o600 });
	const recoveryKeyPath = join(parentArtifacts, ".c04-recovery-key");
	writeFileSync(recoveryKeyPath, Buffer.alloc(32, 7), { mode: 0o600 });
	chmodSync(recoveryKeyPath, 0o600);
	return { parentSessionFile: parentFile, parentArtifactRoot: parentArtifacts, recoveryKeyPath };
}

describe("C04 bounded child results", () => {
	it("commits an opaque streamed result idempotently and denies cross-owner bytes", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", id: ids[1] })}\n`);
		try {
			const input = {
				owner: owner(file),
				childArtifactRoot: artifacts,
				parentRecoveryAuthority: authority(file),
				candidate: {
					status: "completed" as const,
					summary: "done",
					preview: "safe",
					artifacts: [
						{
							kind: "terminal_output" as const,
							contentType: "text/plain" as const,
							data: (async function* () {
								yield new TextEncoder().encode("private");
							})(),
						},
					],
					model: { initialResolvedSelector: "test/a", terminalResolvedSelector: "test/a" },
				},
			};
			const result = await createOrGetTerminalChildResult(input);
			const again = await createOrGetTerminalChildResult({
				...input,
				candidate: {
					...input.candidate,
					artifacts: [
						{
							...input.candidate.artifacts![0]!,
							data: (async function* () {
								yield new TextEncoder().encode("private");
							})(),
						},
					],
				},
			});
			expect(again).toEqual(result);
			await expect(
				createOrGetTerminalChildResult({ ...input, candidate: { ...input.candidate, preview: "different" } }),
			).rejects.toThrow("immutable operation conflict");
			expect(JSON.stringify(result)).not.toContain("private");
			const grant = resolveOwnedChildResult(input.owner, result.artifacts[0].handleId, artifacts);
			expect(grant).toBeDefined();
			expect(
				new TextDecoder().decode(
					readOwnedArtifact(grant!.capability, { offset: 0, length: MAX_STREAM_CHUNK_BYTES }),
				),
			).toBe("private");
			expect(
				resolveOwnedChildResult({ ...input.owner, assignmentId: ids[4] }, result.artifacts[0].handleId, artifacts),
			).toBeUndefined();
			expect(getChildResultProjection(input.owner, result.resultId, artifacts)).toEqual(result);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("rejects inline payloads and treats a different retry stream as an immutable conflict", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-stream-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", id: ids[1] })}\n`);
		const stream = (text: string) =>
			(async function* () {
				yield new TextEncoder().encode(text);
			})();
		try {
			const input = {
				owner: owner(file),
				childArtifactRoot: artifacts,
				parentRecoveryAuthority: authority(file),
				candidate: {
					status: "completed" as const,
					summary: "done",
					preview: "safe",
					artifacts: [{ kind: "terminal_output" as const, contentType: "text/plain" as const, data: stream("A") }],
				},
			};
			await createOrGetTerminalChildResult(input);
			await expect(
				createOrGetTerminalChildResult({
					...input,
					candidate: { ...input.candidate, artifacts: [{ ...input.candidate.artifacts[0]!, data: stream("B") }] },
				}),
			).rejects.toThrow("immutable operation conflict");
			await expect(
				createOrGetTerminalChildResult({
					...input,
					owner: { ...input.owner, operationId: ids[4] },
					candidate: {
						...input.candidate,
						artifacts: [{ ...input.candidate.artifacts[0]!, data: "not-a-stream" as never }],
					},
				}),
			).rejects.toThrow("payload must be");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("requires the exact SessionManager child artifact binding and keeps a loser from removing a winner reservation", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-binding-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		const sibling = join(root, "session-artifacts", ids[4]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		mkdirSync(sibling, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", id: ids[1] })}\n`);
		const base = {
			owner: owner(file),
			childArtifactRoot: artifacts,
			parentRecoveryAuthority: authority(file),
			candidate: { status: "completed" as const, summary: "done", preview: "safe" },
		};
		try {
			await expect(createOrGetTerminalChildResult({ ...base, childArtifactRoot: sibling })).rejects.toThrow(
				"exact SessionManager",
			);
			let release!: () => void;
			const held = createOrGetTerminalChildResult({
				...base,
				candidate: {
					...base.candidate,
					artifacts: [
						{
							kind: "terminal_output" as const,
							contentType: "text/plain" as const,
							data: (async function* () {
								await new Promise<void>((resolve) => {
									release = resolve;
								});
								yield new TextEncoder().encode("winner");
							})(),
						},
					],
				},
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			await expect(createOrGetTerminalChildResult(base)).rejects.toThrow("immutable operation conflict");
			release();
			const winner = await held;
			expect(getChildResultProjection(base.owner, winner.resultId, artifacts)).toEqual(winner);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("publishes disposition before removal so a resolved capability cannot return payload after delete", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-disposition-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", id: ids[1] })}\n`);
		const input = {
			owner: owner(file),
			childArtifactRoot: artifacts,
			parentRecoveryAuthority: authority(file),
			candidate: {
				status: "completed" as const,
				summary: "done",
				preview: "safe",
				artifacts: [
					{
						kind: "terminal_output" as const,
						contentType: "text/plain" as const,
						data: (async function* () {
							yield new TextEncoder().encode("private");
						})(),
					},
				],
			},
		};
		try {
			const result = await createOrGetTerminalChildResult(input);
			const grant = resolveOwnedChildResult(input.owner, result.artifacts[0]!.handleId, artifacts)!;
			expect(
				recordChildResultDisposition(input.owner, { resultId: result.resultId, disposition: "deleted" }, artifacts),
			).toBe(true);
			expect(readOwnedArtifact(grant.capability, { offset: 0, length: 7 })).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("uses authenticated recoverable disposition leases and fails closed for live or unreadable owners", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-disposition-lease-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", id: ids[1] })}\n`);
		const input = {
			owner: owner(file),
			childArtifactRoot: artifacts,
			parentRecoveryAuthority: authority(file),
			candidate: {
				status: "completed" as const,
				summary: "done",
				preview: "safe",
				artifacts: [
					{
						kind: "terminal_output" as const,
						contentType: "text/plain" as const,
						data: (async function* () {
							yield new TextEncoder().encode("private");
						})(),
					},
				],
			},
		};
		try {
			const result = await createOrGetTerminalChildResult(input);
			const operationIndex = join(artifacts, "rlm-child-results", "operation-index");
			const lock = join(operationIndex, `.disposition.${result.resultId}.lock`);
			const installLease = () => {
				const payload = {
					version: 1,
					owner: input.owner,
					resultId: result.resultId,
					nonce: ids[4],
					pid: process.pid,
					processStartId: "old-owner",
				};
				const mac = createHmac("sha256", readFileSync(input.parentRecoveryAuthority.recoveryKeyPath))
					.update(canonical(payload))
					.digest("hex");
				mkdirSync(lock, { mode: 0o700 });
				writeFileSync(join(lock, "lease.json"), canonical({ ...payload, mac }), { mode: 0o600 });
			};
			for (const state of ["live", "unreadable"] as const) {
				installLease();
				const restore = setC04ProcessIdentitySeamForTest({
					captureCurrent: () => ({ pid: process.pid, processStartId: "current" }),
					observe: () => state,
				});
				expect(
					recordChildResultDisposition(
						input.owner,
						{ resultId: result.resultId, disposition: "deleted" },
						artifacts,
					),
				).toBe(false);
				restore();
				expect(existsSync(lock)).toBe(true);
				rmSync(lock, { recursive: true, force: true }); // Test cleanup, never production recovery.
			}
			for (const state of ["dead", "mismatch"] as const) {
				installLease();
				const restore = setC04ProcessIdentitySeamForTest({
					captureCurrent: () => ({ pid: process.pid, processStartId: "current" }),
					observe: () => state,
				});
				expect(
					recordChildResultDisposition(
						input.owner,
						{ resultId: result.resultId, disposition: "deleted" },
						artifacts,
					),
				).toBe(true);
				restore();
				expect(existsSync(lock)).toBe(false);
				expect(
					JSON.parse(
						readFileSync(join(artifacts, "rlm-child-results", "results", `${result.resultId}.json`), "utf8"),
					).generation,
				).toBe(1);
				break; // State is terminal after the first successful transition.
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts authority UUIDv7 identities while preserving random v4 result/handle IDs", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-v7-"));
		const childV7 = "019a8f42-1234-7000-8000-123456789abc";
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", childV7);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${childV7}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", id: childV7 })}\n`);
		try {
			const parentSessionId = "019a8f42-1234-7000-8000-123456789abd";
			const parentArtifacts = join(root, "session-artifacts", parentSessionId);
			mkdirSync(parentArtifacts, { recursive: true });
			const parentFile = join(sessions, `${parentSessionId}.jsonl`);
			writeFileSync(parentFile, `${JSON.stringify({ type: "session", id: parentSessionId })}\n`);
			const parentRecoveryAuthority = {
				parentSessionFile: parentFile,
				parentArtifactRoot: parentArtifacts,
				recoveryKeyPath: join(parentArtifacts, ".c04-recovery-key"),
			};
			writeFileSync(parentRecoveryAuthority.recoveryKeyPath, Buffer.alloc(32, 7), { mode: 0o600 });
			const result = await createOrGetTerminalChildResult({
				owner: {
					parentSessionId,
					childSessionId: childV7,
					childSessionFile: file,
					assignmentId: "019a8f42-1234-7000-8000-123456789abe",
					operationId: "019a8f42-1234-7000-8000-123456789abf",
					deliveryId: "019a8f42-1234-7000-8000-123456789ac0",
				},
				childArtifactRoot: artifacts,
				parentRecoveryAuthority,
				candidate: { status: "completed", summary: "done", preview: "safe" },
			});
			expect(result.resultId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("measures quote/backslash worst case through C03's stable envelope before commit", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-c03-cap-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", id: ids[1] })}\n`);
		try {
			const result = await createOrGetTerminalChildResult({
				owner: owner(file),
				childArtifactRoot: artifacts,
				parentRecoveryAuthority: authority(file),
				candidate: {
					status: "completed",
					summary: '\\"'.repeat(2_048),
					preview: '\\"'.repeat(1_024),
				},
			});
			const projection = Buffer.from(canonicalChildResultBytes(result)).toString("utf8");
			const envelope = createRlmSafeTerminalResultTerminalMessage(
				"Child completed; bounded result available.",
				projection,
				0,
			);
			expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(64 * 1024);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses a real SessionManager-issued session header binding", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-real-session-manager-"));
		const sessions = join(root, "sessions");
		const manager = SessionManager.create(root, sessions);
		manager.flushNow();
		const file = manager.getSessionFile()!;
		const artifacts = manager.getSessionArtifactDir()!;
		mkdirSync(artifacts, { recursive: true });
		try {
			const result = await createOrGetTerminalChildResult({
				owner: { ...owner(file), childSessionId: manager.getSessionId() },
				childArtifactRoot: artifacts,
				parentRecoveryAuthority: authority(file),
				candidate: { status: "completed", summary: "done", preview: "safe" },
			});
			expect(
				getChildResultProjection(
					{ ...owner(file), childSessionId: manager.getSessionId() },
					result.resultId,
					artifacts,
				),
			).toEqual(result);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reconciles a dead reservation after the result and blobs were durable but indexes were not", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-reconcile-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", id: ids[1] })}\n`);
		const base = {
			owner: owner(file),
			childArtifactRoot: artifacts,
			parentRecoveryAuthority: authority(file),
			candidate: { status: "completed" as const, summary: "done", preview: "safe" },
		};
		try {
			const result = await createOrGetTerminalChildResult(base);
			const resultRoot = join(artifacts, "rlm-child-results");
			const index = join(resultRoot, "operation-index", `${ids[3]}.json`);
			const reservation = join(resultRoot, "operation-index", `.${ids[3]}.reserve`);
			const quota = join(resultRoot, "operation-index", `.quota.${ids[1]}.${ids[2]}.reserve`);
			const payload = {
				version: 1,
				owner: base.owner,
				indexPath: index,
				nonce: ids[4],
				pid: 999999,
				processStartId: "dead-start",
				progress: "reserved",
				resultId: result.resultId,
			};
			const key = readFileSync(base.parentRecoveryAuthority.recoveryKeyPath);
			const journal = { ...payload, mac: createHmac("sha256", key).update(canonical(payload)).digest("hex") };
			writeFileSync(reservation, JSON.stringify(journal));
			writeFileSync(quota, JSON.stringify(journal));
			rmSync(index);
			const restoreIdentity = setC04ProcessIdentitySeamForTest({
				captureCurrent: () => ({ pid: process.pid, processStartId: "current" }),
				observe: () => "dead",
			});
			const again = await createOrGetTerminalChildResult({ ...base, candidate: { ...base.candidate } });
			restoreIdentity();
			expect(again).toEqual(result);
			expect(getChildResultProjection(base.owner, result.resultId, artifacts)).toEqual(result);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed for live, unreadable, malformed, or MAC-tampered reservations without deleting them", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-reservation-fail-closed-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", id: ids[1] })}\n`);
		const base = {
			owner: owner(file),
			childArtifactRoot: artifacts,
			parentRecoveryAuthority: authority(file),
			candidate: { status: "completed" as const, summary: "done", preview: "safe" },
		};
		try {
			const result = await createOrGetTerminalChildResult(base);
			const resultRoot = join(artifacts, "rlm-child-results");
			const index = join(resultRoot, "operation-index", `${ids[3]}.json`);
			const reservation = join(resultRoot, "operation-index", `.${ids[3]}.reserve`);
			const quota = join(resultRoot, "operation-index", `.quota.${ids[1]}.${ids[2]}.reserve`);
			const payload = {
				version: 1,
				owner: base.owner,
				indexPath: index,
				nonce: ids[4],
				pid: 999999,
				processStartId: "owner-start",
				progress: "reserved",
				resultId: result.resultId,
			};
			const key = readFileSync(base.parentRecoveryAuthority.recoveryKeyPath);
			const valid = { ...payload, mac: createHmac("sha256", key).update(canonical(payload)).digest("hex") };
			for (const [journal, identity] of [
				[valid, "live"],
				[valid, "unreadable"],
				[{ ...valid, mac: "00".repeat(32) }, "dead"],
				[{ nope: true }, "dead"],
			] as const) {
				rmSync(index, { force: true });
				writeFileSync(reservation, JSON.stringify(journal));
				writeFileSync(quota, JSON.stringify(journal));
				const restore = setC04ProcessIdentitySeamForTest({
					captureCurrent: () => ({ pid: process.pid, processStartId: "current" }),
					observe: () => identity,
				});
				await expect(createOrGetTerminalChildResult({ ...base, candidate: { ...base.candidate } })).rejects.toThrow(
					"immutable operation conflict",
				);
				restore();
				expect(readFileSync(reservation, "utf8")).toBe(JSON.stringify(journal));
				expect(getChildResultProjection(base.owner, result.resultId, artifacts)).toEqual(result);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reclaims a PID-recycled start-token mismatch but never by wall clock", async () => {
		const root = mkdtempSync(join(tmpdir(), "c04-reservation-recycled-"));
		const sessions = join(root, "sessions");
		const artifacts = join(root, "session-artifacts", ids[1]);
		mkdirSync(sessions, { recursive: true });
		mkdirSync(artifacts, { recursive: true });
		const file = join(sessions, `${ids[1]}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", id: ids[1] })}\n`);
		const base = {
			owner: owner(file),
			childArtifactRoot: artifacts,
			parentRecoveryAuthority: authority(file),
			candidate: { status: "completed" as const, summary: "done", preview: "safe" },
		};
		try {
			const result = await createOrGetTerminalChildResult(base);
			const resultRoot = join(artifacts, "rlm-child-results");
			const index = join(resultRoot, "operation-index", `${ids[3]}.json`);
			const reservation = join(resultRoot, "operation-index", `.${ids[3]}.reserve`);
			const quota = join(resultRoot, "operation-index", `.quota.${ids[1]}.${ids[2]}.reserve`);
			const payload = {
				version: 1,
				owner: base.owner,
				indexPath: index,
				nonce: ids[4],
				pid: process.pid,
				processStartId: "old-incarnation",
				progress: "reserved" as const,
				resultId: result.resultId,
			};
			const mac = createHmac("sha256", readFileSync(base.parentRecoveryAuthority.recoveryKeyPath))
				.update(canonical(payload))
				.digest("hex");
			writeFileSync(reservation, JSON.stringify({ ...payload, mac }));
			writeFileSync(quota, JSON.stringify({ ...payload, mac }));
			rmSync(index);
			const restore = setC04ProcessIdentitySeamForTest({
				captureCurrent: () => ({ pid: process.pid, processStartId: "current" }),
				observe: () => "mismatch",
			});
			await expect(createOrGetTerminalChildResult({ ...base, candidate: { ...base.candidate } })).resolves.toEqual(
				result,
			);
			restore();
			expect(() => readFileSync(reservation)).toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
