#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { darwinReleasePlatforms } from "./release-platforms.mjs";

const runnerByPlatform = {
	"darwin-arm64": "macos-15",
	"darwin-x64": "macos-15-intel",
};

export function resolveMacosValidationMatrix(publishProduction, publishBeta) {
	if (typeof publishProduction !== "boolean" || typeof publishBeta !== "boolean") {
		throw new Error("Release channel flags must be booleans");
	}
	const channels = [];
	if (publishProduction) channels.push("production");
	if (publishBeta) channels.push("beta");
	if (channels.length === 0) throw new Error("At least one release channel must be enabled");

	return {
		include: channels.flatMap((channel) =>
			darwinReleasePlatforms.map((platform) => {
				const runner = runnerByPlatform[platform];
				if (!runner) throw new Error(`No macOS validation runner configured for ${platform}`);
				return { channel, platform, runner };
			}),
		),
	};
}

function parseFlag(value, name) {
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} must be true or false`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [production, beta, ...extra] = process.argv.slice(2);
	if (production === undefined || beta === undefined || extra.length) {
		throw new Error("Usage: node release-macos-validation-matrix.mjs <publish-production> <publish-beta>");
	}
	console.log(JSON.stringify(resolveMacosValidationMatrix(parseFlag(production, "publish-production"), parseFlag(beta, "publish-beta"))));
}
