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

const CD_LINE_MAGIC_PATTERN = /^%cd(?:[ \t]+(.*))?$/;
const ENV_LINE_MAGIC_PATTERN = /^%env(?:[ \t]+(.*))?$/;

/** Rewrite a `%%bash` cell body into a Python stanza with IPython's semantics: buffered output, raise on nonzero exit. */
function rewriteBashCell(body: string): string {
	return [
		`_prime_agent_bash = await bash(${JSON.stringify(body)})`,
		'print(_prime_agent_bash.output, end="")',
		"if _prime_agent_bash.exit_code != 0:",
		'    raise RuntimeError(f"bash exited with code {_prime_agent_bash.exit_code}")',
	].join("\n");
}

function rewriteLineMagic(line: string): string {
	const cd = CD_LINE_MAGIC_PATTERN.exec(line);
	if (cd) {
		const target = cd[1]?.trim();
		return target
			? `__import__("os").chdir(${JSON.stringify(target)})`
			: '__import__("os").chdir(__import__("os").path.expanduser("~"))';
	}
	const env = ENV_LINE_MAGIC_PATTERN.exec(line);
	if (env) {
		const argument = env[1]?.trim() ?? "";
		const separator = argument.indexOf("=");
		if (separator > 0) {
			const name = argument.slice(0, separator).trim();
			const value = argument.slice(separator + 1);
			return `__import__("os").environ[${JSON.stringify(name)}] = ${JSON.stringify(value)}`;
		}
		if (argument) {
			return `print(__import__("os").environ[${JSON.stringify(argument)}])`;
		}
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
