#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The single source of truth for the compiled release platform set.
// Every entry is a Bun compile target (`bun-<platform>`), an archive suffix
// (`prime-agent-<version>-<platform>.tar.gz`), and a value the installer can
// emit from `install.sh --native-platform`.
//
// Linux ships four x64 and two arm64 variants so that no Linux host falls back
// to the Node installation: glibc and musl each need their own build, and x64
// CPUs without AVX2 need Bun's baseline build. macOS needs no baseline variant
// because macOS 13 only runs on 2017-and-newer Macs, which all have AVX2.
export const releasePlatforms = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-arm64-musl",
	"linux-x64",
	"linux-x64-baseline",
	"linux-x64-musl",
	"linux-x64-musl-baseline",
];

// Platforms advertised in client-facing manifests (beta.json / latest.json).
// Pre-0.9.5 clients reject the entire binaries list when they encounter an
// unknown platform entry, so the manifest must stay limited to the four
// platforms every shipped client accepts.
export const manifestPlatforms = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
];

export const darwinReleasePlatforms = releasePlatforms.filter((platform) => platform.startsWith("darwin-"));

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	console.log(releasePlatforms.join("\n"));
}
