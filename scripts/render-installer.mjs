#!/usr/bin/env node
/**
 * Renders install.sh for a release and records its digest.
 *
 * The installer used to be rendered inside the credential-bearing publish job,
 * straight out of a working-tree checkout. It is now rendered in the `assemble`
 * job, appended to SHA256SUMS (so the cosign signature over SHA256SUMS covers
 * it) and shipped as a release asset, so the bytes served from R2 are the bytes
 * GitHub recorded a digest for.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const BASE_URL_PLACEHOLDER = "__PRIME_AGENT_DOWNLOAD_BASE_URL__";
const CHANNEL_PLACEHOLDER = "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__";

export const INSTALLER_TARGETS = [
	{ channel: "stable", name: "install.sh" },
	{ channel: "beta", name: "install-beta.sh" },
];

export function renderInstaller(source, baseUrl, channel) {
	if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
		throw new Error(`Installer base URL must be an absolute http(s) URL: ${baseUrl}`);
	}
	if (channel !== "stable" && channel !== "beta") {
		throw new Error(`Unknown release channel: ${channel}`);
	}
	const rendered = source.replaceAll(BASE_URL_PLACEHOLDER, baseUrl.replace(/\/$/, "")).replaceAll(CHANNEL_PLACEHOLDER, channel);
	if (rendered.includes(BASE_URL_PLACEHOLDER) || rendered.includes(CHANNEL_PLACEHOLDER)) {
		throw new Error("Rendered installer still contains a placeholder");
	}
	if (rendered === source) {
		throw new Error("Installer source contained no placeholders; refusing to publish it");
	}
	return rendered;
}

export function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

function parseArgs(argv) {
	const args = { installer: "install.sh", sums: "" };
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (value === undefined) throw new Error(`Missing value for ${key}`);
		if (key === "--installer") args.installer = value;
		else if (key === "--base-url") args.baseUrl = value;
		else if (key === "--out-dir") args.outDir = value;
		else if (key === "--sums") args.sums = value;
		else throw new Error(`Unknown argument ${key}`);
	}
	if (!args.baseUrl) throw new Error("--base-url is required");
	if (!args.outDir) throw new Error("--out-dir is required");
	return args;
}

export function main(argv) {
	const args = parseArgs(argv);
	const source = readFileSync(args.installer, "utf8");
	mkdirSync(args.outDir, { recursive: true });
	const written = [];
	for (const target of INSTALLER_TARGETS) {
		const rendered = renderInstaller(source, args.baseUrl, target.channel);
		const outPath = join(args.outDir, target.name);
		writeFileSync(outPath, rendered, { mode: 0o755 });
		const digest = sha256(rendered);
		written.push({ name: target.name, digest });
		if (args.sums) {
			appendFileSync(args.sums, `${digest}  ${basename(outPath)}\n`);
		}
		console.log(`${digest}  ${target.name}`);
	}
	return written;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	main(process.argv.slice(2));
}
