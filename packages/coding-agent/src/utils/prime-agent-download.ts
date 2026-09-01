export const DEFAULT_PRIME_AGENT_DOWNLOAD_BASE_URL = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";

export function getPrimeAgentDownloadBaseUrl(): string {
	return (process.env.PRIME_AGENT_DOWNLOAD_BASE_URL?.trim() || DEFAULT_PRIME_AGENT_DOWNLOAD_BASE_URL).replace(
		/\/+$/,
		"",
	);
}
