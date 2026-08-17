import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fchownSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_FILE_SYSTEM_UNSUPPORTED_ERROR = "Private file storage requires O_NOFOLLOW support";

export function requireNoFollow(flag: number | undefined): number {
	if (flag === undefined || flag === null) throw new Error(PRIVATE_FILE_SYSTEM_UNSUPPORTED_ERROR);
	return flag;
}

const NONBLOCK_FLAG = constants.O_NONBLOCK ?? 0;
const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0;

function pathExistsLexical(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function ensureNoSymlinkPath(path: string, mode: number): void {
	const target = resolve(path);
	const root = parse(target).root;
	const components = target.slice(root.length).split(/[/\\]/).filter(Boolean);
	let current = root;
	for (const [index, component] of components.entries()) {
		current = join(current, component);
		if (!pathExistsLexical(current)) {
			try {
				mkdirSync(current, { mode });
			} catch (error) {
				if (!isAlreadyExistsError(error)) throw error;
			}
		}
		const stats = lstatSync(current);
		if (index === 0 && stats.isSymbolicLink()) {
			current = realpathSync(current);
			continue;
		}
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw new Error(`Refusing to use non-directory private path: ${current}`);
		}
	}
}

function setPrivateFileMode(fd: number, path: string, mode: number): void {
	if (process.platform === "win32") {
		chmodSync(path, mode);
	} else {
		fchmodSync(fd, mode);
	}
}

function isAlreadyExistsError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function openRegularFileNoSymlink(path: string, flags: number): number {
	assertRegularFileNoSymlink(path);
	const fd = openSync(path, flags | requireNoFollow(constants.O_NOFOLLOW) | NONBLOCK_FLAG);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`Refusing to use non-regular private file: ${path}`);
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

export function assertRegularFileNoSymlink(path: string): void {
	const stats = lstatSync(path);
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`Refusing to use non-regular private file: ${path}`);
	}
}

export function ensurePrivateDirectory(path: string): void {
	ensureNoSymlinkPath(path, PRIVATE_DIRECTORY_MODE);
	const stats = lstatSync(path);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error(`Refusing to use non-directory private path: ${path}`);
	}
	if (process.platform === "win32") {
		if ((stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) chmodSync(path, PRIVATE_DIRECTORY_MODE);
		return;
	}
	const fd = openSync(path, constants.O_RDONLY | DIRECTORY_FLAG | requireNoFollow(constants.O_NOFOLLOW));
	try {
		const openedStats = fstatSync(fd);
		if (!openedStats.isDirectory()) throw new Error(`Refusing to use non-directory private path: ${path}`);
		if ((openedStats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
			setPrivateFileMode(fd, path, PRIVATE_DIRECTORY_MODE);
		}
	} finally {
		closeSync(fd);
	}
}

export function ensurePrivateFile(path: string, initialContent = ""): void {
	ensurePrivateDirectory(dirname(path));
	if (!pathExistsLexical(path)) {
		let fd: number | undefined;
		try {
			fd = openSync(
				path,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requireNoFollow(constants.O_NOFOLLOW),
				PRIVATE_FILE_MODE,
			);
			writeFileSync(fd, initialContent);
		} catch (error) {
			// Another process may have won the exclusive-create race. The regular-file
			// check below validates its result without ever following a symlink.
			if (!isAlreadyExistsError(error)) {
				if (fd !== undefined) {
					const created = fstatSync(fd);
					closeSync(fd);
					fd = undefined;
					try {
						const current = lstatSync(path);
						if (current.dev === created.dev && current.ino === created.ino) rmSync(path, { force: true });
					} catch (cleanupError) {
						if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) {
							throw cleanupError;
						}
					}
				}
				throw error;
			}
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	const privateFd = openRegularFileNoSymlink(path, constants.O_RDONLY);
	try {
		setPrivateFileMode(privateFd, path, PRIVATE_FILE_MODE);
	} finally {
		closeSync(privateFd);
	}
}

export function readPrivateFile(path: string, encoding: BufferEncoding): string {
	const fd = openRegularFileNoSymlink(path, constants.O_RDONLY);
	try {
		setPrivateFileMode(fd, path, PRIVATE_FILE_MODE);
		return readFileSync(fd, encoding);
	} finally {
		closeSync(fd);
	}
}

function ensureParentDirectory(path: string, privateParent: boolean): void {
	const parent = dirname(path);
	if (privateParent) {
		ensurePrivateDirectory(parent);
		return;
	}
	const parentExisted = pathExistsLexical(parent);
	ensureNoSymlinkPath(parent, PRIVATE_DIRECTORY_MODE);
	if (!lstatSync(parent).isDirectory()) throw new Error(`Refusing to use non-directory private path: ${parent}`);
	if (!parentExisted) chmodSync(parent, PRIVATE_DIRECTORY_MODE);
}

export function writePrivateFileAtomic(
	path: string,
	content: string | Uint8Array,
	options: { privateParent?: boolean } = {},
): void {
	ensureParentDirectory(path, options.privateParent !== false);
	if (pathExistsLexical(path)) {
		assertRegularFileNoSymlink(path);
	}
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(
			tempPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requireNoFollow(constants.O_NOFOLLOW),
			PRIVATE_FILE_MODE,
		);
		writeFileSync(fd, content);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(tempPath, { force: true });
	}
}

export function writePrivateFileAtomicLines(
	path: string,
	lines: Iterable<string>,
	options: { preserveOwnership?: boolean; privateParent?: boolean } = {},
): void {
	ensureParentDirectory(path, options.privateParent !== false);
	if (pathExistsLexical(path)) assertRegularFileNoSymlink(path);
	const metadata = options.preserveOwnership && pathExistsLexical(path) ? statSync(path) : undefined;
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(
			tempPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requireNoFollow(constants.O_NOFOLLOW),
			PRIVATE_FILE_MODE,
		);
		for (const line of lines) writeFileSync(fd, line);
		fsyncSync(fd);
		if (metadata && process.platform !== "win32") fchownSync(fd, metadata.uid, metadata.gid);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(tempPath, { force: true });
	}
}

export function appendPrivateFile(path: string, content: string, options: { privateParent?: boolean } = {}): void {
	ensureParentDirectory(path, options.privateParent !== false);
	let flags = constants.O_WRONLY | constants.O_APPEND | requireNoFollow(constants.O_NOFOLLOW) | NONBLOCK_FLAG;
	const exists = pathExistsLexical(path);
	if (exists) {
		assertRegularFileNoSymlink(path);
	} else {
		flags |= constants.O_CREAT | constants.O_EXCL;
	}
	let fd: number;
	try {
		fd = openSync(path, flags, PRIVATE_FILE_MODE);
	} catch (error) {
		if (!isAlreadyExistsError(error) || exists) throw error;
		fd = openRegularFileNoSymlink(path, constants.O_WRONLY | constants.O_APPEND);
	}
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`Refusing to use non-regular private file: ${path}`);
		setPrivateFileMode(fd, path, PRIVATE_FILE_MODE);
		writeFileSync(fd, content);
	} finally {
		closeSync(fd);
	}
}

export interface PrivateTempFile {
	path: string;
	directory: string;
}

export function createPrivateTempFile(prefix: string, suffix: string, content = ""): PrivateTempFile {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	chmodSync(directory, PRIVATE_DIRECTORY_MODE);
	const path = join(directory, `${randomUUID()}${suffix}`);
	try {
		ensurePrivateFile(path, content);
		return { path, directory };
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}
