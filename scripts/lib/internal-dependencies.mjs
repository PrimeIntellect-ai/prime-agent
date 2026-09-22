/**
 * Shared dependency rewriting for the two release packers.
 *
 * There are two distribution channels with different trust models:
 *
 *   R2 channel      scripts/pack-prime-agent-release.mjs
 *                   Internal workspace dependencies become absolute tarball URLs because those
 *                   artifacts only exist in the bucket. Unchanged behaviour - the installer path
 *                   depends on it.
 *
 *   Registry channel scripts/pack-npm-packages.mjs
 *                   Internal workspace dependencies become semver ranges against packages that are
 *                   actually published to registry.npmjs.org, so npm can verify registry signatures,
 *                   pin integrity hashes in the consumer lockfile, and cover the graph with
 *                   provenance attestations. A tarball URL in a published package would let anyone
 *                   holding the R2 key change what installs under an already published version.
 */

/**
 * Replace dependency specifiers whose key is present in `replacements`. Keys are always the source
 * workspace package names, because compiled output imports those specifiers literally.
 */
export function rewriteInternalDependencies(dependencies, replacements) {
	if (!dependencies) return undefined;
	const rewritten = {};
	for (const [name, range] of Object.entries(dependencies)) {
		const replacement = replacements.get(name);
		rewritten[name] = replacement === undefined ? range : replacement;
	}
	return rewritten;
}

/** R2 channel specifier: an absolute tarball URL inside the release prefix. */
export function tarballDependencySpec(baseUrl, version, tarballFile) {
	return `${baseUrl}/releases/v${version}/${tarballFile}`;
}

/**
 * Registry channel specifier. When the published name differs from the imported name (it does: the
 * compiled output still imports `@earendil-works/pi-*`), npm alias syntax keeps the import specifier
 * working while resolving to the package this project owns. `npm:` aliases are understood by npm,
 * pnpm, yarn and bun.
 */
export function registryDependencySpec(sourceName, registryName, version, options = {}) {
	const range = options.exact ? version : `^${version}`;
	return sourceName === registryName ? range : `npm:${registryName}@${range}`;
}

/*
 * Registry dependency specifiers are validated against an ALLOWLIST grammar, never a denylist. npm
 * accepts far more specifier shapes than the obvious `https:` / `git:` prefixes: `git@host:repo`,
 * GitHub shorthand `user/repo#ref`, `github:user/repo`, bare tarball URLs, `file:`, `link:`,
 * `workspace:`, dist-tags such as `latest`, and the empty range `*`. Any of those lets whoever controls
 * the referenced location - not the registry - decide what installs under an already published
 * version. So the only things accepted here are the two shapes the packers actually produce:
 *
 *   1. a plain semver range built from explicit comparators, e.g. `1.2.3`, `^1.2.3`, `~1.2.3`,
 *      `>=1 <2`, `>=1.2.3-beta.1 <2 || ^3.0.0`
 *   2. an npm alias `npm:<package-name>@<plain semver range>`
 *
 * Deliberately NOT accepted, even though npm would understand them: `*`, `x`/`X` wildcards, hyphen
 * ranges (`1.2 - 2.3`), dist-tags, build metadata (`1.2.3+build`), an alias without a range, and a
 * bare partial version (`1`, `1.2`) - the caret/tilde/comparator forms express the same intent
 * without ambiguity. The grammar is a strict subset of what `semver` parses, so everything it accepts
 * is a valid npm range.
 */

const NUMERIC = String.raw`(?:0|[1-9]\d*)`;
const PRERELEASE = String.raw`(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)`;
const FULL_VERSION = String.raw`${NUMERIC}\.${NUMERIC}\.${NUMERIC}${PRERELEASE}?`;
const PARTIAL_VERSION = String.raw`${NUMERIC}(?:\.${NUMERIC}(?:\.${NUMERIC}${PRERELEASE}?)?)?`;
/** A comparator: an operator with a (possibly partial) version, or a bare full version. */
const COMPARATOR = String.raw`(?:(?:\^|~|>=|<=|>|<|=)${PARTIAL_VERSION}|${FULL_VERSION})`;
const COMPARATOR_SET = String.raw`${COMPARATOR}(?: ${COMPARATOR})*`;
const PLAIN_SEMVER_RANGE = new RegExp(String.raw`^${COMPARATOR_SET}(?: \|\| ${COMPARATOR_SET})*$`);

/**
 * npm package name rules (validate-npm-package-name): lowercase, URL-safe, no leading `.` or `_`,
 * at most 214 characters including the scope.
 */
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const MAX_PACKAGE_NAME_LENGTH = 214;

/** True when `spec` is a plain semver range from the allowlist grammar above. */
export function isPlainSemverRange(spec) {
	return typeof spec === "string" && spec.length <= 256 && PLAIN_SEMVER_RANGE.test(spec);
}

/** True when `name` is a valid npm package name (scoped or unscoped). */
export function isNpmPackageName(name) {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		name.length <= MAX_PACKAGE_NAME_LENGTH &&
		NPM_PACKAGE_NAME.test(name) &&
		!name.split("/").some((part) => part.replace(/^@/, "") === "." || part.replace(/^@/, "") === "..")
	);
}

/**
 * True when `spec` is acceptable in a package that is about to be published to the registry: a plain
 * semver range, or an `npm:<name>@<plain semver range>` alias whose target is a valid package name.
 */
export function isRegistryDependencySpec(spec) {
	if (typeof spec !== "string" || spec !== spec.trim() || spec.length === 0) return false;
	if (isPlainSemverRange(spec)) return true;
	if (!spec.startsWith("npm:")) return false;
	const alias = spec.slice("npm:".length);
	// A scoped alias target starts with `@`; the range separator is the LAST `@`, which must exist.
	const separator = alias.lastIndexOf("@");
	if (separator <= 0) return false;
	const name = alias.slice(0, separator);
	const range = alias.slice(separator + 1);
	return isNpmPackageName(name) && isPlainSemverRange(range);
}

/**
 * Fail closed if a package that is about to be published to the registry declares a dependency that
 * is not a plain registry range or an `npm:` alias onto one. See the grammar notes above.
 */
export function assertRegistryDependencies(packageJson) {
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		const entries = packageJson[field];
		if (entries === undefined) continue;
		if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
			throw new Error(`${packageJson.name}: ${field} must be an object of package names to registry ranges`);
		}
		for (const [name, spec] of Object.entries(entries)) {
			if (!isNpmPackageName(name)) {
				throw new Error(`${packageJson.name}: ${field} has an invalid package name "${name}"`);
			}
			if (!isRegistryDependencySpec(spec)) {
				throw new Error(
					`${packageJson.name}: ${field}["${name}"] must be a plain semver range or npm:<name>@<range> alias for a published package, got ${JSON.stringify(spec)}`,
				);
			}
		}
	}
}
