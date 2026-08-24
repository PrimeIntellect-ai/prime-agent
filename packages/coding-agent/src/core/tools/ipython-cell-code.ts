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
	return `_prime_agent_prev_cd = __import__("os").getcwd(); __import__("os").chdir(${targetExpression})`;
}

function rewriteCdMagic(target: string): string {
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

function rewriteEnvMagic(argument: string): string {
	if (!argument) {
		return 'print(dict(__import__("os").environ))';
	}
	// %env NAME=value and %env NAME value both assign; split on whichever separator comes first.
	const separator = [...argument].findIndex((char) => char === "=" || char === " " || char === "\t");
	if (separator <= 0) {
		return `print(__import__("os").environ[${JSON.stringify(argument)}])`;
	}
	const name = argument.slice(0, separator).trim();
	const value = argument.slice(separator + 1).trim();
	const valueExpression = value.startsWith("$") ? `str(${value.slice(1)})` : JSON.stringify(value);
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
