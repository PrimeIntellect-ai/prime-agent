import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import {
	KERNEL_PROCESS_SANDBOX_ENV,
	KERNEL_SANDBOX_CONNECTION_PLACEHOLDER,
	KERNEL_SANDBOX_PYTHON_PLACEHOLDER,
} from "../core/kernel/index.js";

export interface IsolatedEvaluationSandboxOptions {
	command: readonly string[];
	cwd: string;
	privateHome: string;
	writablePaths: readonly string[];
	readOnlyPaths: readonly string[];
	hiddenPaths?: readonly string[];
	maskedFiles?: readonly string[];
	rootFilesystem?: "host-read-only" | "minimal";
	deviceFilesystem?: "minimal" | "host";
}

export interface EvaluationKernelSandboxOptions {
	cwd: string;
	privateHome: string;
	kernelPython: string;
	writablePaths: readonly string[];
	readOnlyPaths: readonly string[];
	maskedFiles?: readonly string[];
	inheritEnvironment: readonly string[];
	hostDevices?: boolean;
}

function normalizedAbsolutePath(path: string, label: string): string {
	if (!isAbsolute(path)) throw new Error(`${label} must be absolute: ${path}`);
	return resolve(path);
}

function pathWithin(root: string, path: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

function uniquePaths(paths: readonly string[], label: string): string[] {
	return [...new Set(paths.map((path) => normalizedAbsolutePath(path, label)))];
}

function minimalSystemArguments(deviceFilesystem: "minimal" | "host"): string[] {
	const deviceArguments = deviceFilesystem === "host" ? ["--dev-bind", "/dev", "/dev"] : ["--dev", "/dev"];
	const args = [
		"--tmpfs",
		"/",
		"--proc",
		"/proc",
		...deviceArguments,
		"--tmpfs",
		"/dev/shm",
		"--ro-bind",
		"/usr",
		"/usr",
	];
	for (const path of ["/bin", "/lib", "/lib64", "/sbin"]) {
		if (!existsSync(path)) continue;
		if (lstatSync(path).isSymbolicLink()) {
			args.push("--symlink", readlinkSync(path), path);
		} else {
			args.push("--ro-bind", path, path);
		}
	}
	for (const path of [
		"/etc/group",
		"/etc/hosts",
		"/etc/localtime",
		"/etc/nsswitch.conf",
		"/etc/passwd",
		"/etc/ssl/certs/ca-certificates.crt",
	]) {
		if (existsSync(path)) args.push("--ro-bind", path, path);
	}
	return args;
}

export function buildIsolatedEvaluationSandboxArgs(options: IsolatedEvaluationSandboxOptions): string[] {
	if (options.command.length === 0) throw new Error("evaluation sandbox command is required");
	const privateHome = normalizedAbsolutePath(options.privateHome, "evaluation sandbox private home");
	if (privateHome === sep) throw new Error("evaluation sandbox private home cannot be the filesystem root");
	const cwd = normalizedAbsolutePath(options.cwd, "evaluation sandbox cwd");
	const writablePaths = uniquePaths(options.writablePaths, "evaluation sandbox writable path");
	const readOnlyPaths = uniquePaths(options.readOnlyPaths, "evaluation sandbox read-only path");
	const mounts = [...writablePaths, ...readOnlyPaths];
	const requestedHiddenPaths = uniquePaths(options.hiddenPaths ?? [], "evaluation sandbox hidden path");
	const maskedFiles = uniquePaths(options.maskedFiles ?? [], "evaluation sandbox masked file");
	for (const hiddenPath of requestedHiddenPaths.filter((path) => pathWithin(privateHome, path))) {
		const exposingMount = mounts.find((path) => pathWithin(path, hiddenPath));
		if (exposingMount) {
			throw new Error(`evaluation sandbox read mount ${exposingMount} would expose hidden path ${hiddenPath}`);
		}
	}
	const hiddenPaths = requestedHiddenPaths.filter((path) => !pathWithin(privateHome, path));
	const writableSet = new Set(writablePaths);
	const duplicateMount = readOnlyPaths.find((path) => writableSet.has(path));
	if (duplicateMount)
		throw new Error(`evaluation sandbox path cannot be both writable and read-only: ${duplicateMount}`);
	if (mounts.includes(privateHome)) {
		throw new Error("evaluation sandbox cannot expose the complete private home");
	}

	const homeParents = new Set<string>();
	for (const path of mounts) {
		if (!pathWithin(privateHome, path)) continue;
		for (let parent = dirname(path); parent !== privateHome; parent = dirname(parent)) {
			if (!pathWithin(privateHome, parent)) {
				throw new Error(`evaluation sandbox mount escapes the private home: ${path}`);
			}
			homeParents.add(parent);
		}
	}
	const orderedHomeParents = [...homeParents].sort(
		(left, right) => left.split(sep).length - right.split(sep).length || left.localeCompare(right),
	);
	const rootArguments =
		options.rootFilesystem === "minimal"
			? minimalSystemArguments(options.deviceFilesystem ?? "minimal")
			: ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc"];

	return [
		"bwrap",
		...rootArguments,
		"--tmpfs",
		"/tmp",
		"--tmpfs",
		"/run",
		"--unshare-net",
		"--tmpfs",
		privateHome,
		...hiddenPaths.flatMap((path) => ["--tmpfs", path]),
		...orderedHomeParents.flatMap((path) => ["--dir", path]),
		...writablePaths.flatMap((path) => ["--bind", path, path]),
		...readOnlyPaths.flatMap((path) => ["--ro-bind", path, path]),
		...maskedFiles.flatMap((path) => ["--ro-bind", "/dev/null", path]),
		"--unshare-pid",
		"--die-with-parent",
		"--chdir",
		cwd,
		"--",
		...options.command,
	];
}

export function buildEvaluationKernelSandboxEnvironment(options: EvaluationKernelSandboxOptions): NodeJS.ProcessEnv {
	const kernelRoot = dirname(dirname(options.kernelPython));
	// The venv executable may point through a floating cpython-X.Y-* alias, so
	// expose the containing catalog rather than only the pinned realpath target.
	const interpreterCatalogRoot = dirname(dirname(dirname(realpathSync(options.kernelPython))));
	const readOnlyPaths = [kernelRoot, interpreterCatalogRoot, ...options.readOnlyPaths]
		.filter((path) => existsSync(path))
		.filter((path, index, paths) => paths.indexOf(path) === index);
	const argv = buildIsolatedEvaluationSandboxArgs({
		command: [
			KERNEL_SANDBOX_PYTHON_PLACEHOLDER,
			"-m",
			"ipykernel_launcher",
			"-f",
			KERNEL_SANDBOX_CONNECTION_PLACEHOLDER,
		],
		cwd: options.cwd,
		privateHome: options.privateHome,
		writablePaths: options.writablePaths,
		readOnlyPaths,
		maskedFiles: options.maskedFiles,
		rootFilesystem: "minimal",
		deviceFilesystem: options.hostDevices ? "host" : "minimal",
	});
	return {
		[KERNEL_PROCESS_SANDBOX_ENV]: JSON.stringify({
			version: 1,
			argv,
			home: options.privateHome,
			inheritEnvironment: [...new Set(options.inheritEnvironment)],
		}),
	};
}
