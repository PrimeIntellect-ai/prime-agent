import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, sep } from "node:path";
import { isLocalPath } from "../../utils/paths.js";
import type { ResourceDiagnostic } from "../diagnostics.js";
import type { ResolvedResource } from "../package-manager.js";
import type { HarnessEntry, HarnessState, PackageHarnessProvenance, RefinementKind } from "./refinement.js";

const HARNESS_KINDS: readonly RefinementKind[] = ["prompt", "memory", "skill", "subagent"];
const HARNESS_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const RESERVED_HARNESS_IDS = new Set(["prototype"]);
// Package entries are pure content overlays: a fixed timestamp keeps the rendered
// digest stable across reloads when the underlying files did not change.
const PACKAGE_HARNESS_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const REVISION_LENGTH = 12;

const CREDENTIAL_QUERY_KEY =
	/(?:^|[-_])(token|secret|password|passwd|credential|authorization|auth|api[-_]?key|access[-_]?key|signature|sig)(?:$|[-_])/i;
const CREDENTIAL_QUERY_VALUE = /^(?:bearer\s+|basic\s+|gh[pousr]_|github_pat_|glpat-|sk[-_]|xox[baprs]-)/i;

export interface PackageHarnessLoadResult {
	state: HarnessState;
	diagnostics: ResourceDiagnostic[];
}

export function createEmptyPackageHarnessState(): HarnessState {
	return {
		schema: 1,
		entries: {
			prompt: {},
			memory: {},
			skill: {},
			subagent: {},
		},
		refinements: [],
	};
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function isHarnessKind(value: string): value is RefinementKind {
	return HARNESS_KINDS.some((kind) => kind === value);
}

function harnessIdError(id: string): string | undefined {
	if (!HARNESS_ID_PATTERN.test(id)) {
		return "package harness id must match [A-Za-z0-9_.-]+";
	}
	if (id in Object.prototype || RESERVED_HARNESS_IDS.has(id)) {
		return `package harness id ${id} is reserved`;
	}
	return undefined;
}

/**
 * Scope ranking for cross-package (kind, id) collisions: project packages beat user
 * packages, mirroring the resource precedence model (package rank sits below
 * user/project editable entries, which win in mergeHarnessStates).
 */
function packageScopeRank(scope: ResolvedResource["metadata"]["scope"]): number {
	switch (scope) {
		case "project":
			return 0;
		case "user":
			return 1;
		case "temporary":
			return 2;
	}
}

function parsePackageHarnessPath(resource: ResolvedResource): { kind: RefinementKind; id: string } | { error: string } {
	const baseDir = resource.metadata.baseDir;
	if (!baseDir) {
		return { error: "package harness resource is missing its package root" };
	}

	const relativePath = relative(baseDir, resource.path);
	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		return { error: "package harness file must be inside its package root" };
	}

	const segments = relativePath.split(sep);
	if (segments.length !== 3 || segments[0] !== "harness") {
		return { error: "package harness file must use harness/<kind>/<id>.json" };
	}

	const kind = segments[1] ?? "";
	if (!kind || !isHarnessKind(kind)) {
		return { error: `package harness path has unsupported kind ${kind || "<empty>"}` };
	}

	const fileName = segments[2] ?? "";
	if (!fileName?.endsWith(".json")) {
		return { error: "package harness file must use a .json extension" };
	}
	const id = fileName.slice(0, -".json".length);
	if (!id) {
		return { error: "package harness file name must contain a nonempty id" };
	}
	const idError = harnessIdError(id);
	if (idError) {
		return { error: idError };
	}

	return { kind, id };
}

function validatePackageHarnessEntry(
	value: unknown,
	expected: { kind: RefinementKind; id: string },
	packageSource: string,
): { entry: HarnessEntry } | { error: string } {
	const record = objectRecord(value);
	if (!record) {
		return { error: "package harness file must contain a JSON object" };
	}

	for (const field of ["id", "kind", "title", "content"] as const) {
		if (typeof record[field] !== "string" || (record[field] as string).trim().length === 0) {
			return { error: `package harness entry ${field} must be a nonempty string` };
		}
	}

	if (record.kind !== expected.kind) {
		return { error: `package harness entry kind must match path kind ${expected.kind}` };
	}
	if (record.id !== expected.id) {
		return { error: `package harness entry id must match file id ${expected.id}` };
	}
	if (record.scope !== undefined && record.scope !== "local" && record.scope !== "global") {
		return { error: "package harness entry scope must be local or global when provided" };
	}

	let entryPath = expected.kind === "prompt" ? "policy" : "general";
	if (record.path !== undefined) {
		if (typeof record.path !== "string" || record.path.trim().length === 0) {
			return { error: "package harness entry path must be a nonempty string when provided" };
		}
		entryPath = record.path as string;
	}

	// Package overlays are scope-less: a scope exported from an editable entry is
	// accepted but not carried into the overlay.
	const reference = record.reference === undefined ? {} : objectRecord(record.reference);
	if (!reference) {
		return { error: "package harness entry reference must be an object when provided" };
	}
	const argumentsRecord = record.arguments === undefined ? {} : objectRecord(record.arguments);
	if (!argumentsRecord) {
		return { error: "package harness entry arguments must be an object when provided" };
	}
	const metadata = record.metadata === undefined ? {} : objectRecord(record.metadata);
	if (!metadata) {
		return { error: "package harness entry metadata must be an object when provided" };
	}
	const version = record.version === undefined ? 1 : record.version;
	if (!Number.isInteger(version) || (version as number) < 1) {
		return { error: "package harness entry version must be a positive integer when provided" };
	}

	if (expected.kind === "skill") {
		if (reference.type !== "python") {
			return { error: "package harness skill reference.type must be python" };
		}
		const hasImport =
			(typeof reference.import === "string" && reference.import.trim().length > 0) ||
			(typeof reference.python_import === "string" && reference.python_import.trim().length > 0);
		if (!hasImport) {
			return { error: "package harness skill requires a python import" };
		}
		const hasCallable =
			(typeof reference.callable === "string" && reference.callable.trim().length > 0) ||
			(typeof reference.call_pattern === "string" && reference.call_pattern.trim().length > 0);
		if (!hasCallable) {
			return { error: "package harness skill requires a callable or call_pattern" };
		}
	}

	return {
		entry: {
			id: record.id as string,
			kind: expected.kind,
			title: record.title as string,
			content: record.content as string,
			path: entryPath,
			reference,
			arguments: argumentsRecord,
			metadata,
			source: packageSource,
			created_at: PACKAGE_HARNESS_TIMESTAMP,
			updated_at: PACKAGE_HARNESS_TIMESTAMP,
			version: version as number,
		},
	};
}

function redactCredentialParameters(source: string): string {
	const redacted = source.replace(
		/([?&#])([^=&]+)=([^&#]*)/g,
		(match, separator: string, key: string, value: string) => {
			return CREDENTIAL_QUERY_KEY.test(key) || CREDENTIAL_QUERY_VALUE.test(value)
				? `${separator}${key}=[redacted]`
				: match;
		},
	);
	const fragmentIndex = redacted.indexOf("#");
	if (fragmentIndex < 0) {
		return redacted;
	}
	const fragment = redacted.slice(fragmentIndex + 1);
	let decodedFragment = fragment;
	try {
		decodedFragment = decodeURIComponent(fragment);
	} catch {
		// Keep malformed fragments unchanged unless the raw value matches below.
	}
	return CREDENTIAL_QUERY_VALUE.test(decodedFragment) ? `${redacted.slice(0, fragmentIndex)}#[redacted]` : redacted;
}

function redactScpLikeCredentials(source: string): string {
	const queryIndex = source.search(/[?#]/);
	const sourceIdentity = queryIndex < 0 ? source : source.slice(0, queryIndex);
	const suffix = queryIndex < 0 ? "" : source.slice(queryIndex);
	const packagePrefix = sourceIdentity.startsWith("git:") ? "git:" : "";
	const scpIdentity = sourceIdentity.slice(packagePrefix.length);
	const atIndex = scpIdentity.indexOf("@");
	if (atIndex <= 0) {
		return source;
	}

	const userInfo = scpIdentity.slice(0, atIndex);
	const hostPath = scpIdentity.slice(atIndex + 1);
	const looksLikeScpSource = hostPath.includes(":") || hostPath.includes("/");
	const containsCredentials =
		userInfo.includes(":") || CREDENTIAL_QUERY_KEY.test(userInfo) || CREDENTIAL_QUERY_VALUE.test(userInfo);
	if (!looksLikeScpSource || userInfo === "git" || !containsCredentials) {
		return source;
	}

	return `${packagePrefix}${hostPath}${suffix}`;
}

/**
 * Sanitize a configured package source for prompt-visible provenance: strip URL
 * userinfo, credential-looking query parameters, and scp-like user:pass segments.
 */
function sanitizePackageSource(source: string): string {
	const urlIndex = source.search(/[A-Za-z][A-Za-z0-9+.-]*:\/\//);
	if (urlIndex < 0) {
		return redactCredentialParameters(redactScpLikeCredentials(source));
	}

	try {
		const prefix = source.slice(0, urlIndex);
		const url = new URL(source.slice(urlIndex));
		url.username = "";
		url.password = "";
		const queryKeysToDelete = new Set<string>();
		for (const [key, value] of url.searchParams) {
			if (CREDENTIAL_QUERY_KEY.test(key) || CREDENTIAL_QUERY_VALUE.test(value)) {
				queryKeysToDelete.add(key);
			}
		}
		for (const key of queryKeysToDelete) {
			url.searchParams.delete(key);
		}
		return redactCredentialParameters(`${prefix}${url.toString()}`);
	} catch {
		return redactCredentialParameters(source.replace(/(\/\/)[^/@\s]+@/, "$1"));
	}
}

/**
 * Prompt-safe package identity for local-path packages: the installed directory
 * name identifies the package without leaking the local filesystem path.
 */
function describePackageSource(source: string, baseDir: string): string {
	const sanitized = sanitizePackageSource(source);
	if (!isLocalPath(sanitized)) {
		return sanitized;
	}
	return `local:${basename(baseDir)}`;
}

function readGitRevision(baseDir: string): string | undefined {
	// Resolve through a .git file indirection (worktrees, submodules) without spawning git.
	let gitDir = `${baseDir}/.git`;
	try {
		if (!existsSync(gitDir)) {
			return undefined;
		}
		if (!statSync(gitDir).isDirectory()) {
			const indirection = readFileSync(gitDir, "utf-8").trim();
			if (!indirection.startsWith("gitdir:")) {
				return undefined;
			}
			gitDir = indirection.slice("gitdir:".length).trim();
		}
		const headPath = `${gitDir}/HEAD`;
		if (!existsSync(headPath)) {
			return undefined;
		}
		const head = readFileSync(headPath, "utf-8").trim();
		if (head.startsWith("ref:")) {
			const ref = head.slice("ref:".length).trim();
			const refPath = `${gitDir}/${ref}`;
			if (existsSync(refPath)) {
				return readFileSync(refPath, "utf-8").trim().slice(0, REVISION_LENGTH) || undefined;
			}
			// Packed refs are the other common storage; read them before giving up.
			const packedRefsPath = `${gitDir}/packed-refs`;
			if (existsSync(packedRefsPath)) {
				const line = readFileSync(packedRefsPath, "utf-8")
					.split("\n")
					.find((entry) => entry.endsWith(` ${ref}`));
				const sha = line?.split(" ")[0];
				if (sha && /^[0-9a-f]{7,40}$/.test(sha)) {
					return sha.slice(0, REVISION_LENGTH);
				}
			}
			return undefined;
		}
		return /^[0-9a-f]{7,40}$/.test(head) ? head.slice(0, REVISION_LENGTH) : undefined;
	} catch {
		return undefined;
	}
}

function readPackageRevision(baseDir: string): string | undefined {
	const gitRevision = readGitRevision(baseDir);
	if (gitRevision) {
		return gitRevision;
	}
	try {
		const pkg = objectRecord(JSON.parse(readFileSync(`${baseDir}/package.json`, "utf-8")));
		if (typeof pkg?.version === "string" && pkg.version.trim().length > 0) {
			return `v${pkg.version.trim()}`;
		}
	} catch {
		// Non-package or unreadable manifests keep provenance without a revision.
	}
	return undefined;
}

function packageProvenance(resource: ResolvedResource): PackageHarnessProvenance {
	const baseDir = resource.metadata.baseDir!;
	const provenance: PackageHarnessProvenance = {
		origin: "package",
		// Never render local filesystem paths: identify local packages by directory name.
		source: describePackageSource(resource.metadata.source, baseDir),
		scope: resource.metadata.scope,
		file: relative(baseDir, resource.path).split(sep).join("/"),
		readOnly: true,
	};
	const revision = readPackageRevision(baseDir);
	if (revision) {
		provenance.revision = revision;
	}
	return provenance;
}

/**
 * Mount read-only continual harness entries from resolved package resources.
 *
 * Entries keep (kind, id) uniqueness across packages: the first package in
 * precedence order (project, then user, then temporary) wins and later
 * duplicates surface as collision diagnostics. Editable local/global harness
 * entries still win over every package entry in mergeHarnessStates.
 */
export function loadPackageHarness(resources: readonly ResolvedResource[]): PackageHarnessLoadResult {
	const state = createEmptyPackageHarnessState();
	const diagnostics: ResourceDiagnostic[] = [];
	const ordered = resources
		.map((resource, index) => ({ resource, index }))
		.filter(({ resource }) => resource.enabled)
		.sort(
			(left, right) =>
				packageScopeRank(left.resource.metadata.scope) - packageScopeRank(right.resource.metadata.scope) ||
				left.index - right.index,
		);

	for (const { resource } of ordered) {
		const pathValidation = parsePackageHarnessPath(resource);
		if ("error" in pathValidation) {
			diagnostics.push({ type: "warning", message: pathValidation.error, path: resource.path });
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(resource.path, "utf-8"));
		} catch (error) {
			diagnostics.push({
				type: "warning",
				message:
					error instanceof Error
						? `failed to read package harness entry: ${error.message}`
						: "failed to read package harness entry",
				path: resource.path,
			});
			continue;
		}

		const provenance = packageProvenance(resource);
		const validation = validatePackageHarnessEntry(parsed, pathValidation, provenance.source);
		if ("error" in validation) {
			diagnostics.push({ type: "warning", message: validation.error, path: resource.path });
			continue;
		}

		const entry: HarnessEntry = { ...validation.entry, provenance };
		const existing = state.entries[entry.kind][entry.id];
		if (existing) {
			const winnerProvenance = existing.provenance;
			diagnostics.push({
				type: "collision",
				message: `package harness ${entry.kind}:${entry.id} collision; keeping ${winnerProvenance?.source ?? existing.source}`,
				path: resource.path,
				collision: {
					resourceType: "harness",
					name: `${entry.kind}:${entry.id}`,
					winnerPath: `${winnerProvenance?.source ?? existing.source}#${winnerProvenance?.file ?? existing.id}`,
					loserPath: `${provenance.source}#${provenance.file}`,
					winnerSource: winnerProvenance?.source,
					loserSource: provenance.source,
				},
			});
			continue;
		}
		state.entries[entry.kind][entry.id] = entry;
	}

	return { state, diagnostics };
}
