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
