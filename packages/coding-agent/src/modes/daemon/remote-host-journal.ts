/**
 * Replay/deduplication journal for remote-agent-host protocol.
 *
 * Append-only JSONL journal that records every frame sent and received over
 * a remote-host link. Supports replay (reading back frames from a cursor
 * position) and deduplication (detecting and rejecting duplicate frame IDs).
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
	eventSequence?: RemoteHostEventSequence;
}

export interface RemoteHostDedupState {
	received: Set<RemoteHostFrameId>;
	lastReceivedEventSequence: RemoteHostEventSequence;
	lastSentEventSequence: RemoteHostEventSequence;
}

export function createRemoteHostDedupState(): RemoteHostDedupState {
	return {
		received: new Set(),
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
	private readonly dedup: RemoteHostDedupState;

	constructor(opts: { path: string; hostId: string; generation: string }) {
		this.journalPath = opts.path;
		this.hostId = opts.hostId;
		this.generation = opts.generation;
		this.nextSeq = 1;
		this.dedup = createRemoteHostDedupState();

		const dir = dirname(opts.path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		if (existsSync(opts.path)) {
			// Enforce 0600 on existing journal files.
			const mode = statSync(opts.path).mode & 0o777;
			if (mode !== 0o600) {
				chmodSync(opts.path, 0o600);
			}
			const content = readFileSync(opts.path, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			for (const line of lines) {
				try {
					const entry = JSON.parse(line) as RemoteHostJournalEntry;
					if (entry.journalSeq >= this.nextSeq) {
						this.nextSeq = entry.journalSeq + 1;
					}
					if (entry.type === "received") {
						this.dedup.received.add(entry.frameId);
						if (entry.eventSequence !== undefined && entry.eventSequence > this.dedup.lastReceivedEventSequence) {
							this.dedup.lastReceivedEventSequence = entry.eventSequence;
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

	/**
	 * Persist before returning: the entry is written and fsynced synchronously
	 * before the caller sends the frame. This ensures the journal is durable
	 * before the wire write, so replay can always recover the frame.
	 */
	recordSent(frame: RemoteHostFrameEnvelope): RemoteHostJournalEntry {
		const entry: RemoteHostJournalEntry = {
			journalSeq: this.nextSeq++,
			type: "sent",
			frameId: frame.frameId,
			recordedAt: new Date().toISOString(),
			frame: frame.frame,
			hostId: this.hostId,
			generation: this.generation,
			eventSequence: frame.frame.type === "event" ? frame.frame.sequence : undefined,
		};
		if (frame.frame.type === "event") {
			this.dedup.lastSentEventSequence = frame.frame.sequence;
		}
		this.persistEntry(entry);
		return entry;
	}

	/**
	 * Persist before returning. Duplicate frame IDs are detected but
	 * still persisted (the journal is an audit log). However, duplicates
	 * do NOT advance sequence/gap state or count toward dedup tracking.
	 */
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
			eventSequence: frame.frame.type === "event" ? frame.frame.sequence : undefined,
		};
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
				if (entry.journalSeq >= fromSeq) {
					entries.push(entry);
					if (entries.length >= limit) break;
				}
			} catch {
				// Skip corrupt lines.
			}
		}
		return entries;
	}

	/**
	 * Get replay entries matching a resume cursor and a direction filter.
	 * Sent replay returns only sent entries; received replay returns only
	 * received entries. Gap analysis is performed on the filtered set so
	 * outbound and inbound event sequences are never interleaved.
	 */
	getReplayEntries(
		resumeCursor: RemoteHostEventCursor,
		_limit: number = 500,
		direction: JournalReplayDirection = "sent",
	): { status: "complete" | "partial" | "unavailable"; entries: RemoteHostJournalEntry[]; reason?: string } {
		// Validate cursor identity: both hostId AND generation must match.
		if (resumeCursor.hostId !== this.hostId) {
			return { status: "unavailable", entries: [], reason: "host_identity_mismatch" };
		}
		if (resumeCursor.generation !== this.generation) {
			return { status: "unavailable", entries: [], reason: "generation_changed" };
		}

		const allEntries = this.readEntries(1, _limit);
		const matching = allEntries.filter(
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

		if (hasGap) {
			return { status: "partial", entries: matching, reason: "event_sequence_gap" };
		}

		return { status: "complete", entries: matching };
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
	private readonly dedup: RemoteHostDedupState;

	constructor(opts: { hostId: string; generation: string }) {
		this.hostId = opts.hostId;
		this.generation = opts.generation;
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
			eventSequence: frame.frame.type === "event" ? frame.frame.sequence : undefined,
		};
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

		if (hasGap) {
			return { status: "partial", entries: matching, reason: "event_sequence_gap" };
		}

		return { status: "complete", entries: matching };
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
}
