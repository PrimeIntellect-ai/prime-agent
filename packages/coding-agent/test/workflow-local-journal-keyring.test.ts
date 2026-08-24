import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestObject, type WorkflowEpochRef } from "../src/core/workflow/contracts.js";
import {
	createLocalWorkflowJournalKeyProvider,
	LocalWorkflowJournalKeyring,
} from "../src/core/workflow/local-journal-keyring.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };

describe("local workflow journal keyring", () => {
	it("creates a random per-generation key and reopens it after restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-keyring-"));
		try {
			const first = new LocalWorkflowJournalKeyring({ sessionArtifactRoot: root, rootSessionId: "session-1" });
			const created = await first.current("workflow-1", EPOCH);
			const second = createLocalWorkflowJournalKeyProvider({
				sessionArtifactRoot: root,
				rootSessionId: "session-1",
			});
			const reopened = await second.current("workflow-1", EPOCH);

			expect(created.secret).toHaveLength(32);
			expect(reopened).toMatchObject({
				keyId: created.keyId,
				validStoreEpoch: EPOCH.storeEpoch,
				generationId: created.generationId,
			});
			expect(reopened.secret).toEqual(created.secret);
			expect(created.secret).not.toEqual(new Uint8Array(32));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("publishes a private immutable key record inside the session root", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-keyring-"));
		try {
			const provider = new LocalWorkflowJournalKeyring({ sessionArtifactRoot: root, rootSessionId: "session-1" });
			const key = await provider.current("workflow-1", EPOCH);
			const keyPath = join(
				root,
				"keyring",
				"workflows",
				"workflow-1",
				"generations",
				key.generationId,
				"side-records",
				"key.json",
			);
			const markerPath = join(root, "keyring", "workflows", "workflow-1", "side-records", "key.json");
			expect(await readdir(join(root, "keyring", "workflows", "workflow-1", "generations"))).toEqual([
				key.generationId,
			]);
			const stats = await stat(keyPath);
			expect(stats.mode & 0o777).toBe(0o600);
			expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
			expect(JSON.parse(await readFile(keyPath, "utf8"))).toMatchObject({
				workflowId: "workflow-1",
				generationId: key.generationId,
				keyId: key.keyId,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rotates to a new generation while retaining the predecessor resolver", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-keyring-"));
		try {
			const provider = new LocalWorkflowJournalKeyring({ sessionArtifactRoot: root, rootSessionId: "session-1" });
			const predecessor = await provider.current("workflow-1", EPOCH);
			const nextEpoch: WorkflowEpochRef = { storeEpoch: 2, coordinatorEpoch: 1 };
			const priorHeadDigest = "a".repeat(64);
			const successor = await provider.rotate({
				workflowId: "workflow-1",
				previousEpoch: EPOCH,
				nextEpoch,
				rotationId: "rotation-1",
				priorHeadDigest,
			});

			expect(successor.generationId).not.toBe(predecessor.generationId);
			expect(successor.generationId).toBe(
				`generation-${digestObject({
					workflowId: "workflow-1",
					nextEpoch,
					rotationId: "rotation-1",
					priorHeadDigest,
				}).slice(0, 32)}`,
			);
			expect(successor.keyId).not.toBe(predecessor.keyId);
			expect(successor.secret).not.toEqual(predecessor.secret);
			expect(await provider.resolve("workflow-1", predecessor.keyId, EPOCH)).toEqual(predecessor);
			expect(await provider.resolve("workflow-1", successor.keyId, nextEpoch)).toEqual(successor);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("creates a distinct generation when a new epoch is opened without an explicit rotation", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-keyring-"));
		try {
			const provider = new LocalWorkflowJournalKeyring({ sessionArtifactRoot: root, rootSessionId: "session-1" });
			const first = await provider.current("workflow-1", EPOCH);
			const second = await provider.current("workflow-1", { storeEpoch: 2, coordinatorEpoch: 1 });

			expect(second.generationId).not.toBe(first.generationId);
			expect(second.secret).not.toEqual(first.secret);
			expect(await provider.current("workflow-1", { storeEpoch: 2, coordinatorEpoch: 1 })).toEqual(second);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed for a corrupt record, insecure permissions, symlinks, and foreign roots", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-keyring-"));
		const foreignRoot = await mkdtemp(join(tmpdir(), "workflow-keyring-foreign-"));
		const symlinkTarget = await mkdtemp(join(tmpdir(), "workflow-keyring-target-"));
		try {
			const provider = new LocalWorkflowJournalKeyring({ sessionArtifactRoot: root, rootSessionId: "session-1" });
			const key = await provider.current("workflow-1", EPOCH);
			const keyPath = join(
				root,
				"keyring",
				"workflows",
				"workflow-1",
				"generations",
				key.generationId,
				"side-records",
				"key.json",
			);
			const markerPath = join(root, "keyring", "workflows", "workflow-1", "side-records", "key.json");
			const original = await readFile(keyPath);
			const originalMarker = await readFile(markerPath);
			await rm(markerPath);
			await expect(provider.current("workflow-1", EPOCH)).rejects.toThrow(/marker/i);
			await writeFile(markerPath, originalMarker, { mode: 0o600 });
			await writeFile(keyPath, Buffer.from(original).subarray(0, original.byteLength - 1));
			await expect(provider.resolve("workflow-1", key.keyId, EPOCH)).rejects.toThrow(
				/key record|canonical|corrupt|marker/i,
			);

			await writeFile(keyPath, original, { mode: 0o600 });
			await chmod(keyPath, 0o644);
			await expect(provider.resolve("workflow-1", key.keyId, EPOCH)).rejects.toThrow(/permission|private|mode/i);
			await chmod(keyPath, 0o600);

			await rm(keyPath);
			await symlink(original, keyPath);
			await expect(provider.resolve("workflow-1", key.keyId, EPOCH)).rejects.toThrow(/symlink|no-follow/i);
			await rm(keyPath);
			const sideRecordsPath = join(
				root,
				"keyring",
				"workflows",
				"workflow-1",
				"generations",
				key.generationId,
				"side-records",
			);
			await rm(sideRecordsPath, { recursive: true });
			await symlink(symlinkTarget, sideRecordsPath);
			await expect(provider.resolve("workflow-1", key.keyId, EPOCH)).rejects.toThrow(/symlink|controlled path/i);

			const foreignKeyPath = join(
				foreignRoot,
				"keyring",
				"workflows",
				"workflow-1",
				"generations",
				key.generationId,
				"side-records",
				"key.json",
			);
			await mkdir(
				join(foreignRoot, "keyring", "workflows", "workflow-1", "generations", key.generationId, "side-records"),
				{
					recursive: true,
					mode: 0o700,
				},
			);
			await mkdir(join(foreignRoot, "keyring", "workflows", "workflow-1", "side-records"), {
				recursive: true,
				mode: 0o700,
			});
			await writeFile(foreignKeyPath, original, { mode: 0o600 });
			await writeFile(
				join(foreignRoot, "keyring", "workflows", "workflow-1", "side-records", "key.json"),
				original,
				{
					mode: 0o600,
				},
			);
			const foreign = new LocalWorkflowJournalKeyring({
				sessionArtifactRoot: foreignRoot,
				rootSessionId: "session-1",
			});
			await expect(foreign.resolve("workflow-1", key.keyId, EPOCH)).rejects.toThrow(/foreign|root|identity/i);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(foreignRoot, { recursive: true, force: true });
			await rm(symlinkTarget, { recursive: true, force: true });
		}
	});

	it("rejects a symlinked session root before touching key material", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-keyring-"));
		const alias = `${root}-alias`;
		try {
			await symlink(root, alias);
			const provider = new LocalWorkflowJournalKeyring({ sessionArtifactRoot: alias, rootSessionId: "session-1" });
			await expect(provider.current("workflow-1", EPOCH)).rejects.toThrow(/symlink|no-follow/i);
		} finally {
			await rm(alias, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		}
	});
});
