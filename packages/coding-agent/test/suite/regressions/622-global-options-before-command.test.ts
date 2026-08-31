import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	daemonCommands: [] as string[][],
}));

vi.mock("../../../src/cli/daemon-command.js", () => ({
	handleDaemonCommand: async (args: string[]) => {
		mocks.daemonCommands.push(args);
		return true;
	},
}));

import { handlePublicCommand } from "../../../src/cli/public-command.js";

describe("issue #622 global options before commands", () => {
	beforeEach(() => {
		mocks.daemonCommands.length = 0;
	});

	it.each([
		["stop", ["worker"], ["kill", "worker"]],
		["rename", ["worker", "reviewer"], ["rename", "worker", "reviewer"]],
	])(
		"routes %s with the documented socket option before or after the command",
		async (command, operands, internalArgs) => {
			const socketPath = "/tmp/custom-daemon.sock";

			await expect(
				handlePublicCommand(["--daemon-socket", socketPath, command, ...operands]),
			).resolves.toMatchObject({ handled: true });
			await expect(
				handlePublicCommand([command, ...operands, "--daemon-socket", socketPath]),
			).resolves.toMatchObject({ handled: true });
			await expect(handlePublicCommand([command, ...operands, "--socket", socketPath])).resolves.toMatchObject({
				handled: true,
			});

			expect(mocks.daemonCommands).toEqual([
				["daemon", ...internalArgs, "--daemon-socket", socketPath],
				["daemon", ...internalArgs, "--daemon-socket", socketPath],
				["daemon", ...internalArgs, "--socket", socketPath],
			]);
		},
	);
});
