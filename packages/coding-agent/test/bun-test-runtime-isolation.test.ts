import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const launcher = resolve(repoRoot, "scripts/run-with-clean-env.ts");

describe("Bun test runtime isolation", () => {
	it("removes live Prime Agent orchestration state before Bun and its descendants start", () => {
		const probe = `console.log(JSON.stringify({
			internal: process.env.PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL,
			rlm: process.env.RLM_SESSION_DIR,
			agentDir: process.env.PRIME_AGENT_CODING_AGENT_DIR,
			owner: process.env.PRIME_AGENT_KERNEL_OWNER_PID,
			tags: process.env.PRIME_AGENT_TEST_TAGS,
		}))`;
		const result = spawnSync(process.execPath, [launcher, "bun", "-e", probe], {
			cwd: repoRoot,
			encoding: "utf8",
			env: {
				...process.env,
				PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL: "/live/orphans.jsonl",
				RLM_SESSION_DIR: "/live/session",
				PRIME_AGENT_CODING_AGENT_DIR: "/live/agent",
				PRIME_AGENT_KERNEL_OWNER_PID: "1234",
				PRIME_AGENT_TEST_TAGS: "kernel-heavy",
			},
		});

		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ tags: "kernel-heavy" });
	});
});
