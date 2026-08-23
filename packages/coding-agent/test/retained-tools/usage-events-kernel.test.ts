import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.js";
import { loadToolIndex } from "../../src/core/retained-tools/index.js";
import { refreshToolIndexes } from "../../src/core/retained-tools/rebuild.js";
import { recordToolUsageEvent, type ToolUsageEvent } from "../../src/core/retained-tools/usage.js";
import { IpythonKernelProvisioner } from "../../src/core/tools/ipython.js";

/**
 * SARK T03 kernel-level synthetic session: a real IPython kernel wired with
 * the retained-tool usage options, exercising the two kernel count sources —
 * (b) file read of a known SKILL.md and (c) Python skill function call via
 * the host-request path. Each counter must increment exactly once per event,
 * and a "successful" session with no explicit signal must produce zero
 * explicit_ok.
 */
describe("retained tool usage events from the kernel", { tags: ["kernel-heavy"] }, () => {
	let cwd: string;
	let agentDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;
	const events: ToolUsageEvent[] = [];

	function writeSkill(name: string): void {
		const dir = join(cwd, ".prime", "agent", "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: A test skill.\n---\n\n# ${name}\n`);
	}

	beforeEach(() => {
		events.length = 0;
		const base = mkdtempSync(join(tmpdir(), "pi-usage-kernel-"));
		cwd = join(base, "cwd");
		agentDir = join(base, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeSkill("demo-tool");
		writeSkill("py-tool");
		// Create both index entries so recording has something to update.
		refreshToolIndexes({ cwd, agentDir });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(join(cwd, ".."), { recursive: true, force: true });
	});

	it("counts file reads and completed/raised python skill calls exactly once per event", async () => {
		const skillPath = join(cwd, ".prime", "agent", "skills", "demo-tool", "SKILL.md");
		provisioner = new IpythonKernelProvisioner(cwd, {
			hostHandlers: {
				"py_tool.ping": async () => ({ pong: true }),
				"py_tool.fail": async () => {
					throw new Error("boom");
				},
			},
			skillFileReadSources: [{ name: "demo-tool", skillFilePath: skillPath, baseDir: dirname(skillPath) }],
			skillHostRequestTypes: { "py_tool.ping": "py-tool", "py_tool.fail": "py-tool" },
			onToolUsageEvent: (event) => {
				events.push(event);
				recordToolUsageEvent({
					skillName: event.skillName,
					event: event.event,
					scope: "project",
					cwd,
					agentDir,
					note: event.note,
				});
			},
		});
		const manager = await provisioner.ensure();

		// (b) kernel file read of a known SKILL.md — twice, via different APIs.
		const readOpen = await manager.execute(`
content = open(${JSON.stringify(skillPath)}).read()
print("read-open", len(content) > 0)
`);
		expect(readOpen.status).toBe("ok");

		const readPathlib = await manager.execute(`
from pathlib import Path
text = Path(${JSON.stringify(skillPath)}).read_text()
print("read-pathlib", "demo-tool" in text)
`);
		expect(readPathlib.status).toBe("ok");

		// (c) Python skill call via the host-request path — completed.
		const ping = await manager.execute(`
import rlm as _rlm
result = await _rlm.host_request("py_tool.ping", {})
print("ping", result["pong"])
`);
		expect(ping.status).toBe("ok");
		expect(ping.stdout.trim()).toBe("ping True");

		// (c) Python skill call via the host-request path — raised.
		const fail = await manager.execute(`
import rlm as _rlm
try:
    await _rlm.host_request("py_tool.fail", {})
except RuntimeError as error:
    print("fail", error)
`);
		expect(fail.status).toBe("ok");
		expect(fail.stdout).toContain("boom");

		// Event stream: one `used` per read, `used` + one explicit signal per call.
		expect(events.map((event) => `${event.event}:${event.skillName}`)).toEqual([
			"used:demo-tool",
			"used:demo-tool",
			"used:py-tool",
			"explicit_ok:py-tool",
			"used:py-tool",
			"explicit_fail:py-tool",
		]);

		const index = loadToolIndex(join(cwd, CONFIG_DIR_NAME, "tools"));
		expect(index.skills["demo-tool"].usage).toMatchObject({ used: 2, explicit_ok: 0, explicit_fail: 0 });
		expect(index.skills["py-tool"].usage).toMatchObject({ used: 2, explicit_ok: 1, explicit_fail: 1 });
		expect(index.skills["py-tool"].usage.recent_failures.length).toBe(1);
		expect(index.skills["py-tool"].usage.recent_failures[0].note).toContain("boom");

		// A successful session with no explicit signal: demo-tool (used twice,
		// never failed, never praised) has zero explicit outcomes.
		expect(index.skills["demo-tool"].usage.explicit_ok).toBe(0);
		expect(index.skills["demo-tool"].usage.last_status).toBe(null);
	});

	it("does not count unmapped host request types as skill usage", async () => {
		provisioner = new IpythonKernelProvisioner(cwd, {
			hostHandlers: {
				"custom.other": async () => ({ ok: true }),
			},
			skillFileReadSources: [],
			skillHostRequestTypes: { "py_tool.ping": "py-tool" },
			onToolUsageEvent: (event) => {
				events.push(event);
			},
		});
		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import rlm as _rlm
await _rlm.host_request("custom.other", {})
print("done")
`);
		expect(result.status).toBe("ok");
		expect(events).toEqual([]);
	});
});
