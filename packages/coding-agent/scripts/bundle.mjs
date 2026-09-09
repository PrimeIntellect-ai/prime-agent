#!/usr/bin/env bun
/**
 * Bundles the compiled CLI entry and its two fixed Python helper assets.
 */
import { execFileSync } from "node:child_process";
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
	readFileSync,
	readSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(packageDir, "dist", "bundle");
const sourceDir = join(packageDir, "src", "modes", "daemon", "sandbox");
const unbundledDir = join(packageDir, "dist", "modes", "daemon", "sandbox");
const HELPER_ASSETS = Object.freeze([
	Object.freeze({
		name: "hosted-session-store-posix-helper.py",
		size: 240996,
		digest: "c1caa6d23942fc2bf5f11993f71cd0a7431de1f467444a9b00bad459fbcfa56f",
		sourceAnchor: "hosted-session-store.ts",
	}),
	Object.freeze({
		name: "ws-posix-helper.py",
		size: 144628,
		digest: "0241c6ddd8de0072bb5b6f7896899767cdde5b4902654f883bb92435fac78fb2",
		sourceAnchor: "prime-workspace-helper-core.ts",
	}),
]);
function verifyHelperInventory(directory) {
	const expected = HELPER_ASSETS.map((asset) => asset.name).sort();
	const actual = readdirSync(directory)
		.filter((name) => name.endsWith("-helper.py"))
		.sort();
	if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
		throw new Error(`helper inventory mismatch: ${directory}`);
}


function sameStat(left, right) {
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

function readVerifiedHelper(path, asset, anchorPath) {
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

function copyVerifiedHelper(asset, bytes, anchorPath) {
	const target = join(outdir, asset.name);
	const temporary = join(outdir, `.${asset.name}.${process.pid}.${randomUUID()}.tmp`);
	let fd;
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
			if (!(typeof error === "object" && error !== null && error.code === "ENOENT")) throw error;
		}
	}
	readVerifiedHelper(target, asset, anchorPath);
}

rmSync(outdir, { recursive: true, force: true });
try {
	let buildId;
	try {
		buildId = execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
			cwd: dirname(packageDir),
			encoding: "utf8",
		}).trim();
	} catch {
		buildId = `release-${JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version}`;
	}
	const result = await Bun.build({
		entrypoints: [join(packageDir, "dist", "cli.js")],
		outdir,
		splitting: true,
		format: "esm",
		target: "bun",
		sourcemap: "linked",
		external: ["koffi", "undici", "@silvia-odwyer/photon-node", "@mariozechner/clipboard"],
		define: {
			__PI_BUNDLED__: "true",
			__PI_BUILD_ID__: JSON.stringify(buildId),
		},
		banner: `import { createRequire as __piBundleCreateRequire } from 'node:module'; const require = __piBundleCreateRequire(import.meta.url);`,
		naming: {
			entry: "[name].js",
			chunk: "[name]-[hash].js",
		},
		throw: false,
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error("bundle build failed");
	}

	verifyHelperInventory(sourceDir);
	verifyHelperInventory(unbundledDir);
	const unbundledAnchor = join(packageDir, "dist", "cli.js");
	const bundleAnchor = join(outdir, "cli.js");
	chmodSync(bundleAnchor, 0o755);
	for (const asset of HELPER_ASSETS) {
		const source = readVerifiedHelper(join(sourceDir, asset.name), asset, join(sourceDir, asset.sourceAnchor));
		const unbundled = readVerifiedHelper(join(unbundledDir, asset.name), asset, unbundledAnchor);
		if (!source.every((byte, index) => byte === unbundled[index])) throw new Error(`helper copies differ: ${asset.name}`);
		copyVerifiedHelper(asset, unbundled, bundleAnchor);
	}
	verifyHelperInventory(outdir);
	console.log("bundled dist/cli.js -> dist/bundle/");
} catch (error) {
	rmSync(outdir, { recursive: true, force: true });
	throw error;
}
