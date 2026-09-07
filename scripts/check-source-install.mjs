import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const installer = readFileSync(join(root, "install.sh"), "utf8");
const powershell = readFileSync(join(root, "install.ps1"), "utf8");
for (const marker of ["https://github.com/JonusNattapong/preme-agent.git", "PREME_AGENT_SOURCE_DIR", "npm ci", "npm link", "preme-agent"]) {
	if (!installer.includes(marker) || !powershell.includes(marker)) {
		throw new Error(`source installer is missing ${marker}`);
	}
}

if (process.platform !== "win32") {
	const temp = mkdtempSync(join(tmpdir(), "preme-agent-source-install-"));
	try {
		const bin = join(temp, "bin");
		mkdirSync(bin);
		const fakeGit = join(bin, "git");
		const fakeNpm = join(bin, "npm");
		writeFileSync(fakeGit, `#!/bin/sh
target=""
for arg in "$@"; do target="$arg"; done
if [ "$1" = clone ]; then mkdir -p "$target/.git"; fi
exit 0
`);
		writeFileSync(fakeNpm, "#!/bin/sh\nexit 0\n");
		chmodSync(fakeGit, 0o755);
		chmodSync(fakeNpm, 0o755);
		const home = join(temp, "home");
		mkdirSync(home);
		const result = spawnSync("sh", [join(root, "install.sh")], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
		});
		if (result.status !== 0) throw new Error(`source installer smoke test failed\n${result.stdout}${result.stderr}`);
		if (!existsSync(join(home, ".preme-agent", ".git"))) throw new Error("source checkout was not created");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

console.log("Source installer smoke check passed.");
