import { describe, expect, it } from "vitest";
import { applyExifOrientation } from "../src/utils/exif-orientation.js";
import type { PhotonImageType } from "../src/utils/photon.js";

type Photon = typeof import("@silvia-odwyer/photon-node");

describe("exif orientation", () => {
	it("terminates the WebP chunk scan when a chunk size has the high bit set", () => {
		const bytes = new Uint8Array(20);
		bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
		bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
		bytes.set([0x4a, 0x55, 0x4e, 0x4b], 12); // JUNK
		bytes.set([0xf8, 0xff, 0xff, 0xff], 16); // chunk size 0xFFFFFFF8: read signed (-8), the scan re-visits this chunk forever
		// Orientation resolves to 1, so neither photon nor the image is ever touched.
		const image = {} as PhotonImageType;
		expect(applyExifOrientation({} as Photon, image, bytes)).toBe(image);
	});
});
