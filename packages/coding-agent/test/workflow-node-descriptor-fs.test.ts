import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowDescriptorHandle } from "../src/core/workflow/contracts.js";
import { createNodeWorkflowDescriptorFs } from "../src/core/workflow/node-descriptor-fs.js";

async function withTempRoot<T>(callback: (rootPath: string) => Promise<T>): Promise<T> {
	const rootPath = await mkdtemp(join(tmpdir(), "workflow-descriptor-fs-"));
	try {
		return await callback(rootPath);
	} finally {
		await rm(rootPath, { recursive: true, force: true });
	}
}

describe("node workflow descriptor filesystem", () => {
	it("writes and reopens real descriptor-relative files with durable sync boundaries", async () => {
		await withTempRoot(async (rootPath) => {
			const descriptorFs = createNodeWorkflowDescriptorFs();
			const root = await descriptorFs.openRoot(rootPath);
			let directory: WorkflowDescriptorHandle | undefined;
			let file: WorkflowDescriptorHandle | undefined;
			try {
				directory = await descriptorFs.mkdirAt(root, "nested", 0o700);
				file = await descriptorFs.openAt(
					directory,
					"payload",
					fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
					0o600,
				);
				const bytes = new TextEncoder().encode("descriptor-relative bytes");
				await file.write(bytes);
				await file.sync();
				await descriptorFs.syncDirectoryChain(file, root);
				expect(await file.read()).toEqual(bytes);
				expect((await file.stat()).identityDigest).toBe(file.identityDigest);
			} finally {
				await file?.close();
				await directory?.close();
				await root.close();
			}

			const reopenedRoot = await descriptorFs.openRoot(rootPath);
			let reopenedDirectory: WorkflowDescriptorHandle | undefined;
			let reopenedFile: WorkflowDescriptorHandle | undefined;
			try {
				reopenedDirectory = await descriptorFs.openAt(
					reopenedRoot,
					"nested",
					fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
					0o700,
				);
				reopenedFile = await descriptorFs.openAt(
					reopenedDirectory,
					"payload",
					fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
					0o600,
				);
				expect(Buffer.from(await reopenedFile.read()).toString()).toBe("descriptor-relative bytes");
				expect(await readFile(join(rootPath, "nested", "payload"), "utf8")).toBe("descriptor-relative bytes");
			} finally {
				await reopenedFile?.close();
				await reopenedDirectory?.close();
				await reopenedRoot.close();
			}
		});
	});

	it("rejects symlink traversal through descriptor-relative opens", async () => {
		await withTempRoot(async (rootPath) => {
			const outsidePath = await mkdtemp(join(tmpdir(), "workflow-descriptor-outside-"));
			try {
				await symlink(outsidePath, join(rootPath, "escape"));
				const descriptorFs = createNodeWorkflowDescriptorFs();
				const root = await descriptorFs.openRoot(rootPath);
				try {
					await expect(
						descriptorFs.openAt(
							root,
							"escape",
							fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
							0o700,
						),
					).rejects.toThrow(/symlink|no-follow/i);
				} finally {
					await root.close();
				}
			} finally {
				await rm(outsidePath, { recursive: true, force: true });
			}
		});
	});

	it("uses an atomic no-replace publication when concurrent writers race", async () => {
		await withTempRoot(async (rootPath) => {
			const descriptorFs = createNodeWorkflowDescriptorFs();
			const root = await descriptorFs.openRoot(rootPath);
			let directory: WorkflowDescriptorHandle | undefined;
			let first: WorkflowDescriptorHandle | undefined;
			let second: WorkflowDescriptorHandle | undefined;
			try {
				directory = await descriptorFs.mkdirAt(root, "objects", 0o700);
				first = await descriptorFs.openAt(
					directory,
					"first.tmp",
					fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
					0o600,
				);
				await first.write(new TextEncoder().encode("winner"));
				await first.sync();

				second = await descriptorFs.openAt(
					directory,
					"second.tmp",
					fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
					0o600,
				);
				await second.write(new TextEncoder().encode("loser"));
				await second.sync();
				const race = await Promise.allSettled([
					descriptorFs.renameAt(directory, "first.tmp", "published", { replace: false, noReplace: true }),
					descriptorFs.renameAt(directory, "second.tmp", "published", { replace: false, noReplace: true }),
				]);
				expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
				expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);
				expect(await readFile(join(rootPath, "objects", "published"), "utf8")).toMatch(/^(winner|loser)$/);
			} finally {
				await second?.close();
				await first?.close();
				await directory?.close();
				await root.close();
			}
		});
	});

	it("pins opened identity across path replacement and closes handles deterministically", async () => {
		await withTempRoot(async (rootPath) => {
			const descriptorFs = createNodeWorkflowDescriptorFs();
			const root = await descriptorFs.openRoot(rootPath);
			let file: WorkflowDescriptorHandle | undefined;
			try {
				file = await descriptorFs.openAt(
					root,
					"payload",
					fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
					0o600,
				);
				await file.write(new TextEncoder().encode("original"));
				await file.sync();
				await descriptorFs.renameAt(root, "payload", "payload.moved", { replace: true, noReplace: false });
				const replacement = await descriptorFs.openAt(
					root,
					"payload",
					fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
					0o600,
				);
				try {
					await replacement.write(new TextEncoder().encode("replacement"));
					await replacement.sync();
				} finally {
					await replacement.close();
				}
				expect(Buffer.from(await file.read()).toString()).toBe("original");
				expect((await file.stat()).identityDigest).toBe(file.identityDigest);
				await file.close();
				await expect(file.read()).rejects.toThrow(/closed/i);
				await expect(file.close()).resolves.toBeUndefined();
			} finally {
				await file?.close();
				await root.close();
			}
		});
	});

	it("rejects syncing a replacement ancestor directory", async () => {
		await withTempRoot(async (rootPath) => {
			const descriptorFs = createNodeWorkflowDescriptorFs();
			const root = await descriptorFs.openRoot(rootPath);
			let nested: WorkflowDescriptorHandle | undefined;
			let deep: WorkflowDescriptorHandle | undefined;
			let file: WorkflowDescriptorHandle | undefined;
			try {
				nested = await descriptorFs.mkdirAt(root, "nested", 0o700);
				deep = await descriptorFs.mkdirAt(nested, "deep", 0o700);
				file = await descriptorFs.openAt(
					deep,
					"payload",
					fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
					0o600,
				);
				await file.write(new TextEncoder().encode("old ancestor"));
				await file.sync();

				await rename(join(rootPath, "nested"), join(rootPath, "nested.moved"));
				await mkdir(join(rootPath, "nested"), { mode: 0o700 });
				await mkdir(join(rootPath, "nested", "deep"), { mode: 0o700 });

				await expect(descriptorFs.syncDirectoryChain(file, root)).rejects.toThrow(/ancestor|identity|replaced/i);
			} finally {
				await file?.close();
				await deep?.close();
				await nested?.close();
				await root.close();
			}
		});
	});
});
