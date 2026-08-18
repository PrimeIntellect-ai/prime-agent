const DISPLAY_ID_LENGTH = 12;
const HEX_ID_PATTERN = /^[0-9a-f]+$/;

export function formatSessionDisplayId(id: string): string {
	const normalized = normalizeHexSessionId(id);
	if (!normalized) {
		return id.length > DISPLAY_ID_LENGTH ? id.slice(-DISPLAY_ID_LENGTH) : id;
	}
	return normalized.length > DISPLAY_ID_LENGTH ? normalized.slice(-DISPLAY_ID_LENGTH) : normalized;
}

export function matchesSessionIdSuffix(candidate: string, suffix: string): boolean {
	const normalizedCandidate = normalizeHexSessionId(candidate);
	const normalizedSuffix = normalizeHexSessionId(suffix);
	return !!normalizedCandidate && !!normalizedSuffix && normalizedCandidate.endsWith(normalizedSuffix);
}

export function matchesSavedSessionSelector(candidate: string, selector: string): boolean {
	const normalizedCandidate = normalizeHexSessionId(candidate);
	const normalizedSelector = normalizeHexSessionId(selector);
	if (normalizedCandidate && normalizedSelector) {
		return normalizedCandidate.startsWith(normalizedSelector) || normalizedCandidate.endsWith(normalizedSelector);
	}
	return candidate.startsWith(selector);
}

export function normalizeSessionId(id: string): string {
	return id.replaceAll("-", "").toLowerCase();
}

function normalizeHexSessionId(id: string): string | undefined {
	const normalized = normalizeSessionId(id);
	return normalized && HEX_ID_PATTERN.test(normalized) ? normalized : undefined;
}
