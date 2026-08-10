import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeadlineExtensionResult } from "./operation-ledger.js";

export const OPERATION_EXTENSION_SCHEMA_VERSION = 1 as const;

export interface OperationExtensionRequest {
	type: "request";
	schemaVersion: typeof OPERATION_EXTENSION_SCHEMA_VERSION;
	requestId: string;
	operationId: string;
	extensionMs: number;
	source: "human";
	requestedAt: string;
}

export interface OperationExtensionReceipt {
	type: "receipt";
	schemaVersion: typeof OPERATION_EXTENSION_SCHEMA_VERSION;
	requestId: string;
	status: "applied" | "rejected";
	reason?: string;
	deadlineAt?: string;
	recordedAt: string;
}

export type OperationExtensionEvent = OperationExtensionRequest | OperationExtensionReceipt;

export class OperationExtensionInbox {
	readonly path: string;
	private readonly now: () => number;

	constructor(rootDir: string, now: () => number = Date.now) {
		this.path = join(rootDir, "operation-extensions.jsonl");
		this.now = now;
	}

	request(operationId: string, extensionMs: number): OperationExtensionRequest {
		if (!operationId.trim()) throw new Error("Operation id is required");
		if (!Number.isFinite(extensionMs) || extensionMs <= 0) throw new Error("Extension must be positive");
		const request: OperationExtensionRequest = {
			type: "request",
			schemaVersion: OPERATION_EXTENSION_SCHEMA_VERSION,
			requestId: `extension_${randomUUID()}`,
			operationId,
			extensionMs,
			source: "human",
			requestedAt: new Date(this.now()).toISOString(),
		};
		this.append(request);
		return request;
	}

	pending(): OperationExtensionRequest[] {
		const events = this.events();
		const settled = new Set(
			events
				.filter((event): event is OperationExtensionReceipt => event.type === "receipt")
				.map((event) => event.requestId),
		);
		return events.filter(
			(event): event is OperationExtensionRequest => event.type === "request" && !settled.has(event.requestId),
		);
	}

	record(request: OperationExtensionRequest, result: DeadlineExtensionResult): OperationExtensionReceipt {
		const receipt: OperationExtensionReceipt = {
			type: "receipt",
			schemaVersion: OPERATION_EXTENSION_SCHEMA_VERSION,
			requestId: request.requestId,
			status: result.status,
			...(result.status === "applied" ? { deadlineAt: result.record.deadlineAt } : { reason: result.reason }),
			recordedAt: new Date(this.now()).toISOString(),
		};
		this.append(receipt);
		return receipt;
	}

	events(): OperationExtensionEvent[] {
		let text: string;
		try {
			text = readFileSync(this.path, "utf8");
		} catch {
			return [];
		}
		const events: OperationExtensionEvent[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as OperationExtensionEvent;
				if (
					event.schemaVersion === OPERATION_EXTENSION_SCHEMA_VERSION &&
					(event.type === "request" || event.type === "receipt")
				) {
					events.push(event);
				}
			} catch {
				// Ignore a torn final line; prior append-only events remain authoritative.
			}
		}
		return events;
	}

	// The inbox directory is created on first write, never in the constructor: the daemon must still
	// construct when the reliability directory is unusable, matching OperationLedger's degradation.
	private append(event: OperationExtensionEvent): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
	}
}
