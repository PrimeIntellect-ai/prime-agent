import { describe, expect, it } from "vitest";
import { getOAuthProvider, getOAuthProviders, type OAuthCredentials } from "../src/utils/oauth/index.js";
import { xaiOAuthProvider } from "../src/utils/oauth/xai.js";

describe("xaiOAuthProvider", () => {
	it("registers as a built-in OAuth provider", () => {
		expect(getOAuthProvider("xai")).toBe(xaiOAuthProvider);
		expect(getOAuthProviders().map((p) => p.id)).toContain("xai");
	});

	it("exposes SuperGrok subscription metadata", () => {
		expect(xaiOAuthProvider.name).toContain("SuperGrok");
		expect(xaiOAuthProvider.usesCallbackServer).toBe(true);
	});

	it("uses the access token as the API key", () => {
		const credentials: OAuthCredentials = {
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};
		expect(xaiOAuthProvider.getApiKey(credentials)).toBe("access-token");
	});
});
