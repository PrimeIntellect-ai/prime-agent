#!/usr/bin/env bun

interface Shard {
	index: number;
	total: number;
}

function parseShard(args: string[]): { shard?: Shard; forwarded: string[] } {
	let shard: Shard | undefined;
	const forwarded: string[] = [];
	for (const arg of args) {
		if (!arg.startsWith("--shard=")) {
			forwarded.push(arg);
			continue;
		}
		const match = arg.slice("--shard=".length).match(/^(\d+)\/(\d+)$/);
		if (!match) throw new Error(`Invalid shard: ${arg}`);
		const index = Number(match[1]);
		const total = Number(match[2]);
		if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) {
			throw new Error(`Invalid shard: ${arg}`);
		}
		shard = { index, total };
	}
	return { shard, forwarded };
}

const excluded = new Set(["test/compiled-artifact-smoke.test.ts", "test/daemon-supervisor-process.test.ts"]);
const { shard, forwarded } = parseShard(process.argv.slice(2));
const discovered: string[] = [];
for await (const file of new Bun.Glob("test/**/*.test.ts").scan({ cwd: process.cwd(), onlyFiles: true })) {
	if (!excluded.has(file)) discovered.push(file);
}
discovered.sort();
const selected = shard
	? discovered.filter((_file, position) => position % shard.total === shard.index - 1)
	: discovered;

console.log(
	`Running ${selected.length}/${discovered.length} coding-agent test files${shard ? ` (shard ${shard.index}/${shard.total})` : ""}`,
);

const failures: Array<{ file: string; exitCode: number }> = [];
for (const file of selected) {
	const child = Bun.spawn([process.execPath, "test", "--isolate", "--timeout", "30000", ...forwarded, file], {
		cwd: process.cwd(),
		env: process.env,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) failures.push({ file, exitCode });
}

if (failures.length > 0) {
	console.error(`Failed coding-agent test files (${failures.length}/${selected.length}):`);
	for (const failure of failures) console.error(`- ${failure.file} (exit ${failure.exitCode})`);
	process.exit(1);
}
console.log(`Passed ${selected.length} coding-agent test files.`);
