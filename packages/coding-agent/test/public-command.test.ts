import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF_UPDATE_INTERACTIVE_CHILD_ENV } from "../src/config.js";

const mocks = vi.hoisted(() => ({
	daemonCommands: [] as string[][],
	packageCommands: [] as string[][],
	psCalls: [] as boolean[],
	reapCalls: [] as Array<[boolean, boolean]>,
	shutdownCalls: [] as Array<[boolean, boolean]>,
	mcpCommands: [] as string[][],
}));

vi.mock("../src/cli/daemon-command.js", () => ({
	handleDaemonCommand: async (args: string[]) => {
		mocks.daemonCommands.push(args);
		return true;
	},
}));

vi.mock("../src/package-manager-cli.js", () => ({
	handlePackageCommand: async (args: string[]) => {
		mocks.packageCommands.push(args);
		return true;
	},
	isSelfUpdateSource: (source: string) => source === "self" || source === "pi" || source === "prime-agent",
}));

vi.mock("../src/core/mcp/mcp-command.js", () => ({
	runMcpManagementCommand: async (args: string[]) => {
		mocks.mcpCommands.push(args);
		return { action: args[0], message: "managed", changed: false };
	},
}));

vi.mock("../src/core/settings-manager.js", () => ({
	SettingsManager: {
		create: () => ({ flush: async () => {}, drainErrors: () => [], getGlobalMcpServers: () => undefined }),
	},
}));

vi.mock("../src/cli/daemon-ps.js", () => ({
	runPs: async (json: boolean) => {
		mocks.psCalls.push(json);
	},
	runReap: async (json: boolean, force: boolean) => {
		mocks.reapCalls.push([json, force]);
	},
	runShutdownAll: async (json: boolean, force: boolean) => {
		mocks.shutdownCalls.push([json, force]);
	},
}));

import { INTERNAL_RUNTIME_COMMAND_MARKER } from "../src/cli/args.js";
import { formatTopLevelHelp } from "../src/cli/command-registry.js";
import { DAEMON_UPDATE_RESTART_COORDINATOR_FLAG } from "../src/cli/daemon-update-restart.js";
import { handlePublicCommand } from "../src/cli/public-command.js";

describe("public command routing", () => {
	beforeEach(() => {
		mocks.daemonCommands.length = 0;
		mocks.packageCommands.length = 0;
		mocks.psCalls.length = 0;
		mocks.reapCalls.length = 0;
		mocks.shutdownCalls.length = 0;
		mocks.mcpCommands.length = 0;
		process.exitCode = undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it("rewrites attach into the normal interactive resume path", async () => {
		await expect(handlePublicCommand(["attach", "worker"])).resolves.toEqual({
			handled: false,
			args: ["--resume", "worker"],
			explicitAgentsView: false,
			attachAgent: "worker",
		});
	});

	it("forwards global options when attaching", async () => {
		await expect(handlePublicCommand(["attach", "worker", "--verbose", "--provider", "anthropic"])).resolves.toEqual({
			handled: false,
			args: ["--resume", "worker", "--verbose", "--provider", "anthropic"],
			explicitAgentsView: false,
			attachAgent: "worker",
		});
	});

	it("rejects extra attach operands", async () => {
		await expect(handlePublicCommand(["attach", "worker", "extra"])).resolves.toMatchObject({ handled: true });
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("prime-agent attach <agent>"));
	});

	it("rejects conflicting session selectors when attaching", async () => {
		for (const selector of [["--resume", "other"], ["-r", "other"], ["--continue"], ["--fork", "session.jsonl"]]) {
			await expect(handlePublicCommand(["attach", "worker", ...selector])).resolves.toMatchObject({ handled: true });
		}
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("cannot be combined"));
	});

	it("forwards global options when opening the agents view", async () => {
		await expect(handlePublicCommand(["agents", "--verbose", "--provider", "anthropic"])).resolves.toEqual({
			handled: false,
			args: ["--verbose", "--provider", "anthropic"],
			explicitAgentsView: true,
		});
	});

	it("routes MCP management without entering agent startup", async () => {
		await expect(
			handlePublicCommand(["mcp", "add", "local", "--", "node", "server file.js", "--stdio"]),
		).resolves.toMatchObject({ handled: true });
		expect(mocks.mcpCommands).toEqual([["add", "local", "--", "node", "server file.js", "--stdio"]]);
	});

	it("routes agent operations through the internal protocol adapter", async () => {
		await expect(handlePublicCommand(["list", "--all", "--json"])).resolves.toMatchObject({ handled: true });
		expect(mocks.daemonCommands).toEqual([["daemon", "list", "--all", "--json"]]);
	});

	it("forwards a custom daemon socket when stopping an agent", async () => {
		await expect(
			handlePublicCommand(["stop", "worker", "--daemon-socket", "/tmp/custom-daemon.sock"]),
		).resolves.toMatchObject({ handled: true });
		expect(mocks.daemonCommands).toEqual([
			["daemon", "kill", "worker", "--daemon-socket", "/tmp/custom-daemon.sock"],
		]);
	});

	it("forwards a custom daemon socket when renaming an agent", async () => {
		await expect(
			handlePublicCommand(["rename", "worker", "reviewer", "--daemon-socket", "/tmp/custom-daemon.sock"]),
		).resolves.toMatchObject({ handled: true });
		expect(mocks.daemonCommands).toEqual([
			["daemon", "rename", "worker", "reviewer", "--daemon-socket", "/tmp/custom-daemon.sock"],
		]);
	});

	it("separates Prime Agent updates from package updates", async () => {
		await handlePublicCommand(["update", "--force"]);
		await handlePublicCommand(["package", "update"]);
		await handlePublicCommand(["package", "update", "npm:@example/tools"]);

		expect(mocks.packageCommands).toEqual([
			["update", "--self", "--force"],
			["update", "--extensions"],
			["update", "npm:@example/tools"],
		]);
	});

	it("forwards hidden update restart coordinator invocations", async () => {
		const args = ["update", DAEMON_UPDATE_RESTART_COORDINATOR_FLAG, "--daemon-socket", "custom-daemon.sock"];

		await handlePublicCommand(args);

		expect(mocks.packageCommands).toEqual([args]);
	});

	it("preserves the internal interactive self-update command", async () => {
		const previousValue = process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
		const args = ["update", "--self", "--force", "--daemon-socket", "custom-daemon.sock"];
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";

		try {
			await handlePublicCommand(args);
		} finally {
			if (previousValue === undefined) {
				delete process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
			} else {
				process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = previousValue;
			}
		}

		expect(mocks.packageCommands).toEqual([args]);
	});

	it("gives legacy update targets explicit migration guidance", async () => {
		for (const target of ["self", "--self", "prime-agent"]) {
			await handlePublicCommand(["update", target]);
		}

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Use "prime-agent update [--force]"'));
	});

	it("directs legacy package-update forms to the package command", async () => {
		await handlePublicCommand(["update", "npm:@example/tools"]);
		await handlePublicCommand(["update", "--extensions"]);
		await handlePublicCommand(["update", "--extension", "npm:@example/tools"]);

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Use "prime-agent package update [source]"'));
	});

	it("explains that combined legacy updates are now separate", async () => {
		await handlePublicCommand(["update", "--self", "--extensions"]);

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("separately"));
	});

	it("rejects self-update aliases on the package update path", async () => {
		for (const source of ["self", "pi", "prime-agent"]) {
			await handlePublicCommand(["package", "update", source]);
		}

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Use "prime-agent update"'));
	});

	it("directs package uninstall to package remove", async () => {
		await handlePublicCommand(["package", "uninstall", "npm:@example/tools"]);

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Use "prime-agent package remove"'));
		expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("package install"));
	});

	it("maps model listing and session export to the existing runtime flags", async () => {
		await expect(handlePublicCommand(["model", "list", "sonnet"])).resolves.toMatchObject({
			handled: false,
			args: [INTERNAL_RUNTIME_COMMAND_MARKER, "--list-models", "sonnet"],
		});
		await expect(handlePublicCommand(["session", "export", "session.jsonl", "session.html"])).resolves.toMatchObject({
			handled: false,
			args: [INTERNAL_RUNTIME_COMMAND_MARKER, "--export", "session.jsonl", "session.html"],
		});
	});

	it("preserves trailing global options for model listing and session export", async () => {
		await expect(handlePublicCommand(["model", "list", "sonnet", "--offline"])).resolves.toMatchObject({
			handled: false,
			args: [INTERNAL_RUNTIME_COMMAND_MARKER, "--list-models", "sonnet", "--offline"],
		});
		await expect(
			handlePublicCommand(["session", "export", "session.jsonl", "session.html", "--verbose"]),
		).resolves.toMatchObject({
			handled: false,
			args: [INTERNAL_RUNTIME_COMMAND_MARKER, "--export", "session.jsonl", "session.html", "--verbose"],
		});
	});

	it("rejects operands for package list", async () => {
		await handlePublicCommand(["package", "list", "ignored-source"]);

		expect(mocks.packageCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("prime-agent package list"));
	});

	it("uses force only when explicitly requested for full shutdown", async () => {
		await handlePublicCommand(["shutdown", "--json"]);
		await handlePublicCommand(["shutdown", "--force"]);
		expect(mocks.shutdownCalls).toEqual([
			[true, false],
			[false, true],
		]);
	});

	it("routes doctor fixes through the safe cleanup path", async () => {
		await handlePublicCommand(["doctor", "--fix", "--json"]);
		expect(mocks.reapCalls).toEqual([[true, false]]);
	});

	it("rejects the old daemon hierarchy with migration guidance", async () => {
		await expect(handlePublicCommand(["daemon", "list"])).resolves.toMatchObject({ handled: true });
		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Run "prime-agent help"'));
	});

	it("shows migration guidance when help targets removed commands", async () => {
		const cases: Array<[path: string[], hint: string]> = [
			[["daemon"], 'Run "prime-agent help"'],
			[["install"], 'Use "prime-agent package install"'],
			[["remove"], 'Use "prime-agent package remove"'],
			[["uninstall"], 'Use "prime-agent package remove"'],
			[["manage"], 'Use "prime-agent agents"'],
			[["app", "update"], 'Use "prime-agent update"'],
		];

		for (const [path, hint] of cases) {
			await expect(handlePublicCommand(["help", ...path])).resolves.toMatchObject({ handled: true });
			expect(console.error).toHaveBeenCalledWith(expect.stringContaining(hint));
		}
		expect(process.exitCode).toBe(1);
		expect(console.log).not.toHaveBeenCalled();
	});

	it("suggests close nested commands without executing them", async () => {
		await handlePublicCommand(["schedule", "cancell", "job-1"]);
		expect(mocks.daemonCommands).toEqual([]);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("schedule cancel"));
	});

	it("treats help-like message text after the separator literally", async () => {
		await handlePublicCommand(["send", "worker", "--", "--help"]);
		expect(mocks.daemonCommands).toEqual([["daemon", "send", "worker", "--", "--help"]]);
	});

	it("leaves natural-language prompts beginning with help on the prompt path", async () => {
		const args = ["help", "me", "fix", "this"];
		await expect(handlePublicCommand(args)).resolves.toEqual({
			handled: false,
			args,
			explicitAgentsView: false,
		});
	});

	it("rejects invalid paths below a known help command", async () => {
		await handlePublicCommand(["help", "schedule", "nonsense"]);

		expect(process.exitCode).toBe(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Unknown command: schedule nonsense"));
	});

	it("shows command help when options precede the help flag", async () => {
		await handlePublicCommand(["list", "--all", "--help"]);
		await handlePublicCommand(["doctor", "--fix", "--help"]);
		await handlePublicCommand(["package", "install", "--local", "--help"]);

		expect(console.log).toHaveBeenNthCalledWith(1, expect.stringContaining("prime-agent list [--all] [--json]"));
		expect(console.log).toHaveBeenNthCalledWith(2, expect.stringContaining("prime-agent doctor [--fix] [--json]"));
		expect(console.log).toHaveBeenNthCalledWith(3, expect.stringContaining("prime-agent package install <source>"));
		expect(console.error).not.toHaveBeenCalled();
	});

	it("leaves top-level help flags on the full CLI help path", async () => {
		await expect(handlePublicCommand(["--help"])).resolves.toEqual({
			handled: false,
			args: ["--help"],
			explicitAgentsView: false,
		});
		await expect(handlePublicCommand(["-h"])).resolves.toEqual({
			handled: false,
			args: ["-h"],
			explicitAgentsView: false,
		});
	});

	it("formats complete top-level help, including autonomous options", () => {
		const help = formatTopLevelHelp();
		expect(help).toContain("Options:");
		expect(help).toContain("Run options:");
		expect(help).toContain("--mode <text|json|rpc|acp|daemon>");
		expect(help).toContain("Autonomous options:");
		for (const option of [
			"--autonomous",
			"--autonomous-gate <command>",
			"--autonomous-gate-retries <n>",
			"--autonomous-gate-timeout-ms <n>",
			"--autonomous-max-continuations <n>",
			"--autonomous-max-turns <n>",
			"--autonomous-max-tokens <n>",
			"--autonomous-timeout-ms <n>",
		]) {
			expect(help).toContain(option);
		}
		expect(help).toContain("default: 300000");
		expect(help).toContain("default: 1800000");
		expect(help).toContain("Commands:");
		expect(help).toContain("shutdown");
		expect(help).not.toContain("Environment Variables:");
		expect(help).not.toContain("Examples:");
		expect(help).not.toContain("Built-in Tool Names:");
	});
});
