export function withOpenCodeHeaders<T extends string | null>(
	provider: string,
	sessionId: string | undefined,
	headers: Record<string, T>,
): Record<string, T | string> {
	if (provider !== "opencode" && provider !== "opencode-go") return headers;

	const merged: Record<string, T | string> = { "User-Agent": "prime-agent" };
	if (sessionId) merged["x-opencode-session"] = sessionId;
	for (const [name, value] of Object.entries(headers)) {
		// Keep the SDK's User-Agent casing so Google's SDK replaces its default.
		const key = name.toLowerCase();
		merged[key === "user-agent" ? "User-Agent" : key] = value;
	}
	return merged;
}
