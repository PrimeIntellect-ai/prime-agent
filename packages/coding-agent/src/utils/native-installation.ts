import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface NativeInstallation {
	root: string;
	launcher: string;
	executable: string;
	releaseDir: string;
	version: string;
	platform: string;
	sha256: string;
	baseUrl: string;
}

export function readNativeInstallation(root: string, link = "prime-agent"): NativeInstallation | undefined {
	try {
		root = realpathSync(root);
		for (const part of [".managed", "bin", "releases"]) {
			if (lstatSync(join(root, part)).isSymbolicLink()) return undefined;
		}
		if (readFileSync(join(root, ".managed"), "utf8").trim() !== "prime-agent-native-v1") return undefined;
		const launcher = join(root, "bin", link);
		const target = readlinkSync(launcher);
		const match =
			/^\.\.\/releases\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(darwin|linux)-(arm64|x64)-([a-f0-9]{64})(?:\.[A-Za-z0-9]{6})?\/prime-agent$/.exec(
				target,
			);
		if (!match) return undefined;
		const executable = resolve(dirname(launcher), target);
		if (realpathSync(executable) !== executable) return undefined;
		const releaseDir = dirname(executable);
		if (readFileSync(join(releaseDir, ".archive-sha256"), "utf8").trim() !== match[4]) return undefined;
		const metadata = JSON.parse(readFileSync(join(releaseDir, "package.json"), "utf8")) as { version?: unknown };
		if (metadata.version !== match[1]) return undefined;
		const baseUrl = readFileSync(join(releaseDir, ".install-source"), "utf8").trim();
		if (!["https:", "http:"].includes(new URL(baseUrl).protocol)) return undefined;
		return {
			root,
			launcher,
			executable,
			releaseDir,
			version: match[1],
			platform: `${match[2]}-${match[3]}`,
			sha256: match[4],
			baseUrl,
		};
	} catch {
		return undefined;
	}
}

export function getNativeInstallation(executable = process.execPath): NativeInstallation | undefined {
	try {
		const actual = realpathSync(executable);
		const root = resolve(dirname(actual), "../..");
		const installation = readNativeInstallation(root);
		// A running process may belong to the previous release after activation.
		return installation && dirname(dirname(actual)) === join(root, "releases") ? installation : undefined;
	} catch {
		return undefined;
	}
}
