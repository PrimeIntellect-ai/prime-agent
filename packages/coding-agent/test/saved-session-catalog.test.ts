import { describe, expect, it } from "vitest";
import type { DaemonClient, DaemonClientRequestOptions } from "../src/modes/daemon/daemon-client.js";
import type { DaemonCommand, DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import {
	deleteDaemonSavedSession,
	listDaemonSavedSessions,
	renameDaemonSavedSession,
} from "../src/modes/daemon/saved-session-catalog.js";

class FakeDaemonClient {
	readonly commands: DaemonCommand[] = [];

	async request(
		command: DaemonCommand,
		_timeoutMs = 30000,
		options: DaemonClientRequestOptions = {},
	): Promise<DaemonResponse> {
		this.commands.push(command);
		if (command.type === "list_saved_sessions") {
			options.onProgress?.({
				type: "session_list_progress",
				command: "list_saved_sessions",
				loaded: 1,
				total: 1,
			});
			options.onProgress?.({
				type: "session_list_item",
				command: "list_saved_sessions",
				session: {
					path: "/tmp/sessions/one.jsonl",
					id: "one",
					cwd: "/tmp/project",
					parentSessionPath: "/tmp/sessions/parent.jsonl",
					rlmDepth: 1,
					created: "2026-01-01T00:00:00.000Z",
					modified: "2026-01-02T00:00:00.000Z",
					messageCount: 1,
					firstMessage: "hello",
					allMessagesText: "hello",
					agentStatus: {
						summary: "Finished the task",
						taskState: "completed",
						basedOnMessageCount: 1,
					},
				},
			});
			return {
				type: "response",
				command: "list_saved_sessions",
				success: true,
				data: {
					sessions: [
						{
							path: "/tmp/sessions/one.jsonl",
							id: "one",
							cwd: "/tmp/project",
							parentSessionPath: "/tmp/sessions/parent.jsonl",
							rlmDepth: 1,
							created: "2026-01-01T00:00:00.000Z",
							modified: "2026-01-02T00:00:00.000Z",
							messageCount: 1,
							firstMessage: "hello",
							allMessagesText: "hello",
							agentStatus: {
								summary: "Finished the task",
								taskState: "completed",
								basedOnMessageCount: 1,
							},
						},
					],
				},
			};
		}
		if (command.type === "delete_saved_session") {
			return {
				type: "response",
				command: "delete_saved_session",
				success: true,
				data: { ok: true, method: "trash" },
			};
		}
		return { type: "response", command: command.type, success: true };
	}
}

function asDaemonClient(client: FakeDaemonClient): DaemonClient {
	return client as unknown as DaemonClient;
}

describe("saved session catalog", () => {
	it("streams detached saved sessions through the daemon catalog", async () => {
		const fakeClient = new FakeDaemonClient();
		const progress: Array<[number, number]> = [];
		const discovered: string[] = [];

		const sessions = await listDaemonSavedSessions(
			asDaemonClient(fakeClient),
			{ cwd: "/tmp/project", sessionDir: "/tmp/sessions" },
			"current",
			{
				onProgress: (loaded, total) => progress.push([loaded, total]),
				onSession: (session) => discovered.push(session.id),
			},
		);

		expect(fakeClient.commands[0]).toEqual({
			type: "list_saved_sessions",
			cwd: "/tmp/project",
			sessionDir: "/tmp/sessions",
			scope: "current",
		});
		expect(progress).toEqual([[1, 1]]);
		expect(discovered).toEqual(["one"]);
		expect(sessions).toEqual([
			{
				path: "/tmp/sessions/one.jsonl",
				id: "one",
				cwd: "/tmp/project",
				parentSessionPath: "/tmp/sessions/parent.jsonl",
				rlmDepth: 1,
				created: new Date("2026-01-01T00:00:00.000Z"),
				modified: new Date("2026-01-02T00:00:00.000Z"),
				messageCount: 1,
				firstMessage: "hello",
				allMessagesText: "hello",
				agentStatus: {
					summary: "Finished the task",
					taskState: "completed",
					basedOnMessageCount: 1,
				},
			},
		]);
	});

	it("mutates detached saved sessions without an active session id", async () => {
		const fakeClient = new FakeDaemonClient();
		const context = { cwd: "/tmp/project", sessionDir: "/tmp/sessions" };

		await renameDaemonSavedSession(asDaemonClient(fakeClient), context, "/tmp/sessions/one.jsonl", "One");
		await expect(
			deleteDaemonSavedSession(asDaemonClient(fakeClient), context, "/tmp/sessions/one.jsonl"),
		).resolves.toEqual({
			ok: true,
			method: "trash",
		});

		expect(fakeClient.commands).toEqual([
			{ type: "rename_saved_session", sessionPath: "/tmp/sessions/one.jsonl", name: "One" },
			{ type: "delete_saved_session", sessionPath: "/tmp/sessions/one.jsonl" },
		]);
	});
});
