import { parseIpythonBashCell } from "./ipython-cell-code.js";

const DESCRIPTOR_MAX_WIDTH = 64;

const MAGIC_LINE_PATTERN = /^\s*!/;
const COMMENT_LINE_PATTERN = /^\s*#/;
const CD_PREFIX_PATTERN = /^\s*cd\s+([^&;|]+)(?:&&|;)\s*/;
const BASH_SET_PATTERN = /^\s*set\s+[-+][A-Za-z]*(?:\s+[-+]?\w+)*(?:\s+pipefail)?\s*$/;
const BASH_SETUP_PATTERN = /^(?:export\s+\w+=|source\s+\S+|\.\s+\S+)/;
const PYTHON_IMPORT_PATTERN = /^\s*(?:import\s+\S|from\s+\S+\s+import\s+)/;
const PYTHON_DECORATOR_PATTERN = /^\s*@/;
const PYTHON_DEFINITION_PATTERN = /^\s*(?:async\s+def|def|class)\s+/;
const PYTHON_MAIN_PATTERN = /^\s*if\s+__name__\s*==\s*['"]__main__['"]\s*:/;
const PYTHON_CONTROL_PATTERN = /^\s*(?:if|elif|else|for|while|with|try|except|finally)\b.*:\s*$/;
const PYTHON_CALL_PATTERN = /^\s*(?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*\(/;
const BASH_SKILL_CALL_PATTERN = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?(?:await\s+)?bash\s*\(\s*[rR]?("""|'''|"|')/;
const PYTHON_LOW_SIGNAL_CALL_PATTERN = /^\s*(?:await\s+)?(?:print|len|str|repr|int|float|list|dict|set|tuple)\s*\(/;
const PYTHON_ASSIGNMENT_CALL_PATTERN =
	/^\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[^=]+)?\s*=\s*(?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*\(/;
const PYTHON_LOW_SIGNAL_ASSIGNMENT_CALL_PATTERN =
	/^\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[^=]+)?\s*=\s*(?:await\s+)?(?:Path|pathlib\.Path|json\.loads|json\.dumps|str|int|float|list|dict|set|tuple)\s*\(/;
const PYTHON_EFFECT_CALL_PATTERN =
	/^\s*(?:await\s+)?[A-Za-z_][A-Za-z0-9_.]*\.(?:write_text|write_bytes|mkdir|unlink|rename|replace|touch|append|extend|update|add|remove|discard|close|commit|execute|run)\s*\(/;
const HEREDOC_PATTERN = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;
const PATH_ASSIGN_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:Path|pathlib\.Path)\(["']([^"']+)["']\)/;
const STRING_ASSIGN_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']([^"']+)["']/;

export type CodePreviewLanguage = "bash" | "python";

export interface CodePreview {
	language: CodePreviewLanguage;
	text: string;
}

interface PreviewCandidate {
	language: CodePreviewLanguage;
	text: string;
	score: number;
	index: number;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateDescriptor(text: string): string {
	if (text.length <= DESCRIPTOR_MAX_WIDTH) {
		return text;
	}
	return `${text.slice(0, DESCRIPTOR_MAX_WIDTH - 1).trimEnd()}…`;
}

function redactNoise(text: string): string {
	return text
		.replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "<blob>")
		.replace(/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*=\s*(["'])[^"']*\2/gi, "$1=<redacted>")
		.replace(
			/\b((?=\w*(?:token|key|secret|password))[A-Za-z_]\w*)\s*=\s*(?!<redacted>)(?!["'])\S+/gi,
			"$1=<redacted>",
		)
		.replace(/(["'])sk-[^"']+\1/g, "$1<redacted>$1")
		.replace(/(["']).{160,}\1/g, "$1…$1");
}

function descriptor(text: string): string {
	return truncateDescriptor(collapseWhitespace(redactNoise(text)));
}

function stripBashPrefix(line: string): string {
	return line.replace(MAGIC_LINE_PATTERN, "").trim().replace(CD_PREFIX_PATTERN, "").trim();
}

function isSkippableBashLine(line: string): boolean {
	const trimmed = line.trim();
	return (
		!trimmed ||
		COMMENT_LINE_PATTERN.test(trimmed) ||
		BASH_SET_PATTERN.test(trimmed) ||
		BASH_SETUP_PATTERN.test(trimmed)
	);
}

function shellWords(line: string): string[] {
	const words: string[] = [];
	const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (const match of line.matchAll(pattern)) {
		words.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return words;
}

function pathTail(path: string): string {
	return path.replace(/^\.\//, "");
}

function simplifyRunnerCommand(line: string): string | undefined {
	const words = shellWords(line);
	const joined = words.join(" ");
	const vitestIndex = words.findIndex((word) => /(?:^|\/)vitest\/dist\/cli\.js$/.test(word));
	if (words[0] === "npx" && words[1] === "tsx" && vitestIndex >= 2) {
		return `vitest ${words.slice(vitestIndex + 1).join(" ")}`.trim();
	}
	if (words[0] === "npm") {
		const prefixIndex = words.indexOf("--prefix");
		const cwd = prefixIndex >= 0 ? words[prefixIndex + 1] : undefined;
		const runIndex = words.indexOf("run");
		if (runIndex >= 0 && words[runIndex + 1]) {
			const command = `npm ${words[runIndex + 1]} ${words.slice(runIndex + 2).join(" ")}`.trim();
			return cwd ? `${command} (${pathTail(cwd)})` : command;
		}
	}
	if (words[0] === "pnpm") {
		const cwdIndex = words.findIndex((word) => word === "-C" || word === "--dir");
		const cwd = cwdIndex >= 0 ? words[cwdIndex + 1] : undefined;
		const rest = words.filter((_, index) => index !== cwdIndex && index !== cwdIndex + 1);
		return cwd ? `${rest.join(" ")} (${pathTail(cwd)})` : undefined;
	}
	const pytestIndex = words.findIndex(
		(word, index) => word === "pytest" || (word === "pytest" && words[index - 1] === "-m"),
	);
	if (words[0] === "uv" && words[1] === "run" && pytestIndex >= 0) {
		return `pytest ${words.slice(pytestIndex + 1).join(" ")}`.trim();
	}
	if ((words[0] === "python" || words[0] === "python3") && words[1] === "-m" && words[2] === "pytest") {
		return `pytest ${words.slice(3).join(" ")}`.trim();
	}
	if (joined.includes("node_modules/.bin/")) {
		return joined.replace(/\S*node_modules\/\.bin\//g, "");
	}
	return undefined;
}

function simplifyMutationCommand(line: string): string | undefined {
	const words = shellWords(line);
	if (words.length === 0) return undefined;
	if (words[0] === "cat" && words[1] === ">" && words[2]) return `write ${pathTail(words[2])}`;
	if (words[0] === "tee" && words.at(-1))
		return `${words.includes("-a") ? "append" : "write"} ${pathTail(words.at(-1) ?? "")}`;
	if (words[0] === "apply_patch") return "apply patch";
	if (["rm", "mv", "cp", "git", "npm"].includes(words[0] ?? "")) return line;
	if (
		(words[0] === "sed" && words.some((word) => word.startsWith("-i"))) ||
		(words[0] === "perl" && words.includes("-pi"))
	) {
		return line;
	}
	return undefined;
}

function simplifyBashCommandLine(line: string): string {
	return simplifyRunnerCommand(line) ?? simplifyMutationCommand(line) ?? line;
}

function splitCommandChain(line: string): string[] {
	return line
		.split(/\s*(?:&&|;)\s*/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function heredocBody(lines: readonly string[], startIndex: number, delimiter: string): string | undefined {
	// While args stream, preview the partial heredoc body rather than the low-signal heredoc opener.
	const body: string[] = [];
	for (let i = startIndex + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === delimiter) {
			return body.join("\n");
		}
		body.push(line);
	}
	return body.length > 0 ? body.join("\n") : undefined;
}

function previewHeredoc(lines: readonly string[]): CodePreview | undefined {
	// A generic heredoc body is low-signal; keep it as a fallback and prefer a
	// later, more specific heredoc (python/bash/node/write) if one follows.
	let fallback: CodePreview | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = stripBashPrefix(lines[i] ?? "");
		if (isSkippableBashLine(line)) {
			continue;
		}
		const heredocMatch = line.match(HEREDOC_PATTERN);
		const delimiter = heredocMatch?.[1];
		if (!delimiter) {
			continue;
		}
		const body = heredocBody(lines, i, delimiter);
		if (!body) {
			continue;
		}
		if (/\b(?:uv\s+run\s+)?python3?\b/.test(line)) {
			const preview = previewPythonCode(body);
			if (preview.text) {
				return preview;
			}
			continue;
		}
		// Match bash/sh as an interpreter word (incl. /bin/sh), not a path suffix like script.sh.
		if (/(?<![\w.])(?:bash|sh)\b/.test(line)) {
			const preview = previewBashCommand(body);
			return preview.text ? preview : { language: "bash", text: descriptor(body) };
		}
		if (/\bnode\b/.test(line)) {
			return { language: "bash", text: `node: ${descriptor(body)}` };
		}
		const catWrite = line.match(/\b(?:cat|tee)\b.*(?:>|\s)(\S+)\s*<<-?/);
		if (catWrite?.[1]) {
			return { language: "bash", text: `${line.includes("tee -a") ? "append" : "write"} ${pathTail(catWrite[1])}` };
		}
		if (/\bapply_patch\b/.test(line)) {
			return { language: "bash", text: "apply patch" };
		}
		fallback ??= { language: "bash", text: descriptor(body) };
	}
	return fallback;
}

function bashLineScore(line: string, index: number): number {
	const simplified = simplifyBashCommandLine(line);
	const words = shellWords(line);
	let score = 30;
	if (simplified !== line) score += 40;
	if (["rm", "mv", "cp", "git", "npm", "pnpm", "pytest", "vitest"].includes(words[0] ?? "")) score += 20;
	if (/\b(?:rm|mv|cp|git\s+(?:add|commit)|npm\s+install|sed\s+-i|perl\s+-pi|tee|cat\s*>|apply_patch)\b/.test(line))
		score += 40;
	return score + index;
}

export function previewBashCommand(command: string): CodePreview {
	const lines = command.split("\n");
	const heredoc = previewHeredoc(lines);
	if (heredoc?.text) {
		return { language: heredoc.language, text: descriptor(heredoc.text) };
	}

	let best: PreviewCandidate | undefined;
	let index = 0;
	for (const rawLine of lines) {
		for (const rawPart of splitCommandChain(rawLine)) {
			const commandLine = stripBashPrefix(rawPart.trim());
			if (!commandLine || isSkippableBashLine(commandLine)) {
				continue;
			}
			const candidate = {
				language: "bash" as const,
				text: simplifyBashCommandLine(commandLine),
				score: bashLineScore(commandLine, index),
				index,
			};
			if (!best || candidate.score > best.score) {
				best = candidate;
			}
			index += 1;
		}
	}
	return { language: "bash", text: best ? descriptor(best.text) : "" };
}

function isSkippablePythonLine(line: string): boolean {
	const trimmed = line.trim();
	return !trimmed || COMMENT_LINE_PATTERN.test(trimmed) || PYTHON_IMPORT_PATTERN.test(trimmed);
}

function pythonIndent(line: string): number {
	const match = line.match(/^\s*/);
	return match?.[0].length ?? 0;
}

function pythonPrintInnerCall(line: string): string | undefined {
	const printMatch = line.trim().match(/^print\((.*)\)$/);
	const inner = printMatch?.[1]?.trim();
	return inner && PYTHON_CALL_PATTERN.test(inner) ? inner : undefined;
}

function pythonPathVars(lines: readonly string[]): Map<string, string> {
	const vars = new Map<string, string>();
	for (const line of lines) {
		const pathMatch = line.match(PATH_ASSIGN_PATTERN) ?? line.match(STRING_ASSIGN_PATTERN);
		if (pathMatch?.[1] && pathMatch[2]?.includes("/")) {
			vars.set(pathMatch[1], pathMatch[2]);
		}
	}
	return vars;
}

function pythonFileOperation(line: string, paths: ReadonlyMap<string, string>): string | undefined {
	const match = line
		.trim()
		.match(
			/^(?:await\s+)?([A-Za-z_][A-Za-z0-9_]*)\.(write_text|write_bytes|read_text|read_bytes|mkdir|unlink|rename|replace|touch)\s*\(/,
		);
	if (!match?.[1] || !match[2]) return undefined;
	const path = paths.get(match[1]);
	if (!path) return undefined;
	const action: Record<string, string> = {
		write_text: "write",
		write_bytes: "write",
		read_text: "read",
		read_bytes: "read",
		mkdir: "mkdir",
		unlink: "delete",
		rename: "rename",
		replace: "replace",
		touch: "touch",
	};
	return `${action[match[2]] ?? match[2]} ${pathTail(path)}`;
}

function pythonSubprocessCommand(line: string): string | undefined {
	const trimmed = line.trim();
	const shellMatch = trimmed.match(/subprocess\.(?:run|check_call|check_output|Popen)\(\s*["`]([^"`]+)["`]/);
	if (shellMatch?.[1]) return simplifyBashCommandLine(shellMatch[1]);
	const listMatch = trimmed.match(/subprocess\.(?:run|check_call|check_output|Popen)\(\s*\[([^\]]+)\]/);
	if (listMatch?.[1]) {
		const words = [...listMatch[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1] ?? "");
		return simplifyBashCommandLine(words.join(" "));
	}
	return undefined;
}

function simplifyPythonPreviewLine(line: string, paths: ReadonlyMap<string, string>): string {
	return (
		pythonFileOperation(line, paths) ?? pythonSubprocessCommand(line) ?? pythonPrintInnerCall(line) ?? line.trim()
	);
}

function pythonPreviewLine(lines: readonly string[], index: number, paths: ReadonlyMap<string, string>): string {
	const line = lines[index] ?? "";
	if (index > 0 && PYTHON_DEFINITION_PATTERN.test(line)) {
		const previous = lines[index - 1] ?? "";
		if (PYTHON_DECORATOR_PATTERN.test(previous.trim())) {
			return `${previous.trim()} ${line.trim()}`;
		}
	}
	if (PYTHON_CONTROL_PATTERN.test(line)) {
		const childIndex = firstPythonChildLine(lines, index);
		if (childIndex !== undefined) {
			return `${line.trim().replace(/:\s*$/, ":")} ${simplifyPythonPreviewLine(lines[childIndex] ?? "", paths)}`;
		}
	}
	return simplifyPythonPreviewLine(line, paths);
}

function firstPythonChildLine(lines: readonly string[], parentIndex: number): number | undefined {
	const parentIndent = pythonIndent(lines[parentIndex] ?? "");
	for (let i = parentIndex + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (isSkippablePythonLine(line) || PYTHON_DECORATOR_PATTERN.test(line.trim())) {
			continue;
		}
		if (pythonIndent(line) <= parentIndent) {
			return undefined;
		}
		return i;
	}
	return undefined;
}

function pythonLineScore(lines: readonly string[], index: number, paths: ReadonlyMap<string, string>): number {
	const line = lines[index] ?? "";
	const trimmed = line.trim();
	if (isSkippablePythonLine(line) || PYTHON_DECORATOR_PATTERN.test(trimmed)) {
		return -1;
	}
	if (pythonFileOperation(line, paths)) {
		return 95;
	}
	if (pythonSubprocessCommand(line)) {
		return 90;
	}
	if (PYTHON_MAIN_PATTERN.test(line)) {
		return 70;
	}
	if (PYTHON_EFFECT_CALL_PATTERN.test(line)) {
		return 80;
	}
	if (PYTHON_CONTROL_PATTERN.test(line)) {
		const childIndex = firstPythonChildLine(lines, index);
		return childIndex === undefined ? 20 : Math.max(20, pythonLineScore(lines, childIndex, paths) - 5);
	}
	if (PYTHON_DEFINITION_PATTERN.test(line)) {
		return 50;
	}
	if (PYTHON_LOW_SIGNAL_ASSIGNMENT_CALL_PATTERN.test(line)) {
		return 25;
	}
	const printInnerCall = pythonPrintInnerCall(line);
	if (printInnerCall && !PYTHON_LOW_SIGNAL_CALL_PATTERN.test(printInnerCall)) {
		return 55;
	}
	if (PYTHON_ASSIGNMENT_CALL_PATTERN.test(line)) {
		return 60;
	}
	if (PYTHON_CALL_PATTERN.test(line) && !PYTHON_LOW_SIGNAL_CALL_PATTERN.test(line)) {
		return 65;
	}
	if (PYTHON_CALL_PATTERN.test(line)) {
		return 15;
	}
	return 30;
}

function pythonPreviewIndex(lines: readonly string[], index: number): number {
	const line = lines[index] ?? "";
	if (!PYTHON_CONTROL_PATTERN.test(line)) {
		return index;
	}
	const childIndex = firstPythonChildLine(lines, index);
	return childIndex === undefined ? index : pythonPreviewIndex(lines, childIndex);
}

const PYTHON_ESCAPES: Record<string, string> = {
	"\n": "", // backslash-newline is a line continuation
	'"': '"',
	"'": "'",
	"\\": "\\",
	n: "\n",
	r: "\r",
	t: "\t",
};

interface PythonStringScan {
	value: string;
	end: number;
	closed: boolean;
	/** A cooked escape (\x, \u, octal, \a…) whose value the preview does not compute. */
	unsupportedEscape: boolean;
}

// Walks a python string-literal body starting just after the opening delimiter.
// In both raw and cooked strings a backslash consumes the next char (python's
// raw-string rule: backslash-quote never closes the literal); only cooked
// strings unescape, and unknown escapes keep the backslash, matching python.
function scanPythonStringLiteral(code: string, start: number, quote: string, raw: boolean): PythonStringScan {
	let value = "";
	let i = start;
	let unsupportedEscape = false;
	while (i < code.length) {
		const char = code[i] ?? "";
		if (char === "\\" && i + 1 < code.length) {
			const next = code[i + 1] ?? "";
			if (!raw && /[xuUN0-7abfv]/.test(next)) {
				// \x41, \u…, octal, \a\b\f\v change the value; showing the source
				// form would preview a command that differs from what ran.
				unsupportedEscape = true;
			}
			value += raw ? char + next : (PYTHON_ESCAPES[next] ?? char + next);
			i += 2;
			continue;
		}
		if (code.startsWith(quote, i)) {
			return { value, end: i + quote.length, closed: true, unsupportedEscape };
		}
		if (quote.length === 1 && char === "\n") {
			break; // single-quoted literals cannot span lines
		}
		value += char;
		i += 1;
	}
	return { value, end: i, closed: false, unsupportedEscape };
}

// True when the lines end inside an unterminated triple-quoted string, meaning
// the following line is string text rather than code.
function endsInsideMultilineString(lines: readonly string[]): boolean {
	const text = lines.join("\n");
	let i = 0;
	while (i < text.length) {
		const char = text[i] ?? "";
		if (char === "#") {
			const newline = text.indexOf("\n", i);
			if (newline < 0) return false;
			i = newline + 1;
			continue;
		}
		if (char === '"' || char === "'") {
			const quote = text.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
			const scan = scanPythonStringLiteral(text, i + quote.length, quote, true);
			if (!scan.closed && scan.end >= text.length) {
				return quote.length === 3;
			}
			i = scan.end;
			continue;
		}
		i += 1;
	}
	return false;
}

function extractBashSkillCommand(code: string): string | undefined {
	const match = code.match(BASH_SKILL_CALL_PATTERN);
	const quote = match?.[1];
	if (!match || !quote) return undefined;
	const start = match[0].length;
	const prefixChar = match[0][start - quote.length - 1];
	const scan = scanPythonStringLiteral(code, start, quote, prefixChar === "r" || prefixChar === "R");
	if (!scan.closed || scan.unsupportedEscape) return undefined;
	const rest = code.slice(scan.end).trimStart();
	// Require a plain literal first argument; concatenation or other expressions fall back.
	if (!rest.startsWith(",") && !rest.startsWith(")")) return undefined;
	return scan.value;
}

export function previewPythonCode(code: string): CodePreview {
	const lines = code.split("\n");
	const paths = pythonPathVars(lines);
	let bestIndex: number | undefined;
	let bestScore = -1;

	for (let i = 0; i < lines.length; i++) {
		const score = pythonLineScore(lines, i, paths);
		if (score > bestScore) {
			bestIndex = i;
			bestScore = score;
		}
	}

	if (bestIndex !== undefined && bestScore >= 0) {
		const previewIndex = pythonPreviewIndex(lines, bestIndex);
		// The literal may span lines below the chosen one, so extract from the full tail.
		// A line inside a multiline string is text, not a bash-skill call: no bash ran.
		const bashCommand = endsInsideMultilineString(lines.slice(0, previewIndex))
			? undefined
			: extractBashSkillCommand(lines.slice(previewIndex).join("\n"));
		if (bashCommand) {
			return previewBashCommand(bashCommand);
		}
		return {
			language: "python",
			text: descriptor(pythonPreviewLine(lines, previewIndex, paths)),
		};
	}
	return { language: "python", text: "" };
}

export function previewIpythonCode(code: string): CodePreview {
	const trimmedCode = code.trimEnd();
	const bashCell = parseIpythonBashCell(trimmedCode);
	if (bashCell) {
		return previewBashCommand(bashCell.body);
	}
	return previewPythonCode(trimmedCode);
}
