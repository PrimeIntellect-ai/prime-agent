import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkflowEpochRef } from "./contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes } from "./contracts.js";
import type { WorkflowJournalKey, WorkflowJournalKeyProvider } from "./journal.js";

const KEY_SECRET_BYTES = 32;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GENERATION_ID_PATTERN = /^generation-[0-9a-f]{32}$/;
const KEY_ID_PATTERN = /^key-[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ROTATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface LocalWorkflowJournalKeyringOptions {
	sessionArtifactRoot: string;
	rootSessionId: string;
}

export interface LocalWorkflowJournalKeyRotationInput {
	workflowId: string;
	previousEpoch: WorkflowEpochRef;
	nextEpoch: WorkflowEpochRef;
	rotationId: string;
	priorHeadDigest: string;
	generationId?: string;
}

interface LocalWorkflowJournalKeyRecord {
	recordVersion: 1;
	rootSessionId: string;
	rootIdentityDigest: string;
	rootPathDigest: string;
	workflowId: string;
	epochRef: WorkflowEpochRef;
	validStoreEpoch: number;
	generationId: string;
	keyId: string;
	bindingDigest: string;
	secretBase64: string;
	recordDigest: string;
}

interface LocalWorkflowJournalKeyRecordUnsigned extends Omit<LocalWorkflowJournalKeyRecord, "recordDigest"> {
	recordDigest: "";
}

interface RootState {
	rootPath: string;
	rootSessionId: string;
	rootIdentityDigest: string;
	rootPathDigest: string;
}

interface KeyDirectories {
	sideRecordsPath: string;
	generationsPath: string;
}

interface VerifiedLocalWorkflowJournalKey extends WorkflowJournalKey {
	epochRef: WorkflowEpochRef;
}

interface DirectoryEntry {
	name: string;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

const workflowLocks = new Map<string, Promise<void>>();

/**
 * Persist one HMAC secret per authenticated workflow generation.
 *
 * Args:
 * options: Session artifact root and root-session identity used to bind key records.
 * Return: A persisted workflow journal key provider.
 */
export class LocalWorkflowJournalKeyring implements WorkflowJournalKeyProvider {
	private readonly rootPath: string;
	private readonly rootSessionId: string;

	constructor(options: LocalWorkflowJournalKeyringOptions) {
		if (!isAbsolute(options.sessionArtifactRoot))
			throw new Error("Local workflow keyring requires an absolute session artifact root.");
		if (
			options.rootSessionId.length === 0 ||
			options.rootSessionId.includes("/") ||
			options.rootSessionId.includes("\\")
		)
			throw new Error("Local workflow keyring requires a canonical root-session identity.");
		this.rootPath = resolve(options.sessionArtifactRoot);
		this.rootSessionId = options.rootSessionId;
	}

	async current(workflowId: string, epoch: WorkflowEpochRef): Promise<WorkflowJournalKey> {
		validateWorkflowId(workflowId);
		validateEpoch(epoch);
		return withWorkflowLock(this.rootPath, workflowId, async () => {
			const root = await openRootState(this.rootPath, this.rootSessionId);
			const directories = await ensureKeyDirectories(root.rootPath, workflowId);
			return findOrPublishCurrentKey(root, directories, workflowId, epoch);
		});
	}

	async resolve(workflowId: string, keyId: string, epoch: WorkflowEpochRef): Promise<WorkflowJournalKey> {
		validateWorkflowId(workflowId);
		validateKeyId(keyId);
		validateEpoch(epoch);
		return withWorkflowLock(this.rootPath, workflowId, async () => {
			const root = await openRootState(this.rootPath, this.rootSessionId);
			const directories = await ensureKeyDirectories(root.rootPath, workflowId);
			await verifyWorkflowKeyMarker(root, directories, workflowId);
			return findKeyById(root, directories, workflowId, keyId, epoch);
		});
	}

	async rotate(input: LocalWorkflowJournalKeyRotationInput): Promise<WorkflowJournalKey> {
		validateWorkflowId(input.workflowId);
		validateEpoch(input.previousEpoch);
		validateEpoch(input.nextEpoch);
		if (!isEpochSuccessor(input.previousEpoch, input.nextEpoch))
			throw new Error("Workflow key rotation must advance the store or coordinator epoch.");
		if (!ROTATION_ID_PATTERN.test(input.rotationId))
			throw new Error("Workflow key rotation requires a canonical rotation identity.");
		if (!DIGEST_PATTERN.test(input.priorHeadDigest))
			throw new Error("Workflow key rotation requires the prior authenticated head digest.");
		if (input.generationId !== undefined) validateGenerationId(input.generationId);
		return withWorkflowLock(this.rootPath, input.workflowId, async () => {
			const root = await openRootState(this.rootPath, this.rootSessionId);
			const directories = await ensureKeyDirectories(root.rootPath, input.workflowId);
			await findOrPublishCurrentKey(root, directories, input.workflowId, input.previousEpoch);
			const generationId = deriveGenerationId({
				workflowId: input.workflowId,
				nextEpoch: input.nextEpoch,
				rotationId: input.rotationId,
				priorHeadDigest: input.priorHeadDigest,
			});
			if (input.generationId !== undefined && input.generationId !== generationId)
				throw new Error("Workflow key rotation supplied a non-canonical generation identity.");
			return findOrPublishGenerationKey(root, directories, input.workflowId, input.nextEpoch, generationId);
		});
	}

	async rotateGeneration(input: LocalWorkflowJournalKeyRotationInput): Promise<WorkflowJournalKey> {
		return this.rotate(input);
	}
}

/**
 * Create a persisted local workflow journal key provider.
 *
 * Args:
 * options: Session artifact root and root-session identity used to bind key records.
 * Return: A provider backed by the protected session artifact root.
 */
export function createLocalWorkflowJournalKeyProvider(
	options: LocalWorkflowJournalKeyringOptions,
): LocalWorkflowJournalKeyring {
	return new LocalWorkflowJournalKeyring(options);
}

export type LocalJournalKeyringOptions = LocalWorkflowJournalKeyringOptions;
export type LocalJournalKeyRotationInput = LocalWorkflowJournalKeyRotationInput;
export const createLocalJournalKeyProvider = createLocalWorkflowJournalKeyProvider;

async function findOrPublishCurrentKey(
	root: RootState,
	directories: KeyDirectories,
	workflowId: string,
	epoch: WorkflowEpochRef,
): Promise<WorkflowJournalKey> {
	const existing = await findKeysForEpoch(root, directories, workflowId, epoch);
	if (existing.length > 1) throw new Error("Workflow keyring found multiple keys for one authenticated epoch.");
	if (existing.length === 1) return toJournalKey(existing[0]);
	const key = await findOrPublishGenerationKey(
		root,
		directories,
		workflowId,
		epoch,
		deriveGenerationId({
			workflowId,
			nextEpoch: epoch,
			rotationId: "bootstrap",
			priorHeadDigest: "genesis",
		}),
	);
	if ((await readWorkflowKeyMarker(root, directories, workflowId)) === null)
		await publishWorkflowKeyMarker(root, directories, workflowId, key);
	return key;
}

async function findKeysForEpoch(
	root: RootState,
	directories: KeyDirectories,
	workflowId: string,
	epoch: WorkflowEpochRef,
): Promise<VerifiedLocalWorkflowJournalKey[]> {
	const marker = await readWorkflowKeyMarker(root, directories, workflowId);
	const entries = (await readdir(directories.generationsPath, { withFileTypes: true })) as unknown as DirectoryEntry[];
	const matches: VerifiedLocalWorkflowJournalKey[] = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink()) throw new Error("Workflow keyring refuses a symlinked generation directory.");
		if (!entry.isDirectory()) throw new Error("Workflow keyring found a non-directory generation entry.");
		validateGenerationId(entry.name);
		const keyPath = join(directories.generationsPath, entry.name, "side-records", "key.json");
		const key = await readAndVerifyKeyRecord(keyPath, undefined, root, workflowId, undefined, entry.name);
		if (
			key.validStoreEpoch === epoch.storeEpoch &&
			key.epochRef.storeEpoch === epoch.storeEpoch &&
			key.epochRef.coordinatorEpoch === epoch.coordinatorEpoch
		)
			matches.push(key);
	}
	if (marker === null && entries.length > 0)
		throw new Error("Workflow keyring is missing its authenticated workflow key marker.");
	if (marker !== null && !entries.some((entry) => entry.name === marker.generationId))
		throw new Error("Workflow keyring marker references a missing generation record.");
	return matches;
}

async function verifyWorkflowKeyMarker(
	root: RootState,
	directories: KeyDirectories,
	workflowId: string,
): Promise<void> {
	const marker = await readWorkflowKeyMarker(root, directories, workflowId);
	if (marker === null) throw new Error("Workflow keyring is missing its authenticated workflow key marker.");
	const markerPath = join(directories.sideRecordsPath, "key.json");
	const generationPath = join(directories.generationsPath, marker.generationId, "side-records", "key.json");
	if (
		!sameBytes(await readPrivateFile(markerPath, root.rootPath), await readPrivateFile(generationPath, root.rootPath))
	)
		throw new Error("Workflow keyring marker does not match its immutable generation record.");
}

async function readWorkflowKeyMarker(
	root: RootState,
	directories: KeyDirectories,
	workflowId: string,
): Promise<VerifiedLocalWorkflowJournalKey | null> {
	try {
		return await readAndVerifyKeyRecord(join(directories.sideRecordsPath, "key.json"), undefined, root, workflowId);
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw error;
	}
}

async function publishWorkflowKeyMarker(
	root: RootState,
	directories: KeyDirectories,
	workflowId: string,
	key: WorkflowJournalKey,
): Promise<void> {
	const generationKeyPath = join(directories.generationsPath, key.generationId, "side-records", "key.json");
	const markerPath = join(directories.sideRecordsPath, "key.json");
	const marker = await readWorkflowKeyMarker(root, directories, workflowId);
	if (marker !== null) return;
	await publishImmutableRecord(markerPath, await readPrivateFile(generationKeyPath, root.rootPath), root.rootPath);
	const published = await readWorkflowKeyMarker(root, directories, workflowId);
	if (published === null || published.keyId !== key.keyId || published.generationId !== key.generationId)
		throw new Error("Workflow keyring published a conflicting immutable key marker.");
}

async function findKeyById(
	root: RootState,
	directories: KeyDirectories,
	workflowId: string,
	keyId: string,
	epoch: WorkflowEpochRef,
): Promise<WorkflowJournalKey> {
	const entries = (await readdir(directories.generationsPath, { withFileTypes: true })) as unknown as DirectoryEntry[];
	let found: VerifiedLocalWorkflowJournalKey | null = null;
	const seenKeyIds = new Set<string>();
	for (const entry of entries) {
		if (entry.isSymbolicLink()) throw new Error("Workflow keyring refuses a symlinked generation directory.");
		if (!entry.isDirectory()) throw new Error("Workflow keyring found a non-directory generation entry.");
		validateGenerationId(entry.name);
		const candidate = await readAndVerifyKeyRecord(
			join(directories.generationsPath, entry.name, "side-records", "key.json"),
			undefined,
			root,
			workflowId,
			undefined,
			entry.name,
		);
		if (seenKeyIds.has(candidate.keyId)) throw new Error("Workflow keyring found duplicate key identities.");
		seenKeyIds.add(candidate.keyId);
		if (candidate.keyId !== keyId) continue;
		found = candidate;
	}
	if (found === null) throw new Error("Workflow key record is missing.");
	if (found.epochRef.storeEpoch !== epoch.storeEpoch || found.epochRef.coordinatorEpoch !== epoch.coordinatorEpoch)
		throw new Error("Workflow key record is stale for the requested epoch.");
	return toJournalKey(found);
}

async function findOrPublishGenerationKey(
	root: RootState,
	directories: KeyDirectories,
	workflowId: string,
	epoch: WorkflowEpochRef,
	generationId: string,
): Promise<WorkflowJournalKey> {
	validateGenerationId(generationId);
	const keyId = deriveKeyId({ workflowId, epochRef: epoch, generationId });
	const generationPath = join(directories.generationsPath, generationId);
	const generationSideRecordsPath = join(generationPath, "side-records");
	await ensurePrivateDirectory(generationPath);
	await ensurePrivateDirectory(generationSideRecordsPath);
	const recordPath = join(generationSideRecordsPath, "key.json");
	try {
		return toJournalKey(await readAndVerifyKeyRecord(recordPath, keyId, root, workflowId, epoch, generationId));
	} catch (error) {
		if (!isNotFoundError(error)) throw error;
	}
	const secret = randomBytes(KEY_SECRET_BYTES);
	const record = createKeyRecord({ root, workflowId, epoch, generationId, keyId, secret });
	const published = await publishImmutableRecord(recordPath, canonicalJsonBytes(record), root.rootPath);
	return toJournalKey(await readAndVerifyKeyRecord(published, keyId, root, workflowId, epoch, generationId));
}

function createKeyRecord(input: {
	root: RootState;
	workflowId: string;
	epoch: WorkflowEpochRef;
	generationId: string;
	keyId: string;
	secret: Uint8Array;
}): LocalWorkflowJournalKeyRecord {
	const bindingDigest = digestObject({
		rootSessionId: input.root.rootSessionId,
		rootIdentityDigest: input.root.rootIdentityDigest,
		rootPathDigest: input.root.rootPathDigest,
		workflowId: input.workflowId,
		epochRef: input.epoch,
		validStoreEpoch: input.epoch.storeEpoch,
		generationId: input.generationId,
		keyId: input.keyId,
	});
	const withoutRecordDigest: LocalWorkflowJournalKeyRecordUnsigned = {
		recordVersion: 1,
		rootSessionId: input.root.rootSessionId,
		rootIdentityDigest: input.root.rootIdentityDigest,
		rootPathDigest: input.root.rootPathDigest,
		workflowId: input.workflowId,
		epochRef: input.epoch,
		validStoreEpoch: input.epoch.storeEpoch,
		generationId: input.generationId,
		keyId: input.keyId,
		bindingDigest,
		secretBase64: Buffer.from(input.secret).toString("base64"),
		recordDigest: "",
	};
	return { ...withoutRecordDigest, recordDigest: digestObject(withoutRecordDigest) };
}

async function readAndVerifyKeyRecord(
	recordPath: string,
	expectedKeyId: string | undefined,
	root: RootState,
	workflowId: string,
	expectedEpoch?: WorkflowEpochRef,
	expectedGenerationId?: string,
): Promise<VerifiedLocalWorkflowJournalKey> {
	const bytes = await readPrivateFile(recordPath, root.rootPath);
	let value: unknown;
	try {
		value = parseCanonicalJsonBytes(bytes);
	} catch {
		throw new Error("Workflow key record is corrupt or not canonical.");
	}
	if (!isLocalWorkflowJournalKeyRecord(value) || !sameBytes(canonicalJsonBytes(value), bytes))
		throw new Error("Workflow key record is corrupt or not canonical.");
	if (
		value.recordVersion !== 1 ||
		value.rootSessionId !== root.rootSessionId ||
		value.rootIdentityDigest !== root.rootIdentityDigest ||
		value.rootPathDigest !== root.rootPathDigest ||
		value.workflowId !== workflowId ||
		(expectedKeyId !== undefined && value.keyId !== expectedKeyId) ||
		(expectedGenerationId !== undefined && value.generationId !== expectedGenerationId) ||
		value.keyId !==
			deriveKeyId({ workflowId: value.workflowId, epochRef: value.epochRef, generationId: value.generationId }) ||
		value.validStoreEpoch !== value.epochRef.storeEpoch ||
		(expectedEpoch !== undefined &&
			(value.validStoreEpoch !== expectedEpoch.storeEpoch ||
				digestObject(value.epochRef) !== digestObject(expectedEpoch))) ||
		value.bindingDigest !==
			digestObject({
				rootSessionId: value.rootSessionId,
				rootIdentityDigest: value.rootIdentityDigest,
				rootPathDigest: value.rootPathDigest,
				workflowId: value.workflowId,
				epochRef: value.epochRef,
				validStoreEpoch: value.validStoreEpoch,
				generationId: value.generationId,
				keyId: value.keyId,
			}) ||
		value.recordDigest !== digestObject({ ...value, recordDigest: "" })
	)
		throw new Error("Workflow key record is foreign, stale, or not bound to this workflow epoch.");
	const secret = decodeSecret(value.secretBase64);
	return {
		keyId: value.keyId,
		secret: Uint8Array.from(secret),
		validStoreEpoch: value.validStoreEpoch,
		generationId: value.generationId,
		epochRef: { ...value.epochRef },
	};
}

function toJournalKey(key: VerifiedLocalWorkflowJournalKey): WorkflowJournalKey {
	return {
		keyId: key.keyId,
		secret: Uint8Array.from(key.secret),
		validStoreEpoch: key.validStoreEpoch,
		generationId: key.generationId,
	};
}

async function publishImmutableRecord(recordPath: string, bytes: Uint8Array, rootPath: string): Promise<string> {
	const parentPath = dirname(recordPath);
	await assertControlledPath(rootPath, parentPath);
	const keyId = recordPath.slice(parentPath.length + 1, -5);
	const tempPath = join(parentPath, `.${keyId}.tmp-${randomBytes(16).toString("hex")}`);
	let temporaryCreated = false;
	try {
		const temporary = await open(
			tempPath,
			fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
			PRIVATE_FILE_MODE,
		);
		temporaryCreated = true;
		try {
			await temporary.writeFile(bytes);
			await temporary.sync();
		} finally {
			await temporary.close();
		}
		try {
			await link(tempPath, recordPath);
		} catch (error) {
			if (!isAlreadyExistsError(error)) throw error;
			await readPublishedRecord(recordPath, rootPath);
		}
		await unlink(tempPath);
		temporaryCreated = false;
		await syncPrivateFile(recordPath, rootPath);
		await syncDirectoryChain(parentPath, rootPath);
		return recordPath;
	} finally {
		if (temporaryCreated) await rm(tempPath, { force: true }).catch(() => undefined);
	}
}

async function readPublishedRecord(path: string, rootPath: string): Promise<Uint8Array> {
	for (let attempt = 0; attempt < 32; attempt += 1) {
		try {
			return await readPrivateFile(path, rootPath);
		} catch (error) {
			const stats = await lstat(path).catch(() => null);
			if (stats?.nlink !== 2 || attempt === 31) throw error;
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
		}
	}
	throw new Error("Workflow key publication did not settle to one immutable file identity.");
}

async function openRootState(rootPath: string, rootSessionId: string): Promise<RootState> {
	const rootBefore = await lstat(rootPath);
	if (rootBefore.isSymbolicLink()) throw new Error("Workflow keyring refuses a symlinked session root.");
	const canonicalRootPath = await realpath(rootPath);
	const stats = await lstat(canonicalRootPath);
	if (stats.isSymbolicLink()) throw new Error("Workflow keyring refuses a symlinked session root.");
	if (!stats.isDirectory() || (stats.mode & 0o077) !== 0)
		throw new Error("Session artifact root is not a private directory.");
	const rootIdentityDigest = digestObject({
		device: Number(stats.dev),
		inode: Number(stats.ino),
		kind: "directory",
	});
	return {
		rootPath: canonicalRootPath,
		rootSessionId,
		rootIdentityDigest,
		rootPathDigest: digestObject({ path: canonicalRootPath }),
	};
}

async function ensureKeyDirectories(rootPath: string, workflowId: string): Promise<KeyDirectories> {
	const keyringPath = join(rootPath, "keyring");
	await ensurePrivateDirectory(keyringPath);
	const workflowsPath = join(keyringPath, "workflows");
	await ensurePrivateDirectory(workflowsPath);
	const workflowPath = join(workflowsPath, workflowId);
	await ensurePrivateDirectory(workflowPath);
	const sideRecordsPath = join(workflowPath, "side-records");
	await ensurePrivateDirectory(sideRecordsPath);
	const generationsPath = join(workflowPath, "generations");
	await ensurePrivateDirectory(generationsPath);
	return { sideRecordsPath, generationsPath };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	try {
		await assertPrivateDirectory(path);
	} catch (error) {
		if (!isNotFoundError(error)) throw error;
		try {
			await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
		} catch (mkdirError) {
			if (!isAlreadyExistsError(mkdirError)) throw mkdirError;
		}
		await assertPrivateDirectory(path);
	}
}

async function assertPrivateDirectory(path: string): Promise<void> {
	const stats = await lstat(path);
	if (stats.isSymbolicLink()) throw new Error("Workflow keyring refuses a symlinked directory.");
	if (!stats.isDirectory() || (stats.mode & 0o077) !== 0)
		throw new Error("Workflow keyring requires private directory permissions.");
}

async function readPrivateFile(path: string, rootPath: string): Promise<Uint8Array> {
	await assertControlledPath(rootPath, path);
	const before = await lstat(path);
	if (before.isSymbolicLink()) throw new Error("Workflow keyring refuses a symlinked key record.");
	if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== PRIVATE_FILE_MODE)
		throw new Error("Workflow key record is not a private regular file.");
	const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
	try {
		const opened = await handle.stat();
		if (
			!opened.isFile() ||
			opened.nlink !== 1 ||
			(opened.mode & 0o777) !== PRIVATE_FILE_MODE ||
			Number(opened.dev) !== Number(before.dev) ||
			Number(opened.ino) !== Number(before.ino)
		)
			throw new Error("Workflow key record changed identity or permissions during open.");
		return new Uint8Array(await handle.readFile());
	} finally {
		await handle.close();
	}
}

async function syncPrivateFile(path: string, rootPath: string): Promise<void> {
	await assertControlledPath(rootPath, path);
	const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
	try {
		const stats = await handle.stat();
		if (!stats.isFile() || stats.nlink !== 1 || (stats.mode & 0o777) !== PRIVATE_FILE_MODE)
			throw new Error("Workflow key publication lost private file identity.");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectoryChain(path: string, rootPath: string): Promise<void> {
	await assertControlledPath(rootPath, path);
	let current = path;
	while (true) {
		const handle = await open(
			current,
			fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
		);
		try {
			const stats = await handle.stat();
			if (!stats.isDirectory()) throw new Error("Workflow key parent is not a directory.");
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (current === rootPath) return;
		const parent = dirname(current);
		if (parent === current) throw new Error("Workflow keyring could not reach its session root.");
		current = parent;
	}
}

async function assertControlledPath(rootPath: string, path: string): Promise<void> {
	const relativePath = relative(rootPath, path);
	if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`))
		throw new Error("Workflow keyring path escaped its canonical session root.");
	let current = rootPath;
	for (const component of relativePath.split(sep)) {
		if (component.length === 0) continue;
		current = join(current, component);
		const stats = await lstat(current);
		if (stats.isSymbolicLink()) throw new Error("Workflow keyring refuses a symlinked controlled path.");
	}
}

function deriveGenerationId(input: {
	workflowId: string;
	nextEpoch: WorkflowEpochRef;
	rotationId: string;
	priorHeadDigest: string;
}): string {
	return `generation-${digestObject(input).slice(0, 32)}`;
}

function deriveKeyId(input: { workflowId: string; epochRef: WorkflowEpochRef; generationId: string }): string {
	return `key-${digestObject(input)}`;
}

function decodeSecret(value: string): Uint8Array {
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value))
		throw new Error("Workflow key record contains an invalid secret encoding.");
	const secret = Buffer.from(value, "base64");
	if (secret.byteLength !== KEY_SECRET_BYTES || secret.toString("base64") !== value)
		throw new Error("Workflow key record contains an invalid secret length.");
	return new Uint8Array(secret);
}

function isLocalWorkflowJournalKeyRecord(value: unknown): value is LocalWorkflowJournalKeyRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const keys = [
		"recordVersion",
		"rootSessionId",
		"rootIdentityDigest",
		"rootPathDigest",
		"workflowId",
		"epochRef",
		"validStoreEpoch",
		"generationId",
		"keyId",
		"bindingDigest",
		"secretBase64",
		"recordDigest",
	];
	if (Object.keys(record).length !== keys.length || !keys.every((key) => key in record)) return false;
	const epoch = record.epochRef;
	return (
		record.recordVersion === 1 &&
		typeof record.rootSessionId === "string" &&
		typeof record.rootIdentityDigest === "string" &&
		typeof record.rootPathDigest === "string" &&
		typeof record.workflowId === "string" &&
		typeof record.validStoreEpoch === "number" &&
		Number.isSafeInteger(record.validStoreEpoch) &&
		isEpoch(epoch) &&
		typeof record.generationId === "string" &&
		GENERATION_ID_PATTERN.test(record.generationId) &&
		typeof record.keyId === "string" &&
		KEY_ID_PATTERN.test(record.keyId) &&
		typeof record.bindingDigest === "string" &&
		typeof record.secretBase64 === "string" &&
		typeof record.recordDigest === "string"
	);
}

function isEpoch(value: unknown): value is WorkflowEpochRef {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).length === 2 &&
		typeof record.storeEpoch === "number" &&
		Number.isSafeInteger(record.storeEpoch) &&
		record.storeEpoch > 0 &&
		typeof record.coordinatorEpoch === "number" &&
		Number.isSafeInteger(record.coordinatorEpoch) &&
		record.coordinatorEpoch > 0
	);
}

function validateWorkflowId(workflowId: string): void {
	if (!WORKFLOW_ID_PATTERN.test(workflowId))
		throw new Error("Workflow keyring requires a canonical workflow identity.");
}

function validateEpoch(epoch: WorkflowEpochRef): void {
	if (!isEpoch(epoch)) throw new Error("Workflow keyring requires a positive canonical epoch.");
}

function validateGenerationId(generationId: string): void {
	if (!GENERATION_ID_PATTERN.test(generationId))
		throw new Error("Workflow keyring requires a canonical generation identity.");
}

function validateKeyId(keyId: string): void {
	if (!KEY_ID_PATTERN.test(keyId)) throw new Error("Workflow keyring requires a canonical key identity.");
}

function isEpochSuccessor(previous: WorkflowEpochRef, next: WorkflowEpochRef): boolean {
	return (
		(next.storeEpoch === previous.storeEpoch + 1 && next.coordinatorEpoch === previous.coordinatorEpoch) ||
		(next.storeEpoch === previous.storeEpoch && next.coordinatorEpoch === previous.coordinatorEpoch + 1)
	);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function withWorkflowLock<T>(rootPath: string, workflowId: string, operation: () => Promise<T>): Promise<T> {
	const lockKey = `${rootPath}\u0000${workflowId}`;
	const previous = workflowLocks.get(lockKey) ?? Promise.resolve();
	const current = previous.then(operation, operation);
	const tail = current.then(
		() => undefined,
		() => undefined,
	);
	workflowLocks.set(lockKey, tail);
	return current.finally(() => {
		if (workflowLocks.get(lockKey) === tail) workflowLocks.delete(lockKey);
	});
}
