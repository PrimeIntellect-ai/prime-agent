import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const NATIVE_RELEASE_ASSETS = [
	"prime-agent",
	"package.json",
	"install.sh",
	"prime-agent-runtime/pyproject.toml",
	"prime-agent-runtime/src/rlm/repl.py",
	"theme/prime.json",
	"export-html/template.html",
	"photon_rs_bg.wasm",
	".archive-sha256",
	".install-source",
] as const;

interface NativeInstallationTarget {
	root: string;
	launcher: string;
	executable: string;
	releaseDir: string;
	version: string;
	platform: string;
	sha256: string;
}

export interface NativeInstallation extends NativeInstallationTarget {
	baseUrl: string;
}

function readNativeTarget(root: string, link: string, recoveredTarget?: string): NativeInstallationTarget | undefined {
	try {
		root = realpathSync(root);
		for (const part of [".managed", "bin", "releases"]) {
			if (lstatSync(join(root, part)).isSymbolicLink()) return undefined;
		}
		if (readFileSync(join(root, ".managed"), "utf8").trim() !== "prime-agent-native-v1") return undefined;
		const launcher = join(root, "bin", link);
		const target = recoveredTarget ?? readlinkSync(launcher);
		const match =
			/^\.\.\/releases\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(darwin|linux)-(arm64|x64)-([a-f0-9]{64})(?:\.[A-Za-z0-9]{6})?\/prime-agent$/.exec(
				target,
			);
		if (!match) return undefined;
		const executable = resolve(dirname(launcher), target);
		const releaseDir = dirname(executable);
		return {
			root,
			launcher,
			executable,
			releaseDir,
			version: match[1],
			platform: `${match[2]}-${match[3]}`,
			sha256: match[4],
		};
	} catch {
		return undefined;
	}
}

export function readNativeInstallation(root: string, link = "prime-agent"): NativeInstallation | undefined {
	return validateNativeInstallation(readNativeTarget(root, link));
}

function validateNativeInstallation(target: NativeInstallationTarget | undefined): NativeInstallation | undefined {
	try {
		if (!target) return undefined;
		const { executable, releaseDir } = target;
		if (realpathSync(executable) !== executable) return undefined;
		for (const asset of NATIVE_RELEASE_ASSETS) {
			const assetPath = join(releaseDir, asset);
			if (!lstatSync(assetPath).isFile() || lstatSync(assetPath).isSymbolicLink()) return undefined;
			if (realpathSync(dirname(assetPath)) !== dirname(assetPath)) return undefined;
		}
		if (readFileSync(join(releaseDir, ".archive-sha256"), "utf8").trim() !== target.sha256) return undefined;
		const metadata = JSON.parse(readFileSync(join(releaseDir, "package.json"), "utf8")) as { version?: unknown };
		if (metadata.version !== target.version) return undefined;
		const baseUrl = readFileSync(join(releaseDir, ".install-source"), "utf8").trim();
		if (!["https:", "http:"].includes(new URL(baseUrl).protocol)) return undefined;
		return { ...target, baseUrl };
	} catch {
		return undefined;
	}
}

export function readNativeRollbackInstallation(root: string): NativeInstallation | undefined {
	const statePath = join(root, ".activation-state");
	const state = lstatSync(statePath, { throwIfNoEntry: false });
	if (!state) return readNativeInstallation(root, "previous");
	const invalid = () =>
		new Error(
			`Invalid or ambiguous activation recovery state at ${statePath}. Restore the recorded links before retrying.`,
		);
	if (!state.isFile() || state.isSymbolicLink()) throw invalid();
	const recorded = /^([^\n]+)\n([^\n]*)\n$/.exec(readFileSync(statePath, "utf8"));
	if (!recorded) throw invalid();
	const target = validateNativeInstallation(readNativeTarget(root, "prime-agent", recorded[1]));
	const previous = recorded[2]
		? validateNativeInstallation(readNativeTarget(root, "previous", recorded[2]))
		: undefined;
	if (!target || (recorded[2] && !previous)) throw invalid();
	const current = readNativeTarget(root, "prime-agent");
	// Planning predicts the locked installer's recovery without modifying either launcher.
	if (current?.executable === target.executable) return previous;
	if (previous && current?.executable === previous.executable) return readNativeInstallation(root, "previous");
	throw invalid();
}

export function getNativeInstallation(executable = process.execPath): NativeInstallation | undefined {
	const target = getNativeInstallationTarget(executable);
	return target ? readNativeInstallation(target.root) : undefined;
}

export function getNativeInstallationTarget(executable = process.execPath): NativeInstallationTarget | undefined {
	try {
		const actual = realpathSync(executable);
		const root = resolve(dirname(actual), "../..");
		const installation = readNativeTarget(root, "prime-agent");
		// A running process may belong to the previous release after activation.
		return installation && dirname(dirname(actual)) === join(root, "releases") ? installation : undefined;
	} catch {
		return undefined;
	}
}
