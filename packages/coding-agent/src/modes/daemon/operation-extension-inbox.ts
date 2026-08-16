import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireSyncFileLock } from "../../utils/sync-file-lock.js";
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

interface OperationExtensionReceiptBase {
	type: "receipt";
	schemaVersion: typeof OPERATION_EXTENSION_SCHEMA_VERSION;
	requestId: string;
	recordedAt: string;
}

export type OperationExtensionReceipt =
	| (OperationExtensionReceiptBase & {
			status: "applied";
			deadlineAt: string;
			reason?: never;
	  })
	| (OperationExtensionReceiptBase & {
			status: "rejected";
			reason: string;
			deadlineAt?: never;
	  });

export interface OperationExtensionClaim {
	type: "claim";
	schemaVersion: typeof OPERATION_EXTENSION_SCHEMA_VERSION;
	requestId: string;
	claimedAt: string;
}

export type OperationExtensionEvent = OperationExtensionRequest | OperationExtensionReceipt | OperationExtensionClaim;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function requestsMatch(left: OperationExtensionRequest, right: OperationExtensionRequest): boolean {
	return (
		left.requestId === right.requestId &&
		left.operationId === right.operationId &&
		left.extensionMs === right.extensionMs &&
		left.source === right.source &&
		left.requestedAt === right.requestedAt
	);
}

function parseOperationExtensionEvent(value: unknown): OperationExtensionEvent | undefined {
	if (!isObject(value) || value.schemaVersion !== OPERATION_EXTENSION_SCHEMA_VERSION) return undefined;
	if (value.type === "request") {
		if (
			!isNonEmptyString(value.requestId) ||
			!isNonEmptyString(value.operationId) ||
			typeof value.extensionMs !== "number" ||
			!Number.isFinite(value.extensionMs) ||
			value.extensionMs <= 0 ||
			value.source !== "human" ||
			!isTimestamp(value.requestedAt)
		) {
			return undefined;
		}
		return {
			type: "request",
			schemaVersion: OPERATION_EXTENSION_SCHEMA_VERSION,
			requestId: value.requestId,
			operationId: value.operationId,
			extensionMs: value.extensionMs,
			source: "human",
			requestedAt: value.requestedAt,
		};
	}
	if (value.type === "receipt") {
		if (!isNonEmptyString(value.requestId) || !isTimestamp(value.recordedAt)) return undefined;
		if (value.status === "applied") {
			if (!isTimestamp(value.deadlineAt) || value.reason !== undefined) return undefined;
			return {
				type: "receipt",
				schemaVersion: OPERATION_EXTENSION_SCHEMA_VERSION,
				requestId: value.requestId,
				status: "applied",
				deadlineAt: value.deadlineAt,
				recordedAt: value.recordedAt,
			};
		}
		if (value.status !== "rejected" || !isNonEmptyString(value.reason) || value.deadlineAt !== undefined) {
			return undefined;
		}
		return {
			type: "receipt",
			schemaVersion: OPERATION_EXTENSION_SCHEMA_VERSION,
			requestId: value.requestId,
			status: "rejected",
			reason: value.reason,
			recordedAt: value.recordedAt,
		};
	}
	if (value.type !== "claim" || !isNonEmptyString(value.requestId) || !isTimestamp(value.claimedAt)) {
		return undefined;
	}
	return {
		type: "claim",
		schemaVersion: OPERATION_EXTENSION_SCHEMA_VERSION,
		requestId: value.requestId,
		claimedAt: value.claimedAt,
	};
}

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

	// A request is no longer pending once it has been claimed, not merely once it has a receipt.
	// Claiming is what makes application exactly-once: if the receipt write later fails, the claim
	// still suppresses the request, so a sweep can never re-apply the same extension.
	pending(): OperationExtensionRequest[] {
		const events = this.events();
		const settled = new Set(
			events
				.filter(
					(event): event is OperationExtensionReceipt | OperationExtensionClaim =>
						event.type === "receipt" || event.type === "claim",
				)
				.map((event) => event.requestId),
		);
		return events.filter(
			(event): event is OperationExtensionRequest => event.type === "request" && !settled.has(event.requestId),
		);
	}

	// Durably reserve a request before its extension is applied. The compare-and-set runs while
	// holding a cross-process lock: stale copies returned by pending() cannot both append claims.
	claim(request: OperationExtensionRequest): OperationExtensionClaim {
		return this.withLock(() => {
			const events = this.events();
			const authoritative = events.find(
				(event): event is OperationExtensionRequest =>
					event.type === "request" && event.requestId === request.requestId,
			);
			if (!authoritative || !requestsMatch(authoritative, request)) {
				throw new Error(`Operation extension request ${request.requestId} is not authoritative`);
			}
			if (
				events.some(
					(event) => (event.type === "claim" || event.type === "receipt") && event.requestId === request.requestId,
				)
			) {
				throw new Error(`Operation extension request ${request.requestId} is already settled`);
			}
			const claim: OperationExtensionClaim = {
				type: "claim",
				schemaVersion: OPERATION_EXTENSION_SCHEMA_VERSION,
				requestId: request.requestId,
				claimedAt: new Date(this.now()).toISOString(),
			};
			this.append(claim);
			return claim;
		});
	}

	record(request: OperationExtensionRequest, result: DeadlineExtensionResult): OperationExtensionReceipt {
		return this.withLock(() => {
			const events = this.events();
			const authoritative = events.find(
				(event): event is OperationExtensionRequest =>
					event.type === "request" && event.requestId === request.requestId,
			);
			if (!authoritative || !requestsMatch(authoritative, request)) {
				throw new Error(`Operation extension request ${request.requestId} is not authoritative`);
			}
			if (events.some((event) => event.type === "receipt" && event.requestId === request.requestId)) {
				throw new Error(`Operation extension request ${request.requestId} already has a receipt`);
			}
			const recordedAt = new Date(this.now()).toISOString();
			let receipt: OperationExtensionReceipt;
			if (result.status === "applied") {
				const deadlineAt = result.record.deadlineAt;
				if (!deadlineAt) throw new Error("Applied operation extension is missing its deadline");
				receipt = {
					type: "receipt",
					schemaVersion: OPERATION_EXTENSION_SCHEMA_VERSION,
					requestId: request.requestId,
					status: "applied",
					deadlineAt,
					recordedAt,
				};
			} else {
				receipt = {
					type: "receipt",
					schemaVersion: OPERATION_EXTENSION_SCHEMA_VERSION,
					requestId: request.requestId,
					status: "rejected",
					reason: result.reason,
					recordedAt,
				};
			}
			this.append(receipt);
			return receipt;
		});
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
				const event = parseOperationExtensionEvent(JSON.parse(line) as unknown);
				if (event) events.push(event);
			} catch {
				// Ignore an interrupted append; typed events written before it remain authoritative.
			}
		}
		return events;
	}

	private withLock<T>(action: () => T): T {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const release = acquireSyncFileLock(this.path, { lockfilePath: `${this.path}.lock`, staleMs: 30_000 });
		try {
			return action();
		} finally {
			release();
		}
	}

	// The inbox directory is created on first write, never in the constructor: the daemon must still
	// construct when the reliability directory is unusable, matching OperationLedger's degradation.
	private append(event: OperationExtensionEvent): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
	}
}
