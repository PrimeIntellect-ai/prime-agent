import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Explicit policy input from a global, user-owned authority. */
export interface McpProjectTrustAuthorityInput {
	readonly revision: string;
	readonly allowedProjectDirectories: readonly string[];
}

declare const mcpProjectTrustBindingBrand: unique symbol;
export interface McpProjectTrustBinding {
	readonly [mcpProjectTrustBindingBrand]: never;
}

export type McpProjectTrustAuthorization =
	| { readonly kind: "denied" }
	| { readonly kind: "granted"; readonly binding: McpProjectTrustBinding };
export type McpProjectTrustBindingValidation = { readonly kind: "denied" } | { readonly kind: "granted" };

export interface McpProjectTrustAuthority {
	authorizeProjectDirectory(projectDirectory: string): McpProjectTrustAuthorization;
	validateBinding(binding: unknown): McpProjectTrustBindingValidation;
}

interface DirectoryIdentity {
	readonly canonicalPath: string;
	readonly device: string;
	readonly inode: string;
}
interface RetainedDirectory extends DirectoryIdentity {
	readonly rootFd: number;
}
interface BindingRecord {
	readonly authority: McpProjectTrustAuthority;
	readonly revision: string;
	readonly digest: string;
	readonly identity: DirectoryIdentity;
	readonly rootFd: number;
}

const DENIED: McpProjectTrustAuthorization = Object.freeze({ kind: "denied" });
const BINDING_DENIED: McpProjectTrustBindingValidation = Object.freeze({ kind: "denied" });
const BINDING_GRANTED: McpProjectTrustBindingValidation = Object.freeze({ kind: "granted" });
const genuineAuthorities = new WeakSet<object>();
const bindingRecords = new WeakMap<object, BindingRecord>();
const releasedBindings = new WeakSet<object>();

// The authority owns its pinned policy descriptors. Binding records retain the
// authority strongly, so these cannot close while a live binding can use one.
const authorityFinalizer = new FinalizationRegistry<readonly number[]>((rootFds) => {
	for (const rootFd of rootFds) {
		try {
			closeSync(rootFd);
		} catch {
			/* best effort only */
		}
	}
});

export function isMcpProjectTrustAuthority(value: unknown): value is McpProjectTrustAuthority {
	return typeof value === "object" && value !== null && genuineAuthorities.has(value);
}

function supportsRetainedDirectoryFd(): boolean {
	return process.platform !== "win32" && constants.O_DIRECTORY !== undefined && constants.O_NOFOLLOW !== undefined;
}

function exactDirectoryIdentity(path: string): DirectoryIdentity | undefined {
	if (!isAbsolute(path) || resolve(path) !== path) return undefined;
	try {
		const initial = lstatSync(path);
		if (initial.isSymbolicLink() || !initial.isDirectory()) return undefined;
		accessSync(path, constants.R_OK | constants.X_OK);
		const canonicalPath = realpathSync.native(path);
		if (canonicalPath !== path) return undefined;
		const canonical = statSync(canonicalPath, { bigint: true });
		if (!canonical.isDirectory()) return undefined;
		accessSync(canonicalPath, constants.R_OK | constants.X_OK);
		return { canonicalPath, device: canonical.dev.toString(), inode: canonical.ino.toString() };
	} catch {
		return undefined;
	}
}

function openRetainedDirectory(path: string): RetainedDirectory | undefined {
	if (!isAbsolute(path) || resolve(path) !== path) return undefined;
	let rootFd: number | undefined;
	try {
		rootFd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const opened = fstatSync(rootFd, { bigint: true });
		if (!opened.isDirectory()) throw new Error("not a directory");
		const identity = exactDirectoryIdentity(path);
		if (!identity || opened.dev.toString() !== identity.device || opened.ino.toString() !== identity.inode)
			throw new Error("directory changed during policy capture");
		return { ...identity, rootFd };
	} catch {
		if (rootFd !== undefined)
			try {
				closeSync(rootFd);
			} catch {
				/* best effort only */
			}
		return undefined;
	}
}
function digestSnapshot(revision: string, directories: readonly DirectoryIdentity[]): string {
	return createHash("sha256")
		.update(revision)
		.update("\0")
		.update(directories.map(({ canonicalPath, device, inode }) => `${canonicalPath}\0${device}\0${inode}`).join("\0"))
		.digest("hex");
}
function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
	return left.canonicalPath === right.canonicalPath && left.device === right.device && left.inode === right.inode;
}
function retainedDirectoryMatches(identity: DirectoryIdentity, rootFd: number): boolean {
	try {
		const current = fstatSync(rootFd, { bigint: true });
		return (
			current.isDirectory() &&
			current.dev.toString() === identity.device &&
			current.ino.toString() === identity.inode
		);
	} catch {
		return false;
	}
}
function retainedDescriptorMatches(record: BindingRecord): boolean {
	return retainedDirectoryMatches(record.identity, record.rootFd);
}

/**
 * Module-private binding ownership is the only route from a real admission to
 * its root FD. It validates the retained descriptor and the current policy on
 * both sides of the operation, preventing path ABA re-open races.
 */
export function withValidatedMcpProjectTrustBinding<T>(
	binding: unknown,
	operation: (rootFd: number) => T,
): T | undefined {
	if (typeof binding !== "object" || binding === null || releasedBindings.has(binding)) return undefined;
	const record = bindingRecords.get(binding);
	if (!record || !retainedDescriptorMatches(record) || record.authority.validateBinding(binding).kind !== "granted")
		return undefined;
	const result = operation(record.rootFd);
	return retainedDescriptorMatches(record) && record.authority.validateBinding(binding).kind === "granted"
		? result
		: undefined;
}

/** Explicit release for a real binding; foreign/duplicate releases are inert. */
export function releaseMcpProjectTrustBinding(binding: unknown): void {
	if (typeof binding !== "object" || binding === null || releasedBindings.has(binding)) return;
	const record = bindingRecords.get(binding);
	if (!record) return;
	releasedBindings.add(binding);
	bindingRecords.delete(binding);
}

export function createMcpProjectTrustAuthority(input: McpProjectTrustAuthorityInput): McpProjectTrustAuthority {
	const revision = typeof input.revision === "string" ? input.revision : "";
	const requestedDirectories = Array.isArray(input.allowedProjectDirectories)
		? [...input.allowedProjectDirectories]
		: [];
	const retained = supportsRetainedDirectoryFd()
		? requestedDirectories.map((directory) =>
				typeof directory === "string" ? openRetainedDirectory(directory) : undefined,
			)
		: [];
	const valid =
		supportsRetainedDirectoryFd() &&
		revision.length > 0 &&
		retained.every((identity): identity is RetainedDirectory => identity !== undefined) &&
		new Set(retained.map((identity) => identity.canonicalPath)).size === retained.length;
	if (!valid) {
		for (const identity of retained) {
			if (identity)
				try {
					closeSync(identity.rootFd);
				} catch {
					/* best effort only */
				}
		}
	}
	const snapshot = valid
		? Object.freeze([...retained] as RetainedDirectory[])
		: Object.freeze([] as RetainedDirectory[]);
	const snapshotDigest = digestSnapshot(revision, snapshot);
	const bindings = new WeakSet<object>();
	const authority: McpProjectTrustAuthority = Object.freeze({
		authorizeProjectDirectory(projectDirectory: string): McpProjectTrustAuthorization {
			const requested = typeof projectDirectory === "string" ? exactDirectoryIdentity(projectDirectory) : undefined;
			const approved = requested ? snapshot.find((candidate) => sameIdentity(candidate, requested)) : undefined;
			if (!requested || !approved || !retainedDirectoryMatches(approved, approved.rootFd)) return DENIED;
			const binding = Object.freeze(Object.create(null)) as McpProjectTrustBinding;
			const record: BindingRecord = Object.freeze({
				authority,
				revision,
				digest: snapshotDigest,
				identity: approved,
				rootFd: approved.rootFd,
			});
			bindings.add(binding);
			bindingRecords.set(binding, record);
			return Object.freeze({ kind: "granted", binding });
		},
		validateBinding(binding: unknown): McpProjectTrustBindingValidation {
			if (typeof binding !== "object" || binding === null || !bindings.has(binding) || releasedBindings.has(binding))
				return BINDING_DENIED;
			const record = bindingRecords.get(binding);
			const currentSnapshot = snapshot.map(({ canonicalPath }) => exactDirectoryIdentity(canonicalPath));
			if (currentSnapshot.some((identity) => identity === undefined)) return BINDING_DENIED;
			const current = currentSnapshot as DirectoryIdentity[];
			if (
				!record ||
				record.authority !== authority ||
				!retainedDescriptorMatches(record) ||
				record.revision !== revision ||
				record.digest !== snapshotDigest ||
				!current.every((identity, index) => sameIdentity(snapshot[index]!, identity)) ||
				digestSnapshot(revision, current) !== snapshotDigest ||
				!snapshot.some((approved) => sameIdentity(approved, record.identity))
			)
				return BINDING_DENIED;
			return BINDING_GRANTED;
		},
	});
	genuineAuthorities.add(authority);
	if (snapshot.length > 0) authorityFinalizer.register(authority, Object.freeze(snapshot.map(({ rootFd }) => rootFd)));
	return authority;
}
