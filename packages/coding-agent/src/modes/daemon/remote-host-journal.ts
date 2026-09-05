/**
 * Replay/deduplication/ack journal for remote-agent-host protocol.
 *
 * Append-only JSONL journal that records every frame sent and received over
 * a remote-host link. Supports replay (reading back frames from a cursor
 * position), deduplication (detecting and rejecting duplicate frame IDs),
 * and durable ACK tracking (marking acknowledged frames for replay recovery).
 *
 * The journal lives on the home daemon and is the durable record of the
 * link's message exchange.
 */

import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
} from "node:fs";
import { dirname } from "node:path";
import type {
	RemoteHostEventCursor,
	RemoteHostEventSequence,
	RemoteHostFrame,
	RemoteHostFrameEnvelope,
	RemoteHostFrameId,
} from "./remote-agent-host-protocol.js";

export type RemoteHostJournalEntryType = "sent" | "received";

export interface RemoteHostJournalEntry {
	journalSeq: number;
	type: RemoteHostJournalEntryType;
	frameId: RemoteHostFrameId;
	recordedAt: string;
	frame: RemoteHostFrame;
	hostId: string;
	generation: string;
	sessionId: string;
	eventSequence?: RemoteHostEventSequence;
}

export interface RemoteHostDedupState {
	received: Set<RemoteHostFrameId>;
	acknowledged: Set<RemoteHostFrameId>;
	lastReceivedEventSequence: RemoteHostEventSequence;
	lastSentEventSequence: RemoteHostEventSequence;
}

export function createRemoteHostDedupState(): RemoteHostDedupState {
	return {
		received: new Set(),
		acknowledged: new Set(),
		lastReceivedEventSequence: 0,
		lastSentEventSequence: 0,
	};
}

export type JournalReplayDirection = "sent" | "received" | "both";

export class RemoteHostJournal {
	private readonly journalPath: string;
	private nextSeq: number;
	private readonly hostId: string;
	private readonly generation: string;
	private readonly sessionId: string;
	private readonly dedup: RemoteHostDedupState;

	constructor(opts: { path: string; hostId: string; generation: string; sessionId: string }) {
		this.journalPath = opts.path;
		this.hostId = opts.hostId;
		this.generation = opts.generation;
		this.sessionId = opts.sessionId;
		this.nextSeq = 1;
		this.dedup = createRemoteHostDedupState();

		const dir = dirname(opts.path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}

		if (existsSync(opts.path)) {
			const mode = statSync(opts.path).mode & 0o777;
			if (mode !== 0o600) {
				chmodSync(opts.path, 0o600);
			}
			const content = readFileSync(opts.path, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			for (const line of lines) {
				try {
					const entry = JSON.parse(line) as RemoteHostJournalEntry;
					// Ignore entries for a different identity.
					if (entry.hostId !== this.hostId) continue;
					if (entry.generation !== this.generation) continue;
					if (entry.sessionId !== this.sessionId) continue;
					if (entry.journalSeq >= this.nextSeq) {
						this.nextSeq = entry.journalSeq + 1;
					}
					if (entry.type === "received") {
						this.dedup.received.add(entry.frameId);
						if (entry.eventSequence !== undefined && entry.eventSequence > this.dedup.lastReceivedEventSequence) {
							this.dedup.lastReceivedEventSequence = entry.eventSequence;
						}
						if (entry.frame.type === "ack" && "acknowledges" in entry.frame) {
							this.dedup.acknowledged.add((entry.frame as { acknowledges: string }).acknowledges);
						}
					}
					if (
						entry.type === "sent" &&
						entry.eventSequence !== undefined &&
						entry.eventSequence > this.dedup.lastSentEventSequence
					) {
						this.dedup.lastSentEventSequence = entry.eventSequence;
					}
				} catch {
					// Skip corrupt lines.
				}
			}
		}
	}

	get path(): string {
		return this.journalPath;
	}

	recordSent(frame: RemoteHostFrameEnvelope): RemoteHostJournalEntry {
		const entry: RemoteHostJournalEntry = {
			journalSeq: this.nextSeq++,
			type: "sent",
			frameId: frame.frameId,
			recordedAt: new Date().toISOString(),
			frame: frame.frame,
			hostId: this.hostId,
			generation: this.generation,
			sessionId: this.sessionId,
			eventSequence: frame.frame.type === "event" ? frame.frame.sequence : undefined,
		};
		if (frame.frame.type === "event") {
			this.dedup.lastSentEventSequence = frame.frame.sequence;
		}
		this.persistEntry(entry);
		return entry;
	}

	recordReceived(frame: RemoteHostFrameEnvelope): { entry: RemoteHostJournalEntry; isDuplicate: boolean } {
		const isDuplicate = this.dedup.received.has(frame.frameId);
		if (!isDuplicate) {
			this.dedup.received.add(frame.frameId);
			if (frame.frame.type === "event" && frame.frame.sequence > this.dedup.lastReceivedEventSequence) {
				this.dedup.lastReceivedEventSequence = frame.frame.sequence;
			}
		}
		const entry: RemoteHostJournalEntry = {
			journalSeq: this.nextSeq++,
			type: "received",
			frameId: frame.frameId,
			recordedAt: new Date().toISOString(),
			frame: frame.frame,
			hostId: this.hostId,
			generation: this.generation,
			sessionId: this.sessionId,
			eventSequence: frame.frame.type === "event" ? frame.frame.sequence : undefined,
		};
		if (frame.frame.type === "ack") {
			this.dedup.acknowledged.add(frame.frame.acknowledges);
		}
		this.persistEntry(entry);
		return { entry, isDuplicate };
	}

	isDuplicate(frameId: RemoteHostFrameId): boolean {
		return this.dedup.received.has(frameId);
	}

	readEntries(fromSeq: number = 1, limit: number = 1000): RemoteHostJournalEntry[] {
		if (!existsSync(this.journalPath)) {
			return [];
		}
		const content = readFileSync(this.journalPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		const entries: RemoteHostJournalEntry[] = [];
		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as RemoteHostJournalEntry;
				if (entry.journalSeq < fromSeq) continue;
				if (entry.hostId !== this.hostId) continue;
				if (entry.generation !== this.generation) continue;
				if (entry.sessionId !== this.sessionId) continue;
				entries.push(entry);
				if (entries.length >= limit) break;
			} catch {
				// Skip corrupt lines.
			}
		}
		return entries;
	}

	/**
	 * Get replay entries matching a resume cursor and a direction filter.
	 * Filtering by cursor/direction happens before the limit so gaps and
	 * overflow are detected correctly. Reports partial when more entries
	 * remain beyond the limit or when a sequence gap is detected.
	 */
	getReplayEntries(
		resumeCursor: RemoteHostEventCursor,
		_limit: number = 500,
		direction: JournalReplayDirection = "sent",
	): { status: "complete" | "partial" | "unavailable"; entries: RemoteHostJournalEntry[]; reason?: string } {
		if (resumeCursor.hostId !== this.hostId) {
			return { status: "unavailable", entries: [], reason: "host_identity_mismatch" };
		}
		if (resumeCursor.generation !== this.generation) {
			return { status: "unavailable", entries: [], reason: "generation_changed" };
		}
		if (resumeCursor.sessionId !== this.sessionId) {
			return { status: "unavailable", entries: [], reason: "session_mismatch" };
		}
		if (!existsSync(this.journalPath)) {
			if (resumeCursor.sequence > 0) {
				return { status: "unavailable", entries: [], reason: "journal_missing" };
			}
			return { status: "complete", entries: [] };
		}

		const safeLimit = Number.isSafeInteger(_limit) && _limit > 0 ? Math.min(_limit, 1000) : 500;

		const content = readFileSync(this.journalPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		const matching: RemoteHostJournalEntry[] = [];
		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as RemoteHostJournalEntry;
				if (entry.hostId !== this.hostId) continue;
				if (entry.generation !== this.generation) continue;
				if (entry.sessionId !== this.sessionId) continue;
				if (
					entry.eventSequence !== undefined &&
					entry.eventSequence > resumeCursor.sequence &&
					(direction === "both" || entry.type === direction)
				) {
					matching.push(entry);
				}
			} catch {
				// Skip corrupt lines.
			}
		}

		if (matching.length === 0) {
			return { status: "complete", entries: [] };
		}

		let hasGap = false;
		let expectedSeq = resumeCursor.sequence + 1;
		for (const e of matching) {
			if (e.eventSequence !== undefined) {
				if (e.eventSequence > expectedSeq) {
					hasGap = true;
					break;
				}
				expectedSeq = e.eventSequence + 1;
			}
		}

		const totalMatched = matching.length;
		const limited = matching.slice(0, safeLimit);

		if (hasGap) {
			return { status: "partial", entries: limited, reason: "event_sequence_gap" };
		}

		if (totalMatched > _limit) {
			return { status: "partial", entries: limited, reason: "more_entries_available" };
		}

		return { status: "complete", entries: limited };
	}

	getReplaySentFrames(
		resumeCursor: RemoteHostEventCursor,
		limit: number = 500,
	): { status: "complete" | "partial" | "unavailable"; frames: RemoteHostFrame[]; reason?: string } {
		const result = this.getReplayEntries(resumeCursor, limit, "sent");
		return {
			status: result.status,
			frames: result.entries.map((e) => e.frame),
			reason: result.reason,
		};
	}

	/**
	 * Returns sent entries (excluding health/handshake/ack frames) that
	 * have NOT been durably acknowledged via a received ack frame.
	 * Entries are returned in journalSeq order (oldest first).
	 */
	getUnacknowledgedSentEntries(): RemoteHostJournalEntry[] {
		if (!existsSync(this.journalPath)) {
			return [];
		}
		const content = readFileSync(this.journalPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		const unacked: RemoteHostJournalEntry[] = [];
		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as RemoteHostJournalEntry;
				if (entry.hostId !== this.hostId) continue;
				if (entry.generation !== this.generation) continue;
				if (entry.sessionId !== this.sessionId) continue;
				if (entry.type !== "sent") continue;
				if (entry.frame.type === "health" || entry.frame.type === "handshake" || entry.frame.type === "ack")
					continue;
				if (this.dedup.acknowledged.has(entry.frameId)) continue;
				unacked.push(entry);
			} catch {
				// Skip corrupt lines.
			}
		}
		return unacked;
	}

	get lastReceivedEventSequence(): RemoteHostEventSequence {
		return this.dedup.lastReceivedEventSequence;
	}

	get lastSentEventSequence(): RemoteHostEventSequence {
		return this.dedup.lastSentEventSequence;
	}

	get dedupCount(): number {
		return this.dedup.received.size;
	}

	private persistEntry(entry: RemoteHostJournalEntry): void {
		const fd = openSync(this.journalPath, "a", 0o600);
		try {
			appendFileSync(fd, `${JSON.stringify(entry)}\n`, "utf-8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
}

export class InMemoryRemoteHostJournal implements RemoteHostJournalLike {
	private entries: RemoteHostJournalEntry[] = [];
	private nextSeq: number = 1;
	private readonly hostId: string;
	private readonly generation: string;
	private readonly sessionId: string;
	private readonly dedup: RemoteHostDedupState;

	constructor(opts: { hostId: string; generation: string; sessionId: string }) {
		this.hostId = opts.hostId;
		this.generation = opts.generation;
		this.sessionId = opts.sessionId;
		this.dedup = createRemoteHostDedupState();
	}

	get path(): string {
		return "(memory)";
	}

	recordSent(frame: RemoteHostFrameEnvelope): RemoteHostJournalEntry {
		const entry: RemoteHostJournalEntry = {
			journalSeq: this.nextSeq++,
			type: "sent",
			frameId: frame.frameId,
			recordedAt: new Date().toISOString(),
			frame: frame.frame,
			hostId: this.hostId,
			generation: this.generation,
			sessionId: this.sessionId,
			eventSequence: frame.frame.type === "event" ? frame.frame.sequence : undefined,
		};
		if (frame.frame.type === "event") {
			this.dedup.lastSentEventSequence = frame.frame.sequence;
		}
		this.entries.push(entry);
		return entry;
	}

	recordReceived(frame: RemoteHostFrameEnvelope): { entry: RemoteHostJournalEntry; isDuplicate: boolean } {
		const isDuplicate = this.dedup.received.has(frame.frameId);
		if (!isDuplicate) {
			this.dedup.received.add(frame.frameId);
			if (frame.frame.type === "event" && frame.frame.sequence > this.dedup.lastReceivedEventSequence) {
				this.dedup.lastReceivedEventSequence = frame.frame.sequence;
			}
		}
		const entry: RemoteHostJournalEntry = {
			journalSeq: this.nextSeq++,
			type: "received",
			frameId: frame.frameId,
			recordedAt: new Date().toISOString(),
			frame: frame.frame,
			hostId: this.hostId,
			generation: this.generation,
			sessionId: this.sessionId,
			eventSequence: frame.frame.type === "event" ? frame.frame.sequence : undefined,
		};
		if (frame.frame.type === "ack") {
			this.dedup.acknowledged.add(frame.frame.acknowledges);
		}
		this.entries.push(entry);
		return { entry, isDuplicate };
	}

	isDuplicate(frameId: RemoteHostFrameId): boolean {
		return this.dedup.received.has(frameId);
	}

	readEntries(fromSeq: number = 1, limit: number = 1000): RemoteHostJournalEntry[] {
		return this.entries.filter((e) => e.journalSeq >= fromSeq).slice(0, limit);
	}

	getReplayEntries(
		resumeCursor: RemoteHostEventCursor,
		_limit: number = 500,
		direction: JournalReplayDirection = "sent",
	): { status: "complete" | "partial" | "unavailable"; entries: RemoteHostJournalEntry[]; reason?: string } {
		if (resumeCursor.hostId !== this.hostId) {
			return { status: "unavailable", entries: [], reason: "host_identity_mismatch" };
		}
		if (resumeCursor.generation !== this.generation) {
			return { status: "unavailable", entries: [], reason: "generation_changed" };
		}
		if (resumeCursor.sessionId !== this.sessionId) {
			return { status: "unavailable", entries: [], reason: "session_mismatch" };
		}

		const safeLimit = Number.isSafeInteger(_limit) && _limit > 0 ? Math.min(_limit, 1000) : 500;

		const matching = this.entries.filter(
			(e) =>
				e.eventSequence !== undefined &&
				e.eventSequence > resumeCursor.sequence &&
				(direction === "both" || e.type === direction),
		);

		if (matching.length === 0) {
			return { status: "complete", entries: [] };
		}

		let hasGap = false;
		let expectedSeq = resumeCursor.sequence + 1;
		for (const e of matching) {
			if (e.eventSequence !== undefined) {
				if (e.eventSequence > expectedSeq) {
					hasGap = true;
					break;
				}
				expectedSeq = e.eventSequence + 1;
			}
		}

		const totalMatched = matching.length;
		const limited = matching.slice(0, safeLimit);

		if (hasGap) {
			return { status: "partial", entries: limited, reason: "event_sequence_gap" };
		}

		if (totalMatched > _limit) {
			return { status: "partial", entries: limited, reason: "more_entries_available" };
		}

		return { status: "complete", entries: limited };
	}

	getReplaySentFrames(
		resumeCursor: RemoteHostEventCursor,
		limit: number = 500,
	): { status: "complete" | "partial" | "unavailable"; frames: RemoteHostFrame[]; reason?: string } {
		const result = this.getReplayEntries(resumeCursor, limit, "sent");
		return {
			status: result.status,
			frames: result.entries.map((e) => e.frame),
			reason: result.reason,
		};
	}

	getUnacknowledgedSentEntries(): RemoteHostJournalEntry[] {
		return this.entries.filter(
			(e) =>
				e.type === "sent" &&
				e.frame.type !== "health" &&
				e.frame.type !== "handshake" &&
				e.frame.type !== "ack" &&
				!this.dedup.acknowledged.has(e.frameId),
		);
	}

	get lastReceivedEventSequence(): RemoteHostEventSequence {
		return this.dedup.lastReceivedEventSequence;
	}

	get lastSentEventSequence(): RemoteHostEventSequence {
		return this.dedup.lastSentEventSequence;
	}

	get dedupCount(): number {
		return this.dedup.received.size;
	}

	reset(): void {
		this.entries = [];
		this.nextSeq = 1;
		this.dedup.received.clear();
		this.dedup.acknowledged.clear();
		this.dedup.lastReceivedEventSequence = 0;
		this.dedup.lastSentEventSequence = 0;
	}
}

export interface RemoteHostJournalLike {
	readonly path: string;
	recordSent(frame: RemoteHostFrameEnvelope): RemoteHostJournalEntry;
	recordReceived(frame: RemoteHostFrameEnvelope): { entry: RemoteHostJournalEntry; isDuplicate: boolean };
	isDuplicate(frameId: RemoteHostFrameId): boolean;
	readEntries(fromSeq?: number, limit?: number): RemoteHostJournalEntry[];
	getReplayEntries(
		resumeCursor: RemoteHostEventCursor,
		limit?: number,
		direction?: JournalReplayDirection,
	): { status: "complete" | "partial" | "unavailable"; entries: RemoteHostJournalEntry[]; reason?: string };
	getReplaySentFrames(
		resumeCursor: RemoteHostEventCursor,
		limit?: number,
	): { status: "complete" | "partial" | "unavailable"; frames: RemoteHostFrame[]; reason?: string };
	readonly lastReceivedEventSequence: RemoteHostEventSequence;
	readonly lastSentEventSequence: RemoteHostEventSequence;
	readonly dedupCount: number;
	getUnacknowledgedSentEntries(): RemoteHostJournalEntry[];
}
