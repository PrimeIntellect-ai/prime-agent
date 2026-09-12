#!/usr/bin/env node
const [value, ...extra] = process.argv.slice(2);

if (value === undefined || extra.length !== 0) {
	console.error("Expected exactly one GitHub API path segment.");
	process.exit(1);
}

// A Git ref can contain path separators and URI delimiters. GitHub's commits
// endpoint accepts it as one URL path segment only after percent encoding.
process.stdout.write(`${encodeURIComponent(value)}\n`);
