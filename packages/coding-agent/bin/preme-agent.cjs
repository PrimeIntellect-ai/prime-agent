#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const packageDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const sourceCli = path.join(packageDir, "src", "cli.ts");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const bundledCli = path.join(packageDir, "dist", "bundle", "cli.js");
const forwardedArgs = process.argv.slice(2);

let entrypoint;
let args;

if (existsSync(sourceCli) && existsSync(tsxCli)) {
  entrypoint = process.execPath;
  args = [tsxCli, sourceCli, ...forwardedArgs];
} else if (existsSync(bundledCli)) {
  entrypoint = process.execPath;
  args = [bundledCli, ...forwardedArgs];
} else {
  console.error("Preme Agent CLI entrypoint is unavailable. Reinstall the package or restore the local workspace dependencies.");
  process.exit(1);
}

const child = spawnSync(entrypoint, args, {
  stdio: "inherit",
  windowsHide: true,
  env: process.env,
});

if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}

if (child.signal) {
  process.kill(process.pid, child.signal);
}

process.exit(child.status ?? 1);
