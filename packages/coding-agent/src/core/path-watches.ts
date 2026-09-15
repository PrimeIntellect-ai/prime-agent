import { randomUUID } from "node:crypto";
import { type FSWatcher, statSync, watch } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Batch window for filesystem events, mirroring the runtime design's 200 ms. */
export const PATH_WATCH_DEBOUNCE_MS = 200;
/** Concurrent active watches per owning session. */
export const MAX_ACTIVE_PATH_WATCHES = 64;
/** Total registrations per owning session, including finished ones. */
export const MAX_TOTAL_PATH_WATCHES = 1024;
/** Encoded cap for the changed-path list carried by one change notice. */
export const PATH_WATCH_PATHS_MAX_BYTES = 32 * 1024;

export type RlmPathWatchStatus = "active" | "completed" | "failed";

export interface RlmPathWatchInfo {
	watchId: string;
	/** Canonical watched path, resolved against the owner's cwd by the caller. */
	path: string;
	recursive: boolean;
	status: RlmPathWatchStatus;
	createdAt: string;
	error?: string;
}

export interface RlmPathWatchChange {
	watchId: string;
	path: string;
	recursive: boolean;
	paths: string[];
	truncated: boolean;
}

export interface RlmPathWatchFailure {
	watchId: string;
	path: string;
	recursive: boolean;
	error: string;
}

interface RlmPathWatchEntry {
	info: RlmPathWatchInfo;
	watcher: FSWatcher;
	pending: Set<string>;
	batchTimer?: NodeJS.Timeout;
}

export interface RlmPathWatchHandlers {
	/** One debounced batch of changed paths under a still-active watch. */
	onChange(change: RlmPathWatchChange): void;
	/** The watch stopped: the path was removed or the backend failed. */
	onFailure(failure: RlmPathWatchFailure): void;
}

/**
 * Session-owned filesystem subscriptions. The registry, not any kernel or
 * Python cell, owns the watchers, so subscriptions survive kernel restarts
 * and are released when the owning session terminates.
 */
export class RlmPathWatchRegistry {
	private readonly entries = new Map<string, RlmPathWatchEntry>();
	private readonly handlers: RlmPathWatchHandlers;
	private total = 0;

	constructor(handlers: RlmPathWatchHandlers) {
		this.handlers = handlers;
	}

	register(path: string, recursive: boolean): RlmPathWatchInfo {
		const active = [...this.entries.values()].filter((entry) => entry.info.status === "active").length;
		if (active >= MAX_ACTIVE_PATH_WATCHES) {
			throw new Error(`Too many active path watches: limit is ${MAX_ACTIVE_PATH_WATCHES}`);
		}
		if (this.total >= MAX_TOTAL_PATH_WATCHES) {
			throw new Error(`Too many path watch registrations: limit is ${MAX_TOTAL_PATH_WATCHES}`);
		}
		let stat: { isDirectory(): boolean };
		try {
			stat = statSync(path);
		} catch {
			throw new Error(`Watched path does not exist: ${path}`);
		}
		let watcher: FSWatcher;
		try {
			// Non-persistent watchers never hold the event loop open on their own;
			// owner lifetime (or process exit) ends them.
			watcher = watch(path, { recursive, persistent: false });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Cannot watch ${path}${recursive ? " recursively" : ""}: ${message}`);
		}
		const watchId = `watch_${randomUUID()}`;
		const entry: RlmPathWatchEntry = {
			info: {
				watchId,
				path,
				recursive: recursive && stat.isDirectory(),
				status: "active",
				createdAt: new Date().toISOString(),
			},
			watcher,
			pending: new Set(),
		};
		this.entries.set(watchId, entry);
		this.total += 1;
		watcher.on("change", (_eventType, filename) => {
			if (entry.info.status !== "active") return;
			entry.pending.add(filename ? join(path, String(filename)) : path);
			entry.batchTimer ??= setTimeout(() => this.flush(entry), PATH_WATCH_DEBOUNCE_MS);
		});
		watcher.on("error", (error) => this.fail(entry, error instanceof Error ? error.message : String(error)));
		// Watcher backends can drop the event for a deletion racing registration;
		// an initial liveness flush turns that into a failure notice instead of
		// silence. A flush with no pending paths emits nothing when all is well.
		entry.batchTimer ??= setTimeout(() => this.flush(entry), PATH_WATCH_DEBOUNCE_MS);
		return { ...entry.info };
	}

	get(watchId: string): RlmPathWatchInfo | undefined {
		const entry = this.entries.get(watchId);
		return entry ? { ...entry.info } : undefined;
	}

	list(): RlmPathWatchInfo[] {
		return [...this.entries.values()].map((entry) => ({ ...entry.info }));
	}

	cancel(watchId: string): RlmPathWatchInfo {
		const entry = this.entries.get(watchId);
		if (!entry) {
			throw new Error(`Unknown path watch: ${watchId}`);
		}
		if (entry.info.status === "active") {
			entry.info = { ...entry.info, status: "completed" };
			this.close(entry);
		}
		return { ...entry.info };
	}

	/** Release every watch; used at owner termination. */
	dispose(): void {
		for (const entry of this.entries.values()) {
			if (entry.info.status === "active") {
				entry.info = { ...entry.info, status: "completed" };
			}
			this.close(entry);
		}
		this.entries.clear();
	}

	private flush(entry: RlmPathWatchEntry): void {
		entry.batchTimer = undefined;
		if (entry.info.status !== "active") return;
		const paths = [...entry.pending];
		entry.pending.clear();
		// Observed removal stops the watch, mirroring the runtime design:
		// recreating the path needs a new registration.
		try {
			statSync(entry.info.path);
		} catch {
			this.fail(entry, "Watched path was removed");
			return;
		}
		if (paths.length === 0) return;
		const { list, truncated } = capPathList(paths);
		this.handlers.onChange({
			watchId: entry.info.watchId,
			path: entry.info.path,
			recursive: entry.info.recursive,
			paths: list,
			truncated,
		});
	}

	private fail(entry: RlmPathWatchEntry, error: string): void {
		if (entry.info.status !== "active") return;
		entry.info = { ...entry.info, status: "failed", error };
		this.close(entry);
		this.handlers.onFailure({
			watchId: entry.info.watchId,
			path: entry.info.path,
			recursive: entry.info.recursive,
			error,
		});
	}

	private close(entry: RlmPathWatchEntry): void {
		if (entry.batchTimer) {
			clearTimeout(entry.batchTimer);
			entry.batchTimer = undefined;
		}
		entry.pending.clear();
		entry.watcher.close();
	}
}

function capPathList(paths: string[]): { list: string[]; truncated: boolean } {
	const list: string[] = [];
	let bytes = 0;
	for (const path of paths) {
		const size = Buffer.byteLength(path, "utf8") + 1;
		if (bytes + size > PATH_WATCH_PATHS_MAX_BYTES) {
			return { list, truncated: true };
		}
		list.push(path);
		bytes += size;
	}
	return { list, truncated: false };
}

/** Resolve the watched path for an owner: absolute stays, relative joins the owner cwd. */
export function resolveWatchPath(path: string, cwd: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Kernel wire shape for one watch, matching the Python runtime contract. */
export function rlmPathWatchHostResponse(info: RlmPathWatchInfo): Record<string, unknown> {
	return {
		watch_id: info.watchId,
		path: info.path,
		recursive: info.recursive,
		status: info.status,
		created_at: info.createdAt,
		...(info.error !== undefined ? { error: info.error } : {}),
	};
}
