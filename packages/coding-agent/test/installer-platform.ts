import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { NATIVE_PLATFORMS } from "../src/utils/native-installation.js";

export const installerPath = resolve(__dirname, "../../../install.sh");

/**
 * The platform the installer selects on this host. Fixtures name their archives
 * after it so the suite also runs on musl and non-AVX2 machines, where the host
 * platform is no longer `${process.platform}-${process.arch}`.
 */
export function hostNativePlatform(): string {
	// Windows has no compiled release and no `sh`; these suites skip there.
	if (process.platform === "win32") return `${process.platform}-${process.arch}`;
	try {
		return execFileSync("sh", [installerPath, "--native-platform"], { encoding: "utf8" }).trim();
	} catch {
		return `${process.platform}-${process.arch}`;
	}
}

/** The platform an archive filename advertises, or undefined when it names none. */
export function archiveNativePlatform(archive: string): string | undefined {
	const name = basename(archive);
	return NATIVE_PLATFORMS.find((platform) => name.endsWith(`-${platform}.tar.gz`));
}
