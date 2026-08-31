import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentCronJob, AgentHeartbeatManagementAction } from "../src/core/cron-jobs.js";
import { KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionHeartbeat } from "../src/modes/agent-connection/types.js";
import { HeartbeatManagerComponent } from "../src/modes/interactive/components/heartbeat-manager.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function heartbeat(
	id: string,
	options: Partial<AgentCronJob> & { source: "heartbeat" | "rlm_heartbeat" },
): AgentConnectionHeartbeat {
	const { source, ...overrides } = options;
	return {
		job: {
			id,
			status: "active",
			source,
			activeSessionId: `active-${id}`,
			sessionId: `session-${id}`,
			sessionFile: `/tmp/${id}.jsonl`,
			cwd: "/tmp",
			prompt: `${id} prompt`,
			schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
			createdAt: "2026-07-15T10:00:00.000Z",
			updatedAt: "2026-07-15T10:00:00.000Z",
			nextRunAt: "2026-07-15T10:05:00.000Z",
			runCount: 2,
			...overrides,
		},
		sessionName: id === "user" ? "Primary session" : "Background session",
	};
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("HeartbeatManagerComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("uses a terminal-stable default shortcut", () => {
		expect(KEYBINDINGS["app.heartbeats.open"].defaultKeys).toBe("ctrl+r");
		expect(KEYBINDINGS["app.heartbeats.openSelected"].defaultKeys).toBe("right");
	});

	it("groups user and agent heartbeats and stays within terminal width", () => {
		const component = new HeartbeatManagerComponent({
			getHeartbeats: () => [
				heartbeat("user", { source: "heartbeat" }),
				heartbeat("agent", {
					source: "rlm_heartbeat",
					status: "paused",
					nextRunAt: undefined,
					deliveryMode: "follow_up",
					lastError: "the previous delivery failed",
				}),
			],
			getRows: () => 20,
			onAction: async () => {},
			onClose: () => {},
			requestRender: () => {},
		});
		for (const width of [32, 48, 80]) {
			const lines = component.render(width);
			expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
		}
		const rendered = component.render(100).map(stripAnsi);
		const output = rendered.join("\n");
		expect(output).toContain("2 heartbeats · 1 paused");
		expect(output).toContain("Primary session");
		expect(output).toContain("Created by you");
		expect(output).toContain("Created by agent");
		expect(output).toContain("previous delivery failed");
		expect(output).toContain("Esc close");
		expect(output).not.toContain("← close");
		expect(output).not.toContain("›");
		expect(output).not.toContain("─");
		const titleColumn = rendered.find((line) => line.includes("Heartbeats"))?.indexOf("Heartbeats");
		expect(titleColumn).toBeGreaterThan(2);
		expect(rendered.find((line) => line.includes("Esc close"))?.indexOf("Esc close")).toBe(titleColumn);
	});

	it("reads the current heartbeat list when rendered", () => {
		let heartbeats = [heartbeat("user", { source: "heartbeat" })];
		const component = new HeartbeatManagerComponent({
			getHeartbeats: () => heartbeats,
			getRows: () => 20,
			onAction: async () => {},
			onClose: () => {},
			requestRender: () => {},
		});

		expect(stripAnsi(component.render(80).join("\n"))).toContain("1 heartbeat.");
		heartbeats = [heartbeat("user", { source: "heartbeat" }), heartbeat("agent", { source: "rlm_heartbeat" })];
		expect(stripAnsi(component.render(80).join("\n"))).toContain("2 heartbeats.");
	});

	it("uses arrows to open and go back, and closes with escape or the toggle shortcut", () => {
		let closeCount = 0;
		const component = new HeartbeatManagerComponent({
			getHeartbeats: () => [heartbeat("user", { source: "heartbeat" })],
			getRows: () => 20,
			onAction: async () => {},
			onClose: () => closeCount++,
			requestRender: () => {},
		});

		component.handleInput("\x1b[D");
		expect(closeCount).toBe(1);

		component.handleInput("\x1b[C");
		const detailLines = component.render(80).map(stripAnsi);
		const titleColumn = detailLines.find((line) => line.includes("Your heartbeat"))?.indexOf("Your heartbeat");
		expect(detailLines.join("\n")).not.toContain("Return to all heartbeats");
		expect(detailLines.find((line) => line.includes("Created by you"))?.indexOf("Created by you")).toBe(titleColumn);
		expect(detailLines.find((line) => line.includes("← back"))?.indexOf("← back")).toBe(titleColumn);

		component.handleInput("\x1b[D");
		expect(closeCount).toBe(1);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("Select a heartbeat to manage");

		component.handleInput("\r");
		component.handleInput("\x1b");
		expect(closeCount).toBe(2);

		component.handleInput("\x12");
		expect(closeCount).toBe(3);
	});

	it("pauses and stops individual heartbeats immediately", async () => {
		const actions: Array<{ id: string; action: AgentHeartbeatManagementAction }> = [];
		const component = new HeartbeatManagerComponent({
			getHeartbeats: () => [heartbeat("user", { source: "heartbeat" })],
			getRows: () => 20,
			onAction: async (entry, action) => {
				actions.push({ id: entry.job.id, action });
			},
			onClose: () => {},
			requestRender: () => {},
		});

		component.handleInput("\r");
		component.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(actions).toEqual([{ id: "user", action: "pause" }]);

		component.handleInput("\r");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(actions).toEqual([
			{ id: "user", action: "pause" },
			{ id: "user", action: "stop" },
		]);
	});
});
