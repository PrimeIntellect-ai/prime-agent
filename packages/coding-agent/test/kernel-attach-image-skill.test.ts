import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner, imageBlocksFromAttachments } from "../src/core/tools/ipython.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function bundledAttachImageSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "attach-image");
	return {
		name: "attach-image",
		importName: "attach_image",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

describe("attach-image skill over the kernel host bridge", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-attach-image-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads an on-disk image into the tool result as an ImageContent block", async () => {
		const imagePath = join(tempDir, "sample.png");
		writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`print(await attach_image(${JSON.stringify(imagePath)}))`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toContain("Loaded 1 image(s) into context");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/png");
		expect(result.attachments?.[0]?.data).toBe(PNG_BASE64);

		const blocks = imageBlocksFromAttachments(result.attachments);
		expect(blocks).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	it("compresses large attached images before storing them in the tool result", { retry: 1 }, async () => {
		const imagePath = join(tempDir, "large.png");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
from PIL import Image
img = Image.new("RGB", (2400, 1800), (32, 64, 96))
img.save(${JSON.stringify(imagePath)})
print(await attach_image(${JSON.stringify(imagePath)}))
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("Resized for efficient inline rendering/replay");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/jpeg");
		expect(result.attachments?.[0]?.data.length).toBeLessThanOrEqual(350_000);
	});

	it("reports when compressed animated images are flattened to their first frame", { retry: 1 }, async () => {
		const imagePath = join(tempDir, "animated.gif");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
from PIL import Image
frames = [Image.new("RGB", (1300, 10), color) for color in ("red", "blue")]
frames[0].save(${JSON.stringify(imagePath)}, save_all=True, append_images=frames[1:], duration=50, loop=0)
print(await attach_image(${JSON.stringify(imagePath)}))
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("animated image flattened to first frame");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/jpeg");
		expect(result.attachments?.[0]?.data.length).toBeLessThanOrEqual(350_000);
	});

	it("uses a neutral background when compressing transparent images", async () => {
		const imagePath = join(tempDir, "transparent.png");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
from PIL import Image, ImageDraw
img = Image.new("RGBA", (1300, 10), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
draw.rectangle((0, 0, 1299, 9), fill=(255, 255, 255, 255))
img.save(${JSON.stringify(imagePath)})
print(await attach_image(${JSON.stringify(imagePath)}))
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("transparent pixels composited on #888888 background");
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments?.[0]?.mimeType).toBe("image/jpeg");
		expect(result.attachments?.[0]?.data.length).toBeLessThanOrEqual(350_000);
	});

	it("rejects oversized pixel counts before loading an image into context", async () => {
		const imagePath = join(tempDir, "huge.png");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import struct
import zlib


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


png = bytes([137, 80, 78, 71, 13, 10, 26, 10])
png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", 6001, 6001, 8, 2, 0, 0, 0))
png += png_chunk(b"IEND", b"")
with open(${JSON.stringify(imagePath)}, "wb") as file:
    file.write(png)
try:
    await attach_image(${JSON.stringify(imagePath)})
except ValueError as error:
    print(f"ValueError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("images must be at most 36MP");
		expect(result.attachments).toBeUndefined();
	});

	it("rejects undecodable images before emitting any attachment", async () => {
		const validImagePath = join(tempDir, "valid.png");
		const corruptImagePath = join(tempDir, "corrupt.png");
		writeFileSync(validImagePath, Buffer.from(PNG_BASE64, "base64"));

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import struct
import zlib


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


png = bytes([137, 80, 78, 71, 13, 10, 26, 10])
png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", 10, 10, 8, 2, 0, 0, 0))
png += png_chunk(b"IEND", b"")
with open(${JSON.stringify(corruptImagePath)}, "wb") as file:
    file.write(png)
try:
    await attach_image(${JSON.stringify(validImagePath)}, ${JSON.stringify(corruptImagePath)})
except ValueError as error:
    print(f"ValueError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout).toContain("is not a readable supported image");
		expect(result.attachments).toBeUndefined();
	});

	it("errors without emitting an attachment when the model is not vision-capable", async () => {
		const imagePath = join(tempDir, "sample.png");
		writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "openai/gpt-oss-120b", input: ["text"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await attach_image(${JSON.stringify(imagePath)})
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe(
			"RuntimeError: openai/gpt-oss-120b does not support vision. " +
				"Tell the user to switch to a vision-capable model to load images into context.",
		);
		expect(result.attachments).toBeUndefined();
	});

	it("rejects a non-image file", async () => {
		const notImage = join(tempDir, "notes.txt");
		writeFileSync(notImage, "just text");

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAttachImageSkill()],
			hostHandlers: {
				"model.info": async () => ({ id: "anthropic/claude-haiku-4.5", input: ["text", "image"] }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await attach_image(${JSON.stringify(notImage)})
except ValueError as error:
    print(f"ValueError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toContain("is not a supported image");
		expect(result.attachments).toBeUndefined();
	});

	it("fails the cell loudly when an emitted attachment exceeds the size cap", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, { pythonSkills: [] });
		const manager = await provisioner.ensure();
		const result = await manager.execute(`
from IPython.display import display
display({"application/vnd.prime-agent.attachment+json": {"mime_type": "image/png", "data": "A" * 10_000_001}}, raw=True)
print("done")
`);

		expect(result.status).toBe("error");
		expect(result.stderr).toContain("attachment dropped");
		expect(result.attachments).toBeUndefined();
	});
});
