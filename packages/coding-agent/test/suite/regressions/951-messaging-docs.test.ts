import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

const packageRoot = resolve(__dirname, "../../..");
const longRunningAgentsPath = resolve(packageRoot, "docs/long-running-agents.md");
const rpcDocsPath = resolve(packageRoot, "docs/rpc.md");
const rpcTypesPath = resolve(packageRoot, "src/modes/rpc/rpc-types.ts");
const agentMessageSkillPath = resolve(packageRoot, "skills/agent-message/src/agent_message/__init__.py");

function extractSection(markdown: string, heading: string): string {
	const start = markdown.indexOf(heading);
	if (start < 0) throw new Error(`Missing documentation heading: ${heading}`);
	const end = markdown.indexOf("\n## ", start + heading.length);
	return markdown.slice(start, end < 0 ? undefined : end);
}

function extractFirstCodeBlock(markdown: string, language: string): string {
	const fence = "```";
	const match = new RegExp(`${fence}${language}\\r?\\n([\\s\\S]*?)\\r?\\n${fence}`).exec(markdown);
	if (!match?.[1]) throw new Error(`Missing ${language} code block`);
	return match[1];
}

function extractJsonCommand(markdown: string, commandType: string): Record<string, unknown> {
	for (const match of markdown.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)) {
		try {
			const command = JSON.parse(match[1] ?? "") as unknown;
			if (typeof command === "object" && command !== null && "type" in command && command.type === commandType) {
				return command as Record<string, unknown>;
			}
		} catch {
			// Other documentation blocks use placeholders such as {...}.
		}
	}
	throw new Error(`Missing valid JSON example for ${commandType}`);
}

function extractRpcCommandMember(source: string, commandType: string): string {
	const discriminator = source.indexOf(`type: "${commandType}"`);
	if (discriminator < 0) throw new Error(`Missing RpcCommand member: ${commandType}`);
	const start = source.lastIndexOf("\n\t| {", discriminator);
	const end = source.indexOf("\n\t|", discriminator);
	if (start < 0 || end < 0) throw new Error(`Could not isolate RpcCommand member: ${commandType}`);
	return source.slice(start + "\n\t| ".length, end).trim();
}

function contractFieldNames(member: string): string[] {
	return [...member.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)(?:\?)?:/gm)]
		.map((match) => match[1]!)
		.filter((name) => name !== "id" && name !== "type");
}

function documentedTableFieldNames(markdown: string, commandType: string): string[] {
	const row = markdown.split(/\r?\n/).find((line) => line.startsWith(`| \`${commandType}\` |`));
	if (!row) throw new Error(`Missing RPC command table row: ${commandType}`);
	const fieldCell =
		row
			.split("|")[2]
			?.trim()
			.replace(/\s*\([^)]*\)\s*$/, "") ?? "";
	return [...fieldCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

function resolvePython(): string {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		process.platform === "win32" ? "python" : "python3",
		"python",
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of new Set(candidates)) {
		const probe = spawnSync(candidate, ["-c", "import sys; print(sys.version_info[:2])"], { encoding: "utf8" });
		if (probe.status === 0) return candidate;
	}
	throw new Error("No Python interpreter is available for the documented agent_message example");
}

describe("issue #951 messaging documentation contracts", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await createHarness();
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("executes the documented agent_message.send example against the real Python skill", () => {
		const markdown = readFileSync(longRunningAgentsPath, "utf8");
		const snippet = extractFirstCodeBlock(extractSection(markdown, "## Agent-to-Agent Communication"), "python");
		const indentedSnippet = snippet
			.split(/\r?\n/)
			.map((line) => `    ${line}`)
			.join("\n");
		const runner = `
import asyncio
import importlib.util
import json
import sys
import types

calls = []

async def host_request(name, payload=None):
    calls.append([name, payload])
    if name == "agent_message.list_agents":
        return {"agents": []}
    return {
        "id": "agentmsg_docs",
        "deliveryStatus": "delivered",
        "message": payload["message"],
        "target": {"activeSessionId": "reviewer-active", "sessionId": "reviewer-session"},
    }

rlm = types.ModuleType("rlm")
rlm.host_request = host_request
display_module = types.ModuleType("IPython.display")
display_module.display = lambda *args, **kwargs: None
ipython_module = types.ModuleType("IPython")
ipython_module.display = display_module
sys.modules["rlm"] = rlm
sys.modules["IPython"] = ipython_module
sys.modules["IPython.display"] = display_module

spec = importlib.util.spec_from_file_location("agent_message", ${JSON.stringify(agentMessageSkillPath)})
agent_message = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent_message)

async def main():
${indentedSnippet}

asyncio.run(main())
print("CALLS=" + json.dumps(calls))
`;
		const result = spawnSync(resolvePython(), ["-c", runner], { encoding: "utf8" });

		expect(result.status, result.stderr).toBe(0);
		const callsLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("CALLS="));
		expect(callsLine).toBeDefined();
		const calls = JSON.parse(callsLine!.slice("CALLS=".length)) as Array<[string, Record<string, unknown> | null]>;
		expect(calls).toContainEqual([
			"agent_message.send",
			{
				message: "Recheck the endpoint after the latest edit",
				receiver_role: "sibling",
				receiver_name: "api-reviewer",
			},
		]);
	});

	it("type-checks the documented RPC send_message JSON against RpcCommand", () => {
		const markdown = readFileSync(rpcDocsPath, "utf8");
		const source = readFileSync(rpcTypesPath, "utf8");
		const documentedCommand = extractJsonCommand(markdown, "send_message");
		const contract = extractRpcCommandMember(source, "send_message");
		const typeCheckPath = resolve(harness.tempDir, "rpc-send-message-docs.ts");
		writeFileSync(
			typeCheckPath,
			`type SendMessageCommand = ${contract};\nconst command = ${JSON.stringify(documentedCommand)} satisfies SendMessageCommand;\nvoid command;\n`,
		);
		const typeCheckConfigPath = resolve(harness.tempDir, "rpc-send-message-docs.tsconfig.json");
		writeFileSync(
			typeCheckConfigPath,
			JSON.stringify({
				compilerOptions: {
					lib: ["ES2022"],
					noEmit: true,
					strict: true,
					target: "ES2022",
					types: [],
				},
				files: [typeCheckPath],
			}),
		);
		const tsgoLauncherPath = resolve(packageRoot, "../../node_modules/@typescript/native-preview/bin/tsgo.js");
		const typeCheck = spawnSync(
			process.execPath,
			[tsgoLauncherPath, "-p", typeCheckConfigPath, "--pretty", "false"],
			{
				cwd: packageRoot,
				encoding: "utf8",
			},
		);

		expect(typeCheck.status, `${typeCheck.stdout}\n${typeCheck.stderr}`).toBe(0);
		expect(documentedTableFieldNames(markdown, "send_message")).toEqual(contractFieldNames(contract));
	});

	it("keeps heartbeat delivery modes documented on their separate contract", () => {
		const longRunningMarkdown = readFileSync(longRunningAgentsPath, "utf8");
		const rpcMarkdown = readFileSync(rpcDocsPath, "utf8");
		const source = readFileSync(rpcTypesPath, "utf8");
		const heartbeatContract = extractRpcCommandMember(source, "set_heartbeat");

		expect(longRunningMarkdown).toContain('delivery_mode="follow_up"');
		expect(documentedTableFieldNames(rpcMarkdown, "set_heartbeat")).toEqual(contractFieldNames(heartbeatContract));
		expect(rpcMarkdown).toContain("optional `deliveryMode` (`steer`, `follow_up`)");
	});
});
