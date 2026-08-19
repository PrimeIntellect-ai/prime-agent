import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KnowledgeRecord } from "../src/core/knowledge/records.js";
import {
	createFileScopedKnowledgeStorage,
	createScopedKnowledgeAuthority,
	type ScopedKnowledgeAuthority,
	type ScopedKnowledgeCrashHook,
	type ScopedKnowledgeGlobalApproval,
	type ScopedKnowledgeHostBoundary,
	type ScopedKnowledgePromotionInput,
	type ScopedKnowledgeScope,
	type ScopedKnowledgeSourceBinding,
	type ScopedKnowledgeTarget,
	type ScopedKnowledgeTransferEvidence,
	scopedKnowledgeGlobalApprovalDigest,
	scopedKnowledgePromotionAuthorizationDigests,
	scopedKnowledgeTransferEvidenceDigest,
} from "../src/core/knowledge/scoped-knowledge-authority.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	parseCanonicalJsonBytes,
	type WorkflowEpochRef,
	type WorkflowJournalHead,
	type WorkflowTrustedPrincipal,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import type { WorkflowLearningHostWitness } from "../src/core/workflow/learning-controller.js";

const NOW = "2026-08-17T00:00:00.000Z";
const LATER = "2026-08-17T01:00:00.000Z";
const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
type Lifecycle = "active" | "retracted" | "revoked" | "quarantined";

describe("authenticated scoped knowledge authority", () => {
	it("transfers workflow A knowledge to B, scopes goal recall, and preserves the workflow source", async () => {
		const root = await mkdtemp(join(tmpdir(), "scoped-knowledge-authority-goal-"));
		try {
			const storagePath = join(root, "scoped-knowledge.json");
			const receiptContext = createFixtureHostReceiptConsumerContext();
			const source = sourceRecord("workflow-a", "goal-a");
			const registry = sourceRegistry(source);
			const host = createHost(receiptContext, registry);
			const authority = createAuthority(storagePath, receiptContext, host);
			const targetValue = target("goal", "goal-a", "domain-a");

			await expect(
				authority.promote(await promotionInput(receiptContext, source, targetValue)),
			).resolves.toMatchObject({ status: "committed" });
			await expect(
				authority.recall({
					workflowId: "workflow-a",
					query: "fixture",
					requestedScope: "goal",
					target: targetValue,
					policyRevision: "policy-1",
				}),
			).resolves.toEqual(
				expect.arrayContaining([
					expect.objectContaining({ source: "workflow", statement: source.statement }),
					expect.objectContaining({ source: "scoped", scope: "goal", statement: source.statement }),
				]),
			);

			const reopened = createAuthority(
				storagePath,
				receiptContext,
				createHost(receiptContext, registry, { workflowId: "workflow-b" }),
			);
			await expect(
				reopened.recall({
					workflowId: "workflow-b",
					query: "fixture",
					requestedScope: "goal",
					target: targetValue,
					policyRevision: "policy-1",
				}),
			).resolves.toEqual(
				expect.arrayContaining([
					expect.objectContaining({ source: "scoped", scope: "goal", statement: source.statement }),
				]),
			);
			const foreignGoal = target("goal", "goal-b", "domain-a");
			await expect(
				reopened.recall({
					workflowId: "workflow-b",
					query: "fixture",
					requestedScope: "goal",
					target: foreignGoal,
					policyRevision: "policy-1",
				}),
			).resolves.toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("requires independent transfer evidence for domain and signed approval for global", async () => {
		const root = await mkdtemp(join(tmpdir(), "scoped-knowledge-authority-scope-"));
		try {
			const storagePath = join(root, "scoped-knowledge.json");
			const receiptContext = createFixtureHostReceiptConsumerContext();
			const domainSource = sourceRecord("workflow-domain", "goal-a");
			const globalSource = sourceRecord("workflow-global", "goal-a");
			const registry = sourceRegistry(domainSource, globalSource);
			const authority = createAuthority(storagePath, receiptContext, createHost(receiptContext, registry));
			const domainTarget = target("domain", null, "domain-a");
			await expect(
				authority.promote(await promotionInput(receiptContext, domainSource, domainTarget)),
			).resolves.toMatchObject({ status: "committed" });

			const globalTarget = target("global", null, null);
			await expect(
				authority.promote(
					await promotionInput(receiptContext, globalSource, globalTarget, {
						globalApproval: undefined,
						receiptId: "global-promotion-unapproved",
					}),
				),
			).rejects.toThrow(/signed host\/user approval/);
			const approval = await globalApproval(receiptContext, globalSource);
			await expect(
				authority.promote(
					await promotionInput(receiptContext, globalSource, globalTarget, {
						globalApproval: approval,
						receiptId: "global-promotion-approved",
					}),
				),
			).resolves.toMatchObject({ status: "committed" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects stale source head, epoch, and receipt revision before admission", async () => {
		const root = await mkdtemp(join(tmpdir(), "scoped-knowledge-authority-stale-source-"));
		try {
			const storagePath = join(root, "scoped-knowledge.json");
			const receiptContext = createFixtureHostReceiptConsumerContext();
			const source = sourceRecord("workflow-stale-source", "goal-a");
			const registry = sourceRegistry(source);
			const authority = createAuthority(storagePath, receiptContext, createHost(receiptContext, registry));
			const targetValue = target("goal", "goal-a", "domain-a");

			const staleHead = await promotionInput(receiptContext, source, targetValue, {
				receiptId: "stale-head",
			});
			staleHead.source.binding.sourceHead = {
				...staleHead.source.binding.sourceHead,
				sequence: staleHead.source.binding.sourceHead.sequence + 1,
			};
			await expect(authority.promote(staleHead)).rejects.toThrow(/exact authenticated source head/);

			const staleEpoch = await promotionInput(receiptContext, source, targetValue, {
				receiptId: "stale-epoch",
			});
			staleEpoch.source.binding.sourceEpochRef = { storeEpoch: 2, coordinatorEpoch: 1 };
			await expect(authority.promote(staleEpoch)).rejects.toThrow(/head epoch/);

			const staleRevision = await promotionInput(receiptContext, source, targetValue, {
				receiptId: "stale-revision",
			});
			staleRevision.source.binding.sourceReceipt = {
				...staleRevision.source.binding.sourceReceipt,
				revision: staleRevision.source.binding.sourceReceipt.revision + 1,
			};
			await expect(authority.promote(staleRevision)).rejects.toThrow(
				/receipt witness|cryptographically valid|source receipt/,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("requires canPromote for never and keeps its canonical never target", async () => {
		const root = await mkdtemp(join(tmpdir(), "scoped-knowledge-authority-never-admission-"));
		try {
			const storagePath = join(root, "scoped-knowledge.json");
			const receiptContext = createFixtureHostReceiptConsumerContext();
			const source = sourceRecord("workflow-never-admission", "goal-a");
			const registry = sourceRegistry(source);
			const authority = createAuthority(
				storagePath,
				receiptContext,
				createHost(receiptContext, registry, { canPromote: false }),
			);
			await expect(
				authority.promote(
					await promotionInput(receiptContext, source, target("never", null, null), {
						scope: "never",
						transferEvidence: [],
					}),
				),
			).rejects.toThrow(/admission/);
			expect(Object.keys((await authority.read()).tombstones)).toHaveLength(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not turn a transient source resolver outage into a durable revocation", async () => {
		const root = await mkdtemp(join(tmpdir(), "scoped-knowledge-authority-transient-source-"));
		try {
			const storagePath = join(root, "scoped-knowledge.json");
			const receiptContext = createFixtureHostReceiptConsumerContext();
			const source = sourceRecord("workflow-transient-source", "goal-a");
			const registry = sourceRegistry(source);
			const targetValue = target("goal", "goal-a", "domain-a");
			const authority = createAuthority(storagePath, receiptContext, createHost(receiptContext, registry));
			const promotion = await authority.promote(await promotionInput(receiptContext, source, targetValue));
			const scopedRecordId = promotion.record?.scopedRecordId as string;
			registry.resolveError = new Error("temporary source resolver outage");

			await expect(
				authority.recall({
					workflowId: "workflow-b",
					query: "fixture",
					requestedScope: "goal",
					target: targetValue,
					policyRevision: "policy-1",
				}),
			).rejects.toThrow("temporary source resolver outage");
			expect((await authority.read()).records[scopedRecordId]?.status).toBe("active");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("binds recall to the authenticated target and workflow rather than structural callback output", async () => {
		const root = await mkdtemp(join(tmpdir(), "scoped-knowledge-authority-recall-binding-"));
		try {
			const storagePath = join(root, "scoped-knowledge.json");
			const receiptContext = createFixtureHostReceiptConsumerContext();
			const source = sourceRecord("workflow-recall-binding", "goal-a");
			const registry = sourceRegistry(source);
			const targetValue = target("goal", "goal-a", "domain-a");
			const authority = createAuthority(
				storagePath,
				receiptContext,
				createHost(receiptContext, registry, {
					workflowId: "workflow-recall-binding",
					authorizationWorkflowId: "workflow-recall-binding",
					authorizationGoalId: "goal-b",
				}),
			);
			await expect(
				authority.promote(await promotionInput(receiptContext, source, targetValue)),
			).resolves.toMatchObject({
				status: "committed",
			});
			await expect(
				authority.recall({
					workflowId: "workflow-recall-binding",
					query: "fixture",
					requestedScope: "goal",
					target: targetValue,
					policyRevision: "policy-1",
				}),
			).rejects.toThrow(/target|authorization/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("requires the canonical sealed host boundary instead of a structural host lookalike", async () => {
		const root = await mkdtemp(join(tmpdir(), "scoped-knowledge-authority-forged-host-"));
		try {
			const receiptContext = createFixtureHostReceiptConsumerContext();
			const source = sourceRecord("workflow-forged-host", "goal-a");
			const forged = createHost(receiptContext, sourceRegistry(source));
			expect(() =>
				createScopedKnowledgeAuthority({
					storage: createFileScopedKnowledgeStorage({
						filePath: join(root, "scoped-knowledge.json"),
						trustDomainId: "trust-local",
					}),
					host: { ...forged, receiptContext: { ...receiptContext } },
				}),
			).toThrow(/CONTRACT_CHANGE|sealed host/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects revoked source and transfer receipts through the central resolver", async () => {
		const root = await mkdtemp(join(tmpdir(), "scoped-knowledge-authority-receipt-admission-"));
		try {
			const storagePath = join(root, "scoped-knowledge.json");
			const receiptContext = createFixtureHostReceiptConsumerContext();
			const source = sourceRecord("workflow-receipt-admission", "goal-a");
			const registry = sourceRegistry(source);
			const targetValue = target("goal", "goal-a", "domain-a");
			const authority = createAuthority(storagePath, receiptContext, createHost(receiptContext, registry));

			const revokedSource = await promotionInput(receiptContext, source, targetValue, {
				receiptId: "revoked-source-receipt",
			});
			await receiptContext.revokeReceipt?.(source.privacy.secretScan.receiptId);
			await expect(authority.promote(revokedSource)).rejects.toThrow(
				/source receipt|revoked|cryptographically valid/,
			);

			const freshContext = createFixtureHostReceiptConsumerContext();
			const freshAuthority = createAuthority(storagePath, freshContext, createHost(freshContext, registry));
			const revokedEvidence = await promotionInput(freshContext, source, targetValue, {
				receiptId: "revoked-transfer-receipt",
			});
			await freshContext.revokeReceipt?.(revokedEvidence.transferEvidence[0]?.receipt.receiptId ?? "");
			await expect(freshAuthority.promote(revokedEvidence)).rejects.toThrow(
				/transfer evidence receipt|revoked|cryptographically valid/,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects dot and empty path segments in transfer artifacts", async () => {
		const root = await mkdtemp(join(tmpdir(), "scoped-knowledge-authority-paths-"));
		try {
			const storagePath = join(root, "scoped-knowledge.json");
			const receiptContext = createFixtureHostReceiptConsumerContext();
			const source = sourceRecord("workflow-paths", "goal-a");
			const authority = createAuthority(
				storagePath,
				receiptContext,
				createHost(receiptContext, sourceRegistry(source)),
			);
			for (const [suffix, relativePath] of [
				["dot", "evidence/./transfer"],
				["empty", "evidence//transfer"],
			] as const) {
				const input = await promotionInput(receiptContext, source, target("goal", "goal-a", "domain-a"), {
					receiptId: `path-${suffix}`,
				});
				const evidence = input.transferEvidence[0];
				if (evidence === undefined) throw new Error("fixture transfer evidence missing");
				const artifactRef = { ...evidence.artifactRefs[0], relativePath };
				const receipt = { ...evidence.receipt, artifactRef };
				const badEvidence = {
					...evidence,
					artifactRefs: [artifactRef],
					receipt,
				} as ScopedKnowledgeTransferEvidence;
				await expect(authority.promote({ ...input, transferEvidence: [badEvidence] })).rejects.toThrow(
					/relativePath/,
				);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("recomputes durable scoped IDs, contradiction keys, and content digests on reopen", async () => {
		for (const [field, expectedError] of [
			["scopedRecordId", /record id is not canonical/],
			["contradictionKey", /contradiction key is not canonical/],
			["contentDigest", /content or source digest is stale/],
		] as const) {
			const root = await mkdtemp(join(tmpdir(), `scoped-knowledge-authority-digest-${field}-`));
			try {
				const storagePath = join(root, "scoped-knowledge.json");
				const receiptContext = createFixtureHostReceiptConsumerContext();
				const source = sourceRecord(`workflow-digest-${field}`, "goal-a");
				const registry = sourceRegistry(source);
				const targetValue = target("goal", "goal-a", "domain-a");
				const authority = createAuthority(storagePath, receiptContext, createHost(receiptContext, registry));
				const promotion = await authority.promote(await promotionInput(receiptContext, source, targetValue));
				const recordId = promotion.record?.scopedRecordId;
				if (recordId === undefined) throw new Error("fixture promotion did not commit");
				await tamperStoredRecord(storagePath, field);
				const reopened = createAuthority(
					storagePath,
					receiptContext,
					createHost(receiptContext, registry, { workflowId: "workflow-b" }),
				);
				await expect(reopened.read()).rejects.toThrow(expectedError);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	});

	it("persists a never tombstone that blocks later promotion and survives reopen", async () => {
		const root = await mkdtemp(join(tmpdir(), "scoped-knowledge-authority-never-"));
		try {
			const storagePath = join(root, "scoped-knowledge.json");
			const receiptContext = createFixtureHostReceiptConsumerContext();
			const source = sourceRecord("workflow-never", "goal-a");
			const registry = sourceRegistry(source);
			const host = createHost(receiptContext, registry);
			const authority = createAuthority(storagePath, receiptContext, host);
			const neverTarget = target("never", null, null);
			const deny = await authority.promote(
				await promotionInput(receiptContext, source, neverTarget, { scope: "never", transferEvidence: [] }),
			);
			expect(deny.status).toBe("denied");
			expect(deny.tombstone?.reason).toBe("never");

			const blocked = await authority.promote(
				await promotionInput(receiptContext, source, target("goal", "goal-a", "domain-a")),
			);
			expect(blocked.status).toBe("denied");
			expect(blocked.tombstone?.reason).toBe("never");

			const reopened = createAuthority(
				storagePath,
				receiptContext,
				createHost(receiptContext, registry, { workflowId: "workflow-b" }),
			);
			expect((await reopened.read()).tombstones).toHaveProperty(deny.tombstone?.tombstoneId as string);
			await expect(
				reopened.recall({
					workflowId: "workflow-b",
					query: "fixture",
					requestedScope: "goal",
					target: target("goal", "goal-a", "domain-a"),
					policyRevision: "policy-1",
				}),
			).resolves.toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("replays exact-once after before/after commit crashes and retains a one-use witness", async () => {
		const root = await mkdtemp(join(tmpdir(), "scoped-knowledge-authority-crash-"));
		try {
			const storagePath = join(root, "scoped-knowledge.json");
			const receiptContext = createFixtureHostReceiptConsumerContext();
			const source = sourceRecord("workflow-crash", "goal-a");
			const registry = sourceRegistry(source);
			const targetValue = target("goal", "goal-a", "domain-a");
			const host = createHost(receiptContext, registry);
			const authority = createAuthority(storagePath, receiptContext, host);
			const beforeInput = await promotionInput(receiptContext, source, targetValue, {
				receiptId: "promotion-before",
			});
			const crashBefore: ScopedKnowledgeCrashHook = async (point) => {
				if (point === "before-commit") throw new Error("simulated before commit crash");
			};
			await expect(authority.promote({ ...beforeInput, crashHook: crashBefore })).rejects.toThrow(
				/before commit crash/,
			);
			const reopenedBefore = createAuthority(
				storagePath,
				receiptContext,
				createHost(receiptContext, registry, { workflowId: "workflow-b" }),
			);
			await expect(reopenedBefore.promote(beforeInput)).resolves.toMatchObject({ status: "committed" });

			const afterSource = sourceRecord("workflow-crash-after", "goal-a");
			const afterRegistry = sourceRegistry(afterSource);
			const afterTarget = target("goal", "goal-a", "domain-a");
			const afterInput = await promotionInput(receiptContext, afterSource, afterTarget, {
				receiptId: "promotion-after",
			});
			const crashAfter: ScopedKnowledgeCrashHook = async (point) => {
				if (point === "after-commit") throw new Error("simulated after commit crash");
			};
			const afterAuthority = createAuthority(
				storagePath,
				receiptContext,
				createHost(receiptContext, {
					...afterRegistry,
					records: new Map([...registry.records, ...afterRegistry.records]),
				}),
			);
			await expect(afterAuthority.promote({ ...afterInput, crashHook: crashAfter })).rejects.toThrow(
				/after commit crash/,
			);
			const reopenedAfter = createAuthority(
				storagePath,
				receiptContext,
				createHost(
					receiptContext,
					{ records: new Map([...registry.records, ...afterRegistry.records]), statuses: new Map() },
					{ workflowId: "workflow-b" },
				),
			);
			await expect(reopenedAfter.promote(afterInput)).resolves.toMatchObject({ status: "replayed" });
			await expect(
				receiptContext.receiptResolver.resolveConsumptionWitness({
					receiptId: "promotion-after",
					workflowId: "workflow-crash-after",
					expectedBindingDigest: afterInput.promotionReceipt?.bindingDigest ?? "",
				}),
			).resolves.toMatchObject({ receiptId: "promotion-after" });
			await expect(
				reopenedAfter.drainOutbox({ upsert: async () => undefined, delete: async () => undefined }),
			).resolves.toMatchObject({ status: "healthy" });
			await expect(reopenedAfter.promote(afterInput)).resolves.toMatchObject({ status: "replayed" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each(["retracted", "revoked", "quarantined"] as const)(
		"propagates source %s after reopen and keeps projection failure non-destructive",
		async (status) => {
			const root = await mkdtemp(join(tmpdir(), `scoped-knowledge-authority-${status}-`));
			try {
				const storagePath = join(root, "scoped-knowledge.json");
				const receiptContext = createFixtureHostReceiptConsumerContext();
				const source = sourceRecord(`workflow-${status}`, "goal-a");
				const registry = sourceRegistry(source);
				const targetValue = target("domain", null, "domain-a");
				const authority = createAuthority(storagePath, receiptContext, createHost(receiptContext, registry));
				const promotion = await authority.promote(await promotionInput(receiptContext, source, targetValue));
				const scopedRecordId = promotion.record?.scopedRecordId as string;
				registry.statuses.set(workflowIdOf(source), status);
				const reopened = createAuthority(
					storagePath,
					receiptContext,
					createHost(receiptContext, registry, { workflowId: "workflow-b" }),
				);
				await expect(
					reopened.recall({
						workflowId: "workflow-b",
						query: "fixture",
						requestedScope: "domain",
						target: targetValue,
						policyRevision: "policy-1",
					}),
				).resolves.toEqual([]);
				expect((await reopened.read()).records[scopedRecordId]?.status).toBe("retracted");
				const projection = {
					upsert: async () => undefined,
					delete: async () => {
						throw new Error("projection unavailable");
					},
				};
				await expect(reopened.drainOutbox(projection)).resolves.toMatchObject({ status: "degraded" });
				expect((await reopened.read()).records[scopedRecordId]?.status).toBe("retracted");
				const deletes: string[] = [];
				await expect(
					reopened.drainOutbox({
						upsert: async () => undefined,
						delete: async (id) => {
							deletes.push(id);
						},
					}),
				).resolves.toMatchObject({ status: "healthy" });
				expect(deletes).toContain(scopedRecordId);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("revalidates revoked source receipts after reopen and retracts the shared record", async () => {
		const root = await mkdtemp(join(tmpdir(), "scoped-knowledge-authority-receipt-revoked-"));
		try {
			const storagePath = join(root, "scoped-knowledge.json");
			const receiptContext = createFixtureHostReceiptConsumerContext();
			const source = sourceRecord("workflow-receipt-revoked", "goal-a");
			const registry = sourceRegistry(source);
			const targetValue = target("goal", "goal-a", "domain-a");
			const authority = createAuthority(storagePath, receiptContext, createHost(receiptContext, registry));
			const promotion = await authority.promote(await promotionInput(receiptContext, source, targetValue));
			await receiptContext.revokeReceipt?.(source.privacy.secretScan.receiptId);
			const reopened = createAuthority(
				storagePath,
				receiptContext,
				createHost(receiptContext, registry, { workflowId: "workflow-b" }),
			);
			await expect(
				reopened.recall({
					workflowId: "workflow-b",
					query: "fixture",
					requestedScope: "goal",
					target: targetValue,
					policyRevision: "policy-1",
				}),
			).resolves.toEqual([]);
			expect((await reopened.read()).records[promotion.record?.scopedRecordId as string]?.tombstone?.reason).toBe(
				"source-revoked",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects foreign authority scope, raw holdout data, and retains contradictory records", async () => {
		const root = await mkdtemp(join(tmpdir(), "scoped-knowledge-authority-boundary-"));
		try {
			const storagePath = join(root, "scoped-knowledge.json");
			const receiptContext = createFixtureHostReceiptConsumerContext();
			const first = sourceRecord(
				"workflow-contradiction-a",
				"goal-a",
				"contradiction",
				"Use the first fixture path.",
			);
			const second = sourceRecord(
				"workflow-contradiction-b",
				"goal-a",
				"contradiction",
				"Use the second fixture path.",
			);
			const registry = sourceRegistry(first, second);
			const authority = createAuthority(storagePath, receiptContext, createHost(receiptContext, registry));
			const foreign = target("goal", "goal-a", "domain-a", "trust-foreign", "tenant-local");
			await expect(
				authority.promote(await promotionInput(receiptContext, first, foreign, { receiptId: "foreign-promotion" })),
			).rejects.toThrow(/outside the authenticated host/);

			const validInput = await promotionInput(receiptContext, first, target("goal", "goal-a", "domain-a"));
			const badEvidence = {
				...validInput.transferEvidence[0],
				holdoutRows: [{ row: "raw evaluation case" }],
				secretToken: "password=leaked",
			} as unknown as ScopedKnowledgeTransferEvidence;
			await expect(authority.promote({ ...validInput, transferEvidence: [badEvidence] })).rejects.toThrow(
				/raw holdout|Secret material/,
			);

			await expect(authority.promote(validInput)).resolves.toMatchObject({ status: "committed" });
			await expect(
				authority.promote(
					await promotionInput(receiptContext, second, target("goal", "goal-a", "domain-a"), {
						receiptId: "contradiction-second",
					}),
				),
			).resolves.toMatchObject({ status: "committed" });
			const recalled = await authority.recall({
				workflowId: "workflow-b",
				query: "fixture",
				requestedScope: "goal",
				target: target("goal", "goal-a", "domain-a"),
				policyRevision: "policy-1",
			});
			expect(recalled.filter((record) => record.source === "scoped")).toHaveLength(2);
			expect(recalled.map((record) => record.statement)).toEqual(
				expect.arrayContaining([first.statement, second.statement]),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

function createAuthority(
	storagePath: string,
	receiptContext: ReturnType<typeof createFixtureHostReceiptConsumerContext>,
	host: ScopedKnowledgeHostBoundary,
): ScopedKnowledgeAuthority {
	Object.freeze(receiptContext.receiptResolver);
	Object.freeze(receiptContext.keyResolver);
	Object.freeze(receiptContext.artifactResolver);
	Object.freeze(receiptContext.principalAuthorizer);
	Object.freeze(receiptContext);
	return createScopedKnowledgeAuthority({
		storage: createFileScopedKnowledgeStorage({ filePath: storagePath, trustDomainId: "trust-local" }),
		host: { ...host, receiptContext },
	});
}

function target(
	scope: ScopedKnowledgeScope,
	goalId: string | null,
	domainId: string | null,
	trustDomainId = "trust-local",
	tenantId = "tenant-local",
): ScopedKnowledgeTarget {
	return {
		scope,
		trustDomainId,
		tenantId,
		namespace: `${scope}:${scope === "goal" ? goalId : scope === "domain" ? domainId : "shared"}`,
		goalId,
		domainId,
		workspaceId: null,
		userId: null,
	};
}

interface SourceRegistry {
	records: Map<string, KnowledgeRecord>;
	statuses: Map<string, Lifecycle>;
	resolveError?: Error;
}

function sourceRegistry(...records: KnowledgeRecord[]): SourceRegistry {
	return {
		records: new Map(records.map((record) => [workflowIdOf(record), record])),
		statuses: new Map(),
	};
}

interface HostOptions {
	workflowId?: string;
	allowGlobalApproval?: boolean;
	canPromote?: boolean;
	authorizationWorkflowId?: string;
	authorizationGoalId?: string | null;
}

function createHost(
	receiptContext: ReturnType<typeof createFixtureHostReceiptConsumerContext>,
	registry: SourceRegistry,
	options: HostOptions = {},
): ScopedKnowledgeHostBoundary {
	return {
		trustDomainId: "trust-local",
		tenantId: "tenant-local",
		receiptContext,
		artifactResolver: receiptContext.artifactResolver,
		trustedNow: () => NOW,
		currentPolicyRevision: () => "policy-1",
		resolveTarget: async ({ requestedScope, requested, sourceWorkflowId }) => {
			if (requested.trustDomainId !== "trust-local" || requested.tenantId !== "tenant-local")
				throw new Error("foreign host target");
			if (requestedScope === "never")
				return { ...target("never", null, null), namespace: `never:${sourceWorkflowId}` };
			return requested;
		},
		admitLearningScope: async (input) => ({
			requestedScope: input.requestedScope,
			effectiveScope: input.requestedScope,
			canPromote: options.canPromote ?? true,
			policyRevision: "policy-1",
			transferEvidenceDigest: digestObject(input.transferEvidence),
			decisionDigest: digestObject({ scope: input.requestedScope, policyRevision: "policy-1" }),
			executionIdentity: "host-execution",
			sessionId: "host-session",
		}),
		resolveSource: async ({ binding }) => {
			if (registry.resolveError !== undefined) throw registry.resolveError;
			const source = registry.records.get(binding.sourceWorkflowId);
			if (source === undefined) return { status: "quarantined", record: null };
			const status = registry.statuses.get(binding.sourceWorkflowId) ?? "active";
			return { status, record: status === "active" ? source : null };
		},
		readWorkflowKnowledge: async ({ workflowId: requestedWorkflowId }) => {
			const source = registry.records.get(requestedWorkflowId);
			return source !== undefined && (registry.statuses.get(requestedWorkflowId) ?? "active") === "active"
				? [source]
				: [];
		},
		authorizeRecall: async ({ workflowId: requestedWorkflowId, requested }) => ({
			...requested,
			workflowId: options.authorizationWorkflowId ?? requestedWorkflowId,
			...(options.authorizationGoalId === undefined ? {} : { goalId: options.authorizationGoalId }),
			policyRevision: "policy-1",
			authorizationDigest: digestObject({ workflowId: requestedWorkflowId, requested }),
		}),
		verifyGlobalApproval: async () => {
			if (options.allowGlobalApproval === false) throw new Error("global approval rejected by host policy");
		},
	};
}

async function promotionInput(
	receiptContext: ReturnType<typeof createFixtureHostReceiptConsumerContext>,
	source: KnowledgeRecord,
	targetValue: ScopedKnowledgeTarget,
	options: {
		scope?: ScopedKnowledgeScope;
		transferEvidence?: readonly ScopedKnowledgeTransferEvidence[];
		globalApproval?: ScopedKnowledgeGlobalApproval;
		receiptId?: string;
		evidenceId?: string;
		crashHook?: ScopedKnowledgeCrashHook;
	} = {},
): Promise<ScopedKnowledgePromotionInput> {
	const binding = sourceBinding(source);
	const scope = options.scope ?? targetValue.scope;
	const transferEvidence =
		options.transferEvidence ??
		(scope === "never"
			? []
			: [
					await independentEvidence(
						receiptContext,
						source,
						options.evidenceId ?? `${scope}-${source.recordId}-${options.receiptId ?? "default"}`,
						scope === "goal" ? "goal-transfer" : scope === "domain" ? "domain-transfer" : "global-transfer",
					),
				]);
	const approvalDigest = options.globalApproval === undefined ? null : digestObject(options.globalApproval);
	const promotionReceipt =
		scope === "never"
			? undefined
			: (() => {
					const digests = scopedKnowledgePromotionAuthorizationDigests({
						scope,
						target: targetValue,
						source: binding,
						sourceContentDigest: source.contentDigest,
						transferEvidenceDigest: digestObject(transferEvidence),
						policyRevision: "policy-1",
						approvalDigest,
						executionIdentity: "host-execution",
						sessionId: "host-session",
					});
					return createFixtureHostReceipt({
						receiptKind: "capability",
						receiptId: options.receiptId ?? `promotion-${scope}-${source.recordId}`,
						issuerId: "fixture-host",
						workflowId: binding.sourceWorkflowId,
						bindingDigest: digests.bindingDigest,
						payloadDigest: digestObject({ kind: "scoped-knowledge-promotion", source: source.contentDigest }),
						artifactRef: binding.sourceReceipt.artifactRef,
						issuedAt: NOW,
						validUntil: LATER,
						keyId: "fixture-receipt-key",
						stateDigest: binding.sourceReceipt.stateDigest,
						revision: binding.sourceReceipt.revision,
						capabilityBinding: {
							capability: "workflow_learning_knowledge_promotion",
							resourceDigest: digests.resourceDigest,
							operationDigest: digests.operationDigest,
							executionIdentity: "host-execution",
							sessionId: "host-session",
						},
					});
				})();
	return {
		source: { record: source, binding },
		requestedScope: scope,
		target: targetValue,
		transferEvidence,
		policyRevision: "policy-1",
		...(promotionReceipt === undefined ? {} : { promotionReceipt }),
		...(options.globalApproval === undefined ? {} : { globalApproval: options.globalApproval }),
		...(options.crashHook === undefined ? {} : { crashHook: options.crashHook }),
	};
}

async function independentEvidence(
	receiptContext: ReturnType<typeof createFixtureHostReceiptConsumerContext>,
	source: KnowledgeRecord,
	evidenceId: string,
	kind: ScopedKnowledgeTransferEvidence["kind"],
): Promise<ScopedKnowledgeTransferEvidence> {
	const workflowId = workflowIdOf(source);
	const receipt = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: `transfer-receipt-${workflowId}-${evidenceId}`,
		issuerId: "fixture-host",
		workflowId,
		bindingDigest: digestObject({ kind: "transfer-binding", evidenceId }),
		payloadDigest: digestObject({ kind: "transfer-payload", evidenceId }),
		artifactRef: {
			artifactId: `transfer-artifact-${workflowId}-${evidenceId}`,
			relativePath: `evidence/transfer/${workflowId}/${evidenceId}`,
			digest: "placeholder",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		issuedAt: NOW,
		validUntil: LATER,
		keyId: "fixture-receipt-key",
		stateDigest: "transfer-state",
		revision: 1,
		oneUse: true,
	});
	await receiptContext.receiptResolver.consumeIfOneUse({
		receipt,
		workflowId,
		expectedBindingDigest: receipt.bindingDigest,
		currentRevision: receipt.revision,
	});
	const witnessValue = witness(receipt, workflowId);
	return {
		evidenceId,
		kind,
		artifactRefs: [receipt.artifactRef],
		receipt,
		witness: witnessValue,
		evidenceDigest: scopedKnowledgeTransferEvidenceDigest({
			evidenceId,
			kind,
			artifactRefs: [receipt.artifactRef],
			receipt,
			witness: witnessValue,
			independence: "independent",
		}),
		independence: "independent",
	};
}

async function globalApproval(
	receiptContext: ReturnType<typeof createFixtureHostReceiptConsumerContext>,
	source: KnowledgeRecord,
): Promise<ScopedKnowledgeGlobalApproval> {
	const workflowId = workflowIdOf(source);
	const principal: WorkflowTrustedPrincipal = {
		kind: "interactive_ui",
		principalId: "user-local",
		credentialDigest: digestObject({ workflowId }),
	};
	const receipt = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: `global-approval-${workflowId}`,
		issuerId: "fixture-host",
		workflowId,
		bindingDigest: digestObject({ kind: "global-approval-binding", workflowId }),
		payloadDigest: digestObject({ kind: "global-approval-payload", workflowId }),
		artifactRef: {
			artifactId: `global-approval-artifact-${workflowId}`,
			relativePath: `approvals/global/${workflowId}`,
			digest: "placeholder",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		issuedAt: NOW,
		validUntil: LATER,
		keyId: "fixture-receipt-key",
		stateDigest: "global-approval-state",
		revision: 1,
		oneUse: true,
	});
	await receiptContext.receiptResolver.consumeIfOneUse({
		receipt,
		workflowId,
		expectedBindingDigest: receipt.bindingDigest,
		currentRevision: receipt.revision,
	});
	return {
		approvalId: `approval-${workflowId}`,
		policyRevision: "policy-1",
		principal,
		receipt,
		witness: witness(receipt, workflowId),
		signedApprovalDigest: scopedKnowledgeGlobalApprovalDigest({
			approvalId: `approval-${workflowId}`,
			policyRevision: "policy-1",
			principal,
		}),
	};
}

function sourceBinding(record: KnowledgeRecord): ScopedKnowledgeSourceBinding {
	const receipt = record.privacy.secretScan;
	const workflowId = workflowIdOf(record);
	const head: WorkflowJournalHead = {
		workflowId,
		sequence: record.commitRef.knowledgeJournalSequence,
		eventDigest: record.commitRef.knowledgeJournalDigest,
		epochRef: EPOCH,
	};
	if (head.eventDigest === null) throw new Error("fixture source head has no event digest");
	return {
		sourceWorkflowId: workflowId,
		sourceHead: head,
		sourceEpochRef: EPOCH,
		sourceEventSequence: head.sequence,
		sourceEventDigest: head.eventDigest,
		sourceArtifactRefs: record.evidenceRefs.flatMap((ref) => ref.artifactRefs),
		sourceReceipt: receipt,
		sourceWitness: witness(receipt, workflowId),
	};
}

function witness(receipt: WorkflowVerifiedHostReceipt, workflowId: string): WorkflowLearningHostWitness {
	return {
		witnessId: `witness-${receipt.receiptId}`,
		witnessKind: "receipt",
		workflowId,
		stage: "source",
		candidateId: null,
		evidenceRef: receipt.artifactRef,
		payloadDigest: receipt.bindingDigest,
		bytesDigest: receipt.artifactRef.digest,
		bytesSize: receipt.artifactRef.sizeBytes,
		revision: receipt.revision,
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		stateHeadDigest: receipt.stateDigest,
		trustedNow: NOW,
		oneUse: receipt.oneUse,
	};
}

function workflowIdOf(record: KnowledgeRecord): string {
	const workflowId = record.evidenceRefs[0]?.workflowId;
	if (workflowId === undefined) throw new Error("fixture record has no source workflow");
	return workflowId;
}

async function tamperStoredRecord(filePath: string, field: string): Promise<void> {
	const envelope = parseCanonicalJsonBytes(await readFile(filePath)) as unknown as Record<string, unknown>;
	const state = envelope.state as Record<string, unknown>;
	const records = state.records as Record<string, Record<string, unknown>>;
	const record = Object.values(records)[0];
	if (record === undefined) throw new Error("fixture stored record is missing");
	record[field] = digestObject({ tampered: field });
	const { digest: _digest, ...withoutDigest } = state;
	state.digest = digestObject(withoutDigest);
	await writeFile(filePath, canonicalJsonBytes(envelope), { mode: 0o600 });
}

function sourceRecord(
	workflowId: string,
	goalId: string,
	variant = workflowId,
	statement = "Use the fixture workflow to verify the transfer.",
): KnowledgeRecord {
	const artifactRef = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: `source-receipt-${workflowId}-${variant}`,
		issuerId: "fixture-host",
		workflowId,
		bindingDigest: digestObject({ kind: "source-binding", workflowId, variant }),
		payloadDigest: digestObject({ kind: "source-payload", workflowId, variant }),
		artifactRef: {
			artifactId: `source-artifact-${workflowId}-${variant}`,
			relativePath: `evidence/source/${workflowId}/${variant}`,
			digest: "placeholder",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		issuedAt: NOW,
		validUntil: LATER,
		keyId: "fixture-receipt-key",
		stateDigest: "source-state",
		revision: 1,
	}).artifactRef;
	const sourceReceipt = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: `source-evidence-${workflowId}-${variant}`,
		issuerId: "fixture-host",
		workflowId,
		bindingDigest: digestObject({ kind: "source-evidence-binding", workflowId, variant }),
		payloadDigest: digestObject({ kind: "source-evidence-payload", workflowId, variant }),
		artifactRef,
		issuedAt: NOW,
		validUntil: LATER,
		keyId: "fixture-receipt-key",
		stateDigest: "source-state",
		revision: 1,
	});
	const evidenceRef = {
		workflowId,
		envelopeId: `source-envelope-${workflowId}-${variant}`,
		envelopeDigest: digestObject({ workflowId, variant, kind: "source-envelope" }),
		evidenceRevision: 1,
		artifactRefs: [artifactRef],
		validationReceipt: sourceReceipt,
	};
	const proposal = {
		proposalId: `source-proposal-${workflowId}-${variant}`,
		recordId: `source-record-${variant}`,
		kind: "how" as const,
		title: "Fixture lesson",
		statement,
		provenance: { source: "host" as const, producerId: "fixture-host" },
		applicability: {
			namespace: `workflow-local:${goalId}`,
			scope: "workspace" as const,
			workspaceId: "workspace-local",
		},
		privacy: { class: "public" as const, secretScan: sourceReceipt },
		retention: { class: "indefinite" as const },
		confidence: "audited" as const,
		decisionRef: {
			decisionScope: { kind: "knowledge" as const, namespace: `workflow-local:${goalId}` },
			decisionId: `source-decision-${workflowId}-${variant}`,
			revision: 1,
			storeEpoch: EPOCH.storeEpoch,
			decisionDigest: digestObject({ workflowId, variant, kind: "source-decision" }),
		},
		evidenceRefs: [evidenceRef],
		epochRef: EPOCH,
		action: "create" as const,
		expectedRevision: null,
		rollbackRevision: null,
	};
	return {
		...proposal,
		revision: 1,
		status: "active" as const,
		contentDigest: digestObject({
			applicability: proposal.applicability,
			kind: proposal.kind,
			privacy: proposal.privacy,
			procedure: null,
			recordId: proposal.recordId,
			retention: proposal.retention,
			statement: proposal.statement,
			title: proposal.title,
		}),
		sourceDigest: digestObject(proposal.evidenceRefs),
		commitRef: {
			knowledgeStoreId: `store-${workflowId}`,
			workflowEpochRef: EPOCH,
			knowledgeStoreEpoch: EPOCH.storeEpoch,
			proposalId: proposal.proposalId,
			decisionRef: proposal.decisionRef,
			knowledgeJournalSequence: 1,
			knowledgeJournalDigest: digestObject({ workflowId, variant, kind: "source-event" }),
			transactionDigest: digestObject({ workflowId, variant, kind: "source-transaction" }),
		},
		createdAt: NOW,
		updatedAt: NOW,
	};
}
