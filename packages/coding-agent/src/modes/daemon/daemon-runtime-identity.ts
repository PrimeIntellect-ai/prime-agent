import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../config.js";
import {
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonRuntimeIdentity,
} from "./daemon-protocol.js";

declare const __PI_BUILD_ID__: string | undefined;
declare const __PI_CODE_TREE_DIGEST__: string | undefined;
declare const __PI_INSTALLED_BUILD_ID__: string | undefined;
declare const __PI_SOURCE_BUILD_ID__: string | undefined;

export const PRIME_AGENT_BUILD_ID_ENV = "PRIME_AGENT_BUILD_ID";
export const PRIME_AGENT_SOURCE_BUILD_ID_ENV = "PRIME_AGENT_SOURCE_BUILD_ID";
export const PRIME_AGENT_INSTALLED_BUILD_ID_ENV = "PRIME_AGENT_INSTALLED_BUILD_ID";
export const PRIME_AGENT_CODE_TREE_DIGEST_ENV = "PRIME_AGENT_CODE_TREE_DIGEST";
export const PRIME_AGENT_LAUNCHER_PATH_ENV = "PRIME_AGENT_LAUNCHER_PATH";

/** Source files that define the launcher/runtime boundary and its bundle identity. */
export const DAEMON_RUNTIME_CODE_INPUTS = [
	"prime-agent.sh",
	"packages/coding-agent/scripts/bundle.mjs",
	"packages/coding-agent/src/cli/daemon-launch.ts",
	"packages/coding-agent/src/modes/daemon/daemon-runtime-identity.ts",
] as const;

export interface DaemonRuntimeAttestation extends DaemonRuntimeIdentity {
	sourceBuildId?: string;
	installedBuildId?: string;
	codeTreeDigest?: string;
	protocolVersion?: number;
	schemaId?: string;
	schemaRevision?: number;
}

export interface DaemonRuntimeBuildIdentity {
	buildId: string;
	sourceBuildId: string;
	installedBuildId: string;
	codeTreeDigest?: string;
}

export interface BundledDaemonRuntimeBuildIdentity {
	sourceBuildId?: string;
	installedBuildId?: string;
	codeTreeDigest?: string;
	buildId?: string;
}

export interface CanonicalDaemonRuntimeAttestation {
	executablePath: string;
	sourceBuildId: string;
	installedBuildId: string;
	codeTreeDigest: string;
	protocolVersion: number;
	schemaId: string;
	schemaRevision: number;
}

export const DAEMON_RUNTIME_ATTESTATION_FIELDS: readonly (keyof CanonicalDaemonRuntimeAttestation)[] = [
	"executablePath",
	"sourceBuildId",
	"installedBuildId",
	"codeTreeDigest",
	"protocolVersion",
	"schemaId",
	"schemaRevision",
];

function bundledBuildIdentity(): BundledDaemonRuntimeBuildIdentity | undefined {
	const buildId = typeof __PI_BUILD_ID__ === "undefined" ? undefined : __PI_BUILD_ID__;
	const sourceBuildId = typeof __PI_SOURCE_BUILD_ID__ === "undefined" ? undefined : __PI_SOURCE_BUILD_ID__;
	const installedBuildId = typeof __PI_INSTALLED_BUILD_ID__ === "undefined" ? undefined : __PI_INSTALLED_BUILD_ID__;
	const codeTreeDigest = typeof __PI_CODE_TREE_DIGEST__ === "undefined" ? undefined : __PI_CODE_TREE_DIGEST__;
	if (!buildId && !sourceBuildId && !installedBuildId && !codeTreeDigest) {
		return undefined;
	}
	return { buildId, sourceBuildId, installedBuildId, codeTreeDigest };
}

/**
 * Resolve launcher-provided and bundle-embedded identity without allowing launcher metadata to replace a bundle.
 *
 * Args:
 * environment: Process environment used for source-launcher metadata.
 * bundled: Build metadata embedded by the bundle, when this is a bundled runtime.
 * Return: Build identity with the legacy buildId alias retained.
 */
export function resolveDaemonRuntimeBuildIdentity(
	environment: NodeJS.ProcessEnv = process.env,
	bundled: BundledDaemonRuntimeBuildIdentity | undefined = bundledBuildIdentity(),
): DaemonRuntimeBuildIdentity {
	const releaseBuildId = `release-${VERSION}`;
	const launcherSourceBuildId = environment[PRIME_AGENT_SOURCE_BUILD_ID_ENV] ?? environment[PRIME_AGENT_BUILD_ID_ENV];
	const sourceBuildId = launcherSourceBuildId ?? bundled?.sourceBuildId ?? bundled?.buildId ?? releaseBuildId;
	const installedBuildId =
		bundled?.installedBuildId ?? bundled?.buildId ?? environment[PRIME_AGENT_INSTALLED_BUILD_ID_ENV] ?? sourceBuildId;
	const codeTreeDigest = bundled?.codeTreeDigest ?? environment[PRIME_AGENT_CODE_TREE_DIGEST_ENV];
	return {
		buildId: installedBuildId,
		sourceBuildId,
		installedBuildId,
		...(codeTreeDigest ? { codeTreeDigest } : {}),
	};
}

function walkUp(startPath: string): string[] {
	const paths: string[] = [];
	let current = resolve(startPath);
	while (true) {
		paths.push(current);
		const parent = dirname(current);
		if (parent === current) {
			return paths;
		}
		current = parent;
	}
}

function findProjectRoot(environment: NodeJS.ProcessEnv): string | undefined {
	const candidates = [
		...(environment[PRIME_AGENT_LAUNCHER_PATH_ENV]
			? [dirname(resolve(environment[PRIME_AGENT_LAUNCHER_PATH_ENV]))]
			: []),
		dirname(fileURLToPath(import.meta.url)),
		...(process.argv[1] ? [dirname(resolve(process.argv[1]))] : []),
		process.cwd(),
	];
	for (const candidate of candidates) {
		for (const path of walkUp(candidate)) {
			if (existsSync(join(path, "prime-agent.sh")) && existsSync(join(path, "packages/coding-agent/package.json"))) {
				return path;
			}
		}
	}
	return undefined;
}

/**
 * Hash the declared runtime inputs with path and length boundaries for a stable source/bundle identity.
 *
 * Args:
 * projectRoot: Repository root containing the declared inputs.
 * codeInputs: Relative paths included in the digest.
 * Return: Stable SHA-256 digest, or undefined when an input is unavailable.
 */
export function computeCodeTreeDigest(
	projectRoot: string | undefined = findProjectRoot(process.env),
	codeInputs: readonly string[] = DAEMON_RUNTIME_CODE_INPUTS,
): string | undefined {
	if (!projectRoot) {
		return undefined;
	}
	const hash = createHash("sha256");
	hash.update("prime-agent-daemon-runtime-code-tree-v1\0", "utf8");
	for (const relativePath of [...codeInputs].sort()) {
		let contents: Buffer;
		try {
			contents = readFileSync(join(projectRoot, relativePath));
		} catch {
			return undefined;
		}
		hash.update(relativePath, "utf8");
		hash.update("\0", "utf8");
		hash.update(String(contents.byteLength), "utf8");
		hash.update("\0", "utf8");
		hash.update(contents);
		hash.update("\0", "utf8");
	}
	return `sha256:${hash.digest("hex")}`;
}

/**
 * Build the runtime identity announced by a daemon and expected by its clients.
 *
 * Args:
 * environment: Process environment used for launcher metadata and diagnostics.
 * Return: Runtime identity with canonical attestation fields when available.
 */
export function getDaemonRuntimeIdentity(environment: NodeJS.ProcessEnv = process.env): DaemonRuntimeAttestation {
	const buildIdentity = resolveDaemonRuntimeBuildIdentity(environment);
	const codeTreeDigest = buildIdentity.codeTreeDigest ?? computeCodeTreeDigest(findProjectRoot(environment));
	const entrypoint = process.argv[1];
	const launcher = environment[PRIME_AGENT_LAUNCHER_PATH_ENV];
	return {
		buildId: buildIdentity.buildId,
		sourceBuildId: buildIdentity.sourceBuildId,
		installedBuildId: buildIdentity.installedBuildId,
		...(codeTreeDigest ? { codeTreeDigest } : {}),
		protocolVersion: DAEMON_PROTOCOL_VERSION,
		schemaId: DAEMON_SCHEMA_ID,
		schemaRevision: DAEMON_SCHEMA_REVISION,
		executablePath: resolve(process.execPath),
		...(entrypoint ? { entrypointPath: resolve(entrypoint) } : {}),
		...(launcher ? { launcherPath: resolve(launcher) } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the strict attestation required before attaching to a current-version daemon.
 *
 * Args:
 * value: Untrusted runtime value received from a daemon hello.
 * Return: Canonical attestation, or undefined when required fields are absent or invalid.
 */
export function getCanonicalDaemonRuntimeAttestation(value: unknown): CanonicalDaemonRuntimeAttestation | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const executablePath = value.executablePath;
	const sourceBuildId = value.sourceBuildId;
	const installedBuildId = value.installedBuildId;
	const codeTreeDigest = value.codeTreeDigest;
	const protocolVersion = value.protocolVersion;
	const schemaId = value.schemaId;
	const schemaRevision = value.schemaRevision;
	const buildId = value.buildId;
	if (
		typeof executablePath !== "string" ||
		typeof sourceBuildId !== "string" ||
		typeof installedBuildId !== "string" ||
		typeof codeTreeDigest !== "string" ||
		typeof protocolVersion !== "number" ||
		!Number.isInteger(protocolVersion) ||
		typeof schemaId !== "string" ||
		typeof schemaRevision !== "number" ||
		!Number.isInteger(schemaRevision) ||
		(buildId !== undefined && (typeof buildId !== "string" || buildId !== installedBuildId))
	) {
		return undefined;
	}
	return {
		executablePath,
		sourceBuildId,
		installedBuildId,
		codeTreeDigest,
		protocolVersion,
		schemaId,
		schemaRevision,
	};
}

/**
 * Compare canonical runtime fields without consulting optional legacy diagnostics.
 *
 * Args:
 * expected: Runtime attestation required by this client.
 * observed: Runtime attestation announced by the daemon.
 * Return: Canonical fields whose values differ.
 */
export function findDaemonRuntimeAttestationMismatches(
	expected: CanonicalDaemonRuntimeAttestation,
	observed: CanonicalDaemonRuntimeAttestation,
): (keyof CanonicalDaemonRuntimeAttestation)[] {
	return DAEMON_RUNTIME_ATTESTATION_FIELDS.filter((field) => expected[field] !== observed[field]);
}

function safeString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return value === undefined ? undefined : "<invalid>";
	}
	return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
}

/**
 * Return only bounded, known runtime fields for user-facing diagnostics.
 *
 * Args:
 * value: Untrusted runtime identity received from a daemon.
 * Return: Sanitized known fields safe to serialize in an error or log.
 */
export function safeDaemonRuntimeIdentity(value: unknown): Record<string, string | number | undefined> {
	if (!isRecord(value)) {
		return {};
	}
	return {
		executablePath: safeString(value.executablePath),
		sourceBuildId: safeString(value.sourceBuildId),
		installedBuildId: safeString(value.installedBuildId),
		codeTreeDigest: safeString(value.codeTreeDigest),
		protocolVersion: typeof value.protocolVersion === "number" ? value.protocolVersion : undefined,
		schemaId: safeString(value.schemaId),
		schemaRevision: typeof value.schemaRevision === "number" ? value.schemaRevision : undefined,
		buildId: safeString(value.buildId),
		entrypointPath: safeString(value.entrypointPath),
		launcherPath: safeString(value.launcherPath),
	};
}
