import { describe, expect, it } from "vitest";
import {
	assertSupportedWorkflowConfigSchemaVersion,
	createWorkflowConfigService,
	resolveWorkflowRuntimeConfig,
	SUPPORTED_WORKFLOW_CONFIG_SCHEMA_VERSIONS,
	validateWorkflowConfigSchemaVersion,
} from "../src/core/workflow/config.js";
import type { WorkflowArtifactRef, WorkflowDecisionRef } from "../src/core/workflow/contracts.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	sha256Hex,
} from "../src/core/workflow/contracts.js";
import {
	migrateWorkflowSettings,
	type WorkflowSettingsMigrationRecord,
	type WorkflowSettingsMigrationStore,
} from "../src/core/workflow/migrations.js";
import type { WorkflowProfileApprovalReceipt } from "../src/core/workflow/profile.js";
import { resolveWorkflowProfile } from "../src/core/workflow/profile.js";

const epoch = { storeEpoch: 1, coordinatorEpoch: 1 } as const;

function refFor(bytes: Uint8Array): WorkflowArtifactRef {
	return {
		artifactId: "closure",
		relativePath: "config/closure.json",
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence: 1,
	};
}

function configInput(profile: "unresolved" | "inline" | "parallel" = "unresolved") {
	const members = ["runtime", "policy", "skills"];
	const bytes = canonicalJsonBytes(members);
	return {
		configSchemaVersion: 1,
		configRevision: 1,
		closureMembers: members,
		executionProfile: profile,
		runtimeIdentityDigest: "runtime",
		repositoryPolicyDigest: "repository",
		workspaceIdentityDigest: "workspace",
		globalSettingsDigest: "global",
		projectSettingsDigest: "project",
		packageDefaultsDigest: "defaults",
		methodologyManifestDigests: ["methodology"],
		nativeMethodologyContractDigest: "native",
		skillContentDigests: ["skill"],
		skillDependencyDigests: ["dependency"],
		evaluatorDigests: ["evaluator"],
		parserDigests: ["parser"],
		guardDigests: ["guard"],
		scorecardRuleDigest: "scorecard",
		resourceInventoryDigest: "inventory",
		resourceEnvelopePolicyDigest: "resource-policy",
		egressPolicyDigest: "egress",
		authorityPolicyDigest: "authority",
		approvalPolicyDigest: "approval",
		provenanceManifestDigest: "provenance",
		daemonCapabilityDigest: "daemon",
		decisionLimitsDigest: "limits",
		schedulerPolicyDigest: "scheduler",
		journalFormatDigest: "journal",
		closureManifestRef: refFor(bytes),
		closureManifestBytes: bytes,
	};
}

function decisionRef(): WorkflowDecisionRef {
	return {
		decisionScope: { kind: "workflow", workflowId: "wf-1", rootSessionId: "session-1" },
		decisionId: "profile-decision",
		revision: 1,
		storeEpoch: epoch.storeEpoch,
		coordinatorEpoch: epoch.coordinatorEpoch,
		decisionDigest: "decision-digest",
	};
}

describe("workflow configuration and profile", () => {
	it.each([0, 3, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects unsupported config schema %s before snapshot parsing",
		(version) => {
			const malformed = {
				...configInput(),
				configSchemaVersion: version,
				closureManifestBytes: new Uint8Array([0xff]),
			};
			const result = validateWorkflowConfigSchemaVersion(version);
			expect(result).toMatchObject({
				accepted: false,
				code: "recipe_config_schema_unsupported",
				configSchemaVersion: version,
				failureDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			});
			expect(validateWorkflowConfigSchemaVersion(version)).toEqual(result);
			let thrown: unknown;
			try {
				assertSupportedWorkflowConfigSchemaVersion(version);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect((thrown as Error).message).toContain(String(version));
			expect((thrown as Error).message).toMatch(/unsupported|supported versions/i);
			expect(() => resolveWorkflowRuntimeConfig(malformed)).toThrow(/schema/i);
		},
	);

	it("accepts exactly the supported safe integer config schemas", () => {
		expect(SUPPORTED_WORKFLOW_CONFIG_SCHEMA_VERSIONS).toEqual([1, 2]);
		for (const version of SUPPORTED_WORKFLOW_CONFIG_SCHEMA_VERSIONS) {
			expect(validateWorkflowConfigSchemaVersion(version)).toEqual({ accepted: true, configSchemaVersion: version });
			expect(() => assertSupportedWorkflowConfigSchemaVersion(version)).not.toThrow();
		}
	});

	it.each([1, 2])("preserves the frozen runtime-config snapshot contract for schema %s", (version) => {
		const snapshot = resolveWorkflowRuntimeConfig({ ...configInput(), configSchemaVersion: version });
		expect(snapshot).toMatchObject({ configSchemaVersion: version, resolvedConfigDigest: expect.any(String) });
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(snapshot).not.toHaveProperty("recipe");
	});

	it("pins an immutable closure digest and rejects changed closure bytes", () => {
		const input = configInput();
		const snapshot = resolveWorkflowRuntimeConfig(input);
		expect(snapshot.closureManifestDigest).toBe(digestObject(input.closureMembers));
		expect(snapshot.resolvedConfigDigest).toMatch(/^[0-9a-f]{64}$/);
		const exposedBytes = snapshot.closureManifestBytes as unknown as Uint8Array;
		exposedBytes[0] = exposedBytes[0] === 0 ? 1 : 0;
		expect(sha256Hex(snapshot.closureManifestBytes)).toBe(input.closureManifestRef.digest);
		const changed = { ...input, closureMembers: ["runtime", "policy", "changed"] };
		expect(() => resolveWorkflowRuntimeConfig(changed)).toThrow(/closure/i);
	});

	it("rejects empty members in every configuration digest array", () => {
		const digestArrays = [
			"methodologyManifestDigests",
			"skillContentDigests",
			"skillDependencyDigests",
			"evaluatorDigests",
			"parserDigests",
			"guardDigests",
		] as const;
		for (const key of digestArrays) {
			const malformed = { ...configInput(), [key]: [""] } as ReturnType<typeof configInput>;
			expect(() => resolveWorkflowRuntimeConfig(malformed)).toThrow(/digest|empty/i);
		}
	});

	it("keeps an unapproved requested profile unresolved and binds the approved profile receipt", async () => {
		const base = {
			workflowId: "wf-1",
			requestedProfile: "parallel" as const,
			maxWorkers: 2,
			readyIndependentTaskCount: 2,
			capacity: { processSlots: 2, unknownPoolIds: [] },
			expectedEpoch: epoch,
			receiptContext: createFixtureHostReceiptConsumerContext(),
			currentStateDigest: "state",
			currentRevision: 1,
		};
		const unresolved = await resolveWorkflowProfile({ ...base, approvalReceipt: null });
		expect(unresolved.resolved).toBe("unresolved");
		const receiptDecision = decisionRef();
		const receipt = {
			...createFixtureHostReceipt({
				receiptKind: "decision",
				receiptId: "profile-receipt",
				issuerId: "host",
				workflowId: "wf-1",
				bindingDigest: digestObject({
					workflowId: "wf-1",
					requestedProfile: base.requestedProfile,
					maxWorkers: base.maxWorkers,
					readyIndependentTaskCount: base.readyIndependentTaskCount,
					capacity: base.capacity,
					decisionRef: receiptDecision,
					epochRef: epoch,
					currentRevision: base.currentRevision,
				}),
				payloadDigest: "payload",
				artifactRef: {
					artifactId: "receipt",
					relativePath: "receipt",
					digest: "receipt",
					sizeBytes: 1,
					sourceEventSequence: 1,
				},
				issuedAt: "2026-08-15T00:00:00.000Z",
				validUntil: "2026-08-15T00:05:00.000Z",
				keyId: "key",
				stateDigest: "state",
			}),
			decisionRef: receiptDecision,
			epochRef: epoch,
		};
		const approved = await resolveWorkflowProfile({
			...base,
			approvalReceipt: receipt as WorkflowProfileApprovalReceipt,
		});
		expect(approved.resolved).toBe("parallel");
		expect(approved.approvalDecisionRef).toEqual(receipt.decisionRef);
		await expect(
			resolveWorkflowProfile({ ...base, maxWorkers: 1, approvalReceipt: receipt as WorkflowProfileApprovalReceipt }),
		).rejects.toThrow(/binding|profile|receipt/i);
	});

	it("resumes an applied migration from its persisted next version without replaying prior steps", async () => {
		const backupManifestRef: WorkflowArtifactRef = {
			artifactId: "settings-backup:partial-migration",
			relativePath: "settings/backups/partial-migration",
			digest: "backup-digest",
			sizeBytes: 1,
			sourceEventSequence: 0,
		};
		const partialWithoutDigest = {
			migrationId: "partial-migration",
			migrationIdDigest: sha256Hex(new TextEncoder().encode("partial-migration")),
			fromVersion: 0,
			targetVersion: 2,
			nextVersion: 1,
			values: { unrelated: "preserved", count: 2 },
			status: "applied" as const,
			priorDigest: "prior-digest",
			backupManifestRef,
			backupManifestDigest: backupManifestRef.digest,
			fsyncDigest: "flush-proof",
		};
		const partialRecord: WorkflowSettingsMigrationRecord = {
			...partialWithoutDigest,
			recordDigest: digestObject({ ...partialWithoutDigest, recordDigest: "" }),
		};
		const calls: string[] = [];
		const result = await migrateWorkflowSettings(
			{ schemaVersion: 0, unrelated: "preserved", count: 1 },
			0,
			2,
			[
				{
					fromVersion: 0,
					toVersion: 1,
					stepId: "one",
					apply: () => {
						calls.push("one");
						return { count: 999 };
					},
				},
				{
					fromVersion: 1,
					toVersion: 2,
					stepId: "two",
					apply: (values) => {
						calls.push("two");
						return { ...values, migrated: true };
					},
				},
			],
			migrationStore(partialRecord),
			"partial-migration",
		);
		expect(calls).toEqual(["two"]);
		expect(result).toEqual({ schemaVersion: 2, values: { unrelated: "preserved", count: 2, migrated: true } });
	});

	it("resumes a recovered partial migration instead of returning an unverified target schema", async () => {
		const backupManifestRef: WorkflowArtifactRef = {
			artifactId: "settings-backup:recovered-migration",
			relativePath: "settings/backups/recovered-migration",
			digest: "backup-digest",
			sizeBytes: 1,
			sourceEventSequence: 0,
		};
		const partialWithoutDigest = {
			migrationId: "recovered-migration",
			migrationIdDigest: sha256Hex(new TextEncoder().encode("recovered-migration")),
			fromVersion: 0,
			targetVersion: 2,
			nextVersion: 1,
			values: { unrelated: "preserved", count: 2 },
			status: "recovered" as const,
			priorDigest: "prior-digest",
			backupManifestRef,
			backupManifestDigest: backupManifestRef.digest,
			fsyncDigest: "flush-proof",
		};
		const partialRecord: WorkflowSettingsMigrationRecord = {
			...partialWithoutDigest,
			recordDigest: digestObject({ ...partialWithoutDigest, recordDigest: "" }),
		};
		const calls: string[] = [];
		const result = await migrateWorkflowSettings(
			{ schemaVersion: 0, unrelated: "preserved", count: 1 },
			0,
			2,
			[
				{
					fromVersion: 0,
					toVersion: 1,
					stepId: "one",
					apply: () => {
						calls.push("one");
						return { count: 999 };
					},
				},
				{
					fromVersion: 1,
					toVersion: 2,
					stepId: "two",
					apply: (values) => {
						calls.push("two");
						return { ...values, migrated: true };
					},
				},
			],
			migrationStore(partialRecord),
			"recovered-migration",
		);
		expect(calls).toEqual(["two"]);
		expect(result).toEqual({ schemaVersion: 2, values: { unrelated: "preserved", count: 2, migrated: true } });
	});

	it("rejects a verified migration record that has not reached the target version", async () => {
		const backupManifestRef: WorkflowArtifactRef = {
			artifactId: "settings-backup:verified-partial-migration",
			relativePath: "settings/backups/verified-partial-migration",
			digest: "backup-digest",
			sizeBytes: 1,
			sourceEventSequence: 0,
		};
		const partialWithoutDigest = {
			migrationId: "verified-partial-migration",
			migrationIdDigest: sha256Hex(new TextEncoder().encode("verified-partial-migration")),
			fromVersion: 0,
			targetVersion: 2,
			nextVersion: 1,
			values: { unrelated: "preserved", count: 2 },
			status: "verified" as const,
			priorDigest: "prior-digest",
			backupManifestRef,
			backupManifestDigest: backupManifestRef.digest,
			fsyncDigest: "flush-proof",
		};
		const partialRecord: WorkflowSettingsMigrationRecord = {
			...partialWithoutDigest,
			recordDigest: digestObject({ ...partialWithoutDigest, recordDigest: "" }),
		};
		await expect(
			migrateWorkflowSettings(
				{ schemaVersion: 0, unrelated: "preserved", count: 1 },
				0,
				2,
				[
					{ fromVersion: 0, toVersion: 1, stepId: "one", apply: (values) => values },
					{ fromVersion: 1, toVersion: 2, stepId: "two", apply: (values) => values },
				],
				migrationStore(partialRecord),
				"verified-partial-migration",
			),
		).rejects.toThrow(/verified|target|migration|record/i);
	});
});

function migrationStore(initial: WorkflowSettingsMigrationRecord | null = null): WorkflowSettingsMigrationStore {
	let record = initial;
	return {
		read: async () => record,
		compareAndSwap: async ({ expectedDigest, next }) => {
			if ((record?.recordDigest ?? null) !== expectedDigest) throw new Error("stale migration CAS");
			record = next;
			return record;
		},
		backup: async ({ expectedDigest, fsyncDigest }) => {
			if (record?.recordDigest !== expectedDigest || fsyncDigest.length === 0)
				throw new Error("backup not prepared");
			const next = { ...record, status: "applied" as const, recordDigest: "" };
			record = { ...next, recordDigest: digestObject(next) };
			return record;
		},
		apply: async ({ expectedDigest, next }) => {
			if (record?.recordDigest !== expectedDigest) throw new Error("stale apply CAS");
			record = next;
			return record;
		},
		verify: async ({ expectedDigest, expectedValuesDigest }) => {
			if (record?.recordDigest !== expectedDigest || digestObject(record.values) !== expectedValuesDigest)
				throw new Error("verify mismatch");
			const next = { ...record, status: "verified" as const, recordDigest: "" };
			record = { ...next, recordDigest: digestObject(next) };
			return record;
		},
		recover: async ({ expectedDigest }) => {
			if (record?.recordDigest !== expectedDigest) throw new Error("stale recovery CAS");
			const next = { ...record, status: "recovered" as const, recordDigest: "" };
			record = { ...next, recordDigest: digestObject(next) };
			return record;
		},
		flush: async ({ expectedDigest }) => {
			if (record?.recordDigest !== expectedDigest) throw new Error("flush before prepare");
			return { fileSync: true as const, parentDirectorySync: true as const, flushDigest: "flush-proof" };
		},
	};
}

describe("workflow settings migration", () => {
	it("runs ordered migrations through the injected adapter and leaves a verified record", async () => {
		const result = await migrateWorkflowSettings(
			{ schemaVersion: 0, unrelated: "preserved", count: 1 },
			0,
			2,
			[
				{
					fromVersion: 0,
					toVersion: 1,
					stepId: "one",
					apply: (values) => ({ ...values, count: Number(values.count) + 1 }),
				},
				{ fromVersion: 1, toVersion: 2, stepId: "two", apply: (values) => ({ ...values, migrated: true }) },
			],
			migrationStore(),
			"migration-1",
		);
		expect(result).toEqual({ schemaVersion: 2, values: { unrelated: "preserved", count: 2, migrated: true } });
	});

	it("rejects newer schemas before invoking migration steps", async () => {
		let called = false;
		await expect(
			migrateWorkflowSettings(
				{ schemaVersion: 3 },
				0,
				2,
				[
					{
						fromVersion: 0,
						toVersion: 1,
						stepId: "one",
						apply: (values) => {
							called = true;
							return values;
						},
					},
					{ fromVersion: 1, toVersion: 2, stepId: "two", apply: (values) => values },
				],
				migrationStore(),
				"migration-2",
			),
		).rejects.toThrow(/newer|schema/i);
		expect(called).toBe(false);
	});

	it("recovers a prepared transaction when a step fails", async () => {
		const store = migrationStore();
		await expect(
			migrateWorkflowSettings(
				{ schemaVersion: 0, value: "before" },
				0,
				1,
				[
					{
						fromVersion: 0,
						toVersion: 1,
						stepId: "fail",
						apply: () => {
							throw new Error("step failed");
						},
					},
				],
				store,
				"migration-3",
			),
		).rejects.toThrow("step failed");
	});
});

describe("workflow config transaction", () => {
	it("requires prepare/apply/verify and invokes recovery after an injected failure", async () => {
		const calls: string[] = [];
		const service = createWorkflowConfigService({
			input: configInput(),
			adapter: {
				prepare: async () => {
					calls.push("prepare");
				},
				apply: async () => {
					calls.push("apply");
					throw new Error("apply failed");
				},
				verify: async () => {
					calls.push("verify");
				},
				recover: async () => {
					calls.push("recover");
				},
			},
		});
		const transaction = await service.prepare("unresolved");
		expect(transaction.state).toBe("prepared");
		await expect(transaction.apply()).rejects.toThrow("apply failed");
		await transaction.recover();
		expect(calls).toEqual(["prepare", "apply", "recover"]);
	});
});
