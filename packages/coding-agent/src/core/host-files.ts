import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

type HostFileData = string | NodeJS.ArrayBufferView;

interface ParentHandle {
	path: string;
	close(): void;
}

function boundedParts(relativePath: string): string[] {
	const normalized = relativePath.replaceAll("\\", "/");
	if (
		!normalized ||
		normalized === "." ||
		isAbsolute(relativePath) ||
		normalized.startsWith("/") ||
		normalized.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new Error(`host path must be a bounded relative path: ${relativePath}`);
	}
	return normalized.split("/");
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function descriptorPath(descriptor: number): string | undefined {
	for (const root of ["/proc/self/fd", "/dev/fd"]) {
		try {
			const path = join(root, String(descriptor));
			if (lstatSync(path).isSymbolicLink()) return path;
		} catch {
			// Try the next platform-specific descriptor filesystem.
		}
	}
	return undefined;
}

function directoryFlags(): number {
	return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

function openDirectory(path: string): number {
	try {
		const descriptor = openSync(path, directoryFlags());
		if (!fstatSync(descriptor).isDirectory()) {
			closeSync(descriptor);
			throw new Error(`host path is not a directory: ${path}`);
		}
		return descriptor;
	} catch (error) {
		if (["ELOOP", "ENOTDIR"].includes(errorCode(error) ?? "")) {
			try {
				if (lstatSync(path).isSymbolicLink()) throw new Error(`host path contains a symbolic link: ${path}`);
			} catch (inspectionError) {
				if (inspectionError instanceof Error && inspectionError.message.startsWith("host path contains")) {
					throw inspectionError;
				}
			}
		}
		throw error;
	}
}

function openParent(root: string, relativePath: string, createParents: boolean): ParentHandle {
	const parts = boundedParts(relativePath);
	parts.pop();
	const absoluteRoot = resolve(root);
	const rootMetadata = lstatSync(absoluteRoot);
	if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
		throw new Error(`host root must be a non-symlink directory: ${absoluteRoot}`);
	}
	let descriptor = openDirectory(absoluteRoot);
	let descriptorBase = descriptorPath(descriptor);
	let currentPath = absoluteRoot;
	try {
		for (const part of parts) {
			const childPath = descriptorBase ? join(descriptorBase, part) : join(currentPath, part);
			let childDescriptor: number;
			try {
				childDescriptor = openDirectory(childPath);
			} catch (error) {
				if (!createParents || errorCode(error) !== "ENOENT") throw error;
				mkdirSync(childPath, { mode: 0o700 });
				childDescriptor = openDirectory(childPath);
			}
			closeSync(descriptor);
			descriptor = childDescriptor;
			descriptorBase = descriptorPath(descriptor);
			currentPath = join(currentPath, part);
		}
		return {
			path: descriptorBase ?? currentPath,
			close: () => closeSync(descriptor),
		};
	} catch (error) {
		closeSync(descriptor);
		throw error;
	}
}

function leafPath(parent: ParentHandle, relativePath: string): string {
	return join(parent.path, boundedParts(relativePath).at(-1)!);
}

function rejectSymlink(path: string): void {
	try {
		if (lstatSync(path).isSymbolicLink()) throw new Error(`host path contains a symbolic link: ${path}`);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

export function hostPathKind(root: string, relativePath: string): "missing" | "file" | "directory" | "other" {
	let parent: ParentHandle;
	try {
		parent = openParent(root, relativePath, false);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return "missing";
		throw error;
	}
	try {
		const path = leafPath(parent, relativePath);
		try {
			const metadata = lstatSync(path);
			if (metadata.isSymbolicLink()) throw new Error(`host path contains a symbolic link: ${path}`);
			if (metadata.isFile()) return "file";
			if (metadata.isDirectory()) return "directory";
			return "other";
		} catch (error) {
			if (errorCode(error) === "ENOENT") return "missing";
			throw error;
		}
	} finally {
		parent.close();
	}
}

export function createFreshHostDirectory(root: string, relativePath: string, mode = 0o700): string {
	const parent = openParent(root, relativePath, true);
	try {
		const path = leafPath(parent, relativePath);
		rejectSymlink(path);
		try {
			mkdirSync(path, { mode });
		} catch (error) {
			if (errorCode(error) === "EEXIST") {
				throw new Error(`host directory already exists; refusing unsafe reuse: ${resolve(root, relativePath)}`);
			}
			throw error;
		}
		const descriptor = openDirectory(path);
		closeSync(descriptor);
		return resolve(root, relativePath);
	} finally {
		parent.close();
	}
}

export function renameHostDirectory(root: string, sourceRelativePath: string, destinationRelativePath: string): void {
	const sourceParent = openParent(root, sourceRelativePath, false);
	const destinationParent = openParent(root, destinationRelativePath, true);
	try {
		const source = leafPath(sourceParent, sourceRelativePath);
		const destination = leafPath(destinationParent, destinationRelativePath);
		const sourceMetadata = lstatSync(source);
		if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) {
			throw new Error(`host directory must remain a non-symlink directory: ${resolve(root, sourceRelativePath)}`);
		}
		if (hostPathKind(root, destinationRelativePath) !== "missing") {
			throw new Error(`host archive destination already exists: ${resolve(root, destinationRelativePath)}`);
		}
		renameSync(source, destination);
	} finally {
		destinationParent.close();
		sourceParent.close();
	}
}

function openHostFile(
	root: string,
	relativePath: string,
	flags: number,
	mode: number,
	createParents = true,
): {
	descriptor: number;
	parent: ParentHandle;
} {
	const parent = openParent(root, relativePath, createParents);
	const path = leafPath(parent, relativePath);
	rejectSymlink(path);
	try {
		try {
			if (!lstatSync(path).isFile())
				throw new Error(`host path is not a regular file: ${resolve(root, relativePath)}`);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		const descriptor = openSync(path, flags | constants.O_NOFOLLOW, mode);
		if (!fstatSync(descriptor).isFile()) {
			closeSync(descriptor);
			throw new Error(`host path is not a regular file: ${resolve(root, relativePath)}`);
		}
		return { descriptor, parent };
	} catch (error) {
		parent.close();
		if (errorCode(error) === "ELOOP") {
			throw new Error(`host path contains a symbolic link: ${resolve(root, relativePath)}`);
		}
		throw error;
	}
}

export function writeHostFile(
	root: string,
	relativePath: string,
	data: HostFileData,
	options: { mode?: number; exclusive?: boolean } = {},
): void {
	const opened = openHostFile(
		root,
		relativePath,
		constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (options.exclusive ? constants.O_EXCL : 0),
		options.mode ?? 0o600,
	);
	try {
		writeFileSync(opened.descriptor, data);
		fsyncSync(opened.descriptor);
		fchmodSync(opened.descriptor, options.mode ?? 0o600);
	} finally {
		closeSync(opened.descriptor);
		opened.parent.close();
	}
}

export function appendHostFile(root: string, relativePath: string, data: HostFileData, mode = 0o600): void {
	const opened = openHostFile(root, relativePath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, mode);
	try {
		writeFileSync(opened.descriptor, data);
		fsyncSync(opened.descriptor);
	} finally {
		closeSync(opened.descriptor);
		opened.parent.close();
	}
}

export function readHostFile(root: string, relativePath: string): Buffer {
	const opened = openHostFile(root, relativePath, constants.O_RDONLY, 0o600, false);
	try {
		return readFileSync(opened.descriptor);
	} finally {
		closeSync(opened.descriptor);
		opened.parent.close();
	}
}

export function copyHostFile(
	sourcePath: string,
	destinationRoot: string,
	destinationRelativePath: string,
	mode = 0o600,
): void {
	let sourceDescriptor: number;
	try {
		sourceDescriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (errorCode(error) === "ELOOP")
			throw new Error(`host fixture source must not be a symbolic link: ${sourcePath}`);
		throw error;
	}
	try {
		if (!fstatSync(sourceDescriptor).isFile()) {
			throw new Error(`host fixture source must be a regular file: ${sourcePath}`);
		}
		const opened = openHostFile(
			destinationRoot,
			destinationRelativePath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			mode,
		);
		try {
			const buffer = Buffer.allocUnsafe(64 * 1024);
			for (let bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, null); bytesRead > 0; ) {
				let offset = 0;
				while (offset < bytesRead) offset += writeSync(opened.descriptor, buffer, offset, bytesRead - offset);
				bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
			}
			fsyncSync(opened.descriptor);
			fchmodSync(opened.descriptor, mode);
		} finally {
			closeSync(opened.descriptor);
			opened.parent.close();
		}
	} finally {
		closeSync(sourceDescriptor);
	}
}
