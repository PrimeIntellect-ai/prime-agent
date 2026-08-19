import type { ImageContent } from "@earendil-works/pi-ai";
import type { EditorPasteSnapshot } from "@earendil-works/pi-tui";

export interface PromptStash {
	text: string;
	expandedText?: string;
	pasteSnapshot?: EditorPasteSnapshot;
	images?: readonly (readonly [number, ImageContent])[];
	restoreOnOpen?: boolean;
}

export interface PromptStashState {
	stash?: PromptStash;
	queuedStashes?: PromptStash[];
}

export class ClientPromptStashStore {
	private readonly states = new Map<string, PromptStashState>();

	forSession(sessionId: string): PromptStashState {
		let state = this.states.get(sessionId);
		if (!state) {
			state = {};
			this.states.set(sessionId, state);
		}
		return state;
	}

	release(sessionId: string, state: PromptStashState): void {
		if (
			state.stash === undefined &&
			(state.queuedStashes?.length ?? 0) === 0 &&
			this.states.get(sessionId) === state
		) {
			this.states.delete(sessionId);
		}
	}
}
