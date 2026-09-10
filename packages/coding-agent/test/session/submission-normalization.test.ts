import type { ImageContent } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { PromptTemplate } from "../../src/core/prompt-templates.js";
import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import {
	type SubmissionNormalizationHost,
	type SubmissionNormalizationPolicy,
	SubmissionNormalizer,
} from "../../src/session/submission-normalization.js";
import { createDeferred } from "../suite/scheduling.js";

const policy: SubmissionNormalizationPolicy = {
	parseSessionCommands: true,
	extensionCommands: "ignore",
	inputSource: "interactive",
	expandSkills: true,
	expandPromptTemplates: true,
};

function createNormalizer() {
	const extensions: ReturnType<SubmissionNormalizationHost["getExtensions"]> = {
		hasHandlers: vi.fn(() => false),
		emitInput: vi.fn(async () => ({ action: "continue" as const })),
		getCommand: vi.fn(() => undefined),
		createCommandContext: () => {
			throw new Error("Unexpected extension command");
		},
		emitError: vi.fn(),
	};
	const resources: { prompts: PromptTemplate[] } = { prompts: [] };
	const normalizer = new SubmissionNormalizer({
		getExtensions: () => extensions,
		getPrompts: () => resources.prompts,
		getSkills: () => [],
	});
	return { normalizer, extensions, resources };
}

describe("submission normalization boundaries", () => {
	it("keeps plain submissions synchronous when there are no input hooks", () => {
		const { normalizer, extensions } = createNormalizer();
		const result = normalizer.normalizeSubmission("hello", undefined, policy);
		expect(result).not.toBeInstanceOf(Promise);
		expect(result).toEqual({ kind: "prompt", text: "hello", images: undefined });
		expect(extensions.emitInput).not.toHaveBeenCalled();
	});

	it("recognizes session commands before extension or input processing", () => {
		const { normalizer, extensions } = createNormalizer();
		vi.mocked(extensions.hasHandlers).mockReturnValue(true);
		const result = normalizer.normalizeSubmission("/compact focus", undefined, {
			...policy,
			extensionCommands: "execute",
		});
		expect(result).toMatchObject({ kind: "sessionCommand", text: "/compact focus" });
		expect(result).not.toBeInstanceOf(Promise);
		expect(extensions.getCommand).not.toHaveBeenCalled();
		expect(extensions.emitInput).not.toHaveBeenCalled();
	});

	it("expands the current templates after an asynchronous input transform", async () => {
		const { normalizer, extensions, resources } = createNormalizer();
		const transformed = createDeferred<Awaited<ReturnType<typeof extensions.emitInput>>>();
		vi.mocked(extensions.hasHandlers).mockReturnValue(true);
		vi.mocked(extensions.emitInput).mockReturnValue(transformed.promise);
		const result = normalizer.normalizeSubmission("original", undefined, policy);
		resources.prompts = [
			{
				name: "latest",
				description: "",
				content: "current resource $1",
				filePath: "/tmp/latest.md",
				sourceInfo: createSyntheticSourceInfo("/tmp/latest.md", { source: "test" }),
			},
		];
		transformed.resolve({ action: "transform", text: "/latest argument" });
		await expect(result).resolves.toEqual({ kind: "prompt", text: "current resource argument", images: undefined });
	});

	it.each([undefined, []] satisfies Array<ImageContent[] | undefined>)(
		"preserves transform image semantics for %s",
		async (replacement) => {
			const { normalizer, extensions } = createNormalizer();
			const images: ImageContent[] = [{ type: "image", data: "image", mimeType: "image/png" }];
			vi.mocked(extensions.hasHandlers).mockReturnValue(true);
			vi.mocked(extensions.emitInput).mockResolvedValue({
				action: "transform",
				text: "changed",
				images: replacement,
			});
			const result = await normalizer.normalizeSubmission("original", images, policy);
			expect(result).toEqual({ kind: "prompt", text: "changed", images: replacement ?? images });
			if (result.kind === "prompt") expect(result.images).toBe(replacement ?? images);
		},
	);
});
