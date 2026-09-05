export function isTestTagEnabled(tag: string): boolean {
	return (process.env.PRIME_AGENT_TEST_TAGS ?? "")
		.split(",")
		.map((value) => value.trim())
		.includes(tag);
}
