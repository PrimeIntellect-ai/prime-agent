import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const source = readFileSync("install.ps1", "utf8");
const baseMarker = "__PRIME_AGENT_DOWNLOAD_BASE_URL__";
const channelMarker = "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__";

for (const channel of ["stable", "beta"]) {
	const rendered = source.replaceAll(baseMarker, "https://releases.example.test").replaceAll(channelMarker, channel);
	if (rendered.includes(baseMarker) || rendered.includes(channelMarker)) {
		throw new Error(`PowerShell installer has unresolved markers for ${channel}`);
	}
	if (!rendered.includes(`$DefaultChannel = "${channel}"`)) {
		throw new Error(`PowerShell installer did not render the ${channel} channel`);
	}
}

const parserCommand = [
	"$allErrors = @()",
	"foreach ($path in @('install.ps1', 'scripts/test-windows-installer.ps1')) {",
	"$tokens = $null",
	"$errors = $null",
	"[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $path), [ref]$tokens, [ref]$errors) | Out-Null",
	"$allErrors += $errors",
	"}",
	"if ($allErrors.Count -gt 0) { $allErrors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
].join("; ");
const parser = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", parserCommand], {
	encoding: "utf8",
});
if (parser.error && (parser.error).code !== "ENOENT") {
	throw parser.error;
}
if (!parser.error && parser.status !== 0) {
	throw new Error(`PowerShell installer parse failed:
${parser.stderr}${parser.stdout}`);
}

console.log(parser.error ? "PowerShell installer markers passed; pwsh parser unavailable." : "PowerShell installer check passed.");
