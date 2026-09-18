import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalSessionPath } from "../session-lease.js";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	getSessionArtifactPathForFile,
	parseSessionEntries,
	type SessionEntry,
	type SessionHeader,
} from "../session-manager.js";
import type { CloudArtifactRef, CloudSessionId } from "./protocol.js";

/**
 * Single-writer durable mirror of one remote session's transcript.
 *
 * One resident cloud session (root or remote descendant) owns exactly one
 * local shadow file: an ordinary session JSONL whose session id equals the
 * remote session id, so every local consumer (/resume, the saved-session
 * catalog, the agents view, observe) reads it without new rendering code.
 *
 * Guarantees:
 * - The shadow is created only when absent, and opened only when its header
 *   id equals the expected session id; a mismatch is a split-brain hazard
 *   and fails closed (`claimShadowSession`).
 * - Every appended entry is deduplicated by entry id, so guest event replay
 *   (snapshot resubscribe, retention resync) never duplicates a line.
 * - A batch of mirrored entries becomes durable via `sync()` (fsync), and the
 *   caller acknowledges the guest only afterwards; a crashed supervisor
 *   never loses an acknowledged entry.
 * - Entries that traveled as artifact references (payload above
 *   CLOUD_MAX_INLINE_ENTRY_BYTES) are resolved through a bounded, digest-
 *   verified transfer: small payloads are inlined, large payloads are stored
 *   under the session's artifact directory and referenced from a marker entry.
 */

/** One artifact resolved through the bounded gateway transfer. */
export interface ShadowArtifactResolver {
	/** Fetch one artifact ref's bytes; the implementation bounds the transfer. */
	fetch(ref: CloudArtifactRef): Promise<Uint8Array>;
}

/** Payloads up to this size are inlined into the shadow transcript. */
export const CLOUD_SHADOW_INLINE_ARTIFACT_MAX_BYTES = 1_048_576;
/** Artifact transfer bound; larger refs fail closed instead of ballooning the shadow. */
export const CLOUD_SHADOW_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export class ShadowSessionSplitBrainError extends Error {
	constructor(sessionFile: string, expectedSessionId: string, foundSessionId: string) {
		super(
			`Shadow session ${sessionFile} belongs to session ${foundSessionId}, not ${expectedSessionId}; refusing a second writer`,
		);
		this.name = "ShadowSessionSplitBrainError";
	}
}

export class ShadowSessionArtifactError extends Error {
	constructor(ref: CloudArtifactRef, reason: string) {
		super(`Shadow artifact ${ref.path} failed to mirror: ${reason}`);
		this.name = "ShadowSessionArtifactError";
	}
}

export interface ShadowSessionWriterOptions {
	/** Canonical shadow file path (`<sessionDir>/<sessionId>.jsonl`). */
	sessionFile: string;
	/** Remote session id; must equal the shadow header id. */
	sessionId: string;
	/** Workspace cwd recorded in the shadow header. */
	cwd: string;
	/** The owning cloud session record's id (marker entry). */
	cloudSessionId: CloudSessionId;
	/** Sandbox incarnation recorded in the marker entry. */
	generation: number;
	/** Platform sandbox id recorded in the marker entry. */
	sandboxId?: string;
	/** Parent session file (remote descendants carry a real parent edge). */
	parentSessionPath?: string;
	/** RLM depth (0 for the converted root). */
	rlmDepth?: number;
	/** Resolves oversized entry payloads; omit to reject artifact refs. */
	artifactResolver?: ShadowArtifactResolver;
}

interface ShadowHeadInfo {
	cloudSessionId: string;
	generation: number;
	sandboxId?: string;
}

/** Marker entry written at the head of every cloud shadow (pattern: prime-agent.cloud-event). */
export const CLOUD_SHADOW_HEAD_CUSTOM_TYPE = "prime-agent.cloud-session";
/** Marker entry written when a shadow continues under a new sandbox generation. */
export const CLOUD_SHADOW_GENERATION_CUSTOM_TYPE = "prime-agent.cloud-generation";

export class ShadowSessionWriter {
	readonly sessionFile: string;
	readonly sessionId: string;
	private readonly artifactResolver: ShadowArtifactResolver | undefined;
	private entries: FileEntry[];
	private readonly entryIds = new Set<string>();
	private fd: number | undefined;
	private dirty = false;
	private head: ShadowHeadInfo;

	private constructor(options: ShadowSessionWriterOptions, entries: FileEntry[], head: ShadowHeadInfo) {
		this.sessionFile = options.sessionFile;
		this.sessionId = options.sessionId;
		this.artifactResolver = options.artifactResolver;
		this.entries = entries;
		this.head = head;
		for (const entry of entries) {
			if (entry.type !== "session") this.entryIds.add(entry.id);
		}
	}

	/** The shadow header (session identity, cwd, parent edge). */
	get header(): SessionHeader {
		const header = this.entries.find((entry) => entry.type === "session");
		if (!header) throw new Error(`Shadow session ${this.sessionFile} has no header`);
		return header as SessionHeader;
	}

	get generation(): number {
		return this.head.generation;
	}

	get entryCount(): number {
		return this.entries.length;
	}

	/** Parsed entries (header first), the local mirror of the remote transcript. */
	getEntries(): FileEntry[] {
		return [...this.entries];
	}

	/**
	 * Open an existing shadow or create it. A file whose header id differs
	 * from `sessionId` fails closed: the registry never writes into a
	 * transcript it does not own (split-brain guard).
	 */
	static openOrCreate(options: ShadowSessionWriterOptions): ShadowSessionWriter {
		const existing = existsSync(options.sessionFile)
			? parseSessionEntries(readFileSync(options.sessionFile, "utf8"))
			: undefined;
		const head: ShadowHeadInfo = {
			cloudSessionId: options.cloudSessionId,
			generation: options.generation,
			...(options.sandboxId ? { sandboxId: options.sandboxId } : {}),
		};
		if (existing === undefined || existing.length === 0) {
			return ShadowSessionWriter.create(options, head);
		}
		const header = existing.find((entry) => entry.type === "session") as SessionHeader | undefined;
		if (header === undefined || header.id !== options.sessionId) {
			throw new ShadowSessionSplitBrainError(
				options.sessionFile,
				options.sessionId,
				header?.id ?? "<missing header>",
			);
		}
		return new ShadowSessionWriter(options, existing, head);
	}

	private static create(options: ShadowSessionWriterOptions, head: ShadowHeadInfo): ShadowSessionWriter {
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: options.sessionId,
			timestamp,
			cwd: options.cwd,
			...(options.parentSessionPath ? { parentSession: options.parentSessionPath } : {}),
			rlmDepth: options.rlmDepth ?? 0,
		};
		const marker: SessionEntry = {
			type: "custom",
			id: newShadowEntryId(),
			parentId: null,
			timestamp,
			customType: CLOUD_SHADOW_HEAD_CUSTOM_TYPE,
			data: {
				cloudSessionId: options.cloudSessionId,
				generation: options.generation,
				...(options.sandboxId ? { sandboxId: options.sandboxId } : {}),
			},
		};
		const writer = new ShadowSessionWriter(options, [header, marker], head);
		writer.appendLine(header);
		writer.appendLine(marker);
		writer.sync();
		return writer;
	}

	/** True when the shadow already records this entry id (dedupe). */
	hasEntry(entryId: string): boolean {
		return this.entryIds.has(entryId);
	}

	/**
	 * Mirror one session entry. Returns true when a new line landed, false on
	 * dedupe. Oversized payload artifacts are resolved through the bounded
	 * resolver; an unresolvable artifact throws and the caller must not
	 * acknowledge the event.
	 */
	async appendEntry(entry: Record<string, unknown>, artifacts?: readonly CloudArtifactRef[]): Promise<boolean> {
		const entryId = typeof entry.id === "string" ? entry.id : "";
		if (entryId !== "" && this.entryIds.has(entryId)) {
			return false;
		}
		let resolved: Record<string, unknown> | undefined;
		if (artifacts !== undefined && artifacts.length > 0) {
			resolved = await this.resolveArtifacts(entry, artifacts);
		} else {
			resolved = entry;
		}
		const fileEntry = resolved as unknown as FileEntry;
		if (fileEntry.type === "session") {
			// The guest never re-emits its header; a header-shaped entry means
			// the stream is corrupt, not that the shadow gains a second header.
			throw new Error(`Shadow session ${this.sessionFile} refused a second session header`);
		}
		this.entryIds.add(fileEntry.id);
		this.entries.push(fileEntry);
		this.appendLine(fileEntry);
		return true;
	}

	/**
	 * Resolve one artifact-backed entry through the bounded transfer: verify
	 * the digest and size, then inline small payloads or store large ones
	 * under the session's artifact directory with a marker entry.
	 */
	private async resolveArtifacts(
		identity: Record<string, unknown>,
		artifacts: readonly CloudArtifactRef[],
	): Promise<Record<string, unknown>> {
		if (this.artifactResolver === undefined) {
			throw new ShadowSessionArtifactError(artifacts[0]!, "no artifact resolver is configured");
		}
		const ref = artifacts[0]!;
		if (ref.bytes > CLOUD_SHADOW_MAX_ARTIFACT_BYTES) {
			throw new ShadowSessionArtifactError(ref, `artifact of ${ref.bytes} bytes exceeds the mirror bound`);
		}
		let payload: Uint8Array;
		try {
			payload = await this.artifactResolver.fetch(ref);
		} catch (error) {
			throw new ShadowSessionArtifactError(ref, error instanceof Error ? error.message : String(error));
		}
		if (payload.byteLength !== ref.bytes) {
			throw new ShadowSessionArtifactError(ref, `transferred ${payload.byteLength} bytes, expected ${ref.bytes}`);
		}
		const digest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
		if (digest !== ref.sha256) {
			throw new ShadowSessionArtifactError(ref, "sha256 digest mismatch");
		}
		const text = Buffer.from(payload).toString("utf8");
		if (ref.bytes <= CLOUD_SHADOW_INLINE_ARTIFACT_MAX_BYTES) {
			return JSON.parse(text) as Record<string, unknown>;
		}
		// Large payloads live under the session artifact directory; the
		// transcript keeps only a durable marker. The identity stub is never
		// appended: without its artifact payload it is not a valid entry, and
		// a truncated message would poison every local parser of the shadow.
		const artifactDir = join(getSessionArtifactPathForFile(this.sessionFile), "cloud-artifacts");
		mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
		const artifactPath = join(artifactDir, `${typeof identity.id === "string" ? identity.id : "entry"}.json`);
		writeFileSync(artifactPath, payload, { mode: 0o600 });
		const marker: SessionEntry = {
			type: "custom",
			id: typeof identity.id === "string" ? identity.id : newShadowEntryId(),
			parentId: null,
			timestamp: typeof identity.timestamp === "string" ? identity.timestamp : new Date().toISOString(),
			customType: "prime-agent.cloud-artifact",
			data: {
				entryId: identity.id,
				entryType: typeof identity.type === "string" ? identity.type : undefined,
				path: artifactPath,
				sha256: ref.sha256,
				bytes: ref.bytes,
			},
		};
		this.entryIds.add(marker.id);
		this.entries.push(marker);
		this.appendLine(marker);
		return marker as unknown as Record<string, unknown>;
	}

	/** Record a sandbox-generation boundary inside the shadow transcript. */
	appendGenerationMarker(next: { generation: number; sandboxId?: string }): void {
		const marker: SessionEntry = {
			type: "custom",
			id: newShadowEntryId(),
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: CLOUD_SHADOW_GENERATION_CUSTOM_TYPE,
			data: { generation: next.generation, ...(next.sandboxId ? { sandboxId: next.sandboxId } : {}) },
		};
		this.head = { cloudSessionId: this.head.cloudSessionId, generation: next.generation };
		this.entryIds.add(marker.id);
		this.entries.push(marker);
		this.appendLine(marker);
	}

	/** fsync the shadow; resolves only when the mirrored lines are durable. */
	sync(): void {
		if (this.fd === undefined) {
			this.fd = openSync(this.sessionFile, "a");
			chmodSync(this.sessionFile, 0o600);
		}
		if (this.dirty) {
			fsyncSync(this.fd);
			this.dirty = false;
		}
	}

	async close(): Promise<void> {
		this.sync();
		if (this.fd !== undefined) {
			closeSync(this.fd);
			this.fd = undefined;
		}
	}

	/** The canonical shadow path, the create/attach interception key. */
	static shadowSessionFile(sessionDir: string, sessionId: string): string {
		return canonicalSessionPath(join(sessionDir, `${sessionId}.jsonl`));
	}

	static shadowFileForId(sessionDir: string, remoteSessionId: string): string {
		return join(sessionDir, `${remoteSessionId}.jsonl`);
	}

	static shadowFileExists(sessionFile: string): boolean {
		try {
			return statSync(sessionFile).isFile();
		} catch {
			return false;
		}
	}

	private appendLine(entry: FileEntry): void {
		if (this.fd === undefined) {
			mkdirSync(dirname(this.sessionFile), { recursive: true, mode: 0o700 });
			this.fd = openSync(this.sessionFile, "a");
			chmodSync(this.sessionFile, 0o600);
		}
		const line = `${JSON.stringify(entry)}\n`;
		if (Buffer.byteLength(line, "utf8") > CLOUD_SHADOW_INLINE_ARTIFACT_MAX_BYTES * 2) {
			throw new Error(
				`Shadow session ${this.sessionFile} refused an entry of ${Buffer.byteLength(line, "utf8")} bytes`,
			);
		}
		writeSync(this.fd, line);
		this.dirty = true;
	}
}

let shadowEntryCounter = 0;

/** Entry ids inside a shadow must be unique; guest ids are authoritative, markers are synthetic. */
function newShadowEntryId(): string {
	shadowEntryCounter += 1;
	return `cloudshadow_${Date.now().toString(36)}_${shadowEntryCounter.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
