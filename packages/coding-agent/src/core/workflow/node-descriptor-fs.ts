import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { WorkflowDescriptorFs, WorkflowDescriptorHandle } from "./contracts.js";
import { digestObject } from "./contracts.js";
import type { WorkflowDescriptorNativeAdapter } from "./journal.js";

type DescriptorKind = "file" | "directory";

interface NodeDescriptorState {
	readonly file: FileHandle;
	readonly path: string;
	readonly rootPath: string;
	readonly chain: DescriptorChain;
	readonly kind: DescriptorKind;
	readonly identityDigest: string;
	readonly device: number;
	readonly inode: number;
	closed: boolean;
}

interface DescriptorIdentity {
	kind: DescriptorKind;
	linkCount: number;
	device: number;
	inode: number;
	identityDigest: string;
}

interface DescriptorChain {
	readonly paths: readonly string[];
	readonly identities: readonly DescriptorIdentity[];
}

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fsConstants.O_DIRECTORY ?? 0;

function descriptorError(message: string, code?: string): Error {
	const error = new Error(message);
	if (code !== undefined) Object.assign(error, { code });
	return error;
}

function assertSafeComponent(component: string, label: string): void {
	if (
		component.length === 0 ||
		component === "." ||
		component === ".." ||
		component.includes("/") ||
		component.includes("\\") ||
		component.includes("\0")
	)
		throw descriptorError(`${label} must be one safe descriptor component.`);
}

function numberStatField(value: number | bigint, field: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0) {
		throw descriptorError(`Descriptor ${field} is not a safe non-negative integer.`);
	}
	return number;
}

function identityFromStats(stats: Stats): DescriptorIdentity {
	const kind: DescriptorKind = stats.isDirectory()
		? "directory"
		: stats.isFile()
			? "file"
			: (() => {
					throw descriptorError("Descriptor entry is not a regular file or directory.");
				})();
	const device = numberStatField(stats.dev, "device");
	const inode = numberStatField(stats.ino, "inode");
	const linkCount = numberStatField(stats.nlink, "link count");
	return {
		kind,
		linkCount,
		device,
		inode,
		identityDigest: digestObject({ device, inode, kind }),
	};
}

function sameIdentity(left: DescriptorIdentity, right: DescriptorIdentity): boolean {
	return left.kind === right.kind && left.device === right.device && left.inode === right.inode;
}

function assertRegularPrivateFile(identity: DescriptorIdentity): void {
	if (identity.kind !== "file") throw descriptorError("Descriptor entry is not a regular file.");
	if (identity.linkCount !== 1) throw descriptorError("Descriptor adapter refuses hard-linked regular files.");
}

function assertPrivateDirectory(identity: DescriptorIdentity): void {
	if (identity.kind !== "directory") throw descriptorError("Descriptor entry is not a directory.");
	if (identity.linkCount < 1) throw descriptorError("Descriptor directory has an invalid link count.");
}

function assertDescendant(rootPath: string, candidatePath: string): void {
	const pathRelation = relative(rootPath, candidatePath);
	if (pathRelation.startsWith("..") || pathRelation.startsWith("/") || pathRelation === "") {
		if (candidatePath !== rootPath) throw descriptorError("Descriptor ancestor escaped the opened root.");
	}
}

function stateFor(
	states: WeakMap<WorkflowDescriptorHandle, NodeDescriptorState>,
	handle: WorkflowDescriptorHandle,
): NodeDescriptorState {
	const state = states.get(handle);
	if (state === undefined) throw descriptorError("Unknown descriptor handle.");
	return state;
}

function assertOpen(state: NodeDescriptorState): void {
	if (state.closed) throw descriptorError("Descriptor handle is closed.");
}

async function statPath(path: string): Promise<DescriptorIdentity> {
	const stats = await lstat(path);
	if (stats.isSymbolicLink()) throw descriptorError("Descriptor adapter refuses symlink traversal.", "ELOOP");
	return identityFromStats(stats);
}

async function assertNoSymlinkComponents(
	rootPath: string,
	candidatePath: string,
	allowMissingLeaf = false,
): Promise<void> {
	assertDescendant(rootPath, candidatePath);
	const pathRelation = relative(rootPath, candidatePath);
	if (pathRelation.length === 0) return;
	let currentPath = rootPath;
	for (const component of pathRelation.split(sep)) {
		if (component.length === 0) continue;
		currentPath = join(currentPath, component);
		let identity: DescriptorIdentity;
		try {
			identity = await statPath(currentPath);
		} catch (error) {
			if (allowMissingLeaf && currentPath === candidatePath && (error as NodeJS.ErrnoException).code === "ENOENT")
				return;
			throw error;
		}
		if (identity.kind !== "directory" && currentPath !== candidatePath)
			throw descriptorError("Descriptor path component is not a directory.");
	}
}

async function assertParentStable(state: NodeDescriptorState): Promise<DescriptorIdentity> {
	assertOpen(state);
	if (state.kind !== "directory") throw descriptorError("Descriptor parent must be a directory.");
	await assertNoSymlinkComponents(state.rootPath, state.path);
	const descriptorIdentity = identityFromStats(await state.file.stat());
	if (
		!sameIdentity(descriptorIdentity, {
			kind: state.kind,
			linkCount: descriptorIdentity.linkCount,
			device: state.device,
			inode: state.inode,
			identityDigest: state.identityDigest,
		})
	)
		throw descriptorError("Opened descriptor parent identity changed.");
	const pathIdentity = await statPath(state.path);
	if (!sameIdentity(pathIdentity, descriptorIdentity)) throw descriptorError("Descriptor parent path was replaced.");
	return descriptorIdentity;
}

async function openPathHandle(
	path: string,
	flags: number,
	mode: number,
	states: WeakMap<WorkflowDescriptorHandle, NodeDescriptorState>,
	rootPath: string,
	parentChain: DescriptorChain | undefined,
	expectedIdentity?: DescriptorIdentity,
): Promise<WorkflowDescriptorHandle> {
	await assertNoSymlinkComponents(rootPath, path, (flags & fsConstants.O_CREAT) !== 0);
	let beforeIdentity: DescriptorIdentity | undefined;
	try {
		beforeIdentity = await statPath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const file = await open(path, flags | O_NOFOLLOW, mode);
	try {
		const afterIdentity = identityFromStats(await file.stat());
		await assertNoSymlinkComponents(rootPath, path);
		if (beforeIdentity !== undefined && !sameIdentity(beforeIdentity, afterIdentity))
			throw descriptorError("Descriptor adapter detected a path swap during open.");
		if (expectedIdentity !== undefined && !sameIdentity(expectedIdentity, afterIdentity))
			throw descriptorError("Descriptor adapter detected a parent identity change during open.");
		if (afterIdentity.kind === "file") assertRegularPrivateFile(afterIdentity);
		if (afterIdentity.kind === "directory") assertPrivateDirectory(afterIdentity);
		const state: NodeDescriptorState = {
			file,
			path,
			rootPath,
			chain:
				parentChain === undefined
					? { paths: [path], identities: [afterIdentity] }
					: {
							paths: [...parentChain.paths, path],
							identities: [...parentChain.identities, afterIdentity],
						},
			kind: afterIdentity.kind,
			identityDigest: afterIdentity.identityDigest,
			device: afterIdentity.device,
			inode: afterIdentity.inode,
			closed: false,
		};
		const handle: WorkflowDescriptorHandle = {
			identityDigest: state.identityDigest,
			write: async (bytes) => {
				assertOpen(state);
				assertRegularPrivateFile(identityFromStats(await state.file.stat()));
				let offset = 0;
				while (offset < bytes.byteLength) {
					const result = await state.file.write(bytes, offset, bytes.byteLength - offset, null);
					if (result.bytesWritten <= 0) throw descriptorError("Descriptor write made no progress.");
					offset += result.bytesWritten;
				}
			},
			read: async () => {
				assertOpen(state);
				const identity = identityFromStats(await state.file.stat());
				assertRegularPrivateFile(identity);
				const size = numberStatField((await state.file.stat()).size, "file size");
				const bytes = Buffer.allocUnsafe(size);
				let offset = 0;
				while (offset < size) {
					const result = await state.file.read(bytes, offset, size - offset, offset);
					if (result.bytesRead <= 0)
						throw descriptorError("Descriptor read ended before the opened file was complete.");
					offset += result.bytesRead;
				}
				return new Uint8Array(bytes);
			},
			stat: async () => {
				assertOpen(state);
				const current = identityFromStats(await state.file.stat());
				if (current.kind !== state.kind || current.device !== state.device || current.inode !== state.inode)
					throw descriptorError("Opened descriptor identity changed.");
				return {
					kind: current.kind,
					linkCount: current.linkCount,
					device: current.device,
					identityDigest: state.identityDigest,
				};
			},
			sync: async () => {
				assertOpen(state);
				await state.file.sync();
			},
			close: async () => {
				if (state.closed) return;
				state.closed = true;
				await state.file.close();
			},
		};
		states.set(handle, state);
		return handle;
	} catch (error) {
		await file.close().catch(() => undefined);
		throw error;
	}
}

function createNativeDescriptorAdapter(): WorkflowDescriptorNativeAdapter {
	const states = new WeakMap<WorkflowDescriptorHandle, NodeDescriptorState>();

	const openRoot = async (rootPath: string): Promise<WorkflowDescriptorHandle> => {
		if (!isAbsolute(rootPath)) throw descriptorError("Descriptor root must be absolute.");
		const requestedIdentity = await statPath(rootPath);
		assertPrivateDirectory(requestedIdentity);
		return openPathHandle(
			rootPath,
			fsConstants.O_RDONLY | O_DIRECTORY,
			0o700,
			states,
			rootPath,
			undefined,
			requestedIdentity,
		);
	};

	const mkdirAt = async (
		parent: WorkflowDescriptorHandle,
		component: string,
		mode: number,
	): Promise<WorkflowDescriptorHandle> => {
		assertSafeComponent(component, "Descriptor component");
		const parentState = stateFor(states, parent);
		const parentIdentity = await assertParentStable(parentState);
		const childPath = join(parentState.path, component);
		try {
			await mkdir(childPath, { mode });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const child = await openPathHandle(
			childPath,
			fsConstants.O_RDONLY | O_DIRECTORY,
			mode,
			states,
			parentState.rootPath,
			parentState.chain,
		);
		const currentParent = await assertParentStable(parentState);
		if (!sameIdentity(parentIdentity, currentParent)) {
			await child.close().catch(() => undefined);
			throw descriptorError("Descriptor parent identity changed during mkdir.");
		}
		return child;
	};

	const openAt = async (
		parent: WorkflowDescriptorHandle,
		component: string,
		flags: number,
		mode: number,
	): Promise<WorkflowDescriptorHandle> => {
		assertSafeComponent(component, "Descriptor component");
		const parentState = stateFor(states, parent);
		const parentIdentity = await assertParentStable(parentState);
		const childPath = join(parentState.path, component);
		const child = await openPathHandle(childPath, flags, mode, states, parentState.rootPath, parentState.chain);
		try {
			const currentParent = await assertParentStable(parentState);
			if (!sameIdentity(parentIdentity, currentParent))
				throw descriptorError("Descriptor parent identity changed during open.");
			return child;
		} catch (error) {
			await child.close().catch(() => undefined);
			throw error;
		}
	};

	const renameAt = async (
		parent: WorkflowDescriptorHandle,
		fromComponent: string,
		toComponent: string,
		options: { replace: boolean; noReplace: boolean } = { replace: true, noReplace: false },
	): Promise<void> => {
		assertSafeComponent(fromComponent, "Descriptor source component");
		assertSafeComponent(toComponent, "Descriptor target component");
		if (fromComponent === toComponent) throw descriptorError("Descriptor rename source and target must differ.");
		if (options.replace === options.noReplace)
			throw descriptorError("Descriptor rename requires exactly one replacement mode.");
		const parentState = stateFor(states, parent);
		const parentIdentity = await assertParentStable(parentState);
		const sourcePath = join(parentState.path, fromComponent);
		const targetPath = join(parentState.path, toComponent);
		const sourceIdentity = await statPath(sourcePath);
		if (sourceIdentity.kind === "file") assertRegularPrivateFile(sourceIdentity);
		if (options.noReplace) {
			if (sourceIdentity.kind !== "file")
				throw descriptorError("Descriptor no-replace rename requires a regular file.");
			await link(sourcePath, targetPath);
			try {
				await unlink(sourcePath);
			} catch (error) {
				await unlink(targetPath).catch(() => undefined);
				throw error;
			}
		} else {
			await rename(sourcePath, targetPath);
		}
		const currentParent = await assertParentStable(parentState);
		if (!sameIdentity(parentIdentity, currentParent))
			throw descriptorError("Descriptor parent identity changed during rename.");
		const targetIdentity = await statPath(targetPath);
		if (!sameIdentity(sourceIdentity, targetIdentity))
			throw descriptorError("Descriptor rename target identity changed.");
	};

	const unlinkAt = async (parent: WorkflowDescriptorHandle, component: string): Promise<void> => {
		assertSafeComponent(component, "Descriptor component");
		const parentState = stateFor(states, parent);
		const parentIdentity = await assertParentStable(parentState);
		const targetPath = join(parentState.path, component);
		const targetIdentity = await statPath(targetPath);
		if (targetIdentity.kind === "file") assertRegularPrivateFile(targetIdentity);
		await unlink(targetPath);
		const currentParent = await assertParentStable(parentState);
		if (!sameIdentity(parentIdentity, currentParent))
			throw descriptorError("Descriptor parent identity changed during unlink.");
	};

	const syncDirectoryChain = async (leaf: WorkflowDescriptorHandle, root: WorkflowDescriptorHandle): Promise<void> => {
		const leafState = stateFor(states, leaf);
		const rootState = stateFor(states, root);
		assertOpen(leafState);
		assertOpen(rootState);
		const rootIdentity = identityFromStats(await rootState.file.stat());
		assertPrivateDirectory(rootIdentity);
		if (rootState.kind !== "directory") throw descriptorError("Descriptor sync root must be a directory.");
		await assertNoSymlinkComponents(rootState.rootPath, rootState.path);
		const rootPathIdentity = await statPath(rootState.path);
		if (!sameIdentity(rootIdentity, rootPathIdentity))
			throw descriptorError("Descriptor sync root path was replaced.");
		if (
			leafState.chain.paths.length !== leafState.chain.identities.length ||
			leafState.chain.paths[0] !== rootState.path ||
			leafState.chain.identities[0] === undefined ||
			!sameIdentity(leafState.chain.identities[0], rootIdentity)
		)
			throw descriptorError("Descriptor sync chain is not rooted at the opened root identity.");
		assertDescendant(rootState.path, leafState.path);
		await leafState.file.sync();
		let ancestorPath = leafState.kind === "directory" ? leafState.path : dirname(leafState.path);
		while (true) {
			assertDescendant(rootState.path, ancestorPath);
			if (ancestorPath === rootState.path) {
				await rootState.file.sync();
				return;
			}
			const ancestorIndex = leafState.chain.paths.indexOf(ancestorPath);
			if (ancestorIndex < 0 || ancestorIndex >= leafState.chain.identities.length)
				throw descriptorError("Descriptor sync chain has no original identity for an ancestor.");
			const expectedAncestorIdentity = leafState.chain.identities[ancestorIndex];
			const ancestor = await openPathHandle(
				ancestorPath,
				fsConstants.O_RDONLY | O_DIRECTORY,
				0o700,
				states,
				rootState.rootPath,
				undefined,
				expectedAncestorIdentity,
			);
			try {
				await ancestor.sync();
			} finally {
				await ancestor.close().catch(() => undefined);
			}
			const nextAncestor = dirname(ancestorPath);
			if (nextAncestor === ancestorPath) throw descriptorError("Descriptor sync chain could not reach its root.");
			ancestorPath = nextAncestor;
		}
	};

	return { openRoot, mkdirAt, openAt, renameAt, unlinkAt, syncDirectoryChain };
}

/**
 * Create the Node host implementation of the descriptor-native adapter.
 * Return: A descriptor-relative adapter backed by opened Node file handles.
 */
export function createNodeWorkflowDescriptorNativeAdapter(): WorkflowDescriptorNativeAdapter {
	return createNativeDescriptorAdapter();
}

/**
 * Create a workflow descriptor filesystem, optionally adapting an existing native port.
 * Args:
 * native: Existing public journal adapter to forward, or undefined for the Node host adapter.
 * Return: Workflow descriptor filesystem operations with deterministic opened-handle ownership.
 */
export function createNodeWorkflowDescriptorFs(native?: WorkflowDescriptorNativeAdapter): WorkflowDescriptorFs {
	if (native !== undefined) {
		return {
			openRoot: (rootPath) => native.openRoot(rootPath),
			mkdirAt: (parent, component, mode) => native.mkdirAt(parent, component, mode),
			openAt: (parent, component, flags, mode) => native.openAt(parent, component, flags, mode),
			renameAt: (parent, fromComponent, toComponent, options) =>
				native.renameAt(parent, fromComponent, toComponent, options),
			unlinkAt: (parent, component) => native.unlinkAt(parent, component),
			syncDirectoryChain: (leaf, root) => native.syncDirectoryChain(leaf, root),
		};
	}
	return createNativeDescriptorAdapter();
}
