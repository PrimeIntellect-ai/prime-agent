import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(packageDir, "../..");
const distDir = join(packageDir, "dist");
const mode = process.argv[2];

const HELPER_ASSETS = Object.freeze([
	Object.freeze({
		name: "hosted-session-store-posix-helper.py",
		size: 213852,
		digest: "e750b8b12966959b5aeba70d8aae1ec010a02714f7d5cfa9facac47423a45f13",
		sourceAnchor: "hosted-session-store.ts",
	}),
	Object.freeze({
		name: "ws-posix-helper.py",
		size: 144628,
		digest: "0241c6ddd8de0072bb5b6f7896899767cdde5b4902654f883bb92435fac78fb2",
		sourceAnchor: "prime-workspace-helper-core.ts",
	}),
]);
const helperSourceDir = join(packageDir, "src", "modes", "daemon", "sandbox");

interface HelperAsset {
	readonly name: string;
	readonly size: number;
	readonly digest: string;
	readonly sourceAnchor: string;
}
function verifyHelperInventory(directory: string): void {
	const expected = HELPER_ASSETS.map((asset) => asset.name).sort();
	const actual = readdirSync(directory)
		.filter((name) => name.endsWith("-helper.py"))
		.sort();
	if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
		throw new Error(`helper inventory mismatch: ${directory}`);
}


function sameStat(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.isFile() === right.isFile()
	);
}

function readVerifiedHelper(path: string, asset: HelperAsset, anchorPath: string): Uint8Array {
	if (realpathSync(path) !== resolve(path) || realpathSync(anchorPath) !== resolve(anchorPath))
		throw new Error(`helper or anchor is outside its exact path: ${asset.name}`);
	const pathStat = lstatSync(path);
	const anchorBefore = lstatSync(anchorPath);
	if (!anchorBefore.isFile()) throw new Error(`helper anchor is not a regular file: ${asset.name}`);
	const closeOnExec = process.platform === "darwin" ? 0x01000000 : 0x00080000;
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | closeOnExec);
	try {
		const before = fstatSync(fd);
		if (pathStat.dev !== before.dev || pathStat.ino !== before.ino) throw new Error(`helper changed during open: ${asset.name}`);
		if (!before.isFile() || before.nlink !== 1) throw new Error(`helper is not a one-link regular file: ${asset.name}`);
		if ((before.mode & 0o7777) !== 0o644 || (before.mode & 0o7022) !== 0)
			throw new Error(`helper has invalid mode: ${asset.name}`);
		const euid = process.geteuid?.();
		if (
			euid === undefined ||
			(before.uid !== euid && before.uid !== 0) ||
			before.uid !== anchorBefore.uid ||
			before.gid !== anchorBefore.gid
		)
			throw new Error(`helper has invalid owner: ${asset.name}`);
		if (before.size !== asset.size) throw new Error(`helper has invalid size: ${asset.name}`);
		const bytes = new Uint8Array(asset.size);
		let position = 0;
		while (position < bytes.byteLength) {
			const count = readSync(fd, bytes, position, bytes.byteLength - position, position);
			if (count <= 0 || count > bytes.byteLength - position) throw new Error(`helper has a short read: ${asset.name}`);
			position += count;
		}
		if (position !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.digest)
			throw new Error(`helper digest mismatch: ${asset.name}`);
		if (!sameStat(before, fstatSync(fd)) || !sameStat(anchorBefore, lstatSync(anchorPath)))
			throw new Error(`helper or anchor changed while reading: ${asset.name}`);
		return bytes;
	} finally {
		closeSync(fd);
	}
}

function copyVerifiedHelper(targetDir: string, asset: HelperAsset, bytes: Uint8Array, anchorPath: string): void {
	const target = join(targetDir, asset.name);
	const temporary = join(targetDir, `.${asset.name}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		let position = 0;
		while (position < bytes.byteLength) {
			const count = writeSync(fd, bytes, position, bytes.byteLength - position, position);
			if (count <= 0 || count > bytes.byteLength - position) throw new Error(`helper copy short write: ${asset.name}`);
			position += count;
		}
		fchmodSync(fd, 0o644);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, target);
	} finally {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(temporary);
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	readVerifiedHelper(target, asset, anchorPath);
}

function removeHelperPair(targetDir: string): void {
	for (const asset of HELPER_ASSETS) {
		try {
			unlinkSync(join(targetDir, asset.name));
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
}

async function installHelperPair(targetDir: string, targetAnchorPath: string): Promise<void> {
	try {
		verifyHelperInventory(helperSourceDir);
		const verified = HELPER_ASSETS.map((asset) =>
			Object.freeze({
				asset,
				bytes: readVerifiedHelper(
					join(helperSourceDir, asset.name),
					asset,
					join(helperSourceDir, asset.sourceAnchor),
				),
			}),
		);
		await mkdir(targetDir, { recursive: true });
		const targetStat = lstatSync(targetDir);
		if (!targetStat.isDirectory()) throw new Error(`helper target is not a directory: ${targetDir}`);
		const unexpected = readdirSync(targetDir).filter(
			(name) => name.endsWith("-helper.py") && !HELPER_ASSETS.some((asset) => asset.name === name),
		);
		if (unexpected.length !== 0) throw new Error(`helper inventory mismatch: ${targetDir}`);
		for (const entry of verified) copyVerifiedHelper(targetDir, entry.asset, entry.bytes, targetAnchorPath);
		verifyHelperInventory(targetDir);
	} catch (error) {
		removeHelperPair(targetDir);
		throw error;
	}
}

async function copyFiles(sourceDir: string, targetDir: string, suffix: string): Promise<void> {
	await mkdir(targetDir, { recursive: true });
	for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(suffix)) {
			await cp(join(sourceDir, entry.name), join(targetDir, entry.name));
		}
	}
}

const excludedReleaseDirectoryNames = new Set(["node_modules", ".venv", "__pycache__", ".pytest_cache"]);

function includeReleasePath(source: string): boolean {
	return !source.split(/[\\/]/).some((part) => excludedReleaseDirectoryNames.has(part));
}

async function replaceDirectory(source: string, target: string): Promise<void> {
	await rm(target, { recursive: true, force: true });
	await cp(source, target, { recursive: true, filter: includeReleasePath });
}

async function copyFile(source: string, targetDir: string): Promise<void> {
	await mkdir(targetDir, { recursive: true });
	await cp(source, join(targetDir, basename(source)));
}

async function copyPackageAssets(): Promise<void> {
	const helperTarget = join(distDir, "modes", "daemon", "sandbox");
	removeHelperPair(helperTarget);
	try {
		await chmod(join(distDir, "cli.js"), 0o755);
		await copyFiles(join(packageDir, "src/modes/interactive/theme"), join(distDir, "modes/interactive/theme"), ".json");
		await copyFiles(join(packageDir, "src/modes/interactive/assets"), join(distDir, "modes/interactive/assets"), ".png");
		const exportDir = join(distDir, "core/export-html");
		for (const name of ["template.html", "template.css", "template.js"]) {
			await copyFile(join(packageDir, "src/core/export-html", name), exportDir);
		}
		await copyFiles(join(packageDir, "src/core/export-html/vendor"), join(exportDir, "vendor"), ".js");
		await replaceDirectory(join(repoDir, "prime-agent-runtime"), join(distDir, "prime-agent-runtime"));
		await replaceDirectory(join(packageDir, "skills"), join(distDir, "skills"));
		await installHelperPair(helperTarget, join(distDir, "cli.js"));
	} catch (error) {
		removeHelperPair(helperTarget);
		throw error;
	}
}

async function copyBinaryAssets(): Promise<void> {
	const binary = join(distDir, "pi");
	removeHelperPair(distDir);
	try {
		const binaryStat = lstatSync(binary);
		if (!binaryStat.isFile()) throw new Error("dist/pi must exist before binary assets are copied");
		for (const name of ["package.json", "README.md", "CHANGELOG.md"]) {
			await copyFile(join(packageDir, name), distDir);
		}
		await copyFile(join(repoDir, "install.sh"), distDir);
		await copyFiles(join(packageDir, "src/modes/interactive/theme"), join(distDir, "theme"), ".json");
		await copyFiles(join(packageDir, "src/modes/interactive/assets"), join(distDir, "assets"), ".png");
		for (const name of ["template.html", "template.css", "template.js"]) {
			await copyFile(join(packageDir, "src/core/export-html", name), join(distDir, "export-html"));
		}
		await copyFiles(join(packageDir, "src/core/export-html/vendor"), join(distDir, "export-html/vendor"), ".js");
		await replaceDirectory(join(packageDir, "docs"), join(distDir, "docs"));
		await replaceDirectory(join(packageDir, "examples"), join(distDir, "examples"));
		await copyFile(join(repoDir, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"), distDir);
		await replaceDirectory(join(repoDir, "prime-agent-runtime"), join(distDir, "prime-agent-runtime"));
		await replaceDirectory(join(packageDir, "skills"), join(distDir, "skills"));
		await installHelperPair(distDir, binary);
	} catch (error) {
		removeHelperPair(distDir);
		throw error;
	}
}

if (mode === "package") {
	await copyPackageAssets();
} else if (mode === "binary") {
	await copyBinaryAssets();
} else {
	console.error("Usage: bun scripts/copy-assets.ts <package|binary>");
	process.exit(2);
}
