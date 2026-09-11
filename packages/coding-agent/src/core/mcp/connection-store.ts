// Local connection records for MCP services. Separate from credentials (auth.json):
// a record captures the verified connection state for a connectionId — the stable
// alias the kernel dispatches through — plus the catalog serviceId it connects and
// the endpoint the verification ran against. Tokens never live here.

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type McpConnectionRecordStatus = "connected" | "pending" | "error";

export interface McpConnectionRecord {
	/** Auth.json key suffix (`mcp:<connectionId>`) and the kernel dispatch id. */
	connectionId: string;
	/** Catalog service id; deliberately distinct from connectionId (aliases remain possible). */
	serviceId: string;
	/** Endpoint the record's verification ran against. */
	endpoint: string;
	label: string;
	status: McpConnectionRecordStatus;
	createdAt: number;
	updatedAt: number;
	/** Epoch ms of the last successful handshake + tools/list. */
	verifiedAt?: number;
	toolCount?: number;
	/** Sanitized, bounded failure detail for pending/error states. */
	lastError?: string;
}

interface McpConnectionsFile {
	version: 1;
	connections: Record<string, McpConnectionRecord>;
}

const MAX_LAST_ERROR_LENGTH = 500;

function sanitizeRecord(raw: unknown, connectionId: string): McpConnectionRecord | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Partial<McpConnectionRecord>;
	const string = (input: unknown): string | undefined => (typeof input === "string" ? input : undefined);
	const status = value.status;
	if (
		!string(value.connectionId) ||
		!string(value.serviceId) ||
		!string(value.endpoint) ||
		!string(value.label) ||
		(status !== "connected" && status !== "pending" && status !== "error")
	) {
		return undefined;
	}
	const record: McpConnectionRecord = {
		connectionId: string(value.connectionId) ?? connectionId,
		serviceId: string(value.serviceId) ?? "",
		endpoint: string(value.endpoint) ?? "",
		label: string(value.label) ?? string(value.connectionId) ?? connectionId,
		status,
		createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
	};
	if (typeof value.verifiedAt === "number") record.verifiedAt = value.verifiedAt;
	if (typeof value.toolCount === "number") record.toolCount = value.toolCount;
	const lastError = string(value.lastError);
	if (lastError) record.lastError = lastError.slice(0, MAX_LAST_ERROR_LENGTH);
	return record;
}

/** File-backed store of MCP connection records; corrupt or missing files reset to empty. */
export class McpConnectionStore {
	private recordsById = new Map<string, McpConnectionRecord>();

	private constructor(private readonly path: string) {}

	static open(path: string): McpConnectionStore {
		const store = new McpConnectionStore(path);
		store.load();
		return store;
	}

	/** Re-read the file. Tolerates a missing or corrupt file by resetting to empty. */
	load(): void {
		this.recordsById = new Map();
		let raw: string;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch {
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}
		const file = parsed as Partial<McpConnectionsFile>;
		if (!file || file.version !== 1 || typeof file.connections !== "object" || file.connections === null) return;
		for (const [connectionId, value] of Object.entries(file.connections)) {
			const record = sanitizeRecord(value, connectionId);
			if (record && record.connectionId === connectionId) {
				this.recordsById.set(connectionId, record);
			}
		}
	}

	get(connectionId: string): McpConnectionRecord | undefined {
		return this.recordsById.get(connectionId);
	}

	records(): readonly McpConnectionRecord[] {
		return [...this.recordsById.values()];
	}

	upsert(record: McpConnectionRecord): void {
		const now = Date.now();
		const previous = this.recordsById.get(record.connectionId);
		const next: McpConnectionRecord = {
			...record,
			createdAt: previous?.createdAt ?? record.createdAt ?? now,
			updatedAt: now,
			lastError: record.lastError ? record.lastError.slice(0, MAX_LAST_ERROR_LENGTH) : undefined,
		};
		if (next.status !== "connected") {
			delete next.verifiedAt;
			delete next.toolCount;
		}
		this.recordsById.set(record.connectionId, next);
	}

	remove(connectionId: string): void {
		this.recordsById.delete(connectionId);
	}

	/** Atomically persist (tmp file + rename). */
	async flush(): Promise<void> {
		const file: McpConnectionsFile = {
			version: 1,
			connections: Object.fromEntries(
				[...this.recordsById.entries()].sort(([left], [right]) => left.localeCompare(right)),
			),
		};
		const serialized = `${JSON.stringify(file, null, "\t")}\n`;
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.tmp`;
		await writeFile(temporary, serialized, "utf8");
		await rename(temporary, this.path);
	}
}

export type { McpConnectionsFile };
