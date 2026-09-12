import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { APP_NAME, type SelfUpdateCommand } from "../config.js";
import {
	getNativeInstallationTarget,
	readNativeInstallation,
	readNativeRollbackInstallation,
} from "../utils/native-installation.js";
import { getLatestPiRelease, isNewerPackageVersion } from "../utils/version-check.js";

export interface NativeUpdatePlan {
	command?: SelfUpdateCommand;
	targetVersion: string;
}

export async function getNativeUpdatePlan(options: {
	force: boolean;
	rollback: boolean;
	executable?: string;
}): Promise<NativeUpdatePlan> {
	const current = getNativeInstallationTarget(options.executable);
	if (!current)
		throw new Error(
			"This compiled application is not owned by the Prime Agent installer. Update it using its original installer.",
		);
	const active = readNativeInstallation(current.root);
	const installation = active ?? readNativeInstallation(current.root, "previous");
	if (!installation || installation.platform !== current.platform)
		throw new Error("The compiled installation is damaged. Run the published installer again to repair it.");
	if (
		(options.rollback || !active) &&
		!/^# prime-agent-native-recovery-v1$/m.test(readFileSync(join(installation.releaseDir, "install.sh"), "utf8"))
	)
		throw new Error(
			"The retained installer does not support this recovery. Run the published installer at https://app.primeintellect.ai/prime-agent/install.sh again to repair it.",
		);
	accessSync(installation.root, constants.W_OK);
	accessSync(join(installation.root, "bin"), constants.W_OK);
	let version: string;
	let checksum: string | undefined;
	let previousTarget: string | undefined;
	const baseUrl = process.env.PRIME_AGENT_DOWNLOAD_BASE_URL?.trim() || installation.baseUrl;
	if (options.rollback) {
		const previous = readNativeRollbackInstallation(installation.root);
		if (!previous || previous.executable === current.executable)
			throw new Error("No valid previous compiled release is available.");
		let reportedVersion: string;
		try {
			reportedVersion = execFileSync(previous.executable, ["--version"], {
				encoding: "utf8",
				timeout: 10000,
			});
		} catch {
			throw new Error("The previous compiled release executable could not be validated.");
		}
		if (reportedVersion !== previous.version && reportedVersion !== `${previous.version}\n`)
			throw new Error("The previous compiled release executable reports a different version.");
		try {
			execFileSync(previous.executable, ["--help"], { stdio: "ignore", timeout: 10000 });
		} catch {
			throw new Error("The previous compiled release executable failed its help probe.");
		}
		version = previous.version;
		previousTarget = relative(join(installation.root, "bin"), previous.executable);
	} else {
		const release = await getLatestPiRelease(current.version, { baseUrl });
		if (!release || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version))
			throw new Error("Could not resolve a compiled release. The installed version was kept.");
		if (active && !options.force && !isNewerPackageVersion(release.version, current.version))
			return { targetVersion: current.version };
		const artifact = release.binaries?.find((entry) => entry.platform === current.platform);
		if (!artifact) throw new Error(`No verified compiled archive is available for ${current.platform}.`);
		version = release.version;
		checksum = artifact.sha256;
	}
	const environment = {
		PRIME_AGENT_INSTALL_METHOD: "binary",
		PRIME_AGENT_INSTALL_DIR: installation.root,
		PRIME_AGENT_DOWNLOAD_BASE_URL: baseUrl,
		PRIME_AGENT_INSTALL_LINK: "0",
		PRIME_AGENT_INSTALLER_NONINTERACTIVE: "1",
		PRIME_AGENT_INSTALLER_PLAIN: "1",
		PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL: "0",
		PRIME_AGENT_EXPECTED_CURRENT: relative(join(current.root, "bin"), current.executable),
		...(previousTarget ? { PRIME_AGENT_EXPECTED_PREVIOUS: previousTarget } : {}),
		...(checksum ? { PRIME_AGENT_EXPECTED_SHA256: checksum } : {}),
	};
	return {
		targetVersion: version,
		command: {
			command: "/usr/bin/env",
			args: [
				...Object.entries(environment).map(([name, value]) => `${name}=${value}`),
				"sh",
				join(installation.releaseDir, "install.sh"),
				options.rollback ? "--rollback" : version,
			],
			display: `${APP_NAME} update${options.rollback ? " --rollback" : options.force ? " --force" : ""}`,
		},
	};
}
