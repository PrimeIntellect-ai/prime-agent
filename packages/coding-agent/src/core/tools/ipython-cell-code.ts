const BASH_CELL_MAGIC_PATTERN = /^((?:[ \t]*\r?\n)*)([ \t]*)%%bash\b([^\r\n]*)(\r?\n|$)/;

export interface ParsedIpythonBashCell {
	leadingWhitespace: string;
	indent: string;
	magicArguments: string;
	lineBreak: string;
	body: string;
}

export function parseIpythonBashCell(code: string): ParsedIpythonBashCell | undefined {
	const match = BASH_CELL_MAGIC_PATTERN.exec(code);
	if (!match) {
		return undefined;
	}
	return {
		leadingWhitespace: match[1] ?? "",
		indent: match[2] ?? "",
		magicArguments: match[3] ?? "",
		lineBreak: match[4] ?? "",
		body: code.slice(match[0].length),
	};
}

// Single separator char + [\s\S]* keeps these linear-time (no ambiguous [ \t]+/. split points); callers trim the capture.
const CD_LINE_MAGIC_PATTERN = /^%cd(?:[ \t]([\s\S]*))?$/;
const ENV_LINE_MAGIC_PATTERN = /^%env(?:[ \t]([\s\S]*))?$/;

/** Rewrite a `%%bash` cell body into a Python stanza with IPython's semantics: buffered output, raise on nonzero exit. */
function rewriteBashCell(body: string): string {
	return [
		`_prime_agent_bash = await bash(${JSON.stringify(body)})`,
		'print(_prime_agent_bash.output, end="")',
		"if _prime_agent_bash.exit_code != 0:",
		'    raise RuntimeError(f"bash exited with code {_prime_agent_bash.exit_code}")',
	].join("\n");
}

const CD_NO_PREVIOUS_ERROR = "No previous directory to change to";

function rewriteChdir(targetExpression: string): string {
	// IPython's %cd echoes the new working directory after changing into it.
	return `_prime_agent_prev_cd = __import__("os").getcwd(); __import__("os").chdir(${targetExpression}); print(__import__("os").getcwd())`;
}

function rewriteCdMagic(rawTarget: string): string {
	// Strip one pair of matching outer quotes, as IPython does for %cd 'dir with spaces'.
	const target = rawTarget.replace(/^(['"])(.*)\1$/, "$2");
	if (target === "-") {
		return [
			'_prime_agent_cd_target = globals().get("_prime_agent_prev_cd")',
			`if _prime_agent_cd_target is None: raise RuntimeError(${JSON.stringify(CD_NO_PREVIOUS_ERROR)})`,
			rewriteChdir("_prime_agent_cd_target"),
		].join("\n");
	}
	const expression = target ? JSON.stringify(target) : '"~"';
	return rewriteChdir(`__import__("os").path.expanduser(${expression})`);
}

const ENV_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;
const ENV_FULL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Escape a literal character for inclusion inside a double-quoted Python f-string. */
function escapeFStringLiteralChar(char: string): string {
	if (char === "\\") return "\\\\";
	if (char === '"') return '\\"';
	if (char === "{") return "{{";
	if (char === "}") return "}}";
	const code = char.charCodeAt(0);
	if (code <= 0x1f) {
		if (char === "\n") return "\\n";
		if (char === "\r") return "\\r";
		if (char === "\t") return "\\t";
		return `\\x${code.toString(16).padStart(2, "0")}`;
	}
	return char;
}

/** Translate IPython's $var / ${var} / $$ substitution in a %env value into a Python f-string literal. */
function pythonFStringFromEnvValue(value: string): string {
	let source = "";
	let index = 0;
	while (index < value.length) {
		const char = value.charAt(index);
		if (char === "$") {
			if (value.charAt(index + 1) === "$") {
				source += "$";
				index += 2;
				continue;
			}
			if (value.charAt(index + 1) === "{") {
				const close = value.indexOf("}", index + 2);
				const contents = close > index + 2 ? value.slice(index + 2, close) : "";
				if (ENV_FULL_IDENTIFIER_PATTERN.test(contents)) {
					source += `{${contents}}`;
					index = close + 1;
					continue;
				}
			}
			const identifier = ENV_IDENTIFIER_PATTERN.exec(value.slice(index + 1));
			if (identifier) {
				source += `{${identifier[0]}}`;
				index += 1 + identifier[0].length;
				continue;
			}
			source += "$";
			index += 1;
			continue;
		}
		source += escapeFStringLiteralChar(char);
		index += 1;
	}
	return `f"${source}"`;
}

// Like IPython's bare %env, hide values whose variable name looks like a credential.
const ENV_LISTING_CODE =
	'print({k: ("[REDACTED]" if any(marker in k.lower() for marker in ("key", "token", "secret")) else v) for k, v in __import__("os").environ.items()})';

function rewriteEnvMagic(argument: string): string {
	if (!argument) {
		return ENV_LISTING_CODE;
	}
	// %env NAME=value and %env NAME value both assign. Like IPython, prefer the first '='
	// (so `%env FOO = bar` sets "bar"), but if that leaves whitespace inside the name
	// (`%env FOO bar=baz`), split on whitespace instead and keep the '=' in the value.
	let separator = argument.indexOf("=");
	if (separator > 0 && /\s/.test(argument.slice(0, separator).trim())) separator = -1;
	if (separator === -1) separator = argument.search(/[ \t]/);
	if (separator <= 0) {
		return `print(__import__("os").environ[${JSON.stringify(argument)}])`;
	}
	const name = argument.slice(0, separator).trim();
	const value = argument.slice(separator + 1).trim();
	const valueExpression = value.includes("$") ? pythonFStringFromEnvValue(value) : JSON.stringify(value);
	return `__import__("os").environ[${JSON.stringify(name)}] = ${valueExpression}`;
}

function rewriteLineMagic(line: string): string {
	const magicLine = line.endsWith("\r") ? line.slice(0, -1) : line;
	const cd = CD_LINE_MAGIC_PATTERN.exec(magicLine);
	if (cd) {
		return rewriteCdMagic(cd[1]?.trim() ?? "");
	}
	const env = ENV_LINE_MAGIC_PATTERN.exec(magicLine);
	if (env) {
		return rewriteEnvMagic(env[1]?.trim() ?? "");
	}
	return line;
}

/**
 * Rewrite `%%bash` cells and column-0 `%cd`/`%env` line magics into plain
 * Python. `%%bash` magic arguments are dropped: the runtime's `bash()` reads
 * the shell path and command prefix from `PRIME_AGENT_BASH_SHELL` /
 * `PRIME_AGENT_BASH_COMMAND_PREFIX`. Everything else passes through untouched.
 */
export function rewriteCellMagics(code: string): string {
	const bashCell = parseIpythonBashCell(code);
	if (bashCell) {
		return `${bashCell.leadingWhitespace}${rewriteBashCell(bashCell.body)}`;
	}
	if (!code.includes("%cd") && !code.includes("%env")) return code;
	return code
		.split("\n")
		.map((line) => (line.startsWith("%") ? rewriteLineMagic(line) : line))
		.join("\n");
}
