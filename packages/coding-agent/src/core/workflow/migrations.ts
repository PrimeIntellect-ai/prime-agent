import type { WorkflowArtifactRef } from "./contracts.js";
import { canonicalJsonBytes, digestObject, sha256Hex } from "./contracts.js";

export type WorkflowSettingsValue =
	| string
	| number
	| boolean
	| null
	| readonly WorkflowSettingsValue[]
	| { readonly [key: string]: WorkflowSettingsValue };

export interface WorkflowSettings {
	schemaVersion: number;
	values: Readonly<Record<string, WorkflowSettingsValue>>;
}

export interface WorkflowSettingsMigrationPlan {
	fromVersion: number;
	toVersion: number;
	ownedKeys: readonly string[];
	sourceDigest: string;
	targetDigest: string;
	backupManifestDigest: string;
	state: "prepared" | "applied" | "verified" | "recovered";
}

export interface WorkflowSettingsMigrationStep {
	fromVersion: number;
	toVersion: number;
	stepId: string;
	apply(input: Readonly<Record<string, WorkflowSettingsValue>>): Readonly<Record<string, WorkflowSettingsValue>>;
}

export interface WorkflowSettingsMigrationRecord {
	migrationId: string;
	migrationIdDigest: string;
	fromVersion: number;
	targetVersion: number;
	nextVersion: number;
	values: Readonly<Record<string, WorkflowSettingsValue>>;
	status: "prepared" | "applied" | "verified" | "recovered";
	priorDigest: string | null;
	backupManifestRef: WorkflowArtifactRef;
	backupManifestDigest: string;
	fsyncDigest: string;
	recordDigest: string;
}

export interface WorkflowPreparedSettingsTransaction {
	plan: WorkflowSettingsMigrationPlan;
	preparedBytesDigest: string;
	backupManifestRef: WorkflowArtifactRef;
	fsync(): Promise<void>;
}

export interface WorkflowSettingsMigrationStore {
	read(migrationId: string): Promise<WorkflowSettingsMigrationRecord | null>;
	compareAndSwap(input: {
		migrationId: string;
		expectedDigest: string | null;
		next: WorkflowSettingsMigrationRecord;
	}): Promise<WorkflowSettingsMigrationRecord>;
	backup(input: {
		migrationId: string;
		expectedDigest: string;
		backupManifestRef: WorkflowArtifactRef;
		backupManifestDigest: string;
		fsyncDigest: string;
	}): Promise<WorkflowSettingsMigrationRecord>;
	apply(input: {
		migrationId: string;
		expectedDigest: string;
		next: WorkflowSettingsMigrationRecord;
	}): Promise<WorkflowSettingsMigrationRecord>;
	verify(input: {
		migrationId: string;
		expectedDigest: string;
		expectedValuesDigest: string;
	}): Promise<WorkflowSettingsMigrationRecord>;
	recover(input: {
		migrationId: string;
		expectedDigest: string;
		reasonDigest: string;
	}): Promise<WorkflowSettingsMigrationRecord>;
	flush(input: {
		migrationId: string;
		expectedDigest: string;
		backupManifestRef: WorkflowArtifactRef;
	}): Promise<{ fileSync: true; parentDirectorySync: true; flushDigest: string }>;
}

export interface WorkflowSettingsStore {
	read(): Promise<WorkflowSettings>;
	prepare(plan: WorkflowSettingsMigrationPlan): Promise<WorkflowPreparedSettingsTransaction>;
	apply(plan: WorkflowSettingsMigrationPlan): Promise<void>;
	verify(plan: WorkflowSettingsMigrationPlan): Promise<void>;
	recover(plan: WorkflowSettingsMigrationPlan): Promise<void>;
}

function isSettingsValue(value: unknown): value is WorkflowSettingsValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return Object.keys(value).length === value.length && value.every(isSettingsValue);
	if (typeof value !== "object") return false;
	return Object.entries(value).every(([key, nested]) => key.length > 0 && isSettingsValue(nested));
}

function recordDigest(record: Omit<WorkflowSettingsMigrationRecord, "recordDigest">): string {
	return digestObject({ ...record, recordDigest: "" });
}

function assertRecord(
	record: WorkflowSettingsMigrationRecord,
	migrationId: string,
	fromVersion: number,
	toVersion: number,
	migrationIdDigest: string,
): void {
	if (
		record.migrationId !== migrationId ||
		record.fromVersion !== fromVersion ||
		record.targetVersion !== toVersion ||
		record.migrationIdDigest !== migrationIdDigest ||
		!Number.isSafeInteger(record.nextVersion) ||
		record.nextVersion < fromVersion ||
		record.nextVersion > toVersion ||
		!Object.values(record.values).every(isSettingsValue) ||
		record.backupManifestRef.digest.length === 0 ||
		!Number.isSafeInteger(record.backupManifestRef.sizeBytes) ||
		record.backupManifestRef.sizeBytes <= 0 ||
		record.backupManifestDigest !== record.backupManifestRef.digest ||
		!(["prepared", "applied", "verified", "recovered"] as const).includes(record.status) ||
		(record.status === "prepared" && (record.nextVersion !== fromVersion || record.fsyncDigest.length !== 0)) ||
		(record.status === "verified" && record.nextVersion !== toVersion) ||
		(record.status !== "prepared" && record.fsyncDigest.length === 0) ||
		record.recordDigest !== recordDigest(record)
	)
		throw new Error("Workflow settings migration record is corrupt or mismatched.");
}

function validateMigrationInput(
	input: unknown,
	fromVersion: number,
	toVersion: number,
	migrationId: string,
): Record<string, WorkflowSettingsValue> {
	if (
		!Number.isSafeInteger(fromVersion) ||
		!Number.isSafeInteger(toVersion) ||
		fromVersion < 0 ||
		toVersion < fromVersion
	)
		throw new Error("Workflow settings migration versions are invalid.");
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(migrationId) ||
		migrationId.includes("..") ||
		migrationId.includes("/") ||
		migrationId.includes("\\")
	)
		throw new Error("Workflow settings migration identifier is unsafe.");
	if (input === null || typeof input !== "object" || Array.isArray(input))
		throw new Error("Workflow settings migration input must be an object.");
	const declaredVersion = (input as Record<string, unknown>).schemaVersion;
	if (
		declaredVersion !== undefined &&
		(typeof declaredVersion !== "number" ||
			!Number.isSafeInteger(declaredVersion) ||
			declaredVersion < fromVersion ||
			declaredVersion > toVersion)
	)
		throw new Error("Workflow settings migration rejects a newer or out-of-range schema before filtering fields.");
	const values = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "schemaVersion"));
	if (!Object.values(values).every(isSettingsValue))
		throw new Error("Workflow settings migration rejects unsupported setting values.");
	return values as Record<string, WorkflowSettingsValue>;
}

function validateOrderedSteps(
	steps: readonly WorkflowSettingsMigrationStep[],
	fromVersion: number,
	toVersion: number,
): WorkflowSettingsMigrationStep[] {
	const ordered = [...steps].sort(
		(left, right) =>
			left.fromVersion - right.fromVersion ||
			left.toVersion - right.toVersion ||
			left.stepId.localeCompare(right.stepId),
	);
	if (
		ordered.length !== toVersion - fromVersion ||
		ordered.some(
			(step, index) =>
				step.fromVersion !== fromVersion + index ||
				step.toVersion !== step.fromVersion + 1 ||
				step.stepId.length === 0,
		)
	)
		throw new Error("Workflow settings migration requires an exact ordered N-to-N+1 path.");
	return ordered;
}

export function buildWorkflowSettingsMigrationPlan(
	input: WorkflowSettings,
	fromVersion: number,
	toVersion: number,
	steps: readonly WorkflowSettingsMigrationStep[],
	ownedKeys: readonly string[] = [],
): WorkflowSettingsMigrationPlan {
	if (input.schemaVersion !== fromVersion)
		throw new Error("Workflow settings migration source schema does not match the requested migration plan.");
	const ordered = validateOrderedSteps(steps, fromVersion, toVersion);
	let values: Readonly<Record<string, WorkflowSettingsValue>> = input.values;
	for (const step of ordered) {
		const nextValues = { ...values, ...step.apply(values) };
		if (!Object.values(nextValues).every(isSettingsValue))
			throw new Error(`Workflow settings migration step ${step.stepId} returned unsupported values.`);
		values = nextValues;
	}
	const sourceDigest = digestObject({ schemaVersion: fromVersion, values: input.values });
	const targetDigest = digestObject({ schemaVersion: toVersion, values });
	return {
		fromVersion,
		toVersion,
		ownedKeys: [...ownedKeys].sort(),
		sourceDigest,
		targetDigest,
		backupManifestDigest: digestObject(input.values),
		state: "prepared",
	};
}

export async function migrateWorkflowSettings(
	input: unknown,
	fromVersion: number,
	toVersion: number,
	steps: readonly WorkflowSettingsMigrationStep[],
	store: WorkflowSettingsMigrationStore,
	migrationId: string,
): Promise<WorkflowSettings> {
	const valuesInput = validateMigrationInput(input, fromVersion, toVersion, migrationId);
	const ordered = validateOrderedSteps(steps, fromVersion, toVersion);
	const migrationIdDigest = sha256Hex(new TextEncoder().encode(migrationId));
	let current = await store.read(migrationId);
	if (current !== null) {
		assertRecord(current, migrationId, fromVersion, toVersion, migrationIdDigest);
		if (current.status === "verified") {
			let expectedValues: Readonly<Record<string, WorkflowSettingsValue>> = valuesInput;
			for (const step of ordered) {
				expectedValues = { ...expectedValues, ...step.apply(expectedValues) };
				if (!Object.values(expectedValues).every(isSettingsValue))
					throw new Error(`Workflow settings migration step ${step.stepId} returned unsupported values.`);
			}
			if (digestObject(current.values) !== digestObject(expectedValues))
				throw new Error("Verified workflow settings migration values do not match the final schema.");
			return { schemaVersion: toVersion, values: current.values };
		}
	} else {
		const backupManifestBytes = canonicalJsonBytes(valuesInput);
		const backupManifestRef: WorkflowArtifactRef = {
			artifactId: `settings-backup:${migrationId}`,
			relativePath: `settings/backups/${migrationId}`,
			digest: sha256Hex(backupManifestBytes),
			sizeBytes: backupManifestBytes.byteLength,
			sourceEventSequence: 0,
		};
		const preparedWithoutDigest: Omit<WorkflowSettingsMigrationRecord, "recordDigest"> = {
			migrationId,
			migrationIdDigest,
			fromVersion,
			targetVersion: toVersion,
			nextVersion: fromVersion,
			values: valuesInput,
			status: "prepared",
			priorDigest: null,
			backupManifestRef,
			backupManifestDigest: backupManifestRef.digest,
			fsyncDigest: "",
		};
		current = await store.compareAndSwap({
			migrationId,
			expectedDigest: null,
			next: { ...preparedWithoutDigest, recordDigest: recordDigest(preparedWithoutDigest) },
		});
	}
	let values = current.values;
	let version = current.nextVersion;
	try {
		if (
			!Number.isSafeInteger(version) ||
			version < fromVersion ||
			version > toVersion ||
			!Object.values(values).every(isSettingsValue)
		)
			throw new Error("Workflow settings migration record has an invalid partial version or value set.");
		if (current.status === "prepared") {
			if (version !== fromVersion) throw new Error("Prepared settings migration is not at its source version.");
			current = await fsyncPreparedWorkflowSettingsTransaction(store, current);
			current = await store.backup({
				migrationId,
				expectedDigest: current.recordDigest,
				backupManifestRef: current.backupManifestRef,
				backupManifestDigest: current.backupManifestDigest,
				fsyncDigest: current.fsyncDigest,
			});
		} else if ((current.status !== "applied" && current.status !== "recovered") || current.fsyncDigest.length === 0) {
			throw new Error("Workflow settings migration has no recoverable prepared transaction.");
		}
		for (const step of ordered) {
			if (step.toVersion <= version) continue;
			if (step.fromVersion !== version || step.toVersion !== version + 1 || step.toVersion > toVersion)
				throw new Error("Workflow settings migration steps are not an exact ordered N-to-N+1 path.");
			const nextValues = { ...values, ...step.apply(values) };
			if (!Object.values(nextValues).every(isSettingsValue))
				throw new Error(`Workflow settings migration step ${step.stepId} returned unsupported values.`);
			values = nextValues;
			version = step.toVersion;
			const nextWithoutDigest: Omit<WorkflowSettingsMigrationRecord, "recordDigest"> = {
				...current,
				nextVersion: version,
				values,
				status: "applied",
				priorDigest: current.recordDigest,
			};
			current = await store.apply({
				migrationId,
				expectedDigest: current.recordDigest,
				next: { ...nextWithoutDigest, recordDigest: recordDigest(nextWithoutDigest) },
			});
		}
		if (version !== toVersion)
			throw new Error("Workflow settings migration has no complete ordered path to the target version.");
		current = await store.verify({
			migrationId,
			expectedDigest: current.recordDigest,
			expectedValuesDigest: digestObject(values),
		});
		return { schemaVersion: toVersion, values: current.values };
	} catch (error) {
		await store.recover({
			migrationId,
			expectedDigest: current.recordDigest,
			reasonDigest: digestObject({
				migrationId,
				version,
				error: error instanceof Error ? error.message : String(error),
			}),
		});
		throw error;
	}
}

async function fsyncPreparedWorkflowSettingsTransaction(
	store: WorkflowSettingsMigrationStore,
	record: WorkflowSettingsMigrationRecord,
): Promise<WorkflowSettingsMigrationRecord> {
	if (
		record.status !== "prepared" ||
		record.migrationIdDigest !== sha256Hex(new TextEncoder().encode(record.migrationId)) ||
		record.backupManifestDigest !== record.backupManifestRef.digest
	)
		throw new Error("Settings migration backup is not prepared before fsync.");
	const flushed = await store.flush({
		migrationId: record.migrationId,
		expectedDigest: record.recordDigest,
		backupManifestRef: record.backupManifestRef,
	});
	if (flushed.fileSync !== true || flushed.parentDirectorySync !== true || flushed.flushDigest.length === 0)
		throw new Error("Settings migration did not persist file and parent-directory flush proof.");
	const nextWithoutDigest: Omit<WorkflowSettingsMigrationRecord, "recordDigest"> = {
		...record,
		fsyncDigest: flushed.flushDigest,
	};
	return store.compareAndSwap({
		migrationId: record.migrationId,
		expectedDigest: record.recordDigest,
		next: { ...nextWithoutDigest, recordDigest: recordDigest(nextWithoutDigest) },
	});
}

export async function fsyncPreparedWorkflowSettings(
	file: { sync(): Promise<void> },
	parentDirectory: { sync(): Promise<void> },
): Promise<void> {
	await file.sync();
	await parentDirectory.sync();
}
