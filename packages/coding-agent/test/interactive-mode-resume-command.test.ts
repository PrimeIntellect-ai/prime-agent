import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type InteractiveModePrototype = {
	handleResumeCommand(this: ResumeCommandContext, args: string): Promise<void>;
};

type ResumeCommandContext = {
	requestAgentsView: () => Promise<void>;
	handleResumeSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	showError: (message: string) => void;
	getCurrentCwd: () => string;
	connectionState: { sessionDir?: string } | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

const emptySessionDir = mkdtempSync(join(tmpdir(), "resume-command-test-"));

afterAll(() => {
	rmSync(emptySessionDir, { recursive: true, force: true });
});

function makeContext() {
	return {
		requestAgentsView: vi.fn<() => Promise<void>>(async () => undefined),
		handleResumeSession: vi.fn<(sessionPath: string) => Promise<{ cancelled: boolean }>>(async () => ({
			cancelled: false,
		})),
		showError: vi.fn<(message: string) => void>(),
		getCurrentCwd: () => emptySessionDir,
		connectionState: { sessionDir: emptySessionDir },
	} satisfies ResumeCommandContext;
}

describe("InteractiveMode /resume command", () => {
	it("opens the agents view for bare /resume", async () => {
		const context = makeContext();

		await interactiveModePrototype.handleResumeCommand.call(context, "  ");

		expect(context.requestAgentsView).toHaveBeenCalledTimes(1);
		expect(context.handleResumeSession).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("resumes a session path argument in place", async () => {
		const context = makeContext();

		await interactiveModePrototype.handleResumeCommand.call(context, "/tmp/session.jsonl");

		expect(context.handleResumeSession).toHaveBeenCalledWith("/tmp/session.jsonl");
		expect(context.requestAgentsView).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("shows a non-fatal error for an unknown session selector", async () => {
		const context = makeContext();

		await interactiveModePrototype.handleResumeCommand.call(context, "no-such-session");

		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("No session found matching"));
		expect(context.handleResumeSession).not.toHaveBeenCalled();
		expect(context.requestAgentsView).not.toHaveBeenCalled();
	});
});
