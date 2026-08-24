import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { type HostRequestHandlers, installHostRequestCapabilityResolver } from "../src/core/kernel/index.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { loadSkillsFromDir } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

const WORKFLOW_SKILL_IMPORT_NAMES = ["autoresearch", "mempalace"] as const;
const EVIDENCE_REF = {
	artifact_id: "evidence-1",
	relative_path: "artifacts/evidence/evidence-1.json",
	digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	size_bytes: 128,
	source_event_sequence: 7,
};
const OUTPUT_DIGEST = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function bundledWorkflowSkill(importName: (typeof WORKFLOW_SKILL_IMPORT_NAMES)[number]): PythonSkillRuntimeInfo {
	const name = importName === "autoresearch" ? "workflow-autoresearch" : importName;
	const packagePath = join(getBundledSkillsDir(), name);
	return {
		name,
		importName,
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

function bundledWorkflowControlSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "workflow");
	return {
		name: "workflow",
		importName: "workflow",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

function authorizedWorkflowHostHandlers(handlers: HostRequestHandlers): HostRequestHandlers {
	const requiredCapabilities: Readonly<Record<string, string>> = {
		"workflow.v1.autoresearch.run": "autoresearch.run",
		"workflow.v1.mempalace.propose": "mempalace.propose",
		"workflow.v1.pipeline.record": "pipeline.record",
	};
	return installHostRequestCapabilityResolver(handlers, (requestType) => ({
		workflowId: "workflow-skill-test",
		decisionId: "decision-skill-test",
		decisionRevision: 1,
		capabilities: requiredCapabilities[requestType] === undefined ? [] : [requiredCapabilities[requestType]],
		expiresAt: Date.now() + 60_000,
		nonce: `nonce-${requestType}`,
	}));
}

function readWorkflowSkillFile(importName: (typeof WORKFLOW_SKILL_IMPORT_NAMES)[number], relativePath: string): string {
	const name = importName === "autoresearch" ? "workflow-autoresearch" : importName;
	return readFileSync(join(getBundledSkillsDir(), name, relativePath), "utf8");
}

describe("built-in workflow skill facades", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;
	let originalKernelVenv: string | undefined;
	let originalKernelPython: string | undefined;
	let originalPythonPath: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `workflow-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		originalKernelVenv = process.env.PRIME_AGENT_KERNEL_VENV;
		originalKernelPython = process.env.PRIME_AGENT_KERNEL_PYTHON;
		originalPythonPath = process.env.PYTHONPATH;
		process.env.PRIME_AGENT_KERNEL_VENV = join(tempDir, "kernel-venv");
		const existingKernelPython = join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python");
		if (existsSync(existingKernelPython)) {
			process.env.PRIME_AGENT_KERNEL_PYTHON = existingKernelPython;
			const skillSourcePaths = WORKFLOW_SKILL_IMPORT_NAMES.map((name) => bundledWorkflowSkill(name).packagePath).map(
				(packagePath) => join(packagePath, "src"),
			);
			process.env.PYTHONPATH = [...skillSourcePaths, ...(originalPythonPath ? [originalPythonPath] : [])].join(":");
		}
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		if (originalKernelVenv === undefined) {
			delete process.env.PRIME_AGENT_KERNEL_VENV;
		} else {
			process.env.PRIME_AGENT_KERNEL_VENV = originalKernelVenv;
		}
		if (originalKernelPython === undefined) {
			delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		} else {
			process.env.PRIME_AGENT_KERNEL_PYTHON = originalKernelPython;
		}
		if (originalPythonPath === undefined) {
			delete process.env.PYTHONPATH;
		} else {
			process.env.PYTHONPATH = originalPythonPath;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads native workflow skill manifests as Python skills", () => {
		const result = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "builtin" });

		expect(result.diagnostics).toEqual([]);
		for (const importName of WORKFLOW_SKILL_IMPORT_NAMES) {
			const name = importName === "autoresearch" ? "workflow-autoresearch" : importName;
			const skill = result.skills.find((candidate) => candidate.name === name);
			expect(skill).toMatchObject({ name, kind: "python" });
			expect(skill?.kind === "python" && skill.python.importName).toBe(importName);
		}
		const workflow = result.skills.find((candidate) => candidate.name === "workflow");
		expect(workflow).toMatchObject({ name: "workflow", kind: "python" });
		expect(workflow?.kind === "python" && workflow.python.importName).toBe("workflow");
	});

	it("forwards only evidence/proposal requests to future host-owned APIs", { tags: ["kernel-heavy"] }, async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: WORKFLOW_SKILL_IMPORT_NAMES.map(bundledWorkflowSkill),
			hostHandlers: authorizedWorkflowHostHandlers({
				"workflow.v1.autoresearch.run": async (payload) => {
					requests.push({ type: "workflow.v1.autoresearch.run", payload });
					return {
						skill_id: "autoresearch",
						output_kind: "evidence",
						evidence_refs: payload.evidence_refs,
						durable_knowledge_boundary_digest: null,
						transient_state_refs: [],
						can_authorize: false,
						output_digest: OUTPUT_DIGEST,
					};
				},
				"workflow.v1.mempalace.recall": async (payload) => {
					requests.push({ type: "workflow.v1.mempalace.recall", payload });
					return {
						skill_id: "mempalace",
						output_kind: "evidence",
						evidence_refs: [],
						durable_knowledge_boundary_digest: null,
						transient_state_refs: [],
						can_authorize: false,
						output_digest: OUTPUT_DIGEST,
					};
				},
				"workflow.v1.mempalace.propose": async (payload) => {
					requests.push({ type: "workflow.v1.mempalace.propose", payload });
					return {
						skill_id: "mempalace",
						output_kind: "knowledge_proposal",
						evidence_refs: payload.source_evidence_refs,
						durable_knowledge_boundary_digest: OUTPUT_DIGEST,
						transient_state_refs: [],
						can_authorize: false,
						output_digest: OUTPUT_DIGEST,
					};
				},
			}),
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
evidence_ref = {
    "artifact_id": "evidence-1",
    "relative_path": "artifacts/evidence/evidence-1.json",
    "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "size_bytes": 128,
    "source_event_sequence": 7,
}
experiment = await autoresearch.run("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", [evidence_ref])
recall = await mempalace.recall("deployment timeout", knowledge_kind="procedure", limit=2)
proposal = await mempalace.propose("how", [evidence_ref])
print(json.dumps({"experiment": experiment, "recall": recall, "proposal": proposal}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		expect(JSON.parse(result.stdout.trim())).toEqual({
			experiment: {
				skill_id: "autoresearch",
				output_kind: "evidence",
				evidence_refs: [EVIDENCE_REF],
				durable_knowledge_boundary_digest: null,
				transient_state_refs: [],
				can_authorize: false,
				output_digest: OUTPUT_DIGEST,
			},
			recall: {
				skill_id: "mempalace",
				output_kind: "evidence",
				evidence_refs: [],
				durable_knowledge_boundary_digest: null,
				transient_state_refs: [],
				can_authorize: false,
				output_digest: OUTPUT_DIGEST,
			},
			proposal: {
				skill_id: "mempalace",
				output_kind: "knowledge_proposal",
				evidence_refs: [EVIDENCE_REF],
				durable_knowledge_boundary_digest: OUTPUT_DIGEST,
				transient_state_refs: [],
				can_authorize: false,
				output_digest: OUTPUT_DIGEST,
			},
		});
		expect(requests.map((request) => request.type)).toEqual([
			"workflow.v1.autoresearch.run",
			"workflow.v1.mempalace.recall",
			"workflow.v1.mempalace.propose",
		]);
		expect(requests[0]?.payload).toMatchObject({
			recipe_digest: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			evidence_refs: [EVIDENCE_REF],
		});
		expect(requests[1]?.payload).toMatchObject({
			query: "deployment timeout",
			knowledge_kind: "procedure",
			limit: 2,
		});
		expect(requests[2]?.payload).toMatchObject({
			knowledge_kind: "how",
			source_evidence_refs: [EVIDENCE_REF],
		});
	});

	it("exposes pipeline evidence admission through the real coordinator kernel", {
		tags: ["kernel-heavy"],
	}, async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledWorkflowControlSkill()],
			hostHandlers: authorizedWorkflowHostHandlers({
				"workflow.v1.execution_evidence.read": async (payload) => {
					requests.push({ type: "workflow.v1.execution_evidence.read", payload });
					return { observation_refs: [EVIDENCE_REF], state_digest: OUTPUT_DIGEST };
				},
				"workflow.v1.pipeline.record": async (payload) => {
					requests.push({ type: "workflow.v1.pipeline.record", payload });
					return { completed_stage_ids: [payload.stage_id], state_digest: OUTPUT_DIGEST };
				},
			}),
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
execution = await workflow.v1.execution_evidence.read()
pipeline = await workflow.v1.pipeline.record("recon", execution["observation_refs"])
print(json.dumps({"execution": execution, "pipeline": pipeline}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		expect(JSON.parse(result.stdout.trim())).toEqual({
			execution: { observation_refs: [EVIDENCE_REF], state_digest: OUTPUT_DIGEST },
			pipeline: { completed_stage_ids: ["recon"], state_digest: OUTPUT_DIGEST },
		});
		expect(requests).toMatchObject([
			{ type: "workflow.v1.execution_evidence.read", payload: { type: "workflow.v1.execution_evidence.read" } },
			{
				type: "workflow.v1.pipeline.record",
				payload: {
					type: "workflow.v1.pipeline.record",
					stage_id: "recon",
					evidence_refs: [EVIDENCE_REF],
				},
			},
		]);
	});

	it("rejects transient knowledge and source-less proposals before reaching the host", {
		tags: ["kernel-heavy"],
	}, async () => {
		let hostRequestCount = 0;
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledWorkflowSkill("mempalace")],
			hostHandlers: authorizedWorkflowHostHandlers({
				"workflow.v1.mempalace.recall": async () => {
					hostRequestCount++;
					return {};
				},
				"workflow.v1.mempalace.propose": async () => {
					hostRequestCount++;
					return {};
				},
			}),
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
for kind in ("decision", "outcome", "run_history", "transient_state"):
    try:
        await mempalace.recall("anything", knowledge_kind=kind)
    except ValueError as error:
        print(f"recall: {error}")
    try:
        await mempalace.propose(kind, [{"artifact_id": "evidence-1"}])
    except ValueError as error:
        print(f"propose: {error}")
try:
    await mempalace.propose("how", [])
except ValueError as error:
    print(f"empty: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim().split("\n")).toHaveLength(9);
		expect(hostRequestCount).toBe(0);
	});

	it("rejects bounded input overflow and malformed evidence references before reaching the host", {
		tags: ["kernel-heavy"],
	}, async () => {
		let hostRequestCount = 0;
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: WORKFLOW_SKILL_IMPORT_NAMES.map(bundledWorkflowSkill),
			hostHandlers: {
				"workflow.v1.autoresearch.run": async () => {
					hostRequestCount++;
					return {};
				},
				"workflow.v1.mempalace.recall": async () => {
					hostRequestCount++;
					return {};
				},
				"workflow.v1.mempalace.propose": async () => {
					hostRequestCount++;
					return {};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
valid_digest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
valid_ref = {
    "artifact_id": "evidence-1",
    "relative_path": "artifacts/evidence/evidence-1.json",
    "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "size_bytes": 128,
    "source_event_sequence": 7,
}
cases = [
    lambda: autoresearch.run("x" * 257, []),
    lambda: autoresearch.run(valid_digest, [valid_ref] * 33),
    lambda: autoresearch.run(valid_digest, [{"artifact_id": "evidence-1"}]),
    lambda: mempalace.recall("q" * 251),
    lambda: mempalace.recall("query", limit=6),
    lambda: mempalace.propose("how", []),
]
for attempt in cases:
    try:
        await attempt()
    except (TypeError, ValueError) as error:
        print(type(error).__name__)
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim().split("\n")).toEqual([
			"ValueError",
			"ValueError",
			"ValueError",
			"ValueError",
			"ValueError",
			"ValueError",
		]);
		expect(hostRequestCount).toBe(0);
	});

	it("rejects malformed and status-bearing host results", { tags: ["kernel-heavy"] }, async () => {
		let call = 0;
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledWorkflowSkill("autoresearch")],
			hostHandlers: authorizedWorkflowHostHandlers({
				"workflow.v1.autoresearch.run": async () => {
					call++;
					return call === 1
						? { status: "accepted" }
						: {
								skill_id: "autoresearch",
								output_kind: "evidence",
								evidence_refs: [],
								durable_knowledge_boundary_digest: null,
								transient_state_refs: [],
								can_authorize: false,
								output_digest: OUTPUT_DIGEST,
								unexpected: true,
							};
				},
			}),
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
valid_digest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
for _ in range(2):
    try:
        await autoresearch.run(valid_digest, [])
    except (RuntimeError, ValueError) as error:
        print(f"{type(error).__name__}: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim().split("\n")).toHaveLength(2);
		expect(result.stdout).toContain("ValueError");
	});

	it("documents and enforces the no-authority facade boundary", () => {
		const autoResearchSkill = readWorkflowSkillFile("autoresearch", "SKILL.md");
		const mempalaceSkill = readWorkflowSkillFile("mempalace", "SKILL.md");
		const pythonSources = WORKFLOW_SKILL_IMPORT_NAMES.map((name) =>
			readWorkflowSkillFile(name, `src/${name}/__init__.py`),
		);

		expect(autoResearchSkill).toContain("evidence/proposal");
		expect(autoResearchSkill.replace(/\s+/g, " ")).toContain("cannot authorize, promote, or complete");
		expect(mempalaceSkill).toContain("how/why/procedure");
		expect(mempalaceSkill.replace(/\s+/g, " ").toLowerCase()).toContain("transient decisions or run history");
		expect(mempalaceSkill.replace(/\s+/g, " ").toLowerCase()).toContain("cannot authorize, promote, or complete");
		expect(pythonSources[0]).toContain('"workflow.v1.autoresearch.run"');
		expect(pythonSources[1]).toContain('"workflow.v1.mempalace.recall"');
		expect(pythonSources[1]).toContain('"workflow.v1.mempalace.propose"');
		for (const source of pythonSources) {
			expect(source).toMatch(/from rlm import host_request/);
			expect(source).not.toMatch(
				/(?:^|\n)\s*(?:from|import)\s+(?:os|pathlib|socket|sqlite3|subprocess|urllib|requests|httpx)\b/,
			);
			expect(source).not.toMatch(/\b(?:open|unlink|remove|rename|mkdir|makedirs|Popen|call)\s*\(/);
			expect(source).not.toMatch(/host_request\(\s*["'][^"']*(?:authorize|promote|complete|store|write)/);
		}
	});
});
