export function requireOptionValue(value: string | undefined, flag: string, description = "a value"): string {
	if (value === undefined || value.trim().length === 0 || value.startsWith("-")) {
		throw new Error(`${flag} requires ${description}`);
	}
	return value;
}
