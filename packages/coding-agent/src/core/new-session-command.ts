export interface ParsedNewSessionCommand {
	name?: string;
	prompt?: string;
}

/** Parse /new's raw suffix while preserving the initial prompt verbatim. */
export function parseNewSessionCommand(rawArgs: string): ParsedNewSessionCommand {
	if (!rawArgs) return {};
	const args = consumeNewSeparator(rawArgs, "Expected whitespace after /new");
	if (!args.startsWith("-")) return { prompt: args };
	if (/^--(?:\s|$)/.test(args)) return { prompt: requireNewPrompt(args.slice(2)) };

	const option = args.match(/^\S+/)?.[0] ?? args;
	if (!/^--name(?:\s|$)/.test(args)) throw new Error(`Unknown /new option: ${option}`);
	let rest = consumeNewSeparator(args.slice(6), 'Missing value for /new option "--name"');
	if (/^--name(?:\s|$)/.test(rest)) throw new Error('Duplicate /new option: "--name"');
	if (!rest || rest.startsWith("-")) throw new Error('Missing value for /new option "--name"');

	let name: string;
	if (rest[0] === '"' || rest[0] === "'") {
		const quote = rest[0];
		const closingQuote = rest.indexOf(quote, 1);
		if (closingQuote === -1) throw new Error("Unterminated quote in /new --name");
		name = rest.slice(1, closingQuote);
		rest = rest.slice(closingQuote + 1);
	} else {
		const match = /^(\S+)([\s\S]*)$/.exec(rest)!;
		name = match[1];
		rest = match[2];
	}
	if (!name.trim()) throw new Error('/new option "--name" cannot be empty');
	if (!rest) return { name };
	rest = consumeNewSeparator(rest, 'Expected "--" before the /new prompt');
	if (/^--name(?:\s|$)/.test(rest)) throw new Error('Duplicate /new option: "--name"');
	if (!/^--(?:\s|$)/.test(rest)) {
		if (rest.startsWith("-")) throw new Error(`Unknown /new option: ${rest.match(/^\S+/)?.[0] ?? rest}`);
		throw new Error('Expected "--" before the /new prompt');
	}
	return { name, prompt: requireNewPrompt(rest.slice(2)) };
}

function consumeNewSeparator(value: string, error: string): string {
	let offset = /^[ \t]*/.exec(value)?.[0].length ?? 0;
	if (value.startsWith("\r\n", offset)) offset += 2;
	else if (value[offset] === "\n" || value[offset] === "\r") offset++;
	if (offset === 0) throw new Error(error);
	return value.slice(offset);
}

function requireNewPrompt(value: string): string {
	const prompt = consumeNewSeparator(value, 'Missing prompt after /new "--"');
	if (!prompt.trim()) throw new Error('Missing prompt after /new "--"');
	return prompt;
}
