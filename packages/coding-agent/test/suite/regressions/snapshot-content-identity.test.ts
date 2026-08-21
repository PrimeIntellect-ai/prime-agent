import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	createSnapshotTranscriptChunks,
	snapshotTranscriptId,
} from "../../../src/modes/daemon/snapshot-transcript-cache.js";

const activeSessionId = "active-content-identity";
const eventGeneration = "generation-1";
const lastEventSequence = 42;

function messages(content: string): AgentMessage[] {
	const user: AgentMessage = { role: "user", content: [{ type: "text", text: content }], timestamp: 1 };
	const assistant: AgentMessage = {
		role: "assistant",
		content: [{ type: "text", text: `${content}-reply` }],
		timestamp: 2,
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
	return [user, assistant];
}

function publishedSnapshotId(snapshotMessages: AgentMessage[]): string {
	return snapshotTranscriptId(`${activeSessionId}-${eventGeneration}-${lastEventSequence}`, snapshotMessages);
}

function chunkBytes(snapshotMessages: AgentMessage[]): Buffer {
	return Buffer.concat([
		...createSnapshotTranscriptChunks({ activeSessionId, snapshotId: "id", messages: snapshotMessages }),
	]);
}

describe("snapshot content identity", () => {
	it("yields identical ids for exact retransmission", () => {
		const first = messages("hello");
		const retransmission = messages("hello");
		expect(publishedSnapshotId(retransmission)).toBe(publishedSnapshotId(first));
		expect(chunkBytes(retransmission).equals(chunkBytes(first))).toBe(true);
	});

	it("yields distinct ids when message bytes change at equal generation, sequence, and count", () => {
		const first = messages("hello");
		const changed = messages("goodbye");
		expect(changed.length).toBe(first.length);
		const firstId = publishedSnapshotId(first);
		const changedId = publishedSnapshotId(changed);
		expect(changedId).not.toBe(firstId);
		expect(changedId.startsWith(firstId)).toBe(false);
	});

	it("keeps the generation and sequence prefix in the derived id", () => {
		const id = publishedSnapshotId(messages("hello"));
		expect(id.startsWith(`${activeSessionId}-${eventGeneration}-${lastEventSequence}-`)).toBe(true);
	});
});
