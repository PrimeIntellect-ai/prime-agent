import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { getAgentDir } from "../../config.js";
import { defaultDaemonSocketDir, defaultDaemonSocketPath, normalizeSocketPath } from "./daemon-socket.js";
import {
	canonicalizeFilesystemPath,
	listDaemonSupervisorSocketPathsForAgentDir,
} from "./daemon-supervisor-ownership.js";

/**
 * The state root an invocation reads and writes: the agent dir (config, logs,
 * worker descriptors) and the default daemon socket dir. Both already follow
 * HOME, TMPDIR and the agent-dir env override, so an isolated root resolves to
 * isolated paths; this type just carries the pair around so daemon discovery can
 * be scoped the same way instead of sweeping the whole machine.
 */
export interface DaemonStateRoot {
	agentDir: string;
	socketDir: string;
	defaultSocketPath: string;
}

export function currentDaemonStateRoot(): DaemonStateRoot {
	return {
		agentDir: getAgentDir(),
		socketDir: defaultDaemonSocketDir(),
		defaultSocketPath: normalizeSocketPath(defaultDaemonSocketPath()),
	};
}

/**
 * Predicate for "this daemon belongs to our state root". A daemon is ours when
 * its socket sits in our socket dir, when it sits anywhere inside our agent dir,
 * or when the supervisor ownership registry (itself scoped to our HOME) records
 * it under our agent dir — the last two rules keep daemons on custom
 * `--daemon-socket` paths in scope for the root that started them.
 *
 * The directory rules also compare canonical, realpath-resolved forms: the
 * listening sweep reports the spelling each daemon bound, which can be a
 * symlink alias of our own spelling while naming the very same directory
 * (macOS /var against /private/var), and such a listener is still ours to reap.
 *
 * The agent-dir rule is what keeps *hidden* supervisors reachable. A supervisor
 * that has handed its runtime to a successor is no longer the registered owner,
 * so the registry cannot name it; the OS socket sweep is the only thing that can
 * still see it. Scoping by the registry alone would silently put those daemons
 * out of reach of `daemon ps` and `shutdown --force` and leak them forever, which
 * is the regression ENG-4603 covers. A socket inside our agent dir is
 * unambiguously ours — another HOME resolves to another agent dir — so honouring
 * it restores that reach without widening scope back to the whole machine.
 *
 * The registry read is deferred and memoised so the common case (every socket in
 * our own socket dir) costs nothing, and a fresh matcher per sweep keeps results
 * current for callers that poll.
 *
 * The socket dir is deliberately part of the root: it is per-uid, per-TMPDIR
 * state, so two invocations that share TMPDIR also share that one daemon
 * namespace no matter which HOME or agent dir they run under — they could not
 * run concurrent default daemons on one socket path anyway. Scoping the dir away
 * would orphan every unregistered listener there (workers, abandoned and
 * pre-registry daemons), which `shutdown --force` must still reap.
 */
export function createDaemonStateRootMatcher(
	root: DaemonStateRoot = currentDaemonStateRoot(),
): (socketPath: string) => boolean {
	if (process.platform === "win32") {
		// Windows daemons share one named pipe per machine, so there is nothing to scope.
		return () => true;
	}
	const socketDir = resolve(root.socketDir);
	const agentDir = resolve(root.agentDir);
	const canonicalSocketDir = canonicalizeDirectorySafely(socketDir);
	const canonicalAgentDir = canonicalizeDirectorySafely(agentDir);
	const canonicalDirectories = new Map<string, string>();
	let registeredSocketPaths: Set<string> | undefined;
	return (socketPath: string): boolean => {
		const normalized = normalizeSocketPath(socketPath);
		const directory = resolve(dirname(normalized));
		if (normalized === root.defaultSocketPath || directory === socketDir || isInside(directory, agentDir)) {
			return true;
		}
		let canonicalDirectory = canonicalDirectories.get(directory);
		if (canonicalDirectory === undefined) {
			canonicalDirectory = canonicalizeDirectorySafely(directory);
			canonicalDirectories.set(directory, canonicalDirectory);
		}
		if (canonicalDirectory === canonicalSocketDir || isInside(canonicalDirectory, canonicalAgentDir)) {
			return true;
		}
		registeredSocketPaths ??= new Set(listDaemonSupervisorSocketPathsForAgentDir(root.agentDir));
		return registeredSocketPaths.has(normalized);
	};
}

/**
 * True when `directory` is `parent` itself or sits below it. `relative` is used
 * rather than a prefix comparison so a sibling whose name merely starts with the
 * parent's name (`/tmp/agent-other` against `/tmp/agent`) is not mistaken for a
 * child, and so an absolute result on a different volume is rejected outright.
 * Traversal is recognized only as a complete `..` path segment, so a directory
 * literally named `..runtime` still counts as a child.
 */
function isInside(directory: string, parent: string): boolean {
	if (directory === parent) return true;
	const offset = relative(parent, directory);
	return offset.length > 0 && offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

/**
 * Canonical form of a directory for the alias comparison, degrading to the
 * lexical form when canonicalization itself fails (an unreadable ancestor, a
 * symlink loop): a listener must never crash the sweep scoping it.
 */
function canonicalizeDirectorySafely(directory: string): string {
	try {
		return canonicalizeFilesystemPath(directory);
	} catch {
		return directory;
	}
}
