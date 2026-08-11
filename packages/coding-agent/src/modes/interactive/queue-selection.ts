import type { AgentConnectionQueueState } from "../agent-connection/index.js";

export type QueueLane = "steering" | "followUp";

export interface QueueSelectionItem {
	lane: QueueLane;
	index: number;
	text: string;
}

/**
 * Tracks which queued message the user is browsing/editing with alt+up/alt+down.
 *
 * Items are addressed by (lane, index, text): the text is the authoritative
 * check when a mutation is applied, so no ids or revisions are needed. Browsing
 * order is newest-first: draft -> last followUp -> ... -> first steering.
 */
export class QueueSelection {
	private items: QueueSelectionItem[] = [];
	private cursor = -1; // -1 = draft
	private draft = "";
	private hasStashedDraft = false;

	get selected(): QueueSelectionItem | undefined {
		return this.cursor >= 0 ? this.items[this.cursor] : undefined;
	}

	get isBrowsing(): boolean {
		return this.cursor >= 0;
	}

	get hasDraft(): boolean {
		return this.hasStashedDraft;
	}

	replaceDraft(draft: string): void {
		this.draft = draft;
		this.hasStashedDraft = true;
	}

	/** Move the cursor. -1 browses older, +1 newer. Returns the text to show, or undefined for a boundary noop. */
	move(queue: AgentConnectionQueueState, draft: string, direction: -1 | 1): string | undefined {
		if (this.cursor < 0) {
			if (direction > 0) return undefined;
			this.items = flatten(queue);
			if (this.items.length === 0) return undefined;
			// A drop (sync) keeps the previous draft stashed; do not overwrite it
			// with the dropped item's text still sitting in the editor.
			if (!this.hasStashedDraft) {
				this.draft = draft;
				this.hasStashedDraft = true;
			}
			this.cursor = this.items.length - 1;
			return this.items[this.cursor]?.text;
		}
		const next = this.cursor + direction;
		if (next < 0 || next > this.items.length) return undefined;
		if (next === this.items.length) {
			return this.reset();
		}
		this.cursor = next;
		return this.items[next]?.text;
	}

	/**
	 * Track queue changes while browsing: keep the selection when its text is
	 * still present. Returns the dropped item's text when the selection could
	 * not be kept, so the caller can restore the stashed draft.
	 */
	sync(queue: AgentConnectionQueueState): string | undefined {
		const selected = this.selected;
		this.items = flatten(queue);
		if (!selected) return undefined;
		const exact = this.items[selected.lane === "steering" ? selected.index : queue.steering.length + selected.index];
		if (exact?.lane === selected.lane && exact.text === selected.text) {
			this.cursor = this.items.indexOf(exact);
			return undefined;
		}
		const retargeted = this.items.find((item) => item.lane === selected.lane && item.text === selected.text);
		this.cursor = retargeted ? this.items.indexOf(retargeted) : -1;
		return retargeted ? undefined : selected.text;
	}

	/** Called after a mutation or submit resolved the selection. Returns the stashed draft. */
	reset(): string {
		this.cursor = -1;
		const draft = this.draft;
		this.draft = "";
		this.hasStashedDraft = false;
		return draft;
	}
}

function flatten(queue: AgentConnectionQueueState): QueueSelectionItem[] {
	return [
		...queue.steering.map((text, index) => ({ lane: "steering" as const, index, text })),
		...queue.followUp.map((text, index) => ({ lane: "followUp" as const, index, text })),
	];
}
