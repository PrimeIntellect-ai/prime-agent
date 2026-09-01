import { describe, expect, it } from "vitest";
import { previewBashCommand, previewIpythonCode, previewPythonCode } from "../src/core/tools/code-preview.js";

describe("code preview", () => {
	it("skips bash setup and previews the real command", () => {
		expect(previewBashCommand("set -e\nnpm run check")).toEqual({ language: "bash", text: "npm check" });
	});

	it("simplifies common runner wrappers", () => {
		expect(
			previewBashCommand("npx tsx ../../node_modules/vitest/dist/cli.js --run test/code-preview.test.ts"),
		).toEqual({
			language: "bash",
			text: "vitest --run test/code-preview.test.ts",
		});
	});

	it("unwraps python heredocs in bash", () => {
		const command = `set -e
python3 - <<'PY'
from pathlib import Path
path = Path("package.json")
text = path.read_text()
path.write_text(text)
PY`;
		expect(previewBashCommand(command)).toEqual({ language: "python", text: "path.write_text(text)" });
	});

	it("unwraps bash cells in ipython", () => {
		const code = `%%bash
set -e
python3 - <<'PY'
import json
data = json.loads("{}")
print(data.keys())
PY`;
		expect(previewIpythonCode(code)).toEqual({ language: "python", text: "data.keys()" });
	});

	it("prefers meaningful python effects over setup assignments", () => {
		const code = `from pathlib import Path
p = Path("packages/coding-agent/src/modes/interactive/components/ipython-cell.ts")
txt = p.read_text()
p.write_text(txt.replace("old", "new"))`;
		expect(previewPythonCode(code)).toEqual({
			language: "python",
			text: "write packages/coding-agent/src/modes/interactive/components/ip…",
		});
	});

	it("handles stronger bash heuristics", () => {
		expect(previewBashCommand("cd packages/coding-agent && npm --prefix ../.. run check")).toEqual({
			language: "bash",
			text: "npm check (../..)",
		});
		expect(previewBashCommand("echo setup\ngit add packages/foo.ts")).toEqual({
			language: "bash",
			text: "git add packages/foo.ts",
		});
		expect(previewBashCommand("cat > packages/foo.ts <<'EOF'\nhello\nEOF")).toEqual({
			language: "bash",
			text: "write packages/foo.ts",
		});
	});

	it("extracts python subprocesses and control-block effects", () => {
		const subprocessCode = `import subprocess
subprocess.run(["npm", "run", "check"])
`;
		expect(previewPythonCode(subprocessCode)).toEqual({ language: "python", text: "npm check" });

		const controlCode = `from pathlib import Path
p = Path("packages/foo.ts")
if p.exists():
    p.unlink()
`;
		expect(previewPythonCode(controlCode)).toEqual({ language: "python", text: "delete packages/foo.ts" });
	});

	it("prefers executable calls over helper definitions", () => {
		const code = `def helper():
    return 1
run_check()
`;
		expect(previewPythonCode(code)).toEqual({ language: "python", text: "run_check()" });
	});

	it("redacts sensitive python preview values", () => {
		expect(previewPythonCode('password = "supersecretvalue"')).toEqual({
			language: "python",
			text: "password=<redacted>",
		});
		expect(previewPythonCode('client = OpenAI(api_key="sk-testsecretvalue")')).toEqual({
			language: "python",
			text: "client = OpenAI(api_key=<redacted>)",
		});
	});

	it("falls back when heredoc has no useful preview", () => {
		const command = `npm run check
python3 - <<'PY'
import json
from pathlib import Path
PY`;
		expect(previewBashCommand(command)).toEqual({ language: "bash", text: "npm check" });
	});

	it("continues past empty python heredocs", () => {
		const command = `python3 - <<'PY'
import json
from pathlib import Path
PY
python3 - <<'PY'
from pathlib import Path
p = Path("packages/foo.ts")
p.write_text("hello")
PY`;
		expect(previewBashCommand(command)).toEqual({ language: "python", text: "write packages/foo.ts" });
	});

	it("does not treat a .sh script path as an inline bash heredoc", () => {
		const command = `./script.sh <<'EOF'
hello world
EOF`;
		expect(previewBashCommand(command)).toEqual({ language: "bash", text: "hello world" });
	});

	it("routes bash-skill calls with literal commands to the bash preview", () => {
		expect(previewIpythonCode("r = await bash('git status --porcelain')")).toEqual({
			language: "bash",
			text: "git status --porcelain",
		});
		const longCommand = `git log --oneline -- ${Array.from({ length: 8 }, (_, i) => `packages/coding-agent/src/dir-${i}`).join(" ")}`;
		const longPreview = previewIpythonCode(`result = await bash("${longCommand}", timeout=120)`);
		expect(longPreview.language).toBe("bash");
		expect(longPreview.text.startsWith("git log --oneline")).toBe(true);
		const scorer = `import json
r = await bash('git diff --stat')
print(r)`;
		expect(previewIpythonCode(scorer)).toEqual({ language: "bash", text: "git diff --stat" });
		expect(
			previewIpythonCode(`r = await bash('curl -H "Authorization: Bearer sec-abc123" https://api.example.com')`)
				.text,
		).not.toContain("sec-abc123");
	});

	it("evaluates bash-skill literals the way python does", () => {
		const tripleBody = `r = await bash('''
set -e
git add packages/foo.ts
''')`;
		expect(previewIpythonCode(tripleBody)).toEqual({ language: "bash", text: "git add packages/foo.ts" });
		expect(previewIpythonCode("r = await bash('printf \"a\\nb\"\\ngit add -A')")).toEqual({
			language: "bash",
			text: "git add -A",
		});
		expect(previewIpythonCode("r = await bash('echo can\\'t stop')")).toEqual({
			language: "bash",
			text: "echo can't stop",
		});
		expect(previewIpythonCode('r = await bash("grep -n \\")\\" src.c")')).toEqual({
			language: "bash",
			text: 'grep -n ")" src.c',
		});
		expect(previewIpythonCode("r = await bash('''echo it\\'''')")).toEqual({ language: "bash", text: "echo it'" });
		expect(previewIpythonCode("r = await bash(r'grep \\'x\\' f')")).toEqual({
			language: "bash",
			text: "grep \\'x\\' f",
		});
	});

	it("keeps the python preview when the exact command cannot be known", () => {
		for (const code of [
			"r = await bash(cmd)",
			'r = await bash(f"git checkout {branch}")',
			"r = await bash('echo ' + name)",
			"r = await bash('echo hi\n)", // unterminated literal: python syntax error
			"r = await bash('echo \\x41')", // value-changing escape not computed here
			"r = await bash('grep \\bword\\b f')",
		]) {
			expect(previewIpythonCode(code).language).toBe("python");
		}
	});

	it("keeps the python preview for bash-looking text inside a multiline string", () => {
		expect(previewIpythonCode('doc = """\nbash("git status")\n"""')).toEqual({
			language: "python",
			text: 'bash("git status")',
		});
		expect(previewIpythonCode(`doc = """usage"""\nr = await bash('git status')`)).toEqual({
			language: "bash",
			text: "git status",
		});
	});

	it("prefers a later meaningful heredoc over an earlier generic one", () => {
		const command = `cat <<'CFG'
key=value
CFG
python3 - <<'PY'
from pathlib import Path
p = Path("packages/foo.ts")
p.write_text("hello")
PY`;
		expect(previewBashCommand(command)).toEqual({ language: "python", text: "write packages/foo.ts" });
	});
});
