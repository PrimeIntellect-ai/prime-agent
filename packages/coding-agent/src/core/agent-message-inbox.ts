/**
 * Digest inbox for agent messages (swarm communication PR C).
 *
 * When a session runs with the digest lane enabled, inbound agent messages from
 * non-parent senders are stored here instead of prompting immediately. One
 * coalesced notice per batch wakes the recipient; the recipient pulls messages
 * with rlm.inbox.list()/read(). Payloads persist as generic session entries
 * (never replayed into model context) so unread messages survive restarts.
 */

import type { AgentSessionMessage } from "./agent-messages.js";

export const AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE = "agent_message_inbox";
export const AGENT_MESSAGE_INBOX_READ_ENTRY_CUSTOM_TYPE = "agent_message_inbox_read";
/** Custom type of the one-per-batch digest notice prompt. */
export const AGENT_MESSAGE_DIGEST_NOTICE_CUSTOM_TYPE = "agent_message_digest_notice";

const PREVIEW_MAX_CHARS = 120;

export interface AgentMessageInboxEntryData {
	messageId: string;
	content: string;
	from: { activeSessionId: string; sessionName?: string };
	fromRelationship: string;
	target: { activeSessionId: string; sessionId: string; sessionName?: string };
	receivedAt: string;
	/** "agent_message" for delivered reports; "watch" for watch events on the digest lane. */
	kind: "agent_message" | "watch";
	/** Present for watch entries: which watch produced the event. */
	watch?: "agent" | "job";
}

export interface AgentMessageInboxEntryView {
	/** Durable inbox entry id; pass to rlm.inbox.read() to read single entries. */
	id: string;
	messageId: string;
	from: AgentMessageInboxEntryData["from"];
	fromRelationship: string;
	receivedAt: string;
	read: boolean;
	preview: string;
	content: string;
	kind: "agent_message" | "watch";
	watch?: "agent" | "job";
}

/** Narrow store port so the inbox is testable without a full session. */
export interface AgentMessageInboxStore {
	getEntries(): { type: string; customType?: string; data?: unknown; id: string }[];
	appendCustomEntryWithRollback(customType: string, data?: unknown): string;
}

interface InboxRecord {
	id: string;
	data: AgentMessageInboxEntryData;
	read: boolean;
}

function asEntryData(value: unknown): AgentMessageInboxEntryData | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Partial<AgentMessageInboxEntryData>;
	if (
		typeof candidate.messageId !== "string" ||
		typeof candidate.content !== "string" ||
		typeof candidate.receivedAt !== "string" ||
		typeof candidate.fromRelationship !== "string"
	) {
		return undefined;
	}
	return candidate as AgentMessageInboxEntryData;
}

export class AgentMessageInbox {
	private readonly store: AgentMessageInboxStore;
	private loaded = false;
	private records: InboxRecord[] = [];

	constructor(store: AgentMessageInboxStore) {
		this.store = store;
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		const readMessageIds = new Set<string>();
		const pendingReads: { id: string; data: AgentMessageInboxEntryData }[] = [];
		for (const entry of this.store.getEntries()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === AGENT_MESSAGE_INBOX_READ_ENTRY_CUSTOM_TYPE) {
				const marker = entry.data as { messageId?: unknown } | undefined;
				if (typeof marker?.messageId === "string") readMessageIds.add(marker.messageId);
			} else if (entry.customType === AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE) {
				const data = asEntryData(entry.data);
				if (data) pendingReads.push({ id: entry.id, data });
			}
		}
		this.records = pendingReads.map((entry) => ({
			id: entry.id,
			data: entry.data,
			read: readMessageIds.has(entry.data.messageId),
		}));
		this.loaded = true;
	}

	/** Store one agent message durably; returns the durable entry id. */
	append(message: AgentSessionMessage): string {
		this.ensureLoaded();
		const data: AgentMessageInboxEntryData = {
			messageId: message.details.id,
			content: message.details.message,
			from: {
				activeSessionId: message.details.from?.activeSessionId ?? "unknown",
				...(message.details.from?.sessionName ? { sessionName: message.details.from.sessionName } : {}),
			},
			fromRelationship: message.details.fromRelationship ?? "sibling",
			target: {
				activeSessionId: message.details.target?.activeSessionId ?? "unknown",
				sessionId: message.details.target?.sessionId ?? "unknown",
				...(message.details.target?.sessionName ? { sessionName: message.details.target.sessionName } : {}),
			},
			receivedAt: new Date().toISOString(),
			kind: "agent_message",
		};
		const id = this.store.appendCustomEntryWithRollback(AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE, data);
		this.records.push({ id, data, read: false });
		return id;
	}

	/** Store one watch event (agent or job) on the digest lane; returns the entry id. */
	appendWatch(watch: "agent" | "job", content: string): string {
		this.ensureLoaded();
		const data: AgentMessageInboxEntryData = {
			messageId: `watch-${watch}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			content,
			from: { activeSessionId: "watch" },
			fromRelationship: "watch",
			target: { activeSessionId: "watch", sessionId: "watch" },
			receivedAt: new Date().toISOString(),
			kind: "watch",
			watch,
		};
		const id = this.store.appendCustomEntryWithRollback(AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE, data);
		this.records.push({ id, data, read: false });
		return id;
	}

	unreadCount(): number {
		this.ensureLoaded();
		return this.records.filter((record) => !record.read).length;
	}

	totalCount(): number {
		this.ensureLoaded();
		return this.records.length;
	}

	/** Inbox listing for rlm.inbox.list(): ids, senders, read state, previews. */
	list(): AgentMessageInboxEntryView[] {
		this.ensureLoaded();
		return this.records.map((record) => this.view(record));
	}

	/**
	 * Mark entries read (durable marker) and return their full contents.
	 * Without ids, reads every unread entry. Unknown ids are ignored.
	 */
	read(ids?: string[]): { entries: AgentMessageInboxEntryView[]; unread: number } {
		this.ensureLoaded();
		const wanted = ids === undefined ? null : new Set(ids);
		const entries: AgentMessageInboxEntryView[] = [];
		for (const record of this.records) {
			const matches = wanted ? wanted.has(record.id) : !record.read;
			if (!matches) continue;
			if (!record.read) {
				this.store.appendCustomEntryWithRollback(AGENT_MESSAGE_INBOX_READ_ENTRY_CUSTOM_TYPE, {
					messageId: record.data.messageId,
				});
				record.read = true;
			}
			entries.push(this.view(record));
		}
		return { entries, unread: this.unreadCount() };
	}

	private view(record: InboxRecord): AgentMessageInboxEntryView {
		return {
			id: record.id,
			messageId: record.data.messageId,
			from: record.data.from,
			fromRelationship: record.data.fromRelationship,
			receivedAt: record.data.receivedAt,
			read: record.read,
			preview:
				record.data.content.length > PREVIEW_MAX_CHARS
					? `${record.data.content.slice(0, PREVIEW_MAX_CHARS)}...`
					: record.data.content,
			content: record.data.content,
			kind: record.data.kind ?? "agent_message",
			...(record.data.watch ? { watch: record.data.watch } : {}),
		};
	}
}

/** Notice prompt delivered once per batch of digest-lane items. */
export function createAgentMessageDigestNoticeContent(unreadCount: number, senders: string[]): string {
	const senderList = senders.slice(0, 5).join(", ");
	return [
		`You have ${unreadCount} unread inbox item${unreadCount === 1 ? "" : "s"}${
			senderList ? ` (from: ${senderList}${senders.length > 5 ? ", ..." : ""})` : ""
		}.`,
		"List them with `await rlm.inbox.list()` or read all of them with `await rlm.inbox.read()`.",
	].join("\n");
}
