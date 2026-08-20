import { describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

type TestMessage = {
	header: { msg_type: string };
	parent_header: { msg_id: string };
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
};

type ShutdownInternals = {
	state: "running";
	connection: { key: string };
	control: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
	kernel: { kill: (signal?: NodeJS.Signals | number) => boolean };
	pendingControlReplies: Map<string, (message: TestMessage) => void>;
};

function shutdownReply(parentMessageId: string, msgType = "shutdown_reply"): TestMessage {
	return {
		header: { msg_type: msgType },
		parent_header: { msg_id: parentMessageId },
		metadata: {},
		content: { status: "ok", restart: false },
	};
}

function configuredManager(onSend: (internals: ShutdownInternals) => void | Promise<void>): {
	manager: KernelManager;
	internals: ShutdownInternals;
} {
	const manager = new KernelManager({ cwd: process.cwd() });
	const internals = manager as unknown as ShutdownInternals;
	Object.assign(internals, {
		state: "running",
		connection: { key: "test-key" },
		control: {
			send: vi.fn(async () => onSend(internals)),
			close: vi.fn(),
		},
		kernel: { kill: vi.fn(() => true) },
	});
	return { manager, internals };
}

describe("KernelManager graceful shutdown", () => {
	it("waits for the matching shutdown reply and removes its listener", async () => {
		const { manager, internals } = configuredManager(async (state) => {
			const [requestMessageId, dispatch] = [...state.pendingControlReplies.entries()][0] ?? [];
			expect(requestMessageId).toBeTypeOf("string");
			expect(dispatch).toBeTypeOf("function");
			if (!requestMessageId || !dispatch) throw new Error("missing shutdown reply listener");
			dispatch(shutdownReply("unrelated"));
			dispatch(shutdownReply(requestMessageId, "interrupt_reply"));
			expect(state.pendingControlReplies.size).toBe(1);
			dispatch(shutdownReply(requestMessageId));
		});

		await manager.shutdown();

		expect(internals.pendingControlReplies.size).toBe(0);
		expect(internals.kernel).toBeUndefined();
	});
});
