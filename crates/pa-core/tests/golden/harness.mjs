#!/usr/bin/env node
/**
 * Golden differential harness (lane core-tools).
 *
 * Runs the REAL TypeScript tools from the /tmp/pa-golden copy of prime-agent
 * and records their results as a JSON corpus, so a Rust port can assert
 * byte-identical parity.
 *
 * - cwd for execution: /tmp/pa-golden (node_modules resolution via jiti).
 * - Output: corpus/*.json next to this file.
 * - Every case sets up its fixture in a fresh mkdtemp dir; the fixture setup
 *   is recorded as replayable shell commands.
 * - Normalization: os.tmpdir() prefix -> "<TMP>", random tmp ids -> "<ID>".
 *   No timestamps, durations, or random ids are recorded.
 *
 * Determinism: two runs produce identical corpus files.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const PA_ROOT = "/tmp/pa-golden";
const __filename = fileURLToPath(import.meta.url);
const OUT_DIR = path.dirname(__filename);
const CORPUS = path.join(OUT_DIR, "corpus");

const TMP = os.tmpdir();

const req = createRequire(path.join(PA_ROOT, "package.json"));
const { createJiti } = req("jiti");
const jiti = createJiti(pathToFileURL(path.join(PA_ROOT, "harness-entry.mjs")).href, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-agent-core": path.join(PA_ROOT, "packages/agent/src/index.ts"),
		"@earendil-works/pi-ai": path.join(PA_ROOT, "packages/ai/src/index.ts"),
		"@earendil-works/pi-tui": path.join(PA_ROOT, "packages/tui/src/index.ts"),
	},
});

async function loadTs(rel) {
	const mod = await jiti.import(path.join(PA_ROOT, rel));
	return mod.default ?? mod;
}

// ---------------------------------------------------------------- normalizing
function normString(s) {
	let out = s.split(TMP + "/").join("<TMP>/");
	out = out.replace(/golden-[A-Za-z0-9_]{6}/g, "golden-<ID>");
	out = out.replace(/\bpi-(?:bash|output)-[0-9a-f]+\.log/g, "pi-<ID>.log");
	out = out.replace(/tmp-stdout-[0-9A-Za-z_]+/g, "tmp-stdout-<ID>");
	return out;
}

function deepNorm(value) {
	if (typeof value === "string") return normString(value);
	if (Array.isArray(value)) return value.map(deepNorm);
	if (value && typeof value === "object") {
		const out = {};
		for (const [k, v] of Object.entries(value)) out[k] = deepNorm(v);
		return out;
	}
	return value;
}

function writeCorpus(name, cases) {
	const doc = deepNorm({ group: name, caseCount: cases.length, cases });
	fs.writeFileSync(path.join(CORPUS, name + ".json"), JSON.stringify(doc, null, 2) + "\n");
}

// ------------------------------------------------------------------- fixtures
function makeFixture(tc) {
	const dir = fs.mkdtempSync(path.join(TMP, "golden-"));
	for (const [name, content] of Object.entries(tc.files ?? {})) {
		const abs = path.join(dir, name);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, Buffer.from(String(content), "utf-8"));
	}
	for (const cmd of tc.fixture ?? []) {
		const r = spawnSync("/bin/bash", ["-c", cmd], { cwd: dir, encoding: "utf-8" });
		if (r.status !== 0) {
			throw new Error(`fixture command failed (${r.status}): ${cmd}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
		}
	}
	return dir;
}

function stripCaseRuntimeFields(tc) {
	const { files, fixture, ...rest } = tc;
	return rest;
}

// ================================================================== GROUP 1
async function editGroup() {
	const mod = await loadTs("packages/coding-agent/src/core/tools/edit.ts");

	const gitless = {
		files: {
			"file.txt": "alpha\nbeta\ngamma\ndelta\n",
		},
	};

	const cases = [
		{
			name: "unique-replacement",
			...gitless,
			applyPrepareArguments: false,
			input: { path: "file.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
		},
		{
			name: "two-edits",
			files: { "file.txt": "alpha\nbeta\ngamma\ndelta\n" },
			applyPrepareArguments: false,
			input: {
				path: "file.txt",
				edits: [
					{ oldText: "alpha", newText: "ALPHA" },
					{ oldText: "gamma", newText: "GAMMA" },
				],
			},
		},
		{
			name: "not-found",
			...gitless,
			applyPrepareArguments: false,
			input: { path: "file.txt", edits: [{ oldText: "missing", newText: "x" }] },
		},
		{
			name: "ambiguous",
			files: { "file.txt": "repeat\nmiddle\nrepeat\n" },
			applyPrepareArguments: false,
			input: { path: "file.txt", edits: [{ oldText: "repeat", newText: "x" }] },
		},
		{
			name: "overlapping-edits",
			files: { "file.txt": "abcdef\n" },
			applyPrepareArguments: false,
			input: {
				path: "file.txt",
				edits: [
					{ oldText: "abcd", newText: "X" },
					{ oldText: "cdef", newText: "Y" },
				],
			},
		},
		{
			name: "file-not-found",
			applyPrepareArguments: false,
			input: { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] },
		},
		{
			name: "empty-edits",
			...gitless,
			applyPrepareArguments: false,
			input: { path: "file.txt", edits: [] },
		},
		{
			name: "legacy-oldText-newText",
			...gitless,
			applyPrepareArguments: true,
			input: { path: "file.txt", oldText: "beta", newText: "BETA" },
		},
		{
			name: "edits-as-json-string",
			...gitless,
			applyPrepareArguments: true,
			input: { path: "file.txt", edits: JSON.stringify([{ oldText: "beta", newText: "BETA" }]) },
		},
		{
			name: "bom-file",
			files: { "file.txt": "﻿hello world\nsecond line\n" },
			applyPrepareArguments: false,
			input: { path: "file.txt", edits: [{ oldText: "world", newText: "planet" }] },
		},
		{
			name: "crlf-file",
			files: { "file.txt": "line1\r\nline2\r\nline3\r\n" },
			applyPrepareArguments: false,
			input: { path: "file.txt", edits: [{ oldText: "line2", newText: "LINE2" }] },
		},
		{
			name: "fuzzy-trailing-whitespace",
			files: { "file.txt": "alpha   \nbeta\nkeep  \n" },
			applyPrepareArguments: false,
			input: { path: "file.txt", edits: [{ oldText: "alpha\n", newText: "ALPHA\n" }] },
		},
		{
			name: "fuzzy-smart-quotes",
			files: { "file.txt": "it’s a “test” line\n" },
			applyPrepareArguments: false,
			input: { path: "file.txt", edits: [{ oldText: "it's a \"test\" line", newText: "plain quotes" }] },
		},
		{
			name: "empty-oldtext",
			...gitless,
			applyPrepareArguments: false,
			input: { path: "file.txt", edits: [{ oldText: "", newText: "x" }] },
		},
		{
			name: "no-change",
			...gitless,
			applyPrepareArguments: false,
			input: { path: "file.txt", edits: [{ oldText: "beta", newText: "beta" }] },
		},
		{
			name: "directory-path",
			fixture: ["mkdir -p adir"],
			applyPrepareArguments: false,
			input: { path: "adir", edits: [{ oldText: "a", newText: "b" }] },
		},
	];

	const out = [];
	for (const tc of cases) {
		const dir = makeFixture(tc);
		const def = mod.createEditToolDefinition(dir);
		let input = structuredClone(tc.input);
		let preparedInput;
		if (tc.applyPrepareArguments) {
			input = def.prepareArguments(input);
			preparedInput = input;
		}
		let result;
		try {
			const r = await def.execute("id", input, undefined);
			result = { ok: true, text: r.content[0].text, details: r.details ?? null };
		} catch (err) {
			result = { ok: false, error: err.message };
		}
		let finalContent = null;
		try {
			finalContent = fs.readFileSync(path.resolve(dir, String(tc.input.path)), "utf-8");
		} catch {
			finalContent = null;
		}
		out.push({
			name: tc.name,
			files: tc.files ?? {},
			fixture: tc.fixture ?? [],
			applyPrepareArguments: tc.applyPrepareArguments,
			input: tc.input,
			...(preparedInput !== undefined ? { preparedInput } : {}),
			result,
			finalContent,
		});
	}
	writeCorpus("edit", out);
	return out.length;
}

// ================================================================== GROUP 2
// Fixed commit dates keep commit hashes (printed by `git reset --hard`)
// deterministic across runs.
const FIXED_DATE = "GIT_AUTHOR_DATE='2005-04-07T22:13:13' GIT_COMMITTER_DATE='2005-04-07T22:13:13'";

const dirtyRepoFixture = [
	"git init -q .",
	"git config user.email t@t",
	"git config user.name t",
	"echo original > tracked.txt",
	"git add tracked.txt",
	FIXED_DATE + " git commit -qm init",
	"echo modified > tracked.txt",
	"echo untracked > untracked.txt",
];

const cleanRepoFixture = [
	"git init -q .",
	"git config user.email t@t",
	"git config user.name t",
	"echo original > tracked.txt",
	"git add tracked.txt",
	FIXED_DATE + " git commit -qm init",
];

function bashCase(name, opts) {
	return { name, ...opts };
}

async function runBashCase(tc) {
	let dir;
	if (tc.cwdIsDeleted) {
		dir = makeFixture({ files: tc.files ?? {}, fixture: tc.fixture ?? [] });
		fs.rmSync(dir, { recursive: true });
	} else {
		dir = makeFixture(tc);
	}
	const bashMod = await loadTs("packages/coding-agent/src/core/tools/bash.ts");
	const def = bashMod.createBashToolDefinition(dir, tc.options);
	const input = { command: tc.command };
	if (tc.timeout !== undefined) input.timeout = tc.timeout;
	if (tc.allowDestructiveGit !== undefined) input.allowDestructiveGit = tc.allowDestructiveGit;
	let result;
	try {
		const r = await def.execute("id", input, undefined);
		result = { ok: true, isError: false, text: r.content[0].text, details: r.details ?? null };
	} catch (err) {
		result = { ok: false, isError: true, error: err.message };
	}
	const out = {
		name: tc.name,
		files: tc.files ?? {},
		fixture: tc.fixture ?? [],
		command: tc.command,
		...(tc.timeout !== undefined ? { timeout: tc.timeout } : {}),
		...(tc.allowDestructiveGit !== undefined ? { allowDestructiveGit: tc.allowDestructiveGit } : {}),
		...(tc.envBypass ? { envBypass: tc.envBypass } : {}),
		...(tc.cwdIsDeleted ? { cwdIsDeleted: true } : {}),
		result,
	};
	// Normalize + probe details of fullOutputPath (existence is checked pre-normalization).
	const rawPath = result.ok ? result.details?.fullOutputPath : undefined;
	if (rawPath) {
		let exists = false;
		let bytes = null;
		try {
			const st = fs.statSync(rawPath);
			exists = true;
			bytes = st.size;
		} catch {
			exists = false;
		}
		result.fullOutputFile = { exists, bytes };
	}
	return out;
}

function bashCaseDefs() {
	return [
		bashCase("echo-hello", { command: "echo hello" }),
		bashCase("exit-code-3", { command: "echo out; exit 3" }),
		bashCase("no-output", { command: "true" }),
		bashCase("timeout", { command: "sleep 5", timeout: 1 }),
		bashCase("stdout-stderr-both", { command: "echo out; echo err1 1>&2; echo out2; echo err2 1>&2" }),
		bashCase("line-truncation", { command: "seq 1 2500" }),
		bashCase("byte-truncation-multiline", {
			command: "for i in $(seq 1 100); do head -c 600 /dev/zero | tr '\\0' x; echo; done",
		}),
		bashCase("single-huge-line", {
			command: "python3 -c \"print('x'*60000)\"",
		}),
		bashCase("unicode-output", {
			command:
				"python3 -c \"import sys,time; sys.stdout.write('\\u00e9\\u00e9\\u00e9'); sys.stdout.flush(); time.sleep(0.05); sys.stdout.write('\\u2713'); sys.stdout.flush()\"",
		}),
		bashCase("destructive-checkout-dirty", {
			fixture: dirtyRepoFixture,
			command: "git checkout -- .",
		}),
		bashCase("destructive-allow-bypass", {
			fixture: dirtyRepoFixture,
			command: "git checkout -- .",
			allowDestructiveGit: true,
		}),
		bashCase("destructive-reset-clean", {
			fixture: cleanRepoFixture,
			command: "git reset --hard",
		}),
		bashCase("destructive-quoted", {
			command: "echo 'git reset --hard'",
		}),
		bashCase("destructive-cd-sub", {
			fixture: [
				...cleanRepoFixture,
				"mkdir sub",
				"cd sub && git init -q . && git config user.email t@t && git config user.name t && echo orig > subfile.txt && git add subfile.txt && " + FIXED_DATE + " git commit -qm subinit",
				"cd sub && echo dirty > subfile.txt",
			],
			command: "cd sub && git checkout -- .",
		}),
		bashCase("destructive-comment", {
			fixture: cleanRepoFixture,
			command: "echo done # git reset --hard",
		}),
		bashCase("env-bypass", {
			fixture: dirtyRepoFixture,
			command: "git checkout -- .",
			envBypass: true,
		}),
		bashCase("cwd-missing", {
			cwdIsDeleted: true,
			command: "echo hi",
		}),
	];
}

async function bashGroup() {
	const defs = bashCaseDefs();
	const out = [];
	// env-bypass needs PI_BASH_ALLOW_DESTRUCTIVE_GIT in process.env; run it in a
	// child node process (getShellEnv() inherits process.env).
	for (const tc of defs) {
		if (!tc.envBypass) {
			out.push(await runBashCase(tc));
		}
	}
	// Child run: only the env-bypass case.
	const envBypassDef = defs.find((d) => d.envBypass);
	const childEnv = {
		...process.env,
		PI_BASH_ALLOW_DESTRUCTIVE_GIT: "1",
		HARNESS_ONLY_BYPASS: "1",
		HARNESS_OUT: path.join(CORPUS, "_env-bypass-part.json"),
	};
	const r = spawnSync(process.execPath, [__filename], { encoding: "utf-8", env: childEnv, cwd: process.cwd() });
	if (r.status !== 0) {
		throw new Error("env-bypass child run failed:\n" + r.stdout + "\n" + r.stderr);
	}
	const part = JSON.parse(fs.readFileSync(childEnv.HARNESS_OUT, "utf-8"));
	fs.rmSync(childEnv.HARNESS_OUT, { force: true });
	out.push(part);

	writeCorpus("bash", out);
	return out.length;
}

// ================================================================== GROUP 3
async function previewGroup() {
	const cp = await loadTs("packages/coding-agent/src/core/tools/code-preview.ts");
	const inputs = [
		"npm run test -- --watch",
		"git add -A && git commit -m x",
		"python3 <<'EOF'\nprint('hello')\nEOF",
		"%%bash\ncd sub && make",
		"curl -s https://api.example.com/v1 -H 'Authorization: Bearer abc123def456'",
		"cd sub && make",
		"uv run python3 -m pytest tests/x.rs",
		"tee -a out.log",
		"API_TOKEN = \"abc123\"\nrequests.get(\"https://example.com\", headers={\"Authorization\": \"Bearer sk-live-0123456789\"})",
		"python3 -c \"import base64; print(base64.b64encode(b'0123456789'*12))\"",
		"cat data.bin",
		"echo qwertyuiopasdfghjklzxcvbnm1234567890QWERTYUIOPASDFGHJKLZXCVBNM+/0987654321qazwsxedcrfvtgbyhnujmikolp",
		"for i in $(ls /very/long/path/with/many/components/here); do echo processing $i; done",
		"from pathlib import Path\nout = Path('out.txt')\nout.write_text('hello')\nimport subprocess\nsubprocess.run('git status', shell=True)",
		"print('just printing')",
		"%%bash\necho in-bash-cell",
	];
	const out = inputs.map((input) => ({
		input,
		bash: cp.previewBashCommand(input),
		ipython: cp.previewIpythonCode(input),
	}));
	writeCorpus("preview", out);
	return out.length;
}

// ================================================================== GROUP 4
async function truncateGroup() {
	const tr = await loadTs("packages/coding-agent/src/core/tools/truncate.ts");
	const cases = [
		{ name: "exact-boundary-equal-limits", content: "a\nb\nc", maxLines: 3, maxBytes: 10 },
		{ name: "one-line-over-head", content: "a\nb\nc\nd", maxLines: 3, maxBytes: 100 },
		{ name: "one-line-over-tail", content: "a\nb\nc\nd", maxLines: 3, maxBytes: 100 },
		{
			name: "multibyte-at-byte-boundary",
			content: "éééééééééé\néééééééééé\néééééééééé\n",
			maxLines: 100,
			maxBytes: 24,
		},
		{ name: "first-line-exceeds-bytes-head", content: "xxxxxxxxxxxxxxxxxxxxxxxx\nshort\n", maxLines: 10, maxBytes: 16 },
		{ name: "first-line-exceeds-bytes-tail", content: "xxxxxxxxxxxxxxxxxxxxxxxx\nshort\n", maxLines: 10, maxBytes: 16 },
		{
			name: "tail-trailing-blank-partial-rescue",
			content: "y".repeat(100) + "\n\n\n",
			maxLines: 10,
			maxBytes: 50,
		},
		{ name: "empty-string", content: "", maxLines: 5, maxBytes: 50 },
		{ name: "no-trailing-newline", content: "a\nb\nc", maxLines: 2, maxBytes: 100 },
		{ name: "byte-limit-tail-simple", content: Array.from({ length: 40 }, (_, i) => "line" + i).join("\n") + "\n", maxLines: 2000, maxBytes: 60 },
	];
	const out = cases.map((tc) => ({
		name: tc.name,
		content: tc.content,
		maxLines: tc.maxLines,
		maxBytes: tc.maxBytes,
		head: tr.truncateHead(tc.content, { maxLines: tc.maxLines, maxBytes: tc.maxBytes }),
		tail: tr.truncateTail(tc.content, { maxLines: tc.maxLines, maxBytes: tc.maxBytes }),
	}));
	writeCorpus("truncate", out);
	return out.length;
}

// ================================================================== GROUP 5
async function ipythonGroup() {
	const ip = await loadTs("packages/coding-agent/src/core/tools/ipython.ts");
	const kernelShared = await loadTs("packages/coding-agent/src/core/kernel/shared.ts");
	const BusyErr = kernelShared.KernelBusyAfterInterruptError;

	function makeProvisioner(executions) {
		const calls = { ensure: 0, execute: 0, kill: 0 };
		let i = 0;
		const manager = {
			execute: async (code, opts) => {
				calls.execute++;
				const item = executions[Math.min(i++, executions.length - 1)];
				if (item instanceof Error) throw item;
				return item;
			},
		};
		return {
			calls,
			ensure: async (_onProgress, _signal) => {
				calls.ensure++;
				return manager;
			},
			kill: async () => {
				calls.kill++;
			},
		};
	}

	const okResult = (over = {}) => ({ status: "ok", stdout: "", stderr: "", durationMs: 123, ...over });

	const caseDefs = [
		{
			name: "stdout-stderr-result-ordering",
			code: "print('out')",
			mockResults: [okResult({ stdout: "out\n", stderr: "err\n", result: "42" })],
			ctxMode: "none",
		},
		{
			name: "error-status-traceback",
			code: "1/0",
			mockResults: [
				{
					status: "error",
					stdout: "before\n",
					stderr: "",
					result: undefined,
					error: {
						ename: "ZeroDivisionError",
						evalue: "division by zero",
						traceback: ["Traceback (most recent call last):", "  File ...: division by zero"],
					},
					durationMs: 5,
				},
			],
			ctxMode: "none",
		},
		{
			name: "empty-output",
			code: "x = 1",
			mockResults: [okResult()],
			ctxMode: "none",
		},
		{
			name: "background-output",
			code: "import time; time.sleep(0.01)",
			mockResults: [okResult({ stdout: "x", backgroundOutput: "late output\nfrom background" })],
			ctxMode: "none",
		},
		{
			name: "aborted-status",
			code: "import time; time.sleep(10)",
			mockResults: [okResult({ status: "aborted", stdout: "partial output" })],
			ctxMode: "none",
		},
		{
			name: "busy-then-cancel-no-ui",
			code: "print('never')",
			mockResults: [new BusyErr()],
			ctxMode: "none",
		},
		{
			name: "busy-then-kill-restart-notice",
			code: "print('after restart')",
			mockResults: [new BusyErr(), okResult({ stdout: "after restart\n" })],
			ctxMode: "ui-kill",
		},
	];

	const out = [];
	for (const tc of caseDefs) {
		const prov = makeProvisioner(tc.mockResults);
		const def = ip.createIpythonToolDefinition("/tmp", { provisioner: prov });
		const ctx =
			tc.ctxMode === "ui-kill"
				? {
					hasUI: true,
					ui: {
						async select(_prompt, _choices, _opts) {
							return "Kill kernel and restart";
						},
						setWorkingMessage() {},
					},
				}
				: undefined;
		let result;
		try {
			const r = await def.execute("id", { code: tc.code }, undefined, undefined, ctx);
			result = { ok: true, isError: r.isError === true, outputText: r.content[0].text };
		} catch (err) {
			result = { ok: false, isError: true, error: err.message };
		}
		out.push({
			name: tc.name,
			code: tc.code,
			ctxMode: tc.ctxMode,
			mockResults: tc.mockResults.map((m) => (m instanceof Error ? { thrown: m.name, message: m.message } : m)),
			provisionerCalls: prov.calls,
			result,
		});
	}
	writeCorpus("ipython", out);
	return out.length;
}

// ================================================================== GROUP 6
async function schemaGroup() {
	const edit = await loadTs("packages/coding-agent/src/core/tools/edit.ts");
	const bash = await loadTs("packages/coding-agent/src/core/tools/bash.ts");
	const ipython = await loadTs("packages/coding-agent/src/core/tools/ipython.ts");
	const defs = {
		bash: bash.createBashToolDefinition("/tmp"),
		edit: edit.createEditToolDefinition("/tmp"),
		ipython: ipython.createIpythonToolDefinition("/tmp"),
	};
	const out = [];
	for (const [tool, def] of Object.entries(defs)) {
		out.push({
			tool,
			name: def.name,
			label: def.label,
			description: def.description,
			promptSnippet: def.promptSnippet,
			...(def.executionMode !== undefined ? { executionMode: def.executionMode } : {}),
			parameters: def.parameters,
		});
	}
	writeCorpus("schema", out);
	return out.length;
}

// ======================================================================= main
async function main() {
	fs.mkdirSync(CORPUS, { recursive: true });
	if (process.env.HARNESS_ONLY_BYPASS === "1") {
		// Child run: execute only the env-bypass bash case, write it to HARNESS_OUT.
		const defs = bashCaseDefs().filter((d) => d.envBypass);
		const results = [];
		for (const tc of defs) results.push(await runBashCase(tc));
		fs.writeFileSync(process.env.HARNESS_OUT, JSON.stringify(deepNorm(results[0]), null, 2) + "\n");
		process.exit(0);
	}
	const counts = {};
	counts.edit = await editGroup();
	counts.bash = await bashGroup();
	counts.preview = await previewGroup();
	counts.truncate = await truncateGroup();
	counts.ipython = await ipythonGroup();
	counts.schema = await schemaGroup();

	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	console.log("corpus written:", JSON.stringify(counts), "total", total);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
