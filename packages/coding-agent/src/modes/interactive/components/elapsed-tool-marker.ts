import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Minimum seconds between two elapsed labels displayed in one conversation. */
const ELAPSED_TOOL_LABEL_INTERVAL_SECONDS = 30;

const ELAPSED_TOOL_MARKER_PATTERN = /^\[T\+(\d+)s\]$/;

export interface ElapsedToolMarker {
	seconds: number;
	label: string;
	toolCallId: string;
}

/**
 * parseElapsedToolMarker matches text that is exactly `[T+<seconds>s]`, the
 * marker the agent emits to timestamp the session. Anything else — including
 * prose that merely contains a marker — returns undefined.
 */
export function parseElapsedToolMarker(text: string): { seconds: number; label: string } | undefined {
	const match = ELAPSED_TOOL_MARKER_PATTERN.exec(text.trim());
	if (!match) {
		return undefined;
	}
	const seconds = Number(match[1]);
	return { seconds, label: `T+${seconds}s` };
}

/**
 * isElapsedToolMarkerBlock reports whether the text block at `index` is an
 * exact elapsed marker whose timestamp a later tool call in the same message
 * will carry, so the prose renderer must drop it.
 */
export function isElapsedToolMarkerBlock(content: AssistantMessage["content"], index: number): boolean {
	const block = content[index];
	if (block?.type !== "text") {
		return false;
	}
	if (parseElapsedToolMarker(block.text) === undefined) {
		return false;
	}
	return content.slice(index + 1).some((later) => later?.type === "toolCall");
}

/**
 * collectElapsedToolMarkers associates each exact elapsed marker with the next
 * tool call in the same assistant message, keyed by that tool call's id.
 */
export function collectElapsedToolMarkers(content: AssistantMessage["content"]): Map<string, ElapsedToolMarker> {
	const markers = new Map<string, ElapsedToolMarker>();
	let pending: { seconds: number; label: string } | undefined;
	for (const block of content) {
		if (block?.type === "text") {
			const marker = parseElapsedToolMarker(block.text);
			if (marker) {
				pending = marker;
			}
		} else if (block?.type === "toolCall") {
			if (pending) {
				markers.set(block.id, { ...pending, toolCallId: block.id });
			}
			pending = undefined;
		}
	}
	return markers;
}

/**
 * ElapsedToolLabelGate keeps consecutive elapsed labels in one conversation at
 * least ELAPSED_TOOL_LABEL_INTERVAL_SECONDS apart, so long tool-heavy turns do
 * not repeat the suffix on every status line.
 */
export class ElapsedToolLabelGate {
	private lastShownSeconds: number | undefined;

	/**
	 * admit records a label as displayed and returns it, or returns undefined
	 * when fewer than the interval have passed since the last displayed label.
	 */
	admit(seconds: number, label: string): string | undefined {
		if (
			this.lastShownSeconds !== undefined &&
			seconds - this.lastShownSeconds < ELAPSED_TOOL_LABEL_INTERVAL_SECONDS
		) {
			return undefined;
		}
		this.lastShownSeconds = seconds;
		return label;
	}

	/** reset forgets the last displayed label for a full conversation rebuild. */
	reset(): void {
		this.lastShownSeconds = undefined;
	}
}
