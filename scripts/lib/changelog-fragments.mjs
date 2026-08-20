function normalizeFragment(text) {
	const trimmed = text.trim();
	return trimmed ? `${trimmed}\n` : "";
}

/**
 * Build the `[version] - date` section from pre-sorted fragments. Entries in
 * a stray [Unreleased] section (old-style PR merged post-cutover) are
 * absorbed first instead of being stranded.
 */
export function buildReleaseSection(changelogContent, fragments, version, date) {
	const unreleasedRe = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/;
	const match = changelogContent.match(unreleasedRe);
	if (!match && fragments.length === 0) {
		return { content: changelogContent, changed: false };
	}

	const parts = [];
	if (match && match[1].trim()) {
		parts.push(`${match[1].trim()}\n`);
	}
	for (const fragment of fragments) {
		const normalized = normalizeFragment(fragment.content);
		if (normalized) {
			parts.push(normalized);
		}
	}

	const header = `## [${version}] - ${date}`;
	const section = parts.length > 0 ? `${header}\n\n${parts.join("")}` : `${header}\n`;

	if (match) {
		return { content: changelogContent.replace(unreleasedRe, () => section), changed: true };
	}

	// No [Unreleased] header but fragments exist: insert the section after the title.
	const content = changelogContent.replace(/^(# Changelog\n\n)/, (title) => `${title}${section}\n`);
	return { content, changed: true };
}
