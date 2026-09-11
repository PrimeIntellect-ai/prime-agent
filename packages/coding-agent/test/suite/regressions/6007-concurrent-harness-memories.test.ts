import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyRefinementProposal,
	getHarnessStatePath,
	loadHarnessState,
	type RefinementProposal,
	saveHarnessState,
} from "../../../src/core/refinement/refinement.js";
import { createHarness, type Harness } from "../harness.js";

function proposal(id: string): RefinementProposal {
	return {
		summary: id,
		rationale: "Synthetic concurrent writer regression",
		expectedOutcome: "All accepted entries survive",
		edits: [{ action: "create", kind: "memory", id, title: id, content: id }],
	};
}

function createHostMemory(dir: string, id: string): void {
	const state = loadHarnessState(dir, "local");
	applyRefinementProposal(state, proposal(id), { id, scope: "local" });
	saveHarnessState(dir, state);
}

function pythonWriter(dir: string, id: string, paused: boolean | "save" = false, action = "create") {
	const ready = join(dir, `${id}.ready`);
	const release = join(dir, `${id}.release`);
	const child = spawn(
		process.env.PYTHON ?? "python3",
		[
			"-c",
			`import json, sys, time
from pathlib import Path
from rlm.harness import HarnessState
path, entry_id, ready, release, paused, action = sys.argv[1:]
state = HarnessState(path)
original_sync = state._sync_from_disk
def barrier():
    Path(ready).write_text("ready")
    deadline = time.monotonic() + 15
    while not Path(release).exists():
        if time.monotonic() > deadline:
            raise TimeoutError("Python writer barrier expired")
        time.sleep(0.01)
def barrier_sync():
    original_sync()
    barrier()
if paused == "true":
    state._sync_from_disk = barrier_sync
elif paused == "save":
    original_dump = json.dump
    def barrier_dump(*args, **kwargs):
        barrier()
        return original_dump(*args, **kwargs)
    json.dump = barrier_dump
if action == "update":
    state.update_memory(entry_id, entry_id, "python update")
elif action == "delete":
    state.delete_memory(entry_id)
elif action == "schema":
    state._sync_from_disk()
    state.schema = 3
    state.save()
elif action == "refine":
    state.record_refinement(entry_id, [entry_id])
elif action == "invalid-schema":
    state.schema = float(entry_id)
    state.save()
else:
    state.create_memory(entry_id, entry_id, id=entry_id)
print("accepted", flush=True)
`,
			getHarnessStatePath(dir),
			id,
			ready,
			release,
			String(paused),
			action,
		],
		{
			env: { ...process.env, PYTHONPATH: resolve("../../prime-agent-runtime/src") },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (data: Buffer) => {
		stdout += data.toString();
	});
	child.stderr.on("data", (data: Buffer) => {
		stderr += data.toString();
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
	return {
		done,
		async waitReady() {
			const deadline = Date.now() + 10_000;
			while (!existsSync(ready)) {
				if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Python not ready: ${stderr}`);
				await delay(10);
			}
		},
		release: () => writeFileSync(release, "release"),
		async cleanup() {
			if (child.exitCode === null) child.kill("SIGKILL");
			await done;
		},
	};
}

describe("concurrent harness memory persistence", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("preserves a refinement accepted after Python's final reload, plus sequential writes", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("Prepare a synthetic memory fixture");
		const dir = join(harness.sessionManager.getSessionArtifactDir()!, "harness");
		createHostMemory(dir, "seed-entry");
		const python = pythonWriter(dir, "python-entry", true);
		try {
			await python.waitReady();
			harness.setResponses([fauxAssistantMessage(JSON.stringify(proposal("host-entry")))]);
			const result = await harness.session.refine();
			expect(result.appliedEdits[0].applied).toBe(true);
			expect(Object.keys(loadHarnessState(dir).entries.memory).sort()).toEqual(["host-entry", "seed-entry"]);
			python.release();
			expect(await python.done).toEqual({ code: 0, stdout: "accepted\n", stderr: "" });
			createHostMemory(dir, "serial-host-entry");
			const serial = pythonWriter(dir, "serial-entry");
			try {
				expect((await serial.done).code).toBe(0);
			} finally {
				await serial.cleanup();
			}
			expect(Object.keys(loadHarnessState(dir).entries.memory).sort()).toEqual([
				"host-entry",
				"python-entry",
				"seed-entry",
				"serial-entry",
				"serial-host-entry",
			]);
			expect(loadHarnessState(dir).refinements.some((event) => event.id === result.id)).toBe(true);
		} finally {
			await python.cleanup();
		}
	});

	it("preserves Python writes accepted after the host loaded its snapshot", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dir = join(harness.tempDir, "harness");
		mkdirSync(dir);
		createHostMemory(dir, "seed-entry");
		const stale = loadHarnessState(dir, "local");
		applyRefinementProposal(stale, proposal("host-entry"), { id: "host-refine", scope: "local" });
		const python = pythonWriter(dir, "python-entry");
		try {
			expect((await python.done).code).toBe(0);
		} finally {
			await python.cleanup();
		}
		saveHarnessState(dir, stale);
		expect(Object.keys(loadHarnessState(dir).entries.memory).sort()).toEqual([
			"host-entry",
			"python-entry",
			"seed-entry",
		]);
	});

	it("preserves two Python writers starting from the same absent file", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dir = join(harness.tempDir, "harness");
		mkdirSync(dir);
		const writers = [pythonWriter(dir, "one", true), pythonWriter(dir, "two", true)];
		try {
			await Promise.all(writers.map((writer) => writer.waitReady()));
			for (const writer of writers) writer.release();
			for (const result of await Promise.all(writers.map((writer) => writer.done))) expect(result.code).toBe(0);
			expect(Object.keys(loadHarnessState(dir).entries.memory).sort()).toEqual(["one", "two"]);
		} finally {
			await Promise.all(writers.map((writer) => writer.cleanup()));
		}
	});

	it.each(["Python", "host"])("refuses an unsupported schema change from the %s writer", async (writer) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dir = join(harness.tempDir, "harness");
		createHostMemory(dir, "seed-entry");
		const statePath = getHarnessStatePath(dir);
		const accepted = readFileSync(statePath, "utf8");
		if (writer === "host") {
			const host = loadHarnessState(dir, "local");
			host.schema = 2;
			expect(() => saveHarnessState(dir, host)).toThrow("supports schema 1");
		} else {
			const python = pythonWriter(dir, "schema-change", false, "schema");
			try {
				const result = await python.done;
				expect(result.code).toBe(1);
				expect(result.stderr).toContain("supports schema 1");
			} finally {
				await python.cleanup();
			}
		}
		expect(readFileSync(statePath, "utf8")).toBe(accepted);
		expect(existsSync(`${statePath}.lock`)).toBe(false);
		createHostMemory(dir, "after-rejection");
	});

	it("assigns distinct default IDs to concurrent Python refinements", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dir = join(harness.tempDir, "harness");
		mkdirSync(dir);
		const writers = [pythonWriter(dir, "one", true, "refine"), pythonWriter(dir, "two", true, "refine")];
		try {
			await Promise.all(writers.map((writer) => writer.waitReady()));
			for (const writer of writers) writer.release();
			for (const result of await Promise.all(writers.map((writer) => writer.done))) expect(result.code).toBe(0);
			const events = loadHarnessState(dir).refinements;
			expect(events.map((event) => event.trigger).sort()).toEqual(["one", "two"]);
			expect(new Set(events.map((event) => event.id)).size).toBe(2);
		} finally {
			await Promise.all(writers.map((writer) => writer.cleanup()));
		}
	});

	it.each(["nan", "inf", "-inf"])("rejects Python schema %s without corrupting accepted state", async (schema) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dir = join(harness.tempDir, "harness");
		createHostMemory(dir, "seed-entry");
		const accepted = loadHarnessState(dir);
		const python = pythonWriter(dir, schema, false, "invalid-schema");
		try {
			const result = await python.done;
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("not overwritten");
			expect(loadHarnessState(dir)).toEqual(accepted);
			expect(existsSync(`${getHarnessStatePath(dir)}.lock`)).toBe(false);
			createHostMemory(dir, "after-rejection");
			expect(Object.keys(loadHarnessState(dir).entries.memory).sort()).toEqual(["after-rejection", "seed-entry"]);
		} finally {
			await python.cleanup();
		}
	});

	for (const schema of ["NaN", "Infinity", "-Infinity", "1e400", "null", '"1"', "true"]) {
		it.each(["Python", "host"])(
			`refuses to overwrite a harness containing invalid schema ${schema} from the %s writer`,
			async (writer) => {
				const harness = await createHarness();
				harnesses.push(harness);
				const dir = join(harness.tempDir, "harness");
				createHostMemory(dir, "seed-entry");
				const state = loadHarnessState(dir);
				const statePath = getHarnessStatePath(dir);
				const corrupted = JSON.stringify(state).replace('"schema":1', `"schema":${schema}`);
				writeFileSync(statePath, corrupted);
				if (writer === "host") {
					const host = loadHarnessState(dir, "local");
					applyRefinementProposal(host, proposal("host-entry"), { id: "host-refine", scope: "local" });
					expect(() => saveHarnessState(dir, host)).toThrow("invalid or unreadable");
				} else {
					const python = pythonWriter(dir, "python-entry");
					try {
						const result = await python.done;
						expect(result.code).toBe(1);
						expect(result.stderr).toContain("invalid or unreadable");
					} finally {
						await python.cleanup();
					}
				}
				expect(readFileSync(statePath, "utf8")).toBe(corrupted);
				expect(existsSync(`${statePath}.lock`)).toBe(false);
			},
		);
	}

	it.each(["metadata", "reference", "arguments"] as const)(
		"refuses to overwrite non-finite persisted %s values during Python mutations",
		async (field) => {
			for (const value of ["NaN", "Infinity", "-Infinity", "1e400"]) {
				for (const action of ["create", "update", "delete"]) {
					const harness = await createHarness();
					harnesses.push(harness);
					const dir = join(harness.tempDir, "harness");
					createHostMemory(dir, "seed-entry");
					if (action !== "create") createHostMemory(dir, "target-entry");
					const state = loadHarnessState(dir);
					state.entries.memory["seed-entry"][field] = { invalid: "__NON_FINITE__", valid: "preserved" };
					const statePath = getHarnessStatePath(dir);
					const corrupted = JSON.stringify(state).replace('"__NON_FINITE__"', value);
					writeFileSync(statePath, corrupted);
					const python = pythonWriter(dir, "target-entry", false, action);
					try {
						const result = await python.done;
						expect(result.code, `${field} ${value} ${action}: ${result.stderr}`).toBe(1);
						expect(result.stderr).toContain("invalid or unreadable");
						expect(readFileSync(statePath, "utf8")).toBe(corrupted);
					} finally {
						await python.cleanup();
					}
				}
			}
		},
	);

	it.each(["Python", "host"])(
		"refuses to overwrite malformed schema-1 entry data from the %s writer",
		async (writer) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const dir = join(harness.tempDir, "harness");
			createHostMemory(dir, "seed-entry");
			const statePath = getHarnessStatePath(dir);
			const malformed = JSON.parse(readFileSync(statePath, "utf8"));
			malformed.entries.memory.foo = 42;
			const malformedRaw = `${JSON.stringify(malformed, null, 2)}\n`;
			writeFileSync(statePath, malformedRaw);
			if (writer === "host") {
				const host = loadHarnessState(dir, "local");
				applyRefinementProposal(host, proposal("host-entry"), { id: "host-refine", scope: "local" });
				expect(() => saveHarnessState(dir, host)).toThrow("invalid or unreadable");
			} else {
				const python = pythonWriter(dir, "python-entry");
				try {
					const result = await python.done;
					expect(result.code).toBe(1);
					expect(result.stderr).toContain("invalid or unreadable");
				} finally {
					await python.cleanup();
				}
			}
			expect(loadHarnessState(dir, "local").entries.memory["seed-entry"].content).toBe("seed-entry");
			expect(readFileSync(statePath, "utf8")).toBe(malformedRaw);
			expect(existsSync(`${statePath}.lock`)).toBe(false);
		},
	);

	it.each([
		["Python", "reset"],
		["Python", "rewrite"],
		["host", "reset"],
		["host", "rewrite"],
	])("rejects an appended %s refinement after an accepted history %s", async (writer, change) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dir = join(harness.tempDir, "harness");
		createHostMemory(dir, "seed-entry");
		const stale = loadHarnessState(dir, "local");
		applyRefinementProposal(stale, proposal("pending-entry"), { id: "pending-event", scope: "local" });
		const python = writer === "Python" ? pythonWriter(dir, "pending-event", true, "refine") : undefined;
		try {
			await python?.waitReady();
			const current = loadHarnessState(dir, "local");
			if (change === "reset") current.refinements = [];
			else current.refinements[0].outcome = "accepted replacement";
			saveHarnessState(dir, current);
			if (python) {
				python.release();
				const result = await python.done;
				expect(result.code).toBe(1);
				expect(result.stderr).toContain("Harness refinement history changed before save");
			} else {
				expect(() => saveHarnessState(dir, stale)).toThrow("Harness refinement history changed before save");
			}
			const state = loadHarnessState(dir);
			expect(state.refinements).toEqual(current.refinements);
			expect(Object.keys(state.entries.memory)).toEqual(["seed-entry"]);
			expect(existsSync(`${getHarnessStatePath(dir)}.lock`)).toBe(false);
		} finally {
			await python?.cleanup();
		}
	});

	it.each(["Python", "host"])("preserves a history reset during an unrelated %s memory save", async (writer) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dir = join(harness.tempDir, "harness");
		createHostMemory(dir, "seed-entry");
		const stale = loadHarnessState(dir, "local");
		stale.entries.memory["seed-entry"].content = "updated memory";
		const python = writer === "Python" ? pythonWriter(dir, "python-entry", true) : undefined;
		try {
			await python?.waitReady();
			const current = loadHarnessState(dir, "local");
			current.refinements = [];
			saveHarnessState(dir, current);
			if (python) {
				python.release();
				expect((await python.done).code).toBe(0);
			} else {
				saveHarnessState(dir, stale);
			}
			const state = loadHarnessState(dir);
			expect(state.refinements).toEqual([]);
			if (python) expect(state.entries.memory["python-entry"].content).toBe("python-entry");
			else expect(state.entries.memory["seed-entry"].content).toBe("updated memory");
		} finally {
			await python?.cleanup();
		}
	});

	it.each(["Python", "host"])(
		"refuses to rewrite unsupported future schema data from the %s writer",
		async (writer) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const dir = join(harness.tempDir, "harness");
			createHostMemory(dir, "seed-entry");
			const statePath = getHarnessStatePath(dir);
			const current = loadHarnessState(dir, "local");
			const futureState = {
				...current,
				schema: 2,
				future_top: { preserved: true },
				entries: {
					...current.entries,
					memory: {
						...current.entries.memory,
						"seed-entry": { ...current.entries.memory["seed-entry"], future_entry_field: "preserved" },
					},
					futurekind: { future: { preserved: true } },
				},
			};
			const futureRaw = `${JSON.stringify(futureState, null, 2)}\n`;
			writeFileSync(statePath, futureRaw);
			if (writer === "host") {
				const host = loadHarnessState(dir, "local");
				applyRefinementProposal(host, proposal("host-entry"), { id: "host-refine", scope: "local" });
				expect(() => saveHarnessState(dir, host)).toThrow("Unsupported harness schema 2");
			} else {
				const python = pythonWriter(dir, "python-entry");
				try {
					const result = await python.done;
					expect(result.code).toBe(1);
					expect(result.stderr).toContain("Unsupported harness schema 2");
				} finally {
					await python.cleanup();
				}
			}
			expect(readFileSync(statePath, "utf8")).toBe(futureRaw);
			const readable = loadHarnessState(dir, "local");
			expect(readable.schema).toBe(2);
			expect(readable.entries.memory["seed-entry"].content).toBe("seed-entry");
			expect(existsSync(`${statePath}.lock`)).toBe(false);
		},
	);

	it("waits for Python's lock before the host reads and merges its save", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dir = join(harness.tempDir, "harness");
		createHostMemory(dir, "seed-entry");
		const python = pythonWriter(dir, "python-entry", "save");
		const attempted = join(dir, "host-attempted");
		const modulePath = resolve("src/core/refinement/refinement.ts");
		let stopHost: (() => Promise<void>) | undefined;
		try {
			await python.waitReady();
			const host = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					"--input-type=module",
					"-e",
					`
import { writeFileSync } from "node:fs";
import { loadHarnessState, applyRefinementProposal, saveHarnessState } from ${JSON.stringify(modulePath)};
const dir = ${JSON.stringify(dir)};
const state = loadHarnessState(dir, "local");
applyRefinementProposal(state, ${JSON.stringify(proposal("host-entry"))}, { id: "host-refine" });
writeFileSync(${JSON.stringify(attempted)}, "attempted");
saveHarnessState(dir, state);
`,
				],
				{ cwd: resolve("../.."), stdio: ["ignore", "ignore", "pipe"] },
			);
			let stderr = "";
			let closed = false;
			host.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
			const timer = setTimeout(() => host.kill("SIGKILL"), 20_000);
			const done = new Promise<number | null>((resolve, reject) => {
				host.once("error", reject);
				host.once("close", (code) => {
					clearTimeout(timer);
					closed = true;
					resolve(code);
				});
			});
			stopHost = async () => {
				if (!closed) host.kill("SIGKILL");
				await done;
			};
			const deadline = Date.now() + 10_000;
			while (!existsSync(attempted)) {
				if (closed || Date.now() > deadline) throw new Error(`Host not ready: ${stderr}`);
				await delay(10);
			}
			await delay(100);
			expect(closed).toBe(false);
			expect(Object.keys(loadHarnessState(dir).entries.memory)).toEqual(["seed-entry"]);
			python.release();
			expect((await python.done).code).toBe(0);
			expect(await done, stderr).toBe(0);
			expect(Object.keys(loadHarnessState(dir).entries.memory).sort()).toEqual([
				"host-entry",
				"python-entry",
				"seed-entry",
			]);
		} finally {
			await python.cleanup();
			await stopHost?.();
		}
	});

	it("merges host snapshots without resurrecting a deletion or reverting an unrelated update", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dir = join(harness.tempDir, "harness");
		createHostMemory(dir, "deleted");
		createHostMemory(dir, "updated");
		const stale = loadHarnessState(dir, "local");
		const current = loadHarnessState(dir, "local");
		delete current.entries.memory.deleted;
		current.entries.memory.updated.content = "new content";
		saveHarnessState(dir, current);
		applyRefinementProposal(stale, proposal("added"), { id: "addition" });
		saveHarnessState(dir, stale);
		const reloaded = loadHarnessState(dir);
		expect(Object.keys(reloaded.entries.memory).sort()).toEqual(["added", "updated"]);
		expect(reloaded.entries.memory.updated.content).toBe("new content");
		// Reusing a saved object must not replay its earlier additions/history.
		saveHarnessState(dir, stale);
		expect(loadHarnessState(dir).refinements).toEqual(reloaded.refinements);
	});

	it.each(["create", "update", "delete"])("rejects a conflicting Python %s and releases the lock", async (action) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dir = join(harness.tempDir, "harness");
		mkdirSync(dir);
		if (action !== "create") createHostMemory(dir, "contested");
		const python = pythonWriter(dir, "contested", true, action);
		try {
			await python.waitReady();
			const host = loadHarnessState(dir, "local");
			const edit = proposal("contested");
			edit.edits[0].action = action === "create" ? "create" : "update";
			edit.edits[0].content = "accepted host content";
			applyRefinementProposal(host, edit, { id: "winning-host" });
			saveHarnessState(dir, host);
			python.release();
			const result = await python.done;
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Harness entry changed before save: memory:contested");
			expect(loadHarnessState(dir).entries.memory.contested.content).toBe("accepted host content");
			expect(existsSync(`${getHarnessStatePath(dir)}.lock`)).toBe(false);
			createHostMemory(dir, "after-conflict");
		} finally {
			await python.cleanup();
		}
	});

	it.each(["update", "delete"])("rejects a stale host %s without persisting its refinement event", async (action) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const dir = join(harness.tempDir, "harness");
		createHostMemory(dir, "contested");
		const stale = loadHarnessState(dir, "local");
		const edit = proposal("contested");
		edit.edits[0].action = action === "delete" ? "delete" : "update";
		applyRefinementProposal(stale, edit, { id: "rejected-host" });
		const python = pythonWriter(dir, "contested", false, "update");
		try {
			expect((await python.done).code).toBe(0);
		} finally {
			await python.cleanup();
		}
		expect(() => saveHarnessState(dir, stale)).toThrow("Harness entry changed before save: memory:contested");
		const state = loadHarnessState(dir);
		expect(state.entries.memory.contested.content).toBe("python update");
		expect(state.refinements.some((event) => event.id === "rejected-host")).toBe(false);
		expect(existsSync(`${getHarnessStatePath(dir)}.lock`)).toBe(false);
	});
});
